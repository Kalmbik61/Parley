/**
 * Лимиты подписки (спека комнат Organic, 3.5): разбор того, что отдают сами CLI, и правило
 * «окно с прошедшим сбросом не отдаётся». Форматы — по документации Claude Code
 * (code.claude.com/docs/en/statusline: `rate_limits.five_hour` и `seven_day`,
 * `used_percentage` и `resets_at` в Unix-секундах).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeLimits,
  dropExpiredWindows,
  isFileSafeId,
  limitsFile,
  limitWindow,
  mergeLimits,
  parseLimitsFile,
  readWorkLimits,
  type ProviderLimits,
} from './limits.js';

/** 2026-09-29T12:00:00Z в секундах — от него считаются «сейчас» и сбросы окон. */
const NOW_SEC = Date.parse('2026-09-29T12:00:00.000Z') / 1000;
const NOW_MS = NOW_SEC * 1000;
const AT = '2026-09-29T11:59:00.000Z';

const rateLimits = {
  five_hour: { used_percentage: 58, resets_at: NOW_SEC + 3600 },
  seven_day: { used_percentage: 41.2, resets_at: NOW_SEC + 86_400 },
};

describe('Z.ai windows with unknown resets', () => {
  const old: ProviderLimits = { source: 'zai', at: AT, fiveHour: { usedPercent: 70, resetsAt: null }, week: null };
  const recent: ProviderLimits = { ...old, at: '2026-09-29T12:00:00.000Z', fiveHour: { usedPercent: 20, resetsAt: null } };
  it('does not expire an unknown reset and preserves quota provenance', () => {
    expect(dropExpiredWindows(old, NOW_MS + 1e10)).toEqual(old);
  });
  it('uses observation time rather than assuming unknown windows have monotonically increasing usage', () => {
    expect(mergeLimits([old, recent])).toEqual(recent);
    expect(mergeLimits([recent, old])).toEqual(recent);
  });
});

describe('limitWindow', () => {
  it('процент и секунды сброса → usedPercent и resetsAt в ISO', () => {
    expect(limitWindow(23.5, NOW_SEC)).toEqual({
      usedPercent: 23.5,
      resetsAt: '2026-09-29T12:00:00.000Z',
    });
  });

  it('процент за пределами 0..100 прижимается к краю', () => {
    expect(limitWindow(140, NOW_SEC)?.usedPercent).toBe(100);
    expect(limitWindow(-3, NOW_SEC)?.usedPercent).toBe(0);
  });

  it('не число, NaN, бесконечность и выход за пределы даты — окна нет', () => {
    expect(limitWindow('58', NOW_SEC)).toBeNull();
    expect(limitWindow(58, '1738425600')).toBeNull();
    expect(limitWindow(58, undefined)).toBeNull();
    expect(limitWindow(Number.NaN, NOW_SEC)).toBeNull();
    expect(limitWindow(58, Number.POSITIVE_INFINITY)).toBeNull();
    expect(limitWindow(58, 1e20)).toBeNull();
  });
});

describe('claudeLimits: rate_limits строки статуса Claude Code', () => {
  it('five_hour → fiveHour, seven_day → week', () => {
    expect(claudeLimits(rateLimits, AT)).toEqual({
      fiveHour: { usedPercent: 58, resetsAt: '2026-09-29T13:00:00.000Z' },
      week: { usedPercent: 41.2, resetsAt: '2026-09-30T12:00:00.000Z' },
      at: AT,
    });
  });

  it('окна приходят по отдельности: второе — null', () => {
    const onlyWeek = claudeLimits({ seven_day: rateLimits.seven_day }, AT);
    expect(onlyWeek?.fiveHour).toBeNull();
    expect(onlyWeek?.week?.usedPercent).toBe(41.2);
  });

  it('spend_limit шлюза не окно подписки: его не показываем', () => {
    const limits = claudeLimits(
      { ...rateLimits, spend_limit: { used_percentage: 130, resets_at: NOW_SEC } },
      AT,
    );
    expect(Object.keys(limits ?? {}).sort()).toEqual(['at', 'fiveHour', 'week']);
  });

  it('ни одного разобранного окна или чужая форма — null', () => {
    expect(claudeLimits({}, AT)).toBeNull();
    expect(
      claudeLimits({ five_hour: { used_percentage: 'много', resets_at: NOW_SEC } }, AT),
    ).toBeNull();
    expect(claudeLimits(null, AT)).toBeNull();
    expect(claudeLimits([], AT)).toBeNull();
    expect(claudeLimits('rate_limits', AT)).toBeNull();
  });
});

