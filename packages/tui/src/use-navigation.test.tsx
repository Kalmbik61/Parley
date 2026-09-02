import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useNavigation } from './use-navigation.js';

const ARROW_DOWN = '\u001B[B';
const ARROW_UP = '\u001B[A';
const ARROW_LEFT = '\u001B[D';
const ARROW_RIGHT = '\u001B[C';
const TAB = '\t';
const ENTER = '\r';

interface ProbeProps {
  sessionCount?: number;
  subsessionCount?: number;
  onRescan?: () => void;
  onToggleMode?: () => void;
  onCollapse?: () => void;
  onExpand?: () => void;
  onKey?: () => void;
  onOpen?: (index: number) => void;
  onNewSession?: () => void;
  onNewWork?: () => void;
  onSummary?: () => void;
  newSessionOpensTerminal?: boolean;
  suspended?: boolean;
  focusTerminalOnOpen?: boolean;
}

function Probe({
  sessionCount = 5,
  subsessionCount = 3,
  onRescan,
  onToggleMode,
  onCollapse,
  onExpand,
  onKey,
  onOpen,
  onNewSession,
  onNewWork,
  onSummary,
  newSessionOpensTerminal,
  suspended,
  focusTerminalOnOpen,
}: ProbeProps): ReactNode {
  const nav = useNavigation({
    sessionCount,
    getSubsessionCount: () => subsessionCount,
    ...(onRescan === undefined ? {} : { onRescan }),
    ...(onToggleMode === undefined ? {} : { onToggleMode }),
    ...(onCollapse === undefined ? {} : { onCollapse }),
    ...(onExpand === undefined ? {} : { onExpand }),
    ...(onKey === undefined ? {} : { onKey }),
    ...(onOpen === undefined ? {} : { onOpen }),
    ...(onNewSession === undefined ? {} : { onNewSession }),
    ...(onNewWork === undefined ? {} : { onNewWork }),
    ...(onSummary === undefined ? {} : { onSummary }),
    ...(newSessionOpensTerminal === undefined ? {} : { newSessionOpensTerminal }),
    ...(suspended === undefined ? {} : { suspended }),
    ...(focusTerminalOnOpen === undefined ? {} : { focusTerminalOnOpen }),
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

  it('w переключает режим левой колонки', async () => {
    const onToggleMode = vi.fn();
    const { stdin, lastFrame } = render(<Probe onToggleMode={onToggleMode} />);
    await settle();

    stdin.write('w');
    await settle();
    expect(onToggleMode).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('n запускает новую сессию и уводит фокус в терминал', async () => {
    const onNewSession = vi.fn();
    const { stdin, lastFrame } = render(<Probe onNewSession={onNewSession} />);
    await settle();

    stdin.write('n');
    await settle();
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBe('terminal|0|0');
  });

  it('в режиме работ n открывает диалог и не уводит фокус (дизайн 4.2)', async () => {
    const onNewSession = vi.fn();
    const { stdin, lastFrame } = render(
      <Probe onNewSession={onNewSession} newSessionOpensTerminal={false} />,
    );
    await settle();

    stdin.write('n');
    await settle();
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('из терминала диалоги не открываются: n и N молчат (дизайн 4)', async () => {
    const onNewSession = vi.fn();
    const onNewWork = vi.fn();
    const { stdin, lastFrame } = render(
      <Probe onNewSession={onNewSession} onNewWork={onNewWork} newSessionOpensTerminal={false} />,
    );
    await settle();

    stdin.write(TAB);
    stdin.write(TAB);
    await settle();
    expect(lastFrame()).toBe('terminal|0|0');

    stdin.write('n');
    await settle();
    stdin.write('N');
    await settle();
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onNewWork).not.toHaveBeenCalled();
  });

  it('N открывает диалог новой работы из фокуса списков (дизайн 4.1)', async () => {
    const onNewWork = vi.fn();
    const { stdin, lastFrame } = render(<Probe onNewWork={onNewWork} />);
    await settle();

    stdin.write('N');
    await settle();
    expect(onNewWork).toHaveBeenCalledTimes(1);
    // Диалог живёт в левой колонке: фокус остаётся на списках.
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('s открывает диалог дозаказа резюме и не уводит фокус (дизайн 4.5)', async () => {
    const onSummary = vi.fn();
    const { stdin, lastFrame } = render(<Probe onSummary={onSummary} />);
    await settle();

    stdin.write('s');
    await settle();
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toBe('sessions|0|0');

    // Из терминала диалог не выпрыгивает: там ввод принадлежит агенту.
    stdin.write(TAB);
    stdin.write(TAB);
    await settle();
    stdin.write('s');
    await settle();
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it('открытый диалог модален: клавиши списков молчат (дизайн 4)', async () => {
    const onRescan = vi.fn();
    const onToggleMode = vi.fn();
    const onNewWork = vi.fn();
    const { stdin, lastFrame } = render(
      <Probe onRescan={onRescan} onToggleMode={onToggleMode} onNewWork={onNewWork} suspended />,
    );
    await settle();

    stdin.write('r');
    stdin.write('w');
    stdin.write('N');
    stdin.write(ARROW_DOWN);
    stdin.write(TAB);
    await settle();

    expect(onRescan).not.toHaveBeenCalled();
    expect(onToggleMode).not.toHaveBeenCalled();
    expect(onNewWork).not.toHaveBeenCalled();
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('←→ и h l сворачивают и разворачивают работу', async () => {
    const onCollapse = vi.fn();
    const onExpand = vi.fn();
    const { stdin } = render(<Probe onCollapse={onCollapse} onExpand={onExpand} />);
    await settle();

    stdin.write(ARROW_LEFT);
    await settle();
    stdin.write('h');
    await settle();
    stdin.write(ARROW_RIGHT);
    await settle();
    stdin.write('l');
    await settle();

    expect(onCollapse).toHaveBeenCalledTimes(2);
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  it('вне списка РАБОТЫ ←→ и h l не трогают дерево (дизайн 8)', async () => {
    const onCollapse = vi.fn();
    const onExpand = vi.fn();
    const { stdin, lastFrame } = render(<Probe onCollapse={onCollapse} onExpand={onExpand} />);
    await settle();

    // Фокус на панели ДЕТАЛИ: свернулась бы работа, на которую не смотрят.
    stdin.write(TAB);
    await settle();
    expect(lastFrame()).toBe('subsessions|0|0');

    stdin.write(ARROW_LEFT);
    await settle();
    stdin.write('l');
    await settle();

    expect(onCollapse).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('Enter в режиме работ не уводит фокус в терминал', async () => {
    const onOpen = vi.fn();
    const { stdin, lastFrame } = render(<Probe onOpen={onOpen} focusTerminalOnOpen={false} />);
    await settle();

    stdin.write(ENTER);
    await settle();
    expect(onOpen).toHaveBeenCalledWith(0);
    expect(lastFrame()).toBe('sessions|0|0');
  });

  it('любая клавиша в списках отмечается — ею гаснут уведомления', async () => {
    const onKey = vi.fn();
    const { stdin } = render(<Probe onKey={onKey} />);
    await settle();

    stdin.write(ARROW_DOWN);
    await settle();
    stdin.write('p');
    await settle();
    expect(onKey).toHaveBeenCalledTimes(2);
  });

  it('пустой список не даёт уехать в минус', async () => {
    const { stdin, lastFrame } = render(<Probe sessionCount={0} subsessionCount={0} />);
    await settle();

    stdin.write(ARROW_DOWN);
    await settle();
    expect(lastFrame()).toBe('sessions|0|0');
  });
});
