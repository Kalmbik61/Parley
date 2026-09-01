import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Размер терминала с подпиской на ресайз. Нужен и макету, и (в v1) PTY:
 * правой панели придётся сообщать свои cols/rows и node-pty, и xterm.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const update = (): void => setSize({ columns: stdout.columns, rows: stdout.rows });
    update();
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  return size;
}
