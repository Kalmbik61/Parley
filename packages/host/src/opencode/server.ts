/**
 * Supervision of the per-session OpenCode servers (spec 2026-11-12, §4.2; plan O5).
 *
 * For each launch or resume the host starts `opencode serve --hostname 127.0.0.1 --port 0` under a lifeline
 * (`lifeline.ts`): the lifeline leads a new process group with a stdin pipe from the host, and kills its whole group
 * when that pipe closes or the host asks it to stop. The server prints its address (`server listening on …`, FINDINGS
 * item 1); the session is ready for its TUI once `GET /api/info` answers with the session's password.
 *
 * Secrets: the password and the address live only in this module's memory and in the two processes' environments. They
 * are never written to the run file, the log or an error message.
 *
 * Host dies first: the lifeline sees its pipe close and kills the group. As a backstop, `sweep()` at the next host start
 * reads the run file and kills the group of every recorded lifeline that is still alive with the same start time. It
 * runs only `ps -o lstart= -p <pid>` and never reads a process environment.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SessionRef } from '@parley/protocol';
import { OPENCODE_PASSWORD_ENV } from '@parley/core';
import type { Log } from '../log.js';

/** The same prefix as in `lifeline.ts` (that file runs on import and is not imported here). */
const LIFELINE_STATUS_PREFIX = 'parley-lifeline ';
/** The line `opencode serve` prints once it listens (FINDINGS item 1). Only loopback addresses are accepted. */
const LISTENING = /server listening on (http:\/\/127\.0\.0\.1:\d{1,5})\b/;
const ADDRESS_IN_USE = /EADDRINUSE|address (?:already )?in use/i;

export const OPENCODE_READY_TIMEOUT_MS = 15_000;
export const OPENCODE_KILL_GRACE_MS = 2_000;
export const OPENCODE_START_ATTEMPTS = 3;
/** Stderr kept per start attempt, only to recognise "address in use"; never logged. */
const STDERR_TAIL_BYTES = 4096;

/** A run record: the lifeline only. No password, no port (spec §4.2). */
export interface OpencodeRunRecord {
  workId: string;
  sessionId: string;
  pid: number;
  pgid: number;
  /** `ps -o lstart= -p <pid>`, verbatim. */
  lstart: string;
}

export interface OpencodeServerExit {
  code: number | null;
  signal: string | null;
  /** A readable reason for the human; carries no address and no password. */
  reason: string;
}

export interface OpencodeServer {
  url: string;
  password: string;
  /** The lifeline's pid; it is also the pgid of the server's group. */
  pid: number;
}

export interface OpencodeStartRequest {
  /** The resolved `opencode` binary. */
  binary: string;
  cwd: string;
  /** The inherited launch environment (the TUI's, without the password). */
  env: Record<string, string | undefined>;
  /** The server-only config environment of the launch plan (`LaunchPlan.opencodeServer.env`). */
  serverEnv: Record<string, string>;
}

/** Runs `ps` (or a spy in tests): the only process query of this module. */
export type PsRunner = (args: readonly string[]) => Promise<string>;

export interface OpencodeSupervisorOptions {
  /** Parley home: the run file is `<home>/run/opencode-servers.json`. */
  home: string;
  log: Log;
  readyTimeoutMs?: number;
  graceMs?: number;
  attempts?: number;
  /** How to run the lifeline; default `process.execPath` with the built `lifeline.js`. */
  lifeline?: { command: string; args: readonly string[] };
  fetchImpl?: typeof fetch;
  ps?: PsRunner;
  /** The last transcript poll before a planned stop (spec §4.11, O8). Errors are logged and do not block the stop. */
  beforeStop?: (ref: SessionRef, server: OpencodeServer) => Promise<void>;
}

