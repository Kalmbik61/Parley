/**
 * Модель панели агентов (спека 2026-10-07, 5.1): строки по карточкам `agent` ленты сессии — работающие и закончившие
 * отдельно, в порядке ленты; текущий шаг — строка последнего вложенного вызова; этапы — свёртка успешных
 * плановых вызовов общей моделью core. Ни React, ни моста — только элементы ленты.
 */

import type { FeedAgent, FeedAgentStatus, FeedItem } from '@parley/core';
import { applyPlanCall, capPlan, type AgentPlan, type AgentPlanState } from '@parley/core/agent-plan';
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

const PLAN_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'update_plan']);

export function agentStepsPartial(agent: FeedAgent): boolean {
  return agent.toolCount > agent.children.length || agent.children.some((call) =>
    PLAN_TOOLS.has(call.name) && (call.truncated === true || call.response?.truncated === true),
  );
}

export function agentSteps(agent: FeedAgent): AgentPlan | null {
  const partial = agentStepsPartial(agent);
  let plan: AgentPlanState | null = null;
  for (const call of agent.children) {
    plan = applyPlanCall(plan, {
      name: call.name,
      input: call.input,
      result: call.response?.text,
      status: call.status,
      at: call.at,
    });
    if (plan !== null && partial) plan = { ...plan, partial: true };
  }
  return plan === null ? null : capPlan(plan);
}

export function findAgent(items: readonly FeedItem[], pick: AgentPick): FeedAgent | null {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]!;
    if (!isAgent(item)) continue;
    if (pick.by === 'item' ? item.id === pick.id : item.agentId === pick.id) return item;
  }
  return null;
}
