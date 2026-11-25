/**
 * Лента Codex из журнала сессии (спека 2026-10-07, 5.2). Журнал пишет только законченные элементы хода
 * (`event_msg/item_completed` с `TurnItem`), поэтому вызовы появляются в ленте сразу законченными. Записи с `ordinal`
 * не больше применённого пропускаются — повторное чтение файла не даёт дублей. Id элементов — id элементов Codex
 * (`toolUseId` вызова — `item.id`: с ним совпадёт `tool_use_id` хука, если этап 0 это подтвердит). Строительные блоки —
 * те же, что у ленты Claude (`reduce.ts`).
 *
 * С `agentId` записи — из журнала субагента: его вызовы ложатся в `children` карточки (`withChild`, без хунков), а текст,
 * промпты и ходы агента в ленту родителя не идут — итог и задание карточке даёт `codex-agents.ts`.
 *
 * `Reasoning` пропускается (thinking у Claude тоже не показывается); `ContextCompaction` — заметка `compact`; запись
 * `compacted` её не дублирует. Незнакомый тип элемента — пропуск и счётчик `skipped` для `host.log`.
 * Нативные async-вопросы из `response_item` и `item_completed` объединяются по questionItemId.
 * Ответы из диалога Codex снимают карточки по тому же id; оставшиеся вопросы истекают с концом хода.
 *
 * Картинки (план 2026-10-09): записи приходят после обхода картинок хоста (`stash.ts`), поэтому картинка `McpToolCall`
 * в `result.content` — блок со ссылкой, а не base64; сводку вызова собирает `toolResponseOf`. `ImageView` хост снабжает
 * ссылкой на копию файла в хранилище (`parleyImage` элемента): файл агент переписывает, и лента, ссылайся она на путь
 * агента, показала бы не ту картинку, которую он тогда посмотрел.
 */

import { hasImageRef, hasStashedImage } from '../images.js';
import {
  agentById,
  blocksText,
  closeTurn,
  emptyFeedState,
  FeedDraft,
  finishAgent,
  finishTool,
  putMail,
  limitText,
  newText,
  newTool,
  withChild,
} from '../reduce.js';
import {
  FEED_INPUT_LIMIT,
  FEED_TEXT_LIMIT,
  type FeedAgent,
  type FeedError,
  type FeedItem,
  type FeedNotice,
  type FeedNoticeData,
  type FeedPrompt,
  type FeedQuestionCard,
  type FeedState,
  type FeedTool,
  type FeedToolStatus,
  type FeedUpdate,
} from '../types.js';
import type { RolloutRecord } from './rollout-record.js';
import { parseUnifiedDiff } from './unified-diff.js';

export interface CodexCursor {
  /** Последний применённый `ordinal`; `-1` — ничего не применено. */
  lastOrdinal: number;
  /** Сколько элементов незнакомых типов пропущено. */
  skipped: number;
  /** Встретилась ли запись `item_completed` — журнал в формате 0.160+. */
  modern: boolean;
}

export const emptyCodexCursor = (): CodexCursor => ({ lastOrdinal: -1, skipped: 0, modern: false });

export const CODEX_HISTORY_IN_TERMINAL = 'codex-history-in-terminal';
export const CODEX_HISTORY_MESSAGE = 'Earlier history of this session is only in Terminal';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: Json | null | undefined, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const msAt = (value: unknown, fallback: string): string =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : fallback;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
    .filter((text) => text !== '')
    .join('\n');
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => isRecord(part) && typeof part['type'] === 'string' && part['type'].includes('image')).length;
}

const SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh', 'fish']);

