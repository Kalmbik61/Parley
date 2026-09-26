import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Request,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_CONFIG } from '../config.js';
import { commandInPath, loadProviders } from '../providers.js';
import { agentDirs, assertAgent } from '../work/agents.js';
import { writeBrief } from '../work/brief.js';
import { GUIDE } from '../work/guide.js';
import { unreadFor } from '../work/letters.js';
import { addMessage, addSession, transitionSession } from '../work/map.js';
import { finishSession } from '../work/metrics.js';
import { addRoom, isDescendant, isMember, joinNotice } from '../work/rooms.js';
import { displayStatus } from '../work/status-view.js';
import { readMap, updateMap, workPaths } from '../work/store.js';
import { participantLabel } from '../work/thread.js';
import {
  MESSAGE_KINDS,
  type Artifact,
  type Message,
  type Room,
  type WorkMap,
  type WorkSession,
} from '../work/types.js';
import type { McpContext } from './context.js';
import { watchInbox, type Ring } from './inbox-watch.js';
import { waitForMap } from './watch-map.js';

/** Таймаут `wait_for` по умолчанию — десять минут (спецификация, раздел 4). */
export const DEFAULT_TIMEOUT_SEC = 600;

/** Верхний предел: у MCP-клиентов есть свой лимит на длительность вызова. */
export const MAX_TIMEOUT_SEC = 30 * 60;

/** Как часто перечитывать карту, когда `fs.watch` промолчал. */
const POLL_MS = 2000;

/**
 * Состояние, на котором `wait_for` перестаёт ждать (спецификация 7.1): у цели
 * есть итог или процесса больше нет — ушла в `sleeping` или `closed`. `null` —
 * цель ещё работает.
 */
function finishedState(session: WorkSession): string | null {
  if (session.result !== null) return session.result;
  return session.lifecycle === 'sleeping' || session.lifecycle === 'closed'
    ? session.lifecycle
    : null;
}

/** Скользящий час для окна писем (разговор агентов, 4.7, решение D20). */
export const RATE_WINDOW_MS = 60 * 60 * 1000;

export function waitTimeoutMs(timeoutSec: number | undefined): number {
  const seconds = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.max(seconds, 0), MAX_TIMEOUT_SEC) * 1000;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`аргумент ${name} обязателен и должен быть непустой строкой`);
  }
  return value;
}

function enumArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = stringArg(args, name);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`аргумент ${name}: ожидалось одно из ${allowed.join(' | ')}, пришло ${value}`);
  }
  return value as T;
}

function stringsArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`аргумент ${name}: ожидался массив строк`);
  }
  return value as string[];
}

/**
 * `to` у `send_message`: одна строка (как раньше) или массив — обе формы
 * приходят от клиентов агентов, а `send_message` без `room` всё равно требует
 * ровно одного адресата после разбора.
 */
function toArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  throw new Error(`аргумент ${name}: ожидалась строка или массив строк`);
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | null {
  return args[name] === undefined ? null : stringArg(args, name);
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`аргумент ${name}: ожидалось число`);
  }
  return value;
}

/**
 * Артефакт — файл внутри проекта, и путь к нему в карте всегда относительный
 * (спецификация, раздел 8): карту читают другие сессии и TUI, абсолютный путь
 * с чужой машины им бесполезен, а выход за корень проекта — просто ошибка.
 */
function artifactsArg(args: Record<string, unknown>): Artifact[] {
  const value = args['artifacts'];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('аргумент artifacts: ожидался массив {kind, path}');

  return value.map((item) => {
    if (!isRecord(item) || typeof item['kind'] !== 'string' || typeof item['path'] !== 'string') {
      throw new Error('аргумент artifacts: каждый элемент — объект {kind, path}');
    }
    const file = item['path'];
    if (file === '') throw new Error('путь артефакта пуст');
    if (path.isAbsolute(file)) {
      throw new Error(`путь артефакта ${file}: нужен относительный корню проекта`);
    }
    const normalized = path.normalize(file);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`путь артефакта ${file} ведёт за пределы проекта`);
    }
    return { kind: item['kind'], path: file };
  });
}

