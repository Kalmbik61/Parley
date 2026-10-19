// Тесты-гарантии «Claude Code не задет» (спека своих провайдеров, разделы 6, 6.2, К17, К18; план, задача 9).
// Песочница: HOME процесса и дом хоста — временные папки, настоящих ~/.claude, ~/.claude.json и ~/.parley тут нет.
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, readlink, rename, unlink, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@parley/core';
import * as protocol from '@parley/protocol';
import type { Result } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

let host: RunningHost | undefined;
let home: string;
let clients: TestClient[] = [];
let nextId = 9000;
const saved = {
  HOME: process.env['HOME'],
  CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
  PARLEY_CLAUDE_BIN: process.env['PARLEY_CLAUDE_BIN'],
  CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients) client.close();
  clients = [];
  await host?.context.shutdown('test-cleanup');
  host = undefined;
  if (home) await removeHome(home);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const KEY = 'synthetic-secret-key-0123456789-ABCDEFGHIJ';
const draft = {
  id: null, label: 'Kimi', preset: 'kimi', baseUrl: 'https://api.example.com/anthropic', auth: 'bearer',
  models: { opus: 'm-big', sonnet: 'm-mid', haiku: 'm-small', subagent: 'm-mid' },
  contextWindow: null, linkClaude: true,
};

/** Заглушка `claude`: пишет окружение и argv в файл (путь вшит, в окружение его не кладём) и остаётся жить. */
function stubSource(out: string): string {
  return `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
console.log('STUB READY');
setInterval(() => {}, 1000);
process.stdin.resume();
`;
}

interface Sandbox { client: TestClient; claude: string; project: string; out: string }

async function boot(options: { fetch?: typeof globalThis.fetch; userClaudeJson?: (project: string) => unknown } = {}): Promise<Sandbox> {
  home = await tempHome();
  // HOME процесса — песочница: ~/.claude = <home>/.claude, ~/.claude.json = <home>/.claude.json.
  process.env['HOME'] = home;
  delete process.env['CLAUDE_CONFIG_DIR'];
  delete process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
  const out = path.join(home, 'stub-out.json');
  const binary = path.join(home, 'claude-stub');
  await writeFile(binary, stubSource(out), 'utf8');
  await chmod(binary, 0o755);
  process.env['PARLEY_CLAUDE_BIN'] = binary;

  const claude = path.join(home, '.claude');
  await mkdir(path.join(claude, 'skills', 'x'), { recursive: true });
  await mkdir(path.join(claude, 'agents'), { recursive: true });
  await writeFile(path.join(claude, 'CLAUDE.md'), 'human rules\n');
  await writeFile(path.join(claude, 'skills', 'x', 'SKILL.md'), 'skill x\n');
  await writeFile(path.join(claude, 'agents', 'a.md'), 'agent a\n');
  await writeFile(path.join(claude, 'settings.json'), '{"theme":"dark"}\n');
  const project = path.join(home, 'project');
  await mkdir(project, { recursive: true });
  if (options.userClaudeJson !== undefined) {
    await writeFile(path.join(home, '.claude.json'), JSON.stringify(options.userClaudeJson(project)));
  }

  host = await startHost({
    home,
    probeVersion: async () => '2.1.302',
    ...(options.fetch === undefined ? {} : { customCheck: { fetch: options.fetch } }),
  });
  const client = connectRaw(hostPaths(home).socket);
  clients.push(client);
  await waitConnected(client.socket);
  await hello(client, await readFile(hostPaths(home).token, 'utf8'));
  return { client, claude, project, out };
}

async function rpc(client: TestClient, method: string, params: unknown = {}): Promise<RawMessage[]> {
  const id = nextId++;
  client.send({ id, method, params });
  const seen: RawMessage[] = [];
  for (;;) {
    const message = await client.next();
    seen.push(message);
    if (message.id === id) return seen;
  }
}

