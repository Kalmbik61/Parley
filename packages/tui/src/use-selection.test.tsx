import { addSession, type WorkEntry, type WorkMap } from '@harnas/core';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useAttachSession, useSelection, type SelectionWork } from './use-selection.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const attached: string[] = [];

/** Клавиши: 1/2 — выбрать работу, a — подключить вторую сессию первой работы. */
function Probe({ works }: { works: readonly SelectionWork[] }): ReactNode {
  const selection = useSelection({ works, onAttach: (id) => attached.push(id) });
  useInput((input) => {
    if (input === '1') selection.selectWork('w1');
    if (input === '2') selection.selectWork('w2');
    if (input === 'a') selection.attach('s-02');
  });
  return <Text>{`${selection.work ?? '—'}|${selection.session ?? '—'}`}</Text>;
}

const works: SelectionWork[] = [
  { key: 'w1', sessions: ['s-01', 's-02'] },
  { key: 'w2', sessions: ['s-03'] },
];

describe('useSelection', () => {
  it('по умолчанию выбраны первая работа и её первая сессия', async () => {
    const { lastFrame } = render(<Probe works={works} />);
    await settle();
    expect(lastFrame()).toBe('w1|s-01');
  });

  it('смена работы подключает панель к её самой свежей сессии', async () => {
    attached.length = 0;
    const { stdin, lastFrame } = render(<Probe works={works} />);
    await settle();

    stdin.write('2');
    await settle();
    expect(lastFrame()).toBe('w2|s-03');
    expect(attached).toEqual(['s-03']);
  });

  it('работа помнит последнюю подключённую сессию и возвращается к ней', async () => {
    attached.length = 0;
    const { stdin, lastFrame } = render(<Probe works={works} />);
    await settle();

    stdin.write('a');
    await settle();
    stdin.write('2');
    await settle();
    stdin.write('1');
    await settle();
    expect(lastFrame()).toBe('w1|s-02');
    expect(attached).toEqual(['s-02', 's-03', 's-02']);
  });

  it('подключение к сессии гасит unseen через onAttach', async () => {
    attached.length = 0;
    const { stdin, lastFrame } = render(<Probe works={works} />);
    await settle();

    stdin.write('a');
    await settle();
    expect(lastFrame()).toBe('w1|s-02');
    expect(attached).toEqual(['s-02']);
  });

  it('исчезнувшая работа или сессия чинит выбор сама', async () => {
    const { stdin, lastFrame, rerender } = render(<Probe works={works} />);
    await settle();
    stdin.write('2');
    await settle();
    expect(lastFrame()).toBe('w2|s-03');

    rerender(<Probe works={[{ key: 'w1', sessions: [] }]} />);
    await settle();
    expect(lastFrame()).toBe('w1|—');
  });

  it('работ нет — выбирать нечего', async () => {
    const { lastFrame } = render(<Probe works={[]} />);
    await settle();
    expect(lastFrame()).toBe('—|—');
  });
});

/** Работа с сессиями: id нумеруются внутри работы, поэтому у всех работ есть `s-01`. */
function entry(workId: string, labels: readonly string[] = ['план']): WorkEntry {
  const map: WorkMap = {
    schemaVersion: 1,
    work: {
      id: workId,
      title: workId,
      goal: '',
      status: 'active',
      createdAt: '2026-09-05T09:00:00.000Z',
      updatedAt: '2026-09-05T09:00:00.000Z',
    },
    sessions: [],
    messages: [],
  };
  for (const label of labels) addSession(map, { provider: 'claude', label, task: '' });
  return { projectPath: '/dev/shop', map };
}

describe('useAttachSession', () => {
  const works = [entry('w-0001'), entry('w-0002')];

  /** Подключение по клавише: цифра — номер работы, чью `s-01` подключаем. */
  function Attacher({ ids }: { ids: string[] }): ReactNode {
    const attach = useAttachSession({
      works,
      markSeen: () => undefined,
      seen: () => undefined,
      attach: (key) => ids.push(key),
    });
    useInput((input) => attach('s-01', `/dev/shop w-000${input}`));
    return <Text>—</Text>;
  }

  it('одинаковые id разных работ не путаются: панель едет к сессии своей работы', async () => {
    const ids: string[] = [];
    const { stdin } = render(<Attacher ids={ids} />);
    await settle();

    stdin.write('2');
    await settle();
    expect(ids).toEqual(['work:/dev/shop w-0002 s-01']);
  });

  it('сессии, которой в этой работе нет, панель не отдают', async () => {
    const ids: string[] = [];
    const { stdin } = render(<Attacher ids={ids} />);
    await settle();

    // Работы `w-0003` в списке нет: подключать нечего, панель остаётся на месте.
    stdin.write('3');
    await settle();
    expect(ids).toEqual([]);
  });
});
