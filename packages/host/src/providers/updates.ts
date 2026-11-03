/**
 * Проверка новых версий CLI `codex` и `claude` раз в сутки (спека 2026-11-02, обновление CLI из Parley, T2).
 * Хост спрашивает публичный источник последней версии (`fetchLatestVersion` в core), кладёт ответ в
 * `<parleyHome>/cli-updates.json` и отдаёт `providers.list` как поле `update`. Проверка идёт в фоне со своим таймером
 * и ничего не задерживает: ни старт хоста, ни `providers.list`, ни запуск сессии. Без сети — тишина: в кэш пишется
 * только время проверки, прежняя `latest` не стирается.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  fetchLatestVersion,
  findRunnerBinary,
  installMethod,
  isNewer,
  parleyHome,
  userClaudeConfigDir,
  type CliUpdateProvider,
  type LatestVersionSource,
} from '@parley/core';
import type { Log } from '../log.js';

/** Что видит окно: новая версия, способ установки и когда спрашивали. */
export interface CliUpdateInfo {
  latest: string;
  method: string;
  checkedAt: string;
}

export interface CliUpdates {
  /** Первая проверка — в фоне, затем каждые 24 часа; таймер не держит процесс. */
  start(): void;
  /** Проверка сейчас; команды, спрошенные меньше 20 часов назад, пропускаются. Не бросает. */
  checkAll(): Promise<void>;
  /** Обновление для команды: `null`, если версия не новее установленной, её пропустили или проверки не было. */
  current(command: string, installed: string | null): Promise<CliUpdateInfo | null>;
  /** Последняя найденная версия как есть (даже пропущенная); `null` — проверки не было или сеть молчала. */
  latest(command: string): Promise<string | null>;
  /** Пропустить найденную версию; `false` — пропускать нечего. */
  skip(command: string): Promise<boolean>;
  stop(): void;
}

export interface CliUpdatesOptions {
  fetchImpl: typeof fetch;
  log: Pick<Log, 'warn'>;
  /** Папка Parley с `cli-updates.json`; по умолчанию `parleyHome()`. */
  home?: string;
  /** Домашняя папка человека: от неё считается способ установки и берутся пользовательские настройки Claude (только чтение). */
  userHome: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Видимое состояние команды изменилось (пришла новая версия). */
  onChange?: (command: UpdateCommand) => void;
}

export type UpdateCommand = CliUpdateProvider;
/** Команды реестра, у которых есть проверка; GLM и свои провайдеры показывают строку `claude`. */
export const UPDATE_COMMANDS: readonly UpdateCommand[] = ['codex', 'claude'];

export const CLI_UPDATE_MIN_AGE_MS = 20 * 60 * 60 * 1000;
export const CLI_UPDATE_PERIOD_MS = 24 * 60 * 60 * 1000;

interface Record_ {
  latest: string | null;
  checkedAt: string;
  method: string;
  skipped: string | null;
}
type Cache = Partial<Record<UpdateCommand, Record_>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readRecord(value: unknown): Record_ | null {
  if (!isObject(value)) return null;
  const { latest, checkedAt, method, skipped } = value;
  if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt)) || typeof method !== 'string') return null;
  if (latest !== null && typeof latest !== 'string') return null;
  if (skipped !== null && typeof skipped !== 'string') return null;
  return { latest, checkedAt, method, skipped };
}

/** Битый файл или запись не той формы — пустой кэш. */
async function loadCache(file: string): Promise<Cache> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    const providers = isObject(data) && data['version'] === 1 ? data['providers'] : undefined;
    if (!isObject(providers)) return {};
    const cache: Cache = {};
    for (const command of UPDATE_COMMANDS) {
      const record = readRecord(providers[command]);
      if (record !== null) cache[command] = record;
    }
    return cache;
  } catch {
    return {};
  }
}

