/**
 * Маршрут хоста `POST /agent/tools` (спека хранилища 6.3, 6.4, 6.9, этап 1) на настоящем `node:http` и настоящем
 * `createToolRunner`: инструменты агента исполняются в процессе хоста, карту пишет он. Работа — временная
 * (`createWork`) с сессиями `s-01` и `s-02`; токены — настоящий реестр `createBrowserEndpoint`; подписки на изменения
 * работ — ручные, чтобы считать живые ожидания.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_TOOLS_PATH,
  AGENT_TOOLS_REQUEST_BYTES,
  DEFAULT_CONFIG,
  addSession,
  buildRoleCatalog,
  createRemoteToolRunner,
  createWork,
  readStoredMap,
  updateMap,
  workPaths,
  type ProviderRow,
  type ToolLaunch,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { hostToolContext } from './tool-context.js';
import { CALL_REPLAY_LIMIT, CALL_REPLAY_TTL_MS, createToolsEndpoint } from './tools-endpoint.js';

/** Ожидания идут через сеть и диск: запас на загруженную машину больше умолчания в секунду. */
const POLL = { timeout: 5_000 };

let servers: Server[] = [];
let home = '';
let project = '';
let workId = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-tools-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-tools-project-'));
  process.env['PARLEY_HOME'] = home;
  workId = (await createWork(project, { title: 'Tools endpoint' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'one', task: 'first' });
    addSession(map, { provider: 'claude', label: 'two', task: 'second' });
  });
});

