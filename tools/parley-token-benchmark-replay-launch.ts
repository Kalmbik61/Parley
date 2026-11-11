// T9a harness, slice H3a: a `kind: "launch"` goal through the REAL launch planning. Nothing here starts an agent or a server: it builds a work in a
// scratch store, plans the launch the goal describes and, beside it, the same launch with no routing, and hands both to `judgeLaunchGoal`.
//
// Where the goal's inputs come from (the same seams the core's own launch tests use, set for the duration of one call and put back):
//   provider, mode          the session's provider and `planLaunch` / `planResume` / `planNew`; glm is a codex-registered session with provider glm
//   role                    `{ customPrompt }` is a custom Codex role in a role catalogue; `null` is no role; anything else is refused by name
//   routing                 `classic`, the shipped registry's routing, or a fixture list
//   navigator, skills       `PARLEY_SKILL_NAVIGATOR`, and the catalogue `skills/list` would have returned (`codexSkillRoute.catalog`), `null` for none/unread
//   channel, agent          the plan's `channel` and `agent` options; `tools` is the launch's own list (`originalToolNames`)
//   profile                 informational; checked against what the provider really gets when a goal asserts `tools`
// The scratch directory is random per run and sits in the arguments and the env, so it is masked: two runs of one goal then compare.
// A launch input the harness has no seam for (a recipe, a native agent, a catalogue Claude would read later) stops the run by name: a goal that
// needs one is a repair task for the goal or for the harness, never a quiet default.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_REGISTRY } from '../packages/core/src/mcp/code-mode/migration-registry.js';
import { originalToolNames } from '../packages/core/src/mcp/tools.js';
import { CLASSIC_ROUTING, bootstrapText, fixtureRouting, replacementRouting, selectsClassic, type CodeModeRouting } from '../packages/core/src/work/code-mode-instructions.js';
import { createPendingSession, planLaunch, planNew, planResume, readBrief, type LaunchPlan } from '../packages/core/src/work/launch.js';
import { claudeSkillRoute, codexSkillRoute } from '../packages/core/src/work/skill-reduction.js';
import { createWork, readMap } from '../packages/core/src/work/store.js';
import type { SkillCatalog } from '../packages/core/src/skills/catalog.js';
import { claimProcessHome } from './parley-token-benchmark-replay-busy.js';
import type { LaunchObservation, LaunchView } from './parley-token-benchmark-replay-judge.js';
import type { Goal, Obj } from './parley-token-benchmark-replay-schema.js';

/** A launch input the harness has no seam for, or a goal whose own inputs disagree: the run stops, the goal is not judged on what is missing. */
export class LaunchSetupError extends Error {}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STUB = path.join(REPO, 'packages', 'core', 'test', 'stub-agent.mjs');
const FIXED_PROVIDER_SESSION = '7fa0e1ee-cc7b-4a1e-9d4e-0000000000c9';
export const AGENT = { url: 'http://127.0.0.1:4321/agent/browser', token: 'ab'.repeat(32) };

