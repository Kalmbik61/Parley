// T9a harness, slice H3b: a `kind: "rollback"` goal. The run record the goal names is put on disk by the REAL run-record store, in a child process (the holder), so
// a record is held, unaccounted or accounted for exactly the reasons the product writes them; the launcher's choice is the REAL `selectExposure` over the REAL
// `inspectRunRecord`; and "a replacement process on that record" is a real replacement server (H2c) asked to run one script.
//
//   none                  no record at all
//   held-live             the holder opened a record, wrote an intent for a read, and is still alive
//   unaccounted           the same, and the holder is gone before it settled the call
//   dead-accounted        the holder settled the call and is gone, leaving the file
//   unreadable            a torn record (no end of line) in a record directory the store would have made
//   non-read-unaccounted  an intent for a method that is not a read, and the holder is gone
// `nextLaunch` (the server of the launch that follows) has no executor yet and no frozen goal uses it: a goal that states it stops the run by name.

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectExposure } from '../packages/core/src/mcp/code-mode/launch-decision.js';
import { inspectRunRecord, runRecordPath } from '../packages/core/src/mcp/code-mode/run-record.js';
import { workPaths } from '../packages/core/src/work/store.js';
import { type ReplacementScript, runArm } from './parley-token-benchmark-replay-arms.js';
import { buildGoalData } from './parley-token-benchmark-replay-data.js';
import type { RecordSnapshot, RollbackObservation, Selection } from './parley-token-benchmark-replay-judge.js';
import type { Goal, Obj } from './parley-token-benchmark-replay-schema.js';

/** A rollback input the harness has no executor for, or a holder that did not do what the state needs: the run stops, the goal is not judged on what is missing. */
export class RollbackSetupError extends Error {}

type State = 'none' | 'held-live' | 'unaccounted' | 'dead-accounted' | 'unreadable' | 'non-read-unaccounted';

/** The holder: opens a record through the product's own store, writes what the state needs, says `ready`, and then stays or goes. */
const HOLDER = `
const { createRunRecordStore } = await import(process.argv[1]);
const [workDir, sessionId, mode, method] = process.argv.slice(2);
const store = createRunRecordStore({ workDir, sessionId, launchId: 'rollback-holder' });
const open = store.open('run-rollback');
if (!open.ok) { process.stderr.write('busy ' + open.busy); process.exit(3); }
if (!store.intent('run-rollback', 1, method, '0'.repeat(64))) { process.stderr.write('intent'); process.exit(4); }
if (mode === 'settled') open.handle.sync({ entries: [{ ordinal: 1, state: 'succeeded', refusal: null }], cleanupUnknown: false });
process.stdout.write('ready\\n');
if (mode === 'alive') setInterval(() => {}, 1000); else process.exit(0);
`;

/** Starts the holder and waits for it to be ready, and, when it is to leave, to be gone. */
async function holder(distDir: string, workDir: string, sessionId: string, mode: 'alive' | 'abandoned' | 'settled', method: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER, pathToFileURL(path.join(distDir, 'mcp', 'code-mode', 'run-record.js')).href, workDir, sessionId, mode, method], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (c: Buffer) => { err += c.toString(); });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (c: Buffer) => { out += c.toString(); if (out.includes('ready')) resolve(); });
    child.once('close', (code) => { if (!out.includes('ready')) reject(new RollbackSetupError(`the record holder exited with ${String(code)} before it was ready: ${err}`)); });
  });
  if (mode !== 'alive') await new Promise<void>((resolve) => { if (child.exitCode !== null && child.stdout!.destroyed) resolve(); else child.once('close', () => resolve()); });
  return child;
}

/** Puts the record of `state` where the server for `sessionId` will look; returns the live holder, if the state needs one. */
export async function plantRecord(state: State, distDir: string, workDir: string, sessionId: string): Promise<ChildProcess | null> {
  switch (state) {
    case 'none': return null;
    case 'held-live': return holder(distDir, workDir, sessionId, 'alive', 'get_map');
    case 'unaccounted': await holder(distDir, workDir, sessionId, 'abandoned', 'get_map'); return null;
    case 'dead-accounted': await holder(distDir, workDir, sessionId, 'settled', 'get_map'); return null;
    case 'non-read-unaccounted': await holder(distDir, workDir, sessionId, 'abandoned', 'send_message'); return null;
    case 'unreadable': {
      const file = runRecordPath(workDir, sessionId);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, '{"v":1,"runId":"run-rollback"', { mode: 0o600 }); // a torn first line: no end of line
      return null;
    }
  }
}

