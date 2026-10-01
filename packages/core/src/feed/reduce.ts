/**
 * Редьюсер ленты вида «Chat» (план 2026-10-01, Task 1): событие хука Claude Code → элементы ленты.
 * Чистый: порядок — порядок прихода событий, время приходит снаружи, диска и часов нет. Кольцо
 * держит хост — редьюсер о нём не знает и ищет элементы в том, что ему оставили.
 *
 * Разбор общих полей хука (`agent_id`, `agent_type`, `transcript_path`, `background_tasks`) — тот же,
 * что у журнала `events/` (`eventRecordOf`), чтобы лента и активность не расходились.
 *
 * `PreToolUse` доходит до хоста для всех инструментов, но лента терпит и неполный поток (хук не
 * дошёл, сессию подняли посреди хода): вызов, карточку разрешения и карточку агента заводит то
 * событие, которое пришло первым.
 */

import { eventRecordOf, isRecord, textOf, type EventRecord } from '../work/events.js';
import { isHookNoise } from './noise.js';
import {
  FEED_AGENT_TEXT_LIMIT,
  FEED_INPUT_LIMIT,
  FEED_PATCH_LINES,
  FEED_RESULT_LIMIT,
  FEED_TEXT_LIMIT,
  type FeedAgent,
  type FeedCard,
  type FeedCardState,
  type FeedDecision,
  type FeedItem,
  type FeedPatchHunk,
  type FeedPermissionCard,
  type FeedQuestion,
  type FeedQuestionCard,
  type FeedState,
  type FeedStream,
  type FeedText,
  type FeedTool,
  type FeedToolResponse,
  type FeedToolStatus,
  type FeedUpdate,
} from './types.js';

/** Инструмент субагента: `Agent`, у старых сборок — `Task`. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';
const TASK_NOTIFICATION = '<task-notification>';
/** Поля ответа правки, которые в сводку не идут: исходный файл, хунки и новое содержимое. */
const PATCH_BULK_KEYS = new Set(['originalFile', 'structuredPatch', 'content']);
/** Насколько порция `MessageDisplay` может опередить следующую по счёту. */
const STREAM_AHEAD = 64;
/** Сколько порций одного сообщения лента разбирает по `index`; дальше — по порядку прихода. */
const STREAM_MAX_PARTS = 10_000;

export const emptyFeedState = (): FeedState => ({
  items: [],
  seq: 0,
  turnStartedAt: null,
  streams: {},
});

// ---------------------------------------------------------------------------------------------------
// Разбор значений

const inputOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** Строка не длиннее `limit`; `truncated` — её обрезали. */
export function limitText(value: string, limit: number): { text: string; truncated: boolean } {
  return value.length > limit
    ? { text: value.slice(0, limit), truncated: true }
    : { text: value, truncated: false };
}

/** Значение с обрезанными до `FEED_INPUT_LIMIT` строками; без длинных строк — то же значение. */
function limitStrings(value: unknown, cut: { truncated: boolean }): unknown {
  if (typeof value === 'string') {
    if (value.length <= FEED_INPUT_LIMIT) return value;
    cut.truncated = true;
    return value.slice(0, FEED_INPUT_LIMIT);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const limited = limitStrings(item, cut);
      if (limited !== item) changed = true;
      return limited;
    });
    return changed ? next : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const limited = limitStrings(item, cut);
      if (limited !== item) changed = true;
      next[key] = limited;
    }
    return changed ? next : value;
  }
  return value;
}

/** Вход вызова или карточки с пределом `FEED_INPUT_LIMIT` на каждую строку внутри. */
export function limitInput(input: Record<string, unknown>): {
  input: Record<string, unknown>;
  truncated: boolean;
} {
  const cut = { truncated: false };
  const limited = limitStrings(input, cut) as Record<string, unknown>;
  return { input: limited, truncated: cut.truncated };
}

const sameInput = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Миллисекунды между двумя ISO-временами; `null` — одно из них не время. */
export function durationBetween(from: string | null, to: string): number | null {
  if (from === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Текст блоков `[{type:'text', text}]` или строка как есть. */
export function blocksText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const block of value) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string')
      parts.push(block['text']);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Сводка результата инструмента: у `Bash` — вывод, у `Read` — содержимое файла, строка — как есть,
 * прочее — JSON. Усечение явное: `truncated` и полный `size`.
 */
export function toolResponseOf(value: unknown): FeedToolResponse | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (
    isRecord(value) &&
    (typeof value['stdout'] === 'string' || typeof value['stderr'] === 'string')
  ) {
    const stdout = typeof value['stdout'] === 'string' ? value['stdout'] : '';
    const stderr = typeof value['stderr'] === 'string' ? value['stderr'] : '';
    text = stdout !== '' && stderr !== '' ? `${stdout}\n${stderr}` : stdout + stderr;
  } else if (
    isRecord(value) &&
    isRecord(value['file']) &&
    typeof value['file']['content'] === 'string'
  ) {
    text = value['file']['content'];
  } else if (isRecord(value) && Array.isArray(value['structuredPatch'])) {
    // Правка: дифф идёт хунками, содержимое — во входе вызова; в сводке остаётся остальное.
    const rest = Object.fromEntries(
      Object.entries(value).filter(([key]) => !PATCH_BULK_KEYS.has(key)),
    );
    text = JSON.stringify(rest, null, 2);
  } else {
    text = JSON.stringify(value, null, 2);
  }
  const truncated = text.length > FEED_RESULT_LIMIT;
  return {
    text: truncated ? text.slice(0, FEED_RESULT_LIMIT) : text,
    size: text.length,
    truncated,
  };
}

