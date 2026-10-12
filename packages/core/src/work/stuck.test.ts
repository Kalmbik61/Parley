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
  classifyClaudeFailure,
  clampDetail,
  codexFailureError,
  parseResetText,
  pickResetsAt,
  zonedInstant,
  type ResetGuess,
} from './stuck.js';

const MOSCOW = 'Europe/Moscow'; // UTC+3 круглый год
const NEW_YORK = 'America/New_York'; // EST −5, EDT −4: в 2026-м часы переводят 8 марта и 1 ноября
const KOLKATA = 'Asia/Kolkata'; // UTC+5:30 круглый год
const BERLIN = 'Europe/Berlin'; // CET +1, CEST +2: часы переводят 29 марта и 25 октября

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
