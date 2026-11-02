import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpConsentStore,
  createProjectMcp,
  mcpFingerprint,
  readClaudeDecisions,
  readProjectMcpServers,
  repoKeyOf,
} from './project-mcp.js';

const git = promisify(execFile);

let root = '';
let userHome = '';
let parley = '';
let configDir = '';
const log = { warn: vi.fn() };

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-project-mcp-')));
  userHome = path.join(root, 'user');
  parley = path.join(root, 'parley');
  configDir = path.join(userHome, '.claude');
  await mkdir(userHome, { recursive: true });
  log.warn.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const stdio = (command: string, args: string[] = [], extra: Record<string, unknown> = {}) => ({ type: 'stdio', command, args, ...extra });
const mcpJson = (servers: Record<string, unknown>): string => JSON.stringify({ mcpServers: servers });

async function repo(name = 'repo'): Promise<string> {
  const dir = path.join(userHome, name);
  await mkdir(dir, { recursive: true });
  await git('git', ['init', '-q', '-b', 'main', dir]);
  await git('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function service() {
  return createProjectMcp({ home: parley, userHome, claudeConfigDir: configDir, log });
}

describe('mcpFingerprint', () => {
  it('sha256 всей записи: command — только команда с аргументами или адрес, значения env и headers нигде не видны', () => {
    const a = mcpFingerprint(stdio('node', ['server.js'], { env: { TOKEN: 'one' } }))!;
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.command).toBe('node server.js');
    expect(mcpFingerprint(stdio('node', ['other.js']))!.fingerprint).not.toBe(a.fingerprint);
    const http = mcpFingerprint({ type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer secret' } })!;
    expect(http.command).toBe('https://x.example/mcp');
    expect(JSON.stringify(http)).not.toContain('secret');
  });

  it('env меняется — отпечаток другой (NODE_OPTIONS меняет то, что запускается)', () => {
    const plain = mcpFingerprint(stdio('node', ['server.js']))!;
    const withEnv = mcpFingerprint(stdio('node', ['server.js'], { env: { NODE_OPTIONS: '--require ./evil.js' } }))!;
    const otherEnv = mcpFingerprint(stdio('node', ['server.js'], { env: { NODE_OPTIONS: '--require ./other.js' } }))!;
    expect(withEnv.fingerprint).not.toBe(plain.fingerprint);
    expect(otherEnv.fingerprint).not.toBe(withEnv.fingerprint);
    expect(withEnv.command).toBe(plain.command);
  });

  it('headers меняются — отпечаток другой', () => {
    const base = { type: 'http', url: 'https://x.example/mcp' };
    const a = mcpFingerprint({ ...base, headers: { Authorization: 'Bearer one' } })!;
    const b = mcpFingerprint({ ...base, headers: { Authorization: 'Bearer two' } })!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(mcpFingerprint(base)!.fingerprint).not.toBe(a.fingerprint);
  });

  it('порядок ключей на любой глубине отпечаток не меняет', () => {
    const one = mcpFingerprint({ command: 'node', args: ['a'], type: 'stdio', env: { A: '1', B: { y: 2, x: 1 } } })!;
    const two = mcpFingerprint({ env: { B: { x: 1, y: 2 }, A: '1' }, type: 'stdio', args: ['a'], command: 'node' })!;
    expect(one.fingerprint).toBe(two.fingerprint);
    // Порядок элементов массива — часть записи.
    expect(mcpFingerprint(stdio('node', ['a', 'b']))!.fingerprint).not.toBe(mcpFingerprint(stdio('node', ['b', 'a']))!.fingerprint);
  });

  it('command не длиннее 200 знаков', () => {
    expect(mcpFingerprint(stdio('x'.repeat(500)))!.command).toHaveLength(200);
  });

  it('запись не той формы — null', () => {
    for (const entry of [null, 'node', [], {}, { command: 5 }, { command: 'a', args: 'x' }, { command: 'a', args: [1] }, { url: {} }, { type: 1, command: 'a' }]) {
      expect(mcpFingerprint(entry)).toBeNull();
    }
  });
});

describe('readProjectMcpServers', () => {
  it('читает .mcp.json от папки вверх до домашней папки включительно, ближайший файл побеждает', async () => {
    const dir = path.join(userHome, 'a', 'b');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(userHome, '.mcp.json'), mcpJson({ home: stdio('h'), shared: stdio('far') }));
    await writeFile(path.join(userHome, 'a', '.mcp.json'), mcpJson({ mid: stdio('m'), shared: stdio('near') }));
    const { servers } = await readProjectMcpServers(dir, userHome, log);
    expect(servers.map((server) => server.name).sort()).toEqual(['home', 'mid', 'shared']);
    expect(servers.find((server) => server.name === 'shared')?.command).toBe('near');
  });

  it('выше домашней папки не поднимается', async () => {
    await writeFile(path.join(root, '.mcp.json'), mcpJson({ outside: stdio('o') }));
    const dir = path.join(userHome, 'p');
    await mkdir(dir, { recursive: true });
    expect((await readProjectMcpServers(dir, userHome, log)).servers).toEqual([]);
  });

  it('битый .mcp.json — серверов нет, предупреждение в журнал', async () => {
    const dir = path.join(userHome, 'p');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.mcp.json'), '{не json');
    expect((await readProjectMcpServers(dir, userHome, log)).servers).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'), expect.anything());
  });

  it('нет mcpServers или запись не той формы — этот сервер пропускается с предупреждением', async () => {
    const dir = path.join(userHome, 'p');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ good: stdio('g'), bad: 'oops' }));
    const read = await readProjectMcpServers(dir, userHome, log);
    expect(read.servers.map((server) => server.name)).toEqual(['good']);
    expect(read.unmanaged).toEqual(['bad']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cannot fingerprint'), expect.objectContaining({ names: ['bad'] }));
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ servers: {} }));
    expect((await readProjectMcpServers(dir, userHome, log)).servers).toEqual([]);
  });
});

