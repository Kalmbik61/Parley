import { createHash } from 'node:crypto';
import { HOST_ERROR_REASONS } from '@parley/protocol';
import type { WorksSnapshot } from '@parley/protocol';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL,
  appRequestFrame,
  bridgeEventSchemas,
  checkRemoteParams,
  projectWorksSnapshot,
} from '@parley/protocol/remote';
import type { BridgeHello } from '@parley/protocol/remote';
import type { AuditLog } from './audit.js';
import { createFanout } from './fanout.js';
import type { SessionHandler, PhoneSessions } from './session-contract.js';
import { HostCallError } from './host-link.js';
import type { HostLink } from './host-link.js';
import {
  MAX_FRAME_FROM_PHONE,
  MAX_IN_FLIGHT,
  MUTATING_METHODS,
  MUTATING_PER_MINUTE,
  PUSH_REGISTER_PER_MINUTE,
  READS_PER_MINUTE,
  createRateLimiter,
} from './limits.js';
import { LOCAL_METHODS, LocalMethodError, callLocalMethod } from './local-methods.js';
import type { ClientInfo } from './local-methods.js';
import type { BridgeLog } from './log.js';

/** Постоянные поля `hello` моста (спека 8.2); `host` и `epoch` берутся у `HostLink`. */
export interface BridgeInfo {
  /** Функция — `hostId` меняется после сброса ключа (спека 7.9). */
  hostId: string | (() => string);
  hostName: string;
  bridgeVersion: string;
  /** Версия хоста, если известна (`host.info`); иначе `null`. */
  hostVersion?: () => string | null;
  minClient: string;
  /** Функция — адрес relay меняется командой `configure` без перезапуска. */
  relays: string[] | (() => string[]);
}

export interface BridgeOptions {
  host: HostLink;
  sessions: PhoneSessions;
  audit: AuditLog;
  log: BridgeLog;
  info: BridgeInfo;
  /** Имя устройства для журнала (хранит A7); нет — пустая строка. */
  deviceName?: (deviceId: string) => string;
  now?: () => number;
  coalesceMs?: number;
}

interface DeviceState {
  name: string;
  inFlight: number;
  /** Ключ последнего `push.register` сессии (`local-methods`). */
  pushKey?: string;
  clientInfo?: ClientInfo;
}

const decoder = new TextDecoder();
const KNOWN_REASONS: ReadonlySet<string> = new Set(Object.values(HOST_ERROR_REASONS));
const STAGE_METHODS: ReadonlySet<string> = new Set(REMOTE_METHODS);

/** Ответы хоста, которые телефону идут только в проекции: сырой `works.list` несёт планы и `argv`/`env` проверок. */
const RESULT_PROJECTIONS: Readonly<Record<string, (result: unknown) => unknown>> = {
  'works.list': (result) => projectWorksSnapshot(result as WorksSnapshot),
};

/** Только известный `reason` хоста идёт телефону в `data`; остальное отбрасывается. */
function safeErrorData(data: unknown): { data: unknown } | Record<string, never> {
  if (typeof data === 'object' && data !== null) {
    const reason = (data as { reason?: unknown }).reason;
    if (typeof reason === 'string' && KNOWN_REASONS.has(reason)) return { data };
  }
  return {};
}

/** Ключи, значения которых безопасно писать в журнал как есть: выбор решения, режим, номера. Остальные строки — только длина и хэш. */
const PLAIN_KEYS: ReadonlySet<string> = new Set(['rev', 'choice', 'decision', 'kind', 'mode', 'always', 'allow', 'approve', 'provider', 'model', 'role']);

