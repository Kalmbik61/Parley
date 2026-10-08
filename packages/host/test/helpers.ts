import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { PROTOCOL_VERSION } from '@parley/protocol';

/**
 * Дом теста — всегда короткий путь прямо в `/tmp`: `os.tmpdir()` на macOS
 * упирается в лимит unix-сокета в 103 байта почти сразу же после
 * `host/host.sock`, а короткие тесты про этот лимит специально хотят другого.
 */
export async function tempHome(): Promise<string> {
  return mkdtemp('/tmp/hh-');
}

export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true });
}

export interface RawMessage {
  id?: number;
  result?: unknown;
  error?: { code: string; message: string; data?: Record<string, unknown> };
  event?: string;
  data?: unknown;
}

export interface TestClient {
  socket: Socket;
  send(message: unknown): void;
  next(): Promise<RawMessage>;
  close(): void;
}

/** Минимальный клиент протокола для тестов: без проверки схем, просто строки NDJSON. */
export function connectRaw(socketPath: string): TestClient {
  const socket = createConnection(socketPath);
  let carry = '';
  const queue: RawMessage[] = [];
  const waiters: Array<(value: RawMessage) => void> = [];

  socket.on('data', (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    let newline = carry.indexOf('\n');
    while (newline !== -1) {
      const line = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      if (line.length > 0) {
        const message = JSON.parse(line) as RawMessage;
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else queue.push(message);
      }
      newline = carry.indexOf('\n');
    }
  });

  return {
    socket,
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    next() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      socket.end();
    },
  };
}

export async function waitConnected(socket: Socket): Promise<void> {
  if (!socket.connecting) return;
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

/** Ждёт события `close` сокета — проверка, что сервер действительно оборвал соединение. */
export async function waitClosed(socket: Socket, timeoutMs = 1000): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('соединение не закрылось вовремя')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let nextHelloId = 1;

/** Отправляет `hello` и возвращает разобранный ответ. */
export async function hello(
  client: TestClient,
  token: string,
  overrides: { protocol?: number; client?: string; features?: string[] } = {},
): Promise<RawMessage> {
  const id = nextHelloId;
  nextHelloId += 1;
  client.send({
    id,
    method: 'hello',
    params: {
      token,
      protocol: overrides.protocol ?? PROTOCOL_VERSION,
      client: overrides.client ?? 'test',
      ...(overrides.features === undefined ? {} : { features: overrides.features }),
    },
  });
  return client.next();
}
