import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createPendingSession, FEED_TEXT_LIMIT, readMap, unreadLetters, updateMap, workPaths } from '@parley/core';
import { KIMI_LAUNCH_MODES_FEATURE, feedItem, type MethodName, type Params, type Result, type SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected, type RawMessage, type TestClient } from '../../test/helpers.js';
import { startHost, type RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

const r2Faults = vi.hoisted(() => ({
  trace: null as string[] | null,
  failPublish: false,
  failActivation: false,
  failRelease: false,
}));

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  const updateMap: typeof core.updateMap = (projectPath, workId, mutate, options) =>
    core.updateMap(projectPath, workId, (map, letters) => {
      const before = r2Faults.trace !== null || r2Faults.failPublish
        ? new Set(map.sessions.filter((session) => session.kimiTerminal !== undefined).map(({ id }) => id))
        : undefined;
      mutate(map, letters);
      if (before === undefined) return;
      for (const item of map.sessions) {
        if (!before.has(item.id) && item.kimiTerminal !== undefined) {
          r2Faults.trace?.push('publish');
          if (r2Faults.failPublish) throw new Error('Fixture refused the archive marker write');
        }
        if (before.has(item.id) && item.kimiTerminal === undefined) {
          r2Faults.trace?.push('release');
          if (r2Faults.failRelease) throw new Error('Fixture refused the marker release');
        }
      }
    }, options);
  return { ...core, updateMap };
});

vi.mock('../feed/feed-service.js', async (importOriginal) => {
  const feedModule = await importOriginal<typeof import('../feed/feed-service.js')>();
  const createFeedService: typeof feedModule.createFeedService = (...args) => {
    const service = feedModule.createFeedService(...args);
    return {
      ...service,
      async kimiPrepareHistory(...params) {
        const install = await service.kimiPrepareHistory(...params);
        return () => {
          r2Faults.trace?.push('activate');
          if (r2Faults.failActivation) throw new Error('Fixture refused feed activation');
          install();
        };
      },
    };
  };
  return { ...feedModule, createFeedService };
});

let home: string | undefined;
let running: RunningHost | undefined;
let client: TestClient | undefined;
let id = 100;
let events: RawMessage[] = [];

async function request<M extends MethodName>(method: M, params: Params<M>): Promise<RawMessage> {
  const requestId = ++id;
  client!.send({ id: requestId, method, params });
  for (;;) {
    const next = await client!.next();
    if (next.id === requestId) return next;
    if (next.event !== undefined) events.push(next);
  }
}

async function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  const response = await request(method, params);
  if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
  return response.result as Result<M>;
}

async function setup(loggedOut = false, standalone = false): Promise<string> {
  home = await tempHome();
  const binary = path.join(home, standalone ? '.kimi-code/bin/kimi' : 'kimi');
  if (standalone) await mkdir(path.dirname(binary), { recursive: true });
  const project = path.join(home, 'project');
  await mkdir(project);
  await writeFile(binary, await readFile(new URL('./fixtures/acp.cjs', import.meta.url)), { mode: 0o755 });
  vi.stubEnv('PARLEY_KIMI_BIN', standalone ? undefined : binary);
  if (standalone) {
    vi.stubEnv('HARNAS_KIMI_BIN', undefined);
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', path.dirname(process.execPath));
  }
  vi.stubEnv('KIMI_FIXTURE_MODEL_FILE', path.join(home, 'fixture-model'));
  if (loggedOut) vi.stubEnv('KIMI_FIXTURE_LOGGED_OUT', '1');
  await connectIsolatedHost();
  return project;
}

async function connectIsolatedHost(): Promise<void> {
  running = await startHost({ home: home! });
  const paths = hostPaths(home!);
  client = connectRaw(paths.socket);
  await waitConnected(client.socket);
  const handshake = await hello(client, await readFile(paths.token, 'utf8'));
  expect(handshake.error).toBeUndefined();
  expect(handshake.result).toMatchObject({ features: expect.arrayContaining([KIMI_LAUNCH_MODES_FEATURE]) });
}

afterEach(async () => {
  client?.close();
  await running?.context.shutdown('test');
  await running?.closed;
  if (home !== undefined) await removeHome(home);
  client = undefined;
  running = undefined;
  home = undefined;
  events = [];
  r2Faults.trace = null;
  r2Faults.failPublish = false;
  r2Faults.failActivation = false;
  r2Faults.failRelease = false;
  vi.unstubAllEnvs();
});

const input = (projectPath: string) => ({ projectPath, workId: null, provider: 'kimi', label: '', task: '', parent: null });

async function session(ref: SessionRef) {
  return (await readMap(ref.projectPath, ref.workId)).sessions.find((entry) => entry.id === ref.sessionId);
}

