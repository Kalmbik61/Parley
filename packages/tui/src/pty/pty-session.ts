import { spawn, type IPty } from 'node-pty';

export interface PtyExit {
  exitCode: number;
  signal: number | undefined;
}

export type PtyState = 'running' | 'exited';

export interface PtySpawnOptions {
  /** Абсолютный путь к бинарю — результат findClaudeBinary(). */
  file: string;
  args?: string[];
  /** Рабочий каталог процесса: для `claude --resume` это cwd сессии. */
  cwd?: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
}

export interface PtySession {
  readonly pid: number;
  readonly state: PtyState;
  /** Заполняется, когда процесс завершился. */
  readonly exit: PtyExit | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Мягкое завершение. По умолчанию SIGHUP — как при закрытии терминала. */
  kill(signal?: string): void;
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (exit: PtyExit) => void): () => void;
}

/** Минимальные размеры: node-pty на нулях ведёт себя непредсказуемо. */
const clampSize = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Math.max(2, Math.floor(cols)),
  rows: Math.max(2, Math.floor(rows)),
});

/**
 * Запускает процесс в псевдотерминале.
 *
 * Никакой логики «что за программа внутри» здесь нет: это тонкая обёртка над node-pty
 * с предсказуемым завершением и подписками. Разбор потока байтов — забота VT-парсера
 * (@xterm/headless, specs/pty.md).
 */
export function spawnPtySession({
  file,
  args = [],
  cwd,
  cols,
  rows,
  env = process.env,
}: PtySpawnOptions): PtySession {
  const size = clampSize(cols, rows);

  const pty: IPty = spawn(file, args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    // Наследуем окружение пользователя: бинарь сам разбирается со своей
    // аутентификацией. Харнесс не читает и не подставляет никаких учётных данных.
    env: { ...env, TERM: 'xterm-256color' } as Record<string, string>,
    ...(cwd === undefined ? {} : { cwd }),
  });

  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(exit: PtyExit) => void>();

  let state: PtyState = 'running';
  let exit: PtyExit | undefined;

  pty.onData((chunk) => {
    for (const listener of dataListeners) listener(chunk);
  });

  pty.onExit(({ exitCode, signal }) => {
    state = 'exited';
    exit = { exitCode, signal };
    for (const listener of exitListeners) listener(exit);
  });

  return {
    get pid() {
      return pty.pid;
    },
    get state() {
      return state;
    },
    get exit() {
      return exit;
    },

    write(data) {
      if (state === 'running') pty.write(data);
    },

    resize(nextCols, nextRows) {
      if (state !== 'running') return;
      const next = clampSize(nextCols, nextRows);
      pty.resize(next.cols, next.rows);
    },

    kill(signal = 'SIGHUP') {
      if (state !== 'running') return;
      try {
        pty.kill(signal);
      } catch {
        // Процесс мог умереть между проверкой и вызовом — это не ошибка.
      }
    },

    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },

    onExit(listener) {
      // Процесс мог завершиться до подписки — не теряем событие.
      if (state === 'exited' && exit !== undefined) {
        const finished = exit;
        queueMicrotask(() => listener(finished));
        return () => {};
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}
