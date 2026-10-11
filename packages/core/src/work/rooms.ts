import type { RecipeSnapshot } from '../recipes/types.js';
import { addMessage, maxNumber } from './map.js';
import { recipientsOf } from './letters.js';
import { cancelActiveRoomPlan } from './plans.js';
import { sessionMention, sessionTag } from './thread.js';
import { HUMAN, PARLEY, SYSTEM, type RoomMode, type Message, type Room, type WorkMap } from './types.js';

/**
 * Нарушено правило комнаты: не участник, не ведущий, комната закрыта, ведущий вне круга.
 * Отдельный класс, как `WorkNotFoundError`: хост отвечает на него `bad_request` — ошибся
 * запрос, а не хост, — а не общим `internal`.
 */
export class RoomRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomRuleError';
  }
}

/**
 * Следующий id комнаты внутри работы: `r-01`, `r-02`, … Счётчик — `work.roomSeq`,
 * а не длина списка: комнаты этот кусок не удаляет, но номер не должен уехать
 * назад, если карту когда-нибудь начнут чистить (тот же приём, что у сессий в
 * `nextSessionId`).
 */
export function nextRoomId(map: WorkMap): string {
  const next =
    Math.max(
      map.work.roomSeq ?? 0,
      maxNumber(
        map.rooms.map((room) => room.id),
        'r-',
      ),
    ) + 1;
  map.work.roomSeq = next;
  return `r-${String(next).padStart(2, '0')}`;
}

export interface NewRoom {
  mode?: RoomMode;
  title: string;
  /** Id сессии-создателя или `human`; создатель — участник, в `members` не пишется. */
  creator: string;
  members: string[];
  /**
   * Ведущий: участник комнаты (создатель-сессия тоже); человек им быть не может. Без него
   * `lead: null` — ведущим считается первый из `members` (`roomLead`).
   */
  lead?: string | null;
  /** Рецепт комнаты: копируется снимком, дальнейшие правки файла рецепта комнату не меняют. */
  recipe?: RecipeSnapshot | null;
}

/** Заводит комнату в карте. */
export function addRoom(map: WorkMap, init: NewRoom, at = new Date().toISOString()): Room {
  const lead = init.lead ?? null;
  if (init.mode !== undefined && !['free', 'checklist', 'verified'].includes(init.mode)) throw new RoomRuleError('invalid room mode');
  // Проверка до `nextRoomId`: отказ не должен тратить номер комнаты.
  if (lead !== null && (lead === HUMAN || !(lead === init.creator || init.members.includes(lead)))) {
    throw new RoomRuleError(`lead ${lead} is not a participant of room "${init.title}"`);
  }
  const room: Room = {
    id: nextRoomId(map),
    title: init.title,
    creator: init.creator,
    members: [...init.members],
    createdAt: at,
    lead,
    proposal: null,
    mode: init.mode ?? 'free',
    recipe: init.recipe == null ? null : { id: init.recipe.id, name: init.recipe.name, playbook: init.recipe.playbook },
    archivedAt: null,
  };
  map.rooms.push(room);
  return room;
}

/**
 * Ведущий комнаты по записи: явный `lead`, а у комнат без него — первый из `members`. Так читаются
 * карты до 2026-09-29, и так же считается ведущий, когда назначенный ушёл из комнаты
 * (`leaveOtherRooms` сбрасывает `lead` в `null`). Ни одного участника — ведущего нет. Это только
 * запись: кто может действовать, когда назначенный закрыт, решает `liveLead`.
 */
export function roomLead(room: Room): string | null {
  return room.lead ?? room.members[0] ?? null;
}

/** Жива ли сессия: есть в карте и не закрыта. Закрытая и удалённая из карты — нет; человек не сессия. */
function isAlive(map: WorkMap, id: string): boolean {
  return map.sessions.some((session) => session.id === id && session.lifecycle !== 'closed');
}

