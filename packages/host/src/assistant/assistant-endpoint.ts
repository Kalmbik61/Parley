/**
 * Приёмник инструментов помощника (спека 2026-10-14, 7.1): `POST /assistant/<tool>` на том же сервере 127.0.0.1, что
 * принимает хуки (`hooks/hook-server.ts`, параметр `routes`) — по одному точному пути на инструмент, как у
 * `/agent/browser`. Токен один — у текущего разговора (`setToken`); сравнение в постоянное время; `null` — маршруты
 * закрыты. Отказы доступа — без тела, как у хуков: токен — 401, тело больше 1 МиБ — 413, не JSON-объект — 400.
 * Ответ обработчика уходит как есть: `200 {text}` или не-200 `{error}` (режим помощника `parley-mcp` читает оба).
 *
 * Журнал — одна строка на вызов: инструмент и статус; аргументов (там текст человека) и токена в нём нет.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Log } from '../log.js';

/** Основа путей приёмника; адрес для `PARLEY_ASSISTANT_URL` — `<origin сервера хуков>/assistant`. */
export const ASSISTANT_PATH = '/assistant';
/** Инструменты режима помощника `parley-mcp` (задача 4) — по пути на каждый. */
export const ASSISTANT_TOOL_NAMES = [
  'parley_overview',
  'parley_detail',
  'parley_find',
  'parley_room',
  'parley_session',
  'propose_message',
  'propose_room',
  'propose_decision',
  'propose_room_decision',
  'propose_actions',
  'schedule_check',
  'list_reminders',
  'cancel_reminder',
  'end_conversation',
] as const;
/** Предел тела вызова: аргументы инструментов — короткие строки. */
export const ASSISTANT_BODY_LIMIT = 1024 * 1024;

/** Ответ инструмента: статус и тело для MCP-сервера помощника. */
export interface AssistantReply {
  status: number;
  body: { text: string } | { error: string };
}

export interface AssistantEndpointOptions {
  log: Log;
  /** Вызов инструмента текущего разговора (`assistant-service.tool`). */
  tool(name: string, args: unknown): Promise<AssistantReply>;
}

export interface AssistantEndpoint {
  /** Маршруты для `routes` сервера хуков: `/assistant/<tool>` → обработчик. */
  routes(): Record<string, (req: IncomingMessage, res: ServerResponse) => void>;
  /** Токен текущего разговора; `null` — маршруты закрыты (разговора нет). */
  setToken(token: string | null): void;
}

const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createAssistantEndpoint(options: AssistantEndpointOptions): AssistantEndpoint {
  const { log } = options;
  let token: Buffer | null = null;

  const allowed = (header: string | undefined): boolean => {
    if (token === null) return false;
    const given = Buffer.from(header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : '');
    return given.length === token.length && timingSafeEqual(given, token);
  };

  /** Отказ без тела; соединение закрывается — недочитанное тело дальше не читается. */
  function refuse(req: IncomingMessage, res: ServerResponse, status: 400 | 401 | 413, reason: string): void {
    if (!res.headersSent) {
      log.warn('вызов инструмента помощника отклонён', { status, reason });
      res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
    }
    res.end(() => req.socket.destroy());
  }

  function reply(res: ServerResponse, result: AssistantReply): void {
    if (res.writableEnded || res.destroyed) return;
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) });
    res.end(payload);
  }

  function handle(name: string, req: IncomingMessage, res: ServerResponse): void {
    if (!allowed(headerOf(req, 'authorization'))) {
      refuse(req, res, 401, 'token');
      return;
    }
    const declared = Number(headerOf(req, 'content-length') ?? '0');
    if (Number.isFinite(declared) && declared > ASSISTANT_BODY_LIMIT) {
      refuse(req, res, 413, 'body-size');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > ASSISTANT_BODY_LIMIT) {
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
      const text = Buffer.concat(chunks, size).toString('utf8');
      let args: unknown = {};
      try {
        if (text.trim() !== '') args = JSON.parse(text);
      } catch {
        refuse(req, res, 400, 'json');
        return;
      }
      if (!isRecord(args)) {
        refuse(req, res, 400, 'json');
        return;
      }
      void options
        .tool(name, args)
        .catch((error: unknown): AssistantReply => ({ status: 500, body: { error: error instanceof Error ? error.message : String(error) } }))
        .then((result) => {
          log.info('инструмент помощника', { tool: name, status: result.status });
          reply(res, result);
        });
    });
  }

  return {
    routes: () =>
      Object.fromEntries(
        ASSISTANT_TOOL_NAMES.map((name) => [`${ASSISTANT_PATH}/${name}`, (req: IncomingMessage, res: ServerResponse) => handle(name, req, res)]),
      ),
    setToken: (next) => {
      token = next === null ? null : Buffer.from(next);
    },
  };
}