/**
 * Хунки `structuredPatch` не длиннее `FEED_PATCH_LINES` строк в сумме: хвост отбрасывается,
 * `truncated`. Пусто или кривое — `undefined`.
 */
export function patchOf(
  value: unknown,
): { hunks: FeedPatchHunk[]; truncated: boolean } | undefined {
  if (!isRecord(value) || !Array.isArray(value['structuredPatch'])) return undefined;
  const hunks: FeedPatchHunk[] = [];
  let room = FEED_PATCH_LINES;
  let truncated = false;
  for (const hunk of value['structuredPatch']) {
    if (!isRecord(hunk) || !Array.isArray(hunk['lines'])) continue;
    if (room === 0) {
      truncated = true;
      break;
    }
    const num = (key: string): number => (typeof hunk[key] === 'number' ? hunk[key] : 0);
    let lines = hunk['lines'].filter((line): line is string => typeof line === 'string');
    if (lines.length > room) {
      lines = lines.slice(0, room);
      truncated = true;
    }
    room -= lines.length;
    hunks.push({
      oldStart: num('oldStart'),
      oldLines: num('oldLines'),
      newStart: num('newStart'),
      newLines: num('newLines'),
      lines,
    });
  }
  return hunks.length > 0 ? { hunks, truncated } : undefined;
}

function questionsOf(value: unknown): FeedQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: FeedQuestion[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['question'] !== 'string') continue;
    const options = Array.isArray(item['options']) ? item['options'] : [];
    questions.push({
      question: item['question'],
      header: textOf(item['header']),
      options: options.filter(isRecord).map((option) => ({
        label: typeof option['label'] === 'string' ? option['label'] : '',
        description: textOf(option['description']),
      })),
      multiSelect: item['multiSelect'] === true,
    });
  }
  return questions;
}

function answersOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !isRecord(value['answers'])) return undefined;
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(value['answers'])) {
    if (typeof answer === 'string') answers[question] = answer;
  }
  return answers;
}

/** Поля `<task-notification>`: пробуждение родителя по концу фонового субагента. */
export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
  result: string | null;
}

export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.trimStart().startsWith(TASK_NOTIFICATION)) return null;
  const tag = (name: string): string | null => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
    return match === null ? null : textOf(match[1]?.trim());
  };
  return {
    taskId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: tag('status'),
    summary: tag('summary'),
    result: tag('result'),
  };
}

// ---------------------------------------------------------------------------------------------------
// Черновик шага: копия списка, изменения по id

export class FeedDraft {
  readonly items: FeedItem[];
  seq: number;
  turnStartedAt: string | null;
  readonly streams: Record<string, FeedStream>;
  private readonly changed = new Map<string, FeedItem>();
  /** `id` → место в `items`; строится при первом поиске. */
  private index: Map<string, number> | null = null;

  constructor(state: FeedState) {
    this.items = state.items.slice();
    this.seq = state.seq;
    this.turnStartedAt = state.turnStartedAt;
    this.streams = { ...state.streams };
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}:#${this.seq}`;
  }

  has(id: string): boolean {
    return this.indexOf(id) !== -1;
  }

  /** Элемент по `id`. */
  get(id: string): FeedItem | undefined {
    const index = this.indexOf(id);
    return index === -1 ? undefined : this.items[index];
  }

  /** Добавляет элемент или заменяет элемент с тем же `id` на месте. */
  put(item: FeedItem): void {
    const index = this.indexOf(item.id);
    if (index === -1) {
      this.items.push(item);
      this.index?.set(item.id, this.items.length - 1);
    } else {
      this.items[index] = item;
    }
    this.changed.set(item.id, item);
  }

  /** Последний элемент, подходящий под условие. */
  findLast<T extends FeedItem>(test: (item: FeedItem) => item is T): T | undefined;
  findLast(test: (item: FeedItem) => boolean): FeedItem | undefined;
  findLast(test: (item: FeedItem) => boolean): FeedItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i] as FeedItem;
      if (test(item)) return item;
    }
    return undefined;
  }

  filter<T extends FeedItem>(test: (item: FeedItem) => item is T): T[] {
    return this.items.filter(test);
  }

  done(): FeedUpdate {
    return {
      state: {
        items: this.items,
        seq: this.seq,
        turnStartedAt: this.turnStartedAt,
        streams: this.streams,
      },
      changes: [...this.changed.values()],
    };
  }

  private indexOf(id: string): number {
    if (this.index === null) {
      this.index = new Map();
      this.items.forEach((item, i) => this.index?.set(item.id, i));
    }
    return this.index.get(id) ?? -1;
  }
}

