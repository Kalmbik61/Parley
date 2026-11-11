// T9a harness, slice H4a-2b: the run. Everything the earlier slices built, put in order: the scripts file is checked against the frozen goals, each run goal gets
// its data built once and each arm it names run on real processes, launch goals go through the real launch planning, rollback goals over real run records, and every
// verdict goes into one report. Nothing here is a test: the run file (`parley-token-benchmark-replay.run.test.ts`) calls it, and the gate script runs that file.
//
// The conservation phase is one fixed procedure, identical on both arms and pinned by its text (`CONSERVATION_PROCEDURE`, whose sha256 the report carries): after a
// goal's script, on the same live arm, with everything the goal is judged on already frozen, it reads the guide topic by topic (the whole guide is over the result
// budget of one script run), the role list, and on the replacement arm the catalogue twice.

import { createHash } from 'node:crypto';
import {
  type ArmRunResult, type ArmScript, type ClassicScript, type PhaseTools, type ReplacementScript, runArm,
} from './parley-token-benchmark-replay-arms.js';
import { buildGoalData } from './parley-token-benchmark-replay-data.js';
import { startReplayHost } from './parley-token-benchmark-replay-host.js';
import { runLaunchGoal } from './parley-token-benchmark-replay-launch.js';
import { type LaunchSources, readLaunchSources } from './parley-token-benchmark-replay-sources.js';
import type { Facts } from './parley-token-benchmark-replay-preflight.js';
import { runRollbackGoal } from './parley-token-benchmark-replay-rollback.js';
import {
  type ArmAccounting, type ArmObservation, type ConservationObservation, type Goal, type Obj, type Tokenizer, type ToolDescriptor, type Verdict,
  armAccounting, judgeLaunchGoal, judgeRollbackGoal, judgeRunGoal,
} from './parley-token-benchmark-replay.js';

// the two arm names as bare tokens, so a message built from them is not a literal phrase of its own
const ARM_A = 'classic';
const ARM_B = 'replacement';
const isRec = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---------- the scripts file ----------

export interface ScriptsEntry { readonly goal: string; readonly classic?: ClassicScript; readonly replacement?: ReplacementScript }
export type ScriptsByGoal = ReadonlyMap<string, { readonly classic?: ClassicScript; readonly replacement?: ReplacementScript }>;

