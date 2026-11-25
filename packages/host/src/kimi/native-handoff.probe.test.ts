import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import * as pty from 'node-pty';
import { expect, test } from 'vitest';

const bin = '/Users/kalmbik61/.kimi-code/bin/kimi';
const optIn = process.env['PARLEY_KIMI_PROBE_BIN'];
const fixtures = fileURLToPath(new URL('./fixtures/native/', import.meta.url));
const model = 'parley-offline-fixture';
const toolPattern = /mcp__[\w-]*handoff_probe/;
const qualifiedTool = 'mcp__plugin-parley-handoff-probe_fixture__handoff_probe';
const limit = 8_000;

type Json = Record<string, unknown>;
type ModelRequest = { prompt: string; history: string; tool?: string; definitions: string; finished: boolean; discovery: string[]; result?: string };
type Lease = { id: string; generation: string; label: string; revoked: boolean; grant: boolean };
type LeaseEvent = { id?: string; generation: string; event: string; tool?: string; allowed: boolean };

function safeText(text: string): string {
  return text.replace(/(?:\/private)?\/tmp\/parley-kimi-[^/\s]+/g, '<temp>');
}

async function wait<T>(label: string, check: () => T | undefined, details: () => string = () => ''): Promise<T> {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const result = check();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(`${label} timed out\n${safeText(details()).slice(-1_500)}`);
}

function modelFixture() {
  const seen: ModelRequest[] = [];
  const rejected: string[] = [];
  let knownTool: string | undefined;
  const server = createServer(async (req, res) => {
    try {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer probe-not-a-secret');
      let input = '';
      for await (const chunk of req) {
        input += chunk;
        expect(input.length).toBeLessThan(512_000);
      }
      const body = JSON.parse(input);
      expect(body.model).toBe(model);
      expect(body.stream).toBe(true);
      const history = JSON.stringify(body.messages);
      const fixtureTool = body.tools?.find((entry: { function: { name: string } }) => toolPattern.test(entry.function.name))?.function;
      const definitions = JSON.stringify(fixtureTool ?? {});
      const tool = fixtureTool?.name as string | undefined;
      const prompt = [...history.matchAll(/PROBE_PROMPT_([A-Z_]+)/g)].at(-1)?.[1];
      if (!prompt) throw new Error('No synthetic prompt in model request');
      const names: string[] = (body.tools ?? []).map((entry: { function: { name: string } }) => entry.function.name);
      const announced = history.match(toolPattern)?.[0];
      const alreadyCalled = (type: string) => body.messages.some((message: { tool_calls?: { id: string }[] }) => message.tool_calls?.some(call => call.id === `${type}_${prompt}`));
      const disclose = ['NATIVE_A', 'NATIVE_B'].includes(prompt) && !tool && announced && names.includes('select_tools') && !alreadyCalled('disclose');
      const loaded = announced && history.includes(`Loaded: ${announced}`) ? announced : undefined;
      knownTool ??= tool ?? loaded;
      const requestedTool = ['NATIVE_A', 'NATIVE_B'].includes(prompt) ? tool ?? loaded
        : ['SWITCHED', 'REVOKED'].includes(prompt) ? tool ?? knownTool : undefined;
      const call = disclose ? { id: `disclose_${prompt}`, name: 'select_tools', arguments: JSON.stringify({ names: [announced] }) }
        : requestedTool && !alreadyCalled('probe') ? { id: `probe_${prompt}`, name: requestedTool, arguments: '{}' } : undefined;
      const discovery = [...new Set([...(announced ? [announced] : []), ...names.filter(name => /mcp__|^select_tools$/.test(name))])];
      const result = body.messages.findLast((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id?.endsWith(`_${prompt}`))?.content;
      seen.push({ prompt, history, tool, definitions, finished: !call, discovery, result: result === undefined ? undefined : JSON.stringify(result).slice(0, 400) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] }
        : { content: `PROBE_REPLY_${prompt}` };
      const send = (choice: Json) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, ...choice }] })}\n\n`);
      send({ delta: { role: 'assistant', ...delta }, finish_reason: null });
      send({ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' });
      res.end('data: [DONE]\n\n');
    } catch (error) {
      rejected.push(String(error));
      res.writeHead(400).end();
    }
  });
  return { server, seen, rejected };
}

const sandbox = '/usr/bin/sandbox-exec';

function launchEnv(root: string, port: number, selectTools: boolean) {
  const env = {
    HOME: join(root, 'home'), KIMI_CODE_HOME: join(root, 'kimi'), PARLEY_HOME: join(root, 'parley'),
    TMPDIR: join(root, 'tmp'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/sh',
    TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
    KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'probe-not-a-secret',
    KIMI_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ...(selectTools && { KIMI_MODEL_CAPABILITIES: 'tool_use,dynamically_loaded_tools', KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: '1' }),
  };
  const profile = join(root, 'sandbox.sb');
  // The only socket destination is this run's synthetic model. Deny real home data even
  // if Kimi or a child consults the OS account home instead of the HOME variable.
  writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
(deny file-read-data (subpath "/Users/kalmbik61"))
(deny file-write* (subpath "/Users/kalmbik61"))
(allow file-read-data (literal ${JSON.stringify(realpathSync(bin))}) (literal ${JSON.stringify(realpathSync(process.execPath))}))
`);
  return { env, argv: ['-f', profile, bin] };
}