const isCard = (item: FeedItem): item is FeedCard =>
  item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan';

const isPending = (item: FeedItem): item is FeedCard => isCard(item) && item.state === 'pending';

const isMainTool = (item: FeedItem): item is FeedTool =>
  item.kind === 'tool' && item.agentId === undefined;

const isAgent = (item: FeedItem): item is FeedAgent => item.kind === 'agent';

export const agentById = (draft: FeedDraft, agentId: string): FeedAgent | undefined =>
  draft.findLast((item): item is FeedAgent => isAgent(item) && item.agentId === agentId);

export function agentByToolUse(draft: FeedDraft, toolUseId: string): FeedAgent | undefined {
  const item = draft.get(`agent:${toolUseId}`);
  return item !== undefined && isAgent(item) ? item : undefined;
}

export function mainTool(draft: FeedDraft, toolUseId: string): FeedTool | undefined {
  const item = draft.get(`tool:${toolUseId}`);
  return item !== undefined && isMainTool(item) ? item : undefined;
}

/** Новый вызов инструмента; длинные строки входа обрезаны (`FEED_INPUT_LIMIT`). */
export function newTool(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  at: string,
  agentId: string | null,
): FeedTool {
  const limited = limitInput(input);
  const tool: FeedTool = {
    id: `tool:${toolUseId}`,
    at,
    kind: 'tool',
    toolUseId,
    name,
    input: limited.input,
    status: 'running',
  };
  if (limited.truncated) tool.truncated = true;
  if (agentId !== null) tool.agentId = agentId;
  return tool;
}

/** Текст ответа модели с пределом `FEED_TEXT_LIMIT`. */
export function newText(
  id: string,
  at: string,
  messageId: string | null,
  value: string,
  streaming: boolean,
): FeedText {
  const { text, truncated } = limitText(value, FEED_TEXT_LIMIT);
  const item: FeedText = { id, at, kind: 'text', messageId, text, streaming };
  if (truncated) item.truncated = true;
  return item;
}

/** Тот же текст с новым содержимым (`FEED_TEXT_LIMIT`). */
function withText(item: FeedText, value: string, streaming: boolean): FeedText {
  return newText(item.id, item.at, item.messageId, value, streaming);
}

/** Итог субагента с пределом `FEED_AGENT_TEXT_LIMIT`. */
export function withResult(agent: FeedAgent, value: string): FeedAgent {
  const { text, truncated } = limitText(value, FEED_AGENT_TEXT_LIMIT);
  const next: FeedAgent = { ...agent, result: text };
  if (truncated) next.truncated = true;
  return next;
}

/** Закрытый вызов: статус, сводка результата и хунки. */
export function finishTool(
  tool: FeedTool,
  status: FeedToolStatus,
  response: unknown,
  at: string,
): FeedTool {
  const next: FeedTool = { ...tool, status, endedAt: at };
  const summary = toolResponseOf(response);
  if (summary !== undefined) next.response = summary;
  const patch = patchOf(response);
  if (patch !== undefined) {
    next.patch = patch.hunks;
    if (patch.truncated) next.patchTruncated = true;
  }
  return next;
}

/** Новая карточка агента из входа вызова `Agent`. */
export function newAgent(toolUseId: string, input: Record<string, unknown>, at: string): FeedAgent {
  const prompt = textOf(input['prompt']);
  const limited = prompt === null ? null : limitText(prompt, FEED_AGENT_TEXT_LIMIT);
  const agent: FeedAgent = {
    id: `agent:${toolUseId}`,
    at,
    kind: 'agent',
    toolUseId,
    agentId: null,
    agentType: textOf(input['subagent_type']),
    description: textOf(input['description']),
    prompt: limited?.text ?? null,
    model: textOf(input['model']),
    background: input['run_in_background'] === true,
    status: 'running',
    toolCount: 0,
    children: [],
  };
  if (limited?.truncated === true) agent.truncated = true;
  return agent;
}

/**
 * Ответ вызова `Agent` (`tool_response` хука, `toolUseResult` журнала): фоновый запуск привязывает
 * `agentId` и модель, foreground-субагент приходит уже законченным.
 */
export function applyAgentResponse(agent: FeedAgent, response: unknown, at: string): FeedAgent {
  if (!isRecord(response)) return agent;
  let next: FeedAgent = { ...agent };
  const agentId = textOf(response['agentId']);
  if (agentId !== null && next.agentId === null) next.agentId = agentId;
  const model = textOf(response['resolvedModel']);
  if (model !== null) next.model = model;
  if (response['isAsync'] === true || response['status'] === 'async_launched') {
    next.background = true;
    return next;
  }
  if (
    next.status === 'running' &&
    (response['status'] === 'completed' || response['content'] !== undefined)
  ) {
    next.status = 'done';
    next.endedAt = at;
    const duration = response['totalDurationMs'];
    next.durationMs =
      typeof duration === 'number' ? duration : (durationBetween(agent.at, at) ?? 0);
    const count = response['totalToolUseCount'];
    if (typeof count === 'number' && count > next.toolCount) next.toolCount = count;
    const result = blocksText(response['content']);
    if (result !== null) next = withResult(next, result);
  }
  return next;
}

