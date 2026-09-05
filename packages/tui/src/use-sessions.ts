import {
  buildAllSessions,
  claudeSource,
  codexSource,
  watchSessions,
  type SessionChange,
  type SessionIndex,
} from '@harnas/core';
import { useEffect, useState } from 'react';

export interface SessionsRoots {
  claudeRoot?: string;
  codexRoot?: string;
}

export interface SessionsState {
  sessions: SessionIndex[];
  loading: boolean;
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
 * Список сессий всех провайдеров, живущий по событиям файловых watcher'ов:
 * перерисовка происходит на изменение файла, без опроса по таймеру (specs/ui.md).
 */
export function useSessions({ claudeRoot, codexRoot }: SessionsRoots = {}): SessionsState {
  const [sessions, setSessions] = useState<SessionIndex[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    buildAllSessions({
      ...(claudeRoot === undefined ? {} : { claudeRoot }),
      ...(codexRoot === undefined ? {} : { codexRoot }),
    })
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
  }, [claudeRoot, codexRoot]);

  useEffect(() => {
    const watcher = watchSessions(
      (change) => setSessions((current) => applyChange(current, change)),
      [claudeSource(claudeRoot), codexSource(codexRoot)],
    );
    return () => watcher.close();
  }, [claudeRoot, codexRoot]);

  return { sessions, loading };
}
