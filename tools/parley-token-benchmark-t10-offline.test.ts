import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPO, FROZEN_GOALS_SHA, FROZEN_SCRIPTS_SHA, HEADER, NATIVE_FIELDS, PINNED_LABEL, REASONS, REAL_DEPS, buildOffline, main, readScripts, readT9aReport, renderMarkdown, requestView, type CliDeps, type OfflineInput,
} from './parley-token-benchmark-t10-offline.js';

const sha = (t: string): string => createHash('sha256').update(t).digest('hex');

// one genuine goal of the frozen r2 file (read-session-detail), so the real schema check runs; the sha is the fixture's own
const goal = (id: string, arms: string[]) => ({
  id, class: 'read-dto', kind: 'run', goal: 'Read Amber peer detail.', arms,
  data: {
    self: 'caller',
    sessions: [
      { key: 'caller', label: 'Synthetic caller', provider: 'codex', lifecycle: 'active', task: 'Inspect synthetic records', summary: 'CALLER-SUMMARY' },
      { key: 'peer', label: 'Amber peer', provider: 'claude', lifecycle: 'active', task: 'Review amber', summary: 'AMBER-SUMMARY' },
    ],
    rooms: [{ key: 'amber', title: 'Amber room', lead: 'caller', members: ['caller', 'peer'], messages: [{ from: 'peer', kind: 'note', text: 'AMBER-FIRST' }] }],
    backlog: [{ kind: 'bug', title: 'Amber boundary', why: 'Preserve amber', details: 'AMBER-DETAIL' }],
  },
  criteria: [{ answer: { path: 'detail.label', equals: 'Amber peer' } }],
  answer: { detail: 'The selected peer detail.' },
});
const goalsText = JSON.stringify({ version: 1, goals: [goal('read-a', ['classic', 'replacement']), goal('read-b', ['classic', 'replacement'])] });
const GOALS_SHA = sha(goalsText);
const scriptsText = JSON.stringify({
  version: 1,
  scripts: [
    { goal: 'read-a', classic: { calls: [{ name: 'get_map', args: {} }, { name: 'read_room', args: { room: 'r-01' } }], extract: {} }, replacement: { code: 'return await parley.get_map({});', extract: {} } },
    { goal: 'read-b', replacement: { code: 'return 1;', second: 'return 2;', extract: {} } },
  ],
});
const SCRIPTS_SHA = sha(scriptsText);

