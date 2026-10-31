import { realpath, stat } from 'node:fs/promises';
import { AGENT_PLAN_TOOL, publishAgentPlan } from './agent-plan-tool.js';
import { homedir } from 'node:os';
import { claudeProjectRoots } from '../discover.js';
import { readClaudeSkillCatalog } from '../skills/claude-listing.js';
import { readCodexSkillCatalog } from '../skills/context.js';
import { searchSkills } from '../skills/search.js';
import type { SkillCatalog } from '../skills/catalog.js';
import { nativeContextMatches, readNativeContext, readNativeSkillCatalog } from '../work/native-context.js';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Request,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_CONFIG, loadConfig } from '../config.js';
import { MCP_SERVER_NAME } from '../names.js';
import {
  claudeConfigDirFor,
  isClaudeCode,
  providerReadiness,
  loadProviders,
  selectableModels,
  supportsEffort,
} from '../providers.js';
import { roleSummaries, sessionRoleCatalog } from '../work/agents.js';
import { inboxFenced } from '../work/auto-sleep.js';
import { LEAD_ROLE, memberRole } from '../work/brief.js';
import { CONTEXT_LIMITS, FIND_SKILL_MAX_BYTES, LETTER_MAX_CHARS, LETTER_SOFT_CHARS, READ_GUIDE_MAX_BYTES, boundResponse, contextBytes, markedExcerpt } from '../work/context-budget.js';
import {
  LETTER_PAGE_MAX_ITEMS,
  PAGE_MAX_BYTES,
  PAGE_MIN_BYTES,
  PageError,
  clampPageBytes,
  listPage,
  mapTopology,
  messagePage,
  pageBySeq,
  parseCursor,
  seqOf,
  textPage,
  mapOverview,
  topologyListPage,
  TOPOLOGY_FIELDS,
  type TopologyField,
} from '../work/context-pages.js';
import { settleDelayMs } from '../work/delivery.js';
import { guide, GUIDE_TOPICS, guideTopic } from '../work/guide.js';
import { storeLetterReader, unreadLetters, writeLetters, type LetterReads } from '../work/letter-store.js';
import { recipientsOf } from '../work/letters.js';
import { isCodexThreadBinding, transitionSession } from '../work/map.js';
import { readBacklog } from '../work/backlog.js';
import { listBacklogSuggestions, suggestBacklog } from '../work/backlog-suggestions.js';
import { rememberProjectMemory } from '../work/memory-suggestions.js';
import { HISTORY_SCOPES, HistorySearchError, MAX_SEARCH_LIMIT, searchHistory } from '../work/history-search.js';
import type { HistoryScope } from '../work/history-search.js';
import { readProjectMemory } from '../work/project-memory.js';
import type { MemoryKind } from '../work/project-memory.js';
import { readProjectPreferences } from '../work/project-preferences.js';
import { finishSession } from '../work/metrics.js';
import { SHORT_PROFILE_HIDDEN_TOOLS } from '../work/mcp-config.js';
import { PROPOSAL_TEXT_MAX } from '../work/proposals.js';
import {
  assertMessageBudget,
  countRecipients,
  deniedForAgent,
  limitsFromConfig,
  RESOURCE_WINDOW_MS,
  ResourceDeniedError,
  type ResourceLimits,
} from '../work/resource-policy.js';
import { capacityReport, type CapacityReport } from '../work/capacity-report.js';
import { PLAN_DRAFT_SCHEMA, PLAN_TOOLS, isPlanTool, planTool } from './plan-tools.js';
import { AGENT_SWITCH_UNAVAILABLE, CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL, SESSION_CREATION_UNAVAILABLE, createSession, requestAgentSwitch } from './session-tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL, SWARM_UNAVAILABLE, createSwarm, swarmAdd } from './swarm-tools.js';
import { fetchProviderRows } from './provider-rows.js';
import { addMemberByLead, addRoom, canReadRoom, isCreatedDescendant, isMember, isRoomArchived, joinNotice, leaveOtherRooms, liveLead, requireOpenRoom } from '../work/rooms.js';
import { agentStatus, asleepHint } from '../work/session-state.js';
import { swarmOfSession } from '../work/swarms.js';
import { stuckHint, stuckWarning } from '../work/stuck.js';
import { SharedStateError, inspectSharedIgnore, readMap, readWorksIndex, sharedProjectPaths, updateMap, viewMap, workVersionKey } from '../work/store.js';
import { participantLabel, sessionMention, agentLetterAudience, agentLetterVisible } from '../work/thread.js';
import {
  HUMAN,
  MESSAGE_KINDS,
  SYSTEM,
  type Artifact,
  type Message,
  type Room,
  type WorkMap,
  type WorkSession,
} from '../work/types.js';
import { BROWSER_UNAVAILABLE, createBrowserTools } from './browser-tools.js';
import type { McpContext } from './context.js';
import { watchInbox, type Ring } from './inbox-watch.js';
import { waitForMap } from './watch-map.js';

/** Таймаут `wait_for` по умолчанию — десять минут (спецификация, раздел 4). */
export const DEFAULT_TIMEOUT_SEC = 600;

/** Верхний предел: у MCP-клиентов есть свой лимит на длительность вызова. */
export const MAX_TIMEOUT_SEC = 30 * 60;

/** Как часто сверять версию работы в базе: карта перечитывается, только когда версия сменилась (спека хранилища 6.9). */
const POLL_MS = 2000;

/**
 * Запас к сроку окна тишины в `wait_for("inbox")`: таймер Node может сработать на миллисекунду раньше часов, и цикл вошёл бы
 * в новое ожидание с остатком в 1–2 мс. Ожидание всё равно не уходит за таймаут вызова.
 */
const SETTLE_SLACK_MS = 20;

/**
 * Состояние, на котором `wait_for` перестаёт ждать (спецификация 7.1): у цели
 * есть итог, она ждёт человека (`stuck`: спека застрявших 5.3 — итога ещё нет, но и ждать её незачем) или
 * процесса больше нет — ушла в `sleeping` или `closed`. Усыплённая хостом (`autoSleep`) — `asleep`: она не кончила
 * и не умерла, письмо её поднимет (спека сна агентов 4.1). `null` — цель ещё работает. Идёт замена агента (спека
 * передачи сессии 6.2) — тоже работает: между остановкой прежнего агента и стартом нового сессия `sleeping`, а
 * `stuck` снят, но работа у неё не кончилась. Цель в очереди машины (`queued`, спека ёмкости 4.2) тоже работает: процесса
 * ещё нет, но запуск начнётся сам, и `wait_for` ждёт её, как работающую. Итог и `stuck` отвечают раньше очереди.
 */
export function finishedState(session: WorkSession): string | null {
  if ((session.switching ?? null) !== null) return null;
  if (session.result !== null) return session.result;
  if ((session.stuck ?? null) !== null) return 'stuck';
  if (session.queued != null && session.lifecycle !== 'closed') return null;
  if (session.lifecycle === 'sleeping' && session.autoSleep != null) return 'asleep';
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
    throw new Error(`argument ${name} is required and must be a non-empty string`);
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
    throw new Error(`argument ${name}: expected one of ${allowed.join(' | ')}, got ${value}`);
  }
  return value as T;
}

function stringsArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`argument ${name}: expected an array of strings`);
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
  throw new Error(`argument ${name}: expected a string or an array of strings`);
}

/**
 * Необязательная строка: нет поля или `null` — `null`. Часть клиентов заполняет все поля схемы и шлёт `null`
 * вместо пропуска; ошибка «is required» на необязательном поле толкала бы агента выдумать значение (ревью 0.3.0).
 */
function optionalStringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return value === undefined || value === null ? null : stringArg(args, name);
}

function numberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`argument ${name}: expected a number`);
  }
  return value;
}

/**
 * Артефакт — файл внутри проекта, и путь к нему в карте всегда относительный
 * (спецификация, раздел 8): карту читают другие сессии и окно, абсолютный путь
 * с чужой машины им бесполезен, а выход за корень проекта — просто ошибка.
 */
function artifactsArg(args: Record<string, unknown>): Artifact[] {
  const value = args['artifacts'];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('argument artifacts: expected an array of {kind, path}');

  return value.map((item) => {
    if (!isRecord(item) || typeof item['kind'] !== 'string' || typeof item['path'] !== 'string') {
      throw new Error('argument artifacts: each element is an object {kind, path}');
    }
    const file = item['path'];
    if (file === '') throw new Error('artifact path is empty');
    if (path.isAbsolute(file)) {
      throw new Error(`artifact path ${file}: must be relative to the project root`);
    }
    const normalized = path.normalize(file);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error(`artifact path ${file} leads outside the project`);
    }
    return { kind: item['kind'], path: file };
  });
}

function requireSession(map: WorkMap, sessionId: string): WorkSession {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`session ${sessionId} is not in the map`);
  return session;
}

function requireRoom(map: WorkMap, roomId: string): Room {
  const room = map.rooms.find((candidate) => candidate.id === roomId);
  if (room === undefined) throw new Error(`room ${roomId} is not in the map`);
  return room;
}

/** Сессия существует и не закрыта — иначе письмо доставлять некому (спецификация 6.2). */
function assertDeliverable(map: WorkMap, sessionId: string): void {
  const session = requireSession(map, sessionId);
  if (session.lifecycle === 'closed') throw new Error(`session ${sessionId} is closed`);
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
    // Ответ несёт id сообщения, на которое написан (Parley 0.3.0); у прочих писем ключа нет совсем.
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.via === undefined ? {} : { via: message.via }),
    // Рассылка комнаты (пустой `to`): агент иначе видит письмо без адресата и не отличает «всем» от случайного.
    ...(message.to.length === 0 ? { toEveryone: true } : {}),
  };
};

/**
 * Роль получателя в комнате, когда человек поставил задачу всем: приезжает вместе с письмом. Тихий старт
 * (сессии окна запускаются раньше комнаты) пишет бриф до того, как комната существует, и раздела «Role in
 * the room» в нём нет; а в самом письме не было ни адресата, ни роли — агенты начинали работу параллельно,
 * не дожидаясь ведущего. Роль считаем по живому ведущему (`liveLead`), а не по брифу: она верна и для
 * участника, добавленного позже, и после смены ведущего. Тексты — те же `LEAD_ROLE` и `memberRole`, что в брифе.
 * Нет ведущего (комната закрыта) — `undefined`: роли раздавать некому.
 */
function roomTaskOf(map: WorkMap, message: Message, recipientId: string) {
  if (message.from !== HUMAN || message.roomId === null || message.to.length > 0) return undefined;
  const room = map.rooms.find((candidate) => candidate.id === message.roomId);
  if (room === undefined) return undefined;
  const lead = liveLead(map, room);
  if (lead === null) return undefined;
  const isLead = lead === recipientId;
  return {
    role: isLead ? ('lead' as const) : ('member' as const),
    lead,
    leadLabel: participantLabel(map, lead),
    proposalWaiting: room.proposal !== null,
    hint: isLead ? LEAD_ROLE : memberRole(sessionMention(recipientId)),
  };
}

/** Письмо в ответе `check_inbox` и `wait_for("inbox")`: `messageView` и, для задачи человека всем, `roomTask`. */
const inboxView = (message: Message, map: WorkMap, recipientId: string) => {
  const roomTask = roomTaskOf(map, message, recipientId);
  return { ...messageView(message, map), ...(roomTask === undefined ? {} : { roomTask }) };
};

