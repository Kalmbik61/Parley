/**
 * Разбор ошибок лимита и входа и времени сброса (спека «Застрявшие сессии», 3.1–3.4). Функции чистые:
 * записи, часы и пояс приходят параметрами. Пояс машины тесты не читают, кроме проверки умолчания
 * `localZone`, — иначе набор зависел бы от того, где его запустили.
 */

import { describe, expect, it } from 'vitest';
import type { LimitWindow, ProviderLimits } from '../limits.js';
import {
  LIMIT_RETRY_MS,
  LIMIT_RETURN_GRACE_MS,
  LIMIT_RETURNS_MAX,
  NEED_DETAIL_MAX,
  STUCK_REPORT_MS,
  agentClock,
  backLetter,
  backLine,
  classifyClaudeFailure,
  clampDetail,
  codexFailureError,
  limitLetter,
  localClock,
  needReason,
  parseResetText,
  pickResetsAt,
  providerLabel,
  stuckHint,
  stuckLetter,
  stuckLine,
  stuckReason,
  stuckWarning,
  zonedInstant,
  type LimitAlternative,
  type ResetGuess,
  type SessionNeed,
} from './stuck.js';
import { sessionMention } from './thread.js';

const MOSCOW = 'Europe/Moscow'; // UTC+3 круглый год
const NEW_YORK = 'America/New_York'; // EST −5, EDT −4: в 2026-м часы переводят 8 марта и 1 ноября
const KOLKATA = 'Asia/Kolkata'; // UTC+5:30 круглый год
const BERLIN = 'Europe/Berlin'; // CET +1, CEST +2: часы переводят 29 марта и 25 октября
// Пропуск часа вплотную к полуночи: в 2026-м Нуук переводит часы в 23:00 28 марта (сразу 00:00 29-го),
// Гавана — в 00:00 8 марта (сразу 01:00).
const GODTHAB = 'America/Godthab';
const HAVANA = 'America/Havana';

