import { describe, expect, it } from 'vitest';
import { LIMIT_RETRY_MS, LIMIT_RETURN_GRACE_MS, LIMIT_RETURNS_MAX, type ProviderLimits, type SessionNeed } from '@parley/core';
import {
  LIMIT_MENU_TEXT,
  limitReturnDue,
  limitReturnFromEnv,
  limitWindowFree,
  returnBlock,
  returnBlockReason,
} from './limit-return.js';

const needOf = (patch: Partial<SessionNeed> = {}): SessionNeed => ({
  kind: 'limit',
  since: '2026-10-22T10:00:00.000Z',
  detail: null,
  resetsAt: null,
  window: null,
  account: null,
  ...patch,
});

const SECOND = 1000;

describe('limitReturnDue (спека застрявших 6.3)', () => {
  it('время сброса известно — оно и запас', () => {
    const need = needOf({ resetsAt: '2026-10-22T19:27:00.000Z' });
    expect(limitReturnDue(need, 120 * SECOND, 900 * SECOND)).toBe(Date.parse('2026-10-22T19:29:00.000Z'));
    expect(limitReturnDue(need, 500, 2000)).toBe(Date.parse('2026-10-22T19:27:00.500Z'));
  });

  it('времени сброса нет — удар плюс повторный срок', () => {
    expect(limitReturnDue(needOf(), 120 * SECOND, 900 * SECOND)).toBe(Date.parse('2026-10-22T10:15:00.000Z'));
    expect(limitReturnDue(needOf(), 500, 2000)).toBe(Date.parse('2026-10-22T10:00:02.000Z'));
  });

  it('сроки по умолчанию в core — две минуты и пятнадцать', () => {
    expect(LIMIT_RETURN_GRACE_MS).toBe(120_000);
    expect(LIMIT_RETRY_MS).toBe(900_000);
  });
});

describe('returnBlock', () => {
  const clear = { hasDraft: false, screen: ['❯ '], returns: 0 };

  it('ничто не мешает — null', () => {
    expect(returnBlock(clear)).toBeNull();
    // Экрана нет (сессия без экрана в хосте) — меню на нём не увидеть.
    expect(returnBlock({ ...clear, screen: undefined })).toBeNull();
    expect(returnBlock({ ...clear, returns: LIMIT_RETURNS_MAX - 1 })).toBeNull();
  });

  it('черновик человека', () => {
    expect(returnBlock({ ...clear, hasDraft: true })).toBe('draft');
  });

  it('меню лимита на экране — и с хвостами версии 2.1.296', () => {
    expect(LIMIT_MENU_TEXT).toBe('Wait here, then continue automatically');
    for (const line of [
      `  ${LIMIT_MENU_TEXT}`,
      `❯ 1. ${LIMIT_MENU_TEXT} at 7:27pm`,
      `❯ 1. ${LIMIT_MENU_TEXT} shortly`,
      `❯ 1. ${LIMIT_MENU_TEXT} when the limit resets`,
    ]) {
      expect(returnBlock({ ...clear, screen: ['You hit your limit', line, ''] }), line).toBe('menu');
    }
    // Похожее, но не меню.
    expect(returnBlock({ ...clear, screen: ['Wait here, then stop'] })).toBeNull();
  });

  it('два автовозврата подряд уже были — третьего нет', () => {
    expect(returnBlock({ ...clear, returns: LIMIT_RETURNS_MAX })).toBe('repeated');
    expect(returnBlock({ ...clear, returns: LIMIT_RETURNS_MAX + 3 })).toBe('repeated');
  });

  it('несколько причин сразу — повтор, затем меню, затем черновик', () => {
    const menu = [LIMIT_MENU_TEXT];
    expect(returnBlock({ hasDraft: true, screen: menu, returns: LIMIT_RETURNS_MAX })).toBe('repeated');
    expect(returnBlock({ hasDraft: true, screen: menu, returns: 0 })).toBe('menu');
  });

  it('тексты причин для уведомления', () => {
    expect(returnBlockReason('draft')).toBe('unsent text in its terminal');
    expect(returnBlockReason('menu')).toBe('a menu is open in its terminal');
    expect(returnBlockReason('repeated')).toBe('it hit the limit again twice');
  });
});

