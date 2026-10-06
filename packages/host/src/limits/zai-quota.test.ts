import { afterEach, describe, expect, it, vi } from 'vitest';
import { readZaiQuota, zaiQuotaOf, ZaiQuotaError, ZAI_QUOTA_MAX_BYTES, ZAI_QUOTA_TIMEOUT_MS, ZAI_QUOTA_URL } from './zai-quota.js';

const AT = '2026-10-04T12:00:00.000Z';
// Synthetic fixtures for the single legacy shape in the official plugin quota script.
const payload = (limits: unknown = [{ type: 'TOKENS_LIMIT', percentage: 37.5 }]) => ({ success: true, data: { limits } });
const response = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => vi.useRealTimers());

describe('Z.ai quota parsing', () => {
  it('accepts only one unqualified token window, retaining unknown reset and provenance', () => {
    expect(zaiQuotaOf(payload(), AT)).toEqual({ source: 'zai', at: AT, fiveHour: { usedPercent: 37.5, resetsAt: null }, week: null });
    expect(zaiQuotaOf(payload([{ type: 'TOKENS_LIMIT', percentage: 120 }]), AT).fiveHour?.usedPercent).toBe(100);
  });

  it.each([
    payload([{ type: 'TOKENS_LIMIT', percentage: 40, unit: 3, number: 5 }]),
    payload([{ type: 'TOKENS_LIMIT', percentage: 40 }, { type: 'TOKENS_LIMIT', percentage: 50 }]),
    payload([{ type: 'CREDIT_LIMIT', percentage: 40 }]),
    payload([{ type: 'TOKENS_LIMIT', percentage: '40' }]),
    payload([{ type: 'TOKENS_LIMIT', percentage: NaN }]),
    payload([]), {}, null,
  ])('does not guess unsupported window meaning', (value) => {
    expect(() => zaiQuotaOf(value, AT)).toThrow(ZaiQuotaError);
    expect(() => zaiQuotaOf(value, AT)).toThrow(expect.objectContaining({ reason: 'unsupported_response' }));
  });

  it.each([401, '401'])('rejects HTTP-success envelopes with authentication code %s', (code) => {
    expect(() => zaiQuotaOf({ success: false, code, msg: 'upstream-secret' }, AT)).toThrow('GLM quota authentication failed');
    expect(() => zaiQuotaOf({ success: false, code, msg: 'upstream-secret' }, AT)).toThrow(expect.objectContaining({ reason: 'authentication' }));
  });

  it('classifies other application failures as unavailable', () => {
    expect(() => zaiQuotaOf({ success: false, code: 500, msg: 'upstream-secret' }, AT)).toThrow(expect.objectContaining({ reason: 'unavailable', message: 'Unable to refresh GLM quota' }));
  });
});

describe('Z.ai credit windows (monitor API, сверено живым ответом 2026-10-05)', () => {
  // Живой ответ monitor API на тарифе Lite (числа и времена сброса — как пришли, ключа нет).
  const NOW = '2026-10-05T16:50:00.000Z';
  const fiveHour = { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 1018, remaining: 981, percentage: 50, nextResetTime: 1791220767696 };
  const week = { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 3092, remaining: 6907, percentage: 30, nextResetTime: 1791672337984 };
  const live = (limits: unknown[]) => ({ code: 200, msg: 'Operation successful', data: { limits, level: 'lite' }, success: true });

  it('пятичасовое и недельное окна с временем сброса', () => {
    expect(zaiQuotaOf(live([fiveHour, week]), NOW)).toEqual({
      source: 'zai',
      at: NOW,
      fiveHour: { usedPercent: 50, resetsAt: '2026-10-05T17:19:27.696Z' },
      week: { usedPercent: 30, resetsAt: '2026-10-10T22:45:37.984Z' },
    });
  });

  it('одно из окон — второе остаётся неизвестным; без времени сброса — resetsAt: null', () => {
    expect(zaiQuotaOf(live([week]), NOW)).toMatchObject({ fiveHour: null, week: { usedPercent: 30 } });
    expect(zaiQuotaOf(live([{ ...fiveHour, nextResetTime: undefined }]), NOW)).toMatchObject({
      fiveHour: { usedPercent: 50, resetsAt: null }, week: null,
    });
  });

  it('пустое пятичасовое окно после сброса приходит без nextResetTime — 0 %, время сброса неизвестно', () => {
    // Тот же ответ через 12 минут после сброса окна (живая проверка 2026-10-05).
    const idle = { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 };
    expect(zaiQuotaOf(live([idle, week]), NOW)).toMatchObject({
      fiveHour: { usedPercent: 0, resetsAt: null }, week: { usedPercent: 30 },
    });
  });

  it('месячный MCP (TIME_LIMIT) и незнакомые сочетания unit/number не толкуются', () => {
    const mcp = { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 3, percentage: 3 };
    expect(zaiQuotaOf(live([fiveHour, mcp, { ...week, unit: 5 }]), NOW)).toMatchObject({ fiveHour: { usedPercent: 50 }, week: null });
    expect(() => zaiQuotaOf(live([{ ...fiveHour, number: 4 }, mcp]), NOW)).toThrow(expect.objectContaining({ reason: 'unsupported_response' }));
  });

  it('сброс дальше длины окна — коды значат не то, окно не толкуется', () => {
    const tooFar = { ...fiveHour, nextResetTime: Date.parse(NOW) + 6 * 3_600_000 };
    expect(zaiQuotaOf(live([tooFar, week]), NOW)).toMatchObject({ fiveHour: null, week: { usedPercent: 30 } });
    expect(() => zaiQuotaOf(live([tooFar]), NOW)).toThrow(expect.objectContaining({ reason: 'unsupported_response' }));
  });

  it('два одинаковых окна или процент не числом — отказ, а не догадка', () => {
    expect(() => zaiQuotaOf(live([fiveHour, { ...fiveHour, percentage: 70 }]), NOW)).toThrow(expect.objectContaining({ reason: 'unsupported_response' }));
    expect(() => zaiQuotaOf(live([{ ...week, percentage: '30' }]), NOW)).toThrow(expect.objectContaining({ reason: 'unsupported_response' }));
  });

  it('кредитные окна главнее старого TOKENS_LIMIT; процент зажат в 0–100', () => {
    expect(zaiQuotaOf(live([{ type: 'TOKENS_LIMIT', percentage: 90 }, { ...fiveHour, percentage: 120 }]), NOW)).toMatchObject({
      fiveHour: { usedPercent: 100 }, week: null,
    });
  });

  it('readZaiQuota на живом ответе отдаёт оба окна', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(live([fiveHour, week])));
    expect(await readZaiQuota('synthetic-key', { fetch, now: () => Date.parse(NOW) })).toMatchObject({
      fiveHour: { usedPercent: 50 }, week: { usedPercent: 30 }, source: 'zai',
    });
  });
});

