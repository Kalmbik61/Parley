/**
 * Каталог моделей Qwen Code от самого CLI (спека 2026-11-12, 8.4): короткая проба `qwen --acp` шлёт `initialize` и
 * `session/new` (без промпта, без обращения к модели) и читает `models.availableModels`. Проба идёт на старте хоста,
 * в фоне, когда `providers.list` застаёт каталог старше шести часов, и после входа в Qwen. Новый список атомарно
 * переписывает файл Parley `qwen-models.json` (`qwenModelsFile` в core) и зовёт `onChange`; файл читает `loadProviders`,
 * поэтому окно, хост и MCP-сервер агента видят один список. Сбой пробы файл не трогает.
 *
 * Рамка секретов: код Parley не открывает ни одного файла, кроме своего временного `cwd` и `qwen-models.json`, и не
 * передаёт CLI ни пути к файлу входа, ни ключа, ни системного файла настроек сессии Parley. Файл входа читает сам CLI,
 * как в каждой сессии Qwen, которую запускает человек. Запускается то, что стоит у человека в PATH (или подмена
 * `PARLEY_QWEN_BIN`).
 *
 * Процесс пробы всегда завершается целиком: он лидер своей группы процессов, и в `finally` группа получает SIGTERM, а
 * через `killGraceMs` — SIGKILL, если кто-то жив; потомок, державший stdout, пробу не задерживает.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandBinary, MODEL_LABEL_MAX, PROVIDERS, qwenModelsFile, type ModelOption } from '@parley/core';
import type { Log } from '../log.js';

/** Одна проба: `models.availableModels` ответа `session/new` как есть; `null` — любая неудача. */
export type QwenModelsProbe = (command: string) => Promise<unknown>;

export interface QwenCatalog {
  /** Первая проба завершена, успехом или нет; не отказывает. */
  ready: Promise<void>;
  /** Модели последней удачной пробы в порядке CLI; `null` — удачной пробы ещё не было. */
  current(): ModelOption[] | null;
  /** Каталог старше срока и проба не идёт — новая проба в фоне; `providers.list` её не ждёт. */
  refreshIfStale(): void;
  /** Проба сейчас: идущая делится (вызов присоединяется к ней), иначе стартует новая. Не отказывает. */
  refresh(): Promise<void>;
}

/** Срок каталога: старше — `providers.list` просит пробу заново. */
export const QWEN_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Таймаут пробы целиком. */
export const QWEN_CATALOG_TIMEOUT_MS = 15_000;
/** Предел вывода CLI (stdout) за пробу. */
export const QWEN_CATALOG_MAX_BYTES = 1024 * 1024;
/** Сколько после SIGTERM группа может жить до SIGKILL. */
export const QWEN_PROBE_KILL_GRACE_MS = 2000;

/** `--model`: одно слово, не с дефиса, не длиннее 200 знаков — правило id модели core (`modelChoiceError`). */
const MODEL_ID = /^[^\s-]\S*$/;
const MODEL_ID_MAX_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Модели из `availableModels`: только записи с `_meta.isRuntime === false`; `id` — `_meta.baseModelId`, голый id, который
 * принимает `-m`, `label` — `name`. Порядок CLI, повторы и записи не той формы выбрасываются, `efforts: null` (DQ2).
 * `null` — не список или годных моделей нет.
 */
export function parseQwenModels(available: unknown, log?: Pick<Log, 'warn'>): ModelOption[] | null {
  if (!Array.isArray(available)) return null;
  const models: ModelOption[] = [];
  for (const entry of available) {
    const meta = isRecord(entry) ? entry['_meta'] : undefined;
    if (!isRecord(meta) || meta['isRuntime'] !== false) continue;
    const id = meta['baseModelId'];
    const name = isRecord(entry) ? entry['name'] : undefined;
    if (
      typeof id === 'string' &&
      id.length <= MODEL_ID_MAX_LENGTH &&
      MODEL_ID.test(id) &&
      typeof name === 'string' &&
      name !== '' &&
      !models.some((known) => known.id === id)
    ) {
      models.push({ id, label: name.slice(0, MODEL_LABEL_MAX), efforts: null });
      continue;
    }
    if (log !== undefined) log.warn('модель каталога Qwen пропущена: id, подпись или повтор не той формы');
  }
  return models.length === 0 ? null : models;
}

/** Модели из файла как есть; файла нет или он не читается — `null`. */
async function storedModels(file: string): Promise<unknown> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(data) ? (data['models'] ?? null) : null;
  } catch {
    return null;
  }
}

/** Атомарная запись: временный файл рядом и `rename` — читатель видит старый или новый. */
async function writeCatalog(file: string, models: ModelOption[], at: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ fetchedAt: new Date(at).toISOString(), models }, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Заводит каталог: первая проба сразу, в фоне. Без пробы (`undefined` — тесты, `PARLEY_SKIP_VERSION_PROBE`) ничего не
 * запускается. Одна проба за раз: идущую делят все триггеры. Список, которого нет в файле, пишет файл и зовёт
 * `onChange`; сбой пробы файл не трогает. Срок считается от начала последней пробы.
 */
