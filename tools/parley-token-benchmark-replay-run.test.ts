// T9a harness, slice H4a-2b: the run library, on synthetic goals and scripts (the frozen scripts file is H5). This file owns the fixture mint expression and the vi.mock.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writePreload } from './parley-token-benchmark-replay-arms.js';
import { CONSERVATION_PROCEDURE, CONSERVATION_PROCEDURE_SHA256, GUIDE_TEXT, NAMED_LIMITS, ROLES_PICK, ROLES_REST_PICK, rolesRestProblem, wantsConservation, assembleReport, checkScripts, conservationObservation, conservationPhase, guideTopicsOf, handlerProbeControl, readChunked, runAll, runRunGoal } from './parley-token-benchmark-replay-run.js';
import { checkGoalFile, type Goal } from './parley-token-benchmark-replay-schema.js';
import { createHash } from 'node:crypto';

vi.mock('../packages/core/dist/index.js', async (orig) => (await import('./parley-token-benchmark-replay-probe.js')).withHandlerProbe(await orig()));

const distDir = path.resolve('packages/core/dist');
const FIVE = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
const WRAPPERS = ['code_search', 'code_docs', 'code_execute'];
let root = '';
let preload = '';
beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'parley-replay-run-')); preload = writePreload(path.join(root, 'pre'), { distDir, proven: FIVE, mintExpression: 'np.claimFixtureSourceMint()' }); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
const T = 300_000;
const tokenizer = { name: 'bytes', count: (text: string) => Buffer.byteLength(text, 'utf8') };
const deps = () => ({ dir: root, distDir, preloadPath: preload, tokenizer, migrated: FIVE, wrapperNames: WRAPPERS });

const DATA = {
  self: 'caller',
  sessions: [{ key: 'caller', label: 'Synthetic caller', provider: 'codex', lifecycle: 'active', task: 'Inspect', summary: 'CALLER-SUMMARY' }, { key: 'peer', label: 'Amber peer', provider: 'claude', lifecycle: 'active', task: 'Review amber', summary: 'AMBER-SUMMARY' }],
  rooms: [], plans: [], backlog: [],
};
function goals(list: object[]): Goal[] {
  const r = checkGoalFile({ version: 1, goals: list });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return [...r.goals];
}
const RUN = { id: 'summaries', class: 'read-dto', kind: 'run', goal: 's', arms: ['classic', 'replacement'], data: DATA, answer: { summaries: 'the session summaries' }, criteria: [{ answer: { path: 'summaries', equals: ['CALLER-SUMMARY', 'AMBER-SUMMARY'] } }, { equalAcrossArms: 'summaries' }] };
const SCRIPT = { goal: 'summaries', classic: { calls: [{ name: 'get_map', args: {} }], extract: { summaries: { call: 0, path: 'map.sessions[*].summary' } } }, replacement: { code: 'const m = await parley.get_map({}); return m.value.map.sessions.map((s) => s.unknownFields.summary);', extract: { summaries: { path: '' } } } };

