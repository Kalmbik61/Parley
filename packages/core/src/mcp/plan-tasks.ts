import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { planTasksView } from '../work/plan-tasks.js';
import { readMap } from '../work/store.js';
import type { McpContext } from './context.js';

export const PLAN_TASKS_TOOL: Tool = {
  name: 'plan_tasks',
  annotations: { readOnlyHint: true },
  description:
    'List your accepted room-plan assignments with the next action for each and what each waits for; reading a letter does not finish an assignment.',
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', pattern: '^pl-[0-9]+$', maxLength: 128, description: 'Only this plan.' },
      item: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: 'With planId: read this one item in full, with its latest log entries and both saved checkpoints.',
      },
      cursor: { type: 'string', maxLength: 256, description: 'The next value of the previous page.' },
    },
    additionalProperties: false,
  },
};

/** Вызывающий берётся из контекста запуска: параметра сессии у инструмента нет. */
export async function planTasks(
  context: McpContext,
  sessionId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (Object.keys(args).some((key) => !['planId', 'item', 'cursor'].includes(key)))
    throw new Error('plan_tasks takes only planId, item and cursor; the caller is fixed by the launch');
  const { planId, item, cursor } = args;
  if (planId !== undefined && (typeof planId !== 'string' || !/^pl-\d+$/.test(planId) || planId.length > 128))
    throw new Error('argument planId: a plan ID like pl-01 is required');
  if (item !== undefined && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1))
    throw new Error('argument item: a positive integer is required');
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 256))
    throw new Error('argument cursor: use the next value of the previous page');
  const map = await readMap(context.projectPath, context.workId);
  return planTasksView(map, sessionId, {
    ...(planId === undefined ? {} : { planId: planId as string }),
    ...(item === undefined ? {} : { item: item as number }),
    ...(cursor === undefined ? {} : { cursor: cursor as string }),
  });
}
