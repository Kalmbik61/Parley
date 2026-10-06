#!/usr/bin/env -S pnpm exec tsx
/**
 * Стенд замера экономии на принятом результате (P38, пункт F05 аудита экономии токенов).
 *
 * Офлайн: ни одна команда здесь не делает платного хода модели. Живой прогон ведёт P32 в самом Parley (две
 * настройки на ход: `PARLEY_SKILL_NAVIGATOR` и фикстурный проект), а стенд готовит всё вокруг него — план и
 * бюджет, листы запуска, копию фикстурного проекта, проверку принятия, сбор записи прогона из логов
 * провайдеров и отчёт. Как запускать и сколько это стоит — `docs/research/2026-10-04-parley-token-benchmark.md`.
 *
 * Правила измерения (контракт аудита):
 * - единица сравнения — принятый результат; пара считается экономией только без потери качества;
 * - токены берутся из usage-ledger ядра (`sumUsage`): запрос и потомок один раз, неизвестное — `null`,
 *   неполный итог в разности токенов не участвует; байты, секунды и счётчики — отдельные величины;
 * - «символы, делённые на 4» и размер списка не токены: запись с полем-оценкой отвергается;
 * - холодный и тёплый кеш — разные разделы отчёта; мод jev и навык minimal-development — отдельные оси;
 * - процентов экономии нет нигде: офлайн-данные живую проверку не закрывают.
 *
 * Запуск: `pnpm exec tsx tools/parley-token-benchmark.ts <команда>`, список команд — `--help`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { indexCodexSession } from '../packages/core/src/codex/index-session.js';
import { defaultRoot, discoverSession, discoverSessions } from '../packages/core/src/discover.js';
import { forEachJsonlRecord, type RawRecord } from '../packages/core/src/jsonl.js';
import { indexSessionFile, isServiceText } from '../packages/core/src/session-index.js';
import {
  asCount,
  sumUsage,
  usageKey,
  type DescendantUsage,
  type KeyedUsage,
  type UsageCounters,
  type UsageSummary,
  type UsageTotal,
} from '../packages/core/src/work/usage-ledger.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = path.join(repoRoot, 'docs/research/2026-10-04-parley-token-benchmark');
export const DEFAULT_OUT = path.join(repoRoot, '.parley/benchmark');
const MINIMAL_DEVELOPMENT_DIR = path.join(repoRoot, '.agents/skills/minimal-development');

// ---------- Модель ----------

export const ARMS = ['native', 'navigator'] as const;
export type Arm = (typeof ARMS)[number];
export type CacheTemp = 'cold' | 'warm';
export type Toggle = 'off' | 'on';
export type Axis = 'arm' | 'jev' | 'skill';

/** Покрытие аудита: каждый пункт — один сценарий. */
export const COVERAGE = [
  'no-skill', 'obvious', 'ambiguous', 'russian', 'multiple', 'mixed', 'dm',
  'broadcast', 'amendment', 'stop-resume', 'disabled', 'unavailable', 'long-skill', 'compaction',
] as const;

/** Волна прогонов отдельных осей (jev и навык): основные волны перечислены в бюджете. */
const AXES_WAVE = 'w3';

export type Accept = { kind: 'command'; command: string } | { kind: 'human'; criteria: string };

export interface Task {
  id: string;
  title: string;
  skills: string[];
  accept: Accept;
  /** Каталог эталонного решения относительно фикстур; у задач с человеческим принятием его нет. */
  solution?: string;
}

export interface Scenario {
  id: string;
  title: string;
  coverage: (typeof COVERAGE)[number];
  task: string;
  language: 'en' | 'ru';
  prompt: string;
  followUps?: { when: string; text: string }[];
  room: { provider: 'claude' | 'codex'; role: string }[];
  armSetup?: Partial<Record<Arm, string>>;
  expectedSkills: string[];
  forbiddenSkills: string[];
  /** Потолок вызовов find_skill на прогон; больше — нарушение (пустой поиск ограничен). */
  maxLookups: number;
  operatorSteps: string[];
  axes: { jev: boolean; skill: boolean };
}

export interface ScenarioFile {
  schema: 1;
  tasks: Task[];
  scenarios: Scenario[];
}

export interface Budget {
  schema: 1;
  note: string;
  conditions: Record<'claude' | 'codex', { model: string; effort: string }>;
  repetitions: number;
  cache: { ttlSec: number; warmWithinSec: number };
  perSession: { maxTotalInputTokens: number; maxOutputTokens: number; maxMinutes: number };
  pilot: { scenarios: string[] };
  maxRuns: number;
  waves: { id: string; title: string; scenarios: string[] }[];
  stopRules: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

/** Проверка форм и ссылок фикстур сценариев; непустой список — отказ. */
export function validateScenarioFile(raw: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(raw) || raw['schema'] !== 1 || !Array.isArray(raw['tasks']) || !Array.isArray(raw['scenarios'])) {
    return ['scenarios: ждали { schema: 1, tasks, scenarios }'];
  }
  const taskIds = new Set<string>();
  for (const task of raw['tasks'] as unknown[]) {
    if (!isObject(task) || !isString(task['id']) || !isString(task['title']) || !isStrings(task['skills'])) {
      problems.push('task: нужны id, title, skills');
      continue;
    }
    if (taskIds.has(task['id'])) problems.push(`task ${task['id']}: повтор id`);
    taskIds.add(task['id']);
    const accept = task['accept'];
    const okAccept =
      isObject(accept) &&
      ((accept['kind'] === 'command' && isString(accept['command'])) ||
        (accept['kind'] === 'human' && isString(accept['criteria'])));
    if (!okAccept) problems.push(`task ${task['id']}: accept — command или human`);
    if (isObject(accept) && accept['kind'] === 'command' && !isString(task['solution'])) {
      problems.push(`task ${task['id']}: у проверяемой командой задачи нужен solution`);
    }
  }
  const covered = new Set<string>();
  const scenarioIds = new Set<string>();
  for (const item of raw['scenarios'] as unknown[]) {
    if (!isObject(item) || !isString(item['id'])) {
      problems.push('scenario: нет id');
      continue;
    }
    const id = item['id'];
    if (scenarioIds.has(id)) problems.push(`scenario ${id}: повтор id`);
    scenarioIds.add(id);
    if (!(COVERAGE as readonly unknown[]).includes(item['coverage'])) problems.push(`scenario ${id}: неизвестное coverage`);
    else covered.add(String(item['coverage']));
    if (!isString(item['prompt']) || !isString(item['title'])) problems.push(`scenario ${id}: нужны title и prompt`);
    if (!taskIds.has(String(item['task']))) problems.push(`scenario ${id}: нет задачи ${String(item['task'])}`);
    if (item['language'] !== 'en' && item['language'] !== 'ru') problems.push(`scenario ${id}: language en или ru`);
    const room = item['room'];
    if (!Array.isArray(room) || room.length === 0 || !room.every((m) => isObject(m) && (m['provider'] === 'claude' || m['provider'] === 'codex') && isString(m['role']))) {
      problems.push(`scenario ${id}: room — непустой список { provider, role }`);
    }
    if (!isStrings(item['expectedSkills']) || !isStrings(item['forbiddenSkills']) || !isStrings(item['operatorSteps'])) {
      problems.push(`scenario ${id}: expectedSkills, forbiddenSkills, operatorSteps — списки строк`);
    }
    if (typeof item['maxLookups'] !== 'number' || !Number.isInteger(item['maxLookups']) || item['maxLookups'] < 0) {
      problems.push(`scenario ${id}: maxLookups — целое не меньше 0`);
    }
    const axes = item['axes'];
    if (!isObject(axes) || typeof axes['jev'] !== 'boolean' || typeof axes['skill'] !== 'boolean') {
      problems.push(`scenario ${id}: axes { jev, skill }`);
    }
  }
  for (const item of COVERAGE) if (!covered.has(item)) problems.push(`нет сценария для покрытия ${item}`);
  return problems;
}

export function validateBudget(raw: unknown, file: ScenarioFile): string[] {
  if (!isObject(raw) || raw['schema'] !== 1) return ['budget: ждали { schema: 1, … }'];
  const problems: string[] = [];
  const budget = raw as unknown as Budget;
  const positive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!positive(budget.repetitions) || !Number.isInteger(budget.repetitions)) problems.push('budget.repetitions — целое больше 0');
  if (!isObject(budget.cache) || !positive(budget.cache.ttlSec) || !positive(budget.cache.warmWithinSec) || budget.cache.warmWithinSec >= budget.cache.ttlSec) {
    problems.push('budget.cache: warmWithinSec должно быть меньше ttlSec');
  }
  const per = budget.perSession;
  if (!isObject(per) || !positive(per.maxTotalInputTokens) || !positive(per.maxOutputTokens) || !positive(per.maxMinutes)) {
    problems.push('budget.perSession: maxTotalInputTokens, maxOutputTokens, maxMinutes — числа больше 0');
  }
  const conditions = budget.conditions;
  for (const provider of ['claude', 'codex'] as const) {
    if (!isObject(conditions) || !isObject(conditions[provider]) || !isString(conditions[provider].model) || !isString(conditions[provider].effort)) {
      problems.push(`budget.conditions.${provider}: model и effort`);
    }
  }
  const ids = new Set(file.scenarios.map((s) => s.id));
  const placed = new Map<string, number>();
  for (const wave of Array.isArray(budget.waves) ? budget.waves : []) {
    for (const id of Array.isArray(wave.scenarios) ? wave.scenarios : []) {
      if (!ids.has(id)) problems.push(`budget.waves ${wave.id}: нет сценария ${id}`);
      placed.set(id, (placed.get(id) ?? 0) + 1);
    }
  }
  for (const id of ids) if (placed.get(id) !== 1) problems.push(`сценарий ${id} должен быть ровно в одной волне`);
  if (!isObject(budget.pilot) || !Array.isArray(budget.pilot.scenarios) || budget.pilot.scenarios.some((id) => !ids.has(id))) {
    problems.push('budget.pilot.scenarios: ссылки на сценарии');
  }
  if (problems.length === 0 && planRuns(file, budget).length > budget.maxRuns) problems.push('план больше maxRuns');
  return problems;
}

