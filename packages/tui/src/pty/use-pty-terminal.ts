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
 * Гоняет поток PTY через VT-парсер и отдаёт снимок экрана для рендера.
 */
export function usePtyTerminal(
  session: PtySession | undefined,
  { cols, rows, frameMs = FRAME_MS, scrollback }: PtyTerminalOptions,
): PtyTerminal {
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | undefined>();
  const bufferRef = useRef<TerminalBuffer | undefined>(undefined);

  useEffect(() => {
    if (session === undefined) {
      setSnapshot(undefined);
      return;
    }

    const buffer = createTerminalBuffer(cols, rows, scrollback);
    bufferRef.current = buffer;

    let frame: NodeJS.Timeout | undefined;
    let disposed = false;

    const flush = (): void => {
      frame = undefined;
      if (!disposed) setSnapshot(buffer.snapshot());
    };

    const unsubscribe = session.onData((chunk) => {
      // Ждём, пока xterm разберёт чанк, и только потом планируем кадр:
      // парсер асинхронный, снимок сразу после write увидел бы старое состояние.
      buffer.write(chunk, () => {
        if (disposed || frame !== undefined) return;
        frame = setTimeout(flush, frameMs);
      });
    });

    // Первый кадр сразу: панель не должна оставаться пустой до первого байта.
    setSnapshot(buffer.snapshot());

    return () => {
      disposed = true;
      unsubscribe();
      if (frame !== undefined) clearTimeout(frame);
      bufferRef.current = undefined;
      buffer.dispose();
    };
    // cols/rows намеренно не в зависимостях: размер меняется через resize ниже,
    // пересоздавать буфер на каждый ресайз значило бы терять экран.
  }, [session, frameMs, scrollback]);

  useEffect(() => {
    const buffer = bufferRef.current;
    if (buffer === undefined) return;
    buffer.resize(cols, rows);
    setSnapshot(buffer.snapshot());
  }, [cols, rows]);

  const scroll = useCallback((lines: number) => {
    const buffer = bufferRef.current;
    if (buffer === undefined) return;
    buffer.scroll(lines);
    setSnapshot(buffer.snapshot());
  }, []);

  return { snapshot, scroll };
}
