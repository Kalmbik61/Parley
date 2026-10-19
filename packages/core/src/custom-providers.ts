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
/** Версия Claude Code, на которой проверена изоляция папки (спека 6.1). */
export const CUSTOM_MIN_VERSION = '2.1.302';

export function isCustomProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX);
}

export interface CustomProviderRecord {
  id: string;
  label: string;
  preset: string | null;
  baseUrl: string;
  auth: 'bearer' | 'api-key';
  models: { opus: string; sonnet: string; haiku: string; subagent: string };
  contextWindow: number | null;
  linkClaude: boolean;
}

export function customProvidersFile(home = parleyHome()): string {
  return path.join(home, 'custom-providers.json');
}

export function customProviderDir(id: string, home = parleyHome()): string {
  return path.join(home, 'providers', id);
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

function asRecord(value: unknown): CustomProviderRecord | null {
  if (!isRecord(value) || !isRecord(value['models'])) return null;
  const models = value['models'];
  const { id, label, preset, baseUrl, auth, contextWindow, linkClaude } = value;
  if (!isText(id) || !isCustomProviderId(id) || !isText(label) || !isText(baseUrl)) return null;
  if (preset !== null && typeof preset !== 'string') return null;
  if (auth !== 'bearer' && auth !== 'api-key') return null;
  if (contextWindow !== null && (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow))) return null;
  if (typeof linkClaude !== 'boolean') return null;
  const { opus, sonnet, haiku, subagent } = models;
  if (!isText(opus) || !isText(sonnet) || !isText(haiku) || !isText(subagent)) return null;
  return {
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
export function customProviderEntry(record: CustomProviderRecord, home = parleyHome()): ProviderEntry {
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
    mark: record.label.slice(0, 2),
    hasHistory: true,
    linkBy: 'session-id',
    runner,
    models,
    custom: record,
  };
}
