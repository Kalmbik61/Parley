/**
 * Каталог моделей Codex от самого CLI (спека нормалайзера, 5.2): `codex debug models` печатает каталог аккаунта —
 * модели, их подписи и уровни effort. Проба идёт на старте хоста и повторяется в фоне, когда `providers.list`
 * застаёт каталог старше шести часов. Удачная проба со списком, которого ещё нет в файле, атомарно переписывает
 * файл Parley `codex-models.json` (`codexModelsFile` в core) и зовёт `onChange`. Файл читает `loadProviders`, поэтому
 * окно, хост и MCP-сервер агента (отдельный процесс) видят один список. Сбой пробы файл не трогает: остаётся
 * прежний каталог, а без файла действует встроенный `CODEX_MODELS` из core.
 *
 * Рамка: это команда самого CLI, как проба `--version` (`versions.ts`). Parley не читает ни ключей, ни файлов
 * входа и сам в API не ходит: каталог забирает Codex под входом человека. Запускается то, что стоит у человека в
 * PATH (или подмена `PARLEY_<КОМАНДА>_BIN`, как при запуске сессии), и никогда — без таймаута и предела вывода.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  codexModelsFile,
  commandBinary,
  EFFORT_DESCRIPTION_MAX,
  EFFORT_TOKEN,
  effortLabel,
  loadProviders,
  MODEL_LABEL_MAX,
  type EffortOption,
  type ModelOption,
} from '@parley/core';
import type { Log } from '../log.js';

/** Одна проба: stdout `<команда> debug models`; `null` — ненулевой выход, таймаут, предел вывода или нет бинаря. */
export type CatalogProbe = (command: string) => Promise<string | null>;

export interface CodexCatalog {
  /** Первая проба завершена, успехом или нет; не отказывает. */
  ready: Promise<void>;
  /** Модели последней удачной пробы в порядке Codex; `null` — удачной пробы ещё не было. */
  current(): ModelOption[] | null;
  /** Каталог старше срока и проба не идёт — новая проба в фоне; новый список — в файл и `onChange`. */
  refreshIfStale(): void;
}

/** Срок каталога (спека 5.2): старше — `providers.list` просит пробу заново. */
export const CODEX_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Таймаут пробы: Codex отвечает примерно за 2 с, но перед ответом сам скачивает каталог. */
export const CODEX_CATALOG_TIMEOUT_MS = 15_000;
/** Предел вывода: настоящий каталог на 2026-10-06 — около 600 КБ. */
export const CODEX_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

/** `--model`: одно слово, не с дефиса, не длиннее 200 знаков — правило id модели core (`modelChoiceError`). */
const MODEL_ID = /^[^\s-]\S*$/;
const MODEL_ID_MAX_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Порядок Codex — `priority` по возрастанию; запись без числа уходит в конец. */
const priorityOf = (model: Record<string, unknown>): number =>
  typeof model['priority'] === 'number' ? model['priority'] : Number.MAX_SAFE_INTEGER;

/**
 * Модель каталога для окна; `null` — запись не годится: id не того вида (стал бы флагом или двумя аргументами
 * `--model`), нет подписи, уровень не проходит `EFFORT_TOKEN` (значение встаёт и в argv, и в кавычки TOML
 * `model_reasoning_effort="…"`) или повторяется. Подпись и описания длиннее пределов core обрезаются.
 */
function modelOf(model: Record<string, unknown>): ModelOption | null {
  const slug = model['slug'];
  const label = model['display_name'];
  const levels = model['supported_reasoning_levels'];
  if (
    typeof slug !== 'string' ||
    slug.length > MODEL_ID_MAX_LENGTH ||
    !MODEL_ID.test(slug) ||
    typeof label !== 'string' ||
    label === '' ||
    !Array.isArray(levels)
  ) {
    return null;
  }
  const efforts: EffortOption[] = [];
  for (const level of levels) {
    const id = isRecord(level) ? level['effort'] : undefined;
    const description = isRecord(level) ? level['description'] : undefined;
    if (typeof id !== 'string' || !EFFORT_TOKEN.test(id) || efforts.some((known) => known.id === id)) return null;
    efforts.push({
      id,
      label: effortLabel(id),
      ...(typeof description === 'string' ? { description: description.slice(0, EFFORT_DESCRIPTION_MAX) } : {}),
    });
  }
  // Уровней нет — effort у модели нет, как у Haiku.
  return { id: slug, label: label.slice(0, MODEL_LABEL_MAX), efforts: efforts.length === 0 ? null : efforts };
}

