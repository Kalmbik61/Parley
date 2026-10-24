import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { addRoom, addSession, ENGINE, HUMAN, parseMap, resume, setProposal, startAttempt, type AttemptChannelRequest, type CheckResult, type RoomPlan, type WorkMap } from '@parley/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutonomousEngine, resolveAutonomousProposal, type EngineIO } from './autonomous-engine.js';
import { attemptsEngineGitPath, type AttemptsProposal } from '../agent/attempts-endpoint.js';

const exec = promisify(execFile);
const dirs: string[] = [];
const engines: ReturnType<typeof createAutonomousEngine>[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  : JSON.stringify(value)!;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const now = new Date('2026-10-24T18:00:00.000Z');

async function fixture(qualitative = false, count = 1) {
  const projectPath = await fs.mkdtemp(path.join(tmpdir(), 'autonomous-engine-')); dirs.push(projectPath);
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.fsmonitor=false', '-C', projectPath, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  await fs.writeFile(path.join(projectPath, 'test.js'), 'console.log("pass");\n');
  await fs.writeFile(path.join(projectPath, '.gitignore'), '.parley/\n');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial');
  const sha = await git('rev-parse', 'HEAD'), blob = await git('rev-parse', 'HEAD:test.js');
  let map: WorkMap = { schemaVersion: 2, work: { id: 'w-01', title: 'Fixture', goal: '', status: 'active', createdAt: now.toISOString(), updatedAt: now.toISOString() }, sessions: [], rooms: [], messages: [] };
  addSession(map, { provider: 'codex', label: 'Lead', task: 'Lead' });
  addRoom(map, { creator: HUMAN, title: 'Plan', members: ['s-01'], lead: 's-01', mode: 'autonomous' });
  const plan: RoomPlan = {
    id: 'pl-01', roomId: 'r-01', mode: 'autonomous', status: 'active', rev: 1, goal: 'Verified change', backlog: [], acceptedAt: now.toISOString(), completedAt: null, cancelledAt: null, completionSummary: null,
    items: Array.from({ length: count }, (_, i) => ({ id: i + 1, title: `Change ${i + 1}`, owner: ENGINE, verifier: ENGINE, scope: 'src', after: [], criteria: ['Works'], status: 'ready', evidence: null, note: null, log: [] })),
    autonomous: {
      criteriaVersion: Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, 1])),
      budget: { limits: { attemptsPerItem: 3, repairWaves: 5, minutesPerAttempt: 30, sessions: 20, concurrent: 4 }, spent: { attempts: 0, repairWaves: 0, sessions: 0, verifiers: 0, minutes: 0, launches: 0 }, reservations: [] },
      checks: Array.from({ length: count }, (_, i) => ({ id: `test-${i + 1}`, item: i + 1, argv: ['node', 'test.js'], cwd: '.', env: {}, inputs: [{ path: 'test.js', blob }], timeoutMs: 1000, frozenAt: now.toISOString() })),
      coverage: Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, { 0: qualitative ? [`test-${i + 1}`, 'verifier'] : [`test-${i + 1}`] }])),
      integration: { branch: 'parley/w-01/integration/pl-01', baseSha: sha, verifiedHead: sha, candidateHead: null, queue: [], suspended: null },
      attempts: [], ops: [], halted: null, seq: { attempt: 0, receipt: 0, check: 0, op: 0 },
    },
  };
  map.plans = [plan];
  const events: string[] = [];
  const io: EngineIO = {
    readMap: async () => structuredClone(map),
    updateMap: async (_project, _work, mutate) => { const draft = structuredClone(map); await mutate(draft); map = draft; return structuredClone(map); },
    fs,
    git: async (args, options) => (await exec('git', args, { ...options, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout,
    now: () => now,
    sleep: async () => {},
    sessions: {
      create: vi.fn(async input => {
        events.push('create');
        const session = addSession(map, { provider: input.provider, label: input.label, task: input.task });
        session.lifecycle = 'pending';
        return { projectPath, workId: 'w-01', sessionId: session.id };
      }),
      launch: vi.fn(async ref => { expect(map.rooms.some(room => room.members.includes(ref.sessionId))).toBe(true); events.push('launch'); map.sessions.find(s => s.id === ref.sessionId)!.lifecycle = 'active'; return 'started' as const; }),
      stop: vi.fn(async ref => { events.push('stop'); map.sessions.find(s => s.id === ref.sessionId)!.lifecycle = 'sleeping'; }),
      close: vi.fn(async ref => { events.push('close'); map.sessions.find(s => s.id === ref.sessionId)!.lifecycle = 'closed'; }),
    },
    runner: vi.fn(async (ctx, spec, captured, attemptId): Promise<CheckResult> => {
      events.push('check');
      return { id: ctx.resultId, specId: spec.id, attemptId, sha: captured, argvHash: digest(spec.argv), envHash: digest(spec.env), inputsOk: true, verdict: 'pass', by: ENGINE, exitCode: 0, summary: 'pass', outputTail: null, at: now.toISOString(), durationMs: 1 };
    }),
  };
  const make = (restart = false, onFailure = vi.fn()) => { const engine = createAutonomousEngine(io, { provider: 'codex', verifier: { provider: 'claude', model: 'sonnet' }, onFailure, ...(restart ? { works: { snapshot: () => ({ entries: [{ projectPath, map }] }) as any, onChange: () => () => {} } } : {}) }); engines.push(engine); return engine; };
  const engine = make();
  const read = (planId = 'pl-01') => map.plans!.find(plan => plan.id === planId)!;
  const attempt = (index = 0, planId = 'pl-01') => read(planId).autonomous!.attempts[index]!;
  const clone = (index = 0, planId = 'pl-01') => path.join(projectPath, `.parley/works/w-01/autonomous/${planId}/attempts`, attempt(index, planId).id, 'clone');
  const submission = (index = 0, artifacts: { path: string; sha256: string; storedAs: string }[] = [], planId = 'pl-01') => {
    const body = { version: 1 as const, criteriaVersion: 1, dependsOn: [], coverage: 'covered' as const, scope: 'src', facts: ['Done'], hypotheses: [], notFound: [], gaps: [], text: 'Done', artifacts, submittedAt: now.toISOString() };
    const manifest = { ...body, hash: digest({ ...body, sha: null }) };
    const request: Extract<AttemptChannelRequest, { action: 'submit' }> = { action: 'submit', attemptId: attempt(index, planId).id, submissionKey: digest(manifest), manifest };
    return request;
  };
  const submit = (index = 0, artifacts: { path: string; sha256: string; storedAs: string }[] = [], planId = 'pl-01') => engine.submit({ projectPath, workId: 'w-01', sessionId: attempt(index, planId).worker! }, planId, read(planId).rev, submission(index, artifacts, planId));
  return { projectPath, git, io, events, engine, make, read, attempt, clone, submit, submission, map: () => map, sha };
}

describe('autonomous engine', () => {
  function secondPlan(f: Awaited<ReturnType<typeof fixture>>, template = f.read()) {
    const lead = addSession(f.map(), { provider: 'codex', label: 'Second lead', task: 'Lead' });
    const room = addRoom(f.map(), { creator: HUMAN, title: 'Second plan', members: [lead.id], lead: lead.id, mode: 'autonomous' });
    const plan = structuredClone(template);
    plan.id = 'pl-02'; plan.roomId = room.id;
    plan.autonomous!.integration.branch = 'parley/w-01/integration/pl-02';
    f.map().plans!.push(plan);
  }

  it('isolates session and capture identities for two plans sharing a work', async () => {
    const f = await fixture(); secondPlan(f);
    await f.engine.flush(f.projectPath, 'w-01');
    const first = f.attempt(), second = f.attempt(0, 'pl-02');
    expect(first.id).toBe('at-0001'); expect(second.id).toBe('at-0001');
    expect(second.worker).not.toBe(first.worker);
    expect(f.io.sessions.create).toHaveBeenCalledTimes(2);
    for (const planId of ['pl-01', 'pl-02']) {
      await fs.writeFile(path.join(f.clone(0, planId), 'result.txt'), planId);
      expect(await f.submit(0, [], planId)).toMatchObject({ ok: true });
      const attempt = f.attempt(0, planId);
      expect(attempt.receipt).toMatchObject({ sha: attempt.sha, valid: true });
      const git = (...args: string[]) => exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, ...args]);
      expect((await git('show', `${attempt.sha}:result.txt`)).stdout).toBe(planId);
      expect((await git('rev-parse', `refs/attempts/${planId}/at-0001`)).stdout.trim()).toBe(attempt.sha);
      const capture = f.read(planId).autonomous!.ops.find(op => op.kind === 'capture')!;
      expect((await git('show', '-s', '--format=%B', attempt.sha!)).stdout.trim()).toBe(`${planId} ${capture.key} at-0001`);
    }
    expect(f.attempt(0, 'pl-02').sha).not.toBe(f.attempt().sha);
  });

  it('never reuses a previous plan capture when a later plan has the same base', async () => {
    const f = await fixture(); const template = structuredClone(f.read());
    await f.engine.flush(f.projectPath, 'w-01');
    await fs.writeFile(path.join(f.clone(), 'result.txt'), 'first plan'); await f.submit();
    const firstSha = f.attempt().sha;
    f.read().status = 'cancelled';
    // Remove label overlap here to exercise capture identity independently of session lookup.
    f.map().sessions.find(session => session.id === f.attempt().worker)!.label = 'retired first worker';
    secondPlan(f, template); await f.engine.flush(f.projectPath, 'w-01');
    await fs.writeFile(path.join(f.clone(0, 'pl-02'), 'result.txt'), 'second plan');
    expect(await f.submit(0, [], 'pl-02')).toMatchObject({ ok: true });
    expect(f.attempt(0, 'pl-02').sha).not.toBe(firstSha);
    expect((await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'show', `${f.attempt(0, 'pl-02').sha}:result.txt`])).stdout).toBe('second plan');
  });
  it('does nothing before Go; creates an isolated attempt after acceptance', async () => {
    const f = await fixture();
    f.read().status = 'proposed';
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.events).toEqual([]);
    await expect(fs.stat(attemptsEngineGitPath(f.projectPath, 'w-01'))).rejects.toThrow();
    f.read().status = 'active';
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.attempt().status).toBe('running');
    expect(f.events).toEqual(['create', 'launch']);
    expect(f.io.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: ENGINE, role: { source: 'builtin', name: 'executor' }, label: expect.stringContaining('at-0001') }));
    expect(await fs.readFile(path.join(f.clone(), 'test.js'), 'utf8')).toContain('pass');
    expect(f.read().autonomous!.budget.reservations).toEqual([]);
    expect(parseMap(JSON.stringify(f.map()), 'fixture').plans![0]!.autonomous!.attempts[0]!.status).toBe('running');
  });

  it('stops before capture, copies artifacts before receipt, and deduplicates submission', async () => {
    const f = await fixture(true);
    await f.engine.flush(f.projectPath, 'w-01');
    await fs.writeFile(path.join(f.clone(), 'result.txt'), 'captured');
    const artifacts = [{ path: 'result.txt', sha256: createHash('sha256').update('captured').digest('hex'), storedAs: '' }];
    const [first, second] = await Promise.all([f.submit(0, artifacts), f.submit(0, artifacts)]);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(f.attempt().receipt?.valid).toBe(true);
    expect(f.read().autonomous!.seq.receipt).toBe(1);
    expect(f.io.sessions.create).toHaveBeenCalledTimes(2);
    expect(f.events.indexOf('stop')).toBeLessThan(f.events.indexOf('check'));
    const stored = f.attempt().manifest!.artifacts[0]!.storedAs;
    await fs.rm(f.clone(), { recursive: true });
    expect(await fs.readFile(path.join(path.dirname(f.clone()), stored), 'utf8')).toBe('captured');
  });

  it('captures through engine config without clone hooks, filters, fsmonitor, signing or clone HEAD', async () => {
    const f = await fixture();
    await f.engine.flush(f.projectPath, 'w-01');
    const marker = path.join(f.projectPath, 'hostile-marker');
    const command = `touch ${marker}`;
    for (const hook of ['pre-commit', 'post-checkout']) {
      const file = path.join(f.clone(), '.git/hooks', hook);
      await fs.writeFile(file, `#!/bin/sh\n${command}\n`); await fs.chmod(file, 0o755);
    }
    for (const [key, value] of [['core.fsmonitor', command], ['filter.evil.clean', command], ['commit.gpgsign', 'true'], ['gpg.program', command]])
      await exec('git', ['-C', f.clone(), 'config', key, value]);
    await fs.writeFile(path.join(f.clone(), '.gitattributes'), '* filter=evil\n');
    await fs.writeFile(path.join(f.clone(), 'result.txt'), 'candidate');
    const result = await f.submit();
    expect(result.ok).toBe(true);
    expect(f.attempt().receipt?.valid).toBe(true);
    await expect(fs.stat(marker)).rejects.toThrow();
    expect((await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'show', `${f.attempt().sha}:result.txt`])).stdout).toBe('candidate');
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.sha);
  });

  it('captures the stopped snapshot and ignores a later edit of the clone', async () => {
    const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
    const stop = f.io.sessions.stop;
    f.io.sessions.stop = async ref => { await fs.writeFile(path.join(f.clone(), 'result.txt'), 'stopped'); await stop(ref); };
    const git = f.io.git;
    f.io.git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('add')) await fs.writeFile(path.join(f.clone(), 'result.txt'), 'late edit');
      return result;
    };
    await f.submit();
    expect((await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'show', `${f.attempt().sha}:result.txt`])).stdout).toBe('stopped');
  });

  it('returns changed frozen inputs before running checks', async () => {
    const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
    await fs.writeFile(path.join(f.clone(), 'test.js'), 'tampered');
    await f.submit();
    expect(f.attempt().receipt).toMatchObject({ valid: false, reason: 'frozen-inputs-changed' });
    expect(f.io.runner).not.toHaveBeenCalled();
  });

  it('does not follow a hostile artifact-directory symlink outside the attempt', async () => {
    const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
    const outside = path.join(f.projectPath, 'outside-artifacts'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(path.dirname(f.clone()), 'artifacts'));
    await fs.writeFile(path.join(f.clone(), 'result.txt'), 'content');
    await f.submit(0, [{ path: 'result.txt', sha256: createHash('sha256').update('content').digest('hex'), storedAs: '' }]);
    expect(f.attempt().receipt?.valid).toBe(false);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('records an invalid receipt for missing artifacts and fences late handoffs', async () => {
    const f = await fixture();
    await f.engine.flush(f.projectPath, 'w-01');
    const artifacts = [{ path: 'missing.txt', sha256: 'a'.repeat(64), storedAs: '' }];
    const first = await f.submit(0, artifacts);
    expect(first.ok).toBe(true);
    expect(f.attempt().receipt).toMatchObject({ valid: false, reason: 'artifacts-invalid' });
    expect(f.attempt().status).toBe('returned');
    expect(await f.submit(0, artifacts)).toEqual(first);
    expect(await f.submit()).toMatchObject({ ok: false, error: { code: 'handoff-conflict' } });
  });

  it('rejects unauthorized verifier results and closes the verifier after all verdicts', async () => {
    const f = await fixture(true);
    await f.engine.flush(f.projectPath, 'w-01'); await f.submit();
    const request = { action: 'verify' as const, attemptId: f.attempt().id, sha: f.attempt().sha!, criterion: 0, verdict: 'pass' as const, note: 'Artifacts establish the criterion' };
    const ref = { projectPath: f.projectPath, workId: 'w-01', sessionId: f.attempt().verifier! };
    expect(await f.engine.verify({ ...ref, sessionId: f.attempt().worker! }, 'pl-01', 1, request)).toMatchObject({ ok: false });
    expect(await f.engine.verify(ref, 'pl-01', 1, { ...request, sha: '0'.repeat(40) })).toMatchObject({ ok: false });
    expect(await f.engine.verify(ref, 'pl-01', 0, request)).toMatchObject({ ok: false });
    expect(await f.engine.verify(ref, 'pl-01', 1, request)).toMatchObject({ ok: true });
    expect(f.attempt().status).toBe('queued');
    expect(f.map().sessions.find(row => row.id === ref.sessionId)?.lifecycle).toBe('closed');
  });

  it('halts when confinement is unavailable and never accepts the candidate', async () => {
    const f = await fixture();
    const runner = f.io.runner;
    f.io.runner = async (...args) => ({ ...await runner(...args), verdict: 'error', summary: 'confinement-unavailable', inputsOk: false });
    await f.engine.flush(f.projectPath, 'w-01'); await f.submit();
    expect(f.read().autonomous!.halted?.reason).toBe('confinement');
    expect(f.attempt().status).not.toBe('accepted');
    expect(f.read().autonomous!.integration.queue).toEqual([]);
  });

  it('halts on resource denial before a session is created', async () => {
    const f = await fixture();
    f.io.sessions.create = vi.fn(async () => { throw new Error('resource-budget'); });
    await expect(f.engine.flush(f.projectPath, 'w-01')).rejects.toThrow('resource-budget');
    expect(f.read().autonomous!.halted?.reason).toBe('budget');
    expect(f.map().sessions).toHaveLength(1);
    expect(f.read().autonomous!.budget.reservations).toEqual([]);
  });

  it('serializes check runs across separate work engines on the host', async () => {
    const [a, b] = await Promise.all([fixture(), fixture()]);
    await Promise.all([a.engine.flush(a.projectPath, 'w-01'), b.engine.flush(b.projectPath, 'w-01')]);
    let concurrent = 0, max = 0;
    const original = a.io.runner;
    const runner: EngineIO['runner'] = async (...args) => {
      concurrent++; max = Math.max(max, concurrent);
      await new Promise(resolve => setTimeout(resolve, 20));
      const result = await original(...args); concurrent--; return result;
    };
    a.io.runner = runner; b.io.runner = runner;
    await Promise.all([a.submit(), b.submit()]);
    expect(max).toBe(1);
    expect(a.attempt().status).toBe('queued'); expect(b.attempt().status).toBe('queued');
  });

  it.each(['create-session', 'launch', 'capture'] as const)('reconciles a crash after %s without repeating execution', async kind => {
    const f = await fixture();
    const update = f.io.updateMap;
    let armed = true;
    f.io.updateMap = async (project, work, mutate, ...rest) => update(project, work, async map => {
      await mutate(map);
      if (armed && map.plans![0]!.autonomous!.ops.some(op => op.kind === kind && op.state === 'done')) {
        armed = false; throw new Error('simulated map write crash');
      }
    }, ...rest);
    if (kind === 'capture') {
      await f.engine.flush(f.projectPath, 'w-01');
      await fs.writeFile(path.join(f.clone(), 'result.txt'), 'captured before crash');
      expect(await f.submit()).toMatchObject({ ok: false });
    } else await expect(f.engine.flush(f.projectPath, 'w-01')).rejects.toThrow('simulated map write crash');
    await f.engine.stop();
    const created = f.io.sessions.create.mock.calls.length;
    const launched = f.io.sessions.launch.mock.calls.length;
    const restarted = f.make(true); restarted.start();
    await restarted.flush(f.projectPath, 'w-01');
    expect(f.read().autonomous!.halted?.reason).toBe('restart');
    expect(f.attempt().status).toBe('aborted');
    expect(f.io.sessions.create).toHaveBeenCalledTimes(created);
    expect(f.io.sessions.launch).toHaveBeenCalledTimes(launched);
    expect(f.read().autonomous!.ops.find(op => op.kind === kind)).toMatchObject({ state: 'done' });
    if (kind === 'create-session') expect(f.attempt().worker).toBeTruthy();
    if (kind === 'capture') expect(f.read().autonomous!.ops.find(op => op.kind === 'capture')!.result!.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(f.io.sessions.stop).toHaveBeenCalled();
  });

  it('fences the whole work and agent requests until a failed recovery write is retried', async () => {
    const f = await fixture(); secondPlan(f);
    f.map().plans![0] = startAttempt(f.read(), { actor: ENGINE, rev: 1, now: now.toISOString(), item: 1, branch: 'attempt', baseSha: f.sha });
    const update = f.io.updateMap;
    let armed = true;
    f.io.updateMap = async (project, work, mutate, ...rest) => update(project, work, async map => {
      await mutate(map);
      if (armed && map.plans![0]!.autonomous!.halted?.reason === 'restart') { armed = false; throw new Error('recovery write unavailable'); }
    }, ...rest);
    const onFailure = vi.fn(), restarted = f.make(true, onFailure);
    restarted.start();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(f.events).toEqual([]);
    expect(f.read().autonomous!.halted).toBeNull();
    const ref = { projectPath: f.projectPath, workId: 'w-01', sessionId: 's-01' };
    expect(await restarted.submit(ref, 'pl-01', 1, f.submission())).toMatchObject({ ok: false, error: { code: 'engine-recovering' } });
    expect(await restarted.verify(ref, 'pl-01', 1, { action: 'verify', attemptId: 'at-0001', sha: f.sha, criterion: 0, verdict: 'pass', note: 'No execution during recovery' })).toMatchObject({ ok: false, error: { code: 'engine-recovering' } });
    await restarted.flush(f.projectPath, 'w-01');
    expect(f.read().autonomous!.halted?.reason).toBe('restart');
    expect(f.read('pl-02').autonomous!.halted?.reason).toBe('restart');
    expect(f.attempt().status).toBe('aborted');
    expect(f.events).toEqual([]);
    await expect(fs.stat(attemptsEngineGitPath(f.projectPath, 'w-01'))).rejects.toThrow();
  });

  it('refuses work and agent requests before startup reconciliation has begun', async () => {
    const f = await fixture();
    f.map().plans![0] = startAttempt(f.read(), { actor: ENGINE, rev: 1, now: now.toISOString(), item: 1, branch: 'attempt', baseSha: f.sha });
    const restarted = f.make(true);
    const ref = { projectPath: f.projectPath, workId: 'w-01', sessionId: 's-01' };
    expect(await restarted.submit(ref, 'pl-01', 1, f.submission())).toMatchObject({ ok: false, error: { code: 'engine-recovering' } });
    expect(await restarted.verify(ref, 'pl-01', 1, { action: 'verify', attemptId: 'at-0001', sha: f.sha, criterion: 0, verdict: 'pass', note: 'Before startup' })).toMatchObject({ ok: false, error: { code: 'engine-recovering' } });
    await expect(restarted.flush(f.projectPath, 'w-01')).rejects.toThrow('engine-recovering');
    expect(f.events).toEqual([]);
    restarted.start(); await restarted.flush(f.projectPath, 'w-01');
    expect(f.read().autonomous!.halted?.reason).toBe('restart');
    expect(f.events).toEqual([]);
  });

  it('keeps recovery fenced when reading Git evidence fails once', async () => {
    const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01'); await f.engine.stop();
    f.attempt().status = 'starting'; f.events.length = 0;
    const git = f.io.git;
    let armed = true;
    const mutations: string[][] = [];
    f.io.git = async (args, options) => {
      if (['clone', 'add', 'commit-tree', 'update-ref', 'fetch'].some(command => args.includes(command))) mutations.push(args);
      if (armed && args.includes('show-ref')) { armed = false; throw new Error('git evidence unavailable'); }
      return git(args, options);
    };
    const onFailure = vi.fn(), restarted = f.make(true, onFailure); restarted.start();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalled());
    expect(f.read().autonomous!.halted).toBeNull();
    expect(f.events).toEqual([]);
    expect(mutations).toEqual([]);
    await restarted.flush(f.projectPath, 'w-01');
    expect(f.read().autonomous!.halted?.reason).toBe('restart');
    expect(f.attempt().status).toBe('aborted');
    expect(f.events.every(event => ['stop', 'close'].includes(event))).toBe(true);
    expect(mutations).toEqual([]);
  });

  it('retains submitted receipts on restart and never reruns checks until human resume', async () => {
    const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
    const runner = f.io.runner;
    f.io.runner = vi.fn(async () => { throw new Error('crash before check'); });
    await f.submit();
    // Model a crash just after receipt persistence and before the first check intent.
    f.read().autonomous!.halted = null;
    f.attempt().status = 'submitted';
    f.read().autonomous!.ops = f.read().autonomous!.ops.filter(op => op.kind !== 'check');
    await f.engine.stop();
    f.io.runner = runner;
    const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
    expect(f.attempt().status).toBe('submitted');
    expect(f.attempt().receipt?.valid).toBe(true);
    expect(f.read().autonomous!.halted?.reason).toBe('restart');
    expect(runner).not.toHaveBeenCalled();
  });

  it('halts and aborts a stuck worker after the attempt time limit', async () => {
    const f = await fixture();
    await f.engine.flush(f.projectPath, 'w-01');
    f.map().sessions.find(row => row.id === f.attempt().worker)!.stuck = { kind: 'approval', since: now.toISOString() } as any;
    f.io.now = () => new Date(now.getTime() + 31 * 60_000);
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.attempt().status).toBe('aborted');
    expect(f.read().autonomous!.halted?.reason).toBe('stuck');
    expect(f.io.sessions.stop).toHaveBeenCalled();
    expect(f.read().autonomous!.attempts).toHaveLength(1);
    expect(f.map().messages.some(row => row.to.includes('s-01') && row.text.includes('at-0001'))).toBe(true);
  });

  it('blocks a repair after two identical failure signatures without a third attempt', async () => {
    const f = await fixture();
    const runner = f.io.runner;
    f.io.runner = async (...args) => ({ ...await runner(...args), verdict: 'fail', exitCode: 1, summary: 'assertion failed' });
    await f.engine.flush(f.projectPath, 'w-01'); await f.submit();
    expect(f.attempt().status).toBe('returned');
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.attempt(1).status).toBe('running');
    await f.submit(1);
    expect(f.attempt(1).status).toBe('blocked');
    expect(f.read().autonomous!.halted?.reason).toBe('no_progress');
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.read().autonomous!.attempts).toHaveLength(2);
  });

  function amendment(f: Awaited<ReturnType<typeof fixture>>, edit: (proposal: AttemptsProposal) => void) {
    const plan = f.read(), a = plan.autonomous!;
    setProposal(f.map(), plan.roomId, 's-01', 'Amend plan', now.toISOString(), { plan: { id: plan.id, rev: plan.rev, mode: 'autonomous', goal: plan.goal, items: plan.items } });
    const proposal = f.map().rooms[0]!.proposal! as AttemptsProposal;
    proposal.autonomousAmendment = { planId: plan.id, rev: plan.rev, draft: { budget: structuredClone(a.budget.limits), coverage: structuredClone(a.coverage), checks: a.checks.map(({ inputs, frozenAt: _at, ...spec }) => ({ ...spec, inputs: inputs.map(row => row.path) })) }, checks: structuredClone(a.checks) };
    edit(proposal);
    const options = { rev: proposal.rev, planId: proposal.plan!.id, planRev: proposal.plan!.rev };
    return { proposal, options };
  }

  it('amends changed criteria and queued dependents atomically, then stops fenced sessions', async () => {
    const f = await fixture(false, 2);
    await f.engine.flush(f.projectPath, 'w-01');
    f.read().items[1]!.after = [1];
    f.attempt(1).status = 'queued'; f.read().autonomous!.integration.queue = [f.attempt(1).id];
    const { proposal, options } = amendment(f, proposal => { proposal.plan!.items[0]!.criteria = ['New criterion']; });
    resolveAutonomousProposal(f.map(), 'r-01', proposal.id, 'accept', options, now.toISOString());
    expect(f.read().rev).toBe(3);
    expect(f.read().autonomous!.criteriaVersion).toEqual({ 1: 2, 2: 1 });
    expect(f.read().autonomous!.attempts.map(row => row.status)).toEqual(['superseded', 'superseded']);
    expect(f.read().autonomous!.integration.queue).toEqual([]);
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.io.sessions.stop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: f.attempt(1).worker }));
  });

  it('preserves unrelated attempts and budget, and invalidates changed frozen specs', async () => {
    const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
    const spent = structuredClone(f.read().autonomous!.budget.spent);
    const untouched = structuredClone(f.attempt(1));
    const { proposal, options } = amendment(f, proposal => {
      proposal.autonomousAmendment!.checks[0]!.argv = ['node', 'changed.js'];
      proposal.autonomousAmendment!.draft.checks[0]!.argv = ['node', 'changed.js'];
    });
    resolveAutonomousProposal(f.map(), 'r-01', proposal.id, 'accept', options, now.toISOString());
    expect(f.attempt().status).toBe('superseded');
    expect(f.attempt(1)).toEqual(untouched);
    expect(f.read().autonomous!.budget.spent).toEqual(spent);
    expect(f.read().autonomous!.criteriaVersion).toEqual({ 1: 2, 2: 1 });
  });

  it('does not create a worker if an amendment fences it while its clone is being made', async () => {
    const f = await fixture();
    const git = f.io.git;
    f.io.git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('checkout')) {
        const { proposal, options } = amendment(f, row => { row.plan!.items[0]!.criteria = ['Changed during clone']; });
        resolveAutonomousProposal(f.map(), 'r-01', proposal.id, 'accept', options, now.toISOString());
      }
      return result;
    };
    await f.engine.flush(f.projectPath, 'w-01').catch(() => {});
    expect(f.attempt().status).toBe('superseded');
    expect(f.io.sessions.create).not.toHaveBeenCalled();
  });

  it('starts no new session when the service stops during clone creation', async () => {
    const f = await fixture();
    const git = f.io.git;
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.io.git = async (args, options) => {
      const result = await git(args, options);
      if (args.includes('checkout')) { entered(); await barrier; }
      return result;
    };
    const running = f.engine.flush(f.projectPath, 'w-01');
    const rejected = expect(running).rejects.toThrow('engine-stopped');
    await inside;
    const stopping = f.engine.stop(); release();
    await stopping; await rejected;
    expect(f.io.sessions.create).not.toHaveBeenCalled();
  });

  it('fences removed items, initializes new items at version one, and returns stale amendments', async () => {
    const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
    const { proposal, options } = amendment(f, proposal => {
      const item = structuredClone(proposal.plan!.items[0]!); item.id = 3;
      proposal.plan!.items = [proposal.plan!.items[1]!, item];
      const draft = proposal.autonomousAmendment!;
      delete draft.draft.coverage[1]; draft.draft.coverage[3] = { 0: ['verifier'] };
      draft.checks = draft.checks.filter(row => row.item !== 1);
      draft.draft.checks = draft.draft.checks.filter(row => row.item !== 1);
    });
    resolveAutonomousProposal(f.map(), 'r-01', proposal.id, 'accept', options, now.toISOString());
    expect(f.attempt().status).toBe('superseded');
    expect(f.read().autonomous!.criteriaVersion).toEqual({ 2: 1, 3: 1 });
    expect(parseMap(JSON.stringify(f.map()), 'fixture').plans![0]!.rev).toBe(3);
    const stale = amendment(f, () => {});
    f.read().rev++;
    const before = structuredClone(f.read());
    resolveAutonomousProposal(f.map(), 'r-01', stale.proposal.id, 'accept', stale.options, now.toISOString());
    expect(f.read()).toEqual(before);
    expect(f.map().rooms[0]!.proposal).toBeNull();
    expect(f.map().messages.some(row => row.text.includes('Amendment revision changed'))).toBe(true);
  });
});


