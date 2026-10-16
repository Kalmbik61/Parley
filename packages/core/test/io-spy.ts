/**
 * Шпион ввода-вывода для тестов карты-журнала. Видит ВСЕ пути, которыми код читает файл: `readFile` и `open` из
 * `node:fs/promises`, чтение через дескриптор (`handle.read`, `handle.readFile` — так читают страницы журнала и
 * поиск по id), а также синхронные `node:fs` (`readFileSync`, `openSync` + `readSync` — так читают приёмник писем и
 * ленивая сборка карты в мутаторе). Для каждого пути считаются обращения и ПРОЧИТАННЫЕ БАЙТЫ: «журнал не читался
 * целиком» проверяется числом байт, а не словами «файл не открывали».
 *
 * Подключение в тесте (фабрики `vi.mock` поднимаются выше импортов, поэтому журнал создаёт `vi.hoisted`):
 *   const io = vi.hoisted(() => ({ opened: [], writes: [], bytes: {} }));
 *   vi.mock('node:fs/promises', async (original) => (await import('../../test/io-spy.js')).spyFsPromises(await original(), io));
 *   vi.mock('node:fs', async (original) => (await import('../../test/io-spy.js')).spyFs(await original(), io));
 */

export interface IoLog {
  /** Пути, которые открыли или прочитали (по одному разу на обращение). */
  opened: string[];
  /** Пути, в которые писали, дописывали или переименовывали. */
  writes: string[];
  /** Прочитано байт по пути (после `reset` — с нуля). */
  bytes: Record<string, number>;
}

export const newIoLog = (): IoLog => ({ opened: [], writes: [], bytes: {} });

export function resetIo(log: IoLog): void {
  log.opened.length = 0;
  log.writes.length = 0;
  for (const key of Object.keys(log.bytes)) delete log.bytes[key];
}

const count = (log: IoLog, file: unknown, size: number): void => {
  const key = String(file);
  log.bytes[key] = (log.bytes[key] ?? 0) + size;
};

const isWriteFlag = (flags: unknown): boolean => typeof flags === 'string' && /[wa+]/.test(flags);

type AnyFn = (...args: unknown[]) => unknown;

/** Дескриптор файла `node:fs/promises`: чтения считаются, остальное идёт как есть. */
function spyHandle<H extends object>(handle: H, file: string, log: IoLog): H {
  return new Proxy(handle, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as AnyFn).bind(target);
      if (key === 'read') {
        return async (...args: unknown[]) => {
          const result = (await bound(...args)) as { bytesRead: number };
          count(log, file, result.bytesRead);
          return result;
        };
      }
      if (key === 'readFile') {
        return async (...args: unknown[]) => {
          const result = (await bound(...args)) as string | Buffer;
          count(log, file, Buffer.byteLength(result));
          return result;
        };
      }
      if (key === 'write' || key === 'writeFile' || key === 'appendFile') {
        return (...args: unknown[]) => {
          log.writes.push(file);
          return bound(...args);
        };
      }
      return bound;
    },
  });
}

export function spyFsPromises<T extends object>(actual: T, log: IoLog): T {
  const real = actual as unknown as Record<string, AnyFn>;
  return {
    ...actual,
    readFile: async (file: unknown, ...rest: unknown[]) => {
      log.opened.push(String(file));
      const result = (await real['readFile']!(file, ...rest)) as string | Buffer;
      count(log, file, Buffer.byteLength(result));
      return result;
    },
    open: async (file: unknown, flags: unknown, ...rest: unknown[]) => {
      (isWriteFlag(flags) ? log.writes : log.opened).push(String(file));
      return spyHandle((await real['open']!(file, flags, ...rest)) as object, String(file), log);
    },
    writeFile: (file: unknown, ...rest: unknown[]) => {
      log.writes.push(String(file));
      return real['writeFile']!(file, ...rest);
    },
    appendFile: (file: unknown, ...rest: unknown[]) => {
      log.writes.push(String(file));
      return real['appendFile']!(file, ...rest);
    },
    rename: (from: unknown, to: unknown) => {
      log.writes.push(String(to));
      return real['rename']!(from, to);
    },
  } as T;
}

export function spyFs<T extends object>(actual: T, log: IoLog): T {
  const real = actual as unknown as Record<string, AnyFn>;
  const fds = new Map<number, string>();
  const spied = {
    ...actual,
    readFileSync: (file: unknown, ...rest: unknown[]) => {
      log.opened.push(String(file));
      const result = real['readFileSync']!(file, ...rest) as string | Buffer;
      count(log, file, Buffer.byteLength(result));
      return result;
    },
    openSync: (file: unknown, flags: unknown, ...rest: unknown[]) => {
      const fd = real['openSync']!(file, flags, ...rest) as number;
      fds.set(fd, String(file));
      (isWriteFlag(flags) ? log.writes : log.opened).push(String(file));
      return fd;
    },
    readSync: (fd: unknown, ...rest: unknown[]) => {
      const bytesRead = real['readSync']!(fd, ...rest) as number;
      const file = fds.get(fd as number);
      if (file !== undefined) count(log, file, bytesRead);
      return bytesRead;
    },
    closeSync: (fd: unknown) => {
      fds.delete(fd as number);
      return real['closeSync']!(fd);
    },
    writeFileSync: (file: unknown, ...rest: unknown[]) => {
      log.writes.push(String(file));
      return real['writeFileSync']!(file, ...rest);
    },
    appendFileSync: (file: unknown, ...rest: unknown[]) => {
      log.writes.push(String(file));
      return real['appendFileSync']!(file, ...rest);
    },
    renameSync: (from: unknown, to: unknown) => {
      log.writes.push(String(to));
      return real['renameSync']!(from, to);
    },
  };
  return spied as T;
}
