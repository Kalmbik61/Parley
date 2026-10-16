/**
 * Попытка очереди комнаты (спека 2026-10-16, 4.2): `rooms.send` с меткой `requestedAt` из payload; исходы —
 * ушло с `messageId` / не ушло с тостом.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import type { OutboxItem } from '../../lib/outbox.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { attemptRoomSend, type RoomOutboxPayload } from './room-outbox.js';

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
