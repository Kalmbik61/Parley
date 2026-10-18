import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PLAN_DESCRIPTION_LIMIT, PLAN_ITEMS_LIMIT, type AgentPlanState } from '../agent-plan.js';
import { updateMap } from '../work/store.js';
import type { McpContext } from './context.js';

export const AGENT_PLAN_TOOL: Tool = {
  name: 'publish_agent_plan',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  description: 'Publish your own execution steps in the human’s agent card and Agents panel. Before multi-step work, publish the full list; update it when a step starts, completes or the approach changes. Keep completed steps until a new task starts. This replaces your previous personal plan; it does not change accepted room assignments, send messages or wake the feature lead. Use explanation for blockers. An empty steps list clears the personal plan.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['steps'],
    properties: {
      steps: { type: 'array', maxItems: PLAN_ITEMS_LIMIT, items: {
        type: 'object', additionalProperties: false, required: ['step', 'status'],
        properties: {
          step: { type: 'string', minLength: 1, maxLength: 512 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          description: { type: 'string', maxLength: PLAN_DESCRIPTION_LIMIT },
        },
      } },
      explanation: { type: 'string', maxLength: PLAN_DESCRIPTION_LIMIT },
    },
  },
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, max: number, required = false): string | null {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new Error(`Plan text must be ${required ? 'nonempty and ' : ''}at most ${max} characters`);
  return value;
}

export async function publishAgentPlan(context: McpContext, args: Record<string, unknown>): Promise<unknown> {
  if (context.sessionId === null) throw new Error('Publishing a plan requires a Parley session');
  if (Object.keys(args).some(key => !['steps', 'explanation'].includes(key)) ||
      !Array.isArray(args.steps) || args.steps.length > PLAN_ITEMS_LIMIT)
    throw new Error(`Provide only steps (at most ${PLAN_ITEMS_LIMIT}) and optional explanation; the caller identity is fixed`);
  const items: AgentPlanState['items'] = args.steps.map((value: unknown, index: number) => {
    if (!record(value) || Object.keys(value).some(key => !['step', 'status', 'description'].includes(key)) ||
        !['pending', 'in_progress', 'completed'].includes(String(value.status)))
      throw new Error('Each step requires step and status: pending, in_progress or completed; description is optional');
    return {
      id: String(index + 1), subject: text(value.step, 512, true)!,
      status: value.status as AgentPlanState['items'][number]['status'],
      description: text(value.description, PLAN_DESCRIPTION_LIMIT), activeForm: null,
    };
  });
  if (items.filter(item => item.status === 'in_progress').length > 1)
    throw new Error('Only one personal step may be in_progress; track delegated work separately');
  const explanation = text(args.explanation, PLAN_DESCRIPTION_LIMIT);
  await updateMap(context.projectPath, context.workId, map => {
    const session = map.sessions.find(row => row.id === context.sessionId);
    if (session === undefined || session.lifecycle === 'closed' || map.work.status !== 'active')
      throw new Error('Publishing a plan requires an open session in an active workspace');
    session.agentPlan = { items, explanation, partial: false, updatedAt: new Date().toISOString() };
  });
  return { ok: true, completed: items.filter(item => item.status === 'completed').length, total: items.length };
}
