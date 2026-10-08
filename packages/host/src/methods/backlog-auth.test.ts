import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBacklog } from '@parley/core';
import { connectRaw, hello, waitClosed, waitConnected } from '../../test/helpers.js';
import type { TestClient } from '../../test/helpers.js';
import { createHostContext } from '../context.js';
import { createHostServer } from '../server.js';
import { hostPaths } from '../paths.js';
import { createBacklogHandlers } from './backlog.js';
let project: string; let server: Server; const clients: TestClient[] = [];
beforeEach(async () => {
  project = await realpath(await mkdtemp('/private/tmp/p21-auth-'));
  const handle = createHostContext({ version: 'fixture', paths: hostPaths(project),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, onIdleChange: vi.fn(), registerShutdownHook: vi.fn(), requestShutdown: async () => {} });
  server = createHostServer({ context: handle.context, token: 'fixture-token', helloTimeoutMs: 1000,
    methodHandlers: createBacklogHandlers(), notificationHandlers: {}, registerClient: handle.addClient, unregisterClient: handle.removeClient });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(`${project}/socket`, resolve); });
});
afterEach(async () => { clients.splice(0).forEach(client => client.socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); await rm(project, { recursive: true, force: true }); });
async function client() { const result = connectRaw(`${project}/socket`); clients.push(result); await waitConnected(result.socket); return result; }

describe('backlog authenticated host transport boundary', () => {
  it('denies pre-hello and bad-token mutation before any shared write', async () => {
    const early = await client(); early.send({ id: 1, method: 'backlog.add', params: { projectPath: project, title: 'Must not write' } });
    expect((await early.next()).error?.code).toBe('unauthorized'); await waitClosed(early.socket);
    const wrong = await client(); expect((await hello(wrong, 'bad-token')).error?.code).toBe('unauthorized'); await waitClosed(wrong.socket);
    expect((await readBacklog(project)).items).toEqual([]);
  });
  it('allows the existing full-token manual API and rejects undeclared mutation fields on real socket framing', async () => {
    const manual = await client(); expect((await hello(manual, 'fixture-token', { client: 'caller-chosen-name' })).error).toBeUndefined();
    manual.send({ id: 2, method: 'backlog.add', params: { projectPath: project, title: 'Human item' } });
    expect((await manual.next()).result).toMatchObject({ items: [{ id: 'b-001', title: 'Human item', checked: false }] });
    manual.send({ id: 3, method: 'backlog.update', params: { projectPath: project, id: 'b-001', version: 'unused', patch: { taken: 'w-99/r-99', checked: true } } });
    const rejected = await manual.next(); expect(rejected.error?.code).toBe('bad_request');
    expect((await readBacklog(project)).items[0]).toMatchObject({ checked: false });
    // The token is the capability. This deliberately does not attest a caller-chosen client name as human identity.
  });
});
