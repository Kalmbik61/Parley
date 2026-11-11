// What a launcher decided for one launch (plan T8h, §5). Only a launcher can say replacement: it writes this file and puts a fresh nonce in the
// config env, and a session-MCP process honours the file only when its env nonce matches. A value in a repository's settings, a managed setting or
// a stale config cannot match, so none can turn the mode on or stop the server. Every launch overwrites the file, a classic one with no nonce, so an
// old config stops matching at the next launch. It is not consumed on use: a respawn inside one launch keeps its exposure, since a same-launch
// switch is what the design forbids (§7.1). A human turning the mode off therefore reaches a respawn only at the next launch: a stated limit.
//
// T8h defines and reads this; T12a writes it and calls `selectExposure`. Accounting-level trust, like the run record: the agent's own shell can
// read the file, and it can already do more through its tools.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { type ExposureRecord, readRecordFile, writeRecordFile } from './exposure-record.js';
import { MIGRATION_REGISTRY, type MigrationRegistry, migratableReads } from './migration-registry.js';
import { type RecordView, validSessionId } from './run-record.js';

/**
 * Identities a launch recorded (v2, lead m-7515 Q2): never contents. `client` is the client binary the launcher ran `--version` on and then
 * spawned, by realpath, with its inode (a decimal string: inodes exceed 2^53). `cwd` is the launch's working directory; `settings` the session
 * settings file Parley wrote; `configRoot` the client's config root as the launcher set it in the child's env (C2a, lead m-7557 Q-A), and
 * `gitRoot` the canonical git root of `cwd`. Each is optional: a launch records what its provider row needs.
 */
export interface LaunchIdentities {
  readonly client?: { readonly path: string; readonly version: string; readonly inode: string };
  readonly cwd?: string;
  readonly settings?: { readonly path: string; readonly sha256: string };
  readonly configRoot?: string;
  readonly gitRoot?: string;
}

/**
 * v1 is T8h's file; v2 adds the optional identities and is closed: a key outside its shape makes the file not understood. A reader that meets
 * any other `v` does not understand the file (fail-closed).
 */
export interface LaunchDecision extends LaunchIdentities {
  readonly v: 1 | 2;
  /** Fresh per launch; null on a classic launch, which no env nonce can match. */
  readonly nonce: string | null;
  readonly effective: 'replacement' | 'classic';
  /** The setting asked for replacement. */
  readonly requested: boolean;
  /** A fixed code when replacement was not chosen; null otherwise. */
  readonly reason: string | null;
  readonly provider: string;
  readonly at: string;
}

const NONCE = /^[0-9a-f]{32}$/;

export const newLaunchNonce = (): string => randomBytes(16).toString('hex');

export function launchDecisionPath(workDir: string, sessionId: string): string {
  return path.join(workDir, 'code-mode', `${sessionId}.launch.json`);
}

/** Atomic, 0600, under the directory rules of the other records. `false`: nothing was written, so the launch must not ask for replacement. Never throws. */
export function writeLaunchDecision(workDir: string, sessionId: string, decision: LaunchDecision): boolean {
  if (typeof workDir !== 'string' || workDir === '' || !validSessionId(sessionId)) return false;
  return writeRecordFile(launchDecisionPath(workDir, sessionId), sessionId, 'launch', decision);
}

export type LaunchDecisionRead =
  | { readonly kind: 'decision'; readonly decision: LaunchDecision }
  /** A file with a nonce that this build cannot read further: written by something newer, or wrong. */
  | { readonly kind: 'not-understood'; readonly nonce: string }
  | { readonly kind: 'none' };