export function commandText(argv: unknown): string {
  if (!Array.isArray(argv)) return '';
  const parts = argv.filter((part): part is string => typeof part === 'string');
  const shell = parts[0]?.split('/').pop() ?? '';
  if (parts.length === 3 && SHELLS.has(shell) && (parts[1] === '-lc' || parts[1] === '-c')) return parts[2] as string;
  return parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function statusOf(item: Json): FeedToolStatus {
  const status = str(item, 'status');
  if (status === 'declined') return 'rejected';
  if (status === 'failed' || status === 'interrupted') return 'failed';
  const code = item['exit_code'];
  return typeof code === 'number' && code !== 0 ? 'failed' : 'done';
}

/**
 * Что идёт в сводку `McpToolCall`. Если в `result.content` есть картинка после `stashFeedImages` — сам
 * массив: текст блоков, пометки картинок и ссылки соберёт `toolResponseOf`. Иначе, как раньше, текст
 * блоков, а нет текста — весь `result` JSON-ом.
 */
function mcpResult(result: Json): unknown {
  const content = result['content'];
  return hasStashedImage(content) ? content : (blocksText(content) ?? JSON.stringify(result));
}

/**
 * Сводка вызова `ImageView`: блок-картинка со ссылкой на копию файла, которую хост положил в хранилище и пометил
 * `item.parleyImage` (`stashCodexRecord`). Метки нет или она кривая — `undefined`: вызов остаётся без результата.
 * Путь агента (`item.path`) здесь не читается и в ленту не идёт.
 */
function viewedImage(item: Json): unknown {
  const block = { type: 'image', parleyImage: item['parleyImage'] };
  return hasImageRef(block) ? block : undefined;
}

/** Вызов — в основную ленту или в `children` карточки субагента. */
function putTool(draft: FeedDraft, agentId: string | null, tool: FeedTool): void {
  if (agentId === null) {
    draft.put(tool);
    return;
  }
  const agent = agentById(draft, agentId);
  if (agent !== undefined) draft.put(withChild(agent, tool));
}

function modeOf(payload: Json): string | null {
  const approval = str(payload, 'approval_policy');
  const sandboxRaw = payload['sandbox_policy'];
  const sandbox = typeof sandboxRaw === 'string' ? sandboxRaw : isRecord(sandboxRaw) ? str(sandboxRaw, 'type') : null;
  const parts = [approval, sandbox].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

function lastModel(draft: FeedDraft): string | null {
  for (let at = draft.items.length - 1; at >= 0; at -= 1) {
    const item = draft.items[at] as FeedItem;
    if (item.kind !== 'notice') continue;
    if (item.notice.type === 'session-start') return item.notice.model;
    if (item.notice.type === 'model-switch') return item.notice.to;
  }
  return null;
}

function onTurnContext(draft: FeedDraft, record: RolloutRecord): void {
  const mode = modeOf(record.payload);
  if (mode !== null) draft.permissionMode = mode;
  const model = str(record.payload, 'model');
  if (model === null) return;
  const was = lastModel(draft);
  if (was === model) return;
  const notice: FeedNoticeData =
    was === null ? { type: 'session-start', source: 'codex', model } : { type: 'model-switch', from: was, to: model, source: 'codex' };
  const item: FeedNotice = { id: draft.nextId('notice'), at: record.at, kind: 'notice', notice };
  draft.put(item);
}

function onItem(draft: FeedDraft, record: RolloutRecord, cursor: CodexCursor, agentId: string | null, mail: boolean): void {
  const item = record.payload['item'];
  if (!isRecord(item)) return;
  const type = str(item, 'type');
  const id = str(item, 'id');
  if (type === null || id === null) return;
  const startAt = msAt(record.payload['started_at_ms'], record.at);
  const endAt = msAt(record.payload['completed_at_ms'], record.at);

  switch (type) {
    case 'Reasoning':
      return;
    case 'UserMessage': {
      if (agentId !== null) return;
      const message = contentText(item['content']);
      if (onAsyncReply(draft, message, endAt)) return;
      const { text } = limitText(message, FEED_TEXT_LIMIT);
      const prompt: FeedPrompt = { id: `prompt:${id}`, at: startAt, kind: 'prompt', text, images: imageCount(item['content']) };
      draft.put(prompt);
      return;
    }
    case 'AgentMessage': {
      if (agentId !== null) return;
      if (item['delivery'] === 'async' && Array.isArray(item['questions'])) {
        putAsyncQuestions(draft, id, item['questions'], endAt);
        return;
      }
      const text = contentText(item['content']);
      if (text !== '') draft.put(newText(`text:${id}`, endAt, id, text, false));
      return;
    }
    case 'CommandExecution': {
      const cwd = str(item, 'cwd');
      const output =
        typeof item['aggregated_output'] === 'string'
          ? item['aggregated_output']
          : [item['stdout'], item['stderr']].filter((part) => typeof part === 'string' && part !== '').join('\n');
      const tool = newTool(id, 'Bash', { command: commandText(item['command']), ...(cwd === null ? {} : { cwd }) }, startAt, agentId);
      putTool(draft, agentId, finishTool(tool, statusOf(item), output, endAt));
      return;
    }
    case 'FileChange': {
      const changes = item['changes'];
      if (!isRecord(changes)) return;
      const status = statusOf(item);
      Object.entries(changes).forEach(([file, raw], index) => {
        if (!isRecord(raw)) return;
        const kind = str(raw, 'type');
        const move = str(raw, 'move_path');
        const base = { file_path: file, ...(move === null ? {} : { move_path: move }) };
        const toolUseId = `${id}:${index}`;
        if (kind === 'add') {
          const content = typeof raw['content'] === 'string' ? raw['content'] : '';
          putTool(draft, agentId, finishTool(newTool(toolUseId, 'Write', { ...base, content }, startAt, agentId), status, undefined, endAt));
          return;
        }
        if (kind === 'delete') {
          putTool(draft, agentId, finishTool(newTool(toolUseId, 'Delete', base, startAt, agentId), status, undefined, endAt));
          return;
        }
        const done = finishTool(newTool(toolUseId, 'Edit', base, startAt, agentId), status, undefined, endAt);
        const diff = typeof raw['unified_diff'] === 'string' ? raw['unified_diff'] : '';
        const patch = agentId === null ? parseUnifiedDiff(diff) : { hunks: [], truncated: false };
        putTool(draft, agentId, patch.hunks.length === 0 ? done : { ...done, patch: patch.hunks, ...(patch.truncated ? { patchTruncated: true } : {}) });
      });
      return;
    }
    case 'McpToolCall': {
      const server = str(item, 'server') ?? 'mcp';
      const name = str(item, 'tool') ?? 'tool';
      const args = isRecord(item['arguments']) ? item['arguments'] : {};
      const result = isRecord(item['result']) ? mcpResult(item['result']) : undefined;
      const error = isRecord(item['error']) ? str(item['error'], 'message') : str(item, 'error');
      const finished = finishTool(newTool(id, `mcp__${server}__${name}`, args, startAt, agentId), statusOf(item), result ?? error ?? undefined, endAt);
      putTool(draft, agentId, finished);
      if (mail && agentId === null) putMail(draft, finished);
      return;
    }
    case 'Extension': {
      const query = str(item, 'query');
      if (query === null) break;
      const results = Array.isArray(item['results'])
        ? item['results'].filter(isRecord).map((hit) => [str(hit, 'title'), str(hit, 'url')].filter(Boolean).join(' — ')).join('\n')
        : undefined;
      putTool(draft, agentId, finishTool(newTool(id, 'WebSearch', { query }, startAt, agentId), 'done', results, endAt));
      return;
    }
    case 'ImageView': {
      const file = str(item, 'path');
      putTool(draft, agentId, finishTool(newTool(id, 'ViewImage', file === null ? {} : { file_path: file }, startAt, agentId), 'done', viewedImage(item), endAt));
      return;
    }
    case 'ContextCompaction': {
      if (agentId !== null) return;
      const notice: FeedNotice = { id: `notice:${id}`, at: endAt, kind: 'notice', notice: { type: 'compact', phase: 'post', trigger: null } };
      draft.put(notice);
      return;
    }
    case 'SubAgentActivity': {
      if (agentId !== null) return;
      const thread = str(item, 'agent_thread_id');
      if (thread === null) return;
      const kind = str(item, 'kind');
      const known = agentById(draft, thread);
      if (kind === 'started') {
        if (known === undefined) {
          const card: FeedAgent = {
            id: `agent:${thread}`,
            at: endAt,
            kind: 'agent',
            toolUseId: thread,
            agentId: thread,
            agentType: null,
            description: null,
            prompt: null,
            model: null,
            background: false,
            status: 'running',
            toolCount: 0,
            children: [],
          };
          draft.put(card);
        }
        return;
      }
      if (known !== undefined && known.status === 'running' && (kind === 'completed' || kind === 'interrupted')) {
        draft.put(finishAgent(known, kind === 'completed' ? 'done' : 'failed', endAt));
      }
      return;
    }
    case 'CollabAgentToolCall': {
      const tool = str(item, 'tool');
      if (tool === null || tool === 'spawn_agent') return;
      const receivers = Array.isArray(item['receiver_thread_ids']) ? item['receiver_thread_ids'].filter((value) => typeof value === 'string') : [];
      const prompt = str(item, 'prompt');
      putTool(draft, agentId, finishTool(newTool(id, tool, { receivers, ...(prompt === null ? {} : { prompt }) }, startAt, agentId), statusOf(item), undefined, endAt));
      return;
    }
    default:
      break;
  }
  cursor.skipped += 1;
}

const ASYNC_QUESTION_TOOL = 'request_user_input_async';

function putAsyncQuestions(draft: FeedDraft, callId: string, questions: unknown[], at: string): void {
  questions.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const title = str(raw, 'title');
    if (title === null || title.trim() === '') return;
    const id = JSON.stringify([ASYNC_QUESTION_TOOL, callId, index]);
    // Оба формата журнала и replay описывают ту же карточку, включая уже снятую.
    if (draft.has(id)) return;
    const options = Array.isArray(raw['options'])
      ? raw['options'].filter((option): option is string => typeof option === 'string' && option.trim() !== '')
      : [];
    const question = title.slice(0, FEED_INPUT_LIMIT);
    const labels = options.map(label => label.slice(0, FEED_INPUT_LIMIT));
    const truncated = title.length > FEED_INPUT_LIMIT || options.some(label => label.length > FEED_INPUT_LIMIT);
    const card: FeedQuestionCard = {
      id, cardId: id, at, kind: 'question', state: 'pending', via: 'terminal',
      toolUseId: callId, toolName: ASYNC_QUESTION_TOOL,
      toolInput: { questions: [{ title: question, options: labels }] },
      questions: [{ question, header: null, options: labels.map(label => ({ label, description: null })), multiSelect: false }],
      ...(truncated ? { truncated: true } : {}),
    };
    draft.put(card);
  });
}