/** Checks the scripts file against the frozen goals: the arms each run goal names have a script of the right kind, nothing else has one, and the answer names are the goal's. */
export function checkScripts(file: unknown, goals: readonly Goal[]): { readonly ok: true; readonly byGoal: ScriptsByGoal } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const byGoal = new Map<string, { classic?: ClassicScript; replacement?: ReplacementScript }>();
  if (!isRec(file) || file['version'] !== 1 || !Array.isArray(file['scripts']) || Object.keys(file).length !== 2) return { ok: false, issues: ['the scripts file is { version: 1, scripts: [...] } and nothing else'] };
  const runGoals = new Map(goals.filter((g) => g.kind === 'run').map((g) => [g.id, g]));
  const extractOk = (e: unknown, calls: number | null, where: string): boolean => {
    if (!isRec(e)) { issues.push(`${where}.extract: an object`); return false; }
    for (const [name, spec] of Object.entries(e)) {
      if (!isRec(spec) || typeof spec['path'] !== 'string') { issues.push(`${where}.extract.${name}: { path: string, call?, calls?, raw?, is?, where?, project?, shape?, parse?, skip?, prefix? }`); continue; }
      if (spec['calls'] !== undefined && !(Array.isArray(spec['calls']) && spec['calls'].length > 0 && spec['calls'].every((c) => Number.isInteger(c) && c >= 0 && (calls === null || c < calls)) && spec['call'] === undefined)) issues.push(`${where}.extract.${name}.calls: call indexes of this script, without \`call\``);
      if (spec['call'] !== undefined && (!Number.isInteger(spec['call']) || (spec['call'] as number) < 0 || (calls !== null && (spec['call'] as number) >= calls))) issues.push(`${where}.extract.${name}.call: a call index of this script`);
      if (spec['where'] !== undefined && !(isRec(spec['where']) && Object.values(spec['where']).every((v) => typeof v === 'string'))) issues.push(`${where}.extract.${name}.where: { member: string }`);
      if (spec['is'] !== undefined && !isJsonValue(spec['is'])) issues.push(`${where}.extract.${name}.is: a JSON value`);
      if (spec['raw'] !== undefined && spec['raw'] !== true) issues.push(`${where}.extract.${name}.raw: true`);
      if (spec['shape'] !== undefined && !(isRec(spec['shape']) && Object.values(spec['shape']).every((m) => typeof m === 'string' || (isRec(m) && typeof m['path'] === 'string' && (m['project'] === undefined || (Array.isArray(m['project']) && m['project'].every((k) => typeof k === 'string'))))))) issues.push(`${where}.extract.${name}.shape: { name: path | { path, project? } }`);
      if (spec['parse'] !== undefined && spec['parse'] !== 'json') issues.push(`${where}.extract.${name}.parse: json`);
      if (spec['skip'] !== undefined && !(Number.isInteger(spec['skip']) && (spec['skip'] as number) > 0)) issues.push(`${where}.extract.${name}.skip: a positive integer`);
      if (spec['prefix'] !== undefined && !(Number.isInteger(spec['prefix']) && (spec['prefix'] as number) > 0)) issues.push(`${where}.extract.${name}.prefix: a positive integer`);
      if (spec['project'] !== undefined && !(Array.isArray(spec['project']) && spec['project'].every((k) => typeof k === 'string'))) issues.push(`${where}.extract.${name}.project: strings`);
    }
    return true;
  };
  (file['scripts'] as unknown[]).forEach((entry, i) => {
    const where = `scripts[${i}]`;
    if (!isRec(entry) || typeof entry['goal'] !== 'string') { issues.push(`${where}: { goal, ${ARM_A}?, ${ARM_B}? }`); return; }
    const goal = runGoals.get(entry['goal']);
    if (goal === undefined) { issues.push(`${where}: ${entry['goal']} is not a run goal of the frozen file`); return; }
    if (byGoal.has(goal.id)) { issues.push(`${where}: ${goal.id} twice`); return; }
    const out: { classic?: ClassicScript; replacement?: ReplacementScript } = {};
    for (const arm of ['classic', 'replacement'] as const) {
      const s = entry[arm];
      if (!goal.arms.includes(arm)) { if (s !== undefined) issues.push(`${where}.${arm}: ${goal.id} does not run the ${arm} arm`); continue; }
      if (!isRec(s)) { issues.push(`${where}.${arm}: ${goal.id} runs the ${arm} arm and needs a script`); continue; }
      if (arm === 'classic') {
        const calls = s['calls'];
        if (!Array.isArray(calls) || calls.length === 0 || !calls.every((c) => isRec(c) && typeof c['name'] === 'string' && isRec(c['args']))) { issues.push(`${where}.${arm}.calls: one or more { name, args }`); continue; }
        if (extractOk(s['extract'], calls.length, `${where}.${arm}`)) out.classic = { calls: calls as ClassicScript['calls'], extract: s['extract'] as ClassicScript['extract'] };
      } else {
        if (typeof s['code'] !== 'string' || s['code'] === '') { issues.push(`${where}.replacement.code: a script`); continue; }
        for (const k of ['search', 'second', 'next'] as const) if (s[k] !== undefined && typeof s[k] !== 'string') issues.push(`${where}.replacement.${k}: a string`);
        if (extractOk(s['extract'], null, `${where}.replacement`)) out.replacement = { code: s['code'], extract: s['extract'] as ReplacementScript['extract'], ...(typeof s['search'] === 'string' ? { search: s['search'] } : {}), ...(typeof s['second'] === 'string' ? { second: s['second'] } : {}), ...(typeof s['next'] === 'string' ? { next: s['next'] } : {}) };
      }
    }
    // both arms answer with the goal's own names, so a difference between arms is stated in a script and not made by a name
    const want = Object.keys(goal.answer ?? {}).sort().join();
    for (const arm of ['classic', 'replacement'] as const) {
      const s = out[arm];
      if (s !== undefined && Object.keys(s.extract).sort().join() !== want) issues.push(`${where}.${arm}.extract: names [${Object.keys(s.extract).sort().join(', ')}] are not the goal's answer names [${want.split(',').join(', ')}]`);
    }
    byGoal.set(goal.id, out);
  });
  for (const id of runGoals.keys()) if (!byGoal.has(id)) issues.push(`${id}: a run goal without a script`);
  return issues.length === 0 ? { ok: true, byGoal } : { ok: false, issues };
}

