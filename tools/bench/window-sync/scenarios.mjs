// Isolated full application scenarios; raw evidence, never an automatic PASS.
import fs from 'node:fs/promises';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
import { launchFixture } from './driver.mjs';
const [output, scenario, mode = 'head', observed = '1'] = process.argv.slice(2);
const observe = observed !== '0';
if (!output?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('isolated output required');
const build = mode === 'head' ? '/private/tmp/parley-s215-p7-head-repaired-v1' : '/private/tmp/parley-s215-p7-base-repaired-observers-v1';
const shape = scenario === 'sustained' || scenario === 'evolution' ? 'cold1' : scenario === 'mail' ? 'short3k' : scenario;
await fs.writeFile(output + '.declaration.json', JSON.stringify({ scenario, mode, shape, build, heavyObservation: observe, island: false, candidateBytes: 524288, referenceHz: 60, synchronousP95BudgetMs: 16.7, sustained: '300 writes at100ms intervals for30s; commit probe uses source versions; final full-state digest', baselineOversized: 'no completion expected; no latency parity' }, null, 2));
const f = await launchFixture({ build, mode, shape, observe });
try {
  const started = Date.now();
  try { await f.ready(60000); }
  catch (error) {
    await fs.writeFile(output, JSON.stringify({ scenario, mode, home: f.home, completed: false, error: String(error), raw: await f.collect() }, null, 2));
    throw error;
  }
  const coldReadyWallMs = Date.now() - started;
  let processBefore = null;
  const edits = [];
  if (scenario === 'sustained') {
    processBefore = await f.reset();
    await new Promise((resolve, reject) => {
      let sent = 0; const pending = [];
      const timer = setInterval(() => {
        const index = sent++;
        pending.push(f.command('edit', { text: (`sustained-${index}:` + 'x'.repeat(4096)).slice(0, 4096) }).then(edit => edits.push(edit)));
        if (sent === 300) { clearInterval(timer); Promise.all(pending).then(resolve, reject); }
      }, 100);
    });
    const last = edits.at(-1); await f.waitVersion(last.workId, last.version, 60000);
  } else if (scenario === 'evolution') {
    processBefore = await f.reset();
    for (const command of ['dense', 'nochange', 'edit']) {
      const edit = await f.command(command, { text: (command + ':').padEnd(4096, 'e') }); edits.push(edit);
      await f.waitVersion(edit.workId, edit.version, 60000);
    }
  } else if (scenario === 'mail') {
    processBefore = await f.reset();
    for (let i = 0; i < 10; i += 1) { edits.push(await f.command('mail', { work: 20 })); await new Promise(resolve => setTimeout(resolve, 200)); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const raw = await f.collect();
  await fs.writeFile(output, JSON.stringify({ ...raw, scenario, completed: true, coldReadyWallMs, processBefore, edits, correctness: await f.checkState(), gates: 'not evaluated; heavy observation overhead and task/phase completeness require independent review' }, null, 2));
  process.stdout.write(JSON.stringify({ output, home: f.home, scenario, completed: true }) + '\n');
} finally { await f.cleanup(); }
