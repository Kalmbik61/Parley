/**
 * Файловый API main (спека 10.7). В 5.2 — `stat` и `locate`: на них стоят ссылки
 * терминала (спека 8.3); в 7.1a — `list`, `readText`, `readBytes` и `write` для
 * дерева и редактора; git, поиск и слежение приходят в 7.1b. Каждый путь проходит
 * реестр корней (`main/roots.ts`), отказ по одному пути пачку `stat` не валит.
 */
import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, rename, stat as fsStat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry, FileRoot, FileStat, Located, TextFile, WriteResult } from '../../shared/files-types.js';
import { createFileQueue } from '../atomic-file.js';
import { HostError } from '../host-connection.js';
import { FilesDeniedError, type RootsRegistry } from '../roots.js';

/** Предел путей в одном вызове `files.stat` и `files.locate` (таблица чисел плана). */
export const MAX_PATHS_PER_CALL = 200;

/** Файл в редакторе: до 2 МБ — правка, 2–20 МБ — только чтение, больше — не открывается (таблица чисел). */
export const LIMITS = { editableBytes: 2 * 1024 * 1024, openableBytes: 20 * 1024 * 1024 } as const;

/** Сколько байт от начала смотрит `detectText` в поисках NUL — как git. */
const BINARY_PROBE_BYTES = 8192;

/** Имена, которые дерево не показывает в любом регистре: git и карты core (`.harnas/`) — не для правки из окна. */
const HIDDEN_NAMES = new Set(['.git', '.harnas']);

export interface FsApi {
  stat(root: FileRoot, paths: string[]): Promise<Array<FileStat | null>>;
  locate(workKey: string, absPaths: string[]): Promise<Array<Located | null>>;
  list(root: FileRoot, dir: string): Promise<DirEntry[]>;
  readText(root: FileRoot, path: string): Promise<TextFile>;
  readBytes(root: FileRoot, path: string, limit?: number): Promise<Uint8Array>;
  write(root: FileRoot, path: string, text: string, expectedMtimeMs: number | null): Promise<WriteResult>;
}

