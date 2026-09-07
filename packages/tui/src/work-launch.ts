/**
 * Запуск сессии работы: план команды по реестру провайдеров и переходы статусов
 * (спецификация координации, разделы 5 и 6).
 *
 * Юридическая граница не меняется: спавнится только немодифицированный бинарь
 * провайдера из PATH под логином пользователя — здесь считается лишь то, с
 * какими аргументами его позвать.
 */

import {
  addSession,
  createWork,
  deleteSessionFiles,
  finishSession,
  linkProviderSession,
  loadProviders,
  mcpConfigValue,
  readMap,
  removeSession,
  resumeCommand,
  startCommand,
  systemGuidance,
  transitionSession,
  updateMap,
  workPaths,
  writeBrief,
  writeMcpConfig,
  writeWorkSettings,
  type LaunchedBy,
  type MetricsRoots,
  type NewSession,
  type ProviderEntry,
  type RunnerSubstitutions,
  type WorkSession,
} from '@harnas/core';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
}

async function entryOf(provider: string): Promise<ProviderEntry> {
  const registry = await loadProviders();
  const entry = registry[provider];
  if (entry === undefined) {
    throw new Error(
      `неизвестный провайдер ${provider}; допустимы: ${Object.keys(registry).join(', ')}`,
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
): Promise<LaunchPlan> {
  const entry = await entryOf(session.provider);
  const paths = workPaths(projectPath, workId);
  const params = { workDir: paths.dir, sessionId: session.id };

  // Файл конфига нужен только тем, кто принимает путь; codex получает сервер
  // значением `-c`, и лишний файл ему незачем.
  const file =
    entry.runner.mcpConfig === 'json-file'
      ? await writeMcpConfig(projectPath, workId, session.id)
      : null;
  const mcp = mcpConfigValue(entry.runner.mcpConfig, params, file ?? '');

  const subs: RunnerSubstitutions = {};
  if (mcp !== undefined) subs.mcpConfig = mcp;

  // Тихий старт: задачи у сессии нет — бриф уходит контекстом в системный
  // промпт, а не первым сообщением, и агент ждёт запроса пользователя
  // (план от 2026-09-06, раздел B).
  const quiet = session.task === '';

  // Продолжать нечего, пока id сессии у провайдера неизвестен: такой запуск —
  // новый процесс по тому же брифу, запись в карте остаётся прежней.
  const resuming = mode === 'resume' && session.providerSessionId !== null;
  let providerSessionId: string | null = null;

  // Файл хуков нужен тому, кто его принимает (`claude --settings`); один на
  // работу, потому что команда хука не зависит от сессии (дизайн 4.2).
  const template = (resuming ? entry.runner.resumeArgs : entry.runner.args) ?? [];
  if (template.includes('{settingsFile}')) {
    subs.settingsFile = await writeWorkSettings(projectPath, workId);
  }
  // Системная вставка гида идёт во всех трёх режимах, включая `resume`:
  // системный промпт живёт в процессе, а не в транскрипте, и собирается заново
  // при каждом запуске (план от 2026-09-06, раздел A).
  if (template.includes('{systemPrompt}')) {
    const guidance = systemGuidance(await readMap(projectPath, workId), session.id);
    // Бриф тихой сессии идёт этим же путём и при `resume`: транскрипт начинается
    // с сообщения пользователя, контекста родителя в нём нет.
    const brief = quiet ? await writtenBrief(projectPath, workId, session.id) : null;
    subs.systemPrompt = brief === null ? guidance : `${guidance}\n\n${brief}`;
  }

  if (resuming) {
    subs.providerSessionId = session.providerSessionId as string;
  } else {
    // Быстрая сессия стартует без промпта: карту и правила агент получает
    // через MCP, бриф ей не пишется (5.1). Тихая — тоже: её бриф уже уехал
    // системным промптом.
    if (mode !== 'new' && !quiet) subs.prompt = await readBrief(projectPath, workId, session.id);
    if (entry.linkBy === 'session-id') {
      providerSessionId = session.providerSessionId ?? randomUUID();
      subs.sessionUuid = providerSessionId;
    }
  }

  const { command, args } = resuming ? resumeCommand(entry, subs) : startCommand(entry, subs);
  return {
    command,
    args,
    cwd: projectPath,
    // Те же переменные, что у MCP-сервера в конфиге: сервер знает, кто звонит,
    // даже унаследовав окружение от агента.
    env: { HARNAS_WORK_DIR: paths.dir, HARNAS_SESSION_ID: session.id },
    providerSessionId,
  };
}

/** Запуск `pending` сессии: бриф стартовым промптом (дизайн 4.3). */
export function planLaunch(
  projectPath: string,
  workId: string,
  session: WorkSession,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, 'launch');
}

/** Возобновление вышедшей или завершённой сессии по `resumeArgs` (дизайн 4.4). */
export function planResume(
  projectPath: string,
  workId: string,
  session: WorkSession,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, 'resume');
}