describe('autonomous integration', () => {
  it('integrates independent candidates serially and checks only integrated items plus the candidate', async () => {
    const f = await fixture(false, 2);
    await f.engine.flush(f.projectPath, 'w-01');
    for (const i of [0, 1]) {
      await fs.writeFile(path.join(f.clone(i), `item-${i + 1}.txt`), 'implemented');
      expect(await f.submit(i)).toMatchObject({ ok: true });
    }
    const calls: string[] = [];
    const runner = f.io.runner;
    f.io.runner = vi.fn(async (ctx, spec, sha, attemptId) => {
      calls.push(spec.id);
      await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'cat-file', '-e', `${sha}:item-${spec.item}.txt`]);
      return runner(ctx, spec, sha, attemptId);
    });
    await f.engine.flush(f.projectPath, 'w-01');
    expect(f.read().items.map(item => item.status)).toEqual(['verified', 'verified']);
    expect(calls).toEqual(['test-1', 'test-1', 'test-2']);
    expect(f.read().autonomous!.integration.queue).toEqual([]);
    const head = f.read().autonomous!.integration.verifiedHead;
    expect(await f.git('rev-parse', f.read().autonomous!.integration.branch)).toBe(head);
    expect(await f.git('rev-parse', 'HEAD')).toBe(f.sha);
    await expect(fs.stat(f.clone())).rejects.toMatchObject({ code: 'ENOENT' });
    const create = vi.mocked(f.io.sessions.create).mock.calls[0]![0];
    expect(create.workspace).toMatchObject({ kind: 'clone', path: f.clone(), sha: f.sha });
  });

  it('rechecks an unchanged old-base submission on verifiedHead without moving the head', async () => {
    const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
    await fs.writeFile(path.join(f.clone(), 'item-1.txt'), 'A');
    await f.submit(); await f.engine.flush(f.projectPath, 'w-01');
    const head = f.read().autonomous!.integration.verifiedHead;
    expect(head).not.toBe(f.sha);
    await f.submit(1); await f.engine.flush(f.projectPath, 'w-01');
    expect(f.attempt(1).status).toBe('integrated');
    expect(f.read().autonomous!.integration.verifiedHead).toBe(head);
    expect(f.read().autonomous!.ops.find(op => op.kind === 'noop-integration')).toMatchObject({ state: 'done', result: { sha: head } });
    expect(vi.mocked(f.io.runner).mock.calls.slice(-2).map(args => args[2])).toEqual([head, head]);
  });
});


