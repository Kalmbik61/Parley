/**
 * Удалённый исполнитель инструментов Parley (спека хранилища 6.3, 6.4, 6.9, этап 1): процесс MCP сессии с каналом агента
 * не открывает карту, а пересылает `tools/list` и `tools/call` хосту — `POST /agent/tools`, — и хост исполняет их тем же
 * `createToolRunner` в своём процессе. Здесь же описан сам обмен — путь, потолок тела, форма запроса и ответа: хост
 * берёт их отсюда, чтобы две стороны не разошлись.
 */

import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { types as utilTypes } from 'node:util';
import type { AgentChannel, ToolProfile } from '../work/mcp-config.js';
import type { McpContext } from './context.js';
import { waitTimeoutMs, type ToolRunner } from './tools.js';

/** Путь маршрута хоста; адрес и порт берутся у канала агента (`McpContext.agent`). */
export const AGENT_TOOLS_PATH = '/agent/tools';

/** Потолок тела запроса: больше хост отвечает 413 и тела не читает (спека хранилища 6.3). */
export const AGENT_TOOLS_REQUEST_BYTES = 1024 * 1024;

/** Тексты, которые видит агент (спека хранилища 6.4): хост молчит, ссылка сессии с хостом устарела, аргументы велики. */
export const HOST_NOT_RESPONDING = 'Parley host is not responding, try again.';
export const SESSION_LINK_EXPIRED = "This session's link to Parley has expired: ask the human to restart the session from Parley.";
export const ARGUMENTS_TOO_LARGE = 'The tool arguments are larger than 1 MiB: write the long part to a file and pass its path.';
const CANCELLED = 'Cancelled.';
const UNREADABLE_ANSWER = "Parley's host sent an unreadable answer.";
const hostRefused = (status: number): string => `Parley's host refused the request (HTTP ${status}).`;

/** Срок одного запроса `list`. */
const LIST_TIMEOUT_MS = 30_000;
/** Срок одного запроса `call` по умолчанию (`wait_for` — свой, см. `requestTimeoutMs`). */
const CALL_TIMEOUT_MS = 120_000;
/** Запас сверх срока `wait_for`: хост сам кончает ожидание по таймауту и успевает ответить. */
const WAIT_SLACK_MS = 30_000;
/** Сколько после первой неудачи повторять, пока хост занят (спека хранилища 6.4: «примерно до 30 с»). */
const RETRY_BUDGET_MS = 30_000;
/** Паузы перед повторами; когда они кончились — последняя повторяется. */
const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 8000];
/** Ответы, после которых повторяют: хост занят или перезапускается. */
const RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Снимок запуска сессии, от которого зависят список и описания инструментов хоста: он собирает исполнителя сессии по
 * токену, а профиль и навигатор скиллов знает только процесс MCP (они приходят в его окружении при старте).
 */
export interface ToolLaunch {
  skillNavigator?: boolean;
  skillListReduced?: boolean;
  nativeContextRevision?: string;
  agentRevision?: string;
  toolProfile?: ToolProfile;
}

/** Из контекста сервера — только поля запуска, и только заданные: лишнего хосту не уходит. */
export function launchOf(context: McpContext): ToolLaunch {
  return {
    ...(context.skillNavigator === undefined ? {} : { skillNavigator: context.skillNavigator }),
    ...(context.skillListReduced === undefined ? {} : { skillListReduced: context.skillListReduced }),
    ...(context.nativeContextRevision === undefined ? {} : { nativeContextRevision: context.nativeContextRevision }),
    ...(context.agentRevision === undefined ? {} : { agentRevision: context.agentRevision }),
    ...(context.toolProfile === undefined ? {} : { toolProfile: context.toolProfile }),
  };
}

/**
 * Тело запроса к `/agent/tools`. `callId` — один на вызов и на все его повторы: по нему хост отдаёт сохранённый результат
 * вместо второго исполнения (спека хранилища 6.4, ключ идемпотентности).
 */
export type RemoteToolRequest =
  | { op: 'list'; launch: ToolLaunch }
  | { op: 'call'; launch: ToolLaunch; name: string; args: Record<string, unknown>; meta?: Record<string, unknown>; callId: string };

