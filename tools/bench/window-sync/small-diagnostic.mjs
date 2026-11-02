// Authorized bounded B,H,H,B diagnostic. Gross CPU and idle controls stay separate.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers';
import { launchFixture } from './driver.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), exec = promisify(execFile);
const [output, mode] = process.argv.slice(2);
if (!output?.startsWith('/private/tmp/parley-s215-p7-small-diagnostic-')) throw new Error('isolated diagnostic output required');
if (!mode) {
  await fs.mkdir(output);
  await fs.cp(here, path.join(output, 'observers'), { recursive: true, errorOnExist: true });
  const hashes = {};
  for (const file of await fs.readdir(here)) hashes[file] = createHash('sha256').update(await fs.readFile(path.join(here, file))).digest('hex');
  await fs.writeFile(path.join(output, 'declaration.json'), JSON.stringify({ order: ['base', 'head', 'head', 'base'], shape: 'small', warmupWrites: 5, measuredWrites: 20, taskBytes: 128, heavy: false, commitProbe: false, idleBeforeMs: 1000, idleAfterMs: 1000, accounting: 'gross CPU/write and idle controls separately; no speculative subtraction; actual version polling upper bound only', observers: hashes }, null, 2));
  for (const [i, mode] of ['base', 'head', 'head', 'base'].entries()) {
    const out = path.join(output, `${i}-${mode}.json`);
    process.stdout.write(JSON.stringify({ start: out }) + '\n');
    const result = await exec(process.execPath, [fileURLToPath(import.meta.url), out, mode], { maxBuffer: 8 * 1024 * 1024 });
    await fs.writeFile(out + '.log', result.stdout + result.stderr);
  }
  for (const [file, expected] of Object.entries(hashes)) if (createHash('sha256').update(await fs.readFile(path.join(here, file))).digest('hex') !== expected) throw new Error('observer changed during diagnostic:'+file);
  process.stdout.write('Four diagnostic runs complete; observer hashes unchanged.\n');
} else {
  const f = await launchFixture({ build: mode === 'base' ? '/private/tmp/parley-s215-p7-base-repaired-observers-v1' : '/private/tmp/parley-s215-p7-head-repaired-v1', mode, shape: 'small', observe: false, commitProbe: false });
  try {
    await f.ready();
    const text = i => (`diagnostic-${i}:` + 'x'.repeat(128)).slice(0, 128);
    for (let i = 0; i < 5; i += 1) { const e = await f.command('edit', { text: text('warm'+i) }); await f.waitVersion(e.workId, e.version); }
    const idle = async () => { const processBefore = await f.reset(), start = Date.now(); await new Promise(resolve => setTimeout(resolve, 1000)); return { start, end: Date.now(), processBefore, raw: await f.collect() }; };
    const idleBefore = await idle();
    const processBefore = await f.reset(), start = Date.now(), edits = [];
    for (let i = 0; i < 20; i += 1) { const e = await f.command('edit', { text: text(i) }); await f.waitVersion(e.workId, e.version); edits.push({ ...e, observedAt: Date.now() }); }
    const end = Date.now(), raw = await f.collect(), idleAfter = await idle();
    const correctness = await f.checkState();
    await fs.writeFile(output, JSON.stringify({ ...raw, start, end, processBefore, edits, idleBefore, idleAfter, correctness, timing: 'polling upper bounds; commit probe off; gross CPU includes measurement controls' }, null, 2));
    if (!correctness.equal) throw new Error('full-state mismatch');
  } finally { await f.cleanup(); }
}