it('requires a fresh integration verifier for every qualitative item on each candidate', async () => {
  const f = await fixture(true, 2); await f.engine.flush(f.projectPath, 'w-01');
  const verify = (index: number, sessionId: string, sha: string, note: string) => f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt(index).id, sha, criterion: 0, verdict: 'pass', note });
  for (const i of [0, 1]) {
    await fs.writeFile(path.join(f.clone(i), `item-${i}.txt`), i === 0 ? 'screen A calls helper B' : 'helper B changes');
    await f.submit(i);
    expect(await verify(i, f.attempt(i).verifier!, f.attempt(i).sha!, 'acceptance')).toMatchObject({ ok: true });
  }
  await f.engine.flush(f.projectPath, 'w-01');
  const first = f.read().autonomous!.ops.findLast(op => op.payload.purpose === 'integration-verifier' && op.kind === 'create-session')!;
  const candidate = f.read().autonomous!.integration.candidateHead!;
  expect(f.attempt().status).toBe('queued');
  expect(f.read().autonomous!.integration.verifiedHead).toBe(f.sha);
  expect((await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'rev-parse', f.read().autonomous!.integration.branch])).stdout.trim()).toBe(f.sha);
  expect((await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'rev-parse', `refs/candidates/pl-01/${f.attempt().id}`])).stdout.trim()).toBe(candidate);
  expect(await verify(0, f.attempt().verifier!, candidate, 'old verifier')).toMatchObject({ ok: false });
  expect(await verify(0, String(first.result!.sessionId), candidate, 'fresh A')).toMatchObject({ ok: true });
  expect(f.attempt().status).toBe('integrated');
  const second = f.read().autonomous!.ops.findLast(op => op.payload.purpose === 'integration-verifier' && op.kind === 'create-session')!;
  expect(second.key).not.toBe(first.key);
  const head = f.read().autonomous!.integration.candidateHead!;
  expect(await verify(1, String(second.result!.sessionId), head, 'fresh B')).toMatchObject({ ok: true });
  expect(f.attempt(1).status).toBe('queued');
  expect(await verify(0, String(first.result!.sessionId), head, 'stale')).toMatchObject({ ok: false });
  expect(await verify(0, String(second.result!.sessionId), head, 'A with changed helper')).toMatchObject({ ok: true });
  expect(f.attempt(1).status).toBe('integrated');
  expect(f.read().autonomous!.budget.spent.verifiers).toBe(4);
  const creates = vi.mocked(f.io.sessions.create).mock.calls.filter(([input]) => input.role?.name === 'verifier');
  expect(creates.every(([input]) => input.workspace === undefined)).toBe(true);
  expect(creates.at(-1)![0].task).toContain('helper B changes');
  expect(creates.at(-1)![0].task).toContain('at-0001');
  expect(f.map().sessions.find(row => row.id === second.result!.sessionId)?.lifecycle).toBe('closed');
});