function requireSession(map: WorkMap, sessionId: string): WorkSession {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`сессии ${sessionId} нет в карте`);
  return session;
}

function requireRoom(map: WorkMap, roomId: string): Room {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`комнаты ${roomId} нет в карте`);
  return room;
}

/** Сессия существует и не закрыта — иначе письмо доставлять некому (спецификация 6.2). */
function assertDeliverable(map: WorkMap, sessionId: string): void {
  const session = requireSession(map, sessionId);
  if (session.lifecycle === 'closed') throw new Error(`сессия ${sessionId} закрыта`);
}

/** Письмо в ответе агенту: комната и подпись отправителя — не только id (спецификация 6.2). */
const messageView = (message: Message, map: WorkMap) => {
  const room = message.roomId === null ? null : (map.rooms.find((r) => r.id === message.roomId) ?? null);
  return {
    id: message.id,
    from: message.from,
    fromLabel: participantLabel(map, message.from),
    at: message.at,
    text: message.text,
    kind: message.kind,
    room: room === null ? null : { id: room.id, title: room.title },
  };
};

/**
 * Окно писем (разговор агентов, 4.7): два вежливых агента способны отвечать
 * друг другу, пока не кончится лимит подписки, поэтому сервер считает письма
 * этой сессии за последний час по всей карте. Скользящий час отличает петлю от
 * честной долгой работы и восстанавливается сам; состояния нет — всё в карте.
 */
function assertRate(map: WorkMap, sessionId: string, limit: number, now: number): void {
  const recent = map.messages.filter(
    (message) => message.from === sessionId && now - Date.parse(message.at) < RATE_WINDOW_MS,
  ).length;
  if (recent >= limit) {
    throw new Error(
      `слишком часто: ${recent} писем за час от этой сессии (лимит ${limit}); отчитайся report и обратись к человеку`,
    );
  }
}

