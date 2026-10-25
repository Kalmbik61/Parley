import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  addRoom, addSession, archiveRoom, createParleyServer, ENGINE, HUMAN, readMap, summarizePlanEffects, updateMap, workPaths,
  type AttemptChannelRequest, type CheckResult, type RoomPlan, type WorkMap,
} from '@parley/core';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptsEngineGitPath, createAttemptsEndpoint, type AttemptsResult } from '../agent/attempts-endpoint.js';
import { createBrowserEndpoint } from '../agent/browser-endpoint.js';
import { createPlanHandlers } from '../methods/rooms.js';
import { autonomousEngineIO, createAutonomousEngine, type AutonomousEngine } from './autonomous-engine.js';
import { resolveRoomProposal, resumeAutonomousPlan } from './rooms-service.js';

const exec = promisify(execFile);
const dirs: string[] = [];
const engines: AutonomousEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  : JSON.stringify(value)!;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
type ProposalRequest = Extract<AttemptChannelRequest, { action: 'propose-plan' }>;
type Submission = Extract<AttemptChannelRequest, { action: 'submit' }>;
const keyed = (body: ProposalRequest): ProposalRequest => ({ ...body, requestKey: digest({ roomId: body.roomId, planId: body.planId ?? null, rev: body.rev ?? null, text: body.text, draft: body.plan }) });

