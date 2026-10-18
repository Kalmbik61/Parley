import { describe, expect, it } from 'vitest';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import { agentRows, agentSteps, agentStepsPartial, findAgent } from './agents-model.js';

const AT = '2026-10-07T10:00:00.000Z';
const LONG_PATH = `/Users/someone/projects/${'very-long-directory-name/'.repeat(5)}feed/types.ts`;

function agent(over: Partial<FeedAgent> = {}): FeedAgent {
  return {
    id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore',
    description: 'Найти все вызовы FeedAgent', prompt: 'Найди все вызовы', model: 'haiku', background: false,
    status: 'running', toolCount: 0, children: [], ...over,
  };
}
function child(id: string, name: string, input: Record<string, unknown>): FeedTool {
  return { id: `tool:${id}`, at: AT, kind: 'tool', toolUseId: id, name, input, status: 'done', agentId: 'a1' };
}

describe('agentRows', () => {
  it('работающие и закончившие — отдельными группами, в порядке ленты', () => {
    const items: FeedItem[] = [
      agent({ id: 'agent:t1', toolUseId: 't1', status: 'done', durationMs: 5000 }),
      agent({ id: 'agent:t2', toolUseId: 't2', agentId: 'a2' }),
      agent({ id: 'agent:t3', toolUseId: 't3', agentId: 'a3', status: 'failed' }),
      agent({ id: 'agent:t4', toolUseId: 't4', agentId: 'a4' }),
    ];
    const groups = agentRows(items);
    expect(groups.running.map((row) => row.itemId)).toEqual(['agent:t2', 'agent:t4']);
    expect(groups.finished.map((row) => row.itemId)).toEqual(['agent:t1', 'agent:t3']);
    expect(groups.finished[0]?.durationMs).toBe(5000);
    expect(groups.running[0]?.durationMs).toBeNull();
  });

  it('текущий шаг — строка последнего вложенного вызова; без вызовов — null', () => {
    const busy = agent({ children: [child('c1', 'Bash', { command: 'ls' }), child('c2', 'Read', { file_path: LONG_PATH })], toolCount: 2 });
    const idle = agent({ id: 'agent:t9', toolUseId: 't9', agentId: 'a9' });
    const [first, second] = agentRows([busy, idle]).running;
    expect(first?.step).toEqual({ name: 'Read', summary: LONG_PATH });
    expect(first?.toolCount).toBe(2);
    expect(second?.step).toBeNull();
  });

  it('заголовок — описание, иначе тип, иначе null', () => {
    const rows = agentRows([
      agent({ id: 'agent:a', toolUseId: 'a' }),
      agent({ id: 'agent:b', toolUseId: 'b', description: null }),
      agent({ id: 'agent:c', toolUseId: 'c', description: null, agentType: null }),
    ]).running;
    expect(rows.map((row) => row.title)).toEqual(['Найти все вызовы FeedAgent', 'Explore', null]);
  });

  it('агент без agentId — среди работающих, agentId null', () => {
    expect(agentRows([agent({ agentId: null })]).running[0]?.agentId).toBeNull();
  });

  it('прочие элементы ленты не дают строк', () => {
    expect(agentRows([{ id: 'p1', at: AT, kind: 'prompt', text: 'hi', images: 0 }])).toEqual({ running: [], finished: [] });
  });
});

function planning(id: string, name: string, input: Record<string, unknown>, result = '{}', over: Partial<FeedTool> = {}): FeedTool {
  return { ...child(id, name, input), response: { text: result, size: result.length, truncated: false }, ...over };
}

const subjects = (value: FeedAgent) => agentSteps(value)?.items.map((item) => [item.id, item.subject, item.status]);

