import { describe, expect, it } from 'vitest';
import {
  AUTO_SLEEP_WORDS,
  NEED_WORDS,
  STATE_WORDS,
  agentStatus,
  asleepHint,
  autoSleepWord,
  dotState,
  liveStatus,
  needWord,
  reportedStatus,
  sessionDotState,
  sessionDotStateWithNeed,
  stateWord,
  type Activity,
  type DotState,
  type SessionLifecycle,
  type SessionResult,
  type SessionStatus,
} from './session-state.js';
import type { SessionNeed } from './stuck.js';
import type { AutoSleep } from './types.js';

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

describe('agentStatus: сон по решению хоста', () => {
  const slept: AutoSleep = { reason: 'idle', at: '2026-10-31T12:00:00.000Z', waitTarget: null };

  it('усыплённая хостом сессия без итога — asleep, а не exited', () => {
    expect(agentStatus({ lifecycle: 'sleeping', result: null, autoSleep: slept })).toBe('asleep');
    expect(agentStatus({ lifecycle: 'sleeping', autoSleep: slept })).toBe('asleep');
  });

  it('остановленная человеком (autoSleep пуст или нет) — exited, как у reportedStatus', () => {
    expect(agentStatus({ lifecycle: 'sleeping', result: null, autoSleep: null })).toBe('exited');
    expect(agentStatus({ lifecycle: 'sleeping', result: null })).toBe('exited');
  });

  it('итог важнее сна: усыплённая хостом с итогом показывает итог', () => {
    expect(agentStatus({ lifecycle: 'sleeping', result: 'done', autoSleep: slept })).toBe('done');
    expect(agentStatus({ lifecycle: 'sleeping', result: 'failed', autoSleep: slept })).toBe('failed');
  });

  it('отметка сна решает только у sleeping: у остальных осей статус как у reportedStatus', () => {
    for (const lifecycle of ['pending', 'active', 'closed'] as const) {
      for (const result of [null, 'done', 'failed'] as const) {
        expect(agentStatus({ lifecycle, result, autoSleep: slept })).toBe(reportedStatus({ lifecycle, result }));
      }
    }
  });

  it('без сна всё как у reportedStatus', () => {
    for (const lifecycle of ['pending', 'active', 'sleeping', 'closed'] as const) {
      for (const result of [null, 'done', 'failed'] as const) {
        expect(agentStatus({ lifecycle, result })).toBe(reportedStatus({ lifecycle, result }));
      }
    }
  });
});

describe('слова сна по решению хоста', () => {
  it('AUTO_SLEEP_WORDS: слово на каждую причину, autoSleepWord берёт из таблицы', () => {
    expect(AUTO_SLEEP_WORDS).toEqual({ idle: 'asleep · idle', 'swarm-done': 'asleep · swarm done' });
    expect(autoSleepWord('idle')).toBe('asleep · idle');
    expect(autoSleepWord('swarm-done')).toBe('asleep · swarm done');
  });

  it('asleepHint: подсказка тому, кто ждёт усыплённую цель', () => {
    expect(asleepHint('s-07')).toBe('s-07 is asleep until mail arrives: write to it, or wait for mail via inbox.');
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

describe('sessionDotStateWithNeed', () => {
  const need: SessionNeed = {
    kind: 'limit',
    since: '2026-10-21T12:00:00.000Z',
    detail: null,
    resetsAt: null,
    window: null,
    account: null,
  };

  it('у живой сессии с need точка blocked, что бы ни говорила activity', () => {
    for (const activity of ['working', 'blocked', 'unseen', 'idle', null] as const) {
      expect(sessionDotStateWithNeed({ lifecycle: 'active' }, activity, need)).toBe('blocked');
    }
  });

  it('итог живой сессии need не отменяет', () => {
    expect(sessionDotStateWithNeed({ lifecycle: 'active', result: 'done' }, 'unseen', need)).toBe('blocked');
  });

  it('без need — как sessionDotState', () => {
    expect(sessionDotStateWithNeed({ lifecycle: 'active' }, 'unseen', null)).toBe('unseen');
    expect(sessionDotStateWithNeed({ lifecycle: 'active' }, null, null)).toBe('idle');
  });

  it('у спящей, ожидающей и закрытой need не считается: точка по статусу карты', () => {
    expect(sessionDotStateWithNeed({ lifecycle: 'sleeping' }, 'idle', need)).toBe('exited');
    expect(sessionDotStateWithNeed({ lifecycle: 'sleeping', result: 'failed' }, null, need)).toBe('failed');
    expect(sessionDotStateWithNeed({ lifecycle: 'closed' }, null, need)).toBe('exited');
    expect(sessionDotStateWithNeed({ lifecycle: 'pending' }, null, need)).toBe('pending');
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

describe('needWord', () => {
  it('одно слово на вид need (спека подписок 7, правило 2026-10-17)', () => {
    expect(needWord('limit')).toBe('limit');
    expect(needWord('startup')).toBe('starting');
    expect(Object.keys(NEED_WORDS)).toEqual(['approval', 'question', 'limit', 'sign-in', 'startup']);
  });
});
