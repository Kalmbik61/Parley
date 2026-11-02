// Preliminary observer calibration/readiness, not the final alternating P7 matrix.
import fs from 'node:fs/promises';
import path from 'node:path';
import { supportedTrial } from './driver.mjs';
const output = process.argv[2] ?? '/private/tmp/parley-s215-p7-calibration-pilot';
await fs.mkdir(output);
const declarations = { purpose: 'observer on/off readiness and preliminary calibration only', shapes: ['small', 'short3k'], cases: [{ mode: 'base', observe: false }, { mode: 'base', observe: true }, { mode: 'head', observe: true }, { mode: 'head', observe: false }], base: '/private/tmp/parley-s215-p7-base-v4', head: '/private/tmp/parley-s215-p7-head-v7', finalGate: 'not evaluated; one preliminary control per combination' };
await fs.writeFile(path.join(output, 'declaration.json'), JSON.stringify(declarations, null, 2));
for (const shape of declarations.shapes) for (const entry of declarations.cases) {
  const file = path.join(output, `${shape}-${entry.mode}-${entry.observe ? 'on' : 'off'}.json`);
  process.stdout.write(JSON.stringify({ start: file }) + '\n');
  try {
    const result = await supportedTrial({ ...entry, shape, build: declarations[entry.mode] });
    await fs.writeFile(file, JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify({ complete: file, edits: result.edits.length, home: result.home }) + '\n');
  } catch (error) { await fs.writeFile(file, JSON.stringify({ error: String(error) }, null, 2)); throw error; }
}
