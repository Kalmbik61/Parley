import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OUT,
  FIXTURE_DIR,
  PROMPT_MAX_CHARS,
  assertHostSocketFits,
  beginRun,
  buildLabelSheet,
  buildReport,
  collectClaudeSession,
  collectCodexSessions,
  collectCodexTranscript,
  collectRun,
  dryRun,
  estimateBudget,
  extractPrompts,
  findMcpServerNames,
  hashTree,
  hostEnv,
  isEmptyFindSkillResult,
  loadFixtures,
  main,
  median,
  nearestRank,
  pairSection,
  parseRun,
  planRuns,
  renderReport,
  renderRunSheet,
  runIdOf,
  safeForPrivateData,
  validateBudget,
  validateScenarioFile,
  type BeginRecord,
  type Budget,
  type RunRecord,
} from './parley-token-benchmark.js';
import type { UsageSummary } from '../packages/core/src/work/usage-ledger.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'parley-bench-test-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const WARM = { warmWithinSec: 240 };

/** Поиск мода jev без чтения настоящего `~/.claude`: мода «нет». */
const noJev = async (): Promise<string[]> => [];

/** Поиск `.mcp.json` без чтения файлов домашней папки: серверов «нет». */
const noMcp = async (): Promise<{ names: string[]; warnings: string[] }> => ({ names: [], warnings: [] });

async function syntheticRuns(): Promise<RunRecord[]> {
  const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'runs.synthetic.json'), 'utf8')) as unknown[];
  return raw.map((item) => {
    const parsed = parseRun(item);
    if ('problems' in parsed) throw new Error(parsed.problems.join('; '));
    return parsed.run;
  });
}

const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalInput: 130,
  source: 'native-index', observedAt: '2026-10-06T10:00:00.000Z', stale: false, completeness: 'complete', coverage: 'conversation',
  ...over,
});

/** Запись прогона с минимумом полей: остальное неизвестно. */
async function oneRun(over: Partial<RunRecord> = {}): Promise<RunRecord> {
  const [first] = await syntheticRuns();
  return { ...first!, ...over };
}

describe('фикстуры сценариев', () => {
  it('сценарии, задачи, навыки и бюджет согласованы', async () => {
    const { file, problems } = await loadFixtures();
    expect(problems).toEqual([]);
    expect(file.scenarios).toHaveLength(14);
  });

  it('проверка сценариев ловит пропущенное покрытие и битую ссылку на задачу', async () => {
    const { file } = await loadFixtures();
    const broken = { ...file, scenarios: file.scenarios.filter((s) => s.coverage !== 'compaction').map((s, i) => (i === 0 ? { ...s, task: 'нет такой' } : s)) };
    const problems = validateScenarioFile(broken);
    expect(problems).toContain('нет сценария для покрытия compaction');
    expect(problems.some((p) => p.includes('нет задачи'))).toBe(true);
  });
});

describe('план и бюджет', () => {
  it('матрица: одна ячейка на сценарий, руку и повтор, без тёплых прогонов; отдельные оси, пилот и потолки', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length);
    // wq, wq-codex, wq-glm: по 5 сценариев × 2 руки × 3 повтора; w1: 6 × 2; w2: 3 × 2; jev: 5; навык: 3 сценария × 2 руки.
    expect(runs).toHaveLength(3 * (5 * 2 * 3) + 6 * 2 + 3 * 2 + 5 + 3 * 2);
    expect(runs.every((r) => r.cache === 'cold')).toBe(true);
    expect(runs.filter((r) => r.jev === 'on').every((r) => r.arm === 'native')).toBe(true);
    const estimate = estimateBudget(runs, budget);
    expect(estimate.sessions).toBe(runs.reduce((acc, r) => acc + r.sessions, 0));
    expect(estimate.pilotRuns).toBe(4);
    expect(estimate.ceilings.outputTokens).toBe(estimate.sessions * budget.perSession.maxOutputTokens);
    expect(estimate.byWave.map((w) => w.wave)).toEqual(['wq', 'wq-codex', 'wq-glm', 'w1', 'w2', 'w3']);
    expect(budget.cache.ttlSec).toBe(3600);
  });

  it('волна wq: пять сценариев, обе руки, jev и навык выключены, три повтора, руки чередуются; --wave оставляет только её', async () => {
    const { file, budget } = await loadFixtures();
    const wq = planRuns(file, budget, 'wq');
    expect(wq).toHaveLength(30);
    expect(wq.map((r) => r.order)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(wq.every((r) => r.wave === 'wq' && r.jev === 'off' && r.skill === 'off' && r.cache === 'cold' && !r.pilot)).toBe(true);
    expect([...new Set(wq.map((r) => r.scenario))]).toEqual(['ambiguous', 'russian', 'multiple', 'long-skill', 'unavailable']);
    expect(wq.filter((r) => r.scenario === 'ambiguous').map((r) => r.id)).toEqual(expect.arrayContaining([
      'ambiguous.native.cold.jev-off.skill-off.r1', 'ambiguous.navigator.cold.jev-off.skill-off.r3',
    ]));
    // Порядок рук чередуется: первая в ячейке то native, то navigator.
    const firsts = [0, 2, 4, 6].map((i) => wq[i]!.arm);
    expect(firsts).toEqual(['native', 'navigator', 'native', 'navigator']);
    // Повторы другой волны остаются общими из бюджета.
    expect(planRuns(file, budget, 'w1').every((r) => r.repetition === 1)).toBe(true);
    expect(planRuns(file, budget, 'w3').every((r) => r.wave === 'w3')).toBe(true);
    expect(planRuns(file, budget, 'нет такой')).toEqual([]);
  });

  it('plan --wave wq пишет в план и лист только прогоны этой волны; неизвестная волна — отказ', async () => {
    const out = path.join(tmp, 'out-wave');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['plan', '--out', out, '--home', '/bench/home', '--wave', 'wq'])).toBe(0);
      const plan = JSON.parse(await readFile(path.join(out, 'plan.json'), 'utf8')) as { runs: { wave: string }[]; estimate: { runs: number } };
      expect(plan.runs).toHaveLength(30);
      expect(plan.runs.every((r) => r.wave === 'wq')).toBe(true);
      expect(plan.estimate.runs).toBe(30);
      const sheet = await readFile(path.join(out, 'run-sheet.md'), 'utf8');
      expect(sheet).toContain('ambiguous.native.cold.jev-off.skill-off.r3');
      expect(sheet).not.toContain('no-skill.native');

      const all = path.join(tmp, 'out-all');
      expect(await main(['plan', '--out', all, '--home', '/bench/home'])).toBe(0);
      expect((JSON.parse(await readFile(path.join(all, 'plan.json'), 'utf8')) as { runs: unknown[] }).runs).toHaveLength(119);
      await expect(main(['plan', '--out', all, '--home', '/bench/home', '--wave', 'нет такой'])).rejects.toThrow('нет волны');
    } finally {
      log.mockRestore();
    }
  });

  it('повторы волны в бюджете — целое больше 0', async () => {
    const { file, budget } = await loadFixtures();
    const bad = { ...budget, waves: budget.waves.map((w) => (w.id === 'wq' ? { ...w, repetitions: 0 } : w)) };
    expect(validateBudget(bad, file)).toContain('budget.waves wq: repetitions — целое больше 0');
    expect(validateBudget(budget, file)).toEqual([]);
  });

  it('у руки disabled навигатор выключен в хосте, у остальных navigator включён; навыки Parley и jev задаёт хост одинаково в обеих руках', async () => {
    const { file } = await loadFixtures();
    const byId = (id: string) => file.scenarios.find((s) => s.id === id)!;
    // DISABLE_AUTOUPDATER=1: CLI не обновляется посреди волны, версия у пар одна.
    expect(hostEnv({ arm: 'navigator', jev: 'off' }, byId('obvious'))).toEqual([
      'PARLEY_SKILL_NAVIGATOR=true', 'PARLEY_AGENT_SKILLS=false', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0', 'DISABLE_AUTOUPDATER=1',
    ]);
    expect(hostEnv({ arm: 'native', jev: 'on' }, byId('obvious'))).toContain('DISABLE_AUTOUPDATER=1');
    expect(hostEnv({ arm: 'navigator', jev: 'off' }, byId('disabled'))[0]).toBe('PARLEY_SKILL_NAVIGATOR=false');
    expect(hostEnv({ arm: 'native', jev: 'off' }, byId('obvious'))[0]).toBe('PARLEY_SKILL_NAVIGATOR=false');
    expect(hostEnv({ arm: 'native', jev: 'on' }, byId('obvious'))[2]).toBe('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1');
  });

  it('лист запуска называет запрос, шаги, принятие и сбор для каждого прогона', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    const sheet = renderRunSheet(runs, file, budget, '/out');
    for (const run of runs) expect(sheet).toContain(`## ${String(run.order).padStart(2, '0')}. ${run.id}`);
    expect(sheet).toContain('node scripts/check-changelog.mjs 4711');
    expect(sheet).toContain('Принятие человеком');
    expect(sheet).toContain('явного разрешения человека');
    // Кеш: без намеренного прогрева, тёплых прогонов в листе нет.
    expect(sheet).toContain('без намеренного прогрева');
    expect(sheet).toContain('`firstRequest`');
    expect(sheet).not.toContain('Тёплый прогон');
    expect(sheet).not.toContain('кеш warm');
    expect(sheet).toContain('DISABLE_AUTOUPDATER=1');
    expect(sheet).toContain('cli-version-mismatch');
  });
});

describe('запись прогона', () => {
  it('отсутствующие счётчики — неизвестно, а не ноль', async () => {
    const run = await oneRun();
    const raw = JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
    raw['skillUse'] = { lookups: 2 };
    raw['durationMs'] = 'долго';
    const parsed = parseRun(raw);
    expect('run' in parsed).toBe(true);
    if ('run' in parsed) {
      expect(parsed.run.skillUse['lookups']).toBe(2);
      expect(parsed.run.skillUse['loads']).toBeNull();
      expect(parsed.run.durationMs).toBeNull();
    }
  });

  it('оценка токенов (символы/4, размер списка) отвергается как измерение', async () => {
    const raw = JSON.parse(JSON.stringify(await oneRun())) as Record<string, unknown>;
    raw['estimatedTokens'] = 750;
    (raw['bytes'] as Record<string, unknown>)['listingCharsDiv4'] = 750;
    const parsed = parseRun(raw);
    expect('problems' in parsed && parsed.problems.filter((p) => p.includes('оценка'))).toHaveLength(2);
  });
});

describe('учёт токенов в записи', () => {
  it('разговор в двух видах и потомок, названный и у родителя, и отдельной записью, входят один раз', async () => {
    const child = { key: 'claude\u0000kid\u0000', usage: summary({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalInput: 1 }) };
    const parent = { key: 'claude\u0000main\u0000', usage: summary() };
    const run = await oneRun({
      usage: [
        { ...parent, descendants: [child] },
        // Тот же разговор во втором виде (побеждает более свежее наблюдение) и тот же потомок отдельной записью.
        { ...parent, usage: summary({ observedAt: '2026-10-06T10:05:00.000Z' }) },
        child,
      ],
    });
    const { sumUsage } = await import('../packages/core/src/work/usage-ledger.js');
    expect(sumUsage(run.usage)).toMatchObject({ input: 11, output: 6, cacheRead: 100, cacheWrite: 20, totalInput: 131, conversations: 2, completeness: 'complete' });
  });

  it('неполный итог не даёт разности токенов, но время и счётчики остаются; недостающий счётчик — неизвестно', async () => {
    const [base, test] = await Promise.all([
      oneRun({ id: 'a', accepted: true }),
      oneRun({
        id: 'b', accepted: true,
        conditions: { ...(await oneRun()).conditions, arm: 'navigator' },
        usage: [{ key: 'claude\u0000x\u0000', usage: summary({ completeness: 'partial', cacheWrite: null }) }],
        durationMs: 70000,
      }),
    ]);
    const baseCond = { ...base.conditions, arm: 'native' as const, cache: 'cold' as const, jev: 'off' as const, skill: 'off' as const };
    const section = pairSection(
      [{ ...base, conditions: baseCond }, { ...test, conditions: { ...test.conditions, cache: 'cold', jev: 'off', skill: 'off' } }],
      'arm', 'cold', { jev: 'off', skill: 'off' }, WARM,
    );
    expect(section.clean).toHaveLength(1);
    const stat = (name: string) => section.stats.find((s) => s.metric === name)!;
    expect(stat('totalInput')).toMatchObject({ known: 0, unknown: 1, median: null });
    expect(stat('cacheWrite')).toMatchObject({ known: 0, unknown: 1 });
    expect(stat('durationMs')).toMatchObject({ known: 1, median: 70000 - base.durationMs! });
  });
});

