import type { Log } from './log.js';

/** Больше стольких необработанных исключений за окно — хост останавливается обычным порядком. */
export const UNCAUGHT_LIMIT = 10;
export const UNCAUGHT_WINDOW_MS = 60_000;

/**
 * Процессные обработчики хоста: в нём живут PTY всех агентов, и брошенное слушателем исключение или
 * отвергнутый промис не должны убить их все разом. Оба случая пишутся в лог и хост работает дальше;
 * частые исключения (признак того, что состояние в памяти уже не починить) запускают остановку, один раз.
 */
export function installCrashGuards(options: {
  log: Log;
  shutdown: (reason: string) => Promise<void>;
  target?: Pick<NodeJS.Process, 'on' | 'off'>;
  now?: () => number;
}): () => void {
  const target = options.target ?? process;
  const now = options.now ?? Date.now;
  let stamps: number[] = [];
  let shutdownRequested = false;

  // Сбой записи в самом обработчике не должен рождать новое исключение.
  const report = (msg: string, error: unknown): void => {
    try {
      const text = error instanceof Error ? error.message : String(error);
      options.log.error(msg, { error: text, ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) });
    } catch {
      // лог не может сообщить о собственной поломке
    }
  };

  const onRejection = (reason: unknown): void => {
    report('unhandled rejection', reason);
  };

  const onException = (error: unknown): void => {
    report('uncaught exception', error);
    const current = now();
    stamps = stamps.filter((stamp) => current - stamp <= UNCAUGHT_WINDOW_MS);
    stamps.push(current);
    if (stamps.length <= UNCAUGHT_LIMIT || shutdownRequested) return;
    shutdownRequested = true;
    options.shutdown('too-many-uncaught-exceptions').catch((shutdownError: unknown) => {
      report('shutdown after uncaught exceptions failed', shutdownError);
    });
  };

  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
}
