import { describe, expect, it } from 'vitest';
import { sessionOrders, sessionSequence, treeOrder, workKey } from './tree-order.js';
import type { WorkSession } from '@harnas/core';

function session(id: string, parent: string | null, status: WorkSession['status'] = 'active'): WorkSession {
  return {
    id,
    provider: 'claude',
    label: id,
    task: '',
    parent,
    contextFrom: [],
    status,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

describe('treeOrder', () => {
  it('корни по порядку создания, дети сразу под родителем', () => {
    const sessions = [session('s-01', null), session('s-02', 's-01'), session('s-03', null)];

    const order = treeOrder(sessions).map((item) => `${item.session.id}:${item.depth}`);

    expect(order).toEqual(['s-01:0', 's-02:1', 's-03:0']);
  });

  it('вложенность и порядок не меняются от смены статусов', () => {
    const base = [session('s-01', null), session('s-02', 's-01'), session('s-03', 's-02')];
    const changed = [
      session('s-01', null, 'done'),
      session('s-02', 's-01', 'failed'),
      session('s-03', 's-02', 'exited'),
    ];

    const before = treeOrder(base).map((item) => `${item.session.id}:${item.depth}`);
    const after = treeOrder(changed).map((item) => `${item.session.id}:${item.depth}`);

    expect(after).toEqual(before);
  });

  it('сессия с чужим/пропавшим родителем — тоже корень', () => {
    const sessions = [session('s-02', 's-nope')];

    expect(treeOrder(sessions)).toEqual([{ session: sessions[0], depth: 0 }]);
  });
});

describe('sessionSequence', () => {
  it('склеивает работы по порядку ключей', () => {
    const orders = new Map([
      ['work-a', ['s-01', 's-02']],
      ['work-b', ['s-03']],
    ]);

    expect(sessionSequence(['work-a', 'work-b'], orders)).toEqual([
      { work: 'work-a', session: 's-01' },
      { work: 'work-a', session: 's-02' },
      { work: 'work-b', session: 's-03' },
    ]);
  });
});

describe('workKey / sessionOrders', () => {
  it('workKey соединяет путь проекта и id работы', () => {
    expect(workKey('/tmp/proj', 'w-01')).toBe('/tmp/proj w-01');
  });

  it('sessionOrders строит порядок для каждой работы из WorkEntry', () => {
    const entries = [
      {
        projectPath: '/tmp/proj',
        map: {
          schemaVersion: 1 as const,
          work: { id: 'w-01', title: 't', goal: '', status: 'active' as const, createdAt: '', updatedAt: '' },
          sessions: [session('s-01', null), session('s-02', 's-01')],
          messages: [],
        },
      },
    ];

    const orders = sessionOrders(entries);
    expect(orders.get(workKey('/tmp/proj', 'w-01'))).toEqual(['s-01', 's-02']);
  });
});
