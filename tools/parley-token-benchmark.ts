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
 * - кеш у Claude Code живёт час и общий префикс у рук один, поэтому «холодность» мерится по первому запросу прогона,
 *   а не по доле чтения за весь прогон; мод jev и навык minimal-development — отдельные оси;
 * - процентов экономии нет нигде: офлайн-данные живую проверку не закрывают.
 *
 * Запуск: `pnpm exec tsx tools/parley-token-benchmark.ts <команда>`, список команд — `--help`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { indexCodexSession } from '../packages/core/src/codex/index-session.js';
import { defaultRoot, discoverSession, discoverSessions } from '../packages/core/src/discover.js';
import { forEachJsonlRecord, type RawRecord } from '../packages/core/src/jsonl.js';
import { indexSessionFile, isServiceText } from '../packages/core/src/session-index.js';
import { findJevPluginIds } from '../packages/core/src/work/skill-reduction.js';
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
/** `warm` планом больше не выдаётся (кеш живёт час, общий префикс у рук один); тип нужен, чтобы читать старые записи. */
export type CacheTemp = 'cold' | 'warm';
export type Toggle = 'off' | 'on';
export type Axis = 'arm' | 'jev' | 'skill';
/** Провайдер прогона: у `glm` тот же бинарь `claude` с ключом Z.ai, у `codex` свой CLI и свой журнал. */
export const PROVIDERS = ['claude', 'codex', 'glm'] as const;
export type Provider = (typeof PROVIDERS)[number];

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
  conditions: Record<Provider, { model: string; effort: string }>;
  repetitions: number;
  cache: { ttlSec: number; warmWithinSec: number };
  perSession: { maxTotalInputTokens: number; maxOutputTokens: number; maxMinutes: number };
  pilot: { scenarios: string[] };
  maxRuns: number;
  /**
   * `repetitions` волны перекрывает общее `repetitions` бюджета (сокращённая волна с несколькими повторами).
   * `provider` волны (по умолчанию `claude`): сценарии с одним участником идут с ним вместо указанного в сценарии.
   */
  waves: { id: string; title: string; scenarios: string[]; repetitions?: number; provider?: Provider }[];
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
  for (const provider of PROVIDERS) {
    if (!isObject(conditions) || !isObject(conditions[provider]) || !isString(conditions[provider].model) || !isString(conditions[provider].effort)) {
      problems.push(`budget.conditions.${provider}: model и effort`);
    }
  }
  const ids = new Set(file.scenarios.map((s) => s.id));
  const byId = new Map(file.scenarios.map((s) => [s.id, s]));
  // Пара (сценарий, провайдер) лежит не больше чем в одной волне; у claude — ровно в одной (покрытие аудита).
  const placed = new Map<string, number>();
  for (const wave of Array.isArray(budget.waves) ? budget.waves : []) {
    if (wave.repetitions !== undefined && (!positive(wave.repetitions) || !Number.isInteger(wave.repetitions))) {
      problems.push(`budget.waves ${wave.id}: repetitions — целое больше 0`);
    }
    if (wave.provider !== undefined && !(PROVIDERS as readonly unknown[]).includes(wave.provider)) {
      problems.push(`budget.waves ${wave.id}: provider — claude, codex или glm`);
    }
    const provider = wave.provider ?? 'claude';
    for (const id of Array.isArray(wave.scenarios) ? wave.scenarios : []) {
      if (!ids.has(id)) problems.push(`budget.waves ${wave.id}: нет сценария ${id}`);
      if (provider !== 'claude' && (byId.get(id)?.room.length ?? 1) !== 1) {
        problems.push(`budget.waves ${wave.id}: сценарий ${id} с комнатой не переопределяется провайдером ${provider}`);
      }
      placed.set(`${id}|${provider}`, (placed.get(`${id}|${provider}`) ?? 0) + 1);
    }
  }
  for (const id of ids) if (placed.get(`${id}|claude`) !== 1) problems.push(`сценарий ${id} должен быть ровно в одной волне`);
  for (const [key, count] of placed) {
    const [id, provider] = key.split('|');
    if (provider !== 'claude' && count > 1) problems.push(`сценарий ${id} с провайдером ${provider} лежит в нескольких волнах`);
  }
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
  /** Провайдер одиночного участника (волна с `provider`); у остальных — `claude`. */
  provider: Provider;
  sessions: number;
  pilot: boolean;
}

/** id прогона; у не-claude провайдера перед повтором стоит его имя (`.codex.r1`), прежние id claude не меняются. */
export const runIdOf = (p: Pick<PlannedRun, 'scenario' | 'arm' | 'cache' | 'jev' | 'skill' | 'repetition'> & { provider?: Provider }): string =>
  `${p.scenario}.${p.arm}.${p.cache}.jev-${p.jev}.skill-${p.skill}${p.provider === undefined || p.provider === 'claude' ? '' : `.${p.provider}`}.r${p.repetition}`;

/**
 * Матрица прогонов. Основная ось: сценарий × рука × повтор (jev выключен, навык выключен), по одной ячейке:
 * кеш у Claude Code живёт час, общий префикс у рук один, поэтому тёплый прогон от холодного не отличить, и намеренного
 * прогрева нет (`cache` остаётся `cold` ради совместимости записей; фактическое попадание видно по первому запросу).
 * Повторы волны — `repetitions` волны, иначе общие из бюджета. Отдельные оси: jev включён (рука native) и
 * minimal-development включён (обе руки), повторы общие. Порядок рук чередуется, чтобы время суток не доставалось
 * одной руке. `waveId` оставляет прогоны одной волны; номера порядка считаются заново, чередование — по всему плану.
 */
