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
  addRoomArchivedLetters,
  addRoomOriginMessage,
  archiveRoom,
  deleteRoom,
  HUMAN,
  DEFAULT_CONFIG,
  loadConfig,
  capturePlanNotice,
  reservePlanEffects,
  PlanConflictError,
  isMember,
  recipeLeadsPending,
  reconcileRecipeLeads,
  joinNotice,
  leaveOtherRooms,
  ProposalConflictError,
  renameRoom,
  reopenRoom,
  requireOpenRoom,
  resolveProposal,
  RoomRuleError,
  setRoomLead,
  updateMap,
  workPaths,
  type Room,
  type WorkMap,
} from '@parley/core';
import type { Params, SessionRef } from '@parley/protocol';
import { HostError } from '../errors.js';
import type { SessionsService } from '../sessions/sessions-service.js';

const bad = (message: string): HostError => new HostError('bad_request', message);

/**
 * Работы нет — отказ до `updateMap`: иначе его общий `Error` ушёл бы клиенту
 * как `internal`, хотя ошибся запрос, а не хост.
 */
function assertWork(projectPath: string, workId: string): void {
  if (!existsSync(workPaths(projectPath, workId).map)) throw bad(`workspace ${workId} does not exist`);
}

/** Сессия есть в карте и не закрыта — закрытая писем не получает (спека 7.1). */
function assertDeliverable(map: WorkMap, sessionId: string): void {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw bad(`session ${sessionId} is not in the map`);
  if (session.lifecycle === 'closed') throw bad(`session ${sessionId} is closed`);
}

/**
 * Правила комнаты из core — отказ запроса, а не сбой хоста: `RoomRuleError` — `bad_request`,
 * устаревший ответ на решение (`ProposalConflictError`) — `conflict`. Остальное летит как есть.
 */
function asHostError(error: unknown): unknown {
  if (error instanceof RoomRuleError) return bad(error.message);
  if (error instanceof ProposalConflictError || error instanceof PlanConflictError) return new HostError('conflict', error.message);
  return error;
}