export async function loadFixtures(dir = FIXTURE_DIR): Promise<{ file: ScenarioFile; budget: Budget; problems: string[] }> {
  const rawFile: unknown = JSON.parse(await readFile(path.join(dir, 'scenarios.json'), 'utf8'));
  const rawBudget: unknown = JSON.parse(await readFile(path.join(dir, 'budget.json'), 'utf8'));
  const problems = validateScenarioFile(rawFile);
  if (problems.length > 0) return { file: rawFile as ScenarioFile, budget: rawBudget as Budget, problems };
  const file = rawFile as ScenarioFile;
  const names = new Set(await readdir(path.join(dir, 'project/skills')));
  for (const task of file.tasks) {
    for (const skill of task.skills) if (!names.has(skill)) problems.push(`task ${task.id}: нет навыка ${skill} в project/skills`);
    if (task.solution !== undefined && !(await stat(path.join(dir, task.solution)).then((s) => s.isDirectory(), () => false))) {
      problems.push(`task ${task.id}: нет каталога решения ${task.solution}`);
    }
  }
  return { file, budget: rawBudget as Budget, problems: [...problems, ...validateBudget(rawBudget, file)] };
}

// ---------- План и бюджет ----------

export interface PlannedRun {
  id: string;
  order: number;
  wave: string;
  scenario: string;
  arm: Arm;
  cache: CacheTemp;
  jev: Toggle;
  skill: Toggle;
  repetition: number;
  sessions: number;
  pilot: boolean;
}

export const runIdOf = (p: Pick<PlannedRun, 'scenario' | 'arm' | 'cache' | 'jev' | 'skill' | 'repetition'>): string =>
  `${p.scenario}.${p.arm}.${p.cache}.jev-${p.jev}.skill-${p.skill}.r${p.repetition}`;

/**
 * Матрица прогонов. Основная ось: сценарий × рука × холодный/тёплый кеш (jev выключен, навык выключен).
 * Отдельные оси — только холодный кеш: jev включён (рука native) и minimal-development включён (обе руки).
 * Порядок рук чередуется, чтобы время суток не доставалось одной руке; тёплый прогон идёт сразу за холодным.
 */
export function planRuns(file: ScenarioFile, budget: Budget): PlannedRun[] {
  const byId = new Map(file.scenarios.map((s) => [s.id, s]));
  const base = (scenario: Scenario, wave: string, repetition: number, arm: Arm, cache: CacheTemp, jev: Toggle, skill: Toggle): Omit<PlannedRun, 'order'> => {
    const draft = { scenario: scenario.id, arm, cache, jev, skill, repetition };
    return {
      id: runIdOf(draft), wave, ...draft, sessions: scenario.room.length,
      pilot: wave !== AXES_WAVE && budget.pilot.scenarios.includes(scenario.id) && cache === 'cold' && repetition === 1,
    };
  };
  const planned: Omit<PlannedRun, 'order'>[] = [];
  let flip = 0;
  for (const wave of budget.waves) {
    for (const id of wave.scenarios) {
      const scenario = byId.get(id);
      if (scenario === undefined) continue;
      for (let repetition = 1; repetition <= budget.repetitions; repetition += 1, flip += 1) {
        const arms = flip % 2 === 0 ? ARMS : [...ARMS].reverse();
        for (const arm of arms) {
          planned.push(base(scenario, wave.id, repetition, arm, 'cold', 'off', 'off'));
          planned.push(base(scenario, wave.id, repetition, arm, 'warm', 'off', 'off'));
        }
      }
    }
  }
  for (const scenario of file.scenarios) {
    if (!scenario.axes.jev) continue;
    for (let repetition = 1; repetition <= budget.repetitions; repetition += 1) {
      planned.push(base(scenario, AXES_WAVE, repetition, 'native', 'cold', 'on', 'off'));
    }
  }
  for (const scenario of file.scenarios) {
    if (!scenario.axes.skill) continue;
    for (let repetition = 1; repetition <= budget.repetitions; repetition += 1) {
      for (const arm of ARMS) planned.push(base(scenario, AXES_WAVE, repetition, arm, 'cold', 'off', 'on'));
    }
  }
  return planned.map((item, index) => ({ ...item, order: index + 1 }));
}

export interface BudgetEstimate {
  runs: number;
  sessions: number;
  pilotRuns: number;
  pilotSessions: number;
  /** Потолки остановки, а не ожидание: ожидаемый расход неизвестен до пилота. */
  ceilings: { totalInputTokens: number; outputTokens: number; minutes: number };
  pilotCeilings: { totalInputTokens: number; outputTokens: number; minutes: number };
  byWave: { wave: string; runs: number; sessions: number }[];
}

export function estimateBudget(runs: PlannedRun[], budget: Budget): BudgetEstimate {
  const ceilings = (sessions: number) => ({
    totalInputTokens: sessions * budget.perSession.maxTotalInputTokens,
    outputTokens: sessions * budget.perSession.maxOutputTokens,
    minutes: sessions * budget.perSession.maxMinutes,
  });
  const sessionsOf = (list: PlannedRun[]): number => list.reduce((acc, run) => acc + run.sessions, 0);
  const pilot = runs.filter((run) => run.pilot);
  const waves = [...new Set(runs.map((run) => run.wave))];
  return {
    runs: runs.length,
    sessions: sessionsOf(runs),
    pilotRuns: pilot.length,
    pilotSessions: sessionsOf(pilot),
    ceilings: ceilings(sessionsOf(runs)),
    pilotCeilings: ceilings(sessionsOf(pilot)),
    byWave: waves.map((wave) => {
      const list = runs.filter((run) => run.wave === wave);
      return { wave, runs: list.length, sessions: sessionsOf(list) };
    }),
  };
}

/** Окружение запуска хоста Parley для руки и оси: всё, что отличает прогоны, кроме фикстурного проекта. */
export function hostEnv(run: Pick<PlannedRun, 'arm' | 'jev'>, scenario: Scenario): string[] {
  const navigator = run.arm === 'navigator' && scenario.coverage !== 'disabled';
  // Навыки Parley (parley и minimal-development) стенд доставляет сам: у обеих рук одно и то же. Мод jev
  // включается переменной окружения хоста, а не записью в настройки человека: одинаково в обеих руках.
  return [
    `PARLEY_SKILL_NAVIGATOR=${navigator}`,
    'PARLEY_AGENT_SKILLS=false',
    `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=${run.jev === 'on' ? 1 : 0}`,
  ];
}