it('rolls back candidate failures and preserves the done merge witness', async () => {
  const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'implementation.txt'), 'change'); await f.submit();
  const runner = f.io.runner;
  f.io.runner = vi.fn(async (...args) => ({ ...await runner(...args), verdict: 'fail', summary: 'candidate fails' }));
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.attempt().status).toBe('returned');
  const a = f.read().autonomous!;
  expect(a.integration.verifiedHead).toBe(f.sha); expect(a.integration.candidateHead).toBeNull();
  expect(a.ops.find(op => op.kind === 'merge')).toMatchObject({ state: 'done' });
  expect(a.ops.find(op => op.kind === 'merge-abort')).toMatchObject({ state: 'done' });
  expect((await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'rev-parse', a.integration.branch])).stdout.trim()).toBe(f.sha);
  expect(a.attempts.filter(attempt => attempt.item === 1 && attempt.status === 'running')).toHaveLength(1);
});

it('cleans the disposable integration checkout before the next merge', async () => {
  const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit(); await f.engine.flush(f.projectPath, 'w-01');
  const dir = path.join(f.projectPath, '.parley/works/w-01/autonomous/pl-01/integration');
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'untracked');
  await f.submit(1); await f.engine.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.integration.suspended).toBeNull();
  expect(f.attempt(1).status).toBe('integrated');
  await expect(fs.stat(path.join(dir, 'dirty.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});


it.each(['merge', 'integrate', 'noop'] as const)('recovers a %s crash and reruns candidate checks before advancing the queue', async crash => {
  const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  if (crash === 'noop') {
    await f.engine.flush(f.projectPath, 'w-01');
    await f.submit(1);
  } else {
    await fs.writeFile(path.join(f.clone(1), 'B.txt'), 'B'); await f.submit(1);
  }
  const update = f.io.updateMap;
  let injected = false;
  f.io.updateMap = async (project, work, mutate) => update(project, work, async draft => {
    await mutate(draft);
    const a = draft.plans![0]!.autonomous!;
    const hit = crash === 'integrate' ? a.attempts[0]!.status === 'integrated' :
      a.ops.some(op => op.kind === (crash === 'noop' ? 'noop-integration' : 'merge') && op.state === 'done');
    if (!injected && hit) { injected = true; throw new Error('integration crash'); }
  });
  await expect(f.engine.flush(f.projectPath, 'w-01')).rejects.toThrow('integration crash');
  await f.engine.stop(); f.io.updateMap = update;
  const before = f.read().autonomous!.integration.verifiedHead;
  const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.halted?.reason).toBe('restart');
  const candidate = f.read().autonomous!.integration.candidateHead;
  expect(candidate).not.toBeNull();
  expect(f.read().autonomous!.integration.verifiedHead).toBe(before);
  const runner = f.io.runner;
  const calls: string[] = [];
  f.io.runner = vi.fn(async (...args) => { calls.push(args[2]); return runner(...args); });
  f.map().plans![0] = resume(f.read(), { actor: ENGINE, rev: 1, now: now.toISOString(), requestedBy: HUMAN });
  await restarted.flush(f.projectPath, 'w-01');
  expect(calls[0]).toBe(candidate);
  expect(f.read().items.every(item => item.status === 'verified')).toBe(true);
  if (crash === 'noop') expect(f.read().autonomous!.integration.verifiedHead).toBe(before);
});

it('ignores the integration checkout as a recovery witness', async () => {
  const f = await fixture(true); await f.engine.flush(f.projectPath, 'w-01'); await f.submit();
  await f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: f.attempt().verifier! }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt().id, sha: f.attempt().sha!, criterion: 0, verdict: 'pass', note: 'accept' });
  await f.engine.flush(f.projectPath, 'w-01'); await f.engine.stop();
  const dir = path.join(f.projectPath, '.parley/works/w-01/autonomous/pl-01/integration');
  await exec('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@test', 'commit', '--allow-empty', '-m', 'unconfirmed']);
  const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.integration.candidateHead).toBe(f.sha);
  expect((await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()).not.toBe(f.sha);
  expect(f.read().autonomous!.halted?.reason).toBe('restart');
});


