/**
 * Что помощник знает о работах (спека 2026-10-14, 7.2): компактный снимок всех открытых работ, подробности одной
 * комнаты или сессии и разбор цели, которую назвала модель. Чистые функции: снимок работ и активность — на входе.
 * Состояния сессий берутся из единого модуля core (`sessionDotStateWithNeed`, `stateWord`), своего расчёта у помощника
 * нет: решение человека 2026-10-17 о паритете статусов с окном и агентами. Сессия, которой нужен человек (`need`: лимит,
 * вход, одобрение…), — `blocked` и считается ждущей, а вместо слова состояния в её строке слово и причина `need`
 * (спека подписок 7, итоговое ревью).
 */

import { createHash } from 'node:crypto';
import {
  cardDetail,
  cardGist,
  needReason,
  needWord,
  participantLabel,
  providerLabel,
  sessionDotStateWithNeed,
  stateWord,
  type DotState,
  type FeedCard,
  type Message,
  type ProviderEntry,
  type SessionLifecycle,
  type SessionNeed,
  type WorkEntry,
  type WorkMap,
  type WorkSession,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { sessionNeed } from '@parley/core/attention';
import type { SessionLive } from '../activity/activity-service.js';

/** Почему цель скрыта из обзора (спека 5.4): сессия закрыта или комната/работа в архиве; у видимых цели поля нет. */
export type HiddenKind = 'closed' | 'archived';

export type AssistantTarget =
  | { kind: 'work'; id: string; projectPath: string; workId: string; name: string; where: string; hidden?: HiddenKind }
  | { kind: 'room'; id: string; projectPath: string; workId: string; roomId: string; name: string; where: string; hidden?: HiddenKind }
  | { kind: 'session'; id: string; ref: SessionRef; name: string; where: string; running: boolean; lifecycle: SessionLifecycle; hidden?: HiddenKind };

export interface OverviewSource {
  entries: readonly WorkEntry[];
  live(ref: SessionRef): SessionLive | undefined;
  /** Последние `count` писем комнаты по порядку ленты: письма лежат в базе работы, а не в снимке (спека хранилища 6.2). */
  roomTail(entry: WorkEntry, roomId: string, count: number): readonly Message[];
  /** Ждущие карточки сессии, если сервис их уже достал; нет функции или `undefined` — строка `waits:` без карточки. */
  cards?(ref: SessionRef): readonly FeedCard[] | undefined;
  /**
   * Реестр провайдеров для имени в причине `need` («Hit its Claude Code 2 usage limit»); нет реестра — имя по id, как у
   * Telegram. Время сброса в причине считается от `now`.
   */
  providers?: Readonly<Record<string, Pick<ProviderEntry, 'id' | 'label'>>> | undefined;
  now?: Date | undefined;
  /** Домашняя папка пользователя: в имени проекта-двойника она пишется как `~`; нет — путь как есть. */
  home?: string;
}

const STATE_ORDER: Readonly<Record<DotState, number>> = { blocked: 0, working: 1, unseen: 2, idle: 3, pending: 4, done: 5, failed: 6, exited: 7 };
const ROOM_MESSAGES = 10;
const PLAN_ITEMS = 12;
const SESSION_CARDS = 3;
const DECISION_BRIEF = 200;
const DECISION_FULL = 1500;
/** Мягкий бюджет обзора в знаках (спека 4): по нему выбирается ступень сжатия, но объекты не выкидываются. */
export const OVERVIEW_BUDGET = 12_000;

/** Ступень сжатия описаний (спека 4): 0 — полные строки, 3 — самые короткие. */
type Level = 0 | 1 | 2 | 3;

const projectKey = (projectPath: string): string => createHash('sha1').update(projectPath).digest('hex').slice(0, 6);
export const projectName = (projectPath: string): string => projectPath.split('/').filter(Boolean).pop() ?? projectPath;
const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const open = (entries: readonly WorkEntry[]): WorkEntry[] => entries.filter((entry) => entry.map.work.status !== 'archived');
const isArchived = (room: { archivedAt?: unknown }): boolean => typeof room.archivedAt === 'string';
/**
 * Как назвать проект в обзоре: имя папки; если среди работ (любого статуса) есть другой проект с тем же именем папки —
 * `scanum in ~/Desktop`, где родительская папка дана с `~` вместо `home`.
 */
export function projectLabel(entries: readonly WorkEntry[], projectPath: string, home?: string): string {
  const name = projectName(projectPath);
  if (!entries.some((other) => other.projectPath !== projectPath && projectName(other.projectPath) === name)) return name;
  const parent = projectPath.slice(0, projectPath.lastIndexOf('/')) || '/';
  const shown = home !== undefined && home !== '' && (parent === home || parent.startsWith(`${home}/`)) ? `~${parent.slice(home.length)}` : parent;
  return `${name} in ${shown}`;
}
const where = (entry: WorkEntry): string => `${entry.map.work.title} · ${projectName(entry.projectPath)}`;
const refOf = (entry: WorkEntry, session: WorkSession): SessionRef => ({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });

/** Пометка скрытой цели: у цели из архивной работы всегда `archived`, иначе — своя (закрытая сессия, архивная комната). */
const hiddenMark = (archivedWork: boolean, own?: HiddenKind): { hidden?: HiddenKind } =>
  archivedWork ? { hidden: 'archived' } : own === undefined ? {} : { hidden: own };

/**
 * Цели помощника. Без опции — только видимое в обзоре; с `hidden: true` ещё архивные работы со всеми комнатами и
 * сессиями (`archived`), архивные комнаты открытых работ (`archived`) и их закрытые сессии (`closed`) — с пометкой.
 */
export function targetsOf(source: OverviewSource, options: { hidden?: boolean } = {}): AssistantTarget[] {
  const withHidden = options.hidden === true;
  const targets: AssistantTarget[] = [];
  for (const entry of withHidden ? source.entries : open(source.entries)) {
    const { map } = entry;
    const archivedWork = map.work.status === 'archived';
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
    // Работа — цель сама по себе: по ней модель создаёт комнату; в каждой работе идёт первой.
    targets.push({
      kind: 'work',
      id: `work:${prefix}`,
      projectPath: entry.projectPath,
      workId: map.work.id,
      name: map.work.title,
      where: where(entry),
      ...hiddenMark(archivedWork),
    });
    for (const room of map.rooms) {
      const archivedRoom = isArchived(room);
      if (archivedRoom && !withHidden) continue;
      targets.push({
        kind: 'room',
        id: `room:${prefix}:${room.id}`,
        projectPath: entry.projectPath,
        workId: map.work.id,
        roomId: room.id,
        name: room.title,
        where: where(entry),
        ...hiddenMark(archivedWork, archivedRoom ? 'archived' : undefined),
      });
    }
    for (const session of map.sessions) {
      const closed = session.lifecycle === 'closed';
      if (closed && !withHidden) continue;
      const ref = refOf(entry, session);
      targets.push({
        kind: 'session',
        id: `session:${prefix}:${session.id}`,
        ref,
        name: participantLabel(map, session.id),
        where: where(entry),
        // Процесс есть, пока сессия `active`: после resume активность может быть ещё не выведена (`idle`), но запущена она.
        running: session.lifecycle === 'active',
        lifecycle: session.lifecycle,
        ...hiddenMark(archivedWork, closed ? 'closed' : undefined),
      });
    }
  }
  return targets;
}

const targetList = (targets: readonly AssistantTarget[]): string => targets.map((target) => `${target.id} (${target.name}, ${target.where})`).join('; ');

/**
 * Цель по id из снимка, а если модель назвала имя — по однозначному имени или его первому слову («S03»). Нашлось
 * несколько — ошибка со списком. Дальше запасной путь: имя папки проекта у цели-работы (название работы всегда
 * побеждает, потому что проверяется раньше). Скрытые цели (`options.hidden`) — только по точному id или полному имени.
 */
export function resolveTarget(
  targets: readonly AssistantTarget[],
  wanted: string,
  options: { hidden?: readonly AssistantTarget[] } = {},
): { target: AssistantTarget } | { error: string } {
  const key = wanted.trim();
  const exact = targets.find((target) => target.id === key);
  if (exact !== undefined) return { target: exact };
  const name = key.toLowerCase();
  const matches = targets.filter((target) => {
    const own = target.name.toLowerCase();
    return name !== '' && (own === name || own.split(' ')[0] === name);
  });
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { target: only };
  if (matches.length > 1) {
    return { error: `"${key}" matches several targets: ${targetList(matches)}` };
  }
  const byProject = name === '' ? [] : targets.filter((target) => target.kind === 'work' && projectName(target.projectPath).toLowerCase() === name);
  const [project] = byProject;
  if (byProject.length === 1 && project !== undefined) return { target: project };
  if (byProject.length > 1) {
    return { error: `"${key}" is the project folder of several works: ${targetList(byProject)}` };
  }
  const hidden = options.hidden ?? [];
  const hiddenById = hidden.find((target) => target.id === key);
  if (hiddenById !== undefined) return { target: hiddenById };
  const hiddenByName = name === '' ? [] : hidden.filter((target) => target.name.toLowerCase() === name);
  const [hiddenOnly] = hiddenByName;
  if (hiddenByName.length === 1 && hiddenOnly !== undefined) return { target: hiddenOnly };
  if (hiddenByName.length > 1) {
    return { error: `"${key}" matches several closed or archived targets: ${targetList(hiddenByName)}` };
  }
  return { error: `No work, room or session "${key}". Call parley_overview for the current ids, or parley_find to search.` };
}

/** Строка ждущей карточки для модели: что просят и id карточки, по которому предлагается решение. */
export function cardLine(card: FeedCard, projectPath: string): string {
  const gist = cardGist(card, projectPath);
  const id = `(card ${card.cardId})`;
  switch (gist.kind) {
    case 'run':
      return `permission — ${card.toolName}: ${oneLine(gist.command, 160)} ${id}`;
    case 'tool':
      return `permission — ${gist.tool}${gist.path === null ? '' : `: ${oneLine(gist.path, 160)}`} ${id}`;
    case 'fetch':
      return `permission — ${card.toolName}: ${oneLine(gist.url, 160)} ${id}`;
    case 'question':
      return `question — ${oneLine(gist.text, 160)} ${id}`;
    case 'plan':
      return `plan — ${card.kind === 'plan' ? card.plan.split(/\r?\n/).length : 0} lines ${id}`;
  }
}

/** Чего нужно от человека у живой сессии: `need` из активности (у спящей и закрытой — `null`). */
const needOf = (session: WorkSession, live: SessionLive | undefined): SessionNeed | null => sessionNeed(session, live?.activity ?? null);

/**
 * Слово в строке сессии: слово состояния, а у сессии с `need` — слово вида и причина из core (`needWord`, `needReason`),
 * как в окне, на острове и в Telegram.
 */
function stateText(source: OverviewSource, session: WorkSession, state: DotState, need: SessionNeed | null): string {
  if (need === null) return stateWord(state, session.lifecycle);
  const label = providerLabel(source.providers?.[session.provider] ?? { id: session.provider, label: '' });
  return `${needWord(need.kind)} — ${needReason(need, source.now ?? new Date(), label)}`;
}

/**
 * Остаются ли `task:` и `summary:` у сессии на ступени сжатия (спека 4): 1 — только у работающих, ждущих и непрочитанных,
 * 2 и 3 — только у ждущих человека.
 */
function keepsDetail(level: Level, state: DotState): boolean {
  if (level === 0) return true;
  if (level === 1) return state === 'working' || state === 'blocked' || state === 'unseen';
  return state === 'blocked';
}

function sessionLine(
  source: OverviewSource,
  entry: WorkEntry,
  session: WorkSession,
  state: DotState,
  need: SessionNeed | null,
  live: SessionLive | undefined,
  cards: readonly FeedCard[] | undefined,
  level: Level = 0,
): string {
  const prefix = `${projectKey(entry.projectPath)}:${entry.map.work.id}`;
  const parts = [`  Session ${participantLabel(entry.map, session.id)} [session:${prefix}:${session.id}] ${session.provider}`, stateText(source, session, state, need)];
  // Комната нужна модели, чтобы писать агенту через неё с упоминанием; сессия состоит не больше чем в одной комнате работы.
  const room = entry.map.rooms.find((candidate) => !isArchived(candidate) && candidate.members.includes(session.id));
  if (room !== undefined) parts.push(`in room "${room.title}"`);
  // Ступень 3: сжатая строка у всех, кроме ждущих человека — те остаются как на ступени 2.
  if (level === 3 && state !== 'blocked') return parts.join(' · ');
  if (keepsDetail(level, state)) {
    if (typeof session.task === 'string' && session.task.trim() !== '') parts.push(`task: ${oneLine(session.task, 160)}`);
    if (typeof session.summary === 'string' && session.summary.trim() !== '') parts.push(`summary: ${oneLine(session.summary, 200)}`);
  }
  const waitingFor = live?.activity.waitingFor ?? null;
  if (state === 'blocked' && waitingFor !== null) parts.push(`waiting for: ${oneLine(waitingFor, 120)}`);
  if (state === 'blocked') for (const card of (cards ?? []).slice(0, SESSION_CARDS)) parts.push(`waits: ${cardLine(card, entry.projectPath)}`);
  return parts.join(' · ');
}

/** Решение ведущего, которое ждёт человека: `decision`, а у старых записей без вида — тоже решение. */
function proposalHead(map: WorkMap, proposal: NonNullable<WorkMap['rooms'][number]['proposal']>): string {
  const word = proposal.kind === 'completion' ? 'completion' : 'decision';
  return `${word} from ${participantLabel(map, proposal.from)} (${proposal.id}, rev ${proposal.rev})`;
}

function planOf(map: WorkMap, roomId: string) {
  return (map.plans ?? []).find((plan) => plan.roomId === roomId && plan.status !== 'cancelled' && plan.status !== 'completed');
}

/** Строка о том, что обзор не показывает: закрытые сессии и архивные комнаты открытых работ и архивные работы (спека 4). */
function hiddenLine(entries: readonly WorkEntry[]): string | null {
  let closed = 0;
  let rooms = 0;
  let works = 0;
  for (const entry of entries) {
    if (entry.map.work.status === 'archived') {
      works += 1;
      continue;
    }
    closed += entry.map.sessions.filter((session) => session.lifecycle === 'closed').length;
    rooms += entry.map.rooms.filter(isArchived).length;
  }
  const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [closed > 0 ? count(closed, 'closed session') : null, rooms > 0 ? count(rooms, 'archived room') : null, works > 0 ? count(works, 'archived work') : null];
  const shown = parts.filter((part): part is string => part !== null);
  return shown.length === 0 ? null : `Also ${shown.join(', ')} — use parley_find with include_closed to see them.`;
}

/**
 * Снимок всех открытых работ (спека 4.1): работы с ждущими человека — первыми; в обзоре всегда все работы, комнаты и
 * сессии. Не влезло в `maxChars` — описания сжимаются по ступеням 1–3, а если и сжатые не влезли, отдаются все:
 * бюджет мягкий. После текста — строка о скрытом (закрытое и архивное), бюджет её не считает.
 */
export function overviewText(source: OverviewSource, maxChars = OVERVIEW_BUDGET): string {
  const blocks: Array<{ rank: number; text: (level: Level) => string }> = [];
  for (const entry of open(source.entries)) {
    const { map } = entry;
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
    const sessions = map.sessions
      .filter((session) => session.lifecycle !== 'closed')
      .map((session) => {
        const live = source.live(refOf(entry, session));
        const need = needOf(session, live);
        return { session, live, need, state: sessionDotStateWithNeed(session, live?.activity.activity ?? null, need), cards: source.cards?.(refOf(entry, session)) };
      })
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    const rank = Math.min(...sessions.map((item) => STATE_ORDER[item.state]), STATE_ORDER.exited);
    const head = `Work "${map.work.title}" [work:${prefix}] (project ${projectLabel(source.entries, entry.projectPath, source.home)})`;
    const text = (level: Level): string => {
      const lines = [head];
      for (const room of map.rooms) {
        if (isArchived(room)) continue;
        const members = sessions.filter((item) => room.members.includes(item.session.id));
        const working = members.filter((item) => item.state === 'working').length;
        const waiting = members.filter((item) => item.state === 'blocked').length;
        const base = `  Room "${room.title}" [room:${prefix}:${room.id}]: ${members.length} members, ${working} working` + (waiting > 0 ? `, ${waiting} need the person` : '');
        // Ступень 3: решение ведущего не сжимается, остальные комнаты — только счётчики.
        if (level === 3 && room.proposal === null) {
          lines.push(base);
          continue;
        }
        const plan = planOf(map, room.id);
        const done = plan?.items.filter((item) => item.status === 'done' || item.status === 'verified').length ?? 0;
        lines.push(
          base +
            (room.lead === null ? '' : `, lead ${participantLabel(map, room.lead)}`) +
            (plan === undefined ? '' : `, plan ${done}/${plan.items.length}: ${oneLine(plan.goal, 120)}`) +
            (room.proposal === null ? '' : `, waits: ${proposalHead(map, room.proposal)}: ${oneLine(room.proposal.text, DECISION_BRIEF)}`),
        );
      }
      for (const item of sessions) lines.push(sessionLine(source, entry, item.session, item.state, item.need, item.live, item.cards, level));
      return lines.join('\n');
    };
    blocks.push({ rank, text });
  }
  const hidden = hiddenLine(source.entries);
  if (blocks.length === 0) return ['No works are open in Parley right now.', hidden].filter((part) => part !== null).join('\n\n');
  blocks.sort((a, b) => a.rank - b.rank);
  const render = (level: Level): string => blocks.map((block) => block.text(level)).join('\n\n');
  // Первая ступень, что влезла в бюджет; не влезла ни одна — самая сжатая, целиком.
  let text = render(0);
  for (const level of [1, 2, 3] as const) {
    if (text.length <= maxChars) break;
    text = render(level);
  }
  return hidden === null ? text : `${text}\n\n${hidden}`;
}

/**
 * Одна строка о цели с её id (спека 5.1): работа, комната или сессия. Для находок `parley_find` и ошибок инструментов.
 * Слово состояния сессии — из core, как в обзоре; у цели из архива в конце ` · archived`, у закрытой сессии пометки
 * нет: слово состояния уже `closed`.
 */
export function briefLine(source: OverviewSource, target: AssistantTarget): string {
  const archived = target.hidden === 'archived' ? ' · archived' : '';
  if (target.kind === 'work') {
    return `Work "${target.name}" [${target.id}] (project ${projectLabel(source.entries, target.projectPath, source.home)})${archived}`;
  }
  if (target.kind === 'room') return `Room "${target.name}" [${target.id}] in ${target.where}${archived}`;
  const entry = source.entries.find((item) => item.projectPath === target.ref.projectPath && item.map.work.id === target.ref.workId);
  const session = entry?.map.sessions.find((item) => item.id === target.ref.sessionId);
  if (session === undefined) return `${target.name} [${target.id}] is no longer in Parley.`;
  const live = source.live(target.ref);
  const need = needOf(session, live);
  const state = sessionDotStateWithNeed(session, live?.activity.activity ?? null, need);
  const role = session.role?.name === undefined ? '' : ` · role ${session.role.name}`;
  return `Session ${target.name} [${target.id}] ${session.provider} · ${stateText(source, session, state, need)} · in ${target.where}${role}${archived}`;
}

/**
 * Шапка комнаты (спека 5.2): участники, решение ведущего, план и его пункты. Общая для `detailText` и полного чтения
 * комнаты; письма в неё не входят. Нет такой комнаты — пустой список.
 */
export function roomHeader(source: OverviewSource, entry: WorkEntry, roomId: string, place: string): string[] {
  const { map } = entry;
  const room = map.rooms.find((item) => item.id === roomId);
  if (room === undefined) return [];
  const lines = [`Room "${room.title}" in ${place}; members: ${room.members.map((id) => participantLabel(map, id)).join(', ') || 'none'}`];
  if (room.proposal !== null) {
    lines.push(`${proposalHead(map, room.proposal).replace(/^./, (c) => c.toUpperCase())}: ${oneLine(room.proposal.text, DECISION_FULL)}`);
  }
  const plan = planOf(map, room.id);
  if (plan !== undefined) {
    lines.push(`Plan: ${oneLine(plan.goal, 200)}`);
    for (const item of plan.items.slice(0, PLAN_ITEMS)) lines.push(`  ${item.id}. ${oneLine(item.title, 120)} — ${item.status}`);
  }
  return lines;
}

/**
 * Подробности одной цели (спека 7.2.2). `lastReply` — последний ответ агента из ленты, только у сессии;
 * `cards` — её ждущие карточки: с вариантами ответа целиком, чтобы модель отвечала на вопрос по существу.
 */
export function detailText(source: OverviewSource, target: AssistantTarget, lastReply: string | null, cards: readonly FeedCard[] = []): string {
  const projectPath = target.kind === 'session' ? target.ref.projectPath : target.projectPath;
  const workId = target.kind === 'session' ? target.ref.workId : target.workId;
  const entry = source.entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
  if (entry === undefined) return `${target.name} is no longer in Parley.`;
  const { map } = entry;
  if (target.kind === 'work') {
    // Одна работа — тот же снимок, что и в обзоре, но только она.
    return overviewText({ ...source, entries: [entry] });
  }
  if (target.kind === 'session') {
    const session = map.sessions.find((item) => item.id === target.ref.sessionId);
    if (session === undefined) return `${target.name} is no longer in Parley.`;
    const live = source.live(target.ref);
    const need = needOf(session, live);
    const state = sessionDotStateWithNeed(session, live?.activity.activity ?? null, need);
    const lines = [sessionLine(source, entry, session, state, need, live, source.cards?.(target.ref)).trim()];
    if (lastReply !== null) lines.push(`Last reply: ${oneLine(lastReply, 1500)}`);
    if (cards.length > 0) {
      lines.push('Waiting:');
      for (const card of cards) {
        lines.push(`  ${cardLine(card, entry.projectPath)}`);
        const detail = cardDetail(card);
        if (detail !== null && detail !== '') lines.push(...detail.split('\n').map((line) => `    ${line}`));
      }
    }
    return lines.join('\n');
  }
  const room = map.rooms.find((item) => item.id === target.roomId);
  if (room === undefined) return `${target.name} is no longer in Parley.`;
  const lines = roomHeader(source, entry, room.id, target.where);
  const messages = source.roomTail(entry, room.id, ROOM_MESSAGES);
  if (messages.length > 0) lines.push('Last messages:');
  for (const message of messages) lines.push(`  ${participantLabel(map, message.from)} (${message.kind}): ${oneLine(message.text, 200)}`);
  return lines.join('\n');
}
