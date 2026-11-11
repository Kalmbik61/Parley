// Code Mode instruction routing (plan T8a). One convention for every agent-visible instruction text: a Parley method name such as
// get_map names an OPERATION, and this launch's route says how to run it. Nothing here rewrites an existing text: a launch gets one
// bootstrap paragraph in front of the guidance, and the one generated block that shows call forms (the Codex examples) is rebuilt
// from an explicit table. The classic launch (no routing) renders exactly what it rendered before.
import { MIGRATION_REGISTRY, type MigrationRegistry, migratableReads } from '../mcp/code-mode/migration-registry.js';
import type { SkillCatalog } from '../skills/catalog.js';
import { CODEX_TOOL_EXAMPLES } from './guidance.js';
import { MINIMAL_DEVELOPMENT_SKILL_MD } from './minimal-development.js';
import { PARLEY_BROWSER_SKILL_MD } from './parley-browser-skill.js';
import { RESEARCH_SWARM_SKILL_MD } from './research-swarm-skill.js';
import { SKILL_MD } from './skill.js';

/**
 * How a launch runs the Parley operations. `classic` is the absent value. `replacement` lists the operations that go through
 * `code_execute`; `source` says where that list came from: the shipped registry (proves nothing yet) or a test-built fixture.
 */
export type CodeModeRouting =
  | { readonly mode: 'classic'; readonly held?: HeldRun }
  | { readonly mode: 'replacement'; readonly migrated: readonly string[]; readonly source: 'registry' | 'fixture' };

/** Why a launch that could have been replacement stays classic because of an earlier run (T8h, `selectExposure`). */
export type HeldRun = 'unaccounted' | 'may-be-finishing';

export type Route = 'direct' | 'migrated' | 'unavailable';

export const CLASSIC_ROUTING: CodeModeRouting = Object.freeze({ mode: 'classic' });

/** The three tools of the replacement surface: they exist only in a launch that lists them. */
export const WRAPPER_NAMES: readonly string[] = Object.freeze(['code_search', 'code_docs', 'code_execute']);

const replacement = (migrated: readonly string[], source: 'registry' | 'fixture'): CodeModeRouting =>
  Object.freeze({ mode: 'replacement' as const, migrated: Object.freeze([...migrated]), source });

/** A classic launch because of an earlier run: everything direct, and one line that says what not to assume about that run. */
export function heldRunRouting(held: HeldRun): CodeModeRouting {
  return Object.freeze({ mode: 'classic' as const, held });
}

/** The routing of a replacement launch under a registry: what the registry proves is migrated. An invalid registry is refused. */
export function replacementRouting(registry: MigrationRegistry = MIGRATION_REGISTRY): CodeModeRouting {
  const proven = [...registry.proven];
  const reads = migratableReads(registry);
  if (new Set(proven).size !== proven.length || !proven.every((name) => reads.has(name))) {
    throw new Error('code mode routing: the registry proves a method twice or a method that is not a migratable read.');
  }
  return replacement(proven.sort(), 'registry');
}

/** A test-built route: labelled `fixture` because the shipped registry proves nothing yet. */
export function fixtureRouting(migrated: readonly string[]): CodeModeRouting {
  return replacement([...new Set(migrated)].sort(), 'fixture');
}

/**
 * Where a name goes in this launch: `migrated` goes through `code_execute`, `direct` is a tool in the launch's list,
 * `unavailable` is neither (not listed, or hidden by the tool profile). The universe is what the launch really lists.
 */
export function routeOf(name: string, universe: readonly string[], routing: CodeModeRouting): Route {
  if (!universe.includes(name)) return 'unavailable';
  return routing.mode === 'replacement' && routing.migrated.includes(name) ? 'migrated' : 'direct';
}

const CONVENTION =
  "Parley operation names in authoritative Parley instructions (get_map, report, send_message and the like) name operations, not unconditional direct tools. Resolve each through this launch's route: ";
