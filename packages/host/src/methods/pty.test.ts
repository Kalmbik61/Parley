import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refKey } from '@harnas/protocol';
import type { WorkEntry } from '@harnas/core';
import type { EventName, ResponseMessage, SessionRef } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { Client } from '../client.js';
import type { HostContext, RequestInfo } from '../context.js';
import { HostError } from '../errors.js';
import type { ExitInfo } from '../pty/pty-process.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import type { WakeService } from '../wake/wake-service.js';
import type { WorksService } from '../works/works-service.js';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
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
  const startListeners = new Set<(ref: SessionRef) => void>();
  const snapshotResult = { snapshot: 'SNAPSHOT', cols: 80, rows: 24 };

  const manager: PtyManager = {
    start: (): PtyHandle => {
      throw new Error('в этом наборе тестов не используется');
    },
    get: (ref) =>
      live.has(refKey(ref))
        ? { ref, pid: 1, cols: 80, rows: 24, hasDraft: () => false, bracketedPaste: () => false }
        : undefined,
    list: () => [],
    write: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    snapshot: () => snapshotResult,
    stop: async () => ({ exitCode: 0, signal: null }),
    setHostDraft: vi.fn(),
    on(event: 'output' | 'exit' | 'start' | 'draft' | 'host-draft', listener: never): () => void {
      if (event === 'output') {
        outputListeners.add(listener);
        return () => outputListeners.delete(listener);
      }
      if (event === 'exit') {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      }
      if (event === 'start') {
        startListeners.add(listener);
        return () => startListeners.delete(listener);
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
      live.delete(refKey(ref));
      for (const listener of exitListeners) listener(ref, exit);
    },
    /** Новый процесс на ref — как `sessions.resume`: сессия снова жива, слушатели `start` узнают. */
    emitStart: (ref: SessionRef) => {
      live.add(refKey(ref));
      for (const listener of startListeners) listener(ref);
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

/**
 * `WorksService`-заглушка: `entry` знает только работу w-01 проекта /tmp/project
 * с сессиями `sessions` — снимок работ хоста для проверки `activity.seen`.
 */
function fakeWorks(sessions: string[] = ['s-01']): WorksService {
  const entry = {
    projectPath: '/tmp/project',
    map: { work: { id: 'w-01' }, sessions: sessions.map((id) => ({ id })) },
  } as unknown as WorkEntry;
  return {
    entry: (projectPath: string, workId: string) =>
      projectPath === entry.projectPath && workId === 'w-01' ? entry : undefined,
  } as unknown as WorksService;
}

/** Будильник-заглушка: pty.send спрашивает только «указатель в полёте» и паузу Enter. */
function fakeWake(): Pick<WakeService, 'inFlight' | 'enterDelayMs'> {
  return { inFlight: () => false, enterDelayMs: 500 };
}

const ref = (id = 's-01'): SessionRef => ({ projectPath: '/tmp/project', workId: 'w-01', sessionId: id });

const outputEvents = (client: { sent: Array<ResponseMessage | EventMessage> }): EventMessage[] =>
  client.sent.filter((m): m is EventMessage => 'event' in m && m.event === 'pty.output');

const resyncEvents = (client: { sent: Array<ResponseMessage | EventMessage> }): EventMessage[] =>
  client.sent.filter((m): m is EventMessage => 'event' in m && m.event === 'pty.resync');

describe('createPtyHandlers', () => {
  it('pty.attach на несуществующую сессию — not_found', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
    const client = fakeClient();

    await expect(handlers.ptyAttach({ ref: ref() }, requestOf(client))).rejects.toBeInstanceOf(HostError);
  });

  // Кусок 4.1 (спека 3.2): подключение — не просмотр. Невидимая, но подключённая
  // вкладка и окно не в фокусе больше не гасят «не просмотрено».
  it('pty.attach отдаёт снимок и «не просмотрено» не гасит', async () => {
    const pty = fakePtyManager();
    const activity = fakeActivity();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity, works: fakeWorks() });
    const sessionRef = ref();
    pty.markLive(sessionRef);
    const client = fakeClient();

    const result = await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));

    expect(result).toEqual(pty.snapshotResult);
    expect(activity.markSeen).not.toHaveBeenCalled();
  });

  it('activity.seen зовёт markSeen ровно этой сессии', () => {
    const pty = fakePtyManager();
    const activity = fakeActivity();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity, works: fakeWorks(['s-01', 's-02']) });

    handlers.activitySeen({ ref: ref('s-02') }, requestOf(fakeClient()));

    expect(activity.markSeen).toHaveBeenCalledTimes(1);
    expect(activity.markSeen).toHaveBeenCalledWith(ref('s-02'));
  });

  it('activity.seen неизвестной сессии или работы — тихо, без markSeen и без исключения', () => {
    const pty = fakePtyManager();
    const activity = fakeActivity();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity, works: fakeWorks() });
    const client = fakeClient();

    expect(() => handlers.activitySeen({ ref: ref('s-09') }, requestOf(client))).not.toThrow();
    expect(() =>
      handlers.activitySeen({ ref: { ...ref(), workId: 'w-99' } }, requestOf(client)),
    ).not.toThrow();
    expect(activity.markSeen).not.toHaveBeenCalled();
    // Уведомление без ответа: клиенту ничего не ушло.
    expect(client.sent).toEqual([]);
  });

  it('поток идёт только клиенту, подключённому этой сессии — второй клиент без attach его не получает', async () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
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
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
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
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
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
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
    const sessionRef = ref();
    pty.markLive(sessionRef);
    const client = fakeClient();

    await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
    pty.emitExit(sessionRef, { exitCode: 0, signal: null });
    pty.emitOutput(sessionRef, 'после выхода процесса подписки уже нет');

    expect(outputEvents(client)).toHaveLength(0);
  });

  // Раунд fix-host-resync (review-5.4-B, Critical): после sessions.resume открытая вкладка
  // молчала — подписчики ref пропадали на exit, и о новом процессе окно не узнавало.
  describe('оживление сессии: новый PTY на тот же ref', () => {
    it('attach → exit → start: клиент получает pty.resync, повторный attach даёт снимок и поток нового процесса', async () => {
      const pty = fakePtyManager();
      const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
      const sessionRef = ref();
      pty.markLive(sessionRef);
      const client = fakeClient();

      await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
      pty.emitExit(sessionRef, { exitCode: 0, signal: null });
      expect(resyncEvents(client)).toHaveLength(0);

      pty.snapshotResult.snapshot = 'NEW PROCESS';
      pty.emitStart(sessionRef);

      expect(resyncEvents(client)).toHaveLength(1);
      expect(resyncEvents(client)[0]?.data).toEqual({ ref: sessionRef });

      const result = await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
      expect(result.snapshot).toBe('NEW PROCESS');
      pty.emitOutput(sessionRef, 'вывод нового процесса');
      expect(outputEvents(client).map((m) => m.data)).toEqual([{ ref: sessionRef, data: 'вывод нового процесса' }]);
    });

    it('после resync клиент из ожидания снят: следующий перезапуск без его attach второй resync не шлёт', async () => {
      const pty = fakePtyManager();
      const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
      const sessionRef = ref();
      pty.markLive(sessionRef);
      const client = fakeClient();

      await handlers.ptyAttach({ ref: sessionRef }, requestOf(client));
      pty.emitExit(sessionRef, { exitCode: 0, signal: null });
      pty.emitStart(sessionRef);
      pty.emitExit(sessionRef, { exitCode: 0, signal: null });
      pty.emitStart(sessionRef);

      expect(resyncEvents(client)).toHaveLength(1);
    });

    it('pty.detach до оживления снимает клиента и из ожидания: resync ему не приходит', async () => {
      const pty = fakePtyManager();
      const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
      const sessionRef = ref();
      pty.markLive(sessionRef);
      const stays = fakeClient();
      const leaves = fakeClient();

      await handlers.ptyAttach({ ref: sessionRef }, requestOf(stays));
      await handlers.ptyAttach({ ref: sessionRef }, requestOf(leaves));
      pty.emitExit(sessionRef, { exitCode: 0, signal: null });
      await handlers.ptyDetach({ ref: sessionRef }, requestOf(leaves));
      pty.emitStart(sessionRef);

      expect(resyncEvents(stays)).toHaveLength(1);
      expect(resyncEvents(leaves)).toHaveLength(0);
    });

    it('другой ref не затронут: его подписчик resync не получает и поток его сессии идёт дальше', async () => {
      const pty = fakePtyManager();
      const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks(['s-01', 's-02']) });
      const revived = ref('s-01');
      const other = ref('s-02');
      pty.markLive(revived);
      pty.markLive(other);
      const onRevived = fakeClient();
      const onOther = fakeClient();

      await handlers.ptyAttach({ ref: revived }, requestOf(onRevived));
      await handlers.ptyAttach({ ref: other }, requestOf(onOther));
      pty.emitExit(revived, { exitCode: 0, signal: null });
      pty.emitStart(revived);
      pty.emitOutput(other, 'соседняя сессия');

      expect(resyncEvents(onRevived)).toHaveLength(1);
      expect(resyncEvents(onOther)).toHaveLength(0);
      expect(outputEvents(onOther)).toHaveLength(1);
      expect(outputEvents(onRevived)).toHaveLength(0);
    });

    it('start ref, на котором никто не ждёт, — ничего никому не шлёт', async () => {
      const pty = fakePtyManager();
      const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
      const sessionRef = ref();
      pty.markLive(sessionRef);
      const attachedLive = fakeClient();
      await handlers.ptyAttach({ ref: sessionRef }, requestOf(attachedLive));

      // Первый старт ref (sessions.create) при живом подписчике — не оживление: resync не нужен.
      pty.emitStart(ref('s-07'));

      expect(resyncEvents(attachedLive)).toHaveLength(0);
    });
  });

  it('pty.input: идёт в manager.input и помечает активность увиденной', () => {
    const pty = fakePtyManager();
    const activity = fakeActivity();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity, works: fakeWorks() });
    const sessionRef = ref();

    handlers.ptyInput({ ref: sessionRef, data: 'hello\r' }, requestOf(fakeClient()));

    expect(pty.manager.input).toHaveBeenCalledWith(sessionRef, 'hello\r');
    expect(activity.markSeen).toHaveBeenCalledWith(sessionRef);
  });

  it('pty.resize: идёт в manager.resize с новыми размерами', () => {
    const pty = fakePtyManager();
    const handlers = createPtyHandlers({ wake: fakeWake(), pty: pty.manager, activity: fakeActivity(), works: fakeWorks() });
    const sessionRef = ref();

    handlers.ptyResize({ ref: sessionRef, cols: 100, rows: 30 }, requestOf(fakeClient()));

    expect(pty.manager.resize).toHaveBeenCalledWith(sessionRef, 100, 30);
  });
});

