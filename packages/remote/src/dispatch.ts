import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { HOST_ERROR_REASONS } from '@parley/protocol';
import type { WorksSnapshot } from '@parley/protocol';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL,
  appRequestFrame,
  bridgeEventSchemas,
  checkRemoteParams,
  phoneActionEvent,
  projectWorksSnapshot,
} from '@parley/protocol/remote';
import type { BridgeHello, PhoneActionEvent } from '@parley/protocol/remote';
import type { SessionRef } from '@parley/protocol';
import type { AuditLog } from './audit.js';
import { createFanout } from './fanout.js';
import { createFeedSubscriptions } from './feed-subs.js';
import { createSendDedupe } from './send-dedupe.js';
import type { SendOutcome } from './send-dedupe.js';
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
  /** Весомое действие телефона удалось (A34): событие `phone.action` окну по сокету управления. */
  onPhoneAction?: (event: PhoneActionEvent) => void;
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
  // `pty.send`, `feed.subscribe`: цель — сессия из `ref`.
  const ref = typeof p.ref === 'object' && p.ref !== null ? (p.ref as Record<string, unknown>) : {};
  return typeof ref.sessionId === 'string' && ref.sessionId.length <= 128 ? ref.sessionId : undefined;
}

/**
 * Ключ повтора `pty.send` и отпечаток сообщения: `ref`, текст и `submit` (без `requestedAt` — он у повтора свой).
 * Правило A27 уже проверило типы.
 */
function sendKeyOf(params: unknown): { clientMsgId: string; fingerprint: string } {
  const p = params as { ref: Record<string, unknown>; text: string; submit: boolean; clientMsgId: string };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([p.ref.projectPath, p.ref.workId, p.ref.sessionId, p.text, p.submit]))
    .digest('hex');
  return { clientMsgId: p.clientMsgId, fingerprint };
}

/** Сколько карточек согласий мост помнит: ждущих у хоста единицы, предел — от разрастания. */
const MAX_CONSENT_CARDS = 500;

/** Вид карточки согласия и её папка: по ним `consents.decide allow` становится `phone.action` (A34). */
interface ConsentCardInfo {
  kind: string;
  folder: string | null;
  /** Имя провайдера для людей у `agent-switch`. */
  provider: string | null;
}

/** `ref` из трёх строк без лишних ключей — цель `phone.action`. */
function cleanRef(value: unknown): SessionRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const { projectPath, workId, sessionId } = value as Record<string, unknown>;
  if (typeof projectPath !== 'string' || typeof workId !== 'string' || typeof sessionId !== 'string') return null;
  return { projectPath, workId, sessionId };
}

/** `ref` подписки на ленту: три строки, иначе `bad_request` — по нему считается подписка. */
function sessionRefOf(params: unknown): SessionRef | null {
  if (typeof params !== 'object' || params === null) return null;
  const ref = (params as { ref?: unknown }).ref;
  if (typeof ref !== 'object' || ref === null) return null;
  const { projectPath, workId, sessionId } = ref as Record<string, unknown>;
  if (typeof projectPath !== 'string' || typeof workId !== 'string' || typeof sessionId !== 'string') return null;
  return { projectPath, workId, sessionId };
}

