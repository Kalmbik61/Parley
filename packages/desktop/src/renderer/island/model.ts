/**
 * Что показывает остров в покое (спека 2026-10-12, раздел 4): счётчики пилюли и список «в работе» по работам.
 * Чистая функция: работы окна, активность и множество сессий, у которых в очереди острова есть карточка
 * (без неё ждущая сессия — «waiting in terminal»). «В работе»: сессия — `sessionAttention` даёт `working` или
 * `needs-you`; комната — в работе хотя бы один её участник; «finished, not seen» не считается. Codex вне острова.
 */

import type { WorkEntry } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { ISLAND_EXCLUDED_PROVIDERS } from '../../shared/island.js';
import { sessionAttention } from '../attention/derive.js';
import { sessionRowLabel, workTitleText } from '../lib/participant.js';
import { projectName } from '../lib/project-name.js';
import { isRoomArchived } from '../lib/room-archive.js';
import { workKey } from '../lib/tree-order.js';
import type { ActivityEntry } from '../store/activity.js';

export type IslandRow =
  | { kind: 'session'; key: string; ref: SessionRef; label: string; provider: string; state: 'working' | 'needs-you'; inTerminal: boolean }
  | { kind: 'room'; key: string; projectPath: string; workId: string; roomId: string; title: string; busy: number };

export interface IslandGroup {
  key: string;
  title: string;
  project: string;
  rows: IslandRow[];
}

export interface IslandModel {
  working: number;
  waiting: number;
  providers: string[];
  groups: IslandGroup[];
  active: boolean;
}

export function islandModel(
  entries: readonly WorkEntry[],
  byRef: Readonly<Record<string, ActivityEntry>>,
  withCard: ReadonlySet<string>,
): IslandModel {
  let working = 0;
  let waiting = 0;
  const providers = new Set<string>();
  const groups: IslandGroup[] = [];
  for (const entry of entries) {
    const { work } = entry.map;
    if (work.status !== 'active') continue;
    const rows: IslandRow[] = [];
    const busy = new Set<string>();
    for (const session of entry.map.sessions) {
      if (ISLAND_EXCLUDED_PROVIDERS.has(session.provider)) continue;
      const ref = { projectPath: entry.projectPath, workId: work.id, sessionId: session.id };
      const key = refKey(ref);
      const state = sessionAttention(session, byRef[key]?.activity ?? null);
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
    const groupKey = workKey(entry.projectPath, work.id);
    for (const room of entry.map.rooms) {
      if (isRoomArchived(room)) continue;
      const count = room.members.filter((id) => busy.has(id)).length;
      if (count === 0) continue;
      rows.push({ kind: 'room', key: `${groupKey}\u0000room\u0000${room.id}`, projectPath: entry.projectPath, workId: work.id, roomId: room.id, title: room.title, busy: count });
    }
    if (rows.length > 0) groups.push({ key: groupKey, title: workTitleText(work.title), project: projectName(entry.projectPath), rows });
  }
  return { working, waiting, providers: [...providers].sort(), groups, active: working + waiting > 0 };
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
