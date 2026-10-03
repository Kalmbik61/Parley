/**
 * Запуск сессии работы: план команды по реестру провайдеров и переходы статусов
 * (спецификация координации, разделы 5 и 6).
 *
 * Юридическая граница не меняется: спавнится только немодифицированный бинарь
 * провайдера из PATH под логином пользователя — здесь считается лишь то, с
 * какими аргументами его позвать.
 */

import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectRoots } from '../discover.js';
import { isServiceText } from '../session-index.js';
import { bothEnv } from '../names.js';
import {
  loadProviders,
  resumeCommand,
  startCommand,
  type EffortLevel,
  type ProviderEntry,
  type RunnerSubstitutions,
} from '../providers.js';
import { CHANNEL_VALUE, NO_CHANNEL_WARNING } from './channel.js';
import { writeBrief } from './brief.js';
import { systemGuidance } from './guidance.js';
import { readParleyMd, type LayerWarning } from './parley-md.js';
import { buildSessionLayer, developerInstructions, validateLayerArguments, type SessionLayerInput } from './session-layer.js';
import { addSession, removeSession, transitionSession, type NewSession } from './map.js';
import { codexNotifyOverride, mcpConfigValue, writeMcpConfig } from './mcp-config.js';
import { finishSession, linkProviderSession, type MetricsRoots } from './metrics.js';
import { writeWorkSettings } from './settings-file.js';
import { ensureStateDir } from './state-dir.js';
import { createWork, deleteSessionFiles, readMap, updateMap, workPaths } from './store.js';
import type { LaunchedBy, WorkSession } from './types.js';

/** Чего хочет запуск сверх самой сессии. */
export interface LaunchOptions {
  /**
   * Будить ли сессию звонком: флаг канала в команде и `PARLEY_CHANNEL` (с прежней
   * `HARNAS_CHANNEL`) в конфиге MCP. Панель берёт значение из настроек и пробы версии (4.4).
   */
  channel?: boolean;
  /**
   * Первый ход возобновлённой сессии — указатель на письма, которыми хост
   * поднимает спящую (спецификация окна 7.2). Только в `resume` и только если в
   * `resumeArgs` провайдера есть `{prompt}`: иначе подстановка выпадает, и хост
   * печатает указатель сам после первого простоя.
   */
  prompt?: string;
  /**
   * Модель и усилие новой сессии из диалога окна. Доезжают только до провайдера, у которого
   * в шаблоне запуска есть их подстановки (`supportsModel`, `supportsEffort`), и только при
   * запуске: `resumeArgs` их не содержат — Claude Code возвращает модель сам, а выбор из диалога
   * в карте не хранится. Перекрывают выбор, записанный в сессию `spawn_session`ом
   * (`WorkSession.model`, `.effort`): его хост подставляет сам, когда поднимает `pending`.
   */
  model?: string;
  effort?: EffortLevel;
  /**
   * Адрес приёмника хуков хоста: с ним файл `--settings` получает HTTP-хуки ленты (вид «Chat»,
   * решение 1). Хост передаёт его только для `claude` не ниже `FEED_MIN_VERSION`; нет — файл как раньше.
   */
  hookUrl?: string;
  /** Optional current role/recipe/memory snapshot, never persisted in the session map. */
  layer?: Omit<SessionLayerInput, 'guidance' | 'bridge' | 'brief' | 'parleyMd'>;
}

/** Чем и как поднимать процесс сессии в правой панели. */
export interface LaunchPlan {
  command: string;
  args: string[];
  /** Проект работы: у чужой работы это не cwd харнесса (решение №9). */
  cwd: string;
  env: Record<string, string>;
  /**
   * Id, выданный провайдеру, который принимает его снаружи (`claude --session-id`);
   * `null` — провайдер связывается с логом иначе, гадать за него нечего.
   */
  providerSessionId: string | null;
  /** Что в запуске пошло не так, оставшись запуском: строка статуса покажет `⚑`. */
  warnings: string[];
  /** Safe warning codes for host logging and deduplicated notices. */
  diagnostics?: LayerWarning[];
}

async function entryOf(provider: string): Promise<ProviderEntry> {
  const registry = await loadProviders();
  const entry = registry[provider];
  if (entry === undefined) {
    throw new Error(
      `unknown provider ${provider}; allowed: ${Object.keys(registry).join(', ')}`,
    );
  }
  return entry;
}