const MINUTE = 60_000;
const HOUR = 3_600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Стенные часы пояса в момент: «2026-09-22 16:00». */
function wall(moment: number | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(moment);
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${field('year')}-${field('month')}-${field('day')} ${field('hour')}:${field('minute')}`;
}

describe('константы спеки', () => {
  it('числа лежат в константах, а не в коде', () => {
    expect({
      NEED_DETAIL_MAX,
      STUCK_REPORT_MS,
      LIMIT_RETURN_GRACE_MS,
      LIMIT_RETRY_MS,
      LIMIT_RETURNS_MAX,
    }).toEqual({
      NEED_DETAIL_MAX: 200,
      STUCK_REPORT_MS: 120_000,
      LIMIT_RETURN_GRACE_MS: 120_000,
      LIMIT_RETRY_MS: 900_000,
      LIMIT_RETURNS_MAX: 2,
    });
  });
});

describe('clampDetail', () => {
  it('перевод строки и лишние пробелы → один пробел', () => {
    expect(clampDetail('npm install\nnpm test')).toBe('npm install npm test');
    expect(clampDetail('  a \r\n\t b  ')).toBe('a b');
  });

  it('300 знаков → ровно NEED_DETAIL_MAX, последний знак — «…»', () => {
    const result = clampDetail('x'.repeat(300));
    expect(result).toBe(`${'x'.repeat(NEED_DETAIL_MAX - 1)}…`);
    expect(result?.length).toBe(NEED_DETAIL_MAX);
  });

  it('ровно NEED_DETAIL_MAX знаков остаётся как есть, на знак больше — обрезается', () => {
    expect(clampDetail('y'.repeat(NEED_DETAIL_MAX))).toBe('y'.repeat(NEED_DETAIL_MAX));
    expect(clampDetail('y'.repeat(NEED_DETAIL_MAX + 1))).toBe(
      `${'y'.repeat(NEED_DETAIL_MAX - 1)}…`,
    );
  });

  it('пробел перед «…» не остаётся', () => {
    const result = clampDetail(`${'a'.repeat(NEED_DETAIL_MAX - 2)} ${'b'.repeat(20)}`);
    expect(result).toBe(`${'a'.repeat(NEED_DETAIL_MAX - 2)}…`);
  });

  it('обрезка не рвёт суррогатную пару: в конце целые эмодзи', () => {
    const result = clampDetail('😀'.repeat(150));
    expect(result).toBe(`${'😀'.repeat(99)}…`);
    expect(result?.length).toBeLessThanOrEqual(NEED_DETAIL_MAX);
  });

  it('пусто → null: пустая строка, одни пробелы, undefined, null', () => {
    expect(clampDetail('')).toBeNull();
    expect(clampDetail(' \n\t ')).toBeNull();
    expect(clampDetail(undefined)).toBeNull();
    expect(clampDetail(null)).toBeNull();
  });
});

describe('classifyClaudeFailure', () => {
  it.each([
    ['rate_limit', { kind: 'limit', account: null }],
    ['authentication_failed', { kind: 'sign-in', account: 'auth' }],
    ['oauth_org_not_allowed', { kind: 'sign-in', account: 'auth' }],
    ['account_on_hold', { kind: 'sign-in', account: 'account' }],
    ['billing_error', { kind: 'sign-in', account: 'account' }],
  ])('%s → %o', (error, expected) => {
    expect(classifyClaudeFailure(error)).toEqual(expected);
  });

  it.each(
    [
      null,
      '',
      'server_error',
      'invalid_request',
      'max_output_tokens',
      'unknown',
      'constructor',
      '__proto__',
    ].map((error) => [error]),
  )('прочее (%j) → null', (error) => {
    expect(classifyClaudeFailure(error)).toBeNull();
  });
});

describe('codexFailureError', () => {
  it('usage_limit_exceeded → rate_limit, unauthorized → authentication_failed', () => {
    expect(codexFailureError('usage_limit_exceeded')).toBe('rate_limit');
    expect(codexFailureError('unauthorized')).toBe('authentication_failed');
  });

  it('объект с одним ключом — имя варианта', () => {
    expect(codexFailureError({ usage_limit_exceeded: {} })).toBe('rate_limit');
    expect(codexFailureError({ unauthorized: { message: 'x' } })).toBe('authentication_failed');
  });

  // Каждое значение — в своём массиве: `it.each` разворачивает массивы в аргументы.
  it.each(
    [
      'rate_limit_exceeded',
      'server_overloaded',
      'context_window_exceeded',
      'other',
      '',
      'toString',
      { http_connection_failed: { http_status_code: 502 } },
      { usage_limit_exceeded: {}, unauthorized: {} },
      {},
      [],
      ['unauthorized'],
      null,
      undefined,
      42,
    ].map((info) => [info]),
  )('прочее (%j) → null', (info) => {
    expect(codexFailureError(info)).toBeNull();
  });

  it('словарь Claude: свёртка разбирает обе стороны одним classifyClaudeFailure', () => {
    expect(classifyClaudeFailure(codexFailureError('usage_limit_exceeded'))).toEqual({
      kind: 'limit',
      account: null,
    });
    expect(classifyClaudeFailure(codexFailureError('unauthorized'))).toEqual({
      kind: 'sign-in',
      account: 'auth',
    });
    expect(classifyClaudeFailure(codexFailureError('rate_limit_exceeded'))).toBeNull();
  });
});

describe('parseResetText: Claude', () => {
  const AT = new Date('2026-09-20T08:00:00.000Z'); // 11:00 по Москве

  it('«resets 2:50pm (Europe/Moscow)» → сегодня 14:50 по Москве, окно session', () => {
    const guess = parseResetText(
      "You've hit your session limit · resets 2:50pm (Europe/Moscow)",
      AT,
    );
    expect(guess).toEqual({ resetsAt: '2026-09-20T11:50:00.000Z', window: 'session' });
    expect(wall(Date.parse(guess.resetsAt ?? ''), MOSCOW)).toBe('2026-09-20 14:50');
  });

  it('«resets 7pm (Europe/Moscow)» без минут → 19:00, окно week', () => {
    expect(parseResetText("You've hit your weekly limit · resets 7pm (Europe/Moscow)", AT)).toEqual(
      { resetsAt: '2026-09-20T16:00:00.000Z', window: 'week' },
    );
  });

  it('«resets Sep 22 at 4pm (Europe/Moscow)» → 22 сентября 16:00 по Москве, окно week', () => {
    const guess = parseResetText(
      "You've hit your weekly limit · resets Sep 22 at 4pm (Europe/Moscow)",
      AT,
    );
    expect(guess).toEqual({ resetsAt: '2026-09-22T13:00:00.000Z', window: 'week' });
    expect(wall(Date.parse(guess.resetsAt ?? ''), MOSCOW)).toBe('2026-09-22 16:00');
  });

  it('прежние тексты: запятая вместо «at»; «5-hour limit reached» окна не называет', () => {
    // 10:00 по Москве — 07:00Z; без пояса в тексте берётся localZone
    expect(parseResetText('Weekly limit reached ∙ resets Oct 9, 10am', AT, MOSCOW)).toEqual({
      resetsAt: '2026-10-09T07:00:00.000Z',
      window: 'week',
    });
    expect(parseResetText('5-hour limit reached ∙ resets 3pm', AT, MOSCOW)).toEqual({
      resetsAt: '2026-09-20T12:00:00.000Z',
      window: null,
    });
  });

  it('несуществующий пояс → resetsAt null, а окно из текста остаётся', () => {
    expect(parseResetText("You've hit your session limit · resets 2:50pm (Mars/Base)", AT)).toEqual(
      { resetsAt: null, window: 'session' },
    );
  });

  it('пояс в скобках важнее localZone, а без скобок берётся localZone', () => {
    // 14:50 по Москве — 11:50Z; 14:50 по Калькутте — 09:20Z
    expect(parseResetText('resets 2:50pm (Europe/Moscow)', AT, KOLKATA).resetsAt).toBe(
      '2026-09-20T11:50:00.000Z',
    );
    expect(parseResetText('resets 2:50pm', AT, KOLKATA).resetsAt).toBe('2026-09-20T09:20:00.000Z');
  });

  it('без localZone — пояс машины', () => {
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const guess = parseResetText('resets 2:50pm', AT);
    expect(guess.resetsAt).not.toBeNull();
    expect(guess).toEqual(parseResetText('resets 2:50pm', AT, machine));
  });

  it('время уже прошло → завтра; ровно в момент записи — тоже завтра (строго позже)', () => {
    const afternoon = new Date('2026-09-20T12:00:00.000Z'); // 15:00 по Москве
    expect(parseResetText('resets 2:50pm (Europe/Moscow)', afternoon).resetsAt).toBe(
      '2026-09-21T11:50:00.000Z',
    );
    const exact = new Date('2026-09-20T11:50:00.000Z');
    expect(parseResetText('resets 2:50pm (Europe/Moscow)', exact).resetsAt).toBe(
      '2026-09-21T11:50:00.000Z',
    );
  });

  it('12am — полночь, 12pm — полдень, 12:30am — полпервого ночи', () => {
    expect(parseResetText('resets 12am (Europe/Moscow)', AT).resetsAt).toBe(
      '2026-09-20T21:00:00.000Z', // 21 сентября 00:00 по Москве
    );
    expect(parseResetText('resets 12pm (Europe/Moscow)', AT).resetsAt).toBe(
      '2026-09-20T09:00:00.000Z', // 12:00 сегодня по Москве: сейчас 11:00
    );
    expect(parseResetText('resets 12:30am (Europe/Moscow)', AT).resetsAt).toBe(
      '2026-09-20T21:30:00.000Z',
    );
  });

  it('дата без года, уже прошедшая → в следующем году', () => {
    const late = new Date('2026-09-23T00:00:00.000Z');
    expect(parseResetText('resets Sep 22 at 4pm (Europe/Moscow)', late).resetsAt).toBe(
      '2027-09-22T13:00:00.000Z',
    );
  });

  it('«Jan 2 at 4pm» при записи 31 декабря → следующий год', () => {
    const newYearsEve = new Date('2026-12-31T10:00:00.000Z');
    expect(parseResetText('resets Jan 2 at 4pm (Europe/Moscow)', newYearsEve).resetsAt).toBe(
      '2027-01-02T13:00:00.000Z',
    );
  });

  it('год дата берёт по часам пояса, а не по UTC', () => {
    // 01:00Z 1 января 2027 — ещё 31 декабря 2026, 20:00 в Нью-Йорке
    const at = new Date('2027-01-01T01:00:00.000Z');
    expect(parseResetText('resets Dec 31 at 11pm (America/New_York)', at).resetsAt).toBe(
      '2027-01-01T04:00:00.000Z',
    );
  });

  it('29 февраля — в ближайшем високосном из двух лет, несуществующая дата → null', () => {
    const at = new Date('2027-12-10T00:00:00.000Z');
    expect(parseResetText('resets Feb 29 at 4pm (Europe/Moscow)', at).resetsAt).toBe(
      '2028-02-29T13:00:00.000Z',
    );
    expect(parseResetText('resets Feb 29 at 4pm (Europe/Moscow)', AT).resetsAt).toBeNull();
    expect(parseResetText('resets Feb 30 at 4pm (Europe/Moscow)', AT).resetsAt).toBeNull();
  });

  it('окно по тексту: session limit, weekly limit, иначе null — и без времени сброса', () => {
    expect(parseResetText("You've hit your session limit", AT)).toEqual({
      resetsAt: null,
      window: 'session',
    });
    expect(parseResetText("You've hit your weekly limit", AT)).toEqual({
      resetsAt: null,
      window: 'week',
    });
    expect(parseResetText("You've hit your limit · resets 3pm (Europe/Moscow)", AT)).toEqual({
      resetsAt: '2026-09-20T12:00:00.000Z',
      window: null,
    });
  });
});

describe('parseResetText: Codex', () => {
  const MOSCOW_EVENING = new Date('2026-09-20T16:30:00.000Z'); // 19:30 по Москве

  it('«try again at 7:27 PM» при записи в 19:30 → завтра 19:27', () => {
    expect(
      parseResetText(
        'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:27 PM.',
        MOSCOW_EVENING,
        MOSCOW,
      ),
    ).toEqual({ resetsAt: '2026-09-21T16:27:00.000Z', window: null });
  });

  it('то же время при записи раньше — в тот же день', () => {
    const earlier = new Date('2026-09-20T16:00:00.000Z'); // 19:00 по Москве
    expect(parseResetText('or try again at 7:27 PM.', earlier, MOSCOW).resetsAt).toBe(
      '2026-09-20T16:27:00.000Z',
    );
  });

  it('текст с обычным апострофом и вариант «usage limit for …» разбираются так же', () => {
    const text =
      "You've hit your usage limit for GPT-5-Codex-Spark. Switch to another model now, or try again at 7:27 PM.";
    expect(parseResetText(text, MOSCOW_EVENING, MOSCOW).resetsAt).toBe('2026-09-21T16:27:00.000Z');
  });

  it('«try again at Oct 14th, 2026 7:27 PM» → точно, по локальному поясу', () => {
    const text = 'or try again at Oct 14th, 2026 7:27 PM.';
    const guess = parseResetText(text, MOSCOW_EVENING, MOSCOW);
    expect(guess).toEqual({ resetsAt: '2026-10-14T16:27:00.000Z', window: null });
    expect(parseResetText(text, MOSCOW_EVENING, NEW_YORK).resetsAt).toBe(
      '2026-10-14T23:27:00.000Z',
    );
  });

  it('суффиксы дня: 1st, 2nd, 3rd, 4th', () => {
    const times = ['Nov 1st', 'Nov 2nd', 'Nov 3rd', 'Nov 4th'].map(
      (day) =>
        parseResetText(`or try again at ${day}, 2026 1:05 AM.`, MOSCOW_EVENING, MOSCOW).resetsAt,
    );
    expect(times).toEqual([
      '2026-10-31T22:05:00.000Z',
      '2026-11-01T22:05:00.000Z',
      '2026-11-02T22:05:00.000Z',
      '2026-11-03T22:05:00.000Z',
    ]);
  });

  it('«try again later» и текст без времени → resetsAt null', () => {
    expect(parseResetText('You’ve hit your usage limit. Try again later.', MOSCOW_EVENING)).toEqual(
      { resetsAt: null, window: null },
    );
    expect(parseResetText('or try again later.', MOSCOW_EVENING, MOSCOW).resetsAt).toBeNull();
  });
});

describe('parseResetText: GLM (Z.ai)', () => {
  // Живая запись из журнала автора (2026-10-08T06:51:54Z, `isApiErrorMessage: true`, `error: "rate_limit"`).
  // Номер запроса в хвосте начинается с 14:51:53 при записи в 06:51:54Z: Z.ai печатает пекинское время (UTC+8).
  const RECORD =
    'API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-08 19:03:01][20261008145153…]';
  const AT = new Date('2026-10-08T06:51:54.000Z');
  const RESET = '2026-10-08T11:03:01.000Z'; // 19:03:01 по Пекину

  it('живая запись → 19:03:01 по Пекину, окно session', () => {
    expect(parseResetText(RECORD, AT, MOSCOW)).toEqual({ resetsAt: RESET, window: 'session' });
  });

  it('пояс машины не влияет: тот же момент при localZone Нью-Йорк и Калькутта и без localZone', () => {
    expect(parseResetText(RECORD, AT, NEW_YORK)).toEqual({ resetsAt: RESET, window: 'session' });
    expect(parseResetText(RECORD, AT, KOLKATA).resetsAt).toBe(RESET);
    expect(parseResetText(RECORD, AT).resetsAt).toBe(RESET);
  });

  it('секунды сохраняются', () => {
    const text = RECORD.replace('19:03:01', '19:03:59');
    expect(parseResetText(text, AT, MOSCOW).resetsAt).toBe('2026-10-08T11:03:59.000Z');
  });

  it('время не позже записи возвращается как разобрано: это абсолютная дата', () => {
    const later = new Date('2026-10-09T00:00:00.000Z');
    expect(parseResetText(RECORD, later, MOSCOW).resetsAt).toBe(RESET);
  });

  it('окно называет только «Usage limit reached for 5 hour»: у прочих текстов окно null', () => {
    // Текст кода 1310 не подтверждён: проверяем лишь, что окно не выдумывается.
    const other =
      'API Error: Request rejected (429) · [1310][Limit exhausted. Your limit will reset at 2026-10-12 00:00:00]';
    expect(parseResetText(other, AT, MOSCOW)).toEqual({
      resetsAt: '2026-10-11T16:00:00.000Z',
      window: null,
    });
  });

  it('невозможная дата или время (2026-13-40 25:00:00, секунда 60, 30 февраля) → resetsAt null', () => {
    for (const bad of ['2026-13-40 25:00:00', '2026-10-08 19:03:60', '2026-02-30 10:00:00']) {
      const text = RECORD.replace('2026-10-08 19:03:01', bad);
      expect(parseResetText(text, AT, MOSCOW), bad).toEqual({ resetsAt: null, window: 'session' });
    }
  });
});

describe('parseResetText: непонятное даёт null, а не ошибку', () => {
  const AT = new Date('2026-09-20T08:00:00.000Z');

  it.each([
    '',
    'something went wrong',
    'resets soon',
    'resets 25pm (Europe/Moscow)',
    'resets 0pm (Europe/Moscow)',
    'resets 7:75pm (Europe/Moscow)',
    'resets 19:27 (Europe/Moscow)',
    'resets Smarch 22 at 4pm (Europe/Moscow)',
  ])('«%s»', (text) => {
    expect(parseResetText(text, AT, MOSCOW).resetsAt).toBeNull();
  });

  it('запись с невозможным временем (Invalid Date) → null', () => {
    expect(parseResetText('resets 2:50pm (Europe/Moscow)', new Date(Number.NaN))).toEqual({
      resetsAt: null,
      window: null,
    });
  });
});

describe('parseResetText: инварианты времени без даты', () => {
  /** Сутки, где у Нью-Йорка переводят часы вперёд (8 марта) и назад (1 ноября), и конец года. */
  const DAYS = [
    '2026-03-07',
    '2026-03-08',
    '2026-03-09',
    '2026-09-20',
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
    '2026-12-31',
  ];

  /** Эталон перебором: первый момент строго после `at` с часами пояса 01:00 (шаг 30 минут: смещения кратны). */
  function nextOneAm(at: number, timeZone: string): number {
    for (let ms = at + 30 * MINUTE; ms <= at + 26 * HOUR; ms += 30 * MINUTE) {
      if (wall(ms, timeZone).endsWith(' 01:00')) return ms;
    }
    throw new Error(`за 26 часов после ${iso(at)} нет 01:00 в ${timeZone}`);
  }

  describe.each([MOSCOW, NEW_YORK, KOLKATA])('«resets 1am» в поясе %s', (timeZone) => {
    it.each(DAYS)(
      'сутки %s: на каждый час и полчаса — ближайшее 01:00, строго позже записи, не дальше 24 ч',
      (day) => {
        for (let hour = 0; hour < 24; hour += 1) {
          for (const minutes of [0, 30]) {
            const at = Date.parse(`${day}T00:00:00.000Z`) + hour * HOUR + minutes * MINUTE;
            const guess = parseResetText(
              `You've hit your session limit · resets 1am (${timeZone})`,
              new Date(at),
            );
            const where = `${timeZone}, запись ${iso(at)}`;
            expect(guess.resetsAt, where).not.toBeNull();
            const resets = Date.parse(guess.resetsAt ?? '');
            expect(resets, where).toBeGreaterThan(at);
            expect(resets - at, where).toBeLessThanOrEqual(24 * HOUR);
            expect(wall(resets, timeZone), where).toMatch(/ 01:00$/);
            expect(resets, where).toBe(nextOneAm(at, timeZone));
          }
        }
      },
    );
  });

  it.each([
    // 23:50 в Нью-Йорке (EDT) 20 сентября — 03:50Z, 06:50 по Москве: до 01:00 по Москве ещё 18 ч 10 мин
    [NEW_YORK, '2026-09-21T03:50:00.000Z', '2026-09-21T22:00:00.000Z'],
    // 23:50 в Калькутте — 18:20Z, 21:20 по Москве: до 01:00 по Москве 3 ч 40 мин
    [KOLKATA, '2026-09-20T18:20:00.000Z', '2026-09-20T22:00:00.000Z'],
  ])(
    'часы машины в другом поясе (%s), 23:50: «1am (Europe/Moscow)» → ближайшее 01:00 по Москве',
    (localZone, at, expected) => {
      const guess = parseResetText('resets 1am (Europe/Moscow)', new Date(at ?? ''), localZone);
      expect(guess.resetsAt).toBe(expected);
      expect(wall(Date.parse(guess.resetsAt ?? ''), MOSCOW)).toMatch(/ 01:00$/);
    },
  );

  it('цепочка в сутки перевода часов назад: 01:00 в Нью-Йорке 1 ноября случается дважды', () => {
    const text = 'resets 1am (America/New_York)';
    const chain: string[] = [];
    let at = new Date('2026-10-30T12:00:00.000Z');
    for (let step = 0; step < 4; step += 1) {
      const next = parseResetText(text, at).resetsAt;
      expect(next).not.toBeNull();
      chain.push(next ?? '');
      at = new Date(next ?? '');
    }
    expect(chain).toEqual([
      '2026-10-31T05:00:00.000Z', // 01:00 EDT
      '2026-11-01T05:00:00.000Z', // 01:00 EDT — первое
      '2026-11-01T06:00:00.000Z', // 01:00 EST — второе, через час
      '2026-11-02T06:00:00.000Z', // 01:00 EST
    ]);
  });

  it('время, которого в сутки перевода вперёд нет (2:30 в Нью-Йорке), сдвигается на величину скачка', () => {
    const at = new Date('2026-03-08T04:00:00.000Z'); // 23:00 EST 7 марта
    const guess = parseResetText('resets 2:30am (America/New_York)', at);
    expect(guess.resetsAt).toBe('2026-03-08T07:30:00.000Z');
    expect(wall(Date.parse(guess.resetsAt ?? ''), NEW_YORK)).toBe('2026-03-08 03:30');
  });

  it('пропуск часа вплотную к полуночи (12:30am в Гаване 8 марта) сдвигается на час, как и в zonedInstant', () => {
    const at = new Date('2026-03-08T03:00:00.000Z'); // 22:00 по Гаване 7 марта
    const guess = parseResetText('resets 12:30am (America/Havana)', at);
    expect(guess.resetsAt).toBe('2026-03-08T05:30:00.000Z');
    expect(wall(Date.parse(guess.resetsAt ?? ''), HAVANA)).toBe('2026-03-08 01:30');
  });
});

