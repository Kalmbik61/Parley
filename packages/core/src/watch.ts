import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import { defaultRoot, discoverSession, sessionFileForPath } from './discover.js';
import { indexSessionFile, type SessionIndex } from './session-index.js';

export type SessionChange =
  { kind: 'updated'; file: string; session: SessionIndex } | { kind: 'removed'; file: string };

export interface WatchOptions {
  root?: string;
  /** Claude Code дописывает файл пачками — склеиваем всплеск событий в одно. */
  debounceMs?: number;
  adapter?: SchemaAdapter;
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

/**
 * Следит за ~/.claude/projects и на каждое изменение перечитывает ТОЛЬКО задетую
 * сессию. Изменение файла субагента поднимается к родительской сессии — подсессии
 * лежат в отдельных файлах (см. specs/data-layer.md).
 *
 * Рекурсивный fs.watch поддержан на macOS и Windows; на Linux — начиная с Node 20.
 */
export function watchSessions(
  onChange: (change: SessionChange) => void,
  { root = defaultRoot(), debounceMs = 300, adapter = adapterV1, onError }: WatchOptions = {},
): SessionWatcher {
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;
  let watcher: FSWatcher;

  const reparse = async (file: string): Promise<void> => {
    timers.delete(file);
    if (closed) return;

    try {
      if (!(await exists(file))) {
        onChange({ kind: 'removed', file });
        return;
      }
      const discovered = await discoverSession(file, root);
      const session = await indexSessionFile(file, root, {
        adapter,
        subsessionCount: discovered.subagents.length,
      });
      if (!closed) onChange({ kind: 'updated', file, session });
    } catch (error) {
      onError?.(error, file);
    }
  };

  const schedule = (file: string): void => {
    const pending = timers.get(file);
    if (pending) clearTimeout(pending);
    timers.set(
      file,
      setTimeout(() => void reparse(file), debounceMs),
    );
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name === null) return;
      const file = sessionFileForPath(path.join(root, name.toString()), root);
      if (file !== null) schedule(file);
    });
  } catch (error) {
    onError?.(error, root);
    return { close: () => {} };
  }

  watcher.on('error', (error) => onError?.(error, root));

  return {
    close(): void {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      watcher.close();
    },
  };
}
