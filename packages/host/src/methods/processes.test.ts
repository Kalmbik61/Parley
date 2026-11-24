import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EventName, SessionProcessesSnapshot, SessionRef } from '@parley/protocol';
import type { Client } from '../client.js';
import type { RequestInfo } from '../context.js';
import type { ProcessSnapshot } from '../pty/process-monitor.js';
import { createProcessesHandlers } from './processes.js';

const ref: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
const other: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-2' };

type Sent = { event: EventName; data: SessionProcessesSnapshot };

function fakeClient(): Client & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    id: randomUUID(), name: 'test', sent,
    send(message) { sent.push(message as unknown as Sent); return true; },
    writableLength: () => 0, close() {},
  };
}

const requestOf = (client: Client): RequestInfo => ({ client, host: {} as never });

const row = { pid: 10, name: 'sleep', elapsed: '00:01', cpuPct: 0, memPct: 0, rssKb: 100 };
const snapshotOf = (approximate = false): ProcessSnapshot => ({ processes: [row], approximate });

function setup(live: SessionRef[] = [ref, other]) {
  const listeners = new Map<string, (r: SessionRef, s: ProcessSnapshot | null) => void>();
  const unsubscribed: string[] = [];
  const exits: Array<(r: SessionRef) => void> = [];
  const monitor = {
    subscribe: vi.fn((r: SessionRef, listener: (r: SessionRef, s: ProcessSnapshot | null) => void) => {
      listeners.set(r.sessionId, listener);
      return () => { unsubscribed.push(r.sessionId); listeners.delete(r.sessionId); };
    }),
    refresh: vi.fn(async () => {
      for (const [id, listener] of listeners) listener({ ...ref, sessionId: id }, snapshotOf());
    }),
  };
  const pty = {
    get: (r: SessionRef) => (live.some((l) => l.sessionId === r.sessionId) ? ({} as never) : undefined),
    on: ((event: string, listener: (r: SessionRef) => void) => {
      if (event === 'exit') exits.push(listener);
      return () => undefined;
    }) as never,
  };
  const handlers = createProcessesHandlers({ monitor, pty });
  return { handlers, monitor, listeners, unsubscribed, exit: (r: SessionRef) => exits.forEach((f) => f(r)) };
}

describe('processes.*', () => {
  it('новый подписчик получает начальный снимок, дальше — заменяющие снимки с растущей ревизией', async () => {
    const { handlers, listeners } = setup();
    const client = fakeClient();
    const first = await handlers.processesSubscribe({ ref }, requestOf(client));
    expect(first).toMatchObject({ available: true, processes: [row] });

    listeners.get('s-1')?.(ref, snapshotOf());
    listeners.get('s-1')?.(ref, snapshotOf());
    // Опрос при подписке уже разослал начальный снимок тем же событием (та же ревизия): окно отбросит повтор.
    const revisions = client.sent.map((m) => m.data.revision);
    expect(revisions[0]).toBe(first.revision);
    expect(revisions.every((r, i) => i === 0 || r > revisions[i - 1]!)).toBe(true);
    expect(revisions.at(-1)).toBeGreaterThan(first.revision);
    expect(client.sent.every((m) => m.event === 'processes.changed')).toBe(true);
  });

  it('повторная подписка идемпотентна: одна подписка на монитор, один клиент в таблице', async () => {
    const { handlers, monitor } = setup();
    const client = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(client));
    await handlers.processesSubscribe({ ref }, requestOf(client));
    expect(monitor.subscribe).toHaveBeenCalledTimes(1);
    expect(handlers.subscriptionCount()).toBe(1);
  });

  it('несколько клиентов делят одну подписку монитора; отписка последнего снимает её', async () => {
    const { handlers, monitor, unsubscribed } = setup();
    const a = fakeClient();
    const b = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(a));
    await handlers.processesSubscribe({ ref }, requestOf(b));
    expect(monitor.subscribe).toHaveBeenCalledTimes(1);

    await handlers.processesUnsubscribe({ ref }, requestOf(a));
    expect(unsubscribed).toEqual([]);
    await handlers.processesUnsubscribe({ ref }, requestOf(b));
    expect(unsubscribed).toEqual(['s-1']);
    expect(handlers.subscriptionCount()).toBe(0);
  });

  it('отключение клиента снимает все его подписки', async () => {
    const { handlers, unsubscribed } = setup();
    const client = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(client));
    await handlers.processesSubscribe({ ref: other }, requestOf(client));
    handlers.dropClient(client);
    expect(unsubscribed.sort()).toEqual(['s-1', 's-2']);
    expect(handlers.subscriptionCount()).toBe(0);
  });

  it('снимки идут только подписчикам своей сессии', async () => {
    const { handlers, listeners } = setup();
    const a = fakeClient();
    const b = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(a));
    await handlers.processesSubscribe({ ref: other }, requestOf(b));
    a.sent.length = 0; b.sent.length = 0;
    listeners.get('s-2')?.(other, snapshotOf());
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  it('выход PTY заменяет снимок пустым недоступным', async () => {
    const { handlers, exit } = setup();
    const client = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(client));
    client.sent.length = 0;
    exit(ref);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.data).toMatchObject({ ref, available: false, processes: [] });
  });

  it('подписка на сессию без живого PTY — not_found', async () => {
    const { handlers, monitor } = setup([]);
    await expect(handlers.processesSubscribe({ ref }, requestOf(fakeClient()))).rejects.toMatchObject({ code: 'not_found' });
    expect(monitor.subscribe).not.toHaveBeenCalled();
  });

  it('сбой опроса (null) уходит клиенту как available: false', async () => {
    const { handlers, listeners } = setup();
    const client = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(client));
    client.sent.length = 0;
    listeners.get('s-1')?.(ref, null);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.data).toMatchObject({ ref, available: false, processes: [] });
  });

  it('Codex: признак approximate доходит до клиента', async () => {
    const { handlers, listeners } = setup();
    const client = fakeClient();
    await handlers.processesSubscribe({ ref }, requestOf(client));
    listeners.get('s-1')?.(ref, snapshotOf(true));
    expect(client.sent.at(-1)?.data.approximate).toBe(true);
  });
});
