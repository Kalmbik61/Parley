import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { claudeProjectRoots } from '../discover.js';
import { readClaudeSkillCatalog } from '../skills/claude-listing.js';
import { readCodexSkillCatalog } from '../skills/context.js';
import { searchSkills } from '../skills/search.js';
import type { SkillCatalog } from '../skills/catalog.js';
import { nativeContextMatches, readNativeContext } from '../work/native-context.js';
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
  EFFORT_LEVELS,
  isClaudeCode,
  providerReadiness,
  providerReadinessError,
  loadProviders,
  modelChoiceError,
  selectableModels,
  supportsEffort,
  supportsModel,
} from '../providers.js';
import { prepareSessionRole, roleFromId, roleId, roleSummaries, sessionRoleCatalog } from '../work/agents.js';
import { writeBrief } from '../work/brief.js';
import { CONTEXT_LIMITS, FIND_SKILL_MAX_BYTES, READ_GUIDE_MAX_BYTES, boundResponse, contextBytes, markedExcerpt } from '../work/context-budget.js';
import {
  PAGE_MAX_BYTES,
  PAGE_MAX_ITEMS,
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
} from '../work/context-pages.js';
import { guide, GUIDE_TOPICS, guideTopic } from '../work/guide.js';
import { unreadFor } from '../work/letters.js';
import { addMessage, addSession, transitionSession } from '../work/map.js';
import { readBacklog } from '../work/backlog.js';
import { listBacklogSuggestions, suggestBacklog } from '../work/backlog-suggestions.js';
import { rememberProjectMemory } from '../work/memory-suggestions.js';
import { HISTORY_SCOPES, HistorySearchError, MAX_SEARCH_LIMIT, searchHistory } from '../work/history-search.js';
import type { HistoryScope } from '../work/history-search.js';
import { readProjectMemory } from '../work/project-memory.js';
import type { MemoryKind } from '../work/project-memory.js';
import { readProjectPreferences } from '../work/project-preferences.js';
import { finishSession } from '../work/metrics.js';
import { PROPOSAL_TEXT_MAX } from '../work/proposals.js';
import {
  admitSpawn,
  assertMessageBudget,
  countRecipients,
  deniedForAgent,
  limitsFromConfig,
  ResourceDeniedError,
  type ResourceLimits,
} from '../work/resource-policy.js';
import { PLAN_DRAFT_SCHEMA, PLAN_TOOLS, isPlanTool, planTool } from './plan-tools.js';
import { addMemberByLead, addRoom, isDescendant, isMember, joinNotice, leaveOtherRooms } from '../work/rooms.js';
import { displayStatus } from '../work/status-view.js';
import { SharedStateError, inspectSharedIgnore, readMap, readWorksIndex, sharedProjectPaths, updateMap, workPaths } from '../work/store.js';
import { participantLabel, threadOf } from '../work/thread.js';
import {
  MESSAGE_KINDS,
  SYSTEM,
  type Artifact,
  type Message,
  type Room,
  type WorkMap,
  type WorkSession,
} from '../work/types.js';
import { baseBranchOf, isGitRepo, plannedWorktree } from '../work/worktree.js';
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
  };
};

/**
 * Окно писем (разговор агентов, 4.7): два вежливых агента способны отвечать
 * друг другу, пока не кончится лимит подписки, поэтому сервер считает письма
 * этой сессии за последний час по всей карте. Скользящий час отличает петлю от
 * честной долгой работы и восстанавливается сам; состояния нет — всё в карте.
 */
