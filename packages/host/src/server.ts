import { createServer as createNetServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import {
  LineDecoder,
  LineTooLongError,
  PROTOCOL_VERSION,
  parseIncoming,
} from '@harnas/protocol';
import type { MethodName, NotificationName, ResponseMessage } from '@harnas/protocol';
import { createClient } from './client.js';
import type { Client } from './client.js';
import type { AnyHandler, AnyNotificationHandler, HostContext, RequestInfo } from './context.js';
import { HostError } from './errors.js';

export interface ServerOptions {
  context: HostContext;
  token: string;
  helloTimeoutMs: number;
  methodHandlers: Partial<Record<MethodName, AnyHandler>>;
  notificationHandlers: Partial<Record<NotificationName, AnyNotificationHandler>>;
  registerClient: (client: Client) => void;
  unregisterClient: (client: Client) => void;
}

interface HelloParams {
  token: string;
  protocol: number;
  client: string;
}

/** Пишет один кадр напрямую в сокет — до рукопожатия у соединения ещё нет `Client`. */
function writeRaw(socket: Socket, message: ResponseMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

export function createHostServer(options: ServerOptions): Server {
  return createNetServer((socket) => {
    handleConnection(socket, options);
  });
}

function handleConnection(socket: Socket, options: ServerOptions): void {
  const decoder = new LineDecoder();
  let client: Client | null = null;

  // Первое сообщение должно быть `hello` за `helloTimeoutMs`, иначе — закрытие
  // без ответа (клиент ничего не прислал, отвечать нечему).
  const helloTimer = setTimeout(() => socket.destroy(), options.helloTimeoutMs);
  helloTimer.unref();

  socket.on('data', (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      if (error instanceof LineTooLongError) {
        socket.destroy();
        return;
      }
      throw error;
    }
    for (const raw of messages) {
      if (!client) {
        client = handleHello(raw, socket, options, helloTimer);
        continue;
      }
      handleMessage(raw, client, options);
    }
  });

  socket.on('close', () => {
    clearTimeout(helloTimer);
    if (client) options.unregisterClient(client);
  });

  // 'error' без обработчика роняет процесс; 'close' придёт следом сам по себе
  // и снимет клиента — здесь достаточно не дать необработанному исключению.
  socket.on('error', () => {});
}

function handleHello(
  raw: unknown,
  socket: Socket,
  options: ServerOptions,
  helloTimer: NodeJS.Timeout,
): Client | null {
  const parsed = parseIncoming(raw);

  if (parsed.kind !== 'request' || parsed.message.method !== 'hello') {
    // Уведомление до hello тоже отклоняется, но у него нет id — отвечать нечем.
    const id = parsed.kind === 'notification' ? null : parsed.kind === 'invalid' ? parsed.id : parsed.message.id;
    if (id !== null) {
      writeRaw(socket, { id, error: { code: 'unauthorized', message: 'первое сообщение должно быть hello' } });
    }
    socket.end();
    return null;
  }

  clearTimeout(helloTimer);
  const { id } = parsed.message;
  const hello = parsed.params as HelloParams;

  if (hello.token !== options.token) {
    writeRaw(socket, { id, error: { code: 'unauthorized', message: 'неверный токен' } });
    socket.end();
    return null;
  }

  if (hello.protocol !== PROTOCOL_VERSION) {
    writeRaw(socket, {
      id,
      error: {
        code: 'protocol_mismatch',
        message: `хост понимает протокол ${PROTOCOL_VERSION}, клиент прислал ${hello.protocol}`,
        data: { hostVersion: options.context.version, liveSessions: options.context.liveSessions() },
      },
    });
    socket.end();
    return null;
  }

  const registered = createClient(socket, hello.client);
  writeRaw(socket, {
    id,
    result: { hostVersion: options.context.version, protocol: PROTOCOL_VERSION, pid: process.pid },
  });
  options.registerClient(registered);
  return registered;
}

function handleMessage(raw: unknown, client: Client, options: ServerOptions): void {
  const parsed = parseIncoming(raw);
  const request: RequestInfo = { client, host: options.context };

  if (parsed.kind === 'invalid') {
    if (parsed.id !== null) {
      client.send({ id: parsed.id, error: parsed.error });
    } else {
      options.context.log.warn('нераспознанное уведомление', { error: parsed.error.message });
    }
    return;
  }

  if (parsed.kind === 'notification') {
    const handler = options.notificationHandlers[parsed.message.method];
    // Ответить на уведомление нечем, а исключение отсюда уходит в обработчик
    // 'data' сокета и роняет весь хост: `pty.resize` терминала, чей PTY остался
    // у прежнего хоста, валил каждый новый хост сразу после подключения окна.
    try {
      handler?.(parsed.params as never, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.context.log.warn('обработчик уведомления упал', { method: parsed.message.method, error: message });
    }
    return;
  }

  const { id, method } = parsed.message;
  const handler = options.methodHandlers[method];
  if (!handler) {
    // Схема метода известна протоколу (иначе parseIncoming вернул бы invalid),
    // но этот кусок хоста ещё не завёл для него обработчик — появится позже.
    client.send({ id, error: { code: 'unknown_method', message: `метод пока не реализован: ${method}` } });
    return;
  }

  Promise.resolve(handler(parsed.params as never, request))
    .then((result) => {
      client.send({ id, result });
    })
    .catch((error: unknown) => {
      // `HostError` несёт свой код протокола (`conflict`, `bad_request`, …) —
      // остальное считаем неожиданным сбоем и заворачиваем в `internal`.
      if (error instanceof HostError) {
        const errorField = error.data === undefined
          ? { code: error.code, message: error.message }
          : { code: error.code, message: error.message, data: error.data };
        client.send({ id, error: errorField });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      options.context.log.error('обработчик метода упал', { method, error: message });
      client.send({ id, error: { code: 'internal', message } });
    });
}
