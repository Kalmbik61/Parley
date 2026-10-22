/**
 * Свои провайдеры: описание в `~/.parley/custom-providers.json` (без ключа) и превращение записи в `ProviderEntry`
 * семейства Claude Code (спека своих провайдеров 2026-10-17, разделы 5.1–5.3). Запись похожа на встроенный GLM, но
 * живёт в своей `CLAUDE_CONFIG_DIR` (`~/.parley/providers/<id>/`), а ключ лежит в файле секретов Parley под `custom:<id>`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_EFFORTS, type ModelOption } from './provider-models.js';
import { PROVIDERS, type ProviderEntry, type RunnerConfig } from './providers.js';
import type { SecretId } from './secrets.js';
import { parleyHome } from './work/store.js';

/** Префикс объявлен здесь заново: ядро не импортирует протокол, равенство с ним проверяет задача 9 плана. */
export const CUSTOM_PROVIDER_PREFIX = 'custom-';
/** Префикс аккаунтов Codex (спека подписок 5.1, К8); объявлен заново по той же причине. */
export const CODEX_ACCOUNT_PREFIX = 'codex-';
/** Версия Claude Code, на которой проверена изоляция папки (спека 6.1). */
export const CUSTOM_MIN_VERSION = '2.1.302';
/**
 * Старейшая версия Claude Code, на которой проверены `claude auth login/status/logout` и вход в своей папке
 * (спека подписок 9.1, решение 3: 2.1.302–2.1.303 в проверке не участвовали).
 */
export const ACCOUNT_MIN_VERSION_CLAUDE = '2.1.304';

export function isCustomProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/** Оба префикса, которыми владеет окно: `custom-` (свои провайдеры и аккаунты Claude) и `codex-` (аккаунты Codex). */
export function isManagedProviderId(id: string): boolean {
  return isCustomProviderId(id) || id.startsWith(CODEX_ACCOUNT_PREFIX);
}

/**
 * Строгий формат id (спека 5.1, 7): id становится именем папки и частью секрета, поэтому без `/`, `..` и пробелов.
 * Принимает оба префикса (спека подписок 5.1, К8); кто из них у какой записи — решает `asRecord` по `kind`.
 */
const CUSTOM_ID_PATTERN = /^(?:custom|codex)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidCustomProviderId(id: string): boolean {
  return id.length <= 40 && CUSTOM_ID_PATTERN.test(id);
}

/** Свой провайдер с адресом и ключом (спека своих провайдеров 5.1). */
export interface CustomEndpointRecord {
  /** Хост пишет его явно; нет поля (файл до подписок, тесты) — это `endpoint`, миграции нет (спека подписок 5.1). */
  kind?: 'endpoint';
  id: string;
  label: string;
  preset: string | null;
  baseUrl: string;
  auth: 'bearer' | 'api-key';
  models: { opus: string; sonnet: string; haiku: string; subagent: string };
  contextWindow: number | null;
  linkClaude: boolean;
}

/** Ещё один аккаунт Claude Code или Codex того же человека: ни адреса, ни ключа (спека подписок 5.1). */
export interface CustomAccountRecord {
  kind: 'claude-account' | 'codex-account';
  id: string;
  /** Пустая строка — стандартное имя (`accountLabel`). */
  label: string;
  /** «Bring from …»: ссылки на общее из папки человека (у `endpoint` это `linkClaude`). */
  link: boolean;
}

export type CustomProviderRecord = CustomEndpointRecord | CustomAccountRecord;

export function isAccountRecord(record: CustomProviderRecord): record is CustomAccountRecord {
  return record.kind === 'claude-account' || record.kind === 'codex-account';
}

export function customProvidersFile(home = parleyHome()): string {
  return path.join(home, 'custom-providers.json');
}

export function customProviderDir(id: string, home = parleyHome()): string {
  const result = path.join(home, 'providers', id);
  // Защита от выхода из `<home>/providers` (спека 7): папку провайдера потом засевают и удаляют.
  if (!isValidCustomProviderId(id) || path.dirname(result) !== path.join(home, 'providers')) {
    throw new Error(`Invalid custom provider id: ${id}`);
  }
  return result;
}

export function customProviderSecret(id: string): SecretId {
  return `custom:${id}`;
}

/** Латинский slug для id: `custom-` + до 24 символов `[a-z0-9-]`; занято — `-2`, `-3`, … */
export function slugProviderId(label: string, taken: ReadonlySet<string>): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'provider';
  const base = `${CUSTOM_PROVIDER_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isLoopbackUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** `https:`, либо `http:` только для loopback; без логина и пароля, `?` и `#` (спека 5.1, 7). */
