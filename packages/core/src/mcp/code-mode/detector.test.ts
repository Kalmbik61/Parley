// The live detector (plan T12a slice C): three outcomes, config.json as the human's mid-session off, bounded reads, one scan per
// synchronous stretch and the budget. No provider row exists in T12a-core, so these use small fixture classes.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CLEAR, SETTINGS_MAX_BYTES, type SourceClass, configSourceClass, createDetector, readBounded } from './detector.js';

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
let dir: string;
let config: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'parley-t12a-detector-')); roots.push(dir); config = path.join(dir, 'config.json'); });

const ROW: readonly SourceClass[] = [];
const cls = (name: string, check: () => ReturnType<SourceClass['check']>): SourceClass => ({ name, check });

describe('config.json: the human\'s setting as the session process reads it', () => {
  it.each([
    ['missing', null, 'clear'],
    ['on', '{"codeMode":true}', 'clear'],
    ['no key: the default, on', '{"fontSize":14}', 'clear'],
    ['off', '{"codeMode":false}', 'human-off'],
    ['a string false is not off and not on', '{"codeMode":"false"}', 'config-unparsable'],
    ['not JSON', '{', 'config-unparsable'],
    ['an array', '[]', 'config-unparsable'],
    ['empty (a torn write)', '', 'config-unparsable'],
  ])('%s', (_name, text, expected) => {
    if (text !== null) writeFileSync(config, text);
    const v = configSourceClass(config).check();
    expect(v.kind === 'clear' ? 'clear' : v.kind === 'trigger' ? v.reason : v.sourceClass).toBe(expected);
  });
  it('a FIFO at the path: a trigger, and the read does not block', () => {
    execFileSync('mkfifo', [config]);
    expect(configSourceClass(config).check()).toEqual({ kind: 'trigger', reason: 'config-not-a-file' });
  });
  it('a symlink at the path is not followed: a trigger', () => {
    const target = path.join(dir, 'real.json');
    writeFileSync(target, '{"codeMode":true}');
    symlinkSync(target, config);
    expect(configSourceClass(config).check()).toEqual({ kind: 'trigger', reason: 'config-open' });
  });
  it('a directory at the path: a trigger', () => {
    mkdirSync(config);
    expect(configSourceClass(config).check().kind).toBe('trigger');
  });
  it('over 1 MiB: a trigger, not read', () => {
    writeFileSync(config, `{"codeMode":true,"pad":"${'x'.repeat(SETTINGS_MAX_BYTES)}"}`);
    expect(configSourceClass(config).check()).toEqual({ kind: 'trigger', reason: 'config-too-large' });
  });
  it('a benign edit keeps it clear; turning off mid-session is seen at the next check, and on again is clear again (the gate latches, not the class)', () => {
    writeFileSync(config, '{"codeMode":true}');
    const c = configSourceClass(config);
    expect(c.check()).toBe(CLEAR);
    writeFileSync(config, '{"codeMode":true,"fontSize":15}');
    expect(c.check()).toBe(CLEAR);
    writeFileSync(config, '{"codeMode":false,"fontSize":15}');
    expect(c.check()).toEqual({ kind: 'trigger', reason: 'human-off' });
    writeFileSync(config, '{"codeMode":true}');
    expect(c.check()).toBe(CLEAR);
  });
  it('an atomic replacement (rename) is seen: the fingerprint follows the inode', () => {
    writeFileSync(config, '{"codeMode":true}');
    const c = configSourceClass(config);
    expect(c.check()).toBe(CLEAR);
    const temp = path.join(dir, '.config.json.tmp');
    writeFileSync(temp, '{"codeMode":false}');
    execFileSync('mv', [temp, config]);
    expect(c.check()).toEqual({ kind: 'trigger', reason: 'human-off' });
  });
});