export function planRuns(file: ScenarioFile, budget: Budget, waveId?: string): PlannedRun[] {
  const byId = new Map(file.scenarios.map((s) => [s.id, s]));
  const base = (scenario: Scenario, wave: string, repetition: number, arm: Arm, jev: Toggle, skill: Toggle, provider: Provider = 'claude'): Omit<PlannedRun, 'order'> => {
    const draft = { scenario: scenario.id, arm, cache: 'cold' as const, jev, skill, repetition, provider };
    return {
      id: runIdOf(draft), wave, ...draft, sessions: scenario.room.length,
      pilot: wave !== AXES_WAVE && provider === 'claude' && budget.pilot.scenarios.includes(scenario.id) && repetition === 1,
    };
  };
  const planned: Omit<PlannedRun, 'order'>[] = [];
  let flip = 0;
  for (const wave of budget.waves) {
    for (const id of wave.scenarios) {
      const scenario = byId.get(id);
      if (scenario === undefined) continue;
      for (let repetition = 1; repetition <= (wave.repetitions ?? budget.repetitions); repetition += 1, flip += 1) {
        const arms = flip % 2 === 0 ? ARMS : [...ARMS].reverse();
        for (const arm of arms) planned.push(base(scenario, wave.id, repetition, arm, 'off', 'off', wave.provider));
      }
    }
  }
  for (const scenario of file.scenarios) {
    if (!scenario.axes.jev) continue;
    for (let repetition = 1; repetition <= budget.repetitions; repetition += 1) {
      planned.push(base(scenario, AXES_WAVE, repetition, 'native', 'on', 'off'));
    }
  }
  for (const scenario of file.scenarios) {
    if (!scenario.axes.skill) continue;
    for (let repetition = 1; repetition <= budget.repetitions; repetition += 1) {
      for (const arm of ARMS) planned.push(base(scenario, AXES_WAVE, repetition, arm, 'off', 'on'));
    }
  }
  return planned.filter((item) => waveId === undefined || item.wave === waveId).map((item, index) => ({ ...item, order: index + 1 }));
}

/** Есть ли такая волна в плане: волны бюджета и волна отдельных осей. */
export const hasWave = (budget: Budget, waveId: string): boolean => waveId === AXES_WAVE || budget.waves.some((wave) => wave.id === waveId);

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
  // Навыки Parley (parley и minimal-development) стенд доставляет сам: у обеих рук одно и то же. Переменная
  // функциональных хуков нужна при jev on, но выключить мод она не может: Claude Code накладывает `env` из файлов
  // настроек поверх окружения запуска, а в пользовательских настройках человека она стоит в 1. Настройки Claude Code
  // стенд не пишет (рамка Parley), поэтому при jev off мод удаляет человек до волны, а `begin` отказывает, пока мод
  // установлен (`beginRun`), одинаково в обеих руках.
  // DISABLE_AUTOUPDATER: Claude Code обновился сам посреди пилота (2.1.289 -> 2.1.291), и пары разошлись бы по версии.
  return [
    `PARLEY_SKILL_NAVIGATOR=${navigator}`,
    'PARLEY_AGENT_SKILLS=false',
    `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=${run.jev === 'on' ? 1 : 0}`,
    'DISABLE_AUTOUPDATER=1',
  ];
}

/** Строка листа о провайдере волны: модель и усилие из условий бюджета, откуда брать журнал, как идёт ключ GLM. */
function providerLine(provider: Provider, budget: Budget): string {
  const { model, effort } = budget.conditions[provider];
  const where =
    provider === 'codex'
      ? 'журнал — rollout в `~/.codex/sessions` (`--codex`)'
      : 'журнал — транскрипт `claude` (`--claude`), сессия идёт тем же бинарём, что и у Claude, с ключом Z.ai';
  const key = provider === 'glm' ? ' Ключ Z.ai драйвер подключает ссылкой на время прогона: `--link-secrets <путь к файлу ключа в ~/.parley>`, только с разрешения человека.' : '';
  return `- Провайдер ${provider}: модель ${model}, усилие ${effort}; ${where}.${key}`;
}

/**
 * Лист запуска для человека, ведущего живой прогон: всё, что нужно сделать в Parley на каждый ход. `home` — дом
 * хоста Parley (`PARLEY_HOME`), по умолчанию `<out>/home`; влезает ли в него сокет хоста, проверяет `plan`.
 */
