import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveMetrics } from '@parley/protocol';
import { SessionUsageChip } from './SessionUsageChip.js';

afterEach(cleanup);

const base: LiveMetrics = { tokensIn: 500_000, tokensOut: 30_000, durationMs: null, unread: 0, subagents: 0, model: null };

describe('SessionUsageChip (спека расхода токенов, 3.4)', () => {
  it('значок по usage, поповер — четыре колонки и пометки', () => {
    render(
      <SessionUsageChip
        metrics={{
          ...base,
          usage: {
            input: 500_000,
            output: 30_000,
            cacheRead: 5_200_000,
            cacheWrite: null,
            totalInput: null,
            source: 'frozen-snapshot',
            observedAt: null,
            stale: true,
            completeness: 'complete',
            coverage: 'conversation',
          },
        }}
      />,
    );
    fireEvent.click(screen.getByText('↑500k ↓30k'));
    const popover = screen.getByTestId('chat-usage-popover');
    expect(popover.textContent).toContain('This session, all time');
    expect(popover.textContent).toContain('5.2M');
    expect(popover.textContent).toContain('snapshot · stale');
  });

  it('хост без usage — цифры строки сайдбара; цифр нет вовсе — прочерк', () => {
    const { rerender } = render(<SessionUsageChip metrics={base} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('↑500k ↓30k');
    rerender(<SessionUsageChip metrics={{ ...base, tokensIn: null, tokensOut: null }} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('—');
  });

  describe('расход по отрезкам (спека 2026-10-30, 5.9)', () => {
    const counters = (input: number, output: number) => ({
      input, output, cacheRead: null, cacheWrite: null, totalInput: null, source: 'transcript' as const,
      observedAt: null, stale: false, completeness: 'complete' as const, coverage: 'conversation' as const,
    });
    const at = (hour: number, minute: number): string => new Date(2026, 9, 30, hour, minute).toISOString();
    const segment = (providerLabel: string, model: string | null, from: number, to: number | null, input: number, costUsd: number | null) => ({
      provider: providerLabel.toLowerCase(), providerLabel, model, from: at(from, 0), to: to === null ? null : at(to, 30),
      usage: counters(input, 1_000), costUsd,
    });
    const open = (metrics: LiveMetrics): HTMLElement => {
      render(<SessionUsageChip metrics={metrics} />);
      fireEvent.click(screen.getByTestId('chat-usage-chip'));
      return screen.getByTestId('chat-usage-popover');
    };

    it('две замены — три строки по порядку и итог как раньше; текущий отрезок кончается now', () => {
      const popover = open({
        ...base,
        usage: counters(3_000_000, 3_000),
        usageSegments: [
          segment('Claude Code', 'opus', 9, 10, 1_000_000, 1.2),
          segment('Codex', 'gpt-5', 10, 11, 1_500_000, 0.5),
          segment('Claude Code', null, 11, null, 500_000, 0.25),
        ],
      });
      expect(screen.getByTestId('chat-usage-chip').textContent).toBe('↑3.0M ↓3.0k');
      const lines = screen.getAllByRole('listitem').map((item) => item.textContent);
      expect(lines).toEqual([
        'Claude Code · opus · 09:00–10:30 — ↑1.0M ↓1.0k, ≈ $1.20 (list price)',
        'Codex · gpt-5 · 10:00–11:30 — ↑1.5M ↓1.0k, ≈ $0.50 (list price)',
        'Claude Code · 11:00–now — ↑500k ↓1.0k, ≈ $0.25 (list price)',
      ]);
      expect(popover.textContent).toContain('This session, all time');
    });

    it('costUsd null — строка без стоимости', () => {
      open({ ...base, usageSegments: [segment('Claude Code', null, 9, 10, 1_000, null), segment('Codex', null, 10, null, 1_000, null)] });
      for (const item of screen.getAllByRole('listitem')) expect(item.textContent).not.toContain('$');
    });

    it('нет поля и один отрезок — прежний вид', () => {
      open(base);
      expect(screen.queryByTestId('chat-usage-segments')).toBeNull();
      cleanup();
      open({ ...base, usageSegments: [segment('Claude Code', null, 9, null, 1_000, 1)] });
      expect(screen.queryByTestId('chat-usage-segments')).toBeNull();
    });
  });
});
