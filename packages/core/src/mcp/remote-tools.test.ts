import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChannel } from '../work/mcp-config.js';
import { createWork, deleteWorkFiles, workPaths } from '../work/store.js';
import {
  AGENT_TOOLS_REQUEST_BYTES,
  ARGUMENTS_TOO_LARGE,
  HOST_NOT_RESPONDING,
  SESSION_LINK_EXPIRED,
  type PreparedCall,
  REMOTE_ONLY_MAX_CALL_BYTES,
  type RemoteOnlyCaller,
  type SendOptions,
  createRemoteOnlyCaller,
  createRemoteToolRunner,
  launchOf,
} from './remote-tools.js';
import { RUN_LIMITS } from './code-mode/limits.js';
import { type AgentHost, FIXTURE_TOKEN, type Script, type ScriptedReply, okEnvelope, startAgentHost } from '../../../../tests/fixtures/code-mode/agent-host.js';
import { createParleyServer, createToolRunner, type ToolRunner } from './tools.js';

const TOKEN = 'a'.repeat(64);
const servers: Server[] = [];

let home = '';
let project = '';
const opened: { client: Client; server: ReturnType<typeof createParleyServer> }[] = [];
/** Всё, что тест записал в stderr процесса: строки диагностики MCP в вывод прогона не просачиваются. */
let stderrWrites: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  stderrWrites = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
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

/**
 * Хост прежней сборки без маршрута `/agent/tools`: то же, что приёмник хуков делает с неизвестным путём (`hook-server.ts`,
 * `reject`) — 404 без тела, тело запроса не читается, сокет закрывается сразу после ответа. В `seen` — строки запросов.
 */
async function hostWithoutRoute(): Promise<{ agent: AgentChannel; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
    res.end(() => req.socket.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { agent: { url: `http://127.0.0.1:${port}/agent/browser`, token: TOKEN }, seen };
}

/** Что звали у подставного запасного исполнителя. */
interface FallbackCall {
  name: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

/** Подставной запасной исполнитель: записывает вызовы, на `call` отвечает текстом `from fallback: <имя>`. */
function fallbackStub(): { runner: ToolRunner; lists: number[]; calls: FallbackCall[] } {
  const lists: number[] = [];
  const calls: FallbackCall[] = [];
  const runner: ToolRunner = {
    list: async () => {
      lists.push(lists.length + 1);
      return [{ name: 'local_tool', inputSchema: { type: 'object' } }];
    },
    call: async (name, args, meta, signal) => {
      calls.push({ name, args, meta, signal });
      return { content: [{ type: 'text', text: `from fallback: ${name}` }] };
    },
  };
  return { runner, lists, calls };
}

const ok = (result: unknown): { ok: true; result: unknown } => ({ ok: true, result });
const TOOL_OK = { content: [{ type: 'text', text: '{}' }] };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;
/** Строки диагностики процесса MCP, записанные в stderr (с префиксом `parley-mcp: `). */
const mcpLines = (): string[] => stderrWrites.filter((line) => line.startsWith('parley-mcp: '));

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

describe('запасной исполнитель при хосте без маршрута (спека хранилища 6.5)', () => {
  it('404 на call: вызов отвечает запасной исполнитель, второй вызов хоста уже не трогает', async () => {
    const { agent, seen } = await hostWithoutRoute();
    const fallback = fallbackStub();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner });
    const controller = new AbortController();

    const first = await runner.call('get_map', { field: 'x' }, { threadId: 'T' }, controller.signal);
    const second = await runner.call('check_inbox', {}, undefined);

    expect(textOf(first)).toBe('from fallback: get_map');
    expect(textOf(second)).toBe('from fallback: check_inbox');
    expect(seen).toEqual(['POST /agent/tools']);
    // Вызов целиком, с аргументами, `_meta` и сигналом отмены, достаётся запасному исполнителю.
    expect(fallback.calls).toEqual([
      { name: 'get_map', args: { field: 'x' }, meta: { threadId: 'T' }, signal: controller.signal },
      { name: 'check_inbox', args: {}, meta: undefined, signal: undefined },
    ]);
  });

  it('404 на list: список отдаёт запасной исполнитель, и следующие list и call — тоже он', async () => {
    const { agent, seen } = await hostWithoutRoute();
    const fallback = fallbackStub();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner });

    expect((await runner.list()).map((tool) => tool.name)).toEqual(['local_tool']);
    expect(textOf(await runner.call('get_map', {}, undefined))).toBe('from fallback: get_map');
    expect((await runner.list()).map((tool) => tool.name)).toEqual(['local_tool']);

    expect(seen).toHaveLength(1);
    expect(fallback.lists).toHaveLength(2);
    expect(fallback.calls).toHaveLength(1);
  });

  it('два вызова сразу до первого ответа: оба получают ответ запасного исполнителя', async () => {
    const { agent } = await hostWithoutRoute();
    const fallback = fallbackStub();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner });

    const [a, b] = await Promise.all([runner.call('get_map', {}, undefined), runner.call('check_inbox', {}, undefined)]);

    expect([textOf(a), textOf(b)]).toEqual(['from fallback: get_map', 'from fallback: check_inbox']);
    expect(fallback.calls.map((call) => call.name).sort()).toEqual(['check_inbox', 'get_map']);
  });

  it('без запасного исполнителя 404 остаётся отказом с текстом — и у call, и у list', async () => {
    const { agent, seen } = await hostWithoutRoute();
    const runner = createRemoteToolRunner(agent, {});

    const result = await runner.call('get_map', {}, undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Parley's host refused the request (HTTP 404).");
    await expect(runner.list()).rejects.toThrow("Parley's host refused the request (HTTP 404).");
    // Без запасного хост спрашивается каждый раз: переключаться не на что.
    expect(seen).toHaveLength(2);
  });

  it.each([
    ['401', 401, SESSION_LINK_EXPIRED],
    ['500', 500, "Parley's host refused the request (HTTP 500)."],
    ['503 дольше бюджета', 503, HOST_NOT_RESPONDING],
  ] as const)('запасной включает только 404: ответ %s остаётся отказом', async (_name, status, text) => {
    const { agent } = await fakeHost((_req, res) => reply(res, status));
    const fallback = fallbackStub();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner, retryDelaysMs: [10], retryBudgetMs: 50 });

    expect(textOf(await runner.call('get_map', {}, undefined))).toBe(text);
    expect(fallback.calls).toHaveLength(0);
  });

  it('недоступный хост — не повод открывать карту: порт закрыт — HOST_NOT_RESPONDING, запасной не зовётся', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const fallback = fallbackStub();
    const agent: AgentChannel = { url: `http://127.0.0.1:${port}/agent/browser`, token: TOKEN };

    const result = await createRemoteToolRunner(agent, {}, { fallback: fallback.runner, retryDelaysMs: [10], retryBudgetMs: 50 }).call('get_map', {}, undefined);

    expect(textOf(result)).toBe(HOST_NOT_RESPONDING);
    expect(fallback.calls).toHaveLength(0);
  });
});

