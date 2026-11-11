// T9a harness, slice H3a: launch goals through the real launch planning. The eight frozen launch goals are judged for real when the goals file is given.
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { judgeLaunchGoal } from './parley-token-benchmark-replay-judge.js';
import { withHome } from './parley-token-benchmark-replay-data.js';
import { LaunchSetupError, codeOf, runLaunchGoal } from './parley-token-benchmark-replay-launch.js';
import { checkGoalFile, type Goal } from './parley-token-benchmark-replay-schema.js';

const FIVE = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
const launch = (over: Record<string, unknown>) => ({ provider: 'codex', mode: 'launch', profile: 'short', role: null, recipe: null, navigator: false, channel: true, agent: true, routing: { fixture: FIVE }, skills: { catalogue: 'verified', entries: [] }, ...over });
function goalOf(id: string, l: Record<string, unknown>, criteria: object[]): Goal {
  const r = checkGoalFile({ version: 1, goals: [{ id, class: 'routing-role', kind: 'launch', goal: 'x', launch: l, criteria }] });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.goals[0]!;
}
const T = 120_000;

describe('a launch goal through the real launch planning', () => {
  it('a fixture routing puts the bootstrap first and leaves the rest of the layer and the arguments as the launch without routing had them', async () => {
    const g = goalOf('plain', launch({ provider: 'claude', profile: 'full', skills: { catalogue: 'none', entries: [] } }), [{ layerEqualsClassicWithBootstrap: true }, { argv: { equalsClassicOutsideLayer: true } }, { selectsClassic: { value: false } }]);
    const o = await runLaunchGoal(g);
    expect(o.bootstrap.length).toBeGreaterThan(0);
    expect(o.plan.layer.startsWith(`${o.bootstrap}\n`)).toBe(true);
    expect(o.classic.layer).not.toContain(o.bootstrap);
    expect(o.plan.argvWithoutLayer).toBe(o.classic.argvWithoutLayer);
    expect(o.plan.argvWithoutLayer.length).toBeGreaterThan(0);
    expect(judgeLaunchGoal(g, o).every((v) => v.pass)).toBe(true);
  }, T);

  it('the native context revision is a fresh uuid on every plan: masked in the arguments and the env, and nothing else is', async () => {
    const o = await runLaunchGoal(goalOf('plain', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]));
    expect(o.plan.argvWithoutLayer).toContain('PARLEY_NATIVE_CONTEXT_REVISION="<revision>"');
    expect(o.plan.argvWithoutLayer).toBe(o.classic.argvWithoutLayer);
    expect(o.plan.env['PARLEY_NATIVE_CONTEXT_REVISION']).toBe('<revision>');
    expect(o.plan.argvWithoutLayer).toMatch(/PARLEY_SESSION_ID="s-\d+"/);
    // the scratch directory is random per run: masked, so two runs of one goal produce the same arguments
    expect(o.plan.argvWithoutLayer).toContain('<scratch>');
    const again = await runLaunchGoal(goalOf('plain', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]));
    expect(again.plan.argvWithoutLayer).toBe(o.plan.argvWithoutLayer);
    expect(again.plan.env).toEqual(o.plan.env);
  }, T);

  it('on Codex the examples block of the layer is rebuilt for a migrated operation: the layer is NOT the classic layer behind the bootstrap', async () => {
    const o = await runLaunchGoal(goalOf('codex', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]));
    const rest = o.plan.layer.slice(o.bootstrap.length + 1);
    expect(rest).not.toBe(o.classic.layer);
    expect(rest).toContain('apiRevision comes from code_docs');
    expect(o.classic.layer).not.toContain('apiRevision comes from code_docs');
  }, T);

  it('a custom role that names a migrated operation is incompatible and selects classic; one that does not is compatible', async () => {
    const bad = goalOf('bad-role', launch({ role: { customPrompt: 'First call get_map directly.' } }), [{ verdict: { source: 'role', status: 'incompatible' } }, { selectsClassic: { value: true, source: 'role' } }, { layer: { contains: 'First call get_map directly.' } }]);
    const good = goalOf('good-role', launch({ role: { customPrompt: 'Summarize the amber finding.' } }), [{ verdict: { source: 'role', status: 'compatible' } }, { selectsClassic: { value: false } }]);
    expect(judgeLaunchGoal(bad, await runLaunchGoal(bad)).every((v) => v.pass)).toBe(true);
    expect(judgeLaunchGoal(good, await runLaunchGoal(good)).every((v) => v.pass)).toBe(true);
  }, T);

  it('the catalogue Codex returned reaches the verdict: a skill that calls a migrated operation is incompatible; none held is unverified', async () => {
    const nav = { navigator: true };
    const bad = goalOf('bad-skill', launch({ ...nav, skills: { catalogue: 'verified', entries: [{ name: 'reader', description: 'Call get_map directly.', source: 'user' }] } }), [{ skillCatalogue: { includes: ['reader'] } }, { verdict: { source: 'skills', status: 'incompatible' } }, { selectsClassic: { value: true, source: 'skills' } }]);
    const none = goalOf('no-catalogue', launch({ ...nav, skills: { catalogue: 'none', entries: [] } }), [{ verdict: { source: 'skills', status: 'unverified' } }, { selectsClassic: { value: false } }]);
    expect(judgeLaunchGoal(bad, await runLaunchGoal(bad)).every((v) => v.pass)).toBe(true);
    expect(judgeLaunchGoal(none, await runLaunchGoal(none)).every((v) => v.pass)).toBe(true);
  }, T);

  it('the tools criteria read the launch\'s own list: an agent channel adds the browser and session tools, none leaves them out', async () => {
    const withAgent = goalOf('agent', launch({ provider: 'glm', mode: 'new', profile: 'full' }), [{ tools: { includes: ['browser_open', 'create_session', 'report'] } }]);
    const without = goalOf('no-agent', launch({ mode: 'resume', agent: false, channel: false }), [{ tools: { includes: ['report'] } }, { tools: { excludes: ['browser_open', 'create_session'] } }]);
    expect(judgeLaunchGoal(withAgent, await runLaunchGoal(withAgent)).every((v) => v.pass)).toBe(true);
    expect(judgeLaunchGoal(without, await runLaunchGoal(without)).every((v) => v.pass)).toBe(true);
  }, T);

  it('a launch input with no seam, or a profile the provider does not get, stops the run by name', async () => {
    await expect(runLaunchGoal(goalOf('recipe', launch({ recipe: 'builtin:x' }), [{ argv: { equalsClassicOutsideLayer: true } }]))).rejects.toThrow(LaunchSetupError);
    await expect(runLaunchGoal(goalOf('native', launch({ role: { nativeAgent: 'x' } }), [{ argv: { equalsClassicOutsideLayer: true } }]))).rejects.toThrow(/custom prompt role/);
    await expect(runLaunchGoal(goalOf('profile', launch({ profile: 'full' }), [{ tools: { includes: ['report'] } }]))).rejects.toThrow(/not the profile codex gets/);
    await expect(runLaunchGoal(goalOf('claude-catalogue', launch({ provider: 'claude', navigator: true, skills: { catalogue: 'verified', entries: [] } }), [{ argv: { equalsClassicOutsideLayer: true } }]))).rejects.toThrow(/read later by the MCP process/);
  }, T);

  it('the routing the goal names is the routing planned: classic is the launch without one, shipped proves nothing, a fixture lists its operations', async () => {
    const claude = (routing: unknown) => launch({ provider: 'claude', profile: 'full', skills: { catalogue: 'none', entries: [] }, routing });
    const classic = await runLaunchGoal(goalOf('c', claude('classic'), [{ argv: { equalsClassicOutsideLayer: true } }]));
    expect(classic.bootstrap).toBe('');
    expect(classic.migrated).toEqual([]);
    expect(classic.plan.layer).toBe(classic.classic.layer);
    const shipped = await runLaunchGoal(goalOf('s', claude('shipped'), [{ argv: { equalsClassicOutsideLayer: true } }]));
    expect(shipped.bootstrap).toContain('nothing is migrated');
    expect(shipped.migrated).toEqual([]);
    const fixture = await runLaunchGoal(goalOf('f', claude({ fixture: ['get_map'] }), [{ argv: { equalsClassicOutsideLayer: true } }]));
    expect(fixture.migrated).toEqual(['get_map']);
    expect(fixture.bootstrap).toContain('only get_map is migrated');
  }, T);

  it('a partial catalogue is unverified even when no skill in it is a problem; a complete one is compatible', async () => {
    const nav = { navigator: true };
    const entries = [{ name: 'reader', description: 'Summarize amber.', source: 'user' }];
    const partial = await runLaunchGoal(goalOf('p', launch({ ...nav, skills: { catalogue: 'partial', entries } }), [{ verdict: { source: 'skills', status: 'unverified' } }]));
    const full = await runLaunchGoal(goalOf('v', launch({ ...nav, skills: { catalogue: 'verified', entries } }), [{ verdict: { source: 'skills', status: 'compatible' } }]));
    expect(partial.plan.verdict['skills']?.status).toBe('unverified');
    expect(full.plan.verdict['skills']?.status).toBe('compatible');
  }, T);

  it('the mode picks the planner, the channel and the agent reach the plan, and the Codex profile is the short list', async () => {
    const argvOf = async (over: Record<string, unknown>) => (await runLaunchGoal(goalOf('m', launch(over), [{ argv: { equalsClassicOutsideLayer: true } }]))).plan;
    const [launched, resumed, fresh] = [await argvOf({ mode: 'launch' }), await argvOf({ mode: 'resume' }), await argvOf({ mode: 'new' })];
    expect(new Set([launched.argvWithoutLayer, resumed.argvWithoutLayer, fresh.argvWithoutLayer]).size).toBeGreaterThan(1);
    expect(resumed.argvWithoutLayer).not.toBe(launched.argvWithoutLayer);
    const claude = { provider: 'claude', profile: 'full', skills: { catalogue: 'none', entries: [] } }; // the channel flag is Claude's
    const [withChannel, without] = [await argvOf({ ...claude, channel: true }), await argvOf({ ...claude, channel: false })];
    expect(withChannel.argvWithoutLayer).not.toBe(without.argvWithoutLayer);
    const [withAgent, noAgent] = [await argvOf({ agent: true }), await argvOf({ agent: false })];
    expect(withAgent.argvWithoutLayer).toContain('PARLEY_AGENT_URL');
    expect(noAgent.argvWithoutLayer).not.toContain('PARLEY_AGENT_URL');
    const codex = await argvOf({ provider: 'codex', profile: 'short' });
    const glm = await argvOf({ provider: 'glm', profile: 'full', mode: 'new' });
    expect(codex.tools.length).toBeLessThan(glm.tools.length);
  }, T);

  it('the layer is cut out of the arguments whole: no layer text and no dangling -c flag is left in what remains', async () => {
    const o = await runLaunchGoal(goalOf('cut', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]));
    const tokens = o.plan.argvWithoutLayer.split('\u0000');
    expect(o.plan.argvWithoutLayer).not.toContain('developer_instructions');
    expect(tokens.every((t, i) => !(t === '-c' && (tokens[i + 1] === undefined || tokens[i + 1] === '-c')))).toBe(true);
    expect(o.plan.layer.length).toBeGreaterThan(1000);
  }, T);

  it('a launch the product refuses is a thrown code on that view, not a failed run: only the planned view is refused', async () => {
    const refuse: typeof import('../packages/core/src/work/launch.js').planLaunch = async (_p, _w, _s, options) => {
      if (options?.codeMode?.mode === 'replacement') throw new Error('code-mode-bootstrap-unavailable: this runner cannot deliver the Code Mode instructions.');
      return { command: 'x', args: ['a'], cwd: '/', env: {}, providerSessionId: null, warnings: [] };
    };
    const o = await runLaunchGoal(goalOf('refused', launch({}), [{ throws: 'code-mode-bootstrap-unavailable' }]), { planner: refuse });
    expect(o.plan.threw).toBe('code-mode-bootstrap-unavailable');
    expect(o.classic.threw).toBeNull();
    expect(judgeLaunchGoal(goalOf('refused', launch({}), [{ throws: 'code-mode-bootstrap-unavailable' }]), o).every((v) => v.pass)).toBe(true);
    expect(codeOf(new Error('code-mode-bootstrap-unavailable: x'))).toBe('code-mode-bootstrap-unavailable');
    expect(codeOf(new Error('no code here'))).toBe('no code here');
  }, T);

  it('goals run one after another: a second run while one is going is refused by name, the first finishes, and the flag is released after a failure', async () => {
    const g = goalOf('busy', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]);
    const [a, b] = await Promise.allSettled([runLaunchGoal(g), runLaunchGoal(g)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(String((b as PromiseRejectedResult).reason)).toMatch(/runLaunchGoal is busy/);
    await expect(runLaunchGoal(goalOf('recipe', launch({ recipe: 'builtin:x' }), [{ argv: { equalsClassicOutsideLayer: true } }]))).rejects.toThrow(LaunchSetupError);
    await expect(runLaunchGoal(g)).resolves.toBeDefined();
  }, T);

  it('PARLEY_HOME has one claim for both: a launch goal inside withHome is refused by name, and withHome inside a launch goal is too', async () => {
    const g = goalOf('shared', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]);
    await expect(withHome('/a', async () => runLaunchGoal(g))).rejects.toThrow(/runLaunchGoal is busy: withHome holds PARLEY_HOME/);
    const planner: typeof import('../packages/core/src/work/launch.js').planLaunch = async () => { await withHome('/b', async () => 1); throw new Error('unreachable'); };
    // a planner that throws is a refused launch, recorded on the view (not a failed run): the busy message is what it recorded
    const inside = await runLaunchGoal(g, { planner });
    expect(inside.plan.threw).toMatch(/withHome is busy: runLaunchGoal holds PARLEY_HOME/);
    await expect(runLaunchGoal(g)).resolves.toBeDefined();
  }, T);

  it('the order of the two plans does not matter: planned first then classic gives the same judged views', async () => {
    for (const over of [{}, { provider: 'claude', profile: 'full', skills: { catalogue: 'none', entries: [] } }, { role: { customPrompt: 'First call get_map directly.' } }]) {
      const g = goalOf('order', launch(over), [{ argv: { equalsClassicOutsideLayer: true } }]);
      const a = await runLaunchGoal(g);
      const b = await runLaunchGoal(g, { order: 'planned-first' });
      expect(b).toEqual(a);
    }
  }, T);

  it('leaves the process as it found it: the environment and the skill seams', async () => {
    const { codexSkillRoute, claudeSkillRoute } = await import('../packages/core/src/work/skill-reduction.js');
    claudeSkillRoute.catalogReady = true;
    const scratch = () => readdirSync(tmpdir()).filter((n) => n.startsWith('parley-replay-launch-')).sort();
    const left = scratch();
    const before = { catalog: codexSkillRoute.catalog, ready: claudeSkillRoute.catalogReady, home: process.env['PARLEY_HOME'], nav: process.env['PARLEY_SKILL_NAVIGATOR'] };
    expect(before.ready).toBe(true);
    await runLaunchGoal(goalOf('plain', launch({}), [{ argv: { equalsClassicOutsideLayer: true } }]));
    await expect(runLaunchGoal(goalOf('recipe', launch({ recipe: 'builtin:x' }), [{ argv: { equalsClassicOutsideLayer: true } }]))).rejects.toThrow();
    expect({ catalog: codexSkillRoute.catalog, ready: claudeSkillRoute.catalogReady, home: process.env['PARLEY_HOME'], nav: process.env['PARLEY_SKILL_NAVIGATOR'] }).toEqual(before);
    expect(scratch()).toEqual(left);
  }, T);
});

const GOALS = process.env['PARLEY_REPLAY_GOALS'];
describe.skipIf(GOALS === undefined)('the frozen launch goals, judged for real', () => {
  const file = checkGoalFile(JSON.parse(readFileSync(GOALS ?? '/dev/null', 'utf8') || '{}'));
  const goals = file.ok ? file.goals.filter((g) => g.kind === 'launch') : [];
  it('the file has the eight launch goals', () => { expect(goals.map((g) => g.id).length).toBe(8); });
  // A criterion that fails here is a repair task for the goal or the product, never a patch in this harness: the run must complete and judge every criterion.
  it.each(goals.map((g) => [g.id, g] as const))('%s: runs through the real planning and every criterion gets a verdict', async (_id, goal) => {
    const verdicts = judgeLaunchGoal(goal, await runLaunchGoal(goal));
    expect(verdicts.length).toBe(goal.criteria.length);
    expect(verdicts.every((v) => v.detail !== '')).toBe(true);
  }, T);
});
