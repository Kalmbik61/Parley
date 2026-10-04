/**
 * Модель вкладки комнаты (спека окна 2026-09-29, 1.3, 2.4): из карты работы — шапка с подзаголовком,
 * лента участников, сообщения с адресатами и строкой доставки, блок `Decisions`, карточка решения.
 * Чистая функция без React: `RoomPanel.tsx` рисует то, что она вернула.
 *
 * Вместо прежнего `roomView` из `lib/room-view.ts` (удалён): тому нужны были письма-строки `LetterView`,
 * а здесь у сообщения свои поля — отправитель для аватара, `★` ведущего, адресаты без человека,
 * доставка агентам. Правило ведущего — `roomLiveLead` (`lib/room-lead.ts`), общая копия `liveLead` из core;
 * своей здесь нет (решение контролёра 1).
 *
 * Модель участника — из живых метрик (`activity.changed`, `metrics.model`), как её брал `RoomBody` до этого
 * куска: короткое имя с версией (`Opus 5.5`). Усилие не показывается — его никто не хранит. Пока сессия
 * ничего не написала и модель неизвестна, у участника её нет (`null`).
 *
 * Чем занят участник (`doing`, `doingDetail`) — из тех же метрик (`tasks`, `waitingFor`, Parley 0.2.0): живой
 * субагент или ожидание `wait_for`. Только у живой сессии: у закрытой и спящей метрики — след прошлого процесса.
 * `agents` — те же субагенты списком для поповера на строке `doing` (кусок 4b плана 2026-10-01).
 *
 * Доставка (`MessageModel.delivery`): по каждому не закрытому адресату-агенту — забрал ли он сообщение (`readBy`, с
 * временем) или ещё нет; у ждущего есть причина из живых метрик сессии (`metrics.mailWaiting`). Хост прежней версии
 * поля не присылает — тогда причины нет (`null`), и окно пишет один тег.
 *
 * Ответ (`Message.replyTo`, Parley 0.3.0): у сообщения-ответа модель несёт цитату — подпись и выдержку оригинала
 * (`replyExcerpt`: тот же разбор Markdown, что у ленты, и то же правило `@human` по отправителю — у сообщения человека
 * он остаётся текстом), если он лежит в этой же комнате, и пометку «оригинала нет», если нет.
 */

import type { Message, MessageKind, SessionLifecycle, WorkEntry, WorkMap, RoomMode, RoomPlan } from '@parley/core';
import { refKey, type LiveTask, type MailWait } from '@parley/protocol';
import { S, providerName } from '../../../shared/strings.js';
import {
  isHumanMention,
  isHumanUnread,
  sessionAttention,
  type Attention,
} from '../../attention/derive.js';
import { displayStatus, dotState, stateWord, type DotState } from '../../lib/dot-state.js';
import { DECISIONS_SHOWN, recipientsOf } from '../../lib/mail-view.js';
import { sessionLabelText, sessionRowLabel, sessionTag, workTitleText } from '../../lib/participant.js';
import { modelName } from '../../lib/participant-tag.js';
import { roomLiveLead } from '../../lib/room-lead.js';
import type { ActivityEntry } from '../../store/activity.js';
import { replyExcerpt } from './excerpt.js';

// Те же литералы, что `HUMAN` и `SYSTEM` в `core/work/types.ts`: из core рендерер берёт только типы.
const HUMAN = 'human';
const SYSTEM = 'system';
const PARLEY = 'parley';

export type SenderKind = 'human' | 'system' | 'agent';