describe('парные разности по фикстурным прогонам', () => {
  it('основная ось, холодный кеш: медиана, p90 и хвосты, неполные данные отдельно', async () => {
    const { file } = await loadFixtures();
    const report = buildReport(await syntheticRuns(), file, WARM);
    const cold = report.sections.find((s) => s.axis === 'arm' && s.cache === 'cold')!;
    const stat = (name: string) => cold.stats.find((s) => s.metric === name)!;

    expect(cold.candidates).toBe(14);
    expect(cold.clean).toHaveLength(13);
    expect(cold.regressions).toEqual([{ pair: 'unavailable r1', reasons: ['not-accepted'] }]);
    expect(cold.qualityUnknown).toBe(1);

    // Пара broadcast неполная по usage, пара mixed — без cacheWrite у Codex: цифры неизвестны, нулями не стали.
    expect(stat('totalInput')).toMatchObject({ known: 12, unknown: 1, median: -3250, p90: 0, max: 500, min: -6000, lower: 10, equal: 1, higher: 1 });
    expect(stat('cacheWrite')).toMatchObject({ known: 11, unknown: 2, median: -3000 });
    expect(stat('totalInput').worstPair).toBe('compaction.navigator.cold.jev-off.skill-off.r1');
    expect(stat('output')).toMatchObject({ median: 20, lower: 0, higher: 12 });
    // Байты — отдельная группа, в токены не переводятся.
    expect(stat('listingBytes')).toMatchObject({ group: 'bytes', median: -27000 });
    expect(stat('deliveries')).toMatchObject({ known: 1, unknown: 12 });
    expect(report.incompleteRuns).toContainEqual({ run: 'broadcast.navigator.cold.jev-off.skill-off.r1', why: ['usage partial'] });
  });

  it('холодный и тёплый кеш — разные разделы; тёплый без интервала или за TTL исключён', async () => {
    const { file } = await loadFixtures();
    const report = buildReport(await syntheticRuns(), file, WARM);
    const warm = report.sections.find((s) => s.axis === 'arm' && s.cache === 'warm')!;
    expect(warm.excluded).toEqual(expect.arrayContaining([
      { pair: 'long-skill r1', reason: 'warm-ttl-exceeded' },
      { pair: 'stop-resume r1', reason: 'warm-interval-unknown' },
    ]));
    expect(warm.clean).toHaveLength(4);
    expect(warm.stats.find((s) => s.metric === 'cacheRead')).toMatchObject({ median: -5250, max: -4000 });
  });

  it('jev и навык — отдельные оси; сторона без признаков оси не сравнивается', async () => {
    const { file } = await loadFixtures();
    const report = buildReport(await syntheticRuns(), file, WARM);
    const jev = report.sections.find((s) => s.axis === 'jev')!;
    expect(jev.clean).toHaveLength(4);
    expect(jev.excluded).toEqual([{ pair: 'multiple r1', reason: 'axis-unverified' }]);
    expect(jev.stats.find((s) => s.metric === 'cacheWrite')).toMatchObject({ median: 3000 });

    const skills = report.sections.filter((s) => s.axis === 'skill');
    expect(skills.map((s) => s.label)).toEqual(['skill (arm=native) (jev=off)', 'skill (arm=navigator) (jev=off)']);
    expect(skills[0]!.clean).toHaveLength(3);
    expect(skills[1]!.excluded).toEqual([{ pair: 'long-skill r1', reason: 'axis-unverified' }]);
  });

  it('пары с разными хешами, неизвестным принятием или принятой базой без принятого результата не сравниваются', async () => {
    const runs = await syntheticRuns();
    const pick = (id: string) => runs.find((r) => r.id === id)!;
    const baseId = 'no-skill.native.cold.jev-off.skill-off.r1';
    const testId = 'no-skill.navigator.cold.jev-off.skill-off.r1';
    const only = (changed: RunRecord[]) => pairSection(changed, 'arm', 'cold', { jev: 'off', skill: 'off' }, WARM);

    const mismatch = only([pick(baseId), { ...pick(testId), conditions: { ...pick(testId).conditions, hashes: { ...pick(testId).conditions.hashes, project: 'другой' } } }]);
    expect(mismatch.excluded).toEqual([{ pair: 'no-skill r1', reason: 'conditions-mismatch:hashes.project' }]);
    expect(only([pick(baseId), { ...pick(testId), accepted: null }]).excluded[0]?.reason).toBe('acceptance-unknown');
    expect(only([{ ...pick(baseId), accepted: false }, pick(testId)]).excluded[0]?.reason).toBe('baseline-not-accepted');
    // Меньше токенов, но больше правок человека: экономией не считается.
    const worse = only([{ ...pick(baseId), quality: { constraintsKept: true, humanCorrections: 0 } }, { ...pick(testId), quality: { constraintsKept: true, humanCorrections: 2 } }]);
    expect(worse.clean).toEqual([]);
    expect(worse.regressions[0]?.reasons).toEqual(['more-human-corrections']);
  });

  it('отчёт: офлайн-данные не заявляют экономию, живые не дают вердикта и процентов', async () => {
    const { file } = await loadFixtures();
    const runs = await syntheticRuns();
    const offline = renderReport(buildReport(runs, file, WARM));
    expect(offline).toContain('экономия не заявляется');
    expect(offline).toContain('Байты (диагностика, не токены)');
    expect(offline).not.toMatch(/%/);
    expect(offline).toContain('| Сценарий | Покрытие |');

    const live = renderReport(buildReport(runs.map((r) => ({ ...r, origin: 'live' as const })), file, WARM));
    expect(live).toContain('не вердикт');
    expect(live).not.toContain('экономия не заявляется');
  });

  it('условия приёмки: поиск сверх потолка, запрещённый навык в выдаче, ожидаемый навык не загружен', async () => {
    const { file } = await loadFixtures();
    const runs = await syntheticRuns();
    const base = runs.find((r) => r.id === 'obvious.navigator.cold.jev-off.skill-off.r1')!;
    const bad: RunRecord = {
      ...base, id: 'bad',
      skillUse: { ...base.skillUse, lookups: 5 }, offeredSkills: ['bench-unavailable'], loadedSkills: [],
    };
    const report = buildReport([bad], file, WARM);
    expect(report.violations.map((v) => v.rule).sort()).toEqual(['expected-skill-not-loaded', 'forbidden-offered', 'lookups-over-limit']);
  });

  it('медиана и процентиль по ближайшему рангу', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(nearestRank([5], 90)).toBe(5);
  });
});

/** Транскрипт Claude Code: одна запись на блок content, каждая несёт usage всего ответа. */
const line = (value: Record<string, unknown>): string => `${JSON.stringify({ sessionId: 's1', ...value })}\n`;
const usage = (input: number, output: number, read: number, write: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

async function claudeTranscript(): Promise<string> {
  const dir = path.join(tmp, 'projects', '-bench');
  await mkdir(path.join(dir, 's1', 'subagents'), { recursive: true });
  const at = (s: number) => `2026-10-06T10:00:${String(s).padStart(2, '0')}.000Z`;
  const msg1 = { id: 'msg_1', role: 'assistant', model: 'claude-x', usage: usage(10, 5, 100, 20) };
  const msg2 = { id: 'msg_2', role: 'assistant', model: 'claude-x', usage: usage(1, 2, 120, 0) };
  await writeFile(
    path.join(dir, 's1.jsonl'),
    line({ type: 'attachment', timestamp: at(0), attachment: { type: 'skill_listing', names: ['bench-changelog', 'minimal-development'], isInitial: true } }) +
      line({ type: 'user', timestamp: at(1), message: { role: 'user', content: 'add changelog\n<skill_relevance>\nRelevant to the current request: bench-changelog.\n</skill_relevance>' } }) +
      // Один ответ — три записи с одним message.id: токены считаются один раз.
      line({ type: 'assistant', timestamp: at(2), message: { ...msg1, content: [{ type: 'text', text: 'ищу' }] } }) +
      line({ type: 'assistant', timestamp: at(2), message: { ...msg1, content: [tool('t1', 'mcp__parley__find_skill', { query: 'changelog' })] } }) +
      line({ type: 'assistant', timestamp: at(2), message: { ...msg1, content: [tool('t2', 'mcp__parley__find_skill', { query: 'journal' })] } }) +
      line({ type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No skill matched: work without one, or try other words once' }] } }) +
      line({ type: 'user', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '1. bench-changelog — add an entry' }] }] } }) +
      line({ type: 'assistant', timestamp: at(5), message: { ...msg2, content: [tool('t3', 'Skill', { skill: 'bench-changelog' }), tool('t4', 'Skill', { skill: 'bench-changelog' }), tool('t5', 'mcp__parley__send_message', { room: 'r-1', text: 'готово' })] } }) +
      line({ type: 'system', subtype: 'compact_boundary', timestamp: at(6) }),
  );
  await writeFile(
    path.join(dir, 's1', 'subagents', 'agent-a1.jsonl'),
    line({ type: 'assistant', isSidechain: true, agentId: 'a1', timestamp: at(7), message: { id: 'msg_sub', role: 'assistant', content: [tool('s1', 'mcp__parley__find_skill', { query: 'x' })], usage: usage(3, 3, 0, 30) } }),
  );
  return path.join(dir, 's1.jsonl');
}

