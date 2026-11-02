/* global performance */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './node-profiler.mjs';

const output = process.argv[2];
if (!output?.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('isolated output required');
const source = await fs.readFile(fileURLToPath(import.meta.url));
const hash = createHash('sha256').update(source).digest('hex');
const n = 50_000;
const syncPlain = () => { for (let i = 0; i < n; i += 1) { const f = () => i; f(); } };
async function time(run) { const start = process.hrtime.bigint(); await run(); return Number(process.hrtime.bigint() - start) / 1e6; }
const node = globalThis.__p7Node;
const syncRaw = await time(syncPlain), syncWrapped = await time(() => { for (let i = 0; i < n; i += 1) node.phaseSync('calibration.sync', () => i, { workId: 'w', sourceVersion: i, structuralRevision: i }); });
const samplePlain = await time(() => { for (let i = 0; i < n; i += 1) { const start = performance.now(); const elapsed = performance.now() - start; if (elapsed < 0) throw new Error("clock moved backwards"); } });
const sampleWrapped = await time(() => { for (let i = 0; i < n; i += 1) { const start = performance.now(); node.phaseSample('calibration.next', start, { phaseName: 'host.cooperative-work', workId: 'w', sourceVersion: i, structuralRevision: i }); } });
const result = { scriptSha256: hash, sampleCount: n, syncPlainMs: syncRaw, syncWrappedMs: syncWrapped, syncIncrementalMsPerCall: (syncWrapped - syncRaw) / n, sliceTimerPlainMs: samplePlain, sliceSampleWrappedMs: sampleWrapped, sliceSampleIncrementalMs: (sampleWrapped - samplePlain) / n, method: 'separate non-Electron Node process, no-op synchronous span and phase-sample wrappers with correlation fields; gross wall-time overhead estimates, not subtracted from trial CPU or phase spans' };
await fs.writeFile(output, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result) + '\n');
