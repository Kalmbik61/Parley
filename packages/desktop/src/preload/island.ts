/**
 * Preload окна острова (спека 2026-10-12, 5.2): узкий мост вместо общего `preload/index.ts`. Острову не нужны файлы,
 * диалоги, браузер и голос, а подписка `app.onFocusTarget` общего моста забрала бы у главного окна отложенную цель
 * клика по уведомлению (`app:take-focus-target`). Белый список методов хоста держит ещё и main (`host:call` по
 * отправителю) — на случай ошибки здесь.
 *
 * Порт нейроголоса (план 3b, B15) `contextBridge` не пропускает: preload передаёт его в главный мир сообщением окна
 * (`window.postMessage(ISLAND_TTS_PORT, '*', ports)`).
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { EventMessage, EventName, MethodName, SessionRef } from '@parley/protocol';
import type { HostStatus } from '../shared/bridge.js';
import {
  ISLAND_TTS_PORT,
  type AssistantOpenRequest,
  type IslandApi,
  type IslandBridge,
  type IslandConfig,
  type IslandHitRect,
  type IslandPoint,
  type IslandSpeakRequest,
  type SessionVisibilitySnapshot,
  type TtsEngineState,
} from '../shared/island.js';
import type { MicStatus, TranscribeResult } from '../shared/voice-types.js';

const eventListeners = new Map<EventName, Set<(data: unknown) => void>>();
const statusListeners = new Set<(status: HostStatus) => void>();
const configListeners = new Set<(config: IslandConfig) => void>();
const hoverListeners = new Set<(hovered: boolean) => void>();
const assistantOpenListeners = new Set<(request: AssistantOpenRequest) => void>();
const navigatePendingListeners = new Set<() => void>();
const keyboardBlurListeners = new Set<() => void>();
const visibilityListeners = new Set<(snapshot: SessionVisibilitySnapshot) => void>();
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
ipcRenderer.on('island:assistant-open', (_event, request: unknown) => {
  for (const listener of assistantOpenListeners) listener(request as AssistantOpenRequest);
});
ipcRenderer.on('island:navigate-pending', () => {
  for (const listener of navigatePendingListeners) listener();
});
ipcRenderer.on('island:keyboard-blur', () => {
  for (const listener of keyboardBlurListeners) listener();
});
ipcRenderer.on('island:session-visibility', (_event, snapshot: SessionVisibilitySnapshot) => {
  for (const listener of visibilityListeners) listener(snapshot);
});
ipcRenderer.on('island:tts-port', (event) => {
  // Типов DOM у preload нет: окно — через `globalThis`.
  const page = (globalThis as unknown as { window: { postMessage(message: unknown, targetOrigin: string, transfer: unknown[]): void } }).window;
  page.postMessage(ISLAND_TTS_PORT, '*', event.ports);
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
    visibility: () => ipcRenderer.invoke('island:session-visibility') as Promise<SessionVisibilitySnapshot>,
    onVisibility: (listener: (snapshot: SessionVisibilitySnapshot) => void) => {
      visibilityListeners.add(listener);
      return () => { visibilityListeners.delete(listener); };
    },
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
    keyboard: (on: boolean) => ipcRenderer.send('island:keyboard', on),
    onAssistantOpen: (listener: (request: AssistantOpenRequest) => void) => {
      assistantOpenListeners.add(listener);
      return () => {
        assistantOpenListeners.delete(listener);
      };
    },
    onNavigatePending: (listener: () => void) => {
      navigatePendingListeners.add(listener);
      return () => { navigatePendingListeners.delete(listener); };
    },
    onKeyboardBlur: (listener: () => void) => {
      keyboardBlurListeners.add(listener);
      return () => {
        keyboardBlurListeners.delete(listener);
      };
    },
    voice: {
      transcribe: (request) => ipcRenderer.invoke('voice:transcribe', request) as Promise<TranscribeResult>,
      micStatus: () => ipcRenderer.invoke('voice:mic-status') as Promise<MicStatus>,
      requestMic: () => ipcRenderer.invoke('voice:request-mic') as Promise<boolean>,
    },
    speech: {
      connect: () => ipcRenderer.send('island:tts-connect'),
      speak: (request: IslandSpeakRequest) => ipcRenderer.invoke('island:tts-speak', request) as Promise<TtsEngineState>,
      cancel: (utteranceId?: string) => ipcRenderer.send('island:tts-cancel', utteranceId ?? null),
      warmup: () => ipcRenderer.invoke('island:tts-warmup') as Promise<TtsEngineState>,
      setSpeak: (on: boolean) => ipcRenderer.invoke('island:assistant-speak', on) as Promise<void>,
    },
    dragStart: (point: IslandPoint) => ipcRenderer.send('island:drag-start', point),
    dragMove: (point: IslandPoint) => ipcRenderer.send('island:drag-move', point),
    dragEnd: (point: IslandPoint) => ipcRenderer.send('island:drag-end', point),
    open: (target: unknown) => ipcRenderer.send('island:open', target),
    markSeen: (refs: SessionRef[]) => ipcRenderer.send('island:mark-seen', refs),
    failed: () => ipcRenderer.send('island:failed'),
  } satisfies IslandApi,
};

contextBridge.exposeInMainWorld('parley', bridge as unknown as IslandBridge);
