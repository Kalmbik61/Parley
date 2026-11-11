// Code Mode durable run record (plan T7a-sleep, H2). The session lease in `scheduler.ts` is memory: when the process ends, by
// auto-sleep, Stop, a crash, a host restart or an MCP reconnect, an unresolved call would be forgotten and the next process would
// start free. This file is what outlives it, and it is also the lease across processes: one per session, created exclusively before
// anything runs, removed only when the run is quiescent. A run held for good simply never removes it. Nothing here ages it out,
// replays anything or asks the host; auto-sleep and wake are unchanged.
//
// Lifecycle owner: the session-MCP process holding the run creates and appends; any later process of the session reads and
// classifies; the holder deletes on quiescent; the next acquirer reclaims a record that is fully accounted for and whose holder is
// gone; session deletion removes it (`deleteSessionFiles`). An UNACCOUNTED record is never released: the launcher reads it (`inspectRunRecord`,
// which changes nothing) and picks classic, so nothing has to prove what became of its calls (T8h).
//
// What is written: run identity, then method and arguments hash per call, then each terminal state. No raw arguments, no results,
// no tool text. No fsync: a machine crash that loses the file also kills the host, so no earlier attempt survives it. T11 inherits
// that: after power loss a write's effect can survive its lost intent.
//
// This is accounting, not authority: the agent's own shell can delete the file; the guest cannot reach it.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export type RecordBusy = 'previous-process-unaccounted' | 'held-by-other-process' | 'run-record-unavailable';

/** The scheduler's busy text per reason. `code-mode-tools.ts` maps these exact strings to the contract's typed reasons. */
export const RECORD_BUSY_TEXT: Readonly<Record<RecordBusy, string>> = Object.freeze({
  'previous-process-unaccounted': 'previous process left calls unaccounted',
  'held-by-other-process': 'another process holds the run record',
  'run-record-unavailable': 'run record unavailable',
});

/** A record of 32 calls is about 8 KiB; anything over this is not one of ours. */
export const RECORD_MAX_BYTES = 16 * 1024;
/** Two readings of one process's start time may differ by this much (clock adjustment, machine sleep: not measured). */
export const START_TIME_MARGIN_S = 2;
const PS = '/bin/ps';
const PS_TIMEOUT_MS = 1000;
const SESSION_ID = /^[a-z0-9-]+$/;
/** A session id safe as a file name under `code-mode/`: nothing that can leave the directory. */
export const validSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id);
const NONCE = /^[0-9a-f]{32}$/;
const METHOD = /^[a-z][a-z0-9_]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
/** Terminal lines that account for a call. `unknown` is recorded too, and is what keeps a record held. */
const ACCOUNTED = new Set(['succeeded', 'failed', 'cancelled', 'unread', 'refused']);
const TERMINAL = new Set([...ACCOUNTED, 'unknown']);

/** What a ledger says, as far as the record needs it. */
export interface RecordSnapshot {
  readonly entries: readonly { readonly ordinal: number; readonly state: string; readonly refusal: string | null }[];
  readonly cleanupUnknown: boolean;
}

export interface RunRecordHandle {
  /** Writes one terminal line per finished entry and the cleanup line, once each. Never throws: a missing line reads as unaccounted. */
  sync(snapshot: RecordSnapshot): void;
  /** On quiescent: closes and removes the record. Never throws. */
  release(): void;
}

export type RecordOpen = { readonly ok: true; readonly handle: RunRecordHandle } | { readonly ok: false; readonly busy: RecordBusy };

export interface RunRecordStore {
  /** Synchronous, as `SessionScheduler.acquire` is. Creates the record, or says why it cannot. Never throws. */
  open(runId: string): RecordOpen;
  /**
   * The intent line of one call, at the dispatch edge, before attempt 1 leaves. `false`: it could not be written (or no such run is
   * open here), and the call must not be sent.
   */
  intent(runId: string, ordinal: number, method: string, argsSha256: string): boolean;
}