it('uses ordinary session and Chat RPC, calls the real Parley MCP, then cancels and resumes the bound ACP session', async () => {
  const projectPath = await setup();
  const providers = await call('providers.list', {});
  expect(providers.providers.find(({ id }) => id === 'kimi')).toMatchObject({ label: 'Kimi Code', available: true });
  const { ref } = await call('sessions.create', input(projectPath));
  expect(await session(ref)).toMatchObject({ lifecycle: 'active', provider: 'kimi', providerSessionId: 'acp-session' });
  expect((await call('kimi.getState', { ref })).config).toMatchObject([
    { id: 'mode', currentValue: 'default' }, { id: 'model', currentValue: 'alpha' },
  ]);
  expect(await call('kimi.setConfig', { ref, configId: 'mode', value: 'plan' })).toMatchObject({
    config: [{ id: 'mode', currentValue: 'plan' }, { id: 'model', currentValue: 'alpha' }],
  });
  expect(await call('kimi.setConfig', { ref, configId: 'model', value: 'beta' })).toMatchObject({
    config: [{ id: 'mode', currentValue: 'plan' }, { id: 'model', currentValue: 'beta' }],
  });
  expect(events).toContainEqual(expect.objectContaining({
    event: 'kimi.configChanged', data: { ref, config: expect.arrayContaining([expect.objectContaining({ id: 'model', currentValue: 'beta' })]) },
  }));
  expect(await call('pty.send', { ref, text: 'call Parley', submit: true })).toMatchObject({ submitted: true });
  await expect.poll(() => call('feed.snapshot', { ref })).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ kind: 'text', text: 'Parley session: s-01', streaming: false })]),
  });
  expect(await call('pty.send', { ref, text: 'wait', submit: true })).toMatchObject({ submitted: true });
  await call('feed.interrupt', { ref });
  await expect.poll(() => call('feed.snapshot', { ref })).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ kind: 'turn', interrupted: true })]),
  });
  expect(await call('pty.send', { ref, text: 'disconnect', submit: true })).toMatchObject({ submitted: true });
  await expect.poll(() => session(ref)).toMatchObject({ lifecycle: 'sleeping', providerSessionId: 'acp-session' });
  await call('sessions.resume', { ref });
  expect(await session(ref)).toMatchObject({ lifecycle: 'active', providerSessionId: 'acp-session' });
  expect((await call('kimi.getState', { ref })).config).toContainEqual(expect.objectContaining({ id: 'model', currentValue: 'beta' }));
  expect(await call('pty.send', { ref, text: 'hello', submit: true })).toMatchObject({ submitted: true });
  await expect.poll(() => call('feed.snapshot', { ref })).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ kind: 'text', text: 'Hello Parley', streaming: false })]),
  });
}, 15_000);

it('applies catalog choices before its first prompt and restores subsequent chat changes on resume', async () => {
  vi.stubEnv('KIMI_FIXTURE_CREATION_CONFIG', '1');
  const projectPath = await setup();
  const traceFile = path.join(home!, 'startup-trace');
  vi.stubEnv('KIMI_FIXTURE_TRACE', traceFile);
  await writeFile(path.join(home!, 'providers.json'), JSON.stringify({ kimi: { models: [
    { id: 'alpha', label: 'Alpha', efforts: ['low', 'high'] },
    { id: 'beta', label: 'Beta', efforts: ['low', 'high', 'max'] },
  ] } }));
  const { ref } = await call('sessions.create', { ...input(projectPath), task: 'hello', model: 'beta', effort: 'max' });
  await expect.poll(() => readFile(traceFile, 'utf8')).toContain('"prompt"');
  const trace = (await readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(trace.slice(0, 2)).toEqual([{ configId: 'model', value: 'beta' }, { configId: 'thinking', value: 'max' }]);
  expect(trace[2]).toMatchObject({ prompt: expect.stringContaining('hello'), model: 'beta', effort: 'max' });
  expect(await session(ref)).toMatchObject({ model: 'beta', effort: 'max' });
  await expectReply(ref, 'Hello Parley');
  expect(await call('kimi.setConfig', { ref, configId: 'model', value: 'alpha' })).toMatchObject({
    config: expect.arrayContaining([expect.objectContaining({ id: 'model', currentValue: 'alpha' })]),
  });
  await call('pty.send', { ref, text: 'disconnect', submit: true });
  await expect.poll(() => session(ref)).toMatchObject({ lifecycle: 'sleeping' });
  await call('sessions.resume', { ref });
  expect((await call('kimi.getState', { ref })).config).toContainEqual(expect.objectContaining({ id: 'model', currentValue: 'alpha' }));
}, 15_000);

it('distinguishes sign-in required and a missing CLI on ordinary create', async () => {
  const projectPath = await setup(true, true);
  expect((await request('sessions.create', input(projectPath))).error).toMatchObject({ data: { reason: 'kimi-sign-in' } });
  expect((await call('providers.list', {})).providers.find(({ id }) => id === 'kimi')).toMatchObject({ available: false, needs: 'sign-in' });
  vi.stubEnv('PARLEY_KIMI_BIN', '/no/such/kimi');
  expect((await request('sessions.create', input(projectPath))).error).toMatchObject({ data: { reason: 'kimi-missing-cli' } });
  expect((await call('providers.list', {})).providers.find(({ id }) => id === 'kimi')).toMatchObject({ available: false, needs: 'cli' });
}, 15_000);

async function pendingCard(ref: SessionRef, kind: 'permission' | 'question') {
  const find = async () => (await call('feed.snapshot', { ref })).items.find(
    (item) => item.kind === kind && item.state === 'pending',
  );
  await expect.poll(find).toBeDefined();
  const card = await find();
  if (card?.kind !== 'permission' && card?.kind !== 'question') throw new Error('Missing pending card');
  expect(feedItem.parse(card)).toEqual(card);
  return card;
}

async function expectReply(ref: SessionRef, text: string) {
  await expect.poll(() => call('feed.snapshot', { ref })).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ kind: 'text', text, streaming: false })]),
  });
}

