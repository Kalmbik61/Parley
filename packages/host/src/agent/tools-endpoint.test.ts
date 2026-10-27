/**
 * Маршрут хоста `POST /agent/tools` (спека хранилища 6.3, 6.4, 6.9, этап 1) на настоящем `node:http` и настоящем
 * `createToolRunner`: инструменты агента исполняются в процессе хоста, карту пишет он. Работа — временная
 * (`createWork`) с сессиями `s-01` и `s-02`; токены — настоящий реестр `createBrowserEndpoint`; подписки на изменения
 * работ — ручные, чтобы считать живые ожидания.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  AGENT_TOOLS_PATH,
  AGENT_TOOLS_REQUEST_BYTES,
  DEFAULT_CONFIG,
  addRoom,
  addSession,
  buildRoleCatalog,
  createRemoteToolRunner,
  createWork,
  ENGINE,
  HUMAN,
  readStoredMap,
  resolveProposal,
  updateMap,
  workPaths,
  type ProviderRow,
  type ToolLaunch,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityService } from '../activity/activity-service.js';
import { createBrowserEndpoint } from './browser-endpoint.js';
import { createAttemptsEndpoint } from './attempts-endpoint.js';
import { hostToolContext, mapChangeSignal, turnBoundarySource } from './tool-context.js';
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

async function boot(options: { now?: () => number; pollMs?: number } = {}) {
  const registry = createBrowserEndpoint({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, clients: () => [], roomsOf: () => [] });
  const ref: SessionRef = { projectPath: project, workId, sessionId: 's-01' };
  const ownToken = registry.register(ref);
  const listeners = new Set<() => void>();
  const mailListeners = new Set<() => void>();
  // Служба работ — ручная: `onChange` и `onMail` ведут отдельные подписки, и тест будит их по очереди.
  const works = {
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onMail: (listener: () => void) => {
      mailListeners.add(listener);
      return () => {
        mailListeners.delete(listener);
      };
    },
  };
  // Сколько раз `get_map` на самом деле исполнился: повтор по тому же `callId` строки провайдеров не спрашивает.
  const providerRows = vi.fn(async (): Promise<ProviderRow[]> => []);
  // Подписка — та же `mapChangeSignal`, что у хоста; крупный `pollMs` гасит запасной опрос: проснуться можно только по сигналу.
  const standard = async (target: SessionRef, launch: ToolLaunch) => ({
    ...(await hostToolContext(target, launch, { providerRows, onWorksChange: mapChangeSignal(works as never) })),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
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
    /** Живые подписки `wait_for` на записи писем. */
    mailWaiters: () => mailListeners.size,
    /** «Карта изменилась»: будит все ожидания, как `worksService.onChange`. */
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    /** «Записаны письма»: будит ожидания, как `worksService.onMail`; `works.changed` при этом нет. */
    notifyMail: () => {
      for (const listener of [...mailListeners]) listener();
    },
  };
}

