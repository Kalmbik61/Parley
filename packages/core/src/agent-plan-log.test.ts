import { describe, expect, it } from 'vitest';
import { createClaudePlanCollector, createCodexPlanCollector } from './agent-plan-log.js';
const at = '2026-10-18T10:00:00Z';
const call = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  timestamp: at,
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: unknown = 'OK', extra = {}) => ({
  type: 'user',
  timestamp: at,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
});
const todo = (subject: string) => ({ todos: [{ content: subject, status: 'pending' }] });
describe('plan log collectors', () => {
  it('retains call order across late results and ignores duplicate calls/results', () => {
    const c = createClaudePlanCollector();
    const a = call('a', 'TaskCreate', { subject: 'A' });
    c.onRecord(a);
    c.onRecord(call('b', 'TaskUpdate', { taskId: '1', status: 'in_progress' }));
    c.onRecord(result('b'));
    expect(c.finish()).toBeNull();
    c.onRecord(result('a', [{ type: 'text', text: 'Task #1 created successfully: A' }]));
    expect(c.finish()?.items[0]).toMatchObject({ id: '1', status: 'in_progress' });
    c.onRecord(a);
    c.onRecord(result('a'));
    expect(c.finish()?.items).toHaveLength(1);
    expect(c.finish()?.items[0]?.status).toBe('in_progress');
  });
  it('replays old calls before snapshots and clones independently with repeatable finish', () => {
    const c = createClaudePlanCollector();
    c.onRecord(call('a', 'TaskCreate', { subject: 'A' }));
    c.onRecord(call('b', 'TodoWrite', todo('B')));
    c.onRecord(result('b'));
    const clone = c.clone();
    clone.onRecord(result('a', 'Task #1 created successfully: A'));
    expect(clone.finish()?.items.map((i) => i.subject)).toEqual(['B']);
    expect(c.finish()).toEqual(c.finish());
    c.onRecord(result('a', 'Task #2 created successfully: A'));
    expect(c.finish()?.items.map((i) => i.subject)).toEqual(['B']);
  });
  it('rejects failed, refused and sidechain calls; missing IDs remain partial', () => {
    for (const extra of [{ is_error: true }, {}]) {
      const c = createClaudePlanCollector();
      c.onRecord(call('a', 'TodoWrite', todo('A')));
      c.onRecord(result('a', extra.is_error ? 'error' : 'User rejected tool use', extra));
      expect(c.finish()).toBeNull();
    }
    const c = createClaudePlanCollector();
    c.onRecord({ ...call('s', 'TodoWrite', todo('side')), isSidechain: true });
    c.onRecord(result('s'));
    expect(c.finish()).toBeNull();
    c.onRecord(call('a', 'TaskCreate', { subject: 'A' }));
    c.onRecord(result('a'));
    expect(c.finish()).toMatchObject({ partial: true, items: [{ id: null }] });
    c.onRecord(call('b', 'TodoWrite', todo('B')));
    c.onRecord({ ...result('b'), toolUseResult: { success: false } });
    expect(c.finish()?.items[0]?.subject).toBe('A');
  });
  it('accepts native structured TodoWrite results and successful subjects containing refusal words', () => {
    const c = createClaudePlanCollector();
    c.onRecord(call('a', 'TodoWrite', todo('A')));
    c.onRecord({
      ...result('a', '', { is_error: false }),
      toolUseResult: { oldTodos: [], newTodos: todo('A').todos },
    });
    expect(c.finish()?.items[0]?.subject).toBe('A');
    c.onRecord(call('b', 'TaskCreate', { subject: 'Fix denied requests' }));
    c.onRecord(result('b', 'Task #1 created successfully: Fix denied requests'));
    expect(c.finish()?.items[1]?.id).toBe('1');
  });
  it('Codex requires supported success and parses arguments safely', () => {
    const c = createCodexPlanCollector();
    const cc = (id: string, subject: string) => ({
      type: 'response_item',
      timestamp: at,
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: id,
        arguments: JSON.stringify({ plan: [{ step: subject, status: 'in_progress' }] }),
      },
    });
    const cr = (id: string, output: unknown) => ({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: id, output },
    });
    c.onRecord(cc('a', 'A'));
    expect(c.finish()).toBeNull();
    const clone = c.clone();
    clone.onRecord(cr('a', 'Plan updated'));
    expect(c.finish()).toBeNull();
    expect(clone.finish()?.items[0]?.subject).toBe('A');
    c.onRecord(cr('a', 'Plan updated'));
    c.onRecord(cc('b', 'B'));
    c.onRecord(cr('b', '{"success":false}'));
    c.onRecord(cc('c', 'C'));
    c.onRecord(cr('c', { unexpected: true }));
    c.onRecord(cc('unknown', 'Unknown'));
    c.onRecord(cr('unknown', 'unrecognized response'));
    c.onRecord(cc('a', 'old'));
    c.onRecord(cr('a', 'error'));
    c.onRecord({
      ...cc('bad', 'bad'),
      payload: { type: 'function_call', name: 'update_plan', call_id: 'bad', arguments: '{' },
    });
    expect(c.finish()?.items[0]?.subject).toBe('A');
  });
});
