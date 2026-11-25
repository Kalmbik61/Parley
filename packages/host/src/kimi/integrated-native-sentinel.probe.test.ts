import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from 'node-pty';
import { expect, test } from 'vitest';
import { createScreen } from '../pty/screen.js';
import { kimiTerminalEnv } from '../providers/kimi-env.js';
import { createKimiAcp, type KimiMcpServer } from './acp.js';

const bin = '/Users/kalmbik61/.kimi-code/bin/kimi';
const optIn = process.env['PARLEY_KIMI_SENTINEL_BIN'];
const sandbox = '/usr/bin/sandbox-exec';
const model = 'parley-offline-fixture';
const name = 'parley_sentinel';
const tool = `mcp__${name}__handoff_probe`;
const original = 'SENTINEL_ORIGINAL_PROMPT';
const native = 'SENTINEL_NATIVE_PROMPT';
const back = 'SENTINEL_BACK_PROMPT';
const callId = 'sentinel_once';
const ready = /^\s*│ >\s*│\s*$/m;
const poll = { timeout: 10_000, interval: 40 };

test.skipIf(!optIn)('discriminates stock Kimi native sentinel advertisement from dispatch', async () => {
  expect(optIn).toBe(bin);
  expect(process.platform).toBe('darwin');
  const root = realpathSync(mkdtempSync('/tmp/parley-kimi-sentinel-'));
  const cwd = join(root, 'cwd');
  const starts = join(root, 'mcp-starts');
  const requests: { phase: string; offered: boolean; requested: boolean; result: string }[] = [];
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
      const history = JSON.stringify(body.messages.filter((entry: { role: string }) => entry.role === 'user'));
      const phase = [back, native, original].find(marker => history.includes(marker));
      expect(phase).toBeDefined();
      // Advertisement is diagnostic, not an authority assertion. Try the inert sentinel
      // once even if a provider no longer offers its historical schema in native mode.
      const offered = (body.tools ?? []).some((entry: { function: { name: string } }) => entry.function.name === tool);
      const requested = phase === native && !requests.some(entry => entry.requested);
      const result = body.messages.findLast((entry: { role: string; tool_call_id?: string }) => entry.role === 'tool' && entry.tool_call_id === callId)?.content;
      requests.push({ phase: phase!, offered, requested, result: result === undefined ? '' : JSON.stringify(result).slice(0, 500) });
      const delta = requested ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: tool, arguments: '{}' } }] }
        : { content: `${phase}_REPLY` };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-sentinel', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(frame({ role: 'assistant', ...delta }, null));
      res.end(frame({}, requested ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      rejected.push(String(error));
      res.writeHead(400).end();
    }
  });
  const disposals: (() => Promise<void>)[] = [];
  function lines(path: string): string[] {
    return existsSync(path) ? readFileSync(path, 'utf8').trimEnd().split('\n') : [];
  }
  const events = (phase: string) => lines(join(root, `lease-${phase}.events`)).map(line => JSON.parse(line));
  try {
    for (const sub of ['home', 'kimi', 'tmp', 'cwd']) mkdirSync(join(root, sub));
    for (const file of ['binding.cjs', 'mcp.cjs']) copyFileSync(new URL(`./fixtures/native/${file}`, import.meta.url), join(root, file));
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected model loopback port');
    const executable = realpathSync(bin);
    const node = realpathSync(process.execPath);
    const profile = join(root, 'sandbox.sb');
    // Like the existing stock probe, allow only the synthetic model port and deny real home data.
    writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${address.port}"))
(deny file-read-data (subpath "/Users/kalmbik61"))
(deny file-write* (subpath "/Users/kalmbik61"))
(allow file-read-data (literal ${JSON.stringify(executable)}) (literal ${JSON.stringify(node)}))
`);
    const args = ['-f', profile, executable];
    const env = {
      HOME: join(root, 'home'), KIMI_CODE_HOME: join(root, 'kimi'), TMPDIR: join(root, 'tmp'),
      PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
      KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'probe-not-a-secret',
      KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    expect(execFileSync(sandbox, [...args, '--version'], { cwd, env, encoding: 'utf8', timeout: 8000 }).trim()).toBe('2.7.3');
    function attachment(phase: 'initial' | 'restored'): KimiMcpServer[] {
      const lease = join(root, `lease-${phase}`);
      writeFileSync(lease, JSON.stringify({ generation: phase, label: phase, revoked: false, grant: true }), { mode: 0o600 });
      return [{ type: 'stdio', name, command: node,
        args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(starts)}, ${JSON.stringify(phase + '\n')}); require(${JSON.stringify(join(root, 'mcp.cjs'))});`],
        env: [{ name: 'PROBE_LEASE', value: lease }, { name: 'PROBE_GENERATION', value: phase }],
      }];
    }
    const first = createKimiAcp({ command: sandbox, args: [...args, 'acp'], cwd, env, mcpServers: attachment('initial') });
    disposals.push(first.close);
    const id = await first.connect();
    expect(id).toMatch(/^session_/);
    await first.setConfig('mode', 'yolo');
    expect(await first.prompt(original)).toBe('end_turn');
    await first.close();
    expect(lines(starts)).toEqual(['initial']);
    expect(events('initial')).toEqual([expect.objectContaining({ event: 'tools/list', allowed: true })]);

    const screen = createScreen(116, 30);
    const terminal = pty.spawn(sandbox, [...args, '--session', id], { cwd, env: kimiTerminalEnv(env), name: 'xterm-256color', cols: 116, rows: 30 });
    let exited = false;
    const exit = new Promise<number>(resolve => terminal.onExit(event => { exited = true; resolve(event.exitCode); }));
    const output = terminal.onData(data => screen.write(data));
    disposals.push(async () => {
      if (!exited) terminal.kill('SIGKILL');
      await exit;
      output.dispose();
      screen.dispose();
    });
    const view = () => screen.text().join('\n');
    async function submit(text: string) {
      terminal.write(`\x1b[200~${text}\x1b[201~`);
      await expect.poll(view, poll).toContain(text);
      await delay(150);
      terminal.write('\r');
    }
    await expect.poll(view, poll).toMatch(/Trust this folder\?|^\s*│ >\s*│\s*$/m);
    if (view().includes('Trust this folder?')) {
      expect(view()).toContain('No project integrations or instructions to activate.');
      expect(view()).toMatch(/❯ Trust and continue/);
      expect(readdirSync(cwd)).toEqual([]);
      terminal.write('\r');
    }
    await expect.poll(view, poll).toMatch(ready);
    await expect.poll(view, poll).toContain(id);
    await submit(native);
    const approval = new RegExp(`Approve ${tool}\\?`);
    await expect.poll(view, poll).toMatch(new RegExp(`${native}_REPLY|${approval.source}`));
    if (approval.test(view())) {
      expect(view()).toMatch(/▶ 1\. Approve once/);
      terminal.write('1'); // The only approved call is this one temporary sentinel.
    }
    await expect.poll(view, poll).toContain(`${native}_REPLY`);
    await expect.poll(view, poll).toMatch(ready);
    await submit('/exit');
    await expect.poll(() => exited, poll).toBe(true);
    expect(await exit).toBe(0);
    const nativeStarts = lines(starts).slice(1);
    const nativeCalls = events('initial').filter(event => event.event === 'tools/call');
    const nativeRequests = requests.filter(entry => entry.phase === native);
    console.info('Native sentinel evidence:', { nativeStarts, nativeCalls, nativeRequests });

    const replay: string[] = [];
    const restored = createKimiAcp({ command: sandbox, args: [...args, 'acp'], cwd, env, mcpServers: attachment('restored'), sessionId: id,
      loadHistory: true, requireHistory: true, onText: (text, history) => { if (history) replay.push(text); },
    });
    disposals.push(restored.close);
    expect(await restored.connect()).toBe(id);
    const replayText = replay.join('');
    for (const marker of [`${original}_REPLY`, `${native}_REPLY`]) expect(replayText.split(marker)).toHaveLength(2);
    const withoutReplies = replayText.replace(`${original}_REPLY`, '').replace(`${native}_REPLY`, '');
    for (const marker of [original, native]) expect(withoutReplies.split(marker)).toHaveLength(2);
    expect(await restored.prompt(back)).toBe('end_turn');
    await restored.close();
    expect(lines(starts).filter(phase => phase === 'restored')).toEqual(['restored']);
    expect(events('restored')).toEqual([expect.objectContaining({ event: 'tools/list', allowed: true })]);
    expect(rejected).toEqual([]);
    expect(requests.map(entry => entry.phase)).toEqual([original, native, native, back]);
    expect(nativeRequests.filter(entry => entry.requested)).toHaveLength(1);
    expect(nativeRequests[1]?.result).toMatch(/Tool .*not found/);
    expect(nativeStarts).toEqual([]);
    expect(nativeCalls).toEqual([]);
    expect(requests.find(entry => entry.phase === back)?.offered).toBe(true);
    console.info('Sentinel server startup, tools/list, and advertisement restored on exact-ID ACP handback.');
  } finally {
    await Promise.allSettled(disposals.map(dispose => dispose()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 70_000);
