/**
 * Тест 9 куска 9.2a: favicon вкладки браузера качает main — только image/* того же origin, что
 * страница, до 64 КБ потоком и не дольше 5 с; data:image/* — как есть.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAVICON_LIMITS, fetchFavicon } from './favicon.js';

const PAGE = 'http://127.0.0.1:5173/app/page';
const PNG_1K = new Uint8Array(1024).map((_, index) => index % 256);

type FetchFn = Parameters<typeof fetchFavicon>[2];

function response(body: BodyInit | null, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchFavicon (тест 9)', () => {
  it('image/png 1 КБ того же origin → data:image/png;base64,…', async () => {
    const fetch = vi.fn<FetchFn>(async () => response(PNG_1K, { 'content-type': 'image/png' }));
    const result = await fetchFavicon('http://127.0.0.1:5173/favicon.png', PAGE, fetch);
    expect(result).toBe(`data:image/png;base64,${Buffer.from(PNG_1K).toString('base64')}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:5173/favicon.png');
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('Content-Type с параметрами — в data: только тип', async () => {
    const fetch = vi.fn<FetchFn>(async () => response(PNG_1K, { 'content-type': 'Image/X-Icon; charset=binary' }));
    const result = await fetchFavicon('http://127.0.0.1:5173/favicon.ico', PAGE, fetch);
    expect(result?.startsWith('data:image/x-icon;base64,')).toBe(true);
  });

  it('data:image/png;base64,… — как есть, fetch не вызван; data: не картинка и больше 64 КБ — null', async () => {
    const fetch = vi.fn<FetchFn>();
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    expect(await fetchFavicon(icon, PAGE, fetch)).toBe(icon);
    expect(await fetchFavicon('data:text/html,<script>x</script>', PAGE, fetch)).toBeNull();
    expect(await fetchFavicon(`data:image/png;base64,${'A'.repeat(FAVICON_LIMITS.bytes)}`, PAGE, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('text/html → null; ответ не 2xx → null', async () => {
    const html = vi.fn<FetchFn>(async () => response('<html></html>', { 'content-type': 'text/html' }));
    expect(await fetchFavicon('http://127.0.0.1:5173/favicon.ico', PAGE, html)).toBeNull();
    const missing = vi.fn<FetchFn>(async () => response(PNG_1K, { 'content-type': 'image/png' }, 404));
    expect(await fetchFavicon('http://127.0.0.1:5173/favicon.ico', PAGE, missing)).toBeNull();
  });

  it('Content-Length: 70000 → null, тело не читалось', async () => {
    const getReader = vi.fn();
    const fake = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': '70000' }),
      body: { getReader, cancel: vi.fn(async () => {}) },
    } as unknown as Response;
    const fetch = vi.fn<FetchFn>(async () => fake);
    expect(await fetchFavicon('http://127.0.0.1:5173/favicon.png', PAGE, fetch)).toBeNull();
    expect(getReader).not.toHaveBeenCalled();
  });

  it('поток без Content-Length длиннее 64 КБ → null, чтение оборвано', async () => {
    const chunk = new Uint8Array(16 * 1024);
    let pulls = 0;
    const cancel = vi.fn();
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    const fetch = vi.fn<FetchFn>(async () => response(endless, { 'content-type': 'image/png' }));
    expect(await fetchFavicon('http://127.0.0.1:5173/favicon.png', PAGE, fetch)).toBeNull();
    expect(cancel).toHaveBeenCalled();
    // 64 КБ — четыре куска, пятый переходит предел; дальше поток не тянется.
    expect(pulls).toBeLessThanOrEqual(7);
  });

  it('чужой origin и file:///x.png → null, fetch не вызван', async () => {
    const fetch = vi.fn<FetchFn>();
    expect(await fetchFavicon('http://evil.test/favicon.ico', PAGE, fetch)).toBeNull();
    expect(await fetchFavicon('https://127.0.0.1:5173/favicon.ico', PAGE, fetch)).toBeNull();
    expect(await fetchFavicon('http://127.0.0.1:9999/favicon.ico', PAGE, fetch)).toBeNull();
    expect(await fetchFavicon('file:///x.png', PAGE, fetch)).toBeNull();
    expect(await fetchFavicon('not a url', PAGE, fetch)).toBeNull();
    expect(await fetchFavicon('http://127.0.0.1:5173/favicon.ico', 'about:blank', fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ответ дольше 5 с → null, запрос прерван', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null = null;
    // fetch, который сигнал не слушает: предел держит сам fetchFavicon, а не честность fetch.
    const fetch = vi.fn<FetchFn>((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    const result = fetchFavicon('http://127.0.0.1:5173/favicon.png', PAGE, fetch);
    await vi.advanceTimersByTimeAsync(FAVICON_LIMITS.timeoutMs - 1);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('пределы — из спеки и плана', () => {
    expect(FAVICON_LIMITS).toEqual({ bytes: 65536, timeoutMs: 5000 });
  });
});