const briefFile = (projectPath: string, workId: string, sessionId: string): string =>
  path.join(workPaths(projectPath, workId).briefs, `${sessionId}.md`);

/**
 * Бриф сессии с диска. Между созданием записи и запуском файл можно править
 * своим редактором — поэтому он читается заново при каждом запуске (решение №1).
 * Файла нет (карту принесли из другого проекта) — собираем его заново.
 */
export async function readBrief(
  projectPath: string,
  workId: string,
  sessionId: string,
): Promise<string> {
  const file = briefFile(projectPath, workId, sessionId);
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeBrief(projectPath, await readMap(projectPath, workId), sessionId);
    return readFile(file, 'utf8');
  }
}

/**
 * Бриф, если он записан. `null` — брифа у сессии нет вовсе: быстрой сессии
 * `new` он не пишется (5.1), и придумывать его при запуске нечего.
 */
async function writtenBrief(
  projectPath: string,
  workId: string,
  sessionId: string,
): Promise<string | null> {
  try {
    return await readFile(briefFile(projectPath, workId, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

/**
 * Есть ли у Claude Code разговор с этим id: файл `<id>.jsonl` в каком-нибудь каталоге проекта одного из
 * корней истории (`claudeProjectRoots`: `$CLAUDE_CONFIG_DIR/projects`, `~/.claude/projects`; тесты и E2E
 * подменяют их `PARLEY_CLAUDE_PROJECTS_DIR`). Каталог по cwd не вычисляется: имя ему строит Claude Code, и у
 * сессии в worktree оно своё.
 *
 * «Нет» — только точный ответ: хоть один корень прочитан, и транскрипта нет ни в одном. Не прочитан ни один
 * (их нет, нет доступа) — разговор считается, и остаётся прежний `--resume`: новый процесс с занятым id
 * Claude Code не запустит («Session ID … is already in use»), а это хуже, чем «No conversation found».
 */
async function claudeConversationExists(id: string): Promise<boolean> {
  let readAny = false;
  for (const root of claudeProjectRoots()) {
    let projects: Dirent[];
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    readAny = true;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      try {
        if ((await stat(path.join(root, project.name, `${id}.jsonl`))).isFile()) return true;
      } catch {
        // В этом каталоге проекта такого транскрипта нет.
      }
    }
  }
  return !readAny;
}

/**
 * Как поднимается процесс: `launch` — по брифу, `resume` — по `resumeArgs`,
 * `new` — быстрая сессия без промпта вовсе (дизайн TUI v2, 5.1).
 */
type LaunchMode = 'launch' | 'resume' | 'new';

/** Общая часть запуска и возобновления: конфиг MCP, подстановки, команда. */
async function plan(
  projectPath: string,
  workId: string,
  session: WorkSession,
  mode: LaunchMode,
  options: LaunchOptions = {},
): Promise<LaunchPlan> {
  const entry = await entryOf(session.provider);
  const paths = workPaths(projectPath, workId);
  const cwd = session.worktree?.path ?? projectPath;

  // Тихий старт: задачи у сессии нет — бриф уходит контекстом в системный
  // промпт, а не первым сообщением, и агент ждёт запроса пользователя
  // (план от 2026-09-06, раздел B).
  const quiet = session.task === '';

  // Продолжать нечего, пока id сессии у провайдера неизвестен: такой запуск —
  // новый процесс по тому же брифу, запись в карте остаётся прежней. Id Claude Code харнесс выдаёт
  // сам (`--session-id`) ещё на запуске, а транскрипт появляется с первым сообщением: сессию, уснувшую
  // раньше, `--resume` не поднимет («No conversation found»), и её тоже запускаем заново — с тем же id.
  const resuming =
    mode === 'resume' &&
    session.providerSessionId !== null &&
    (session.provider !== 'claude' || (await claudeConversationExists(session.providerSessionId)));
  let providerSessionId: string | null = null;

  // Файл хуков нужен тому, кто его принимает (`claude --settings`); один на
  // работу, потому что команда хука не зависит от сессии (дизайн 4.2).
  const template = (resuming ? entry.runner.resumeArgs : entry.runner.args) ?? [];

  // Звонок доходит только туда, куда уехал флаг канала: без `{channel}` в
  // шаблоне ставить `PARLEY_CHANNEL` некому и незачем.
  const warnings: string[] = [];
  const diagnostics: LayerWarning[] = [];
  const channel = options.channel === true && template.includes('{channel}');
  // Молчим про чужих провайдеров: push — возможность Claude Code, у codex и GLM
  // `{channel}` в шаблоне нет и быть не должно.
  if (options.channel === true && !channel && entry.id === 'claude') {
    warnings.push(NO_CHANNEL_WARNING);
  }

  // `env` — окружение запускающего процесса: Codex режет серверу MCP окружение, и нужные ему
  // `PARLEY_*` и `HARNAS_*` (дом харнесса, подмены бинарей) уходят в таблицу `env` сервера явно.
  const params = {
    workDir: paths.dir,
    sessionId: session.id,
    env: process.env,
    ...(channel ? { channel } : {}),
  };

  // Файл конфига нужен только тем, кто принимает путь; codex получает сервер
  // значением `-c`, и лишний файл ему незачем.
  const file =
    entry.runner.mcpConfig === 'json-file'
      ? await writeMcpConfig(projectPath, workId, session.id, undefined, channel)
      : null;
  const mcp = mcpConfigValue(entry.runner.mcpConfig, params, file ?? '');

  const subs: RunnerSubstitutions = {};
  if (mcp !== undefined) subs.mcpConfig = mcp;
  if (channel) subs.channel = CHANNEL_VALUE;
  // Роль сессии ставится при каждом запуске, включая `resume`: агент Claude
  // Code живёт в процессе, а не в транскрипте, как и системная вставка (5.1).
  // Проверка имени осталась там, где создавалась запись, — второй раз файл
  // агента читать нечего.
  if (session.agent !== null) subs.agent = session.agent;
  if (template.includes('{settingsFile}')) {
    subs.settingsFile = await writeWorkSettings(
      projectPath,
      workId,
      options.hookUrl !== undefined ? { hookUrl: options.hookUrl } : {},
    );
  }
  // Конец хода Codex приходит скриптом `notify`, а тот только дописывает журнал `events/` — каталог
  // под него заводит запуск, как `writeWorkSettings` заводит его для хуков Claude Code: наблюдатель
  // журналов хоста не встанет на каталог, которого нет.
  if (template.includes('{notify}')) {
    await ensureStateDir(projectPath);
    await mkdir(paths.events, { recursive: true });
    subs.notify = codexNotifyOverride();
  }
  const hasSystemLayer = template.includes('{systemPrompt}');
  const hasDeveloperLayer = template.includes('{developerInstructions}');
  const nativeClaudeRole = entry.id === 'claude' && options.layer?.nativeClaudeRole === true;
  if (options.layer?.role?.trim()) {
    const deliverable = nativeClaudeRole
      ? session.agent !== null && template.includes('{agent}')
      : hasSystemLayer || hasDeveloperLayer;
    if (!deliverable) throw new Error('role-delivery-unavailable: this runner cannot deliver the required role.');
  }
  if (entry.id === 'codex' && !hasDeveloperLayer) {
    diagnostics.push({
      code: 'provider-override-gap',
      message: 'Custom Codex runner has no {developerInstructions}; add this placeholder to deliver the Parley session layer through Codex.',
    });
  }
  // One current layer for launch/new/resume; only its provider channel differs.
  let blockBytes;
  if (hasSystemLayer || hasDeveloperLayer) {
    const map = await readMap(projectPath, workId);
    const brief = quiet ? await writtenBrief(projectPath, workId, session.id) : null;
    const parley = await readParleyMd(projectPath);
    diagnostics.push(...parley.warnings);
    const bridge = entry.id === 'codex' && await codexBridgeApplies(cwd)
      ? 'Project instructions here were written for Claude Code (CLAUDE.md): they may name skills, slash commands or tools you do not have — skip those parts.'
      : '';
    const layer = buildSessionLayer({
      ...options.layer,
      nativeClaudeRole,
      guidance: systemGuidance(map, session.id),
      bridge,
      ...(brief === null ? {} : { brief }),
      parleyMd: parley.text,
    });
    blockBytes = layer.blockBytes;
    diagnostics.push(...layer.warnings);
    if (hasSystemLayer) subs.systemPrompt = layer.text;
    if (hasDeveloperLayer) subs.developerInstructions = developerInstructions(layer.text);
  }

  if (resuming) {
    subs.providerSessionId = session.providerSessionId as string;
    if (options.prompt !== undefined && template.includes('{prompt}')) subs.prompt = options.prompt;
  } else {
    // Быстрая сессия стартует без промпта: карту и правила агент получает
    // через MCP, бриф ей не пишется (5.1). Тихая — тоже: её бриф уже уехал
    // системным промптом.
    const brief = mode !== 'new' && !quiet ? await readBrief(projectPath, workId, session.id) : '';
    // Сессию без разговора, поднятую письмом, указатель догоняет её первым сообщением: будильник уже
    // счёл письма указанными (`{prompt}` в `resumeArgs`) и второй раз их не напечатает.
    const pointer = mode === 'resume' ? (options.prompt ?? '') : '';
    const first = [brief, pointer].filter((part) => part !== '').join('\n\n');
    if (first !== '') subs.prompt = first;
    const model = options.model ?? session.model;
    if (model !== undefined) subs.model = model;
    const effort = options.effort ?? session.effort;
    if (effort !== undefined) subs.effort = effort;
    if (entry.linkBy === 'session-id') {
      providerSessionId = session.providerSessionId ?? randomUUID();
      subs.sessionUuid = providerSessionId;
    }
  }

  const { command, args } = resuming ? resumeCommand(entry, subs) : startCommand(entry, subs);
  validateLayerArguments(args, blockBytes, subs.systemPrompt);
  warnings.push(...diagnostics.map((warning) => warning.message));
  return {
    command,
    args,
    // Сессия в своём worktree живёт там во всех режимах, включая `resume`:
    // `claude --resume` ищет транскрипт по каталогу, а не по id (спецификация 8.1).
    cwd,
    // Те же переменные, что у MCP-сервера в конфиге: сервер знает, кто звонит,
    // даже унаследовав окружение от агента. Под обоими именами: старые скрипты и сервер
    // прежней сборки читают `HARNAS_*` (R3).
    env: bothEnv({ WORK_DIR: paths.dir, SESSION_ID: session.id }),
    providerSessionId,
    warnings,
    diagnostics,
  };
}

async function codexBridgeApplies(cwd: string): Promise<boolean> {
  const isFile = async (name: string): Promise<boolean> => {
    try { return (await stat(path.join(cwd, name))).isFile(); }
    catch { return false; }
  };
  const [claude, agents, override] = await Promise.all(['CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md'].map(isFile));
  return claude === true && agents === false && override === false;
}

/** Запуск `pending` сессии: бриф стартовым промптом (дизайн 4.3). */
export function planLaunch(
  projectPath: string,
  workId: string,
  session: WorkSession,
  options?: LaunchOptions,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, 'launch', options);
}

/** Возобновление вышедшей или завершённой сессии по `resumeArgs` (дизайн 4.4). */
export function planResume(
  projectPath: string,
  workId: string,
  session: WorkSession,
  options?: LaunchOptions,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, 'resume', options);
}

/** Быстрая сессия `new`: тот же запуск, но без промпта (дизайн TUI v2, 5.1). */
export function planNew(
  projectPath: string,
  workId: string,
  session: WorkSession,
  options?: LaunchOptions,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, 'new', options);
}

