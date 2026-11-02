import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const hash = data => createHash('sha256').update(data).digest('hex');
async function files(root, exclude = new Set()) {
  const rows = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (exclude.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { rows.push({ path: path.relative(root, file), link: await fs.readlink(file), resolved: await fs.realpath(file).catch(() => null) }); continue; }
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { const data = await fs.readFile(file); rows.push({ path: path.relative(root, file), bytes: data.length, sha256: hash(data) }); }
    }
  }
  await walk(root); return rows.sort((a, b) => a.path.localeCompare(b.path));
}
export async function freezeManifest({ sourceRoot, output, harness, runtime }) {
  const source = {};
  for (const name of ['core', 'protocol', 'host', 'noise', 'remote', 'desktop']) source[name] = await files(path.join(sourceRoot, 'packages', name), new Set(['node_modules', 'dist', 'out', 'out-tsc', 'test-results', '.vite', '.cache']));
  const dependencies = {}, seen = new Set();
  async function dependency(dir) {
    dir = await fs.realpath(dir); if (seen.has(dir)) return; seen.add(dir);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    dependencies[dir] = { name: pkg.name, version: pkg.version, files: await files(dir, new Set(['node_modules', '.git'])), optionalMissing: [] };
    const require = createRequire(path.join(dir, 'package.json'));
    for (const name of new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})])) {
      let candidate;
      try { candidate = path.dirname(require.resolve(name + '/package.json')); }
      catch {
        try {
          candidate = path.dirname(require.resolve(name));
          while (JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
            const parent = path.dirname(candidate); if (parent === candidate) throw new Error('package boundary missing'); candidate = parent;
          }
        } catch (error) { if (name in (pkg.optionalDependencies ?? {})) { dependencies[dir].optionalMissing.push(name); continue; } throw new Error(`Unresolved runtime dependency ${pkg.name} -> ${name}: ${error}`); }
      }
      await dependency(candidate);
    }
  }
  for (const name of ['core', 'protocol', 'host', 'noise', 'remote', 'desktop']) await dependency(path.join(output, 'packages', name));
  const driverRequire = createRequire(path.join(sourceRoot, 'packages/desktop/package.json'));
  for (const name of ['@playwright/test', 'typescript']) await dependency(path.dirname(driverRequire.resolve(name + '/package.json')));
  const git = await exec('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }).catch(() => ({ stdout: 'archive33e3761b(no.git)' }));
  const diff = await exec('git', ['diff', '--binary', 'HEAD'], { cwd: sourceRoot, maxBuffer: 32 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  const status = await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceRoot, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
  await fs.writeFile(path.join(output, 'source.diff'), diff.stdout);
  const manifest = { gitRevision: git.stdout.trim(), dirtyStatus: status.stdout, trackedDiffSha256: hash(diff.stdout), lockfileSha256: hash(await fs.readFile(path.join(sourceRoot, 'pnpm-lock.yaml'))), source, artifacts: await files(output, new Set(['node_modules', 'manifest.json'])), observers: await files(harness, new Set(['node_modules'])), dependencies, runtime: await files(runtime), notes: 'All actual copied package outputs/bundles/config and resolved runtime dependency files are hashed; links and real targets recorded. Source includes untracked implementation files. Base is archive33e3761b.' };
  const serialized = JSON.stringify(manifest, null, 2);
  await fs.writeFile(path.join(output, 'manifest.json'), serialized);
  return { path: path.join(output, 'manifest.json'), sha256: hash(serialized) };
}