const RULES =
  " A name that is neither migrated, nor routed by your Parley tools' descriptions, nor offered by your client (listed or loadable on demand) is unavailable here: say so, never guess a call and never bypass a permission. code_search finds methods; code_docs can describe a method this launch does not run: only the migrated ones go through code_execute. The rules below for report, close, mail, wait and rooms are unchanged.";

const HELD_RUN_LINE: Readonly<Record<HeldRun, string>> = Object.freeze({
  unaccounted: 'An earlier scripted run in this session was not accounted for: do not assume its reads happened. Every Parley tool is direct in this launch.',
  'may-be-finishing': 'An earlier scripted run in this session may still be finishing in another process: do not assume its reads happened. Every Parley tool is direct in this launch.',
});

/** The paragraph that goes first in the system layer of a replacement launch; a classic one has none, unless an earlier run held it there. */
export function bootstrapText(routing: CodeModeRouting): string {
  if (routing.mode === 'classic') return routing.held === undefined ? '' : HELD_RUN_LINE[routing.held];
  const names = routing.migrated;
  const route =
    names.length === 0
      ? 'nothing is migrated in this launch: call every operation directly.'
      : `only ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} migrated: call ${names.length === 1 ? 'it' : 'them'} as parley.<name>(args) inside code_execute (code_docs gives the declaration and the apiRevision), and call every other Parley tool directly.`;
  return `${CONVENTION}${route}${RULES}`;
}

// The example rows of CODEX_TOOL_EXAMPLES, one per operation: what stands before and after the call, and the call itself.
const EXAMPLE_ROWS: Readonly<Record<string, { before: string; call: string; after: string }>> = {
  get_map: { before: '  const map = await ', call: 'return await parley.get_map({})', after: '' },
  send_message: { before: '  await ', call: 'return await parley.send_message({ to: "s-02", kind: "question", text: "Which branch do I build on?" })', after: '' },
  check_inbox: { before: '  const inbox = await ', call: 'return await parley.check_inbox({})', after: ' // once per "New messages (N)" pointer' },
  wait_for: { before: '  await ', call: 'return await parley.wait_for({ target: "inbox", timeoutSec: 1500 })', after: ' // returns and marks messages read; on running repeat once' },
  report: { before: '  await ', call: 'return await parley.report({ status: "done", summary: "What was done, what was found, what is left." })', after: '' },
};

const REVISION_LINE = '  // apiRevision comes from code_docs; call it once before the first code_execute.';

/**
 * The Codex call examples for this launch. Classic, the shipped replacement (nothing migrated) and a route with no example row
 * give the constant itself. A migrated operation's row is shown inside `code_execute`; the other rows stay as they were.
 */
export function codexToolExamples(routing: CodeModeRouting): string {
  if (routing.mode === 'classic') return CODEX_TOOL_EXAMPLES;
  const rows = routing.migrated.filter((name) => name in EXAMPLE_ROWS);
  if (rows.length === 0) return CODEX_TOOL_EXAMPLES;
  const lines = CODEX_TOOL_EXAMPLES.split('\n');
  for (const name of rows) {
    const at = lines.findIndex((line) => line.includes(`tools.mcp__parley__${name}(`));
    if (at < 0) throw new Error(`code mode routing: the Codex examples have no row for ${name}.`);
    const row = EXAMPLE_ROWS[name]!;
    lines[at] = `${row.before}tools.mcp__parley__code_execute({ code: '${row.call}', apiRevision });${row.after}`;
  }
  lines.splice(1, 0, REVISION_LINE);
  return lines.join('\n');
}

// ----- read_guide routing (plan T8b) -----
// The guide text stays raw. For a replacement launch the direct read_guide answer gets one routing block IN FRONT of it, built from this
// table: the operation names each topic mentions. A test recomputes the table from the raw text (every topic, whole guide, short profile,
// navigator), so the table cannot drift from the text and nothing here scans prose at run time.

