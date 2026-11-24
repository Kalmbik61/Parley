import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readMap } from '@parley/core';
import { feedItem, type MethodName, type Params, type Result, type SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected, type RawMessage, type TestClient } from '../../test/helpers.js';
import { startHost, type RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

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
  running = await startHost({ home });
  const paths = hostPaths(home);
  client = connectRaw(paths.socket);
  await waitConnected(client.socket);
  expect((await hello(client, await readFile(paths.token, 'utf8'))).error).toBeUndefined();
  return project;
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
