// T9a harness, slice H5a: the conservation sources that are judged at LAUNCH PLANNING, not through MCP (lead m-7301): the shipped lead playbooks (recipes) and the skill
// catalogue file a launch installs. Each arm is a launch planned in its OWN scratch (its own store, home and project), and each source is read from there:
//   recipes  per shipped recipe: a lead session of a room that carries the recipe is planned; the source is the playbook text if it sits verbatim in that launch's layer, and
//            empty if it does not (a launch that edited the playbook therefore differs from the one that did not)
//   skills   the native skill catalogue file the launch wrote for the session (the entries `skills/list` returned), as canonical JSON with its per-launch revision left out
// A source that cannot be read is an empty text, and an empty source fails its criterion by name.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILTIN_RECIPES } from '../packages/core/src/recipes/builtin.js';
import { CLASSIC_ROUTING, fixtureRouting, type CodeModeRouting } from '../packages/core/src/work/code-mode-instructions.js';
import { createPendingSession, planLaunch, type LaunchPlan } from '../packages/core/src/work/launch.js';
import { readNativeSkillCatalog } from '../packages/core/src/work/native-context.js';
import { claudeSkillRoute, codexSkillRoute } from '../packages/core/src/work/skill-reduction.js';
import { addRoom } from '../packages/core/src/work/rooms.js';
import { createWork, readMap, updateMap } from '../packages/core/src/work/store.js';
import type { SkillCatalog } from '../packages/core/src/skills/catalog.js';
import { claimProcessHome } from './parley-token-benchmark-replay-busy.js';
import { AGENT, STUB, splitArgs, withEnv } from './parley-token-benchmark-replay-launch.js';

export interface LaunchSources {
  readonly recipes: { readonly classic: string; readonly replacement: string };
  readonly skills: { readonly classic: string; readonly replacement: string };
  /** Where each source was read from, for the report. */
  readonly where: { readonly recipes: string; readonly skills: string };
}

/** The skills the launch is given: two benign ones, as `skills/list` would have returned them. */
const FIXTURE_SKILLS: SkillCatalog = {
  provider: 'codex', diagnostics: [], partial: false,
  skills: [['amber-reader', 'Summarize synthetic amber findings.'], ['plan-checker', 'Check a plan against its acceptance criteria.']].map(([name, description]) => ({ provider: 'codex' as const, documentKind: 'skill' as const, name: name!, description: description!, source: 'user' as const, path: `/fixture/skills/${name}/SKILL.md`, modelAvailable: true, unavailableReason: null })),
};

interface OneArm { readonly recipes: string; readonly skills: string }

async function readOneArm(routing: CodeModeRouting, mutate: ((plan: LaunchPlan) => LaunchPlan) | undefined): Promise<OneArm> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'parley-replay-sources-'));
  const project = path.join(scratch, 'project');
  const claudeConfig = path.join(scratch, 'claude-config');
  const logs = path.join(scratch, 'logs');
  for (const dir of [project, claudeConfig, logs]) mkdirSync(dir, { recursive: true });
  const savedCatalog = codexSkillRoute.catalog;
  const savedReady = claudeSkillRoute.catalogReady;
  try {
    return await withEnv({
      PARLEY_HOME: path.join(scratch, 'home'), PARLEY_CLAUDE_BIN: STUB, PARLEY_CODEX_BIN: STUB, PARLEY_GLM_BIN: '', PARLEY_SKILL_NAVIGATOR: '1', HARNAS_SKILL_NAVIGATOR: undefined,
      PARLEY_CLAUDE_PROJECTS_DIR: logs, CLAUDE_CONFIG_DIR: claudeConfig,
    }, async () => {
      codexSkillRoute.catalog = async () => FIXTURE_SKILLS;
      claudeSkillRoute.catalogReady = false;
      const created = await createWork(project, { title: 'sources', goal: '' });
      const workId = created.work.id;
      const parts: string[] = [];
      let skills = '';
      for (const recipe of BUILTIN_RECIPES) {
        const lead = await createPendingSession(project, workId, { provider: 'codex', label: '', task: 'lead' });
        const member = await createPendingSession(project, workId, { provider: 'codex', label: 'member', task: 'x' });
        await updateMap(project, workId, (map) => { addRoom(map, { title: recipe.name, creator: 'human', members: [lead, member], lead, recipe: { id: recipe.id, name: recipe.name, playbook: recipe.playbook } }); });
        const session = { ...(await readMap(project, workId)).sessions.find((x) => x.id === lead)!, providerSessionId: '7fa0e1ee-cc7b-4a1e-9d4e-0000000000d1' };
        let plan = await planLaunch(project, workId, session, { codeMode: routing, agent: AGENT, channel: true });
        if (mutate !== undefined) plan = mutate(plan);
        const layer = splitArgs('codex', plan.args).layer;
        parts.push(`${recipe.id}\n${layer.includes(recipe.playbook) ? recipe.playbook : ''}`);
        if (skills === '') {
          const revision = plan.env['PARLEY_NATIVE_CONTEXT_REVISION'] ?? '';
          const catalog = await readNativeSkillCatalog(project, workId, lead, revision);
          skills = catalog === null ? '' : JSON.stringify(catalog.skills);
        }
      }
      return { recipes: parts.join('\n---\n'), skills };
    });
  } finally {
    codexSkillRoute.catalog = savedCatalog;
    claudeSkillRoute.catalogReady = savedReady;
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Reads the sources on both arms, each in its own scratch. `migrated` is the replacement arm's routing; `mutate` is a test seam that edits the plan of one arm. */
export async function readLaunchSources(migrated: readonly string[], seams: { readonly mutate?: { readonly arm: 'classic' | 'replacement'; readonly edit: (plan: LaunchPlan) => LaunchPlan } } = {}): Promise<LaunchSources> {
  const release = claimProcessHome('readLaunchSources');
  try {
    const classic = await readOneArm(CLASSIC_ROUTING, seams.mutate?.arm === 'classic' ? seams.mutate.edit : undefined);
    const replacement = await readOneArm(fixtureRouting(migrated), seams.mutate?.arm === 'replacement' ? seams.mutate.edit : undefined);
    return {
      recipes: { classic: classic.recipes, replacement: replacement.recipes }, skills: { classic: classic.skills, replacement: replacement.skills },
      where: { recipes: 'the layer of a planned launch of the lead session of a room that carries each shipped recipe (codex), in a scratch of its own per arm', skills: 'the native skill catalogue file the same launch wrote for the session (codex skills/list entries), in the same scratch' },
    };
  } finally { release(); }
}