function assertRate(map: WorkMap, sessionId: string, limit: number, now: number, needed = 1): void {
  const recent = map.messages.filter(
    (message) => message.from === sessionId && now - Date.parse(message.at) < RATE_WINDOW_MS,
  ).length;
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

/** Чтения — карта, лента комнаты, гид, ожидание: на диск ничего не пишут, отметок прочтения не ставят. */
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

const TOOLS: Tool[] = [
  ...PLAN_TOOLS,
  {
    name: 'backlog_list', annotations: READS,
    description: 'Read this project backlog before suggesting work outside your task. Reads never create files or assign IDs.',
    inputSchema: { type: 'object', properties: {
      filter: { type: 'string', enum: ['open', 'taken', 'done', 'all'], default: 'open' },
      text: { type: 'string', maxLength: 4096 },
    }, additionalProperties: false },
  },
  {
    name: 'backlog_suggest', annotations: WRITES,
    description: 'Propose one worthwhile finding outside your task with a reason. The project rule decides whether to add it or ask the human. Cannot edit, close, or remove existing items.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['bug', 'debt', 'idea'] }, title: { type: 'string', minLength: 1, maxLength: 4096 },
      details: { type: 'string', maxLength: 65536 }, why: { type: 'string', minLength: 1, maxLength: 16384 },
    }, required: ['kind', 'title', 'why'], additionalProperties: false },
  },
  {
    name: 'remember', annotations: WRITES,
    description: 'Propose one lasting fact, lesson or agreement about this project, with a reason. It waits for the human to accept it, unless the human has just asked you to remember it: then set onHumanRequest. One fact per call, short; do not store what the code, git, PARLEY.md or CLAUDE.md already say.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['fact', 'lesson', 'agreement'] }, fact: { type: 'string', minLength: 1, maxLength: 4096 },
      details: { type: 'string', maxLength: 65536 }, why: { type: 'string', minLength: 1, maxLength: 16384 },
      onHumanRequest: { type: 'boolean', description: 'Only when the human asked you in this conversation to remember it.' },
    }, required: ['kind', 'fact', 'why'], additionalProperties: false },
  },
  {
    name: 'memory_read', annotations: READS,
    description: 'Read the project memory with details: all entries, or only the given ids (m-NNN). The memory phrases are already in your instructions; this adds the details. Current human instructions take precedence over memory.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'string', pattern: '^m-\\d{3,}$' }, maxItems: 100 },
    }, additionalProperties: false },
  },
  {
    name: 'search_history', annotations: READS,
    description: `Search this project's past before deciding something big: accepted decisions, memory, plans, backlog, room histories and session results. All words of the query must meet in one entry. scope: ${HISTORY_SCOPES.join(', ')} (default all). Does not search skills.`,
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
      'The compact workspace map: sessions with statuses, rooms, current plan revisions, unread counts and message cursors — plus the list of registry providers with an availability flag in PATH and what the provider accepts at launch (models and effort for spawn_session). Long texts, history, summaries, artifacts and messages are not in it: they come as bounded pages through the parameters (a cut field names its full size). Call it first; the detailed guide is the read_guide tool',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id (s-NN): that session in detail, or with field the one field of it.' },
        room: { type: 'string', description: 'Room id (r-NN): that room in full, or with field messages its message pages. Without field only participants read a room.' },
        field: {
          type: 'string',
          enum: ['goal', 'title', 'task', 'summary', 'history', 'artifacts', 'contextFrom', 'messages', 'message', 'summaries', 'archive'],
          description: 'goal/title — the workspace texts; task/summary/history/artifacts/contextFrom — one field of session; messages — message pages of room (without room — your direct messages), newest first; message — the text of the message id; summaries — summaries of all sessions; archive — other workspaces of this project.',
        },
        id: { type: 'string', description: 'Message id (m-NN) for field message.' },
        kind: { type: 'string', enum: [...MESSAGE_KINDS], description: 'Only messages of this kind (field messages); decision lists the decisions of a room.' },
        cursor: { type: 'string', description: 'The `next` of the previous page: continues it without gaps or repeats. Messages: a cursor before:N goes to older ones, after:N to newer ones.' },
        maxBytes: { type: 'integer', minimum: PAGE_MIN_BYTES, maximum: PAGE_MAX_BYTES, description: 'Page size limit in bytes; the default is 65536.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report',
    annotations: WRITES,
    description:
      'A report on your own session. done or failed — the result is handed in, the session stays reachable and does not close itself; progress — an intermediate summary without changing the result. A repeated call overwrites the summary and the artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['done', 'failed', 'progress'] },
        summary: { type: 'string', description: 'A summary of the result in two or three sentences.' },
        artifacts: {
          type: 'array',
          description: 'Result files; the path is relative to the project root.',
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
    name: 'list_roles', annotations: READS, description: 'List current builtin and native roles in the participant working folder, without prompts or file paths.', inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'spawn_session',
    annotations: WRITES,
    description:
      'Creates a session of another agent in this same workspace: checks the provider against the registry and the command in PATH, assembles the brief and creates a pending record. Parley will launch it.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider id from get_map.' },
        label: { type: 'string', description: 'Session role: "plan", "backend", "review".' },
        task: { type: 'string', description: 'What the new session should do.' },
        contextFrom: {
          type: 'array',
          description: 'Ids of sessions whose summaries and artifacts go into the brief.',
          items: { type: 'string' },
        },
        role: { type: 'string', description: 'Source-qualified role id from list_roles. Provider may override a builtin default; native provider must match.' },
        agent: {
          type: 'string',
          description:
            'Legacy Claude role alias: exact metadata.name from a native agent definition. A definition with a trimmed tools list must include mcp__parley__*, otherwise the role can neither write to a colleague nor report.',
        },
        worktree: {
          type: 'boolean',
          description:
            "Isolate the session in its own git worktree — its edits do not touch the project's working copy until it is decided to merge them (the window's Changes panel). Only for a project with git; Parley itself creates it before the launch.",
        },
        model: {
          type: ['string', 'null'],
          description:
            "The new session's model: an id from the models field of its provider in get_map. Not from the list — an error, the session is not created. A provider that does not accept a model as a flag drops the value. Omitted or empty string — the current role default, otherwise the provider default. Exact null explicitly clears the role default and uses the provider CLI default.",
        },
        effort: {
          type: ['string', 'null'],
          enum: [...EFFORT_LEVELS, null],
          description:
            "The new session's reasoning effort. A provider with effort: false in get_map drops the value. Omitted or empty string — the current role default, otherwise the provider default. Exact null explicitly clears the role default and uses the provider CLI default.",
        },
      },
      required: ['label', 'task'],
    },
  },
  {
    name: 'wait_for',
    annotations: READS,
    description:
      'Waits for a session to finish (target is its id) or for an incoming message (target = "inbox"). On timeout it returns {"state":"running"} — decide yourself whether to call again. {"state":"deleted"} means the human deleted the session: there is nothing left to wait for. Giving a new job to a session that has already handed in its report? Wait for its answer with target = "inbox", not by id: by id the old result comes back at once.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A session id or "inbox".' },
        timeoutSec: {
          type: 'number',
          description: `How long to wait; the default is ${DEFAULT_TIMEOUT_SEC}, the maximum is ${MAX_TIMEOUT_SEC}.`,
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'send_message',
    annotations: WRITES,
    description:
      'Puts a message into the correspondence. Without room — to exactly one addressee in the workspace. With room — the sender and the addressees must be participants of the room; an empty or missing to is a broadcast to all participants. Answer only a question: a note and a decision need no answer.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          description:
            'An addressee id, or several at once. Without room — exactly one; with room and no to — a broadcast to the room.',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        text: { type: 'string' },
        kind: {
          type: 'string',
          enum: [...MESSAGE_KINDS],
          description:
            'question — waiting for an answer; decision — we have agreed; note — a note (the default).',
        },
        room: { type: 'string', description: 'Room id from get_map; without it the message is direct.' },
        replyTo: {
          type: 'string',
          description:
            'Id of the message in this room you are answering (from check_inbox or read_room), above all a question from the human: the window shows a quote of it above your message. Only together with room.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'check_inbox',
    annotations: WRITES,
    description:
      "Returns this session's unread messages — direct ones and those from its rooms, including broadcasts — and marks them as read. Each message carries the sender's label and the room, if there is one.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_room',
    annotations: WRITES,
    description:
      "Creates a room — a standing circle of conversation for several sessions, usually your own subordinates. The caller becomes the creator and a participant; the other participants get a message about being added. One room per session: both you and the participants leave the workspace's other rooms. The room's lead collects the participants' positions and brings the human a decision (propose_decision): without lead, the lead is you.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        members: {
          type: 'array',
          description: 'Ids of the participant sessions from get_map; you do not need to list yourself.',
          items: { type: 'string' },
        },
        lead: {
          type: 'string',
          description:
            "The lead's id: yours or one of members. Without it you are the lead; not from the room's circle — an error, the room is not created.",
        },
      },
      required: ['title', 'members'],
    },
  },
  {
    name: 'add_to_room',
    annotations: WRITES,
    description:
      "The lead brings one more session of this workspace into the room — for example, an executor just spawned. Lead only (get_map, the room's lead field); the room is not closed, the session is alive and not yet a participant. One room per session: it leaves the workspace's other rooms, and a line \"@s04 joined the room\" appears in the feed. The new participant gets no message about being added — write to it in the room yourself, saying what you expect.",
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id from get_map.' },
        session: {
          type: 'string',
          description: 'Id of a session of this workspace from get_map; a closed or foreign one is an error.',
        },
      },
      required: ['room', 'session'],
    },
  },
  {
    name: 'read_room',
    annotations: READS,
    description:
      "The room's feed for context — the last limit messages within the byte limit, without read marks; `page.next` continues to older ones. Available only to participants.",
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id from get_map.' },
        limit: { type: 'number', description: 'How many of the latest messages to return; the default is 50.' },
        cursor: { type: 'string', description: 'The `next` of the previous page: older messages (before:N) or newer ones (after:N).' },
        maxBytes: { type: 'integer', minimum: PAGE_MIN_BYTES, maximum: PAGE_MAX_BYTES, description: 'Page size limit in bytes; the default is 65536. A message that does not fit is cut with its full size named (textBytes); get_map with field message reads it whole.' },
      },
      required: ['room'],
    },
  },
  {
    name: 'propose_decision',
    annotations: WRITES,
    description:
      "The room's lead proposes a decision: it lands as a card in the window and waits for the human's answer — accept or return for rework. Lead only (get_map, the room's lead field); in a closed room — an error. Call it when the participants' positions are collected; do not start the work before acceptance. A repeat before the human's answer replaces the text (the same proposalId, rev + 1). The answer will reach you as a message: accepted — hand out the parts, returned — redo it and propose again.",
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room id from get_map.' },
        plan: PLAN_DRAFT_SCHEMA,
        kind: { type: 'string', enum: ['decision', 'completion'] },
        planId: { type: 'string', pattern: '^pl-[0-9]+$', maxLength: 128 },
        rev: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        text: {
          type: 'string',
          description: `The whole decision, up to ${PROPOSAL_TEXT_MAX} characters: what we do and which part each takes; name participants with @s02 mentions.`,
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
      "Closes a session for good: it no longer receives messages, and auto-wake does not start it. The target is the session itself or its descendant. Call it only after the human's explicit consent.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'A session id: your own or a descendant spawned down the chain.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'read_guide',
    annotations: READS,
    description: `The detailed guide to Parley: entities, the session lifecycle, rooms and the roles in them (lead, participant), what to put in a report and artifacts, how to wait for a subordinate session, what not to do. Read it when the short descriptions were not enough. Without topic — the whole guide, with topic — one section: ${GUIDE_TOPICS.map((item) => item.topic).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: GUIDE_TOPICS.map((item) => item.topic),
          description: 'A guide section; without it — the whole guide.',
        },
      },
      additionalProperties: false,
    },
  },
];

async function getMap(context: McpContext, args: Record<string, unknown> = {}): Promise<unknown> {
  const map = await readMap(context.projectPath, context.workId);
  if (Object.keys(args).length > 0) return mapPage(context, map, args);
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
  // Плейбук рецепта получает только ведущий (слоем и письмом): в топологии агенту видны id и имя рецепта.
  return { sessionId: context.sessionId, map: mapTopology(map, context.sessionId), providers };
}

const optionalString = (args: Record<string, unknown>, name: string): string | undefined => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`argument ${name}: expected a string`);
  return value;
};

/**
 * Прямое письмо видно сессии, если оно в её треде (родитель и дети делят письма, одинокий корень видит все) или
 * оно её собственное; письмо комнаты — участнику комнаты, как в `read_room`. Прежний `get_map` отдавал все письма
 * работы всем, страницы — только то, что сессии положено читать.
 */
function canReadMessage(map: WorkMap, message: Message, sessionId: string, thread: ReadonlySet<string>): boolean {
  if (message.roomId === null) return thread.has(message.id) || message.from === sessionId || message.to.includes(sessionId);
  const room = map.rooms.find((candidate) => candidate.id === message.roomId);
  return room !== undefined && isMember(room, sessionId);
}

/** Ограниченные страницы `get_map`: поле, список или письма — по параметрам; без параметров карту отдаёт `getMap`. */
async function mapPage(context: McpContext, map: WorkMap, args: Record<string, unknown>): Promise<unknown> {
  const maxBytes = clampPageBytes(numberArg(args, 'maxBytes'));
  const field = optionalString(args, 'field');
  const sessionId = optionalString(args, 'session');
  const roomId = optionalString(args, 'room');
  const cursorRaw = optionalString(args, 'cursor');
  try {
    if (field === undefined) {
      if (sessionId !== undefined) {
        const session = requireSession(map, sessionId);
        const entry = mapTopology(map, context.sessionId).sessions.find((candidate) => candidate.id === sessionId);
        return { session: { ...entry, artifacts: session.artifacts.slice(0, 20), history: session.history.slice(-20) } };
      }
      if (roomId !== undefined) {
        const room = requireRoom(map, roomId);
        const topology = mapTopology(map, context.sessionId).rooms.find((candidate) => candidate.id === roomId);
        const { recipe, recipeLeadNotified, ...rest } = room;
        void recipeLeadNotified;
        // Решение целиком (до 10000 знаков) — здесь, а не в общей топологии.
        return { room: { ...rest, recipe: recipe == null ? null : { id: recipe.id, name: recipe.name } }, messages: topology?.messages };
      }
      throw new Error('give session, room or field; without parameters get_map returns the compact map');
    }
    if (field === 'goal' || field === 'title') return { field, ...textPage(map.work[field], cursorRaw, maxBytes) };
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
        view: (session) => ({ id: session.id, label: session.label, status: displayStatus(session), source: session.summarySource, text: session.summary ?? '' }),
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
        const message = map.messages.find((candidate) => candidate.id === id);
        if (message === undefined || !canReadMessage(map, message, caller, new Set(threadOf(map, caller).messages.map((row) => row.id)))) throw new PageError('unknown-target', `message ${id} is not available to this session`);
        return { id, from: message.from, at: message.at, roomId: message.roomId, ...textPage(message.text, cursorRaw, maxBytes) };
      }
      let filter: ((message: Message) => boolean) | undefined;
      if (roomId === undefined) {
        const thread = new Set(threadOf(map, caller).messages.map((row) => row.id));
        filter = (message) => canReadMessage(map, message, caller, thread);
      }
      else if (!isMember(requireRoom(map, roomId), caller)) throw new Error(`session ${caller} is not a participant of room ${roomId}`);
      const kind = optionalString(args, 'kind');
      if (kind !== undefined && !(MESSAGE_KINDS as readonly string[]).includes(kind)) throw new Error(`argument kind: one of ${MESSAGE_KINDS.join(', ')}`);
      return messagePage(map, {
        roomId: roomId ?? null,
        ...(kind === undefined ? {} : { kind: kind as Message['kind'] }),
        ...(filter === undefined ? {} : { filter }),
        cursor: parseCursor(cursorRaw),
        maxBytes,
        view: (message) => messageView(message, map),
      });
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
  if (args['agent'] !== undefined && args['role'] !== undefined) throw new Error('agent-and-role-conflict');
  const savedRole = args['role'] === undefined ? (args['agent'] === undefined ? null : { source: 'claude' as const, name: stringArg(args, 'agent') }) : roleFromId(stringArg(args, 'role'));
  if (!savedRole && args['provider'] === undefined) throw new Error('provider is required without a role');
  const catalog = savedRole ? await (context.roleCatalog ? context.roleCatalog(context.projectPath) : sessionRoleCatalog(context.projectPath, { codex: savedRole.source === 'codex' })) : undefined;
  const provider = args['provider'] === undefined ? (catalog?.roles.find(role => role.id === roleId(savedRole))?.provider ?? 'claude') : stringArg(args, 'provider');
  const label = stringArg(args, 'label');
  const task = stringArg(args, 'task');
  const contextFrom = stringsArg(args, 'contextFrom');
  // Роль необязательна: без неё сессия идёт обычным агентом провайдера.
  // Изоляция необязательна: без флага сессия работает прямо в каталоге проекта.
  const worktree = args['worktree'] === true;
  // Модель и усилие тоже необязательны; пустая строка — как отсутствие: агенты шлют её на любой
  // необязательный параметр. Только явный null очищает default роли до default CLI.
  const model =
    args['model'] === undefined || args['model'] === '' ? undefined : args['model'] === null ? null : stringArg(args, 'model');
  const effort =
    args['effort'] === undefined || args['effort'] === '' ? undefined : args['effort'] === null ? null : enumArg(args, 'effort', EFFORT_LEVELS);

  const registry = await loadProviders();
  const entry = registry[provider];
  if (entry === undefined) {
    throw new Error(
      `unknown provider ${provider}; allowed: ${Object.keys(registry).join(', ')}`,
    );
  }
  const refusal = providerReadinessError(entry, await providerReadiness(entry));
  if (refusal !== null) throw new Error(refusal);

  // Модель проверяем до записи, как и роль: значение не из списка провайдера — отказ, а не `pending`,
  // который нечем запустить. Провайдер, чей шаблон запуска не принимает флаг, выбор отбрасывает молча —
  // как `sessions.create` хоста: окно узнаёт об этом из `providers.list`, агент — из `get_map`.
  let chosenModel: string | null | undefined = model === null && supportsModel(entry) ? null : undefined;
  if (model !== undefined && model !== null) {
    const refusal = modelChoiceError(entry, model);
    if (refusal !== null) throw new Error(refusal);
    if (supportsModel(entry)) chosenModel = model;
  }
  const chosenEffort = effort !== undefined && supportsEffort(entry) ? effort : undefined;

  await prepareSessionRole(context.projectPath, entry, { roleId: roleId(savedRole), provider, mode: 'create' }, catalog);

  // База worktree — та же причина, что и роль: пропускаем до записи в карту, а
  // не после. `updateMap` мутирует карту синхронно, поэтому асинхронные проверки
  // git идут заранее (спецификация 8.1).
  let worktreeBase: string | null = null;
  if (worktree) {
    if (!(await isGitRepo(context.projectPath))) {
      throw new Error('the project has no git — a worktree cannot be created');
    }
    const parent = requireSession(await readMap(context.projectPath, context.workId), sessionId);
    worktreeBase =
      parent.worktree !== null ? parent.worktree.branch : await baseBranchOf(context.projectPath);
  }

  const limits = await limitsOf(context);
  let created = '';
  const map = await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, sessionId);
    for (const id of contextFrom) requireSession(current, id);
    // Допуск и запись сессии — одна мутация под замком карты: отказ не оставляет ни сессии, ни резерва, а параллельные
    // вызовы разных агентов видят слоты друг друга.
    const attempt = admitSpawn(current, { actor: sessionId, limits });
    const session = addSession(current, {
      provider,
      label,
      task,
      parent: sessionId,
      contextFrom,
      role: savedRole,
      ...(chosenModel === undefined ? {} : { model: chosenModel }),
      ...(chosenEffort === undefined ? {} : { effort: chosenEffort }),
    });
    created = session.id;
    attempt.session = session.id;
    if (worktreeBase !== null) {
      // Сам worktree на диске заводит хост перед запуском (кусок 4.2); здесь —
      // только план с `createdAt: null`.
      session.worktree = plannedWorktree(
        context.projectPath,
        context.workId,
        session.id,
        worktreeBase,
        context.worktreeRoot ?? DEFAULT_CONFIG.worktreeRoot,
      );
    }
  });
  await writeBrief(context.projectPath, map, created);
  return { sessionId: created };
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

async function waitFor(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const target = stringArg(args, 'target');
  const waitId = randomUUID();
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

  // Реальное ожидание начинается, когда первая проба вернула `null`; ответ без ожидания —
  // итог уже есть, письмо уже пришло, неизвестный id — следов в журнале не оставляет. Конец
  // ждёт записи начала: строки идут по порядку, что бы ни случилось с ожиданием.
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
    const found = await waitForMap(
      workPaths(context.projectPath, context.workId).map,
      probeAndNote,
      timeoutMs,
      context.pollMs ?? POLL_MS,
      signal,
    );
    return found ?? { state: 'running' };
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

  const limits = await limitsOf(context);
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
        throw new Error(`session ${sessionId} is not a participant of room ${roomId}`);
      }
      for (const memberId of to) {
        if (!isMember(room, memberId)) {
          throw new Error(`session ${memberId} is not a participant of room ${roomId}`);
        }
        assertDeliverable(current, memberId);
      }
      // Ответ (Parley 0.3.0): цитировать можно только сообщение этой же комнаты — несуществующий id, чужая
      // комната и прямое письмо дают отказ. Сверка идёт под тем же замком, что и запись: карта между ними
      // не устареет, как у проверок участников выше.
      if (replyTo !== null) {
        const quoted = current.messages.find((message) => message.id === replyTo);
        if (quoted?.roomId !== roomId) {
          throw new Error(`message ${replyTo} is not in room ${roomId}`);
        }
      }
      assertMessageBudget(current, {
        actor: sessionId,
        room: roomId,
        messages: 1,
        recipients: countRecipients(current, sessionId, roomId, to),
        limits,
      });
      // Пустой to в комнате — рассылка всем участникам (recipientsOf её и разберёт).
      created = addMessage(current, {
        from: sessionId,
        to,
        text,
        kind,
        roomId,
        ...(replyTo === null ? {} : { replyTo }),
      }).id;
    } else {
      // Цитата живёт в ленте комнаты: у прямого письма её нет, и молча отбросить `replyTo` значило бы
      // обмануть агента, ждущего цитаты.
      if (replyTo !== null) throw new Error('replyTo works only together with room');
      if (to.length !== 1) {
        throw new Error('without room, exactly one addressee in to is required');
      }
      const target = to[0] as string;
      assertDeliverable(current, target);
      assertMessageBudget(current, { actor: sessionId, room: null, messages: 1, recipients: 1, limits });
      created = addMessage(current, { from: sessionId, to: [target], text, kind }).id;
    }
  });
  const warning = unknownParamsWarning(args);
  return warning === null ? { messageId: created } : { messageId: created, warning };
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
  const leadInput = optionalStringArg(args, 'lead');

  const limits = await limitsOf(context);
  let roomId = '';
  await updateMap(context.projectPath, context.workId, (current) => {
    requireSession(current, sessionId);
    // Повторы схлопнуты, себя в список участников не добавляем — создатель и
    // так участник (спецификация 6.1).
    const members = [...new Set(membersInput)].filter((id) => id !== sessionId);
    for (const memberId of members) {
      const member = requireSession(current, memberId);
      if (member.lifecycle === 'closed') {
        throw new Error(`session ${memberId} is closed: it cannot be added to the room`);
      }
    }
    // Приглашение — письмо от создателя каждому участнику: оно расходует тот же бюджет писем, что и `send_message`,
    // иначе исчерпанный лимит обходился бы созданием комнаты.
    if (members.length > 0) {
      assertRate(current, sessionId, context.messageRate ?? DEFAULT_CONFIG.messageRate, Date.now(), members.length);
      assertMessageBudget(current, { actor: sessionId, room: null, messages: members.length, recipients: members.length, limits });
    }

    // Без `lead` ведущий — вызывающий: агент заводит комнату для своих подчинённых и ведёт её сам
    // (в handoff «Created by S01 · lead S01»). Правило «первый из members» (дизайн комнат, 3.1) — для
    // `rooms.create` окна и старых карт, здесь оно отдало бы комнату подчинённому. Ведущего не из круга
    // комнаты `addRoom` отвергает до выдачи номера: комнаты нет, номер не потрачен.
    const room = addRoom(current, {
      title,
      creator: sessionId,
      members,
      lead: leadInput ?? sessionId,
    });
    roomId = room.id;
    // Одна комната на сессию (решение 4 дизайна комнат): создатель и участники уходят из прочих комнат работы — как у
    // `rooms.create` окна (`createHumanRoom`) и у `add_to_room`. Прежние комнаты остаются со своими письмами.
    for (const memberId of [sessionId, ...members]) leaveOtherRooms(current, memberId, room.id);
    const notice = joinNotice(room, current);
    for (const memberId of members) {
      addMessage(current, { from: sessionId, to: [memberId], roomId: room.id, kind: 'note', text: notice });
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
  await updateMap(context.projectPath, context.workId, (current) => {
    // Правила — ведущий, живая комната, закрытая или чужая сессия, уже участник, одна комната на сессию —
    // держит `addMemberByLead`. Его `RoomRuleError` уходит агенту текстом ошибки, как у `propose_decision`,
    // а исключение из мутатора не даёт `updateMap` записать карту: после отказа она не меняется.
    // Допуска бюджета здесь нет намеренно (P37): `addMemberByLead` пишет только системную строку «joined the room»
    // (`from: system`, адресат — человек), она никого не будит, не рассылается и в бюджет писем не входит. Письма
    // приглашённому здесь нет, в отличие от `create_room`; разговорная квота управление комнатой не блокирует.
    messageId = addMemberByLead(current, roomId, sessionId, target).id;
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
  if (!isMember(room, sessionId)) {
    throw new Error(`session ${sessionId} is not a participant of room ${roomId}`);
  }

  // Хвост комнаты в пределах байтов: письмо, которое одно не влезает, сокращается с полным размером, а старее —
  // по `page.next`. Прежний ответ был `limit` писем любого размера.
  try {
    return messagePage(map, {
      roomId,
      cursor: parseCursor(optionalString(args, 'cursor')),
      maxBytes: clampPageBytes(numberArg(args, 'maxBytes')),
      maxItems: Math.min(Math.max(Math.floor(limit), 1), PAGE_MAX_ITEMS),
      view: (message) => messageView(message, map),
    });
  } catch (error) {
    if (error instanceof PageError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

async function proposeDecision(
  context: McpContext,
  _sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return planTool(context, 'propose_decision', args);
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
  if (raw === undefined || raw === '') return boundedGuide(guide(context.skillNavigator === true), 'The whole guide');
  if (typeof raw !== 'string') throw new Error('argument topic: expected a string');
  const text = guideTopic(raw.trim().toLowerCase(), context.skillNavigator === true);
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
    if (target !== sessionId && !isDescendant(current, sessionId, target)) {
      throw new Error(
        `session ${target} is not subordinate to ${sessionId}: close_session closes only itself or a descendant`,
      );
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
    if (result.status !== 'duplicate' && map.rooms.some(room => room.members.includes(sessionId))) {
      try {
        await updateMap(context.projectPath, context.workId, current => {
          const label = sessionId.replace(/^s-/, 'S');
          const text = `${label} ${result.status === 'added' ? 'added to' : 'suggested for'} the backlog: ${args.title as string}`;
          for (const room of current.rooms.filter(row => row.members.includes(sessionId)))
            addMessage(current, { from: SYSTEM, to: [], text, kind: 'note', roomId: room.id });
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
    if (result.status !== 'duplicate' && map.rooms.some(room => room.members.includes(sessionId))) {
      try {
        await updateMap(context.projectPath, context.workId, current => {
          const label = sessionId.replace(/^s-/, 'S');
          const fact = args.fact as string;
          const brief = fact.length > FEED_FACT_LENGTH ? `${fact.slice(0, FEED_FACT_LENGTH)}…` : fact;
          // The agent only claims that the human asked: the line says so instead of vouching for it.
          const text = result.status === 'remembered' ? `${label} remembered, saying you asked for it: ${brief}` : `${label} suggests remembering: ${brief}`;
          for (const room of current.rooms.filter(row => row.members.includes(sessionId)))
            addMessage(current, { from: SYSTEM, to: [], text, kind: 'note', roomId: room.id });
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
  if (name === 'get_map') return getMap(context, args);
  if (name === 'list_roles') {
    const map = await readMap(context.projectPath, context.workId);
    const caller = map.sessions.find(item => item.id === context.sessionId);
    const cwd = caller?.worktree?.path ?? context.projectPath;
    return roleSummaries(await (context.roleCatalog ? context.roleCatalog(cwd) : sessionRoleCatalog(cwd, { codex: true })));
  }
  // Гид не про конкретную сессию: он доступен и без `PARLEY_SESSION_ID`.
  if (name === 'read_guide') return readGuide(context, args);

  if (isPlanTool(name)) return planTool(context, name, args);
  const { sessionId } = context;
  if (sessionId === null) throw new Error(NO_SESSION);

  if (name === 'report') return report(context, sessionId, args);
  if (name === 'spawn_session') return spawnSession(context, sessionId, args);
  if (name === 'wait_for') return waitFor(context, sessionId, args, signal);
  if (name === 'send_message') return sendMessage(context, sessionId, args);
  if (name === 'check_inbox') return checkInbox(context, sessionId);
  if (name === 'create_room') return createRoom(context, sessionId, args);
  if (name === 'add_to_room') return addToRoom(context, sessionId, args);
  if (name === 'read_room') return readRoom(context, sessionId, args);
  if (name === 'propose_decision') return proposeDecision(context, sessionId, args);
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
 * `true` — вопрос закрыт (записано, уже записано, сессия не codex) и дальше спрашивать не нужно; `false` —
 * подходящего id в `_meta` нет или сбой записи, попробует следующий вызов. Ошибки наружу не идут:
 * привязка не должна ронять вызов инструмента.
 */
async function bindCodexThread(
  context: McpContext,
  meta: Record<string, unknown> | undefined,
): Promise<boolean> {
  const { sessionId } = context;
  const threadId = meta?.['threadId'];
  if (sessionId === null || typeof threadId !== 'string' || !THREAD_ID.test(threadId)) return false;
  const thread = threadId.toLowerCase();
  const root = meta?.['sessionId'];
  if (typeof root === 'string' && THREAD_ID.test(root) && root.toLowerCase() !== thread) return false;
  try {
    // Чтение до записи: `updateMap` переписал бы карту и без изменений, а её читают наблюдатели окна.
    const known = (await readMap(context.projectPath, context.workId)).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (known === undefined) return false;
    if (known.provider !== 'codex' || known.providerSessionId === thread) return true;
    await updateMap(context.projectPath, context.workId, (current) => {
      const target = current.sessions.find((candidate) => candidate.id === sessionId);
      if (target !== undefined && target.provider === 'codex') target.providerSessionId = thread;
    });
    return true;
  } catch (error) {
    process.stderr.write(`parley-mcp: could not record the thread binding: ${(error as Error).message}\n`);
    return false;
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
        const homeDir = descriptor?.roots.homeDir ?? process.env.HOME ?? homedir();
        const configDir = descriptor?.roots.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR ? path.resolve(cwd, process.env.CLAUDE_CONFIG_DIR) : undefined);
        const built = await readClaudeSkillCatalog({ cwd, homeDir, providerSessionId: session.providerSessionId ?? null,
          ...(configDir ? { configDir } : {}), roots: claudeProjectRoots({ ...process.env, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) }, homeDir) });
        // Транскрипта или вложения ещё нет: честная причина, и следующий вызов прочитает заново.
        return 'catalog' in built ? built : { catalog: null, reason: built.reason, retry: true };
      }
      if (!bound || !descriptor?.verified || !descriptor.command) return { catalog: null };
      return { catalog: await readCodexSkillCatalog({ cwd, command: descriptor.command, configArgs: descriptor.configArgs,
        env: { ...process.env, HOME: descriptor.roots.homeDir, CODEX_HOME: descriptor.roots.codexHome ?? path.join(descriptor.roots.homeDir, '.codex') },
        homeDir: descriptor.roots.homeDir, ...(descriptor.roots.codexHome ? { codexHome: descriptor.roots.codexHome } : {}) }) };
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
      const names = own.catalog?.skills.filter(skill => skill.modelAvailable).map(skill => skill.name) ?? [];
      const lead = reduced ? (names.length ? CODEX_NO_LIST : CODEX_NO_LIST_NO_NAMES) : '';
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

export function createParleyServer(context: McpContext): Server<Request, ChannelNotification> {
  // Сессии нет — звонить некому: сервер без `PARLEY_SESSION_ID` умеет только
  // отдавать карту и гид (4.2).
  const { sessionId } = context;
  const channel = context.channel && sessionId !== null;
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

  const navigator = context.skillNavigator === true ? skillNavigator(context) : null;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: navigator ? [...TOOLS, await navigator.list()] : TOOLS }));
  // Тред Codex привязывается один раз за жизнь сервера — с первого вызова, где `_meta.threadId` есть.
  let threadBound = false;
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      if (request.params.name === 'find_skill' && navigator === null)
        return { content: [{ type: 'text', text: 'Skill navigator is disabled for this launch.' }], isError: true };
      // До самого инструмента: `wait_for` может держать вызов до получаса, а привязка нужна сразу.
      if (!threadBound) threadBound = await bindCodexThread(context, request.params._meta);
      try {
        const result = request.params.name === 'find_skill' ? await navigator!.find(args)
          : await dispatch(context, request.params.name, args, extra.signal);
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
  );

  return server;
}