/** Снимок дерева: относительный путь → вид записи и sha256 содержимого (для ссылок — цель). */
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      const info = await lstat(full);
      if (info.isSymbolicLink()) result[rel] = `link:${await readlink(full)}`;
      else if (info.isDirectory()) { result[rel] = 'dir'; await walk(full); }
      else result[rel] = `file:${createHash('sha256').update(await readFile(full)).digest('hex')}`;
    }
  }
  await walk(root);
  return result;
}

interface OwnJson { hasCompletedOnboarding?: boolean; projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }

const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

async function waitFile(file: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text.length > 0) return text;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`stub did not write ${file}`);
}

async function startSession(sandbox: Sandbox, provider: string) {
  const created = await rpc(sandbox.client, 'works.create', { projectPath: sandbox.project, title: 'w', goal: '' });
  const workId = (created.at(-1)?.result as { workId: string }).workId;
  const seen = await rpc(sandbox.client, 'sessions.create', {
    projectPath: sandbox.project, workId, provider, label: '', task: 'do it', parent: null,
  });
  expect(seen.at(-1)?.error).toBeUndefined();
  return JSON.parse(await waitFile(sandbox.out)) as { argv: string[]; env: Record<string, string>; cwd: string };
}

const trustedJson = (project: string) => ({ numStartups: 3, projects: { [project]: { hasTrustDialogAccepted: true } } });

