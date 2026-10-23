import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChannel } from '../work/mcp-config.js';
import { createWork, workPaths } from '../work/store.js';
import {
  AGENT_TOOLS_REQUEST_BYTES,
  ARGUMENTS_TOO_LARGE,
  HOST_NOT_RESPONDING,
  SESSION_LINK_EXPIRED,
  createRemoteToolRunner,
  launchOf,
} from './remote-tools.js';
import { createParleyServer } from './tools.js';

const TOKEN = 'a'.repeat(64);
const servers: Server[] = [];

let home = '';
let project = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close();
    await server.close();
  }
  // Зависшие запросы хоста-заглушки закрываются силой: иначе `close` ждал бы их до конца теста.
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Что хост-заглушка увидел в одном запросе. */
interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  /** Разобранное тело запроса; если это не JSON-объект — пустой объект. */
  body: Record<string, unknown>;
}

/** Хост-заглушка: `n` — номер запроса (с единицы); запросы складываются в `seen`. */
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen, n: number) => void;

async function fakeHost(handler: Handler): Promise<{ agent: AgentChannel; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        // Не JSON — тело остаётся пустым: тест сам скажет, что хост получил не то.
      }
      const entry: Seen = { method: req.method, url: req.url, authorization: req.headers.authorization, body };
      seen.push(entry);
      handler(req, res, entry, seen.length);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { agent: { url: `http://127.0.0.1:${port}/agent/browser`, token: TOKEN }, seen };
}

