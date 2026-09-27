import { describe, expect, it } from 'vitest';
import type { Activity, SessionStatus } from '@harnas/core';
import {
  displayStatus,
  dotColorVar,
  dotState,
  maxDotState,
  stateWord,
  STATE_WORDS,
  type DotState,
} from './dot-state.js';

const STATUSES: SessionStatus[] = ['pending', 'active', 'exited', 'done', 'failed'];
const ACTIVITIES: Array<Activity | null> = ['working', 'blocked', 'unseen', 'idle', null];

describe('displayStatus', () => {
  // Копия core/work/status-view.ts: та же таблица, что и в её тесте.
  it.each([
    ['pending', null, 'pending'],
    ['active', null, 'active'],
    ['active', 'done', 'done'],
    ['sleeping', null, 'exited'],
    ['sleeping', 'failed', 'failed'],
    ['closed', null, 'exited'],
    ['closed', 'done', 'done'],
  ] as const)('%s + %s → %s', (lifecycle, result, expected) => {
    expect(displayStatus({ lifecycle, result })).toBe(expected);
  });
});

describe('dotState', () => {
  it('таблица всех сочетаний статуса и активности', () => {
    const table: Record<string, DotState> = {};
    for (const status of STATUSES) {
      for (const activity of ACTIVITIES) {
        table[`${status}/${activity ?? 'null'}`] = dotState(status, activity);
      }
    }

    // Не-active статусы игнорируют activity — состояние берётся из статуса.
    expect(table['pending/working']).toBe('pending');
    expect(table['exited/blocked']).toBe('exited');
    expect(table['done/idle']).toBe('done');
    expect(table['failed/null']).toBe('failed');

    // active со всеми activity — activity как есть, а без неё — idle.
    expect(table['active/working']).toBe('working');
    expect(table['active/blocked']).toBe('blocked');
    expect(table['active/unseen']).toBe('unseen');
    expect(table['active/idle']).toBe('idle');
    expect(table['active/null']).toBe('idle');
  });
});

describe('maxDotState', () => {
  it('null — сессий нет', () => {
    expect(maxDotState([])).toBeNull();
  });

  it('порядок важности: blocked выше working выше unseen выше failed выше idle/pending/exited выше done', () => {
    expect(maxDotState(['done', 'idle', 'blocked'])).toBe('blocked');
    expect(maxDotState(['done', 'working'])).toBe('working');
    expect(maxDotState(['exited', 'unseen'])).toBe('unseen');
    expect(maxDotState(['done', 'exited'])).toBe('exited');
    expect(maxDotState(['done'])).toBe('done');
  });
});

describe('STATE_WORDS', () => {
  it('слово есть у каждого состояния', () => {
    const states: DotState[] = ['working', 'blocked', 'unseen', 'idle', 'pending', 'exited', 'done', 'failed'];
    for (const state of states) {
      expect(STATE_WORDS[state]).toBeTypeOf('string');
      expect(STATE_WORDS[state].length).toBeGreaterThan(0);
    }
  });

  it('blocked и unseen совпадают с заголовками уведомлений', () => {
    expect(STATE_WORDS.blocked).toBe('ждёт ответа');
    expect(STATE_WORDS.unseen).toBe('закончила ход');
  });
});

describe('stateWord', () => {
  // Тест 6 куска 1.2 плана: девять строк таблицы спеки 4.2 (`exited` даёт две
  // строки — по `lifecycle`). Второй параметр для остальных состояний не
  // влияет на результат, но обязателен по сигнатуре — передаём правдоподобный.
  it('working → «работает»', () => {
    expect(stateWord('working', 'active')).toBe('работает');
  });

  it('blocked → «ждёт тебя»', () => {
    expect(stateWord('blocked', 'active')).toBe('ждёт тебя');
  });

  it('unseen → «закончил · не просмотрено»', () => {
    expect(stateWord('unseen', 'active')).toBe('закончил · не просмотрено');
  });

  it('idle → «простаивает»', () => {
    expect(stateWord('idle', 'active')).toBe('простаивает');
  });

  it('pending → «ожидает запуска»', () => {
    expect(stateWord('pending', 'pending')).toBe('ожидает запуска');
  });

  it('exited + sleeping → «спит»', () => {
    expect(stateWord('exited', 'sleeping')).toBe('спит');
  });

  it('exited + closed → «закрыта»', () => {
    expect(stateWord('exited', 'closed')).toBe('закрыта');
  });

  it('done → «готово»', () => {
    expect(stateWord('done', 'closed')).toBe('готово');
  });

  it('failed → «сбой»', () => {
    expect(stateWord('failed', 'closed')).toBe('сбой');
  });
});

describe('dotColorVar', () => {
  it('у done цвета нет', () => {
    expect(dotColorVar('done')).toBeNull();
  });

  it('у остальных состояний цвет есть', () => {
    const states: DotState[] = ['working', 'blocked', 'unseen', 'idle', 'pending', 'exited', 'failed'];
    for (const state of states) {
      expect(dotColorVar(state)).not.toBeNull();
    }
  });
});