describe('checkScripts: the scripts file against the frozen goals', () => {
  const g = goals([RUN, { id: 'only-replacement', class: 'abort', kind: 'run', goal: 's', arms: ['replacement'], armsReason: 'replacement-only: x', data: DATA, faults: { host: { call: 'hang', callMethod: 'read_room' }, abort: { afterCalls: 1 }, limits: { wallMs: 3000 } }, answer: {}, criteria: [{ run: { attemptedExecute: true, incomplete: true, status: 'partial-or-unknown' } }, { host: { calls: 1, distinctCalls: 1, handlerStarts: { method: 'read_room', n: 1 }, callsAfter: { fault: 'abort', n: 0 }, maxAttemptsPerCall: 1 } }] }]);
  const OTHER = { goal: 'only-replacement', replacement: { code: 'return 1;', extract: {} } };
  const issues = (file: unknown): string[] => { const r = checkScripts(file, g); return r.ok ? [] : [...r.issues]; };
  it('every extract option a good script uses is accepted', () => {
    const extract = { summaries: { calls: [0], path: 'x', raw: true, is: 'a', where: { code: 'c' }, skip: 1, prefix: 3, parse: 'json', shape: { a: 'b', c: { path: 'd', project: ['e'] } }, project: ['k'] } };
    expect(issues({ version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract } }, OTHER] })).toEqual([]);
  });
  it('a good file passes and is keyed by goal', () => {
    const r = checkScripts({ version: 1, scripts: [SCRIPT, OTHER] }, g);
    expect(r.ok).toBe(true);
    expect(r.ok && [...r.byGoal.keys()]).toEqual(['summaries', 'only-replacement']);
  });
  it.each([
    ['not the container', { scripts: [] }, /\{ version: 1, scripts/],
    ['extra keys', { version: 1, scripts: [], x: 1 }, /nothing else/],
    ['an unknown goal', { version: 1, scripts: [SCRIPT, OTHER, { goal: 'nope' }] }, /nope is not a run goal/],
    ['the same goal twice', { version: 1, scripts: [SCRIPT, SCRIPT, OTHER] }, /summaries twice/],
    ['a run goal without a script', { version: 1, scripts: [SCRIPT] }, /only-replacement: a run goal without a script/],
    ['a script for an arm the goal does not run', { version: 1, scripts: [SCRIPT, { ...OTHER, classic: SCRIPT.classic }] }, /does not run the classic arm/],
    ['an arm the goal runs without a script', { version: 1, scripts: [{ goal: 'summaries', classic: SCRIPT.classic }, OTHER] }, /summaries runs the replacement arm and needs a script/],
    ['no classic calls', { version: 1, scripts: [{ ...SCRIPT, classic: { calls: [], extract: SCRIPT.classic.extract } }, OTHER] }, /one or more \{ name, args \}/],
    ['a call without args', { version: 1, scripts: [{ ...SCRIPT, classic: { calls: [{ name: 'get_map' }], extract: SCRIPT.classic.extract } }, OTHER] }, /one or more/],
    ['an extract call index past the calls', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { call: 3, path: 'x' } } } }, OTHER] }, /a call index of this script/],
    ['an extract without a path', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: {} } } }, OTHER] }, /\{ path: string/],
    ['a prefix that is not a positive integer', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { call: 0, path: 'x', prefix: 0 } } } }, OTHER] }, /prefix: a positive integer/],
    ['calls with call', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { call: 0, calls: [0], path: 'x' } } } }, OTHER] }, /calls: call indexes of this script, without `call`/],
    ['calls past the script', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { calls: [0, 5], path: 'x' } } } }, OTHER] }, /calls: call indexes/],
    ['a skip that is not positive', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { path: 'x', skip: 0 } } } }, OTHER] }, /skip: a positive integer/],
    ['a parse that is not json', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { path: 'x', parse: 'yaml' } } } }, OTHER] }, /parse: json/],
    ['a shape member that is not a path', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { path: 'x', shape: { a: 5 } } } } }, OTHER] }, /shape: \{ name: path/],
    ['a raw that is not true', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { path: 'x', raw: 1 } } } }, OTHER] }, /raw: true/],
    ['a where that is not strings', { version: 1, scripts: [{ ...SCRIPT, classic: { ...SCRIPT.classic, extract: { summaries: { path: 'x', where: { code: 1 } } } } }, OTHER] }, /where: \{ member: string \}/],
    ['an empty replacement script', { version: 1, scripts: [{ ...SCRIPT, replacement: { code: '', extract: SCRIPT.replacement.extract } }, OTHER] }, /replacement\.code: a script/],
    ['a second request that is not a string', { version: 1, scripts: [{ ...SCRIPT, replacement: { ...SCRIPT.replacement, second: 1 } }, OTHER] }, /second: a string/],
    ['answer names that are not the goal\'s', { version: 1, scripts: [{ ...SCRIPT, replacement: { ...SCRIPT.replacement, extract: { other: { path: '' } } } }, OTHER] }, /are not the goal's answer names/],
  ])('%s is refused', (_name, file, message) => { expect(issues(file).join('\n')).toMatch(message); });
});

