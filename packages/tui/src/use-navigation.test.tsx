import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useNavigation } from './use-navigation.js';

const ARROW_DOWN = '\u001B[B';
const ARROW_UP = '\u001B[A';
const TAB = '\t';

interface ProbeProps {
  sessionCount?: number;
  subsessionCount?: number;
  onRescan?: () => void;
}

function Probe({ sessionCount = 5, subsessionCount = 3, onRescan }: ProbeProps): ReactNode {
  const nav = useNavigation({
    sessionCount,
    getSubsessionCount: () => subsessionCount,
    ...(onRescan === undefined ? {} : { onRescan }),
  });
  return <Text>{`${nav.focus}|${nav.selectedSession}|${nav.selectedSubsession}`}</Text>;
}

/** Ink обрабатывает ввод асинхронно — даём кадру дорисоваться. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('useNavigation', () => {
  it('стрелки и j/k двигают список сессий', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();

    stdin.write(ARROW_DOWN);
    await settle();
    expect(lastFrame()).toBe('sessions|1|0');

    stdin.write('j');
    await settle();
    expect(lastFrame()).toBe('sessions|2|0');

    stdin.write('k');
    await settle();
    expect(lastFrame()).toBe('sessions|1|0');

    stdin.write(ARROW_UP);
    await settle();
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('выбор не уходит за границы списка', async () => {
    const { stdin, lastFrame } = render(<Probe sessionCount={2} />);
    await settle();

    stdin.write(ARROW_UP);
    await settle();
    expect(lastFrame()).toBe('sessions|0|0');

    for (let i = 0; i < 5; i++) {
      stdin.write(ARROW_DOWN);
      await settle();
    }
    expect(lastFrame()).toBe('sessions|1|0');
  });

  it('Tab ходит по кругу sessions → subsessions → terminal', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();

    stdin.write(TAB);
    await settle();
    expect(lastFrame()).toBe('subsessions|0|0');

    stdin.write(TAB);
    await settle();
    expect(lastFrame()).toBe('terminal|0|0');

    stdin.write(TAB);
    await settle();
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('на панели подсессий движется её собственный выбор', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();

    stdin.write(TAB);
    await settle();
    stdin.write(ARROW_DOWN);
    await settle();
    expect(lastFrame()).toBe('subsessions|0|1');
  });

  it('смена сессии сбрасывает выбор подсессии', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();

    stdin.write(TAB);
    await settle();
    stdin.write(ARROW_DOWN);
    await settle();
    expect(lastFrame()).toBe('subsessions|0|1');

    stdin.write(TAB);
    await settle();
    stdin.write(TAB);
    await settle();
    stdin.write(ARROW_DOWN);
    await settle();
    expect(lastFrame()).toBe('sessions|1|0');
  });

  it('r зовёт ре-скан, не трогая выбор', async () => {
    const onRescan = vi.fn();
    const { stdin, lastFrame } = render(<Probe onRescan={onRescan} />);
    await settle();

    stdin.write('r');
    await settle();
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('пустой список не даёт уехать в минус', async () => {
    const { stdin, lastFrame } = render(<Probe sessionCount={0} subsessionCount={0} />);
    await settle();

    stdin.write(ARROW_DOWN);
    await settle();
    expect(lastFrame()).toBe('sessions|0|0');
  });
});
