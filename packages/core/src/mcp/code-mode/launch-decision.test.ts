// The launch decision (plan T8h): where it may land, when a process may believe it, what the launcher picks, and what the launch's own process confirmed.

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExposureRecord } from './exposure-record.js';
import { type ExposureInput, type LaunchDecision, exposureStatus, honouredExposure, launchDecisionPath, newLaunchNonce, readLaunchDecision, selectExposure, writeLaunchDecision } from './launch-decision.js';
import { MIGRATABLE_READS, MIGRATION_REGISTRY } from './migration-registry.js';
import { LIVE_POLICY_UNAVAILABLE, resolveLiveNativePolicy } from './native-policy.js';
import { type ProcessProbe, type RecordView, inspectRunRecord, runRecordPath } from './run-record.js';

const roots: string[] = [];
const newRoot = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'parley-t8h-decision-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) { try { chmodSync(path.join(d, 'code-mode'), 0o700); } catch { /* none */ } rmSync(d, { recursive: true, force: true }); } });

const SID = 's-1';
const decision = (over: Partial<LaunchDecision> = {}): LaunchDecision => ({ v: 1, nonce: 'a'.repeat(32), effective: 'replacement', requested: true, reason: null, provider: 'claude', at: '2026-11-09T00:00:00.000Z', ...over });
let workDir: string;
beforeEach(() => { workDir = newRoot(); });

describe('v2: the identities a launch records (T12a-Claude, lead m-7515 Q2)', () => {
  const client = { path: '/opt/claude/versions/2.1.322', version: '2.1.322', inode: '1152921500312611996' };
  const settings = { path: '/w/.parley/works/w-0001/settings/s-01.json', sha256: 'c'.repeat(64) };
  // The writer stores any value as given; the shape check is the reader's.
  const raw = (value: unknown): void => { expect(writeLaunchDecision(workDir, SID, value as LaunchDecision)).toBe(true); };
  it('each identity, alone or together, is read back; identities never ride on a v1 file', () => {
    for (const ids of [{}, { client }, { cwd: '/w/project' }, { settings }, { client, cwd: '/w/project', settings }]) {
      expect(writeLaunchDecision(workDir, SID, decision({ v: 2, ...ids }))).toBe(true);
      expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'decision', decision: decision({ v: 2, ...ids }) });
    }
    expect(writeLaunchDecision(workDir, SID, decision({ v: 1, client }))).toBe(true);
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'not-understood', nonce: 'a'.repeat(32) });
  });
  it('configRoot and gitRoot (C2a) are read back; v2 is closed: an unknown top-level key is not understood, none without a nonce', () => {
    const ids = { cwd: '/w/project', configRoot: '/home/u/.claude', gitRoot: '/w' };
    expect(writeLaunchDecision(workDir, SID, decision({ v: 2, ...ids }))).toBe(true);
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'decision', decision: decision({ v: 2, ...ids }) });
    raw({ ...decision({ v: 2 }), extra: 1 });
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'not-understood', nonce: 'a'.repeat(32) });
    raw({ ...decision({ v: 2, nonce: null, effective: 'classic', reason: 'detector' }), extra: 1 });
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'none' });
  });
  it.each([
    ['an unknown v', { v: 3 }],
    ['a relative configRoot', { v: 2, configRoot: '.claude' }],
    ['a relative gitRoot', { v: 2, gitRoot: 'repo' }],
    ['a numeric configRoot', { v: 2, configRoot: 7 }],
    ['a relative client path', { v: 2, client: { ...client, path: 'claude' } }],
    ['a client version that is not x.y.z', { v: 2, client: { ...client, version: '2.1.322 (Claude Code)' } }],
    ['a numeric inode', { v: 2, client: { ...client, inode: 42 } }],
    ['an extra client key', { v: 2, client: { ...client, size: 1 } }],
    ['a relative cwd', { v: 2, cwd: 'project' }],
    ['a settings hash that is not sha256', { v: 2, settings: { ...settings, sha256: 'x' } }],
  ])('%s: not understood, so the server refuses and a classic file reads as none (fail-closed)', (_name, over) => {
    raw(decision(over as never));
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'not-understood', nonce: 'a'.repeat(32) });
    raw(decision({ ...(over as object), nonce: null, effective: 'classic', reason: 'provider-unproven' } as never));
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'none' });
  });
  it('the reader shipped before v2 (7a83d601), run on a v2 file: not-understood with the nonce, none without (it cannot open Code Mode)', async () => {
    // The shipped module, verbatim from git, beside links to today's siblings it imports; then it reads files today's writer wrote.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const old = newRoot();
    writeFileSync(path.join(old, 'launch-decision.ts'), execFileSync('git', ['show', '7a83d601:packages/core/src/mcp/code-mode/launch-decision.ts'], { cwd: here, encoding: 'utf8' }));
    for (const sibling of ['exposure-record.ts', 'migration-registry.ts', 'run-record.ts']) symlinkSync(path.join(here, sibling), path.join(old, sibling));
    const shipped = (await import(pathToFileURL(path.join(old, 'launch-decision.ts')).href)) as { readLaunchDecision: typeof readLaunchDecision };
    expect(writeLaunchDecision(workDir, SID, decision({ v: 2, client }))).toBe(true);
    expect(shipped.readLaunchDecision(workDir, SID)).toEqual({ kind: 'not-understood', nonce: 'a'.repeat(32) });
    expect(writeLaunchDecision(workDir, SID, decision({ v: 2, client, nonce: null, effective: 'classic', reason: 'client-version' }))).toBe(true);
    expect(shipped.readLaunchDecision(workDir, SID)).toEqual({ kind: 'none' });
    // The control: the same shipped reader understands a v1 file.
    expect(writeLaunchDecision(workDir, SID, decision())).toBe(true);
    expect(shipped.readLaunchDecision(workDir, SID)).toEqual({ kind: 'decision', decision: decision() });
  });
});

