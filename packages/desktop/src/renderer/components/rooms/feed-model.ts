/**
 * Модель вкладки комнаты (спека окна 2026-09-29, 1.3, 2.4): из карты работы — шапка с подзаголовком,
 * лента участников, сообщения с адресатами и строкой ожидания, блок `Decisions`, карточка решения.
 * Чистая функция без React: `RoomPanel.tsx` рисует то, что она вернула.
 *
 * Вместо прежнего `roomView` из `lib/room-view.ts` (удалён): тому нужны были письма-строки `LetterView`,
 * а здесь у сообщения свои поля — отправитель для аватара, `★` ведущего, адресаты без человека,
 * ожидающие агенты. Правило ведущего — `roomLiveLead` (`lib/room-lead.ts`), общая копия `liveLead` из core;
 * своей здесь нет (решение контролёра 1).
 *
 * Модель участника — из живых метрик (`activity.changed`, `metrics.model`), как её брал `RoomBody` до этого
 * куска: короткое имя с версией (`Opus 5.5`). Усилие не показывается — его никто не хранит. Пока сессия
 * ничего не написала и модель неизвестна, у участника её нет (`null`).
 *
 * Чем занят участник (`doing`, `doingDetail`) — из тех же метрик (`tasks`, `waitingFor`, Parley 0.2.0): живой
 * субагент или ожидание `wait_for`. Только у живой сессии: у закрытой и спящей метрики — след прошлого процесса.
 * `agents` — те же субагенты списком для поповера на строке `doing` (кусок 4b плана 2026-10-01).
 */

import type { MessageKind, SessionLifecycle, WorkEntry, WorkMap } from '@parley/core';
import { refKey, type LiveTask } from '@parley/protocol';
import { S, providerName } from '../../../shared/strings.js';
import { isHumanUnread, sessionAttention, type Attention } from '../../attention/derive.js';
import { displayStatus, dotState, stateWord, type DotState } from '../../lib/dot-state.js';
import { DECISIONS_SHOWN, recipientsOf } from '../../lib/mail-view.js';
import { sessionLabelText, sessionRowLabel, sessionTag, workTitleText } from '../../lib/participant.js';
import { modelName } from '../../lib/participant-tag.js';
import { roomLiveLead } from '../../lib/room-lead.js';
import type { ActivityEntry } from '../../store/activity.js';

// Те же литералы, что `HUMAN` и `SYSTEM` в `core/work/types.ts`: из core рендерер берёт только типы.
const HUMAN = 'human';
const SYSTEM = 'system';

export type SenderKind = 'human' | 'system' | 'agent';

/** Участник комнаты — карточка ленты участников, пункт меню упоминаний. */
export interface ParticipantModel {
  id: string;
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
  /** Теги (`S02`) живых адресатов-агентов, которые ещё не подхватили сообщение (`readBy`). */
  waiting: string[];
}

export interface ProposalModel {
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
  if (id === SYSTEM) return S.participants.system;
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

  // Создатель-сессия в `members` не пишется (`core/work/rooms.ts#addMember`), человек — участник всегда
  // и списком не хранится: агенты комнаты — создатель и члены без человека, каждый один раз.
  const memberIds = [...new Set([room.creator, ...room.members])].filter((id) => id !== HUMAN);
  const participants: ParticipantModel[] = [];
  for (const id of memberIds) {
    const session = map.sessions.find((candidate) => candidate.id === id);
    // Удалённая сессия в ленте участников не выводится: показать о ней нечего.
    if (session === undefined) continue;
    const liveEntry = activity[refKey({ projectPath: entry.projectPath, workId: map.work.id, sessionId: id })];
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

  const messages: MessageModel[] = map.messages
    .filter((message) => message.roomId === roomId)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((message) => {
      const kind: SenderKind = message.from === HUMAN ? 'human' : message.from === SYSTEM ? 'system' : 'agent';
      return {
        id: message.id,
        sender: { kind, provider: kind === 'agent' ? providerOf(map, message.from) : null },
        from: labelOf(map, message.from),
        lead: message.from === lead,
        // Системная строка: `to: [human]` — служебность хоста (`addSystemMessage`), не адресат для показа.
        to: kind === 'system' ? null : message.to.length === 0 ? S.rooms.toAll : message.to.map((id) => labelOf(map, id)).join(', '),
        kind: message.kind,
        at: message.at,
        text: message.text,
        unread: kind !== 'system' && isHumanUnread(message),
        needsRead: isHumanUnread(message),
        waiting: recipientsOf(message, map)
          .filter((id) => id !== HUMAN && id !== SYSTEM && isAlive(map, id) && message.readBy[id] === undefined)
          .map(sessionTag),
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
          id: waiting.id,
          rev: waiting.rev,
          at: waiting.at,
          text: waiting.text,
          from: labelOf(map, waiting.from),
          provider: providerOf(map, waiting.from),
        };

  return {
    title: room.title === '' ? S.rooms.fallbackTitle : room.title,
    subtitle,
    participants,
    decisions,
    messages,
    proposal,
    empty: messages.length === 0 && proposal === null,
  };
}
