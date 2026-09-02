import { useEffect } from 'react';
import type { PtySession } from './pty-session.js';

/**
 * Держит размер процесса в PTY в согласии с размером панели.
 *
 * Ресайз обязан доехать в ОБА места: сюда, в node-pty (процесс получит SIGWINCH),
 * и в буфер xterm — тем занимается usePtyTerminal (specs/pty.md).
 */
export function usePtyResize(session: PtySession | undefined, cols: number, rows: number): void {
  useEffect(() => {
    session?.resize(cols, rows);
  }, [session, cols, rows]);
}
