import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain, IpcRenderer } from 'electron';
import { addSession, createWork, deleteWorkFiles, mailWorkMap, storeLetterReader, updateMap, writeLetters } from '@parley/core';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE, WORKS_SYNC_FEATURE, WORKS_SYNC_PAGE_BYTES, WorksSyncReducer } from '@parley/protocol';
import type { WorksSyncSurfaceBatch } from '@parley/protocol';
import type { Client, HostContext, HostPaths } from '@parley/host';
import { createHostServer } from '../../../host/src/server.js';
import { createWorksService } from '../../../host/src/works/works-service.js';
import { worksList, worksMailState, worksSync } from '../../../host/src/methods/works.js';
import { connectRaw, hello, waitConnected } from '../../../host/test/helpers.js';
import { HostConnection } from './host-connection.js';
import { bindHostWorksSync } from './works-sync.js';
import { bindWorksSyncWindow, forwardHostToPages } from './ipc.js';
import { createSyncRootsRegistry, worktreeRootPolicy } from './roots.js';
import { createWorksSyncBridge } from '../preload/works-sync.js';
import { useWorksStore } from '../renderer/store/works.js';
import { useRoomPagesStore } from '../renderer/store/room-pages.js';
import { makeWork } from '../renderer/test-utils/work-fixtures.js';
import type { ParleyBridge } from '../shared/bridge.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });
async function boot(enabled = true, count = 5, text = 20, mailDeadline = 1000) {
  const home = await mkdtemp('/private/tmp/p7-sync-');
  const priorHome = process.env.PARLEY_HOME; process.env.PARLEY_HOME = home;
  cleanups.push(async () => { if (priorHome === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = priorHome; await rm(home, { recursive: true, force: true }); });
  const project = path.join(home, 'project'); await mkdir(project); await writeFile(path.join(project, 'file.txt'), 'fixture');
  const created = await createWork(project, { title: 'integration', goal: 'fixture' });
  const workId = created.work.id;
  await updateMap(project, workId, map => {
    for (let i = 0; i < count; i++) addSession(map, { provider: 'codex', label: 'fixture', task: '雪'.repeat(text) });
    map.sessions[0]!.codexThreadBinding = { launchRevision: 'private-proof', pid: 123, startedAtProcess: 'fixture', threadId: 'SECRET-THREAD' };
  });
  const paths: HostPaths = { dir: home, socket: path.join(home, 'host.sock'), token: path.join(home, 'token'), pid: path.join(home, 'pid'), log: path.join(home, 'log') };
  await writeFile(paths.token, 'fixture');
  const clients = new Set<Client>(); const sockets: Socket[] = [];
  const context = { version: 'fixture', startedAt: 'now', paths, log: { info() {}, warn() {}, error() {} }, clients: () => [...clients], liveSessions: () => 0,
    broadcast(event, data, only) { for (const client of clients) if (only === undefined || only(client)) client.send({ event, data }); },
    onShutdown() {}, shutdown: async () => {}, busy() {}, hold() {} } as HostContext;
  const service = createWorksService(context, { debounceMs: 5, mailBatchMs: 5, ...(enabled ? { sync: { enabled: true as const } } : {}) });
  await service.start(); cleanups.push(() => service.stop());
  const calls: Array<{ method: string; params: unknown }> = [];
  const frames: number[] = [];
  let pause: { promise: Promise<void>; release(): void; continuation: boolean } | null = null;
  const syncHandler = worksSync(service);
  const mailHandler = worksMailState(service);
  let stallNextMail = false;
  const server = createHostServer({ context, token: 'fixture', helloTimeoutMs: 1000, methodHandlers: {
    'works.list': async (params, request) => { calls.push({ method: 'works.list', params }); return worksList(service)(params, request); },
    ...(enabled ? { 'works.sync': async (params, request) => {
      calls.push({ method: 'works.sync', params });
      if (pause !== null && (!pause.continuation || typeof params === 'object' && params !== null && 'cursor' in params)) await pause.promise;
      return syncHandler(params, request);
    }, 'works.mailState': async (params, request) => {
      const reply = await mailHandler(params, request);
      if (stallNextMail) { stallNextMail = false; return new Promise(() => {}); }
      return reply;
    } } : {}),
  }, notificationHandlers: {}, registerClient: client => {
    clients.add(client);
    const sendLine = client.sendLine!;
    client.sendLine = line => { frames.push(Buffer.byteLength(line));
      return sendLine(line);
    };
  }, unregisterClient: client => { clients.delete(client); service.sync?.dropClient(client.id); } });
  server.on('connection', socket => sockets.push(socket));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, resolve); });
  cleanups.push(async () => { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); });
  const spawn = vi.fn();
  const connection = new HostConnection({ paths, env: {}, spawn, worksSync: true, connectTimeoutMs: 1000, mailPageTimeoutMs: mailDeadline, processes: { kill: vi.fn(), isAlive: () => true, isHost: () => true, identity: () => 'fixture' } });
  cleanups.push(() => connection.close());
  const binding = bindHostWorksSync(connection); cleanups.push(() => binding.dispose());
  const roots = createSyncRootsRegistry(binding.sync, { home, acceptWorktree: worktreeRootPolicy({ home, worktreeRoot: async () => path.join(home, 'worktrees'), isRegistered: async () => false }) });
  cleanups.push(() => roots.dispose());
  const ipc = new EventEmitter();
  function surface(island = false) {
    const renderer = new EventEmitter(); const statuses: string[] = []; const batches: WorksSyncSurfaceBatch[] = [];
    const contents = Object.assign(new EventEmitter(), { mainFrame: {}, send: (channel: string, ...args: unknown[]) => {
      if (channel === 'host:status') statuses.push((args[0] as { state: string }).state);
      if (channel === 'works-sync:batch') batches.push(args[2] as WorksSyncSurfaceBatch);
      expect(Buffer.byteLength(JSON.stringify([channel, ...args]))).toBeLessThanOrEqual(WORKS_SYNC_PAGE_BYTES);
      renderer.emit(channel, {}, ...args);
    } });
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
    const event = { sender: contents, senderFrame: contents.mainFrame };
    Object.assign(renderer, { send: (channel: string, ...args: unknown[]) => { ipc.emit(channel, event, ...args); } });
    const bridge = createWorksSyncBridge(renderer as unknown as IpcRenderer);
    cleanups.push(bindWorksSyncWindow(ipc as IpcMain, window as unknown as BrowserWindow, binding.sync, island, () => connection.retryMailRecovery()));
    forwardHostToPages(connection, window as unknown as BrowserWindow, island ? { island: true } : {});
    contents.emit('did-finish-load');
    cleanups.push(() => { window.emit('closed'); });
    return { bridge, statuses, batches };
  }
  const main = surface();
  useWorksStore.setState({ entries: [], branches: {}, ready: false, loading: true, error: null });
  useRoomPagesStore.setState({ opened: {}, pending: {}, chains: {}, loading: {}, quotes: {} });
  const rendererBridge = { worksSync: main.bridge,
    call: ((method, params) => connection.call(method, params)) as ParleyBridge['call'],
    on: ((event, listener) => connection.onEvent(message => { if (message.event === event) listener(message.data as never); })) as ParleyBridge['on'],
    onStatus: ((listener) => connection.onStatus(listener)) as ParleyBridge['onStatus'],
  };
  const disposeStore = useWorksStore.getState().init(rendererBridge, { sync: true });
  cleanups.push(disposeStore);
  return { home, project, workId, service, connection, binding, roots, main, surface, calls, frames, clients, spawn,
    stallMail: () => { stallNextMail = true; },
    legacyRenderer: () => { disposeStore(); const off = useWorksStore.getState().init(rendererBridge); cleanups.push(off); },
    pause: (continuation = false) => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); pause = { promise, release, continuation }; return () => { pause = null; release(); }; },
  };
}

