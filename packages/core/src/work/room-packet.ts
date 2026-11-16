import { PACKET_LIMITS, PACKET_MAX_BYTES, PACKET_MAX_DECISIONS, contextBytes, inlineOrRef, textHash } from './context-budget.js';
import type { DecisionJournalIntent, DecisionJournalMap } from './decision-journal.js';
import type { LetterReads } from './letter-store.js';
import { recipientsOf } from './letters.js';
import { activeRoomPlan } from './plans.js';
import { isRoomClosed, liveLead } from './rooms.js';
import { exportTitle } from './stored-texts.js';
import type { PlanItem, Room, RoomPlan } from './types.js';

/**
 * Пакет состояния комнаты (спека 2026-11-16, 3.1–3.3): выжимка того, что сейчас действует в комнате, из хранилища.
 * Каждая строка — поле карты или ссылка на него; пересказов и модели нет. Функция чистая: карту, письма, имена
 * инструментов и время ей отдают снаружи.
 */

/** Кто смотрит: участник комнаты либо её владелец вне состава. Проекцию владельца функция строит сама. */
export type PacketViewer = { kind: 'member'; sessionId: string } | { kind: 'owner'; sessionId: string };
export interface PacketTarget { roomId: string; viewer: PacketViewer }
export type PacketRefusalReason = 'no-room' | 'room-closed' | 'not-participant';
export type RoomPacketResult =
  | { ok: true; text: string; revision: string; bytes: number }
  | { ok: false; reason: PacketRefusalReason; message: string };

const FIRST_LINE_SUFFIX = 'Data from the Parley store; verify with get_map before acting on it.';
/** Сколько последних писем комнаты просматривается в поиске вопросов; письма старше в раздел не попадают и называются в нём. */
export const QUESTION_SCAN_LETTERS = 1000;

/** Раздел: обязательная голова и список, который может не влезть целиком. */
interface Section {
  head: string[];
  items: string[];
  /** Строки после списка, обязательные как голова: например, что просмотрена не вся комната. */
  tail?: string[];
  /** Разделитель элементов: `\n` — строка на элемент, `, ` — все в одной строке. */
  join: '\n' | ', ';
  /** Строка о непоказанных элементах и способе прочитать остальные. */
  more: (hidden: number) => string;
  /** Элементы, которых нет в `items` из-за собственного предела раздела; они входят в число непоказанных. */
  extra?: number;
}

/** Перевод строки в бюджете весит два байта: `contextBytes` считает текст после JSON-экранирования. */
const NEWLINE = 2;

const quote = (value: string): string => JSON.stringify(value);

/** Поле хранилища в пределах: влезло — в кавычках как есть, иначе ограниченная ссылка (`inlineOrRef`). */
function field(what: string, value: string, limit: number, where: string): string {
  const bounded = inlineOrRef(what, value, limit, where);
  return bounded === value ? quote(value) : bounded;
}

const refuse = (reason: PacketRefusalReason, message: string): RoomPacketResult => ({ ok: false, reason, message });

const none = (head: string[]): Section => ({ head, items: [], join: '\n', more: () => '' });

const decisionTitle = (intent: DecisionJournalIntent): string => intent.title ?? exportTitle(intent.content ?? '');

/** Принятые решения комнаты: от новых к старым, переделанное до принятия — одной записью (с наибольшей ревизией). */
function roomDecisions(map: DecisionJournalMap, roomId: string): DecisionJournalIntent[] {
  const byProposal = new Map<string, DecisionJournalIntent>();
  for (const intent of map.decisionExports ?? []) {
    if (intent.roomId !== roomId) continue;
    const kept = byProposal.get(intent.proposalId);
    if (kept === undefined || intent.rev > kept.rev) byProposal.set(intent.proposalId, intent);
  }
  return [...byProposal.values()].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.file.localeCompare(a.file));
}

/**
 * Вопросы комнаты, адресованные сессии, без её собственного сообщения с `replyTo` на них; id, новые первыми. Просматриваются
 * последние `QUESTION_SCAN_LETTERS` писем комнаты: ответ старше вопроса его не снимает, поэтому и вопросов старше окна
 * пакет не ищет. `truncated` — в комнате писем больше, чем просмотрено.
 */
function openQuestions(map: DecisionJournalMap, letters: LetterReads, roomId: string, sessionId: string): { ids: string[]; truncated: boolean } {
  const window = letters.query({ roomId, newestFirst: true, limit: QUESTION_SCAN_LETTERS });
  const answered = new Set<string>();
  for (const message of window) if (message.from === sessionId && message.replyTo !== undefined) answered.add(message.replyTo);
  const ids = window
    .filter((message) => message.kind === 'question' && message.deleted !== true && message.from !== sessionId && !answered.has(message.id) && recipientsOf(message, map).includes(sessionId))
    .map((message) => message.id);
  return { ids, truncated: window.length === QUESTION_SCAN_LETTERS && letters.count({ roomId }) > QUESTION_SCAN_LETTERS };
}

