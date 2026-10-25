import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { addRoom, addSession, ENGINE, HUMAN, readMap, resolveProposal, workPaths } from '@parley/core';
import type { AttemptChannelRequest, PlanAttempt, WorkMap } from '@parley/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { attemptsEngineGitPath, createAttemptsEndpoint, type AttemptsEngine } from './attempts-endpoint.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  : JSON.stringify(value)!;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function proposal(text = 'Implement the plan'): Extract<AttemptChannelRequest, { action: 'propose-plan' }> {
  const plan: Extract<AttemptChannelRequest, { action: 'propose-plan' }>['plan'] = {
    mode: 'autonomous' as const, goal: 'A verified change',
    items: [{ id: 1, title: 'Change', owner: ENGINE, verifier: ENGINE, scope: 'src', criteria: ['Works'] }],
    autonomous: {
      budget: { attemptsPerItem: 3, repairWaves: 4, minutesPerAttempt: 30, sessions: 10, concurrent: 2 },
      checks: [{ id: 'test', item: 1, argv: ['node', 'test.js'], cwd: '.', env: {}, inputs: ['test.js'], timeoutMs: 1000 }],
      coverage: { 1: { 0: ['test', 'verifier'] } },
    },
  };
  return keyed({ action: 'propose-plan', roomId: 'r-01', text, requestKey: '', plan });
}
function keyed(body: Extract<AttemptChannelRequest, { action: 'propose-plan' }>) {
  return { ...body, requestKey: digest({ roomId: body.roomId, planId: body.planId ?? null, rev: body.rev ?? null, text: body.text, draft: body.plan }) };
}
async function setup(withEngine = true) {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'attempts-endpoint-')); dirs.push(projectPath);
  const git = async (...args: string[]) => (await run('git', ['-c', 'core.fsmonitor=false', '-C', projectPath, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await writeFile(path.join(projectPath, 'test.js'), 'console.log("pass");\n');
  await git('add', 'test.js');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial fixture');
  const baseSha = await git('rev-parse', 'HEAD');
  const map: WorkMap = { schemaVersion: 2, work: { id: 'w-01', title: 'Fixture', goal: '', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, sessions: [], rooms: [], messages: [] };
  for (const label of ['Lead', 'Worker', 'Verifier', 'Other', 'Integration']) addSession(map, { provider: 'codex', label, task: label });
  addRoom(map, { creator: HUMAN, title: 'Plan', members: ['s-01', 's-02', 's-03', 's-05'], lead: 's-01', mode: 'autonomous' });
  const file = workPaths(projectPath, 'w-01').map;
  await mkdir(path.dirname(file), { recursive: true });
  const save = (value: WorkMap) => writeFile(file, JSON.stringify(value));
  await save(map);
  const ref = { projectPath, workId: 'w-01', sessionId: 's-01' };
  const calls: unknown[][] = [];
  const engine: AttemptsEngine = {
    async submit(...args) { calls.push(['submit', ...args]); return { ok: true, result: { receipt: 'from-engine' } }; },
    async verify(...args) { calls.push(['verify', ...args]); return { ok: true, result: { recorded: true } }; },
  };
  const registry = createBrowserEndpoint({ log: { info() {}, warn() {}, error() {} }, clients: () => [], roomsOf: () => [] });
  const endpoint = createAttemptsEndpoint({ authenticate: req => registry.authenticate(req), ...(withEngine ? { engine } : {}) });
  const tokens = Object.fromEntries(map.sessions.map(session => [session.id, registry.register({ ...ref, sessionId: session.id })]));
  // Drive the authenticated HTTP handler directly, as in autonomous-cycle, without sockets.
  const post = (body: unknown, session = 's-01') => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = Object.assign(Readable.from([data]), { method: 'POST', headers: { authorization: `Bearer ${tokens[session] ?? session}`, 'content-length': String(data.length) } });
    let status = 200;
    const res = {
      writableEnded: false, destroyed: false,
      writeHead(code: number) { status = code; },
      end(text?: string) { this.writableEnded = true; resolve({ status, body: text ? JSON.parse(text) : null }); },
    };
    req.on('error', reject);
    endpoint.handle(req as IncomingMessage, res as unknown as ServerResponse);
  });
  const read = () => readMap(projectPath, 'w-01');
  async function active() {
    await post(proposal());
    const value = await read();
    const plan = structuredClone(value.rooms[0]!.proposal!.plan!);
    plan.status = 'active'; plan.rev = 1; plan.acceptedAt = new Date().toISOString();
    plan.items[0]!.status = 'in_progress';
    value.plans = [plan]; value.rooms[0]!.proposal = null;
    await save(value); return { value, plan };
  }
  return { projectPath, git, baseSha, map, save, read, post, calls, ref, registry, active, raw: () => readFile(file, 'utf8') };
}
function handoff(criteriaVersion = 1) {
  const body = { version: 1 as const, criteriaVersion, dependsOn: [], coverage: 'covered' as const, scope: 'src', facts: ['Works'], hypotheses: [], notFound: [], gaps: [], text: 'Done', artifacts: [], submittedAt: new Date().toISOString() };
  const manifest = { ...body, hash: digest({ ...body, sha: null }) };
  return { action: 'submit' as const, attemptId: 'at-0001', submissionKey: digest(manifest), manifest };
}
function attempt(baseSha: string): PlanAttempt {
  return { id: 'at-0001', item: 1, n: 1, planRev: 1, criteriaVersion: 1, worker: 's-02', verifier: 's-03', branch: 'attempt', baseSha, sha: null, tree: null, submissionKey: null, status: 'running', manifest: null, receipt: null, checks: [], failureSignature: null, startedAt: new Date().toISOString(), endedAt: null, log: [] };
}
async function checking(f: Awaited<ReturnType<typeof setup>>) {
  await run('git', ['clone', '--bare', '--no-hardlinks', f.projectPath, attemptsEngineGitPath(f.projectPath, 'w-01')]);
  const { value, plan } = await f.active();
  const entry = attempt(f.baseSha), submission = handoff();
  entry.status = 'checking'; entry.sha = f.baseSha; entry.tree = await f.git('rev-parse', 'HEAD^{tree}');
  entry.submissionKey = submission.submissionKey; entry.manifest = { ...submission.manifest, sha: f.baseSha };
  entry.receipt = { id: 'rc-0001', attemptId: entry.id, manifestHash: entry.manifest.hash, sha: f.baseSha, criteriaVersion: 1, valid: true, reason: null, at: new Date().toISOString() };
  plan.autonomous!.attempts = [entry]; await f.save(value);
  return { value, plan, entry, submission, verify: { action: 'verify' as const, attemptId: entry.id, sha: f.baseSha, criterion: 0, verdict: 'pass' as const, note: 'Observed' } };
}

describe('agent attempts endpoint', () => {
  it('freezes base and blob facts in one proposal without starting execution', async () => {
    const f = await setup();
    expect((await f.post(proposal())).body).toEqual({ ok: true, result: { proposalId: 'p-01', rev: 0 } });
    const value = await f.read(), plan = value.rooms[0]!.proposal!.plan!;
    expect(plan.items[0]).toMatchObject({ owner: ENGINE, verifier: ENGINE });
    expect(plan.autonomous).toMatchObject({ criteriaVersion: { 1: 1 }, attempts: [], ops: [], halted: null, seq: { attempt: 0, receipt: 0, check: 0, op: 0 }, budget: { spent: { attempts: 0, repairWaves: 0, sessions: 0, verifiers: 0, minutes: 0, launches: 0 }, reservations: [] }, integration: { branch: 'parley/w-01/integration/pl-01', baseSha: f.baseSha, verifiedHead: f.baseSha, candidateHead: null, queue: [], suspended: null } });
    expect(plan.autonomous!.checks[0]!.inputs).toEqual([{ path: 'test.js', blob: await f.git('rev-parse', `${f.baseSha}:test.js`) }]);
    expect(Number.isFinite(Date.parse(plan.autonomous!.checks[0]!.frozenAt))).toBe(true);
    expect(await f.git('branch', '--format=%(refname:short)')).toBe('main');
    expect(value.sessions).toHaveLength(5); expect(value.plans).toEqual([]); expect(f.calls).toEqual([]);
    await writeFile(path.join(f.projectPath, 'test.js'), 'changed\n'); await f.git('add', 'test.js');
    await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Move base');
    resolveProposal(value, 'r-01', 'p-01', 'accept', { rev: 0, planId: plan.id, planRev: plan.rev });
    expect(value.plans![0]!.autonomous).toEqual(plan.autonomous);
  });
  it('retries an open proposal exactly, replaces changed text, and starts a new round after return', async () => {
    const f = await setup(), body = proposal();
    const first = await f.post(body), before = await f.raw();
    expect(await f.post(body)).toEqual(first); expect(await f.raw()).toBe(before);
    expect((await f.post(proposal('Revised wording'))).body.result).toEqual({ proposalId: 'p-01', rev: 1 });
    let value = await f.read(); expect(value.rooms[0]!.proposal!.text).toBe('Revised wording');
    resolveProposal(value, 'r-01', 'p-01', 'return', { rev: 1, planId: value.rooms[0]!.proposal!.plan!.id, planRev: value.rooms[0]!.proposal!.plan!.rev }); await f.save(value);
    expect((await f.post(body)).body.result).toEqual({ proposalId: 'p-02', rev: 0 });
    value = await f.read(); expect(value.rooms[0]!.proposal!.plan!.id).toBe('pl-02');
  });
  it('coalesces concurrent retries under the map lock', async () => {
    const f = await setup();
    const responses = await Promise.all([f.post(proposal()), f.post(proposal())]);
    expect(responses[0]).toEqual(responses[1]);
    expect((await f.read()).work.proposalSeq).toBe(1);
  });
  it.each(['missing', 's-04', 's-02'])('rejects unauthorized proposals from %s without mutations', async session => {
    const f = await setup(), before = await f.raw();
    expect((await f.post(proposal(), session)).body?.ok ?? false).toBe(false);
    expect(await f.raw()).toBe(before); expect(f.calls).toEqual([]);
  });
  it('rejects a revoked bearer without mutations', async () => {
    const f = await setup(), before = await f.raw();
    f.registry.unregister(f.ref);
    expect((await f.post(proposal())).status).toBe(401);
    expect(await f.raw()).toBe(before); expect(f.calls).toEqual([]);
  });
  it.each(['closed', 'missing', 'free', 'archived', 'inactive', 'wrong-work'])('rejects stale authority (%s) without mutations', async reason => {
    const f = await setup();
    if (reason === 'closed') f.map.sessions[0]!.lifecycle = 'closed';
    if (reason === 'missing') f.map.sessions.shift();
    if (reason === 'free') f.map.rooms[0]!.mode = 'free';
    if (reason === 'archived') f.map.rooms[0]!.archivedAt = new Date().toISOString();
    if (reason === 'inactive') f.map.work.status = 'completed';
    if (reason === 'wrong-work') f.map.work.id = 'w-other';
    await f.save(f.map); const before = await f.raw();
    expect((await f.post(proposal())).body.ok).toBe(false); expect(await f.raw()).toBe(before);
  });
  it('rejects missing and non-file frozen inputs without a partial proposal', async () => {
    const f = await setup();
    for (const input of ['missing.js', '.', '../test.js', '/test.js']) {
      const body = proposal(); body.plan.autonomous.checks[0]!.inputs = [input];
      const before = await f.raw();
      expect((await f.post(keyed(body))).body.error.code).toBe('bad-input'); expect(await f.raw()).toBe(before);
    }
  });
  it('rejects malformed bodies, unknown fields, forged keys and incomplete coverage', async () => {
    const f = await setup(), body = proposal(), before = await f.raw();
    const uncovered = proposal(); uncovered.plan.autonomous.coverage = {};
    for (const invalid of [null, [], { ...body, projectPath: '/foreign' }, { ...body, requestKey: '0'.repeat(64) }, keyed(uncovered), { action: 'verify', attemptId: 'at-0001', sha: 'HEAD', criterion: -1, verdict: 'pass', note: '' }, { ...handoff(), manifest: { ...handoff().manifest, sha: f.baseSha } }]) {
      expect((await f.post(invalid)).body.ok).toBe(false); expect(await f.raw()).toBe(before);
    }
    expect((await f.post({ ...body, text: 'x'.repeat(70000) })).status).toBe(413);
  });
  it('stores amendments separately and allows replacing a pending amendment at the accepted rev', async () => {
    const f = await setup(), { value, plan } = await f.active();
    plan.autonomous!.attempts = [attempt(f.baseSha)]; plan.autonomous!.budget.spent.attempts = 1;
    await f.save(value); const saved = structuredClone(plan.autonomous);
    const body = proposal(); body.planId = plan.id; body.rev = plan.rev; body.plan.id = plan.id; body.plan.rev = plan.rev;
    expect((await f.post(keyed(body))).body.result).toEqual({ proposalId: 'p-02', rev: 0 });
    body.text = 'Amended wording';
    expect((await f.post(keyed(body))).body.result).toEqual({ proposalId: 'p-02', rev: 1 });
    const after = await f.read(); expect(after.plans![0]!.autonomous).toEqual(saved);
    expect(after.rooms[0]!.proposal).toMatchObject({ planId: plan.id, planRev: plan.rev + 1, autonomousAmendment: { planId: plan.id, rev: plan.rev, draft: body.plan.autonomous } });
    body.rev = 0; body.plan.rev = 0; const before = await f.raw();
    expect((await f.post(keyed(body))).body.error.code).toBe('conflict'); expect(await f.raw()).toBe(before);
  });
  it('dispatches a valid worker handoff with authenticated scope and accepted revision', async () => {
    const f = await setup(), { value, plan } = await f.active(), body = handoff();
    plan.autonomous!.attempts = [attempt(f.baseSha)]; await f.save(value); const before = await f.raw();
    expect((await f.post(body, 's-02')).body).toEqual({ ok: true, result: { receipt: 'from-engine', submissionKey: body.submissionKey } });
    expect(f.calls).toEqual([['submit', { ...f.ref, sessionId: 's-02' }, plan.id, 1, body]]); expect(await f.raw()).toBe(before);
  });
  it('normalizes omitted hashes before engine dispatch without writing the map', async () => {
    const f = await setup(), { value, plan } = await f.active();
    plan.autonomous!.attempts = [attempt(f.baseSha)]; await f.save(value);
    const before = await f.raw(), explicit = handoff();
    const { hash: _hash, ...manifest } = explicit.manifest;
    const request = { action: 'submit', attemptId: explicit.attemptId, manifest };
    for (const body of [request, { ...request, submissionKey: explicit.submissionKey }, explicit]) {
      expect((await f.post(body, 's-02')).body).toEqual({ ok: true, result: { receipt: 'from-engine', submissionKey: explicit.submissionKey } });
      expect(f.calls.at(-1)).toEqual(['submit', { ...f.ref, sessionId: 's-02' }, plan.id, plan.rev, explicit]);
      expect(await f.raw()).toBe(before);
    }
    const calls = f.calls.length;
    for (const body of [
      { ...request, manifest: { ...manifest, hash: 'f'.repeat(64) } },
      { ...request, submissionKey: 'f'.repeat(64) },
      { ...request, submissionKey: explicit.submissionKey, manifest: { ...manifest, text: 'Changed' } },
    ]) {
      expect((await f.post(body, 's-02')).body.ok).toBe(false);
      expect(f.calls).toHaveLength(calls); expect(await f.raw()).toBe(before);
    }
  });

  it('returns an existing receipt on retry without engine dispatch', async () => {
    const f = await setup(), { entry, submission } = await checking(f), before = await f.raw();
    const { hash: _hash, ...manifest } = submission.manifest;
    for (const body of [submission, { action: 'submit', attemptId: entry.id, manifest }, { action: 'submit', attemptId: entry.id, manifest, submissionKey: submission.submissionKey }]) {
      expect((await f.post(body, 's-02')).body).toEqual({ ok: true, result: { ...entry.receipt, submissionKey: submission.submissionKey } });
    }
    expect(f.calls).toEqual([]); expect(await f.raw()).toBe(before);
    expect((await f.post(handoff(2), 's-02')).body.error.code).toBe('handoff-conflict');
  });
  it.each(['aborted', 'superseded', 'returned', 'blocked'] as const)('fences late submissions in %s, including receipt retries', async status => {
    const f = await setup(), { value, entry, submission } = await checking(f);
    entry.status = status; await f.save(value); const before = await f.raw();
    expect((await f.post(submission, 's-02')).body.error.code).toBe('attempt-fenced'); expect(f.calls).toEqual([]); expect(await f.raw()).toBe(before);
  });
  it('rejects foreign attempts and stale criteria without engine calls or writes', async () => {
    const f = await setup(), { value, plan } = await f.active(); plan.autonomous!.attempts = [attempt(f.baseSha)]; await f.save(value);
    const before = await f.raw();
    for (const [body, session, code] of [[handoff(), 's-03', 'forbidden'], [handoff(), 's-04', 'forbidden'], [{ ...handoff(), attemptId: 'at-9999' }, 's-02', 'forbidden'], [handoff(2), 's-02', 'stale-criteria']] as const) {
      expect((await f.post(body, session)).body.error.code).toBe(code); expect(await f.raw()).toBe(before);
    }
    expect(f.calls).toEqual([]);
  });
  it('checks verifier assignment and exact descendant SHA before engine dispatch', async () => {
    const f = await setup(), { plan, verify } = await checking(f), before = await f.raw();
    expect((await f.post(verify, 's-02')).body.error.code).toBe('forbidden');
    expect((await f.post({ ...verify, sha: 'f'.repeat(40) }, 's-03')).body.error.code).toBe('bad-sha');
    expect((await f.post(verify, 's-03')).body).toEqual({ ok: true, result: { recorded: true } });
    expect(f.calls).toEqual([['verify', { ...f.ref, sessionId: 's-03' }, plan.id, 1, verify]]); expect(await f.raw()).toBe(before);
  });
  it('authorizes only the current settled integration verifier for the candidate SHA', async () => {
    const f = await setup(), { value, plan, entry, verify } = await checking(f);
    const auto = plan.autonomous!; entry.status = 'queued'; auto.integration.queue = [entry.id]; auto.integration.candidateHead = f.baseSha;
    const at = new Date().toISOString();
    auto.ops = [
      { key: 'op-0001', kind: 'noop-integration', attemptId: entry.id, payload: { verifiedHead: f.baseSha }, state: 'done', at, settledAt: at, result: { sha: f.baseSha } },
      { key: 'op-0002', kind: 'create-session', attemptId: entry.id, payload: { role: 'verifier', purpose: 'integration-verifier', phase: 'integration', integrationOp: 'op-0001', sha: f.baseSha }, state: 'done', at, settledAt: at, result: { sessionId: 's-05' } },
    ];
    await f.save(value); const before = await f.raw();
    expect((await f.post(verify, 's-03')).body.error.code).toBe('forbidden');
    expect((await f.post(verify, 's-05')).body.ok).toBe(true);
    expect(await f.raw()).toBe(before);
  });
  it('rejects stale verification criteria and a known SHA outside the base ancestry', async () => {
    const f = await setup(), { value, plan, entry, verify } = await checking(f);
    plan.autonomous!.criteriaVersion[1] = 2; await f.save(value);
    expect((await f.post(verify, 's-03')).body.error.code).toBe('stale-criteria');
    plan.autonomous!.criteriaVersion[1] = 1;
    const repo = attemptsEngineGitPath(f.projectPath, 'w-01');
    const root = (await run('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit-tree', entry.tree!, '-m', 'Unrelated root'])).stdout.trim();
    entry.sha = root; entry.manifest!.sha = root; entry.receipt!.sha = root; await f.save(value);
    const before = await f.raw();
    expect((await f.post({ ...verify, sha: root }, 's-03')).body.error.code).toBe('bad-sha');
    expect(f.calls).toEqual([]); expect(await f.raw()).toBe(before);
  });
  it('requires the engine repository even when the SHA exists in the project', async () => {
    const f = await setup(), { verify } = await checking(f);
    await rm(attemptsEngineGitPath(f.projectPath, 'w-01'), { recursive: true });
    const before = await f.raw();
    expect((await f.post(verify, 's-03')).body.error.code).toBe('engine-unavailable');
    expect(f.calls).toEqual([]); expect(await f.raw()).toBe(before);
  });
  it('fails safely when the engine is not installed', async () => {
    const f = await setup(false), { value, plan } = await f.active(); plan.autonomous!.attempts = [attempt(f.baseSha)]; await f.save(value);
    const before = await f.raw(); expect((await f.post(handoff(), 's-02')).body.error.code).toBe('engine-unavailable'); expect(await f.raw()).toBe(before);
  });
});