export interface FsApiOptions {
  /** Случайная часть имени временного файла записи; подменяют тесты. */
  random?: () => string;
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** NUL в первых 8 КБ — двоичный; UTF-8 — строгой проверкой всего буфера. */
export function detectText(buffer: Buffer): { binary: boolean; utf8: boolean } {
  return { binary: buffer.subarray(0, BINARY_PROBE_BYTES).includes(0), utf8: isUtf8(buffer) };
}

/**
 * open(O_RDONLY | O_NONBLOCK), затем fstat().isFile(); не обычный файл — HostError('bad_request'),
 * дескриптор закрыт. Без O_NONBLOCK `open()` FIFO агента висит в пуле потоков libuv (их четыре), и
 * несколько таких чтений остановили бы все `fs` main, включая запись `ui.json` и `layouts.json`.
 */
export async function openRegularFile(absPath: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(absPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    // Файл удалили между resolve и open — для окна это «нет файла», а не сбой.
    if (errorCode(error) === 'ENOENT') throw new HostError('not_found', `no such file: ${absPath}`);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new HostError('bad_request', `not a regular file: ${absPath}`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/** Содержимое обычного файла не больше limit байт, иначе `files:too-large`; с fstat до чтения. */
async function readRegular(absPath: string, limit: number): Promise<{ buffer: Buffer; info: Stats }> {
  const handle = await openRegularFile(absPath);
  try {
    const info = await handle.stat();
    const tooLarge = (): HostError => new HostError('files:too-large', `file exceeds ${limit} bytes: ${absPath}`);
    if (info.size > limit) throw tooLarge();
    const buffer = await handle.readFile();
    // Файл мог вырасти между fstat и чтением.
    if (buffer.length > limit) throw tooLarge();
    return { buffer, info };
  } finally {
    await handle.close();
  }
}

/**
 * Запись по realpath из roots.resolve(…, 'write'): временный файл рядом со случайным
 * именем, open(…, 'wx'), сверка realpath его каталога с каталогом absPath, права прежние
 * (новый файл — 0644), rename. Имя занято или каталог подменён — ошибка, цель не тронута.
 * `writeAtomic` из `atomic-file.ts` не годится: его имя предсказуемо, а `writeFile` идёт по
 * ссылке — подложенный заранее симлинк увёл бы запись наружу.
 */
export async function writeAtomicPreservingMode(
  absPath: string,
  text: string,
  random: () => string = () => randomBytes(4).toString('hex'),
): Promise<number> {
  const folder = path.dirname(absPath);
  const tmp = path.join(folder, `.${path.basename(absPath)}.${random()}.harnas-tmp`);
  let handle: FileHandle | null;
  try {
    // 'wx' — O_CREAT | O_EXCL: на занятом имени, в том числе симлинке, — EEXIST, по ссылке не идёт.
    handle = await open(tmp, 'wx', 0o600);
  } catch (error) {
    // Чужой файл по этому имени не удаляем: он не наш.
    if (errorCode(error) === 'EEXIST') throw new FilesDeniedError(`temporary name taken: ${tmp}`);
    throw error;
  }
  try {
    // Промежуточные звенья `open` проходит по ссылкам: агент мог между resolve и open
    // заменить каталог ссылкой наружу. Подмена между этой сверкой и rename — остаточный
    // риск спеки 10.8.
    if ((await realpath(folder)) !== folder) throw new FilesDeniedError(`parent directory changed: ${folder}`);
    let mode = 0o644;
    try {
      mode = (await fsStat(absPath)).mode & 0o777;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    await handle.writeFile(text, 'utf8');
    await handle.chmod(mode);
    // mtime — со своего дескриптора, а не stat цели после rename: запись агента сразу после
    // нашей иначе выдала бы себя за эхо нашей и потерялась бы для окна.
    const { mtimeMs } = await handle.stat();
    await handle.close();
    handle = null;
    await rename(tmp, absPath);
    return mtimeMs;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** `stat` по realpath: FIFO, сокеты и прочие не-файлы окну не нужны — `null`, как отсутствующий путь. */
async function statReal(real: string): Promise<FileStat | null> {
  const info = await fsStat(real);
  if (info.isDirectory()) return { kind: 'dir', size: info.size, mtimeMs: info.mtimeMs };
  if (info.isFile()) return { kind: 'file', size: info.size, mtimeMs: info.mtimeMs };
  return null;
}

export function createFsApi(roots: RootsRegistry, options: FsApiOptions = {}): FsApi {
  const statOne = async (root: FileRoot, relPath: string): Promise<FileStat | null> => {
    try {
      return await statReal(await roots.resolve(root, relPath, 'read'));
    } catch {
      // Нет файла и путь вне корня для окна одинаковы: ссылкой он не станет.
      return null;
    }
  };

  /** Вид цели симлинка, если её realpath внутри корня; иначе (наружу, висячая, не файл и не папка) — null. */
  const linkTarget = async (root: FileRoot, relPath: string): Promise<'file' | 'dir' | null> => {
    try {
      return (await statReal(await roots.resolve(root, relPath, 'read')))?.kind ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Порядок вызовов write до очереди файла: resolve асинхронный, и без общей очереди вторая
   * запись могла бы встать в очередь файла раньше первой.
   */
  const order = createFileQueue();
  /** Очередь на realpath: сверка mtime и запись одного файла — по одной (⌘S дважды, две работы проекта). */
  const queues = new Map<string, { run: ReturnType<typeof createFileQueue>; pending: number }>();
  const enqueue = <T>(real: string, operation: () => Promise<T>): Promise<T> => {
    let slot = queues.get(real);
    if (slot === undefined) {
      slot = { run: createFileQueue(), pending: 0 };
      queues.set(real, slot);
    }
    const current = slot;
    current.pending += 1;
    const result = current.run(operation);
    const release = (): void => {
      current.pending -= 1;
      if (current.pending === 0 && queues.get(real) === current) queues.delete(real);
    };
    result.then(release, release);
    return result;
  };

  const writeChecked = async (real: string, text: string, expectedMtimeMs: number | null): Promise<WriteResult> => {
    let current: Stats | null;
    try {
      current = await fsStat(real);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      current = null;
    }
    if (current !== null && !current.isFile()) throw new HostError('bad_request', `not a regular file: ${real}`);
    if (expectedMtimeMs === null) {
      // «Файла быть не должно»: его успел создать агент — не перетираем молча.
      if (current !== null) return { ok: false, conflict: { mtimeMs: current.mtimeMs } };
    } else {
      // Ждали файл, а его нет: у conflict нет mtime — окно само покажет «удалён на диске».
      if (current === null) throw new HostError('not_found', `no such file: ${real}`);
      if (current.mtimeMs !== expectedMtimeMs) return { ok: false, conflict: { mtimeMs: current.mtimeMs } };
    }
    return { ok: true, mtimeMs: await writeAtomicPreservingMode(real, text, options.random) };
  };

  return {
    stat: (root, paths) => Promise.all(paths.map((relPath) => statOne(root, relPath))),
    locate: (workKey, absPaths) =>
      Promise.all(
        absPaths.map(async (absPath): Promise<Located | null> => {
          const found = await roots.locate(workKey, absPath);
          if (found === null) return null;
          const stat = await statOne(found.root, found.relPath);
          return stat === null ? null : { root: found.root, relPath: found.relPath, stat };
        }),
      ),

    list: async (root, dir) => {
      const real = await roots.resolve(root, dir, 'read');
      let names: string[];
      try {
        names = await readdir(real);
      } catch (error) {
        if (errorCode(error) === 'ENOTDIR') throw new HostError('bad_request', `not a directory: ${dir}`);
        if (errorCode(error) === 'ENOENT') throw new HostError('not_found', `no such directory: ${dir}`);
        throw error;
      }
      const entries = await Promise.all(
        names
          .filter((name) => !HIDDEN_NAMES.has(name.toLowerCase()))
          .map(async (name): Promise<DirEntry | null> => {
            let info: Stats;
            try {
              info = await lstat(path.join(real, name));
            } catch {
              // Запись исчезла между readdir и lstat.
              return null;
            }
            const base = { name, size: info.size, mtimeMs: info.mtimeMs, ignored: false };
            if (info.isFile()) return { ...base, kind: 'file', target: null };
            if (info.isDirectory()) return { ...base, kind: 'dir', target: null };
            if (info.isSymbolicLink()) return { ...base, kind: 'symlink', target: await linkTarget(root, path.join(dir, name)) };
            // FIFO, сокеты и устройства дерево не показывает.
            return null;
          }),
      );
      return entries.filter((entry): entry is DirEntry => entry !== null);
    },

    readText: async (root, relPath) => {
      const { buffer, info } = await readRegular(await roots.resolve(root, relPath, 'read'), LIMITS.openableBytes);
      const { binary, utf8 } = detectText(buffer);
      return {
        // Не UTF-8 — всё равно текст для просмотра: битые байты станут U+FFFD, правка закрыта.
        text: buffer.toString('utf8'),
        mtimeMs: info.mtimeMs,
        size: buffer.length,
        binary,
        utf8,
        readOnlyReason: buffer.length > LIMITS.editableBytes ? 'too-large' : utf8 ? null : 'not-utf8',
      };
    },

    readBytes: async (root, relPath, limit = LIMITS.openableBytes) =>
      (await readRegular(await roots.resolve(root, relPath, 'read'), limit)).buffer,

    write: async (root, relPath, text, expectedMtimeMs) => {
      // Обёртка { done }: промис из операции очереди иначе дождался бы и записи, и очередь
      // порядка держала бы все файлы разом.
      const { done } = await order(async () => {
        const real = await roots.resolve(root, relPath, 'write');
        return { done: enqueue(real, () => writeChecked(real, text, expectedMtimeMs)) };
      });
      return done;
    },
  };
}