describe('repoKeyOf', () => {
  it('worktree делит ключ с основным репозиторием, подпапка тоже; не репозиторий — сама папка', async () => {
    const main = await repo();
    const worktree = path.join(userHome, 'wt');
    await git('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'feature', worktree]);
    const sub = path.join(main, 'sub');
    await mkdir(sub);
    expect(await repoKeyOf(main)).toBe(main);
    expect(await repoKeyOf(worktree)).toBe(main);
    expect(await repoKeyOf(sub)).toBe(main);
    const plain = path.join(userHome, 'plain');
    await mkdir(plain);
    expect(await repoKeyOf(plain)).toBe(plain);
  });
});

describe('repoKeyOf: корень основного репозитория', () => {
  it('--separate-git-dir: основной каталог и все worktree дают один ключ (git называет основным worktree папку .git — ключ тот же для всех)', async () => {
    const work = path.join(userHome, 'sep-work');
    const gitDir = path.join(userHome, 'sep.git');
    await mkdir(work, { recursive: true });
    await git('git', ['init', '-q', '-b', 'main', `--separate-git-dir=${gitDir}`, work]);
    await git('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const linked = path.join(userHome, 'sep-linked');
    await git('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'feature', linked]);
    await mkdir(path.join(work, 'deep'));
    const key = await repoKeyOf(work);
    expect(await repoKeyOf(linked)).toBe(key);
    expect(await repoKeyOf(path.join(work, 'deep'))).toBe(key);
    expect(key).not.toBe(linked);
    // Раньше ключом выходил родитель `.git`: для такого репозитория это был бы каталог выше папки с гитом.
    expect(key).not.toBe(userHome);
  });
});

describe('readClaudeDecisions', () => {
  it('настройки пользователя — все три ключа; проект и local проекта — только отказы (спайк T5b)', async () => {
    const dir = await repo();
    await mkdir(configDir, { recursive: true });
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['u1'], disabledMcpjsonServers: ['u2'] }));
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['p'], enabledMcpjsonServers: ['p-on'] }));
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['l'], enabledMcpjsonServers: ['l-on'] }));
    const decisions = readClaudeDecisions({ repo: dir, cwd: dir, configDir });
    expect([...decisions.decided].sort()).toEqual(['l', 'p', 'u1', 'u2']);
    expect(decisions.enableAll).toBe(false);
  });

  it('enableAllProjectMcpServers гасит вопрос только из настроек пользователя; из проекта — нет', async () => {
    const dir = await repo();
    await mkdir(configDir, { recursive: true });
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(readClaudeDecisions({ repo: dir, cwd: dir, configDir }).enableAll).toBe(false);
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(readClaudeDecisions({ repo: dir, cwd: dir, configDir }).enableAll).toBe(true);
  });

  it('битые файлы и чужие формы читаются как «решений нет»', async () => {
    const dir = await repo();
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), '{битый');
    expect(readClaudeDecisions({ repo: dir, cwd: dir, configDir }).decided.size).toBe(0);
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: 'a', enableAllProjectMcpServers: 'yes' }));
    const odd = readClaudeDecisions({ repo: dir, cwd: dir, configDir });
    expect(odd.decided.size).toBe(0);
    expect(odd.enableAll).toBe(false);
  });

  it('файлы Claude только читаются: содержимое и время не меняются', async () => {
    const dir = await repo();
    await mkdir(configDir, { recursive: true });
    const file = path.join(configDir, 'settings.json');
    await writeFile(file, JSON.stringify({ enabledMcpjsonServers: ['u'] }));
    const before = await stat(file);
    readClaudeDecisions({ repo: dir, cwd: dir, configDir });
    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify({ enabledMcpjsonServers: ['u'] }));
  });
});