it('holds the action for an explicit permission decision and delivers each choice once', async () => {
  const projectPath = await setup();
  const file = path.join(projectPath, 'notes.md');
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'approve and write', submit: true });
  const denied = await pendingCard(ref, 'permission');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await call('feed.decide', { ref, cardId: denied.id, decision: { kind: 'permission', behavior: 'allow', optionId: 'deny' } })).toEqual({ applied: false, state: 'pending' });
  expect(await call('feed.decide', { ref, cardId: denied.id, decision: { kind: 'permission', behavior: 'deny', optionId: 'deny' } })).toEqual({ applied: true, state: 'denied' });
  await expectReply(ref, 'deny');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await call('feed.decide', { ref, cardId: denied.id, decision: { kind: 'permission', behavior: 'allow', optionId: 'allow' } })).toEqual({ applied: false, state: 'denied' });

  await call('pty.send', { ref, text: 'approve and write', submit: true });
  const allowed = await pendingCard(ref, 'permission');
  expect(allowed.id).not.toBe(denied.id);
  expect(await call('feed.decide', { ref, cardId: allowed.id, decision: { kind: 'permission', behavior: 'allow', optionId: 'allow' } })).toEqual({ applied: true, state: 'allowed' });
  await expectReply(ref, 'allow');
  expect(await readFile(file, 'utf8')).toBe('after');
}, 15_000);

it('routes a form and a fallback question in different sessions without crossing responses', async () => {
  vi.stubEnv('KIMI_FIXTURE_UNIQUE_IDS', '1');
  const projectPath = await setup();
  const { ref } = await call('sessions.create', input(projectPath));
  const { ref: other } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'mixed form', submit: true });
  await call('pty.send', { ref: other, text: 'fallback question', submit: true });
  const form = await pendingCard(ref, 'question');
  const fallback = await pendingCard(other, 'question');
  expect(fallback).toMatchObject({ questions: [{ question: 'Which release?' }] });
  expect((await request('feed.decide', { ref, cardId: fallback.id, decision: { kind: 'question', answers: {}, values: { answer: 'option:stable' } } })).error).toBeDefined();
  expect(await call('feed.decide', { ref: other, cardId: fallback.id, decision: { kind: 'permission', behavior: 'allow' } })).toEqual({ applied: false, state: 'pending' });
  expect(await call('feed.decide', { ref: other, cardId: fallback.id, decision: { kind: 'question', answers: {}, values: { answer: 'option:stable' } } })).toEqual({ applied: true, state: 'answered' });
  await expectReply(other, 'option:stable');
  expect(await call('feed.decide', { ref, cardId: form.id, decision: { kind: 'question', answers: {}, values: { channels: ['unlisted'], note: 'Free text' } } })).toEqual({ applied: false, state: 'pending' });
  expect(await call('feed.decide', { ref, cardId: form.id, decision: { kind: 'question', answers: {}, values: { channels: ['stable', 'beta'], note: 'Free text' } } })).toEqual({ applied: true, state: 'answered' });
  await expectReply(ref, '{"channels":["stable","beta"],"note":"Free text"}');
}, 15_000);

it('removes a cancelled request from attention and rejects a stale click', async () => {
  const projectPath = await setup();
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'approve and write', submit: true });
  const card = await pendingCard(ref, 'permission');
  await call('feed.interrupt', { ref });
  await expect.poll(async () => (await call('feed.snapshot', { ref })).items.find((item) => item.id === card.id)).toMatchObject({ state: 'stale' });
  expect((await call('feed.snapshot', { ref, scope: 'attention' })).items).toEqual([]);
  expect(await call('feed.decide', { ref, cardId: card.id, decision: { kind: 'permission', behavior: 'allow', optionId: 'allow' } })).toEqual({ applied: false, state: 'stale' });
  await expect(readFile(path.join(projectPath, 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);

it('lets Kimi fall back when the requested form cannot be rendered', async () => {
  const projectPath = await setup();
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'unsupported form', submit: true });
  const card = await pendingCard(ref, 'question');
  expect(card).toMatchObject({ questions: [{ question: 'Which release?', options: [
    { label: 'Stable', value: 'option:stable' }, { label: 'Skip', value: 'q0_skip' },
  ] }] });
  expect(await call('feed.decide', { ref, cardId: card.id, decision: { kind: 'question', answers: {}, values: { answer: 'q0_skip' } } })).toEqual({ applied: true, state: 'answered' });
  await expectReply(ref, 'q0_skip');
}, 15_000);

it('answers the correct request when two live cards use the same form key', async () => {
  const projectPath = await setup();
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'parallel questions', submit: true });
  const questions = async () => (await call('feed.snapshot', { ref, scope: 'attention' })).items
    .filter((item) => item.kind === 'question');
  await expect.poll(questions).toHaveLength(2);
  const [first, second] = await questions();
  expect(first?.formPrompt).toBe('First question');
  expect(second?.formPrompt).toBe('Second question');
  const decide = (cardId: string, answer: string) => call('feed.decide', {
    ref, cardId, decision: { kind: 'question', answers: {}, values: { answer } },
  });
  expect(await decide(second!.id, 'Second answer')).toEqual({ applied: true, state: 'answered' });
  expect(await decide(second!.id, 'Duplicate')).toEqual({ applied: false, state: 'answered' });
  expect((await questions()).map((item) => item.id)).toEqual([first!.id]);
  expect(await decide(first!.id, 'First answer')).toEqual({ applied: true, state: 'answered' });
  await expectReply(ref, 'First answer / Second answer');
}, 15_000);


