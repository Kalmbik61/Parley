import { describe, expect, it } from 'vitest';
import { displayStatus, historyStatus } from './status-view.js';
import type { SessionLifecycle, SessionResult, SessionStatus } from './types.js';

describe('displayStatus', () => {
  // Таблица всех сочетаний двух осей (план этапа 3, 3.1): итог важнее процесса.
  const table: Array<[SessionLifecycle, SessionResult | null, SessionStatus]> = [
    ['pending', null, 'pending'],
    ['pending', 'done', 'pending'],
    ['pending', 'failed', 'pending'],
    ['active', null, 'active'],
    ['active', 'done', 'done'],
    ['active', 'failed', 'failed'],
    ['sleeping', null, 'exited'],
    ['sleeping', 'done', 'done'],
    ['sleeping', 'failed', 'failed'],
    ['closed', null, 'exited'],
    ['closed', 'done', 'done'],
    ['closed', 'failed', 'failed'],
  ];

  it.each(table)('%s + %s → %s', (lifecycle, result, expected) => {
    expect(displayStatus({ lifecycle, result })).toBe(expected);
  });
});

describe('historyStatus', () => {
  it.each([
    ['pending', 'pending'],
    ['active', 'active'],
    ['sleeping', 'exited'],
    ['closed', 'exited'],
    ['done', 'done'],
    ['failed', 'failed'],
  ] as const)('%s → %s', (event, expected) => {
    expect(historyStatus({ event })).toBe(expected);
  });
});
