/**
 * Приёмник операций агента над браузером окна (спека 2026-10-07-browser-devtools-agent-design.md, 3.7; этап B2): путь
 * `POST /agent/browser` на том же HTTP-сервере 127.0.0.1, что принимает хуки (`hooks/hook-server.ts`, параметр
 * `routes`), но свой реестр токенов: у Codex хуков нет, а канал агента нужен всем провайдерам.
 *
 * Отказы доступа — без тела, как у хуков: токен — 401, тело больше 64 КБ — 413. Остальное — 200 и
 * `BrowserAgentResult`: агенту нужен код и текст, а не статус HTTP. Операция уходит одному окну — последнему
 * подключившемуся клиенту с возможностью `browser-agent`: два окна не должны исполнить одну операцию дважды. Окна нет —
 * `window_not_connected`, есть только окно старой сборки — `unsupported` (спека 9), окно молчит `AGENT_LIMITS.opMs` —
 * `timeout`, окно ушло — `window_not_connected` сразу. Ответ принимается только от клиента, которому ушла операция.
 *
 * Сессию находит токен, а не тело: работу операции задаёт хост (`ref` события), агент назвать чужую не может. Хозяев,
 * которыми сессия может пользоваться (`owners`: она сама и комнаты, где она участник), хост вкладывает в событие сам
 * (спека 3.10).
 *
 * Журнал — одна строка на операцию: сессия, операция, вкладка, origin, исход. Аргументов, путей и query адресов,
 * данных страницы и токенов в нём нет.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionTag } from '@parley/core';
import { AGENT_LIMITS, BROWSER_AGENT_FEATURE, browserAgentArgs, browserAgentRequest, refKey } from '@parley/protocol';
import type { BrowserAgentErrorCode, BrowserAgentOp, BrowserAgentOpEvent, BrowserAgentOwner, BrowserAgentResult, SessionRef } from '@parley/protocol';
import type { Client } from '../client.js';
import type { Log } from '../log.js';

/** Путь приёмника на сервере хуков; адрес для MCP-сервера — `<origin сервера хуков><путь>`. */
export const AGENT_BROWSER_PATH = '/agent/browser';

export interface BrowserEndpointOptions {
  log: Log;
  /** Клиенты хоста; окно — клиент с `browser-agent` в `hello.features`. */
  clients(): readonly Client[];
  /**
   * Id комнат работы сессии, где она участник и которые не в архиве (спека 3.10). Читает карту из памяти хоста, не с
   * диска: на пути операции хост только ищет токен и пересылает (спека 3.7, заметка 2026-10-16). Работы нет — пусто.
   */
  roomsOf(ref: SessionRef): readonly string[];
  /** Срок ответа окна; по умолчанию `AGENT_LIMITS.opMs`. Тестам — меньше. */
  timeoutMs?: number;
}

export interface BrowserEndpoint {
  /** Токен запуска сессии для `PARLEY_AGENT_TOKEN`: 32 байта hex. Прежний токен той же сессии отзывается. */
  register(ref: SessionRef): string;
  /** Отзывает токен сессии: её запросы дальше — 401. */
  unregister(ref: SessionRef): void;
  /** Обработчик пути `AGENT_BROWSER_PATH` для сервера хуков. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Ответ окна (`browser.agentResult`). `false` — операции нет (закрыта сроком или уходом окна) или ответил не тот клиент. */
  resolve(opId: string, result: BrowserAgentResult, from: Client): boolean;
  /** Окно ушло: его операции сразу получают `window_not_connected`. */
  dropClient(client: Client): void;
  /** Остановка хоста: всем висящим — `window_not_connected`. */
  close(): void;
}

interface Pending {
  client: Client;
  ref: SessionRef;
  op: BrowserAgentOp;
  args: unknown;
  startedAt: number;
  timer: NodeJS.Timeout;
  reply(result: BrowserAgentResult): void;
}

const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Строка заголовка; у повторённого заголовка Node отдаёт массив — такой не принимаем. */
const headerOf = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Поле объекта, если это строка. */
function stringField(value: unknown, name: string): string | null {
  return isRecord(value) && typeof value[name] === 'string' ? value[name] : null;
}

/** Origin первого разбираемого адреса — только для журнала: путь, query и hash в него не идут. */
function originOf(...candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    if (candidate === null) continue;
    try {
      const { origin } = new URL(candidate);
      if (origin !== 'null') return origin;
    } catch {
      // Не адрес — следующий кандидат.
    }
  }
  return null;
}