type Launch = ReturnType<typeof launchEnv>;

function startAcp(launch: Launch, cwd: string) {
  const child = spawn(sandbox, [...launch.argv, 'acp'], { cwd, env: launch.env });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exited = new Promise<void>(resolve => child.once('close', (code, signal) => { exit = { code, signal }; resolve(); }));
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, { result?: Json; error?: Json }>();
  const updates: { sessionId: string; update: { sessionUpdate: string; content?: { text?: string } } }[] = [];
  let stderr = '';
  let next = 0;
  child.on('error', error => { stderr = String(error); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-1_200); });
  lines.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'session/update') updates.push(msg.params);
    else if (msg.method && msg.id !== undefined) {
      // No ACP interaction is authorized. Never approve an unexpected request.
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not a probe method' } }) + '\n');
    } else if (msg.id !== undefined) replies.set(msg.id, msg);
  });
  async function rpc(method: string, params: Json) {
    const id = ++next;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const reply = await wait(method, () => replies.get(id), () => stderr);
    expect(reply.error, method).toBeUndefined();
    return reply.result ?? {};
  }
  return { rpc, updates, async exit(sessionId?: string) {
    if (sessionId) await rpc('session/close', { sessionId });
    child.stdin.end();
    expect(await wait('ACP process exit', () => exit, () => stderr)).toEqual({ code: 0, signal: null });
  }, async dispose() { child.kill('SIGKILL'); await exited; } };
}

