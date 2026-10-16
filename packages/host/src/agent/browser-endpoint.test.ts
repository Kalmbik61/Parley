/**
 * Приёмник операций агента (спека браузера 2026-10-07, 3.7; этап B2) на настоящем `node:http`: токен сессии, схема
 * протокола, одно окно с возможностью `browser-agent`, ответ окна, срок, уход окна и журнал без путей адресов и токенов.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_AGENT_FEATURE } from '@parley/protocol';
import type { BrowserAgentOpEvent, EventMessage, ResponseMessage, SessionRef } from '@parley/protocol';
import { silentLog } from '../../test/feed-fakes.js';
import type { Client } from '../client.js';
import { createBrowserEndpoint } from './browser-endpoint.js';

const REF: SessionRef = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const OTHER: SessionRef = { projectPath: '/proj', workId: 'w-2', sessionId: 's-01' };
const PAGE = 'http://localhost:5173/';

type FakeClient = Client & { sent: Array<ResponseMessage | EventMessage> };

let counter = 0;
/** Клиент хоста: окно нынешней сборки заявляет `browser-agent`, окно старой — нет. */
function fakeWindow(features: string[] = [BROWSER_AGENT_FEATURE], name = 'desktop'): FakeClient {
  counter += 1;
  const sent: Array<ResponseMessage | EventMessage> = [];
  return {
    id: `client-${counter}`,
    name,
    features: new Set(features),
    sent,
    send(message) {
      sent.push(message);
      return true;
    },
    writableLength: () => 0,
    close() {},
  };
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

async function boot(clients: Client[], timeoutMs?: number, roomsOf: (ref: SessionRef) => readonly string[] = () => []) {
  const log = silentLog();
  const endpoint = createBrowserEndpoint({ log, clients: () => clients, roomsOf, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const server = createServer((req, res) => endpoint.handle(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/browser`;
  return { endpoint, url, log, token: endpoint.register(REF) };
}

interface Reply {
  status: number;
  body: string;
}

function post(url: string, body: unknown, token: string | null): Promise<Reply> {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const json = (reply: Reply): unknown => JSON.parse(reply.body);

/** Ждёт `index`-ю операцию, ушедшую окну. */
async function nextOp(client: FakeClient, index = 0): Promise<BrowserAgentOpEvent> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const ops = client.sent.filter((message): message is EventMessage => 'event' in message && message.event === 'browser.agentOp');
    const op = ops[index];
    if (op !== undefined) return op.data as BrowserAgentOpEvent;
    if (Date.now() > deadline) throw new Error('операция до окна не дошла');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const OPENED = { ok: true as const, result: { tab: 't1', url: PAGE, reused: false, notes: [] } };

describe('доступ: токен сессии (Фокус ревью, п. 1)', () => {
  it('нет токена, чужой и отозванный — 401 без тела; окну ничего; токена в журнале нет', async () => {
    const window = fakeWindow();
    const { endpoint, url, token, log } = await boot([window]);
    expect(await post(url, { op: 'open', args: { url: PAGE } }, null)).toEqual({ status: 401, body: '' });
    expect(await post(url, { op: 'open', args: { url: PAGE } }, 'f'.repeat(64))).toEqual({ status: 401, body: '' });
    endpoint.unregister(REF);
    expect(await post(url, { op: 'open', args: { url: PAGE } }, token)).toEqual({ status: 401, body: '' });
    expect(window.sent).toEqual([]);
    expect(JSON.stringify([vi.mocked(log.warn).mock.calls, vi.mocked(log.info).mock.calls])).not.toContain(token);
  });

  it('перезапуск сессии: новый токен, старый — 401; токен другой сессии ведёт к ней, и работа события — её, а не названная агентом', async () => {
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window]);
    const other = endpoint.register(OTHER);
    const again = endpoint.register(REF);
    expect(again).toMatch(/^[0-9a-f]{64}$/);
    expect(again).not.toBe(token);
    expect((await post(url, { op: 'open', args: { url: PAGE } }, token)).status).toBe(401);
    // Работу агент назвать не может: схема строгая, лишнее поле — отказ, окну ничего не уходит.
    const forged = json(await post(url, { op: 'open', args: { url: PAGE, workKey: '/proj w-1' } }, other)) as { error: { code: string } };
    expect(forged.error.code).toBe('bad_request');
    expect(window.sent).toEqual([]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, other);
    const op = await nextOp(window);
    expect(op.ref).toEqual(OTHER);
    endpoint.resolve(op.opId, OPENED, window);
    expect((await reply).status).toBe(200);
  });
});

describe('операция до окна и ответ', () => {
  it('операция уходит окну с browser-agent: opId, ref, метка S02, op, args; ответ окна — агенту как есть', async () => {
    const plain = fakeWindow([]);
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window, plain]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(op).toMatchObject({ ref: REF, label: 'S02', op: 'open', args: { url: PAGE } });
    expect(op.opId).toMatch(/^[0-9a-f-]{36}$/);
    expect(plain.sent).toEqual([]);
    expect(endpoint.resolve(op.opId, OPENED, window)).toBe(true);
    expect(json(await reply)).toEqual(OPENED);
  });

  it('owners события: сама сессия и комнаты, названные roomsOf; список берётся на каждую операцию заново (спека 3.10)', async () => {
    const window = fakeWindow();
    let rooms: string[] = ['r-01', 'r-03'];
    const { endpoint, url, token } = await boot([window], undefined, () => rooms);
    const first = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op1 = await nextOp(window);
    expect(op1.owners).toEqual([
      { kind: 'session', sessionId: 's-02' },
      { kind: 'room', roomId: 'r-01' },
      { kind: 'room', roomId: 'r-03' },
    ]);
    endpoint.resolve(op1.opId, OPENED, window);
    await first;
    rooms = [];
    const second = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op2 = await nextOp(window, 1);
    expect(op2.owners).toEqual([{ kind: 'session', sessionId: 's-02' }]);
    endpoint.resolve(op2.opId, OPENED, window);
    await second;
  });

  it('roomsOf получает ref сессии по токену, а не из тела', async () => {
    const window = fakeWindow();
    const seen: SessionRef[] = [];
    const { endpoint, url, token } = await boot([window], undefined, (ref) => {
      seen.push(ref);
      return [];
    });
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(seen).toEqual([REF]);
    endpoint.resolve(op.opId, OPENED, window);
    await reply;
  });

  it('два окна с возможностью — операция только последнему подключившемуся', async () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const { endpoint, url, token } = await boot([first, second]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(second);
    expect(first.sent).toEqual([]);
    endpoint.resolve(op.opId, OPENED, second);
    expect((await reply).status).toBe(200);
  });

  it('окон нет — сразу window_not_connected; есть только окно старой сборки — unsupported', async () => {
    const none = await boot([]);
    expect(json(await post(none.url, { op: 'open', args: { url: PAGE } }, none.token))).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });
    const old = await boot([fakeWindow([])]);
    expect(json(await post(old.url, { op: 'open', args: { url: PAGE } }, old.token))).toMatchObject({ ok: false, error: { code: 'unsupported' } });
  });

  it('схема: неизвестная операция, неверные аргументы, не JSON — bad_request, окну ничего', async () => {
    const window = fakeWindow();
    const { url, token } = await boot([window]);
    for (const body of [
      { op: 'evaluate', args: { code: '1' } },
      { op: 'open', args: {} },
      { op: 'open', args: { url: 'x'.repeat(5000) } },
      { op: 'open', args: { url: PAGE, tab: 't1' } },
      '{"op":',
    ]) {
      const reply = json(await post(url, body, token)) as { ok: boolean; error: { code: string } };
      expect(reply.error.code, JSON.stringify(body).slice(0, 60)).toBe('bad_request');
    }
    expect(window.sent).toEqual([]);
  });

  it('тело больше 64 КБ — 413', async () => {
    const { url, token } = await boot([fakeWindow()]);
    const big = JSON.stringify({ op: 'open', args: { url: PAGE }, pad: 'x'.repeat(70_000) });
    // Сервер мог оборвать соединение раньше, чем клиент дописал тело: это тоже отказ по размеру.
    const status = await post(url, big, token).then(
      (reply) => reply.status,
      (error: NodeJS.ErrnoException) => (error.code === 'EPIPE' || error.code === 'ECONNRESET' ? 413 : Promise.reject(error)),
    );
    expect(status).toBe(413);
  });
});

describe('сроки и уход окна (Фокус ревью, п. 4)', () => {
  it('окно молчит дольше срока — timeout; поздний ответ не принят', async () => {
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window], 50);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(json(await reply)).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(endpoint.resolve(op.opId, OPENED, window)).toBe(false);
  });

  it('окно ушло посреди операции — сразу window_not_connected; ответ чужого клиента не принят', async () => {
    const stranger = fakeWindow();
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([stranger, window]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    const op = await nextOp(window);
    expect(endpoint.resolve(op.opId, OPENED, stranger)).toBe(false);
    const started = Date.now();
    endpoint.dropClient(window);
    expect(json(await reply)).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('close(): висящим — window_not_connected', async () => {
    const window = fakeWindow();
    const { endpoint, url, token } = await boot([window]);
    const reply = post(url, { op: 'open', args: { url: PAGE } }, token);
    await nextOp(window);
    endpoint.close();
    expect(json(await reply)).toMatchObject({ ok: false, error: { code: 'window_not_connected' } });
  });
});

describe('журнал хоста', () => {
  it('одна строка на операцию: сессия, операция, вкладка, origin, исход — без пути и query адреса, без токена', async () => {
    const window = fakeWindow();
    const { endpoint, url, token, log } = await boot([window]);
    const asked = 'http://localhost:5173/settings/ARG-PATH?token=URL-SECRET#HASH-SECRET';
    const reply = post(url, { op: 'open', args: { url: asked } }, token);
    const op = await nextOp(window);
    endpoint.resolve(op.opId, { ok: true, result: { tab: 't1', url: asked, reused: false, notes: [] } }, window);
    await reply;
    const lines = vi.mocked(log.info).mock.calls.filter(([message]) => message === 'операция агента в браузере');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({
      projectPath: '/proj',
      workId: 'w-1',
      sessionId: 's-02',
      op: 'browser.agentOp',
      agentOp: 'open',
      tab: 't1',
      origin: 'http://localhost:5173',
      outcome: 'ok',
      ms: expect.any(Number),
    });
    const all = JSON.stringify(vi.mocked(log.info).mock.calls);
    for (const secret of ['ARG-PATH', 'URL-SECRET', 'HASH-SECRET', token]) expect(all).not.toContain(secret);
  });

  it('отказ окна и отсутствие окна тоже в журнале: исход — код; адрес не из http — origin пуст', async () => {
    const window = fakeWindow();
    const { endpoint, url, token, log } = await boot([window]);
    const reply = post(url, { op: 'open', args: { url: 'javascript:alert(1)' } }, token);
    const op = await nextOp(window);
    endpoint.resolve(op.opId, { ok: false, error: { code: 'not_loopback', message: 'Only localhost.' } }, window);
    await reply;
    const none = await boot([]);
    await post(none.url, { op: 'open', args: { url: PAGE } }, none.token);
    expect(vi.mocked(log.info).mock.calls.at(-1)?.[1]).toMatchObject({ op: 'browser.agentOp', agentOp: 'open', tab: null, origin: null, outcome: 'not_loopback' });
    expect(vi.mocked(none.log.info).mock.calls.at(-1)?.[1]).toMatchObject({ outcome: 'window_not_connected', origin: 'http://localhost:5173', ms: 0 });
  });
});