const TOOLS: Tool[] = [
  {
    name: 'get_map',
    description:
      'Карта работы целиком: сессии, их статусы, резюме и артефакты, сообщения — плюс список провайдеров реестра с флагом доступности в PATH. Вызови первым делом; подробный гид — инструмент read_guide',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'report',
    description:
      'Отчёт о своей сессии. done или failed — финал работы, progress — промежуточное резюме без смены статуса. Повторный вызов перезаписывает резюме и артефакты.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'failed', 'progress'] },
        summary: { type: 'string', description: 'Резюме результата в двух-трёх фразах.' },
        artifacts: {
          type: 'array',
          description: 'Файлы результата; путь — относительно корня проекта.',
          items: {
            type: 'object',
            properties: { kind: { type: 'string' }, path: { type: 'string' } },
            required: ['kind', 'path'],
          },
        },
      },
      required: ['status', 'summary'],
    },
  },
  {
    name: 'spawn_session',
    description:
      'Создаёт сессию другого агента в этой же работе: проверяет провайдера по реестру и наличие команды в PATH, собирает бриф и заводит запись pending. Запустит её харнесс.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Id провайдера из get_map.' },
        label: { type: 'string', description: 'Роль сессии: «план», «бэкенд», «ревью».' },
        task: { type: 'string', description: 'Что новой сессии сделать.' },
        contextFrom: {
          type: 'array',
          description: 'Id сессий, чьи резюме и артефакты попадут в бриф.',
          items: { type: 'string' },
        },
        agent: {
          type: 'string',
          description:
            'Роль сессии — агент Claude Code: имя файла .claude/agents/<name>.md проекта или ~/.claude/agents/<name>.md. Определение с урезанным списком tools обязано включать mcp__harnas__*, иначе роль не сможет ни написать коллеге, ни отчитаться.',
        },
      },
      required: ['provider', 'label', 'task'],
    },
  },
  {
    name: 'wait_for',
    description:
      'Ждёт завершения сессии (target — её id) или входящего сообщения (target = "inbox"). По таймауту возвращает {"state":"running"} — решай сам, звать ли снова. {"state":"deleted"} значит, что сессию удалил человек: ждать больше нечего.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Id сессии или "inbox".' },
        timeoutSec: {
          type: 'number',
          description: `Сколько ждать; по умолчанию ${DEFAULT_TIMEOUT_SEC}, максимум ${MAX_TIMEOUT_SEC}.`,
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'send_message',
    description:
      'Кладёт сообщение в переписку. Без room — ровно одному адресату работы, как раньше. С room — отправитель и адресаты обязаны быть участниками комнаты; пустой или отсутствующий to — рассылка всем участникам. Отвечай только на question: заметка и решение ответа не требуют.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          description:
            'Id адресата или несколько сразу. Без room — ровно один; с room и без to — рассылка комнате.',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        text: { type: 'string' },
        kind: {
          type: 'string',
          enum: [...MESSAGE_KINDS],
          description:
            'question — жду ответа; decision — договорились; note — заметка (по умолчанию).',
        },
        room: { type: 'string', description: 'Id комнаты из get_map; без него письмо прямое.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'check_inbox',
    description:
      'Отдаёт непрочитанные письма этой сессии — прямые и из её комнат, включая рассылки — и помечает их прочитанными. У каждого письма — подпись отправителя и комната, если она есть.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_room',
    description:
      'Заводит комнату — постоянный круг переписки для нескольких сессий. Вызывающий становится создателем и участником; остальным участникам уходит письмо о добавлении.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        members: {
          type: 'array',
          description: 'Id сессий-участников из get_map; себя указывать не нужно.',
          items: { type: 'string' },
        },
      },
      required: ['title', 'members'],
    },
  },
  {
    name: 'read_room',
    description:
      'Лента комнаты для контекста — последние limit писем, без пометок прочтения. Доступна только участникам.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Id комнаты из get_map.' },
        limit: { type: 'number', description: 'Сколько последних писем отдать; по умолчанию 50.' },
      },
      required: ['room'],
    },
  },
  {
    name: 'close_session',
    description:
      'Закрывает сессию насовсем: письма ей больше не приходят, будильник её не поднимает. Цель — сама сессия или её потомок. Зови только после явного согласия человека.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Id сессии: своей или порождённой по цепочке.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'read_guide',
    description:
      'Подробный гид по харнессу: сущности, жизненный цикл сессии, что класть в отчёт и артефакты, как ждать подчинённую сессию, чего не делать. Читай, когда коротких описаний не хватило.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function getMap(context: McpContext): Promise<unknown> {
  const registry = await loadProviders();
  const providers = await Promise.all(
    Object.values(registry).map(async (entry) => ({
      id: entry.id,
      label: entry.label,
      available: await commandInPath(entry.runner.command),
    })),
  );
  return {
    sessionId: context.sessionId,
    map: await readMap(context.projectPath, context.workId),
    providers,
  };
}

async function report(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const status = enumArg(args, 'status', ['done', 'failed', 'progress'] as const);
  const summary = stringArg(args, 'summary');
  const artifacts = artifactsArg(args);

  // Резюме пишем до смены статуса: ждущий `wait_for` просыпается на статусе и
  // должен увидеть уже готовое резюме, а не пустое поле.
  let map = await updateMap(context.projectPath, context.workId, (current) => {
    const session = requireSession(current, sessionId);
    // Закрытая сессия ничего больше не сдаёт (спецификация 7.1) — проверяем
    // раньше записи резюме, иначе progress на закрытой тихо прошёл бы мимо.
    if (session.lifecycle === 'closed') {
      throw new Error(`сессия ${sessionId} закрыта: report не принят`);
    }
    session.summary = summary;
    session.summarySource = 'agent';
    session.artifacts = artifacts;
  });
  if (status !== 'progress') {
    // Итоговые метрики в карту фиксирует общий код жизненного цикла.
    map = await finishSession(context.projectPath, context.workId, sessionId, status);
  }

  const session = requireSession(map, sessionId);
  return {
    sessionId,
    // Ответ прежней формы: сданный итог виден сразу, даже у сессии, которую
    // харнесс ещё не отметил запущенной.
    status: session.result ?? displayStatus(session),
    summary: session.summary,
    artifacts: session.artifacts,
  };
}

