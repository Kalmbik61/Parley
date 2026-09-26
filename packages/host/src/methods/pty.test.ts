import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { refKey } from '@harnas/protocol';
import type { EventName, ResponseMessage, SessionRef } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { Client } from '../client.js';
import type { HostContext, RequestInfo } from '../context.js';
import { HostError } from '../errors.js';
import type { ExitInfo } from '../pty/pty-process.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import { createPtyHandlers } from './pty.js';

type EventMessage = { event: EventName; data: unknown };

/** Клиент-заглушка: помнит все отправленные сообщения, `sendResult` решает, что вернуть. */
function fakeClient(sendResult: (message: ResponseMessage | EventMessage) => boolean = () => true): Client & {
  sent: Array<ResponseMessage | EventMessage>;
} {
  const sent: Array<ResponseMessage | EventMessage> = [];
  return {
    id: randomUUID(),
    name: 'test',
    sent,
    send(message) {
      sent.push(message);
      return sendResult(message);
    },
    writableLength: () => 0,
    close() {},
  };
}

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: () => {},
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

function requestOf(client: Client): RequestInfo {
  return { client, host: fakeHost() };
}

/** `PtyManager`-заглушка: живые сессии и подписки эмулируются вручную из теста. */
function fakePtyManager() {
  const live = new Set<string>();
  const outputListeners = new Set<(ref: SessionRef, data: string) => void>();
  const exitListeners = new Set<(ref: SessionRef, exit: ExitInfo) => void>();
  const snapshotResult = { snapshot: 'SNAPSHOT', cols: 80, rows: 24 };

  const manager: PtyManager = {
    start: (): PtyHandle => {
      throw new Error('в этом наборе тестов не используется');
    },
    get: (ref) =>
      live.has(refKey(ref)) ? { ref, pid: 1, cols: 80, rows: 24, hasDraft: () => false } : undefined,
    list: () => [],
    write: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    snapshot: () => snapshotResult,
    stop: async () => ({ exitCode: 0, signal: null }),
    on(event: 'output' | 'exit' | 'draft', listener: never): () => void {
      if (event === 'output') {
        outputListeners.add(listener);
        return () => outputListeners.delete(listener);
      }
      if (event === 'exit') {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      }
      return () => {};
    },
  };

  return {
    manager,
    snapshotResult,
    markLive: (ref: SessionRef) => live.add(refKey(ref)),
    emitOutput: (ref: SessionRef, data: string) => {
      for (const listener of outputListeners) listener(ref, data);
    },
    emitExit: (ref: SessionRef, exit: ExitInfo) => {
      for (const listener of exitListeners) listener(ref, exit);
    },
  };
}

function fakeActivity(): ActivityService & { markSeen: ReturnType<typeof vi.fn> } {
  return {
    start: async () => {},
    get: () => undefined,
    markSeen: vi.fn(),
    onChange: () => () => {},
    stop: async () => {},
  };
}

const ref = (id = 's-01'): SessionRef => ({ projectPath: '/tmp/project', workId: 'w-01', sessionId: id });

const outputEvents = (client: { sent: Array<ResponseMessage | EventMessage> }): EventMessage[] =>
  client.sent.filter((m): m is EventMessage => 'event' in m && m.event === 'pty.output');

const resyncEvents = (client: { sent: Array<ResponseMessage | EventMessage> }): EventMessage[] =>
  client.sent.filter((m): m is EventMessage => 'event' in m && m.event === 'pty.resync');

describe('createPtyHandlers', () => {
  it('pty.attach на несуществующую сессию — not_found', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ pty: pty.manager, activity: fakeActivity() });
    const client = fakeClient();

    await expect(handlers.ptyAttach({ ref: ref() }, requestOf(client))).rejects.toBeInstanceOf(HostError);
  });

  it('pty.attach отдаёт снимок и помечает активность увиденной', async () => {
    const pty = fakePtyManager();
    const activity = fakeActivity();
    const handlers = createPtyHandlers({ pty: pty.manager, activity });
    const sessionRef = ref();
    pty.markLive(sessionRef);
    const client = fakeClient();

    const result = await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));

    expect(result).toEqual(pty.snapshotResult);
    expect(activity.markSeen).toHaveBeenCalledWith(sessionRef);
  });

  it('поток идёт только клиенту, подключённому этой сессии — второй клиент без attach его не получает', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ pty: pty.manager, activity: fakeActivity() });
    const sessionRef = ref();
    pty.markLive(sessionRef);

    const attached = fakeClient();
    const bystander = fakeClient();
    await handlers.ptyAttach({ ref: sessionRef }, requestOf(attached));

    pty.emitOutput(sessionRef, 'echo: hello');

    expect(outputEvents(attached)).toHaveLength(1);
    expect(outputEvents(attached)[0]?.data).toEqual({ ref: sessionRef, data: 'echo: hello' });
    expect(outputEvents(bystander)).toHaveLength(0);
  });

  it('pty.detach снимает подписку: после него клиент вывод не получает', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ pty: pty.manager, activity: fakeActivity() });
    const sessionRef = ref();
    pty.markLive(sessionRef);
    const client = fakeClient();

    await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
    await handlers.ptyDetach({ ref: sessionRef }, requestOf(client));
    pty.emitOutput(sessionRef, 'после detach');

    expect(outputEvents(client)).toHaveLength(0);
  });

  it('backpressure: send()===false останавливает поток и шлёт pty.resync до нового attach', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ pty: pty.manager, activity: fakeActivity() });
    const sessionRef = ref();
    pty.markLive(sessionRef);

    let deliverable = false;
    const client = fakeClient(() => deliverable);

    await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
    pty.emitOutput(sessionRef, 'кусок который не помещается');

    expect(outputEvents(client)).toHaveLength(1);
    expect(resyncEvents(client)).toHaveLength(1);

    // Поток остановлен: следующий кусок клиенту не уходит вовсе.
    pty.emitOutput(sessionRef, 'этот уже не придёт');
    expect(outputEvents(client)).toHaveLength(1);

    // Новый pty.attach восстанавливает подписку.
    deliverable = true;
    await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
    pty.emitOutput(sessionRef, 'снова течёт');
    expect(outputEvents(client)).toHaveLength(2);
  });

  it('выход процесса убирает подписчиков сессии', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ pty: pty.manager, activity: fakeActivity() });
    const sessionRef = ref();
    pty.markLive(sessionRef);
    const client = fakeClient();

    await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
    pty.emitExit(sessionRef, { exitCode: 0, signal: null });
    pty.emitOutput(sessionRef, 'после выхода процесса подписки уже нет');

    expect(outputEvents(client)).toHaveLength(0);
  });

  it('pty.input: идёт в manager.input и помечает активность увиденной', () => {
    const pty = fakePtyManager();
    const activity = fakeActivity();
    const handlers = createPtyHandlers({ pty: pty.manager, activity });
    const sessionRef = ref();

    handlers.ptyInput({ ref: sessionRef, data: 'hello\r' }, requestOf(fakeClient()));

    expect(pty.manager.input).toHaveBeenCalledWith(sessionRef, 'hello\r');
    expect(activity.markSeen).toHaveBeenCalledWith(sessionRef);
  });

  it('pty.resize: идёт в manager.resize с новыми размерами', () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ pty: pty.manager, activity: fakeActivity() });
    const sessionRef = ref();

    handlers.ptyResize({ ref: sessionRef, cols: 100, rows: 30 }, requestOf(fakeClient()));

    expect(pty.manager.resize).toHaveBeenCalledWith(sessionRef, 100, 30);
  });
});
