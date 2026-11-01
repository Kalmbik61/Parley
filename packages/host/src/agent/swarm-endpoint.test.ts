import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig } from '@parley/core';
import { HostError } from '../errors.js';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { createSwarmEndpoint } from './swarm-endpoint.js';

const servers: Server[] = [];
// Песочница настроек: `leanAgents` читается из конфига, настоящий `~/.parley` тест не трогает.
let home = '';
beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'parley-swarm-endpoint-')); process.env['PARLEY_HOME'] = home; });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  delete process.env['PARLEY_HOME'];
  await rm(home, { recursive: true, force: true });
});
const ref = { projectPath: '/trusted/project', workId: 'w-01', sessionId: 's-01' };
async function setup() {
  const registry = createBrowserEndpoint({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clients: () => [], roomsOf: () => [] });
  const create = vi.fn(async () => ({ ...ref, sessionId: 's-02' }));
  const memberOf = vi.fn(async () => ({ swarmId: 'sw-01', role: 'queen' as const, n: 1 }));
  const endpoint = createSwarmEndpoint({ authenticate: req => registry.authenticate(req), create, memberOf });
  const server = createServer((req, res) => endpoint.handle(req, res));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const token = registry.register(ref);
  const post = (body: unknown, bearer: string = token) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text }));
    });
    req.on('error', reject); req.end(data);
  });
  return { registry, create, memberOf, post };
}
const create = { op: 'create', tag: 'Research', objective: 'Audit', provider: 'claude' };
const add = { op: 'add', role: 'drone', task: 'Read core', provider: 'claude' };

describe('agent swarm endpoint', () => {
  it('create: область и вызывающий из токена, рой в карте — внутреннее поле swarm', async () => {
    const { post, create: spawn } = await setup();
    const response = await post({ ...create, role: 'builtin:researcher', model: 'm', effort: 'high' });
    expect(JSON.parse(response.body)).toEqual({ ok: true, result: { swarmId: 'sw-01', queenSessionId: 's-02' } });
    expect(spawn).toHaveBeenCalledWith({
      projectPath: ref.projectPath, workId: ref.workId, requestedBy: ref.sessionId, parent: null, provider: 'claude', label: '', task: 'Audit',
      lean: true, swarm: { kind: 'create', tag: 'Research', objective: 'Audit' }, role: { source: 'builtin', name: 'researcher' }, model: 'm', effort: 'high',
    });
  });

  it('create: королева облегчённая и при leanAgents = false', async () => {
    await saveConfig({ leanAgents: false });
    const { post, create: spawn } = await setup();
    expect(JSON.parse((await post(create)).body).ok).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ lean: true, swarm: { kind: 'create', tag: 'Research', objective: 'Audit' } }));
  });

  it('add: участник по leanAgents — true и false', async () => {
    const { post, create: spawn, memberOf } = await setup();
    memberOf.mockResolvedValue({ swarmId: 'sw-01', role: 'drone', n: 1 });
    await saveConfig({ leanAgents: true });
    await post(add);
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ lean: true, swarm: { kind: 'add', role: 'drone' } }));
    await saveConfig({ leanAgents: false });
    await post(add);
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ lean: false, swarm: { kind: 'add', role: 'drone' } }));
  });

  it('add: трутень получает роль researcher, проверяющий — verifier; ответ называет участника', async () => {
    const { post, create: spawn, memberOf } = await setup();
    memberOf.mockResolvedValueOnce({ swarmId: 'sw-01', role: 'drone', n: 3 });
    expect(JSON.parse((await post(add)).body)).toEqual({ ok: true, result: { sessionId: 's-02', member: 'Drone 3' } });
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ task: 'Read core', label: '', swarm: { kind: 'add', role: 'drone' }, role: { source: 'builtin', name: 'researcher' } }));
    memberOf.mockResolvedValueOnce({ swarmId: 'sw-01', role: 'verifier', n: 1 });
    expect(JSON.parse((await post({ ...add, role: 'verifier', label: 'Check', agentRole: 'builtin:critic' })).body).result.member).toBe('Verifier 1');
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Check', swarm: { kind: 'add', role: 'verifier' }, role: { source: 'builtin', name: 'critic' } }));
    memberOf.mockResolvedValueOnce({ swarmId: 'sw-01', role: 'verifier', n: 2 });
    await post({ ...add, role: 'verifier' });
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ role: { source: 'builtin', name: 'verifier' } }));
  });

  it('участник в очереди машины: queued в ответе — у королевы при create и у участника при add', async () => {
    const { post, create: spawn, memberOf } = await setup();
    spawn.mockResolvedValueOnce({ ...ref, sessionId: 's-02', queued: 'machine-limit' } as never);
    expect(JSON.parse((await post(create)).body)).toEqual({ ok: true, result: { swarmId: 'sw-01', queenSessionId: 's-02', queued: 'machine-limit' } });
    spawn.mockResolvedValueOnce({ ...ref, sessionId: 's-03', queued: 'memory-critical' } as never);
    memberOf.mockResolvedValueOnce({ swarmId: 'sw-01', role: 'drone', n: 2 });
    expect(JSON.parse((await post(add)).body)).toEqual({ ok: true, result: { sessionId: 's-03', member: 'Drone 2', queued: 'memory-critical' } });
  });

  it('отказы хоста: код — причина роя или resource-budget, иначе код ошибки', async () => {
    const { post, create: spawn } = await setup();
    spawn.mockRejectedValueOnce(new HostError('conflict', 'Only the queen of a swarm can add members to it.', { reason: 'not-queen' }));
    expect(JSON.parse((await post(add)).body)).toEqual({ ok: false, error: { code: 'not-queen', message: 'Only the queen of a swarm can add members to it.' } });
    spawn.mockRejectedValueOnce(new HostError('conflict', 'limit', { code: 'resource-budget', reason: 'concurrent' }));
    expect(JSON.parse((await post(add)).body).error.code).toBe('resource-budget');
    spawn.mockRejectedValueOnce(new HostError('bad_request', 'The caller session is no longer available.'));
    expect(JSON.parse((await post(add)).body).error.code).toBe('bad_request');
  });

  it('отвергает чужие токены, подмену области, лишние и неверные аргументы; create не вызывается', async () => {
    const { post, create: spawn, registry } = await setup();
    expect((await post(create, '')).status).toBe(401);
    for (const bad of [
      { ...create, projectPath: '/other' }, { ...create, workId: 'w-x' }, { ...create, swarm: { kind: 'add' } }, { ...create, swarmId: 'sw-09' },
      { ...create, tag: '' }, { ...create, tag: 'x'.repeat(25) }, { ...create, tag: 'a\nb' }, { ...create, objective: ' ' }, { ...create, objective: 'x'.repeat(4097) },
      { ...create, role: 'executor' }, { ...create, provider: '' },
      { ...add, role: 'queen' }, { ...add, task: '' }, { ...add, tag: 'x' }, { ...add, worktree: true }, { ...add, agentRole: 'x' },
      { ...add, op: undefined }, { ...add, op: 'close' },
    ]) {
      expect(JSON.parse((await post(bad)).body), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect((await post({ ...add, task: 'x'.repeat(70000) })).status).toBe(413);
    registry.unregister(ref);
    expect((await post(add)).status).toBe(401);
    expect(spawn).not.toHaveBeenCalled();
  });
});
