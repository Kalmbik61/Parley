/**
 * Лимиты подписок в хосте (спека комнат Organic, 3.5, кусок 9a): последнее значение на провайдера
 * из файлов строки статуса Claude Code и из логов Codex, окно с прошедшим сбросом не отдаётся,
 * событие `providers.limitsChanged` — при изменении и молчание без него. Часы и таймер подменены,
 * настоящие `claude` и `codex` не запускаются, логи человека не читаются: всё во временных
 * каталогах.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSession, createWork, updateMap, workPaths } from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { EventData, EventName } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createLimitsService, LIMITS_POLL_MS, limitsOptionsFromEnv } from './limits-service.js';
import type { LimitsService } from './limits-service.js';

const T0 = Date.parse('2026-09-29T12:00:00.000Z');
const sec = (ms: number): number => Math.floor(ms / 1000);

let home = '';
let projectA = '';
let projectB = '';
let codexRoot = '';
let now = T0;
let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let services: LimitsService[] = [];

/** Минимальный `HostContext`: сервису нужны только `log` и `broadcast`. */
const fakeHost = (): HostContext => ({
  version: '0.0.0',
  startedAt: new Date().toISOString(),
  paths: { dir: '', socket: '', token: '', pid: '', log: '' },
  log: { info: () => {}, warn: () => {}, error: () => {} },
  clients: () => [],
  liveSessions: () => 0,
  broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
  onShutdown: () => {},
  shutdown: async () => {},
  busy: () => {},
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-limits-home-'));
  projectA = await mkdtemp(path.join(tmpdir(), 'parley-limits-a-'));
  projectB = await mkdtemp(path.join(tmpdir(), 'parley-limits-b-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-limits-codex-'));
  process.env.PARLEY_HOME = home;
  now = T0;
  broadcasts = [];
});