const list = (total: number) => ({ exposure: 'classic', originalTools: 41, residualTools: 41, wrapperTools: 0, residualBytes: total, wrappersBytes: 0, totalBytes: total, residualTokens: 900, wrappersTokens: 0, tokenizer: PINNED_LABEL, registryRevision: null });
const arm = (total: number, received: number, names: string[] = ['get_map']) => ({ list: list(total), residualNames: names, calls: { direct: 2, wrapper: 0, nested: 0 }, context: { bytes: received, tokens: 77 } });
/** The same arm with the harness's per-message list: handshake 100, list 900, then the call results; the sum is the received total. */
const armPM = (total: number, calls: number[], names: string[] = ['get_map']) => {
  const pm = [{ id: 0, kind: 'handshake', bytes: 100 }, { id: 1, kind: 'tools/list', bytes: 900 }, ...calls.map((b, i) => ({ id: i + 2, kind: `tools/call ${i === 0 ? 'get_map' : 'read_room'}`, bytes: b }))];
  return { ...arm(total, pm.reduce((n, m) => n + m.bytes, 0), names), perMessage: pm };
};
const report = (over: Record<string, unknown> = {}) => ({
  passed: true, failed: 0, skips: { classic: 0, replacement: 0 }, goalsSha: GOALS_SHA, goalsShaOk: true, scriptsSha: SCRIPTS_SHA, scriptsShaOk: true,
  treeHash: 'tree-1', buildStamp: '{"protocol":0,"core":0,"run":"1"}', tokenizer: PINNED_LABEL,
  accounting: { 'read-a': { classic: arm(19000, 4000), replacement: arm(5000, 1200) }, 'read-b': { replacement: arm(5000, 900) } },
  ...over,
});
const counter = { count: (t: string) => Math.ceil(t.length / 4) };
const input = (over: Partial<OfflineInput> = {}): OfflineInput => ({
  goalsText, expectedGoalsSha: GOALS_SHA, scriptsText, expectedScriptsSha: SCRIPTS_SHA, t9aReport: report(), counter,
  bootstrap: { text: 'x'.repeat(656), treeHash: 'tree-1', clean: true, buildStamp: report().buildStamp, source: 'packages/core/src/work/code-mode-instructions.ts bootstrapText(replacementRouting())' },
  finalSurface: null, ...over,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks a parsed JSON report by key
const out = (o: Partial<OfflineInput> = {}) => buildOffline(input(o)) as Record<string, any>;

describe('the gate on the T9a report', () => {
  const expected = { goalsSha: GOALS_SHA, scriptsSha: SCRIPTS_SHA };
  it('accepts a passed report on the frozen files', () => { expect(readT9aReport(report(), expected).ok).toBe(true); });
  it.each([
    ['not passed', { passed: false }, 't9a-not-passed'],
    ['a failed goal', { failed: 1 }, 't9a-not-passed'],
    ['a skip on an arm', { skips: { classic: 0, replacement: 1 } }, 't9a-not-passed'],
    ['another goals file', { goalsSha: 'f'.repeat(64) }, 'sha-mismatch'],
    ['another scripts file', { scriptsSha: 'f'.repeat(64) }, 'sha-mismatch'],
    ['goalsShaOk false', { goalsShaOk: false }, 'sha-mismatch'],
    ['no tree hash', { treeHash: '' }, 'report-shape'],
    ['no accounting', { accounting: null }, 'report-shape'],
    ['a count that is a string', { accounting: { 'read-a': { classic: { ...arm(1, 1), context: { bytes: '9', tokens: 1 } } } } }, 'report-shape'],
    ['an unknown arm', { accounting: { 'read-a': { navigator: arm(1, 1) } } }, 'report-shape'],
  ])('refuses %s', (_n, over, reason) => {
    const r = readT9aReport(report(over), expected);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => x.reason)).toContain(reason);
  });
  it('refuses a report when the frozen scripts sha is not set', () => {
    const r = readT9aReport(report(), { goalsSha: GOALS_SHA, scriptsSha: '' });
    expect(r.ok === false && r.refusals.map((x) => x.reason)).toContain('scripts-not-frozen');
  });
  it('refuses what is not an object', () => { expect(readT9aReport('x', expected).ok).toBe(false); });
});

describe('request bytes from the scripts file', () => {
  const s = readScripts(JSON.parse(scriptsText));
  it('reads the scripts', () => { expect(s.ok).toBe(true); });
  it('classic: each call as { name, arguments }', () => {
    if (!s.ok) throw new Error('scripts');
    const v = requestView('classic', s.byGoal.get('read-a')!, counter)!;
    const texts = [JSON.stringify({ name: 'get_map', arguments: {} }), JSON.stringify({ name: 'read_room', arguments: { room: 'r-01' } })];
    expect(v.requests).toBe(2);
    expect(v.bytes).toBe(texts.reduce((n, t) => n + Buffer.byteLength(t), 0));
    expect(v.excludes).toEqual([]);
  });
  it('replacement: the search, the code and a second script; the apiRevision value is declared as excluded', () => {
    if (!s.ok) throw new Error('scripts');
    const v = requestView('replacement', s.byGoal.get('read-b')!, null)!;
    expect(v.requests).toBe(3);
    expect(v.excludes[0]).toMatch(/apiRevision/);
    expect(v.tokens.status).toBe('not-measured');
  });
  it('an arm the script does not have is null, not zero', () => {
    if (!s.ok) throw new Error('scripts');
    expect(requestView('classic', s.byGoal.get('read-b')!, null)).toBeNull();
  });
  it.each([[null], [{ version: 2, scripts: [] }], [{ version: 1, scripts: [{ goal: 'a', classic: { calls: [{ name: 1 }] } }] }], [{ version: 1, scripts: [{ goal: 'a' }, { goal: 'a' }] }]])('refuses a malformed scripts file %#', (raw) => {
    expect(readScripts(raw).ok).toBe(false);
  });
});

