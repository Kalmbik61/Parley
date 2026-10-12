/**
 * Застрявшие сессии: чего сессия ждёт от человека (`SessionNeed`), разбор ошибок API Claude и Codex и
 * времени сброса лимита (спека «Застрявшие сессии», 3.1–3.4). Модуль чистый: ни диска, ни часов — записи,
 * «сейчас» и пояс приходят параметрами. Свёртка активности и хост берут отсюда типы и разбор, поэтому сам
 * модуль ничего из `activity.ts` не тянет: цикла нет.
 */

import type { ProviderLimits } from '../limits.js';

/** Что нужно от человека: одобрение, ответ на вопрос, сброс лимита, вход или экран при старте. */
export type NeedKind = 'approval' | 'question' | 'limit' | 'sign-in' | 'startup';

export interface SessionNeed {
  kind: NeedKind;
  /** Начало эпизода (ISO). */
  since: string;
  /** Команда, файл, текст вопроса или ошибки — до `NEED_DETAIL_MAX` знаков; null — нечего показать. */
  detail: string | null;
  /** Только `limit`: время сброса (ISO); null — неизвестно (3.4). */
  resetsAt: string | null;
  /** Только `limit`: окно, если известно из текста или данных провайдера. */
  window: 'session' | 'week' | null;
  /** Только `sign-in`: `account` — аккаунт или оплата (on hold, billing), `auth` — вход. */
  account: 'auth' | 'account' | null;
}

/** Длина `detail`, знаков вместе с `…` (3.1). */
export const NEED_DETAIL_MAX = 200;
/** Сколько `approval` и `question` должны длиться, прежде чем о них узнают карта, лента и ведущий (3.5). */
export const STUCK_REPORT_MS = 120_000;
/** Запас после времени сброса, прежде чем Parley вернёт сессию сам: Claude мог продолжить без него (6.3). */
export const LIMIT_RETURN_GRACE_MS = 120_000;
/** Через сколько после удара вернуть сессию, если время сброса неизвестно (6.3). */
export const LIMIT_RETRY_MS = 900_000;
/** Сколько автовозвратов подряд допустимо, дальше — уведомление человеку (6.3). */
export const LIMIT_RETURNS_MAX = 2;

/**
 * Строка без переводов строк и лишних пробелов, не длиннее `NEED_DETAIL_MAX` знаков (обрезанная кончается
 * `…`); пустая — `null`.
 */