/**
 * Ответ хоста со статусом 200. Ошибка самого инструмента едет внутри `result` — `CallToolResult` с `isError: true`, — а
 * `ok: false` только у отказа маршрута (кривой запрос и тому подобное). Отказы 401 и 413 — статусом, без тела.
 */
export type RemoteToolResponse =
  | { ok: true; result: { tools: Tool[] } | CallToolResult }
  | { ok: false; error: { code: string; message: string } };

export interface RemoteToolOptions {
  /** Окно повторов от первой неудачи вызова; по умолчанию 30 с. */
  retryBudgetMs?: number;
  /** Паузы перед повторами; кончились — повторяется последняя. По умолчанию 250, 500, 1000, 2000, 4000, 8000 мс. */
  retryDelaysMs?: readonly number[];
  /** Срок одного запроса `call` (не `wait_for`); по умолчанию 120 с. */
  callTimeoutMs?: number;
  /**
   * Исполнитель в этом процессе на случай, когда у хоста нет маршрута `/agent/tools` (спека хранилища 6.5: сессия без
   * работающего канала остаётся на прямом пути и читает базу работ напрямую; работы в базе ещё нет — отказ «workspace …
   * does not exist»). Ответ 404 значит хост прежней сборки: так бывает сразу после обновления, когда хост ещё старый и
   * запускает сессии, а сервер MCP на диске уже новый. Первый такой ответ на `list` или `call` переключает исполнителя
   * до конца процесса: этот вызов и все следующие идут в запасной. Не задан —
   * 404 остаётся отказом с текстом. Насовсем переключает только 404: молчание хоста, 401 и 5xx — не повод открывать карту
   * мимо него. Второе дело запасного — список: любой сбой `list` отвечает этому одному запросу он же, без переключения
   * (спека хранилища 6.4).
   */
  fallback?: ToolRunner;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Строка диагностики в stderr процесса MCP (stdout занят протоколом). Агент видит только текст отказа, а тому, кто
 * разбирается, почему процессы MCP ушли читать базу напрямую или не достучались до хоста, нужна эта строка: без неё хост с
 * неверным маршрутом молча вернул бы их к прямому чтению (спека хранилища 6.4, 6.5). Аргументы вызова и токен в неё не попадают.
 */
const note = (text: string): void => {
  process.stderr.write(`parley-mcp: ${text}\n`);
};

/** Ответ хоста на один запрос: статус и тело. */
interface Reply {
  status: number;
  text: string;
}

/**
 * Один запрос. Не `fetch`: у глобального `fetch` (undici) срок ожидания заголовков ответа — 300 с, и более долгий
 * `wait_for` (по умолчанию он ждёт десять минут) он обрывал бы сам, хотя хост ждёт и сигнал вызывающего позволяет.
 * Хост же отменяет вызов, когда соединение закрыто, поэтому переспросить тот же `callId` после обрыва нельзя — соединение
 * должно жить, пока хост не ответит. `node:http` сроков не ставит: их держит `signal`. Соединение — на один запрос
 * (`agent: false`): повторно использованный сокет, который хост как раз закрывает, давал бы ложные обрывы.
 * Перенаправлений `node:http` не выполняет (у `fetch` это `redirect: 'error'`): 3xx приходит обычным статусом и кончается
 * отказом, а токен сессии не уходит на другой адрес.
 */
function post(url: URL, token: string, payload: string, signal: AbortSignal): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
        // Хост оборвал ответ посередине: `end` не придёт, только `close` с неполным ответом.
        res.on('close', () => {
          if (!res.complete) reject(new Error('the connection closed before the answer was complete'));
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Что осталось от обмена: поле `result` ответа хоста или текст для агента. `missingRoute` — хост ответил 404, то есть
 * маршрута у него нет (приёмник хуков так отвечает на любой неизвестный путь): по нему включается запасной исполнитель.
 */
type Answer = { result: Record<string, unknown> } | { text: string; missingRoute?: true };

/** Ответ хоста, который повторять не нужно: статус и конверт `{ ok, result | error }`. */
function answerOf(reply: Reply): Answer {
  if (reply.status === 401) return { text: SESSION_LINK_EXPIRED };
  if (reply.status === 413) return { text: ARGUMENTS_TOO_LARGE };
  if (reply.status === 404) return { text: hostRefused(404), missingRoute: true };
  if (reply.status !== 200) return { text: hostRefused(reply.status) };
  let body: unknown;
  try {
    body = JSON.parse(reply.text);
  } catch {
    return { text: UNREADABLE_ANSWER };
  }
  if (!isRecord(body)) return { text: UNREADABLE_ANSWER };
  if (body['ok'] === true && isRecord(body['result'])) return { result: body['result'] };
  const error = body['error'];
  if (body['ok'] === false && isRecord(error) && typeof error['message'] === 'string' && error['message'] !== '') {
    return { text: error['message'] };
  }
  return { text: UNREADABLE_ANSWER };
}

/**
 * Срок одного запроса `call`. `wait_for` держит запрос, пока хост ждёт, — до `timeoutSec` (как и в самом инструменте,
 * не больше потолка) и ещё запас. Кривой `timeoutSec` срок не ломает: хост сам вернёт агенту отказ по аргументу.
 */
function requestTimeoutMs(name: string, args: Record<string, unknown>, callTimeoutMs: number): number {
  if (name !== 'wait_for') return callTimeoutMs;
  const seconds = args['timeoutSec'];
  return waitTimeoutMs(typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : undefined) + WAIT_SLACK_MS;
}

/**
 * Исполнитель, который пересылает `list` и `call` хосту сессии (спека хранилища 6.3). Хост ждёт токен канала агента и
 * по нему узнаёт сессию. Повторы (6.4): обрыв, срок запроса и ответы 502/503/504 повторяются с нарастающей паузой, пока
 * окно с первой неудачи вызова укладывается в `retryBudgetMs`; дальше агент получает честное «хост не отвечает». Повтор
 * несёт тот же `callId`, так что потерянный ответ не удваивает запись. Отказы 401 и 413 и ответы, которых хост не даёт,
 * не повторяются: повтор ничего не изменил бы. Отмена вызывающим (`signal`) обрывает запрос и ожидание сразу, без повтора.
 * Буфера писем в этом процессе нет: письмо отправлено, только когда хост подтвердил. Хост без маршрута (404) при
 * заданном `options.fallback` уступает место запасному исполнителю до конца процесса (спека хранилища 6.5); любой иной
 * сбой `list` при нём отвечает запасной разово (6.4). О переходе на запасной и о запросе, кончившемся «хост не
 * отвечает», процесс пишет строку в stderr (`parley-mcp: …`).
 */
export function createRemoteToolRunner(agent: AgentChannel, launch: ToolLaunch, options: RemoteToolOptions = {}): ToolRunner {
  const retryBudgetMs = options.retryBudgetMs ?? RETRY_BUDGET_MS;
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const { fallback } = options;
  const url = new URL(AGENT_TOOLS_PATH, agent.url);
  // Запасной исполнитель, к которому перешли после 404; пока `null` — всё идёт к хосту.
  let direct: ToolRunner | null = null;

  /** Ответ — 404 и запасной задан: переходим на него насовсем и отдаём его, чтобы он ответил и на этот вызов. */
  function switchToFallback(answer: Answer): ToolRunner | null {
    if (fallback === undefined || !('text' in answer) || answer.missingRoute !== true) return null;
    // Вызовы, ждавшие ответа вместе, получают 404 все сразу: строка нужна одна на процесс, от первого.
    if (direct === null) note(`the host has no ${AGENT_TOOLS_PATH} route (HTTP 404); reading the map directly for the rest of this process`);
    direct = fallback;
    return fallback;
  }

  async function exchange(body: RemoteToolRequest, timeoutMs: number, signal?: AbortSignal): Promise<Answer> {
    const payload = JSON.stringify(body);
    // Хост такое тело не примет, а оборванное им соединение выглядело бы сбоем сети и повторялось: отказываем до запроса.
    if (Buffer.byteLength(payload, 'utf8') > AGENT_TOOLS_REQUEST_BYTES) return { text: ARGUMENTS_TOO_LARGE };
    let firstFailure: number | null = null;
    for (let failures = 0; ; failures += 1) {
      if (signal?.aborted) return { text: CANCELLED };
      const timeout = AbortSignal.timeout(Math.ceil(timeoutMs));
      let reply: Reply | null;
      try {
        reply = await post(url, agent.token, payload, signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
      } catch {
        // Отмена вызывающего — не неудача хоста; всё остальное (сеть, срок запроса, обрыв) — неудача.
        if (signal?.aborted) return { text: CANCELLED };
        reply = null;
      }
      if (reply !== null && !RETRY_STATUSES.has(reply.status)) return answerOf(reply);
      const now = performance.now();
      firstFailure ??= now;
      const pause = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)] ?? 0;
      if (now - firstFailure + pause > retryBudgetMs) {
        note(`Parley host is not responding to ${body.op === 'call' ? `call ${body.name}` : 'list'}: gave up after ${failures + 1} attempts`);
        return { text: HOST_NOT_RESPONDING };
      }
      try {
        await sleep(pause, undefined, signal === undefined ? undefined : { signal });
      } catch {
        return { text: CANCELLED };
      }
    }
  }

  return {
    async list(): Promise<Tool[]> {
      if (direct !== null) return direct.list();
      const answer = await exchange({ op: 'list', launch }, LIST_TIMEOUT_MS);
      const local = switchToFallback(answer);
      if (local !== null) return local.list();
      const tools = 'text' in answer ? undefined : answer.result['tools'];
      if (Array.isArray(tools)) return tools as Tool[];
      // Список — не вызов: клиент просит его при подключении, а `listChanged` сервер не объявляет, так что один сбой
      // (хост занят, сеть, 401, 5xx после окна повторов, нечитаемый ответ) мог бы оставить агента без инструментов
      // Parley на всю сессию. Набор у местного исполнителя тот же, поэтому этому запросу отвечает он, не переключаясь на
      // прямой путь: вызовы по-прежнему идут хосту, и при его молчании агент получает честный отказ (спека хранилища 6.4).
      if (fallback !== undefined) return fallback.list();
      // Списку отвечать результатом с `isError` нечем: отказ идёт ошибкой протокола с тем же текстом.
      throw new Error('text' in answer ? answer.text : UNREADABLE_ANSWER);
    },
    async call(name, args, meta, signal): Promise<CallToolResult> {
      if (direct !== null) return direct.call(name, args, meta, signal);
      const callId = randomUUID();
      const answer = await exchange(
        { op: 'call', launch, name, args, ...(meta === undefined ? {} : { meta }), callId },
        requestTimeoutMs(name, args, callTimeoutMs),
        signal,
      );
      const local = switchToFallback(answer);
      if (local !== null) return local.call(name, args, meta, signal);
      if ('text' in answer) return failure(answer.text);
      return Array.isArray(answer.result['content']) ? (answer.result as unknown as CallToolResult) : failure(UNREADABLE_ANSWER);
    },
  };
}

// ----- Code Mode: the remote-only caller (plan T5b1) -----
//
// A separate client for Code Mode's broker. It shares the route, token, envelope and retry statuses with the classic
// runner above, which stays unchanged, but it has no fallback at all (a host without the route is never answered by a
// local runner), reads every answer under a byte cap, and reports a typed outcome instead of agent text. Only a
// complete HTTP 200 whose body parses strictly into exactly `{ ok: true, result }`, with `result` a valid MCP
// `CallToolResult`, settles a call. A 200 that cannot be read as one (cut by the cap, or a complete body that is not a result) is
// `unread`: the answering attempt is done, which says nothing about earlier attempts, and nothing is known about what the body said. Every other outcome after the
// first attempt left the process is `unknown` (it may have executed). `observedBytes` are the response-body bytes actually read on every attempt, never a re-serialized size.

/** Why a call's outcome is unknown. */
export type UnknownWhy =
  | '401' | '404' | '413' | `status:${number}` | 'route-refusal' | 'unreadable' | 'invalid-result'
  | 'body-over-cap' | 'gave-up' | 'aborted' | 'retry-not-authorized';

/**
 * Why a 200 was not read as a result: the response was cut by this caller's own cap, or its complete body is not a result.
 * The host writes its 200 only after the attempt that answered has no work outstanding (`/agent/tools` `reply`; a test on the
 * real endpoint pins the order). Two limits, so that a method with an effect does not inherit this: a 200 does not prove the
 * handler ran (a refused request also answers 200), and an earlier attempt can still be running if its replay record was
 * evicted. This is a fact for the caller's owner to weigh; the Code Mode broker accepts it for read effects only.
 */
export type UnreadWhy = 'body-over-cap' | 'route-refusal' | 'unreadable' | 'invalid-result';

/**
 * `not-dispatched`: the host has no tools route (spec §5.2, "Code Mode treats host 404 as unavailable"). Its endpoint never answers 404
 * itself, so a 404 means the route is absent and the call never reached a tool. That proves nothing about an EARLIER attempt (a reset after
 * the body left, then a host without the route): so only a 404 that answers attempt 1 is `not-dispatched`; a 404 after any retry stays
 * `unknown('404')` (s-296 m-7463, lead m-7464).
 */
export type RemoteOutcome =
  | { readonly kind: 'ok' | 'tool-error'; readonly text: string; readonly observedBytes: number; readonly attempts: number }
  /**
   * `runBudgetCut` is present (true) only on a `body-over-cap` whose cap was the run's remaining response budget, not this caller's
   * per-call ceiling: typed evidence for the run's own diagnostic, never inferred from `why` alone.
   */
  | { readonly kind: 'unread'; readonly why: UnreadWhy; readonly observedBytes: number; readonly attempts: number; readonly runBudgetCut?: true }
  | { readonly kind: 'not-dispatched'; readonly why: '404'; readonly observedBytes: number; readonly attempts: 1 }
  | { readonly kind: 'unknown'; readonly why: UnknownWhy; readonly observedBytes: number; readonly attempts: number };

/** The exact request body of one call, built before dispatch (frozen). */
export interface PreparedCall { readonly body: string; readonly bytes: number }

export interface SendOptions {
  /** Aborted at the run deadline or by the caller; stops pauses and sends at once. */
  readonly signal: AbortSignal;
  /** The run's remaining raw byte budget (settled bytes), read at every attempt. */
  remainingRaw(): number;
  /** Asked before every retry (never before attempt 1); false stops with `retry-not-authorized`. */
  beforeRetry(): boolean;
  /** Retry window from the start of `send`. */
  readonly retryBudgetMs: number;
}

export interface ListOutcome { readonly ok: boolean; readonly why: UnknownWhy | null; readonly observedBytes: number }

export interface RemoteOnlyCaller {
  /** Pure and synchronous: builds the exact body `{op:'call', launch, name, args, meta?, callId}`. Nothing is sent. */
  prepare(name: string, args: unknown, meta: unknown): PreparedCall | { readonly refused: 'too-large' };
  /** Sends attempt 1 synchronously (before any await), then retries 502/503/504 and network failures. */
  send(call: PreparedCall, options: SendOptions): Promise<RemoteOutcome>;
  /** One `list` attempt read under `cap` bytes: the preflight. Its bytes are reported, not charged to a call. */
  list(options: { readonly signal: AbortSignal; readonly cap: number }): Promise<ListOutcome>;
}

/** Test-only timing; production uses the classic runner's delays and timeouts. */
export interface RemoteOnlyOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly callTimeoutMs?: number;
  readonly listTimeoutMs?: number;
}

/** A call's cumulative read cap never exceeds this (the run response budget, `RUN_LIMITS.responseBytes`). */
export const REMOTE_ONLY_MAX_CALL_BYTES = 1024 * 1024;

/** The `ToolLaunch` fields and their checks. Null prototype: `constructor`, `toString` and the like are not fields. */
const LAUNCH_KEYS: Readonly<Record<string, (v: unknown) => boolean>> = Object.freeze(Object.assign(Object.create(null) as Record<string, (v: unknown) => boolean>, {
  skillNavigator: (v: unknown) => typeof v === 'boolean',
  skillListReduced: (v: unknown) => typeof v === 'boolean',
  nativeContextRevision: (v: unknown) => typeof v === 'string',
  // Forwarded exactly: the host keys the session's one tool slot on it, and its agent fence compares it with the map.
  // Never empty from `launchOf`: `contextFromEnv` drops an empty variable.
  agentRevision: (v: unknown) => typeof v === 'string' && v !== '',
  toolProfile: (v: unknown) => v === 'short',
}));

/**
 * Plain JSON data only: null, booleans, strings, finite numbers, arrays and plain objects (prototype Object or null) of
 * own enumerable data properties with string keys, no proxies, no cycles, depth at most 64, and no `toJSON` reachable
 * on any object or array, own or inherited (a polluted `Object.prototype.toJSON` would rewrite what `JSON.stringify`
 * emits, so such input is refused). The broker passes values that already crossed strict validation; this keeps
 * `JSON.stringify` exact for anything else.
 */
function plainJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return false;
  if ('toJSON' in value) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return false; // the indices plus `length`
    for (let i = 0; i < value.length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      if (d === undefined || !('value' in d) || !plainJson(d.value, depth + 1)) return false;
    }
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || key === 'toJSON' || key === '__proto__' || !d.enumerable || !('value' in d) || !plainJson(d.value, depth + 1)) return false;
  }
  return true;
}

