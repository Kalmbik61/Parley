import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { HostPaths } from '@parley/host';
import {
  ASSISTANT_ACTIONS_FEATURE,
  BROWSER_AGENT_FEATURE,
  BROWSER_AGENT_OP_FEATURE,
  BROWSER_AGENT_OPS,
  COMPACT_WORKS_FEATURE,
  encodeLine,
  LineDecoder,
  LineTooLongError,
  PROTOCOL_VERSION,
  refKey,
  ROOMS_MAIL_FEATURE,
  type BrowserAgentOpEvent,
  type BrowserAgentResult,
  type EventData,
  type EventMessage,
  type HostNotice,
  type MethodName,
  type NotificationName,
  type Result,
} from '@parley/protocol';
import type { HostStatus } from '../shared/bridge.js';
import { S } from '../shared/strings.js';
import { createRpcRing, type RpcRecord } from './diagnostics/rpc-ring.js';

/** Сколько уведомлений хоста main держит для окна: столько же, сколько хранит их стор окна. */
const NOTICE_CACHE_LIMIT = 20;

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
  /**
   * Тождество процесса: pid и время его старта. Повторно занявший pid процесс (даже другой Parley-хост)
   * даст другую строку. null — установить нельзя (процесса нет или `ps` не ответил).
   */
  identity(pid: number): string | null;
}

