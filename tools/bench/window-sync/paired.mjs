// Each trial runs in a fresh driver process so module-scoped home state cannot leak.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const exec = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const [output, kind = 'paired'] = process.argv.slice(2);
if (!output?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('isolated output required');
await fs.mkdir(output);
const builds = { base: '/private/tmp/parley-s215-p7-base-phases-v3', head: '/private/tmp/parley-s215-p7-head-phases-v4' };
const manifestHashes = Object.fromEntries(await Promise.all(Object.entries(builds).map(async ([name, build]) => [name, createHash('sha256').update(await fs.readFile(path.join(build, 'manifest.json'))).digest('hex')])));
const cases = [];
for (const shape of ['short3k']) {
  if (kind === 'paired') {
    for (let pair = 0; pair < 5; pair += 1) for (const mode of pair % 2 === 0 ? ['base', 'head'] : ['head', 'base']) cases.push({ shape, pair, mode, observe: false, probe: true, phases: true });
  } else {
    for (let pair = 0; pair < 2; pair += 1) for (const mode of pair % 2 === 0 ? ['base', 'head'] : ['head', 'base']) for (const probe of pair % 2 === 0 ? [false, true] : [true, false]) cases.push({ shape, pair, mode, observe: false, probe });
    for (const mode of ['base', 'head']) cases.push({ shape, pair: 2, mode, observe: true, probe: true });
  }
}
await fs.writeFile(path.join(output, 'declaration.json'), JSON.stringify({ kind, builds, manifestHashes, cases, instrumentation: 'identical bounded sampler in base/head; heavy hooks, async_hooks, global JSON and Socket observers off; disjoint synchronous spans and existing generator.next slices only; common bounded commit timestamps on', workload: 'exactly five alternating base/head short3k pairs; one main; 30 works/3000 archived 128-byte sessions; one warmup then three128-byte task edits; island off; full canonical state comparison outside timing', phaseCaveat: 'all recorded phase intervals end before any await or generator yield; process CPU is separate; no overhead subtraction', referenceHz: 60, synchronousP95BudgetMs: 16.7, candidateBytes: 512 * 1024 }, null, 2));
for (let i = 0; i < cases.length; i += 1) {
  const c = cases[i], out = path.join(output, `${String(i).padStart(2, '0')}-${c.shape}-${c.mode}-${c.observe ? 'heavy' : 'minimal'}-probe${Number(c.probe)}.json`);
  process.stdout.write(JSON.stringify({ start: out }) + '\n');
  try {
    const run = await exec(process.execPath, [path.join(here, 'driver.mjs'), builds[c.mode], c.mode, c.shape, c.observe ? '1' : '0', out, c.probe ? '1' : '0', c.phases ? '1' : '0'], { maxBuffer: 8 * 1024 * 1024 });
    const raw = JSON.parse(await fs.readFile(out, 'utf8'));
    if (!raw.correctness.equal) throw new Error(`complete state mismatch: ${out}`);
    await fs.writeFile(out + '.log', run.stdout + run.stderr);
    process.stdout.write(JSON.stringify({ complete: out, correctness: true }) + '\n');
  } catch (error) { await fs.writeFile(out + '.error', String(error)); throw error; }
}
