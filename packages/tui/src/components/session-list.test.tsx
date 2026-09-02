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
    tokens: { input: 1_200, output: 845, cacheRead: 500_000, cacheWrite: 3_000 },
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

  it('стрелки выбора больше нет — выбор показывается фоном (6.2)', () => {
    const { lastFrame } = render(
      <SessionList
        sessions={[session({ id: 'a', title: 'первая' }), session({ id: 'b', title: 'вторая' })]}
        selected={1}
        height={10}
        width={60}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('❯');
    // Освободившиеся две колонки достались заголовку: он начинается с края.
    expect(frame.split('\n')[0]?.startsWith('первая')).toBe(true);
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
    expect(lastFrame()).toContain('Сессий не найдено');
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

describe('токены в строке', () => {
  it('на широкой колонке видно вход/выход, кэш не выводится', () => {
    const { lastFrame } = render(
      <SessionList sessions={[session()]} selected={0} height={10} width={80} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.2к/845');
    expect(frame).not.toContain('500к');
  });

  it('в узкой колонке токены уходят первыми, а заголовок остаётся', () => {
    const { lastFrame } = render(
      <SessionList sessions={[session()]} selected={0} height={10} width={30} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('1.2к');
    expect(frame).toContain('заголовок');
  });

  it('токены появляются только там, где заголовку остаётся половина ширины (2.3, 6.4)', () => {
    for (const width of [36, 45, 55]) {
      const frame = render(
        <SessionList sessions={[session()]} selected={0} height={10} width={width} />,
      ).lastFrame();
      expect(frame, `ширина ${width}`).not.toContain('1.2к/845');
      expect(frame, `ширина ${width}`).toContain('заголовок');
    }
    for (const width of [64, 80, 100]) {
      const frame = render(
        <SessionList sessions={[session()]} selected={0} height={10} width={width} />,
      ).lastFrame();
      expect(frame, `ширина ${width}`).toContain('1.2к/845');
      expect(frame, `ширина ${width}`).toContain('заголовок');
    }
  });

  it('длинный заголовок получает не меньше половины ширины, хвост ужимается', () => {
    const title = 'очень длинный заголовок сессии для проверки бюджета';
    for (const width of [36, 40, 60]) {
      const frame = render(
        <SessionList sessions={[session({ title })]} selected={0} height={10} width={width} />,
      ).lastFrame();
      // Половина ширины минус знак усечения — столько символов заголовка видно точно.
      const guaranteed = title.slice(0, Math.ceil(width / 2) - 1);
      expect(frame, `ширина ${width}`).toContain(guaranteed);
    }
  });

  it('видимость токенов не зависит от возраста сессии', () => {
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    for (const endedAt of [ago(0), ago(60_000), ago(12 * 60_000), ago(3 * 24 * 60 * 60_000)]) {
      const { lastFrame } = render(
        <SessionList sessions={[session({ endedAt })]} selected={0} height={10} width={80} />,
      );
      expect(lastFrame() ?? '', endedAt).toContain('1.2к/845');
    }
  });

  it('сессия без токенов показывает прочерк на их месте', () => {
    const { lastFrame } = render(
      <SessionList sessions={[session({ tokens: null })]} selected={0} height={10} width={80} />,
    );
    // Прочерк именно в слоте токенов: длительность рядом своя, не прочерк.
    expect(lastFrame()).toContain('— · 12м');
  });
});

describe('маркер провайдера', () => {
  const mixed = [
    session({ id: 'a', title: 'клод', provider: 'claude', primaryModel: 'claude-opus-5' }),
    session({ id: 'b', title: 'кодекс', provider: 'codex', primaryModel: 'gpt-5.2-codex' }),
  ];

  it('в смешанном списке видно, чья сессия', () => {
    const { lastFrame } = render(
      <SessionList sessions={mixed} selected={0} height={10} width={70} showProvider />,
    );
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.find((l) => l.includes('клод'))).toContain('Cl');
    expect(lines.find((l) => l.includes('кодекс'))).toContain('Cx');
  });

  it('с одним провайдером маркер не занимает место', () => {
    const { lastFrame } = render(
      <SessionList sessions={[mixed[0]!]} selected={0} height={10} width={70} />,
    );
    expect(lastFrame()).not.toContain('Cl ');
  });

  it('бейдж модели единый для обоих провайдеров', () => {
    const { lastFrame } = render(
      <SessionList sessions={mixed} selected={0} height={10} width={70} showProvider />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Opus');
    expect(frame).toContain('Codex');
  });
});
