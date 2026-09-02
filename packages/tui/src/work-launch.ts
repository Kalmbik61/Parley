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
  commandInPath,
  finishSession,
  loadProviders,
  mcpConfigValue,
  readMap,
  resumeCommand,
  startCommand,
  transitionSession,
  updateMap,
  workPaths,
  writeBrief,
  writeMcpConfig,
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

/** Провайдер для селектора диалога новой сессии (дизайн 4.2). */
export interface ProviderOption {
  id: string;
  label: string;
  /** Нет в PATH — показывается, но не выбирается. */
  available: boolean;
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

/** Провайдеры реестра с пометкой доступности — селектор диалога новой сессии. */
export async function providerOptions(): Promise<ProviderOption[]> {
  const registry = await loadProviders();
  return Promise.all(
    Object.values(registry).map(async (entry) => ({
      id: entry.id,
      label: entry.label,
      available: await commandInPath(entry.runner.command),
    })),
  );
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

/** Общая часть запуска и возобновления: конфиг MCP, подстановки, команда. */
async function plan(
  projectPath: string,
  workId: string,
  session: WorkSession,
  resume: boolean,
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

  // Продолжать нечего, пока id сессии у провайдера неизвестен: такой запуск —
  // новый процесс по тому же брифу, запись в карте остаётся прежней.
  const resuming = resume && session.providerSessionId !== null;
  let providerSessionId: string | null = null;

  if (resuming) {
    subs.providerSessionId = session.providerSessionId as string;
  } else {
    subs.prompt = await readBrief(projectPath, workId, session.id);
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
  return plan(projectPath, workId, session, false);
}

/** Возобновление вышедшей или завершённой сессии по `resumeArgs` (дизайн 4.4). */
export function planResume(
  projectPath: string,
  workId: string,
  session: WorkSession,
): Promise<LaunchPlan> {
  return plan(projectPath, workId, session, true);
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
 * Панель открыта, процесс запущен: `pending`/`exited`/`done`/`failed` → `active`
 * с записью id сессии у провайдера (спецификация, раздел 6).
 */
export async function startSession(
  projectPath: string,
  workId: string,
  sessionId: string,
  providerSessionId: string | null,
): Promise<void> {
  await updateMap(projectPath, workId, (map) => {
    const session = transitionSession(map, sessionId, 'active');
    if (providerSessionId !== null) session.providerSessionId = providerSessionId;
  });
}

/**
 * Процесс сессии завершился: `active`/`idle` → `exited` с кодом выхода в
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
  if (session.status !== 'active' && session.status !== 'idle') return;

  await finishSession(projectPath, workId, sessionId, 'exited', {
    ...roots,
    exitCode: exit.exitCode,
    ...(exit.signal === undefined ? {} : { signal: exit.signal }),
  });
}
