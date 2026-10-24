import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CheckSpec } from '@parley/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptsEngineGitPath } from '../agent/attempts-endpoint.js';
import { run } from './check-runner.js';

// Only the unavailable macOS boundary is simulated; clones and candidate processes are real.
const boundary = vi.hoisted(() => ({ native: false, unavailable: '', kernelOnly: false, logs: '', dirty: false, wrongHead: false, postLogFailure: false, queries: 0, stamps: [] as string[] }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const intercepted = (file: string, args: string[], ...rest: any[]) => {
      if (!boundary.native && file === '/usr/bin/sandbox-exec') {
        return actual.execFile(boundary.unavailable === 'sandbox' ? '/nonexistent/sandbox-exec' : '/usr/bin/true', [], ...rest);
      }
      if (!boundary.native && file === '/usr/bin/log') {
        boundary.queries++;
        boundary.stamps.push(args[args.indexOf('--start') + 1]!, args[args.indexOf('--end') + 1]!);
        if ((boundary.kernelOnly && !args[args.indexOf('--predicate') + 1]?.includes('sender == \"Sandbox\"')) || boundary.unavailable === 'log' || (boundary.postLogFailure && boundary.queries > 1)) {
          return actual.execFile('/nonexistent/log', [], ...rest);
        }
        return actual.execFile('/usr/bin/printf', ['%s', boundary.queries > 1 ? boundary.logs : ''], ...rest);
      }
      if (!boundary.native && args.includes('status') && boundary.dirty) return actual.execFile('/usr/bin/printf', ['?? unexpected\n'], ...rest);
      if (!boundary.native && args.includes('rev-parse') && args.includes('HEAD') && boundary.wrongHead) return actual.execFile('/usr/bin/printf', ['0'.repeat(40)], ...rest);
      return actual.execFile(file, args, ...rest);
  };
  Object.defineProperty(intercepted, Symbol.for('nodejs.util.promisify.custom'), { value: (...args: any[]) => new Promise((resolve, reject) => {
    (intercepted as any)(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
  }) });
  return {
    ...actual,
    execFile: intercepted,
    spawn: (file: string, args: string[], options: any) => !boundary.native && file === '/usr/bin/sandbox-exec'
      ? actual.spawn(args[2]!, args.slice(3), options)
      : actual.spawn(file, args, options),
  };
});
const exec = promisify(execFile);
const roots: string[] = [];
beforeEach(() => Object.assign(boundary, { native: false, unavailable: '', kernelOnly: false, logs: '', dirty: false, wrongHead: false, postLogFailure: false, queries: 0, stamps: [] as string[] }));
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = path.resolve('.parley/check-runner-tests');
  await mkdir(base, { recursive: true });
  const projectPath = await mkdtemp(path.join(base, 'case-')); roots.push(projectPath);
  const git = async (...args: string[]) => (await exec('git', ['-C', projectPath, ...args])).stdout.trim();
  await git('init', '-b', 'main');
  for (const file of ['test.js', 'runner.config.js', 'fixture.txt', 'package.json']) await writeFile(path.join(projectPath, file), file === 'package.json' ? '{}' : 'initial');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture');
  const sha = await git('rev-parse', 'HEAD');
  const engine = attemptsEngineGitPath(projectPath, 'w-01');
  await mkdir(path.dirname(engine), { recursive: true });
  await exec('git', ['clone', '--bare', '--no-hardlinks', projectPath, engine]);
  const ctx = { projectPath, workId: 'w-01', planId: 'pl-01', resultId: 'cr-01' };
  const spec: CheckSpec = { id: 'check', item: 1, argv: [process.execPath, '-e', 'console.log("ok")'], cwd: '.', env: {}, inputs: [], timeoutMs: 2000, frozenAt: '2026-10-24T00:00:00.000Z' };
  const checkDir = path.join(projectPath, '.parley/works/w-01/autonomous/pl-01/attempts/at-01/checks/check');
  return { ctx, spec, sha, git, engine, checkDir };
}

it('runs the captured SHA from engine.git and retains output after checkout cleanup', async () => {
  const f = await fixture();
  const result = await run(f.ctx, f.spec, f.sha, 'at-01');
  expect(result).toMatchObject({ id: 'cr-01', specId: 'check', attemptId: 'at-01', sha: f.sha, verdict: 'pass', by: 'engine', inputsOk: true, exitCode: 0 });
  expect(await readFile(result.outputTail!, 'utf8')).toBe('ok\n');
  await expect(access(path.join(f.checkDir, 'checkout'))).rejects.toThrow();
});