describe('своя сессия не трогает ~/.claude и обычный Claude (спека 6)', () => {
  it('saveCustom (linkClaude) → setKey → check → запуск заглушки → deleteCustom(removeFolder): ~/.claude и ~/.claude.json побайтно прежние', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 }));
    const sandbox = await boot({ fetch, userClaudeJson: trustedJson });
    const { client, claude } = sandbox;
    const treeBefore = await snapshot(claude);
    const jsonBefore = await sha(path.join(home, '.claude.json'));

    const ok = (seen: RawMessage[]) => expect(seen.at(-1)?.error).toBeUndefined();
    ok(await rpc(client, 'providers.saveCustom', draft));
    // Ссылки на навык и агента появились в папке провайдера — значит, проверка не пустая.
    expect(await readlink(path.join(home, 'providers', 'custom-kimi', 'skills', 'x'))).toBe(path.join(claude, 'skills', 'x'));
    ok(await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: KEY }));
    expect((await rpc(client, 'providers.check', { provider: 'custom-kimi' })).at(-1)?.result).toMatchObject({ check: { state: 'ok' } });
    const run = await startSession(sandbox, 'custom-kimi');
    expect(run.env['CLAUDE_CONFIG_DIR']).toBe(path.join(home, 'providers', 'custom-kimi'));
    ok(await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi', removeFolder: true }));
    // Удаление действительно прошло: папки и ключа нет, иначе «прежние» ~/.claude проверяли бы пустоту.
    await expect(lstat(path.join(home, 'providers', 'custom-kimi'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(home, 'secrets.json'), 'utf8').catch(() => '')).not.toContain('custom:custom-kimi');

    expect(await snapshot(claude)).toEqual(treeBefore);
    expect(await sha(path.join(home, '.claude.json'))).toBe(jsonBefore);
  });

  it('копия по шагам правила 5.8 и новый навык в папке провайдера: следующий prepare оставляет ~/.claude прежним, копия на месте', async () => {
    const { client, claude } = await boot();
    await rpc(client, 'providers.saveCustom', draft);
    const dir = path.join(home, 'providers', 'custom-kimi');
    const treeBefore = await snapshot(claude);

    const link = path.join(dir, 'skills', 'x');
    const temp = path.join(dir, 'skills', 'x.copy-tmp');
    await cp(path.join(claude, 'skills', 'x'), temp, { recursive: true }); // cp оригинала во временное имя
    await unlink(link); // rm ссылки без -r
    await rename(temp, link); // mv
    await writeFile(path.join(link, 'SKILL.md'), 'provider-only edit\n');
    await mkdir(path.join(dir, 'skills', 'new'), { recursive: true });
    await writeFile(path.join(dir, 'skills', 'new', 'SKILL.md'), 'new skill\n');

    await rpc(client, 'providers.saveCustom', { ...draft, id: 'custom-kimi' }); // следующий prepare
    expect(await snapshot(claude)).toEqual(treeBefore);
    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(link, 'SKILL.md'), 'utf8')).toBe('provider-only edit\n');
    expect(await readFile(path.join(dir, 'skills', 'new', 'SKILL.md'), 'utf8')).toBe('new skill\n');
    expect(await readFile(path.join(claude, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('skill x\n');
    // Ссылка на CLAUDE.md и агента не затронута.
    expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(claude, 'CLAUDE.md'));
  });

  it('реестр: registry.claude и registry.glm с двумя своими провайдерами и без них — deepEqual', async () => {
    home = await tempHome();
    process.env['HOME'] = home;
    const file = path.join(home, 'providers.json');
    const codex = path.join(home, 'codex-models.json');
    const customFile = core.customProvidersFile(home);
    const without = await core.loadProviders(file, codex, customFile);
    const base = { id: '', label: 'A', preset: null, baseUrl: 'https://a.example.com', auth: 'bearer' as const,
      models: { opus: 'o', sonnet: 's', haiku: 'h', subagent: 's' }, contextWindow: null, linkClaude: false };
    await core.writeCustomProviders([{ ...base, id: 'custom-a' }, { ...base, id: 'custom-b', label: 'B' }], customFile);
    const withCustom = await core.loadProviders(file, codex, customFile);
    expect(Object.keys(withCustom)).toEqual(expect.arrayContaining(['custom-a', 'custom-b']));
    expect(without['claude']).toBeDefined();
    expect(without['glm']).toBeDefined();
    expect(withCustom['claude']).toEqual(without['claude']);
    expect(withCustom['glm']).toEqual(without['glm']);
  });

  it('ключ custom-провайдера не встречается в логе хоста, в argv заглушки, в custom-providers.json, в ответе providers.list', async () => {
    const sandbox = await boot();
    const { client } = sandbox;
    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: KEY });
    const run = await startSession(sandbox, 'custom-kimi');
    const list = await rpc(client, 'providers.list');

    expect(JSON.stringify(run.argv)).not.toContain(KEY);
    expect(JSON.stringify(list)).not.toContain(KEY);
    // Лог должен существовать и быть непустым, иначе проверка ничего не проверяет.
    const log = await readFile(hostPaths(home).log, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(KEY);
    expect(await readFile(path.join(home, 'custom-providers.json'), 'utf8')).not.toContain(KEY);
    // Ключ есть там, где ему положено: secrets.json и окружение процесса сессии.
    expect(await readFile(path.join(home, 'secrets.json'), 'utf8')).toContain(KEY);
    expect(run.env['ANTHROPIC_AUTH_TOKEN']).toBe(KEY);
  });

  it('окружение заглушки custom-сессии: CLAUDE_CONFIG_DIR = папка провайдера, CLAUDE_SECURESTORAGE_CONFIG_DIR нет', async () => {
    process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = '/somewhere/else';
    const sandbox = await boot();
    process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = '/somewhere/else'; // boot() снимает её, ставим снова до запуска
    await rpc(sandbox.client, 'providers.saveCustom', draft);
    await rpc(sandbox.client, 'providers.setKey', { provider: 'custom-kimi', key: KEY });
    const run = await startSession(sandbox, 'custom-kimi');
    expect(run.env['CLAUDE_CONFIG_DIR']).toBe(path.join(home, 'providers', 'custom-kimi'));
    expect(run.env).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR');
  });

  it('префикс custom- одинаков в @parley/core и @parley/protocol', () => {
    expect(core.CUSTOM_PROVIDER_PREFIX).toBe(protocol.CUSTOM_PROVIDER_PREFIX);
  });
});

