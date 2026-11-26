import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node-pty';
import { expect, test } from 'vitest';
import { REF, fakeFeedDeps } from '../../test/feed-fakes.js';
import { createFeedService } from '../feed/feed-service.js';
import { createScreen } from '../pty/screen.js';
import { KIMI_ENTER_DELAY_MS } from '../pty/send.js';
import { KIMI_QUEUE_KEY, KIMI_STEER_KEY, kimiComposer, kimiSelectiveSteerKey } from './native-screen.js';
import { projectKimiWire } from './native-wire.js';

const optIn = process.env['PARLEY_KIMI_STEERING_PROBE'];
const sandbox = '/usr/bin/sandbox-exec';
const initial = 'PARLEY_FIXTURE_INITIAL';
const steered = 'PARLEY_FIXTURE_STEER';
const model = 'parley-fixture';
const older = 'PARLEY_FIXTURE_OLDER_QUEUE';

test.skipIf(!optIn).each(['plain', 'queue', 'steer'] as const)('stock Kimi begins processing only the selected steer while the first request is held (%s)', async (mode) => {
  if (!optIn || !isAbsolute(optIn)) throw new Error('PARLEY_KIMI_STEERING_PROBE must be an absolute Kimi binary path');
  expect(process.platform).toBe('darwin');
  const root = realpathSync(mkdtempSync('/tmp/parley-kimi-steer-'));
  const cwd = join(root, 'cwd');
  const home = join(root, 'kimi');
  let release = () => {};
  let releaseSteer = () => {};
  let firstReleased = false;
  const held = new Promise<void>(resolve => {
    release = () => { firstReleased = true; resolve(); };
  });
  const heldSteer = new Promise<void>(resolve => { releaseSteer = resolve; });
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.stringify(JSON.parse(body).messages);
    requests.push(messages);
    const ordinal = requests.length;
    const frame = (delta: object, finish: string | null) =>
      'data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame({ role: 'assistant', content: 'PARLEY_FIXTURE_REPLY' }, null));
    if (ordinal === 1) await held;
    if (ordinal === 2 && mode !== 'plain') await heldSteer;
    res.end(frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  const screen = createScreen(116, 30);
  let child: ReturnType<typeof spawn> | undefined;
  let exit: Promise<unknown> | undefined;
  try {
    for (const dir of ['cwd', 'home', 'kimi', 'tmp', 'parley']) mkdirSync(join(root, dir));
    if (mode !== 'plain') writeFileSync(join(home, 'tui.toml'), `follow_up_behavior = "${mode}"
`);
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    const profile = join(root, 'sandbox.sb');
    const executable = realpathSync(optIn);
    // Vitest sets HOME to a throwaway directory. Protect the OS account's
    // home, not the fixture's, even when the opt-in path traverses a symlink.
    const protectedHome = realpathSync(userInfo().homedir);
    writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${address.port}"))
(deny file-read-data (subpath ${JSON.stringify(protectedHome)}))
(deny file-write* (subpath ${JSON.stringify(protectedHome)}))
(allow file-read-data (literal ${JSON.stringify(executable)}))
`);
    const args = ['-f', profile, executable];
    const env = {
      HOME: join(root, 'home'), KIMI_CODE_HOME: home, PARLEY_HOME: join(root, 'parley'), TMPDIR: join(root, 'tmp'),
      TERM: 'xterm-256color', PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8',
      KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'not-a-secret',
      KIMI_MODEL_CAPABILITIES: 'tool_use', KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    const version = execFileSync(sandbox, [...args, '--version'], { cwd, env, encoding: 'utf8', timeout: 5_000 }).trim();
    expect(['2.7.3', '2.8.0']).toContain(version);
    const terminal = spawn(sandbox, args, { cwd, env, name: 'xterm-256color', cols: 116, rows: 30 });
    child = terminal;
    let dead = false;
    exit = new Promise(resolve => terminal.onExit(event => { dead = true; resolve(event); }));
    terminal.onData(data => screen.write(data));
    const view = () => screen.text().join('\n');
    function wire(): { type: string; [key: string]: unknown }[] {
      try {
        const paths = readdirSync(join(home, 'sessions'), { recursive: true, encoding: 'utf8' });
        const file = paths.find(path => path.endsWith('/agents/main/wire.jsonl'));
        return file === undefined ? [] : readFileSync(join(home, 'sessions', file), 'utf8').split('\n').slice(0, -1)
          .filter(Boolean).map(line => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }
    async function until(label: string, check: () => unknown) {
      for (let i = 0; i < 320 && !dead; i++) {
        if (check()) return;
        await delay(25);
      }
      throw new Error(`${label}\n${view().replaceAll(root, '<temp>')}\n${JSON.stringify(wire().map(r => [r.type, r.type === 'prompt.steered' ? r : undefined]))}`);
    }
    async function draft(text: string) {
      terminal.write(`\x1b[200~${text}\x1b[201~`);
      await until('draft painted', () => screen.text().some(line => line.includes('│ >') && line.includes(text)));
      await delay(KIMI_ENTER_DELAY_MS);
    }
    await until('disposable trust screen', () => view().includes('Trust this folder?'));
    terminal.write('\r');
    await until('empty editor', () => screen.bracketedPaste() && kimiComposer(screen.text())?.empty === true);
    // The fixture has no managed readiness handshake. Let Kimi bind its local
    // environment profile after the lazy startup editor appears.
    await delay(350);
    await draft(initial);
    terminal.write('\r');
    await until('working editor', () => kimiComposer(screen.text(), 'steer')?.empty === true && requests.length === 1);
    if (mode !== 'plain') {
      await draft(older);
      terminal.write(KIMI_QUEUE_KEY); // Ctrl+Q is queue-only in either follow-up mode.
      await until('older native queue entry', () => view().includes(older) &&
        kimiComposer(screen.text(), 'selective-steer')?.empty === true);
      expect(kimiComposer(screen.text(), 'steer')).toBeUndefined();
    }
    await draft(steered);
    const screenMode = mode === 'plain' ? 'steer' : 'selective-steer';
    expect(kimiComposer(screen.text(), screenMode)?.empty).toBe(false);
    terminal.write(mode === 'plain' ? KIMI_STEER_KEY : kimiSelectiveSteerKey(mode));
    await until('steered request arrives while the first response is held', () =>
      wire().some(r => r.type === 'prompt.steered') && requests[1]?.includes(steered));
    expect(firstReleased).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.split(steered)).toHaveLength(2);
    expect(requests[1]).not.toContain(older);
    if (mode !== 'plain') {
      await until('older prompt is still queued during the second model request', () =>
        view().includes(older) && view().includes('ctrl-s to steer immediately'));
    }
    releaseSteer();
    await until('the steered model request finishes without releasing the first response', () =>
      wire().filter(r => r.type === 'turn.ended').length >= 2);
    expect(firstReleased).toBe(false);
    release();
    const expected = mode === 'plain' ? 2 : 3;
    await until('all provider turns finish', () => wire().filter(r => r.type === 'turn.ended').length === expected);
    const rows = wire();
    const record = rows.find(r => r.type === 'prompt.steered')!;
    const first = rows.find(r => r.type === 'turn.prompt')!;
    expect(record.activePromptId).toBe(first.promptId);
    expect(projectKimiWire(record)).toMatchObject({ kind: 'steer', id: record.messageId, text: steered });
    expect(rows.indexOf(record)).toBeLessThan(rows.findIndex(r => r.type === 'turn.ended'));
    // The stock CLI accepts the steer in the active prompt, then hands it off
    // at the provider's turn boundary. The user message keeps its identity.
    const consumed = rows.findIndex(r => r.type === 'turn.prompt' && r.promptId === record.messageId);
    expect(consumed).toBeGreaterThan(rows.findIndex(r => r.type === 'turn.ended'));
    expect(requests).toHaveLength(expected);
    if (mode !== 'plain') expect(requests[2]?.split(older)).toHaveLength(2);
    expect(requests[0]).not.toContain(steered);
    expect(requests[1]?.split(steered)).toHaveLength(2);
    expect(rows.filter(r => r.type === 'prompt.steered')).toHaveLength(1);

    const feed = createFeedService(fakeFeedDeps([{ ref: REF, provider: 'kimi' }]).deps);
    try {
      for (const row of rows) {
        const event = projectKimiWire(row);
        if (event !== undefined) feed.kimiNativeEvent(REF, 'session_fixture', event, true);
      }
      const snapshot = await feed.snapshot(REF);
      expect(snapshot.items.filter(item => item.kind === 'prompt').map(item => item.text)).toEqual(mode === 'plain' ? [initial, steered] : [initial, steered, older]);
      expect(snapshot.items.filter(item => item.kind === 'turn')).toHaveLength(expected);
    } finally {
      await feed.stop();
    }
  } finally {
    release();
    releaseSteer();
    child?.kill('SIGKILL');
    await exit;
    screen.dispose();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
