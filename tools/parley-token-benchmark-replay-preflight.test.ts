// T9a harness, slice H4a: every refusal of the preflight is named, and a run with nothing wrong has none.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Facts, collectFacts, distFact, preflightProblems, readBuilds } from './parley-token-benchmark-replay-preflight.js';

const TEXT = '{"version":1,"goals":[]}';
const SHA = createHash('sha256').update(TEXT).digest('hex');
const REPO = '/repo';
const dist = (name: 'core' | 'protocol', over: Partial<Facts['dists'][number]> = {}): Facts['dists'][number] => ({ name, dir: `${REPO}/packages/${name}/dist`, exists: true, newestBuiltMs: 2000, newestSourceMs: 1000, buildCommand: `pnpm --filter @parley/${name} build`, ...over });
const good = (over: Partial<Facts> = {}): Facts => ({
  goalsPath: '/goals.json', goalsText: TEXT, expectedGoalsSha: SHA, goalsSchemaIssues: [], platform: 'darwin', sandboxExec: true, loopback: true,
  nativeProbe: { path: `${REPO}/packages/core/native/darwin-arm64/procinfo-probe`, exists: true, sha256: 'ab' }, probeVerdict: { ok: true, reason: null }, builds: { stamp: '/stamp.json', protocol: 0, core: 0 }, dists: [dist('protocol'), dist('core')],
  sdk: { root: `${REPO}/packages/core/node_modules/@modelcontextprotocol/sdk`, version: '1.30.0' }, repo: REPO, handlerProbeStarted: true, retry: 0, treeClean: true, treeHash: 'abc', node: 'v22', load: [0, 0, 0], ...over,
});

describe('preflightProblems: nothing wrong, nothing said; every fault named', () => {
  it('a clean machine has no problem', () => { expect(preflightProblems(good())).toEqual([]); });
  const cases: [string, Partial<Facts>, RegExp][] = [
    ['the goals variable unset', { goalsPath: undefined, goalsText: null }, /PARLEY_REPLAY_GOALS is not set/],
    ['the goals variable empty', { goalsPath: '' , goalsText: null }, /PARLEY_REPLAY_GOALS is not set/],
    ['the goals file unreadable', { goalsText: null }, /cannot be read/],
    ['another goals file', { goalsText: `${TEXT} ` }, /the frozen one is/],
    ['a goals schema issue', { goalsSchemaIssues: ['$.goals[0].id: duplicate'] }, /goals file: \$\.goals\[0\]\.id: duplicate/],
    ['not macOS', { platform: 'linux' }, /needs macOS/],
    ['no sandbox-exec', { sandboxExec: false }, /sandbox-exec is missing/],
    ['no loopback', { loopback: false }, /loopback port/],
    ['no native probe', { nativeProbe: { path: '/p', exists: false, sha256: null } }, /native probe \/p is missing/],
    ['a probe the product refuses', { probeVerdict: { ok: false, reason: 'native probe built from another source' } }, /the product refuses the native probe .*built from another source/],
    ['no probe verdict', { probeVerdict: null }, /probe check did not run/],
    ['no build stamp', { builds: { stamp: null, protocol: null, core: null } }, /no build stamp/],
    ['a protocol build that failed', { builds: { stamp: '/s', protocol: 2, core: 0 } }, /protocol build exited with 2/],
    ['a core build that failed', { builds: { stamp: '/s', protocol: 0, core: 1 } }, /core build exited with 1/],
    ['a stamp with no code for core', { builds: { stamp: '/s', protocol: 0, core: null } }, /no exit code for core/],
    ['no core dist', { dists: [dist('protocol'), dist('core', { exists: false })] }, /core dist .*missing: run pnpm --filter @parley\/core build/],
    ['no protocol dist', { dists: [dist('protocol', { exists: false }), dist('core')] }, /protocol dist .*missing/],
    ['a stale core dist', { dists: [dist('protocol'), dist('core', { newestBuiltMs: 900 })] }, /core dist .* older than its sources/],
    ['a dist with no readable time', { dists: [dist('protocol'), dist('core', { newestBuiltMs: null })] }, /cannot be read/],
    ['no SDK', { sdk: null }, /SDK cannot be resolved/],
    ['an SDK outside the repository', { sdk: { root: '/home/node_modules/@modelcontextprotocol/sdk', version: '1' } }, /outside the repository/],
    ['no handler probe control', { handlerProbeStarted: null }, /control did not run/],
    ['a handler probe that never reports a start', { handlerProbeStarted: false }, /reported no handler start/],
    ['retry 1', { retry: 1 }, /retry is 1, it must be 0/],
    ['retry unset', { retry: undefined }, /retry is undefined/],
    ['a dirty tree', { treeClean: false }, /not clean/],
    ['no tree hash', { treeHash: null }, /tree hash cannot be read/],
  ];
  it.each(cases)('%s', (_name, over, message) => {
    const found = preflightProblems(good(over));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(message);
  });
  it('several faults are all reported, none hides another', () => {
    expect(preflightProblems(good({ platform: 'linux', retry: 2, treeClean: false })).length).toBe(3);
  });
});