function onAsyncQuestion(draft: FeedDraft, record: RolloutRecord): void {
  const payload = record.payload;
  const type = str(payload, 'type');
  if ((type !== 'function_call' && type !== 'custom_tool_call') || str(payload, 'name') !== ASYNC_QUESTION_TOOL) return;
  const callId = str(payload, 'call_id');
  const args = str(payload, type === 'function_call' ? 'arguments' : 'input');
  if (callId === null || args === null) return;
  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    return;
  }
  if (isRecord(input) && Array.isArray(input['questions'])) putAsyncQuestions(draft, callId, input['questions'], record.at);
}

/** Заголовок в ответе TUI может быть обрезан: связываем только по полному questionItemId. */
function onAsyncReply(draft: FeedDraft, text: string, at: string): boolean {
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(text);
  if (match === null) return false;
  let replies: unknown;
  try {
    replies = JSON.parse(match[1] as string);
  } catch {
    return false;
  }
  if (!Array.isArray(replies) || !replies.every((reply) => isRecord(reply)
    && typeof reply['questionItemId'] === 'string' && typeof reply['answer'] === 'string')) return false;
  for (const reply of replies as Array<{ questionItemId: string; answer: string }>) {
    const card = draft.get(reply.questionItemId);
    if (card?.kind !== 'question' || card.toolName !== ASYNC_QUESTION_TOOL || card.state !== 'pending') continue;
    const question = card.questions[0];
    if (question !== undefined) draft.put({ ...card, state: 'answered', answers: { [question.question]: reply.answer }, settledAt: at });
  }
  // Конверт повторяется в response_item и UserMessage; сырой текст в ленте не нужен.
  return true;
}

