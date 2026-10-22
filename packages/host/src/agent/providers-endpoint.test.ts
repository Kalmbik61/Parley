import { createServer, request, type Server } from 'node:http';
import type { Result } from '@parley/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { AGENT_PROVIDERS_PATH, createProvidersEndpoint, providerRowsOf } from './providers-endpoint.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const ref = { projectPath: '/trusted/project', workId: 'w-01', sessionId: 's-01' };
const limits = { fiveHour: { usedPercent: 42, resetsAt: '2026-10-22T15:00:00.000Z' }, week: null, at: '2026-10-22T12:00:00.000Z' };
const rows = [
  { id: 'claude', label: 'Claude Code', family: 'claude' as const, available: true, needs: null, models: null, effort: true, limits },
  { id: 'custom-claude-2', label: 'Claude Code 2', family: 'claude' as const, available: false, needs: 'sign-in' as const, models: null, effort: true, limits: null },
];

async function setup(list = vi.fn(async () => rows)) {
  const registry = createBrowserEndpoint({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clients: () => [], roomsOf: () => [] });
  const endpoint = createProvidersEndpoint({ authenticate: req => registry.authenticate(req), list });
  const server = createServer((req, res) => endpoint.handle(req, res));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const token = registry.register(ref);
  const post = (bearer: string = token, data = '') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: AGENT_PROVIDERS_PATH, headers: { Authorization: `Bearer ${bearer}`, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on('error', reject); req.end(data);
  });
  return { registry, list, post };
}

describe('agent providers endpoint (спека подписок 5.8, К7)', () => {
  it('путь — /agent/providers', () => {
    expect(AGENT_PROVIDERS_PATH).toBe('/agent/providers');
  });

  it('отвечает строками list тем, кто пришёл с токеном сессии; тело запроса не нужно', async () => {
    const { post, list } = await setup();
    const empty = await post();
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body)).toEqual({ ok: true, result: { providers: rows } });
    expect(JSON.parse((await post(undefined, '{}')).body)).toEqual({ ok: true, result: { providers: rows } });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('401 без токена, с чужим и снятым токеном; list не зовётся', async () => {
    const { post, list, registry } = await setup();
    expect((await post('')).status).toBe(401);
    expect((await post('f'.repeat(64))).status).toBe(401);
    registry.unregister(ref);
    expect((await post()).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('413 на заявленное слишком большое тело', async () => {
    const { post, list } = await setup();
    expect((await post(undefined, 'x'.repeat(70000))).status).toBe(413);
    expect(list).not.toHaveBeenCalled();
  });

  it('сбой list — ok: false с кодом, а не обрыв', async () => {
    const { post } = await setup(vi.fn(async () => { throw new Error('boom'); }));
    expect(JSON.parse((await post()).body)).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } });
  });
});

describe('providerRowsOf', () => {
  it('берёт из строки providers.list только то, что нужно агенту: без keyHint, check, custom; пропуски — безопасными значениями', () => {
    const result: Result<'providers.list'> = {
      providers: [
        {
          id: 'custom-claude-2', label: 'Claude Code 2', available: false, needs: 'sign-in', family: 'claude',
          models: [{ id: 'opus', label: 'Opus' }], effort: true, argsOverridden: false, version: '2.1.300', limits,
          keyHint: 'sk-…abc',
        },
        { id: 'old', label: 'Old host row', available: true },
      ],
    };
    expect(providerRowsOf(result)).toEqual([
      { id: 'custom-claude-2', label: 'Claude Code 2', family: 'claude', available: false, needs: 'sign-in', models: [{ id: 'opus', label: 'Opus' }], effort: true, limits },
      { id: 'old', label: 'Old host row', family: null, available: true, needs: null, models: null, effort: false, limits: null },
    ]);
  });
});