it('recovers from idle child exit before the first send without replaying the unsent message', async () => {
  const projectPath = await setup();
  const traceFile = path.join(home!, 'recovery-trace');
  await writeFile(traceFile, '');
  vi.stubEnv('KIMI_FIXTURE_TRACE', traceFile);
  const prompts = async () => (await readFile(traceFile, 'utf8')).split('\n')
    .filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => 'prompt' in entry);
  const { ref } = await call('sessions.create', input(projectPath));
  const created = await session(ref);
  expect(created?.pid).toBeTypeOf('number');
  process.kill(created!.pid!, 'SIGKILL');
  await expect.poll(() => session(ref)).toMatchObject({ lifecycle: 'sleeping' });
  expect((await request('pty.send', { ref, text: 'проверка', submit: true })).error).toMatchObject({ code: 'not_found' });
  // A sleeping session need not be present in the works cache used by feed.snapshot.
  expect(await prompts()).toEqual([]);
  await call('sessions.resume', { ref });
  expect(await session(ref)).toMatchObject({ lifecycle: 'active', providerSessionId: 'acp-session' });
  await expectReply(ref, 'Old answer');
  expect((await call('feed.snapshot', { ref })).items).toContainEqual(expect.objectContaining({ kind: 'prompt', text: 'Old question' }));
  expect(await prompts()).toEqual([]);
  expect(await call('pty.send', { ref, text: 'проверка', submit: true })).toMatchObject({ submitted: true });
  await expectReply(ref, 'Hello Parley');
  expect(await prompts()).toEqual([{ prompt: 'проверка', model: 'alpha', effort: 'low' }]);
  expect((await call('feed.snapshot', { ref })).items.filter((item) => item.kind === 'prompt' && item.text === 'проверка')).toHaveLength(1);
}, 15_000);


it('delivers a Cyrillic Chat prompt once while preserving the raw terminal draft', async () => {
  const projectPath = await setup();
  const traceFile = path.join(home!, 'draft-trace');
  vi.stubEnv('KIMI_FIXTURE_TRACE', traceFile);
  const { ref } = await call('sessions.create', input(projectPath));
  client!.send({ method: 'pty.input', params: { ref, data: 'unfinished terminal draft' } });
  expect(await call('pty.send', { ref, text: 'привет! тест', submit: true })).toEqual({
    inserted: true, submitted: true, reason: null,
  });
  await expectReply(ref, 'Hello Parley');
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(await trace()).toEqual([{ prompt: 'привет! тест', model: 'alpha', effort: 'low' }]);
  client!.send({ method: 'pty.input', params: { ref, data: '\r' } });
  await expect.poll(trace).toEqual([
    { prompt: 'привет! тест', model: 'alpha', effort: 'low' },
    { prompt: 'unfinished terminal draft', model: 'alpha', effort: 'low' },
  ]);
}, 15_000);

it.each([['manual', 'default'], ['yolo', 'yolo'], ['auto', 'auto']] as const)(
  'passes %s through sessions.create to ACP and keeps it historical after Chat changes', async (kimiPermissionMode, value) => {
    const projectPath = await setup();
    const trace = path.join(projectPath, 'mode-trace');
    vi.stubEnv('KIMI_FIXTURE_TRACE', trace);
    vi.stubEnv('KIMI_FIXTURE_PERMISSION_MODES', '1');
    const { ref } = await call('sessions.create', { ...input(projectPath), task: 'hello', kimiPermissionMode });
    expect(await session(ref)).toMatchObject({ kimiPermissionMode, lifecycle: 'active' });
    await expect.poll(async () => (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { opened: 'session/new' }, { configId: 'mode', value },
      { prompt: expect.stringContaining('hello'), model: 'alpha', effort: 'low', permission: value, plan: false },
    ]);
    await expectReply(ref, 'Hello Parley');
    await call('kimi.setConfig', { ref, configId: 'mode', value: 'plan' });
    expect((await session(ref))?.kimiPermissionMode).toBe(kimiPermissionMode);
  },
);

it('rejects non-Kimi and invalid wire preferences', async () => {
  const projectPath = await setup();
  expect((await request('sessions.create', { ...input(projectPath), provider: 'codex', kimiPermissionMode: 'auto' })).error).toBeDefined();
  expect((await request('sessions.create', { ...input(projectPath), kimiPermissionMode: 'plan' as 'manual' })).error).toBeDefined();
});


it('applies the preference when Parley resumes a record with no provider conversation yet', async () => {
  const projectPath = await setup();
  const trace = path.join(projectPath, 'resume-trace');
  vi.stubEnv('KIMI_FIXTURE_TRACE', trace);
  vi.stubEnv('KIMI_FIXTURE_PERMISSION_MODES', '1');
  const { workId } = await call('works.create', { projectPath, title: 'Kimi', goal: '' });
  const sessionId = await createPendingSession(projectPath, workId, {
    provider: 'kimi', label: '', task: 'hello', kimiPermissionMode: 'auto',
  });
  const ref = { projectPath, workId, sessionId };
  expect((await session(ref))?.providerSessionId).toBeNull();
  await call('sessions.resume', { ref });
  await expectReply(ref, 'Hello Parley');
  expect(await session(ref)).toMatchObject({ providerSessionId: 'acp-session', kimiPermissionMode: 'auto' });
  const entries = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  expect(entries).toEqual([
    { opened: 'session/new' }, { configId: 'mode', value: 'auto' },
    { prompt: expect.stringContaining('hello'), model: 'alpha', effort: 'low', permission: 'auto', plan: false },
  ]);
});

