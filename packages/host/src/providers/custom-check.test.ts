import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@parley/core';
import { CUSTOM_CHECK_MAX_BYTES, checkAnthropicEndpoint, createCustomCheckService, messagesUrl } from './custom-check.js';

const target = { baseUrl: 'https://api.example.com/anthropic', auth: 'bearer' as const, model: 'm-sonnet' };
const KEY = 'sk-secret-1234567890';

const reply = (status: number, body: unknown = { type: 'message' }): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('custom-check', () => {
  it('Review Focus 2: messagesUrl', () => {
    expect(messagesUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1/messages');
    expect(messagesUrl('https://openrouter.ai/api')).toBe('https://openrouter.ai/api/v1/messages');
    expect(messagesUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(messagesUrl('http://localhost:11434//')).toBe('http://localhost:11434/v1/messages');
  });

  it('заголовки: bearer, api-key, без ключа', async () => {
    const seen: Array<Record<string, string>> = [];
    const spy = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response('{"type":"message"}', { status: 200 });
    }) as unknown as typeof fetch;
    await checkAnthropicEndpoint(target, KEY, { fetch: spy });
    await checkAnthropicEndpoint({ ...target, auth: 'api-key' }, KEY, { fetch: spy });
    await checkAnthropicEndpoint(target, null, { fetch: spy });
    expect(seen[0]).toMatchObject({ Authorization: `Bearer ${KEY}`, 'anthropic-version': '2023-06-01' });
    expect(seen[0]).not.toHaveProperty('x-api-key');
    expect(seen[1]).toMatchObject({ 'x-api-key': KEY });
    expect(seen[1]).not.toHaveProperty('Authorization');
    expect(seen[2]).not.toHaveProperty('Authorization');
    expect(seen[2]).not.toHaveProperty('x-api-key');
  });

  it('тело: модель, max_tokens 1; redirect: error; адрес', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const spy = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response('{"type":"message"}', { status: 200 });
    }) as unknown as typeof fetch;
    await checkAnthropicEndpoint(target, KEY, { fetch: spy });
    const [url, init] = calls[0]!;
    expect(url).toBe('https://api.example.com/anthropic/v1/messages');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'm-sonnet',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('исходы: ok, 401, 429, 5xx, таймаут, сеть', async () => {
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: reply(200) })).toEqual({ state: 'ok' });
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: reply(401, {}) })).toMatchObject({
      state: 'failed',
      reason: 'authentication',
      httpStatus: 401,
    });
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: reply(429, {}) })).toMatchObject({ reason: 'rate_limited' });
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: reply(503, {}) })).toMatchObject({ reason: 'server_error' });
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: reply(200, { foo: 1 }) })).toMatchObject({
      state: 'failed',
      reason: 'unsupported_response',
    });
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: hang, timeoutMs: 20 })).toMatchObject({ reason: 'timeout' });
    const boom = (async () => {
      throw new Error(`connect failed for ${KEY}`);
    }) as unknown as typeof fetch;
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: boom })).toEqual({ state: 'failed', reason: 'network' });
  });

  it('ключ не попадает в исход', async () => {
    const echo = (async () => new Response(JSON.stringify({ error: { message: KEY } }), { status: 401 })) as typeof fetch;
    const outcome = await checkAnthropicEndpoint(target, KEY, { fetch: echo });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(await checkAnthropicEndpoint(target, 'ключ-с-кириллицей', { fetch: echo })).toMatchObject({ reason: 'authentication' });
  });

  it('сервис: один запрос на параллельные run, forget сбрасывает, broadcast при смене исхода', async () => {
    const broadcast = vi.fn();
    let count = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = (async () => {
      count += 1;
      await gate;
      return new Response('{"type":"message"}', { status: 200 });
    }) as unknown as typeof fetch;
    const service = createCustomCheckService({ broadcast } as never, { fetch: slow });
    const entry = {
      id: 'custom-kimi',
      custom: { id: 'custom-kimi', baseUrl: target.baseUrl, auth: 'bearer', models: { sonnet: 'm-sonnet' } },
    } as unknown as ProviderEntry;
    expect(service.current('custom-kimi', KEY)).toBeNull();
    const a = service.run(entry, KEY);
    const b = service.run(entry, KEY);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(count).toBe(1);
    expect(ra).toBe(rb);
    expect(ra.state).toBe('ok');
    expect(service.current('custom-kimi', KEY)).toEqual(ra);
    expect(service.current('custom-kimi', 'other-key')).toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('providers.changed', { provider: 'custom-kimi' });
    await service.run(entry, KEY);
    expect(broadcast).toHaveBeenCalledTimes(1);
    service.forget('custom-kimi');
    expect(service.current('custom-kimi', KEY)).toBeNull();
  });

  it('маркер контекста [1m] в модель запроса не попадает', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const spy = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response('{"type":"message"}', { status: 200 });
    }) as unknown as typeof fetch;
    await checkAnthropicEndpoint({ ...target, model: 'kimi-k3[1m]' }, KEY, { fetch: spy });
    expect(bodies[0]!['model']).toBe('kimi-k3');
  });

  it('предел тела: content-length больше предела и поток больше предела — unsupported_response', async () => {
    const declared = (async () => new Response('{"type":"message"}', {
      status: 200, headers: { 'content-length': String(CUSTOM_CHECK_MAX_BYTES + 1) },
    })) as unknown as typeof fetch;
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: declared })).toMatchObject({
      state: 'failed', reason: 'unsupported_response', httpStatus: 200,
    });
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const endless = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: endless, timeoutMs: 5_000 })).toMatchObject({
      state: 'failed', reason: 'unsupported_response', httpStatus: 200,
    });
    expect(cancelled).toBe(true);
  });

  it('редирект (fetch бросает при redirect: error) — исход network, не отказ', async () => {
    const redirecting = (async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }) as unknown as typeof fetch;
    expect(await checkAnthropicEndpoint(target, KEY, { fetch: redirecting })).toEqual({ state: 'failed', reason: 'network' });
  });

  it('forget во время идущей проверки: исход не записывается и providers.changed нет', async () => {
    const broadcast = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = (async () => {
      await gate;
      return new Response('{"type":"message"}', { status: 200 });
    }) as unknown as typeof fetch;
    const service = createCustomCheckService({ broadcast } as never, { fetch: slow });
    const entry = {
      id: 'custom-kimi',
      custom: { id: 'custom-kimi', baseUrl: target.baseUrl, auth: 'bearer', models: { sonnet: 'm-sonnet' } },
    } as unknown as ProviderEntry;
    const running = service.run(entry, KEY);
    service.forget('custom-kimi');
    release();
    await running;
    expect(service.current('custom-kimi', KEY)).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