/**
 * Окно писем (разговор агентов, 4.7): два вежливых агента способны отвечать
 * друг другу, пока не кончится лимит подписки, поэтому сервер считает письма
 * этой сессии за последний час по всем письмам работы. Скользящий час отличает петлю от
 * честной долгой работы и восстанавливается сам; состояния нет — всё в письмах.
 * Час — запрос `count` с `sinceAt`, а не обход ленты (спека хранилища 6.2); письмо ровно часовой давности в окно не входит.
 */
function assertRate(letters: LetterReads, sessionId: string, limit: number, now: number, needed = 1): void {
  const recent = letters.count({ from: sessionId, sinceAt: new Date(now - RATE_WINDOW_MS).toISOString() });
  if (recent + needed > limit) {
    throw new Error(
      `too many messages: ${recent} from this session in the last hour (limit ${limit}); call report and turn to the human`,
    );
  }
}

/**
 * Пороги бюджета для допуска. Настройки читаются заново на каждый допуск, а не при старте сервера: изменение человека
 * в окне действует сразу, а агент остановленный лимит сам расширить не может — у него нет ни инструмента, ни аргумента.
 */
async function limitsOf(context: McpContext): Promise<ResourceLimits> {
  return context.resourceLimits ?? limitsFromConfig((await loadConfig()).config);
}

/**
 * Аннотации MCP (спека комнат, решение 13). По ним клиент решает, спрашивать ли человека перед
 * вызовом инструмента: Codex без аннотаций спрашивает перед каждым (незаданные `destructiveHint` и
 * `openWorldHint` он считает истиной), с ними — только там, где инструмент разрушает. Аннотация —
 * обещание клиенту, поэтому каждая сверена с кодом инструмента, а `annotations.test.ts` держит и
 * таблицу, и то, что обещание правда.
 */
type Annotations = NonNullable<Tool['annotations']>;

/** Чтения — карта, лента комнаты, гид: на диск ничего не пишут, отметок прочтения не ставят. */
const READS: Annotations = { readOnlyHint: true };

/**
 * Записи в карту работы: добавляют сессии, комнаты, письма и отметки прочтения или заменяют своё —
 * резюме отчёта, ждущее решение. Ни одна сессия, комната и письмо из карты не исчезают, а в сеть и
 * в чужие файлы на запись инструмент не выходит. Граница — `add_to_room`: сессия уходит из прежней
 * комнаты (одна комната на сессию) — из её `members`, а если была там ведущим или создателем, то
 * `lead` сбрасывается в `null`, `creator` переходит к человеку. Сама комната, её письма и остальные
 * участники остаются, поэтому и это запись, а не разрушение: `destructiveHint: true` заставил бы
 * Codex спрашивать человека на каждого нового участника комнаты.
 */
const WRITES: Annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** Закрытие сессии насовсем: письма ей больше не приходят, а вернуть её агенту нечем. */
const CLOSES: Annotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/** Список инструментов сервера (без браузерных и `create_session`, их объявляет `createParleyServer`): экспорт нужен тестам, что сверяют по нему примеры слоя. */
export const TOOLS: Tool[] = [
  AGENT_PLAN_TOOL,
  ...PLAN_TOOLS,
  {
    name: 'backlog_list', annotations: READS,
    description: 'Read this project backlog before suggesting work outside your task.',
    inputSchema: { type: 'object', properties: {
      filter: { type: 'string', enum: ['open', 'taken', 'done', 'all'], default: 'open' },
      text: { type: 'string', maxLength: 4096 },
    }, additionalProperties: false },
  },
  {
    name: 'backlog_suggest', annotations: WRITES,
    description: 'Propose one finding outside your task, with a reason. The project rule decides whether it is added or the human is asked.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['bug', 'debt', 'idea'] }, title: { type: 'string', minLength: 1, maxLength: 4096 },
      details: { type: 'string', maxLength: 65536 }, why: { type: 'string', minLength: 1, maxLength: 16384 },
    }, required: ['kind', 'title', 'why'], additionalProperties: false },
  },
  {
    name: 'remember', annotations: WRITES,
    description: 'Propose one lasting project fact, lesson or agreement, with a reason. The human accepts it first, unless they just asked you to remember it: then set onHumanRequest. One short fact per call.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['fact', 'lesson', 'agreement'] }, fact: { type: 'string', minLength: 1, maxLength: 4096 },
      details: { type: 'string', maxLength: 65536 }, why: { type: 'string', minLength: 1, maxLength: 16384 },
      onHumanRequest: { type: 'boolean' },
    }, required: ['kind', 'fact', 'why'], additionalProperties: false },
  },
  {
    name: 'memory_read', annotations: READS,
    description: 'Read the project memory with details: all entries or only the given ids (m-NNN).',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'string', pattern: '^m-\\d{3,}$' }, maxItems: 100 },
    }, additionalProperties: false },
  },
  {
    name: 'search_history', annotations: READS,
    description: "Search this project's past before deciding something big: decisions, memory, plans, backlog, room history, sessions. All query words must meet in one entry.",
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 1000 },
      scope: { type: 'string', enum: [...HISTORY_SCOPES], default: 'all' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: 10 },
    }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'get_map',
    annotations: READS,
    description:
      'The compact workspace map: partial summaries within 48 KiB. Call it first. Lists: field, page.next. The provider catalog comes with field "providers", only before create_session. Details: read_guide.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id; with field — one field of it.' },
        room: { type: 'string' },
        field: {
          type: 'string',
          enum: ['goal', 'title', 'task', 'summary', 'history', 'artifacts', 'contextFrom', 'messages', 'message', 'summaries', 'archive', 'providers', ...TOPOLOGY_FIELDS, 'plan'],
          description: 'task…contextFrom: with session; messages: room pages (no room: direct); message: by id; archive: other workspaces.',
        },
        id: { type: 'string' },
        rev: { type: 'integer', minimum: 0 },
        kind: { type: 'string', enum: [...MESSAGE_KINDS] },
        cursor: { type: 'string', description: '`next` of the previous page.' },
        maxBytes: { type: 'integer', minimum: PAGE_MIN_BYTES, maximum: PAGE_MAX_BYTES, description: 'Page bytes; default 65536.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_capacity',
    annotations: READS,
    description:
      'How busy Parley and this machine are: live, asleep and queued sessions, your child sessions and subagents, the limits that apply and how much of each is used, memory pressure. Call it before starting several sessions or a heavy job.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'report',
    annotations: WRITES,
    description:
      'Report on your own session: done or failed hands in the result (the session stays reachable, not closed); progress is an interim summary. A repeat overwrites the summary and artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'failed', 'progress'] },
        summary: { type: 'string' },
        artifacts: {
          type: 'array',
          description: 'Paths relative to the project root.',
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
    name: 'list_roles', annotations: READS, description: 'List roles (ids for create_session), without prompts or paths.', inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wait_for',
    annotations: WRITES,
    description:
      'Wait for a session to finish (target = its id) or for mail (target = "inbox"); mail comes back marked read, so check_inbox is not needed. Timeout returns {"state":"running"}. {"state":"stuck"}: that session waits for the human or its usage limit — do not wait for it again, Parley writes when it is back. A session that already handed in its report returns the old result at once by id: wait for its answer to a new job via "inbox".',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        timeoutSec: {
          type: 'number',
          description: `Seconds; default ${DEFAULT_TIMEOUT_SEC}, maximum ${MAX_TIMEOUT_SEC}.`,
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'send_message',
    annotations: WRITES,
    description:
      "Send a message: direct to one addressee, or with room to some of the room's participants (no to = all of them). Answer only a question: a note and a decision need no answer. A stuck addressee still gets it; the answer carries a warning.",
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        text: {
          type: 'string',
          maxLength: LETTER_MAX_CHARS,
          description: 'Keep it short; send long content as a file path.',
        },
        kind: {
          type: 'string',
          enum: [...MESSAGE_KINDS],
          description: 'question — answer expected; decision — we agreed; note — default.',
        },
        room: { type: 'string' },
        replyTo: {
          type: 'string',
          description: 'Id of the message in this room that you answer (from check_inbox or read_room): the window quotes it. Only with room.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'check_inbox',
    annotations: WRITES,
    description:
      "Return this session's unread messages (direct and from its rooms) and mark them read.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_room',
    annotations: WRITES,
    description:
      "Create a room you own, with existing working sessions as members and a lead from them. Members leave their other rooms; you join only if you list yourself.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        members: {
          type: 'array',
          description: 'Existing working session ids from get_map.',
          items: { type: 'string' },
        },
        lead: {
          type: 'string',
          description: 'One of members.',
        },
      },
      required: ['title', 'members', 'lead'],
    },
  },
  {
    name: 'add_to_room',
    annotations: WRITES,
    description:
      "Bring another session of this workspace into the room. Lead only. One room per session: it leaves its other rooms and the feed shows \"@s04 joined the room\". The new participant gets no message: tell it in the room what you expect.",
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        session: { type: 'string' },
      },
      required: ['room', 'session'],
    },
  },
  {
    name: 'read_room',
    annotations: READS,
    description:
      "The room's feed for context: the last limit messages, without read marks; `page.next` continues to older ones.",
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        limit: { type: 'number', description: 'How many latest messages; default 50.' },
        cursor: { type: 'string', description: '`next` of the previous page.' },
        maxBytes: { type: 'integer', minimum: PAGE_MIN_BYTES, maximum: PAGE_MAX_BYTES, description: 'Page size in bytes; default 65536.' },
      },
      required: ['room'],
    },
  },
  {
    name: 'propose_decision',
    annotations: WRITES,
    description:
      "The room's lead proposes a decision: a card that waits for the human's answer. Lead only. Call it when positions are collected; do not start work before acceptance. A repeat before the answer replaces the text. The answer arrives as a message.",
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        plan: PLAN_DRAFT_SCHEMA,
        kind: { type: 'string', enum: ['decision', 'completion'] },
        planId: { type: 'string', pattern: '^pl-[0-9]+$', maxLength: 128 },
        rev: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        text: {
          type: 'string',
          description: `Up to ${PROPOSAL_TEXT_MAX} characters: what we do and which part each takes; mention participants as @s02.`,
        },
      },
      required: ['room', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_session',
    annotations: CLOSES,
    description:
      "Close yourself only after the human's explicit consent; ones you created: when accepted.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Yours or one you created.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'read_guide',
    annotations: READS,
    description: 'The detailed Parley guide: rooms and the roles in them (lead, participant), reports, waiting, what not to do. Read it when unsure; topic picks one section.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: GUIDE_TOPICS.map((item) => item.topic),
        },
      },
      additionalProperties: false,
    },
  },
];

/** Подпись к локальным строкам, когда хост не ответил (спека подписок 5.8): вход аккаунтов и лимиты из процесса MCP не видны. */
const HOST_UNREACHABLE_NOTE = 'host unreachable: sign-in state and limits unknown';

async function getMap(context: McpContext, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
  const map = await readMap(context.projectPath, context.workId);
  if (Object.keys(args).length > 0) return mapPage(context, map, args, signal);
  // Плейбук рецепта получает только ведущий (слоем и письмом): в топологии агенту видны id и имя рецепта.
  // Каталог провайдеров в карту не входит: он нужен только при создании сессии и приходит по `field: "providers"`.
  return mapOverview(map, context.sessionId, storeLetterReader(context.projectPath, context.workId));
}