async function terminalReady(ref: SessionRef): Promise<string> {
  await expect.poll(async () => (await call('pty.screenText', { ref })).lines.join('\n')).toContain('Native Kimi Ready');
  const { generation, snapshot } = await call('pty.attach', { ref });
  expect(snapshot).toContain('\x1b[');
  if (generation === undefined) throw new Error('Expected a native PTY generation');
  return generation;
}

function raw(ref: SessionRef, data: string, generation?: string): void {
  client!.send({ method: 'pty.input', params: { ref, data, generation } });
}

it('hands the exact conversation to a raw Terminal, fences writes, and replays only the originally bound history', async () => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  const nativeInput = path.join(home!, 'native-input');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  vi.stubEnv('KIMI_FIXTURE_NATIVE_INPUT', nativeInput);
  vi.stubEnv('PARLEY_FIXTURE_TOKEN', 'not-a-real-token');
  vi.stubEnv('HARNAS_FIXTURE_WORKDIR', 'not-a-real-directory');
  const { ref } = await call('sessions.create', { ...input(projectPath), task: 'fixture brief' });
  await expectReply(ref, 'Hello Parley');
  const before = (await session(ref))?.pid;
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'chat' });
  expect((await request('kimi.setControl', { ref, target: 'terminal', hasDraft: true })).error).toMatchObject({ data: { reason: 'kimi-draft' } });
  raw(ref, 'retained draft');
  expect((await request('kimi.setControl', { ref, target: 'terminal' })).error).toMatchObject({ data: { reason: 'kimi-draft' } });
  raw(ref, '\x15');
  await call('pty.send', { ref, text: 'approve', submit: true });
  const card = await pendingCard(ref, 'permission');
  expect((await request('kimi.setControl', { ref, target: 'terminal' })).error).toMatchObject({ data: { reason: 'kimi-busy' } });
  await call('feed.decide', { ref, cardId: card.cardId, decision: { kind: 'permission', behavior: 'deny', optionId: 'deny' } });
  await expectReply(ref, 'deny');

  expect(await call('kimi.setControl', { ref, target: 'terminal' })).toMatchObject({ owner: 'terminal' });
  expect((await session(ref))?.pid).not.toBe(before);
  expect(typeof before).toBe('number');
  expect(() => process.kill(before!, 0)).toThrow(/ESRCH/);
  expect(await call('pty.send', { ref, text: 'must not be typed', submit: true })).toMatchObject({ submitted: false });
  expect((await request('kimi.setConfig', { ref, configId: 'mode', value: 'plan' })).error).toMatchObject({ code: 'conflict' });
  expect((await request('feed.interrupt', { ref })).error).toMatchObject({ code: 'conflict' });
  expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toMatchObject({ data: { reason: 'kimi-native-running' } });
  expect((await request('sessions.resume', { ref })).error).toMatchObject({ data: { reason: 'kimi-native' } });

  const duplicate = await createPendingSession(ref.projectPath, ref.workId, { provider: 'kimi', label: 'Duplicate binding', task: '' });
  await updateMap(ref.projectPath, ref.workId, (map) => {
    map.sessions.find((item) => item.id === duplicate)!.providerSessionId = 'acp-session';
  });
  const duplicateRef = { ...ref, sessionId: duplicate };
  expect((await request('sessions.resume', { ref: duplicateRef })).error).toMatchObject({ code: 'conflict' });
  expect(await session(duplicateRef)).not.toMatchObject({ lifecycle: 'active' });

  const generation = await terminalReady(ref);
  raw(ref, 'stale input\r', 'ec2eb5da-fce9-47da-ae66-8cc1f7c71908');
  raw(ref, 'unversioned input\r');
  raw(ref, '/help\r', generation);
  raw(ref, '\x1b', generation);
  client!.send({ method: 'pty.resize', params: { ref, cols: 92, rows: 24, generation } });
  await expect.poll(async () => (await call('pty.screenText', { ref })).lines).toEqual(expect.arrayContaining(['Native slash help', 'ESC KEY', 'RESIZE 92x24']));
  raw(ref, 'native original\r/new\rforeign turn\r', generation);
  await expect.poll(() => readFile(history, 'utf8')).toContain('native original');
  await updateMap(ref.projectPath, ref.workId, (_map, letters) => {
    letters.add({ roomId: null, kind: 'note', from: 'human', to: [ref.sessionId], text: 'held mail' });
  });
  expect(unreadLetters(ref.projectPath, ref.workId, ref.sessionId).map((letter) => letter.text)).toContain('held mail');
  await expect.poll(async () => {
    await call('kimi.getControl', { ref });
    return events.some((entry) => entry.event === 'activity.changed' && JSON.stringify(entry.data).includes('"mailWaiting":"paused"'));
  }).toBe(true);
  raw(ref, '/exit\r', generation);
  await expect.poll(() => call('kimi.getControl', { ref })).toMatchObject({ owner: 'exited' });

  expect(await call('kimi.setControl', { ref, target: 'chat' })).toMatchObject({ owner: 'chat' });
  expect(await session(ref)).toMatchObject({ lifecycle: 'active', providerSessionId: 'acp-session' });
  const { items } = await call('feed.snapshot', { ref });
  const prompts = items.filter((item) => item.kind === 'prompt').map((item) => item.text);
  expect(prompts.filter((prompt) => prompt.includes('fixture brief'))).toHaveLength(1);
  expect(prompts.filter((prompt) => prompt === 'native original')).toHaveLength(1);
  expect(await readFile(history, 'utf8')).not.toMatch(/foreign turn|stale input|unversioned input|must not be typed/);
  expect(await readFile(nativeInput, 'utf8')).not.toMatch(/check_inbox|stale input|unversioned input|must not be typed/);
  raw(ref, 'stale native key\r', generation);
  await expect.poll(() => readFile(history, 'utf8'), { timeout: 5000 }).toContain('Call check_inbox.');
  await expect.poll(() => call('pty.send', { ref, text: 'call Parley', submit: true })).toMatchObject({ submitted: true });
  await expectReply(ref, 'Parley session: s-01');
}, 15_000);

