export type AgentPlanStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentPlanItem {
  id: string | null;
  subject: string;
  description: string | null;
  activeForm: string | null;
  status: AgentPlanStatus;
}

export interface AgentPlanState {
  items: AgentPlanItem[];
  explanation: string | null;
  updatedAt: string;
  partial: boolean;
}

export interface AgentPlanSummary {
  current: AgentPlanItem | null;
  next: AgentPlanItem | null;
  done: number;
  total: number;
}

export interface AgentPlan extends AgentPlanState {
  omitted: number;
  summary: AgentPlanSummary;
}

/** Результат — объект, JSON-строка или текст ответа инструмента. */
export interface PlanCall {
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  status: 'running' | 'done' | 'failed' | 'rejected';
  at: string;
}

export const PLAN_ITEMS_LIMIT = 50;
export const PLAN_DESCRIPTION_LIMIT = 4096;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function status(value: unknown): AgentPlanStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

function resultValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function applyPlanCall(plan: AgentPlanState | null, call: PlanCall): AgentPlanState | null {
  const result = resultValue(call.result);
  const object = record(result);
  if (
    call.status !== 'done' ||
    result == null ||
    object?.success === false ||
    object?.is_error === true
  )
    return plan;
  const input = call.input;

  if (call.name === 'TaskCreate') {
    const subject = text(input.subject);
    if (!subject?.trim()) return plan;
    const rawId = record(object?.task)?.id;
    const id =
      typeof rawId === 'string' && rawId.trim()
        ? rawId
        : typeof rawId === 'number' && Number.isFinite(rawId)
          ? String(rawId)
          : typeof result === 'string'
            ? (/Task #(\d+) created successfully:/.exec(result)?.[1] ?? null)
            : null;
    const reset =
      plan &&
      ((!plan.partial &&
        plan.items.length > 0 &&
        plan.items.every((item) => item.status === 'completed')) ||
        (id !== null && plan.items.some((item) => item.id === id)));
    const previous = reset ? null : plan;
    return {
      items: [
        ...(previous?.items ?? []),
        {
          id,
          subject,
          description: text(input.description),
          activeForm: text(input.activeForm),
          status: 'pending',
        },
      ],
      explanation: previous?.explanation ?? null,
      updatedAt: call.at,
      partial: (previous?.partial ?? false) || id === null,
    };
  }

  if (call.name === 'TaskUpdate') {
    if (!plan) return plan;
    const id = text(input.taskId);
    const index = id ? plan.items.findIndex((item) => item.id === id) : -1;
    const previousItem = plan.items[index];
    if (previousItem === undefined) return { ...plan, partial: true, updatedAt: call.at };
    if (input.status === 'deleted')
      return { ...plan, items: plan.items.filter((_, i) => i !== index), updatedAt: call.at };
    if (typeof input.subject === 'string' && !input.subject.trim()) return plan;
    const item = { ...previousItem };
    if ('status' in input) item.status = status(input.status);
    if (typeof input.subject === 'string') item.subject = input.subject;
    if ('description' in input) item.description = text(input.description);
    if ('activeForm' in input) item.activeForm = text(input.activeForm);
    return {
      ...plan,
      items: plan.items.map((previous, i) => (i === index ? item : previous)),
      updatedAt: call.at,
    };
  }

  if (call.name === 'TodoWrite' || call.name === 'update_plan') {
    const rows = call.name === 'TodoWrite' ? input.todos : input.plan;
    if (!Array.isArray(rows)) return plan;
    const items: AgentPlanItem[] = [];
    let partial = false;
    for (const row of rows) {
      const entry = record(row);
      const subject = text(call.name === 'TodoWrite' ? entry?.content : entry?.step);
      if (!subject?.trim()) {
        partial = true;
        continue;
      }
      items.push({
        id: null,
        subject,
        description: null,
        activeForm: text(entry?.activeForm),
        status: status(entry?.status),
      });
    }
    return {
      items,
      explanation: call.name === 'update_plan' ? text(input.explanation) : null,
      updatedAt: call.at,
      partial,
    };
  }
  return plan;
}

function capItem(item: AgentPlanItem): AgentPlanItem {
  const description = item.description;
  return description && description.length > PLAN_DESCRIPTION_LIMIT
    ? { ...item, description: description.slice(0, PLAN_DESCRIPTION_LIMIT - 1) + '…' }
    : { ...item };
}

export function capPlan(plan: AgentPlanState): AgentPlan {
  const current = plan.items.find((item) => item.status === 'in_progress') ?? null;
  const next = current ? null : (plan.items.find((item) => item.status === 'pending') ?? null);
  const selected = current ?? next;
  const items = plan.items.slice(0, PLAN_ITEMS_LIMIT);
  if (selected && !items.includes(selected)) items[items.length - 1] = selected;
  return {
    ...plan,
    items: items.map(capItem),
    omitted: plan.items.length - items.length,
    summary: {
      current: current ? capItem(current) : null,
      next: next ? capItem(next) : null,
      done: plan.items.filter((item) => item.status === 'completed').length,
      total: plan.items.length,
    },
  };
}

export function planSummary(plan: AgentPlan): AgentPlanSummary {
  return plan.summary;
}
