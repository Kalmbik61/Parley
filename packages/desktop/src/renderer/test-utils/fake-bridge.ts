/**
 * Подставной `HarnasBridge` для тестов рендерера (кусок 1.10 плана окна: «тесты
 * идут на подставном HarnasBridge»). Настоящего `window.harnas` в jsdom нет —
 * этот объект его заменяет: `call` отвечает по заранее заданным обработчикам,
 * `emit*` имитирует события и статус, пришедшие от хоста.
 */

import type { EventData, EventName, MethodName, NotificationName, Params, Result } from '@harnas/protocol';
import type { HarnasBridge, HostStatus, MenuAction } from '../../shared/bridge.js';

type Handler = (params: never) => unknown;

export interface FakeBridge extends HarnasBridge {
  /** Обработчик `call` для конкретного метода; без него `call` отклоняется. */
  setHandler<M extends MethodName>(method: M, handler: (params: Params<M>) => Result<M> | Promise<Result<M>>): void;
  /** Уведомления, отправленные наружу (`notify`), — для проверки, что дошло. */
  readonly notified: Array<{ method: NotificationName; params: unknown }>;
  /** Вызовы `call` — для проверки, что и с какими параметрами позвали. */
  readonly calls: Array<{ method: MethodName; params: unknown }>;
  emit<E extends EventName>(event: E, data: EventData<E>): void;
  emitStatus(status: HostStatus): void;
  emitMenu(action: MenuAction): void;
  readonly appNotified: Array<{ title: string; body: string }>;
  readonly badges: number[];
  /** Вызовы `app.saveLayout` — для теста тишины 500 мс (кусок 2.2). */
  readonly layoutSaves: Array<{ workKey: string; layout: unknown }>;
}

export function createFakeBridge(): FakeBridge {
  const handlers = new Map<MethodName, Handler>();
  const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
  const statusListeners = new Set<(status: HostStatus) => void>();
  const menuListeners = new Set<(action: MenuAction) => void>();
  const notified: Array<{ method: NotificationName; params: unknown }> = [];
  const calls: Array<{ method: MethodName; params: unknown }> = [];
  const appNotified: Array<{ title: string; body: string }> = [];
  const badges: number[] = [];
  const layoutSaves: Array<{ workKey: string; layout: unknown }> = [];
  const layouts = new Map<string, unknown>();
  let status: HostStatus = { state: 'connected', hostVersion: '0.0.0-test' };

  const bridge: FakeBridge = {
    setHandler: (method, handler) => {
      handlers.set(method, handler as Handler);
    },
    notified,
    calls,
    appNotified,
    badges,
    layoutSaves,

    call: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`fake-bridge: нет обработчика для ${method}`);
      return handler(params as never) as never;
    },
    notify: (method, params) => {
      notified.push({ method, params });
    },
    on: (event, listener) => {
      let set = eventListeners.get(event);
      if (set === undefined) {
        set = new Set();
        eventListeners.set(event, set);
      }
      set.add(listener as (data: unknown) => void);
      return () => eventListeners.get(event)?.delete(listener as (data: unknown) => void);
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
    app: {
      openExternal: async () => {},
      notify: (note) => {
        appNotified.push(note);
      },
      setBadge: (count) => {
        badges.push(count);
      },
      chooseFolder: async () => null,
      restartHost: async () => {},
      loadLayout: async (workKey) => layouts.get(workKey) ?? null,
      saveLayout: async (workKey, layout) => {
        layouts.set(workKey, layout);
        layoutSaves.push({ workKey, layout });
      },
      onMenu: (listener) => {
        menuListeners.add(listener);
        return () => menuListeners.delete(listener);
      },
    },

    emit: (event, data) => {
      for (const listener of eventListeners.get(event) ?? []) listener(data);
    },
    emitStatus: (next) => {
      status = next;
      for (const listener of statusListeners) listener(next);
    },
    emitMenu: (action) => {
      for (const listener of menuListeners) listener(action);
    },
  };

  return bridge;
}
