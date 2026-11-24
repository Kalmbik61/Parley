import path from 'node:path';
import { Counter, oneLine } from '../counters.js';
import { reuseOrIndex, type IndexReuse } from '../index-reuse.js';
import { forEachJsonlRecord, type RawRecord } from '../jsonl.js';
import { DEFAULT_TIMELINE_READER, readJsonlTail, type TailCursor, type TimelineReader } from '../jsonl-tail.js';
import { INDEX_READ_CONCURRENCY, mapLimited } from '../map-limited.js';
import { missingFileError, type SessionIndex } from '../session-index.js';
import { assistantCwd } from '../discover.js';
import { defaultQwenRoot, discoverQwenSessions } from './discover.js';

const isObject = (value: unknown): value is RawRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: RawRecord | null | undefined, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** Index of one Qwen Code transcript (spec §3.5). Usage and limits are not read for qwen in v1: `tokens` is `null`. */
export class QwenIndexAccumulator {
  models = new Counter();
  tools = new Counter();
  roles = new Counter();
  recordTypes = new Counter();
  id: string | null = null;
  cwd: string | null = null;
  version: string | null = null;
  startedAt: string | null = null;
  endedAt: string | null = null;
  firstUserMessage: string | null = null;
  lastUserRecordAt: string | null = null;
  lastWorkRecordAt: string | null = null;
  parsed = 0;
  malformed = 0;

  feed(raw: RawRecord): void {
    const type = str(raw, 'type');
    this.recordTypes.add(type);
    this.id ??= str(raw, 'sessionId');
    this.cwd ??= str(raw, 'cwd');
    this.version ??= str(raw, 'version');
    const at = str(raw, 'timestamp');
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.endedAt === null || at > this.endedAt) this.endedAt = at;
    }
    const message = isObject(raw['message']) ? raw['message'] : null;
    const parts = Array.isArray(message?.['parts']) ? (message['parts'] as unknown[]).filter(isObject) : [];
    if (type === 'user' && str(raw, 'provenance') === 'real_user') {
      this.roles.add('user');
      this.firstUserMessage ??= parts.map((part) => str(part, 'text') ?? '').filter((text) => text !== '').join('\n') || null;
      if (at !== null && (this.lastUserRecordAt === null || at > this.lastUserRecordAt)) this.lastUserRecordAt = at;
    }
    if (type === 'user' || type === 'assistant' || type === 'tool_result') {
      if (at !== null && (this.lastWorkRecordAt === null || at > this.lastWorkRecordAt)) this.lastWorkRecordAt = at;
    }
    if (type === 'assistant') {
      this.roles.add('assistant');
      this.models.add(str(raw, 'model'));
      for (const part of parts) {
        const call = isObject(part['functionCall']) ? part['functionCall'] : null;
        if (call === null) continue;
        const args = isObject(call['args']) ? call['args'] : null;
        const outer = str(call, 'name');
        this.tools.add(outer === 'tool_call' ? (str(args, 'name') ?? outer) : outer);
      }
    }
  }

  build(file: string, { pendingMalformed = false }: { pendingMalformed?: boolean } = {}): SessionIndex {
    const { cwd, startedAt, endedAt, firstUserMessage } = this;
    const title = firstUserMessage === null ? null : oneLine(firstUserMessage);
    return {
      id: this.id ?? path.basename(file, '.jsonl'),
      // The directory name is a lossy cwd encoding: the project name comes from the records' cwd.
      project: cwd === null ? '—' : path.basename(cwd),
      projectPath: cwd,
      cwd,
      gitBranch: null,
      version: this.version,
      file,
      title,
      titleSource: title === null ? null : 'first-text',
      startedAt,
      endedAt,
      lastUserRecordAt: this.lastUserRecordAt,
      lastInterruptAt: null,
      lastWorkRecordAt: this.lastWorkRecordAt,
      durationMs: startedAt !== null && endedAt !== null ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
      records: this.parsed,
      malformedLines: this.malformed + (pendingMalformed ? 1 : 0),
      models: this.models.toObject(),
      tools: this.tools.toObject(),
      roles: this.roles.toObject(),
      recordTypes: this.recordTypes.toObject(),
      primaryModel: this.models.top(),
      subsessionCount: 0,
      tokens: null,
      provider: 'qwen',
    };
  }
}

export async function indexQwenSession(file: string, signal?: AbortSignal): Promise<SessionIndex> {
  const acc = new QwenIndexAccumulator();
  const stats = await forEachJsonlRecord(file, (raw) => acc.feed(raw), signal);
  acc.parsed = stats.parsed;
  acc.malformed = stats.malformed;
  return acc.build(file);
}

export interface QwenIndexState {
  acc: QwenIndexAccumulator;
  cursor: TailCursor;
}

/**
 * Like `indexQwenSession`, but reads only what was appended since `previous` (a partial last line stays unconsumed
 * until it is finished) and returns the index of the whole current content. A shorter or replaced file starts over.
 */
export async function extendQwenSessionIndex(
  previous: QwenIndexState | null,
  file: string,
  { reader = DEFAULT_TIMELINE_READER }: { reader?: TimelineReader } = {},
): Promise<{ state: QwenIndexState; index: SessionIndex }> {
  let draft: QwenIndexAccumulator | null = null;
  let pending: RawRecord[] = [];
  const result = await readJsonlTail(previous?.cursor ?? null, file, reader, {
    reset: () => {
      draft = new QwenIndexAccumulator();
      pending = [];
    },
    record: (raw) => {
      if (draft !== null) (draft as QwenIndexAccumulator).feed(raw);
      else pending.push(raw);
    },
  });
  if (result.missing) throw missingFileError(file);
  const acc = (draft as QwenIndexAccumulator | null) ?? (previous as QwenIndexState).acc;
  for (const raw of pending) acc.feed(raw);
  acc.parsed += result.parsed;
  acc.malformed += result.malformed;
  return { state: { acc, cursor: result.cursor }, index: acc.build(file, { pendingMalformed: result.cursor.pendingMalformed }) };
}

/** Index of all Qwen sessions under `root`, freshest first. */
export async function buildQwenIndex(
  root: string = defaultQwenRoot(),
  signal?: AbortSignal,
  reuse?: IndexReuse,
): Promise<SessionIndex[]> {
  const discovered = await discoverQwenSessions(root);
  const index = await mapLimited(discovered, INDEX_READ_CONCURRENCY, (session) =>
    reuseOrIndex(reuse, [session.file], () => indexQwenSession(session.file, signal)),
  );
  const own = index.filter((session) => session.cwd !== assistantCwd());
  own.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
  return own;
}