/** Участник комнаты — карточка ленты участников, пункт меню упоминаний. */
export interface ParticipantModel {
  id: string;
  role?: import('@parley/core').SessionRole | null;
  roleRevision?: string;
  sessionRef?: import('@parley/protocol').SessionRef;
  /** `S02 бэкенд`. */
  label: string;
  /** Ярлык без номера (`бэкенд`) — для фильтра меню упоминаний. */
  rawLabel: string;
  provider: string;
  /** `Claude Code`. */
  providerName: string;
  /**
   * Модель сессии из живых метрик — `Opus 5.5`, `GPT-5.5`. `null`: модель неизвестна или имя лишь повторяет
   * провайдера (`gpt-5.2-codex` у Codex — «Codex · Codex» ничего не добавило бы).
   */
  model: string | null;
  state: DotState;
  lifecycle: SessionLifecycle;
  /** Слово состояния: `working`, `needs you`… */
  word: string;
  /** Подкраска карточки: `needs-you` — `accent-200`, `unseen` — `accent-2-200`. */
  attention: Attention;
  task: string;
  /**
   * Чем занят сейчас: `Subagent: Orca research`, `3 subagents: …`, `Waiting for S03`, `Waiting for messages`.
   * `null` — ничем особым (или хост прежней версии не прислал данных); карточка тогда показывает задачу.
   */
  doing: string | null;
  /** Полный список для подсказки: все субагенты по строке, ожидание — первой; `null`, когда `doing` пуст. */
  doingDetail: string | null;
  /**
   * Живые субагенты для поповера на строке `doing` (кусок 4b). Не пусто, только когда `doing` — сама строка субагентов:
   * ожидание `wait_for` важнее, и тогда субагенты видны лишь в подсказке.
   */
  agents: readonly LiveTask[];
  lead: boolean;
  /** Закрытая сессия: в ленте участников есть, а в меню упоминаний нет. */
  closed: boolean;
}

/** Цитата над сообщением-ответом: на что оно отвечает. */
export interface ReplyModel {
  /** Id оригинала — по нему кнопка цитаты ведёт к сообщению. */
  id: string;
  /** Подпись отправителя оригинала, как в ленте: `You`, `Parley`, `S02 бэкенд`. У пропавшего оригинала — пусто. */
  from: string;
  /** Выдержка из текста оригинала (`replyExcerpt`). Пусто у пропавшего и у оригинала без текста — цитата тогда одна подпись. */
  excerpt: string;
  /** Оригинал лежит в этой же комнате. */
  found: boolean;
}

export interface MessageModel {
  id: string;
  /** Для аватара; `provider` — только у агента с известной сессией. */
  sender: { kind: SenderKind; provider: string | null };
  /** Подпись отправителя: `You`, `System`, `S02 бэкенд`. */
  from: string;
  /** Отправитель — ведущий (`★`). */
  lead: boolean;
  /** Адресаты для `→ …`: `all` или ярлыки; `null` — у системной строки адресата не показываем. */
  to: string | null;
  kind: MessageKind;
  at: string;
  text: string;
  /** Точка «непрочитано» — по человеку; у системной строки её нет. */
  unread: boolean;
  /**
   * Человек это сообщение ещё не прочёл (`isHumanUnread`) — кандидат в `mail.markRead`. От `unread`
   * отличается системной строкой: точки у неё нет, а счётчик сайдбара, пока она не отмечена, — есть.
   */
  needsRead: boolean;
  /**
   * Агент назвал человека в сообщении (`@human`) — по тому же правилу, что чип «@you» ленты и счётчик «для тебя»
   * (`isHumanMention`); прочитано оно или нет, говорит `unread`. Открытие комнаты ведёт к самому раннему непрочитанному
   * такому сообщению (`RoomPanel.tsx`).
   */
  mentionsYou: boolean;
  /**
   * Доставка не закрытым адресатам-агентам (человек и система сообщение не «забирают»; закрытая и удалённая сессия уже не
   * заберёт), в порядке адресатов (`recipientsOf`). `picked` — те, кто подхватил сообщение (`readBy`, `at` — время
   * отметки); `waiting` — кто ещё нет, `reason` — `metrics.mailWaiting` его сессии: `null`, пока хост причину не
   * прислал (хост прежней версии, метрик ещё нет).
   */
  delivery: {
    picked: Array<{ tag: string; at: string }>;
    waiting: Array<{ tag: string; reason: MailWait | null }>;
  };
  /** Цитата, если сообщение — ответ (`Message.replyTo`); `null` — не ответ. */
  reply: ReplyModel | null;
}