describe('zonedInstant', () => {
  it('обычное время: Москва, Калькутта, Нью-Йорк зимой и летом', () => {
    const at = (
      parts: [number, number, number, number, number],
      timeZone: string,
    ): string | undefined => {
      const [year, month, day, hour, minute] = parts;
      return zonedInstant({ year, month, day, hour, minute }, timeZone)?.toISOString();
    };
    expect(at([2026, 9, 22, 16, 0], MOSCOW)).toBe('2026-09-22T13:00:00.000Z');
    expect(at([2027, 1, 2, 16, 0], KOLKATA)).toBe('2027-01-02T10:30:00.000Z');
    expect(at([2026, 1, 15, 12, 0], NEW_YORK)).toBe('2026-01-15T17:00:00.000Z');
    expect(at([2026, 7, 15, 12, 0], NEW_YORK)).toBe('2026-07-15T16:00:00.000Z');
  });

  it('день перевода часов вперёд: 2:30 в Нью-Йорке нет → не null, 03:30 по стенным часам', () => {
    const moment = zonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK);
    expect(moment).not.toBeNull();
    expect(wall(moment ?? 0, NEW_YORK)).toBe('2026-03-08 03:30');
    expect(moment?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('пропуск часа к востоку от Гринвича: 2:30 в Берлине 29 марта → 03:30', () => {
    const moment = zonedInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN);
    expect(moment?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(wall(moment ?? 0, BERLIN)).toBe('2026-03-29 03:30');
  });

  it('пропуск часа вплотную к полуночи: 23:30 в Нууке 28 марта и 00:30 в Гаване 8 марта сдвигаются на час', () => {
    const nuuk = zonedInstant({ year: 2026, month: 3, day: 28, hour: 23, minute: 30 }, GODTHAB);
    expect(nuuk?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(wall(nuuk ?? 0, GODTHAB)).toBe('2026-03-29 00:30'); // сдвиг перешёл через полночь
    const havana = zonedInstant({ year: 2026, month: 3, day: 8, hour: 0, minute: 30 }, HAVANA);
    expect(havana?.toISOString()).toBe('2026-03-08T05:30:00.000Z');
    expect(wall(havana ?? 0, HAVANA)).toBe('2026-03-08 01:30');
  });

  it('повтор часа при переводе назад — первое вхождение, и к западу, и к востоку от Гринвича', () => {
    expect(
      zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NEW_YORK)?.toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z'); // EDT; второе вхождение — 06:30Z (EST)
    expect(
      zonedInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BERLIN)?.toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z'); // CEST; второе вхождение — 01:30Z (CET)
  });

  it('в сутки перевода часов стенные часы совпадают с запрошенными, кроме пропущенного часа', () => {
    const days: Array<[string, number, number, number]> = [
      [NEW_YORK, 3, 8, 2], // пропущен час 2
      [NEW_YORK, 11, 1, -1], // пропусков нет
      [BERLIN, 3, 29, 2],
      [BERLIN, 10, 25, -1],
    ];
    for (const [timeZone, month, day, skipped] of days) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const minute of [0, 30]) {
          const moment = zonedInstant({ year: 2026, month, day, hour, minute }, timeZone);
          const asked = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const hh = String(hour === skipped ? hour + 1 : hour).padStart(2, '0');
          const mm = String(minute).padStart(2, '0');
          expect(wall(moment ?? 0, timeZone), `${timeZone} ${asked} ${hour}:${minute}`).toBe(
            `${asked} ${hh}:${mm}`,
          );
        }
      }
    }
  });

  it('неизвестный пояс и невозможные части → null', () => {
    const base = { year: 2026, month: 9, day: 22, hour: 16, minute: 0 };
    expect(zonedInstant(base, 'Mars/Base')).toBeNull();
    expect(zonedInstant(base, '')).toBeNull();
    expect(zonedInstant({ ...base, month: 2, day: 30 }, MOSCOW)).toBeNull();
    expect(zonedInstant({ ...base, month: 13 }, MOSCOW)).toBeNull();
    expect(zonedInstant({ ...base, hour: 24 }, MOSCOW)).toBeNull();
    expect(zonedInstant({ ...base, minute: 60 }, MOSCOW)).toBeNull();
  });
});