export function renderRunSheet(runs: PlannedRun[], file: ScenarioFile, budget: Budget, out: string, home = path.join(out, 'home')): string {
  const scenarios = new Map(file.scenarios.map((s) => [s.id, s]));
  const tasks = new Map(file.tasks.map((t) => [t.id, t]));
  const lines = [
    '# Лист запуска живого прогона (P38 -> P32)',
    '',
    'Платные ходы начинаются только после явного разрешения человека. Перед каждой волной — проверка недельного лимита.',
    '',
    ...budget.stopRules.map((rule) => `- ${rule}`),
    '',
    'Версия `claude` на всю волну одна: `DISABLE_AUTOUPDATER=1` в строке хоста, `begin` записывает версию, `collect` сверяет её с `version` записей транскрипта (расхождение — флаг `cli-version-mismatch`, пара исключается).',
    'У Codex версия CLI — `cli_version` из `session_meta` его журнала: `collect` сверяет её с версией `codex`, записанной `begin` (то же `cli-version-mismatch`). Прогоны glm идут тем же `claude`, версия — как у Claude.',
    '`begin` не пишет настройки Claude Code: имена серверов из всех `.mcp.json` выше копии он только записывает в `begin.json` (`mcpServersAbove`). При первом запуске в копии Claude Code спросит «N new MCP servers found in this project»: диалог закрывает оператор или драйвер (Esc, отклонить все), у обеих рук одинаково.',
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
      `- Волна ${run.wave}, рука ${run.arm}, jev ${run.jev}, minimal-development ${run.skill}, сессий ${run.sessions}.`,
      '- Кеш: без намеренного прогрева (значение `cache` в записи — `cold` для совместимости); попал ли первый запрос в кеш, видно по `firstRequest` записи, а не по плану.',
      `- Начало: \`pnpm exec tsx tools/parley-token-benchmark.ts begin ${run.id} --out ${out}\``,
      `- Хост Parley: \`PARLEY_HOME=${home} ${hostEnv(run, scenario).join(' ')}\`; проект работы — \`${path.join(out, 'work', run.id, 'project')}\`.`,
      ...(run.provider === 'claude' ? [] : [providerLine(run.provider, budget)]),
      ...(setup === undefined ? [] : [`- Особенность руки: ${setup}`]),
      run.provider !== 'claude'
        ? '- jev: у этого провайдера не применим, ось не планируется. `begin` мод jev не ищет и не отказывает. Если провайдер — glm, сессия идёт тем же `claude` и вставку jev мог бы дать установленный мод: `collect` ищет её в транскрипте, отчёт исключает пару со вставкой (`jev-leak`); у codex `jevFired` — `null`.'
        : run.jev === 'off'
        ? '- jev off: мод jev удаляет человек до волны: одной переменной хоста мод не выключить (настройки CLI человека её перекрывают), а стенд настройки Claude Code не пишет. `begin` ищет установку мода (id — `jevInstalled` в `begin.json`) и отказывает, пока мод установлен; отключения в настройках человека мало. В транскрипте не должно быть вставки jev (`attachment` типа `hook_additional_context` с «Relevant to the current request:») — `collect` ищет её, а отчёт исключает пару со вставкой у стороны jev off (`jev-leak`).'
        : '- jev on: мод включён настройками CLI человека, стенд их не трогает; переменная хоста в строке выше включает функциональные хуки. В транскрипте должна быть вставка jev (`attachment` типа `hook_additional_context` с «Relevant to the current request:») — проверить в пилоте.',
      // У волны с провайдером единственный участник идёт с ним, а не с провайдером из сценария.
      `- Участники: ${scenario.room.map((member) => `${scenario.room.length === 1 ? run.provider : member.provider}/${member.role}`).join(', ')}.`,
      `- Запрос: ${JSON.stringify(scenario.prompt)}`,
      ...(scenario.followUps ?? []).map((item) => `- Позже (${item.when}): ${JSON.stringify(item.text)}`),
      ...scenario.operatorSteps.map((step) => `- Шаг: ${step}`),
      task.accept.kind === 'command'
        ? `- Принятие: \`pnpm exec tsx tools/parley-token-benchmark.ts accept ${run.id} --out ${out}\` (команда \`${task.accept.command}\`).`
        : `- Принятие человеком: ${task.accept.criteria}`,
      `- Сбор: \`pnpm exec tsx tools/parley-token-benchmark.ts collect ${run.id} ${run.provider === 'codex' ? '--codex <rollout.jsonl>' : run.provider === 'glm' ? '--claude <лог.jsonl>' : '--claude <лог.jsonl> [--codex <rollout.jsonl>]'} --out ${out}\``,
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
  /** Вставка мода jev в транскриптах Claude: `true` — есть, `false` — нет; `null` — транскриптов Claude нет. */
  jevFired: boolean | null;
}

/** Первый запрос главного разговора: чтение кеша и полный вход; `null` у поля — в логе не видно. */
export interface FirstRequest {
  cacheRead: number | null;
  totalInput: number | null;
}

/** MCP-серверы человека подключаются асинхронно: сколько ещё в ожидании и сколько упало к первому запросу. */
export interface McpStartup {
  pendingMcpServers: number | null;
  failedMcpServers: number | null;
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
  /** `null` — в записи (старой или без usage у ассистента) первого запроса не видно. */
  firstRequest: FirstRequest | null;
  startup: McpStartup;
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
    firstRequest: isObject(raw['firstRequest'])
      ? { cacheRead: asCount(raw['firstRequest']['cacheRead']), totalInput: asCount(raw['firstRequest']['totalInput']) }
      : null,
    startup: {
      pendingMcpServers: isObject(raw['startup']) ? asCount(raw['startup']['pendingMcpServers']) : null,
      failedMcpServers: isObject(raw['startup']) ? asCount(raw['startup']['failedMcpServers']) : null,
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

/** Числа известны у обеих сторон и различаются; неизвестное с известным не сравнивается. */
const differs = (a: number | null, b: number | null): boolean => a !== null && b !== null && a !== b;

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
    if (base.flags.includes('cli-version-mismatch') || test.flags.includes('cli-version-mismatch')) {
      section.excluded.push({ pair: name, reason: 'cli-version-mismatch' });
      continue;
    }
    if (!axisProven(axis, baseValue, base) || !axisProven(axis, testValue, test)) {
      section.excluded.push({ pair: name, reason: 'axis-unverified' });
      continue;
    }
    // Вставка jev у стороны с jev off — утечка условия: пара сравнивала бы не то, что заявлено.
    if ([base, test].some((run) => run.conditions.jev === 'off' && run.axisEvidence.jevFired === true)) {
      section.excluded.push({ pair: name, reason: 'jev-leak' });
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
    // Кеш мерится по первому запросу: дальше каждый запрос перечитывает предыдущий, и доля за прогон ничего не говорит.
    const [baseRead, testRead] = [base.firstRequest?.cacheRead ?? null, test.firstRequest?.cacheRead ?? null];
    if ([baseRead, testRead].some((value) => value !== null && value > 0)) notes.push('first-request-cached');
    if (differs(baseRead, testRead)) notes.push('cache-unbalanced');
    if (differs(base.startup.pendingMcpServers, test.startup.pendingMcpServers) || differs(base.startup.failedMcpServers, test.startup.failedMcpServers)) {
      notes.push('mcp-startup-unbalanced');
    }
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
  // Разные провайдеры в пары не смешиваются и в одном разделе не считаются: при нескольких провайдерах в записях
  // у каждого свои разделы (в заголовке — его имя); у записей одного провайдера отчёт прежний.
  const known: readonly string[] = PROVIDERS;
  const providers = [...new Set(runs.map((run) => run.conditions.provider))].sort((a, b) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const add = (axis: Axis, cache: CacheTemp, fixed: Parameters<typeof pairSection>[3]): void => {
    for (const provider of providers.length > 1 ? providers : [null]) {
      const section = pairSection(provider === null ? runs : runs.filter((run) => run.conditions.provider === provider), axis, cache, fixed, options);
      if (provider !== null) section.label += ` [${provider}]`;
      if (section.candidates > 0 || section.excluded.length > 0) sections.push(section);
    }
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
  // Тёплые ячейки не планируются: у основной оси одна ячейка на руку.
  // Ячейки claude обязательны у каждого сценария; у другого провайдера — только у сценариев, где он уже есть.
  const cells = (scenario: string): string[] => [
    ...ARMS.filter((arm) => !runs.some((r) => r.scenario === scenario && r.conditions.provider === 'claude' && r.conditions.arm === arm && r.conditions.cache === 'cold' && r.conditions.jev === 'off' && r.conditions.skill === 'off')),
    ...providers.filter((provider) => provider !== 'claude' && runs.some((r) => r.scenario === scenario && r.conditions.provider === provider)).flatMap((provider) =>
      ARMS.filter((arm) => !runs.some((r) => r.scenario === scenario && r.conditions.provider === provider && r.conditions.arm === arm && r.conditions.cache === 'cold' && r.conditions.jev === 'off' && r.conditions.skill === 'off')).map((arm) => `${arm}/${provider}`)),
  ];
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
    '| Сценарий | Покрытие | Записей | Нет ячейки основной оси (рука) |',
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
    const noted = section.clean.filter((pair) => pair.notes.length > 0);
    if (noted.length > 0) {
      lines.push(
        `Оговорки (first-request-cached — на первом запросе было чтение кеша; cache-unbalanced — оно у сторон разное; mcp-startup-unbalanced — разный старт MCP-серверов): ${noted.map((pair) => `${pair.test} (${pair.notes.join(', ')})`).join('; ')}.`,
        '',
      );
    }
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

/**
 * Файлы фикстурного каталога для копии и хеша. В git-репозитории — только отслеживаемые (`git ls-files`): в пилот
 * попал неотслеживаемый `.omc/state` от хуков сессии оператора. Вне репозитория (временные фикстуры тестов) — все.
 */
async function projectFiles(dir: string): Promise<string[]> {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) return treeFiles(dir);
  const found: string[] = [];
  for (const relative of listed.stdout.split('\0').filter((item) => item !== '')) {
    if (await stat(path.join(dir, relative)).then((info) => info.isFile(), () => false)) found.push(relative);
  }
  return found.sort();
}

/** Хеш дерева каталога: пути и содержимое, в порядке имён; правило отбора файлов — `projectFiles`. */
export async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relative of await projectFiles(dir)) hash.update(`${relative}\0`).update(await readFile(path.join(dir, relative))).update('\0');
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
  /**
   * Id мода jev, найденные при `jev off`. Установленный мод — отказ `begin`, поэтому в записи список пуст: он говорит,
   * что проверка прошла и мода нет. При `jev on` и у провайдера не claude (codex, glm: ось jev не применима) мод не ищется, и список пуст так же.
   */
  jevInstalled: string[];
  /** Имена MCP-серверов из всех `.mcp.json` от копии вверх: о них Claude Code спросит диалогом, его закрывает оператор или драйвер. */
  mcpServersAbove: string[];
  /** Нечитаемые или битые `.mcp.json`, пропущенные при поиске. */
  warnings: string[];
  startedAt: string;
}

/**
 * Id установленного мода jev для руки с `jev off`. Переменной хоста мод не выключить (см. `hostEnv`), а настройки
 * Claude Code стенд не пишет (рамка Parley): выключить мод может только человек, удалив его до волны. Id ищется как
 * у Parley (`work/launch.ts`): тем же `findJevPluginIds` и в той же папке конфигурации Claude. Он находит установку
 * мода, а не его включённость. Пустой список — мода нет. `null` — место установки не прочиталось, и мод мог остаться
 * включённым незаметно: прогон с `jev off`, который нельзя проверить, не начинаем.
 */
async function findJevInstalled(projectDir: string, findIds: typeof findJevPluginIds): Promise<string[]> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(projectDir, process.env.CLAUDE_CONFIG_DIR) : path.join(process.env.HOME ?? homedir(), '.claude');
  const ids = await findIds(projectDir, configDir);
  if (ids === null) throw new Error(`jev off: место установки мода в ${configDir} не прочиталось, выключение jev не проверить`);
  return ids;
}

export type McpServerNames = (projectDir: string) => Promise<{ names: string[]; warnings: string[] }>;

/**
 * Имена серверов из всех `.mcp.json`, найденных от копии вверх до корня файловой системы: Claude Code ищет файл выше по
 * дереву (в пилоте — `~/.mcp.json`) и при первом запуске в копии спрашивает «N new MCP servers found in this project».
 * Файлы только читаются; нечитаемый или битый — предупреждение, не отказ.
 */
export const findMcpServerNames: McpServerNames = async (projectDir) => {
  const names = new Set<string>();
  const warnings: string[] = [];
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    const file = path.join(dir, '.mcp.json');
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`${file}: не прочитан (${error.code ?? error.message})`);
      return null;
    });
    if (text !== null) {
      try {
        const servers = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
        if (isObject(servers)) for (const name of Object.keys(servers)) names.add(name);
        else warnings.push(`${file}: нет объекта mcpServers`);
      } catch {
        warnings.push(`${file}: не JSON`);
      }
    }
    if (path.dirname(dir) === dir) break;
  }
  return { names: [...names].sort(), warnings };
};

