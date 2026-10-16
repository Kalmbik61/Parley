import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { encodeLine } from '@parley/protocol';
import type { EventMessage, ResponseMessage } from '@parley/protocol';

/** Буфер записи сокета выше этого порога — клиент, скорее всего, не успевает читать. */
const HIGH_WATER_MARK = 4 * 1024 * 1024;

export interface Client {
  id: string;
  name: string;
  /** Что клиент заявил в `hello.features` (например, `compact-works`); пусто — клиент до этих возможностей. */
  features: ReadonlySet<string>;
  /** `false` — буфер записи выше порога (вызывающая сторона решает, что делать). */
  send(message: ResponseMessage | EventMessage): boolean;
  /** Кадр, уже закодированный `encodeLine`: рассылка одного события многим клиентам кодирует его один раз. Нет — клиент шлёт через `send`. */
  sendLine?(line: string): boolean;
  writableLength(): number;
  close(): void;
}

export function createClient(socket: Socket, name: string, features: readonly string[] = []): Client {
  const sendLine = (line: string): boolean => {
    if (socket.destroyed) return false;
    socket.write(line);
    return socket.writableLength <= HIGH_WATER_MARK;
  };
  return {
    id: randomUUID(),
    name,
    features: new Set(features),
    send(message) {
      if (socket.destroyed) return false;
      return sendLine(encodeLine(message));
    },
    sendLine,
    writableLength: () => socket.writableLength,
    close() {
      socket.end();
    },
  };
}