/**
 * Закрыта ли комната: в ней не осталось живых участников — каждая сессия создателя и
 * `members` закрыта или уже удалена из карты (человек не сессия и комнату не держит).
 * Отдельного признака «закрыта» у комнаты в карте нет: она закрывается вместе со своими
 * сессиями, и решение в такую комнату приносить некому.
 */
export function isRoomClosed(map: WorkMap, room: Room): boolean {
  return ![room.creator, ...room.members].some((id) => isAlive(map, id));
}

/**
 * В архиве ли комната: человек убрал её с глаз (`archiveRoom`). Проверка по строке, а не по `=== null`: комната из
 * литерала без поля (старая фикстура, карта в памяти не через `parseMap`) считается открытой, а не архивной.
 */
export function isRoomArchived(room: Room): boolean {
  return typeof room.archivedAt === 'string';
}

/**
 * Ведущий, который может действовать: `roomLead`, если он жив, а иначе первый живой из `members`
 * и за ним создатель-сессия. `closed` из карты не откатывается, а `removeSession` не убирает id
 * из `members` — и сменить ведущего нечем. Без подмены комната с ушедшим ведущим осталась бы без
 * права на решение навсегда: `setProposal` не пустил бы никого. Ведущего нет ровно тогда, когда
 * комната закрыта (`isRoomClosed`): круг тот же — создатель и `members`. Запись комнаты
 * (`lead`, `members`) подмена не переписывает.
 */
export function liveLead(map: WorkMap, room: Room): string | null {
  const declared = roomLead(room);
  if (declared !== null && isMember(room, declared) && isAlive(map, declared)) return declared;
  return [...room.members, room.creator].find((id) => isAlive(map, id)) ?? null;
}

/**
 * Правило одной комнаты на сессию (решение 4 дизайна комнат): убирает сессию из всех
 * комнат карты, кроме `exceptRoomId`. Ушедший ведущий оставляет `lead: null`, а создатель-
 * сессия уступает комнату человеку: иначе `isMember` продолжил бы считать её участницей, а
 * `recipientsOf` — адресатом рассылок, то есть она осталась бы в двух комнатах сразу.
 * Ждущее решение ушедшего ведущего остаётся в слоте: человек ответит на него как на любое,
 * а письмо о принятии или возврате пойдёт нынешнему ведущему (`resolveProposal`).
 */
export function leaveOtherRooms(map: WorkMap, sessionId: string, exceptRoomId: string): void {
  for (const room of map.rooms) {
    if (room.id === exceptRoomId) continue;
    room.members = room.members.filter((id) => id !== sessionId);
    if (room.creator === sessionId) room.creator = HUMAN;
    if (room.lead === sessionId) room.lead = null;
  }
}

/**
 * Строка ленты от самого харнесса: «@s04 joined the room», «You accepted the decision».
 * Это существующий механизм системных писем (`from: SYSTEM`, его пишут и `wake-service`, и
 * `sessions-service`), но адресат у строки — человек. Пустой `to` в комнате означал бы
 * рассылку всем участникам: строка легла бы каждому агенту непрочитанной письмом и подняла
 * бы спящих. А человек про действие, которое сам сделал, «непрочитанного» иметь не должен —
 * его отметка стоит с самой записи.
 */
export function addSystemMessage(
  map: WorkMap,
  roomId: string,
  text: string,
  at = new Date().toISOString(),
): Message {
  const message = addMessage(map, { from: SYSTEM, to: [HUMAN], roomId, kind: 'note', text }, at);
  message.readBy[HUMAN] = at;
  return message;
}