/** Names each guide topic mentions in the default text (full tool profile, no skill navigator). */
export const GUIDE_OPERATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  plans: ['attempt_status', 'attempt_submit', 'attempt_verify', 'get_map', 'plan_progress', 'plan_submit', 'plan_tasks', 'plan_update', 'plan_verify', 'propose_completion', 'propose_decision', 'publish_agent_plan', 'report', 'set_room_mode'],
  overview: ['check_inbox', 'create_session', 'get_map', 'read_room'],
  lifecycle: ['close_session', 'create_session', 'get_map', 'report', 'wait_for'],
  tools: ['add_to_room', 'backlog_list', 'backlog_suggest', 'backlog_take', 'check_inbox', 'create_session', 'get_map', 'list_roles', 'memory_read', 'remember', 'report', 'search_history', 'send_message', 'wait_for'],
  rooms: ['add_to_room', 'check_inbox', 'create_room', 'create_session', 'get_map', 'read_room', 'report', 'send_message'],
  lead: ['add_to_room', 'check_inbox', 'create_session', 'get_capacity', 'get_map', 'propose_decision', 'read_room', 'report', 'send_message', 'wait_for'],
  member: ['add_to_room', 'check_inbox', 'get_map', 'read_room', 'report', 'send_message', 'wait_for'],
  stuck: ['add_to_room', 'create_session', 'get_map', 'request_agent_switch', 'wait_for'],
  brief: [],
  window: [],
  worktrees: [],
  letters: ['check_inbox', 'read_room', 'report', 'wait_for'],
  rules: ['add_to_room', 'check_inbox', 'close_session', 'create_session', 'get_map', 'read_room', 'report'],
});
/** The short tool profile drops the memory paragraph of the `tools` topic. */
const GUIDE_SHORT_REMOVES: Readonly<Record<string, readonly string[]>> = Object.freeze({ tools: ['memory_read', 'remember', 'search_history'] });
/** The skill navigator adds a hint paragraph to two topics. */
const GUIDE_NAVIGATOR_ADDS: Readonly<Record<string, readonly string[]>> = Object.freeze({ tools: ['find_skill'], lead: ['find_skill'] });

/** Operations that end or hand over a turn: always top-level tool calls, whatever the route (plan T8b, lead ruling m-6667). */
export const TERMINAL_OPERATIONS: readonly string[] = Object.freeze(['check_inbox', 'report', 'send_message', 'wait_for']);

export interface GuideRoutingOptions {
  readonly skillNavigator?: boolean;
  readonly toolProfile?: 'short';
}

/** The operation names a guide answer mentions: one topic, or the whole guide (`null`), under the options that shape the text. */
export function guideOperations(topic: string | null, options: GuideRoutingOptions = {}): string[] {
  const topics = topic === null ? Object.keys(GUIDE_OPERATIONS) : [topic];
  const names = new Set<string>();
  for (const t of topics) {
    const removed = options.toolProfile === 'short' ? (GUIDE_SHORT_REMOVES[t] ?? []) : [];
    for (const name of GUIDE_OPERATIONS[t] ?? []) if (!removed.includes(name)) names.add(name);
    if (options.skillNavigator === true) for (const name of GUIDE_NAVIGATOR_ADDS[t] ?? []) names.add(name);
  }
  return [...names].sort();
}

/**
 * The routing block for one guide answer; empty for classic. Every name the answer mentions is listed once under its route in this
 * launch: migrated (through code_execute), direct (a tool in the list) or unavailable. Terminal operations are never migrated.
 */
