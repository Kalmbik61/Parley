/**
 * Агенты Codex (спека 2026-10-07, 3 п. 10–11 и 5.2). Карточку ставит `SubAgentActivity started` в журнале родителя:
 * `agentId` — id треда агента. У агента свой журнал: в начале — копия истории родителя до
 * `subagent_history_start_ordinal`, своё — после неё. Задание — первое межагентное сообщение агенту после отметки
 * (`response_item/agent_message`), итог — последний `AgentMessage` с фазой `final_answer`, тип — `agent_role`, иначе
 * прозвище, модель — `turn_context` агента.
 */

import { agentById, FeedDraft, limitText, withResult } from '../reduce.js';
import { FEED_AGENT_TEXT_LIMIT, type FeedAgent, type FeedState, type FeedUpdate } from '../types.js';
import type { RolloutRecord } from './rollout-record.js';

export interface CodexAgentMeta {
  threadId: string | null;
  parentThreadId: string | null;
  nickname: string | null;
  role: string | null;
  model: string | null;
  historyStart: number;
  task: string | null;
  result: string | null;
}

export const emptyCodexAgentMeta = (): CodexAgentMeta => ({
  threadId: null,
  parentThreadId: null,
  nickname: null,
  role: null,
  model: null,
  historyStart: 0,
  task: null,
  result: null,
});

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: Json | null | undefined, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(isRecord)
        .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
        .filter(Boolean)
        .join('\n')
    : '';

function spawnOf(payload: Json): Json | null {
  const source = payload['source'];
  const subagent = isRecord(source) ? source['subagent'] : null;
  const spawn = isRecord(subagent) ? subagent['thread_spawn'] : null;
  return isRecord(spawn) ? spawn : null;
}

/** Сведения из журнала агента; `prior` — уже собранное с прошлых чтений (хвостом). */
export function codexAgentMeta(records: readonly RolloutRecord[], prior: CodexAgentMeta = emptyCodexAgentMeta()): CodexAgentMeta {
  const meta: CodexAgentMeta = { ...prior };
  for (const record of records) {
    const payload = record.payload;
    if (record.type === 'session_meta') {
      if (meta.threadId !== null) continue;
      const spawn = spawnOf(payload);
      meta.threadId = str(payload, 'id');
      meta.parentThreadId = str(payload, 'parent_thread_id') ?? str(spawn, 'parent_thread_id');
      meta.nickname = str(payload, 'agent_nickname') ?? str(spawn, 'agent_nickname');
      meta.role = str(spawn, 'agent_role');
      const start = payload['subagent_history_start_ordinal'];
      if (typeof start === 'number' && Number.isFinite(start)) meta.historyStart = start;
      continue;
    }
    if (record.ordinal !== null && record.ordinal < meta.historyStart) continue;
    if (record.type === 'turn_context') {
      meta.model = str(payload, 'model') ?? meta.model;
    } else if (record.type === 'response_item' && str(payload, 'type') === 'agent_message' && meta.task === null) {
      const text = textOf(payload['content']);
      if (text !== '') meta.task = text;
    } else if (record.type === 'event_msg' && str(payload, 'type') === 'item_completed') {
      const item = payload['item'];
      if (isRecord(item) && str(item, 'type') === 'AgentMessage' && str(item, 'phase') === 'final_answer') {
        const text = textOf(item['content']);
        if (text !== '') meta.result = text;
      }
    }
  }
  return meta;
}

/** Сведения — в карточку агента: тип, описание, модель, задание, итог. */
export function withCodexAgentMeta(state: FeedState, agentId: string, meta: CodexAgentMeta): FeedUpdate {
  const draft = new FeedDraft(state);
  const agent = agentById(draft, agentId);
  if (agent === undefined) return draft.done();
  let next: FeedAgent = {
    ...agent,
    agentType: meta.role ?? meta.nickname ?? agent.agentType,
    description: meta.nickname ?? agent.description,
    model: meta.model ?? agent.model,
  };
  if (meta.task !== null) {
    const { text, truncated } = limitText(meta.task, FEED_AGENT_TEXT_LIMIT);
    next = { ...next, prompt: text, ...(truncated ? { truncated: true } : {}) };
  }
  if (meta.result !== null) next = withResult(next, meta.result);
  draft.put(next);
  return draft.done();
}
