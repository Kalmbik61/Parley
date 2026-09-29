/**
 * Лимиты подписки провайдера: общие типы и разбор того, что отдают сами CLI (спека комнат
 * Organic, раздел 3.5). Учётные данные не читаются и к API никто не ходит: Claude Code сам
 * присылает `rate_limits` строке статуса, Codex сам пишет их в лог сессии.
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
  /** Когда окно сбросится, ISO 8601. */
  resetsAt: string;
}

/** Лимиты одного провайдера: пятичасовое и недельное окна, каждое может отсутствовать. */
export interface ProviderLimits {
  fiveHour: LimitWindow | null;
  week: LimitWindow | null;
  /** Когда CLI отдал эти числа, ISO 8601: по нему хост выбирает самые свежие. */
  at: string;
}

/** Каталог работы, куда скрипт строки статуса кладёт файл на сессию: `limits/<session-id>.json`. */
export const LIMITS_DIR = 'limits';

/** Файл лимитов сессии в каталоге работы (`HARNAS_WORK_DIR`). */
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
export function claudeLimits(rateLimits: unknown, at: string): ProviderLimits | null {
  if (!isRecord(rateLimits)) return null;
  const window = (key: string): LimitWindow | null => {
    const raw = rateLimits[key];
    return isRecord(raw) ? limitWindow(raw['used_percentage'], raw['resets_at']) : null;
  };
  const fiveHour = window('five_hour');
  const week = window('seven_day');
  return fiveHour === null && week === null ? null : { fiveHour, week, at };
}

/**
 * Файл сессии `{ at, rateLimits }`, как его пишет скрипт строки статуса: `rateLimits` — сырое
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
  return claudeLimits(data['rateLimits'], at.toISOString());
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
    window !== null && Date.parse(window.resetsAt) > nowMs ? window : null;
  const fiveHour = live(limits.fiveHour);
  const week = live(limits.week);
  return fiveHour === null && week === null ? null : { fiveHour, week, at: limits.at };
}
