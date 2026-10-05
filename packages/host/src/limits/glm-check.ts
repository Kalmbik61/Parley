/**
 * Исход последней явной проверки ключа Z.ai (`providers.check`): тестовое сообщение (`zai-check.ts`) по
 * Check again в карточке GLM и после сохранения ключа.
 *
 * Хост останавливается по простою и поднимается заново — одной памяти мало: «ключ отвергнут» должен
 * пережить перезапуск. Файл лежит в доме Parley рядом с секретом и не содержит ни ключа, ни намёка на
 * него: только sha256-отпечаток, по которому видно, что запись — о нынешнем ключе. Старт хоста сети не
 * трогает: файл читается лениво, а новая проверка идёт лишь по явному запросу окна.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { envValue, parleyHome } from '@parley/core';
import { PROVIDER_CHECK_REASONS, type ProviderCheck, type ProviderCheckReason } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { checkZaiKey, type ZaiCheckOutcome } from './zai-check.js';

/** Запись файла: публичный исход плюс отпечаток ключа, которым проверяли. */
export interface GlmCheckRecord extends ProviderCheck {
  keyFingerprint: string;
}

/** Файл в доме Parley; тесты подставляют свой путь. */
export function glmCheckFile(): string {
  return path.join(parleyHome(), 'glm-check.json');
}

const isReason = (value: unknown): value is ProviderCheckReason =>
  typeof value === 'string' && (PROVIDER_CHECK_REASONS as readonly string[]).includes(value);

const fingerprint = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Публичная часть записи: отпечаток ключа остаётся у хоста. */
function publicCheck(record: GlmCheckRecord): ProviderCheck {
  return {
    state: record.state,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus }),
    ...(record.code === undefined ? {} : { code: record.code }),
    at: record.at,
  };
}

/** Одинаков ли исход без времени: время той же проверки — не новость для окна. */
const sameOutcome = (a: ProviderCheck | null, b: ProviderCheck): boolean =>
  a !== null && a.state === b.state && a.reason === b.reason && a.httpStatus === b.httpStatus && a.code === b.code;

/** Чтение файла; битый, чужой или отсутствующий — «не проверяли» (`null`), без ошибки. */
export async function readGlmCheck(file = glmCheckFile()): Promise<GlmCheckRecord | null> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const { state, reason, httpStatus, code, at, keyFingerprint } = record;
  if (state !== 'ok' && state !== 'failed') return null;
  if (typeof at !== 'string' || at === '' || typeof keyFingerprint !== 'string' || keyFingerprint === '') return null;
  // Успех — без причины, отказ — только с причиной из закрытого списка.
  if (state === 'ok' ? reason !== undefined : !isReason(reason)) return null;
  if (httpStatus !== undefined && !(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) {
    return null;
  }
  if (code !== undefined && !(typeof code === 'string' && /^\d{1,8}$/u.test(code))) return null;
  return {
    state,
    ...(isReason(reason) ? { reason } : {}),
    ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    at,
    keyFingerprint,
  };
}