export interface ProposalModel {
  kind?: 'decision' | 'completion';
  plan?: RoomPlan;
  planId?: string;
  planRev?: number;
  id: string;
  /** Версия текста: растёт, когда ведущий заменяет решение до ответа человека. */
  rev: number;
  at: string;
  text: string;
  /** Подпись ведущего и его провайдер — для шапки карточки. */
  from: string;
  provider: string | null;
}

export interface DecisionItem {
  id: string;
  text: string;
  from: string;
}

export interface RoomModel {
  mode: RoomMode;
  plan: RoomPlan | null;
  title: string;
  subtitle: string;
  participants: ParticipantModel[];
  decisions: { shown: DecisionItem[]; earlier: number };
  messages: MessageModel[];
  proposal: ProposalModel | null;
  /** Ни сообщений, ни решения: показывается подсказка «Write the task for everyone below…». */
  empty: boolean;
}

export interface RoomModelInput {
  entry: WorkEntry;
  roomId: string;
  providers: ReadonlyArray<{ id: string; label: string }>;
  /** `useActivityStore.byRef`: живая активность по `refKey`. */
  activity: Readonly<Record<string, ActivityEntry>>;
}

/** Подпись участника переписки: человек, система, сессия с номером и ярлыком, удалённая, чужой id как есть. */
function labelOf(map: WorkMap, id: string): string {
  if (id === HUMAN) return S.participants.human;
  if (id === SYSTEM || id === PARLEY) return S.participants.system;
  const session = map.sessions.find((candidate) => candidate.id === id);
  if (session !== undefined) return sessionRowLabel(id, session.label);
  return (map.work.deletedSessions ?? []).includes(id) ? `${sessionTag(id)} ${S.participants.deletedSuffix}` : id;
}

function isAlive(map: WorkMap, id: string): boolean {
  return map.sessions.some((session) => session.id === id && session.lifecycle !== 'closed');
}

/** Провайдер сессии по id; `null` — сессии нет в карте (удалена или чужой id). */
function providerOf(map: WorkMap, id: string): string | null {
  return map.sessions.find((session) => session.id === id)?.provider ?? null;
}

/** Тот же литерал, что цель `wait_for("inbox")` в `core/mcp/tools.ts`: из core рендерер берёт только типы. */
const INBOX = 'inbox';

/**
 * Чем занят участник по данным хоста. В `doing` ожидание важнее субагентов: оно держит агента прямо сейчас,
 * а фоновые работают сами; в `doingDetail` попадают оба. Название субагента — описание, а без него тип агента.
 */
function doingOf(
  tasks: readonly LiveTask[],
  waitingFor: string | null,
): { doing: string | null; doingDetail: string | null; agents: readonly LiveTask[] } {
  const waiting =
    waitingFor === null
      ? null
      : waitingFor === INBOX
        ? S.rooms.doingWaitingInbox
        : S.rooms.doingWaitingFor(sessionTag(waitingFor));
  const names = tasks.map((task) => task.description ?? task.agentType);
  const first = names.find((name) => name !== null) ?? null;
  const subagents =
    tasks.length === 0
      ? null
      : tasks.length === 1
        ? S.rooms.doingSubagent(first)
        : S.rooms.doingSubagents(tasks.length, first);

  const doing = waiting ?? subagents;
  if (doing === null) return { doing: null, doingDetail: null, agents: [] };

  const lines = waiting === null ? [] : [waiting];
  if (tasks.length > 1) {
    lines.push(
      S.rooms.doingSubagents(tasks.length, null),
      ...names.map((name) => `• ${name ?? S.rooms.doingSubagent(null)}`),
    );
  } else if (subagents !== null) {
    lines.push(subagents);
  }
  return { doing, doingDetail: lines.join('\n'), agents: waiting === null ? tasks : [] };
}

