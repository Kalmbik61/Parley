import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  coverageVerdict,
  enqueue,
  failureSignature,
  halt,
  integrate,
  intendOp,
  lateDefect,
  receipt,
  reconcileAfterRestart,
  recordCheck,
  release,
  reserve,
  resume,
  returnAttempt,
  settleOp,
  startAttempt,
  submitAttempt,
  supersedeByAmendment,
  suspend,
} from './autonomous.js';
import { parseMap } from './map.js';
import { ENGINE, HUMAN } from './types.js';
import type {
  AutonomousOp,
  CheckResult,
  HandoffManifest,
  Room,
  RoomPlan,
  WorkMap,
} from './types.js';

const now = '2026-10-24T10:00:00.000Z';
const context = (plan: RoomPlan) => ({
  actor: ENGINE,
  rev: plan.rev,
  now: plan.autonomous?.attempts.at(-1)?.startedAt ?? now,
});
const auto = (plan: RoomPlan) => plan.autonomous!;
const last = (plan: RoomPlan) => auto(plan).attempts.at(-1)!;
const lastOp = (plan: RoomPlan) => auto(plan).ops.at(-1)!;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value)!;
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function fixture(criteria = 1): RoomPlan {
  const plan: RoomPlan = {
    id: 'pl-01',
    roomId: 'r-01',
    mode: 'autonomous',
    status: 'active',
    rev: 1,
    goal: 'Цикл',
    backlog: [],
    acceptedAt: now,
    completedAt: null,
    cancelledAt: null,
    completionSummary: null,
    items: [1, 2, 3].map((id) => ({
      id,
      title: `Пункт ${id}`,
      owner: `s-0${id}`,
      scope: 'core',
      after: id === 1 ? [] : [id - 1],
      criteria: Array.from({ length: criteria }, (_, i) => `Критерий ${i}`),
      verifier: 's-09',
      status: id === 1 ? 'ready' : 'waiting',
      evidence: null,
      note: null,
      log: [],
    })),
    autonomous: {
      criteriaVersion: { 1: 1, 2: 1, 3: 1 },
      budget: {
        limits: {
          attemptsPerItem: 3,
          repairWaves: 10,
          minutesPerAttempt: 30,
          sessions: 100,
          concurrent: 10,
        },
        spent: { attempts: 0, repairWaves: 0, sessions: 0, verifiers: 0, minutes: 0, launches: 0 },
        reservations: [],
      },
      checks: [],
      coverage: {},
      integration: {
        branch: 'autonomous/pl-01',
        baseSha: 'base',
        verifiedHead: 'base',
        candidateHead: null,
        queue: [],
        suspended: null,
      },
      attempts: [],
      ops: [],
      halted: null,
      seq: { attempt: 0, receipt: 0, check: 0, op: 0 },
    },
  };
  for (const item of plan.items) {
    auto(plan).coverage[item.id] = {};
    item.criteria.forEach((_, criterion) => {
      const id = `spec-${item.id}-${criterion}`;
      auto(plan).checks.push({
        id,
        item: item.id,
        argv: ['test', String(criterion)],
        cwd: '.',
        env: {},
        inputs: [{ path: 'test.ts', blob: 'frozen' }],
        timeoutMs: 1000,
        frozenAt: now,
      });
      auto(plan).coverage[item.id]![criterion] = [id];
    });
  }
  return plan;
}
function room(): Room {
  return {
    id: 'r-01',
    mode: 'autonomous',
    title: 'Комната',
    creator: 's-01',
    ownerId: null,
    members: ['s-01'],
    lead: 's-01',
    createdAt: now,
    proposal: { id: 'p-01', kind: 'completion', from: 's-01', text: 'Готово', rev: 0, at: now },
  };
}
function operation(
  plan: RoomPlan,
  kind: AutonomousOp['kind'],
  attemptId: string | null,
  payload: Record<string, unknown>,
  result: Record<string, unknown> = {},
): RoomPlan {
  const intended = intendOp(plan, { ...context(plan), kind, attemptId, payload });
  return settleOp(intended, {
    ...context(intended),
    key: lastOp(intended).key,
    outcome: 'done',
    result,
  });
}
function running(plan = fixture(), item = 1): RoomPlan {
  let next = startAttempt(plan, {
    ...context(plan),
    item,
    branch: `attempt-${auto(plan).seq.attempt + 1}`,
    baseSha: auto(plan).integration.verifiedHead,
  });
  const id = last(next).id;
  next = settleOp(next, {
    ...context(next),
    key: lastOp(next).key,
    outcome: 'done',
    result: { sessionId: `worker-${id}` },
  });
  return operation(next, 'launch', id, { sessionId: last(next).worker, role: 'worker' });
}
function handoff(plan: RoomPlan, patch: Partial<HandoffManifest> = {}) {
  const attempt = last(plan);
  const manifest: HandoffManifest = {
    version: 1,
    sha: null,
    criteriaVersion: attempt.criteriaVersion,
    dependsOn: plan.items
      .find((item) => item.id === attempt.item)!
      .after.map((id) => auto(plan).attempts.findLast((entry) => entry.item === id)!.id),
    coverage: 'covered',
    scope: 'core',
    facts: ['Готово'],
    hypotheses: [],
    notFound: [],
    gaps: [],
    text: 'Передача',
    artifacts: [],
    hash: '',
    submittedAt: now,
    ...patch,
  };
  const { hash: _unused, ...body } = manifest;
  manifest.hash = digest(body);
  const { sha: _sha, ...withoutSha } = manifest;
  const key = digest(withoutSha);
  return { manifest, key };
}
function submitted(
  plan = running(),
  options: {
    sha?: string;
    tree?: string;
    baseTree?: string;
    descendantOfBase?: boolean;
    inputsOk?: boolean;
    artifactsCopied?: boolean;
    artifactHashesOk?: boolean;
    manifest?: Partial<HandoffManifest>;
  } = {},
) {
  const { manifest, key } = handoff(plan, options.manifest);
  let next = submitAttempt(plan, {
    ...context(plan),
    attemptId: last(plan).id,
    submissionKey: key,
    manifest,
  });
  const id = last(next).id;
  const stop = auto(next).ops.findLast((op) => op.kind === 'stop-session' && op.attemptId === id)!;
  next = settleOp(next, { ...context(next), key: stop.key, outcome: 'done', result: {} });
  const sha = options.sha ?? `sha-${id}`,
    tree = options.tree ?? `tree-${id}`;
  next = operation(next, 'capture', id, {}, { sha, tree });
  const captureOp = lastOp(next).key;
  next = operation(next, 'copy-artifacts', id, { captureOp }, { copied: true });
  const copyOp = lastOp(next).key;
  const input = {
    ...context(next),
    attemptId: id,
    submissionKey: key,
    sha,
    tree,
    baseTree: options.baseTree ?? 'base-tree',
    descendantOfBase: options.descendantOfBase ?? true,
    inputsOk: options.inputsOk ?? true,
    artifactsCopied: options.artifactsCopied ?? true,
    artifactHashesOk: options.artifactHashesOk ?? true,
    artifacts: manifest.artifacts.map((artifact, index) => ({ ...artifact, storedAs: `artifacts/${index}-${artifact.sha256}` })),
    captureOp,
    copyOp,
  };
  const captured = receipt(next, input);
  return { ...captured, manifest, key, input };
}
function checks(
  plan: RoomPlan,
  options: {
    count?: number;
    verdict?: CheckResult['verdict'];
    integration?: boolean;
    attemptIds?: string[];
  } = {},
) {
  let next = plan;
  const results: CheckResult[] = [];
  const ids = options.attemptIds ?? [last(plan).id];
  for (const attemptId of ids) {
    const attempt = auto(next).attempts.find((entry) => entry.id === attemptId)!;
    const specs = auto(next)
      .checks.filter((spec) => spec.item === attempt.item)
      .slice(0, options.count);
    for (const spec of specs) {
      const result: CheckResult = {
        id: `check-${auto(next).ops.length}`,
        specId: spec.id,
        attemptId,
        sha: options.integration ? auto(next).integration.candidateHead! : attempt.sha!,
        argvHash: digest(spec.argv),
        envHash: digest(spec.env),
        inputsOk: true,
        verdict: options.verdict ?? 'pass',
        by: ENGINE,
        exitCode: 0,
        summary: 'Результат',
        outputTail: null,
        at: now,
        durationMs: 0,
      };
      next = operation(
        next,
        'check',
        attemptId,
        {
          phase: options.integration ? 'integration' : 'attempt',
          sha: result.sha,
          specId: spec.id,
          ...(options.integration
            ? {
                integrationOp: auto(next).ops.findLast(
                  (op) =>
                    ['merge', 'noop-integration'].includes(op.kind) &&
                    op.state === 'done' &&
                    op.result?.sha === auto(next).integration.candidateHead,
                )!.key,
              }
            : {}),
        },
        { checkResult: result },
      );
      const opKey = lastOp(next).key;
      if (!options.integration)
        next = recordCheck(next, { ...context(next), attemptId, result, opKey });
      results.push(result);
    }
  }
  return { plan: next, results };
}
function accepted(plan = submitted().plan) {
  const checked = checks(plan);
  const verdict = coverageVerdict(checked.plan, {
    ...context(checked.plan),
    attemptId: last(plan).id,
    results: checked.results,
    verifiers: [],
  });
  expect(verdict.accepted).toBe(true);
  return { plan: verdict.plan, results: checked.results };
}
function qualitativeChecks(
  plan: RoomPlan,
  attemptId: string,
  integrationOp?: string,
  close = true,
) {
  const attempt = auto(plan).attempts.find((entry) => entry.id === attemptId)!;
  const phase = integrationOp ? 'integration' : 'attempt';
  const sha = integrationOp ? auto(plan).integration.candidateHead! : attempt.sha!;
  const owner = integrationOp
    ? auto(plan).ops.find((op) => op.key === integrationOp)!.attemptId!
    : attemptId;
  const payload = integrationOp
    ? { purpose: 'integration-verifier', sha }
    : { role: 'verifier', phase, sha };
  const existing = integrationOp
    ? auto(plan).ops.findLast(
        (op, index) =>
          op.kind === 'create-session' &&
          op.state === 'done' &&
          op.payload.integrationOp === integrationOp &&
          index > auto(plan).ops.findLastIndex((entry) => entry.kind === 'resume') &&
          !auto(plan).ops.some(
            (closed) =>
              closed.kind === 'close-session' &&
              closed.state === 'done' &&
              closed.payload.sessionId === op.result?.sessionId,
          ),
      )
    : undefined;
  const sessionId =
    (existing?.result?.sessionId as string | undefined) ?? `verifier-${auto(plan).ops.length}`;
  let next = plan;
  if (!existing) {
    next = operation(next, 'create-session', owner, payload, { sessionId });
    next = operation(next, 'launch', owner, { ...payload, sessionId });
  }
  const result: CheckResult = {
    id: `quality-${auto(next).ops.length}`,
    attemptId,
    specId: 'verifier:0',
    sha,
    argvHash: '',
    envHash: '',
    by: sessionId,
    verdict: 'pass',
    inputsOk: true,
    exitCode: null,
    summary: 'Критерий пройден',
    outputTail: null,
    at: context(next).now,
    durationMs: 0,
  };
  next = operation(
    next,
    'check',
    attemptId,
    { phase, sha, ...(integrationOp ? { integrationOp } : {}) },
    { checkResult: result },
  );
  next = recordCheck(next, { ...context(next), attemptId, result, opKey: lastOp(next).key });
  if (close) next = operation(next, 'close-session', owner, { sessionId });
  return { plan: next, result, sessionId };
}
function queued(plan = accepted().plan): RoomPlan {
  return enqueue(plan, { ...context(plan), attemptId: last(plan).id });
}
function candidate(plan = queued(), options: { contained?: boolean; head?: string } = {}) {
  const a = auto(plan),
    attempt = last(plan);
  const noop = options.contained || attempt.sha === a.integration.verifiedHead;
  const next = operation(
    plan,
    noop ? 'noop-integration' : 'merge',
    attempt.id,
    {
      sha: attempt.sha,
      verifiedHead: a.integration.verifiedHead,
      containedInVerifiedHead: !!options.contained,
    },
    { sha: noop ? a.integration.verifiedHead : (options.head ?? `head-${attempt.id}`) },
  );
  return { plan: next, opKey: lastOp(next).key };
}
function integrated(plan = queued()): RoomPlan {
  const merged = candidate(plan);
  const checked = checks(merged.plan, {
    integration: true,
    attemptIds: auto(merged.plan)
      .attempts.filter((attempt) => ['queued', 'integrated'].includes(attempt.status))
      .map((attempt) => attempt.id),
  });
  return integrate(checked.plan, {
    ...context(checked.plan),
    attemptId: last(plan).id,
    opKey: merged.opKey,
    results: checked.results,
    verifiers: [],
  });
}
const returned = (plan: RoomPlan, signature = 'failure-a') =>
  returnAttempt(plan, {
    ...context(plan),
    attemptId: last(plan).id,
    signature,
    reason: 'Проверка провалена',
  });