export function baseUrlError(url: string): string | null {
  if (url !== url.trim() || /\s/.test(url)) return 'The address must not contain spaces';
  const parsed = parseUrl(url);
  if (parsed === null) return 'Enter a full address, for example https://api.example.com/anthropic';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    return 'The address must start with https:// (http:// is allowed only for localhost)';
  }
  if (parsed.username !== '' || parsed.password !== '') return 'The address must not contain a login or password';
  if (url.includes('?') || url.includes('#')) return 'The address must not contain ? or #';
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
// Слот модели: одно слово, не с дефиса — как в схеме протокола (иначе уйдёт в `--model` флагом).
const isModelSlot = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^[^\s-]\S*$/.test(value);

/** Метка аккаунта: пустая — стандартное имя, иначе как у `endpoint` (не пробелы, до 40 символов). */
const isAccountLabel = (value: unknown): value is string =>
  typeof value === 'string' && (value === '' || (value.trim() !== '' && value.trim().length <= 40));

/**
 * Запись без `kind` — `endpoint`, миграции нет (спека подписок 5.1). У аккаунта поля адреса и ключа не читаются
 * и не сохраняются; префикс id сходится с `kind`: `custom-` у Claude, `codex-` у Codex (К8).
 */
function asRecord(value: unknown): CustomProviderRecord | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (kind === 'claude-account' || kind === 'codex-account') return asAccountRecord(value, kind);
  return kind === undefined || kind === 'endpoint' ? asEndpointRecord(value) : null;
}

function asAccountRecord(value: Record<string, unknown>, kind: CustomAccountRecord['kind']): CustomAccountRecord | null {
  const { id, label, link } = value;
  if (!isText(id) || !isValidCustomProviderId(id) || !isAccountLabel(label) || typeof link !== 'boolean') return null;
  const prefix = kind === 'claude-account' ? CUSTOM_PROVIDER_PREFIX : CODEX_ACCOUNT_PREFIX;
  return id.startsWith(prefix) ? { kind, id, label, link } : null;
}

function asEndpointRecord(value: Record<string, unknown>): CustomEndpointRecord | null {
  if (!isRecord(value['models'])) return null;
  const models = value['models'];
  const { id, label, preset, baseUrl, auth, contextWindow, linkClaude } = value;
  if (!isText(id) || !isCustomProviderId(id) || !isValidCustomProviderId(id) || !isText(label) || !isText(baseUrl)) return null;
  if (label.trim() === '' || label.trim().length > 40 || baseUrlError(baseUrl) !== null) return null;
  if (preset !== null && typeof preset !== 'string') return null;
  if (auth !== 'bearer' && auth !== 'api-key') return null;
  if (contextWindow !== null && !(typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0)) return null;
  if (typeof linkClaude !== 'boolean') return null;
  const { opus, sonnet, haiku, subagent } = models;
  if (!isModelSlot(opus) || !isModelSlot(sonnet) || !isModelSlot(haiku) || !isModelSlot(subagent)) return null;
  return {
    kind: 'endpoint',
    id,
    label,
    preset,
    baseUrl,
    auth,
    models: { opus, sonnet, haiku, subagent },
    contextWindow,
    linkClaude,
  };
}

/** Нет файла или битый JSON — пусто; неверная запись пропускается, остальные живут. */
export async function readCustomProviders(file = customProvidersFile()): Promise<CustomProviderRecord[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(data) || !Array.isArray(data['providers'])) return [];
  return data['providers'].flatMap((item) => {
    const record = asRecord(item);
    return record === null ? [] : [record];
  });
}

/** Атомарно: временный файл с uuid и `rename`, как `writeStore` в `secrets.ts`. */
export async function writeCustomProviders(
  records: readonly CustomProviderRecord[],
  file = customProvidersFile(),
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, providers: records }, null, 2) + '\n', 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Запись → `ProviderEntry` по раннеру GLM (спека 5.2); окружение без ключа, ключ добавляет `providerLaunchEnv`. */
export function customProviderEntry(record: CustomEndpointRecord, home = parleyHome()): ProviderEntry {
  const glm = PROVIDERS['glm'].runner;
  const { opus, sonnet, haiku, subagent } = record.models;
  const runner: RunnerConfig = {
    command: 'claude',
    configDir: customProviderDir(record.id, home),
    secret: customProviderSecret(record.id),
    auth: record.auth,
    minVersion: CUSTOM_MIN_VERSION,
    settingsModel: sonnet,
    env: {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_BASE_URL: record.baseUrl,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
      ANTHROPIC_DEFAULT_FABLE_MODEL: opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
      CLAUDE_CODE_SUBAGENT_MODEL: subagent,
      ...(record.contextWindow === null ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(record.contextWindow) }),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      API_TIMEOUT_MS: '3000000',
    },
    ...(isLoopbackUrl(record.baseUrl) ? { keyOptional: true as const } : {}),
    ...(glm.args === undefined ? {} : { args: [...glm.args] }),
    ...(glm.resumeArgs === undefined ? {} : { resumeArgs: [...glm.resumeArgs] }),
    ...(glm.printArgs === undefined ? {} : { printArgs: [...glm.printArgs] }),
    ...(glm.assistantArgs === undefined ? {} : { assistantArgs: [...glm.assistantArgs] }),
    ...(glm.assistantResumeArgs === undefined ? {} : { assistantResumeArgs: [...glm.assistantResumeArgs] }),
    ...(glm.mcpConfig === undefined ? {} : { mcpConfig: glm.mcpConfig }),
  };
  const ids = [...new Set([sonnet, opus, haiku])];
  const models: ModelOption[] = ids.map((id) => ({ id, label: id, efforts: CLAUDE_EFFORTS }));
  return {
    id: record.id,
    family: 'claude',
    label: record.label,
    mark: [...record.label].slice(0, 2).join(''),
    hasHistory: true,
    linkBy: 'session-id',
    runner,
    models,
    custom: record,
  };
}

