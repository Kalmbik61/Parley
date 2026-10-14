import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomUsage, UsageTotal } from '@parley/core';
import { useActivityStore } from '../../store/activity.js';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { ROOM_USAGE_MIN_INTERVAL_MS, RoomUsageChip } from './RoomUsageChip.js';

const T0 = '2026-10-14T10:00:00.000Z';
const total = (input: number, over: Partial<UsageTotal> = {}): UsageTotal => ({
  input,
  output: 84_000,
  cacheRead: 9_100_000,
  cacheWrite: null,
  totalInput: null,
  completeness: 'complete',
  stale: false,
  coverage: 'conversation',
  conversations: 1,
  ...over,
});
const USAGE: RoomUsage = {
  roomId: 'r-01',
  computedAt: '2026-10-14T12:03:00.000Z',
  reconstructed: false,
  total: total(1_200_000),
  byProvider: [{ provider: 'claude', total: total(1_200_000) }],
  members: [
    {
      sessionId: 's-01',
      provider: 'claude',
      lead: true,
      periods: [{ from: T0, to: null }],
      current: true,
      status: 'counted',
      reason: null,
      method: 'sliced',
      usage: { ...total(1_200_000), source: 'native-index', observedAt: T0, completeness: 'partial' },
      sharedWith: [],
    },
    {
      sessionId: 's-02',
      provider: 'claude',
      lead: false,
      periods: [{ from: T0, to: null }],
      current: true,
      status: 'not-started',
      reason: null,
      method: null,
      usage: null,
      sharedWith: [],
    },
  ],
};

const entry = makeWork('w-01', {
  projectPath: '/p',
  sessions: [makeSession('s-01', 'Planner'), makeSession('s-02', 'Backend')],
  rooms: [
    {
      id: 'r-01',
      title: 'Payments',
      creator: 'human',
      members: ['s-01', 's-02'],
      createdAt: T0,
      lead: 's-01',
      proposal: null,
      memberLog: [
        { session: 's-01', from: T0, to: null },
        { session: 's-02', from: T0, to: null },
      ],
    },
  ],
});
const PROVIDERS = [{ id: 'claude', label: 'Claude' }];
let bridge: FakeBridge;
const show = (active = true) => <RoomUsageChip bridge={bridge} entry={entry} roomId="r-01" active={active} providers={PROVIDERS} />;
const usageCalls = () => bridge.calls.filter((call) => call.method === 'rooms.usage');
const metrics = (tokensIn: number) => ({ tokensIn, tokensOut: 1, durationMs: null, unread: 0, subagents: 0, model: null });

beforeEach(() => {
  bridge = createFakeBridge();
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: ['rooms.usage'] }, connections: 1 });
  useActivityStore.setState({ byRef: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RoomUsageChip (спека расхода токенов, 3.1–3.3)', () => {
  it('хост без rooms.usage — значка нет, хост не спрашивается', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [] }, connections: 1 });
    render(show());
    expect(screen.queryByTestId('room-usage-chip')).toBeNull();
    expect(usageCalls()).toHaveLength(0);
  });

  it('активная вкладка спрашивает сразу; значок — итог, поповер — участники и пометки', async () => {
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show());
    const chip = await screen.findByText('↑1.2M ↓84k');
    expect(usageCalls()).toEqual([{ method: 'rooms.usage', params: { projectPath: '/p', workId: 'w-01', roomId: 'r-01' } }]);
    fireEvent.click(chip);
    const popover = await screen.findByTestId('room-usage-popover');
    expect(popover.textContent).toContain('S01 Planner · lead · Claude');
    expect(popover.textContent).toContain('partial');
    expect(popover.textContent).toContain('not started');
    expect(popover.textContent).toContain('Tokens, not money or plan limit.');
  });

  it('неактивная вкладка хост не спрашивает', () => {
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show(false));
    expect(usageCalls()).toHaveLength(0);
  });

  it('ошибка хоста — «—» и Usage unavailable', async () => {
    bridge.setHandler('rooms.usage', () => {
      throw new Error('boom');
    });
    render(show());
    const chip = await screen.findByText('—');
    expect(chip.closest('button')?.getAttribute('title')).toBe('Usage unavailable');
  });

  it('новые цифры участников — повтор не чаще раза в 10 секунд', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(usageCalls()).toHaveLength(1);
    const ref = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'working', { metrics: metrics(10) })]) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOM_USAGE_MIN_INTERVAL_MS - 1000);
    });
    expect(usageCalls()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(usageCalls()).toHaveLength(2);
  });

  it('Copy кладёт в буфер таблицу Markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    bridge.setHandler('rooms.usage', () => USAGE);
    render(show());
    fireEvent.click(await screen.findByText('↑1.2M ↓84k'));
    fireEvent.click(await screen.findByTestId('room-usage-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain('**Room “Payments” (r-01) — token usage**');
  });
});