/** План: голова с целью и числом остальных пунктов по статусам; пункты сессии — списком (у владельца вне состава их нет). */
function planSection(plan: RoomPlan, sessionId: string | null): Section {
  const where = `get_map {field: "plan", id: "${plan.id}", rev: ${plan.rev}}`;
  const roles = (item: PlanItem): string[] => [
    ...(sessionId !== null && item.owner === sessionId ? ['owner'] : []),
    ...(sessionId !== null && item.verifier === sessionId ? ['verifier'] : []),
  ];
  const own = plan.items.filter((item) => roles(item).length > 0);
  const counts = new Map<string, number>();
  for (const item of plan.items) if (!own.includes(item)) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const head = [
    '## Plan',
    `Plan ${plan.id} rev ${plan.rev}, ${plan.mode}, ${plan.status}. Goal: ${field('plan goal', plan.goal, PACKET_LIMITS.planGoal, where)}`,
  ];
  if (counts.size > 0) head.push(`${sessionId === null ? 'Items' : 'Other items'}: ${[...counts].map(([status, count]) => `${count} ${status}`).join(', ')}.`);
  return {
    head,
    items: own.map((item) => `- item ${item.id} [${item.status}] as ${roles(item).join(' and ')}: ${field('item title', item.title, PACKET_LIMITS.planItem, where)}`),
    join: '\n',
    more: (hidden) => `… and ${hidden} more: ${where}`,
  };
}

/**
 * Сборка. Порядок разделов в тексте постоянный (спека 3.2), порядок заполнения бюджета другой: план, вопросы, инструменты,
 * затем решения — им отдаётся остаток (спека 3.3). Раздел, не влезший в `PACKET_MAX_BYTES`, кончается строкой «… and K more».
 * Головы разделов обязательны и малы по построению: их поля ограничены `PACKET_LIMITS`.
 */
