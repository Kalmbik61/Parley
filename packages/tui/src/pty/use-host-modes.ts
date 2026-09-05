import { useEffect } from 'react';
import type { MouseTracking } from './terminal-buffer.js';

const CSI = '\u001B[';

/**
 * Какие режимы включить у СЕБЯ, чтобы гость получал то, что просил.
 *
 * Мы не рисуем мышь сами: включаем отслеживание в своём терминале, а события,
 * которые он начнёт слать в stdin, уже уходят в PTY как сырой поток (usePtyInput).
 * Кодирование всегда SGR (?1006) — древние X10/UTF-8 форматы не поддерживаем.
 */
const MOUSE_MODES: Record<MouseTracking, string[]> = {
  none: [],
  x10: ['?9'],
  vt200: ['?1000', '?1006'],
  drag: ['?1002', '?1006'],
  any: ['?1003', '?1006'],
};

const ALL_MOUSE_MODES = ['?9', '?1000', '?1002', '?1003', '?1006'];

/**
 * Что держим включённым сами, когда ловим мышь (дизайн TUI v2, 3.3): клики и
 * колесо в SGR. Гость мог не просить мышь вовсе — сайдбару она нужна всё равно.
 */
const HOST_MOUSE_MODES = ['?1000', '?1006'];

/** Последовательности включения запрошенных режимов. */
export function enableSequence(
  mouseTracking: MouseTracking,
  bracketedPaste: boolean,
  mouseCapture = false,
): string {
  const modes = new Set([
    ...(mouseCapture ? HOST_MOUSE_MODES : []),
    ...MOUSE_MODES[mouseTracking],
    ...(bracketedPaste ? ['?2004'] : []),
  ]);
  return [...modes].map((mode) => `${CSI}${mode}h`).join('');
}

/** Последовательности выключения всего, что мы могли включить. */
export function disableSequence(): string {
  return [...ALL_MOUSE_MODES, '?2004'].map((mode) => `${CSI}${mode}l`).join('');
}

/**
 * Пишем режимы прямо в терминал, минуя Ink: это не содержимое экрана, а состояние
 * устройства. Не-TTY (пайп, тесты) пропускаем — там отслеживать мышь некому, а
 * лишняя запись только мешала бы Ink считать свои кадры.
 */
function writeToTerminal(sequence: string): void {
  if (sequence !== '' && process.stdout.isTTY === true) process.stdout.write(sequence);
}

/**
 * Зеркалит режимы гостя в хост-терминал, пока правая панель в фокусе.
 * Уходит фокус или закрывается приложение — режимы гасятся, иначе терминал
 * останется слать в stdin то, что уже никто не разбирает.
 */
export function useHostTerminalModes(
  active: boolean,
  mouseTracking: MouseTracking,
  bracketedPaste: boolean,
  write: (sequence: string) => void = writeToTerminal,
  mouseCapture = false,
): void {
  useEffect(() => {
    if (!active) return;

    write(enableSequence(mouseTracking, bracketedPaste, mouseCapture));
    return () => write(disableSequence());
  }, [active, mouseTracking, bracketedPaste, write, mouseCapture]);
}
