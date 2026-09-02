import { useStdout } from 'ink';
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
 * Зеркалит режимы гостя в хост-терминал, пока правая панель в фокусе.
 * Уходит фокус или закрывается приложение — режимы гасятся, иначе терминал
 * останется слать в stdin то, что уже никто не разбирает.
 */
export function useHostTerminalModes(
  active: boolean,
  mouseTracking: MouseTracking,
  bracketedPaste: boolean,
): void {
  const { stdout } = useStdout();

  useEffect(() => {
    if (!active || stdout === undefined) return;

    const enabled = [...MOUSE_MODES[mouseTracking], ...(bracketedPaste ? ['?2004'] : [])];
    if (enabled.length > 0) stdout.write(enabled.map((mode) => `${CSI}${mode}h`).join(''));

    return () => {
      stdout.write([...ALL_MOUSE_MODES, '?2004'].map((mode) => `${CSI}${mode}l`).join(''));
    };
  }, [active, mouseTracking, bracketedPaste, stdout]);
}
