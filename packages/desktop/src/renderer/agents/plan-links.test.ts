import { expect, it } from 'vitest';
import type { WindowWorkEntry, RoomPlan, PlanItem } from '@parley/core';
import { roomPlanLinks } from './plan-links.js';
it('takes only this session assignments in active or completing room plans', () => {
  const item = (id: number, owner: string, status: PlanItem['status']): PlanItem => ({
    id,
    owner,
    status,
    title: `Item ${id}`,
    scope: 'Scope',
    after: [],
    criteria: [],
    verifier: null,
    evidence: null,
    note: null,
    log: [],
  });
  const plan = (status: RoomPlan['status']): RoomPlan => ({
    id: 'pl-01',
    roomId: 'r-01',
    status,
    mode: 'checklist',
    rev: 0,
    goal: '',
    items: [
      item(1, 's-01', 'ready'),
      item(2, 's-02', 'ready'),
      item(3, 's-01', 'done'),
      item(4, 's-01', 'in_progress'),
      item(5, 's-01', 'blocked'),
      item(6, 's-01', 'returned'),
    ],
    backlog: [],
    acceptedAt: null,
    completedAt: null,
    cancelledAt: null,
    completionSummary: null,
  });
  const entry = {
    map: { plans: [plan('active'), { ...plan('completing'), id: 'pl-02' }, plan('completed')] },
  } as WindowWorkEntry;
  expect(roomPlanLinks(entry, 's-01').map((link) => [link.planId, link.itemId])).toEqual([
    ['pl-01', 1],
    ['pl-01', 4],
    ['pl-01', 5],
    ['pl-01', 6],
    ['pl-02', 1],
    ['pl-02', 4],
    ['pl-02', 5],
    ['pl-02', 6],
  ]);
});
