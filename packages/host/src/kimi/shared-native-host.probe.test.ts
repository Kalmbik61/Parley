import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { kimiArchiveDirectory, readMap, updateMap } from '@parley/core';
import * as pty from 'node-pty';
import type { MethodName, Params, Result } from '@parley/protocol';
import { expect, test, vi } from 'vitest';
import { connectRaw, hello, waitConnected, type RawMessage, type TestClient } from '../../test/helpers.js';
import { startHost, type RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
import { createScreen } from '../pty/screen.js';
import { workspaceKey } from './date-provenance.js';

const bin = '/Users/kalmbik61/.kimi-code/bin/kimi';
const optIn = process.env['PARLEY_KIMI_SHARED_HOST_BIN'];
const fixtureManualDefault = process.env['PARLEY_KIMI_SHARED_HOST_MANUAL_DEFAULT'] === '1';
const model = 'parley-offline-fixture';
const original = 'INTEGRATED_ORIGINAL_PROMPT';
const native = 'INTEGRATED_NATIVE_PROMPT';
const approval = 'NATIVE_HOST_PERMISSION_PROBE';
const reject = 'NATIVE_HOST_REJECT_PROBE';
const feedback = 'NATIVE_HOST_FEEDBACK_PROBE';
const always = 'NATIVE_HOST_SESSION_APPROVAL';
const ask = 'NATIVE_HOST_QUESTION_PROBE';
const afterNew = 'NATIVE_HOST_AFTER_NEW';
const freshCold = 'NATIVE_HOST_FRESH_COLD';
const freshAfterNew = 'NATIVE_HOST_FRESH_AFTER_NEW';
const unbound = 'NATIVE_HOST_UNBOUND';
const mail = 'NATIVE_HOST_QUEUED_MAIL';
const pointer = 'Call check_inbox.';
const mapTurns = new Set([approval, reject, feedback, always]);
const ready = /^\s*│ >\s*│\s*$/m;
const sandbox = '/usr/bin/sandbox-exec';

test.skipIf(!optIn)('shares real production host Chat and Terminal on one stock Kimi PTY', async () => {
  expect(optIn).toBe(bin);
  expect(process.platform).toBe('darwin');
  const root = await realpath(await mkdtemp('/tmp/pki-'));
  const [home, kimi, parley, tmp, projectPath] = ['home', 'kimi', 'parley', 'tmp', 'project'].map(part => join(root, part)) as [string, string, string, string, string];
  const seen: { turn: string; tools: string[]; result?: string; hasMail: boolean }[] = [];
  const rejected: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      expect([req.method, req.url, req.headers.authorization]).toEqual(['POST', '/v1/chat/completions', 'Bearer probe-not-a-secret']);
      let input = '';
      for await (const chunk of req) {
        input += chunk;
        expect(input.length).toBeLessThan(512_000);
      }
      const body = JSON.parse(input);
      expect([body.model, body.stream]).toEqual([model, true]);
      const history = JSON.stringify(body.messages);
      const turn = [original, native, ...mapTurns, ask, afterNew, freshCold, freshAfterNew, unbound, pointer].map(marker => ({ marker, at: history.lastIndexOf(marker) }))
        .filter(item => item.at >= 0).sort((x, y) => y.at - x.at)[0]?.marker;
      if (turn === undefined) throw new Error('Unexpected synthetic model request');
      const tools: string[] = (body.tools ?? []).map((entry: { function: { name: string } }) => entry.function.name);
      const callId = `fixture_${turn}`;
      const result = body.messages.find((message: { role: string; tool_call_id?: string }) =>
        message.role === 'tool' && message.tool_call_id === callId)?.content;
      seen.push({ turn, tools, hasMail: history.includes(mail), ...(result === undefined ? {} : { result: JSON.stringify(result) }) });
      const invoke = (mapTurns.has(turn) || turn === ask || (turn === freshAfterNew && tools.includes('mcp__parley__get_map'))) && result === undefined;
      const tool = turn === ask ? 'AskUserQuestion' : 'mcp__parley__get_map';
      if (invoke) expect(tools).toContain(tool);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const args = turn === ask ? { questions: [{ question: 'Which fixture marker?', header: 'Marker', multi_select: false, options: [{ label: 'ALPHA' }, { label: 'BETA' }] }] } : {};
      const delta = invoke ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
        : { content: `${turn === pointer ? 'NATIVE_MAIL' : turn}_REPLY` };
      res.write(chunk({ role: 'assistant', ...delta }, null));
      res.end(chunk({}, invoke ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      rejected.push(String(error));
      res.writeHead(400).end();
    }
  });
  let host: RunningHost | undefined;
  let client: TestClient | undefined;
  let stage = 'loopback listen';
  let inspectScreen: (() => Promise<string>) | undefined;
  let id = 100;
  const events: RawMessage[] = [];
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
    if (response.error !== undefined) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result as Result<M>;
  }
  try {
    await Promise.all([home, kimi, parley, tmp, projectPath].map(dir => mkdir(dir)));
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No loopback port');

    stage = 'sandboxed version check';
    const profile = join(root, 'sandbox.sb');
    const executable = await realpath(bin);
    const node = await realpath(process.execPath);
    const workspace = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
    const core = join(workspace, 'packages/core');
    // Kimi and its children get only the synthetic model port and the launch's own host callback port.
    await writeFile(profile, `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${address.port}"))
(deny file-read-data (subpath "/Users/kalmbik61"))
(deny file-write* (subpath "/Users/kalmbik61"))
(allow file-read-data (literal ${JSON.stringify(executable)}) (literal ${JSON.stringify(node)}) (literal ${JSON.stringify(join(core, 'package.json'))}) (subpath ${JSON.stringify(join(core, 'dist'))}) (subpath ${JSON.stringify(join(workspace, 'packages/host/dist/kimi'))}) (literal ${JSON.stringify(join(workspace, 'packages/host/package.json'))}) (subpath ${JSON.stringify(join(workspace, 'node_modules/.pnpm'))}))
`);
    const launch = join(root, 'kimi-locked');
    const hookPort = String.raw`$(printf "%s" "$PARLEY_HOOK_URL" | /usr/bin/sed -nE 's@^http://127\.0\.0\.1:([0-9]+)/hooks$@\1@p')`;
    await writeFile(launch, [
      '#!/bin/sh',
      `port=${hookPort}`,
      `profile=$(/bin/cat '${profile}')`,
      "if [ -n \"$port\" ]; then profile=\"$profile",
      '(allow network-outbound (remote ip \\"localhost:$port\\"))\"; fi',
      `exec ${sandbox} -p "$profile" '${executable}' "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });
    // Do not supply inherited model/auth/config/proxy selectors to either process.
    for (const name of Object.keys(process.env)) {
      if (/^(KIMI_|MOONSHOT_|XDG_|OPENAI_|ANTHROPIC_|AZURE_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)) vi.stubEnv(name, undefined);
    }
    const env = {
      HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimi, PARLEY_KIMI_BIN: launch,
      TMPDIR: tmp, PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
      KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'probe-not-a-secret',
      KIMI_MODEL_CAPABILITIES: 'tool_use',
      KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    for (const [key, value] of Object.entries({ ...env, PARLEY_AGENT_SKILLS: 'off' })) vi.stubEnv(key, value);
    expect(execFileSync(launch, ['--version'], { cwd: projectPath, env, encoding: 'utf8', timeout: 8000 }).trim()).toBe('2.7.3');

    stage = 'managed native launch';
    const preference = `default_permission_mode = "${fixtureManualDefault ? 'manual' : 'auto'}"`;
    await writeFile(join(kimi, 'config.toml'), `# keep original preference\n${preference}\n`);
    host = await startHost({ home: parley });
    const paths = hostPaths(parley);
    client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    const greeting = await hello(client, await readFile(paths.token, 'utf8'));
    expect(greeting.error).toBeUndefined();
    expect((greeting.result as { features: string[] }).features).toContain('kimi-shared-terminal');
    const { ref } = await call('sessions.create', {
      projectPath, workId: null, provider: 'kimi', label: 'Offline native integration', task: '', parent: null,
      ...(fixtureManualDefault ? {} : { kimiPermissionMode: 'manual' as const }),
    });
    const session = async () => (await readMap(ref.projectPath, ref.workId)).sessions.find(item => item.id === ref.sessionId)!;
    const firstStart = await session();
    expect(firstStart.pid).toBeTypeOf('number');
    const poll = { timeout: 9000, interval: 50 };
    const screen = async () => (await call('pty.screenText', { ref })).lines.join('\n');
    inspectScreen = screen;
    const snap = () => call('feed.snapshot', { ref });
    let generation = (await call('pty.attach', { ref })).generation!;
    expect(generation).toBeDefined();
    const raw = (data: string, gen = generation) => client!.send({ method: 'pty.input', params: { ref, data, generation: gen } });
    const submit = async (text: string) => {
      raw(`\x1b[200~${text}\x1b[201~`);
      await expect.poll(screen, poll).toContain(text);
      await delay(160);
      raw('\r');
    };

    await expect.poll(screen, poll).toMatch(/Trust this folder\?|No session yet/);
    if ((await screen()).includes('Trust this folder?')) {
      expect((await screen())).toContain(projectPath);
      expect((await screen())).toContain('No project integrations or instructions to activate.');
      expect(await call('pty.send', { ref, text: original, submit: true })).toMatchObject({ submitted: false });
      raw('\r');
    }
    stage = 'first Chat prompt after explicit Manual on a saved automatic default';
    await expect.poll(screen, poll).toMatch(ready);
    // Check the guarded sender's first action, retrying only if not a single byte was inserted.
    await expect.poll(async () => {
      const result = await call('pty.send', { ref, text: original, submit: true });
      if (result.inserted && !result.submitted) throw new Error('Chat text became an unsubmitted draft');
      return result.submitted;
    }, poll).toBe(true);
    await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'text', text: `${original}_REPLY`, streaming: false }));
    const a = (await session()).providerSessionId!;
    expect(a).toMatch(/^session_/);
    const coldAdvertised = seen[0]?.tools.includes('mcp__parley__get_map');
    expect((await readFile(join(kimi, 'config.toml'), 'utf8')).split('\n')[1]).toBe(preference);

    stage = 'raw Terminal same PID and provider ID';
    await call('kimi.setControl', { ref, target: 'terminal' });
    expect((await session()).pid).toBe(firstStart.pid);
    expect((await call('pty.attach', { ref })).generation).toBe(generation);
    await submit('/help');
    await expect.poll(screen, poll).toMatch(/Keyboard shortcuts|Slash commands/i);
    raw('\x1b');
    await expect.poll(screen, poll).toMatch(ready);
    client.send({ method: 'pty.resize', params: { ref, cols: 116, rows: 35, generation } });
    expect(await call('pty.attach', { ref })).toMatchObject({ cols: 116, rows: 35, generation });
    await submit(native);
    await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'text', text: `${native}_REPLY` }));
    expect((await session()).providerSessionId).toBe(a);

    stage = 'human draft and queued mail through the same guarded sender';
    await expect.poll(screen, poll).toMatch(ready);
    raw('HUMAN_DRAFT');
    await expect.poll(screen, poll).toContain('HUMAN_DRAFT');
    expect(await call('pty.send', { ref, text: 'CHAT_SHOULD_NOT_EDIT_DRAFT', submit: true })).toMatchObject({ inserted: false });
    await updateMap(ref.projectPath, ref.workId, (_map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 'human', to: [ref.sessionId], text: mail });
    });
    expect(seen.some(row => row.turn === pointer)).toBe(false);
    raw('\x15');
    await expect.poll(screen, poll).toMatch(ready);
    await expect.poll(async () => (await snap()).items, { timeout: 20000, interval: 100 }).toContainEqual(expect.objectContaining({ kind: 'text', text: 'NATIVE_MAIL_REPLY' }));
    expect(seen.filter(row => row.turn === pointer)).toMatchObject([{ hasMail: true }]);
    expect((await session()).pid).toBe(firstStart.pid);

    stage = 'exact native resume and stale raw generation fence';
    await expect.poll(screen, poll).toMatch(ready);
    const legacyItems = (await snap()).items;
    await submit('/exit');
    await expect.poll(async () => (await session()).lifecycle, poll).toBe('sleeping');
    const legacyId = randomUUID();
    const legacyDir = await kimiArchiveDirectory(projectPath, ref.workId, ref.sessionId, true);
    expect(legacyDir).toBeDefined();
    await writeFile(join(legacyDir!, `${legacyId}.json`), JSON.stringify(legacyItems));
    await updateMap(projectPath, ref.workId, (map) => {
      const item = map.sessions.find(item => item.id === ref.sessionId)!;
      delete item.kimiNativeBinding;
      item.kimiTerminal = { archive: legacyId, home: kimi, cwd: projectPath };
    });
    await call('sessions.resume', { ref });
    await expect.poll(screen, poll).toMatch(ready);
    expect((await session()).providerSessionId).toBe(a);
    const resumed = await session();
    expect(resumed.pid).not.toBe(firstStart.pid);
    expect(resumed.kimiTerminal).toBeUndefined();
    expect(resumed.kimiNativeBinding).toMatchObject({ legacyArchive: legacyId, legacyProviderId: a, home: kimi, cwd: projectPath });
    const old = generation;
    generation = (await call('pty.attach', { ref })).generation!;
    expect(generation).not.toBe(old);
    raw('STALE_RAW', old);
    await delay(150);
    expect(await screen()).not.toContain('STALE_RAW');

    stage = 'revalidated native approval and real Parley get_map';
    await submit(approval);
    await expect.poll(screen, poll).toContain('Approve mcp__parley__get_map?');
    const findCard = async () => (await snap()).items.find(item => item.kind === 'permission' && item.state === 'pending');
    await expect.poll(findCard, poll).toMatchObject({ kind: 'permission' });
    const card = await findCard();
    if (card?.kind !== 'permission') throw new Error('Expected native permission card');
    const options = card.permissionOptions!;
    expect(options.map(option => option.name)).toEqual(['Approve once', 'Approve for this session', 'Reject', 'Reject with feedback']);
    const decide = () => call('feed.decide', { ref, cardId: card.cardId, decision: { kind: 'permission', behavior: 'allow', optionId: options[0]!.optionId } });
    expect(await decide()).toMatchObject({ applied: true });
    expect(await decide()).toMatchObject({ applied: false });
    await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'text', text: `${approval}_REPLY` }));
    expect(seen.findLast(entry => entry.turn === approval)?.result).toContain(ref.sessionId);
    expect(seen.findLast(entry => entry.turn === approval)?.result).toContain(ref.workId);
    for (const marker of [original, native, approval]) {
      const rows = (await snap()).items;
      expect(rows.filter(item => item.kind === 'prompt' && item.text === marker)).toHaveLength(1);
      expect(rows.filter(item => item.kind === 'text' && item.text === `${marker}_REPLY`)).toHaveLength(1);
    }

    stage = 'native questions and remaining permission choices';
    const choose = async (marker: string, label: string) => {
      await expect.poll(screen, poll).toMatch(ready);
      await submit(marker);
      await expect.poll(findCard, poll).toMatchObject({ kind: 'permission' });
      const next = await findCard();
      if (next?.kind !== 'permission') throw new Error('Expected native permission card');
      const option = next.permissionOptions?.find(option => option.name === label);
      if (option === undefined) throw new Error('Missing native choice');
      return call('feed.decide', { ref, cardId: next.id, decision: {
        kind: 'permission', behavior: option.kind.startsWith('allow') ? 'allow' : 'deny', optionId: option.optionId,
      } });
    };
    expect(await choose(reject, 'Reject')).toMatchObject({ applied: true });
    await expect.poll(() => seen.findLast(entry => entry.turn === reject)?.result, poll).toMatch(/rejected/i);
    expect(await choose(feedback, 'Reject with feedback')).toMatchObject({ applied: false });
    await expect.poll(screen, poll).toContain('Type feedback · ↵ submit.');
    console.info('Native feedback prompt:', (await screen()).split('\n').filter(line => /feedback|reason|submit|cancel/i.test(line)).join('\n'));
    raw('Synthetic feedback');
    await expect.poll(screen, poll).toContain('Synthetic feedback');
    await delay(170);
    raw('\r');
    await expect.poll(() => seen.findLast(entry => entry.turn === feedback)?.result, poll).toContain('Synthetic feedback');
    expect(await choose(always, 'Approve for this session')).toMatchObject({ applied: true });
    await expect.poll(() => seen.findLast(entry => entry.turn === always)?.result, poll).toContain(ref.sessionId);
    await expect.poll(screen, poll).toMatch(ready);
    await submit(ask);
    const questionCard = async () => (await snap()).items.find(item => item.kind === 'question' && item.state === 'pending');
    await expect.poll(questionCard, poll).toMatchObject({ kind: 'question' });
    const question = await questionCard();
    expect(await call('feed.decide', { ref, cardId: question!.id, decision: {
      kind: 'question', answers: {}, values: { answer: 'ALPHA' },
    } })).toMatchObject({ applied: true });
    await expect.poll(() => seen.findLast(entry => entry.turn === ask)?.result, poll).toContain('ALPHA');

    stage = 'same-PID /new and feed on new binding';
    await expect.poll(screen, poll).toMatch(ready);
    await submit('/new');
    await expect.poll(async () => (await session()).providerSessionId, poll).not.toBe(a);
    const b = (await session()).providerSessionId!;
    expect(b).toMatch(/^session_/);
    await expect.poll(screen, poll).toContain(b);
    await expect.poll(screen, poll).toMatch(ready);
    await submit(afterNew);
    await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'text', text: `${afterNew}_REPLY` }));
    expect((await session()).pid).toBe(resumed.pid);
    expect((await session()).providerSessionId).toBe(b);

    stage = 'same registration in a clean, unbound native process';
    await expect.poll(screen, poll).toMatch(ready);
    await submit('/exit');
    await expect.poll(async () => (await session()).lifecycle, poll).toBe('sleeping');
    const term = createScreen(116, 35);
    const plain = pty.spawn(launch, [], { cwd: projectPath, env, name: 'xterm-256color', cols: 116, rows: 35 });
    const output = plain.onData(data => term.write(data));
    let plainExited = false;
    const plainExit = new Promise<void>(resolve => plain.onExit(() => { plainExited = true; resolve(); }));
    const plainScreen = () => term.text().join('\n');
    try {
      await expect.poll(plainScreen, poll).toMatch(ready);
      plain.write(unbound);
      await expect.poll(plainScreen, poll).toContain(unbound);
      await delay(170);
      plain.write('\r');
      await expect.poll(plainScreen, poll).toContain(`${unbound}_REPLY`);
      expect(seen.find(row => row.turn === unbound)?.tools.some(tool => tool.startsWith('mcp__parley__'))).toBe(false);
    } finally {
      if (!plainExited) plain.kill('SIGKILL');
      await plainExit;
      output.dispose();
      term.dispose();
    }

    stage = 'cold /new after confirmed full MCP discovery, without resume';
    const { ref: fresh } = await call('sessions.create', {
      projectPath, workId: null, provider: 'kimi', label: 'Offline cold /new comparison', task: '', parent: null,
      ...(fixtureManualDefault ? {} : { kimiPermissionMode: 'manual' as const }),
    });
    const freshSession = async () => (await readMap(fresh.projectPath, fresh.workId)).sessions.find(item => item.id === fresh.sessionId)!;
    const freshScreen = async () => (await call('pty.screenText', { ref: fresh })).lines.join('\n');
    inspectScreen = freshScreen;
    const freshGeneration = (await call('pty.attach', { ref: fresh })).generation!;
    const freshRaw = (data: string) => client!.send({ method: 'pty.input', params: { ref: fresh, data, generation: freshGeneration } });
    const freshSend = (marker: string) => expect.poll(async () => {
      const result = await call('pty.send', { ref: fresh, text: marker, submit: true });
      if (result.inserted && !result.submitted) throw new Error('Unexpected cold comparison draft');
      return result.submitted;
    }, poll).toBe(true);
    const readTimeline = async (sessionId: string) => {
      const file = join(kimi, 'sessions', workspaceKey(projectPath), sessionId, 'agents', 'main', 'wire.jsonl');
      const content = await readFile(file, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      return content.split('\n').slice(0, -1).map(line => JSON.parse(line) as {
        type: string; serverName?: string; tools?: { name: string }[];
      }).filter(row => /^(mcp\.tools_discovered|tool_select\.initialized|turn\.prompt|llm\.tools_snapshot)$/.test(row.type));
    };
    const comparisonMetrics = async (sessionId: string, marker: string) => {
      const timeline = await readTimeline(sessionId);
      const snapshot = timeline.find(row => row.type === 'llm.tools_snapshot');
      const discovered = timeline.find(row => row.type === 'mcp.tools_discovered' && row.serverName === 'parley');
      const initialized = timeline.find(row => row.type === 'tool_select.initialized');
      const advertised = seen.find(row => row.turn === marker)!.tools;
      expect(snapshot?.tools?.map(({ name }) => name).sort()).toEqual([...advertised].sort());
      return {
        order: timeline.slice(0, timeline.indexOf(snapshot!) + 1).map(row => row.type),
        discovered: discovered?.tools?.length, initialized: initialized?.tools?.length,
        advertised: advertised.length, getMapAdvertised: advertised.includes('mcp__parley__get_map'),
      };
    };
    await expect.poll(freshScreen, poll).toMatch(ready);
    const freshPid = (await freshSession()).pid;
    await freshSend(freshCold);
    await expect.poll(freshScreen, poll).toContain(`${freshCold}_REPLY`);
    const before = (await freshSession()).providerSessionId!;
    await expect.poll(async () => (await readTimeline(before)).some(row =>
      row.type === 'mcp.tools_discovered' && row.serverName === 'parley' && row.tools?.some(tool => tool.name === 'get_map')), poll).toBe(true);
    const cold = await comparisonMetrics(before, freshCold);
    await expect.poll(freshScreen, poll).toMatch(ready);
    freshRaw('/new');
    await expect.poll(freshScreen, poll).toContain('/new');
    await delay(160);
    freshRaw('\r');
    await expect.poll(async () => (await freshSession()).providerSessionId, poll).not.toBe(before);
    const nextId = (await freshSession()).providerSessionId!;
    await expect.poll(freshScreen, poll).toContain(nextId);
    await freshSend(freshAfterNew);
    await expect.poll(() => seen.some(row => row.turn === freshAfterNew), poll).toBe(true);
    const newTools = seen.find(row => row.turn === freshAfterNew)!.tools;
    if (newTools.includes('mcp__parley__get_map')) {
      await expect.poll(freshScreen, poll).toContain('Approve mcp__parley__get_map?');
      freshRaw('\r');
      await expect.poll(() => seen.findLast(row => row.turn === freshAfterNew)?.result, poll).toContain(fresh.sessionId);
    }
    await expect.poll(freshScreen, poll).toContain(`${freshAfterNew}_REPLY`);
    const after = await comparisonMetrics(nextId, freshAfterNew);
    expect((await freshSession()).pid).toBe(freshPid);
    expect((await call('pty.attach', { ref: fresh })).generation).toBe(freshGeneration);
    console.info('Cold /new catalog comparison:', JSON.stringify({ cold, after, getMapCalled: newTools.includes('mcp__parley__get_map') }));

    expect(rejected).toEqual([]);
    console.info('Production stock native host evidence:', { sameGenerationBetweenViews: true, realMap: true, coldAdvertised, requests: seen.map(row => row.turn) });
  } catch (error) {
    console.info('Production stock native host stage:', stage, { requests: seen.map(row => [row.turn, row.tools.length]), rejected });
    for (const file of (await readdir(kimi, { recursive: true }).catch(() => [])).filter(file => file.endsWith('/agents/main/wire.jsonl'))) {
      const rows = (await readFile(join(kimi, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      console.info(rows.filter(row => /mcp.tools_discovered|tool_select.initialized|llm.tools_snapshot|turn.prompt/.test(row.type))
        .map(row => ({ type: row.type, tools: row.tools?.length, parley: row.tools?.some((t: { name: string }) => t.name.includes('get_map')), time: row.time })));
      console.info(rows.filter(row => row.type === 'interaction.request' && row.kind === 'question').slice(-1));
    }
    console.info((await inspectScreen?.().catch(() => ''))?.replaceAll(root, '<temp>').slice(-2200));
    throw error;
  } finally {
    client?.close();
    await host?.context.shutdown('test cleanup');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 85000);
