import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTerminalBuffer,
  type TerminalBuffer,
  type TerminalSnapshot,
} from './terminal-buffer.js';
import type { PtySession } from './pty-session.js';

/**
 * Пауза между перерисовками правой панели. Claude Code стримит текст, и рисовать
 * каждый чанк незачем: копим пачку и отдаём один кадр (specs/pty.md).
 */
const FRAME_MS = 24;

export interface PtyTerminalOptions {
  cols: number;
  rows: number;
  frameMs?: number;
  scrollback?: number;
}

export interface PtyTerminal {
  /** Пока сессии нет — undefined: панель показывает карточку. */
  snapshot: TerminalSnapshot | undefined;
  /**
   * Прокрутка скроллбэка: меньше нуля — вверх, больше — вниз. Ею колесо мыши
   * листает наш буфер, когда гость отслеживание мыши не просил (дизайн 3.3).
   */
  scroll: (lines: number) => void;
}

/**
 * Гоняет потоки PTY через VT-парсеры и отдаёт снимок экрана подключённой сессии.
 *
 * Буфер у каждой живой сессии свой, и подписка на её вывод держится всё время
 * её жизни: агент, которого не видно, продолжает говорить, и его экран должен
 * вернуться целым, когда панель к нему вернётся (дизайн TUI v2, 2.2). Снимок и
 * ресайз — только у подключённой: остальные подгоняются под размер при
 * подключении, до первого кадра.
 */
export function usePtyTerminal(
  sessions: readonly PtySession[],
  active: PtySession | undefined,
  { cols, rows, frameMs = FRAME_MS, scrollback }: PtyTerminalOptions,
): PtyTerminal {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | undefined>();
  const buffers = useRef(new Map<PtySession, TerminalBuffer>());
  // Подключённая сессия и размер панели читаются из ссылок: подписка живёт
  // дольше кадра, и решать по состоянию рендера — значит отстать на кадр.
  const shown = useRef<PtySession | undefined>(undefined);
  shown.current = active;
  const size = useRef({ cols, rows });
  size.current = { cols, rows };
  const live = useRef(sessions);
  live.current = sessions;

  // Подписки пересоздаются, только когда меняется набор живых сессий.
  const signature = sessions.map((session) => session.pid).join(',');

  useEffect(() => {
    const running = new Set(live.current);
    // Процесс вышел — его экран больше не нужен никому.
    for (const [session, buffer] of buffers.current) {
      if (running.has(session)) continue;
      buffer.dispose();
      buffers.current.delete(session);
    }

    let disposed = false;
    const frames = new Map<PtySession, NodeJS.Timeout>();
    const unsubscribe = [...running].map((session) => {
      const buffer =
        buffers.current.get(session) ??
        createTerminalBuffer(size.current.cols, size.current.rows, scrollback);
      buffers.current.set(session, buffer);

      return session.onData((chunk) => {
        // Ждём, пока xterm разберёт чанк, и только потом планируем кадр:
        // парсер асинхронный, снимок сразу после write увидел бы старое состояние.
        buffer.write(chunk, () => {
          // Кадр рисуется только за подключённую сессию: остальные просто копят.
          if (disposed || shown.current !== session || frames.has(session)) return;
          frames.set(
            session,
            setTimeout(() => {
              frames.delete(session);
              if (!disposed && shown.current === session) setSnapshot(buffer.snapshot());
            }, frameMs),
          );
        });
      });
    });

    return () => {
      disposed = true;
      for (const stop of unsubscribe) stop();
      for (const frame of frames.values()) clearTimeout(frame);
    };
  }, [signature, frameMs, scrollback]);

  // Подключение и ресайз: экран на виду подгоняется под панель до кадра, иначе
  // гость вернулся бы нарисованным под прежний размер.
  useEffect(() => {
    if (active === undefined) {
      setSnapshot(undefined);
      return;
    }
    const buffer = buffers.current.get(active);
    if (buffer === undefined) return;
    buffer.resize(cols, rows);
    setSnapshot(buffer.snapshot());
  }, [active, cols, rows]);

  // Уходит вся панель — уходят и буферы: xterm держит своё состояние сам.
  const held = buffers.current;
  useEffect(
    () => () => {
      for (const buffer of held.values()) buffer.dispose();
      held.clear();
    },
    [held],
  );

  const scroll = useCallback(
    (lines: number) => {
      const buffer = active === undefined ? undefined : buffers.current.get(active);
      if (buffer === undefined) return;
      buffer.scroll(lines);
      setSnapshot(buffer.snapshot());
    },
    [active],
  );

  return { snapshot, scroll };
}