/**
 * Человек вводит сессию в комнату (`rooms.addMember`): она уходит из прочих комнат работы
 * (`leaveOtherRooms`), встаёт последней в `members`, а в ленту ложится системная строка
 * «@s04 joined the room». Возвращает эту строку. Закрытая сессия писем не получает и в
 * комнату не входит.
 *
 * Отказ «уже участник» — только если сессия состоит в этой комнате и больше нигде: окно такой
 * бросок не допускает. В старой карте (решение 4) она может состоять в нескольких комнатах, а
 * сайдбар ставит её в самую раннюю. Бросок на позднюю, где она по записи тоже участница, — как
 * раз лекарство: из прочих комнат она уходит, а в этой остаётся одной записью, не двумя
 * (создатель-сессия в `members` не пишется вовсе: он и так участник).
 */
export function addMember(
  map: WorkMap,
  roomId: string,
  sessionId: string,
  at = new Date().toISOString(),
): Message {
  const room = requireOpenRoom(map, roomId);
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new RoomRuleError(`session ${sessionId} is not in the map`);
  if (session.lifecycle === 'closed') throw new RoomRuleError(`session ${sessionId} is closed`);

  const inRoom = isMember(room, sessionId);
  const elsewhere = map.rooms.some((other) => other.id !== roomId && isMember(other, sessionId));
  if (inRoom && !elsewhere) {
    throw new RoomRuleError(`session ${sessionId} is already a participant of room ${roomId}`);
  }

  leaveOtherRooms(map, sessionId, roomId);
  if (!inRoom) room.members.push(sessionId);
  return addSystemMessage(map, roomId, `${sessionMention(sessionId)} joined the room`, at);
}

/**
 * Ведущий вводит сессию в свою комнату (MCP `add_to_room`). Правила `addMember` те же — закрытая,
 * чужая (нет в карте этой работы) сессия, уже участник, одна комната на сессию, системная строка
 * «@s04 joined the room», — плюс два своих: комната живая и вводит тот, кто ведёт её сейчас
 * (`liveLead`: назначенный, пока жив, иначе первый живой участник). Порядок проверок как у
 * `setProposal`: у закрытой комнаты ведущего нет вовсе, и отказ «закрыта» точнее, чем «не ведущий».
 * Письма о добавлении новому участнику `addMember` не пишет — как и при `rooms.addMember` из окна.
 */
export function addMemberByLead(
  map: WorkMap,
  roomId: string,
  leadId: string,
  sessionId: string,
  at = new Date().toISOString(),
): Message {
  const room = requireOpenRoom(map, roomId);
  if (isRoomClosed(map, room)) {
    throw new RoomRuleError(`room ${roomId} is closed: it has no live participants`);
  }
  if (liveLead(map, room) !== leadId) {
    throw new RoomRuleError(
      `session ${leadId} is not the lead of room ${roomId}: only the lead can bring a session into the room`,
    );
  }
  return addMember(map, roomId, sessionId, at);
}

/**
 * Системная строка «Room created from @s03 and @s02»: комнату собрали из двух сессий, уже
 * идущих в работе (дизайн комнат, 2.5, диалог 1.6). Писать её может только хост, поэтому окно
 * присылает пару в `rooms.create.origin`. Порядок пары — порядок в строке. Как и прочие системные
 * строки, никого не будит и человеку непрочитанной не значится (`addSystemMessage`).
 */
export function addRoomOriginMessage(
  map: WorkMap,
  roomId: string,
  origin: readonly [string, string],
  at = new Date().toISOString(),
): Message {
  const [first, second] = origin;
  const text = `Room created from ${sessionMention(first)} and ${sessionMention(second)}`;
  return addSystemMessage(map, roomId, text, at);
}

/** Комната карты по id; нет такой — отказ запроса. */
function findRoom(map: WorkMap, roomId: string): Room {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new RoomRuleError(`room ${roomId} is not in the map`);
  return room;
}

/**
 * Комната карты для записи в неё: найденная, а для архивной — отказ `RoomRuleError`, который хост отдаёт окну как
 * `bad_request`, а агенту текстом ошибки. Единой точки поиска комнаты в коде нет, поэтому этот хелпер ставят на пути
 * записи (письмо, вход в комнату, решение, план, режим, ведущий); пути чтения — лента, `get_map {room}`, страницы писем —
 * его не зовут. `addSystemMessage` и `addMessage` проверки не делают: строки об архивации и возврате должны проходить.
 */
