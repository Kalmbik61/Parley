/**
 * Очередь отправки комнаты (спека 2026-10-16, 4.2) поверх `lib/outbox.ts`: ключ — `draftKey` комнаты, элемент — письмо
 * человека с адресатами из чипов на момент Enter. Попытка — `rooms.send`; ушло — элемент держится как `sent` с
 * `messageId`, пока письмо не придёт в ленту (`RoomPanel`). Сама комната не повторяет: отказ — «Not sent» и прежний тост.
 */

import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { createOutbox, type AttemptResult, type OutboxItem } from '../../lib/outbox.js';

export interface RoomOutboxPayload {
  bridge: ParleyBridge;
  projectPath: string;
  workId: string;
  roomId: string;
  /** Упомянутые сессии; пусто — всем участникам. */
  to: string[];
  text: string;
  /** Момент нажатия Send (мс эпохи): ставится при постановке в очередь, автоповтор его не меняет, ручной Retry ставит заново; хост считает по нему `queueMs`. */
  requestedAt: number;
}

export async function attemptRoomSend(_key: string, item: OutboxItem<RoomOutboxPayload>): Promise<AttemptResult> {
  const { bridge, projectPath, workId, roomId, to, text, requestedAt } = item.payload;
  try {
    const { messageId } = await bridge.call('rooms.send', { projectPath, workId, roomId, to, text, kind: 'note', requestedAt });
    return { kind: 'sent', keepAs: messageId };
  } catch (error) {
    // Не ушло (не участник, комната в архиве, тайм-аут `map.lock`, хост недоступен): человек узнаёт об этом тостом.
    toast(errorText(decodeIpcError(error).code, S.rooms.sendAction));
    return { kind: 'failed' };
  }
}

export const roomOutbox = createOutbox<RoomOutboxPayload>(attemptRoomSend);
