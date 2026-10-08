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
  type DescendantUsage,
  type MetricsRoots,
  type SessionChange,
  type SessionIndex,
  type SessionWatcher,
  type UsageSummary,
  type WorkSession,
  usageKey,
  withDescendants,
} from '@parley/core';

export interface LogIndex {
  start(): Promise<void>;
  /** Запись индекса по `providerSessionId` сессии; `undefined` — лога нет. */
  index(session: WorkSession): SessionIndex | undefined;
  /**
   * Токены разговора вместе с потомками, которых увидел индекс: подагенты Claude уже в итоге записи, а
   * порождённые треды Codex находятся по `parentId` и складываются здесь (один тред — один раз). `undefined` —
   * лога нет или он собран кодом до P36.
   */
  usage(session: WorkSession): UsageSummary | undefined;
  /** Журналы прямых субагентов треда Codex этой сессии (`parent_thread_id`); у сессии без журнала — []. */
  childLogs(session: WorkSession): Array<{ threadId: string; file: string }>;
  /** Что известно про лог сессии для страховки `activityOf`; `null` — лога нет (4.3). */
  log(session: WorkSession): ActivityLog | null;
  onChange(listener: () => void): () => void;
  stop(): void;
}

/**
 * Чьи логи читает сессия: Codex — свои, всё прочее (Claude и его надстройки вроде GLM) — Claude Code.
 * Один и тот же нативный id у двух семейств друг друга не вытесняет.
 */
const logFamily = (provider: string): 'codex' | 'claude' => (provider === 'codex' ? 'codex' : 'claude');
const logKey = (provider: string, id: string): string => `${logFamily(provider)}\u0000${id}`;

export function createLogIndex(roots: MetricsRoots = {}): LogIndex {
  let sessions: SessionIndex[] = [];
  const byId = new Map<string, SessionIndex>();
  /** Порождённые треды Codex по ключу родителя: родные признаки (`parent_thread_id`), не время и cwd. */
  const byParent = new Map<string, SessionIndex[]>();
  const listeners = new Set<() => void>();
  let watcher: SessionWatcher | undefined;
  let stopped = false;
  // Прерывает построение списка на остановке: чтение истории в гигабайты держало бы процесс хоста
  // живым и после «хост остановлен» — минутами, пока не дочитает (2026-10-06).
  const building = new AbortController();

  const rebuild = (): void => {
    byId.clear();
    byParent.clear();
    for (const session of sessions) {
      byId.set(logKey(session.provider, session.id), session);
      if (session.provider === 'codex' && session.parentId !== undefined) {
        const key = logKey('codex', session.parentId);
        byParent.set(key, [...(byParent.get(key) ?? []), session]);
      }
    }
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
    session.providerSessionId === null
      ? undefined
      : byId.get(logKey(session.provider, session.providerSessionId));

  /** Все порождённые треды Codex под корнем (дети, внуки…); цикл в данных их не зациклит. */
  const descendantsOf = (root: SessionIndex): DescendantUsage[] => {
    const seen = new Set([logKey('codex', root.id)]);
    const found: DescendantUsage[] = [];
    const queue = [root];
    for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
      for (const child of byParent.get(logKey('codex', parent.id)) ?? []) {
        const key = logKey('codex', child.id);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push(child);
        if (child.usage === undefined) continue;
        found.push({
          key: usageKey('codex', child.id, child.startedAt),
          usage: child.usage,
          // Форк унаследовал чужую историю: что в его итоге своё, не доказать.
          ...(child.forkedFrom === undefined ? {} : { overlapUnresolved: true }),
        });
      }
    }
    return found;
  };

  return {
    childLogs(session) {
      if (session.provider !== 'codex') return [];
      const root = indexOf(session);
      if (root === undefined) return [];
      return (byParent.get(logKey('codex', root.id)) ?? []).map((child) => ({ threadId: child.id, file: child.file }));
    },
    async start() {
      // Полный список могут читать гигабайты истории (`~/.claude/projects`) —
      // вызывающий (`ActivityService`) не ждёт эту функцию, чтобы не задерживать
      // старт хоста; `stopped` здесь ловит остановку, случившуюся, пока список
      // ещё строился: `stop()` прерывает чтение, и прерванное построение — не сбой.
      let built: SessionIndex[];
      try {
        built = await buildAllSessions({ ...roots, signal: building.signal });
      } catch (error) {
        if (stopped) return;
        throw error;
      }
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
    usage(session) {
      const found = indexOf(session);
      if (found?.usage === undefined) return undefined;
      return found.provider === 'codex' ? withDescendants(found.usage, descendantsOf(found)) : found.usage;
    },
    log(session) {
      const found = indexOf(session);
      return found === undefined
        ? null
        : // Не `endedAt`: итоги хуков и длительность хода Claude Code пишет уже после `Stop`, и по ним
          // закончившая ход сессия числилась бы `working` ещё порог тишины — письма ей всё это время ждали бы.
          { lastRecordAt: found.lastWorkRecordAt, lastUserRecordAt: found.lastUserRecordAt };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      building.abort();
      watcher?.close();
      listeners.clear();
    },
  };
}
