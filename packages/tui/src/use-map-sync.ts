/**
 * Синхронизация карт с внешним миром: живость процессов, `SessionEnd` из журнала
 * хуков, авто-заголовок Claude Code и флажок `⚑` у неподключённой `blocked`
 * сессии (дизайн TUI v2, 4.2, 5.1, 5.4 и 6).
 *
 * Всё идёт по событиям watcher карт — таймера здесь нет.
 */

import {
  finishSession,
  reconcileMap,
  type MetricsRoots,
  type SessionActivity,
  type SessionIndex,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import { useEffect, useRef } from 'react';
import { workRunKey } from './pty/use-agent-pty.js';
import type { StatusEventInit } from './use-status.js';
import { applyAutoTitle, NEW_LABEL } from './work-launch.js';

export interface MapSyncOptions {
  works: readonly WorkEntry[];
  roots: MetricsRoots;
  /** Индекс логов провайдера: из него приходит заголовок Claude Code. */
  index: (session: WorkSession) => SessionIndex | undefined;
  activityOf: (sessionId: string) => SessionActivity | null;
  /**
   * Ключ подключённой панели: про сессию, чей гость на экране, «не подключена»
   * писать нельзя (макет 1.5).
   */
  attached: string | null;
  /**
   * Чей PTY держит сам харнесс: у такой сессии `SessionEnd` из журнала не
   * трогает карту — настоящий код выхода принесёт выход процесса. Хук Claude Code
   * срабатывает ДО выхода, так что без этой оговорки код терялся бы всегда.
   */
  held: (key: string) => boolean;
  push: (events: readonly StatusEventInit[]) => void;
  fail: (reason: unknown) => void;
}

export function useMapSync({
  works,
  roots,
  index,
  activityOf,
  attached,
  held,
  push,
  fail,
}: MapSyncOptions): void {
  // Живость: при старте и на каждое событие watcher карт, без таймера (5.4).
  useEffect(() => {
    for (const entry of works) {
      void reconcileMap(entry.projectPath, entry.map.work.id, roots).catch(() => {});
    }
  }, [works, roots]);

  // `SessionEnd` в журнале: агент попрощался, а отчёта не было — сессия уходит
  // в `exited` тем же путём, что и сверка живости (таблица 4.2). Код выхода
  // неизвестен: этот процесс ждал не харнесс. Сессию, чей PTY у нас, не трогаем:
  // хук приходит раньше выхода процесса, а настоящий код принесёт сам выход.
  const ended = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        if (session.status !== 'active' || ended.current.has(session.id)) continue;
        if (held(workRunKey(entry.projectPath, entry.map.work.id, session.id))) continue;
        if (activityOf(session.id)?.exited !== true) continue;
        ended.current = new Set([...ended.current, session.id]);
        void finishSession(entry.projectPath, entry.map.work.id, session.id, 'exited', {
          exitCode: null,
          ...roots,
        }).catch(() => {});
      }
    }
  }, [works, activityOf, held, roots]);

  // Заголовок Claude Code доехал до индекса логов — переименование один раз (5.1).
  useEffect(() => {
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        const title = session.label === NEW_LABEL ? index(session)?.title : null;
        if (title === undefined || title === null) continue;
        void applyAutoTitle(entry.projectPath, entry.map.work.id, session.id, title).catch(fail);
      }
    }
  }, [works, index, fail]);

  // `⚑` при переходе в `blocked` у неподключённой сессии; гаснет при подключении (6).
  const flagged = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const now = new Set<string>();
    const events: StatusEventInit[] = [];
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        if (activityOf(session.id)?.activity !== 'blocked') continue;
        now.add(session.id);
        const workId = entry.map.work.id;
        if (flagged.current.has(session.id)) continue;
        if (workRunKey(entry.projectPath, workId, session.id) === attached) continue;
        const source = { projectPath: entry.projectPath, workId, sessionId: session.id };
        events.push({ text: `${session.label} ждёт ответа — не подключена`, source });
      }
    }
    flagged.current = now;
    push(events);
  }, [works, activityOf, attached, push]);
}
