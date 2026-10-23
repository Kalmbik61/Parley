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
  toolProfile?: ToolProfile;
}

/** Из контекста сервера — только поля запуска, и только заданные: лишнего хосту не уходит. */
export function launchOf(context: McpContext): ToolLaunch {
  return {
    ...(context.skillNavigator === undefined ? {} : { skillNavigator: context.skillNavigator }),
    ...(context.skillListReduced === undefined ? {} : { skillListReduced: context.skillListReduced }),
    ...(context.nativeContextRevision === undefined ? {} : { nativeContextRevision: context.nativeContextRevision }),
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
   * работающего канала остаётся на прямом пути, пока карта — `map.json`). Ответ 404 значит хост прежней сборки: так бывает
   * сразу после обновления, когда хост ещё старый и запускает сессии, а сервер MCP на диске уже новый. Первый такой ответ
   * на `list` или `call` переключает исполнителя до конца процесса: этот вызов и все следующие идут в запасной. Не задан —
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
 * разбирается, почему процессы MCP ушли к `map.json` или не достучались до хоста, нужна эта строка: без неё хост с
 * неверным маршрутом молча вернул бы их к карте (спека хранилища 6.4, 6.5). Аргументы вызова и токен в неё не попадают.
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