it('aborts a conflicting merge, continues the queue, and creates one repair from verifiedHead', async () => {
  const f = await fixture(false, 3); await f.engine.flush(f.projectPath, 'w-01');
  for (const i of [0, 1]) await fs.writeFile(path.join(f.clone(i), 'shared.txt'), i === 0 ? 'A' : 'B');
  await fs.writeFile(path.join(f.clone(2), 'independent.txt'), 'C');
  for (const i of [0, 1, 2]) await f.submit(i);
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.attempt().status).toBe('integrated');
  expect(f.attempt(1).status).toBe('returned');
  expect(f.attempt(1).log.some(row => row.note === 'conflict')).toBe(true);
  expect(f.attempt(2).status).toBe('integrated');
  const a = f.read().autonomous!;
  expect(a.ops.find(op => op.kind === 'merge' && op.attemptId === f.attempt(1).id)).toMatchObject({ state: 'failed', result: { reason: 'integration-conflict' } });
  const repair = a.attempts.filter(row => row.item === 2 && row.n === 2);
  expect(repair).toHaveLength(1);
  expect(repair[0]).toMatchObject({ status: 'running', baseSha: a.integration.verifiedHead });
  expect(a.integration.suspended).toBeNull();
  expect(a.halted).toBeNull();
  const dir = path.join(f.projectPath, '.parley/works/w-01/autonomous/pl-01/integration');
  await expect(fs.stat(path.join(dir, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('returns a regressing candidate while retaining evidence at verifiedHead and briefs its repair with prior item failures', async () => {
  const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit(); await f.engine.flush(f.projectPath, 'w-01');
  const evidence = structuredClone(f.read().items[0]!.evidence);
  const head = f.read().autonomous!.integration.verifiedHead;
  await fs.writeFile(path.join(f.clone(1), 'B.txt'), 'regresses A'); await f.submit(1);
  const runner = f.io.runner;
  f.io.runner = vi.fn(async (...args) => ({ ...await runner(...args), ...(args[1].item === 1 ? { verdict: 'fail' as const, summary: 'A breaks through helper B' } : {}) }));
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.attempt(1).status).toBe('returned');
  expect(f.read().items[0]).toMatchObject({ status: 'verified', evidence });
  expect(f.read().autonomous!.integration.verifiedHead).toBe(head);
  const brief = vi.mocked(f.io.sessions.create).mock.calls.at(-1)![0].task;
  expect(brief).toContain('A breaks through helper B');
  expect(brief).toContain('regresses A');
  expect(brief).toContain('"item":1');
});

it('releases dependencies only after integration, with the verified head as their clone base', async () => {
  const f = await fixture(false, 2);
  f.read().items[1]!.after = [1]; f.read().items[1]!.status = 'waiting';
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.attempts).toHaveLength(1);
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  expect(f.attempt().status).toBe('queued');
  expect(f.read().autonomous!.attempts).toHaveLength(1);
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.attempt(1)).toMatchObject({ item: 2, status: 'running', baseSha: f.read().autonomous!.integration.verifiedHead });
});

it('refuses a divergent project integration mirror without publishing an unchecked candidate', async () => {
  const f = await fixture(true); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  await f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: f.attempt().verifier! }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt().id, sha: f.attempt().sha!, criterion: 0, verdict: 'pass', note: 'accept' });
  await f.engine.flush(f.projectPath, 'w-01');
  const branch = f.read().autonomous!.integration.branch;
  await expect(f.git('rev-parse', '--verify', branch)).rejects.toThrow();
  const unrelated = await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@test', 'commit-tree', `${f.sha}^{tree}`, '-p', f.sha, '-m', 'Project branch changed');
  await f.git('update-ref', `refs/heads/${branch}`, unrelated);
  const creation = f.read().autonomous!.ops.findLast(op => op.kind === 'create-session' && op.payload.purpose === 'integration-verifier')!;
  expect(await f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: String(creation.result!.sessionId) }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt().id, sha: f.read().autonomous!.integration.candidateHead!, criterion: 0, verdict: 'pass', note: 'fresh' })).toMatchObject({ ok: false });
  expect(await f.git('rev-parse', branch)).toBe(unrelated);
  expect(await f.git('rev-parse', 'HEAD')).toBe(f.sha);
});


