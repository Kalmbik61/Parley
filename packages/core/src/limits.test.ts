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
    workDir = await mkdtemp(path.join(tmpdir(), 'harnas-limits-work-'));
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