const IDENTITY_KEYS = ['client', 'cwd', 'settings', 'configRoot', 'gitRoot'] as const;
const DECISION_KEYS: ReadonlySet<string> = new Set(['v', 'nonce', 'effective', 'requested', 'reason', 'provider', 'at', ...IDENTITY_KEYS]);
const isAbsolute = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= 4096 && path.isAbsolute(p) && !p.includes('\u0000');
const plainKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  typeof o === 'object' && o !== null && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();
function identitiesAbsent(v: object): boolean {
  return IDENTITY_KEYS.every((k) => !Object.hasOwn(v, k));
}
/** v2 is closed: no key outside its shape, and each identity, when present, has exactly its shape; anything else and the file is not understood. */
function identitiesValid(v: Partial<LaunchIdentities>): boolean {
  if (Object.keys(v).some((k) => !DECISION_KEYS.has(k))) return false;
  if (Object.hasOwn(v, 'client') && !(plainKeys(v.client, ['path', 'version', 'inode']) && isAbsolute(v.client['path']) && typeof v.client['version'] === 'string' && /^\d+\.\d+\.\d+$/.test(v.client['version']) && typeof v.client['inode'] === 'string' && /^[1-9]\d{0,19}$/.test(v.client['inode']))) return false;
  if (Object.hasOwn(v, 'cwd') && !isAbsolute(v.cwd)) return false;
  if (Object.hasOwn(v, 'configRoot') && !isAbsolute(v.configRoot)) return false;
  if (Object.hasOwn(v, 'gitRoot') && !isAbsolute(v.gitRoot)) return false;
  if (Object.hasOwn(v, 'settings') && !(plainKeys(v.settings, ['path', 'sha256']) && isAbsolute(v.settings['path']) && typeof v.settings['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(v.settings['sha256']))) return false;
  return true;
}

export function readLaunchDecision(workDir: string, sessionId: string): LaunchDecisionRead {
  const none = { kind: 'none' } as const;
  if (!validSessionId(sessionId)) return none;
  const v = readRecordFile(launchDecisionPath(workDir, sessionId)) as Partial<LaunchDecision> | null | undefined;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return none;
  const nonce = typeof v.nonce === 'string' && NONCE.test(v.nonce) ? v.nonce : null;
  if (nonce === null && v.nonce !== null) return none;
  const understood = (v.v === 1 ? identitiesAbsent(v) : v.v === 2 && identitiesValid(v)) && (v.effective === 'replacement' || v.effective === 'classic') && typeof v.requested === 'boolean' && (v.reason === null || typeof v.reason === 'string') && typeof v.provider === 'string' && typeof v.at === 'string';
  if (!understood) return nonce === null ? none : { kind: 'not-understood', nonce };
  // A replacement that no env nonce can match says nothing.
  if (nonce === null && v.effective === 'replacement') return none;
  return { kind: 'decision', decision: v as LaunchDecision };
}

/**
 * What a process started with this env nonce is. Fail-closed: no session, a missing, torn or untrusted file, or another launch's file (a file's nonce
 * has one shape, so an env value of any other cannot match it) are all classic, with no exit. Absence never reads as replacement. `not-understood`: the launcher did mean this process, and this build cannot tell what.
 */
export function honouredExposure(workDir: string, sessionId: string | null, envNonce: string): 'replacement' | 'classic' | 'not-understood' {
  if (sessionId === null) return 'classic';
  const read = readLaunchDecision(workDir, sessionId);
  if (read.kind === 'none') return 'classic';
  if (read.kind === 'not-understood') return read.nonce === envNonce ? 'not-understood' : 'classic';
  return read.decision.nonce === envNonce && read.decision.effective === 'replacement' ? 'replacement' : 'classic';
}

export type ExposureStatus = { readonly status: 'classic' } | { readonly status: 'ok' } | { readonly status: 'failed'; readonly reason: string } | { readonly status: 'unknown' };

/**
 * Did the launch's own process do what the decision asked? Only a record carrying this launch's nonce counts, so an earlier launch's `replacement`
 * cannot read as `ok` for a launch whose server died. A missing record is `unknown`, never classic: it is written at the first list.
 */
export function exposureStatus(decision: LaunchDecision, record: { readonly kind: 'record'; readonly record: ExposureRecord } | { readonly kind: 'unknown' }): ExposureStatus {
  if (decision.effective !== 'replacement') return { status: 'classic' };
  if (record.kind !== 'record' || record.record.nonce !== decision.nonce) return { status: 'unknown' };
  return record.record.effective === 'replacement' ? { status: 'ok' } : { status: 'failed', reason: record.record.reason ?? 'no-reason' };
}

export interface ExposureInput {
  /** The setting asks for replacement. */
  readonly requested: boolean;
  /** A fixed reason why the launch's gates refuse replacement; null when they pass. */
  readonly refused: string | null;
  /** `inspectRunRecord` of this session. */
  readonly record: RecordView;
  /** Some method the broker can run, in this build or an earlier one, is not a read (`writesExist` of the registry; T11). False today. */
  readonly writesExist?: boolean;
  /** The registry whose migratable reads a held record may name. Missing means the shipped one; a fixture passes its own. */
  readonly registry?: MigrationRegistry;
}

export type ExposureSelection =
  | { readonly effective: 'replacement'; readonly reason: null }
  | { readonly effective: 'classic'; readonly reason: string; readonly held?: 'unaccounted' | 'may-be-finishing' }
  /** Nothing is launched until a human decides: the design's explicit blocked handoff. */
  | { readonly effective: 'blocked'; readonly reason: 'non-read-record' | 'unreadable-record' };

/**
 * The launcher's choice, pure. A held record never picks replacement: classic takes no lease, a stray read has nothing to double, and the lost
 * outcome stays recorded. Written against effect, so T11 inherits it: a record naming a non-read method blocks, and so does an unreadable record
 * once writes exist, since it can hide what it named. A read is a migratable read of THIS build's registry (T11 B0): a record naming a method
this build does not allow as one (a write, an unknown name, or a read a later build migrated and this one does not) blocks, never classic.
Nothing here ends a live holder or touches a record.
 */
export function selectExposure(input: ExposureInput): ExposureSelection {
  const { record } = input;
  const reads = migratableReads(input.registry ?? MIGRATION_REGISTRY);
  if ((record.kind === 'held-live' || record.kind === 'unaccounted') && record.methods.some((m) => !reads.has(m))) return { effective: 'blocked', reason: 'non-read-record' };
  if (record.kind === 'unreadable' && input.writesExist === true) return { effective: 'blocked', reason: 'unreadable-record' };
  if (record.kind === 'held-live') return { effective: 'classic', reason: 'held-run', held: 'may-be-finishing' };
  if (record.kind === 'unaccounted' || record.kind === 'unreadable') return { effective: 'classic', reason: 'held-run', held: 'unaccounted' };
  if (!input.requested) return { effective: 'classic', reason: 'not-requested' };
  if (input.refused !== null) return { effective: 'classic', reason: input.refused };
  return { effective: 'replacement', reason: null };
}