// ---------- the conservation phase ----------

/** The pinned procedure. Its text is the contract: both arms do these reads in this order (the replacement arm through code_execute, the classic arm directly). */
export const CONSERVATION_PROCEDURE: readonly string[] = Object.freeze([
  'topics = the enum of the topic argument of read_guide in the arm\'s own tool list, in that order',
  'for each topic: the text of read_guide({ topic })  (replacement: parley.read_guide inside code_execute, read in slices; the surface wraps the text as { text }, and the text is what is compared)',
  'roles: the `roles` array of list_roles({}), as JSON text  (replacement: parley.list_roles inside code_execute; the surface adds an empty `unknownFields` object to every object, so the array is compared with exactly those empty members left out; a non-empty `unknownFields` is kept and shows as a difference; the other members of the read (`partial`, `diagnostics`) are read on both arms and compared with the array, and a read that reports partial, diagnostics or any other member stops the run by name)',
  'replacement only: code_search({ query: " " }) (a blank query lists the whole catalogue) followed page by page with nextCursor to the end, twice; the names in order and the page texts joined are kept per run',
  'every value is taken as the tool returned it: a string as it is, anything else as JSON text',
]);
export const CONSERVATION_PROCEDURE_SHA256 = sha256(CONSERVATION_PROCEDURE.join('\n'));

/** What the whole guide read does on this arm: the surface limit the report records from a run (the replacement final-value cap against the classic whole answer). */
export interface WholeGuide { readonly classicBytes: number | null; readonly replacement: { readonly status: string; readonly errorKind: string | null; readonly message: string | null; readonly readBytes: number | null; readonly incomplete: boolean; readonly diagnostics: readonly { readonly code: string; readonly params: unknown }[] } | null }

export interface ArmConservation {
  readonly wholeGuide: WholeGuide;
  readonly guide: readonly { readonly topic: string; readonly text: string }[];
  readonly roles: string;
  /** The members of the roles read other than `roles`, as JSON text: `{"partial":false,"diagnostics":[]}` on both arms, compared with the roles array. */
  readonly rolesRest: string;
  readonly catalogue: readonly { readonly names: readonly string[]; readonly bytes: string }[];
}

/** The members of a list_roles read other than `roles` (and an empty `unknownFields`), as JSON text: both arms carry `partial` and `diagnostics`, and they are compared. */
export const ROLES_REST_PICK = "JSON.stringify(Object.fromEntries(Object.entries(r.value).filter(([k, v]) => k !== 'roles' && !(k === 'unknownFields' && v !== null && typeof v === 'object' && Object.keys(v).length === 0))))";

/** A list_roles read that reports anything but a complete read is no baseline and no result to compare: `partial` must be false, `diagnostics` empty, and no other member. */
export function rolesRestProblem(rest: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'partial') { if (v !== false) return `list_roles reports partial: ${JSON.stringify(v)}`; }
    else if (k === 'diagnostics') { if (!Array.isArray(v) || v.length !== 0) return `list_roles reports diagnostics: ${JSON.stringify(v)}`; }
    else return `list_roles carries a member beyond roles, partial and diagnostics: ${k}`;
  }
  return null;
}