it('blocks repeated identical integration failures through the existing no-progress rule', async () => {
  const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
  const runner = f.io.runner;
  f.io.runner = vi.fn(async (...args) => ({ ...await runner(...args), ...(f.read().autonomous!.ops.findLast(op => op.kind === 'check')?.payload.phase === 'integration' ? { verdict: 'fail' as const, summary: 'same integration defect' } : {}) }));
  for (const index of [0, 1]) {
    await fs.writeFile(path.join(f.clone(index), 'A.txt'), 'same defect');
    await f.submit(index); await f.engine.flush(f.projectPath, 'w-01');
  }
  expect(f.attempt(1).status).toBe('blocked');
  expect(f.attempt(1).failureSignature).toBe(f.attempt().failureSignature);
  expect(f.read().autonomous!.halted?.reason).toBe('no_progress');
  expect(f.read().autonomous!.integration.verifiedHead).toBe(f.sha);
});

it('recreates a broken disposable integration clone before processing the next candidate', async () => {
  const f = await fixture(false, 2); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit(); await f.engine.flush(f.projectPath, 'w-01');
  const dir = path.join(f.projectPath, '.parley/works/w-01/autonomous/pl-01/integration');
  await fs.rm(path.join(dir, '.git'), { recursive: true, force: true });
  await f.submit(1); await f.engine.flush(f.projectPath, 'w-01');
  expect(f.attempt(1).status).toBe('integrated');
  expect(f.read().autonomous!.ops.filter(op => op.kind === 'clone' && op.payload.purpose === 'integration' && op.state === 'done')).toHaveLength(2);
});