/** Bytes, inode and mtime of the record file, or null when there is none. */
export function snapshotOf(file: string): RecordSnapshot | null {
  if (!existsSync(file)) return null;
  const st = statSync(file);
  return { sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), inode: st.ino, mtimeMs: st.mtimeMs };
}

const DATA = {
  self: 'caller', sessions: [{ key: 'caller', label: 'Synthetic caller', provider: 'codex', lifecycle: 'active', task: 'Hold the record', summary: 'ROLLBACK-CALLER' }], rooms: [], plans: [], backlog: [],
};

export interface RollbackDeps {
  /** A scratch directory the goal may use (removed by the caller). */
  readonly dir: string;
  /** `packages/core/dist`. */
  readonly distDir: string;
  /** The replacement arm's preload (the test that owns the mint writes it). */
  readonly preloadPath: string;
  /** The script the replacement server is asked to run (default: one that reads nothing). */
  readonly script?: ReplacementScript;
  /** Ask the replacement server even when no criterion needs it (for a test of what the server does to the record and the host). */
  readonly server?: boolean;
}

/** Runs one rollback goal: plants its record, reads the launcher's choice (and repeats it), asks a replacement server to run a script, and returns what the judge reads. */
export async function runRollbackGoal(goal: Goal, deps: RollbackDeps): Promise<RollbackObservation> {
  const R = goal.rollback as Obj | undefined;
  if (goal.kind !== 'rollback' || R === undefined || R === null) throw new RollbackSetupError(`goal ${goal.id} is not a rollback goal`);
  if (goal.criteria.some((c) => 'nextLaunch' in c)) throw new RollbackSetupError('nextLaunch (the server of the launch that follows) has no executor yet');
  const state = String(R['record']) as State;
  const repeats = goal.criteria.reduce((n, c) => ('repeatSelection' in c ? Number(c['repeatSelection']) : n), 1);
  const needsServer = deps.server === true || goal.criteria.some((c) => 'busy' in c || 'calls' in c);

  const built = await buildGoalData({ ...goal, kind: 'run', data: DATA as never }, path.join(deps.dir, 'rollback'));
  let live: ChildProcess | null = null;
  let selection: Selection | null = null;
  let repeated: Selection[] = [];
  let before: RecordSnapshot | null = null;
  let after: RecordSnapshot | null = null;
  let busyReason: string | null = null;
  let hostCalls = 0;
  const choose = (workDir: string): Selection => {
    const s = selectExposure({ requested: R['requested'] === true, refused: (R['refused'] as string | null) ?? null, record: inspectRunRecord(workDir, built.selfId), writesExist: R['writesExist'] === true });
    return s as unknown as Selection;
  };
  const seam = async ({ workDir }: { readonly workDir: string }): Promise<void> => {
    live = await plantRecord(state, deps.distDir, workDir, built.selfId);
    const file = runRecordPath(workDir, built.selfId);
    before = snapshotOf(file);
    selection = choose(workDir);
    repeated = Array.from({ length: repeats }, () => choose(workDir));
  };
  try {
    if (needsServer) {
      const armGoal = { ...goal, kind: 'run' as const, faults: {}, criteria: [], data: DATA as never };
      const arm = await runArm({
        goal: armGoal, arm: 'replacement', built, script: deps.script ?? { code: 'return null;', extract: {} }, distDir: deps.distDir, preloadPath: deps.preloadPath, beforeLaunch: seam,
        // the server of the run is gone when its client is; a holder that is still alive is the holder, not the server
      });
      const busy = arm.result?.diagnostics.find((d) => d.code === 'busy');
      busyReason = busy === undefined ? null : String(busy.params?.['reason'] ?? 'other');
      hostCalls = arm.hostLog.filter((e) => e.op === 'call').length;
      after = snapshotOf(runRecordPath(workPaths(built.project, built.workId).dir, built.selfId));
    } else {
      const workDir = workPaths(built.project, built.workId).dir;
      await seam({ workDir });
      after = snapshotOf(runRecordPath(workDir, built.selfId));
    }
  } finally {
    const child = live as ChildProcess | null;
    if (child !== null && child.exitCode === null) { child.kill('SIGKILL'); await new Promise<void>((r) => child.once('exit', () => r())); }
    rmSync(path.join(deps.dir, 'rollback'), { recursive: true, force: true });
  }
  if (selection === null) throw new RollbackSetupError('the launcher\'s choice was never read');
  return { selection, repeats: repeated, before, after, nextLaunch: null, busyReason, hostCalls };
}