/** Для журнала: числа и флаги, выбор решения; тексты — длиной и хэшем (спека 5.8). Сами тексты в журнал не попадают. */
function describeParams(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`);
    else if (typeof value === 'string') {
      if (PLAIN_KEYS.has(key) && value.length <= 24 && /^[\w.:-]*$/.test(value)) parts.push(`${key}=${value}`);
      else parts.push(`${key}:len=${Buffer.byteLength(value)},sha256=${createHash('sha256').update(value).digest('hex').slice(0, 12)}`);
    }
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * Журнал вызова (спека 5.8): цель и подробности. У `feed.decide` сессия и выбор лежат во вложенных объектах (`ref`,
 * `decision`): цель — сессия, в подробностях карточка, вид и выбор; ответы на вопрос и текст отказа — длиной и хэшем.
 */
function auditOf(method: string, params: unknown): { target: string | undefined; detail: string | undefined } {
  if (method !== 'feed.decide' || typeof params !== 'object' || params === null) {
    return { target: targetOf(params), detail: describeParams(params) };
  }
  const p = params as { ref?: unknown; cardId?: unknown; decision?: unknown };
  const ref = typeof p.ref === 'object' && p.ref !== null ? (p.ref as Record<string, unknown>) : {};
  const target = typeof ref.sessionId === 'string' && ref.sessionId.length <= 128 ? ref.sessionId : undefined;
  const parts: string[] = [];
  if (typeof p.cardId === 'string') parts.push(/^[\w.:-]{1,64}$/.test(p.cardId) ? `cardId=${p.cardId}` : opaque('cardId', p.cardId));
  const d = typeof p.decision === 'object' && p.decision !== null ? (p.decision as Record<string, unknown>) : {};
  for (const key of ['kind', 'behavior', 'choice']) if (typeof d[key] === 'string' && /^[\w-]{1,24}$/.test(d[key] as string)) parts.push(`${key}=${d[key]}`);
  if (typeof d.always === 'boolean') parts.push(`always=${d.always}`);
  if (typeof d.message === 'string') parts.push(opaque('message', d.message));
  if (d.answers !== undefined) parts.push(opaque('answers', JSON.stringify(d.answers) ?? ''));
  return { target, detail: parts.length ? parts.join(' ') : undefined };
}

/** Текст журнала: только длина и хэш. */
function opaque(key: string, value: string): string {
  return `${key}:len=${Buffer.byteLength(value)},sha256=${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function targetOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const p = params as Record<string, unknown>;
  for (const key of ['roomId', 'proposalId', 'workId', 'sessionId', 'id']) {
    if (typeof p[key] === 'string' && (p[key] as string).length <= 128) return p[key] as string;
  }
  return undefined;
}

export function createSessionHandler(options: BridgeOptions): SessionHandler & { stop(): void } {
  const { host, sessions, audit, log, info } = options;
  const push = sessions;
  const fanout = createFanout({ host, sessions, log, ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }) });
  const limiter = createRateLimiter(MUTATING_PER_MINUTE, 60_000, options.now);
  const readLimiter = createRateLimiter(READS_PER_MINUTE, 60_000, options.now);
  const pushLimiter = createRateLimiter(PUSH_REGISTER_PER_MINUTE, 60_000, options.now);
  /** Проекция снимка эпохи: считается один раз на снимок, а не на каждый вызов `works.list`. */
  let projected: { source: WorksSnapshot; value: ReturnType<typeof projectWorksSnapshot> } | null = null;
  function projectedSnapshot(): ReturnType<typeof projectWorksSnapshot> | null {
    const source = host.snapshot;
    if (!source) return null;
    if (projected?.source !== source) projected = { source, value: projectWorksSnapshot(source) };
    return projected.value;
  }
  const devices = new Map<string, DeviceState>();

  function reply(deviceId: string, id: string, body: { result: unknown } | { error: { code: string; message: string; data?: unknown } }): void {
    if (!devices.has(deviceId)) return;
    if (!fanout.send(deviceId, { id, ...body }) && devices.has(deviceId) && 'result' in body) {
      // Результат больше 8 МиБ (или сессия уже закрыта): телефон узнаёт об этом, а не ждёт.
      fanout.send(deviceId, { id, error: { code: 'too_large', message: 'response is too large' } });
    }
  }

  const fail = (deviceId: string, id: string, code: string, message: string = code, extra: { data?: unknown } = {}): void =>
    reply(deviceId, id, { error: { code, message, ...extra } });

  function refuse(deviceId: string, state: DeviceState, method: string, params: unknown, outcome: string, detail?: string): void {
    audit.append({ kind: 'call-refused', deviceId, deviceName: state.name, method, target: targetOf(params), outcome, detail });
  }

  /** Методы, которые телефон может звать в эту эпоху: белый список этапа ∩ `hello.methods` хоста. */
  function hostMethods(): string[] {
    const offered = host.methods;
    return offered === null ? [] : REMOTE_METHODS.filter((m) => offered.includes(m));
  }
  const methodsKey = (): string => hostMethods().join(',');
  /** Набор методов в `hello` телефона на момент рукопожатия. */
  const helloKeys = new Map<string, string>();

  /** Набор методов эпохи отличается от того, что телефон получил в `hello`: `rekey`, он переподключится и увидит новый. */
  function rekeyIfStale(deviceId: string): void {
    const seen = helloKeys.get(deviceId);
    if (seen === undefined || host.status !== 'online' || seen === methodsKey()) return;
    sessions.close(deviceId, 'rekey');
  }
  const unsubscribe = host.subscribe((event) => {
    if (event.type === 'status' && event.status === 'online') for (const deviceId of [...devices.keys()]) rekeyIfStale(deviceId);
  });

  /** Нарушение протокола: `session.closing protocol` — телефон переподключится с отступом, а не примет это за остановку моста. */
  function close(deviceId: string): void {
    devices.delete(deviceId);
    fanout.sessionClosed(deviceId);
    sessions.close(deviceId, 'protocol');
  }

  async function handle(deviceId: string, state: DeviceState, id: string, method: string, params: unknown): Promise<void> {
    if (LOCAL_METHODS.has(method)) {
      // Методы моста тоже считаются в работе; `push.register` пишет файл — не чаще 10 раз в минуту.
      if (state.inFlight >= MAX_IN_FLIGHT || (method === 'push.register' && !pushLimiter.take(deviceId))) {
        fail(deviceId, id, 'rate_limited', 'too many requests');
        return;
      }
      state.inFlight++;
      try {
        reply(deviceId, id, {
          result: await callLocalMethod(method, params, {
            deviceId,
            push,
            setClientInfo: (info) => {
              state.clientInfo = info;
            },
            pushKey: {
              get: () => state.pushKey,
              set: (key) => {
                state.pushKey = key;
              },
            },
          }),
        });
      } catch (error) {
        if (error instanceof LocalMethodError) fail(deviceId, id, error.code);
        else {
          log.error('dispatch.local_failed', { method, error });
          fail(deviceId, id, 'internal', 'internal error');
        }
      } finally {
        state.inFlight--;
      }
      return;
    }

    // Белый список этапа ∩ `hello.methods` хоста этой эпохи (A8b); правила параметров. Хост политику повторяет,
    // но мост отсекает первым. Пока методов эпохи нет (хост не `online`), решает `host_offline` ниже.
    if (!STAGE_METHODS.has(method) || (host.methods !== null && !host.methods.includes(method))) {
      refuse(deviceId, state, method, params, 'unknown_method');
      fail(deviceId, id, 'unknown_method', `unknown method: ${method.slice(0, 64)}`);
      return;
    }
    if (!checkRemoteParams(method, params)) {
      refuse(deviceId, state, method, params, 'bad_request', 'params');
      fail(deviceId, id, 'bad_request');
      return;
    }
    // Хост не online (starting, offline, incompatible): ничего не уходит и лимиты не тратятся.
    if (host.status !== 'online') {
      fail(deviceId, id, 'host_offline');
      return;
    }
    const mutating = MUTATING_METHODS.has(method);
    if (state.inFlight >= MAX_IN_FLIGHT) {
      if (mutating) refuse(deviceId, state, method, params, 'rate_limited', 'in-flight');
      fail(deviceId, id, 'rate_limited', 'too many requests in flight');
      return;
    }
    if (mutating && !limiter.take(deviceId)) {
      refuse(deviceId, state, method, params, 'rate_limited', 'rate');
      fail(deviceId, id, 'rate_limited', 'too many changes per minute');
      return;
    }
    if (!mutating && !readLimiter.take(deviceId)) {
      fail(deviceId, id, 'rate_limited', 'too many reads per minute');
      return;
    }
    // `works.list` телефону — проекция снимка эпохи, хост не зовётся: иначе каждый вызов собирал бы полный снимок (мегабайты).
    if (method === 'works.list') {
      try {
        const snapshot = projectedSnapshot();
        if (snapshot === null) fail(deviceId, id, 'host_offline');
        else reply(deviceId, id, { result: snapshot });
      } catch (error) {
        log.error('dispatch.projection_failed', { method, error });
        fail(deviceId, id, 'internal', 'internal error');
      }
      return;
    }

    state.inFlight++;
    try {
      const raw = await host.call(method, params ?? {});
      // Сбой проекции уходит ошибкой `internal`, сырой ответ телефону не отдаётся.
      const result = RESULT_PROJECTIONS[method]?.(raw) ?? raw;
      if (mutating) audit.append({ kind: 'call', deviceId, deviceName: state.name, method, ...auditOf(method, params), outcome: 'ok' });
      reply(deviceId, id, { result });
    } catch (error) {
      const code = error instanceof HostCallError ? error.code : 'internal';
      if (mutating) audit.append({ kind: 'call', deviceId, deviceName: state.name, method, ...auditOf(method, params), outcome: code });
      if (error instanceof HostCallError) fail(deviceId, id, error.code, error.message, safeErrorData(error.data));
      else {
        log.error('dispatch.call_failed', { method, error });
        fail(deviceId, id, 'internal', 'internal error');
      }
    } finally {
      state.inFlight--;
    }
  }

  return {
    hello(deviceId): BridgeHello {
      helloKeys.set(deviceId, methodsKey());
      return {
        protocol: REMOTE_PROTOCOL,
        minClient: info.minClient,
        hostId: typeof info.hostId === 'function' ? info.hostId() : info.hostId,
        hostName: info.hostName,
        bridgeVersion: info.bridgeVersion,
        hostVersion: info.hostVersion?.() ?? null,
        host: host.status,
        epoch: host.epoch,
        stage: 'A',
        methods: [...hostMethods(), ...LOCAL_METHODS],
        events: [...REMOTE_EVENTS, ...Object.keys(bridgeEventSchemas)],
        relays: typeof info.relays === 'function' ? info.relays() : info.relays,
        serverTime: Date.now(),
      };
    },
    onOpen(deviceId) {
      devices.set(deviceId, { name: options.deviceName?.(deviceId) ?? '', inFlight: 0 });
      fanout.sessionActive(deviceId);
      rekeyIfStale(deviceId);
    },
    onClose(deviceId) {
      devices.delete(deviceId);
      limiter.forget(deviceId);
      readLimiter.forget(deviceId);
      pushLimiter.forget(deviceId);
      helloKeys.delete(deviceId);
      fanout.sessionClosed(deviceId);
    },
    onFrame(deviceId, frame) {
      const state = devices.get(deviceId);
      if (!state) return;
      // A7 держит потолок 64 КиБ в `FrameCodec`; здесь защита на случай другого пути входа.
      if (frame.length > MAX_FRAME_FROM_PHONE) {
        log.warn('dispatch.frame_too_large', { deviceId, size: frame.length });
        close(deviceId);
        return;
      }
      let parsed: ReturnType<typeof appRequestFrame.safeParse>;
      try {
        parsed = appRequestFrame.safeParse(JSON.parse(decoder.decode(frame)));
      } catch {
        parsed = appRequestFrame.safeParse(undefined);
      }
      if (!parsed.success) {
        // Без валидного `id` ответить нельзя: нарушение протокола, сессия закрывается.
        log.warn('dispatch.bad_frame', { deviceId });
        close(deviceId);
        return;
      }
      const { id, method, params } = parsed.data;
      void handle(deviceId, state, id, method, params);
    },
    stop() {
      unsubscribe();
      fanout.stop();
    },
  };
}
