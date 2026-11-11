// The live detector of a session process (plan T12a, §4 and Deltas 1, 4, 5). It owns the one live policy source a broker of this process
// may get, and answers in three outcomes: `clear`, `trigger` or `uninspected`; only `clear` keeps the source open. It never reads a
// tombstone or the store: mid-session off is config.json's `false` (Delta 5). Provider source lists are not here: each provider row
// (T12a-Claude, T12a-Codex) adds its own classes to `provider-rows.ts`, and a provider with no row is `uninspected`, so never clear.
//
// - **Revision.** Constant while clear, so a benign change re-classifies and keeps the mode; any trigger or uninspected class makes the
//   revision unreadable, which the gate turns into `revoked`, latched for the process (native-policy.ts).
// - **When.** The gate asks at open (classify before any baseline: a dirty state refuses the broker), before every run (`recheck`), and
//   around every nested call and retry. One scan serves one synchronous stretch: the gate's several reads inside `decide`/`authorize`
//   share it, and the next turn scans again.
// - **Budget.** A pass that takes longer than the budget is a detector failure at the next check (a trigger). A hung mount can still stall
//   one pass: the named limit, no worker.
// - **Reading** (`readBounded`): `O_NOFOLLOW|O_NONBLOCK`, a regular file, a size bound, and `fstat` before and after the read on the same
//   fd; a mismatch keeps nothing and reads once more, and a second mismatch is a trigger.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { type PolicySource, mintLiveSource } from './native-policy.js';

/** What one source class, or the whole scan, says. */
export type SourceVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'trigger'; readonly reason: string }
  | { readonly kind: 'uninspected'; readonly sourceClass: string };

/** One in-scope source class of a provider row: a name and a synchronous, bounded check. A check that throws is `uninspected`. */
export interface SourceClass {
  readonly name: string;
  check(): SourceVerdict;
}

export const CLEAR: SourceVerdict = Object.freeze({ kind: 'clear' });
const trigger = (reason: string): SourceVerdict => Object.freeze({ kind: 'trigger', reason });
const uninspected = (sourceClass: string): SourceVerdict => Object.freeze({ kind: 'uninspected', sourceClass });

/** Settings, hook and manifest files: 1 MiB (§4.3). */
export const SETTINGS_MAX_BYTES = 1024 * 1024;
/** A pass over this is a detector failure at the next check (Delta 5, proposed; measured at the freeze). */
export const SCAN_BUDGET_MS = 100;

export type BoundedRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly why: 'not-a-file' | 'too-large' | 'open' | 'read' | 'changed' };

/**
 * One bounded, non-blocking, no-follow read. A FIFO or a symlink never stalls or redirects it. The fd is `fstat`ed before and after the
 * read; if size, mtime, ctime or inode moved, nothing is kept and the read is tried once more (B4).
 */
export function readBounded(file: string, maxBytes: number): BoundedRead {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', why: 'open' };
    }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) return { kind: 'unreadable', why: 'not-a-file' };
      if (before.size > BigInt(maxBytes)) return { kind: 'unreadable', why: 'too-large' };
      const buf = Buffer.alloc(Number(before.size));
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      const after = fstatSync(fd, { bigint: true });
      const same = got === buf.length && after.size === before.size && after.ino === before.ino && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs;
      if (same) return { kind: 'text', text: buf.toString('utf8') };
    } catch {
      return { kind: 'unreadable', why: 'read' };
    } finally {
      try { closeSync(fd); } catch { /* decided */ }
    }
  }
  return { kind: 'unreadable', why: 'changed' };
}