/** Атомарная запись, как у секретов: её читает следующий старт хоста. Отказ остаётся вызывающему. */
export async function writeGlmCheck(record: GlmCheckRecord, file = glmCheckFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(record, null, 2) + '\n', 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface GlmCheckOptions {
  /** Подмены тестов: сеть и часы. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Файл исхода; по умолчанию `glmCheckFile()`. */
  file?: string;
  /** Рычаг E2E окна (`PARLEY_GLM_CHECK_STUB`): исход без сети — E2E нельзя ходить в настоящий Z.ai. */
  stub?: ZaiCheckOutcome;
}

/**
 * Рычаг E2E: `PARLEY_GLM_CHECK_STUB` — `ok` или причина из закрытого списка (имя с префиксом `HARNAS_`
 * `envValue` понимает сам). Хост тогда ничего не отправляет и отдаёт этот исход, не записывая его на
 * диск; ключ никуда не уходит. Прочее значение рычага не даёт.
 */
export function glmCheckOptionsFromEnv(env: NodeJS.ProcessEnv): GlmCheckOptions | undefined {
  const raw = envValue(env, 'GLM_CHECK_STUB')?.trim();
  if (raw === 'ok') return { stub: { state: 'ok' } };
  if (isReason(raw)) return { stub: { state: 'failed', reason: raw } };
  return undefined;
}

export interface GlmCheckService {
  /** Исход последней проверки этого ключа; `null` — не проверяли, ключ с тех пор сменился или его нет. Без сети. */
  current(key: string | null): Promise<ProviderCheck | null>;
  /** Тестовое сообщение этим ключом; параллельные проверки одного ключа делят один запрос. Не отказывает. */
  run(key: string): Promise<ProviderCheck>;
  /**
   * Ключ сохранён заново или удалён: прежний исход забывается вместе с файлом, а ещё идущая проверка
   * своего исхода уже не запишет. Сбой удаления файла уходит в журнал.
   */
  forget(): Promise<void>;
}

export function createGlmCheckService(
  host: Pick<HostContext, 'log' | 'broadcast'>,
  options: GlmCheckOptions = {},
): GlmCheckService {
  const file = options.file ?? glmCheckFile();
  const now = options.now ?? Date.now;
  let stored: GlmCheckRecord | null = null;
  let loading: Promise<void> | null = null;
  const running = new Map<string, Promise<ProviderCheck>>();
  /**
   * Номер последней начатой проверки. Записывает исход только она: поздний ответ проверки прежнего
   * ключа (до 20 секунд, другое окно) не затрёт исход нового, а `forget` отменяет запись идущей.
   */
  let latest = 0;

  /** Сколько раз исход забывали: чтение файла, начатое до `forget`, не воскрешает забытый исход. */
  let forgets = 0;

  /**
   * Записи и удаления файла идут по очереди, в порядке решений: иначе запись, начатая до `forget`,
   * переименовала бы временный файл уже после удаления, и забытый исход вернулся бы на диск.
   */
  let disk: Promise<void> = Promise.resolve();
  const onDisk = (operation: () => Promise<void>, report: (error: unknown) => void): Promise<void> =>
    (disk = disk.then(operation).catch((error: unknown) => {
      // Исход уже случился: сбой диска не отменяет его, а только теряет до перезапуска. Журнал пишет
      // синхронно и сам может отказать — проверка, которая «не отказывает», от этого не падает.
      try {
        report(error);
      } catch {
        // Журнал недоступен — исход важнее строки о нём.
      }
    }));

  const load = (): Promise<void> => {
    const epoch = forgets;
    return (loading ??= readGlmCheck(file).then((record) => {
      // Проверка, закончившаяся раньше чтения, новее файла.
      if (epoch === forgets && stored === null) stored = record;
    }));
  };

  async function check(key: string, identity: string, generation: number): Promise<ProviderCheck> {
    await load();
    const outcome = options.stub ?? (await checkZaiKey(key, options));
    const result: ProviderCheck = { ...outcome, at: new Date(now()).toISOString() };
    try {
      host.log.info('проверка ключа GLM', {
        state: result.state,
        reason: result.reason ?? null,
        httpStatus: result.httpStatus ?? null,
        code: result.code ?? null,
        ...(options.stub === undefined ? {} : { stub: true }),
      });
    } catch {
      // Журнал пишет синхронно: его сбой не должен уронить проверку, которая «не отказывает».
    }
    // Ключ с тех пор сменили или удалили: этот исход — уже не о нынешнем ключе.
    if (generation !== latest) return result;
    const previous = stored !== null && stored.keyFingerprint === identity ? publicCheck(stored) : null;
    const record: GlmCheckRecord = { ...result, keyFingerprint: identity };
    stored = record;
    // Исход рычага E2E на диск не пишется: случайно оставленная переменная не должна пережить себя.
    if (options.stub === undefined) {
      await onDisk(
        () => writeGlmCheck(record, file),
        (error) => host.log.warn('исход проверки ключа GLM не записан на диск', { error: String(error) }),
      );
    }
    if (!sameOutcome(previous, result)) host.broadcast('providers.changed', { provider: 'glm' });
    return result;
  }

  return {
    async current(key) {
      if (key === null) return null;
      await load();
      return stored !== null && stored.keyFingerprint === fingerprint(key) ? publicCheck(stored) : null;
    },
    run(key) {
      const identity = fingerprint(key);
      const pending = running.get(identity);
      if (pending !== undefined) return pending;
      const promise = check(key, identity, ++latest).finally(() => {
        if (running.get(identity) === promise) running.delete(identity);
      });
      running.set(identity, promise);
      return promise;
    },
    async forget() {
      forgets += 1;
      latest += 1;
      running.clear();
      stored = null;
      // Файл больше не читаем: его содержимое — о прежнем ключе.
      loading = Promise.resolve();
      await onDisk(
        () => rm(file, { force: true }),
        (error) => host.log.warn('исход проверки ключа GLM не удалён с диска', { error: String(error) }),
      );
    },
  };
}
