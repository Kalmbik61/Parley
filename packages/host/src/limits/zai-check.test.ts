/** Тестовое сообщение Z.ai: форма запроса и сведение ответа к закрытому исходу. Сети нет — `fetch` поддельный. */
import { PROVIDERS } from '@parley/core';
import { describe, expect, it, vi } from 'vitest';
import { checkZaiKey, ZAI_CHECK_MODEL } from './zai-check.js';

const KEY = 'synthetic-zai-key-0001';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const zaiError = (status: number, code: string | number): Response =>
  json(status, { error: { code, message: `upstream text ${KEY}` } });

const message = (): Response =>
  json(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'glm-5.3',
    content: [{ type: 'text', text: 'p' }],
    stop_reason: 'max_tokens',
  });

const run = (response: Response | (() => Promise<Response>)) =>
  checkZaiKey(KEY, {
    fetch: vi.fn<typeof globalThis.fetch>(typeof response === 'function' ? response : async () => response),
  });

describe('checkZaiKey: запрос', () => {
  it('одно сообщение в /v1/messages с ключом в Authorization, max_tokens 1, без редиректов', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => message());
    expect(await checkZaiKey(KEY, { fetch })).toEqual({ state: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: ZAI_CHECK_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('модель — та, на которой стартуют GLM-сессии, без пометки контекста [1m]', () => {
    expect(ZAI_CHECK_MODEL).toBe(PROVIDERS.glm.runner.settingsModel?.replace(/\[[^\]]*\]$/u, ''));
  });
});

describe('checkZaiKey: ответ Z.ai → исход', () => {
  it.each([
    [401, '1000', 'authentication'],
    [401, '1001', 'authentication'],
    [401, '1003', 'authentication'],
    [401, '1005', 'authentication'],
    [429, '1309', 'plan_expired'],
    [429, '1314', 'plan_expired'],
    [429, '1113', 'no_plan'],
    [429, '1308', 'limit_reached'],
    [429, '1310', 'limit_reached'],
    [429, '1316', 'limit_reached'],
    [429, '1317', 'limit_reached'],
    [429, '1318', 'limit_reached'],
    [429, '1319', 'limit_reached'],
    [429, '1320', 'limit_reached'],
    [429, '1321', 'limit_reached'],
    [400, '1211', 'unsupported_response'],
    [400, '1212', 'unsupported_response'],
    [429, '1311', 'model_unavailable'],
    [403, '1220', 'key_restricted'],
    [429, '1313', 'key_restricted'],
    [429, '1315', 'key_restricted'],
    [429, '1302', 'rate_limited'],
    [429, '1305', 'rate_limited'],
    [429, '1399', 'rate_limited'],
    [500, '1200', 'server_error'],
    [500, '1230', 'server_error'],
    [500, '1234', 'server_error'],
    [400, '1214', 'unsupported_response'],
    [400, '1261', 'unsupported_response'],
  ] as const)('HTTP %i, код %s → %s', async (status, code, reason) => {
    expect(await run(zaiError(status, code))).toEqual({ state: 'failed', reason, httpStatus: status, code });
  });

  it('код числом тоже читается; код с буквами — не код, решает HTTP-статус', async () => {
    expect(await run(zaiError(429, 1308))).toEqual({ state: 'failed', reason: 'limit_reached', httpStatus: 429, code: '1308' });
    expect(await run(zaiError(401, 'abc'))).toEqual({ state: 'failed', reason: 'authentication', httpStatus: 401 });
  });

  it.each([
    [401, 'authentication'],
    [403, 'key_restricted'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
    [404, 'unsupported_response'],
    [400, 'unsupported_response'],
  ] as const)('без кода Z.ai (ошибка в форме Anthropic) HTTP %i → %s', async (status, reason) => {
    const body = { type: 'error', error: { type: 'some_error', message: 'upstream text' } };
    expect(await run(json(status, body))).toEqual({ state: 'failed', reason, httpStatus: status });
  });

  it('ошибка Z.ai в ответе 200 сводится по коду', async () => {
    expect(await run(zaiError(200, '1308'))).toEqual({ state: 'failed', reason: 'limit_reached', httpStatus: 200, code: '1308' });
  });

  it('ответ вида monitor API — { success: false, code } со статусом 200: код Z.ai и код вида HTTP', async () => {
    expect(await run(json(200, { success: false, code: 401, msg: 'upstream' }))).toEqual({
      state: 'failed', reason: 'authentication', httpStatus: 200, code: '401',
    });
    expect(await run(json(200, { success: false, code: '1308', msg: 'upstream' }))).toEqual({
      state: 'failed', reason: 'limit_reached', httpStatus: 200, code: '1308',
    });
    // Верхний code без success: false — не ошибка (у сообщения его нет, но и гадать не о чем).
    expect(await run(json(200, { type: 'message', code: 200, content: [] }))).toEqual({ state: 'ok' });
  });

  it('тело оборвалось после известного статуса — исход по статусу, а не «нет сети»', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'));
        controller.error(new Error('socket reset'));
      },
    });
    expect(await run(new Response(broken, { status: 401 }))).toEqual({ state: 'failed', reason: 'authentication', httpStatus: 401 });
  });

  it('ключ с символом вне печатного ASCII — «ключ отвергнут» без запроса, а не «нет сети»', async () => {
    for (const key of ['\u201cabc.def\u201d', 'abc\u2013def', 'ключ.def']) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => message());
      expect(await checkZaiKey(key, { fetch })).toEqual({ state: 'failed', reason: 'authentication' });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('200 без сообщения и не JSON — незнакомый ответ', async () => {
    expect(await run(json(200, { hello: 'world' }))).toEqual({ state: 'failed', reason: 'unsupported_response', httpStatus: 200 });
    expect(await run(new Response('<html>proxy</html>', { status: 200 }))).toEqual({
      state: 'failed', reason: 'unsupported_response', httpStatus: 200,
    });
  });

  it('ошибка с телом не JSON решается HTTP-статусом', async () => {
    expect(await run(new Response('Bad gateway', { status: 502 }))).toEqual({ state: 'failed', reason: 'server_error', httpStatus: 502 });
  });

  it('слишком большой ответ не читается: 200 — незнакомый ответ, ошибка — по статусу', async () => {
    const huge = 'x'.repeat(300 * 1024);
    expect(await run(new Response(huge, { status: 200 }))).toEqual({ state: 'failed', reason: 'unsupported_response', httpStatus: 200 });
    expect(await run(new Response(huge, { status: 401 }))).toEqual({ state: 'failed', reason: 'authentication', httpStatus: 401 });
    expect(
      await run(new Response('{}', { status: 429, headers: { 'content-length': String(10 * 1024 * 1024) } })),
    ).toEqual({ state: 'failed', reason: 'rate_limited', httpStatus: 429 });
  });

  it('в исходе нет ни ключа, ни текста ответа Z.ai', async () => {
    const outcome = await run(zaiError(401, '1000'));
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(JSON.stringify(outcome)).not.toContain('upstream');
  });
});

describe('checkZaiKey: нет ответа', () => {
  it('таймаут обрывает запрос и даёт timeout', async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    expect(await checkZaiKey(KEY, { fetch, timeoutMs: 20 })).toEqual({ state: 'failed', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('запрос, честно оборванный по сигналу, — тоже таймаут, а не «нет сети»', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    expect(await checkZaiKey(KEY, { fetch, timeoutMs: 20 })).toEqual({ state: 'failed', reason: 'timeout' });
  });

  it('тело, застрявшее после заголовков, — тоже таймаут', async () => {
    const stuck = new ReadableStream<Uint8Array>({ start() {} });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(stuck, { status: 200 }));
    expect(await checkZaiKey(KEY, { fetch, timeoutMs: 20 })).toEqual({ state: 'failed', reason: 'timeout' });
  });

  it('запрос не дошёл (DNS, TLS, офлайн, редирект) — network', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await checkZaiKey(KEY, { fetch })).toEqual({ state: 'failed', reason: 'network' });
  });
});
