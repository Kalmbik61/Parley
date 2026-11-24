/**
 * Лимиты подписки провайдера: общие типы и разбор того, что отдают сами CLI (спека комнат
 * Organic, раздел 3.5). Claude Code присылает `rate_limits` строке статуса, Codex пишет их
 * в лог сессии. Квота GLM приходит из отдельного хостового запроса к Z.ai.
 *
 * Модуль — лист без внутренних зависимостей: его тянет и скрипт строки статуса
 * (`work/statusline.ts`), а тот зовётся Claude Code часто, и лишний импорт там — лишние
 * миллисекунды на каждый вызов.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Окно лимита: сколько израсходовано и когда сбросится. */
export interface LimitWindow {
  /** 0–100; дробное бывает (`23.5`). */
  usedPercent: number;
  /** Когда окно сбросится, ISO 8601; null — источник не сообщает время. */
  resetsAt: string | null;
}

/** Лимиты одного провайдера: пятичасовое и недельное окна, каждое может отсутствовать. */
export interface ProviderLimits {
  fiveHour: LimitWindow | null;
  week: LimitWindow | null;
  /** Когда CLI отдал эти числа, ISO 8601: по нему хост выбирает самые свежие. */
  at: string;
  /**
   * Когда числа сессии в последний раз действительно изменились, ISO 8601 (пишет скрипт строки
   * статуса). Простаивающая сессия обновляет `at`, но не `changedAt`; нет поля (старые файлы,
   * Codex, Z.ai) — для сравнения берётся `at`.
   */
  changedAt?: string;
  /** Подтверждённая квота Z.ai, а не лимиты claude.ai из общей строки статуса. */
  source?: 'zai';
}

/** Каталог работы, куда скрипт строки статуса кладёт файл на сессию: `limits/<session-id>.json`. */
export const LIMITS_DIR = 'limits';

/** Файл лимитов сессии в каталоге работы (`PARLEY_WORK_DIR`). */
export const limitsFile = (workDir: string, sessionId: string): string =>
  path.join(workDir, LIMITS_DIR, `${sessionId}.json`);

/**
 * Годится ли id сессии в имя файла: без разделителей пути и без точки впереди. Id приходит
 * из окружения агента, поэтому скрипт строки статуса проверяет его, а не верит.
 */
export const isFileSafeId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Окно из пары «сколько израсходовано, когда сбросится (Unix-секунды)» — так их отдают и
 * Claude Code, и Codex. Чужая форма — `null`: полуразобранное окно хуже отсутствующего.
 * Процент прижимается к 0–100, чтобы полоска окна не вылезла за край.
 */
export function limitWindow(usedPercent: unknown, resetsAtSec: unknown): LimitWindow | null {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof resetsAtSec !== 'number' || !Number.isFinite(resetsAtSec)) return null;
  const resets = new Date(resetsAtSec * 1000);
  // `toISOString` на невозможной дате бросает, а не отдаёт `Invalid Date`.
  if (Number.isNaN(resets.getTime())) return null;
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: resets.toISOString(),
  };
}

/**
 * `rate_limits` из JSON строки статуса Claude Code: `five_hour` и `seven_day`, у каждого
 * `used_percentage` и `resets_at`. Окна приходят по отдельности; `spend_limit` шлюза —
 * не подписка, и его здесь нет. Ни одного окна — `null`.
 */
export function claudeLimits(
  rateLimits: unknown,
  at: string,
  changedAt?: string,
): ProviderLimits | null {
  if (!isRecord(rateLimits)) return null;
  const window = (key: string): LimitWindow | null => {
    const raw = rateLimits[key];
    return isRecord(raw) ? limitWindow(raw['used_percentage'], raw['resets_at']) : null;
  };
  const fiveHour = window('five_hour');
  const week = window('seven_day');
  return fiveHour === null && week === null
    ? null
    : { fiveHour, week, at, ...(changedAt === undefined ? {} : { changedAt }) };
}

/**
 * Файл сессии `{ at, changedAt?, rateLimits }`, как его пишет скрипт строки статуса: `rateLimits` — сырое
 * `rate_limits` из входа Claude Code. Файл пишет процесс агента, поэтому ему не доверяем:
 * битое — `null`, а не ошибка.
 */
export function parseLimitsFile(text: string): ProviderLimits | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data['at'] !== 'string') return null;
  const at = new Date(data['at']);
  if (Number.isNaN(at.getTime())) return null;
  // Битый `changedAt` — как отсутствующий: сравнение откатится на `at`.
  const changed = typeof data['changedAt'] === 'string' ? new Date(data['changedAt']) : null;
  const changedAt = changed === null || Number.isNaN(changed.getTime()) ? undefined : changed.toISOString();
  return claudeLimits(data['rateLimits'], at.toISOString(), changedAt);
}

