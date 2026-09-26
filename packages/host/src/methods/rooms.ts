/**
 * Методы `rooms.*`: комната и письмо человека из окна (план, кусок 3.5).
 * Правила живут в `rooms/rooms-service.ts` — здесь только форма ответа.
 */

import type { Handler } from '../context.js';
import { createHumanRoom, sendHumanLetter } from '../rooms/rooms-service.js';

export const roomsCreate: Handler<'rooms.create'> = async (params) => ({
  roomId: await createHumanRoom(params),
});

export const roomsSend: Handler<'rooms.send'> = async (params) => ({
  messageId: await sendHumanLetter(params),
});
