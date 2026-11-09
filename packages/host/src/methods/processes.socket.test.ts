/**
 * Цикл `processes.*` через настоящий сокет хоста (план shell-processes, этап D): настоящие `createHostServer`,
 * `createProcessMonitor` и обработчики, `ps` — заглушка с деревом, которое тест меняет по ходу.
 */

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { Readable } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey } from '@parley/protocol';
import type { SessionProcessesSnapshot, SessionRef } from '@parley/protocol';
import { connectRaw, hello, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { createHostContext } from '../context.js';
import { createHostServer } from '../server.js';
import { hostPaths } from '../paths.js';
import { createProcessMonitor } from '../pty/process-monitor.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { createProcessesHandlers } from './processes.js';

const ref = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w-01', sessionId });
const S1 = ref('s-1');
const S2 = ref('s-2');
const HEADER = '  PID  PPID  %CPU %MEM    RSS     ELAPSED UCOMM';

/** Дерево `ps`: корни PTY — pid 100 (s-1) и 200 (s-2); тест меняет `tree` между опросами. */
let tree: Array<[number, number, string]>;
let psCalls: number;
const INTERVAL_MS = 30;

function psStub(): typeof spawn {
  return vi.fn(() => {
    psCalls += 1;
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void };
    child.stdout = new Readable({ read() {} });
    child.kill = () => {};
    const text = [HEADER, ...tree.map(([pid, ppid, name]) => `${pid} ${ppid} 0.4 0.1 2048 00:05 ${name.padEnd(16)}`), ''].join('\n');
    queueMicrotask(() => {
      child.stdout.push(text);
      child.stdout.push(null);
      child.stdout.once('end', () => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof spawn;
}

/** Менеджер PTY: живые сессии и выход эмулируются тестом. */
function ptys() {
  const live = new Map<string, PtyHandle>();
  const exits = new Set<(r: SessionRef) => void>();
  const manager = {
    get: (r: SessionRef) => live.get(refKey(r)),
    on: (event: string, listener: (r: SessionRef) => void) => {
      if (event === 'exit') exits.add(listener);
      return () => exits.delete(listener);
    },
  } as unknown as PtyManager;
  return {
    manager,
    list: () => [...live.values()],
    start: (r: SessionRef, pid: number, provider = 'claude') => live.set(refKey(r), { ref: r, pid, provider } as PtyHandle),
    exit: (r: SessionRef) => { live.delete(refKey(r)); for (const f of exits) f(r); },
  };
}

let dir: string;
let servers: Server[] = [];
const clients: TestClient[] = [];

beforeEach(async () => {
  dir = await mkdtemp('/tmp/ps-');
  psCalls = 0;
  tree = [];
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.socket.destroy());
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

async function bootServer(withProcesses: boolean) {
  const fake = ptys();
  const monitor = createProcessMonitor({ log: { info() {}, warn() {} }, livePtys: () => fake.list(), spawn: psStub(), intervalMs: INTERVAL_MS });
  const processes = createProcessesHandlers({ monitor, pty: fake.manager });
  const handle = createHostContext({
    version: 'fixture', paths: hostPaths(dir),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    onIdleChange: vi.fn(), registerShutdownHook: vi.fn(), requestShutdown: async () => {},
  });
  const server = createHostServer({
    context: handle.context, token: 't', helloTimeoutMs: 1000,
    methodHandlers: withProcesses
      ? { 'processes.subscribe': processes.processesSubscribe as never, 'processes.unsubscribe': processes.processesUnsubscribe as never }
      : {},
    notificationHandlers: {},
    registerClient: handle.addClient,
    // Как в host.ts: ушедший клиент снимается и с подписок процессов.
    unregisterClient: (client) => { handle.removeClient(client); processes.dropClient(client); },
  });
  servers.push(server);
  const socketPath = `${dir}/sock`;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return { fake, monitor, processes, socketPath };
}

async function connect(socketPath: string): Promise<TestClient> {
  const client = connectRaw(socketPath);
  clients.push(client);
  await waitConnected(client.socket);
  expect((await hello(client, 't')).error).toBeUndefined();
  return client;
}

let nextId = 1000;
/** Запрос и ответ на него; события, пришедшие раньше, складываются в `events`. */
async function request(client: TestClient, events: SessionProcessesSnapshot[], method: string, params: unknown): Promise<RawMessage> {
  const id = nextId++;
  client.send({ id, method, params });
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
    if (message.event === 'processes.changed') events.push(message.data as SessionProcessesSnapshot);
  }
}

/** Ждёт события, удовлетворяющего условию. */
async function waitEvent(client: TestClient, events: SessionProcessesSnapshot[], match: (s: SessionProcessesSnapshot) => boolean): Promise<SessionProcessesSnapshot> {
  for (;;) {
    const found = events.find(match);
    if (found !== undefined) return found;
    const message = await client.next();
    if (message.event === 'processes.changed') events.push(message.data as SessionProcessesSnapshot);
  }
}

const names = (s: SessionProcessesSnapshot): string[] => s.processes.map((p) => p.name).sort();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('processes.* через сокет хоста', () => {
  it('подписка → снимок → изменение → выход PTY → отписка', async () => {
    const { fake, socketPath } = await bootServer(true);
    fake.start(S1, 100);
    tree = [[100, 1, '2.1.319'], [101, 100, 'zsh'], [102, 101, 'sleep']];
    const client = await connect(socketPath);
    const events: SessionProcessesSnapshot[] = [];

    const first = (await request(client, events, 'processes.subscribe', { ref: S1 })).result as SessionProcessesSnapshot;
    expect(first).toMatchObject({ available: true, approximate: false });
    expect(names(first)).toEqual(['sleep', 'zsh']);

    tree = [...tree, [103, 101, 'cat']];
    const changed = await waitEvent(client, events, (s) => s.processes.length === 3);
    expect(names(changed)).toEqual(['cat', 'sleep', 'zsh']);
    expect(changed.revision).toBeGreaterThan(first.revision);

    fake.exit(S1);
    const exited = await waitEvent(client, events, (s) => !s.available);
    expect(exited).toMatchObject({ available: false, processes: [] });
    expect(exited.revision).toBeGreaterThan(changed.revision);

    expect((await request(client, events, 'processes.unsubscribe', { ref: S1 })).result).toEqual({ ok: true });
  });

  it('снимки идут по возрастанию ревизии', async () => {
    const { fake, socketPath } = await bootServer(true);
    fake.start(S1, 100);
    tree = [[100, 1, 'x'], [101, 100, 'zsh']];
    const client = await connect(socketPath);
    const events: SessionProcessesSnapshot[] = [];
    await request(client, events, 'processes.subscribe', { ref: S1 });
    await waitEvent(client, events, () => events.length >= 4);
    const revisions = events.map((e) => e.revision);
    expect(revisions.every((r, i) => i === 0 || r > revisions[i - 1]!)).toBe(true);
  });

  it('две сессии и два клиента: каждый получает снимки только своей подписки', async () => {
    const { fake, socketPath } = await bootServer(true);
    fake.start(S1, 100);
    fake.start(S2, 200, 'codex');
    tree = [[100, 1, 'x'], [101, 100, 'zsh'], [200, 1, 'node'], [201, 200, 'sleep']];
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    const eventsA: SessionProcessesSnapshot[] = [];
    const eventsB: SessionProcessesSnapshot[] = [];

    const a1 = (await request(a, eventsA, 'processes.subscribe', { ref: S1 })).result as SessionProcessesSnapshot;
    const b2 = (await request(b, eventsB, 'processes.subscribe', { ref: S2 })).result as SessionProcessesSnapshot;
    expect(names(a1)).toEqual(['zsh']);
    expect(a1.approximate).toBe(false);
    expect(names(b2)).toEqual(['sleep']);
    expect(b2.approximate).toBe(true);

    await waitEvent(a, eventsA, (s) => refKey(s.ref) === refKey(S1) && s.revision > a1.revision);
    await waitEvent(b, eventsB, (s) => refKey(s.ref) === refKey(S2) && s.revision > b2.revision);
    expect(eventsA.every((e) => refKey(e.ref) === refKey(S1))).toBe(true);
    expect(eventsB.every((e) => refKey(e.ref) === refKey(S2))).toBe(true);

    // Второй клиент на ту же сессию делит подписку: оба получают следующий снимок.
    const eventsB1: SessionProcessesSnapshot[] = [];
    const b1 = (await request(b, eventsB1, 'processes.subscribe', { ref: S1 })).result as SessionProcessesSnapshot;
    tree = [...tree, [102, 101, 'cat']];
    await waitEvent(a, eventsA, (s) => s.processes.length === 2);
    await waitEvent(b, eventsB1, (s) => refKey(s.ref) === refKey(S1) && s.processes.length === 2);
    expect(b1.available).toBe(true);
  });

  it('обрыв клиента снимает подписку: опрос останавливается', async () => {
    const { fake, socketPath } = await bootServer(true);
    fake.start(S1, 100);
    tree = [[100, 1, 'x'], [101, 100, 'zsh']];
    const client = await connect(socketPath);
    const events: SessionProcessesSnapshot[] = [];
    await request(client, events, 'processes.subscribe', { ref: S1 });
    await waitEvent(client, events, () => events.length >= 1);

    client.socket.destroy();
    await pause(INTERVAL_MS * 3);   // сервер заметил обрыв и снял подписку
    const settled = psCalls;
    await pause(INTERVAL_MS * 6);
    expect(psCalls).toBe(settled);
  });

  it('подписка на сессию без живого PTY — not_found', async () => {
    const { socketPath } = await bootServer(true);
    const client = await connect(socketPath);
    const response = await request(client, [], 'processes.subscribe', { ref: S1 });
    expect(response.error?.code).toBe('not_found');
  });

  it('хост без монитора отвечает unknown_method и не объявляет методы в hello', async () => {
    const { socketPath } = await bootServer(false);
    const client = connectRaw(socketPath);
    clients.push(client);
    await waitConnected(client.socket);
    const helloReply = await hello(client, 't');
    expect((helloReply.result as { methods: string[] }).methods).not.toContain('processes.subscribe');
    const response = await request(client, [], 'processes.subscribe', { ref: S1 });
    expect(response.error?.code).toBe('unknown_method');
  });
});
