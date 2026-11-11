// What a session-MCP process actually exposed (plan T7b, lead m-6221): only that process knows it, and the launcher can only assume.
// Minimal, names and hashes only, not agent-visible. A MISSING RECORD READS AS EXPOSURE UNKNOWN, NEVER AS CLASSIC: `readExposureRecord` is the
// reader, and T12a and T8h build on that. Writing is best effort: a failure changes nothing about what is exposed. This module and the
// registry load only on a replacement launch.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { validSessionId } from './run-record.js';

export interface ExposureRecord {
  readonly v: 1;
  readonly effective: 'replacement' | 'failed';
  /** A fixed code when `failed`; null otherwise. */
  readonly reason: string | null;
  readonly migrated: readonly string[];
  readonly residual: readonly string[];
  readonly registryRevision: string;
  readonly residualSchemaSha256: string | null;
  readonly launchId: string | null;
  /** The launch nonce this process was started under (`launch-decision.ts`): what ties a record to one launch. */
  readonly nonce: string | null;
}

/** 50 names and two hashes fit in far less. */
const MAX_BYTES = 64 * 1024;

export function exposureRecordPath(workDir: string, sessionId: string): string {
  return path.join(workDir, 'code-mode', `${sessionId}.exposure.json`);
}

/** A real directory, open to its owner only: a symlink would carry the record elsewhere, and a looser mode lets others put one there. */
function directoryOk(dir: string): boolean {
  const st = lstatSync(dir);
  return st.isDirectory() && (st.mode & 0o077) === 0;
}

/**
 * Temp in the same directory, exclusive and 0600, then rename: a symlink at the path is replaced, not followed, a symlinked or looser
 * directory is refused and left as it is, and a reader sees a whole record or the previous one. `false`: nothing was written. Never throws.
 * `kind` names the temp file, which session deletion removes by exact name.
 */
export function writeRecordFile(file: string, sessionId: string, kind: 'exposure' | 'launch', value: unknown): boolean {
  const temp = path.join(path.dirname(file), `.${sessionId}.${kind}.${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!directoryOk(path.dirname(file))) return false;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    try {
      const text = `${JSON.stringify(value)}\n`;
      if (writeSync(fd, text) !== Buffer.byteLength(text, 'utf8')) throw new Error('short write');
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    return true;
  } catch {
    if (created) { try { unlinkSync(temp); } catch { /* junk that session deletion removes */ } }
    return false;
  }
}

export function writeExposureRecord(workDir: string, sessionId: string, record: ExposureRecord): boolean {
  if (typeof workDir !== 'string' || workDir === '' || !validSessionId(sessionId)) return false;
  return writeRecordFile(exposureRecordPath(workDir, sessionId), sessionId, 'exposure', record);
}

/** The parsed JSON of a small record, or `undefined`: absent, untrusted directory, not a regular file, over the bound, or not JSON. Never blocks on a FIFO, never follows a symlink, never throws. */
export function readRecordFile(file: string): unknown {
  let fd: number;
  try {
    if (!directoryOk(path.dirname(file))) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    return JSON.parse(buf.subarray(0, got).toString('utf8')) as unknown;
  } catch {
    return undefined;
  } finally {
    try { closeSync(fd); } catch { /* the read is already decided */ }
  }
}

/** A record, or `unknown`: absent, unreadable or not one of ours. There is no third answer, and `unknown` never means classic. */
export function readExposureRecord(workDir: string, sessionId: string): { readonly kind: 'record'; readonly record: ExposureRecord } | { readonly kind: 'unknown' } {
  const unknown = { kind: 'unknown' } as const;
  if (!validSessionId(sessionId)) return unknown;
  const v = readRecordFile(exposureRecordPath(workDir, sessionId)) as Partial<ExposureRecord> | null | undefined;
  if (typeof v !== 'object' || v === null) return unknown;
  if (v.v !== 1 || (v.effective !== 'replacement' && v.effective !== 'failed') || !Array.isArray(v.migrated) || !Array.isArray(v.residual) || typeof v.registryRevision !== 'string' || (v.nonce !== null && typeof v.nonce !== 'string')) return unknown;
  return { kind: 'record', record: v as ExposureRecord };
}
