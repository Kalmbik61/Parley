import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { runBench, summarize } from './bench';

describe('bench', () => {
  it('summarize takes the median of an even and an odd sample', () => {
    expect(summarize([3, 1, 2]).median).toBe(2);
    expect(summarize([4, 1, 3, 2])).toEqual({ median: 2.5, min: 1, max: 4, runs: 4 });
  });

  it('runs every case through @parley/noise and reports the verdict', async () => {
    const seen: string[] = [];
    const report = await runBench({ runs: 2, warmup: 0, now: () => performance.now() }, { os: 'node' }, (r) => seen.push(r.id));
    expect(seen).toHaveLength(9);
    expect(report.rows.every((r) => r.median >= 0 && r.runs === 2)).toBe(true);
    expect(report.schema).toBe('parley-mobile-bench/1');
    expect(report.verdict.ok).toBe(true);
  });
});
