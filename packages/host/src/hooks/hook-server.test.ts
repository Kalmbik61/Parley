/**
 * Приёмник HTTP-хуков на настоящем `node:http` (план 2026-10-01, Task 2, «Тесты»; Review Focus 6):
 * отказы без тела, событие доходит до службы ленты с ref, удержанные хуки отвечают решением окна,
 * `{}` по PostToolUse, по таймауту и при закрытии.
 */

import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { fakeFeedDeps, REF, silentLog } from '../../test/feed-fakes.js';
import { createFeedService } from '../feed/feed-service.js';
import type { FeedService } from '../feed/feed-service.js';
import { createHookServer } from './hook-server.js';
import type { HookRequest, HookServer, HookServerOptions } from './hook-server.js';

const PROVIDER_SESSION = 'c-1';

interface Reply {
  status: number;
  body: string;
}

interface PostOptions {
  token?: string | null;
  session?: string | null;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}

let servers: HookServer[] = [];
let services: FeedService[] = [];

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  await Promise.all(servers.map((server) => server.close()));
  services = [];
  servers = [];
});

async function boot(
  overrides: Partial<HookServerOptions> = {},
  feedOptions: Parameters<typeof createFeedService>[1] = {},
) {
  const fakes = fakeFeedDeps();
  const service = createFeedService(fakes.deps, feedOptions);
  services.push(service);
  const log = silentLog();
  const seen: HookRequest[] = [];
  const server = createHookServer({
    log,
    onHook: (hook) => {
      seen.push(hook);
      service.onHook(hook);
    },
    ...overrides,
  });
  servers.push(server);
  const url = await server.listen();
  const token = server.register(REF, PROVIDER_SESSION);
  return { server, service, url, token, log, seen, fakes };
}

