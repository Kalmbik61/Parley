import { describe, expect, it } from 'vitest';
import type { RoomUsage, RoomUsageMember, UsageSummary, UsageTotal } from '@parley/core';
import { createUsageLabels, memberMarks, usageChipText, usageMarkdown, usageMarks } from './usage-format.js';

const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  input: 500_000,
  output: 30_000,
  cacheRead: 5_200_000,
  cacheWrite: 180_000,
  totalInput: 5_880_000,
  source: 'native-index',
  observedAt: '2026-10-14T11:00:00.000Z',
  stale: false,
  completeness: 'complete',
  coverage: 'conversation',
  ...over,
});

const total = (over: Partial<UsageTotal> = {}): UsageTotal => ({
  input: 1_200_000,
  output: 84_000,
  cacheRead: 9_100_000,
  cacheWrite: null,
  totalInput: null,
  completeness: 'complete',
  stale: false,
  coverage: 'conversation',
  conversations: 2,
  ...over,
});

const member = (over: Partial<RoomUsageMember> = {}): RoomUsageMember => ({
  sessionId: 's-01',
  provider: 'claude',
  lead: false,
  periods: [{ from: '2026-10-14T10:00:00.000Z', to: null }],
  current: true,
  status: 'counted',
  reason: null,
  method: 'whole-session',
  usage: summary(),
  sharedWith: [],
  ...over,
});

const labels = createUsageLabels(
  [
    { id: 's-01', label: 'Planner' },
    { id: 's-04', label: 'Tests | e2e' },
  ],
  [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
  ],
);

describe('usage-format (спека расхода токенов, 3)', () => {
  it('значок: числа, неизвестное — ?, нижняя граница — с ≥', () => {
    expect(usageChipText({ input: 1_200_000, output: 84_000, completeness: 'complete' })).toBe('↑1.2M ↓84k');
    expect(usageChipText({ input: null, output: 0, completeness: 'complete' })).toBe('↑? ↓0');
    expect(usageChipText({ input: 10, output: 2, completeness: 'partial' })).toBe('≥ ↑10 ↓2');
  });

  it('пометки итога сессии: n/a, snapshot, stale, partial', () => {
    expect(usageMarks(summary())).toEqual([]);
    expect(usageMarks(summary({ source: 'unavailable' }))).toEqual(['n/a']);
    expect(usageMarks(summary({ source: 'frozen-snapshot', stale: true, completeness: 'partial' }))).toEqual(['snapshot', 'stale', 'partial']);
  });

  it('пометки строки участника', () => {
    expect(memberMarks(member({ status: 'not-started', usage: null }))).toEqual(['not started']);
    expect(memberMarks(member({ status: 'unavailable', reason: 'log-missing', usage: null }))).toEqual(['n/a — log not found']);
    expect(memberMarks(member({ status: 'unavailable', reason: 'deleted', usage: null, provider: null }))).toEqual(['n/a — session deleted']);
    const left = memberMarks(member({ current: false, periods: [{ from: '2026-10-14T10:00:00.000Z', to: '2026-10-14T11:40:00.000Z' }] }));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^left \d/);
    expect(memberMarks(member({ sharedWith: ['r-02'] }))).toEqual(['shared with r-02']);
  });

  it('подписи: номер и название сессии, ведущий, провайдер; удалённая — только номер', () => {
    expect(labels.member(member({ lead: true }))).toBe('S01 Planner · lead · Claude');
    expect(labels.member(member({ sessionId: 's-09', provider: null }))).toBe('S09');
    expect(labels.provider('glm')).toBe('glm');
  });

  it('Markdown: заголовок, время, итог с пометкой, провайдеры при двух и больше, участники, примечания; | экранируется', () => {
    const usage: RoomUsage = {
      roomId: 'r-03',
      computedAt: '2026-10-14T12:03:00.000Z',
      reconstructed: true,
      total: total({ completeness: 'partial' }),
      byProvider: [
        { provider: 'claude', total: total({ input: 900_000 }) },
        { provider: 'codex', total: total({ input: 300_000 }) },
      ],
      members: [
        member({ lead: true }),
        member({ sessionId: 's-04', provider: 'codex', usage: summary({ completeness: 'partial', cacheWrite: null }) }),
        member({ sessionId: 's-05', status: 'unavailable', reason: 'log-missing', usage: null }),
      ],
    };
    const text = usageMarkdown(usage, 'Payment refactor', labels).split('\n');
    expect(text[0]).toBe('**Room “Payment refactor” (r-03) — token usage**');
    expect(text[1]).toMatch(/^Since each member joined · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(text).toContain('| | In | Out | Cache read | Cache write |');
    expect(text).toContain('| **Total** (partial) | 1.2M | 84k | 9.1M | ? |');
    expect(text).toContain('| Claude | 900k | 84k | 9.1M | ? |');
    expect(text).toContain('| S01 Planner · lead · Claude | 500k | 30k | 5.2M | 180k |');
    expect(text).toContain('| S04 Tests \\| e2e · Codex (partial) | 500k | 30k | 5.2M | ? |');
    expect(text).toContain('| S05 · Claude (n/a — log not found) | ? | ? | ? | ? |');
    expect(text).toContain('Tokens, not money or plan limit. Providers count tokens differently. `?` — not reported.');
    expect(text).toContain('Membership before usage tracking is partly reconstructed.');
  });

  it('Markdown: один провайдер — строк провайдеров нет', () => {
    const usage: RoomUsage = {
      roomId: 'r-01',
      computedAt: '2026-10-14T12:03:00.000Z',
      reconstructed: false,
      total: total(),
      byProvider: [{ provider: 'claude', total: total() }],
      members: [member()],
    };
    const text = usageMarkdown(usage, 'r', labels);
    expect(text).not.toContain('| Claude |');
    expect(text).not.toContain('reconstructed');
  });
});
