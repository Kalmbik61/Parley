import { chmod, lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import type { AuthExec, AuthServiceOptions, PtySpawn } from '../providers/auth-service.js';
import { createCustomProviderHandlers } from './custom-providers.js';

let host: RunningHost | undefined;
let home: string;
let clients: TestClient[] = [];
let nextId = 5000;
const previousBinary = process.env['PARLEY_CLAUDE_BIN'];
const previousClaudeDir = process.env['CLAUDE_CONFIG_DIR'];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients) client.close();
  clients = [];
  await host?.context.shutdown('test-cleanup');
  host = undefined;
  if (home) await removeHome(home);
  if (previousBinary === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
  else process.env['PARLEY_CLAUDE_BIN'] = previousBinary;
  if (previousClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = previousClaudeDir;
});

/** Проверка входа, которая не отвечает: `signedIn` остаётся «не проверялось», пока тест сам не подменит службу входа. */
const silentAuth: AuthServiceOptions = {
  // Выход при удалении аккаунта отвечает сразу: молчащий выход держал бы очередь `serialized` всех тестов файла.
  exec: (_command, args) => (args[1] === 'logout' ? Promise.resolve({ code: 0, stdout: '' }) : new Promise(() => {})),
};

async function boot(options: { fetch?: typeof globalThis.fetch; version?: string; auth?: AuthServiceOptions } = {}) {
  home = await tempHome();
  const binary = path.join(home, 'claude-stub');
  await writeFile(binary, '#!/bin/sh\n', 'utf8');
  await chmod(binary, 0o755);
  process.env['PARLEY_CLAUDE_BIN'] = binary;
  // Папка Claude Code человека — песочница: настоящая ~/.claude не читается.
  process.env['CLAUDE_CONFIG_DIR'] = path.join(home, 'user-claude');
  host = await startHost({
    home,
    probeVersion: async () => options.version ?? '2.1.302',
    auth: options.auth ?? silentAuth,
    ...(options.fetch === undefined ? {} : { customCheck: { fetch: options.fetch } }),
  });
  const client = connectRaw(hostPaths(home).socket);
  clients.push(client);
  await waitConnected(client.socket);
  await hello(client, await readFile(hostPaths(home).token, 'utf8'));
  return client;
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

const draft = {
  id: null,
  label: 'Kimi',
  preset: 'kimi',
  baseUrl: 'https://api.example.com/anthropic',
  auth: 'bearer',
  models: { opus: 'm-big', sonnet: 'm-mid', haiku: 'm-small', subagent: 'm-mid' },
  contextWindow: null,
  linkClaude: false,
};

async function item(client: TestClient, id: string) {
  const seen = await rpc(client, 'providers.list');
  return (seen.at(-1)?.result as Result<'providers.list'>).providers.find((provider) => provider.id === id);
}

const exists = (file: string) => lstat(file).then(() => true, () => false);

describe('custom providers over RPC', () => {
  it('saveCustom без id создаёт custom-kimi, папку и запись; providers.list показывает его с needs key', async () => {
    const client = await boot();
    const seen = await rpc(client, 'providers.saveCustom', draft);
    expect(seen.at(-1)?.result).toEqual({ id: 'custom-kimi' });
    expect(await exists(path.join(home, 'providers', 'custom-kimi', 'projects'))).toBe(true);
    const row = await item(client, 'custom-kimi');
    expect(row).toMatchObject({
      available: false, needs: 'key', keyHint: null,
      custom: { baseUrl: draft.baseUrl, auth: 'bearer', linkClaude: false, folder: path.join(home, 'providers', 'custom-kimi') },
    });
    expect((await item(client, 'glm'))?.custom).toBeUndefined();
    // Второй с тем же именем получает другой id.
    expect((await rpc(client, 'providers.saveCustom', draft)).at(-1)?.result).toEqual({ id: 'custom-kimi-2' });
  });

  it('Review Focus 3: saveCustom с id и новым label — id, папка и ключ прежние', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: 'synthetic-kimi-key' });
    const seen = await rpc(client, 'providers.saveCustom', { ...draft, id: 'custom-kimi', label: 'Moonshot' });
    expect(seen.at(-1)?.result).toEqual({ id: 'custom-kimi' });
    expect(await item(client, 'custom-kimi')).toMatchObject({ label: 'Moonshot', needs: null, available: true });
    expect(await exists(path.join(home, 'providers', 'custom-kimi'))).toBe(true);
  });

  it('saveCustom: http на удалённый адрес → bad_request; неизвестный id → bad_request', async () => {
    const client = await boot();
    expect((await rpc(client, 'providers.saveCustom', { ...draft, baseUrl: 'http://api.example.com' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request' });
    expect((await rpc(client, 'providers.saveCustom', { ...draft, id: 'custom-nope' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request' });
  });

  it('setKey/clearKey для custom-kimi пишут secrets.json под custom:custom-kimi; keyHint в списке — маска', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', draft);
    const key = 'synthetic-kimi-key-123456';
    const reply = (await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key })).at(-1)?.result as Result<'providers.setKey'>;
    const secrets = await readFile(path.join(home, 'secrets.json'), 'utf8');
    expect(secrets).toContain('custom:custom-kimi');
    expect((await item(client, 'custom-kimi'))?.keyHint).toBe(reply.keyHint);
    expect(reply.keyHint).not.toContain(key);
    await rpc(client, 'providers.clearKey', { provider: 'custom-kimi' });
    expect(await item(client, 'custom-kimi')).toMatchObject({ keyHint: null, needs: 'key' });
    expect((await rpc(client, 'providers.setKey', { provider: 'claude', key })).at(-1)?.error).toMatchObject({ code: 'bad_request' });
  });

  it('clearKey убирает одобрение ключа из .claude.json папки провайдера (К17)', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', { ...draft, auth: 'api-key' });
    const file = path.join(home, 'providers', 'custom-kimi', '.claude.json');
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...data, customApiKeyResponses: { approved: ['x'], rejected: [] } }));
    await rpc(client, 'providers.clearKey', { provider: 'custom-kimi' });
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('customApiKeyResponses');
  });

  it('check для custom-kimi идёт через custom-check (заглушка fetch), для glm — прежним путём', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 }));
    const client = await boot({ fetch });
    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: 'synthetic-kimi-key' });
    const seen = await rpc(client, 'providers.check', { provider: 'custom-kimi' });
    expect(seen.at(-1)?.result).toMatchObject({ check: { state: 'ok' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('api.example.com');
    expect(await item(client, 'custom-kimi')).toMatchObject({ check: { state: 'ok' } });
    // Новый ключ — прежний исход забыт.
    await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: 'synthetic-kimi-key-2' });
    expect(await item(client, 'custom-kimi')).toMatchObject({ check: null });
    // GLM без ключа — null без сети.
    expect((await rpc(client, 'providers.check', { provider: 'glm' })).at(-1)?.result).toEqual({ check: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('deleteCustom: запись и ключ удалены, папка остаётся; removeFolder: true — папки нет', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: 'synthetic-kimi-key' });
    expect((await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi', removeFolder: false })).at(-1)?.result).toEqual({ ok: true });
    expect(await item(client, 'custom-kimi')).toBeUndefined();
    expect(await exists(path.join(home, 'providers', 'custom-kimi'))).toBe(true);
    expect(await readFile(path.join(home, 'secrets.json'), 'utf8').catch(() => '')).not.toContain('custom:custom-kimi');
    // Папка прежнего custom-kimi осталась, поэтому новый получает другой id.
    expect((await rpc(client, 'providers.saveCustom', draft)).at(-1)?.result).toEqual({ id: 'custom-kimi-2' });
    await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi-2', removeFolder: true });
    expect(await exists(path.join(home, 'providers', 'custom-kimi-2'))).toBe(false);
    expect((await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi-2', removeFolder: true })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request' });
  });

  it('каждое изменение рассылает providers.changed { provider: id }', async () => {
    const client = await boot();
    const saved = await rpc(client, 'providers.saveCustom', draft);
    expect(saved).toContainEqual({ event: 'providers.changed', data: { provider: 'custom-kimi' } });
    const keyed = await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: 'synthetic-kimi-key' });
    expect(keyed).toContainEqual({ event: 'providers.changed', data: { provider: 'custom-kimi' } });
    const cleared = await rpc(client, 'providers.clearKey', { provider: 'custom-kimi' });
    expect(cleared).toContainEqual({ event: 'providers.changed', data: { provider: 'custom-kimi' } });
    const deleted = await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi', removeFolder: false });
    expect(deleted).toContainEqual({ event: 'providers.changed', data: { provider: 'custom-kimi' } });
  });

  it('в custom-providers.json нет ключа ни в каком виде', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.setKey', { provider: 'custom-kimi', key: 'synthetic-kimi-key' });
    await rpc(client, 'providers.saveCustom', { ...draft, id: 'custom-kimi', label: 'Kimi 2' });
    const file = await readFile(path.join(home, 'custom-providers.json'), 'utf8');
    expect(file).not.toContain('synthetic-kimi-key');
    expect(file).not.toMatch(/key|secret|token/i);
  });

  it('новый провайдер с тем же именем не занимает папку удалённого (removeFolder: false) и забытый ключ', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', draft);
    await writeFile(path.join(home, 'providers', 'custom-kimi', 'history.txt'), 'old work');
    await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi', removeFolder: false });
    // Забытый ключ того же id, например от прерванного удаления.
    await writeFile(path.join(home, 'secrets.json'), JSON.stringify({ 'custom:custom-kimi-2': { key: 'forgotten-key' } }));
    const seen = await rpc(client, 'providers.saveCustom', draft);
    expect(seen.at(-1)?.result).toEqual({ id: 'custom-kimi-3' });
    expect(await readFile(path.join(home, 'providers', 'custom-kimi', 'history.txt'), 'utf8')).toBe('old work');
    expect(await item(client, 'custom-kimi-3')).toMatchObject({ needs: 'key', keyHint: null });
  });

  it('смена auth на bearer убирает хвост ключа из .claude.json провайдера (К17)', async () => {
    const client = await boot();
    await rpc(client, 'providers.saveCustom', { ...draft, auth: 'api-key' });
    const file = path.join(home, 'providers', 'custom-kimi', '.claude.json');
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...data, customApiKeyResponses: { approved: ['x'], rejected: [] } }));
    await rpc(client, 'providers.saveCustom', { ...draft, id: 'custom-kimi', auth: 'bearer' });
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('customApiKeyResponses');
  });

  it('setKey параллельно с deleteCustom не оставляет ключ без провайдера', async () => {
    const client = await boot();
    for (let round = 0; round < 12; round += 1) {
      await rpc(client, 'providers.saveCustom', draft);
      const ids = [nextId++, nextId++];
      client.send({ id: ids[0], method: 'providers.setKey', params: { provider: 'custom-kimi', key: 'synthetic-kimi-key' } });
      client.send({ id: ids[1], method: 'providers.deleteCustom', params: { id: 'custom-kimi', removeFolder: true } });
      const pending = new Set(ids);
      while (pending.size > 0) {
        const message = await client.next();
        if (typeof message.id === 'number') pending.delete(message.id);
      }
      const secrets = await readFile(path.join(home, 'secrets.json'), 'utf8').catch(() => '{}');
      expect(secrets).not.toContain('custom:custom-kimi');
    }
  });
});

