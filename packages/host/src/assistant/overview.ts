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

export type AssistantTarget =
  | { kind: 'work'; id: string; projectPath: string; workId: string; name: string; where: string }
  | { kind: 'room'; id: string; projectPath: string; workId: string; roomId: string; name: string; where: string }
  | { kind: 'session'; id: string; ref: SessionRef; name: string; where: string; running: boolean; lifecycle: SessionLifecycle };

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
}

const STATE_ORDER: Readonly<Record<DotState, number>> = { blocked: 0, working: 1, unseen: 2, idle: 3, pending: 4, done: 5, failed: 6, exited: 7 };
const ROOM_MESSAGES = 10;
const PLAN_ITEMS = 12;
const SESSION_CARDS = 3;
const DECISION_BRIEF = 200;
const DECISION_FULL = 1500;

const projectKey = (projectPath: string): string => createHash('sha1').update(projectPath).digest('hex').slice(0, 6);
const projectName = (projectPath: string): string => projectPath.split('/').filter(Boolean).pop() ?? projectPath;
const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const open = (entries: readonly WorkEntry[]): WorkEntry[] => entries.filter((entry) => entry.map.work.status !== 'archived');
const isArchived = (room: { archivedAt?: unknown }): boolean => typeof room.archivedAt === 'string';
const where = (entry: WorkEntry): string => `${entry.map.work.title} · ${projectName(entry.projectPath)}`;
const refOf = (entry: WorkEntry, session: WorkSession): SessionRef => ({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });

export function targetsOf(source: OverviewSource): AssistantTarget[] {
  const targets: AssistantTarget[] = [];
  for (const entry of open(source.entries)) {
    const { map } = entry;
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
    // Работа — цель сама по себе: по ней модель создаёт комнату; в каждой работе идёт первой.
    targets.push({ kind: 'work', id: `work:${prefix}`, projectPath: entry.projectPath, workId: map.work.id, name: map.work.title, where: where(entry) });
    for (const room of map.rooms) {
      if (isArchived(room)) continue;
      targets.push({ kind: 'room', id: `room:${prefix}:${room.id}`, projectPath: entry.projectPath, workId: map.work.id, roomId: room.id, name: room.title, where: where(entry) });
    }
    for (const session of map.sessions) {
      if (session.lifecycle === 'closed') continue;
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
      });
    }
  }
  return targets;
}

/** Цель по id из снимка, а если модель назвала имя — по однозначному имени или его первому слову («S03»). */
export function resolveTarget(targets: readonly AssistantTarget[], wanted: string): { target: AssistantTarget } | { error: string } {
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
    return { error: `"${key}" matches several targets: ${matches.map((target) => `${target.id} (${target.name}, ${target.where})`).join('; ')}` };
  }
  return { error: `No work, room or session "${key}". Call parley_overview for the current ids.` };
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

function sessionLine(
  source: OverviewSource,
  entry: WorkEntry,
  session: WorkSession,
  state: DotState,
  need: SessionNeed | null,
  live: SessionLive | undefined,
  cards: readonly FeedCard[] | undefined,
): string {
  const prefix = `${projectKey(entry.projectPath)}:${entry.map.work.id}`;
  const parts = [`  Session ${participantLabel(entry.map, session.id)} [session:${prefix}:${session.id}] ${session.provider}`, stateText(source, session, state, need)];
  // Комната нужна модели, чтобы писать агенту через неё с упоминанием; сессия состоит не больше чем в одной комнате работы.
  const room = entry.map.rooms.find((candidate) => !isArchived(candidate) && candidate.members.includes(session.id));
  if (room !== undefined) parts.push(`in room "${room.title}"`);
  if (typeof session.task === 'string' && session.task.trim() !== '') parts.push(`task: ${oneLine(session.task, 160)}`);
  if (typeof session.summary === 'string' && session.summary.trim() !== '') parts.push(`summary: ${oneLine(session.summary, 200)}`);
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

/** Снимок всех открытых работ (спека 7.2.1); работы с ждущими человека — первыми; длиннее `maxChars` — срез по работам. */
export function overviewText(source: OverviewSource, maxChars = 8000): string {
  const blocks: Array<{ rank: number; text: string }> = [];
  for (const entry of open(source.entries)) {
    const { map } = entry;
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
    const sessions = map.sessions
      .filter((session) => session.lifecycle !== 'closed')
      .map((session) => {
        const live = source.live(refOf(entry, session));
        const need = needOf(session, live);
        return { session, live, need, state: sessionDotStateWithNeed(session, live?.activity.activity ?? null, need) };
      })
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    const lines = [`Work "${map.work.title}" [work:${prefix}] (project ${projectName(entry.projectPath)})`];
    for (const room of map.rooms) {
      if (isArchived(room)) continue;
      const members = sessions.filter((item) => room.members.includes(item.session.id));
      const working = members.filter((item) => item.state === 'working').length;
      const waiting = members.filter((item) => item.state === 'blocked').length;
      const plan = planOf(map, room.id);
      const done = plan?.items.filter((item) => item.status === 'done' || item.status === 'verified').length ?? 0;
      lines.push(
        `  Room "${room.title}" [room:${prefix}:${room.id}]: ${members.length} members, ${working} working` +
          (waiting > 0 ? `, ${waiting} need the person` : '') +
          (room.lead === null ? '' : `, lead ${participantLabel(map, room.lead)}`) +
          (plan === undefined ? '' : `, plan ${done}/${plan.items.length}: ${oneLine(plan.goal, 120)}`) +
          (room.proposal === null ? '' : `, waits: ${proposalHead(map, room.proposal)}: ${oneLine(room.proposal.text, DECISION_BRIEF)}`),
      );
    }
    for (const item of sessions) lines.push(sessionLine(source, entry, item.session, item.state, item.need, item.live, source.cards?.(refOf(entry, item.session))));
    const rank = Math.min(...sessions.map((item) => STATE_ORDER[item.state]), STATE_ORDER.exited);
    blocks.push({ rank, text: lines.join('\n') });
  }
  if (blocks.length === 0) return 'No works are open in Parley right now.';
  blocks.sort((a, b) => a.rank - b.rank);
  const shown: string[] = [];
  let size = 0;
  let skipped = 0;
  for (const block of blocks) {
    if (size + block.text.length > maxChars && shown.length > 0) {
      skipped += 1;
      continue;
    }
    shown.push(block.text);
    size += block.text.length + 2;
  }
  if (skipped > 0) shown.push(`…${skipped} more works not shown (less active).`);
  return shown.join('\n\n');
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
  const lines = [`Room "${room.title}" in ${target.where}; members: ${room.members.map((id) => participantLabel(map, id)).join(', ') || 'none'}`];
  if (room.proposal !== null) {
    lines.push(`${proposalHead(map, room.proposal).replace(/^./, (c) => c.toUpperCase())}: ${oneLine(room.proposal.text, DECISION_FULL)}`);
  }
  const plan = planOf(map, room.id);
  if (plan !== undefined) {
    lines.push(`Plan: ${oneLine(plan.goal, 200)}`);
    for (const item of plan.items.slice(0, PLAN_ITEMS)) lines.push(`  ${item.id}. ${oneLine(item.title, 120)} — ${item.status}`);
  }
  const messages = source.roomTail(entry, room.id, ROOM_MESSAGES);
  if (messages.length > 0) lines.push('Last messages:');
  for (const message of messages) lines.push(`  ${participantLabel(map, message.from)} (${message.kind}): ${oneLine(message.text, 200)}`);
  return lines.join('\n');
}
