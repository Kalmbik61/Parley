// Actual isolated Electron driver; pilots/calibration are not final P7 claims.
/* global document, performance, requestAnimationFrame, TextEncoder, crypto */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout, setImmediate } from 'node:timers';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../..');
const { _electron } = createRequire(path.join(root, 'packages/desktop/package.json'))('@playwright/test');
export const runtime = '/private/tmp/parley-s215-electron44-dist/Electron.app/Contents/MacOS/Electron';

export async function launchFixture({ build, shape = 'small', observe = true, commitProbe = true, island = false, phases = false, mode = 'head' }) {
  const home = await fs.mkdtemp('/private/tmp/parley-s215-p7-run-');
  // Each historical runtime creates/reads its own supported storage schema.
  // Logical fixture values are identical; current core must not migrate the base DB.
  await exec(process.execPath, [path.join(here, 'seed.mjs'), build, home, shape]);
  const fixture = JSON.parse(await fs.readFile(path.join(home, 'fixture.json'), 'utf8'));
  for (const name of ['empty-claude', 'empty-codex']) await fs.mkdir(path.join(home, name));
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  Object.assign(env, {
    PARLEY_HOME: home, PARLEY_WORKS_SYNC: mode === 'head' ? '1' : '0', PARLEY_E2E: '1', PARLEY_ISLAND: island ? 'on' : 'off', PARLEY_NOTCH: '185x32', PARLEY_UPDATE_CHECK: 'off',
    PARLEY_LOGIN_SHELL: 'skip', PARLEY_SKIP_VERSION_PROBE: '1', PARLEY_NOTIFICATIONS: 'log', PARLEY_SHELL: 'log', PARLEY_DROPS: 'fake', PARLEY_DOWNLOADS: 'log', PARLEY_DIALOGS: 'log',
    PARLEY_SLEEP_AFTER_MINUTES: '0', PARLEY_MACHINE_CONCURRENT: 'off', PARLEY_CLAUDE_PROJECTS_DIR: path.join(home, 'empty-claude'), PARLEY_CODEX_SESSIONS_DIR: path.join(home, 'empty-codex'),
    P7_FIXTURE: path.join(home, 'fixture.json'), P7_OBSERVE: observe ? '1' : '0', P7_PHASES: phases ? '1' : '0', P7_COMMIT_PROBE: commitProbe ? '1' : '0',
  });
  const host = fork(path.join(here, 'host-fixture.mjs'), [build], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let hostLog = '', nextId = 0, app, electronProcess;
  host.stderr.on('data', data => { hostLog += String(data); });
  host.stdout.on('data', data => { hostLog += String(data); });
  function command(command, fields = {}) {
    const id = ++nextId, dispatchAt = Date.now();
    return new Promise((resolve, reject) => {
      const receive = message => {
        if (message.id !== id) return;
        clearTimeout(timer); host.off('message', receive);
        if (message.error) reject(new Error(message.error)); else resolve(message.result && typeof message.result === 'object' ? { ...message.result, driverDispatchAt: dispatchAt, driverReplyAt: Date.now() } : message.result);
      };
      const timer = setTimeout(() => { host.off('message', receive); reject(new Error(`fixture ${command} timed out: ${hostLog}`)); }, 30000);
      host.on('message', receive); host.send({ id, command, dispatchAt, ...fields });
    });
  }
  const cleanup = async () => {
    if (app) await app.evaluate(({ app }) => { setImmediate(() => app.quit()); }).catch(() => {});
    if (electronProcess?.exitCode === null) await Promise.race([new Promise(resolve => electronProcess.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (electronProcess?.exitCode === null) electronProcess.kill();
    if (host.connected) await command('stop').catch(() => host.kill());
    if (host.exitCode === null) await new Promise(resolve => host.once('exit', resolve));
    await fs.writeFile(path.join(home, 'host-stderr.log'), hostLog);
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture host readiness timeout: ${hostLog}`)), 30000);
      host.once('error', error => { clearTimeout(timer); reject(error); });
      host.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture host exit ${code}: ${hostLog}`)); });
      host.on('message', message => { if (message.kind === 'ready') { clearTimeout(timer); resolve(); } });
    });
    app = await _electron.launch({ executablePath: runtime, args: [path.join(build, 'packages/desktop/out/main/index.js')], env });
    electronProcess = app.process();
    await app.firstWindow();
    let page = (await app.windows()).find(window => /\/index\.html(?:$|[?#])/.test(window.url()));
    if (!page) page = await app.waitForEvent('window', { predicate: window => /\/index\.html(?:$|[?#])/.test(window.url()) });
    const browserLog = [];
    page.on('pageerror', error => browserLog.push(String(error)));
    const ready = async (timeout = 30000) => {
      await page.waitForFunction(spec => {
        const s = globalThis.__p7Renderer?.state();
        return s?.ready === true && s.entries.length === spec.works && s.entries.reduce((n, e) => n + e.map.sessions.length, 0) === spec.total && !(s.mailRepairPending > 0) && !s.mailRepairFailed;
      }, fixture.spec, { timeout });
    };
    const waitVersion = async (workId, version, timeout = 30000) => page.waitForFunction(({ workId, version }) => globalThis.__p7Renderer.state().entries.some(entry => entry.map.work.id === workId && entry.version >= version), { workId, version }, { timeout });
    const reset = async () => {
      await command('reset');
      await app.evaluate(() => { globalThis.__p7Main.reset(); });
      for (const page of await app.windows()) await page.evaluate(() => { globalThis.__p7Renderer.reset(); globalThis.__p7IPC.reset(); performance.mark('p7-measure-start'); });
      return await app.evaluate(({ app }) => app.getAppMetrics());
    };
    const collect = async () => {
      const measureEnds = [];
      for (const page of await app.windows()) measureEnds.push(await page.evaluate(() => { performance.mark('p7-measure-end'); return { title: document.title, epoch: performance.timeOrigin + performance.now() }; }));
      const hostStats = await command('stats');
      const main = await app.evaluate(() => globalThis.__p7Main.read());
      const surfaces = [];
      for (const page of await app.windows()) surfaces.push(await page.evaluate(() => ({ title: document.title, renderer: globalThis.__p7Renderer.read(), ipc: globalThis.__p7IPC.read() })));
      const trace = await app.evaluate(() => globalThis.__p7Main.stopTrace());
      const runtimeInfo = await app.evaluate(({ app, screen }) => ({ versions: process.versions, appVersion: app.getVersion(), displays: screen.getAllDisplays().map(({ id, size, scaleFactor, displayFrequency }) => ({ id, size, scaleFactor, displayFrequency })) }));
      return { home, build, mode, observe, commitProbe, fixture, host: hostStats, main, surfaces, trace, measureEnds, browserLog, runtimeInfo };
    };
    const checkState = async () => {
      const previous = process.env.PARLEY_HOME; process.env.PARLEY_HOME = home;
      let expected, core;
      function canonical(value) {
        if (Array.isArray(value)) return value.map(canonical);
        if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        return value;
      }
      try {
        core = await import(pathToFileURL(path.join(build, 'packages/core/dist/index.js')).href);
        const works = await core.readWorks();
        expected = { entries: works.map(entry => ({ projectPath: entry.projectPath, version: entry.version, map: core.mailWorkMap(entry.map, core.storeLetterReader(entry.projectPath, entry.map.work.id)) })), branches: Object.fromEntries(await Promise.all([...new Set(works.map(entry => entry.projectPath))].map(async project => [project, await core.gitBranch(project)]))) };
      } finally { core?.closeWorkDb(); if (previous === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = previous; }
      const expectedHash = createHash('sha256').update(JSON.stringify(canonical(expected))).digest('hex');
      const actualHash = await page.evaluate(async () => {
        function canonical(value) {
          if (Array.isArray(value)) return value.map(canonical);
          if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
          return value;
        }
        const state = globalThis.__p7Renderer.state();
        const bytes = new TextEncoder().encode(JSON.stringify(canonical({ entries: state.entries, branches: state.branches })));
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      });
      await fs.writeFile(path.join(home, 'correctness-expected.json'), JSON.stringify(expected));
      await fs.writeFile(path.join(home, 'correctness-actual.json'), JSON.stringify(await page.evaluate(() => { const s = globalThis.__p7Renderer.state(); return { entries: s.entries, branches: s.branches }; })));
      return { expectedHash, actualHash, equal: expectedHash === actualHash, scope: 'complete canonical entries/ordering/versions/maps/branches; untimed after observers stopped' };
    };
    return { home, fixture, app, page, command, ready, waitVersion, reset, collect, checkState, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function supportedTrial(options) {
  const f = await launchFixture(options);
  try {
    await f.ready();
    // One declared warmup write. The following three equal-sized task edits are measured.
    const text = i => (`p7-${i}:` + 'x'.repeat(128)).slice(0, 128);
    const work = f.fixture.spec.works === 30 ? 20 : 0;
    const warmup = await f.command('edit', { text: text('warm'), work }); await f.waitVersion(warmup.workId, warmup.version);
    const processBefore = await f.reset(), edits = [];
    for (let i = 0; i < 3; i += 1) { const result = await f.command('edit', { text: text(i), work }); edits.push(result); await f.waitVersion(result.workId, result.version); }
    await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const raw = await f.collect();
    return { ...raw, processBefore, edits, correctness: await f.checkState(), trialKind: 'supported-size, one warmup then3 task edits', gates: 'not evaluated; observer/provenance coverage review required' };
  } finally { await f.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [build, mode = 'head', shape = 'small', observe = '1', out, probe = '1', phases = '0'] = process.argv.slice(2);
  if (!out) throw new Error('Usage:driver.mjs build mode shape observe output.json');
  const result = await supportedTrial({ build, mode, shape, observe: observe !== '0', commitProbe: probe !== '0', phases: phases === '1' });
  await fs.writeFile(out, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ out, home: result.home, mode, shape, observe: result.observe, edits: result.edits.length, trace: result.trace }) + '\n');
}
