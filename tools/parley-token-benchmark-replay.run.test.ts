// T9a: the replay RUN. One test that judges every goal of the frozen goals file on real processes and writes the report. It is excluded from routine runs by name
// (tools/vitest.config.ts) and run by the gate script through tools/vitest.replay-run.config.ts, with PARLEY_REPLAY_GOALS, PARLEY_REPLAY_SCRIPTS, PARLEY_REPLAY_BUILD and
// PARLEY_REPLAY_REPORT set. It refuses by name and never skips: a missing input, a foreign file, a stale build or a failed check is a failure of the run.
//
// This file owns the fixture mint expression (a static guard keeps it out of every other non-test file) and the `vi.mock` that lets the host log tell a real handler start.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sdkPreflight, writePreload } from './parley-token-benchmark-replay-arms.js';
import { collectFacts, preflightProblems } from './parley-token-benchmark-replay-preflight.js';
import { assembleReport, checkScripts, handlerProbeControl, runAll } from './parley-token-benchmark-replay-run.js';
import { REPORT_HEADER, buildReport, checkGoalFile, runRefusals, type Goal, type ScriptEntry, type Tokenizer } from './parley-token-benchmark-replay.js';
import { loadPinnedTokenizer } from './parley-token-benchmark.js';

vi.mock('../packages/core/dist/index.js', async (orig) => (await import('./parley-token-benchmark-replay-probe.js')).withHandlerProbe(await orig()));

/** The frozen goals file (r3, docs commit fb1673ca) and the scripts file. The scripts sha is the sha256 of tools/read-workflow-scripts.json (a test pins that they agree). */
const EXPECTED_GOALS_SHA = '3df0161491b70da362a707723c8abbd4fcdb0a66cec5bdeeb2ea7d4c2f5ed4ed';
const EXPECTED_SCRIPTS_SHA = '63e53f3f0e2ecd9122bb94c7670df766d58a2a7ac163b4641bb5d394e01beb06';
const FIVE = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'];
const WRAPPERS = ['code_search', 'code_docs', 'code_execute'];

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const scratch = mkdtempSync(path.join(tmpdir(), 'parley-replay-run-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

/** Token counts are a report row, never a verdict: the pinned tokenizer when its directory is given, bytes (and the report says so) when it is not. */
async function tokenizer(): Promise<Tokenizer> {
  const dir = process.env['PARLEY_TOKENIZER_DIR'];
  if (dir !== undefined && dir !== '') { const pinned = await loadPinnedTokenizer(dir); return { name: pinned.label, count: (text) => pinned.count(text) }; }
  return { name: 'utf8 bytes (no tokenizer directory given: these are NOT tokens)', count: (text) => Buffer.byteLength(text, 'utf8') };
}

describe('the T9a replay', () => {
  it('judges every goal of the frozen file, on this build, and writes the report', async () => {
    const goalsPath = process.env['PARLEY_REPLAY_GOALS'];
    const scriptsPath = process.env['PARLEY_REPLAY_SCRIPTS'];
    const reportPath = process.env['PARLEY_REPLAY_REPORT'];
    const stampPath = process.env['PARLEY_REPLAY_BUILD'];

    // 1. the preflight: every refusal named, none skipped
    const facts = await collectFacts({
      repo, goalsPath, expectedGoalsSha: EXPECTED_GOALS_SHA, buildStamp: stampPath,
      goalsSchemaIssues: (text) => { try { const c = checkGoalFile(JSON.parse(text)); return c.ok ? [] : c.issues.map((i) => `${i.path}: ${i.message}`); } catch { return ['not JSON']; } },
      sdk: async () => { const i = await sdkPreflight(); return { root: i.root, version: i.version }; },
      retry: (globalThis as { __vitest_worker__?: { config?: { retry?: number } } }).__vitest_worker__?.config?.retry,
      handlerProbeControl: () => handlerProbeControl(scratch),
    });
    const problems = [...preflightProblems(facts)];
    if (scriptsPath === undefined || scriptsPath === '') problems.push('PARLEY_REPLAY_SCRIPTS is not set: point it at the frozen scripts file');
    if (reportPath === undefined || reportPath === '') problems.push('PARLEY_REPLAY_REPORT is not set: the gate script names where the report goes');
    if (stampPath === undefined || stampPath === '') problems.push('PARLEY_REPLAY_BUILD is not set: the gate script writes the build stamp');
    expect(problems, 'the preflight refuses the run').toEqual([]);

    // 2. the inputs, checked against each other
    const goalsText = facts.goalsText!;
    const scriptsText = readFileSync(scriptsPath!, 'utf8');
    const scriptsSha = sha256(scriptsText);
    const scriptsFile = JSON.parse(scriptsText) as { scripts: ScriptEntry[] };
    const refusals = runRefusals({ goalsText, expectedSha: EXPECTED_GOALS_SHA, scripts: scriptsFile.scripts, scriptsSha, expectedScriptsSha: EXPECTED_SCRIPTS_SHA });
    expect(refusals, 'the run refuses its inputs').toEqual([]);
    const goals: Goal[] = [...(checkGoalFile(JSON.parse(goalsText)) as { goals: readonly Goal[] }).goals];
    const checked = checkScripts(scriptsFile, goals);
    expect(checked.ok ? [] : checked.issues, 'the scripts file does not fit the goals').toEqual([]);
    if (!checked.ok) return;

    // 3. the run, strictly one goal after another
    const preload = writePreload(path.join(scratch, 'preload'), { distDir: path.join(repo, 'packages', 'core', 'dist'), proven: FIVE, mintExpression: 'np.claimFixtureSourceMint()' });
    const tk = await tokenizer();
    const result = await runAll(goals, checked.byGoal, { dir: scratch, distDir: path.join(repo, 'packages', 'core', 'dist'), preloadPath: preload, tokenizer: tk, migrated: FIVE, wrapperNames: WRAPPERS });

    // 4. the report
    const report = buildReport({
      treeHash: facts.treeHash!, goalsSha: sha256(goalsText), scriptsSha, node: facts.node, load: facts.load, label: 'T9a replay', goals, expectedGoalsSha: EXPECTED_GOALS_SHA,
      expectedScriptsSha: EXPECTED_SCRIPTS_SHA, verdicts: result.verdicts, accounting: result.accounting, skipsByArm: result.skipsByArm,
    });
    const full = { ...assembleReport(report, { facts, buildStamp: readFileSync(stampPath!, 'utf8'), conservation: result.conservation, launchSources: result.launchSources }), tokenizer: tk.name, header: REPORT_HEADER };
    writeFileSync(reportPath!, `${JSON.stringify(full, null, 2)}\n`);
    expect(report['failedAt'], 'goals that failed').toEqual([]);
    expect(report['uncovered'], 'goals with no verdict').toEqual([]);
    expect(report['passed']).toBe(true);
  });
});
