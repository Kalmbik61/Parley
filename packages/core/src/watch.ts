import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import { assistantCwd, defaultRoot, discoverSession, sessionFileForPath } from './discover.js';
import { defaultCodexRoot } from './codex/discover.js';
import { indexCodexSession } from './codex/index-session.js';
import { defaultQwenRoot, isQwenTranscriptPath } from './qwen/discover.js';
import { indexQwenSession } from './qwen/index-session.js';
import { indexSessionFile, type SessionIndex } from './session-index.js';
import type { SessionIndexer } from './session-indexer.js';

export type SessionChange =
  { kind: 'updated'; file: string; session: SessionIndex } | { kind: 'removed'; file: string };

/** Один каталог с историей: как понять, чья сессия изменилась, и как её перечитать. */
export interface WatchSource {
  root: string;
  /** Путь изменившегося файла → файл сессии, которую надо перечитать. */
  resolve(changedPath: string, root: string): string | null;
  /** `null` — файл не сессия Parley, изменение пропускается. */
  index(file: string, root: string): Promise<SessionIndex | null>;
}

export interface WatchOptions {
  /** Claude Code дописывает файл пачками — склеиваем всплеск событий в одно. */
  debounceMs?: number;
  /**
   * Не чаще одного перечитывания файла за это время. Перечитывание — полный разбор файла, у живой сессии это
   * десятки-сотни МБ: при записи каждые пару секунд один debounce не помогает, разбор шёл бы после каждой.
   * Первое изменение после паузы по-прежнему ждёт только `debounceMs`.
   */
  minIntervalMs?: number;
  /**
   * Потолок ожидания: перечитывание не позже этого срока от первого события пачки (но не раньше `minIntervalMs`
   * от прошлого). Без него непрерывная запись сдвигает debounce бесконечно.
   */
  maxWaitMs?: number;
  /** Сбой ре-парса не должен ронять watcher; по умолчанию тихо игнорируется. */
  onError?: (error: unknown, file: string) => void;
}

export interface SessionWatcher {
  close(): void;
  /** Перечитать файлы, чьи размер или mtime изменились с последнего перечитывания, и ещё не перечитанные. */
  rescan(files: readonly string[]): void;
}

export const WATCH_MAX_WAIT_MS = 5_000;
export const WATCH_RECREATE_MS = 1_000;
export const WATCH_RECREATE_MAX_MS = 60_000;

/**
 * Источник Claude Code: подсессии лежат в соседних файлах и поднимаются к родителю. С `indexer` живой файл
 * дочитывается хвостом, без него — полное чтение.
 */
export function claudeSource(
  root: string = defaultRoot(),
  adapter: SchemaAdapter = adapterV1,
  indexer?: SessionIndexer,
): WatchSource {
  return {
    root,
    resolve: sessionFileForPath,
    async index(file, sourceRoot) {
      const discovered = await discoverSession(file, sourceRoot);
      const options = { adapter, subagents: discovered.subagents };
      return indexer === undefined ? indexSessionFile(file, sourceRoot, options) : indexer.claude(file, sourceRoot, options);
    },
  };
}

/** Источник Codex: один rollout-файл — одна сессия, вложенности нет. С `indexer` файл дочитывается хвостом. */
export function codexSource(root: string = defaultCodexRoot(), indexer?: SessionIndexer): WatchSource {
  return {
    root,
    resolve: (changedPath, sourceRoot) => {
      const relative = path.relative(sourceRoot, changedPath);
      if (relative.startsWith('..') || !relative.endsWith('.jsonl')) return null;
      return changedPath;
    },
    index: async (file) => {
      const session = await (indexer === undefined ? indexCodexSession(file) : indexer.codex(file));
      // Ход помощника (спека 2026-10-14, 15.6) — не сессия Parley.
      return session.cwd === assistantCwd() ? null : session;
    },
  };
}

/** Qwen Code source: `<qwenHome>/projects/*\/chats/<uuid>.jsonl`, one file per session. */
export function qwenSource(root: string = defaultQwenRoot(), indexer?: SessionIndexer): WatchSource {
  return {
    root,
    resolve: (changedPath, sourceRoot) => (isQwenTranscriptPath(changedPath, sourceRoot) ? changedPath : null),
    index: async (file) => {
      const session = await (indexer === undefined ? indexQwenSession(file) : indexer.qwen(file));
      return session.cwd === assistantCwd() ? null : session;
    },
  };
}

