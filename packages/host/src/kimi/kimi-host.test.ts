import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KIMI_LAUNCH_MODES_FEATURE, KIMI_PTY_GENERATION_FEATURE, KIMI_SHARED_TERMINAL_FEATURE, type MethodName, type Params, type Result } from '@parley/protocol';
import { readMap } from '@parley/core';
import { afterEach, expect, it, vi } from 'vitest';
import { connectRaw, hello, removeHome, tempHome, waitConnected, type TestClient } from '../../test/helpers.js';
import { startHost, type RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

let requestId = 100;
let home: string | undefined;
let running: RunningHost | undefined;
let client: TestClient | undefined;

async function request<M extends MethodName>(method: M, params: Params<M>) {
  const id = ++requestId;
  client!.send({ id, method, params });
  for (;;) {
    const response = await client!.next();
    if (response.id === id) return response;
  }
}

async function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  const response = await request(method, params);
  expect(response.error).toBeUndefined();
  return response.result as Result<M>;
}

async function setup(withoutBracketedPaste = false) {
  home = await tempHome();
  const binary = path.join(home, 'kimi');
  const projectPath = path.join(home, 'project');
  const data = path.join(home, 'kimi-data');
  const trace = path.join(home, 'native.jsonl');
  const keys = path.join(home, 'input.txt');
  await mkdir(projectPath);
  await mkdir(data);
  await writeFile(binary, `#!/usr/bin/env node
if (process.argv[2] === 'acp') process.exit(21);
process.getBuiltinModule('node:fs').appendFileSync(process.env.KIMI_FIXTURE_NATIVE_LAUNCH_LOG,
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.KIMI_CODE_HOME }) + '\\n');
${withoutBracketedPaste ? `if (process.stdout.isTTY) {
  process.stdout.write(${JSON.stringify('│ Version: 2.7.2 │\r\nNo session yet — one will be created on your first message.\r\n╭──────────╮\r\n│ >        │\r\n╰──────────╯\r\n')});
  process.stdin.setRawMode(true);
  process.stdin.on('data', (data) => process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(keys)}, data));
}` : ''}
process.stdin.resume();
`, { mode: 0o755 });
  vi.stubEnv('PARLEY_KIMI_BIN', binary);
  vi.stubEnv('KIMI_CODE_HOME', data);
  vi.stubEnv('KIMI_FIXTURE_NATIVE_LAUNCH_LOG', trace);
  running = await startHost({ home });
  const paths = hostPaths(home);
  client = connectRaw(paths.socket);
  await waitConnected(client.socket);
  const greeting = await hello(client, await readFile(paths.token, 'utf8'));
  expect(greeting.error).toBeUndefined();
  expect(greeting.result).toMatchObject({ features: expect.arrayContaining([
    KIMI_LAUNCH_MODES_FEATURE, KIMI_PTY_GENERATION_FEATURE, KIMI_SHARED_TERMINAL_FEATURE,
  ]) });
  return { projectPath, data, trace, keys };
}

afterEach(async () => {
  client?.close();
  await running?.context.shutdown('test');
  await running?.closed;
  if (home !== undefined) await removeHome(home);
  client = undefined;
  running = undefined;
  home = undefined;
  vi.unstubAllEnvs();
});

const input = (projectPath: string) => ({ projectPath, workId: null, provider: 'kimi', label: '', task: '', parent: null });

