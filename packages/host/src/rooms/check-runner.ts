import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENGINE, workPaths, type CheckResult, type CheckSpec } from '@parley/core';
import { attemptsEngineGitPath } from '../agent/attempts-endpoint.js';

export interface CheckRunnerContext {
  projectPath: string;
  workId: string;
  planId: string;
  resultId: string;
  now?: () => Date;
}
const exec = promisify(execFile);
// Depending on macOS reporting state, denials come from sandboxd or directly from the kernel.
const predicate = '(subsystem == \"com.apple.sandbox.reporting\" OR sender == \"Sandbox\") AND eventMessage CONTAINS \"deny(1)\"';
const tailLimit = 64 * 1024;
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  : JSON.stringify(value)!;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const inside = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);
const identifier = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
function specDirectory(id: string): string {
  let encoded: string;
  try { encoded = encodeURIComponent(id).replace(/\./g, '%2E'); } catch { return hash(id); }
  // Hash every ID so a short literal cannot alias a truncated long ID's directory.
  return `${encoded.slice(0, 31)}-${hash(id).slice(0, 32)}`;
}
const stamp = (date: Date) => date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+0000');

async function sandboxLog(start: Date, end: Date): Promise<string> {
  return (await exec('/usr/bin/log', ['show', '--start', stamp(start), '--end', stamp(end), '--style', 'compact', '--predicate', predicate], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

function outsideWrites(log: string, pid: number | undefined, executable: string, roots: string[]): { lines: string[]; attributed: boolean } {
  const lines: string[] = [];
  let attributed = false;
  for (const line of log.split('\n')) {
    const write = /deny\(1\)\s+file-write\S*\s+(.+)$/.exec(line);
    if (!write || roots.some(root => inside(root, write[1]!.trim()))) continue;
    const process = /Sandbox:\s+(.+)\((\d+)\)\s+deny/.exec(line);
    const related = process && (Number(process[2]) === pid || path.basename(process[1]!) === path.basename(executable))
      || roots.some(root => line.includes(root));
    // Short-lived renamed children cannot be reliably attributed by name/PID. Fail closed
    // for every outside write in the window, accepting concurrent-host false positives.
    attributed ||= !!related;
    lines.push(line);
  }
  return { lines, attributed };
}

/** Run only a frozen check from the engine's captured commit; the engine owns result IDs. */
export async function run(ctx: CheckRunnerContext, spec: CheckSpec, sha: string, attemptId: string): Promise<CheckResult> {
  const started = Date.now();
  const now = ctx.now ?? (() => new Date());
  const result: CheckResult = {
    id: ctx.resultId, specId: spec.id, attemptId, sha, argvHash: hash(spec.argv), envHash: hash(spec.env),
    inputsOk: false, verdict: 'error', by: ENGINE, exitCode: null, summary: '', outputTail: null,
    at: now().toISOString(), durationMs: 0,
  };
  let checkout: string | undefined;
  let ownsCheckout = false;
  let tmp: string | undefined;
  let tail = Buffer.alloc(0);
  const append = (data: Buffer) => { tail = Buffer.concat([tail, data]).subarray(-tailLimit); };
  try {
    try {
      await exec('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000 });
      const probe = new Date();
      await sandboxLog(new Date(probe.getTime() - 1000), probe);
    } catch {
      result.summary = 'confinement-unavailable'; return result;
    }
    if (Object.keys(spec.env).some(key => /^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)|_(TOKEN|KEY|SECRET)$/i.test(key))) {
      result.summary = 'env-not-allowed'; return result;
    }
    if (![ctx.workId, ctx.planId, attemptId, ctx.resultId].every(identifier)
      || !spec.id
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)
      || !spec.argv.length || !spec.argv[0] || !(spec.timeoutMs > 0 && spec.timeoutMs <= 2_147_483_647)) {
      result.summary = 'invalid-check'; return result;
    }
    const project = await realpath(ctx.projectPath);
    for (const candidate of ['/tmp', '/private/tmp', process.env.TMPDIR].filter((root): root is string => !!root)) {
      const root = await realpath(candidate).catch(() => path.resolve(candidate));
      if (inside(root, project)) { result.summary = 'check-directory-in-temporary-root'; return result; }
    }
    const specDir = path.join(workPaths(project, ctx.workId).dir, 'autonomous', ctx.planId, 'attempts', attemptId, 'checks', specDirectory(spec.id));
    await mkdir(specDir, { recursive: true });
    if (await realpath(specDir) !== specDir) throw new Error('check-directory-outside-root');
    const dir = path.join(specDir, ctx.resultId);
    try { await mkdir(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      result.summary = 'result-already-exists'; return result;
    }
    checkout = path.join(dir, 'checkout');
    tmp = path.join(dir, 'tmp');
    await mkdir(path.join(tmp, 'home'), { recursive: true });
    result.outputTail = path.join(dir, 'output.tail');
    // Host git must not inherit a caller's GIT_DIR, filters, hooks or alternate object store.
    const gitEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env: gitEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
    ownsCheckout = true;
    await git('-c', 'init.templateDir=', 'clone', '--no-hardlinks', '--no-checkout', '--', attemptsEngineGitPath(project, ctx.workId), checkout);
    try { await access(path.join(checkout, '.git/objects/info/alternates')); throw new Error('checkout-has-alternates'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await git('-C', checkout, 'checkout', '--detach', sha);
    if (await git('-C', checkout, 'rev-parse', 'HEAD') !== sha) throw new Error('checkout-sha-mismatch');
    if (await git('-C', checkout, 'status', '--porcelain', '--untracked-files=all')) throw new Error('checkout-not-clean');
    const changed: string[] = [];
    for (const input of spec.inputs) {
      try {
        const blob = await git('-C', checkout, 'rev-parse', `${sha}:${input.path}`);
        if (blob !== input.blob || await git('-C', checkout, 'cat-file', '-t', blob) !== 'blob') changed.push(input.path);
      } catch { changed.push(input.path); }
    }
    if (changed.length) { result.summary = `frozen-inputs-changed: ${changed.join(', ')}`; return result; }
    result.inputsOk = true;
    const cwd = await realpath(path.resolve(checkout, spec.cwd));
    if (!inside(checkout, cwd)) throw new Error('cwd-outside-checkout');
    const commandPaths = spec.argv[0]!.includes('/') ? [path.resolve(cwd, spec.argv[0]!)]
      : (spec.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(root => path.resolve(cwd, root, spec.argv[0]!));
    let executable = false;
    for (const command of commandPaths) {
      try { await access(command, constants.X_OK); if ((await stat(command)).isFile()) { executable = true; break; } } catch { /* Try the next explicit PATH entry. */ }
    }
    if (!executable) { result.summary = 'launch-failed: executable-unavailable'; return result; }
    const profile = path.join(dir, 'profile.sb');
    const template = await readFile(new URL('../../../../scripts/gates/runner-profile-kill.sb', import.meta.url), 'utf8');
    await writeFile(profile, template.replace('__CHECKOUT__', JSON.stringify(checkout)).replace('__TMP__', JSON.stringify(tmp)));
    const windowStart = new Date();
    let pid: number | undefined;
    let timedOut = false;
    let launchError: Error | undefined;
    let signal: NodeJS.Signals | null = null;
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, ...spec.argv], {
      cwd, env: { ...spec.env, HOME: path.join(tmp, 'home'), TMPDIR: tmp },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    pid = child.pid;
    let closed = false;
    child.once('close', () => { closed = true; });
    const killGroup = () => {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') launchError = error as Error;
        }
      }
    };
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { timedOut = true; killGroup(); resolve(); }, spec.timeoutMs);
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.once('error', error => { clearTimeout(timer); launchError = error; resolve(); });
      child.once('exit', (code, value) => {
        clearTimeout(timer); result.exitCode = code; signal = value;
        killGroup(); resolve();
      });
    });
    // A detached descendant can retain pipes after its parent exits. Never await close unboundedly.
    if (!closed) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(); };
      const timer = setTimeout(finish, 500);
      child.once('close', finish);
    });
    child.stdout.destroy(); child.stderr.destroy();
    let orphaned = false;
    let orphanScanUnavailable = false;
    try {
      let output = '';
      let warnings = '';
      try {
        const listing = await exec('/usr/sbin/lsof', ['-t', '+D', dir], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
        output = listing.stdout;
        warnings = listing.stderr;
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
        // +D can return 1 for unmatched entries even when stdout lists live processes.
        if (failure.code !== 1 || failure.signal || failure.killed) throw error;
        output = failure.stdout ?? ''; warnings = failure.stderr ?? '';
      }
      if (!output.trim() && warnings.trim()) throw new Error('orphan-scan-warning');
      const pids = output.trim() ? output.trim().split(/\s+/) : [];
      if (pids.some(value => !/^[1-9]\d*$/.test(value) || Number(value) === process.pid)) throw new Error('invalid-orphan-scan');
      // This is bounded discovery, not full lifetime containment: a setsid descendant that
      // changes cwd and closes all run-directory descriptors evades lsof but retains seatbelt.
      for (const value of new Set(pids)) {
        try { process.kill(Number(value), 'SIGKILL'); orphaned = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    } catch { orphanScanUnavailable = true; }
    const records: string[] = [];
    try {
      // sandboxd/kernel publication is asynchronous; an immediate empty read is not evidence.
      for (const delay of [1500, 1000]) {
        await sleep(delay);
        records.push(await sandboxLog(new Date(windowStart.getTime() - 1000), new Date(Date.now() + 1000)));
      }
    } catch {
      result.summary = 'confinement-unavailable (sandbox log)'; return result;
    }
    const logs = records.join('\n');
    const violations = outsideWrites(logs, pid, spec.argv[0]!, [checkout, tmp, '/dev']);
    if (violations.lines.length) result.summary = `write-outside-root (sandbox log${violations.attributed ? '' : ', unattributed'}): ${violations.lines.slice(0, 3).join('\n')}`;
    else if (orphanScanUnavailable) result.summary = 'orphan-scan-unavailable';
    else if (orphaned) result.summary = 'orphan-descendants';
    else if (timedOut) result.summary = 'timeout';
    else if (launchError) result.summary = `launch-failed: ${launchError.message}`;
    else if (signal) result.summary = `killed-by-signal: ${signal}`;
    else { result.verdict = result.exitCode === 0 ? 'pass' : 'fail'; result.summary = result.exitCode === 0 ? 'passed' : `exit-code: ${result.exitCode}`; }
  } catch (error) {
    result.summary = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (result.outputTail) await writeFile(result.outputTail, tail);
    } catch (error) { result.verdict = 'error'; result.summary = `output-tail-failed: ${String(error)}`; }
    try {
      if (checkout && ownsCheckout) await rm(checkout, { recursive: true, force: true });
      if (tmp) await rm(tmp, { recursive: true, force: true });
    } catch (error) { result.verdict = 'error'; result.summary = `cleanup-failed: ${String(error)}`; }
    result.durationMs = Math.max(0, Date.now() - started);
    result.at = now().toISOString();
  }
  return result;
}
