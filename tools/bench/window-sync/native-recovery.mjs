// Real repaired Electron UI; OS input is supplied through CUA, not CDP mouse APIs.
/* global document, location, getComputedStyle, performance */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { launchFixture } from './driver.mjs';
const output = process.argv[2];
if (!output?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('owned evidence output required');
const f = await launchFixture({ build: '/private/tmp/parley-s215-p7-head-repaired-v1', mode: 'head', shape: 'small', observe: false, island: true });
const input = createInterface({ input: process.stdin });
try {
  await f.ready();
  let pages = await f.app.windows(); if (pages.length < 2) { await f.app.waitForEvent('window'); pages = await f.app.windows(); }
  const logs = [];
  for (const page of pages) {
    await page.waitForFunction(() => globalThis.__p7Renderer?.state().syncStatus?.state === 'current');
    page.on('pageerror', error => logs.push({ url: page.url(), error: String(error) }));
    await page.evaluate(() => { globalThis.__p7NativeClicks = []; document.addEventListener('click', event => { const button = event.target.closest?.('button'); if (button?.textContent === 'Retry') globalThis.__p7NativeClicks.push({ trusted: event.isTrusted, at: performance.timeOrigin + performance.now(), x: event.clientX, y: event.clientY }); }, true); });
  }
  await f.app.evaluate(({ BrowserWindow, ipcMain }) => {
    const records = []; globalThis.__p7NativePolicy = records;
    for (const window of BrowserWindow.getAllWindows()) { const original = window.setIgnoreMouseEvents; window.setIgnoreMouseEvents = function (...args) { records.push({ kind: 'mouse-ignore', id: window.id, at: Date.now(), args }); return Reflect.apply(original, this, args); }; }
    for (const channel of ['island:hit-rect', 'island:visible', 'island:failed']) ipcMain.on(channel, (event, value) => records.push({ kind: channel, contents: event.sender.id, at: Date.now(), value }));
  });
  const captures = [];
  const capture = async name => {
    const surfaces = [];
    for (const [i, page] of pages.entries()) {
      const data = await page.evaluate(() => {
        const s = globalThis.__p7Renderer.state(), shape = document.querySelector('[data-testid="island"]');
        const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        return { title: document.title, url: location.href, status: s.syncStatus, entries: s.entries.length, hidden: document.hidden, shape: shape ? { rect: rect(shape), html: shape.outerHTML, display: getComputedStyle(shape).display } : null, retry: [...document.querySelectorAll('button')].filter(e => e.textContent === 'Retry').map(e => ({ rect: rect(e), disabled: e.disabled })), clicks: globalThis.__p7NativeClicks };
      });
      await page.screenshot({ path: path.join(f.home, `${name}-${i}.png`) }); surfaces.push(data);
    }
    const native = await f.app.evaluate(({ BrowserWindow, screen }) => ({ cursor: screen.getCursorScreenPoint(), calls: globalThis.__p7NativePolicy, windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), url: w.webContents.getURL(), bounds: w.getBounds(), visible: w.isVisible() })) }));
    const value = { name, surfaces, native, logs: [...logs] }; captures.push(value);
    await fs.writeFile(output + '.' + name + '.json', JSON.stringify(value, null, 2));
    process.stdout.write(JSON.stringify({ home: f.home, name, surfaces: surfaces.map(s => ({ title: s.title, status: s.status, entries: s.entries, retry: s.retry, clicks: s.clicks })), native }) + '\n');
  };
  await capture('before'); await f.command('socket-hide');
  for (const page of pages) await page.waitForFunction(() => globalThis.__p7Renderer.state().syncStatus?.state === 'error');
  for (const page of pages) await page.getByRole('button', { name: 'Retry', exact: true }).waitFor({ state: 'visible' });
  await capture('failed');
  process.stdout.write('Commands: restore, capture, finish. Use CUA OS mouse for Retry.\n');
  for await (const line of input) {
    if (line === 'restore') { await f.command('socket-restore'); await capture('restored-before-input'); }
    else if (line === 'capture') await capture('after-input');
    else if (line === 'finish') break;
  }
  await capture('final');
  await fs.writeFile(output, JSON.stringify({ home: f.home, captures, correctness: await f.checkState(), raw: await f.collect(), input: 'CUA native OS coordinate input recorded separately; script never calls CDP mouse/locator.click' }, null, 2));
} finally { input.close(); await f.cleanup(); }
