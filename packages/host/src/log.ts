import { appendFileSync, renameSync, statSync } from 'node:fs';
import { maskTelegramTokens } from '@parley/core';

export interface Log {
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

/**
 * JSON-строки со временем, синхронная запись: лог хоста пишется редко
 * (старт, остановка, сбои), поток `pty.output` через него не идёт, так что
 * блокировка событийного цикла не ощущается, а порядок строк гарантирован. Ничего не буферизуется:
 * строка уходит в файл до возврата из вызова, так что ни остановка хоста, ни падение процесса
 * не теряют уже записанного. Размер файла считается в памяти: диск спрашивается один раз до первой
 * записи и у порога ротации, а не на каждой строке.
 */
export function createLog(file: string, options?: { maxBytes?: number }): Log {
  const maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
  /** Размер файла по нашему счёту; `null` — ещё не спрашивали диск (или запись упала и счёт ненадёжен). */
  let size: number | null = null;
  const diskSize = (): number => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };

  /** Токен бота Telegram не должен попасть в файл ни через сообщение, ни через строковое поле. */
  const mask = (data: object | undefined): object | undefined =>
    data === undefined
      ? undefined
      : Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === 'string' ? maskTelegramTokens(value) : value]));

  const write = (level: string, rawMsg: string, rawData?: object): void => {
    try {
      const msg = maskTelegramTokens(rawMsg);
      const data = mask(rawData);
      size ??= diskSize();
      if (size >= maxBytes) {
        // Файл мог повернуть другой процесс хоста (журнал заводится до замка `host.pid`): у порога сверяемся с диском.
        size = diskSize();
        if (size >= maxBytes) {
          renameSync(file, `${file}.1`);
          size = 0;
        }
      }
      const line = `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...data })}\n`;
      appendFileSync(file, line, 'utf8');
      size += Buffer.byteLength(line);
    } catch {
      // Счёт мог разойтись с диском (запись упала на полпути): следующая строка спросит диск заново.
      size = null;
      // Журнал не должен ронять вызывающего: диск полон или каталога нет — строка теряется.
    }
  };

  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}
