import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { HostPaths } from '@parley/host';
import {
  BROWSER_AGENT_FEATURE,
  COMPACT_WORKS_FEATURE,
  encodeLine,
  LineDecoder,
  LineTooLongError,
  PROTOCOL_VERSION,
  refKey,
  type BrowserAgentOpEvent,
  type BrowserAgentResult,
  type EventData,
  type EventMessage,
  type MethodName,
  type NotificationName,
  type Result,
} from '@parley/protocol';
import type { HostStatus } from '../shared/bridge.js';
import { S } from '../shared/strings.js';
import { createRpcRing, type RpcRecord } from './diagnostics/rpc-ring.js';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  /** Момент записи вызова в сокет, ISO. */
  startedAt: string;
  /** `performance.now()` в тот же момент: по нему считается возраст висящего вызова. */
  startedMs: number;
  /** `sessionId` из `params.ref`, если он есть. */
  ref?: string;
}

/** Процесс хоста, запущенный окном: жив ли он ещё (раунд lane-r4). */
export interface SpawnedHost {
  isRunning(): boolean;
}

/** Системные процессы для остановки хоста по pid; в тестах подменяются, чтобы сигналы не уходили настоящим процессам. */
export interface HostProcesses {
  kill(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  /** Это процесс хоста Parley, а не чужой, занявший pid после него. */
  isHost(pid: number): boolean;
}

const realProcesses: HostProcesses = {
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // Процесс уже вышел или чужой — сигналить некому.
    }
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM — процесс есть, просто не наш.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  isHost(pid) {
    try {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      return /[\\/]host[\\/]dist[\\/]main\.js/.test(command);
    } catch {
      return false;
    }
  },
};

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
  /** Сигналы и проверки процессов для `stopHost`; по умолчанию настоящие. */
  processes?: HostProcesses;
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

