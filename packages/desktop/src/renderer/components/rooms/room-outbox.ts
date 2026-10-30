/**
 * Очередь отправки комнаты (спека 2026-10-16, 4.2) поверх `lib/outbox.ts`: ключ — `draftKey` комнаты, элемент — письмо
 * человека с адресатами из чипов на момент Enter. Попытка — `rooms.send`; ушло — элемент держится как `sent` с
 * `messageId`, пока письмо не придёт в ленту или событием `rooms.mail` (`RoomPanel`, `useMailLanded`). Сама комната не
 * повторяет: отказ — «Not sent» и прежний тост.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { createOutbox, type AttemptResult, type OutboxItem } from '../../lib/outbox.js';
import { useWorksStore } from '../../store/works.js';

export interface RoomOutboxPayload {
  bridge: ParleyBridge;
  projectPath: string;
  workId: string;
  roomId: string;
  /** Упомянутые сессии; пусто — всем участникам. */
  to: string[];
  text: string;
  /** Ответ на сообщение комнаты (Reply): хост хранит связь, окно рисует нативную цитату. */
  replyTo?: string;
  /** Момент нажатия Send (мс эпохи): ставится при постановке в очередь, автоповтор его не меняет, ручной Retry ставит заново; хост считает по нему `queueMs`. */
  requestedAt: number;
}

export async function attemptRoomSend(_key: string, item: OutboxItem<RoomOutboxPayload>): Promise<AttemptResult> {
  const { bridge, projectPath, workId, roomId, to, text, requestedAt, replyTo } = item.payload;
  try {
    const { messageId } = await bridge.call('rooms.send', { projectPath, workId, roomId, to, text, kind: 'note', requestedAt, ...(replyTo === undefined ? {} : { replyTo }) });
    return { kind: 'sent', keepAs: messageId };
  } catch (error) {
    // Не ушло (не участник, комната в архиве, база занята дольше таймаута, хост недоступен): человек узнаёт об этом тостом.
    toast(errorText(decodeIpcError(error).code, S.rooms.sendAction));
    return { kind: 'failed' };
  }
}

export const roomOutbox = createOutbox<RoomOutboxPayload>(attemptRoomSend);

/** Тот же литерал, что `HUMAN` в `core/work/types.ts`: из core рендерер берёт только типы (как в `derive.ts`). */
const HUMAN = 'human';
const NO_IDS: ReadonlySet<string> = new Set();
/** Серое письмо снимается следом за приходом, поэтому помнить нужно недавнее; набор не растёт вместе с перепиской. */
const LANDED_MAX = 200;

/**
 * Id писем человека, которые пришли в комнату событием `rooms.mail`, пока открыта вкладка (спека rooms.mail 6.9): серое
 * письмо очереди снимается и тогда, когда письма нет среди писем, которые окно держит, — комнату окно не держит или письмо
 * не встало в ленту. Событие может прийти раньше, чем `rooms.send` ответит `messageId`: набор помнит id, и `RoomPanel`
 * сверяет его с `sentAs`, когда тот станет известен.
 */
export function useMailLanded(projectPath: string, workId: string, roomId: string): ReadonlySet<string> {
  const key = `${projectPath}\u0000${workId}\u0000${roomId}`;
  const [landed, setLanded] = useState<{ key: string; ids: ReadonlySet<string> }>({ key, ids: NO_IDS });
  useEffect(
    () =>
      useWorksStore.getState().onMail((event) => {
        if (event.projectPath !== projectPath || event.workId !== workId) return;
        const arrived = event.rooms
          .find((batch) => batch.roomId === roomId)
          ?.letters.filter((letter) => letter.from === HUMAN)
          .map((letter) => letter.id);
        if (arrived === undefined || arrived.length === 0) return;
        setLanded((was) => ({ key, ids: new Set([...(was.key === key ? was.ids : []), ...arrived].slice(-LANDED_MAX)) }));
      }),
    [key, projectPath, workId, roomId],
  );
  // Набор другой комнаты (вкладка переехала) не считается: id писем уникальны только в работе.
  return landed.key === key ? landed.ids : NO_IDS;
}
