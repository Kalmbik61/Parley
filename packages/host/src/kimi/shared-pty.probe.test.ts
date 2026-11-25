import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from 'node-pty';
import { expect, test } from 'vitest';
import { createScreen } from '../pty/screen.js';

const bin = '/Users/kalmbik61/.kimi-code/bin/kimi';
const optIn = process.env['PARLEY_KIMI_SHARED_PTY_BIN'];
const sandbox = '/usr/bin/sandbox-exec';
const model = 'parley-offline-fixture';
const pluginName = 'parley-shared-pty-probe';
const tool = `mcp__plugin-${pluginName}_fixture__handoff_probe`;
const ready = /^\s*│ >\s*│\s*$/m;
const working = /Working for \d/;
const modal = /▶ 1\. Approve once|^\s*\? Which synthetic marker\?|Ready to submit your answers\?/m;
const limit = 8_000;

type Wire = { type: string; [key: string]: unknown };
type Hook = { hook_event_name: string; session_id: string; [key: string]: unknown };
type Request = {
  messages: { role: string; content: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[];
  tools?: { function: { name: string; parameters?: unknown } }[];
  model: string;
  stream: boolean;
};

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  // shortcut: reread the whole tiny fixture, use a byte cursor for real transcripts.
  return readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
}

async function until<T>(label: string, check: () => T | undefined, details = () => ''): Promise<T> {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const result = check();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(`${label} timed out\n${details().slice(-2300)}`);
}

