import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { MethodName, Params, Result, SessionRef } from '@parley/protocol';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';

const runtime = process.env.PARLEY_KIMI_ELECTRON_RUNTIME;
const bin = '/Users/kalmbik61/.kimi-code/bin/kimi';
const model = 'parley-electron-offline';
const modes = { manual: 'Always Ask', auto: 'Full access / Never Ask', yolo: 'Automatic / Ask When Needed' } as const;
const marker = (mode: string) => `E2E_KIMI_${mode.toUpperCase()}`;
const rawMarker = 'E2E_KIMI_TERMINAL';

async function call<M extends MethodName>(window: Page, method: M, params: Params<M>): Promise<Result<M>> {
  return window.evaluate(([name, args]) => window.parley.call(name, args), [method, params] as const) as Promise<Result<M>>;
}

async function nativeScreen(window: Page, ref: SessionRef): Promise<string> {
  return (await call(window, 'pty.screenText', { ref })).lines.join('\n');
}

async function sessions(window: Page, work: Pick<SessionRef, 'projectPath' | 'workId'>) {
  const { entries } = await call(window, 'works.list', {});
  return entries.find(entry => entry.projectPath === work.projectPath && entry.map.work.id === work.workId)?.map.sessions ?? [];
}

test('stock Kimi first-turn tools, launch modes, shared renderer and native island', async ({}, info) => {
  test.skip(!runtime || process.platform !== 'darwin', 'requires a local Electron runtime and stock Kimi 2.7.3');
  test.setTimeout(110_000);
  const root = await realpath(await mkdtemp('/tmp/pke-'));
  const [home, kimi, parley, tmp, projectPath, appData] = ['home', 'kimi', 'parley', 'tmp', 'project', 'app'].map(name => join(root, name)) as [string, string, string, string, string, string];
  const seen: { marker: string; tools: string[]; result?: string }[] = [];
  const rejected: string[] = [];
  let modelRequests = 0;
  const modelServer = createServer(async (req, res) => {
    modelRequests++;
    try {
      expect([req.method, req.url, req.headers.authorization]).toEqual(['POST', '/v1/chat/completions', 'Bearer test-not-a-secret']);
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        expect(raw.length).toBeLessThan(512_000);
      }
      const { messages, tools = [], model: actual, stream } = JSON.parse(raw);
      expect([actual, stream]).toEqual([model, true]);
      const history = JSON.stringify(messages);
      const current = [...Object.keys(modes).map(marker), rawMarker].map(text => ({ text, at: history.lastIndexOf(text) }))
        .filter(candidate => candidate.at >= 0).sort((a, b) => b.at - a.at)[0]?.text;
      if (!current) throw new Error('Unsolicited model request');
      const callId = `call_${current}`;
      const result = messages.find((item: { role: string; tool_call_id?: string }) => item.role === 'tool' && item.tool_call_id === callId)?.content;
      const names: string[] = tools.map((tool: { function: { name: string } }) => tool.function.name);
      seen.push({ marker: current, tools: names, ...(result === undefined ? {} : { result: JSON.stringify(result) }) });
      const invoke = current !== rawMarker && result === undefined;
      if (invoke) expect(names).toContain('mcp__parley__get_map');
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
        id: 'kimi-electron-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk(invoke ? { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
        function: { name: 'mcp__parley__get_map', arguments: '{}' } }] } : { role: 'assistant', content: `${current}_REPLY` }, null));
      res.end(chunk({}, invoke ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      rejected.push(String(error));
      res.writeHead(400).end();
    }
  });
  let app: ElectronApplication | null = null;
  let stage = 'isolate launch';
  let inspect: (() => Promise<string>) | undefined;
  try {
    await Promise.all([home, kimi, parley, tmp, projectPath, appData].map(dir => mkdir(dir)));
    const listening = once(modelServer, 'listening');
    modelServer.listen(0, '127.0.0.1');
    await listening;
    const address = modelServer.address();
    if (!address || typeof address === 'string') throw new Error('No loopback model address');
    const executable = await realpath(bin);
    const node = await realpath(process.execPath);
    const workspace = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
    const core = join(workspace, 'packages/core');
    const hostPkg = join(workspace, 'packages/host');
    const profile = join(root, 'kimi.sb');
    await writeFile(profile, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${address.port}"))\n(deny file-read-data (subpath "/Users/kalmbik61"))\n(deny file-write* (subpath "/Users/kalmbik61"))\n(allow file-read-data (literal ${JSON.stringify(executable)}) (literal ${JSON.stringify(node)}) (literal ${JSON.stringify(join(core, 'package.json'))}) (subpath ${JSON.stringify(join(core, 'dist'))}) (literal ${JSON.stringify(join(hostPkg, 'package.json'))}) (subpath ${JSON.stringify(join(hostPkg, 'dist/kimi'))}) (subpath ${JSON.stringify(join(workspace, 'node_modules/.pnpm'))}))\n`);
    const launch = join(root, 'kimi-locked');
    await writeFile(launch, [
      '#!/bin/sh',
      String.raw`port=$(printf "%s" "$PARLEY_HOOK_URL" | /usr/bin/sed -nE 's@^http://127.0.0.1:([0-9]+)/hooks$@\1@p')`,
      `profile=$(/bin/cat '${profile}')`,
      'if [ -n "$port" ]; then profile="$profile',
      '(allow network-outbound (remote ip \\"localhost:$port\\"))"; fi',
      `exec /usr/bin/sandbox-exec -p "$profile" '${executable}' "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });
    await writeFile(join(kimi, 'config.toml'), 'default_permission_mode = "auto"\n');
    const env = {
      HOME: home, USERPROFILE: home, TMPDIR: tmp, LANG: 'en_US.UTF-8', SHELL: '/bin/sh', PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      PARLEY_HOME: parley, PARLEY_APP_DATA: appData, PARLEY_E2E: '1', PARLEY_SKIP_VERSION_PROBE: '1', PARLEY_AGENT_SKILLS: 'off',
      PARLEY_LOGIN_SHELL: 'skip', PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_UPDATE_CHECK: 'off', PARLEY_NOTIFICATIONS: 'log',
      PARLEY_DIALOGS: 'log', PARLEY_SHELL: 'log', PARLEY_ISLAND: '', PARLEY_MACHINE_CONCURRENT: 'off', PARLEY_SLEEP_AFTER_MINUTES: '0',
      KIMI_CODE_HOME: kimi, PARLEY_KIMI_BIN: launch, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1',
      KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_NAME: model, KIMI_MODEL_API_KEY: 'test-not-a-secret',
      KIMI_MODEL_CAPABILITIES: 'tool_use', KIMI_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    };
    expect(execFileSync(launch, ['--version'], { cwd: projectPath, env, encoding: 'utf8', timeout: 8000 }).trim()).toBe('2.7.3');
    app = await electron.launch({ executablePath: runtime!, args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--lang=en-US'], env });
    const main = () => app!.windows().find(page => /\/index\.html(?:\?|$)/.test(page.url()));
    const island = () => app!.windows().find(page => /\/island\.html(?:\?|$)/.test(page.url()));
    await expect.poll(() => Boolean(main()), { timeout: 30_000 }).toBe(true);
    const window = main()!;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => /\/index\.html(?:\?|$)/.test(win.webContents.getURL()))
      ?.setBounds({ x: 50, y: 80, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call(window, 'works.create', { projectPath, title: 'Offline Kimi Electron', goal: '' });
    const work = { projectPath, workId };
    await window.locator(`[data-work-key="${projectPath} ${workId}"]:not([role="tab"]) [data-work-title]`).first().click();

    for (const [mode, label] of Object.entries(modes)) {
      stage = `launch ${mode} in renderer`;
      const before = modelRequests;
      const previous = new Set((await sessions(window, work)).map(row => row.id));
      await window.keyboard.press('Meta+T');
      const dialog = window.getByRole('dialog', { name: 'New session', exact: true });
      await dialog.getByRole('radio', { name: 'Kimi Code', exact: true }).click();
      await dialog.getByRole('combobox', { name: 'Kimi permission mode' }).click();
      await window.getByRole('option', { name: label, exact: true }).click();
      await dialog.getByPlaceholder('Optional').fill(`Offline Kimi ${mode}`);
      await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
      await expect(dialog).toBeHidden();
      const current = async () => (await sessions(window, work)).find(row => !previous.has(row.id) && row.provider === 'kimi');
      await expect.poll(current, { timeout: 10_000 }).toMatchObject({ kimiPermissionMode: mode, pid: expect.any(Number) });
      const row = (await current())!;
      const ref = { ...work, sessionId: row.id };
      inspect = () => nativeScreen(window, ref);
      const generation = (await call(window, 'pty.attach', { ref })).generation;
      const terminal = () => window.getByRole('radio', { name: 'Terminal', exact: true });
      const chatSwitch = () => window.getByRole('radio', { name: 'Chat', exact: true });
      const existingChat = window.getByTestId('chat-view');
      const rendererKeys = () => window.locator('.xterm-helper-textarea:visible');
      if (mode === 'manual') {
        await terminal().click();
        await expect.poll(() => nativeScreen(window, ref)).toContain('Trust this folder?');
        expect(await nativeScreen(window, ref)).toContain(projectPath);
        await rendererKeys().press('Enter');
      }
      await expect.poll(async () => {
        const item = await current();
        return item?.providerSessionId !== null && item?.providerSessionId !== undefined && item.kimiNativeBootstrap === undefined;
      }, { timeout: 20_000 }).toBe(true);
      const ready = (await current())!;
      expect(ready.pid).toBe(row.pid);
      expect(modelRequests).toBe(before);
      expect((await call(window, 'pty.attach', { ref })).generation).toBe(generation);
      await chatSwitch().click();
      const field = existingChat.getByRole('textbox', { name: 'Message to Kimi Code' });
      await field.fill(marker(mode));
      await existingChat.getByRole('button', { name: 'Send', exact: true }).click();
      if (mode === 'manual') {
        stage = 'real native permission choices in island';
        await expect.poll(() => Boolean(island())).toBe(true);
        const islandView = island()!;
        await expect(islandView.getByTestId('island-card')).toContainText('mcp__parley__get_map');
        for (const name of ['Approve once', 'Approve for this session', 'Reject', 'Reject with feedback']) {
          await expect(islandView.getByRole('button', { name, exact: true })).toBeVisible();
        }
        const screenshot = info.outputPath('kimi-native-choices.png');
        await islandView.screenshot({ path: screenshot });
        await info.attach('Native Kimi choices in the isolated working build', { path: screenshot, contentType: 'image/png' });
        await islandView.getByRole('button', { name: 'Approve once', exact: true }).click();
      }
      await expect(existingChat.getByText(`${marker(mode)}_REPLY`, { exact: true })).toBeVisible({ timeout: 12_000 });
      const rows = seen.filter(entry => entry.marker === marker(mode));
      expect(rows).toHaveLength(2);
      expect(rows[0]!.tools).toHaveLength(74);
      expect(rows[0]!.tools.filter(tool => tool.startsWith('mcp__parley__'))).toHaveLength(50);
      expect(rows[1]!.result).toContain(ref.sessionId);
      expect(rows[1]!.result).toContain(ref.workId);
      if (mode === 'manual') {
        stage = 'raw Terminal turn stays in the same native thread and reappears in Chat';
        await terminal().click();
        await expect.poll(() => nativeScreen(window, ref)).toMatch(/^\s*│ >\s*│\s*$/m);
        await rendererKeys().focus();
        // Stock Kimi treats a dense unbracketed burst followed by Enter as a paste newline.
        await window.keyboard.type(rawMarker, { delay: 45 });
        await expect.poll(() => nativeScreen(window, ref)).toContain(rawMarker);
        await rendererKeys().press('Enter');
        await expect.poll(() => nativeScreen(window, ref), { timeout: 12_000 }).toContain(`${rawMarker}_REPLY`);
        await chatSwitch().click();
        await expect(existingChat.getByText(`${rawMarker}_REPLY`, { exact: true })).toBeVisible();
        expect(seen.filter(entry => entry.marker === rawMarker)).toHaveLength(1);
      }
      expect(await current()).toMatchObject({ providerSessionId: ready.providerSessionId, pid: ready.pid });
      expect((await call(window, 'pty.attach', { ref })).generation).toBe(generation);
      await call(window, 'sessions.stop', { ref });
    }
    expect(await readFile(join(kimi, 'config.toml'), 'utf8')).toContain('default_permission_mode = "auto"');
    expect(rejected).toEqual([]);
    console.info('Electron stock Kimi acceptance:', JSON.stringify({ modelRequests, modes: Object.keys(modes), sharedPty: true, nativeIsland: true }));
  } catch (error) {
    console.info('Electron stock Kimi stage:', stage, { modelRequests, rejected, windows: app?.windows().map(page => page.url()) });
    if (inspect) console.info((await inspect().catch(() => '')).replaceAll(root, '<temp>').slice(-2400));
    const log = await readFile(join(parley, 'host', 'host.log'), 'utf8').catch(() => '');
    console.info(log.split('\n').filter(line => /Kimi |error|failed/.test(line)).slice(-9).map(line => line.replaceAll(root, '<temp>')));
    throw error;
  } finally {
    await stopApp(app);
    await stopHost(parley);
    modelServer.closeAllConnections();
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