/**
 * `get_capacity`: карта с письмами агентов только за последний час (не вся история), числа машины — от хоста.
 * Один `now` на выборку писем и на расчёт: окно часа в обоих местах одно.
 */
async function getCapacity(context: McpContext, signal?: AbortSignal): Promise<CapacityReport> {
  const now = Date.now();
  const limits = await limitsOf(context);
  const map = await readMap(context.projectPath, context.workId);
  const messages = storeLetterReader(context.projectPath, context.workId).page({
    sinceAt: new Date(now - RESOURCE_WINDOW_MS).toISOString(),
    agentsOnly: true,
    limit: limits.workMessages,
  });
  const facts = (await context.capacity?.(signal)) ?? null;
  return capacityReport({
    map: { ...map, messages },
    sessionId: context.sessionId,
    limits,
    resumeRate: (await loadConfig()).config.resumeRate,
    facts,
    now,
  });
}

/**
 * Каталог провайдеров для `get_map {field: "providers"}`.
 * Строки провайдеров с входом аккаунтов и лимитами отдаёт хост (спека подписок 5.8, К7): процесс MCP не видит ни кэша
 * входа, ни других работ. `needs` (почему недоступен: `sign-in`, `key`, `cli`) и `limits` — только когда известны, чтобы
 * ответ оставался компактным; агент отличает «не вошёл» от «старый CLI» (спека подписок 5.8).
 * Откуда строки (спека хранилища 6.9): `providerRows` — исполнитель в самом хосте, ходить к себе по HTTP незачем; иначе
 * канал агента — запрос к хосту; иначе локальный реестр с пометкой `note`. Заданный `providerRows` — единственный
 * источник: его `null` ведёт к тому же локальному ответу с пометкой.
 */
async function providerCatalog(context: McpContext, signal?: AbortSignal): Promise<{ providers: unknown[]; note?: string }> {
  const rowsSignal = signal ?? new AbortController().signal;
  const hostRows = context.providerRows !== undefined ? await context.providerRows(rowsSignal)
    : context.agent === undefined ? null : await fetchProviderRows(context.agent, rowsSignal);
  if (hostRows !== null) {
    return {
      providers: hostRows.map(({ id, label, family, available, needs, models, effort, limits }) => ({
        id, label, family, available, ...(needs === null ? {} : { needs }), models, effort, ...(limits === null ? {} : { limits }),
      })),
    };
  }
  const registry = await loadProviders();
  const providers = await Promise.all(
    Object.values(registry).map(async (entry) => {
      const readiness = await providerReadiness(entry);
      return {
        id: entry.id,
        label: entry.label,
        available: readiness.needs === null && readiness.error === null,
        // Same launch controls as providers.list, so agents can choose supported models.
        models: selectableModels(entry),
        effort: supportsEffort(entry),
      };
    }),
  );
  return { providers, note: HOST_UNREACHABLE_NOTE };
}

const optionalString = (args: Record<string, unknown>, name: string): string | undefined => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`argument ${name}: expected a string`);
  return value;
};