/** Комната для записи в неё (`requireOpenRoom`): нет такой или она в архиве — `bad_request`. */
function openRoom(map: WorkMap, roomId: string): Room {
  try {
    return requireOpenRoom(map, roomId);
  } catch (error) {
    throw asHostError(error);
  }
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
    if (members.length === 0) throw bad('a room needs at least one session');
    for (const id of members) assertDeliverable(map, id);

    const lead = input.lead ?? (members[0] as string);
    if (!members.includes(lead)) throw bad(`lead ${lead} is not a participant of the room`);
    const { origin } = input;
    if (
      origin !== undefined &&
      (origin[0] === origin[1] || !origin.every((id) => members.includes(id)))
    ) {
      throw bad('origin: two different sessions among the room participants');
    }

    const room = addRoom(map, {
      title: input.title,
      creator: HUMAN,
      members,
      lead,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
    });
    // Слой строится из карты при запуске: ведущий, ещё не запущенный (`pending`), получит плейбук им, и письмо
    // не нужно. Запущенный раньше комнаты (окно создаёт сессии до неё) слой уже получил без рецепта — ему
    // плейбук придёт письмом, как новому ведущему (`reconcileRecipeLeads`).
    if (room.recipe != null && map.sessions.find((session) => session.id === lead)?.lifecycle === 'pending') {
      room.recipeLeadNotified = lead;
    }
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

class NothingToDeliver extends Error {}

/**
 * Смена ведущего у комнаты с рецептом: новому ведущему письмом от `parley` уходит исходный снимок плейбука
 * (спека рецептов, 6.4). Отметка о доставленном ведущем пишется в карту вместе с письмом, поэтому повтор и
 * перезапуск хоста второго письма не дают. Письмо будит адресата обычный будильник. Карту трогает только
 * если есть кому слать: `recipeLeadsPending` смотрит снимок хоста без записи.
 */
export async function deliverRecipeToNewLeads(projectPath: string, map: WorkMap): Promise<void> {
  if (!recipeLeadsPending(map)) return;
  try {
    await updateMap(projectPath, map.work.id, (current) => {
      // Снимок хоста мог отстать: под локом уже могло быть сделано — карту не переписываем впустую.
      if (!recipeLeadsPending(current)) throw new NothingToDeliver();
      reconcileRecipeLeads(current);
    });
  } catch (error) {
    if (!(error instanceof NothingToDeliver)) throw error;
  }
}

/**
 * Письмо человека. Без комнаты — ровно один адресат-сессия; в комнате адресаты
 * должны быть её участниками, пустой `to` — рассылка всем (`recipientsOf`). Комната в архиве — отказ.
 */
export async function sendHumanLetter(input: Params<'rooms.send'>): Promise<string> {
  const { projectPath, workId, roomId, to, text, kind } = input;
  assertWork(projectPath, workId);
  let messageId = '';
  await updateMap(projectPath, workId, (map) => {
    if (roomId !== null) {
      // Нет комнаты или она в архиве — `bad_request`: писать в архивную нельзя, пока человек не вернёт её (`rooms.reopen`).
      const room = openRoom(map, roomId);
      for (const id of to) {
        if (!isMember(room, id)) throw bad(`session ${id} is not a participant of room ${roomId}`);
        assertDeliverable(map, id);
      }
      messageId = addMessage(map, { from: HUMAN, to, text, kind, roomId }).id;
      return;
    }

    if (to.length !== 1) throw bad('without a room, exactly one addressee in to is required');
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
  const { projectPath, workId, roomId, proposalId, action, note, rev, planId, planRev } = input;
  const rate = (await loadConfig()).config.messageRate ?? DEFAULT_CONFIG.messageRate;
  assertWork(projectPath, workId);
  let messageId = '';
  await updateMap(projectPath, workId, (map) => {
    try {
      const completion = map.rooms.find(row => row.id === roomId)?.proposal;
      messageId = resolveProposal(map, roomId, proposalId, action, { note, rev, ...(planId === undefined ? {} : { planId }), ...(planRev === undefined ? {} : { planRev }) }).messageId;
      if (action === 'return' && completion?.kind === 'completion')
        capturePlanNotice(map, roomId, 'completion-returned', messageId, completion.planId);
      reservePlanEffects(map, rate);
    } catch (error) {
      throw asHostError(error);
    }
  });
  return messageId;
}

/**
 * Человек переименовывает комнату из сайдбара (`rooms.rename`). Пустое после обрезки название не проходит уже схему,
 * правило повторяет core (`renameRoom`). Не событие работы: `updatedAt` стоит на месте, как у `works.rename`, иначе
 * карточка всплыла бы в начало своего ранга в сайдбаре. Вкладка, шапка комнаты и строка сайдбара читают название из
 * карты — окно покажет новое по обычному `works.changed`.
 */
export async function renameHumanRoom(input: Params<'rooms.rename'>): Promise<void> {
  const { projectPath, workId, roomId, title } = input;
  assertWork(projectPath, workId);
  await updateMap(
    projectPath,
    workId,
    (map) => {
      try {
        renameRoom(map, roomId, title);
      } catch (error) {
        throw asHostError(error);
      }
    },
    { touch: false },
  );
}

/**
 * «Make lead» из окна (`rooms.setLead`): правила, системная строка и письма `parley` — в core (`setRoomLead`).
 * Плейбук рецепта новому ведущему пишется той же мутацией (`reconcileRecipeLeads`). Будильник сделал бы это и сам по
 * следующему изменению карты (`deliverRecipeToNewLeads`), но в одной записи «You now lead…» и плейбук ложатся подряд,
 * а отметка `recipeLeadNotified` второго письма уже не даст. Письма будит обычный будильник; доставку пунктов плана
 * новому ведущему пересчитывает служба плана: смена `lead` в карте для неё — изменение источника. Возвращает id
 * системной строки.
 */
export async function setHumanRoomLead(input: Params<'rooms.setLead'>): Promise<string> {
  const { projectPath, workId, roomId, sessionId } = input;
  assertWork(projectPath, workId);
  let messageId = '';
  await updateMap(projectPath, workId, (map) => {
    try {
      messageId = setRoomLead(map, roomId, sessionId).line.id;
    } catch (error) {
      throw asHostError(error);
    }
    reconcileRecipeLeads(map);
  });
  return messageId;
}

/**
 * Удаление комнаты из окна (`rooms.delete`): правила — в core (`deleteRoom`). Комната уходит с лентой, её сессии
 * остаются обычными сессиями работы, и живым из них — прощальные письма `parley`; будит их обычный будильник.
 *
 * Удалить заодно и сессии окно просит само, до этого вызова, — тем же `sessions.delete`, что у пункта «Delete» строки
 * сессии (`RoomRowMenu`): остановка процесса, worktree с отказом на грязном, запись карты, а перед ними — вопрос окна о
 * несохранённых правках во вкладках файлов worktree. Хост этот путь не повторяет: вопрос о правках задаёт только окно,
 * а отказ на грязном worktree должен остановить удаление до того, как комната пропадёт. К этому вызову удалённых сессий
 * в карте уже нет, и прощальные письма им не пишутся.
 */
export async function deleteHumanRoom(input: Params<'rooms.delete'>): Promise<void> {
  const { projectPath, workId, roomId } = input;
  assertWork(projectPath, workId);
  await updateMap(projectPath, workId, (map) => {
    try {
      deleteRoom(map, roomId);
    } catch (error) {
      throw asHostError(error);
    }
  });
}

/**
 * Архивация комнаты из окна (`rooms.archive`): правила, строка ленты, отмена плана и очистка решения — в core
 * (`archiveRoom`). Не событие работы: `updatedAt` стоит на месте, как у `rooms.rename` и `works.setStatus`, — человек
 * убирает законченное с глаз, и карточка не должна всплывать в начало своего ранга.
 *
 * `archiveRoom` отдаёт сессии, у которых после архивации нет другой открытой комнаты. Дальше две ветки, обе — только для
 * тех из них, у кого есть живой процесс хоста (`sessions.live`): спящей, закрытой и ещё не запущенной остановка не нужна,
 * а письмо спящую подняло бы обратно будильником.
 * - `stopSessions`: каждой живой — `sessions.stop`, как у кнопки Stop и у архива работы; сессия засыпает, поднимет её
 *   Resume или письмо. Письма им не пишутся: они спят.
 * - иначе: живым, кого не остановили, — прямое письмо `parley` (`addRoomArchivedLetters`). Оно пишется той же записью,
 *   что и архивация, поэтому комната не остаётся архивной без письма.
 *
 * Запись карты уже сделана, когда начинается остановка, поэтому сбой остановки не откатывает архив: остальные сессии
 * всё равно останавливаются, а первая ошибка уходит окну после всех. Повторный вызов для уже архивной комнаты ничего не
 * делает (`archiveRoom` отдаёт пустой список) — ни остановки, ни писем.
 */
export async function archiveHumanRoom(
  input: Params<'rooms.archive'>,
  sessions: Pick<SessionsService, 'live' | 'stop'>,
): Promise<void> {
  const { projectPath, workId, roomId, stopSessions } = input;
  assertWork(projectPath, workId);
  const refOf = (sessionId: string): SessionRef => ({ projectPath, workId, sessionId });
  let live: SessionRef[] = [];
  await updateMap(
    projectPath,
    workId,
    (map) => {
      try {
        const orphans = archiveRoom(map, roomId);
        live = orphans.map(refOf).filter((ref) => sessions.live(ref));
        if (!stopSessions) {
          addRoomArchivedLetters(
            map,
            roomId,
            live.map((ref) => ref.sessionId),
          );
        }
      } catch (error) {
        throw asHostError(error);
      }
    },
    { touch: false },
  );
  if (!stopSessions) return;

  const stopped = await Promise.allSettled(live.map((ref) => sessions.stop(ref)));
  const failed = stopped.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}

/**
 * Возврат комнаты из архива (`rooms.reopen`): правила и строка ленты — в core (`reopenRoom`). Сессии сами не
 * поднимаются, как и при Reopen работы. Не событие работы (`updatedAt` на месте), как у архивации и у Reopen работы
 * (`setWorkStatus`): карточка всплывёт, когда в комнате появится первое письмо.
 */
export async function reopenHumanRoom(input: Params<'rooms.reopen'>): Promise<void> {
  const { projectPath, workId, roomId } = input;
  assertWork(projectPath, workId);
  await updateMap(
    projectPath,
    workId,
    (map) => {
      try {
        reopenRoom(map, roomId);
      } catch (error) {
        throw asHostError(error);
      }
    },
    { touch: false },
  );
}