/** Лист запуска для человека, ведущего живой прогон: всё, что нужно сделать в Parley на каждый ход. */
export function renderRunSheet(runs: PlannedRun[], file: ScenarioFile, budget: Budget, out: string): string {
  const scenarios = new Map(file.scenarios.map((s) => [s.id, s]));
  const tasks = new Map(file.tasks.map((t) => [t.id, t]));
  const lines = [
    '# Лист запуска живого прогона (P38 -> P32)',
    '',
    'Платные ходы начинаются только после явного разрешения человека. Перед каждой волной — проверка недельного лимита.',
    '',
    ...budget.stopRules.map((rule) => `- ${rule}`),
    '',
  ];
  for (const run of runs) {
    const scenario = scenarios.get(run.scenario);
    const task = tasks.get(scenario?.task ?? '');
    if (scenario === undefined || task === undefined) continue;
    const setup = scenario.armSetup?.[run.arm];
    lines.push(
      `## ${String(run.order).padStart(2, '0')}. ${run.id}${run.pilot ? ' (пилот)' : ''}`,
      '',
      `- Волна ${run.wave}, рука ${run.arm}, кеш ${run.cache}, jev ${run.jev}, minimal-development ${run.skill}, сессий ${run.sessions}.`,
      `- Начало: \`pnpm exec tsx tools/parley-token-benchmark.ts begin ${run.id} --out ${out}\``,
      `- Хост Parley: \`PARLEY_HOME=${path.join(out, 'home')} ${hostEnv(run, scenario).join(' ')}\`; проект работы — \`${path.join(out, 'work', run.id, 'project')}\`.`,
      ...(setup === undefined ? [] : [`- Особенность руки: ${setup}`]),
      ...(run.cache === 'warm' ? [`- Тёплый прогон: начать не позже ${budget.cache.warmWithinSec} с после конца холодного, того же проекта и руки; записать интервал в \`--warm-interval-sec\`.`] : []),
      `- jev ${run.jev}: переменная окружения хоста в строке выше; в транскрипте вставка \`<skill_relevance>\` должна быть только при on (проверить в пилоте).`,
      `- Участники: ${scenario.room.map((member) => `${member.provider}/${member.role}`).join(', ')}.`,
      `- Запрос: ${JSON.stringify(scenario.prompt)}`,
      ...(scenario.followUps ?? []).map((item) => `- Позже (${item.when}): ${JSON.stringify(item.text)}`),
      ...scenario.operatorSteps.map((step) => `- Шаг: ${step}`),
      task.accept.kind === 'command'
        ? `- Принятие: \`pnpm exec tsx tools/parley-token-benchmark.ts accept ${run.id} --out ${out}\` (команда \`${task.accept.command}\`).`
        : `- Принятие человеком: ${task.accept.criteria}`,
      `- Сбор: \`pnpm exec tsx tools/parley-token-benchmark.ts collect ${run.id} --claude <лог.jsonl> [--codex <rollout.jsonl>] --out ${out}\``,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------- Запись прогона ----------

export type Provenance = 'synthetic-fixture' | 'live';

export interface Conditions {
  arm: Arm;
  cache: CacheTemp;
  jev: Toggle;
  skill: Toggle;
  provider: string;
  model: string;
  effort: string;
  cli: string;
  /** Хеши состояния: minimalDevelopment, project, scenarios, budget. Разные у пары — пара не сравнивается. */
  hashes: Record<string, string>;
  /** Секунд от конца холодного прогона до начала тёплого; `null` — неизвестно. */
  warmIntervalSec: number | null;
}

type Counts = Record<string, number | null>;

export const COUNT_GROUPS = {
  skillUse: ['lookups', 'loads', 'noMatch', 'reformulations', 'duplicateLoads', 'forbiddenOffered'],
  bytes: ['bootstrapBytes', 'listingBytes', 'findSkillResultBytes', 'toolResultBytes'],
  traffic: ['messages', 'broadcasts', 'deliveries'],
  process: ['launches', 'resumes', 'retries', 'compactions', 'stops'],
} as const;
type CountGroup = keyof typeof COUNT_GROUPS;

export interface AxisEvidence {
  /** Имя minimal-development видно сессии (список имён или ответ find_skill); `null` — признаков нет. */
  minimalDevelopmentListed: boolean | null;
  /** Тело навыка загружено; `null` — наблюдения нет, а не «не загружено». */
  minimalDevelopmentLoaded: boolean | null;
  /** В транскрипте есть вставка мода jev; `null` — не замечена (мог не сработать или выбрать «ничего»). */
  jevFired: boolean | null;
}

export interface RunRecord {
  schema: 1;
  id: string;
  scenario: string;
  repetition: number;
  origin: Provenance;
  conditions: Conditions;
  /** Принято по команде или человеком; `null` — решения нет, пара не сравнивается. */
  accepted: boolean | null;
  quality: { constraintsKept: boolean | null; humanCorrections: number | null };
  usage: KeyedUsage[];
  durationMs: number | null;
  skillUse: Counts;
  bytes: Counts;
  traffic: Counts;
  process: Counts;
  loadedSkills: string[] | null;
  offeredSkills: string[] | null;
  axisEvidence: AxisEvidence;
  flags: string[];
}

const ESTIMATE_KEY = /estimat|chars?[-_]?(div|over)?4|approx|guess/i;
const COUNTER_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalInput'] as const;
const COMPLETENESS = ['complete', 'partial', 'unknown'];
const SOURCES = ['native-index', 'frozen-snapshot', 'legacy-snapshot', 'unavailable'];

function readSummary(raw: unknown, where: string, problems: string[]): UsageSummary | null {
  if (!isObject(raw) || !COMPLETENESS.includes(String(raw['completeness'])) || !SOURCES.includes(String(raw['source']))) {
    problems.push(`${where}: нет usage с completeness и source`);
    return null;
  }
  const counters = Object.fromEntries(COUNTER_KEYS.map((key) => [key, asCount(raw[key])])) as unknown as UsageCounters;
  return {
    ...counters,
    source: raw['source'] as UsageSummary['source'],
    observedAt: typeof raw['observedAt'] === 'string' ? raw['observedAt'] : null,
    stale: raw['stale'] === true,
    completeness: raw['completeness'] as UsageSummary['completeness'],
    coverage: raw['coverage'] === 'conversation-and-descendants' ? 'conversation-and-descendants' : 'conversation',
  };
}

const readCounts = (raw: unknown, keys: readonly string[]): Counts =>
  Object.fromEntries(keys.map((key) => [key, isObject(raw) ? asCount(raw[key]) : null]));

function findEstimateKeys(value: unknown, trail: string, found: string[], depth = 0): void {
  if (depth > 6 || !isObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    if (ESTIMATE_KEY.test(key)) found.push(`${trail}${key}`);
    findEstimateKeys(inner, `${trail}${key}.`, found, depth + 1);
  }
}

/** Запись прогона из недоверенного JSON. Нет поля — неизвестно; поле-оценка — отказ. */
export function parseRun(raw: unknown): { run: RunRecord } | { problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw) || raw['schema'] !== 1 || !isString(raw['id']) || !isString(raw['scenario'])) {
    return { problems: ['run: ждали { schema: 1, id, scenario, … }'] };
  }
  const estimates: string[] = [];
  findEstimateKeys(raw, '', estimates);
  for (const key of estimates) problems.push(`поле ${key}: оценка (символы/4, размер списка) не измерение токенов`);

  const origin = raw['origin'];
  if (origin !== 'synthetic-fixture' && origin !== 'live') problems.push('origin: synthetic-fixture или live');
  const repetition = raw['repetition'];
  if (typeof repetition !== 'number' || !Number.isInteger(repetition) || repetition < 1) problems.push('repetition: целое от 1');
  const c = raw['conditions'];
  const conditionsOk =
    isObject(c) &&
    (ARMS as readonly unknown[]).includes(c['arm']) &&
    (c['cache'] === 'cold' || c['cache'] === 'warm') &&
    (c['jev'] === 'off' || c['jev'] === 'on') &&
    (c['skill'] === 'off' || c['skill'] === 'on') &&
    isString(c['provider']) && isString(c['model']) && isString(c['effort']) && isString(c['cli']) &&
    isObject(c['hashes']) && Object.values(c['hashes']).every(isString);
  if (!conditionsOk) problems.push('conditions: arm, cache, jev, skill, provider, model, effort, cli, hashes');

  const entries = raw['usage'];
  const usage: KeyedUsage[] = [];
  if (!Array.isArray(entries)) problems.push('usage: ждали список { key, usage, descendants? }');
  else {
    for (const entry of entries as unknown[]) {
      if (!isObject(entry) || !isString(entry['key'])) {
        problems.push('usage[]: нет key');
        continue;
      }
      const own = readSummary(entry['usage'], `usage ${entry['key']}`, problems);
      if (own === null) continue;
      const descendants: DescendantUsage[] = [];
      for (const kid of Array.isArray(entry['descendants']) ? (entry['descendants'] as unknown[]) : []) {
        const summary = isObject(kid) && isString(kid['key']) ? readSummary(kid['usage'], `descendant ${kid['key']}`, problems) : null;
        if (summary !== null && isObject(kid)) {
          descendants.push({ key: String(kid['key']), usage: summary, ...(kid['overlapUnresolved'] === true ? { overlapUnresolved: true } : {}) });
        }
      }
      usage.push({ key: entry['key'], usage: own, ...(descendants.length > 0 ? { descendants } : {}) });
    }
  }
  if (problems.length > 0 || !isObject(c)) return { problems };

  const q = isObject(raw['quality']) ? raw['quality'] : {};
  const evidence = isObject(raw['axisEvidence']) ? raw['axisEvidence'] : {};
  const tri = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  const names = (value: unknown): string[] | null => (isStrings(value) ? value : null);
  const duration = asCount(raw['durationMs']);
  const warm = c['warmIntervalSec'];
  const run: RunRecord = {
    schema: 1,
    id: raw['id'],
    scenario: raw['scenario'],
    repetition: repetition as number,
    origin: origin as Provenance,
    conditions: {
      arm: c['arm'] as Arm, cache: c['cache'] as CacheTemp, jev: c['jev'] as Toggle, skill: c['skill'] as Toggle,
      provider: String(c['provider']), model: String(c['model']), effort: String(c['effort']), cli: String(c['cli']),
      hashes: c['hashes'] as Record<string, string>,
      warmIntervalSec: typeof warm === 'number' && Number.isFinite(warm) && warm >= 0 ? warm : null,
    },
    accepted: tri(raw['accepted']),
    quality: { constraintsKept: tri(q['constraintsKept']), humanCorrections: asCount(q['humanCorrections']) },
    usage,
    durationMs: duration,
    skillUse: readCounts(raw['skillUse'], COUNT_GROUPS.skillUse),
    bytes: readCounts(raw['bytes'], COUNT_GROUPS.bytes),
    traffic: readCounts(raw['traffic'], COUNT_GROUPS.traffic),
    process: readCounts(raw['process'], COUNT_GROUPS.process),
    loadedSkills: names(raw['loadedSkills']),
    offeredSkills: names(raw['offeredSkills']),
    axisEvidence: {
      minimalDevelopmentListed: tri(evidence['minimalDevelopmentListed']),
      minimalDevelopmentLoaded: tri(evidence['minimalDevelopmentLoaded']),
      jevFired: tri(evidence['jevFired']),
    },
    flags: isStrings(raw['flags']) ? raw['flags'] : [],
  };
  return { run };
}

// ---------- Статистика и пары ----------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Процентиль по ближайшему рангу: на малых выборках — реальное наблюдение, а не интерполяция. */
export function nearestRank(values: number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1))]!;
}

export type MetricGroup = 'tokens' | 'time' | CountGroup;

interface Metric {
  name: string;
  group: MetricGroup;
  get: (run: RunRecord, total: UsageTotal) => number | null;
}

/** Токены — только из полного итога: нижняя граница и устаревшее в разности не участвуют. */
const tokenOf = (field: keyof UsageCounters) => (_run: RunRecord, total: UsageTotal): number | null =>
  total.completeness === 'complete' && !total.stale ? total[field] : null;

export const METRICS: readonly Metric[] = [
  ...COUNTER_KEYS.map((field): Metric => ({ name: field, group: 'tokens', get: tokenOf(field) })),
  { name: 'durationMs', group: 'time', get: (run) => run.durationMs },
  { name: 'humanCorrections', group: 'process', get: (run) => run.quality.humanCorrections },
  ...(Object.keys(COUNT_GROUPS) as CountGroup[]).flatMap((group) =>
    COUNT_GROUPS[group].map((name): Metric => ({ name, group, get: (run) => run[group][name] ?? null })),
  ),
];

