import type { EventData, EventName, MethodName, NotificationName, Params, Result } from '@parley/protocol';
import type { Client } from './client.js';
import type { Log } from './log.js';
import type { HostPaths } from './paths.js';

/** Общее состояние хоста, видимое обработчикам методов и серверу. */
export interface HostContext {
  version: string;
  startedAt: string;
  paths: HostPaths;
  log: Log;
  clients(): readonly Client[];
  /** Число занятых ключей `busy()` — живые PTY появятся в куске 1.6. */
  liveSessions(): number;
  /** `only` — кому слать: разным клиентам одно событие уходит в разном виде (`works.changed`, P35). */
  broadcast<E extends EventName>(event: E, data: EventData<E>, only?: (client: Client) => boolean): void;
  onShutdown(hook: () => Promise<void>): void;
  shutdown(reason: string): Promise<void>;
  busy(key: string, isBusy: boolean): void;
}

export interface RequestInfo {
  client: Client;
  host: HostContext;
}

export type Handler<M extends MethodName> = (
  params: Params<M>,
  request: RequestInfo,
) => Promise<Result<M>>;

export type NotificationHandler<N extends NotificationName> = (
  params: Params<N>,
  request: RequestInfo,
) => void;

/**
 * Метод в реестре обработчиков узнаётся в рантайме по строке, а не в
 * компиляции, поэтому точный `Handler<M>` до вызова не сохранить. `never` в
 * параметре — стандартный приём: конкретный `Handler<M>` присваивается сюда
 * без `any` (функция с более узким параметром совместима с более широким).
 */
export type AnyHandler = (params: never, request: RequestInfo) => Promise<unknown>;
export type AnyNotificationHandler = (params: never, request: RequestInfo) => void;

export interface CreateHostContextOptions {
  version: string;
  paths: HostPaths;
  log: Log;
  onIdleChange: (idle: boolean) => void;
  registerShutdownHook: (hook: () => Promise<void>) => void;
  requestShutdown: (reason: string) => Promise<void>;
}

export interface HostContextHandle {
  context: HostContext;
  addClient(client: Client): void;
  removeClient(client: Client): void;
}

/** Собирает `HostContext` вокруг множеств клиентов и занятых ключей `busy()`. */
export function createHostContext(options: CreateHostContextOptions): HostContextHandle {
  const clients = new Set<Client>();
  const busyKeys = new Set<string>();

  const notifyIdle = (): void => {
    options.onIdleChange(clients.size === 0 && busyKeys.size === 0);
  };

  const context: HostContext = {
    version: options.version,
    startedAt: new Date().toISOString(),
    paths: options.paths,
    log: options.log,
    clients: () => Array.from(clients),
    liveSessions: () => busyKeys.size,
    broadcast(event, data, only) {
      for (const client of clients) if (only === undefined || only(client)) client.send({ event, data });
    },
    onShutdown(hook) {
      options.registerShutdownHook(hook);
    },
    shutdown: (reason) => options.requestShutdown(reason),
    busy(key, isBusy) {
      if (isBusy) busyKeys.add(key);
      else busyKeys.delete(key);
      notifyIdle();
    },
  };

  return {
    context,
    addClient(client) {
      clients.add(client);
      notifyIdle();
    },
    removeClient(client) {
      clients.delete(client);
      notifyIdle();
    },
  };
}
