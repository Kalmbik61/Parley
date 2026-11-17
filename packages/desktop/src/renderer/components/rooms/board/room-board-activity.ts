/** Метки пунктов у участников и лента перемен доски: чистые функции от плана и карты. */
import type { PlanAttempt, PlanItemStatus, Room, RoomPlan, WindowWorkEntry } from '@parley/core';
import { planItemDuties } from '@parley/core/plan-state';
import { isoMs } from '../../../lib/iso-time.js';
import { roomLiveLead, roomVerifierUnavailable } from '../../../lib/room-lead.js';
import { lastAttempt } from '../latest-attempt-check.js';

/** Сессия → номера пунктов, по которым она сейчас должна действовать, по возрастанию. */
export function participantItemTags(plan: RoomPlan, room: Room, entry: WindowWorkEntry): ReadonlyMap<string, number[]> {
  const tags = new Map<string, number[]>();
  if (plan.status !== 'active' && plan.status !== 'completing') return tags;
  const tag = (sessionId: string, itemId: number): void => {
    const ids = tags.get(sessionId);
    if (ids === undefined) tags.set(sessionId, [itemId]);
    else if (!ids.includes(itemId)) ids.push(itemId);
  };
  if (plan.mode === 'autonomous') {
    if (plan.autonomous?.halted != null) return tags;
    for (const item of plan.items) {
      const attempt = lastAttempt(plan, item.id);
      if (attempt === undefined) continue;
      if (attempt.worker !== null && (attempt.status === 'starting' || attempt.status === 'running')) tag(attempt.worker, item.id);
      if (attempt.verifier !== null && (attempt.status === 'submitted' || attempt.status === 'checking')) tag(attempt.verifier, item.id);
    }
  } else {
    const live = roomLiveLead(entry.map, room);
    for (const item of plan.items)
      for (const duty of planItemDuties(plan, item, live, roomVerifierUnavailable(entry.map, room, item.verifier)))
        if (duty.action !== 'wait' && duty.sessionId !== 'human') tag(duty.sessionId, item.id);
  }
  for (const ids of tags.values()) ids.sort((a, b) => a - b);
  return tags;
}

export type BoardEventStatus =
  | { source: 'item'; status: PlanItemStatus }
  | { source: 'attempt'; status: PlanAttempt['status'] };
export interface BoardEvent { at: string; by: string; itemId: number; change: BoardEventStatus }

const ATTEMPT_PHASES: PlanAttempt['status'][] = ['submitted', 'checking', 'accepted', 'queued'];
const timeOf = (at: string): number => isoMs(at) ?? Number.NEGATIVE_INFINITY;

/** Последние перемены плана, новые первыми; по умолчанию три. */
export function boardEvents(plan: RoomPlan, limit = 3): BoardEvent[] {
  const events: BoardEvent[] = [];
  for (const item of plan.items)
    for (const row of item.log) events.push({ at: row.at, by: row.by, itemId: item.id, change: { source: 'item', status: row.status } });
  if (plan.mode === 'autonomous')
    for (const attempt of plan.autonomous?.attempts ?? [])
      attempt.log.forEach((row, index) => {
        if (!ATTEMPT_PHASES.includes(row.status)) return;
        if (index > 0 && attempt.log[index - 1]!.status === row.status) return;
        events.push({ at: row.at, by: row.by, itemId: attempt.item, change: { source: 'attempt', status: row.status } });
      });
  // Сортировка устойчива: при полном равенстве остаётся порядок сбора.
  return events
    .sort((a, b) => timeOf(b.at) - timeOf(a.at) || a.itemId - b.itemId || Number(a.change.source === 'attempt') - Number(b.change.source === 'attempt'))
    .slice(0, limit);
}
