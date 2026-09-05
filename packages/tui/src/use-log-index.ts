/**
 * Индекс логов провайдера, разложенный по сессиям карты: заголовки, метрики и
 * страховка `activity` (дизайн TUI v2, 4.3 и 5.1).
 *
 * Своих файлов не читает: список сессий уже живёт в `use-sessions.ts`.
 */

import type { ActivityLog, SessionIndex, WorkSession } from '@harnas/core';
import { useCallback, useMemo } from 'react';

export interface LogIndexState {
  /** Запись индекса по `providerSessionId` сессии; `undefined` — лога нет. */
  index: (session: WorkSession) => SessionIndex | undefined;
  /** Что страховка знает про лог сессии; `null` — лога нет (4.3). */
  log: (session: WorkSession) => ActivityLog | null;
}

export function useLogIndex(sessions: readonly SessionIndex[]): LogIndexState {
  const byProviderId = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions]);

  const index = useCallback(
    (session: WorkSession): SessionIndex | undefined =>
      session.providerSessionId === null ? undefined : byProviderId.get(session.providerSessionId),
    [byProviderId],
  );

  const log = useCallback(
    (session: WorkSession): ActivityLog | null => {
      const found = index(session);
      return found === undefined
        ? null
        : { lastRecordAt: found.endedAt, lastUserRecordAt: found.lastUserRecordAt };
    },
    [index],
  );

  return { index, log };
}
