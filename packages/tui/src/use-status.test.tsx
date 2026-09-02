import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useStatus, type StatusSource } from './use-status.js';

const source: StatusSource = { projectPath: '/dev/shop', workId: 'w-0001', sessionId: 's-04' };
const other: StatusSource = { projectPath: '/dev/shop', workId: 'w-0001', sessionId: 's-02' };

/** Клавиши: p — событие со строкой-источником, l — без неё, s — фокус на источнике, k — любая клавиша. */
function Probe(): ReactNode {
  const status = useStatus();
  useInput((input) => {
    if (input === 'p') status.push([{ text: 'pending «тесты»', source }]);
    if (input === 'l') status.push([{ text: 'уже есть активная сессия' }]);
    if (input === 's') status.seen(source);
    if (input === 'o') status.seen(other);
    if (input === 'k') status.keyPressed();
  });
  return <Text>{`${status.count}|${status.last?.text ?? '—'}`}</Text>;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('useStatus', () => {
  it('копит события и показывает последнее', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();
    expect(lastFrame()).toBe('0|—');

    stdin.write('p');
    await settle();
    expect(lastFrame()).toBe('1|pending «тесты»');

    stdin.write('l');
    await settle();
    expect(lastFrame()).toBe('2|уже есть активная сессия');
  });

  it('событие гаснет, когда фокус побывал на его строке', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();

    stdin.write('p');
    await settle();
    stdin.write('o');
    await settle();
    expect(lastFrame()).toBe('1|pending «тесты»');

    stdin.write('s');
    await settle();
    expect(lastFrame()).toBe('0|—');
  });

  it('событие без источника гаснет по любой клавише, а с источником — нет', async () => {
    const { stdin, lastFrame } = render(<Probe />);
    await settle();

    stdin.write('p');
    await settle();
    stdin.write('l');
    await settle();
    expect(lastFrame()).toBe('2|уже есть активная сессия');

    stdin.write('k');
    await settle();
    expect(lastFrame()).toBe('1|pending «тесты»');
  });
});
