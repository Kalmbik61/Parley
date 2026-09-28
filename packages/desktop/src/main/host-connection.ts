import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import type { HostPaths } from '@harnas/host';
import {
  encodeLine,
  LineDecoder,
  PROTOCOL_VERSION,
  refKey,
  type EventData,
  type EventMessage,
  type MethodName,
  type NotificationName,
  type Result,
} from '@harnas/protocol';
import type { HostStatus } from '../shared/bridge.js';
import { S } from '../shared/strings.js';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Процесс хоста, запущенный окном: жив ли он ещё (раунд lane-r4). */
export interface SpawnedHost {
  isRunning(): boolean;
}

export interface HostConnectionOptions {
  paths: HostPaths;
  env: NodeJS.ProcessEnv;
  /**
   * Поднимает хост (реальный процесс в проде, фейковый сервер в тестах). Процесс — чтобы не
   * запускать второй, пока первый жив; null — процесса нет (не запустился или подставной сервер).
   */
  spawn: () => SpawnedHost | null | Promise<SpawnedHost | null>;
  connectTimeoutMs?: number;
  /** Сколько ждать сокета от живого запущенного процесса, прежде чем сказать человеку «не отвечает». */
  hostStartTimeoutMs?: number;
}

/** Ошибка протокола, дошедшая от хоста в ответе на запрос. */
export class HostError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown> | undefined;

  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.data = data;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Соединение окна с хостом по unix-сокету: находит хост, при необходимости
 * поднимает его, делает рукопожатие и дальше пробрасывает запросы, уведомления
 * и события. Переживает обрыв связи — переподключается сам с нарастающей
 * паузой, ровно как заявлено в спеке.
 */
export class HostConnection {
  private readonly paths: HostPaths;
  private readonly spawnHostProcess: HostConnectionOptions['spawn'];
  private readonly connectTimeoutMs: number;
  private readonly hostStartTimeoutMs: number;
  /**
   * Последний запущенный окном процесс хоста и время запуска (раунд lane-r4). Пока он жив или
   * ещё запускается, второй не запускается: новый хост при медленном старте первого его и сносил.
   */
  private spawnedHost: SpawnedHost | null = null;
  private spawning = false;
  private spawnedAt = 0;

  private socket: Socket | null = null;
  private decoder = new LineDecoder();
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventListeners = new Set<(message: EventMessage) => void>();
  private readonly statusListeners = new Set<(status: HostStatus) => void>();
  private status: HostStatus = { state: 'connecting' };
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 500;
  /** Уведомления, ушедшие без связи с хостом, — счётчик для журнала main (lane-r3, п. 2). */
  private droppedNotifications = 0;
  /** Причина, по которой `spawn()` заведомо не поднимет хост (например, нет `node` в PATH). */
  private spawnFailure: string | null = null;
  /**
   * Последнее `activity.changed` по каждой сессии текущего подключения. Хост
   * повторяет активность новому клиенту сразу после `hello`, а рендерер
   * подписывается на события позже (после статуса connected, после
   * перезагрузки окна) — без этого кеша повтор уходил бы в пустоту, и ждущая
   * разрешения сессия выглядела бы idle до следующего события.
   */
  private readonly activityCache = new Map<string, EventData<'activity.changed'>>();

  constructor(options: HostConnectionOptions) {
    this.paths = options.paths;
    this.spawnHostProcess = options.spawn;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.hostStartTimeoutMs = options.hostStartTimeoutMs ?? 30_000;
  }

  /** Запущенный окном хост ещё запускается или жив. */
  private hostStarting(): boolean {
    return this.spawning || (this.spawnedHost?.isRunning() ?? false);
  }

  private startHostProcess(): void {
    this.spawning = true;
    this.spawnedHost = null;
    this.spawnedAt = Date.now();
    void Promise.resolve()
      .then(() => this.spawnHostProcess())
      .then(
        (spawned) => {
          this.spawnedHost = spawned;
        },
        (error: unknown) => {
          console.error('[harnas] failed to start host', error);
        },
      )
      .finally(() => {
        this.spawning = false;
      });
  }