describe('agentSteps', () => {
  it.each(['{"task":{"id":"1"}}', 'Task #1 created successfully: A'])('uses returned task IDs (%s)', (result) => {
    expect(subjects(agent({ children: [
      planning('a', 'TaskCreate', { subject: 'A' }, result),
      planning('b', 'TaskCreate', { subject: 'B' }, '{"task":{"id":2}}'),
      planning('c', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ] }))).toEqual([['1', 'A', 'completed'], ['2', 'B', 'pending']]);
  });

  it('does not renumber tasks when the first create is missing', () => {
    const value = agent({ toolCount: 3, children: [
      planning('b', 'TaskCreate', { subject: 'B' }, 'Task #2 created successfully: B'),
      planning('c', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ] });
    expect(subjects(value)).toEqual([['2', 'B', 'pending']]);
    expect(agentSteps(value)?.partial).toBe(true);
  });

  it('marks a lost prefix before completing a known task and creating the next', () => {
    const value = agent({ toolCount: 4, children: [
      planning('b', 'TaskCreate', { subject: 'B' }, '{"task":{"id":"2"}}'),
      planning('c', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      planning('d', 'TaskCreate', { subject: 'C' }, '{"task":{"id":"3"}}'),
    ] });
    expect(subjects(value)).toEqual([['2', 'B', 'completed'], ['3', 'C', 'pending']]);
    expect(agentSteps(value)?.partial).toBe(true);
  });

  it('never guesses an ID from create order', () => {
    expect(subjects(agent({ children: [
      planning('a', 'TaskCreate', { subject: 'A' }, 'Created'),
      planning('b', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ] }))).toEqual([[null, 'A', 'pending']]);
  });

  it.each(['failed', 'rejected', 'running'] as const)('ignores %s calls', (status) => {
    expect(subjects(agent({ children: [
      planning('a', 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }),
      planning('b', 'TodoWrite', { todos: [{ content: 'B', status: 'completed' }] }, '{}', { status }),
    ] }))).toEqual([[null, 'A', 'pending']]);
  });

  it('requires a result and folds successful replacement lists', () => {
    expect(agentSteps(agent({ children: [child('a', 'TodoWrite', { todos: [{ content: 'missing result' }] })] }))).toBeNull();
    expect(subjects(agent({ children: [
      planning('a', 'TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }),
      planning('b', 'update_plan', { plan: [{ step: 'new', status: 'in_progress' }] }),
    ] }))).toEqual([[null, 'new', 'in_progress']]);
  });

  it.each(['input', 'response'] as const)('marks truncated planning %s before later folds', (part) => {
    const first = planning('a', 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }] });
    if (part === 'input') first.truncated = true;
    else first.response!.truncated = true;
    const value = agent({ children: [first,
      planning('b', 'TaskCreate', { subject: 'B' }, '{"task":{"id":"2"}}'),
    ] });
    expect(subjects(value)).toEqual([[null, 'A', 'completed'], ['2', 'B', 'pending']]);
    expect(agentSteps(value)?.partial).toBe(true);
    expect(agentStepsPartial(value)).toBe(true);
  });

  it('keeps partial after a list replacement and ignores non-planning truncation', () => {
    const value = agent({ toolCount: 3, children: [planning('a', 'update_plan', { plan: [{ step: 'A' }] })] });
    expect(agentSteps(value)?.partial).toBe(true);
    expect(agentStepsPartial(agent({ children: [{ ...child('b', 'Read', {}), truncated: true }] }))).toBe(false);
  });

  it('caps only after folding all task updates', () => {
    const children = Array.from({ length: 51 }, (_, index) => planning(String(index), 'TaskCreate', { subject: `Task ${index}` }, JSON.stringify({ task: { id: String(index) } })));
    children.push(planning('update', 'TaskUpdate', { taskId: '50', status: 'in_progress' }));
    const plan = agentSteps(agent({ children }));
    expect(plan?.items).toHaveLength(50);
    expect(plan?.omitted).toBe(1);
    expect(plan?.items.some((item) => item.id === '50' && item.status === 'in_progress')).toBe(true);
  });
});

describe('findAgent', () => {
  it('по id карточки и по agentId; нет — null', () => {
    const items = [agent(), agent({ id: 'agent:t2', toolUseId: 't2', agentId: 'a2' })];
    expect(findAgent(items, { by: 'item', id: 'agent:t2' })?.agentId).toBe('a2');
    expect(findAgent(items, { by: 'agent', id: 'a1' })?.id).toBe('agent:t1');
    expect(findAgent(items, { by: 'agent', id: 'nope' })).toBeNull();
  });
});