export function startQwenCatalog(
  probe: QwenModelsProbe | undefined,
  log: Log,
  onChange: () => void,
  options: { maxAgeMs?: number; now?: () => number } = {},
): QwenCatalog {
  const maxAgeMs = options.maxAgeMs ?? QWEN_CATALOG_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  // Дом известен на старте хоста: файл не переедет, даже если окружение потом сменится.
  const file = qwenModelsFile();
  let models: ModelOption[] | null = null;
  let written: string | undefined;
  let probedAt = 0;
  let inflight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    if (probe === undefined) return;
    probedAt = now();
    try {
      const raw = await probe(PROVIDERS['qwen']?.runner.command ?? 'qwen').catch(() => null);
      const next = raw === null || raw === undefined ? null : parseQwenModels(raw, log);
      if (next === null) {
        log.info('каталог Qwen не получен: проба не ответила, вход не выполнен или моделей нет');
        return;
      }
      models = next;
      written ??= JSON.stringify(await storedModels(file));
      const text = JSON.stringify(next);
      if (text === written) return;
      await writeCatalog(file, next, now());
      written = text;
      onChange();
    } catch (error) {
      log.error('каталог Qwen не записан', { error: String(error) });
    }
  };

  const refresh = (): Promise<void> => {
    if (probe === undefined) return Promise.resolve();
    if (inflight === null) {
      const current: Promise<void> = run().finally(() => {
        if (inflight === current) inflight = null;
      });
      inflight = current;
    }
    return inflight;
  };

  return {
    ready: refresh(),
    current: () => models,
    refreshIfStale() {
      if (probe === undefined || inflight !== null || now() - probedAt < maxAgeMs) return;
      void refresh();
    },
    refresh,
  };
}

interface ProbeOptions {
  timeoutMs?: number;
  maxBytes?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Где создаётся временный `cwd`; по умолчанию системный каталог. */
  tmpRoot?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Сигнал всей группе; `false` — группы уже нет. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Жив ли хоть один участник группы (сигнал 0). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ждёт, пока группа опустеет; `false` — не опустела за `ms`. */
async function waitGroupGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= until) return false;
    await sleep(25);
  }
  return true;
}

/** Конец пробы: stdin закрыт, группа получает SIGTERM, через `graceMs` — SIGKILL, трубы разрушены. Не бросает. */
async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
  try {
    child.stdin?.end();
  } catch {
    /* закрыт */
  }
  const pid = child.pid;
  if (pid !== undefined) {
    signalGroup(pid, 'SIGTERM');
    if (!(await waitGroupGone(pid, graceMs))) {
      signalGroup(pid, 'SIGKILL');
      await waitGroupGone(pid, 1000);
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

/** Обмен JSON-RPC построчно: `initialize`, затем `session/new`; результат — `availableModels` или `null`. */
function exchange(child: ChildProcess, cwd: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    let received = 0;
    let buffer = '';
    const finish = (value: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (id: number, method: string, params: unknown): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };
    const onLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return finish(null);
      }
      if (!isRecord(message) || typeof message['id'] !== 'number') return;
      if (message['error'] !== undefined) return finish(null);
      if (message['id'] === 1) return send(2, 'session/new', { cwd, mcpServers: [] });
      if (message['id'] === 2) {
        const result = message['result'];
        const models = isRecord(result) ? result['models'] : undefined;
        finish(isRecord(models) && Array.isArray(models['availableModels']) ? models['availableModels'] : null);
      }
    };
    child.once('error', () => finish(null));
    // Выход раньше ответа: ответ мог ещё лежать в трубе, поэтому не сразу.
    child.once('exit', () => setTimeout(() => finish(null), 100));
    child.stdin?.on('error', () => {});
    child.stderr?.on('data', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) return finish(null);
      buffer += chunk.toString('utf8');
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '' && !done) onLine(line);
      }
    });
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}

/**
 * Настоящая проба: `<команда> --acp` лидером своей группы, в пустом временном `cwd`. Не бросает: любой сбой — `null`.
 * Процесс и временный каталог убираются всегда, в `finally`.
 */
export async function probeQwenModels(command: string, options: ProbeOptions = {}): Promise<unknown> {
  const env = options.env ?? process.env;
  let cwd: string;
  try {
    cwd = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), 'parley-qwen-probe-'));
  } catch {
    return null;
  }
  let child: ChildProcess | undefined;
  try {
    child = spawn(commandBinary(command, env), ['--acp'], {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return await exchange(child, cwd, options.timeoutMs ?? QWEN_CATALOG_TIMEOUT_MS, options.maxBytes ?? QWEN_CATALOG_MAX_BYTES);
  } catch {
    return null;
  } finally {
    if (child !== undefined) await stopGroup(child, options.killGraceMs ?? QWEN_PROBE_KILL_GRACE_MS);
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
