import { contextBridge, ipcRenderer } from 'electron';
import type { EventMessage, EventName, MethodName, NotificationName } from '@harnas/protocol';
import type { HarnasBridge, HostStatus, MenuAction } from '../shared/bridge.js';

const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
const statusListeners = new Set<(status: HostStatus) => void>();
const menuListeners = new Set<(action: MenuAction) => void>();

ipcRenderer.on('host:event', (_event, message: EventMessage) => {
  const listeners = eventListeners.get(message.event);
  if (!listeners) return;
  for (const listener of listeners) listener(message.data);
});

ipcRenderer.on('host:status', (_event, status: HostStatus) => {
  for (const listener of statusListeners) listener(status);
});

ipcRenderer.on('menu:action', (_event, action: MenuAction) => {
  for (const listener of menuListeners) listener(action);
});

/**
 * Единственный выход рендерера наружу. Всё идёт через `ipcRenderer.invoke`/`send`
 * на белый список каналов, который проверяет `ipc.ts` в основном процессе —
 * рендерер не может позвать ничего произвольного, даже зная имя канала.
 */
// Реализация ниже нарочно нетипизирована по дженерику `M`: мост через IPC
// стирает связь между методом и его параметрами/результатом на границе
// процессов, а вызывающая сторона (`HarnasBridge`) типизирована как раз для
// того, чтобы эту связь вернуть на стороне рендерера.
const bridge = {
  call: (method: MethodName, params: unknown) => ipcRenderer.invoke('host:call', method, params),
  notify: (method: NotificationName, params: unknown) => {
    ipcRenderer.send('host:notify', method, params);
  },
  on: (event: EventName, listener: (data: unknown) => void) => {
    let set = eventListeners.get(event);
    if (!set) {
      set = new Set();
      eventListeners.set(event, set);
    }
    set.add(listener);
    return () => eventListeners.get(event)?.delete(listener);
  },
  onStatus: (listener: (status: HostStatus) => void) => {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
  app: {
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
    notify: (note: { title: string; body: string }) => {
      ipcRenderer.send('app:notify', note);
    },
    setBadge: (count: number) => {
      ipcRenderer.send('app:set-badge', count);
    },
    chooseFolder: () => ipcRenderer.invoke('app:choose-folder') as Promise<string | null>,
    restartHost: () => ipcRenderer.invoke('app:restart-host') as Promise<void>,
    onMenu: (listener: (action: MenuAction) => void) => {
      menuListeners.add(listener);
      return () => menuListeners.delete(listener);
    },
  },
};

contextBridge.exposeInMainWorld('harnas', bridge as unknown as HarnasBridge);