export function buildRoomModel(input: RoomModelInput): RoomModel | null {
  const { entry, roomId, providers, activity } = input;
  const map = entry.map;
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) return null;

  const lead = roomLiveLead(map, room);

  /** Живая активность сессии (`activity.changed`); `undefined` — хост её ещё не присылал. */
  const liveOf = (sessionId: string): ActivityEntry | undefined =>
    activity[refKey({ projectPath: entry.projectPath, workId: map.work.id, sessionId })];

  // Создатель-сессия в `members` не пишется (`core/work/rooms.ts#addMember`), человек — участник всегда
  // и списком не хранится: агенты комнаты — создатель и члены без человека, каждый один раз.
  const memberIds = [...new Set([room.creator, ...room.members])].filter((id) => id !== HUMAN);
  const participants: ParticipantModel[] = [];
  for (const id of memberIds) {
    const session = map.sessions.find((candidate) => candidate.id === id);
    // Удалённая сессия в ленте участников не выводится: показать о ней нечего.
    if (session === undefined) continue;
    const liveEntry = liveOf(id);
    const live = liveEntry?.activity ?? null;
    const state = dotState(displayStatus(session), live?.activity ?? null);
    const providerDisplay = providerName(session.provider, providers.find((entryProvider) => entryProvider.id === session.provider)?.label ?? session.provider);
    const model = modelName(liveEntry?.metrics?.model ?? null);
    // Хост прежней версии полей не присылает — тогда участник ничем особым не занят.
    const { doing, doingDetail, agents } =
      session.lifecycle === 'active'
        ? doingOf(liveEntry?.metrics?.tasks ?? [], liveEntry?.metrics?.waitingFor ?? null)
        : { doing: null, doingDetail: null, agents: [] };
    participants.push({
      id,
      role: session.role ?? null,
      roleRevision: `${session.pid}:${session.startedAtProcess}:${session.lifecycle}:${session.worktree?.path}`,
      sessionRef: { projectPath: entry.projectPath, workId: map.work.id, sessionId: id },
      label: sessionRowLabel(id, session.label),
      rawLabel: sessionLabelText(session.label),
      provider: session.provider,
      providerName: providerDisplay,
      model: model !== null && model.toLowerCase() !== providerDisplay.toLowerCase() ? model : null,
      state,
      lifecycle: session.lifecycle,
      word: stateWord(state, session.lifecycle),
      attention: sessionAttention(session, live),
      task: session.task,
      doing,
      doingDetail,
      agents,
      lead: id === lead,
      closed: session.lifecycle === 'closed',
    });
  }

  const createdBy = room.creator === HUMAN ? S.rooms.createdByYou : S.rooms.createdBy(labelOf(map, room.creator));
  const subtitle = [
    createdBy,
    S.rooms.agentCount(participants.length),
    ...(lead === null ? [] : [S.rooms.leadIs(sessionTag(lead))]),
    workTitleText(map.work.title),
  ].join(' · ');

  // Оригинал цитаты ищется только среди сообщений этой комнаты: id из другой комнаты — «оригинала нет».
  const roomMessageById = new Map(
    map.messages
      .filter((message) => message.roomId === roomId)
      .map((message) => [message.id, message] as const),
  );
  /** Ярлык упоминания в выдержке — как у чипа в ленте (`RoomPanel`): сессии нет в карте — `null`, берётся тег. */
  const chipLabelOf = (sessionId: string): string | null => {
    const session = map.sessions.find((candidate) => candidate.id === sessionId);
    return session === undefined ? null : sessionRowLabel(sessionId, session.label);
  };
  const replyOf = (replyTo: string | undefined): ReplyModel | null => {
    if (replyTo === undefined) return null;
    const original = roomMessageById.get(replyTo);
    if (original === undefined) return { id: replyTo, from: '', excerpt: '', found: false };
    return {
      id: original.id,
      from: labelOf(map, original.from),
      // Свой `@human` человека — текст, а не «@you»: то же правило по отправителю, что у `RoomMessage`.
      excerpt: replyExcerpt(original.text, chipLabelOf, { humanChips: original.from !== HUMAN }),
      found: true,
    };
  };

  /**
   * Кто из не закрытых адресатов-агентов уже забрал сообщение, а кто нет. Причина ожидания — из метрик самой сессии и у
   * не активной тоже (в отличие от `doing`): `sleeping`, `resuming` и `pending` — причины именно спящих и не запущенных.
   */
  const deliveryOf = (message: Message): MessageModel['delivery'] => {
    const delivery: MessageModel['delivery'] = { picked: [], waiting: [] };
    for (const id of recipientsOf(message, map)) {
      if (id === HUMAN || id === SYSTEM || id === PARLEY) continue;
      const pickedAt = message.readBy[id];
      // Забравший остаётся в строке и после закрытия сессии: это запись о том, что было. Ждать же закрытую
      // незачем — она письмо уже не заберёт.
      if (pickedAt !== undefined) delivery.picked.push({ tag: sessionTag(id), at: pickedAt });
      else if (isAlive(map, id)) delivery.waiting.push({ tag: sessionTag(id), reason: liveOf(id)?.metrics?.mailWaiting ?? null });
    }
    return delivery;
  };

  const messages: MessageModel[] = map.messages
    .filter((message) => message.roomId === roomId)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((message) => {
      const kind: SenderKind = message.from === HUMAN ? 'human' : (message.from === SYSTEM || message.from === PARLEY) ? 'system' : 'agent';
      return {
        id: message.id,
        sender: { kind, provider: kind === 'agent' ? providerOf(map, message.from) : null },
        from: labelOf(map, message.from),
        lead: message.from === lead,
        // Системная строка: `to: [human]` — служебность хоста (`addSystemMessage`), не адресат для показа.
        to: message.from === SYSTEM ? null : message.to.length === 0 ? S.rooms.toAll : message.to.map((id) => labelOf(map, id)).join(', '),
        kind: message.kind,
        at: message.at,
        text: message.text,
        unread: message.from !== SYSTEM && isHumanUnread(message),
        needsRead: isHumanUnread(message),
        mentionsYou: isHumanMention(message),
        delivery: deliveryOf(message),
        reply: replyOf(message.replyTo),
      };
    });

  const decisionMessages = messages.filter((message) => message.kind === 'decision');
  const decisions = {
    shown: decisionMessages.slice(-DECISIONS_SHOWN).map((message) => ({ id: message.id, text: message.text, from: message.from })),
    earlier: Math.max(0, decisionMessages.length - DECISIONS_SHOWN),
  };

  // На диске и у старого хоста слота может не быть (`parseMap` подставляет `null`, но снимок мог прийти от хоста до этого).
  const waiting = room.proposal ?? null;
  const proposal: ProposalModel | null =
    waiting === null
      ? null
      : {
          ...(waiting.kind ? {kind:waiting.kind} : {}),
          ...(waiting.plan ? {plan:waiting.plan} : {}),
          ...((waiting.plan?.id ?? waiting.planId) ? {planId:waiting.plan?.id ?? waiting.planId,planRev:waiting.plan?.rev ?? waiting.planRev} : {}),
          id: waiting.id,
          rev: waiting.rev,
          at: waiting.at,
          text: waiting.text,
          from: labelOf(map, waiting.from),
          provider: providerOf(map, waiting.from),
        };

  return {
    mode: room.mode ?? 'free',
    plan: (map.plans ?? []).find(plan => plan.roomId === roomId && (plan.status === 'active' || plan.status === 'completing')) ?? (map.plans ?? []).filter(plan => plan.roomId === roomId).at(-1) ?? null,
    title: room.title === '' ? S.rooms.fallbackTitle : room.title,
    subtitle,
    participants,
    decisions,
    messages,
    proposal,
    empty: messages.length === 0 && proposal === null,
  };
}
