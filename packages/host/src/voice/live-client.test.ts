import { describe, expect, it, vi } from 'vitest';
import { LiveError, createLiveClient, type LiveSocket } from './live-client.js';

const KEY = 'sk-MARKER-1234567890';

class FakeSocket implements LiveSocket {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  closed = 0;
  headers: Record<string, string> = {};
  url = '';
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const okResponse = (body: unknown, status = 201): Response => new Response(JSON.stringify(body), { status });

const setup = (fetchImpl: typeof fetch, connectTimeoutMs?: number) => {
  const socket = new FakeSocket();
  const client = createLiveClient({
    fetch: fetchImpl,
    readKey: async () => KEY,
    openSocket: (url, headers) => {
      socket.url = url;
      socket.headers = headers;
      return socket;
    },
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
  });
  return { socket, client };
};

const openAttach = async (client: ReturnType<typeof setup>['client'], socket: FakeSocket) => {
  const pending = client.attach('sess_1');
  // readKey асинхронный: сокет открывается на следующих тиках.
  await new Promise((resolve) => setImmediate(resolve));
  socket.onopen?.({});
  return pending;
};

describe('live-client', () => {
  it('ключ только в заголовке Authorization и в заголовках сокета; не в теле, URL и результате', async () => {
    const fetchMock = vi.fn(async () => okResponse({ session: { id: 'sess_1' }, transport: { type: 'webrtc', sdp: 'answer' } }));
    const { client, socket } = setup(fetchMock as unknown as typeof fetch);
    const result = await client.createSession('offer');
    expect(result).toEqual({ sessionId: 'sess_1', sdpAnswer: 'answer' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/live/sessions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    await openAttach(client, socket);
    expect(socket.url).toBe('wss://api.openai.com/v1/live/sessions/sess_1/attach');
    expect(socket.url).not.toContain(KEY);
    expect(socket.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('отказ fetch с ключом в сообщении возвращается очищенным', async () => {
    const { client } = setup((async () => {
      throw new Error(`boom ${KEY}`);
    }) as unknown as typeof fetch);
    const error = await client.createSession('offer').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveError);
    expect((error as LiveError).message).not.toContain(KEY);
    expect((error as LiveError).message).toContain('[key]');
  });

  it('не 201: ошибка без тела ответа', async () => {
    const { client } = setup((async () => new Response(`secret body ${KEY}`, { status: 401 })) as unknown as typeof fetch);
    const error = (await client.createSession('offer').catch((e: unknown) => e)) as LiveError;
    expect(error.code).toBe('http');
    expect(error.message).toBe('Live session request failed: HTTP 401');
  });

  it('кривое тело: bad_response', async () => {
    const notJson = setup((async () => new Response('nope', { status: 201 })) as unknown as typeof fetch);
    expect(((await notJson.client.createSession('o').catch((e: unknown) => e)) as LiveError).code).toBe('bad_response');
    const noId = setup((async () => okResponse({ session: {}, transport: { sdp: 'x' } })) as unknown as typeof fetch);
    expect(((await noId.client.createSession('o').catch((e: unknown) => e)) as LiveError).code).toBe('bad_response');
  });

  it('нет ключа: no_key', async () => {
    const client = createLiveClient({ readKey: async () => null });
    expect(((await client.createSession('o').catch((e: unknown) => e)) as LiveError).code).toBe('no_key');
  });

  it('usage доходит до onUsage, session.closed — один раз, поздний onclose не дублирует; сокет закрывается', async () => {
    const { client, socket } = setup(vi.fn() as unknown as typeof fetch);
    const sideband = await openAttach(client, socket);
    const usage: number[] = [];
    const closed: unknown[] = [];
    sideband.onUsage((s) => usage.push(s));
    sideband.onClosed((c) => closed.push(c));
    socket.emit({ type: 'session.usage.updated', usage: { seconds: 20 } });
    socket.emit({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 25 } });
    socket.onclose?.({});
    expect(usage).toEqual([20]);
    expect(closed).toEqual([{ seconds: 25, reason: 'close_requested' }]);
    expect(socket.closed).toBe(1);
    sideband.requestClose();
    expect(socket.sent).toEqual([]);
  });

  it('requestClose шлёт session.close; send, бросающий исключение, не ломает вызов', async () => {
    const { client, socket } = setup(vi.fn() as unknown as typeof fetch);
    const sideband = await openAttach(client, socket);
    sideband.requestClose();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'session.close' })]);
    socket.send = () => {
      throw new Error('closing');
    };
    expect(() => sideband.requestClose()).not.toThrow();
  });

  it('обрыв сокета без session.closed — onDisconnected один раз, ложного closed нет', async () => {
    const { client, socket } = setup(vi.fn() as unknown as typeof fetch);
    const sideband = await openAttach(client, socket);
    const closed: unknown[] = [];
    let disconnected = 0;
    sideband.onClosed((c) => closed.push(c));
    sideband.onDisconnected(() => (disconnected += 1));
    socket.onclose?.({});
    socket.onclose?.({});
    expect(closed).toEqual([]);
    expect(disconnected).toBe(1);
  });

  it('createSession: 201 с id, но без SDP — ошибка несёт id; fetch получает signal', async () => {
    const fetchMock = vi.fn(async () => okResponse({ session: { id: 'sess_9' }, transport: {} }));
    const { client } = setup(fetchMock as unknown as typeof fetch);
    const error = (await client.createSession('o').catch((e: unknown) => e)) as LiveError;
    expect(error.code).toBe('bad_response');
    expect(error.sessionId).toBe('sess_9');
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('таймаут подключения отклоняет и закрывает сокет', async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = setup(vi.fn() as unknown as typeof fetch, 50);
      const pending = client.attach('sess_1').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(60);
      expect(((await pending) as LiveError).code).toBe('sideband');
      expect(socket.closed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('исключение конструктора сокета приходит как LiveError без ключа', async () => {
    const client = createLiveClient({
      readKey: async () => KEY,
      openSocket: () => {
        throw new Error(`ctor ${KEY}`);
      },
    });
    const error = (await client.attach('s').catch((e: unknown) => e)) as LiveError;
    expect(error).toBeInstanceOf(LiveError);
    expect(error.code).toBe('sideband');
    expect(error.message).not.toContain(KEY);
  });
});
