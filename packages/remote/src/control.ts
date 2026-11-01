import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';
import { z } from 'zod';
import { LineDecoder } from '@parley/protocol';
import {
  controlAuditTailParams,
  controlConfigureParams,
  controlPresenceParams,
  controlRevokeParams,
  controlStatusResult,
  pairAnswerParams,
  pairDoneEvent,
  pairFailedEvent,
  pairOfferClosedEvent,
  pairRequestEvent,
  pairStartResult,
} from '@parley/protocol/remote';
import type { AuditLog, AuditRecord } from './audit.js';
import { ensureDir, writeFileAtomic } from './files.js';
import type { BridgeLog } from './log.js';

/** Код отказа обработчика: уходит окну как есть (`stale_request`, `not_found`…). */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

/** Запись устройства для окна: без ключей и хэшей токенов. */
export interface ControlDeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeen: number | null;
}

/** Обработчики, которые регистрирует A7. Пока их нет — `not_ready`. */
export interface ControlHandlers {
  'pair.start': () => Promise<z.infer<typeof pairStartResult>>;
  'pair.cancel': () => Promise<void>;
  'pair.answer': (params: z.infer<typeof pairAnswerParams>) => Promise<void>;
  'devices.list': () => Promise<ControlDeviceInfo[]>;
  'devices.revoke': (params: z.infer<typeof controlRevokeParams>) => Promise<void>;
  reset: () => Promise<void>;
}

/** Состояние и действия, которые сокет только вызывает. */
export interface ControlCallbacks {
  status(): z.infer<typeof controlStatusResult>;
  configure(params: z.infer<typeof controlConfigureParams>): Promise<void>;
  presence(params: z.infer<typeof controlPresenceParams>): void;
  pushTest(params: z.infer<typeof controlRevokeParams>): Promise<void>;
  /** Вызывается после ответа окну. */
  stop(): void | Promise<void>;
}

export interface ControlEvents {
  'pair.request': z.infer<typeof pairRequestEvent>;
  'pair.done': z.infer<typeof pairDoneEvent>;
  'pair.failed': z.infer<typeof pairFailedEvent>;
  'pair.offerClosed': z.infer<typeof pairOfferClosedEvent>;
}

export interface ControlServerOptions {
  socketPath: string;
  tokenPath: string;
  audit: AuditLog;
  log: BridgeLog;
  callbacks: ControlCallbacks;
  /** Число аутентифицированных соединений окна изменилось (присутствие без окна — `null`, спека 9.3). */
  onClientsChanged?: (count: number) => void;
  helloTimeoutMs?: number;
}

export interface ControlServer {
  start(): Promise<void>;
  close(): Promise<void>;
  /** Регистрация обработчиков A7; повторный вызов заменяет прежние. */
  register(handlers: Partial<ControlHandlers>): void;
  emit<E extends keyof ControlEvents>(event: E, data: ControlEvents[E]): void;
}

const helloParams = z.strictObject({ token: z.string().min(1).max(256) });
const empty = z.strictObject({});
const OK = { ok: true } as const;

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

type Reply = { result: unknown } | { error: { code: string; message: string } };

/**
 * Сокет управления (спека 5.3): NDJSON, первый кадр `hello {token}`, дальше запросы окна
 * `{id, method, params}`. Ответ уходит окну только после завершения обработчика.
 */
