import { describe, expect, it } from 'vitest';
import {
  STATE_WORDS,
  dotState,
  liveStatus,
  reportedStatus,
  sessionDotState,
  stateWord,
  type Activity,
  type DotState,
  type SessionLifecycle,
  type SessionResult,
  type SessionStatus,
} from './session-state.js';

describe('reportedStatus и liveStatus', () => {
  // Таблица двух осей (план этапа 3, 3.1): бриф и MCP ставят итог выше процесса, окно и помощник у живой — нет.
  const table: Array<[SessionLifecycle, SessionResult | null, SessionStatus, SessionStatus]> = [
    ['pending', null, 'pending', 'pending'],
    ['pending', 'done', 'pending', 'pending'],
    ['pending', 'failed', 'pending', 'pending'],
    ['active', null, 'active', 'active'],
    ['active', 'done', 'done', 'active'],
    ['active', 'failed', 'failed', 'active'],
    ['sleeping', null, 'exited', 'exited'],
    ['sleeping', 'done', 'done', 'done'],
    ['sleeping', 'failed', 'failed', 'failed'],
    ['closed', null, 'exited', 'exited'],
    ['closed', 'done', 'done', 'done'],
    ['closed', 'failed', 'failed', 'failed'],
  ];

  it.each(table)('%s + %s → бриф %s, окно %s', (lifecycle, result, reported, live) => {
    expect(reportedStatus({ lifecycle, result })).toBe(reported);
    expect(liveStatus({ lifecycle, result })).toBe(live);
  });

  it('живая сессия с итогом: бриф видит итог, окно нет', () => {
    expect(reportedStatus({ lifecycle: 'active', result: 'done' })).toBe('done');
    expect(liveStatus({ lifecycle: 'active', result: 'done' })).toBe('active');
  });

  it('ось итога можно не передавать', () => {
    expect(reportedStatus({ lifecycle: 'active' })).toBe('active');
    expect(liveStatus({ lifecycle: 'sleeping' })).toBe('exited');
  });
});

describe('dotState', () => {
  it('у живой сессии точку ведёт activity', () => {
    const activities: Activity[] = ['working', 'blocked', 'unseen', 'idle'];
    for (const activity of activities) expect(dotState('active', activity)).toBe(activity);
  });

  it('живая сессия без выведенной activity — тусклая', () => {
    expect(dotState('active', null)).toBe('idle');
  });

  it.each<SessionStatus>(['pending', 'exited', 'done', 'failed'])(
    'не-active %s остаётся как есть, activity не влияет',
    (status) => {
      expect(dotState(status, null)).toBe(status);
      expect(dotState(status, 'working')).toBe(status);
    },
  );
});

describe('sessionDotState', () => {
  it('итог живой сессии не показывается: ведёт activity', () => {
    expect(sessionDotState({ lifecycle: 'active', result: 'done' }, 'working')).toBe('working');
  });

  it('живая сессия без activity — idle', () => {
    expect(sessionDotState({ lifecycle: 'active' }, null)).toBe('idle');
  });

  it('спящая сессия без итога — exited, activity не влияет', () => {
    expect(sessionDotState({ lifecycle: 'sleeping' }, 'idle')).toBe('exited');
  });

  it('спящая сессия с итогом показывает итог', () => {
    expect(sessionDotState({ lifecycle: 'sleeping', result: 'failed' }, 'working')).toBe('failed');
  });
});

describe('stateWord', () => {
  it('exited у закрытой сессии — closed', () => {
    expect(stateWord('exited', 'closed')).toBe('closed');
  });

  it('exited у спящей сессии — asleep', () => {
    expect(stateWord('exited', 'sleeping')).toBe('asleep');
  });

  it('blocked — needs you', () => {
    expect(stateWord('blocked', 'active')).toBe('needs you');
  });

  it('остальные состояния берут слово из таблицы, жизненный цикл не важен', () => {
    const expected: Array<[DotState, string]> = [
      ['working', 'working'],
      ['unseen', 'done · unseen'],
      ['idle', 'idle'],
      ['pending', 'not started'],
      ['done', 'done'],
      ['failed', 'failed'],
    ];
    for (const [state, word] of expected) expect(stateWord(state, 'closed')).toBe(word);
  });
});

describe('STATE_WORDS', () => {
  it('ровно девять слов состояния', () => {
    expect(STATE_WORDS).toEqual({
      working: 'working',
      blocked: 'needs you',
      unseen: 'done · unseen',
      idle: 'idle',
      pending: 'not started',
      asleep: 'asleep',
      closed: 'closed',
      done: 'done',
      failed: 'failed',
    });
  });
});
