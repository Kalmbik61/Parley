/**
 * Замена агента сессии (спека 2026-10-30, 5.1, 6.7–6.9): чистые функции над картой. Сессия остаётся собой — id,
 * родитель, комнаты, пункты планов, worktree и личный план не трогаются, — меняются провайдер и разговор у него.
 */

import type { EffortLevel } from '../providers.js';
import type { AgentBinding, WorkMap, WorkSession } from './types.js';
import type { FrozenUsage } from './usage-ledger.js';

/** Сколько отрезков хранится в сессии: при переполнении два самых старых сливаются в один (спека, 5.9). */
export const PREVIOUS_AGENTS_MAX = 20;

/** Куда переводят сессию. Модель и effort не заданы — умолчание роли, как у новой сессии. */
export interface AgentTarget {
  provider: string;
  model?: string | null;
  effort?: EffortLevel | null;
}

const COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalInput'] as const;

const addCost = (a: number | null | undefined, b: number | null | undefined): number | null =>
  typeof a === 'number' && typeof b === 'number' ? a + b : null;

/** Сумма расхода двух соседних отрезков; неизвестный счётчик делает сумму неизвестной, полнота — не выше `partial`. */
function mergeUsage(older: FrozenUsage | undefined, younger: FrozenUsage | undefined): FrozenUsage | undefined {
  if (older === undefined || younger === undefined) {
    const one = older ?? younger;
    return one === undefined ? undefined : { ...one, completeness: one.completeness === 'complete' ? 'partial' : one.completeness };
  }
  const merged: FrozenUsage = { ...older, observedAt: younger.observedAt, closed: true };
  for (const field of COUNTERS) {
    const a = older[field];
    const b = younger[field];
    merged[field] = a === null || b === null ? null : a + b;
  }
  if (older.completeness !== 'complete' || younger.completeness !== 'complete') merged.completeness = 'partial';
  return merged;
}

/** Два самых старых отрезка в один: начало старшего, конец младшего, расход и стоимость — суммой. */
function mergeOldest(list: AgentBinding[]): AgentBinding[] {
  const [older, younger, ...rest] = list;
  if (older === undefined || younger === undefined) return list;
  const merged: AgentBinding = { ...younger, startedAt: older.startedAt };
  const usage = mergeUsage(older.usage, younger.usage);
  if (usage === undefined) delete merged.usage;
  else merged.usage = usage;
  if (older.costUsd !== undefined || younger.costUsd !== undefined) merged.costUsd = addCost(older.costUsd, younger.costUsd);
  return [merged, ...rest];
}

/**
 * Карта с заменённым агентом сессии: `binding` дописан в `previousAgents`, провайдер и выбор модели — цели,
 * разговор у провайдера, процесс и застревание сброшены, `agentRevision` — новая ревизия агента (ограда записей
 * прежнего MCP-процесса, спека 6.1; ревизию даёт оркестратор, на каждую замену своя). Исходная карта не меняется.
 * `switching` не трогает: его снимает оркестратор после запуска.
 */
export function applyAgentSwitch(map: WorkMap, sessionId: string, target: AgentTarget, binding: AgentBinding, agentRevision: string): WorkMap {
  const current = map.sessions.find((session) => session.id === sessionId);
  if (current === undefined) throw new Error(`session ${sessionId} not found`);
  let previous = [...(current.previousAgents ?? []), binding];
  while (previous.length > PREVIOUS_AGENTS_MAX) previous = mergeOldest(previous);
  const next: WorkSession = {
    ...current,
    provider: target.provider,
    providerSessionId: null,
    pid: null,
    startedAtProcess: null,
    stuck: null,
    previousAgents: previous,
    agentRevision,
  };
  delete next.codexThreadBinding;
  // Явный выбор прежнего провайдера цели не подходит; без выбора роль подставит умолчание при запуске.
  if (target.model === undefined) delete next.model;
  else next.model = target.model;
  if (target.effort === undefined) delete next.effort;
  else next.effort = target.effort;
  return { ...map, sessions: map.sessions.map((session) => (session === current ? next : session)) };
}

/** Причины, по которым сессию нельзя перевести на `target`; пусто — можно. Тексты уходят в ответ API. */
export function switchBlockers(map: WorkMap, sessionId: string, target: AgentTarget): string[] {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) return ['session not found'];
  const reasons: string[] = [];
  if (session.workspace !== null && session.workspace !== undefined) {
    reasons.push('autonomous engine sessions cannot change agent');
  }
  if (session.lifecycle === 'closed') reasons.push('session is closed');
  if (map.work.status === 'archived') reasons.push('work is archived');
  if (session.provider === target.provider) reasons.push('target is the current provider');
  return reasons;
}
