import { useCallback, useRef, useState } from 'react';

/**
 * Строка списка, породившая событие. Событие гаснет, когда фокус на ней побывал
 * (дизайн координации TUI, раздел 5).
 */
export interface StatusSource {
  projectPath: string;
  workId: string;
  sessionId: string | null;
}

export interface StatusEventInit {
  text: string;
  hint?: string;
  /** Событие без источника (предупреждение о лимитах) гаснет по любой клавише. */
  source?: StatusSource;
}

export interface StatusEvent extends StatusEventInit {
  id: number;
}

export interface StatusState {
  /** Сколько событий ещё не просмотрено — `⚑N` в строке статуса. */
  count: number;
  /** Показывается только последнее; следы прежних видны в списках. */
  last: StatusEvent | null;
  push: (events: readonly StatusEventInit[]) => void;
  seen: (source: StatusSource | null) => void;
  keyPressed: () => void;
}

const sameSource = (a: StatusSource, b: StatusSource): boolean =>
  a.projectPath === b.projectPath && a.workId === b.workId && a.sessionId === b.sessionId;

/**
 * Непросмотренные события строки статуса. Ничего не мигает и не выпрыгивает:
 * пользователь в это время может печатать в правой панели.
 */
export function useStatus(): StatusState {
  const [events, setEvents] = useState<StatusEvent[]>([]);
  const nextId = useRef(0);

  const push = useCallback((incoming: readonly StatusEventInit[]) => {
    if (incoming.length === 0) return;
    setEvents((current) => [
      ...current,
      ...incoming.map((event) => ({ ...event, id: nextId.current++ })),
    ]);
  }, []);

  const seen = useCallback((source: StatusSource | null) => {
    if (source === null) return;
    setEvents((current) => {
      const kept = current.filter(
        (event) => event.source === undefined || !sameSource(event.source, source),
      );
      // Новый массив на каждый вызов заставлял бы перерисовываться впустую.
      return kept.length === current.length ? current : kept;
    });
  }, []);

  const keyPressed = useCallback(() => {
    setEvents((current) => {
      const kept = current.filter((event) => event.source !== undefined);
      return kept.length === current.length ? current : kept;
    });
  }, []);

  return {
    count: events.length,
    last: events[events.length - 1] ?? null,
    push,
    seen,
    keyPressed,
  };
}
