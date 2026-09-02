import type { SessionIndex } from '@harnas/core';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useProviderFilter } from './use-provider-filter.js';

function session(over: Partial<SessionIndex>): SessionIndex {
  return {
    id: 'x',
    project: '-proj',
    projectPath: null,
    cwd: null,
    gitBranch: null,
    version: null,
    file: `/root/${over.id ?? 'x'}.jsonl`,
    title: 'сессия',
    titleSource: 'custom',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    records: 1,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: null,
    subsessionCount: 0,
    provider: 'claude',
    ...over,
  };
}

const MIXED = [
  session({ id: 'a', provider: 'claude', title: 'клод-1' }),
  session({ id: 'b', provider: 'codex', title: 'кодекс-1' }),
  session({ id: 'c', provider: 'claude', title: 'клод-2' }),
];

function Probe({ sessions }: { sessions: SessionIndex[] }): ReactNode {
  const { filter, visible, present, cycle } = useProviderFilter(sessions);

  useInput((input) => {
    if (input === 'p') cycle();
  });

  return (
    <Text>{`${filter ?? 'все'}|${visible.map((s) => s.title).join(',')}|${present.join(',')}`}</Text>
  );
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('useProviderFilter', () => {
  it('по умолчанию показывает всех', async () => {
    const { lastFrame } = render(<Probe sessions={MIXED} />);
    await settle();
    expect(lastFrame()).toBe('все|клод-1,кодекс-1,клод-2|claude,codex');
  });

  it('переключение идёт по кругу: все → claude → codex → все', async () => {
    const { stdin, lastFrame } = render(<Probe sessions={MIXED} />);
    await settle();

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('claude|клод-1,клод-2|claude,codex');

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('codex|кодекс-1|claude,codex');

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('все|клод-1,кодекс-1,клод-2|claude,codex');
  });

  it('с одним провайдером фильтровать нечего', async () => {
    const { stdin, lastFrame } = render(<Probe sessions={[MIXED[0]!]} />);
    await settle();

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('все|клод-1|claude');
  });

  it('пустой список не ломает фильтр', async () => {
    const { stdin, lastFrame } = render(<Probe sessions={[]} />);
    await settle();
    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('все||');
  });
});
