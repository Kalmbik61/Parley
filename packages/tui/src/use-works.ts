import { DEFAULT_CONFIG, readWorks, watchWorks, type WorkEntry } from '@harnas/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { glyphs } from './glyphs.js';
import type { StatusEventInit } from './use-status.js';
import { worksEvents } from './work-events.js';

export interface WorksOptions {
  /** Проект, в котором запущен харнесс: его карты читаются с диска напрямую. */
  projectPath: string;
  /** Имя префикса: подсказки событий зовут клавиши только через него (§3). */
  prefix: string;
  /**
   * `config.messageRate`: потолок писем одной сессии за час. Строка статуса
   * считает то же условие, что и `send_message` (разговор агентов, 4.7).
   */
  messageRate?: number;
  /** Включён ли автозапуск `pending` от агента: меняет текст события (5.2). */
  autoLaunch?: boolean;
  /** События карты уходят в строку статуса — единственный канал уведомлений. */
  onEvents?: (events: readonly StatusEventInit[]) => void;
}

export interface WorksState {
  works: WorkEntry[];
  loading: boolean;
  /** Принудительное перечитывание по клавише `r`. */
  rescan: () => void;
}

/**
 * Живой список работ: читается один раз и дальше обновляется по событиям watcher
 * карт — без опроса по таймеру, как и список сессий (specs/ui.md).
 */
export function useWorks({
  projectPath,
  prefix,
  messageRate = DEFAULT_CONFIG.messageRate,
  autoLaunch = false,
  onEvents,
}: WorksOptions): WorksState {
  const [works, setWorks] = useState<WorkEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  // Прошлое чтение нужно, чтобы понять, что именно изменилось; колбэк — через
  // ref, иначе его новая ссылка пересоздавала бы watcher на каждый рендер.
  const previous = useRef<WorkEntry[]>([]);
  const notify = useRef(onEvents);
  notify.current = onEvents;

  const apply = useCallback(
    (next: WorkEntry[]) => {
      const events = worksEvents(previous.current, next, glyphs(), prefix, {
        rate: messageRate,
        autoLaunch,
      });
      previous.current = next;
      setWorks(next);
      if (events.length > 0) notify.current?.(events);
    },
    [prefix, messageRate, autoLaunch],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    readWorks(projectPath)
      .then((list) => {
        if (cancelled) return;
        apply(list);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath, generation, apply]);

  useEffect(() => {
    const watcher = watchWorks((list) => apply(list), projectPath);
    return () => watcher.close();
  }, [projectPath, apply]);

  const rescan = useCallback(() => setGeneration((n) => n + 1), []);

  return { works, loading, rescan };
}
