import { createHash } from 'node:crypto';
import { PlanConflictError } from './plans.js';
import { RoomRuleError } from './rooms.js';
import { ENGINE, HUMAN } from './types.js';
import type {
  AutonomousOp,
  AutonomousPlan,
  CheckResult,
  HandoffManifest,
  PlanAttempt,
  PlanItem,
  Room,
  RoomPlan,
} from './types.js';

/**
 * Rules return detached state; callers persist it atomically. Invalid requests throw the
 * existing rule/conflict errors. Stale criteria/dependencies instead return a fenced
 * attempt, with the reason in its appended log. All time and git facts are explicit.
 *
 * Hashes use canonical JSON (lexically sorted object keys). A submissionKey hashes the
 * incoming manifest without sha; manifest.hash hashes it without hash. Operation payloads:
 * session {role, sessionId?}, copy-artifacts {captureOp}, check {phase, sha, specId?},
 * merge/noop {sha, verifiedHead, containedInVerifiedHead?}. Settled captures return {sha, tree};
 * settled checks return {checkResult}. Compose coverageVerdict + enqueue in one transaction.
 * Integration checks include {phase: 'integration', sha, integrationOp}. The candidate's
 * verifier session uses {purpose: 'integration-verifier', sha}; phase/integrationOp are captured
 * in its intent. Its provenance stays in ops; attempt.verifier retains the acceptance verifier.
 * A replacement requires the previous session to be closed.
 */
