/**
 * Застрявшие сессии: чего сессия ждёт от человека (`SessionNeed`), разбор ошибок API Claude и Codex и
 * времени сброса лимита (спека «Застрявшие сессии», 3.1–3.4). Модуль чистый: ни диска, ни часов — записи,
 * «сейчас» и пояс приходят параметрами. Свёртка активности и хост берут отсюда типы и разбор, поэтому сам
 * модуль ничего из `activity.ts` не тянет: цикла нет. В конце — тексты для человека: часы машины, имя
 * провайдера и одна строка причины `needReason` для уведомления окна, острова и Telegram (спека подписок К16);
 * поэтому окно берёт модуль подпутём `@parley/core/stuck`, как `@parley/core/session-state`. Дальше — строки
 * ленты комнаты, письма Parley и подсказки MCP о застрявшей сессии (спека застрявших 5.2–5.3, подписок 5.8).
 */

import type { LimitWindow, ProviderLimits } from '../limits.js';
import type { ProviderEntry } from '../providers.js';

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

/**
 * Метка стенных часов из частей; `null` — такой даты или времени не бывает (30 февраля, 25 часов). Секунды
 * нужны одному формату — GLM, остальным хватает минут; 60 секунд перекатываются в минуту и не проходят сверку.
 */
function wallOfParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
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

/**
 * GLM (Z.ai): «Your limit will reset at 2026-10-08 19:03:01» — абсолютное время по Пекину (UTC+8): Z.ai
 * печатает пекинское время, пояс машины и скобки тут ни при чём. Группы: год, месяц, день, час, минуты, секунды.
 */
const GLM_RESET = /\bYour limit will reset at\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i;
const GLM_ZONE = 'Asia/Shanghai';

/** Окно по тексту. Слова окна GLM известны одни: «Usage limit reached for 5 hour» — пятичасовой лимит. */
function windowOf(text: string): ResetGuess['window'] {
  if (/session limit|usage limit reached for 5 hour/i.test(text)) return 'session';
  if (/weekly limit/i.test(text)) return 'week';
  return null;
}

