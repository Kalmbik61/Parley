// What a session is running, by Parley's own files (plan T12a, Delta 2): real files, every row of the table, and no throw.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposureRecordPath, writeExposureRecord } from './exposure-record.js';
import { type LaunchDecision, launchDecisionPath, writeLaunchDecision } from './launch-decision.js';
import { CODE_MODE_REASONS, codeModeStateOf } from './mode-state.js';

const roots: string[] = [];
afterAll(() => { for (const d of roots) { try { chmodSync(path.join(d, 'code-mode'), 0o700); } catch { /* none */ } rmSync(d, { recursive: true, force: true }); } });
let workDir: string;
beforeEach(() => { workDir = mkdtempSync(path.join(tmpdir(), 'parley-t12a-state-')); roots.push(workDir); });

const SID = 's-01';
const NONCE = 'a'.repeat(32);
const decide = (over: Partial<LaunchDecision> = {}): void => {
  expect(writeLaunchDecision(workDir, SID, { v: 1, nonce: NONCE, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: '2026-11-09T00:00:00.000Z', ...over })).toBe(true);
};
const record = (over: Record<string, unknown> = {}): void => {
  expect(writeExposureRecord(workDir, SID, { v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: null, launchId: 'l', nonce: NONCE, ...over } as never)).toBe(true);
};
const classic = (reason: string): void => decide({ nonce: null, effective: 'classic', reason });

describe('codeModeStateOf: one source, every row', () => {
  it('no decision: unknown', () => { expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null }); });
  it('replacement confirmed by this launch: code-mode', () => { decide(); record(); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'code-mode', reason: null }); });
  it('replacement, this launch failed: unknown, failed: the process exited, so nothing says what runs', () => {
    decide(); record({ effective: 'failed', reason: 'partition' });
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: 'failed' });
  });
  it('replacement, no record yet: unknown, unconfirmed', () => { decide(); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: 'unconfirmed' }); });
  it('replacement, another launch\'s record, ok or failed: unconfirmed, never code-mode', () => {
    decide({ nonce: 'b'.repeat(32) }); record();
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: 'unconfirmed' });
    record({ effective: 'failed', reason: 'partition' });
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: 'unconfirmed' });
  });
  it.each(Object.keys(CODE_MODE_REASONS).filter((r) => r !== 'failed' && r !== 'unconfirmed'))('classic, %s: classic with that reason', (reason) => {
    classic(reason);
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'classic', reason });
  });
  it('classic, uninspected-source with its class: the class-free reason', () => {
    classic('uninspected-source:codex-plugin-hooks');
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'classic', reason: 'uninspected-source' });
  });
  it.each([['a reason no one listed', 'something-new'], ['free text', 'The client said no.'], ['no reason at all', null], ['an inherited key', 'toString'], ['another inherited key', 'constructor'], ['the prefix alone', 'uninspected-source:']] as const)('classic with %s: unknown, never raw text', (_n, reason) => {
    classic(reason as never);
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null });
  });
  it('classic ignores a stale exposure record beside it', () => { classic('not-requested'); record(); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'classic', reason: 'not-requested' }); });
});

describe('a read problem is unknown, and never throws', () => {
  const plant = (text: string): void => { mkdirSync(path.join(workDir, 'code-mode'), { recursive: true, mode: 0o700 }); writeFileSync(launchDecisionPath(workDir, SID), text, { mode: 0o600 }); };
  it.each(['{"v":1', '', '[]', 'null'])('torn or not ours %j', (text) => { plant(text); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null }); });
  it('not understood (effective unknown to this build): unknown', () => { plant(JSON.stringify({ v: 1, nonce: NONCE, effective: 'alongside', requested: true, reason: null, provider: 'claude', at: 't' })); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null }); });
  it('a FIFO at the path: no hang, unknown', () => { mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 }); execFileSync('mkfifo', [launchDecisionPath(workDir, SID)]); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null }); });
  it('a symlink at the path: unknown', () => {
    const target = path.join(workDir, 'elsewhere.json');
    writeFileSync(target, JSON.stringify({ v: 1, nonce: null, effective: 'classic', requested: true, reason: 'not-requested', provider: 'claude', at: 't' }));
    mkdirSync(path.join(workDir, 'code-mode'), { mode: 0o700 });
    symlinkSync(target, launchDecisionPath(workDir, SID));
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null });
  });
  it('a loose directory: unknown', () => { classic('not-requested'); chmodSync(path.join(workDir, 'code-mode'), 0o755); expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null }); });
  it('an exposure record that cannot be read beside a replacement decision: unconfirmed, not code-mode', () => {
    decide(); mkdirSync(exposureRecordPath(workDir, SID), { recursive: true });
    expect(codeModeStateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: 'unconfirmed' });
  });
  it('bad inputs: unknown', () => {
    for (const [dir, sid] of [['', SID], [workDir, '../x'], [workDir, ''], [path.join(workDir, 'missing'), SID]] as const) expect(codeModeStateOf(dir, sid), `${dir} ${sid}`).toEqual({ mode: 'unknown', reason: null });
  });
});

describe('the closed list', () => {
  it('every reason is one short English sentence, with no free text slot and no code word', () => {
    for (const [key, text] of Object.entries(CODE_MODE_REASONS)) {
      expect(key, key).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(text, key).toMatch(/^[A-Z][^\n]{10,110}\.$/);
      expect(text, key).not.toMatch(/[А-Яа-яЁё]|code_execute|code_search|parley\.|\$\{|<|>/);
    }
  });
  it('frozen', () => { expect(Object.isFrozen(CODE_MODE_REASONS)).toBe(true); });
  it('exactly these keys: one per gate of T12a §5, plus held-run, not-requested, decision-write-failed, failed, unconfirmed', () => {
    expect(Object.keys(CODE_MODE_REASONS)).toEqual([
      'confined-attempt', 'not-parley-launched', 'provider-unproven', 'client-version', 'instructions-undeliverable', 'helper-unavailable',
      'registry', 'detector', 'uninspected-source', 'role', 'playbook', 'skills', 'held-run', 'not-requested', 'decision-write-failed', 'failed', 'unconfirmed',
    ]);
  });
  it('the reader writes nothing and imports nothing that decides or grants', () => {
    const src = readFileSync(fileURLToPath(new URL('./mode-state.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/\b(writeFileSync|writeLaunchDecision|writeExposureRecord|writeRecordFile|unlinkSync|rmSync|selectExposure|honouredExposure)\b/);
    expect([...src.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1]).sort()).toEqual(['./exposure-record.js', './launch-decision.js']);
  });
});

describe('a reader that throws underneath', () => {
  it('unknown, and no throw reaches the caller', async () => {
    vi.resetModules();
    vi.doMock('./launch-decision.js', async (orig) => ({ ...(await orig<typeof import('./launch-decision.js')>()), readLaunchDecision: () => { throw new Error('disk'); } }));
    try {
      const { codeModeStateOf: stateOf } = await import('./mode-state.js');
      expect(stateOf(workDir, SID)).toEqual({ mode: 'unknown', reason: null });
    } finally { vi.doUnmock('./launch-decision.js'); vi.resetModules(); }
  });
});
