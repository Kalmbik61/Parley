// Платформа клиента (спека §10): всё, что зависит от Hermes, браузера или Node, приходит снаружи.
import type { HostRecord } from './host-store.js';

/** Значение, которое можно прочитать сейчас и на смену которого можно подписаться. */
export interface Subscribable<T> {
  get(): T;
  /** Слушатель зовётся на каждую смену значения; возвращает отписку. */
  subscribe(listener: (value: T) => void): () => void;
}

export type AppState = 'active' | 'background';
export interface NetworkState {
  online: boolean;
  /** Вид сети (`wifi`, `cellular`…): его смена — триггер подключения и проверки (§10.2). */
  kind: string;
}

/** Сообщение WebSocket: текст или бинарные данные (`binaryType = 'arraybuffer'`). */
export interface SocketMessageEvent {
  data: unknown;
}

/** Общее подмножество RN WebSocket, браузерного WebSocket и `ws` на Node. */
export interface WebSocketLike {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Защищённое хранилище записей хостов (§7.8): на iOS — `expo-secure-store`, одна запись на хост. */
export interface KeyStore {
  list(): Promise<HostRecord[]>;
  put(record: HostRecord): Promise<void>;
  remove(hostId: string): Promise<void>;
}

export type TimerHandle = unknown;

export interface Platform {
  keyStore: KeyStore;
  openSocket(url: string): WebSocketLike;
  /** Криптостойкие случайные байты. */
  random(n: number): Uint8Array;
  appState: Subscribable<AppState>;
  network: Subscribable<NetworkState>;
  /** Миллисекунды эпохи. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /**
   * Сборка разработчика: разрешает `ws://` к relay с частным адресом (§6.6). В релизной сборке `false`, и QR с
   * частным адресом отвергается.
   */
  allowLocalRelay: boolean;
}
