/**
 * Приёмник HTTP-хуков Claude Code (план 2026-10-01, решения 1 и 12): `node:http` только на 127.0.0.1,
 * порт случайный. Каждый запуск сессии получает свой токен (`register`): id сессии Parley уникален
 * только внутри работы, поэтому сессию находит токен, а заголовок `X-Parley-Session` и `session_id`
 * тела лишь сверяются с ней.
 *
 * Отказы — без тела ответа и в лог хоста: не тот путь или метод — 404, токен — 401, сессия — 404,
 * тело больше 16 МиБ — 413, не JSON или событие не из списка ленты — 400. Ни один вход не роняет хост
 * (Review Focus 6). Принятое событие уходит в `onHook` с функцией ответа: ответ — один, повтор
 * игнорируется, а на выключении всем, кому не ответили, уходит `{}`.
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { CODEX_HOOK_EVENTS, FEED_HOOK_EVENTS } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import { EMPTY_HOOK_RESPONSE, type HookResponse } from './decisions.js';

/** Предел тела хука (решение 12). */
export const HOOK_BODY_LIMIT = 16 * 1024 * 1024;

/** Путь приёмника: тот же, что пишется в файл настроек (`<url>`). */
const HOOK_PATH = '/hooks';

/** Соединение без запросов держится недолго: CLI открывает новое на каждый хук. */
const KEEP_ALIVE_MS = 5_000;

/** Сколько выключение ждёт, пока `{}` висящим уйдёт в сокеты. */
const CLOSE_FLUSH_MS = 1_000;

const FEED_EVENTS: ReadonlySet<string> = new Set(FEED_HOOK_EVENTS);
const CODEX_EVENTS: ReadonlySet<string> = new Set(CODEX_HOOK_EVENTS);

/** Принятое событие хука одной сессии. */
export interface HookRequest {
  ref: SessionRef;
  /** stdin-JSON Claude Code как есть; `hook_event_name` — из `FEED_HOOK_EVENTS`. */
  body: Record<string, unknown>;
  /** Ответ хуку (200, JSON). Второй и следующие вызовы ничего не делают. */
  respond(json: HookResponse): void;
  /**
   * Запрос закрыт другой стороной раньше ответа (CLI оборвал хук, процесс вышел). Слушатель
   * вызывается один раз и только если ответа ещё не было.
   */
  onAbandon(listener: () => void): void;
}

export interface HookServerOptions {
  log: Log;
  onHook(request: HookRequest): void;
  /** Предел тела; по умолчанию `HOOK_BODY_LIMIT`. Тестам — меньше. */
  bodyLimit?: number;
}

export interface HookServer {
  /** Слушает `127.0.0.1:0`; разрешается адресом `http://127.0.0.1:<порт>/hooks`. */
  listen(): Promise<string>;
  /** Адрес приёмника; `null` — ещё не слушает или уже закрыт. */
  url(): string | null;
  /**
   * Токен запуска сессии (32 байта, hex) для `PARLEY_HOOK_TOKEN`. Прежний токен той же сессии
   * отзывается. `providerSessionId` — id сессии у Claude Code; `null` — сверять `session_id` не с чем,
   * первый принятый хук его запомнит. `provider` задаёт набор принимаемых событий (у Codex свой).
   */
  register(ref: SessionRef, providerSessionId: string | null, provider?: string): string;
  /** Отзывает токен сессии: её хуки дальше — 401. */
  unregister(ref: SessionRef): void;
  /** `{}` всем висящим запросам, затем закрывает сервер и все соединения. */
  close(): Promise<void>;
  /** Сам `http.Server` — только для проверки его настроек в тестах. */
  readonly http: Server;
}

interface Registration {
  ref: SessionRef;
  token: string;
  providerSessionId: string | null;
  /** События, которые принимает этот запуск: у Claude Code и Codex наборы разные. */
  events: ReadonlySet<string>;
}