const isJsonValue = (x: unknown): boolean => { try { return JSON.stringify(x) !== undefined; } catch { return false; } };
const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** The roles of a list_roles read, as JSON text, with the empty `unknownFields` objects the replacement surface adds to every object left out (a non-empty one stays). */
export const ROLES_PICK = "JSON.stringify(r.value.roles, (k, v) => (k === 'unknownFields' && v !== null && typeof v === 'object' && Object.keys(v).length === 0 ? undefined : v))";

/** The text of a guide read as the script sees it: the text itself, or the `text` of the object the replacement surface wraps it in. The wrapper is opened only when `text` is its only member; any other member keeps the whole value as JSON, so it shows in the comparison. */
export const GUIDE_TEXT = "typeof r.value === 'string' ? r.value : (r.value !== null && typeof r.value === 'object' && !Array.isArray(r.value) && Object.keys(r.value).length === 1 && typeof r.value.text === 'string' ? r.value.text : JSON.stringify(r.value))";

/** One script run slices at most this many characters of a text (JSON escaping can double them; the final value of a run is capped at 16 KiB). */
const CHUNK = 6000;

/**
 * Reads one parley.<call> result of any size on the replacement arm: each run returns one slice of the text (a string as it is, anything else as JSON text), and the
 * slices are put together. A run that does not complete, or a read that is not ok, is a failed conservation read, by name.
 */
export async function readChunked(t: PhaseTools, call: string, what: string, pick = "typeof r.value === 'string' ? r.value : JSON.stringify(r.value)"): Promise<string> {
  let text = '';
  let total = -1;
  for (let at = 0; total < 0 || at < total; at += CHUNK) {
    const run = await t.run(`const r = ${call}; const s = ${pick}; return { total: s.length, part: s.slice(${at}, ${at + CHUNK}) };`);
    if (run.result.status !== 'completed') throw new Error(`conservation read of ${what} did not complete (${run.result.status}${run.result.error === null ? '' : ` ${run.result.error.kind}`})`);
    const v = run.body['value'];
    if (!isRec(v) || typeof v['total'] !== 'number' || typeof v['part'] !== 'string') throw new Error(`conservation read of ${what} returned no slice`);
    total = v['total'];
    text += v['part'];
  }
  if (text.length !== total) throw new Error(`conservation read of ${what}: ${text.length} characters put together, ${total} expected`);
  return text;
}

export function guideTopicsOf(tools: readonly ToolDescriptor[]): string[] {
  const guide = tools.find((t) => t.name === 'read_guide');
  const schema = (guide as unknown as { inputSchema?: { properties?: { topic?: { enum?: unknown } } } } | undefined)?.inputSchema;
  const list = schema?.properties?.topic?.enum;
  if (!Array.isArray(list) || list.length === 0 || !list.every((t) => typeof t === 'string')) throw new Error('conservation: the read_guide descriptor has no topic enum');
  return list as string[];
}