export function requireOpenRoom(map: WorkMap, roomId: string): Room {
  const room = findRoom(map, roomId);
  if (isRoomArchived(room)) throw new RoomRuleError(`room ${roomId} is archived: only the human can reopen it`);
  return room;
}

/**
 * Края названия: пробелы и невидимые символы формата (ZWSP, ZWNJ, ZWJ, WJ, BOM) — то же правило, что у названия
 * работы (`renameWork` в `store.ts`) и у схемы `rooms.rename` протокола. Копия, а не импорт: `store.ts` тянет диск,
 * а этот модуль — чистые правила карты.
 */
const TITLE_EDGES = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

/**
 * Человек переименовывает комнату из сайдбара (`rooms.rename`). Края обрезаются; пустое название — отказ, прежнее
 * остаётся. Системной строки в ленте нет: это не событие разговора, а вкладка, шапка комнаты и строка сайдбара
 * читают название из карты и сами покажут новое.
 */
export function renameRoom(map: WorkMap, roomId: string, title: string): void {
  const room = findRoom(map, roomId);
  const trimmed = title.replace(TITLE_EDGES, '');
  if (trimmed === '') throw new RoomRuleError('room title is empty');
  room.title = trimmed;
}

/**
 * Человек переименовывает сессию из меню её строки (`sessions.rename`). Края обрезаются по тому же правилу, что у
 * комнаты; пустое имя — отказ, прежнее остаётся. Закрытую сессию переименовать можно: строка в сайдбаре остаётся. Как
 * и у комнаты, системной строки в ленте нет; агенты увидят новое имя в `get_map` и в брифе при следующей сверке.
 */
export function renameSession(map: WorkMap, sessionId: string, label: string): void {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new RoomRuleError(`session ${sessionId} is not in the map`);
  const trimmed = label.replace(TITLE_EDGES, '');
  if (trimmed === '') throw new RoomRuleError('session label is empty');
  session.label = trimmed;
}

/**
 * Письмо `parley` в комнате по действию человека. Человеку непрочитанным не значится — его отметка стоит с самой
 * записи, как у системной строки (`addSystemMessage`): о том, что сделал сам, «нового» у него быть не должно.
 * Адресату-сессии письмо непрочитано и будит её обычным будильником.
 */
function parleyNote(map: WorkMap, roomId: string, to: string, text: string, at: string): Message {
  const message = addMessage(map, { from: PARLEY, to: [to], roomId, kind: 'note', text }, at);
  message.readBy[HUMAN] = at;
  return message;
}

export interface LeadChange {
  /** Системная строка ленты «@s03 is now the lead» — для человека. */
  line: Message;
  /** Письма `parley` в комнате: новому ведущему и, если был живой прежний, ему. */
  letters: Message[];
}

/**
 * Человек назначает ведущего из сайдбара («Make lead», `rooms.setLead`). Ведущим становится участник комнаты
 * (создатель-сессия тоже), не закрытый и не ведущий уже: «уже» — по `liveLead`, то есть тот, у кого в окне `★`.
 * Запись — `room.lead`; человеку — системная строка «@s03 is now the lead»; новому ведущему и прежнему живому —
 * письма от `parley` в комнате: сами агенты о смене не узнали бы, `get_map` без повода они не перечитывают.
 *
 * Ждущее решение прежнего ведущего остаётся в слоте (то же правило, что у `leaveOtherRooms`): человек ответит на
 * него как на любое, а письмо о принятии или возврате пойдёт уже новому ведущему (`resolveProposal`). Плейбук
 * рецепта новому ведущему пишет вызывающий — `reconcileRecipeLeads`, общий для любой смены ведущего.
 */