/**
 * Ярлык быстрой сессии, пока не появился заголовок Claude Code (5.1). Метка-страж: она лежит в картах на
 * диске, по значению её узнают `applyAutoTitle`, хост (автозаголовок) и окно (показывает «New session»), а
 * агент видит её в брифе и в результатах MCP — поэтому английская.
 */
export const NEW_LABEL = 'new session';
/** Заголовок работы, созданной вместе с быстрой сессией (5.1); метка-страж того же рода, что `NEW_LABEL`. */
export const UNTITLED_WORK = 'untitled';
/**
 * Те же метки в прежней, русской записи: карты, заведённые сборками до перевода текстов, хранят их, и они
 * по-прежнему свои — автозаголовок такую сессию и такую работу переименует. Текст — как он лежит на диске,
 * поэтому не переводится.
 */
const RUSSIAN_NEW_LABEL = 'новая сессия'; // cyrillic-ok: метка на диске, по ней узнаём свою
const RUSSIAN_UNTITLED_WORK = 'без названия'; // cyrillic-ok: метка на диске, по ней узнаём свою

/**
 * Ярлык быстрой сессии, ещё не переименованной: `NEW_LABEL` или его прежняя русская запись. Служебный
 * текст Claude Code (`<local-command-caveat>…`) — тоже не имя: его ставил автозаголовок сборок до 0.2.0
 * сессиям, начатым со слеш-команды, и такой ярлык автозаголовок переименует заново.
 */
