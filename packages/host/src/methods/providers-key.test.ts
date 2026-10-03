import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@parley/core';
import type { Result } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { HostOptions, RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
import { createProvidersList } from './providers.js';

let host: RunningHost | undefined;
let home: string;
let clients: TestClient[] = [];
let nextId = 1000;
const previousBinary = process.env['PARLEY_CLAUDE_BIN'];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients) client.close();
  clients = [];
  await host?.context.shutdown('test-cleanup');
  host = undefined;
  if (home) await removeHome(home);
  if (previousBinary === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
  else process.env['PARLEY_CLAUDE_BIN'] = previousBinary;
});

async function connect(): Promise<{ client: TestClient; greeting: RawMessage }> {
  const client = connectRaw(hostPaths(home).socket);
  clients.push(client);
  await waitConnected(client.socket);
  const greeting = await hello(client, await readFile(hostPaths(home).token, 'utf8'));
  return { client, greeting };
}

async function boot(options: { cli?: boolean; version?: () => string | null; providersJson?: unknown; limits?: HostOptions['limits'] } = {}) {
  home = await tempHome();
  const binary = path.join(home, 'claude-stub');
  if (options.cli !== false) {
    await writeFile(binary, '#!/bin/sh\n', 'utf8');
    await chmod(binary, 0o755);
  }
  process.env['PARLEY_CLAUDE_BIN'] = binary;
  if (options.providersJson !== undefined) {
    await writeFile(path.join(home, 'providers.json'), JSON.stringify(options.providersJson));
  }
  host = await startHost({ home, probeVersion: async () => options.version?.() ?? '2.1.287', ...(options.limits === undefined ? {} : { limits: options.limits }) });
  return connect();
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

async function glm(client: TestClient) {
  const seen = await rpc(client, 'providers.list');
  const result = seen.at(-1)?.result as Result<'providers.list'>;
  return result.providers.find((provider) => provider.id === 'glm');
}

describe('provider readiness and key mutations over RPC', () => {
  it.each([false, true])('CLI present=%s: no key and saved key report coherent readiness', async (cli) => {
    const { client } = await boot({ cli });
    expect(await glm(client)).toMatchObject({
      available: false, needs: cli ? 'key' : 'cli', keyHint: null, family: 'claude',
    });
    await rpc(client, 'providers.setKey', { provider: 'glm', key: 'fake-ready-1234' });
    expect(await glm(client)).toMatchObject({
      available: cli, needs: cli ? null : 'cli', keyHint: '••••1234', family: 'claude', limits: null,
    });
  });

  it('manual refresh advertises its method, returns Z.ai provenance, and key removal clears it immediately', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 42 }] },
    })));
    const { client, greeting } = await boot({ limits: { fetch } });
    expect((greeting.result as Result<'hello'>).methods).toContain('providers.refreshLimits');
    expect(fetch).not.toHaveBeenCalled();
    await rpc(client, 'providers.setKey', { provider: 'glm', key: 'synthetic-quota-key' });
    const refreshed = await rpc(client, 'providers.refreshLimits');
    expect(refreshed.at(-1)?.result).toEqual({ ok: true });
    expect(await glm(client)).toMatchObject({ limits: { source: 'zai', fiveHour: { usedPercent: 42, resetsAt: null }, week: null } });
    const removed = await rpc(client, 'providers.clearKey', { provider: 'glm' });
    expect(removed).toContainEqual({ event: 'providers.limitsChanged', data: { id: 'glm', limits: null } });
    expect(await glm(client)).toMatchObject({ limits: null, keyHint: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    const log = await readFile(hostPaths(home).log, 'utf8');
    expect(log).not.toContain('synthetic-quota-key');
  });

  it('Check again sees an updated CLI version without restarting the host', async () => {
    let version = '2.1.286';
    const { client } = await boot({ version: () => version });
    await rpc(client, 'providers.setKey', { provider: 'glm', key: 'fake-update-2345' });
    expect(await glm(client)).toMatchObject({ available: false, needs: 'cli', version });
    version = '2.1.287';
    const seen = await rpc(client, 'providers.list');
    const result = seen.at(-1)?.result as Result<'providers.list'>;
    expect(result.providers.find((provider) => provider.id === 'glm')).toMatchObject({ available: true, needs: null, version });
    expect(result.providers.find((provider) => provider.id === 'claude')?.version).toBe(version);
  });

  it('hello advertises both mutations; set, replace and clear broadcast to both clients with only hints in replies', async () => {
    const { client, greeting } = await boot();
    expect((greeting.result as Result<'hello'>).methods).toEqual(expect.arrayContaining(['providers.setKey', 'providers.clearKey']));
    const { client: second } = await connect();
    const mutations = [
      { method: 'providers.setKey', params: { provider: 'glm', key: '  fake-first-1234  ' }, result: { keyHint: '••••1234' } },
      { method: 'providers.setKey', params: { provider: 'glm', key: 'tiny' }, result: { keyHint: '••••' } },
      { method: 'providers.setKey', params: { provider: 'glm', key: ` ${'x'.repeat(512)} ` }, result: { keyHint: '••••xxxx' } },
      { method: 'providers.clearKey', params: { provider: 'glm' }, result: { ok: true } },
    ];
    for (const mutation of mutations) {
      const seen = await rpc(client, mutation.method, mutation.params);
      expect(seen.at(-1)?.result).toEqual(mutation.result);
      expect(seen.filter((message) => message.event === 'providers.changed')).toEqual([
        { event: 'providers.changed', data: { provider: 'glm' } },
      ]);
      expect(await second.next()).toEqual({ event: 'providers.changed', data: { provider: 'glm' } });
    }
    expect(await glm(client)).toMatchObject({ available: false, needs: 'key', keyHint: null });
    const log = await readFile(hostPaths(home).log, 'utf8');
    for (const mutation of mutations) {
      if ('key' in mutation.params) expect(log).not.toContain(mutation.params.key.trim());
    }
  });

  it('unknown and non-secret providers, malformed keys and types return bad_request without secrets or change events', async () => {
    const { client } = await boot();
    const invalid = ['', ' ', 'fake key', 'fake\nkey', 'x'.repeat(513), 'fake\u200Bkey'];
    const requests = [
      ...invalid.map((key) => ({ method: 'providers.setKey', params: { provider: 'glm', key } })),
      { method: 'providers.setKey', params: { provider: 'glm', key: { secret: 'object-secret-9999' } } },
      { method: 'providers.setKey', params: { provider: 'missing', key: 'unknown-secret-9999' } },
      { method: 'providers.setKey', params: { provider: 'claude', key: 'claude-secret-9999' } },
      { method: 'providers.clearKey', params: { provider: 'missing' } },
      { method: 'providers.clearKey', params: { provider: 'codex' } },
    ];
    for (const request of requests) {
      const seen = await rpc(client, request.method, request.params);
      expect(seen.at(-1)?.error?.code).toBe('bad_request');
      expect(seen.some((message) => message.event === 'providers.changed')).toBe(false);
      const key = 'key' in request.params ? request.params.key : null;
      if (typeof key === 'string' && key.trim()) expect(JSON.stringify(seen)).not.toContain(key);
      expect(JSON.stringify(seen)).not.toContain('object-secret-9999');
    }
    expect(await glm(client)).toMatchObject({ keyHint: null });
    const log = await readFile(hostPaths(home).log, 'utf8');
    expect(log).not.toContain('secret-9999');
    expect(log).not.toContain('fake key');
  });

  it('secret storage filesystem failures return generic errors and emit no change event', async () => {
    const { client } = await boot();
    await mkdir(path.join(home, 'secrets.json'));
    const seen = await rpc(client, 'providers.setKey', { provider: 'glm', key: 'filesystem-secret-1234' });
    expect(seen.at(-1)?.error).toEqual({ code: 'internal', message: 'Unable to save provider key' });
    expect(seen.some((message) => message.event === 'providers.changed')).toBe(false);
    expect(await readFile(hostPaths(home).log, 'utf8')).not.toContain('filesystem-secret-1234');
    await rm(path.join(home, 'secrets.json'), { recursive: true });
  });

  it('custom GLM command stays unavailable without pretending its secret is missing', async () => {
    const { client } = await boot({ providersJson: { glm: { command: 'unsupported-cli' } } });
    expect(await glm(client)).toMatchObject({ available: false, needs: null, family: 'claude' });
  });

  it('one list read supplies both hint and readiness, even if the key changes on another read', async () => {
    await boot();
    const read = vi.spyOn(core, 'readSecret').mockResolvedValueOnce('snapshot-secret-1234').mockResolvedValue(null);
    const version = { ready: Promise.resolve(), get: () => '2.1.287', fresh: async () => '2.1.287' };
    const result = await createProvidersList(version)({}, {} as never);
    expect(result.providers.find((provider) => provider.id === 'glm')).toMatchObject({
      available: true, needs: null, keyHint: '••••1234',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
