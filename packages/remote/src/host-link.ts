import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import {
  COMPACT_WORKS_FEATURE,
  LineDecoder,
  PROTOCOL_VERSION,
  ROOMS_MAIL_FEATURE,
} from '@parley/protocol';
import type { Events, SessionRef, WorksSnapshot } from '@parley/protocol';
import { REMOTE_POLICY_FEATURE } from '@parley/protocol/remote';
import type { BridgeLog } from './log.js';

/** Причина, по которой связь не доходит до `online`, если известна. */
export type HostLinkFailure = 'line_too_long';

export type HostLinkStatus = 'offline' | 'incompatible' | 'starting' | 'online';

/** Последнее `activity.changed` по сессии: ровно то, что пришло от хоста. */
type SessionActivity = Events['activity.changed']['activity'];

export interface ActivityEntry {
  ref: SessionRef;
  activity: SessionActivity;
  metrics: unknown;
}

export type HostLinkEvent =
  | { type: 'status'; status: HostLinkStatus; epoch: string | null }
  | { type: 'host'; event: string; data: unknown };

export class HostCallError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
    /** `error.data` хоста как есть; наружу к телефону идёт только при известном `reason` (A8). */
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'HostCallError';
  }
}

export interface HostLinkOptions {
  socketPath: string;
  tokenPath: string;
  log: BridgeLog;
  /** Задержка перед переподключением и повтором `works.list`: от `initialMs`, удваивается до `maxMs`. */
  backoff?: { initialMs: number; maxMs: number };
  /** Только тесты: фиксированный `bootId`. */
  bootId?: string;
  /** Тайм-аут на ответ `hello` и `works.list`. */
  replyTimeoutMs?: number;
}

/** Внешний интерфейс для A8 (проекция) и A9 (ретрансляция вызовов). */
export interface HostLink {
  start(): void;
  stop(): Promise<void>;
  readonly status: HostLinkStatus;
  /** `<bootId>:<n>`; `null` — соединения ещё не было. Растёт на каждое соединение с хостом. */
  readonly epoch: string | null;
  /** `hello.methods` хоста текущей эпохи (проверенный ответ); `null` — эпохи нет или хост несовместим. */
  readonly methods: readonly string[] | null;
  /** Почему мост не может загрузить эпоху (например, строка хоста длиннее предела); `null` — причин нет. */
  readonly failure: HostLinkFailure | null;
  /** Полный снимок текущей эпохи; `null` до ответа `works.list`. */
  readonly snapshot: WorksSnapshot | null;
  /** Последнее `activity.changed` на каждую сессию текущей эпохи. */
  readonly activity: ReadonlyMap<string, ActivityEntry>;
  /** Вызов метода хоста; вне `online` — `HostCallError('host_offline')`, до хоста не доходит. */
  call(method: string, params?: unknown): Promise<unknown>;
  subscribe(listener: (event: HostLinkEvent) => void): () => void;
}