export function createBrowserEndpoint(options: BrowserEndpointOptions): BrowserEndpoint {
  const { log } = options;
  const timeoutMs = options.timeoutMs ?? AGENT_LIMITS.opMs;
  const byToken = new Map<string, SessionRef>();
  const tokenOfSession = new Map<string, string>();
  const pending = new Map<string, Pending>();

  function send(res: ServerResponse, result: BrowserAgentResult): void {
    if (res.writableEnded || res.destroyed) return;
    const payload = JSON.stringify(result);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) });
    res.end(payload);
  }

  /** Отказ без тела; соединение закрывается — недочитанное тело дальше не читается. */
  function refuse(req: IncomingMessage, res: ServerResponse, status: 401 | 413, reason: string): void {
    if (!res.headersSent) {
      log.warn('операция агента отклонена', { status, reason });
      res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
    }
    res.end(() => req.socket.destroy());
  }

  function record(ref: SessionRef, op: BrowserAgentOp, args: unknown, result: BrowserAgentResult, ms: number): void {
    log.info('операция агента в браузере', {
      projectPath: ref.projectPath,
      workId: ref.workId,
      sessionId: ref.sessionId,
      op: 'browser.agentOp',
      agentOp: op,
      tab: stringField(args, 'tab') ?? (result.ok ? stringField(result.result, 'tab') : null),
      origin: originOf(stringField(args, 'url'), result.ok ? stringField(result.result, 'url') : null),
      outcome: result.ok ? 'ok' : result.error.code,
      ms,
    });
  }

  function finish(opId: string, result: BrowserAgentResult): void {
    const entry = pending.get(opId);
    if (entry === undefined) return;
    pending.delete(opId);
    clearTimeout(entry.timer);
    record(entry.ref, entry.op, entry.args, result, Date.now() - entry.startedAt);
    entry.reply(result);
  }

  function dispatch(ref: SessionRef, body: unknown, res: ServerResponse): void {
    const request = browserAgentRequest.safeParse(body);
    if (!request.success) {
      send(res, failure('bad_request', 'Unknown browser operation or malformed request.'));
      return;
    }
    const { op } = request.data;
    const args = browserAgentArgs[op].safeParse(request.data.args ?? {});
    if (!args.success) {
      const issue = args.error.issues[0];
      const where = issue === undefined || issue.path.length === 0 ? 'args' : issue.path.join('.');
      send(res, failure('bad_request', `Invalid arguments for ${op}: ${where} — ${issue?.message ?? 'invalid'}.`));
      return;
    }
    const clients = options.clients();
    const window = clients.filter((client) => client.features.has(BROWSER_AGENT_FEATURE)).at(-1);
    if (window === undefined) {
      const old = clients.some((client) => client.name === 'desktop');
      const result = old
        ? failure('unsupported', "Parley's window is older than its host and cannot run browser operations: ask the human to restart Parley.")
        : failure('window_not_connected', "Parley's window is not connected to the host: ask the human to open Parley.");
      record(ref, op, args.data, result, 0);
      send(res, result);
      return;
    }
    const opId = randomUUID();
    const timer = setTimeout(
      () => finish(opId, failure('timeout', `The window did not answer within ${Math.round(timeoutMs / 1000)} s.`)),
      timeoutMs,
    );
    pending.set(opId, { client: window, ref, op, args: args.data, startedAt: Date.now(), timer, reply: (result) => send(res, result) });
    // Агент оборвал запрос (MCP-клиент отменил вызов): операцию закрываем, поздний ответ окна уже не примется.
    res.on('close', () => {
      if (pending.has(opId)) finish(opId, failure('timeout', 'The agent cancelled the request.'));
    });
    // Хозяева на момент операции: сама сессия и её комнаты. Вышла из комнаты — со следующей операции доступа нет.
    const owners: BrowserAgentOwner[] = [
      { kind: 'session', sessionId: ref.sessionId },
      ...options.roomsOf(ref).map((roomId): BrowserAgentOwner => ({ kind: 'room', roomId })),
    ];
    const event: BrowserAgentOpEvent = { opId, ref, label: sessionTag(ref.sessionId), owners, op, args: args.data };
    window.send({ event: 'browser.agentOp', data: event });
  }

  return {
    register(ref) {
      const key = refKey(ref);
      const previous = tokenOfSession.get(key);
      if (previous !== undefined) byToken.delete(previous);
      const token = randomBytes(32).toString('hex');
      byToken.set(token, { ...ref });
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
    handle(req, res) {
      const auth = headerOf(req, 'authorization');
      const token = auth?.startsWith('Bearer ') === true ? auth.slice('Bearer '.length).trim() : '';
      const ref = token === '' ? undefined : byToken.get(token);
      if (ref === undefined) {
        refuse(req, res, 401, 'token');
        return;
      }
      const declared = Number(headerOf(req, 'content-length') ?? '0');
      if (Number.isFinite(declared) && declared > AGENT_LIMITS.requestBytes) {
        refuse(req, res, 413, 'body-size');
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > AGENT_LIMITS.requestBytes) {
          rejected = true;
          chunks.length = 0;
          req.pause();
          refuse(req, res, 413, 'body-size');
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        rejected = true;
      });
      req.on('end', () => {
        if (rejected) return;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        } catch {
          send(res, failure('bad_request', 'The request body is not JSON.'));
          return;
        }
        dispatch(ref, body, res);
      });
    },
    resolve(opId, result, from) {
      const entry = pending.get(opId);
      if (entry === undefined || entry.client.id !== from.id) return false;
      finish(opId, result);
      return true;
    },
    dropClient(client) {
      for (const [opId, entry] of [...pending]) {
        if (entry.client.id === client.id) finish(opId, failure('window_not_connected', "Parley's window disconnected during the operation."));
      }
    },
    close() {
      for (const opId of [...pending.keys()]) finish(opId, failure('window_not_connected', 'The Parley host is shutting down.'));
    },
  };
}
