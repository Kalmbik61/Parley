/**
 * Клиент OpenAI GPT-Live на хосте. Единственное место, где живёт ключ API: он читается только через
 * `readSecret('voice:openai')` в момент вызова, уходит только в заголовок `Authorization` и не попадает ни в
 * результаты, ни в события, ни в сообщения ошибок (тексты ошибок и логов чистятся от ключа).
 *
 * Сверено с документацией OpenAI 2026-11-04 (guides/voice-webrtc?api=live, voice-server-controls?api=live, live-conversations):
 * - подтверждено: `POST https://api.openai.com/v1/live/sessions`, тело `{ session: { model, ... }, transport: { type: 'webrtc', sdp } }`,
 *   ответ 201 `{ session: { id }, transport: { type: 'webrtc', sdp } }`; id использовать как есть, с префиксом;
 *   sideband — `wss://api.openai.com/v1/live/sessions/{id}/attach` с `Authorization: Bearer`; команда закрытия
 *   `session.close`, ждать `session.closed` до отключения; usage приходит событием `session.usage.updated`
 *   `{ usage: { seconds } }` (накопленное значение), итог — в `session.closed` (верхний `usage.seconds`, подтверждено страницей live-conversations;
 *   запасной разбор `session.usage.seconds` оставлен на всякий случай; `reason`:
 *   close_requested | expired | content | remote_hangup | connection_lost);
 * - НЕ подтверждено: Content-Type запроса создания (шлём application/json) и «те же заголовки соединения, что при создании»
 *   для sideband (шлём только Authorization); максимальная длительность сессии (в доке нет, 30 минут — наше правило); тариф за секунду
 *   (поэтому `cost_final` не считается); endpoint принудительного закрытия без sideband (hangup упомянут, путь не показан).
 */
import { readSecret } from '@parley/core';

export const LIVE_BASE_URL = 'https://api.openai.com';
export const LIVE_MODEL = 'gpt-live-1';
export const CREATE_TIMEOUT_MS = 20_000;
/** Срок одной попытки подключения sideband. */
export const SIDEBAND_CONNECT_TIMEOUT_MS = 10_000;

/** Ошибка клиента: сообщение уже очищено от ключа. */
export class LiveError extends Error {
  constructor(
    readonly code: 'no_key' | 'http' | 'bad_response' | 'sideband',
    message: string,
    /** Сессия у OpenAI уже создана, но ответ непригоден: id нужен, чтобы её закрыть. */
    readonly sessionId?: string,
  ) {
    super(message);
  }
}

/** Минимум от WebSocket, который нужен клиенту (глобальный WebSocket Node, undici). */
export interface LiveSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type OpenSocket = (url: string, headers: Record<string, string>) => LiveSocket;

const defaultOpenSocket: OpenSocket = (url, headers) =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => LiveSocket)(url, { headers });

export interface LiveSessionCreated {
  sessionId: string;
  sdpAnswer: string;
}

export interface LiveClosed {
  seconds: number | null;
  reason: string;
}

export interface Sideband {
  /** Накопленные секунды из `session.usage.updated`. */
  onUsage(listener: (seconds: number) => void): void;
  /** Финал `session.closed`; приходит один раз. */
  onClosed(listener: (closed: LiveClosed) => void): void;
  /** Сокет оборвался без `session.closed`: сессия у OpenAI может жить, можно подключиться заново. Приходит один раз. */
  onDisconnected(listener: () => void): void;
  /** Отправляет `session.close`. */
  requestClose(): void;
  /** Закрывает сокет без ожидания. */
  dispose(): void;
}

export interface LiveClient {
  createSession(sdpOffer: string, session?: Record<string, unknown>): Promise<LiveSessionCreated>;
  attach(sessionId: string): Promise<Sideband>;
}

