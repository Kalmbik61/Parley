import type { SchemaAdapter } from './adapter-v1.js';
import { extendCodexSessionIndex, type CodexIndexState } from './codex/index-session.js';
import type { DiscoveredSubagent } from './discover.js';
import { DEFAULT_TIMELINE_READER, isMissingFile, type TimelineReader } from './jsonl-tail.js';
import { extendClaudeSessionIndex, type ClaudeIndexState, type SessionIndex } from './session-index.js';

/** Сколько файлов держит индексатор (LRU): столько же, сколько шкал расхода у индекса логов хоста. */
export const SESSION_INDEXER_MAX_FILES = 256;

export interface SessionIndexerOptions {
  maxFiles?: number;
  /** Чтение логов; в тестах подменяется, чтобы видеть, что и сколько читали. */
  reader?: TimelineReader;
}

export interface SessionIndexer {
  /**
   * SessionIndex файла Claude: первый вызов читает файл целиком, следующие — только дописанное. `adapter` и
   * `subagents` берутся из вызова, который запустил чтение (одновременные вызовы по одному файлу делят его).
   */
  claude(
    file: string,
    root: string,
    options?: { adapter?: SchemaAdapter; subagents?: DiscoveredSubagent[]; subsessionCount?: number },
  ): Promise<SessionIndex>;
  /** SessionIndex rollout-лога Codex: так же, дочитыванием. */
  codex(file: string): Promise<SessionIndex>;
}

/**
 * Кэш состояний индексации по файлам: живой лог перечитывается хвостом, а не целиком. Одно дочитывание файла
 * в полёте — одновременные вызовы получают общий промис. Упавшее чтение не остаётся «в полёте» и сохранённого
 * состояния не трогает; «файла нет» его забывает.
 */
export function createSessionIndexer({
  maxFiles = SESSION_INDEXER_MAX_FILES,
  reader = DEFAULT_TIMELINE_READER,
}: SessionIndexerOptions = {}): SessionIndexer {
  const states = new Map<string, unknown>();
  const running = new Map<string, Promise<SessionIndex>>();

  const extend = <State>(
    key: string,
    step: (previous: State | null) => Promise<{ state: State; index: SessionIndex }>,
  ): Promise<SessionIndex> => {
    const inFlight = running.get(key);
    if (inFlight !== undefined) return inFlight;
    const run = (async (): Promise<SessionIndex> => {
      try {
        const { state, index } = await step((states.get(key) as State | undefined) ?? null);
        states.delete(key);
        states.set(key, state);
        if (states.size > maxFiles) states.delete(states.keys().next().value as string);
        return index;
      } catch (error) {
        if (isMissingFile(error)) states.delete(key);
        throw error;
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, run);
    return run;
  };

  return {
    claude: (file, root, options = {}) =>
      extend<ClaudeIndexState>(`claude\u0000${file}`, (previous) =>
        extendClaudeSessionIndex(previous, file, root, { ...options, reader }),
      ),
    codex: (file) =>
      extend<CodexIndexState>(`codex\u0000${file}`, (previous) => extendCodexSessionIndex(previous, file, { reader })),
  };
}
