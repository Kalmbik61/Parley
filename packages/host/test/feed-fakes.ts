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

export interface FakeFeedDeps {
  deps: FeedServiceDeps;
  log: ReturnType<typeof silentLog>;
  /** Журнал сессии, который отдаёт «индекс логов». */
  setLogFile(file: string | null): void;
  emitActivity(ref: SessionRef, activity: string): void;
  emitExit(ref: SessionRef): void;
}

export function fakeFeedDeps(
  sessions: Array<{ ref: SessionRef; provider?: string }> = [{ ref: REF }],
): FakeFeedDeps {
  let logFile: string | null = null;
  const activityListeners = new Set<ActivityListener>();
  const exitListeners = new Set<ExitListener>();
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
            sessions: own.map((session) => ({
              id: session.ref.sessionId,
              provider: session.provider ?? 'claude',
            })),
          },
        };
      },
    },
    activity: {
      logFile: () => logFile,
      onChange: (listener: ActivityListener) => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
    },
    pty: {
      on: (event: string, listener: ExitListener) => {
        if (event !== 'exit') return () => {};
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    },
  } as unknown as FeedServiceDeps;
  return {
    deps,
    log,
    setLogFile(file) {
      logFile = file;
    },
    emitActivity(ref, activity) {
      for (const listener of activityListeners)
        listener(ref, { activity: { activity }, metrics: null });
    },
    emitExit(ref) {
      for (const listener of exitListeners) listener(ref);
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
