import {
  applyPlanCall,
  capPlan,
  type AgentPlan,
  type AgentPlanState,
  type PlanCall,
} from './agent-plan.js';

export interface PlanCollector {
  onRecord(raw: Record<string, unknown>): void;
  finish(): AgentPlan | null;
  clone(): PlanCollector;
}
const names = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'update_plan']);
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function output(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map((v) => record(v)?.text)
      .filter((v) => typeof v === 'string')
      .join('\n');
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
function outcome(
  value: unknown,
  error: unknown,
  engine: 'claude' | 'codex',
): PlanCall['status'] | null {
  const object = record(value);
  if (
    error === true ||
    object?.success === false ||
    object?.is_error === true ||
    object?.error != null
  )
    return 'failed';
  if (typeof value === 'string') {
    if (/^(?:user\s+)?(?:rejected|refused|denied)\b/i.test(value)) return 'rejected';
    if (/^(error|failed|failure)\b/i.test(value.trim())) return 'failed';
    return value.trim() && (engine === 'claude' || /^plan updated[.!]?$/i.test(value.trim()))
      ? 'done'
      : null;
  }
  return object && (engine === 'claude' || object.success === true) ? 'done' : null;
}
class Collector implements PlanCollector {
  private calls = new Map<string, PlanCall>();
  constructor(private readonly engine: 'claude' | 'codex') {}
  clone(): PlanCollector {
    const copy = new Collector(this.engine);
    // Entries are replaced, never modified; input/results are read-only log values.
    copy.calls = new Map(this.calls);
    return copy;
  }
  private call(id: unknown, name: unknown, input: unknown, at: unknown): void {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof name !== 'string' ||
      !names.has(name) ||
      this.calls.has(id)
    )
      return;
    const object = record(input);
    if (object)
      this.calls.set(id, {
        name,
        input: object,
        at: typeof at === 'string' ? at : '',
        status: 'running',
      });
  }
  private result(id: unknown, value: unknown, error?: unknown): void {
    if (typeof id !== 'string') return;
    const call = this.calls.get(id);
    if (!call || call.status !== 'running') return;
    const result = output(value);
    const status = outcome(result, error, this.engine);
    if (status) this.calls.set(id, { ...call, result, status });
  }
  onRecord(raw: Record<string, unknown>): void {
    if (this.engine === 'claude') {
      if (raw.isSidechain === true || (raw.type !== 'assistant' && raw.type !== 'user')) return;
      const content = record(raw.message)?.content;
      if (!Array.isArray(content)) return;
      const singleResult = content.filter((v) => record(v)?.type === 'tool_result').length === 1;
      for (const value of content) {
        const block = record(value);
        if (block?.type === 'tool_use') this.call(block.id, block.name, block.input, raw.timestamp);
        if (block?.type === 'tool_result') {
          // Structured toolUseResult belongs to the single result on this record.
          const structured = singleResult ? raw.toolUseResult : undefined;
          this.result(block.tool_use_id, structured ?? block.content, block.is_error);
        }
      }
    } else {
      if (raw.type !== 'response_item') return;
      const payload = record(raw.payload);
      if (payload?.type === 'function_call' && payload.name === 'update_plan') {
        this.call(payload.call_id, payload.name, output(payload.arguments), raw.timestamp);
      } else if (payload?.type === 'function_call_output') {
        this.result(payload.call_id, payload.output);
      }
    }
  }
  finish(): AgentPlan | null {
    let plan: AgentPlanState | null = null;
    for (const call of this.calls.values()) plan = applyPlanCall(plan, call);
    return plan ? capPlan(plan) : null;
  }
}
export function createClaudePlanCollector(): PlanCollector {
  return new Collector('claude');
}
export function createCodexPlanCollector(): PlanCollector {
  return new Collector('codex');
}
