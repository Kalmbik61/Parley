/**
 * Preload окна острова (спека 2026-10-12, 5.2): узкий мост вместо общего `preload/index.ts`. Острову не нужны файлы,
 * диалоги, браузер и голос, а подписка `app.onFocusTarget` общего моста забрала бы у главного окна отложенную цель
 * клика по уведомлению (`app:take-focus-target`). Белый список методов хоста держит ещё и main (`host:call` по
 * отправителю) — на случай ошибки здесь.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { EventMessage, EventName, MethodName, SessionRef } from '@parley/protocol';
import type { HostStatus } from '../shared/bridge.js';
import type { IslandApi, IslandBridge, IslandConfig, IslandHitRect, IslandPoint } from '../shared/island.js';

const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
const statusListeners = new Set<(status: HostStatus) => void>();
const configListeners = new Set<(config: IslandConfig) => void>();
const hoverListeners = new Set<(hovered: boolean) => void>();
/** Последний статус: подписчик, пришедший позже события, получает его сразу (как в общем preload). */
let lastStatus: HostStatus | null = null;

ipcRenderer.on('host:event', (_event, message: EventMessage) => {
  for (const listener of eventListeners.get(message.event) ?? []) listener(message.data);
});
ipcRenderer.on('host:status', (_event, status: HostStatus) => {
  lastStatus = status;
  for (const listener of statusListeners) listener(status);
});
ipcRenderer.on('island:config', (_event, config: IslandConfig) => {
  for (const listener of configListeners) listener(config);
});
ipcRenderer.on('island:hover', (_event, hovered: boolean) => {
  for (const listener of hoverListeners) listener(hovered);
});

const bridge = {
  call: (method: MethodName, params: unknown) => ipcRenderer.invoke('host:call', method, params),
  on: (event: EventName, listener: (data: unknown) => void) => {
    let set = eventListeners.get(event);
    if (set === undefined) {
      set = new Set();
      eventListeners.set(event, set);
    }
    set.add(listener);
    return () => {
      eventListeners.get(event)?.delete(listener);
    };
  },
  onStatus: (listener: (status: HostStatus) => void) => {
    statusListeners.add(listener);
    if (lastStatus !== null) listener(lastStatus);
    return () => {
      statusListeners.delete(listener);
    };
  },
  activitySnapshot: () => ipcRenderer.invoke('host:activity-snapshot'),
  // `satisfies`: член, добавленный в `IslandApi`, но не реализованный здесь, не пройдёт сборку; внешнее приведение — ради `call`.
  island: {
    config: () => ipcRenderer.invoke('island:config') as Promise<IslandConfig>,
    onConfig: (listener: (config: IslandConfig) => void) => {
      configListeners.add(listener);
      return () => {
        configListeners.delete(listener);
      };
    },
    onHover: (listener: (hovered: boolean) => void) => {
      hoverListeners.add(listener);
      return () => {
        hoverListeners.delete(listener);
      };
    },
    setHitRect: (rect: IslandHitRect | null) => ipcRenderer.send('island:hit-rect', rect),
    setVisible: (visible: boolean) => ipcRenderer.send('island:visible', visible),
    dragStart: (point: IslandPoint) => ipcRenderer.send('island:drag-start', point),
    dragMove: (point: IslandPoint) => ipcRenderer.send('island:drag-move', point),
    dragEnd: (point: IslandPoint) => ipcRenderer.send('island:drag-end', point),
    open: (target: unknown) => ipcRenderer.send('island:open', target),
    beep: () => ipcRenderer.send('island:beep'),
    markSeen: (refs: SessionRef[]) => ipcRenderer.send('island:mark-seen', refs),
    failed: () => ipcRenderer.send('island:failed'),
  } satisfies IslandApi,
};

contextBridge.exposeInMainWorld('parley', bridge as unknown as IslandBridge);