export function isNewLabel(label: string): boolean {
  return label === NEW_LABEL || label === RUSSIAN_NEW_LABEL || isServiceText(label);
}

/**
 * Заголовок работы, ещё не названной: `UNTITLED_WORK` или его прежняя русская запись. Служебный текст Claude
 * Code — тоже не название: автозаголовок сборок до 0.2.0 ставил его безымянной работе вместе с ярлыком сессии.
 */
export function isUntitledWork(title: string): boolean {
  return title === UNTITLED_WORK || title === RUSSIAN_UNTITLED_WORK || isServiceText(title);
}

export interface NewSessionResult {
  workId: string;
  session: WorkSession;
}

/**
 * `new` без диалога: работа берётся выбранная, а если работ нет — заводится
 * работа `UNTITLED_WORK` с пустой целью. Бриф такой сессии не пишется (5.1).
 */
export async function createNewSession(
  projectPath: string,
  workId: string | null,
): Promise<NewSessionResult> {
  const id = workId ?? (await createWork(projectPath, { title: UNTITLED_WORK, goal: '' })).work.id;
  let created: WorkSession | undefined;
  await updateMap(projectPath, id, (map) => {
    created = addSession(map, { provider: 'claude', label: NEW_LABEL, task: '' });
  });
  if (created === undefined) throw new Error(`session in workspace ${id} was not created`);
  return { workId: id, session: created };
}

