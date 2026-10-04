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