export const refKey = (ref: SessionRef): string => `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export function createHostLink(options: HostLinkOptions): HostLink {
  const { log } = options;
  const backoff = options.backoff ?? { initialMs: 500, maxMs: 15_000 };
  const replyTimeoutMs = options.replyTimeoutMs ?? 30_000;
  const bootId = options.bootId ?? randomBytes(8).toString('hex');
  const listeners = new Set<(event: HostLinkEvent) => void>();

  let status: HostLinkStatus = 'offline';
  let epochCounter = 0;
  let epoch: string | null = null;
  let hostMethods: string[] | null = null;
  let failure: HostLinkFailure | null = null;
  let snapshot: WorksSnapshot | null = null;
  let activity = new Map<string, ActivityEntry>();
  let socket: net.Socket | null = null;
  let pending = new Map<number, Pending>();
  let nextId = 1;
  let stopped = true;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = backoff.initialMs;

  function emit(event: HostLinkEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // подписчик не должен ронять связь
      }
    }
  }

  function setStatus(next: HostLinkStatus): void {
    if (status === next) return;
    status = next;
    emit({ type: 'status', status, epoch });
  }

  function failPending(): void {
    const old = pending;
    pending = new Map();
    for (const entry of old.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new HostCallError('host_offline'));
    }
  }

  function scheduleReconnect(): void {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, backoff.maxMs);
  }

  /** Запрос по сокету конкретной эпохи; ответ чужой эпохи не принимается. */
  function request(sock: net.Socket, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (sock.destroyed) {
        reject(new HostCallError('host_offline'));
        return;
      }
      const id = nextId++;
      const entry: Pending = { resolve, reject };
      entry.timer = setTimeout(() => {
        pending.delete(id);
        reject(new HostCallError('timeout'));
      }, replyTimeoutMs);
      pending.set(id, entry);
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  function applySnapshot(next: WorksSnapshot): void {
    // Побеждает больший `revision`; ответ `works.list` не откатывает свежее событие.
    if (snapshot && (next.revision ?? 0) < (snapshot.revision ?? 0)) return;
    snapshot = next;
  }

  function handleEvent(event: string, data: unknown): void {
    if (event === 'activity.changed') {
      const d = data as { ref?: SessionRef; activity: SessionActivity; metrics?: unknown };
      if (d?.ref) activity.set(refKey(d.ref), { ref: d.ref, activity: d.activity, metrics: d.metrics ?? null });
    } else if (event === 'works.changed') {
      applySnapshot(data as WorksSnapshot);
    }
    emit({ type: 'host', event, data });
  }

  async function loadWorks(sock: net.Socket): Promise<void> {
    let delay = backoff.initialMs;
    while (socket === sock && !sock.destroyed) {
      try {
        const reply = (await request(sock, 'works.list', {})) as WorksSnapshot;
        if (socket !== sock) return;
        applySnapshot(reply);
        retryDelay = backoff.initialMs;
        failure = null;
        setStatus('online');
        return;
      } catch (error) {
        if (socket !== sock) return;
        log.warn('host.works_list_failed', { error });
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, backoff.maxMs);
      }
    }
  }

  /** Сокет в пути (до `connect`) и поколение попытки: `stop()` и новый `start()` обесценивают старую. */
  let connecting: net.Socket | null = null;
  let generation = 0;

  async function connect(): Promise<void> {
    if (stopped) return;
    const gen = ++generation;
    let token: string;
    try {
      // Токен читается заново на каждое подключение (хост мог перезапуститься).
      token = (await readFile(options.tokenPath, 'utf8')).trim();
    } catch (error) {
      if (gen !== generation) return;
      log.warn('host.token_unreadable', { error });
      setStatus('offline');
      scheduleReconnect();
      return;
    }
    if (stopped || gen !== generation) return;
    log.addSecret(token);

    const sock = net.connect(options.socketPath);
    connecting = sock;
    const decoder = new LineDecoder();
    let closed = false;
    /** Ответ на `hello` разобран и признак политики подтверждён: до этого события хоста отбрасываются. */
    let verified = false;

    function onClose(): void {
      if (closed) return;
      closed = true;
      if (connecting === sock) {
        // Не дошли до `connect` (хост недоступен): повтор с отступом.
        connecting = null;
        if (!stopped && gen === generation) {
          setStatus('offline');
          scheduleReconnect();
        }
        return;
      }
      if (socket === sock) {
        socket = null;
        failPending();
        snapshot = null;
        activity = new Map();
        hostMethods = null;
        if (status !== 'incompatible') setStatus('offline');
        scheduleReconnect();
      }
    }
    sock.on('error', () => {});
    sock.on('close', onClose);

    sock.on('connect', () => {
      if (stopped || connecting !== sock) {
        sock.destroy();
        return;
      }
      connecting = null;
      // Новая эпоха: кэши прошлой не переживают переподключение.
      failPending();
      epoch = `${bootId}:${++epochCounter}`;
      snapshot = null;
      activity = new Map();
      hostMethods = null;
      socket = sock;
      emit({ type: 'status', status, epoch });
      sendHello(sock, token, onHelloReply);
    });

    /** Вызывается синхронно из разбора кадров: следующий кадр того же куска уже видит `verified`. */
    function onHelloReply(result: unknown, error: Error | null): void {
      if (socket !== sock) {
        sock.destroy();
        return;
      }
      if (error) {
        log.warn('host.hello_failed', { error });
        sock.destroy();
        return;
      }
      const reply = result as { features?: unknown; methods?: unknown } | null;
      const features = reply?.features;
      if (!Array.isArray(features) || !features.includes(REMOTE_POLICY_FEATURE)) {
        // Fail closed: хост без политики — ни одного вызова и ни одного события.
        log.warn('host.incompatible');
        setStatus('incompatible');
        sock.destroy();
        return;
      }
      verified = true;
      hostMethods = Array.isArray(reply?.methods) ? reply.methods.filter((m): m is string => typeof m === 'string') : [];
      log.info('host.connected', { epoch });
      setStatus('starting');
      void loadWorks(sock);
    }

    sock.on('data', (chunk: Buffer) => {
      if (socket !== sock) return;
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch {
        // Строка длиннее предела (например, огромный `works.list`): причина в логе и в `failure`.
        failure = 'line_too_long';
        log.warn('host.line_too_long', { epoch });
        sock.destroy();
        return;
      }
      for (const raw of messages) {
        if (socket !== sock || sock.destroyed) return;
        const msg = raw as { id?: unknown; result?: unknown; error?: { code?: string; message?: string; data?: unknown }; event?: unknown; data?: unknown };
        if (typeof msg !== 'object' || msg === null) continue;
        if (typeof msg.id === 'number') {
          const entry = pending.get(msg.id);
          if (!entry) continue;
          pending.delete(msg.id);
          if (entry.timer) clearTimeout(entry.timer);
          if (msg.error) entry.reject(new HostCallError(msg.error.code ?? 'host_error', msg.error.message, msg.error.data));
          else entry.resolve(msg.result);
        } else if (typeof msg.event === 'string') {
          // До подтверждения политики события не доходят ни до кэша, ни до подписчиков.
          if (verified) handleEvent(msg.event, msg.data);
        }
      }
    });
  }

  /** `hello` без Promise: ответ обрабатывается в том же такте, что и разбор кадра. */
  function sendHello(sock: net.Socket, token: string, done: (result: unknown, error: Error | null) => void): void {
    const id = nextId++;
    const entry: Pending = { resolve: (v) => done(v, null), reject: (e) => done(null, e) };
    entry.timer = setTimeout(() => {
      pending.delete(id);
      done(null, new HostCallError('timeout'));
    }, replyTimeoutMs);
    pending.set(id, entry);
    sock.write(
      `${JSON.stringify({
        id,
        method: 'hello',
        params: { token, protocol: PROTOCOL_VERSION, client: 'remote', features: [COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE] },
      })}\n`,
    );
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      retryDelay = backoff.initialMs;
      void connect();
    },
    async stop() {
      stopped = true;
      generation++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      const sock = socket;
      socket = null;
      const inPath = connecting;
      connecting = null;
      failPending();
      sock?.destroy();
      inPath?.destroy();
      snapshot = null;
      hostMethods = null;
      activity = new Map();
      setStatus('offline');
    },
    get status() {
      return status;
    },
    get epoch() {
      return epoch;
    },
    get methods() {
      return hostMethods;
    },
    get failure() {
      return failure;
    },
    get snapshot() {
      return snapshot;
    },
    get activity() {
      return activity;
    },
    call(method, params = {}) {
      const sock = socket;
      if (status !== 'online' || !sock) return Promise.reject(new HostCallError('host_offline'));
      return request(sock, method, params);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