it('starts native and keeps one PTY across compatibility view calls', async () => {
  const { projectPath, data, trace } = await setup();
  const { ref } = await call('sessions.create', { ...input(projectPath), kimiPermissionMode: 'auto' });
  const launch = () => readFile(trace, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)));
  await expect.poll(launch, { timeout: 5000 }).toMatchObject([{ args: ['--auto'], cwd: await realpath(projectPath), home: await realpath(data) }]);
  const generation = (await call('pty.attach', { ref })).generation;
  expect(generation).toBeDefined();
  const session = async () => (await readMap(ref.projectPath, ref.workId)).sessions.find(item => item.id === ref.sessionId);
  const pid = (await session())?.pid;
  expect(pid).toBeTypeOf('number');
  await call('kimi.setControl', { ref, target: 'terminal' });
  await call('kimi.setControl', { ref, target: 'chat' });
  expect((await call('pty.attach', { ref })).generation).toBe(generation);
  expect((await session())?.pid).toBe(pid);
  expect(await launch()).toHaveLength(1);
  expect((await request('kimi.setConfig', { ref, configId: 'mode', value: 'plan' })).error).toBeDefined();
  const json = await readFile(path.join(data, 'mcp.json'), 'utf8');
  expect(JSON.parse(json)).toMatchObject({ mcpServers: { parley: { args: expect.arrayContaining(['--kimi-native']) } } });
  expect(json).not.toMatch(/TOKEN|CAPABILITY|WORK_DIR|SESSION_ID/);
}, 15_000);

it('rejects non-Kimi and invalid wire preferences', async () => {
  const { projectPath } = await setup();
  expect((await request('sessions.create', { ...input(projectPath), provider: 'codex', kimiPermissionMode: 'auto' })).error).toBeDefined();
  expect((await request('sessions.create', { ...input(projectPath), kimiPermissionMode: 'plan' as 'manual' })).error).toBeDefined();
});

it('keeps input blocked with an actionable error when the startup editor lacks bracketed paste', async () => {
  const { projectPath, data, trace, keys } = await setup(true);
  const { ref } = await call('sessions.create', { ...input(projectPath), kimiPermissionMode: 'manual' });
  const { generation } = await call('pty.attach', { ref });
  expect(generation).toBeDefined();
  const screen = async () => (await call('pty.screenText', { ref })).lines.join('\n');
  await expect.poll(screen, { timeout: 5_000 }).toContain('Version: 2.7.2');
  expect(await screen()).toContain('No session yet');
  expect(await screen()).toMatch(/│ >\s+│/);
  expect(JSON.parse((await readFile(trace, 'utf8')).trim())).toEqual({
    args: [], cwd: await realpath(projectPath), home: await realpath(data),
  });
  const send = () => call('pty.send', { ref, text: 'irrelevant', submit: true });
  expect(await send()).toMatchObject({ inserted: false, submitted: false });
  // The normal startup proof window is 15 seconds. Do not treat a version
  // label as an immediate rejection or change the real host deadline.
  await expect.poll(async () => (await call('feed.snapshot', { ref })).items, { timeout: 20_000 }).toContainEqual(expect.objectContaining({
    kind: 'error', error: 'kimi-native-startup', message: expect.stringMatching(/2\.7\.2.*bracketed paste.*stop and resume/i),
  }));
  expect(await send()).toMatchObject({ inserted: false, submitted: false });
  client!.send({ method: 'pty.input', params: { ref, data: 'irrelevant\r', generation } });
  expect(await screen()).toContain('Version: 2.7.2');
  await expect(readFile(keys, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const session = (await readMap(ref.projectPath, ref.workId)).sessions.find(item => item.id === ref.sessionId);
  expect(session).toMatchObject({ providerSessionId: null, kimiPermissionMode: 'manual', kimiNativeBootstrap: { phase: 'reserved' } });
}, 27_000);

it('reports a foreign same-name MCP entry before launching and preserves its bytes', async () => {
  const { projectPath, data, trace } = await setup();
  const raw = '{ "mcpServers": { "parley": { "command": "foreign" }, "mine": { "command": "keep" } } }';
  const config = path.join(data, 'mcp.json');
  await writeFile(config, raw);
  const response = await request('sessions.create', input(projectPath));
  expect(response.error).toMatchObject({ code: 'conflict' });
  expect(await readFile(config, 'utf8')).toBe(raw);
  await expect(readFile(trace, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
