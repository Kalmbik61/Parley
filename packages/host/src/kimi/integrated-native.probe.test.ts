import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readMap, unreadLetters, updateMap } from '@parley/core';
import type { MethodName, Params, Result } from '@parley/protocol';
import { expect, test, vi } from 'vitest';
import { connectRaw, hello, waitConnected, type RawMessage, type TestClient } from '../../test/helpers.js';
import { startHost, type RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

const bin = '/Users/kalmbik61/.kimi-code/bin/kimi';
const optIn = process.env['PARLEY_KIMI_INTEGRATED_BIN'];
const model = 'parley-offline-fixture';
const original = 'INTEGRATED_ORIGINAL_PROMPT';
const native = 'INTEGRATED_NATIVE_PROMPT';
const held = 'INTEGRATED_HELD_MAIL';
const ready = /^\s*│ >\s*│\s*$/m;
const sandbox = '/usr/bin/sandbox-exec';
const chatZone = 'Etc/GMT+12';
const terminalZone = 'Etc/GMT-14';

type WireEvent = {
  type: string;
  agentId?: string;
  serverName?: string;
  tools?: unknown[];
  message?: { role: string; content: { type: string; text?: string }[]; origin?: {
    kind: string; variant?: string; disclosure?: { kind: string; localDate?: string; timeZone?: string };
  } };
};

test.skipIf(!optIn).each([
  { day: 'ordinary native day', shiftDay: false },
  { day: 'changed native calendar day', shiftDay: true },
])('hands real host control to stock Kimi 2.7.3 and back ($day)', async ({ shiftDay }) => {
  expect(optIn).toBe(bin);
  expect(process.platform).toBe('darwin');
  const root = await realpath(await mkdtemp('/tmp/pki-'));
  const [home, kimi, parley, tmp, projectPath] = ['home', 'kimi', 'parley', 'tmp', 'project'].map(part => join(root, part)) as [string, string, string, string, string];
  const seen: { turn: string; managed: boolean; containsMail: boolean }[] = [];
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
      // ACP sends the brief and managed instructions in separate blocks. Match the latest
      // synthetic user marker, excluding old assistant replies from the history.
      const userHistory = JSON.stringify(body.messages.filter((m: { role: string }) => m.role === 'user'));
      const turn = [original, native, 'Call check_inbox.']
        .map(marker => ({ marker, at: userHistory.lastIndexOf(marker) }))
        .filter(match => match.at >= 0).sort((a, b) => b.at - a.at)[0]?.marker;
      if (turn === undefined) throw new Error('Unexpected synthetic model request');
      const tools: string[] = (body.tools ?? []).map((entry: { function: { name: string } }) => entry.function.name);
      const parleyTools = tools.filter(name => name.startsWith('mcp__parley__'));
      const managed = parleyTools.length > 0;
      console.info(`${turn}: ${tools.length} model tools, ${parleyTools.length} managed (${parleyTools.slice(0, 4).join(', ')}).`);
      seen.push({ turn, managed, containsMail: input.includes(held) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: `${turn === 'Call check_inbox.' ? 'MAIL_POINTER' : turn}_REPLY` }, null));
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      rejected.push(String(error));
      res.writeHead(400).end();
    }
  });
  let host: RunningHost | undefined;
  let client: TestClient | undefined;
  let stage = 'loopback listen';
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
    // Same deny rules as native-handoff.probe.test.ts. Read-only exceptions let stock ACP
    // launch the real Parley MCP; workspace code lives under the otherwise denied real home.
    await writeFile(profile, `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:${address.port}"))
(deny file-read-data (subpath "/Users/kalmbik61"))
(deny file-write* (subpath "/Users/kalmbik61"))
(allow file-read-data (literal ${JSON.stringify(executable)}) (literal ${JSON.stringify(node)}) (literal ${JSON.stringify(join(core, 'package.json'))}) (subpath ${JSON.stringify(join(core, 'dist'))}) (subpath ${JSON.stringify(join(workspace, 'node_modules/.pnpm'))}))
`);
    const launch = join(root, 'kimi-locked');
    await writeFile(launch, `#!/bin/sh\nif [ "$1" = acp ]; then exec 2>>'${join(root, 'kimi.stderr')}'; fi\nexec ${sandbox} -f '${profile}' '${executable}' "$@"\n`, { mode: 0o700 });
    // Do not supply inherited model/auth/config/proxy selectors to either process.
    for (const name of Object.keys(process.env)) {
      if (/^(KIMI_|MOONSHOT_|XDG_|OPENAI_|ANTHROPIC_|AZURE_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)) vi.stubEnv(name, undefined);
    }
    const env = {
      HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimi, PARLEY_KIMI_BIN: launch,
      TMPDIR: tmp, PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
      KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'probe-not-a-secret',
      KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    for (const [key, value] of Object.entries({ ...env, PARLEY_AGENT_SKILLS: 'off' })) vi.stubEnv(key, value);
    if (shiftDay) vi.stubEnv('TZ', chatZone);
    expect(execFileSync(launch, ['--version'], { cwd: projectPath, env, encoding: 'utf8', timeout: 8000 }).trim()).toBe('2.7.3');

    stage = 'host and yolo ACP launch';
    host = await startHost({ home: parley });
    const paths = hostPaths(parley);
    client = connectRaw(paths.socket);
    await waitConnected(client.socket);
    expect((await hello(client, await readFile(paths.token, 'utf8'))).error).toBeUndefined();
    const { ref } = await call('sessions.create', { projectPath, workId: null, provider: 'kimi', label: 'Offline integration', task: original, parent: null, kimiPermissionMode: 'yolo' });
    const session = async () => (await readMap(ref.projectPath, ref.workId)).sessions.find(item => item.id === ref.sessionId)!;
    const start = await session();
    expect(start.providerSessionId).toMatch(/^session_/);
    expect(start.pid).toBeTypeOf('number');
    expect((await call('kimi.getState', { ref })).config).toContainEqual(expect.objectContaining({ id: 'mode', currentValue: 'yolo' }));
    const poll = { timeout: 10_000, interval: 40 };
    await expect.poll(async () => (await call('feed.snapshot', { ref })).items, { ...poll, timeout: 35_000 }).toContainEqual(
      expect.objectContaining({ kind: 'text', text: `${original}_REPLY`, streaming: false }),
    );
    await expect.poll(() => call('kimi.getControl', { ref }), poll).toMatchObject({ owner: 'chat', canTakeover: true });
    expect(seen).toMatchObject([{ turn: original, containsMail: false }]);
    const archivedBrief = (await call('feed.snapshot', { ref })).items
      .filter(item => item.kind === 'prompt').map(item => item.text).find(text => text.includes(original));
    expect(archivedBrief).toBeDefined();
    // Kimi may discover tools without selecting them for the first model request.
    const wire = (await readdir(kimi, { recursive: true })).find(file => file.endsWith(`/${start.providerSessionId}/agents/main/wire.jsonl`));
    expect(wire).toBeDefined();
    const readWire = async (): Promise<WireEvent[]> => (await readFile(join(kimi, wire!), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const managedDiscoveries = async () => (await readWire()).filter(event => event.type === 'mcp.tools_discovered' && event.serverName === 'parley');
    const dateReminders = async () => (await readWire()).flatMap(({ type, agentId, message }) => {
      const origin = message?.origin;
      if (type !== 'context.append_message' || agentId !== 'main' || message?.role !== 'user' ||
          origin?.kind !== 'injection' || origin.variant !== 'date_change' || origin.disclosure?.kind !== 'date') return [];
      return [{ ...origin.disclosure, text: message.content.filter(part => part.type === 'text').map(part => part.text).join('') }];
    });
    const chatDates = shiftDay ? await dateReminders() : [];
    if (shiftDay) expect(chatDates).toMatchObject([{ timeZone: chatZone, localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    const chatDiscoveries = await managedDiscoveries();
    expect(chatDiscoveries.some(event => (event.tools?.length ?? 0) > 0)).toBe(true);
    console.info('Verified yolo creation, original binding, completed initial ACP turn, and managed Parley tool discovery.');

    stage = 'native takeover and client write fence';
    // The two zones are 26 hours apart. Only the disposable Kimi command's calendar changes.
    if (shiftDay) vi.stubEnv('TZ', terminalZone);
    expect(await call('kimi.setControl', { ref, target: 'terminal' })).toEqual({ owner: 'terminal' });
    const terminal = await session();
    expect(terminal.providerSessionId).toBe(start.providerSessionId);
    expect(terminal.pid).toBeTypeOf('number');
    expect(terminal.pid).not.toBe(start.pid);
    expect(() => process.kill(start.pid!, 0)).toThrow(/ESRCH/);
    expect(await call('pty.send', { ref, text: 'INTEGRATED_BLOCKED_CHAT', submit: true })).toMatchObject({ submitted: false });
    expect((await request('kimi.setConfig', { ref, configId: 'mode', value: 'plan' })).error).toMatchObject({ code: 'conflict' });
    expect((await request('feed.decide', { ref, cardId: 'offline-card', decision: { kind: 'permission', behavior: 'deny' } })).error).toMatchObject({ code: 'conflict' });
    expect((await request('kimi.setControl', { ref, target: 'chat' })).error).toMatchObject({ data: { reason: 'kimi-native-running' } });
    expect((await request('sessions.resume', { ref })).error).toMatchObject({ data: { reason: 'kimi-native' } });
    console.info('Verified old ACP PID exited and native rejects Chat send, config, decisions, and early handback.');

    stage = 'native screen, keys, and permissions';
    const screen = async () => (await call('pty.screenText', { ref })).lines.join('\n');
    await expect.poll(screen, poll).toMatch(/Trust this folder\?|^\s*│ >\s*│\s*$/m);
    const { snapshot, generation } = await call('pty.attach', { ref });
    expect(snapshot).toContain('\x1b[');
    expect(generation).toBeDefined();
    const raw = (data: string) => client!.send({ method: 'pty.input', params: { ref, data, generation } });
    const submit = async (text: string) => {
      raw(`\x1b[200~${text}\x1b[201~`);
      await expect.poll(screen, poll).toContain(text);
      // Kimi 2.7.3 also has the fallback paste-suppression window noted in the stock probe.
      await delay(150);
      raw('\r');
    };
    const first = await screen();
    if (first.includes('Trust this folder?')) {
      expect(first).toContain(projectPath);
      expect(first).toContain('No project integrations or instructions to activate.');
      expect(first).toMatch(/❯ Trust and continue/);
      expect((await readdir(projectPath)).filter(entry => !['.parley', 'PARLEY.md'].includes(entry))).toEqual([]);
      raw('\r');
    }
    await expect.poll(screen, poll).toMatch(ready);
    await expect.poll(screen, poll).toContain(start.providerSessionId!);
    client.send({ method: 'pty.resize', params: { ref, cols: 116, rows: 30, generation } });
    await expect.poll(() => call('pty.attach', { ref }), poll).toMatchObject({ cols: 116, rows: 30, generation });
    await submit('/status');
    await expect.poll(screen, poll).toMatch(/Permissions\s+Ask When Needed/);
    expect(await screen()).toContain(projectPath);
    expect(events.some(event => event.event === 'pty.output' && (event.data as { data: string }).data.includes('\x1b['))).toBe(true);
    raw('\x1b');
    await expect.poll(screen, poll).toMatch(ready);
    console.info('Verified native ANSI frames, resize, original provider ID/cwd and Ask When Needed in /status.');

    stage = 'native prompt with mail held';
    await updateMap(ref.projectPath, ref.workId, (_map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 'human', to: [ref.sessionId], text: held });
    });
    const unread = () => unreadLetters(ref.projectPath, ref.workId, ref.sessionId).map(letter => letter.text);
    await expect.poll(async () => {
      await call('kimi.getControl', { ref });
      return events.some(event => event.event === 'activity.changed' && JSON.stringify(event.data).includes('"mailWaiting":"paused"'));
    }, poll).toBe(true);
    await submit(native);
    await expect.poll(screen, poll).toContain(`${native}_REPLY`);
    await expect.poll(screen, poll).toMatch(ready);
    expect(unread()).toContain(held);
    expect(seen).toMatchObject([
      { turn: original, containsMail: false },
      { turn: native, containsMail: false },
    ]);
    expect(await screen()).not.toMatch(/Call check_inbox\.|INTEGRATED_HELD_MAIL|INTEGRATED_BLOCKED_CHAT/);
    console.info('Verified raw native turn and mail held outside the PTY.');

    stage = 'explicit exit and replay on handback';
    await submit('/exit');
    await expect.poll(() => call('kimi.getControl', { ref }), poll).toEqual({ owner: 'exited' });
    expect(() => process.kill(terminal.pid!, 0)).toThrow(/ESRCH/);
    // Stock Kimi can advertise schemas restored from history without dispatching them.
    // The real-host wire must show no fresh Parley discovery during native ownership.
    // Dispatch is checked separately with the inert sentinel, not with any real tool.
    expect(await managedDiscoveries(), 'No fresh Parley MCP discovery during native ownership').toHaveLength(chatDiscoveries.length);
    console.info('No new Parley MCP discovery appeared in the native provider trace.');
    expect(seen).toHaveLength(2);
    expect(unread()).toContain(held);
    const handoffDates = shiftDay ? await dateReminders() : [];
    if (shiftDay) {
      const nativeDates = handoffDates.slice(chatDates.length);
      expect(nativeDates).toMatchObject([{ timeZone: terminalZone, localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
      expect(nativeDates[0]?.localDate).not.toBe(chatDates[0]?.localDate);
      expect(nativeDates[0]?.text).toContain('The date has changed.');
      console.info('Kimi recorded a native date_change injection.', { chat: chatDates[0]?.localDate, native: nativeDates[0]?.localDate });
      vi.stubEnv('TZ', chatZone);
    }
    expect(await call('kimi.setControl', { ref, target: 'chat' })).toMatchObject({ owner: 'chat' });
    expect(await session()).toMatchObject({ lifecycle: 'active', providerSessionId: start.providerSessionId });
    await expect.poll(() => seen, { ...poll, timeout: 35_000 }).toHaveLength(3);
    expect(seen[2]).toMatchObject({ turn: 'Call check_inbox.', containsMail: false });
    expect.soft(seen[2]?.managed, 'Managed Parley tools should be advertised after handback').toBe(true);
    const { items } = await call('feed.snapshot', { ref });
    const prompts = items.filter(item => item.kind === 'prompt').map(item => item.text);
    const replies = items.filter(item => item.kind === 'text').map(item => item.text).join('');
    if (shiftDay) {
      expect(prompts).toContain(archivedBrief);
      expect(prompts).toContain(native);
      for (const { text } of handoffDates) expect(prompts.some(prompt => prompt.includes(text))).toBe(false);
    }
    for (const marker of [original, native]) {
      expect(prompts.filter(text => text.includes(marker))).toHaveLength(1);
      expect(replies.split(`${marker}_REPLY`)).toHaveLength(2);
    }
    expect(rejected).toEqual([]);
    console.info('Verified exact-ID handback, one copy of each prompt/reply, and one ACP mail pointer.');
  } catch (error) {
    console.error(`Integrated Kimi probe stopped at ${stage}. Loopback turns: ${JSON.stringify(seen)}. Rejected: ${JSON.stringify(rejected)}`);
    const log = await readFile(hostPaths(parley).log, 'utf8').catch(() => '');
    console.error(log.split('\n').filter(line => /kimi/i.test(line)).slice(-12).join('\n').replaceAll(root, '<temp>'));
    const stderr = await readFile(join(root, 'kimi.stderr'), 'utf8').catch(() => '');
    if (stderr) console.error(stderr.slice(-3000).replaceAll(root, '<temp>'));
    const entries = await readdir(kimi, { recursive: true }).catch(() => []);
    for (const file of entries.filter(name => /\.log$/.test(name)).slice(0, 4)) {
      const providerLog = await readFile(join(kimi, file), 'utf8').catch(() => '');
      if (providerLog) console.error(`${file}: ${providerLog.slice(-2500).replaceAll(root, '<temp>')}`);
    }
    throw error;
  } finally {
    client?.close();
    await host?.context.shutdown('test');
    await host?.closed;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
