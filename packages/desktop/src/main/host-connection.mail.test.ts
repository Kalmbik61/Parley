import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostPaths } from '@parley/host';
import { encodeLine, LineDecoder } from '@parley/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostConnection } from './host-connection.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  expect(check()).toBe(true);
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mail-recovery-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const paths: HostPaths = { dir, socket: path.join(dir, 'h.sock'), token: path.join(dir, 'token'), pid: path.join(dir, 'pid'), log: path.join(dir, 'log') };
  await mkdir(dir, { recursive: true }); await writeFile(paths.token, 'token');
  const sockets: Socket[] = [], received: Array<{ id: number; method: string; params: unknown; socket: Socket }> = [];
  let hello = true;
  const server: Server = createServer(socket => {
    sockets.push(socket); socket.on('error', () => {});
    const decoder = new LineDecoder();
    socket.on('data', chunk => { for (const raw of decoder.push(chunk)) {
      const message = raw as { id: number; method: string; params: unknown };
      received.push({ ...message, socket });
      if (message.method === 'hello' && hello) socket.write(encodeLine({ id: message.id, result: { pid: 123, hostVersion: 'test' } }));
    } });
  });
  await new Promise<void>(resolve => server.listen(paths.socket, resolve));
  cleanup.push(async () => { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); });
  const spawn = vi.fn(), kill = vi.fn();
  const connection = new HostConnection({ paths, env: {}, spawn, connectTimeoutMs: 1000,
    processes: { kill, isAlive: () => true, isHost: () => true, identity: () => 'host' } });
  cleanup.push(() => connection.close());
  await connection.connect();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const send = (message: (typeof received)[number], result: unknown) => message.socket.write(encodeLine({ id: message.id, result }));
  return { connection, received, sockets, spawn, kill, send, setHello: (value: boolean) => { hello = value; } };
}

