#!/usr/bin/env node
// Isolated measurement build. Never edits sourceRoot or its dependency graph.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freezeManifest } from './manifest.mjs';
import { observeCoreSource } from './phase-transform.mjs';
import { observeHostPhases } from './host-phase-transform.mjs';

const harness = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(process.argv[2] ?? path.join(harness, '../../..'));
const output = path.resolve(process.argv[3] ?? '/private/tmp/parley-s215-p7-head');
const mode = process.argv[4] ?? 'head';
if (!output.startsWith('/private/tmp/parley-s215-p7-')) throw new Error('P7 output must be an owned isolated /private/tmp/parley-s215-p7-* directory');
await fs.mkdir(output); // Existing evidence is never overwritten.
const provenance = { sourceRoot, output, mode, build: 'electron-vite production build, fixture instrumentation', behavioralPatches: [], transforms: [], copiedHashes: {} };
const hash = data => createHash('sha256').update(data).digest('hex');
await fs.copyFile(path.join(sourceRoot, 'package.json'), path.join(output, 'package.json'));
await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(output, 'node_modules'));
for (const name of ['core', 'protocol', 'host', 'noise', 'remote', 'desktop']) {
  const from = path.join(sourceRoot, 'packages', name), to = path.join(output, 'packages', name);
  await fs.mkdir(to, { recursive: true });
  await fs.copyFile(path.join(from, 'package.json'), path.join(to, 'package.json'));
  await fs.cp(path.join(from, 'node_modules'), path.join(to, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
  if (name !== 'desktop') await fs.cp(path.join(from, 'dist'), path.join(to, 'dist'), { recursive: true });
}
const hostFile = path.join(output, 'packages/host/dist/host.js');
const coreFile = path.join(output, 'packages/core/dist/work/context-pages.js');
if (mode === 'head') {
  const phaseFiles = {
    service: path.join(output, 'packages/host/dist/works/works-service.js'),
    sync: path.join(output, 'packages/host/dist/works/works-sync.js'),
    rows: path.join(output, 'packages/host/dist/works/sync-rows.js'),
  };
  const hostObserved = observeHostPhases(Object.fromEntries(await Promise.all(Object.entries(phaseFiles).map(async ([name, file]) => [name, await fs.readFile(file, 'utf8')]))));
  for (const name of Object.keys(phaseFiles)) await fs.writeFile(phaseFiles[name], hostObserved[name]);
  provenance.transforms.push({ files: Object.values(phaseFiles).map(file => path.relative(output, file)), kind: 'fixture-only behavior-preserving bounded host phase wrappers', phases: hostObserved.phases });
} else provenance.transforms.push({ files: [], kind: 'no matching host sync implementation exists in the historical base; no phase wrappers applied' });
const coreObservation = observeCoreSource(await fs.readFile(coreFile, 'utf8'));
await fs.writeFile(coreFile, coreObservation.source);
provenance.transforms.push({ file: 'packages/core/dist/work/context-pages.js', kind: 'AST synchronous try/finally spans only', phases: coreObservation.phases });
if (mode === 'head') {
  const source = await fs.readFile(hostFile, 'utf8');
  const anchor = 'const worksService = createWorksService(handle.context, {';
  if (source.split(anchor).length !== 2) throw new Error('Host opt-in anchor is not unique');
  const replacement = anchor + '\n        sync: { enabled: true },';
  await fs.writeFile(hostFile, source.replace(anchor, replacement));
  provenance.behavioralPatches.push({ file: 'packages/host/dist/host.js', before: anchor, after: replacement, sourceSha256: hash(source) });
}
await fs.cp(path.join(harness, 'node-profiler.mjs'), path.join(output, 'node-profiler.mjs'));
await fs.cp(path.join(harness, 'wire-meter.mjs'), path.join(output, 'wire-meter.mjs'));
await fs.cp(path.join(harness, 'main-profiler.mjs'), path.join(output, 'main-profiler.mjs'));
const nodeImport = `import ${JSON.stringify(pathToFileURL(path.join(output, 'node-profiler.mjs')).href)};\n`;
const hostEntry = path.join(output, 'packages/host/dist/main.js');
await fs.writeFile(hostEntry, nodeImport + await fs.readFile(hostEntry, 'utf8'));
provenance.transforms.push({ file: 'packages/host/dist/main.js', prepend: nodeImport });
const require = createRequire(path.join(sourceRoot, 'packages/desktop/package.json'));
const { build } = await import(pathToFileURL(require.resolve('electron-vite')).href);
const profileSource = await fs.readFile(path.join(harness, 'renderer-profiler.ts'), 'utf8');
// Relative imports in the fixture profiler resolve against the selected baseline/head source.
const profileFile = path.join(output, 'renderer-profiler.ts');
await fs.writeFile(profileFile, profileSource
  .replace("import * as protocol from '@parley/protocol';", mode === 'head' ? `import { WorksSyncReducer, WorksMailStateAssembler } from ${JSON.stringify(path.join(sourceRoot, 'packages/protocol/dist/index.js'))};\nconst protocol = { WorksSyncReducer, WorksMailStateAssembler };` : 'const protocol = {};')
  .replace('../../../packages/desktop/src/renderer/store/works.js', path.join(sourceRoot, 'packages/desktop/src/renderer/store/works.ts')));
const configFile = path.join(output, 'p7.electron.config.mjs');
const prepend = `import ${JSON.stringify(profileFile)};\n`;
const configSource = `import config from ${JSON.stringify(path.join(sourceRoot, 'packages/desktop/electron.vite.config.ts'))};
import { observeRootsSource } from ${JSON.stringify(path.join(harness, 'phase-transform.mjs'))};
config.main.build = { ...config.main.build, outDir: ${JSON.stringify(path.join(output, 'packages/desktop/out/main'))} };
config.preload.build = { ...config.preload.build, outDir: ${JSON.stringify(path.join(output, 'packages/desktop/out/preload'))} };
config.renderer.build = { ...config.renderer.build, outDir: ${JSON.stringify(path.join(output, 'packages/desktop/out/renderer'))} };
config.renderer.plugins.push({ name: 'p7-observe-entry', transform(source, id) {
  if (!/\\/src\\/renderer\\/(main|island\\/main)\\.tsx$/.test(id)) return;
  return ${JSON.stringify(prepend)} + source;
} });
config.main.plugins.push({ name: 'p7-observe-roots', transform(source, id) {
  if (!id.endsWith('/src/main/roots.ts')) return;
  return observeRootsSource(source).source;
} });
export default config;\n`;
await fs.writeFile(configFile, configSource);
provenance.transforms.push({ file: 'renderer/main.tsx and island.tsx', prepend, profilerSha256: hash(profileSource) });
provenance.transforms.push({ file: 'main/roots.ts', kind: 'AST synchronous try/finally spans in existing roots reconcile/apply/install callbacks', scheduling: 'same calls, returns and awaits' });
const cwd = process.cwd(); process.chdir(path.join(sourceRoot, 'packages/desktop'));
try {
  await build({ configFile, logLevel: 'warn' });
} finally { process.chdir(cwd); }
const mainEntry = path.join(output, 'packages/desktop/out/main/index.js');
const mainImport = `import ${JSON.stringify(pathToFileURL(path.join(output, 'main-profiler.mjs')).href)};\n`;
await fs.writeFile(mainEntry, mainImport + await fs.readFile(mainEntry, 'utf8'));
provenance.transforms.push({ file: 'packages/desktop/out/main/index.js', prepend: mainImport });
const preloadObserver = await fs.readFile(path.join(harness, 'preload-profiler.cjs'), 'utf8');
for (const name of ['index', 'island']) {
  const file = path.join(output, `packages/desktop/out/preload/${name}.js`);
  await fs.writeFile(file, preloadObserver + '\n' + await fs.readFile(file, 'utf8'));
  provenance.transforms.push({ file: path.relative(output, file), prependSha256: hash(preloadObserver) });
}
for (const file of [hostFile, hostEntry, mainEntry, path.join(output, 'node-profiler.mjs'), profileFile]) provenance.copiedHashes[path.relative(output, file)] = hash(await fs.readFile(file));
await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
const manifest = await freezeManifest({ sourceRoot, output, harness, runtime: '/private/tmp/parley-s215-electron44-dist' });
process.stdout.write(JSON.stringify({ output, provenance: path.join(output, 'provenance.json'), manifest }) + '\n');
