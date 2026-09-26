import type { WorkEntry, WorkMap, WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { providerMarkOf, sessionOrders, treeOrder, workKey } from './work-rows.js';

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'составить план',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: '2026-09-05T09:12:00.000Z',
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

function entry(projectPath: string, id: string, sessions: WorkSession[] = []): WorkEntry {
  const work: WorkMap['work'] = {
    id,
    title: id,
    goal: '',
    status: 'active',
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  return { projectPath, map: { schemaVersion: 2, work, sessions, messages: [], rooms: [] } };
}

const ids = (sessions: WorkSession[]): Array<[string, number]> =>
  treeOrder(sessions).map((item) => [item.session.id, item.depth]);

describe('treeOrder', () => {
  it('дети идут сразу под родителем, корни — в порядке создания', () => {
    expect(
      ids([
        session({ id: 's-01' }),
        session({ id: 's-02' }),
        session({ id: 's-03', parent: 's-01' }),
        session({ id: 's-04', parent: 's-03' }),
      ]),
    ).toEqual([
      ['s-01', 0],
      ['s-03', 1],
      ['s-04', 2],
      ['s-02', 0],
    ]);
  });

  it('сессия с неизвестным родителем остаётся корнем, а не пропадает', () => {
    expect(ids([session({ id: 's-02', parent: 'нет-такой' })])).toEqual([['s-02', 0]]);
  });
});

describe('sessionOrders', () => {
  it('порядок сессий каждой работы лежит под её ключом', () => {
    const orders = sessionOrders([
      entry('/dev/shop', 'w-0001', [
        session({ id: 's-01' }),
        session({ id: 's-02', parent: 's-01' }),
      ]),
      entry('/dev/site', 'w-0001', [session({ id: 's-09' })]),
    ]);

    // Id работы уникален только внутри проекта: у ключа две половины.
    expect([...orders.keys()]).toEqual(['/dev/shop w-0001', '/dev/site w-0001']);
    expect(orders.get(workKey('/dev/shop', 'w-0001'))).toEqual(['s-01', 's-02']);
    expect(orders.get(workKey('/dev/site', 'w-0001'))).toEqual(['s-09']);
  });
});

describe('providerMarkOf', () => {
  it('берёт ярлык из реестра, а незнакомому провайдеру показывает его id', () => {
    expect(providerMarkOf('claude')).toBe('Cl');
    expect(providerMarkOf('свой-cli')).toBe('свой-cli');
  });
});
