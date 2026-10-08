/**
 * Заглушки для тестов ленты: работы с одной сессией, активность и PTY с ручными событиями, клиент,
 * который помнит отправленное, и запрос хука без HTTP.
 */

import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { EventName, ResponseMessage, SessionRef } from '@parley/protocol';
import type { Client } from '../src/client.js';
import type { FeedServiceDeps } from '../src/feed/feed-service.js';
import type { HookRequest } from '../src/hooks/hook-server.js';
import type { HookResponse } from '../src/hooks/decisions.js';
import type { Log } from '../src/log.js';

export const REF: SessionRef = { projectPath: '/proj', workId: 'w-1', sessionId: 's-01' };

export const silentLog = (): Log & { warn: ReturnType<typeof vi.fn> } => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

type ActivityListener = (
  ref: SessionRef,
  value: { activity: { activity: string }; metrics: null },
) => void;
type ExitListener = (ref: SessionRef) => void;
type FakeSession = { ref: SessionRef; provider?: string };
type WorksListener = (snapshot: unknown, previous: unknown) => void;

export interface FakeFeedDeps {
  deps: FeedServiceDeps;
  log: ReturnType<typeof silentLog>;
  /** Журнал сессии, который отдаёт «индекс логов». */
  setLogFile(file: string | null): void;
  /** Журнал субагента Codex по id его треда (`activity.childLogFile`); `null` — убрать. */
  setChildLogFile(threadId: string, file: string | null): void;
  emitActivity(ref: SessionRef, activity: string): void;
  emitExit(ref: SessionRef): void;
  /** Процесс сессии запущен (`pty.on('start')`): запуск или возобновление. */
  emitStart(ref: SessionRef): void;
  /** Индекс логов сообщил об изменении журнала (`activity.onLogChange`). */
  emitLog(): void;
  /** Меняет сессии в работах и шлёт `works.onChange` со снимком по ним. */
  setSessions(next: FakeSession[]): void;
  /** Всё, что служба напечатала в терминал сессии (`pty.write`). */
  writes: string[];
  /** Строки экрана терминала, которые отдаёт `pty.screenText`. */
  setScreen(lines: string[]): void;
  /** Процесс сессии: `null` — не запущен; `draft` — человек набирает в терминале. */
  setProcess(process: { pid: number; draft?: boolean } | null): void;
}

type FakeEntry = { projectPath: string; map: { work: { id: string }; sessions: unknown[] } };

/** Снимок работ по списку сессий: записи по проекту и работе. */
function worksSnapshotOf(sessions: FakeSession[]): { entries: FakeEntry[] } {
  const entries = new Map<string, FakeEntry>();
  for (const session of sessions) {
    const key = `${session.ref.projectPath}\u0000${session.ref.workId}`;
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = {
        projectPath: session.ref.projectPath,
        map: { work: { id: session.ref.workId }, sessions: [] },
      };
      entries.set(key, entry);
    }
    entry.map.sessions.push({ id: session.ref.sessionId, provider: session.provider ?? 'claude' });
  }
  return { entries: Array.from(entries.values()) };
}

export function fakeFeedDeps(initial: FakeSession[] = [{ ref: REF }]): FakeFeedDeps {
  let sessions = initial;
  let logFile: string | null = null;
  const childLogFiles = new Map<string, string>();
  const activityListeners = new Set<ActivityListener>();
  const logListeners = new Set<() => void>();
  const exitListeners = new Set<ExitListener>();
  const startListeners = new Set<ExitListener>();
  const worksListeners = new Set<WorksListener>();
  const writes: string[] = [];
  let screen: string[] = [];
  let process: { pid: number; draft?: boolean } | null = { pid: 1 };
  const log = silentLog();
  const deps = {
    host: { log },
    works: {
      entry: (projectPath: string, workId: string) => {
        const own = sessions.filter(
          (session) => session.ref.projectPath === projectPath && session.ref.workId === workId,
        );
        if (own.length === 0) return undefined;
        return {
          projectPath,
          map: {
            work: { id: workId },
            sessions: own.map((session) => ({
              id: session.ref.sessionId,
              provider: session.provider ?? 'claude',
            })),
          },
        };
      },
      onChange: (listener: WorksListener) => {
        worksListeners.add(listener);
        return () => worksListeners.delete(listener);
      },
    },
    activity: {
      logFile: () => logFile,
      childLogFile: (_ref: SessionRef, threadId: string) => childLogFiles.get(threadId) ?? null,
      questionHeld: vi.fn(),
      onChange: (listener: ActivityListener) => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
      onLogChange: (listener: () => void) => {
        logListeners.add(listener);
        return () => logListeners.delete(listener);
      },
    },
    pty: {
      get: () =>
        process === null ? undefined : { pid: process.pid, hasDraft: () => process?.draft === true },
      write: (_ref: SessionRef, data: string) => {
        writes.push(data);
      },
      screenText: () => (process === null ? undefined : screen),
      on: (event: string, listener: ExitListener) => {
        const listeners =
          event === 'exit' ? exitListeners : event === 'start' ? startListeners : null;
        if (listeners === null) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as FeedServiceDeps;
  return {
    deps,
    log,
    setLogFile(file) {
      logFile = file;
    },
    setChildLogFile(threadId, file) {
      if (file === null) childLogFiles.delete(threadId);
      else childLogFiles.set(threadId, file);
    },
    emitActivity(ref, activity) {
      for (const listener of activityListeners)
        listener(ref, { activity: { activity }, metrics: null });
    },
    emitExit(ref) {
      for (const listener of exitListeners) listener(ref);
    },
    writes,
    setScreen(lines) {
      screen = lines;
    },
    setProcess(next) {
      process = next;
    },
    emitStart(ref) {
      for (const listener of startListeners) listener(ref);
    },
    emitLog() {
      for (const listener of logListeners) listener();
    },
    setSessions(next) {
      const previous = worksSnapshotOf(sessions);
      sessions = next;
      const snapshot = worksSnapshotOf(sessions);
      for (const listener of worksListeners) listener(snapshot, previous);
    },
  };
}

type EventMessage = { event: EventName; data: unknown };

export function fakeClient(sendResult: () => boolean = () => true): Client & {
  sent: Array<ResponseMessage | EventMessage>;
} {
  const sent: Array<ResponseMessage | EventMessage> = [];
  return {
    id: randomUUID(),
    name: 'test',
    sent,
    send(message) {
      sent.push(message);
      return sendResult();
    },
    writableLength: () => 0,
    close() {},
  };
}

/** Запрос хука без HTTP: ответы копятся в `responses`, `abandon()` — CLI закрыл запрос. */
export function hookRequest(
  body: Record<string, unknown>,
  ref: SessionRef = REF,
): HookRequest & { responses: HookResponse[]; abandon(): void } {
  const responses: HookResponse[] = [];
  let answered = false;
  let onAbandon: (() => void) | null = null;
  return {
    ref,
    body,
    responses,
    respond(json) {
      if (answered) return;
      answered = true;
      responses.push(json);
    },
    onAbandon(listener) {
      onAbandon = listener;
    },
    abandon() {
      if (answered) return;
      answered = true;
      onAbandon?.();
    },
  };
}
