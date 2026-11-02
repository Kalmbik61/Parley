import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  ENGINE, HUMAN, addMember, cancelRoomPlan, coverageVerdict, enqueue, failureSignature, halt, intendOp,
  liveLead, parleyNote, planItemsComplete, proposeCompletion, PROPOSAL_TEXT_MAX, PlanConflictError, ProposalConflictError, RoomRuleError, readMap, receipt, reconcileAfterRestart, recordCheck, resolveProposal,
  integrate, isGitRoot, normalizeAttemptSubmission, returnAttempt, settleOp, startAttempt, submitAttempt, supersedeByAmendment, updateMap, workPaths,
  type AutonomousOp, type CheckResult, type HandoffManifest, type LetterTx, type PlanAttempt,
  type RoomPlan, type WorkMap,
} from '@parley/core';
import {
  attemptsEngineGitPath, notGitRepositoryMessage, type AttemptsEngine, type AttemptsProposal, type AttemptsResult,
} from '../agent/attempts-endpoint.js';
import type { CreateSessionInput, SessionsService } from '../sessions/sessions-service.js';
import type { WorksService } from '../works/works-service.js';
import { run } from './check-runner.js';

export interface EngineIO {
  readMap: typeof readMap;
  updateMap: typeof updateMap;
  sessions: Pick<SessionsService, 'create' | 'launch' | 'stop' | 'close'>;
  runner: typeof run;
  git(args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<Buffer>;
  fs: Pick<typeof filesystem, 'mkdir' | 'stat' | 'lstat' | 'realpath' | 'readFile' | 'writeFile' | 'rm'>;
  now(): Date;
  sleep(ms: number): Promise<unknown>;
}
export interface AutonomousEngineOptions {
  provider: string;
  model?: string;
  verifier: { provider: string; model?: string };
  works?: Pick<WorksService, 'snapshot' | 'onChange'>;
  onFailure?(error: unknown): void;
}
export interface AutonomousEngine extends AttemptsEngine {
  start(): void;
  stop(): Promise<void>;
  flush(projectPath: string, workId: string): Promise<void>;
  cancel(input: { projectPath: string; workId: string; planId: string; rev: number }): Promise<void>;
}
const exec = promisify(execFile);
export function autonomousEngineIO(sessions: EngineIO['sessions']): EngineIO {
  return {
    readMap, updateMap, sessions, runner: run, fs: filesystem, now: () => new Date(), sleep,
    git: async (args, options) => (await exec('git', args, { ...options, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout,
  };
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  : JSON.stringify(value)!;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const context = (plan: RoomPlan, at: string) => ({ actor: ENGINE, rev: plan.rev, now: at });
// Папки рантайма агентов только в корне репозитория: pathspec не трогает записи базы и вложенные одноимённые папки.
const CAPTURE_EXCLUDED = ['.omc', '.omx', '.claude', '.codex', '.agents', '.parley-tmp'] as const;
const fenced = new Set(['returned', 'blocked', 'aborted', 'superseded']);
const active = (plan: RoomPlan) => plan.mode === 'autonomous' && plan.acceptedAt !== null && ['active', 'completing'].includes(plan.status) && !!plan.autonomous;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const denied = (error: unknown): AttemptsResult => ({ ok: false, error: { code: errorText(error), message: errorText(error) } });
const attemptOf = (plan: RoomPlan, id: string) => {
  const attempt = plan.autonomous!.attempts.find(row => row.id === id);
  if (!attempt) throw new Error('attempt-not-found');
  return attempt;
};
// Shared by every engine instance in this host process: sandbox log windows cannot overlap.
let checkQueue: Promise<unknown> = Promise.resolve();
function serialCheck<T>(effect: () => Promise<T>): Promise<T> {
  const result = checkQueue.then(effect, effect);
  checkQueue = result.catch(() => {});
  return result;
}
interface WorkState {
  tail: Promise<unknown>;
  scheduled: boolean;
  recovering: Set<string>;
  recoveryFailures: number;
  retryAt: number;
}
interface Location { projectPath: string; workId: string; planId: string }
class NoEngineChange extends Error {}

type AutonomousState = NonNullable<RoomPlan['autonomous']>;
/** Halt detail with the current summary of attempts and ops; `change()` rewrites it for a halted plan on every edit. */
function haltedDetail(a: AutonomousState): string {
  const halted = a.halted!;
  const attempts = a.attempts.map(row => `item ${row.item}/${row.id}: ${row.status}`).join(', ') || 'no attempts';
  const done = a.ops.filter(op => op.state === 'done').map(op => op.key).join(', ') || 'none';
  const pending = a.ops.filter(op => op.state === 'intended').map(op => `${op.key} ${op.kind}`).join(', ') || 'none';
  return halted.detail.split('\nReason:')[0] + `\nReason: ${halted.reason}; ${attempts}.\nDone: ${done}; verifiedHead=${a.integration.verifiedHead}.\nWaiting: ${pending}; explicit human resume required.`;
}

/** Runs inside the caller's single updateMap transaction, before any effects. */
export function resolveAutonomousProposal(
  map: WorkMap, letters: LetterTx, roomId: string, proposalId: string, action: 'accept' | 'return',
  options: Parameters<typeof resolveProposal>[5], now = new Date().toISOString(),
): string {
  const room = map.rooms.find(row => row.id === roomId);
  const proposal = room?.proposal as AttemptsProposal | null | undefined;
  const amendment = proposal?.autonomousAmendment;
  if (action === 'return' && proposal?.kind === 'completion' && map.plans?.some(plan => plan.id === proposal.planId && plan.mode === 'autonomous')) {
    if (proposal.id !== proposalId || options?.rev !== proposal.rev || options?.planId !== proposal.planId || options?.planRev !== proposal.planRev)
      throw new ProposalConflictError('plan identity/revision must match the displayed proposal');
    throw new RoomRuleError('autonomous-completion-needs-item: select an item to return');
  }
  if (action !== 'accept' || !amendment) return resolveProposal(map, letters, roomId, proposalId, action, options, now).messageId;
  // Validate the exact card the human saw before changing either revision.
  if (proposal!.id !== proposalId || options?.rev !== proposal!.rev || options?.planId !== proposal!.plan?.id || options?.planRev !== proposal!.plan?.rev) throw new ProposalConflictError('plan identity/revision must match the displayed proposal');
  const index = map.plans?.findIndex(row => row.id === amendment.planId) ?? -1;
  const old = map.plans?.[index];
  if (!old || old.rev !== amendment.rev || !active(old))
    return resolveProposal(map, letters, roomId, proposalId, 'return', { ...options, note: 'Amendment revision changed; propose it again against the current plan.' }, now).messageId;
  if (!proposal!.plan || !room) throw new PlanConflictError();
  const semantics = (item: RoomPlan['items'][number]) => canonical([item.title, item.owner, item.scope, item.after, item.criteria, item.verifier]);
  const specs = (plan: RoomPlan, item: number, checks = plan.autonomous!.checks, coverage = plan.autonomous!.coverage) => {
    const ids = new Set(Object.values(coverage[item] ?? {}).flat().filter(id => id !== 'verifier'));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the key is destructured only to drop it from the copy
    return canonical(checks.filter(row => ids.has(row.id)).map(({ frozenAt: _frozenAt, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id)));
  };
  const changedItems = old.items.filter(item => {
    const proposed = proposal!.plan!.items.find(row => row.id === item.id);
    return !proposed || semantics(item) !== semantics(proposed) ||
      canonical(old.autonomous!.coverage[item.id]) !== canonical(amendment.draft.coverage[item.id]) ||
      specs(old, item.id) !== specs(old, item.id, amendment.checks, amendment.draft.coverage);
  }).map(item => item.id);
  const fenced = supersedeByAmendment(old, room, { ...context(old, now), changedItems });
  map.plans![index] = fenced.plan;
  map.rooms[map.rooms.indexOf(room)] = fenced.room;
  const pending = fenced.room.proposal as AttemptsProposal;
  const proposed = pending.plan!;
  // Supersession and acceptance each advance rev once; runtime history is retained.
  proposed.rev = fenced.plan.rev + 1;
  proposed.autonomous = structuredClone(fenced.plan.autonomous!);
  proposed.autonomous.checks = structuredClone(amendment.checks);
  proposed.autonomous.coverage = structuredClone(amendment.draft.coverage);
  proposed.autonomous.budget.limits = structuredClone(amendment.draft.budget);
  proposed.autonomous.criteriaVersion = Object.fromEntries(proposed.items.map(item => [item.id, fenced.plan.autonomous!.criteriaVersion[item.id] ?? 1]));
  pending.planRev = proposed.rev;
  return resolveProposal(map, letters, roomId, proposalId, action, { ...options, planRev: proposed.rev }, now).messageId;
}

/** Durable rule transactions precede all effects. Integration and resume are separate stages. */
export function createAutonomousEngine(io: EngineIO, options: AutonomousEngineOptions): AutonomousEngine {
  const states = new Map<string, WorkState>();
  let stopped = false;
  let started = options.works === undefined;
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const at = () => io.now().toISOString();
  function state(projectPath: string, workId: string): WorkState {
    const key = `${projectPath}\0${workId}`;
    let value = states.get(key);
    if (!value) { value = { tail: Promise.resolve(), scheduled: false, recovering: new Set(), recoveryFailures: 0, retryAt: 0 }; states.set(key, value); }
    return value;
  }
  function exclusive<T>(projectPath: string, workId: string, effect: () => Promise<T>): Promise<T> {
    const current = state(projectPath, workId);
    const execute = () => { if (stopped) throw new Error('engine-stopped'); return effect(); };
    const result = current.tail.then(execute, execute);
    current.tail = result;
    // Observe rejection without turning the durable recovery barrier into a successful tail.
    void result.catch(() => {});
    return result;
  }
  const recovering = (projectPath: string, workId: string) => !started || state(projectPath, workId).recovering.size > 0;
  function requireRecovered(projectPath: string, workId: string) {
    if (recovering(projectPath, workId)) throw new Error('engine-recovering');
  }
  async function load(loc: Location): Promise<RoomPlan> {
    const map = await io.readMap(loc.projectPath, loc.workId);
    const plan = map.plans?.find(row => row.id === loc.planId);
    if (!plan || !active(plan)) throw new Error('plan-unavailable');
    return plan;
  }
  async function change(loc: Location, edit: (plan: RoomPlan, map: WorkMap, letters: LetterTx) => RoomPlan): Promise<RoomPlan> {
    let changed!: RoomPlan;
    try { await io.updateMap(loc.projectPath, loc.workId, (map, letters) => {
      const before = JSON.stringify(map);
      // Letters live outside the map JSON: count them too, or a letter-only edit would be rolled back as a no-op.
      const lettersBefore = letters.count({});
      const index = map.plans?.findIndex(row => row.id === loc.planId) ?? -1;
      if (index < 0 || !active(map.plans![index]!)) throw new Error('plan-unavailable');
      changed = edit(map.plans![index]!, map, letters);
      const a = changed.autonomous!;
      if (a.halted) a.halted.detail = haltedDetail(a);
      map.plans![index] = changed;
      if (JSON.stringify(map) === before && letters.count({}) === lettersBefore) throw new NoEngineChange();
    }); } catch (error) { if (!(error instanceof NoEngineChange)) throw error; }
    return changed;
  }
  const directory = (loc: Location, attemptId: string) => path.join(workPaths(loc.projectPath, loc.workId).dir, 'autonomous', loc.planId, 'attempts', attemptId);
  const cloneDirectory = (loc: Location, attemptId: string) => path.join(directory(loc, attemptId), 'clone');
  const artifactPath = (loc: Location, attemptId: string, index: number, sha: string) => path.join(directory(loc, attemptId), 'artifacts', `${index}-${sha}`);
  async function exists(file: string): Promise<boolean> {
    try { await io.fs.stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  // No inherited git variables, global config, executable hooks, fsmonitor or signing.
  async function git(loc: Location, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    const home = path.join(workPaths(loc.projectPath, loc.workId).dir, 'autonomous', loc.planId, 'git-home');
    const hooks = path.join(home, 'empty-hooks');
    return io.git(['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Parley engine', GIT_AUTHOR_EMAIL: 'engine@parley.local', GIT_COMMITTER_NAME: 'Parley engine', GIT_COMMITTER_EMAIL: 'engine@parley.local', ...extra },
    });
  }
  const bare = (loc: Location, args: string[], env?: NodeJS.ProcessEnv) => git(loc, [`--git-dir=${attemptsEngineGitPath(loc.projectPath, loc.workId)}`, ...args], env);
  const text = async (loc: Location, args: string[]) => (await bare(loc, args)).toString('utf8').trim();
  async function refSha(loc: Location, ref: string): Promise<string | null> {
    try { await bare(loc, ['show-ref', '--verify', '--quiet', ref]); }
    catch (error) { if ((error as { code?: unknown }).code === 1) return null; throw error; }
    return text(loc, ['rev-parse', '--verify', ref]);
  }
  function sessionLabel(loc: Location, attemptId: string, op: AutonomousOp) { return `${loc.planId}/${attemptId}/${op.payload.role}/${op.key}`; }
  const commitMessage = (loc: Location, op: AutonomousOp) => `${loc.planId} ${op.key} ${op.attemptId}`;
  const attemptRef = (loc: Location, attemptId: string) => `refs/attempts/${loc.planId}/${attemptId}`;
  const candidateRef = (loc: Location, attemptId: string) => `refs/candidates/${loc.planId}/${attemptId}`;
  async function intend(loc: Location, kind: AutonomousOp['kind'], attemptId: string | null, payload: Record<string, unknown>): Promise<AutonomousOp> {
    const plan = await change(loc, current => intendOp(current, { ...context(current, at()), kind, attemptId, payload }));
    return plan.autonomous!.ops.at(-1)!;
  }
  async function settled(loc: Location, op: AutonomousOp, outcome: 'done' | 'failed', result: Record<string, unknown>) {
    return change(loc, (plan, map, letters) => {
      const next = settleOp(plan, { ...context(plan, at()), key: op.key, outcome, result });
      if (op.kind === 'create-session' && outcome === 'done') joinCreated(map, letters, next, String(result.sessionId));
      return next;
    });
  }
  function joinCreated(map: WorkMap, letters: LetterTx, plan: RoomPlan, sessionId: string) {
    const room = map.rooms.find(row => row.id === plan.roomId)!;
    const session = map.sessions.find(row => row.id === sessionId);
    if (session && session.lifecycle !== 'closed' && !room.members.includes(sessionId)) addMember(map, letters, room.id, sessionId, at());
  }
  async function effect(loc: Location, op: AutonomousOp, execute: () => Promise<Record<string, unknown>>): Promise<AutonomousOp> {
    if (op.state !== 'intended') return op;
    if (stopped) throw new Error('engine-stopped');
    if (!['stop-session', 'close-session', 'merge-abort', 'cleanup'].includes(op.kind)) requireRecovered(loc.projectPath, loc.workId);
    const latest = await load(loc);
    const cancelling = latest.autonomous!.halted?.detail.startsWith('cancelled by human');
    const cancellationCleanup = cancelling && op.kind === 'cleanup' && op.payload.purpose === 'cancellation';
    if (latest.autonomous!.halted && !['stop-session', 'close-session'].includes(op.kind) && !cancellationCleanup) throw new Error('plan-halted');
    if (!['stop-session', 'close-session', 'merge-abort', 'cleanup'].includes(op.kind) &&
      op.attemptId && fenced.has(attemptOf(latest, op.attemptId).status)) {
      await settled(loc, op, 'failed', { reason: 'attempt-fenced' });
      throw new Error('attempt-fenced');
    }
    let result: Record<string, unknown>;
    try { result = await execute(); }
    catch (error) {
      await settled(loc, op, 'failed', { reason: errorText(error) });
      if (errorText(error) !== 'integration-conflict') await change(loc, plan => halt(plan, { ...context(plan, at()), reason: cancelling ? 'human' : errorText(error).includes('confinement-unavailable') ? 'confinement' : /resource|limit|budget|denied/i.test(errorText(error)) ? 'budget' : 'human', detail: `${cancelling ? 'cancelled by human: ' : ''}${op.kind}: ${errorText(error)}` }));
      throw error;
    }
    // A crash/failing write here leaves the original intention for startup reconciliation.
    const plan = await settled(loc, op, 'done', result);
    return plan.autonomous!.ops.find(row => row.key === op.key)!;
  }
  async function sessionOperation(loc: Location, op: AutonomousOp): Promise<void> {
    const sessionId = String(op.payload.sessionId);
    const map = await io.readMap(loc.projectPath, loc.workId);
    const session = map.sessions.find(row => row.id === sessionId);
    await effect(loc, op, async () => {
      if (session && (op.kind === 'close-session' ? session.lifecycle !== 'closed' : ['active', 'pending', 'closing'].includes(session.lifecycle))) {
        const ref = { projectPath: loc.projectPath, workId: loc.workId, sessionId };
        if (op.kind === 'close-session') await io.sessions.close(ref); else await io.sessions.stop(ref);
      }
      return { sessionId };
    });
  }
  async function drainSessions(loc: Location) {
    const plan = await load(loc);
    for (const op of plan.autonomous!.ops.filter(row => row.state === 'intended' && ['stop-session', 'close-session'].includes(row.kind))) {
      if (stopped) return;
      await sessionOperation(loc, op);
    }
  }
  async function reservedTemporaryPath(loc: Location, sha: string, project = false): Promise<boolean> {
    const args = ['ls-tree', sha, '--', '.parley-tmp'];
    const tracked = project ? await git(loc, ['-C', loc.projectPath, ...args]) : await bare(loc, args);
    if (!tracked.length) return false;
    await change(loc, plan => halt(plan, { ...context(plan, at()), reason: 'human', detail: 'reserved path .parley-tmp is tracked' }));
    return true;
  }
  async function initialize(loc: Location): Promise<void> {
    const plan = await load(loc);
    const previous = plan.autonomous!.ops.find(row => row.kind === 'clone' && row.payload.purpose === 'engine' && row.state !== 'failed');
    if (previous?.state === 'done') return;
    try {
      if (await reservedTemporaryPath(loc, plan.autonomous!.integration.baseSha, true)) return;
    } catch (error) {
      // This project git call runs outside effect(); without a halt here the poll would retry the same failure forever.
      const detail = await isGitRoot(loc.projectPath) ? `clone: ${errorText(error)}` : notGitRepositoryMessage(loc.projectPath);
      await change(loc, current => halt(current, { ...context(current, at()), reason: 'human', detail }));
      return;
    }
    const op = previous ?? await intend(loc, 'clone', null, { purpose: 'engine', baseSha: plan.autonomous!.integration.baseSha, branch: plan.autonomous!.integration.branch });
    await effect(loc, op, async () => {
      const repo = attemptsEngineGitPath(loc.projectPath, loc.workId), integration = plan.autonomous!.integration;
      await io.fs.mkdir(path.dirname(repo), { recursive: true });
      if (!await exists(repo)) await git(loc, ['init', '--bare', repo]);
      await bare(loc, ['fetch', '--no-tags', '--', loc.projectPath, integration.baseSha]);
      await bare(loc, ['update-ref', `refs/heads/${integration.branch}`, integration.baseSha]);
      return { sha: integration.baseSha };
    });
  }
  async function workerBrief(loc: Location, plan: RoomPlan, attempt: PlanAttempt): Promise<string> {
    const a = plan.autonomous!, item = plan.items.find(row => row.id === attempt.item)!;
    const dependencies = item.after.map(id => a.attempts.findLast(row => row.item === id)!).filter(row => row && ['accepted', 'queued', 'integrated'].includes(row.status));
    const previous = a.attempts.filter(row => row.item === item.id && row.n < attempt.n);
    const integrationFailures = await Promise.all(a.ops.filter(op => ['merge', 'noop-integration'].includes(op.kind) && previous.some(row => row.id === op.attemptId)).map(async op => {
      const results = a.ops.filter(row => row.kind === 'check' && row.payload.integrationOp === op.key && row.state === 'done').map(row => row.result?.checkResult as CheckResult).filter(Boolean);
      return { attemptId: op.attemptId, candidateHead: op.result?.sha, checks: results.map(result => ({ ...result, item: a.attempts.find(row => row.id === result.attemptId)?.item })),
        diff: typeof op.result?.sha === 'string' ? await text(loc, ['diff', '--no-ext-diff', '--no-textconv', `${op.payload.verifiedHead}..${op.result.sha}`]) : null,
        tails: await outputTails(loc, results) };
    }));
    const tails = await outputTails(loc, previous.flatMap(row => thisResults(plan, row)));
    return [
      `Goal: ${plan.goal}`, `Attempt: ${attempt.id}; plan ${plan.id} rev ${plan.rev}; baseSha ${attempt.baseSha}`,
      `Item: ${item.id} ${item.title}; scope: ${item.scope}`, `Criteria version ${attempt.criteriaVersion}: ${JSON.stringify(item.criteria)}`,
      `Accepted dependencies (use these attempt IDs in dependsOn): ${JSON.stringify(dependencies.map(row => ({ attemptId: row.id, facts: row.manifest?.facts, artifacts: row.manifest?.artifacts })))}`,
      `Previous attempts: ${JSON.stringify(previous.map(row => ({ manifest: row.manifest, failure: row.failureSignature, checks: thisResults(plan, row) })))}`,
      `Previous check output tails: ${JSON.stringify(tails)}`,
      `Previous integration failures (candidate-wide checks, owner items and diff): ${JSON.stringify(integrationFailures)}`,
      `Frozen inputs: ${JSON.stringify(a.checks.filter(row => row.item === item.id).flatMap(row => row.inputs))}`,
      'Work only inside the clone. Do not modify git or write outside the clone. Submit only through attempt_submit.',
      'Manifest: {version:1,criteriaVersion,dependsOn,coverage:"covered"|"partial"|"failed"|"unstarted",scope,facts:[],hypotheses:[],notFound:[],gaps:[],text (<=4096),artifacts:[{path,sha256,storedAs:""}],hash,submittedAt}. The engine captures sha and copies artifacts.',
    ].join('\n');
  }
  function nextCheckId(plan: RoomPlan): string {
    const a = plan.autonomous!;
    const allocated = a.ops.flatMap(op => [op.payload.resultId, (op.result?.checkResult as CheckResult | undefined)?.id]);
    const sequence = Math.max(a.seq.check, ...allocated.map(id => typeof id === 'string' && /^ck-\d+$/.test(id) ? Number(id.slice(3)) : 0));
    return `ck-${String(sequence + 1).padStart(4, '0')}`;
  }
  function thisResults(plan: RoomPlan, attempt: PlanAttempt): CheckResult[] {
    return plan.autonomous!.ops.filter(op => op.kind === 'check' && op.state === 'done' && op.attemptId === attempt.id)
      .map(op => op.result?.checkResult as CheckResult).filter(row => row && attempt.checks.includes(row.id));
  }
  async function prepareReview(loc: Location, plan: RoomPlan, creation: AutonomousOp, attempts: PlanAttempt[], base: string, sha: string, results: CheckResult[]): Promise<string> {
    const dir = path.join(directory(loc, creation.attemptId!), 'review', creation.key);
    const previous = plan.autonomous!.ops.find(op => op.kind === 'clone' && op.payload.purpose === 'review' && op.payload.createOp === creation.key && op.state !== 'failed');
    const op = previous ?? await intend(loc, 'clone', creation.attemptId, { purpose: 'review', createOp: creation.key, dir, sha });
    await effect(loc, op, async () => {
      await io.fs.mkdir(dir, { recursive: true });
      await io.fs.mkdir(path.join(dir, '.parley-tmp'), { recursive: true });
      const diff = await bare(loc, ['diff', '--no-ext-diff', '--no-textconv', `${base}..${sha}`]);
      await io.fs.writeFile(path.join(dir, 'diff.patch'), diff);
      await io.fs.writeFile(path.join(dir, 'manifests.json'), JSON.stringify(attempts.map(attempt => ({ id: attempt.id, item: attempt.item, manifest: attempt.manifest })), null, 2));
      await io.fs.writeFile(path.join(dir, 'criteria.json'), JSON.stringify(attempts.map(attempt => ({ id: attempt.id, criteriaVersion: attempt.criteriaVersion, criteria: plan.items.find(item => item.id === attempt.item)!.criteria, coverage: plan.autonomous!.coverage[attempt.item] })), null, 2));
      await io.fs.writeFile(path.join(dir, 'checks.json'), JSON.stringify({ results, tails: await outputTails(loc, results) }, null, 2));
      for (const attempt of attempts) {
        const artifacts = path.join(dir, 'artifacts', attempt.id);
        await io.fs.mkdir(artifacts, { recursive: true });
        for (const [index, artifact] of (attempt.manifest?.artifacts ?? []).entries()) {
          await io.fs.writeFile(path.join(artifacts, `${index}-${artifact.sha256}`), await artifactBytes(artifactPath(loc, attempt.id, index, artifact.sha256)));
        }
      }
      return { dir, sha };
    });
    return dir;
  }
  async function spawn(loc: Location, attemptId: string, role: 'worker' | 'verifier'): Promise<void> {
    let plan = await load(loc), attempt = attemptOf(plan, attemptId);
    if (role === 'verifier' && !['codex', 'claude'].includes(options.verifier.provider)) {
      await change(loc, current => halt(current, { ...context(current, at()), reason: 'confinement', detail: `Unsupported verifier provider: ${options.verifier.provider}` }));
      return;
    }
    let op = plan.autonomous!.ops.find(row => row.kind === 'create-session' && row.attemptId === attemptId && row.payload.role === role);
    op ??= await intend(loc, 'create-session', attemptId, { role });
    if (op.state === 'failed' || (await load(loc)).autonomous!.halted) return;
    if (op.state === 'intended') {
      if (role === 'worker') {
        if (await reservedTemporaryPath(loc, attempt.baseSha)) return;
        const dir = cloneDirectory(loc, attemptId);
        const cloneOp = await intend(loc, 'clone', attemptId, { dir, sha: attempt.baseSha, branch: attempt.branch });
        await effect(loc, cloneOp, async () => {
          await io.fs.mkdir(path.dirname(dir), { recursive: true });
          await git(loc, ['clone', '--no-hardlinks', '--no-checkout', '--', attemptsEngineGitPath(loc.projectPath, loc.workId), dir]);
          await git(loc, ['-C', dir, 'checkout', '--detach', attempt.baseSha]);
          await io.fs.mkdir(path.join(dir, '.parley-tmp'), { recursive: true });
          return { dir, sha: attempt.baseSha };
        });
      }
      const review = role === 'verifier' ? await prepareReview(loc, plan, op, [attempt], attempt.baseSha, attempt.sha!, thisResults(plan, attempt)) : null;
      const task = role === 'worker' ? await workerBrief(loc, plan, attempt) : await verifierBrief(loc, plan, attempt);
      const selected = role === 'worker' ? { provider: options.provider, model: options.model } : options.verifier;
      const create = op;
      await effect(loc, create, async () => {
        const map = await io.readMap(loc.projectPath, loc.workId);
        const existing = map.sessions.find(row => row.label === sessionLabel(loc, attemptId, create));
        if (existing) return { sessionId: existing.id };
        const input: CreateSessionInput = { projectPath: loc.projectPath, workId: loc.workId, requestedBy: ENGINE, deferLaunch: true, parent: null, ...(role === 'worker' ? { workspace: { kind: 'clone' as const, path: cloneDirectory(loc, attemptId), branch: attempt.branch, sha: attempt.baseSha } } : { workspace: { kind: 'artifacts' as const, path: review! } }), provider: selected.provider, label: sessionLabel(loc, attemptId, create), task, role: { source: 'builtin', name: role === 'worker' ? 'executor' : 'verifier' }, ...(selected.model === undefined ? {} : { model: selected.model }) };
        const ref = await io.sessions.create(input);
        return { sessionId: ref.sessionId };
      });
    }
    plan = await load(loc); attempt = attemptOf(plan, attemptId);
    if (plan.autonomous!.halted || fenced.has(attempt.status)) return;
    const sessionId = role === 'worker' ? attempt.worker : attempt.verifier;
    if (!sessionId) return;
    const launched = plan.autonomous!.ops.find(row => row.kind === 'launch' && row.payload.sessionId === sessionId && row.state === 'done');
    if (!launched) {
      const launch = await intend(loc, 'launch', attemptId, { sessionId, role });
      if (launch.state !== 'intended') return;
      await effect(loc, launch, async () => {
        const result = await io.sessions.launch({ projectPath: loc.projectPath, workId: loc.workId, sessionId }, 'launch', { by: ENGINE });
        if (result !== 'started') throw new Error('session-launch-held');
        return { sessionId };
      });
    }
  }
  async function outputTails(loc: Location, results: CheckResult[]) {
    return Promise.all(results.map(async result => {
      if (!result.outputTail) return { id: result.id, tail: null };
      const file = path.resolve(loc.projectPath, result.outputTail);
      const root = path.join(workPaths(loc.projectPath, loc.workId).dir, 'autonomous', loc.planId);
      if (!file.startsWith(`${root}${path.sep}`)) throw new Error('untrusted-check-output');
      return { id: result.id, tail: (await io.fs.readFile(file, 'utf8')).slice(-65536) };
    }));
  }
  async function verifierBrief(loc: Location, plan: RoomPlan, attempt: PlanAttempt): Promise<string> {
    const diff = await text(loc, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${attempt.baseSha}..${attempt.sha}`]);
    const results = thisResults(plan, attempt);
    const tails = await outputTails(loc, results);
    return [`Read-only verifier for ${attempt.id}; sha ${attempt.sha}; criteriaVersion ${attempt.criteriaVersion}.`,
      `Criteria: ${JSON.stringify(plan.items.find(row => row.id === attempt.item)!.criteria)}`,
      'Use only these engine-owned artifacts. Do not read source code or execute commands. Return attempt_verify for every qualitative criterion.',
      `Manifest: ${JSON.stringify(attempt.manifest)}`, `Diff summary: ${diff}`, `Checks: ${JSON.stringify(results)}`, `Output tails: ${JSON.stringify(tails)}`].join('\n');
  }
  async function capture(loc: Location, attempt: PlanAttempt): Promise<AutonomousOp> {
    const plan = await load(loc);
    const previous = plan.autonomous!.ops.find(op => op.kind === 'capture' && op.attemptId === attempt.id);
    const op = previous ?? await intend(loc, 'capture', attempt.id, { baseSha: attempt.baseSha, dir: cloneDirectory(loc, attempt.id) });
    return effect(loc, op, async () => {
      const recovered = await captureEvidence(loc, op, attempt);
      if (recovered) return recovered;
      const index = path.join(directory(loc, attempt.id), `${op.key}.index`);
      await io.fs.rm(index, { force: true });
      const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: cloneDirectory(loc, attempt.id) };
      await bare(loc, ['read-tree', attempt.baseSha], env);
      await bare(loc, ['add', '-A', '--', '.', ...CAPTURE_EXCLUDED.map(name => `:(exclude,top)${name}`)], env);
      await bare(loc, ['rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.parley-tmp'], env);
      const tree = (await bare(loc, ['write-tree'], env)).toString('utf8').trim();
      const baseTree = await text(loc, ['rev-parse', `${attempt.baseSha}^{tree}`]);
      const sha = tree === baseTree ? attempt.baseSha : (await bare(loc, ['commit-tree', tree, '-p', attempt.baseSha, '-m', commitMessage(loc, op)], { ...env, GIT_AUTHOR_NAME: `attempt ${loc.planId}/${attempt.id}` })).toString('utf8').trim();
      await bare(loc, ['update-ref', attemptRef(loc, attempt.id), sha]);
      await io.fs.rm(index, { force: true });
      return { sha, tree, baseTree };
    });
  }
  async function captureEvidence(loc: Location, op: AutonomousOp, attempt: PlanAttempt): Promise<Record<string, unknown> | null> {
    if (!await exists(attemptsEngineGitPath(loc.projectPath, loc.workId))) return null;
    // commit-tree can finish before update-ref: scan engine-owned objects, including dangling commits.
    const objects = await text(loc, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
    for (const line of objects.split('\n')) {
      const [sha, type] = line.split(' ');
      if (type !== 'commit') continue;
      const commit = await text(loc, ['cat-file', 'commit', sha!]);
      const parents = [...commit.matchAll(/^parent (.+)$/gm)].map(match => match[1]);
      if (commit.split('\n\n').slice(1).join('\n\n').trim() === commitMessage(loc, op) && parents.length === 1 && parents[0] === attempt.baseSha) {
        return { sha, tree: /^tree (.+)$/m.exec(commit)![1], baseTree: await text(loc, ['rev-parse', `${attempt.baseSha}^{tree}`]) };
      }
    }
    // Unchanged captures are witnessed by an attempt ref pointing exactly at baseSha.
    if (await refSha(loc, attemptRef(loc, attempt.id)) === attempt.baseSha) {
      const tree = await text(loc, ['rev-parse', `${attempt.baseSha}^{tree}`]);
      return { sha: attempt.baseSha, tree, baseTree: tree };
    }
    return null;
  }
  async function frozenInputs(loc: Location, plan: RoomPlan, attempt: PlanAttempt, sha: string): Promise<boolean> {
    for (const input of plan.autonomous!.checks.filter(row => row.item === attempt.item).flatMap(row => row.inputs)) {
      try { if (await text(loc, ['rev-parse', `${sha}:${input.path}`]) !== input.blob || await text(loc, ['cat-file', '-t', `${sha}:${input.path}`]) !== 'blob') return false; }
      catch { return false; }
    }
    return true;
  }
  async function artifactDirectory(loc: Location, attemptId: string): Promise<string> {
    const dir = directory(loc, attemptId);
    const root = await io.fs.realpath(path.dirname(dir));
    if (await io.fs.realpath(dir) !== path.join(root, attemptId)) throw new Error('untrusted-artifact-directory');
    const artifacts = path.join(dir, 'artifacts');
    await io.fs.mkdir(artifacts, { recursive: true });
    if (!(await io.fs.lstat(artifacts)).isDirectory() || await io.fs.realpath(artifacts) !== path.join(root, attemptId, 'artifacts')) throw new Error('untrusted-artifact-directory');
    return artifacts;
  }
  async function artifactBytes(file: string): Promise<Buffer> {
    if (!(await io.fs.lstat(file)).isFile() || await io.fs.realpath(file) !== path.join(await io.fs.realpath(path.dirname(file)), path.basename(file))) throw new Error('untrusted-artifact-file');
    return io.fs.readFile(file);
  }
  async function copyArtifacts(loc: Location, attempt: PlanAttempt, captureOp: AutonomousOp): Promise<AutonomousOp> {
    const plan = await load(loc);
    const op = plan.autonomous!.ops.find(row => row.kind === 'copy-artifacts' && row.attemptId === attempt.id)
      ?? await intend(loc, 'copy-artifacts', attempt.id, { captureOp: captureOp.key });
    return effect(loc, op, async () => {
      let valid = true;
      const artifacts: HandoffManifest['artifacts'] = [];
      for (const [index, artifact] of attempt.manifest!.artifacts.entries()) {
        const file = artifactPath(loc, attempt.id, index, artifact.sha256);
        const storedAs = path.relative(directory(loc, attempt.id), file);
        artifacts.push({ ...artifact, storedAs });
        if (path.posix.isAbsolute(artifact.path) || artifact.path.split('/').some(part => part === '..' || part === '.git') || !/^[a-f0-9]{64}$/.test(artifact.sha256)) { valid = false; continue; }
        try {
          const object = `${captureOp.result!.sha}:${artifact.path}`;
          // Read blobs from the captured tree; never follow a clone symlink or trust storedAs.
          const entry = await text(loc, ['ls-tree', String(captureOp.result!.sha), '--', artifact.path]);
          if (!/^100(644|755) blob /.test(entry)) { valid = false; continue; }
          const data = await bare(loc, ['cat-file', 'blob', object]);
          if (bytesHash(data) !== artifact.sha256) { valid = false; continue; }
          await artifactDirectory(loc, attempt.id);
          await io.fs.writeFile(file, data, { flag: 'wx' }).catch(async error => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || bytesHash(await artifactBytes(file)) !== artifact.sha256) throw error;
          });
        } catch { valid = false; }
      }
      return { artifacts, artifactsCopied: valid, artifactHashesOk: valid };
    });
  }
  async function finishSubmission(loc: Location, attemptId: string): Promise<void> {
    await drainSessions(loc);
    let plan = await load(loc), attempt = attemptOf(plan, attemptId);
    if (fenced.has(attempt.status) || plan.autonomous!.halted || attempt.receipt) return;
    const captured = await capture(loc, attempt);
    const copied = await copyArtifacts(loc, attempt, captured);
    const sha = String(captured.result!.sha), tree = String(captured.result!.tree);
    const inputsOk = await frozenInputs(loc, plan, attempt, sha);
    let descendantOfBase = false;
    try { await bare(loc, ['merge-base', '--is-ancestor', attempt.baseSha, sha]); descendantOfBase = true; } catch { /* Receipt records the failed observation. */ }
    plan = await change(loc, (current, map, letters) => {
      // The snapshot read before the transaction may be stale: decide on the plan this transaction sees.
      const had = attemptOf(current, attemptId).receipt;
      const result = receipt(current, { ...context(current, at()), attemptId, submissionKey: attempt.submissionKey!, sha, tree, baseTree: String(captured.result!.baseTree), descendantOfBase, inputsOk, artifactsCopied: copied.result!.artifactsCopied === true, artifactHashesOk: copied.result!.artifactHashesOk === true, artifacts: copied.result!.artifacts as HandoffManifest['artifacts'], captureOp: captured.key, copyOp: copied.key });
      const received = attemptOf(result.plan, attemptId);
      if (received.receipt && !had && received.worker) parleyNote(map, letters, result.plan.roomId, received.worker, `Receipt ${received.receipt.id} recorded (${received.receipt.valid ? 'valid' : received.receipt.reason}).`, at());
      return result.plan;
    });
    await drainSessions(loc);
    attempt = attemptOf(plan, attemptId);
    if (attempt.receipt?.valid) await checkAttempt(loc, attemptId);
  }
  async function record(loc: Location, attemptId: string, op: AutonomousOp, result: CheckResult): Promise<void> {
    await settled(loc, op, 'done', { checkResult: result });
    await change(loc, plan => recordCheck(plan, { ...context(plan, at()), attemptId, opKey: op.key, result }));
    if (result.verdict === 'error' && result.summary.includes('confinement-unavailable'))
      await change(loc, plan => halt(plan, { ...context(plan, at()), reason: 'confinement', detail: result.summary }));
  }
  async function checkAttempt(loc: Location, attemptId: string): Promise<void> {
    let plan = await load(loc), attempt = attemptOf(plan, attemptId);
    if (plan.autonomous!.halted || !['submitted', 'checking'].includes(attempt.status)) return;
    for (const spec of plan.autonomous!.checks.filter(row => row.item === attempt.item)) {
      plan = await load(loc); attempt = attemptOf(plan, attemptId);
      if (plan.autonomous!.halted || fenced.has(attempt.status)) return;
      if (thisResults(plan, attempt).some(row => row.specId === spec.id)) continue;
      await serialCheck(async () => {
        const current = await load(loc);
        if (stopped || current.autonomous!.halted) return;
        const resultId = nextCheckId(current);
        const op = await intend(loc, 'check', attemptId, { phase: 'attempt', sha: attempt.sha, specId: spec.id, resultId });
        let result: CheckResult;
        try { result = await io.runner({ projectPath: loc.projectPath, workId: loc.workId, planId: loc.planId, resultId, now: io.now }, spec, attempt.sha!, attemptId); }
        catch (error) {
          await settled(loc, op, 'failed', { reason: errorText(error) });
          await change(loc, row => halt(row, { ...context(row, at()), reason: 'human', detail: `check: ${errorText(error)}` }));
          throw error;
        }
        await record(loc, attemptId, op, result);
      });
    }
    plan = await load(loc); attempt = attemptOf(plan, attemptId);
    if (plan.autonomous!.halted || fenced.has(attempt.status)) return;
    const qualitative = Object.entries(plan.autonomous!.coverage[attempt.item] ?? {}).filter(([, checks]) => checks.includes('verifier')).map(([criterion]) => `verifier:${criterion}`);
    const results = thisResults(plan, attempt);
    if (qualitative.some(id => !results.some(row => row.specId === id))) {
      await spawn(loc, attemptId, 'verifier');
      return;
    }
    await decide(loc, attemptId);
  }
  async function decide(loc: Location, attemptId: string): Promise<void> {
    await change(loc, plan => {
      const attempt = attemptOf(plan, attemptId), results = thisResults(plan, attempt);
      const verdict = coverageVerdict(plan, { ...context(plan, at()), attemptId, results: results.filter(row => row.by === ENGINE), verifiers: results.filter(row => row.by !== ENGINE) });
      if (verdict.plan.autonomous!.halted || fenced.has(attemptOf(verdict.plan, attemptId).status)) return verdict.plan;
      if (verdict.accepted) return enqueue(verdict.plan, { ...context(verdict.plan, at()), attemptId });
      return returnAttempt(verdict.plan, { ...context(verdict.plan, at()), attemptId, signature: failureSignature({ checks: results, criteria: results.filter(row => row.specId.startsWith('verifier:')).map(row => ({ criterion: Number(row.specId.split(':')[1]), verdict: row.verdict })), reasons: [verdict.reason ?? 'coverage-incomplete', ...verdict.gaps] }), reason: JSON.stringify({ gaps: verdict.gaps, checks: results.map(row => ({ id: row.specId, verdict: row.verdict, summary: row.summary, outputTail: row.outputTail })) }) });
    });
    const plan = await load(loc), attempt = attemptOf(plan, attemptId);
    if (attempt.verifier && !plan.autonomous!.ops.some(op => op.kind === 'close-session' && op.payload.sessionId === attempt.verifier)) await intend(loc, 'close-session', attemptId, { sessionId: attempt.verifier });
    await drainSessions(loc);
  }
  const integrationDirectory = (loc: Location) => path.join(workPaths(loc.projectPath, loc.workId).dir, 'autonomous', loc.planId, 'integration');
  function integrationAttempts(plan: RoomPlan): PlanAttempt[] {
    const a = plan.autonomous!;
    return a.attempts.filter(attempt => attempt.id === a.integration.queue[0] ||
      (attempt.status === 'integrated' && plan.items.find(item => item.id === attempt.item)?.status === 'verified' &&
        a.attempts.findLast(row => row.item === attempt.item && row.status === 'integrated') === attempt));
  }
  function candidateOperation(plan: RoomPlan): AutonomousOp | undefined {
    const a = plan.autonomous!;
    return a.ops.findLast(op => ['merge', 'noop-integration'].includes(op.kind) && op.state === 'done' &&
      op.attemptId === a.integration.queue[0] && op.result?.sha === a.integration.candidateHead && op.payload.verifiedHead === a.integration.verifiedHead);
  }
  function integrationResults(plan: RoomPlan, operation: AutonomousOp): CheckResult[] {
    const a = plan.autonomous!, resume = a.ops.findLastIndex(op => op.kind === 'resume');
    return a.ops.filter((op, index) => index > resume && op.kind === 'check' && op.state === 'done' &&
      op.payload.phase === 'integration' && op.payload.integrationOp === operation.key)
      .map(op => op.result?.checkResult as CheckResult).filter(result => result && result.sha === a.integration.candidateHead &&
        a.attempts.some(attempt => attempt.id === result.attemptId && attempt.checks.includes(result.id)));
  }
  function candidateVerifier(plan: RoomPlan, operation: AutonomousOp): AutonomousOp | undefined {
    const a = plan.autonomous!, resume = a.ops.findLastIndex(op => op.kind === 'resume');
    return a.ops.findLast((op, index) => index > resume && op.kind === 'create-session' && op.state !== 'failed' &&
      op.payload.purpose === 'integration-verifier' && op.payload.integrationOp === operation.key);
  }
  async function integrationCheckout(loc: Location, attemptId: string): Promise<void> {
    const plan = await load(loc), dir = integrationDirectory(loc), i = plan.autonomous!.integration;
    const clone = async () => {
      const op = await intend(loc, 'clone', null, { purpose: 'integration', dir, branch: i.branch, sha: i.verifiedHead });
      await effect(loc, op, async () => {
        await git(loc, ['clone', '--no-hardlinks', '--no-checkout', '--', attemptsEngineGitPath(loc.projectPath, loc.workId), dir]);
        await git(loc, ['-C', dir, 'checkout', '-b', i.branch, i.verifiedHead]);
        return { dir, sha: i.verifiedHead };
      });
    };
    if (await exists(dir)) {
      const op = await intend(loc, 'merge-abort', attemptId, { purpose: 'prepare-integration', sha: i.verifiedHead });
      try {
        if (await exists(path.join(dir, '.git', 'MERGE_HEAD'))) await git(loc, ['-C', dir, 'merge', '--abort']);
        await git(loc, ['-C', dir, 'reset', '--hard', i.verifiedHead]);
        await git(loc, ['-C', dir, 'clean', '-fdx']);
      } catch (error) {
        await settled(loc, op, 'failed', { reason: errorText(error) });
      }
      if ((await load(loc)).autonomous!.ops.find(row => row.key === op.key)?.state === 'intended') {
        await settled(loc, op, 'done', { sha: i.verifiedHead });
        return;
      }
      const cleanup = await intend(loc, 'cleanup', null, { purpose: 'integration', dir });
      await effect(loc, cleanup, async () => { await io.fs.rm(dir, { recursive: true, force: true }); return { removed: true }; });
    }
    await clone();
  }
  async function rollback(loc: Location): Promise<void> {
    const plan = await load(loc);
    if (plan.autonomous!.halted) return;
    for (const op of plan.autonomous!.ops.filter(row => row.kind === 'merge-abort' && row.state === 'intended')) {
      await effect(loc, op, async () => {
        const dir = integrationDirectory(loc), sha = String(op.payload.sha ?? plan.autonomous!.integration.verifiedHead);
        if (await exists(path.join(dir, '.git', 'MERGE_HEAD'))) await git(loc, ['-C', dir, 'merge', '--abort']);
        if (await exists(dir)) await git(loc, ['-C', dir, 'reset', '--hard', sha]);
        return { sha };
      });
    }
  }
  async function failIntegration(loc: Location, operation: AutonomousOp, reason: 'conflict' | 'integration'): Promise<void> {
    await change(loc, plan => {
      const failed = integrationResults(plan, operation).filter(result => result.verdict !== 'pass');
      return returnAttempt(plan, { ...context(plan, at()), attemptId: operation.attemptId!, reason,
        signature: failureSignature({ checks: failed.filter(result => !result.specId.startsWith('verifier:')),
          criteria: failed.filter(result => result.specId.startsWith('verifier:')).map(result => ({ criterion: Number(result.specId.split(':')[1]), verdict: result.verdict })), reasons: [reason] }) });
    });
    await rollback(loc);
    await drainSessions(loc);
  }
  async function mirrorIntegration(loc: Location): Promise<void> {
    const plan = await load(loc), i = plan.autonomous!.integration;
    if (i.candidateHead || !plan.autonomous!.attempts.some(attempt => attempt.status === 'integrated')) return;
    if (plan.autonomous!.ops.some(op => op.kind === 'clone' && op.payload.purpose === 'mirror' && op.payload.sha === i.verifiedHead && op.state === 'done')) return;
    const op = await intend(loc, 'clone', null, { purpose: 'mirror', sha: i.verifiedHead });
    await effect(loc, op, async () => {
      await bare(loc, ['update-ref', `refs/heads/${i.branch}`, i.verifiedHead]);
      // Fetch without '+' refuses a non-fast-forward project ref and never checks out its tree.
      await git(loc, ['-C', loc.projectPath, 'fetch', '--no-tags', '--', attemptsEngineGitPath(loc.projectPath, loc.workId), `refs/heads/${i.branch}:refs/heads/${i.branch}`]);
      return { sha: i.verifiedHead };
    });
  }
  async function cleanupIntegrated(loc: Location): Promise<void> {
    const plan = await load(loc);
    if (plan.autonomous!.halted) return;
    for (const attempt of plan.autonomous!.attempts.filter(row => row.status === 'integrated')) {
      let op = plan.autonomous!.ops.findLast(row => row.kind === 'cleanup' && row.attemptId === attempt.id && row.state !== 'failed');
      if (op?.state === 'done') continue;
      op ??= await intend(loc, 'cleanup', attempt.id, { dir: cloneDirectory(loc, attempt.id) });
      await effect(loc, op, async () => { await io.fs.rm(cloneDirectory(loc, attempt.id), { recursive: true, force: true }); return { removed: true }; });
    }
  }
  async function cleanupPlan(loc: Location, cancelling = false): Promise<void> {
    let plan = await load(loc);
    if (plan.autonomous!.halted && !cancelling) return;
    // Remove only disposable trees. Artifacts, check tails and engine.git are retained.
    const targets = [
      ...plan.autonomous!.attempts.map(attempt => ({ attemptId: attempt.id, dir: cloneDirectory(loc, attempt.id) })),
      { attemptId: null, dir: integrationDirectory(loc) },
    ];
    for (const target of targets) {
      plan = await load(loc);
      if (plan.autonomous!.halted && !cancelling) return;
      let op = plan.autonomous!.ops.findLast(row => row.kind === 'cleanup' && row.payload.dir === target.dir && row.state !== 'failed' &&
        (target.attemptId !== null || ['completion', 'cancellation'].includes(String(row.payload.purpose))));
      if (op?.state === 'done' && !await exists(target.dir)) continue;
      if (op?.state === 'done') op = undefined;
      op ??= await intend(loc, 'cleanup', target.attemptId, { dir: target.dir, purpose: cancelling ? 'cancellation' : 'completion' });
      await effect(loc, op, async () => { await io.fs.rm(target.dir, { recursive: true, force: true }); return { removed: true }; });
    }
    plan = await load(loc);
    for (const creation of plan.autonomous!.ops.filter(op => op.kind === 'create-session' && op.state === 'done')) {
      const sessionId = String(creation.result!.sessionId);
      for (const kind of ['stop-session', 'close-session'] as const) {
        const latest = await load(loc);
        if (latest.autonomous!.halted && !cancelling) return;
        const previous = latest.autonomous!.ops.findLast(op => op.kind === kind && op.payload.sessionId === sessionId && op.state !== 'failed');
        const op = previous ?? await intend(loc, kind, creation.attemptId, { sessionId });
        await sessionOperation(loc, op);
      }
    }
    await drainSessions(loc);
  }
  async function complete(loc: Location): Promise<void> {
    let plan = await load(loc);
    if (!planItemsComplete(plan)) return;
    await mirrorIntegration(loc);
    await cleanupPlan(loc);
    plan = await load(loc);
    if (!planItemsComplete(plan)) return;
    const room = (await io.readMap(loc.projectPath, loc.workId)).rooms.find(row => row.id === plan.roomId)!;
    if (room.proposal) return;
    const a = plan.autonomous!, b = a.budget;
    const integrated = a.attempts.filter(attempt => attempt.status === 'integrated' && plan.items.some(item => item.id === attempt.item && item.status === 'verified'))
      .filter(attempt => !a.attempts.some(other => other.item === attempt.item && other.status === 'integrated' && other.n > attempt.n));
    const checks = a.ops.filter(op => op.kind === 'check' && op.state === 'done').map(op => op.result?.checkResult as CheckResult)
      .filter(result => result && result.sha === a.integration.verifiedHead);
    const concurrent = a.ops.filter(op => op.kind === 'launch' && op.state === 'done' && !a.ops.some(end => ['stop-session', 'close-session'].includes(end.kind) && end.state === 'done' && end.payload.sessionId === op.payload.sessionId)).length;
    const minutes = a.attempts.map(attempt => {
      const charged = a.ops.filter(op => op.kind === 'check' && op.state === 'done' &&
        (op.payload.phase === 'integration' ? a.ops.find(merge => merge.key === op.payload.integrationOp)?.attemptId === attempt.id : op.attemptId === attempt.id))
        .map(op => op.result?.checkResult as CheckResult).filter(result => result && a.attempts.some(owner => owner.checks.includes(result.id)));
      const spent = Math.max(0, Math.ceil((Date.parse(attempt.endedAt ?? at()) - Date.parse(attempt.startedAt)) / 60_000)) + charged.reduce((sum, result) => sum + Math.ceil(result.durationMs / 60_000), 0);
      return { attemptId: attempt.id, spent, remaining: Math.max(0, b.limits.minutesPerAttempt - spent) };
    });
    const budget = [
      ...plan.items.map(item => { const spent = a.attempts.filter(attempt => attempt.item === item.id).length; return `attemptsPerItem item ${item.id}: spent ${spent}/${b.limits.attemptsPerItem}, remaining ${Math.max(0, b.limits.attemptsPerItem - spent)}`; }),
      `repairWaves: spent ${b.spent.repairWaves}/${b.limits.repairWaves}, remaining ${Math.max(0, b.limits.repairWaves - b.spent.repairWaves)}`,
      `minutesPerAttempt: limit ${b.limits.minutesPerAttempt}; total spent minutes ${b.spent.minutes}`,
      ...minutes.map(row => `${row.attemptId}: spent minutes ${row.spent}, remaining ${row.remaining}`),
      `sessions: spent ${b.spent.sessions}/${b.limits.sessions}, remaining ${Math.max(0, b.limits.sessions - b.spent.sessions)}; verifiers ${b.spent.verifiers}; launches ${b.spent.launches}`,
      `concurrent: spent ${concurrent}/${b.limits.concurrent}, remaining ${Math.max(0, b.limits.concurrent - concurrent)}`,
    ];
    const report = Buffer.from(JSON.stringify({
      planId: plan.id, rev: plan.rev, goal: plan.goal, verifiedHead: a.integration.verifiedHead,
      integration: a.integration, items: integrated.map(attempt => ({ item: attempt.item, attemptId: attempt.id, receipt: attempt.receipt, evidence: plan.items.find(item => item.id === attempt.item)!.evidence })),
      checks, budget: { ...b, minutes, summary: budget },
    }, null, 2));
    const sha256 = bytesHash(report);
    let reportOp = a.ops.findLast(op => op.kind === 'copy-artifacts' && op.payload.purpose === 'completion-report' && op.payload.sha256 === sha256 && op.state !== 'failed');
    const previous = a.ops.some(op => op.kind === 'copy-artifacts' && op.payload.purpose === 'completion-report' && op.payload.rev === plan.rev && op.payload.sha256 !== sha256);
    const reportPath = reportOp ? String(reportOp.payload.path) : path.relative(loc.projectPath,
      path.join(workPaths(loc.projectPath, loc.workId).dir, 'autonomous', loc.planId, `completion-${plan.rev}${previous ? '-' + sha256 : ''}.json`));
    const reportFile = path.resolve(loc.projectPath, reportPath);
    reportOp ??= await intend(loc, 'copy-artifacts', null, { purpose: 'completion-report', rev: plan.rev, path: reportPath, sha256 });
    await effect(loc, reportOp, async () => {
      await io.fs.writeFile(reportFile, report, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      if (bytesHash(await artifactBytes(reportFile)) !== sha256) throw new Error('completion-report-conflict');
      return { path: reportPath, sha256 };
    });
    const heading = [
      `verifiedHead: ${a.integration.verifiedHead}`,
      `Integration branch: ${a.integration.branch}; engine: ${attemptsEngineGitPath(loc.projectPath, loc.workId)}; project mirror: ${loc.projectPath} refs/heads/${a.integration.branch}`,
      ...integrated.map(attempt => `Item ${attempt.item}: ${attempt.id}; receipt ${attempt.receipt?.id}; criteriaVersion ${attempt.criteriaVersion}`),
    ];
    const reference = `Full completion report: ${reportPath}; sha256: ${sha256}`;
    let summary = [...heading, `Checks/verdicts on verifiedHead: ${JSON.stringify(checks.map(result => ({ id: result.id, specId: result.specId, attemptId: result.attemptId, verdict: result.verdict, by: result.by })))}`, ...budget, reference].join('\n');
    if (summary.length > PROPOSAL_TEXT_MAX)
      summary = [...heading, `Checks/verdicts on verifiedHead: ${checks.filter(result => result.verdict === 'pass').length} pass / ${checks.length} total; full list in report.`, ...budget, reference].join('\n');
    await change(loc, (current, map) => {
      if (!planItemsComplete(current) || current.rev !== plan.rev || current.autonomous!.integration.verifiedHead !== a.integration.verifiedHead) return current;
      const room = map.rooms.find(row => row.id === current.roomId)!;
      const lead = liveLead(map, room);
      if (!lead) return halt(current, { ...context(current, at()), reason: 'human', detail: 'no live lead for completion proposal' });
      if (room.proposal) return current;
      if (summary.length > PROPOSAL_TEXT_MAX) return halt(current, { ...context(current, at()), reason: 'human', detail: `completion card exceeds limit: ${summary.length}` });
      proposeCompletion(map, room.id, lead, current.id, current.rev, summary, at(), ENGINE);
      return current;
    });
  }
  async function spawnIntegrationVerifier(loc: Location, operation: AutonomousOp): Promise<void> {
    let plan = await load(loc);
    if (!['codex', 'claude'].includes(options.verifier.provider)) {
      await change(loc, current => halt(current, { ...context(current, at()), reason: 'confinement', detail: `Unsupported verifier provider: ${options.verifier.provider}` }));
      return;
    }
    const sha = plan.autonomous!.integration.candidateHead!;
    const payload = { purpose: 'integration-verifier', phase: 'integration', integrationOp: operation.key, role: 'verifier', sha };
    let op = candidateVerifier(plan, operation) ?? await intend(loc, 'create-session', operation.attemptId, payload);
    if (op.state === 'failed' || (await load(loc)).autonomous!.halted) return;
    if (op.state === 'intended') {
      const attempts = integrationAttempts(plan), results = integrationResults(plan, operation);
      const review = await prepareReview(loc, plan, op, attempts, plan.autonomous!.integration.verifiedHead, sha, results);
      const diff = await text(loc, ['diff', '--no-ext-diff', '--no-textconv', `${plan.autonomous!.integration.verifiedHead}..${sha}`]);
      const task = [`Read-only integration verifier; candidateHead ${sha}; integrationOp ${operation.key}.`,
        'Use only these engine-owned artifacts. Do not read source code or execute commands. Return attempt_verify for every listed attempt and qualitative criterion, using candidateHead as sha.',
        `Attempts and criteria: ${JSON.stringify(attempts.map(attempt => ({ attemptId: attempt.id, criteriaVersion: attempt.criteriaVersion, criteria: plan.items.find(item => item.id === attempt.item)!.criteria, qualitative: Object.entries(plan.autonomous!.coverage[attempt.item] ?? {}).filter(([, ids]) => ids.includes('verifier')).map(([criterion]) => Number(criterion)), manifest: attempt.manifest })))}`,
        `Diff: ${diff}`, `Checks: ${JSON.stringify(results)}`, `Output tails: ${JSON.stringify(await outputTails(loc, results))}`].join('\n');
      const creation = op;
      op = await effect(loc, creation, async () => {
        const map = await io.readMap(loc.projectPath, loc.workId);
        const existing = map.sessions.find(row => row.label === sessionLabel(loc, operation.attemptId!, creation));
        if (existing) return { sessionId: existing.id };
        const ref = await io.sessions.create({ projectPath: loc.projectPath, workId: loc.workId, requestedBy: ENGINE, deferLaunch: true, parent: null,
          provider: options.verifier.provider, ...(options.verifier.model === undefined ? {} : { model: options.verifier.model }),
          workspace: { kind: 'artifacts', path: review }, label: sessionLabel(loc, operation.attemptId!, creation), task, role: { source: 'builtin', name: 'verifier' } });
        return { sessionId: ref.sessionId };
      });
    }
    plan = await load(loc);
    if (plan.autonomous!.halted) return;
    const sessionId = String(op.result!.sessionId);
    if (!plan.autonomous!.ops.some(row => row.kind === 'launch' && row.state === 'done' && row.payload.sessionId === sessionId)) {
      const launch = await intend(loc, 'launch', operation.attemptId, { ...payload, sessionId });
      if (launch.state !== 'intended') return;
      await effect(loc, launch, async () => {
        if (await io.sessions.launch({ projectPath: loc.projectPath, workId: loc.workId, sessionId }, 'launch', { by: ENGINE }) !== 'started') throw new Error('session-launch-held');
        return { sessionId };
      });
    }
  }
  async function integrateQueue(loc: Location, candidateOnly = false): Promise<void> {
    while (!stopped) {
      let plan = await load(loc), a = plan.autonomous!;
      if (a.halted || a.integration.suspended || !a.integration.queue.length) return;
      const attempt = attemptOf(plan, a.integration.queue[0]!);
      let operation = candidateOperation(plan);
      if (!operation) {
        await integrationCheckout(loc, attempt.id);
        let contained = attempt.sha === a.integration.verifiedHead;
        if (!contained) {
          try { await bare(loc, ['merge-base', '--is-ancestor', attempt.sha!, a.integration.verifiedHead]); contained = true; }
          catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
        }
        operation = await intend(loc, contained ? 'noop-integration' : 'merge', attempt.id,
          { attemptId: attempt.id, sha: attempt.sha, verifiedHead: a.integration.verifiedHead, containedInVerifiedHead: contained });
        // The rule performs the third dependency check and may supersede instead of intending.
        plan = await load(loc);
        if (attemptOf(plan, attempt.id).status !== 'queued' || !['merge', 'noop-integration'].includes(operation.kind)) return;
        let conflict = false;
        const mergeOperation = operation;
        try { operation = await effect(loc, operation, async () => {
          if (contained) return { sha: a.integration.verifiedHead };
          const dir = integrationDirectory(loc);
          await git(loc, ['-C', dir, 'fetch', '--no-tags', '--', attemptsEngineGitPath(loc.projectPath, loc.workId), attempt.sha!]);
          try { await git(loc, ['-C', dir, 'merge', '--no-ff', '--no-edit', '-m', commitMessage(loc, operation!), attempt.sha!]); }
          catch (error) {
            if (!await exists(path.join(dir, '.git', 'MERGE_HEAD'))) throw error;
            conflict = true;
            throw new Error('integration-conflict');
          }
          const sha = (await git(loc, ['-C', dir, 'rev-parse', 'HEAD'])).toString('utf8').trim();
          await bare(loc, ['fetch', '--no-tags', '--', dir, `+HEAD:${candidateRef(loc, attempt.id)}`]);
          return { sha };
        }); } catch (error) {
          if (!conflict || (await load(loc)).autonomous!.ops.find(row => row.key === mergeOperation.key)?.state !== 'failed') throw error;
          await intend(loc, 'merge-abort', attempt.id, { sha: a.integration.verifiedHead });
          await rollback(loc);
          await failIntegration(loc, mergeOperation, 'conflict');
          continue;
        }
      }
      plan = await load(loc); a = plan.autonomous!;
      const checked = integrationAttempts(plan);
      checks: for (const owner of checked) {
        for (const spec of a.checks.filter(row => row.item === owner.item)) {
          plan = await load(loc);
          if (plan.autonomous!.halted) return;
          if (integrationResults(plan, operation).some(result => result.attemptId === owner.id && result.specId === spec.id)) continue;
          await serialCheck(async () => {
            const current = await load(loc);
            if (stopped || current.autonomous!.halted) return;
            const resultId = nextCheckId(current);
            const sha = current.autonomous!.integration.candidateHead!;
            const op = await intend(loc, 'check', owner.id, { phase: 'integration', integrationOp: operation!.key, sha, specId: spec.id, resultId });
            let result: CheckResult;
            try { result = await io.runner({ projectPath: loc.projectPath, workId: loc.workId, planId: loc.planId, resultId, now: io.now }, spec, sha, owner.id); }
            catch (error) {
              await settled(loc, op, 'failed', { reason: errorText(error) });
              await change(loc, current => halt(current, { ...context(current, at()), reason: 'human', detail: `integration check: ${errorText(error)}` }));
              throw error;
            }
            await record(loc, owner.id, op, result);
          });
          plan = await load(loc);
          const result = integrationResults(plan, operation).findLast(row => row.attemptId === owner.id && row.specId === spec.id);
          if (result && result.verdict !== 'pass') { await failIntegration(loc, operation, 'integration'); break checks; }
          if (plan.autonomous!.halted) return;
        }
      }
      plan = await load(loc);
      if (plan.autonomous!.integration.candidateHead === null) continue;
      const results = integrationResults(plan, operation);
      const failed = results.find(result => result.verdict !== 'pass');
      const missing = checked.some(owner => Object.entries(plan.autonomous!.coverage[owner.item] ?? {}).some(([criterion, ids]) =>
        ids.includes('verifier') && !results.some(row => row.attemptId === owner.id && row.specId === `verifier:${criterion}`)));
      if (missing && !failed) { await spawnIntegrationVerifier(loc, operation); return; }
      const verifier = candidateVerifier(plan, operation);
      if (verifier?.state === 'done' && !plan.autonomous!.ops.some(op => op.kind === 'close-session' && op.payload.sessionId === verifier.result!.sessionId)) {
        await intend(loc, 'close-session', operation.attemptId, { sessionId: verifier.result!.sessionId });
        await drainSessions(loc);
      }
      if (failed) { await failIntegration(loc, operation, 'integration'); continue; }
      await change(loc, current => integrate(current, { ...context(current, at()), attemptId: operation!.attemptId!, opKey: operation!.key,
        results: results.filter(row => row.by === ENGINE), verifiers: results.filter(row => row.by !== ENGINE) }));
      if ((await load(loc)).autonomous!.halted) return;
      await mirrorIntegration(loc);
      await cleanupIntegrated(loc);
      if (candidateOnly) return;
    }
  }
  async function verifyIntegration(loc: Location, sessionId: string, rev: number, request: Parameters<AutonomousEngine['verify']>[3]): Promise<AttemptsResult> {
    const plan = await load(loc);
    const operation = candidateOperation(plan);
    if (!operation) throw new Error('integration-not-ready');
    const creation = candidateVerifier(plan, operation);
    if (creation?.state !== 'done' || creation.result?.sessionId !== sessionId) throw new Error('not-integration-verifier');
    const attempt = integrationAttempts(plan).find(row => row.id === request.attemptId);
    if (!attempt || plan.rev !== rev || attempt.criteriaVersion !== plan.autonomous!.criteriaVersion[attempt.item]) throw new Error('stale-criteria');
    if (request.sha !== plan.autonomous!.integration.candidateHead) throw new Error('sha-mismatch');
    if (!plan.autonomous!.coverage[attempt.item]?.[request.criterion]?.includes('verifier')) throw new Error('criterion-not-covered');
    const existing = integrationResults(plan, operation).find(row => row.attemptId === attempt.id && row.specId === `verifier:${request.criterion}`);
    if (existing) {
      if (existing.verdict !== request.verdict || existing.summary !== request.note) throw new Error('check-conflict');
      return { ok: true, result: { check: existing.id } };
    }
    const result: CheckResult = { id: nextCheckId(plan), specId: `verifier:${request.criterion}`, attemptId: attempt.id,
      sha: request.sha, argvHash: hash([]), envHash: hash({}), inputsOk: true, verdict: request.verdict, by: sessionId, exitCode: null,
      summary: request.note, outputTail: null, at: at(), durationMs: 0 };
    const op = await intend(loc, 'check', attempt.id, { phase: 'integration', integrationOp: operation.key, sha: request.sha, criterion: request.criterion, criteriaVersion: attempt.criteriaVersion, resultId: result.id });
    await record(loc, attempt.id, op, result);
    await integrateQueue(loc);
    return { ok: true, result: { check: result.id } };
  }
  async function recover(loc: Location): Promise<void> {
    const plan = await load(loc), map = await io.readMap(loc.projectPath, loc.workId);
    const observations: Parameters<typeof reconcileAfterRestart>[1]['observations'] = [];
    for (const op of plan.autonomous!.ops.filter(row => row.state === 'intended')) {
      let result: Record<string, unknown> | null = null;
      if (op.kind === 'create-session' && op.attemptId) {
        const session = map.sessions.find(row => row.label === sessionLabel(loc, op.attemptId!, op));
        if (session) result = { sessionId: session.id };
      } else if (['launch', 'stop-session', 'close-session'].includes(op.kind)) {
        const session = map.sessions.find(row => row.id === op.payload.sessionId);
        const confirmed = op.kind === 'launch' ? session?.lifecycle === 'active' : op.kind === 'close-session' ? session?.lifecycle === 'closed' : session && ['sleeping', 'closed'].includes(session.lifecycle);
        if (confirmed) result = { sessionId: op.payload.sessionId };
      } else if (op.kind === 'capture' && op.attemptId) result = await captureEvidence(loc, op, attemptOf(plan, op.attemptId));
      else if (op.kind === 'cleanup' && typeof op.payload.dir === 'string' &&
        [integrationDirectory(loc), ...plan.autonomous!.attempts.map(attempt => cloneDirectory(loc, attempt.id))].includes(op.payload.dir) &&
        !await exists(op.payload.dir)) result = { removed: true };
      else if (op.kind === 'copy-artifacts' && op.payload.purpose === 'completion-report' &&
        typeof op.payload.path === 'string' && typeof op.payload.sha256 === 'string') {
        const file = path.resolve(loc.projectPath, op.payload.path);
        const root = path.join(workPaths(loc.projectPath, loc.workId).dir, 'autonomous', loc.planId);
        if (path.dirname(file) === root && /^completion-\d+(?:-[a-f0-9]{64})?\.json$/.test(path.basename(file)) && await exists(file) &&
          bytesHash(await artifactBytes(file)) === op.payload.sha256) result = { path: op.payload.path, sha256: op.payload.sha256 };
      }
      else if (op.kind === 'copy-artifacts' && op.attemptId) {
        const attempt = attemptOf(plan, op.attemptId);
        const artifacts = attempt.manifest?.artifacts ?? [];
        let valid = true;
        for (const [index, artifact] of artifacts.entries()) {
          try {
            const file = artifactPath(loc, attempt.id, index, artifact.sha256);
            const root = await io.fs.realpath(path.dirname(directory(loc, attempt.id)));
            valid &&= await io.fs.realpath(path.dirname(file)) === path.join(root, attempt.id, 'artifacts') && bytesHash(await artifactBytes(file)) === artifact.sha256;
          } catch { valid = false; }
        }
        if (valid) result = { artifactsCopied: true, artifactHashesOk: true };
      }
      observations.push({ key: op.key, outcome: result ? 'done' : 'failed', result: result ?? { reason: 'restart-unconfirmed' } });
    }
    const integration = plan.autonomous!.integration;
    let head = integration.verifiedHead, parents: string[] = [], opKey: string | null = null;
    let branchMismatch = false;
    if (await exists(attemptsEngineGitPath(loc.projectPath, loc.workId))) {
      const branchHead = await refSha(loc, `refs/heads/${integration.branch}`);
      branchMismatch = branchHead !== integration.verifiedHead;
      const operation = plan.autonomous!.ops.findLast(op => ['merge', 'noop-integration'].includes(op.kind) && op.state !== 'failed' && op.attemptId === integration.queue[0]);
      if (operation?.kind === 'merge') {
        const observed = await refSha(loc, candidateRef(loc, operation.attemptId!));
        if (observed) {
          head = observed;
          const commit = await text(loc, ['cat-file', 'commit', head]);
          parents = [...commit.matchAll(/^parent (.+)$/gm)].map(match => match[1]!);
          if (commit.split('\n\n').slice(1).join('\n\n').trim() === commitMessage(loc, operation)) opKey = operation.key;
        }
      }
    }
    await change(loc, (current, map, letters) => {
      let next = reconcileAfterRestart(current, { ...context(current, at()), observations, integrationHead: { sha: head, parents, opKey } });
      if (current.autonomous!.halted?.detail.startsWith('cancelled by human'))
        next = halt(next, { ...context(next, at()), reason: 'human', detail: current.autonomous!.halted!.detail.split('\nReason:')[0]! });
      if (branchMismatch) next = halt(next, { ...context(next, at()), reason: 'restart', detail: `Integration branch ${integration.branch} differs from verifiedHead; inspect before resuming` });
      for (const op of next.autonomous!.ops.filter(row => row.kind === 'create-session' && row.state === 'done')) joinCreated(map, letters, next, String(op.result!.sessionId));
      return next;
    });
    await drainSessions(loc);
  }
  async function cycle(projectPath: string, workId: string): Promise<void> {
    requireRecovered(projectPath, workId);
    const map = await io.readMap(projectPath, workId);
    if (map.work.status !== 'active') return;
    for (const original of map.plans?.filter(active) ?? []) {
      const loc = { projectPath, workId, planId: original.id };
      await drainSessions(loc);
      let plan = await load(loc);
      if (plan.autonomous!.halted) {
        // The identity edit only refreshes the halt summary; once it is current, `change()` would throw NoEngineChange.
        if (haltedDetail(plan.autonomous!) !== plan.autonomous!.halted.detail) await change(loc, current => current);
        continue;
      }
      for (const op of plan.autonomous!.ops.filter(op => op.kind === 'resume' && op.state === 'intended'))
        await settled(loc, op, 'done', { requestedBy: HUMAN });
      plan = await load(loc);
      if (planItemsComplete(plan)) { await complete(loc); continue; }
      await rollback(loc);
      if (!['codex', 'claude'].includes(options.provider)) {
        await change(loc, current => halt(current, { ...context(current, at()), reason: 'confinement', detail: `Unsupported executor provider: ${options.provider}` }));
        continue;
      }
      const integrationVerifier = plan.autonomous!.ops.findLast(op => op.kind === 'launch' && op.state === 'done' && op.payload.purpose === 'integration-verifier' &&
        !plan.autonomous!.ops.some(end => ['stop-session', 'close-session'].includes(end.kind) && end.state === 'done' && end.payload.sessionId === op.payload.sessionId));
      if (integrationVerifier && io.now().getTime() - Date.parse(integrationVerifier.settledAt ?? integrationVerifier.at) > plan.autonomous!.budget.limits.minutesPerAttempt * 60_000) {
        const sessionId = String(integrationVerifier.payload.sessionId);
        const session = map.sessions.find(row => row.id === sessionId);
        const stop = await intend(loc, 'stop-session', integrationVerifier.attemptId, { sessionId });
        await sessionOperation(loc, stop);
        await change(loc, current => halt(current, { ...context(current, at()), reason: 'stuck', detail: `Integration verifier ${sessionId}: ${session?.stuck ? `stuck ${session.stuck.kind} since ${session.stuck.since}` : 'minutesPerAttempt exceeded'}` }));
        await drainSessions(loc);
        continue;
      }
      const expired = plan.autonomous!.attempts.find(attempt => ['starting', 'running', 'checking'].includes(attempt.status) && io.now().getTime() - Date.parse(attempt.startedAt) > plan.autonomous!.budget.limits.minutesPerAttempt * 60_000);
      if (expired) {
        const session = map.sessions.find(row => row.id === expired.verifier || row.id === expired.worker);
        for (const sessionId of [expired.worker, expired.verifier].filter((id): id is string => id !== null)) {
          const op = await intend(loc, 'stop-session', expired.id, { sessionId });
          await sessionOperation(loc, op);
        }
        await change(loc, (current, draft, letters) => {
          const detail = `${expired.id}: ${session?.stuck ? `stuck ${session.stuck.kind} since ${session.stuck.since}` : 'minutesPerAttempt exceeded'}`;
          const next = halt(current, { ...context(current, at()), reason: 'stuck', detail });
          const room = draft.rooms.find(row => row.id === next.roomId)!;
          const lead = liveLead(draft, room);
          if (lead) parleyNote(draft, letters, room.id, lead, detail, at());
          return next;
        });
        await drainSessions(loc);
        continue;
      }
      if (plan.autonomous!.integration.candidateHead) {
        await integrateQueue(loc, true);
        plan = await load(loc);
        if (plan.autonomous!.halted || plan.autonomous!.integration.candidateHead) continue;
      }
      await initialize(loc);
      plan = await load(loc);
      if (plan.autonomous!.halted) { await drainSessions(loc); continue; }
      for (const attempt of plan.autonomous!.attempts) {
        if (stopped) return;
        if (attempt.status === 'running' && attempt.submissionKey && !attempt.receipt) await finishSubmission(loc, attempt.id);
        else if (['submitted', 'checking'].includes(attempt.status)) await checkAttempt(loc, attempt.id);
        else if (attempt.status === 'starting') await spawn(loc, attempt.id, 'worker');
      }
      plan = await load(loc);
      if (plan.autonomous!.halted) { await drainSessions(loc); continue; }
      await mirrorIntegration(loc);
      await cleanupIntegrated(loc);
      await startReady(loc, true);
      await integrateQueue(loc);
      plan = await load(loc);
      if (planItemsComplete(plan)) { await complete(loc); continue; }
      if (plan.autonomous!.integration.candidateHead || plan.autonomous!.integration.suspended) continue;
      await startReady(loc);
    }
  }
  async function startReady(loc: Location, abortedOnly = false): Promise<void> {
    let plan = await load(loc);
    for (const item of plan.items.filter(row => ['ready', 'returned'].includes(row.status))) {
      plan = await load(loc);
      const a = plan.autonomous!;
      if (stopped || a.halted || a.integration.candidateHead || a.integration.suspended) return;
      if (abortedOnly && a.attempts.findLast(attempt => attempt.item === item.id)?.status !== 'aborted') continue;
      // Verifier sessions share the same concurrent budget as executors.
      const running = a.ops.filter(op => op.kind === 'launch' && op.state === 'done' && !a.ops.some(end => ['stop-session', 'close-session'].includes(end.kind) && end.state === 'done' && end.payload.sessionId === op.payload.sessionId)).length;
      if (running >= a.budget.limits.concurrent) return;
      const nextId = `at-${String(a.seq.attempt + 1).padStart(4, '0')}`;
      plan = await change(loc, current => startAttempt(current, { ...context(current, at()), item: item.id, baseSha: current.autonomous!.integration.verifiedHead, branch: `attempts/${nextId}` }));
      if (!plan.autonomous!.halted) await spawn(loc, nextId, 'worker');
    }
  }
  async function processWork(projectPath: string, workId: string, manual = false): Promise<void> {
    if (!started) throw new Error('engine-recovering');
    const current = state(projectPath, workId);
    if (current.recovering.size) {
      if (!manual && io.now().getTime() < current.retryAt) return;
      try {
        for (const planId of current.recovering) {
          await recover({ projectPath, workId, planId });
          current.recovering.delete(planId);
        }
        current.recoveryFailures = 0;
        current.retryAt = 0;
      } catch (error) {
        current.retryAt = io.now().getTime() + Math.min(30_000, 1000 * 2 ** Math.min(current.recoveryFailures++, 5));
        throw error;
      }
    }
    await cycle(projectPath, workId);
  }
  function schedule(projectPath: string, workId: string) {
    const current = state(projectPath, workId);
    if (current.scheduled || stopped) return;
    current.scheduled = true;
    void exclusive(projectPath, workId, async () => {
      current.scheduled = false;
      await processWork(projectPath, workId);
    }).catch(error => options.onFailure?.(error));
  }
  return {
    start() {
      if (off || stopped || !options.works) return;
      // Snapshot plans before subscribing: plans accepted later are Go, not restarts.
      for (const entry of options.works.snapshot().entries) {
        for (const plan of entry.map.plans?.filter(active) ?? []) {
          state(entry.projectPath, entry.map.work.id).recovering.add(plan.id);
        }
      }
      started = true;
      const scan = () => { for (const entry of options.works!.snapshot().entries) if (entry.map.plans?.some(active)) schedule(entry.projectPath, entry.map.work.id); };
      off = options.works.onChange(scan);
      const poll = () => { if (stopped) return; scan(); timer = setTimeout(poll, 1000); timer.unref?.(); };
      poll();
    },
    async stop() { stopped = true; off?.(); if (timer) clearTimeout(timer); await Promise.allSettled([...states.values()].map(value => value.tail)); },
    flush: (projectPath, workId) => exclusive(projectPath, workId, () => processWork(projectPath, workId, true)),
    cancel: input => exclusive(input.projectPath, input.workId, async () => {
      const { projectPath, workId, planId, rev } = input;
      requireRecovered(projectPath, workId);
      const map = await io.readMap(projectPath, workId);
      const plan = map.plans?.find(row => row.id === planId);
      if (!plan || plan.rev !== rev) throw new PlanConflictError();
      if (plan.status === 'cancelled') return;
      const loc = { projectPath, workId, planId };
      await change(loc, current => {
        if (current.rev !== rev) throw new PlanConflictError();
        let next = halt(current, { ...context(current, at()), reason: 'human', detail: 'cancelled by human: cleanup pending' });
        // No effect is in flight under the engine's work queue. Cancellation fences all
        // other intentions; stop/close and cleanup remain durable work before terminal CAS.
        for (const op of next.autonomous!.ops.filter(op => op.state === 'intended' && !['stop-session', 'close-session'].includes(op.kind)))
          next = settleOp(next, { ...context(next, at()), key: op.key, outcome: 'failed', result: { reason: 'cancelled by human' } });
        return next;
      });
      await drainSessions(loc);
      await cleanupPlan(loc, true);
      await io.updateMap(projectPath, workId, (draft, letters) => {
        const current = draft.plans?.find(row => row.id === planId);
        if (!current || current.rev !== rev || !current.autonomous?.halted?.detail.startsWith('cancelled by human') ||
          current.autonomous.ops.some(op => op.state === 'intended')) throw new PlanConflictError();
        cancelRoomPlan(draft, letters, planId, rev, HUMAN, at());
      });
    }),
    async submit(ref, planId, rev, request) {
      if (recovering(ref.projectPath, ref.workId)) return denied(new Error('engine-recovering'));
      return exclusive(ref.projectPath, ref.workId, async () => {
        const loc = { projectPath: ref.projectPath, workId: ref.workId, planId };
        try {
          requireRecovered(ref.projectPath, ref.workId);
          await change(loc, plan => {
            const attempt = attemptOf(plan, request.attemptId);
            if (ref.sessionId !== attempt.worker) throw new Error('not-worker');
            if (['aborted', 'superseded'].includes(attempt.status)) throw new Error('attempt-fenced');
            if (plan.rev !== rev) throw new Error('rev-conflict');
            const submission = normalizeAttemptSubmission({ ...request, manifest: { ...request.manifest, sha: null } });
            if (attempt.receipt) {
              if (attempt.submissionKey !== submission.submissionKey) throw new Error('handoff-conflict');
              return plan;
            }
            if (fenced.has(attempt.status)) throw new Error('attempt-fenced');
            if (attempt.status !== 'running') throw new Error('attempt-not-running');
            if (request.manifest.criteriaVersion !== plan.autonomous!.criteriaVersion[attempt.item]) throw new Error('criteria-version-stale');
            if (request.manifest.text.length > 4096) throw new Error('invalid manifest');
            return submitAttempt(plan, { ...context(plan, at()), attemptId: request.attemptId, ...submission });
          });
          let plan = await load(loc);
          if (attemptOf(plan, request.attemptId).status === 'superseded') return denied(new Error('attempt-superseded'));
          if (!attemptOf(plan, request.attemptId).receipt) await finishSubmission(loc, request.attemptId);
          plan = await load(loc);
          const attempt = attemptOf(plan, request.attemptId);
          return { ok: true, result: { receipt: attempt.receipt, submissionKey: attempt.submissionKey } };
        } catch (error) { return denied(error); }
      });
    },
    async verify(ref, planId, rev, request) {
      if (recovering(ref.projectPath, ref.workId)) return denied(new Error('engine-recovering'));
      return exclusive(ref.projectPath, ref.workId, async () => {
        const loc = { projectPath: ref.projectPath, workId: ref.workId, planId };
        try {
          requireRecovered(ref.projectPath, ref.workId);
          const current = await load(loc);
          if (current.autonomous!.integration.candidateHead !== null && ['queued', 'integrated'].includes(attemptOf(current, request.attemptId).status)) return await verifyIntegration(loc, ref.sessionId, rev, request);
          let result!: CheckResult;
          let operation!: AutonomousOp;
          await change(loc, plan => {
            const attempt = attemptOf(plan, request.attemptId);
            if (ref.sessionId !== attempt.verifier) throw new Error('not-attempt-verifier');
            if (plan.rev !== rev || attempt.criteriaVersion !== plan.autonomous!.criteriaVersion[attempt.item]) throw new Error('stale-criteria');
            if (request.sha !== attempt.sha) throw new Error('sha-mismatch');
            if (!['submitted', 'checking'].includes(attempt.status)) throw new Error('attempt-fenced');
            if (!plan.autonomous!.coverage[attempt.item]?.[request.criterion]?.includes('verifier')) throw new Error('criterion-not-covered');
            const existing = thisResults(plan, attempt).find(row => row.specId === `verifier:${request.criterion}`);
            if (existing) {
              if (existing.verdict !== request.verdict || existing.summary !== request.note) throw new Error('check-conflict');
              result = existing; return plan;
            }
            result = { id: nextCheckId(plan), specId: `verifier:${request.criterion}`, attemptId: attempt.id, sha: request.sha, argvHash: hash([]), envHash: hash({}), inputsOk: true, verdict: request.verdict, by: ref.sessionId, exitCode: null, summary: request.note, outputTail: null, at: at(), durationMs: 0 };
            const next = intendOp(plan, { ...context(plan, at()), kind: 'check', attemptId: attempt.id, payload: { phase: 'attempt', sha: request.sha, criterion: request.criterion, criteriaVersion: attempt.criteriaVersion, resultId: result.id } });
            operation = next.autonomous!.ops.at(-1)!;
            return next;
          });
          if (operation) await record(loc, request.attemptId, operation, result);
          await checkAttempt(loc, request.attemptId);
          return { ok: true, result: { check: result.id } };
        } catch (error) { return denied(error); }
      });
    },
  };
}