export interface OpencodeSupervisor {
  /** Starts the session's server and waits until it answers; throws (with nothing left running) if it does not. */
  start(ref: SessionRef, request: OpencodeStartRequest): Promise<OpencodeServer>;
  get(ref: SessionRef): OpencodeServer | undefined;
  /** Planned stop: last poll, then the group SIGTERM, SIGKILL after the grace period; the record is removed. */
  stop(ref: SessionRef): Promise<void>;
  stopAll(): Promise<void>;
  /** A server that ended by itself (crash); not called for planned stops or failed starts. */
  onExit(listener: (ref: SessionRef, exit: OpencodeServerExit) => void): void;
  /** Host start, before any resume: kills the groups of recorded lifelines that are still alive, then clears the file. */
  sweep(): Promise<{ killed: number; skipped: number }>;
  runFile(): string;
}

const execFileAsync = promisify(execFile);

const defaultPs: PsRunner = async (args) => {
  const { stdout } = await execFileAsync('ps', [...args], {
    // English dates whatever the user's locale; nothing else of the host environment matters to `ps`.
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 2000,
    killSignal: 'SIGKILL',
  });
  return stdout;
};

/** The start time of a pid as `ps` prints it; null when the process is gone. Never asks for an environment. */
export async function lstartOf(pid: number, ps: PsRunner = defaultPs): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const value = (await ps(['-o', 'lstart=', '-p', String(pid)])).trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/** The built lifeline next to this module; from source in tests (Node strips the types). */
export function defaultLifeline(): { command: string; args: string[] } {
  const js = fileURLToPath(new URL('./lifeline.js', import.meta.url));
  const script = existsSync(js) ? js : fileURLToPath(new URL('./lifeline.ts', import.meta.url));
  return { command: process.execPath, args: [script] };
}