/** The phase function for one arm. `topicsOf` is given the arm's own tool list; the runner answers with the classic arm's topics when there is one, so both arms read the same. */
export function conservationPhase(topicsOf: (tools: readonly ToolDescriptor[]) => readonly string[]): (t: PhaseTools) => Promise<ArmConservation> {
  return async (t) => {
    const topics = topicsOf(t.tools);
    const guide: { topic: string; text: string }[] = [];
    for (const topic of topics) {
      guide.push({ topic, text: t.arm === 'classic' ? asText(await t.call('read_guide', { topic })) : await readChunked(t, `await parley.read_guide({ topic: ${JSON.stringify(topic)} })`, `guide topic ${topic}`, GUIDE_TEXT) });
    }
    let roles: string;
    let rolesRest: string;
    if (t.arm === 'classic') {
      const read = await t.call('list_roles', {}) as Obj;
      roles = JSON.stringify(read['roles']);
      rolesRest = JSON.stringify(Object.fromEntries(Object.entries(read).filter(([k]) => k !== 'roles')));
    } else {
      roles = await readChunked(t, 'await parley.list_roles({})', 'roles', ROLES_PICK);
      rolesRest = await readChunked(t, 'await parley.list_roles({})', 'roles members', ROLES_REST_PICK);
    }
    const problem = rolesRestProblem(JSON.parse(rolesRest) as Record<string, unknown>);
    if (problem !== null) throw new Error(`conservation read of roles on the ${t.arm} arm: ${problem}`);
    // the whole guide in one read: kept as a stated surface limit, never hidden behind the topic reads
    let wholeGuide: WholeGuide;
    if (t.arm === 'classic') wholeGuide = { classicBytes: Buffer.byteLength(asText(await t.call('read_guide', {})), 'utf8'), replacement: null };
    else {
      const whole = await t.run('return await parley.read_guide({});');
      const op = Array.isArray(whole.body['operations']) ? (whole.body['operations'] as Obj[])[0] : undefined;
      const err = isRec(whole.body['error']) ? whole.body['error'] : null;
      wholeGuide = { classicBytes: null, replacement: { status: whole.result.status, errorKind: err === null ? null : String(err['kind']), message: err === null || err['message'] === undefined ? null : String(err['message']), readBytes: typeof op?.['responseBytes'] === 'number' ? op['responseBytes'] : null, incomplete: whole.result.incomplete, diagnostics: whole.result.diagnostics.map((d) => ({ code: d.code, params: d.params })) } };
    }
    const catalogue: { names: string[]; bytes: string }[] = [];
    if (t.arm === 'replacement') {
      for (let i = 0; i < 2; i++) {
        const names: string[] = [];
        const pages: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 100; page++) {
          const s = await t.search(' ', cursor);
          const items = s.body['items'];
          if (!Array.isArray(items)) throw new Error('conservation read of the catalogue returned no items');
          names.push(...items.map((x) => String((x as Obj)['name'])));
          pages.push(s.text);
          const next = s.body['nextCursor'];
          if (next === null || next === undefined) break;
          if (typeof next !== 'string') throw new Error('conservation read of the catalogue returned a cursor that is not a string');
          cursor = next;
          if (page === 99) throw new Error('conservation read of the catalogue did not end in 100 pages');
        }
        catalogue.push({ names, bytes: pages.join('\n') });
      }
    }
    return { wholeGuide, guide, roles, rolesRest, catalogue };
  };
}

/**
 * The comparison the conservation criteria read. The guide and the roles are read where the agent receives them, one arm at a time. Recipes and skills are
 * judged at launch planning, not through MCP (`readLaunchSources`); without them a goal that asks for them fails by name.
 */
export function conservationObservation(classic: ArmRunResult, replacement: ArmRunResult, wrapperNames: readonly string[], migrated: readonly string[], launch?: LaunchSources): ConservationObservation {
  const a = classic.phase as ArmConservation | undefined;
  const b = replacement.phase as ArmConservation | undefined;
  if (a === undefined || b === undefined) throw new Error('conservation: an arm did not run the conservation phase');
  const join = (c: ArmConservation): string => c.guide.map((g) => `# ${g.topic}\n${g.text}`).join('\n');
  return {
    classicTools: classic.tools, replacementTools: replacement.tools, migrated, wrapperNames,
    catalogueNames: b.catalogue[0]?.names ?? [], originalNames: classic.tools.map((t) => t.name), catalogueRuns: b.catalogue,
    sources: { guide: { classic: join(a), replacement: join(b) }, roles: { classic: `${a.roles}\n${a.rolesRest}`, replacement: `${b.roles}\n${b.rolesRest}` }, ...(launch === undefined ? {} : { recipes: launch.recipes, skills: launch.skills }) },
  };
}

// ---------- one run goal ----------

export interface RunDeps {
  readonly dir: string;
  readonly distDir: string;
  readonly preloadPath: string;
  readonly tokenizer: Tokenizer;
  /** The operations the replacement arm runs through the script surface (what the preload proves). */
  readonly migrated: readonly string[];
  readonly wrapperNames: readonly string[];
}