async function fixture(options: { count?: number; independent?: boolean; qualitative?: boolean; attempts?: number } = {}) {
  const count = options.count ?? 2;
  const projectPath = await fs.mkdtemp(path.join(tmpdir(), 'autonomous-cycle-')); dirs.push(projectPath);
  let time = new Date('2026-10-25T08:00:00.000Z');
  const gitEnv = { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.fsmonitor=false', '-C', projectPath, ...args], { env: gitEnv })).stdout.trim();
  await git('init', '-b', 'main');
  await fs.mkdir(path.join(projectPath, 'spec'));
  // The frozen specification describes the required content; the runner interprets it on the captured tree.
  for (let item = 1; item <= count; item++) await fs.writeFile(path.join(projectPath, `spec/${item}.json`), JSON.stringify({ file: `item-${item}.txt`, expected: `implementation ${item}` }));
  await fs.writeFile(path.join(projectPath, '.gitignore'), '.parley/\n');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial cycle fixture');
  const baseSha = await git('rev-parse', 'HEAD');
  const map: WorkMap = { schemaVersion: 2, work: { id: 'w-01', title: 'Cycle', goal: '', status: 'active', createdAt: time.toISOString(), updatedAt: time.toISOString() }, sessions: [], rooms: [], messages: [] };
  addSession(map, { provider: 'codex', label: 'Lead', task: 'Propose the cycle' });
  addRoom(map, { creator: HUMAN, title: 'Cycle', members: ['s-01'], lead: 's-01', mode: 'autonomous' });
  await fs.mkdir(path.dirname(workPaths(projectPath, 'w-01').map), { recursive: true });
  await fs.writeFile(workPaths(projectPath, 'w-01').map, JSON.stringify(map));
  const read = () => readMap(projectPath, 'w-01');
  const plan = async () => (await read()).plans![0]!;
  const state = async () => (await plan()).autonomous!;
  const attempt = async (index = 0) => (await state()).attempts[index]!;
  const clone = async (index = 0) => path.join(workPaths(projectPath, 'w-01').dir, 'autonomous/pl-01/attempts', (await attempt(index)).id, 'clone');
  const ref = (sessionId: string) => ({ projectPath, workId: 'w-01', sessionId });
  const snapshots: WorkMap[] = [];
  const events: string[] = [];
  const gitCalls: string[][] = [];
  const runs: { sha: string; spec: string; attempt: string }[] = [];
  const mutate = (fn: (map: WorkMap) => void) => updateMap(projectPath, 'w-01', fn);
  const io = autonomousEngineIO({
    create: async input => {
      let sessionId = '';
      await mutate(map => { const session = addSession(map, { provider: input.provider, label: input.label, task: input.task }); session.lifecycle = 'pending'; sessionId = session.id; });
      events.push(`create:${sessionId}`);
      return ref(sessionId);
    },
    launch: async input => {
      await mutate(map => {
        expect(map.rooms[0]!.members).toContain(input.sessionId);
        map.sessions.find(row => row.id === input.sessionId)!.lifecycle = 'active';
      });
      events.push(`launch:${input.sessionId}`); return 'started';
    },
    stop: async input => { await mutate(map => { map.sessions.find(row => row.id === input.sessionId)!.lifecycle = 'sleeping'; }); events.push(`stop:${input.sessionId}`); },
    close: async input => { await mutate(map => { map.sessions.find(row => row.id === input.sessionId)!.lifecycle = 'closed'; }); events.push(`close:${input.sessionId}`); },
  });
  io.now = () => new Date(time);
  io.sleep = async ms => { time = new Date(time.getTime() + ms); };
  const diskUpdate = io.updateMap;
  io.updateMap = async (project, work, fn) => {
    const result = await diskUpdate(project, work, fn);
    snapshots.push(structuredClone(result)); return result;
  };
  const realGit = io.git;
  io.git = async (args, opts) => { gitCalls.push([...args]); return realGit(args, { ...opts, env: opts?.env ?? gitEnv }); };
  const bare = async (...args: string[]) => (await io.git([`--git-dir=${attemptsEngineGitPath(projectPath, 'w-01')}`, ...args])).toString('utf8').trim();
  io.runner = async (ctx, spec, sha, attemptId): Promise<CheckResult> => {
    runs.push({ sha, spec: spec.id, attempt: attemptId });
    const requirement = JSON.parse(await bare('show', `${sha}:spec/${spec.item}.json`)) as { file: string; expected: string };
    let content = '';
    try { content = await bare('show', `${sha}:${requirement.file}`); } catch { /* Missing implementation fails the specification. */ }
    const denied = content.includes('deny(1) file-write');
    const verdict = denied ? 'error' : content === requirement.expected ? 'pass' : 'fail';
    return { id: ctx.resultId, specId: spec.id, attemptId, sha, argvHash: digest(spec.argv), envHash: digest(spec.env), inputsOk: true, verdict, by: ENGINE, exitCode: verdict === 'pass' ? 0 : 1, summary: denied ? 'deny(1) file-write outside checkout (sandbox journal)' : `${spec.id}: ${verdict}`, outputTail: null, at: io.now().toISOString(), durationMs: 1 };
  };
  let engine = createAutonomousEngine(io, { provider: 'codex', verifier: { provider: 'claude', model: 'sonnet' } }); engines.push(engine);
  const registry = createBrowserEndpoint({ log: { info() {}, warn() {}, error() {} }, clients: () => [], roomsOf: () => [] });
  const endpoint = createAttemptsEndpoint({ authenticate: req => registry.authenticate(req), engine: {
    submit: (...args) => engine.submit(...args), verify: (...args) => engine.verify(...args),
  } });
  // Exercise the real authenticated channel without opening sockets or starting providers.
  const post = (body: AttemptChannelRequest, sessionId = 's-01') => new Promise<AttemptsResult>((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const token = registry.register(ref(sessionId));
    const req = Object.assign(Readable.from([data]), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': String(data.length) } });
    const res = { writableEnded: false, destroyed: false, writeHead(status: number) { if (status !== 200) reject(new Error(`attempt channel HTTP ${status}`)); }, end(body: string) { this.writableEnded = true; resolve(JSON.parse(body) as AttemptsResult); } };
    endpoint.handle(req as IncomingMessage, res as unknown as ServerResponse);
  });
  const draft: ProposalRequest['plan'] = {
    mode: 'autonomous', goal: 'Implement two dependent changes',
    items: Array.from({ length: count }, (_, i) => ({ id: i + 1, title: `Change ${i + 1}`, owner: ENGINE, verifier: ENGINE, scope: `item-${i + 1}.txt`, after: !options.independent && i > 0 ? [i] : [], criteria: ['The frozen specification passes'] })),
    autonomous: {
      budget: { attemptsPerItem: options.attempts ?? 5, repairWaves: 10, minutesPerAttempt: 30, sessions: 50, concurrent: 4 },
      checks: Array.from({ length: count }, (_, i) => ({ id: `test-${i + 1}`, item: i + 1, argv: ['node', `spec/${i + 1}.json`], cwd: '.', env: {}, inputs: [`spec/${i + 1}.json`], timeoutMs: 1000 })),
      coverage: Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, { 0: options.qualitative ? [`test-${i + 1}`, 'verifier'] : [`test-${i + 1}`] }])),
    },
  };
  const accept = async () => {
    const proposal = (await read()).rooms[0]!.proposal!;
    await resolveRoomProposal({ projectPath, workId: 'w-01', roomId: 'r-01', proposalId: proposal.id, rev: proposal.rev, planId: proposal.plan?.id ?? proposal.planId!, planRev: proposal.plan?.rev ?? proposal.planRev!, action: 'accept' });
  };
  const go = async () => {
    expect(await post(keyed({ action: 'propose-plan', roomId: 'r-01', text: 'Go: implement the frozen specifications', plan: draft, requestKey: '' }))).toMatchObject({ ok: true });
    expect((await fs.stat(attemptsEngineGitPath(projectPath, 'w-01')).catch(() => null))).toBeNull();
    await accept();
    expect((await state()).integration).toMatchObject({ baseSha, verifiedHead: baseSha, queue: [], candidateHead: null });
    await engine.flush(projectPath, 'w-01');
    expect(await bare('rev-parse', `refs/heads/${(await state()).integration.branch}`)).toBe(baseSha);
  };
  const submission = async (index = 0, change: Partial<Submission['manifest']> = {}): Promise<Submission> => {
    const p = await plan(), a = await attempt(index), item = p.items.find(row => row.id === a.item)!;
    const dependsOn = item.after.map(id => p.autonomous!.attempts.findLast(row => row.item === id && row.status === 'integrated')!.id);
    const body = { version: 1 as const, criteriaVersion: a.criteriaVersion, dependsOn, coverage: 'covered' as const, scope: item.scope, facts: ['Implementation ready'], hypotheses: [], notFound: [], gaps: [], text: 'Ready for independent checks', artifacts: [], submittedAt: io.now().toISOString(), ...change };
    return { action: 'submit', attemptId: a.id, manifest: body };
  };
  const submit = async (index = 0, request?: Submission) => engine.submit(ref((await attempt(index)).worker!), 'pl-01', (await plan()).rev, request ?? await submission(index));
  const write = async (index = 0, content?: string) => { const a = await attempt(index); await fs.writeFile(path.join(await clone(index), `item-${a.item}.txt`), content ?? `implementation ${a.item}`); };
  const flush = () => engine.flush(projectPath, 'w-01');
  const verifyAttempt = async (index = 0) => {
    const a = await attempt(index);
    expect(await engine.verify(ref(a.verifier!), 'pl-01', (await plan()).rev, { action: 'verify', attemptId: a.id, sha: a.sha!, criterion: 0, verdict: 'pass', note: 'Artifacts satisfy the criterion' })).toMatchObject({ ok: true });
  };
  const integrate = async () => {
    await flush();
    const p = await plan(), a = p.autonomous!;
    if (a.integration.candidateHead && options.qualitative) {
      const creation = a.ops.findLast(op => op.kind === 'create-session' && op.payload.purpose === 'integration-verifier' && op.state === 'done')!;
      const owners = a.attempts.filter(attempt => attempt.id === a.integration.queue[0] || attempt.status === 'integrated' && p.items.find(row => row.id === attempt.item)!.status === 'verified' && a.attempts.findLast(row => row.item === attempt.item && row.status === 'integrated') === attempt);
      for (const owner of owners) expect(await engine.verify(ref(String(creation.result!.sessionId)), p.id, p.rev, { action: 'verify', attemptId: owner.id, sha: a.integration.candidateHead, criterion: 0, verdict: 'pass', note: 'Fresh integrated-tree review' })).toMatchObject({ ok: true });
      await flush();
    }
  };
  const finish = async (index = 0, content?: string) => {
    await write(index, content); expect(await submit(index)).toMatchObject({ ok: true });
    if (options.qualitative) await verifyAttempt(index);
    await integrate();
  };
  const resume = async () => resumeAutonomousPlan({ projectPath, workId: 'w-01', roomId: 'r-01', planId: 'pl-01', rev: (await plan()).rev });
  const restart = async () => {
    await engine.stop();
    const map = await read();
    engine = createAutonomousEngine(io, { provider: 'codex', verifier: { provider: 'claude', model: 'sonnet' }, works: { snapshot: () => ({ entries: [{ projectPath, map }] }) as any, onChange: () => () => {} } });
    engines.push(engine); engine.start(); await flush();
  };
  const handlers = createPlanHandlers({ start() {}, stop() {}, flush: async () => summarizePlanEffects(await read()) });
  const returnItem = async (item = 1) => handlers['plans.verify']({ projectPath, workId: 'w-01', planId: 'pl-01', rev: (await plan()).rev, item, verdict: 'returned', note: 'Human found a late defect' }, {} as any);
  const mirror = async () => {
    const a = await state();
    expect(await bare('rev-parse', `refs/heads/${a.integration.branch}`)).toBe(a.integration.verifiedHead);
    expect(await git('rev-parse', `refs/heads/${a.integration.branch}`)).toBe(a.integration.verifiedHead);
    expect(await git('rev-parse', 'HEAD')).toBe(baseSha);
    expect(await git('status', '--porcelain')).toBe('');
  };
  return { projectPath, baseSha, git, bare, io, plan, state, attempt, clone, read, mutate, ref, go, post, draft, accept, submission, submit, write, flush, verifyAttempt, integrate, finish, resume, restart, returnItem, handlers, mirror, snapshots, events, gitCalls, runs, engine: () => engine };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function crashOnWrite(f: Fixture, matches: (plan: RoomPlan) => boolean, message: string) {
  const update = f.io.updateMap;
  let crashed = false;
  f.io.updateMap = (project, work, mutate) => update(project, work, draft => {
    mutate(draft);
    if (!crashed && matches(draft.plans![0]!)) { crashed = true; throw new Error(message); }
  });
  return () => { expect(crashed).toBe(true); f.io.updateMap = update; };
}