export interface MetricStats {
  metric: string;
  group: MetricGroup;
  /** Чистых пар, где обе стороны известны. */
  known: number;
  /** Чистых пар с неизвестной или неполной стороной: в разность не вошли. */
  unknown: number;
  median: number | null;
  p90: number | null;
  max: number | null;
  min: number | null;
  /** Пара с наибольшим ростом ресурса у проверяемой стороны. */
  worstPair: string | null;
  lower: number;
  equal: number;
  higher: number;
}

export interface PairView {
  scenario: string;
  repetition: number;
  base: string;
  test: string;
  diffs: Record<string, number | null>;
  notes: string[];
}

export interface Section {
  axis: Axis;
  label: string;
  cache: CacheTemp;
  base: string;
  test: string;
  /** Пар, у которых нашлись обе стороны. */
  candidates: number;
  clean: PairView[];
  excluded: { pair: string; reason: string }[];
  /** Принятая база, непринятая или худшая по качеству проверяемая сторона: экономией не считается. */
  regressions: { pair: string; reasons: string[] }[];
  qualityUnknown: number;
  stats: MetricStats[];
}

interface AxisSpec {
  axis: Axis;
  values: [string, string];
  of: (c: Conditions) => string;
}

const AXIS_SPECS: Record<Axis, AxisSpec> = {
  arm: { axis: 'arm', values: ['native', 'navigator'], of: (c) => c.arm },
  jev: { axis: 'jev', values: ['off', 'on'], of: (c) => c.jev },
  skill: { axis: 'skill', values: ['off', 'on'], of: (c) => c.skill },
};

const ARM_SKILL_FIELDS = ['arm', 'jev', 'skill'] as const;

function conditionMismatch(a: Conditions, b: Conditions): string | null {
  for (const field of ['provider', 'model', 'effort', 'cli'] as const) if (a[field] !== b[field]) return field;
  for (const key of new Set([...Object.keys(a.hashes), ...Object.keys(b.hashes)])) {
    if (a.hashes[key] !== b.hashes[key]) return `hashes.${key}`;
  }
  return null;
}

/** Попала ли сторона оси в проверяемое значение по наблюдённым признакам (минимум для jev и навыка). */
function axisProven(axis: Axis, value: string, run: RunRecord): boolean {
  const evidence = run.axisEvidence;
  if (axis === 'skill') return evidence.minimalDevelopmentListed === (value === 'on');
  if (axis === 'jev') return value === 'on' ? evidence.jevFired === true : evidence.jevFired !== true;
  return true;
}

const hitRatio = (total: UsageTotal): number | null =>
  total.cacheRead === null || total.totalInput === null || total.totalInput === 0 ? null : total.cacheRead / total.totalInput;

export interface PairOptions {
  /** Тёплый прогон начат не позже этого числа секунд после холодного. */
  warmWithinSec: number;
}

/**
 * Парное сравнение одной оси при одном кеше. `fixed` — остальные оси, которые у обеих сторон равны заданному
 * значению (основная ось сравнивает руки только при выключенных jev и навыке и т. д.).
 * Разность: проверяемая сторона минус база; отрицательная — проверяемая сторона расходует меньше.
 */
