import type { SessionStatus, WorkEntry, WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import type { LiveMetrics } from './work-rows.js';
import { idleTransitions } from './work-lifecycle.js';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'бэкенд',
    task: 'шаги 1–3',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: minutesAgo(60),
    endedAt: null,
    providerSessionId: 'uuid-1',
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

function entry(sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: '/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: 'w-0042',
        title: 'Авторизация',
        goal: '',
        status: 'active',
        createdAt: minutesAgo(120),
        updatedAt: minutesAgo(10),
      },
      sessions,
      messages: [],
    },
  };
}

const metrics = (lastRecordAt: string | null): LiveMetrics => ({
  durationMs: null,
  tokens: null,
  model: null,
  lastRecordAt,
});

const at = (last: string | null) => (): LiveMetrics => metrics(last);

describe('idleTransitions', () => {
  it('молчащая дольше порога active уходит в idle', () => {
    const found = idleTransitions([entry([session()])], at(minutesAgo(14)), { now: NOW });
    expect(found).toEqual([
      { projectPath: '/dev/shop', workId: 'w-0042', sessionId: 's-01', to: 'idle' },
    ]);
  });

  it('свежая запись возвращает idle в active', () => {
    const found = idleTransitions([entry([session({ status: 'idle' })])], at(minutesAgo(1)), {
      now: NOW,
    });
    expect(found.map((item) => item.to)).toEqual(['active']);
  });

  it('порог настраивается', () => {
    const rows = [entry([session()])];
    expect(idleTransitions(rows, at(minutesAgo(3)), { now: NOW })).toEqual([]);
    expect(idleTransitions(rows, at(minutesAgo(3)), { now: NOW, idleMs: 60_000 })).toHaveLength(1);
  });

  it('прочие статусы харнесс по молчанию не двигает', () => {
    const statuses: SessionStatus[] = ['pending', 'exited', 'done', 'failed'];
    for (const status of statuses) {
      expect(
        idleTransitions([entry([session({ status })])], at(minutesAgo(99)), { now: NOW }),
      ).toEqual([]);
    }
  });

  it('без записей в логе простой считать не от чего', () => {
    expect(idleTransitions([entry([session()])], at(null), { now: NOW })).toEqual([]);
  });
});
