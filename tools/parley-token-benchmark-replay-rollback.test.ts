// T9a harness, slice H3b: rollback goals. This file owns the fixture mint expression and the `vi.mock` for the replacement server the busy criteria run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectRunRecord, runRecordPath } from '../packages/core/src/mcp/code-mode/run-record.js';
import { writePreload } from './parley-token-benchmark-replay-arms.js';
import { judgeRollbackGoal } from './parley-token-benchmark-replay-judge.js';
import { RollbackSetupError, plantRecord, runRollbackGoal, snapshotOf } from './parley-token-benchmark-replay-rollback.js';
import { checkGoalFile, type Goal } from './parley-token-benchmark-replay-schema.js';

vi.mock('../packages/core/dist/index.js', async (orig) => (await import('./parley-token-benchmark-replay-probe.js')).withHandlerProbe(await orig()));

const distDir = path.resolve('packages/core/dist');
const FIVE = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
let root = '';
let preload = '';
beforeAll(() => { preload = writePreload(mkdtempSync(path.join(tmpdir(), 'parley-replay-rb-preload-')), { distDir, proven: FIVE, mintExpression: 'np.claimFixtureSourceMint()' }); });
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'parley-replay-rollback-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const T = 180_000;

function goalOf(rollback: Record<string, unknown>, criteria: object[]): Goal {
  const r = checkGoalFile({ version: 1, goals: [{ id: 'rb', class: 'rollback', kind: 'rollback', goal: 'x', rollback: { record: 'none', requested: true, refused: null, writesExist: false, ...rollback }, criteria }] });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.goals[0]!;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('plantRecord: each state is written by the real store, in another process', () => {
  const plant = async (state: Parameters<typeof plantRecord>[0]) => {
    const workDir = path.join(root, 'work');
    const holder = await plantRecord(state, distDir, workDir, 's-01');
    return { workDir, holder, view: inspectRunRecord(workDir, 's-01'), file: runRecordPath(workDir, 's-01') };
  };
  it('none leaves no record', async () => {
    const p = await plant('none');
    expect(p.holder).toBeNull();
    expect(p.view).toEqual({ kind: 'free' });
    expect(existsSync(p.file)).toBe(false);
  }, T);
  it('held-live: the holder is alive and holds a read', async () => {
    const p = await plant('held-live');
    try {
      expect(p.holder!.pid).toBeGreaterThan(0);
      expect(alive(p.holder!.pid!)).toBe(true);
      expect(p.view).toEqual({ kind: 'held-live', methods: ['get_map'] });
    } finally { p.holder?.kill('SIGKILL'); }
  }, T);
  it('unaccounted: the holder is gone before it settled the call', async () => {
    const p = await plant('unaccounted');
    expect(p.holder).toBeNull();
    expect(p.view).toEqual({ kind: 'unaccounted', methods: ['get_map'] });
  }, T);
  it('dead-accounted: the holder settled the call and left the file, which reads as free', async () => {
    const p = await plant('dead-accounted');
    expect(p.view).toEqual({ kind: 'free' });
    expect(existsSync(p.file)).toBe(true);
  }, T);
  it('non-read-unaccounted: the intent names a method that is not a read', async () => {
    const p = await plant('non-read-unaccounted');
    expect(p.view).toEqual({ kind: 'unaccounted', methods: ['send_message'] });
  }, T);
  it('unreadable: a torn record in a directory the store would have made', async () => {
    const p = await plant('unreadable');
    expect(p.view).toEqual({ kind: 'unreadable' });
    expect(readFileSync(p.file, 'utf8').endsWith('\n')).toBe(false);
  }, T);
});

describe('snapshotOf: bytes, inode and mtime, or nothing', () => {
  it('none for a missing file; a change of bytes, of mtime, or of the inode is a different snapshot', () => {
    const f = path.join(root, 'rec');
    expect(snapshotOf(f)).toBeNull();
    writeFileSync(f, 'a');
    const a = snapshotOf(f)!;
    expect(snapshotOf(f)).toEqual(a);
    writeFileSync(f, 'b');
    expect(snapshotOf(f)!.sha256).not.toBe(a.sha256);
    writeFileSync(f, 'b');
    const b = snapshotOf(f)!;
    utimesSync(f, new Date(1_000_000), new Date(1_000_000));
    expect(snapshotOf(f)!.mtimeMs).not.toBe(b.mtimeMs);
    rmSync(f);
    writeFileSync(f, 'b');
    expect(statSync(f).ino === a.inode && snapshotOf(f)!.mtimeMs === a.mtimeMs).toBe(false);
  });
});

describe('a rollback goal through the real launcher choice and a real replacement server', () => {
  const run = (g: Goal) => runRollbackGoal(g, { dir: root, distDir, preloadPath: preload });
  it('a held live record: classic, held, may-be-finishing; the record is untouched; the server is busy; no host call; the holder is gone afterwards', async () => {
    const g = goalOf({ record: 'held-live' }, [{ selection: { effective: 'classic', reason: 'held-run', held: 'may-be-finishing' } }, { recordUnchanged: true }, { busy: { reason: 'held-by-other-process' } }, { repeatSelection: 3 }, { calls: 0 }]);
    const o = await run(g);
    expect(o.selection).toEqual({ effective: 'classic', reason: 'held-run', held: 'may-be-finishing' });
    expect(o.repeats).toHaveLength(3);
    expect(o.busyReason).toBe('held-by-other-process');
    expect(o.hostCalls).toBe(0);
    expect(o.before).not.toBeNull();
    expect(o.after).toEqual(o.before);
    expect(judgeRollbackGoal(g, o).every((v) => v.pass)).toBe(true);
  }, T);
  it('an unaccounted record is busy for another reason and stays as it was', async () => {
    const g = goalOf({ record: 'unaccounted' }, [{ selection: { effective: 'classic', reason: 'held-run', held: 'unaccounted' } }, { recordUnchanged: true }, { busy: { reason: 'previous-process-unaccounted' } }, { repeatSelection: 3 }, { calls: 0 }]);
    const o = await run(g);
    expect(o.busyReason).toBe('previous-process-unaccounted');
    expect(o.after).toEqual(o.before);
    expect(judgeRollbackGoal(g, o).every((v) => v.pass)).toBe(true);
  }, T);
  it('a goal with no server criterion asks no server: the choice and the unchanged record only', async () => {
    const g = goalOf({ record: 'unreadable' }, [{ selection: { effective: 'blocked', reason: 'unreadable-record' } }, { recordUnchanged: true }, { repeatSelection: 2 }]);
    const o = await run({ ...g, rollback: { ...(g.rollback as object), writesExist: true } as never });
    expect(o.busyReason).toBeNull();
    expect(o.hostCalls).toBe(0);
    expect(o.repeats).toHaveLength(2);
    expect(judgeRollbackGoal(g, o).every((v) => v.pass)).toBe(true);
  }, T);
  it('requested, refused and writesExist reach the choice', async () => {
    const choose = async (rollback: Record<string, unknown>) => (await run(goalOf(rollback, [{ selection: { effective: 'classic' } }]))).selection;
    expect(await choose({ requested: true })).toEqual({ effective: 'replacement', reason: null });
    expect(await choose({ requested: false })).toEqual({ effective: 'classic', reason: 'not-requested' });
    expect(await choose({ requested: true, refused: 'channel-missing' })).toEqual({ effective: 'classic', reason: 'channel-missing' });
    expect(await choose({ record: 'non-read-unaccounted', writesExist: true })).toEqual({ effective: 'blocked', reason: 'non-read-record' });
  }, T);
  it('the host calls of the server are counted: a script that reads once, on a clear record, makes one', async () => {
    const g = goalOf({ record: 'none' }, [{ selection: { effective: 'replacement' } }]);
    const o = await runRollbackGoal(g, { dir: root, distDir, preloadPath: preload, server: true, script: { code: 'const m = await parley.get_map({}); return m.ok;', extract: {} } });
    expect(o.hostCalls).toBe(1);
    expect(o.busyReason).toBeNull();
  }, T);
  it('the record after the arm is read after it: a dead accounted record is taken back by the server that runs, and the snapshots differ', async () => {
    const g = goalOf({ record: 'dead-accounted' }, [{ recordUnchanged: true }]);
    const o = await runRollbackGoal(g, { dir: root, distDir, preloadPath: preload, server: true });
    expect(o.before).not.toBeNull();
    expect(o.after).toBeNull();
  }, T);
  it('a goal that states nextLaunch stops the run by name', async () => {
    await expect(run(goalOf({}, [{ nextLaunch: { tools: 1, wrappers: false } }]))).rejects.toThrow(RollbackSetupError);
  }, T);
  it('no holder outlives the goal, and the scratch is removed', async () => {
    const g = goalOf({ record: 'held-live' }, [{ busy: { reason: 'held-by-other-process' } }]);
    await run(g);
    // a holder is killed and awaited by the goal itself; earlier tests of this file kill theirs without waiting, so give those the time to go (bounded)
    const holders = (): string[] => execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter((l) => l.includes('--input-type=module') && l.includes('rollback-holder'));
    for (let i = 0; i < 50 && holders().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(holders()).toEqual([]);
    expect(existsSync(path.join(root, 'rollback'))).toBe(false);
  }, T);
});

const GOALS = process.env['PARLEY_REPLAY_GOALS'];
describe.skipIf(GOALS === undefined)('the frozen rollback goals, judged for real', () => {
  const file = checkGoalFile(JSON.parse(readFileSync(GOALS ?? '/dev/null', 'utf8') || '{}'));
  const goals = file.ok ? file.goals.filter((g) => g.kind === 'rollback') : [];
  it('the file has the seven rollback goals (r2: the unreadable record is covered with and without writes)', () => { expect(goals).toHaveLength(7); });
  // A criterion that fails here is a repair task for the goal or the product, never a patch in this harness.
  it.each(goals.map((g) => [g.id, g] as const))('%s', async (_id, goal) => {
    const verdicts = judgeRollbackGoal(goal, await runRollbackGoal(goal, { dir: root, distDir, preloadPath: preload }));
    expect(verdicts.filter((v) => !v.pass).map((v) => `${v.where}: ${v.detail}`)).toEqual([]);
    expect(verdicts.length).toBe(goal.criteria.length);
  }, T);
});
