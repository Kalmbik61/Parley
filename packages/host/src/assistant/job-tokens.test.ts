import { describe, expect, it } from 'vitest';
import type { HumanOverviewV1 } from '@parley/protocol';
import { JOB_TOKEN_PREFIX } from '@parley/core';
import { createJobTokens } from './job-tokens.js';

describe('токены job', () => {
  it('у каждого job свой токен с префиксом job; токен определяет jobId', () => {
    const tokens = createJobTokens();
    const a = tokens.issue('job-a');
    const b = tokens.issue('job-b');
    expect(a).not.toBe(b);
    expect(a.startsWith(JOB_TOKEN_PREFIX)).toBe(true);
    expect(tokens.jobOf(a)).toBe('job-a');
    expect(tokens.jobOf(b)).toBe('job-b');
    expect(tokens.jobOf('job_unknown')).toBeNull();
    expect(tokens.jobOf('')).toBeNull();
  });

  it('новый токен того же job заменяет прежний; revoke снимает токен', () => {
    const tokens = createJobTokens();
    const old = tokens.issue('job-a');
    const fresh = tokens.issue('job-a');
    expect(tokens.jobOf(old)).toBeNull();
    expect(tokens.jobOf(fresh)).toBe('job-a');
    tokens.revoke('job-a');
    expect(tokens.jobOf(fresh)).toBeNull();
  });

  it('хост записывает вызовы и карточки, take забирает их один раз', () => {
    let at = 100;
    const tokens = createJobTokens(() => at++);
    tokens.issue('job-a');
    tokens.recordTool('job-a', 'parley_overview', true);
    tokens.recordTool('job-a', 'propose_message', false);
    tokens.recordCard('job-a', { cardId: 'p1', kind: 'message' });
    expect(tokens.take('job-a')).toEqual({
      cards: [{ cardId: 'p1', kind: 'message' }],
      toolRefs: [
        { tool: 'parley_overview', ok: true, at: 100 },
        { tool: 'propose_message', ok: false, at: 101 },
      ],
    });
    expect(tokens.take('job-a')).toEqual({ cards: [], toolRefs: [] });
  });

  it('отозванный токен ничего не записывает', () => {
    const tokens = createJobTokens();
    tokens.issue('job-a');
    tokens.revoke('job-a');
    tokens.recordTool('job-a', 'parley_overview', true);
    tokens.recordCard('job-a', { cardId: 'p1', kind: 'message' });
    expect(tokens.take('job-a')).toEqual({ cards: [], toolRefs: [] });
  });

  it('peek читает записи, не забирая их', () => {
    const tokens = createJobTokens(() => 5);
    tokens.issue('job-a');
    tokens.recordCard('job-a', { cardId: 'p1', kind: 'message' });
    expect(tokens.peek('job-a').cards).toHaveLength(1);
    expect(tokens.peek('job-a').cards).toHaveLength(1);
    expect(tokens.take('job-a').cards).toHaveLength(1);
  });
});


it('keeps overview aliases private to the job and removes them with take', () => {
  const tokens = createJobTokens();
  tokens.issue('a');
  tokens.issue('b');
  const overview = { rooms: [], unassignedSessions: [{ ref: 'session:abc:w-1:s-01', displayName: 'Anna' }] } as unknown as HumanOverviewV1;
  tokens.recordOverview('a', overview);
  expect(tokens.peek('a').humanRefs).toMatchObject({ S01: 'Anna', '@s01': 'Anna', 's-01': 'Anna' });
  expect(tokens.peek('b').humanRefs).toBeUndefined();
  const peek = tokens.peek('a');
  peek.humanRefs!.S01 = 'changed';
  expect(tokens.peek('a').humanRefs!.S01).toBe('Anna');
  expect(tokens.take('a').humanRefs!.S01).toBe('Anna');
  expect(tokens.peek('a').humanRefs).toBeUndefined();
  tokens.revoke('a');
  tokens.recordOverview('a', overview);
  expect(tokens.peek('a').humanRefs).toBeUndefined();
});