describe('сбор из логов провайдеров', () => {
  it('Claude: токены один раз на ответ и вместе с подагентом, счётчики навыков, писем, сжатий и признаки осей', async () => {
    const file = await claudeTranscript();
    const collected = await collectClaudeSession(file, ['bench-changelog', 'bench-unavailable', 'minimal-development']);

    expect(collected.entry.usage).toMatchObject({ input: 14, output: 10, cacheRead: 220, cacheWrite: 50, totalInput: 284, coverage: 'conversation-and-descendants', completeness: 'complete' });
    expect(collected.skillUse).toMatchObject({ lookups: 3, loads: 2, duplicateLoads: 1, noMatch: 1, reformulations: 1 });
    expect(collected.offered).toEqual(['bench-changelog']);
    expect(collected.traffic).toMatchObject({ messages: 1, broadcasts: 1 });
    expect(collected.compactions).toBe(1);
    expect(collected.jevFired).toBe(true);
    expect(collected.listedNames).toEqual(['bench-changelog', 'minimal-development']);
    expect(collected.bytes['findSkillResultBytes']).toBeGreaterThan(0);
    // В списке этого транскрипта нет `content`, а стартовой вставки в логе Claude нет вовсе: неизвестно, а не 0.
    expect(collected.bytes['listingBytes']).toBeNull();
    expect(collected.bytes['bootstrapBytes']).toBeNull();
  });

  it('Claude: «ничего не найдено» узнаётся и в настоящем JSON-ответе find_skill (message), включая второй промах, и по прежнему префиксу; найденное не считается', async () => {
    const dir = path.join(tmp, 'projects', '-bench-nomatch');
    await mkdir(dir, { recursive: true });
    const reply = (id: string, toolId: string) => line({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-x', usage: usage(1, 1, 0, 0), content: [tool(toolId, 'mcp__parley__find_skill', { query: 'q' })] } });
    const result = (toolId: string, text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }] } });
    const json = (extra: Record<string, unknown>) => JSON.stringify({ provider: 'claude', skills: [], ...extra }, null, 2);
    const found = JSON.stringify({ provider: 'claude', skills: [{ name: 'bench-changelog', description: 'No skill matched is only a phrase here' }] }, null, 2);
    const file = path.join(dir, 'nomatch.jsonl');
    await writeFile(
      file,
      reply('m1', 't1') + result('t1', found) +
        reply('m2', 't2') + result('t2', json({ message: 'No skill matched: work without one, or try other words once' })) +
        reply('m3', 't3') + result('t3', json({ message: 'No skill matched again: stop searching and work without one' })) +
        reply('m4', 't4') + result('t4', 'No skill matched: work without one, or try other words once'),
    );

    const collected = await collectClaudeSession(file, ['bench-changelog']);
    expect(collected.skillUse).toMatchObject({ lookups: 4, noMatch: 3 });
    expect(collected.offered).toEqual(['bench-changelog']);
  });

  it('isEmptyFindSkillResult: префикс, JSON с message, обёртка MCP, шапка exec; найденное, чужой JSON, обычный текст и слишком глубокая вложенность — нет', () => {
    const miss = JSON.stringify({ provider: 'claude', skills: [], message: 'No skill matched: try other words once' });
    const wrapped = (inner: string) => JSON.stringify({ content: [{ type: 'text', text: inner }] });
    const header = 'Script completed\nWall time 1.0 seconds\nOutput:\n';
    expect(isEmptyFindSkillResult('No skill matched: x')).toBe(true);
    expect(isEmptyFindSkillResult(miss)).toBe(true);
    expect(isEmptyFindSkillResult(wrapped(miss))).toBe(true);
    expect(isEmptyFindSkillResult(header + wrapped(miss))).toBe(true);
    expect(isEmptyFindSkillResult(JSON.stringify({ provider: 'claude', skills: [{ name: 'a' }] }))).toBe(false);
    expect(isEmptyFindSkillResult(JSON.stringify({ message: 'something else' }))).toBe(false);
    expect(isEmptyFindSkillResult(wrapped(JSON.stringify({ skills: [] })))).toBe(false);
    expect(isEmptyFindSkillResult(header)).toBe(false);
    expect(isEmptyFindSkillResult('1. bench-changelog — add an entry')).toBe(false);
    expect(isEmptyFindSkillResult('[1,2')).toBe(false);
    expect(isEmptyFindSkillResult(wrapped(wrapped(wrapped(wrapped(miss)))))).toBe(false);
  });

  it('Claude: jevFired даёт вставка в настоящем виде — вложение hook_additional_context; та же фраза в другом месте и запись подагента — нет', async () => {
    const dir = path.join(tmp, 'projects', '-bench-jev');
    await mkdir(dir, { recursive: true });
    const phrase = 'Relevant to the current request: bench-changelog. Ignore this if it does not fit.';
    const hook = (content: unknown, extra: Record<string, unknown> = {}) =>
      line({ type: 'attachment', attachment: { type: 'hook_additional_context', content, hookName: 'prompt.submit', hookEvent: 'UserPromptSubmit', toolUseID: 'h1' }, ...extra });
    const ask = line({ type: 'user', message: { role: 'user', content: 'add changelog' } });
    const reply = (text: string) => line({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'claude-x', usage: usage(1, 1, 0, 0), content: [{ type: 'text', text }] } });
    const fired = async (name: string, body: string): Promise<boolean> => {
      await writeFile(path.join(dir, `${name}.jsonl`), body);
      return (await collectClaudeSession(path.join(dir, `${name}.jsonl`), [])).jevFired;
    };

    expect(await fired('block', ask + hook([`<skill_relevance>\n${phrase}\n</skill_relevance>`]) + reply('ok'))).toBe(true);
    expect(await fired('plain', ask + hook(phrase) + reply('ok'))).toBe(true);
    // Те же слова в результате инструмента, ответе ассистента, другом вложении, чужом ответе хука и в записи подагента.
    const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: phrase }] } });
    const queued = line({ type: 'attachment', attachment: { type: 'queued_command', prompt: phrase } });
    expect(await fired('elsewhere', ask + toolResult + queued + hook(['<system-reminder>hook без выбора навыка</system-reminder>']) + reply(phrase))).toBe(false);
    expect(await fired('sidechain', ask + hook([phrase], { isSidechain: true }) + reply('ok'))).toBe(false);
  });

  it('запись прогона: условия из begin, принятие и счётчики оператора; невидимое остаётся неизвестным', async () => {
    const file = await claudeTranscript();
    const { file: scenarios, budget } = await loadFixtures();
    const planned = planRuns(scenarios, budget).find((r) => r.id === 'obvious.navigator.cold.jev-off.skill-on.r1')!;
    const begin = await beginRun(planned, budget, tmp, { mcpServerNames: noMcp, versions: () => ({ claude: '2.1.289', codex: '0.160.0' }), jevPluginIds: noJev });
    const run = await collectRun({
      begin, claude: [file], codex: [], accepted: true, constraintsKept: true, humanCorrections: 0, warmIntervalSec: null,
      set: ['launches=1', 'stops=0'], knownSkills: ['bench-changelog', 'minimal-development'], origin: 'live',
    });

    expect(run.conditions).toMatchObject({ arm: 'navigator', cache: 'cold', skill: 'on', cli: 'claude 2.1.289; codex 0.160.0' });
    expect(run.process).toMatchObject({ launches: 1, stops: 0, resumes: null, retries: null, compactions: 1 });
    expect(run.durationMs).toBe(6000);
    // minimal-development назван в списке имён транскрипта, а тело не загружалось: загрузка не наблюдалась.
    expect(run.axisEvidence).toEqual({ minimalDevelopmentListed: true, minimalDevelopmentLoaded: null, jevFired: true });
    expect(parseRun(JSON.parse(JSON.stringify(run)))).toHaveProperty('run');
  });

  it('Codex: токены накопителя, cacheWrite неизвестен, порождённый тред входит в родителя один раз', async () => {
    const meta = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'session_meta', timestamp: '2026-10-06T10:00:00.000Z', payload: { id, cwd: '/x', ...extra } });
    const count = (total: number, cached: number, output: number) =>
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-06T10:00:09.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: cached, output_tokens: output } } } });
    const parent = path.join(tmp, 'parent.jsonl');
    const child = path.join(tmp, 'child.jsonl');
    await writeFile(parent, `${meta('p1')}\n${count(1000, 400, 50)}\n${count(1500, 900, 80)}\n`);
    await writeFile(child, `${meta('c1', { parent_thread_id: 'p1', source: 'exec' })}\n${count(200, 0, 20)}\n`);

    const collected = await collectCodexSessions([parent, child]);
    expect(collected.orphans).toBe(0);
    expect(collected.entries).toHaveLength(1);
    expect(collected.entries[0]!.descendants).toHaveLength(1);
    const { sumUsage } = await import('../packages/core/src/work/usage-ledger.js');
    expect(sumUsage(collected.entries)).toMatchObject({ totalInput: 1700, output: 100, cacheRead: 900, cacheWrite: null });
  });
});

describe('копия фикстурного проекта', () => {
  it('навыки лежат в родных каталогах копии, minimal-development только на оси навыка, копия — git-репозиторий', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    const off = runs.find((r) => r.id === 'obvious.native.cold.jev-off.skill-off.r1')!;
    const on = runs.find((r) => r.id === 'obvious.native.cold.jev-off.skill-on.r1')!;
    const versions = () => ({ claude: 'x', codex: 'y' });
    const a = await beginRun(off, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: noJev });
    const b = await beginRun(on, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: noJev });

    const exists = async (dir: string, name: string) => readFile(path.join(dir, name, 'SKILL.md'), 'utf8').then(() => true, () => false);
    for (const home of ['.agents/skills', '.claude/skills']) {
      expect(await exists(path.join(a.projectDir, home), 'bench-changelog')).toBe(true);
      expect(await exists(path.join(a.projectDir, home), 'minimal-development')).toBe(false);
      expect(await exists(path.join(b.projectDir, home), 'minimal-development')).toBe(true);
    }
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: a.projectDir, encoding: 'utf8' }).stdout).toBe('');
    expect(a.conditions.hashes['minimalDevelopment']).toBe(b.conditions.hashes['minimalDevelopment']);
    expect(a.conditions.hashes['project']).toBe(b.conditions.hashes['project']);
  });
});

describe('мод jev при begin', () => {
  const MOD = 'jev-skill-suggestion@skills-dir';
  const versions = () => ({ claude: 'x', codex: 'y' });
  /** Каталог `.claude` копии: стенд кладёт туда только навыки фикстуры, настроек Claude Code не пишет. */
  const claudeDirOf = (projectDir: string) => readdir(path.join(projectDir, '.claude'));
  /** Холодный прогон без навыка minimal-development: рука native или navigator, jev off или on. */
  async function pickRun(jev: 'off' | 'on', arm: 'native' | 'navigator' = 'native') {
    const { file, budget } = await loadFixtures();
    const run = planRuns(file, budget).find((r) => r.jev === jev && r.arm === arm && r.cache === 'cold' && r.skill === 'off')!;
    return { run, budget };
  }
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('jev off, мод установлен: begin отказывает в обеих руках до копирования и любых записей', async () => {
    const ids = [MOD, 'jev-skill-suggestion@some-market'];
    for (const arm of ['native', 'navigator'] as const) {
      const { run, budget } = await pickRun('off', arm);
      const refusal = beginRun(run, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: async () => ids });
      await expect(refusal).rejects.toThrow(`мод jev установлен (${ids.join(', ')})`);
      await expect(refusal).rejects.toThrow('Удалите мод до волны');
    }
    // До первой записи не создан ни каталог работы, ни копия, ни begin.json.
    expect(await readdir(tmp)).toEqual([]);
  });

  it('отказ из-за мода не стирает прежнюю копию того же прогона', async () => {
    const { run, budget } = await pickRun('off');
    const first = await beginRun(run, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: noJev });
    const marker = path.join(first.projectDir, 'marker.txt');
    await writeFile(marker, 'прежняя копия');
    await expect(beginRun(run, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: async () => [MOD] })).rejects.toThrow('мод jev установлен');
    expect(await readFile(marker, 'utf8')).toBe('прежняя копия');
  });

  it('jev off, мод не установлен (пустой список): копия без настроек Claude Code, jevInstalled пуст', async () => {
    const { run, budget } = await pickRun('off');
    const begin = await beginRun(run, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: noJev });
    expect(await claudeDirOf(begin.projectDir)).toEqual(['skills']);
    expect(begin.jevInstalled).toEqual([]);
    const saved = JSON.parse(await readFile(path.join(tmp, 'work', run.id, 'begin.json'), 'utf8')) as BeginRecord;
    expect(saved.jevInstalled).toEqual([]);
  });

  it('jev off, место установки не прочиталось (null): begin отказывает и ничего не создаёт', async () => {
    const { run, budget } = await pickRun('off');
    await expect(beginRun(run, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: async () => null })).rejects.toThrow('выключение jev не проверить');
    expect(await readdir(tmp)).toEqual([]);
  });

  it('jev on: мод не ищется, настроек Claude Code в копии нет', async () => {
    const { run, budget } = await pickRun('on');
    const begin = await beginRun(run, budget, tmp, { mcpServerNames: noMcp, versions, jevPluginIds: async () => { throw new Error('при jev on мод не ищется'); } });
    expect(await claudeDirOf(begin.projectDir)).toEqual(['skills']);
    expect(begin.jevInstalled).toEqual([]);
  });

  it('мод ищется там же, где у Parley: <HOME>/.claude по умолчанию и CLAUDE_CONFIG_DIR, относительный — от копии проекта', async () => {
    const installAt = async (config: string) => {
      const dir = path.join(config, 'skills', 'jev-skill-suggestion', '.claude-plugin');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'plugin.json'), '{"name":"jev-skill-suggestion"}');
    };
    const native = await pickRun('off');
    const navigator = await pickRun('off', 'navigator');

    // Пустой CLAUDE_CONFIG_DIR — как незаданный.
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('HOME', path.join(tmp, 'user'));
    expect((await beginRun(native.run, native.budget, tmp, { mcpServerNames: noMcp, versions })).jevInstalled).toEqual([]);
    await installAt(path.join(tmp, 'user', '.claude'));
    await expect(beginRun(native.run, native.budget, tmp, { mcpServerNames: noMcp, versions })).rejects.toThrow(`мод jev установлен (${MOD})`);

    // Копия проекта — <tmp>/work/<id>/project, поэтому `../../cfg` — это <tmp>/work/cfg.
    vi.stubEnv('HOME', path.join(tmp, 'empty-home'));
    await installAt(path.join(tmp, 'work', 'cfg'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '../../cfg');
    await expect(beginRun(navigator.run, navigator.budget, tmp, { mcpServerNames: noMcp, versions })).rejects.toThrow(`мод jev установлен (${MOD})`);
  });
});