type Env = Record<string, string | undefined>;
/** Sets process variables for the duration of `body` and puts every one back, also when it throws. */
export async function withEnv<T>(env: Env, body: () => Promise<T>): Promise<T> {
  const saved: Env = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  try { return await body(); } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

const isRec = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

function routingOf(spec: unknown): CodeModeRouting {
  if (spec === 'classic') return CLASSIC_ROUTING;
  if (spec === 'shipped') return replacementRouting(MIGRATION_REGISTRY);
  if (isRec(spec) && Array.isArray(spec['fixture'])) return fixtureRouting(spec['fixture'] as string[]);
  throw new LaunchSetupError(`routing ${JSON.stringify(spec)} is not one the harness builds`);
}

/** The catalogue `skills/list` would have returned for this launch, or null when the launch holds none. */
function catalogOf(provider: string, navigator: boolean, skills: Obj): SkillCatalog | null {
  const kind = String(skills['catalogue']);
  const entries = (skills['entries'] as Obj[] | undefined) ?? [];
  if (provider !== 'codex') {
    // Claude's catalogue is read later, by the MCP process, so a launch cannot hold one; with no navigator nothing is read at all
    if (entries.length > 0 || (navigator && (kind === 'verified' || kind === 'partial'))) throw new LaunchSetupError('a Claude catalogue is read later by the MCP process, so a launch cannot hold one: the goal states catalogue "none"');
    return null;
  }
  if (kind === 'none' || kind === 'unread') return null;
  return {
    provider: 'codex', diagnostics: [], partial: kind === 'partial',
    skills: entries.map((e) => ({ provider: 'codex' as const, documentKind: 'skill' as const, name: String(e['name']), description: String(e['description']), source: e['source'] as 'user', path: `/fixture/skills/${String(e['name'])}/SKILL.md`, modelAvailable: true, unavailableReason: null })),
  };
}

/** Every plan of a launch mints a fresh native context revision (a uuid); two plans of one session differ in it and in nothing else, so it is masked. */
const maskRevision = (text: string): string => text.replace(/(PARLEY|HARNAS)_NATIVE_CONTEXT_REVISION(="|=)[0-9a-f-]{36}/g, '$1_NATIVE_CONTEXT_REVISION$2<revision>');

/** The layer is the provider's own system or developer instruction argument; `rest` is every other argument, in order. */
export function splitArgs(provider: string, args: readonly string[]): { layer: string; rest: string } {
  if (provider === 'codex') {
    const at = args.findIndex((a) => a.startsWith('developer_instructions='));
    if (at < 0) return { layer: '', rest: args.join('\u0000') };
    const layer = JSON.parse(args[at]!.slice('developer_instructions='.length)) as string;
    // `-c <assignment>`: the flag goes with its value
    const from = args[at - 1] === '-c' ? at - 1 : at;
    return { layer, rest: [...args.slice(0, from), ...args.slice(at + 1)].join('\u0000') };
  }
  const at = args.indexOf('--append-system-prompt');
  if (at < 0) return { layer: '', rest: args.join('\u0000') };
  return { layer: args[at + 1] ?? '', rest: [...args.slice(0, at), ...args.slice(at + 2)].join('\u0000') };
}

export const codeOf = (e: unknown): string => { const m = /^([a-z][a-z0-9-]*)(?::|$)/.exec((e as Error).message); return m === null ? (e as Error).message : m[1]!; };

/**
 * Plans the launch the goal describes and the same launch with no routing, and reads both the way the judge needs. Both plans are of ONE session with a
 * fixed provider session id, so what differs between them is the routing and nothing else.
 */
export async function runLaunchGoal(goal: Goal, seams: { readonly planner?: typeof planLaunch; readonly order?: 'plain-first' | 'planned-first' } = {}): Promise<LaunchObservation> {
  // process.env and the two skill seams are the process's: a second run while one is going would read the first one's launch
  let release: () => void;
  try { release = claimProcessHome('runLaunchGoal'); } catch (e) { throw new LaunchSetupError((e as Error).message); }
  try { return await launchGoal(goal, seams); } finally { release(); }
}

async function launchGoal(goal: Goal, seams: { readonly planner?: typeof planLaunch; readonly order?: 'plain-first' | 'planned-first' }): Promise<LaunchObservation> {
  const L = goal.launch as Obj | undefined;
  if (goal.kind !== 'launch' || L === undefined) throw new LaunchSetupError(`goal ${goal.id} is not a launch goal`);
  const provider = String(L['provider']);
  const mode = String(L['mode']);
  if (L['recipe'] !== null && L['recipe'] !== undefined) throw new LaunchSetupError('a recipe is a launch input the harness has no seam for');
  const role = L['role'];
  if (role !== null && role !== undefined && !(isRec(role) && typeof role['customPrompt'] === 'string')) throw new LaunchSetupError('only a custom prompt role is built; a built-in or native role is not');
  if (isRec(role) && provider !== 'codex') throw new LaunchSetupError('a custom prompt role is built for Codex only');
  const profile = String(L['profile']);
  if (goal.criteria.some((c) => 'tools' in c) && profile !== (provider === 'codex' ? 'short' : 'full')) throw new LaunchSetupError(`the goal asserts tools under profile ${profile}, which is not the profile ${provider} gets`);

  const scratch = mkdtempSync(path.join(tmpdir(), 'parley-replay-launch-'));
  const project = path.join(scratch, 'project');
  const logs = path.join(scratch, 'logs');
  const claudeConfig = path.join(scratch, 'claude-config');
  for (const dir of [project, logs, claudeConfig, path.join(logs, '-replay-project')]) mkdirSync(dir, { recursive: true });
  const savedCatalog = codexSkillRoute.catalog;
  const savedReady = claudeSkillRoute.catalogReady;
  try {
    return await withEnv({
      PARLEY_HOME: path.join(scratch, 'home'), PARLEY_CLAUDE_BIN: STUB, PARLEY_CODEX_BIN: STUB, PARLEY_GLM_BIN: '',
      PARLEY_SKILL_NAVIGATOR: L['navigator'] === true ? '1' : '0', HARNAS_SKILL_NAVIGATOR: undefined,
      PARLEY_CLAUDE_PROJECTS_DIR: logs, CLAUDE_CONFIG_DIR: claudeConfig,
    }, async () => {
      const catalog = catalogOf(provider, L['navigator'] === true, isRec(L['skills']) ? L['skills'] : { catalogue: 'none', entries: [] });
      codexSkillRoute.catalog = async () => catalog;
      claudeSkillRoute.catalogReady = false;
      const created = await createWork(project, { title: goal.id, goal: '' });
      const workId = created.work.id;
      const registered = provider === 'glm' ? 'codex' : provider;
      const sessionId = await createPendingSession(project, workId, {
        provider: registered, label: '', task: 'synthetic',
        ...(isRec(role) ? { role: { source: 'codex' as const, name: 'custom' } } : {}),
      });
      const base = (await readMap(project, workId)).sessions.find((s) => s.id === sessionId)!;
      const session = { ...base, provider, providerSessionId: FIXED_PROVIDER_SESSION };
      if (mode === 'resume' && provider !== 'codex') writeFileSync(path.join(logs, '-replay-project', `${FIXED_PROVIDER_SESSION}.jsonl`), '{"type":"user"}\n');
      const roleCatalog = isRec(role)
        ? { roles: [{ id: 'codex:custom', source: 'codex' as const, provider: 'codex' as const, name: 'custom', description: '', path: '/fixture/custom.toml', prompt: String(role['customPrompt']), model: null, effort: null, sandboxMode: null, readOnly: false }], diagnostics: [], partial: false }
        : undefined;
      const planner = seams.planner ?? (mode === 'resume' ? planResume : mode === 'new' ? planNew : planLaunch);
      if (!['launch', 'resume', 'new'].includes(mode)) throw new LaunchSetupError(`mode ${mode} is not a launch mode`);
      const options = (routing: CodeModeRouting) => ({
        codeMode: routing, channel: L['channel'] === true, ...(L['agent'] === true ? { agent: AGENT } : {}), ...(roleCatalog === undefined ? {} : { roleCatalog }),
      });
      const real = realpathSync(scratch);
      const maskScratch = (text: string): string => text.split(real).join('<scratch>').split(scratch).join('<scratch>');
      const view = async (routing: CodeModeRouting): Promise<{ view: LaunchView; plan: LaunchPlan | null }> => {
        let plan: LaunchPlan | null = null;
        let threw: string | null = null;
        try { plan = await planner(project, workId, session, options(routing)); } catch (e) { threw = codeOf(e); }
        const brief = threw === null ? await readBrief(project, workId, sessionId) : '';
        const split = plan === null ? { layer: '', rest: '' } : splitArgs(provider, plan.args);
        const report = plan?.codeModeRouting;
        return {
          plan,
          view: {
            layer: split.layer, argvWithoutLayer: maskScratch(maskRevision(split.rest)), env: Object.fromEntries(Object.entries(plan?.env ?? {}).map(([k, v]) => [k, maskScratch(maskRevision(`${k}=${v}`)).slice(k.length + 1)])),
            verdict: { ...(report?.role === undefined ? {} : { role: report.role }), ...(report?.playbook === undefined ? {} : { playbook: report.playbook }), ...(report?.skills === undefined ? {} : { skills: report.skills }) },
            selectsClassic: (() => { const s = selectsClassic(report); return { classic: s.classic, source: s.source }; })(),
            tools: originalToolNames({ ...(provider === 'codex' ? { toolProfile: 'short' as const } : {}), skillNavigator: L['navigator'] === true, ...(L['agent'] === true ? { agent: AGENT } : {}), sessionId }),
            brief, skillCatalogue: catalog === null ? [] : catalog.skills.map((s) => s.name), threw,
          },
        };
      };
      const routing = routingOf(L['routing']);
      // the order the two plans are made in must not matter: a seam lets a test make them the other way round
      const first = seams.order === 'planned-first' ? await view(routing) : await view(CLASSIC_ROUTING);
      const second = seams.order === 'planned-first' ? await view(CLASSIC_ROUTING) : await view(routing);
      const planned = seams.order === 'planned-first' ? first : second;
      const classic = seams.order === 'planned-first' ? second : first;
      return { plan: planned.view, classic: classic.view, bootstrap: bootstrapText(routing), migrated: routing.mode === 'replacement' ? routing.migrated : [] };
    });
  } finally {
    codexSkillRoute.catalog = savedCatalog;
    claudeSkillRoute.catalogReady = savedReady;
    rmSync(scratch, { recursive: true, force: true });
  }
}
