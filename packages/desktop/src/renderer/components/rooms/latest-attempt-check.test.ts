import { expect, it } from 'vitest';
import type { CheckResult, PlanAttempt, RoomPlan } from '@parley/core';
import { autonomousRoomPlan } from '../../test-utils/autonomous-plan.js';
import { checkLine, lastAttempt, latestAttemptCheck } from './latest-attempt-check.js';

const check = (patch: Partial<CheckResult>): CheckResult => ({
  id: 'ck-01', specId: 'verifier:0', attemptId: 'at-02', sha: 'abc', argvHash: '', envHash: '', inputsOk: true, verdict: 'fail',
  by: 's-02', exitCode: null, summary: 'Restart still fails', outputTail: null, at: '2026-10-25T10:00:00Z', durationMs: 1, ...patch,
});
const attempt = (n: number, patch: Partial<PlanAttempt> = {}): PlanAttempt => ({ ...autonomousRoomPlan().autonomous!.attempts[0]!, id: `at-0${n}`, n, ...patch });

it('последняя попытка — с наибольшим n', () => {
  const plan = autonomousRoomPlan();
  plan.autonomous!.attempts = [attempt(2), attempt(3), attempt(1), { ...attempt(9), item: 2 }];
  expect(lastAttempt(plan, 1)?.n).toBe(3);
});

it('нет попыток — undefined; у неавтономного плана тоже', () => {
  const plan = autonomousRoomPlan();
  expect(lastAttempt(plan, 7)).toBeUndefined();
  const checklist = { ...plan, mode: 'checklist' } as RoomPlan;
  expect(lastAttempt(checklist, 1)).toBeUndefined();
});

it('проверка берётся только своей попытки и только завершённая', () => {
  const plan = autonomousRoomPlan();
  const own = plan.autonomous!.attempts[0]!;
  expect(latestAttemptCheck(plan, own)?.id).toBe('ck-01');
  const auto = plan.autonomous!;
  auto.attempts = [{ ...own, checks: ['ck-01', 'ck-02', 'ck-03', 'ck-04'] }];
  auto.ops = [
    { key: 'a', kind: 'check', attemptId: 'at-02', payload: {}, state: 'done', at: 'x', settledAt: 'x', result: { checkResult: check({ id: 'ck-01', at: '2026-10-25T10:00:00Z' }) } },
    { key: 'b', kind: 'check', attemptId: 'at-02', payload: {}, state: 'done', at: 'x', settledAt: 'x', result: { checkResult: check({ id: 'ck-02', at: '2026-10-25T11:00:00Z', verdict: 'pass' }) } },
    { key: 'c', kind: 'check', attemptId: 'at-02', payload: {}, state: 'pending', at: 'x', settledAt: null, result: { checkResult: check({ id: 'ck-03', at: '2026-10-25T12:00:00Z' }) } },
    { key: 'd', kind: 'check', attemptId: 'at-01', payload: {}, state: 'done', at: 'x', settledAt: 'x', result: { checkResult: check({ id: 'ck-04', attemptId: 'at-01', at: '2026-10-25T13:00:00Z' }) } },
  ] as typeof auto.ops;
  expect(latestAttemptCheck(plan, auto.attempts[0]!)?.id).toBe('ck-02');
});

it('строка проверки обрезает сводку до 160 знаков', () => {
  expect(checkLine(check({}))).toBe('verifier:0 → fail · Restart still fails');
  const long = checkLine(check({ summary: 'x'.repeat(200) }));
  expect(long.endsWith('…')).toBe(true);
  expect(long).toBe(`verifier:0 → fail · ${'x'.repeat(160)}…`);
  expect(checkLine(check({ summary: 'a\n\n  b' }))).toBe('verifier:0 → fail · a b');
});

it('нет проверки — пустая строка', () => {
  expect(checkLine(undefined)).toBe('');
});
