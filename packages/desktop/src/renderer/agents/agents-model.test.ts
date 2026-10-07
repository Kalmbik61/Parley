// packages/desktop/src/renderer/agents/agents-model.test.ts
import { describe, expect, it } from 'vitest';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import { agentRows, agentSteps, findAgent } from './agents-model.js';

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

describe('agentSteps', () => {
  it('этапы Claude — вход последнего TodoWrite', () => {
    const steps = agentSteps(agent({ children: [
      child('c1', 'TodoWrite', { todos: [{ content: 'старое', status: 'pending' }] }),
      child('c2', 'Bash', { command: 'ls' }),
      child('c3', 'TodoWrite', { todos: [{ content: 'Найти вызовы', status: 'completed' }, { content: 'Проверить тесты', status: 'in_progress' }] }),
    ] }));
    expect(steps).toEqual([{ text: 'Найти вызовы', status: 'completed' }, { text: 'Проверить тесты', status: 'in_progress' }]);
  });

  it('этапы Codex — вход update_plan (plan[].step)', () => {
    const steps = agentSteps(agent({ children: [child('c1', 'update_plan', { plan: [{ step: 'Прочитать журнал', status: 'completed' }] })] }));
    expect(steps).toEqual([{ text: 'Прочитать журнал', status: 'completed' }]);
  });

  it('без TodoWrite и update_plan — null; незнакомый статус — pending; пустой текст пропускается', () => {
    expect(agentSteps(agent({ children: [child('c1', 'Bash', { command: 'ls' })] }))).toBeNull();
    expect(agentSteps(agent({ children: [child('c1', 'TodoWrite', { todos: [{ content: 'a', status: 'blocked' }, { content: '', status: 'pending' }] })] })))
      .toEqual([{ text: 'a', status: 'pending' }]);
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
