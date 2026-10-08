/**
 * Хуки Codex поверх ленты из журнала (спека 2026-10-07, 5.6). Хуки приходят, только если человек включил
 * `codexApprovals` и одобрил хуки в Codex. Содержимое ленты — из журнала; хуки дают карточку разрешения, раннее «идёт»
 * вызова и карточку агента до журнала. Повторное закрытие хода (`Stop`, затем `task_complete`) не добавляет второй черты.
 */

import {
  agentById,
  closeTurn,
  FeedDraft,
  finishAgent,
  finishTool,
  limitInput,
  newTool,
  withChild,
  withResult,
} from '../reduce.js';
import type { FeedAgent, FeedPermissionCard, FeedState, FeedUpdate } from '../types.js';

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/**
 * Раннее «идёт» по `PreToolUse`: нужно, чтобы `tool_use_id` хука совпадал с `item.id` элемента журнала (спека 13.2,
 * проба 6). Вживую это не проверено — выключено: вызов появляется законченным из журнала.
 */
export const CODEX_EARLY_TOOLS = false;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: Json, key: string): string | null => {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** Раннее «идёт» — только у Bash и MCP; у правок (`apply_patch`) в журнале свои id `<id>:<n>`. */
const earlyTool = (name: string): boolean => name === 'Bash' || name.startsWith('mcp__');

export function applyCodexHookEvent(state: FeedState, body: Json, at: string): FeedUpdate {
  const draft = new FeedDraft(state);
  const event = str(body, 'hook_event_name');
  const agentId = str(body, 'agent_id');
  const toolName = str(body, 'tool_name');
  const toolUseId = str(body, 'tool_use_id');
  const input = isRecord(body['tool_input']) ? body['tool_input'] : {};

  switch (event) {
    case 'PreToolUse': {
      if (!CODEX_EARLY_TOOLS || toolName === null || toolUseId === null || !earlyTool(toolName)) break;
      if (agentId !== null) {
        const agent = agentById(draft, agentId);
        if (agent !== undefined && !agent.children.some((child) => child.toolUseId === toolUseId)) {
          draft.put(withChild(agent, newTool(toolUseId, toolName, input, at, agentId)));
        }
        break;
      }
      if (!draft.has(`tool:${toolUseId}`)) draft.put(newTool(toolUseId, toolName, input, at, null));
      break;
    }
    case 'PostToolUse': {
      if (toolUseId === null || agentId !== null) break;
      const tool = draft.get(`tool:${toolUseId}`);
      if (tool?.kind === 'tool' && tool.status === 'running') {
        draft.put(finishTool(tool, 'done', body['tool_response'], at));
      }
      break;
    }
    case 'PermissionRequest': {
      if (toolName === null) break;
      const limited = limitInput(input);
      const id = draft.nextId('permission');
      const card: FeedPermissionCard = {
        id,
        at,
        kind: 'permission',
        cardId: id,
        state: 'pending',
        toolUseId: null,
        toolName,
        toolInput: limited.input,
        suggestions: [],
        notified: false,
        ...(limited.truncated ? { truncated: true } : {}),
        ...(agentId === null ? {} : { agentId }),
      };
      draft.put(card);
      break;
    }
    case 'SubagentStart': {
      if (agentId === null || agentById(draft, agentId) !== undefined) break;
      const card: FeedAgent = {
        id: `agent:${agentId}`,
        at,
        kind: 'agent',
        toolUseId: agentId,
        agentId,
        agentType: str(body, 'agent_type'),
        description: null,
        prompt: null,
        model: null,
        background: false,
        status: 'running',
        toolCount: 0,
        children: [],
      };
      draft.put(card);
      break;
    }
    case 'SubagentStop': {
      const agent = agentId === null ? undefined : agentById(draft, agentId);
      if (agent === undefined || agent.status !== 'running') break;
      const message = str(body, 'last_assistant_message');
      const finished = finishAgent(agent, 'done', at);
      draft.put(message === null ? finished : withResult(finished, message));
      break;
    }
    case 'Stop': {
      if (agentId === null && draft.turnStartedAt !== null) closeTurn(draft, at, false);
      break;
    }
    default:
      break;
  }
  return draft.done();
}