function expireAsyncQuestions(draft: FeedDraft, at: string): void {
  for (const item of draft.items) {
    if (item.kind === 'question' && item.toolName === ASYNC_QUESTION_TOOL && item.state === 'pending') {
      draft.put({ ...item, state: 'stale', settledAt: at });
    }
  }
}

function applyRecord(draft: FeedDraft, record: RolloutRecord, cursor: CodexCursor, agentId: string | null, mail: boolean): void {
  if (record.type === 'turn_context') {
    if (agentId === null) onTurnContext(draft, record);
    return;
  }
  if (record.type === 'response_item') {
    if (agentId === null) {
      onAsyncQuestion(draft, record);
      if (record.payload['type'] === 'message' && record.payload['role'] === 'user') {
        onAsyncReply(draft, contentText(record.payload['content']), record.at);
      }
    }
    return;
  }
  if (record.type !== 'event_msg') return;
  const kind = str(record.payload, 'type');
  if (kind === 'item_completed') {
    cursor.modern = true;
    onItem(draft, record, cursor, agentId, mail);
    return;
  }
  if (agentId !== null) return;
  if (kind === 'task_started') draft.turnStartedAt = record.at;
  // Ход мог уже закрыть хук `Stop`: повторное закрытие по журналу не даёт второй черты.
  // Карточки одобрения не снимаем: запрос Codex идёт из ячейки code mode, которая переживает ход; пустой
  // ответ хуку уводит Codex в окно TUI, где `exec` ждёт без срока (разбор 2026-10-16).
  else if (kind === 'task_complete' || kind === 'turn_aborted') {
    expireAsyncQuestions(draft, record.at);
    if (draft.turnStartedAt !== null) closeTurn(draft, record.at, kind === 'turn_aborted', true);
  }
}

