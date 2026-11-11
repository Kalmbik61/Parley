// The Code Mode label (plan T12a-indicator): display only. Every state, every closed reason, and the ways it must not lie.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result, SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { CODE_MODE_REFRESH_MS, CodeModeChip, readCodeMode } from './CodeModeChip.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };
type Wire = Result<'sessions.codeMode'>;

beforeEach(() => { useActivityStore.setState({ byRef: {}, loaded: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const entry = (at: number): ActivityEntry => ({ ref, activity: { activity: 'idle', subagents: 0, tasks: [], waitingFor: null, heldByBackground: false, turnEndedAt: null, lastEventAt: at, source: 'hooks', hooksMissing: false, need: null }, metrics: null });

async function show(answer: unknown): Promise<HTMLElement> {
  const bridge = createFakeBridge();
  bridge.setHandler('sessions.codeMode', (async () => answer) as never);
  render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
  await act(async () => { await Promise.resolve(); });
  return screen.getByTestId('chat-code-mode');
}

describe('CodeModeChip: what it says', () => {
  it('code-mode: Code Mode, whatever reason rides along', async () => {
    const chip = await show({ mode: 'code-mode', reason: null });
    expect(chip.textContent).toBe('Code Mode');
    expect(chip.dataset.mode).toBe('code-mode');
  });

  it('classic with provider-unproven: plain "Classic", no short reason, no sentence about proof in the text, tooltip or accessible name', async () => {
    const chip = await show({ mode: 'classic', reason: 'provider-unproven' });
    expect(chip.textContent).toBe('Classic');
    expect(chip.dataset.mode).toBe('classic');
    expect(chip.title).toContain(S.codeMode.meaning.classic);
    expect(chip.title).toContain(S.codeMode.limit);
    expect(chip.title.split('\n')).toHaveLength(2);
    expect(`${chip.textContent}|${chip.title}|${chip.getAttribute('aria-label')}`).not.toMatch(/\bproven\b|unproven/i);
  });

  it.each(Object.keys(S.codeMode.reasons).filter((reason) => reason !== 'provider-unproven'))('classic with %s: "Classic · short", the full sentence in the tooltip and the accessible name', async (reason) => {
    const text = S.codeMode.reasons[reason as Exclude<keyof typeof S.codeMode.reasons, 'provider-unproven'>]!;
    const chip = await show({ mode: 'classic', reason });
    expect(chip.textContent).toBe(`Classic · ${text.short}`);
    expect(chip.title).toContain(text.full);
    expect(chip.getAttribute('aria-label')).toContain(text.full);
    expect(chip.dataset.mode).toBe('classic');
  });

  it.each([['no reason', null], ['failed', 'failed'], ['unconfirmed', 'unconfirmed']])('unknown (%s): Mode unknown, never Code Mode or Classic', async (_n, reason) => {
    const chip = await show({ mode: 'unknown', reason });
    expect(chip.textContent).toBe('Mode unknown');
    expect(chip.textContent).not.toMatch(/Code Mode|Classic/);
    expect(chip.title).not.toMatch(/runs Code Mode|classic tool list/);
    expect(chip.dataset.mode).toBe('unknown');
    if (reason !== null) expect(chip.title).toContain(S.codeMode.reasons[reason as 'failed']!.full);
  });

  it('the tooltip says it is Parley\'s record and not proof of what runs', async () => {
    for (const answer of [{ mode: 'code-mode', reason: null }, { mode: 'classic', reason: 'held-run' }, { mode: 'unknown', reason: null }]) {
      cleanup();
      const chip = await show(answer);
      expect(chip.title).toContain(S.codeMode.limit);
      expect(chip.getAttribute('aria-label')).toContain('not proof');
    }
  });

  it.each([
    ['an unrecognised reason on classic', { mode: 'classic', reason: 'a-newer-gate' }],
    ['free text as a reason on classic', { mode: 'classic', reason: 'The client said no.' }],
    ['classic without a reason', { mode: 'classic', reason: null }],
    ['an inherited key as a reason', { mode: 'classic', reason: 'toString' }],
    ['an unrecognised mode', { mode: 'alongside', reason: null }],
    ['a reason that is not a string', { mode: 'unknown', reason: 4 }],
    ['not an object', 'code-mode'],
    ['null', null],
    ['nothing', undefined],
    ['an array', []],
  ])('%s: Mode unknown, no raw text on the page', async (_n, answer) => {
    const chip = await show(answer);
    expect(chip.textContent).toBe('Mode unknown');
    const raw = typeof answer === 'object' && answer !== null && 'reason' in answer ? String((answer as { reason: unknown }).reason) : '';
    if (raw.length > 3) expect(document.body.innerHTML).not.toContain(raw);
  });

  it('unknown on the way and when the host says no: the label never claims a mode it was not told', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.codeMode', (() => new Promise(() => undefined)) as never);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Mode unknown');
    cleanup();
    const failing = createFakeBridge();
    failing.setHandler('sessions.codeMode', (async () => { throw new Error('host gone'); }) as never);
    render(<CodeModeChip sessionRef={ref} bridge={failing} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Mode unknown');
  });

  it('a read that fails after a good one: back to Mode unknown, not the old state', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    let fail = false;
    bridge.setHandler('sessions.codeMode', (async () => { if (fail) throw new Error('host gone'); return { mode: 'code-mode', reason: null }; }) as never);
    const dispose = useActivityStore.getState().init(bridge);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_MODE_REFRESH_MS); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Code Mode');
    fail = true;
    await act(async () => { bridge.emit('activity.changed', entry(1)); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Mode unknown');
    dispose();
  });

  it('no bridge at all: Mode unknown, no throw', () => {
    const original = (window as unknown as { parley?: unknown }).parley;
    delete (window as unknown as { parley?: unknown }).parley;
    try {
      render(<CodeModeChip sessionRef={ref} />);
      expect(screen.getByTestId('chat-code-mode').textContent).toBe('Mode unknown');
    } finally { (window as unknown as { parley?: unknown }).parley = original; }
  });

  it('readCodeMode: the shapes a host may answer, one by one', () => {
    expect(readCodeMode({ mode: 'code-mode', reason: 'held-run' })).toEqual({ mode: 'code-mode', reason: null });
    expect(readCodeMode({ mode: 'classic', reason: 'held-run' })).toEqual({ mode: 'classic', reason: 'held-run' });
    expect(readCodeMode({ mode: 'unknown', reason: 'a-newer-gate' })).toEqual({ mode: 'unknown', reason: 'a-newer-gate' });
  });
});

describe('CodeModeChip: it moves, without a poll', () => {
  it('unknown, then the record is written and an activity event arrives, then Code Mode; nothing in between', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    let answer: Wire = { mode: 'unknown', reason: null };
    bridge.setHandler('sessions.codeMode', (async () => answer) as never);
    const dispose = useActivityStore.getState().init(bridge);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Mode unknown');
    expect(bridge.calls.filter((c) => c.method === 'sessions.codeMode')).toHaveLength(1);

    answer = { mode: 'code-mode', reason: null };
    // Time alone changes nothing: no timer, no poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Mode unknown');
    expect(bridge.calls.filter((c) => c.method === 'sessions.codeMode')).toHaveLength(1);

    await act(async () => { bridge.emit('activity.changed', entry(1)); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Code Mode');
    expect(bridge.calls.filter((c) => c.method === 'sessions.codeMode')).toHaveLength(2);
    dispose();
  });

  it('a burst of events reads at most once a second: the first at once, the rest as one trailing read', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.codeMode', (async () => ({ mode: 'unknown', reason: null })) as never);
    const dispose = useActivityStore.getState().init(bridge);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const reads = () => bridge.calls.filter((c) => c.method === 'sessions.codeMode').length;
    expect(reads()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_MODE_REFRESH_MS); });
    for (let i = 0; i < 20; i += 1) await act(async () => { bridge.emit('activity.changed', entry(i)); await vi.advanceTimersByTimeAsync(10); });
    expect(reads()).toBe(2); // one at once, 19 swallowed into the one trailing read still to come
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_MODE_REFRESH_MS); });
    expect(reads()).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads()).toBe(3);
    dispose();
  });

  it('only this session\'s events count: another session\'s activity reads nothing', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.codeMode', (async () => ({ mode: 'unknown', reason: null })) as never);
    const dispose = useActivityStore.getState().init(bridge);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_MODE_REFRESH_MS * 2); });
    await act(async () => { bridge.emit('activity.changed', { ...entry(1), ref: { ...ref, sessionId: 's-02' } }); await vi.advanceTimersByTimeAsync(CODE_MODE_REFRESH_MS * 2); });
    expect(bridge.calls.filter((c) => c.method === 'sessions.codeMode')).toHaveLength(1);
    dispose();
  });

  it('a late answer to an older read never overwrites a newer one', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    const resolvers: Array<(w: Wire) => void> = [];
    bridge.setHandler('sessions.codeMode', (() => new Promise<Wire>((resolve) => resolvers.push(resolve))) as never);
    const dispose = useActivityStore.getState().init(bridge);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODE_MODE_REFRESH_MS); });
    await act(async () => { bridge.emit('activity.changed', entry(1)); await vi.advanceTimersByTimeAsync(0); });
    expect(resolvers).toHaveLength(2);
    await act(async () => { resolvers[1]!({ mode: 'code-mode', reason: null }); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { resolvers[0]!({ mode: 'classic', reason: 'not-requested' }); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Code Mode');
    dispose();
  });

  it('switching to another session drops the old state at once: B never shows A\'s mode while B\'s read is pending', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.codeMode', (async ({ ref: asked }: { ref: SessionRef }) => (asked.sessionId === 's-01' ? { mode: 'code-mode', reason: null } : new Promise<never>(() => undefined))) as never);
    const other: SessionRef = { ...ref, sessionId: 's-02' };
    const view = render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('chat-code-mode').textContent).toBe('Code Mode');
    // The toolbar renders the chip without a key, so the instance is reused for the next session.
    view.rerender(<CodeModeChip sessionRef={other} bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    expect(bridge.calls.filter((c) => c.method === 'sessions.codeMode')).toHaveLength(2);
    const chip = screen.getByTestId('chat-code-mode');
    expect(chip.textContent).toBe('Mode unknown');
    expect(chip.dataset.mode).toBe('unknown');
  });

  it('after unmount, a pending trailing read does not fire and a late answer does not set state', async () => {
    vi.useFakeTimers();
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.codeMode', (async () => ({ mode: 'unknown', reason: null })) as never);
    const dispose = useActivityStore.getState().init(bridge);
    const view = render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { bridge.emit('activity.changed', entry(1)); await vi.advanceTimersByTimeAsync(0); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(bridge.calls.filter((c) => c.method === 'sessions.codeMode')).toHaveLength(1);
    dispose();
  });
});

describe('CodeModeChip: display only', () => {
  it('has no click action and calls nothing but sessions.codeMode with the session\'s own ref', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.codeMode', (async () => ({ mode: 'classic', reason: 'not-requested' })) as never);
    render(<CodeModeChip sessionRef={ref} bridge={bridge} />);
    await act(async () => { await Promise.resolve(); });
    const chip = screen.getByTestId('chat-code-mode');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.querySelector('button, a, input')).toBeNull();
    expect(chip.getAttribute('onclick')).toBeNull();
    expect(bridge.calls).toEqual([{ method: 'sessions.codeMode', params: { ref } }]);
    expect(bridge.notified).toEqual([]);
  });
});
