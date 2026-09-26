/**
 * Тонкая обёртка над node-pty (`packages/tui/src/pty/pty-session.ts` — тот же
 * приём): изолирует остальной хост от конкретной библиотеки и даёт интерфейс,
 * который проще подменить в тестах. Разбор потока байтов сюда не входит — это
 * забота `screen.ts` (@xterm/headless), план, кусок 1.6.
 */

import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';

export interface PtyLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ExitInfo {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: ExitInfo) => void): () => void;
}

/** Запускает процесс в псевдотерминале с заданным стартовым размером. */
export function spawnPty(launch: PtyLaunch, size: { cols: number; rows: number }): PtyProcess {
  const pty: IPty = spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: launch.cwd,
    // `PtyLaunch.env` собирает вызывающая сторона (agentEnv, П0) — здесь только
    // приведение типа: node-pty не принимает `undefined` в значениях, а
    // `NodeJS.ProcessEnv` их допускает.
    env: launch.env as Record<string, string>,
  });

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: ExitInfo) => void>();

  pty.onData((data) => {
    for (const listener of dataListeners) listener(data);
  });

  pty.onExit(({ exitCode, signal }) => {
    const info: ExitInfo = { exitCode, signal: signal ?? null };
    for (const listener of exitListeners) listener(info);
  });

  return {
    get pid() {
      return pty.pid;
    },

    write(data) {
      pty.write(data);
    },

    resize(cols, rows) {
      try {
        pty.resize(cols, rows);
      } catch {
        // Процесс мог умереть между проверкой вызывающей стороны и этим
        // вызовом (EBADF на закрытом fd) — событие exit придёт своим чередом.
      }
    },

    kill(signal) {
      try {
        pty.kill(signal);
      } catch {
        // См. resize() выше: гонка с уже завершившимся процессом — не ошибка.
      }
    },

    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },

    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}