/** Атомарная запись: временный файл рядом и `rename`. */
async function saveCache(file: string, cache: Cache): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, providers: cache }, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Канал Claude из пользовательских настроек (только чтение): `autoUpdatesChannel`, иначе `latest`. */
async function claudeChannel(userHome: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    // Папка настроек Claude человека — `CLAUDE_CONFIG_DIR` или `~/.claude`, как у самого Claude.
    const data: unknown = JSON.parse(await readFile(path.join(userClaudeConfigDir(env, userHome), 'settings.json'), 'utf8'));
    const channel = isObject(data) ? data['autoUpdatesChannel'] : undefined;
    return typeof channel === 'string' && channel !== '' ? channel : 'latest';
  } catch {
    return 'latest';
  }
}

export function createCliUpdates(options: CliUpdatesOptions): CliUpdates {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const file = path.join(options.home ?? parleyHome(), 'cli-updates.json');
  let cache: Promise<Cache> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let first: NodeJS.Immediate | undefined;

  const loaded = (): Promise<Cache> => (cache ??= loadCache(file));
  /** Изменения кэша идут по одному: чтение-правка-запись не перемешиваются. */
  const mutate = (change: (current: Cache) => boolean): Promise<void> => {
    const run = queue.then(async () => {
      const current = await loaded();
      if (change(current)) await saveCache(file, current);
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const checkOne = async (command: UpdateCommand): Promise<void> => {
    const before = (await loaded())[command];
    if (before !== undefined && now() - Date.parse(before.checkedAt) < CLI_UPDATE_MIN_AGE_MS) return;
    let method: string;
    try {
      // Тот же бинарь, что запускает Parley (с подменой `PARLEY_<КОМАНДА>_BIN`), без ссылок.
      const real = await realpath(await findRunnerBinary(command, env));
      // Домашняя папка тоже без ссылок: путь бинаря уже раскрыт, и сравниваться они должны в одном виде.
      const home = await realpath(options.userHome).catch(() => options.userHome);
      method = installMethod(command, real, home);
    } catch {
      return; // CLI не установлен — проверять нечего
    }
    const source: LatestVersionSource =
      command === 'claude'
        ? { kind: 'claude-npm', channel: await claudeChannel(options.userHome, env) }
        : method === 'brew'
          ? { kind: 'codex-brew' }
          : { kind: 'codex-github' };
    const latest = await fetchLatestVersion(source, options.fetchImpl);
    let changed = false;
    await mutate((current) => {
      const previous = current[command];
      current[command] =
        latest === null
          ? { latest: previous?.latest ?? null, checkedAt: new Date(now()).toISOString(), method: previous?.method ?? method, skipped: previous?.skipped ?? null }
          : { latest, checkedAt: new Date(now()).toISOString(), method, skipped: previous?.skipped ?? null };
      changed = latest !== null && latest !== previous?.latest;
      return true;
    });
    if (changed) options.onChange?.(command);
  };

  const checkAll = async (): Promise<void> => {
    await Promise.all(
      UPDATE_COMMANDS.map((command) =>
        checkOne(command).catch((error: unknown) => {
          options.log.warn('CLI update check failed', { command, error: String(error) });
        }),
      ),
    );
  };

  return {
    start() {
      if (timer !== undefined) return;
      first = setImmediate(() => void checkAll());
      timer = setInterval(() => void checkAll(), CLI_UPDATE_PERIOD_MS);
      timer.unref();
    },
    checkAll,
    async current(command, installed) {
      if (!UPDATE_COMMANDS.includes(command as UpdateCommand)) return null;
      const record = (await loaded())[command as UpdateCommand];
      if (record?.latest == null || installed === null) return null;
      if (record.skipped === record.latest || !isNewer(installed, record.latest)) return null;
      return { latest: record.latest, method: record.method, checkedAt: record.checkedAt };
    },
    async latest(command) {
      if (!UPDATE_COMMANDS.includes(command as UpdateCommand)) return null;
      return (await loaded())[command as UpdateCommand]?.latest ?? null;
    },
    async skip(command) {
      if (!UPDATE_COMMANDS.includes(command as UpdateCommand)) return false;
      let skipped = false;
      await mutate((current) => {
        const record = current[command as UpdateCommand];
        if (record?.latest == null) return false;
        record.skipped = record.latest;
        skipped = true;
        return true;
      });
      return skipped;
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      if (first !== undefined) clearImmediate(first);
      timer = undefined;
      first = undefined;
    },
  };
}