describe('createMcpConsentStore', () => {
  it('запись с отпечатком; другой отпечаток — решения нет; файл 0600 и переживает перезапуск', async () => {
    const store = createMcpConsentStore(parley, log);
    store.record('/r', [{ name: 'a', fingerprint: 'f1', enabled: true }, { name: 'b', fingerprint: 'f2', enabled: false }], 'window');
    expect(store.lookup('/r', 'a', 'f1')).toEqual({ enabled: true });
    expect(store.lookup('/r', 'b', 'f2')).toEqual({ enabled: false });
    expect(store.lookup('/r', 'a', 'другой')).toBeUndefined();
    expect(store.lookup('/другой', 'a', 'f1')).toBeUndefined();
    const file = path.join(parley, 'mcp-consent.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; repos: Record<string, Record<string, Record<string, unknown>>> };
    expect(saved.version).toBe(1);
    expect(saved.repos['/r']!['a']).toMatchObject({ fingerprint: 'f1', enabled: true, by: 'window' });
    expect(saved.repos['/r']!['a']!['decidedAt']).toEqual(expect.any(String));
    expect(createMcpConsentStore(parley, log).lookup('/r', 'a', 'f1')).toEqual({ enabled: true });
  });

  it('битый файл или чужая версия — пустое хранилище, предупреждение', async () => {
    await mkdir(parley, { recursive: true });
    await writeFile(path.join(parley, 'mcp-consent.json'), '{не json');
    expect(createMcpConsentStore(parley, log).lookup('/r', 'a', 'f1')).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    await writeFile(path.join(parley, 'mcp-consent.json'), JSON.stringify({ version: 2, repos: { '/r': { a: { fingerprint: 'f1', enabled: true } } } }));
    expect(createMcpConsentStore(parley, log).lookup('/r', 'a', 'f1')).toBeUndefined();
  });

  it('запись, которая не пишется на диск, остаётся в памяти хоста', async () => {
    await writeFile(parley, 'это файл, а не папка');
    const store = createMcpConsentStore(parley, log);
    store.record('/r', [{ name: 'a', fingerprint: 'f1', enabled: true }], 'window');
    expect(store.lookup('/r', 'a', 'f1')).toEqual({ enabled: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not written'), expect.anything());
  });
});

describe('inspect: папка настроек Claude запускаемого провайдера (F3)', () => {
  it('у провайдера своя папка: решения из ~/.claude/settings.json её не касаются, решения из своей — касаются', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('a') }));
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'] }));
    const mcp = service();
    // Хост по умолчанию читает ~/.claude: решение есть.
    expect(await mcp.inspect(dir)).toMatchObject({ undecided: [] });
    // Провайдер со своей папкой: решений в ней нет — вопрос остаётся.
    const own = path.join(root, 'provider-config');
    await mkdir(own, { recursive: true });
    expect((await mcp.inspect(dir, { configDir: own })).undecided.map((server) => server.name)).toEqual(['a']);
    await writeFile(path.join(own, 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['a'] }));
    expect(await mcp.inspect(dir, { configDir: own })).toMatchObject({ undecided: [] });
  });

  it('у провайдера нет своей папки (GLM): читается ~/.claude домашней папки, а не папка хоста', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('a') }));
    await mkdir(path.join(userHome, '.claude'), { recursive: true });
    await writeFile(path.join(userHome, '.claude', 'settings.json'), JSON.stringify({ disabledMcpjsonServers: ['a'] }));
    const hostDir = path.join(root, 'host-config');
    await mkdir(hostDir, { recursive: true });
    const mcp = createProjectMcp({ home: parley, userHome, claudeConfigDir: hostDir, log });
    expect((await mcp.inspect(dir)).undecided.map((server) => server.name)).toEqual(['a']);
    expect(await mcp.inspect(dir, { configDir: undefined })).toMatchObject({ undecided: [] });
  });
});

