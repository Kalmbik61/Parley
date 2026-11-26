import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { kimiArchiveDirectory, readMap, updateMap } from '@parley/core';
import * as pty from 'node-pty';
import { refKey, type EventData, type MethodName, type Params, type Result } from '@parley/protocol';
import { expect, test, vi } from 'vitest';
import { connectRaw, hello, waitConnected, type RawMessage, type TestClient } from '../../test/helpers.js';
import { startHost, type RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';
import { createScreen } from '../pty/screen.js';
import { workspaceKey } from './date-provenance.js';
import { kimiPermissionMenu } from './native-screen.js';

const optIn = process.env['PARLEY_KIMI_SHARED_HOST_BIN'];
const fixtureManualDefault = process.env['PARLEY_KIMI_SHARED_HOST_MANUAL_DEFAULT'] === '1';
const probeStartupRecovery = process.env['PARLEY_KIMI_SHARED_HOST_STARTUP_RECOVERY'] === '1';
const probeAutomaticBootstrap = process.env['PARLEY_KIMI_SHARED_HOST_AUTOMATIC_BOOTSTRAP'] === '1';
const probeReservedRetry = process.env['PARLEY_KIMI_SHARED_HOST_RESERVED_RETRY'] === '1';
const probeThinking = process.env['PARLEY_KIMI_SHARED_HOST_THINKING'] === '1';
const bootstrapMode = process.env['PARLEY_KIMI_SHARED_HOST_BOOTSTRAP_MODE'] ?? 'manual';
const model = 'parley-offline-fixture';
const original = 'INTEGRATED_ORIGINAL_PROMPT';
const reasoning = 'INTEGRATED_THINKING_MARKER';
const native = 'INTEGRATED_NATIVE_PROMPT';
const multiline = 'INTEGRATED_MULTILINE_PROMPT';
const wrapped = 'INTEGRATED_WRAPPED_PROMPT';
const recovered = 'INTEGRATED_RECOVERED_STARTUP';
const deferred = 'INTEGRATED_DEFERRED_STARTUP';
const approval = 'NATIVE_HOST_PERMISSION_PROBE';
const reject = 'NATIVE_HOST_REJECT_PROBE';
const feedback = 'NATIVE_HOST_FEEDBACK_PROBE';
const always = 'NATIVE_HOST_SESSION_APPROVAL';
const ask = 'NATIVE_HOST_QUESTION_PROBE';
const afterNew = 'NATIVE_HOST_AFTER_NEW';
const emptyNewFirst = 'NATIVE_HOST_EMPTY_NEW_FIRST';
const unbound = 'NATIVE_HOST_UNBOUND';
const mail = 'NATIVE_HOST_QUEUED_MAIL';
const pointer = 'Call check_inbox.';
const mapTurns = new Set([approval, reject, feedback, always]);
const ready = /^\s*│ >\s*│\s*$/m;
const sandbox = '/usr/bin/sandbox-exec';

test.skipIf(!optIn)('shares real production host Chat and Terminal on one stock Kimi PTY', async () => {
  expect(isAbsolute(optIn!)).toBe(true);
  expect(process.platform).toBe('darwin');
  const root = await realpath(await mkdtemp('/tmp/pki-'));
  const [home, kimi, parley, tmp, projectPath] = ['home', 'kimi', 'parley', 'tmp', 'project'].map(part => join(root, part)) as [string, string, string, string, string];
  const seen: { turn: string; tools: string[]; result?: string; hasMail: boolean; userText?: string }[] = [];
  const rejected: string[] = [];
  let requests = 0;
  let verifyRetryAdmission: (() => Promise<void>) | undefined;
  let releaseThinking!: () => void;
  const heldThinking = new Promise<void>(resolve => { releaseThinking = resolve; });
  const server = createServer(async (req, res) => {
    requests++;
    try {
      if (requests === 1) await verifyRetryAdmission?.();
      expect([req.method, req.url, req.headers.authorization]).toEqual(['POST', '/v1/chat/completions', 'Bearer probe-not-a-secret']);
      let input = '';
      for await (const chunk of req) {
        input += chunk;
        expect(input.length).toBeLessThan(512_000);
      }
      const body = JSON.parse(input);
      expect([body.model, body.stream]).toEqual([model, true]);
      const history = JSON.stringify(body.messages);
      const turn = [original, native, multiline, wrapped, recovered, deferred, ...mapTurns, ask, afterNew, emptyNewFirst, unbound, pointer].map(marker => ({ marker, at: history.lastIndexOf(marker) }))
        .filter(item => item.at >= 0).sort((x, y) => y.at - x.at)[0]?.marker;
      if (turn === undefined) throw new Error('Unexpected synthetic model request');
      const tools: string[] = (body.tools ?? []).map((entry: { function: { name: string } }) => entry.function.name);
      const callId = `fixture_${turn}`;
      const result = body.messages.find((message: { role: string; tool_call_id?: string }) =>
        message.role === 'tool' && message.tool_call_id === callId)?.content;
      const userText = body.messages.filter((message: { role: string }) => message.role === 'user')
        .map(({ content }: { content: string | { type: string; text?: string }[] }) => Array.isArray(content)
          ? content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') : content)
        .findLast((content: string | undefined) => content?.includes(turn));
      seen.push({ turn, tools, userText, hasMail: history.includes(mail), ...(result === undefined ? {} : { result: JSON.stringify(result) }) });
      const invoke = (mapTurns.has(turn) || turn === ask ||
        turn === emptyNewFirst || (probeReservedRetry && turn === recovered)) && result === undefined;
      const tool = turn === ask ? 'AskUserQuestion' : 'mcp__parley__get_map';
      if (invoke) expect(tools).toContain(tool);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const args = turn === ask ? { questions: [{ question: 'Which fixture marker?', header: 'Marker', multi_select: false, options: [{ label: 'ALPHA' }, { label: 'BETA' }] }] } : {};
      const delta = invoke ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }
        : { content: `${turn === pointer ? 'NATIVE_MAIL' : turn}_REPLY` };
      if (probeThinking && turn === original) {
        res.write(chunk({ role: 'assistant', reasoning_content: reasoning }, null));
        await heldThinking;
      }
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
    const executable = await realpath(optIn!);
    const executableArg = "'" + executable.replaceAll("'", "'\"'\"'") + "'";
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
      '(allow network-outbound (remote ip \\"localhost:$port\\"))"; fi',
      `exec ${sandbox} -p "$profile" ${executableArg} "$@"`,
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
      KIMI_MODEL_CAPABILITIES: probeThinking ? 'tool_use,thinking' : 'tool_use',
      KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    for (const [key, value] of Object.entries({ ...env, PARLEY_AGENT_SKILLS: 'off' })) vi.stubEnv(key, value);
    if (probeThinking) vi.stubEnv('PARLEY_SILENCE_MS', '100');
    const version = execFileSync(launch, ['--version'], { cwd: projectPath, env, encoding: 'utf8', timeout: 8000 }).trim();
    expect(['2.7.3', '2.8.0']).toContain(version);

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
    if (bootstrapMode !== 'manual' && bootstrapMode !== 'auto' && bootstrapMode !== 'yolo' && bootstrapMode !== 'inherit') throw new Error('Invalid fixture permission mode');
    const { ref } = await call('sessions.create', {
      projectPath, workId: null, provider: 'kimi', label: 'Offline native integration', task: probeReservedRetry ? recovered : '', parent: null,
      ...(probeReservedRetry ? { kimiPermissionMode: 'auto' as const }
        : probeAutomaticBootstrap ? bootstrapMode === 'inherit' ? {} : { kimiPermissionMode: bootstrapMode }
          : fixtureManualDefault ? {} : { kimiPermissionMode: 'manual' as const }),
    });
    const session = async () => (await readMap(ref.projectPath, ref.workId)).sessions.find(item => item.id === ref.sessionId)!;
    let firstStart = await session();
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

    if (probeReservedRetry) {
      stage = 'persist the legacy pre-bind failure state with its original task';
      // Stop with trust still unresolved to create the same durable state as
      // the old version rejection, without keeping an obsolete host binary.
      await expect.poll(screen, poll).toContain('Trust this folder?');
      await call('sessions.stop', { ref });
      await expect.poll(session, poll).toMatchObject({
        lifecycle: 'sleeping', providerSessionId: null, task: recovered, kimiPermissionMode: 'auto',
        kimiNativeBinding: { home: kimi, cwd: projectPath }, kimiNativeBootstrap: { phase: 'reserved' },
      });
      const reserved = (await session()).kimiNativeBootstrap!;
      expect(requests).toBe(0);
      expect((await readdir(join(kimi, 'sessions', workspaceKey(projectPath))).catch(() => [])).filter(id => id.startsWith('session_'))).toEqual([]);

      stage = 'resume the persisted reservation on a new disposable host';
      client.close();
      await host.context.shutdown('restart only the disposable fixture host');
      await host.closed;
      host = await startHost({ home: parley });
      client = connectRaw(paths.socket);
      await waitConnected(client.socket);
      expect((await hello(client, await readFile(paths.token, 'utf8'))).error).toBeUndefined();
      await call('sessions.resume', { ref });
      const restarted = await session();
      expect(restarted.pid).not.toBe(firstStart.pid);
      expect(restarted.kimiNativeBootstrap).toMatchObject({ phase: 'reserved' });
      expect(restarted.kimiNativeBootstrap?.nonce).not.toBe(reserved.nonce);
      expect(restarted.task).toBe(recovered);
      firstStart = restarted;
      const resumedGeneration = (await call('pty.attach', { ref })).generation!;
      expect(resumedGeneration).not.toBe(generation);
      generation = resumedGeneration;
      verifyRetryAdmission = async () => {
        const current = await session();
        expect(current.task).toBe(recovered);
        expect(current.kimiNativeBootstrap).toBeUndefined();
        expect(current.providerSessionId).toMatch(/^session_/);
      };
    }

    await expect.poll(screen, poll).toMatch(/Trust this folder\?|No session yet/);
    if ((await screen()).includes('Trust this folder?')) {
      expect((await screen())).toContain(projectPath);
      expect((await screen())).toContain('No project integrations or instructions to activate.');
      expect(await call('pty.send', { ref, text: original, submit: true })).toMatchObject({ submitted: false });
      raw(`\r${original}\r`);
      expect(await screen()).toContain('Trust this folder?');
      expect(requests).toBe(0);
      raw('\r');
    }
    stage = 'first Chat prompt after explicit Manual on a saved automatic default';
    await expect.poll(screen, poll).toMatch(ready);
    if (probeAutomaticBootstrap || probeReservedRetry) {
      const firstPrompt = probeReservedRetry ? recovered : emptyNewFirst;
      const noModel = () => { expect(requests).toBe(0); };
      const guarded = (text: string) => expect.poll(async () => {
        const result = await call('pty.send', { ref, text, submit: true });
        if (result.inserted && !result.submitted) throw new Error('Empty /new probe left a draft');
        return result.submitted;
      }, poll).toBe(true);
      const wireRows = async (providerId: string) => {
        const file = join(kimi, 'sessions', workspaceKey(projectPath), providerId, 'agents', 'main', 'wire.jsonl');
        const content = await readFile(file, 'utf8');
        return content.trim().split('\n').map(line => JSON.parse(line) as {
          type: string; serverName?: string; tools?: { name: string }[];
          message?: { role: string; origin?: { kind: string } };
        });
      };
      const emptyWire = (rows: Awaited<ReturnType<typeof wireRows>>) => {
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter(row => /^(?:turn\.|llm\.|context\.append_loop_event$)/.test(row.type) ||
          (row.type === 'context.append_message' && (row.message?.role === 'assistant' || row.message?.origin?.kind === 'user')))).toEqual([]);
      };
      const checkSamePty = async () => {
        expect((await session()).pid).toBe(firstStart.pid);
        expect((await call('pty.attach', { ref })).generation).toBe(generation);
      };
      stage = 'ordinary sessions.create automatically binds two empty native IDs';
      if (!probeReservedRetry) expect((await session()).kimiNativeBootstrap?.phase).toBeDefined();
      const ids = async () => (await readdir(join(kimi, 'sessions', workspaceKey(projectPath))).catch(() => []))
        .filter(file => /^session_/.test(file));
      await expect.poll(async () => {
        const error = (await snap()).items.find(item => item.kind === 'error' && item.error === 'kimi-native-startup');
        return error ?? await ids();
      }, { ...poll, timeout: 24_000 }).toHaveLength(2);
      await expect.poll(async () => {
        const current = await session();
        return current.providerSessionId !== null && current.kimiNativeBootstrap === undefined && (await screen()).includes(current.providerSessionId);
      }, poll).toBe(true);
      const finalId = (await session()).providerSessionId!;
      const abandoned = (await ids()).find(id => id !== finalId)!;
      expect(abandoned).toMatch(/^session_/);
      await expect.poll(screen, poll).toMatch(ready);
      const firstWire = await wireRows(abandoned);
      emptyWire(firstWire);
      const discovered = firstWire.find(row => row.type === 'mcp.tools_discovered' && row.serverName === 'parley')?.tools;
      expect(discovered).toHaveLength(50);
      expect(discovered?.map(({ name }) => name)).toContain('get_map');
      if (!probeReservedRetry) {
        emptyWire(await wireRows(finalId));
        noModel();
      }
      await checkSamePty();

      stage = 'first actual model request after two empty /new commands';
      if (!probeReservedRetry) await guarded(firstPrompt);
      await expect.poll(() => seen[0]?.turn, poll).toBe(firstPrompt);
      const { tools } = seen[0]!;
      const parleyTools = tools.filter(tool => tool.startsWith('mcp__parley__'));
      console.info('Empty /new first advertised tools:', { mode: probeReservedRetry ? 'reserved-auto-retry' : bootstrapMode, tools: tools.length, parleyTools: parleyTools.length });
      const getMapAdvertised = parleyTools.includes('mcp__parley__get_map');
      expect(parleyTools).toHaveLength(50);
      expect(getMapAdvertised).toBe(true);
      const toolResult = () => seen.findLast(row => row.turn === firstPrompt)?.result;
      const approval = async () => kimiPermissionMenu((await screen()).split('\n'), 'Approve mcp__parley__get_map');
      if (!probeReservedRetry && (bootstrapMode === 'manual' || (bootstrapMode === 'inherit' && fixtureManualDefault))) {
        await expect.poll(approval, poll).toBeDefined();
        raw('\r');
      } else {
        await expect.poll(async () => toolResult() !== undefined || await approval() !== undefined, poll).toBe(true);
        if (toolResult() === undefined) raw('\r');
      }
      await expect.poll(toolResult, poll).toContain(ref.sessionId);
      expect(toolResult()).toContain(ref.workId);
      await expect.poll(screen, poll).toContain(`${firstPrompt}_REPLY`);
      if (probeReservedRetry) {
        expect(seen[0]?.userText).toContain(firstPrompt);
        expect(seen.map(row => row.turn)).toEqual([firstPrompt, firstPrompt]);
        expect((await readMap(ref.projectPath, ref.workId)).sessions.map(row => row.id)).toEqual([ref.sessionId]);
      } else {
        expect(seen[0]?.userText).toBe(firstPrompt);
      }
      await expect.poll(async () => (await snap()).items.filter(item => item.kind === 'prompt'), poll).toEqual([
        expect.objectContaining({ kind: 'prompt', text: probeReservedRetry ? expect.stringContaining(firstPrompt) : firstPrompt }),
      ]);
      expect((await readFile(join(kimi, 'config.toml'), 'utf8')).split('\n')[1]).toBe(preference);
      const snapshotTools = (await wireRows(finalId)).find(row => row.type === 'llm.tools_snapshot')?.tools;
      expect(snapshotTools?.map(({ name }) => name).sort()).toEqual([...tools].sort());
      emptyWire(await wireRows(abandoned));
      await checkSamePty();
      expect((await session()).providerSessionId).toBe(finalId);
      expect(rejected).toEqual([]);
      console.info('Empty /new cold evidence:', JSON.stringify({
        version, mode: probeReservedRetry ? 'reserved-auto-retry' : bootstrapMode, abandonedWire: (await wireRows(abandoned)).map(row => row.type),
        abandonedDiscovery: discovered?.length,
        samePidAndGeneration: true, requestsBeforePrompt: 0, requests, tools: tools.length,
        parleyTools: parleyTools.length, getMapAdvertised, getMapCalled: seen.some(row => row.result !== undefined),
      }));
      return;
    }
    // Check the guarded sender's first action, retrying only if not a single byte was inserted.
    await expect.poll(async () => {
      const result = await call('pty.send', { ref, text: original, submit: true });
      if (result.inserted && !result.submitted) throw new Error('Chat text became an unsubmitted draft');
      return result.submitted;
    }, poll).toBe(true);
    if (probeThinking) {
      stage = 'native thinking through wire silence and then completion';
      const key = refKey(ref);
      const readActivity = async () => {
        await snap(); // Drain the host's activity.changed events in order.
        return events.filter(event => event.event === 'activity.changed')
          .map(event => event.data as EventData<'activity.changed'>)
          .filter(event => refKey(event.ref) === key)
          .at(-1)?.activity;
      };
      await expect.poll(screen, poll).toContain(reasoning);
      await expect.poll(screen, poll).toMatch(/Working for \d/);
      await expect.poll(readActivity, poll).toMatchObject({ activity: 'working', turnEndedAt: null });
      const providerId = (await session()).providerSessionId!;
      const file = join(kimi, 'sessions', workspaceKey(projectPath), providerId, 'agents', 'main', 'wire.jsonl');
      const readWire = () => readFile(file, 'utf8');
      const before = await readWire();
      expect(before).toMatch(/"type":"step.begin"/);
      expect(before).not.toMatch(/"type":"turn.ended"/);
      const silentSince = Date.now();
      await delay(1250);
      expect(await readWire()).toBe(before);
      expect(await readActivity()).toMatchObject({ activity: 'working', turnEndedAt: null });
      expect((await snap()).items.some(item => item.kind === 'text' && item.text.includes(reasoning))).toBe(false);
      const quietMs = Date.now() - silentSince;

      releaseThinking();
      await expect.poll(readActivity, poll).toMatchObject({ activity: 'unseen', turnEndedAt: expect.any(String) });
      await expect.poll(screen, poll).toMatch(ready);
      await expect.poll(readWire, poll).toMatch(/"type":"turn.ended"/);
      await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'turn' }));
      expect((await snap()).items.some(item => item.kind === 'text' && item.text.includes(reasoning))).toBe(false);
      client.send({ method: 'activity.seen', params: { ref } });
      await expect.poll(readActivity, poll).toMatchObject({ activity: 'idle' });
      expect(rejected).toEqual([]);
      console.info('Native thinking evidence:', { version, quietMs, activity: ['working', 'unseen', 'idle'] });
      return;
    }
    await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'text', text: `${original}_REPLY`, streaming: false }));
    const a = (await session()).providerSessionId!;
    expect(a).toMatch(/^session_/);
    const coldAdvertised = seen[0]?.tools.includes('mcp__parley__get_map');
    expect(coldAdvertised).toBe(true);
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

    stage = 'guarded Chat multiline and naturally wrapped input';
    client.send({ method: 'pty.resize', params: { ref, cols: 80, rows: 26, generation } });
    expect(await call('pty.attach', { ref })).toMatchObject({ cols: 80, rows: 26, generation });
    const multilineText = `${multiline}\nline two with é\n\nline four with α\nline five\nline six\nline seven\nline eight\nline nine`;
    const wrappedText = `${wrapped} ${'wrapped phrase '.repeat(60)}TAIL`;
    // Stock Kimi replaces larger pastes with a one-line placeholder instead of wrapping them.
    expect(wrappedText.length).toBe(930);
    for (const [marker, input] of [[multiline, multilineText], [wrapped, wrappedText]] as const) {
      await expect.poll(async () => {
        const result = await call('pty.send', { ref, text: input, submit: true });
        if (result.inserted && !result.submitted) throw new Error(`${marker} became an unsubmitted draft (${result.reason})`);
        return result.submitted;
      }, poll).toBe(true);
      await expect.poll(async () => (await snap()).items, poll).toContainEqual(expect.objectContaining({ kind: 'text', text: `${marker}_REPLY` }));
      expect(seen.filter(row => row.turn === marker).map(row => row.userText)).toEqual([input]);
      expect((await snap()).items.filter(row => row.kind === 'prompt' && row.text === input)).toHaveLength(1);
    }
    client.send({ method: 'pty.resize', params: { ref, cols: 116, rows: 35, generation } });
    expect(await call('pty.attach', { ref })).toMatchObject({ cols: 116, rows: 35, generation });

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

    if (probeStartupRecovery) {
      stage = 'visible fail-closed Always Ask bootstrap interrupted by Stop';
      const beforeFailure = seen.length;
      const recoveryProject = join(root, 'recovery-project');
      await mkdir(recoveryProject);
      const { ref: failed } = await call('sessions.create', {
        projectPath: recoveryProject, workId: null, provider: 'kimi', label: 'Offline startup recovery', task: '', parent: null, kimiPermissionMode: 'manual',
      });
      const failedScreen = async () => (await call('pty.screenText', { ref: failed })).lines.join('\n');
      const failedSession = async () => (await readMap(failed.projectPath, failed.workId)).sessions.find(item => item.id === failed.sessionId)!;
      inspectScreen = failedScreen;
      const failedAttach = await call('pty.attach', { ref: failed });
      const failedPid = (await failedSession()).pid;
      await expect.poll(failedScreen, poll).toContain('Trust this folder?');
      client.send({ method: 'pty.input', params: { ref: failed, data: '\r', generation: failedAttach.generation } });
      await expect.poll(failedScreen, { ...poll, interval: 10 }).toMatch(/│ >\s*\/permission\s*│/);
      expect(await call('pty.send', { ref: failed, text: recovered, submit: true })).toMatchObject({ inserted: false, submitted: false });
      client.send({ method: 'pty.input', params: { ref: failed, data: `${recovered}\r`, generation: failedAttach.generation } });
      expect(await failedScreen()).not.toContain(recovered);
      await call('sessions.stop', { ref: failed });
      await expect.poll(async () => (await call('feed.snapshot', { ref: failed })).items, poll).toContainEqual(expect.objectContaining({
        kind: 'error', error: 'kimi-native-startup', message: expect.stringMatching(/Always Ask.*stop.*resume/i),
      }));
      expect(await failedSession()).toMatchObject({ providerSessionId: null, kimiNativeBootstrap: { phase: 'reserved' } });
      expect(seen).toHaveLength(beforeFailure);
      await expect.poll(async () => (await failedSession()).lifecycle, poll).toBe('sleeping');
      await call('sessions.resume', { ref: failed });
      expect((await failedSession()).pid).not.toBe(failedPid);
      await expect.poll(async () => {
        const result = await call('pty.send', { ref: failed, text: recovered, submit: true });
        if (result.inserted && !result.submitted) throw new Error('Recovery entered an unsubmitted draft');
        return result.submitted;
      }, poll).toBe(true);
      await expect.poll(failedScreen, poll).toContain(`${recovered}_REPLY`);
      expect(seen.filter(row => row.turn === recovered).map(row => row.userText)).toEqual([recovered]);

      stage = 'stopping after an empty ID is bound preserves it and does not replay /new';
      const beforeStop = requests;
      const { ref: late } = await call('sessions.create', {
        projectPath, workId: null, provider: 'kimi', label: 'Offline rotating startup stop', task: '', parent: null, kimiPermissionMode: 'manual',
      });
      const lateSession = async () => (await readMap(late.projectPath, late.workId)).sessions.find(item => item.id === late.sessionId)!;
      await expect.poll(async () => {
        const current = await lateSession();
        return current.kimiNativeBootstrap?.phase === 'rotating' ? current.providerSessionId : null;
      }, { ...poll, interval: 10 }).toMatch(/^session_/);
      const bound = (await lateSession()).providerSessionId;
      await call('sessions.stop', { ref: late });
      expect(await lateSession()).toMatchObject({ providerSessionId: bound, kimiNativeBootstrap: { phase: 'rotating' }, lifecycle: 'sleeping' });
      const resumed = await request('sessions.resume', { ref: late });
      expect(resumed.error).toMatchObject({ code: 'conflict', message: expect.stringMatching(/conversation and queued messages were kept/i) });
      expect(requests).toBe(beforeStop);

      stage = 'ordinary deferred task gets full tools on its first and only turn';
      const { ref: queued } = await call('sessions.create', {
        projectPath, workId: null, provider: 'kimi', label: 'Offline deferred first task', task: deferred, parent: null, kimiPermissionMode: 'manual',
      });
      await expect.poll(async () => (await call('feed.snapshot', { ref: queued })).items, { ...poll, timeout: 20_000 })
        .toContainEqual(expect.objectContaining({ kind: 'text', text: `${deferred}_REPLY` }));
      expect(seen.filter(row => row.turn === deferred)).toMatchObject([{ tools: expect.arrayContaining(['mcp__parley__get_map']) }]);

      stage = 'rotating provenance survives restarting the disposable host';
      const total = requests;
      client.close();
      await host.context.shutdown('test-only restart of disposable host');
      await host.closed;
      host = await startHost({ home: parley });
      client = connectRaw(paths.socket);
      await waitConnected(client.socket);
      expect((await hello(client, await readFile(paths.token, 'utf8'))).error).toBeUndefined();
      expect((await request('sessions.resume', { ref: late })).error).toMatchObject({ code: 'conflict', message: expect.stringMatching(/conversation and queued messages were kept/i) });
      expect(await lateSession()).toMatchObject({ providerSessionId: bound, kimiNativeBootstrap: { phase: 'rotating' }, lifecycle: 'sleeping' });
      expect(requests).toBe(total);
    }

    expect(rejected).toEqual([]);
    console.info('Production stock native host evidence:', { sameGenerationBetweenViews: true, realMap: true, coldAdvertised, requests: seen.map(row => row.turn) });
  } catch (error) {
    console.info('Production stock native host stage:', stage, { requests: seen.map(row => [row.turn, row.tools.length]), rejected });
    const startupLog = (await readFile(hostPaths(parley).log, 'utf8').catch(() => '')).split('\n')
      .filter(line => /Kimi first-turn bootstrap stopped|Kimi native provider binding could not be verified/.test(line));
    if (startupLog.length) console.info(startupLog.map(line => line.replaceAll(root, '<temp>')));
    for (const file of (await readdir(kimi, { recursive: true }).catch(() => [])).filter(file => file.endsWith('/agents/main/wire.jsonl'))) {
      const rows = (await readFile(join(kimi, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      console.info('Fixture wire row types', rows.slice(0, 32).map(row => row.type === 'metadata'
        ? [row.type, row.protocol_version, row.min_protocol_version] : row.type));
      console.info(rows.filter(row => /mcp.tools_discovered|tool_select.initialized|llm.tools_snapshot|turn.prompt/.test(row.type))
        .map(row => ({ type: row.type, tools: row.tools?.length, parley: row.tools?.some((t: { name: string }) => t.name.includes('get_map')), time: row.time })));
      console.info(rows.filter(row => row.type === 'interaction.request' && row.kind === 'question').slice(-1));
    }
    console.info((await inspectScreen?.().catch(() => ''))?.replaceAll(root, '<temp>').slice(-2200));
    throw error;
  } finally {
    releaseThinking();
    client?.close();
    await host?.context.shutdown('test cleanup');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 85000);
