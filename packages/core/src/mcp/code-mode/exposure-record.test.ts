// The exposure record (plan T7b, lead m-6221): where it may land, and that a missing one means unknown.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixed = vi.hoisted(() => ({ bytes: null as string | null }));
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof import('node:crypto')>();
  return { ...real, randomBytes: (n: number) => (fixed.bytes === null ? real.randomBytes(n) : Buffer.from(fixed.bytes, 'hex')) };
});

const { exposureRecordPath, readExposureRecord, writeExposureRecord } = await import('./exposure-record.js');

const roots: string[] = [];
const newRoot = (): string => { const d = mkdtempSync(path.join(tmpdir(), 'parley-t7b-record-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) { try { chmodSync(path.join(d, 'code-mode'), 0o700); } catch { /* none */ } rmSync(d, { recursive: true, force: true }); } });

const RECORD = { v: 1 as const, effective: 'replacement' as const, reason: null, migrated: [], residual: ['report'], registryRevision: 'r', residualSchemaSha256: 'h', launchId: 'l', nonce: 'a'.repeat(32) };
let workDir: string;
beforeEach(() => { workDir = newRoot(); fixed.bytes = null; });

describe('the launch it belongs to', () => {
  it.each([[undefined], [7], [{}]])('a nonce field of %j: not one of ours, unknown', (nonce) => {
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    writeFileSync(exposureRecordPath(workDir, 's-1'), JSON.stringify({ ...RECORD, nonce }));
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'unknown' });
  });
  it('a null nonce is a record, and it matches no launch', () => {
    writeExposureRecord(workDir, 's-1', { ...RECORD, nonce: null });
    expect(readExposureRecord(workDir, 's-1')).toMatchObject({ kind: 'record', record: { nonce: null } });
  });
});

describe('writing', () => {
  it('whole, 0600 in a 0700 directory, and no temp left', () => {
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(true);
    const file = exposureRecordPath(workDir, 's-1');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.dirname(file))).toEqual(['s-1.exposure.json']);
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'record', record: RECORD });
  });
  it('a later write replaces it', () => {
    writeExposureRecord(workDir, 's-1', RECORD);
    writeExposureRecord(workDir, 's-1', { ...RECORD, effective: 'failed', reason: 'partition' });
    expect(readExposureRecord(workDir, 's-1')).toMatchObject({ kind: 'record', record: { effective: 'failed', reason: 'partition' } });
  });
  it.each(['../x', '..', 'a/b', 'S-1', '', 'a.b', 's-1/../../x'])('session id %j: refused, nothing written anywhere', (sessionId) => {
    expect(writeExposureRecord(workDir, sessionId, RECORD)).toBe(false);
    expect(readdirSync(workDir)).toEqual([]);
    expect(readExposureRecord(workDir, sessionId)).toEqual({ kind: 'unknown' });
  });
  it('a symlink at the path is replaced, and its target is untouched', () => {
    const target = path.join(workDir, 'target');
    writeFileSync(target, 'mine');
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    symlinkSync(target, exposureRecordPath(workDir, 's-1'));
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('mine');
    expect(lstatSync(exposureRecordPath(workDir, 's-1')).isSymbolicLink()).toBe(false);
  });
  it('a symlinked code-mode directory is refused: nothing lands in its target (s-290)', () => {
    const elsewhere = path.join(workDir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(workDir, 'code-mode'));
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  it.each([0o755, 0o750, 0o705, 0o770])('an existing code-mode directory with mode %o is refused and left as it is, nothing written', (mode) => {
    const dir = path.join(workDir, 'code-mode');
    mkdirSync(dir);
    chmodSync(dir, mode);
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(statSync(dir).mode & 0o777).toBe(mode);
  });
  it('an existing 0700 directory is fine', () => {
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(true);
  });
  it('a colliding temp name fails cleanly: exclusive, and the file already there is not touched or removed', () => {
    fixed.bytes = 'aa'.repeat(8);
    const temp = path.join(workDir, 'code-mode', `.s-1.exposure.${'aa'.repeat(8)}.tmp`);
    mkdirSync(path.dirname(temp), { mode: 0o700 });
    writeFileSync(temp, 'other');
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(false);
    expect(readFileSync(temp, 'utf8')).toBe('other');
    expect(existsSync(exposureRecordPath(workDir, 's-1'))).toBe(false);
  });
  it('a failed rename removes its temp', () => {
    const file = exposureRecordPath(workDir, 's-1');
    // A non-empty directory at the path: the rename itself is what fails, in a directory that passes the rules.
    mkdirSync(path.dirname(file), { mode: 0o700 });
    mkdirSync(file);
    writeFileSync(path.join(file, 'x'), '');
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(false);
    expect(readdirSync(path.dirname(file))).toEqual(['s-1.exposure.json']);
  });
  it('a directory that cannot be written: false, no throw', () => {
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o500 });
    expect(writeExposureRecord(workDir, 's-1', RECORD)).toBe(false);
  });
});

describe('reading: unknown, never classic', () => {
  it('no record is unknown', () => {
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'unknown' });
  });
  it.each([
    ['not JSON', 'x'],
    ['another version', JSON.stringify({ ...RECORD, v: 2 })],
    ['another state, classic included', JSON.stringify({ ...RECORD, effective: 'classic' })],
    ['no lists', JSON.stringify({ v: 1, effective: 'failed', registryRevision: 'r' })],
    ['oversized, though valid', `${' '.repeat(70 * 1024)}${JSON.stringify(RECORD)}`],
  ])('%s is unknown', (_name, text) => {
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    writeFileSync(exposureRecordPath(workDir, 's-1'), text);
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'unknown' });
  });
  it('a symlinked code-mode directory reads as unknown, even with a good record behind it (s-290)', () => {
    const elsewhere = path.join(workDir, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(path.join(elsewhere, 's-1.exposure.json'), JSON.stringify(RECORD));
    symlinkSync(elsewhere, path.join(workDir, 'code-mode'));
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'unknown' });
  });
  it('a record in a looser directory reads as unknown: anyone could have put it there', () => {
    writeExposureRecord(workDir, 's-1', RECORD);
    expect(readExposureRecord(workDir, 's-1').kind).toBe('record');
    chmodSync(path.join(workDir, 'code-mode'), 0o755);
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'unknown' });
  });
  it('a symlink is not followed', () => {
    const elsewhere = path.join(workDir, 'r.json');
    writeFileSync(elsewhere, JSON.stringify(RECORD));
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    symlinkSync(elsewhere, exposureRecordPath(workDir, 's-1'));
    expect(readExposureRecord(workDir, 's-1')).toEqual({ kind: 'unknown' });
  });
});