export function createControlServer(options: ControlServerOptions): ControlServer {
  const { callbacks, audit, log } = options;
  const handlers: Partial<ControlHandlers> = {};
  const clients = new Set<net.Socket>();
  let token = '';
  let server: net.Server | null = null;

  function routed<K extends keyof ControlHandlers>(
    name: K,
    call: (handler: ControlHandlers[K]) => Promise<unknown>,
  ): () => Promise<unknown> {
    return async () => {
      const handler = handlers[name];
      if (!handler) throw new ControlError('not_ready', `${name} is not ready`);
      return call(handler);
    };
  }

  async function dispatch(method: string, rawParams: unknown): Promise<Reply> {
    const parse = <S extends z.ZodType>(schema: S): z.infer<S> => {
      const parsed = schema.safeParse(rawParams ?? {});
      if (!parsed.success) throw new ControlError('bad_request', 'invalid params');
      return parsed.data;
    };
    try {
      switch (method) {
        case 'status':
          parse(empty);
          return { result: controlStatusResult.parse(callbacks.status()) };
        case 'configure':
          await callbacks.configure(parse(controlConfigureParams));
          return { result: OK };
        case 'audit.tail': {
          const { limit } = parse(controlAuditTailParams);
          const records: AuditRecord[] = audit.tail(limit);
          return { result: { records } };
        }
        case 'presence':
          callbacks.presence(parse(controlPresenceParams));
          return { result: OK };
        case 'push.test':
          await callbacks.pushTest(parse(controlRevokeParams));
          return { result: OK };
        case 'stop':
          parse(empty);
          return { result: OK };
        case 'pair.start':
          parse(empty);
          return { result: await routed('pair.start', (h) => h())() };
        case 'pair.cancel':
          parse(empty);
          await routed('pair.cancel', (h) => h())();
          return { result: OK };
        case 'pair.answer': {
          const params = parse(pairAnswerParams);
          await routed('pair.answer', (h) => h(params))();
          return { result: OK };
        }
        case 'devices.list':
          parse(empty);
          return { result: { devices: await routed('devices.list', (h) => h())() } };
        case 'devices.revoke': {
          const params = parse(controlRevokeParams);
          await routed('devices.revoke', (h) => h(params))();
          return { result: OK };
        }
        case 'reset':
          parse(empty);
          await routed('reset', (h) => h())();
          return { result: OK };
        default:
          return { error: { code: 'unknown_method', message: 'unknown method' } };
      }
    } catch (error) {
      if (error instanceof ControlError) return { error: { code: error.code, message: error.message } };
      // Текст чужой ошибки может нести значение; окну и логу — только имя.
      log.error('control.handler-failed', { method, error });
      return { error: { code: 'internal', message: 'internal error' } };
    }
  }

  /** Промис завершается, когда ответ записан в сокет (или сокет уже закрыт). */
  function send(socket: net.Socket, message: unknown): Promise<void> {
    return new Promise((resolve) => {
      if (!socket.writable) return resolve();
      socket.write(`${JSON.stringify(message)}\n`, () => resolve());
    });
  }

  /** Запросы всех соединений, которые ещё идут: `stop` дожидается их перед остановкой. */
  const running = new Set<Promise<void>>();
  let stopping = false;

  /** Сокет с живым слушателем: второй экземпляр моста его не затирает. */
  function isLive(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
  }

  function onConnection(socket: net.Socket): void {
    const decoder = new LineDecoder();
    let authed = false;
    let chain: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => socket.destroy(), options.helloTimeoutMs ?? 5000);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      if (clients.delete(socket)) options.onClientsChanged?.(clients.size);
    });

    const handle = async (raw: unknown): Promise<void> => {
      // Запросы одного соединения идут по очереди: ответы не обгоняют друг друга.
      const msg = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const id = msg && typeof msg.id === 'number' ? msg.id : null;
      if (!msg || id === null || typeof msg.method !== 'string') {
        if (id !== null) await send(socket, { id, error: { code: 'bad_request', message: 'malformed request' } });
        if (!authed) socket.end();
        return;
      }
      if (!authed) {
        const hello = msg.method === 'hello' ? helloParams.safeParse(msg.params) : null;
        if (!hello?.success || !tokensEqual(hello.data.token, token)) {
          await send(socket, { id, error: { code: 'unauthorized', message: 'invalid token' } });
          socket.end();
          return;
        }
        authed = true;
        clearTimeout(timer);
        clients.add(socket);
        options.onClientsChanged?.(clients.size);
        await send(socket, { id, result: OK });
        return;
      }
      if (stopping) {
        await send(socket, { id, error: { code: 'stopping', message: 'the bridge is stopping' } });
        return;
      }
      const work = dispatch(msg.method, msg.params);
      const tracked = work.then(() => undefined);
      running.add(tracked);
      let reply: Reply;
      try {
        reply = await work;
      } finally {
        running.delete(tracked);
      }
      if (msg.method === 'stop' && 'result' in reply) stopping = true;
      await send(socket, { id, ...reply });
      if (msg.method === 'stop' && 'result' in reply) {
        // Ответ записан; ждём запросы других соединений, потом остановка.
        await Promise.allSettled([...running]);
        try {
          await callbacks.stop();
        } catch (error) {
          log.error('control.stop-failed', { error });
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const raw of messages) chain = chain.then(() => handle(raw)).catch((error: unknown) => log.error('control.handle-failed', { error }));
    });
  }

  return {
    async start() {
      await ensureDir(options.socketPath.slice(0, options.socketPath.lastIndexOf('/')) || '/');
      if (await isLive(options.socketPath)) throw new Error('control socket is already in use by another bridge');
      await rm(options.socketPath, { force: true });
      stopping = false;
      token = randomBytes(32).toString('hex');
      log.addSecret(token);
      await writeFileAtomic(options.tokenPath, token);
      server = net.createServer(onConnection);
      const listening = server;
      await new Promise<void>((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(options.socketPath, () => {
          listening.off('error', reject);
          resolve();
        });
      });
      await chmod(options.socketPath, 0o600);
    },
    async close() {
      const had = clients.size;
      for (const socket of clients) socket.destroy();
      clients.clear();
      if (had > 0) options.onClientsChanged?.(0);
      const closing = server;
      server = null;
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
      await Promise.all([rm(options.socketPath, { force: true }), rm(options.tokenPath, { force: true })]);
    },
    register(next) {
      Object.assign(handlers, next);
    },
    emit(event, data) {
      for (const socket of clients) send(socket, { event, data });
    },
  };
}