export function buildRoomPacket(
  map: DecisionJournalMap,
  target: PacketTarget,
  letters: LetterReads,
  toolNames: readonly string[],
  at: string,
): RoomPacketResult {
  const room: Room | undefined = map.rooms.find((candidate) => candidate.id === target.roomId);
  if (room === undefined) return refuse('no-room', `room ${target.roomId} is not in the map`);
  if (isRoomClosed(map, room)) return refuse('room-closed', `room ${room.id} is closed`);
  const { viewer } = target;
  const allowed = viewer.kind === 'member' ? room.members.includes(viewer.sessionId) : room.ownerId === viewer.sessionId;
  if (!allowed) return refuse('not-participant', `room ${room.id} is not available to session ${viewer.sessionId}`);
  const member = viewer.kind === 'member';
  const roomWhere = `get_map {room: "${room.id}"}`;

  // Раздел 1. Заголовок: работа, комната, смотрящий. Эти данные входят в ревизию.
  const header = none([`Work ${map.work.id} ${field('work title', map.work.title, PACKET_LIMITS.title, 'get_map {field: "title"}')}; room ${room.id} ${field('room title', room.title, PACKET_LIMITS.title, roomWhere)}; viewer: ${viewer.kind} ${viewer.sessionId}.`]);

  // Раздел 2. Место сессии; у владельца вне состава его нет.
  let place: Section | undefined;
  if (member) {
    const lead = liveLead(map, room);
    place = none(['## Place', `You are ${viewer.sessionId}, ${lead === viewer.sessionId ? 'lead' : 'participant'} of room ${room.id}; lead: ${lead ?? 'none'}; room mode: ${room.mode ?? 'free'}.`]);
  }

  // Раздел 3. План: только действующий; отменённый и ещё не принятый в пакет не попадают.
  const plan = activeRoomPlan(map, room.id);
  const planPart = plan === undefined ? undefined : planSection(plan, member ? viewer.sessionId : null);

  // Раздел 4. Решение, которое ждёт человека.
  const proposal = room.proposal === null ? undefined
    : none(['## Waiting for the human', `${room.proposal.kind ?? 'decision'} ${room.proposal.id} rev ${room.proposal.rev} from ${room.proposal.from}; read it: ${roomWhere}`]);

  // Раздел 5. История принятых решений. Читаются письмами-решениями комнаты через `get_map`, а не файлами: каталог журнала
  // лежит в корне проекта, сессия может работать в worktree, а номер комнаты повторяется в разных рабочих областях.
  const decisions = roomDecisions(map, room.id);
  const decisionsWhere = `get_map {room: "${room.id}", field: "messages", kind: "decision"}`;
  const shown = decisions.slice(0, PACKET_MAX_DECISIONS);
  const decisionsPart: Section | undefined = decisions.length === 0 ? undefined : {
    head: ['## Accepted decisions', `Newest first; a later decision may have changed an earlier one. ${decisions.length} accepted in this room.`],
    items: shown.map((intent) => `- ${intent.proposalId} rev ${intent.rev}${intent.kind === 'completion' ? ' (completion)' : ''}, ${intent.acceptedAt.slice(0, 10)}: ${field('decision title', decisionTitle(intent), PACKET_LIMITS.decisionTitle, decisionsWhere)}`),
    join: '\n',
    more: (hidden) => `… and ${hidden} more: ${decisionsWhere}`,
    extra: decisions.length - shown.length,
  };

  // Раздел 6. Вопросы сессии без её ответа по `replyTo`.
  const questions = member ? openQuestions(map, letters, room.id, viewer.sessionId) : { ids: [], truncated: false };
  const questionsPart: Section | undefined = questions.ids.length === 0 && !questions.truncated ? undefined : {
    head: ['## Open questions', 'Questions in this room addressed to you with no reply from you carrying replyTo; an answer without replyTo is not visible here. Read one: get_map {field: "message", id: "<id>"}.'],
    items: questions.ids,
    tail: questions.truncated ? [`Only the last ${QUESTION_SCAN_LETTERS} letters of this room were scanned; earlier letters were not: get_map {room: "${room.id}", field: "messages", kind: "question"}.`] : [],
    join: ', ',
    more: (hidden) => `… and ${hidden} more: get_map {room: "${room.id}", field: "messages", kind: "question"}`,
  };

  // Раздел 7. Инструменты.
  const toolsPart: Section | undefined = !member || toolNames.length === 0 ? undefined : {
    head: ['## Tools', 'Parley tools available to you; load each tool schema before calling it.'],
    items: [...toolNames],
    join: ', ',
    more: (hidden) => `… and ${hidden} more: list the tools of your MCP client`,
  };

  const ordered = [header, place, planPart, proposal, decisionsPart, questionsPart, toolsPart].filter((part): part is Section => part !== undefined);
  const fillOrder = [planPart, questionsPart, toolsPart, decisionsPart].filter((part): part is Section => part !== undefined);

  // Бюджет. Сначала головы всех разделов и запас под строку «more» каждого списка, затем списки по очереди заменяют свой
  // запас тем, что влезло. Строка элемента и строка «more» стоят после перевода строки; запятая с пробелом весит как он.
  const first = `Room state packet ${'0'.repeat(12)}, ${room.id}, ${at}. ${FIRST_LINE_SUFFIX}`;
  const hiddenOf = (section: Section, shown: number): number => section.items.length - shown + (section.extra ?? 0);
  const moreCost = (section: Section, shown: number): number => NEWLINE + contextBytes(section.more(hiddenOf(section, shown)));
  const reserve = (section: Section): number => (hiddenOf(section, 0) > 0 ? moreCost(section, 0) : 0);
  let used = contextBytes(first) + NEWLINE + (ordered.length - 1) * 2 * NEWLINE + NEWLINE
    + ordered.reduce((sum, section) => sum + contextBytes([...section.head, ...(section.tail ?? [])].join('\n')) + reserve(section), 0);
  const taken = new Map<Section, number>();
  for (const section of fillOrder) {
    used -= reserve(section);
    const total = section.items.length;
    let accepted = 0;
    let added = 0;
    for (let index = 0; index < total; index += 1) {
      const cost = contextBytes(section.items[index]!) + NEWLINE;
      const more = hiddenOf(section, index + 1) > 0 ? moreCost(section, index + 1) : 0;
      if (used + added + cost + more > PACKET_MAX_BYTES) break;
      added += cost;
      accepted += 1;
    }
    if (hiddenOf(section, accepted) > 0) added += moreCost(section, accepted);
    used += added;
    taken.set(section, accepted);
  }

  const render = (section: Section): string => {
    const count = taken.get(section) ?? 0;
    const lines = [...section.head];
    if (count > 0) lines.push(section.items.slice(0, count).join(section.join));
    if (hiddenOf(section, count) > 0) lines.push(section.more(hiddenOf(section, count)));
    lines.push(...(section.tail ?? []));
    return lines.join('\n');
  };
  // Ревизия — хеш содержимого без первой строки: время сборки и сама отметка в хеш не входят, работа, комната и смотрящий — входят.
  const body = ordered.map(render).join('\n\n');
  const revision = textHash(body);
  const text = `Room state packet ${revision}, ${room.id}, ${at}. ${FIRST_LINE_SUFFIX}\n${body}\n`;
  return { ok: true, text, revision, bytes: contextBytes(text) };
}