/** Ограниченные страницы `get_map`: поле, список или письма — по параметрам; без параметров карту отдаёт `getMap`. */
async function mapPage(context: McpContext, map: WorkMap, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const maxBytes = clampPageBytes(numberArg(args, 'maxBytes'));
  const field = optionalString(args, 'field');
  const sessionId = optionalString(args, 'session');
  const roomId = optionalString(args, 'room');
  const cursorRaw = optionalString(args, 'cursor');
  const letters = storeLetterReader(context.projectPath, context.workId);
  try {
    if ((TOPOLOGY_FIELDS as readonly (string | undefined)[]).includes(field)) {
      if (sessionId !== undefined || roomId !== undefined || args['kind'] !== undefined || args['id'] !== undefined || args['rev'] !== undefined)
        throw new PageError('invalid-cursor', 'Collection pages accept only field, cursor and maxBytes; use session or room for detail.');
      return topologyListPage(map, context.sessionId, letters, { field: field as TopologyField, ...(cursorRaw === undefined ? {} : { cursor: cursorRaw }), maxBytes });
    }
    if (field === 'plan') {
      const id = stringArg(args, 'id');
      const rev = args['rev'];
      if (!Number.isSafeInteger(rev) || (rev as number) < 0) throw new PageError('unknown-target', 'field plan requires the exact numeric rev from a plan summary.');
      const plan = map.plans?.find((p) => p.id === id && p.rev === rev);
      if (plan === undefined) throw new PageError('unknown-target', 'Plan id/rev is no longer current; refresh field plans.');
      if (context.sessionId === null || !canReadRoom(requireRoom(map, plan.roomId), context.sessionId))
        throw new PageError('unknown-target', 'Plan detail is not available to this session.');
      return { field, id: plan.id, rev: plan.rev, status: plan.status, format: 'json', ...textPage(JSON.stringify(plan), cursorRaw, maxBytes) };
    }
    if (field === undefined) {
      if (sessionId !== undefined) {
        const session = requireSession(map, sessionId);
        const entry = mapTopology({ ...map, sessions: [session], rooms: [], plans: [] }, context.sessionId, letters).sessions[0];
        return { session: { ...entry, artifacts: session.artifacts.slice(0, 20), history: session.history.slice(-20) } };
      }
      if (roomId !== undefined) {
        const room = requireRoom(map, roomId);
        if (context.sessionId === null || !canReadRoom(room, context.sessionId)) throw new Error(`room ${roomId} is not available to this session`);
        const topology = mapTopology({ ...map, sessions: [], rooms: [room], plans: [] }, context.sessionId, letters).rooms[0];
        const { recipe, recipeLeadNotified, ...rest } = room;
        void recipeLeadNotified;
        // Решение целиком (до 10000 знаков) — здесь, а не в общей топологии.
        return { room: { ...rest, recipe: recipe == null ? null : { id: recipe.id, name: recipe.name } }, messages: topology?.messages };
      }
      throw new Error('give session, room or field; without parameters get_map returns the compact map');
    }
    if (field === 'goal' || field === 'title') return { field, ...textPage(map.work[field], cursorRaw, maxBytes) };
    if (field === 'providers') return providerCatalog(context, signal);
    if (field === 'archive') {
      const index = await readWorksIndex();
      const others = index.works.filter((work) => work.projectPath === context.projectPath && work.id !== context.workId);
      const { items, page } = pageBySeq(others, {
        seq: (work) => seqOf(work.id, 'w-'),
        view: (work) => ({ id: work.id, title: work.title, status: work.status, updatedAt: work.updatedAt }),
        cursor: parseCursor(cursorRaw),
        maxBytes,
      });
      return { workspaces: items, page };
    }
    if (field === 'summaries') {
      const withSummary = map.sessions.filter((session) => session.summary !== null);
      const { items, page } = pageBySeq(withSummary, {
        seq: (session) => seqOf(session.id, 's-'),
        view: (session) => ({ id: session.id, label: session.label, status: agentStatus(session), source: session.summarySource, text: session.summary ?? '' }),
        shrink: (view, limit) => shrinkSummary(view, limit),
        cursor: parseCursor(cursorRaw),
        maxBytes,
      });
      return { summaries: items, page };
    }
    if (field === 'messages' || field === 'message') {
      const caller = context.sessionId;
      if (caller === null) throw new Error(NO_SESSION);
      if (field === 'message') {
        const id = optionalString(args, 'id');
        if (id === undefined) throw new Error('argument id is required for field message');
        const message = letters.byIds([id])[0];
        if (message === undefined || !agentLetterVisible(map, caller)(message)) throw new PageError('unknown-target', `message ${id} is not available to this session`);
        return { id, from: message.from, at: message.at, roomId: message.roomId, ...textPage(message.text, cursorRaw, maxBytes) };
      }
      let filter: ((message: Message) => boolean) | undefined;
      // Прямые письма отбирает предикат видимости одного письма (спека хранилища 6.2): тред целиком не собирается.
      if (roomId === undefined) filter = agentLetterVisible(map, caller);
      else if (!canReadRoom(requireRoom(map, roomId), caller)) throw new Error(`session ${caller} is not a participant of room ${roomId}`);
      const kind = optionalString(args, 'kind');
      if (kind !== undefined && !(MESSAGE_KINDS as readonly string[]).includes(kind)) throw new Error(`argument kind: one of ${MESSAGE_KINDS.join(', ')}`);
      return messagePage(map, {
        roomId: roomId ?? null,
        ...(kind === undefined ? {} : { kind: kind as Message['kind'] }),
        ...(filter === undefined ? {} : { filter, involving: agentLetterAudience(map, caller) }),
        cursor: parseCursor(cursorRaw),
        maxBytes,
        view: (message) => messageView(message, map),
      }, letters);
    }
    // Остальные поля — поля одной сессии.
    if (sessionId === undefined) throw new Error(`field ${field} needs the session argument`);
    const session = requireSession(map, sessionId);
    if (field === 'task') return { session: sessionId, field, ...textPage(session.task, cursorRaw, maxBytes) };
    if (field === 'summary') return { session: sessionId, field, ...textPage(session.summary ?? '', cursorRaw, maxBytes) };
    if (field === 'contextFrom') return { session: sessionId, field, contextFrom: session.contextFrom };
    if (field === 'history') {
      const { items, page } = listPage(session.history, { view: (entry) => entry, cursor: parseCursor(cursorRaw), maxBytes });
      return { session: sessionId, field, history: items, page };
    }
    if (field === 'artifacts') {
      const { items, page } = listPage(session.artifacts, { view: (entry) => entry, cursor: parseCursor(cursorRaw), maxBytes });
      return { session: sessionId, field, artifacts: items, page };
    }
    throw new Error(`unknown field ${field}`);
  } catch (error) {
    // Ошибка запроса страницы — для агента: код и что поправить, без внутренностей.
    if (error instanceof PageError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

/** Резюме в странице `summaries`: длинное сокращается с полным размером — целиком оно читается полем summary. */
function shrinkSummary<V extends { id: string; text: string }>(view: V, limit: number): V & { textBytes: number } {
  const full = Buffer.byteLength(view.text, 'utf8');
  const text = markedExcerpt(view.text, Math.max(256, limit - 1024)).text;
  return { ...view, text: `${text} [read the whole summary: get_map {session: "${view.id}", field: "summary"}]`, textBytes: full };
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
      throw new Error(`session ${sessionId} is closed: report not accepted`);
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
    status: session.result ?? agentStatus(session),
    summary: session.summary,
    artifacts: session.artifacts,
  };
}

/**
 * Строка в журнал событий своей сессии — тот, куда пишут и хуки Claude Code: по `ParleyWaitStart` и
 * `ParleyWaitEnd` хост видит, что агент ждёт в `wait_for`, а не бездействует; случайный `parley_wait_id`
 * связывает начало вызова с его концом: вызовов бывает несколько сразу, а конец брошенного (Esc) вызова
 * приходит позже начала нового. Адрес — как у хука:
 * `<каталог работы>/events/<id сессии>.jsonl`. Одна строка — один `appendFile`: строки параллельных
 * вызовов не перемешиваются. Каталог не создаётся: его отсутствие — признак сессии без хуков, и
 * наши строки не должны заглушать предупреждение хоста.
 *
 * Best-effort: журнал — подсказка окну, а не часть ответа агенту. Сбой записи (нет каталога, диск)
 * ожидание не ломает.
 */
async function noteWait(
  context: McpContext,
  sessionId: string,
  event: Record<string, string>,
): Promise<void> {
  try {
    await appendFile(
      path.join(context.workDir, 'events', `${sessionId}.jsonl`),
      `${JSON.stringify(event)}\n`,
      'utf8',
    );
  } catch {
    // Агент об этом знать не должен: ответ `wait_for` от журнала не зависит.
  }
}

/** Пауза, которую прерывает отмена вызова клиентом: ждать больше некого, и вызывающий проверит `signal` сам. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function waitFor(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const startedAt = Date.now();
  const target = stringArg(args, 'target');
  const timeoutMs = waitTimeoutMs(numberArg(args, 'timeoutSec'));
  const read = (): Promise<WorkMap> => readMap(context.projectPath, context.workId);
  /**
   * Хост усыпляет эту сессию или уже усыпил (`inboxFenced`): письма ей не выдаются, ожидание отвечает `running`. Синхронно
   * и без копии карты: от проверки отмены до ответа ниже `await` быть не должно.
   */
  const fenced = (): boolean =>
    viewMap(context.projectPath, context.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === sessionId);
      return session !== undefined && inboxFenced(session);
    });
  /** Сколько ещё ждать тишины по этим письмам, мс; 0 — доставлять сейчас (окно и потолок — из контекста, для тестов). */
  const settleDelay = (unread: readonly Message[]): number =>
    settleDelayMs(unread, sessionId, Date.now(), context.settleMs, context.settleMaxMs);
  /** Ответ пробы «письма есть, но не устоялись»: цикл ниже пересчитывает срок и ждёт не дольше него. */
  const PENDING = Symbol('pending');
  /** Ожидание начато без писем: появившиеся несрочные письма оно обязано отдать циклу (см. пробу), а не ждать мимо их срока. */
  let wakeOnPending = false;

  let probe: () => Promise<unknown | null>;
  if (target === 'inbox') {
    // Проба только читает: письма отдаёт и отмечает прочитанными `takeInbox` после ожидания, когда вызов точно не отменён
    // (отмена посреди пробы иначе отметила бы письма, которых агент не увидит). «Готово» — есть срочное письмо или пачка
    // устоялась (`settleDelayMs`, то же правило, что у будильника хоста); несрочные ещё в окне тишины — не готово.
    probe = async () => {
      const unread = unreadLetters(context.projectPath, context.workId, sessionId);
      if (unread.length === 0) return null;
      if (settleDelay(unread) === 0) return true;
      // Письма пришли, пока ожидание шло без них: оно не знает их срока, поэтому отдаёт управление циклу ниже, и тот ограничит
      // ожидание окном. Ожидание, уже ограниченное окном, этого не делает — иначе цикл не вышел бы из пробы.
      return wakeOnPending ? PENDING : null;
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
      // Застрявшая: итога нет, она ждёт человека. Ответ несёт потребность и подсказку не ждать её снова (5.3).
      if (state === 'stuck' && session.stuck != null) {
        return {
          state,
          sessionId: target,
          stuck: session.stuck,
          hint: stuckHint(target, session.stuck, new Date()),
        };
      }
      // Усыплённая хостом: итога не будет, пока её не разбудит письмо, а ждать её до таймаута впустую. Отвечаем сразу и вместо
      // резюме и артефактов даём подсказку, что делать: писать ей или ждать почту.
      if (state === 'asleep') return { state, sessionId: target, hint: asleepHint(target) };
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

  // Одно ожидание: свой id и своя пара ParleyWaitStart/End. Реальное ожидание начинается, когда первая проба вернула
  // `null`; ответ без ожидания — итог уже есть, письмо уже пришло, неизвестный id — следов в журнале не оставляет. Конец
  // ждёт записи начала: строки идут по порядку, что бы ни случилось с ожиданием. Конец пишется до возврата из этой
  // функции, то есть до того, как вызывающий заберёт письма (см. ниже).
  const waitOnce = async (ms: number): Promise<unknown | null> => {
    const waitId = randomUUID();
    const wait = { begun: null as Promise<void> | null };
    const probeAndNote = async (): Promise<unknown | null> => {
      const result = await probe();
      if (result === null && wait.begun === null) {
        wait.begun = noteWait(context, sessionId, {
          hook_event_name: 'ParleyWaitStart',
          parley_wait_target: target,
          parley_wait_id: waitId,
        });
      }
      return result;
    };
    try {
      // `mapChanges` — сигнал об изменении карты снаружи (хост, спека хранилища 6.9): он будит ожидание сразу, а опрос по версии
      // работы остаётся запасным и единственным поводом там, где сигнала нет (сессия без канала, запасной путь при 404).
      return await waitForMap(
        () => workVersionKey(context.projectPath, context.workId),
        probeAndNote,
        ms,
        context.pollMs ?? POLL_MS,
        signal,
        context.mapChanges,
      );
    } finally {
      // Любой исход, в том числе отмена вызова клиентом: она прерывает ожидание, и конец пишется сразу.
      if (wait.begun !== null) {
        await wait.begun;
        await noteWait(context, sessionId, {
          hook_event_name: 'ParleyWaitEnd',
          parley_wait_id: waitId,
        });
      }
    }
  };

  const endsAt = Date.now() + timeoutMs;
  // Функцией, а не полем `signal.aborted` напрямую: после `await` отмена могла прийти, а компилятор помнил бы прежнее `false`.
  const cancelled = (): boolean => signal?.aborted === true;
  for (;;) {
    // Отметка «засыпает»: письма остаются непрочитанными, ждать их незачем — сессию остановят. Ни одной строки журнала.
    if (fenced()) return { state: 'running' };
    const timeLeftMs = Math.max(endsAt - Date.now(), 0);
    // Письма лежат, но пачка не устоялась: проба из-за этого не сработает до смены карты, а срок идёт по часам. Поэтому ждём
    // не дольше срока и пересчитываем (не раньше, чем кончится таймаут вызова).
    const unsettledMs = target === 'inbox' ? settleDelay(unreadLetters(context.projectPath, context.workId, sessionId)) : 0;
    wakeOnPending = unsettledMs === 0;
    const found = await waitOnce(unsettledMs > 0 ? Math.min(timeLeftMs, unsettledMs + SETTLE_SLACK_MS) : timeLeftMs);
    if (target !== 'inbox') return found === null ? { state: 'running' } : found;
    if (found === PENDING) continue;
    if (found === null) {
      if (cancelled()) return { state: 'running' };
      // Короткое ожидание до срока кончилось, а таймаут вызова — нет: письма могли устояться или прибавиться.
      if (endsAt - Date.now() > 0) continue;
      // Таймаут вызова при лежащих неустоявшихся письмах: отдаём их, а не `running` — письмо уже лежит, а держать его дольше
      // вызова незачем. Ничего не лежит — `running`.
      if (unreadLetters(context.projectPath, context.workId, sessionId).length === 0) return { state: 'running' };
    }
    // Письма забираются только теперь, когда ожидание целиком закончено, в том числе запись конца в журнал: пока она шла,
    // клиент мог отменить вызов, а письма, помеченные до этого, пропали бы вместе с отброшенным ответом. От проверки отмены
    // до `return` ни одного `await`: отмена приходит отдельным событием, а не микрозадачей, и между пометкой и ответом
    // вклиниться не может. Отменённый вызов ничего не отмечает: письмо остаётся для следующего `check_inbox`.
    if (cancelled()) return { state: 'running' };
    // Брошенный вызов: ход сессии кончился или начался заново после старта вызова (человек прервал ход, а клиент отмену не
    // прислал — Codex). Агент ответа не увидит; письмо остаётся непрочитанным, и хост напечатает на него указатель.
    if (context.turnBoundarySince?.(startedAt) === true) return { state: 'running' };
    // Хост поставил отметку, пока шло ожидание: письмо остаётся непрочитанным. `takeInbox` проверяет это ещё раз в своей записи.
    if (fenced()) return { state: 'running' };
    const messages = takeInbox(context, sessionId);
    if (messages.length > 0) return { state: 'message', messages };
    // Письма успел забрать параллельный `check_inbox`: пустой `message` не отдаём, ждём остаток таймаута. Пауза перед
    // новым ожиданием — на случай, если проба и `takeInbox` разойдутся: без неё цикл крутился бы в микрозадачах до таймаута.
    const remaining = endsAt - Date.now();
    if (remaining <= 0) return { state: 'running' };
    await abortableDelay(Math.min(context.pollMs ?? POLL_MS, remaining), signal);
    if (cancelled()) return { state: 'running' };
  }
}

/** Параметры `send_message`, которые сервер знает; прочие он пропускает с предупреждением. */
const SEND_MESSAGE_PARAMS = new Set(['to', 'text', 'kind', 'room', 'replyTo']);

/**
 * Предупреждение о незнакомых параметрах `send_message` (Parley 0.3.0). Схема их не запрещает: строгая схема
 * (`additionalProperties: false`) сломала бы клиентов, которые шлют лишнее. Но опечатку вроде `reply_to` сервер
 * пропускал молча, и агент считал, что процитировал. Теперь письмо уходит, а в ответе сказано, что пропущено и что
 * имелось в виду. `null` — незнакомых полей нет.
 */
function unknownParamsWarning(args: Record<string, unknown>): string | null {
  const unknown = Object.keys(args).filter((key) => !SEND_MESSAGE_PARAMS.has(key));
  if (unknown.length === 0) return null;
  const named = unknown.map((key) => (/reply/i.test(key) ? `${key} (did you mean replyTo?)` : key));
  return `unknown parameters ignored: ${named.join(', ')}`;
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
  // Пустая строка — ошибка, как у `room`: `stringArg` пустое значение не пропускает.
  const replyTo = optionalStringArg(args, 'replyTo');
  // Схема с maxLength клиента не обязывает, поэтому потолок держит сам обработчик, до записи в карту. Обычный
  // Error, а не SharedStateError: у того сообщение — голый код, а агенту нужна фраза с действием.
  if (text.length > LETTER_MAX_CHARS) {
    throw new Error(`letter is ${text.length} chars, limit ${LETTER_MAX_CHARS}: write a file and send its path`);
  }

  const limits = await limitsOf(context);
  let created = '';
  let stuckNotes: string[] = [];
  writeLetters(context.projectPath, context.workId, (letters, current) => {
    // Отправителя проверяем наравне с получателем: сервер удалённой сессии ещё
    // жив, и без проверки в карту легло бы письмо от несуществующего адресата,
    // ответить на которое нечем (план от 2026-09-06, раздел C).
    requireSession(current, sessionId);
    assertRate(letters, sessionId, context.messageRate ?? DEFAULT_CONFIG.messageRate, Date.now());

    let sent: Message;
    if (roomId !== null) {
      // Запись в комнату: архивная отказывает текстом `RoomRuleError`. Чтение (`requireRoom`) архивную комнату отдаёт.
      const room = requireOpenRoom(current, roomId);
      const lead = liveLead(current, room);
      if (room.ownerId === sessionId) assertDeliverable(current, sessionId);
      const ownerToLead = room.ownerId === sessionId && to.length === 1 && to[0] === lead;
      const leadToOwner = lead === sessionId && room.ownerId !== null && to.length === 1 && to[0] === room.ownerId;
      if (!isMember(room, sessionId) && !ownerToLead) {
        throw new Error(room.ownerId === sessionId
          ? 'room owners may send only an addressed message to the current live room lead'
          : `session ${sessionId} is not a participant of room ${roomId}`);
      }
      for (const memberId of to) {
        if (!isMember(room, memberId) && !leadToOwner) {
          throw new Error(`session ${memberId} is not a participant of room ${roomId}`);
        }
        assertDeliverable(current, memberId);
      }
      // Ответ (Parley 0.3.0): цитировать можно только сообщение этой же комнаты — несуществующий id, чужая
      // комната и прямое письмо дают отказ. Сверка идёт под тем же замком, что и запись: карта между ними
      // не устареет, как у проверок участников выше.
      if (replyTo !== null) {
        const quoted = letters.byId(replyTo);
        if (quoted?.roomId !== roomId) {
          throw new Error(`message ${replyTo} is not in room ${roomId}`);
        }
      }
      assertMessageBudget(current, letters, {
        actor: sessionId,
        room: roomId,
        messages: 1,
        recipients: countRecipients(current, sessionId, roomId, to),
        limits,
      });
      // Пустой to в комнате — рассылка всем участникам (recipientsOf её и разберёт).
      sent = letters.add({
        roomId,
        from: sessionId,
        to,
        text,
        kind,
        ...(replyTo === null ? {} : { replyTo }),
      });
    } else {
      // Цитата живёт в ленте комнаты: у прямого письма её нет, и молча отбросить `replyTo` значило бы
      // обмануть агента, ждущего цитаты.
      if (replyTo !== null) throw new Error('replyTo works only together with room');
      if (to.length !== 1) {
        throw new Error('without room, exactly one addressee in to is required');
      }
      const target = to[0] as string;
      // Человек — не сессия: прямое письмо ему (ответ на его письмо) проверки доставки не проходит, его читает окно.
      if (target !== HUMAN) assertDeliverable(current, target);
      assertMessageBudget(current, letters, { actor: sessionId, room: null, messages: 1, recipients: 1, limits });
      sent = letters.add({ roomId: null, from: sessionId, to: [target], text, kind });
    }
    created = sent.id;
    // Адресат (явный или по рассылке комнаты) застрял: письмо уже записано, но прочтёт он его по возвращении (5.3).
    const now = new Date();
    stuckNotes = recipientsOf(sent, current).flatMap((id) => {
      const need = current.sessions.find((candidate) => candidate.id === id)?.stuck;
      return need == null ? [] : [stuckWarning(id, need, now)];
    });
  });
  const warnings = [
    text.length > LETTER_SOFT_CHARS ? `long letter (${text.length} chars): prefer a file and a path` : null,
    unknownParamsWarning(args),
    ...stuckNotes,
  ].filter((warning): warning is string => warning !== null);
  return warnings.length === 0 ? { messageId: created } : { messageId: created, warning: warnings.join('; ') };
}

/**
 * Забирает непрочитанное: письма в ответ и пометка прочитанными — по одному снимку, одной записью. Общая для `check_inbox` и
 * `wait_for("inbox")`: письмо не бывает отмечено, не будучи отданным хотя бы одному из вызовов. Пустой ящик ничего не пишет:
 * ни версии работы, ни `updatedAt` (спека хранилища 6.2); сдвиг — когда отмечено письмо.
 */
function takeInbox(context: McpContext, sessionId: string): ReturnType<typeof inboxView>[] {
  const at = new Date().toISOString();
  return writeLetters(context.projectPath, context.workId, (letters, current) => {
    requireSession(current, sessionId);
    // Ограда агента ещё раз — в той же записи, где письма помечаются: `wait_for`, начатый до замены агента, иначе забрал бы
    // почту нового (спека передачи сессии 6.1). Отказ откатывает запись: письма остаются непрочитанными.
    const revision = current.sessions.find((session) => session.id === sessionId)?.agentRevision ?? null;
    if (revision !== null && revision !== context.agentRevision) throw new Error(STALE_AGENT);
    // Сессию усыпляет хост или уже усыпил (`inboxFenced`): письма не выдаются и не помечаются, но и ошибки нет — они поднимут её
    // после сна. Тоже в этой записи: отметка, поставленная после проверки в `waitFor`, письма не заберёт.
    if (inboxFenced(requireSession(current, sessionId))) return [];
    const inbox = letters.unreadFor(sessionId);
    const views = inbox.map((message) => inboxView(message, current, sessionId));
    letters.markRead(sessionId, inbox.map((message) => message.id), at);
    return views;
  });
}

async function checkInbox(context: McpContext, sessionId: string): Promise<unknown> {
  return { messages: takeInbox(context, sessionId) };
}

/** Сессия роя в комнату не входит (спека роя v1, 4): проверка по карте, `code: message` как у остальных отказов роя. */
function assertNotSwarmMember(map: WorkMap, sessionId: string): void {
  if (swarmOfSession(map, sessionId) !== null) throw new Error(`swarm-member: ${sessionId} is a member of a swarm and cannot join a room.`);
}

async function createRoom(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const title = stringArg(args, 'title');
  const membersInput = stringsArg(args, 'members');
  const leadInput = stringArg(args, 'lead');
  if (membersInput.length === 0) throw new Error('members must include at least one working participant');

  const limits = await limitsOf(context);
  let roomId = '';
  await updateMap(context.projectPath, context.workId, (current, letters) => {
    requireSession(current, sessionId);
    const members = [...new Set(membersInput)];
    const invited = members.filter((id) => id !== sessionId);
    for (const memberId of members) {
      const member = requireSession(current, memberId);
      if (member.lifecycle === 'closed') {
        throw new Error(`session ${memberId} is closed: it cannot be added to the room`);
      }
      assertNotSwarmMember(current, memberId);
    }
    // Приглашение — письмо от создателя каждому участнику: оно расходует тот же бюджет писем, что и `send_message`,
    // иначе исчерпанный лимит обходился бы созданием комнаты.
    if (invited.length > 0) {
      assertRate(letters, sessionId, context.messageRate ?? DEFAULT_CONFIG.messageRate, Date.now(), invited.length);
      assertMessageBudget(current, letters, { actor: sessionId, room: null, messages: invited.length, recipients: invited.length, limits });
    }

    const room = addRoom(current, {
      title,
      creator: sessionId,
      ownerId: sessionId,
      members,
      lead: leadInput,
    });
    roomId = room.id;
    for (const memberId of members) leaveOtherRooms(current, letters, memberId, room.id, room.createdAt);
    const notice = joinNotice(room, current);
    for (const memberId of invited) {
      letters.add({ roomId: room.id, from: sessionId, to: [memberId], kind: 'note', text: notice });
    }
  });
  return { roomId };
}

async function addToRoom(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const roomId = stringArg(args, 'room');
  const target = stringArg(args, 'session');

  let messageId = '';
  await updateMap(context.projectPath, context.workId, (current, letters) => {
    // Правила — ведущий, живая комната, закрытая или чужая сессия, уже участник, одна комната на сессию —
    // держит `addMemberByLead`. Его `RoomRuleError` уходит агенту текстом ошибки, как у `propose_decision`,
    // а исключение из мутатора не даёт `updateMap` записать карту: после отказа она не меняется.
    // Допуска бюджета здесь нет намеренно (P37): `addMemberByLead` пишет только системную строку «joined the room»
    // (`from: system`, адресат — человек), она никого не будит, не рассылается и в бюджет писем не входит. Письма
    // приглашённому здесь нет, в отличие от `create_room`; разговорная квота управление комнатой не блокирует.
    assertNotSwarmMember(current, target);
    messageId = addMemberByLead(current, letters, roomId, sessionId, target).id;
  });
  return { messageId };
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
  if (!canReadRoom(room, sessionId)) {
    throw new Error(`room ${roomId} is not available to this session`);
  }

  // Хвост комнаты в пределах байтов: письмо, которое одно не влезает, сокращается с полным размером, а старее —
  // по `page.next`. Прежний ответ был `limit` писем любого размера.
  try {
    return messagePage(map, {
      roomId,
      cursor: parseCursor(optionalString(args, 'cursor')),
      maxBytes: clampPageBytes(numberArg(args, 'maxBytes')),
      maxItems: Math.min(Math.max(Math.floor(limit), 1), LETTER_PAGE_MAX_ITEMS),
      view: (message) => messageView(message, map),
    }, storeLetterReader(context.projectPath, context.workId));
  } catch (error) {
    if (error instanceof PageError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

async function proposeDecision(
  context: McpContext,
  _sessionId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return planTool(context, 'propose_decision', args, signal);
}

/**
 * Гид: без темы — весь, с темой — один раздел. Пустая тема (`""`) — то же, что её отсутствие: агенты
 * нередко шлют пустую строку на необязательный параметр. Неизвестная — ошибка со списком тем, чтобы
 * агент поправил вызов сам.
 */
/**
 * Ответ гида в пределах бюджета. Гид растёт, а агент читает его целиком: не влез — вместо обрезанного текста
 * короткий ответ с размером и списком тем, дальше агент просит одну тему (P34).
 */
export function boundedGuide(text: string, what: string, limit = READ_GUIDE_MAX_BYTES): string {
  return boundResponse(
    text,
    limit,
    (bytes) => `${what} is ${bytes} bytes, over the ${limit}-byte limit for one answer. Ask for one section with the topic argument; topics: ${GUIDE_TOPICS.map((item) => item.topic).join(', ')}.\n`,
  );
}

function readGuide(context: McpContext, args: Record<string, unknown>): string {
  const raw = args['topic'];
  const options = { skillNavigator: context.skillNavigator === true, ...(context.toolProfile === undefined ? {} : { toolProfile: context.toolProfile }) };
  if (raw === undefined || raw === '') return boundedGuide(guide(options), 'The whole guide');
  if (typeof raw !== 'string') throw new Error('argument topic: expected a string');
  const text = guideTopic(raw.trim().toLowerCase(), options);
  if (text === null) {
    throw new Error(
      `unknown guide topic "${raw}"; topics: ${GUIDE_TOPICS.map((item) => item.topic).join(', ')}`,
    );
  }
  return boundedGuide(text, `The guide topic ${raw.trim().toLowerCase()}`);
}

async function closeSession(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const target = stringArg(args, 'target');

  await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, target);
    if (target !== sessionId) {
      if (swarmOfSession(current, target) !== null) {
        throw new Error(`close_session cannot close ${target}: it is a swarm member; only the human cancels a swarm`);
      }
      if (!isCreatedDescendant(current, sessionId, target)) {
        throw new Error(
          `close_session can only close the calling session or a session it created (${target} is not one of them)`,
        );
      }
    }
    transitionSession(current, target, 'closed');
  });
  return { sessionId: target };
}

const NO_SESSION =
  'no session is set (PARLEY_SESSION_ID is empty): only get_map and read_guide are available. Create a session through Parley or `parley-core work session new` — then the other tools work.';

/** Only the immutable launched caller supplies project/work/session identity; tool arguments cannot redirect it. */
async function backlogTool(context: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const allowed = name === 'backlog_list' ? ['filter', 'text'] : ['kind', 'title', 'details', 'why'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new SharedStateError('backlog-invalid');
    const sessionId = context.sessionId;
    if (sessionId === null) throw new Error('Backlog tools require a known launched session.');
    const map = await readMap(context.projectPath, context.workId);
    const caller = map.sessions.find(row => row.id === sessionId);
    if (!caller || map.work.id !== context.workId) throw new Error('Backlog tools require a known launched session.');
    if (name === 'backlog_list') {
      const filter = args.filter ?? 'open'; const text = args.text ?? '';
      if (!['open', 'taken', 'done', 'all'].includes(String(filter)) || typeof filter !== 'string' ||
        typeof text !== 'string' || text.length > 4096 || text.includes('\0')) throw new SharedStateError('backlog-invalid');
      const document = await readBacklog(context.projectPath);
      const needle = text.toLowerCase();
      const items = document.items.filter(row => (filter === 'all' || (filter === 'done' ? row.checked :
        filter === 'taken' ? !row.checked && row.taken !== undefined : !row.checked)) &&
        (!needle || `${row.title}\n${row.details}\n${row.section ?? ''}`.toLowerCase().includes(needle)));
      const pending = await listBacklogSuggestions(context.projectPath);
      const paths = await sharedProjectPaths(context.projectPath);
      const result = { version: document.version, items, suggestions: pending.map(row => ({ id: row.id, kind: row.kind,
        title: row.title, details: row.details, why: row.why, workId: row.workId, sessionId: row.sessionId })),
        rule: (await readProjectPreferences(context.projectPath)).backlogRule, diagnostics: await inspectSharedIgnore(paths) };
      if (items.length > 10_000 || pending.length > 10_000 || Buffer.byteLength(JSON.stringify(result), 'utf8') > 4 * 1024 * 1024)
        throw new Error('The backlog snapshot is too large.');
      return result;
    }
    if (caller.lifecycle === 'closed' || map.work.status !== 'active') throw new Error('A live launched session is required to suggest backlog work.');
    if (!['bug', 'debt', 'idea'].includes(String(args.kind)) || typeof args.kind !== 'string' ||
        typeof args.title !== 'string' || typeof args.why !== 'string' ||
        (args.details !== undefined && typeof args.details !== 'string')) throw new SharedStateError('suggestions-invalid');
    const result = await suggestBacklog(context.projectPath, { kind: args.kind as 'bug' | 'debt' | 'idea', title: args.title,
      why: args.why, ...(typeof args.details === 'string' ? { details: args.details } : {}), workId: context.workId, sessionId });
    let feedUnavailable = false;
    // Строка в ленту — только открытым комнатам: в архивную комнату не пишет никто, кроме человека.
    if (result.status !== 'duplicate' && map.rooms.some(room => room.members.includes(sessionId) && !isRoomArchived(room))) {
      try {
        writeLetters(context.projectPath, context.workId, (letters, current) => {
          const label = sessionId.replace(/^s-/, 'S');
          const text = `${label} ${result.status === 'added' ? 'added to' : 'suggested for'} the backlog: ${args.title as string}`;
          for (const room of current.rooms.filter(row => row.members.includes(sessionId) && !isRoomArchived(row)))
            letters.add({ roomId: room.id, from: SYSTEM, to: [], text, kind: 'note' });
        });
      } catch { feedUnavailable = true; }
    }
    return { message: `${result.status === 'added' ? 'added' : result.status === 'pending' ? 'suggested' : 'already in backlog'}: ${result.id}`,
      diagnostics: result.diagnostics, ...(feedUnavailable ? { feedUnavailable: true } : {}) };
  } catch (error) {
    if (error instanceof SharedStateError) throw new Error(`Backlog operation failed (${error.code}).`);
    // Never return parser/filesystem/raw-input errors through the generic MCP error handler.
    const safe = error instanceof Error && ['Backlog tools require a known launched session.',
      'A live launched session is required to suggest backlog work.', 'The backlog snapshot is too large.'].includes(error.message);
    throw new Error(safe ? (error as Error).message : 'Backlog operation could not be completed.');
  }
}

/** Ответ `memory_read` ограничен: лишнее отбрасывается с пометкой, а не раздувает контекст агента. */
const MEMORY_READ_BYTES = 64 * 1024;
const FEED_FACT_LENGTH = 300;
const MEMORY_KINDS: readonly string[] = ['fact', 'lesson', 'agreement'];
const MEMORY_ID = /^m-\d{3,}$/;

/** Memory and history tools: the caller is the launched session fixed by the context; arguments cannot redirect it. */
async function memoryTool(context: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const allowed = name === 'remember' ? ['kind', 'fact', 'details', 'why', 'onHumanRequest']
      : name === 'memory_read' ? ['ids'] : ['query', 'scope', 'limit'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new SharedStateError('memory-invalid');
    const sessionId = context.sessionId;
    if (sessionId === null) throw new Error('Memory tools require a known launched session.');
    const map = await readMap(context.projectPath, context.workId);
    const caller = map.sessions.find(row => row.id === sessionId);
    if (!caller || map.work.id !== context.workId) throw new Error('Memory tools require a known launched session.');
    if (name === 'search_history') {
      const { query, scope, limit } = args;
      if (typeof query !== 'string' || (scope !== undefined && typeof scope !== 'string') ||
        (limit !== undefined && typeof limit !== 'number')) throw new HistorySearchError('search-invalid');
      const found = await searchHistory(context.projectPath, { query, ...(scope === undefined ? {} : { scope: scope as HistoryScope }),
        ...(limit === undefined ? {} : { limit }) });
      return found.total === 0 ? { ...found, message: 'Nothing found: try fewer or other words.' } : found;
    }
    if (name === 'memory_read') {
      const { ids } = args;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !MEMORY_ID.test(id))))
        throw new SharedStateError('memory-invalid');
      const wanted = ids === undefined ? null : new Set(ids as string[]);
      const items = (await readProjectMemory(context.projectPath)).items.filter(row => wanted === null || (row.id !== null && wanted.has(row.id)));
      const shown: unknown[] = []; let bytes = 0;
      for (const row of items) {
        const entry = { id: row.id, kind: row.kind, fact: row.fact, details: row.details,
          state: row.state ?? row.provenance?.state ?? 'current',
          by: row.human === true || row.provenance?.origin === 'human' ? 'human' : row.by ?? 'unknown',
          ...(row.onHumanRequest === true || row.provenance?.claimedHumanRequest === true ? { onRequest: true } : {}) };
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (bytes > MEMORY_READ_BYTES) break;
        shown.push(entry);
      }
      return { items: shown, total: items.length, ...(shown.length < items.length ? { truncated: true } : {}) };
    }
    if (caller.lifecycle === 'closed' || map.work.status !== 'active') throw new Error('A live launched session is required to remember.');
    if (typeof args.kind !== 'string' || !MEMORY_KINDS.includes(args.kind) || typeof args.fact !== 'string' || typeof args.why !== 'string' ||
      (args.details !== undefined && typeof args.details !== 'string') ||
      (args.onHumanRequest !== undefined && typeof args.onHumanRequest !== 'boolean')) throw new SharedStateError('memory-invalid');
    const request = args.onHumanRequest === true;
    const result = await rememberProjectMemory(context.projectPath, { kind: args.kind as MemoryKind, fact: args.fact, why: args.why,
      ...(typeof args.details === 'string' ? { details: args.details } : {}), ...(request ? { onHumanRequest: true } : {}),
      workId: context.workId, sessionId });
    let feedUnavailable = false;
    // Строка в ленту — только открытым комнатам, как у `backlog_suggest`.
    if (result.status !== 'duplicate' && map.rooms.some(room => room.members.includes(sessionId) && !isRoomArchived(room))) {
      try {
        writeLetters(context.projectPath, context.workId, (letters, current) => {
          const label = sessionId.replace(/^s-/, 'S');
          const fact = args.fact as string;
          const brief = fact.length > FEED_FACT_LENGTH ? `${fact.slice(0, FEED_FACT_LENGTH)}…` : fact;
          // The agent only claims that the human asked: the line says so instead of vouching for it.
          const text = result.status === 'remembered' ? `${label} remembered, saying you asked for it: ${brief}` : `${label} suggests remembering: ${brief}`;
          for (const room of current.rooms.filter(row => row.members.includes(sessionId) && !isRoomArchived(row)))
            letters.add({ roomId: room.id, from: SYSTEM, to: [], text, kind: 'note' });
        });
      } catch { feedUnavailable = true; }
    }
    return { message: `${result.status === 'remembered' ? 'remembered' : result.status === 'pending' ? 'suggested' : 'already remembered'}: ${result.id}`,
      diagnostics: result.diagnostics, ...(feedUnavailable ? { feedUnavailable: true } : {}) };
  } catch (error) {
    if (error instanceof SharedStateError) throw new Error(`Memory operation failed (${error.code}).`);
    if (error instanceof HistorySearchError) throw new Error('Search request is invalid: give a non-empty query (up to 16 words), a known scope and a limit from 1 to 30.');
    // Never return parser/filesystem/raw-input errors through the generic MCP error handler.
    const safe = error instanceof Error && ['Memory tools require a known launched session.', 'A live launched session is required to remember.'].includes(error.message);
    throw new Error(safe ? (error as Error).message : 'Memory operation could not be completed.');
  }
}

