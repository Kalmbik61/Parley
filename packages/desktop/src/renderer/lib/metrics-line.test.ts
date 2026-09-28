import { describe, expect, it } from 'vitest';
import type { LiveMetrics } from '@harnas/protocol';
import { formatMetricsLine } from './metrics-line.js';

function metrics(patch: Partial<LiveMetrics> = {}): LiveMetrics {
  return {
    tokensIn: null,
    tokensOut: null,
    durationMs: null,
    unread: 0,
    subagents: 0,
    model: null,
    ...patch,
  };
}

describe('formatMetricsLine', () => {
  it('токенов нет — тире вместо стрелок', () => {
    expect(formatMetricsLine(metrics())).toBe('— · —');
  });

  it('тысячи — с «k», минуты — с «m»', () => {
    const line = formatMetricsLine(metrics({ tokensIn: 1200, tokensOut: 845, durationMs: 12 * 60_000 }));
    expect(line).toBe('↑1.2k ↓845 · 12m');
  });

  it('нулевые ▤ и ⋮ не печатаются', () => {
    const line = formatMetricsLine(metrics({ tokensIn: 100, tokensOut: 0, durationMs: 1000, subagents: 0, unread: 0 }));
    expect(line).not.toContain('▤');
    expect(line).not.toContain('⋮');
  });

  it('ненулевые ▤ и ⋮ печатаются', () => {
    const line = formatMetricsLine(
      metrics({ tokensIn: 1200, tokensOut: 845, durationMs: 12 * 60_000, subagents: 1, unread: 1 }),
    );
    expect(line).toBe('↑1.2k ↓845 · 12m · ▤1 · ⋮1');
  });
});