  onEvent(listener: (message: EventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Снимок кеша активности — окно берёт его, подписавшись на события (`host:activity-snapshot`). */
  activitySnapshot(): Array<EventData<'activity.changed'>> {
    return [...this.activityCache.values()];
  }

  onStatus(listener: (status: HostStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: HostStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  /** Первое подключение. Резолвится и при удачном рукопожатии, и при mismatch — в обоих случаях связь с хостом установлена. */
  async connect(): Promise<void> {
    this.closed = false;
    this.spawnFailure = null;
    this.setStatus({ state: 'connecting' });
    await this.connectOnce();
  }

  /**
   * Сообщает, что `spawn()` заведомо не поднимет хост — раньше таймаута
   * подключения, а не после него: иначе таймаут перетёр бы внятную причину
   * (например, «нет node в PATH») невыразительным `ECONNREFUSED` сокета.
   */
  reportUnavailable(reason: string): void {
    this.spawnFailure = reason;
    this.setStatus({ state: 'disconnected', reason });
  }

  private async connectOnce(): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    let spawned = false;
    for (;;) {
      try {
        // Токен — до сокета (раунд lane-r3, п. 2): хост закрывает соединение без `hello`
        // через 5 с после accept, и чтение файла под нагрузкой не должно тратить этот срок.
        // Нет файла — хост ещё не поднят: та же ветка повтора, что и отказ сокета.
        const token = (await readFile(this.paths.token, 'utf8')).trim();
        const socket = await this.tryConnectSocket();
        await this.handshake(socket, token);
        return;
      } catch (err) {
        if (this.closed) throw err instanceof Error ? err : new Error(String(err));
        if (this.spawnFailure !== null) {
          throw new Error(this.spawnFailure);
        }
        const now = Date.now();
        if (now >= deadline) {
          // Запущенный процесс жив — ждём его сокета до срока старта, а не запускаем второй.
          const starting = this.hostStarting();
          if (starting && now < this.spawnedAt + this.hostStartTimeoutMs) {
            await delay(150);
            continue;
          }
          const message = starting ? S.connection.reasonHostNotAnswering : err instanceof Error ? err.message : String(err);
          this.setStatus({ state: 'disconnected', reason: message });
          throw err instanceof Error ? err : new Error(message);
        }
        // Процесс прошлой попытки ещё жив (петля переподключения, уходящий после host.shutdown) —
        // второй не запускается; вышел — запуск на следующем круге.
        if (!spawned && !this.hostStarting()) {
          spawned = true;
          this.startHostProcess();
        }
        await delay(150);
      }
    }
  }

  private tryConnectSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.paths.socket);
      const onError = (err: Error): void => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(socket);
      });
    });
  }

  private async handshake(socket: Socket, token: string): Promise<void> {
    this.socket = socket;
    this.decoder = new LineDecoder();
    // Новое подключение — новый повтор от хоста: записи прошлого хоста могли
    // пропасть вместе с ним. Чистим до `hello`, а не после ответа: повтор идёт
    // в том же куске данных сразу за ответом и разобрался бы раньше продолжения.
    this.activityCache.clear();
    socket.on('data', (chunk: Buffer) => this.handleChunk(chunk));
    socket.on('close', () => this.handleClose());
    // Ошибки сокета проявляются как 'close' — отдельный обработчик тут не нужен,
    // но слушатель обязателен, иначе неотловленная ошибка валит процесс.
    socket.on('error', () => {});

    const id = this.nextId++;
    const pendingPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    socket.write(
      encodeLine({ id, method: 'hello', params: { token, protocol: PROTOCOL_VERSION, client: 'desktop' } }),
    );

    try {
      const result = (await pendingPromise) as Result<'hello'>;
      this.reconnectDelayMs = 500;
      this.setStatus({
        state: 'connected',
        hostVersion: result.hostVersion,
        methods: result.methods ?? null,
      });
    } catch (err) {
      if (err instanceof HostError && err.code === 'protocol_mismatch') {
        const data = err.data ?? {};
        this.setStatus({
          state: 'mismatch',
          hostVersion: typeof data.hostVersion === 'string' ? data.hostVersion : 'unknown',
          liveSessions: typeof data.liveSessions === 'number' ? data.liveSessions : null,
        });
        return;
      }
      throw err;
    }
  }

  private handleChunk(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch {
      // Строка длиннее лимита — от такого соединения толку нет.
      this.socket?.destroy();
      return;
    }
    for (const raw of messages) this.handleMessage(raw);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const obj = raw as Record<string, unknown>;

    if (typeof obj.event === 'string') {
      if (obj.event === 'activity.changed') {
        const data = obj.data as EventData<'activity.changed'>;
        this.activityCache.set(refKey(data.ref), data);
      }
      for (const listener of this.eventListeners) listener(obj as unknown as EventMessage);
      return;
    }

    if (typeof obj.id === 'number') {
      const pending = this.pending.get(obj.id);
      if (!pending) return;
      this.pending.delete(obj.id);
      if (obj.error !== undefined) {
        const error = obj.error as { code: string; message: string; data?: Record<string, unknown> };
        pending.reject(new HostError(error.code, error.message, error.data));
      } else {
        pending.resolve(obj.result);
      }
    }
  }

  private handleClose(): void {
    this.socket = null;
    const closedError = new Error(S.connection.reasonClosed);
    for (const pending of this.pending.values()) pending.reject(closedError);
    this.pending.clear();

    if (this.closed) return;
    // После mismatch хост сам закрывает сокет — повторно ломиться на ту же
    // версию бессмысленно, ждём явного restartHost от пользователя.
    if (this.status.state === 'mismatch') return;

    this.setStatus({ state: 'disconnected', reason: closedError.message });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connectOnce().catch(() => this.scheduleReconnect());
    }, delayMs);
  }

  async call(method: MethodName, params: unknown): Promise<unknown> {
    if (!this.socket) throw new Error('no connection to host');
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.write(encodeLine({ id, method, params }));
    return promise;
  }

  notify(method: NotificationName, params: unknown): void {
    if (this.socket === null) {
      // Не молча (раунд lane-r3, п. 2): уведомление без связи пропадает, и в консоли main
      // остаётся след для диагностики. Окно само не шлёт ввод, пока связи нет.
      this.droppedNotifications += 1;
      console.warn(`[harnas] host: ${method} dropped — no connection to host (dropped ${this.droppedNotifications})`);
      return;
    }
    this.socket.write(encodeLine({ method, params }));
  }

  /** `host.shutdown` → новый процесс хоста → новое подключение. */
  async restartHost(): Promise<void> {
    try {
      await this.call('host.shutdown', {});
    } catch {
      // Хост мог закрыть соединение раньше, чем пришёл ответ, — это ожидаемо.
    }
    this.reconnectDelayMs = 500;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.connectOnce();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }
}