it.each(['sandbox', 'log'])('does not launch without %s confinement capability', async unavailable => {
  const f = await fixture(); boundary.unavailable = unavailable;
  const result = await run(f.ctx, f.spec, f.sha, 'at-01');
  expect(result).toMatchObject({ verdict: 'error', summary: 'confinement-unavailable', outputTail: null });
  await expect(access(f.checkDir)).rejects.toThrow();
});
it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_DEBUG', 'OPENAI_BASE_URL', 'GITHUB_TOKEN', 'SERVICE_KEY', 'SERVICE_SECRET'])('rejects secret environment variable %s before launch', async key => {
  const f = await fixture(); f.spec.env[key] = 'secret';
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'error', summary: 'env-not-allowed', outputTail: null });
});
it.each(['unknown', 'mismatch', 'dirty'])('rejects an %s checkout and cleans it', async kind => {
  const f = await fixture(); boundary.wrongHead = kind === 'mismatch'; boundary.dirty = kind === 'dirty';
  const result = await run(f.ctx, f.spec, kind === 'unknown' ? 'a'.repeat(40) : f.sha, 'at-01');
  expect(result.verdict).toBe('error');
  expect(result.inputsOk).toBe(false);
  if (kind !== 'unknown') expect(result.summary).toBe(kind === 'dirty' ? 'checkout-not-clean' : 'checkout-sha-mismatch');
  expect(await readFile(result.outputTail!, 'utf8')).toBe('');
  await expect(access(path.join(f.checkDir, 'checkout'))).rejects.toThrow();
});
it.each(['test.js', 'runner.config.js', 'fixture.txt', 'package.json'])('rejects the changed frozen input %s', async file => {
  const f = await fixture();
  f.spec.inputs = [{ path: file, blob: await f.git('rev-parse', `${f.sha}:${file}`) }];
  await writeFile(path.join(f.ctx.projectPath, file), 'changed'); await f.git('add', file);
  await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Candidate');
  const candidate = await f.git('rev-parse', 'HEAD');
  await exec('git', ['--git-dir', f.engine, 'fetch', f.ctx.projectPath, candidate]);
  expect(await run(f.ctx, f.spec, candidate, 'at-01')).toMatchObject({ verdict: 'error', inputsOk: false, summary: `frozen-inputs-changed: ${file}` });
});
it('accepts an unchanged frozen blob', async () => {
  const f = await fixture(); f.spec.inputs = [{ path: 'test.js', blob: await f.git('rev-parse', `${f.sha}:test.js`) }];
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'pass', inputsOk: true });
});
it.each(['direct', 'child'])('overrides a zero exit with %s sandbox denial evidence', async kind => {
  const f = await fixture();
  f.spec.argv = [process.execPath, '-e', kind === 'child'
    ? 'require("child_process").spawnSync(process.execPath,["-e","process.exit(1)"]); console.log("parent masks failure")'
    : 'console.log("handled EPERM; zero exit")'];
  boundary.logs = `2026-10-24 sandboxd[1:2] [com.apple.sandbox.reporting:violation] Sandbox: node(999999) deny(1) file-write-create ${f.ctx.projectPath}/outside.txt`;
  const result = await run(f.ctx, f.spec, f.sha, 'at-01');
  expect(result).toMatchObject({ verdict: 'error', exitCode: 0 });
  expect(result.summary).toContain('write-outside-root (sandbox log)');
});
it('ignores journal events within allowed roots', async () => {
  const f = await fixture(); boundary.logs = `Sandbox: node(999999) deny(1) file-write-create ${f.checkDir}/checkout/allowed`;
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'pass' });
});
it('fails closed if the journal becomes unavailable after launch', async () => {
  const f = await fixture(); boundary.postLogFailure = true;
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'error', summary: 'confinement-unavailable (sandbox log)' });
});
it('reports an unclassified signal without claiming a sandbox violation', async () => {
  const f = await fixture(); f.spec.argv = [process.execPath, '-e', 'process.kill(process.pid,"SIGKILL")'];
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'error', exitCode: null, summary: 'killed-by-signal: SIGKILL' });
});
it('times out, retains a bounded stdout/stderr tail, and cleans descendants and checkout', async () => {
  const f = await fixture(); f.spec.timeoutMs = 300;
  f.spec.argv = [process.execPath, '-e', 'require("fs").writeSync(1,"x".repeat(70000)); require("fs").writeSync(2,"END"); setInterval(()=>{},1000)'];
  const result = await run(f.ctx, f.spec, f.sha, 'at-01');
  expect(result).toMatchObject({ verdict: 'error', summary: 'timeout' });
  const output = await readFile(result.outputTail!);
  expect(output.length).toBe(65536); expect(output.subarray(-3).toString()).toBe('END');
  await expect(access(path.join(f.checkDir, 'checkout'))).rejects.toThrow();
});
it('maps an ordinary nonzero exit to fail', async () => {
  const f = await fixture(); f.spec.argv = [process.execPath, '-e', 'console.error("failed");process.exit(1)'];
  const result = await run(f.ctx, f.spec, f.sha, 'at-01');
  expect(result).toMatchObject({ verdict: 'fail', exitCode: 1 }); expect(await readFile(result.outputTail!, 'utf8')).toBe('failed\n');
});
it('uses only spec.env and private HOME/TMPDIR, and records stable canonical identity', async () => {
  const f = await fixture(); f.spec.env = { Z: 'last', A: 'first', HOME: '/ignored', TMPDIR: '/ignored' };
  f.spec.argv = [process.execPath, '-e', 'console.log(JSON.stringify(process.env))'];
  const result = await run({ ...f.ctx, now: () => new Date('2026-10-24T01:02:03Z') }, f.spec, f.sha, 'at-01');
  expect(result.verdict).toBe('pass');
  // Node on macOS inserts this platform bookkeeping variable even with an explicit env.
  const { __CF_USER_TEXT_ENCODING: _encoding, ...environment } = JSON.parse(await readFile(result.outputTail!, 'utf8'));
  expect(environment).toEqual({ Z: 'last', A: 'first', HOME: path.join(f.checkDir, 'tmp/home'), TMPDIR: path.join(f.checkDir, 'tmp') });
  const digest = (json: string) => createHash('sha256').update(json).digest('hex');
  expect(result.envHash).toBe(digest('{"A":"first","HOME":"/ignored","TMPDIR":"/ignored","Z":"last"}'));
  expect(result.argvHash).toBe(digest(JSON.stringify(f.spec.argv)));
  expect(result.at).toBe('2026-10-24T01:02:03.000Z'); expect(result.durationMs).toBeGreaterThanOrEqual(0);
});
it('never runs from a cwd outside checkout', async () => {
  const f = await fixture(); f.spec.cwd = '..';
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'error', summary: 'cwd-outside-checkout' });
});

