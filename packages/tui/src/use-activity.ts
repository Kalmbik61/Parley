/**
 * Живое состояние сессий: журналы хуков работы плюс страховка по логу провайдера
 * (дизайн TUI v2, 4.2 и 4.3). Свёртку делает core (`activityOf`), здесь только
 * подписка, память о просмотренных сессиях и точка работы.
 *
 * Таймера нет: состояние пересчитывается на событие watcher и на перерисовку.
 */

import {
  activityOf,
  openEvents,
  watchEvents,
  workPaths,
  type ActivityLog,
  type EventRecord,
  type SessionActivity,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dotState, maxDotState, type DotState } from './components/activity-dot.js';
import { workKey } from './work-rows.js';

export interface ActivityWork {
  /** Ключ работы: `workKey(projectPath, id)`. */
  key: string;
  /** Каталог журналов работы: `workPaths(projectPath, id).events`. */
  eventsDir: string;
  sessions: readonly WorkSession[];
}

/** Работа для подписки: журналы хуков лежат в её каталоге `events/` (4.2). */
export const activityWork = (entry: WorkEntry): ActivityWork => ({
  key: workKey(entry.projectPath, entry.map.work.id),
  eventsDir: workPaths(entry.projectPath, entry.map.work.id).events,
  sessions: entry.map.sessions,
});

export interface ActivityOptions {
  works: readonly ActivityWork[];
  /**
   * Страховка: что известно про лог провайдера. Индекс логов уже живёт в
   * `use-sessions`, второй раз читать файлы незачем.
   */
  log?: (session: WorkSession) => ActivityLog | null;
  silenceThresholdMs?: number;
}

export interface ActivityState {
  /** Полное состояние сессии; `null` — такой сессии в работах нет. */
  activityOf: (sessionId: string) => SessionActivity | null;
  /** Что рисует точка: activity живой сессии или её жизненный цикл (4.1). */
  stateOf: (session: WorkSession) => DotState;
  /** Точка работы — максимум по её сессиям; `null` — сессий нет (решение №6). */
  workState: (key: string) => DotState | null;
  /** Панель подключилась к сессии: `unseen` гаснет (4.1). */
  markSeen: (sessionId: string) => void;
  /** Каталога `events/` нет: нужен разовый `⚑` в строке статуса (4.3). */
  hooksMissing: boolean;
}

/** Журналы известных сессий: `null` — каталога `events/` нет вовсе. */
type Journals = ReadonlyMap<string, readonly EventRecord[] | null>;

/** Подписка пересоздаётся, только когда меняется набор работ и их сессий. */
const signatureOf = (works: readonly ActivityWork[]): string =>
  JSON.stringify(
    works.map((work) => [work.key, work.eventsDir, work.sessions.map((session) => session.id)]),
  );

export function useActivity({ works, log, silenceThresholdMs }: ActivityOptions): ActivityState {
  const [journals, setJournals] = useState<Journals>(new Map());
  // Сессия, к которой подключена панель: пока она подключена, её ход виден
  // целиком — «unseen переходит в idle, когда сессия подключена к панели и
  // панель на экране» (4.1).
  const [attached, setAttached] = useState<string | null>(null);
  // Водяной знак на сессию: длина журнала, которую пользователь уже видел.
  // При первом чтении просмотренным считается весь журнал — «после перезапуска
  // харнесса все завершившие ход сессии считаются idle» (4.1), — а пока панель
  // подключена, знак едет за журналом. Уехала панель — синий `unseen` зажжёт
  // только НОВЫЙ законченный ход, а не тот, что мы уже смотрели.
  const seenAt = useRef(new Map<string, number>());

  const signature = signatureOf(works);
  // Работы читаются из ссылки: их массив пересоздаётся на каждом рендере, а
  // подписка живёт, пока не изменился состав.
  const current = useRef(works);
  current.current = works;

  useEffect(() => {
    let cancelled = false;
    const remember = (sessionId: string, events: readonly EventRecord[] | null): void => {
      if (cancelled) return;
      // Каталог `events/` мог появиться позже самой сессии, поэтому у журнала
      // без каталога отметка тоже нулевая: пришедшее потом событие её сдвинет.
      if (!seenAt.current.has(sessionId)) seenAt.current.set(sessionId, events?.length ?? 0);
      setJournals((previous) => {
        const next = new Map(previous);
        next.set(sessionId, events);
        return next;
      });
    };

    const watchers = current.current.map((work) => {
      const journal = openEvents(work.eventsDir);
      const read = (sessionId: string): void => {
        journal
          .read(sessionId)
          .then((events) => remember(sessionId, events))
          // Журнал мог исчезнуть вместе с работой: состояние ведёт страховка.
          .catch(() => remember(sessionId, null));
      };
      for (const session of work.sessions) read(session.id);
      // Каталога может не быть (старый Claude Code без `--settings`) — тогда
      // watcher молча не заводится, а `hooksMissing` покажет предупреждение.
      return watchEvents(work.eventsDir, read, { onError: () => {} });
    });

    return () => {
      cancelled = true;
      for (const watcher of watchers) watcher.close();
    };
  }, [signature]);

  // Панель подключена — журнал этой сессии виден по мере роста, и знак едет за
  // ним. Отключились — знак остался на том, что успели посмотреть.
  useEffect(() => {
    if (attached === null) return;
    const events = journals.get(attached);
    if (events != null) seenAt.current.set(attached, events.length);
  }, [attached, journals]);

  const states = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, SessionActivity>();
    for (const work of current.current) {
      for (const session of work.sessions) {
        const events = journals.get(session.id) ?? null;
        map.set(
          session.id,
          activityOf({
            events,
            log: log?.(session) ?? null,
            // Журнал не вырос выше водяного знака — этот ход пользователь уже
            // видел, показывать его синим незачем (4.1). Без журнала вовсе
            // (`null`) сказать нечего, и всё решает подключение к панели.
            seen:
              attached === session.id ||
              (events !== null && events.length <= (seenAt.current.get(session.id) ?? 0)),
            now,
            ...(silenceThresholdMs === undefined ? {} : { silenceThresholdMs }),
          }),
        );
      }
    }
    return map;
  }, [journals, attached, log, silenceThresholdMs, signature]);

  const stateOf = useCallback(
    (session: WorkSession): DotState =>
      dotState(session.status, states.get(session.id)?.activity ?? null),
    [states],
  );

  const workState = useCallback(
    (key: string): DotState | null => {
      const work = current.current.find((item) => item.key === key);
      return work === undefined ? null : maxDotState(work.sessions.map(stateOf));
    },
    [stateOf],
  );

  const markSeen = useCallback((sessionId: string) => setAttached(sessionId), []);

  return {
    activityOf: useCallback((sessionId: string) => states.get(sessionId) ?? null, [states]),
    stateOf,
    workState,
    markSeen,
    // Хуков нет хотя бы у одной известной сессии — предупреждение общее (4.3).
    hooksMissing: [...journals.values()].some((events) => events === null),
  };
}
