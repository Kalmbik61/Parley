import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  activeRoomPlan, baseBranchOf, ENGINE, isMember, liveLead, PlanConflictError,
  normalizeAttemptSubmission, readMap, requireOpenRoom, setProposal, submitAttempt, updateMap,
  validateAutonomousDraft, workPaths,
} from '@parley/core';
import type {
  AttemptChannelRequest, AutonomousDraft, CheckSpec,
  PlanAttempt, Proposal, RoomPlan, WorkMap,
} from '@parley/core';
import { AGENT_LIMITS, type SessionRef } from '@parley/protocol';

export const AGENT_ATTEMPTS_PATH = '/agent/attempts';
/** The engine owns this bare repository; capture objects need not exist in the project. */
export const attemptsEngineGitPath = (projectPath: string, workId: string): string =>
  path.join(workPaths(projectPath, workId).dir, 'engine.git');

export type AttemptsResult =
  | { ok: true; result: object }
  | { ok: false; error: { code: string; message: string } };
export interface AttemptsEngine {
  // The endpoint performs read-only preflight. The engine must recheck authority, revision
  // and attempt state under updateMap; verify calls recordCheck with real settled-op
  // provenance, which the endpoint cannot manufacture before the engine runs the check.
  submit(ref: SessionRef, planId: string, rev: number, request: Extract<AttemptChannelRequest, { action: 'submit' }>): Promise<AttemptsResult>;
  verify(ref: SessionRef, planId: string, rev: number, request: Extract<AttemptChannelRequest, { action: 'verify' }>): Promise<AttemptsResult>;
}
export type AttemptsProposal = Proposal & {
  requestKey: string;
  /** Apply only on human acceptance, through the engine's amendment rules. */
  autonomousAmendment?: { planId: string; rev: number; draft: AutonomousDraft; checks: CheckSpec[] };
};