/** POST тела хука; `body` — объект (JSON) или готовая строка. */
function post(url: string, body: unknown, options: PostOptions = {}): Promise<Reply> {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...(options.token === null || options.token === undefined
      ? {}
      : { Authorization: `Bearer ${options.token}` }),
    ...(options.session === null ? {} : { 'X-Parley-Session': options.session ?? REF.sessionId }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method: options.method ?? 'POST',
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const event = (name: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: name,
  session_id: PROVIDER_SESSION,
  ...extra,
});
const preBash = event('PreToolUse', {
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_use_id: 't1',
});
const permissionBash = event('PermissionRequest', {
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});
const postBash = event('PostToolUse', {
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  tool_response: { stdout: '', stderr: '' },
  tool_use_id: 't1',
});

/** Ждёт, пока условие станет истинным (запрос дошёл до службы). */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('отказы приёмника — без тела и в лог', () => {
  it('не POST /hooks — 404', async () => {
    const { url, token, log } = await boot();
    expect(await post(url, preBash, { token, method: 'GET' })).toEqual({ status: 404, body: '' });
    expect(await post(url, preBash, { token, path: '/other' })).toEqual({ status: 404, body: '' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('нет токена, чужой токен, отозванный токен — 401; токена в логе нет', async () => {
    const { server, url, token, log } = await boot();
    expect(await post(url, preBash)).toEqual({ status: 401, body: '' });
    expect(await post(url, preBash, { token: 'f'.repeat(64) })).toEqual({ status: 401, body: '' });
    server.unregister(REF);
    expect(await post(url, preBash, { token })).toEqual({ status: 401, body: '' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(token);
  });

  it('заголовок сессии не тот или нет его, чужой session_id тела — 404', async () => {
    const { url, token, seen } = await boot();
    expect(await post(url, preBash, { token, session: 's-02' })).toEqual({ status: 404, body: '' });
    expect(await post(url, preBash, { token, session: null })).toEqual({ status: 404, body: '' });
    expect(await post(url, { ...preBash, session_id: 'other' }, { token })).toEqual({
      status: 404,
      body: '',
    });
    expect(seen).toHaveLength(0);
  });

  it('токен одной сессии не открывает другую с тем же id в другой работе', async () => {
    const { server, url, token } = await boot();
    const other: SessionRef = { ...REF, workId: 'w-2' };
    const otherToken = server.register(other, 'c-2');
    expect(otherToken).not.toBe(token);
    expect(await post(url, { ...preBash, session_id: 'c-2' }, { token })).toEqual({
      status: 404,
      body: '',
    });
    expect((await post(url, { ...preBash, session_id: 'c-2' }, { token: otherToken })).status).toBe(
      200,
    );
  });

  it('тело больше предела — 413: и по Content-Length, и потоком без него', async () => {
    const { url, token, seen } = await boot({ bodyLimit: 1024 });
    const big = JSON.stringify({ ...preBash, pad: 'x'.repeat(2048) });
    expect(await post(url, big, { token })).toEqual({ status: 413, body: '' });

    // Потоком: Content-Length нет, тело приходит кусками.
    const status = await new Promise<number>((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Parley-Session': REF.sessionId,
            'Transfer-Encoding': 'chunked',
          },
          agent: false,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        // Сервер оборвал соединение раньше, чем клиент дописал тело, — тоже отказ.
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve(413);
        else reject(error);
      });
      req.write('x'.repeat(800));
      req.write('x'.repeat(800));
      req.end();
    });
    expect(status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('невалидный JSON, не объект, событие не из списка ленты — 400', async () => {
    const { url, token, seen } = await boot();
    expect(await post(url, '{"hook_event_name":', { token })).toEqual({ status: 400, body: '' });
    expect(await post(url, '[1,2]', { token })).toEqual({ status: 400, body: '' });
    expect(await post(url, event('ConfigChange'), { token })).toEqual({ status: 400, body: '' });
    expect(await post(url, { session_id: PROVIDER_SESSION }, { token })).toEqual({
      status: 400,
      body: '',
    });
    expect(seen).toHaveLength(0);
  });

  it('мусор вместо HTTP и оборванный запрос хост не роняют', async () => {
    const { url, token } = await boot();
    const target = new URL(url);
    await new Promise<void>((resolve) => {
      const socket = connect(Number(target.port), target.hostname, () => {
        socket.write('NOT HTTP AT ALL\r\n\r\n');
      });
      socket.on('data', () => socket.destroy());
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
    });
    expect((await post(url, preBash, { token })).status).toBe(200);
  });
});

describe('приём событий', () => {
  it('верное событие доходит до службы с ref и получает {}', async () => {
    const { url, token, seen } = await boot();
    const reply = await post(url, preBash, { token });
    expect(reply).toEqual({ status: 200, body: '{}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.ref).toEqual(REF);
    expect(seen[0]?.body['tool_use_id']).toBe('t1');
  });

  it('MessageDisplay: ответ уходит в том же тике, что и событие, — до пачки дельт', async () => {
    // Скорость доказывается строением, а не часами: `respond` вызван синхронно внутри `onHook`,
    // без ожидания таймера пачки. Часы на нагруженной машине флейкали бы.
    let syncAnswered = false;
    const fakes = fakeFeedDeps();
    const service = createFeedService(fakes.deps);
    services.push(service);
    const server = createHookServer({
      log: silentLog(),
      onHook: (hook) => {
        let answered = false;
        service.onHook({
          ...hook,
          respond: (json) => {
            answered = true;
            hook.respond(json);
          },
        });
        syncAnswered = answered;
      },
    });
    servers.push(server);
    const url = await server.listen();
    const token = server.register(REF, PROVIDER_SESSION);
    await post(url, event('UserPromptSubmit', { prompt: 'go' }), { token });

    const before = performance.now();
    const reply = await post(
      url,
      event('MessageDisplay', {
        message_id: 'm1',
        index: 0,
        delta: 'line\n'.repeat(200),
        final: false,
      }),
      { token },
    );
    const roundTrip = performance.now() - before;

    expect(reply).toEqual({ status: 200, body: '{}' });
    expect(syncAnswered).toBe(true);
    // Запас на порядок больше требования плана (10 мс): ловит только ожидание чего-то, не нагрузку.
    expect(roundTrip).toBeLessThan(1000);
  });

  it('SessionStart после /clear приносит новый session_id — сессия перепривязывается', async () => {
    const { url, token } = await boot();
    expect(
      (await post(url, event('SessionStart', { session_id: 'c-new', source: 'clear' }), { token }))
        .status,
    ).toBe(200);
    expect((await post(url, { ...preBash, session_id: 'c-new' }, { token })).status).toBe(200);
    expect((await post(url, preBash, { token })).status).toBe(404);
  });

  it('id сессии Claude не известен при регистрации — первый хук его запоминает', async () => {
    const { server, url } = await boot();
    const token = server.register(REF, null);
    expect((await post(url, { ...preBash, session_id: 'c-9' }, { token })).status).toBe(200);
    expect((await post(url, { ...preBash, session_id: 'c-10' }, { token })).status).toBe(404);
  });

  it('Node не оборвёт удержанный запрос: requestTimeout выключен, заголовки — по умолчанию', async () => {
    const { server } = await boot();
    expect(server.http.requestTimeout).toBe(0);
    expect(server.http.headersTimeout).toBe(60_000);
    expect(server.http.keepAliveTimeout).toBe(5_000);
    expect(server.http.address()).toMatchObject({ address: '127.0.0.1' });
    expect(server.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks$/);
  });
});

describe('удержанные хуки', () => {
  it('PermissionRequest ждёт и получает решение из feed.decide', async () => {
    const { url, token, service, seen } = await boot();
    await post(url, preBash, { token });
    const held = post(url, permissionBash, { token });
    await until(() => seen.length === 2);

    expect(
      service.decide(REF, 'permission:t1', {
        kind: 'permission',
        behavior: 'deny',
        message: 'No.',
      }),
    ).toEqual({
      applied: true,
      state: 'denied',
    });
    const reply = await held;
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'No.' },
      },
    });
  });

  it('PostToolUse того же вызова: удержанному {}', async () => {
    const { url, token, seen } = await boot();
    await post(url, preBash, { token });
    const held = post(url, permissionBash, { token });
    await until(() => seen.length === 2);

    await post(url, postBash, { token });
    expect(await held).toEqual({ status: 200, body: '{}' });
  });

  it('таймаут: {} и карточка stale', async () => {
    const { url, token, seen, service } = await boot({}, { pendingTimeoutMs: 100 });
    await post(url, preBash, { token });
    const held = post(url, permissionBash, { token });
    await until(() => seen.length === 2);

    expect(await held).toEqual({ status: 200, body: '{}' });
    const card = (await service.snapshot(REF)).items.find((item) => item.kind === 'permission');
    expect(card).toMatchObject({ state: 'stale' });
  });

  it('close(): висящим {}, дальше приёмник не слушает', async () => {
    const { server, url, token, seen } = await boot();
    await post(url, preBash, { token });
    const held = post(url, permissionBash, { token });
    await until(() => seen.length === 2);

    await server.close();
    expect(await held).toEqual({ status: 200, body: '{}' });
    expect(server.url()).toBeNull();
    expect(server.http.listening).toBe(false);
  });

  it('CLI оборвал удержанный запрос — карточка elsewhere', async () => {
    const { url, token, seen, service } = await boot();
    await post(url, preBash, { token });
    const target = new URL(url);
    const payload = JSON.stringify(permissionBash);
    const req = request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Parley-Session': REF.sessionId,
        'Content-Length': String(Buffer.byteLength(payload)),
      },
    });
    req.on('error', () => {});
    req.end(payload);
    await until(() => seen.length === 2);
    req.destroy();

    await until(() => cardState(service) === 'elsewhere');
  });

  it('обработчик упал — хуку {}, приёмник жив', async () => {
    const log = silentLog();
    const server = createHookServer({
      log,
      onHook: () => {
        throw new Error('boom');
      },
    });
    servers.push(server);
    const url = await server.listen();
    const token = server.register(REF, PROVIDER_SESSION);
    expect(await post(url, preBash, { token })).toEqual({ status: 200, body: '{}' });
    expect(await post(url, preBash, { token })).toEqual({ status: 200, body: '{}' });
    expect(log.warn).toHaveBeenCalled();
  });
});

/** Состояние карточки разрешения: решение не того вида ничего не меняет и называет его. */
function cardState(service: FeedService): string {
  return service.decide(REF, 'permission:t1', { kind: 'question', answers: {} }).state;
}