/** Строка заголовка: у повторённого заголовка Node отдаёт массив — такой не принимаем. */
const headerOf = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createHookServer(options: HookServerOptions): HookServer {
  const { log } = options;
  const bodyLimit = options.bodyLimit ?? HOOK_BODY_LIMIT;
  const byToken = new Map<string, Registration>();
  const tokenOfSession = new Map<string, string>();
  /** Запросы, которым ещё не ответили: на выключении получают `{}`. */
  const open = new Map<(json: HookResponse) => void, ServerResponse>();
  let address: string | null = null;
  let closing: Promise<void> | null = null;

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      log.warn('приёмник хуков: сбой разбора запроса', { error: String(error) });
      reject(req, res, 400, 'internal');
    }
  });
  // Удержанный хук ждёт человека до часа (решение 1): предел запроса Node (300 с) оборвал бы его.
  // Заголовки ждём по умолчанию — их CLI шлёт сразу.
  server.requestTimeout = 0;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  // Сбой сокета клиента (оборванный запрос, мусор вместо HTTP) — не повод падать.
  server.on('clientError', (error: Error, socket: Socket) => {
    log.warn('приёмник хуков: ошибка соединения', { error: error.message });
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  /** Отказ без тела; соединение закрывается — недочитанное тело дальше не читается. */
  function reject(req: IncomingMessage, res: ServerResponse, status: number, reason: string): void {
    if (!res.headersSent) {
      log.warn('приёмник хуков: запрос отклонён', {
        status,
        reason,
        method: req.method,
        path: req.url?.split('?')[0]?.slice(0, 200),
      });
      res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
    }
    res.end(() => req.socket.destroy());
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const pathname = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || pathname !== HOOK_PATH) {
      reject(req, res, 404, 'route');
      return;
    }
    const auth = headerOf(req, 'authorization');
    const token = auth?.startsWith('Bearer ') === true ? auth.slice('Bearer '.length).trim() : '';
    const registration = token === '' ? undefined : byToken.get(token);
    if (registration === undefined) {
      reject(req, res, 401, 'token');
      return;
    }
    if (headerOf(req, 'x-parley-session') !== registration.ref.sessionId) {
      reject(req, res, 404, 'session-header');
      return;
    }
    const declared = Number(headerOf(req, 'content-length') ?? '0');
    if (Number.isFinite(declared) && declared > bodyLimit) {
      reject(req, res, 413, 'body-size');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > bodyLimit) {
        rejected = true;
        chunks.length = 0;
        req.pause();
        reject(req, res, 413, 'body-size');
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      rejected = true;
      log.warn('приёмник хуков: запрос оборван', { error: error.message });
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        accept(req, res, registration, Buffer.concat(chunks, size).toString('utf8'));
      } catch (error) {
        log.warn('приёмник хуков: сбой обработки события', { error: String(error) });
        if (!res.headersSent) reject(req, res, 400, 'internal');
      }
    });
  }

  function accept(
    req: IncomingMessage,
    res: ServerResponse,
    registration: Registration,
    text: string,
  ): void {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      reject(req, res, 400, 'json');
      return;
    }
    if (!isRecord(body)) {
      reject(req, res, 400, 'json');
      return;
    }
    const event = body['hook_event_name'];
    if (typeof event !== 'string' || !registration.events.has(event)) {
      reject(req, res, 400, 'event');
      return;
    }
    const sessionId = typeof body['session_id'] === 'string' ? body['session_id'] : null;
    if (
      sessionId !== null &&
      registration.providerSessionId !== null &&
      sessionId !== registration.providerSessionId
    ) {
      // `/clear` и `--fork-session` заводят у Claude Code новый id (разведка, 2.2): его приносит
      // `SessionStart` того же процесса — токен уже доказал, что запрос от него.
      if (event !== 'SessionStart') {
        reject(req, res, 404, 'session-id');
        return;
      }
      log.info('приёмник хуков: новый id сессии провайдера', {
        sessionId: registration.ref.sessionId,
      });
      registration.providerSessionId = sessionId;
    } else if (sessionId !== null && registration.providerSessionId === null) {
      registration.providerSessionId = sessionId;
    }

    let answered = false;
    let abandon: (() => void) | null = null;
    const respond = (json: HookResponse): void => {
      if (answered) return;
      answered = true;
      open.delete(respond);
      if (res.writableEnded || res.destroyed) return;
      const payload = JSON.stringify(json);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    };
    open.set(respond, res);
    res.on('close', () => {
      if (answered) return;
      answered = true;
      open.delete(respond);
      abandon?.();
    });
    // Сбой записи ответа (CLI закрыл сокет первым) — не повод падать: `close` уже всё снял.
    res.on('error', () => {});

    const request: HookRequest = {
      ref: registration.ref,
      body,
      respond,
      onAbandon(listener) {
        abandon = listener;
      },
    };
    try {
      options.onHook(request);
    } catch (error) {
      log.warn('приёмник хуков: обработчик события упал', { event, error: String(error) });
      respond(EMPTY_HOOK_RESPONSE);
    }
  }

  return {
    http: server,
    listen() {
      return new Promise<string>((resolve, rejectListen) => {
        const onError = (error: Error): void => rejectListen(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError);
          // После старта ошибка сервера только в лог: падать хосту из-за приёмника нельзя.
          server.on('error', (error) =>
            log.warn('приёмник хуков: ошибка сервера', { error: error.message }),
          );
          const { port } = server.address() as AddressInfo;
          address = `http://127.0.0.1:${port}${HOOK_PATH}`;
          resolve(address);
        });
      });
    },
    url: () => address,
    register(ref, providerSessionId, provider = 'claude') {
      const key = refKey(ref);
      const previous = tokenOfSession.get(key);
      if (previous !== undefined) byToken.delete(previous);
      const token = randomBytes(32).toString('hex');
      byToken.set(token, {
        ref: { ...ref },
        token,
        providerSessionId,
        events: provider === 'codex' ? CODEX_EVENTS : FEED_EVENTS,
      });
      tokenOfSession.set(key, token);
      return token;
    },
    unregister(ref) {
      const key = refKey(ref);
      const token = tokenOfSession.get(key);
      if (token === undefined) return;
      tokenOfSession.delete(key);
      byToken.delete(token);
    },
    close() {
      closing ??= (async () => {
        // Ответы сначала уходят в сокеты, и только потом соединения рвутся: иначе `{}` терялся бы в
        // буфере, а CLI ждал бы свой час.
        const flushed = Array.from(open).map(
          ([respond, res]) =>
            new Promise<void>((resolve) => {
              res.once('finish', resolve);
              res.once('close', resolve);
              respond(EMPTY_HOOK_RESPONSE);
              if (res.writableFinished || res.destroyed) resolve();
            }),
        );
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all(flushed),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CLOSE_FLUSH_MS);
          }),
        ]);
        clearTimeout(timer);
        address = null;
        if (!server.listening) return;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