/** `(dev, ino, size, mtimeNs, ctimeNs)` of a path without following it, or `absent`/`unreadable`. */
function fingerprint(file: string): string {
  try {
    const st = lstatSync(file, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

/**
 * The human's setting as this process reads it: config.json alone. `false` is the human's off mid-session (a trigger, latched); missing is
 * the default, on. Anything unreadable, unparsable or not a boolean is a trigger: never silently on. An unchanged fingerprint reuses the
 * last verdict without reading (§4.4).
 */
export function configSourceClass(file: string): SourceClass {
  let last: { readonly print: string; readonly verdict: SourceVerdict } | null = null;
  const classify = (): SourceVerdict => {
    const read = readBounded(file, SETTINGS_MAX_BYTES);
    if (read.kind === 'absent') return CLEAR;
    if (read.kind === 'unreadable') return trigger(`config-${read.why}`);
    let data: unknown;
    try { data = JSON.parse(read.text); } catch { return trigger('config-unparsable'); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return trigger('config-unparsable');
    const value = (data as Record<string, unknown>)['codeMode'];
    if (value === undefined || value === true) return CLEAR;
    return value === false ? trigger('human-off') : trigger('config-unparsable');
  };
  return Object.freeze({
    name: 'parley-config',
    check(): SourceVerdict {
      const print = fingerprint(file);
      if (last !== null && last.print === print && print !== 'unreadable') return last.verdict;
      const verdict = classify();
      // Kept only when the file did not move during the classification, so a write in between is seen at the next check.
      last = fingerprint(file) === print ? { print, verdict } : null;
      return verdict;
    },
  });
}

export interface DetectorOptions {
  /** The provider row's classes, or null when this provider has no row in this build: then the scan is `uninspected`. */
  readonly classes: readonly SourceClass[] | null;
  /** config.json, the one Parley source every row shares. */
  readonly configFile: string;
  readonly budgetMs?: number;
  /** Tests only: the clock. */
  readonly now?: () => number;
}

export interface Detector {
  /** One verdict for the current synchronous stretch: the first call scans, later calls in the same stretch reuse it. */
  scan(): SourceVerdict;
  /** Passes actually run, for tests and the freeze's cost figure. */
  passes(): number;
}

export function createDetector(options: DetectorOptions): Detector {
  const budget = options.budgetMs ?? SCAN_BUDGET_MS;
  const now = options.now ?? ((): number => performance.now());
  const classes: readonly SourceClass[] = [configSourceClass(options.configFile), ...(options.classes ?? [])];
  let stretch: SourceVerdict | null = null;
  let overBudget = false;
  let passes = 0;
  const pass = (): SourceVerdict => {
    if (overBudget) return trigger('over-budget');
    const started = now();
    passes++;
    let verdict: SourceVerdict = options.classes === null ? uninspected('no-provider-row') : CLEAR;
    for (const c of classes) {
      let v: SourceVerdict;
      try { v = c.check(); } catch { v = uninspected(c.name); }
      if (v.kind === 'trigger') { verdict = v; break; }
      if (v.kind === 'uninspected' && verdict.kind === 'clear') verdict = v;
    }
    if (now() - started > budget) overBudget = true;
    return verdict;
  };
  return Object.freeze({
    scan(): SourceVerdict {
      if (stretch !== null) return stretch;
      const verdict = pass();
      stretch = verdict;
      // Dropped when this synchronous stretch ends: the next turn scans again.
      queueMicrotask(() => { stretch = null; });
      return verdict;
    },
    passes: () => passes,
  });
}

/** The clear revision. Constant while clear (Delta 5): a benign change re-classifies and keeps it. */
const CLEAR_REVISION = 'live-clear-1';

/**
 * The live policy source of this process, minted from a proof that `resolveLiveNativePolicy` issued for a proven provider. Its revision is
 * readable only while the scan is clear, so the gate refuses to open on a dirty state (classify at open) and goes `revoked` on any later
 * trigger. It allows every eligible call while clear; everything else is the gate's.
 */
export function createLiveSource(proof: unknown, detector: Detector): PolicySource {
  return mintLiveSource(proof, 'live-detector', {
    revision: () => (detector.scan().kind === 'clear' ? CLEAR_REVISION : null),
    decide: () => (detector.scan().kind === 'clear' ? 'allow' : 'revoked'),
  });
}
