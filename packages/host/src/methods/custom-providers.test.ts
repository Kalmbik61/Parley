import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

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

async function boot(options: { fetch?: typeof globalThis.fetch } = {}) {
  home = await tempHome();
  const binary = path.join(home, 'claude-stub');
  await writeFile(binary, '#!/bin/sh\n', 'utf8');
  await chmod(binary, 0o755);
  process.env['PARLEY_CLAUDE_BIN'] = binary;
  // Папка Claude Code человека — песочница: настоящая ~/.claude не читается.
  process.env['CLAUDE_CONFIG_DIR'] = path.join(home, 'user-claude');
  host = await startHost({
    home,
    probeVersion: async () => '2.1.302',
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
