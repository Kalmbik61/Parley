/**
 * Комнаты и письма человека из окна (план, кусок 3.5; спека 6.1–6.3, 7.2).
 *
 * Правила — те же, что у MCP-инструментов агента (`create_room`,
 * `send_message` в core): участие в комнате, живость адресата, ровно один
 * адресат без комнаты. Отличий два: отправитель — `human`, и лимита писем нет —
 * `messageRate` держит петлю двух вежливых агентов, а человек в неё не попадает.
 *
 * Отказ по этим правилам — `bad_request`: окно прислало то, чего карта не
 * допускает. Сбой записи (лок, диск) остаётся своим кодом.
 */

import { existsSync } from 'node:fs';
import {
  addMember,
  addMessage,
  addRoom,
  addRoomOriginMessage,
  HUMAN,
  isMember,
  joinNotice,
  leaveOtherRooms,
  ProposalConflictError,
  resolveProposal,
  RoomRuleError,
  updateMap,
  workPaths,
  type WorkMap,
} from '@parley/core';
import type { Params } from '@parley/protocol';
import { HostError } from '../errors.js';

const bad = (message: string): HostError => new HostError('bad_request', message);

/**
 * Работы нет — отказ до `updateMap`: иначе его общий `Error` ушёл бы клиенту
 * как `internal`, хотя ошибся запрос, а не хост.
 */
function assertWork(projectPath: string, workId: string): void {
  if (!existsSync(workPaths(projectPath, workId).map)) throw bad(`работы ${workId} нет`);
}

/** Сессия есть в карте и не закрыта — закрытая писем не получает (спека 7.1). */
function assertDeliverable(map: WorkMap, sessionId: string): void {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw bad(`сессии ${sessionId} нет в карте`);
  if (session.lifecycle === 'closed') throw bad(`сессия ${sessionId} закрыта`);
}

/**
 * Правила комнаты из core — отказ запроса, а не сбой хоста: `RoomRuleError` — `bad_request`,
 * устаревший ответ на решение (`ProposalConflictError`) — `conflict`. Остальное летит как есть.
 */
function asHostError(error: unknown): unknown {
  if (error instanceof RoomRuleError) return bad(error.message);
  if (error instanceof ProposalConflictError) return new HostError('conflict', error.message);
  return error;
}

/**
 * Комната человека: создатель `human`, участники — заданные сессии; им письмо-приглашение.
 * Ведущий — `input.lead`, а без него первый участник (дизайн комнат, 3.2). Участники уходят
 * из прочих комнат работы: сессия состоит не больше чем в одной (решение 4).
 *
 * `origin` — пара сессий, из которых комнату собрали (диалог 1.6): хост пишет первой строкой ленты
 * системное «Room created from @s03 and @s02» (спека 2.5; писать `from: system` может только он).
 * `quiet` — тихий старт (диалог 1.5, спека 2.1): приглашений нет, лента пуста, пока человек не
 * напишет задачу; по умолчанию они уходят, как прежде, — сессии уже работают и о комнате иначе не
 * узнают.
 */
export async function createHumanRoom(input: Params<'rooms.create'>): Promise<string> {
  assertWork(input.projectPath, input.workId);
  let roomId = '';
  await updateMap(input.projectPath, input.workId, (map) => {
    // Человек — участник всегда и в список не пишется (спека 6.1); повторы схлопнуты.
    const members = [...new Set(input.members)].filter((id) => id !== HUMAN);
    if (members.length === 0) throw bad('в комнате нужна хотя бы одна сессия');
    for (const id of members) assertDeliverable(map, id);

    const lead = input.lead ?? (members[0] as string);
    if (!members.includes(lead)) throw bad(`ведущий ${lead} не участник комнаты`);
    const { origin } = input;
    if (
      origin !== undefined &&
      (origin[0] === origin[1] || !origin.every((id) => members.includes(id)))
    ) {
      throw bad('origin: две разные сессии из участников комнаты');
    }

    const room = addRoom(map, { title: input.title, creator: HUMAN, members, lead });
    for (const id of members) leaveOtherRooms(map, id, room.id);
    roomId = room.id;
    if (origin !== undefined) addRoomOriginMessage(map, room.id, origin);
    if (input.quiet !== true) {
      const notice = joinNotice(room, map);
      for (const id of members) {
        addMessage(map, { from: HUMAN, to: [id], roomId: room.id, kind: 'note', text: notice });
      }
    }
  });
  return roomId;
}

/**
 * Письмо человека. Без комнаты — ровно один адресат-сессия; в комнате адресаты
 * должны быть её участниками, пустой `to` — рассылка всем (`recipientsOf`).
 */
export async function sendHumanLetter(input: Params<'rooms.send'>): Promise<string> {
  const { projectPath, workId, roomId, to, text, kind } = input;
  assertWork(projectPath, workId);
  let messageId = '';
  await updateMap(projectPath, workId, (map) => {
    if (roomId !== null) {
      const room = map.rooms.find((candidate) => candidate.id === roomId);
      if (room === undefined) throw bad(`комнаты ${roomId} нет в карте`);
      for (const id of to) {
        if (!isMember(room, id)) throw bad(`сессия ${id} не участник комнаты ${roomId}`);
        assertDeliverable(map, id);
      }
      messageId = addMessage(map, { from: HUMAN, to, text, kind, roomId }).id;
      return;
    }

    if (to.length !== 1) throw bad('без комнаты нужен ровно один адресат в to');
    const target = to[0] as string;
    assertDeliverable(map, target);
    messageId = addMessage(map, { from: HUMAN, to: [target], text, kind }).id;
  });
  return messageId;
}

/**
 * Человек вводит сессию в комнату (`rooms.addMember`): она уходит из прочих комнат работы,
 * а в ленту ложится «@s04 joined the room». Возвращает id этой строки. Правила — в core
 * (`addMember`): закрытой сессии, неизвестной комнате и уже участнику, что нигде больше не
 * состоит, — отказ `bad_request`. Состоящая и в других комнатах (старая карта, решение 4)
 * входит: из прочих уходит, в этой остаётся одной записью.
 */
export async function addRoomMember(input: Params<'rooms.addMember'>): Promise<string> {
  const { projectPath, workId, roomId, sessionId } = input;
  assertWork(projectPath, workId);
  let messageId = '';
  await updateMap(projectPath, workId, (map) => {
    try {
      messageId = addMember(map, roomId, sessionId).id;
    } catch (error) {
      throw asHostError(error);
    }
  });
  return messageId;
}

/**
 * Ответ человека на решение ведущего (`rooms.resolveProposal`). Устаревший `proposalId` —
 * `conflict`: карточку успели принять, вернуть или заменить. То же при `rev`, если он не
 * совпал с нынешним: ведущий заменил текст (`id` тот же), пока человек смотрел на прежнюю
 * версию. Проверка и запись идут под одним `map.lock`, поэтому два `Accept` подряд не пишут
 * сообщения дважды: второй видит уже пустой слот. Возвращает id сообщения `decision`
 * (`accept`) или письма ведущему (`return`).
 */
export async function resolveRoomProposal(input: Params<'rooms.resolveProposal'>): Promise<string> {
  const { projectPath, workId, roomId, proposalId, action, note, rev } = input;
  assertWork(projectPath, workId);
  let messageId = '';
  await updateMap(projectPath, workId, (map) => {
    try {
      messageId = resolveProposal(map, roomId, proposalId, action, { note, rev }).messageId;
    } catch (error) {
      throw asHostError(error);
    }
  });
  return messageId;
}
