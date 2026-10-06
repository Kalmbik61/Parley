import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  collectRun,
  dryRun,
  estimateBudget,
  extractPrompts,
  hostEnv,
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
  validateScenarioFile,
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

/** Поиск мода jev без чтения настоящего `~/.claude`: мода «нет», файл настроек в копию не пишется. */
const noJev = async (): Promise<string[]> => [];

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
  it('матрица: основная ось, отдельные оси только на холодном кеше, пилот и потолки', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length);
    // 14 сценариев × 2 руки × (холодный, тёплый) + 5 прогонов jev + 3 сценария навыка × 2 руки.
    expect(runs).toHaveLength(14 * 2 * 2 + 5 + 3 * 2);
    expect(runs.filter((r) => r.wave === 'w3').every((r) => r.cache === 'cold')).toBe(true);
    expect(runs.filter((r) => r.jev === 'on').every((r) => r.arm === 'native')).toBe(true);
    // Тёплый прогон идёт сразу за холодным той же руки.
    const warm = runs.filter((r) => r.cache === 'warm');
    for (const run of warm) {
      const before = runs.find((r) => r.order === run.order - 1)!;
      expect(runIdOf({ ...before, cache: 'warm' })).toBe(run.id);
    }
    const estimate = estimateBudget(runs, budget);
    expect(estimate.sessions).toBe(runs.reduce((acc, r) => acc + r.sessions, 0));
    expect(estimate.pilotRuns).toBe(4);
    expect(estimate.ceilings.outputTokens).toBe(estimate.sessions * budget.perSession.maxOutputTokens);
    expect(estimate.byWave.map((w) => w.wave)).toEqual(['w1', 'w2', 'w3']);
  });

  it('у руки disabled навигатор выключен в хосте, у остальных navigator включён; навыки Parley и jev задаёт хост одинаково в обеих руках', async () => {
    const { file } = await loadFixtures();
    const byId = (id: string) => file.scenarios.find((s) => s.id === id)!;
    expect(hostEnv({ arm: 'navigator', jev: 'off' }, byId('obvious'))).toEqual([
      'PARLEY_SKILL_NAVIGATOR=true', 'PARLEY_AGENT_SKILLS=false', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0',
    ]);
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
    // Размер списка и стартовой вставки в логе Claude не лежат: неизвестно, а не 0.
    expect(collected.bytes['listingBytes']).toBeNull();
    expect(collected.bytes['bootstrapBytes']).toBeNull();
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
    const begin = await beginRun(planned, budget, tmp, { versions: () => ({ claude: '2.1.289', codex: '0.160.0' }), jevPluginIds: noJev });
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
    const a = await beginRun(off, budget, tmp, { versions, jevPluginIds: noJev });
    const b = await beginRun(on, budget, tmp, { versions, jevPluginIds: noJev });

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

describe('мод jev в копии проекта', () => {
  const MOD = 'jev-skill-suggestion@skills-dir';
  const versions = () => ({ claude: 'x', codex: 'y' });
  const exists = (file: string) => readFile(file, 'utf8').then(() => true, () => false);
  const settingsOf = (projectDir: string) => path.join(projectDir, '.claude/settings.json');
  const gitIn = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;
  /** Холодный прогон без навыка minimal-development: рука native или navigator, jev off или on. */
  async function pickRun(jev: 'off' | 'on', arm: 'native' | 'navigator' = 'native') {
    const { file, budget } = await loadFixtures();
    const run = planRuns(file, budget).find((r) => r.jev === jev && r.arm === arm && r.cache === 'cold' && r.skill === 'off')!;
    return { run, budget };
  }
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('jev off: найденные id выключаются файлом настроек копии, и файл входит в коммит копии', async () => {
    const { run, budget } = await pickRun('off');
    const ids = [MOD, 'jev-skill-suggestion@some-market'];
    const begin = await beginRun(run, budget, tmp, { versions, jevPluginIds: async () => ids });

    expect(JSON.parse(await readFile(settingsOf(begin.projectDir), 'utf8'))).toEqual({ enabledPlugins: { [MOD]: false, 'jev-skill-suggestion@some-market': false } });
    expect(begin.jevDisabled).toEqual(ids);
    const saved = JSON.parse(await readFile(path.join(tmp, 'work', run.id, 'begin.json'), 'utf8')) as { jevDisabled: string[] };
    expect(saved.jevDisabled).toEqual(ids);
    // Файл лежит в коммите копии, а не остался неотслеженным.
    expect(gitIn(begin.projectDir, 'show', 'HEAD:.claude/settings.json')).toBe(await readFile(settingsOf(begin.projectDir), 'utf8'));
    expect(gitIn(begin.projectDir, 'status', '--porcelain')).toBe('');
  });

  it('jev off в руке navigator выключается так же: условие одно у обеих рук', async () => {
    const { run, budget } = await pickRun('off', 'navigator');
    const begin = await beginRun(run, budget, tmp, { versions, jevPluginIds: async () => [MOD] });
    expect(JSON.parse(await readFile(settingsOf(begin.projectDir), 'utf8'))).toEqual({ enabledPlugins: { [MOD]: false } });
  });

  it('jev on: файла настроек нет, и мод не ищется', async () => {
    const { run, budget } = await pickRun('on');
    const begin = await beginRun(run, budget, tmp, { versions, jevPluginIds: async () => { throw new Error('при jev on мод не ищется'); } });
    expect(await exists(settingsOf(begin.projectDir))).toBe(false);
    expect(begin.jevDisabled).toEqual([]);
  });

  it('jev off, мод не установлен (пустой список): файла настроек нет', async () => {
    const { run, budget } = await pickRun('off');
    const begin = await beginRun(run, budget, tmp, { versions, jevPluginIds: noJev });
    expect(await exists(settingsOf(begin.projectDir))).toBe(false);
    expect(begin.jevDisabled).toEqual([]);
  });

  it('jev off, место установки не прочиталось (null): begin отказывает и прогон не начат', async () => {
    const { run, budget } = await pickRun('off');
    await expect(beginRun(run, budget, tmp, { versions, jevPluginIds: async () => null })).rejects.toThrow('выключение jev не проверить');
    expect(await exists(path.join(tmp, 'work', run.id, 'begin.json'))).toBe(false);
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
    expect((await beginRun(native.run, native.budget, tmp, { versions })).jevDisabled).toEqual([]);
    await installAt(path.join(tmp, 'user', '.claude'));
    expect((await beginRun(native.run, native.budget, tmp, { versions })).jevDisabled).toEqual([MOD]);

    // Копия проекта — <tmp>/work/<id>/project, поэтому `../../cfg` — это <tmp>/work/cfg.
    vi.stubEnv('HOME', path.join(tmp, 'empty-home'));
    await installAt(path.join(tmp, 'work', 'cfg'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '../../cfg');
    expect((await beginRun(navigator.run, navigator.budget, tmp, { versions })).jevDisabled).toEqual([MOD]);
  });
});

describe('дом хоста стенда и путь сокета', () => {
  it('лист запуска: PARLEY_HOME по умолчанию <out>/home, а с заданным home — он; jev off выключает файл настроек', async () => {
    const { file, budget } = await loadFixtures();
    const runs = planRuns(file, budget);
    expect(renderRunSheet(runs, file, budget, '/out')).toContain('`PARLEY_HOME=/out/home ');

    const sheet = renderRunSheet(runs, file, budget, '/out', '/short/home');
    expect(sheet).toContain('`PARLEY_HOME=/short/home ');
    expect(sheet).not.toContain('PARLEY_HOME=/out/home');
    expect(sheet).toContain('- jev off: мод выключает файл настроек копии');
    expect(sheet).toContain('- jev on: мод включён настройками CLI человека');
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
    expect(spawns.sort()).toEqual(["'git'", "'git'", "'git'", "'sh'", 'bin']);
    expect(source).toContain("spawnSync(bin, ['--version']");
  });
});
