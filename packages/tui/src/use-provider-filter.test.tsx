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
    lastUserRecordAt: null,
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
    tokens: null,
    ...over,
  };
}

const MIXED = [
  session({ id: 'a', provider: 'claude', title: 'клод-1' }),
  session({ id: 'b', provider: 'codex', title: 'кодекс-1' }),
  session({ id: 'c', provider: 'claude', title: 'клод-2' }),
];

function Probe({
  sessions,
  extra = [],
}: {
  sessions: SessionIndex[];
  extra?: string[];
}): ReactNode {
  const { filter, visible, present, cycle } = useProviderFilter(sessions, extra);

  useInput((input) => {
    if (input === 'p') cycle();
  });

  return (
    <Text>{`${filter ?? 'все'}|${visible.map((s) => s.title).join(',')}|${present.join(',')}`}</Text>
  );
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('useProviderFilter', () => {
  // GLM всегда в списке выбора: истории у него нет, но запустить его надо уметь.
  it('по умолчанию показывает всех', async () => {
    const { lastFrame } = render(<Probe sessions={MIXED} />);
    await settle();
    expect(lastFrame()).toBe('все|клод-1,кодекс-1,клод-2|claude,codex,glm');
  });

  it('переключение идёт по кругу и доходит до раннера без истории', async () => {
    const { stdin, lastFrame } = render(<Probe sessions={MIXED} />);
    await settle();

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('claude|клод-1,клод-2|claude,codex,glm');

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('codex|кодекс-1|claude,codex,glm');

    // У GLM сессий нет и быть не может — список пуст, но выбрать его можно.
    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('glm||claude,codex,glm');

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('все|клод-1,кодекс-1,клод-2|claude,codex,glm');
  });

  it('единственный провайдер с историей всё равно переключается на GLM', async () => {
    const { stdin, lastFrame } = render(<Probe sessions={[MIXED[0]!]} />);
    await settle();

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('claude|клод-1|claude,glm');
  });

  it('провайдер сессий работ попадает в выбор без единого лога (дизайн 6.5)', async () => {
    // Карту работы создали через CLI или MCP: истории Codex ещё нет.
    const { stdin, lastFrame } = render(<Probe sessions={[MIXED[0]!]} extra={['codex']} />);
    await settle();
    expect(lastFrame()).toBe('все|клод-1|claude,codex,glm');

    stdin.write('p');
    await settle();
    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('codex||claude,codex,glm');
  });

  it('чужой провайдер из providers.json в фильтр не превращается', async () => {
    const { lastFrame } = render(<Probe sessions={[MIXED[0]!]} extra={['свой-cli']} />);
    await settle();
    expect(lastFrame()).toBe('все|клод-1|claude,glm');
  });

  it('пустой список не ломает фильтр', async () => {
    const { stdin, lastFrame } = render(<Probe sessions={[]} />);
    await settle();
    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('glm||glm');
  });
});
