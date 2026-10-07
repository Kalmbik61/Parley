// packages/desktop/src/renderer/agents/agents-model.ts
/**
 * Модель панели агентов (спека 2026-10-07, 5.1): строки по карточкам `agent` ленты сессии — работающие и закончившие
 * отдельно, в порядке ленты; текущий шаг — строка последнего вложенного вызова; этапы — последний `TodoWrite` (Claude)
 * или `update_plan` (Codex). Ни React, ни моста — только элементы ленты.
 */

import type { FeedAgent, FeedAgentStatus, FeedItem } from '@parley/core';
import { toolHeadline, type ToolHeadline } from '../chat/feed-model.js';

export interface AgentRow {
  itemId: string;
  agentId: string | null;
  title: string | null;
  type: string | null;
  model: string | null;
  status: FeedAgentStatus;
  background: boolean;
  toolCount: number;
  startedAt: string;
  durationMs: number | null;
  step: ToolHeadline | null;
}

export interface AgentGroups {
  running: AgentRow[];
  finished: AgentRow[];
}

/** Какой агент открыт на экране: по id карточки (из списка) или по `agentId` (из поповера). */
export type AgentPick = { by: 'item'; id: string } | { by: 'agent'; id: string };

export interface AgentStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const isAgent = (item: FeedItem): item is FeedAgent => item.kind === 'agent';

function rowOf(agent: FeedAgent): AgentRow {
  const last = agent.children[agent.children.length - 1];
  return {
    itemId: agent.id,
    agentId: agent.agentId,
    title: agent.description ?? agent.agentType,
    type: agent.agentType,
    model: agent.model,
    status: agent.status,
    background: agent.background,
    toolCount: agent.toolCount,
    startedAt: agent.at,
    durationMs: agent.durationMs ?? null,
    step: last === undefined ? null : toolHeadline(last.name, last.input),
  };
}

export function agentRows(items: readonly FeedItem[]): AgentGroups {
  const running: AgentRow[] = [];
  const finished: AgentRow[] = [];
  for (const item of items) {
    if (!isAgent(item)) continue;
    (item.status === 'running' ? running : finished).push(rowOf(item));
  }
  return { running, finished };
}

const STEP_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function stepsOf(list: unknown, textKey: 'content' | 'step'): AgentStep[] | null {
  if (!Array.isArray(list)) return null;
  const steps: AgentStep[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = record[textKey];
    if (typeof text !== 'string' || text === '') continue;
    const status = typeof record['status'] === 'string' && STEP_STATUSES.has(record['status']) ? (record['status'] as AgentStep['status']) : 'pending';
    steps.push({ text, status });
  }
  return steps.length === 0 ? null : steps;
}

export function agentSteps(agent: FeedAgent): AgentStep[] | null {
  for (let at = agent.children.length - 1; at >= 0; at -= 1) {
    const call = agent.children[at]!;
    if (call.name === 'TodoWrite') return stepsOf(call.input['todos'], 'content');
    if (call.name === 'update_plan') return stepsOf(call.input['plan'], 'step');
  }
  return null;
}

export function findAgent(items: readonly FeedItem[], pick: AgentPick): FeedAgent | null {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]!;
    if (!isAgent(item)) continue;
    if (pick.by === 'item' ? item.id === pick.id : item.agentId === pick.id) return item;
  }
  return null;
}