/** Ответ хоста: без тела (отказ маршрута) или JSON. Оборванное соединение не трогаем. */
function reply(res: ServerResponse, status: number, body?: unknown, raw?: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (body === undefined && raw === undefined) {
    res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(raw ?? JSON.stringify(body));
}

const ok = (result: unknown): { ok: true; result: unknown } => ({ ok: true, result });
const TOOL_OK = { content: [{ type: 'text', text: '{}' }] };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;

describe('createRemoteToolRunner: инструменты агента через хост (спека хранилища 6.3, 6.4)', () => {
  it('list и call уходят на /agent/tools с токеном, launch и _meta', async () => {
    const { agent, seen } = await fakeHost((_req, res, entry) =>
      reply(res, 200, entry.body['op'] === 'list' ? ok({ tools: [{ name: 'get_map', inputSchema: { type: 'object' } }] }) : ok(TOOL_OK)));
    const threadId = '019a0c2e-5d3f-7b11-9c44-8e2f6a1b3c4d';
    const runner = createRemoteToolRunner(agent, { toolProfile: 'short' });

    expect((await runner.list()).map((tool) => tool.name)).toEqual(['get_map']);
    await runner.call('get_map', {}, { threadId });

    expect(seen.map((r) => r.url)).toEqual(['/agent/tools', '/agent/tools']);
    expect(seen.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(seen[0]!.authorization).toBe(`Bearer ${agent.token}`);
    expect(seen[0]!.body).toEqual({ op: 'list', launch: { toolProfile: 'short' } });
    expect(seen[1]!.body).toMatchObject({ op: 'call', name: 'get_map', args: {}, launch: { toolProfile: 'short' }, meta: { threadId } });
    expect(seen[1]!.body['callId']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('повтор после обрыва несёт тот же callId', async () => {
    const { agent, seen } = await fakeHost((req, res, _entry, n) => (n === 1 ? req.socket.destroy() : reply(res, 200, ok(TOOL_OK))));
    const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 1_000 });

    const result = await runner.call('send_message', { to: 's-02', text: 'x' }, undefined);

    expect(result.isError).not.toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body['callId']).toBe(seen[0]!.body['callId']);
  });

  it('разные вызовы получают разные callId', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));
    const runner = createRemoteToolRunner(agent, {});

    await runner.call('get_map', {}, undefined);
    await runner.call('get_map', {}, undefined);

    expect(seen[0]!.body['callId']).not.toBe(seen[1]!.body['callId']);
  });

  it('хост молчит дольше бюджета — HOST_NOT_RESPONDING', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 503));
    const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 100 });

    const result = await runner.call('get_map', {}, undefined);

    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: HOST_NOT_RESPONDING }] });
    expect(seen.length).toBeGreaterThan(1);
  });

  it('окно повторов — от первой неудачи: хост, что не отвечает, стоит агенту пару запросов, а не по запросу на каждую паузу бюджета', async () => {
    const { agent, seen } = await fakeHost(() => { /* держит запрос, не отвечая */ });
    const runner = createRemoteToolRunner(agent, {}, { callTimeoutMs: 100, retryDelaysMs: [10], retryBudgetMs: 150 });

    const result = await runner.call('get_map', {}, undefined);

    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: HOST_NOT_RESPONDING }] });
    // Запрос живёт целый срок (100 мс), окно — 150 мс с первой неудачи: два-три запроса. Если бы бюджет считал одни паузы
    // (по 10 мс), их было бы полтора десятка, и агент ждал бы секунды (а с настоящими сроками — минуты).
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it.each([502, 503, 504])('ответ %i — повтор, затем результат', async (status) => {
    const { agent, seen } = await fakeHost((_req, res, _entry, n) => (n === 1 ? reply(res, status) : reply(res, 200, ok(TOOL_OK))));
    const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 1_000 });

    const result = await runner.call('get_map', {}, undefined);

    expect(result.isError).not.toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body['callId']).toBe(seen[0]!.body['callId']);
  });

  it('401 — без повторов, текст про перезапуск', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 401));

    const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('get_map', {}, undefined);

    expect(result).toMatchObject({ isError: true, content: [{ text: SESSION_LINK_EXPIRED }] });
    expect(seen).toHaveLength(1);
  });

  it('413 — понятный отказ про размер', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 413));

    const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('plan_submit', { goal: 'x' }, undefined);

    expect(result).toMatchObject({ isError: true, content: [{ text: ARGUMENTS_TOO_LARGE }] });
    expect(seen).toHaveLength(1);
  });

  it('аргументы больше 1 МиБ в байтах — отказ без запроса к хосту; чуть меньше — уходят', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));
    const runner = createRemoteToolRunner(agent, {});

    // «я» — два байта в UTF-8: символов меньше миллиона, байт больше.
    const wide = await runner.call('plan_submit', { goal: 'я'.repeat(AGENT_TOOLS_REQUEST_BYTES / 2) }, undefined);
    expect(wide).toMatchObject({ isError: true, content: [{ text: ARGUMENTS_TOO_LARGE }] });
    expect(seen).toHaveLength(0);

    const fits = await runner.call('plan_submit', { goal: 'x'.repeat(AGENT_TOOLS_REQUEST_BYTES - 4096) }, undefined);
    expect(fits.isError).not.toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('{ ok: false } — результат с isError и текстом хоста, без повторов', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, { ok: false, error: { code: 'bad_request', message: 'launch must be an object' } }));

    const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('get_map', {}, undefined);

    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'launch must be an object' }] });
    expect(seen).toHaveLength(1);
  });

  it('ошибка самого инструмента приходит внутри result и доходит как есть', async () => {
    const failed = { isError: true, content: [{ type: 'text', text: 'unknown tool nope' }] };
    const { agent } = await fakeHost((_req, res) => reply(res, 200, ok(failed)));

    expect(await createRemoteToolRunner(agent, {}).call('nope', {}, undefined)).toEqual(failed);
  });

  it.each([404, 500])('ответ %i — без повторов: хост отказал, статус назван', async (status) => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, status));

    const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('get_map', {}, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`Parley's host refused the request (HTTP ${status}).`);
    expect(seen).toHaveLength(1);
  });

  it('перенаправление не выполняется: токен не уходит на чужой адрес, ответ — отказ хоста', async () => {
    const elsewhere = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));
    const { agent, seen } = await fakeHost((_req, res) => {
      res.writeHead(302, { Location: elsewhere.agent.url, 'Content-Length': '0' });
      res.end();
    });

    const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('get_map', {}, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Parley's host refused the request (HTTP 302).");
    expect(seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
  });

  it.each([
    ['не JSON', undefined, 'not json'],
    ['не объект', [], undefined],
    ['пустой объект', {}, undefined],
    ['ok без result', { ok: true }, undefined],
    ['result без content', { ok: true, result: {} }, undefined],
    ['ok: false без текста', { ok: false, error: {} }, undefined],
  ] as const)('нечитаемый ответ (%s) — без повторов', async (_name, body, raw) => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, body, raw));

    const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('get_map', {}, undefined);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Parley's host sent an unreadable answer.");
    expect(seen).toHaveLength(1);
  });

  it('list: отказ хоста — исключение с текстом для агента', async () => {
    const down = await fakeHost((_req, res) => reply(res, 503));
    await expect(createRemoteToolRunner(down.agent, {}, { retryDelaysMs: [10], retryBudgetMs: 50 }).list()).rejects.toThrow(HOST_NOT_RESPONDING);

    const expired = await fakeHost((_req, res) => reply(res, 401));
    await expect(createRemoteToolRunner(expired.agent, {}).list()).rejects.toThrow(SESSION_LINK_EXPIRED);

    const garbage = await fakeHost((_req, res) => reply(res, 200, ok({ tools: 'nope' })));
    await expect(createRemoteToolRunner(garbage.agent, {}).list()).rejects.toThrow("Parley's host sent an unreadable answer.");
  });

  it('запрос дольше callTimeoutMs — повтор с тем же callId', async () => {
    // Первый запрос хост держит, не отвечая; второй отвечает сразу.
    const { agent, seen } = await fakeHost((_req, res, _entry, n) => { if (n > 1) reply(res, 200, ok(TOOL_OK)); });
    const runner = createRemoteToolRunner(agent, {}, { callTimeoutMs: 300, retryDelaysMs: [10], retryBudgetMs: 5_000 });

    const result = await runner.call('get_map', {}, undefined);

    expect(result.isError).not.toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body['callId']).toBe(seen[0]!.body['callId']);
  });

  it('wait_for ждёт ответ хоста дольше callTimeoutMs: срок — timeoutSec и ещё 30 с', async () => {
    const { agent, seen } = await fakeHost((_req, res) => { setTimeout(() => reply(res, 200, ok(TOOL_OK)), 250); });
    // Бюджет повторов мал: если бы wait_for обрывался по callTimeoutMs, тест кончился бы отказом хоста, а не долгим ожиданием.
    const runner = createRemoteToolRunner(agent, {}, { callTimeoutMs: 100, retryDelaysMs: [10], retryBudgetMs: 100 });

    const result = await runner.call('wait_for', { target: 'inbox', timeoutSec: 5 }, undefined);

    expect(result.isError).not.toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('wait_for с дробным, чужим по типу или огромным timeoutSec не роняет исполнителя: вопрос уходит хосту', async () => {
    const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));
    const runner = createRemoteToolRunner(agent, {});
    const values: unknown[] = [0.0005, 'soon', null, -5, 1e12];

    for (const timeoutSec of values) {
      const result = await runner.call('wait_for', { target: 'inbox', timeoutSec }, undefined);
      expect(result.isError, String(timeoutSec)).not.toBe(true);
    }
    expect(seen).toHaveLength(values.length);
  });

  describe('отмена вызывающим', () => {
    it('в полёте: соединение закрывается, повторов нет, ответ — Cancelled.', async () => {
      let closed = 0;
      const { agent, seen } = await fakeHost((_req, res) => { res.on('close', () => { closed += 1; }); });
      const controller = new AbortController();
      const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 5_000 });

      const pending = runner.call('wait_for', { target: 'inbox' }, undefined, controller.signal);
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 2000, interval: 10 });
      controller.abort();

      expect(await pending).toEqual({ isError: true, content: [{ type: 'text', text: 'Cancelled.' }] });
      // Хост узнаёт об отмене по закрытому соединению: по нему он перестаёт ждать.
      await vi.waitFor(() => expect(closed).toBe(1), { timeout: 2000, interval: 10 });
      await delay(60);
      expect(seen).toHaveLength(1);
    });

    it('в паузе между повторами: ждать перестаёт сразу, второго запроса нет', async () => {
      const { agent, seen } = await fakeHost((_req, res) => reply(res, 503));
      const controller = new AbortController();
      const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [60_000], retryBudgetMs: 120_000 });

      const pending = runner.call('get_map', {}, undefined, controller.signal);
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 2000, interval: 10 });
      controller.abort();

      expect(await pending).toEqual({ isError: true, content: [{ type: 'text', text: 'Cancelled.' }] });
      expect(seen).toHaveLength(1);
    });

    it('сигнал уже отменён: запроса к хосту нет', async () => {
      const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));

      const result = await createRemoteToolRunner(agent, {}).call('get_map', {}, undefined, AbortSignal.abort());

      expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Cancelled.' }] });
      expect(seen).toHaveLength(0);
    });
  });
});