async function dispatch(
  context: McpContext,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (name === 'backlog_list' || name === 'backlog_suggest') return backlogTool(context, name, args);
  if (name === 'remember' || name === 'memory_read' || name === 'search_history') return memoryTool(context, name, args);
  if (name === 'get_map') return getMap(context, args, signal);
  if (name === 'get_capacity') {
    if (Object.keys(args).length > 0) throw new Error('get_capacity takes no arguments');
    return getCapacity(context, signal);
  }
  if (name === 'list_roles') {
    const map = await readMap(context.projectPath, context.workId);
    const caller = map.sessions.find(item => item.id === context.sessionId);
    const cwd = caller?.worktree?.path ?? context.projectPath;
    return roleSummaries(await (context.roleCatalog ? context.roleCatalog(cwd) : sessionRoleCatalog(cwd, { codex: true })));
  }
  // Гид не про конкретную сессию: он доступен и без `PARLEY_SESSION_ID`.
  if (name === 'read_guide') return readGuide(context, args);

  if (isPlanTool(name)) return planTool(context, name, args, signal);
  const { sessionId } = context;
  if (sessionId === null) throw new Error(NO_SESSION);

  if (name === 'publish_agent_plan') return publishAgentPlan(context, args);
  if (name === 'report') return report(context, sessionId, args);
  if (name === 'wait_for') return waitFor(context, sessionId, args, signal);
  if (name === 'send_message') return sendMessage(context, sessionId, args);
  if (name === 'check_inbox') return checkInbox(context, sessionId);
  if (name === 'create_room') return createRoom(context, sessionId, args);
  if (name === 'add_to_room') return addToRoom(context, sessionId, args);
  if (name === 'read_room') return readRoom(context, sessionId, args);
  if (name === 'propose_decision') return proposeDecision(context, sessionId, args, signal);
  if (name === 'close_session') return closeSession(context, sessionId, args);
  throw new Error(`unknown tool ${name}`);
}

