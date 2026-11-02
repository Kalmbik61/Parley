#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(process.argv[2] ?? '.');
const base = '/private/tmp/parley-s215-p7-base-source';
await fs.mkdir(base);
const { stdout } = await exec('git', ['archive', '--format=tar', '33e3761b'], { cwd: root, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
const archive = path.join(base, 'source.tar'); await fs.writeFile(archive, stdout);
await exec('tar', ['-xf', archive, '-C', base]);
await fs.symlink(path.join(root, 'node_modules'), path.join(base, 'node_modules'));
for (const name of await fs.readdir(path.join(base, 'packages'))) {
  const from = path.join(root, 'packages', name, 'node_modules');
  try { await fs.lstat(from); } catch { continue; }
  await fs.cp(from, path.join(base, 'packages', name, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
}
process.stdout.write(JSON.stringify({ source: base, ref: '33e3761b', dependencyGraph: 'shared isolated worktree packages, no install', archiveBytes: stdout.length }) + '\n');