const keyOf = (ref: SessionRef): string => `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    return signal === 0 && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (signalGroup(pgid, 0)) {
    if (Date.now() >= until) return false;
    await sleep(20);
  }
  return true;
}

/** SIGTERM to the group, SIGKILL after `graceMs`, then waits for it to be gone. Never throws. */
async function killGroup(pgid: number, graceMs: number): Promise<void> {
  if (!signalGroup(pgid, 'SIGTERM')) return;
  if (await waitGroupGone(pgid, graceMs)) return;
  signalGroup(pgid, 'SIGKILL');
  await waitGroupGone(pgid, 1000);
}

interface Live {
  ref: SessionRef;
  child: ChildProcess;
  server: OpencodeServer;
  planned: boolean;
  exited: Promise<void>;
  /** The lifeline's status line about the server's own exit; the lifeline itself ends by the group SIGKILL. */
  status: () => { event: string; code?: unknown; signal?: unknown } | null;
}

class StartError extends Error {
  constructor(message: string, readonly retry: boolean) {
    super(message);
  }
}

export function createOpencodeSupervisor(options: OpencodeSupervisorOptions): OpencodeSupervisor {
  const readyTimeoutMs = options.readyTimeoutMs ?? OPENCODE_READY_TIMEOUT_MS;
  const graceMs = options.graceMs ?? OPENCODE_KILL_GRACE_MS;
  const attempts = options.attempts ?? OPENCODE_START_ATTEMPTS;
  const lifeline = options.lifeline ?? defaultLifeline();
  const fetchImpl = options.fetchImpl ?? fetch;
  const ps = options.ps ?? defaultPs;
  const file = path.join(options.home, 'run', 'opencode-servers.json');
  const live = new Map<string, Live>();
  const listeners: Array<(ref: SessionRef, exit: OpencodeServerExit) => void> = [];

  // One writer of the run file at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  async function readRecords(): Promise<OpencodeRunRecord[]> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is OpencodeRunRecord =>
        typeof item === 'object' && item !== null &&
        typeof (item as OpencodeRunRecord).workId === 'string' && typeof (item as OpencodeRunRecord).sessionId === 'string' &&
        Number.isInteger((item as OpencodeRunRecord).pid) && Number.isInteger((item as OpencodeRunRecord).pgid) &&
        typeof (item as OpencodeRunRecord).lstart === 'string');
    } catch {
      return [];
    }
  }

  async function writeRecords(records: OpencodeRunRecord[]): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  }

  const addRecord = (record: OpencodeRunRecord): Promise<void> =>
    serialized(async () => writeRecords([...(await readRecords()).filter((item) => item.pid !== record.pid), record]));
  const removeRecord = (pid: number): Promise<void> =>
    serialized(async () => {
      const records = await readRecords();
      if (records.some((item) => item.pid === pid)) await writeRecords(records.filter((item) => item.pid !== pid));
    }).catch((error: unknown) => options.log.warn('opencode run record was not removed', { error: String(error) }));

  /** One start attempt: the lifeline, the listening line, then `/api/info` with the password. */
  async function attempt(ref: SessionRef, request: OpencodeStartRequest, password: string): Promise<Live> {
    const child = spawn(lifeline.command, [
      ...lifeline.args, String(graceMs), request.binary, 'serve', '--hostname', '127.0.0.1', '--port', '0',
    ], {
      cwd: request.cwd,
      env: { ...request.env, ...request.serverEnv, [OPENCODE_PASSWORD_ENV]: password },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
      await new Promise((resolve) => child.once('error', resolve).once('exit', resolve));
      throw new StartError('the OpenCode server could not be started', false);
    }
    child.stdin?.on('error', () => {});

    let url: string | null = null;
    let stderrTail = '';
    // Set by the stream handlers; read by the wait loop (an object, so the loop sees the late writes).
    const seen: {
      status: { event: string; code?: unknown; signal?: unknown } | null;
      exit: { code: number | null; signal: string | null } | null;
    } = { status: null, exit: null };
    let buffer = '';
    const exited = new Promise<void>((resolve) => {
      // 'close', not 'exit': the status lines on stdout are all read by then.
      child.once('close', (code, signal) => {
        seen.exit = { code, signal };
        resolve();
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith(LIFELINE_STATUS_PREFIX)) {
          try {
            const parsed = JSON.parse(line.slice(LIFELINE_STATUS_PREFIX.length)) as { event?: unknown };
            if (typeof parsed.event === 'string' && parsed.event !== 'started') seen.status = parsed as { event: string; code?: unknown; signal?: unknown };
          } catch {
            /* not a status line */
          }
          continue;
        }
        url ??= LISTENING.exec(line)?.[1] ?? null;
      }
      if (buffer.length > 65536) buffer = buffer.slice(-4096);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });

    // Recorded at once, so a host that dies during the start leaves the group to the backstop sweep.
    const lstart = await lstartOf(pid, ps);
    if (lstart !== null) {
      await addRecord({ workId: ref.workId, sessionId: ref.sessionId, pid, pgid: pid, lstart }).catch((error: unknown) => {
        options.log.warn('opencode run record was not written', { error: String(error) });
      });
    }

    const server: OpencodeServer = { url: '', password, pid };
    const entry: Live = { ref, child, server, planned: false, exited, status: () => seen.status };
    const fail = async (message: string, retry: boolean): Promise<never> => {
      entry.planned = true;
      try { child.stdin?.end(); } catch { /* closed */ }
      await killGroup(pid, graceMs);
      await exited;
      await removeRecord(pid);
      throw new StartError(message, retry);
    };

    const deadline = Date.now() + readyTimeoutMs;
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    for (;;) {
      if (seen.exit !== null || seen.status !== null) {
        await exited;
        const { status } = seen;
        const reason = status?.event === 'spawn-error'
          ? `the opencode command could not be started (${String(status.code)})`
          : `the OpenCode server exited before it was ready (code ${String(status?.code ?? seen.exit?.code ?? null)})`;
        return fail(reason, ADDRESS_IN_USE.test(stderrTail));
      }
      if (Date.now() >= deadline) return fail(`the OpenCode server did not answer within ${Math.round(readyTimeoutMs / 1000)} s`, false);
      if (url !== null) {
        try {
          const response = await fetchImpl(`${url}/api/info`, {
            headers: { authorization: auth },
            signal: AbortSignal.timeout(Math.max(100, Math.min(2000, deadline - Date.now()))),
          });
          await response.body?.cancel().catch(() => {});
          if (response.ok) {
            server.url = url;
            return entry;
          }
        } catch {
          /* not listening yet */
        }
      }
      await sleep(50);
    }
  }

  function watch(entry: Live): void {
    const key = keyOf(entry.ref);
    void entry.exited.then(async () => {
      if (live.get(key) === entry) live.delete(key);
      await removeRecord(entry.server.pid);
      if (entry.planned) return;
      const status = entry.status();
      const exit: OpencodeServerExit = {
        code: typeof status?.code === 'number' ? status.code : entry.child.exitCode,
        signal: typeof status?.signal === 'string' ? status.signal : entry.child.signalCode,
        reason: 'the OpenCode server of this session stopped unexpectedly',
      };
      options.log.warn('opencode server exited', { ref: entry.ref, code: exit.code, signal: exit.signal });
      for (const listener of listeners) {
        try {
          listener(entry.ref, exit);
        } catch (error) {
          options.log.error('opencode exit listener failed', { error: String(error) });
        }
      }
    });
  }

  async function stopEntry(entry: Live): Promise<void> {
    if (entry.planned) {
      await entry.exited;
      return;
    }
    entry.planned = true;
    if (options.beforeStop !== undefined) {
      try {
        await options.beforeStop(entry.ref, entry.server);
      } catch (error) {
        options.log.warn('opencode last poll failed', { ref: entry.ref, error: String(error) });
      }
    }
    try {
      entry.child.stdin?.write('stop\n');
      entry.child.stdin?.end();
    } catch {
      /* the lifeline is gone */
    }
    // The lifeline kills its group itself; the host's own group kill is the fallback.
    const exited = await Promise.race([entry.exited.then(() => true), sleep(graceMs + 1000).then(() => false)]);
    if (!exited) signalGroup(entry.server.pid, 'SIGKILL');
    if (!(await waitGroupGone(entry.server.pid, 1000))) {
      signalGroup(entry.server.pid, 'SIGKILL');
      await waitGroupGone(entry.server.pid, 1000);
    }
    await entry.exited;
    await removeRecord(entry.server.pid);
  }

  return {
    async start(ref, request) {
      const key = keyOf(ref);
      const previous = live.get(key);
      // Never two servers for one session.
      if (previous !== undefined) await stopEntry(previous);
      const password = randomBytes(32).toString('base64url');
      let lastError: unknown;
      for (let index = 1; index <= attempts; index += 1) {
        try {
          const entry = await attempt(ref, request, password);
          live.set(key, entry);
          watch(entry);
          options.log.info('opencode server ready', { ref, attempt: index, pid: entry.server.pid });
          return entry.server;
        } catch (error) {
          lastError = error;
          if (!(error instanceof StartError) || !error.retry) break;
          options.log.warn('opencode server start retried: address in use', { ref, attempt: index });
        }
      }
      throw lastError instanceof Error ? new Error(lastError.message) : new Error('the OpenCode server could not be started');
    },
    get(ref) {
      return live.get(keyOf(ref))?.server;
    },
    async stop(ref) {
      const entry = live.get(keyOf(ref));
      if (entry !== undefined) await stopEntry(entry);
    },
    async stopAll() {
      await Promise.all([...live.values()].map((entry) => stopEntry(entry)));
    },
    onExit(listener) {
      listeners.push(listener);
    },
    async sweep() {
      return serialized(async () => {
        const records = await readRecords();
        let killed = 0;
        let skipped = 0;
        for (const record of records) {
          const now = await lstartOf(record.pid, ps);
          // Another start time: the pid was reused by another program, which is left alone.
          if (now === null || now !== record.lstart) {
            skipped += 1;
            continue;
          }
          await killGroup(record.pgid, graceMs);
          killed += 1;
        }
        if (records.length > 0 || existsSync(file)) await writeRecords([]);
        if (killed > 0 || skipped > 0) options.log.info('opencode run file swept', { killed, skipped });
        return { killed, skipped };
      });
    },
    runFile() {
      return file;
    },
  };
}
