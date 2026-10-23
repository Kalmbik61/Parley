import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_TOOLS_REQUEST_BYTES,
  createToolRunner,
  type McpContext,
  type RemoteToolRequest,
  type RemoteToolResponse,
  type ToolLaunch,
  type ToolRunner,
} from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';

/**
 * Сколько после конца вызова хост помнит его результат по `callId` (спека хранилища 6.4): клиент повторяет запрос с тем же
 * `callId`, когда потерял ответ, и должен получить сохранённый результат, а не второе исполнение записи.
 */
export const CALL_REPLAY_TTL_MS = 10 * 60_000;

/** Сколько вызовов на сессию хост помнит; сверх этого первым забывается самый давний. */
export const CALL_REPLAY_LIMIT = 256;

/** `callId` клиента — UUID; длиннее хост не принимает: ключи держатся в памяти до десяти минут. */
const CALL_ID_MAX_CHARS = 128;

/**
 * Инструменты, которые получают отмену и кончают ожидание сами: в core сигнал передаётся только им (`dispatch`). Исход
 * «отменено» хранить незачем, повторить их безопасно. Остальные отмены не видят и доходят до конца, поэтому запись о них —
 * ключ идемпотентности: повтор после оборванного запроса получает тот же вызов, а не второе исполнение записи
 * (спека хранилища 6.4). Появится в core другой инструмент с сигналом — его имя добавляется сюда.
 */
const CANCELLABLE_TOOLS: ReadonlySet<string> = new Set(['wait_for', 'get_map']);

type CallResult = Awaited<ReturnType<ToolRunner['call']>>;

/** Вызов в памяти сессии: его результат и когда он кончился; от конца отсчитывается срок памяти. */
interface CallRecord {
  result: Promise<CallResult>;
  /** `null` — вызов ещё идёт: пока он идёт, он не устаревает. */
  settledAt: number | null;
}

/** Исполнитель одной сессии и память её вызовов. */
interface SessionTools {
  /** Снимок запуска, для которого собран исполнитель: другой снимок — другой исполнитель. */
  launchKey: string;
  runner: Promise<ToolRunner>;
  calls: Map<string, CallRecord>;
}

/** Запрос неверной формы: отказ маршрута `bad_request`, а не ошибка инструмента. */
class BadRequest extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Снимок запуска из тела запроса. Берутся только четыре известных поля нужных типов: остальное (чужие поля, которыми
 * запрос мог бы подменить сессию или канал) в контекст исполнителя не попадает.
 */
function parseLaunch(value: unknown): ToolLaunch {
  if (!isRecord(value)) throw new BadRequest('launch must be an object.');
  const launch: ToolLaunch = {};
  for (const key of ['skillNavigator', 'skillListReduced'] as const) {
    const flag = value[key];
    if (flag === undefined) continue;
    if (typeof flag !== 'boolean') throw new BadRequest(`launch.${key} must be a boolean.`);
    launch[key] = flag;
  }
  const revision = value['nativeContextRevision'];
  if (revision !== undefined) {
    if (typeof revision !== 'string') throw new BadRequest('launch.nativeContextRevision must be a string.');
    launch.nativeContextRevision = revision;
  }
  const profile = value['toolProfile'];
  if (profile !== undefined) {
    if (profile !== 'short') throw new BadRequest('launch.toolProfile must be "short".');
    launch.toolProfile = profile;
  }
  return launch;
}

