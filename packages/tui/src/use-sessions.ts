import { buildIndex, watchSessions, type SessionChange, type SessionIndex } from '@harnas/core';
import { useCallback, useEffect, useState } from 'react';

export interface SessionsState {
  sessions: SessionIndex[];
  loading: boolean;
  /** Принудительный ре-скан по клавише `r`. */
  rescan: () => void;
}

const byRecency = (a: SessionIndex, b: SessionIndex): number =>
  String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? ''));

/**
 * Применяет одно событие watcher к списку. Чистая функция: вся логика слияния
 * проверяется без файловой системы.
 */
export function applyChange(sessions: SessionIndex[], change: SessionChange): SessionIndex[] {
  if (change.kind === 'removed') {
    return sessions.filter((session) => session.file !== change.file);
  }

  const without = sessions.filter((session) => session.file !== change.file);
  return [...without, change.session].sort(byRecency);
}

/**
 * Список сессий, живущий по событиям файлового watcher: перерисовка происходит
 * на изменение файла, без опроса по таймеру (specs/ui.md).
 */
export function useSessions(root?: string): SessionsState {
  const [sessions, setSessions] = useState<SessionIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  const rescan = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    buildIndex(root)
      .then((index) => {
        if (!cancelled) {
          setSessions(index);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [root, generation]);

  useEffect(() => {
    const watcher = watchSessions(
      (change) => setSessions((current) => applyChange(current, change)),
      root === undefined ? {} : { root },
    );
    return () => watcher.close();
  }, [root]);

  return { sessions, loading, rescan };
}
