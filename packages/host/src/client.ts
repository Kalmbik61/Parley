import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { encodeLine } from '@parley/protocol';
import type { EventMessage, ResponseMessage } from '@parley/protocol';
import { REMOTE_EVENTS } from '@parley/protocol/remote';

/** Буфер записи сокета выше этого порога — клиент, скорее всего, не успевает читать. */
const HIGH_WATER_MARK = 4 * 1024 * 1024;

/** `remote` — мост телефонов (спека мобильного приложения 4.1): только белый список этапа. */
export type ClientRole = 'remote';

export interface Client {
  id: string;
  name: string;
  /** Что клиент заявил в `hello.features` (например, `compact-works`); пусто — клиент до этих возможностей. */
  features: ReadonlySet<string>;
  /** Нет поля — полный клиент (окно, Telegram и прочие внутренние `Client`). Задаётся один раз, в `hello`. */
  readonly role?: ClientRole;
  /** `false` — буфер записи выше порога (вызывающая сторона решает, что делать). */
  send(message: ResponseMessage | EventMessage): boolean;
  /** Кадр, уже закодированный `encodeLine`: рассылка одного события многим клиентам кодирует его один раз. Нет — клиент шлёт через `send`. */
  sendLine?(line: string): boolean;
  writableLength(): number;
  close(): void;
}

const REMOTE_EVENT_SET: ReadonlySet<string> = new Set(REMOTE_EVENTS);

/**
 * Пропускает ли граница кадр к клиенту `remote` (спека 4.1, точка «отправка»): событие — только из `REMOTE_EVENTS`,
 * ответ — кадр с числовым `id` без `event`. Всё прочее не уходит.
 */
export function remoteMayReceive(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return false;
  const fields = frame as Record<string, unknown>;
  if (fields.event !== undefined) return typeof fields.event === 'string' && REMOTE_EVENT_SET.has(fields.event);
  return typeof fields.id === 'number';
}

/**
 * Готовая строка для клиента `remote`: решает разобранный кадр, а не поиск подстроки. Строка — ровно один кадр с `\n`
 * в конце и нигде больше: иначе получатель режет её на несколько кадров, и проверенный кадр не тот, что дойдёт.
 */
function remoteMayReceiveLine(line: string): boolean {
  if (line.indexOf('\n') !== line.length - 1) return false;
  try {
    return remoteMayReceive(JSON.parse(line));
  } catch {
    return false;
  }
}

export function createClient(
  socket: Socket,
  name: string,
  features: readonly string[] = [],
  role?: ClientRole,
): Client {
  const writeLine = (line: string): boolean => {
    if (socket.destroyed) return false;
    socket.write(line);
    return socket.writableLength <= HIGH_WATER_MARK;
  };
  // Отброшенный кадр — не переполнение буфера: `true`, чтобы вызывающая сторона не сочла клиента медленным.
  const remote = role === 'remote';
  const sendLine = remote
    ? (line: string): boolean => (remoteMayReceiveLine(line) ? writeLine(line) : true)
    : writeLine;
  return {
    id: randomUUID(),
    name,
    features: new Set(features),
    ...(remote ? { role } : {}),
    send(message) {
      if (socket.destroyed) return false;
      if (remote && !remoteMayReceive(message)) return true;
      return writeLine(encodeLine(message));
    },
    sendLine,
    writableLength: () => socket.writableLength,
    close() {
      socket.end();
    },
  };
}
