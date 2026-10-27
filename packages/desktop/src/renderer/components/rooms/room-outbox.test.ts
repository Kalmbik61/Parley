/**
 * Попытка очереди комнаты (спека 2026-10-16, 4.2): `rooms.send` с меткой `requestedAt` из payload; исходы —
 * ушло с `messageId` / не ушло с тостом.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { ROOMS_MAIL_FEATURE } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import type { OutboxItem } from '../../lib/outbox.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeLetter, makeMailEvent, makeMailRoom, makeRoom, makeWork } from '../../test-utils/work-fixtures.js';
import { attemptRoomSend, useMailLanded, type RoomOutboxPayload } from './room-outbox.js';

vi.mock('sonner', () => {
  const fn = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast: fn };
});

const REQUESTED_AT = 1_760_000_000_000;

let bridge: FakeBridge;

const item = (): OutboxItem<RoomOutboxPayload> => ({
  id: 'o1',
  status: 'pending',
  payload: { bridge, projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-01', to: ['s-02'], text: 'привет', requestedAt: REQUESTED_AT },
});

beforeEach(() => {
  bridge = createFakeBridge();
  vi.mocked(toast).mockClear();
});

describe('attemptRoomSend', () => {
  it('rooms.send уходит с requestedAt из payload (метка нажатия Send, а не момента вызова)', async () => {
    bridge.setHandler('rooms.send', () => ({ messageId: 'm-01' }));
    expect(await attemptRoomSend('k', item())).toEqual({ kind: 'sent', keepAs: 'm-01' });
    expect(bridge.calls).toEqual([
      {
        method: 'rooms.send',
        params: { projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-01', to: ['s-02'], text: 'привет', kind: 'note', requestedAt: REQUESTED_AT },
      },
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('отказ хоста — failed и тост', async () => {
    bridge.setHandler('rooms.send', () => {
      throw encodeIpcError({ code: 'failed', message: 'нет' });
    });
    expect(await attemptRoomSend('k', item())).toEqual({ kind: 'failed' });
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

/**
 * Что пришло в комнату событием `rooms.mail` (спека rooms.mail 6.9): серое письмо очереди снимается и тогда, когда письма
 * нет среди писем, которые окно держит, — комната не открыта или письмо не встало в ленту.
 */
describe('useMailLanded', () => {
  const human = (id: string) => makeLetter(id, { roomId: 'r-01', from: 'human', to: [] });
  const agent = (id: string) => makeLetter(id, { roomId: 'r-01', from: 's-02', to: [] });
  const event = (version: number, rooms: ReturnType<typeof makeMailRoom>[], workId = 'w-01') =>
    makeMailEvent({ projectPath: '/tmp/p', workId, version, prevVersion: version - 1, rooms });

  /** Окно подключено к хосту с признаком и держит работу `w-01` с двумя комнатами (версия 5). */
  async function connect(): Promise<() => void> {
    const work = { ...makeWork('w-01', { projectPath: '/tmp/p', rooms: [makeRoom('r-01', 'К'), makeRoom('r-02', 'Б')] }), version: 5 };
    bridge.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: null, features: [ROOMS_MAIL_FEATURE] });
    bridge.setHandler('works.list', () => ({ entries: [work], branches: {}, revision: 1 }));
    const dispose = useWorksStore.getState().init(bridge);
    await waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
    return dispose;
  }

  it('собирает id писем человека, пришедших событием в эту комнату; чужая комната, чужая работа и письма агентов — нет', async () => {
    const dispose = await connect();
    const { result } = renderHook(() => useMailLanded('/tmp/p', 'w-01', 'r-01'));
    const other = renderHook(() => useMailLanded('/tmp/p', 'w-02', 'r-01'));
    expect([...result.current]).toEqual([]);

    bridge.emit('rooms.mail', event(6, [makeMailRoom('r-01', { letters: [human('m-7'), agent('m-8')] }), makeMailRoom('r-02', { letters: [human('m-9')] })]));
    await waitFor(() => expect([...result.current]).toEqual(['m-7']));
    expect([...other.result.current]).toEqual([]);

    bridge.emit('rooms.mail', event(7, [makeMailRoom('r-01', { letters: [human('m-10')] })]));
    await waitFor(() => expect([...result.current]).toEqual(['m-7', 'm-10']));
    dispose();
  });

  it('помнит последние 200 id, а не все: набор не растёт без конца', async () => {
    const dispose = await connect();
    const { result } = renderHook(() => useMailLanded('/tmp/p', 'w-01', 'r-01'));
    const letters = Array.from({ length: 250 }, (_, index) => human(`m-${index + 1}`));
    bridge.emit('rooms.mail', event(6, [makeMailRoom('r-01', { letters })]));
    await waitFor(() => expect(result.current.size).toBe(200));
    expect(result.current.has('m-250')).toBe(true);
    expect(result.current.has('m-50')).toBe(false);
    dispose();
  });

  it('другая комната — свой набор; после размонтирования слушатель снят', async () => {
    const dispose = await connect();
    const { result, rerender, unmount } = renderHook(({ roomId }) => useMailLanded('/tmp/p', 'w-01', roomId), { initialProps: { roomId: 'r-01' } });
    bridge.emit('rooms.mail', event(6, [makeMailRoom('r-01', { letters: [human('m-7')] })]));
    await waitFor(() => expect([...result.current]).toEqual(['m-7']));
    // Вкладка переехала в другую комнату: id первой в её набор не попадают (id писем уникальны только в работе).
    rerender({ roomId: 'r-02' });
    expect([...result.current]).toEqual([]);

    const seen = result.current;
    unmount();
    bridge.emit('rooms.mail', event(7, [makeMailRoom('r-01', { letters: [human('m-11')] })]));
    expect(result.current).toBe(seen);
    dispose();
  });
});
