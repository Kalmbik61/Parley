/**
 * Индекс логов провайдера по id сессии у провайдера: перенос `use-log-index.ts` и
 * `use-sessions.ts` TUI без React (дизайн TUI v2, 4.3 и 5.1). Живёт по событиям
 * `watchSessions` — без опроса.
 *
 * Своей файловой логики не заводит: список сессий строит и обновляет core
 * (`buildAllSessions`, `watchSessions`), здесь только разложение по id и подписка.
 */

import {
  buildAllSessions,
  claudeSource,
  codexSource,
  watchSessions,
  type ActivityLog,
  type MetricsRoots,
  type SessionChange,
  type SessionIndex,
  type SessionWatcher,
  type WorkSession,
} from '@parley/core';

export interface LogIndex {
  start(): Promise<void>;
  /** Запись индекса по `providerSessionId` сессии; `undefined` — лога нет. */
  index(session: WorkSession): SessionIndex | undefined;
  /** Что известно про лог сессии для страховки `activityOf`; `null` — лога нет (4.3). */
  log(session: WorkSession): ActivityLog | null;
  onChange(listener: () => void): () => void;
  stop(): void;
}

export function createLogIndex(roots: MetricsRoots = {}): LogIndex {
  let sessions: SessionIndex[] = [];
  const byId = new Map<string, SessionIndex>();
  const listeners = new Set<() => void>();
  let watcher: SessionWatcher | undefined;
  let stopped = false;

  const rebuild = (): void => {
    byId.clear();
    for (const session of sessions) byId.set(session.id, session);
  };

  /** Та же склейка, что и `applyChange` в `use-sessions.ts`: по файлу, свежие первыми. */
  const applyChange = (change: SessionChange): void => {
    sessions =
      change.kind === 'removed'
        ? sessions.filter((session) => session.file !== change.file)
        : [...sessions.filter((session) => session.file !== change.file), change.session];
    rebuild();
    for (const listener of listeners) listener();
  };

  const indexOf = (session: WorkSession): SessionIndex | undefined =>
    session.providerSessionId === null ? undefined : byId.get(session.providerSessionId);

  return {
    async start() {
      // Полный список могут читать гигабайты истории (`~/.claude/projects`) —
      // вызывающий (`ActivityService`) не ждёт эту функцию, чтобы не задерживать
      // старт хоста; `stopped` здесь ловит остановку, случившуюся, пока список
      // ещё строился.
      const built = await buildAllSessions(roots);
      if (stopped) return;
      sessions = built;
      rebuild();
      // Тех, кто уже подписался (`ActivityService.handleLogChange`), нужно
      // толкнуть и на сам первый список: иначе сессия, чей лог был на диске
      // ещё до старта хоста, ждала бы первой ЖИВОЙ записи, которой может не
      // случиться (план, кусок 1.5 — автозаголовок и привязка «на изменениях
      // логов»).
      for (const listener of listeners) listener();
      watcher = watchSessions(
        applyChange,
        [claudeSource(roots.claudeRoot), codexSource(roots.codexRoot)],
        // Сбой ре-парса одного файла не должен ронять хост — следующее событие
        // попробует снова, как и у остальных наблюдателей хоста.
        { onError: () => {} },
      );
    },
    index: indexOf,
    log(session) {
      const found = indexOf(session);
      return found === undefined
        ? null
        : { lastRecordAt: found.endedAt, lastUserRecordAt: found.lastUserRecordAt };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      watcher?.close();
      listeners.clear();
    },
  };
}