/** Закрывает карточку агента: `done` или `failed`. */
export function finishAgent(agent: FeedAgent, status: 'done' | 'failed', at: string): FeedAgent {
  if (agent.status !== 'running') return agent;
  return { ...agent, status, endedAt: at, durationMs: durationBetween(agent.at, at) ?? 0 };
}

/** Статус задачи из `background_tasks` или `<task-notification>` → статус карточки; `null` — ещё идёт. */
export function agentStatusOf(status: string | null): 'done' | 'failed' | null {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'killed' || status === 'error') return 'failed';
  return null;
}

/**
 * Пробуждение родителя `<task-notification>`: карточка агента закрывается, в ленту — `notice`
 * «agent reported», а не промпт человека.
 */
export function applyTaskNotification(draft: FeedDraft, note: TaskNotification, at: string): void {
  let agent =
    (note.toolUseId !== null ? agentByToolUse(draft, note.toolUseId) : undefined) ??
    (note.taskId !== null ? agentById(draft, note.taskId) : undefined);
  const status = agentStatusOf(note.status);
  if (agent !== undefined && status !== null && agent.status === 'running') {
    agent = finishAgent(agent, status, at);
    if (agent.result === undefined && note.result !== null) agent = withResult(agent, note.result);
    draft.put(agent);
  }
  draft.put({
    id: draft.nextId('notice'),
    at,
    kind: 'notice',
    notice: {
      type: 'agent-reported',
      agentItemId: agent?.id ?? null,
      agentId: agent?.agentId ?? note.taskId,
      status: note.status,
      summary: note.summary,
    },
  });
}

/** Снимает карточку; `elsewhere` отклоняет вызов, который всё ещё идёт (Esc в диалоге терминала). */
function settle(draft: FeedDraft, card: FeedCard, state: FeedCardState, at: string): void {
  draft.put({ ...card, state, settledAt: at });
  if (state !== 'elsewhere' || card.toolUseId === null) return;
  rejectTool(draft, card.toolUseId, card.agentId ?? null, at);
}

function rejectTool(draft: FeedDraft, toolUseId: string, agentId: string | null, at: string): void {
  if (agentId === null) {
    const tool = mainTool(draft, toolUseId);
    if (tool !== undefined && tool.status === 'running')
      draft.put({ ...tool, status: 'rejected', endedAt: at });
    return;
  }
  const agent = agentById(draft, agentId);
  const child = agent?.children.find((item) => item.toolUseId === toolUseId);
  if (agent === undefined || child === undefined || child.status !== 'running') return;
  draft.put(withChild(agent, { ...child, status: 'rejected', endedAt: at }));
}

function withChild(agent: FeedAgent, child: FeedTool): FeedAgent {
  const index = agent.children.findIndex((item) => item.toolUseId === child.toolUseId);
  const children = agent.children.slice();
  if (index === -1) children.push(child);
  else children[index] = child;
  return { ...agent, children, toolCount: Math.max(agent.toolCount, children.length) };
}

function settleAllPending(draft: FeedDraft, at: string): void {
  for (const card of draft.filter(isPending)) settle(draft, card, 'elsewhere', at);
}

/** Закрывает текст: порций он больше не принимает. */
function closeText(draft: FeedDraft, text: FeedText, value?: string): void {
  if (text.messageId !== null) delete draft.streams[text.messageId];
  draft.put(value === undefined ? { ...text, streaming: false } : withText(text, value, false));
}

function closeTexts(draft: FeedDraft): void {
  for (const text of draft.filter((item): item is FeedText => item.kind === 'text')) {
    if (text.streaming) closeText(draft, text);
  }
}

/** Конец хода без `Stop`: вызовы, оставшиеся `running` в общем потоке, — прерваны человеком. */
function rejectRunningTools(draft: FeedDraft, at: string): void {
  for (const tool of draft.filter(isMainTool)) {
    if (tool.status === 'running') draft.put({ ...tool, status: 'rejected', endedAt: at });
  }
}

/** Закрывает идущий ход: тексты, карточки, вызовы; `turn` — если ход шёл. */
function closeTurn(draft: FeedDraft, at: string): void {
  closeTexts(draft);
  settleAllPending(draft, at);
  rejectRunningTools(draft, at);
  if (draft.turnStartedAt !== null) {
    draft.put({
      id: draft.nextId('turn'),
      at,
      kind: 'turn',
      durationMs: durationBetween(draft.turnStartedAt, at),
    });
    draft.turnStartedAt = null;
  }
}

// ---------------------------------------------------------------------------------------------------
// События хуков