export interface GoalRun {
  readonly verdicts: readonly Verdict[];
  readonly accounting: Partial<Record<'classic' | 'replacement', ArmAccounting>>;
  readonly skips: Readonly<Record<'classic' | 'replacement', number>>;
  /** What the conservation phase read on each arm (apart from every verdict): the report records the whole-guide surface limit from here. */
  readonly conservation?: Partial<Record<'classic' | 'replacement', ArmConservation>>;
  /** Where recipes and skills were read: launch planning, not MCP. */
  readonly launchSources?: LaunchSources;
}

export const wantsConservation = (goal: Goal): boolean => {
  const asks = goal.criteria.some((c) => 'toolList' in c || 'catalogue' in c || 'sources' in c);
  if (!asks) return false;
  // The phase runs after the goal's script, on the same server, and its own runs write run records. Everything the goal is judged on is frozen before it EXCEPT the
  // record, the canary and the process end (read after the arm ends), so a goal that has a fault or a criterion on one of those cannot also take the phase.
  const faults = Object.keys(goal.faults).filter((k) => !['profile', 'navigator', 'agent'].includes(k));
  const late = goal.criteria.filter((c) => 'record' in c || ('text' in c && isRec(c['text']) && isRec(c['text']['neverContains'])));
  if (faults.length > 0 || late.length > 0) throw new Error(`goal ${goal.id}: a conservation criterion with ${faults.length > 0 ? `faults (${faults.join(', ')})` : 'a record or canary criterion'} is refused: the conservation phase would write run records and read after what the goal is judged on`);
  return true;
};

/** Runs one run goal: data once, each arm it names (classic first), the conservation phase when a criterion asks for it, then the judge. */
export async function runRunGoal(goal: Goal, scripts: ScriptsByGoal, deps: RunDeps): Promise<GoalRun> {
  const script = scripts.get(goal.id);
  if (script === undefined) throw new Error(`goal ${goal.id}: no script`);
  const built = await buildGoalData(goal, `${deps.dir}/${goal.id}`);
  const results: Partial<Record<'classic' | 'replacement', ArmRunResult>> = {};
  const conserve = wantsConservation(goal);
  for (const arm of ['classic', 'replacement'] as const) {
    if (!goal.arms.includes(arm)) continue;
    const s = (arm === 'classic' ? script.classic : script.replacement) as ArmScript;
    // both arms read the topics of the classic arm's list; a replacement-only goal has no classic arm and reads its own
    const phase = conserve ? conservationPhase((own) => (results.classic === undefined ? guideTopicsOf(own) : guideTopicsOf(results.classic.tools))) : undefined;
    results[arm] = await runArm({ goal, arm, built, script: s, distDir: deps.distDir, preloadPath: arm === 'replacement' ? deps.preloadPath : null, ...(phase === undefined ? {} : { phase }) });
  }
  const observations: Partial<Record<'classic' | 'replacement', ArmObservation>> = { ...results };
  const wantsLaunchSources = goal.criteria.some((c) => isRec(c['sources']) && (c['sources']['unchanged'] as string[]).some((n) => n === 'recipes' || n === 'skills'));
  const launchSources = wantsLaunchSources ? await readLaunchSources(deps.migrated) : undefined;
  const cons = conserve && results.classic !== undefined && results.replacement !== undefined ? conservationObservation(results.classic, results.replacement, deps.wrapperNames, deps.migrated, launchSources) : undefined;
  const verdicts = judgeRunGoal(goal, observations, built.ids, cons);
  const accounting: GoalRun['accounting'] = {};
  for (const arm of ['classic', 'replacement'] as const) {
    const r = results[arm];
    if (r === undefined) continue;
    const wrappers = r.tools.filter((t) => deps.wrapperNames.includes(t.name));
    const residual = r.tools.filter((t) => !deps.wrapperNames.includes(t.name));
    const original = results.classic?.tools ?? residual;
    const calls = arm === 'classic' ? ((script.classic?.calls ?? []).map((c) => c.name)) : ['code_search', 'code_execute', ...(script.replacement?.second === undefined ? [] : ['code_execute'])];
    accounting[arm] = armAccounting({ original, residual: arm === 'classic' ? original : residual, wrappers: arm === 'classic' ? [] : wrappers, registryRevision: null, tokenizer: deps.tokenizer, clientCalls: calls, hostLog: r.hostLog, received: r.received, messages: r.messages });
  }
  return {
    verdicts, accounting, skips: { classic: results.classic?.skipped ?? 0, replacement: results.replacement?.skipped ?? 0 },
    ...(launchSources === undefined ? {} : { launchSources }),
    ...(conserve ? { conservation: { ...(results.classic === undefined ? {} : { classic: results.classic.phase as ArmConservation }), ...(results.replacement === undefined ? {} : { replacement: results.replacement.phase as ArmConservation }) } } : {}),
  };
}