describe('the file', () => {
  it('whole, 0600 in a 0700 directory, no temp left, and it reads back', () => {
    expect(writeLaunchDecision(workDir, SID, decision())).toBe(true);
    const file = launchDecisionPath(workDir, SID);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file))).toEqual([`${SID}.launch.json`]);
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'decision', decision: decision() });
  });
  it('every write replaces it: a classic launch leaves no nonce to match', () => {
    writeLaunchDecision(workDir, SID, decision());
    writeLaunchDecision(workDir, SID, decision({ nonce: null, effective: 'classic', requested: false, reason: 'not-requested' }));
    expect(readLaunchDecision(workDir, SID)).toMatchObject({ kind: 'decision', decision: { nonce: null, effective: 'classic' } });
    expect(honouredExposure(workDir, SID, 'a'.repeat(32))).toBe('classic');
  });
  it('a nonce is 128 random bits, new each time', () => {
    expect(newLaunchNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(Array.from({ length: 50 }, newLaunchNonce)).size).toBe(50);
  });
  it.each(['../x', '..', 'a/b', 'S-1', ''])('session id %j: refused, nothing written anywhere', (sid) => {
    expect(writeLaunchDecision(workDir, sid, decision())).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
    expect(readLaunchDecision(workDir, sid)).toEqual({ kind: 'none' });
    expect(honouredExposure(workDir, sid, 'a'.repeat(32))).toBe('classic');
  });
  it('a symlink at the path is replaced, and its target is untouched', () => {
    const target = path.join(workDir, 'target');
    writeFileSync(target, 'mine');
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    symlinkSync(target, launchDecisionPath(workDir, SID));
    expect(writeLaunchDecision(workDir, SID, decision())).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('mine');
    expect(lstatSync(launchDecisionPath(workDir, SID)).isSymbolicLink()).toBe(false);
  });
  it('a symlinked or loose directory is refused and left as it is', () => {
    const elsewhere = path.join(workDir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(workDir, 'code-mode'));
    expect(writeLaunchDecision(workDir, SID, decision())).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    const loose = newRoot();
    mkdirSync(path.join(loose, 'code-mode'));
    chmodSync(path.join(loose, 'code-mode'), 0o755);
    expect(writeLaunchDecision(loose, SID, decision())).toBe(false);
    expect(statSync(path.join(loose, 'code-mode')).mode & 0o777).toBe(0o755);
    expect(readdirSync(path.join(loose, 'code-mode'))).toEqual([]);
  });
});