afterEach(async () => {
  for (const service of services) service.stop();
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all(
    [home, projectA, projectB, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Работа с сессиями нужных провайдеров; возвращает карту с их id по порядку. */
async function work(
  project: string,
  providers: string[],
): Promise<{ map: WorkMap; ids: string[] }> {
  const created = await createWork(project, { title: 'Работа' });
  const map = await updateMap(project, created.work.id, (draft) => {
    for (const provider of providers)
      addSession(draft, { provider, label: provider, task: 'задача' });
  });
  return { map, ids: map.sessions.map((session) => session.id) };
}

/** Кладёт файл строки статуса сессии так, как его пишет скрипт: { at, rateLimits }. */
async function putLimits(
  project: string,
  map: WorkMap,
  sessionId: string,
  at: number,
  fiveHour: number | null,
  week: number | null = null,
  resets: { fiveHour?: number; week?: number } = {},
): Promise<void> {
  const rateLimits: Record<string, unknown> = {};
  if (fiveHour !== null) {
    rateLimits['five_hour'] = {
      used_percentage: fiveHour,
      resets_at: resets.fiveHour ?? sec(T0) + 3600,
    };
  }
  if (week !== null) {
    rateLimits['seven_day'] = { used_percentage: week, resets_at: resets.week ?? sec(T0) + 86_400 };
  }
  const dir = workPaths(project, map.work.id).limits;
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ at: new Date(at).toISOString(), rateLimits }),
  );
}

/** Сервис на подменённых часах и таймере; снимок работ — те карты, что передал тест. */
function service(
  maps: Array<{ project: string; map: WorkMap }>,
  extra: { intervalMs?: number } = {},
) {
  const ticks: Array<() => void> = [];
  const intervals: number[] = [];
  const created = createLimitsService(
    fakeHost(),
    {
      snapshot: () => ({
        entries: maps.map(({ project, map }) => ({ projectPath: project, map })),
        branches: {},
      }),
    },
    {
      codexRoot,
      now: () => now,
      schedule: (fn, ms) => {
        ticks.push(fn);
        intervals.push(ms);
        return () => ticks.splice(0, ticks.length);
      },
      ...extra,
    },
  );
  services.push(created);
  return { limits: created, tick: (): void => ticks.forEach((fn) => fn()), intervals };
}

const limitsEvents = (): Array<EventData<'providers.limitsChanged'>> =>
  broadcasts
    .filter((item) => item.event === 'providers.limitsChanged')
    .map((item) => item.data as EventData<'providers.limitsChanged'>);

describe('Claude: файлы строки статуса', () => {
  it('свод по файлам всех работ и проектов: числа окна — большие при том же сбросе, at — самое позднее', async () => {
    const a = await work(projectA, ['claude', 'claude']);
    const b = await work(projectB, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 600_000, 10, 5);
    await putLimits(projectA, a.map, a.ids[1]!, T0 - 60_000, 58, 41);
    await putLimits(projectB, b.map, b.ids[0]!, T0 - 300_000, 30, 20);
    const { limits } = service([
      { project: projectA, map: a.map },
      { project: projectB, map: b.map },
    ]);

    await limits.start();

    expect(limits.get('claude')).toEqual({
      fiveHour: { usedPercent: 58, resetsAt: new Date((sec(T0) + 3600) * 1000).toISOString() },
      week: { usedPercent: 41, resetsAt: new Date((sec(T0) + 86_400) * 1000).toISOString() },
      at: new Date(T0 - 60_000).toISOString(),
    });
  });

  // Спека 3.5 и решение контролёра 9a: «самое свежее по `at`» даёт устаревшим числам простаивающей
  // сессии перебить свежие, поэтому каждое окно сводится отдельно (`mergeLimits`).
  it('простаивающая сессия со свежим at, но устаревшими числами не перебивает числа той, что работала', async () => {
    const a = await work(projectA, ['claude', 'claude']);
    // Claude Code зовёт скрипт и по другим поводам (смена режима, /compact): `at` свежий,
    // числа прежние.
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    await putLimits(projectA, a.map, a.ids[1]!, T0 - 600_000, 61, 43);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limits.get('claude')).toEqual({
      fiveHour: { usedPercent: 61, resetsAt: new Date((sec(T0) + 3600) * 1000).toISOString() },
      week: { usedPercent: 43, resetsAt: new Date((sec(T0) + 86_400) * 1000).toISOString() },
      at: new Date(T0 - 1000).toISOString(),
    });
  });

  it('окно началось заново: побеждает окно с более поздним сбросом, а не сессия со свежим at', async () => {
    const a = await work(projectA, ['claude', 'claude']);
    // Старое окно: расход большой, файл свежее по at (сессию потрогали уже после сброса других).
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 90, 80, {
      fiveHour: sec(T0) + 1800,
      week: sec(T0) + 7200,
    });
    // Новое окно: расход маленький, сброс позже.
    await putLimits(projectA, a.map, a.ids[1]!, T0 - 600_000, 3, 1, {
      fiveHour: sec(T0) + 18_000,
      week: sec(T0) + 604_800,
    });
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limits.get('claude')?.fiveHour).toEqual({
      usedPercent: 3,
      resetsAt: new Date((sec(T0) + 18_000) * 1000).toISOString(),
    });
    expect(limits.get('claude')?.week?.usedPercent).toBe(1);
  });

  it('окна сводятся по отдельности: пятичасовое от одной сессии, недельное — от другой', async () => {
    const a = await work(projectA, ['claude', 'claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 3, 40, {
      fiveHour: sec(T0) + 18_000,
      week: sec(T0) + 86_400,
    });
    await putLimits(projectA, a.map, a.ids[1]!, T0 - 600_000, 70, 45, {
      fiveHour: sec(T0) + 1800,
      week: sec(T0) + 86_400,
    });
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    // Пятичасовое — новое окно первой сессии; недельное — то же окно, где расход больше у второй.
    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(3);
    expect(limits.get('claude')?.week?.usedPercent).toBe(45);
  });

  it('файл сессии GLM не становится лимитами Claude: провайдер — по сессии из карты работы', async () => {
    const a = await work(projectA, ['claude', 'glm']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 120_000, 58, 41);
    // Файл GLM свежее — и Claude он не достаётся, лимиты GLM остаются его собственными.
    await putLimits(projectA, a.map, a.ids[1]!, T0 - 10_000, 3, null);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(58);
    expect(limits.get('claude')?.week?.usedPercent).toBe(41);
    expect(limits.get('glm')?.fiveHour?.usedPercent).toBe(3);
  });

  it('файл сессии, которой нет в карте (удалена), не считается; провайдер без файлов — null', async () => {
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, 's-99', T0 - 1000, 90, 90);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limits.get('claude')).toBeNull();
    expect(limits.get('codex')).toBeNull();
    expect(limits.get('нет-такого-провайдера')).toBeNull();
  });

  it('битый файл и файл без окон пропускаются, соседний читается', async () => {
    const a = await work(projectA, ['claude', 'claude', 'claude']);
    const dir = workPaths(projectA, a.map.work.id).limits;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${a.ids[0]!}.json`), '{ битый');
    await writeFile(
      path.join(dir, `${a.ids[1]!}.json`),
      JSON.stringify({ at: new Date(T0).toISOString(), rateLimits: {} }),
    );
    await putLimits(projectA, a.map, a.ids[2]!, T0 - 5000, 12, null);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(12);
  });
});

describe('окно с прошедшим сбросом не отдаётся', () => {
  it('пятичасовое кончилось — остаётся недельное; кончились оба — limits: null', async () => {
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41, {
      fiveHour: sec(T0) + 1800,
      week: sec(T0) + 86_400,
    });
    const { limits } = service([{ project: projectA, map: a.map }]);
    await limits.start();
    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(58);

    // Сброс пятичасового прошёл, опроса ещё не было: ответ всё равно без него.
    now = T0 + 1801_000;
    expect(limits.get('claude')?.fiveHour).toBeNull();
    expect(limits.get('claude')?.week?.usedPercent).toBe(41);

    now = T0 + 90_000_000;
    expect(limits.get('claude')).toBeNull();
  });

  it('при опросе прошедшее окно снимается и событием: пятичасовое null, потом всё null', async () => {
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41, {
      fiveHour: sec(T0) + 1800,
      week: sec(T0) + 7200,
    });
    const { limits, tick } = service([{ project: projectA, map: a.map }]);
    await limits.start();
    broadcasts = [];

    now = T0 + 1801_000;
    tick();
    await limits.refresh();
    expect(limitsEvents()).toHaveLength(1);
    expect(limitsEvents()[0]?.id).toBe('claude');
    expect(limitsEvents()[0]?.limits?.fiveHour).toBeNull();
    expect(limitsEvents()[0]?.limits?.week?.usedPercent).toBe(41);

    now = T0 + 7201_000;
    await limits.refresh();
    expect(limitsEvents()).toHaveLength(2);
    expect(limitsEvents()[1]).toEqual({ id: 'claude', limits: null });
  });
});

describe('Codex: по логу', () => {
  /** Rollout-лог с одним событием token_count. */
  async function rollout(at: number, primary: number, secondary: number): Promise<void> {
    const dir = path.join(codexRoot, '2026', '09', '29');
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      'rollout-2026-09-29T10-00-00-019a0000-0000-7000-8000-000000000001.jsonl',
    );
    const event = {
      timestamp: new Date(at).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: {
          primary: { used_percent: primary, window_minutes: 300, resets_at: sec(T0) + 3600 },
          secondary: {
            used_percent: secondary,
            window_minutes: 10_080,
            resets_at: sec(T0) + 86_400,
          },
        },
      },
    };
    await writeFile(file, `${JSON.stringify(event)}\n`);
    await utimes(file, new Date(at), new Date(at));
  }

  it('лимиты Codex — из последнего token_count самого свежего лога; Claude их не касается', async () => {
    await rollout(T0 - 30_000, 22, 7);
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limits.get('codex')?.fiveHour?.usedPercent).toBe(22);
    expect(limits.get('codex')?.week?.usedPercent).toBe(7);
    expect(limits.get('codex')?.at).toBe(new Date(T0 - 30_000).toISOString());
    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(58);
  });

  it('лога нет — null, и хост не падает', async () => {
    const { limits } = service([]);
    await limits.start();
    expect(limits.get('codex')).toBeNull();
  });
});

describe('providers.limitsChanged: событие при изменении и тишина без него', () => {
  it('первое чтение — событие на каждого провайдера с данными; провайдеры без данных молчат', async () => {
    const a = await work(projectA, ['claude', 'glm']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();

    expect(limitsEvents().map((event) => event.id)).toEqual(['claude']);
    expect(limitsEvents()[0]?.limits?.fiveHour?.usedPercent).toBe(58);
  });

  it('опрос без изменений — ни одного события; изменились числа или at — ровно одно', async () => {
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 5000, 58, 41);
    const { limits, tick } = service([{ project: projectA, map: a.map }]);
    await limits.start();
    broadcasts = [];

    tick();
    await limits.refresh();
    await limits.refresh();
    expect(limitsEvents()).toEqual([]);

    // Те же числа, но CLI отдал их позже: `at` другой — окну важно `Updated {time}`.
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    await limits.refresh();
    expect(limitsEvents()).toHaveLength(1);

    await putLimits(projectA, a.map, a.ids[0]!, T0, 61, 41);
    await limits.refresh();
    expect(limitsEvents()).toHaveLength(2);
    expect(limitsEvents()[1]?.limits?.fiveHour?.usedPercent).toBe(61);
  });

  it('данные исчезли (сессию удалили) — событие с null', async () => {
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    const maps = [{ project: projectA, map: a.map }];
    const { limits } = service(maps);
    await limits.start();
    broadcasts = [];

    maps[0] = { project: projectA, map: { ...a.map, sessions: [] } };
    await limits.refresh();

    expect(limitsEvents()).toEqual([{ id: 'claude', limits: null }]);
    expect(limits.get('claude')).toBeNull();
  });
});

describe('опрос', () => {
  it('по умолчанию не чаще раза в 30 секунд; тик перечитывает, stop гасит таймер', async () => {
    expect(LIMITS_POLL_MS).toBeGreaterThanOrEqual(30_000);
    const a = await work(projectA, ['claude']);
    const { limits, tick, intervals } = service([{ project: projectA, map: a.map }]);

    await limits.start();
    expect(intervals).toEqual([LIMITS_POLL_MS]);
    expect(limits.get('claude')).toBeNull();

    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    tick();
    await limits.refresh();
    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(58);

    limits.stop();
    await putLimits(projectA, a.map, a.ids[0]!, T0, 99, 99);
    tick();
    await limits.refresh();
    // Остановленный сервис новых данных не берёт: хост уже гасится.
    expect(limits.get('claude')?.fiveHour?.usedPercent).toBe(58);
  });

  it('свой интервал из параметров доходит до таймера (E2E окна ускоряют опрос)', async () => {
    const { limits, intervals } = service([], { intervalMs: 250 });
    await limits.start();
    expect(intervals).toEqual([250]);
  });

  it('start дожидается первого чтения: сразу после него get уже отвечает', async () => {
    const a = await work(projectA, ['claude']);
    await putLimits(projectA, a.map, a.ids[0]!, T0 - 1000, 58, 41);
    const { limits } = service([{ project: projectA, map: a.map }]);

    await limits.start();
    expect(limits.get('claude')).not.toBeNull();
  });
});

describe('PARLEY_LIMITS_POLL_MS: рычаг E2E окна', () => {
  it('число миллисекунд в допустимых пределах — период опроса', () => {
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: '200' })).toEqual({ intervalMs: 200 });
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: '250' })).toEqual({ intervalMs: 250 });
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: ' 1500 ' })).toEqual({ intervalMs: 1500 });
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: '2147483647' })).toEqual({
      intervalMs: 2_147_483_647,
    });
  });

  it('прежнее имя HARNAS_LIMITS_POLL_MS читается как запасное; PARLEY_* главнее; пустое новое не перекрывает', () => {
    expect(limitsOptionsFromEnv({ HARNAS_LIMITS_POLL_MS: '300' })).toEqual({ intervalMs: 300 });
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: '250', HARNAS_LIMITS_POLL_MS: '300' })).toEqual({
      intervalMs: 250,
    });
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: '', HARNAS_LIMITS_POLL_MS: '300' })).toEqual({
      intervalMs: 300,
    });
  });

  it('границы: меньше 200 мс — 200, больше 2147483647 — 2147483647', () => {
    expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: '1' })).toEqual({ intervalMs: 200 });
    for (const value of ['0', '-5', '199', '1.5']) {
      expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: value }), value).toEqual({
        intervalMs: 200,
      });
    }
    // Больше предела `setInterval` таймер сработал бы каждую миллисекунду.
    for (const value of ['2147483648', '99999999999', '1e12']) {
      expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: value }), value).toEqual({
        intervalMs: 2_147_483_647,
      });
    }
  });

  it('нечисловое значение — рычага нет: опрос остаётся раз в 30 секунд', () => {
    for (const value of [undefined, '', '   ', 'часто', '10s', 'NaN', 'Infinity', '-Infinity']) {
      expect(limitsOptionsFromEnv({ PARLEY_LIMITS_POLL_MS: value }), String(value)).toBeUndefined();
    }
  });
});
