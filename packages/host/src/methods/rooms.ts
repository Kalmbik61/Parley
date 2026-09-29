/**
 * Методы `rooms.*`: комната и письмо человека из окна (план, кусок 3.5).
 * Правила живут в `rooms/rooms-service.ts` — здесь только форма ответа.
 */

import type { Handler } from '../context.js';
import {
  addRoomMember,
  createHumanRoom,
  resolveRoomProposal,
  sendHumanLetter,
} from '../rooms/rooms-service.js';

export const roomsCreate: Handler<'rooms.create'> = async (params) => ({
  roomId: await createHumanRoom(params),
});

export const roomsSend: Handler<'rooms.send'> = async (params) => ({
  messageId: await sendHumanLetter(params),
});

export const roomsAddMember: Handler<'rooms.addMember'> = async (params) => ({
  messageId: await addRoomMember(params),
});

export const roomsResolveProposal: Handler<'rooms.resolveProposal'> = async (params) => ({
  messageId: await resolveRoomProposal(params),
});