afterEach(async () => {
  // Висящие запросы рвутся силой: иначе `close` ждал бы их до конца теста.
  await Promise.all(
    servers.map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  servers = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Ответ маршрута со статусом 200: конверт `{ ok, result | error }`. */
interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface RawOptions {
  /** Токен запроса; `null` — без заголовка. По умолчанию — токен сессии `s-01`. */
  token?: string | null;
  signal?: AbortSignal;
}

async function boot(options: { now?: () => number } = {}) {
  const registry = createBrowserEndpoint({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clients: () => [], roomsOf: () => [] });
  const ref: SessionRef = { projectPath: project, workId, sessionId: 's-01' };
  const ownToken = registry.register(ref);
  const listeners = new Set<() => void>();
  // Сколько раз `get_map` на самом деле исполнился: повтор по тому же `callId` строки провайдеров не спрашивает.
  const providerRows = vi.fn(async (): Promise<ProviderRow[]> => []);
  const standard = (target: SessionRef, launch: ToolLaunch) =>
    hostToolContext(target, launch, {
      providerRows,
      onWorksChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  const contextFor = vi.fn(standard);
  // Журнал маршрута — свой, отдельный от журнала реестра токенов: тест смотрит только на то, что пишет `/agent/tools`.
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const endpoint = createToolsEndpoint({
    authenticate: (req) => registry.authenticate(req),
    contextFor,
    log,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // Закрытия соединений считает сам тест: его слушатель `close` ставится раньше хостового, и когда счётчик вырос,
  // обработчик хоста этого же закрытия уже отработал.
  let closes = 0;
  const server = createServer((req, res) => {
    res.on('close', () => {
      closes += 1;
    });
    endpoint.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${AGENT_TOOLS_PATH}`;

  const raw = (body: unknown, { token = ownToken, signal }: RawOptions = {}): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  const post = async (body: unknown, requestOptions?: RawOptions): Promise<Envelope> =>
    (await raw(body, requestOptions)).json() as Promise<Envelope>;
  return {
    registry,
    ref,
    token: ownToken,
    url,
    endpoint,
    contextFor,
    log,
    /** Обычная сборка контекста: тест подменяет `contextFor` на раз и зовёт её же после задержки. */
    standard,
    providerRows,
    raw,
    post,
    closes: () => closes,
    /** Живые подписки `wait_for` на изменения работ. */
    waiters: () => listeners.size,
    /** «Карта изменилась»: будит все ожидания, как `worksService.onChange`. */
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

const getMapCall = (callId: string = randomUUID()) => ({ op: 'call', launch: {}, name: 'get_map', args: {}, callId });
const sendCall = (text: string, callId: string = randomUUID()) => ({ op: 'call', launch: {}, name: 'send_message', args: { to: 's-02', text }, callId });
const waitCall = (callId: string = randomUUID()) => ({ op: 'call', launch: {}, name: 'wait_for', args: { target: 'inbox', timeoutSec: 600 }, callId });
const textOf = (envelope: Envelope): string => ((envelope.result as { content: { text: string }[] }).content[0] as { text: string }).text;
const toolNames = (envelope: Envelope): string[] => (envelope.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);

/**
 * Только заголовки с заявленным `Content-Length`, без тела: хост обязан отказать по одному заголовку, не дожидаясь тела
 * (иначе тест повис бы). Статус при этом приходит всегда: клиент, ещё пишущий мегабайт тела, мог бы получить сброс
 * соединения вместо ответа, и тест на 413 мигал бы под нагрузкой.
 */
function statusForDeclaredLength(url: string, token: string, contentLength: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const target = new URL(url);
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = /^HTTP\/1\.1 (\d{3}) /.exec(received)?.[1];
      if (status === undefined) reject(new Error(`no HTTP status in the reply: ${JSON.stringify(received.slice(0, 80))}`));
      else resolve(Number(status));
    });
    socket.write(
      [
        `POST ${target.pathname} HTTP/1.1`,
        `Host: ${target.host}`,
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        `Content-Length: ${contentLength}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
  });
}

describe('маршрут /agent/tools: инструменты агента в процессе хоста (спека хранилища 6.3)', () => {
  it('runs a tool for the bearer session and writes the map in the host process', async () => {
    const { post } = await boot();
    const reply = await post(sendCall('hi'));
    expect(reply.ok).toBe(true);
    expect((reply.result as { isError?: boolean }).isError).not.toBe(true);
    expect((readStoredMap(project, workId)).messages.at(-1)).toMatchObject({ from: 's-01', to: ['s-02'], text: 'hi' });
  });

  it('a replayed callId does not run the tool twice', async () => {
    const { post } = await boot();
    const body = sendCall('once');
    const replies = [...(await Promise.all([post(body), post(body)])), await post(body)];
    expect((readStoredMap(project, workId)).messages.filter((message) => message.text === 'once')).toHaveLength(1);
    // Все три получили один и тот же результат: тот же номер письма.
    expect(new Set(replies.map(textOf)).size).toBe(1);
  });

  it('lists the profile tools without browser tools or create_session', async () => {
    const { post } = await boot();
    const names = toolNames(await post({ op: 'list', launch: { toolProfile: 'short' } }));
    expect(names).toContain('get_map');
    expect(names).not.toContain('remember');
    expect(names).not.toContain('create_session');
    expect(names.filter((name) => name.startsWith('browser_'))).toEqual([]);
  });

  it('closing the request aborts a pending wait_for', async () => {
    const { post, waiters } = await boot();
    const controller = new AbortController();
    const pending = post(waitCall(), { signal: controller.signal }).catch(() => null);
    await expect.poll(() => waiters(), POLL).toBe(1);
    controller.abort();
    await pending;
    await expect.poll(() => waiters(), POLL).toBe(0);
  });

  it('a wait_for whose connection dropped does not leave its aborted outcome under the callId', async () => {
    const { post, waiters } = await boot();
    const body = waitCall();
    const controller = new AbortController();
    const dropped = post(body, { signal: controller.signal }).catch(() => null);
    await expect.poll(() => waiters(), POLL).toBe(1);
    controller.abort();
    await dropped;
    await expect.poll(() => waiters(), POLL).toBe(0);
    // Пока агент переподключался, пришло письмо. Хранись под callId исход отменённого ожидания (`running`), повтор
    // получил бы его; повтор исполняется заново и видит письмо.
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'wake up', kind: 'note' });
    });
    const retried = await post(body);
    expect(JSON.parse(textOf(retried))).toMatchObject({ state: 'message' });
  });

  it('a call that does not take the signal survives a dropped connection: the retry joins the same run instead of repeating it', async () => {
    const { post, contextFor, standard, closes } = await boot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `list_roles` читает каталог ролей через подставную функцию: медленный вызов, который отмены не видит.
    const catalogReads = vi.fn();
    contextFor.mockImplementation(async (target, launch) => ({
      ...(await standard(target, launch)),
      roleCatalog: async () => {
        catalogReads();
        await gate;
        return { roles: [], diagnostics: [], partial: false };
      },
    }));
    const body = { op: 'call', launch: {}, name: 'list_roles', args: {}, callId: randomUUID() };
    const controller = new AbortController();
    const dropped = post(body, { signal: controller.signal }).catch(() => null);
    await vi.waitFor(() => expect(catalogReads).toHaveBeenCalledTimes(1), POLL.timeout);
    controller.abort();
    await dropped;
    await expect.poll(() => closes(), POLL).toBe(1);
    const retried = post(body);
    release();
    expect((await retried).ok).toBe(true);
    expect(catalogReads).toHaveBeenCalledTimes(1);
  });

  it('a client that left before the executor was ready does not start the call, and its retry runs', async () => {
    const { post, contextFor, standard, closes } = await boot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    contextFor.mockImplementationOnce(async (target, launch) => {
      await gate;
      return standard(target, launch);
    });
    const body = waitCall();
    const controller = new AbortController();
    const left = post(body, { signal: controller.signal }).catch(() => null);
    await vi.waitFor(() => expect(contextFor).toHaveBeenCalledTimes(1), POLL.timeout);
    controller.abort();
    await left;
    await expect.poll(() => closes(), POLL).toBe(1);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'wake up', kind: 'note' });
    });
    const retried = post(body);
    release();
    // Запись об отменённом `wait_for` под callId не осталась: повтор видит письмо, а не `running`.
    expect(JSON.parse(textOf(await retried))).toMatchObject({ state: 'message' });
  });

  it('a duplicate of a call that is still running joins the same run', async () => {
    const { post, waiters, notify } = await boot();
    const body = waitCall();
    const first = post(body);
    await expect.poll(() => waiters(), POLL).toBe(1);
    const second = post(body);
    // Второму хватает времени дойти до хоста; отдельное ожидание дало бы вторую подписку.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(waiters()).toBe(1);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'both', kind: 'note' });
    });
    notify();
    const replies = await Promise.all([first, second]);
    expect(JSON.parse(textOf(replies[0] as Envelope))).toMatchObject({ state: 'message' });
    expect(textOf(replies[1] as Envelope)).toBe(textOf(replies[0] as Envelope));
  });

  it('answers a failure to build the executor with ok: false internal, and the next request builds it again', async () => {
    const { raw, post, contextFor } = await boot();
    contextFor.mockImplementationOnce(async () => {
      throw new Error('settings are unreadable');
    });
    const failed = await raw({ op: 'list', launch: {} });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ ok: false, error: { code: 'internal', message: 'settings are unreadable' } });
    expect(toolNames(await post({ op: 'list', launch: {} }))).toContain('get_map');
    expect(contextFor).toHaveBeenCalledTimes(2);
  });

  it('401 without a token, 413 past 1 MiB, 200 KB arguments pass', async () => {
    const { url, token, raw, post, contextFor } = await boot();
    expect((await raw({ op: 'list', launch: {} }, { token: null })).status).toBe(401);
    // 413 — по заявленной длине, до чтения тела (оно здесь вообще не отправляется) и до исполнителя.
    expect(await statusForDeclaredLength(url, token, AGENT_TOOLS_REQUEST_BYTES + 1)).toBe(413);
    expect(contextFor).not.toHaveBeenCalled();
    // Принято тело, а не ответ инструмента: `get_map` может отвергнуть лишний `pad`, но это `result` с `ok: true`.
    const big = await post({ op: 'call', launch: {}, name: 'get_map', args: { pad: 'x'.repeat(200_000) }, callId: randomUUID() });
    expect(big.ok).toBe(true);
  });

  it('413 for a body that outgrows the limit while streaming, with no Content-Length, and the tool does not run', async () => {
    const { url, token, contextFor } = await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        { host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        // Хост оборвал соединение раньше, чем клиент дописал тело, — тоже отказ.
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve(413);
        else reject(error);
      });
      for (let sent = 0; sent <= AGENT_TOOLS_REQUEST_BYTES; sent += 256 * 1024) req.write('x'.repeat(256 * 1024));
      req.end();
    });
    expect(status).toBe(413);
    expect(contextFor).not.toHaveBeenCalled();
  });

  it('401 for a revoked or foreign token', async () => {
    const { raw, registry, ref } = await boot();
    expect((await raw({ op: 'list', launch: {} }, { token: 'f'.repeat(64) })).status).toBe(401);
    registry.unregister(ref);
    expect((await raw({ op: 'list', launch: {} })).status).toBe(401);
  });

  it('logs a warn for each refusal of the route, with the reason and without the token or the request body', async () => {
    const { url, token, raw, contextFor, log } = await boot();
    const foreign = 'f'.repeat(64);
    // 401: чужой токен.
    expect((await raw({ op: 'list', launch: {} }, { token: foreign })).status).toBe(401);
    // 413: заявленная длина больше потолка.
    expect(await statusForDeclaredLength(url, token, AGENT_TOOLS_REQUEST_BYTES + 1)).toBe(413);
    // bad_request: в теле метка, которой в журнале быть не должно.
    await raw({ op: 'nope', launch: {}, marker: 'SECRET-BODY-MARKER' });
    // internal: сбой сборки исполнителя.
    contextFor.mockImplementationOnce(async () => {
      throw new Error('settings are unreadable');
    });
    await raw({ op: 'list', launch: {} });

    const scope = { projectPath: project, workId, sessionId: 's-01' };
    expect(log.warn.mock.calls).toEqual([
      ['agent tools: request refused', { status: 401, reason: expect.any(String) }],
      ['agent tools: request refused', { status: 413, reason: expect.any(String) }],
      ['agent tools: request refused', { code: 'bad_request', reason: 'op must be "list" or "call".', ...scope }],
      ['agent tools: request refused', { code: 'internal', reason: 'settings are unreadable', ...scope }],
    ]);
    const logged = JSON.stringify(log.warn.mock.calls);
    for (const secret of [foreign, token, 'SECRET-BODY-MARKER']) expect(logged).not.toContain(secret);
  });

  it('checks the token again before replying: a token revoked while the call ran gets 401, not the result', async () => {
    const { raw, registry, ref, waiters, notify } = await boot();
    const pending = raw(waitCall());
    await expect.poll(() => waiters(), POLL).toBe(1);
    registry.unregister(ref);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'late', kind: 'note' });
    });
    notify();
    expect((await pending).status).toBe(401);
  });

  it('answers an unknown tool inside result with ok: true, never 404', async () => {
    const { raw } = await boot();
    for (const name of ['no_such_tool', 'browser_open', 'create_session']) {
      const response = await raw({ op: 'call', launch: {}, name, args: {}, callId: randomUUID() });
      expect(response.status, name).toBe(200);
      expect(await response.json(), name).toMatchObject({ ok: true, result: { isError: true } });
    }
  });

  it('answers a malformed request with ok: false bad_request over HTTP 200, never 404', async () => {
    const { raw } = await boot();
    const shapes: unknown[] = [
      '{not json',
      '[]',
      '{}',
      { op: 'nope', launch: {} },
      { op: 'list' },
      { op: 'list', launch: [] },
      { op: 'list', launch: { toolProfile: 'long' } },
      { op: 'list', launch: { skillNavigator: 'yes' } },
      { op: 'call', launch: {}, args: {}, callId: 'x' },
      { op: 'call', launch: {}, name: '', args: {}, callId: 'x' },
      { op: 'call', launch: {}, name: 'get_map', args: [], callId: 'x' },
      { op: 'call', launch: {}, name: 'get_map', args: {} },
      { op: 'call', launch: {}, name: 'get_map', args: {}, callId: 'x'.repeat(500) },
      { op: 'call', launch: {}, name: 'get_map', args: {}, callId: 'x', meta: 'm' },
    ];
    for (const body of shapes) {
      const response = await raw(body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(await response.json(), JSON.stringify(body)).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    }
  });

  it('takes the session scope from the token: a launch naming another session, project or channel changes nothing', async () => {
    const { post } = await boot();
    const hostile = {
      sessionId: 's-02',
      projectPath: '/somewhere/else',
      workId: 'w-9999',
      workDir: '/tmp',
      channel: true,
      agent: { url: 'http://127.0.0.1:1/agent/browser', token: 'a'.repeat(64) },
      toolProfile: 'short',
    };
    const reply = await post({ op: 'call', launch: hostile, name: 'send_message', args: { to: 's-02', text: 'scoped' }, callId: randomUUID() });
    expect(reply.ok).toBe(true);
    expect((readStoredMap(project, workId)).messages.at(-1)).toMatchObject({ from: 's-01', to: ['s-02'], text: 'scoped' });
  });

  it('keeps one executor per session while the launch is unchanged and builds a new one for a new launch', async () => {
    const { post, contextFor } = await boot();
    const list = (launch: ToolLaunch) => post({ op: 'list', launch });
    // Три первых запроса идут вместе: исполнитель создаётся один раз.
    const replies = await Promise.all([list({ toolProfile: 'short' }), list({ toolProfile: 'short' }), list({ toolProfile: 'short' })]);
    for (const reply of replies) expect(toolNames(reply)).not.toContain('remember');
    expect(contextFor).toHaveBeenCalledTimes(1);
    expect(contextFor).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's-01' }), { toolProfile: 'short' });
    expect(toolNames(await list({}))).toContain('remember');
    expect(contextFor).toHaveBeenCalledTimes(2);
  });

  it('keeps the call memory per session: the same callId from another session runs on its own', async () => {
    const { post, registry, ref } = await boot();
    const other = registry.register({ ...ref, sessionId: 's-02' });
    const callId = randomUUID();
    await post(sendCall('from one', callId));
    await post({ op: 'call', launch: {}, name: 'send_message', args: { to: 's-01', text: 'from two' }, callId }, { token: other });
    expect((readStoredMap(project, workId)).messages.map((message) => [message.from, message.text])).toEqual([
      ['s-01', 'from one'],
      ['s-02', 'from two'],
    ]);
  });

  it('forget drops the session executor and its replay memory', async () => {
    const { post, endpoint, ref, contextFor, providerRows } = await boot();
    const body = getMapCall();
    await post(body);
    await post(body);
    expect(providerRows).toHaveBeenCalledTimes(1);
    endpoint.forget(ref);
    await post(body);
    expect(providerRows).toHaveBeenCalledTimes(2);
    expect(contextFor).toHaveBeenCalledTimes(2);
  });

  it('remembers a finished call for 10 minutes, counted from the moment it finished', async () => {
    let clock = 1_700_000_000_000;
    const { post, providerRows } = await boot({ now: () => clock });
    const body = getMapCall();
    await post(body);
    clock += CALL_REPLAY_TTL_MS - 1;
    await post(body);
    expect(providerRows).toHaveBeenCalledTimes(1);
    clock += 2;
    await post(body);
    expect(providerRows).toHaveBeenCalledTimes(2);
  });

  it(`remembers at most ${CALL_REPLAY_LIMIT} calls per session: the oldest is forgotten first`, async () => {
    const { post, providerRows } = await boot();
    const first = randomUUID();
    await post(getMapCall(first));
    const later = Array.from({ length: CALL_REPLAY_LIMIT }, () => randomUUID());
    for (const callId of later) await post(getMapCall(callId));
    expect(providerRows).toHaveBeenCalledTimes(CALL_REPLAY_LIMIT + 1);
    await post(getMapCall(later.at(-1)));
    expect(providerRows).toHaveBeenCalledTimes(CALL_REPLAY_LIMIT + 1);
    await post(getMapCall(first));
    expect(providerRows).toHaveBeenCalledTimes(CALL_REPLAY_LIMIT + 2);
  });
});