/** `params.ref.sessionId`, если параметры — объект с таким полем. */
function sessionIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const ref = (params as { ref?: unknown }).ref;
  if (typeof ref !== 'object' || ref === null) return undefined;
  const sessionId = (ref as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
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
  private readonly processes: HostProcesses;
  /** pid хоста из ответа `hello` текущего подключения — чтобы добить зависший хост. */
  private hostPid: number | null = null;
  /**
   * Последний запущенный окном процесс хоста и время запуска (раунд lane-r4). Пока он жив или
   * ещё запускается, второй не запускается: новый хост при медленном старте первого его и сносил.
   */
  private spawnedHost: SpawnedHost | null = null;
  private spawning = false;
  private spawnedAt = 0;

  /** Текущий сокет — только после ответа на `hello` (раунд lane-r4, п. 3). */
  private socket: Socket | null = null;
  /** Сокет посреди рукопожатия: его сообщения принимаются, его `close` текущий не трогает. */
  private candidate: Socket | null = null;
  /** Единственная петля подключения: `connect`, переподключение и `restartHost` делят её. */
  private loop: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  /** Последние вызовы окна к хосту — для архива диагностики (`recentCalls`). */
  private readonly rpcRing = createRpcRing();
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
  /**
   * Сокет, на котором хост прислал строку длиннее предела кадра (хост до P35 с огромным снимком работ). Декодер на такой
   * строке не восстановить, а переподключение получило бы ту же строку по кругу: сокет остаётся (чтобы «Restart host»
   * мог послать `host.shutdown`), его данные не читаются, а человеку сказано, что делать. Его закрытие хостом — обычный
   * обрыв: дальше работает переподключение к уже перезапущенному хосту.
   */
  private oversized: Socket | null = null;

  constructor(options: HostConnectionOptions) {
    this.paths = options.paths;
    this.spawnHostProcess = options.spawn;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.hostStartTimeoutMs = options.hostStartTimeoutMs ?? 30_000;
    this.processes = options.processes ?? realProcesses;
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
          console.error('[parley] failed to start host', error);
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

  /**
   * Первое подключение и «Retry» экрана «No connection to host». Резолвится и при удачном
   * рукопожатии, и при mismatch — в обоих случаях связь с хостом установлена. Отказ заводит
   * петлю переподключения (fix-final-b, M4): без неё окно так и стояло бы на экране отказа.
   */
  async connect(): Promise<void> {
    this.oversized?.destroy();
    this.oversized = null;
    this.closed = false;
    this.spawnFailure = null;
    // Повтор человека — с начала: короткая пауза, а не накопленная автоповторами.
    this.clearReconnectTimer();
    this.reconnectDelayMs = 500;
    this.setStatus({ state: 'connecting' });
    await this.connectOrRetry();
  }

  /** Петля подключения; её отказ — повтор по таймеру с нарастающей паузой. */
  private async connectOrRetry(): Promise<void> {
    try {
      await this.connectLoop();
    } catch (err) {
      this.scheduleReconnect();
      throw err;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * Петля подключения одна (раунд lane-r4, п. 3): вызов во время идущей возвращает её же. Иначе
   * обрыв посреди рукопожатия заводил переподключение рядом с повтором самой петли — два
   * соединения разом, и `close` осиротевшего обнулял живой.
   */
  private connectLoop(): Promise<void> {
    if (this.loop !== null) return this.loop;
    const loop = this.connectOnce().finally(() => {
      if (this.loop === loop) this.loop = null;
    });
    this.loop = loop;
    return loop;
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
    this.candidate = socket;
    // Разбор строк — свой у каждого сокета: хвост прежнего не смешается с новым.
    const decoder = new LineDecoder();
    // Новое подключение — новый повтор от хоста: записи прошлого хоста могли
    // пропасть вместе с ним. Чистим до `hello`, а не после ответа: повтор идёт
    // в том же куске данных сразу за ответом и разобрался бы раньше продолжения.
    this.activityCache.clear();
    socket.on('data', (chunk: Buffer) => this.handleChunk(socket, decoder, chunk));
    // Ошибки сокета проявляются как 'close' — отдельный обработчик тут не нужен,
    // но слушатель обязателен, иначе неотловленная ошибка валит процесс.
    socket.on('error', () => {});

    const id = this.nextId++;
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    const pendingPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method: 'hello', startedAt, startedMs });
    });
    // Обрыв посреди рукопожатия — отказ только этого `hello`: повторяет сама петля, статус и
    // текущий сокет не трогаются.
    socket.on('close', () => this.handleClose(socket, id));
    socket.write(
      encodeLine({
        id,
        method: 'hello',
        // Окно читает компактный снимок работ (P35): письма хвостом, старше — страницами `context.messages`, и исполняет
        // операции агента над своим браузером (спека браузера 3.7).
        params: { token, protocol: PROTOCOL_VERSION, client: 'desktop', features: [COMPACT_WORKS_FEATURE, BROWSER_AGENT_FEATURE] },
      }),
    );

    try {
      const result = (await pendingPromise) as Result<'hello'>;
      this.adopt(socket);
      this.hostPid = result.pid;
      this.reconnectDelayMs = 500;
      this.setStatus({
        state: 'connected',
        hostVersion: result.hostVersion,
        methods: result.methods ?? null,
        features: result.features ?? null,
      });
    } catch (err) {
      if (err instanceof HostError && err.code === 'protocol_mismatch') {
        // Текущим — и после mismatch: «Restart» шлёт по нему host.shutdown.
        this.adopt(socket);
        const data = err.data ?? {};
        this.setStatus({
          state: 'mismatch',
          hostVersion: typeof data.hostVersion === 'string' ? data.hostVersion : 'unknown',
          liveSessions: typeof data.liveSessions === 'number' ? data.liveSessions : null,
        });
        return;
      }
      if (this.candidate === socket) this.candidate = null;
      socket.destroy();
      throw err;
    }
  }

  private adopt(socket: Socket): void {
    if (this.candidate === socket) this.candidate = null;
    this.socket = socket;
  }

  private handleChunk(socket: Socket, decoder: LineDecoder, chunk: Buffer): void {
    // Сокет, уже не текущий и не рукопожатный, — осиротевший: его сообщения не наши.
    if (socket !== this.socket && socket !== this.candidate) return;
    if (socket === this.oversized) return;
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      if (error instanceof LineTooLongError && socket === this.socket) {
        this.handleOversize(socket);
        return;
      }
      // Строка длиннее лимита (или не JSON) — от такого соединения толку нет.
      socket.destroy();
      return;
    }
    for (const raw of messages) this.handleMessage(raw);
  }

  /**
   * Хост прислал строку длиннее предела кадра. Переподключаться бессмысленно — хост ответит тем же, — поэтому ждущие
   * запросы отказывают с понятной причиной, статус называет, что делать, а автоповтор не заводится (`oversized`).
   */
  private handleOversize(socket: Socket): void {
    this.oversized = socket;
    const error = new Error(S.connection.reasonOversize);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.setStatus({ state: 'disconnected', reason: S.connection.reasonOversize });
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

  private handleClose(socket: Socket, helloId: number): void {
    if (socket === this.candidate) {
      this.candidate = null;
      const pending = this.pending.get(helloId);
      this.pending.delete(helloId);
      pending?.reject(new Error(S.connection.reasonClosed));
      return;
    }
    // Чужой (не текущий) сокет текущий не трогает.
    if (socket !== this.socket) return;
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

  /**
   * Повтор подключения: пауза 0,5 с, дальше вдвое до предела 5 с. Второй хост поверх живого
   * петля не запускает (`connectOnce`, lane-r4): запуск — только когда прошлого процесса нет.
   */
  private scheduleReconnect(): void {
    if (this.closed) return;
    // Петля уже идёт (restartHost, первое подключение) — она и подключит; вторую не заводим.
    if (this.reconnectTimer || this.loop !== null) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connectLoop().catch(() => this.scheduleReconnect());
    }, delayMs);
  }

  async call(method: MethodName, params: unknown): Promise<unknown> {
    const ref = sessionIdOf(params);
    const startedAt = new Date().toISOString();
    if (!this.socket) {
      // Отказ без сокета тоже виден в архиве диагностики: иначе «окно молчит» не отличить от «окно не звало».
      this.rpcRing.push({ t: startedAt, method, ms: 0, ok: false, error: 'no-connection', ...(ref === undefined ? {} : { ref }) });
      throw new Error('no connection to host');
    }
    const id = this.nextId++;
    const startedMs = performance.now();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, startedAt, startedMs, ...(ref === undefined ? {} : { ref }) });
    });
    this.socket.write(encodeLine({ id, method, params }));
    const record = (ok: boolean, error?: string): void => {
      this.rpcRing.push({
        t: startedAt,
        method,
        ms: performance.now() - startedMs,
        ok,
        ...(error === undefined ? {} : { error }),
        ...(ref === undefined ? {} : { ref }),
      });
    };
    try {
      const result = await promise;
      record(true);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record(false, error instanceof HostError ? error.code : message.slice(0, 120));
      throw error;
    }
  }

  /**
   * Последние вызовы окна к хосту (до `RPC_RING_CAPACITY`), от старых к новым, и в конце по записи на каждый
   * вызов, который ещё ждёт ответа (`error: 'pending'`, `ms` — возраст): зависший хост иначе в кольце не виден.
   */
  recentCalls(): RpcRecord[] {
    const now = performance.now();
    const hanging = [...this.pending.values()].map(
      (call): RpcRecord => ({
        t: call.startedAt,
        method: call.method,
        ms: Math.round(now - call.startedMs),
        ok: false,
        error: 'pending',
        ...(call.ref === undefined ? {} : { ref: call.ref }),
      }),
    );
    return [...this.rpcRing.entries(), ...hanging];
  }

  notify(method: NotificationName, params: unknown): void {
    if (this.socket === null) {
      // Не молча (раунд lane-r3, п. 2): уведомление без связи пропадает, и в консоли main
      // остаётся след для диагностики. Окно само не шлёт ввод, пока связи нет.
      this.droppedNotifications += 1;
      console.warn(`[parley] host: ${method} dropped — no connection to host (dropped ${this.droppedNotifications})`);
      return;
    }
    this.socket.write(encodeLine({ method, params }));
  }

  /** `host.shutdown` → новый процесс хоста → новое подключение. */
  async restartHost(): Promise<void> {
    // Запуск хоста — заново: прошлая причина отказа (нет node) могла уйти (fix-final-b, M4).
    this.spawnFailure = null;
    // Подключаться — после того как уходящий хост закрыл наш сокет (он закрывает клиентов в конце
    // остановки, до этого ещё слушает): иначе петля успела бы подключиться к нему же (lane-r4, п. 3).
    const old = this.socket;
    const oldClosed =
      old === null || old.destroyed ? Promise.resolve() : new Promise<void>((resolve) => old.once('close', () => resolve()));
    try {
      await this.call('host.shutdown', {});
    } catch {
      // Хост мог закрыть соединение раньше, чем пришёл ответ, — это ожидаемо.
    }
    // Хост завис на остановке — не ждём вечно: срок подключения, затем рвём сами.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([oldClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.connectTimeoutMs)))]);
    clearTimeout(timer);
    if (old !== null && this.socket === old) old.destroy();
    this.reconnectDelayMs = 500;
    this.clearReconnectTimer();
    // Отказ — переподключение по таймеру (fix-final-b, M4): терминалы пишут «reconnecting…».
    await this.connectOrRetry();
  }

  /** pid живого процесса хоста по `host.pid` (первая строка), если он ещё жив и это хост Parley. */
  private async livePidFromFile(): Promise<number | null> {
    let text: string;
    try {
      text = await readFile(this.paths.pid, 'utf8');
    } catch {
      return null;
    }
    const pid = Number.parseInt(text.split('\n')[0]?.trim() ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return this.processes.isAlive(pid) && this.processes.isHost(pid) ? pid : null;
  }

  /** Ждёт выхода процесса, опрашивая его; true — вышел в срок. */
  private async waitExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processes.isAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await delay(25);
    }
    return true;
  }

  /**
   * Число живых сессий хоста для вопроса о выходе. Есть связь — `host.info` (ошибка или срок — null); связи нет —
   * по `host.pid`: живой хост даёт null (сколько сессий, неизвестно), хоста нет — 0.
   */
  async liveSessions(timeoutMs = 2000): Promise<number | null> {
    if (this.socket === null) return (await this.livePidFromFile()) === null ? 0 : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = (await Promise.race([
        this.call('host.info', {}),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('host.info timeout')), timeoutMs))),
      ])) as Result<'host.info'>;
      return info.liveSessions;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Останавливает хост насовсем при выходе из приложения: переподключение и запуск выключаются, затем
   * `host.shutdown`; хост не вышел за срок — добивается по pid (SIGTERM, потом SIGKILL). Итог: `shutdown` — вышел
   * сам, `killed` — добит сигналом, `none` — хоста не нашлось.
   */
  async stopHost(options: { timeoutMs?: number; killGraceMs?: number } = {}): Promise<'shutdown' | 'killed' | 'none'> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const killGraceMs = options.killGraceMs ?? 3000;
    // Насовсем: ни петля, ни `spawn` после этого не оживают.
    this.closed = true;
    this.clearReconnectTimer();

    let pid: number | null;
    const socket = this.socket;
    if (socket !== null) {
      pid = this.hostPid;
      const closed =
        socket.destroyed ? Promise.resolve() : new Promise<void>((resolve) => socket.once('close', () => resolve()));
      // Ответа не ждём: молчащий хост (цикл событий стоит) не должен держать выход дольше срока. Отказ вызова
      // (сокет закрыт хостом или нами ниже) ожидаем и глотаем.
      void this.call('host.shutdown', {}).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
      clearTimeout(timer);
      socket.destroy();
      this.socket = null;
      if (pid === null || (await this.waitExit(pid, killGraceMs))) return 'shutdown';
    } else {
      pid = await this.livePidFromFile();
      if (pid === null) return 'none';
    }

    this.processes.kill(pid, 'SIGTERM');
    if (!(await this.waitExit(pid, killGraceMs))) this.processes.kill(pid, 'SIGKILL');
    return 'killed';
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.candidate?.destroy();
    this.candidate = null;
  }
}

/**
 * Операции агента над браузером окна (спека браузера 2026-10-07, 3.7; этап B2): событие хоста `browser.agentOp` исполняет
 * `run` в main, ответ уходит методом `browser.agentResult` с тем же `opId`. Сбой `run` — `unsupported` с текстом ошибки.
 * Ответ не дошёл (связь оборвалась) — хост сам ответит агенту `window_not_connected` или `timeout`.
 */
export function answerBrowserAgentOps(
  connection: Pick<HostConnection, 'onEvent' | 'call'>,
  run: (event: BrowserAgentOpEvent) => Promise<BrowserAgentResult>,
): () => void {
  return connection.onEvent((message) => {
    if (message.event !== 'browser.agentOp') return;
    const event = message.data as BrowserAgentOpEvent;
    void run(event)
      .catch(
        (error: unknown): BrowserAgentResult => ({
          ok: false,
          error: { code: 'unsupported', message: error instanceof Error ? error.message : String(error) },
        }),
      )
      .then((result) => connection.call('browser.agentResult', { opId: event.opId, ...result }))
      .catch((error: unknown) => console.warn('[parley] browser.agentResult failed', error));
  });
}
