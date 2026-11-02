import { fork } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';
import { stopApp } from './stop-app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const build = process.env.P7_BUILD ?? '/private/tmp/parley-s215-p7-head-v9';
const runtime = '/private/tmp/parley-s215-electron44-dist/Electron.app/Contents/MacOS/Electron';

test('P7 actual Electron pilot uses the complete isolated host/main/preload/renderers path', async () => {
  test.setTimeout(120000);
  const home = await mkdtemp('/private/tmp/parley-s215-p7-pilot-');
  const seed = fork(path.join(root, 'tools/bench/window-sync/seed.mjs'), [root, home, 'small'], { stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => { seed.once('error', reject); seed.once('exit', code => code === 0 ? resolve() : reject(new Error(`seed exit ${code}`))); });
  const fixture = JSON.parse(await readFile(path.join(home, 'fixture.json'), 'utf8')) as { ids: string[]; project: string };
  const inherited = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  const env = { ...inherited, PARLEY_HOME: home, PARLEY_WORKS_SYNC: '1', PARLEY_E2E: '1', PARLEY_ISLAND: 'on', PARLEY_NOTCH: '185x32', PARLEY_UPDATE_CHECK: 'off', PARLEY_LOGIN_SHELL: 'skip', PARLEY_SKIP_VERSION_PROBE: '1', PARLEY_CLAUDE_PROJECTS_DIR: path.join(home, 'empty-claude'), PARLEY_CODEX_SESSIONS_DIR: path.join(home, 'empty-codex'), P7_FIXTURE: path.join(home, 'fixture.json') };
  const host = fork(path.join(root, 'tools/bench/window-sync/host-fixture.mjs'), [build], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let hostLog = '';
  host.stderr?.on('data', chunk => { hostLog += String(chunk); });
  let requestId = 0;
  function command(command: string, fields: object = {}): Promise<unknown> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { host.off('message', receive); reject(new Error(`fixture command timeout ${command}: ${hostLog}`)); }, 20000);
      const receive = (message: { id?: number; result?: unknown; error?: string }) => {
        if (message.id !== id) return; clearTimeout(timer); host.off('message', receive);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      };
      host.on('message', receive); host.send({ id, command, ...fields });
    });
  }
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { host.once('error', reject); host.once('exit', code => reject(new Error(`fixture host exit ${code}: ${hostLog}`))); host.on('message', message => { if ((message as { kind?: string }).kind === 'ready') resolve(); }); });
    app = await electron.launch({ executablePath: runtime, args: [path.join(build, 'packages/desktop/out/main/index.js')], env });
    await app.firstWindow();
    await expect.poll(async () => (await app!.windows()).some(page => /\/index\.html/.test(page.url()))).toBe(true);
    const window = (await app.windows()).find(page => /\/index\.html/.test(page.url()))!;
    await window.waitForFunction(() => (globalThis as unknown as { __p7Renderer?: { state(): { ready: boolean; entries: unknown[] } } }).__p7Renderer?.state().ready === true);
    const state = await window.evaluate(() => {
      const s = (globalThis as unknown as { __p7Renderer: { state(): { entries: Array<{ map: { sessions: unknown[] } }>; syncStatus: unknown } } }).__p7Renderer.state();
      return { works: s.entries.length, sessions: s.entries.reduce((n, entry) => n + entry.map.sessions.length, 0), status: s.syncStatus };
    });
    expect(state.works).toBe(2); expect(state.sessions).toBe(20);
    expect(state.status).toMatchObject({ state: 'current' });
    await window.screenshot({ path: path.join(home, 'main.png') });
    const windows = await app.windows();
    const result = { home, build, fixture, state, windows: await Promise.all(windows.map(page => page.title())), host: await command('stats'), main: await app.evaluate(() => (globalThis as { __p7Main?: { read(): unknown } }).__p7Main?.read()), renderer: await window.evaluate(() => (globalThis as unknown as { __p7Renderer: { read(): unknown } }).__p7Renderer.read()), ipc: await window.evaluate(() => (globalThis as unknown as { __p7IPC: { read(): unknown } }).__p7IPC.read()), trace: await app.evaluate(() => (globalThis as { __p7Main?: { stopTrace(): Promise<string> } }).__p7Main?.stopTrace()) };
    await writeFile(path.join(home, 'pilot.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ evidence: path.join(home, 'pilot.json'), state, windows: result.windows }));
  } finally {
    if (app) await stopApp(app);
    if (host.connected) await command('stop').catch(() => host.kill());
    if (host.exitCode === null) await new Promise(resolve => host.once('exit', resolve));
  }
});
