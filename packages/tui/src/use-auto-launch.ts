/**
 * Автозапуск `pending` сессий, порождённых агентом (дизайн TUI v2, 5.2, настройка
 * `autoLaunch`). Запускается только то, что появилось в карте при живом TUI:
 * записи, найденные при старте, остаются ждать человека — иначе открытие
 * харнесса разом поднимало бы процессы из всех старых работ.
 *
 * Сессии без `parent` завёл человек (диалог, `prefix C`, CLI) — их он запускает сам.
 *
 * Работу с живой арендой хоста (`host.lease`, кусок 1.4 плана хоста) TUI не
 * трогает: сессии внутри неё запускает и видит хост, второй запуск тем же
 * pending удвоил бы процесс агента.
 */

import { displayStatus, hostLeaseActive, type WorkEntry, type WorkSession } from '@harnas/core';
import { useEffect, useRef } from 'react';

export interface AutoLaunchOptions {
  works: readonly WorkEntry[];
  /** Пока первое чтение не закончилось, всё увиденное считается «старым». */
  loading: boolean;
  enabled: boolean;
  launch: (projectPath: string, workId: string, session: WorkSession) => void;
}

export function useAutoLaunch({ works, loading, enabled, launch }: AutoLaunchOptions): void {
  const known = useRef<Set<string> | null>(null);
  // Колбэк через ссылку: его новый экземпляр не должен перезапускать эффект.
  const start = useRef(launch);
  start.current = launch;

  useEffect(() => {
    if (loading) return;
    // Первое полное чтение: запоминаем, никого не запуская.
    if (known.current === null) {
      known.current = new Set(
        works.flatMap((entry) => entry.map.sessions.map((session) => session.id)),
      );
      return;
    }

    // Кандидаты собираются синхронно (иначе повторный рендер до того, как
    // асинхронная проверка аренды вернётся, отметил бы их как известные и
    // запуска не случилось бы вовсе), а сама аренда сверяется отдельно —
    // `hostLeaseActive` читает файл с диска.
    const candidates: Array<{ projectPath: string; workId: string; session: WorkSession }> = [];
    for (const entry of works) {
      for (const session of entry.map.sessions) {
        if (known.current.has(session.id)) continue;
        known.current.add(session.id);
        if (!enabled || displayStatus(session) !== 'pending' || session.parent === null) continue;
        candidates.push({ projectPath: entry.projectPath, workId: entry.map.work.id, session });
      }
    }
    if (candidates.length === 0) return;

    void (async () => {
      for (const candidate of candidates) {
        if (await hostLeaseActive(candidate.projectPath, candidate.workId)) continue;
        start.current(candidate.projectPath, candidate.workId, candidate.session);
      }
    })();
  }, [works, loading, enabled]);
}