describe('parseLimitsFile: файл { at, rateLimits }', () => {
  it('разбирает файл, как его пишет скрипт строки статуса; at приводится к ISO', () => {
    const text = JSON.stringify({ at: '2026-09-29T14:59:00+03:00', rateLimits });
    expect(parseLimitsFile(text)?.at).toBe(AT);
    expect(parseLimitsFile(text)?.fiveHour?.usedPercent).toBe(58);
  });

  it('битый JSON, нет at, at не дата, нет окон — null', () => {
    expect(parseLimitsFile('{')).toBeNull();
    expect(parseLimitsFile('[]')).toBeNull();
    expect(parseLimitsFile(JSON.stringify({ rateLimits }))).toBeNull();
    expect(parseLimitsFile(JSON.stringify({ at: 'вчера', rateLimits }))).toBeNull();
    expect(parseLimitsFile(JSON.stringify({ at: AT, rateLimits: {} }))).toBeNull();
  });
});

describe('dropExpiredWindows: прошедшее окно не отдаётся', () => {
  const both: ProviderLimits = {
    fiveHour: { usedPercent: 58, resetsAt: '2026-09-29T13:00:00.000Z' },
    week: { usedPercent: 41, resetsAt: '2026-09-30T12:00:00.000Z' },
    at: AT,
  };

  it('оба окна впереди — без изменений', () => {
    expect(dropExpiredWindows(both, NOW_MS)).toEqual(both);
  });

  it('пятичасовое прошло — остаётся неделя', () => {
    const later = Date.parse('2026-09-29T13:00:01.000Z');
    expect(dropExpiredWindows(both, later)).toEqual({ ...both, fiveHour: null });
  });

  it('момент сброса уже прошедший: окно с resetsAt = сейчас не отдаётся', () => {
    const atReset = Date.parse('2026-09-29T13:00:00.000Z');
    expect(dropExpiredWindows(both, atReset)?.fiveHour).toBeNull();
  });

  it('оба окна прошли — limits: null; и null остаётся null', () => {
    expect(dropExpiredWindows(both, Date.parse('2026-10-05T00:00:00.000Z'))).toBeNull();
    expect(dropExpiredWindows(null, NOW_MS)).toBeNull();
  });
});