const run = promisify(execFile);
const unavailable = (): AttemptsResult => ({ ok: false, error: { code: 'engine-unavailable', message: 'The autonomous engine is not available.' } });
const engineStub: AttemptsEngine = { submit: async () => unavailable(), verify: async () => unavailable() };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 10000, empty = false): value is string => typeof value === 'string' && (empty || !!value.trim()) && value.length <= max && !value.includes('\0') && Buffer.from(value).toString() === value;
const safe = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(code: string, message = code): never { throw Object.assign(new Error(message), { code }); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('bad_request', 'Unknown attempt argument.');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value)!;
}
function manifest(value: unknown): void {
  if (!object(value)) fail('bad_request', 'Invalid handoff manifest.');
  keys(value, ['version', 'criteriaVersion', 'dependsOn', 'coverage', 'scope', 'facts', 'hypotheses', 'notFound', 'gaps', 'text', 'artifacts', 'hash', 'submittedAt']);
  if (value.version !== 1 || !safe(value.criteriaVersion, 1) || (value.hash !== undefined && !hash(value.hash)) ||
    !Array.isArray(value.dependsOn) || value.dependsOn.length > 100 || !value.dependsOn.every(id => text(id, 128) && /^at-\d+$/.test(id)) ||
    !['covered', 'partial', 'failed', 'unstarted'].includes(String(value.coverage)) ||
    !text(value.scope) || !text(value.text, 4096, true) || !text(value.submittedAt) ||
    !['facts', 'hypotheses', 'notFound', 'gaps'].every(key => Array.isArray(value[key]) && value[key].length <= 100 && value[key].every(entry => text(entry))) ||
    !Array.isArray(value.artifacts) || value.artifacts.length > 100) fail('bad_request', 'Invalid handoff manifest.');
  for (const artifact of value.artifacts) {
    if (!object(artifact)) fail('bad_request', 'Invalid handoff artifact.');
    keys(artifact, ['path', 'sha256', 'storedAs']);
    if (!text(artifact.path) || !hash(artifact.sha256) || !text(artifact.storedAs, 10000, true)) fail('bad_request', 'Invalid handoff artifact.');
  }
}
function parseRequest(value: unknown): AttemptChannelRequest {
  if (!object(value)) fail('bad_request', 'Expected attempt arguments.');
  if (value.action === 'propose-plan') {
    keys(value, ['action', 'roomId', 'planId', 'rev', 'requestKey', 'text', 'plan']);
    if (!text(value.roomId, 128) || !/^r-\d+$/.test(value.roomId) || !hash(value.requestKey) || !text(value.text) || !object(value.plan)) fail('bad_request', 'Invalid proposal arguments.');
    keys(value.plan, ['id', 'rev', 'mode', 'goal', 'items', 'backlog', 'autonomous']);
    if ((value.planId !== undefined && (!text(value.planId, 128) || !/^pl-\d+$/.test(value.planId))) ||
      (value.rev !== undefined && !safe(value.rev, 0)) || value.planId !== value.plan.id || value.rev !== value.plan.rev ||
      (value.planId === undefined) !== (value.rev === undefined)) fail('conflict', 'Invalid amendment identity or revision.');
    if (!Array.isArray(value.plan.items)) fail('bad_request', 'Invalid plan items.');
    for (const item of value.plan.items) {
      if (!object(item)) fail('bad_request', 'Invalid plan item.');
      keys(item, ['id', 'title', 'owner', 'scope', 'after', 'criteria', 'verifier']);
    }
    const expected = createHash('sha256').update(canonical({ roomId: value.roomId, planId: value.planId ?? null, rev: value.rev ?? null, text: value.text, draft: value.plan })).digest('hex');
    if (value.requestKey !== expected) fail('bad_request', 'requestKey does not match the proposal.');
  } else if (value.action === 'submit' || value.action === 'verify') {
    if (!text(value.attemptId, 128) || !/^at-\d+$/.test(value.attemptId)) fail('bad_request', 'Invalid attempt identity.');
    if (value.action === 'submit') {
      keys(value, ['action', 'attemptId', 'submissionKey', 'manifest']);
      if (value.submissionKey !== undefined && !hash(value.submissionKey)) fail('bad_request', 'Invalid submissionKey.');
      manifest(value.manifest);
    } else {
      keys(value, ['action', 'attemptId', 'sha', 'criterion', 'verdict', 'note']);
      if (!text(value.sha, 64) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sha) || !safe(value.criterion, 0) || !['pass', 'fail', 'error', 'not_verified'].includes(String(value.verdict)) || !text(value.note)) fail('bad_request', 'Invalid verification arguments.');
    }
  } else fail('bad_request', 'Unknown attempt action.');
  return value as unknown as AttemptChannelRequest;
}
function caller(map: WorkMap, ref: SessionRef): void {
  if (map.work.id !== ref.workId || map.work.status !== 'active' || !map.sessions.some(session => session.id === ref.sessionId && session.lifecycle !== 'closed')) fail('forbidden', 'A live session in this workspace is required.');
}
function proposalRoom(map: WorkMap, ref: SessionRef, request: Extract<AttemptChannelRequest, { action: 'propose-plan' }>) {
  caller(map, ref);
  const room = requireOpenRoom(map, request.roomId);
  if (room.mode !== 'autonomous' || !isMember(room, ref.sessionId) || liveLead(map, room) !== ref.sessionId) fail('forbidden', 'Only the live lead of an autonomous room can propose a plan.');
  validateAutonomousDraft(map, room.id, ref.sessionId, request.plan, request.text.length);
  return room;
}
async function git(repo: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-c', 'core.fsmonitor=false', '-C', repo, ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function freezeChecks(projectPath: string, baseSha: string, draft: AutonomousDraft, now: string): Promise<CheckSpec[]> {
  const checks: CheckSpec[] = [];
  for (const check of draft.checks) {
    const inputs: CheckSpec['inputs'] = [];
    for (const file of check.inputs) {
      if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => part === '..') || path.posix.normalize(file) !== file || file === '.') fail('bad-input', `Invalid frozen input: ${file}`);
      try {
        const blob = await git(projectPath, 'rev-parse', '--verify', `${baseSha}:${file}`);
        if (await git(projectPath, 'cat-file', '-t', blob) !== 'blob') fail('bad-input');
        inputs.push({ path: file, blob });
      } catch { fail('bad-input', `Frozen input is not a file on the base commit: ${file}`); }
    }
    checks.push({ ...structuredClone(check), inputs, frozenAt: now });
  }
  return checks;
}
async function propose(ref: SessionRef, request: Extract<AttemptChannelRequest, { action: 'propose-plan' }>, authenticated: () => boolean): Promise<AttemptsResult> {
  const before = await readMap(ref.projectPath, ref.workId);
  const room = proposalRoom(before, ref, request);
  if (!authenticated()) fail('forbidden', 'The session token was revoked.');
  const retry = (proposal: Proposal | null) => proposal?.from === ref.sessionId && (proposal as AttemptsProposal).requestKey === request.requestKey;
  if (retry(room.proposal)) return { ok: true, result: { proposalId: room.proposal!.id, rev: room.proposal!.rev } };
  const now = new Date().toISOString();
  const baseSha = await git(ref.projectPath, 'rev-parse', '--verify', '--end-of-options', `${await baseBranchOf(ref.projectPath)}^{commit}`);
  const accepted = activeRoomPlan(before, room.id);
  const oldChecks = accepted?.autonomous?.checks;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the key is destructured only to drop it from the copy
  const unchangedChecks = oldChecks && canonical(oldChecks.map(({ inputs, frozenAt: _at, ...check }) => ({ ...check, inputs: inputs.map(input => input.path) }))) === canonical(request.plan.autonomous.checks);
  const checks = unchangedChecks ? structuredClone(oldChecks) : await freezeChecks(ref.projectPath, baseSha, request.plan.autonomous, now);
  let result: { proposalId: string; rev: number } | undefined;
  const unchanged = Symbol('unchanged proposal');
  try {
    await updateMap(ref.projectPath, ref.workId, map => {
      if (!authenticated()) fail('forbidden', 'The session token was revoked.');
      const current = proposalRoom(map, ref, request);
      if (retry(current.proposal)) {
        result = { proposalId: current.proposal!.id, rev: current.proposal!.rev };
        throw unchanged; // Do not rewrite even updatedAt on a retry under the lock.
      }
      result = setProposal(map, current.id, ref.sessionId, request.text, now, { plan: request.plan });
      const proposal = current.proposal as AttemptsProposal;
      proposal.requestKey = request.requestKey;
      const plan = proposal.plan!;
      if (request.planId !== undefined) {
        proposal.planId = request.planId;
        proposal.planRev = plan.rev;
        proposal.autonomousAmendment = { planId: request.planId, rev: request.rev!, draft: structuredClone(request.plan.autonomous), checks };
      } else {
        plan.autonomous = {
          budget: { limits: structuredClone(request.plan.autonomous.budget), spent: { attempts: 0, repairWaves: 0, sessions: 0, verifiers: 0, minutes: 0, launches: 0 }, reservations: [] },
          checks, coverage: structuredClone(request.plan.autonomous.coverage),
          criteriaVersion: Object.fromEntries(plan.items.map(item => [item.id, 1])),
          integration: { branch: `parley/${ref.workId}/integration/${plan.id}`, baseSha, verifiedHead: baseSha, candidateHead: null, queue: [], suspended: null },
          attempts: [], ops: [], halted: null, seq: { attempt: 0, receipt: 0, check: 0, op: 0 },
        };
      }
    });
  } catch (error) { if (error !== unchanged) throw error; }
  return { ok: true, result: result! };
}
function assignedAttempt(map: WorkMap, ref: SessionRef, attemptId: string): { plan: RoomPlan; attempt: PlanAttempt } {
  caller(map, ref);
  const plans = (map.plans ?? []).filter(plan => plan.mode === 'autonomous' && map.rooms.some(room =>
    room.id === plan.roomId && room.mode === 'autonomous' && isMember(room, ref.sessionId) &&
    (activeRoomPlan(map, room.id) ?? map.plans?.findLast(row => row.roomId === room.id))?.id === plan.id,
  ) && plan.autonomous?.attempts.some(attempt => attempt.id === attemptId));
  if (plans.length !== 1) fail('forbidden', 'The attempt is not in this session’s plan room.');
  const plan = plans[0]!;
  requireOpenRoom(map, plan.roomId);
  return { plan, attempt: plan.autonomous!.attempts.find(attempt => attempt.id === attemptId)! };
}
function currentIntegrationVerifier(plan: RoomPlan, attempt: PlanAttempt, sha: string): string | null {
  const a = plan.autonomous!, i = a.integration;
  const merge = a.ops.findLast(op => ['merge', 'noop-integration'].includes(op.kind) && op.state === 'done' && op.attemptId === i.queue[0] && i.candidateHead !== null && op.result?.sha === i.candidateHead && op.payload.verifiedHead === i.verifiedHead);
  if (!merge || i.candidateHead !== sha || !['queued', 'integrated'].includes(attempt.status)) return null;
  const resume = a.ops.findLastIndex(op => op.kind === 'resume');
  const creation = a.ops.findLast((op, index) => index > resume && op.kind === 'create-session' && op.attemptId === merge.attemptId && op.payload.role === 'verifier' && op.payload.purpose === 'integration-verifier' && op.payload.phase === 'integration' && op.payload.integrationOp === merge.key && op.payload.sha === sha && op.state !== 'failed');
  return creation?.state === 'done' && typeof creation.result?.sessionId === 'string' ? creation.result.sessionId : null;
}
async function handoff(ref: SessionRef, request: Exclude<AttemptChannelRequest, { action: 'propose-plan' }>, engine: AttemptsEngine, authenticated: () => boolean): Promise<AttemptsResult> {
  const map = await readMap(ref.projectPath, ref.workId);
  if (!authenticated()) fail('forbidden', 'The session token was revoked.');
  const { plan, attempt } = assignedAttempt(map, ref, request.attemptId);
  const a = plan.autonomous!;
  if (request.action === 'submit' ? attempt.worker !== ref.sessionId :
    ref.sessionId === attempt.worker || (['queued', 'integrated'].includes(attempt.status)
      ? currentIntegrationVerifier(plan, attempt, request.sha) !== ref.sessionId
      : attempt.verifier !== ref.sessionId)) fail('forbidden', 'This session is not assigned to this attempt operation.');
  if (['aborted', 'superseded', 'returned', 'blocked'].includes(attempt.status)) fail('attempt-fenced');
  if (request.action === 'submit') {
    const submission = normalizeAttemptSubmission({ ...request, manifest: { ...request.manifest, sha: null } });
    const next = submitAttempt(plan, { actor: ENGINE, rev: plan.rev, now: new Date().toISOString(), attemptId: attempt.id, ...submission });
    // submitAttempt is pure: inspect its fenced result, never persist its stop/capture intent here.
    if (attempt.submissionKey !== null && attempt.receipt) return { ok: true, result: { ...attempt.receipt, submissionKey: submission.submissionKey } };
    if (attempt.criteriaVersion !== a.criteriaVersion[attempt.item] || request.manifest.criteriaVersion !== a.criteriaVersion[attempt.item]) fail('stale-criteria');
    const preflight = next.autonomous!.attempts.find(entry => entry.id === attempt.id)!;
    if (preflight.status === 'superseded') fail('attempt-fenced', preflight.log.at(-1)?.note ?? 'attempt-fenced');
    if (next.autonomous!.halted) fail('attempt-fenced', 'The attempt has exceeded its execution limits.');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the key is destructured only to drop it from the copy
    const { sha: _sha, ...normalizedManifest } = submission.manifest;
    const result = await engine.submit(ref, plan.id, plan.rev, { ...request, submissionKey: submission.submissionKey, manifest: normalizedManifest });
    return result.ok ? { ok: true, result: { ...result.result, submissionKey: submission.submissionKey } } : result;
  }
  if (!['active', 'completing'].includes(plan.status) || a.halted || !['submitted', 'checking', 'accepted', 'queued', 'integrated'].includes(attempt.status) || !attempt.receipt?.valid || !attempt.manifest) fail('attempt-fenced');
  if (attempt.criteriaVersion !== a.criteriaVersion[attempt.item] || attempt.manifest.criteriaVersion !== a.criteriaVersion[attempt.item]) fail('stale-criteria');
  if (request.criterion >= (plan.items.find(item => item.id === attempt.item)?.criteria.length ?? 0) || !a.coverage[attempt.item]?.[request.criterion]?.includes('verifier')) fail('bad_request', 'This criterion does not require a verifier.');
  const expectedSha = ['queued', 'integrated'].includes(attempt.status) ? a.integration.candidateHead : attempt.sha;
  if (request.sha !== expectedSha) fail('bad-sha', 'The verdict must target the assigned SHA.');
  const repo = attemptsEngineGitPath(ref.projectPath, ref.workId);
  try { if (!(await stat(repo)).isDirectory()) return unavailable(); } catch { return unavailable(); }
  try { await git(repo, 'merge-base', '--is-ancestor', attempt.baseSha, request.sha); } catch { fail('bad-sha', 'The verdict SHA is not a descendant of the attempt base.'); }
  if (!authenticated()) fail('forbidden', 'The session token was revoked.');
  return engine.verify(ref, plan.id, plan.rev, request);
}