/**
 * Разбор вывода `{"models":[…]}`: модели с `visibility: "list"` в порядке `priority`; `id` — `slug`, подпись —
 * `display_name`, уровни — `supported_reasoning_levels` (`effort` → `id`, описание как есть). Запись не той формы
 * и повтор `slug` выбрасываются с предупреждением, прочие поля каталога не читаются. `null` — не JSON, не та форма
 * или видимых моделей не осталось.
 */
export function parseCodexCatalog(stdout: string, log?: Pick<Log, 'warn'>): ModelOption[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = isRecord(data) ? data['models'] : undefined;
  if (!Array.isArray(list)) return null;
  const visible = list
    .filter(isRecord)
    .filter((model) => model['visibility'] === 'list')
    .sort((a, b) => priorityOf(a) - priorityOf(b));
  const models: ModelOption[] = [];
  for (const model of visible) {
    const option = modelOf(model);
    if (option !== null && !models.some((known) => known.id === option.id)) {
      models.push(option);
      continue;
    }
    // Вызов журнала прямой: страж английских текстов узнаёт строку журнала по `log.warn(…)`, а не по `log?.warn`.
    if (log !== undefined) {
      log.warn('модель каталога Codex пропущена: id, подпись или уровень не той формы либо повтор', {
        slug: String(model['slug']),
      });
    }
  }
  return models.length === 0 ? null : models;
}

/**
 * Проба по команде записи `codex` реестра (свой `command` из `providers.json` тоже в силе). Не бросает: сбой —
 * `null` и предупреждение в журнал.
 */
async function probeOnce(probe: CatalogProbe, log: Log): Promise<ModelOption[] | null> {
  let command: string | undefined;
  try {
    command = (await loadProviders())['codex']?.runner.command;
  } catch (error) {
    log.warn('каталог Codex не пробуется: реестр провайдеров не читается', { error: String(error) });
    return null;
  }
  if (command === undefined) return null;
  const stdout = await probe(command).catch(() => null);
  const models = stdout === null ? null : parseCodexCatalog(stdout, log);
  if (models === null) {
    log.warn('каталог Codex не получен: проба не ответила, вывод не JSON или видимых моделей нет', { command });
  }
  return models;
}

/** Модели из файла каталога как есть; файла нет или он не читается — `null`. */
async function storedModels(file: string): Promise<unknown> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(data) ? (data['models'] ?? null) : null;
  } catch {
    return null;
  }
}

/** Атомарная запись, как у проверки ключа GLM: временный файл рядом и `rename` — читатель видит старый или новый. */
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
 * Заводит каталог: первая проба сразу, в фоне. Без пробы (`undefined` — тесты, `PARLEY_SKIP_VERSION_PROBE`)
 * ничего не запускается и файл не трогается. Удачная проба со списком, которого нет в файле, пишет файл и зовёт
 * `onChange`; неудачная прежний файл не трогает. Файл хост читает один раз, при первой удачной пробе: дальше его
 * пишет только этот каталог. Срок считается от начала последней пробы, удачной или нет.
 */
export function startCodexCatalog(
  probe: CatalogProbe | undefined,
  log: Log,
  onChange: () => void,
  options: { maxAgeMs?: number; now?: () => number } = {},
): CodexCatalog {
  const maxAgeMs = options.maxAgeMs ?? CODEX_CATALOG_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  // Дом известен на старте хоста: файл не переедет, даже если окружение потом сменится (тесты гоняют хосты подряд).
  const file = codexModelsFile();
  let models: ModelOption[] | null = null;
  /** Список из файла (JSON); `undefined` — файл ещё не читали. */
  let written: string | undefined;
  let probedAt = 0;
  let running = false;

  const run = async (): Promise<void> => {
    if (probe === undefined) return;
    running = true;
    probedAt = now();
    try {
      const next = await probeOnce(probe, log);
      if (next === null) return;
      models = next;
      written ??= JSON.stringify(await storedModels(file));
      const text = JSON.stringify(next);
      if (text === written) return;
      await writeCatalog(file, next, now());
      written = text;
      onChange();
    } catch (error) {
      log.error('каталог Codex не записан', { error: String(error) });
    } finally {
      running = false;
    }
  };

  return {
    ready: run(),
    current: () => models,
    refreshIfStale() {
      if (probe === undefined || running || now() - probedAt < maxAgeMs) return;
      void run();
    },
  };
}

/**
 * Настоящая проба: `<команда> debug models` с подменой `PARLEY_<КОМАНДА>_BIN`, как у пробы версии
 * (`probeCliVersion` в core). Зависший бинарь убивается по таймауту, вывод сверх предела — тоже.
 */
export function probeCodexCatalog(
  command: string,
  timeoutMs = CODEX_CATALOG_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      commandBinary(command, env),
      ['debug', 'models'],
      { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: CODEX_CATALOG_MAX_BYTES, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}