async function spawnSession(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const provider = stringArg(args, 'provider');
  const label = stringArg(args, 'label');
  const task = stringArg(args, 'task');
  const contextFrom = stringsArg(args, 'contextFrom');
  // Роль необязательна: без неё сессия идёт обычным агентом провайдера.
  const agent = args['agent'] === undefined ? null : stringArg(args, 'agent');

  const registry = await loadProviders();
  const entry = registry[provider];
  if (entry === undefined) {
    throw new Error(
      `неизвестный провайдер ${provider}; допустимы: ${Object.keys(registry).join(', ')}`,
    );
  }
  if (!(await commandInPath(entry.runner.command))) {
    throw new Error(
      `команды ${entry.runner.command} нет в PATH — провайдер ${provider} недоступен`,
    );
  }

  // Роль проверяем до записи: `pending`, который нечем запустить, — мусор в
  // карте (спецификация 2026-09-08, раздел 7).
  if (agent !== null) {
    if (!(entry.runner.args ?? []).includes('{agent}')) {
      throw new Error(`провайдер ${provider} агентов не принимает`);
    }
    await assertAgent(agent, agentDirs(context.projectPath));
  }

  let created = '';
  const map = await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, sessionId);
    for (const id of contextFrom) requireSession(current, id);
    created = addSession(current, {
      provider,
      label,
      task,
      parent: sessionId,
      contextFrom,
      agent,
    }).id;
  });
  await writeBrief(context.projectPath, map, created);
  return { sessionId: created };
}

async function waitFor(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const target = stringArg(args, 'target');
  const timeoutMs = waitTimeoutMs(numberArg(args, 'timeoutSec'));
  const read = (): Promise<WorkMap> => readMap(context.projectPath, context.workId);

  let probe: () => Promise<unknown | null>;
  if (target === 'inbox') {
    probe = async () => {
      const map = await read();
      const messages = unreadFor(map, sessionId);
      return messages.length === 0
        ? null
        : { state: 'message', messages: messages.map((message) => messageView(message, map)) };
    };
  } else {
    // Первая проба идёт до всякого ожидания, поэтому неизвестный id падает
    // ошибкой сразу — ожидания не возникает (спецификация, раздел 8). Сессию,
    // удалённую человеком, от опечатки отличает `deletedSessions`: по ней ответ
    // `deleted`, а не ошибка (план от 2026-09-06, раздел C).
    let existed = false;
    probe = async () => {
      const map = await read();
      if ((map.work.deletedSessions ?? []).includes(target)) {
        return { state: 'deleted', sessionId: target };
      }
      const found = map.sessions.find((candidate) => candidate.id === target);
      // Запись исчезла из карты, но следа удаления нет — карту правили мимо
      // харнесса; ждать всё равно нечего, и ответ тот же.
      if (found === undefined && existed) return { state: 'deleted', sessionId: target };
      const session = requireSession(map, target);
      existed = true;
      const state = finishedState(session);
      return state !== null
        ? {
            state,
            sessionId: target,
            summary: session.summary,
            artifacts: session.artifacts,
          }
        : null;
    };
  }

  const found = await waitForMap(
    workPaths(context.projectPath, context.workId).map,
    probe,
    timeoutMs,
    context.pollMs ?? POLL_MS,
  );
  return found ?? { state: 'running' };
}