export function applyCodexRecords(
  state: FeedState,
  records: readonly RolloutRecord[],
  cursor: CodexCursor,
  agentId: string | null = null,
  mail = true,
): { update: FeedUpdate; cursor: CodexCursor } {
  const draft = new FeedDraft(state);
  const next: CodexCursor = { ...cursor };
  for (const record of records) {
    if (record.ordinal !== null) {
      if (record.ordinal <= next.lastOrdinal) continue;
      next.lastOrdinal = record.ordinal;
    }
    applyRecord(draft, record, next, agentId, mail);
  }
  return { update: draft.done(), cursor: next };
}

export function feedFromCodexRollout(
  records: readonly RolloutRecord[],
  options: { limit?: number; historyStart?: number; context?: 'root' | 'child' } = {},
): { state: FeedState; cursor: CodexCursor } {
  const start: CodexCursor = { ...emptyCodexCursor(), lastOrdinal: (options.historyStart ?? 0) - 1 };
  const { update, cursor } = applyCodexRecords(emptyFeedState(), records, start, null, options.context !== 'child');
  let { state } = update;
  const conversational = records.some((record) => record.type === 'response_item' || (record.type === 'event_msg' && str(record.payload, 'type') !== 'token_count'));
  if (!cursor.modern && conversational) {
    const note: FeedError = { id: 'error:codex-history', at: records[0]?.at ?? new Date(0).toISOString(), kind: 'error', error: CODEX_HISTORY_IN_TERMINAL, message: CODEX_HISTORY_MESSAGE };
    state = { ...state, items: [note, ...state.items] };
  }
  if (options.limit !== undefined && state.items.length > options.limit) state = { ...state, items: state.items.slice(-options.limit) };
  return { state, cursor };
}