describe('маршрут /agent/tools и настоящий удалённый исполнитель из core (спека хранилища 6.3, 6.4)', () => {
  async function runnerOf(launch: ToolLaunch = {}) {
    const booted = await boot();
    const agent = { url: new URL('/agent/browser', booted.url).href, token: booted.token };
    return { ...booted, runner: createRemoteToolRunner(agent, launch) };
  }

  it('list and call go through the host: the map is written by the host process', async () => {
    const { runner } = await runnerOf({ toolProfile: 'short' });
    const names = (await runner.list()).map((tool) => tool.name);
    expect(names).toContain('get_map');
    expect(names).not.toContain('remember');
    const result = await runner.call('send_message', { to: 's-02', text: 'via runner' }, undefined);
    expect(result.isError).not.toBe(true);
    expect((readStoredMap(project, workId)).messages.at(-1)).toMatchObject({ from: 's-01', to: ['s-02'], text: 'via runner' });
  });

  it('a tool error and an unknown tool come back as tool results, not as route failures', async () => {
    const { runner } = await runnerOf();
    expect(await runner.call('send_message', { to: 's-99', text: 'nobody' }, undefined)).toMatchObject({ isError: true });
    expect(await runner.call('no_such_tool', {}, undefined)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('unknown tool') }] });
  });

  it("the caller's cancel closes the connection and the host ends the wait", async () => {
    const { runner, waiters } = await runnerOf();
    const controller = new AbortController();
    const pending = runner.call('wait_for', { target: 'inbox', timeoutSec: 600 }, undefined, controller.signal);
    await expect.poll(() => waiters(), POLL).toBe(1);
    controller.abort();
    expect(await pending).toMatchObject({ isError: true });
    await expect.poll(() => waiters(), POLL).toBe(0);
  });
});

