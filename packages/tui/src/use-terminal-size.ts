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
// Не-TTY stdout (пайп, тесты) не сообщает размер — тогда берём разумный минимум.
const FALLBACK: TerminalSize = { columns: 80, rows: 24 };

const sizeOf = (stdout: { columns?: number; rows?: number } | undefined): TerminalSize => ({
  columns: stdout?.columns ?? FALLBACK.columns,
  rows: stdout?.rows ?? FALLBACK.rows,
});

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => sizeOf(stdout));

  useEffect(() => {
    if (!stdout) return;
    const update = (): void => setSize(sizeOf(stdout));
    update();
    stdout.on('resize', update);
    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  return size;
}
