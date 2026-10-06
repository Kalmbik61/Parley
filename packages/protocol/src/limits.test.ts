/**
 * Лимиты подписок в протоколе (спека комнат Organic, 3.5, решения контролёра куска 9a): у элемента
 * `providers.list` необязательное поле `limits`, событие `providers.limitsChanged` — `{ id, limits }`.
 * Только добавления: `PROTOCOL_VERSION` остаётся 1. Схем ответов и событий в протоколе нет (zod — у
 * параметров запросов), поэтому проверяются типы: ошибка здесь видна `tsc`, а не рантайму.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { METHODS, PROTOCOL_VERSION } from './index.js';
import type { EventData, EventName, LimitWindow, ProviderLimits, Result } from './index.js';

const limits: ProviderLimits = {
  fiveHour: { usedPercent: 58, resetsAt: '2026-09-29T13:00:00.000Z' },
  week: { usedPercent: 41.2, resetsAt: '2026-09-30T12:00:00.000Z' },
  at: '2026-09-29T11:58:00.000Z',
};

describe('лимиты подписок (спека комнат, 3.5)', () => {
  it('ProviderLimits — пятичасовое и недельное окна и время; окно — процент и сброс в ISO', () => {
    expectTypeOf<ProviderLimits>().toEqualTypeOf<{
      fiveHour: LimitWindow | null;
      week: LimitWindow | null;
      at: string;
      source?: 'zai';
    }>();
    expectTypeOf<LimitWindow>().toEqualTypeOf<{ usedPercent: number; resetsAt: string | null }>();
  });

  it('providers.list: limits необязательно; хост без данных отдаёт null, старый хост молчит', () => {
    expectTypeOf<Result<'providers.list'>['providers'][number]['limits']>().toEqualTypeOf<
      ProviderLimits | null | undefined
    >();
    const list: Result<'providers.list'> = {
      providers: [
        { id: 'claude', label: 'Claude', available: true, limits },
        { id: 'codex', label: 'Codex', available: true, limits: null },
        { id: 'glm', label: 'GLM', available: false },
      ],
    };
    expect(list.providers[0]?.limits?.fiveHour?.usedPercent).toBe(58);
    expect(list.providers[1]?.limits).toBeNull();
    expect(list.providers[2]).not.toHaveProperty('limits');
  });

  it('providers.limitsChanged — событие хоста: id провайдера и его лимиты или null', () => {
    expectTypeOf<'providers.limitsChanged'>().toMatchTypeOf<EventName>();
    expectTypeOf<EventData<'providers.limitsChanged'>>().toEqualTypeOf<{
      id: string;
      limits: ProviderLimits | null;
    }>();
    const changed: EventData<'providers.limitsChanged'> = { id: 'claude', limits: null };
    expect(changed).toEqual({ id: 'claude', limits: null });
  });

  it('refresh is additive and takes no provider selector', () => {
    expect(METHODS['providers.refreshLimits'].safeParse({}).success).toBe(true);
    expectTypeOf<Result<'providers.refreshLimits'>>().toEqualTypeOf<{ ok: true }>();
  });

  it('PROTOCOL_VERSION остаётся 1: поле и событие только добавлены', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