export const realProcesses: HostProcesses = {
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
  identity(pid) {
    try {
      const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
      return started === '' ? null : `${pid}:${started}`;
    } catch {
      return null;
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
  /** Тождество процесса `hostPid`, снятое при установке подключения: pid мог уйти и достаться другому хосту. */
  private hostIdentity: string | null = null;
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
  /** Закрытие и restart отменяют продолжения старой петли, включая незавершённый hello. */
  private connectionEpoch = 0;
  private restartOperation: Promise<void> | null = null;
  /** При неподтверждённой остановке автоповтор запрещён до следующего явного restart. */
  private teardownPending = false;
  /** После отказа сохраняем проверенный старый pid: следующий restart не должен забыть живой хост. */
  private teardownPid: number | null = null;
  /** Тождество `teardownPid`, снятое до первого shutdown. */
  private teardownIdentity: string | null = null;
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
   * `host.notice` текущего подключения, не больше `NOTICE_CACHE_LIMIT` последних. Стартовые уведомления хост (карты, не
   * переехавшие в базу) повторяет новому клиенту сразу после `hello`, как активность, — а рендерер подписывается позже,
   * в статусе connected: без этого кеша повтор уходил бы в пустоту и человек не узнал бы о работе, оставшейся в файле.
   */
  private readonly noticeCache: HostNotice[] = [];
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

  private startHostProcess(epoch: number): void {
    this.spawning = true;
    this.spawnedHost = null;
    this.spawnedAt = Date.now();
    void Promise.resolve()
      .then(() => {
        this.checkEpoch(epoch);
        return this.spawnHostProcess();
      })
      .then(
        (spawned) => {
          this.spawnedHost = spawned;
        },
        (error: unknown) => {
          if (epoch === this.connectionEpoch) console.error('[parley] failed to start host', error);
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

  /** Снимок кеша уведомлений хоста — окно берёт его, подписавшись на события (`host:notices-snapshot`). */
  noticesSnapshot(): HostNotice[] {
    return [...this.noticeCache];
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
    if (this.restartOperation !== null) return this.restartOperation;
    if (this.teardownPending) throw new Error('host teardown is unresolved; retry Restart Host');
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
    const epoch = this.connectionEpoch;
    try {
      await this.connectLoop();
    } catch (err) {
      if (epoch === this.connectionEpoch) this.scheduleReconnect();
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
    const loop = this.connectOnce(this.connectionEpoch).finally(() => {
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

  private checkEpoch(epoch: number): void {
    if (this.closed || epoch !== this.connectionEpoch) throw new Error(S.connection.reasonClosed);
  }

  private async connectOnce(epoch: number): Promise<void> {
    const deadline = Date.now() + this.connectTimeoutMs;
    let spawned = false;
    for (;;) {
      try {
        this.checkEpoch(epoch);
        // Токен — до сокета (раунд lane-r3, п. 2): хост закрывает соединение без `hello`
        // через 5 с после accept, и чтение файла под нагрузкой не должно тратить этот срок.
        // Нет файла — хост ещё не поднят: та же ветка повтора, что и отказ сокета.
        const token = (await readFile(this.paths.token, 'utf8')).trim();
        this.checkEpoch(epoch);
        const socket = await this.tryConnectSocket();
        if (this.closed || epoch !== this.connectionEpoch) {
          socket.destroy();
          this.checkEpoch(epoch);
        }
        await this.handshake(socket, token, epoch);
        return;
      } catch (err) {
        if (this.closed || epoch !== this.connectionEpoch) throw err instanceof Error ? err : new Error(String(err));
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
          this.startHostProcess(epoch);
        }
        await delay(150);
      }
    }
  }

  private tryConnectSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.paths.socket);
      const timer = setTimeout(() => onError(new Error('host socket connect timeout')), this.connectTimeoutMs);
      const onError = (err: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve(socket);
      });
    });
  }

  private async handshake(socket: Socket, token: string, epoch: number): Promise<void> {
    this.candidate = socket;
    // Разбор строк — свой у каждого сокета: хвост прежнего не смешается с новым.
    const decoder = new LineDecoder();
    // Новое подключение — новый повтор от хоста: записи прошлого хоста могли
    // пропасть вместе с ним. Чистим до `hello`, а не после ответа: повтор идёт
    // в том же куске данных сразу за ответом и разобрался бы раньше продолжения.
    this.activityCache.clear();
    this.noticeCache.length = 0;
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
        // Окно читает компактный снимок работ (P35): письма хвостом, старше — страницами `context.messages`; письма и
        // отметки прочтения берёт событием `rooms.mail` (спека rooms.mail 6.10); исполняет операции агента над своим
        // браузером (спека браузера 3.7); рисует карточку шагов помощника и её отчёт (руки помощника).
        params: {
          token,
          protocol: PROTOCOL_VERSION,
          client: 'desktop',
          features: [COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE, BROWSER_AGENT_FEATURE, ...BROWSER_AGENT_OPS.map(BROWSER_AGENT_OP_FEATURE), ASSISTANT_ACTIONS_FEATURE],
        },
      }),
    );

    // Зависшее hello тоже ограничено сроком подключения; общий timeout для RPC не вводим.
    const timer = setTimeout(() => this.pending.get(id)?.reject(new Error('host hello timeout')), this.connectTimeoutMs);
    try {
      const result = (await pendingPromise) as Result<'hello'>;
      this.checkEpoch(epoch);
      this.adopt(socket);
      this.hostPid = result.pid;
      // Сразу при подключении: restart сверяет сигналы с этим тождеством, а не с тем, что окажется под pid позже.
      this.hostIdentity = this.processes.identity(result.pid);
      this.reconnectDelayMs = 500;
      this.setStatus({
        state: 'connected',
        hostVersion: result.hostVersion,
        methods: result.methods ?? null,
        features: result.features ?? null,
      });
    } catch (err) {
      // Restart забирает старый сокет для shutdown: отменённое hello его не закрывает.
      if (epoch !== this.connectionEpoch) throw err;
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
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private adopt(socket: Socket): void {
    if (this.candidate === socket) this.candidate = null;
    this.socket = socket;
    this.hostPid = null;
    this.hostIdentity = null;
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
      if (obj.event === 'host.notice') {
        this.noticeCache.push(obj.data as HostNotice);
        if (this.noticeCache.length > NOTICE_CACHE_LIMIT) this.noticeCache.shift();
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
    if (this.closed || this.teardownPending) return;
    // Петля уже идёт (restartHost, первое подключение) — она и подключит; вторую не заводим.
    if (this.reconnectTimer || this.loop !== null) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.teardownPending) return;
      void this.connectOrRetry().catch(() => {});
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

  /** `host.shutdown` → подтверждённый выход старого хоста → новое подключение. */
  restartHost(options: { timeoutMs?: number; killGraceMs?: number; killWaitMs?: number } = {}): Promise<void> {
    if (this.restartOperation !== null) return this.restartOperation;
    if (this.closed) return Promise.reject(new Error(S.connection.reasonClosed));
    const unresolved = this.teardownPending;
    this.teardownPending = true;
    this.clearReconnectTimer();
    const operation = this.restartOnce(options, unresolved).finally(() => {
      if (this.restartOperation === operation) this.restartOperation = null;
    });
    this.restartOperation = operation;
    return operation;
  }

  /** Ждёт только до срока; close/stop немедленно отменяют дальнейшие сигналы и запуск. */
  private async waitRestart(predicate: () => boolean, timeoutMs: number, epoch: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.checkEpoch(epoch);
      if (predicate()) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(25, remaining));
    }
  }

  private rejectPending(): void {
    const error = new Error(S.connection.reasonClosed);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async restartOnce(
    options: { timeoutMs?: number; killGraceMs?: number; killWaitMs?: number },
    unresolved: boolean,
  ): Promise<void> {
    const epoch = ++this.connectionEpoch;
    const old = this.socket ?? this.candidate;
    const helloPid = this.teardownPid ?? (this.socket === old ? this.hostPid : null);
    const helloIdentity = this.teardownPid !== null ? this.teardownIdentity : this.socket === old ? this.hostIdentity : null;
    const previousLoop = this.loop;
    let oldClosed = old === null || old.closed;
    const onClose = (): void => { oldClosed = true; };
    old?.once('close', onClose);
    this.spawnFailure = null;
    // Отменяем hello и остальные RPC до shutdown: их ответы уже не нужны. Сокет остаётся для остановки.
    this.rejectPending();
    this.candidate = null;
    try {
      // pid и его тождество определяются до host.shutdown: после него pid мог уйти и достаться другому хосту.
      let pid: number | null = null;
      let expected: string | null = null;
      if (helloPid !== null && Number.isInteger(helloPid) && helloPid > 0 &&
          (!this.processes.isAlive(helloPid) || this.processes.isHost(helloPid))) {
        pid = helloPid;
        expected = helloIdentity;
      } else {
        pid = await this.livePidFromFile();
        if (pid !== null) expected = this.processes.identity(pid);
      }
      this.checkEpoch(epoch);
      if (old !== null && !old.destroyed) {
        // Ответ не участвует в остановке; pending текущего сокета очищается в finally даже у молчащего хоста.
        if (old === this.socket) void this.call('host.shutdown', {}).catch(() => {});
        else old.write(encodeLine({ id: this.nextId++, method: 'host.shutdown', params: {} }));
      }
      if (previousLoop !== null && !(await this.waitRestart(() => this.loop !== previousLoop, this.connectTimeoutMs, epoch))) {
        throw new Error('host teardown could not cancel the previous connection');
      }
      // Уже вызванный async spawn отменить нельзя: ждём его результат до срока и не запускаем второй.
      if (!(await this.waitRestart(() => !this.spawning, this.connectTimeoutMs, epoch))) {
        throw new Error('host teardown could not confirm a pending spawn');
      }
      this.checkEpoch(epoch);
      this.teardownPid = pid;
      this.teardownIdentity = expected;
      if (pid === null) {
        if ((old === null && (unresolved || previousLoop !== null || this.hostStarting())) ||
            !(await this.waitRestart(() => oldClosed, options.timeoutMs ?? 10_000, epoch))) {
          throw new Error('host teardown could not be confirmed without a host PID');
        }
      } else {
        const oldPid = pid;
        // Тождество снято до shutdown: сигнал получит только тот процесс, которому он был отправлен.
        const exited = (): boolean => !this.processes.isAlive(oldPid);
        // Прежнее поколение ушло: pid свободен, занят чужим процессом или другим поколением хоста.
        const gone = (): boolean => {
          if (exited() || !this.processes.isHost(oldPid)) return true;
          // Живой pid с неустановленным тождеством (`ps` не ответил) — неизвестно, а не «ушёл».
          const now = this.processes.identity(oldPid);
          return expected !== null && now !== null && now !== expected;
        };
        if (!(await this.waitRestart(exited, options.timeoutMs ?? 10_000, epoch))) {
          for (const [signal, grace] of [
            ['SIGTERM', options.killGraceMs ?? 3000],
            ['SIGKILL', options.killWaitMs ?? 3000],
          ] as const) {
            this.checkEpoch(epoch);
            // Перед каждым сигналом тождество сверяется снова; не сошлось или не установлено — сигнала нет.
            if (gone() || !this.signalIfSame(oldPid, expected, signal)) break;
            if (await this.waitRestart(exited, grace, epoch)) break;
          }
          if (!gone()) {
            throw new Error(expected === null
              ? 'host teardown could not be confirmed without the host process identity'
              : 'old host did not exit after SIGKILL');
          }
        }
      }
    } catch (error) {
      if (!this.closed && epoch === this.connectionEpoch) {
        this.setStatus({ state: 'disconnected', reason: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    } finally {
      old?.off('close', onClose);
      old?.destroy();
      if (this.socket === old) {
        this.socket = null;
        this.hostPid = null;
        this.hostIdentity = null;
      }
      if (this.oversized === old) this.oversized = null;
      this.rejectPending();
    }
    this.checkEpoch(epoch);
    this.teardownPid = null;
    this.teardownIdentity = null;
    this.teardownPending = false;
    this.reconnectDelayMs = 500;
    this.setStatus({ state: 'connecting' });
    // После подтверждённой остановки прежнее поведение сохраняется: отказ подключения заводит автоповтор.
    await this.connectOrRetry();
    this.checkEpoch(epoch);
  }

  /**
   * Шлёт сигнал, только если под pid всё ещё тот процесс хоста, чьё тождество снято раньше. Тождества нет или оно
   * изменилось — сигнала нет (fail closed); true — сигнал отправлен.
   */
  private signalIfSame(pid: number, expected: string | null, signal: NodeJS.Signals): boolean {
    if (expected === null || this.processes.identity(pid) !== expected || !this.processes.isHost(pid)) return false;
    this.processes.kill(pid, signal);
    return true;
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
    this.connectionEpoch += 1;
    this.clearReconnectTimer();
    this.rejectPending();
    this.candidate?.destroy();
    this.candidate = null;

    let pid: number | null;
    let expected: string | null = null;
    const socket = this.socket;
    if (socket !== null) {
      pid = this.hostPid;
      // Тождество снимаем до shutdown: добивать можно только тот процесс, которому он был отправлен.
      if (pid !== null) expected = this.processes.identity(pid);
      const closed =
        socket.destroyed ? Promise.resolve() : new Promise<void>((resolve) => socket.once('close', () => resolve()));
      // Ответа не ждём: молчащий хост (цикл событий стоит) не должен держать выход дольше срока. Отказ вызова
      // (сокет закрыт хостом или нами ниже) ожидаем и глотаем.
      void this.call('host.shutdown', {}).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
      clearTimeout(timer);
      socket.destroy();
      this.rejectPending();
      this.socket = null;
      if (pid === null || (await this.waitExit(pid, killGraceMs))) return 'shutdown';
    } else {
      pid = await this.livePidFromFile();
      if (pid === null) return 'none';
      expected = this.processes.identity(pid);
    }

    // Тождество не сошлось или не установлено: чужого поколения не трогаем, выход остаётся без добивания.
    if (!this.signalIfSame(pid, expected, 'SIGTERM')) return 'none';
    if (!(await this.waitExit(pid, killGraceMs))) this.signalIfSame(pid, expected, 'SIGKILL');
    return 'killed';
  }

  close(): void {
    this.closed = true;
    this.connectionEpoch += 1;
    this.rejectPending();
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
