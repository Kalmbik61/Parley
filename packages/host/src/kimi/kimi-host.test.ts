import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readMap } from '@parley/core';
import type { MethodName, Params, Result, SessionRef } from '@parley/protocol';
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

async function setup(loggedOut = false): Promise<string> {
  home = await tempHome();
  const binary = path.join(home, 'kimi');
  const project = path.join(home, 'project');
  await mkdir(project);
  await writeFile(binary, await readFile(new URL('./fixtures/acp.cjs', import.meta.url)), { mode: 0o755 });
  vi.stubEnv('PARLEY_KIMI_BIN', binary);
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
  expect((await call('kimi.getState', { ref })).config).toMatchObject([{ id: 'mode', currentValue: 'default' }]);
  expect(await call('kimi.setConfig', { ref, configId: 'mode', value: 'plan' })).toMatchObject({ config: [{ id: 'mode', currentValue: 'plan' }] });
  expect(events.some((message) => message.event === 'kimi.configChanged')).toBe(true);
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
  expect(await call('pty.send', { ref, text: 'hello', submit: true })).toMatchObject({ submitted: true });
  await expect.poll(() => call('feed.snapshot', { ref })).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ kind: 'text', text: 'Hello Parley', streaming: false })]),
  });
}, 15_000);

it('distinguishes sign-in required and a missing CLI on ordinary create', async () => {
  const projectPath = await setup(true);
  expect((await request('sessions.create', input(projectPath))).error).toMatchObject({ data: { reason: 'kimi-sign-in' } });
  expect((await call('providers.list', {})).providers.find(({ id }) => id === 'kimi')).toMatchObject({ available: false, needs: 'sign-in' });
  vi.stubEnv('PARLEY_KIMI_BIN', '/no/such/kimi');
  expect((await request('sessions.create', input(projectPath))).error).toMatchObject({ data: { reason: 'kimi-missing-cli' } });
}, 15_000);
