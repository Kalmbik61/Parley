// Code Mode instruction routing (plan T8a): the neutral operation-name convention, rendered by launch state. Pure functions here;
// the launch, the manifest and the rendered-text audit are in launch.test.ts and code-mode-routing-manifest.test.ts.
import { describe, expect, it } from 'vitest';
import { MIGRATION_REGISTRY } from '../mcp/code-mode/migration-registry.js';
import { CODEX_TOOL_EXAMPLES } from './guidance.js';
import { BUILTIN_RECIPES } from '../recipes/builtin.js';
import { mapLetterTx } from './letter-store.js';
import { addSession } from './map.js';
import { recipeLeadBlock, reconcileRecipeLeads } from './recipe-lead.js';
import { addRoom } from './rooms.js';
import { HUMAN, type WorkMap } from './types.js';
import { BUILTIN_ROLES } from '../roles/builtin.js';
import { originalToolNames } from '../mcp/tools.js';
import { contextBytes } from './context-budget.js';
import type { SkillCatalog } from '../skills/catalog.js';
import type { NativeSkill } from '../skills/types.js';
import { MINIMAL_DEVELOPMENT_SKILL_MD } from './minimal-development.js';
import { PARLEY_BROWSER_SKILL_MD } from './parley-browser-skill.js';
import { RESEARCH_SWARM_SKILL_MD } from './research-swarm-skill.js';
import { SKILL_MD } from './skill.js';
import { GUIDE_TOPICS, guide, guideTopic } from './guide.js';
import {
  CLASSIC_ROUTING,
  GUIDE_OPERATIONS,
  PARLEY_OWNED_SKILLS,
  RECIPE_OPERATION_REFS,
  ROLE_OPERATION_REFS,
  TERMINAL_OPERATIONS,
  WRAPPER_NAMES,
  bootstrapText,
  heldRunRouting,
  codexToolExamples,
  fixtureRouting,
  guideOperations,
  guideRouting,
  recipeCompatibility,
  recipeRoutingNote,
  replacementRouting,
  roleCompatibility,
  roleRoutingNote,
  routeOf,
  selectsClassic,
  skillCompatibility,
  type CodeModeRouting,
} from './code-mode-instructions.js';

const BOOT_BYTES = 683;
const UNIVERSE = ['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room', 'report', 'send_message', 'check_inbox', 'wait_for', 'remember'];
const SHIPPED = replacementRouting(MIGRATION_REGISTRY);

describe('routing values', () => {
  it('classic is the absent value; the shipped replacement routing migrates nothing and says where it came from', () => {
    expect(CLASSIC_ROUTING).toEqual({ mode: 'classic' });
    expect(SHIPPED).toEqual({ mode: 'replacement', migrated: [], source: 'registry' });
    expect(Object.isFrozen(SHIPPED) && Object.isFrozen(SHIPPED.mode === 'replacement' ? SHIPPED.migrated : [])).toBe(true);
  });

  it('a fixture route is labelled fixture, sorted and de-duplicated', () => {
    const r = fixtureRouting(['read_room', 'get_map', 'get_map']);
    expect(r).toEqual({ mode: 'replacement', migrated: ['get_map', 'read_room'], source: 'fixture' });
  });

  it('a registry that proves a method gives a registry route; an invalid registry is refused', () => {
    const proven = { ...MIGRATION_REGISTRY, proven: ['get_map'] };
    expect(replacementRouting(proven)).toEqual({ mode: 'replacement', migrated: ['get_map'], source: 'registry' });
    expect(() => replacementRouting({ ...MIGRATION_REGISTRY, proven: ['report'] })).toThrow(/code mode routing/);
    expect(() => replacementRouting({ ...MIGRATION_REGISTRY, proven: ['get_map', 'get_map'] })).toThrow(/code mode routing/);
  });

  it('proven may be any migratable read of the registry (T11 B0), never a read it does not allow nor a write it lists', () => {
    const six = { ...MIGRATION_REGISTRY, migratable: [...MIGRATION_REGISTRY.migratable, 'memory_read'] };
    expect(replacementRouting({ ...six, proven: ['memory_read', 'get_map'] })).toEqual({ mode: 'replacement', migrated: ['get_map', 'memory_read'], source: 'registry' });
    expect(() => replacementRouting({ ...MIGRATION_REGISTRY, proven: ['memory_read'] })).toThrow(/code mode routing/);
    expect(() => replacementRouting({ ...MIGRATION_REGISTRY, migratable: [...MIGRATION_REGISTRY.migratable, 'send_message'], proven: ['send_message'] })).toThrow(/code mode routing/);
  });

  it('the shipped routing is unchanged while PROVEN is empty: replacement with nothing migrated', () => {
    expect(replacementRouting()).toEqual({ mode: 'replacement', migrated: [], source: 'registry' });
  });
});