export function pairSection(
  runs: RunRecord[],
  axis: Axis,
  cache: CacheTemp,
  fixed: Partial<Record<(typeof ARM_SKILL_FIELDS)[number], string>>,
  options: PairOptions,
): Section {
  const spec = AXIS_SPECS[axis];
  const [baseValue, testValue] = spec.values;
  const candidates = runs.filter(
    (run) => run.conditions.cache === cache && ARM_SKILL_FIELDS.every((field) => field === axis || fixed[field] === undefined || run.conditions[field] === fixed[field]),
  );
  const groups = new Map<string, RunRecord[]>();
  for (const run of candidates) {
    const c = run.conditions;
    const key = [run.scenario, run.repetition, c.provider, c.model, c.effort, ...ARM_SKILL_FIELDS.filter((f) => f !== axis).map((f) => c[f])].join('|');
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const section: Section = {
    axis, cache, base: baseValue, test: testValue, candidates: 0, clean: [], excluded: [], regressions: [], qualityUnknown: 0, stats: [],
    label: `${axis}${Object.entries(fixed).filter(([f]) => f !== axis).map(([f, v]) => ` (${f}=${v})`).join('')}`,
  };
  for (const [key, group] of groups) {
    const bases = group.filter((run) => spec.of(run.conditions) === baseValue);
    const tests = group.filter((run) => spec.of(run.conditions) === testValue);
    const name = key.split('|').slice(0, 2).join(' r');
    if (bases.length > 1 || tests.length > 1) {
      section.excluded.push({ pair: name, reason: 'duplicate-runs' });
      continue;
    }
    const [base, test] = [bases[0], tests[0]];
    if (base === undefined || test === undefined) {
      // Оси jev и навыка запускаются выборочно: база без проверяемой стороны — не запланированная пара, а не пропуск.
      if (test === undefined && axis !== 'arm') continue;
      section.excluded.push({ pair: name, reason: base === undefined ? 'unpaired-no-base' : 'unpaired-no-test' });
      continue;
    }
    section.candidates += 1;
    const mismatch = conditionMismatch(base.conditions, test.conditions);
    if (mismatch !== null) {
      section.excluded.push({ pair: name, reason: `conditions-mismatch:${mismatch}` });
      continue;
    }
    if (!axisProven(axis, baseValue, base) || !axisProven(axis, testValue, test)) {
      section.excluded.push({ pair: name, reason: 'axis-unverified' });
      continue;
    }
    if (cache === 'warm') {
      const intervals = [base, test].map((run) => run.conditions.warmIntervalSec);
      if (intervals.some((value) => value === null)) {
        section.excluded.push({ pair: name, reason: 'warm-interval-unknown' });
        continue;
      }
      if (intervals.some((value) => value! > options.warmWithinSec)) {
        section.excluded.push({ pair: name, reason: 'warm-ttl-exceeded' });
        continue;
      }
    }
    if (base.accepted === null || test.accepted === null) {
      section.excluded.push({ pair: name, reason: 'acceptance-unknown' });
      continue;
    }
    if (!base.accepted) {
      section.excluded.push({ pair: name, reason: 'baseline-not-accepted' });
      continue;
    }
    const reasons: string[] = [];
    if (!test.accepted) reasons.push('not-accepted');
    if (test.quality.constraintsKept === false && base.quality.constraintsKept !== false) reasons.push('constraints-broken');
    const [bc, tc] = [base.quality.humanCorrections, test.quality.humanCorrections];
    if (bc !== null && tc !== null && tc > bc) reasons.push('more-human-corrections');
    if (reasons.length > 0) {
      section.regressions.push({ pair: name, reasons });
      continue;
    }
    if (test.quality.constraintsKept === null || base.quality.constraintsKept === null || bc === null || tc === null) section.qualityUnknown += 1;

    const [baseTotal, testTotal] = [sumUsage(base.usage), sumUsage(test.usage)];
    const notes: string[] = [];
    const [baseHit, testHit] = [hitRatio(baseTotal), hitRatio(testTotal)];
    if (baseHit !== null && testHit !== null && Math.abs(baseHit - testHit) > 0.25) notes.push('cache-unbalanced');
    if (cache === 'cold' && [baseHit, testHit].some((value) => value !== null && value > 0.5)) notes.push('cold-not-clean');
    if (cache === 'warm' && [baseHit, testHit].some((value) => value === 0)) notes.push('warm-not-observed');
    const diffs: Record<string, number | null> = {};
    for (const metric of METRICS) {
      const [b, t] = [metric.get(base, baseTotal), metric.get(test, testTotal)];
      diffs[metric.name] = b === null || t === null ? null : t - b;
    }
    section.clean.push({ scenario: base.scenario, repetition: base.repetition, base: base.id, test: test.id, diffs, notes });
  }

  section.stats = METRICS.map((metric): MetricStats => {
    const known = section.clean.flatMap((pair) => (pair.diffs[metric.name] === null || pair.diffs[metric.name] === undefined ? [] : [{ pair, diff: pair.diffs[metric.name]! }]));
    const diffs = known.map((item) => item.diff);
    const max = diffs.length === 0 ? null : Math.max(...diffs);
    return {
      metric: metric.name, group: metric.group, known: known.length, unknown: section.clean.length - known.length,
      median: median(diffs), p90: nearestRank(diffs, 90), max, min: diffs.length === 0 ? null : Math.min(...diffs),
      worstPair: max === null || max <= 0 ? null : (known.find((item) => item.diff === max)?.pair.test ?? null),
      lower: diffs.filter((d) => d < 0).length, equal: diffs.filter((d) => d === 0).length, higher: diffs.filter((d) => d > 0).length,
    };
  });
  return section;
}

// ---------- Отчёт ----------

export interface Violation {
  run: string;
  rule: 'lookups-over-limit' | 'forbidden-offered' | 'expected-skill-not-loaded';
  detail: string;
}

/** Условия приёмки сценария по самой записи: пустой поиск ограничен, запрещённые навыки не предлагаются. */
export function gateViolations(run: RunRecord, scenario: Scenario | undefined): Violation[] {
  if (scenario === undefined) return [];
  const found: Violation[] = [];
  const lookups = run.skillUse['lookups'] ?? null;
  if (lookups !== null && lookups > scenario.maxLookups) {
    found.push({ run: run.id, rule: 'lookups-over-limit', detail: `${lookups} > ${scenario.maxLookups}` });
  }
  const offered = (run.offeredSkills ?? []).filter((name) => scenario.forbiddenSkills.includes(name));
  if (offered.length > 0) found.push({ run: run.id, rule: 'forbidden-offered', detail: offered.join(', ') });
  // Загрузка читается по транскрипту; у руки с вставкой jev её не видно, поэтому там не проверяется.
  if (run.loadedSkills !== null && run.conditions.jev === 'off' && run.accepted === true) {
    const missing = scenario.expectedSkills.filter((name) => !run.loadedSkills!.includes(name));
    if (missing.length > 0) found.push({ run: run.id, rule: 'expected-skill-not-loaded', detail: missing.join(', ') });
  }
  return found;
}

export interface Report {
  runs: number;
  origins: Record<Provenance, number>;
  coverage: { scenario: string; coverage: string; runs: number; missingCells: string[] }[];
  sections: Section[];
  incompleteRuns: { run: string; why: string[] }[];
  violations: Violation[];
}

export function buildReport(runs: RunRecord[], file: ScenarioFile, options: PairOptions): Report {
  const scenarios = new Map(file.scenarios.map((s) => [s.id, s]));
  const sections: Section[] = [];
  const add = (axis: Axis, cache: CacheTemp, fixed: Parameters<typeof pairSection>[3]): void => {
    const section = pairSection(runs, axis, cache, fixed, options);
    if (section.candidates > 0 || section.excluded.length > 0) sections.push(section);
  };
  for (const cache of ['cold', 'warm'] as const) add('arm', cache, { jev: 'off', skill: 'off' });
  add('jev', 'cold', { arm: 'native', skill: 'off' });
  for (const arm of ARMS) add('skill', 'cold', { arm, jev: 'off' });

  const incompleteRuns = runs.flatMap((run) => {
    const total = sumUsage(run.usage);
    const why: string[] = [];
    if (total.completeness !== 'complete') why.push(`usage ${total.completeness}`);
    if (total.stale) why.push('usage stale');
    if (run.accepted === null) why.push('acceptance unknown');
    if (run.durationMs === null) why.push('duration unknown');
    return why.length === 0 ? [] : [{ run: run.id, why }];
  });
  const cells = (scenario: string): string[] =>
    ARMS.flatMap((arm) => (['cold', 'warm'] as const).flatMap((cache) =>
      runs.some((r) => r.scenario === scenario && r.conditions.arm === arm && r.conditions.cache === cache && r.conditions.jev === 'off' && r.conditions.skill === 'off') ? [] : [`${arm}/${cache}`]));
  return {
    runs: runs.length,
    origins: { 'synthetic-fixture': runs.filter((r) => r.origin === 'synthetic-fixture').length, live: runs.filter((r) => r.origin === 'live').length },
    coverage: file.scenarios.map((s) => ({ scenario: s.id, coverage: s.coverage, runs: runs.filter((r) => r.scenario === s.id).length, missingCells: cells(s.id) })),
    sections,
    incompleteRuns,
    violations: runs.flatMap((run) => gateViolations(run, scenarios.get(run.scenario))),
  };
}

const GROUP_TITLES: Record<MetricGroup, string> = {
  tokens: 'Токены из usage-ledger (только полные итоги)',
  time: 'Время журнала, мс (включает ожидание человека)',
  skillUse: 'Навыки: поиск и загрузка',
  bytes: 'Байты (диагностика, не токены)',
  traffic: 'Письма и рассылки',
  process: 'Попытки, сжатия, правки человека',
};

const fmt = (value: number | null): string => (value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(1));
const signed = (value: number | null): string => (value === null ? 'n/a' : `${value > 0 ? '+' : ''}${fmt(value)}`);

export function renderReport(report: Report): string {
  const lines: string[] = ['# Отчёт стенда замера токенов (P38)', ''];
  const { origins } = report;
  lines.push(
    origins.live === 0
      ? `**Данные офлайн-фикстур (${origins['synthetic-fixture']} записей).** Отчёт показывает форму и арифметику, а не результат: экономия не заявляется, живую проверку P32 офлайн-данные не закрывают.`
      : `Записей: живых ${origins.live}, фикстурных ${origins['synthetic-fixture']}. Разности ниже — наблюдения, а не вердикт: принятие и человеческую разметку закрывает P32, процент экономии не вычисляется.`,
    '',
    'Разность = проверяемая сторона минус база: отрицательная — проверяемая сторона расходует меньше. Сравниваются только принятые результаты без потери качества; пары с неизвестной стороной в разность не входят.',
    '',
    '## Покрытие сценариев',
    '',
    '| Сценарий | Покрытие | Записей | Нет ячейки основной оси (рука/кеш) |',
    '|---|---|---:|---|',
    ...report.coverage.map((row) => `| ${row.scenario} | ${row.coverage} | ${row.runs} | ${row.missingCells.join(', ') || '-'} |`),
    '',
  );
  for (const section of report.sections) {
    lines.push(
      `## ${section.label}, кеш ${section.cache}: ${section.test} против ${section.base}`,
      '',
      `Пар с обеими сторонами: ${section.candidates}; чистых: ${section.clean.length}; исключено: ${section.excluded.length}; без экономии из-за качества: ${section.regressions.length}; качество частично неизвестно: ${section.qualityUnknown}.`,
      '',
    );
    const cacheNotes = section.clean.filter((pair) => pair.notes.length > 0);
    if (cacheNotes.length > 0) lines.push(`Оговорки по кешу: ${cacheNotes.map((pair) => `${pair.test} (${pair.notes.join(', ')})`).join('; ')}.`, '');
    for (const group of Object.keys(GROUP_TITLES) as MetricGroup[]) {
      const rows = section.stats.filter((stat) => stat.group === group && (stat.known > 0 || stat.unknown > 0));
      if (rows.length === 0) continue;
      lines.push(
        `### ${GROUP_TITLES[group]}`,
        '',
        '| Величина | Известно / неизвестно | Медиана | p90 | Максимум (хвост) | Минимум | Меньше / равно / больше | Худшая пара |',
        '|---|---:|---:|---:|---:|---:|---|---|',
        ...rows.map((s) => `| ${s.metric} | ${s.known} / ${s.unknown} | ${signed(s.median)} | ${signed(s.p90)} | ${signed(s.max)} | ${signed(s.min)} | ${s.lower} / ${s.equal} / ${s.higher} | ${s.worstPair ?? '-'} |`),
        '',
      );
    }
    if (section.regressions.length > 0) {
      lines.push('Потеря качества (экономией не считается):', '', ...section.regressions.map((r) => `- ${r.pair}: ${r.reasons.join(', ')}`), '');
    }
    if (section.excluded.length > 0) {
      lines.push('Исключённые пары:', '', ...section.excluded.map((e) => `- ${e.pair}: ${e.reason}`), '');
    }
  }
  lines.push('## Нарушения условий приёмки', '', ...(report.violations.length === 0 ? ['Нет.'] : report.violations.map((v) => `- ${v.run}: ${v.rule} (${v.detail})`)), '');
  lines.push('## Неполные данные', '', ...(report.incompleteRuns.length === 0 ? ['Нет.'] : report.incompleteRuns.map((r) => `- ${r.run}: ${r.why.join(', ')}`)), '');
  return `${lines.join('\n')}\n`;
}

// ---------- Хеши и подготовка прогона ----------

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function treeFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await treeFiles(full, base)));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/** Хеш дерева каталога: пути и содержимое, в порядке имён. */
export async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relative of await treeFiles(dir)) hash.update(`${relative}\0`).update(await readFile(path.join(dir, relative))).update('\0');
  return hash.digest('hex');
}

export async function fixtureHashes(dir = FIXTURE_DIR): Promise<Record<string, string>> {
  const minimal = await readFile(path.join(MINIMAL_DEVELOPMENT_DIR, 'SKILL.md'));
  return {
    minimalDevelopment: sha256(minimal),
    project: await hashTree(path.join(dir, 'project')),
    scenarios: sha256(await readFile(path.join(dir, 'scenarios.json'))),
    budget: sha256(await readFile(path.join(dir, 'budget.json'))),
  };
}

function cliVersion(bin: string): string {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return result.status === 0 ? result.stdout.trim().split('\n')[0] ?? 'unknown' : 'unknown';
}

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@invalid', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
};

export interface BeginRecord {
  id: string;
  scenario: string;
  repetition: number;
  conditions: Conditions;
  projectDir: string;
  startedAt: string;
}

/**
 * Копия фикстурного проекта для прогона: навыки лежат в родных каталогах `.agents/skills` и `.claude/skills`
 * копии (домашние каталоги CLI не трогаются), minimal-development — только на оси навыка. Копия — git-репозиторий.
 */