function parseRequest(text: string): RemoteToolRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest('The request body is not JSON.');
  }
  if (!isRecord(body)) throw new BadRequest('The request body must be a JSON object.');
  const launch = parseLaunch(body['launch']);
  if (body['op'] === 'list') return { op: 'list', launch };
  if (body['op'] !== 'call') throw new BadRequest('op must be "list" or "call".');
  const name = body['name'];
  const args = body['args'];
  const meta = body['meta'];
  const callId = body['callId'];
  if (typeof name !== 'string' || name === '') throw new BadRequest('name must be a nonempty string.');
  if (!isRecord(args)) throw new BadRequest('args must be an object.');
  if (meta !== undefined && !isRecord(meta)) throw new BadRequest('meta must be an object.');
  if (typeof callId !== 'string' || callId === '' || callId.length > CALL_ID_MAX_CHARS) {
    throw new BadRequest(`callId must be a string of 1 to ${CALL_ID_MAX_CHARS} characters.`);
  }
  return { op: 'call', launch, name, args, ...(meta === undefined ? {} : { meta }), callId };
}

/** Сбой самого исполнителя (его `call` ошибок не бросает) — ошибка инструмента, как и любая другая. */
const toolFailure = (error: unknown): CallResult => ({
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  isError: true,
});

/**
 * Маршрут `POST /agent/tools` на сервере хуков (спека хранилища 6.3, 6.4, 6.9, этап 1): агент не открывает карту сам, а
 * пересылает `tools/list` и `tools/call` хосту (`createRemoteToolRunner` в core), и хост исполняет их тем же
 * `createToolRunner` в своём процессе — карту пишет только он. Токен — тот же, что у `/agent/sessions`: сессию (проект,
 * работу, сессию) задаёт он, а не тело запроса.
 *
 * Ответы. Нет токена — 401, тело больше `AGENT_TOOLS_REQUEST_BYTES` — 413, и то и другое без тела. Всё остальное — 200 и
 * конверт `{ ok, result | error }`: ошибка самого инструмента едет внутри `result` (`isError`), `ok: false` — отказ
 * маршрута (`bad_request` для неверной формы, `internal` для сбоя хоста). Никогда не 404: клиент читает 404 как «у этого
 * хоста нет маршрута» и навсегда уходит на прямое чтение карты (6.5).
 *
 * Исполнитель создаётся на сессию и живёт, пока снимок запуска (`launch`) тот же; новый снимок — новый исполнитель.
 *
 * Повтор (6.4): вызов с уже виденным `callId` отдаёт тот же результат — и идущему, и законченному. Запоминание — на
 * `CALL_REPLAY_TTL_MS` после конца вызова, не больше `CALL_REPLAY_LIMIT` на сессию. Исключение — `wait_for` и `get_map`,
 * которые шли, когда клиент закрыл соединение: они видят отмену, их запись снимается, и повтор с тем же `callId`
 * исполняется заново, а не получает исход «отменено». Остальные инструменты отмены не видят и доходят до конца: их запись
 * остаётся, и повтор после оборванного запроса присоединяется к идущему вызову, не исполняя запись второй раз.
 */