describe('автономные правила', () => {
  it('повторный рестарт после успешной починки сохраняет verified и доказательства зависимого', () => {
    const first = running();
    const restarted = reconcileAfterRestart(first, {
      ...context(first),
      observations: [],
      integrationHead: { sha: 'base', parents: [], opKey: null },
    });
    const resumed = resume(restarted, { ...context(restarted), requestedBy: HUMAN });
    const repaired = integrated(queued(accepted(submitted(running(resumed)).plan).plan));
    const dependent = integrated(queued(accepted(submitted(running(repaired, 2)).plan).plan));
    const saved = structuredClone(dependent.items.slice(0, 2));
    const next = reconcileAfterRestart(dependent, {
      ...context(dependent),
      observations: [],
      integrationHead: { sha: auto(dependent).integration.verifiedHead, parents: [], opKey: null },
    });
    expect(next.items.slice(0, 2)).toEqual(saved);
    expect(auto(next).attempts.map((attempt) => attempt.status)).toEqual([
      'aborted',
      'integrated',
      'integrated',
    ]);
    expect(auto(next).halted?.reason).toBe('restart');
  });

  it('после позднего дефекта интеграция зависимого проверяет актуальную починку без старой попытки', () => {
    const original = integrated();
    const returned = lateDefect(original, room(), {
      ...context(original),
      attemptId: last(original).id,
      reason: 'Дефект',
    }).plan;
    const repaired = integrated(queued(accepted(submitted(running(returned)).plan).plan));
    const current = last(repaired).id;
    const merged = candidate(queued(accepted(submitted(running(repaired, 2)).plan).plan));
    const checked = checks(merged.plan, {
      integration: true,
      attemptIds: [current, last(merged.plan).id],
    });
    const next = integrate(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      opKey: merged.opKey,
      results: checked.results,
      verifiers: [],
    });
    expect(next.items.slice(0, 2).map((item) => item.status)).toEqual(['verified', 'verified']);
    expect(auto(next).attempts[0]!.status).toBe('integrated');
    expect(auto(next).attempts[0]!.checks).toEqual(auto(repaired).attempts[0]!.checks);
  });

  it('новые интеграционные проверяющие перепроверяют критерий на двух головах и сохраняют происхождение', () => {
    const initial = fixture();
    auto(initial).coverage[1]![0] = ['verifier'];
    const submittedPlan = submitted(running(initial)).plan;
    const attemptId = last(submittedPlan).id;
    const acceptance = qualitativeChecks(submittedPlan, attemptId);
    const verdict = coverageVerdict(acceptance.plan, {
      ...context(acceptance.plan),
      attemptId,
      results: [],
      verifiers: [acceptance.result],
    });
    expect(verdict.accepted).toBe(true);
    const firstMerge = candidate(queued(verdict.plan));
    const firstQuality = qualitativeChecks(firstMerge.plan, attemptId, firstMerge.opKey);
    const first = integrate(firstQuality.plan, {
      ...context(firstQuality.plan),
      attemptId,
      opKey: firstMerge.opKey,
      results: [],
      verifiers: [firstQuality.result],
    });
    const secondMerge = candidate(queued(accepted(submitted(running(first, 2)).plan).plan));
    const secondQuality = qualitativeChecks(secondMerge.plan, attemptId, secondMerge.opKey);
    const checked = checks(secondQuality.plan, { integration: true });
    const next = integrate(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      opKey: secondMerge.opKey,
      results: checked.results,
      verifiers: [secondQuality.result],
    });
    expect(next.items.slice(0, 2).map((item) => item.status)).toEqual(['verified', 'verified']);
    expect(auto(next).attempts[0]!.verifier).toBe(acceptance.sessionId);
    expect(
      new Set([acceptance.sessionId, firstQuality.sessionId, secondQuality.sessionId]).size,
    ).toBe(3);
    expect(auto(next).budget.spent).toMatchObject({ sessions: 5, verifiers: 3, launches: 5 });
    expect(auto(next).budget.reservations).toEqual([]);
    for (const quality of [acceptance, firstQuality, secondQuality])
      expect(
        auto(next).ops.some(
          (op) =>
            op.kind === 'close-session' &&
            op.payload.sessionId === quality.sessionId &&
            op.state === 'done',
        ),
      ).toBe(true);
  });

  it('рестарт останавливает интеграционного проверяющего verified-пункта и требует нового после resume', () => {
    const initial = fixture();
    auto(initial).coverage[1]![0] = ['verifier'];
    const captured = submitted(running(initial)).plan,
      id = last(captured).id;
    const acceptance = qualitativeChecks(captured, id);
    const accepted = coverageVerdict(acceptance.plan, {
      ...context(acceptance.plan),
      attemptId: id,
      results: [],
      verifiers: [acceptance.result],
    }).plan;
    const firstMerge = candidate(queued(accepted));
    const firstCheck = qualitativeChecks(firstMerge.plan, id, firstMerge.opKey);
    const first = integrate(firstCheck.plan, {
      ...context(firstCheck.plan),
      attemptId: id,
      opKey: firstMerge.opKey,
      results: [],
      verifiers: [firstCheck.result],
    });
    const dependent = checks(submitted(running(first, 2)).plan);
    const secondAccepted = coverageVerdict(dependent.plan, {
      ...context(dependent.plan),
      attemptId: last(dependent.plan).id,
      results: dependent.results,
      verifiers: [],
    }).plan;
    const secondMerge = candidate(queued(secondAccepted));
    const interrupted = qualitativeChecks(secondMerge.plan, id, secondMerge.opKey, false);
    const restarted = reconcileAfterRestart(interrupted.plan, {
      ...context(interrupted.plan),
      observations: [],
      integrationHead: {
        sha: auto(interrupted.plan).integration.candidateHead!,
        parents: [auto(interrupted.plan).integration.verifiedHead, last(interrupted.plan).sha!],
        opKey: secondMerge.opKey,
      },
    });
    expect(auto(restarted).attempts[0]!.status).toBe('integrated');
    expect(restarted.items[0]!.status).toBe('verified');
    const stops = auto(restarted).ops.filter(
      (op) =>
        op.payload.sessionId === interrupted.sessionId &&
        ['stop-session', 'close-session'].includes(op.kind) &&
        op.state === 'intended',
    );
    expect(stops.map((op) => op.kind)).toEqual(['stop-session', 'close-session']);
    let resumed = resume(restarted, { ...context(restarted), requestedBy: HUMAN });
    for (const op of stops)
      resumed = settleOp(resumed, {
        ...context(resumed),
        key: op.key,
        outcome: 'done',
        result: {},
      });
    const engine = checks(resumed, { integration: true });
    expect(() =>
      integrate(engine.plan, {
        ...context(engine.plan),
        attemptId: last(engine.plan).id,
        opKey: secondMerge.opKey,
        results: engine.results,
        verifiers: [interrupted.result],
      }),
    ).toThrow('integration-coverage-incomplete');
    const fresh = qualitativeChecks(engine.plan, id, secondMerge.opKey);
    const next = integrate(fresh.plan, {
      ...context(fresh.plan),
      attemptId: last(fresh.plan).id,
      opKey: secondMerge.opKey,
      results: engine.results,
      verifiers: [fresh.result],
    });
    expect(last(next).status).toBe('integrated');
    expect(auto(next).attempts[0]!.verifier).toBe(acceptance.sessionId);
    expect(fresh.sessionId).not.toBe(interrupted.sessionId);
  });

  it('интеграционный проверяющий старого verified-пункта расходует бюджет текущего кандидата', () => {
    const initial = fixture();
    auto(initial).coverage[1]![0] = ['verifier'];
    const captured = submitted(running(initial)).plan,
      id = last(captured).id;
    const acceptance = qualitativeChecks(captured, id);
    const acceptedFirst = coverageVerdict(acceptance.plan, {
      ...context(acceptance.plan),
      attemptId: id,
      results: [],
      verifiers: [acceptance.result],
    }).plan;
    const firstMerge = candidate(queued(acceptedFirst));
    const firstQuality = qualitativeChecks(firstMerge.plan, id, firstMerge.opKey);
    const first = integrate(firstQuality.plan, {
      ...context(firstQuality.plan),
      attemptId: id,
      opKey: firstMerge.opKey,
      results: [],
      verifiers: [firstQuality.result],
    });
    let later = startAttempt(first, {
      ...context(first),
      now: '2026-10-24T11:00:00.000Z',
      item: 2,
      branch: 'later-attempt',
      baseSha: auto(first).integration.verifiedHead,
    });
    later = settleOp(later, {
      ...context(later),
      key: lastOp(later).key,
      outcome: 'done',
      result: { sessionId: 'later-worker' },
    });
    later = operation(later, 'launch', last(later).id, {
      role: 'worker',
      sessionId: 'later-worker',
    });
    const merged = candidate(queued(accepted(submitted(later).plan).plan));
    const quality = qualitativeChecks(merged.plan, auto(first).attempts[0]!.id, merged.opKey);
    expect(auto(quality.plan).halted).toBeNull();
    expect(auto(quality.plan).budget.spent.verifiers).toBe(3);
    expect(auto(quality.plan).attempts[0]!.status).toBe('integrated');
  });

  it('один проверяющий кандидата даёт качественные вердикты для текущего и ранее verified-пункта', () => {
    const initial = fixture();
    auto(initial).coverage[1]![0] = ['verifier'];
    auto(initial).coverage[2]![0] = ['verifier'];
    const captured = submitted(running(initial)).plan,
      firstId = last(captured).id;
    const acceptedFirst = qualitativeChecks(captured, firstId);
    const firstPlan = coverageVerdict(acceptedFirst.plan, {
      ...context(acceptedFirst.plan),
      attemptId: firstId,
      results: [],
      verifiers: [acceptedFirst.result],
    }).plan;
    const firstMerge = candidate(queued(firstPlan));
    const firstQuality = qualitativeChecks(firstMerge.plan, firstId, firstMerge.opKey);
    const first = integrate(firstQuality.plan, {
      ...context(firstQuality.plan),
      attemptId: firstId,
      opKey: firstMerge.opKey,
      results: [],
      verifiers: [firstQuality.result],
    });
    const secondCapture = submitted(running(first, 2)).plan,
      secondId = last(secondCapture).id;
    const secondAcceptance = qualitativeChecks(secondCapture, secondId);
    const secondPlan = coverageVerdict(secondAcceptance.plan, {
      ...context(secondAcceptance.plan),
      attemptId: secondId,
      results: [],
      verifiers: [secondAcceptance.result],
    }).plan;
    const secondMerge = candidate(queued(secondPlan));
    const oldItem = qualitativeChecks(secondMerge.plan, firstId, secondMerge.opKey, false);
    const newItem = qualitativeChecks(oldItem.plan, secondId, secondMerge.opKey);
    expect(newItem.sessionId).toBe(oldItem.sessionId);
    const next = integrate(newItem.plan, {
      ...context(newItem.plan),
      attemptId: secondId,
      opKey: secondMerge.opKey,
      results: [],
      verifiers: [oldItem.result, newItem.result],
    });
    expect(next.items.slice(0, 2).map((item) => item.status)).toEqual(['verified', 'verified']);
    expect(
      auto(next).ops.filter(
        (op) =>
          op.kind === 'create-session' &&
          op.payload.purpose === 'integration-verifier' &&
          op.payload.sha === auto(next).integration.verifiedHead,
      ),
    ).toHaveLength(1);
    expect(auto(next).attempts.map((attempt) => attempt.verifier)).toEqual([
      acceptedFirst.sessionId,
      secondAcceptance.sessionId,
    ]);
  });
  it('новая попытка дописывается и не перезаписывает прежнюю попытку и её журнал', () => {
    const first = returned(submitted().plan);
    const saved = structuredClone(last(first));
    const next = running(first);
    expect(auto(next).attempts).toHaveLength(2);
    expect(auto(next).attempts[0]).toEqual(saved);
    expect(last(next)).toMatchObject({ id: 'at-0002', n: 2 });
    expect(auto(first).attempts).toEqual([saved]);
    expect(last(next).log.every((entry) => entry.by === ENGINE)).toBe(true);
  });

  it('сдача без хэшей заполняет прежние формулы и повторяется до квитанции без эффектов', () => {
    const plan = running(), explicit = handoff(plan);
    const { hash: _hash, ...manifest } = explicit.manifest;
    const input = { ...context(plan), attemptId: last(plan).id, manifest };
    const first = submitAttempt(plan, input);
    expect(last(first).manifest).toEqual(explicit.manifest);
    expect(last(first).submissionKey).toBe(explicit.key);
    expect(input.manifest).not.toHaveProperty('hash');
    expect(last(plan).manifest).toBeNull();
    expect(submitAttempt(first, input)).toEqual(first);
    expect(submitAttempt(first, { ...input, submissionKey: last(first).submissionKey! })).toEqual(first);
    expect(submitAttempt(first, { ...input, submissionKey: explicit.key, manifest: explicit.manifest })).toEqual(first);
    expect(auto(first).ops.filter(op => op.kind === 'stop-session')).toHaveLength(1);
    expect(auto(first).seq.receipt).toBe(0);
    expect(auto(first).budget).toEqual(auto(plan).budget);
  });

  it('повтор без хэшей после захвата сохраняет квитанцию, операции и бюджет', () => {
    const first = submitted(running(), { manifest: { artifacts: [{ path: 'result.txt', sha256: 'a'.repeat(64), storedAs: '' }] } });
    const { hash: _hash, ...manifest } = first.manifest;
    for (const submissionKey of [undefined, first.key]) {
      const repeated = submitAttempt(first.plan, { ...context(first.plan), attemptId: last(first.plan).id, manifest, submissionKey });
      expect(repeated).toEqual(first.plan);
      expect(receipt(repeated, first.input).plan).toEqual(first.plan);
    }
  });

  it('проверяет каждый явный хэш даже при отсутствии другого', () => {
    const plan = running(), explicit = handoff(plan);
    const { hash: _hash, ...manifest } = explicit.manifest;
    const input = { ...context(plan), attemptId: last(plan).id, manifest };
    expect(submitAttempt(plan, { ...input, submissionKey: explicit.key })).toEqual(submitAttempt(plan, input));
    expect(submitAttempt(plan, { ...input, manifest: explicit.manifest })).toEqual(submitAttempt(plan, input));
    for (const invalid of [
      { ...input, manifest: { ...manifest, hash: 'f'.repeat(64) } },
      { ...input, manifest: { ...manifest, sha: 'agent-sha' } },
    ]) expect(() => submitAttempt(plan, invalid)).toThrow('invalid manifest');
    expect(() => submitAttempt(plan, { ...input, submissionKey: 'f'.repeat(64) })).toThrow('handoff-conflict');
    const first = submitAttempt(plan, input);
    expect(() => submitAttempt(first, { ...input, submissionKey: explicit.key, manifest: { ...manifest, text: 'Изменено' } })).toThrow();
    expect(last(first).manifest).toEqual(explicit.manifest);
  });

  it('повтор с тем же submissionKey возвращает ту же квитанцию без новых операций', () => {
    const first = submitted();
    const repeated = submitAttempt(first.plan, {
      ...context(first.plan),
      attemptId: last(first.plan).id,
      submissionKey: first.key,
      manifest: first.manifest,
    });
    const again = receipt(repeated, { ...first.input, sha: 'ignored-retry-sha' });
    expect(again.plan).toEqual(first.plan);
    expect(last(again.plan).receipt).toEqual(last(first.plan).receipt);
  });

  it('пути копий задаёт движок при записи квитанции', () => {
    const artifact = { path: 'result.txt', sha256: 'a'.repeat(64), storedAs: '' };
    const first = submitted(running(), { manifest: { artifacts: [artifact] } });
    expect(last(first.plan).manifest!.artifacts).toEqual([{ ...artifact, storedAs: `artifacts/0-${artifact.sha256}` }]);
    const { hash: _hash, ...body } = last(first.plan).manifest!;
    expect(last(first.plan).manifest!.hash).toBe(digest(body));
    const finished = integrated(queued(accepted(first.plan).plan));
    expect(finished.items[0]!.evidence!.artifacts).toEqual([`artifacts/0-${artifact.sha256}`]);
    for (const artifacts of [[], [{ ...artifact, path: 'other.txt', storedAs: 'artifacts/result' }], [{ ...artifact, sha256: 'b'.repeat(64), storedAs: 'artifacts/result' }], [{ ...artifact, storedAs: '../escape' }]]) {
      const plan = structuredClone(first.plan);
      last(plan).receipt = null;
      last(plan).status = 'running';
      last(plan).manifest = structuredClone(first.manifest);
      expect(() => receipt(plan, { ...first.input, artifacts })).toThrow('artifacts-mismatch');
    }
  });

  it.each(['artifacts/chosen-by-agent', '/absolute', '../escape'])('не принимает путь копии от агента: %s', storedAs => {
    const plan = running();
    const hand = handoff(plan, { artifacts: [{ path: 'result.txt', sha256: 'a'.repeat(64), storedAs }] });
    expect(() => submitAttempt(plan, { ...context(plan), attemptId: last(plan).id, submissionKey: hand.key, manifest: hand.manifest })).toThrow('invalid manifest');
  });

  it('повтор отказа с тем же submissionKey сохраняет отрицательную квитанцию', () => {
    const first = submitted(running(), { inputsOk: false });
    const repeated = receipt(first.plan, first.input);
    expect(last(repeated.plan).receipt).toEqual(last(first.plan).receipt);
    expect(auto(repeated.plan).seq.receipt).toBe(1);
  });

  it('другой манифест той же попытки отклоняется как handoff-conflict', () => {
    const first = submitted();
    const changed = handoff(first.plan, { text: 'Другая передача' });
    expect(() =>
      submitAttempt(first.plan, {
        ...context(first.plan),
        attemptId: last(first.plan).id,
        submissionKey: changed.key,
        manifest: changed.manifest,
      }),
    ).toThrow('handoff-conflict');
    expect(() =>
      submitAttempt(first.plan, {
        ...context(first.plan),
        attemptId: last(first.plan).id,
        submissionKey: first.key,
        manifest: changed.manifest,
      }),
    ).toThrow('handoff-conflict');
  });

  it('отсутствие изменений определяется деревом захвата против дерева baseSha', () => {
    const sameTree = submitted(running(), { tree: 'same-tree', baseTree: 'same-tree' });
    expect(sameTree.unchanged).toBe(true);
    expect(last(sameTree.plan).sha).not.toBe(last(sameTree.plan).baseSha);
    expect(submitted(running(), { tree: 'changed', baseTree: 'base-tree' }).unchanged).toBe(false);
  });

  it('sha старше baseSha отклоняется с отрицательной квитанцией', () => {
    const result = submitted(running(), { sha: 'older', descendantOfBase: false });
    expect(last(result.plan).receipt).toMatchObject({ valid: false, reason: 'sha-before-base' });
    expect(last(result.plan).status).toBe('returned');
  });

  it('устаревшая criteriaVersion на сдаче отгораживает попытку', () => {
    const plan = running(),
      input = handoff(plan);
    auto(plan).criteriaVersion[1] = 2;
    const next = submitAttempt(plan, {
      ...context(plan),
      attemptId: last(plan).id,
      submissionKey: input.key,
      manifest: input.manifest,
    });
    expect(last(next).status).toBe('superseded');
    expect(last(next).receipt).toBeNull();
    expect(last(next).log.some((entry) => entry.note === 'criteria-stale')).toBe(true);
  });

  it('sha равный baseSha принимается и интегрируется noop без сдвига головы', () => {
    const captured = submitted(running(), {
      sha: 'base',
      tree: 'base-tree',
      descendantOfBase: false,
    });
    const merged = candidate(queued(accepted(captured.plan).plan));
    const checked = checks(merged.plan, { integration: true });
    const next = integrate(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      opKey: merged.opKey,
      results: checked.results,
      verifiers: [],
    });
    expect(auto(next).integration.verifiedHead).toBe('base');
    expect(auto(next).ops.find((op) => op.key === merged.opKey)?.kind).toBe('noop-integration');
    expect(last(next).status).toBe('integrated');
  });

  it('sha уже содержащийся в verifiedHead принимается через noop без сдвига головы', () => {
    const captured = submitted(running(), { sha: 'contained' });
    const merged = candidate(queued(accepted(captured.plan).plan), { contained: true });
    const checked = checks(merged.plan, { integration: true });
    const next = integrate(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      opKey: merged.opKey,
      results: checked.results,
      verifiers: [],
    });
    expect(auto(next).integration.verifiedHead).toBe('base');
    expect(last(next).status).toBe('integrated');
  });

  it('dependsOn на superseded отклоняется при сдаче', () => {
    const plan = running(integrated(), 2),
      input = handoff(plan);
    auto(plan).attempts[0]!.status = 'superseded';
    const next = submitAttempt(plan, {
      ...context(plan),
      attemptId: last(plan).id,
      submissionKey: input.key,
      manifest: input.manifest,
    });
    expect(last(next).status).toBe('superseded');
    expect(last(next).log.some((entry) => entry.note === 'dependency-stale')).toBe(true);
  });

  it('dependsOn на superseded отклоняется при приёме проверок', () => {
    const checked = checks(submitted(running(integrated(), 2)).plan);
    auto(checked.plan).attempts[0]!.status = 'superseded';
    const verdict = coverageVerdict(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      results: checked.results,
      verifiers: [],
    });
    expect(verdict).toMatchObject({ accepted: false, reason: 'dependency-stale' });
    expect(last(verdict.plan).status).toBe('superseded');
  });

  it('dependsOn на superseded отклоняется перед слиянием и запись очереди снимается', () => {
    const plan = queued(accepted(submitted(running(integrated(), 2)).plan).plan);
    auto(plan).attempts[0]!.status = 'superseded';
    const next = intendOp(plan, {
      ...context(plan),
      kind: 'merge',
      attemptId: last(plan).id,
      payload: { sha: last(plan).sha, verifiedHead: auto(plan).integration.verifiedHead },
    });
    expect(last(next).status).toBe('superseded');
    expect(auto(next).integration.queue).toEqual([]);
    expect(auto(next).ops.some((op) => op.kind === 'merge' && op.attemptId === last(plan).id)).toBe(
      false,
    );
  });

  it('смена зависимости между слиянием и integrate сбрасывает кандидата', () => {
    const merged = candidate(queued(accepted(submitted(running(integrated(), 2)).plan).plan));
    auto(merged.plan).attempts[0]!.status = 'superseded';
    const next = integrate(merged.plan, {
      ...context(merged.plan),
      attemptId: last(merged.plan).id,
      opKey: merged.opKey,
      results: [],
      verifiers: [],
    });
    expect(last(next).status).toBe('superseded');
    expect(auto(next).integration.candidateHead).toBeNull();
  });

  it('десять критериев с восемью pass и двумя пробелами не принимаются', () => {
    const checked = checks(submitted(running(fixture(10))).plan, { count: 8 });
    const result = coverageVerdict(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      results: checked.results,
      verifiers: [],
    });
    expect(result).toMatchObject({
      accepted: false,
      reason: 'coverage-incomplete',
      gaps: ['criterion:8', 'criterion:9'],
    });
    expect(last(result.plan).status).toBe('checking');
  });

  it('not_verified не даёт accepted', () => {
    const checked = checks(submitted().plan, { verdict: 'not_verified' });
    const result = coverageVerdict(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      results: checked.results,
      verifiers: [],
    });
    expect(result).toMatchObject({ accepted: false, gaps: ['criterion:0'] });
  });

  it('качественный критерий требует независимого pass на точном sha', () => {
    const initial = submitted().plan;
    auto(initial).coverage[1]![0] = ['verifier'];
    const quality = qualitativeChecks(initial, last(initial).id);
    const plan = quality.plan,
      result = quality.result;
    const input = { ...context(plan), attemptId: last(plan).id, results: [], verifiers: [result] };
    expect(coverageVerdict(plan, input).accepted).toBe(true);
    expect(
      coverageVerdict(plan, { ...input, verifiers: [{ ...input.verifiers[0]!, sha: 'other' }] })
        .accepted,
    ).toBe(false);
    expect(
      coverageVerdict(plan, {
        ...input,
        verifiers: [{ ...input.verifiers[0]!, by: last(plan).worker! }],
      }).accepted,
    ).toBe(false);
  });

  it.each(['checking', 'queued'] as const)(
    'amendment отгораживает зависимых в %s, очищает очередь, кандидата и завершение',
    (status) => {
      let plan = submitted(running(integrated(), 2)).plan;
      if (status === 'checking') plan = checks(plan).plan;
      else plan = candidate(queued(accepted(plan).plan)).plan;
      last(plan).verifier = 'active-verifier';
      const dependent = last(plan).id;
      const next = supersedeByAmendment(plan, room(), { ...context(plan), changedItems: [1] });
      expect(auto(next.plan).criteriaVersion).toEqual({ 1: 2, 2: 1, 3: 1 });
      expect(auto(next.plan).attempts.map((attempt) => attempt.status)).toEqual([
        'superseded',
        'superseded',
      ]);
      expect(auto(next.plan).integration).toMatchObject({ queue: [], candidateHead: null });
      expect(next.room.proposal).toBeNull();
      expect(
        auto(next.plan).ops.some(
          (op) =>
            op.kind === 'stop-session' && op.attemptId === dependent && op.state === 'intended',
        ),
      ).toBe(true);
      expect(next.plan.items.map((item) => item.status)).toEqual(['ready', 'waiting', 'waiting']);
      expect(next.plan.rev).toBe(plan.rev + 1);
    },
  );

  it.each(['checking', 'queued'] as const)(
    'поздний дефект отгораживает зависимых в %s и сохраняет исходную попытку',
    (status) => {
      let plan = submitted(running(integrated(), 2)).plan;
      if (status === 'checking') plan = checks(plan).plan;
      else plan = candidate(queued(accepted(plan).plan)).plan;
      last(plan).verifier = 'active-verifier';
      const source = structuredClone(auto(plan).attempts[0]!);
      const next = lateDefect(plan, room(), {
        ...context(plan),
        attemptId: source.id,
        reason: 'Регрессия',
      });
      expect(auto(next.plan).attempts[0]).toEqual(source);
      expect(last(next.plan).status).toBe('superseded');
      expect(auto(next.plan).integration).toMatchObject({ queue: [], candidateHead: null });
      expect(next.room.proposal).toBeNull();
      expect(next.plan.items[0]).toMatchObject({ status: 'returned', evidence: null });
      expect(next.plan.items[0]!.log.at(-1)!.note).toContain(source.id);
      expect(auto(next.plan).criteriaVersion).toEqual(auto(plan).criteriaVersion);
      expect(
        auto(next.plan).ops.some(
          (op) =>
            op.kind === 'stop-session' && op.attemptId === last(plan).id && op.state === 'intended',
        ),
      ).toBe(true);
    },
  );

  it('accepted не освобождает зависимых', () => {
    const plan = accepted().plan;
    expect(plan.items[0]!.status).toBe('in_progress');
    expect(plan.items[1]!.status).toBe('waiting');
    expect(() => running(plan, 2)).toThrow('item-not-ready');
  });

  it('integrated освобождает зависимых и пишет evidence с закреплёнными идентификаторами', () => {
    const plan = integrated();
    expect(plan.items[0]!.status).toBe('verified');
    expect(plan.items[1]!.status).toBe('ready');
    expect(plan.items[0]!.evidence!.text).toContain('receipt=rc-0001');
    expect(plan.items[0]!.evidence!.text).toContain('verifiedHead=head-at-0001');
  });

  it('completing недостижимо при halted', () => {
    const plan = integrated();
    for (const item of plan.items) item.status = 'verified';
    plan.status = 'completing';
    expect(halt(plan, { ...context(plan), reason: 'human', detail: 'Стоп' }).status).toBe('active');
  });

  it('completing недостижимо при непустой очереди', () => {
    const merged = candidate();
    auto(merged.plan).integration.queue.push('another-queued');
    for (const item of merged.plan.items.slice(1)) item.status = 'verified';
    const checked = checks(merged.plan, { integration: true });
    const next = integrate(checked.plan, {
      ...context(checked.plan),
      attemptId: last(checked.plan).id,
      opKey: merged.opKey,
      results: checked.results,
      verifiers: [],
    });
    expect(next.status).toBe('active');
  });

  it('completing недостижимо пока пункт не verified', () => {
    expect(integrated().status).toBe('active');
  });

  it('все verified с пустой очередью без halted достигают completing', () => {
    const plan = fixture();
    plan.items = plan.items.slice(0, 1);
    expect(integrated(queued(accepted(submitted(running(plan)).plan).plan)).status).toBe(
      'completing',
    );
  });

  it('n равный limit блокирует после returned', () => {
    const plan = fixture();
    auto(plan).budget.limits.attemptsPerItem = 1;
    const next = returned(submitted(running(plan)).plan);
    expect(last(next).status).toBe('blocked');
    expect(next.items[0]!.status).toBe('blocked');
    expect(auto(next).halted?.reason).toBe('budget');
  });

  it('accepted на последней разрешённой попытке принимается', () => {
    const plan = fixture();
    auto(plan).budget.limits.attemptsPerItem = 1;
    const next = accepted(submitted(running(plan)).plan).plan;
    expect(last(next).status).toBe('accepted');
    expect(auto(next).halted).toBeNull();
  });

  it('равные сигнатуры подряд дают blocked без третьей попытки', () => {
    const first = returned(submitted().plan);
    const second = returned(submitted(running(first)).plan);
    expect(last(second).status).toBe('blocked');
    expect(auto(second).halted?.reason).toBe('no_progress');
    expect(() => running(second)).toThrow('plan-halted');
    expect(auto(second).attempts).toHaveLength(2);
  });

  it('разные сигнатуры считаются прогрессом и позволяют продолжение', () => {
    const first = returned(submitted().plan);
    const second = returned(submitted(running(first)).plan, 'failure-b');
    expect(auto(second).halted).toBeNull();
    expect(last(running(second)).n).toBe(3);
  });

  it('сигнатура нормализует причины и порядок проверок и критериев', () => {
    const a = failureSignature({
      checks: [
        { specId: 'b', verdict: 'fail' },
        { specId: 'a', verdict: 'pass' },
      ],
      criteria: [
        { criterion: 2, verdict: 'fail' },
        { criterion: 1, verdict: 'pass' },
      ],
      reasons: ['  INPUT   changed\n'],
    });
    const b = failureSignature({
      checks: [
        { specId: 'a', verdict: 'pass' },
        { specId: 'b', verdict: 'fail' },
      ],
      criteria: [
        { criterion: 1, verdict: 'pass' },
        { criterion: 2, verdict: 'fail' },
      ],
      reasons: ['input changed'],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(failureSignature({ checks: [], criteria: [], reasons: ['other'] })).not.toBe(a);
  });

  it.each(['starting', 'running', 'checking'] as const)(
    'reconcileAfterRestart переводит %s в aborted с остановкой сессии',
    (status) => {
      const plan = status === 'checking' ? checks(submitted().plan).plan : running();
      last(plan).status = status;
      const next = reconcileAfterRestart(plan, {
        ...context(plan),
        observations: [],
        integrationHead: { sha: 'base', parents: [], opKey: null },
      });
      expect(last(next).status).toBe('aborted');
      expect(auto(next).halted?.reason).toBe('restart');
      expect(
        auto(next).ops.some(
          (op) => op.kind === 'stop-session' && op.payload.sessionId === last(plan).worker,
        ),
      ).toBe(true);
    },
  );

  it.each(['submitted', 'accepted', 'queued'] as const)(
    'reconcileAfterRestart сохраняет %s',
    (status) => {
      const plan =
        status === 'submitted'
          ? submitted().plan
          : status === 'accepted'
            ? accepted().plan
            : queued();
      const next = reconcileAfterRestart(plan, {
        ...context(plan),
        observations: [],
        integrationHead: { sha: 'base', parents: [], opKey: null },
      });
      expect(last(next).status).toBe(status);
      expect(auto(next).integration.queue).toEqual(auto(plan).integration.queue);
    },
  );

  it('reconcileAfterRestart сохраняет подтверждённого кандидата только для полной перепроверки', () => {
    const merged = candidate();
    const next = reconcileAfterRestart(merged.plan, {
      ...context(merged.plan),
      observations: [],
      integrationHead: {
        sha: auto(merged.plan).integration.candidateHead!,
        parents: ['base', last(merged.plan).sha!],
        opKey: merged.opKey,
      },
    });
    expect(auto(next).integration.candidateHead).toBe('head-at-0001');
    expect(auto(next).integration.verifiedHead).toBe('base');
    const resumed = resume(next, { ...context(next), requestedBy: HUMAN });
    expect(() =>
      integrate(resumed, {
        ...context(resumed),
        attemptId: last(resumed).id,
        opKey: merged.opKey,
        results: [],
        verifiers: [],
      }),
    ).toThrow('integration-coverage-incomplete');
  });

  it('reconcileAfterRestart сбрасывает неподтверждённого кандидата и оставляет попытку в очереди', () => {
    const merged = candidate();
    const next = reconcileAfterRestart(merged.plan, {
      ...context(merged.plan),
      observations: [],
      integrationHead: {
        sha: 'unexpected',
        parents: ['wrong', last(merged.plan).sha!],
        opKey: merged.opKey,
      },
    });
    expect(auto(next).integration).toMatchObject({
      candidateHead: null,
      verifiedHead: 'base',
      queue: [last(next).id],
    });
    expect(last(next).status).toBe('queued');
    expect(auto(next).ops.some((op) => op.kind === 'merge-abort' && op.state === 'intended')).toBe(
      true,
    );
  });

  it('reconcileAfterRestart завершает найденное намерение merge без повторного эффекта', () => {
    const plan = queued();
    const intended = intendOp(plan, {
      ...context(plan),
      kind: 'merge',
      attemptId: last(plan).id,
      payload: { sha: last(plan).sha, verifiedHead: 'base' },
    });
    const key = lastOp(intended).key;
    const next = reconcileAfterRestart(intended, {
      ...context(intended),
      observations: [],
      integrationHead: { sha: 'found-merge', parents: ['base', last(plan).sha!], opKey: key },
    });
    expect(auto(next).ops.find((op) => op.key === key)?.state).toBe('done');
    expect(auto(next).integration.candidateHead).toBe('found-merge');
    expect(auto(next).ops.filter((op) => op.kind === 'merge')).toHaveLength(1);
  });

  it('resume разрешён только из halted и по явному действию человека', () => {
    const plan = fixture();
    expect(() => resume(plan, { ...context(plan), requestedBy: HUMAN })).toThrow('plan-not-halted');
    const stopped = halt(plan, { ...context(plan), reason: 'human', detail: 'Стоп' });
    expect(() => resume(stopped, { ...context(stopped), requestedBy: 's-01' })).toThrow(
      'only a human',
    );
    const next = resume(stopped, { ...context(stopped), requestedBy: HUMAN });
    expect(auto(next).halted).toBeNull();
    expect(lastOp(next).kind).toBe('resume');
  });

  it('счётчики и резервы переживают JSON round-trip через parseMap', () => {
    const plan = submitted().plan;
    const pending = intendOp(plan, {
      ...context(plan),
      kind: 'create-session',
      attemptId: last(plan).id,
      payload: { role: 'verifier' },
    });
    const map: WorkMap = {
      schemaVersion: 2,
      work: {
        id: 'w-0001',
        title: 'Тест',
        goal: '',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      sessions: [],
      messages: [],
      rooms: [room()],
      plans: [pending],
    };
    // JSON.stringify is the map's on-disk serialization, as in map.test.ts.
    const again = parseMap(JSON.stringify(map), 'map.json').plans![0]!;
    expect(auto(again).budget).toEqual(auto(pending).budget);
    expect(auto(again).seq).toEqual(auto(pending).seq);
    expect(auto(again).budget.reservations).toHaveLength(1);
    expect(auto(again).budget.spent).toMatchObject({ attempts: 1, sessions: 1, launches: 1 });
  });

  it('намерение и завершение операции идемпотентны и не перезаписывают результат', () => {
    const plan = running();
    const input = {
      ...context(plan),
      key: 'explicit-op',
      kind: 'cleanup' as const,
      attemptId: last(plan).id,
      payload: { path: 'clone' },
    };
    const intended = intendOp(plan, input);
    expect(intendOp(intended, input)).toEqual(intended);
    const done = settleOp(intended, {
      ...context(intended),
      key: input.key,
      outcome: 'done',
      result: { removed: true },
    });
    expect(
      settleOp(done, {
        ...context(done),
        key: input.key,
        outcome: 'done',
        result: { removed: true },
      }),
    ).toEqual(done);
    expect(() =>
      settleOp(done, { ...context(done), key: input.key, outcome: 'failed', result: {} }),
    ).toThrow('op-conflict');
    expect(auto(intended).ops.find((op) => op.key === input.key)?.state).toBe('intended');
  });

  it('резерв снимается только после завершения операции и учитывается один раз', () => {
    const plan = startAttempt(fixture(), {
      ...context(fixture()),
      item: 1,
      branch: 'attempt',
      baseSha: 'base',
    });
    const key = lastOp(plan).key;
    expect(
      reserve(plan, { ...context(plan), key, kind: 'session', attemptId: last(plan).id }),
    ).toEqual(plan);
    expect(() => release(plan, { ...context(plan), key })).toThrow('operation is not settled');
    const done = settleOp(plan, {
      ...context(plan),
      key,
      outcome: 'done',
      result: { sessionId: 'worker' },
    });
    expect(auto(done).budget.reservations).toEqual([]);
    expect(release(done, { ...context(done), key })).toEqual(done);
    expect(auto(done).budget.spent.sessions).toBe(1);
  });

  it('ожидающие резервы блокируют превышение сессий и останавливают план', () => {
    const plan = fixture();
    auto(plan).budget.limits.sessions = 1;
    const pending = startAttempt(plan, {
      ...context(plan),
      item: 1,
      branch: 'attempt',
      baseSha: 'base',
    });
    const denied = reserve(pending, {
      ...context(pending),
      key: 'another',
      kind: 'session',
      attemptId: last(pending).id,
    });
    expect(auto(denied).halted?.reason).toBe('budget');
    expect(auto(denied).budget.reservations).toHaveLength(1);
  });

  it('suspend сохраняет verifiedHead и намечает откат кандидата', () => {
    const merged = candidate();
    const next = suspend(merged.plan, {
      ...context(merged.plan),
      attemptId: last(merged.plan).id,
      reason: 'dirty integration checkout',
    });
    expect(auto(next).integration).toMatchObject({
      verifiedHead: 'base',
      candidateHead: null,
      suspended: { reason: 'dirty integration checkout' },
    });
    expect(lastOp(next).kind).toBe('merge-abort');
  });

  it('только ENGINE с актуальной rev может менять план, отказ не меняет вход', () => {
    const plan = fixture(),
      saved = structuredClone(plan);
    expect(() =>
      startAttempt(plan, {
        ...context(plan),
        actor: 's-01',
        item: 1,
        branch: 'attempt',
        baseSha: 'base',
      }),
    ).toThrow('only the engine');
    expect(() =>
      startAttempt(plan, { ...context(plan), rev: 0, item: 1, branch: 'attempt', baseSha: 'base' }),
    ).toThrow('plan revision');
    expect(plan).toEqual(saved);
  });

  it('отсутствующая текущая версия критериев не подменяется единицей на всех границах', () => {
    const initial = fixture();
    delete auto(initial).criteriaVersion[1];
    expect(() => running(initial)).toThrow('criteria-missing');
    const active = running(),
      hand = handoff(active);
    delete auto(active).criteriaVersion[1];
    const refused = submitAttempt(active, {
      ...context(active),
      attemptId: last(active).id,
      submissionKey: hand.key,
      manifest: hand.manifest,
    });
    expect(last(refused).log.some((entry) => entry.note === 'criteria-missing')).toBe(true);
    const checked = checks(submitted().plan);
    delete auto(checked.plan).criteriaVersion[1];
    expect(
      coverageVerdict(checked.plan, {
        ...context(checked.plan),
        attemptId: last(checked.plan).id,
        results: checked.results,
        verifiers: [],
      }).reason,
    ).toBe('criteria-missing');
    const merged = candidate();
    delete auto(merged.plan).criteriaVersion[1];
    expect(
      last(
        integrate(merged.plan, {
          ...context(merged.plan),
          attemptId: last(merged.plan).id,
          opKey: merged.opKey,
          results: [],
          verifiers: [],
        }),
      ).status,
    ).toBe('superseded');
  });

  it.each(['accepted', 'integrate'] as const)(
    'устаревшая criteriaVersion отгораживает попытку на границе %s',
    (boundary) => {
      if (boundary === 'accepted') {
        const checked = checks(submitted().plan);
        auto(checked.plan).criteriaVersion[1] = 2;
        const result = coverageVerdict(checked.plan, {
          ...context(checked.plan),
          attemptId: last(checked.plan).id,
          results: checked.results,
          verifiers: [],
        });
        expect(result.reason).toBe('criteria-stale');
        expect(last(result.plan).status).toBe('superseded');
      } else {
        const merged = candidate();
        auto(merged.plan).criteriaVersion[1] = 2;
        const next = integrate(merged.plan, {
          ...context(merged.plan),
          attemptId: last(merged.plan).id,
          opKey: merged.opKey,
          results: [],
          verifiers: [],
        });
        expect(last(next).status).toBe('superseded');
        expect(auto(next).integration.candidateHead).toBeNull();
      }
    },
  );

  it.each(['error', 'fail'] as const)('результат %s блокирует приём', (verdict) => {
    const checked = checks(submitted().plan, { verdict });
    expect(
      coverageVerdict(checked.plan, {
        ...context(checked.plan),
        attemptId: last(checked.plan).id,
        results: checked.results,
        verifiers: [],
      }).accepted,
    ).toBe(false);
  });

  it('заявленное неполное покрытие манифеста не превращается в accepted', () => {
    const checked = checks(submitted(running(), { manifest: { coverage: 'partial' } }).plan);
    expect(
      coverageVerdict(checked.plan, {
        ...context(checked.plan),
        attemptId: last(checked.plan).id,
        results: checked.results,
        verifiers: [],
      }),
    ).toMatchObject({ accepted: false, gaps: ['manifest:coverage'] });
  });

  it.each([{ inputsOk: false }, { artifactsCopied: false }, { artifactHashesOk: false }])(
    'квитанция не valid при неверных входах или копиях: %j',
    (options) => {
      expect(last(submitted(running(), options).plan).receipt?.valid).toBe(false);
    },
  );

  it('захват нельзя наметить до подтверждённой остановки исполнителя', () => {
    const plan = running(),
      hand = handoff(plan);
    const submitted = submitAttempt(plan, {
      ...context(plan),
      attemptId: last(plan).id,
      submissionKey: hand.key,
      manifest: hand.manifest,
    });
    expect(() =>
      intendOp(submitted, {
        ...context(submitted),
        kind: 'capture',
        attemptId: last(plan).id,
        payload: {},
      }),
    ).toThrow('attempt-not-stopped');
  });

  it('интеграция требует свежие проверки всех уже интегрированных пунктов', () => {
    const merged = candidate(queued(accepted(submitted(running(integrated(), 2)).plan).plan));
    const onlyCandidate = checks(merged.plan, { integration: true });
    expect(() =>
      integrate(onlyCandidate.plan, {
        ...context(onlyCandidate.plan),
        attemptId: last(merged.plan).id,
        opKey: merged.opKey,
        results: onlyCandidate.results,
        verifiers: [],
      }),
    ).toThrow('integration-coverage-incomplete');
    const previous = checks(onlyCandidate.plan, {
      integration: true,
      attemptIds: [auto(merged.plan).attempts[0]!.id],
    });
    const next = integrate(previous.plan, {
      ...context(previous.plan),
      attemptId: last(merged.plan).id,
      opKey: merged.opKey,
      results: [...onlyCandidate.results, ...previous.results],
      verifiers: [],
    });
    expect(last(next).status).toBe('integrated');
  });

  it('успешные прогоны до падения не заменяют перепроверку кандидата после resume', () => {
    const merged = candidate();
    const before = checks(merged.plan, { integration: true });
    const restarted = reconcileAfterRestart(before.plan, {
      ...context(before.plan),
      observations: [],
      integrationHead: {
        sha: auto(before.plan).integration.candidateHead!,
        parents: ['base', last(before.plan).sha!],
        opKey: merged.opKey,
      },
    });
    const resumed = resume(restarted, { ...context(restarted), requestedBy: HUMAN });
    expect(() =>
      integrate(resumed, {
        ...context(resumed),
        attemptId: last(resumed).id,
        opKey: merged.opKey,
        results: before.results,
        verifiers: [],
      }),
    ).toThrow('integration-coverage-incomplete');
    const after = checks(resumed, { integration: true });
    expect(
      last(
        integrate(after.plan, {
          ...context(after.plan),
          attemptId: last(after.plan).id,
          opKey: merged.opKey,
          results: after.results,
          verifiers: [],
        }),
      ).status,
    ).toBe('integrated');
  });

  it('восстановление noop сохраняет кандидата без поиска коммита слияния', () => {
    const merged = candidate(queued(accepted(submitted(running(), { sha: 'base' }).plan).plan));
    const restarted = reconcileAfterRestart(merged.plan, {
      ...context(merged.plan),
      observations: [],
      integrationHead: { sha: 'base', parents: [], opKey: null },
    });
    expect(auto(restarted).integration.candidateHead).toBe('base');
    expect(auto(restarted).integration.verifiedHead).toBe('base');
    expect(last(restarted).status).toBe('queued');
  });

  it('незавершённый check после рестарта помечается failed даже при внешнем pass', () => {
    const plan = submitted().plan;
    const intended = intendOp(plan, {
      ...context(plan),
      kind: 'check',
      attemptId: last(plan).id,
      payload: { phase: 'attempt', sha: last(plan).sha },
    });
    const key = lastOp(intended).key;
    const next = reconcileAfterRestart(intended, {
      ...context(intended),
      observations: [{ key, outcome: 'done', result: { verdict: 'pass' } }],
      integrationHead: { sha: 'base', parents: [], opKey: null },
    });
    expect(auto(next).ops.find((op) => op.key === key)?.state).toBe('failed');
  });

  it('лимит минут останавливает сдачу и сохраняет потраченное время', () => {
    const plan = running(),
      hand = handoff(plan);
    const next = submitAttempt(plan, {
      ...context(plan),
      now: '2026-10-24T10:31:00.000Z',
      attemptId: last(plan).id,
      submissionKey: hand.key,
      manifest: hand.manifest,
    });
    expect(auto(next).halted?.reason).toBe('budget');
    expect(last(next).status).toBe('aborted');
    expect(last(next).submissionKey).toBeNull();
    expect(auto(next).budget.spent.minutes).toBe(31);
  });

  it('конкурентность учитывает уже запущенную сессию и резерв нового запуска', () => {
    let plan = fixture();
    plan.items[1]!.after = [];
    plan.items[1]!.status = 'ready';
    auto(plan).budget.limits.concurrent = 1;
    plan = running(plan);
    const next = running(plan, 2);
    expect(auto(next).halted?.reason).toBe('budget');
    expect(last(next).status).toBe('aborted');
    expect(auto(next).budget.spent.launches).toBe(1);
    expect(
      auto(next)
        .ops.filter((op) => op.kind === 'launch')
        .map((op) => op.state),
    ).toEqual(['done', 'failed']);
  });

  it('создание и запуск проверяющего расходуют общий бюджет и счётчик verifiers', () => {
    let plan = submitted().plan;
    plan = operation(
      plan,
      'create-session',
      last(plan).id,
      { role: 'verifier' },
      { sessionId: 'verifier' },
    );
    plan = operation(plan, 'launch', last(plan).id, { role: 'verifier', sessionId: 'verifier' });
    expect(auto(plan).budget.spent).toMatchObject({ sessions: 2, verifiers: 1, launches: 2 });
    expect(auto(plan).budget.reservations).toEqual([]);
    expect(last(plan).verifier).toBe('verifier');
  });

  it('долгий интеграционный прогон останавливает план до сдвига verifiedHead', () => {
    const merged = candidate();
    const spec = auto(merged.plan).checks[0]!;
    const result: CheckResult = {
      id: 'long-check',
      attemptId: last(merged.plan).id,
      specId: spec.id,
      sha: auto(merged.plan).integration.candidateHead!,
      argvHash: digest(spec.argv),
      envHash: digest(spec.env),
      by: ENGINE,
      verdict: 'pass',
      inputsOk: true,
      exitCode: 0,
      summary: 'Долго',
      outputTail: null,
      at: now,
      durationMs: 31 * 60_000,
    };
    const checked = operation(
      merged.plan,
      'check',
      last(merged.plan).id,
      { phase: 'integration', sha: result.sha, integrationOp: merged.opKey },
      { checkResult: result },
    );
    const next = integrate(checked, {
      ...context(checked),
      attemptId: last(checked).id,
      opKey: merged.opKey,
      results: [result],
      verifiers: [],
    });
    expect(auto(next).halted?.reason).toBe('budget');
    expect(auto(next).integration.verifiedHead).toBe('base');
    expect(last(next).status).toBe('queued');
  });

  it('второе намерение создания сессии не перезаписывает первое и не берёт второй резерв', () => {
    const plan = startAttempt(fixture(), {
      ...context(fixture()),
      item: 1,
      branch: 'attempt',
      baseSha: 'base',
    });
    expect(() =>
      intendOp(plan, {
        ...context(plan),
        key: 'second-create',
        kind: 'create-session',
        attemptId: last(plan).id,
        payload: { role: 'worker' },
      }),
    ).toThrow('operation-in-flight');
    expect(auto(plan).budget.reservations).toHaveLength(1);
    expect(auto(plan).ops).toHaveLength(1);
  });

  it('amendment снимает приостановку очереди затронутой попытки', () => {
    const plan = queued();
    const stopped = suspend(plan, {
      ...context(plan),
      attemptId: last(plan).id,
      reason: 'conflict',
    });
    const next = supersedeByAmendment(stopped, room(), { ...context(stopped), changedItems: [1] });
    expect(auto(next.plan).integration.suspended).toBeNull();
    expect(auto(next.plan).integration.queue).toEqual([]);
  });

  it('после рестарта запуск новой попытки ждёт намеченного отката ветки', () => {
    const merged = candidate();
    const restarted = reconcileAfterRestart(merged.plan, {
      ...context(merged.plan),
      observations: [],
      integrationHead: { sha: 'foreign', parents: [], opKey: null },
    });
    const resumed = resume(restarted, { ...context(restarted), requestedBy: HUMAN });
    expect(() =>
      intendOp(resumed, {
        ...context(resumed),
        kind: 'merge',
        attemptId: last(resumed).id,
        payload: { sha: last(resumed).sha, verifiedHead: 'base' },
      }),
    ).toThrow('integration-not-ready');
  });
});
