/**
 * Лимиты подписок в хосте (спека комнат Organic, 3.5): последнее значение на провайдера и событие
 * `providers.limitsChanged`, когда оно изменилось. Источники:
 * - Claude Code (и другие провайдеры, кроме GLM, чей запуск несёт `--settings` работы) — файлы
 *   `limits/<сессия>.json` в каталогах работ, которые пишет скрипт строки статуса. Провайдер файла —
 *   провайдер сессии по карте работы, а не имя файла или его свежесть. GLM не получает лимиты
 *   claude.ai: строка статуса Claude Code не сообщает лимиты Z.ai. Файлы провайдера сводятся
 *   по окнам (`mergeLimits`), а не «берётся самый
 *   свежий по `at`»: простаивающая сессия со свежим `at` и прежними числами не должна перебить
 *   числа той, что работала;
 * - Codex — хвост самого свежего rollout-лога (`readCodexLimits`).
 * - GLM — только явный запрос обновления квоты с добровольно сохранённым ключом Z.ai.
 * Старт и таймер перечитывают CLI, не ходят в сеть и сохраняют последнюю квоту GLM.
 * Учётные данные Claude/Codex не читаются.
 *
 * Как хост узнаёт о новых данных — редкий опрос, раз в 30 секунд (`LIMITS_POLL_MS`), а не
 * наблюдение за каталогами. Файлов много: по каталогу `limits/` на каждую работу каждого проекта,
 * появляющиеся заново, и наблюдатель на каждый из них тянул бы за собой учёт проектов, как у
 * `works-service`; опрос — один `readdir` на работу и хвост одного лога Codex, а окну лимиты нужны
 * не мгновенно: они и у самого CLI обновляются только по ходу работы агента (окно показывает
 * `Updated {time}`). Опрос заодно снимает окна, чей сброс прошёл, без отдельного таймера. Рычаг
 * `intervalMs` — для E2E окна; в боевом хосте он не меняется.
 */

import { createHash } from 'node:crypto';
import {
  dropExpiredWindows,
  envValue,
  mergeLimits,
  readCodexLimits,
  readSecret,
  readWorkLimits,
  workPaths,
  type LimitWindow,
  type ProviderLimits,
} from '@parley/core';
import { readZaiQuota, ZaiQuotaError } from './zai-quota.js';
import type { HostContext } from '../context.js';
import type { WorksService } from '../works/works-service.js';

/** Как часто хост перечитывает лимиты: не чаще раза в 30 секунд. */
export const LIMITS_POLL_MS = 30_000;

export interface LimitsServiceOptions {
  /** Период опроса; по умолчанию `LIMITS_POLL_MS`. Меняют только тесты (E2E окна). */
  intervalMs?: number;
  /** Корень логов Codex; по умолчанию `defaultCodexRoot()` — `~/.codex/sessions`. */
  codexRoot?: string;
  /** Часы: по ним отбрасываются окна с прошедшим сбросом; тесты подставляют свои и не спят. */
  now?: () => number;
  /** Таймер опроса — возвращает отмену; тесты подставляют свой, без настоящего ожидания. */
  schedule?: (tick: () => void, everyMs: number) => () => void;
  /** Подмены тестов: реальные ключи и сеть не нужны. */
  readGlmKey?: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}

export interface LimitsService {
  /** Первое чтение и запуск опроса; не отказывает. */
  start(): Promise<void>;
  /** Лимиты провайдера сейчас; окна с прошедшим сбросом уже сняты, `null` — данных нет. */
  get(providerId: string): ProviderLimits | null;
  /** Перечитать CLI; includeGlm — явный запрос квоты. Параллельные запросы одного вида делят чтение. */
  refresh(includeGlm?: boolean): Promise<void>;
  /** Смена/удаление ключа немедленно снимает старую квоту и отменяет публикацию старого запроса. */
  invalidateGlm(): void;
  stop(): void;
}

/**
 * Пределы периода опроса из окружения, мс. Не чаще 200 мс: короче незачем и опасно для машины.
 * Не больше 2147483647: длиннее `setInterval` не умеет и срабатывал бы каждую миллисекунду.
 */
const MIN_POLL_MS = 200;
const MAX_POLL_MS = 2_147_483_647;

/**
 * Рычаг E2E окна: `PARLEY_LIMITS_POLL_MS` (и прежняя `HARNAS_LIMITS_POLL_MS`) — период опроса в миллисекундах, зажатый в
 * `[MIN_POLL_MS, MAX_POLL_MS]` (`1` даёт 200, `99999999999` — 2147483647). Нечисловое значение
 * (пусто, мусор, `NaN`, `Infinity`) рычага не даёт, и опрос идёт раз в 30 секунд: `setInterval` с
 * `NaN` крутился бы каждую миллисекунду.
 */
export function limitsOptionsFromEnv(env: NodeJS.ProcessEnv): LimitsServiceOptions | undefined {
  const raw = envValue(env, 'LIMITS_POLL_MS')?.trim();
  // Пустая строка — не число, хотя `Number('')` равно нулю.
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return { intervalMs: Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.trunc(value))) };
}

const defaultSchedule = (tick: () => void, everyMs: number): (() => void) => {
  const timer = setInterval(tick, everyMs);
  // Хост живёт клиентами и сессиями, а не этим таймером: он не должен удерживать процесс.
  timer.unref();
  return () => clearInterval(timer);
};

const sameWindow = (a: LimitWindow | null, b: LimitWindow | null): boolean =>
  a === null || b === null ? a === b : a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt;

