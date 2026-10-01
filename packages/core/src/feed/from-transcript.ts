/**
 * Лента из журнала сессии Claude Code (план 2026-10-01, Task 1, пункт 3): история для сессии, чьих
 * событий хост не видел (хост перезапущен, сессия возобновлена). Текст по мере вывода журнал не
 * хранит, зато в нём есть вызовы, результаты и диффы. Тот же разбор читает журнал субагента
 * (`<сессия>/subagents/agent-<id>.jsonl`, записи с `isSidechain: true`) для раскрытой карточки.
 *
 * Формат журнала недокументирован: общие поля берёт `adapterV1`, здесь — только содержимое реплик.
 */

import { adapterV1 } from '../adapter-v1.js';
import type { RawRecord } from '../jsonl.js';
import { isRecord, textOf } from '../work/events.js';
import {
  FeedDraft,
  agentByToolUse,
  applyAgentResponse,
  applyTaskNotification,
  blocksText,
  emptyFeedState,
  finishAgent,
  finishTool,
  mainTool,
  newAgent,
  newText,
  newTool,
  parseTaskNotification,
} from './reduce.js';
import type { FeedState, FeedTool, FeedToolStatus } from './types.js';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
/** Запись прерывания: «[Request interrupted by user]», «… for tool use]». */
const INTERRUPTED = '[Request interrupted by user';
/** `toolUseResult` вызова, отклонённого в диалоге разрешения. */
const REJECTED = 'User rejected tool use';
/** Служебные вставки слеш-команд: вывод и пояснение — не реплика человека. */
const LOCAL_COMMAND = /^\s*<local-command-(stdout|stderr|caveat)>/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** Реплика человека: промпт, слеш-команда, пробуждение субагентом или прерывание. */
function onUserText(draft: FeedDraft, text: string, images: number, at: string): void {
  if (text.startsWith(INTERRUPTED)) {
    for (const tool of draft.filter(
      (item): item is FeedTool => item.kind === 'tool' && item.agentId === undefined,
    )) {
      if (tool.status === 'running') draft.put({ ...tool, status: 'rejected', endedAt: at });
    }
    return;
  }
  const note = parseTaskNotification(text);
  if (note !== null) {
    applyTaskNotification(draft, note, at);
    return;
  }
  if (LOCAL_COMMAND.test(text)) return;
  const command = COMMAND_NAME.exec(text);
  if (command !== null) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? '';
    const name = command[1]?.trim() ?? '';
    draft.put({
      id: draft.nextId('prompt'),
      at,
      kind: 'prompt',
      text: args === '' ? name : `${name} ${args}`,
      images,
    });
    return;
  }
  draft.put({ id: draft.nextId('prompt'), at, kind: 'prompt', text, images });
}

/** `tool_result` закрывает вызов: результат — `toolUseResult` записи, а нет его — текст для модели. */
function onToolResult(
  draft: FeedDraft,
  block: Record<string, unknown>,
  toolUseResult: unknown,
  at: string,
): void {
  const toolUseId = textOf(block['tool_use_id']);
  if (toolUseId === null) return;
  const isError = block['is_error'] === true;

  const agent = agentByToolUse(draft, toolUseId);
  if (agent !== undefined) {
    draft.put(
      isError ? finishAgent(agent, 'failed', at) : applyAgentResponse(agent, toolUseResult, at),
    );
    return;
  }
  const tool = mainTool(draft, toolUseId);
  if (tool === undefined) return;
  const rejected = typeof toolUseResult === 'string' && toolUseResult.startsWith(REJECTED);
  const status: FeedToolStatus = rejected ? 'rejected' : isError ? 'failed' : 'done';
  const response = isRecord(toolUseResult)
    ? toolUseResult
    : (blocksText(block['content']) ?? toolUseResult);
  draft.put(finishTool(tool, status, response, at));
}

function onUser(draft: FeedDraft, raw: RawRecord, content: unknown, at: string): void {
  if (typeof content === 'string') {
    onUserText(draft, content, 0, at);
    return;
  }
  if (!Array.isArray(content)) return;
  const texts: string[] = [];
  let images = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'tool_result') onToolResult(draft, block, raw['toolUseResult'], at);
    else if (block['type'] === 'image') images += 1;
    else if (block['type'] === 'text' && typeof block['text'] === 'string')
      texts.push(block['text']);
  }
  if (texts.length > 0 || images > 0) onUserText(draft, texts.join('\n'), images, at);
}

function onAssistant(
  draft: FeedDraft,
  raw: RawRecord,
  uuid: string,
  messageId: string | null,
  content: unknown,
  at: string,
): void {
  if (raw['isApiErrorMessage'] === true) {
    draft.put({
      id: draft.nextId('error'),
      at,
      kind: 'error',
      error: textOf(raw['error']) ?? 'api_error',
      message: blocksText(content),
    });
    return;
  }
  if (typeof content === 'string') {
    if (content !== '') draft.put(newText(`text:${uuid}`, at, messageId, content, false));
    return;
  }
  if (!Array.isArray(content)) return;
  content.forEach((block, index) => {
    if (!isRecord(block)) return;
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      draft.put(newText(`text:${uuid}:${index}`, at, messageId, block['text'], false));
    } else if (block['type'] === 'tool_use') {
      const toolUseId = textOf(block['id']);
      const name = textOf(block['name']);
      if (toolUseId === null || name === null) return;
      const input = isRecord(block['input']) ? block['input'] : {};
      draft.put(
        AGENT_TOOLS.has(name)
          ? newAgent(toolUseId, input, at)
          : newTool(toolUseId, name, input, at, null),
      );
    }
    // `thinking` в v1 не показываем: по мере вывода его нет (решение 3).
  });
}

/** Время записи без `timestamp`, если до неё не было ни одной записи со временем. */
const EPOCH = new Date(0).toISOString();

export interface FeedFromTranscriptOptions {
  /** Сколько последних элементов вернуть; нет — все. */
  limit?: number;
}

/**
 * Лента из записей журнала (`readJsonlRecords`) в порядке файла. Результат — состояние редьюсера:
 * живые события хуков продолжают его через `applyHookEvent`. Запись без времени получает время
 * предыдущей.
 */
export function feedFromTranscript(
  records: Iterable<RawRecord>,
  { limit }: FeedFromTranscriptOptions = {},
): FeedState {
  const draft = new FeedDraft(emptyFeedState());
  let seq = 0;
  let at = EPOCH;
  for (const raw of records) {
    const record = adapterV1.toSessionRecord(raw);
    at = record.timestamp ?? at;
    seq += 1;
    const uuid = record.uuid ?? `#${seq}`;
    const message = isRecord(raw['message']) ? raw['message'] : null;

    if (record.type === 'user') {
      if (!record.isMeta) onUser(draft, raw, message?.['content'], at);
    } else if (record.type === 'assistant') {
      onAssistant(draft, raw, uuid, record.messageId, message?.['content'], at);
    } else if (record.type === 'system' && raw['subtype'] === 'turn_duration') {
      const duration = raw['durationMs'];
      draft.put({
        id: `turn:${uuid}`,
        at,
        kind: 'turn',
        durationMs: typeof duration === 'number' ? duration : null,
      });
    }
    // `queue-operation`, `attachment`, `mode`, заголовки и прочее служебное в ленту не идут.
  }
  const state = draft.done().state;
  return limit === undefined || state.items.length <= limit
    ? state
    : { ...state, items: state.items.slice(state.items.length - limit) };
}