describe('the offline report', () => {
  it('carries the carried numbers side by side, with a signed difference and no verdict', () => {
    const r = out();
    expect(r['sideBySide']['read-a']['declarationBytes']).toMatchObject({ classic: 19000, replacement: 5000, replacementMinusClassic: -14000 });
    expect(r['sideBySide']['read-a']['receivedBytes']).toMatchObject({ classic: 4000, replacement: 1200, replacementMinusClassic: -2800 });
    expect(Object.keys(r['sideBySide'])).toEqual(['read-a']); // read-b has no classic accounting in the report: no pair
    expect(r['coverage']).toMatchObject({ runGoals: 2, runGoalsBothArms: 2 });
  });
  it('labels a declaration size as a static ceiling and received bytes as excluding the conservation phase', () => {
    const r = out();
    expect(r['perGoal']['read-a']['classic']['declarations']['label']).toMatch(/not a request cost/);
    expect(r['perGoal']['read-a']['classic']['receivedLabel']).toMatch(/before the conservation phase, so that phase is excluded/);
  });
  it('per-call result bytes are harness-does-not-expose, and that keeps the report incomplete', () => {
    const r = out();
    expect(r['perGoal']['read-a']['classic']['perCallResultBytes']).toMatchObject({ status: 'not-measured', reason: 'harness-does-not-expose' });
    expect(r['incomplete']).toBe(true);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks a parsed JSON report by key
    expect(r['coverage']['gaps'].some((g: any) => g.metric === 'perCallResultBytes')).toBe(true);
  });
  it('every native field is present, not measured, needs-paid-run', () => {
    const r = out();
    expect(Object.keys(r['native']).sort()).toEqual([...NATIVE_FIELDS].sort());
    for (const f of NATIVE_FIELDS) expect(r['native'][f]).toMatchObject({ status: 'not-measured', reason: 'needs-paid-run' });
  });
  it('has no percent, saving, ratio or money field anywhere', () => {
    const keys: string[] = [];
    const walk = (v: unknown): void => { if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); } };
    walk(out());
    expect(keys.filter((k) => /^(percent|pct|saving|ratio|price|usd|dollar|cost)/i.test(k))).toEqual([]);
    expect(out()['native']['monetaryCost'].status).toBe('not-measured');
    expect(HEADER).toMatch(/No percent, no savings/);
  });
  it('the surface is interim until T13 declares it, and a mismatch is named', () => {
    expect(out()['surface']).toMatchObject({ measured: 'interim', declaredFinal: false, reason: 'final-surface-not-declared' });
    const off = out({ finalSurface: { residuals: ['report'], sha256: 'a'.repeat(64) } });
    expect(off['surface']).toMatchObject({ measured: 'interim', reason: 'final-surface-mismatch' });
    const on = out({ finalSurface: { residuals: ['get_map'], sha256: 'a'.repeat(64) } });
    expect(on['surface']).toMatchObject({ measured: 'declared-final', declaredFinal: true });
  });
  it('without a T9a report nothing from it is carried', () => {
    const r = out({ t9aReport: null });
    expect(r['inputs']['t9aNotAccepted'][0].reason).toBe('no-t9a-report');
    expect(r['perGoal']['read-a']['classic']['declarations']).toMatchObject({ status: 'not-measured', reason: 'no-t9a-report' });
    expect(r['sideBySide']).toEqual({});
    expect(r['incomplete']).toBe(true);
  });
  it('a refused T9a report carries no number', () => {
    const r = out({ t9aReport: report({ passed: false }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks a parsed JSON report by key
    expect(r['inputs']['t9aNotAccepted'].map((x: any) => x.reason)).toContain('t9a-not-passed');
    expect(r['sideBySide']).toEqual({});
  });
  it('a T9a report counted in bytes carries no token', () => {
    const r = out({ t9aReport: report({ tokenizer: 'utf8 bytes (no tokenizer directory given: these are NOT tokens)' }) });
    expect(r['perGoal']['read-a']['classic']['declarations']['tokens']).toMatchObject({ status: 'not-measured', reason: 'no-pinned-tokenizer' });
    expect(r['perGoal']['read-a']['classic']['receivedTokens']).toMatchObject({ status: 'not-measured', reason: 'no-pinned-tokenizer' });
    expect(r['perGoal']['read-a']['classic']['declarations']['bytes']).toBe(19000);
  });
  it('no counter: own token counts are not measured, bytes still are', () => {
    const r = out({ counter: null });
    expect(r['perGoal']['read-a']['classic']['requests']['tokens']).toMatchObject({ status: 'not-measured', reason: 'no-pinned-tokenizer' });
    expect(r['perGoal']['read-a']['classic']['requests']['bytes']).toBeGreaterThan(0);
    expect(r['bootstrap']['tokens']).toMatchObject({ status: 'not-measured', reason: 'no-pinned-tokenizer' });
    expect(r['inputs']['tokenizer']).toBeNull();
  });
  it('scripts not frozen: requests are not measured with that reason', () => {
    const r = out({ expectedScriptsSha: '', t9aReport: report() });
    expect(r['perGoal']['read-a']['classic']['requests']).toMatchObject({ status: 'not-measured', reason: 'scripts-not-frozen' });
  });
  it('a foreign goals file refuses the whole report', () => {
    const r = out({ expectedGoalsSha: 'f'.repeat(64) });
    expect(r['refused']).toBe(true);
    expect(r['refusals'][0].reason).toBe('sha-mismatch');
    expect(r['coverage']['runGoals']).toBe(0);
  });
  it('a foreign scripts file refuses the whole report', () => {
    const r = out({ scriptsText: scriptsText + ' ' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks a parsed JSON report by key
    expect(r['refusals'].map((x: any) => x.reason)).toContain('sha-mismatch');
  });
  it('every reason in the output comes from the closed list', () => {
    const reasons = new Set<string>();
    const walk = (v: unknown): void => { if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'reason' && typeof x === 'string') reasons.add(x); walk(x); } };
    for (const o of [out(), out({ t9aReport: null, counter: null, scriptsText: null }), out({ expectedGoalsSha: 'f'.repeat(64) })]) walk(o);
    for (const r of reasons) expect(REASONS as readonly string[]).toContain(r);
  });
  it('is deterministic: the same inputs give the same bytes', () => { expect(JSON.stringify(out())).toBe(JSON.stringify(out())); });
});

describe('C1: the bootstrap must come from the report tree', () => {
  it('measured when the tree hash is the report\'s and the checkout is clean', () => {
    const b = out()['bootstrap'];
    expect(b).toMatchObject({ status: 'measured', bytes: 656, treeHash: 'tree-1' });
    expect(b['authorAttributed']).toMatchObject({ bytes: 656, bytesEqual: true });
    expect(b['tokens']).toMatchObject({ status: 'measured' });
  });
  it('refused with sha-mismatch for another tree', () => {
    expect(out({ bootstrap: { text: 'x', treeHash: 'tree-2', clean: true, buildStamp: report().buildStamp, source: 's' } })['bootstrap']).toMatchObject({ status: 'not-measured', reason: 'sha-mismatch' });
  });
  it('refused with sha-mismatch for a dirty checkout', () => {
    expect(out({ bootstrap: { text: 'x', treeHash: 'tree-1', clean: false, buildStamp: report().buildStamp, source: 's' } })['bootstrap']).toMatchObject({ status: 'not-measured', reason: 'sha-mismatch' });
  });
  it('refused without an accepted report', () => {
    expect(out({ t9aReport: null })['bootstrap']).toMatchObject({ status: 'not-measured', reason: 'no-t9a-report' });
  });
  it('no stamp file is data, not a refusal', () => {
    const b = out({ bootstrap: { text: 'x', treeHash: 'tree-1', clean: true, buildStamp: null, source: 's' } })['bootstrap'];
    expect(b).toMatchObject({ status: 'measured' });
    expect(b['stampFile']).toMatch(/not given/);
  });
  it('a stamp file equal to the report stamp is recorded as equal', () => { expect(out()['bootstrap']['stampFile']).toBe('equals the report stamp'); });
  it('refused with sha-mismatch when the build stamp is another run\'s', () => {
    const b = out({ bootstrap: { text: 'x', treeHash: 'tree-1', clean: true, buildStamp: '{"protocol":0,"core":0,"run":"2"}', source: 's' } })['bootstrap'];
    expect(b).toMatchObject({ status: 'not-measured', reason: 'sha-mismatch' });
    expect(b['detail']).toMatch(/not the same run/);
  });
  it('not given is its own reason', () => {
    expect(out({ bootstrap: null })['bootstrap']).toMatchObject({ status: 'not-measured', reason: 'bootstrap-not-given' });
  });
});

describe('the markdown rendering', () => {
  it('shows the labels, the surface and the not-measured list, and no number the JSON lacks', () => {
    const md = renderMarkdown(out());
    expect(md).toMatch(/static declaration size/);
    expect(md).toMatch(/Surface measured: \*\*interim\*\*/);
    expect(md).toMatch(/\| read-a \| 19000 \| 5000 \| 4000 \| 1200 \|/);
    for (const f of NATIVE_FIELDS) expect(md).toContain(`- ${f}`);
    expect(md).not.toMatch(/%/);
  });
  it('names a refusal', () => { expect(renderMarkdown(out({ expectedGoalsSha: 'f'.repeat(64) }))).toMatch(/## Refused/); });
});

describe('the command', () => {
  const files = (over: Record<string, string> = {}): { deps: CliDeps; written: Record<string, string>; seen: string[] } => {
    const written: Record<string, string> = {};
    const seen: string[] = [];
    const disk: Record<string, string> = { 'goals.json': goalsText, 'r.json': JSON.stringify(report()), ...over };
    return {
      written, seen,
      deps: {
        tree: (repo) => { seen.push(`tree:${repo}`); return { treeHash: 'tree-1', clean: true }; },
        bootstrap: async (repo) => { seen.push(`bootstrap:${repo}`); return 'b'.repeat(656); }, tokenizer: async () => counter,
        read: (f) => { if (disk[f] === undefined) throw new Error(`no ${f}`); return disk[f]!; }, write: (f, t) => { written[f] = t; },
      },
    };
  };
  it('refuses a goals file that is not the frozen one with exit 1, and still writes the named refusal', async () => {
    const { deps, written } = files();
    expect(FROZEN_GOALS_SHA).toBe('3df0161491b70da362a707723c8abbd4fcdb0a66cec5bdeeb2ea7d4c2f5ed4ed');
    expect(FROZEN_SCRIPTS_SHA).toBe('63e53f3f0e2ecd9122bb94c7670df766d58a2a7ac163b4641bb5d394e01beb06');
    expect(await main(['--goals', 'goals.json', '--t9a-report', 'r.json', '--out', 'out'], deps)).toBe(1);
    expect(JSON.parse(written['out/t10-offline.json']!).refusals[0].reason).toBe('sha-mismatch');
    expect(written['out/t10-offline.md']).toMatch(/## Refused/);
  });
  it('measures the repository named by --repo, tree and bootstrap alike; without it the one this script lives in', async () => {
    const named = files();
    await main(['--goals', 'goals.json', '--t9a-report', 'r.json', '--out', 'out', '--repo', 'some/clone'], named.deps);
    expect(named.seen).toEqual([`tree:${path.resolve('some/clone')}`, `bootstrap:${path.resolve('some/clone')}`]);
    const own = files();
    await main(['--goals', 'goals.json', '--t9a-report', 'r.json', '--out', 'out'], own.deps);
    expect(own.seen).toEqual([`tree:${DEFAULT_REPO}`, `bootstrap:${DEFAULT_REPO}`]);
    expect(path.isAbsolute(DEFAULT_REPO)).toBe(true);
    expect(existsSync(path.join(DEFAULT_REPO, 'tools/parley-token-benchmark-t10-offline.ts'))).toBe(true);
  });
  it('the real dependencies measure the named repository, not the working directory: its tree, its cleanliness, its bootstrap source', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 't10-repo-'));
    try {
      const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      git('init', '-q');
      mkdirSync(path.join(repo, 'packages/core/src/work'), { recursive: true });
      writeFileSync(path.join(repo, 'packages/core/src/work/code-mode-instructions.ts'), "export const replacementRouting = () => 'routing-of-the-named-repo';\nexport const bootstrapText = (routing: string): string => `boot:${routing}`;\n");
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'fixture');
      expect(REAL_DEPS.tree(repo)).toEqual({ treeHash: git('rev-parse', 'HEAD^{tree}'), clean: true });
      expect(await REAL_DEPS.bootstrap(repo)).toBe('boot:routing-of-the-named-repo');
      writeFileSync(path.join(repo, 'untracked.txt'), 'x');
      expect(REAL_DEPS.tree(repo).clean).toBe(false);
      expect(REAL_DEPS.tree(DEFAULT_REPO).treeHash).not.toBe(REAL_DEPS.tree(repo).treeHash);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('usage without the required flags is exit 2 and writes nothing', async () => {
    const { deps, written } = files();
    expect(await main(['--goals', 'goals.json'], deps)).toBe(2);
    expect(written).toEqual({});
  });
  it('a refused tokenizer is exit 1 and writes nothing', async () => {
    const { deps, written } = files();
    expect(await main(['--goals', 'goals.json', '--t9a-report', 'r.json', '--out', 'out', '--tokenizer-dir', 'x'], { ...deps, tokenizer: async () => { throw new Error('sha256 differs'); } })).toBe(1);
    expect(written).toEqual({});
  });
  it('a malformed final-surface file is exit 1', async () => {
    const { deps } = files({ 'f.json': '{"residuals":[1]}' });
    expect(await main(['--goals', 'goals.json', '--t9a-report', 'r.json', '--out', 'out', '--final-surface', 'f.json'], deps)).toBe(1);
  });
});

describe('the build stamp the report carries', () => {
  const expected = { goalsSha: GOALS_SHA, scriptsSha: SCRIPTS_SHA };
  it.each([
    ['a non-zero core exit', '{"protocol":0,"core":1,"run":"1"}'],
    ['a non-zero protocol exit', '{"protocol":2,"core":0,"run":"1"}'],
    ['an empty run id', '{"protocol":0,"core":0,"run":""}'],
    ['a missing key', '{"protocol":0,"core":0}'],
    ['an extra key', '{"protocol":0,"core":0,"run":"1","x":1}'],
    ['text that is not JSON', 'built'],
    ['exit codes as strings', '{"protocol":"0","core":"0","run":"1"}'],
  ])('refuses %s with report-shape', (_n, stamp) => {
    const r = readT9aReport(report({ buildStamp: stamp }), expected);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toContainEqual(expect.objectContaining({ reason: 'report-shape', detail: expect.stringMatching(/buildStamp/) }));
  });
  it('accepts exactly { protocol: 0, core: 0, run }', () => { expect(readT9aReport(report({ buildStamp: '{"core":0,"protocol":0,"run":"9-1"}' }), expected).ok).toBe(true); });
});

describe('per-call result bytes from the harness per-message list', () => {
  const pmReport = (over: Record<string, unknown> = {}) => report({
    accounting: { 'read-a': { classic: armPM(19000, [3000, 500]), replacement: armPM(5000, [200, 300]) }, 'read-b': { replacement: armPM(5000, [100]) } }, ...over,
  });
  it('reads each tools/call entry per call, and names the handshake and the list apart', () => {
    const r = out({ t9aReport: pmReport() });
    expect(r['perGoal']['read-a']['classic']['perCallResultBytes']).toMatchObject({
      status: 'measured', value: { calls: [{ kind: 'tools/call get_map', bytes: 3000 }, { kind: 'tools/call read_room', bytes: 500 }], callBytes: 3500, handshakeBytes: 100, listBytes: 900, otherBytes: 0, totalBytes: 4500 },
    });
    expect(r['perGoal']['read-a']['classic']['receivedBytes'].value).toBe(4500); // the per-call list adds up to the received total
  });
  it('puts the result bytes side by side where both arms have the list', () => {
    const r = out({ t9aReport: pmReport() });
    expect(r['sideBySide']['read-a']['resultBytes']).toMatchObject({ classic: 3500, replacement: 500, replacementMinusClassic: -3000 });
  });
  it('leaves no perCallResultBytes gap for an arm that has the list, and keeps it for one that has none', () => {
    const withList = out({ t9aReport: pmReport() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks a parsed JSON report by key
    expect(withList['coverage']['gaps'].filter((g: any) => g.metric === 'perCallResultBytes')).toEqual([]);
    const mixed = out({ t9aReport: pmReport({ accounting: { 'read-a': { classic: arm(19000, 4000), replacement: armPM(5000, [200]) }, 'read-b': { replacement: armPM(5000, [100]) } } }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walks a parsed JSON report by key
    expect(mixed['coverage']['gaps'].filter((g: any) => g.metric === 'perCallResultBytes')).toEqual([{ goal: 'read-a', arm: 'classic', metric: 'perCallResultBytes', reason: 'harness-does-not-expose' }]);
    expect(mixed['sideBySide']['read-a']['resultBytes']).toBeUndefined();
  });
  it('refuses a report whose list does not add up to what the client received', () => {
    const bad = armPM(19000, [3000, 500]); bad.context.bytes += 1;
    const r = readT9aReport(pmReport({ accounting: { 'read-a': { classic: bad } } }), { goalsSha: GOALS_SHA, scriptsSha: SCRIPTS_SHA });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toContainEqual(expect.objectContaining({ reason: 'report-shape', detail: expect.stringMatching(/add up to 4500/) }));
  });
  it.each([[{ id: 0, kind: 5, bytes: 1 }], [{ id: 0, kind: 'handshake', bytes: -1 }], [{ id: {}, kind: 'handshake', bytes: 1 }], ['x']])('refuses a malformed per-message entry %#', (entry) => {
    const a = { ...arm(1, 1), perMessage: [entry] };
    const r = readT9aReport(pmReport({ accounting: { 'read-a': { classic: a } } }), { goalsSha: GOALS_SHA, scriptsSha: SCRIPTS_SHA });
    expect(r.ok).toBe(false);
  });
  it('an empty list means the harness did not supply it, not that nothing was received', () => {
    const a = { ...arm(1000, 50), perMessage: [] };
    const r = out({ t9aReport: pmReport({ accounting: { 'read-a': { classic: a, replacement: armPM(5000, [1]) } } }) });
    expect(r['perGoal']['read-a']['classic']['perCallResultBytes']).toMatchObject({ status: 'not-measured', reason: 'harness-does-not-expose' });
  });
  it('a kind that is neither handshake, list nor a call is counted under otherBytes, never as a call result', () => {
    const pm = [{ id: 0, kind: 'handshake', bytes: 10 }, { id: null, kind: 'notification', bytes: 7 }, { id: 2, kind: 'tools/call get_map', bytes: 20 }];
    const a = { ...arm(1, 37), perMessage: pm };
    const r = out({ t9aReport: pmReport({ accounting: { 'read-a': { classic: a, replacement: armPM(5000, [1]) } } }) });
    expect(r['perGoal']['read-a']['classic']['perCallResultBytes'].value).toMatchObject({ callBytes: 20, otherBytes: 7, handshakeBytes: 10, totalBytes: 37 });
  });
});
