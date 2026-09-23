/**
 * Состояние ленты комнаты: прокрутка и кэш вида (дизайн комнаты 2026-09-23,
 * раздел 5.4; приёмка плана, кусок 3). По образцу `use-thread.test.tsx`, но
 * без дока: здесь нет ни `threadFits`, ни `PANEL_MIN`, ни ширины дока.
 *
 * Ink здесь нужен только затем, чтобы у хука был кадр: ни PTY, ни файловой
 * системы, ни настоящего `claude` в этом файле нет.
 */

import type { Message, MessageKind, WorkEntry, WorkSession } from '@harnas/core';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../test/glyphs-env.js';
import type { RoomView } from './room-view.js';
import { useRoom } from './use-room.js';

pinUnicodeGlyphs();

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const at = (time: string): string => `2026-09-08T${time}:00.000Z`;

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: at('12:30'),
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function letter(id: string, time: string, text: string, kind: MessageKind = 'note'): Message {
  return { id, from: 's-01', to: 's-02', at: at(time), text, kind, readAt: at('12:50') };
}

function work(workId: string, title: string, messages: Message[]): WorkEntry {
  return {
    projectPath: '/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: workId,
        title,
        goal: '',
        status: 'active',
        createdAt: at('09:00'),
        updatedAt: at('12:43'),
        deletedSessions: [],
      },
      sessions: [session('s-01', 'план'), session('s-02', 'бэкенд')],
      messages,
    },
  };
}

/** Каждый кадр кладёт сюда свой вид: по нему видно, пересчитались ли строки. */
let views: Array<RoomView | null> = [];

beforeEach(() => {
  views = [];
});

interface ProbeProps {
  /** `undefined` — работа не выбрана: показывать нечего. */
  entry: WorkEntry | undefined;
  width?: number;
  height?: number;
}

/** Модель никого не интересует в этих тестах — ссылка стабильна между кадрами. */
const noModel = (): null => null;

/** Клавиши: `u` — вверх по ленте, `f` — обратно к хвосту. */
function Probe({ entry, width = 30, height = 5 }: ProbeProps): ReactNode {
  const room = useRoom({ width, height, modelOf: noModel });
  useInput((input) => {
    if (input === 'u') room.scrollBy(-2);
    if (input === 'f') room.follow();
  });
  const view = room.viewOf(entry);
  views.push(view);
  return <Text>{`${view?.title ?? 'нет'}|${view?.below ?? 0}`}</Text>;
}

describe('useRoom: работа не выбрана', () => {
  it('вида нет: показывать нечего', async () => {
    const app = render(<Probe entry={undefined} />);
    await settle();
    expect(views.at(-1)).toBeNull();
    expect(app.lastFrame()).toBe('нет|0');
    app.unmount();
  });
});

describe('useRoom: строки и прокрутка (5.4)', () => {
  const chatter = Array.from({ length: 8 }, (_, index) =>
    letter(`m-${index}`, `12:${10 + index}`, `письмо ${index}`),
  );

  it('чужое событие карты с тем же объектом карты строки не пересчитывает', async () => {
    const entry = work('w-0001', 'Авторизация', chatter);
    const app = render(<Probe entry={entry} />);
    await settle();
    const before = views.at(-1);
    expect(before?.lines.length).toBeGreaterThan(0);

    // Watcher принёс новую запись работы, но карта в ней та же самая.
    app.rerender(<Probe entry={{ ...entry }} />);
    await settle();
    expect(views.at(-1)).toBe(before);

    // Новая карта — новые строки.
    const grown = work('w-0001', 'Авторизация', [...chatter, letter('m-9', '12:30', 'ещё')]);
    app.rerender(<Probe entry={grown} />);
    await settle();
    expect(views.at(-1)).not.toBe(before);
    app.unmount();
  });

  it('лента держится на хвосте, прокрутка уводит вверх, follow возвращает', async () => {
    const entry = work('w-0001', 'Авторизация', chatter);
    const app = render(<Probe entry={entry} />);
    await settle();
    expect(views.at(-1)?.below).toBe(0);

    app.stdin.write('u');
    await settle();
    expect(views.at(-1)?.below).toBeGreaterThan(0);

    app.stdin.write('f');
    await settle();
    expect(views.at(-1)?.below).toBe(0);
    app.unmount();
  });

  it('22: новое письмо вне хвоста позицию не сбивает, а `↓N` растёт', async () => {
    const entry = work('w-0001', 'Авторизация', chatter);
    const app = render(<Probe entry={entry} />);
    await settle();

    app.stdin.write('u');
    await settle();
    const before = views.at(-1);
    expect(before?.below).toBeGreaterThan(0);

    // Пришло письмо: лента выросла снизу, а окно стоит там, где его оставили.
    const grown = work('w-0001', 'Авторизация', [...chatter, letter('m-9', '12:30', 'ещё')]);
    app.rerender(<Probe entry={grown} />);
    await settle();
    expect(views.at(-1)?.lines.map((line) => line.text)).toEqual(
      before?.lines.map((line) => line.text),
    );
    // Новое письмо — это несколько строк (заголовок, тело, разделитель), а не
    // одна: важно, что окно не сдвинулось и что-то ниже него прибавилось.
    expect(views.at(-1)?.below).toBeGreaterThan(before?.below ?? 0);
    app.unmount();
  });

  it('смена работы возвращает ленту на хвост (граничные случаи)', async () => {
    // У «w-0002» своя лента: прокрутка «w-0001» ей не указ, и открывается она
    // с хвоста, а не с чужого смещения.
    const first = work('w-0001', 'Авторизация', chatter);
    const second = work(
      'w-0002',
      'Ревью',
      Array.from({ length: 8 }, (_, index) => letter(`r-${index}`, `13:${10 + index}`, `ревью ${index}`)),
    );
    const app = render(<Probe entry={first} />);
    await settle();

    app.stdin.write('u');
    await settle();
    expect(views.at(-1)?.below).toBeGreaterThan(0);

    app.rerender(<Probe entry={second} />);
    await settle();
    expect(views.at(-1)?.below).toBe(0);
    app.unmount();
  });
});
