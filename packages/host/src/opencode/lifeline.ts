/**
 * The lifeline of one OpenCode server (spec 2026-11-12, §4.2). The host starts this script detached, as the leader of a
 * new process group, with a stdin pipe. The script starts `opencode serve` inside its own group and keeps it there:
 *
 * - the host closes the pipe (it exited or crashed) or writes `stop` → SIGTERM to the whole group, SIGKILL after the
 *   grace period, which ends the lifeline too;
 * - the server exits by itself → one status line, then the same group kill, so nothing the server spawned survives.
 *
 * The group holds the server and every descendant that did not leave it on purpose (`setsid`), whatever its command
 * name. Usage: `node lifeline.js <graceMs> <command> [args…]`; the environment goes to the server unchanged (it carries
 * the password, so nothing here prints the environment or the arguments).
 *
 * Self-contained on purpose: no project imports, so the file also runs from source (`node lifeline.ts`) in tests.
 */

import { spawn } from 'node:child_process';

/**
 * Prefix of the lifeline's own status lines on stdout; the server's own output passes through unchanged. The host has
 * the same constant (`server.ts`): it must not import this file, which runs on import.
 */
const LIFELINE_STATUS_PREFIX = 'parley-lifeline ';

function main(): void {
  const [graceArg, command, ...args] = process.argv.slice(2);
  const graceMs = Number(graceArg);
  if (command === undefined || !Number.isFinite(graceMs) || graceMs < 0) {
    process.stderr.write('usage: lifeline <graceMs> <command> [args…]\n');
    process.exit(2);
  }
  const pgid = process.pid;
  // A broken pipe to a dead host must not end the lifeline before it has cleaned up.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  // The group SIGTERM reaches this process too: it finishes the cleanup and ends with the group SIGKILL instead.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => stop());

  const status = (value: Record<string, unknown>): void => {
    try {
      process.stdout.write(`${LIFELINE_STATUS_PREFIX}${JSON.stringify(value)}\n`);
    } catch {
      /* the host is gone */
    }
  };

  let serverDone = false;
  let stopping = false;
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (chunk: Buffer) => {
    try { process.stdout.write(chunk); } catch { /* the host is gone */ }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    try { process.stderr.write(chunk); } catch { /* the host is gone */ }
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    serverDone = true;
    status({ event: 'spawn-error', code: error.code ?? 'unknown' });
    stop();
  });
  child.on('exit', (code, signal) => {
    serverDone = true;
    if (!stopping) status({ event: 'server-exit', code, signal });
    stop();
  });
  if (child.pid !== undefined) status({ event: 'started', serverPid: child.pid });

  // The host's pipe: EOF means the host is gone; a `stop` line is a planned stop.
  let input = '';
  process.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
    if (input.split('\n').some((line) => line.trim() === 'stop')) stop();
  });
  process.stdin.on('end', () => stop());
  process.stdin.on('close', () => stop());
  process.stdin.on('error', () => stop());

  function signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* the group is already gone */
    }
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    signalGroup('SIGTERM');
    const started = Date.now();
    // The server gets the grace period to exit; its descendants get a short one after it, then the group SIGKILL,
    // which ends this process as well.
    const tick = setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed >= graceMs || (serverDone && elapsed >= Math.min(graceMs, 100))) {
        clearInterval(tick);
        signalGroup('SIGKILL');
        // Not reached on POSIX; a platform without process groups still exits.
        process.exit(0);
      }
    }, 20);
  }
}

main();
