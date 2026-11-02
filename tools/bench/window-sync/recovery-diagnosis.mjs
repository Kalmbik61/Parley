// Bounded UI-only reproduction requested by the lead after the failing P7 verdict.
/* global document, location, getComputedStyle, requestAnimationFrame, queueMicrotask */
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchFixture } from './driver.mjs';
const output = process.argv[2];
if (!output?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('owned evidence output required');
const f = await launchFixture({ build: '/private/tmp/parley-s215-p7-head-v9', mode: 'head', shape: 'small', observe: false, island: true });
try {
  await f.ready();
  let pages = await f.app.windows(); if (pages.length < 2) { await f.app.waitForEvent('window'); pages = await f.app.windows(); }
  const logs = [];
  for (const page of pages) { page.on('pageerror', error => logs.push({ url: page.url(), error: String(error) })); page.on('console', message => { if (['error', 'warning'].includes(message.type())) logs.push({ url: page.url(), type: message.type(), text: message.text() }); }); }
  await f.app.evaluate(({ BrowserWindow, ipcMain }) => {
    const records = []; globalThis.__p7IslandDiagnosis = records;
    for (const window of BrowserWindow.getAllWindows()) { const original = window.setIgnoreMouseEvents; window.setIgnoreMouseEvents = function (...args) { records.push({ kind: 'mouse-ignore', id: window.id, at: Date.now(), args }); return Reflect.apply(original, this, args); }; }
    for (const channel of ['island:hit-rect', 'island:visible', 'island:failed']) ipcMain.on(channel, (event, value) => records.push({ kind: channel, contents: event.sender.id, at: Date.now(), value }));
  });
  const capture = async name => {
    const surfaces = [];
    for (const [i, page] of pages.entries()) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const data = await page.evaluate(async () => {
        const state = globalThis.__p7Renderer.state(), status = await new Promise(resolve => { let off; off = globalThis.parley.onStatus(s => { resolve(s); queueMicrotask(() => off?.()); }); });
        const root = document.getElementById('root');
        const shape = document.querySelector('[data-testid="island-shape"]'), notch = document.querySelector('[data-testid="island-notch"]');
        function element(e) { if (!e) return null; const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { html: e.outerHTML.slice(0, 20000), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, visibility: s.visibility, opacity: s.opacity }; }
        return { title: document.title, url: location.href, connection: status, sync: state.syncStatus, entries: state.entries.length, hidden: document.hidden, readyState: document.readyState, root: element(root), shape: element(shape), notch: element(notch), retry: [...document.querySelectorAll('button')].filter(e => e.textContent === 'Retry').map(element), config: location.pathname.endsWith('island.html') ? await globalThis.parley.island.config() : null };
      });
      await page.screenshot({ path: path.join(f.home, `${name}-${i}.png`) }); surfaces.push(data);
    }
    const native = await f.app.evaluate(({ BrowserWindow, screen }) => ({ cursor: screen.getCursorScreenPoint(), calls: globalThis.__p7IslandDiagnosis, windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, visible: w.isVisible(), bounds: w.getBounds(), contentBounds: w.getContentBounds(), title: w.getTitle() })) }));
    const result = { surfaces, native, logs: [...logs] }; await fs.writeFile(output + '.' + name + '.json', JSON.stringify(result, null, 2)); return result;
  };
  const before = await capture('before');
  await f.command('socket-hide');
  for (const page of pages) await page.waitForFunction(() => globalThis.__p7Renderer.state().syncStatus?.state === 'error');
  const after = await capture('after');
  await fs.writeFile(output, JSON.stringify({ home: f.home, before, after, limitation: 'native OS click not attempted without a rendered target; console observers attach after launchFixture returns and may miss earlier bootstrap messages' }, null, 2));
  process.stdout.write(JSON.stringify({ output, home: f.home, retry: after.surfaces.map(s => ({ title: s.title, count: s.retry.length, notch: s.notch !== null, rootChildren: s.root?.html.length })) }) + '\n');
} finally { await f.cleanup(); }