test.skipIf(!optIn)('stock Kimi shares a native PTY, transcript, and local plugin between two input paths', async () => {
  expect(optIn).toBe(bin);
  expect(process.platform).toBe('darwin');
  const root = realpathSync(mkdtempSync('/tmp/parley-kimi-shared-'));
  const cwd = join(root, 'cwd');
  const home = join(root, 'kimi');
  const hooksPath = join(root, 'hooks.jsonl');
  const lease = join(root, 'lease');
  const hooks = () => readJsonl<Hook>(hooksPath);
  const mcp = () => readJsonl<{ event: string; allowed: boolean }>(lease + '.events');
  const requests: { phase: string; body: Request; deltas: unknown[]; finish: string }[] = [];
  const rejected: string[] = [];
  const screens: Record<string, string> = {};
  const evidence: Record<string, unknown> = {};
  const disposals: (() => Promise<void>)[] = [];
  const ids: string[] = [];
  let compacting: 'COMPACT_A' | 'COMPACT_B' | undefined;
  let releaseFirst = () => {};
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  const server = createServer(async (req, res) => {
    try {
      expect([req.method, req.url, req.headers.authorization]).toEqual(['POST', '/v1/chat/completions', 'Bearer probe-not-a-secret']);
      let input = '';
      for await (const chunk of req) {
        input += chunk;
        expect(input.length).toBeLessThan(512_000);
      }
      const body: Request = JSON.parse(input);
      expect([body.model, body.stream]).toEqual([model, true]);
      const phase = compacting ?? [...JSON.stringify(body.messages).matchAll(/SHARED_PROMPT_([A-Z]+)/g)].at(-1)?.[1];
      if (!phase) throw new Error('No synthetic phase');
      const calls = body.messages.flatMap(entry => entry.tool_calls ?? []);
      function call(id: string, name: string, args = {}) {
        return { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      let toolDelta;
      if (['RAW', 'NEW'].includes(phase)) {
        const steps = phase === 'RAW' ? ['reject', 'approve'] : ['new'];
        const step = steps.find(step => !calls.some(({ id }) => id === `shared_${step}`));
        if (step) {
          // RAW is the dispatch-only control. NEW must discover the tool in the request.
          const offered = body.tools?.find(t => t.function.name === tool)?.function;
          if (phase !== 'RAW') expect(offered?.parameters).toEqual({ type: 'object', properties: {} });
          toolDelta = call(`shared_${step}`, offered?.name ?? tool);
        }
      }
      if (phase === 'ASK' && !calls.some(({ id }) => id === 'shared_ask')) {
        const ask = body.tools?.find(entry => /ask.?user.?question/i.test(entry.function.name))?.function;
        if (!ask) throw new Error('No native question tool: ' + body.tools?.map(entry => entry.function.name).join(','));
        toolDelta = call('shared_ask', ask.name, { questions: [{
          question: 'Which synthetic marker?', header: 'Marker', multi_select: false,
          options: [{ label: 'ALPHA', description: 'First fixture value' }, { label: 'BETA', description: 'Second fixture value' }],
        }] });
      }
      const deltas = toolDelta ? [toolDelta] : compacting ? [{ content: `SHARED_${compacting}_SUMMARY` }]
        : [{ content: 'SHARED_REPLY_' }, { content: phase }];
      const finish = toolDelta ? 'tool_calls' : 'stop';
      requests.push({ phase, body, deltas, finish });
      const frame = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-shared', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame({ role: 'assistant', ...deltas[0] }, null));
      if (phase === 'CHAT') await firstReleased;
      for (const delta of deltas.slice(1)) res.write(frame(delta, null));
      res.end(frame({}, finish) + 'data: [DONE]\n\n');
    } catch (error) {
      rejected.push(String(error));
      res.writeHead(400).end();
    }
  });

  function safe(text: string) {
    for (const [index, id] of ids.entries()) text = text.replaceAll(id, `session_${'ABCD'[index]}`);
    return text.replaceAll(root, '<temp>').replaceAll(root.replace('/private', ''), '<temp>')
      .replace(/(approval|question)_[a-f\d-]+/g, '$1_<id>');
  }

  let stage = 'loopback and fixture';
  try {
    const plugin = join(root, 'plugin');
    for (const dir of ['home', 'kimi', 'parley', 'tmp', 'cwd', 'plugin']) mkdirSync(join(root, dir));
    for (const file of ['binding.cjs', 'mcp.cjs']) copyFileSync(new URL(`./fixtures/native/${file}`, import.meta.url), join(plugin, file));
    copyFileSync(new URL('./fixtures/shared-pty/hook.cjs', import.meta.url), join(plugin, 'hook.cjs'));
    writeFileSync(join(plugin, 'kimi.plugin.json'), JSON.stringify({
      name: pluginName, version: '0.0.0', description: 'Inert shared PTY fixture', systemPrompt: 'SHARED_PTY_PLUGIN_RULES',
      mcpServers: { fixture: { command: 'node', args: ['./mcp.cjs'], cwd: './', deferred: false } },
      hooks: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'UserPromptQueued', 'TurnStarted', 'Stop', 'StopFailure',
        'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionResult', 'PreCompact', 'PostCompact',
      ].map(event => ({ event, command: 'node ./hook.cjs', timeout: 3 })),
    }));
    writeFileSync(lease, JSON.stringify({ generation: 'shared', label: 'SHARED', revoked: false, grant: false }), { mode: 0o600 });

    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    const { port } = address;
    const profile = join(root, 'sandbox.sb');
    const executable = realpathSync(bin);
    const node = realpathSync(process.execPath);
    // Same loopback-only Seatbelt isolation as the native handoff probe.
    writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
(deny file-read-data (subpath "/Users/kalmbik61"))
(deny file-write* (subpath "/Users/kalmbik61"))
(allow file-read-data (literal ${JSON.stringify(executable)}) (literal ${JSON.stringify(node)}))
`);
    const argv = ['-f', profile, executable];
    const env = {
      HOME: join(root, 'home'), KIMI_CODE_HOME: home, PARLEY_HOME: join(root, 'parley'),
      TMPDIR: join(root, 'tmp'), PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
      KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'probe-not-a-secret',
      KIMI_MODEL_CAPABILITIES: 'tool_use',
      KIMI_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, SHARED_PTY_HOOKS: hooksPath,
      PROBE_LEASE: lease, PROBE_GENERATION: 'shared',
    };
    expect(execFileSync(sandbox, [...argv, '--version'], { cwd, env, timeout: limit, encoding: 'utf8' }).trim()).toBe('2.7.3');

    function startNative(args: string[] = []) {
      const screen = createScreen(116, 30);
      const child = pty.spawn(sandbox, [...argv, ...args], { cwd, env, name: 'xterm-256color', cols: 116, rows: 30 });
      let exitCode: number | undefined;
      let frames = 0;
      let ansi = false;
      const exit = new Promise<number>(resolve => child.onExit(({ exitCode: code }) => { exitCode = code; resolve(code); }));
      const output = child.onData(data => { ansi ||= /\x1b\[/.test(data); frames++; screen.write(data); });
      const view = () => screen.text().join('\n');
      const visible = (label: string, pattern: RegExp) => until(label, () => {
        if (exitCode !== undefined) throw new Error(`Kimi exited: ${exitCode}`);
        const text = view();
        return pattern.test(text) ? text : undefined;
      }, () => safe(view()));
      const key = (input: string) => child.write(input);
      async function submit(text: string, source: 'chat' | 'raw' = 'chat') {
        if (source === 'chat' && (!ready.test(view()) || working.test(view()) || modal.test(view()))) return false;
        // Same native paste/Enter separation as native-handoff. Raw input emulates typing.
        key(source === 'chat' ? `\x1b[200~${text}\x1b[201~` : text);
        const typed = text.slice(-30).replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&');
        await visible('echo before Enter', new RegExp(typed));
        await delay(150);
        key('\r');
        return true;
      }
      disposals.push(async () => {
        if (exitCode === undefined) child.kill('SIGKILL');
        await until('PTY cleanup', () => exitCode);
        output.dispose();
        screen.dispose();
      });
      return { pid: child.pid, key, submit, view, visible, ansi: () => ansi, async resize(cols: number, rows: number) {
        const before = frames;
        screen.resize(cols, rows);
        child.resize(cols, rows);
        await until('PTY resize repaint', () => frames > before ? true : undefined);
        expect([child.cols, child.rows]).toEqual([cols, rows]);
      }, async close() {
        await visible('composer before /exit', ready);
        expect(await submit('/exit')).toBe(true);
        await until('PTY exit', () => exitCode, view);
        expect(await exit).toBe(0);
      } };
    }

    stage = 'local plugin install';
    const installer = startNative();
    const trust = await installer.visible('temporary empty workspace trust', /Trust this folder\?/);
    expect(trust).toContain(cwd);
    expect(trust).toContain('No project integrations or instructions to activate.');
    expect(trust).toMatch(/❯ Trust and continue/);
    expect(readdirSync(cwd)).toEqual([]);
    installer.key('\r');
    await installer.visible('installer composer', ready);
    expect(await installer.submit(`/plugins install ${plugin}`)).toBe(true);
    const installPrompt = await installer.visible('exact local plugin confirmation', /Install third-party plugin/);
    expect(installPrompt).toContain(plugin);
    installer.key('\x1b[B');
    await installer.visible('local install choice', /❯ Trust and install/);
    installer.key('\r');
    await installer.visible('plugin installed', /(?:installed|installation succeeded).*parley-shared-pty-probe|parley-shared-pty-probe.*installed/i);
    await installer.close();
    const hookOffset = hooks().length;
    const listOffset = mcp().filter(e => e.event === 'tools/list').length;
    const sessionHook = (id?: string) => hooks().slice(hookOffset).filter(h => h.hook_event_name === 'SessionStart' && (!id || h.session_id === id));
    const wirePath = (id: string) => {
      // Node types allow Buffer only if an encoding other than UTF-8 is requested.
      const found = readdirSync(join(home, 'sessions'), { recursive: true, encoding: 'utf8' })
        .find(file => file.endsWith(`/${id}/agents/main/wire.jsonl`));
      return found ? join(home, 'sessions', found) : undefined;
    };
    const wire = (id: string) => {
      const path = wirePath(id);
      return path ? readJsonl<Wire>(path) : [];
    };
    const pickWire = (id: string) => {
      const records = wire(id).filter(r => /^(metadata|turn\.|context\.|interaction\.|permission\.record|prompt\.completed|full_compaction\.|mcp\.tools)/.test(r.type));
      const samples = new Map<string, Wire>();
      for (const r of records) {
        const detail = r.type === 'context.append_message' ? (r.message as { role: string }).role
          : r.type === 'context.append_loop_event' ? (r.event as Wire).type : r.type === 'interaction.request' ? r.kind : '';
        const key = detail ? `${r.type}:${detail}` : r.type;
        if (!samples.has(key)) samples.set(key, r);
      }
      return [...samples].map(([name, sample]) => [name, JSON.stringify(sample).slice(0, 650)]);
    };
    const observe = (name: string, text: string, pattern: RegExp) => {
      screens[name] = text.split('\n').filter(line => pattern.test(line)).join('\n');
    };

    stage = 'native from creation, help and resize';
    const cli = startNative();
    await cli.visible('startup composer', ready);
    expect(cli.view()).toContain('No session yet');
    expect(sessionHook()).toEqual([]);
    expect(cli.ansi()).toBe(true);
    expect(await cli.submit('/help')).toBe(true);
    observe('help 116x30', await cli.visible('native help', /Keyboard shortcuts|Slash commands/i), /help|shortcuts|slash commands/i);
    cli.key('\x1b');
    await cli.visible('Escape exits help', ready);
    await cli.resize(102, 26);
    observe('resize 102x26', await cli.visible('resized composer', ready), /Session:|│ >/);
    await until('fixture MCP listed before first input', () => mcp().filter(e => e.event === 'tools/list').length > listOffset ? true : undefined);
    const pid = cli.pid;
    const nativePid = () => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: limit }).trim();
    expect(nativePid()).toBe('kimi-code');

    stage = 'Chat and raw Terminal on one process';
    expect(await cli.submit('SHARED_PROMPT_CHAT')).toBe(true);
    const a = await until('first message allocates provider id', () => sessionHook()[0]?.session_id, cli.view);
    ids.push(a);
    expect(a).toMatch(/^session_/);
    await until('first streamed chunk', () => requests.find(r => r.phase === 'CHAT'), cli.view);
    const busy = await cli.visible('busy stream', working);
    expect(busy).toMatch(ready); // Kimi accepts drafts while the model is busy.
    evidence['beforeFirstBlockCloses'] = pickWire(a).map(([key]) => key);
    const streamed = () => wire(a).filter(r => r.type === 'context.append_loop_event' && (r.event as Wire).type === 'content.part');
    expect(busy).toContain('SHARED_REPLY_');
    expect(streamed()).toEqual([]);
    observe('busy', busy, /SHARED_REPLY_|working|thinking|esc to/i);
    expect(await cli.submit('SHARED_PROMPT_BLOCKED')).toBe(false);
    releaseFirst();
    await cli.visible('Chat reply', /SHARED_REPLY_CHAT/);
    await cli.visible('ready again', ready);
    expect(await cli.submit('SHARED_PROMPT_RAW', 'raw')).toBe(true);
    for (const choice of ['reject', 'session']) {
      const approval = await cli.visible('native fixture permission', new RegExp(`Approve ${tool}\\?`));
      expect(approval).toMatch(/▶ 1\. Approve once/);
      observe('permission', approval, /Approve |Reject|Deny/i);
      expect(await cli.submit('SHARED_PROMPT_BLOCKED')).toBe(false);
      const rejectKey = approval.match(/(\d)\. (?:Reject|Deny)/i)?.[1];
      expect(rejectKey).toBeDefined();
      expect(approval).toMatch(/2\. Approve for this session/);
      cli.key(choice === 'reject' ? rejectKey! : '2');
      if (choice === 'reject') await until('rejected call returned to model', () => requests.find(r => r.body.messages.some(m => m.tool_call_id === 'shared_reject')), cli.view);
    }
    await cli.visible('Terminal reply', /SHARED_REPLY_RAW/);
    await cli.visible('ready after permission turn', ready);
    expect([cli.pid, sessionHook().length]).toEqual([pid, 1]);
    expect(nativePid()).toBe('kimi-code');
    const raw = requests.filter(r => r.phase === 'RAW');
    const lazy = requests.find(r => r.phase === 'RAW')?.body;
    expect(lazy?.tools?.some(t => t.function.name === tool)).toBe(false);
    expect(JSON.stringify(lazy?.messages)).not.toContain(tool);
    expect(wire(a).some(r => r.type === 'mcp.tools_discovered' && JSON.stringify(r).includes('TOOL_SHARED'))).toBe(true);
    expect(JSON.stringify(raw[0]?.body.messages)).toContain('SHARED_PTY_FIXTURE_RULES');
    expect(JSON.stringify(raw[0]?.body.messages)).toContain('SHARED_PTY_PLUGIN_RULES');
    expect(JSON.stringify(raw.at(-1)?.body.messages.find(m => m.tool_call_id === 'shared_approve'))).toContain('RESULT_SHARED');
    expect(mcp().filter(e => e.event === 'tools/call')).toEqual([expect.objectContaining({ allowed: true })]);

    stage = 'native elicitation';
    expect(await cli.submit('SHARED_PROMPT_ASK')).toBe(true);
    const question = await cli.visible('synthetic question', /Which synthetic marker\?/);
    observe('elicitation', question, /marker|ALPHA|BETA|confirm|submit/i);
    expect(await cli.submit('SHARED_PROMPT_BLOCKED')).toBe(false);
    cli.key('\r');
    const review = await cli.visible('native question submit review', /Ready to submit your answers\?/);
    expect(review).toMatch(/→\s+ALPHA/);
    expect(review).toMatch(/→ \[1\] Submit/);
    cli.key('\r');
    await cli.visible('question turn reply', /SHARED_REPLY_ASK/);
    await cli.visible('ready after question', ready);
    expect(JSON.stringify(requests.findLast(r => r.phase === 'ASK')?.body.messages.find(m => m.tool_call_id === 'shared_ask'))).toContain('ALPHA');

    async function compact(id: string, phase: NonNullable<typeof compacting>) {
      stage = phase;
      compacting = phase;
      expect(await cli.submit('/compact', 'raw')).toBe(true);
      await until('successful PostCompact hook', () => hooks().find(h => h.hook_event_name === 'PostCompact' && h.session_id === id), cli.view);
      const complete = await cli.visible('native compaction complete', /Compaction complete/);
      observe(phase, complete, /Compaction complete/);
      await cli.visible('composer after compact', ready);
      compacting = undefined;
      expect(requests.filter(r => r.phase === phase)).toHaveLength(1);
      expect(wire(id)).toContainEqual(expect.objectContaining({ type: 'context.apply_compaction', summary: `SHARED_${phase}_SUMMARY` }));
    }
    await compact(a, 'COMPACT_A');

    stage = 'new provider id on same process';
    expect(await cli.submit('/new', 'raw')).toBe(true);
    const b = await until('new-session provider id', () => sessionHook().find(h => h.session_id !== a)?.session_id, cli.view);
    ids.push(b);
    expect(b).toMatch(/^session_/);
    expect(cli.pid).toBe(pid);
    expect(nativePid()).toBe('kimi-code');
    await cli.visible('new native viewport', new RegExp(b));
    await cli.visible('new composer', ready);
    expect(await cli.submit('SHARED_PROMPT_NEW')).toBe(true);
    await cli.visible('new session permission', new RegExp(`Approve ${tool}\\?`));
    cli.key('1');
    await cli.visible('new reply', /SHARED_REPLY_NEW/);
    expect(JSON.stringify(requests.find(r => r.phase === 'NEW')?.body.messages)).not.toMatch(/SHARED_(PROMPT_CHAT|PROMPT_RAW|COMPACT_A_SUMMARY)/);
    expect(JSON.stringify(requests.findLast(r => r.phase === 'NEW')?.body.messages)).toContain('RESULT_SHARED');
    await compact(b, 'COMPACT_B');
    await cli.close();

    stage = 'exact native resume';
    const resumed = startNative(['--session', a]);
    await until('resume provider id and source', () => sessionHook(a).find(h => h.source === 'resume'), resumed.view);
    await resumed.visible('resume composer', ready);
    await resumed.visible('replayed native history', /SHARED_REPLY_ASK/);
    expect(resumed.pid).not.toBe(pid);
    expect(await resumed.submit('SHARED_PROMPT_RESUME')).toBe(true);
    await resumed.visible('resume reply', /SHARED_REPLY_RESUME/);
    expect(JSON.stringify(requests.find(r => r.phase === 'RESUME')?.body.messages)).toContain('SHARED_COMPACT_A_SUMMARY');
    await resumed.close();

    stage = 'explicit native /new before first user turn';
    const prepared = startNative();
    await prepared.visible('fresh composer', ready);
    expect(prepared.view()).toContain('No session yet');
    expect(await prepared.submit('/new')).toBe(true);
    const c = await until('explicit /new allocates before user prompt', () => sessionHook().find(h => h.session_id !== a && h.session_id !== b)?.session_id, prepared.view);
    ids.push(c);
    await prepared.visible('explicit session viewport', new RegExp(c));
    await prepared.visible('fresh /new reports its MCP connection', /connected · 1 tool \(stdio\)/);
    await prepared.visible('explicit session composer', ready);
    expect(await prepared.submit('SHARED_PROMPT_PREPARED')).toBe(true);
    await prepared.visible('explicit session reply', /SHARED_REPLY_PREPARED/);
    expect(requests.find(r => r.phase === 'PREPARED')?.body.tools?.some(t => t.function.name === tool)).toBe(false);
    await prepared.close();

    stage = 'create and close a fresh ID without a model turn';
    const requestOffset = requests.length;
    const listingCount = () => mcp().filter(e => e.event === 'tools/list' && e.allowed).length;
    const initialListings = listingCount();
    const empty = startNative();
    await empty.visible('fresh composer before no-turn creation', ready);
    expect(empty.view()).toContain('No session yet');
    expect(await empty.submit('/new')).toBe(true);
    const d = await until('new empty provider ID', () => sessionHook().find(h => !ids.includes(h.session_id))?.session_id, empty.view);
    ids.push(d);
    await empty.visible('empty session MCP connected', /connected · 1 tool \(stdio\)/);
    expect(listingCount()).toBeGreaterThan(initialListings);
    const discovery = await until('persisted MCP discovery before any prompt', () => wire(d).find(r => r.type === 'mcp.tools_discovered' && JSON.stringify(r).includes('TOOL_SHARED')), empty.view);
    await empty.close();
    expect(requests).toHaveLength(requestOffset);
    expect(wire(d).some(r => r.type === 'turn.prompt')).toBe(false);
    expect(hooks().some(h => h.session_id === d && h.hook_event_name === 'UserPromptSubmit')).toBe(false);

    stage = 'first model turn after exact native resume of empty ID';
    const emptyResumed = startNative(['--session', d]);
    await until('resume empty ID', () => sessionHook(d).find(h => h.source === 'resume'), emptyResumed.view);
    await emptyResumed.visible('resumed empty session composer', ready);
    expect(emptyResumed.pid).not.toBe(empty.pid);
    expect(await emptyResumed.submit('SHARED_PROMPT_EMPTYRESUME')).toBe(true);
    await emptyResumed.visible('first reply on resumed empty ID', /SHARED_REPLY_EMPTYRESUME/);
    expect(requests).toHaveLength(requestOffset + 1);
    const firstOnEmpty = requests[requestOffset];
    expect(firstOnEmpty?.phase).toBe('EMPTYRESUME');
    expect(JSON.stringify(firstOnEmpty?.body.messages)).toContain('SHARED_PTY_PLUGIN_RULES');
    expect(firstOnEmpty?.body.tools?.some(t => t.function.name === tool)).toBe(false);
    evidence['emptyResume'] = { discovery, setupModelRequests: 0,
      advertisedOnFirstResume: false };
    await emptyResumed.close();

    stage = 'wire and exact-once records';
    for (const [id, phases] of [[a, ['CHAT', 'RAW', 'ASK', 'RESUME']], [b, ['NEW']], [c, ['PREPARED']], [d, ['EMPTYRESUME']]] as const) {
      expect(wirePath(id)).toContain(`/${id}/agents/main/wire.jsonl`);
      const records = wire(id);
      expect(records[0]).toEqual(expect.objectContaining({ type: 'metadata', protocol_version: '1.5' }));
      const appended = records.filter(r => r.type === 'context.append_message').map(r => r.message as { role: string; content: unknown });
      const chunks = records.filter(r => r.type === 'context.append_loop_event').map(r => r.event as Wire);
      for (const phase of phases) {
        expect(appended.filter(m => m.role === 'user' && JSON.stringify(m.content).includes(`SHARED_PROMPT_${phase}`))).toHaveLength(1);
        expect(chunks.filter(e => e.type === 'content.part' && JSON.stringify(e.part).includes(`SHARED_REPLY_${phase}`))).toHaveLength(1);
        expect(hooks().filter(h => h.session_id === id && h.hook_event_name === 'UserPromptSubmit' && JSON.stringify(h.prompt)?.includes(`SHARED_PROMPT_${phase}`))).toHaveLength(1);
      }
      expect(JSON.stringify(records)).not.toContain('SHARED_PROMPT_BLOCKED');
    }
    expect(requests.map(r => r.phase)).toEqual(['CHAT', 'RAW', 'RAW', 'RAW', 'ASK', 'ASK', 'COMPACT_A', 'NEW', 'NEW', 'COMPACT_B', 'RESUME', 'PREPARED', 'EMPTYRESUME']);
    expect(mcp().filter(e => e.event === 'tools/call')).toEqual([expect.objectContaining({ allowed: true }), expect.objectContaining({ allowed: true })]);
    expect(rejected).toEqual([]);
    const compactRequests = requests.filter(r => r.phase.startsWith('COMPACT_'));
    expect(compactRequests.map(({ body }) => body.tools?.find(t => t.function.name === tool)?.function.parameters)).toEqual([
      undefined, { type: 'object', properties: {} },
    ]);
    const interactionRows = wire(a).filter(r => ['interaction.request', 'interaction.resolved'].includes(r.type));
    const questionRequest = interactionRows.find(r => r.kind === 'question' && r.toolCallId === 'shared_ask');
    expect(questionRequest?.id).toMatch(/^question_/);
    const questionResponse = interactionRows.find(r => r.type === 'interaction.resolved' && r.id === questionRequest?.id);
    expect(questionResponse?.response).toEqual({ answers: { 'Which synthetic marker?': 'ALPHA' }, method: 'enter' });
    console.info(safe(JSON.stringify({
      screens, evidence, wirePaths: ids.map(wirePath), wire: pickWire(a),
      questionResponse: questionResponse?.response,
      discovery: ['CHAT', 'RAW', 'NEW', 'RESUME', 'PREPARED'].map(phase => ({ phase, advertised: requests.find(r => r.phase === phase)?.body.tools?.some(t => t.function.name === tool) })),
      hookTypes: [...new Set(hooks().map(h => h.hook_event_name))], requests: requests.map(r => r.phase),
      compactHooks: hooks().filter(h => h.hook_event_name.endsWith('Compact')).map(({ hook_event_name, session_id, trigger, token_count, estimated_token_count }) => ({ hook_event_name, session_id, trigger, token_count, estimated_token_count })),
      compact: compactRequests.map(({ phase, body, deltas, finish }) => ({ phase, keys: Object.keys(body), messages: body.messages.map(m => ({ role: m.role, sample: JSON.stringify(m.content)?.slice(0, 180) })), tools: body.tools?.map(t => t.function.name) ?? [], deltas, finish })),
    }, null, 2)));
  } catch (error) {
    console.info(safe(JSON.stringify({ stage, screens, evidence, rejected, requests: requests.map(r => r.phase), hooks: hooks().slice(-10), mcp: mcp() }, null, 2)));
    throw error;
  } finally {
    releaseFirst();
    await Promise.allSettled(disposals.map(dispose => dispose()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