describe('launchOf: снимок запуска из контекста сервера', () => {
  const base = { projectPath: '/p', workId: 'w-0001', workDir: '/p/.parley/works/w-0001', sessionId: 's-01', channel: false };

  it('берёт только четыре поля запуска; чужих полей и пустых значений нет', () => {
    expect(launchOf({ ...base, skillNavigator: true, skillListReduced: true, nativeContextRevision: 'r1', toolProfile: 'short', agent: { url: 'http://127.0.0.1:1/agent/browser', token: TOKEN }, pollMs: 40 }))
      .toEqual({ skillNavigator: true, skillListReduced: true, nativeContextRevision: 'r1', toolProfile: 'short' });
    expect(launchOf(base)).toEqual({});
    expect(launchOf({ ...base, skillNavigator: false })).toEqual({ skillNavigator: false });
  });
});

describe('сервер с удалённым исполнителем (спека хранилища 6.9, 7)', () => {
  it('в режиме канала MCP не открывает файл карты', async () => {
    const created = await createWork(project, { title: 'Работа', goal: 'цель' });
    const workId = created.work.id;
    const { agent, seen } = await fakeHost((_req, res, entry) =>
      reply(res, 200, entry.body['op'] === 'list' ? ok({ tools: [{ name: 'get_map', inputSchema: { type: 'object' } }] }) : ok(TOOL_OK)));
    // Карты нет: любое её чтение в процессе MCP упало бы.
    await rm(workPaths(project, workId).map);
    const context = { projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, agent };
    const server = createParleyServer(context, createRemoteToolRunner(agent, {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    opened.push({ client, server });

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['get_map', 'create_session', 'browser_open']));
    expect((await client.callTool({ name: 'get_map', arguments: {} })).isError).not.toBe(true);
    expect(seen.map((r) => r.body['op'])).toEqual(['list', 'call']);
  });
});