describe('дом хоста стенда и путь сокета', () => {
  it('лист запуска: PARLEY_HOME по умолчанию <out>/home, а с заданным home — он; jev off требует удалить мод, диалог MCP закрывает оператор', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    expect(renderRunSheet(runs, file, budget, '/out')).toContain('`PARLEY_HOME=/out/home ');

    const sheet = renderRunSheet(runs, file, budget, '/out', '/short/home');
    expect(sheet).toContain('`PARLEY_HOME=/short/home ');
    expect(sheet).not.toContain('PARLEY_HOME=/out/home');
    expect(sheet).toContain('- jev off: мод jev удаляет человек до волны');
    expect(sheet).toContain('- jev on: мод включён настройками CLI человека');
    expect(sheet).toContain('диалог закрывает оператор или драйвер (Esc, отклонить все)');
    expect(sheet).not.toContain('disabledMcpjsonServers');
    expect(sheet).toContain('hook_additional_context');
    expect(sheet).not.toContain('<skill_relevance>');
  });

  it('plan --home пишет PARLEY_HOME из --home в лист запуска', async () => {
    const out = path.join(tmp, 'out');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['plan', '--out', out, '--home', '/bench/home'])).toBe(0);
    } finally {
      log.mockRestore();
    }
    const sheet = await readFile(path.join(out, 'run-sheet.md'), 'utf8');
    expect(sheet).toContain('`PARLEY_HOME=/bench/home ');
    expect(sheet).not.toContain(path.join(out, 'home'));
  });

  it('plan: слишком длинный --home или длинный <out>/home по умолчанию — отказ с подсказкой, файлы не пишутся', async () => {
    const written = (out: string) => readFile(path.join(out, 'run-sheet.md'), 'utf8').then(() => true, () => false);
    const outA = path.join(tmp, 'out-a');
    await expect(main(['plan', '--out', outA, '--home', path.join(tmp, 'x'.repeat(120))])).rejects.toThrow(/байт при пределе \d+; передайте более короткий --home/);
    expect(await written(outA)).toBe(false);

    const outB = path.join(tmp, 'y'.repeat(100));
    await expect(main(['plan', '--out', outB])).rejects.toThrow('--home');
    expect(await written(outB)).toBe(false);
  });

  it('предел пути сокета — в байтах UTF-8 и включительно', async () => {
    const { MAX_SOCKET_PATH_BYTES } = await import('../packages/host/src/paths.js');
    const tail = '/host/host.sock'.length;
    // Дом ровно на `bytes` байт: буква повторяется, остаток добивается латиницей.
    const homeOf = (bytes: number, letter: string): string => {
      const free = bytes - 1;
      const size = Buffer.byteLength(letter);
      return `/${letter.repeat(Math.floor(free / size))}${'a'.repeat(free % size)}`;
    };
    for (const letter of ['a', 'я']) {
      await expect(assertHostSocketFits(homeOf(MAX_SOCKET_PATH_BYTES - tail, letter))).resolves.toBeUndefined();
      await expect(assertHostSocketFits(homeOf(MAX_SOCKET_PATH_BYTES - tail + 1, letter))).rejects.toThrow('--home');
    }
  });
});

describe('лист разметки для P32', () => {
  async function writeProject(slug: string, id: string, records: Record<string, unknown>[]): Promise<void> {
    const dir = path.join(tmp, 'root', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify({ sessionId: id, ...r })).join('\n'));
  }
  const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
  const assistant = { type: 'assistant', message: { role: 'assistant', id: 'm', content: [{ type: 'text', text: 'ok' }] } };
  const jev = (name: string) => `<skill_relevance>\nRelevant to the current request: ${name}. Ignore this if it does not fit.\n</skill_relevance>`;
  // Настоящий вид вставки в транскриптах Claude Code: вложение хука UserPromptSubmit между репликой и ответом ассистента.
  const hookContext = (content: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'attachment',
    attachment: { type: 'hook_additional_context', content, hookName: 'prompt.submit', hookEvent: 'UserPromptSubmit', toolUseID: 'hook-1' },
    ...extra,
  });
  const tokensReminder = { type: 'attachment', attachment: { type: 'total_tokens_reminder', content: 'служебное' } };

  it('находит выбор jev во вложении hook_additional_context после реплики: массив строк, строка, без блока, имя с двоеточием', async () => {
    const file = path.join(tmp, 'root', '-p', 's1.jsonl');
    await writeProject('-p', 's1', [
      user('составь план миграции базы'),
      tokensReminder,
      hookContext([jev('superpowers:writing-plans')]),
      assistant,
      user('сделай pdf из отчёта'),
      hookContext(jev('anthropic-skills:pdf')),
      assistant,
      user('открой дизайн в фигме'),
      hookContext(['Relevant to the current request: figma-use. Ignore this if it does not fit.']),
      assistant,
      user('просто вопрос без вставки'),
      tokensReminder,
      assistant,
    ]);
    const prompts = await extractPrompts(file);
    expect(prompts.map((p) => [p.text, p.jevPick])).toEqual([
      ['составь план миграции базы', 'superpowers:writing-plans'],
      ['сделай pdf из отчёта', 'anthropic-skills:pdf'],
      ['открой дизайн в фигме', 'figma-use'],
      ['просто вопрос без вставки', null],
    ]);
  });

  it('тот же текст в tool_result, ответе ассистента, другом вложении, после ответа ассистента и у подагента выбором jev не считается', async () => {
    const file = path.join(tmp, 'root', '-p', 's2.jsonl');
    const quoted = 'Relevant to the current request: superpowers:writing-plans. Ignore this if it does not fit.';
    await writeProject('-p', 's2', [
      user('первый запрос человека'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: quoted }] } },
      { type: 'assistant', message: { role: 'assistant', id: 'm2', content: [{ type: 'text', text: quoted }] } },
      // Ответ ассистента уже был: вставка принадлежит следующей реплике (например, поставленной в очередь), а не первой.
      hookContext([jev('late-skill')]),
      user('второй запрос человека'),
      { type: 'attachment', attachment: { type: 'queued_command', prompt: quoted } },
      hookContext([jev('sidechain-skill')], { isSidechain: true }),
      assistant,
    ]);
    const prompts = await extractPrompts(file);
    expect(prompts.map((p) => [p.text, p.jevPick])).toEqual([
      ['первый запрос человека', null],
      ['второй запрос человека', null],
    ]);
  });

  it('лист из транскриптов в настоящем виде: есть запросы и с выбором jev, и без него', async () => {
    for (let s = 0; s < 4; s += 1) {
      await writeProject(`-p${s}`, `s${s}`, [
        user(`запрос с выбором ${s} достаточно длинный`),
        tokensReminder,
        hookContext([jev(`skill-${s % 2}`)]),
        assistant,
        user(`запрос без выбора ${s} достаточно длинный`),
        tokensReminder,
        assistant,
      ]);
    }
    const sheet = await buildLabelSheet(path.join(tmp, 'root'), 6, new Date('2026-10-06T00:00:00Z'));
    expect(sheet.pools).toEqual({ sessions: 4, withJevPick: 4, withoutJevPick: 4 });
    expect(sheet.items.filter((item) => item.jevPick !== null)).toHaveLength(3);
    expect(sheet.items.filter((item) => item.jevPick === null)).toHaveLength(3);
    expect(new Set(sheet.items.map((item) => item.jevPick).filter((pick) => pick !== null))).toEqual(new Set(['skill-0', 'skill-1']));
  });

  it('находит реплики человека и выбор jev (в той же записи и в служебной после неё), вырезает вставку и секреты', async () => {
    const file = path.join(tmp, 'root', '-p', 's1.jsonl');
    await writeProject('-p', 's1', [
      user(`сделай презентацию\n${jev('anthropic-skills:pptx')}`),
      assistant,
      user('объясни, что такое монада'),
      user(jev('superpowers:brainstorming'), { isMeta: true }),
      assistant,
      user('/clear'),
      user('<command-name>/model</command-name>'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'не реплика' }] } },
      user('ключ sk-abcdefghijklmnopqrstuvwxyz0123 не показывать'),
    ]);
    const prompts = await extractPrompts(file);
    expect(prompts.map((p) => [p.text, p.jevPick])).toEqual([
      ['сделай презентацию', 'anthropic-skills:pptx'],
      ['объясни, что такое монада', 'superpowers:brainstorming'],
      ['ключ sk-abcdefghijklmnopqrstuvwxyz0123 не показывать', null],
    ]);
  });

  it('лист: половина с выбором jev по кругу между навыками, не больше двух с сессии, ответ пуст, секреты скрыты', async () => {
    for (let s = 0; s < 8; s += 1) {
      await writeProject(`-p${s}`, `s${s}`, Array.from({ length: 6 }, (_, i) => [
        user(`запрос с выбором ${s}-${i} достаточно длинный\n${jev(`skill-${i % 3}`)}`),
        assistant,
        user(`запрос без выбора ${s}-${i} ключ sk-abcdefghijklmnopqrstuvwxyz0123`),
        assistant,
      ]).flat());
    }
    const sheet = await buildLabelSheet(path.join(tmp, 'root'), 15, new Date('2026-10-06T00:00:00Z'));
    expect(sheet.items).toHaveLength(15);
    expect(sheet.items.every((item) => item.answer === null && item.notes === '')).toBe(true);
    const picked = sheet.items.filter((item) => item.jevPick !== null);
    expect(picked).toHaveLength(8);
    expect(new Set(picked.map((item) => item.jevPick))).toEqual(new Set(['skill-0', 'skill-1', 'skill-2']));
    const perSource = new Map<string, number>();
    for (const item of sheet.items) perSource.set(item.source, (perSource.get(item.source) ?? 0) + 1);
    expect(Math.max(...perSource.values())).toBeLessThanOrEqual(2);
    expect(JSON.stringify(sheet)).not.toContain('sk-abcdefghij');
    expect(sheet.items.every((item) => item.prompt.length <= PROMPT_MAX_CHARS)).toBe(true);
    // Порядок воспроизводим: тот же вход — тот же лист.
    expect(await buildLabelSheet(path.join(tmp, 'root'), 15, new Date('2026-10-06T00:00:00Z'))).toEqual(sheet);
  });

  it('путь для листа: в репозитории только под игнором git, вне репозитория можно', async () => {
    // Рабочая копия: .parley/ в .gitignore.
    expect(safeForPrivateData(path.join(DEFAULT_OUT, 'labels.json'))).toBe(true);
    expect(safeForPrivateData(path.join(DEFAULT_OUT, '..', '..', 'labels.json'))).toBe(false);
    expect(safeForPrivateData(path.join(tmp, 'outside', 'labels.json'))).toBe(true);
    await mkdir(path.join(tmp, 'outside'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: path.join(tmp, 'outside') });
    expect(safeForPrivateData(path.join(tmp, 'outside', 'labels.json'))).toBe(false);
    await writeFile(path.join(tmp, 'outside', '.gitignore'), 'labels.json\n');
    expect(safeForPrivateData(path.join(tmp, 'outside', 'labels.json'))).toBe(true);
    // Каталога цели ещё нет: git спрашивается у ближайшего существующего предка, а не открывается при отказе.
    expect(safeForPrivateData(path.join(DEFAULT_OUT, 'новый', 'labels.json'))).toBe(true);
    expect(safeForPrivateData(path.join(DEFAULT_OUT, '..', '..', 'не-создан', 'labels.json'))).toBe(false);
    await mkdir(path.join(tmp, 'plain'), { recursive: true });
    expect(safeForPrivateData(path.join(tmp, 'plain', 'нет', 'labels.json'))).toBe(true);
    expect(safeForPrivateData(path.join(tmp, 'outside', 'нет', 'labels.json'))).toBe(true);
    await writeFile(path.join(tmp, 'outside', '.gitignore'), '');
    expect(safeForPrivateData(path.join(tmp, 'outside', 'нет', 'labels.json'))).toBe(false);
  });

  it('команда labels отказывается писать лист туда, где его подхватит git', async () => {
    await mkdir(path.join(tmp, 'repo'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: path.join(tmp, 'repo') });
    await writeProject('-p', 's1', [user('любой достаточно длинный запрос'), assistant]);
    const code = await main(['labels', '--root', path.join(tmp, 'root'), '--out', path.join(tmp, 'repo', 'labels.json')]);
    expect(code).toBe(1);
    expect(await readFile(path.join(tmp, 'repo', 'labels.json'), 'utf8').catch(() => null)).toBeNull();
  });
});