describe('reading: nothing here blocks or follows, and absence never reads as replacement', () => {
  const plant = (text: string): void => { mkdirSync(path.join(workDir, 'code-mode'), { recursive: true, mode: 0o700 }); writeFileSync(launchDecisionPath(workDir, SID), text, { mode: 0o600 }); };
  const NONCE = 'a'.repeat(32);
  it('no file: classic', () => { expect(honouredExposure(workDir, SID, NONCE)).toBe('classic'); });
  it('no session: classic, and the file is not asked', () => { writeLaunchDecision(workDir, SID, decision()); expect(honouredExposure(workDir, null, NONCE)).toBe('classic'); });
  it.each(['', 'replacement', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)} `])('env nonce %j, of the wrong shape: classic', (nonce) => { writeLaunchDecision(workDir, SID, decision()); expect(honouredExposure(workDir, SID, nonce)).toBe('classic'); });
  it('another launch\'s nonce: classic', () => { writeLaunchDecision(workDir, SID, decision()); expect(honouredExposure(workDir, SID, 'b'.repeat(32))).toBe('classic'); });
  it('the matching nonce, replacement: replacement. Read twice: not consumed', () => {
    writeLaunchDecision(workDir, SID, decision());
    expect(honouredExposure(workDir, SID, NONCE)).toBe('replacement');
    expect(honouredExposure(workDir, SID, NONCE)).toBe('replacement');
  });
  it('the matching nonce, classic: classic', () => { writeLaunchDecision(workDir, SID, decision({ effective: 'classic', reason: 'x' })); expect(honouredExposure(workDir, SID, NONCE)).toBe('classic'); });
  it.each(['{"v":1,"non', '', 'null', '[]', '7', '"x"'])('%j, torn or not one of ours: none', (text) => { plant(text); expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'none' }); expect(honouredExposure(workDir, SID, NONCE)).toBe('classic'); });
  it('a file with no usable nonce: none, whatever else it says', () => {
    for (const nonce of [undefined, 7, 'short']) { plant(JSON.stringify({ ...decision(), nonce })); expect(readLaunchDecision(workDir, SID), String(nonce)).toEqual({ kind: 'none' }); }
    plant(JSON.stringify({ ...decision(), nonce: null }));
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'none' });
  });
  it.each([[{ effective: 'alongside' }], [{ effective: null }], [{ v: 3 }], [{ requested: 'yes' }], [{ reason: 7 }], [{ provider: 1 }], [{ at: 0 }]])('%j with its nonce: not understood, only for that nonce', (over) => {
    plant(JSON.stringify({ ...decision(), ...over }));
    expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'not-understood', nonce: NONCE });
    expect(honouredExposure(workDir, SID, NONCE)).toBe('not-understood');
    expect(honouredExposure(workDir, SID, 'b'.repeat(32))).toBe('classic');
  });
  it('a FIFO at the path: no hang, none', () => { mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 }); execFileSync('mkfifo', [launchDecisionPath(workDir, SID)]); expect(readLaunchDecision(workDir, SID)).toEqual({ kind: 'none' }); });
  it('a symlink at the path is not followed', () => {
    const target = path.join(workDir, 'target');
    writeFileSync(target, JSON.stringify(decision()));
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    symlinkSync(target, launchDecisionPath(workDir, SID));
    expect(honouredExposure(workDir, SID, NONCE)).toBe('classic');
  });
  it('a directory at the path', () => { mkdirSync(launchDecisionPath(workDir, SID), { recursive: true, mode: 0o700 }); chmodSync(path.join(workDir, 'code-mode'), 0o700); expect(honouredExposure(workDir, SID, NONCE)).toBe('classic'); });
  it('oversized', () => { plant(`${JSON.stringify(decision())}${' '.repeat(70 * 1024)}`); expect(honouredExposure(workDir, SID, NONCE)).toBe('classic'); });
  it('a symlinked directory: a file behind it is not believed', () => {
    const elsewhere = path.join(workDir, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(path.join(elsewhere, `${SID}.launch.json`), JSON.stringify(decision()));
    symlinkSync(elsewhere, path.join(workDir, 'code-mode'));
    expect(honouredExposure(workDir, SID, NONCE)).toBe('classic');
  });
  it('a loose directory: a file in it is not believed', () => {
    writeLaunchDecision(workDir, SID, decision());
    chmodSync(path.join(workDir, 'code-mode'), 0o750);
    expect(honouredExposure(workDir, SID, NONCE)).toBe('classic');
  });
});

describe('exposureStatus: only a record of this launch counts', () => {
  const record = (over: Partial<ExposureRecord>): { kind: 'record'; record: ExposureRecord } => ({ kind: 'record', record: { v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: 'h', launchId: 'l', nonce: 'a'.repeat(32), ...over } });
  it('a classic launch: nothing was asked', () => { expect(exposureStatus(decision({ nonce: null, effective: 'classic' }), { kind: 'unknown' })).toEqual({ status: 'classic' }); });
  it('this launch said replacement: ok', () => { expect(exposureStatus(decision(), record({}))).toEqual({ status: 'ok' }); });
  it('this launch said failed: failed, with its code', () => { expect(exposureStatus(decision(), record({ effective: 'failed', reason: 'partition' }))).toEqual({ status: 'failed', reason: 'partition' }); });
  it('no record: unknown, never classic', () => { expect(exposureStatus(decision(), { kind: 'unknown' })).toEqual({ status: 'unknown' }); });
  it('launch 1\'s replacement after launch 2\'s server died: unknown, not ok', () => { expect(exposureStatus(decision({ nonce: 'b'.repeat(32) }), record({}))).toEqual({ status: 'unknown' }); });
  it('launch 1\'s failed after launch 2: unknown, not that failure', () => { expect(exposureStatus(decision({ nonce: 'b'.repeat(32) }), record({ effective: 'failed', reason: 'partition' }))).toEqual({ status: 'unknown' }); });
  it('a record with no nonce never matches', () => { expect(exposureStatus(decision(), record({ nonce: null }))).toEqual({ status: 'unknown' }); });
});

describe('selectExposure: every row of §2', () => {
  const FREE: RecordView = { kind: 'free' };
  const input = (over: Partial<ExposureInput> = {}): ExposureInput => ({ requested: true, refused: null, record: FREE, ...over });
  it('asked, gates pass, no record: replacement', () => { expect(selectExposure(input())).toEqual({ effective: 'replacement', reason: null }); });
  it('the human turned it off: classic, with the reason', () => { expect(selectExposure(input({ requested: false }))).toEqual({ effective: 'classic', reason: 'not-requested' }); });
  it('a gate or the detector refuses: classic, with its reason', () => { expect(selectExposure(input({ refused: 'detector' }))).toEqual({ effective: 'classic', reason: 'detector' }); });
  it.each([
    ['holder dead, unaccounted', { kind: 'unaccounted', methods: ['get_map'] }, 'unaccounted'],
    ['holder alive', { kind: 'held-live', methods: ['get_map'] }, 'may-be-finishing'],
    ['holder alive, no call yet', { kind: 'held-live', methods: [] }, 'may-be-finishing'],
    ['unreadable, while the broker runs reads', { kind: 'unreadable' }, 'unaccounted'],
  ] as [string, RecordView, string][])('%s: classic, held-run, whatever was asked', (_n, record, held) => {
    for (const requested of [true, false]) expect(selectExposure(input({ requested, record }))).toEqual({ effective: 'classic', reason: 'held-run', held });
    expect(selectExposure(input({ refused: 'detector', record }))).toEqual({ effective: 'classic', reason: 'held-run', held });
  });
  it.each(['unaccounted', 'held-live'] as const)('%s naming a non-read method: blocked, whatever was asked', (kind) => {
    for (const requested of [true, false]) expect(selectExposure(input({ requested, record: { kind, methods: ['get_map', 'send_message'] } }))).toEqual({ effective: 'blocked', reason: 'non-read-record' });
  });
  it('unreadable once writes exist: blocked, since it can hide what it named', () => { expect(selectExposure(input({ record: { kind: 'unreadable' }, writesExist: true }))).toEqual({ effective: 'blocked', reason: 'unreadable-record' }); });
  it('a free record stays free once writes exist', () => { expect(selectExposure(input({ writesExist: true }))).toEqual({ effective: 'replacement', reason: null }); });
  it('a read is a migratable read of the given registry (T11 B0): a sixth one is classic under a registry that allows it, blocked under the shipped one', () => {
    const record: RecordView = { kind: 'held-live', methods: ['get_capacity'] };
    const six = { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'get_capacity'] };
    expect(selectExposure(input({ record, registry: six }))).toEqual({ effective: 'classic', reason: 'held-run', held: 'may-be-finishing' });
    expect(selectExposure(input({ record }))).toEqual({ effective: 'blocked', reason: 'non-read-record' });
  });
  it('a write on a fixture allowlist is still no read, and a name no registry enters blocks', () => {
    const withWrite = { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'send_message'] };
    expect(selectExposure(input({ record: { kind: 'unaccounted', methods: ['send_message'] }, registry: withWrite }))).toEqual({ effective: 'blocked', reason: 'non-read-record' });
    expect(selectExposure(input({ record: { kind: 'unaccounted', methods: ['new_tool'] } }))).toEqual({ effective: 'blocked', reason: 'non-read-record' });
  });
  it('all five reads are reads: none of them blocks', () => {
    expect(selectExposure(input({ record: { kind: 'unaccounted', methods: ['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room'] } }))).toEqual({ effective: 'classic', reason: 'held-run', held: 'unaccounted' });
  });
  it('a held record never picks replacement, over every input', () => {
    const records: RecordView[] = [{ kind: 'held-live', methods: [] }, { kind: 'held-live', methods: ['get_map'] }, { kind: 'unaccounted', methods: [] }, { kind: 'unaccounted', methods: ['report'] }, { kind: 'unreadable' }];
    for (const record of records) for (const requested of [true, false]) for (const refused of [null, 'x']) for (const writesExist of [true, false]) {
      expect(selectExposure({ requested, refused, record, writesExist }).effective).not.toBe('replacement');
    }
  });
});

describe('the launcher\'s classifier changes nothing (R1)', () => {
  const NONCE = 'a'.repeat(32);
  const SHA = 'b'.repeat(64);
  const HOLDER = 4242;
  const START = 1_800_000_000;
  const DEAD: ProcessProbe = { alive: () => false, startedAt: () => null };
  const ALIVE: ProcessProbe = { alive: () => true, startedAt: () => START };
  const header = { v: 1, runId: 'run-1-1', launchId: 'l', pid: HOLDER, startedAt: START, nonce: NONCE, at: 't' };
  const dir = (): string => path.join(workDir, 'code-mode');
  const plant = (...lines: unknown[]): void => {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(runRecordPath(workDir, SID), lines.map((l) => `${typeof l === 'string' ? l : JSON.stringify(l)}\n`).join(''), { mode: 0o600 });
  };
  /** The directory's time is moved back first, so that a created and removed file would show. */
  const backdate = (): void => { const past = new Date(1_700_000_000_000); utimesSync(dir(), past, past); };
  /** Names, inodes, sizes, modes, times and bytes of everything in the directory, and the directory's own. */
  const state = (): unknown => {
    const d = dir();
    const self = lstatSync(d);
    return { dir: [self.mode, self.mtimeMs, self.ctimeMs], files: readdirSync(d).sort().map((f) => { const st = lstatSync(path.join(d, f)); return [f, st.ino, st.size, st.mode, st.mtimeMs, st.ctimeMs, st.nlink, st.isFile() ? readFileSync(path.join(d, f), 'utf8') : null]; }) };
  };
  const intent = { o: 1, m: 'get_map', a: SHA };
  it.each([
    ['a live holder', ALIVE, [header, intent], { kind: 'held-live', methods: ['get_map'] }],
    ['a live holder with nothing dispatched', ALIVE, [header], { kind: 'held-live', methods: [] }],
    ['a dead holder, unaccounted', DEAD, [header, intent, { o: 1, s: 'unknown' }], { kind: 'unaccounted', methods: ['get_map'] }],
    ['a dead holder, an intent with no terminal line', DEAD, [header, intent], { kind: 'unaccounted', methods: ['get_map'] }],
    ['a dead holder, cleanup unknown', DEAD, [header, { cleanup: 'unknown' }], { kind: 'unaccounted', methods: [] }],
    ['a dead accounted record: free, and it stays where it is', DEAD, [header, intent, { o: 1, s: 'succeeded' }], { kind: 'free' }],
    ['a dead empty record', DEAD, [header], { kind: 'free' }],
    ['a reused pid: the holder is gone', { alive: () => true, startedAt: () => START + 100 }, [header, intent], { kind: 'unaccounted', methods: ['get_map'] }],
    ['ps failing reads as alive', { alive: () => true, startedAt: () => null }, [header], { kind: 'held-live', methods: [] }],
    ['torn', DEAD, ['{"v":1'], { kind: 'unreadable' }],
  ] as [string, ProcessProbe, unknown[], RecordView][])('%s', (_n, probe, lines, view) => {
    plant(...lines);
    backdate();
    const before = state();
    expect(inspectRunRecord(workDir, SID, probe)).toEqual(view);
    expect(state()).toEqual(before);
  });
  it('a claim left by a reclaimer: unreadable, as `open` would refuse it, and the claim stays', () => {
    plant(header);
    writeFileSync(`${runRecordPath(workDir, SID)}.claim.${NONCE}`, 'x');
    backdate();
    const before = state();
    expect(inspectRunRecord(workDir, SID, DEAD)).toEqual({ kind: 'unreadable' });
    expect(state()).toEqual(before);
  });
  it('no directory: free, and none is made', () => { expect(inspectRunRecord(workDir, SID, DEAD)).toEqual({ kind: 'free' }); expect(readdirSync(workDir)).toEqual([]); });
  it('a directory with no record: free', () => { mkdirSync(dir(), { mode: 0o700 }); expect(inspectRunRecord(workDir, SID, DEAD)).toEqual({ kind: 'free' }); });
  it('a symlinked or loose directory: unreadable, and a record behind it is not believed', () => {
    const elsewhere = path.join(workDir, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, dir());
    expect(inspectRunRecord(workDir, SID, DEAD)).toEqual({ kind: 'unreadable' });
    const loose = newRoot();
    mkdirSync(path.join(loose, 'code-mode'));
    chmodSync(path.join(loose, 'code-mode'), 0o755);
    expect(inspectRunRecord(loose, SID, DEAD)).toEqual({ kind: 'unreadable' });
  });
  it('a FIFO at the path: no hang, unreadable', () => { mkdirSync(dir(), { mode: 0o700 }); execFileSync('mkfifo', [runRecordPath(workDir, SID)]); expect(inspectRunRecord(workDir, SID, DEAD)).toEqual({ kind: 'unreadable' }); });
  it.each(['', '../x', 'a/b'])('a bad session id %j: unreadable, nothing touched', (sid) => { expect(inspectRunRecord(workDir, sid, DEAD)).toEqual({ kind: 'unreadable' }); expect(readdirSync(workDir)).toEqual([]); });
  it('agrees with `open` on what a process about to run a script would be told, row by row', async () => {
    const { createRunRecordStore } = await import('./run-record.js');
    const rows: [ProcessProbe, unknown[], 'free' | string][] = [
      [ALIVE, [header], 'held-by-other-process'],
      [DEAD, [header, intent], 'previous-process-unaccounted'],
      [DEAD, ['torn'], 'run-record-unavailable'],
      [DEAD, [header], 'free'],
    ];
    for (const [probe, lines, told] of rows) {
      plant(...lines);
      const view = inspectRunRecord(workDir, SID, probe);
      const opened = createRunRecordStore({ workDir, sessionId: SID, launchId: 'l' }, probe).open('run-x');
      if (told === 'free') { expect(view).toEqual({ kind: 'free' }); expect(opened.ok).toBe(true); if (opened.ok) opened.handle.release(); }
      else { expect(view.kind).not.toBe('free'); expect(opened).toEqual({ ok: false, busy: told }); }
    }
  });
});

describe('a static check of the launcher\'s path (§9.8)', () => {
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  it('the classifier writes, removes and claims nothing', () => {
    const text = src('./run-record.ts');
    const body = text.slice(text.indexOf('export function inspectRunRecord'), text.indexOf('export interface RunRecordOptions'));
    expect(body).toContain('readRecord(file)');
    expect(body).not.toMatch(/\b(unlinkSync|linkSync|mkdirSync|writeSync|openSync|renameSync|\.open\(|reclaim|release)\b/);
  });
  it('the decision module touches no run record and calls no tool: it only reads a view of one', () => {
    const text = src('./launch-decision.ts');
    expect(text).not.toMatch(/\b(unlinkSync|linkSync|runRecordPath|createRunRecordStore|callTool|fetch)\b|inspectRunRecord\(/);
  });
  it('no source file writes a released or aged state: nothing in the record has one', () => {
    const text = src('./run-record.ts');
    expect(text).not.toMatch(/['"]released['"]|['"]aged['"]|maxAge|expires/);
  });
});

describe('T8e R8: every refusal is classic with a fixed reason, and replacement is chosen only when nothing refuses', () => {
  const input = (over: Partial<ExposureInput> = {}): ExposureInput => ({ requested: true, refused: null, record: { kind: 'free' }, ...over });
  const RECORDS: [string, ExposureInput['record']][] = [
    ['free', { kind: 'free' }],
    ['held-live', { kind: 'held-live', methods: ['get_map'] }],
    ['unaccounted', { kind: 'unaccounted', methods: ['get_map'] }],
    ['unreadable', { kind: 'unreadable' }],
  ];

  it('a live launch has no native-policy authority: the policy reason it reports selects classic', () => {
    expect(resolveLiveNativePolicy({ anything: true })).toBe(LIVE_POLICY_UNAVAILABLE);
    expect(selectExposure(input({ refused: resolveLiveNativePolicy().reason }))).toEqual({ effective: 'classic', reason: 'native-policy-unproven' });
  });

  it('exhaustive: replacement is selected exactly when it was requested, nothing refuses and the record is free', () => {
    for (const requested of [true, false]) for (const refused of [null, 'native-policy-unproven', 'detector', 'helper-unavailable']) for (const [kind, record] of RECORDS) {
      const picked = selectExposure(input({ requested, refused, record })).effective === 'replacement';
      expect(picked, `${requested} ${refused} ${kind}`).toBe(requested && refused === null && kind === 'free');
    }
  });

  it('a reason string is passed through untouched, whoever set it (the selector has no provider input and proves no provider support)', () => {
    for (const provider of ['claude', 'codex', 'glm', 'custom']) expect(selectExposure(input({ refused: `${provider}-unproven` }))).toEqual({ effective: 'classic', reason: `${provider}-unproven` });
  });

  it('unaccounted and unreadable records stay classic across repeated selections: nothing ages into free', () => {
    for (const [kind, record] of RECORDS.filter(([k]) => k === 'unaccounted' || k === 'unreadable')) {
      for (let i = 0; i < 6; i++) expect(selectExposure(input({ record })), `${kind} #${i}`).toMatchObject({ effective: 'classic', reason: 'held-run', held: 'unaccounted' });
    }
  });

  it('rollback: a live holder keeps the launch classic, and replacement returns only when the record view says free', () => {
    const live: ExposureInput['record'] = { kind: 'held-live', methods: ['get_map'] };
    expect(selectExposure(input({ record: live }))).toEqual({ effective: 'classic', reason: 'held-run', held: 'may-be-finishing' });
    expect(selectExposure(input({ record: live }))).toEqual({ effective: 'classic', reason: 'held-run', held: 'may-be-finishing' });
    expect(selectExposure(input({ record: { kind: 'free' } }))).toEqual({ effective: 'replacement', reason: null });
  });
});