async function expectReadOnlyRecovery(f: Fixture) {
  const before = await f.bare('show-ref'), calls = f.gitCalls.length, runs = f.runs.length;
  await f.restart();
  expect((await f.state()).halted?.reason).toBe('restart');
  expect(f.runs).toHaveLength(runs);
  expect(f.gitCalls.slice(calls).filter(args => args.some(arg => ['fetch', 'update-ref', 'reset', 'merge', 'clean', 'checkout', 'clone', 'commit-tree', 'write-tree', 'update-index'].includes(arg)))).toEqual([]);
  expect(await f.bare('show-ref')).toBe(before);
}

async function planTool(f: Fixture, name: string, args: Record<string, unknown>) {
  const server = createParleyServer({ projectPath: f.projectPath, workId: 'w-01', workDir: workPaths(f.projectPath, 'w-01').dir, sessionId: (await f.attempt()).worker!, channel: false });
  type Transport = Parameters<typeof server.connect>[0];
  let reply!: (message: { result?: { isError?: boolean; content: { text: string }[] } }) => void;
  const response = new Promise<{ result?: { isError?: boolean; content: { text: string }[] } }>(resolve => { reply = resolve; });
  const transport: Transport = { start: async () => {}, close: async () => {}, send: async message => { reply(message as Parameters<typeof reply>[0]); } };
  await server.connect(transport);
  try {
    transport.onmessage!({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return (await response).result!;
  } finally { await server.close(); }
}

async function completion(f: Fixture) {
  await f.flush();
  const p = await f.plan(), a = p.autonomous!, proposal = (await f.read()).rooms[0]!.proposal!;
  expect(p.status).toBe('completing');
  expect(p.items.map(row => row.status)).toEqual(p.items.map(() => 'verified'));
  expect(a.integration).toMatchObject({ queue: [], candidateHead: null }); expect(a.halted).toBeNull();
  const report = a.ops.findLast(op => op.payload.purpose === 'completion-report')!;
  expect(report.state).toBe('done');
  const file = path.resolve(f.projectPath, String(report.result!.path)), bytes = await fs.readFile(file);
  expect(bytesHash(bytes)).toBe(report.result!.sha256);
  expect(proposal.kind).toBe('completion');
  for (const text of [a.integration.verifiedHead, 'Checks/verdicts', 'spent', 'remaining', String(report.result!.path), String(report.result!.sha256)]) expect(proposal.text).toContain(text);
  const data = JSON.parse(bytes.toString());
  expect(data.verifiedHead).toBe(a.integration.verifiedHead);
  expect(data.checks.length).toBeGreaterThanOrEqual(p.items.length);
  expect(data.checks.every((row: CheckResult) => row.sha === a.integration.verifiedHead && row.verdict === 'pass')).toBe(true);
  await f.mirror();
  await f.accept(); expect((await f.plan()).status).toBe('completed');
  const before = await f.read(), events = [...f.events], refs = await f.bare('show-ref'), gitCalls = f.gitCalls.length;
  await f.flush(); await f.flush();
  expect(f.gitCalls).toHaveLength(gitCalls);
  expect(await f.read()).toEqual(before); expect(f.events).toEqual(events); expect(await f.bare('show-ref')).toBe(refs);
  return { file, bytes, head: a.integration.verifiedHead };
}

describe('autonomous room cycle with stub agents and real Git', () => {
  it('runs Go, a failed specification, repair, dependent waves, fresh reviews and human completion', async () => {
    const f = await fixture({ qualitative: true }); await f.go();
    expect((await f.state()).attempts.map(row => row.item)).toEqual([1]);
    expect((await f.plan()).items[1]!.status).toBe('waiting');
    expect(await f.submit()).toMatchObject({ ok: true });
    await f.verifyAttempt();
    expect((await f.attempt()).status).toBe('returned');
    expect(await f.bare('rev-parse', `${(await f.attempt()).sha}^{tree}`)).toBe(await f.bare('rev-parse', `${f.baseSha}^{tree}`));
    await f.flush(); expect(await f.attempt(1)).toMatchObject({ item: 1, n: 2, status: 'running', baseSha: f.baseSha });
    await f.finish(1);
    const first = await f.attempt(1), head = (await f.state()).integration.verifiedHead;
    expect(first.status).toBe('integrated');
    expect((await f.plan()).items[0]!.status).toBe('verified');
    expect(f.snapshots.some(map => map.plans?.[0]?.items[1]?.status === 'ready')).toBe(true);
    expect(await f.attempt(2)).toMatchObject({ item: 2, status: 'running', baseSha: head });
    expect((await f.submission(2)).manifest.dependsOn).toEqual([first.id]);
    await f.mirror();
    await f.finish(2);
    const a = await f.state();
    expect(a.attempts.map(row => row.status)).toEqual(['returned', 'integrated', 'integrated']);
    expect(f.snapshots.some(map => map.plans?.[0]?.autonomous?.attempts.some(row => row.status === 'queued'))).toBe(true);
    const reviews = a.ops.filter(op => op.kind === 'create-session' && op.payload.purpose === 'integration-verifier');
    expect(reviews).toHaveLength(2);
    expect(reviews.map(op => op.result!.sessionId)).not.toContain(first.verifier);
    expect(f.runs.filter(run => run.sha === a.integration.verifiedHead).map(run => run.spec)).toEqual(['test-1', 'test-2']);
    expect(await f.bare('show', `${a.integration.verifiedHead}:item-1.txt`)).toBe('implementation 1');
    expect(await f.bare('show', `${a.integration.verifiedHead}:item-2.txt`)).toBe('implementation 2');
    await completion(f);
  });

  it('reopens accepted completion for a late defect and preserves the first report and Git export', async () => {
    const f = await fixture(); await f.go(); await f.finish(); await f.finish(1);
    const old = await completion(f), prior = await f.state(), rev = (await f.plan()).rev;
    await f.returnItem();
    expect(await f.plan()).toMatchObject({ status: 'active', rev: rev + 1, completedAt: null });
    expect((await f.plan()).items.map(row => row.status)).toEqual(['returned', 'waiting']);
    expect((await f.attempt(1)).status).toBe('superseded');
    expect((await f.state()).integration.verifiedHead).toBe(old.head);
    await f.flush();
    await fs.writeFile(path.join(await f.clone(2), 'repair.txt'), 'Late defect repaired');
    await f.finish(2, 'implementation 1');
    expect((await f.submission(3)).manifest.dependsOn).toEqual([(await f.attempt(2)).id]);
    expect((await f.submission(3)).manifest.dependsOn).not.toEqual([prior.attempts[0]!.id]);
    await f.finish(3); const next = await completion(f);
    expect(next.head).not.toBe(old.head);
    expect(next.file).not.toBe(old.file); expect(await fs.readFile(old.file)).toEqual(old.bytes);
    expect(await f.bare('show', `${old.head}:item-2.txt`)).toBe('implementation 2');
    expect(await f.bare('show', `${next.head}:repair.txt`)).toBe('Late defect repaired');
    expect(await f.git('cat-file', '-t', old.head)).toBe('commit');
  });

  it('reconciles a running worker without another session and resumes explicitly within the persisted budget', async () => {
    const f = await fixture({ count: 1 }); await f.go();
    const old = await f.attempt(), budget = (await f.state()).budget.spent;
    await expectReadOnlyRecovery(f);
    expect(await f.attempt()).toMatchObject({ status: 'aborted', receipt: null });
    expect(f.events.filter(row => row.startsWith('create:'))).toHaveLength(1);
    const request = await f.submission();
    expect(await f.submit(0, request)).toMatchObject({ ok: false, error: { code: 'attempt-fenced' } });
    await f.engine().start(); await f.flush(); await expectReadOnlyRecovery(f);
    expect((await f.state()).budget.spent).toEqual(budget);
    expect((await f.read()).sessions.find(row => row.id === old.worker)!.lifecycle).toBe('closed');
    await f.resume(); await f.flush();
    expect(await f.attempt(1)).toMatchObject({ n: 2, status: 'running' });
    await f.finish(1); await completion(f);
    expect((await f.state()).budget.spent.attempts).toBe(2);
    expect((await f.state()).ops.filter(op => op.kind === 'capture')).toHaveLength(1);
  });

  it.each(['before-capture', 'before-receipt'] as const)('retries a hashless handoff after a lost response %s without duplicate effects', async phase => {
    const f = await fixture({ count: 1 }); await f.go(); await f.write();
    const restore = crashOnWrite(f, p => phase === 'before-capture'
      ? p.autonomous!.ops.some(op => op.kind === 'capture')
      : p.autonomous!.attempts[0]!.receipt !== null, `lost response ${phase}`);
    const request = await f.submission();
    expect(await f.submit(0, request)).toMatchObject({ ok: false }); restore();
    const pending = await f.attempt();
    expect(pending.receipt).toBeNull(); expect(pending.submissionKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.state()).ops.filter(op => op.kind === 'capture')).toHaveLength(phase === 'before-capture' ? 0 : 1);
    // The worker recovers the assigned key through attempt_status, then retries the original body.
    expect(await f.submit(0, { ...request, submissionKey: pending.submissionKey! })).toMatchObject({ ok: true, result: { submissionKey: pending.submissionKey } });
    const settled = await f.state(), events = [...f.events], runs = [...f.runs], calls = [...f.gitCalls];
    const received = await f.attempt();
    expect(await f.submit(0, request)).toEqual({ ok: true, result: { receipt: received.receipt, submissionKey: pending.submissionKey } });
    expect(await f.state()).toEqual(settled);
    expect(f.events).toEqual(events); expect(f.runs).toEqual(runs); expect(f.gitCalls).toEqual(calls);
    expect(settled.seq.receipt).toBe(1);
    expect(settled.ops.filter(op => op.kind === 'capture')).toHaveLength(1);
    expect(f.gitCalls.filter(args => args.includes('commit-tree'))).toHaveLength(1);
    expect(f.events.filter(event => event === `stop:${received.worker}`)).toHaveLength(1);
    await f.integrate(); await completion(f);
  });

  it('retains a receipt across a crash before checks and never recaptures the submission', async () => {
    const f = await fixture({ count: 1 }); await f.go(); await f.write();
    const restore = crashOnWrite(f, p => p.autonomous!.ops.some(op => op.kind === 'check'), 'crash before first check');
    const request = await f.submission();
    expect(await f.submit(0, request)).toMatchObject({ ok: false }); restore();
    const received = await f.attempt(); expect(received).toMatchObject({ status: 'submitted', receipt: { valid: true } });
    const beforeRetry = await f.state(), events = [...f.events], runs = [...f.runs];
    for (const body of [request, { ...request, submissionKey: received.submissionKey! }]) {
      expect(await f.submit(0, body)).toEqual({ ok: true, result: { receipt: received.receipt, submissionKey: received.submissionKey } });
      expect(await f.state()).toEqual(beforeRetry);
      expect(f.events).toEqual(events); expect(f.runs).toEqual(runs);
    }
    const refs = await f.bare('show-ref'), sessions = (await f.read()).sessions.length;
    await expectReadOnlyRecovery(f); await expectReadOnlyRecovery(f);
    expect((await f.attempt()).receipt).toEqual(received.receipt);
    expect((await f.read()).sessions).toHaveLength(sessions);
    await f.resume(); await f.flush(); await completion(f);
    const captures = (await f.state()).ops.filter(op => op.kind === 'capture');
    expect(captures).toHaveLength(1); expect(captures[0]!.state).toBe('done');
    expect(refs).toContain(received.sha!);
    expect(await f.bare('rev-parse', `refs/attempts/pl-01/${received.id}`)).toBe(received.sha);
  });

  it.each(['candidate-ref', 'no-candidate-ref', 'checks-before-acceptance'] as const)('recovers a merge crash (%s) and fully rechecks before advancing the queue', async crash => {
    const f = await fixture({ independent: true }); await f.go();
    await f.write(); await f.submit(); await f.write(1); await f.submit(1);
    expect((await f.state()).integration.queue).toEqual([(await f.attempt()).id, (await f.attempt(1)).id]);
    const git = f.io.git;
    if (crash === 'no-candidate-ref') f.io.git = async (args, opts) => {
      if (args.includes('fetch') && args.some(arg => arg.includes('refs/candidates/'))) throw new Error('crash before publishing candidate');
      return git(args, opts);
    };
    const restore = crashOnWrite(f, p => crash === 'checks-before-acceptance' ? p.autonomous!.attempts[0]!.status === 'integrated'
      : p.autonomous!.ops.some(op => op.kind === 'merge' && op.state === (crash === 'no-candidate-ref' ? 'failed' : 'done')), 'merge settlement lost');
    await expect(f.flush()).rejects.toThrow('merge settlement lost'); restore(); f.io.git = git;
    const a = await f.state(), candidateRef = `refs/candidates/pl-01/${a.attempts[0]!.id}`;
    const candidate = crash === 'no-candidate-ref' ? null : await f.bare('rev-parse', candidateRef);
    expect(a.integration.verifiedHead).toBe(f.baseSha);
    await expectReadOnlyRecovery(f);
    expect((await f.state()).integration.candidateHead).toBe(candidate);
    expect((await f.attempt()).status).toBe('queued');
    expect((await f.attempt(1)).status).toBe('queued');
    const before = f.runs.length;
    await f.resume(); await f.flush(); await completion(f);
    const runs = f.runs.slice(before), final = await f.state();
    expect(runs.map(row => row.spec)).toEqual(['test-1', 'test-1', 'test-2']);
    if (candidate) expect(runs[0]!.sha).toBe(candidate);
    expect(runs.slice(1).every(row => row.sha === final.integration.verifiedHead)).toBe(true);
    expect(await f.bare('rev-list', '--parents', '-n', '1', final.integration.verifiedHead)).toContain(a.attempts[1]!.sha);
    const mergeOps = final.ops.filter(op => op.kind === 'merge' && op.state === 'done');
    expect(mergeOps).toHaveLength(2);
    if (crash !== 'no-candidate-ref') expect(mergeOps[0]!.key).toBe(a.ops.find(op => op.kind === 'merge')!.key);
    await f.mirror();
  });

  it.each(['attemptsPerItem', 'no_progress'] as const)('halts on %s without another worker, and keeps limits across restart', async reason => {
    const f = await fixture({ count: 1, attempts: reason === 'attemptsPerItem' ? 1 : 5 }); await f.go();
    await f.submit();
    if (reason === 'no_progress') { await f.flush(); await f.submit(1); }
    const a = await f.state(), limit = a.budget.limits, spent = a.budget.spent;
    expect(a.attempts.at(-1)!.status).toBe('blocked');
    expect(a.halted?.reason).toBe(reason === 'no_progress' ? 'no_progress' : 'budget');
    if (reason === 'no_progress') expect(a.attempts[0]!.failureSignature).toBe(a.attempts[1]!.failureSignature);
    const count = a.attempts.length;
    await f.flush(); await expectReadOnlyRecovery(f); await f.resume(); await f.flush();
    expect((await f.state()).budget.limits).toEqual(limit); expect((await f.state()).budget.spent).toEqual(spent);
    expect((await f.state()).attempts).toHaveLength(count);
    expect((await f.read()).sessions.filter(row => row.id !== 's-01').every(row => row.lifecycle === 'closed')).toBe(true);
    expect((await f.state()).integration.verifiedHead).toBe(f.baseSha);
    expect(await f.bare('rev-parse', `refs/heads/${a.integration.branch}`)).toBe(f.baseSha);
  });

  it('halts a resource-policy refusal without a session or a spent session reservation', async () => {
    const f = await fixture({ count: 1 });
    f.io.sessions.create = async () => { throw new Error('resource policy denied'); };
    // Go is persisted before the first worker reservation is refused.
    await expect(f.go()).rejects.toThrow('resource policy denied');
    expect((await f.state()).halted?.reason).toBe('budget');
    expect((await f.read()).sessions).toHaveLength(1);
    const budget = (await f.state()).budget;
    expect(budget.spent.sessions).toBe(0);
    expect(budget.reservations).toEqual([]);
    await expectReadOnlyRecovery(f); await f.flush();
    expect((await f.read()).sessions).toHaveLength(1);
    expect((await f.state()).budget.limits).toEqual(budget.limits);
    expect((await f.state()).budget.spent).toEqual(budget.spent);
    expect(await f.bare('rev-parse', `refs/heads/${(await f.state()).integration.branch}`)).toBe(f.baseSha);
  });

  it('deduplicates simultaneous submissions by submissionKey with one receipt and one capture', async () => {
    const f = await fixture({ count: 1 }); await f.go(); await f.write();
    const request = await f.submission();
    const results = await Promise.all([f.submit(0, request), f.submit(0, request)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]).toMatchObject({ ok: true });
    const a = await f.state(), received = await f.attempt();
    expect(results[0]).toEqual({ ok: true, result: { receipt: received.receipt, submissionKey: received.submissionKey } });
    const events = [...f.events], runs = [...f.runs];
    const manifest = { ...request.manifest, hash: digest({ ...request.manifest, sha: null }) };
    for (const body of [request, { ...request, submissionKey: received.submissionKey! }, { ...request, manifest, submissionKey: received.submissionKey! }]) {
      expect(await f.submit(0, body)).toEqual(results[0]);
      expect(await f.state()).toEqual(a);
      expect(f.events).toEqual(events); expect(f.runs).toEqual(runs);
    }
    expect(a.seq.receipt).toBe(1); expect(a.ops.filter(op => op.kind === 'capture')).toHaveLength(1);
    expect(f.events.filter(event => event === `stop:${received.worker}`)).toHaveLength(1);
    expect(await f.bare('rev-parse', `refs/attempts/pl-01/${received.id}`)).toBe(received.receipt!.sha);
    expect(await f.bare('show', `${received.sha}:item-1.txt`)).toBe('implementation 1');
    expect(await f.submit(0, { ...request, submissionKey: 'f'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'handoff-conflict' } });
    expect(await f.submit(0, { ...request, submissionKey: received.submissionKey!, manifest: { ...request.manifest, text: 'Changed under the same key' } })).toMatchObject({ ok: false, error: { code: 'handoff-conflict' } });
    expect(await f.submit(0, { ...request, manifest: { ...request.manifest, hash: 'f'.repeat(64) } })).toMatchObject({ ok: false, error: { code: 'invalid manifest' } });
    expect(await f.state()).toEqual(a);
    expect((await f.attempt()).receipt).toEqual(received.receipt);
    await f.integrate(); await completion(f);
  });

  it('changes criteria only through a human-accepted amendment and fences affected attempts', async () => {
    const f = await fixture(); await f.go();
    const before = await f.read(), rev = (await f.plan()).rev;
    for (const [name, args] of [
      ['plan_update', { status: 'in_progress' }],
      ['plan_submit', { evidence: { text: 'Bypass checks', artifacts: [] } }],
      ['plan_verify', { verdict: 'verified', note: 'Bypass checks' }],
    ] as const) {
      const result = await planTool(f, name, { planId: 'pl-01', rev, item: 1, ...args });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('autonomous plan is driven by the engine');
    }
    const criterionEdit = await planTool(f, 'plan_update', { planId: 'pl-01', rev, item: 1, status: 'in_progress', criteria: ['Bypass the frozen criterion'] });
    expect(criterionEdit.isError).toBe(true);
    expect(criterionEdit.content[0]!.text).toContain('unexpected plan argument');
    expect(await f.read()).toEqual(before);
    await f.finish();
    const oldSubmission = await f.submission(1), oldRefs = await f.bare('show-ref');
    const draft = structuredClone(f.draft); draft.id = 'pl-01'; draft.rev = rev;
    draft.items[0]!.criteria = ['Updated criterion, still checked by the frozen specification'];
    const request = keyed({ action: 'propose-plan', roomId: 'r-01', planId: 'pl-01', rev, text: 'Amend the first criterion', requestKey: '', plan: draft });
    expect(await f.post(request)).toMatchObject({ ok: true });
    expect((await f.state()).criteriaVersion).toEqual({ 1: 1, 2: 1 });
    expect((await f.attempt(1)).status).toBe('running');
    await f.accept();
    expect((await f.state()).criteriaVersion).toEqual({ 1: 2, 2: 1 });
    expect((await f.state()).attempts.map(row => row.status)).toEqual(['superseded', 'superseded']);
    expect(await f.submit(1, oldSubmission)).toMatchObject({ ok: false, error: { code: 'attempt-fenced' } });
    expect(await f.bare('show-ref')).toBe(oldRefs);
    await f.flush(); expect(await f.attempt(2)).toMatchObject({ item: 1, criteriaVersion: 2, status: 'running' });
    await f.finish(2); await f.finish(3); await completion(f);
  });

  it('supersedes a dependent verdict when the human returns its accepted dependency', async () => {
    const f = await fixture({ qualitative: true }); await f.go(); await f.finish();
    await f.write(1); expect(await f.submit(1)).toMatchObject({ ok: true });
    const dependent = await f.attempt(1), first = await f.attempt(), head = (await f.state()).integration.verifiedHead;
    expect(dependent.manifest!.dependsOn).toEqual([first.id]); expect(dependent.status).toBe('checking');
    await f.returnItem();
    expect((await f.attempt(1)).status).toBe('superseded');
    expect(await f.engine().verify(f.ref(dependent.verifier!), 'pl-01', (await f.plan()).rev, { action: 'verify', attemptId: dependent.id, sha: dependent.sha!, criterion: 0, verdict: 'pass', note: 'Late stale verdict' })).toMatchObject({ ok: false, error: { code: 'attempt-fenced' } });
    expect((await f.state()).integration).toMatchObject({ verifiedHead: head, queue: [], candidateHead: null });
    await f.mirror(); await f.flush(); await f.finish(2);
    expect((await f.submission(3)).manifest.dependsOn).toEqual([(await f.attempt(2)).id]);
    await f.finish(3); await completion(f);
  });

  it('serializes independent merges and publishes only fully checked heads', async () => {
    const f = await fixture({ independent: true }); await f.go(); await f.write(); await f.write(1);
    expect(await f.submit()).toMatchObject({ ok: true });
    expect(await f.submit(1)).toMatchObject({ ok: true });
    expect((await f.state()).integration.queue).toEqual([(await f.attempt()).id, (await f.attempt(1)).id]);
    expect((await f.plan()).items.map(row => row.status)).toEqual(['in_progress', 'in_progress']);
    await Promise.all([f.flush(), f.flush(), f.flush()]);
    const a = await f.state(), merges = a.ops.filter(op => op.kind === 'merge');
    expect(merges).toHaveLength(2); expect(merges.every(op => op.state === 'done')).toBe(true);
    const firstHead = String(merges[0]!.result!.sha), lastHead = String(merges[1]!.result!.sha);
    expect(merges[1]!.payload.verifiedHead).toBe(firstHead);
    expect(await f.bare('rev-list', '--parents', '-n', '1', lastHead)).toBe(`${lastHead} ${firstHead} ${a.attempts[1]!.sha}`);
    expect(await f.bare('rev-list', '--count', '--merges', lastHead)).toBe('2');
    const secondIntention = f.snapshots.find(map => map.plans![0]!.autonomous!.ops.some(op => op.key === merges[1]!.key))!;
    expect(secondIntention.plans![0]!.items[0]!.status).toBe('verified');
    expect(a.ops.filter(op => op.kind === 'check' && op.payload.phase === 'integration').map(op => [op.payload.sha, op.payload.specId])).toEqual([[firstHead, 'test-1'], [lastHead, 'test-1'], [lastHead, 'test-2']]);
    for (const item of [1, 2]) expect(await f.bare('show', `${lastHead}:item-${item}.txt`)).toBe(`implementation ${item}`);
    await completion(f);
  });

  it('settles a witnessed create-session operation after a lost acknowledgement without a second effect', async () => {
    const f = await fixture({ count: 1 });
    const restore = crashOnWrite(f, p => p.autonomous!.ops.some(op => op.kind === 'create-session' && op.state === 'done'), 'create settlement lost');
    await expect(f.go()).rejects.toThrow('create settlement lost'); restore();
    const operation = (await f.state()).ops.find(op => op.kind === 'create-session')!;
    expect(operation.state).toBe('intended'); expect(f.events.filter(row => row.startsWith('create:'))).toHaveLength(1);
    await expectReadOnlyRecovery(f); await expectReadOnlyRecovery(f);
    const settled = (await f.state()).ops.find(op => op.key === operation.key)!;
    expect(settled.state).toBe('done');
    expect(f.events.filter(row => row.startsWith('create:'))).toHaveLength(1);
    expect((await f.state()).budget.spent.sessions).toBe(1);
    expect((await f.state()).ops.filter(op => op.kind === 'create-session')).toHaveLength(1);
    expect((await f.read()).sessions).toHaveLength(2);
    await f.resume(); await f.flush(); await f.finish(1); await completion(f);
  });

  it('returns an invalid receipt when a worker edits a frozen specification', async () => {
    const f = await fixture({ count: 1 }); await f.go(); await f.write();
    await fs.writeFile(path.join(await f.clone(), 'spec/1.json'), JSON.stringify({ file: 'item-1.txt', expected: 'forged' }));
    expect(await f.submit()).toMatchObject({ ok: true });
    const a = await f.attempt();
    expect(a).toMatchObject({ status: 'returned', receipt: { valid: false } });
    expect(a.receipt!.reason).toContain('inputs'); expect(f.runs).toEqual([]);
    expect(await f.bare('show', `${a.sha}:spec/1.json`)).toContain('forged');
    expect(await f.git('show', 'HEAD:spec/1.json')).toContain('implementation 1');
    expect((await f.state()).integration).toMatchObject({ verifiedHead: f.baseSha, queue: [], candidateHead: null });
  });

  it('rejects a runner sandbox-denial verdict even when the worker claims complete coverage', async () => {
    const f = await fixture({ count: 1 }); await f.go();
    await f.write(0, 'deny(1) file-write outside checkout'); expect(await f.submit()).toMatchObject({ ok: true });
    const a = await f.state();
    expect(a.attempts[0]!.status).toBe('returned'); expect(a.attempts[0]!.manifest!.coverage).toBe('covered');
    expect(a.ops.find(op => op.kind === 'check')!.result!.checkResult).toMatchObject({ verdict: 'error', summary: expect.stringContaining('sandbox journal') });
    expect(a.integration).toMatchObject({ verifiedHead: f.baseSha, queue: [], candidateHead: null });
    expect(await f.bare('rev-parse', `refs/heads/${a.integration.branch}`)).toBe(f.baseSha);
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.baseSha);
  });

  it('captures an unchanged dependent tree as baseSha and records a checked noop-integration', async () => {
    const f = await fixture(); await f.go();
    await fs.writeFile(path.join(await f.clone(), 'item-2.txt'), 'implementation 2');
    await f.finish();
    const before = (await f.state()).integration.verifiedHead;
    expect((await f.attempt(1)).baseSha).toBe(before);
    expect(await f.submit(1)).toMatchObject({ ok: true }); await f.integrate();
    const a = await f.attempt(1), state = await f.state();
    expect(a).toMatchObject({ sha: before, status: 'integrated' });
    expect(a.tree).toBe(await f.bare('rev-parse', `${a.baseSha}^{tree}`));
    expect(state.integration.verifiedHead).toBe(before);
    expect(state.ops.filter(op => op.kind === 'merge')).toHaveLength(1);
    expect(state.ops.find(op => op.kind === 'noop-integration')).toMatchObject({ attemptId: a.id, state: 'done', result: { sha: before } });
    expect(f.runs.filter(run => run.sha === before).map(run => run.spec)).toEqual(['test-1', 'test-2', 'test-1', 'test-2']);
    await completion(f);
  });

  it('returns a regressing integration candidate while preserving prior verified evidence and the mirror', async () => {
    const f = await fixture(); await f.go(); await f.finish();
    const head = (await f.state()).integration.verifiedHead, evidence = (await f.plan()).items[0]!.evidence;
    await f.write(1); await fs.writeFile(path.join(await f.clone(1), 'item-1.txt'), 'regression');
    expect(await f.submit(1)).toMatchObject({ ok: true });
    expect((await f.attempt(1)).status).toBe('queued');
    await f.flush();
    const a = await f.state(), failed = a.ops.findLast(op => op.kind === 'merge' && op.attemptId === a.attempts[1]!.id)!;
    expect(failed.state).toBe('done');
    expect(a.attempts[1]!.status).toBe('returned');
    expect(a.attempts[1]!.log.some(row => row.status === 'returned' && row.note?.includes('integration'))).toBe(true);
    expect(a.integration).toMatchObject({ verifiedHead: head, candidateHead: null, queue: [] });
    expect((await f.plan()).items[0]).toMatchObject({ status: 'verified', evidence });
    expect(a.ops.some(op => op.kind === 'merge-abort' && op.state === 'done')).toBe(true);
    expect(await f.bare('show', `${failed.result!.sha}:item-1.txt`)).toBe('regression');
    await f.mirror();
    expect(await f.attempt(2)).toMatchObject({ item: 2, n: 2, baseSha: head, status: 'running' });
    expect(await fs.readFile(path.join(await f.clone(2), 'item-1.txt'), 'utf8')).toBe('implementation 1');
    await f.finish(2); await completion(f);
  });

  it('cancels only after stop, close and cleanup settle, retaining artifacts and engine.git', async () => {
    const f = await fixture(); await f.go(); await f.write();
    const bytes = 'captured evidence', hash = bytesHash(bytes);
    await fs.writeFile(path.join(await f.clone(), 'evidence.txt'), bytes);
    const request = await f.submission(0, { artifacts: [{ path: 'evidence.txt', sha256: hash, storedAs: '' }] });
    expect(await f.submit(0, request)).toMatchObject({ ok: true }); await f.integrate();
    expect((await f.attempt(1)).status).toBe('running');
    const artifact = (await f.attempt()).manifest!.artifacts[0]!;
    const stored = path.join(path.dirname(await f.clone()), artifact.storedAs);
    const before = await f.read();
    expect(() => archiveRoom(before, 'r-01', HUMAN)).toThrow('cancel the autonomous plan first');
    await expect(f.handlers['rooms.setMode']({ projectPath: f.projectPath, workId: 'w-01', roomId: 'r-01', mode: 'free', reason: 'Bypass cancellation', confirmCancel: true }, {} as any)).rejects.toThrow('Cancel the autonomous plan first');
    const restore = crashOnWrite(f, p => p.autonomous!.ops.some(op => op.kind === 'cleanup' && op.payload.purpose === 'cancellation' && op.state === 'done'), 'cleanup settlement lost');
    const rev = (await f.plan()).rev;
    const cancel = () => f.engine().cancel({ projectPath: f.projectPath, workId: 'w-01', planId: 'pl-01', rev });
    await expect(cancel()).rejects.toThrow('cleanup settlement lost'); restore();
    expect((await f.plan()).status).toBe('active'); expect((await f.state()).halted?.reason).toBe('human');
    expect((await f.state()).ops.some(op => op.kind === 'cleanup' && op.state === 'intended')).toBe(true);
    await cancel();
    const p = await f.plan(), a = p.autonomous!;
    expect(p.status).toBe('cancelled'); expect(a.ops.every(op => op.state !== 'intended')).toBe(true);
    expect(f.snapshots.some(map => map.plans![0]!.autonomous!.halted?.reason === 'human' && map.plans![0]!.status === 'active')).toBe(true);
    for (const worker of a.attempts.map(row => row.worker!)) {
      expect(a.ops.some(op => op.kind === 'stop-session' && op.state === 'done' && op.payload.sessionId === worker)).toBe(true);
      expect(a.ops.some(op => op.kind === 'close-session' && op.state === 'done' && op.payload.sessionId === worker)).toBe(true);
    }
    expect(await fs.readFile(stored, 'utf8')).toBe(bytes);
    expect(bytesHash(await fs.readFile(stored))).toBe(hash);
    expect((await fs.stat(attemptsEngineGitPath(f.projectPath, 'w-01'))).isDirectory()).toBe(true);
    expect(await fs.stat(await f.clone(1)).catch(() => null)).toBeNull();
    await f.mirror();
    const events = [...f.events], refs = await f.bare('show-ref'); await cancel(); await f.flush();
    expect(f.events).toEqual(events); expect(await f.bare('show-ref')).toBe(refs);
  });
});