export function setRoomLead(
  map: WorkMap,
  roomId: string,
  sessionId: string,
  at = new Date().toISOString(),
): LeadChange {
  const room = requireOpenRoom(map, roomId);
  if (sessionId === HUMAN || !isMember(room, sessionId)) {
    throw new RoomRuleError(`session ${sessionId} is not a participant of room ${roomId}`);
  }
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new RoomRuleError(`session ${sessionId} is not in the map`);
  if (session.lifecycle === 'closed') throw new RoomRuleError(`session ${sessionId} is closed`);
  const previous = liveLead(map, room);
  if (previous === sessionId) throw new RoomRuleError(`session ${sessionId} already leads room ${roomId}`);

  room.lead = sessionId;
  const line = addSystemMessage(map, roomId, `${sessionMention(sessionId)} is now the lead`, at);
  const where = `room ${room.id} "${room.title}"`;
  const letters = [
    parleyNote(
      map,
      roomId,
      sessionId,
      `You now lead ${where}: the human made you the lead. Collect the participants' positions and bring the human a decision with propose_decision (read_guide topic: lead).`,
      at,
    ),
  ];
  if (previous !== null) {
    letters.push(
      parleyNote(
        map,
        roomId,
        previous,
        `${sessionMention(sessionId)} now leads ${where}: the human changed the lead. You are a regular participant now (read_guide topic: member).`,
        at,
      ),
    );
  }
  return { line, letters };
}

/**
 * Человек удаляет комнату из сайдбара (`rooms.delete`). Из карты уходит комната и всё, что держится за её id: лента
 * (письма с её `roomId`), решение в слоте (оно в самой комнате), планы комнаты, их записи доставки (`planEffects`),
 * отметки закрытия бэклога этих планов (`planBacklogIntents`: без своего плана они не проходят проверку карты) и
 * счётчик сессий комнаты в журнале ресурсов; попытки журнала остаются в бюджете работы, но уже без комнаты.
 * Остаются журналы принятого — `planExports` и `decisionExports`: это снятые копии фактов, которые хост дописывает в
 * общий `.parley` (решения, снимки планов), а написанное туда комната с собой не уносит.
 *
 * Сессии комнаты остаются обычными сессиями работы. Каждому живому участнику (`active` или `sleeping`: ещё не
 * запущенный о комнате и не знал), который не числится в другой комнате (старая карта), — прямое письмо от `parley`:
 * комнаты больше нет, дальше он работает сам по себе. Будит адресатов обычный будильник. Номера комнаты, писем,
 * решения и планов не переиспользуются: счётчики работы запоминают их до удаления записей, как `removeSession` —
 * номер сессии. Возвращает эти письма.
 */
export function deleteRoom(map: WorkMap, roomId: string, at = new Date().toISOString()): Message[] {
  const room = findRoom(map, roomId);
  const plans = new Set((map.plans ?? []).filter((plan) => plan.roomId === roomId).map((plan) => plan.id));
  const { work } = map;
  work.roomSeq = Math.max(work.roomSeq ?? 0, maxNumber([room.id], 'r-'));
  work.messageSeq = Math.max(work.messageSeq ?? 0, maxNumber(map.messages.map((message) => message.id), 'm-'));
  if (room.proposal !== null) work.proposalSeq = Math.max(work.proposalSeq ?? 0, maxNumber([room.proposal.id], 'p-'));
  if (plans.size > 0) work.planSeq = Math.max(work.planSeq ?? 0, maxNumber([...plans], 'pl-'));

  map.rooms = map.rooms.filter((candidate) => candidate !== room);
  map.messages = map.messages.filter((message) => message.roomId !== roomId);
  if (map.plans !== undefined) map.plans = map.plans.filter((plan) => plan.roomId !== roomId);
  if (map.planEffects !== undefined) map.planEffects = map.planEffects.filter((effect) => effect.roomId !== roomId);
  if (map.planBacklogIntents !== undefined) {
    map.planBacklogIntents = map.planBacklogIntents.filter((intent) => !plans.has(intent.planId));
  }
  if (map.resources !== undefined) {
    delete map.resources.spawnedByRoom[roomId];
    for (const attempt of map.resources.attempts) if (attempt.room === roomId) attempt.room = null;
  }

  const text = `The human deleted room ${room.id} "${room.title}": you now work as a regular session of this workspace.`;
  // Участников архивной комнаты архивация могла усыпить: прощальное письмо спящему подняло бы его будильником, поэтому
  // у архивной комнаты письмо получают только работающие (спека архива комнат, 3.6).
  const archived = isRoomArchived(room);
  const notified = [...new Set([room.creator, ...room.members])].filter(
    (id) =>
      map.sessions.some(
        (session) => session.id === id && (session.lifecycle === 'active' || (session.lifecycle === 'sleeping' && !archived)),
      ) &&
      !map.rooms.some((other) => isMember(other, id)),
  );
  return notified.map((id) => addMessage(map, { from: PARLEY, to: [id], text }, at));
}