describe('routeOf: a name resolves through this launch (retained direct, migrated, or unavailable)', () => {
  const without = (name: string): string[] => UNIVERSE.filter((n) => n !== name);
  it.each([
    ['classic: a listed name is direct', 'get_map', UNIVERSE, CLASSIC_ROUTING, 'direct'],
    ['classic: a name outside the universe is unavailable', 'browser_open', UNIVERSE, CLASSIC_ROUTING, 'unavailable'],
    ['shipped replacement: nothing is migrated, a listed name is direct', 'get_map', UNIVERSE, SHIPPED, 'direct'],
    ['shipped replacement: a name outside the universe is unavailable', 'browser_open', UNIVERSE, SHIPPED, 'unavailable'],
    ['fixture: a migrated name is migrated', 'get_map', UNIVERSE, fixtureRouting(['get_map']), 'migrated'],
    ['fixture: another listed name stays direct', 'report', UNIVERSE, fixtureRouting(['get_map']), 'direct'],
    ['fixture: a migrated name this launch does not list is unavailable', 'read_room', without('read_room'), fixtureRouting(['read_room']), 'unavailable'],
  ] as const)('%s', (_label, name, universe, routing, route) => {
    expect(routeOf(name, universe, routing)).toBe(route);
  });

  it('a name hidden by the short profile is unavailable in every mode', () => {
    const short = UNIVERSE.filter((n) => n !== 'remember');
    for (const routing of [CLASSIC_ROUTING, SHIPPED, fixtureRouting(['get_map'])]) expect(routeOf('remember', short, routing)).toBe('unavailable');
  });

  it('the wrapper names are not part of the original universe: they resolve only where the replacement lists them', () => {
    for (const name of WRAPPER_NAMES) {
      expect(routeOf(name, UNIVERSE, CLASSIC_ROUTING)).toBe('unavailable');
      expect(routeOf(name, UNIVERSE, SHIPPED)).toBe('unavailable');
      expect(routeOf(name, [...UNIVERSE, ...WRAPPER_NAMES], SHIPPED)).toBe('direct');
    }
  });
});

describe('bootstrapText: the convention, keyed on what this launch migrated', () => {
  it('a classic launch held by an earlier run gets its one line, with no wrapper and no operation name; plain classic stays empty', () => {
    const dead = bootstrapText(heldRunRouting('unaccounted'));
    const live = bootstrapText(heldRunRouting('may-be-finishing'));
    expect(dead).toContain('was not accounted for: do not assume its reads happened');
    expect(live).toContain('may still be finishing');
    for (const text of [dead, live]) expect(text).not.toMatch(/code_execute|code_search|code_docs|get_map|read_room/);
    expect(bootstrapText(CLASSIC_ROUTING)).toBe('');
  });
  it('held routing is classic to every route: a direct tool stays direct', () => {
    expect(routeOf('get_map', ['get_map'], heldRunRouting('unaccounted'))).toBe('direct');
    expect(codexToolExamples(heldRunRouting('unaccounted'))).toBe(codexToolExamples(CLASSIC_ROUTING));
  });
  const SHIPPED_TEXT =
    "Parley operation names in authoritative Parley instructions (get_map, report, send_message and the like) name operations, not unconditional direct tools. Resolve each through this launch's route: nothing is migrated in this launch: call every operation directly. A name that is neither migrated, nor routed by your Parley tools' descriptions, nor offered by your client (listed or loadable on demand) is unavailable here: say so, never guess a call and never bypass a permission. code_search finds methods; code_docs can describe a method this launch does not run: only the migrated ones go through code_execute. The rules below for report, close, mail, wait and rooms are unchanged.";

  it('classic has none', () => {
    expect(bootstrapText(CLASSIC_ROUTING)).toBe('');
  });

  it('the shipped replacement text is exactly this and routes nothing into code_execute', () => {
    const text = bootstrapText(SHIPPED);
    expect(text).toBe(SHIPPED_TEXT);
    expect(Buffer.byteLength(text, 'utf8')).toBe(BOOT_BYTES);
    expect(text).not.toContain('parley.<name>');
    expect(text).toContain('nothing is migrated in this launch: call every operation directly');
  });

  it('a migrated name goes through code_execute and every other Parley tool stays direct; the list is sorted', () => {
    const one = bootstrapText(fixtureRouting(['get_map']));
    expect(one).toContain('only get_map is migrated: call it as parley.<name>(args) inside code_execute (code_docs gives the declaration and the apiRevision), and call every other Parley tool directly.');
    expect(one).not.toContain('nothing is migrated');
    const many = bootstrapText(fixtureRouting(['read_room', 'backlog_list', 'get_map']));
    expect(many).toContain('only backlog_list, get_map, read_room are migrated: call them as parley.<name>(args) inside code_execute');
  });

  it('the convention comes first and the rest of the guidance is declared unchanged; the text is fixed per route', () => {
    for (const routing of [SHIPPED, fixtureRouting(['get_map'])]) {
      const text = bootstrapText(routing);
      expect(text.startsWith('Parley operation names in authoritative Parley instructions')).toBe(true);
      expect(text.endsWith('The rules below for report, close, mail, wait and rooms are unchanged.')).toBe(true);
      expect(text.split('\n')).toHaveLength(1);
      expect(bootstrapText(routing)).toBe(text);
    }
  });

  it('it names code_search once, for discovery, in every replacement route', () => {
    for (const routing of [SHIPPED, fixtureRouting(['get_map']), fixtureRouting(['get_map', 'read_room', 'report'])]) {
      const text = bootstrapText(routing);
      expect(text.split('code_search')).toHaveLength(2);
      expect(text).toContain('code_search finds methods; code_docs can describe');
    }
    expect(bootstrapText(CLASSIC_ROUTING)).not.toContain('code_search');
    expect(bootstrapText(heldRunRouting('unaccounted'))).not.toContain('code_search');
  });

  it('it does not name a wrapper as a place to call a method outside the migrated set (documented is not executable)', () => {
    const text = bootstrapText(fixtureRouting(['get_map']));
    expect(text).toContain('code_docs can describe a method this launch does not run: only the migrated ones go through code_execute.');
  });
});