describe('mergeLimits: свод лимитов нескольких сессий одного провайдера', () => {
  const R5 = '2026-09-29T13:00:00.000Z';
  const R5_NEXT = '2026-09-29T18:00:00.000Z';
  const RW = '2026-09-30T12:00:00.000Z';
  const RW_NEXT = '2026-10-07T12:00:00.000Z';

  const limits = (
    at: string,
    fiveHour: [number, string] | null,
    week: [number, string] | null,
    changedAt?: string,
  ): ProviderLimits => ({
    fiveHour: fiveHour === null ? null : { usedPercent: fiveHour[0], resetsAt: fiveHour[1] },
    week: week === null ? null : { usedPercent: week[0], resetsAt: week[1] },
    at,
    ...(changedAt === undefined ? {} : { changedAt }),
  });

  it('пусто — null; одна запись — она же', () => {
    expect(mergeLimits([])).toBeNull();
    const only = limits(AT, [58, R5], [41, RW]);
    expect(mergeLimits([only])).toEqual(only);
  });

  it('простаивающая сессия со свежим at и старым changedAt не перебивает ту, что работала', () => {
    // Claude Code зовёт скрипт по другим поводам (смена режима, /compact) с прежними числами:
    // `at` свежее, `changedAt` — когда числа менялись на самом деле. (Заменяет прежний тест
    // «равный resetsAt — большее usedPercent»: расход там вырос, и работавшая сессия по-прежнему побеждает.)
    const idleButFresh = limits('2026-09-29T11:59:00.000Z', [58, R5], [41, RW], '2026-09-29T09:00:00.000Z');
    const worked = limits('2026-09-29T11:00:00.000Z', [61, R5], [43, RW], '2026-09-29T11:00:00.000Z');

    for (const list of [
      [idleButFresh, worked],
      [worked, idleButFresh],
    ]) {
      const merged = mergeLimits(list);
      expect(merged?.fiveHour?.usedPercent).toBe(61);
      expect(merged?.week?.usedPercent).toBe(43);
      expect(merged?.at).toBe('2026-09-29T11:59:00.000Z');
      expect(merged?.changedAt).toBe('2026-09-29T11:00:00.000Z');
    }
  });

  it('равный resetsAt и равное время изменения — большее usedPercent', () => {
    const a = limits('2026-09-29T11:00:00.000Z', [58, R5], [41, RW], '2026-09-29T10:00:00.000Z');
    const b = limits('2026-09-29T11:30:00.000Z', [61, R5], [43, RW], '2026-09-29T10:00:00.000Z');
    for (const list of [[a, b], [b, a]]) {
      expect(mergeLimits(list)?.week?.usedPercent).toBe(43);
    }
  });

  describe('сброс лимита вендором посреди окна (реальные формы 2026-11-12)', () => {
    const RESET = '2026-11-16T16:00:00.000Z'; // resets_at 1794844800
    const staleHigh = limits('2026-11-12T08:51:00.000Z', [30, '2026-11-12T13:00:00.000Z'], [96, RESET]);
    const freshLow = limits('2026-11-12T17:22:00.000Z', null, [10, RESET]);

    it('старое 96 % без changedAt и свежее 10 % с равным resetsAt → 10', () => {
      for (const list of [[staleHigh, freshLow], [freshLow, staleHigh]]) {
        expect(mergeLimits(list)?.week).toEqual({ usedPercent: 10, resetsAt: RESET });
      }
    });

    it('смешанный порядок at: много старых файлов и несколько свежих', () => {
      const olds = [92, 94, 96, 95].map((p, i) => limits(`2026-11-12T0${i + 1}:00:00.000Z`, null, [p, RESET]));
      const news = [2, 5, 10].map((p, i) => limits(`2026-11-12T1${i + 5}:00:00.000Z`, null, [p, RESET]));
      for (const list of [[...olds, ...news], [...news, ...olds], [news[1]!, olds[2]!, news[2]!, olds[0]!, news[0]!]]) {
        expect(mergeLimits(list)?.week?.usedPercent).toBe(10);
      }
    });

    it('простаивающая сессия, повторяющая старые 96 % со свежим at, не перебивает работавшую после сброса', () => {
      const idle = limits('2026-11-12T18:00:00.000Z', null, [96, RESET], '2026-11-12T08:51:00.000Z');
      for (const list of [[idle, freshLow], [freshLow, idle]]) {
        expect(mergeLimits(list)?.week).toEqual({ usedPercent: 10, resetsAt: RESET });
      }
    });

    it('работает и для пятичасового окна', () => {
      const R = '2026-11-12T19:00:00.000Z';
      const old = limits('2026-11-12T16:00:00.000Z', [88, R], null);
      const fresh = limits('2026-11-12T17:00:00.000Z', [4, R], null, '2026-11-12T17:00:00.000Z');
      expect(mergeLimits([old, fresh])?.fiveHour?.usedPercent).toBe(4);
      expect(mergeLimits([fresh, old])?.fiveHour?.usedPercent).toBe(4);
    });

    it('окно сводится по своей записи, а не по общему changedAt свода', () => {
      // B менялась позже всех, но недельного окна у неё нет: недельное решают A и C.
      const a = limits('2026-11-12T10:00:00.000Z', null, [40, RESET], '2026-11-12T10:00:00.000Z');
      const b = limits('2026-11-12T12:00:00.000Z', [5, '2026-11-12T19:00:00.000Z'], null, '2026-11-12T12:00:00.000Z');
      const c = limits('2026-11-12T11:00:00.000Z', null, [50, RESET], '2026-11-12T11:00:00.000Z');
      expect(mergeLimits([a, b, c])?.week?.usedPercent).toBe(50);
      expect(mergeLimits([c, b, a])?.week?.usedPercent).toBe(50);
    });

    it('неизвестный resetsAt — по-прежнему последнее наблюдение по at', () => {
      const x: ProviderLimits = { fiveHour: null, week: { usedPercent: 70, resetsAt: null }, at: '2026-11-12T10:00:00.000Z', changedAt: '2026-11-12T12:00:00.000Z' };
      const y: ProviderLimits = { fiveHour: null, week: { usedPercent: 20, resetsAt: null }, at: '2026-11-12T11:00:00.000Z' };
      expect(mergeLimits([x, y])?.week?.usedPercent).toBe(20);
      expect(mergeLimits([y, x])?.week?.usedPercent).toBe(20);
    });
  });

  it('разный resetsAt — окно с более поздним сбросом, даже если оно меньше и старше по at', () => {
    const oldWindow = limits('2026-09-29T12:30:00.000Z', [90, R5], [80, RW]);
    const newWindow = limits('2026-09-29T12:00:00.000Z', [3, R5_NEXT], [1, RW_NEXT]);

    for (const list of [
      [oldWindow, newWindow],
      [newWindow, oldWindow],
    ]) {
      const merged = mergeLimits(list);
      expect(merged?.fiveHour).toEqual({ usedPercent: 3, resetsAt: R5_NEXT });
      expect(merged?.week).toEqual({ usedPercent: 1, resetsAt: RW_NEXT });
    }
  });

  it('каждое окно сводится отдельно: пятичасовое от одной сессии, недельное — от другой', () => {
    // Пятичасовое окно началось заново (сессия A), недельное у той же недели, но у B расход больше.
    // Недельное окно: у B числа менялись позже (changedAt), хотя `at` у A свежее.
    const a = limits('2026-09-29T12:00:00.000Z', [3, R5_NEXT], [40, RW], '2026-09-29T10:00:00.000Z');
    const b = limits('2026-09-29T11:00:00.000Z', [70, R5], [45, RW], '2026-09-29T11:00:00.000Z');

    const merged = mergeLimits([a, b]);
    expect(merged?.fiveHour).toEqual({ usedPercent: 3, resetsAt: R5_NEXT });
    expect(merged?.week).toEqual({ usedPercent: 45, resetsAt: RW });
  });

  it('окно есть только у одной сессии — берётся оно; нет ни у кого — null', () => {
    const onlyFive = limits('2026-09-29T12:00:00.000Z', [58, R5], null);
    const onlyWeek = limits('2026-09-29T11:00:00.000Z', null, [41, RW]);

    const merged = mergeLimits([onlyFive, onlyWeek]);
    expect(merged?.fiveHour?.usedPercent).toBe(58);
    expect(merged?.week?.usedPercent).toBe(41);
    expect(mergeLimits([onlyFive, onlyFive])?.week).toBeNull();
  });

  it('parseLimitsFile читает changedAt; битый — отсутствует', () => {
    const body = (changedAt: unknown) =>
      JSON.stringify({ at: AT, changedAt, rateLimits: { seven_day: { used_percentage: 10, resets_at: NOW_SEC + 86_400 } } });
    expect(parseLimitsFile(body('2026-09-29T11:00:00Z'))?.changedAt).toBe('2026-09-29T11:00:00.000Z');
    expect(parseLimitsFile(body('nope'))).not.toHaveProperty('changedAt');
    expect(parseLimitsFile(body(5))).not.toHaveProperty('changedAt');
  });

  it('at сводного значения — самое позднее из всех, в каком бы порядке ни пришли записи', () => {
    const early = limits('2026-09-29T10:00:00.000Z', [61, R5], [43, RW], '2026-09-29T10:00:00.000Z');
    const late = limits('2026-09-29T12:00:00.000Z', [58, R5], [41, RW], '2026-09-29T09:00:00.000Z');
    const middle = limits('2026-09-29T11:00:00.000Z', [50, R5], [40, RW], '2026-09-29T08:00:00.000Z');

    for (const list of [
      [early, late, middle],
      [late, middle, early],
      [middle, early, late],
    ]) {
      expect(mergeLimits(list)).toEqual({
        fiveHour: { usedPercent: 61, resetsAt: R5 },
        week: { usedPercent: 43, resetsAt: RW },
        at: '2026-09-29T12:00:00.000Z',
        changedAt: '2026-09-29T10:00:00.000Z',
      });
    }
  });
});