/**
 * Карточки, ждущие этого вызова: по `toolUseId`, а нет таких — одна, самая ранняя карточка без
 * вызова с тем же именем и входом (два одинаковых параллельных запроса — две карточки, два вызова).
 */
function cardsOfCall(
  draft: FeedDraft,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  agentId: string | null,
): FeedCard[] {
  const pending = draft.filter(isPending);
  const byId = pending.filter((card) => card.toolUseId === toolUseId);
  if (byId.length > 0) return byId;
  const unbound = pending.find(
    (card) =>
      card.toolUseId === null &&
      card.toolName === name &&
      (card.agentId ?? null) === agentId &&
      sameInput(card.toolInput, input),
  );
  return unbound === undefined ? [] : [unbound];
}

function onPreToolUse(
  draft: FeedDraft,
  data: Record<string, unknown>,
  rec: EventRecord,
  at: string,
): void {
  const toolUseId = textOf(data['tool_use_id']);
  const name = textOf(data['tool_name']);
  if (toolUseId === null || name === null) return;
  const raw = inputOf(data['tool_input']);
  const { input, truncated } = limitInput(raw);

  if (rec.agentId !== null) {
    const agent = agentById(draft, rec.agentId);
    if (agent !== undefined && !agent.children.some((item) => item.toolUseId === toolUseId)) {
      draft.put(withChild(agent, newTool(toolUseId, name, raw, at, rec.agentId)));
    }
    return;
  }
  if (AGENT_TOOLS.has(name)) {
    if (agentByToolUse(draft, toolUseId) === undefined) draft.put(newAgent(toolUseId, raw, at));
    return;
  }
  if (mainTool(draft, toolUseId) === undefined) draft.put(newTool(toolUseId, name, raw, at, null));

  const base = {
    at,
    state: 'pending' as const,
    toolUseId,
    toolName: name,
    toolInput: input,
    ...(truncated ? { truncated: true } : {}),
  };
  if (name === QUESTION_TOOL && !draft.has(`question:${toolUseId}`)) {
    const id = `question:${toolUseId}`;
    draft.put({
      ...base,
      id,
      cardId: id,
      kind: 'question',
      questions: questionsOf(input['questions']),
    });
  } else if (name === PLAN_TOOL && !draft.has(`plan:${toolUseId}`)) {
    const id = `plan:${toolUseId}`;
    const plan = typeof input['plan'] === 'string' ? input['plan'] : '';
    draft.put({
      ...base,
      id,
      cardId: id,
      kind: 'plan',
      plan,
      planFilePath: textOf(input['planFilePath']),
    });
  }
}

function onPermissionRequest(
  draft: FeedDraft,
  data: Record<string, unknown>,
  rec: EventRecord,
  at: string,
): void {
  const name = textOf(data['tool_name']);
  if (name === null) return;
  const { input, truncated } = limitInput(inputOf(data['tool_input']));

  // Вызов, о котором спрашивают: `PermissionRequest` не несёт `tool_use_id`, ищем идущий вызов с тем же
  // именем — сначала с тем же входом — без своей карточки.
  const hasCard = (toolUseId: string): boolean =>
    draft.findLast((item) => isCard(item) && item.toolUseId === toolUseId) !== undefined;
  const pool =
    rec.agentId === null
      ? draft.filter(isMainTool)
      : (agentById(draft, rec.agentId)?.children ?? []);
  const candidates = pool.filter(
    (tool) => tool.name === name && tool.status === 'running' && !hasCard(tool.toolUseId),
  );
  const tool = candidates.findLast((item) => sameInput(item.input, input)) ?? candidates.at(-1);

  // Вопрос и план уже стоят своей карточкой с `PreToolUse` — вторая карточка на тот же вызов не нужна.
  if ((name === QUESTION_TOOL || name === PLAN_TOOL) && tool === undefined) {
    const own = draft.findLast(
      (item) => isPending(item) && item.kind !== 'permission' && item.toolName === name,
    );
    if (own !== undefined) return;
  }

  const id =
    tool !== undefined && !draft.has(`permission:${tool.toolUseId}`)
      ? `permission:${tool.toolUseId}`
      : draft.nextId('permission');
  const card: FeedPermissionCard = {
    id,
    at,
    kind: 'permission',
    cardId: id,
    state: 'pending',
    toolUseId: tool?.toolUseId ?? null,
    toolName: name,
    toolInput: input,
    suggestions: Array.isArray(data['permission_suggestions'])
      ? data['permission_suggestions']
      : [],
    notified: false,
  };
  if (truncated) card.truncated = true;
  if (rec.agentId !== null) card.agentId = rec.agentId;
  draft.put(card);
}

