import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentChannel } from '../work/mcp-config.js';
import { fetchProviderRows } from './provider-rows.js';

const TOKEN = 'a'.repeat(64);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

/** Хост-заглушка: отвечает `reply` на любой запрос, запросы складывает в `seen`. */
async function fakeHost(reply: (req: IncomingMessage) => { status: number; body: string }): Promise<{ agent: AgentChannel; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    req.resume();
    const { status, body } = reply(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { agent: { url: `http://127.0.0.1:${port}/agent/browser`, token: TOKEN }, seen };
}

const limits = { fiveHour: { usedPercent: 42, resetsAt: '2026-10-22T15:00:00.000Z' }, week: null, at: '2026-10-22T12:00:00.000Z' };
const row = { id: 'claude', label: 'Claude Code', family: 'claude', available: true, needs: null, models: [{ id: 'opus', label: 'Opus' }], effort: true, limits };
const ok = (providers: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, result: { providers } }) });

describe('fetchProviderRows (спека подписок 5.8, К7)', () => {
  it('спрашивает хост POST /agent/providers с токеном сессии и отдаёт строки; лишние поля отбрасываются', async () => {
    const { agent, seen } = await fakeHost(() => ok([
      row,
      { id: 'custom-claude-2', label: 'Claude Code 2', family: 'claude', available: false, needs: 'sign-in', models: null, effort: false, limits: null, keyHint: 'sk-…abc', custom: { folder: '/x' }, version: '2.1.300' },
    ]));
    const rows = await fetchProviderRows(agent, new AbortController().signal);
    expect(rows).toEqual([
      row,
      { id: 'custom-claude-2', label: 'Claude Code 2', family: 'claude', available: false, needs: 'sign-in', models: null, effort: false, limits: null },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/agent/providers');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('недостающие необязательные поля строки получают безопасные значения', async () => {
    const { agent } = await fakeHost(() => ok([{ id: 'codex', label: 'Codex', available: true }]));
    expect(await fetchProviderRows(agent, new AbortController().signal)).toEqual([
      { id: 'codex', label: 'Codex', family: null, available: true, needs: null, models: null, effort: false, limits: null },
    ]);
  });

  it('null, когда порт закрыт', async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await fetchProviderRows({ url: `http://127.0.0.1:${port}/agent/browser`, token: TOKEN }, new AbortController().signal)).toBeNull();
  });

  it('null на отказ хоста, чужой статус, нечитаемое тело и кривую строку', async () => {
    for (const reply of [
      { status: 401, body: '' },
      { status: 404, body: '' },
      { status: 500, body: '{}' },
      { status: 200, body: 'not json' },
      { status: 200, body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'x' } }) },
      { status: 200, body: JSON.stringify({ ok: true, result: { providers: 'nope' } }) },
      { status: 200, body: JSON.stringify({ ok: true, result: {} }) },
      ok([{ id: 'claude', label: 'Claude Code' }]),
      ok([{ id: '', label: 'Claude Code', available: true }]),
      ok([null]),
    ]) {
      const { agent } = await fakeHost(() => reply);
      expect(await fetchProviderRows(agent, new AbortController().signal), JSON.stringify(reply)).toBeNull();
    }
  });

  it('null, когда вызов уже отменён', async () => {
    const { agent } = await fakeHost(() => ok([row]));
    expect(await fetchProviderRows(agent, AbortSignal.abort())).toBeNull();
  });
});
