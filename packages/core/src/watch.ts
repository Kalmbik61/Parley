import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import { defaultRoot, discoverSession, sessionFileForPath } from './discover.js';
import { defaultCodexRoot } from './codex/discover.js';
import { indexCodexSession } from './codex/index-session.js';
import { indexSessionFile, type SessionIndex } from './session-index.js';

export type SessionChange =
  { kind: 'updated'; file: string; session: SessionIndex } | { kind: 'removed'; file: string };

/** Один каталог с историей: как понять, чья сессия изменилась, и как её перечитать. */
export interface WatchSource {
  root: string;
  /** Путь изменившегося файла → файл сессии, которую надо перечитать. */
  resolve(changedPath: string, root: string): string | null;
  index(file: string, root: string): Promise<SessionIndex>;
}

export interface WatchOptions {
  /** Claude Code дописывает файл пачками — склеиваем всплеск событий в одно. */
  debounceMs?: number;
  /** Сбой ре-парса не должен ронять watcher; по умолчанию тихо игнорируется. */
  onError?: (error: unknown, file: string) => void;
}

export interface SessionWatcher {
  close(): void;
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/** Источник Claude Code: подсессии лежат в соседних файлах и поднимаются к родителю. */
export function claudeSource(
  root: string = defaultRoot(),
  adapter: SchemaAdapter = adapterV1,
): WatchSource {
  return {
    root,
    resolve: sessionFileForPath,
    async index(file, sourceRoot) {
      const discovered = await discoverSession(file, sourceRoot);
      return indexSessionFile(file, sourceRoot, { adapter, subagents: discovered.subagents });
    },
  };
}

/** Источник Codex: один rollout-файл — одна сессия, вложенности нет. */
export function codexSource(root: string = defaultCodexRoot()): WatchSource {
  return {
    root,
    resolve: (changedPath, sourceRoot) => {
      const relative = path.relative(sourceRoot, changedPath);
      if (relative.startsWith('..') || !relative.endsWith('.jsonl')) return null;
      return changedPath;
    },
    index: (file) => indexCodexSession(file),
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
  { debounceMs = 300, onError }: WatchOptions = {},
): SessionWatcher {
  const timers = new Map<string, NodeJS.Timeout>();
  const watchers: FSWatcher[] = [];
  let closed = false;

  const reparse = async (source: WatchSource, file: string): Promise<void> => {
    timers.delete(file);
    if (closed) return;

    try {
      if (!(await exists(file))) {
        onChange({ kind: 'removed', file });
        return;
      }
      const session = await source.index(file, source.root);
      if (!closed) onChange({ kind: 'updated', file, session });
    } catch (error) {
      onError?.(error, file);
    }
  };

  const schedule = (source: WatchSource, file: string): void => {
    const pending = timers.get(file);
    if (pending) clearTimeout(pending);
    timers.set(
      file,
      setTimeout(() => void reparse(source, file), debounceMs),
    );
  };

  for (const source of sources) {
    try {
      const watcher = watch(source.root, { recursive: true }, (_event, name) => {
        if (name === null) return;
        const file = source.resolve(path.join(source.root, name.toString()), source.root);
        if (file !== null) schedule(source, file);
      });
      watcher.on('error', (error) => onError?.(error, source.root));
      watchers.push(watcher);
    } catch (error) {
      // Каталога может не быть: Codex просто не установлен — это не повод падать.
      onError?.(error, source.root);
    }
  }

  return {
    close(): void {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) watcher.close();
    },
  };
}