// ---------- the whole set ----------

export interface AllResult {
  readonly verdicts: readonly Verdict[];
  readonly accounting: Record<string, Partial<Record<'classic' | 'replacement', ArmAccounting>>>;
  readonly skipsByArm: { classic: number; replacement: number };
  readonly conservation: Record<string, NonNullable<GoalRun['conservation']>>;
  readonly launchSources: Record<string, LaunchSources>;
}

/** Every goal of the frozen file, strictly one after another. A failure of the harness itself (not of a goal) stops the run and is thrown, never turned into a verdict. */
export async function runAll(goals: readonly Goal[], scripts: ScriptsByGoal, deps: RunDeps): Promise<AllResult> {
  const verdicts: Verdict[] = [];
  const accounting: AllResult['accounting'] = {};
  const skipsByArm = { classic: 0, replacement: 0 };
  const conservation: AllResult['conservation'] = {};
  const launchSources: AllResult['launchSources'] = {};
  for (const goal of goals) {
    if (goal.kind === 'run') {
      const r = await runRunGoal(goal, scripts, deps);
      verdicts.push(...r.verdicts);
      accounting[goal.id] = r.accounting;
      if (r.conservation !== undefined) conservation[goal.id] = r.conservation;
      if (r.launchSources !== undefined) launchSources[goal.id] = r.launchSources;
      skipsByArm.classic += r.skips.classic;
      skipsByArm.replacement += r.skips.replacement;
    } else if (goal.kind === 'launch') {
      verdicts.push(...judgeLaunchGoal(goal, await runLaunchGoal(goal)));
    } else {
      verdicts.push(...judgeRollbackGoal(goal, await runRollbackGoal(goal, { dir: deps.dir, distDir: deps.distDir, preloadPath: deps.preloadPath })));
    }
  }
  return { verdicts, accounting, skipsByArm, conservation, launchSources };
}

// ---------- the handler probe control ----------

/**
 * The control for `handlerStarted`: one real call through the real host, and the host's log must say the real handler started. It can only say true where the core's
 * tool runner is wrapped (the `vi.mock` of core/dist in the file that runs this); anywhere else it says false and the preflight refuses the run by name.
 */