export function createAttemptsEndpoint(options: {
  authenticate(req: IncomingMessage): SessionRef | undefined;
  engine?: AttemptsEngine;
}) {
  const refusal = (error: unknown): AttemptsResult => {
    const message = error instanceof Error ? error.message : String(error);
    const ruleCode = ['attempt-fenced', 'handoff-conflict', 'stale-criteria', 'bad-sha', 'attempt-not-running', 'attempt-not-checkable'].includes(message) ? message : 'bad_request';
    return { ok: false, error: { code: error instanceof PlanConflictError ? 'conflict' : error instanceof Error && 'code' in error ? String(error.code) : ruleCode, message } };
  };
  const perform = async (ref: SessionRef, value: unknown, authenticated: () => boolean): Promise<AttemptsResult> => {
    try {
      if (!authenticated()) fail('forbidden', 'The session token was revoked.');
      const request = parseRequest(value);
      return await (request.action === 'propose-plan' ? propose(ref, request, authenticated) : handoff(ref, request, options.engine ?? engineStub, authenticated));
    } catch (error) {
      return refusal(error);
    }
  };
  return {
    perform,
    handle(req: IncomingMessage, res: ServerResponse): void {
      const refuse = (status: number): void => { res.writeHead(status, { Connection: 'close' }); res.end(); req.resume(); };
      const reply = (body: AttemptsResult): void => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      };
      const ref = options.authenticate(req);
      if (!ref) return refuse(401);
      if (req.method !== 'POST') return refuse(405);
      if (Number(req.headers['content-length'] ?? 0) > AGENT_LIMITS.requestBytes) return refuse(413);
      let size = 0, rejected = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > AGENT_LIMITS.requestBytes) { rejected = true; chunks.length = 0; refuse(413); return; }
        chunks.push(chunk);
      });
      req.on('error', () => { rejected = true; });
      req.on('end', () => {
        if (rejected) return;
        void (async () => {
          try {
            const authenticated = () => {
              const current = options.authenticate(req);
              return current?.projectPath === ref.projectPath && current?.workId === ref.workId && current?.sessionId === ref.sessionId;
            };
            if (!authenticated()) return refuse(401);
            reply(await perform(ref, JSON.parse(Buffer.concat(chunks).toString('utf8')), authenticated));
          } catch (error) {
            reply(refusal(error));
          }
        })();
      });
    },
  };
}