export interface LiveClientDeps {
  fetch?: typeof fetch;
  openSocket?: OpenSocket;
  readKey?: () => Promise<string | null>;
  baseUrl?: string;
  connectTimeoutMs?: number;
  createTimeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function createLiveClient(deps: LiveClientDeps = {}): LiveClient {
  const doFetch = deps.fetch ?? fetch;
  const openSocket = deps.openSocket ?? defaultOpenSocket;
  const readKey = deps.readKey ?? (() => readSecret('voice:openai'));
  const baseUrl = deps.baseUrl ?? LIVE_BASE_URL;
  const connectTimeoutMs = deps.connectTimeoutMs ?? SIDEBAND_CONNECT_TIMEOUT_MS;
  const createTimeoutMs = deps.createTimeoutMs ?? CREATE_TIMEOUT_MS;

  const requireKey = async (): Promise<string> => {
    const key = await readKey();
    if (key === null) throw new LiveError('no_key', 'OpenAI voice key is not set');
    return key;
  };
  /** Любой текст, что мог зацепить ключ (сообщение сети, URL), перед выходом из клиента чистится. */
  const scrub = (text: string, key: string): string => text.split(key).join('[key]');

  return {
    async createSession(sdpOffer, session = { model: LIVE_MODEL }) {
      const key = await requireKey();
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/live/sessions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ session, transport: { type: 'webrtc', sdp: sdpOffer } }),
          signal: AbortSignal.timeout(createTimeoutMs),
        });
      } catch (error) {
        throw new LiveError('http', scrub(`Live session request failed: ${error instanceof Error ? error.message : String(error)}`, key));
      }
      // Тело ответа об ошибке в сообщение не берём: оно не нужно окну и не должно утекать дальше хоста.
      if (response.status !== 201 && response.status !== 200) throw new LiveError('http', `Live session request failed: HTTP ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new LiveError('bad_response', 'Live session response is not JSON');
      }
      const id = isRecord(body) && isRecord(body['session']) ? body['session']['id'] : undefined;
      const sdp = isRecord(body) && isRecord(body['transport']) ? body['transport']['sdp'] : undefined;
      if (typeof id !== 'string' || id === '') throw new LiveError('bad_response', 'Live session response has no id or SDP answer');
      if (typeof sdp !== 'string' || sdp === '') throw new LiveError('bad_response', 'Live session response has no id or SDP answer', id);
      return { sessionId: id, sdpAnswer: sdp };
    },

    async attach(sessionId) {
      const key = await requireKey();
      const url = `${baseUrl.replace(/^http/, 'ws')}/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
      let socket: LiveSocket;
      try {
        socket = openSocket(url, { Authorization: `Bearer ${key}` });
      } catch (error) {
        throw new LiveError('sideband', scrub(`Live sideband failed to open: ${error instanceof Error ? error.message : String(error)}`, key));
      }
      const usageListeners: Array<(seconds: number) => void> = [];
      const closedListeners: Array<(closed: LiveClosed) => void> = [];
      const disconnectedListeners: Array<() => void> = [];
      let disconnectedSeen = false;
      let closedSeen = false;
      let dead = false;
      const emitClosed = (closed: LiveClosed): void => {
        if (closedSeen) return;
        closedSeen = true;
        try {
          for (const listener of closedListeners) listener(closed);
        } finally {
          // После `session.closed` транспорт больше не нужен: сокет не оставляем открытым.
          closeSocket();
        }
      };
      const closeSocket = (): void => {
        if (dead) return;
        dead = true;
        try {
          socket.close();
        } catch {
          // уже закрыт
        }
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        if (message['type'] === 'session.usage.updated') {
          const usage = message['usage'];
          const seconds = isRecord(usage) ? usage['seconds'] : undefined;
          if (typeof seconds === 'number' && Number.isFinite(seconds)) for (const listener of usageListeners) listener(seconds);
        } else if (message['type'] === 'session.closed') {
          const usage = isRecord(message['usage']) ? message['usage'] : isRecord(message['session']) && isRecord(message['session']['usage']) ? message['session']['usage'] : undefined;
          const seconds = usage !== undefined && typeof usage['seconds'] === 'number' && Number.isFinite(usage['seconds']) ? usage['seconds'] : null;
          emitClosed({ seconds, reason: typeof message['reason'] === 'string' ? message['reason'] : 'unknown' });
        }
      };
      // Обрыв сокета без `session.closed` — не конец сессии: она у OpenAI может жить (основной канал — WebRTC телефона).
      // Сообщаем отдельным сигналом, чтобы владелец переподключился; ложный `session.closed` не выдумываем.
      socket.onclose = () => {
        dead = true;
        if (closedSeen || disconnectedSeen) return;
        disconnectedSeen = true;
        for (const listener of disconnectedListeners) listener();
      };

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          dead = true;
          socket.close();
          reject(new LiveError('sideband', 'Live sideband did not open in time'));
        }, connectTimeoutMs);
        socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          if (!dead) {
            dead = true;
            socket.close();
          }
          reject(new LiveError('sideband', 'Live sideband connection failed'));
        };
      });
      socket.onerror = () => {};

      return {
        onUsage: (listener) => void usageListeners.push(listener),
        onClosed: (listener) => void closedListeners.push(listener),
        onDisconnected: (listener) => void disconnectedListeners.push(listener),
        requestClose: () => {
          if (dead || closedSeen) return;
          try {
            socket.send(JSON.stringify({ type: 'session.close' }));
          } catch {
            // сокет закрывается: финал придёт как connection_lost
          }
        },
        dispose: closeSocket,
      };
    },
  };
}
