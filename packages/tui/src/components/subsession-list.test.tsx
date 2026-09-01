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