it('allocates a new check result ID after a crash between effect settlement and check recording', async () => {
  const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  const update = f.io.updateMap;
  let injected = false;
  f.io.updateMap = async (project, work, mutate) => update(project, work, async draft => {
    await mutate(draft);
    const a = draft.plans![0]!.autonomous!;
    const op = a.ops.findLast(row => row.kind === 'check' && row.payload.phase === 'integration');
    const result = op?.result?.checkResult as CheckResult | undefined;
    if (!injected && result && a.attempts.some(attempt => attempt.checks.includes(result.id))) { injected = true; throw new Error('record crash'); }
  });
  await expect(f.engine.flush(f.projectPath, 'w-01')).rejects.toThrow('record crash');
  await f.engine.stop(); f.io.updateMap = update;
  const previousId = (f.read().autonomous!.ops.findLast(op => op.kind === 'check')!.result!.checkResult as CheckResult).id;
  const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
  f.map().plans![0] = resume(f.read(), { actor: ENGINE, rev: 1, now: now.toISOString(), requestedBy: HUMAN });
  await restarted.flush(f.projectPath, 'w-01');
  expect(f.attempt().status).toBe('integrated');
  expect(vi.mocked(f.io.runner).mock.calls.at(-1)![0].resultId).not.toBe(previousId);
});


it('accepts another attempt verifier while a candidate integration verifier is pending', async () => {
  const f = await fixture(true, 2); await f.engine.flush(f.projectPath, 'w-01');
  for (const i of [0, 1]) { await fs.writeFile(path.join(f.clone(i), `item-${i}.txt`), 'work'); await f.submit(i); }
  const verify = (index: number) => f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: f.attempt(index).verifier! }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt(index).id, sha: f.attempt(index).sha!, criterion: 0, verdict: 'pass', note: 'accept' });
  expect(await verify(0)).toMatchObject({ ok: true });
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.integration.candidateHead).not.toBeNull();
  expect(await verify(1)).toMatchObject({ ok: true });
  expect(f.attempt(1).status).toBe('queued');
});