describe('readBounded', () => {
  it('absent, text, and the size bound', () => {
    expect(readBounded(path.join(dir, 'none'), 10)).toEqual({ kind: 'absent' });
    writeFileSync(config, 'abc');
    expect(readBounded(config, 10)).toEqual({ kind: 'text', text: 'abc' });
    expect(readBounded(config, 2)).toEqual({ kind: 'unreadable', why: 'too-large' });
  });
});

describe('the scan: three outcomes, never clear by omission', () => {
  it('no provider row: uninspected, never clear', () => {
    expect(createDetector({ classes: null, configFile: config }).scan()).toEqual({ kind: 'uninspected', sourceClass: 'no-provider-row' });
  });
  it('an empty row and config on: clear (the positive control)', () => {
    writeFileSync(config, '{"codeMode":true}');
    expect(createDetector({ classes: ROW, configFile: config }).scan()).toBe(CLEAR);
  });
  it('a class whose reader throws: uninspected with its name', () => {
    const d = createDetector({ classes: [cls('plugin-hooks', () => { throw new Error('no reader'); })], configFile: config });
    expect(d.scan()).toEqual({ kind: 'uninspected', sourceClass: 'plugin-hooks' });
  });
  it('a class that says uninspected stays uninspected; a trigger anywhere wins over it', () => {
    const later = cls('managed', () => ({ kind: 'trigger', reason: 'managed-rule' }));
    expect(createDetector({ classes: [cls('nested', () => ({ kind: 'uninspected', sourceClass: 'nested' }))], configFile: config }).scan()).toEqual({ kind: 'uninspected', sourceClass: 'nested' });
    expect(createDetector({ classes: [cls('nested', () => ({ kind: 'uninspected', sourceClass: 'nested' })), later], configFile: config }).scan()).toEqual({ kind: 'trigger', reason: 'managed-rule' });
  });
  it('the human\'s off wins over everything, even with no row', () => {
    writeFileSync(config, '{"codeMode":false}');
    expect(createDetector({ classes: null, configFile: config }).scan()).toEqual({ kind: 'trigger', reason: 'human-off' });
  });
});

describe('one scan per synchronous stretch, and the budget', () => {
  it('scans in one stretch share one pass; the next turn scans again', async () => {
    let checks = 0;
    const d = createDetector({ classes: [cls('counted', () => { checks++; return CLEAR; })], configFile: config });
    for (let i = 0; i < 6; i++) d.scan();
    expect([checks, d.passes()]).toEqual([1, 1]);
    await Promise.resolve();
    d.scan();
    expect([checks, d.passes()]).toEqual([2, 2]);
  });
  it('a change inside one stretch is not seen until the next turn (the stated residual)', async () => {
    let state: ReturnType<SourceClass['check']> = CLEAR;
    const d = createDetector({ classes: [cls('flip', () => state)], configFile: config });
    expect(d.scan()).toBe(CLEAR);
    state = { kind: 'trigger', reason: 'added' };
    expect(d.scan()).toBe(CLEAR);
    await Promise.resolve();
    expect(d.scan()).toEqual({ kind: 'trigger', reason: 'added' });
  });
  it('a pass over the budget: this pass stands, the next check is a detector failure, and it stays failed', async () => {
    let t = 0;
    const d = createDetector({ classes: [cls('slow', () => { t += 150; return CLEAR; })], configFile: config, budgetMs: 100, now: () => t });
    expect(d.scan()).toBe(CLEAR);
    await Promise.resolve();
    expect(d.scan()).toEqual({ kind: 'trigger', reason: 'over-budget' });
    await Promise.resolve();
    expect(d.scan()).toEqual({ kind: 'trigger', reason: 'over-budget' });
  });
  it('a pass inside the budget does not fail later', async () => {
    let t = 0;
    const d = createDetector({ classes: [cls('fast', () => { t += 99; return CLEAR; })], configFile: config, budgetMs: 100, now: () => t });
    for (let i = 0; i < 3; i++) { expect(d.scan()).toBe(CLEAR); await Promise.resolve(); }
  });
});