describe('mail-scoped socket retirement', () => {
  it.each([false, true])('retires a stalled page (continuation=%s), rejects writes once, ignores old sockets and never replays', async continuation => {
    const f = await fixture();
    if (continuation) {
      const first = f.connection.call('works.mailState', { projectPath: '/p', workId: 'w' });
      await until(() => f.received.length === 2);
      f.send(f.received[1]!, { kind: 'mail-page', next: 'cursor' });
      await first;
      await vi.advanceTimersByTimeAsync(29_000); // Each page gets its own deadline.
    }
    const before = f.received.length;
    const mail = f.connection.call('works.mailState', { projectPath: '/p', workId: 'w', ...(continuation ? { cursor: 'cursor' } : {}) });
    const write = f.connection.call('rooms.create', { projectPath: '/p', workId: 'w', title: 'one write' });
    let rejected = 0;
    const mailResult = mail.catch(error => error);
    const writeResult = write.catch(error => { rejected++; return error; });
    await until(() => f.received.length === before + 2);
    const old = f.sockets[0]!;
    const oldClient = (f.connection as unknown as { socket: Socket }).socket;
    const states: string[] = [];
    f.connection.onStatus(status => states.push(status.state));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(rejected).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await mailResult).toBeInstanceOf(Error);
    expect(await writeResult).toBeInstanceOf(Error);
    await until(() => states.at(-1) === 'connected');
    expect(states).toContain('disconnected');
    expect(old.destroyed || old.closed).toBe(true);
    expect(rejected).toBe(1);
    expect(f.received.filter(message => message.method === 'rooms.create')).toHaveLength(1);
    expect(f.received.filter(message => message.method === 'hello')).toHaveLength(2);
    expect(f.connection.recentCalls().filter(call => call.error === 'pending')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // A callback already queued by the retired generation cannot settle a fresh id.
    const fresh = f.connection.call('works.mailState', { projectPath: '/p', workId: 'new' });
    await until(() => f.received.at(-1)?.method === 'works.mailState' && f.received.at(-1)?.socket !== old);
    const message = f.received.at(-1)!;
    oldClient.emit('data', Buffer.from(encodeLine({ id: message.id, result: 'obsolete' })));
    f.send(message, 'fresh');
    expect(await fresh).toBe('fresh');
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
    expect(f.received.some(message => message.method === 'host.shutdown')).toBe(false);
  });

  it('clears completed-page timers and resolves final-response/deadline races only once', async () => {
    const f = await fixture();
    for (const respondFirst of [true, false]) {
      const call = f.connection.call('works.mailState', {});
      const result = call.catch(error => error);
      const count = f.received.length;
      await until(() => f.received.length > count);
      const message = f.received.at(-1)!;
      await vi.advanceTimersByTimeAsync(29_999);
      if (respondFirst) { f.send(message, 'complete'); await result; }
      await vi.advanceTimersByTimeAsync(1);
      if (!respondFirst) f.send(message, 'too late');
      expect(await result).toEqual(respondFirst ? 'complete' : expect.any(Error));
    }
    await until(() => f.received.filter(message => message.method === 'hello').length === 2);
    expect(f.connection.recentCalls().filter(call => call.method === 'works.mailState')).toHaveLength(2);
  });

  it('coalesces simultaneous stalls, bounds a failed handshake and throttles Retry without spawn', async () => {
    const f = await fixture(); f.setHello(false);
    const a = f.connection.call('works.mailState', {}).catch(error => error);
    const b = f.connection.call('works.mailState', {}).catch(error => error);
    await until(() => f.received.length === 3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await a).toBeInstanceOf(Error); expect(await b).toBeInstanceOf(Error);
    await until(() => f.received.filter(message => message.method === 'hello').length === 2);
    const failed = f.connection.retryMailRecovery()!.catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await failed).toBeInstanceOf(Error);
    await until(() => f.sockets[1]!.destroyed);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.connection.recentCalls().filter(call => call.error === 'pending')).toEqual([]);
    for (let i = 0; i < 10; i++) await expect(f.connection.retryMailRecovery()).rejects.toThrow('cooling down');
    // The ordinary connection screen must not escape into the spawning connect loop either.
    await expect(f.connection.connect()).rejects.toThrow('cooling down');
    expect(f.received.filter(message => message.method === 'hello')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(29_000); f.setHello(true);
    const retry = f.connection.retryMailRecovery()!;
    expect(f.connection.retryMailRecovery()).toBe(retry);
    await retry;
    expect(f.connection.retryMailRecovery()).toBeNull();
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
    expect(f.received.some(message => message.method === 'host.shutdown')).toBe(false);
  });

  it('repeated retirement cycles leave no pending RPCs/timers and close cancels a candidate handshake', async () => {
    const f = await fixture();
    for (let cycle = 0; cycle < 3; cycle++) {
      const call = f.connection.call('works.mailState', {}).catch(error => error);
      const count = f.received.length;
      await until(() => f.received.length > count);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await call).toBeInstanceOf(Error);
      await until(() => f.connection.retryMailRecovery() === null);
      expect(f.connection.recentCalls().filter(call => call.error === 'pending')).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(f.received.filter(message => message.method === 'hello')).toHaveLength(4);
    f.setHello(false);
    const call = f.connection.call('works.mailState', {}).catch(error => error);
    const count = f.received.length;
    await until(() => f.received.length > count);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await call).toBeInstanceOf(Error);
    await until(() => f.received.filter(message => message.method === 'hello').length === 5);
    const recovery = f.connection.retryMailRecovery()!.catch(error => error);
    const candidate = (f.connection as unknown as { candidate: Socket }).candidate;
    f.connection.close();
    expect(await recovery).toBeInstanceOf(Error);
    expect(candidate.destroyed).toBe(true);
    expect(f.connection.recentCalls().filter(call => call.error === 'pending')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.received.filter(message => message.method === 'hello')).toHaveLength(5);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.kill).not.toHaveBeenCalled();
  });
});