describe('limitWindowFree — время сброса неизвестно, окно провайдера снова свободно (6.3)', () => {
  const limits = (patch: Partial<ProviderLimits> = {}): ProviderLimits => ({
    fiveHour: { usedPercent: 3, resetsAt: '2026-10-22T15:00:00.000Z' },
    week: null,
    at: '2026-10-22T10:05:00.000Z',
    ...patch,
  });

  it('данные новее удара, все окна ниже 100 % — свободно', () => {
    expect(limitWindowFree(needOf(), limits())).toBe(true);
    expect(limitWindowFree(needOf(), limits({ week: { usedPercent: 99.5, resetsAt: null } }))).toBe(true);
  });

  it('данные старше удара или одного возраста с ним — нет', () => {
    expect(limitWindowFree(needOf(), limits({ at: '2026-10-22T09:59:59.000Z' }))).toBe(false);
    expect(limitWindowFree(needOf(), limits({ at: needOf().since }))).toBe(false);
  });

  it('какое-то окно исчерпано, данных нет или окон нет — нет', () => {
    expect(limitWindowFree(needOf(), limits({ week: { usedPercent: 100, resetsAt: '2026-10-25T00:00:00.000Z' } }))).toBe(false);
    expect(limitWindowFree(needOf(), null)).toBe(false);
    expect(limitWindowFree(needOf(), limits({ fiveHour: null }))).toBe(false);
  });

  it('время сброса известно — вопрос не стоит', () => {
    expect(limitWindowFree(needOf({ resetsAt: '2026-10-22T19:27:00.000Z' }), limits())).toBe(false);
  });
});

describe('limitReturnFromEnv — рычаги E2E', () => {
  it('обе переменные, целые числа от 100 мс до часа', () => {
    expect(limitReturnFromEnv({ PARLEY_LIMIT_RETURN_GRACE_MS: '500', PARLEY_LIMIT_RETRY_MS: '2000' })).toEqual({
      graceMs: 500,
      retryMs: 2000,
    });
  });

  it('одна из двух — только она', () => {
    expect(limitReturnFromEnv({ PARLEY_LIMIT_RETRY_MS: '2000' })).toEqual({ retryMs: 2000 });
    expect(limitReturnFromEnv({ PARLEY_LIMIT_RETURN_GRACE_MS: '500' })).toEqual({ graceMs: 500 });
  });

  it('прежнее имя с префиксом HARNAS_ тоже читается', () => {
    expect(limitReturnFromEnv({ HARNAS_LIMIT_RETRY_MS: '3000' })).toEqual({ retryMs: 3000 });
  });

  it('края: 100 мс и час — можно; на единицу за краем, дробное, мусор, пусто — игнор', () => {
    expect(limitReturnFromEnv({ PARLEY_LIMIT_RETRY_MS: '100' })).toEqual({ retryMs: 100 });
    expect(limitReturnFromEnv({ PARLEY_LIMIT_RETRY_MS: '3600000' })).toEqual({ retryMs: 3_600_000 });
    for (const value of ['99', '3600001', '0', '-5', '1.5', 'abc', '', '  ', 'NaN', 'Infinity', '1e3x']) {
      expect(limitReturnFromEnv({ PARLEY_LIMIT_RETRY_MS: value }), value).toEqual({});
      expect(limitReturnFromEnv({ PARLEY_LIMIT_RETURN_GRACE_MS: value }), value).toEqual({});
    }
  });

  it('переменных нет — пусто', () => {
    expect(limitReturnFromEnv({})).toEqual({});
  });
});