describe('первый запуск и ключ api-key (спека 6.2, К17, К18)', () => {
  it('доверие к папке перенесено в .claude.json провайдера, ~/.claude.json песочницы побайтно прежний', async () => {
    const sandbox = await boot({ userClaudeJson: trustedJson });
    const jsonBefore = await sha(path.join(home, '.claude.json'));
    await rpc(sandbox.client, 'providers.saveCustom', draft);
    await rpc(sandbox.client, 'providers.setKey', { provider: 'custom-kimi', key: KEY });
    await startSession(sandbox, 'custom-kimi');

    const own = JSON.parse(await readFile(path.join(home, 'providers', 'custom-kimi', '.claude.json'), 'utf8')) as OwnJson;
    expect(own.hasCompletedOnboarding).toBe(true);
    expect(own.projects?.[sandbox.project]?.hasTrustDialogAccepted).toBe(true);
    expect(await sha(path.join(home, '.claude.json'))).toBe(jsonBefore);
  });

  it('человек не доверял папке — в .claude.json провайдера доверия нет', async () => {
    const sandbox = await boot({ userClaudeJson: () => ({ projects: {} }) });
    await rpc(sandbox.client, 'providers.saveCustom', draft);
    await rpc(sandbox.client, 'providers.setKey', { provider: 'custom-kimi', key: KEY });
    await startSession(sandbox, 'custom-kimi');
    const own = JSON.parse(await readFile(path.join(home, 'providers', 'custom-kimi', '.claude.json'), 'utf8')) as OwnJson;
    expect(own.projects?.[sandbox.project]?.hasTrustDialogAccepted).toBeUndefined();
  });

  it('auth api-key: хвост ключа только в .claude.json папки провайдера; после clearKey его нет; полный ключ — лишь в secrets.json и окружении заглушки', async () => {
    const sandbox = await boot({ userClaudeJson: trustedJson });
    const jsonBefore = await sha(path.join(home, '.claude.json'));
    await rpc(sandbox.client, 'providers.saveCustom', { ...draft, auth: 'api-key' });
    await rpc(sandbox.client, 'providers.setKey', { provider: 'custom-kimi', key: KEY });
    const run = await startSession(sandbox, 'custom-kimi');
    const tail = KEY.slice(-20);
    const ownFile = path.join(home, 'providers', 'custom-kimi', '.claude.json');

    expect(JSON.parse(await readFile(ownFile, 'utf8')).customApiKeyResponses).toEqual({ approved: [tail], rejected: [] });
    expect(run.env['ANTHROPIC_API_KEY']).toBe(KEY);
    expect(run.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');

    // Хвост ни в одном файле вне папки провайдера, кроме secrets.json (там ключ целиком).
    const holders: string[] = [];
    async function scan(dir: string): Promise<void> {
      for (const name of await readdir(dir)) {
        const full = path.join(dir, name);
        const info = await lstat(full);
        if (info.isDirectory()) { if (!full.startsWith(path.join(home, 'providers'))) await scan(full); continue; }
        if (!info.isFile() || info.size > 5_000_000) continue;
        if ((await readFile(full, 'utf8').catch(() => '')).includes(tail)) holders.push(path.relative(home, full));
      }
    }
    await scan(home);
    // stub-out.json — вывод заглушки (окружение процесса), host.log — проверяется отдельно.
    expect(holders.sort()).toEqual(['secrets.json', 'stub-out.json']);
    const log = await readFile(hostPaths(home).log, 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(tail);
    expect(await sha(path.join(home, '.claude.json'))).toBe(jsonBefore);

    await rpc(sandbox.client, 'providers.clearKey', { provider: 'custom-kimi' });
    expect(await readFile(ownFile, 'utf8')).not.toContain(tail);
    expect(JSON.parse(await readFile(ownFile, 'utf8'))).not.toHaveProperty('customApiKeyResponses');
    expect(await readFile(path.join(home, 'secrets.json'), 'utf8').catch(() => '')).not.toContain(KEY);
  });
});

// Типы ответов нужны только для проверки компиляции списка.
void (null as unknown as Result<'providers.list'>);