describe('inspect: серверы, которые не отпечатать (F4)', () => {
  it('плохая запись, пустое и слишком длинное имя — не на карточке, а в unmanaged; хорошие серверы как обычно', async () => {
    const dir = await repo();
    const longName = 'n'.repeat(201);
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ good: stdio('g'), bad: 'oops', '': stdio('x'), [longName]: stdio('y'), nocmd: {} }));
    const found = await service().inspect(dir);
    expect(found.undecided.map((server) => server.name)).toEqual(['good']);
    expect(found.unmanaged.sort()).toEqual(['', 'bad', longName, 'nocmd'].sort());
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('если у самого Claude о таком сервере уже есть решение — он не в unmanaged', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ bad: 'oops', bad2: 5 }));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['bad'] }));
    expect((await service().inspect(dir)).unmanaged).toEqual(['bad2']);
  });

  it('только не отпечатанные серверы: карточки нет, но unmanaged заполнен (запуск их выключит)', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ bad: 'oops' }));
    const found = await service().inspect(dir);
    expect(found).toMatchObject({ undecided: [], enabled: [], disabled: [], unmanaged: ['bad'] });
  });

  it('плохая запись ближайшего файла перекрывает хорошую дальнего: имя остаётся в unmanaged', async () => {
    const outer = path.join(root, 'outer');
    const inner = path.join(outer, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(outer, '.mcp.json'), mcpJson({ a: stdio('far') }));
    await writeFile(path.join(inner, '.mcp.json'), mcpJson({ a: 'broken' }));
    const found = await service().inspect(inner);
    expect(found.undecided).toEqual([]);
    expect(found.unmanaged).toEqual(['a']);
  });
});