/**
 * Лимиты из файлов строки статуса одной работы: id сессии → лимиты. Каталога нет или файл
 * битый — эта сессия просто без данных. Временные файлы записи (`*.tmp`) не читаются: скрипт
 * кладёт файл через `rename`, а читатель не должен видеть недописанное.
 */
export async function readWorkLimits(workDir: string): Promise<Map<string, ProviderLimits>> {
  const found = new Map<string, ProviderLimits>();
  const dir = path.join(workDir, LIMITS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let text: string;
    try {
      text = await readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const limits = parseLimitsFile(text);
    if (limits !== null) found.set(name.slice(0, -'.json'.length), limits);
  }
  return found;
}

/** Окно вместе с тем, откуда оно: когда сессия наблюдала эти числа и когда CLI их отдал. */
interface Observed {
  window: LimitWindow | null;
  /** `changedAt ?? at` записи: когда числа последний раз действительно менялись. */
  changed: string;
  at: string;
}

/**
 * Одно окно из двух наблюдений. Разный сброс — окно сменилось, берётся то, что кончается позже.
 * Один и тот же сброс — одно окно, и берётся то, чьи числа менялись позже: расход внутри окна
 * обычно не убывает, но вендор может сбросить его посреди окна, оставив `resets_at`, и тогда
 * большее `usedPercent` — устаревшее. Одинаковое время изменения — большее `usedPercent`.
 * Неизвестный сброс упорядочить нельзя: берётся последнее наблюдение по `at`.
 */
function laterWindow(a: Observed, b: Observed): Observed {
  if (a.window === null) return b.window === null ? a : b;
  if (b.window === null) return a;
  if (a.window.resetsAt === null || b.window.resetsAt === null) return b.at >= a.at ? b : a;
  const byReset = Date.parse(a.window.resetsAt) - Date.parse(b.window.resetsAt);
  if (byReset !== 0) return byReset > 0 ? a : b;
  // ISO с миллисекундами в UTC: строки сравниваются как времена.
  if (a.changed !== b.changed) return b.changed > a.changed ? b : a;
  return b.window.usedPercent > a.window.usedPercent ? b : a;
}

/**
 * Сводит лимиты нескольких сессий одного провайдера в одно значение. «Самое свежее по `at`» не
 * годится: простаивающую сессию Claude Code зовёт по другим поводам (смена режима, `/compact`) с
 * прежними числами, и её свежий `at` перебил бы числа той, что действительно работала. «Большее
 * `usedPercent`» тоже не годится: сброс лимита вендором посреди окна оставляет `resetsAt` и
 * снижает расход. Поэтому каждое окно сводится отдельно (`laterWindow`) по `changedAt`, а `at`
 * сводного значения — самое позднее из всех, `changedAt` — тоже. Пусто — `null`.
 */
export function mergeLimits(all: readonly ProviderLimits[]): ProviderLimits | null {
  const [first, ...rest] = all;
  if (first === undefined) return null;
  const observe = (limits: ProviderLimits, key: 'fiveHour' | 'week'): Observed => ({
    window: limits[key],
    changed: limits.changedAt ?? limits.at,
    at: limits.at,
  });
  const fold = (key: 'fiveHour' | 'week'): LimitWindow | null =>
    rest.reduce(
      (merged, next) => laterWindow(merged, observe(next, key)),
      observe(first, key),
    ).window;
  const at = all.reduce((latest, item) => (item.at > latest ? item.at : latest), first.at);
  const changedAt = all.reduce<string | undefined>((latest, item) => {
    const changed = item.changedAt ?? item.at;
    return latest === undefined || changed > latest ? changed : latest;
  }, undefined);
  const hasChanged = all.some((item) => item.changedAt !== undefined);
  return {
    fiveHour: fold('fiveHour'),
    week: fold('week'),
    at,
    ...(hasChanged && changedAt !== undefined ? { changedAt } : {}),
    ...(all.every((item) => item.source === 'zai') ? { source: 'zai' as const } : {}),
  };
}

/**
 * Окно, чей сброс уже прошёл, не отдаётся: за сбросом числа уже неверны. Прошли оба окна —
 * лимитов нет вовсе (`null`). Момент сброса считается прошедшим.
 */
export function dropExpiredWindows(
  limits: ProviderLimits | null,
  nowMs: number,
): ProviderLimits | null {
  if (limits === null) return null;
  const live = (window: LimitWindow | null): LimitWindow | null =>
    window !== null && (window.resetsAt === null || Date.parse(window.resetsAt) > nowMs) ? window : null;
  const fiveHour = live(limits.fiveHour);
  const week = live(limits.week);
  return fiveHour === null && week === null ? null : { ...limits, fiveHour, week };
}
