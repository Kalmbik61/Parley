import { describe, expect, it } from 'vitest';
import type { Activity, SessionStatus } from '@harnas/core';
import { displayStatus, dotState, maxDotState, stateWord, type DotState } from './dot-state.js';

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

describe('stateWord', () => {
  // Тест 6 куска 1.2 плана: девять строк таблицы спеки 4.2 (`exited` даёт две
  // строки — по `lifecycle`). Второй параметр для остальных состояний не
  // влияет на результат, но обязателен по сигнатуре — передаём правдоподобный.
  it('working → «работает»', () => {
    expect(stateWord('working', 'active')).toBe('Working');
  });

  it('blocked → «ждёт тебя»', () => {
    expect(stateWord('blocked', 'active')).toBe('Needs you');
  });

  it('unseen → «закончил · не просмотрено»', () => {
    expect(stateWord('unseen', 'active')).toBe('Done · unseen');
  });

  it('idle → «простаивает»', () => {
    expect(stateWord('idle', 'active')).toBe('Idle');
  });

  it('pending → «ожидает запуска»', () => {
    expect(stateWord('pending', 'pending')).toBe('Not started');
  });

  it('exited + sleeping → «спит»', () => {
    expect(stateWord('exited', 'sleeping')).toBe('Asleep');
  });

  it('exited + closed → «закрыта»', () => {
    expect(stateWord('exited', 'closed')).toBe('Closed');
  });

  it('done → «готово»', () => {
    expect(stateWord('done', 'closed')).toBe('Done');
  });

  it('failed → «сбой»', () => {
    expect(stateWord('failed', 'closed')).toBe('Failed');
  });
});
