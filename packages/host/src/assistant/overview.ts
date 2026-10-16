/**
 * Что помощник знает о работах (спека 2026-10-14, 7.2): компактный снимок всех открытых работ, подробности одной
 * комнаты или сессии и разбор цели, которую назвала модель. Чистые функции: снимок работ и активность — на входе.
 */

import { createHash } from 'node:crypto';
import { participantLabel, type WorkEntry, type WorkMap, type WorkSession } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { SessionLive } from '../activity/activity-service.js';

export type SessionState = 'working' | 'needs-you' | 'unseen' | 'idle' | 'off';

export type AssistantTarget =
  | { kind: 'room'; id: string; projectPath: string; workId: string; roomId: string; name: string; where: string }
  | { kind: 'session'; id: string; ref: SessionRef; name: string; where: string; running: boolean };

export interface OverviewSource {
  entries: readonly WorkEntry[];
  live(ref: SessionRef): SessionLive | undefined;
}

const STATE_ORDER: Readonly<Record<SessionState, number>> = { 'needs-you': 0, working: 1, unseen: 2, idle: 3, off: 4 };
const ROOM_MESSAGES = 10;
const PLAN_ITEMS = 12;

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

export function sessionState(session: WorkSession, live: SessionLive | undefined): SessionState {
  if (session.lifecycle === 'closed' || live === undefined || live.activity.exited) return 'off';
  switch (live.activity.activity) {
    case 'blocked':
      return 'needs-you';
    case 'working':
      return 'working';
    case 'unseen':
      return 'unseen';
    default:
      return 'idle';
  }
}

export function targetsOf(source: OverviewSource): AssistantTarget[] {
  const targets: AssistantTarget[] = [];
  for (const entry of open(source.entries)) {
    const { map } = entry;
    const prefix = `${projectKey(entry.projectPath)}:${map.work.id}`;
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
        running: sessionState(session, source.live(ref)) !== 'off',
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
  return { error: `No room or session "${key}". Call parley_overview for the current ids.` };
}

function sessionLine(entry: WorkEntry, session: WorkSession, state: SessionState, live: SessionLive | undefined): string {
  const prefix = `${projectKey(entry.projectPath)}:${entry.map.work.id}`;
  const parts = [`  Session ${participantLabel(entry.map, session.id)} [session:${prefix}:${session.id}] ${session.provider}`, state];
  if (typeof session.task === 'string' && session.task.trim() !== '') parts.push(`task: ${oneLine(session.task, 160)}`);
  if (typeof session.summary === 'string' && session.summary.trim() !== '') parts.push(`summary: ${oneLine(session.summary, 200)}`);
  const waitingFor = live?.activity.waitingFor ?? null;
  if (state === 'needs-you' && waitingFor !== null) parts.push(`waiting for: ${oneLine(waitingFor, 120)}`);
  return parts.join(' · ');
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
        return { session, live, state: sessionState(session, live) };
      })
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    const lines = [`Work "${map.work.title}" (project ${projectName(entry.projectPath)})`];
    for (const room of map.rooms) {
      if (isArchived(room)) continue;
      const members = sessions.filter((item) => room.members.includes(item.session.id));
      const working = members.filter((item) => item.state === 'working').length;
      const waiting = members.filter((item) => item.state === 'needs-you').length;
      const plan = planOf(map, room.id);
      const done = plan?.items.filter((item) => item.status === 'done' || item.status === 'verified').length ?? 0;
      lines.push(
        `  Room "${room.title}" [room:${prefix}:${room.id}]: ${members.length} members, ${working} working` +
          (waiting > 0 ? `, ${waiting} need the person` : '') +
          (room.lead === null ? '' : `, lead ${participantLabel(map, room.lead)}`) +
          (plan === undefined ? '' : `, plan ${done}/${plan.items.length}: ${oneLine(plan.goal, 120)}`),
      );
    }
    for (const item of sessions) lines.push(sessionLine(entry, item.session, item.state, item.live));
    const rank = Math.min(...sessions.map((item) => STATE_ORDER[item.state]), STATE_ORDER.off);
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

/** Подробности одной цели (спека 7.2.2). `lastReply` — последний ответ агента из ленты, только у сессии. */
export function detailText(source: OverviewSource, target: AssistantTarget, lastReply: string | null): string {
  const projectPath = target.kind === 'room' ? target.projectPath : target.ref.projectPath;
  const workId = target.kind === 'room' ? target.workId : target.ref.workId;
  const entry = source.entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
  if (entry === undefined) return `${target.name} is no longer in Parley.`;
  const { map } = entry;
  if (target.kind === 'session') {
    const session = map.sessions.find((item) => item.id === target.ref.sessionId);
    if (session === undefined) return `${target.name} is no longer in Parley.`;
    const live = source.live(target.ref);
    const lines = [sessionLine(entry, session, sessionState(session, live), live).trim()];
    if (lastReply !== null) lines.push(`Last reply: ${oneLine(lastReply, 1500)}`);
    return lines.join('\n');
  }
  const room = map.rooms.find((item) => item.id === target.roomId);
  if (room === undefined) return `${target.name} is no longer in Parley.`;
  const lines = [`Room "${room.title}" in ${target.where}; members: ${room.members.map((id) => participantLabel(map, id)).join(', ') || 'none'}`];
  const plan = planOf(map, room.id);
  if (plan !== undefined) {
    lines.push(`Plan: ${oneLine(plan.goal, 200)}`);
    for (const item of plan.items.slice(0, PLAN_ITEMS)) lines.push(`  ${item.id}. ${oneLine(item.title, 120)} — ${item.status}`);
  }
  const messages = map.messages.filter((message) => message.roomId === room.id).slice(-ROOM_MESSAGES);
  if (messages.length > 0) lines.push('Last messages:');
  for (const message of messages) lines.push(`  ${participantLabel(map, message.from)} (${message.kind}): ${oneLine(message.text, 200)}`);
  return lines.join('\n');
}