describe('bounded host transport', () => {
  it('uses raw Authorization once at the fixed endpoint without redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(payload()));
    expect(await readZaiQuota('synthetic-key', { fetch, now: () => Date.parse(AT) })).toMatchObject({ at: AT, source: 'zai' });
    expect(fetch).toHaveBeenCalledWith(ZAI_QUOTA_URL, expect.objectContaining({ method: 'GET', headers: { Authorization: 'synthetic-key', Accept: 'application/json' }, redirect: 'error', signal: expect.any(AbortSignal) }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries Bearer or exposes HTTP200 failure payloads', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ success: false, code: 401, msg: 'synthetic-key' }));
    await expect(readZaiQuota('synthetic-key', { fetch })).rejects.toMatchObject({ reason: 'authentication', message: 'GLM quota authentication failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { makeResponse: () => new Response('bad', { status: 401 }), reason: 'authentication' },
    { makeResponse: () => new Response('bad', { status: 503 }), reason: 'unavailable' },
    { makeResponse: () => new Response('synthetic-key', { headers: { 'content-length': String(ZAI_QUOTA_MAX_BYTES + 1) } }), reason: 'unavailable' },
    { makeResponse: () => new Response('x'.repeat(ZAI_QUOTA_MAX_BYTES + 1)), reason: 'unavailable' },
    { makeResponse: () => new Response('invalid-json-synthetic-key'), reason: 'unsupported_response' },
    { makeResponse: () => new Response(JSON.stringify(payload([]))), reason: 'unsupported_response' },
  ])('rejects failed, malformed and oversized responses with safe reason $reason', async ({ makeResponse, reason }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(makeResponse());
    const error = await readZaiQuota('synthetic-key', { fetch }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ZaiQuotaError);
    expect(error).toMatchObject({ reason });
    expect(String(error)).not.toContain('synthetic-key');
  });

  it('sanitizes network exceptions containing credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Authorization: synthetic-key'));
    await expect(readZaiQuota('synthetic-key', { fetch })).rejects.toMatchObject({ reason: 'unavailable', message: 'Unable to refresh GLM quota' });
  });

  it('bounds the full request to 10 seconds even when the transport ignores abort', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const request = expect(readZaiQuota('synthetic-key', { fetch })).rejects.toMatchObject({ reason: 'timeout', message: 'Unable to refresh GLM quota' });
    await vi.advanceTimersByTimeAsync(ZAI_QUOTA_TIMEOUT_MS);
    await request;
    const options = fetch.mock.calls[0]?.[1];
    expect(options?.signal?.aborted).toBe(true);
  });

  it('retains timeout reason when abort interrupts body streaming', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        options?.signal?.addEventListener('abort', () => controller.error(new Error('synthetic-key')));
      },
    })));
    const request = expect(readZaiQuota('synthetic-key', { fetch })).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(ZAI_QUOTA_TIMEOUT_MS);
    await request;
  });
});
