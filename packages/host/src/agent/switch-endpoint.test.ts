import { createServer, request, type Server } from 'node:http';
import { addRoom, addSession, type WorkMap } from '@parley/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { createSwitchEndpoint, switchRequestDenial } from './switch-endpoint.js';

const T0 = '2026-10-30T10:00:00.000Z';
const ref = { projectPath: '/trusted/project', workId: 'w-01', sessionId: 's-01' };

/** s-01 — запрашивающий; s-02 — цель; остальные — по сценарию. */
function mapOf(setup: (map: WorkMap) => void = () => {}): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: { id: 'w-01', title: 't', goal: '', status: 'active', createdAt: T0, updatedAt: T0 },
    sessions: [],
    messages: [],
    rooms: [],
  };
  for (const label of ['asker', 'target', 'third']) addSession(map, { provider: 'claude', label, task: 'x' }, T0);
  setup(map);
  return map;
}

describe('switchRequestDenial (права на просьбу, спека замены агента 5.5)', () => {
  it('сама цель и создатель цели', () => {
    expect(switchRequestDenial(mapOf(), 's-02', 's-02')).toBeNull();
    expect(switchRequestDenial(mapOf((map) => { map.sessions[1]!.createdBy = 's-01'; }), 's-01', 's-02')).toBeNull();
    expect(switchRequestDenial(mapOf((map) => { map.sessions[1]!.parent = 's-01'; }), 's-01', 's-02')).toBeNull();
  });

  it('живой ведущий комнаты, где цель участник', () => {
    const map = mapOf((m) => { addRoom(m, { title: 'r', creator: 'human', members: ['s-01', 's-02'], lead: 's-01' }, T0); });
    expect(switchRequestDenial(map, 's-01', 's-02')).toBeNull();
  });

  it('владелец комнаты, где цель участник', () => {
    const map = mapOf((m) => { addRoom(m, { title: 'r', creator: 'human', members: ['s-02', 's-03'], ownerId: 's-01' }, T0); });
    expect(switchRequestDenial(map, 's-01', 's-02')).toBeNull();
  });

  it('отказ: чужой, участник без роли ведущего, закрытая и неизвестная цель', () => {
    expect(switchRequestDenial(mapOf(), 's-01', 's-02')).toMatch(/only the parent/);
    const plain = mapOf((m) => { addRoom(m, { title: 'r', creator: 'human', members: ['s-01', 's-02', 's-03'], lead: 's-03' }, T0); });
    expect(switchRequestDenial(plain, 's-01', 's-02')).toMatch(/only the parent/);
    // Ведущий есть, но цель в его комнате не участник.
    const other = mapOf((m) => { addRoom(m, { title: 'r', creator: 'human', members: ['s-01', 's-03'], lead: 's-01' }, T0); });
    expect(switchRequestDenial(other, 's-01', 's-02')).toMatch(/only the parent/);
    const closed = mapOf((m) => { m.sessions[1]!.lifecycle = 'closed'; });
    expect(switchRequestDenial(closed, 's-02', 's-02')).toMatch(/closed/);
    expect(switchRequestDenial(mapOf(), 's-01', 's-99')).toMatch(/not in this workspace/);
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

async function setup(map: WorkMap) {
  const registry = createBrowserEndpoint({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clients: () => [], roomsOf: () => [] });
  const ask = vi.fn();
  const endpoint = createSwitchEndpoint({
    authenticate: (req) => registry.authenticate(req),
    readMap: async () => map,
    providerLabel: async (provider) => (provider === 'codex' ? 'Codex' : null),
    request: ask,
  });
  const server = createServer((req, res) => endpoint.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const token = registry.register(ref);
  const post = (body: unknown, bearer = token) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port, method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on('error', reject); req.end(data);
  });
  return { ask, post };
}

const args = { session: 's-02', provider: 'codex', model: 'gpt-6-astra', reason: 'limit is near' };

describe('agent switch endpoint', () => {
  it('разрешённая просьба создаёт карточку и отвечает «asked @human»', async () => {
    const { post, ask } = await setup(mapOf((m) => { m.sessions[1]!.createdBy = 's-01'; }));
    expect(JSON.parse((await post(args)).body)).toEqual({ ok: true, result: { message: 'asked @human; the switch happens only after their answer' } });
    expect(ask).toHaveBeenCalledWith({
      ref: { ...ref, sessionId: 's-02' }, provider: 'codex', providerLabel: 'Codex', model: 'gpt-6-astra',
      reason: 'limit is near', requestedBy: { sessionId: 's-01', label: 'asker' },
    });
  });

  it('чужая просьба — forbidden с понятным текстом, карточки нет', async () => {
    const { post, ask } = await setup(mapOf());
    const body = JSON.parse((await post(args)).body);
    expect(body).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(body.error.message).toContain('only the parent');
    expect(ask).not.toHaveBeenCalled();
  });

  it('неизвестный провайдер, лишние и пустые поля, чужой токен', async () => {
    const { post, ask } = await setup(mapOf((m) => { m.sessions[1]!.createdBy = 's-01'; }));
    for (const bad of [{ ...args, provider: 'nope' }, { ...args, reason: ' ' }, { ...args, workId: 'w-x' }, { ...args, model: 5 }, { ...args, reason: 'x'.repeat(501) }]) {
      expect(JSON.parse((await post(bad)).body)).toMatchObject({ ok: false });
    }
    expect((await post(args, '')).status).toBe(401);
    expect(ask).not.toHaveBeenCalled();
  });
});