export async function handlerProbeControl(dir: string): Promise<boolean> {
  const goal = (await import('./parley-token-benchmark-replay-schema.js')).checkGoalFile({ version: 1, goals: [{ id: 'probe', class: 'read-dto', kind: 'run', goal: 'x', arms: ['classic', 'replacement'], data: { self: 'caller', sessions: [{ key: 'caller', label: 'Caller', provider: 'codex', lifecycle: 'active', task: 'x', summary: 'S' }], rooms: [], plans: [], backlog: [] }, answer: { a: 'x' }, criteria: [{ answer: { path: 'a', present: true } }] }] });
  if (!goal.ok) throw new Error('the handler probe control goal is not valid');
  const built = await buildGoalData(goal.goals[0]!, `${dir}/handler-probe`);
  const { restoreForArm } = await import('./parley-token-benchmark-replay-data.js');
  await restoreForArm(built, null);
  const host = await startReplayHost(built, {});
  try {
    const res = await fetch(new URL('/agent/tools', host.agent.url), { method: 'POST', headers: { Authorization: `Bearer ${host.agent.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'call', launch: {}, name: 'get_map', args: {}, callId: 'handler-probe' }) });
    await res.text();
    return host.log().some((e) => e.op === 'call' && e.method === 'get_map' && e.handlerStarted);
  } finally { await host.close(); }
}

// ---------- the report ----------

/** Limits of the surface that shaped how a goal is scripted, named in every report (the scripts file carries the numbers; the report states why). */
export const NAMED_LIMITS: readonly { readonly name: string; readonly goals: readonly string[]; readonly cause: string }[] = Object.freeze([
  { name: 'the whole guide is cut to its first 12,000 characters on both arms', goals: ['read-guide-raw-text', 'guide-success-still-unknown'], cause: 'the whole guide is about 46 KB and the final value of a script run is capped at 16 KiB (resultBytes); the whole guide is compared topic by topic in the conservation phase' },
  { name: 'each of the 80 summaries is cut to its first 64 characters on both arms', goals: ['page-session-summaries'], cause: 'the 80 summaries are about 80 KiB and the final value of a script run is capped at 16 KiB; the read itself keeps them whole' },
  { name: 'the code-bytes limit is unreachable through code_execute', goals: ['code-bytes-rejects-one-over'], cause: 'admission refuses code over the cap before any run (invalid-request, no run id, no operation), so the limit-reached code-bytes diagnostic cannot appear' },
]);

export interface ReportExtras {
  readonly facts: Facts;
  /** The contents of the stamp the gate script wrote for this run: the report copies it back, and the gate compares. */
  readonly buildStamp: string;
  readonly conservation: AllResult['conservation'];
  readonly launchSources?: AllResult['launchSources'];
}

/** The scored report plus what a reader needs to trust it: the machine, the build, the procedure that was pinned, the limits the surface showed, and where each thing was judged. */
export function assembleReport(report: Record<string, unknown>, extras: ReportExtras): Record<string, unknown> {
  const f = extras.facts;
  const wholeGuide = Object.entries(extras.conservation).map(([goal, arms]) => ({ goal, classic: arms.classic?.wholeGuide.classicBytes ?? null, replacement: arms.replacement?.wholeGuide.replacement ?? null }));
  return {
    ...report,
    buildStamp: extras.buildStamp,
    environment: { node: f.node, platform: f.platform, load: f.load, sdk: f.sdk, probeSha256: f.nativeProbe.sha256, builds: f.builds, treeHash: f.treeHash },
    conservationProcedureSha256: CONSERVATION_PROCEDURE_SHA256,
    surfaceLimits: [...NAMED_LIMITS.map((l) => ({ ...l })), ...wholeGuide.map((w) => ({ name: 'whole guide in one script run', goal: w.goal, classicBytes: w.classic, replacement: w.replacement, cause: 'the final value of a script run is capped at 16 KiB (resultBytes); the read itself succeeds' }))],
    rolesMembers: Object.entries(extras.conservation).map(([goal, arms]) => ({ goal, classic: arms.classic?.rolesRest ?? null, replacement: arms.replacement?.rolesRest ?? null, note: 'list_roles members other than roles, compared across the arms with the roles array; both reads were complete (partial false, no diagnostics)' })),
    accountingNote: 'context bytes and the per-message list are what the goal received; the conservation phase\'s reads are not in them',
    sourceReads: Object.entries(extras.launchSources ?? {}).map(([goal, l]) => ({ goal, ...l.where })),
    judgedAt: { rollback: 'the function (selectExposure over inspectRunRecord), not the launcher', recipesAndSkills: 'launch planning, not through MCP' },
  };
}