describe('правки по итогам пилота: сбор и пары', () => {
  const at = (s: number): string => `2026-10-06T11:00:${String(s).padStart(2, '0')}.000Z`;
  const reply = (id: string, u: ReturnType<typeof usage>, extra: Record<string, unknown> = {}) =>
    ({ type: 'assistant', timestamp: at(2), ...extra, message: { id, role: 'assistant', model: 'claude-x', usage: u, content: [{ type: 'text', text: 'ok' }] } });
  const ask = (extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: at(1), message: { role: 'user', content: 'сделай' }, ...extra });

  /** Транскрипт главного разговора из готовых записей и, если нужно, файл подагента; возвращает путь главного файла. */
  async function mini(name: string, records: Record<string, unknown>[], sub: Record<string, unknown>[] = []): Promise<string> {
    const dir = path.join(tmp, 'projects', `-bench-${name}`);
    await mkdir(path.join(dir, name, 'subagents'), { recursive: true });
    await writeFile(path.join(dir, `${name}.jsonl`), records.map((r) => line(r)).join(''));
    if (sub.length > 0) await writeFile(path.join(dir, name, 'subagents', 'agent-a1.jsonl'), sub.map((r) => line(r)).join(''));
    return path.join(dir, `${name}.jsonl`);
  }

  async function begin(): Promise<BeginRecord> {
    const { file, budget } = await loadFixtures();
    const planned = planRuns(file, budget).find((r) => r.id === 'obvious.native.cold.jev-off.skill-off.r1')!;
    return beginRun(planned, budget, tmp, { versions: () => ({ claude: '2.1.289 (Claude Code)', codex: 'codex-cli 0.160.0' }), jevPluginIds: noJev, mcpServerNames: noMcp });
  }
  const collect = async (files: string[], codex: string[] = []): Promise<RunRecord> =>
    collectRun({ begin: await begin(), claude: files, codex, accepted: true, constraintsKept: true, humanCorrections: 0, warmIntervalSec: null, set: [], knownSkills: [], origin: 'live' });

  async function syntheticPair(change: (base: RunRecord, test: RunRecord) => [RunRecord, RunRecord]) {
    const runs = await syntheticRuns();
    const pick = (id: string) => runs.find((r) => r.id === id)!;
    const [base, test] = change(pick('no-skill.native.cold.jev-off.skill-off.r1'), pick('no-skill.navigator.cold.jev-off.skill-off.r1'));
    return pairSection([base, test], 'arm', 'cold', { jev: 'off', skill: 'off' }, WARM);
  }

  it('версия CLI: версия записей главного разговора сверяется с begin; другая или несколько — флаг, подагент и запись без версии не в счёт', async () => {
    const withVersion = (name: string, versions: string[], sub: Record<string, unknown>[] = []) =>
      mini(name, [ask({ version: versions[0] }), reply('m1', usage(1, 1, 0, 0), { version: versions[versions.length - 1] })], sub);
    const flags = async (file: string): Promise<string[]> => (await collect([file])).flags;

    expect(await flags(await withVersion('same', ['2.1.289']))).toEqual([]);
    expect(await flags(await withVersion('updated', ['2.1.291']))).toEqual(['cli-version-mismatch']);
    // Обновился посреди прогона: в записях две версии, хотя одна из них совпадает с begin.
    expect(await flags(await withVersion('mid', ['2.1.289', '2.1.291']))).toEqual(['cli-version-mismatch']);
    // Нет поля `version` — сравнивать нечего; подагент с другой версией главный разговор не описывает.
    expect(await flags(await mini('none', [ask(), reply('m1', usage(1, 1, 0, 0))]))).toEqual([]);
    expect(await flags(await withVersion('sub', ['2.1.289'], [reply('s1', usage(1, 1, 0, 0), { isSidechain: true, version: '2.1.300' })]))).toEqual([]);
  });

  it('отчёт исключает пару с флагом cli-version-mismatch у любой стороны', async () => {
    const section = await syntheticPair((base, test) => [base, { ...test, flags: ['cli-version-mismatch'] }]);
    expect(section.clean).toEqual([]);
    expect(section.excluded).toEqual([{ pair: 'no-skill r1', reason: 'cli-version-mismatch' }]);
  });

  it('первый запрос: чтение кеша и полный вход первого ответа главного разговора; один message.id — один запрос; подагент не считается', async () => {
    const file = await mini('first', [
      ask(),
      reply('m1', usage(3, 5, 31654, 100)),
      reply('m1', usage(3, 9, 31654, 100)),
      reply('m2', usage(1, 2, 31754, 0)),
    ], [reply('s1', usage(7, 7, 7, 7), { isSidechain: true })]);
    const collected = await collectClaudeSession(file, []);
    expect(collected.firstRequest).toEqual({ cacheRead: 31654, totalInput: 3 + 31654 + 100 });

    // Нет счётчика создания кеша: полный вход неизвестен, чтение кеша известно. Нет usage — первого запроса не видно.
    const partial = await mini('first-partial', [ask(), reply('m1', { input_tokens: 4, cache_read_input_tokens: 10 } as ReturnType<typeof usage>)]);
    expect((await collectClaudeSession(partial, [])).firstRequest).toEqual({ cacheRead: 10, totalInput: null });
    expect((await collect([file])).firstRequest).toEqual({ cacheRead: 31654, totalInput: 31757 });
    expect(parseRun(JSON.parse(JSON.stringify(await collect([file]))))).toHaveProperty('run.firstRequest.cacheRead', 31654);
  });

  it('в записи с несколькими Claude-сессиями первый запрос и старт MCP — у самой ранней', async () => {
    const early = await mini('early', [ask(), reply('m1', usage(1, 1, 0, 500))]);
    const late = await mini('late', [
      { ...ask(), timestamp: '2026-10-06T12:00:01.000Z' },
      { ...reply('m1', usage(1, 1, 500, 0)), timestamp: '2026-10-06T12:00:02.000Z' },
    ]);
    expect((await collect([late, early])).firstRequest).toEqual({ cacheRead: 0, totalInput: 501 });
  });

  it('кеш в паре — по первому запросу: чтение у одной стороны, у обеих, различие; доля за весь прогон ничего не метит', async () => {
    const withFirst = (run: RunRecord, cacheRead: number | null): RunRecord => ({ ...run, firstRequest: { cacheRead, totalInput: 40000 } });
    const notes = async (a: number | null, b: number | null) =>
      (await syntheticPair((base, test) => [withFirst(base, a), withFirst(test, b)])).clean[0]!.notes;

    expect(await notes(0, 0)).toEqual([]);
    // Общий префикс рук: обе стороны прочитали одно и то же — кеш был, различия нет.
    expect(await notes(31654, 31654)).toEqual(['first-request-cached']);
    expect(await notes(31654, 0)).toEqual(['first-request-cached', 'cache-unbalanced']);
    expect(await notes(0, 28000)).toEqual(['first-request-cached', 'cache-unbalanced']);
    // Неизвестное не сравнивается: старая запись без первого запроса, одна сторона неизвестна.
    expect(await notes(null, null)).toEqual([]);
    expect(await notes(null, 0)).toEqual([]);
    expect(await notes(null, 31654)).toEqual(['first-request-cached']);
    // Прежние пометки по доле за прогон (cold-not-clean, warm-not-observed) больше не ставятся.
    const heavy = await syntheticPair((base, test) => [
      { ...withFirst(base, 0), usage: [{ key: 'claude\u0000x\u0000', usage: summary({ cacheRead: 90000, totalInput: 100000 }) }] },
      withFirst(test, 0),
    ]);
    expect(heavy.clean[0]!.notes).toEqual([]);
    const text = renderReport(buildReport([], { schema: 1, tasks: [], scenarios: [] }, WARM));
    expect(text).not.toContain('cold-not-clean');
  });

  it('оговорки по кешу и старту MCP попадают в отчёт', async () => {
    const { file } = await loadFixtures();
    const runs = (await syntheticRuns()).map((r) => (r.id === 'no-skill.navigator.cold.jev-off.skill-off.r1' ? { ...r, firstRequest: { cacheRead: 31654, totalInput: 40000 } } : r));
    expect(renderReport(buildReport(runs, file, WARM))).toContain('no-skill.navigator.cold.jev-off.skill-off.r1 (first-request-cached)');
  });

  it('jev в отчёте: сторона с jev off и вставкой jev исключает пару (jev-leak), без вставки — нет', async () => {
    const leaked = await syntheticPair((base, test) => [{ ...base, axisEvidence: { ...base.axisEvidence, jevFired: true } }, test]);
    expect(leaked.clean).toEqual([]);
    expect(leaked.excluded).toEqual([{ pair: 'no-skill r1', reason: 'jev-leak' }]);
    const leakedTest = await syntheticPair((base, test) => [base, { ...test, axisEvidence: { ...test.axisEvidence, jevFired: true } }]);
    expect(leakedTest.excluded).toEqual([{ pair: 'no-skill r1', reason: 'jev-leak' }]);
    const clean = await syntheticPair((base, test) => [{ ...base, axisEvidence: { ...base.axisEvidence, jevFired: false } }, test]);
    expect(clean.clean).toHaveLength(1);
  });

  it('collect вычисляет jevFired для каждого прогона: есть вставка — true, нет — false, без транскриптов Claude — null', async () => {
    const hook = ({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['Relevant to the current request: bench-changelog. Ignore this if it does not fit.'], hookName: 'prompt.submit' } });
    const plain = await mini('no-jev', [ask(), reply('m1', usage(1, 1, 0, 0))]);
    const fired = await mini('with-jev', [ask(), hook, reply('m1', usage(1, 1, 0, 0))]);
    expect((await collect([plain])).axisEvidence.jevFired).toBe(false);
    expect((await collect([fired])).axisEvidence.jevFired).toBe(true);
    expect((await collect([plain, fired])).axisEvidence.jevFired).toBe(true);

    const meta = JSON.stringify({ type: 'session_meta', timestamp: '2026-10-06T10:00:00.000Z', payload: { id: 'p1', cwd: '/x' } });
    const count = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-06T10:00:09.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } } } });
    await writeFile(path.join(tmp, 'rollout.jsonl'), `${meta}\n${count}\n`);
    expect((await collect([], [path.join(tmp, 'rollout.jsonl')])).axisEvidence.jevFired).toBeNull();
  });

  it('старт MCP: pendingMcpServers и failedMcpServers из первого deferred_tools_delta главного разговора; нет вложения — null', async () => {
    const delta = (pending: unknown, failed: unknown) => ({ type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: [], pendingMcpServers: pending, failedMcpServers: failed } });
    const file = await mini('mcp', [
      ask(), delta(['a', 'b', 'c'], [{ name: 'pencil', errorCode: 'CONNECTION_CLOSED' }]), delta([], []), reply('m1', usage(1, 1, 0, 0)),
    ]);
    expect((await collectClaudeSession(file, [])).startup).toEqual({ pendingMcpServers: 3, failedMcpServers: 1 });
    const run = await collect([file]);
    expect(run.startup).toEqual({ pendingMcpServers: 3, failedMcpServers: 1 });
    expect(parseRun(JSON.parse(JSON.stringify(run)))).toHaveProperty('run.startup.pendingMcpServers', 3);
    // Числом тоже; в подагенте вложение главный разговор не описывает.
    const numeric = await mini('mcp-num', [ask(), delta(2, 0), reply('m1', usage(1, 1, 0, 0))]);
    expect((await collect([numeric])).startup).toEqual({ pendingMcpServers: 2, failedMcpServers: 0 });
    const only = await mini('mcp-sub', [ask(), reply('m1', usage(1, 1, 0, 0))], [{ ...delta(['x'], []), isSidechain: true }]);
    expect((await collect([only])).startup).toEqual({ pendingMcpServers: null, failedMcpServers: null });
  });

  it('пара с разным стартом MCP помечается mcp-startup-unbalanced; неизвестное с известным не сравнивается', async () => {
    const startup = (run: RunRecord, pendingMcpServers: number | null, failedMcpServers: number | null): RunRecord => ({ ...run, startup: { pendingMcpServers, failedMcpServers } });
    const notes = async (a: [number | null, number | null], b: [number | null, number | null]) =>
      (await syntheticPair((base, test) => [startup(base, ...a), startup(test, ...b)])).clean[0]!.notes;
    expect(await notes([0, 0], [0, 0])).toEqual([]);
    expect(await notes([3, 0], [0, 0])).toEqual(['mcp-startup-unbalanced']);
    expect(await notes([0, 0], [0, 2])).toEqual(['mcp-startup-unbalanced']);
    expect(await notes([null, null], [3, 1])).toEqual([]);
  });

  it('listingBytes: байты UTF-8 поля content первого skill_listing главного разговора; нет — null', async () => {
    const listing = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'attachment', attachment: { type: 'skill_listing', content, names: ['a'] }, ...extra });
    const text = '- проверка списка: описание на русском\n';
    const file = await mini('listing', [listing(text), listing('второй список'), ask(), reply('m1', usage(1, 1, 0, 0))], [listing('подагент', { isSidechain: true })]);
    const collected = await collectClaudeSession(file, []);
    expect(collected.bytes['listingBytes']).toBe(Buffer.byteLength(text));
    expect(Buffer.byteLength(text)).toBeGreaterThan(text.length);
    expect((await collect([file])).bytes['listingBytes']).toBe(Buffer.byteLength(text));
    const without = await mini('no-listing', [ask(), reply('m1', usage(1, 1, 0, 0))]);
    expect((await collectClaudeSession(without, [])).bytes['listingBytes']).toBeNull();
  });
});

