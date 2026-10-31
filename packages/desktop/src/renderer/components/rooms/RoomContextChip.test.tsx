import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { CompactResult, SessionRef } from '@parley/protocol';
import { useHostStore } from '../../store/host.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import type { ParticipantModel } from './feed-model.js';
import { RoomContextChip } from './RoomContextChip.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const FILL = { usedPercent: 82, windowTokens: 200_000, usedTokens: 164_000, at: '2026-10-15T10:00:00.000Z' };
const refOf = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w-01', sessionId });

function participant(patch: Partial<ParticipantModel>): ParticipantModel {
  return {
    id: 's-01',
    label: 'S01 backend',
    rawLabel: 'backend',
    provider: 'claude',
    providerName: 'Claude Code',
    model: null,
    state: 'working',
    lifecycle: 'active',
    word: 'working',
    attention: 'working',
    task: '',
    doing: null,
    doingDetail: null,
    agents: [],
    lead: false,
    closed: false,
    ...patch,
  } as ParticipantModel;
}

const MEMBERS = [
  participant({ id: 's-01', label: 'S01 backend', sessionRef: refOf('s-01'), context: FILL, compaction: null }),
  participant({ id: 's-02', label: 'S02 review', provider: 'codex', sessionRef: refOf('s-02'), context: { ...FILL, usedPercent: 41 }, compaction: 'pending' }),
  participant({ id: 's-03', label: 'S03 docs', lifecycle: 'sleeping', sessionRef: refOf('s-03'), context: null, compaction: null }),
];

let bridge: FakeBridge;
beforeEach(() => {
  bridge = createFakeBridge();
  const answers: Record<string, CompactResult> = { 's-01': { state: 'started' }, 's-02': { state: 'pending' } };
  bridge.setHandler('sessions.compact', ({ ref }) => answers[ref.sessionId] ?? { state: 'refused', reason: 'asleep' });
  bridge.setHandler('sessions.cancelCompact', () => ({ cancelled: true }));
  useHostStore.setState({
    status: { state: 'connected', hostVersion: 'fixture', methods: ['sessions.compact', 'sessions.cancelCompact'] },
    connections: 1,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RoomContextChip (спека 3.3)', () => {
  it('вариант по умолчанию — шапка комнаты (testid есть); sidebar testid не ставит, а клик не всплывает к родителю', () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    expect(screen.getByTestId('room-context-chip')).toBeTruthy();
    cleanup();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} variant="sidebar" />
      </div>,
    );
    expect(screen.queryByTestId('room-context-chip')).toBeNull();
    const trigger = document.querySelector<HTMLElement>('[data-sidebar-room-context]')!;
    expect(trigger.textContent).toBe('Ctx 82% ⏳');
    fireEvent.click(trigger);
    expect(screen.getByTestId('room-context-popover')).toBeTruthy();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('значок — максимум по живым и ⏳ при ждущей просьбе', () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    expect(screen.getByTestId('room-context-chip').textContent).toBe('Ctx 82% ⏳');
  });

  it('список: процент, Cancel у ждущего, asleep у спящего; Codex — подсказка', () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    const row = (id: string) => within(document.querySelector(`[data-context-row="${id}"]`) as HTMLElement);
    expect(row('s-01').getByText('82%')).toBeTruthy();
    expect(row('s-02').getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(row('s-03').getByText('asleep')).toBeTruthy();
    expect(row('s-03').queryByRole('button')).toBeNull();
    expect(screen.getByText('Codex compacts without focus')).toBeTruthy();
  });

  it('Compact all — каждому живому с общим текстом, итог одним тостом', async () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    fireEvent.change(screen.getByTestId('room-compact-instructions'), { target: { value: 'Keep API decisions' } });
    fireEvent.click(screen.getByTestId('room-compact-all'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Compacting 1 agent · 1 queued · 1 skipped'));
    expect(bridge.calls.filter((call) => call.method === 'sessions.compact').map((call) => call.params)).toEqual([
      { ref: refOf('s-01'), instructions: 'Keep API decisions' },
      { ref: refOf('s-02'), instructions: 'Keep API decisions' },
    ]);
  });

  it('Compact all не трогает участника без данных о контексте (skipped)', async () => {
    const members = [
      participant({ id: 's-01', label: 'S01 backend', sessionRef: refOf('s-01'), context: FILL, compaction: null }),
      participant({ id: 's-04', label: 'S04 fresh', sessionRef: refOf('s-04'), context: null, compaction: null }),
    ];
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={members} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    fireEvent.click(screen.getByTestId('room-compact-all'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Compacting 1 agent · 1 skipped'));
    expect(bridge.calls.filter((call) => call.method === 'sessions.compact').map((call) => (call.params as { ref: SessionRef }).ref.sessionId)).toEqual(['s-01']);
  });

  it('Compact в строке — одна сессия с общим текстом по умолчанию', async () => {
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    fireEvent.click(within(document.querySelector('[data-context-row="s-01"]') as HTMLElement).getByRole('button', { name: 'Compact' }));
    await waitFor(() =>
      expect(bridge.calls.find((call) => call.method === 'sessions.compact')?.params).toMatchObject({
        ref: refOf('s-01'),
        instructions: expect.stringContaining('Focus on room "Auth"'),
      }),
    );
  });

  it('старый хост: ни у кого из живых нет поля context — значка нет', () => {
    const old = MEMBERS.map((m) => {
      const copy: Partial<ParticipantModel> = { ...m };
      delete copy.context;
      delete copy.compaction;
      return copy as ParticipantModel;
    });
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={old} />);
    expect(screen.queryByTestId('room-context-chip')).toBeNull();
  });

  it('хост без sessions.compact — список без кнопок', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'fixture', methods: [] }, connections: 1 });
    render(<RoomContextChip bridge={bridge} roomTitle="Auth" participants={MEMBERS} />);
    fireEvent.click(screen.getByTestId('room-context-chip'));
    expect(screen.queryByTestId('room-compact-all')).toBeNull();
    expect(document.querySelectorAll('[data-context-row] button')).toHaveLength(0);
  });
});