function startNative(launch: Launch, cwd: string, args: string[], extra = {}) {
  const terminal = new xterm.Terminal({ cols: 116, rows: 30, scrollback: 0, allowProposedApi: true });
  const child = pty.spawn(sandbox, [...launch.argv, ...args], { cwd, env: { ...launch.env, ...extra }, name: 'xterm-256color', cols: terminal.cols, rows: terminal.rows });
  let frames = 0;
  let exit: number | undefined;
  const exited = new Promise<number>(resolve => child.onExit(({ exitCode }) => { exit = exitCode; resolve(exitCode); }));
  const output = child.onData(data => terminal.write(data, () => { frames++; }));
  function screen() {
    const b = terminal.buffer.active;
    const rows = Array.from({ length: terminal.rows }, (_, row) => b.getLine(b.baseY + row)?.translateToString(true) ?? '');
    return safeText(rows.filter(row => row.trim()).join('\n'));
  }
  async function until(label: string, pattern: RegExp) {
    return wait(label, () => {
      const text = screen();
      if (pattern.test(text)) return text;
      if (exit !== undefined) throw new Error(`${label}: Kimi exited (${exit})\n${text}`);
    }, screen);
  }
  async function submit(text: string) {
    // A raw burst makes 2.7.3 interpret a following Return as a pasted newline.
    child.write(`\x1b[200~${text}\x1b[201~`);
    await until('native typed input', new RegExp(safeText(text).slice(-32).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // 2.7.3 also has a 120 ms fallback suppression window for fast terminal input.
    await delay(150);
    child.write('\r');
  }
  return { screen, until, submit, key: (key: string) => child.write(key), async resize(cols: number, rows: number) {
    const before = frames;
    terminal.resize(cols, rows);
    child.resize(cols, rows);
    await wait('PTY SIGWINCH repaint', () => frames > before ? true : undefined, screen);
    return [terminal.cols, terminal.rows];
  }, async exit() {
    child.write('\x04');
    await wait('native exit or confirmation', () => exit !== undefined || /press.*(?:again|exit|quit)/i.test(screen()) ? true : undefined, screen);
    if (exit === undefined) child.write('\x04');
    await wait('native exit', () => exit, screen);
    expect(await exited).toBe(0);
  }, async exitViaCommand() {
    await submit('/exit');
    expect(await wait('native /exit process exit', () => exit, screen)).toBe(0);
  }, async dispose() {
    if (exit === undefined) child.kill('SIGKILL');
    await exited;
    output.dispose();
    terminal.dispose();
  } };
}

function bind(root: string, id: string, label: string) {
  const path = join(root, `lease-${label}`);
  const initial: Lease = { id, label, generation: `generation-${label}`, revoked: false, grant: false };
  writeFileSync(path, JSON.stringify(initial), { mode: 0o600 });
  const read = (): Lease => JSON.parse(readFileSync(path, 'utf8'));
  return { env: { PROBE_LEASE: path, PROBE_GENERATION: initial.generation }, read,
    revoke: () => writeFileSync(path, JSON.stringify({ ...read(), revoked: true, grant: false })),
    events: (): LeaseEvent[] => existsSync(path + '.events') ? readFileSync(path + '.events', 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}

const ready = /^\s*│ >\s*│\s*$/m;
const initialise = { protocolVersion: 1, clientCapabilities: {} };

async function approveFixtureOnce(native: ReturnType<typeof startNative>) {
  const prompt = await native.until('fixture approval', new RegExp(`Approve ${qualifiedTool}\\?`));
  expect(prompt).toMatch(/▶ 1\. Approve once/);
  native.key('1');
}

test.skipIf(!optIn).each([
  { mode: 'default OpenAI model settings', selectTools: false },
  { mode: 'experimental tool selection', selectTools: true },
])('stock Kimi 2.7.3 native handoff with $mode', async ({ selectTools }) => {
  expect(optIn).toBe(bin);
  expect(process.platform).toBe('darwin');
  const root = realpathSync(mkdtempSync('/tmp/parley-kimi-'));
  const cwd = join(root, 'cwd');
  for (const dir of ['home', 'kimi', 'parley', 'tmp', 'cwd']) mkdirSync(join(root, dir));
  const { server, seen, rejected } = modelFixture();
  const owners = new Map<string, string>();
  const timeline: string[] = [];
  const screens: Record<string, string> = {};
  const disposals: (() => Promise<void>)[] = [];
  const leases: ReturnType<typeof bind>[] = [];
  const aliases = new Map<string, string>();
  let stage = 'loopback listen';
  function acquire(id: string, owner: string) {
    expect(owners.has(id), `${id} already owned`).toBe(false);
    owners.set(id, owner);
    timeline.push(`${id} ${owner} acquired`);
  }
  function release(id: string, owner: string, end = 'exited') {
    expect(owners.get(id)).toBe(owner);
    owners.delete(id);
    timeline.push(`${id} ${owner} ${end}`);
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    const launch = launchEnv(root, address.port, selectTools);
    stage = 'sandbox and version';
    const version = execFileSync(sandbox, [...launch.argv, '--version'], { cwd, env: launch.env, timeout: limit, encoding: 'utf8' }).trim();
    expect(version).toBe('2.7.3');
    console.info('Kimi version:', version);
    async function seed(label: string) {
      const acp = startAcp(launch, cwd);
      disposals.push(acp.dispose);
      await acp.rpc('initialize', initialise);
      const { sessionId } = await acp.rpc('session/new', { cwd, mcpServers: [] });
      expect(typeof sessionId).toBe('string');
      const id = sessionId as string;
      aliases.set(id, label);
      acquire(label, 'ACP seed');
      const result = await acp.rpc('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: `PROBE_PROMPT_ACP_${label}` }] });
      expect(result.stopReason).toBe('end_turn');
      expect(JSON.stringify(acp.updates)).toContain(`PROBE_REPLY_ACP_${label}`);
      await acp.exit(id);
      release(label, 'ACP seed');
      return id;
    }
    stage = 'ACP seed A and B';
    const a = await seed('A');
    const b = await seed('B');
    expect(a).not.toBe(b);

    stage = 'local plugin install';
    const plugin = join(root, 'plugin');
    expect(readdirSync(fixtures, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => [entry.name, entry.isFile()])).toEqual([
      ['binding.cjs', true], ['hook.cjs', true], ['kimi.plugin.json', true], ['mcp.cjs', true],
    ]);
    cpSync(fixtures, plugin, { recursive: true });
    const installer = startNative(launch, cwd, []);
    disposals.push(installer.dispose);
    const trust = await installer.until('disposable workspace trust', /Trust this folder\?/);
    expect(trust).toContain('<temp>/cwd');
    expect(trust).toContain('No project integrations or instructions to activate.');
    expect(trust).toMatch(/❯ Trust and continue/);
    expect(readdirSync(cwd)).toEqual([]);
    installer.key('\r');
    await installer.until('installer ready', ready);
    await installer.submit(`/plugins install ${plugin}`);
    await installer.until('inert plugin confirmation', /Install third-party plugin <temp>\/plugin\?/);
    installer.key('\x1b[B');
    await installer.until('fixture install selected', /❯ Trust and install/);
    installer.key('\r');
    await installer.until('local plugin installed', /(?:installed|installation succeeded).*parley-handoff-probe|parley-handoff-probe.*installed/i);
    await installer.exit();

    const leaseA = bind(root, a, 'A');
    const leaseB = bind(root, b, 'B');
    leases.push(leaseA, leaseB);
    stage = 'native A presentation and model';
    const native = startNative(launch, cwd, ['--session', a], leaseA.env);
    disposals.push(native.dispose);
    acquire('A', 'native');
    screens['ready 116x30'] = await native.until('native resumes A', ready);
    expect(screens['ready 116x30']).toContain(a);
    await native.submit('/help');
    screens['help 116x30'] = await native.until('native help', /(?:Slash Commands|Keyboard Shortcuts|\bKimi Code Help\b)/i);
    native.key('\x1b');
    await native.until('Escape returns to composer', ready);
    expect(await native.resize(92, 24)).toEqual([92, 24]);
    screens['resized 92x24'] = await native.until('composer repainted', ready);
    await native.until('fixture MCP connected', /connected · 1 tool \(stdio\)/);
    await native.submit('PROBE_PROMPT_NATIVE_A');
    if (selectTools) await approveFixtureOnce(native);
    await native.until('native A reply', /PROBE_REPLY_NATIVE_A/);
    const nativeA = seen.find(r => r.prompt === 'NATIVE_A');
    expect(nativeA?.history).toContain('PROBE_PROMPT_ACP_A');
    expect(nativeA?.history).toContain('PROBE_REPLY_ACP_A');
    expect(nativeA?.history).toContain('RULES_A');
    expect(nativeA?.history).not.toMatch(/RULES_B|PROBE_PROMPT_ACP_B/);
    expect(leaseA.events()).toContainEqual(expect.objectContaining({ event: 'UserPromptSubmit', id: a, allowed: true }));
    await native.exit();
    leaseA.revoke();
    release('A', 'native');

    stage = 'ACP replay A';
    const replay = startAcp(launch, cwd);
    disposals.push(replay.dispose);
    acquire('A', 'ACP load');
    await replay.rpc('initialize', initialise);
    await replay.rpc('session/load', { cwd, sessionId: a, mcpServers: [] });
    const transcript = replay.updates.flatMap(({ sessionId, update }) => {
      if (!update.content?.text) return [];
      expect(sessionId).toBe(a);
      return [{ role: update.sessionUpdate, text: update.content.text }];
    });
    for (const [role, marker] of [
      ['user_message_chunk', 'PROBE_PROMPT_ACP_A'], ['agent_message_chunk', 'PROBE_REPLY_ACP_A'],
      ['user_message_chunk', 'PROBE_PROMPT_NATIVE_A'], ['agent_message_chunk', 'PROBE_REPLY_NATIVE_A'],
    ]) {
      const text = transcript.filter(entry => entry.role === role).map(entry => entry.text).join('');
      expect(text.split(marker).length - 1, marker).toBe(1);
    }
    await replay.exit(a);
    release('A', 'ACP load');
    console.info('ACP load replayed A’s two user prompts and replies once each.');

    stage = 'native A tool disclosure and call';
    const advertisedA = seen.filter(r => r.prompt === 'NATIVE_A');
    if (!selectTools) {
      expect(advertisedA).toHaveLength(1);
      expect(advertisedA[0]?.tool).toBeUndefined();
      expect(advertisedA[0]?.discovery).toEqual([qualifiedTool]);
      expect(advertisedA[0]?.history.includes('cannot load runtime tool additions with select_tools')).toBe(true);
      expect(leaseA.events()).toContainEqual(expect.objectContaining({ event: 'tools/list', allowed: true }));
      expect(leaseA.events().some(e => e.event === 'tools/call')).toBe(false);
      expect(owners.size).toBe(0);
      expect(rejected).toEqual([]);
      expect(seen.map(r => r.prompt)).toEqual(['ACP_A', 'ACP_B', 'NATIVE_A']);
      return;
    }
    expect(advertisedA.some(req => req.discovery.includes(qualifiedTool))).toBe(true);
    expect(advertisedA.some(req => req.tool === qualifiedTool)).toBe(false);
    expect(advertisedA.some(req => (req.definitions + req.history).includes('TOOL_B'))).toBe(false);
    expect(leaseA.events()).toContainEqual(expect.objectContaining({ event: 'PreToolUse', id: a, allowed: true }));
    expect(leaseA.events()).toContainEqual(expect.objectContaining({ event: 'tools/call', allowed: true }));
    expect(seen.find(r => r.prompt === 'NATIVE_A' && r.finished)?.history.includes('RESULT_A')).toBe(true);

    stage = 'native B';
    const other = startNative(launch, cwd, ['--session', b], leaseB.env);
    disposals.push(other.dispose);
    acquire('B', 'native');
    await other.until('native B ready', ready);
    await other.until('fixture MCP connected for B', /connected · 1 tool \(stdio\)/);
    await other.submit('PROBE_PROMPT_NATIVE_B');
    await approveFixtureOnce(other);
    await other.until('native B reply', /PROBE_REPLY_NATIVE_B/);
    const nativeB = seen.find(r => r.prompt === 'NATIVE_B');
    expect(nativeB?.history).toContain('PROBE_PROMPT_ACP_B');
    expect(nativeB?.history).toContain('RULES_B');
    expect(nativeB?.history).not.toMatch(/RULES_A|PROBE_PROMPT_ACP_A/);
    const advertisedB = seen.filter(r => r.prompt === 'NATIVE_B');
    expect(advertisedB.some(req => req.discovery.includes(qualifiedTool))).toBe(true);
    expect(advertisedB.some(req => req.tool === qualifiedTool)).toBe(false);
    expect(advertisedB.some(req => (req.definitions + req.history).includes('TOOL_A'))).toBe(false);
    expect(seen.find(r => r.prompt === 'NATIVE_B' && r.finished)?.history.includes('RESULT_B')).toBe(true);
    expect(leaseB.events()).toContainEqual(expect.objectContaining({ event: 'PreToolUse', id: b, allowed: true }));
    expect(leaseB.events().filter(e => e.event === 'tools/call' && e.allowed)).toHaveLength(1);

    stage = 'native /new isolation';
    await other.submit('/new');
    const switched = await wait('new session hook revoked B', () => leaseB.events().find(e => e.event === 'SessionStart' && e.id && e.id !== b && !e.allowed), other.screen);
    expect(switched.id).not.toBe(a);
    if (switched.id) aliases.set(switched.id, 'C');
    expect(leaseB.read().revoked).toBe(true);
    release('B', 'native', 'switched to C in the same process');
    acquire('C', 'native');
    await other.submit('PROBE_PROMPT_SWITCHED');
    await other.until('switched reply', /PROBE_REPLY_SWITCHED/);
    expect(leaseB.events()).toContainEqual(expect.objectContaining({ event: 'UserPromptSubmit', id: switched.id, allowed: false }));
    expect(leaseB.events()).toContainEqual(expect.objectContaining({ event: 'PreToolUse', id: switched.id, tool: qualifiedTool, allowed: false }));
    expect(leaseB.events().filter(e => e.event === 'tools/call' && e.allowed)).toHaveLength(1);
    const switchedRequests = seen.filter(req => req.prompt === 'SWITCHED');
    expect(switchedRequests.every(req => !/RULES_[AB]|PROBE_PROMPT_ACP_[AB]|RESULT_[AB]/.test(req.history))).toBe(true);
    expect(switchedRequests.at(-1)?.result).toContain('PROBE_STALE_BINDING');
    // Deliberately verify the observed stock-2.7.3 blocker. Revocation prevents a call,
    // but /new keeps the former stdio tool description in the model-facing catalog.
    expect(switchedRequests[0]?.tool).toBe(qualifiedTool);
    expect(switchedRequests[0]?.definitions).toContain('TOOL_B');
    await other.exit();
    release('C', 'native');

    stage = 'revoked launch generation';
    const leaseA2 = bind(root, a, 'A2');
    leases.push(leaseA2);
    const stale = startNative(launch, cwd, ['--session', a], leaseA2.env);
    disposals.push(stale.dispose);
    acquire('A', 'native revocation check');
    await stale.until('native before revocation', ready);
    await stale.until('connected fixture before revocation', /connected · 1 tool \(stdio\)/);
    expect(leaseA2.events()).toContainEqual(expect.objectContaining({ event: 'tools/list', allowed: true }));
    leaseA2.revoke();
    await stale.submit('PROBE_PROMPT_REVOKED');
    await stale.until('revoked prompt reply', /PROBE_REPLY_REVOKED/);
    expect(leaseA2.events()).toContainEqual(expect.objectContaining({ event: 'UserPromptSubmit', id: a, allowed: false }));
    expect(leaseA2.events()).toContainEqual(expect.objectContaining({ event: 'PreToolUse', id: a, tool: qualifiedTool, allowed: false }));
    const revoked = seen.find(r => r.prompt === 'REVOKED' && r.finished);
    expect(revoked?.result).toContain('PROBE_STALE_BINDING');
    expect(revoked?.history).not.toMatch(/RULES_A2|RESULT_A2/);
    expect(leaseA2.events().filter(e => e.event === 'tools/call')).toEqual([]);
    await stale.exit();
    release('A', 'native revocation check');

    stage = 'unbound native isolation';
    const events = leases.map(lease => lease.events().length);
    const bare = startNative(launch, cwd, []);
    disposals.push(bare.dispose);
    acquire('D', 'unbound native');
    await bare.until('unbound ready', ready);
    await bare.submit('PROBE_PROMPT_UNBOUND');
    await bare.until('unbound reply', /PROBE_REPLY_UNBOUND/);
    await bare.exit();
    release('D', 'unbound native');
    expect(leases.map(lease => lease.events().length)).toEqual(events);
    const unbound = seen.find(r => r.prompt === 'UNBOUND');
    expect(unbound?.history).not.toMatch(/RULES_[AB]|PROBE_PROMPT_ACP_[AB]|RESULT_[AB]/);
    expect(unbound?.tool).toBeUndefined();
    expect(unbound?.discovery).not.toContain(qualifiedTool);
    expect(owners.size).toBe(0);
    expect(rejected).toEqual([]);
    expect(seen.map(r => r.prompt)).toEqual(['ACP_A', 'ACP_B', 'NATIVE_A', 'NATIVE_A', 'NATIVE_A', 'NATIVE_B', 'NATIVE_B', 'NATIVE_B', 'SWITCHED', 'SWITCHED', 'REVOKED', 'REVOKED', 'UNBOUND']);
  } catch (error) {
    throw new Error(`Probe blocked at ${stage}`, { cause: error });
  } finally {
    await Promise.allSettled(disposals.map(dispose => dispose()));
    console.info('Synthetic owner timeline:', timeline);
    for (const [name, screen] of Object.entries(screens)) {
      const redacted = screen.replace(/session_[\da-f-]+/g, id => `session_${aliases.get(id) ?? 'redacted'}`);
      console.info(`${name}\n${redacted.split('\n').slice(0, 24).join('\n')}`);
    }
    console.info(`Loopback requests (${seen.length}, ${rejected.length} rejected):\n` + seen.map(req => JSON.stringify({
      prompt: req.prompt, tool: req.tool, discovery: req.discovery, result: req.result,
      rules: [...new Set(req.history.match(/RULES_(?:A2|A|B)/g))], description: (req.definitions + req.history).match(/TOOL_(?:A2|A|B)/)?.[0],
    })).join('\n'));
    console.info('Fixture events:\n' + leases.flatMap(lease => lease.events()).map(event => JSON.stringify({
      ...event, id: event.id ? aliases.get(event.id) ?? 'redacted' : undefined,
    })).join('\n'));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 110_000);

const ordinaryBinary = process.env['PARLEY_KIMI_NATIVE_BIN'];
test.skipIf(!ordinaryBinary)('ordinary stock Kimi round trip without any plugin installation', async () => {
  expect(ordinaryBinary).toBe(bin);
  expect(process.platform).toBe('darwin');
  const root = realpathSync(mkdtempSync('/tmp/parley-kimi-native-'));
  const cwd = join(root, 'cwd');
  for (const dir of ['home', 'kimi', 'parley', 'tmp', 'cwd']) mkdirSync(join(root, dir));
  const { server, seen, rejected } = modelFixture();
  const disposals: (() => Promise<void>)[] = [];
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    const launch = launchEnv(root, address.port, false);
    const { kimiTerminalEnv } = await import('../providers/kimi-env.js');
    // Keep the test's allowlisted loopback settings but run the actual production native environment transform.
    const nativeLaunch = { ...launch, env: kimiTerminalEnv(launch.env) } as Launch;
    expect(nativeLaunch.env).not.toHaveProperty('PARLEY_HOME');
    expect(execFileSync(sandbox, [...launch.argv, '--version'], { cwd, env: launch.env, encoding: 'utf8', timeout: limit }).trim()).toBe('2.7.3');
    // An inert ephemeral ACP server proves native did not load the managed attachment. No plugin,
    // dynamic tool selection, hook, credential, or production Parley endpoint is used.
    const mcpTrace = join(root, 'ephemeral-mcp-starts');
    const mcpServers = [{ name: 'parley_fixture', command: process.execPath, env: [], args: ['-e', `
      require('node:fs').appendFileSync(${JSON.stringify(mcpTrace)}, 'ACP\\n');
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params } = JSON.parse(line);
        if (id === undefined) return;
        const result = method === 'initialize' ? {
          protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' },
        } : { tools: [] };
        console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    `] }];

    const cold = startAcp(launch, cwd);
    disposals.push(cold.dispose);
    await cold.rpc('initialize', initialise);
    const { sessionId: emptyId } = await cold.rpc('session/new', { cwd, mcpServers: [] });
    expect(typeof emptyId).toBe('string');
    await cold.exit(emptyId as string);
    const empty = startNative(nativeLaunch, cwd, ['--session', emptyId as string]);
    disposals.push(empty.dispose);
    const trust = await empty.until('fresh disposable cwd trust', /Trust this folder\?/);
    expect(readdirSync(cwd)).toEqual([]);
    expect(trust).toContain('No project integrations or instructions to activate.');
    empty.key('\r');
    await empty.until('unseeded original conversation resumed', new RegExp(emptyId as string));
    await empty.until('unseeded composer ready', ready);
    await empty.exitViaCommand();

    const acp = startAcp(launch, cwd);
    disposals.push(acp.dispose);
    await acp.rpc('initialize', initialise);
    const { sessionId } = await acp.rpc('session/new', { cwd, mcpServers });
    expect(typeof sessionId).toBe('string');
    const id = sessionId as string;
    const chosen = await acp.rpc('session/set_config_option', { sessionId: id, configId: 'mode', value: 'yolo' });
    expect(chosen.configOptions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'mode', currentValue: 'yolo' })]));
    await acp.rpc('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'PROBE_PROMPT_ACP_ORDINARY' }] });
    await wait('managed ephemeral ACP server', () => existsSync(mcpTrace) ? true : undefined);
    const beforeNative = readFileSync(mcpTrace, 'utf8');
    await acp.exit(id);

    const native = startNative(nativeLaunch, cwd, ['--session', id]);
    disposals.push(native.dispose);
    const trustOrReady = await native.until('original cwd trust or resume', /Trust this folder\?|^\s*│ >\s*│\s*$/m);
    if (trustOrReady.includes('Trust this folder?')) {
      expect(readdirSync(cwd)).toEqual([]);
      expect(trustOrReady).toContain('No project integrations or instructions to activate.');
      native.key('\r');
    }
    await native.until('original conversation ready', ready);
    const screen = await native.until('original conversation history visible', new RegExp(id));
    expect(screen).toContain('PROBE_REPLY_ACP_ORDINARY');
    await native.submit('/status');
    const modeScreen = await native.until('provider permission status', /Permissions\s+Ask When Needed/);
    expect(modeScreen).toMatch(/Directory\s+<temp>\/cwd/);
    console.info('Stock native runtime retained Ask When Needed without a launch override.');
    native.key('\x1b');
    await native.until('status dismissed', ready);
    await native.submit('/help');
    await native.until('native keyboard shortcuts', /Keyboard shortcuts/);
    native.key('\x1b');
    await native.until('native help dismissed', ready);
    expect(await native.resize(92, 24)).toEqual([92, 24]);
    await native.submit('PROBE_PROMPT_NATIVE_ORDINARY');
    await native.until('native answer', /PROBE_REPLY_NATIVE_ORDINARY/);
    await native.until('native answer ended', ready);
    await native.submit('/new');
    await native.until('new conversation is distinct', /Session:\s*session_/);
    await wait('original id no longer on screen', () => native.screen().includes(id) ? undefined : true, native.screen);
    await native.submit('PROBE_PROMPT_OTHER_ORDINARY');
    await native.until('new session answered', /PROBE_REPLY_OTHER_ORDINARY/);
    await native.until('new session answer ended', ready);
    await native.exitViaCommand();
    expect(readFileSync(mcpTrace, 'utf8')).toBe(beforeNative);

    const back = startAcp(launch, cwd);
    disposals.push(back.dispose);
    await back.rpc('initialize', initialise);
    const opened = await back.rpc('session/load', { cwd, sessionId: id, mcpServers });
    await wait('managed ephemeral server restored on ACP load', () =>
      readFileSync(mcpTrace, 'utf8') !== beforeNative ? true : undefined);
    // T2 documented that stock ACP can advertise default at open even when actual provider mode differs.
    const reported = (opened.configOptions as { id: string; currentValue: string }[]).find((option) => option.id === 'mode')?.currentValue;
    console.info('Stock ACP opening permission snapshot:', reported);
    expect(['default', 'yolo']).toContain(reported);
    const replay = back.updates.flatMap(({ update }) => update.content?.text ?? []);
    for (const part of ['PROBE_PROMPT_ACP_ORDINARY', 'PROBE_REPLY_ACP_ORDINARY', 'PROBE_PROMPT_NATIVE_ORDINARY', 'PROBE_REPLY_NATIVE_ORDINARY']) {
      expect(replay.join('').split(part)).toHaveLength(2);
    }
    expect(replay.join('')).not.toContain('OTHER_ORDINARY');
    await back.exit(id);
    expect(rejected).toEqual([]);
    expect(seen.map((request) => request.prompt)).toEqual(['ACP_ORDINARY', 'NATIVE_ORDINARY', 'OTHER_ORDINARY']);
    expect(seen.every((request) => request.discovery.length === 0)).toBe(true);
    console.info('Stock 2.7.3: ACP exited → original PTY exited → ACP replay exited. 3 accepted loopback requests, no plugin or permission override.');
  } finally {
    await Promise.allSettled(disposals.map(dispose => dispose()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