describe('the conservation procedure is pinned by its text', () => {
  it('its sha256 is the hash of the five lines, and a changed line is another hash', () => {
    expect(CONSERVATION_PROCEDURE).toHaveLength(5);
    expect(CONSERVATION_PROCEDURE_SHA256).toBe(createHash('sha256').update(CONSERVATION_PROCEDURE.join('\n')).digest('hex'));
    expect(createHash('sha256').update([...CONSERVATION_PROCEDURE.slice(0, 4), 'x'].join('\n')).digest('hex')).not.toBe(CONSERVATION_PROCEDURE_SHA256);
  });
  it('the topics come from the topic enum of the read_guide descriptor, or the run stops by name', () => {
    expect(guideTopicsOf([{ name: 'read_guide', inputSchema: { properties: { topic: { enum: ['a', 'b'] } } } } as never])).toEqual(['a', 'b']);
    expect(() => guideTopicsOf([{ name: 'read_guide', inputSchema: {} } as never])).toThrow(/no topic enum/);
    expect(() => guideTopicsOf([])).toThrow(/no topic enum/);
  });
});

describe('a run goal through both arms, judged', () => {
  it('both arms run, the answer equals across them, every criterion passes, skips are 0 and the accounting names both arms', async () => {
    const [goal] = goals([RUN]);
    const checked = checkScripts({ version: 1, scripts: [SCRIPT] }, [goal!]);
    if (!checked.ok) throw new Error('scripts');
    const r = await runRunGoal(goal!, checked.byGoal, deps());
    expect(r.verdicts.filter((v) => !v.pass).map((v) => `${v.arm} ${v.where}: ${v.detail}`)).toEqual([]);
    expect(r.verdicts.some((v) => v.arm === 'classic')).toBe(true);
    expect(r.verdicts.some((v) => v.arm === 'replacement')).toBe(true);
    expect(r.skips).toEqual({ classic: 0, replacement: 0 });
    expect(Object.keys(r.accounting).sort()).toEqual(['classic', 'replacement']);
    expect(r.accounting.replacement!.calls.wrapper).toBe(2);
    expect(r.accounting.classic!.calls.direct).toBe(1);
    // the per-call result bytes of each arm add up to what that arm's client received
    for (const arm of ['classic', 'replacement'] as const) {
      const a = r.accounting[arm]!;
      expect(a.perMessage.reduce((n, m) => n + m.bytes, 0)).toBe(a.context.bytes);
      expect(a.perMessage.map((m) => m.kind).slice(0, 2)).toEqual(['handshake', 'tools/list']);
    }
    expect(r.accounting.replacement!.perMessage.map((m) => m.kind)).toEqual(['handshake', 'tools/list', 'tools/call code_search', 'tools/call code_execute']);
  }, T);

  it('a goal whose answers differ between the arms fails by criterion, not by an exception', async () => {
    const [goal] = goals([RUN]);
    const bad = { ...SCRIPT, replacement: { ...SCRIPT.replacement, code: 'return ["x", "y"];' } };
    const checked = checkScripts({ version: 1, scripts: [bad] }, [goal!]);
    if (!checked.ok) throw new Error('scripts');
    const r = await runRunGoal(goal!, checked.byGoal, deps());
    expect(r.verdicts.filter((v) => !v.pass).map((v) => v.where)).toEqual(expect.arrayContaining(['criteria[0]', 'criteria[1]']));
  }, T);
});

