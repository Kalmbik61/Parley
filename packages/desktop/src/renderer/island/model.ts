/**
 * Что показывает остров в покое (спека 2026-10-12, раздел 4): счётчики пилюли и список «в работе» по работам.
 * Чистая функция: работы окна, активность, множество сессий, у которых в очереди острова есть карточка
 * (без неё ждущая сессия — «waiting in terminal»), скрытые кнопкой Clear ключи Done и удержанные ключи Done.
 * «В работе»: сессия — `sessionAttention` даёт `working` или `needs-you`; комната — в работе хотя бы один её участник.
 *
 * Done — сессия, у которой ход окончен, а в Parley её ещё не смотрели (`sessionAttention` = `unseen`). Её строка
 * живёт, пока хост не переведёт сессию в `idle` (посмотрели), она не заработает снова или человек не нажмёт Clear.
 * Исключение — удержанные ключи (`held`): строку, которую остров уже показал, отметка «просмотрено» (`unseen` →
 * `idle` с тем же `turnEndedAt`) не убирает — `idle` с концом хода и ключом в `held` остаётся такой же строкой Done.
 * Какие ключи держать и когда отпустить, решает проводка (`IslandApp`): модель только читает множество. У строки Done
 * поле `seen`: `false` — сессию ещё не смотрели (`unseen`), `true` — удержанная `idle`; число `seen === false` — то, что
 * показывает язычок убранного острова.
 * Ключ Done включает конец хода (`turnEndedAt`): новый конец хода той же сессии — новый ключ, и прежний Clear его
 * не скрывает. Done не «работа»: `active` и провайдеры пилюли его не считают, а `done` — число таких строк.
 * Комната помечена `done`, если никто из её участников не в работе, а кто-то из них в Done.
 */

