import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_UPDATE_MIN_AGE_MS, createCliUpdates } from './updates.js';

/**
 * Сети и настоящих CLI здесь нет: `fetch` — подмена, бинари — пустые файлы во временной папке, на которые
 * указывают `PARLEY_CODEX_BIN` и `PARLEY_CLAUDE_BIN`; запускаться они не будут, их только ищут и раскрывают ссылки.
 */
const HOUR = 60 * 60 * 1000;
const GITHUB = 'https://api.github.com/repos/openai/codex/releases/latest';
const BREW = 'https://formulae.brew.sh/api/cask/codex.json';
const NPM = 'https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags';

let root = '';
let userHome = '';
let parley = '';
let codexBin = '';
let claudeBin = '';
const log = { warn: vi.fn() };

async function executable(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-updates-'));
  userHome = path.join(root, 'user');
  parley = path.join(root, 'parley');
  codexBin = await executable(path.join(userHome, '.codex/packages/standalone/releases/0.162.0/bin/codex'));
  claudeBin = await executable(path.join(userHome, '.local/share/claude/versions/2.1.316'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Net {
  fetchImpl: typeof fetch;
  urls: string[];
  /** Ответы по адресам; `Error` — сетевой сбой. */
  replies: Map<string, unknown>;
}

function net(): Net {
  const urls: string[] = [];
  const replies = new Map<string, unknown>([
    [GITHUB, { tag_name: 'rust-v0.166.0', prerelease: false }],
    [BREW, { version: '0.165.0' }],
    [NPM, { latest: '2.1.320', stable: '2.1.300' }],
  ]);
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const reply = replies.get(String(url));
    if (reply instanceof Error) throw reply;
    return { status: 200, json: async () => reply } as Response;
  }) as typeof fetch;
  return { fetchImpl, urls, replies };
}

function service(n: Net, now: () => number, overrides: { codex?: string; claude?: string } = {}) {
  return createCliUpdates({
    fetchImpl: n.fetchImpl,
    log,
    home: parley,
    userHome,
    env: { PARLEY_CODEX_BIN: overrides.codex ?? codexBin, PARLEY_CLAUDE_BIN: overrides.claude ?? claudeBin, PATH: '' },
    now,
  });
}

const cacheFile = (): string => path.join(parley, 'cli-updates.json');

describe('проверка версий CLI', () => {
  it('первая проверка спрашивает оба источника и пишет кэш версии 1', async () => {
    const n = net();
    const updates = service(n, () => Date.UTC(2026, 10, 2));
    await updates.checkAll();
    expect(n.urls.sort()).toEqual([GITHUB, NPM].sort());
    const file = JSON.parse(await readFile(cacheFile(), 'utf8')) as { version: number; providers: Record<string, unknown> };
    expect(file.version).toBe(1);
    expect(file.providers['codex']).toEqual({
      latest: '0.166.0',
      checkedAt: '2026-11-02T00:00:00.000Z',
      method: 'standalone',
      skipped: null,
    });
    expect(file.providers['claude']).toMatchObject({ latest: '2.1.320', method: 'native' });
  });

  it('не чаще раза в 20 часов по checkedAt', async () => {
    const n = net();
    let at = Date.UTC(2026, 10, 2);
    const updates = service(n, () => at);
    await updates.checkAll();
    expect(n.urls).toHaveLength(2);
    at += CLI_UPDATE_MIN_AGE_MS - HOUR;
    await updates.checkAll();
    expect(n.urls).toHaveLength(2);
    at += 2 * HOUR;
    await updates.checkAll();
    expect(n.urls).toHaveLength(4);
  });

  it('кэш переживает перезапуск: свежая запись не даёт новой проверки', async () => {
    const n = net();
    const at = Date.UTC(2026, 10, 2);
    await service(n, () => at).checkAll();
    await service(n, () => at + HOUR).checkAll();
    expect(n.urls).toHaveLength(2);
  });

  it('текущее обновление: новее установленной и не пропущено', async () => {
    const updates = service(net(), () => Date.UTC(2026, 10, 2));
    await updates.checkAll();
    expect(await updates.current('codex', '0.162.0')).toEqual({
      latest: '0.166.0',
      method: 'standalone',
      checkedAt: '2026-11-02T00:00:00.000Z',
    });
    expect(await updates.current('codex', '0.166.0')).toBeNull();
    expect(await updates.current('codex', null)).toBeNull();
    expect(await updates.current('other', '0.1.0')).toBeNull();
  });

  it('без проверки обновления нет', async () => {
    const updates = service(net(), () => 0);
    expect(await updates.current('codex', '0.162.0')).toBeNull();
    expect(await updates.skip('codex')).toBe(false);
  });

  it('пропуск версии: строка уходит, а со следующей версией возвращается', async () => {
    const n = net();
    let at = Date.UTC(2026, 10, 2);
    const updates = service(n, () => at);
    await updates.checkAll();
    expect(await updates.skip('codex')).toBe(true);
    expect(await updates.current('codex', '0.162.0')).toBeNull();
    // Пропуск хранится в файле.
    expect(JSON.parse(await readFile(cacheFile(), 'utf8')).providers.codex.skipped).toBe('0.166.0');
    n.replies.set(GITHUB, { tag_name: 'rust-v0.167.0', prerelease: false });
    at += 25 * HOUR;
    await updates.checkAll();
    expect(await updates.current('codex', '0.162.0')).toMatchObject({ latest: '0.167.0' });
  });

  it('офлайн: пишется только checkedAt, latest не стирается', async () => {
    const n = net();
    let at = Date.UTC(2026, 10, 2);
    const updates = service(n, () => at);
    await updates.checkAll();
    n.replies.set(GITHUB, new TypeError('fetch failed'));
    n.replies.set(NPM, new TypeError('fetch failed'));
    at += 25 * HOUR;
    await updates.checkAll();
    const codex = JSON.parse(await readFile(cacheFile(), 'utf8')).providers.codex;
    expect(codex).toEqual({ latest: '0.166.0', checkedAt: new Date(at).toISOString(), method: 'standalone', skipped: null });
    expect(await updates.current('codex', '0.162.0')).toMatchObject({ latest: '0.166.0' });
  });

  it('офлайн с самого начала: обновления нет, повтор не раньше 20 часов', async () => {
    const n = net();
    n.replies.set(GITHUB, new TypeError('fetch failed'));
    n.replies.set(NPM, new TypeError('fetch failed'));
    const updates = service(n, () => Date.UTC(2026, 10, 2));
    await updates.checkAll();
    expect(await updates.current('codex', '0.162.0')).toBeNull();
    await updates.checkAll();
    expect(n.urls).toHaveLength(2);
  });

  it('битый кэш — пустой кэш', async () => {
    await mkdir(parley, { recursive: true });
    await writeFile(cacheFile(), '{не json');
    const updates = service(net(), () => Date.UTC(2026, 10, 2));
    expect(await updates.current('codex', '0.162.0')).toBeNull();
    await updates.checkAll();
    expect(await updates.current('codex', '0.162.0')).toMatchObject({ latest: '0.166.0' });
  });

  it('кэш другой формы или версии игнорируется', async () => {
    await mkdir(parley, { recursive: true });
    await writeFile(cacheFile(), JSON.stringify({ version: 2, providers: { codex: { latest: '9.9.9', checkedAt: '2026-11-02T00:00:00.000Z', method: 'npm', skipped: null } } }));
    const n = net();
    await service(n, () => Date.UTC(2026, 10, 2)).checkAll();
    expect(n.urls).toHaveLength(2);
  });

  it('PARLEY_CODEX_BIN: способ установки берётся из пути подмены, ссылки раскрываются', async () => {
    const brew = await executable(path.join(root, 'Caskroom/codex/0.162.0/codex'));
    const link = path.join(root, 'bin-link');
    await symlink(brew, link);
    const n = net();
    const updates = service(n, () => Date.UTC(2026, 10, 2), { codex: link });
    await updates.checkAll();
    expect(n.urls).toContain(BREW);
    expect(n.urls).not.toContain(GITHUB);
    expect(await updates.current('codex', '0.162.0')).toEqual({
      latest: '0.165.0',
      method: 'brew',
      checkedAt: '2026-11-02T00:00:00.000Z',
    });
  });

  it('CLI не найден — источник не спрашивается и записи нет', async () => {
    const n = net();
    const updates = service(n, () => Date.UTC(2026, 10, 2), { codex: path.join(root, 'нет-такого'), claude: path.join(root, 'тоже-нет') });
    await updates.checkAll();
    expect(n.urls).toEqual([]);
    expect(await updates.current('codex', '0.1.0')).toBeNull();
  });

  it('Claude: канал из ~/.claude/settings.json (autoUpdatesChannel), иначе latest', async () => {
    await mkdir(path.join(userHome, '.claude'), { recursive: true });
    await writeFile(path.join(userHome, '.claude/settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    const updates = service(net(), () => Date.UTC(2026, 10, 2));
    await updates.checkAll();
    expect(await updates.current('claude', '2.1.200')).toMatchObject({ latest: '2.1.300' });
    // Настройки читаются, но не пишутся.
    expect(JSON.parse(await readFile(path.join(userHome, '.claude/settings.json'), 'utf8'))).toEqual({ autoUpdatesChannel: 'stable' });
  });

  it('Claude: при CLAUDE_CONFIG_DIR канал берётся из его settings.json, а не из ~/.claude', async () => {
    await mkdir(path.join(userHome, '.claude'), { recursive: true });
    await writeFile(path.join(userHome, '.claude/settings.json'), JSON.stringify({ autoUpdatesChannel: 'latest' }));
    const custom = path.join(root, 'custom-claude');
    await mkdir(custom, { recursive: true });
    await writeFile(path.join(custom, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    const n = net();
    const updates = createCliUpdates({
      fetchImpl: n.fetchImpl,
      log,
      home: parley,
      userHome,
      env: { PARLEY_CODEX_BIN: codexBin, PARLEY_CLAUDE_BIN: claudeBin, PATH: '', CLAUDE_CONFIG_DIR: custom },
      now: () => Date.UTC(2026, 10, 2),
    });
    await updates.checkAll();
    expect(await updates.current('claude', '2.1.200')).toMatchObject({ latest: '2.1.300' });
  });

  it('onChange зовётся, когда пришла новая версия, и не зовётся при повторе той же', async () => {
    const n = net();
    let at = Date.UTC(2026, 10, 2);
    const changes: string[] = [];
    const updates = createCliUpdates({
      fetchImpl: n.fetchImpl,
      log,
      home: parley,
      userHome,
      env: { PARLEY_CODEX_BIN: codexBin, PARLEY_CLAUDE_BIN: claudeBin, PATH: '' },
      now: () => at,
      onChange: (command) => changes.push(command),
    });
    await updates.checkAll();
    expect(changes.sort()).toEqual(['claude', 'codex']);
    at += 25 * HOUR;
    await updates.checkAll();
    expect(changes).toHaveLength(2);
  });

  it('start() ничего не ждёт: сеть спрашивается позже, в фоне; stop() гасит таймеры', async () => {
    const n = net();
    const updates = service(n, () => Date.UTC(2026, 10, 2));
    updates.start();
    expect(n.urls).toEqual([]);
    await vi.waitFor(() => expect(n.urls).toHaveLength(2));
    updates.stop();
  });
});