describe('the conservation goal: the phase reads on both arms and the comparison is judged', () => {
  it('tool list, catalogue and the four sources are observed and judged equal', async () => {
    const CONS = { id: 'cons', class: 'conservation-source', kind: 'run', goal: 's', arms: ['classic', 'replacement'], data: DATA, answer: { summaries: 'the session summaries' },
      criteria: [{ toolList: { partition: true } }, { toolList: { residualSchemasEqualClassic: true } }, { toolList: { residualOrderEqualClassic: true } }, { catalogue: { namesEqualOriginal: true } }, { sources: { unchanged: ['guide', 'roles', 'recipes', 'skills'] } }, { catalogue: { orderEqualBetweenRuns: true, bytesEqualBetweenRuns: true } }] };
    const [goal] = goals([CONS]);
    const checked = checkScripts({ version: 1, scripts: [{ ...SCRIPT, goal: 'cons' }] }, [goal!]);
    if (!checked.ok) throw new Error('scripts');
    const r = await runRunGoal(goal!, checked.byGoal, deps());
    const failed = r.verdicts.filter((v) => !v.pass).map((v) => `${v.where}: ${v.detail}`);
    // every conservation criterion passes: partition, schemas, order, catalogue, guide, roles, and the recipes and skills read at launch planning
    expect(failed).toEqual([]);
    expect(r.launchSources!.where.recipes).toContain('launch of the lead session');
    // the whole-guide limit is recorded from the run itself: the classic answer is whole, the replacement read succeeds and its final value is refused
    const whole = r.conservation!;
    expect(whole.classic!.wholeGuide.classicBytes).toBeGreaterThan(40_000);
    expect(whole.replacement!.wholeGuide.replacement).toMatchObject({ status: 'error', errorKind: 'invalid-output', message: 'The final value is not bounded strict JSON.', incomplete: true });
    expect(whole.replacement!.wholeGuide.replacement!.readBytes).toBeGreaterThan(40_000);
    // both arms read the same topics, in the same order, and every topic text is non-empty
    expect(whole.replacement!.guide.map((g) => g.topic)).toEqual(whole.classic!.guide.map((g) => g.topic));
    expect(whole.classic!.guide.every((g) => g.text.length > 0)).toBe(true);
    expect(whole.replacement!.catalogue).toHaveLength(2);
    // list_roles members other than roles: both arms carry partial and diagnostics, both reads were complete, and they are equal
    expect(JSON.parse(whole.classic!.rolesRest)).toEqual({ partial: false, diagnostics: [] });
    expect(whole.replacement!.rolesRest).toBe(whole.classic!.rolesRest);
    console.log('CONS-FAILED', JSON.stringify(failed));
  }, T);
});

describe('a catalogue-only conservation goal also runs the phase', () => {
  it('the catalogue criterion alone asks for the phase and gets its observation', async () => {
    const [goal] = goals([{ id: 'cat', class: 'conservation-list', kind: 'run', goal: 's', arms: ['classic', 'replacement'], data: DATA, answer: { summaries: 'the session summaries' }, criteria: [{ catalogue: { namesEqualOriginal: true } }] }]);
    const checked = checkScripts({ version: 1, scripts: [{ ...SCRIPT, goal: 'cat' }] }, [goal!]);
    if (!checked.ok) throw new Error('scripts');
    const r = await runRunGoal(goal!, checked.byGoal, deps());
    expect(r.verdicts.filter((v) => !v.pass).map((v) => v.detail)).toEqual([]);
    expect(r.conservation?.replacement?.catalogue).toHaveLength(2);
  }, T);
});

describe('runAll: run, launch and rollback goals in one set, strictly one after another', () => {
  it('every goal gets verdicts on the arms it runs; the sets add up', async () => {
    const list = goals([
      RUN,
      { id: 'launch-plain', class: 'routing-role', kind: 'launch', goal: 'x', launch: { provider: 'claude', mode: 'launch', profile: 'full', role: null, recipe: null, navigator: false, channel: true, agent: true, routing: { fixture: FIVE }, skills: { catalogue: 'none', entries: [] } }, criteria: [{ layerEqualsClassicWithBootstrap: true }, { argv: { equalsClassicOutsideLayer: true } }] },
      { id: 'rollback-clear', class: 'rollback', kind: 'rollback', goal: 'x', rollback: { record: 'none', requested: true, refused: null, writesExist: false }, criteria: [{ selection: { effective: 'replacement', reason: null } }, { repeatSelection: 2 }] },
    ]);
    const checked = checkScripts({ version: 1, scripts: [SCRIPT] }, list);
    if (!checked.ok) throw new Error('scripts');
    const r = await runAll(list, checked.byGoal, deps());
    expect(r.verdicts.filter((v) => !v.pass).map((v) => `${v.goal} ${v.where}: ${v.detail}`)).toEqual([]);
    expect([...new Set(r.verdicts.map((v) => v.goal))].sort()).toEqual(['launch-plain', 'rollback-clear', 'summaries']);
    expect(r.skipsByArm).toEqual({ classic: 0, replacement: 0 });
    expect(Object.keys(r.accounting)).toEqual(['summaries']);
  }, T);
});

