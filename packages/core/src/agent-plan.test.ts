import { describe, expect, it } from 'vitest';
import {
  applyPlanCall,
  capPlan,
  planSummary,
  type AgentPlanState,
  type PlanCall,
} from './agent-plan.js';

const AT = '2026-10-18T10:00:00.000Z';
const call = (name: string, input: Record<string, unknown>, result: unknown = 'OK'): PlanCall => ({
  name,
  input,
  result,
  status: 'done',
  at: AT,
});
const create = (id: string, subject = id) => call('TaskCreate', { subject }, { task: { id } });
const state = (statuses: string[]): AgentPlanState => ({
  items: statuses.map((status, i) => ({
    id: String(i + 1),
    subject: String(i + 1),
    description: 'x'.repeat(5000),
    activeForm: null,
    status: status as 'pending',
  })),
  explanation: null,
  updatedAt: AT,
  partial: false,
});

describe('свёртка плана агента', () => {
  it('создаёт пункты с настоящими ID из объекта, JSON и текста', () => {
    let plan = applyPlanCall(null, create('1', 'A'));
    plan = applyPlanCall(
      plan,
      call('TaskCreate', { subject: 'B' }, JSON.stringify({ task: { id: '7' } })),
    );
    plan = applyPlanCall(
      plan,
      call('TaskCreate', { subject: 'C' }, 'Task #9 created successfully: C'),
    );
    expect(plan?.items.map((i) => [i.id, i.subject, i.status])).toEqual([
      ['1', 'A', 'pending'],
      ['7', 'B', 'pending'],
      ['9', 'C', 'pending'],
    ]);
  });
  it('не угадывает ID и не обновляет неизвестный пункт', () => {
    const plan = applyPlanCall(null, call('TaskCreate', { subject: 'A' }))!;
    expect(plan.items[0].id).toBeNull();
    expect(plan.partial).toBe(true);
    expect(
      applyPlanCall(plan, call('TaskUpdate', { taskId: '1', status: 'completed' }))?.items,
    ).toEqual(plan.items);
    expect(applyPlanCall(null, call('TaskUpdate', { taskId: '1' }))).toBeNull();
  });
  it('обновляет поля, удаляет пункт и помечает пропущенные данные', () => {
    const initial = applyPlanCall(null, create('2'))!;
    const updated = applyPlanCall(
      initial,
      call('TaskUpdate', {
        taskId: '2',
        status: 'in_progress',
        subject: 'B',
        description: 'D',
        activeForm: 'Doing',
      }),
    )!;
    expect(updated.items[0]).toEqual({
      id: '2',
      status: 'in_progress',
      subject: 'B',
      description: 'D',
      activeForm: 'Doing',
    });
    expect(initial.items[0].subject).toBe('2');
    expect(applyPlanCall(updated, call('TaskUpdate', { taskId: '9' }))?.partial).toBe(true);
    expect(
      applyPlanCall(updated, call('TaskUpdate', { taskId: '2', status: 'deleted' }))?.items,
    ).toEqual([]);
  });
  it('игнорирует неподтверждённые вызовы и ошибки', () => {
    const plan = state(['pending']);
    for (const operation of [
      create('2'),
      call('TaskUpdate', { taskId: '1', status: 'completed' }),
      call('TodoWrite', { todos: [] }),
      call('update_plan', { plan: [] }),
    ]) {
      for (const status of ['running', 'failed', 'rejected'] as const)
        expect(applyPlanCall(plan, { ...operation, status })).toBe(plan);
      for (const result of [undefined, { success: false }, { is_error: true }, '{"success":false}'])
        expect(applyPlanCall(plan, { ...operation, result })).toBe(plan);
    }
    expect(applyPlanCall(plan, call('Other', {}))).toBe(plan);
    expect(applyPlanCall(plan, create('2', '  '))).toBe(plan);
  });
  it('заменяет снимки, сбрасывает partial и сохраняет explanation', () => {
    const initial = { ...state(['pending']), partial: true };
    const todo = applyPlanCall(
      initial,
      call('TodoWrite', { todos: [{ content: 'A', status: 'unknown', activeForm: 'Doing A' }] }),
    )!;
    expect(todo.items[0]).toEqual({
      id: null,
      subject: 'A',
      status: 'pending',
      description: null,
      activeForm: 'Doing A',
    });
    expect(todo.partial).toBe(false);
    const plan = applyPlanCall(
      todo,
      call('update_plan', { plan: [{ step: 'B', status: 'completed' }], explanation: 'why' }),
    )!;
    expect(plan.explanation).toBe('why');
    expect(plan.items[0].id).toBeNull();
    expect(applyPlanCall(plan, call('TodoWrite', { todos: [] }))?.items).toEqual([]);
    expect(applyPlanCall(plan, call('TodoWrite', {}))).toBe(plan);
    expect(applyPlanCall(plan, call('TodoWrite', { todos: [{ content: 'A' }, {}] }))?.partial).toBe(
      true,
    );
  });
  it('начинает новый план после полного завершения или повторного ID', () => {
    expect(applyPlanCall(state(['completed', 'completed']), create('3'))?.items).toHaveLength(1);
    expect(
      applyPlanCall(state(['pending', 'pending', 'pending']), create('1'))?.items,
    ).toHaveLength(1);
    const plan = applyPlanCall(null, create('2'));
    expect(applyPlanCall(plan, create('1'))?.items).toHaveLength(2);
    expect(
      applyPlanCall({ ...state(['completed']), partial: true }, create('2'))?.items,
    ).toHaveLength(2);
  });
  it('считает сводку до ограничения списка и описаний', () => {
    const full = state(Array(60).fill('completed'));
    const bounded = capPlan(full);
    expect(bounded.items).toHaveLength(50);
    expect(bounded.omitted).toBe(10);
    expect(bounded.partial).toBe(false);
    expect(planSummary(bounded)).toMatchObject({ done: 60, total: 60, current: null, next: null });
    expect(bounded.items[0].description).toHaveLength(4096);
    expect(bounded.items[0].description?.endsWith('…')).toBe(true);
    expect(full.items[0].description).toHaveLength(5000);
  });
  it.each(['in_progress', 'pending'])(
    'сохраняет выбранный пункт за пределом списка: %s',
    (status) => {
      const full = state([...Array(50).fill('completed'), status, ...Array(9).fill('pending')]);
      const bounded = capPlan(full);
      expect(bounded.items.map((i) => i.id)).toEqual([
        ...Array.from({ length: 49 }, (_, i) => String(i + 1)),
        '51',
      ]);
      const selected = bounded.summary.current ?? bounded.summary.next;
      expect(selected?.id).toBe('51');
      expect(selected?.description).toHaveLength(4096);
      expect(bounded.omitted).toBe(10);
    },
  );
  it('выбирает текущий пункт, иначе первый следующий', () => {
    expect(planSummary(capPlan(state(['completed', 'in_progress', 'pending'])))).toMatchObject({
      current: { id: '2' },
      next: null,
      done: 1,
      total: 3,
    });
    expect(planSummary(capPlan(state(['completed', 'pending'])))).toMatchObject({
      current: null,
      next: { id: '2' },
    });
  });
});


import { latestAgentPlan, isPublishedAgentPlan } from './agent-plan.js';
it('uses the newest confirmed source and keeps explicit clearing', () => {
  const published = { items: [], explanation: null, partial: false, updatedAt: '2026-10-18T10:00:00Z' };
  const native = capPlan({ ...published, updatedAt: '2026-10-18T09:00:00Z' });
  expect(latestAgentPlan(published, native)?.updatedAt).toBe(published.updatedAt);
  const newer = { ...native, updatedAt: '2026-10-18T11:00:00Z' };
  expect(latestAgentPlan(published, newer)).toBe(newer);
  expect(latestAgentPlan(undefined, native)).toBe(native);
  expect(latestAgentPlan(undefined, null)).toBeNull();
  expect(isPublishedAgentPlan(published)).toBe(true);
  expect(isPublishedAgentPlan({ ...published, items: [{}] })).toBe(false);
  expect(isPublishedAgentPlan({ ...published, updatedAt: 'bad' })).toBe(false);
});
