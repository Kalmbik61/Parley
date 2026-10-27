import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressResult } from '@parley/protocol';
import { ProgressView } from './ProgressView.js';

afterEach(cleanup);
describe('progress detail', () => {
  it.each(['loading', 'unavailable'] as const)('shows localized %s with explicit open/close actions', (kind) => {
    const open = vi.fn(); const close = vi.fn();
    render(<ProgressView state={{ kind }} onOpen={open} onClose={close} />);
    expect(screen.getByText(kind === 'loading' ? 'Loading recent actions…' : 'Recent actions unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Parley' })); expect(open).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Close history' })); expect(close).toHaveBeenCalledOnce();
  });

  it('shows empty available distinctly from unavailable', () => {
    render(<ProgressView state={{ kind: 'available', delayed: false, result: { revision: 1, availability: 'available', current: null, recent: [], truncated: false } }} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getByText('No recent actions')).toBeTruthy();
    expect(screen.queryByText('Recent actions unavailable')).toBeNull();
  });

  it('renders synthetic Codex positive progress with a completed step and one current action', () => {
    const recent: ProgressResult['recent'] = [
      { id: 'codex-read-1', at: '2026-10-27T08:00:00.000Z', endedAt: '2026-10-27T08:00:01.000Z', category: 'read', status: 'done' },
      { id: 'codex-delegate-2', at: '2026-10-27T08:00:02.000Z', category: 'delegate', status: 'running' },
    ];
    const result: ProgressResult = { revision: 2, availability: 'available', current: recent[1]!, recent, truncated: false };
    render(<ProgressView state={{ kind: 'available', result, delayed: false }} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Read files')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Delegate')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getAllByRole('listitem')[1]?.getAttribute('aria-current')).toBe('step');
  });

  it('caps history at20, labels enums locally, marks current within history and shows delayed/truncated', () => {
    const recent = Array.from({ length: 25 }, (_, index) => ({ id: `opaque-${index}`, at: '2026-10-26T10:00:00.000Z',
      category: 'execute' as const, status: index === 24 ? 'running' as const : 'done' as const, name: 'SECRET-command' }));
    const result = { revision: 1, availability: 'available', current: recent.at(-1), recent, truncated: true } as ProgressResult;
    const { container } = render(<ProgressView state={{ kind: 'available', result, delayed: true }} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getAllByText('Run command')).toHaveLength(20);
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.getByText('Current')).toBeTruthy(); expect(screen.getByText('Update delayed')).toBeTruthy();
    expect(screen.getByText('Earlier actions omitted')).toBeTruthy();
    expect(container.textContent).not.toContain('SECRET');
  });
});
