/**
 * Слежение за файлами (спека 10.1, 10.5, 13; кусок 7.1b). Файл — `fs.watch` на него и на его
 * папку: замену через `rename` (так пишут редакторы и агенты) видит только папка. Дерево —
 * один `fs.watch(root, { recursive: true })` на открытый корень, общий для всех подписок.
 * События не спамят: файл — дроссель 100 мс и только при смене состояния, дерево — пачка
 * раз в 300 мс без `.git/`, `.harnas/` и `node_modules/` (хуки пишут журнал в `.harnas/` на
 * каждом шаге агента). Сбой запуска — `files:watch-failed`, сбой по ходу — только консоль.
 */
import { randomUUID } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileChangedEvent, FileRoot, TreeChangedEvent } from '../../shared/files-types.js';
import { rootKey } from '../../shared/work-keys.js';
import { HostError } from '../host-connection.js';
import type { RootsRegistry } from '../roots.js';

/** Дроссель событий файла (план). */
export const FILE_THROTTLE_MS = 100;
/** Пачка событий дерева (спека 10.1). */
export const TREE_BATCH_MS = 300;
/** Звенья, изменения под которыми дерево не видит. */
const TREE_IGNORED = new Set(['.git', '.harnas', 'node_modules']);

/** Куда уходят события подписки: окно-владелец. */
export interface WatchSink {
  changed(e: FileChangedEvent): void;
  treeChanged(e: TreeChangedEvent): void;
}

/** Нужное от `fs.FSWatcher`: подставной в тестах. */
export interface WatcherLike {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type WatchFs = (
  target: string,
  options: { recursive?: boolean; persistent?: boolean },
  listener: (event: string, filename: string | null) => void,
) => WatcherLike;

export interface FileWatch {
  /** id подписки; relPath '' — дерево корня. Не запустилось — HostError('files:watch-failed'). */
  watch(root: FileRoot, relPath: string, sink: WatchSink): Promise<string>;
  unwatch(id: string): void;
  isTreeWatched(rootKey: string): boolean;
  closeAll(): void;
}

export interface FileWatchOptions {
  roots: Pick<RootsRegistry, 'resolve' | 'rootPath'>;
  watchFs?: WatchFs;
  /** Дерево корня изменилось или слежение за ним кончилось — сброс кэша `lsFiles`. */
  onTreeInvalidate?: (rootKey: string) => void;
}

interface TreeWatch {
  watcher: WatcherLike;
  sinks: Map<string, WatchSink>;
  dirs: Set<string>;
  timer: NodeJS.Timeout | null;
}

interface FileState {
  deleted: boolean;
  mtimeMs: number;
  size: number;
  ino: number;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}

const defaultWatchFs: WatchFs = (target, options, listener) =>
  fsWatch(target, options, (event, filename) => listener(event, filename === null ? null : String(filename)));

async function stateOf(real: string): Promise<FileState | null> {
  try {
    const info = await stat(real);
    return { deleted: false, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino };
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { deleted: true, mtimeMs: 0, size: 0, ino: 0 };
    console.warn(`[parley] files: watch stat failed: ${real}`, error);
    return null;
  }
}

function sameState(a: FileState, b: FileState): boolean {
  return a.deleted === b.deleted && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

export function createFileWatch(options: FileWatchOptions): FileWatch {
  const watchFs = options.watchFs ?? defaultWatchFs;
  const trees = new Map<string, TreeWatch>();
  /** id → как снять подписку. */
  const subscriptions = new Map<string, () => void>();

  const start = (target: string, recursive: boolean, listener: (filename: string | null) => void): WatcherLike => {
    let watcher: WatcherLike;
    try {
      watcher = watchFs(target, { recursive, persistent: false }, (_event, filename) => listener(filename));
    } catch (error) {
      console.warn(`[parley] files: watch failed: ${target}`, error);
      throw new HostError('files:watch-failed', `cannot watch ${target}: ${codeOf(error)}`);
    }
    watcher.on('error', (error) => console.warn(`[parley] files: watch error: ${target}`, error));
    return watcher;
  };

  const flushTree = (key: string, tree: TreeWatch): void => {
    tree.timer = null;
    const dirs = [...tree.dirs];
    tree.dirs.clear();
    if (dirs.length === 0) return;
    options.onTreeInvalidate?.(key);
    // Одно окно с двумя подписками на корень получает пачку один раз.
    for (const sink of new Set(tree.sinks.values())) sink.treeChanged({ rootKey: key, dirs });
  };

  const watchTree = async (root: FileRoot, sink: WatchSink): Promise<string> => {
    const key = rootKey(root);
    // Реестр отвечает асинхронно (промах — пересборка по works.list): trees читается после
    // ответа, за это время наблюдение корня могли поставить или снять.
    const rootPath = await options.roots.rootPath(root);
    let tree = trees.get(key);
    if (tree === undefined) {
      const created: TreeWatch = { watcher: { close: () => undefined, on: () => undefined }, sinks: new Map(), dirs: new Set(), timer: null };
      created.watcher = start(rootPath, true, (filename) => {
        if (filename === null) {
          created.dirs.add('');
        } else {
          const segments = filename.split(path.sep).filter((s) => s !== '');
          if (segments.some((s) => TREE_IGNORED.has(s.toLowerCase()))) return;
          created.dirs.add(segments.slice(0, -1).join('/'));
        }
        if (created.timer === null) created.timer = setTimeout(() => flushTree(key, created), TREE_BATCH_MS);
      });
      tree = created;
      trees.set(key, tree);
    }
    const id = randomUUID();
    const current = tree;
    current.sinks.set(id, sink);
    subscriptions.set(id, () => {
      current.sinks.delete(id);
      if (current.sinks.size > 0) return;
      current.watcher.close();
      if (current.timer !== null) clearTimeout(current.timer);
      trees.delete(key);
      options.onTreeInvalidate?.(key);
    });
    return id;
  };

  const watchFile = async (root: FileRoot, relPath: string, sink: WatchSink): Promise<string> => {
    const real = await options.roots.resolve(root, relPath, 'read');
    const base = path.basename(real).normalize('NFC');
    const id = randomUUID();
    let last = await stateOf(real);
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    const check = (): void => {
      timer = null;
      void stateOf(real).then((next) => {
        if (closed || next === null) return;
        if (last !== null && sameState(last, next)) return;
        last = next;
        sink.changed({ id, path: relPath, mtimeMs: next.deleted ? null : next.mtimeMs, deleted: next.deleted });
      });
    };
    const poke = (): void => {
      if (!closed && timer === null) timer = setTimeout(check, FILE_THROTTLE_MS);
    };
    const folder = start(path.dirname(real), false, (filename) => {
      if (filename === null || filename.normalize('NFC') === base) poke();
    });
    let own: WatcherLike | null = null;
    try {
      own = start(real, false, () => poke());
    } catch {
      // Папки хватает: она видит и запись, и замену; предупреждение уже в консоли.
    }
    subscriptions.set(id, () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      folder.close();
      own?.close();
    });
    return id;
  };

  return {
    watch: async (root, relPath, sink) => (relPath === '' ? watchTree(root, sink) : watchFile(root, relPath, sink)),
    unwatch: (id) => {
      const stop = subscriptions.get(id);
      if (stop === undefined) return;
      subscriptions.delete(id);
      stop();
    },
    isTreeWatched: (key) => trees.has(key),
    closeAll: () => {
      for (const [id, stop] of [...subscriptions]) {
        subscriptions.delete(id);
        stop();
      }
    },
  };
}