describe('pty.send через сервер хоста (кусок 5.1)', () => {
  let hosts: RunningHost[] = [];
  let homes: string[] = [];

  afterEach(async () => {
    await Promise.all(hosts.map((h) => h.context.shutdown('test-cleanup').catch(() => {})));
    hosts = [];
    await Promise.all(homes.map((home) => removeHome(home)));
    homes = [];
  });

  async function connected(): Promise<TestClient> {
    const home = await tempHome();
    homes.push(home);
    hosts.push(await startHost({ home }));
    const token = await readFile(hostPaths(home).token, 'utf8');
    const client = connectRaw(hostPaths(home).socket);
    await waitConnected(client.socket);
    await hello(client, token);
    return client;
  }

  async function reply(client: TestClient, id: number): Promise<RawMessage> {
    for (;;) {
      const message = await client.next();
      if (message.id === id) return message;
    }
  }

  it('сессия без PTY — not_found; пустой text отвергает схема', async () => {
    const client = await connected();
    client.send({ id: 1, method: 'pty.send', params: { ref: ref(), text: 'hi', submit: true } });
    expect((await reply(client, 1)).error?.code).toBe('not_found');

    client.send({ id: 2, method: 'pty.send', params: { ref: ref(), text: '', submit: true } });
    expect((await reply(client, 2)).error?.code).toBe('bad_request');
    client.close();
  });
});
