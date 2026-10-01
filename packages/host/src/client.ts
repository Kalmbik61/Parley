import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { encodeLine } from '@parley/protocol';
import type { EventMessage, ResponseMessage } from '@parley/protocol';

/** Буфер записи сокета выше этого порога — клиент, скорее всего, не успевает читать. */
const HIGH_WATER_MARK = 4 * 1024 * 1024;

export interface Client {
  id: string;
  name: string;
  /** `false` — буфер записи выше порога (вызывающая сторона решает, что делать). */
  send(message: ResponseMessage | EventMessage): boolean;
  writableLength(): number;
  close(): void;
}

export function createClient(socket: Socket, name: string): Client {
  return {
    id: randomUUID(),
    name,
    send(message) {
      if (socket.destroyed) return false;
      socket.write(encodeLine(message));
      return socket.writableLength <= HIGH_WATER_MARK;
    },
    writableLength: () => socket.writableLength,
    close() {
      socket.end();
    },
  };
}