describe('сбой list при заданном запасном исполнителе (спека хранилища 6.4)', () => {
  it.each([
    ['503 дольше бюджета', (res: ServerResponse) => reply(res, 503)],
    ['500', (res: ServerResponse) => reply(res, 500)],
    ['401', (res: ServerResponse) => reply(res, 401)],
    ['413', (res: ServerResponse) => reply(res, 413)],
    ['нечитаемое тело', (res: ServerResponse) => reply(res, 200, undefined, 'not json')],
    ['tools не массив', (res: ServerResponse) => reply(res, 200, ok({ tools: 'nope' }))],
  ] as const)('хост сбоит (%s): этому list отвечает запасной исполнитель, а call по-прежнему идёт хосту', async (_name, onList) => {
    const { agent, seen } = await fakeHost((_req, res, entry) => (entry.body['op'] === 'list' ? onList(res) : reply(res, 200, ok(TOOL_OK))));
    const fallback = fallbackStub();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner, retryDelaysMs: [10], retryBudgetMs: 50 });
    const listsAsked = (): number => seen.filter((entry) => entry.body['op'] === 'list').length;

    expect((await runner.list()).map((tool) => tool.name)).toEqual(['local_tool']);
    const result = await runner.call('get_map', {}, undefined);

    // Исполнитель не переключился: вызов ушёл хосту, а запасной его не видел.
    expect(result).toEqual(TOOL_OK);
    expect(fallback.calls).toHaveLength(0);
    expect(seen.at(-1)!.body['op']).toBe('call');
    // И следующий list снова спрашивает хост, а не запасной напрямую.
    const asked = listsAsked();
    await runner.list();
    expect(listsAsked()).toBeGreaterThan(asked);
    expect(fallback.lists).toHaveLength(2);
  });

  it('хост недоступен (порт закрыт): list отвечает запасной исполнитель, call — HOST_NOT_RESPONDING', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const fallback = fallbackStub();
    const agent: AgentChannel = { url: `http://127.0.0.1:${port}/agent/browser`, token: TOKEN };
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner, retryDelaysMs: [10], retryBudgetMs: 50 });

    expect((await runner.list()).map((tool) => tool.name)).toEqual(['local_tool']);
    expect(textOf(await runner.call('get_map', {}, undefined))).toBe(HOST_NOT_RESPONDING);
    expect(fallback.calls).toHaveLength(0);
  });

  it('404 на call после сбоя list всё равно переключает насовсем', async () => {
    const { agent, seen } = await fakeHost((_req, res, entry) => reply(res, entry.body['op'] === 'list' ? 503 : 404));
    const fallback = fallbackStub();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallback.runner, retryDelaysMs: [10], retryBudgetMs: 50 });

    expect((await runner.list()).map((tool) => tool.name)).toEqual(['local_tool']);
    expect(textOf(await runner.call('get_map', {}, undefined))).toBe('from fallback: get_map');
    const asked = seen.length;

    expect((await runner.list()).map((tool) => tool.name)).toEqual(['local_tool']);
    expect(textOf(await runner.call('check_inbox', {}, undefined))).toBe('from fallback: check_inbox');
    // Хоста больше не спрашивают ни о списке, ни о вызове.
    expect(seen).toHaveLength(asked);
  });
});

describe('запасной исполнитель читает базу напрямую (спека хранилища 6.5)', () => {
  const contextFor = (workId: string) => ({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId: 's-01',
    channel: false,
    pollMs: 20,
  });

  it('работы нет в базе: инструменты, читающие карту, отвечают отказом «does not exist», а не молчат и не ждут', async () => {
    const { agent } = await hostWithoutRoute();
    const runner = createRemoteToolRunner(agent, {}, { fallback: createToolRunner(contextFor('w-0001')) });

    // `wait_for` на отсутствующей работе не должен висеть до таймаута: личности работы нет, проба читает базу и бросает.
    const results = await Promise.all([
      runner.call('get_map', {}, undefined),
      runner.call('wait_for', { target: 'inbox', timeoutSec: 5 }, undefined),
    ]);

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(textOf(result as { content: unknown[] })).toMatch(/^workspace w-0001 does not exist in /);
    }
  });

  it('работа в базе есть: запасной исполнитель отвечает картой из базы', async () => {
    const created = await createWork(project, { title: 'Работа', goal: 'цель' });
    const { agent } = await hostWithoutRoute();
    const runner = createRemoteToolRunner(agent, {}, { fallback: createToolRunner(contextFor(created.work.id)) });

    const result = await runner.call('get_map', {}, undefined);

    expect(result.isError).not.toBe(true);
    expect(textOf(result as { content: unknown[] })).toContain('Работа');
  });
});

describe('строки диагностики в stderr процесса MCP (спека хранилища 6.4, 6.5)', () => {
  it('переход на запасной исполнитель после 404 пишет одну строку на процесс, сколько бы вызовов ни ждало ответа', async () => {
    const { agent } = await hostWithoutRoute();
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallbackStub().runner });

    await Promise.all([runner.call('get_map', {}, undefined), runner.call('check_inbox', {}, undefined)]);
    await runner.call('get_map', {}, undefined);
    await runner.list();

    expect(mcpLines()).toHaveLength(1);
    expect(mcpLines()[0]).toMatch(/^parley-mcp: .*\/agent\/tools.*404.*directly/);
  });

  it('каждый вызов, кончившийся HOST_NOT_RESPONDING, пишет строку с его именем и числом попыток', async () => {
    const { agent } = await fakeHost((_req, res) => reply(res, 503));
    const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 50 });

    await runner.call('get_map', {}, undefined);
    await runner.call('send_message', { to: 's-02', text: 'x' }, undefined);

    expect(mcpLines()).toHaveLength(2);
    expect(mcpLines()[0]).toMatch(/^parley-mcp: .*call get_map.*after \d+ attempts/);
    expect(mcpLines()[1]).toMatch(/^parley-mcp: .*call send_message.*after \d+ attempts/);
    // Ни аргументы вызова, ни токен в строку не попадают.
    expect(mcpLines().join('')).not.toMatch(/s-02|a{64}/);
  });

  it('list, кончившийся HOST_NOT_RESPONDING, тоже пишет строку, даже если ему отвечает запасной исполнитель', async () => {
    const { agent } = await fakeHost((_req, res) => reply(res, 503));
    const runner = createRemoteToolRunner(agent, {}, { fallback: fallbackStub().runner, retryDelaysMs: [10], retryBudgetMs: 50 });

    await runner.list();

    expect(mcpLines()).toHaveLength(1);
    expect(mcpLines()[0]).toMatch(/^parley-mcp: .*\blist\b.*after \d+ attempts/);
  });

  it('штатные исходы молчат: результат, 401, отказ с 200 и отмена вызывающим', async () => {
    const ok200 = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));
    await createRemoteToolRunner(ok200.agent, {}).call('get_map', {}, undefined);
    const expired = await fakeHost((_req, res) => reply(res, 401));
    await createRemoteToolRunner(expired.agent, {}).call('get_map', {}, undefined);
    const refused = await fakeHost((_req, res) => reply(res, 200, { ok: false, error: { code: 'bad_request', message: 'launch must be an object' } }));
    await createRemoteToolRunner(refused.agent, {}).call('get_map', {}, undefined);
    const silent = await fakeHost(() => { /* держит запрос, не отвечая */ });
    const controller = new AbortController();
    const pending = createRemoteToolRunner(silent.agent, {}).call('wait_for', { target: 'inbox' }, undefined, controller.signal);
    await vi.waitFor(() => expect(silent.seen).toHaveLength(1), { timeout: 2000, interval: 10 });
    controller.abort();
    expect(textOf(await pending)).toBe('Cancelled.');

    expect(mcpLines()).toEqual([]);
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
    // Работу из базы убрали: любое чтение её карты в процессе MCP упало бы («workspace … does not exist»).
    await deleteWorkFiles(project, workId);
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

