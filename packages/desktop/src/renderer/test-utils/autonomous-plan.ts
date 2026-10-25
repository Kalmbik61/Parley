import type { AutonomousPlan, CheckResult, RoomPlan } from '@parley/core';

export function autonomousPlan(): AutonomousPlan {
  const check: CheckResult = { id: 'ck-01', specId: 'verifier:0', attemptId: 'at-02', sha: 'abc', argvHash: '', envHash: '', inputsOk: true, verdict: 'fail', by: 's-02', exitCode: null, summary: 'Restart still fails', outputTail: null, at: '2026-10-25T10:00:00Z', durationMs: 1 };
  return {
    budget: { limits: { attemptsPerItem: 3, repairWaves: 2, minutesPerAttempt: 10, sessions: 10, concurrent: 1 }, spent: { attempts: 2, repairWaves: 0, sessions: 2, verifiers: 1, minutes: 1, launches: 2 }, reservations: [] },
    checks: [], coverage: { 1: { 0: ['verifier'] } }, criteriaVersion: { 1: 1 },
    integration: { branch: 'integration', baseSha: 'abc', verifiedHead: 'abc', candidateHead: null, queue: [], suspended: null },
    attempts: [{ id: 'at-02', item: 1, n: 2, planRev: 2, criteriaVersion: 1, worker: 's-01', verifier: 's-02', branch: 'attempt', baseSha: 'abc', sha: 'abc', tree: 'def', submissionKey: null, status: 'returned', manifest: null, receipt: null, checks: [check.id], failureSignature: null, startedAt: 'x', endedAt: 'x', log: [] }],
    ops: [{ key: 'op-01', kind: 'check', attemptId: 'at-02', payload: {}, state: 'done', at: 'x', settledAt: 'x', result: { checkResult: check } }],
    halted: { reason: 'human', at: '2026-10-25T10:00:00Z', detail: 'capture: unexpected failure' }, seq: { attempt: 2, receipt: 0, check: 1, op: 1 },
  };
}

export function autonomousRoomPlan(): RoomPlan {
  return { id: 'pl-01', roomId: 'r-01', rev: 2, mode: 'autonomous', status: 'active', goal: 'Recover', items: [], backlog: [], acceptedAt: 'x', completedAt: null, cancelledAt: null, completionSummary: null, autonomous: autonomousPlan() };
}
