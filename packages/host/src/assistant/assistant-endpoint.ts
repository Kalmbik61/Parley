/**
 * Приёмник инструментов помощника (спека 2026-10-14, 7.1): `POST /assistant/<tool>` на том же сервере 127.0.0.1, что
 * принимает хуки (`hooks/hook-server.ts`, параметр `routes`) — по одному точному пути на инструмент, как у
 * `/agent/browser`. Токен разговора один (`setToken`); у каждого job свой токен (`jobTokens`), привязанный к `jobId`
 * (план голоса, T1). Сравнение в постоянное время; `null` — маршруты разговора закрыты. Токен job вызывает только
 * инструменты из `JOB_TOOL_ALLOWLIST`, остальное — 403 без вызова сервиса: токен разговора job не получает; `link_request` — наоборот, только для токена job. Отказы доступа — без тела, как у хуков: токен — 401, тело больше 1 МиБ — 413, не JSON-объект — 400.
 * Ответ обработчика уходит как есть: `200 {text}` или не-200 `{error}` (режим помощника `parley-mcp` читает оба).
 *
 * Журнал — одна строка на вызов: инструмент и статус; аргументов (там текст человека) и токена в нём нет.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JOB_ONLY_TOOLS, JOB_TOOL_ALLOWLIST } from '@parley/core';
import type { Log } from '../log.js';
import type { JobTokens } from './job-tokens.js';

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
  'link_request',
] as const;
/** Предел тела вызова: аргументы инструментов — короткие строки. */
export const ASSISTANT_BODY_LIMIT = 1024 * 1024;

/** Кто вызывает: разговор помощника или фоновый job (его `jobId` хост знает по токену, не со слов модели). */
export type AssistantCaller = { kind: 'conversation' } | { kind: 'job'; jobId: string };

/** Ответ инструмента: статус и тело для MCP-сервера помощника. */
export interface AssistantReply {
  status: number;
  body: { text: string } | { error: string };
}

export interface AssistantEndpointOptions {
  log: Log;
  /** Вызов инструмента (`assistant-service.tool`) от разговора или от job. */
  tool(name: string, args: unknown, caller: AssistantCaller): Promise<AssistantReply>;
  /** Токены job; без них маршруты принимают только токен разговора. */
  jobTokens?: Pick<JobTokens, 'jobOf'>;
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

  /** Чей это токен; `null` — ничей. */
  const authenticate = (header: string | undefined): AssistantCaller | null => {
    const bearer = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : '';
    const given = Buffer.from(bearer);
    if (token !== null && given.length === token.length && timingSafeEqual(given, token)) return { kind: 'conversation' };
    const jobId = bearer === '' ? null : (options.jobTokens?.jobOf(bearer) ?? null);
    return jobId === null ? null : { kind: 'job', jobId };
  };

  /** Отказ без тела; соединение закрывается — недочитанное тело дальше не читается. */
  function refuse(req: IncomingMessage, res: ServerResponse, status: 400 | 401 | 403 | 413, reason: string): void {
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
    const caller = authenticate(headerOf(req, 'authorization'));
    if (caller === null) {
      refuse(req, res, 401, 'token');
      return;
    }
    if (caller.kind === 'job' && !JOB_TOOL_ALLOWLIST.includes(name)) {
      refuse(req, res, 403, 'job-tool');
      return;
    }
    // `link_request` принадлежит job: токен разговора его не вызывает.
    if (caller.kind === 'conversation' && JOB_ONLY_TOOLS.includes(name)) {
      refuse(req, res, 403, 'job-only-tool');
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
        .tool(name, args, caller)
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