/** Быстрая сессия `new`: тот же запуск, но без промпта (дизайн TUI v2, 5.1). */
export function planNew(
  projectPath: string,
  workId: string,
  session: WorkSession,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, 'new');
}

/** Ярлык быстрой сессии, пока не появился заголовок Claude Code (5.1). */
export const NEW_LABEL = 'новая сессия';
/** Заголовок работы, созданной вместе с быстрой сессией (5.1). */
export const UNTITLED_WORK = 'без названия';

export interface NewSessionResult {
  workId: string;
  session: WorkSession;
}

/**
 * `new` без диалога: работа берётся выбранная, а если работ нет — заводится
 * «без названия» с пустой целью. Бриф такой сессии не пишется (5.1).
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
  if (created === undefined) throw new Error(`сессия в работе ${id} не создана`);
  return { workId: id, session: created };
}

/**
 * `prefix C`: дочерняя сессия выбранной, руками. Родитель и контекст — выбранная
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
    if (parent === undefined) throw new Error(`сессии ${parentId} в работе ${workId} нет`);
    created = addSession(current, {
      provider: 'claude',
      label: NEW_LABEL,
      task: '',
      parent: parentId,
      contextFrom: [parentId],
    });
  });
  if (created === undefined) throw new Error(`сессия в работе ${workId} не создана`);
  await writeBrief(projectPath, map, created.id);
  return { workId, session: created };
}

/**
 * Заголовок Claude Code доехал до индекса логов: ярлык быстрой сессии и
 * заголовок работы «без названия» обновляются из него один раз (5.1).
 * Переименованную руками сессию не трогаем — она уже не `новая сессия`.
 */
export async function applyAutoTitle(
  projectPath: string,
  workId: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await updateMap(projectPath, workId, (map) => {
    const session = map.sessions.find((item) => item.id === sessionId);
    if (session === undefined || session.label !== NEW_LABEL) return;
    session.label = title;
    if (map.work.title === UNTITLED_WORK) map.work.title = title;
  });
}

/**
 * Возобновление из истории провайдера: сессия `~/.claude` регистрируется в
 * текущей работе (дизайн TUI v2, 5.3). Она уже жила, поэтому заводится сразу
 * `active`, и её история начинается с этого перехода — `pending` у неё не было.
 * Метрики считаются по всему транскрипту: `providerSessionId` указывает на весь
 * лог, включая часть до регистрации.
 */
export async function registerResumed(
  projectPath: string,
  workId: string,
  providerSessionId: string,
  label: string,
  at: string = new Date().toISOString(),
): Promise<WorkSession> {
  let created: WorkSession | undefined;
  await updateMap(projectPath, workId, (map) => {
    const session = addSession(map, { provider: 'claude', label, task: '' }, at);
    session.status = 'active';
    session.history = [{ status: 'active', at }];
    session.startedAt = at;
    session.providerSessionId = providerSessionId;
    created = session;
  });
  if (created === undefined) throw new Error(`сессия в работе ${workId} не создана`);
  return created;
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
 * `prefix d`: убрать сессию из карты и её файлы с диска (план от 2026-09-06,
 * раздел C). Сначала карта — она источник истины: не удалившийся журнал читатели
 * всё равно не покажут, а запись без карты показывать было бы нечем. Процесс к
 * этому моменту уже вышел: его гасит панель.
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
 * Панель открыта, процесс запущен: `pending`/`exited`/`done`/`failed` → `active`
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
      current?.status === 'active' ? current : transitionSession(map, sessionId, 'active');
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
  const found = await linkProviderSession(
    entry,
    { cwd: projectPath, startedAt: session.startedAt },
    roots,
  );
  if (found === null) return null;

  await updateMap(projectPath, workId, (map) => {
    const target = map.sessions.find((candidate) => candidate.id === session.id);
    // Пока шёл поиск, сессию могли привязать: чужой id не затираем.
    if (target !== undefined && target.providerSessionId === null) {
      target.providerSessionId = found;
    }
  });
  return found;
}

/**
 * Процесс сессии завершился: `active` → `exited` с кодом выхода в
 * `history` и фиксацией итоговых метрик. Сессия, успевшая отчитаться, остаётся
 * в своём `done`/`failed` — отчёт агента важнее выхода процесса (раздел 6).
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
  if (session.status !== 'active') return;

  await finishSession(projectPath, workId, sessionId, 'exited', {
    ...roots,
    exitCode: exit.exitCode,
    ...(exit.signal === undefined ? {} : { signal: exit.signal }),
  });
}