/**
 * Дочерняя сессия выбранной, руками (окно, через хост). Родитель и контекст — выбранная
 * сессия, бриф собирается как у порождённых агентом (`spawn_session`): резюме и
 * артефакты родителя плюс правила. Задачи у неё нет: бриф уходит контекстом в
 * системный промпт, а запрос пишет пользователь первым сообщением (раздел B
 * плана от 2026-09-06).
 */
export async function createChildSession(
  projectPath: string,
  workId: string,
  parentId: string,
): Promise<NewSessionResult> {
  let created: WorkSession | undefined;
  const map = await updateMap(projectPath, workId, (current) => {
    const parent = current.sessions.find((item) => item.id === parentId);
    if (parent === undefined) throw new Error(`session ${parentId} is not in workspace ${workId}`);
    created = addSession(current, {
      provider: 'claude',
      label: NEW_LABEL,
      task: '',
      parent: parentId,
      contextFrom: [parentId],
    });
  });
  if (created === undefined) throw new Error(`session in workspace ${workId} was not created`);
  await writeBrief(projectPath, map, created.id);
  return { workId, session: created };
}

/**
 * Заголовок Claude Code доехал до индекса логов: ярлык быстрой сессии и
 * заголовок работы `UNTITLED_WORK` обновляются из него один раз (5.1).
 * Переименованную руками сессию не трогаем — её ярлык уже не `NEW_LABEL`.
 */
export async function applyAutoTitle(
  projectPath: string,
  workId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await updateMap(projectPath, workId, (map) => {
    const session = map.sessions.find((item) => item.id === sessionId);
    if (session === undefined || !isNewLabel(session.label)) return;
    session.label = title;
    if (isUntitledWork(map.work.title)) map.work.title = title;
  });
}

/** Новая сессия работы: запись `pending` и бриф по общему шаблону (раздел 5). */
export async function createPendingSession(
  projectPath: string,
  workId: string,
  init: NewSession,
): Promise<string> {
  let created = '';
  const map = await updateMap(projectPath, workId, (current) => {
    created = addSession(current, init).id;
  });
  await writeBrief(projectPath, map, created);
  return created;
}

/**
 * Убрать сессию из карты и её файлы с диска (план от 2026-09-06, раздел C).
 * Сначала карта — она источник истины: не удалившийся журнал читатели
 * всё равно не покажут, а запись без карты показывать было бы нечем. Процесс к
 * этому моменту уже вышел: его гасит хост.
 */
