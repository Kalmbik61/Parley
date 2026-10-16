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
});