describe('the handler probe control and the report extras', () => {
  it('the control says true where the core tool runner is wrapped (this file mocks it), from a real call through the real host', async () => {
    expect(await handlerProbeControl(root)).toBe(true);
  }, T);
  it('assembleReport keeps the scored report whole and adds the build stamp, the machine, the procedure hash, the whole-guide limit and where things were judged', () => {
    const facts = { node: 'v22', platform: 'darwin', load: [1, 2, 3], sdk: { root: '/r', version: '1.30.0' }, nativeProbe: { path: 'p', exists: true, sha256: 'ab' }, builds: { stamp: '/s', protocol: 0, core: 0 }, treeHash: 'abc' } as never;
    const out = assembleReport({ goals: 58, passed: true }, { facts, buildStamp: '{"run":"1-2"}\n', launchSources: { cons: { where: { recipes: 'r', skills: 's' } } as never }, conservation: { cons: { classic: { wholeGuide: { classicBytes: 45420, replacement: null } } as never, replacement: { wholeGuide: { classicBytes: null, replacement: { status: 'error', errorKind: 'invalid-output', message: 'm', readBytes: 46266, incomplete: true, diagnostics: [] } } } as never } } });
    expect(out).toMatchObject({ goals: 58, passed: true, buildStamp: '{"run":"1-2"}\n', conservationProcedureSha256: CONSERVATION_PROCEDURE_SHA256 });
    expect(out['environment']).toEqual({ node: 'v22', platform: 'darwin', load: [1, 2, 3], sdk: { root: '/r', version: '1.30.0' }, probeSha256: 'ab', builds: { stamp: '/s', protocol: 0, core: 0 }, treeHash: 'abc' });
    expect(out['surfaceLimits']).toEqual([...NAMED_LIMITS.map((l) => ({ ...l })), { name: 'whole guide in one script run', goal: 'cons', classicBytes: 45420, replacement: { status: 'error', errorKind: 'invalid-output', message: 'm', readBytes: 46266, incomplete: true, diagnostics: [] }, cause: expect.stringContaining('16 KiB') }]);
    expect(out['sourceReads']).toEqual([{ goal: 'cons', recipes: 'r', skills: 's' }]);
    expect(out['accountingNote']).toMatch(/conservation phase.*not in them/);
    expect(out['judgedAt']).toEqual({ rollback: expect.stringContaining('not the launcher'), recipesAndSkills: expect.stringContaining('launch planning') });
  });
});