/** How the store looks at other processes; tests replace it, nothing else does. */
export interface ProcessProbe {
  /** `false` only when the pid certainly does not exist. */
  alive(pid: number): boolean;
  /** Whole seconds since the epoch, or null when it cannot be told. */
  startedAt(pid: number): number | null;
}

/**
 * `lstart` read with a pinned zone and locale, on write and on compare: the system zone would make a zone change (a laptop travelling)
 * read as another process, which frees a record, so it must not be able to differ.
 */
function startedAtOf(pid: number): number | null {
  try {
    const r = spawnSync(PS, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: { TZ: 'UTC', LC_ALL: 'C' } });
    if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout.trim() === '') return null;
    const ms = Date.parse(`${r.stdout.trim()} UTC`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  } catch {
    return null;
  }
}

export const REAL_PROBE: ProcessProbe = Object.freeze({
  alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
  },
  startedAt: startedAtOf,
});

interface Header { readonly v: 1; readonly runId: string; readonly launchId: string; readonly pid: number; readonly startedAt: number | null; readonly nonce: string; readonly at: string }

type Reading = { readonly kind: 'absent' } | { readonly kind: 'unavailable' } | { readonly kind: 'record'; readonly header: Header; readonly accounted: boolean; readonly methods: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

function readHeader(v: unknown): Header | null {
  if (!isRecord(v) || !keysAre(v, ['v', 'runId', 'launchId', 'pid', 'startedAt', 'nonce', 'at'])) return null;
  if (v['v'] !== 1 || typeof v['runId'] !== 'string' || typeof v['launchId'] !== 'string' || !positive(v['pid']) || typeof v['at'] !== 'string') return null;
  if (typeof v['nonce'] !== 'string' || !NONCE.test(v['nonce'])) return null;
  if (v['startedAt'] !== null && !positive(v['startedAt'])) return null;
  return v as unknown as Header;
}

/** One record as text: anything not exactly what a holder writes, a torn last line included, is `null`. */
function parseRecord(text: string): { header: Header; accounted: boolean; methods: readonly string[] } | null {
  if (!text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  let header: Header | null = null;
  const intents = new Set<number>();
  const settled = new Set<number>();
  const methods = new Set<string>();
  let unaccounted = false;
  for (const [i, line] of lines.entries()) {
    let v: unknown;
    try { v = JSON.parse(line); } catch { return null; }
    if (i === 0) {
      header = readHeader(v);
      if (header === null) return null;
      continue;
    }
    if (!isRecord(v)) return null;
    if (keysAre(v, ['o', 'm', 'a']) && positive(v['o']) && typeof v['m'] === 'string' && METHOD.test(v['m']) && typeof v['a'] === 'string' && SHA.test(v['a'])) { intents.add(v['o']); methods.add(v['m']); }
    else if (keysAre(v, ['o', 's']) && positive(v['o']) && typeof v['s'] === 'string' && TERMINAL.has(v['s'])) {
      if (ACCOUNTED.has(v['s'])) settled.add(v['o']);
      else unaccounted = true;
    } else if (keysAre(v, ['cleanup']) && v['cleanup'] === 'unknown') unaccounted = true;
    else return null;
  }
  if (header === null) return null;
  for (const o of intents) if (!settled.has(o)) unaccounted = true;
  return { header, accounted: !unaccounted, methods: [...methods] };
}

/** A bounded, non-blocking read: a FIFO or a symlink at the path must not stall this synchronous path, classic tools included. */
function readRecord(file: string): Reading {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unavailable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > RECORD_MAX_BYTES) return { kind: 'unavailable' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    const parsed = parseRecord(buf.subarray(0, got).toString('utf8'));
    return parsed === null ? { kind: 'unavailable' } : { kind: 'record', ...parsed };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    try { closeSync(fd); } catch { /* the read is already decided */ }
  }
}

const sameProcess = (a: number, b: number): boolean => Math.abs(a - b) <= START_TIME_MARGIN_S;

/**
 * A holder that is certainly gone, by pid and, where it can be told, by start time. A doubt reads as alive. `ownLeftover`: a record of this
 * pid whose unlink this very store failed, the only own-pid record that can be gone while this pid's process has the same start time.
 */
function holderGone(h: Header, probe: ProcessProbe, ownStartedAt: () => number | null, ownLeftover: (nonce: string) => boolean): boolean {
  if (h.pid === process.pid) {
    const own = ownStartedAt();
    if (h.startedAt !== null && own !== null && !sameProcess(h.startedAt, own)) return true; // this pid was reused: by us
    return ownLeftover(h.nonce);
  }
  if (!probe.alive(h.pid)) return true;
  if (h.startedAt === null) return false;
  const now = probe.startedAt(h.pid);
  return now !== null && !sameProcess(now, h.startedAt);
}

/** What a launcher can tell about a session's record. `free`: nothing would refuse a run here. */
export type RecordView =
  | { readonly kind: 'free' }
  | { readonly kind: 'held-live'; readonly methods: readonly string[] }
  | { readonly kind: 'unaccounted'; readonly methods: readonly string[] }
  | { readonly kind: 'unreadable' };

/**
 * The same classifier as `open`, for a launcher (T8h): strictly read-only, no reclaim, claim, unlink or directory creation, so a live
 * holder and a dead accounted record are left exactly as they are. Only a process about to run a script reclaims. Never throws; `ps` is bounded.
 */
export function inspectRunRecord(workDir: string, sessionId: string, probe: ProcessProbe = REAL_PROBE): RecordView {
  if (typeof workDir !== 'string' || workDir === '' || !validSessionId(sessionId)) return { kind: 'unreadable' };
  const file = runRecordPath(workDir, sessionId);
  try {
    const dir = lstatSync(path.dirname(file));
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) return { kind: 'unreadable' };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'free' } : { kind: 'unreadable' };
  }
  const seen = readRecord(file);
  if (seen.kind === 'absent') return { kind: 'free' };
  if (seen.kind === 'unavailable') return { kind: 'unreadable' };
  if (!holderGone(seen.header, probe, () => probe.startedAt(process.pid), () => false)) return { kind: 'held-live', methods: seen.methods };
  if (!seen.accounted) return { kind: 'unaccounted', methods: seen.methods };
  // A claim left behind makes `open` refuse this record, so a replacement launch would find code_execute busy.
  try {
    lstatSync(`${file}.claim.${seen.header.nonce}`);
    return { kind: 'unreadable' };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'free' } : { kind: 'unreadable' };
  }
}

