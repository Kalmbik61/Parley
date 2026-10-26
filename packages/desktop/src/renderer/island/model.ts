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

import type { WorkEntry } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { sessionAttention } from '../attention/derive.js';
import { sessionRowLabel, workTitleText } from '../lib/participant.js';
import { projectName } from '../lib/project-name.js';
import { isRoomArchived } from '../lib/room-archive.js';
import { workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';

export type IslandRow =
  | { kind: 'session'; key: string; ref: SessionRef; label: string; provider: string; state: 'working' | 'needs-you'; inTerminal: boolean }
  | { kind: 'session'; key: string; ref: SessionRef; label: string; provider: string; state: 'done'; inTerminal: false; doneKey: string; turnEndedAt: string | null; seen: boolean }
  | { kind: 'room'; key: string; projectPath: string; workId: string; roomId: string; title: string; busy: number; done: boolean };

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
}

export function islandModel(
  entries: readonly WorkEntry[],
  byRef: Readonly<Record<string, ActivityEntry>>,
  withCard: ReadonlySet<string>,
  cleared: ReadonlySet<string>,
  held: ReadonlySet<string>,
): IslandModel {
  let working = 0;
  let waiting = 0;
  let done = 0;
  const providers = new Set<string>();
  const groups: IslandGroup[] = [];
  for (const entry of entries) {
    const { work } = entry.map;
    if (work.status !== 'active') continue;
    const rows: IslandRow[] = [];
    const doneRows: IslandRow[] = [];
    const busy = new Set<string>();
    const finished = new Set<string>();
    for (const session of entry.map.sessions) {
      const ref = { projectPath: entry.projectPath, workId: work.id, sessionId: session.id };
      const key = refKey(ref);
      const live = byRef[key]?.activity ?? null;
      const state = sessionAttention(session, live);
      const turnEndedAt = live?.turnEndedAt ?? null;
      const doneKey = `${key}\u0000${turnEndedAt ?? ''}`;
      const unseen = state === 'unseen';
      if (unseen || (state === 'idle' && turnEndedAt !== null && held.has(doneKey))) {
        if (cleared.has(doneKey)) continue;
        finished.add(session.id);
        done += 1;
        doneRows.push({ kind: 'session', key, ref, label: sessionRowLabel(session.id, session.label), provider: session.provider, state: 'done', inTerminal: false, doneKey, turnEndedAt, seen: !unseen });
        continue;
      }
      if (state !== 'working' && state !== 'needs-you') continue;
      busy.add(session.id);
      providers.add(session.provider);
      if (state === 'working') working += 1;
      else waiting += 1;
      rows.push({
        kind: 'session',
        key,
        ref,
        label: sessionRowLabel(session.id, session.label),
        provider: session.provider,
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
      if (count === 0 && !isDone) continue;
      rows.push({ kind: 'room', key: `${groupKey}\u0000room\u0000${room.id}`, projectPath: entry.projectPath, workId: work.id, roomId: room.id, title: room.title, busy: count, done: isDone });
    }
    if (rows.length > 0) groups.push({ key: groupKey, title: workTitleText(work.title), project: projectName(entry.projectPath), rows });
  }
  return { working, waiting, done, providers: [...providers].sort(), groups, active: working + waiting > 0 };
}

/** Шапка карточки запроса: сессия, работа и проект по `refKey`. */
export function sessionLabels(entries: readonly WorkEntry[]): Map<string, { session: string; work: string; project: string }> {
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