/** The strict JSON module (code-mode/validation.ts) is loaded lazily so a classic session never loads it. */
let strictJson: Promise<typeof import('./code-mode/validation.js')> | null = null;
const loadStrictJson = (): Promise<typeof import('./code-mode/validation.js')> => (strictJson ??= import('./code-mode/validation.js'));
const RESPONSE_LIMITS = Object.freeze({ maxBytes: REMOTE_ONLY_MAX_CALL_BYTES, maxDepth: 64, maxNodes: 1_000_000 });

/** One attempt read under a cap: the body when complete, or what is known when it is not. */
type Attempt =
  | { readonly kind: 'reply'; readonly status: number; readonly body: Buffer; readonly bytes: number }
  | { readonly kind: 'truncated'; readonly status: number; readonly bytes: number }
  | { readonly kind: 'failed'; readonly bytes: number };

/**
 * Like `post` above, but the body is counted as it arrives: once more than `cap` bytes were read, the request is
 * destroyed and nothing more is buffered. Never rejects; a network failure, timeout or abort is `failed` with the bytes
 * read so far. The request is created synchronously.
 */
function postBounded(url: URL, token: string, payload: string, signal: AbortSignal, cap: number): Promise<Attempt> {
  return new Promise<Attempt>((resolve) => {
    let bytes = 0;
    let done = false;
    const finish = (a: Attempt): void => { if (!done) { done = true; resolve(a); } };
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > cap) {
            chunks.length = 0;
            finish({ kind: 'truncated', status, bytes });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish({ kind: 'reply', status, body: Buffer.concat(chunks), bytes }));
        res.on('error', () => finish({ kind: 'failed', bytes }));
        res.on('close', () => { if (!res.complete) finish({ kind: 'failed', bytes }); });
      },
    );
    req.on('error', () => finish({ kind: 'failed', bytes }));
    req.end(payload);
  });
}

