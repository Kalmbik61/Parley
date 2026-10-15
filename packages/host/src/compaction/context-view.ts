/**
 * Что окно видит о контексте сессии (спека 2026-10-15, 4.4 и 5.6): пока сжатие ждёт или идёт — фаза и прежняя цифра;
 * после конца сжатия прежняя цифра не показывается, пока не придёт наблюдение новее (`compacted`) — иначе человек
 * увидел бы те же «92 %» и решил бы, что сжатие не сработало.
 */

import type { ContextFill } from '@parley/core';
import type { CompactionPhase } from '@parley/protocol';

/** Что хост знает о сжатии сессии: фаза просьбы и ISO-время конца последнего сжатия. */
export interface CompactionTrack {
  phase: 'pending' | 'running' | null;
  finishedAt: string | null;
}

export function contextView(
  fill: ContextFill | null,
  track: CompactionTrack | undefined,
): { context: ContextFill | null; compaction: CompactionPhase | null } {
  if (track?.phase === 'pending' || track?.phase === 'running') return { context: fill, compaction: track.phase };
  const finished = track?.finishedAt == null ? Number.NaN : Date.parse(track.finishedAt);
  if (!Number.isNaN(finished) && (fill === null || Date.parse(fill.at) < finished)) {
    return { context: null, compaction: 'compacted' };
  }
  return { context: fill, compaction: null };
}