export async function beginRun(
  planned: PlannedRun,
  budget: Budget,
  out: string,
  deps: { versions?: () => { claude: string; codex: string }; fixtureDir?: string } = {},
): Promise<BeginRecord> {
  const fixtureDir = deps.fixtureDir ?? FIXTURE_DIR;
  const workDir = path.join(out, 'work', planned.id);
  const projectDir = path.join(workDir, 'project');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await cp(path.join(fixtureDir, 'project'), projectDir, { recursive: true });
  for (const name of await readdir(path.join(projectDir, 'skills'))) {
    for (const home of ['.agents/skills', '.claude/skills']) await cp(path.join(projectDir, 'skills', name), path.join(projectDir, home, name), { recursive: true });
  }
  await rm(path.join(projectDir, 'skills'), { recursive: true });
  if (planned.skill === 'on') {
    for (const home of ['.agents/skills', '.claude/skills']) {
      await cp(MINIMAL_DEVELOPMENT_DIR, path.join(projectDir, home, 'minimal-development'), { recursive: true });
    }
  }
  git(projectDir, 'init', '-q');
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'fixture');

  const versions = (deps.versions ?? (() => ({ claude: cliVersion('claude'), codex: cliVersion('codex') })))();
  const claudeModel = budget.conditions.claude;
  const record: BeginRecord = {
    id: planned.id,
    scenario: planned.scenario,
    repetition: planned.repetition,
    conditions: {
      arm: planned.arm, cache: planned.cache, jev: planned.jev, skill: planned.skill,
      provider: 'claude', model: claudeModel.model, effort: claudeModel.effort,
      cli: `claude ${versions.claude}; codex ${versions.codex}`,
      hashes: await fixtureHashes(fixtureDir),
      warmIntervalSec: null,
    },
    projectDir,
    startedAt: new Date().toISOString(),
  };
  await writeFile(path.join(workDir, 'begin.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Проверка принятия в копии проекта: офлайн-команда задачи, без модели. */
export function runAcceptance(command: string, cwd: string): { passed: boolean; output: string } {
  const result = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 60000 });
  return { passed: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

// ---------- Сбор из логов провайдеров ----------

interface SessionCollected {
  entry: KeyedUsage;
  startedAt: string | null;
  endedAt: string | null;
  skillUse: Counts;
  bytes: Counts;
  traffic: Counts;
  compactions: number;
  loaded: string[];
  offered: string[];
  listedNames: string[] | null;
  jevFired: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (isObject(value) ? value : null);

/** Текст результата инструмента: строка или блоки `text`. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isObject(block) && typeof block['text'] === 'string' ? block['text'] : '')).join('');
}

/** Все строки внутри значения: формат вложений не документирован, текст вставки может лежать не только в `content`. */
const stringsIn = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(stringsIn) : isObject(value) ? Object.values(value).flatMap(stringsIn) : [];

const JEV_NAME = /Relevant to the current request: (\S+?)\.(?:\s|$)/;

/**
 * Выбор мода jev из записи транскрипта в настоящем виде: `attachment` типа `hook_additional_context` (ответ хука
 * UserPromptSubmit) с фразой «Relevant to the current request: <имя навыка>.»; имя — до первой точки, может
 * содержать двоеточие. `null` — это не вставка jev. Запись подагента (`isSidechain`), tool_result, сообщение
 * ассистента и вложение другого типа вставкой не считаются, даже если в них та же фраза.
 */
function jevPickOfAttachment(record: RawRecord): string | null {
  const attachment = asRecord(record['attachment']);
  if (attachment?.['type'] !== 'hook_additional_context' || record['isSidechain'] === true) return null;
  return JEV_NAME.exec(stringsIn(attachment).join('\n'))?.[1] ?? null;
}

/**
 * Разбор транскриптов Claude (главный файл и файлы подагентов): токены берёт индекс ядра с ledger, остальное —
 * одним проходом по записям. Что в логе не видно (приходит от Parley, а не от CLI), остаётся `null`.
 */
export async function collectClaudeSession(file: string, knownSkills: readonly string[]): Promise<SessionCollected> {
  const root = path.dirname(path.dirname(file));
  const discovered = await discoverSession(file, root);
  const index = await indexSessionFile(file, root, { subagents: discovered.subagents });
  if (index.usage === undefined) throw new Error(`${file}: в логе нет учёта usage`);

  const names = new Map<string, { tool: string; skill: string | null }>();
  const loaded: string[] = [];
  const offered = new Set<string>();
  const listed = new Set<string>();
  let sawListing = false;
  let [lookups, noMatch, reformulations, resultBytes, findBytes, messages, broadcasts, compactions] = [0, 0, 0, 0, 0, 0, 0, 0];
  let lookupsSinceLoad = 0;
  let jevFired = false;

  const files = [file, ...discovered.subagents.map((agent) => agent.file)];
  for (const source of files) {
    // Поправка поиска считается внутри одного разговора: подагент свой поиск начинает заново.
    lookupsSinceLoad = 0;
    await forEachJsonlRecord(source, (record: RawRecord) => {
      if (record['subtype'] === 'compact_boundary' || record['isCompactSummary'] === true) compactions += 1;
      const attachment = asRecord(record['attachment']);
      if (attachment?.['type'] === 'skill_listing') {
        sawListing = true;
        for (const name of Array.isArray(attachment['names']) ? attachment['names'] : []) if (typeof name === 'string') listed.add(name);
      }
      if (jevPickOfAttachment(record) !== null) jevFired = true;
      const message = asRecord(record['message']);
      const content = message?.['content'];
      if (typeof content === 'string') {
        if (content.includes('<skill_relevance>')) jevFired = true;
        return;
      }
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const item = asRecord(block);
        if (item === null) continue;
        if (item['type'] === 'text' && typeof item['text'] === 'string' && item['text'].includes('<skill_relevance>')) jevFired = true;
        if (item['type'] === 'tool_use' && typeof item['name'] === 'string' && typeof item['id'] === 'string') {
          const input = asRecord(item['input']) ?? {};
          const tool = item['name'];
          const skill = tool === 'Skill' ? (['skill', 'name', 'command'].map((k) => input[k]).find(isString) ?? null) : null;
          names.set(item['id'], { tool, skill });
          if (tool.endsWith('__find_skill')) {
            lookups += 1;
            if (lookupsSinceLoad > 0) reformulations += 1;
            lookupsSinceLoad += 1;
          }
          if (skill !== null) {
            loaded.push(skill);
            lookupsSinceLoad = 0;
          }
          if (tool.endsWith('__send_message')) {
            messages += 1;
            const to = input['to'];
            if (isString(input['room']) && (to === undefined || to === '' || (Array.isArray(to) && to.length === 0))) broadcasts += 1;
          }
        }
        if (item['type'] === 'tool_result' && typeof item['tool_use_id'] === 'string') {
          const text = resultText(item['content']);
          const bytes = Buffer.byteLength(text);
          resultBytes += bytes;
          if (names.get(item['tool_use_id'])?.tool.endsWith('__find_skill') === true) {
            findBytes += bytes;
            if (text.startsWith('No skill matched')) noMatch += 1;
            for (const skillName of knownSkills) if (text.includes(skillName)) offered.add(skillName);
          }
        }
      }
    });
  }
  const unique = new Set(loaded);
  return {
    entry: { key: usageKey('claude', index.id, null), usage: index.usage },
    startedAt: index.startedAt,
    endedAt: index.endedAt,
    skillUse: { lookups, loads: loaded.length, noMatch, reformulations, duplicateLoads: loaded.length - unique.size, forbiddenOffered: null },
    bytes: { bootstrapBytes: null, listingBytes: null, findSkillResultBytes: findBytes, toolResultBytes: resultBytes },
    traffic: { messages, broadcasts, deliveries: null },
    compactions,
    loaded,
    offered: [...offered],
    listedNames: sawListing ? [...listed] : null,
    jevFired,
  };
}

/** Логи Codex: токены — индекс ядра; потомки (порождённые треды) прикрепляются к родителю по `parentId`. */
export async function collectCodexSessions(files: string[]): Promise<{ entries: KeyedUsage[]; startedAt: string | null; endedAt: string | null; orphans: number }> {
  const indexes = await Promise.all(files.map((file) => indexCodexSession(file)));
  const parents = indexes.filter((index) => index.spawned !== true);
  const children = indexes.filter((index) => index.spawned === true);
  const claimed = new Set<string>();
  const entries = parents.map((parent): KeyedUsage => {
    const kids = children.filter((child) => child.parentId === parent.id);
    for (const kid of kids) claimed.add(kid.id);
    const descendants = kids.flatMap((kid): DescendantUsage[] =>
      kid.usage === undefined ? [] : [{ key: usageKey('codex', kid.id, kid.startedAt), usage: kid.usage, ...(kid.forkedFrom === undefined ? {} : { overlapUnresolved: true }) }]);
    const usage: UsageSummary = parent.usage ?? { input: null, output: null, cacheRead: null, cacheWrite: null, totalInput: null, source: 'unavailable', observedAt: null, stale: false, completeness: 'unknown', coverage: 'conversation' };
    return { key: usageKey('codex', parent.id, null), usage, ...(descendants.length > 0 ? { descendants } : {}) };
  });
  const times = indexes.flatMap((index) => [index.startedAt, index.endedAt]).filter((value): value is string => value !== null).sort();
  return { entries, startedAt: times[0] ?? null, endedAt: times[times.length - 1] ?? null, orphans: children.filter((child) => !claimed.has(child.id)).length };
}

export interface CollectInput {
  begin: BeginRecord;
  claude: string[];
  codex: string[];
  accepted: boolean | null;
  constraintsKept: boolean | null;
  humanCorrections: number | null;
  warmIntervalSec: number | null;
  /** То, что видно только оператору Parley (запуски, возобновления, остановки и т. п.): `имя=число`. */
  set: string[];
  knownSkills: string[];
  origin: Provenance;
}

export async function collectRun(input: CollectInput): Promise<RunRecord> {
  const flags: string[] = [];
  const claude = await Promise.all(input.claude.map((file) => collectClaudeSession(file, input.knownSkills)));
  const codex = input.codex.length > 0 ? await collectCodexSessions(input.codex) : null;
  if (claude.length + input.codex.length === 0) throw new Error('нужен хотя бы один лог сессии');
  if (codex !== null && codex.orphans > 0) flags.push(`codex-orphan-descendants:${codex.orphans}`);
  if (codex !== null) flags.push('codex-tool-counters-not-collected');

  const sum = (pick: (s: SessionCollected) => number | null): number | null =>
    codex !== null ? null : claude.reduce<number | null>((acc, s) => (acc === null || pick(s) === null ? null : acc + pick(s)!), 0);
  const group = (key: 'skillUse' | 'bytes' | 'traffic', keys: readonly string[]): Counts =>
    Object.fromEntries(keys.map((name) => [name, sum((s) => s[key][name] ?? null)]));
  const times = [...claude.flatMap((s) => [s.startedAt, s.endedAt]), codex?.startedAt ?? null, codex?.endedAt ?? null].filter((v): v is string => v !== null).sort();
  const loaded = claude.flatMap((s) => s.loaded);
  const listings = claude.map((s) => s.listedNames);
  const offered = claude.flatMap((s) => s.offered);
  const md = 'minimal-development';
  const sawListing = listings.some((names) => names !== null);

  const overrides: Counts = {};
  for (const item of input.set) {
    const [name, value] = item.split('=');
    const count = asCount(Number(value));
    if (name === undefined || value === undefined || value === '' || count === null) throw new Error(`--set ${item}: ждали имя=целое`);
    overrides[name] = count;
  }
  const known = new Set<string>(Object.values(COUNT_GROUPS).flat());
  for (const name of Object.keys(overrides)) if (!known.has(name)) throw new Error(`--set ${name}: неизвестная величина`);
  const merged = (key: CountGroup, base: Counts): Counts => ({ ...base, ...Object.fromEntries(COUNT_GROUPS[key].flatMap((name) => (name in overrides ? [[name, overrides[name] ?? null]] : []))) });

  const process = merged('process', { launches: null, resumes: null, retries: null, compactions: codex !== null ? null : claude.reduce((acc, s) => acc + s.compactions, 0), stops: null });
  const run: RunRecord = {
    schema: 1,
    id: input.begin.id,
    scenario: input.begin.scenario,
    repetition: input.begin.repetition,
    origin: input.origin,
    conditions: { ...input.begin.conditions, warmIntervalSec: input.warmIntervalSec },
    accepted: input.accepted,
    quality: { constraintsKept: input.constraintsKept, humanCorrections: input.humanCorrections },
    usage: [...claude.map((s) => s.entry), ...(codex?.entries ?? [])],
    durationMs: times.length < 2 ? null : Date.parse(times[times.length - 1]!) - Date.parse(times[0]!),
    skillUse: merged('skillUse', group('skillUse', COUNT_GROUPS.skillUse)),
    bytes: merged('bytes', group('bytes', COUNT_GROUPS.bytes)),
    traffic: merged('traffic', group('traffic', COUNT_GROUPS.traffic)),
    process,
    loadedSkills: codex !== null ? null : loaded,
    offeredSkills: codex !== null ? null : offered,
    axisEvidence: {
      // Список имён Claude или ответ find_skill называют навык: иначе признаков нет, а не «отсутствует».
      minimalDevelopmentListed: !sawListing && offered.length === 0 ? null : listings.some((names) => names?.includes(md) === true) || offered.includes(md),
      minimalDevelopmentLoaded: loaded.includes(md) ? true : null,
      jevFired: claude.some((s) => s.jevFired) ? true : null,
    },
    flags,
  };
  return run;
}

// ---------- Лист разметки для P32 ----------

export interface PromptCandidate {
  text: string;
  jevPick: string | null;
  source: string;
}

const SECRET = /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|Bearer\s+[A-Za-z0-9._-]{20,}|\b[0-9a-f]{40,}\b/g;
const JEV_BLOCK = /<skill_relevance>([\s\S]*?)<\/skill_relevance>/;
export const PROMPT_MAX_CHARS = 1500;

/**
 * Настоящие реплики человека из транскрипта Claude и выбор мода jev по каждой. В транскриптах Claude Code вставка
 * jev — отдельная запись `attachment` типа `hook_additional_context` (ответ хука UserPromptSubmit, обычно в блоке
 * `<skill_relevance>`) после реплики и до ответа ассистента; выбор — имя после «Relevant to the current request».
 * Вставка относится к последней реплике человека перед ней; тот же текст в tool_result, в сообщении ассистента или в
 * другом вложении вставкой не считается. Прежний вид — блок `<skill_relevance>` в тексте реплики или служебной записи —
 * тоже узнаётся; из текста реплики блок вырезается: размечающий его не видит.
 */
export async function extractPrompts(file: string): Promise<PromptCandidate[]> {
  const found: PromptCandidate[] = [];
  let current: PromptCandidate | null = null;
  const source = sha256(file).slice(0, 12);
  await forEachJsonlRecord(file, (record) => {
    if (asRecord(record['attachment']) !== null) {
      const pick = jevPickOfAttachment(record);
      if (current !== null && pick !== null) current.jevPick = pick;
      return;
    }
    const message = asRecord(record['message']);
    const role = message?.['role'];
    const content = message?.['content'];
    if (role === 'assistant') {
      current = null;
      return;
    }
    if (role !== 'user' || record['isSidechain'] === true) return;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (blocks.some((block) => asRecord(block)?.['type'] === 'tool_result')) return;
    let text = blocks.map((block) => { const item = asRecord(block); return item?.['type'] === 'text' && typeof item['text'] === 'string' ? item['text'] : ''; }).join('\n');
    const block = JEV_BLOCK.exec(text);
    const pick = block === null ? null : (JEV_NAME.exec(block[1] ?? '')?.[1] ?? null);
    if (block !== null) text = text.replace(JEV_BLOCK, '');
    text = text.trim();
    // Вставка в служебной записи после реплики относится к этой реплике.
    if (current !== null && pick !== null && (text === '' || record['isMeta'] === true)) current.jevPick = pick;
    if (text === '' || record['isMeta'] === true || isServiceText(text) || text.startsWith('/') || text.startsWith('<')) return;
    current = { text, jevPick: pick, source };
    found.push(current);
  });
  return found;
}

export interface LabelItem {
  id: string;
  /** Что выбрал jev на этом запросе; `null` — выбора не записано (запрос мог не получить вставки). */
  jevPick: string | null;
  source: string;
  prompt: string;
  truncated: boolean;
  /** Правильный ответ ставит человек: точное имя навыка или `none`. Пока `null`. */
  answer: string | null;
  notes: string;
}

export interface LabelSheet {
  schema: 1;
  createdAt: string;
  note: string;
  pools: { sessions: number; withJevPick: number; withoutJevPick: number };
  items: LabelItem[];
}

const hashOrder = (value: string): string => sha256(value);

/**
 * Лист на ~15 запросов: половина с выбором jev (по кругу между выбранными навыками), остальные без выбора.
 * Порядок детерминирован хешем, не более двух запросов на сессию, повторы текста отбрасываются.
 */
export async function buildLabelSheet(root: string, count: number, now = new Date()): Promise<LabelSheet> {
  const sessions = await discoverSessions(root);
  const seen = new Set<string>();
  const picked: PromptCandidate[] = [];
  const unpicked: PromptCandidate[] = [];
  for (const session of sessions) {
    let perSession = 0;
    for (const candidate of await extractPrompts(session.file)) {
      const clean = candidate.text.replace(SECRET, '<redacted>');
      if (clean.length < 12 || seen.has(clean)) continue;
      seen.add(clean);
      (candidate.jevPick === null ? unpicked : picked).push({ ...candidate, text: clean });
      perSession += 1;
      if (perSession >= 40) break;
    }
  }
  const ordered = (list: PromptCandidate[]): PromptCandidate[] => [...list].sort((a, b) => (hashOrder(a.text) < hashOrder(b.text) ? -1 : 1));
  const perSource = new Map<string, number>();
  const used = new Set<string>();
  const take = (list: PromptCandidate[], limit: number): PromptCandidate[] => {
    const taken: PromptCandidate[] = [];
    for (const item of list) {
      if (taken.length >= limit) break;
      if (used.has(item.text) || (perSource.get(item.source) ?? 0) >= 2) continue;
      used.add(item.text);
      perSource.set(item.source, (perSource.get(item.source) ?? 0) + 1);
      taken.push(item);
    }
    return taken;
  };
  // Выбранные навыки по кругу: один навык не занимает весь лист.
  const bySkill = new Map<string, PromptCandidate[]>();
  for (const item of ordered(picked)) bySkill.set(item.jevPick!, [...(bySkill.get(item.jevPick!) ?? []), item]);
  const wantPicked = Math.ceil(count / 2);
  const roundRobin: PromptCandidate[] = [];
  for (let round = 0; [...bySkill.values()].some((items) => items.length > round); round += 1) {
    for (const items of bySkill.values()) if (items[round] !== undefined) roundRobin.push(items[round]!);
  }
  const chosenPicked = take(roundRobin, wantPicked);
  const chosenUnpicked = take(ordered(unpicked), count - chosenPicked.length);
  // Одного из пулов не хватило (мало сессий или мало вставок jev): остаток добирается из другого.
  const chosen = [...chosenPicked, ...chosenUnpicked];
  chosen.push(...take([...roundRobin, ...ordered(unpicked)], count - chosen.length));
  return {
    schema: 1,
    createdAt: now.toISOString(),
    note: 'Только локально: в git не коммитить. Поле answer — точное имя навыка или "none"; ответ ставит человек, не jev и не агент.',
    pools: { sessions: sessions.length, withJevPick: picked.length, withoutJevPick: unpicked.length },
    items: chosen.map((item, i) => ({
      id: `p${String(i + 1).padStart(2, '0')}`,
      jevPick: item.jevPick,
      source: item.source,
      prompt: item.text.slice(0, PROMPT_MAX_CHARS),
      truncated: item.text.length > PROMPT_MAX_CHARS,
      answer: null,
      notes: '',
    })),
  };
}

/**
 * `true` — путь точно вне любого репозитория или git подтверждает, что он игнорируется; `false` — путь попал бы в git
 * или проверить не удалось (ошибка запуска git, незнакомый отказ): лист с настоящими запросами пишем только при уверенности.
 * Каталога цели может ещё не быть, поэтому git спрашивается из ближайшего существующего предка.
 */
export function safeForPrivateData(target: string): boolean {
  const abs = path.resolve(target);
  let dir = path.dirname(abs);
  while (!existsSync(dir)) dir = path.dirname(dir);
  const real = path.join(realpathSync(dir), path.relative(dir, abs));
  const options = { cwd: dir, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } } as const;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], options);
  if (top.error !== undefined) return false;
  if (top.status !== 0) return /not a git repository/i.test(top.stderr);
  return spawnSync('git', ['check-ignore', '-q', real], options).status === 0;
}