describe('pickResetsAt', () => {
  const SINCE = '2026-09-20T10:00:00.000Z';
  const NOW = Date.parse('2026-09-20T10:05:00.000Z');
  const PAST = '2026-09-20T09:00:00.000Z';
  const SOON = '2026-09-20T12:00:00.000Z';
  const LATER = '2026-09-25T09:00:00.000Z';
  const FRESH = '2026-09-20T10:04:00.000Z'; // новее SINCE
  const STALE = '2026-09-20T09:59:00.000Z'; // старше SINCE

  const TEXT: ResetGuess = { resetsAt: '2026-09-20T11:50:00.000Z', window: null };
  /** В тексте ошибки времени сброса не было. */
  const NO_TEXT: ResetGuess = { resetsAt: null, window: null };
  const used = (usedPercent: number, resetsAt: string | null): LimitWindow => ({
    usedPercent,
    resetsAt,
  });
  const limits = (
    fiveHour: LimitWindow | null,
    week: LimitWindow | null,
    at = FRESH,
  ): ProviderLimits => ({ fiveHour, week, at });

  describe('исчерпанное окно (100 %) со сбросом в будущем', () => {
    it('бьёт время из текста', () => {
      expect(pickResetsAt(TEXT, limits(used(100, SOON), null), SINCE, NOW)).toEqual({
        resetsAt: SOON,
        window: 'session',
      });
      expect(pickResetsAt(TEXT, limits(null, used(100, LATER)), SINCE, NOW)).toEqual({
        resetsAt: LATER,
        window: 'week',
      });
    });

    it('названное окно — тоже, даже когда время в тексте есть', () => {
      expect(
        pickResetsAt({ ...TEXT, window: 'session' }, limits(used(100, SOON), null), SINCE, NOW),
      ).toEqual({ resetsAt: SOON, window: 'session' });
      expect(
        pickResetsAt({ ...TEXT, window: 'week' }, limits(null, used(100, LATER)), SINCE, NOW),
      ).toEqual({ resetsAt: LATER, window: 'week' });
    });

    it('названное окно берётся именно оно, даже если у другого сброс позже', () => {
      expect(
        pickResetsAt(
          { ...TEXT, window: 'week' },
          limits(used(100, LATER), used(100, SOON)),
          SINCE,
          NOW,
        ),
      ).toEqual({ resetsAt: SOON, window: 'week' });
      expect(
        pickResetsAt(
          { ...TEXT, window: 'session' },
          limits(used(100, SOON), used(100, LATER)),
          SINCE,
          NOW,
        ),
      ).toEqual({ resetsAt: SOON, window: 'session' });
    });

    it('без названия оба окна по 100 % — берётся позднее', () => {
      expect(pickResetsAt(TEXT, limits(used(100, SOON), used(100, LATER)), SINCE, NOW)).toEqual({
        resetsAt: LATER,
        window: 'week',
      });
      expect(pickResetsAt(TEXT, limits(used(100, LATER), used(100, SOON)), SINCE, NOW)).toEqual({
        resetsAt: LATER,
        window: 'session',
      });
    });

    it('без названия берётся только исчерпанное окно, даже если у другого сброс позже', () => {
      expect(pickResetsAt(TEXT, limits(used(100, SOON), used(60, LATER)), SINCE, NOW)).toEqual({
        resetsAt: SOON,
        window: 'session',
      });
    });

    it('сброс в прошлом или ровно сейчас — не берётся: остаётся время из текста', () => {
      expect(pickResetsAt(TEXT, limits(used(100, PAST), null), SINCE, NOW)).toEqual(TEXT);
      expect(pickResetsAt(TEXT, limits(used(100, iso(NOW)), null), SINCE, NOW)).toEqual(TEXT);
    });

    it('без времени сброса взять нечем: остаётся время из текста, а без него — null', () => {
      expect(pickResetsAt(TEXT, limits(used(100, null), null), SINCE, NOW)).toEqual(TEXT);
      expect(pickResetsAt(NO_TEXT, limits(used(100, null), null), SINCE, NOW)).toEqual(NO_TEXT);
    });
  });

  describe('окно ниже 100 %: при свежих данных это уже новое окно после сброса', () => {
    it('названное окно со сбросом в будущем не берётся — время из текста, не окна и не now', () => {
      const guess: ResetGuess = { ...TEXT, window: 'session' };
      expect(pickResetsAt(guess, limits(used(5, SOON), null), SINCE, NOW)).toEqual(guess);
    });

    it('исчерпанное, но не названное окно тоже не берётся', () => {
      const guess: ResetGuess = { ...TEXT, window: 'week' };
      expect(pickResetsAt(guess, limits(used(100, SOON), used(40, LATER)), SINCE, NOW)).toEqual(
        guess,
      );
    });

    it('все окна ниже 100 % и свежие данные, но в тексте время есть → время из текста, не now', () => {
      expect(pickResetsAt(TEXT, limits(used(30, SOON), used(10, LATER)), SINCE, NOW)).toEqual(TEXT);
    });
  });

  describe('«уже сброшен»: только когда в тексте времени нет', () => {
    it('данные новее since и все окна ниже 100 % → resetsAt = now', () => {
      expect(pickResetsAt(NO_TEXT, limits(used(30, SOON), used(10, LATER)), SINCE, NOW)).toEqual({
        resetsAt: iso(NOW),
        window: null,
      });
    });

    it('окно из текста сохраняется, и у названного окна сброс может быть как в будущем, так и в прошлом', () => {
      const guess: ResetGuess = { resetsAt: null, window: 'session' };
      expect(pickResetsAt(guess, limits(used(5, SOON), null), SINCE, NOW)).toEqual({
        resetsAt: iso(NOW),
        window: 'session',
      });
      expect(pickResetsAt(guess, limits(used(30, PAST), used(10, LATER)), SINCE, NOW)).toEqual({
        resetsAt: iso(NOW),
        window: 'session',
      });
    });
  });

  describe('нечем ответить → resetsAt остаётся null', () => {
    it('данные старше since или ровно since и все окна ниже 100 % ничего не доказывают', () => {
      expect(
        pickResetsAt(NO_TEXT, limits(used(30, SOON), used(10, LATER), STALE), SINCE, NOW),
      ).toEqual(NO_TEXT);
      expect(
        pickResetsAt(NO_TEXT, limits(used(30, SOON), used(10, LATER), SINCE), SINCE, NOW),
      ).toEqual(NO_TEXT);
      // со временем в тексте оно и остаётся
      expect(
        pickResetsAt(TEXT, limits(used(30, SOON), used(10, LATER), STALE), SINCE, NOW),
      ).toEqual(TEXT);
    });

    it('данные без единого окна не значат «сброшен»', () => {
      expect(pickResetsAt(NO_TEXT, limits(null, null), SINCE, NOW)).toEqual(NO_TEXT);
      expect(pickResetsAt(TEXT, limits(null, null), SINCE, NOW)).toEqual(TEXT);
    });

    it('названного окна в данных нет → как есть, название сохраняется', () => {
      const guess: ResetGuess = { ...TEXT, window: 'session' };
      expect(pickResetsAt(guess, limits(null, used(100, LATER)), SINCE, NOW)).toEqual(guess);
      const bare: ResetGuess = { resetsAt: null, window: 'session' };
      expect(pickResetsAt(bare, limits(null, used(100, LATER)), SINCE, NOW)).toEqual(bare);
    });

    it('limits null → как есть', () => {
      expect(pickResetsAt(TEXT, null, SINCE, NOW)).toEqual(TEXT);
      expect(pickResetsAt({ resetsAt: null, window: 'week' }, null, SINCE, NOW)).toEqual({
        resetsAt: null,
        window: 'week',
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Часы машины и тексты причины (спека застрявших 7.4, спека подписок 4.4, 5.8, К16).
// Даты собраны из частей по местному времени — набор не зависит от пояса машины.
// ---------------------------------------------------------------------------------------------

/** Местное время `2026-10-21 hh:mm` (месяц — октябрь). */
const local = (day: number, hour: number, minute = 0): Date => new Date(2026, 9, day, hour, minute);

describe('localClock', () => {
  const NOW = local(21, 13, 0);

  it('сегодня — только часы и минуты с нулём впереди', () => {
    expect(localClock(local(21, 16, 27).toISOString(), NOW)).toBe('16:27');
    expect(localClock(local(21, 9, 5).toISOString(), NOW)).toBe('09:05');
    expect(localClock(local(21, 0, 0).toISOString(), NOW)).toBe('00:00');
  });

  it('другой день — «Oct 14, 19:27»', () => {
    expect(localClock(local(22, 3, 5).toISOString(), NOW)).toBe('Oct 22, 03:05');
    expect(localClock(local(14, 19, 27).toISOString(), NOW)).toBe('Oct 14, 19:27');
  });

  it('непонятная строка возвращается как есть', () => {
    expect(localClock('not a date', NOW)).toBe('not a date');
  });
});

describe('agentClock', () => {
  const NOW = local(21, 13, 0);
  const offset = (at: Date): string => {
    const total = -at.getTimezoneOffset();
    const abs = Math.abs(total);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `UTC${total < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  };

  it('часы, пояс на тот момент и сколько осталось: «in 2 h 10 min»', () => {
    const at = local(21, 15, 10);
    expect(agentClock(at.toISOString(), NOW)).toBe(`15:10 local time (${offset(at)}), in 2 h 10 min`);
  });

  it('меньше часа — минуты, ровно часы — без «0 min»', () => {
    expect(agentClock(local(21, 13, 25).toISOString(), NOW)).toContain(', in 25 min');
    expect(agentClock(local(21, 15, 0).toISOString(), NOW)).toContain(', in 2 h');
    expect(agentClock(local(21, 15, 0).toISOString(), NOW)).not.toContain('0 min');
  });

  it('дальше суток — дни и часы, дата в часах: «in 3 d 4 h»', () => {
    const at = local(24, 17, 0);
    expect(agentClock(at.toISOString(), NOW)).toBe(`Oct 24, 17:00 local time (${offset(at)}), in 3 d 4 h`);
  });

  it('время прошло — «already passed»', () => {
    expect(agentClock(local(21, 12, 0).toISOString(), NOW)).toContain(', already passed');
  });
});

describe('providerLabel', () => {
  it('встроенные имена, у своих — label, пустой label — id', () => {
    expect(providerLabel({ id: 'claude', label: 'claude' })).toBe('Claude Code');
    expect(providerLabel({ id: 'codex', label: 'Codex' })).toBe('Codex');
    expect(providerLabel({ id: 'glm', label: 'zai' })).toBe('GLM');
    expect(providerLabel({ id: 'custom-claude-2', label: 'Claude Code 2' })).toBe('Claude Code 2');
    expect(providerLabel({ id: 'aider', label: '' })).toBe('aider');
  });

  it('id встроенных — без учёта регистра, как providerName окна', () => {
    expect(providerLabel({ id: 'Codex', label: '' })).toBe('Codex');
  });
});

describe('needReason', () => {
  const NOW = local(21, 13, 0);
  const SINCE = local(21, 10, 0).toISOString();
  const need = (over: Partial<SessionNeed>): SessionNeed => ({
    kind: 'approval',
    since: SINCE,
    detail: null,
    resetsAt: null,
    window: null,
    account: null,
    ...over,
  });

  it('limit называет провайдера и время сброса (спека подписок 4.4, 5.8)', () => {
    const limit = need({ kind: 'limit', resetsAt: local(21, 16, 27).toISOString(), window: 'session' });
    expect(needReason(limit, NOW, 'Claude Code 2')).toBe('Hit its Claude Code 2 usage limit; resets at 16:27');
  });

  it('limit не сегодня — дата перед часами; без времени и с нечитаемым временем — «reset time is unknown»', () => {
    expect(needReason(need({ kind: 'limit', resetsAt: local(22, 3, 5).toISOString() }), NOW, 'Codex')).toBe(
      'Hit its Codex usage limit; resets at Oct 22, 03:05',
    );
    expect(needReason(need({ kind: 'limit' }), NOW, 'Codex')).toBe('Hit its Codex usage limit; the reset time is unknown');
    expect(needReason(need({ kind: 'limit', resetsAt: 'garbage' }), NOW, 'Codex')).toBe(
      'Hit its Codex usage limit; the reset time is unknown',
    );
  });

  it('approval — с командой или без неё; question и startup — фиксированные фразы', () => {
    expect(needReason(need({ kind: 'approval', detail: 'ls -la' }), NOW, 'Codex')).toBe('Waiting for your approval: ls -la');
    expect(needReason(need({ kind: 'approval' }), NOW, 'Codex')).toBe('Waiting for your approval in its terminal');
    expect(needReason(need({ kind: 'question', detail: 'Which database?' }), NOW, 'Codex')).toBe(
      'Asked you a question in its terminal',
    );
    expect(needReason(need({ kind: 'startup' }), NOW, 'Codex')).toBe(
      'Waiting in its terminal since launch (sign-in, folder trust or another startup screen)',
    );
  });

  it('sign-in называет провайдера и текст ошибки; проблема аккаунта — своя фраза', () => {
    expect(needReason(need({ kind: 'sign-in', account: 'auth', detail: 'Please run /login' }), NOW, 'GLM')).toBe(
      'Signed out of GLM: Please run /login',
    );
    expect(needReason(need({ kind: 'sign-in', account: 'auth' }), NOW, 'GLM')).toBe('Signed out of GLM');
    expect(needReason(need({ kind: 'sign-in', account: 'account', detail: 'billing' }), NOW, 'GLM')).toBe(
      'Account problem in GLM: billing',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Строки ленты, письма Parley и подсказки MCP (спека застрявших 5.2–5.3, спека подписок 4.4, 5.8).
// ---------------------------------------------------------------------------------------------

describe('тексты о застрявшей сессии', () => {
  const NOW = local(21, 17, 17);
  const SINCE = local(21, 14, 2).toISOString();
  const RESETS = local(21, 19, 27).toISOString();
  const S03 = { id: 's-03', provider: 'Codex' };
  const need = (over: Partial<SessionNeed>): SessionNeed => ({
    kind: 'approval',
    since: SINCE,
    detail: null,
    resetsAt: null,
    window: null,
    account: null,
    ...over,
  });
  const limit = need({ kind: 'limit', resetsAt: RESETS, window: 'session' });

  describe('stuckReason', () => {
    it('семь причин из спеки 5.3; сброс не сегодня — с датой, нечитаемый — как неизвестный', () => {
      expect(stuckReason(need({ kind: 'approval' }), NOW)).toBe('waiting for approval');
      expect(stuckReason(need({ kind: 'question' }), NOW)).toBe('asked a question');
      expect(stuckReason(limit, NOW)).toBe('usage limit until 19:27 local time');
      expect(stuckReason(need({ kind: 'limit', resetsAt: local(24, 17, 0).toISOString() }), NOW)).toBe(
        'usage limit until Oct 24, 17:00 local time',
      );
      expect(stuckReason(need({ kind: 'limit' }), NOW)).toBe('usage limit, reset time unknown');
      expect(stuckReason(need({ kind: 'limit', resetsAt: 'garbage' }), NOW)).toBe('usage limit, reset time unknown');
      expect(stuckReason(need({ kind: 'sign-in', account: 'auth' }), NOW)).toBe('signed out');
      expect(stuckReason(need({ kind: 'sign-in', account: 'account' }), NOW)).toBe('account problem');
      expect(stuckReason(need({ kind: 'startup' }), NOW)).toBe('waiting at startup');
    });
  });

  describe('stuckLine', () => {
    it('approval — с командой и без неё (без двоеточия и хвоста)', () => {
      expect(stuckLine(S03, need({ detail: 'npm install' }), NOW, false)).toBe(
        '@s03 is waiting for your approval in its terminal: npm install',
      );
      expect(stuckLine(S03, need({}), NOW, false)).toBe('@s03 is waiting for your approval in its terminal');
    });

    it('question и startup — фиксированные строки, detail в них не попадает', () => {
      expect(stuckLine(S03, need({ kind: 'question', detail: 'Which database?' }), NOW, false)).toBe(
        '@s03 asked you a question in its terminal',
      );
      expect(stuckLine(S03, need({ kind: 'startup', detail: 'Do you trust this folder?' }), NOW, false)).toBe(
        '@s03 has been waiting in its terminal since launch (sign-in, folder trust or another startup screen)',
      );
    });

    it('limit называет провайдера и местное время сброса; без времени и с нечитаемым — «the reset time is unknown»', () => {
      expect(stuckLine(S03, limit, NOW, false)).toBe('@s03 hit its Codex usage limit; it resets at 19:27');
      expect(stuckLine({ id: 's-03', provider: 'Claude Code 2' }, limit, NOW, false)).toBe(
        '@s03 hit its Claude Code 2 usage limit; it resets at 19:27',
      );
      expect(stuckLine(S03, need({ kind: 'limit', resetsAt: local(22, 3, 5).toISOString() }), NOW, false)).toBe(
        '@s03 hit its Codex usage limit; it resets at Oct 22, 03:05',
      );
      expect(stuckLine(S03, need({ kind: 'limit' }), NOW, false)).toBe(
        '@s03 hit its Codex usage limit; the reset time is unknown',
      );
      expect(stuckLine(S03, need({ kind: 'limit', resetsAt: 'garbage' }), NOW, false)).toBe(
        '@s03 hit its Codex usage limit; the reset time is unknown',
      );
    });

    it('sign-in — вход или аккаунт, с текстом ошибки и без', () => {
      const who = { id: 's-03', provider: 'Claude Code' };
      const signedOut = need({ kind: 'sign-in', account: 'auth', detail: 'Not logged in · Please run /login' });
      expect(stuckLine(who, signedOut, NOW, false)).toBe(
        '@s03 is signed out of Claude Code: Not logged in · Please run /login',
      );
      expect(stuckLine(who, need({ kind: 'sign-in', account: 'auth' }), NOW, false)).toBe(
        '@s03 is signed out of Claude Code',
      );
      expect(stuckLine(who, need({ kind: 'sign-in', account: 'account', detail: 'billing' }), NOW, false)).toBe(
        '@s03 has an account problem in Claude Code: billing',
      );
      expect(stuckLine(who, need({ kind: 'sign-in', account: 'account' }), NOW, false)).toBe(
        '@s03 has an account problem in Claude Code',
      );
    });

    it('ведущий: хвост «leads this room» только у limit и sign-in', () => {
      const tail = ' @s03 leads this room: you can make another participant the lead.';
      expect(stuckLine(S03, limit, NOW, true)).toBe(`@s03 hit its Codex usage limit; it resets at 19:27.${tail}`);
      expect(stuckLine(S03, need({ kind: 'sign-in', account: 'auth' }), NOW, true)).toBe(
        `@s03 is signed out of Codex.${tail}`,
      );
      // Текст ошибки уже кончается точкой — вторая не нужна.
      expect(stuckLine(S03, need({ kind: 'sign-in', account: 'auth', detail: 'Please log in.' }), NOW, true)).toBe(
        `@s03 is signed out of Codex: Please log in.${tail}`,
      );
      expect(stuckLine(S03, need({ detail: 'ls' }), NOW, true)).not.toContain('leads this room');
      expect(stuckLine(S03, need({ kind: 'question' }), NOW, true)).not.toContain('leads this room');
      expect(stuckLine(S03, need({ kind: 'startup' }), NOW, true)).not.toContain('leads this room');
      expect(stuckLine(S03, limit, NOW, false)).not.toContain('leads this room');
    });

    it('упоминание — как sessionMention: s-03 → @s03, чужая форма id печатается как есть', () => {
      for (const id of ['s-03', 's-123', 'manual']) {
        expect(stuckLine({ id, provider: 'Codex' }, need({ kind: 'question' }), NOW, false)).toBe(
          `${sessionMention(id)} asked you a question in its terminal`,
        );
      }
    });
  });

  describe('backLine', () => {
    it('снят лимит и вход — с пометкой, остальное — просто «is back»', () => {
      expect(backLine('s-03', 'limit')).toBe('@s03 is back (the usage limit has reset)');
      expect(backLine('s-03', 'sign-in')).toBe('@s03 is back (signed in)');
      expect(backLine('s-03', 'approval')).toBe('@s03 is back');
      expect(backLine('s-03', 'question')).toBe('@s03 is back');
      expect(backLine('s-03', 'startup')).toBe('@s03 is back');
    });
  });

  describe('stuckLetter: approval, question, startup', () => {
    it('approval — вид и команда в скобках, время начала по местным часам, ссылка на тему stuck', () => {
      expect(stuckLetter(S03, need({ detail: 'npm install' }), NOW)).toBe(
        '@s03 is waiting for the human in its terminal (approval: npm install) since 14:02. It cannot read messages until the human acts; the human has been notified. Do not hand its part to anyone and do not decide without it: do only what does not depend on it, or end your turn. Its reply comes as usual once it continues (read_guide topic: stuck).',
      );
    });

    it('без detail скобки несут один вид; question и startup — свой вид', () => {
      expect(stuckLetter(S03, need({}), NOW)).toContain('in its terminal (approval) since 14:02.');
      expect(stuckLetter(S03, need({ kind: 'question', detail: 'Which database?' }), NOW)).toContain(
        'in its terminal (question: Which database?) since 14:02.',
      );
      expect(stuckLetter(S03, need({ kind: 'startup' }), NOW)).toContain('in its terminal (startup) since 14:02.');
    });

    it('эпизод начался не сегодня — дата перед часами', () => {
      const old = need({ since: local(20, 23, 40).toISOString() });
      expect(stuckLetter(S03, old, NOW)).toContain('(approval) since Oct 20, 23:40.');
    });
  });

  describe('stuckLetter: sign-in', () => {
    const who = { id: 's-03', provider: 'Claude Code' };

    it('вход — слово человека, ведущему просьба спросить @human', () => {
      const signedOut = need({ kind: 'sign-in', account: 'auth', detail: 'Not logged in · Please run /login' });
      expect(stuckLetter(who, signedOut, NOW)).toBe(
        '@s03 is signed out of Claude Code (Not logged in · Please run /login) and cannot work until the human signs in. Messages to @s03 wait. Do not hand its part to anyone on your own. If you lead this room, tell @human what waits on @s03 and ask whether to wait or give its part to another participant; then wait for the answer (read_guide topic: stuck).',
      );
    });

    it('без detail — без скобок; проблема аккаунта называется проблемой аккаунта', () => {
      expect(stuckLetter(who, need({ kind: 'sign-in', account: 'auth' }), NOW)).toContain(
        '@s03 is signed out of Claude Code and cannot work until the human signs in.',
      );
      expect(stuckLetter(who, need({ kind: 'sign-in', account: 'account', detail: 'billing' }), NOW)).toContain(
        '@s03 has an account problem in Claude Code (billing) and cannot work until the human fixes it.',
      );
    });
  });

  describe('limitLetter и stuckLetter для limit', () => {
    // 17:17 → 19:27 — через 2 ч 10 мин; часы и пояс печатает agentClock, он проверен выше.
    const when = agentClock(RESETS, NOW);
    const nextMonday = local(27, 10, 0).toISOString();
    const base = (over: Partial<Parameters<typeof limitLetter>[0]> = {}): string =>
      limitLetter({ mention: '@s03', provider: 'Codex', resetsAt: RESETS, now: NOW, alternatives: [], ...over });
    const win = (usedPercent: number, resetsAt: string | null): LimitWindow => ({ usedPercent, resetsAt });
    const free = (over: Partial<LimitAlternative> = {}): LimitAlternative => ({
      id: 'claude',
      label: 'Claude Code',
      limits: { fiveHour: null, week: win(31, nextMonday), at: NOW.toISOString() },
      ...over,
    });

    it('без альтернатив — письмо спеки застрявших 5.2 дословно, абзаца о других аккаунтах нет', () => {
      expect(base()).toBe(
        `@s03 hit its Codex usage limit; it resets at ${when}. Messages to @s03 wait; after the reset Parley delivers them and asks @s03 to continue. Do not hand its part to anyone on your own. If you lead this room, write one message to @human: who is out, until when, what waits on it, and the options — wait for the reset, give its part to another participant (name who), or continue without it. Then wait for the answer (read_guide topic: stuck).`,
      );
      expect(base()).not.toContain('Other Codex accounts');
      expect(base()).not.toContain('replacement');
    });

    it('время сброса неизвестно — «the reset time is unknown» вместо часов', () => {
      const text = base({ resetsAt: null });
      expect(text).toContain('@s03 hit its Codex usage limit; the reset time is unknown. Messages to @s03 wait;');
      expect(text).not.toContain('local time');
      expect(base({ resetsAt: 'garbage' })).toBe(text);
    });

    it('с альтернативами — абзац о свободных аккаунтах и вариант replacement (спека подписок 5.8)', () => {
      const text = base({ provider: 'Claude Code 2', alternatives: [free()] });
      expect(text).toContain(
        `Other Claude Code 2 accounts in Parley right now: Claude Code (weekly 31 % used, resets ${agentClock(nextMonday, NOW)}).`,
      );
      expect(text).toContain('create_session (provider: "claude") — but only after @human agrees.');
      expect(text).toContain("(name who), start a replacement on Claude Code and hand it @s03's part, or continue without it.");
      // Абзац стоит перед последним предложением, а не после него.
      expect(text.endsWith('Then wait for the answer (read_guide topic: stuck).')).toBe(true);
      expect(text.indexOf('Other Claude Code 2 accounts')).toBeLessThan(text.indexOf('Then wait for the answer'));
    });

    it('аккаунт без известных лимитов — «no limits known»', () => {
      const text = base({ alternatives: [free({ limits: null })] });
      expect(text).toContain('Other Codex accounts in Parley right now: Claude Code — no limits known.');
    });

    it('аккаунт, у которого оба окна пусты, — тоже «no limits known»', () => {
      const text = base({ alternatives: [free({ limits: { fiveHour: null, week: null, at: NOW.toISOString() } })] });
      expect(text).toContain('right now: Claude Code — no limits known.');
    });

    it('окна: пятичасовое и недельное печатаются вместе, окно без времени сброса — без «resets»', () => {
      const limits = { fiveHour: win(12.4, null), week: win(31, nextMonday), at: NOW.toISOString() };
      const text = base({ alternatives: [free({ limits })] });
      expect(text).toContain(`Claude Code (5-hour 12 % used; weekly 31 % used, resets ${agentClock(nextMonday, NOW)})`);
    });

    it('несколько аккаунтов: список через «; », каждому — его id в create_session, в вариантах — все имена', () => {
      const second = free({ id: 'custom-claude-3', label: 'Claude Code 3', limits: null });
      const text = base({ provider: 'Claude Code 2', alternatives: [free(), second] });
      expect(text).toContain('Claude Code (weekly 31 % used, resets');
      expect(text).toContain('; Claude Code 3 — no limits known.');
      expect(text).toContain('create_session (provider: "claude" for Claude Code, "custom-claude-3" for Claude Code 3)');
      expect(text).toContain("start a replacement on Claude Code or Claude Code 3 and hand it @s03's part");
    });

    it('stuckLetter для limit — то же письмо; альтернативы приходят четвёртым аргументом', () => {
      expect(stuckLetter(S03, limit, NOW)).toBe(base());
      expect(stuckLetter(S03, limit, NOW, [free()])).toBe(base({ alternatives: [free()] }));
    });
  });

  describe('backLetter', () => {
    it('письмо о возврате: лимит, вход и старт — со своей пометкой', () => {
      expect(backLetter('s-03', 'limit')).toBe(
        '@s03 is back (the usage limit has reset). Messages that waited are being delivered.',
      );
      expect(backLetter('s-03', 'sign-in')).toBe(
        '@s03 is back (signed in). Messages that waited are being delivered.',
      );
      expect(backLetter('s-03', 'startup')).toBe(
        '@s03 is back (started). Messages that waited are being delivered.',
      );
    });
  });

  describe('stuckHint и stuckWarning', () => {
    it('подсказка wait_for: причина в скобках, не ждать снова, Parley напишет сам', () => {
      expect(stuckHint(S03.id, limit, NOW)).toBe(
        '@s03 waits for the human (usage limit until 19:27 local time). Do not wait_for it again: end your turn or wait_for("inbox") — Parley writes to you when it is back.',
      );
      expect(stuckHint(S03.id, need({}), NOW)).toContain('(waiting for approval)');
    });

    it('предупреждение send_message: причина и «reads this when it is back»', () => {
      expect(stuckWarning(S03.id, limit, NOW)).toBe(
        '@s03 is stuck (usage limit until 19:27 local time): it reads this when it is back',
      );
      expect(stuckWarning(S03.id, need({ kind: 'sign-in', account: 'auth' }), NOW)).toBe(
        '@s03 is stuck (signed out): it reads this when it is back',
      );
    });
  });
});