/**
 * Следит за каталогами истории и на каждое изменение перечитывает ТОЛЬКО задетую
 * сессию. Источников может быть несколько — по одному на провайдера.
 *
 * Рекурсивный fs.watch поддержан на macOS и Windows; на Linux — начиная с Node 20.
 */
export function watchSessions(
  onChange: (change: SessionChange) => void,
  sources: WatchSource[],
  { debounceMs = 300, minIntervalMs = 0, maxWaitMs = WATCH_MAX_WAIT_MS, onError }: WatchOptions = {},
): SessionWatcher {
  const timers = new Map<string, NodeJS.Timeout>();
  const lastRun = new Map<string, number>();
  /** Время первого события текущей пачки; снимается перечитыванием. */
  const firstAt = new Map<string, number>();
  /** Подпись `размер:mtime` файла при последнем удачном перечитывании. */
  const seen = new Map<string, string>();
  const watchers = new Set<FSWatcher>();
  const recreateTimers = new Set<NodeJS.Timeout>();
  let closed = false;

  const reparse = async (source: WatchSource, file: string): Promise<void> => {
    timers.delete(file);
    firstAt.delete(file);
    if (closed) return;
    lastRun.set(file, Date.now());

    try {
      let signature: string;
      try {
        const info = await stat(file);
        signature = `${info.size}:${info.mtimeMs}`;
      } catch {
        seen.delete(file);
        onChange({ kind: 'removed', file });
        return;
      }
      const session = await source.index(file, source.root);
      seen.set(file, signature);
      if (session === null) return;
      if (!closed) onChange({ kind: 'updated', file, session });
    } catch (error) {
      onError?.(error, file);
    }
  };

  const schedule = (source: WatchSource, file: string): void => {
    const pending = timers.get(file);
    if (pending) clearTimeout(pending);
    const now = Date.now();
    const first = firstAt.get(file) ?? now;
    firstAt.set(file, first);
    const earliest = (lastRun.get(file) ?? 0) + minIntervalMs;
    const due = Math.min(Math.max(now + debounceMs, earliest), Math.max(first + maxWaitMs, earliest));
    timers.set(
      file,
      setTimeout(() => void reparse(source, file), Math.max(0, due - now)),
    );
  };

  const attach = (source: WatchSource, failures: number, recreating: boolean): void => {
    try {
      const watcher = watch(source.root, { recursive: true }, (_event, name) => {
        if (name === null) return;
        const file = source.resolve(path.join(source.root, name.toString()), source.root);
        if (file !== null) schedule(source, file);
      });
      watchers.add(watcher);
      watcher.on('error', (error) => {
        onError?.(error, source.root);
        try {
          watcher.close();
        } catch {
          // уже закрыт
        }
        watchers.delete(watcher);
        if (closed) return;
        const timer = setTimeout(
          () => {
            recreateTimers.delete(timer);
            if (!closed) attach(source, 0, true);
          },
          WATCH_RECREATE_MS,
        );
        timer.unref();
        recreateTimers.add(timer);
      });
    } catch (error) {
      // Каталога может не быть: Codex просто не установлен — это не повод падать.
      onError?.(error, source.root);
      if (!recreating || closed) return;
      // Пересоздание не удалось: пауза удваивается до потолка.
      const pause = Math.min(WATCH_RECREATE_MS * 2 ** (failures + 1), WATCH_RECREATE_MAX_MS);
      const timer = setTimeout(() => {
        recreateTimers.delete(timer);
        if (!closed) attach(source, failures + 1, true);
      }, pause);
      timer.unref();
      recreateTimers.add(timer);
    }
  };

  for (const source of sources) attach(source, 0, false);

  return {
    close(): void {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const timer of recreateTimers) clearTimeout(timer);
      recreateTimers.clear();
      for (const watcher of watchers) watcher.close();
      watchers.clear();
    },
    rescan(files): void {
      if (closed) return;
      for (const file of files) {
        const source = sources.find((candidate) => candidate.resolve(file, candidate.root) === file);
        if (source === undefined || timers.has(file)) continue;
        void stat(file).then(
          (info) => {
            if (closed || timers.has(file)) return;
            if (seen.get(file) !== `${info.size}:${info.mtimeMs}`) schedule(source, file);
          },
          () => {
            if (closed || timers.has(file)) return;
            if (seen.has(file)) schedule(source, file);
          },
        );
      }
    },
  };
}