// ---------- Сухой прогон ----------

export interface DryRunResult {
  ok: boolean;
  lines: string[];
}

/**
 * Офлайн-проверка всех сценариев стенда без платных ходов: фикстуры, план и бюджет, листы, подготовка копий,
 * принятие (проект без решения не проходит, с эталонным решением проходит), сбор из синтетического транскрипта и
 * отчёт по фикстурным прогонам. Ничего, кроме `git`, `sh` и `node` фикстурного проекта, не запускается.
 */
export async function dryRun(fixtureDir = FIXTURE_DIR): Promise<DryRunResult> {
  const lines: string[] = [];
  let ok = true;
  const check = (name: string, passed: boolean, detail = ''): void => {
    lines.push(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
    if (!passed) ok = false;
  };
  const { file, budget, problems } = await loadFixtures(fixtureDir);
  check('фикстуры сценариев и бюджет', problems.length === 0, problems.join('; '));
  if (problems.length > 0) return { ok, lines };

  const runs = planRuns(file, budget);
  const estimate = estimateBudget(runs, budget);
  check('план: ид прогонов уникальны', new Set(runs.map((r) => r.id)).size === runs.length);
  lines.push(`     прогонов ${estimate.runs}, сессий ${estimate.sessions}, пилот ${estimate.pilotRuns} прогона(ов)`);

  const tmp = await mkdtemp(path.join(tmpdir(), 'parley-bench-'));
  try {
    check('лист запуска собирается', renderRunSheet(runs, file, budget, tmp).includes(runs[0]!.id));
    for (const task of file.tasks) {
      if (task.accept.kind !== 'command') continue;
      const planned = runs.find((r) => file.scenarios.find((s) => s.id === r.scenario)?.task === task.id)!;
      const begin = await beginRun({ ...planned, id: `dry.${task.id}` }, budget, tmp, { versions: () => ({ claude: 'dry-run', codex: 'dry-run' }), fixtureDir });
      const before = runAcceptance(task.accept.command, begin.projectDir);
      await cp(path.join(fixtureDir, task.solution!), begin.projectDir, { recursive: true });
      const after = runAcceptance(task.accept.command, begin.projectDir);
      check(`принятие ${task.id}: без решения не проходит, с решением проходит`, !before.passed && after.passed, after.passed ? '' : after.output);
    }
    const synthetic = await readFile(path.join(fixtureDir, 'runs.synthetic.json'), 'utf8');
    const parsed = (JSON.parse(synthetic) as unknown[]).map(parseRun);
    const bad = parsed.flatMap((item) => ('problems' in item ? item.problems : []));
    check('фикстурные записи прогонов разбираются', bad.length === 0, bad.slice(0, 3).join('; '));
    const records = parsed.flatMap((item) => ('run' in item ? [item.run] : []));
    const text = renderReport(buildReport(records, file, { warmWithinSec: budget.cache.warmWithinSec }));
    check('отчёт по фикстурным прогонам строится и не заявляет экономию', text.includes('экономия не заявляется'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { ok, lines };
}

// ---------- Командная строка ----------

const HELP = `parley-token-benchmark — офлайн-стенд замера экономии (P38)

  validate                      проверить фикстуры сценариев и бюджет
  plan [--out DIR]              план, бюджет и лист запуска в DIR (по умолчанию .parley/benchmark)
  begin ID [--out DIR]          копия фикстурного проекта и условия прогона
  accept ID [--out DIR]         проверка принятия офлайн-командой задачи
  collect ID --claude F... [--codex F...] [--accepted yes|no] [--constraints yes|no]
          [--corrections N] [--warm-interval-sec N] [--set имя=N...] [--out DIR] [--synthetic]
  report [--runs DIR] [--out FILE]  отчёт по записям прогонов
  labels [--count 15] [--root DIR] [--out FILE]  лист разметки P32 из ваших транскриптов (только локально)
  dry-run                       полная офлайн-проверка без платных ходов
`;

const yesNo = (value: string | undefined): boolean | null => (value === 'yes' ? true : value === 'no' ? false : null);

async function readRuns(dir: string): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const parsed = parseRun(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
    if ('problems' in parsed) throw new Error(`${name}: ${parsed.problems.join('; ')}`);
    runs.push(parsed.run);
  }
  return runs;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' }, runs: { type: 'string' }, count: { type: 'string' }, root: { type: 'string' },
      claude: { type: 'string', multiple: true }, codex: { type: 'string', multiple: true }, set: { type: 'string', multiple: true },
      accepted: { type: 'string' }, constraints: { type: 'string' }, corrections: { type: 'string' },
      'warm-interval-sec': { type: 'string' }, synthetic: { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const [command, id] = positionals;
  const out = path.resolve(values.out ?? DEFAULT_OUT);
  if (command === undefined || values.help === true) {
    console.log(HELP);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  if (command === 'dry-run') {
    const result = await dryRun();
    console.log(result.lines.join('\n'));
    return result.ok ? 0 : 1;
  }
  if (command === 'labels') {
    const target = path.resolve(values.out ?? path.join(DEFAULT_OUT, 'labels.json'));
    if (!safeForPrivateData(target)) {
      console.error(`${target}: git не игнорирует этот путь, а в листе настоящие запросы человека; выберите путь под .parley/`);
      return 1;
    }
    const sheet = await buildLabelSheet(path.resolve(values.root ?? defaultRoot()), Number(values.count ?? 15));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(sheet, null, 2)}\n`);
    console.log(`${target}: ${sheet.items.length} запросов (с выбором jev ${sheet.items.filter((i) => i.jevPick !== null).length}); пулы: ${JSON.stringify(sheet.pools)}`);
    return 0;
  }
  if (command === 'report') {
    const { file, budget, problems } = await loadFixtures();
    if (problems.length > 0) throw new Error(problems.join('; '));
    const text = renderReport(buildReport(await readRuns(path.resolve(values.runs ?? path.join(out, 'runs'))), file, { warmWithinSec: budget.cache.warmWithinSec }));
    if (values.out === undefined) console.log(text);
    else await writeFile(out, text);
    return 0;
  }

  const { file, budget, problems } = await loadFixtures();
  if (command === 'validate') {
    console.log(problems.length === 0 ? 'ok' : problems.join('\n'));
    return problems.length === 0 ? 0 : 1;
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  const runs = planRuns(file, budget);
  if (command === 'plan') {
    const estimate = estimateBudget(runs, budget);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'plan.json'), `${JSON.stringify({ runs, estimate }, null, 2)}\n`);
    await writeFile(path.join(out, 'run-sheet.md'), renderRunSheet(runs, file, budget, out));
    console.log(JSON.stringify(estimate, null, 2));
    return 0;
  }
  const planned = runs.find((run) => run.id === id);
  if (planned === undefined) throw new Error(`нет прогона ${String(id)} в плане`);
  if (command === 'begin') {
    const begin = await beginRun(planned, budget, out);
    console.log(`${begin.projectDir}\n${hostEnv(planned, file.scenarios.find((s) => s.id === planned.scenario)!).join(' ')}`);
    return 0;
  }
  const workDir = path.join(out, 'work', planned.id);
  const begin = JSON.parse(await readFile(path.join(workDir, 'begin.json'), 'utf8')) as BeginRecord;
  const task = file.tasks.find((t) => t.id === file.scenarios.find((s) => s.id === planned.scenario)?.task)!;
  if (command === 'accept') {
    if (task.accept.kind !== 'command') {
      console.log(`принимает человек: ${task.accept.criteria}`);
      return 0;
    }
    const result = runAcceptance(task.accept.command, begin.projectDir);
    await writeFile(path.join(workDir, 'acceptance.json'), `${JSON.stringify({ passed: result.passed, command: task.accept.command })}\n`);
    console.log(`${result.passed ? 'принято' : 'не принято'}: ${result.output}`);
    return 0;
  }
  if (command === 'collect') {
    let accepted = yesNo(values.accepted);
    if (accepted === null && task.accept.kind === 'command') {
      accepted = await readFile(path.join(workDir, 'acceptance.json'), 'utf8').then((text) => (JSON.parse(text) as { passed: boolean }).passed, () => null);
    }
    const skills = (await readdir(path.join(FIXTURE_DIR, 'project/skills'))).concat('minimal-development');
    const run = await collectRun({
      begin, claude: values.claude ?? [], codex: values.codex ?? [], accepted,
      constraintsKept: yesNo(values.constraints), humanCorrections: values.corrections === undefined ? null : asCount(Number(values.corrections)),
      warmIntervalSec: values['warm-interval-sec'] === undefined ? null : Number(values['warm-interval-sec']),
      set: values.set ?? [], knownSkills: skills, origin: values.synthetic === true ? 'synthetic-fixture' : 'live',
    });
    await mkdir(path.join(out, 'runs'), { recursive: true });
    await writeFile(path.join(out, 'runs', `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
    console.log(`${run.id}: принято=${String(run.accepted)}, usage ${sumUsage(run.usage).completeness}`);
    return 0;
  }
  console.error(HELP);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