// Каталог провайдеров (`field: "providers"`) — единственный ответ `get_map`, что ходит в `providerRows`: по нему и считается исполнение.
const getMapCall = (callId: string = randomUUID()) => ({ op: 'call', launch: {}, name: 'get_map', args: { field: 'providers' }, callId });
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

  it('wait_for(inbox), закончившийся с письмом до обрыва соединения: повтор с тем же callId получает то же письмо из сохранённого результата, а не новое пустое ожидание', async () => {
    const { token, url, waiters, closes, notify, post } = await boot();
    const body = waitCall();
    // Сырой сокет: клиент шлёт запрос, ответа не читает и бросает соединение, как агент, потерявший ответ.
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    socket.on('error', () => {});
    socket.write(
      [
        `POST ${target.pathname} HTTP/1.1`,
        `Host: ${target.host}`,
        `Authorization: Bearer ${token}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        'Connection: close',
        '',
        payload,
      ].join('\r\n'),
    );
    await expect.poll(() => waiters(), POLL).toBe(1);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'lost reply', kind: 'note' });
    });
    notify();
    // Ожидание закончилось, письмо отдано и отмечено прочитанным: вызов уже закончен, и только потом соединение бросают.
    await expect.poll(() => readStoredMap(project, workId).messages.find((message) => message.text === 'lost reply')?.readBy['s-01'], POLL).toBeDefined();
    await expect.poll(() => waiters(), POLL).toBe(0);
    socket.destroy();
    await expect.poll(() => closes(), POLL).toBe(1);
    // Письмо прочитано, поэтому свежее ожидание его уже не увидело бы и висело до таймаута; сохранённый результат отвечает сразу.
    const retried = await post(body);
    expect(JSON.parse(textOf(retried))).toMatchObject({ state: 'message', messages: [{ text: 'lost reply' }] });
    expect(waiters()).toBe(0);
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

  // Спека rooms.mail 6.7: запись одних писем `works.onChange` не зовёт, и ожидающий агент просыпается по `onMail`.
  it('a wait_for on the inbox wakes on a letters-only write, with no works.changed', async () => {
    const { post, waiters, mailWaiters, notifyMail } = await boot({ pollMs: 600_000 });
    const pending = post(waitCall());
    await expect.poll(() => waiters(), POLL).toBe(1);
    expect(mailWaiters()).toBe(1);
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'by mail', kind: 'note' });
    });
    notifyMail();
    expect(JSON.parse(textOf(await pending))).toMatchObject({ state: 'message' });
    await expect.poll(() => waiters() + mailWaiters(), POLL).toBe(0);
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

describe('host-local attempts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checks current registration in the existing token registry, including revocation and scope', () => {
    const registry = createBrowserEndpoint({ log: { info() {}, warn() {}, error() {} }, clients: () => [], roomsOf: () => [] });
    const ref: SessionRef = { projectPath: project, workId, sessionId: 's-01' };
    expect(registry.isRegistered(ref)).toBe(false);
    registry.register(ref);
    expect(registry.isRegistered({ ...ref })).toBe(true);
    for (const other of [{ ...ref, sessionId: 's-02' }, { ...ref, workId: 'w-9999' }, { ...ref, projectPath: '/elsewhere' }]) {
      expect(registry.isRegistered(other)).toBe(false);
    }
    registry.register(ref);
    expect(registry.isRegistered(ref)).toBe(true);
    registry.unregister(ref);
    expect(registry.isRegistered(ref)).toBe(false);
  });

  it('runs forwarded proposal, hashless submit and status through the host context without an HTTP loop', async () => {
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-c', 'core.fsmonitor=false', '-C', project, ...args])).stdout.trim();
    await git('init', '-b', 'main');
    await writeFile(path.join(project, 'test.js'), 'console.log("pass");\n');
    await git('add', 'test.js');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial attempts fixture');
    await updateMap(project, workId, map => { addRoom(map, { creator: HUMAN, title: 'Autonomous', mode: 'autonomous', lead: 's-01', members: ['s-01', 's-02'] }); });
    const log = { info() {}, warn() {}, error() {} };
    const registry = createBrowserEndpoint({ log, clients: () => [], roomsOf: () => [] });
    const ref = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });
    const tokens = { 's-01': registry.register(ref('s-01')), 's-02': registry.register(ref('s-02')) };
    const submit = vi.fn(async () => ({ ok: true as const, result: { receipt: { id: 'rc-internal' } } }));
    const attemptsEndpoint = createAttemptsEndpoint({ authenticate: req => registry.authenticate(req), engine: { submit, verify: async () => ({ ok: true, result: { recorded: true } }) } });
    const perform = vi.spyOn(attemptsEndpoint, 'perform');
    const endpoint = createToolsEndpoint({
      log, authenticate: req => registry.authenticate(req),
      contextFor: (target, launch) => hostToolContext(target, launch, {
        providerRows: async () => [], onWorksChange: () => () => {},
        attempts: (scope, request) => attemptsEndpoint.perform(scope, request, () => registry.isRegistered(scope)),
      }),
    });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const call = (name: string, args: Record<string, unknown>, session: keyof typeof tokens = 's-01') => new Promise<unknown>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ op: 'call', name, args, callId: randomUUID(), launch: {} }));
      const req = Object.assign(Readable.from([data]), { method: 'POST', headers: { authorization: `Bearer ${tokens[session]}`, 'content-length': String(data.length) } });
      const res = Object.assign(new EventEmitter(), {
        writableEnded: false, destroyed: false,
        writeHead(status: number) { if (status !== 200) reject(new Error(`HTTP ${status}`)); },
        end(text: string) {
          this.writableEnded = true;
          const body = JSON.parse(text) as { ok: boolean; result?: { isError?: boolean; content: { text: string }[] } };
          if (!body.ok || body.result?.isError) reject(new Error(text));
          else resolve(JSON.parse(body.result!.content[0]!.text));
        },
      });
      req.on('error', reject);
      endpoint.handle(req as IncomingMessage, res as unknown as ServerResponse);
    });
    const plan = {
      mode: 'autonomous', goal: 'Host-owned handoff',
      items: [{ id: 1, title: 'Change', owner: ENGINE, verifier: ENGINE, scope: 'src', criteria: ['Works'] }],
      autonomous: {
        budget: { attemptsPerItem: 3, repairWaves: 4, minutesPerAttempt: 30, sessions: 10, concurrent: 2 },
        checks: [{ id: 'test', item: 1, argv: ['node', 'test.js'], cwd: '.', env: {}, inputs: ['test.js'], timeoutMs: 1000 }],
        coverage: { 1: { 0: ['test'] } },
      },
    };
    const proposed = await call('propose_decision', { room: 'r-01', text: 'Implement', plan });
    expect(proposed).toEqual({ proposalId: 'p-01', rev: 0 });
    expect(perform.mock.calls[0]![0]).toEqual(ref('s-01'));
    expect(perform.mock.calls[0]![1]).toMatchObject({ action: 'propose-plan', roomId: 'r-01' });
    await updateMap(project, workId, (map, letters) => {
      const proposal = map.rooms[0]!.proposal!;
      resolveProposal(map, letters, 'r-01', proposal.id, 'accept', { rev: proposal.rev, planId: proposal.plan!.id, planRev: proposal.plan!.rev });
      const accepted = map.plans![0]!;
      accepted.autonomous!.attempts.push({
        id: 'at-0001', item: 1, n: 1, planRev: accepted.rev, criteriaVersion: 1, worker: 's-02', verifier: null,
        branch: 'attempt', baseSha: accepted.autonomous!.integration.baseSha, sha: null, tree: null, submissionKey: null,
        status: 'running', manifest: null, receipt: null, checks: [], failureSignature: null, startedAt: new Date().toISOString(), endedAt: null, log: [],
      });
    });
    const manifest = { version: 1, criteriaVersion: 1, dependsOn: [], coverage: 'covered', scope: 'src', facts: ['Works'], hypotheses: [], notFound: [], gaps: [], text: 'Done', artifacts: [], submittedAt: new Date().toISOString() };
    const received = await call('attempt_submit', { attemptId: 'at-0001', manifest }, 's-02');
    expect(received).toMatchObject({ receipt: { id: 'rc-internal' }, submissionKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(perform.mock.calls[1]![0]).toEqual(ref('s-02'));
    expect(submit).toHaveBeenCalledWith(ref('s-02'), expect.any(String), expect.any(Number), expect.objectContaining({ action: 'submit', manifest: expect.objectContaining({ hash: expect.any(String) }) }));
    expect(await call('attempt_status', {})).toMatchObject({ attempts: [{ id: 'at-0001' }] });
    expect(perform).toHaveBeenCalledTimes(2); // Status remains a host-owned map read.
    expect(fetch).not.toHaveBeenCalled();
    registry.unregister(ref('s-02'));
    expect(await attemptsEndpoint.perform(ref('s-02'), { action: 'submit', attemptId: 'at-0001', manifest }, () => registry.isRegistered(ref('s-02')))).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('hostToolContext', () => {
  const scope = (): SessionRef => ({ projectPath: project, workId, sessionId: 's-01' });
  const noRows = async (): Promise<ProviderRow[]> => [];

  it('binds an optional attempts channel to the trusted session and forwards its signal', async () => {
    const attempts = vi.fn(async () => ({ ok: true, result: {} }));
    const context = await hostToolContext(scope(), {}, { providerRows: noRows, onWorksChange: () => () => {}, attempts });
    const signal = new AbortController().signal;
    const request = { action: 'verify' as const, attemptId: 'at-0001', sha: 'a'.repeat(40), criterion: 0, verdict: 'pass' as const, note: 'Checked' };
    await expect(context.attempts!(request, signal)).resolves.toEqual({ ok: true, result: {} });
    expect(attempts).toHaveBeenCalledWith(scope(), request, signal);
    expect(context).not.toHaveProperty('agent');
    expect(await hostToolContext(scope(), {}, { providerRows: noRows, onWorksChange: () => () => {} })).not.toHaveProperty('attempts');
  });

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

  describe('turn boundary for an abandoned wait_for', () => {
    const since = Date.parse('2026-10-27T10:00:00.000Z');
    /** Живая активность, которую тест подменяет между вопросами; `undefined` — сессии службе активности не известны. */
    let live: { activity: { turnBoundaryAt: string | null } } | undefined;
    const boundaryAt = (turnBoundaryAt: string | null) => {
      live = { activity: { turnBoundaryAt } };
    };
    /** Служба работ поверх настоящей карты: сессии `s-03` (codex) и `s-02` (claude); неизвестной работы, как у службы, нет. */
    const works = {
      entry: (projectPath: string, id: string) => (id === workId ? { projectPath, map: readStoredMap(projectPath, id) } : undefined),
    };
    /** Источник хоста поверх неё и подменяемой живой активности. */
    const source = () => turnBoundarySource(works, { get: () => live as ReturnType<ActivityService['get']> });
    const ofSession = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });

    beforeEach(async () => {
      live = undefined;
      await updateMap(project, workId, (map) => {
        addSession(map, { provider: 'codex', label: 'three', task: 'third' });
      });
    });

    it('a codex session gets a predicate that is true only for a boundary after the call start, read at ask time', async () => {
      const context = await hostToolContext(ofSession('s-03'), {}, { providerRows: noRows, onWorksChange: () => () => {}, turnBoundary: source() });
      expect(context.turnBoundarySince).toBeTypeOf('function');

      // No live activity, no boundary, a boundary before or exactly at the call start, an unparsable one: the call is alive.
      expect(context.turnBoundarySince?.(since)).toBe(false);
      boundaryAt(null);
      expect(context.turnBoundarySince?.(since)).toBe(false);
      boundaryAt('2026-10-27T09:59:59.999Z');
      expect(context.turnBoundarySince?.(since)).toBe(false);
      boundaryAt('2026-10-27T10:00:00.000Z');
      expect(context.turnBoundarySince?.(since)).toBe(false);
      boundaryAt('not a date');
      expect(context.turnBoundarySince?.(since)).toBe(false);
      // A boundary after the call start: the call is abandoned.
      boundaryAt('2026-10-27T10:00:00.001Z');
      expect(context.turnBoundarySince?.(since)).toBe(true);
    });

    it('a claude session, or one the map does not know, gets no predicate even with a boundary in its activity', async () => {
      boundaryAt('2026-10-27T10:00:00.001Z');
      const claude = await hostToolContext(ofSession('s-02'), {}, { providerRows: noRows, onWorksChange: () => () => {}, turnBoundary: source() });
      expect('turnBoundarySince' in claude).toBe(false);
      const unknown = await hostToolContext(ofSession('s-99'), {}, { providerRows: noRows, onWorksChange: () => () => {}, turnBoundary: source() });
      expect('turnBoundarySince' in unknown).toBe(false);
    });

    it('has no predicate without a turn boundary source, whatever the provider', async () => {
      const context = await hostToolContext(ofSession('s-03'), {}, { providerRows: noRows, onWorksChange: () => () => {} });
      expect('turnBoundarySince' in context).toBe(false);
    });

    it('the host source reads the provider from the work map and passes the activity service answer through', () => {
      const asked: SessionRef[] = [];
      const answer = { activity: { turnBoundaryAt: '2026-10-27T10:00:00.001Z' } };
      const wired = turnBoundarySource(works, {
        get: (ref) => {
          asked.push(ref);
          return answer as unknown as ReturnType<ActivityService['get']>;
        },
      });
      expect(wired.provider(ofSession('s-03'))).toBe('codex');
      expect(wired.provider(ofSession('s-02'))).toBe('claude');
      expect(wired.provider(ofSession('s-99'))).toBeUndefined();
      expect(wired.provider({ projectPath: project, workId: 'w-9999', sessionId: 's-03' })).toBeUndefined();
      expect(wired.activity(ofSession('s-03'))).toBe(answer);
      expect(asked).toEqual([ofSession('s-03')]);
    });
  });

  it('lets the token scope win over a launch that names scope fields', async () => {
    const dirty = { sessionId: 's-02', projectPath: '/elsewhere', workId: 'w-9999', channel: true } as ToolLaunch;
    const context = await hostToolContext(scope(), dirty, { providerRows: noRows, onWorksChange: () => () => {} });
    expect(context).toMatchObject({ sessionId: 's-01', projectPath: project, workId, channel: false });
  });
});