interface Context {
  actor: string;
  rev: number;
  now: string;
}
const terminal = new Set<PlanAttempt['status']>([
  'integrated',
  'returned',
  'blocked',
  'aborted',
  'superseded',
]);
const fenced = new Set<PlanAttempt['status']>(['returned', 'blocked', 'aborted', 'superseded']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
function state(plan: RoomPlan): AutonomousPlan {
  if (plan.mode !== 'autonomous' || !plan.autonomous)
    throw new RoomRuleError('autonomous plan required');
  return plan.autonomous;
}
function edit(plan: RoomPlan, input: Context): RoomPlan {
  state(plan);
  if (input.actor !== ENGINE)
    throw new RoomRuleError('only the engine can mutate an autonomous plan');
  if (input.rev !== plan.rev || !['active', 'completing'].includes(plan.status))
    throw new PlanConflictError();
  if (!Number.isFinite(Date.parse(input.now))) throw new RoomRuleError('invalid time');
  return structuredClone(plan);
}
function attemptOf(plan: RoomPlan, id: string): PlanAttempt {
  const attempt = state(plan).attempts.find((entry) => entry.id === id);
  if (!attempt) throw new RoomRuleError('unknown attempt');
  return attempt;
}
function itemOf(plan: RoomPlan, id: number): PlanItem {
  const item = plan.items.find((entry) => entry.id === id);
  if (!item) throw new RoomRuleError('unknown item');
  return item;
}
function transition(
  plan: RoomPlan,
  attempt: PlanAttempt,
  status: PlanAttempt['status'],
  now: string,
  note: string | null = null,
  op: string | null = null,
): void {
  attempt.status = status;
  attempt.log.push({ at: now, by: ENGINE, status, note, op });
  if (terminal.has(status) && attempt.endedAt === null) {
    attempt.endedAt = now;
    state(plan).budget.spent.minutes += Math.max(
      0,
      Math.ceil((Date.parse(now) - Date.parse(attempt.startedAt)) / 60_000),
    );
  }
}
function itemStatus(
  item: PlanItem,
  status: PlanItem['status'],
  now: string,
  note: string | null = null,
): void {
  item.status = status;
  item.note = note;
  item.log.push({ at: now, by: ENGINE, status, note });
}
function recalculate(plan: RoomPlan): void {
  for (const item of plan.items)
    if (item.status === 'waiting' || item.status === 'ready')
      item.status = item.after.every((id) => itemOf(plan, id).status === 'verified')
        ? 'ready'
        : 'waiting';
  const a = state(plan);
  plan.status =
    !a.halted &&
    !a.integration.suspended &&
    !a.integration.candidateHead &&
    !a.integration.queue.length &&
    plan.items.every((item) => item.status === 'verified')
      ? 'completing'
      : 'active';
  if (plan.status === 'active') plan.completionSummary = null;
}
function requireRunning(plan: RoomPlan): void {
  if (state(plan).halted) throw new RoomRuleError('plan-halted');
}
function validReceipt(attempt: PlanAttempt): boolean {
  if (!attempt.receipt?.valid || !attempt.manifest || !attempt.sha || !attempt.tree) return false;
  const { hash: manifestHash, ...body } = attempt.manifest;
  return (
    attempt.receipt.attemptId === attempt.id &&
    attempt.receipt.sha === attempt.sha &&
    attempt.manifest.sha === attempt.sha &&
    attempt.receipt.criteriaVersion === attempt.criteriaVersion &&
    attempt.manifest.criteriaVersion === attempt.criteriaVersion &&
    attempt.receipt.manifestHash === manifestHash &&
    hash(body) === manifestHash
  );
}
function appendOp(
  plan: RoomPlan,
  kind: AutonomousOp['kind'],
  attemptId: string | null,
  payload: Record<string, unknown>,
  now: string,
  key?: string,
): AutonomousOp {
  const a = state(plan);
  const existing = key ? a.ops.find((op) => op.key === key) : undefined;
  if (existing) {
    if (
      existing.kind !== kind ||
      existing.attemptId !== attemptId ||
      canonical(existing.payload) !== canonical(payload)
    )
      throw new RoomRuleError('op-conflict');
    return existing;
  }
  const generated = `op-${String(++a.seq.op).padStart(4, '0')}`;
  const op: AutonomousOp = {
    key: key ?? generated,
    kind,
    attemptId,
    payload: structuredClone(payload),
    state: 'intended',
    at: now,
    settledAt: null,
    result: null,
  };
  if (a.ops.some((entry) => entry.key === op.key)) throw new RoomRuleError('op-conflict');
  a.ops.push(op);
  if (attemptId) {
    const attempt = attemptOf(plan, attemptId);
    transition(plan, attempt, attempt.status, now, null, op.key);
  }
  return op;
}
function stopSessions(plan: RoomPlan, attempt: PlanAttempt, now: string): void {
  const created = state(plan)
    .ops.filter(
      (op) => op.kind === 'create-session' && op.attemptId === attempt.id && op.state === 'done',
    )
    .map((op) => op.result?.sessionId)
    .filter((id): id is string => typeof id === 'string');
  for (const sessionId of new Set([attempt.worker, attempt.verifier, ...created])) {
    if (!sessionId) continue;
    if (
      state(plan).ops.some(
        (op) =>
          op.kind === 'close-session' && op.payload.sessionId === sessionId && op.state === 'done',
      )
    )
      continue;
    for (const kind of ['stop-session', 'close-session'] as const)
      if (
        !state(plan).ops.some(
          (op) =>
            op.kind === kind &&
            op.attemptId === attempt.id &&
            op.payload.sessionId === sessionId &&
            op.state !== 'failed',
        )
      )
        appendOp(plan, kind, attempt.id, { sessionId }, now);
  }
}
function staleReason(
  plan: RoomPlan,
  attempt: PlanAttempt,
  manifest = attempt.manifest,
): string | null {
  const a = state(plan);
  if (!a.criteriaVersion[attempt.item]) return 'criteria-missing';
  if (
    attempt.criteriaVersion !== a.criteriaVersion[attempt.item] ||
    (manifest && manifest.criteriaVersion !== a.criteriaVersion[attempt.item])
  )
    return 'criteria-stale';
  if (!manifest) return 'handoff-missing';
  const expected: string[] = [];
  for (const id of itemOf(plan, attempt.item).after) {
    const dependency = a.attempts.findLast((entry) => entry.item === id);
    if (
      !dependency ||
      !['accepted', 'queued', 'integrated'].includes(dependency.status) ||
      itemOf(plan, id).status !== 'verified'
    )
      return 'dependency-stale';
    expected.push(dependency.id);
  }
  return canonical([...manifest.dependsOn].sort()) === canonical(expected.sort())
    ? null
    : 'dependency-stale';
}
function supersede(plan: RoomPlan, attempt: PlanAttempt, now: string, reason: string): void {
  const integration = state(plan).integration;
  if (integration.queue[0] === attempt.id && integration.candidateHead) {
    appendOp(plan, 'merge-abort', attempt.id, { sha: integration.verifiedHead }, now);
    integration.candidateHead = null;
  }
  integration.queue = integration.queue.filter((id) => id !== attempt.id);
  if (integration.suspended?.attemptId === attempt.id) integration.suspended = null;
  transition(plan, attempt, 'superseded', now, reason);
  itemOf(plan, attempt.item).evidence = null;
  itemStatus(itemOf(plan, attempt.item), 'waiting', now, reason);
  stopSessions(plan, attempt, now);
  recalculate(plan);
}
function haltDraft(
  plan: RoomPlan,
  reason: NonNullable<AutonomousPlan['halted']>['reason'],
  detail: string,
  now: string,
): void {
  state(plan).halted = { reason, detail, at: now };
  for (const attempt of state(plan).attempts) {
    if (['starting', 'running', 'checking'].includes(attempt.status)) {
      transition(plan, attempt, 'aborted', now, detail);
      itemStatus(itemOf(plan, attempt.item), 'returned', now, detail);
    }
    stopSessions(plan, attempt, now);
  }
  recalculate(plan);
}
function activeLaunches(plan: RoomPlan, sessionId?: string): number {
  const ops = state(plan).ops;
  return new Set(
    ops
      .filter(
        (op, index) =>
          op.kind === 'launch' &&
          op.state === 'done' &&
          (sessionId === undefined || op.payload.sessionId === sessionId) &&
          !ops
            .slice(index + 1)
            .some(
              (closed) =>
                ['stop-session', 'close-session'].includes(closed.kind) &&
                closed.state === 'done' &&
                closed.payload.sessionId === op.payload.sessionId,
            ),
      )
      .map((op) => op.payload.sessionId),
  ).size;
}
function currentIntegrationOp(plan: RoomPlan): AutonomousOp | undefined {
  const a = state(plan),
    i = a.integration;
  return a.ops.findLast(
    (op) =>
      ['merge', 'noop-integration'].includes(op.kind) &&
      op.state === 'done' &&
      op.attemptId === i.queue[0] &&
      i.candidateHead !== null &&
      op.result?.sha === i.candidateHead &&
      op.payload.verifiedHead === i.verifiedHead,
  );
}
function integrationVerifier(plan: RoomPlan): string | null {
  const a = state(plan),
    integration = currentIntegrationOp(plan);
  if (!integration) return null;
  const resume = a.ops.findLastIndex((op) => op.kind === 'resume');
  const creation = a.ops.findLast(
    (op, index) =>
      index > resume &&
      op.kind === 'create-session' &&
      op.attemptId === integration.attemptId &&
      op.payload.role === 'verifier' &&
      op.payload.purpose === 'integration-verifier' &&
      op.payload.phase === 'integration' &&
      op.payload.integrationOp === integration.key &&
      op.payload.sha === a.integration.candidateHead &&
      op.state !== 'failed',
  );
  return creation?.state === 'done' && typeof creation.result?.sessionId === 'string'
    ? creation.result.sessionId
    : null;
}
function withinTime(plan: RoomPlan, attempt: PlanAttempt, now: string): boolean {
  const a = state(plan);
  const checks = new Map<string, CheckResult>();
  for (const op of a.ops) {
    if (op.kind !== 'check' || op.state !== 'done') continue;
    const result = op.result?.checkResult as CheckResult | undefined;
    if (
      !result ||
      !a.attempts.some((owner) => owner.id === op.attemptId && owner.checks.includes(result.id))
    )
      continue;
    const owner =
      op.payload.phase === 'integration'
        ? a.ops.find((merge) => merge.key === op.payload.integrationOp)?.attemptId
        : op.attemptId;
    if (owner === attempt.id) checks.set(result.id, result);
  }
  const minutes =
    Math.max(
      0,
      Math.ceil((Date.parse(attempt.endedAt ?? now) - Date.parse(attempt.startedAt)) / 60_000),
    ) +
    [...checks.values()].reduce((sum, result) => sum + Math.ceil(result.durationMs / 60_000), 0);
  if (minutes <= a.budget.limits.minutesPerAttempt) return true;
  haltDraft(plan, 'budget', 'minutesPerAttempt limit', now);
  return false;
}
function reserveDraft(
  plan: RoomPlan,
  key: string,
  kind: 'session' | 'launch',
  attemptId: string,
  now: string,
): boolean {
  const { budget } = state(plan);
  const existing = budget.reservations.find((entry) => entry.key === key);
  if (existing) {
    if (existing.kind !== kind || existing.attemptId !== attemptId)
      throw new RoomRuleError('reservation-conflict');
    return true;
  }
  if (state(plan).ops.some((op) => op.key === key && op.state !== 'intended'))
    throw new RoomRuleError('reservation-settled');
  const op = state(plan).ops.find((entry) => entry.key === key);
  const charged =
    op?.payload.phase === 'integration'
      ? (currentIntegrationOp(plan)?.attemptId ?? attemptId)
      : attemptId;
  if (!withinTime(plan, attemptOf(plan, charged), now)) return false;
  const count = budget.reservations.filter((entry) => entry.kind === kind).length;
  if (
    (kind === 'session' && budget.spent.sessions + count >= budget.limits.sessions) ||
    (kind === 'launch' && activeLaunches(plan) + count >= budget.limits.concurrent)
  ) {
    haltDraft(plan, 'budget', `${kind} limit`, now);
    return false;
  }
  budget.reservations.push({ key, kind, attemptId, at: now });
  return true;
}

export function reserve(
  plan: RoomPlan,
  input: Context & { key: string; kind: 'session' | 'launch'; attemptId: string },
): RoomPlan {
  const next = edit(plan, input);
  requireRunning(next);
  attemptOf(next, input.attemptId);
  reserveDraft(next, input.key, input.kind, input.attemptId, input.now);
  return next;
}
export function release(plan: RoomPlan, input: Context & { key: string }): RoomPlan {
  const next = edit(plan, input);
  const op = state(next).ops.find((entry) => entry.key === input.key);
  if (!op || op.state === 'intended') throw new RoomRuleError('operation is not settled');
  state(next).budget.reservations = state(next).budget.reservations.filter(
    (entry) => entry.key !== input.key,
  );
  return next;
}
export function intendOp(
  plan: RoomPlan,
  input: Context & {
    key?: string;
    kind: AutonomousOp['kind'];
    attemptId: string | null;
    payload: Record<string, unknown>;
  },
): RoomPlan {
  const next = edit(plan, input);
  const existing = input.key && state(next).ops.find((op) => op.key === input.key);
  if (
    ['create-session', 'launch'].includes(input.kind) &&
    input.payload.purpose === 'integration-verifier'
  ) {
    if (input.payload.role !== undefined && input.payload.role !== 'verifier')
      throw new RoomRuleError('invalid session role');
    input = {
      ...input,
      payload: {
        ...input.payload,
        role: 'verifier',
        phase: 'integration',
        integrationOp:
          input.payload.integrationOp ??
          (existing ? existing.payload.integrationOp : currentIntegrationOp(next)?.key),
      },
    };
  }
  if (
    !existing &&
    !['stop-session', 'close-session', 'merge-abort', 'cleanup', 'resume'].includes(input.kind)
  )
    requireRunning(next);
  if (input.attemptId) attemptOf(next, input.attemptId);
  if (!existing && input.attemptId) {
    const attempt = attemptOf(next, input.attemptId);
    const integration = input.payload.phase === 'integration';
    const integrationOp = currentIntegrationOp(next);
    if (
      integration &&
      ['create-session', 'launch'].includes(input.kind) &&
      (input.payload.role !== 'verifier' ||
        input.payload.purpose !== 'integration-verifier' ||
        !integrationOp ||
        attempt.id !== integrationOp.attemptId ||
        input.payload.integrationOp !== integrationOp.key ||
        input.payload.sha !== state(next).integration.candidateHead ||
        !['queued', 'integrated'].includes(attempt.status))
    )
      throw new RoomRuleError('integration-verifier-not-needed');
    if (
      ['create-session', 'launch'].includes(input.kind) &&
      !['worker', 'verifier'].includes(String(input.payload.role))
    )
      throw new RoomRuleError('invalid session role');
    if (
      ['create-session', 'launch', 'capture', 'copy-artifacts'].includes(input.kind) &&
      state(next).ops.some(
        (op) =>
          op.kind === input.kind &&
          op.attemptId === attempt.id &&
          op.state !== 'failed' &&
          (input.kind === 'create-session'
            ? op.payload.role === input.payload.role &&
              (integration
                ? op.payload.phase === 'integration' &&
                  op.payload.integrationOp === input.payload.integrationOp &&
                  (op.state === 'intended' ||
                    !state(next).ops.some(
                      (closed) =>
                        closed.kind === 'close-session' &&
                        closed.state === 'done' &&
                        closed.payload.sessionId === op.result?.sessionId,
                    ))
                : op.payload.phase !== 'integration')
            : input.kind === 'launch'
              ? op.payload.sessionId === input.payload.sessionId && op.state === 'intended'
              : true),
      )
    )
      throw new RoomRuleError('operation-in-flight');
    if (
      input.kind === 'launch' &&
      typeof input.payload.sessionId === 'string' &&
      activeLaunches(next, input.payload.sessionId)
    )
      throw new RoomRuleError('session-already-running');
    if (
      input.kind === 'create-session' &&
      (input.payload.role === 'verifier'
        ? !integration &&
          (!['submitted', 'checking'].includes(attempt.status) || attempt.verifier !== null)
        : attempt.status !== 'starting' || attempt.worker !== null)
    )
      throw new RoomRuleError('session-not-needed');
    if (
      input.kind === 'launch' &&
      (typeof input.payload.sessionId !== 'string' ||
        input.payload.sessionId !==
          (input.payload.role === 'verifier'
            ? integration
              ? integrationVerifier(next)
              : attempt.verifier
            : attempt.worker) ||
        (input.payload.role === 'verifier'
          ? !integration && !['submitted', 'checking'].includes(attempt.status)
          : attempt.status !== 'starting'))
    )
      throw new RoomRuleError('session-not-launchable');
    if (
      input.kind === 'capture' &&
      (attempt.status !== 'running' ||
        !attempt.submissionKey ||
        (attempt.worker &&
          !state(next).ops.some(
            (op) =>
              op.kind === 'stop-session' &&
              op.attemptId === attempt.id &&
              op.payload.sessionId === attempt.worker &&
              op.state === 'done',
          )))
    )
      throw new RoomRuleError('attempt-not-stopped');
    if (
      input.kind === 'copy-artifacts' &&
      !state(next).ops.some(
        (op) =>
          op.key === input.payload.captureOp &&
          op.kind === 'capture' &&
          op.attemptId === attempt.id &&
          op.state === 'done',
      )
    )
      throw new RoomRuleError('capture-not-settled');
    if (
      input.kind === 'check' &&
      (!['submitted', 'checking', 'queued', 'integrated'].includes(attempt.status) ||
        (input.payload.phase === 'integration' &&
          (input.payload.sha !== state(next).integration.candidateHead ||
            input.payload.integrationOp !== integrationOp?.key)))
    )
      throw new RoomRuleError('attempt-not-checkable');
  }
  if (!existing && ['merge', 'noop-integration'].includes(input.kind)) {
    const a = state(next);
    if (
      !input.attemptId ||
      a.integration.queue[0] !== input.attemptId ||
      a.integration.suspended ||
      a.integration.candidateHead ||
      a.ops.some((op) => op.kind === 'merge-abort' && op.state === 'intended')
    )
      throw new RoomRuleError('integration-not-ready');
    const attempt = attemptOf(next, input.attemptId);
    const stale = staleReason(next, attempt);
    if (stale) {
      supersede(next, attempt, input.now, stale);
      return next;
    }
    if (
      attempt.status !== 'queued' ||
      !validReceipt(attempt) ||
      input.payload.sha !== attempt.sha ||
      input.payload.verifiedHead !== a.integration.verifiedHead
    )
      throw new RoomRuleError('integration-not-ready');
    if (
      (input.kind === 'noop-integration') !==
      (attempt.sha === a.integration.verifiedHead || input.payload.containedInVerifiedHead === true)
    )
      throw new RoomRuleError('invalid integration kind');
    if (
      a.ops.some((op) => ['merge', 'noop-integration'].includes(op.kind) && op.state === 'intended')
    )
      throw new RoomRuleError('integration-in-flight');
  }
  const op = appendOp(next, input.kind, input.attemptId, input.payload, input.now, input.key);
  if (!existing && ['create-session', 'launch'].includes(input.kind)) {
    if (!input.attemptId) throw new RoomRuleError('attempt required');
    if (
      !reserveDraft(
        next,
        op.key,
        input.kind === 'launch' ? 'launch' : 'session',
        input.attemptId,
        input.now,
      )
    ) {
      op.state = 'failed';
      op.settledAt = input.now;
      op.result = { reason: 'budget' };
    }
  }
  return next;
}
export function settleOp(
  plan: RoomPlan,
  input: Context & { key: string; outcome: 'done' | 'failed'; result: Record<string, unknown> },
): RoomPlan {
  const next = edit(plan, input);
  const a = state(next);
  const op = a.ops.find((entry) => entry.key === input.key);
  if (!op) throw new RoomRuleError('unknown operation');
  if (op.state !== 'intended') {
    if (op.state !== input.outcome || canonical(op.result) !== canonical(input.result))
      throw new RoomRuleError('op-conflict');
    return next;
  }
  const attempt = op.attemptId ? attemptOf(next, op.attemptId) : null;
  if (
    input.outcome === 'done' &&
    op.kind === 'create-session' &&
    (typeof input.result.sessionId !== 'string' || !input.result.sessionId)
  )
    throw new RoomRuleError('sessionId required');
  if (input.outcome === 'done' && ['merge', 'noop-integration'].includes(op.kind)) {
    if (!attempt || typeof input.result.sha !== 'string' || !input.result.sha)
      throw new RoomRuleError('candidate SHA required');
    if (op.kind === 'noop-integration' && input.result.sha !== a.integration.verifiedHead)
      throw new RoomRuleError('invalid noop candidate');
    if (
      attempt.status === 'queued' &&
      a.integration.queue[0] === attempt.id &&
      op.payload.verifiedHead === a.integration.verifiedHead
    )
      a.integration.candidateHead = input.result.sha;
    else appendOp(next, 'merge-abort', attempt.id, { sha: a.integration.verifiedHead }, input.now);
  }
  op.state = input.outcome;
  op.result = structuredClone(input.result);
  op.settledAt = input.now;
  if (input.outcome === 'done') {
    if (op.kind === 'create-session') {
      a.budget.spent.sessions++;
      if (op.payload.role === 'verifier') {
        a.budget.spent.verifiers++;
        if (attempt && !fenced.has(attempt.status) && op.payload.phase !== 'integration')
          attempt.verifier = input.result.sessionId as string;
      } else if (attempt && !fenced.has(attempt.status))
        attempt.worker = input.result.sessionId as string;
      if (attempt && fenced.has(attempt.status)) {
        appendOp(
          next,
          'stop-session',
          attempt.id,
          { sessionId: input.result.sessionId },
          input.now,
        );
        appendOp(
          next,
          'close-session',
          attempt.id,
          { sessionId: input.result.sessionId },
          input.now,
        );
      }
    }
    if (op.kind === 'launch') {
      a.budget.spent.launches++;
      if (attempt?.status === 'starting' && op.payload.role !== 'verifier')
        transition(next, attempt, 'running', input.now, null, op.key);
    }
    if (
      attempt &&
      ['create-session', 'launch'].includes(op.kind) &&
      (fenced.has(attempt.status) ||
        (op.payload.phase === 'integration' &&
          (a.halted || op.payload.integrationOp !== currentIntegrationOp(next)?.key)))
    )
      stopSessions(next, attempt, input.now);
  }
  a.budget.reservations = a.budget.reservations.filter((entry) => entry.key !== op.key);
  if (attempt) transition(next, attempt, attempt.status, input.now, input.outcome, op.key);
  return next;
}

export function startAttempt(
  plan: RoomPlan,
  input: Context & { item: number; branch: string; baseSha: string },
): RoomPlan {
  let next = edit(plan, input);
  requireRunning(next);
  const a = state(next),
    item = itemOf(next, input.item);
  if (a.integration.candidateHead) throw new RoomRuleError('candidate-recheck-required');
  if (
    a.integration.suspended ||
    a.ops.some((op) => op.kind === 'merge-abort' && op.state === 'intended')
  )
    throw new RoomRuleError('integration-not-ready');
  if (
    !['ready', 'returned'].includes(item.status) ||
    !item.after.every((id) => itemOf(next, id).status === 'verified') ||
    a.attempts.some((entry) => entry.item === item.id && !terminal.has(entry.status))
  )
    throw new RoomRuleError('item-not-ready');
  if (input.baseSha !== a.integration.verifiedHead || !input.branch.trim())
    throw new RoomRuleError('invalid attempt base or branch');
  const previous = a.attempts.filter((entry) => entry.item === item.id);
  const n = Math.max(0, ...previous.map((entry) => entry.n)) + 1;
  if (
    n > a.budget.limits.attemptsPerItem ||
    (previous.length && a.budget.spent.repairWaves >= a.budget.limits.repairWaves)
  ) {
    itemStatus(item, 'blocked', input.now, 'budget');
    haltDraft(next, 'budget', 'attempt or repair limit', input.now);
    return next;
  }
  const version = a.criteriaVersion[item.id];
  if (!version) throw new RoomRuleError('criteria-missing');
  const id = `at-${String(++a.seq.attempt).padStart(4, '0')}`;
  if (a.attempts.some((entry) => entry.id === id)) throw new RoomRuleError('attempt-conflict');
  a.attempts.push({
    id,
    item: item.id,
    n,
    planRev: next.rev,
    criteriaVersion: version,
    worker: null,
    verifier: null,
    branch: input.branch,
    baseSha: input.baseSha,
    sha: null,
    tree: null,
    submissionKey: null,
    status: 'starting',
    manifest: null,
    receipt: null,
    checks: [],
    failureSignature: null,
    startedAt: input.now,
    endedAt: null,
    log: [{ at: input.now, by: ENGINE, status: 'starting', note: null, op: null }],
  });
  a.budget.spent.attempts++;
  if (previous.length) a.budget.spent.repairWaves++;
  itemStatus(item, 'in_progress', input.now);
  next = intendOp(next, {
    ...input,
    kind: 'create-session',
    attemptId: id,
    payload: { role: 'worker' },
  });
  return next;
}

/** Preflight only: the host must stop, capture and copy before calling receipt. */
export function submitAttempt(
  plan: RoomPlan,
  input: Context & { attemptId: string; submissionKey: string; manifest: HandoffManifest },
): RoomPlan {
  const next = edit(plan, input),
    attempt = attemptOf(next, input.attemptId);
  const { hash: manifestHash, sha, ...body } = input.manifest;
  if (['aborted', 'superseded'].includes(attempt.status)) throw new RoomRuleError('attempt-fenced');
  const { sha: _sha, ...submission } = input.manifest;
  if (attempt.submissionKey !== null) {
    if (
      attempt.submissionKey !== input.submissionKey ||
      hash(submission) !== input.submissionKey ||
      sha !== null ||
      hash({ sha, ...body }) !== manifestHash
    )
      throw new RoomRuleError('handoff-conflict');
    return next;
  }
  if (fenced.has(attempt.status)) throw new RoomRuleError('attempt-fenced');
  requireRunning(next);
  if (attempt.status !== 'running') throw new RoomRuleError('attempt-not-running');
  if (!withinTime(next, attempt, input.now)) return next;
  if (
    sha !== null ||
    input.manifest.version !== 1 ||
    input.manifest.text.length > 4096 ||
    hash(submission) !== input.submissionKey ||
    hash({ sha, ...body }) !== manifestHash
  )
    throw new RoomRuleError('invalid manifest');
  const stale = staleReason(next, attempt, input.manifest);
  if (stale) {
    supersede(next, attempt, input.now, stale);
    return next;
  }
  attempt.submissionKey = input.submissionKey;
  attempt.manifest = structuredClone(input.manifest);
  if (attempt.worker)
    appendOp(next, 'stop-session', attempt.id, { sessionId: attempt.worker }, input.now);
  return next;
}

/** Observations describe the engine-owned capture, never the clone's HEAD/status. */
export function receipt(
  plan: RoomPlan,
  input: Context & {
    attemptId: string;
    submissionKey: string;
    sha: string;
    tree: string;
    baseTree: string;
    descendantOfBase: boolean;
    inputsOk: boolean;
    artifactsCopied: boolean;
    artifactHashesOk: boolean;
    captureOp: string;
    copyOp: string;
  },
): { plan: RoomPlan; unchanged: boolean } {
  let next = edit(plan, input);
  const a = state(next),
    attempt = attemptOf(next, input.attemptId);
  if (['aborted', 'superseded'].includes(attempt.status)) throw new RoomRuleError('attempt-fenced');
  if (attempt.submissionKey !== input.submissionKey || !attempt.manifest)
    throw new RoomRuleError('handoff-conflict');
  if (attempt.receipt) return { plan: next, unchanged: attempt.tree === input.baseTree };
  if (fenced.has(attempt.status)) throw new RoomRuleError('attempt-fenced');
  requireRunning(next);
  if (attempt.status !== 'running') throw new RoomRuleError('attempt-not-running');
  if (!withinTime(next, attempt, input.now)) return { plan: next, unchanged: false };
  const stale = staleReason(next, attempt);
  if (stale) {
    supersede(next, attempt, input.now, stale);
    return { plan: next, unchanged: false };
  }
  const completed = (key: string, kind: AutonomousOp['kind']): boolean =>
    a.ops.some(
      (op) =>
        op.key === key && op.kind === kind && op.attemptId === attempt.id && op.state === 'done',
    );
  if (
    !input.sha ||
    !input.tree ||
    !input.baseTree ||
    !completed(input.captureOp, 'capture') ||
    !completed(input.copyOp, 'copy-artifacts') ||
    (attempt.worker &&
      !a.ops.some(
        (op) =>
          op.kind === 'stop-session' &&
          op.attemptId === attempt.id &&
          op.payload.sessionId === attempt.worker &&
          op.state === 'done',
      ))
  )
    throw new RoomRuleError('capture-not-settled');
  const capture = a.ops.find((op) => op.key === input.captureOp)!;
  if (capture.result?.sha !== input.sha || capture.result.tree !== input.tree)
    throw new RoomRuleError('capture-mismatch');
  const reason =
    input.sha !== attempt.baseSha && !input.descendantOfBase
      ? 'sha-before-base'
      : !input.inputsOk
        ? 'frozen-inputs-changed'
        : !input.artifactsCopied || !input.artifactHashesOk
          ? 'artifacts-invalid'
          : null;
  attempt.sha = input.sha;
  attempt.tree = input.tree;
  attempt.manifest.sha = input.sha;
  const { hash: _old, ...body } = attempt.manifest;
  attempt.manifest.hash = hash(body);
  attempt.receipt = {
    id: `rc-${String(++a.seq.receipt).padStart(4, '0')}`,
    attemptId: attempt.id,
    manifestHash: attempt.manifest.hash,
    sha: input.sha,
    criteriaVersion: attempt.criteriaVersion,
    valid: reason === null,
    reason,
    at: input.now,
  };
  transition(next, attempt, 'submitted', input.now, null, input.copyOp);
  if (attempt.worker)
    appendOp(next, 'close-session', attempt.id, { sessionId: attempt.worker }, input.now);
  if (reason)
    next = returnAttempt(next, {
      ...input,
      signature: failureSignature({ checks: [], criteria: [], reasons: [reason] }),
      reason,
    });
  return { plan: next, unchanged: input.tree === input.baseTree };
}

/** Qualitative results use specId `verifier:<zero-based criterion>`. */
export function recordCheck(
  plan: RoomPlan,
  input: Context & { attemptId: string; result: CheckResult; opKey: string },
): RoomPlan {
  const next = edit(plan, input),
    a = state(next),
    attempt = attemptOf(next, input.attemptId),
    result = input.result;
  requireRunning(next);
  const op = a.ops.find(
    (entry) =>
      entry.key === input.opKey &&
      entry.kind === 'check' &&
      entry.attemptId === attempt.id &&
      entry.state === 'done',
  );
  const integration = op?.payload.phase === 'integration';
  const integrationOp = currentIntegrationOp(next);
  if (
    !(integration ? ['queued', 'integrated'] : ['submitted', 'checking', 'accepted']).includes(
      attempt.status,
    ) ||
    !validReceipt(attempt)
  )
    throw new RoomRuleError('attempt-not-checkable');
  const stale = staleReason(next, attempt);
  if (stale) {
    supersede(next, attempt, input.now, stale);
    return next;
  }
  const spec = a.checks.find((entry) => entry.id === result.specId && entry.item === attempt.item);
  const criterion = /^verifier:(0|[1-9]\d*)$/.exec(result.specId)?.[1];
  const qualitative =
    criterion !== undefined &&
    a.coverage[attempt.item]?.[Number(criterion)]?.includes('verifier') &&
    result.by === (integration ? integrationVerifier(next) : attempt.verifier) &&
    result.by !== attempt.worker &&
    a.ops.some(
      (entry) =>
        entry.kind === 'launch' &&
        entry.state === 'done' &&
        entry.payload.sessionId === result.by &&
        (integration
          ? entry.payload.integrationOp === integrationOp?.key
          : entry.payload.phase !== 'integration'),
    );
  if (
    (!qualitative &&
      (!spec ||
        result.by !== ENGINE ||
        result.argvHash !== hash(spec.argv) ||
        result.envHash !== hash(spec.env))) ||
    !op ||
    (integration
      ? !integrationOp || op.payload.integrationOp !== integrationOp.key
      : op.payload.phase !== 'attempt') ||
    canonical(op.result?.checkResult) !== canonical(result) ||
    result.attemptId !== attempt.id ||
    result.sha !== (integration ? a.integration.candidateHead : attempt.sha) ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs < 0
  )
    throw new RoomRuleError('invalid check result');
  if (
    a.ops.some(
      (entry) =>
        entry.kind === 'check' &&
        entry.state === 'done' &&
        (entry.result?.checkResult as CheckResult | undefined)?.id === result.id &&
        canonical(entry.result?.checkResult) !== canonical(result),
    )
  )
    throw new RoomRuleError('check-conflict');
  if (attempt.checks.includes(result.id)) return next;
  if (attempt.status === 'accepted' || a.attempts.some((entry) => entry.checks.includes(result.id)))
    throw new RoomRuleError('check-conflict');
  attempt.checks.push(result.id);
  a.seq.check++;
  a.budget.spent.minutes += Math.ceil(result.durationMs / 60_000);
  transition(
    next,
    attempt,
    integration ? attempt.status : 'checking',
    input.now,
    null,
    input.opKey,
  );
  withinTime(next, integration ? attemptOf(next, a.integration.queue[0]!) : attempt, input.now);
  return next;
}
function coverage(
  plan: RoomPlan,
  attempt: PlanAttempt,
  sha: string,
  results: CheckResult[],
  verifiers: CheckResult[],
  recorded: boolean,
): string[] {
  const a = state(plan),
    item = itemOf(plan, attempt.item),
    gaps: string[] = [];
  const resumeIndex = a.ops.findLastIndex((op) => op.kind === 'resume');
  const persisted = (result: CheckResult | undefined): boolean =>
    !!result &&
    a.ops.some(
      (op, index) =>
        index > resumeIndex &&
        op.kind === 'check' &&
        op.attemptId === attempt.id &&
        op.state === 'done' &&
        op.payload.phase === (recorded ? 'attempt' : 'integration') &&
        (recorded || op.payload.integrationOp === currentIntegrationOp(plan)?.key) &&
        canonical(op.result?.checkResult) === canonical(result),
    );
  for (let criterion = 0; criterion < item.criteria.length; criterion++) {
    const required = a.coverage[item.id]?.[criterion] ?? [];
    const failed =
      required.length === 0 ||
      required.some((id) => {
        if (id === 'verifier') {
          const result = verifiers.findLast(
            (entry) =>
              entry.attemptId === attempt.id &&
              entry.specId === `verifier:${criterion}` &&
              entry.sha === sha &&
              attempt.checks.includes(entry.id),
          );
          return (
            !result ||
            !persisted(result) ||
            !result.inputsOk ||
            result.by !== (recorded ? attempt.verifier : integrationVerifier(plan)) ||
            result.by === attempt.worker ||
            result.verdict !== 'pass' ||
            !Number.isFinite(result.durationMs) ||
            result.durationMs < 0
          );
        }
        const spec = a.checks.find((entry) => entry.id === id && entry.item === item.id);
        const result = results.findLast(
          (entry) =>
            entry.attemptId === attempt.id &&
            entry.specId === id &&
            entry.sha === sha &&
            (!recorded || attempt.checks.includes(entry.id)),
        );
        return (
          !spec ||
          !result ||
          !persisted(result) ||
          result.by !== ENGINE ||
          result.argvHash !== hash(spec.argv) ||
          result.envHash !== hash(spec.env) ||
          !result.inputsOk ||
          result.verdict !== 'pass' ||
          !Number.isFinite(result.durationMs) ||
          result.durationMs < 0
        );
      });
    if (failed) gaps.push(`criterion:${criterion}`);
  }
  return gaps;
}
export function coverageVerdict(
  plan: RoomPlan,
  input: Context & { attemptId: string; results: CheckResult[]; verifiers: CheckResult[] },
): { plan: RoomPlan; accepted: boolean; reason: string | null; gaps: string[] } {
  const next = edit(plan, input),
    attempt = attemptOf(next, input.attemptId);
  requireRunning(next);
  if (
    !['submitted', 'checking', 'accepted'].includes(attempt.status) ||
    !validReceipt(attempt) ||
    !attempt.sha
  )
    throw new RoomRuleError('attempt-not-checkable');
  if (!withinTime(next, attempt, input.now))
    return { plan: next, accepted: false, reason: 'budget', gaps: [] };
  const stale = staleReason(next, attempt);
  if (stale) {
    supersede(next, attempt, input.now, stale);
    return { plan: next, accepted: false, reason: stale, gaps: [] };
  }
  const gaps = coverage(next, attempt, attempt.sha, input.results, input.verifiers, true);
  if (attempt.manifest?.coverage !== 'covered' || attempt.manifest.gaps.length)
    gaps.push('manifest:coverage');
  if (gaps.length) return { plan: next, accepted: false, reason: 'coverage-incomplete', gaps };
  if (attempt.status !== 'accepted') transition(next, attempt, 'accepted', input.now);
  return { plan: next, accepted: true, reason: null, gaps: [] };
}
export function enqueue(plan: RoomPlan, input: Context & { attemptId: string }): RoomPlan {
  const next = edit(plan, input),
    attempt = attemptOf(next, input.attemptId),
    a = state(next);
  requireRunning(next);
  if ((attempt.status !== 'accepted' && attempt.status !== 'queued') || !validReceipt(attempt))
    throw new RoomRuleError('attempt-not-accepted');
  if (!withinTime(next, attempt, input.now)) return next;
  const stale = staleReason(next, attempt);
  if (stale) {
    supersede(next, attempt, input.now, stale);
    return next;
  }
  if (!a.integration.queue.includes(attempt.id)) a.integration.queue.push(attempt.id);
  if (attempt.status !== 'queued') transition(next, attempt, 'queued', input.now);
  recalculate(next);
  return next;
}
export function integrate(
  plan: RoomPlan,
  input: Context & {
    attemptId: string;
    opKey: string;
    results: CheckResult[];
    verifiers: CheckResult[];
  },
): RoomPlan {
  const next = edit(plan, input),
    a = state(next),
    attempt = attemptOf(next, input.attemptId),
    i = a.integration;
  requireRunning(next);
  if (
    attempt.status !== 'queued' ||
    !validReceipt(attempt) ||
    i.queue[0] !== attempt.id ||
    i.suspended ||
    !i.candidateHead
  )
    throw new RoomRuleError('integration-not-ready');
  if (!withinTime(next, attempt, input.now)) return next;
  const stale = staleReason(next, attempt);
  if (stale) {
    supersede(next, attempt, input.now, stale);
    return next;
  }
  const op = a.ops.find(
    (entry) =>
      entry.key === input.opKey &&
      ['merge', 'noop-integration'].includes(entry.kind) &&
      entry.state === 'done' &&
      entry.attemptId === attempt.id &&
      entry.result?.sha === i.candidateHead &&
      entry.payload.verifiedHead === i.verifiedHead,
  );
  if (!op) throw new RoomRuleError('candidate-not-confirmed');
  const checked = [
    attempt,
    ...a.attempts.filter(
      (entry) =>
        entry.status === 'integrated' &&
        itemOf(next, entry.item).status === 'verified' &&
        entry ===
          a.attempts.findLast(
            (current) => current.item === entry.item && current.status === 'integrated',
          ),
    ),
  ];
  if (
    checked.some(
      (entry) =>
        coverage(next, entry, i.candidateHead!, input.results, input.verifiers, false).length,
    )
  )
    throw new RoomRuleError('integration-coverage-incomplete');
  for (const result of [...input.results, ...input.verifiers]) {
    const owner = checked.find((entry) => entry.id === result.attemptId);
    if (owner && !owner.checks.includes(result.id)) {
      owner.checks.push(result.id);
      a.seq.check++;
      a.budget.spent.minutes += Math.ceil(result.durationMs / 60_000);
    }
  }
  if (!withinTime(next, attempt, input.now)) return next;
  i.verifiedHead = i.candidateHead;
  i.candidateHead = null;
  i.queue.shift();
  transition(next, attempt, 'integrated', input.now, null, op.key);
  const item = itemOf(next, attempt.item);
  item.evidence = {
    text: `sha=${attempt.sha}; verifiedHead=${i.verifiedHead}; criteriaVersion=${attempt.criteriaVersion}; receipt=${attempt.receipt?.id}; checks=${[...input.results, ...input.verifiers].map((entry) => entry.id).join(',')}`,
    artifacts: attempt.manifest?.artifacts.map((artifact) => artifact.storedAs) ?? [],
  };
  itemStatus(item, 'verified', input.now);
  recalculate(next);
  return next;
}

export function failureSignature(input: {
  checks: Pick<CheckResult, 'specId' | 'verdict'>[];
  criteria: { criterion: number; verdict: CheckResult['verdict'] }[];
  reasons: string[];
}): string {
  return hash({
    checks: input.checks.map((entry) => `${entry.specId}:${entry.verdict}`).sort(),
    criteria: input.criteria.map((entry) => `${entry.criterion}:${entry.verdict}`).sort(),
    reasons: input.reasons.map((reason) => reason.trim().replace(/\s+/g, ' ').toLowerCase()).sort(),
  });
}
export function returnAttempt(
  plan: RoomPlan,
  input: Context & { attemptId: string; signature: string; reason: string },
): RoomPlan {
  const next = edit(plan, input),
    a = state(next),
    attempt = attemptOf(next, input.attemptId);
  if (!['submitted', 'checking', 'accepted', 'queued', 'returned'].includes(attempt.status))
    throw new RoomRuleError('attempt-not-returnable');
  if (attempt.status === 'returned') {
    if (attempt.failureSignature !== input.signature) throw new RoomRuleError('attempt-conflict');
    return next;
  }
  if (a.integration.queue[0] === attempt.id && a.integration.candidateHead) {
    appendOp(next, 'merge-abort', attempt.id, { sha: a.integration.verifiedHead }, input.now);
    a.integration.candidateHead = null;
  }
  a.integration.queue = a.integration.queue.filter((id) => id !== attempt.id);
  if (a.integration.suspended?.attemptId === attempt.id) a.integration.suspended = null;
  attempt.failureSignature = input.signature;
  transition(next, attempt, 'returned', input.now, input.reason);
  stopSessions(next, attempt, input.now);
  const item = itemOf(next, attempt.item);
  item.evidence = null;
  itemStatus(item, 'returned', input.now, input.reason);
  const previous = a.attempts
    .filter((entry) => entry.item === attempt.item && entry.n < attempt.n)
    .at(-1);
  if (
    previous?.failureSignature === input.signature ||
    attempt.n >= a.budget.limits.attemptsPerItem
  ) {
    transition(next, attempt, 'blocked', input.now, input.reason);
    itemStatus(item, 'blocked', input.now, input.reason);
    haltDraft(
      next,
      previous?.failureSignature === input.signature ? 'no_progress' : 'budget',
      input.reason,
      input.now,
    );
  }
  recalculate(next);
  return next;
}
export function suspend(
  plan: RoomPlan,
  input: Context & { attemptId: string; reason: string },
): RoomPlan {
  const next = edit(plan, input),
    i = state(next).integration;
  attemptOf(next, input.attemptId);
  i.suspended = { reason: input.reason, attemptId: input.attemptId, at: input.now };
  if (i.candidateHead) {
    appendOp(next, 'merge-abort', input.attemptId, { sha: i.verifiedHead }, input.now);
    i.candidateHead = null;
  }
  recalculate(next);
  return next;
}
function invalidate(plan: RoomPlan, roots: number[], now: string, includeRoots: boolean): void {
  const affected = new Set(roots);
  for (const id of roots) itemOf(plan, id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of plan.items)
      if (!affected.has(item.id) && item.after.some((id) => affected.has(id))) {
        affected.add(item.id);
        grew = true;
      }
  }
  if (!includeRoots) for (const id of roots) affected.delete(id);
  for (const attempt of state(plan).attempts)
    if (
      affected.has(attempt.item) &&
      (!terminal.has(attempt.status) || attempt.status === 'integrated')
    )
      supersede(plan, attempt, now, 'evidence-invalidated');
  for (const id of affected) {
    const item = itemOf(plan, id);
    item.evidence = null;
    itemStatus(item, 'waiting', now, 'evidence-invalidated');
  }
  recalculate(plan);
}
function clearCompletion(room: Room, plan: RoomPlan): Room {
  if (room.id !== plan.roomId) throw new RoomRuleError('wrong plan room');
  const next = structuredClone(room);
  if (next.proposal?.kind === 'completion') next.proposal = null;
  return next;
}
export function supersedeByAmendment(
  plan: RoomPlan,
  room: Room,
  input: Context & { changedItems: number[] },
): { plan: RoomPlan; room: Room } {
  const next = edit(plan, input),
    a = state(next);
  for (const id of new Set(input.changedItems)) {
    itemOf(next, id);
    const version = a.criteriaVersion[id];
    if (!version || !Number.isSafeInteger(version + 1))
      throw new RoomRuleError('invalid criteria version');
    a.criteriaVersion[id] = version + 1;
  }
  next.rev++;
  invalidate(next, input.changedItems, input.now, true);
  return { plan: next, room: clearCompletion(room, next) };
}
export function lateDefect(
  plan: RoomPlan,
  room: Room,
  input: Context & { attemptId: string; reason: string },
): { plan: RoomPlan; room: Room } {
  const next = edit(plan, input),
    attempt = attemptOf(next, input.attemptId),
    item = itemOf(next, attempt.item);
  if (attempt.status !== 'integrated' || item.status !== 'verified')
    throw new RoomRuleError('verified attempt required');
  item.evidence = null;
  itemStatus(item, 'returned', input.now, `${input.reason}; attempt=${attempt.id}`);
  invalidate(next, [item.id], input.now, false);
  return { plan: next, room: clearCompletion(room, next) };
}
export function halt(
  plan: RoomPlan,
  input: Context & { reason: NonNullable<AutonomousPlan['halted']>['reason']; detail: string },
): RoomPlan {
  const next = edit(plan, input);
  haltDraft(next, input.reason, input.detail, input.now);
  return next;
}