describe('conservationObservation takes each side from its own arm', () => {
  const conv = (guideText: string, roles: string, names: string[]) => ({ wholeGuide: { classicBytes: null, replacement: null }, guide: [{ topic: 't', text: guideText }], roles, rolesRest: '{}', catalogue: names.length === 0 ? [] : [{ names, bytes: 'b' }, { names, bytes: 'b' }] });
  const arm = (toolNames: string[], phase: unknown) => ({ tools: toolNames.map((name) => ({ name })), phase }) as never;
  it('the tool lists, the guide and roles, and the catalogue are each from the arm they were read on', () => {
    const c = conservationObservation(arm(['a', 'b'], conv('classic guide', 'classic roles', [])), arm(['a', 'code_search'], conv('other guide', 'other roles', ['a', 'b'])), WRAPPERS, ['b']);
    expect(c.classicTools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(c.replacementTools.map((t) => t.name)).toEqual(['a', 'code_search']);
    expect(c.originalNames).toEqual(['a', 'b']);
    expect(c.catalogueNames).toEqual(['a', 'b']);
    expect(c.catalogueRuns).toHaveLength(2);
    expect(c.sources['guide']).toEqual({ classic: '# t\nclassic guide', replacement: '# t\nother guide' });
    expect(c.sources['roles']).toEqual({ classic: 'classic roles\n{}', replacement: 'other roles\n{}' });
    expect(c.migrated).toEqual(['b']);
    expect(c.wrapperNames).toEqual(WRAPPERS);
  });
  it('the roles members other than roles are part of the compared roles: a replacement that reports partial while classic does not differs', () => {
    const a = conv('g', 'r', []);
    const b = { ...conv('g', 'r', []), rolesRest: '{"partial":true,"diagnostics":[]}' };
    const c = conservationObservation(arm([], a), arm([], b), WRAPPERS, []);
    const roles = c.sources['roles'] as { classic: string; replacement: string };
    expect(roles.classic).not.toBe(roles.replacement);
  });
  it('an arm that did not run the phase stops the run by name', () => {
    expect(() => conservationObservation(arm([], undefined), arm([], conv('g', 'r', [])), WRAPPERS, [])).toThrow(/did not run the conservation phase/);
    expect(() => conservationObservation(arm([], conv('g', 'r', [])), arm([], undefined), WRAPPERS, [])).toThrow(/did not run the conservation phase/);
  });
});

describe('the reads inside the conservation phase', () => {
  const ok = (value: unknown) => ({ result: { status: 'completed', error: null, incomplete: false } as never, body: { value } });
  it('readChunked puts the slices together and stops when the text is whole', async () => {
    const text = 'x'.repeat(13_000);
    const asked: string[] = [];
    const tools = { arm: 'replacement', tools: [], call: async () => null, search: async () => ({ body: {}, text: '' }), run: async (code: string) => { asked.push(code); const at = Number(/s\.slice\((\d+),/.exec(code)![1]); return ok({ total: text.length, part: text.slice(at, at + 6000) }); } } as never;
    expect(await readChunked(tools, 'await parley.x()', 'x')).toBe(text);
    expect(asked).toHaveLength(3);
  });
  it('a run that did not complete, a missing slice and slices that do not add up are failed reads, by name', async () => {
    const tool = (run: (code: string) => unknown) => ({ arm: 'replacement', tools: [], call: async () => null, search: async () => ({ body: {}, text: '' }), run: async (code: string) => run(code) }) as never;
    await expect(readChunked(tool(async () => ({ result: { status: 'error', error: { kind: 'invalid-output' }, incomplete: true }, body: {} })), 'c', 'the thing')).rejects.toThrow(/conservation read of the thing did not complete \(error invalid-output\)/);
    await expect(readChunked(tool(async () => ok({ nope: 1 })), 'c', 'the thing')).rejects.toThrow(/returned no slice/);
    await expect(readChunked(tool(async () => ok({ total: 5, part: 'abc' })), 'c', 'the thing')).rejects.toThrow(/3 characters put together, 5 expected|did not complete/);
  });
  it('the picks run as the script writes them: the guide text is opened out of { text }, the roles lose only the empty unknownFields', () => {
    const run = (pick: string, r: unknown): unknown => new Function('r', `return ${pick};`)(r);
    expect(run(GUIDE_TEXT, { value: 'plain' })).toBe('plain');
    expect(run(GUIDE_TEXT, { value: { text: 'inside' } })).toBe('inside');
    expect(run(GUIDE_TEXT, { value: { other: 1 } })).toBe('{"other":1}');
    // the wrapper is opened only when `text` is its only member: an extra member on the replacement side stays in the compared text
    expect(run(GUIDE_TEXT, { value: { text: 'x', extra: 1 } })).toBe('{"text":"x","extra":1}');
    expect(run(GUIDE_TEXT, { value: { text: 5 } })).toBe('{"text":5}');
    expect(run(GUIDE_TEXT, { value: ['x'] })).toBe('["x"]');
    expect(run(GUIDE_TEXT, { value: null })).toBe('null');
    expect(run(ROLES_PICK, { value: { roles: [{ id: 'a', unknownFields: {}, models: { claude: 'x', unknownFields: {} } }, { id: 'b', unknownFields: { extra: 1 } }] } }))
      .toBe('[{"id":"a","models":{"claude":"x"}},{"id":"b","unknownFields":{"extra":1}}]');
  });
});

describe('the scripts file the run file pins', () => {
  it('the sha256 in the run file is the sha256 of tools/read-workflow-scripts.json, and the file is the container checkScripts expects', () => {
    const runFile = readFileSync(path.resolve('tools/parley-token-benchmark-replay.run.test.ts'), 'utf8');
    const pinned = /const EXPECTED_SCRIPTS_SHA = '([0-9a-f]{64})';/.exec(runFile)?.[1];
    const text = readFileSync(path.resolve('tools/read-workflow-scripts.json'), 'utf8');
    expect(pinned).toBe(createHash('sha256').update(text).digest('hex'));
    const file = JSON.parse(text) as { version: number; scripts: { goal: string }[] };
    expect(Object.keys(file)).toEqual(['version', 'scripts']);
    expect(new Set(file.scripts.map((e) => e.goal)).size).toBe(file.scripts.length);
    expect(file.scripts).toHaveLength(43);
  });
});

describe('the named limits of the surface are in every report', () => {
  it('each names the goals it shaped, and each goal is a goal of the frozen file', () => {
    const ids = new Set((JSON.parse(readFileSync(path.resolve('tools/read-workflow-scripts.json'), 'utf8')) as { scripts: { goal: string }[] }).scripts.map((e) => e.goal));
    for (const l of NAMED_LIMITS) { expect(l.cause.length).toBeGreaterThan(20); for (const g of l.goals) expect(ids.has(g)).toBe(true); }
  });
});

describe('the roles members other than roles are checked, not dropped silently', () => {
  const run = (pick: string, r: unknown): unknown => new Function('r', `return ${pick};`)(r);
  it('the rest pick keeps every member but roles and an empty unknownFields', () => {
    expect(run(ROLES_REST_PICK, { value: { roles: [], unknownFields: {} } })).toBe('{}');
    expect(run(ROLES_REST_PICK, { value: { roles: [], unknownFields: { a: 1 } } })).toBe('{"unknownFields":{"a":1}}');
    expect(run(ROLES_REST_PICK, { value: { roles: [], partial: true, diagnostics: [{ code: 'x' }] } })).toBe('{"partial":true,"diagnostics":[{"code":"x"}]}');
  });
  it('a partial or diagnosed read, or any other member, is refused by name', () => {
    expect(rolesRestProblem({})).toBeNull();
    expect(rolesRestProblem({ partial: false, diagnostics: [] })).toBeNull();
    expect(rolesRestProblem({ partial: true })).toMatch(/reports partial: true/);
    expect(rolesRestProblem({ partial: false, diagnostics: [{ code: 'x' }] })).toMatch(/reports diagnostics/);
    expect(rolesRestProblem({ unknownFields: { a: 1 } })).toMatch(/member beyond roles, partial and diagnostics: unknownFields/);
  });
});

describe('the replacement roles read is read for its other members too', () => {
  const fake = (rest: string) => ({
    arm: 'replacement', tools: [],
    call: async () => null, search: async () => ({ body: { items: [] }, text: '' }),
    run: async (code: string) => {
      const text = code.includes('parley.list_roles') ? (code.includes("k !== 'roles'") ? rest : '[]') : '';
      return { result: { status: 'completed', error: null, incomplete: false, diagnostics: [] }, body: { value: { total: text.length, part: text }, operations: [] } };
    },
  }) as never;
  it('a replacement that reports partial stops the phase by name; a complete one is carried as its rest text', async () => {
    const phase = conservationPhase(() => []);
    await expect(phase(fake('{"partial":true,"diagnostics":[]}'))).rejects.toThrow(/roles on the replacement arm: list_roles reports partial: true/);
    const ok = await phase(fake('{"partial":false,"diagnostics":[]}')) as { rolesRest: string };
    expect(ok.rolesRest).toBe('{"partial":false,"diagnostics":[]}');
  });
});

describe('a goal that takes the conservation phase cannot have what the phase would disturb', () => {
  const base = { id: 'g', class: 'conservation-source', kind: 'run', arms: ['classic', 'replacement'], faults: {}, criteria: [{ toolList: { partition: true } }] };
  it('faults, a record criterion and a canary criterion are refused; a plain one is accepted', () => {
    expect(wantsConservation(base as never)).toBe(true);
    expect(wantsConservation({ ...base, faults: { profile: 'x', navigator: {}, agent: {} } } as never)).toBe(true);
    expect(wantsConservation({ ...base, criteria: [{ answer: { path: 'a', present: true } }], faults: { abort: {} } } as never)).toBe(false);
    expect(() => wantsConservation({ ...base, faults: { abort: { afterCalls: 1 } } } as never)).toThrow(/faults \(abort\)/);
    expect(() => wantsConservation({ ...base, criteria: [...base.criteria, { record: { state: 'free' } }] } as never)).toThrow(/record or canary criterion/);
    expect(() => wantsConservation({ ...base, criteria: [...base.criteria, { text: { neverContains: { $canary: true } } }] } as never)).toThrow(/record or canary criterion/);
    expect(wantsConservation({ ...base, criteria: [...base.criteria, { text: { neverContains: 'x' } }] } as never)).toBe(true);
  });
});