describe('копия фикстуры и диалог MCP-серверов', () => {
  const versions = () => ({ claude: 'x', codex: 'y' });
  async function pick(jev: 'off' | 'on') {
    const { file, budget } = await loadFixtures();
    return { run: planRuns(file, budget).find((r) => r.jev === jev && r.arm === 'native' && r.skill === 'off')!, budget };
  }
  const exists = (target: string) => readFile(target, 'utf8').then(() => true, () => false);

  it('фикстура в git-репозитории: копия и хеш берут только отслеживаемые файлы, вне репозитория — все', async () => {
    const { run, budget } = await pick('on');
    const tracked = path.join(tmp, 'fix-git');
    const plain = path.join(tmp, 'fix-plain');
    await cp(FIXTURE_DIR, tracked, { recursive: true });
    await cp(FIXTURE_DIR, plain, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: tracked });
    spawnSync('git', ['add', '-A'], { cwd: tracked });
    const run1 = async (fixtureDir: string, id: string) => beginRun({ ...run, id }, budget, tmp, { versions, fixtureDir, mcpServerNames: noMcp });

    const before = await run1(tracked, 'git-before');
    // Состояние хуков сессии оператора: в пилоте оно попало и в копию, и в хеш.
    for (const dir of [tracked, plain]) {
      await mkdir(path.join(dir, 'project/.omc/state'), { recursive: true });
      await writeFile(path.join(dir, 'project/.omc/state/hook.json'), '{"leak":true}');
    }
    const after = await run1(tracked, 'git-after');
    expect(await exists(path.join(after.projectDir, '.omc/state/hook.json'))).toBe(false);
    expect(after.conditions.hashes['project']).toBe(before.conditions.hashes['project']);
    expect(await hashTree(path.join(tracked, 'project'))).toBe(before.conditions.hashes['project']);
    expect(spawnSync('git', ['ls-files'], { cwd: after.projectDir, encoding: 'utf8' }).stdout).not.toContain('.omc');

    const everything = await run1(plain, 'plain');
    expect(await exists(path.join(everything.projectDir, '.omc/state/hook.json'))).toBe(true);
    expect(everything.conditions.hashes['project']).not.toBe(before.conditions.hashes['project']);
  });

  it('begin записывает имена серверов .mcp.json выше копии и предупреждения в begin.json, настроек Claude Code не пишет', async () => {
    const off = await pick('off');
    const found = await beginRun(off.run, off.budget, tmp, { versions, jevPluginIds: noJev, mcpServerNames: async () => ({ names: ['figma', 'pencil'], warnings: ['/x/.mcp.json: не JSON'] }) });
    expect(found.mcpServersAbove).toEqual(['figma', 'pencil']);
    const saved = JSON.parse(await readFile(path.join(tmp, 'work', off.run.id, 'begin.json'), 'utf8')) as BeginRecord;
    expect(saved).toMatchObject({ mcpServersAbove: ['figma', 'pencil'], warnings: ['/x/.mcp.json: не JSON'], jevInstalled: [] });
    expect(await readdir(path.join(found.projectDir, '.claude'))).toEqual(['skills']);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: found.projectDir, encoding: 'utf8' }).stdout).toBe('');

    // jev on: то же самое — имена в записи, в копии только навыки фикстуры.
    const on = await pick('on');
    const onlyMcp = await beginRun(on.run, on.budget, tmp, { versions, mcpServerNames: async () => ({ names: ['figma'], warnings: [] }) });
    expect(onlyMcp.mcpServersAbove).toEqual(['figma']);
    expect(await readdir(path.join(onlyMcp.projectDir, '.claude'))).toEqual(['skills']);
  });

  it('поиск .mcp.json идёт от копии до корня, читает только имена; битый и нечитаемый файл — предупреждение, не отказ', async () => {
    const deep = path.join(tmp, 'a/b/c/project');
    await mkdir(path.join(deep, '.mcp.json'), { recursive: true });
    await writeFile(path.join(tmp, 'a/.mcp.json'), JSON.stringify({ mcpServers: { x: {}, y: { command: 'node' } } }));
    await writeFile(path.join(tmp, 'a/b/.mcp.json'), JSON.stringify({ mcpServers: { y: {}, z: {} } }));
    await writeFile(path.join(tmp, 'a/b/c/.mcp.json'), '{не json');
    const found = await findMcpServerNames(deep);
    expect(found.names).toEqual(expect.arrayContaining(['x', 'y', 'z']));
    expect(found.names).toEqual([...found.names].sort());
    expect(new Set(found.names).size).toBe(found.names.length);
    const ours = found.warnings.filter((w) => w.startsWith(tmp));
    expect(ours).toEqual([
      `${path.join(deep, '.mcp.json')}: не прочитан (EISDIR)`,
      `${path.join(tmp, 'a/b/c/.mcp.json')}: не JSON`,
    ]);

    // Нет объекта mcpServers — тоже предупреждение.
    await writeFile(path.join(tmp, 'a/b/c/.mcp.json'), '{"servers":{}}');
    expect((await findMcpServerNames(deep)).warnings).toContain(`${path.join(tmp, 'a/b/c/.mcp.json')}: нет объекта mcpServers`);
  });
});

