import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

export interface Log {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

/**
 * JSON-строки со временем, синхронная запись: лог хоста пишется редко
 * (старт, остановка, сбои), поток `pty.output` через него не идёт, так что
 * блокировка событийного цикла не ощущается, а порядок строк гарантирован.
 */
export function createLog(file: string, options?: { maxBytes?: number }): Log {
  const maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;

  const write = (level: string, msg: string, data?: object): void => {
    if (existsSync(file) && statSync(file).size >= maxBytes) {
      renameSync(file, `${file}.1`);
    }
    const line = `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...data })}\n`;
    appendFileSync(file, line, 'utf8');
  };

  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}