function onPostToolUse(
  draft: FeedDraft,
  data: Record<string, unknown>,
  rec: EventRecord,
  at: string,
  failed: boolean,
): void {
  const toolUseId = textOf(data['tool_use_id']);
  const name = textOf(data['tool_name']);
  if (toolUseId === null || name === null) return;
  const raw = inputOf(data['tool_input']);
  const response = failed ? (data['error'] ?? data['tool_response']) : data['tool_response'];
  const status: FeedToolStatus = failed ? 'failed' : 'done';

  if (rec.agentId !== null) {
    const agent = agentById(draft, rec.agentId);
    if (agent !== undefined) {
      const child =
        agent.children.find((item) => item.toolUseId === toolUseId) ??
        newTool(toolUseId, name, raw, at, rec.agentId);
      draft.put(withChild(agent, finishTool(child, status, response, at)));
    }
  } else if (AGENT_TOOLS.has(name)) {
    const agent = agentByToolUse(draft, toolUseId) ?? newAgent(toolUseId, raw, at);
    draft.put(failed ? finishAgent(agent, 'failed', at) : applyAgentResponse(agent, response, at));
  } else {
    const tool = mainTool(draft, toolUseId) ?? newTool(toolUseId, name, raw, at, null);
    draft.put(finishTool(tool, status, response, at));
  }

  const { input } = limitInput(raw);
  for (const card of cardsOfCall(draft, toolUseId, name, input, rec.agentId)) {
    const settled = { ...card, toolUseId };
    if (settled.kind === 'question' && settled.answers === undefined) {
      const answers = answersOf(data['tool_response']);
      if (answers !== undefined) settled.answers = answers;
    }
    settle(draft, settled, 'elsewhere', at);
  }
  // Ответ на вопрос из окна: карточка уже `answered`, а ответ в `tool_response` тот же — дописывать нечего.
}

function onStop(
  draft: FeedDraft,
  data: Record<string, unknown>,
  rec: EventRecord,
  at: string,
): void {
  const message = textOf(data['last_assistant_message']);
  if (message !== null) {
    // Последний ответ хода: текст хода с тем же содержимым или тот, что ещё растёт его началом, —
    // `MessageDisplay` отстаёт от хуков, а промпт из очереди встаёт посреди порций. Нет такого —
    // ответ встаёт новым элементом, а опоздавшие порции его потом узнают.
    const limited = limitText(message, FEED_TEXT_LIMIT).text;
    const texts: FeedText[] = [];
    for (let i = draft.items.length - 1; i >= 0; i -= 1) {
      const item = draft.items[i] as FeedItem;
      if (item.kind === 'turn') break;
      if (item.kind === 'text') texts.push(item);
    }
    const target =
      texts.find((text) => text.text.trimEnd() === limited.trimEnd()) ??
      texts.find((text) => text.streaming && message.startsWith(text.text));
    if (target !== undefined) closeText(draft, target, message);
    else draft.put(newText(draft.nextId('text'), at, null, message, false));
  }

  for (const task of rec.backgroundTasks ?? []) {
    const agent = agentById(draft, task.id);
    if (agent === undefined) continue;
    const status = agentStatusOf(task.status);
    let next: FeedAgent = agent.background ? agent : { ...agent, background: true };
    if (status !== null) next = finishAgent(next, status, at);
    if (next !== agent) draft.put(next);
  }

  endTurn(draft, at);
}

/** Конец хода по `Stop`/`StopFailure`: тексты, карточки и вызовы закрыты, `turn` — всегда. */
function endTurn(draft: FeedDraft, at: string): void {
  closeTexts(draft);
  settleAllPending(draft, at);
  rejectRunningTools(draft, at);
  draft.put({
    id: draft.nextId('turn'),
    at,
    kind: 'turn',
    durationMs: durationBetween(draft.turnStartedAt, at),
  });
  draft.turnStartedAt = null;
}

function onUserPromptSubmit(draft: FeedDraft, data: Record<string, unknown>, at: string): void {
  // Решение 5: новый промпт снимает висящие карточки — человек ответил в терминале.
  settleAllPending(draft, at);
  const prompt = typeof data['prompt'] === 'string' ? data['prompt'] : '';
  const note = parseTaskNotification(prompt);
  if (note !== null) applyTaskNotification(draft, note, at);
  else draft.put({ id: draft.nextId('prompt'), at, kind: 'prompt', text: prompt, images: 0 });
  draft.turnStartedAt ??= at;
}

