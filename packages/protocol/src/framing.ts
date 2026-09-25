import type { ZodTypeAny } from 'zod';
import { METHODS, NOTIFICATIONS } from './methods.js';
import type { MethodName, NotificationName } from './methods.js';
import type { EventName } from './events.js';
import type { ProtocolError } from './types.js';

/**
 * Предохранитель от строки без конца: поток на десятки мегабайт (агент вывел
 * большой файл) не должен раздуть буфер хоста до исчерпания памяти.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface RequestMessage {
  id: number;
  method: MethodName;
  params: unknown;
}

export interface NotificationMessage {
  method: NotificationName;
  params: unknown;
}

export type ResponseMessage = { id: number; result: unknown } | { id: number; error: ProtocolError };

export interface EventMessage {
  event: EventName;
  data: unknown;
}

/** Кодирует сообщение в одну NDJSON-строку с переводом строки на конце. */
export function encodeLine(
  message: RequestMessage | NotificationMessage | ResponseMessage | EventMessage,
): string {
  return `${JSON.stringify(message)}\n`;
}

export class LineTooLongError extends Error {
  constructor(message = `строка длиннее ${MAX_LINE_BYTES} байт`) {
    super(message);
    this.name = 'LineTooLongError';
  }
}

/**
 * Режет поток байт на строки по `\n`. Строки копятся как байты, а не как
 * текст, — байт `\n` (0x0A) в UTF-8 не встречается внутри многобайтового
 * знака, так что разрез по нему безопасен, а `ё` и `😀` на стыке кусков
 * собираются целыми ещё до превращения в строку.
 */
export class LineDecoder {
  private carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    const data: Buffer<ArrayBufferLike> =
      this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const messages: unknown[] = [];
    let start = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, start);
      if (newline === -1) break;
      if (newline - start > MAX_LINE_BYTES) throw new LineTooLongError();
      const line = data.toString('utf8', start, newline);
      start = newline + 1;
      if (line.length > 0) messages.push(JSON.parse(line));
    }
    const restLength = data.length - start;
    if (restLength > MAX_LINE_BYTES) throw new LineTooLongError();
    this.carry = start === 0 ? data : Buffer.from(data.subarray(start));
    return messages;
  }
}

export type Incoming =
  | { kind: 'request'; message: RequestMessage; params: unknown }
  | { kind: 'notification'; message: NotificationMessage; params: unknown }
  | { kind: 'invalid'; id: number | null; error: ProtocolError };

/** Разбор и проверка по схеме: `params` в результате уже прошли zod. */
export function parseIncoming(raw: unknown): Incoming {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', id: null, error: { code: 'bad_request', message: 'ожидался объект' } };
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'number' ? obj.id : null;
  const method = obj.method;
  if (typeof method !== 'string') {
    return { kind: 'invalid', id, error: { code: 'bad_request', message: 'нет поля method' } };
  }

  if (id !== null) {
    const schema = (METHODS as Record<string, ZodTypeAny>)[method];
    if (!schema) {
      return {
        kind: 'invalid',
        id,
        error: { code: 'unknown_method', message: `неизвестный метод: ${method}` },
      };
    }
    const result = schema.safeParse(obj.params);
    if (!result.success) {
      return { kind: 'invalid', id, error: { code: 'bad_request', message: result.error.message } };
    }
    return {
      kind: 'request',
      message: { id, method: method as MethodName, params: obj.params },
      params: result.data,
    };
  }

  const schema = (NOTIFICATIONS as Record<string, ZodTypeAny>)[method];
  if (!schema) {
    return {
      kind: 'invalid',
      id: null,
      error: { code: 'unknown_method', message: `неизвестный метод: ${method}` },
    };
  }
  const result = schema.safeParse(obj.params);
  if (!result.success) {
    return { kind: 'invalid', id: null, error: { code: 'bad_request', message: result.error.message } };
  }
  return {
    kind: 'notification',
    message: { method: method as NotificationName, params: obj.params },
    params: result.data,
  };
}
