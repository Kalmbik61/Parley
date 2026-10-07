import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './unified-diff.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '@@ -10 +10,2 @@',
  ' tail',
  '+added',
  '\\ No newline at end of file',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('хунки с началом и длиной; длина по умолчанию 1; служебные строки пропущены', () => {
    const { hunks, truncated } = parseUnifiedDiff(DIFF);
    expect(truncated).toBe(false);
    expect(hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [' tail', '+added'] },
    ]);
  });
  it('строк больше предела — хвост отброшен, truncated', () => {
    const { hunks, truncated } = parseUnifiedDiff(DIFF, 3);
    expect(truncated).toBe(true);
    expect(hunks.flatMap((hunk) => hunk.lines)).toHaveLength(3);
  });
  it('пустой дифф — нет хунков', () => {
    expect(parseUnifiedDiff('')).toEqual({ hunks: [], truncated: false });
  });
});
