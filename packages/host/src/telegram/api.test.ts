import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApiError, createBotApi } from './api.js';

const TOKEN = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createBotApi', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tg-api-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('шлёт POST JSON на /bot<token>/<method> и отдаёт result', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, result: { id: 7 } }));
    const api = createBotApi({ token: TOKEN, fetch: fetchMock as unknown as typeof fetch });
    await expect(api.call('getMe', { a: 1 })).resolves.toEqual({ id: 7 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
  });

  it('ok:false даёт BotApiError со status, description и retryAfter', async () => {
    const api = createBotApi({
      token: TOKEN,
      fetch: (async () =>
        json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 5 } }, 429)) as typeof fetch,
    });
    const error = await api.call('sendMessage').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BotApiError);
    expect(error).toMatchObject({ status: 429, description: 'Too Many Requests', retryAfter: 5, method: 'sendMessage' });
  });

  it('сетевая ошибка: status 0, в сообщении и stack нет токена', async () => {
    const api = createBotApi({
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError('fetch failed', { cause: new Error(`connect ECONNRESET https://api.telegram.org/bot${TOKEN}/getUpdates`) });
      }) as typeof fetch,
    });
    const error = (await api.call('getUpdates').catch((e: unknown) => e)) as BotApiError;
    expect(error.status).toBe(0);
    expect(error.retryAfter).toBeNull();
    expect(error.message).not.toContain(TOKEN);
    expect(error.description).not.toContain(TOKEN);
    expect(error.stack ?? '').not.toContain(TOKEN);
  });

  it('download пишет файл и возвращает число байт', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
    const api = createBotApi({ token: TOKEN, fetch: fetchMock as unknown as typeof fetch });
    const dest = path.join(dir, 'f.bin');
    await expect(api.download('photos/a.jpg', dest, 10)).resolves.toBe(4);
    expect([...(await readFile(dest))]).toEqual([1, 2, 3, 4]);
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/a.jpg`);
  });

  it('download режет по maxBytes', async () => {
    const api = createBotApi({ token: TOKEN, fetch: (async () => new Response(new Uint8Array(20))) as typeof fetch });
    const error = (await api.download('x', path.join(dir, 'big.bin'), 10).catch((e: unknown) => e)) as BotApiError;
    expect(error).toBeInstanceOf(BotApiError);
    expect(error).toMatchObject({ status: 0, description: 'file too large' });
  });
});