it('starts a fresh qualitative verifier after restart and ignores verdicts from the old session', async () => {
  const f = await fixture(true); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  await f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: f.attempt().verifier! }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt().id, sha: f.attempt().sha!, criterion: 0, verdict: 'pass', note: 'accept' });
  await f.engine.flush(f.projectPath, 'w-01'); await f.engine.stop();
  const old = f.read().autonomous!.ops.findLast(op => op.kind === 'create-session' && op.payload.purpose === 'integration-verifier')!;
  const sha = f.read().autonomous!.integration.candidateHead!;
  const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
  f.map().plans![0] = resume(f.read(), { actor: ENGINE, rev: 1, now: now.toISOString(), requestedBy: HUMAN });
  await restarted.flush(f.projectPath, 'w-01');
  const fresh = f.read().autonomous!.ops.findLast(op => op.kind === 'create-session' && op.payload.purpose === 'integration-verifier')!;
  expect(fresh.result!.sessionId).not.toBe(old.result!.sessionId);
  const request = { action: 'verify' as const, attemptId: f.attempt().id, sha, criterion: 0, verdict: 'pass' as const, note: 'fresh' };
  expect(await restarted.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: String(old.result!.sessionId) }, 'pl-01', 1, request)).toMatchObject({ ok: false });
  expect(await restarted.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: String(fresh.result!.sessionId) }, 'pl-01', 1, request)).toMatchObject({ ok: true });
  expect(f.attempt().status).toBe('integrated');
});

it('leaves interrupted MERGE_HEAD untouched until a resumed merge prepares the checkout', async () => {
  const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  const git = f.io.git, update = f.io.updateMap;
  f.io.git = async (args, options) => {
    if (args.includes('--no-ff')) {
      await git([...args.slice(0, args.indexOf('merge') + 1), '--no-ff', '--no-commit', args.at(-1)!], options);
      throw new Error('merge interrupted');
    }
    return git(args, options);
  };
  f.io.updateMap = async (project, work, mutate) => update(project, work, async draft => {
    await mutate(draft);
    if (draft.plans![0]!.autonomous!.ops.some(op => op.kind === 'merge' && op.state === 'failed')) throw new Error('crash before merge settled');
  });
  await expect(f.engine.flush(f.projectPath, 'w-01')).rejects.toThrow('crash before merge settled');
  await f.engine.stop(); f.io.git = git; f.io.updateMap = update;
  const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.ops.find(op => op.kind === 'merge')).toMatchObject({ state: 'failed' });
  const dir = path.join(f.projectPath, '.parley/works/w-01/autonomous/pl-01/integration');
  expect((await fs.stat(path.join(dir, '.git', 'MERGE_HEAD'))).isFile()).toBe(true);
  f.map().plans![0] = resume(f.read(), { actor: ENGINE, rev: 1, now: now.toISOString(), requestedBy: HUMAN });
  await restarted.flush(f.projectPath, 'w-01');
  await expect(fs.stat(path.join(dir, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.attempt().status).toBe('integrated');
});


it('performs no Git mutation when recovery persistence fails after an unwitnessed local merge', async () => {
  const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit();
  const git = f.io.git, update = f.io.updateMap;
  f.io.git = async (args, options) => {
    if (args.some(arg => arg.includes('refs/candidates/'))) throw new Error('crash before candidate publication');
    return git(args, options);
  };
  f.io.updateMap = async (project, work, mutate) => update(project, work, async draft => {
    await mutate(draft);
    if (draft.plans![0]!.autonomous!.ops.some(op => op.kind === 'merge' && op.state === 'failed')) throw new Error('crash before settle');
  });
  await expect(f.engine.flush(f.projectPath, 'w-01')).rejects.toThrow('crash before settle');
  await f.engine.stop();
  const mutations: string[] = [];
  f.io.git = async (args, options) => {
    if (args.some(arg => ['fetch', 'update-ref', 'reset', 'merge', 'clean', 'checkout', 'clone'].includes(arg))) mutations.push(args.join(' '));
    return git(args, options);
  };
  let fail = true;
  f.io.updateMap = async (project, work, mutate) => update(project, work, async draft => {
    await mutate(draft);
    if (fail && draft.plans![0]!.autonomous!.halted?.reason === 'restart') { fail = false; throw new Error('restart persistence failed'); }
  });
  const failures = vi.fn(), restarted = f.make(true, failures); restarted.start();
  await vi.waitFor(() => expect(failures).toHaveBeenCalled());
  expect(mutations).toEqual([]); expect(f.read().autonomous!.halted).toBeNull();
  await restarted.flush(f.projectPath, 'w-01');
  expect(mutations).toEqual([]);
  expect(f.read().autonomous!.halted?.reason).toBe('restart');
  expect(f.read().autonomous!.integration.candidateHead).toBeNull();
  expect(f.attempt().status).toBe('queued');
  expect(f.read().autonomous!.ops.find(op => op.kind === 'merge')?.state).toBe('failed');
});

it('halts a timed-out live integration verifier and journals its stop/close', async () => {
  const f = await fixture(true); await f.engine.flush(f.projectPath, 'w-01'); await f.submit();
  await f.engine.verify({ projectPath: f.projectPath, workId: 'w-01', sessionId: f.attempt().verifier! }, 'pl-01', 1,
    { action: 'verify', attemptId: f.attempt().id, sha: f.attempt().sha!, criterion: 0, verdict: 'pass', note: 'accepted' });
  f.io.now = () => new Date(now.getTime() + 25 * 60_000);
  await f.engine.flush(f.projectPath, 'w-01');
  const verifier = f.read().autonomous!.ops.findLast(op => op.kind === 'create-session' && op.payload.purpose === 'integration-verifier')!;
  f.map().sessions.find(row => row.id === verifier.result!.sessionId)!.stuck = { kind: 'approval', since: now.toISOString() } as any;
  f.io.now = () => new Date(now.getTime() + 31 * 60_000);
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.halted).toBeNull();
  f.io.now = () => new Date(now.getTime() + 56 * 60_000);
  await f.engine.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.halted?.reason).toBe('stuck');
  expect(f.map().sessions.find(row => row.id === verifier.result!.sessionId)?.lifecycle).toBe('closed');
  expect(f.read().autonomous!.ops.some(op => op.kind === 'stop-session' && op.payload.sessionId === verifier.result!.sessionId && op.state === 'done')).toBe(true);
  expect(f.read().autonomous!.ops.some(op => op.kind === 'close-session' && op.payload.sessionId === verifier.result!.sessionId && op.state === 'done')).toBe(true);
});


it('halts on a bare integration branch mismatch without repairing Git during reconciliation', async () => {
  const f = await fixture(); await f.engine.flush(f.projectPath, 'w-01');
  await fs.writeFile(path.join(f.clone(), 'A.txt'), 'A'); await f.submit(); await f.engine.stop();
  await exec('git', [`--git-dir=${attemptsEngineGitPath(f.projectPath, 'w-01')}`, 'update-ref', `refs/heads/${f.read().autonomous!.integration.branch}`, f.attempt().sha!]);
  const git = f.io.git, mutations: string[] = [];
  f.io.git = async (args, options) => { if (args.some(arg => ['fetch', 'update-ref', 'reset', 'merge', 'clean'].includes(arg))) mutations.push(args.join(' ')); return git(args, options); };
  const restarted = f.make(true); restarted.start(); await restarted.flush(f.projectPath, 'w-01');
  expect(f.read().autonomous!.halted?.detail).toContain('differs from verifiedHead');
  expect(mutations).toEqual([]);
});