function onMessageDisplay(
  draft: FeedDraft,
  data: Record<string, unknown>,
  rec: EventRecord,
  at: string,
): void {
  if (rec.agentId !== null) return;
  const messageId = textOf(data['message_id']);
  const delta = typeof data['delta'] === 'string' ? data['delta'] : '';
  if (messageId === null) return;
  const text = draft.findLast(
    (item): item is FeedText => item.kind === 'text' && item.messageId === messageId,
  );
  // Закрытый текст (все порции до `final` или `Stop` с полным ответом) порций больше не принимает.
  if (text !== undefined && !text.streaming) return;
  if (text === undefined) {
    // Порция пришла после `Stop`: ответ уже стоит целиком из `last_assistant_message` — только узнаём его.
    const closed = stoppedText(draft);
    if (closed !== undefined && delta.trimEnd() !== '' && closed.text.includes(delta.trimEnd())) {
      draft.put({ ...closed, messageId });
      return;
    }
  }

  // Пустая финальная порция без открытого текста (поздний `final` после `Stop`): только чистим поток.
  if (text === undefined && delta === '' && data['final'] === true) {
    delete draft.streams[messageId];
    return;
  }
  const stream = addPart(
    draft.streams[messageId] ?? { head: '', count: 0, ahead: {}, finalIndex: null },
    data['index'],
    delta,
    data['final'] === true,
  );
  const complete = stream.finalIndex !== null && stream.count > stream.finalIndex;
  const value = streamText(stream);

  if (complete) delete draft.streams[messageId];
  else draft.streams[messageId] = stream;
  // Пустая порция без открытого текста текста не заводит.
  if (text === undefined && value === '') return;
  if (text === undefined) draft.put(newText(`text:${messageId}`, at, messageId, value, !complete));
  else draft.put(withText(text, value, !complete));
}

/**
 * Порция в поток. `index` принимается только целым, не дальше `STREAM_AHEAD` от следующей по счёту
 * и меньше `STREAM_MAX_PARTS`; иначе порция — следующая по счёту. Повтор уже склеенной — пропуск.
 */
function addPart(stream: FeedStream, rawIndex: unknown, delta: string, final: boolean): FeedStream {
  const index =
    typeof rawIndex === 'number' &&
    Number.isInteger(rawIndex) &&
    rawIndex >= 0 &&
    rawIndex <= stream.count + STREAM_AHEAD &&
    rawIndex < STREAM_MAX_PARTS
      ? rawIndex
      : stream.count;
  const finalIndex = final ? index : stream.finalIndex;
  if (index < stream.count) return { ...stream, finalIndex };
  if (index > stream.count)
    return { ...stream, ahead: { ...stream.ahead, [index]: delta }, finalIndex };

  let head = stream.head + delta;
  let count = stream.count + 1;
  let ahead = stream.ahead;
  if (ahead[count] !== undefined) {
    const rest: Record<string, string> = { ...ahead };
    for (let next = rest[count]; next !== undefined; next = rest[count]) {
      head += next;
      delete rest[count];
      count += 1;
    }
    ahead = rest;
  }
  // Сверх предела текста ленте хранить нечего: `+ 1` — чтобы знать, что текст обрезан.
  if (head.length > FEED_TEXT_LIMIT + 1) head = head.slice(0, FEED_TEXT_LIMIT + 1);
  return { head, count, ahead, finalIndex };
}

/** Текст потока: склеенное и опередившие порции по порядку (дыры пустые). */
function streamText(stream: FeedStream): string {
  const parts = Object.keys(stream.ahead)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => stream.ahead[index] ?? '');
  return parts.length === 0 ? stream.head : stream.head + parts.join('');
}

/** Текст, поставленный `Stop` без порций (`messageId: null`), если он последний в ленте до `turn`. */
function stoppedText(draft: FeedDraft): FeedText | undefined {
  for (let i = draft.items.length - 1; i >= 0; i -= 1) {
    const item = draft.items[i] as FeedItem;
    if (item.kind === 'turn' || item.kind === 'notice') continue;
    return item.kind === 'text' && item.messageId === null && !item.streaming ? item : undefined;
  }
  return undefined;
}

function onSubagentStart(draft: FeedDraft, rec: EventRecord): void {
  if (rec.agentId === null || agentById(draft, rec.agentId) !== undefined) return;
  // Привязка по порядку: первая карточка без id, сначала того же типа.
  const free = draft
    .filter(isAgent)
    .filter((item) => item.agentId === null && item.status === 'running');
  const agent = free.find((item) => item.agentType === rec.agentType) ?? free[0];
  if (agent === undefined) return;
  const next: FeedAgent = { ...agent, agentId: rec.agentId };
  if (next.agentType === null) next.agentType = rec.agentType;
  draft.put(next);
}

function onSubagentStop(
  draft: FeedDraft,
  data: Record<string, unknown>,
  rec: EventRecord,
  at: string,
): void {
  if (rec.agentId === null) return;
  const agent = agentById(draft, rec.agentId);
  if (agent === undefined) return;
  const next: FeedAgent = finishAgent(agent, 'done', at);
  const result = textOf(data['last_assistant_message']);
  const transcript = textOf(data['agent_transcript_path']);
  draft.put({
    ...(result !== null ? withResult(next, result) : next),
    ...(transcript !== null ? { transcriptPath: transcript } : {}),
  });
}

/**
 * Один шаг ленты: событие хука (stdin-JSON Claude Code как есть) и время его прихода.
 * Шум (решение 11), неизвестные события и кривые строки состояние не меняют.
 */