export function reconcileAfterRestart(
  plan: RoomPlan,
  input: Context & {
    observations: { key: string; outcome: 'done' | 'failed'; result: Record<string, unknown> }[];
    integrationHead: { sha: string; parents: string[]; opKey: string | null };
  },
): RoomPlan {
  let next = edit(plan, input);
  const a = state(next),
    i = a.integration;
  const candidateOp = a.ops.findLast(
    (op) =>
      ['merge', 'noop-integration'].includes(op.kind) &&
      op.state !== 'failed' &&
      op.attemptId === i.queue[0],
  );
  const candidateAttempt = candidateOp?.attemptId ? attemptOf(next, candidateOp.attemptId) : null;
  const confirmed =
    !!candidateOp &&
    !!candidateAttempt &&
    candidateOp.payload.verifiedHead === i.verifiedHead &&
    (candidateOp.kind === 'noop-integration'
      ? input.integrationHead.sha === i.verifiedHead
      : input.integrationHead.opKey === candidateOp.key &&
        canonical(input.integrationHead.parents) ===
          canonical([i.verifiedHead, candidateAttempt.sha]));
  for (const op of a.ops.filter((entry) => entry.state === 'intended')) {
    const observed = input.observations.find((entry) => entry.key === op.key);
    const outcome =
      op.kind === 'check'
        ? 'failed'
        : op === candidateOp
          ? confirmed
            ? 'done'
            : 'failed'
          : (observed?.outcome ?? 'failed');
    next = settleOp(next, {
      ...input,
      key: op.key,
      outcome,
      result:
        op === candidateOp && confirmed
          ? { sha: input.integrationHead.sha }
          : (observed?.result ?? { reason: 'restart-unconfirmed' }),
    });
  }
  const integration = state(next).integration;
  integration.candidateHead = confirmed ? input.integrationHead.sha : null;
  if (!confirmed && (i.candidateHead || input.integrationHead.sha !== i.verifiedHead))
    appendOp(next, 'merge-abort', i.queue[0] ?? null, { sha: i.verifiedHead }, input.now);
  for (const attempt of state(next).attempts) {
    if (
      ['starting', 'running', 'checking'].includes(attempt.status) ||
      (attempt.status === 'submitted' && !validReceipt(attempt))
    ) {
      transition(next, attempt, 'aborted', input.now, 'restart');
      stopSessions(next, attempt, input.now);
      itemStatus(itemOf(next, attempt.item), 'returned', input.now, 'restart');
    }
  }
  haltDraft(next, 'restart', 'Host restarted; explicit resume required', input.now);
  return next;
}
export function resume(plan: RoomPlan, input: Context & { requestedBy: string }): RoomPlan {
  const next = edit(plan, input),
    a = state(next);
  if (input.requestedBy !== HUMAN) throw new RoomRuleError('only a human can resume');
  if (!a.halted) throw new RoomRuleError('plan-not-halted');
  appendOp(next, 'resume', null, { requestedBy: HUMAN }, input.now);
  a.halted = null;
  recalculate(next);
  return next;
}