describe('codexToolExamples: classic bytes unless a name is migrated', () => {
  it('classic and the shipped replacement are the constant, byte for byte', () => {
    expect(codexToolExamples(CLASSIC_ROUTING)).toBe(CODEX_TOOL_EXAMPLES);
    expect(codexToolExamples(SHIPPED)).toBe(CODEX_TOOL_EXAMPLES);
  });

  it('a migrated get_map is shown inside code_execute; the other examples are the classic lines', () => {
    const text = codexToolExamples(fixtureRouting(['get_map']));
    const classic = CODEX_TOOL_EXAMPLES.split('\n');
    const lines = text.split('\n');
    expect(lines.filter((line) => line.includes('tools.mcp__parley__get_map'))).toEqual([]);
    expect(text).toContain("code_execute({ code: 'return await parley.get_map({})', apiRevision })");
    expect(text).toContain('apiRevision comes from code_docs');
    for (const keep of classic.filter((line) => /send_message|check_inbox|wait_for|report/.test(line))) expect(lines).toContain(keep);
    expect(lines[0]).toBe(classic[0]);
    expect(lines.at(-1)).toBe(classic.at(-1));
  });

  it('a name with no example row changes nothing', () => {
    expect(codexToolExamples(fixtureRouting(['read_room']))).toBe(CODEX_TOOL_EXAMPLES);
  });

  it('zero-residual fixture: every example is a code_execute form and none is direct', () => {
    const text = codexToolExamples(fixtureRouting(['get_map', 'send_message', 'check_inbox', 'wait_for', 'report']));
    expect(text).not.toMatch(/tools\.mcp__parley__(get_map|send_message|check_inbox|wait_for|report)\(/);
    for (const name of ['get_map', 'send_message', 'check_inbox', 'wait_for', 'report']) expect(text).toContain(`parley.${name}(`);
    expect(text.split('\n').at(-1)).toBe(CODEX_TOOL_EXAMPLES.split('\n').at(-1));
  });
});

// ----- read_guide routing (plan T8b) -----
const REGISTRY_NAMES = MIGRATION_REGISTRY.entries.map((e) => e.name);
const namesInText = (text: string): string[] =>
  [...new Set([...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])(${REGISTRY_NAMES.join('|')})(?![A-Za-z0-9_])`, 'g'))].map((m) => m[1]!))].sort();
const VARIANTS = [
  ['default', {}],
  ['short profile', { toolProfile: 'short' as const }],
  ['navigator', { skillNavigator: true }],
  ['short profile and navigator', { toolProfile: 'short' as const, skillNavigator: true }],
] as const;

describe('GUIDE_OPERATIONS is the names the raw guide really mentions', () => {
  it('has exactly the 13 topics of the guide', () => {
    expect(Object.keys(GUIDE_OPERATIONS)).toEqual(GUIDE_TOPICS.map((t) => t.topic));
  });

  it.each(VARIANTS)('every topic and the whole guide, %s: the table (with its two documented adjustments) equals a scan of the text', (_label, options) => {
    for (const { topic } of GUIDE_TOPICS) expect(guideOperations(topic, options), topic).toEqual(namesInText(guideTopic(topic, options)!));
    expect(guideOperations(null, options)).toEqual(namesInText(guide(options)));
  });

  it('the terminal operations are four registry names', () => {
    expect([...TERMINAL_OPERATIONS]).toEqual(['check_inbox', 'report', 'send_message', 'wait_for']);
    for (const name of TERMINAL_OPERATIONS) expect(REGISTRY_NAMES).toContain(name);
  });
});

describe('guideRouting: the routing block for one guide answer', () => {
  const FULL = REGISTRY_NAMES;
  const SHIPPED_ROUTE = replacementRouting(MIGRATION_REGISTRY);
  const FIXTURE = fixtureRouting(['get_map', 'read_room']);
  const ZERO = fixtureRouting(['get_map', 'send_message', 'check_inbox', 'wait_for', 'report']);

  it('is empty for classic, for every topic and the whole guide', () => {
    for (const topic of [null, ...GUIDE_TOPICS.map((t) => t.topic)]) expect(guideRouting(CLASSIC_ROUTING, FULL, topic)).toBe('');
  });

  it('the shipped registry migrates nothing: every named operation is a listed tool and no wrapper is named', () => {
    const block = guideRouting(SHIPPED_ROUTE, FULL, 'member');
    expect(block).toContain('- nothing is migrated: call every operation as a tool of the parley server.');
    expect(block).toContain('- tools of the parley server: add_to_room, check_inbox, get_map, read_room, report, send_message, wait_for.');
    expect(block).not.toContain('unavailable');
    // the only line that names a wrapper is the fixed terminal rule ("never inside code_execute")
    const rest = block.split('\n').filter((line) => !line.includes('top-level')).join('\n');
    for (const wrapper of WRAPPER_NAMES) expect(rest).not.toContain(wrapper);
  });

  it('a fixture route sends its names through code_execute and leaves the others direct', () => {
    const block = guideRouting(FIXTURE, FULL, 'member');
    expect(block).toContain('- migrated: get_map, read_room (call as parley.<name>(args) inside code_execute; read code_docs first).');
    expect(block).toContain('- direct tools: add_to_room, check_inbox, report, send_message, wait_for.');
    expect(block).not.toContain('nothing is migrated');
  });

  it('terminal operations are never migrated: not by a fixture route, not by the zero-residual fixture', () => {
    for (const routing of [FIXTURE, ZERO]) {
      for (const topic of [null, ...GUIDE_TOPICS.map((t) => t.topic)]) {
        const block = guideRouting(routing, FULL, topic);
        const migrated = /^- migrated: ([^(]*) \(/m.exec(block)?.[1]?.split(', ') ?? [];
        for (const name of TERMINAL_OPERATIONS) expect(migrated, `${topic}: ${name}`).not.toContain(name);
      }
    }
    const lead = guideRouting(ZERO, FULL, 'lead');
    expect(lead).toContain('- report, wait_for, check_inbox and send_message are always top-level tool calls, never inside code_execute.');
    expect(guideRouting(ZERO, FULL, 'brief')).not.toContain('top-level');
  });

  it('names outside the launch list are labelled unavailable and never listed as callable', () => {
    const noAgent = FULL.filter((n) => !['create_session', 'request_agent_switch'].includes(n));
    const block = guideRouting(SHIPPED_ROUTE, noAgent, 'stuck');
    expect(block).toContain('- unavailable in this launch: create_session, request_agent_switch (say so; never guess a call).');
    expect(block).not.toMatch(/tools of the parley server:[^\n]*create_session/);
    const short = FULL.filter((n) => !['remember', 'memory_read', 'search_history'].includes(n));
    expect(guideRouting(SHIPPED_ROUTE, short, 'tools', { toolProfile: 'short' })).not.toMatch(/remember|memory_read|search_history/);
    expect(guideRouting(SHIPPED_ROUTE, short, 'tools')).toContain('unavailable in this launch: memory_read, remember, search_history');
  });

  it('a registry that proves a method changes the block and nothing else about the answer', () => {
    const proven = replacementRouting({ ...MIGRATION_REGISTRY, proven: ['get_map'] });
    expect(guideRouting(proven, FULL, 'overview')).toContain('- migrated: get_map (call as');
    expect(guideRouting(SHIPPED_ROUTE, FULL, 'overview')).not.toContain('migrated: get_map');
  });

  it('a topic with no operation still gets the block, with no terminal line', () => {
    const block = guideRouting(SHIPPED_ROUTE, FULL, 'window');
    expect(block).toBe('Routing for the operations this guide names, in THIS launch:\n- nothing is migrated: call every operation as a tool of the parley server.');
  });

  it('stays within its size budget: 600 bytes a topic, 1.2 KB the whole guide, for the widest case', () => {
    for (const routing of [SHIPPED_ROUTE, FIXTURE, ZERO]) {
      const none: string[] = [];
      for (const universe of [FULL, none]) {
        for (const topic of GUIDE_TOPICS.map((t) => t.topic)) expect(contextBytes(guideRouting(routing, universe, topic)), topic).toBeLessThanOrEqual(600);
        expect(contextBytes(guideRouting(routing, universe, null))).toBeLessThanOrEqual(1200);
      }
    }
  });

  it('is deterministic and sorted', () => {
    const block = guideRouting(FIXTURE, FULL, null);
    expect(guideRouting(FIXTURE, FULL, null)).toBe(block);
    for (const line of block.split('\n').filter((l) => l.startsWith('- ') && l.includes(': '))) {
      const list = line.slice(line.indexOf(': ') + 2).replace(/ \(.*\)\.?$/, '').replace(/\.$/, '').split(', ');
      if (list.every((n) => REGISTRY_NAMES.includes(n))) expect(list).toEqual([...list].sort());
    }
  });
});

// ----- role and recipe routing (plan T8c) -----
describe('the role and recipe operation tables are the names the shipped texts really mention', () => {
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();

  it('one entry per builtin role, and its instruction and label names equal a scan of its prompt and description', () => {
    expect(Object.keys(ROLE_OPERATION_REFS)).toEqual(BUILTIN_ROLES.map((r) => r.id));
    for (const role of BUILTIN_ROLES) {
      const refs = ROLE_OPERATION_REFS[role.id]!;
      expect(sorted([...refs.instruction, ...refs.label]), role.id).toEqual(namesInText(`${role.prompt}\n${role.description}`));
    }
  });

  it('feature-lead has the one actionable name (create_session); every other mention in a role is the noun "report"', () => {
    expect(ROLE_OPERATION_REFS['builtin:feature-lead']).toEqual({ instruction: ['create_session'], label: ['report'] });
    for (const role of BUILTIN_ROLES.filter((r) => r.id !== 'builtin:feature-lead')) expect(ROLE_OPERATION_REFS[role.id], role.id).toEqual({ instruction: [], label: ['report'] });
  });

  it('one entry per builtin recipe; find_skill, backlog_suggest and propose_completion are its instruction names', () => {
    expect(Object.keys(RECIPE_OPERATION_REFS)).toEqual(BUILTIN_RECIPES.map((r) => r.id));
    for (const recipe of BUILTIN_RECIPES) {
      const refs = RECIPE_OPERATION_REFS[recipe.id]!;
      expect(sorted([...refs.instruction, ...refs.label]), recipe.id).toEqual(namesInText(recipe.playbook));
      expect(refs.label, recipe.id).toEqual([]);
    }
  });

  it('the minimal-development skill mentions only the noun "report": a label, never actionable', () => {
    expect(namesInText(MINIMAL_DEVELOPMENT_SKILL_MD)).toEqual(['report']);
  });
});

describe('roleRoutingNote and recipeRoutingNote: appended only when an instruction name is not simply a tool', () => {
  const FULL = REGISTRY_NAMES;
  const NO_AGENT = FULL.filter((n) => !['create_session', 'request_agent_switch'].includes(n));
  const SHIPPED_ROUTE = replacementRouting(MIGRATION_REGISTRY);

  it('is empty for classic whatever the universe', () => {
    for (const universe of [FULL, NO_AGENT, []]) {
      expect(roleRoutingNote('builtin:feature-lead', CLASSIC_ROUTING, universe)).toBe('');
      expect(recipeRoutingNote('builtin:plan-build', CLASSIC_ROUTING, universe)).toBe('');
    }
  });

  it('is empty when every instruction name is a listed tool (the shipped registry migrates nothing)', () => {
    for (const role of BUILTIN_ROLES) expect(roleRoutingNote(role.id, SHIPPED_ROUTE, FULL), role.id).toBe('');
    for (const recipe of BUILTIN_RECIPES) expect(recipeRoutingNote(recipe.id, SHIPPED_ROUTE, FULL.filter(Boolean)), recipe.id).toBe('');
  });

  it('a launch without an agent channel is told create_session is not available, in one appended sentence', () => {
    expect(roleRoutingNote('builtin:feature-lead', SHIPPED_ROUTE, NO_AGENT)).toBe('Routing for this launch: create_session is not available here; say so instead of calling it.');
    for (const role of BUILTIN_ROLES.filter((r) => r.id !== 'builtin:feature-lead')) expect(roleRoutingNote(role.id, SHIPPED_ROUTE, NO_AGENT), role.id).toBe('');
  });

  it('a migrated instruction name is called through code_execute; labels never produce a note', () => {
    expect(roleRoutingNote('builtin:feature-lead', fixtureRouting(['create_session']), FULL)).toBe('Routing for this launch: create_session is called as parley.create_session(args) inside code_execute (read code_docs first).');
    expect(roleRoutingNote('builtin:planner', fixtureRouting(['report']), FULL)).toBe('');
  });

  it('recipes: find_skill is unavailable when the navigator is off, and says so for the lead playbook', () => {
    const noNavigator = FULL.filter((n) => n !== 'find_skill');
    expect(recipeRoutingNote('builtin:debug', SHIPPED_ROUTE, noNavigator)).toBe('Routing for this launch: find_skill is not available here; say so instead of calling it.');
    expect(recipeRoutingNote('builtin:plan-build', SHIPPED_ROUTE, noNavigator)).toBe('Routing for this launch: find_skill is not available here; say so instead of calling it.');
    expect(recipeRoutingNote('builtin:review', SHIPPED_ROUTE, FULL.filter((n) => !['find_skill', 'backlog_suggest'].includes(n)))).toBe('Routing for this launch: backlog_suggest, find_skill are not available here; say so instead of calling them.');
  });

  it('an unknown id has no note (a custom text is judged by compatibility, never annotated)', () => {
    expect(roleRoutingNote('codex:custom', SHIPPED_ROUTE, NO_AGENT)).toBe('');
    expect(recipeRoutingNote('project:long', SHIPPED_ROUTE, NO_AGENT)).toBe('');
  });
});

describe('roleCompatibility and recipeCompatibility: a verdict, never a denial', () => {
  const FULL = REGISTRY_NAMES;
  const NO_AGENT = FULL.filter((n) => !['create_session', 'request_agent_switch'].includes(n));
  const SHIPPED_ROUTE = replacementRouting(MIGRATION_REGISTRY);
  const FIXTURE = fixtureRouting(['get_map']);

  it('classic has nothing to check', () => {
    expect(roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'call get_map' }, CLASSIC_ROUTING, FULL)).toEqual({ status: 'compatible', names: [], conservative: false });
  });

  it('a builtin role is compatible: its note covers the only name that could be unavailable', () => {
    expect(roleCompatibility({ source: 'builtin', id: 'builtin:feature-lead' }, SHIPPED_ROUTE, NO_AGENT)).toEqual({ status: 'compatible', names: ['create_session'], conservative: false });
    expect(roleCompatibility({ source: 'builtin', id: 'builtin:planner' }, FIXTURE, FULL)).toEqual({ status: 'compatible', names: [], conservative: false });
    expect(roleCompatibility({ source: 'builtin', id: 'builtin:not-shipped' }, SHIPPED_ROUTE, FULL)).toEqual({ status: 'unverified', names: [], conservative: false });
  });

  it('a native Claude agent body is unreadable: unverified, never compatible', () => {
    expect(roleCompatibility({ source: 'claude', id: 'claude:native' }, SHIPPED_ROUTE, FULL)).toEqual({ status: 'unverified', names: [], conservative: false });
    expect(roleCompatibility({ source: 'codex', id: 'codex:empty' }, SHIPPED_ROUTE, FULL)).toEqual({ status: 'unverified', names: [], conservative: false });
  });

  it('custom text with a name that is migrated or unavailable is incompatible, conservatively; labels and direct names are fine', () => {
    expect(roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'First call get_map, then report.' }, FIXTURE, FULL)).toEqual({ status: 'incompatible', names: ['get_map'], conservative: true });
    expect(roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'Use create_session when needed.' }, SHIPPED_ROUTE, NO_AGENT)).toEqual({ status: 'incompatible', names: ['create_session'], conservative: true });
    expect(roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'Use create_session when needed; give a report.' }, SHIPPED_ROUTE, FULL)).toEqual({ status: 'compatible', names: [], conservative: false });
    expect(roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'No tools named here.' }, FIXTURE, FULL)).toEqual({ status: 'compatible', names: [], conservative: false });
  });

  it('a name called in its mcp__parley__ form is a mention; only that prefix widens the match', () => {
    const verdict = (prompt: string) => roleCompatibility({ source: 'codex', id: 'codex:x', prompt }, FIXTURE, FULL);
    const found = { status: 'incompatible', names: ['get_map'], conservative: true };
    const clean = { status: 'compatible', names: [], conservative: false };
    for (const prompt of ['Call mcp__parley__get_map first.', 'mcp__parley__get_map', '(mcp__parley__get_map)', 'Use parley.get_map here.', 'Use get_map here.', 'tools.mcp__parley__get_map({})']) expect(verdict(prompt), prompt).toEqual(found);
    for (const prompt of ['xget_map', 'get_mapx', 'mcp__other__get_map', 'mcp__parley__xget_map', 'mcp__parley__get_mapx', 'xmcp__parley__get_map', 'mcp__parley_get_map', 'mcp_parley__get_map', 'mcp__parley____get_map', 'my_mcp__other__get_map', 'GET_MAP', 'MCP__PARLEY__get_map', 'mcp__PARLEY__get_map']) expect(verdict(prompt), prompt).toEqual(clean);
    // the prefixed and the plain form of one name are one mention, and two names stay two
    expect(roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'mcp__parley__get_map then get_map then mcp__parley__read_room' }, fixtureRouting(['get_map', 'read_room']), FULL)).toEqual({ status: 'incompatible', names: ['get_map', 'read_room'], conservative: true });
  });

  it('a recipe playbook: builtin ids use their table, others are scanned', () => {
    expect(recipeCompatibility({ id: 'builtin:debug', playbook: BUILTIN_RECIPES[2]!.playbook }, SHIPPED_ROUTE, FULL.filter((n) => n !== 'find_skill'))).toEqual({ status: 'compatible', names: ['find_skill'], conservative: false });
    expect(recipeCompatibility({ id: 'project:long', playbook: 'Ask for get_map first.' }, FIXTURE, FULL)).toEqual({ status: 'incompatible', names: ['get_map'], conservative: true });
    expect(recipeCompatibility({ id: 'project:long', playbook: 'Plain words.' }, FIXTURE, FULL)).toEqual({ status: 'compatible', names: [], conservative: false });
  });

  it('the verdict is plain data: no field says denied, failed or blocked', () => {
    const verdict = roleCompatibility({ source: 'codex', id: 'codex:x', prompt: 'call get_map' }, FIXTURE, FULL);
    expect(Object.keys(verdict).sort()).toEqual(['conservative', 'names', 'status']);
    expect(['compatible', 'incompatible', 'unverified']).toContain(verdict.status);
  });
});

// ----- skill catalogue routing (plan T8d2) -----
describe('PARLEY_OWNED_SKILLS: the identity of the four shipped stubs, read from their own text', () => {
  const frontmatter = (md: string): { name: string; description: string } => ({
    name: /^name: (.+)$/m.exec(md)![1]!.trim(),
    description: JSON.parse(/^description: (.+)$/m.exec(md)![1]!) as string,
  });

  it('is the (name, description) pair in the frontmatter of SKILL_MD and the three other shipped skills', () => {
    expect(PARLEY_OWNED_SKILLS).toEqual([SKILL_MD, PARLEY_BROWSER_SKILL_MD, RESEARCH_SWARM_SKILL_MD, MINIMAL_DEVELOPMENT_SKILL_MD].map(frontmatter));
    expect(PARLEY_OWNED_SKILLS.map((s) => s.name)).toEqual(['parley', 'parley-browser', 'research-swarm', 'minimal-development']);
  });

  it('the stub descriptions do name operations, which is why they must be excluded by identity and not scanned', () => {
    for (const stub of PARLEY_OWNED_SKILLS.filter((s) => s.name !== 'minimal-development')) expect(namesInText(stub.description).length, stub.name).toBeGreaterThan(0);
  });
});

describe('skillCompatibility: a verdict about the native catalogue, never a denial', () => {
  const FULL = REGISTRY_NAMES;
  const SHIPPED_ROUTE = replacementRouting(MIGRATION_REGISTRY);
  const FIXTURE = fixtureRouting(['get_map']);
  const skill = (name: string, description: string, extra: Partial<NativeSkill> = {}): NativeSkill => ({
    provider: 'codex', documentKind: 'skill', name, description, source: 'user', path: `/fixture/${name}/SKILL.md`, modelAvailable: true, unavailableReason: null, ...extra,
  });
  const catalog = (skills: NativeSkill[], extra: Partial<SkillCatalog> = {}): SkillCatalog => ({ provider: 'codex', skills, diagnostics: [], partial: false, ...extra });
  const COMPATIBLE = { status: 'compatible', skills: [], conservative: false };

  it('classic has nothing to check, with or without a catalogue', () => {
    expect(skillCompatibility(catalog([skill('x', 'call get_map')]), CLASSIC_ROUTING, FULL)).toEqual(COMPATIBLE);
    expect(skillCompatibility(null, CLASSIC_ROUTING, FULL)).toEqual(COMPATIBLE);
  });

  it('no catalogue (Claude at launch, an unread Codex list, unavailable provider evidence) is unverified, never compatible', () => {
    expect(skillCompatibility(null, SHIPPED_ROUTE, FULL)).toEqual({ status: 'unverified', skills: [], conservative: false });
  });

  it('with the shipped registry nothing is migrated: a skill naming operations is compatible', () => {
    expect(skillCompatibility(catalog([skill('helper', 'Use get_map and report.')]), SHIPPED_ROUTE, FULL)).toEqual(COMPATIBLE);
  });

  it('a skill whose description names a migrated operation is incompatible, listed by name and source, conservatively', () => {
    expect(skillCompatibility(catalog([skill('helper', 'First call get_map, then report.')]), FIXTURE, FULL)).toEqual({
      status: 'incompatible', skills: [{ name: 'helper', source: 'user', names: ['get_map'] }], conservative: true,
    });
  });

  it('an operation absent from the launch universe counts the same way', () => {
    const noAgent = FULL.filter((n) => n !== 'create_session');
    expect(skillCompatibility(catalog([skill('maker', 'Use create_session to add a peer.')]), SHIPPED_ROUTE, noAgent).status).toBe('incompatible');
  });

  it('only the description is read: a skill NAMED like an operation, or a body, is not a signal', () => {
    expect(skillCompatibility(catalog([skill('get_map', 'A helper with a telling name.')]), FIXTURE, FULL)).toEqual(COMPATIBLE);
    expect(skillCompatibility(catalog([skill('report', 'Write the weekly summary.')]), fixtureRouting(['report']), FULL)).toEqual(COMPATIBLE);
  });

  it('same-name documents are judged one by one: the one naming the operation is listed with its source, the other is not', () => {
    const verdict = skillCompatibility(catalog([skill('review', 'Plain review.', { source: 'project' }), skill('review', 'Ask get_map first.', { source: 'user' })]), FIXTURE, FULL);
    expect(verdict.skills).toEqual([{ name: 'review', source: 'user', names: ['get_map'] }]);
  });

  it('two same-name documents that BOTH name an operation are both listed, each with its own source', () => {
    const verdict = skillCompatibility(catalog([skill('review', 'Ask get_map first.', { source: 'project' }), skill('review', 'Also get_map.', { source: 'user' })]), FIXTURE, FULL);
    expect(verdict.skills).toEqual([{ name: 'review', source: 'project', names: ['get_map'] }, { name: 'review', source: 'user', names: ['get_map'] }]);
  });

  it('entries the model cannot load are not scanned, an unverified one is (it may be loadable)', () => {
    const named = 'Ask get_map first.';
    expect(skillCompatibility(catalog([skill('a', named, { modelAvailable: false, unavailableReason: 'human-disabled' })]), FIXTURE, FULL)).toEqual(COMPATIBLE);
    expect(skillCompatibility(catalog([skill('b', named, { modelAvailable: false, unavailableReason: 'shadowed' })]), FIXTURE, FULL)).toEqual(COMPATIBLE);
    expect(skillCompatibility(catalog([skill('c', named, { modelAvailable: false, unavailableReason: 'availability-unverified' })]), FIXTURE, FULL).status).toBe('incompatible');
  });

  it('Parley\'s own stubs are excluded by identity: their descriptions name operations and are T8d1\'s', () => {
    const stubs = PARLEY_OWNED_SKILLS.map((s) => skill(s.name, s.description));
    expect(skillCompatibility(catalog(stubs), fixtureRouting(['get_map', 'report', 'create_swarm', 'send_message']), FULL)).toEqual(COMPATIBLE);
  });

  it('a same-name USER document is not a stub: a different description is scanned, an identical one is Parley\'s by definition', () => {
    const stub = PARLEY_OWNED_SKILLS[0]!;
    const imposter = skill(stub.name, 'My own parley notes: call get_map before anything.', { source: 'user' });
    expect(skillCompatibility(catalog([skill(stub.name, stub.description), imposter]), FIXTURE, FULL)).toEqual({
      status: 'incompatible', skills: [{ name: stub.name, source: 'user', names: ['get_map'] }], conservative: true,
    });
    const copy = skill(stub.name, stub.description, { path: '/elsewhere/parley/SKILL.md' });
    expect(skillCompatibility(catalog([copy]), fixtureRouting(['get_map', 'report', 'create_swarm', 'send_message']), FULL)).toEqual(COMPATIBLE);
  });

  it('a partial catalogue or a missing context is unverified, unless a skill is already known to be incompatible', () => {
    expect(skillCompatibility(catalog([skill('ok', 'Plain.')], { partial: true }), FIXTURE, FULL)).toEqual({ status: 'unverified', skills: [], conservative: false });
    expect(skillCompatibility(catalog([], { diagnostics: [{ provider: 'codex', code: 'missing-context', path: '/gone' }], partial: true }), FIXTURE, FULL).status).toBe('unverified');
    expect(skillCompatibility(catalog([skill('bad', 'Ask get_map.')], { partial: true }), FIXTURE, FULL).status).toBe('incompatible');
  });

  it('never changes the catalogue it reads', () => {
    const c = catalog([skill('helper', 'Call get_map.'), skill('plain', 'Nothing.')]);
    const before = JSON.stringify(c);
    skillCompatibility(c, FIXTURE, FULL);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe('selectsClassic: which verdict sends a launch to classic (one pure rule for the launcher)', () => {
  const role = (status: 'compatible' | 'incompatible' | 'unverified', names: string[] = []) => ({ status, names, conservative: status === 'incompatible' });
  const skills = (status: 'compatible' | 'incompatible' | 'unverified', list: { name: string; source: 'user'; names: string[] }[] = []) => ({ status, skills: list, conservative: status === 'incompatible' });

  it('no report (a classic launch) and a fully compatible one stay replacement', () => {
    expect(selectsClassic(undefined)).toEqual({ classic: false, source: null, names: [] });
    expect(selectsClassic({ role: role('compatible', ['create_session']), playbook: role('compatible'), skills: skills('compatible') })).toEqual({ classic: false, source: null, names: [] });
  });

  it('a role or playbook that is incompatible OR unverified selects classic (a native role has no bootstrap route)', () => {
    expect(selectsClassic({ role: role('unverified') })).toEqual({ classic: true, source: 'role', names: [] });
    expect(selectsClassic({ role: role('incompatible', ['get_map']) })).toEqual({ classic: true, source: 'role', names: ['get_map'] });
    expect(selectsClassic({ role: role('compatible'), playbook: role('incompatible', ['find_skill']) })).toEqual({ classic: true, source: 'playbook', names: ['find_skill'] });
  });

  it('skills: only incompatible selects classic; unverified is reported data and a named limit', () => {
    expect(selectsClassic({ role: role('compatible'), skills: skills('unverified') })).toEqual({ classic: false, source: null, names: [] });
    expect(selectsClassic({ role: role('compatible'), skills: skills('incompatible', [{ name: 'helper', source: 'user', names: ['get_map'] }]) })).toEqual({ classic: true, source: 'skills', names: ['get_map'] });
  });

  it('the first source in the order role, playbook, skills is the one named', () => {
    expect(selectsClassic({ role: role('unverified'), skills: skills('incompatible', [{ name: 'h', source: 'user', names: ['get_map'] }]) }).source).toBe('role');
  });
});

// ----- Claude fixture rows that need no server (plan T8e) -----
describe('T8e R1: the Claude launch variants and what is left direct (fixture counts for the pinned variants, not general Claude invariants)', () => {
  const agent = { url: 'http://127.0.0.1:1/agent/browser', token: 't' };
  const VARIANTS = [
    ['full agent', { agent, sessionId: 's-01' }, 49],
    ['short agent', { agent, sessionId: 's-01', toolProfile: 'short' as const }, 46],
    ['full agent, navigator', { agent, sessionId: 's-01', skillNavigator: true }, 50],
    ['full, no agent channel', { sessionId: 's-01' }, 30],
  ] as const;

  it.each(VARIANTS)('%s: the original list has the pinned count; the shipped replacement leaves every name direct, a fixture route removes only what it migrates', (_label, context, count) => {
    const original = originalToolNames(context);
    expect(original).toHaveLength(count);
    for (const name of original) expect(routeOf(name, original, replacementRouting(MIGRATION_REGISTRY)), name).toBe('direct');
    const fixture = fixtureRouting(['get_map', 'read_room']);
    const residual = original.filter((name) => routeOf(name, original, fixture) !== 'migrated');
    expect(residual).toHaveLength(count - 2);
    expect(residual).not.toContain('get_map');
    expect(residual).toContain('report');
  });
});

describe('T8e R7: the later raw playbook letter (reconcileRecipeLeads) stays raw and falls under the launch convention', () => {
  const snapshot = { id: 'builtin:plan-build', name: 'Plan and build', playbook: BUILTIN_RECIPES[0]!.playbook };
  const leadChange = (recipe: { id: string; name: string; playbook: string }): { map: WorkMap; letter: string } => {
    const map = { schemaVersion: 2, work: { id: 'w-0001', title: 't', goal: '', status: 'active', createdAt: '2026-11-09T10:00:00.000Z', updatedAt: '2026-11-09T10:00:00.000Z' }, sessions: [], messages: [], rooms: [] } as unknown as WorkMap;
    for (const label of ['a', 'b']) addSession(map, { provider: 'claude', label, task: 'x' });
    addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01', recipe });
    const sent = reconcileRecipeLeads(map, mapLetterTx(map as never).letters, '2026-11-09T10:01:00.000Z');
    return { map, letter: sent[0]!.text };
  };

  it('the letter is the recipe block byte for byte: no routing note is appended (the convention in the lead\'s own layer covers it)', () => {
    expect(leadChange(snapshot).letter).toBe(recipeLeadBlock(snapshot));
  });

  it('every operation name in the letter takes its concrete route in each mode (not just "some route")', () => {
    const names = namesInText(leadChange(snapshot).letter);
    expect(names).toEqual(['find_skill', 'propose_completion']);
    const full = REGISTRY_NAMES;
    const route = (routing: CodeModeRouting, universe: readonly string[] = full): Record<string, string> => Object.fromEntries(names.map((name) => [name, routeOf(name, universe, routing)]));
    expect(route(CLASSIC_ROUTING)).toEqual({ find_skill: 'direct', propose_completion: 'direct' });
    expect(route(replacementRouting(MIGRATION_REGISTRY))).toEqual({ find_skill: 'direct', propose_completion: 'direct' });
    expect(route(fixtureRouting(['propose_completion']))).toEqual({ find_skill: 'direct', propose_completion: 'migrated' });
    expect(route(fixtureRouting(['find_skill', 'propose_completion']))).toEqual({ find_skill: 'migrated', propose_completion: 'migrated' });
    expect(route(fixtureRouting(['get_map', 'send_message', 'check_inbox', 'wait_for', 'report']))).toEqual({ find_skill: 'direct', propose_completion: 'direct' });
    // a launch without the skill navigator lists no find_skill: the letter names a tool that launch does not have
    expect(route(replacementRouting(MIGRATION_REGISTRY), full.filter((n) => n !== 'find_skill'))).toEqual({ find_skill: 'unavailable', propose_completion: 'direct' });
  });

  it('the bootstrap that precedes the letter in the lead\'s layer is the same convention text for the same launch route', () => {
    const routing = fixtureRouting(['propose_completion']);
    expect(bootstrapText(routing).startsWith('Parley operation names in authoritative Parley instructions')).toBe(true);
    expect(roleRoutingNote('builtin:planner', routing, REGISTRY_NAMES)).toBe('');
    expect(recipeRoutingNote('builtin:plan-build', routing, REGISTRY_NAMES)).toContain('propose_completion is called as parley.propose_completion(args)');
  });

  it('a custom snapshot that names a migrated operation is incompatible for the launcher, the letter itself is still untouched', () => {
    const custom = { id: 'project:long', name: 'Long', playbook: 'Ask for get_map before anything.' };
    const { letter } = leadChange(custom);
    expect(letter).toBe(recipeLeadBlock(custom));
    expect(recipeCompatibility(custom, fixtureRouting(['get_map']), REGISTRY_NAMES)).toEqual({ status: 'incompatible', names: ['get_map'], conservative: true });
  });
});
