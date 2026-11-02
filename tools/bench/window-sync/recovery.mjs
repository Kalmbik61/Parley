// Actual two-surface failure fixture. OS mouse input is supplied separately by CUA.
/* global document, location */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { launchFixture } from './driver.mjs';
const output = process.argv[2];
if (!output?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('isolated output required');
const f = await launchFixture({ build: '/private/tmp/parley-s215-p7-head-v9', mode: 'head', shape: 'small', observe: true, island: true });
const lines = createInterface({ input: process.stdin });
const waitLine = () => new Promise(resolve => lines.once('line', resolve));
try {
  await f.ready();
  let windows = await f.app.windows();
  if (windows.length < 2) { await f.app.waitForEvent('window'); windows = await f.app.windows(); }
  for (const page of windows) await page.waitForFunction(() => globalThis.__p7Renderer?.state().syncStatus?.state === 'current');
  await f.command('socket-hide');
  for (const page of windows) await page.waitForFunction(() => ['stale', 'error'].includes(globalThis.__p7Renderer?.state().syncStatus?.state), { timeout: 45000 });
  const capture = async name => {
    const surfaces = [];
    for (const [i, page] of windows.entries()) {
      await page.screenshot({ path: path.join(f.home, `${name}-${i}.png`) });
      surfaces.push(await page.evaluate(() => { const s = globalThis.__p7Renderer.state(); return { title: document.title, url: location.href, entries: s.entries.length, status: s.syncStatus, retry: [...document.querySelectorAll('button')].filter(b => b.textContent === 'Retry').map(b => { const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) }; }));
    }
    const native = await f.app.evaluate(({ BrowserWindow, screen }) => ({ cursor: screen.getCursorScreenPoint(), windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), bounds: w.getBounds(), visible: w.isVisible(), url: w.webContents.getURL() })) }));
    const value = { home: f.home, surfaces, native };
    await fs.writeFile(output + `.${name}.json`, JSON.stringify(value, null, 2));
    process.stdout.write(JSON.stringify({ name, ...value }) + '\n');
    return value;
  };
  const failed = await capture('failed');
  process.stdout.write('Awaiting stdin: restore (restore own socket), capture, or finish. Native click must use OS input.\n');
  for (;;) {
    const line = await waitLine();
    if (line === 'restore') { await f.command('socket-restore'); await capture('restored-before-click'); }
    else if (line === 'capture') await capture('after-native-input');
    else if (line === 'finish') break;
  }
  const after = await capture('final');
  await fs.writeFile(output, JSON.stringify({ failed, after, correctness: await f.checkState(), raw: await f.collect(), nativeClickEvidence: 'separate CUA tool actions; never infer OS hit eligibility from CDP mouse input' }, null, 2));
} finally { lines.close(); await f.cleanup(); }