describe('distFact and collectFacts read the machine', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'parley-replay-preflight-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const put = (file: string, mtimeSec: number): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'x'); utimesSync(file, mtimeSec, mtimeSec); };

  it('a dist is stale when a non-test source is newer than anything it emitted; tests and declaration files do not count', () => {
    put(path.join(root, 'packages/core/src/a.ts'), 1000);
    put(path.join(root, 'packages/core/src/a.test.ts'), 9000);
    put(path.join(root, 'packages/core/src/a.d.ts'), 9000);
    put(path.join(root, 'packages/core/dist/a.js'), 2000);
    const fresh = distFact(root, 'core');
    expect(fresh.exists).toBe(true);
    expect(fresh.newestBuiltMs).toBe(2_000_000);
    expect(fresh.newestSourceMs).toBe(1_000_000);
    put(path.join(root, 'packages/core/src/b.ts'), 3000);
    expect(distFact(root, 'core').newestSourceMs).toBe(3_000_000);
    expect(preflightProblems(good({ dists: [dist('protocol'), distFact(root, 'core')] })).join('\n')).toMatch(/older than its sources/);
  });
  it('a missing dist is reported as missing', () => {
    expect(distFact(root, 'protocol')).toMatchObject({ exists: false, newestBuiltMs: null });
  });
  it('collectFacts: the goals file hash, the schema check, the probe control and retry come through; an unresolvable SDK is null', async () => {
    const goals = path.join(root, 'goals.json');
    writeFileSync(goals, TEXT);
    const stamp = path.join(root, 'build.json');
    writeFileSync(stamp, JSON.stringify({ protocol: 0, core: 3 }));
    const f = await collectFacts({ buildStamp: stamp, repo: root, goalsPath: goals, expectedGoalsSha: SHA, goalsSchemaIssues: (t) => (t === TEXT ? ['an issue'] : []), sdk: async () => { throw new Error('no'); }, retry: 0, handlerProbeControl: async () => true });
    expect(f.goalsText).toBe(TEXT);
    expect(f.goalsSchemaIssues).toEqual(['an issue']);
    expect(f.sdk).toBeNull();
    expect(f.handlerProbeStarted).toBe(true);
    expect(f.retry).toBe(0);
    expect(f.loopback).toBe(true);
    expect(f.treeHash).toBeNull();
    expect(f.treeClean).toBe(false);
    expect(f.nativeProbe.exists).toBe(false);
    expect(f.probeVerdict).toBeNull();
    expect(f.builds).toEqual({ stamp, protocol: 0, core: 3 });
    const none = await collectFacts({ repo: root, goalsPath: undefined, expectedGoalsSha: SHA, goalsSchemaIssues: () => ['never'], sdk: async () => ({ root: '/r', version: '1' }), retry: undefined, handlerProbeControl: async () => null });
    expect(none.goalsText).toBeNull();
    expect(none.goalsSchemaIssues).toEqual([]);
    expect(none.sdk).toEqual({ root: '/r', version: '1' });
  });
});

describe('readBuilds: the stamp the gate script writes', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'parley-replay-stamp-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it('exit codes come through; anything else is null, and a missing or torn stamp is no stamp or no code', () => {
    const f = path.join(dir, 's.json');
    expect(readBuilds(undefined)).toEqual({ stamp: null, protocol: null, core: null });
    expect(readBuilds('')).toEqual({ stamp: null, protocol: null, core: null });
    expect(readBuilds(f)).toEqual({ stamp: null, protocol: null, core: null });
    writeFileSync(f, JSON.stringify({ protocol: 0, core: 0 }));
    expect(readBuilds(f)).toEqual({ stamp: f, protocol: 0, core: 0 });
    writeFileSync(f, JSON.stringify({ protocol: '0', core: 1.5 }));
    expect(readBuilds(f)).toEqual({ stamp: f, protocol: null, core: null });
    writeFileSync(f, '{"protocol":');
    expect(readBuilds(f)).toEqual({ stamp: f, protocol: null, core: null });
  });
});