it('retains the archived Chat on a failed handback and refreshes deterministically after native clear', async () => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  const failLoad = path.join(home!, 'fail-replay');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  vi.stubEnv('KIMI_FIXTURE_FAIL_LOAD', failLoad);
  const { ref } = await call('sessions.create', { ...input(projectPath), task: 'archived brief' });
  await expectReply(ref, 'Hello Parley');
  await call('kimi.setControl', { ref, target: 'terminal' });
  const generation = await terminalReady(ref);
  raw(ref, '/clear\r/crash\r', generation);
  await expect.poll(() => call('kimi.getControl', { ref })).toMatchObject({ owner: 'stopped' });
  expect(await readFile(history, 'utf8')).toBe('');
  await writeFile(failLoad, '');
  expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toBeDefined();
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'stopped' });
  expect(JSON.stringify((await call('feed.snapshot', { ref })).items)).toContain('archived brief');
  client!.close();
  await running!.context.shutdown('test restart');
  await running!.closed;
  await connectIsolatedHost();
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'stopped' });
  expect((await request('sessions.resume', { ref })).error).toMatchObject({ data: { reason: 'kimi-native' } });
  expect(JSON.stringify((await call('feed.snapshot', { ref })).items)).toContain('archived brief');
  await unlink(failLoad);
  expect(await call('kimi.setControl', { ref, target: 'chat' })).toMatchObject({ owner: 'chat' });
  expect(JSON.stringify((await call('feed.snapshot', { ref })).items)).not.toContain('archived brief');
  const dir = path.join(workPaths(ref.projectPath, ref.workId).dir, 'kimi-history', ref.sessionId);
  const archives = await readdir(dir);
  expect(archives).toHaveLength(1);
  expect(await readFile(path.join(dir, archives[0]!), 'utf8')).toContain('archived brief');
}, 15_000);


it('does not take ownership away from a Chat with pending wake delivery', async () => {
  const projectPath = await setup();
  const { ref } = await call('sessions.create', input(projectPath));
  await call('wake.pause', {});
  await updateMap(ref.projectPath, ref.workId, (_map, letters) => {
    letters.add({ roomId: null, kind: 'note', from: 'human', to: [ref.sessionId], text: 'already queued' });
  });
  expect((await request('kimi.setControl', { ref, target: 'terminal' })).error).toMatchObject({ data: { reason: 'kimi-wake' } });
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'chat' });
  expect(unreadLetters(ref.projectPath, ref.workId, ref.sessionId).map((letter) => letter.text)).toContain('already queued');
}, 15_000);


async function exitNative(ref: SessionRef): Promise<void> {
  const generation = await terminalReady(ref);
  raw(ref, '/exit\r', generation);
  await expect.poll(() => call('kimi.getControl', { ref })).toMatchObject({ owner: 'exited' });
}

it('retains complete archived rows across adjacent replayed prompts and an appended native turn', async () => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'wait', submit: true });
  await call('feed.interrupt', { ref });
  await expect.poll(async () => (await call('feed.snapshot', { ref })).items.some(
    (item) => item.kind === 'turn' && item.interrupted === true,
  )).toBe(true);
  await call('pty.send', { ref, text: 'approve', submit: true });
  const card = await pendingCard(ref, 'permission');
  await call('feed.decide', { ref, cardId: card.cardId, decision: { kind: 'permission', behavior: 'deny', optionId: 'deny' } });
  await expectReply(ref, 'deny');
  const before = (await call('feed.snapshot', { ref })).items;
  expect(before).toContainEqual(expect.objectContaining({ id: card.id, state: 'denied' }));
  await writeFile(history, [['wait', ''], [['ap', 'prove'], 'deny']].map((turn) => JSON.stringify(turn)).join('\n') + '\n');

  await call('kimi.setControl', { ref, target: 'terminal' });
  await exitNative(ref);
  await call('kimi.setControl', { ref, target: 'chat' });
  expect((await call('feed.snapshot', { ref })).items).toEqual(before);

  await call('kimi.setControl', { ref, target: 'terminal' });
  const generation = await terminalReady(ref);
  raw(ref, 'native appended\r/exit\r', generation);
  await expect.poll(() => call('kimi.getControl', { ref })).toMatchObject({ owner: 'exited' });
  // Handback after restart does not depend on the desktop requesting the archive first.
  client!.close();
  await running!.context.shutdown('test restart');
  await running!.closed;
  await connectIsolatedHost();
  await call('kimi.setControl', { ref, target: 'chat' });
  const after = (await call('feed.snapshot', { ref })).items;
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.slice(before.length)).toMatchObject([
    { kind: 'prompt', text: 'native appended' }, { kind: 'text', text: 'Native answer' }, { kind: 'turn' },
  ]);
  expect(await call('pty.send', { ref, text: 'live after replay', submit: true })).toMatchObject({ submitted: true });
  await expectReply(ref, 'Hello Parley');
  const live = (await call('feed.snapshot', { ref })).items;
  expect(live.slice(0, after.length)).toEqual(after);
  expect(new Set(live.map(({ id }) => id)).size).toBe(live.length);
}, 15_000);