export function applyHookEvent(state: FeedState, event: unknown, at: string): FeedUpdate {
  const rec = eventRecordOf(event, at);
  if (rec === null || !isRecord(event) || isHookNoise(event)) return { state, changes: [] };
  const draft = new FeedDraft(state);
  const data = event;

  switch (rec.name) {
    case 'SessionStart':
      draft.put({
        id: draft.nextId('notice'),
        at,
        kind: 'notice',
        notice: {
          type: 'session-start',
          source: textOf(data['source']),
          model: textOf(data['model']),
        },
      });
      break;
    case 'SessionEnd':
      closeTurn(draft, at);
      draft.put({
        id: draft.nextId('notice'),
        at,
        kind: 'notice',
        notice: { type: 'session-end', reason: textOf(data['reason']) },
      });
      break;
    case 'UserPromptSubmit':
      onUserPromptSubmit(draft, data, at);
      break;
    case 'MessageDisplay':
      onMessageDisplay(draft, data, rec, at);
      break;
    case 'PreToolUse':
      onPreToolUse(draft, data, rec, at);
      break;
    case 'PermissionRequest':
      onPermissionRequest(draft, data, rec, at);
      break;
    case 'PostToolUse':
      onPostToolUse(draft, data, rec, at, false);
      break;
    case 'PostToolUseFailure':
      onPostToolUse(draft, data, rec, at, true);
      break;
    case 'Stop':
      if (rec.agentId === null) onStop(draft, data, rec, at);
      break;
    case 'StopFailure':
      // Ход оборван ошибкой API: закрывается как `Stop`, карточка ошибки — перед чертой хода.
      draft.put({
        id: draft.nextId('error'),
        at,
        kind: 'error',
        error: textOf(data['error']) ?? 'unknown',
        message: textOf(data['last_assistant_message']),
      });
      endTurn(draft, at);
      break;
    case 'Notification': {
      if (rec.notificationType !== 'permission_prompt') break;
      const card = draft.findLast(
        (item): item is FeedPermissionCard =>
          item.kind === 'permission' && item.state === 'pending',
      );
      if (card !== undefined && !card.notified) draft.put({ ...card, notified: true });
      break;
    }
    case 'SubagentStart':
      onSubagentStart(draft, rec);
      break;
    case 'SubagentStop':
      onSubagentStop(draft, data, rec, at);
      break;
    case 'PreCompact':
    case 'PostCompact':
      draft.put({
        id: draft.nextId('notice'),
        at,
        kind: 'notice',
        notice: {
          type: 'compact',
          phase: rec.name === 'PreCompact' ? 'pre' : 'post',
          trigger: textOf(data['trigger']),
        },
      });
      break;
    case 'PostModelSwitch':
      draft.put({
        id: draft.nextId('notice'),
        at,
        kind: 'notice',
        notice: {
          type: 'model-switch',
          from: textOf(data['from_model']),
          to: textOf(data['to_model']),
          source: textOf(data['source']),
        },
      });
      break;
    default:
      break;
  }
  return draft.done();
}

// ---------------------------------------------------------------------------------------------------
// Решения окна и снятие карточек хостом

/**
 * Решение человека из окна (`feed.decide`). `applied: false` — карточки нет, она уже не ждёт или
 * решение другого вида: второе нажатие ничего не меняет.
 */
export function applyDecision(
  state: FeedState,
  cardId: string,
  decision: FeedDecision,
  at: string,
): FeedUpdate & { applied: boolean } {
  const draft = new FeedDraft(state);
  const card = draft.findLast((item): item is FeedCard => isCard(item) && item.cardId === cardId);
  if (card === undefined || card.state !== 'pending' || card.kind !== decision.kind) {
    return { state, changes: [], applied: false };
  }
  if (card.kind === 'permission' && decision.kind === 'permission') {
    const next: FeedPermissionCard = {
      ...card,
      state: decision.behavior === 'allow' ? 'allowed' : 'denied',
      settledAt: at,
    };
    if (decision.always === true) next.always = true;
    if (decision.message !== undefined) next.message = decision.message;
    draft.put(next);
    if (decision.behavior === 'deny' && card.toolUseId !== null) {
      rejectTool(draft, card.toolUseId, card.agentId ?? null, at);
    }
  } else if (card.kind === 'question' && decision.kind === 'question') {
    const next: FeedQuestionCard = {
      ...card,
      state: 'answered',
      answers: { ...decision.answers },
      settledAt: at,
    };
    draft.put(next);
  } else if (card.kind === 'plan' && decision.kind === 'plan') {
    draft.put({ ...card, state: 'allowed', choice: decision.choice, settledAt: at });
  }
  return { ...draft.done(), applied: true };
}

/**
 * Снимает ждущие карточки без решения (решение 5): `elsewhere` — ответили в терминале или
 * активность стала `idle`, `stale` — хук ждал дольше предела. Без `cardIds` — все ждущие.
 */
export function settleCards(
  state: FeedState,
  outcome: 'elsewhere' | 'stale',
  at: string,
  cardIds?: readonly string[],
): FeedUpdate {
  const draft = new FeedDraft(state);
  for (const card of draft.filter(isPending)) {
    if (cardIds === undefined || cardIds.includes(card.cardId)) settle(draft, card, outcome, at);
  }
  return draft.done();
}