// Explicit opt-in: run outside Codex's nested sandbox. All escape targets are disposable fixtures.
describe.skipIf(process.env.PARLEY_TEST_NATIVE_SANDBOX !== '1')('native macOS confinement', () => {
  beforeEach(async () => {
    boundary.native = true;
    // The runner intentionally includes a one-second margin around the journal window.
    await new Promise(resolve => setTimeout(resolve, 1100));
  });
  it.each(['clean', 'direct', 'child', 'different-child', 'missing-command'])('enforces and observes a real %s candidate', async kind => {
    const f = await fixture();
    const outside = path.join(f.ctx.projectPath, 'outside.txt');
    const attack = `try{require('fs').writeFileSync(${JSON.stringify(outside)},'escape')}catch(e){console.log(e.code)}`;
    f.spec.argv = [process.execPath, '-e', kind === 'clean' ? 'console.log("clean")' : kind === 'direct' ? attack
      : kind === 'different-child' ? `require('child_process').spawnSync('/bin/sh',['-c','printf escape > \"$1\"','sh',${JSON.stringify(outside)}]); console.log('masked');`
      : `require('child_process').spawnSync(process.execPath,['-e',${JSON.stringify(attack)}]); console.log('masked');`];
    if (kind === 'missing-command') f.spec.argv = ['/nonexistent/check-command'];
    const result = await run(f.ctx, f.spec, f.sha, 'at-01');
    expect(result.verdict).toBe(kind === 'clean' ? 'pass' : 'error');
    if (kind !== 'clean') {
      expect(result.summary).toContain(kind === 'missing-command' ? 'launch-failed' : kind === 'different-child' ? 'write-outside-root (sandbox log, unattributed)' : 'write-outside-root (sandbox log)');
      await expect(access(outside)).rejects.toThrow();
    }
    if (kind === 'child') expect(result.exitCode).toBe(0);
    await expect(access(path.join(f.checkDir, 'checkout'))).rejects.toThrow();
  });
});

it('reports an unavailable executable as a launch error', async () => {
  const f = await fixture(); f.spec.argv = ['/nonexistent/check-command'];
  const result = await run(f.ctx, f.spec, f.sha, 'at-01');
  expect(result.verdict).toBe('error'); expect(result.summary).toContain('launch-failed');
});
it('refuses a project rooted in the default temporary write area', async () => {
  const f = await fixture(); vi.stubEnv('TMPDIR', f.ctx.projectPath);
  try {
    const result = await run(f.ctx, f.spec, f.sha, 'at-01');
    expect(result).toMatchObject({ verdict: 'error', summary: 'check-directory-in-temporary-root', outputTail: null });
  } finally { vi.unstubAllEnvs(); }
});

it('fails closed for an unattributed child executable in the journal window', async () => {
  const f = await fixture();
  boundary.logs = `Sandbox: renamed-child(999999) deny(1) file-write-create ${f.ctx.projectPath}/elsewhere`;
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'error', summary: expect.stringContaining('write-outside-root (sandbox log, unattributed)') });
});

it('passes log show timestamps with whole seconds and an explicit UTC offset', async () => {
  const f = await fixture();
  expect((await run(f.ctx, f.spec, f.sha, 'at-01')).verdict).toBe('pass');
  expect(boundary.stamps).toHaveLength(4);
  for (const stamp of boundary.stamps) expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+0000$/);
});

it.each(['kernel[0:1] (Sandbox) Sandbox:', 'kernel[0:1] (Sandbox) 13 duplicate reports for Sandbox:'])('reads kernel denial records: %s', async prefix => {
  const f = await fixture(); boundary.kernelOnly = true;
  boundary.logs = `${prefix} node(999999) deny(1) file-write-create ${f.ctx.projectPath}/outside`;
  expect(await run(f.ctx, f.spec, f.sha, 'at-01')).toMatchObject({ verdict: 'error', summary: expect.stringContaining('write-outside-root (sandbox log)') });
});
