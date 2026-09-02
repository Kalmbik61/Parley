import type { Subsession } from '@harnas/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SubsessionList } from './subsession-list.js';

function subsession(over: Partial<Subsession> = {}): Subsession {
  return {
    agentId: 'a1',
    file: `/root/agent-${over.agentId ?? 'a1'}.jsonl`,
    workflowRunId: null,
    agentType: 'general-purpose',
    name: 'fix',
    task: 'Починить парсер',
    taskSource: 'meta',
    toolUseId: 'toolu_1',
    models: ['claude-opus-5'],
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:06:00.000Z',
    durationMs: 6 * 60_000,
    records: 12,
    ...over,
  };
}

describe('SubsessionList', () => {
  it('показывает задачу, длительность и бейдж', () => {
    const { lastFrame } = render(
      <SubsessionList subsessions={[subsession()]} selected={0} height={5} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Починить парсер');
    expect(frame).toContain('6м');
    expect(frame).toContain('Opus');
  });

  it('несколько моделей склеиваются в один бейдж без повторов', () => {
    const { lastFrame } = render(
      <SubsessionList
        subsessions={[
          subsession({ models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8'] }),
        ]}
        selected={0}
        height={5}
        width={60}
      />,
    );
    expect(lastFrame()).toContain('Opus/Sonnet');
  });

  it('без задачи показывается тип агента', () => {
    const { lastFrame } = render(
      <SubsessionList
        subsessions={[subsession({ task: null, agentType: 'workflow-subagent' })]}
        selected={0}
        height={5}
        width={60}
      />,
    );
    expect(lastFrame()).toContain('workflow-subagent');
  });

  it('пустой список и загрузка объясняют состояние', () => {
    expect(
      render(<SubsessionList subsessions={[]} selected={0} height={5} width={60} />).lastFrame(),
    ).toContain('Подсессий нет');
    expect(
      render(
        <SubsessionList subsessions={[]} selected={0} height={5} width={60} loading />,
      ).lastFrame(),
    ).toContain('читаю');
  });
});

describe('группировка по workflow', () => {
  const workflows = [
    { runId: 'wf_a', name: 'аудит-курса', status: 'completed', agentCount: 2, durationMs: 60_000 },
    { runId: 'wf_b', name: 'правки', status: 'failed', agentCount: 1, durationMs: 30_000 },
  ];
  const grouped = [
    subsession({ agentId: 'a1', workflowRunId: 'wf_a', task: 'урок 1' }),
    subsession({ agentId: 'a2', workflowRunId: 'wf_a', task: 'урок 2' }),
    subsession({ agentId: 'b1', workflowRunId: 'wf_b', task: 'правка' }),
  ];

  it('заголовок запуска показывает имя, статус и число агентов', () => {
    const { lastFrame } = render(
      <SubsessionList
        subsessions={grouped}
        workflows={workflows}
        selected={0}
        height={10}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('аудит-курса');
    expect(frame).toContain('completed');
    expect(frame).toContain('2 аг.');
    expect(frame).toContain('правки');
    expect(frame).toContain('failed');
  });

  it('заголовок рисуется один раз на группу, перед её первым агентом', () => {
    const { lastFrame } = render(
      <SubsessionList
        subsessions={grouped}
        workflows={workflows}
        selected={0}
        height={10}
        width={60}
      />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.filter((l) => l.includes('аудит-курса'))).toHaveLength(1);

    const header = lines.findIndex((l) => l.includes('аудит-курса'));
    const first = lines.findIndex((l) => l.includes('урок 1'));
    expect(header).toBeLessThan(first);
  });

  it('без дескрипторов список рисуется как раньше', () => {
    const { lastFrame } = render(
      <SubsessionList subsessions={grouped} selected={0} height={10} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('урок 1');
    expect(frame).not.toContain('▾');
  });

  it('агенты без workflow заголовка не получают', () => {
    const { lastFrame } = render(
      <SubsessionList
        subsessions={[subsession({ agentId: 'x', workflowRunId: null, task: 'одиночка' })]}
        workflows={workflows}
        selected={0}
        height={10}
        width={60}
      />,
    );
    expect(lastFrame()).not.toContain('▾');
  });
});