/**
 * Копия фикстурного проекта для прогона: навыки лежат в родных каталогах `.agents/skills` и `.claude/skills`
 * копии (домашние каталоги CLI не трогаются), minimal-development — только на оси навыка. Копируются только
 * отслеживаемые git файлы фикстуры (`projectFiles`). Копия — git-репозиторий. Настроек Claude Code стенд не пишет
 * (рамка Parley): при `jev off` и установленном моде `begin` отказывает до первой записи, имена серверов чужих
 * `.mcp.json` только попадают в запись. `deps.jevPluginIds` и `deps.mcpServerNames` подменяют поиск мода и
 * `.mcp.json`, чтобы тесты и сухой прогон не читали настоящие `~/.claude` и домашнюю папку.
 */
export async function beginRun(
  planned: PlannedRun,
  budget: Budget,
  out: string,
  deps: { versions?: () => { claude: string; codex: string }; fixtureDir?: string; jevPluginIds?: typeof findJevPluginIds; mcpServerNames?: McpServerNames } = {},
): Promise<BeginRecord> {
  const fixtureDir = deps.fixtureDir ?? FIXTURE_DIR;
  const workDir = path.join(out, 'work', planned.id);
  const projectDir = path.join(workDir, 'project');
  // Установленный мод при `jev off` — отказ до стирания прежней копии, копирования и любых записей: иначе платные
  // сессии прошли бы со вставками jev, и отчёт исключил бы пару как `jev-leak`.
  // Только у claude: для codex и glm jev не применим, и begin из-за мода не отказывает (у glm вставку ловит отчёт: jev-leak).
  const jevInstalled = planned.jev === 'off' && planned.provider === 'claude' ? await findJevInstalled(projectDir, deps.jevPluginIds ?? findJevPluginIds) : [];
  if (jevInstalled.length > 0) {
    throw new Error(
      `jev off: мод jev установлен (${jevInstalled.join(', ')}), а прогон с выключенным jev без правки настроек человека не провести: переменной хоста мод не выключить, настройки Claude Code стенд не пишет. Удалите мод до волны (отключения в настройках мало: проверка ищет установку) и повторите begin, иначе вставки jev исключили бы пару как jev-leak.`,
    );
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const source = path.join(fixtureDir, 'project');
  for (const relative of await projectFiles(source)) {
    await mkdir(path.dirname(path.join(projectDir, relative)), { recursive: true });
    await copyFile(path.join(source, relative), path.join(projectDir, relative));
  }
  for (const name of await readdir(path.join(projectDir, 'skills'))) {
    for (const home of ['.agents/skills', '.claude/skills']) await cp(path.join(projectDir, 'skills', name), path.join(projectDir, home, name), { recursive: true });
  }
  await rm(path.join(projectDir, 'skills'), { recursive: true });
  if (planned.skill === 'on') {
    for (const home of ['.agents/skills', '.claude/skills']) {
      await cp(MINIMAL_DEVELOPMENT_DIR, path.join(projectDir, home, 'minimal-development'), { recursive: true });
    }
  }
  const mcp = await (deps.mcpServerNames ?? findMcpServerNames)(projectDir);
  git(projectDir, 'init', '-q');
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'fixture');

  const versions = (deps.versions ?? (() => ({ claude: cliVersion('claude'), codex: cliVersion('codex') })))();
  const providerConditions = budget.conditions[planned.provider];
  const record: BeginRecord = {
    id: planned.id,
    scenario: planned.scenario,
    repetition: planned.repetition,
    conditions: {
      arm: planned.arm, cache: planned.cache, jev: planned.jev, skill: planned.skill,
      provider: planned.provider, model: providerConditions.model, effort: providerConditions.effort,
      cli: `claude ${versions.claude}; codex ${versions.codex}`,
      hashes: await fixtureHashes(fixtureDir),
      warmIntervalSec: null,
    },
    projectDir,
    jevInstalled,
    mcpServersAbove: mcp.names,
    warnings: mcp.warnings,
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
  /** Версии `version` из записей главного разговора (без подагентов). */
  versions: string[];
  firstRequest: FirstRequest | null;
  startup: McpStartup | null;
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

/** Сколько серверов в поле вложения: список (имена или объекты) или число; иначе неизвестно. */
const serverCount = (value: unknown): number | null => (Array.isArray(value) ? value.length : asCount(value));

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
  // Только главный разговор: размер списка, первый запрос, старт MCP и версия CLI подагентов не описывают.
  const versions = new Set<string>();
  let listingBytes: number | null = null;
  let firstRequest: FirstRequest | null = null;
  let startup: McpStartup | null = null;

  const files = [file, ...discovered.subagents.map((agent) => agent.file)];
  for (const source of files) {
    const isMain = source === file;
    // Поправка поиска считается внутри одного разговора: подагент свой поиск начинает заново.
    lookupsSinceLoad = 0;
    await forEachJsonlRecord(source, (record: RawRecord) => {
      if (record['subtype'] === 'compact_boundary' || record['isCompactSummary'] === true) compactions += 1;
      const main = isMain && record['isSidechain'] !== true;
      if (main && isString(record['version'])) versions.add(record['version']);
      const attachment = asRecord(record['attachment']);
      if (main && startup === null && attachment?.['type'] === 'deferred_tools_delta') {
        startup = { pendingMcpServers: serverCount(attachment['pendingMcpServers']), failedMcpServers: serverCount(attachment['failedMcpServers']) };
      }
      if (attachment?.['type'] === 'skill_listing') {
        if (main && listingBytes === null && typeof attachment['content'] === 'string') listingBytes = Buffer.byteLength(attachment['content']);
        sawListing = true;
        for (const name of Array.isArray(attachment['names']) ? attachment['names'] : []) if (typeof name === 'string') listed.add(name);
      }
      if (jevPickOfAttachment(record) !== null) jevFired = true;
      const message = asRecord(record['message']);
      const usage = asRecord(message?.['usage']);
      if (main && firstRequest === null && message?.['role'] === 'assistant' && usage !== null) {
        const [input, cacheRead, cacheWrite] = [asCount(usage['input_tokens']), asCount(usage['cache_read_input_tokens']), asCount(usage['cache_creation_input_tokens'])];
        firstRequest = { cacheRead, totalInput: input === null || cacheRead === null || cacheWrite === null ? null : input + cacheRead + cacheWrite };
      }
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
            if (isEmptyFindSkillResult(text)) noMatch += 1;
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
    bytes: { bootstrapBytes: null, listingBytes, findSkillResultBytes: findBytes, toolResultBytes: resultBytes },
    traffic: { messages, broadcasts, deliveries: null },
    compactions,
    loaded,
    offered: [...offered],
    listedNames: sawListing ? [...listed] : null,
    jevFired,
    versions: [...versions],
    firstRequest,
    startup,
  };
}

/** Счётчики и признаки одного rollout-журнала Codex; что в журнале не видно, остаётся `null`. */
export interface CodexTranscript {
  skillUse: Counts;
  bytes: Counts;
  traffic: Counts;
  loaded: string[];
  offered: string[];
  firstRequest: FirstRequest | null;
}

/** Чтение файла навыка копии: `.agents/skills/<имя>/SKILL.md` или `.claude/skills/<имя>/SKILL.md`; имя навыка — из пути. */
const SKILL_FILE = /\.(?:agents|claude)\/skills\/([^/\s"'`\\]+)\/SKILL\.md/g;

/** Вызов `find_skill` в коде `exec` Codex (code mode): `tools.mcp__<сервер>__find_skill(`, сервер — любое имя. */
const FIND_SKILL_CALL = /\btools\.mcp__\w+__find_skill\s*\(/g;

/** Любое обращение к `tools` в коде: одно такое вхождение — вывод `exec` целиком принадлежит одному вызову. */
const TOOLS_ACCESS = /\btools\s*[.[]/g;

/** Разобранный JSON-объект или массив из строки; обычный текст и скаляры — `null`. */
function parsedJson(value: string): object | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Строки значения; строка с JSON-объектом или массивом (аргументы вызова, результат MCP) раскрывается в строки внутри него. */
function textsOf(value: unknown): string[] {
  if (typeof value !== 'string') return stringsIn(value);
  const parsed = parsedJson(value);
  return parsed === null ? [value] : stringsIn(parsed);
}

/** Поля `text` внутри значения (блоки результата MCP). */
const textFields = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(textFields)
    : isObject(value)
      ? Object.entries(value).flatMap(([key, inner]) => (key === 'text' && typeof inner === 'string' ? [inner] : textFields(inner)))
      : [];

/** Текст результата инструмента: поля `text` блоков, если они есть, иначе все строки результата; обычная строка — она сама. */
function resultTexts(value: unknown): string[] {
  const data = typeof value === 'string' ? (parsedJson(value) ?? value) : value;
  if (typeof data === 'string') return [data];
  const blocks = textFields(data);
  return blocks.length > 0 ? blocks : stringsIn(data);
}

const NO_SKILL_MATCHED = 'No skill matched';
/** Служебная шапка вывода `exec` Codex перед тем, что напечатал код: «Script completed / Wall time … / Output:». */
const EXEC_HEADER = /^Script completed\b[\s\S]*?\bOutput:\s*/;

/**
 * Пустой ли ответ `find_skill`. Настоящий ответ сервера — JSON `{"provider", "skills", "message"?}`, где `message`
 * («No skill matched: …», второй промах — «No skill matched again: …») есть, только когда ничего не нашлось. Узнаются
 * три вида: прежний простой текст с префиксом (синтетические журналы), этот JSON и обёртка MCP
 * `{"content":[{"type":"text","text":"<тот JSON строкой>"}]}`; у Codex перед JSON ещё шапка вывода `exec`.
 * Вложенность строк ограничена: обёртка кладёт JSON строкой в `text`, глубже она не уходит.
 */
export function isEmptyFindSkillResult(text: string, depth = 0): boolean {
  const body = text.replace(EXEC_HEADER, '').trimStart();
  if (body.startsWith(NO_SKILL_MATCHED)) return true;
  if (depth >= 3) return false;
  const parsed = parsedJson(body);
  if (!isObject(parsed)) return false;
  const message = parsed['message'];
  if (typeof message === 'string' && message.startsWith(NO_SKILL_MATCHED)) return true;
  const content = parsed['content'];
  return Array.isArray(content) && content.some((block) => isObject(block) && typeof block['text'] === 'string' && isEmptyFindSkillResult(block['text'], depth + 1));
}

/**
 * Один rollout-журнал Codex (`response_item` и `event_msg`, формат — `indexCodexSession` ядра): вызовы `find_skill`,
 * загрузки навыков и первый запрос. Codex 0.160 («code mode») зовёт все инструменты записью `custom_tool_call` с
 * именем `exec`, а в `input` лежит JS-код с вызовами `tools.<имя>(...)`, поэтому `find_skill` — каждое вхождение
 * `tools.mcp__<сервер>__find_skill(` в код (считается вхождение, а не исполнение: вызов в цикле посчитан один раз) или,
 * как в других версиях, запись с именем со словом `find_skill`. Загрузка навыка — вызов (оболочки, чтения файла,
 * `exec_command` в коде), в аргументах которого есть путь к `SKILL.md` навыка копии (при непустом `knownSkills` —
 * навыка из списка). Результат `find_skill` сопоставляется по `call_id`, но вывод `exec` общий для всех вызовов в
 * коде: его читают (байты, «ничего не найдено», предложенные навыки), только если `find_skill` — единственное
 * обращение к `tools` в коде; иначе байты результата неизвестны (`null`), остальное по такому вызову не собирается.
 * Первый запрос — первая запись `token_count` с `last_token_usage` (это запрос, а не накопитель; ядро берёт тот же
 * `info`): `input_tokens` у Codex уже включает кеш. Байты списка навыков, писем, результатов инструментов и сжатия
 * в журнале Codex не размечены надёжно: `null`.
 */
export async function collectCodexTranscript(file: string, knownSkills: readonly string[] = []): Promise<CodexTranscript> {
  const findCalls = new Set<string>();
  const loaded: string[] = [];
  const offered = new Set<string>();
  let [lookups, noMatch, reformulations, lookupsSinceLoad] = [0, 0, 0, 0];
  let findBytes: number | null = 0;
  let firstRequest: FirstRequest | null = null;
  await forEachJsonlRecord(file, (record: RawRecord) => {
    const payload = asRecord(record['payload']);
    if (payload === null) return;
    const kind = payload['type'];
    if (record['type'] === 'event_msg' && kind === 'token_count' && firstRequest === null) {
      const last = asRecord(asRecord(payload['info'])?.['last_token_usage']);
      if (last !== null) firstRequest = { cacheRead: asCount(last['cached_input_tokens']), totalInput: asCount(last['input_tokens']) };
      return;
    }
    if (record['type'] !== 'response_item') return;
    const callId = isString(payload['call_id']) ? payload['call_id'] : null;
    if (kind === 'function_call' || kind === 'custom_tool_call') {
      const text = textsOf(kind === 'function_call' ? payload['arguments'] : payload['input']).join('\n');
      const named = isString(payload['name']) && payload['name'].includes('find_skill');
      const inCode = [...text.matchAll(FIND_SKILL_CALL)].length;
      const found = named ? 1 : inCode;
      for (let i = 0; i < found; i += 1) {
        lookups += 1;
        if (lookupsSinceLoad > 0) reformulations += 1;
        lookupsSinceLoad += 1;
      }
      if (found > 0) {
        // Вывод принадлежит find_skill, если запись — сам вызов или он единственное обращение к `tools` в коде.
        if (named || text.match(TOOLS_ACCESS)?.length === 1) {
          if (callId !== null) findCalls.add(callId);
        } else {
          findBytes = null;
        }
      }
      const names = new Set([...text.matchAll(SKILL_FILE)].map((match) => match[1]!).filter((name) => knownSkills.length === 0 || knownSkills.includes(name)));
      loaded.push(...names);
      if (names.size > 0) lookupsSinceLoad = 0;
    }
    if ((kind === 'function_call_output' || kind === 'custom_tool_call_output') && callId !== null && findCalls.has(callId)) {
      const texts = resultTexts(payload['output']);
      if (findBytes !== null) findBytes += Buffer.byteLength(texts.join(''));
      if (texts.some((text) => isEmptyFindSkillResult(text))) noMatch += 1;
      for (const name of knownSkills) if (texts.some((text) => text.includes(name))) offered.add(name);
    }
  });
  const unique = new Set(loaded);
  return {
    skillUse: { lookups, loads: loaded.length, noMatch, reformulations, duplicateLoads: loaded.length - unique.size, forbiddenOffered: null },
    bytes: { bootstrapBytes: null, listingBytes: null, findSkillResultBytes: findBytes, toolResultBytes: null },
    traffic: { messages: null, broadcasts: null, deliveries: null },
    loaded,
    offered: [...offered],
    firstRequest,
  };
}

/**
 * Логи Codex: токены — индекс ядра; потомки (порождённые треды) прикрепляются к родителю по `parentId`. Счётчики
 * навыков — `collectCodexTranscript` по каждому файлу, версия CLI — `cli_version` из `session_meta` каждого, первый
 * запрос — у самого раннего родительского треда.
 */
export async function collectCodexSessions(
  files: string[],
  knownSkills: readonly string[] = [],
): Promise<{ entries: KeyedUsage[]; startedAt: string | null; endedAt: string | null; orphans: number; versions: string[]; transcripts: CodexTranscript[]; firstRequest: FirstRequest | null }> {
  const indexes = await Promise.all(files.map((file) => indexCodexSession(file)));
  const transcripts = await Promise.all(files.map((file) => collectCodexTranscript(file, knownSkills)));
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
  const lead = indexes
    .map((index, i) => ({ index, transcript: transcripts[i]! }))
    .filter((item) => item.index.spawned !== true)
    .sort((a, b) => (a.index.startedAt ?? '￿').localeCompare(b.index.startedAt ?? '￿'))[0];
  return {
    entries, startedAt: times[0] ?? null, endedAt: times[times.length - 1] ?? null, orphans: children.filter((child) => !claimed.has(child.id)).length,
    versions: [...new Set(indexes.flatMap((index) => (index.version === null ? [] : [index.version])))],
    transcripts,
    firstRequest: lead?.transcript.firstRequest ?? null,
  };
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
  const codex = input.codex.length > 0 ? await collectCodexSessions(input.codex, input.knownSkills) : null;
  if (claude.length + input.codex.length === 0) throw new Error('нужен хотя бы один лог сессии');
  // Журнал, который прогону с таким провайдером положен: без него условия прогона и собранное не сойдутся.
  if (input.begin.conditions.provider === 'codex' && codex === null) throw new Error(`${input.begin.id}: провайдер codex — нужен --codex <rollout.jsonl>`);
  if (input.begin.conditions.provider === 'glm' && claude.length === 0) throw new Error(`${input.begin.id}: провайдер glm — нужен --claude <транскрипт.jsonl>`);
  if (codex !== null && codex.orphans > 0) flags.push(`codex-orphan-descendants:${codex.orphans}`);
  // Версия CLI одна на всю волну: другая в транскрипте или несколько версий — прогон нельзя сравнивать с парой.
  // У Claude версия — `version` записей главного разговора, у Codex — `cli_version` из `session_meta` каждого журнала.
  const mismatched = (seen: Set<string>, pinned: string | undefined): boolean =>
    seen.size > 1 || (seen.size === 1 && pinned !== undefined && pinned !== 'unknown' && !seen.has(pinned));
  const pinnedClaude = /^claude (\S+)/.exec(input.begin.conditions.cli)?.[1];
  const pinnedCodex = /codex\s+(?:[A-Za-z-]+\s+)?(\d[\w.+-]*)/.exec(input.begin.conditions.cli)?.[1];
  if (mismatched(new Set(claude.flatMap((s) => s.versions)), pinnedClaude) || mismatched(new Set(codex?.versions ?? []), pinnedCodex)) {
    flags.push('cli-version-mismatch');
  }

  // Журнал Codex отдаёт неизвестное как `null`, поэтому суммы по прогону с ним остаются неизвестными там, где оно есть.
  const counted: Pick<SessionCollected, 'skillUse' | 'bytes' | 'traffic'>[] = [...claude, ...(codex?.transcripts ?? [])];
  const sum = (pick: (s: Pick<SessionCollected, 'skillUse' | 'bytes' | 'traffic'>) => number | null): number | null =>
    counted.reduce<number | null>((acc, s) => (acc === null || pick(s) === null ? null : acc + pick(s)!), 0);
  const group = (key: 'skillUse' | 'bytes' | 'traffic', keys: readonly string[]): Counts =>
    Object.fromEntries(keys.map((name) => [name, sum((s) => s[key][name] ?? null)]));
  const times = [...claude.flatMap((s) => [s.startedAt, s.endedAt]), codex?.startedAt ?? null, codex?.endedAt ?? null].filter((v): v is string => v !== null).sort();
  const loaded = [...claude.flatMap((s) => s.loaded), ...(codex?.transcripts.flatMap((t) => t.loaded) ?? [])];
  const listings = claude.map((s) => s.listedNames);
  const offered = [...claude.flatMap((s) => s.offered), ...(codex?.transcripts.flatMap((t) => t.offered) ?? [])];
  const md = 'minimal-development';
  // Первый запрос и старт MCP берутся у главного разговора: у самой ранней Claude-сессии прогона, без неё — у Codex.
  const lead = [...claude].sort((a, b) => (a.startedAt ?? '\uffff').localeCompare(b.startedAt ?? '\uffff'))[0];
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
    loadedSkills: loaded,
    offeredSkills: offered,
    axisEvidence: {
      // Список имён Claude или ответ find_skill называют навык: иначе признаков нет, а не «отсутствует».
      minimalDevelopmentListed: !sawListing && offered.length === 0 ? null : listings.some((names) => names?.includes(md) === true) || offered.includes(md),
      minimalDevelopmentLoaded: loaded.includes(md) ? true : null,
      // Только по транскриптам Claude: без них (чистый Codex) наблюдения нет.
      jevFired: claude.length === 0 ? null : claude.some((s) => s.jevFired),
    },
    firstRequest: lead?.firstRequest ?? codex?.firstRequest ?? null,
    startup: lead?.startup ?? { pendingMcpServers: null, failedMcpServers: null },
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
      // Настоящие `~/.claude` и `.mcp.json` сухой прогон не читает: место установки jev и список серверов у него подставные, пустые.
      const begin = await beginRun({ ...planned, id: `dry.${task.id}` }, budget, tmp, { versions: () => ({ claude: 'dry-run', codex: 'dry-run' }), fixtureDir, jevPluginIds: async () => [], mcpServerNames: async () => ({ names: [], warnings: [] }) });
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

/**
 * Хост кладёт сокет в `<дом>/host/host.sock` и не стартует, если путь длиннее предела `sun_path` в байтах UTF-8
 * (`SocketPathTooLong`): лучше отказать при плане, чем на живом прогоне по уже написанному листу. Раскладку и предел
 * берём у хоста. Его модуль тянет за собой всё ядро из `dist`, поэтому подгружается здесь, а не при старте
 * каждой команды стенда.
 */
export async function assertHostSocketFits(home: string): Promise<void> {
  const { hostPaths, MAX_SOCKET_PATH_BYTES } = await import('../packages/host/src/paths.js');
  const socket = hostPaths(home).socket;
  const bytes = Buffer.byteLength(socket, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`${socket}: путь сокета хоста ${bytes} байт при пределе ${MAX_SOCKET_PATH_BYTES}; передайте более короткий --home DIR (например, ~/.parley-bench)`);
  }
}

const HELP = `parley-token-benchmark — офлайн-стенд замера экономии (P38)

  validate                      проверить фикстуры сценариев и бюджет
  plan [--out DIR] [--home DIR] [--wave ID]
                                план, бюджет и лист запуска в DIR (по умолчанию .parley/benchmark);
                                --wave — только прогоны этой волны (без опции — все волны);
                                --home — PARLEY_HOME хоста (по умолчанию <out>/home), сокет <home>/host/host.sock
                                не должен выходить за предел пути хоста, иначе plan откажет
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
      out: { type: 'string' }, home: { type: 'string' }, wave: { type: 'string' }, runs: { type: 'string' }, count: { type: 'string' }, root: { type: 'string' },
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
  if (values.wave !== undefined && command === 'plan' && !hasWave(budget, values.wave)) throw new Error(`нет волны ${values.wave}`);
  const runs = planRuns(file, budget, command === 'plan' ? values.wave : undefined);
  if (command === 'plan') {
    const home = path.resolve(values.home ?? path.join(out, 'home'));
    await assertHostSocketFits(home);
    const estimate = estimateBudget(runs, budget);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'plan.json'), `${JSON.stringify({ runs, estimate }, null, 2)}\n`);
    await writeFile(path.join(out, 'run-sheet.md'), renderRunSheet(runs, file, budget, out, home));
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
