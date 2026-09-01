import type { SessionIndex } from '@harnas/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { SessionList } from './session-list.js';

function session(over: Partial<SessionIndex> = {}): SessionIndex {
  return {
    id: 's1',
    project: '-proj',
    projectPath: '/work',
    cwd: '/work',
    gitBranch: 'main',
    version: '2.1.247',
    file: `/root/${over.id ?? 's1'}.jsonl`,
    title: 'заголовок',
    titleSource: 'custom',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: new Date().toISOString(),
    durationMs: 12 * 60_000,
    records: 10,
    malformedLines: 0,
    models: {},
    tools: {},
    roles: {},
    recordTypes: {},
    primaryModel: 'claude-opus-5',
    subsessionCount: 0,
    provider: 'claude',
    ...over,
  };
}

describe('SessionList', () => {
  it('показывает заголовок, длительность и бейдж модели', () => {
    const { lastFrame } = render(
      <SessionList sessions={[session()]} selected={0} height={10} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('заголовок');
    expect(frame).toContain('12м');
    expect(frame).toContain('Opus');
  });

  it('маркер стоит у выбранной строки', () => {
    const { lastFrame } = render(
      <SessionList
        sessions={[session({ id: 'a', title: 'первая' }), session({ id: 'b', title: 'вторая' })]}
        selected={1}
        height={10}
        width={60}
      />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    expect(
      lines
        .find((l) => l.includes('первая'))
        ?.trimStart()
        .startsWith('❯'),
    ).toBe(false);
    expect(
      lines
        .find((l) => l.includes('вторая'))
        ?.trimStart()
        .startsWith('❯'),
    ).toBe(true);
  });

  it('рисует только окно видимых строк', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      session({ id: `s${i}`, title: `сессия ${i}` }),
    );
    const { lastFrame } = render(
      <SessionList sessions={many} selected={50} height={5} width={60} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('сессия 50');
    expect(frame).not.toContain('сессия 0');
    expect(frame).not.toContain('сессия 99');
    expect(frame.split('\n')).toHaveLength(5);
  });

  it('пустой список объясняет, что смотреть', () => {
    const { lastFrame } = render(<SessionList sessions={[]} selected={0} height={10} width={60} />);
    expect(lastFrame()).toContain('~/.claude/projects');
  });

  it('без заголовка показывается id', () => {
    const { lastFrame } = render(
      <SessionList
        sessions={[session({ title: null, id: 'без-имени' })]}
        selected={0}
        height={10}
        width={60}
      />,
    );
    expect(lastFrame()).toContain('без-имени');
  });
});