it('refuses unidentifiable consecutive new replay prompts without replacing Chat', async () => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'hello', submit: true });
  await expectReply(ref, 'Hello Parley');
  const before = (await call('feed.snapshot', { ref })).items;
  await call('kimi.setControl', { ref, target: 'terminal' });
  await exitNative(ref);
  const turns = [['hello', 'Hello Parley'], ['first new', ''], ['second new', 'native answer']];
  await writeFile(history, turns.map((turn) => JSON.stringify(turn)).join('\n'));
  expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toMatchObject({ code: 'conflict' });
  expect((await call('feed.snapshot', { ref })).items).toEqual(before);

  // Optional ACP message IDs establish boundaries without guessing from chunks.
  await writeFile(history, turns.map((turn, i) => JSON.stringify([...turn, `user-${i}`])).join('\n'));
  await call('kimi.setControl', { ref, target: 'chat' });
  const items = (await call('feed.snapshot', { ref })).items;
  expect(items.slice(0, before.length)).toEqual(before);
  expect(items.filter((item) => item.kind === 'prompt').map((item) => item.text)).toEqual(['hello', 'first new', 'second new']);
}, 15_000);


it('rejects a CLI without ACP load before stopping Chat', async () => {
  const projectPath = await setup();
  vi.stubEnv('KIMI_FIXTURE_NO_LOAD', '1');
  const { ref } = await call('sessions.create', input(projectPath));
  const pid = (await session(ref))?.pid;
  expect((await request('kimi.setControl', { ref, target: 'terminal' })).error).toMatchObject({
    code: 'conflict', data: { reason: 'kimi-replay-unavailable' },
  });
  expect(await session(ref)).toMatchObject({ pid, providerSessionId: 'acp-session' });
  expect((await session(ref))?.kimiTerminal).toBeUndefined();
  expect(await call('pty.send', { ref, text: 'still active', submit: true })).toMatchObject({ submitted: true });
  await expectReply(ref, 'Hello Parley');
}, 15_000);

it('reopens the exact native owner after exit and after stopped handback survives a restart', async () => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  const launchLog = path.join(home!, 'native-launches');
  const failure = path.join(home!, 'fail-replay');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  vi.stubEnv('KIMI_FIXTURE_FAIL_LOAD', failure);
  vi.stubEnv('KIMI_FIXTURE_NATIVE_LAUNCH_LOG', launchLog);
  vi.stubEnv('KIMI_CODE_HOME', path.join(home!, 'provider-home'));
  const { ref } = await call('sessions.create', { ...input(projectPath), task: 'only one brief' });
  await expectReply(ref, 'Hello Parley');
  await call('kimi.setControl', { ref, target: 'terminal' });
  await exitNative(ref);
  const marker = (await session(ref))?.kimiTerminal;
  expect(await call('kimi.setControl', { ref, target: 'terminal' })).toMatchObject({ owner: 'terminal' });
  await exitNative(ref);
  await writeFile(failure, '');
  expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toBeDefined();
  client!.close();
  await running!.context.shutdown('test restart');
  await running!.closed;
  vi.stubEnv('KIMI_CODE_HOME', path.join(home!, 'different-provider-home'));
  await connectIsolatedHost();
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'stopped' });
  expect((await request('sessions.resume', { ref })).error).toMatchObject({ code: 'conflict' });
  expect(await call('kimi.setControl', { ref, target: 'terminal' })).toMatchObject({ owner: 'terminal' });
  expect((await session(ref))?.kimiTerminal).toEqual(marker);
  const generation = await terminalReady(ref);
  raw(ref, 'reopened native turn\r/exit\r', generation);
  await expect.poll(() => call('kimi.getControl', { ref })).toMatchObject({ owner: 'exited' });
  const launches = (await readFile(launchLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const exactCwd = await realpath(marker!.cwd);
  expect(launches).toEqual(Array.from({ length: 3 }, () => ({
    args: ['--session', 'acp-session'], cwd: exactCwd, home: marker?.home,
  })));
  vi.stubEnv('KIMI_CODE_HOME', marker!.home);
  await unlink(failure);
  await call('kimi.setControl', { ref, target: 'chat' });
  const prompts = (await call('feed.snapshot', { ref })).items.filter((item) => item.kind === 'prompt').map((item) => item.text);
  expect(prompts.filter((prompt) => prompt.includes('only one brief'))).toHaveLength(1);
  expect(prompts).toContain('reopened native turn');
}, 20_000);