describe('inspect', () => {
  it('новые серверы — undecided; ничего не включено и не выключено', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('node', ['a.js']), b: stdio('node', ['b.js']) }));
    const found = await service().inspect(dir);
    expect(found.repo).toBe(dir);
    expect(found.undecided.map((server) => server.name).sort()).toEqual(['a', 'b']);
    expect(found.enabled).toEqual([]);
    expect(found.disabled).toEqual([]);
  });

  it('решение Parley: enabled и disabled; тот же репозиторий в другом worktree — вопроса нет', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('node', ['a.js']), b: stdio('node', ['b.js']) }));
    await git('git', ['-C', dir, 'add', '.mcp.json']);
    await git('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'mcp']);
    const mcp = service();
    const first = await mcp.inspect(dir);
    mcp.store.record(first.repo, first.undecided.map((server) => ({ name: server.name, fingerprint: server.fingerprint, enabled: server.name === 'a' })), 'window');
    const worktree = path.join(userHome, 'wt2');
    await git('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feature', worktree]);
    const second = await mcp.inspect(worktree);
    expect(second).toMatchObject({ repo: dir, undecided: [], enabled: ['a'], disabled: ['b'] });
  });

  it('добавили env к включённому серверу — вопрос снова, сервер не остаётся включённым', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('node', ['a.js']) }));
    const mcp = service();
    const first = await mcp.inspect(dir);
    mcp.store.record(first.repo, first.undecided.map((server) => ({ name: server.name, fingerprint: server.fingerprint, enabled: true })), 'window');
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('node', ['a.js'], { env: { NODE_OPTIONS: '--require ./evil.js' } }) }));
    const second = await mcp.inspect(dir);
    expect(second.undecided.map((server) => server.name)).toEqual(['a']);
    expect(second.enabled).toEqual([]);
  });

  it('изменённый отпечаток — снова вопрос только об этом сервере', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('node', ['a.js']), b: stdio('node', ['b.js']) }));
    const mcp = service();
    const first = await mcp.inspect(dir);
    mcp.store.record(first.repo, first.undecided.map((server) => ({ name: server.name, fingerprint: server.fingerprint, enabled: true })), 'window');
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('node', ['a.js']), b: stdio('node', ['EVIL.js']) }));
    const second = await mcp.inspect(dir);
    expect(second.undecided.map((server) => server.name)).toEqual(['b']);
    expect(second.enabled).toEqual(['a']);
  });

  it('решение Claude в настройках пользователя — вопроса нет и ключей нет', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('a'), b: stdio('b') }));
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['b'] }));
    expect(await service().inspect(dir)).toMatchObject({ undecided: [], enabled: [], disabled: [] });
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    expect(await service().inspect(dir)).toMatchObject({ undecided: [], enabled: [], disabled: [] });
    await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'] }));
    expect((await service().inspect(dir)).undecided.map((server) => server.name)).toEqual(['b']);
  });

  it('отказ Claude в local-настройках папки (так пишет Esc) — вопроса нет', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('a'), b: stdio('b') }));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ disabledMcpjsonServers: ['a', 'b'] }));
    expect(await service().inspect(dir)).toMatchObject({ undecided: [], enabled: [], disabled: [] });
  });

  it('включение в settings.local.json проекта НЕ считается решением: карточка остаётся (Claude всё равно спросит)', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('a'), b: stdio('b') }));
    await mkdir(path.join(dir, '.claude'), { recursive: true });
    await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['a', 'b'], enableAllProjectMcpServers: true }));
    await writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['a'] }));
    expect((await service().inspect(dir)).undecided.map((server) => server.name).sort()).toEqual(['a', 'b']);
  });

  it('списки в файле состояния Claude решением не считаются', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), mcpJson({ a: stdio('a') }));
    await writeFile(path.join(userHome, '.claude.json'), JSON.stringify({ projects: { [dir]: { enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['a'], enableAllProjectMcpServers: true } } }));
    expect((await service().inspect(dir)).undecided.map((server) => server.name)).toEqual(['a']);
  });

  it('не git-папка внутри родителя с .mcp.json: серверы найдены выше, ключ репозитория — realpath самой папки', async () => {
    const outer = path.join(root, 'outer');
    const inner = path.join(outer, 'inner');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(outer, '.mcp.json'), mcpJson({ a: stdio('a'), b: stdio('b') }));
    const found = await service().inspect(inner);
    expect(found.repo).toBe(inner);
    expect(found.undecided.map((server) => server.name).sort()).toEqual(['a', 'b']);
    expect(found.enabled).toEqual([]);
  });

  it('то же внутри домашней папки: серверы из ~/.mcp.json (как у человека) — все без решения', async () => {
    const inner = path.join(userHome, 'docs', 'reports');
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(userHome, '.mcp.json'), mcpJson({ nx: stdio('npx', ['nx']), figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } }));
    const found = await service().inspect(inner);
    expect(found.repo).toBe(inner);
    expect(found.undecided.map((server) => server.name).sort()).toEqual(['figma', 'nx']);
  });

  it('битый .mcp.json — ни вопроса, ни включённых серверов, предупреждение', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, '.mcp.json'), '{{');
    expect(await service().inspect(dir)).toEqual({ repo: '', undecided: [], enabled: [], disabled: [], unmanaged: [] });
    expect(log.warn).toHaveBeenCalled();
  });

  it('любая ошибка разбора (папки нет) — пусто, ничего не включено', async () => {
    expect(await service().inspect(path.join(root, 'нет-такой'))).toEqual({ repo: '', undecided: [], enabled: [], disabled: [], unmanaged: [] });
  });
});