export function guideRouting(routing: CodeModeRouting, universe: readonly string[], topic: string | null, options: GuideRoutingOptions = {}): string {
  if (routing.mode === 'classic') return '';
  const names = guideOperations(topic, options);
  const route = (name: string): Route => (TERMINAL_OPERATIONS.includes(name) ? (universe.includes(name) ? 'direct' : 'unavailable') : routeOf(name, universe, routing));
  const by = (wanted: Route): string[] => names.filter((name) => route(name) === wanted);
  const migrated = by('migrated');
  const lines = ['Routing for the operations this guide names, in THIS launch:'];
  lines.push(
    migrated.length === 0
      ? '- nothing is migrated: call every operation as a tool of the parley server.'
      : `- migrated: ${migrated.join(', ')} (call as parley.<name>(args) inside code_execute; read code_docs first).`,
  );
  const direct = by('direct');
  if (direct.length > 0) lines.push(`- ${migrated.length === 0 ? 'tools of the parley server' : 'direct tools'}: ${direct.join(', ')}.`);
  const unavailable = by('unavailable');
  if (unavailable.length > 0) lines.push(`- unavailable in this launch: ${unavailable.join(', ')} (say so; never guess a call).`);
  if (names.some((name) => TERMINAL_OPERATIONS.includes(name))) lines.push('- report, wait_for, check_inbox and send_message are always top-level tool calls, never inside code_execute.');
  return lines.join('\n');
}

// ----- role and recipe routing (plan T8c) -----
// A shipped role or playbook is never rewritten. A replacement launch may APPEND one sentence when an instruction name in it is not simply a
// tool of this launch; everything else about the text is the shipped text. Custom or native text is only judged, never edited.

/** The operation names a shipped text mentions: names it tells the agent to CALL, and names it uses as plain nouns (e.g. "In your report"). */
export interface OperationRefs {
  readonly instruction: readonly string[];
  readonly label: readonly string[];
}
const refs = (instruction: readonly string[], label: readonly string[] = []): OperationRefs => Object.freeze({ instruction: Object.freeze([...instruction]), label: Object.freeze([...label]) });

/** The nine shipped roles; a test recomputes it from the prompts and descriptions. `report` is the noun in all of them. */
export const ROLE_OPERATION_REFS: Readonly<Record<string, OperationRefs>> = Object.freeze({
  'builtin:feature-lead': refs(['create_session'], ['report']),
  'builtin:planner': refs([], ['report']),
  'builtin:architect': refs([], ['report']),
  'builtin:critic': refs([], ['report']),
  'builtin:executor': refs([], ['report']),
  'builtin:reviewer': refs([], ['report']),
  'builtin:verifier': refs([], ['report']),
  'builtin:debugger': refs([], ['report']),
  'builtin:researcher': refs([], ['report']),
});

/** The three shipped lead playbooks. */
export const RECIPE_OPERATION_REFS: Readonly<Record<string, OperationRefs>> = Object.freeze({
  'builtin:plan-build': refs(['find_skill', 'propose_completion']),
  'builtin:review': refs(['backlog_suggest', 'find_skill']),
  'builtin:debug': refs(['find_skill']),
});

function noteFor(table: Readonly<Record<string, OperationRefs>>, id: string, routing: CodeModeRouting, universe: readonly string[]): string {
  const entry = table[id];
  if (routing.mode === 'classic' || entry === undefined) return '';
  const migrated: string[] = [];
  const missing: string[] = [];
  for (const name of [...entry.instruction].sort()) {
    const route = routeOf(name, universe, routing);
    if (route === 'migrated') migrated.push(name);
    else if (route === 'unavailable') missing.push(name);
  }
  const parts = [
    ...migrated.map((name) => `${name} is called as parley.${name}(args) inside code_execute (read code_docs first).`),
    ...(missing.length === 0 ? [] : [`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not available here; say so instead of calling ${missing.length === 1 ? 'it' : 'them'}.`]),
  ];
  return parts.length === 0 ? '' : `Routing for this launch: ${parts.join(' ')}`;
}

/** The sentence a replacement launch appends to a shipped role's text; empty for classic, for a custom id and when nothing needs saying. */
export function roleRoutingNote(roleId: string, routing: CodeModeRouting, universe: readonly string[]): string {
  return noteFor(ROLE_OPERATION_REFS, roleId, routing, universe);
}

/** The same for a shipped lead playbook. */
export function recipeRoutingNote(recipeId: string, routing: CodeModeRouting, universe: readonly string[]): string {
  return noteFor(RECIPE_OPERATION_REFS, recipeId, routing, universe);
}