// Аккаунты Claude Code (спека подписок 5.1, 5.5, 5.9, 10). Версия CLI — выше минимума аккаунта (2.1.304), иначе
// «старый CLI» перекроет «нужен вход».
const account = { kind: 'claude-account', id: null, label: '', link: true };

const recordsFile = async () =>
  (JSON.parse(await readFile(path.join(home, 'custom-providers.json'), 'utf8')) as { providers: unknown[] }).providers;

describe('аккаунты Claude Code по RPC (спека подписок 5.1, 5.5, 5.9)', () => {
  it('saveCustom без имени: custom-claude-2, имя «Claude Code 2» в записи без адреса, папка с .claude.json и ссылками', async () => {
    const client = await boot({ version: '2.1.306' });
    await mkdir(path.join(home, 'user-claude'), { recursive: true });
    await writeFile(path.join(home, 'user-claude', 'CLAUDE.md'), 'rules');
    const seen = await rpc(client, 'providers.saveCustom', account);
    expect(seen.at(-1)?.result).toEqual({ id: 'custom-claude-2' });
    expect(seen).toContainEqual({ event: 'providers.changed', data: { provider: 'custom-claude-2' } });
    // Ruling 6: стандартное имя записано в label, чтобы не сползать после удалений; ни адреса, ни ключа в записи нет.
    expect(await recordsFile()).toEqual([{ kind: 'claude-account', id: 'custom-claude-2', label: 'Claude Code 2', link: true }]);
    const dir = path.join(home, 'providers', 'custom-claude-2');
    expect(JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8'))).toMatchObject({ hasCompletedOnboarding: true });
    expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(home, 'user-claude', 'CLAUDE.md'));
    const row = await item(client, 'custom-claude-2');
    expect(row).toMatchObject({
      label: 'Claude Code 2', available: false, needs: 'sign-in', family: 'claude',
      custom: { kind: 'claude-account', link: true, folder: dir, signedIn: null, signingIn: false },
    });
    expect(row).not.toHaveProperty('keyHint');
    // У аккаунта нет ключа: сохранить его некуда.
    expect((await rpc(client, 'providers.setKey', { provider: 'custom-claude-2', key: 'synthetic-key' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request' });
  });

  it('следующие аккаунты: custom-claude-3 и «Claude Code 3»; своё имя в id не входит', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    expect((await rpc(client, 'providers.saveCustom', account)).at(-1)?.result).toEqual({ id: 'custom-claude-3' });
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Claude Code 3' });
    expect((await rpc(client, 'providers.saveCustom', { ...account, label: 'Work' })).at(-1)?.result).toEqual({ id: 'custom-claude-4' });
    expect(await item(client, 'custom-claude-4')).toMatchObject({ label: 'Work' });
  });

  it('id аккаунта обходит занятое: запись своего провайдера, оставшуюся папку и забытый ключ', async () => {
    const client = await boot({ version: '2.1.306' });
    // Запись с адресом, чей id совпал со стандартным slug аккаунта.
    await rpc(client, 'providers.saveCustom', { ...draft, label: 'Claude 2' });
    await mkdir(path.join(home, 'providers', 'custom-claude-3'), { recursive: true });
    await writeFile(path.join(home, 'secrets.json'), JSON.stringify({ 'custom:custom-claude-4': { key: 'forgotten-key' } }));
    expect((await rpc(client, 'providers.saveCustom', account)).at(-1)?.result).toEqual({ id: 'custom-claude-5' });
  });

  it('правка аккаунта: id и папка прежние, имя и link меняются; пустое имя остаётся стандартным, ссылки снимаются', async () => {
    const client = await boot({ version: '2.1.306' });
    await mkdir(path.join(home, 'user-claude'), { recursive: true });
    await writeFile(path.join(home, 'user-claude', 'CLAUDE.md'), 'rules');
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.saveCustom', account);
    const link = path.join(home, 'providers', 'custom-claude-2', 'CLAUDE.md');
    expect(await exists(link)).toBe(true);
    const seen = await rpc(client, 'providers.saveCustom', { ...account, id: 'custom-claude-2', label: 'Work', link: false });
    expect(seen.at(-1)?.result).toEqual({ id: 'custom-claude-2' });
    expect(await exists(link)).toBe(false);
    expect(await item(client, 'custom-claude-2')).toMatchObject({ label: 'Work', custom: { link: false } });
    // Пустое имя при правке: стандартное по числу аккаунтов до этого, а не по всем (второй остаётся «3»).
    await rpc(client, 'providers.saveCustom', { ...account, id: 'custom-claude-3' });
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Claude Code 3' });
    await rpc(client, 'providers.saveCustom', { ...account, id: 'custom-claude-2' });
    expect(await item(client, 'custom-claude-2')).toMatchObject({ label: 'Claude Code 2' });
  });

  it('вид сверяется: аккаунт Codex пока отказан; вид против префикса id; запись другого вида не правится', async () => {
    const client = await boot({ version: '2.1.306' });
    const codex = await rpc(client, 'providers.saveCustom', { ...account, kind: 'codex-account' });
    expect(codex.at(-1)?.error).toMatchObject({ code: 'bad_request', message: 'Codex accounts are not supported by this host yet' });
    expect(await exists(path.join(home, 'custom-providers.json'))).toBe(false);
    expect((await rpc(client, 'providers.saveCustom', { ...account, id: 'codex-two' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request', message: 'The id does not match the kind of the provider' });
    expect((await rpc(client, 'providers.saveCustom', { ...draft, id: 'codex-two' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request', message: 'The id does not match the kind of the provider' });

    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.saveCustom', account);
    const before = await recordsFile();
    // Запись с адресом не правится как аккаунт и наоборот: id верный, вид не совпал с записью.
    expect((await rpc(client, 'providers.saveCustom', { ...account, id: 'custom-kimi', label: 'Work' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request' });
    expect((await rpc(client, 'providers.saveCustom', { ...draft, id: 'custom-claude-2' })).at(-1)?.error)
      .toMatchObject({ code: 'bad_request' });
    expect(await recordsFile()).toEqual(before);
  });

  it('deleteCustom аккаунта: запись убрана; папка остаётся или удаляется по removeFolder', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.saveCustom', account);
    const kept = await rpc(client, 'providers.deleteCustom', { id: 'custom-claude-2', removeFolder: false });
    expect(kept.at(-1)?.result).toEqual({ ok: true });
    expect(kept).toContainEqual({ event: 'providers.changed', data: { provider: 'custom-claude-2' } });
    expect(await item(client, 'custom-claude-2')).toBeUndefined();
    expect(await exists(path.join(home, 'providers', 'custom-claude-2'))).toBe(true);
    // Имя уцелевшего не сползло (Ruling 6), а оставшаяся папка занимает id.
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Claude Code 3' });
    expect((await rpc(client, 'providers.saveCustom', account)).at(-1)?.result).toEqual({ id: 'custom-claude-4' });
    // Имя следует за номером в id, а не за числом аккаунтов (решение 7): «3» уже занято, поэтому не «3».
    expect(await item(client, 'custom-claude-4')).toMatchObject({ label: 'Claude Code 4' });
    await rpc(client, 'providers.deleteCustom', { id: 'custom-claude-4', removeFolder: true });
    expect(await exists(path.join(home, 'providers', 'custom-claude-4'))).toBe(false);
  });

  it('решение 7: id и имя выдаются вместе — после удалений с папкой стандартные имена не повторяются', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.deleteCustom', { id: 'custom-claude-2', removeFolder: true });
    // Двойка свободна, живёт «Claude Code 3»: счёт «число аккаунтов + 2» дал бы новому тоже «3».
    expect((await rpc(client, 'providers.saveCustom', account)).at(-1)?.result).toEqual({ id: 'custom-claude-2' });
    expect(await item(client, 'custom-claude-2')).toMatchObject({ label: 'Claude Code 2' });
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Claude Code 3' });

    // Живут 2, 3, 4; удалена средняя — новый занимает её место, а не получает «4» второй раз.
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.deleteCustom', { id: 'custom-claude-3', removeFolder: true });
    expect((await rpc(client, 'providers.saveCustom', account)).at(-1)?.result).toEqual({ id: 'custom-claude-3' });
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Claude Code 3' });
    const labels = (await recordsFile()).map((record) => (record as { label: string }).label);
    expect([...labels].sort()).toEqual(['Claude Code 2', 'Claude Code 3', 'Claude Code 4']);
  });

  it('пустое имя при правке возвращает имя по id, а своё имя в id не входит', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.saveCustom', { ...account, id: 'custom-claude-3', label: 'Work' });
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Work' });
    await rpc(client, 'providers.saveCustom', { ...account, id: 'custom-claude-3' });
    expect(await item(client, 'custom-claude-3')).toMatchObject({ label: 'Claude Code 3' });
  });
});

// Служба входа по RPC (спека подписок 5.5, К5, К14, К17): настоящий хост, фальшивые команды CLI и PTY.
const SIGNED_IN = JSON.stringify({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' });
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const ACCOUNT = 'custom-claude-2';

function stubSpawn() {
  const processes: Array<{ launch: PtyLaunch; written: string[]; resizes: Array<[number, number]>; emit(data: string): void; exit(exitCode: number): void }> = [];
  const spawn: PtySpawn = (launch) => {
    const data = new Set<(chunk: string) => void>();
    const exits = new Set<(exit: { exitCode: number; signal: number | null }) => void>();
    const written: string[] = [];
    const resizes: Array<[number, number]> = [];
    processes.push({
      launch,
      written,
      resizes,
      emit: (chunk) => data.forEach((listener) => listener(chunk)),
      exit: (exitCode) => exits.forEach((listener) => listener({ exitCode, signal: null })),
    });
    return {
      pid: 1,
      write: (chunk) => void written.push(chunk),
      resize: (cols, rows) => void resizes.push([cols, rows]),
      kill: () => exits.forEach((listener) => listener({ exitCode: 0, signal: 1 })),
      onData: (listener) => (data.add(listener), () => data.delete(listener)),
      onExit: (listener) => (exits.add(listener), () => exits.delete(listener)),
    };
  };
  return { spawn, processes };
}

/** Следующее событие с этим именем; остальные сообщения пропускаются. */
async function eventNamed(client: TestClient, name: string): Promise<unknown> {
  for (;;) {
    const message = await client.next();
    if (message.event === name) return message.data;
  }
}

describe('вход в аккаунт по RPC (спека подписок 5.5, К5, К14, К17)', () => {
  it('saveCustom проверяет вход в фоне: providers.list — signedIn из службы, authStatus — signedIn и подпись', async () => {
    const calls: string[][] = [];
    const exec: AuthExec = async (_command, args) => (calls.push(args), { code: 0, stdout: SIGNED_IN });
    const client = await boot({ version: '2.1.306', auth: { exec } });
    await rpc(client, 'providers.saveCustom', account);
    await vi.waitFor(async () => {
      expect(await item(client, ACCOUNT)).toMatchObject({ available: true, needs: null, custom: { signedIn: true, signingIn: false } });
    });
    expect(calls).toEqual([['auth', 'status', '--json']]);
    expect((await rpc(client, 'providers.authStatus', { provider: ACCOUNT })).at(-1)?.result)
      .toEqual({ signedIn: true, detail: 'me@example.com · max' });
  });

  it('вход: signIn → вывод и выход событиями; signingIn в списке; второй вход — conflict; ввод и размер доходят до процесса', async () => {
    const { spawn, processes } = stubSpawn();
    const client = await boot({ version: '2.1.306', auth: { exec: async () => ({ code: 1, stdout: SIGNED_OUT }), spawn } });
    await rpc(client, 'providers.saveCustom', account);

    expect((await rpc(client, 'providers.signIn', { provider: ACCOUNT })).at(-1)?.result).toEqual({ ok: true });
    expect(processes[0]?.launch).toMatchObject({ args: ['auth', 'login', '--claudeai'], cwd: path.join(home, 'providers', ACCOUNT) });
    expect(await item(client, ACCOUNT)).toMatchObject({ custom: { signingIn: true } });

    processes[0]?.emit('Paste code here if prompted > ');
    expect(await eventNamed(client, 'providers.signInOutput')).toEqual({ provider: ACCOUNT, data: 'Paste code here if prompted > ' });

    expect((await rpc(client, 'providers.signIn', { provider: ACCOUNT })).at(-1)?.error)
      .toMatchObject({ code: 'conflict', message: 'another sign-in is running' });
    expect((await rpc(client, 'providers.signInInput', { provider: ACCOUNT, data: 'the-code\r' })).at(-1)?.result).toEqual({ ok: true });
    expect((await rpc(client, 'providers.signInResize', { provider: ACCOUNT, cols: 120, rows: 30 })).at(-1)?.result).toEqual({ ok: true });
    expect(processes[0]?.written).toEqual(['the-code\r']);
    expect(processes[0]?.resizes).toEqual([[120, 30]]);

    processes[0]?.exit(0);
    expect(await eventNamed(client, 'providers.signInExit')).toEqual({ provider: ACCOUNT, exitCode: 0, signedIn: false });
    expect(await item(client, ACCOUNT)).toMatchObject({ custom: { signedIn: false, signingIn: false } });
  });

  it('cancelSignIn убивает процесс; signOut зовёт logout и перепроверяет вход', async () => {
    const { spawn, processes } = stubSpawn();
    const calls: string[][] = [];
    const exec: AuthExec = async (_command, args) => (calls.push(args), { code: 0, stdout: args[1] === 'status' ? SIGNED_IN : '' });
    const client = await boot({ version: '2.1.306', auth: { exec, spawn } });
    await rpc(client, 'providers.saveCustom', account);

    await rpc(client, 'providers.signIn', { provider: ACCOUNT });
    expect((await rpc(client, 'providers.cancelSignIn', { provider: ACCOUNT })).at(-1)?.result).toEqual({ ok: true });
    expect(await eventNamed(client, 'providers.signInExit')).toMatchObject({ provider: ACCOUNT, exitCode: 129 });

    calls.length = 0;
    expect((await rpc(client, 'providers.signOut', { provider: ACCOUNT })).at(-1)?.result).toEqual({ ok: true });
    expect(calls).toEqual([['auth', 'logout'], ['auth', 'status', '--json']]);
    expect(processes).toHaveLength(1);
  });

  it('состояние, вход и выход отказывают не аккаунту: встроенный claude, свой провайдер с адресом, неизвестный id — bad_request', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', draft);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['providers.authStatus', {}],
      ['providers.signIn', {}],
      ['providers.signOut', {}],
    ];
    for (const provider of ['claude', 'glm', 'custom-kimi', 'custom-nothing']) {
      for (const [method, extra] of calls) {
        const seen = await rpc(client, method, { provider, ...extra });
        expect(seen.at(-1)?.error, `${method} ${provider}`).toMatchObject({ code: 'bad_request', message: `${provider} is not an account` });
      }
    }
  });

  it('ввод, размер и отмена реестр не читают: без идущего входа этого id — bad_request, у не-аккаунта тоже', async () => {
    const { spawn } = stubSpawn();
    const client = await boot({ version: '2.1.306', auth: { exec: async () => ({ code: 1, stdout: SIGNED_OUT }), spawn } });
    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.saveCustom', account);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['providers.signInInput', { data: 'x' }],
      ['providers.signInResize', { cols: 80, rows: 24 }],
      ['providers.cancelSignIn', {}],
    ];
    // Аккаунт есть, но вход не идёт; встроенный, свой с адресом и неизвестный id входов не имеют вовсе.
    for (const provider of [ACCOUNT, 'claude', 'glm', 'custom-kimi', 'custom-nothing']) {
      for (const [method, extra] of calls) {
        const seen = await rpc(client, method, { provider, ...extra });
        expect(seen.at(-1)?.error, `${method} ${provider}`).toMatchObject({ code: 'bad_request', message: `no sign-in is running for ${provider}` });
      }
    }
  });

  it('несколько вводов подряд без ожидания ответа доходят до процесса в том же порядке', async () => {
    const { spawn, processes } = stubSpawn();
    const client = await boot({ version: '2.1.306', auth: { exec: async () => ({ code: 1, stdout: SIGNED_OUT }), spawn } });
    await rpc(client, 'providers.saveCustom', account);
    await rpc(client, 'providers.signIn', { provider: ACCOUNT });

    const typed = [...'the-code-from-browser\r'];
    const ids = typed.map(() => nextId++);
    typed.forEach((data, at) => client.send({ id: ids[at], method: 'providers.signInInput', params: { provider: ACCOUNT, data } }));
    const pending = new Set(ids);
    while (pending.size > 0) {
      const message = await client.next();
      if (typeof message.id === 'number') pending.delete(message.id);
    }
    expect(processes[0]?.written).toEqual(typed);
  });

  it('удалённый аккаунт забыт службой и разлогинен самим удалением: новый на том же id не наследует вход', async () => {
    // Вход «лежит в связке ключей»: его снимает только настоящий `auth logout`, вручную статус здесь не переключается.
    let status = SIGNED_IN;
    const exec: AuthExec = async (_command, args) => {
      if (args[1] === 'logout') {
        status = SIGNED_OUT;
        return { code: 0, stdout: '' };
      }
      return { code: 0, stdout: status };
    };
    const client = await boot({ version: '2.1.306', auth: { exec } });
    await rpc(client, 'providers.saveCustom', account);
    await vi.waitFor(async () => expect((await item(client, ACCOUNT))?.custom).toMatchObject({ signedIn: true }));

    // Без предварительного Sign out.
    await rpc(client, 'providers.deleteCustom', { id: ACCOUNT, removeFolder: true });
    expect(status).toBe(SIGNED_OUT);
    expect((await rpc(client, 'providers.saveCustom', account)).at(-1)?.result).toEqual({ id: ACCOUNT });
    // Без `forget` кэш (30 с) вернул бы прежнее `true`.
    await vi.waitFor(async () => expect((await item(client, ACCOUNT))?.custom).toMatchObject({ signedIn: false }));
  });

  it('удаление аккаунта: выход идёт до удаления записи и папки, в окружении аккаунта (решение 12)', async () => {
    const seen: Array<{ args: string[]; cwd: string; config: string | undefined; folder: boolean; records: number }> = [];
    const exec: AuthExec = async (_command, args, env, cwd) => {
      if (args[1] === 'logout') {
        seen.push({ args, cwd, config: env['CLAUDE_CONFIG_DIR'], folder: await exists(cwd), records: (await recordsFile()).length });
      }
      return { code: 0, stdout: args[1] === 'status' ? SIGNED_IN : '' };
    };
    const client = await boot({ version: '2.1.306', auth: { exec } });
    await rpc(client, 'providers.saveCustom', account);
    const dir = path.join(home, 'providers', ACCOUNT);

    expect((await rpc(client, 'providers.deleteCustom', { id: ACCOUNT, removeFolder: true })).at(-1)?.result).toEqual({ ok: true });

    // На момент выхода папка и запись ещё на месте; после ответа их нет.
    expect(seen).toEqual([{ args: ['auth', 'logout'], cwd: dir, config: dir, folder: true, records: 1 }]);
    expect(await exists(dir)).toBe(false);
    expect(await recordsFile()).toEqual([]);
  });

  it('упавший выход удалению не мешает; у своего провайдера с адресом выхода нет', async () => {
    const calls: string[][] = [];
    const exec: AuthExec = async (_command, args) => {
      calls.push(args);
      if (args[1] === 'logout') throw new Error('spawn ENOENT');
      return { code: 0, stdout: SIGNED_IN };
    };
    const client = await boot({ version: '2.1.306', auth: { exec } });
    await rpc(client, 'providers.saveCustom', account);
    expect((await rpc(client, 'providers.deleteCustom', { id: ACCOUNT, removeFolder: true })).at(-1)?.result).toEqual({ ok: true });
    expect(await item(client, ACCOUNT)).toBeUndefined();
    expect(await exists(path.join(home, 'providers', ACCOUNT))).toBe(false);
    expect(calls.filter((args) => args[1] === 'logout')).toHaveLength(1);

    await rpc(client, 'providers.saveCustom', draft);
    await rpc(client, 'providers.deleteCustom', { id: 'custom-kimi', removeFolder: true });
    expect(calls.filter((args) => args[1] === 'logout')).toHaveLength(1);
  });

  it('у аккаунта нет ключа: удаление не трогает ни секреты, ни одобрение ключа в папке (спека подписок 5.3, К12)', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    // Чужой ключ под тем же id и хвост одобрения в папке: `clearSecret` и `syncApiKeyApproval` стёрли бы оба.
    const secrets = path.join(home, 'secrets.json');
    await writeFile(secrets, JSON.stringify({ [`custom:${ACCOUNT}`]: { key: 'stray-key' } }));
    const file = path.join(home, 'providers', ACCOUNT, '.claude.json');
    const data = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...data, customApiKeyResponses: { approved: ['x'], rejected: [] } }));

    expect((await rpc(client, 'providers.deleteCustom', { id: ACCOUNT, removeFolder: false })).at(-1)?.result).toEqual({ ok: true });

    expect(await readFile(secrets, 'utf8')).toContain(`custom:${ACCOUNT}`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('customApiKeyResponses');
  });
});

// Папка с живыми сессиями не удаляется (спека подписок 10): хост передаёт обработчикам, идёт ли сессия провайдера.
describe('deleteCustom и живые сессии (спека подписок 10)', () => {
  const request = { host: { broadcast: vi.fn() } } as never;
  function handlers(live: (id: string) => boolean) {
    const auth = { refresh: vi.fn(async () => true), forget: vi.fn(), logout: vi.fn(async () => {}) };
    return { auth, remove: createCustomProviderHandlers(undefined, auth, live)['providers.deleteCustom'] };
  }

  it('аккаунт: removeFolder при живой сессии — conflict с именем; выход не зовётся, запись и папка целы', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    const { auth, remove } = handlers((id) => id === ACCOUNT);
    const dir = path.join(home, 'providers', ACCOUNT);

    await expect(remove({ id: ACCOUNT, removeFolder: true }, request)).rejects.toMatchObject({
      code: 'conflict',
      message: 'Claude Code 2 has running sessions: stop them before deleting its folder',
    });
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.forget).not.toHaveBeenCalled();
    expect(await recordsFile()).toHaveLength(1);
    expect(await exists(dir)).toBe(true);

    // Без removeFolder запись уходит, как прежде: сессии дорабатывают ход, папка остаётся.
    await expect(remove({ id: ACCOUNT, removeFolder: false }, request)).resolves.toEqual({ ok: true });
    expect(auth.logout).toHaveBeenCalledWith(ACCOUNT);
    expect(auth.forget).toHaveBeenCalledWith(ACCOUNT);
    expect(await recordsFile()).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });

  it('аккаунт: сессий не осталось — папка удаляется', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', account);
    let live = true;
    const { remove } = handlers(() => live);
    await expect(remove({ id: ACCOUNT, removeFolder: true }, request)).rejects.toMatchObject({ code: 'conflict' });
    live = false;
    await expect(remove({ id: ACCOUNT, removeFolder: true }, request)).resolves.toEqual({ ok: true });
    expect(await exists(path.join(home, 'providers', ACCOUNT))).toBe(false);
  });

  it('свой провайдер с адресом: то же правило', async () => {
    const client = await boot({ version: '2.1.306' });
    await rpc(client, 'providers.saveCustom', draft);
    const { auth, remove } = handlers((id) => id === 'custom-kimi');
    const dir = path.join(home, 'providers', 'custom-kimi');

    await expect(remove({ id: 'custom-kimi', removeFolder: true }, request)).rejects.toMatchObject({
      code: 'conflict',
      message: 'Kimi has running sessions: stop them before deleting its folder',
    });
    expect(await recordsFile()).toHaveLength(1);
    expect(await exists(dir)).toBe(true);

    await expect(remove({ id: 'custom-kimi', removeFolder: false }, request)).resolves.toEqual({ ok: true });
    expect(auth.logout).not.toHaveBeenCalled();
    expect(await recordsFile()).toEqual([]);
    expect(await exists(dir)).toBe(true);
  });
});