// ----- Code Mode remote-only caller (plan T5b1) -----

describe('createRemoteOnlyCaller (Code Mode T5b1): typed outcomes, bounded bodies, no fallback', () => {
  const hosts: AgentHost[] = [];
  afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.close())); });
  const host = async (script: Script): Promise<AgentHost> => { const h = await startAgentHost(script); hosts.push(h); return h; };
  const RESULT = { content: [{ type: 'text', text: 'map' }] };
  const ERROR_RESULT = { content: [{ type: 'text', text: 'You are not a member of this room.' }], isError: true };
  const fast = { retryDelaysMs: [5], callTimeoutMs: 2000, listTimeoutMs: 2000 };
  const LAUNCH = { skillNavigator: true, toolProfile: 'short' as const };
  const opts = (over: Partial<SendOptions> = {}): SendOptions => ({ signal: new AbortController().signal, remainingRaw: () => 1024 * 1024, beforeRetry: () => true, retryBudgetMs: 5000, ...over });
  const prep = (c: RemoteOnlyCaller, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): PreparedCall => {
    const p = c.prepare('get_map', args, meta);
    if (!('body' in p)) throw new Error('refused');
    return p;
  };

  describe('agentRevision: forwarded exactly, never stripped or defaulted', () => {
    const FULL = launchOf({ skillNavigator: true, skillListReduced: false, nativeContextRevision: 'n1', agentRevision: 'rev-1', toolProfile: 'short' } as never);
    const withoutCallId = (raw: string): string => raw.replace((JSON.parse(raw) as { callId: string }).callId, 'CALL');

    it('every launchOf field reaches the host in launchOf order, byte-identical to the classic body', async () => {
      expect(Object.keys(FULL)).toEqual(['skillNavigator', 'skillListReduced', 'nativeContextRevision', 'agentRevision', 'toolProfile']);
      const h = await host(() => ({ body: okEnvelope(RESULT) }));
      const only = createRemoteOnlyCaller(h.agent, FULL, fast);
      await only.send(prep(only, { room: 'r-1' }), opts());
      await createRemoteToolRunner(h.agent, FULL).call('get_map', { room: 'r-1' }, undefined);
      const [mine, classic] = h.log.map((x) => x.raw);
      expect(withoutCallId(mine!)).toBe(withoutCallId(classic!));
      expect(mine).toContain(`"launch":${JSON.stringify(FULL)},`);
    });

    it.each(['rev-1', '3f2c9d1e-6b1a-4c55-9a3e-0f7f6d2b8c11', 'rev "quoted" \\ \n é 🙂', ' padded ', 'x'.repeat(4096)])('the exact value %j is sent', (value) => {
      const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, { agentRevision: value });
      expect((JSON.parse(prep(c).body) as { launch: unknown }).launch).toEqual({ agentRevision: value });
    });

    it('the list and every retry of a call carry it, and the attempts are the same bytes', async () => {
      const launch = { agentRevision: 'rev-1', toolProfile: 'short' as const };
      let replies = 0;
      const h = await host((r) => (JSON.parse(r.raw)['op'] === 'list' ? { body: okEnvelope({ tools: [] }) } : ++replies === 1 ? { status: 503 } : { body: okEnvelope(RESULT) }));
      const c = createRemoteOnlyCaller(h.agent, launch, fast);
      await c.list({ signal: new AbortController().signal, cap: 4096 });
      expect(await c.send(prep(c), opts())).toMatchObject({ kind: 'ok', attempts: 2 });
      expect(h.log[0]!.raw).toBe(JSON.stringify({ op: 'list', launch }));
      expect(h.log).toHaveLength(3);
      expect(h.log[2]!.raw).toBe(h.log[1]!.raw);
      expect((JSON.parse(h.log[1]!.raw) as { launch: unknown }).launch).toEqual(launch);
    });

    it.each([[7], [0], [true], [null], [''], [{}], [[]], [['rev-1']], [new String('rev-1')], [undefined]])('the invalid value %j is refused at construction, nothing is sent', async (value) => {
      const h = await host(() => ({ body: okEnvelope(RESULT) }));
      expect(() => createRemoteOnlyCaller(h.agent, { agentRevision: value } as never, fast)).toThrow('invalid launch');
      expect(h.log).toHaveLength(0);
    });

    it('without a revision the launch stays without one: no default, nothing inherited, and the copy does not follow later changes', () => {
      const agent = { url: 'http://127.0.0.1:1', token: TOKEN };
      const launchIn = (c: RemoteOnlyCaller): Record<string, unknown> => (JSON.parse(prep(c).body) as { launch: Record<string, unknown> }).launch;
      expect(launchIn(createRemoteOnlyCaller(agent, { toolProfile: 'short' }))).toEqual({ toolProfile: 'short' });
      expect(launchIn(createRemoteOnlyCaller(agent, launchOf({} as never)))).toEqual({});
      const proto = Object.prototype as Record<string, unknown>;
      proto['agentRevision'] = 'polluted';
      try { expect(Object.hasOwn(launchIn(createRemoteOnlyCaller(agent, {})), 'agentRevision')).toBe(false); } finally { delete proto['agentRevision']; }
      const later: Record<string, unknown> = { agentRevision: 'rev-1' };
      const c = createRemoteOnlyCaller(agent, later as never);
      later['agentRevision'] = 'rev-2';
      expect(launchIn(c)).toEqual({ agentRevision: 'rev-1' });
    });
  });

  describe('construction and prepare', () => {
    it('the body is exactly the classic call body, built before any send; meta absent or verbatim', () => {
      const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1/agent/browser', token: TOKEN }, LAUNCH);
      const p = prep(c, { room: 'r-1', limit: 5 });
      const parsed = JSON.parse(p.body) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(['op', 'launch', 'name', 'args', 'callId']);
      expect(p.body).toBe(JSON.stringify({ op: 'call', launch: LAUNCH, name: 'get_map', args: { room: 'r-1', limit: 5 }, callId: parsed['callId'] }));
      expect(p.bytes).toBe(Buffer.byteLength(p.body));
      expect(Object.isFrozen(p)).toBe(true);
      const withMeta = JSON.parse(prep(c, {}, { threadId: 't-1', nested: { a: [1, 'x'] } }).body) as Record<string, unknown>;
      expect(Object.keys(withMeta)).toEqual(['op', 'launch', 'name', 'args', 'meta', 'callId']);
      expect(withMeta['meta']).toEqual({ threadId: 't-1', nested: { a: [1, 'x'] } });
      expect(withMeta['callId']).not.toBe(parsed['callId']);
    });

    it('a body over the route ceiling is refused before anything is sent; exactly at the ceiling it is prepared', () => {
      const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, {});
      const overhead = prep(c, { text: '' }).bytes;
      const at = c.prepare('get_map', { text: 'x'.repeat(AGENT_TOOLS_REQUEST_BYTES - overhead) }, undefined);
      expect('body' in at && at.bytes).toBe(AGENT_TOOLS_REQUEST_BYTES);
      expect(c.prepare('get_map', { text: 'x'.repeat(AGENT_TOOLS_REQUEST_BYTES - overhead + 1) }, undefined)).toEqual({ refused: 'too-large' });
    });

    it('prepare takes only plain JSON: no proxies, accessors, toJSON, class instances, non-finite numbers or arrays as args', () => {
      const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, {});
      class Box { v = 1; }
      const bad: unknown[] = [new Proxy({}, {}), Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }), { toJSON: () => ({}) }, new Box(), { n: Number.NaN }, { n: Infinity }, [1], null, 'x', { d: new Date(0) }, { s: Symbol('x') }];
      for (const args of bad) expect(() => c.prepare('get_map', args, undefined), String(args)).toThrow(TypeError);
      expect(() => c.prepare('', {}, undefined)).toThrow(TypeError);
      expect(() => c.prepare('get_map', {}, [1])).toThrow(TypeError);
      expect(() => c.send({ body: '{}', bytes: 2 }, opts())).toThrow('not an unsent prepared call of this caller');
    });

    it('agent and launch are checked, copied and frozen once', () => {
      for (const agent of [{ url: 'ftp://127.0.0.1/', token: TOKEN }, { url: 'http://127.0.0.1:1', token: '' }, { url: 'not a url', token: TOKEN }, null]) {
        expect(() => createRemoteOnlyCaller(agent as never, {})).toThrow('invalid agent channel');
      }
      for (const launch of [{ extra: 1 }, { skillNavigator: 'yes' }, { toolProfile: 'long' }, new Proxy({}, {})]) {
        expect(() => createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, launch as never)).toThrow('invalid launch');
      }
      const launch: Record<string, unknown> = { nativeContextRevision: 'r1' };
      const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, launch as never);
      launch['nativeContextRevision'] = 'r2';
      expect((JSON.parse(prep(c).body) as { launch: unknown }).launch).toEqual({ nativeContextRevision: 'r1' });
    });

    it('the per-call cap ceiling is the run response budget', () => {
      expect(REMOTE_ONLY_MAX_CALL_BYTES).toBe(RUN_LIMITS.responseBytes);
    });
  });

  describe('send: settlement only on a strict 200 receipt', () => {
    it('ok: the strict original result text, the wire bytes observed, one attempt; the request carries token and path', async () => {
      const body = okEnvelope(RESULT);
      const h = await host(() => ({ body }));
      const c = createRemoteOnlyCaller(h.agent, LAUNCH, fast);
      const p = prep(c, { a: 1 });
      const out = await c.send(p, opts());
      expect(out).toEqual({ kind: 'ok', text: JSON.stringify(RESULT), observedBytes: Buffer.byteLength(body), attempts: 1 });
      expect(h.log.map((r) => [r.method, r.url, r.authorization, r.raw])).toEqual([['POST', '/agent/tools', `Bearer ${FIXTURE_TOKEN}`, p.body]]);
    });

    it('tool-error: isError keeps the whole result as data', async () => {
      const h = await host(() => ({ body: okEnvelope(ERROR_RESULT) }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const out = await c.send(prep(c), opts());
      expect(out).toMatchObject({ kind: 'tool-error', text: JSON.stringify(ERROR_RESULT), attempts: 1 });
    });

    it('observed bytes are the wire size, never the re-serialized size', async () => {
      const padded = `{ "ok" : true ,\n   "result" : ${JSON.stringify(RESULT, null, 4)}   }   `;
      const h = await host(() => ({ body: padded }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const out = await c.send(prep(c), opts());
      expect(out).toMatchObject({ kind: 'ok', text: JSON.stringify(RESULT), observedBytes: Buffer.byteLength(padded) });
      expect(Buffer.byteLength(padded)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(RESULT)));
    });

    it.each([
      ['401', { status: 401, body: 'nope' }],
      ['413', { status: 413 }],
      ['status:500', { status: 500, body: '{}' }],
      ['status:302', { status: 302 }],
    ] as [string, ScriptedReply][])('%s is unknown with its bytes counted, no retry', async (why, reply) => {
      const h = await host(() => reply);
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const out = await c.send(prep(c), opts());
      const bytes = reply.body === undefined ? 0 : Buffer.byteLength(reply.body);
      expect(out).toEqual({ kind: 'unknown', why, observedBytes: bytes, attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    it.each([
      ['route-refusal', { body: JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'x' } }) }],
      ['route-refusal', { body: JSON.stringify({ ok: false }) }],
      ['unreadable', { body: 'not json' }],
      ['unreadable', { body: '{"ok":true,"result":{"content":[]},"result":{"content":[]}}' }],
      ['unreadable', { body: Buffer.from([0x7b, 0xff, 0x7d]) }],
      ['unreadable', { body: JSON.stringify({ ok: true, result: RESULT, extra: 1 }) }],
      ['unreadable', { body: JSON.stringify({ ok: true }) }],
      ['unreadable', { body: JSON.stringify({ ok: true, result: [RESULT] }) }],
      ['invalid-result', { body: JSON.stringify({ ok: true, result: {} }) }],
      ['invalid-result', { body: JSON.stringify({ ok: true, result: { content: 'text' } }) }],
      ['invalid-result', { body: JSON.stringify({ ok: true, result: { content: [{ type: 'nonsense' }] } }) }],
      ['invalid-result', { body: JSON.stringify({ ok: true, result: { content: [], isError: 'yes' } }) }],
    ] as [string, ScriptedReply][])('a complete 200 that is not a result is unread (%s), bytes counted, no retry', async (why, reply) => {
      const h = await host(() => reply);
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const out = await c.send(prep(c), opts());
      const bytes = reply.body === undefined ? 0 : Buffer.byteLength(reply.body);
      expect(out).toEqual({ kind: 'unread', why, observedBytes: bytes, attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    it('a 404 answering attempt 1 is not-dispatched (spec §5.2: the route is absent), its bytes counted, no retry', async () => {
      const h = await host(() => ({ status: 404, body: 'not found' }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      expect(await c.send(prep(c), opts())).toEqual({ kind: 'not-dispatched', why: '404', observedBytes: Buffer.byteLength('not found'), attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    it.each([
      ['a reset after the body left', { drop: 'before-headers' }],
      ['a 503', { status: 503 }],
    ] as [string, ScriptedReply][])('%s, then a 404: unknown, because attempt 1 may have run (s-296 m-7463)', async (_name, first) => {
      let n = 0;
      const h = await host(() => (++n === 1 ? first : { status: 404, body: 'nf' }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      expect(await c.send(prep(c), opts())).toEqual({ kind: 'unknown', why: '404', observedBytes: 2, attempts: 2 });
      expect(h.log).toHaveLength(2);
    });

    it('a 404 never reaches a local runner: there is no fallback, and a concurrent classic runner still switches to its own', async () => {
      const h = await host(() => ({ status: 404 }));
      const fallback = { list: vi.fn(async () => []), call: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local' }] })) };
      const classic = createRemoteToolRunner(h.agent, {}, { fallback });
      const only = createRemoteOnlyCaller(h.agent, {}, fast);
      const [a, b] = await Promise.all([classic.call('get_map', {}, undefined), only.send(prep(only), opts())]);
      expect(a).toEqual({ content: [{ type: 'text', text: 'local' }] });
      expect(b).toEqual({ kind: 'not-dispatched', why: '404', observedBytes: 0, attempts: 1 });
      expect(fallback.call).toHaveBeenCalledTimes(1);
      // The classic runner is now in direct mode; the remote-only caller still asks the host.
      expect((await only.send(prep(only), opts())).kind).toBe('not-dispatched');
      expect(fallback.call).toHaveBeenCalledTimes(1);
      expect(h.log).toHaveLength(3);
    });
  });

  describe('send: first attempt and retries', () => {
    it('attempt 1 is issued synchronously inside send: aborting right after send returns still counts one attempt', async () => {
      const h = await host(() => ({ body: okEnvelope(RESULT), delayMs: 200 }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const ctl = new AbortController();
      const pending = c.send(prep(c), opts({ signal: ctl.signal }));
      ctl.abort();
      expect(await pending).toEqual({ kind: 'unknown', why: 'aborted', observedBytes: 0, attempts: 1 });
      const pre = new AbortController();
      pre.abort();
      expect(await c.send(prep(c), opts({ signal: pre.signal }))).toEqual({ kind: 'unknown', why: 'aborted', observedBytes: 0, attempts: 0 });
    });

    it('503 with a large body, then 200: both bodies counted, same body (same callId) resent', async () => {
      const big = 'x'.repeat(5000);
      const body = okEnvelope(RESULT);
      const h = await host((r) => (r.n === 1 ? { status: 503, body: big } : { body }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const p = prep(c);
      expect(await c.send(p, opts())).toEqual({ kind: 'ok', text: JSON.stringify(RESULT), observedBytes: 5000 + Buffer.byteLength(body), attempts: 2 });
      expect(h.log.map((r) => r.raw)).toEqual([p.body, p.body]);
    });

    it('a dropped connection or a timed-out attempt is retried; the bytes read before the drop count', async () => {
      const body = okEnvelope(RESULT);
      const h = await host((r) => (r.n === 1 ? { body: 'y'.repeat(100), drop: { afterBytes: 40 } } : r.n === 2 ? { hang: true } : { body }));
      const c = createRemoteOnlyCaller(h.agent, {}, { ...fast, callTimeoutMs: 150 });
      const out = await c.send(prep(c), opts());
      expect(out).toMatchObject({ kind: 'ok', attempts: 3 });
      expect(out.observedBytes).toBe(h.written.get(1)! + Buffer.byteLength(body));
    });

    it('beforeRetry is never asked before attempt 1, is asked before every retry, and false stops with retry-not-authorized', async () => {
      const h = await host(() => ({ status: 503, body: 'busy' }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      let asked = 0;
      const out = await c.send(prep(c), opts({ beforeRetry: () => (++asked < 3) }));
      expect(out).toEqual({ kind: 'unknown', why: 'retry-not-authorized', observedBytes: 3 * 4, attempts: 3 });
      expect(asked).toBe(3);
      expect(h.log).toHaveLength(3);
    });

    it('503, then revocation: the retry is not sent (request log = 1); a throwing beforeRetry also stops', async () => {
      let revoked = false;
      // The gate is revoked while attempt 1 is being answered.
      const h = await host(() => { revoked = true; return { status: 503, body: 'busy' }; });
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      expect(await c.send(prep(c), opts({ beforeRetry: () => !revoked }))).toEqual({ kind: 'unknown', why: 'retry-not-authorized', observedBytes: 4, attempts: 1 });
      expect(h.log).toHaveLength(1);
      const thrower = await c.send(prep(c), opts({ beforeRetry: () => { throw new Error('gate'); } }));
      expect(thrower).toEqual({ kind: 'unknown', why: 'retry-not-authorized', observedBytes: 4, attempts: 1 });
      expect(h.log).toHaveLength(2);
    });

    it('an abort during the retry pause sends nothing more', async () => {
      const h = await host(() => ({ status: 503 }));
      const c = createRemoteOnlyCaller(h.agent, {}, { ...fast, retryDelaysMs: [300] });
      const ctl = new AbortController();
      const pending = c.send(prep(c), opts({ signal: ctl.signal }));
      await vi.waitFor(() => expect(h.log).toHaveLength(1));
      setTimeout(() => ctl.abort(), 50);
      expect(await pending).toEqual({ kind: 'unknown', why: 'aborted', observedBytes: 0, attempts: 1 });
      await new Promise((r) => setTimeout(r, 400));
      expect(h.log).toHaveLength(1);
    });

    it('the retry window gives up: the request count is bounded by the window, not by the number of failures', async () => {
      const h = await host(() => ({ status: 502 }));
      const c = createRemoteOnlyCaller(h.agent, {}, { ...fast, retryDelaysMs: [40] });
      const out = await c.send(prep(c), opts({ retryBudgetMs: 100 }));
      expect(out).toMatchObject({ kind: 'unknown', why: 'gave-up' });
      expect(h.log.length).toBeGreaterThanOrEqual(2);
      expect(h.log.length).toBeLessThanOrEqual(4);
    });
  });

  describe('send: bounded bodies', () => {
    it('a body exactly at the cap settles; cap + 1 is body-over-cap, read is stopped, nothing is parsed', async () => {
      const body = okEnvelope(RESULT);
      const n = Buffer.byteLength(body);
      const h = await host(() => ({ body }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      expect(await c.send(prep(c), opts({ remainingRaw: () => n }))).toMatchObject({ kind: 'ok', observedBytes: n });
      const parse = vi.spyOn(CallToolResultSchema, 'safeParse');
      expect(await c.send(prep(c), opts({ remainingRaw: () => n - 1 }))).toEqual({ kind: 'unread', why: 'body-over-cap', observedBytes: n, attempts: 1, runBudgetCut: true });
      expect(parse).not.toHaveBeenCalled();
    });

    it('a large streamed body is cut at the cap: the host could not write it all, and bytes read stay within cap + one chunk', async () => {
      const chunk = 'z'.repeat(16 * 1024);
      const h = await host(() => ({ chunks: Array.from({ length: 64 }, () => chunk), chunkDelayMs: 2 }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const cap = 40 * 1024;
      const out = await c.send(prep(c), opts({ remainingRaw: () => cap }));
      expect(out).toMatchObject({ kind: 'unread', why: 'body-over-cap', attempts: 1 });
      expect(out.observedBytes).toBeGreaterThan(cap);
      expect(out.observedBytes).toBeLessThanOrEqual(cap + 64 * 1024);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.written.get(1)!).toBeLessThan(64 * chunk.length);
    });

    it('the cumulative cap covers retries of the same call: attempt 2 gets the remainder after attempt 1', async () => {
      const first = 'b'.repeat(300);
      const body = okEnvelope(RESULT);
      const n = Buffer.byteLength(body);
      const h = await host((r) => (r.n % 2 === 1 ? { status: 503, body: first } : { body }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      expect(await c.send(prep(c), opts({ remainingRaw: () => 300 + n }))).toMatchObject({ kind: 'ok', observedBytes: 300 + n, attempts: 2 });
      expect(await c.send(prep(c), opts({ remainingRaw: () => 300 + n - 1 }))).toEqual({ kind: 'unread', why: 'body-over-cap', observedBytes: 300 + n, attempts: 2, runBudgetCut: true });
    });

    it('the cap is fixed at send start (at most 1 MiB) and narrowed by the current remaining budget on retries', async () => {
      const body = okEnvelope(RESULT);
      const n = Buffer.byteLength(body);
      const h = await host((r) => (r.n === 1 ? { status: 503, body: 'q'.repeat(100) } : { body }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      let calls = 0;
      // Plenty at the start, then the settled budget shrinks to less than attempt 1 + the answer.
      const out = await c.send(prep(c), opts({ remainingRaw: () => (++calls === 1 ? 10 * 1024 * 1024 : 100 + n - 1) }));
      expect(out).toEqual({ kind: 'unread', why: 'body-over-cap', observedBytes: 100 + n, attempts: 2, runBudgetCut: true });
      const huge = await host(() => ({ body: 'h'.repeat(REMOTE_ONLY_MAX_CALL_BYTES + 1) }));
      const c2 = createRemoteOnlyCaller(huge.agent, {}, fast);
      const ceiling = await c2.send(prep(c2), opts({ remainingRaw: () => 10 * REMOTE_ONLY_MAX_CALL_BYTES }));
      expect(ceiling).toMatchObject({ kind: 'unread', why: 'body-over-cap' });
      // The per-call ceiling cut it, with plenty of run budget: no typed evidence of the run budget.
      expect(ceiling).not.toHaveProperty('runBudgetCut');
    });

    it('typed evidence of the cut: runBudgetCut only when the run budget (below the per-call ceiling) set the cap that cut a 200', async () => {
      const over = 'h'.repeat(REMOTE_ONLY_MAX_CALL_BYTES + 1);
      const huge = await host(() => ({ body: over }));
      const c = createRemoteOnlyCaller(huge.agent, {}, fast);
      // Budget exactly at the ceiling: the ceiling is the cap, not the budget.
      expect(await c.send(prep(c), opts({ remainingRaw: () => REMOTE_ONLY_MAX_CALL_BYTES }))).not.toHaveProperty('runBudgetCut');
      // One byte under: the run budget is the smaller cap.
      expect(await c.send(prep(c), opts({ remainingRaw: () => REMOTE_ONLY_MAX_CALL_BYTES - 1 }))).toMatchObject({ kind: 'unread', why: 'body-over-cap', runBudgetCut: true });
      // The budget is large at the start and shrinks before a retry: the run budget cuts the retry.
      const retry = await host((r) => (r.n === 1 ? { status: 503, body: 'q'.repeat(100) } : { body: over }));
      const d = createRemoteOnlyCaller(retry.agent, {}, fast);
      let calls = 0;
      expect(await d.send(prep(d), opts({ remainingRaw: () => (++calls === 1 ? 10 * REMOTE_ONLY_MAX_CALL_BYTES : 200) }))).toMatchObject({ kind: 'unread', why: 'body-over-cap', runBudgetCut: true });
      // A complete 200 that is not a result is unread for another cause, whatever the budget: never the run budget.
      const junk = await host(() => ({ body: 'not json' }));
      const e = createRemoteOnlyCaller(junk.agent, {}, fast);
      const other = await e.send(prep(e), opts({ remainingRaw: () => 4096 }));
      expect(other).toMatchObject({ kind: 'unread', why: 'unreadable' });
      expect(other).not.toHaveProperty('runBudgetCut');
    });

    it('our own cut is told apart from everything else: only a 200 is unread, and the same bytes on another status stay unknown', async () => {
      const big = 'n'.repeat(5000);
      for (const [status, kind] of [[200, 'unread'], [500, 'unknown'], [404, 'unknown'], [401, 'unknown'], [302, 'unknown']] as const) {
        const h = await host(() => ({ status, body: big }));
        const c = createRemoteOnlyCaller(h.agent, {}, fast);
        expect(await c.send(prep(c), opts({ remainingRaw: () => 1000 })), String(status)).toMatchObject({ kind, why: 'body-over-cap', attempts: 1, ...(kind === 'unread' ? { runBudgetCut: true } : {}) });
      }
    });

    it('a stream failure after a 200 is not our cut: unknown, with its bytes; the same for no headers', async () => {
      const after = await host(() => ({ body: 'y'.repeat(100), drop: { afterBytes: 40 } }));
      const c = createRemoteOnlyCaller(after.agent, {}, { ...fast, retryDelaysMs: [1] });
      const out = await c.send(prep(c), opts({ retryBudgetMs: 0 }));
      expect(out).toMatchObject({ kind: 'unknown', why: 'gave-up', attempts: 1 });
      const none = await host(() => ({ drop: 'before-headers' }));
      const d = createRemoteOnlyCaller(none.agent, {}, { ...fast, retryDelaysMs: [1] });
      expect(await d.send(prep(d), opts({ retryBudgetMs: 0 }))).toMatchObject({ kind: 'unknown', why: 'gave-up', attempts: 1, observedBytes: 0 });
    });

    it('retry then cut: one callId on both attempts, bytes summed over them, actual bytes rather than the cap', async () => {
      const body = 'c'.repeat(3000);
      const h = await host((r) => (r.n === 1 ? { status: 503, body: 'q'.repeat(100) } : { body }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const out = await c.send(prep(c), opts({ remainingRaw: () => 500 }));
      expect(out).toEqual({ kind: 'unread', why: 'body-over-cap', observedBytes: 3100, attempts: 2, runBudgetCut: true });
      expect(h.log[1]!.raw).toBe(h.log[0]!.raw);
    });

    it('a broken remainingRaw counts as no budget, not as unlimited', async () => {
      const h = await host(() => ({ body: okEnvelope(RESULT) }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      for (const remainingRaw of [() => Number.NaN, () => -5, () => { throw new Error('x'); }]) {
        expect(await c.send(prep(c), opts({ remainingRaw }))).toMatchObject({ kind: 'unknown', why: 'body-over-cap' });
      }
    });

    it('two concurrent calls are each bounded by their own cap; their overshoot of the shared budget is recorded, not hidden', async () => {
      const body = okEnvelope({ content: [{ type: 'text', text: 'w'.repeat(600) }] });
      const n = Buffer.byteLength(body);
      const h = await host(() => ({ body, delayMs: 30 }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const remaining = Math.ceil(n * 1.6); // each body is more than half of it
      const [a, b] = await Promise.all([c.send(prep(c), opts({ remainingRaw: () => remaining })), c.send(prep(c), opts({ remainingRaw: () => remaining }))]);
      expect([a.kind, b.kind]).toEqual(['ok', 'ok']);
      expect(a.observedBytes + b.observedBytes).toBe(2 * n);
      expect(2 * n).toBeGreaterThan(remaining);
    });
  });

  describe('list (preflight)', () => {
    it('ok only for a strict 200 envelope with a tools array; the body is the classic list body', async () => {
      const body = okEnvelope({ tools: [{ name: 'get_map', inputSchema: { type: 'object' } }] });
      const h = await host(() => ({ body }));
      const c = createRemoteOnlyCaller(h.agent, LAUNCH, fast);
      expect(await c.list({ signal: new AbortController().signal, cap: 4096 })).toEqual({ ok: true, why: null, observedBytes: Buffer.byteLength(body) });
      expect(h.log[0]!.raw).toBe(JSON.stringify({ op: 'list', launch: LAUNCH }));
    });

    it.each([
      ['404', { status: 404, body: 'nf' }, 2],
      ['401', { status: 401 }, 0],
      ['status:503', { status: 503 }, 0],
      ['invalid-result', { body: okEnvelope({ tools: 'x' }) }, Buffer.byteLength(okEnvelope({ tools: 'x' }))],
      ['route-refusal', { body: '{"ok":false}' }, 12],
      ['body-over-cap', { body: 'v'.repeat(5000) }, 5000],
    ] as [string, ScriptedReply, number][])('%s is not ok, one attempt, bytes reported', async (why, reply, bytes) => {
      const h = await host(() => reply);
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      expect(await c.list({ signal: new AbortController().signal, cap: 4096 })).toEqual({ ok: false, why, observedBytes: bytes });
      expect(h.log).toHaveLength(1);
    });

    it('a hanging preflight ends on abort', async () => {
      const h = await host(() => ({ hang: true }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 50);
      expect(await c.list({ signal: ctl.signal, cap: 4096 })).toEqual({ ok: false, why: 'aborted', observedBytes: 0 });
    });
  });

  describe('r2 repairs (s-292 D1+/D2/D3, lead D4)', () => {
    it('D1+: a zero cap before attempt 1 sends nothing; observed and attempts stay as they are', async () => {
      const h = await host(() => ({ body: okEnvelope(RESULT) }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      for (const remainingRaw of [() => 0, () => Number.NaN, () => -5, () => Infinity, () => { throw new Error('x'); }]) {
        expect(await c.send(prep(c), opts({ remainingRaw }))).toEqual({ kind: 'unknown', why: 'body-over-cap', observedBytes: 0, attempts: 0 });
      }
      expect(h.log).toHaveLength(0);
    });

    it('D1: a retry refused for no cap after attempt 1 went out is unknown: no 200 was seen, and attempt 1 may have run', async () => {
      const h = await host(() => ({ drop: 'before-headers' }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      let calls = 0;
      // Attempt 1 is sent with budget; a concurrent call then uses it up before the retry.
      const out = await c.send(prep(c), opts({ remainingRaw: () => (++calls <= 2 ? 4000 : 0) }));
      expect(out).toEqual({ kind: 'unknown', why: 'body-over-cap', observedBytes: 0, attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    it('D1: a retry whose cap is already used up is not sent (503 of exactly the remaining budget: log = 1)', async () => {
      const h = await host(() => ({ status: 503, body: 'e'.repeat(4000) }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      let asked = 0;
      expect(await c.send(prep(c), opts({ remainingRaw: () => 4000, beforeRetry: () => { asked++; return true; } }))).toEqual({ kind: 'unknown', why: 'body-over-cap', observedBytes: 4000, attempts: 1 });
      expect(h.log).toHaveLength(1);
      expect(asked).toBe(1);
    });

    it('D2: a prepared call is single-use; a second send throws synchronously and sends nothing', async () => {
      const h = await host(() => ({ body: okEnvelope(RESULT) }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const p = prep(c);
      const first = c.send(p, opts());
      expect(() => c.send(p, opts())).toThrow(TypeError);
      expect(await first).toMatchObject({ kind: 'ok', attempts: 1 });
      expect(() => c.send(p, opts())).toThrow(TypeError);
      expect(h.log).toHaveLength(1);
    });

    it('D2: a call prepared by one caller cannot be sent by another (no foreign launch under another token)', async () => {
      const a = await host(() => ({ body: okEnvelope(RESULT) }));
      const b = await host(() => ({ body: okEnvelope(RESULT) }));
      const ca = createRemoteOnlyCaller(a.agent, { toolProfile: 'short' }, fast);
      const cb = createRemoteOnlyCaller({ url: b.agent.url, token: 'b'.repeat(64) }, {}, fast);
      const p = prep(ca);
      expect(() => cb.send(p, opts())).toThrow(TypeError);
      expect(b.log).toHaveLength(0);
      // The refusal by B did not consume A's call: A can still send it once.
      expect(await ca.send(p, opts())).toMatchObject({ kind: 'ok' });
      expect(a.log).toHaveLength(1);
    });

    const busy = (ms: number): void => { const end = performance.now() + ms; while (performance.now() < end) { /* block */ } };

    it('D3: a beforeRetry that blocks past the window: the final check runs after it, so nothing is resent (gave-up, log 1)', async () => {
      const h = await host(() => ({ status: 503 }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const out = await c.send(prep(c), opts({ retryBudgetMs: 100, beforeRetry: () => { busy(150); return true; } }));
      expect(out).toEqual({ kind: 'unknown', why: 'gave-up', observedBytes: 0, attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    it('D3: a remainingRaw callback that blocks past the window is also before the final check (gave-up, log 1)', async () => {
      const h = await host(() => ({ status: 503 }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      let calls = 0;
      const out = await c.send(prep(c), opts({ retryBudgetMs: 100, remainingRaw: () => { if (++calls === 3) busy(150); return 4096; } }));
      expect(out).toEqual({ kind: 'unknown', why: 'gave-up', observedBytes: 0, attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    it('D3: an abort that happens inside beforeRetry is seen by the final check (aborted, log 1)', async () => {
      const h = await host(() => ({ status: 503 }));
      const c = createRemoteOnlyCaller(h.agent, {}, fast);
      const ctl = new AbortController();
      const out = await c.send(prep(c), opts({ signal: ctl.signal, beforeRetry: () => { ctl.abort(); return true; } }));
      expect(out).toEqual({ kind: 'unknown', why: 'aborted', observedBytes: 0, attempts: 1 });
      expect(h.log).toHaveLength(1);
    });

    /** Runs `fn` with `Object.prototype.toJSON` polluted, synchronously, and always restores it. */
    const polluted = <T>(target: object, fn: () => T): T => {
      Object.defineProperty(target, 'toJSON', { value: () => 'POLLUTED', configurable: true, writable: true, enumerable: false });
      try { return fn(); } finally { delete (target as { toJSON?: unknown }).toJSON; }
    };
    const nullProto = (o: Record<string, unknown>): Record<string, unknown> => Object.assign(Object.create(null) as Record<string, unknown>, o);

    it('D4: an inherited toJSON on Object.prototype or Array.prototype is refused in args and meta; nothing is rewritten', () => {
      const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, {});
      polluted(Object.prototype, () => {
        expect(() => c.prepare('get_map', { room: 'r-1' }, undefined)).toThrow(TypeError);
        expect(() => c.prepare('get_map', nullProto({ room: 'r-1' }), { threadId: 't' })).toThrow(TypeError);
        expect(() => c.prepare('get_map', nullProto({ list: [1] }), undefined)).toThrow(TypeError);
        const p = c.prepare('get_map', nullProto({ room: 'r-1' }), nullProto({ threadId: 't' }));
        expect('body' in p && p.body).not.toContain('POLLUTED');
        expect('body' in p && (JSON.parse(p.body) as Record<string, unknown>)).toMatchObject({ args: { room: 'r-1' }, meta: { threadId: 't' } });
      });
      polluted(Array.prototype, () => {
        expect(() => c.prepare('get_map', { list: [1, 2] }, undefined)).toThrow(TypeError);
      });
      expect(c.prepare('get_map', { list: [1, 2] }, undefined)).toMatchObject({ bytes: expect.any(Number) });
    });

    it('D4: the launch snapshot is own keys only, null-prototype, and safe under a polluted Object.prototype.toJSON', () => {
      // A null-prototype launch created while Object.prototype is polluted: the copy itself must not serialize via the hook.
      const p = polluted(Object.prototype, () => {
        const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, nullProto({ toolProfile: 'short' }) as never);
        return c.prepare('get_map', nullProto({}), undefined);
      });
      expect('body' in p && p.body).not.toContain('POLLUTED');
      expect('body' in p && (JSON.parse(p.body) as Record<string, unknown>)['launch']).toEqual({ toolProfile: 'short' });
      // Inherited launch fields are not read.
      Object.defineProperty(Object.prototype, 'skillNavigator', { value: true, configurable: true, writable: true, enumerable: false });
      let body = '';
      try {
        const c = createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, {});
        const q = c.prepare('get_map', nullProto({}), undefined);
        body = 'body' in q ? q.body : '';
      } finally { delete (Object.prototype as { skillNavigator?: unknown }).skillNavigator; }
      expect((JSON.parse(body) as Record<string, unknown>)['launch']).toEqual({});
      // Own keys that only `in` would have found on a prototype are unknown fields.
      for (const launch of [{ constructor: 1 }, { toString: 'x' }, { hasOwnProperty: true }, nullProto({ toJSON: 'x' })]) {
        expect(() => createRemoteOnlyCaller({ url: 'http://127.0.0.1:1', token: TOKEN }, launch as never), Object.keys(launch).join()).toThrow('invalid launch');
      }
    });

    it('D4: the classic runner bytes are unchanged (the classic body is still JSON.stringify of the request)', async () => {
      const { agent, seen } = await fakeHost((_req, res) => reply(res, 200, ok(TOOL_OK)));
      await createRemoteToolRunner(agent, { toolProfile: 'short' }).call('get_map', { room: 'r-1' }, undefined);
      expect(Object.keys(seen[0]!.body)).toEqual(['op', 'launch', 'name', 'args', 'callId']);
      const only = createRemoteOnlyCaller(agent, { toolProfile: 'short' }, fast);
      const p = prep(only, { room: 'r-1' });
      expect(p.body).toBe(JSON.stringify({ ...seen[0]!.body, callId: (JSON.parse(p.body) as { callId: string }).callId }));
    });
  });

  it('static guard: only test files import the root agent-host fixture', () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const code = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.json'];
    const pattern = /code-mode\/agent-host(\.[jt]s)?['"`]/;
    const tracked = spawnSync('git', ['grep', '-l', '-E', "code-mode/agent-host(\\.[jt]s)?['\"`]", '--', ...code], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...code], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
      .filter((f) => pattern.test(readFileSync(path.join(repo, f), 'utf8')));
    const importers = [...new Set([...tracked, ...untracked])].filter((f) => f !== 'tests/fixtures/code-mode/agent-host.ts');
    expect(importers.filter((f) => !/\.test\.tsx?$/.test(f))).toEqual([]);
    expect(importers).toContain('packages/core/src/mcp/remote-tools.test.ts');
    expect(existsSync(path.join(repo, 'tests/fixtures/code-mode/agent-host.ts'))).toBe(true);
  });
});