/**
 * Что агент должен знать про звонок (разговор агентов, 4.5). Текст доставляется
 * при подключении, поэтому он короткий и весь про поведение: этикет тут —
 * половина защиты от переписки двух вежливых агентов до конца лимита (4.7).
 */
export const CHANNEL_INSTRUCTIONS = `Colleagues' messages in this workspace are announced with the tag <channel source="parley">: in it from is the sender session's id, from_label is its role, kind is the kind of message. The tag has no message text: if you see the tag, call check_inbox, it returns all unread messages at once.
Answer with send_message(to=<from>) only to a \`question\`; a note and a decision need no answer, do not write "thanks" or "agreed". Record an agreement with one message with kind: decision to the one you agreed with.
Each message is announced once; check_inbox and wait_for("inbox") are a safety net in case the channel is silent.`;

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
 * id треда Codex — uuid. Всё, что на него не похоже, в карту не идёт: записанный id потом уходит
 * аргументом `codex resume <id>`, и значение, начинающееся с дефиса, было бы флагом.
 */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Привязка сессии Codex к её логу (спека комнат Organic, 3.6). Codex кладёт id треда в `_meta.threadId`
 * каждого `tools/call` к любому MCP-серверу, поэтому сервер узнаёт его при первом же вызове — без
 * гадания по cwd и времени запуска, которое принимает чужой лог, если рядом стартовал ещё один агент.
 *
 * `_meta.threadId` авторитетнее запасного пути: это тред, который выполняет вызов в этом самом процессе,
 * а запасной путь хоста (по cwd и времени) срабатывает на первом же логе Codex — за секунды до первого
 * вызова модели — и рядом с ещё одним агентом в том же каталоге ошибается. Поэтому id из `_meta`
 * перезаписывает отличающееся значение; запись, где уже он, карту не трогает.
 *
 * Вызов подагента (`_meta.sessionId` — корневой тред — не совпадает с `threadId`) не привязывает: его тред
 * — не тот, который человек возобновит `codex resume`. Ждём вызова корневого треда.
 *
 * Raw once latch и proof retry независимы; ошибка proof не меняет прежнюю привязку Chat.
 * Оба writer-пути сериализованы одним map lock. Ошибки не роняют вызов инструмента.
 */
