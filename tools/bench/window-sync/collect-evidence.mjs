// Preserve raw P7 evidence in the working tree; originals remain untouched in /tmp.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
const destination = process.argv[2];
if (!destination?.endsWith('/window-sync-p7-s215')) throw new Error('explicit evidence destination required');
await fs.mkdir(destination, { recursive: false });
const index = [], seen = new Set();
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function save(source, label) {
  if (seen.has(source)) return;
  await fs.stat(source); seen.add(source);
  const target = path.join(destination, label + '.gz'); await fs.mkdir(path.dirname(target), { recursive: true });
  await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(target, { flags: 'wx' }));
  index.push({ source, path: path.relative(destination, target), rawBytes: (await fs.stat(source)).size, rawSha256: await digest(source), gzipBytes: (await fs.stat(target)).size, gzipSha256: await digest(target) });
}
async function raw(source, label) {
  await save(source, label);
  if (!source.endsWith('.json')) return;
  const r = JSON.parse(await fs.readFile(source, 'utf8'));
  const trace = r.trace ?? r.raw?.trace;
  if (trace) await save(trace, label.replace(/\.json$/, '') + '-electron-trace.json');
}
for (const name of ['paired-v1', 'calibration-v3']) {
  const directory = '/private/tmp/parley-s215-p7-' + name;
  for (const file of (await fs.readdir(directory)).sort()) if (file.endsWith('.json') || file.endsWith('.log')) await raw(path.join(directory, file), path.join(name, file));
  await save(directory + '-summary.json', name + '/summary.json');
}
for (const name of ['huge-v1', 'huge-v2', 'cold30-v1', 'nearcap-v1', 'sustained-v1', 'sustained-minimal-v1', 'mail-v1', 'recovery-v1']) {
  const source = '/private/tmp/parley-s215-p7-' + name + '.json';
  await raw(source, name + '/raw.json');
  await save(source + '.declaration.json', name + '/declaration.json').catch(error => { if (error.code !== 'ENOENT') throw error; });
  await save(source.replace(/\.json$/, '-summary.json'), name + '/summary.json').catch(error => { if (error.code !== 'ENOENT') throw error; });
  const r = JSON.parse(await fs.readFile(source, 'utf8')), home = r.home ?? r.failed?.home;
  for (const file of await fs.readdir(home)) if (file.endsWith('.png') || file.startsWith('correctness-') || file === 'host-stderr.log') await save(path.join(home, file), path.join(name, file));
}
for (const [name, directory] of [['head-v9', '/private/tmp/parley-s215-p7-head-v9'], ['base-v6', '/private/tmp/parley-s215-p7-base-v6']]) for (const file of ['manifest.json', 'provenance.json', 'source.diff']) await save(path.join(directory, file), path.join(name, file));
for (const name of ['paired-v1-observers', 'huge-v2-observers']) {
  const directory = '/private/tmp/parley-s215-p7-' + name;
  for (const file of (await fs.readdir(directory)).sort()) await save(path.join(directory, file), path.join(name, file));
}
await fs.writeFile(path.join(destination, 'index.json'), JSON.stringify({ verdict: 'FAIL: sustained progress/lag gate; other missing/confounded checks never imply PASS', format: 'gzip copies; hashes cover both original raw and gzip file; absolute original paths remain available', files: index }, null, 2));
process.stdout.write(JSON.stringify({ destination, files: index.length, gzipBytes: index.reduce((n, f) => n + f.gzipBytes, 0), rawBytes: index.reduce((n, f) => n + f.rawBytes, 0) }) + '\n');