describe('hostToolContext', () => {
  const scope = (): SessionRef => ({ projectPath: project, workId, sessionId: 's-01' });
  const noRows = async (): Promise<ProviderRow[]> => [];

  it('builds the context of the host-side executor from the token scope, with no agent channel', async () => {
    const onWorksChange = vi.fn(() => () => {});
    const context = await hostToolContext(scope(), { skillNavigator: true, toolProfile: 'short' }, { providerRows: noRows, onWorksChange });
    expect(context).toMatchObject({
      projectPath: project,
      workId,
      workDir: workPaths(project, workId).dir,
      sessionId: 's-01',
      channel: false,
      skillNavigator: true,
      toolProfile: 'short',
      messageRate: DEFAULT_CONFIG.messageRate,
      worktreeRoot: DEFAULT_CONFIG.worktreeRoot,
    });
    expect('agent' in context).toBe(false);
    expect(context.mapChanges).toBe(onWorksChange);
  });

  it('turns a failing provider source into null rows', async () => {
    const failing = async (): Promise<ProviderRow[]> => {
      throw new Error('the host is still starting');
    };
    const context = await hostToolContext(scope(), {}, { providerRows: failing, onWorksChange: () => () => {} });
    await expect(context.providerRows?.(new AbortController().signal)).resolves.toBeNull();
  });

  it('serves the rows of the provider source as they are', async () => {
    const rows: ProviderRow[] = [{ id: 'claude', label: 'Claude Code', family: 'claude', available: true, needs: null, models: null, effort: true, limits: null }];
    const context = await hostToolContext(scope(), {}, { providerRows: async () => rows, onWorksChange: () => () => {} });
    await expect(context.providerRows?.(new AbortController().signal)).resolves.toEqual(rows);
  });

  it('puts the given role catalog into the context, and has none of its own when none is given', async () => {
    const roleCatalog = vi.fn(async () => buildRoleCatalog());
    const shared = await hostToolContext(scope(), {}, { providerRows: noRows, onWorksChange: () => () => {}, roleCatalog });
    expect(shared.roleCatalog).toBe(roleCatalog);
    const own = await hostToolContext(scope(), {}, { providerRows: noRows, onWorksChange: () => () => {} });
    expect('roleCatalog' in own).toBe(false);
  });

  it('lets the token scope win over a launch that names scope fields', async () => {
    const dirty = { sessionId: 's-02', projectPath: '/elsewhere', workId: 'w-9999', channel: true } as ToolLaunch;
    const context = await hostToolContext(scope(), dirty, { providerRows: noRows, onWorksChange: () => () => {} });
    expect(context).toMatchObject({ sessionId: 's-01', projectPath: project, workId, channel: false });
  });
});