/**
 * Человек архивирует комнату (`rooms.archive`): лента остаётся и читается, писать в неё нельзя (`requireOpenRoom`),
 * пока комнату не вернут (`reopenRoom`). Повторный вызов для архивной комнаты ничего не меняет и пустой список отдаёт.
 *
 * Сначала закрывается незавершённое и пишется строка в ленту, и только потом ставится `archivedAt`. Живой план
 * (`active`, `completing`) отменяется как в `cancelRoomPlan` (`cancelActiveRoomPlan`), его неотправленные доставки
 * (`planEffects` в `queued`) снимаются, а слот `proposal` очищается без ответа — как у плана закрытой комнаты в
 * `reconcileRoomPlans`. Затем в ленту ложится строка «Room archived by the human.».
 *
 * Возвращает id сессий, которых архивация оставила без открытой комнаты: участники (создатель-сессия и `members`, без
 * человека и без сессий, которых уже нет в карте), не числящиеся в другой неархивной комнате. Правило то же, что у
 * прощальных писем `deleteRoom`. Остановить их и написать им, кого не остановили, — дело хоста.
 */
export function archiveRoom(map: WorkMap, roomId: string, at = new Date().toISOString()): string[] {
  if (isRoomArchived(findRoom(map, roomId))) return [];

  cancelActiveRoomPlan(map, roomId, at);
  for (const effect of map.planEffects ?? []) {
    if (effect.roomId === roomId && effect.status === 'queued') effect.status = 'cancelled';
  }
  // Отмена плана подменяет `map.rooms` копией (`edit` в plans.ts): запись комнаты ищем заново, а не держим прежнюю ссылку.
  const room = findRoom(map, roomId);
  room.proposal = null;
  addSystemMessage(map, roomId, 'Room archived by the human.', at);
  room.archivedAt = at;

  return [...new Set([room.creator, ...room.members])].filter(
    (id) =>
      id !== HUMAN &&
      map.sessions.some((session) => session.id === id) &&
      !map.rooms.some((other) => other.id !== roomId && !isRoomArchived(other) && isMember(other, id)),
  );
}

/**
 * Письма `parley` сессиям, которых архивация комнаты оставила без открытой комнаты, а они продолжают работать
 * (`rooms.archive` без остановки агентов, спека архива комнат, 3.6): «Room "<title>" was archived by the human. You are
 * no longer in an open room.». Образец — прощальные письма `deleteRoom`, но письмо получает только сессия `active`:
 * спящую оно подняло бы обратно (будильник будит адресата непрочитанного письма), закрытой и ещё не запущенной оно ни
 * к чему. Какие из `active` живы процессом, знает хост, и остановленных им сессий он сюда не передаёт. `sessionIds` —
 * результат `archiveRoom` той же мутации; сессия, ставшая участницей другой открытой комнаты, письма не получает: оно
 * бы лгало. Комната должна быть в карте (название берётся из неё). Возвращает письма.
 */
