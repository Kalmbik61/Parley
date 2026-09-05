/**
 * Синхронизация карт с внешним миром: живость процессов, авто-заголовок Claude
 * Code и флажок `⚑` у неподключённой `blocked` сессии (дизайн TUI v2, 5.1, 5.4 и 6).
 *
 * Всё идёт по событиям watcher карт — таймера здесь нет.
 */

import {
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
  push: (events: readonly StatusEventInit[]) => void;
  fail: (reason: unknown) => void;
}

export function useMapSync({
  works,
  roots,
  index,
  activityOf,
  attached,
  push,
  fail,
}: MapSyncOptions): void {
  // Живость: при старте и на каждое событие watcher карт, без таймера (5.4).
  useEffect(() => {
    for (const entry of works) {
      void reconcileMap(entry.projectPath, entry.map.work.id, roots).catch(() => {});
    }
  }, [works, roots]);

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