interface CodexBindingState {
  rawBound: boolean;
  proofBound: boolean;
  root: string | null;
  launchRevision: string | null;
}

function matchingCodexLaunch(session: WorkSession, launchRevision: string) {
  const record = session.codexThreadBinding;
  return session.provider === 'codex' && isCodexThreadBinding(record) &&
    record.launchRevision === launchRevision && record.pid === session.pid &&
    record.startedAtProcess === session.startedAtProcess ? record : null;
}

async function bindCodexThread(
  context: McpContext,
  meta: Record<string, unknown> | undefined,
  state: CodexBindingState,
): Promise<void> {
  const { sessionId } = context;
  if (sessionId === null) return;
  const threadId = meta?.['threadId'];
  const root = meta?.['sessionId'];
  const thread = typeof threadId === 'string' && THREAD_ID.test(threadId) ? threadId.toLowerCase() : null;
  const validRoot = typeof root === 'string' && THREAD_ID.test(root) ? root.toLowerCase() : null;
  // Legacy raw bind допускает missing/malformed root; proof требует два совпавших UUID.
  const rawThread = !state.rawBound && thread !== null && (validRoot === null || validRoot === thread) ? thread : null;
  if (state.root === null && thread !== null && validRoot === thread) state.root = thread;
  const proof = !state.proofBound && state.root !== null && state.launchRevision !== null
    ? { thread: state.root, launchRevision: state.launchRevision } : null;
  if (rawThread === null && proof === null) return;
  try {
    // Чтение до записи: пустая запись версию не поднимает, но всё равно занимает блокировку записи (спека хранилища 6.2),
    // а привязка уже стоит почти при каждом вызове — незачем держать замок ради «ничего не менять».
    const known = (await readMap(context.projectPath, context.workId)).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (known === undefined) return;
    if (known.provider !== 'codex') {
      if (rawThread !== null) state.rawBound = true;
      state.proofBound = true;
      return;
    }
    const writeRaw = rawThread !== null && known.providerSessionId !== rawThread;
    if (rawThread !== null && !writeRaw) state.rawBound = true;
    const record = proof === null ? null : matchingCodexLaunch(known, proof.launchRevision);
    const canProve = record !== null && (writeRaw ? rawThread : known.providerSessionId) === proof?.thread;
    if (canProve && record.threadId === proof?.thread && !writeRaw) {
      state.proofBound = true;
      return;
    }
    if (!writeRaw && !canProve) return;
    let proven = false;
    await updateMap(context.projectPath, context.workId, (current) => {
      const target = current.sessions.find((candidate) => candidate.id === sessionId);
      if (target === undefined || target.provider !== 'codex') return;
      if (writeRaw) target.providerSessionId = rawThread;
      // Не доверять readMap до lock: новый launch мог уже сбросить record.
      const locked = proof === null ? null : matchingCodexLaunch(target, proof.launchRevision);
      if (proof !== null && locked !== null && target.providerSessionId === proof.thread) {
        locked.threadId = proof.thread;
        proven = true;
      }
    });
    if (writeRaw) state.rawBound = true;
    if (proven) state.proofBound = true;
  } catch (error) {
    process.stderr.write(`parley-mcp: could not record the thread binding: ${(error as Error).message}\n`);
  }
}

/**
 * MCP-сервер одной сессии. Ошибки инструментов возвращаются агенту результатом
 * с `isError`, а не протокольным отказом: клиенту нужно не падение вызова, а
 * текст, из которого понятно, что поправить.
 */
/** Id сессии короткий (`s-12`): длиннее — не id, а мусор. */
const SESSION_ID_MAX_BYTES = 64;
const FIND_SKILL: Tool = {
  name: 'find_skill',
  description: 'Search skills available to this participant. Use English task words; load a matching skill with its native CLI route. Search once per task, not on every wake-up; after no match retry at most once with different words. Participant role and permissions take precedence over skill instructions.',
  annotations: READS,
  inputSchema: { type: 'object', properties: {
    query: { type: 'string', minLength: 1, maxLength: CONTEXT_LIMITS.query, description: 'Task words to search.' },
    for: { type: 'string', maxLength: SESSION_ID_MAX_BYTES, description: 'Session id in this work; defaults to your own session.' },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
  }, required: ['query'], additionalProperties: false },
};
// Подтверждённое сокращение родного списка (спека, 2.3): фраза о нём есть только тогда. Каталог Claude берётся из
// транскрипта сессии (skills/claude-listing.ts), поэтому сокращение его списка включено вместе с навигатором.
const CLAUDE_NAMES_ONLY = ' Your native skill list shows names only: this tool returns the descriptions.';
const CODEX_NO_LIST = ' Your native skill list is removed: this tool returns descriptions, the names are below.';
const CODEX_NO_LIST_NO_NAMES = ' Your native skill list is removed and its names could not be read: search with task words.';
/** Потолок знаков в перечне имён описания: длиннее — перечень обрывается с признаком и числом непоказанных. */
const NATIVE_NAMES_CHARS = 3000;
function nativeNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    const quoted = JSON.stringify(name);
    if (used + quoted.length + 2 > NATIVE_NAMES_CHARS) break;
    shown.push(quoted);
    used += quoted.length + 2;
  }
  const rest = names.length - shown.length;
  return ` Available native names: ${shown.join(', ')}${rest > 0 ? `, … and ${rest} more (find_skill finds them)` : ''}.`;
}
/** Первый пустой поиск допускает одну поправку словами, второй подряд — отказ от поиска до новой задачи. */
const NO_SKILL = 'No skill matched: work without one, or try other words once';
const NO_SKILL_AGAIN = 'No skill matched again: do not search for this task any more, work without a skill';
/** One process owns its promise cache. No shared/global catalog or per-search CLI startup. */
function skillNavigator(context: McpContext): { list: () => Promise<Tool>; find: (args: Record<string, unknown>) => Promise<unknown> } {
  type Built = { catalog: SkillCatalog | null; reason?: string; retry?: boolean };
  const catalogs = new Map<string, Promise<Built>>();
  // Подряд пустых поисков: сбрасывается находкой. Подъём письмом сам повторного поиска не просит (P34).
  let misses = 0;
  async function target(id?: string): Promise<{ session: WorkSession; cwd: string; catalog: SkillCatalog | null; reason?: string }> {
    const map = await readMap(context.projectPath, context.workId);
    const session = map.sessions.find(item => item.id === (id ?? context.sessionId));
    if (!session) throw new Error('Skill search requires a session in this work.');
    const rawCwd = session.worktree?.path ?? context.projectPath;
    let cwd: string;
    try { if (!(await stat(rawCwd)).isDirectory()) throw new Error(); cwd = await realpath(rawCwd); }
    catch { return { session, cwd: rawCwd, catalog: null, reason: 'Participant working directory is unavailable.' }; }
    if (session.provider !== 'codex' && !isClaudeCode(session.provider))
      return { session, cwd, catalog: null, reason: 'This provider has no verified native skill route.' };
    const descriptor = await readNativeContext(context.projectPath, context.workId, session.id);
    const own = session.id === context.sessionId;
    const bound = descriptor !== null && (!own || context.nativeContextRevision !== undefined) && await nativeContextMatches(descriptor, session.provider, cwd,
      own ? context.nativeContextRevision : undefined, session);
    const key = JSON.stringify([session.id, session.provider, cwd, descriptor?.revision ?? 'fixture', bound,
      own ? context.nativeContextRevision : descriptor?.process ?? [session.pid, session.startedAtProcess], session.providerSessionId ?? null]);
    if (!catalogs.has(key)) catalogs.set(key, (async (): Promise<Built> => {
      if (context.skillCatalog) return { catalog: await context.skillCatalog(session, cwd) };
      if (isClaudeCode(session.provider)) {
        // Что модель может загрузить, пишет в транскрипт сам Claude Code: отдельная проверка роли и настроек не нужна.
        // Привязанный дескриптор запуска — источник истины: нет `claudeConfigDir` — значит `~/.claude` (так живёт GLM, у
        // которого хост срезает переменную), и окружение этого сервера (ведущего с `CLAUDE_CONFIG_DIR`) не подмешивается.
        // Без дескриптора — окружение, но только у провайдера, который переменную не срезает (`claudeConfigDirFor`).
        const launch = bound ? descriptor : null;
        const homeDir = launch?.roots.homeDir ?? process.env.HOME ?? homedir();
        // Запись берём из реестра: свой провайдер (`custom-*`) живёт не в `PROVIDERS` (спека своих провайдеров 5.6).
        // Записи нет (провайдер удалён) — тот же отказ, что у неизвестного провайдера, без исключения.
        const entry = (await loadProviders())[session.provider];
        if (!entry) return { catalog: null, reason: 'This provider has no verified native skill route.' };
        const fromEnv = claudeConfigDirFor(entry, process.env);
        const configDir = launch ? launch.roots.claudeConfigDir : fromEnv ? path.resolve(cwd, fromEnv) : undefined;
        const rootsEnv: NodeJS.ProcessEnv = { ...process.env };
        delete rootsEnv.CLAUDE_CONFIG_DIR;
        if (configDir) rootsEnv.CLAUDE_CONFIG_DIR = configDir;
        const built = await readClaudeSkillCatalog({ cwd, homeDir, providerSessionId: session.providerSessionId ?? null,
          ...(configDir ? { configDir } : {}), roots: claudeProjectRoots(rootsEnv, homeDir) });
        // Транскрипта или вложения ещё нет: честная причина, и следующий вызов прочитает заново.
        return 'catalog' in built ? built : { catalog: null, reason: built.reason, retry: true };
      }
      if (!bound || !descriptor?.verified || !descriptor.command) return { catalog: null };
      // Каталог этого запуска сохранил сам запуск (та же ревизия): app-server здесь не нужен. Нет файла (сессию запустила
      // прежняя версия Parley, запись не удалась) или он не годится — прежнее живое чтение.
      const stored = await readNativeSkillCatalog(context.projectPath, context.workId, session.id, descriptor.revision);
      if (stored !== null) return { catalog: stored };
      return { catalog: await readCodexSkillCatalog({ cwd, command: descriptor.command, configArgs: descriptor.configArgs,
        env: { ...process.env, HOME: descriptor.roots.homeDir, CODEX_HOME: descriptor.roots.codexHome ?? path.join(descriptor.roots.homeDir, '.codex') } }) };
    })().catch(() => ({ catalog: null })));
    const built = await catalogs.get(key)!;
    if (built.retry) catalogs.delete(key);
    const { catalog } = built;
    return { session, cwd, catalog, ...(catalog === null ? { reason: built.reason ?? 'Native skill availability or loading route is unverified; use the full native skill list.' } : catalog.partial ? { reason: 'Some native skill metadata or policy could not be verified.' } : {}) };
  }
  return {
    async list() {
      const map = await readMap(context.projectPath, context.workId);
      const provider = map.sessions.find(item => item.id === context.sessionId)?.provider;
      const reduced = context.skillListReduced === true;
      if (provider !== undefined && isClaudeCode(provider)) return reduced ? { ...FIND_SKILL, description: FIND_SKILL.description + CLAUDE_NAMES_ONLY } : FIND_SKILL;
      if (provider !== 'codex') return FIND_SKILL;
      const own = await target();
      // Одноимённые навыки из разных папок в перечне имён — одно имя.
      const names = [...new Set(own.catalog?.skills.filter(skill => skill.modelAvailable).map(skill => skill.name) ?? [])];
      // Каталог прочитан, но доступных навыков нет — о «неудавшемся чтении имён» говорить нечего; фраза нужна только когда имён нет из-за непрочитанного каталога.
      const lead = !reduced ? '' : names.length ? CODEX_NO_LIST : own.catalog === null ? CODEX_NO_LIST_NO_NAMES : '';
      return { ...FIND_SKILL, description: FIND_SKILL.description + lead + nativeNames(names) };
    },
    async find(args) {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('Skill search query must not be empty.');
      const queryBytes = contextBytes(args.query);
      if (queryBytes > CONTEXT_LIMITS.query)
        throw new Error(`Skill search query is ${queryBytes} bytes, the limit is ${CONTEXT_LIMITS.query}: use a few task words.`);
      if (args.for !== undefined && (typeof args.for !== 'string' || !args.for)) throw new Error('Skill search target must be a session id.');
      if (typeof args.for === 'string' && contextBytes(args.for) > SESSION_ID_MAX_BYTES) throw new Error('Skill search target must be a session id.');
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1)) throw new Error('Skill search limit must be a positive integer.');
      const selected = await target(args.for as string | undefined);
      const matches = selected.catalog ? searchSkills(selected.catalog.skills, args.query, (args.limit ?? 5) as number) : [];
      misses = matches.length === 0 ? misses + 1 : 0;
      // Описание режется с пометкой (полный текст — в файле навыка), а ответ целиком держится в бюджете: что не
      // влезло, названо числом в `omitted`, а не пропало молча.
      const skills: unknown[] = [];
      let used = 0;
      for (const { skill } of matches) {
        const description = markedExcerpt(skill.description, CONTEXT_LIMITS.skillDescription).text;
        const entry = { name: skill.name, ...(description ? { description } : {}), source: skill.source,
          load: skill.provider === 'claude' ? `Use the Skill tool with ${JSON.stringify(skill.name)}.` : `Read ${skill.path}.` };
        used += Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (used > FIND_SKILL_MAX_BYTES) break;
        skills.push(entry);
      }
      const omitted = matches.length - skills.length;
      return { provider: selected.session.provider, skills, ...(omitted > 0 ? { omitted } : {}),
        ...(matches.length === 0 ? { message: misses > 1 ? NO_SKILL_AGAIN : NO_SKILL } : {}), ...(selected.reason ? { reason: selected.reason } : {}) };
    },
  };
}