describe('isFileSafeId', () => {
  it('id сессии годится в имя файла, разделители пути и точки впереди — нет', () => {
    for (const id of ['s-01', 's-127', 'a.b_c']) expect(isFileSafeId(id)).toBe(true);
    for (const id of ['', '..', '../s-01', 's/01', '.hidden', 's 01', 'x'.repeat(65)]) {
      expect(isFileSafeId(id)).toBe(false);
    }
  });
});

describe('readWorkLimits: файлы limits/<session-id>.json одной работы', () => {
  let workDir = '';

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'parley-limits-work-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const put = async (name: string, body: string): Promise<void> => {
    await mkdir(path.join(workDir, 'limits'), { recursive: true });
    await writeFile(path.join(workDir, 'limits', name), body, 'utf8');
  };

  it('каталога limits нет — пусто, без ошибки', async () => {
    expect((await readWorkLimits(workDir)).size).toBe(0);
    expect((await readWorkLimits(path.join(workDir, 'нет-такой-работы'))).size).toBe(0);
  });

  it('id сессии берётся из имени файла; временные и битые файлы пропускаются', async () => {
    await put('s-01.json', JSON.stringify({ at: AT, rateLimits }));
    await put('s-02.json', '{ битый');
    await put('s-03.json.4242.tmp', JSON.stringify({ at: AT, rateLimits }));
    await put('заметка.txt', 'не файл лимитов');

    const found = await readWorkLimits(workDir);
    expect([...found.keys()]).toEqual(['s-01']);
    expect(found.get('s-01')?.week?.usedPercent).toBe(41.2);
  });

  it('путь файла — limits/<id>.json в каталоге работы', () => {
    expect(limitsFile('/w', 's-04')).toBe(path.join('/w', 'limits', 's-04.json'));
  });
});