export interface RunRecordOptions {
  readonly workDir: string;
  readonly sessionId: string;
  readonly launchId: string;
}

export function runRecordPath(workDir: string, sessionId: string): string {
  return path.join(workDir, 'code-mode', `${sessionId}.run`);
}

/** The store of one session in one process. Throws TypeError on a bad work directory or session id: nothing can run without it. */
export function createRunRecordStore(options: RunRecordOptions, probe: ProcessProbe = REAL_PROBE): RunRecordStore {
  const { workDir, sessionId, launchId } = options;
  if (typeof workDir !== 'string' || workDir === '' || !validSessionId(sessionId) || typeof launchId !== 'string') throw new TypeError('run record: invalid options');
  const file = runRecordPath(workDir, sessionId);
  /** Nonces of this store's own records whose unlink failed: the only own-pid records it may take back. */
  const leftovers = new Set<string>();
  let ownStart: number | null | undefined;
  const ownStartedAt = (): number | null => (ownStart === undefined ? (ownStart = probe.startedAt(process.pid)) : ownStart);
  let current: { readonly runId: string; readonly fd: number } | null = null;

  const line = (fd: number, value: unknown): boolean => {
    try {
      const text = `${JSON.stringify(value)}\n`;
      return writeSync(fd, text) === Buffer.byteLength(text, 'utf8');
    } catch {
      return false;
    }
  };

  const create = (runId: string): RecordOpen | 'exists' => {
    let fd: number;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // A symlink here would carry the lease elsewhere, and a looser mode lets others put a record in: neither can be trusted, in either direction.
      const dir = lstatSync(path.dirname(file));
      if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) return { ok: false, busy: 'run-record-unavailable' };
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, 0o600);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : { ok: false, busy: 'run-record-unavailable' };
    }
    const nonce = randomBytes(16).toString('hex');
    const header: Header = { v: 1, runId, launchId, pid: process.pid, startedAt: ownStartedAt(), nonce, at: new Date().toISOString() };
    if (!line(fd, header)) {
      // Nothing ran under it: it says nothing, so it goes, if it can.
      try { closeSync(fd); unlinkSync(file); } catch { /* a torn record stays, and reads as unavailable */ }
      return { ok: false, busy: 'run-record-unavailable' };
    }
    current = { runId, fd };
    const written = new Set<number>();
    let cleanupWritten = false;
    let released = false;
    return {
      ok: true,
      handle: Object.freeze({
        sync(snapshot: RecordSnapshot): void {
          if (released) return;
          for (const e of snapshot.entries) {
            if (written.has(e.ordinal) || !TERMINAL.has(e.state) || (e.state === 'refused' && e.refusal === null)) continue;
            if (line(fd, { o: e.ordinal, s: e.state })) written.add(e.ordinal);
          }
          if (snapshot.cleanupUnknown && !cleanupWritten && line(fd, { cleanup: 'unknown' })) cleanupWritten = true;
        },
        release(): void {
          if (released) return;
          released = true;
          if (current?.fd === fd) current = null;
          try { closeSync(fd); } catch { /* the path is what counts */ }
          try { unlinkSync(file); } catch { leftovers.add(nonce); }
        },
      }),
    };
  };

  /** Claim, reread through the same bounded read, then replace. Unlink-then-create alone lets a stale reader delete a live record. */
  const reclaim = (nonce: string, runId: string): RecordOpen => {
    const claim = `${file}.claim.${nonce}`;
    try {
      linkSync(file, claim);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A claim already there: another reclaimer now, or one that died in between. Nothing clears it: the launcher reads it as unreadable and picks classic.
      return { ok: false, busy: code === 'EEXIST' ? 'run-record-unavailable' : 'held-by-other-process' };
    }
    const unclaim = (): void => { try { unlinkSync(claim); } catch { /* junk that session deletion removes */ } };
    const again = readRecord(claim);
    if (again.kind !== 'record' || again.header.nonce !== nonce) {
      unclaim();
      return { ok: false, busy: 'held-by-other-process' };
    }
    try {
      unlinkSync(file);
    } catch {
      unclaim();
      return { ok: false, busy: 'run-record-unavailable' };
    }
    leftovers.delete(nonce);
    const made = create(runId);
    unclaim();
    return made === 'exists' ? { ok: false, busy: 'held-by-other-process' } : made;
  };

  return Object.freeze({
    open(runId: string): RecordOpen {
      // A record that vanishes between the create and the read was released: one more try, then busy.
      for (let attempt = 0; attempt < 2; attempt++) {
        const made = create(runId);
        if (made !== 'exists') return made;
        const seen = readRecord(file);
        if (seen.kind === 'absent') continue;
        if (seen.kind === 'unavailable') return { ok: false, busy: 'run-record-unavailable' };
        if (!holderGone(seen.header, probe, ownStartedAt, (nonce) => leftovers.has(nonce))) return { ok: false, busy: 'held-by-other-process' };
        if (!seen.accounted) return { ok: false, busy: 'previous-process-unaccounted' };
        return reclaim(seen.header.nonce, runId);
      }
      return { ok: false, busy: 'held-by-other-process' };
    },
    intent(runId: string, ordinal: number, method: string, argsSha256: string): boolean {
      if (current === null || current.runId !== runId) return false;
      return line(current.fd, { o: ordinal, m: method, a: argsSha256 });
    },
  });
}