import type { WindowWorkEntry } from '@parley/core';
import { isSwarmTerminal, swarmMemberIds, swarmProgress, type SwarmStatus } from '@parley/core/swarms';
import { refKey, type LiveTask, type SessionRef } from '@parley/protocol';
import { sessionAttention } from '../attention/derive.js';
import { sessionRowLabel, workTitleText } from '../lib/participant.js';
import { projectName } from '../lib/project-name.js';
import { isRoomArchived } from '../lib/room-archive.js';
import { roomLiveLead } from '../lib/room-lead.js';
import { workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';

export interface IslandTaskSummary { items: readonly LiveTask[]; total: number | null; reported: number; }
type SessionBase = { kind: 'session'; key: string; ref: SessionRef; label: string; provider: string; tasks?: IslandTaskSummary };
export type IslandRow =
  | (SessionBase & { state: 'working' | 'needs-you' | 'subagents'; inTerminal: boolean })
  | (SessionBase & { state: 'done'; inTerminal: false; doneKey: string; turnEndedAt: string | null; seen: boolean })
  | { kind: 'room'; key: string; projectPath: string; workId: string; roomId: string; title: string; busy: number; done: boolean;
      proposal?: { key: string; kind: 'decision' | 'completion'; lead: string | null; leadLabel: string | null } }
  // Рой работы (спека роя v1, 7.4): его сессии отдельными рядами не стоят; клик ведёт к королеве.
  | { kind: 'work-swarm'; key: string; projectPath: string; workId: string; swarmId: string; queenId: string; tag: string; handed: number; total: number; state: SwarmStatus };

export interface IslandGroup {
  key: string;
  title: string;
  project: string;
  rows: IslandRow[];
}

export interface IslandModel {
  working: number;
  waiting: number;
  /** Сколько строк Done на острове (не скрытых Clear). */
  done: number;
  providers: string[];
  groups: IslandGroup[];
  active: boolean;
  /** Идущие рои всех работ: сколько их и сколько сдали из скольких — правый статус капсулы `🐝 3/5`. */
  swarm?: { count: number; handed: number; total: number };
  subagents?: number;
  proposals?: number;
}

function tasksFor(entry: ActivityEntry | undefined): IslandTaskSummary {
  const known = Array.isArray(entry?.metrics?.tasks);
  const seen = new Set<string>();
  const items = (entry?.metrics?.tasks ?? []).filter((task) => {
    if (typeof task.id !== 'string' || task.id.length === 0 || seen.has(task.id)) return false;
    seen.add(task.id); return true;
  }).slice(0, 8);
  const count = entry?.metrics?.subagents ?? entry?.activity.subagents ?? 0;
  const total = entry?.islandTasksTotal;
  return { items, reported: Number.isSafeInteger(count) && count >= 0 ? count : 0,
    total: total !== undefined && Number.isSafeInteger(total) && total >= 0 ? Math.max(items.length, total) : known ? items.length : null };
}

export function islandModel(
  entries: readonly WindowWorkEntry[],
  byRef: Readonly<Record<string, ActivityEntry>>,
  withCard: ReadonlySet<string>,
  cleared: ReadonlySet<string>,
  held: ReadonlySet<string>,
): IslandModel {
  let working = 0;
  let waiting = 0;
  let done = 0;
  let subagents = 0;
  let childrenActive = false;
  let proposals = 0;
  const swarmTotals = { count: 0, handed: 0, total: 0 };
  const providers = new Set<string>();
  const groups: IslandGroup[] = [];
  for (const entry of entries) {
    const { work } = entry.map;
    if (work.status !== 'active') continue;
    const rows: IslandRow[] = [];
    const doneRows: IslandRow[] = [];
    const busy = new Set<string>();
    const finished = new Set<string>();
    // Участники роя — не «в работе» и не Done: остров показывает рой одним рядом.
    const swarmSessions = swarmMemberIds(entry.map);
    for (const session of entry.map.sessions) {
      if (swarmSessions.has(session.id)) continue;
      const ref = { projectPath: entry.projectPath, workId: work.id, sessionId: session.id };
      const key = refKey(ref);
      const live = byRef[key]?.activity ?? null;
      const attention = sessionAttention(session, live);
      if (attention === 'off') continue;
      const state = attention === 'working' && live?.heldByBackground ? 'idle' : attention;
      const tasks = tasksFor(byRef[key]);
      const activeTasks = Math.max(tasks.reported, tasks.total ?? 0, tasks.items.length);
      const hasChildren = activeTasks > 0 || live?.heldByBackground === true;
      if (hasChildren) { childrenActive = true; subagents += activeTasks; }
      const base: SessionBase = { kind: 'session', key, ref, label: sessionRowLabel(session.id, session.label), provider: session.provider,
        ...(hasChildren ? { tasks } : {}) };
      const turnEndedAt = live?.turnEndedAt ?? null;
      const doneKey = `${key}\u0000${turnEndedAt ?? ''}`;
      const unseen = state === 'unseen';
      if ((unseen || (state === 'idle' && turnEndedAt !== null && held.has(doneKey))) && !cleared.has(doneKey)) {
        finished.add(session.id);
        done += 1;
        doneRows.push({ ...base, state: 'done', inTerminal: false, doneKey, turnEndedAt, seen: !unseen });
        continue;
      }
      if (hasChildren && state !== 'working' && state !== 'needs-you') {
        rows.push({ ...base, state: 'subagents', inTerminal: false });
        continue;
      }
      if (state !== 'working' && state !== 'needs-you') continue;
      busy.add(session.id);
      providers.add(session.provider);
      if (state === 'working') working += 1;
      else waiting += 1;
      rows.push({
        ...base,
        state,
        inTerminal: state === 'needs-you' && !withCard.has(key),
      });
    }
    // Сначала строки в работе и в ожидании, потом Done.
    rows.push(...doneRows);
    const groupKey = workKey(entry.projectPath, work.id);
    for (const room of entry.map.rooms) {
      if (isRoomArchived(room)) continue;
      const count = room.members.filter((id) => busy.has(id)).length;
      const isDone = count === 0 && room.members.some((id) => finished.has(id));
      const proposal = room.proposal != null && (room.proposal.kind === undefined || room.proposal.kind === 'decision' || room.proposal.kind === 'completion') ? room.proposal : null;
      if (count === 0 && !isDone && proposal === null) continue;
      const lead = proposal === null ? null : roomLiveLead(entry.map, room);
      const leader = entry.map.sessions.find((session) => session.id === lead);
      if (proposal !== null) proposals += 1;
      rows.push({ kind: 'room', key: `${groupKey}\u0000room\u0000${room.id}`, projectPath: entry.projectPath, workId: work.id, roomId: room.id, title: room.title, busy: count, done: isDone,
        ...(proposal === null ? {} : { proposal: { key: JSON.stringify([entry.projectPath, work.id, room.id, proposal.id, proposal.rev]), kind: proposal.kind ?? 'decision',
          lead, leadLabel: leader === undefined ? null : sessionRowLabel(leader.id, leader.label) } }),
      });
    }
    for (const swarm of entry.map.swarms ?? []) {
      const live = !isSwarmTerminal(swarm.status);
      // Законченный рой остаётся рядом, пока человек не увидел итог (`done`/`failed`).
      if (!live && !((swarm.status === 'done' || swarm.status === 'failed') && swarm.seenAt === null)) continue;
      const { handed, total } = swarmProgress(swarm);
      if (live) {
        swarmTotals.count += 1;
        swarmTotals.handed += handed;
        swarmTotals.total += total;
      }
      rows.push({ kind: 'work-swarm', key: `${groupKey}\u0000swarm\u0000${swarm.id}`, projectPath: entry.projectPath, workId: work.id, swarmId: swarm.id, queenId: swarm.queen, tag: swarm.tag, handed, total, state: swarm.status });
    }
    if (rows.length > 0) groups.push({ key: groupKey, title: workTitleText(work.title), project: projectName(entry.projectPath), rows });
  }
  return { working, waiting, done, providers: [...providers].sort(), groups, active: working + waiting > 0 || childrenActive || proposals > 0 || swarmTotals.count > 0,
    ...(childrenActive ? { subagents } : {}), ...(proposals > 0 ? { proposals } : {}), ...(swarmTotals.count > 0 ? { swarm: swarmTotals } : {}),
  };
}

/** Шапка карточки запроса: сессия, работа и проект по `refKey`. */
export function sessionLabels(entries: readonly WindowWorkEntry[]): Map<string, { session: string; work: string; project: string }> {
  const labels = new Map<string, { session: string; work: string; project: string }>();
  for (const entry of entries) {
    const work = workTitleText(entry.map.work.title);
    const project = projectName(entry.projectPath);
    for (const session of entry.map.sessions) {
      const key = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
      labels.set(key, { session: sessionRowLabel(session.id, session.label), work, project });
    }
  }
  return labels;
}