/** Момент из «2026-10-08 19:03:01» по Пекину, секунды сохраняются; `null` — такой даты или времени не бывает. */
function glmResetAt(match: RegExpExecArray): string | null {
  const [, year, month, day, hour, minute, second] = match;
  const clock = zoneClock(GLM_ZONE);
  const wall = wallOfParts(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (clock === null || wall === null) return null;
  return new Date(instantsOfWall(clock, wall)[0]).toISOString();
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
 * - Codex: «try again at 7:27 PM», «try again at Oct 14th, 2026 7:27 PM» — `localZone`;
 * - GLM (Z.ai): «Your limit will reset at 2026-10-08 19:03:01» — абсолютное время по Пекину (`Asia/Shanghai`),
 *   секунды сохраняются, `localZone` не нужен; время не позже `at` возвращается как разобрано.
 * Время без даты — ближайшее строго после `at`; дата без года — в году `at` (по часам пояса), а если она уже
 * прошла — в следующем. Окно: «session limit» и «Usage limit reached for 5 hour» (GLM) → `session`,
 * «weekly limit» → `week`, иначе `null`; оно берётся из текста, даже когда время не разобрать. Непонятный
 * текст, несуществующий пояс или дата — `resetsAt: null`, а не ошибка.
 */
export function parseResetText(
  text: string,
  at: Date,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ResetGuess {
  const window = windowOf(text);
  const unknown: ResetGuess = { resetsAt: null, window };
  const glm = GLM_RESET.exec(text);
  if (glm !== null) return { resetsAt: glmResetAt(glm), window };
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
    ...(limits.fiveHour === null ? [] : [{ ...limits.fiveHour, window: 'session' as const }]),
    ...(limits.week === null ? [] : [{ ...limits.week, window: 'week' as const }]),
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

// ---------------------------------------------------------------------------------------------
// Тексты причины (спека застрявших 7.4, спека подписок 4.4, 5.8, К16). Английские, одни на окно, остров и
// Telegram. Часы — по местному времени машины, «сейчас» приходит параметром.
// ---------------------------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Имя провайдера для человека: `claude` — «Claude Code», `codex` — «Codex», `glm` — «GLM» (id без учёта регистра,
 * как у `providerName` окна), у прочих — `label` записи реестра, а пустой `label` — сам id. Аккаунты
 * (`custom-claude-2`) называются по `label`, который отдаёт хост (спека подписок 5.9, К1).
 */
export function providerLabel(entry: Pick<ProviderEntry, 'id' | 'label'>): string {
  switch (entry.id.toLowerCase()) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'glm':
      return 'GLM';
    default:
      return entry.label || entry.id;
  }
}

/**
 * Время `iso` по часам машины: `19:27`, а не сегодня (по дню `now`) — `Oct 14, 19:27`. Нечитаемая строка
 * возвращается как есть: текст причины не должен падать из-за плохой метки.
 */
export function localClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? clock : `${MONTH_NAMES[at.getMonth()]} ${at.getDate()}, ${clock}`;
}

/** Смещение пояса машины в тот момент: `UTC+03:00`, `UTC-05:00`. */
function utcOffset(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Сколько осталось: `2 h 10 min`, `25 min`, `2 h`; от суток — `3 d 4 h`, `3 d`. Минуты округляются вверх. */
function untilText(ms: number): string {
  const total = Math.ceil(ms / MINUTE_MS);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
  if (hours > 0) return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/**
 * Время для агента, который не знает пояса человека: `19:27 local time (UTC+03:00), in 2 h 10 min` (не сегодня —
 * `Oct 14, 19:27 …`, от суток — `in 3 d 4 h`, прошло — `already passed`). Смещение берётся на сам момент, а не
 * на «сейчас»: перевод часов между ними не должен сдвинуть названный час. Нечитаемая строка — как есть.
 */
export function agentClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const left = at.getTime() - now.getTime();
  return `${localClock(iso, now)} local time (${utcOffset(at)}), ${left <= 0 ? 'already passed' : `in ${untilText(left)}`}`;
}

/**
 * Одна строка «чего ждёт сессия» для уведомления окна, острова и Telegram (спека застрявших 7.4, подписок К16).
 * `provider` — имя провайдера для человека (`providerLabel`): у аккаунтов оно называет аккаунт. Вопрос и экран
 * старта текст `detail` не повторяют: отвечать надо в терминале.
 */
export function needReason(need: SessionNeed, now: Date, provider: string): string {
  switch (need.kind) {
    case 'approval':
      return need.detail === null ? 'Waiting for your approval in its terminal' : `Waiting for your approval: ${need.detail}`;
    case 'question':
      return 'Asked you a question in its terminal';
    case 'limit': {
      const known = need.resetsAt !== null && !Number.isNaN(Date.parse(need.resetsAt));
      const when = known ? `resets at ${localClock(need.resetsAt as string, now)}` : 'the reset time is unknown';
      return `Hit its ${provider} usage limit; ${when}`;
    }
    case 'sign-in': {
      const lead = need.account === 'account' ? `Account problem in ${provider}` : `Signed out of ${provider}`;
      return need.detail === null ? lead : `${lead}: ${need.detail}`;
    }
    case 'startup':
      return 'Waiting in its terminal since launch (sign-in, folder trust or another startup screen)';
  }
}

// ---------------------------------------------------------------------------------------------
// Строки ленты комнаты, письма Parley и подсказки MCP (спека застрявших 5.2–5.3, спека подписок 4.4, 5.8).
// Английские: их читают агенты и человек. Время для человека — `localClock`, для агента — `agentClock`.
// ---------------------------------------------------------------------------------------------

/**
 * Сессия, о которой текст, и имя её провайдера для людей и агентов (`providerLabel`): у аккаунта это его имя
 * («Claude Code 2»), а не id и не просто «Claude Code» (спека подписок 4.4, 5.8).
 */
export interface StuckWho {
  id: string;
  provider: string;
  /**
   * Имя семейства CLI для людей и агентов: `Claude Code` или `Codex` (у незнакомого семейства — само имя провайдера).
   * Нужно письму о лимите: заголовок «Other <family> accounts» объединяет все аккаунты одного CLI, а не повторяет имя
   * застрявшего («Claude Code 2») (спека подписок 4.4, решение 11).
   */
  family: string;
}

/**
 * Упоминание сессии: `s-03` → `@s03`, чужая форма id — `@id`; то же правило, что у `sessionMention` из
 * `thread.ts` (тест сверяет оба). Своё, а не импорт: `thread.ts` через `letters.ts` тянет диск, а модуль идёт в
 * окно подпутём `@parley/core/stuck`.
 */
function mentionOf(id: string): string {
  const match = /^s-(\d+)$/.exec(id);
  return match === null ? `@${id}` : `@s${match[1]}`;
}

/** `iso`, если это читаемая метка времени; иначе `null` — в тексте это «время неизвестно». */
const readableTime = (iso: string | null): string | null =>
  iso !== null && !Number.isNaN(Date.parse(iso)) ? iso : null;

/** `: <detail>` или пусто. */
const detailTail = (detail: string | null): string => (detail === null ? '' : `: ${detail}`);

/**
 * Причина в скобках подсказки `wait_for` и предупреждения `send_message` (спека застрявших 5.3):
 * `waiting for approval`, `usage limit until 19:27 local time`, `signed out`…
 */
export function stuckReason(need: SessionNeed, now: Date): string {
  switch (need.kind) {
    case 'approval':
      return 'waiting for approval';
    case 'question':
      return 'asked a question';
    case 'limit': {
      const resets = readableTime(need.resetsAt);
      return resets === null ? 'usage limit, reset time unknown' : `usage limit until ${localClock(resets, now)} local time`;
    }
    case 'sign-in':
      return need.account === 'account' ? 'account problem' : 'signed out';
    case 'startup':
      return 'waiting at startup';
  }
}

/** Строка ленты без хвоста про ведущего. */
function lineText(who: StuckWho, need: SessionNeed, now: Date): string {
  const at = mentionOf(who.id);
  switch (need.kind) {
    case 'approval':
      return `${at} is waiting for your approval in its terminal${detailTail(need.detail)}`;
    case 'question':
      return `${at} asked you a question in its terminal`;
    case 'limit': {
      const resets = readableTime(need.resetsAt);
      const when = resets === null ? 'the reset time is unknown' : `it resets at ${localClock(resets, now)}`;
      return `${at} hit its ${who.provider} usage limit; ${when}`;
    }
    case 'sign-in':
      return need.account === 'account'
        ? `${at} has an account problem in ${who.provider}${detailTail(need.detail)}`
        : `${at} is signed out of ${who.provider}${detailTail(need.detail)}`;
    case 'startup':
      return `${at} has been waiting in its terminal since launch (sign-in, folder trust or another startup screen)`;
  }
}

/**
 * Строка ленты комнаты о застрявшей сессии — для человека (спека застрявших 5.2): время — местное, `HH:mm`.
 * Застрял ведущий, вид `limit` или `sign-in` — к строке добавляется подсказка про «Make lead».
 */
export function stuckLine(who: StuckWho, need: SessionNeed, now: Date, isLead: boolean): string {
  const line = lineText(who, need, now);
  const mayHandOver = need.kind === 'limit' || need.kind === 'sign-in';
  if (!isLead || !mayHandOver) return line;
  // Подсказка — отдельное предложение: строка кончается без точки, а `detail` ошибки может кончаться ею сам.
  const stop = /[.!?]$/.test(line) ? '' : '.';
  return `${line}${stop} ${mentionOf(who.id)} leads this room: you can make another participant the lead or continue it on another provider.`;
}

/** Пометка «вернулась» у строки: лимит сброшен, вход выполнен; у остальных видов — без пометки. */
const backNote = (kind: NeedKind): string =>
  kind === 'limit' ? ' (the usage limit has reset)' : kind === 'sign-in' ? ' (signed in)' : '';

/** Строка ленты, когда эпизод кончился: `@s03 is back (the usage limit has reset)`. */
export function backLine(sessionId: string, kind: NeedKind): string {
  return `${mentionOf(sessionId)} is back${backNote(kind)}`;
}

/**
 * Письмо Parley агенту о том, что сессия вернулась: для `limit`, `sign-in` и `startup` (у `approval` и `question`
 * выход виден строкой ленты, ответ придёт сам).
 */
export function backLetter(sessionId: string, kind: NeedKind): string {
  const note = kind === 'startup' ? ' (started)' : backNote(kind);
  return `${mentionOf(sessionId)} is back${note}. Messages that waited are being delivered.`;
}

/** Другой вошедший аккаунт того же CLI (спека подписок 5.8): имя для людей, id для `create_session`, лимиты. */
export interface LimitAlternative {
  id: string;
  label: string;
  /** Лимиты аккаунта; `null` — хост их не знает. */
  limits: ProviderLimits | null;
}

/** Окно лимита аккаунта: `weekly 31 % used, resets 10:00 local time (UTC+03:00), in 5 d 21 h`. */
function windowText(name: string, limitWindow: LimitWindow, now: Date): string {
  const resets = readableTime(limitWindow.resetsAt);
  return `${name} ${Math.round(limitWindow.usedPercent)} % used${resets === null ? '' : `, resets ${agentClock(resets, now)}`}`;
}

/** Аккаунт в абзаце письма: с окнами лимитов или «no limits known». */
function alternativeText(item: LimitAlternative, now: Date): string {
  const windows: string[] = [];
  if (item.limits?.fiveHour) windows.push(windowText('5-hour', item.limits.fiveHour, now));
  if (item.limits?.week) windows.push(windowText('weekly', item.limits.week, now));
  return windows.length === 0 ? `${item.label} — no limits known` : `${item.label} (${windows.join('; ')})`;
}

/**
 * Письмо Parley о лимите (спека застрявших 5.2; спека подписок 4.4, 5.8), которое получает ведущий. Когда есть другие
 * вошедшие аккаунты того же CLI, в вариантах для `@human` добавляется замена, а перед последним предложением —
 * абзац о них: что часть работы новой сессии `create_session` ведущий отдаёт только после согласия `@human`, сам — нет (решение 6); саму застрявшую сессию продолжает человек.
 * `provider` — имя для людей (`providerLabel`), `mention` — `@s03`; `family` — имя семейства CLI для заголовка
 * «Other <family> accounts» (у аккаунта `provider` — «Claude Code 2», а замену ищут среди «Claude Code»).
 */
export function limitLetter(input: {
  mention: string;
  provider: string;
  /** Имя семейства CLI (`StuckWho.family`): только в заголовке «Other <family> accounts». */
  family: string;
  resetsAt: string | null;
  now: Date;
  alternatives: readonly LimitAlternative[];
}): string {
  const { mention, provider, family, resetsAt, now, alternatives } = input;
  const resets = readableTime(resetsAt);
  const when = resets === null ? 'the reset time is unknown' : `it resets at ${agentClock(resets, now)}`;
  const after = resets === null ? 'when the limit lifts' : 'after the reset';
  // Застрявшую сессию продолжает человек кнопкой «Continue on another provider…»; `create_session` — лишь для передачи части работы.
  const target = alternatives.length === 0 ? 'another provider' : alternatives.map((item) => item.label).join(' or ');
  const takeover = `ask @human to continue ${mention} on ${target} (Continue on another provider; its rooms, children and mail stay with it), `;
  // Один аккаунт — просто его id; несколько — id с именем, чтобы ведущий не гадал, какой id чей.
  const ids = alternatives
    .map((item) => (alternatives.length === 1 ? `"${item.id}"` : `"${item.id}" for ${item.label}`))
    .join(', ');
  const others =
    alternatives.length === 0
      ? ''
      : ` Other ${family} accounts in Parley right now: ${alternatives.map((item) => alternativeText(item, now)).join('; ')}. A part of the work can be handed to a new session on a free one with create_session (provider: ${ids}) — but only after @human agrees.`;
  return `${mention} hit its ${provider} usage limit; ${when}. Messages to ${mention} wait; ${after} Parley delivers them and asks ${mention} to continue. Do not hand its part to anyone on your own. If you lead this room, write one message to @human: who is out, until when, what waits on it, and the options — wait for the reset, ${takeover}hand a part of the work to another participant (name who), or continue without it.${others} Then wait for the answer (read_guide topic: stuck).`;
}

/**
 * Письмо Parley агенту о застрявшей сессии на вход в эпизод (спека застрявших 5.2): ведущему и тем, кто ждёт её
 * ответа. Время — `agentClock`, а в скобках вид и `detail`: `(approval: npm install)`. `alternatives` нужны одному
 * виду — `limit`.
 */
export function stuckLetter(
  who: StuckWho,
  need: SessionNeed,
  now: Date,
  alternatives: readonly LimitAlternative[] = [],
): string {
  const at = mentionOf(who.id);
  switch (need.kind) {
    case 'limit':
      return limitLetter({ mention: at, provider: who.provider, family: who.family, resetsAt: need.resetsAt, now, alternatives });
    case 'sign-in': {
      const account = need.account === 'account';
      const state = account ? `has an account problem in ${who.provider}` : `is signed out of ${who.provider}`;
      const detail = need.detail === null ? '' : ` (${need.detail})`;
      return `${at} ${state}${detail} and cannot work until the human ${account ? 'fixes it' : 'signs in'}. Messages to ${at} wait. Do not hand its part to anyone on your own. If you lead this room, tell @human what waits on ${at} and ask whether to wait or give its part to another participant; then wait for the answer (read_guide topic: stuck).`;
    }
    case 'approval':
    case 'question':
    case 'startup':
      return `${at} is waiting for the human in its terminal (${need.kind}${detailTail(need.detail)}) since ${localClock(need.since, now)}. It cannot read messages until the human acts; the human has been notified. Do not hand its part to anyone and do not decide without it: do only what does not depend on it, or end your turn. Its reply comes as usual once it continues (read_guide topic: stuck).`;
  }
}

/** Подсказка в ответе `wait_for` на застрявшую сессию (спека застрявших 5.3): не ждать её снова, Parley напишет сам. */
export function stuckHint(sessionId: string, need: SessionNeed, now: Date): string {
  return `${mentionOf(sessionId)} waits for the human (${stuckReason(need, now)}). Do not wait_for it again: end your turn or wait_for("inbox") — Parley writes to you when it is back.`;
}

/** Предупреждение `send_message`, когда адресат застрял: письмо уходит, но прочтёт он его по возвращении. */
export function stuckWarning(sessionId: string, need: SessionNeed, now: Date): string {
  return `${mentionOf(sessionId)} is stuck (${stuckReason(need, now)}): it reads this when it is back`;
}