/** The parsed envelope of a complete 200 body, strictly: `{ ok: true, result: <object> }` and nothing else. */
async function envelopeOf(body: Buffer): Promise<{ result: Record<string, unknown> } | 'route-refusal' | 'unreadable'> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return 'unreadable'; }
  let parsed: unknown;
  try {
    const { parseStrictJson } = await loadStrictJson();
    parsed = parseStrictJson(text, RESPONSE_LIMITS);
  } catch { return 'unreadable'; }
  if (!isRecord(parsed)) return 'unreadable';
  if (parsed['ok'] === false) return 'route-refusal';
  const keys = Object.keys(parsed);
  if (parsed['ok'] !== true || keys.length !== 2 || !keys.includes('result') || !isRecord(parsed['result'])) return 'unreadable';
  return { result: parsed['result'] };
}

/**
 * The Code Mode broker's caller (plan T5b1). `agent` and `launch` are copied, checked and frozen once; the launch JSON is
 * serialized once and reused byte for byte. There is no fallback runner: a 404 is never a switch to reading the map in this process. It is
 * `not-dispatched` when it answers attempt 1, and `unknown` after any retry.
 */
export function createRemoteOnlyCaller(agent: AgentChannel, launch: ToolLaunch, options: RemoteOnlyOptions = {}): RemoteOnlyCaller {
  if (!isRecord(agent) || typeof agent.url !== 'string' || typeof agent.token !== 'string' || agent.token === '') throw new TypeError('remote-only caller: invalid agent channel');
  let url: URL;
  try { url = new URL(AGENT_TOOLS_PATH, agent.url); } catch { throw new TypeError('remote-only caller: invalid agent channel'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('remote-only caller: invalid agent channel');
  const token = agent.token;
  if (!isRecord(launch) || !plainJson(launch)) throw new TypeError('remote-only caller: invalid launch');
  // Own keys only, into a null-prototype snapshot: nothing inherited is read, and no inherited serializer hook can reach
  // the copy when it is turned into JSON.
  if (Object.keys(launch).some((k) => !Object.hasOwn(LAUNCH_KEYS, k))) throw new TypeError('remote-only caller: invalid launch');
  const launchCopy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(LAUNCH_KEYS)) {
    if (!Object.hasOwn(launch, key)) continue;
    const v = (launch as Record<string, unknown>)[key];
    if (!LAUNCH_KEYS[key]!(v)) throw new TypeError('remote-only caller: invalid launch');
    launchCopy[key] = v;
  }
  const launchJson = JSON.stringify(Object.freeze(launchCopy));
  const retryDelaysMs = [...(options.retryDelaysMs ?? RETRY_DELAYS_MS)];
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const listTimeoutMs = options.listTimeoutMs ?? LIST_TIMEOUT_MS;
  // Start loading the strict parser now, so the first answer does not wait for it.
  void loadStrictJson().catch(() => undefined);
  // Prepared calls of THIS caller that have not been sent yet: a prepared call is single-use and cannot cross callers.
  const unsent = new WeakSet<PreparedCall>();

  const attemptSignal = (signal: AbortSignal, ms: number): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(ms))]);
  const fixed = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

  return Object.freeze({
    prepare(name: string, args: unknown, meta: unknown): PreparedCall | { readonly refused: 'too-large' } {
      if (typeof name !== 'string' || name === '' || !isRecord(args) || !plainJson(args) || (meta !== undefined && (!isRecord(meta) || !plainJson(meta)))) {
        throw new TypeError('remote-only caller: prepare needs a name, plain JSON object arguments and optional plain JSON meta');
      }
      const body = `{"op":"call","launch":${launchJson},"name":${JSON.stringify(name)},"args":${JSON.stringify(args)}${meta === undefined ? '' : `,"meta":${JSON.stringify(meta)}`},"callId":${JSON.stringify(randomUUID())}}`;
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > AGENT_TOOLS_REQUEST_BYTES) return Object.freeze({ refused: 'too-large' as const });
      const prepared: PreparedCall = Object.freeze({ body, bytes });
      unsent.add(prepared);
      return prepared;
    },

    send(call: PreparedCall, o: SendOptions): Promise<RemoteOutcome> {
      // Consumed before attempt 1: a second send, or a call prepared by another caller, is refused and sends nothing.
      if (typeof call !== 'object' || call === null || !unsent.delete(call)) throw new TypeError('remote-only caller: not an unsent prepared call of this caller');
      const started = performance.now();
      const remaining = (): number => { try { return fixed(o.remainingRaw()); } catch { return 0; } };
      const budgetMs = fixed(o.retryBudgetMs);
      const startRemaining = remaining();
      const callCap = Math.min(REMOTE_ONLY_MAX_CALL_BYTES, startRemaining);
      // Whether the cap of the latest attempt was set by the run budget (below the per-call ceiling) and not by the ceiling itself; set by `nextCap`.
      let runBound = false;
      let observed = 0;
      let attempts = 0;
      const unknown = (why: UnknownWhy): RemoteOutcome => Object.freeze({ kind: 'unknown', why, observedBytes: observed, attempts });
      const unread = (why: UnreadWhy): RemoteOutcome => Object.freeze({ kind: 'unread', why, observedBytes: observed, attempts, ...(why === 'body-over-cap' && runBound ? { runBudgetCut: true as const } : {}) });
      /** The byte cap of the next attempt: what the call may still read. Runs the `remainingRaw` callback. */
      const nextCap = (): number => {
        const now = remaining();
        runBound = Math.min(startRemaining, now) < REMOTE_ONLY_MAX_CALL_BYTES;
        return Math.max(0, Math.min(callCap, now) - observed);
      };
      /** Sends one attempt with a cap computed BEFORE the final checks; no callback runs between them and the request. */
      const attempt = (cap: number): Promise<Attempt> => {
        attempts += 1;
        return postBounded(url, token, call.body, attemptSignal(o.signal, callTimeoutMs), cap);
      };
      // Attempt 1 leaves synchronously: nothing awaits between the caller's dispatch and this request. A zero cap means
      // no answer could be read at all, so nothing is sent.
      const firstCap = nextCap();
      const first: Promise<Attempt> | 'aborted' | 'no-cap' = o.signal.aborted ? 'aborted' : firstCap <= 0 ? 'no-cap' : attempt(firstCap);
      return (async () => {
        if (first === 'aborted') return unknown('aborted');
        if (first === 'no-cap') return unknown('body-over-cap');
        let reply = await first;
        for (let failures = 0; ; failures += 1) {
          observed += reply.bytes;
          if (reply.kind === 'truncated') return reply.status === 200 ? unread('body-over-cap') : unknown('body-over-cap');
          const retryable = reply.kind === 'failed' || RETRY_STATUSES.has(reply.status);
          if (!retryable) break;
          if (o.signal.aborted) return unknown('aborted');
          const pause = retryDelaysMs[Math.min(failures, retryDelaysMs.length - 1)] ?? 0;
          if (performance.now() - started + pause > budgetMs) return unknown('gave-up');
          try { await sleep(pause, undefined, { signal: o.signal }); } catch { return unknown('aborted'); }
          // Before every retry: first all callback work (re-authorization, then the remaining budget), THEN the final
          // monotonic window and signal checks immediately before the request, with the cap computed above.
          let allowed = false;
          try { allowed = o.beforeRetry() === true; } catch { allowed = false; }
          const cap = nextCap();
          if (o.signal.aborted) return unknown('aborted');
          if (performance.now() - started > budgetMs) return unknown('gave-up');
          if (!allowed) return unknown('retry-not-authorized');
          if (cap <= 0) return unknown('body-over-cap');
          reply = await attempt(cap);
        }
        if (reply.kind !== 'reply') return unknown('gave-up');
        // A missing route answering the first and only attempt: nothing reached a tool. After any retry it proves nothing about the earlier ones.
        if (reply.status === 404 && attempts === 1) return Object.freeze({ kind: 'not-dispatched', why: '404', observedBytes: observed, attempts: 1 });
        if (reply.status === 401 || reply.status === 404 || reply.status === 413) return unknown(String(reply.status) as '401' | '404' | '413');
        if (reply.status !== 200) return unknown(`status:${reply.status}`);
        const env = await envelopeOf(reply.body);
        if (env === 'route-refusal' || env === 'unreadable') return unread(env);
        const result = env.result;
        if (!Array.isArray(result['content']) || !CallToolResultSchema.safeParse(result).success) return unread('invalid-result');
        let text: string;
        try {
          const { serializeStrict } = await loadStrictJson();
          text = serializeStrict(result, RESPONSE_LIMITS);
        } catch { return unread('invalid-result'); }
        return Object.freeze({ kind: result['isError'] === true ? 'tool-error' : 'ok', text, observedBytes: observed, attempts });
      })();
    },

    async list(o: { readonly signal: AbortSignal; readonly cap: number }): Promise<ListOutcome> {
      const no = (why: UnknownWhy, bytes: number): ListOutcome => Object.freeze({ ok: false, why, observedBytes: bytes });
      if (o.signal.aborted) return no('aborted', 0);
      const reply = await postBounded(url, token, `{"op":"list","launch":${launchJson}}`, attemptSignal(o.signal, listTimeoutMs), Math.min(REMOTE_ONLY_MAX_CALL_BYTES, fixed(o.cap)));
      if (reply.kind === 'truncated') return no('body-over-cap', reply.bytes);
      if (reply.kind === 'failed') return no(o.signal.aborted ? 'aborted' : 'gave-up', reply.bytes);
      if (reply.status !== 200) return no(reply.status === 401 || reply.status === 404 || reply.status === 413 ? (String(reply.status) as '401' | '404' | '413') : `status:${reply.status}`, reply.bytes);
      const env = await envelopeOf(reply.body);
      if (env === 'route-refusal' || env === 'unreadable') return no(env, reply.bytes);
      if (!Array.isArray(env.result['tools'])) return no('invalid-result', reply.bytes);
      return Object.freeze({ ok: true, why: null, observedBytes: reply.bytes });
    },
  });
}