async function sendMessage(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const to = toArg(args, 'to');
  const text = stringArg(args, 'text');
  const kind = args['kind'] === undefined ? 'note' : enumArg(args, 'kind', MESSAGE_KINDS);
  const roomId = optionalStringArg(args, 'room');

  let created = '';
  await updateMap(context.projectPath, context.workId, (current) => {
    // Отправителя проверяем наравне с получателем: сервер удалённой сессии ещё
    // жив, и без проверки в карту легло бы письмо от несуществующего адресата,
    // ответить на которое нечем (план от 2026-09-06, раздел C).
    requireSession(current, sessionId);
    assertRate(current, sessionId, context.messageRate ?? DEFAULT_CONFIG.messageRate, Date.now());

    if (roomId !== null) {
      const room = requireRoom(current, roomId);
      if (!isMember(room, sessionId)) {
        throw new Error(`сессия ${sessionId} не участник комнаты ${roomId}`);
      }
      for (const memberId of to) {
        if (!isMember(room, memberId)) {
          throw new Error(`сессия ${memberId} не участник комнаты ${roomId}`);
        }
        assertDeliverable(current, memberId);
      }
      // Пустой to в комнате — рассылка всем участникам (recipientsOf её и разберёт).
      created = addMessage(current, { from: sessionId, to, text, kind, roomId }).id;
    } else {
      if (to.length !== 1) {
        throw new Error('без room нужен ровно один адресат в to');
      }
      const target = to[0] as string;
      assertDeliverable(current, target);
      created = addMessage(current, { from: sessionId, to: [target], text, kind }).id;
    }
  });
  return { messageId: created };
}

async function checkInbox(context: McpContext, sessionId: string): Promise<unknown> {
  let messages: Message[] = [];
  const at = new Date().toISOString();
  const map = await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, sessionId);
    const inbox = unreadFor(current, sessionId);
    messages = inbox.map((message) => ({ ...message }));
    for (const message of inbox) message.readBy[sessionId] = at;
  });
  return { messages: messages.map((message) => messageView(message, map)) };
}

async function createRoom(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const title = stringArg(args, 'title');
  const membersInput = stringsArg(args, 'members');

  let roomId = '';
  await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, sessionId);
    // Повторы схлопнуты, себя в список участников не добавляем — создатель и
    // так участник (спецификация 6.1).
    const members = [...new Set(membersInput)].filter((id) => id !== sessionId);
    for (const memberId of members) {
      const member = requireSession(current, memberId);
      if (member.lifecycle === 'closed') {
        throw new Error(`сессия ${memberId} закрыта: в комнату не добавить`);
      }
    }

    const room = addRoom(current, { title, creator: sessionId, members });
    roomId = room.id;
    const notice = joinNotice(room, current);
    for (const memberId of members) {
      addMessage(current, { from: sessionId, to: [memberId], roomId: room.id, kind: 'note', text: notice });
    }
  });
  return { roomId };
}

async function readRoom(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const roomId = stringArg(args, 'room');
  const limit = numberArg(args, 'limit') ?? 50;

  const map = await readMap(context.projectPath, context.workId);
  const room = requireRoom(map, roomId);
  if (!isMember(room, sessionId)) {
    throw new Error(`сессия ${sessionId} не участник комнаты ${roomId}`);
  }

  const inRoom = map.messages
    .filter((message) => message.roomId === roomId)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-limit);
  return { messages: inRoom.map((message) => messageView(message, map)) };
}

async function closeSession(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const target = stringArg(args, 'target');

  await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, target);
    if (target !== sessionId && !isDescendant(current, sessionId, target)) {
      throw new Error(
        `сессия ${target} не подчинена ${sessionId}: close_session закрывает только себя или потомка`,
      );
    }
    transitionSession(current, target, 'closed');
  });
  return { sessionId: target };
}