describe('isolated actual host → main → preload → renderer integration', () => {
  it('commits exact >5MiB database state, new session/delete, skipped revisions, reconnect and late island', async () => {
    const f = await boot(true, 3000, 700);
    const releaseBootstrap = f.pause(true);
    const restored = makeWork('restored-layout');
    useWorksStore.setState({ entries: [restored] });
    await f.connection.connect();
    await vi.waitFor(() => expect(f.calls.some(call => (call.params as { cursor?: string }).cursor !== undefined)).toBe(true));
    expect(useWorksStore.getState().ready).toBe(false);
    expect(useWorksStore.getState().entries).toEqual([restored]);
    expect(f.roots.roots(`${f.project} ${f.workId}`)).toEqual([]);
    expect(f.main.batches).toEqual([]);
    releaseBootstrap();
    await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true), { timeout: 20_000 });
    const expected = mailWorkMap(f.service.entry(f.project, f.workId)!.map, storeLetterReader(f.project, f.workId));
    expect(useWorksStore.getState().entries[0]!.map).toEqual(expected);
    expect(Buffer.byteLength(JSON.stringify(useWorksStore.getState().entries))).toBeGreaterThan(5 * 1024 * 1024);
    expect(f.service.mailSnapshot()).toBeNull();
    expect(f.calls.some(call => call.method === 'works.list')).toBe(false);
    const root = { workKey: `${f.project} ${f.workId}`, spec: { kind: 'project' as const } };
    expect(await f.roots.resolve(root, 'file.txt', 'read')).toBe(await realpath(path.join(f.project, 'file.txt')));
    let aggregateEncodes = 0;
    const stringify = JSON.stringify;
    const encode = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (typeof value === 'object' && value !== null && (Array.isArray((value as { entries?: unknown }).entries) || (value as { event?: string }).event === 'works.changed')) aggregateEncodes++;
      return (stringify as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify);
    cleanups.push(() => { encode.mockRestore(); });
    const resumeUpdate = f.pause();
    const initialRevision = f.service.sync!.currentRevision;
    const initialCalls = f.calls.length;
    await updateMap(f.project, f.workId, map => { map.sessions[0]!.task = 'skipped'; });
    await vi.waitFor(() => expect(f.service.sync!.currentRevision).toBeGreaterThan(initialRevision));
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(initialCalls));
    expect(useWorksStore.getState().entries[0]!.map.sessions[0]!.task).not.toBe('skipped');
    const skippedRevision = f.service.sync!.currentRevision;
    await updateMap(f.project, f.workId, map => { addSession(map, { provider: 'codex', label: 'new', task: 'new' }); map.sessions.splice(1, 1); });
    await vi.waitFor(() => expect(f.service.sync!.currentRevision).toBeGreaterThan(skippedRevision));
    resumeUpdate();
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]!.map.sessions[0]!.task).toBe('skipped'), { timeout: 10_000 });
    expect(useWorksStore.getState().entries[0]!.map.sessions).toHaveLength(3000);
    expect(useWorksStore.getState().entries[0]!.map.sessions.at(-1)!.label).toBe('new');
    encode.mockRestore();
    expect(aggregateEncodes).toBe(0);
    expect(useWorksStore.getState().entries[0]!.map.sessions).toEqual(f.service.entry(f.project, f.workId)!.map.sessions);
    const island = f.surface(true); const islandReducer = new WorksSyncReducer();
    cleanups.push(island.bridge.subscribe(batch => {
      const outcome = islandReducer.applyPage({ ...batch, kind: 'page', cursor: `local:${batch.index}`, next: batch.commit ? null : `local:${batch.index + 1}` });
      expect(outcome.state).not.toBe('rejected');
    }, () => {}));
    await vi.waitFor(() => expect(islandReducer.view.revision).toBe(f.binding.sync.view.revision), { timeout: 10_000 });
    const publicSessions = useWorksStore.getState().entries[0]!.map.sessions.map(session => { const copy = { ...session }; delete copy.codexThreadBinding; return copy; });
    expect(islandReducer.view.snapshot.entries[0]!.map.sessions).toEqual(publicSessions);
    expect(JSON.stringify(island.batches)).not.toContain('codexThreadBinding');
    expect(JSON.stringify(island.batches)).not.toContain('SECRET-THREAD');
    const disconnects = f.main.statuses.filter(state => state === 'disconnected').length;
    // Drop only the isolated client's socket; existing-host-only recovery is bounded and never spawns.
    (f.connection as unknown as { socket: Socket }).socket.destroy();
    await vi.waitFor(() => expect(f.main.statuses.filter(state => state === 'disconnected').length).toBeGreaterThan(disconnects));
    expect(island.statuses).toContain('disconnected');
    expect(f.binding.supported).toBe(true);
    await expect(f.binding.snapshotForLookup()).rejects.toThrow();
    await expect(f.roots.resolve(root, 'file.txt', 'read')).rejects.toThrow();
    await f.connection.connect();
    await vi.waitFor(() => expect(f.binding.sync.ready).toBe(true), { timeout: 10_000 });
    expect(useWorksStore.getState().entries[0]!.map.sessions.at(-1)!.label).toBe('new');
    expect(f.calls.some(call => call.method === 'works.list')).toBe(false);
    await deleteWorkFiles(f.project, f.workId);
    await vi.waitFor(() => expect(useWorksStore.getState().entries).toEqual([]), { timeout: 10_000 });
    await expect(f.roots.resolve(root, 'file.txt', 'read')).rejects.toThrow();
    expect(f.frames.every(bytes => bytes <= WORKS_SYNC_PAGE_BYTES)).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();
  }, 40_000);

  it('does not grant roots from a partial bootstrap and preserves legacy/remote exclusion', async () => {
    const f = await boot();
    const resume = f.pause();
    await f.connection.connect();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.roots.roots(`${f.project} ${f.workId}`)).toEqual([]);
    expect(useWorksStore.getState().ready).toBe(false);
    resume();
    await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
    const legacy = new HostConnection({ paths: { dir: f.home, socket: path.join(f.home, 'host.sock'), token: path.join(f.home, 'token'), pid: '', log: '' }, env: {}, spawn: vi.fn(), connectTimeoutMs: 1000 });
    cleanups.push(() => legacy.close());
    const legacyEvents: string[] = []; legacy.onEvent(message => legacyEvents.push(message.event));
    await legacy.connect();
    expect([...f.clients].filter(client => client.features.has(WORKS_SYNC_FEATURE))).toHaveLength(1);
    expect(await legacy.call('works.list', {})).toHaveProperty('entries');
    const remote = connectRaw(path.join(f.home, 'host.sock')); cleanups.push(() => remote.close()); await waitConnected(remote.socket);
    const response = await hello(remote, 'fixture', { client: 'remote', features: [WORKS_SYNC_FEATURE, COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE] });
    expect((response.result as { features: string[] }).features).not.toContain(WORKS_SYNC_FEATURE);
    expect([...f.clients].find(client => client.role === 'remote')!.features.has(WORKS_SYNC_FEATURE)).toBe(false);
    remote.send({ id: 100, method: 'works.sync', params: { base: 0 } });
    expect((await remote.next()).error).toBeDefined();
    const revision = f.binding.sync.view.revision;
    writeLetters(f.project, f.workId, letters => letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: 'mail-only' }));
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]!.map.compact?.unread.letters).toBeGreaterThan(0));
    expect(f.binding.sync.view.revision).toBe(revision);
    expect(legacyEvents).toContain('rooms.mail');
    expect(legacyEvents).not.toContain('works.invalidated');
    await updateMap(f.project, f.workId, map => { addSession(map, { provider: 'codex', label: 'mixed', task: 'mixed-client-edit' }); });
    await vi.waitFor(() => expect(legacyEvents).toContain('works.changed'));
    await vi.waitFor(() => expect(useWorksStore.getState().entries[0]!.map.sessions).toHaveLength(6));
    expect((await legacy.call('works.list', {}) as { entries: Array<{ map: { sessions: unknown[] } }> }).entries[0]!.map.sessions).toHaveLength(6);
  });

  it('recovers a stalled actual mail response for both bound surfaces and reconciles a fresh reset', async () => {
    const f = await boot(true, 5, 20, 30);
    const island = f.surface(true); const reducer = new WorksSyncReducer();
    cleanups.push(island.bridge.subscribe(batch => {
      expect(reducer.applyPage({ ...batch, kind: 'page', cursor: `local:${batch.index}`, next: batch.commit ? null : `local:${batch.index + 1}` }).state).not.toBe('rejected');
    }, () => {}));
    let failed = false;
    cleanups.push(useWorksStore.subscribe(state => { if (state.mailRepairFailed) failed = true; }));
    await f.connection.connect();
    await vi.waitFor(() => expect(useWorksStore.getState().ready && useWorksStore.getState().mailRepairPending === 0).toBe(true));
    f.stallMail();
    f.main.bridge.retry();
    await vi.waitFor(() => expect(f.main.statuses).toContain('disconnected'));
    expect(island.statuses).toContain('disconnected');
    expect(failed).toBe(true);
    await vi.waitFor(() => expect(useWorksStore.getState().ready && useWorksStore.getState().mailRepairPending === 0 && !useWorksStore.getState().mailRepairFailed).toBe(true));
    await vi.waitFor(() => expect(reducer.view.revision).toBe(f.binding.sync.view.revision));
    expect(useWorksStore.getState().entries[0]!.map.sessions).toEqual(f.service.entry(f.project, f.workId)!.map.sessions);
    expect(f.connection.recentCalls().filter(call => call.error === 'pending')).toEqual([]);
    expect(f.service.sync!.mailPinCount).toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('falls back to the original old-host snapshot contract without claiming sync support', async () => {
    const f = await boot(false);
    await f.connection.connect();
    expect(f.binding.supported).toBe(false);
    expect(f.calls).toEqual([]);
    expect((await f.binding.snapshotForLookup()).entries).toHaveLength(1);
    expect([...f.clients][0]!.features.has(WORKS_SYNC_FEATURE)).toBe(true);
    expect(f.binding.sync.ready).toBe(false);
    f.legacyRenderer();
    await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
    expect(useWorksStore.getState().entries).toHaveLength(1);
  });

  it('keeps old-host oversize failure visible instead of claiming a completed snapshot', async () => {
    const f = await boot(false, 3000, 700);
    await f.connection.connect();
    f.legacyRenderer();
    await vi.waitFor(() => expect(useWorksStore.getState().error?.reason).toBe('snapshot-too-large'));
    expect(useWorksStore.getState().ready).toBe(false);
    expect(useWorksStore.getState().entries).toEqual([]);
    expect(f.calls.filter(call => call.method === 'works.sync')).toEqual([]);
  });
});