/**
 * Инструменты Parley без транспорта (спека хранилища 6.9, этап 1): то, что отвечает на `tools/list` и `tools/call`, но
 * не знает про MCP-соединение. Сервер процесса агента зовёт исполнитель в своём процессе или пересылает вызовы хосту,
 * а хост исполняет их тем же `createToolRunner` (спека 6.3) — карту тогда открывает только он.
 */
export interface ToolRunner {
  list(): Promise<Tool[]>;
  call(
    name: string,
    args: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
}

/**
 * Исполнитель инструментов одной сессии: список по профилю запуска и навигатор скиллов, привязка треда Codex, разбор
 * вызова и ответ агенту — текстом, а ошибки результатом с `isError`. Браузерных инструментов и `create_session` здесь
 * нет: им нужен канал агента к окну, и они остаются за сервером (`createParleyServer`).
 */
/**
 * Инструменты, которые ничего не пишут от имени сессии: их ограда агента (спека передачи сессии 6.1) не касается.
 * `check_inbox` и `wait_for` сюда не входят — они помечают письма прочитанными.
 */
const AGENT_FENCE_FREE = new Set(['get_map', 'get_capacity', 'read_guide', 'list_roles', 'read_room', 'find_skill', 'memory_read', 'backlog_list', 'search_history', 'attempt_status']);

export const STALE_AGENT = 'This session now continues with another agent: this process belongs to the previous one. Stop working and do not call Parley tools again.';

/**
 * Ограда записей прежнего агента (спека передачи сессии 6.1): у сессии, переведённой на другого агента, в карте
 * `agentRevision`, и процесс с другой ревизией (или без неё — запущен до замены) — осиротевший сервер прежнего агента.
 * Сессия без ревизии в карте не переводилась: ограды нет. Нет сессии в карте — решают сами инструменты.
 */
export async function staleAgent(context: McpContext): Promise<boolean> {
  if (context.sessionId === null) return false;
  const map = await readMap(context.projectPath, context.workId);
  const current = map.sessions.find((session) => session.id === context.sessionId)?.agentRevision ?? null;
  return current !== null && current !== context.agentRevision;
}

export function createToolRunner(context: McpContext): ToolRunner {
  const navigator = context.skillNavigator === true ? skillNavigator(context) : null;
  // Профиль `short` (Codex): три инструмента памяти не объявляются; вызов такого имени уходит в обычный разбор, как и любое неизвестное.
  const declaredInProfile = (tool: Tool): boolean => context.toolProfile !== 'short' || !(SHORT_PROFILE_HIDDEN_TOOLS as readonly string[]).includes(tool.name);
  // Тред Codex привязывается один раз за жизнь исполнителя — с первого вызова, где `_meta.threadId` есть.
  const revision = context.nativeContextRevision;
  const launchRevision = typeof revision === 'string' && THREAD_ID.test(revision) && revision === revision.toLowerCase() ? revision : null;
  const threadBinding: CodexBindingState = { rawBound: false, proofBound: launchRevision === null, root: null, launchRevision };
  return {
    async list() {
      return [...TOOLS.filter(declaredInProfile), ...(navigator ? [await navigator.list()] : [])];
    },
    async call(name, args, meta, signal): Promise<CallToolResult> {
      if (name === 'find_skill' && navigator === null)
        return { content: [{ type: 'text', text: 'Skill navigator is disabled for this launch.' }], isError: true };
      // До самого инструмента: `wait_for` может держать вызов до получаса, а привязка нужна сразу.
      if (!threadBinding.rawBound || !threadBinding.proofBound) await bindCodexThread(context, meta, threadBinding);
      try {
        if (!AGENT_FENCE_FREE.has(name) && await staleAgent(context)) return { content: [{ type: 'text', text: STALE_AGENT }], isError: true };
        const result = name === 'find_skill' ? await navigator!.find(args)
          : await dispatch(context, name, args, signal);
        // Гид — готовый текст: заворачивать его в JSON-строку с экранированием
        // значило бы отдать агенту документ, который ему же и разбирать.
        const text = typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`;
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        // Исчерпанный бюджет — безопасный исход: текст говорит, что расширяет его только человек.
        const text = error instanceof ResourceDeniedError ? deniedForAgent(error) : (error as Error).message;
        return { content: [{ type: 'text', text }], isError: true };
      }
    },
  };
}

/**
 * Сервер MCP одной сессии. Инструменты Parley исполняет `runner`; не передан — свой, в этом процессе (так живут сессии
 * без канала агента). Переданный исполнитель (удалённый, спека хранилища 6.9) карту в этом процессе не открывает,
 * поэтому сторож входящих — он читает карту сам — запускается только без него, а `claude/channel` с его instructions
 * сервер не объявляет: звонков в таком режиме не будет.
 */
export function createParleyServer(context: McpContext, runner?: ToolRunner): Server<Request, ChannelNotification> {
  // Сессии нет — звонить некому: сервер без `PARLEY_SESSION_ID` умеет только
  // отдавать карту и гид (4.2). Нет и сторожа (удалённый исполнитель) — звонить тоже некому: объявить capability значило
  // бы обещать агенту звонки, которых он не дождётся (спека хранилища 6.9).
  const { sessionId } = context;
  const channel = context.channel && sessionId !== null && runner === undefined;
  const server = new Server<Request, ChannelNotification>(
    { name: MCP_SERVER_NAME, version: '0.0.0' },
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

  const tools = runner ?? createToolRunner(context);
  // Инструмент браузера окна (спека браузера 2026-10-07, 3.7) — только при канале агента в окружении сервера.
  const browser = context.agent === undefined ? null : createBrowserTools(context.agent, { clientName: () => server.getClientVersion()?.name });
  const sessionAgent = sessionId === null ? undefined : context.agent;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...await tools.list(), ...(browser?.tools ?? []), ...(sessionAgent ? [CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL, CREATE_SWARM_TOOL, SWARM_ADD_TOOL] : [])],
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      // Инструменты браузера отвечают сами: без канала — отказ с советом перезапустить сессию.
      if (request.params.name.startsWith('browser_')) {
        return browser === null ? { content: [{ type: 'text', text: BROWSER_UNAVAILABLE }], isError: true } : browser.call(request.params.name, args);
      }
      if (request.params.name === 'create_session') {
        return sessionAgent === undefined
          ? { content: [{ type: 'text', text: SESSION_CREATION_UNAVAILABLE }], isError: true }
          : createSession(sessionAgent, args, extra.signal);
      }
      if (request.params.name === 'request_agent_switch') {
        return sessionAgent === undefined
          ? { content: [{ type: 'text', text: AGENT_SWITCH_UNAVAILABLE }], isError: true }
          : requestAgentSwitch(sessionAgent, args, extra.signal);
      }
      if (request.params.name === 'create_swarm' || request.params.name === 'swarm_add') {
        return sessionAgent === undefined
          ? { content: [{ type: 'text', text: SWARM_UNAVAILABLE }], isError: true }
          : (request.params.name === 'create_swarm' ? createSwarm : swarmAdd)(sessionAgent, args, extra.signal);
      }
      return tools.call(request.params.name, args, request.params._meta, extra.signal);
    },
  );

  return server;
}
