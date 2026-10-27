import { createHash } from 'node:crypto';
import type { FeedState, FeedTool } from '@parley/core';
import { FEED_PROGRESS_RECENT_LIMIT, progressLine, progressResult, type ProgressLine, type ProgressResult } from '@parley/protocol';

function unavailable(revision: number): ProgressResult {
  return { revision, availability: 'unavailable', current: null, recent: [], truncated: false };
}

function category(name: string): ProgressLine['category'] {
  switch (name) {
    case 'Read': case 'ViewImage': case 'WebFetch': return 'read';
    case 'Edit': case 'Write': case 'Delete': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Bash': return 'execute';
    case 'Glob': case 'Grep': case 'WebSearch': return 'search';
    case 'Agent': case 'Task': return 'delegate';
    default: return 'other';
  }
}

function canonicalTime(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Date.parse нормализует, например, 30 февраля и 24:00; это не валидные source timestamps.
  const day = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value)?.[1];
  if (day !== undefined && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day) return null;
  const hour = /T(\d{2}):/.exec(value)?.[1];
  if (hour !== undefined && Number(hour) > 23) return null;
  const canonical = new Date(time).toISOString();
  return canonical.length === 24 ? canonical : null;
}

/** Только текущий main-tool tail; agent cards/children и содержимое инструментов не проецируются. */
export function projectProgress(state: FeedState | null, revision: number): ProgressResult {
  if (state === null) return unavailable(0);
  if (!Number.isSafeInteger(revision) || revision < 0) return unavailable(0);

  // FeedDraft.put заменяет значение на прежней позиции: Map сохраняет тот же порядок при повторе id.
  const tools = new Map<string, FeedTool>();
  for (const item of state.items) {
    if (item.kind === 'tool' && item.agentId === undefined) tools.set(item.id, item);
  }
  const tail = [...tools.values()].slice(-FEED_PROGRESS_RECENT_LIMIT);
  const recent: ProgressLine[] = [];
  for (const tool of tail) {
    const line = progressLine.safeParse({
      id: createHash('sha256').update(tool.id).digest('hex'),
      at: canonicalTime(tool.at),
      category: category(tool.name),
      status: tool.status,
      ...(tool.endedAt === undefined ? {} : { endedAt: canonicalTime(tool.endedAt) }),
    });
    if (!line.success) return unavailable(revision);
    recent.push(line.data);
  }
  // Общая schema проверяет в том числе unique ids, current и UTF-8 размер целого результата.
  const result = progressResult.safeParse({
    revision,
    availability: 'available',
    current: recent.findLast((line) => line.status === 'running') ?? null,
    recent,
    truncated: tools.size > FEED_PROGRESS_RECENT_LIMIT,
  });
  return result.success ? result.data : unavailable(revision);
}