export function createToolsEndpoint(options: {
  authenticate(req: IncomingMessage): SessionRef | undefined;
  contextFor(ref: SessionRef, launch: ToolLaunch): Promise<McpContext>;
  now?: () => number;
}): { handle(req: IncomingMessage, res: ServerResponse): void; forget(ref: SessionRef): void } {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionTools>();

  function toolsOf(ref: SessionRef, launch: ToolLaunch): SessionTools {
    const key = refKey(ref);
    const launchKey = JSON.stringify([launch.skillNavigator, launch.skillListReduced, launch.nativeContextRevision, launch.toolProfile]);
    const known = sessions.get(key);
    if (known !== undefined && known.launchKey === launchKey) return known;
    const created: SessionTools = {
      launchKey,
      runner: options.contextFor(ref, launch).then(createToolRunner),
      calls: new Map(),
    };
    // Не собрался — запись не держится: следующий запрос попробует снова, а не получит тот же отказ.
    created.runner.catch(() => {
      if (sessions.get(key) === created) sessions.delete(key);
    });
    sessions.set(key, created);
    return created;
  }

  /** Вызов по `callId`: виденный отдаёт тот же результат, новый запускается. */
  function callOf(
    tools: SessionTools,
    runner: ToolRunner,
    request: Extract<RemoteToolRequest, { op: 'call' }>,
    controller: AbortController,
  ): CallRecord {
    const at = now();
    const known = tools.calls.get(request.callId);
    if (known !== undefined) {
      if (known.settledAt === null || at - known.settledAt < CALL_REPLAY_TTL_MS) return known;
      tools.calls.delete(request.callId);
    }
    // Срок и потолок проверяются при записи нового вызова: отдельного таймера у памяти нет.
    for (const [callId, record] of tools.calls) {
      if (record.settledAt !== null && at - record.settledAt >= CALL_REPLAY_TTL_MS) tools.calls.delete(callId);
    }
    for (const callId of tools.calls.keys()) {
      if (tools.calls.size < CALL_REPLAY_LIMIT) break;
      tools.calls.delete(callId);
    }
    const record: CallRecord = {
      settledAt: null,
      result: runner.call(request.name, request.args, request.meta, controller.signal).then(
        (result) => {
          record.settledAt = now();
          return result;
        },
        (error: unknown) => {
          record.settledAt = now();
          return toolFailure(error);
        },
      ),
    };
    // Клиент ушёл, пока шёл вызов, который видит отмену: его исход «отменено» читать некому, и под `callId` он не остаётся
    // (повтор исполнится заново). Законченный вызов остаётся: ответ потерян, но результат настоящий. Вызов, не видящий
    // отмены, остаётся и пока идёт: повтор присоединится к нему.
    if (CANCELLABLE_TOOLS.has(request.name)) {
      controller.signal.addEventListener(
        'abort',
        () => {
          if (record.settledAt === null && tools.calls.get(request.callId) === record) tools.calls.delete(request.callId);
        },
        { once: true },
      );
    }
    tools.calls.set(request.callId, record);
    return record;
  }

  return {
    handle(req, res) {
      /** Отказ без тела; соединение закрывается, недочитанное тело дальше не читается. */
      const refuse = (status: number): void => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(status, { Connection: 'close' });
          res.end();
        }
        req.resume();
      };
      const reply = (body: RemoteToolResponse): void => {
        if (res.writableEnded || res.destroyed) return;
        // Токен могли снять, пока вызов шёл: ответ без права на него не уходит (как у соседних маршрутов).
        if (options.authenticate(req) === undefined) return refuse(401);
        const text = JSON.stringify(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(text);
      };

      const ref = options.authenticate(req);
      if (ref === undefined) return refuse(401);
      if (Number(req.headers['content-length'] ?? 0) > AGENT_TOOLS_REQUEST_BYTES) return refuse(413);

      // Клиент закрыл соединение, не дождавшись ответа (агент прервал ход, срок запроса вышел): его вызов отменяется.
      // `res`, а не `req`: `req` закрывается сразу после чтения тела (Node 22), а не с уходом клиента.
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > AGENT_TOOLS_REQUEST_BYTES) {
          rejected = true;
          chunks.length = 0;
          refuse(413);
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        rejected = true;
      });
      req.on('end', () => {
        if (rejected) return;
        void (async () => {
          try {
            if (options.authenticate(req) === undefined) return refuse(401);
            const request = parseRequest(Buffer.concat(chunks, size).toString('utf8'));
            const tools = toolsOf(ref, request.launch);
            const runner = await tools.runner;
            // Клиент ушёл, пока собирался исполнитель: начинать вызов, ответ на который некому прочесть, незачем.
            if (controller.signal.aborted) return;
            if (request.op === 'list') return reply({ ok: true, result: { tools: await runner.list() } });
            return reply({ ok: true, result: await callOf(tools, runner, request, controller).result });
          } catch (error) {
            reply({
              ok: false,
              error: { code: error instanceof BadRequest ? 'bad_request' : 'internal', message: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
      });
    },
    forget(ref) {
      sessions.delete(refKey(ref));
    },
  };
}
