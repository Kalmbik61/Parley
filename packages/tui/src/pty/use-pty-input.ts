import { useStdin } from 'ink';
import { useEffect } from 'react';
import type { PtySession } from './pty-session.js';

/**
 * Клавиша выхода из терминала по умолчанию — Ctrl+Q (байт 0x11).
 *
 * Claude Code её не занимает (у него заняты Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+R, Esc),
 * а в raw-режиме терминал не перехватывает её под управление потоком.
 */
export const DEFAULT_ESCAPE_BYTE = 0x11;

/** Ctrl+<буква> в байт: Ctrl+A = 1, Ctrl+Q = 17. */
export function ctrlByte(letter: string): number | undefined {
  const code = letter.trim().toLowerCase().charCodeAt(0);
  if (Number.isNaN(code) || code < 97 || code > 122) return undefined;
  return code - 96;
}

export interface PtyInputOptions {
  /** Байт, возвращающий фокус спискам. */
  escapeByte?: number;
  onEscape: () => void;
}

/**
 * Пока правая панель в фокусе, ВЕСЬ ввод уходит в PTY — стрелки, Ctrl-комбинации,
 * Esc и мышь тоже (specs/pty.md). Поэтому читаем сырой stdin, а не разобранные
 * события Ink: разбор потерял бы исходные последовательности.
 */
export function usePtyInput(
  session: PtySession | undefined,
  active: boolean,
  { escapeByte = DEFAULT_ESCAPE_BYTE, onEscape }: PtyInputOptions,
): void {
  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    if (!active || session === undefined || stdin === undefined) return;

    setRawMode?.(true);

    const onData = (chunk: Buffer | string): void => {
      const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const at = data.indexOf(escapeByte);

      if (at === -1) {
        session.write(data.toString('utf8'));
        return;
      }

      // Всё до escape-клавиши — ещё ввод агента, остаток отбрасываем.
      if (at > 0) session.write(data.subarray(0, at).toString('utf8'));
      onEscape();
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      setRawMode?.(false);
    };
  }, [active, session, stdin, setRawMode, escapeByte, onEscape]);
}
