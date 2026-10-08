/**
 * Unified diff (`FileChange.changes[путь].unified_diff` журнала Codex) в хунки ленты (`FeedPatchHunk`). Заголовки
 * файла до первого хунка и «\ No newline at end of file» пропускаются; строк больше предела — хвост отброшен.
 */

import { FEED_PATCH_LINES, type FeedPatchHunk } from '../types.js';

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string, limit: number = FEED_PATCH_LINES): { hunks: FeedPatchHunk[]; truncated: boolean } {
  const hunks: FeedPatchHunk[] = [];
  let current: FeedPatchHunk | null = null;
  let count = 0;
  for (const line of diff.split('\n')) {
    const header = HEADER.exec(line);
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    const mark = line[0];
    if (mark !== ' ' && mark !== '-' && mark !== '+') continue;
    if (count >= limit) return { hunks, truncated: true };
    current.lines.push(line);
    count += 1;
  }
  return { hunks, truncated: false };
}
