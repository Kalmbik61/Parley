import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostContext } from '../context.js';
import { createKimiSessions } from './sessions.js';

const fixture = fileURLToPath(new URL('./fixtures/acp.cjs', import.meta.url));
const cwd = fileURLToPath(new URL('./fixtures', import.meta.url));
const ref = { projectPath: cwd, workId: 'w-0001', sessionId: 's-01' };
let home: string;
let service: ReturnType<typeof createKimiSessions>;
const output = vi.fn();

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kimi-startup-'));
  output.mockClear();
  service = sessionsWithHistory(true);
});

function sessionsWithHistory(hasHistory: boolean) {
  return createKimiSessions({ version: 'test', broadcast: vi.fn(), log: { warn: vi.fn() } } as unknown as HostContext, {
    output, hasHistory: () => hasHistory, activity: vi.fn(),
  });
}
afterEach(async () => {
  await service.stopAll();
  await rm(home, { recursive: true, force: true });
});

function launch(choices = {}, env = {}) {
  return service.start(ref, {
    command: process.execPath, args: [fixture], cwd,
    env: { KIMI_FIXTURE_CREATION_CONFIG: '1', KIMI_FIXTURE_TRACE: path.join(home, 'trace'), ...env },
    mcpServers: [{ type: 'stdio', name: 'parley', command: process.execPath, args: [], env: [{ name: 'PARLEY_SESSION_ID', value: 's-01' }] }],
    prompt: 'hello', ...choices,
  });
}
const trace = async () => (await readFile(path.join(home, 'trace'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

it('applies model then thinking using the updated config before any first prompt', async () => {
  const started = await launch({ model: 'beta', effort: 'max' });
  expect(await trace()).toEqual([{ configId: 'model', value: 'beta' }, { configId: 'thinking', value: 'max' }]);
  started.activate();
  await expect.poll(trace).toEqual([
    { configId: 'model', value: 'beta' }, { configId: 'thinking', value: 'max' },
    { prompt: 'hello', model: 'beta', effort: 'max' },
  ]);
});

it('rejects stale models and post-switch unsupported effort without a prompt', async () => {
  await expect(launch({ model: 'removed' })).rejects.toMatchObject({ code: 'bad_request', data: { reason: 'kimi-invalid' } });
  await expect(launch({ model: 'alpha', effort: 'max' })).rejects.toMatchObject({ code: 'bad_request', data: { reason: 'kimi-invalid' } });
  expect(await trace()).toEqual([{ configId: 'model', value: 'alpha' }]);
  expect(output).not.toHaveBeenCalled();
});

it('does not translate a named effort into an advertised boolean toggle', async () => {
  await expect(launch({ effort: 'high' }, { KIMI_FIXTURE_BOOLEAN_CONFIG: '1' })).rejects.toMatchObject({ code: 'bad_request' });
  expect(output).not.toHaveBeenCalled();
});

it('fails visibly when the CLI returns a different confirmed value', async () => {
  await expect(launch({ model: 'beta' }, { KIMI_FIXTURE_IGNORE_CONFIG: '1' })).rejects.toMatchObject({ code: 'bad_request' });
  expect(await trace()).toEqual([{ configId: 'model', value: 'beta' }]);
});

it('leaves omitted choices at CLI defaults', async () => {
  const started = await launch();
  started.activate();
  await expect.poll(trace).toEqual([{ prompt: 'hello', model: 'alpha', effort: 'low' }]);
});


it('rejects activation after exit instead of returning a silently inactive session', async () => {
  const started = await launch();
  const exited = new Promise<void>((resolve) => started.process.onExit(() => resolve()));
  started.process.kill('SIGKILL');
  await exited;
  expect(() => started.activate()).toThrow('Kimi Code session is not running');
  expect(output).not.toHaveBeenCalled();
});

it('sends Chat independently of a real terminal draft and preserves that draft', async () => {
  const started = await launch({ prompt: undefined });
  started.activate();
  started.process.write('unfinished');
  expect(service.send(ref, 'привет! тест', true)).toMatchObject({ inserted: true, submitted: true });
  await expect.poll(() => output.mock.calls.some(([, event]) => event.kind === 'end')).toBe(true);
  expect(await trace()).toEqual([{ prompt: 'привет! тест', model: 'alpha', effort: 'low' }]);
  started.process.write('\r');
  await expect.poll(trace).toEqual([
    { prompt: 'привет! тест', model: 'alpha', effort: 'low' },
    { prompt: 'unfinished', model: 'alpha', effort: 'low' },
  ]);
});

it('clears a cancelled terminal draft on Ctrl+C', async () => {
  const started = await launch({ prompt: undefined });
  started.activate();
  started.process.write('unfinished');
  started.process.write('\x03');
  started.process.write('fresh');
  started.process.write('\r');
  await expect.poll(trace).toEqual([{ prompt: 'fresh', model: 'alpha', effort: 'low' }]);
});

it('refuses busy sends without recording or replaying a second prompt', async () => {
  const started = await launch({ prompt: undefined });
  started.activate();
  expect(service.send(ref, 'wait', true)).toMatchObject({ submitted: true });
  expect(service.send(ref, 'later', true)).toEqual({ inserted: false, submitted: false, reason: 'busy' });
  expect(service.send(ref, 'later', false)).toEqual({ inserted: false, submitted: false, reason: 'busy' });
  started.process.write('\x1b');
  await expect.poll(() => output.mock.calls.some(([, event]) => event.kind === 'end')).toBe(true);
  expect(await trace()).toEqual([{ prompt: 'wait', model: 'alpha', effort: 'low' }]);
});


const permissionModes = { KIMI_FIXTURE_PERMISSION_MODES: '1', KIMI_FIXTURE_INHERITED_PLAN: '1', KIMI_FIXTURE_INHERITED_PERMISSION: 'yolo' };

it.each([['manual', 'default'], ['yolo', 'yolo'], ['auto', 'auto']])('sets %s to ACP %s before activation, leaving inherited Plan', async (kimiPermissionMode, value) => {
  const started = await launch({ kimiPermissionMode }, permissionModes);
  const beforePrompt = [{ opened: 'session/new' }, { configId: 'mode', value }];
  expect(await trace()).toEqual(beforePrompt);
  started.activate();
  await expect.poll(trace).toEqual([...beforePrompt, { prompt: 'hello', model: 'alpha', effort: 'low', permission: value, plan: false }]);
});

it('leaves inherited permission and Plan untouched when no preference was selected', async () => {
  const started = await launch({}, permissionModes);
  started.activate();
  await expect.poll(trace).toEqual([
    { opened: 'session/new' }, { prompt: 'hello', model: 'alpha', effort: 'low', permission: 'yolo', plan: true },
  ]);
});

it.each(['session/resume', 'session/load'])('sends no creation preference on provider %s', async (opened) => {
  const started = await launch({ sessionId: 'acp-session', kimiPermissionMode: 'auto' }, {
    ...permissionModes, ...(opened === 'session/load' ? { KIMI_FIXTURE_LOAD_ONLY: '1' } : {}),
  });
  started.activate();
  await expect.poll(trace).toEqual([
    { opened }, { prompt: 'hello', model: 'alpha', effort: 'low', permission: 'yolo', plan: true },
  ]);
});

it('does not activate or accept a first prompt until the mode RPC acknowledges the choice', async () => {
  const gate = path.join(home, 'ack');
  const beforePrompt = [{ opened: 'session/new' }, { configId: 'mode', value: 'auto' }];
  let returned = false;
  const started = launch({ kimiPermissionMode: 'auto' }, { ...permissionModes, KIMI_FIXTURE_MODE_GATE: gate })
    .then((result) => { returned = true; return result; });
  try {
    await expect.poll(trace).toEqual(beforePrompt);
    expect(returned).toBe(false);
    expect(() => service.send(ref, 'too soon', true)).toThrow('not running');
    expect(output).not.toHaveBeenCalled();
  } finally {
    await writeFile(gate, '');
    (await started).activate();
  }
  await expect.poll(trace).toEqual([...beforePrompt, { prompt: 'hello', model: 'alpha', effort: 'low', permission: 'auto', plan: false }]);
});

it.each([
  ['KIMI_FIXTURE_WRONG_ACK', true],
  ['KIMI_FIXTURE_MISSING_ACK', true],
  ['KIMI_FIXTURE_LEGACY_MODE', false],
  ['KIMI_FIXTURE_REJECT_CONFIG', false],
])('fails without a prompt for %s', async (failure, wroteMode) => {
  await expect(launch({ kimiPermissionMode: 'auto' }, { ...permissionModes, [failure]: '1' })).rejects.toMatchObject({ code: 'bad_request' });
  expect(await trace()).toEqual([{ opened: 'session/new' }, ...(wroteMode ? [{ configId: 'mode', value: 'auto' }] : [])]);
  expect(output).not.toHaveBeenCalled();
});


it.each([
  ['a long prompt', [['p'.repeat(65537), 'old']]],
  ['many replay updates', Array.from({ length: 1400 }, (_, n) => [`old ${n}`, 'reply'])],
  ['a large replay', Array.from({ length: 34 }, () => ['p'.repeat(65536), 'reply'])],
])('still delivers a live reply after a cold resume with %s', async (_title, turns) => {
  service = sessionsWithHistory(false);
  const history = path.join(home, 'history');
  await writeFile(history, turns.map((turn) => JSON.stringify(turn)).join('\n'));
  const started = await launch({ sessionId: 'acp-session', prompt: undefined }, { KIMI_FIXTURE_HISTORY: history });
  started.activate();
  if (output.mock.calls.length > 0) expect(output.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'end' });
  output.mockClear();
  expect(service.send(ref, 'live question', true)).toMatchObject({ submitted: true });
  await expect.poll(() => output.mock.calls.filter(([, event]) => event.kind === 'text').map(([, event]) => event.text).join('')).toBe('Hello Parley');
});