describe('сухой прогон', () => {
  it('все фикстуры, листы, принятие эталонных решений, сбор и отчёт проходят без платных ходов', async () => {
    const result = await dryRun();
    expect(result.lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.lines.some((l) => l.includes('принятие long-rule'))).toBe(true);
  }, 60000);

  it('стенд не запускает модели: единственные внешние программы — git, sh и --version у CLI', async () => {
    const source = await readFile(path.join(FIXTURE_DIR, '../../../tools/parley-token-benchmark.ts'), 'utf8');
    const spawns = [...source.matchAll(/spawnSync\(([^,]+),/g)].map((m) => m[1]);
    expect(spawns.sort()).toEqual(["'git'", "'git'", "'git'", "'git'", "'sh'", 'bin']);
    expect(source).toContain("spawnSync(bin, ['--version']");
  });
});

describe('волны с провайдером: wq-codex и wq-glm', () => {
  const FIVE = ['ambiguous', 'russian', 'multiple', 'long-skill', 'unavailable'];

  it('те же пять сценариев, обе руки, три повтора, jev и навык выключены; id с провайдером перед повтором, прежние id claude не меняются', async () => {
    const { file, budget } = await loadFixtures();
    for (const provider of ['codex', 'glm'] as const) {
      const wave = planRuns(file, budget, `wq-${provider}`);
      expect(wave).toHaveLength(30);
      expect(wave.every((r) => r.provider === provider && r.wave === `wq-${provider}` && r.jev === 'off' && r.skill === 'off' && r.sessions === 1 && !r.pilot)).toBe(true);
      expect([...new Set(wave.map((r) => r.scenario))]).toEqual(FIVE);
      expect(wave.map((r) => r.id)).toEqual(expect.arrayContaining([`ambiguous.native.cold.jev-off.skill-off.${provider}.r1`, `unavailable.navigator.cold.jev-off.skill-off.${provider}.r3`]));
      expect(wave.map((r) => r.order)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    }
    const wq = planRuns(file, budget, 'wq');
    expect(wq.every((r) => r.provider === 'claude')).toBe(true);
    expect(wq.map((r) => r.id)).toEqual(expect.arrayContaining(['ambiguous.native.cold.jev-off.skill-off.r1', 'ambiguous.navigator.cold.jev-off.skill-off.r3']));
    const all = planRuns(file, budget);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(all.filter((r) => r.provider === 'claude').every((r) => !/\.(codex|glm)\./.test(r.id))).toBe(true);
    // Остальные волны и оси — только claude.
    expect(all.filter((r) => !r.wave.startsWith('wq')).every((r) => r.provider === 'claude')).toBe(true);
    expect(runIdOf({ scenario: 'x', arm: 'native', cache: 'cold', jev: 'off', skill: 'off', repetition: 2 })).toBe('x.native.cold.jev-off.skill-off.r2');
  });

  it('условия по провайдерам: у glm id из списка GLM как есть и medium, у codex прежние gpt-6-luna и low', async () => {
    const { budget } = await loadFixtures();
    expect(budget.conditions.glm).toEqual({ model: 'glm-5.3[1m]', effort: 'medium' });
    expect(budget.conditions.codex).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(budget.conditions.claude).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });

  it('проверка бюджета: уникальность по паре (сценарий, провайдер), комната не переопределяется, провайдер и условия обязательны', async () => {
    const { file, budget } = await loadFixtures();
    expect(validateBudget(budget, file)).toEqual([]);
    const wave = (id: string, scenarios: string[], provider?: NonNullable<Budget['waves'][number]['provider']>): Budget['waves'][number] =>
      ({ id, title: id, scenarios, ...(provider === undefined ? {} : { provider }) });
    const withWaves = (extra: Budget['waves']): Budget => ({ ...budget, waves: [...budget.waves, ...extra] });

    // Тот же сценарий у того же провайдера в двух волнах — отказ; у разных провайдеров — можно.
    expect(validateBudget(withWaves([wave('dup', ['ambiguous'], 'codex')]), file)).toContain('сценарий ambiguous с провайдером codex лежит в нескольких волнах');
    // claude по-прежнему ровно в одной волне.
    expect(validateBudget(withWaves([wave('again', ['ambiguous'])]), file)).toContain('сценарий ambiguous должен быть ровно в одной волне');
    const lost: Budget = { ...budget, waves: budget.waves.map((w) => (w.id === 'wq' ? { ...w, scenarios: w.scenarios.filter((id) => id !== 'russian') } : w)) };
    expect(validateBudget(lost, file)).toContain('сценарий russian должен быть ровно в одной волне');
    // Сценарий с комнатой провайдером не переопределяется: он идёт с участниками из сценария.
    expect(validateBudget(withWaves([wave('room', ['dm'], 'codex')]), file)).toContain('budget.waves room: сценарий dm с комнатой не переопределяется провайдером codex');
    expect(validateBudget(withWaves([{ ...wave('bad', []), provider: 'gemini' as never }]), file)).toContain('budget.waves bad: provider — claude, codex или glm');
    const noGlm = { ...budget, conditions: { claude: budget.conditions.claude, codex: budget.conditions.codex } };
    expect(validateBudget(noGlm, file)).toContain('budget.conditions.glm: model и effort');
  });

  it('лист запуска: у codex и glm строка провайдера, jev не применим, сбор с нужным журналом; у claude прежний лист', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    const sheet = renderRunSheet(runs, file, budget, '/out');
    const section = (id: string): string => sheet.split('\n## ').find((part) => part.includes(`. ${id}\n`))!;
    const codex = section('ambiguous.native.cold.jev-off.skill-off.codex.r1');
    expect(codex).toContain('Провайдер codex: модель gpt-6-luna, усилие low');
    expect(codex).toContain('collect ambiguous.native.cold.jev-off.skill-off.codex.r1 --codex <rollout.jsonl>');
    expect(codex).toContain('jev: у этого провайдера не применим');
    expect(codex).not.toContain('мод jev удаляет человек');
    const glm = section('ambiguous.navigator.cold.jev-off.skill-off.glm.r1');
    expect(glm).toContain('Провайдер glm: модель glm-5.3[1m], усилие medium');
    expect(glm).toContain('--link-secrets');
    expect(glm).toContain('--claude <лог.jsonl> --out');
    expect(glm).toContain('Участники: glm/worker');
    expect(codex).toContain('Участники: codex/worker');
    const claude = section('ambiguous.native.cold.jev-off.skill-off.r1');
    expect(claude).not.toContain('Провайдер ');
    expect(claude).toContain('мод jev удаляет человек');
  });

  it('plan --wave wq-codex и wq-glm пишут по 30 прогонов своего провайдера', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const provider of ['codex', 'glm']) {
        const out = path.join(tmp, `out-${provider}`);
        expect(await main(['plan', '--out', out, '--home', '/bench/home', '--wave', `wq-${provider}`])).toBe(0);
        const plan = JSON.parse(await readFile(path.join(out, 'plan.json'), 'utf8')) as { runs: { wave: string; provider: string }[] };
        expect(plan.runs).toHaveLength(30);
        expect(plan.runs.every((r) => r.wave === `wq-${provider}` && r.provider === provider)).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe('begin с провайдером', () => {
  const versions = () => ({ claude: '2.1.289 (Claude Code)', codex: 'codex-cli 0.77.0' });

  it('условия берутся у провайдера прогона; мод jev при jev off у codex и glm не ищется и не отказывает, у claude отказывает', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    const installed = vi.fn(async () => ['jev@x']);
    const pick = (id: string) => runs.find((r) => r.id === id)!;

    const codex = await beginRun(pick('russian.native.cold.jev-off.skill-off.codex.r1'), budget, tmp, { versions, jevPluginIds: installed, mcpServerNames: noMcp });
    expect(codex.conditions).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', effort: 'low', jev: 'off' });
    expect(codex.jevInstalled).toEqual([]);
    const glm = await beginRun(pick('russian.navigator.cold.jev-off.skill-off.glm.r2'), budget, tmp, { versions, jevPluginIds: installed, mcpServerNames: noMcp });
    expect(glm.conditions).toMatchObject({ provider: 'glm', model: 'glm-5.3[1m]', effort: 'medium', jev: 'off', cli: 'claude 2.1.289 (Claude Code); codex codex-cli 0.77.0' });
    expect(glm.jevInstalled).toEqual([]);
    expect(installed).not.toHaveBeenCalled();
    await expect(beginRun(pick('russian.native.cold.jev-off.skill-off.r1'), budget, tmp, { versions, jevPluginIds: installed, mcpServerNames: noMcp })).rejects.toThrow(/мод jev установлен/);
    const claude = await beginRun(pick('russian.native.cold.jev-off.skill-off.r1'), budget, tmp, { versions, jevPluginIds: noJev, mcpServerNames: noMcp });
    expect(claude.conditions).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('хеш условий в begin одинаков у провайдеров: меняются только провайдер, модель и усилие', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    const [claude, codex] = await Promise.all(['russian.native.cold.jev-off.skill-off.r1', 'russian.native.cold.jev-off.skill-off.codex.r1'].map((id) =>
      beginRun(runs.find((r) => r.id === id)!, budget, tmp, { versions, jevPluginIds: noJev, mcpServerNames: noMcp })));
    expect(claude!.conditions.hashes).toEqual(codex!.conditions.hashes);
  });
});

describe('пары и отчёт при нескольких провайдерах', () => {
  it('пара с разными провайдерами не сравнивается; разделы отчёта у каждого провайдера свои, у одного провайдера заголовок прежний', async () => {
    const runs = await syntheticRuns();
    const pick = (id: string) => runs.find((r) => r.id === id)!;
    const base = pick('no-skill.native.cold.jev-off.skill-off.r1');
    const test = pick('no-skill.navigator.cold.jev-off.skill-off.r1');
    const mismatch = pairSection([base, { ...test, conditions: { ...test.conditions, provider: 'codex' } }], 'arm', 'cold', { jev: 'off', skill: 'off' }, WARM);
    expect(mismatch.clean).toEqual([]);
    // Группа пары включает провайдера: чужой провайдер — отдельная группа без напарника.
    expect(mismatch.excluded.map((e) => e.reason).sort()).toEqual(['unpaired-no-base', 'unpaired-no-test']);

    const { file } = await loadFixtures();
    const one = buildReport([base, test], file, WARM);
    expect(one.sections.map((x) => x.label)).toEqual(['arm (jev=off) (skill=off)']);
    const rename = (run: RunRecord, provider: string): RunRecord => ({ ...run, id: `${run.id}.${provider}`, conditions: { ...run.conditions, provider } });
    const two = buildReport([base, test, rename(base, 'codex'), rename(test, 'codex')], file, WARM);
    expect(two.sections.map((x) => x.label)).toEqual(['arm (jev=off) (skill=off) [claude]', 'arm (jev=off) (skill=off) [codex]']);
    expect(two.sections.every((x) => x.clean.length === 1)).toBe(true);
    const cell = two.coverage.find((c) => c.scenario === 'no-skill')!;
    expect(cell.missingCells).toEqual([]);
    expect(buildReport([base, test, rename(base, 'codex')], file, WARM).coverage.find((c) => c.scenario === 'no-skill')!.missingCells).toEqual(['navigator/codex']);
  });
});

describe('сбор из журнала Codex', () => {
  const at = (s: number): string => `2026-10-06T12:00:${String(s).padStart(2, '0')}.000Z`;
  const rec = (type: string, payload: Record<string, unknown>, s: number): Record<string, unknown> => ({ timestamp: at(s), type, payload });
  const meta = (id: string, over: Record<string, unknown> = {}) => rec('session_meta', { id, cwd: '/bench/work/project', cli_version: '0.77.0', source: 'cli', ...over }, 0);
  const counts = (input: number, cached: number, output: number, lastInput: number, lastCached: number, s: number) =>
    rec('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: lastInput, cached_input_tokens: lastCached, output_tokens: 7 } } }, s);
  const call = (name: string, callId: string, args: unknown, s: number) => rec('response_item', { type: 'function_call', name, call_id: callId, arguments: typeof args === 'string' ? args : JSON.stringify(args) }, s);
  const output = (callId: string, value: unknown, s: number, type = 'function_call_output') => rec('response_item', { type, call_id: callId, output: value }, s);
  // Codex 0.160 (code mode): вызов — `custom_tool_call` с именем `exec` и JS-кодом в `input`; вывод — блоки `input_text`,
  // в первом служебная строка, в следующем то, что код напечатал (результат MCP-вызова после `text(r)` — JSON-строкой).
  const exec = (callId: string, code: string, s: number) => rec('response_item', { type: 'custom_tool_call', name: 'exec', call_id: callId, input: code }, s);
  const SCRIPT = { type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' };
  const execOutput = (callId: string, text: string, s: number) => output(callId, [SCRIPT, { type: 'input_text', text }], s, 'custom_tool_call_output');
  const rollout = async (name: string, records: Record<string, unknown>[]): Promise<string> => {
    const file = path.join(tmp, `${name}.jsonl`);
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  const KNOWN = ['bench-changelog', 'bench-error-codes', 'minimal-development'];

  async function beginFor(id: string, versions = { claude: '2.1.289 (Claude Code)', codex: 'codex-cli 0.77.0' }): Promise<BeginRecord> {
    const { file, budget } = await loadFixtures();
    return beginRun(planRuns(file, budget).find((r) => r.id === id)!, budget, tmp, { versions: () => versions, jevPluginIds: noJev, mcpServerNames: noMcp });
  }

  it('вызовы find_skill (имя с find_skill, обе формы вызова), результаты по call_id, загрузки по пути SKILL.md навыка копии, первый запрос', async () => {
    const file = await rollout('main', [
      meta('thr-1'),
      rec('event_msg', { type: 'token_count', info: null }, 1),
      counts(1000, 400, 50, 1000, 400, 2),
      counts(2500, 1900, 90, 1500, 1500, 5),
      call('mcp__parley__find_skill', 'c1', { query: 'changelog' }, 3),
      output('c1', 'No skill matched: work without one, or try other words once', 3),
      // Вторая форма: пространство имён и пользовательский вызов; результат — JSON с блоками text.
      rec('response_item', { type: 'custom_tool_call', name: 'parley.find_skill', call_id: 'c2', input: '{"query":"journal"}' }, 4),
      output('c2', JSON.stringify({ content: [{ type: 'text', text: '1. bench-changelog — add an entry' }] }), 4, 'custom_tool_call_output'),
      // Загрузки: чтение SKILL.md навыка копии оболочкой (массив command), custom-вызов, два файла в одной команде,
      // навык вне списка копии и не-SKILL.md не считаются; повтор считается повторной загрузкой.
      call('shell', 'c3', { command: ['bash', '-lc', 'cat .agents/skills/bench-changelog/SKILL.md'] }, 6),
      rec('response_item', { type: 'custom_tool_call', name: 'read_file', call_id: 'c4', input: '{"path":"/work/project/.claude/skills/bench-error-codes/SKILL.md"}' }, 7),
      call('shell', 'c5', { command: ['bash', '-lc', 'cat .agents/skills/bench-changelog/SKILL.md .claude/skills/minimal-development/SKILL.md'] }, 8),
      call('shell', 'c6', { command: ['bash', '-lc', 'cat /Users/x/.claude/skills/someone-elses/SKILL.md; ls .agents/skills/bench-changelog; cat .agents/skills/bench-changelog/README.md'] }, 9),
      call('shell', 'c7', 'cat .agents/skills/bench-error-codes/SKILL.md', 10),
    ]);

    const collected = await collectCodexTranscript(file, KNOWN);
    expect(collected.skillUse).toEqual({ lookups: 2, loads: 5, noMatch: 1, reformulations: 1, duplicateLoads: 2, forbiddenOffered: null });
    expect(collected.loaded).toEqual(['bench-changelog', 'bench-error-codes', 'bench-changelog', 'minimal-development', 'bench-error-codes']);
    expect(collected.offered).toEqual(['bench-changelog']);
    expect(collected.bytes).toEqual({ bootstrapBytes: null, listingBytes: null, findSkillResultBytes: Buffer.byteLength('No skill matched: work without one, or try other words once') + Buffer.byteLength('1. bench-changelog — add an entry'), toolResultBytes: null });
    expect(collected.traffic).toEqual({ messages: null, broadcasts: null, deliveries: null });
    // Первый запрос — первая запись token_count с last_token_usage (info: null пропущена), а не накопитель.
    expect(collected.firstRequest).toEqual({ cacheRead: 400, totalInput: 1000 });
  });

  it('без find_skill и без last_token_usage: нули поиска, первый запрос неизвестен; без списка известных навыков считаются любые пути SKILL.md', async () => {
    const file = await rollout('quiet', [
      meta('thr-2'),
      rec('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 1 } } }, 1),
      call('shell', 'c1', { command: ['cat', '.agents/skills/anything/SKILL.md'] }, 2),
    ]);
    const collected = await collectCodexTranscript(file);
    expect(collected.skillUse).toMatchObject({ lookups: 0, loads: 1, noMatch: 0, reformulations: 0 });
    expect(collected.loaded).toEqual(['anything']);
    expect(collected.bytes['findSkillResultBytes']).toBe(0);
    expect(collected.firstRequest).toBeNull();
  });

  it('Codex 0.160 зовёт инструменты кодом exec: find_skill — вхождение tools.mcp__<сервер>__find_skill( в input; get_map, report и упоминание имени поиском не считаются', async () => {
    const found = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ provider: 'codex', skills: [{ name: 'bench-changelog' }] }, null, 2) }] });
    const file = await rollout('code-mode', [
      meta('thr-cm'),
      exec('e1', 'const a=await tools.mcp__parley__get_map({}); text(a);', 1),
      exec('e2', 'const r=await tools.mcp__parley__find_skill({query:"changelog entry"}); text(r);', 2),
      execOutput('e2', found, 2),
      exec('e3', 'const r=await tools.mcp__parley__report({status:"done",summary:"no find_skill needed"});', 3),
      exec('e4', 'const names=ALL_TOOLS.filter(x=>/find_skill/.test(x.name)); text(names);', 4),
      // Загрузка навыка копии вызовом exec_command в коде — как раньше, по пути SKILL.md.
      exec('e5', 'const r=await tools.exec_command({cmd:"cat .agents/skills/bench-changelog/SKILL.md",yield_time_ms:10000}); text(r.output);', 5),
      // Прежний вид (запись названа find_skill) и другой сервер с пробелом перед скобкой — тот же счётчик.
      call('mcp__parley__find_skill', 'c6', { query: 'again' }, 6),
      exec('e7', 'const r=await tools.mcp__other_srv__find_skill ({query:"x"}); text(r);', 7),
    ]);

    const collected = await collectCodexTranscript(file, KNOWN);
    expect(collected.skillUse).toEqual({ lookups: 3, loads: 1, noMatch: 0, reformulations: 1, duplicateLoads: 0, forbiddenOffered: null });
    expect(collected.loaded).toEqual(['bench-changelog']);
    // find_skill — единственный вызов в своём exec: байты — все текстовые блоки вывода, навык из результата предложен.
    expect(collected.bytes['findSkillResultBytes']).toBe(Buffer.byteLength(SCRIPT.text) + Buffer.byteLength(found));
    expect(collected.offered).toEqual(['bench-changelog']);
  });

  it('в одном exec несколько вызовов: каждый find_skill считается, но вывод общий — байты результата null, предложенные навыки по нему не собираются', async () => {
    const file = await rollout('shared-exec', [
      meta('thr-sh'),
      // Два find_skill подряд: две попытки, вторая — переформулировка.
      exec('e1', 'const a=await tools.mcp__parley__find_skill({query:"a"}); const b=await tools.mcp__parley__find_skill({query:"b"}); text(a); text(b);', 1),
      execOutput('e1', 'bench-error-codes', 1),
      // find_skill рядом с get_map: вывод тоже общий.
      exec('e2', 'const m=await tools.mcp__parley__get_map({}); const r=await tools.mcp__parley__find_skill({query:"c"}); text(m); text(r);', 2),
      execOutput('e2', 'minimal-development', 2),
      // Одиночный поиск после них: имя навыка собирается, а байты остаются неизвестными.
      exec('e3', 'const r=await tools.mcp__parley__find_skill({query:"d"}); text(r);', 3),
      execOutput('e3', 'bench-changelog', 3),
    ]);

    const collected = await collectCodexTranscript(file, KNOWN);
    expect(collected.skillUse).toMatchObject({ lookups: 4, reformulations: 3, noMatch: 0 });
    expect(collected.bytes['findSkillResultBytes']).toBeNull();
    expect(collected.offered).toEqual(['bench-changelog']);
  });

  it('Codex 0.160: «ничего не найдено» узнаётся в двух слоях — обёртка MCP с JSON внутри text после служебной строки; нашёл, промах, второй промах и прежний префикс', async () => {
    const json = (extra: Record<string, unknown>) => JSON.stringify({ provider: 'codex', skills: [], ...extra }, null, 2);
    const wrapped = (inner: string) => JSON.stringify({ content: [{ type: 'text', text: inner }] });
    const find = (id: string, s: number) => exec(id, 'const r=await tools.mcp__parley__find_skill({query:"q"}); text(r);', s);
    const file = await rollout('no-match', [
      meta('thr-nm'),
      find('e1', 1),
      execOutput('e1', wrapped(JSON.stringify({ provider: 'codex', skills: [{ name: 'bench-changelog' }] }, null, 2)), 1),
      find('e2', 2),
      execOutput('e2', wrapped(json({ message: 'No skill matched: work without one, or try other words once' })), 2),
      find('e3', 3),
      execOutput('e3', wrapped(json({ message: 'No skill matched again: stop searching and work without one' })), 3),
      // Прежний вид: простая строка с префиксом.
      find('e4', 4),
      execOutput('e4', 'No skill matched: work without one, or try other words once', 4),
    ]);

    const collected = await collectCodexTranscript(file, KNOWN);
    expect(collected.skillUse).toMatchObject({ lookups: 4, noMatch: 3, reformulations: 3 });
    expect(collected.offered).toEqual(['bench-changelog']);
  });

  it('прогон codex: счётчики, версия CLI из session_meta сверяется с begin (cli-version-mismatch), первый запрос ведущего треда, jevFired — null', async () => {
    const begin = await beginFor('russian.navigator.cold.jev-off.skill-off.codex.r1');
    expect(begin.conditions.provider).toBe('codex');
    const parent = await rollout('parent', [meta('thr-p'), counts(1000, 400, 50, 1000, 400, 2), call('mcp__parley__find_skill', 'c1', {}, 3), call('shell', 'c2', { command: ['cat', '.agents/skills/bench-changelog/SKILL.md'] }, 4), counts(3000, 2500, 80, 2000, 2000, 6)]);
    const child = await rollout('child', [meta('thr-c', { parent_thread_id: 'thr-p', source: 'exec' }), counts(10, 0, 1, 10, 0, 5)]);
    const input = { begin, claude: [] as string[], accepted: true, constraintsKept: true, humanCorrections: 0, warmIntervalSec: null, set: [] as string[], knownSkills: KNOWN, origin: 'live' as const };

    const run = await collectRun({ ...input, codex: [parent, child] });
    expect(run.flags).toEqual([]);
    expect(run.skillUse).toMatchObject({ lookups: 1, loads: 1, noMatch: 0 });
    expect(run.bytes).toMatchObject({ listingBytes: null, toolResultBytes: null });
    expect(run.traffic['messages']).toBeNull();
    expect(run.loadedSkills).toEqual(['bench-changelog']);
    expect(run.firstRequest).toEqual({ cacheRead: 400, totalInput: 1000 });
    expect(run.axisEvidence.jevFired).toBeNull();
    expect(run.startup).toEqual({ pendingMcpServers: null, failedMcpServers: null });
    expect(parseRun(JSON.parse(JSON.stringify(run)))).toHaveProperty('run');

    // Другая версия CLI в журнале (у родителя или у порождённого треда) — флаг, пара исключается.
    const updated = await rollout('updated', [meta('thr-u', { cli_version: '0.99.0' }), counts(1, 0, 1, 1, 0, 1)]);
    expect((await collectRun({ ...input, codex: [updated] })).flags).toContain('cli-version-mismatch');
    const childUpdated = await rollout('childUpdated', [meta('thr-c2', { parent_thread_id: 'thr-p', source: 'exec', cli_version: '0.99.0' }), counts(1, 0, 1, 1, 0, 1)]);
    expect((await collectRun({ ...input, codex: [parent, childUpdated] })).flags).toContain('cli-version-mismatch');
    // В журнале нет версии — сравнивать нечего.
    const unversioned = await rollout('unversioned', [rec('session_meta', { id: 'thr-n', cwd: '/x' }, 0), counts(1, 0, 1, 1, 0, 1)]);
    expect((await collectRun({ ...input, codex: [unversioned] })).flags).toEqual([]);
    // Версия begin в виде «codex 0.77.0» без имени пакета тоже разбирается.
    const plain = await beginFor('russian.navigator.cold.jev-off.skill-off.codex.r1', { claude: '2.1.289', codex: '0.99.0' });
    expect((await collectRun({ ...input, begin: plain, codex: [updated] })).flags).toEqual([]);
  });

  it('прогон codex без --codex и прогон glm без --claude — отказ; прогон glm собирается из транскрипта Claude: jevFired — признак, не null', async () => {
    const codexBegin = await beginFor('russian.native.cold.jev-off.skill-off.codex.r1');
    const glmBegin = await beginFor('russian.native.cold.jev-off.skill-off.glm.r1');
    const file = await claudeTranscript();
    const base = { accepted: true, constraintsKept: true, humanCorrections: 0, warmIntervalSec: null, set: [] as string[], knownSkills: [] as string[], origin: 'live' as const };
    await expect(collectRun({ ...base, begin: codexBegin, claude: [file], codex: [] })).rejects.toThrow(/провайдер codex — нужен --codex/);
    await expect(collectRun({ ...base, begin: glmBegin, claude: [], codex: [await rollout('x', [meta('t'), counts(1, 0, 1, 1, 0, 1)])] })).rejects.toThrow(/провайдер glm — нужен --claude/);
    const glm = await collectRun({ ...base, begin: glmBegin, claude: [file], codex: [] });
    expect(glm.conditions).toMatchObject({ provider: 'glm', model: 'glm-5.3[1m]' });
    expect(typeof glm.axisEvidence.jevFired).toBe('boolean');
    expect(glm.skillUse['lookups']).not.toBeNull();
  });

  it('комната из Claude и Codex: счётчики Claude и Codex складываются, неизвестное у Codex делает сумму неизвестной', async () => {
    const begin = await beginFor('mixed.native.cold.jev-off.skill-off.r1');
    const file = await claudeTranscript();
    const codex = await rollout('room', [meta('thr-r'), counts(100, 0, 5, 100, 0, 1), call('mcp__parley__find_skill', 'c1', {}, 2)]);
    const run = await collectRun({ begin, claude: [file], codex: [codex], accepted: true, constraintsKept: true, humanCorrections: 0, warmIntervalSec: null, set: [], knownSkills: KNOWN, origin: 'live' });
    // Claude: 3 поиска вместе с подагентом, Codex: 1.
    expect(run.skillUse['lookups']).toBe(4);
    expect(run.traffic['messages']).toBeNull();
    expect(run.bytes['toolResultBytes']).toBeNull();
    // Первый запрос и старт MCP — у Claude, если он есть.
    expect(run.firstRequest).toEqual({ cacheRead: 100, totalInput: 130 });
  });
});