const ACCOUNT_BASE_NAME = { 'claude-account': 'Claude Code', 'codex-account': 'Codex' } as const;

/**
 * Стандартное имя следующего аккаунта: глобальный живёт без номера (К1), добавленные — «Claude Code 2», «Codex 2», …
 * Номер — число аккаунтов этого CLI в `records` плюс 2; `endpoint` и аккаунты другого CLI не считаются.
 */
export function defaultAccountLabel(kind: CustomAccountRecord['kind'], records: readonly CustomProviderRecord[]): string {
  return `${ACCOUNT_BASE_NAME[kind]} ${records.filter((record) => record.kind === kind).length + 2}`;
}

/**
 * Id нового аккаунта (спека подписок 5.1): `custom-claude-2`, `custom-claude-3`, … (у Codex `codex-codex-2`) — первый
 * свободный в `taken`. Имя в id не входит: оно меняется, а id и папка аккаунта нет.
 */
export function defaultAccountSlug(kind: CustomAccountRecord['kind'], taken: ReadonlySet<string>): string {
  const base = kind === 'claude-account' ? `${CUSTOM_PROVIDER_PREFIX}claude` : `${CODEX_ACCOUNT_PREFIX}codex`;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Имя аккаунта: своё или стандартное (спека подписок 5.9, одно место вычисления). Если запись есть в `records`,
 * считаются только аккаунты до неё — тогда её номер не меняется, когда появляются следующие; новой записи
 * (в списке её ещё нет) достаётся номер за всеми.
 */
export function accountLabel(record: CustomAccountRecord, records: readonly CustomProviderRecord[]): string {
  if (record.label !== '') return record.label;
  const at = records.findIndex((item) => item.id === record.id);
  return defaultAccountLabel(record.kind, at === -1 ? records : records.slice(0, at));
}

/**
 * Запись аккаунта → `ProviderEntry` (спека подписок 5.2). Раннер — копия записи `claude` из реестра после
 * `providers.json` (К11): те же флаги, модели и переопределения человека. Своя `CLAUDE_CONFIG_DIR` и
 * `minVersion`; ни ключа, ни адреса, ни `env` (К12): вход лежит в самой папке, состояние даёт CLI.
 * Номер стандартного имени считается по аккаунтам, которые уже в `registry`.
 */
export function accountProviderEntry(
  record: CustomAccountRecord,
  registry: Readonly<Record<string, ProviderEntry>>,
  home = parleyHome(),
): ProviderEntry {
  // Этап 3 заменяет это ветвлением по семейству: раннер копируется из записи `codex`.
  if (record.kind !== 'claude-account') throw new Error('codex accounts arrive in stage 3');
  const claude = registry['claude'];
  if (claude === undefined) throw new Error('the claude provider is missing from the registry');
  const base = claude.runner;
  const runner: RunnerConfig = {
    command: base.command,
    configDir: customProviderDir(record.id, home),
    minVersion: ACCOUNT_MIN_VERSION_CLAUDE,
    ...(base.settingsModel === undefined ? {} : { settingsModel: base.settingsModel }),
    ...(base.args === undefined ? {} : { args: [...base.args] }),
    ...(base.resumeArgs === undefined ? {} : { resumeArgs: [...base.resumeArgs] }),
    ...(base.printArgs === undefined ? {} : { printArgs: [...base.printArgs] }),
    ...(base.assistantArgs === undefined ? {} : { assistantArgs: [...base.assistantArgs] }),
    ...(base.assistantResumeArgs === undefined ? {} : { assistantResumeArgs: [...base.assistantResumeArgs] }),
    ...(base.mcpConfig === undefined ? {} : { mcpConfig: base.mcpConfig }),
  };
  const label = accountLabel(
    record,
    Object.values(registry).flatMap((entry) => (entry.account === undefined ? [] : [entry.account])),
  );
  return {
    id: record.id,
    family: 'claude',
    label,
    mark: [...label].slice(0, 2).join(''),
    hasHistory: true,
    linkBy: 'session-id',
    runner,
    ...(claude.models === undefined ? {} : { models: claude.models }),
    // Шаблон запуска человек переопределил в providers.json — подсказка в карточке аккаунта следует за ним (К11).
    ...(claude.argsOverridden === undefined ? {} : { argsOverridden: true as const }),
    account: record,
  };
}