/** Одинаковы ли лимиты: и числа, и время, когда CLI их отдал (окну важно `Updated {time}`). */
const sameLimits = (a: ProviderLimits | undefined, b: ProviderLimits | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.source === b.source && a.at === b.at && sameWindow(a.fiveHour, b.fiveHour) && sameWindow(a.week, b.week);

export function createLimitsService(
  host: HostContext,
  works: Pick<WorksService, 'snapshot'>,
  options: LimitsServiceOptions = {},
): LimitsService {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const intervalMs = options.intervalMs ?? LIMITS_POLL_MS;

  /** Лимиты по провайдерам на момент последнего чтения, без окон с прошедшим сбросом. */
  let state = new Map<string, ProviderLimits>();
  let inFlight: Promise<void> | null = null;
  let manualInFlight: Promise<void> | null = null;
  let cancelTimer: (() => void) | null = null;
  let stopped = false;
  let glmFingerprint: string | null = null;
  let glmGeneration = 0;
  const readGlmKey = options.readGlmKey ?? (() => readSecret('zai'));
  const fingerprint = (key: string | null): string | null => key === null ? null : createHash('sha256').update(key).digest('hex');

  function publish(next: Map<string, ProviderLimits>): void {
    if (stopped) return;
    const previous = state;
    state = next;
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      if (!sameLimits(previous.get(id), next.get(id))) host.broadcast('providers.limitsChanged', { id, limits: next.get(id) ?? null });
    }
  }

  function invalidateGlm(): void {
    ++glmGeneration;
    glmFingerprint = null;
    const next = new Map(state);
    next.delete('glm');
    publish(next);
  }

  async function refreshGlm(): Promise<void> {
    try {
      const key = await readGlmKey();
      if (stopped) return;
      const identity = fingerprint(key);
      if (identity !== glmFingerprint) {
        invalidateGlm();
        glmFingerprint = identity;
      }
      if (key === null) return;
      const generation = glmGeneration;
      let quota: ProviderLimits | null = null;
      let failure: ZaiQuotaError | null = null;
      try {
        quota = await readZaiQuota(key, { now, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
      } catch (error) {
        failure = error instanceof ZaiQuotaError ? error : new ZaiQuotaError();
      }
      // A rotation/removal outside our RPC is also detected before publishing or retaining data.
      const current = fingerprint(await readGlmKey());
      if (stopped || generation !== glmGeneration) return;
      if (current !== identity) {
        invalidateGlm();
        glmFingerprint = current;
        throw new ZaiQuotaError();
      }
      if (failure !== null) throw failure;
      const next = new Map(state);
      const live = dropExpiredWindows(quota, now());
      if (live === null) next.delete('glm');
      else next.set('glm', live);
      publish(next);
    } catch (error) {
      if (error instanceof ZaiQuotaError) throw error;
      throw new ZaiQuotaError();
    }
  }

  /** Свод на провайдера — из файлов всех работ и из лога Codex; окна сводятся по отдельности. */
  async function collect(): Promise<Map<string, ProviderLimits>> {
    const found = new Map<string, ProviderLimits[]>();
    const consider = (provider: string, limits: ProviderLimits): void => {
      const list = found.get(provider);
      if (list === undefined) found.set(provider, [limits]);
      else list.push(limits);
    };

    for (const entry of works.snapshot().entries) {
      const providers = new Map(
        entry.map.sessions.map((session) => [session.id, session.provider]),
      );
      const files = await readWorkLimits(workPaths(entry.projectPath, entry.map.work.id).dir);
      for (const [sessionId, limits] of files) {
        const provider = providers.get(sessionId);
        if (provider !== undefined && provider !== 'glm') consider(provider, limits);
      }
    }
    const codex = await readCodexLimits(options.codexRoot).catch(() => null);
    if (codex !== null) consider('codex', codex);

    const merged = new Map<string, ProviderLimits>();
    for (const [provider, list] of found) {
      const limits = mergeLimits(list);
      if (limits !== null) merged.set(provider, limits);
    }
    return merged;
  }

  async function read(): Promise<void> {
    try {
      const raw = await collect();
      const next = new Map<string, ProviderLimits>();
      for (const [id, limits] of raw) {
        const live = dropExpiredWindows(limits, now());
        if (live !== null) next.set(id, live);
      }
      const existingGlm = dropExpiredWindows(state.get('glm') ?? null, now());
      if (existingGlm !== null) next.set('glm', existingGlm);
      publish(next);
    } catch {
      host.log.warn('лимиты CLI не прочитаны');
    }
  }

  function refresh(includeGlm = false): Promise<void> {
    if (stopped) return Promise.resolve();
    if (includeGlm) {
      manualInFlight ??= Promise.allSettled([refresh(), refreshGlm()]).then((results) => {
        const glm = results[1];
        if (glm?.status === 'rejected' && !stopped) {
          throw glm.reason instanceof ZaiQuotaError ? glm.reason : new ZaiQuotaError();
        }
      }).finally(() => { manualInFlight = null; });
      return manualInFlight;
    }
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async start() {
      await refresh().catch(() => {});
      if (stopped) return;
      cancelTimer = schedule(() => void refresh().catch(() => {}), intervalMs);
    },
    // Окно могло сброситься между опросами: отбрасываем и при ответе, а не только при чтении.
    get: (providerId) => dropExpiredWindows(state.get(providerId) ?? null, now()),
    refresh,
    invalidateGlm,
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
