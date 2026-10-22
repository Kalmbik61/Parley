import { createServer, request, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { createSessionEndpoint } from './session-endpoint.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const ref = { projectPath: '/trusted/project', workId: 'w-01', sessionId: 's-01' };
async function setup() {
  const registry = createBrowserEndpoint({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clients: () => [], roomsOf: () => [] });
  const create = vi.fn(async () => ({ ...ref, sessionId: 's-02' }));
  const endpoint = createSessionEndpoint({ authenticate: req => registry.authenticate(req), create });
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
  return { registry, create, post };
}
const args = { provider: 'codex', label: 'Peer', task: 'Implement' };
describe('agent session endpoint', () => {
  it('derives scope and actor from the bearer and creates a root', async () => {
    const { post, create } = await setup();
    const response = await post({ ...args, role: 'builtin:executor', model: 'model', effort: 'high', worktree: true });
    expect(JSON.parse(response.body)).toEqual({ ok: true, result: { sessionId: 's-02', provider: 'codex' } });
    expect(create).toHaveBeenCalledWith({ ...args, projectPath: ref.projectPath, workId: ref.workId, requestedBy: ref.sessionId, parent: null, lean: true, role: { source: 'builtin', name: 'executor' }, model: 'model', effort: 'high', worktree: true });
  });
  it('удержанный до согласия на папку запуск отвечает сразу с held: folder-trust', async () => {
    const { post, create } = await setup();
    create.mockResolvedValueOnce({ ...ref, sessionId: 's-03', held: 'folder-trust' } as never);
    expect(JSON.parse((await post(args)).body)).toEqual({ ok: true, result: { sessionId: 's-03', provider: 'codex', held: 'folder-trust' } });
  });
  it('rejects missing or revoked bearer tokens', async () => {
    const { post, create, registry } = await setup();
    expect((await post(args, '')).status).toBe(401);
    registry.unregister(ref);
    expect((await post(args)).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves explicit null model and effort choices that clear role defaults', async () => {
    const { post, create } = await setup();
    expect(JSON.parse((await post({ ...args, model: null, effort: null })).body)).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: null, effort: null, parent: null }));
  });
  it('rejects scope overrides, invalid fields and oversized bodies', async () => {
    const { post, create } = await setup();
    for (const extra of [{ parent: null }, { projectPath: '/other' }, { workId: 'w-other' }, { role: 'executor' }, { provider: '' }, { worktree: 'yes' }, { role: 'builtin:executor', agent: 'x' }]) {
      expect(JSON.parse((await post({ ...args, ...extra })).body)).toMatchObject({ ok: false });
    }
    expect((await post({ ...args, task: 'x'.repeat(70000) })).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
});