const NO_SESSION =
  'сессия не задана (HARNAS_SESSION_ID пуст): доступны только get_map и read_guide. Создай сессию через харнесс или `harnas-core work session new` — тогда работают остальные инструменты.';

async function dispatch(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'get_map') return getMap(context);
  // Гид не про конкретную сессию: он доступен и без `HARNAS_SESSION_ID`.
  if (name === 'read_guide') return GUIDE;

  const { sessionId } = context;
  if (sessionId === null) throw new Error(NO_SESSION);

  if (name === 'report') return report(context, sessionId, args);
  if (name === 'spawn_session') return spawnSession(context, sessionId, args);
  if (name === 'wait_for') return waitFor(context, sessionId, args);
  if (name === 'send_message') return sendMessage(context, sessionId, args);
  if (name === 'check_inbox') return checkInbox(context, sessionId);
  if (name === 'create_room') return createRoom(context, sessionId, args);
  if (name === 'read_room') return readRoom(context, sessionId, args);
  if (name === 'close_session') return closeSession(context, sessionId, args);
  throw new Error(`неизвестный инструмент ${name}`);
}

/**
 * Что агент должен знать про звонок (разговор агентов, 4.5). Текст доставляется
 * при подключении, поэтому он короткий и весь про поведение: этикет тут —
 * половина защиты от переписки двух вежливых агентов до конца лимита (4.7).
 */
export const CHANNEL_INSTRUCTIONS = `Письма коллег по этой работе объявляются тегом <channel source="harnas">: в нём from — id сессии-отправителя, from_label — её роль, kind — вид письма. Текста письма в теге нет: увидел тег — позови check_inbox, он отдаст все непрочитанные разом.
Отвечай send_message(to=<from>) только на \`question\`; note и decision ответа не требуют, «спасибо» и «принято» не пишут. Договорённость фиксируй одним письмом с kind: decision тому, с кем договорился.
Про письмо звонят один раз; check_inbox и wait_for("inbox") — страховка, если канал молчит.`;

/**
 * Уведомление-звонок. Метода нет в `ServerNotification`, поэтому он объявляется
 * генериком `Server`: так `notification` проверяется по типу, а не гасится
 * приведением.
 */
type ChannelNotification = {
  method: 'notifications/claude/channel';
  params: Ring;
};

/**
 * MCP-сервер одной сессии. Ошибки инструментов возвращаются агенту результатом
 * с `isError`, а не протокольным отказом: клиенту нужно не падение вызова, а
 * текст, из которого понятно, что поправить.
 */
export function createHarnasServer(context: McpContext): Server<Request, ChannelNotification> {
  // Сессии нет — звонить некому: сервер без `HARNAS_SESSION_ID` умеет только
  // отдавать карту и гид (4.2).
  const { sessionId } = context;
  const channel = context.channel && sessionId !== null;
  const server = new Server<Request, ChannelNotification>(
    { name: 'harnas', version: '0.0.0' },
    {
      capabilities: channel ? { tools: {}, experimental: { 'claude/channel': {} } } : { tools: {} },
      ...(channel ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
    },
  );

  if (channel) {
    let stop: (() => void) | null = null;
    // Сторож стартует после `initialized`: до него клиент уведомления не ждёт.
    server.oninitialized = () => {
      stop = watchInbox(
        { ...context, sessionId },
        {
          pollMs: context.pollMs ?? POLL_MS,
          notify: (ring) =>
            server.notification({ method: 'notifications/claude/channel', params: ring }),
        },
      );
    };
    // Транспорт закрыт — звонить больше некуда, и цикл не должен держать процесс.
    server.onclose = () => stop?.();
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = isRecord(request.params.arguments) ? request.params.arguments : {};
    try {
      const result = await dispatch(context, request.params.name, args);
      // Гид — готовый текст: заворачивать его в JSON-строку с экранированием
      // значило бы отдать агенту документ, который ему же и разбирать.
      const text = typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`;
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
    }
  });

  return server;
}
