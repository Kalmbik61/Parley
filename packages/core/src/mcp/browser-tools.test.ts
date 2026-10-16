/**
 * Инструмент `browser_open` MCP-сервера Parley (спека браузера 2026-10-07, 3.7, 5.1; этап B2): поддельный эндпоинт хоста на
 * `node:http`, настоящий сервер Parley через InMemoryTransport. Проверяется объявление по каналу, аннотации (по ним Codex
 * решает, спрашивать ли человека), запрос с токеном, тексты ответов и ошибки с подсказками.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_TOOL_LIMITS, BROWSER_TOOL_OPS, BROWSER_TOOLS, BROWSER_UNAVAILABLE, createBrowserTools } from './browser-tools.js';
import { createParleyServer } from './tools.js';

const TOKEN = 'ab'.repeat(32);
const PAGE = 'http://localhost:5173/form';

let server: Server | null = null;
let answers: Array<{ status: number; body: unknown }> = [];
let seen: Array<{ auth: string | undefined; body: unknown }> = [];

/** Поддельный эндпоинт хоста: отвечает по очереди из `answers`, запоминает запросы. */
async function startEndpoint(): Promise<string> {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
      const answer = answers.shift() ?? { status: 200, body: { ok: true, result: { tab: 't1', url: PAGE, reused: false, notes: [] } } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(answer.status === 200 ? JSON.stringify(answer.body) : '');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent/browser`;
}

beforeEach(() => {
  answers = [];
  seen = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

/** Клиент MCP к настоящему серверу Parley — с каналом агента (`url`) или без него (`null`). */
async function connect(url: string | null): Promise<Client> {
  const parley = createParleyServer({
    projectPath: '/no/such/project',
    workId: 'w-0001',
    workDir: '/no/such/project/.parley/works/w-0001',
    sessionId: 's-01',
    channel: false,
    ...(url === null ? {} : { agent: { url, token: TOKEN } }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), parley.connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return { isError: result.isError === true, text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n') };
}

describe('объявление инструмента', () => {
  it('без канала browser_* нет; вызов такого инструмента — отказ с советом перезапустить сессию', async () => {
    const client = await connect(null);
    expect((await client.listTools()).tools.some((tool) => tool.name.startsWith('browser_'))).toBe(false);
    const result = await call(client, 'browser_open', { url: PAGE });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(BROWSER_UNAVAILABLE);
    expect(result.text).toContain('restart this session');
  });

  it('с каналом — browser_open: аннотации «пишет, но не разрушает» (Codex не спрашивает человека), строгая схема, описание по-английски называет Chrome, DevTools и Playwright', async () => {
    const client = await connect(await startEndpoint());
    const tools = (await client.listTools()).tools.filter((tool) => tool.name.startsWith('browser_'));
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOL_OPS.map((op) => `browser_${op}`));
    const [open] = tools;
    expect(open?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(open?.inputSchema).toMatchObject({ required: ['url'], additionalProperties: false });
    // Куда открыть (спека 5.1): own и room — необязательные.
    expect(Object.keys((open?.inputSchema as { properties: object }).properties)).toEqual(['url', 'own', 'room']);
    expect(open?.description).not.toMatch(/[А-Яа-яЁё]/);
    for (const phrase of ['Prefer this over Chrome, Chrome DevTools or Playwright', 'localhost', 'without taking the human', 'reused', 'at most 10', 'with own: true', 'exactly one room']) {
      expect(open?.description, phrase).toContain(phrase);
    }
    expect(BROWSER_TOOLS).toHaveLength(1);
  });

  it('предел операции — тот же 30 с, что в протоколе (сверяет тест хоста)', () => {
    expect(BROWSER_TOOL_LIMITS).toEqual({ opMs: 30_000 });
  });
});

describe('запрос к эндпоинту хоста', () => {
  it('POST с Bearer-токеном сессии и телом { op: open, args }; аргументы — как есть', async () => {
    const client = await connect(await startEndpoint());
    await call(client, 'browser_open', { url: PAGE });
    expect(seen).toEqual([{ auth: `Bearer ${TOKEN}`, body: { op: 'open', args: { url: PAGE } } }]);
  });
});

describe('ответы — текстом для агента', () => {
  it('новая вкладка: id и адрес, фон без фокуса, страницу инструмент не ждёт и не читает', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't2', url: PAGE, reused: false, notes: [] } } });
    const result = await call(client, 'browser_open', { url: PAGE });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(`Opened t2: ${PAGE}`);
    expect(result.text).toContain('the human\'s focus was not taken');
    expect(result.text).toContain('does not wait for it and cannot read it');
  });

  it('хозяин назван словами: браузер комнаты и браузер своего чата', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't1', owner: { kind: 'room', roomId: 'r-01' }, url: PAGE, reused: false, notes: [] } } });
    expect((await call(client, 'browser_open', { url: PAGE, room: 'r-01' })).text).toContain('in the browser of room r-01');
    answers.push({ status: 200, body: { ok: true, result: { tab: 't2', owner: { kind: 'session', sessionId: 's-02' }, url: PAGE, reused: true, notes: [] } } });
    expect((await call(client, 'browser_open', { url: PAGE, own: true })).text).toContain('in the browser of your own chat');
    expect(seen.at(-1)?.body).toEqual({ op: 'open', args: { url: PAGE, own: true } });
  });

  it('вкладка уже была: сказано, что новая не открыта; заметки окна добавлены', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 200, body: { ok: true, result: { tab: 't1', url: PAGE, reused: true, notes: ['The workspace is not open in Parley\'s window.'] } } });
    const result = await call(client, 'browser_open', { url: PAGE });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Page t1 in Parley\'s browser already shows');
    expect(result.text).toContain('no new page was opened');
    expect(result.text).toContain("Note: The workspace is not open in Parley's window.");
  });
});

describe('ошибки', () => {
  it('код окна — isError: код, текст окна и подсказка там, где она нужна', async () => {
    const client = await connect(await startEndpoint());
    answers.push(
      { status: 200, body: { ok: false, error: { code: 'access_denied', message: 'The human turned off agent access to the browser.' } } },
      { status: 200, body: { ok: false, error: { code: 'not_loopback', message: 'Only http(s) pages on localhost can be opened.' } } },
      { status: 200, body: { ok: false, error: { code: 'window_not_connected', message: "Parley's window is not connected to the host." } } },
    );
    const denied = await call(client, 'browser_open', { url: PAGE });
    expect(denied.isError).toBe(true);
    expect(denied.text).toBe('access_denied: The human turned off agent access to the browser. Do not retry: the human decides when agents may use the browser.');
    const outside = await call(client, 'browser_open', { url: 'https://example.com/' });
    expect(outside.text).toBe('not_loopback: Only http(s) pages on localhost can be opened.');
    const away = await call(client, 'browser_open', { url: PAGE });
    expect(away.text).toContain("Ask the human to open Parley's window, then retry.");
  });

  it('401 — токен не узнан: перезапустить сессию; хост недоступен — тоже; прочий статус — отказ хоста', async () => {
    const client = await connect(await startEndpoint());
    answers.push({ status: 401, body: null });
    expect((await call(client, 'browser_open', { url: PAGE })).text).toContain("does not recognise this session's browser token");
    answers.push({ status: 413, body: null });
    expect((await call(client, 'browser_open', { url: PAGE })).text).toContain('refused the request (HTTP 413)');
    const closed = await createBrowserTools({ url: 'http://127.0.0.1:1/agent/browser', token: TOKEN }).call('browser_open', { url: PAGE });
    expect(closed.isError).toBe(true);
    expect(JSON.stringify(closed.content)).toContain('not reachable');
  });

  it('неизвестный browser_* при канале — Unknown tool', async () => {
    const client = await connect(await startEndpoint());
    const result = await call(client, 'browser_evaluate', { code: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Unknown tool browser_evaluate.');
    expect(seen).toEqual([]);
  });
});