/**
 * What a replacement launch knows about a role or playbook text. A verdict only: it never blocks a launch and is not an enforcement signal.
 * `incompatible` is conservative (a name scan cannot tell a call from a noun) and says so; `unverified` is for text Parley cannot read.
 */
export interface RoleCompatibility {
  readonly status: 'compatible' | 'incompatible' | 'unverified';
  readonly names: readonly string[];
  readonly conservative: boolean;
}

const COMPATIBLE: RoleCompatibility = Object.freeze({ status: 'compatible', names: Object.freeze([]), conservative: false });
const UNVERIFIED: RoleCompatibility = Object.freeze({ status: 'unverified', names: Object.freeze([]), conservative: false });

function mentionedNames(text: string): string[] {
  const names = MIGRATION_REGISTRY.entries.map((e) => e.name);
  const found = new Set<string>();
  // An agent calls a Parley tool as mcp__parley__<name>: that prefix is part of the mention, nothing else is.
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9_])(?:mcp__parley__)?(${names.join('|')})(?![A-Za-z0-9_])`, 'g'))) found.add(m[1]!);
  return [...found].sort();
}

function scanVerdict(text: string, routing: CodeModeRouting, universe: readonly string[]): RoleCompatibility {
  const bad = mentionedNames(text).filter((name) => routeOf(name, universe, routing) !== 'direct');
  return bad.length === 0 ? COMPATIBLE : Object.freeze({ status: 'incompatible' as const, names: Object.freeze(bad), conservative: true });
}

function tableVerdict(table: Readonly<Record<string, OperationRefs>>, id: string, routing: CodeModeRouting, universe: readonly string[]): RoleCompatibility {
  const entry = table[id];
  if (entry === undefined) return UNVERIFIED;
  const names = [...entry.instruction].filter((name) => routeOf(name, universe, routing) !== 'direct').sort();
  return names.length === 0 ? COMPATIBLE : Object.freeze({ status: 'compatible' as const, names: Object.freeze(names), conservative: false });
}

/** A role: builtin by table (its note covers it), a Claude native agent is unreadable, a Codex role is judged by its text. */
export function roleCompatibility(role: { source: 'builtin' | 'claude' | 'codex'; id: string; prompt?: string }, routing: CodeModeRouting, universe: readonly string[]): RoleCompatibility {
  if (routing.mode === 'classic') return COMPATIBLE;
  if (role.source === 'builtin') return tableVerdict(ROLE_OPERATION_REFS, role.id, routing, universe);
  if (role.source === 'claude' || role.prompt === undefined || role.prompt === '') return UNVERIFIED;
  return scanVerdict(role.prompt, routing, universe);
}

/** A lead playbook: a shipped one by table, any other by a scan of the snapshot text. */
export function recipeCompatibility(recipe: { id: string; playbook: string }, routing: CodeModeRouting, universe: readonly string[]): RoleCompatibility {
  if (routing.mode === 'classic') return COMPATIBLE;
  if (Object.hasOwn(RECIPE_OPERATION_REFS, recipe.id)) return tableVerdict(RECIPE_OPERATION_REFS, recipe.id, routing, universe);
  return scanVerdict(recipe.playbook, routing, universe);
}

// ----- skill catalogue routing (plan T8d2) -----
// Parley holds a native skill catalogue at launch only for Codex (its own skills/list); for Claude the catalogue is read later, by the MCP process.
// Only names and descriptions are scanned: a skill body is never read, and nothing is edited, hidden or reordered.

const frontmatterOf = (md: string): { name: string; description: string } => ({
  name: /^name: (.+)$/m.exec(md)![1]!.trim(),
  description: JSON.parse(/^description: (.+)$/m.exec(md)![1]!) as string,
});

/** The four skills Parley installs, by the (name, description) pair of their own frontmatter. Their routing is T8d1's, so a scan skips exactly these. */
export const PARLEY_OWNED_SKILLS: readonly { readonly name: string; readonly description: string }[] = Object.freeze(
  [SKILL_MD, PARLEY_BROWSER_SKILL_MD, RESEARCH_SWARM_SKILL_MD, MINIMAL_DEVELOPMENT_SKILL_MD].map(frontmatterOf).map((s) => Object.freeze(s)),
);

/** One skill of the catalogue whose description names an operation that is not simply a tool of this launch. */
export interface SkillFinding {
  readonly name: string;
  readonly source: string;
  readonly names: readonly string[];
}
export interface SkillCompatibility {
  readonly status: 'compatible' | 'incompatible' | 'unverified';
  readonly skills: readonly SkillFinding[];
  readonly conservative: boolean;
}

/**
 * What a replacement launch knows about the native skills. No catalogue (Claude at launch, an unread Codex list, unavailable provider evidence)
 * or a partial one is `unverified`; a skill that the model can load and whose description names a migrated or unavailable operation makes it
 * `incompatible`, conservatively (a name scan cannot tell a call from a noun). A skill that Parley itself installed is skipped by identity: its
 * description names operations on purpose and its routing is the stub's own. A same-name document of the user is judged like any other.
 */
export function skillCompatibility(catalog: SkillCatalog | null, routing: CodeModeRouting, universe: readonly string[]): SkillCompatibility {
  if (routing.mode === 'classic') return Object.freeze({ status: 'compatible' as const, skills: Object.freeze([]), conservative: false });
  if (catalog === null) return Object.freeze({ status: 'unverified' as const, skills: Object.freeze([]), conservative: false });
  const owned = (name: string, description: string): boolean => PARLEY_OWNED_SKILLS.some((s) => s.name === name && s.description === description);
  const findings: SkillFinding[] = [];
  for (const skill of catalog.skills) {
    // A skill the model cannot load is no instruction to it; one whose availability is unverified may still be loadable.
    if (!skill.modelAvailable && skill.unavailableReason !== 'availability-unverified') continue;
    if (owned(skill.name, skill.description)) continue;
    const names = mentionedNames(skill.description).filter((name) => routeOf(name, universe, routing) !== 'direct');
    if (names.length > 0) findings.push(Object.freeze({ name: skill.name, source: skill.source, names: Object.freeze(names) }));
  }
  if (findings.length > 0) return Object.freeze({ status: 'incompatible' as const, skills: Object.freeze(findings), conservative: true });
  const incomplete = catalog.partial || catalog.diagnostics.some((d) => d.code === 'missing-context');
  return Object.freeze({ status: incomplete ? ('unverified' as const) : ('compatible' as const), skills: Object.freeze([]), conservative: false });
}

/** Everything a replacement launch knows about the texts it carries. Plain data on the plan; the launcher reads it through `selectsClassic`. */
export interface CodeModeRoutingReport {
  readonly role?: RoleCompatibility;
  readonly playbook?: RoleCompatibility;
  readonly skills?: SkillCompatibility;
}

/**
 * The one rule that turns a report into a fallback (lead rulings m-6859, m-6860). A role or playbook that is not compatible selects classic: a
 * native role has no bootstrap route. For skills only `incompatible` does: `unverified` is reported data and a named limit, because the
 * bootstrap and the stub rule make an unseen skill body harmless (an unavailable name is said, never dispatched), and because Claude's skills
 * are always unverified at launch. The first source in the order role, playbook, skills is named.
 */
export function selectsClassic(report: CodeModeRoutingReport | undefined): { classic: boolean; source: 'role' | 'playbook' | 'skills' | null; names: readonly string[] } {
  if (report?.role !== undefined && report.role.status !== 'compatible') return { classic: true, source: 'role', names: report.role.names };
  if (report?.playbook !== undefined && report.playbook.status !== 'compatible') return { classic: true, source: 'playbook', names: report.playbook.names };
  if (report?.skills?.status === 'incompatible') return { classic: true, source: 'skills', names: [...new Set(report.skills.skills.flatMap((s) => s.names))].sort() };
  return { classic: false, source: null, names: [] };
}