it('keeps the marker through activation, including a thrown activation and its retry', async () => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  const { ref } = await call('sessions.create', input(projectPath));
  await call('kimi.setControl', { ref, target: 'terminal' });
  await exitNative(ref);
  const marker = (await session(ref))?.kimiTerminal;

  r2Faults.trace = [];
  r2Faults.failActivation = true;
  expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toBeDefined();
  expect(r2Faults.trace).toEqual(['activate']);
  expect((await session(ref))?.kimiTerminal).toEqual(marker);
  expect((await request('sessions.resume', { ref })).error).toMatchObject({ code: 'conflict' });

  r2Faults.trace = [];
  r2Faults.failActivation = false;
  r2Faults.failRelease = true;
  expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toBeDefined();
  expect(r2Faults.trace).toEqual(['activate', 'release']);
  expect((await session(ref))?.kimiTerminal).toEqual(marker);
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'stopped' });

  r2Faults.trace = [];
  r2Faults.failRelease = false;
  expect(await call('kimi.setControl', { ref, target: 'chat' })).toMatchObject({ owner: 'chat' });
  expect(r2Faults.trace).toEqual(['activate', 'release']);
  expect((await session(ref))?.kimiTerminal).toBeUndefined();
}, 15_000);

it('keeps only the owned or latest archive and removes unpublished candidates and deleted-session archives', async () => {
  const projectPath = await setup();
  vi.stubEnv('KIMI_FIXTURE_HISTORY', path.join(home!, 'provider-history'));
  const { ref } = await call('sessions.create', input(projectPath));
  const dir = path.join(workPaths(ref.projectPath, ref.workId).dir, 'kimi-history', ref.sessionId);
  await call('kimi.setControl', { ref, target: 'terminal' });
  const first = (await session(ref))!.kimiTerminal!;
  await exitNative(ref);
  await call('kimi.setControl', { ref, target: 'chat' });
  expect(await readdir(dir)).toEqual([`${first.archive}.json`]);

  r2Faults.failPublish = true;
  expect((await request('kimi.setControl', { ref, target: 'terminal' })).error).toBeDefined();
  expect(await call('kimi.getControl', { ref })).toMatchObject({ owner: 'chat' });
  expect(await readdir(dir)).toEqual([`${first.archive}.json`]);

  r2Faults.failPublish = false;
  await call('kimi.setControl', { ref, target: 'terminal' });
  const latest = (await session(ref))!.kimiTerminal!;
  expect(latest.archive).not.toBe(first.archive);
  expect(await readdir(dir)).toEqual([`${latest.archive}.json`]);
  await exitNative(ref);
  await call('sessions.delete', { ref });
  await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);

it.each([
  [FEED_TEXT_LIMIT, FEED_TEXT_LIMIT, true],
  [FEED_TEXT_LIMIT + 1, FEED_TEXT_LIMIT + 1, true],
  [FEED_TEXT_LIMIT, FEED_TEXT_LIMIT + 1, false],
])('preserves archive rows only for an equivalent displayed reply (%i live, %i replay, retain=%s)', async (liveLength, replayLength, retain) => {
  const projectPath = await setup();
  const history = path.join(home!, 'provider-history');
  vi.stubEnv('KIMI_FIXTURE_HISTORY', history);
  vi.stubEnv('KIMI_FIXTURE_LONG_APPROVAL_REPLY', String(liveLength));
  const { ref } = await call('sessions.create', input(projectPath));
  await call('pty.send', { ref, text: 'approve', submit: true });
  const card = await pendingCard(ref, 'permission');
  await call('feed.decide', { ref, cardId: card.id, decision: { kind: 'permission', behavior: 'deny', optionId: 'deny' } });
  await expect.poll(async () => (await call('feed.snapshot', { ref })).items.some((item) => item.kind === 'turn')).toBe(true);
  await call('pty.send', { ref, text: 'hello', submit: true });
  await expectReply(ref, 'Hello Parley');
  const before = (await call('feed.snapshot', { ref })).items;
  const prior = before.find((item) => item.kind === 'text' && item.text.length === FEED_TEXT_LIMIT);
  expect(prior).toBeDefined();
  expect(prior?.kind === 'text' && prior.truncated === true).toBe(liveLength > FEED_TEXT_LIMIT);
  expect(before).toContainEqual(expect.objectContaining({ id: card.id, state: 'denied' }));
  await writeFile(history, [['approve', 'x'.repeat(replayLength)], ['hello', 'Hello Parley']].map((turn) => JSON.stringify(turn)).join('\n'));

  await call('kimi.setControl', { ref, target: 'terminal' });
  await exitNative(ref);
  await call('kimi.setControl', { ref, target: 'chat' });

  const after = (await call('feed.snapshot', { ref })).items;
  if (retain) {
    const digestText = (items: typeof after) => items.map((item) => item.kind === 'text'
      ? { ...item, text: createHash('sha256').update(item.text).digest('hex') } : item);
    expect(digestText(after)).toEqual(digestText(before));
  } else {
    const replayed = after.find((item) => item.kind === 'text' && item.text.length === FEED_TEXT_LIMIT);
    expect(replayed).toMatchObject({ truncated: true });
    expect(replayed?.id).not.toBe(prior?.id);
  }
}, 15_000);