export function addRoomArchivedLetters(
  map: WorkMap,
  roomId: string,
  sessionIds: readonly string[],
  at = new Date().toISOString(),
): Message[] {
  const room = findRoom(map, roomId);
  const text = `Room "${room.title}" was archived by the human. You are no longer in an open room.`;
  return [...new Set(sessionIds)]
    .filter(
      (id) =>
        map.sessions.some((session) => session.id === id && session.lifecycle === 'active') &&
        !map.rooms.some((other) => !isRoomArchived(other) && isMember(other, id)),
    )
    .map((id) => addMessage(map, { from: PARLEY, to: [id], text }, at));
}

/**
 * Человек возвращает комнату из архива (`rooms.reopen`): `archivedAt` снова `null`, в ленте строка «Room reopened by
 * the human.». Сессии сами не поднимаются, как и при Reopen работы; в комнате остаются те, кто в ней числился (правило
 * одной комнаты `leaveOtherRooms` архивную комнату не обходит). Открытая комната — ничего не меняет.
 *
 * Письма ленты, не прочитанные до архивации, после возврата снова стали бы непрочитанными (`recipientsOf`) и будильник
 * поднял бы спящих участников — поэтому старые письма комнаты помечаются прочитанными её участниками.
 */
export function reopenRoom(map: WorkMap, roomId: string, at = new Date().toISOString()): void {
  const room = findRoom(map, roomId);
  if (!isRoomArchived(room)) return;
  room.archivedAt = null;
  for (const message of map.messages) {
    if (message.roomId !== roomId) continue;
    for (const id of recipientsOf(message, map)) message.readBy[id] ??= at;
  }
  addSystemMessage(map, roomId, 'Room reopened by the human.', at);
}

/**
 * Участник ли комнаты: создатель — всегда, человек — всегда (спецификация 6.1:
 * «человек — участник всегда и в список не пишется»), иначе — по списку `members`.
 */
export function isMember(room: Room, id: string): boolean {
  return id === HUMAN || id === room.creator || room.members.includes(id);
}

/** Список тегов через запятую, последний — через `and`: `S03`, `S03 and S05`. */
function joinTags(tags: readonly string[]): string {
  if (tags.length <= 1) return tags[0] ?? '';
  return `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}

/**
 * Тег участника для письма-приглашения: короткий `S03`, а не ярлык роли — письмо
 * это не бриф, а быстрая пометка «кто ещё здесь» (спецификация 6.2).  Участника,
 * которого успели удалить между записями, помечаем отдельно: он есть в списке
 * комнаты навсегда (раздел 10), но откликнуться уже не может.
 */
function memberTag(map: WorkMap, id: string): string {
  const deleted = (map.work.deletedSessions ?? []).includes(id);
  return deleted ? `${sessionTag(id)} (deleted)` : sessionTag(id);
}

/** Текст письма-приглашения в комнату: `You were added to r-01 "<title>" with S03 and S05`. */
export function joinNotice(room: Room, map: WorkMap): string {
  const tags = room.members.map((id) => memberTag(map, id));
  return `You were added to ${room.id} "${room.title}" with ${joinTags(tags)}`;
}

/**
 * Потомок ли сессия `id` по цепочке `parent` от `ancestor`. Сессия себе не
 * потомок: `close_session` разрешает цель либо равенством себе, либо этой
 * проверкой — смешивать их незачем.
 */
export function isDescendant(map: WorkMap, ancestor: string, id: string): boolean {
  const byId = new Map(map.sessions.map((session) => [session.id, session]));
  let current = byId.get(id);
  while (current !== undefined && current.parent !== null) {
    if (current.parent === ancestor) return true;
    current = byId.get(current.parent);
  }
  return false;
}