export function createSessionHandler(options: BridgeOptions): SessionHandler & { stop(): void } {
  const { host, sessions, audit, log, info } = options;
  const push = sessions;
  const feedSubs = createFeedSubscriptions({ host, log });
  const fanout = createFanout({
    host,
    sessions,
    log,
    feedSubscribers: (ref) => feedSubs.subscribers(ref),
    ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
  });
  const sendDedupe = createSendDedupe(options.now ? { now: options.now } : {});
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

  /**
   * Ответ уходит только той сессии телефона, что прислала запрос (критик A30, M1): `id` у клиента — счётчик на
   * соединение, и поздний ответ прежней сессии под тем же `id` достался бы другому запросу новой.
   */
  function reply(deviceId: string, state: DeviceState, id: string, body: SendOutcome): void {
    if (devices.get(deviceId) !== state) return;
    if (!fanout.send(deviceId, { id, ...body }) && devices.get(deviceId) === state && 'result' in body) {
      // Результат больше 8 МиБ (или сессия уже закрыта): телефон узнаёт об этом, а не ждёт.
      fanout.send(deviceId, { id, error: { code: 'too_large', message: 'response is too large' } });
    }
  }

  const fail = (deviceId: string, state: DeviceState, id: string, code: string, message: string = code, extra: { data?: unknown } = {}): void =>
    reply(deviceId, state, id, { error: { code, message, ...extra } });

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
  /** Карточки согласий из `consents.list` и `consents.changed`; `id` у хоста сквозной, эпоха их не обесценивает. */
  const consentCards = new Map<string, ConsentCardInfo>();
  function learnCards(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const item of items as unknown[]) {
      const card = item as { id?: unknown; kind?: unknown; folder?: unknown; providerLabel?: unknown; provider?: unknown } | null;
      if (typeof card?.id !== 'string' || typeof card.kind !== 'string') continue;
      consentCards.delete(card.id);
      const provider = [card.providerLabel, card.provider].find((value): value is string => typeof value === 'string' && value !== '') ?? null;
      consentCards.set(card.id, { kind: card.kind, folder: typeof card.folder === 'string' ? card.folder : null, provider });
      if (consentCards.size > MAX_CONSENT_CARDS) consentCards.delete(consentCards.keys().next().value as string);
    }
  }

  const unsubscribe = host.subscribe((event) => {
    if (event.type === 'status' && event.status === 'online') for (const deviceId of [...devices.keys()]) rekeyIfStale(deviceId);
    if (event.type === 'host' && event.event === 'consents.changed') {
      const data = event.data as { upsert?: unknown; removed?: unknown } | null;
      learnCards(data?.upsert);
      if (Array.isArray(data?.removed)) for (const id of data.removed) if (typeof id === 'string') consentCards.delete(id);
    }
  });

  /** Карточка, которую телефон одобряет: из памяти, иначе одним `consents.list` до решения (после него её в списке нет). */
  async function consentCardOf(params: unknown): Promise<ConsentCardInfo | null> {
    const p = params as { id?: unknown; decision?: unknown };
    if (p.decision !== 'allow' || typeof p.id !== 'string') return null;
    if (!consentCards.has(p.id)) {
      try {
        learnCards(((await host.call('consents.list', {})) as { items?: unknown } | null)?.items);
      } catch (error) {
        log.warn('dispatch.consents_list_failed', { error });
      }
    }
    return consentCards.get(p.id) ?? null;
  }

  /**
   * Весомые действия удавшегося вызова (спека 12, A34): запуск сессии, доверие к папке, смена провайдера, Allow «Always»,
   * план с `auto-accept`. Обычный Allow, сообщения агентам и письма в комнаты — не весомые.
   */
  async function phoneActions(method: string, params: unknown, result: unknown, card: ConsentCardInfo | null): Promise<Omit<PhoneActionEvent, 'deviceId'>[]> {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    const r = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
    // `applied: false` — карточка уже не ждала, ничего не произошло.
    if (r.applied === false) return [];
    const actions: Omit<PhoneActionEvent, 'deviceId'>[] = [];
    if (method === 'sessions.create') {
      const ref = cleanRef(r.ref);
      if (ref) actions.push({ kind: 'session-create', target: ref });
    } else if (method === 'consents.decide' && card !== null && typeof p.id === 'string') {
      if (card.kind === 'folder-trust' && card.folder) actions.push({ kind: 'trust-folder', target: card.folder });
      // Имя провайдера, не `id` карточки; если карточка его не назвала — нейтральный текст.
      else if (card.kind === 'agent-switch') actions.push({ kind: 'provider-switch', target: card.provider ?? 'another provider' });
    } else if (method === 'feed.decide') {
      const ref = cleanRef(p.ref);
      const d = (typeof p.decision === 'object' && p.decision !== null ? p.decision : {}) as Record<string, unknown>;
      if (ref && d.kind === 'permission' && d.behavior === 'allow' && d.always === true) actions.push({ kind: 'allow-always', target: ref });
      else if (ref && d.kind === 'plan' && d.choice === 'auto-accept') actions.push({ kind: 'plan-auto-accept', target: ref });
    }
    return actions;
  }

  /** `phone.action` окну; событие проверяется схемой — лишнее (тексты) не уходит. Сбой не трогает ответ телефону. */
  async function emitPhoneActions(deviceId: string, method: string, params: unknown, result: unknown, card: ConsentCardInfo | null): Promise<void> {
    if (!options.onPhoneAction) return;
    try {
      for (const action of await phoneActions(method, params, result, card)) {
        const event = phoneActionEvent.safeParse({ deviceId, ...action });
        if (event.success) options.onPhoneAction(event.data);
        else log.warn('dispatch.phone_action_invalid', { method, kind: action.kind });
      }
    } catch (error) {
      log.error('dispatch.phone_action_failed', { method, error });
    }
  }

  /**
   * `sessions.create` с `trustFolder: true`: хост пишет доверие до запуска, и запуск после этого может не удаться. Событие
   * идёт по факту записи: папка не была доверена до вызова и доверена после него (успех или отказ запуска).
   */
  async function trustWrittenBy(params: unknown): Promise<(deviceId: string) => Promise<void>> {
    const p = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>;
    if (!options.onPhoneAction || p.trustFolder !== true || typeof p.projectPath !== 'string') return async () => undefined;
    const folder = p.projectPath;
    const trusted = async (): Promise<boolean | null> => {
      try {
        return ((await host.call('trust.check', { folder })) as { trusted?: unknown } | null)?.trusted === true;
      } catch {
        return null;
      }
    };
    const before = await trusted();
    return async (deviceId) => {
      if (before !== false || (await trusted()) !== true) return;
      // Хост пишет в `trust.json` realpath проекта; мост на том же Маке берёт его так же.
      const target = await realpath(folder).catch(() => folder);
      const event = phoneActionEvent.safeParse({ deviceId, kind: 'trust-folder', target });
      if (event.success) options.onPhoneAction?.(event.data);
    };
  }

  /** Нарушение протокола: `session.closing protocol` — телефон переподключится с отступом, а не примет это за остановку моста. */
  function close(deviceId: string): void {
    devices.delete(deviceId);
    fanout.sessionClosed(deviceId);
    feedSubs.dropDevice(deviceId);
    sessions.close(deviceId, 'protocol');
  }

  async function handle(deviceId: string, state: DeviceState, id: string, method: string, params: unknown): Promise<void> {
    if (LOCAL_METHODS.has(method)) {
      // Методы моста тоже считаются в работе; `push.register` пишет файл — не чаще 10 раз в минуту.
      if (state.inFlight >= MAX_IN_FLIGHT || (method === 'push.register' && !pushLimiter.take(deviceId))) {
        fail(deviceId, state, id, 'rate_limited', 'too many requests');
        return;
      }
      state.inFlight++;
      try {
        reply(deviceId, state, id, {
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
        if (error instanceof LocalMethodError) fail(deviceId, state, id, error.code);
        else {
          log.error('dispatch.local_failed', { method, error });
          fail(deviceId, state, id, 'internal', 'internal error');
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
      fail(deviceId, state, id, 'unknown_method', `unknown method: ${method.slice(0, 64)}`);
      return;
    }
    const feedRef = method === 'feed.subscribe' || method === 'feed.unsubscribe' ? sessionRefOf(params) : undefined;
    if (!checkRemoteParams(method, params) || feedRef === null) {
      refuse(deviceId, state, method, params, 'bad_request', 'params');
      fail(deviceId, state, id, 'bad_request');
      return;
    }
    // Отписка — состояние самого моста: проходит и без хоста, и мимо лимитов, иначе намерение телефона потерялось бы,
    // а новая эпоха подписала бы его снова. Вызов хоста (последний подписчик) делает сама очередь, если хост `online`.
    if (method === 'feed.unsubscribe' && feedRef) {
      reply(deviceId, state, id, { result: await feedSubs.unsubscribe(deviceId, feedRef) });
      return;
    }
    // Повтор `pty.send` с тем же `clientMsgId` — прежний ответ (или ждущий вызов), без хоста и без лимита изменений:
    // он не новое действие. Между поиском и записью ключа ниже нет `await` — второй кадр того же ключа найдёт первый вызов.
    const send = method === 'pty.send' ? sendKeyOf(params) : null;
    if (send !== null) {
      const prior = sendDedupe.lookup(deviceId, send.clientMsgId);
      if (prior) {
        // Тот же ключ с другим сообщением — ошибка клиента, а не повтор (критик m1).
        if (prior.fingerprint !== send.fingerprint) {
          refuse(deviceId, state, method, params, 'bad_request', 'clientMsgId');
          fail(deviceId, state, id, 'bad_request', 'clientMsgId was used for another message');
          return;
        }
        // Повтор, ждущий вызов в полёте, тоже занимает место в `MAX_IN_FLIGHT` (критик m3).
        if (state.inFlight >= MAX_IN_FLIGHT) {
          fail(deviceId, state, id, 'rate_limited', 'too many requests in flight');
          return;
        }
        state.inFlight++;
        try {
          reply(deviceId, state, id, await prior.outcome);
        } finally {
          state.inFlight--;
        }
        return;
      }
    }
    // Хост не online (starting, offline, incompatible): ничего не уходит и лимиты не тратятся.
    if (host.status !== 'online') {
      fail(deviceId, state, id, 'host_offline');
      return;
    }
    const mutating = MUTATING_METHODS.has(method);
    if (state.inFlight >= MAX_IN_FLIGHT) {
      if (mutating) refuse(deviceId, state, method, params, 'rate_limited', 'in-flight');
      fail(deviceId, state, id, 'rate_limited', 'too many requests in flight');
      return;
    }
    if (mutating && !limiter.take(deviceId)) {
      refuse(deviceId, state, method, params, 'rate_limited', 'rate');
      fail(deviceId, state, id, 'rate_limited', 'too many changes per minute');
      return;
    }
    if (!mutating && !readLimiter.take(deviceId)) {
      fail(deviceId, state, id, 'rate_limited', 'too many reads per minute');
      return;
    }
    // `works.list` телефону — проекция снимка эпохи, хост не зовётся: иначе каждый вызов собирал бы полный снимок (мегабайты).
    if (method === 'works.list') {
      try {
        const snapshot = projectedSnapshot();
        if (snapshot === null) fail(deviceId, state, id, 'host_offline');
        else reply(deviceId, state, id, { result: snapshot });
      } catch (error) {
        log.error('dispatch.projection_failed', { method, error });
        fail(deviceId, state, id, 'internal', 'internal error');
      }
      return;
    }

    state.inFlight++;
    try {
      const outcome = callHost(deviceId, state, method, params, feedRef);
      // Параметры `pty.send` уходят хосту как есть, с `clientMsgId` (решение ведущего m-2202): правило A27 хост
      // проверяет то же, его схема лишний ключ отбрасывает.
      if (send !== null) sendDedupe.remember(deviceId, send.clientMsgId, send.fingerprint, outcome);
      reply(deviceId, state, id, await outcome);
    } finally {
      state.inFlight--;
    }
  }

  /** Вызов хоста (или подписки моста) → исход для телефона; не отвергается. */
  async function callHost(deviceId: string, state: DeviceState, method: string, params: unknown, feedRef: SessionRef | undefined): Promise<SendOutcome> {
    const mutating = MUTATING_METHODS.has(method);
    try {
      let raw: unknown;
      if (feedRef !== undefined) {
        // `feed.subscribe`: хост видит одного подписчика — мост; счётчик по `ref` на все телефоны (A30).
        raw = await feedSubs.subscribe(deviceId, feedRef);
      } else {
        const card = method === 'consents.decide' && options.onPhoneAction ? await consentCardOf(params) : null;
        const trustAfter = method === 'sessions.create' ? await trustWrittenBy(params) : null;
        try {
          raw = await host.call(method, params ?? {});
        } catch (error) {
          await trustAfter?.(deviceId);
          throw error;
        }
        if (trustAfter !== null) await trustAfter(deviceId);
        if (method === 'consents.list') learnCards((raw as { items?: unknown } | null)?.items);
        if (mutating) void emitPhoneActions(deviceId, method, params, raw, card);
      }
      // Сбой проекции уходит ошибкой `internal`, сырой ответ телефону не отдаётся.
      const result = RESULT_PROJECTIONS[method]?.(raw) ?? raw;
      if (mutating) audit.append({ kind: 'call', deviceId, deviceName: state.name, method, ...auditOf(method, params), outcome: 'ok' });
      return { result };
    } catch (error) {
      const code = error instanceof HostCallError ? error.code : 'internal';
      if (mutating) audit.append({ kind: 'call', deviceId, deviceName: state.name, method, ...auditOf(method, params), outcome: code });
      if (error instanceof HostCallError) return { error: { code: error.code, message: error.message, ...safeErrorData(error.data) } };
      log.error('dispatch.call_failed', { method, error });
      return { error: { code: 'internal', message: 'internal error' } };
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
      // Окна лимитов переживают переподключение: иначе новое соединение обнуляло бы 30 изменений в минуту (критик m4).
      helloKeys.delete(deviceId);
      fanout.sessionClosed(deviceId);
      // Подписки на ленту телефона сняты; кэш `pty.send` остаётся: повтор после `lost` придёт с новой сессии.
      feedSubs.dropDevice(deviceId);
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
      feedSubs.stop();
    },
  };
}