export function clampDetail(text: string | null | undefined): string | null {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (line === '') return null;
  if (line.length <= NEED_DETAIL_MAX) return line;
  // Половинка эмодзи перед `…` — мусорный знак в уведомлении, поэтому обрывок пары отбрасывается.
  const cut = line.slice(0, NEED_DETAIL_MAX - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.trimEnd()}…`;
}

export interface ApiFailure {
  kind: 'limit' | 'sign-in';
  account: 'auth' | 'account' | null;
}

/**
 * `error` хука `StopFailure` или записи журнала Claude: `rate_limit` — лимит; `authentication_failed` и
 * `oauth_org_not_allowed` — вход (`auth`); `account_on_hold` и `billing_error` — аккаунт или оплата
 * (`account`). Прочее (`server_error`, `invalid_request`…) — не повод звать человека: `null`.
 */
export function classifyClaudeFailure(error: string | null): ApiFailure | null {
  switch (error) {
    case 'rate_limit':
      return { kind: 'limit', account: null };
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return { kind: 'sign-in', account: 'auth' };
    case 'account_on_hold':
    case 'billing_error':
      return { kind: 'sign-in', account: 'account' };
    default:
      return null;
  }
}

/**
 * `codex_error_info` из `task_complete.error`: строка (`"usage_limit_exceeded"`) или объект с одним ключом —
 * вариант с полями (`{ http_connection_failed: { http_status_code: 502 } }`). `usage_limit_exceeded` —
 * `'rate_limit'`, `unauthorized` — `'authentication_failed'`, прочее (в том числе короткий
 * `rate_limit_exceeded`, который Codex повторяет сам) — `null`. Ответ — слово Claude, чтобы свёртка
 * разбирала обе стороны одним `classifyClaudeFailure`.
 */
export function codexFailureError(info: unknown): 'rate_limit' | 'authentication_failed' | null {
  const name = typeof info === 'string' ? info : onlyKey(info);
  switch (name) {
    case 'usage_limit_exceeded':
      return 'rate_limit';
    case 'unauthorized':
      return 'authentication_failed';
    default:
      return null;
  }
}

/** Единственный ключ объекта; `null` — не объект, массив или ключей не один. */
function onlyKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

// ---------------------------------------------------------------------------------------------
// Часы пояса. Только `Intl`: зависимостей нет, а база поясов — та, что у самой платформы.
// ---------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Формат стенных часов пояса; `null` — `Intl` такого пояса не знает. */
function zoneClock(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null;
  }
}

/**
 * Стенные часы пояса в момент `ms`, записанные как UTC-метка («метка стенных часов»). Календарь по таким
 * меткам считается без летнего времени: следующие сутки — это `+ DAY_MS`. Разница метки и самого момента —
 * смещение пояса.
 */
function wallClock(clock: Intl.DateTimeFormat, ms: number): number {
  const parts = clock.formatToParts(ms);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
}

/** Смещение пояса в момент `ms`, мс к востоку от UTC. */
const offsetAt = (clock: Intl.DateTimeFormat, ms: number): number =>
  wallClock(clock, ms) - Math.floor(ms / 1000) * 1000;

/** Метка стенных часов из частей; `null` — такой даты или времени не бывает (30 февраля, 25 часов). */
function wallOfParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const back = new Date(wall);
  const same =
    back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute;
  return same ? wall : null;
}

/**
 * Все моменты, когда часы пояса показывают `wall`, по возрастанию. Обычно один; при переводе часов назад
 * час случается дважды — два; при переводе вперёд такого времени не было — один, сдвинутый вперёд на
 * величину скачка (2:30 → 3:30). Смещения берутся за сутки до и после метки: перевод часов, который
 * касается этого времени, лежит между ними. Кандидат годится, если в его момент часы и правда показывают
 * `wall`.
 */
function instantsOfWall(clock: Intl.DateTimeFormat, wall: number): [number, ...number[]] {
  const before = offsetAt(clock, wall - DAY_MS);
  const after = offsetAt(clock, wall + DAY_MS);
  if (before === after) return [wall - before];
  const [first, ...rest] = [wall - before, wall - after]
    .filter((instant) => wallClock(clock, instant) === wall)
    .sort((a, b) => a - b);
  return first === undefined ? [wall - before] : [first, ...rest];
}

/**
 * Момент, когда часы пояса показывают дату и время `parts` (месяц 1–12). Повтор часа при переводе назад —
 * первое вхождение; время, которого при переводе вперёд не было, сдвигается вперёд на величину скачка.
 * `null` — пояс неизвестен или такой даты и времени не бывает.
 */
export function zonedInstant(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date | null {
  const clock = zoneClock(timeZone);
  const wall = wallOfParts(parts.year, parts.month, parts.day, parts.hour, parts.minute);
  if (clock === null || wall === null) return null;
  return new Date(instantsOfWall(clock, wall)[0]);
}

// ---------------------------------------------------------------------------------------------
// Время сброса из текста ошибки.
// ---------------------------------------------------------------------------------------------

export interface ResetGuess {
  resetsAt: string | null;
  window: 'session' | 'week' | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * «[Sep 22[nd][,] [2026] [at|,]] 2:50pm»: у Claude минуты на круглый час опущены, у Codex есть всегда;
 * дата — когда сброс не сегодня (Claude: «Sep 22 at 4pm», Codex: «Oct 14th, 2026 7:27 PM»). Группы:
 * месяц, день, год, час, минуты, am/pm.
 */
const WHEN = String.raw`(?:(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)`;

/** Claude: «resets 2:50pm (Europe/Moscow)»; седьмая группа — пояс. Что стоит перед `resets` («·», «∙»), не важно. */
const CLAUDE_RESET = new RegExp(String.raw`\bresets\s+${WHEN}(?:\s*\(([^)]+)\))?`, 'i');

/** Codex: «try again at 7:27 PM». Текст до `try again` не разбирается, поэтому апостроф в «You’ve» (’ или ') не мешает. */
const CODEX_RESET = new RegExp(String.raw`\btry again at\s+${WHEN}`, 'i');

function windowOf(text: string): ResetGuess['window'] {
  if (/session limit/i.test(text)) return 'session';
  if (/weekly limit/i.test(text)) return 'week';
  return null;
}

/** Дата из текста; `year: null` — года в тексте нет. */
interface ResetDate {
  month: number;
  day: number;
  year: number | null;
}

/**
 * Момент сброса по часам пояса `clock`. С годом в тексте — ровно названный. Время без даты — ближайшее
 * строго после `atMs` (сегодня по часам пояса или завтра); дата без года — в году `atMs` по часам пояса, а
 * если она уже прошла, в следующем. Перебираются все вхождения времени: при переводе часов назад
 * ближайшим может оказаться второе.
 */
function resetInstant(
  clock: Intl.DateTimeFormat,
  atMs: number,
  hour: number,
  minute: number,
  date: ResetDate | null,
): number | null {
  if (date !== null && date.year !== null) {
    const wall = wallOfParts(date.year, date.month, date.day, hour, minute);
    return wall === null ? null : instantsOfWall(clock, wall)[0];
  }
  const atWall = wallClock(clock, atMs);
  const dayStart = Math.floor(atWall / DAY_MS) * DAY_MS;
  const time = (hour * 60 + minute) * MINUTE_MS;
  const year = new Date(atWall).getUTCFullYear();
  // Метки стенных часов, где может оказаться сброс: сегодня и завтра либо в этом году и в следующем.
  const walls =
    date === null
      ? [dayStart + time, dayStart + DAY_MS + time]
      : [year, year + 1].map((y) => wallOfParts(y, date.month, date.day, hour, minute));
  const next = walls
    .flatMap((wall) => (wall === null ? [] : instantsOfWall(clock, wall)))
    .find((instant) => instant > atMs);
  return next ?? null;
}

/**
 * Время сброса и окно из текста ошибки. Форматы:
 * - Claude: «resets 2:50pm (Europe/Moscow)», «resets 7pm (Europe/Moscow)», «resets Sep 22 at 4pm
 *   (Europe/Moscow)»; пояс — из скобок, без скобок — `localZone`;
 * - Codex: «try again at 7:27 PM», «try again at Oct 14th, 2026 7:27 PM» — `localZone`.
 * Время без даты — ближайшее строго после `at`; дата без года — в году `at` (по часам пояса), а если она уже
 * прошла — в следующем. Окно: «session limit» → `session`, «weekly limit» → `week`, иначе `null`; оно
 * берётся из текста, даже когда время не разобрать. Непонятный текст, несуществующий пояс или дата —
 * `resetsAt: null`, а не ошибка.
 */
export function parseResetText(
  text: string,
  at: Date,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ResetGuess {
  const window = windowOf(text);
  const unknown: ResetGuess = { resetsAt: null, window };
  const match = CLAUDE_RESET.exec(text) ?? CODEX_RESET.exec(text);
  const atMs = at.getTime();
  if (match === null || Number.isNaN(atMs)) return unknown;

  const [, monthName, day, year, hour12, minutes, meridiem, zone] = match;
  const clock = zoneClock(zone?.trim() ?? localZone);
  const hour = Number(hour12);
  const minute = minutes === undefined ? 0 : Number(minutes);
  // Сравнения записаны через `!(…)`: NaN не должен пройти дальше, в `Intl`, где он бросает RangeError.
  if (clock === null || !(hour >= 1 && hour <= 12) || !(minute <= 59)) return unknown;

  const date: ResetDate | null =
    monthName === undefined
      ? null
      : {
          month: MONTHS.indexOf(monthName.toLowerCase()) + 1,
          day: Number(day),
          year: year === undefined ? null : Number(year),
        };
  const hour24 = (hour % 12) + (meridiem?.toLowerCase() === 'pm' ? 12 : 0);
  const instant = resetInstant(clock, atMs, hour24, minute, date);
  return { resetsAt: instant === null ? null : new Date(instant).toISOString(), window };
}

/**
 * Окончательное время сброса (спека 3.4), по порядку:
 * 1. Исчерпанное окно провайдера (`usedPercent` ≥ 100) со сбросом строго позже `now`: названное
 *    `guess.window` («session» — `fiveHour`, «week» — `week`), а без названия — любое из двух, из них более
 *    позднее. Окно ниже 100 % не берётся, даже названное: при свежих данных это уже новое окно после сброса,
 *    его `resetsAt` — конец нового окна, а не этого лимита, и сессию по нему припарковали бы зря.
 * 2. Иначе время из текста ошибки: `guess.resetsAt`, если оно есть, — `guess` как есть.
 * 3. Иначе (в тексте времени нет): данные провайдера новее `since` и все их окна ниже 100 % — лимит уже
 *    сброшен, `resetsAt` — `now`, окно из `guess`.
 * 4. Иначе `resetsAt` остаётся `null`.
 */
export function pickResetsAt(
  guess: ResetGuess,
  limits: ProviderLimits | null,
  since: string,
  now: number,
): ResetGuess {
  if (limits === null) return guess;
  const known = [
    ...(limits.fiveHour === null ? [] : [{ window: 'session' as const, ...limits.fiveHour }]),
    ...(limits.week === null ? [] : [{ window: 'week' as const, ...limits.week }]),
  ];
  const [picked] = known
    .filter((candidate) => guess.window === null || candidate.window === guess.window)
    .flatMap(({ window, usedPercent, resetsAt }) =>
      usedPercent >= 100 && resetsAt !== null && Date.parse(resetsAt) > now
        ? [{ window, resetsAt, ms: Date.parse(resetsAt) }]
        : [],
    )
    .sort((a, b) => b.ms - a.ms);
  if (picked !== undefined) return { resetsAt: picked.resetsAt, window: picked.window };
  if (guess.resetsAt !== null) return guess;

  const fresh = Date.parse(limits.at) > Date.parse(since);
  if (fresh && known.length > 0 && known.every((candidate) => candidate.usedPercent < 100)) {
    return { resetsAt: new Date(now).toISOString(), window: guess.window };
  }
  return guess; // времени в тексте нет, и сказать его нечем: resetsAt остаётся null
}
