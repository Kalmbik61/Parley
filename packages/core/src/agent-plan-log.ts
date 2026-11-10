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
// Свёрнутое состояние + хвост с первого незавершённого вызова: не проигрываем весь журнал на каждый снимок.
const PENDING_MAX = 64;
const SEEN_MAX = 1024;
class Collector implements PlanCollector {
  private base: AgentPlanState | null = null;
  private pending = new Map<string, PlanCall>();
  private seen = new Set<string>();
  constructor(private readonly engine: 'claude' | 'codex') {}
  clone(): PlanCollector {
    const copy = new Collector(this.engine);
    // Состояния и записи заменяются, не мутируются: base и вызовы можно делить по ссылке.
    copy.base = this.base;
    copy.pending = new Map(this.pending);
    copy.seen = new Set(this.seen);
    return copy;
  }
  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
  // Сворачиваем голову хвоста, пока она не `running`; слишком длинный хвост бросает брошенную голову.
  private fold(): void {
    for (;;) {
      const head = this.pending.entries().next().value;
      if (!head) return;
      const [id, call] = head;
      if (call.status === 'running') {
        if (this.pending.size <= PENDING_MAX) return;
      } else {
        this.base = applyPlanCall(this.base, call);
      }
      this.pending.delete(id);
      this.remember(id);
    }
  }
  private call(id: unknown, name: unknown, input: unknown, at: unknown): void {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof name !== 'string' ||
      !names.has(name) ||
      this.pending.has(id) ||
      this.seen.has(id)
    )
      return;
    const object = record(input);
    if (object)
      this.pending.set(id, {
        name,
        input: object,
        at: typeof at === 'string' ? at : '',
        status: 'running',
      });
    this.fold();
  }
  private result(id: unknown, value: unknown, error?: unknown): void {
    if (typeof id !== 'string') return;
    const call = this.pending.get(id);
    if (!call || call.status !== 'running') return;
    const result = output(value);
    const status = outcome(result, error, this.engine);
    if (status) {
      this.pending.set(id, { ...call, result, status });
      this.fold();
    }
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
    let plan = this.base;
    for (const call of this.pending.values()) plan = applyPlanCall(plan, call);
    return plan ? capPlan(plan) : null;
  }
}
export function createClaudePlanCollector(): PlanCollector {
  return new Collector('claude');
}
export function createCodexPlanCollector(): PlanCollector {
  return new Collector('codex');
}