export async function deleteSession(
  projectPath: string,
  workId: string,
  sessionId: string,
): Promise<void> {
  await updateMap(projectPath, workId, (map) => {
    removeSession(map, sessionId);
  });
  await deleteSessionFiles(projectPath, workId, sessionId);
}

/** Процесс, поднятый харнессом: по нему проверяется живость после перезапуска (5.4). */
export interface StartedProcess {
  pid: number;
  /** Время старта процесса из ОС; `null` — платформа его не сообщает. */
  startedAtProcess: string | null;
  launchedBy: LaunchedBy;
}

/**
 * Панель открыта, процесс запущен: `pending`/`sleeping` → `active`
 * с записью id сессии у провайдера (спецификация, раздел 6) и приметами
 * процесса, по которым сессия узнаётся после перезапуска харнесса (5.4).
 */
export async function startSession(
  projectPath: string,
  workId: string,
  sessionId: string,
  providerSessionId: string | null,
  started?: StartedProcess,
): Promise<void> {
  await updateMap(projectPath, workId, (map) => {
    const current = map.sessions.find((candidate) => candidate.id === sessionId);
    // Возобновлённая из истории заведена в карте уже `active` (5.3): переход
    // `active → active` таблицей не разрешён и здесь не нужен — остаётся
    // записать приметы процесса.
    const session =
      current?.lifecycle === 'active' ? current : transitionSession(map, sessionId, 'active');
    if (providerSessionId !== null) session.providerSessionId = providerSessionId;
    if (started === undefined) return;
    session.pid = started.pid;
    session.startedAtProcess = started.startedAtProcess;
    session.launchedBy = started.launchedBy;
  });
}

/**
 * Привязка сессии к логу провайдера, который не принимает id снаружи: сессия
 * ищется по cwd и времени запуска (спецификация, раздел 5). Найденный id
 * пишется в карту — без него нет ни метрик, ни возобновления.
 *
 * `null` — привязывать нечего или лог ещё не появился: следующее событие
 * watcher попробует снова.
 */
export async function linkSession(
  projectPath: string,
  workId: string,
  session: WorkSession,
  roots: MetricsRoots = {},
): Promise<string | null> {
  if (session.providerSessionId !== null || session.startedAt === null) return null;

  const entry = await entryOf(session.provider);
  // Логи, занятые другими сессиями работы, своими не берём: рядом запущенный агент в том же каталоге иначе
  // получил бы самый ранний лог — чужой.
  const taken = new Set<string>();
  for (const other of (await readMap(projectPath, workId)).sessions) {
    if (other.id !== session.id && other.providerSessionId !== null) taken.add(other.providerSessionId);
  }
  const found = await linkProviderSession(
    entry,
    { cwd: projectPath, startedAt: session.startedAt },
    { ...roots, exclude: taken },
  );
  if (found === null) return null;

  let lost = false;
  await updateMap(projectPath, workId, (map) => {
    const target = map.sessions.find((candidate) => candidate.id === session.id);
    // Пока шёл поиск, сессию могли привязать: чужой id не затираем. Или лог занял сосед по поиску
    // (обе сессии искали одновременно и увидели один лог): побеждает первая запись, вторая ищет дальше.
    if (target === undefined || target.providerSessionId !== null) return;
    if (map.sessions.some((other) => other.id !== target.id && other.providerSessionId === found)) {
      lost = true;
      return;
    }
    target.providerSessionId = found;
  });
  return lost ? null : found;
}

/**
 * Процесс сессии завершился: `active` → `sleeping` с кодом выхода в
 * `history` и фиксацией итоговых метрик. Итог отчёта выход процесса не трогает:
 * это другая ось (спецификация 7.1).
 */
export async function finishExited(
  projectPath: string,
  workId: string,
  sessionId: string,
  exit: { exitCode: number; signal: number | undefined },
  roots: MetricsRoots = {},
): Promise<void> {
  const session = (await readMap(projectPath, workId)).sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  if (session === undefined) return;
  if (session.lifecycle !== 'active') return;

  await finishSession(projectPath, workId, sessionId, 'sleeping', {
    ...roots,
    exitCode: exit.exitCode,
    ...(exit.signal === undefined ? {} : { signal: exit.signal }),
  });
}
