/**
 * Состояние панели треда: правило дока, переключение, память вида и прокрутка
 * (спецификация 2026-09-08, 6.1–6.3; приёмка 8.19, 8.37, 8.39).
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
import type { ThreadView } from './thread-view.js';
import { useThread } from './use-thread.js';

pinUnicodeGlyphs();

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const at = (time: string): string => `2026-09-08T${time}:00.000Z`;

function session(id: string, label: string, parent: string | null): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent,
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

function letter(
  id: string,
  time: string,
  text: string,
  kind: MessageKind = 'note',
  from = 's-01',
  to = 's-02',
): Message {
  return { id, from, to, at: at(time), text, kind, readAt: at('12:50') };
}

/** Карта: два поддерева — «план» с «бэкендом» и «ревью» с «тестами» (3.4). */
function entryWith(messages: Message[]): WorkEntry {
  return {
    projectPath: '/dev/shop',
    map: {
      schemaVersion: 1,
      work: {
        id: 'w-0042',
        title: 'Авторизация',
        goal: '',
        status: 'active',
        createdAt: at('09:00'),
        updatedAt: at('12:43'),
        deletedSessions: [],
      },
      sessions: [
        session('s-01', 'план', null),
        session('s-02', 'бэкенд', 's-01'),
        session('s-03', 'ревью', null),
        session('s-04', 'тесты', 's-03'),
      ],
      messages,
    },
  };
}

/** Каждый кадр кладёт сюда свой вид: по нему видно, пересчитались ли строки. */
let views: Array<ThreadView | null> = [];

beforeEach(() => {
  views = [];
});

interface ProbeProps {
  /** `undefined` — работа не выбрана: показывать в доке нечего. */
  entry: WorkEntry | undefined;
  /** Колонки панели агента до дока: из них и считается правило (6.1). */
  panelCols: number;
  /** Выбранная сессия: её группа и решает, какой тред виден (6.2). */
  sessionId?: string;
  width?: number;
  height?: number;
}

/** Клавиши: `t` — открыть и закрыть, `u` — вверх по ленте, `f` — обратно к хвосту. */
function Probe({
  entry,
  panelCols,
  sessionId = 's-02',
  width = 30,
  height = 6,
}: ProbeProps): ReactNode {
  const thread = useThread({ panelCols, height, width });
  useInput((input) => {
    if (input === 't') thread.toggle();
    if (input === 'u') thread.scrollBy(-2);
    if (input === 'f') thread.follow();
  });
  const view = thread.viewOf(entry, sessionId);
  views.push(view);
  const where = thread.docked ? 'док' : thread.overlay ? 'оверлей' : '—';
  return <Text>{`${thread.open ? 'открыт' : 'закрыт'}|${where}|${view?.title ?? 'нет'}`}</Text>;
}

/** Панель 138 колонок без сайдбара: 111 из них — панели агента (макет 6.1). */
const WIDE = 111;
/** Тот же терминал в 120 колонок: панели остаётся 93, и док уже не влезает. */
const NARROW = 93;

describe('useThread: правило дока (6.1, приёмка 8.19)', () => {
  it('панели остаётся не меньше 80 колонок — тред докуется справа', async () => {
    const app = render(<Probe entry={entryWith([])} panelCols={WIDE} />);
    await settle();
    expect(app.lastFrame()).toBe('закрыт|—|тред · план');

    app.stdin.write('t');
    await settle();
    expect(app.lastFrame()).toBe('открыт|док|тред · план');

    // Повторное нажатие закрывает (6.1).
    app.stdin.write('t');
    await settle();
    expect(app.lastFrame()).toBe('закрыт|—|тред · план');
    app.unmount();
  });

  it('панель ушла бы ниже 80 колонок — тот же тред показывается оверлеем', async () => {
    const app = render(<Probe entry={entryWith([])} panelCols={NARROW} />);
    await settle();

    app.stdin.write('t');
    await settle();
    expect(app.lastFrame()).toBe('открыт|оверлей|тред · план');
    app.unmount();
  });

  it('ширина треда из настроек двигает порог: 24 колонки докуются там, где 30 — нет', async () => {
    const app = render(<Probe entry={entryWith([])} panelCols={105} width={24} />);
    await settle();

    app.stdin.write('t');
    await settle();
    expect(app.lastFrame()).toBe('открыт|док|тред · план');
    app.unmount();
  });

  it('37: терминал сузился при открытом доке — оверлей; расширился — снова док', async () => {
    const entry = entryWith([]);
    const app = render(<Probe entry={entry} panelCols={WIDE} />);
    await settle();
    app.stdin.write('t');
    await settle();
    expect(app.lastFrame()).toBe('открыт|док|тред · план');

    app.rerender(<Probe entry={entry} panelCols={NARROW} />);
    await settle();
    expect(app.lastFrame()).toBe('открыт|оверлей|тред · план');

    // Тред никуда не девался: широкий терминал возвращает его на место.
    app.rerender(<Probe entry={entry} panelCols={WIDE} />);
    await settle();
    expect(app.lastFrame()).toBe('открыт|док|тред · план');
    app.unmount();
  });
});

describe('useThread: строки и прокрутка (6.3, приёмка 8.39)', () => {
  const chatter = Array.from({ length: 8 }, (_, at) =>
    letter(`m-${at}`, `12:${10 + at}`, `письмо ${at}`),
  );

  it('39: чужое событие карты с тем же объектом карты строки не пересчитывает', async () => {
    const entry = entryWith(chatter);
    const app = render(<Probe entry={entry} panelCols={WIDE} />);
    await settle();
    const before = views.at(-1);
    expect(before?.lines.length).toBeGreaterThan(0);

    // Watcher принёс новую запись работы, но карта в ней та же самая.
    app.rerender(<Probe entry={{ ...entry }} panelCols={WIDE} />);
    await settle();
    expect(views.at(-1)).toBe(before);

    // Новая карта — новые строки.
    const grown = entryWith([...chatter, letter('m-9', '12:30', 'ещё')]);
    app.rerender(<Probe entry={grown} panelCols={WIDE} />);
    await settle();
    expect(views.at(-1)).not.toBe(before);
    app.unmount();
  });

  it('лента держится на хвосте, прокрутка уводит вверх, follow возвращает', async () => {
    const app = render(<Probe entry={entryWith(chatter)} panelCols={WIDE} height={5} />);
    await settle();
    expect(views.at(-1)?.below).toBe(0);

    app.stdin.write('u');
    await settle();
    expect(views.at(-1)?.below).toBe(2);

    app.stdin.write('f');
    await settle();
    expect(views.at(-1)?.below).toBe(0);
    app.unmount();
  });

  it('22: новое письмо вне хвоста позицию не сбивает, а `↓N` растёт', async () => {
    const entry = entryWith(chatter);
    const app = render(<Probe entry={entry} panelCols={WIDE} height={5} />);
    await settle();

    app.stdin.write('u');
    await settle();
    const before = views.at(-1);
    expect(before?.below).toBe(2);

    // Пришло письмо: лента выросла снизу, а окно стоит там, где его оставили.
    const grown = entryWith([...chatter, letter('m-9', '12:30', 'ещё')]);
    app.rerender(<Probe entry={grown} panelCols={WIDE} height={5} />);
    await settle();
    expect(views.at(-1)?.lines.map((line) => line.text)).toEqual(
      before?.lines.map((line) => line.text),
    );
    expect(views.at(-1)?.below).toBe(4);
    app.unmount();
  });

  it('смена группы треда возвращает ленту на хвост (6.2)', async () => {
    // У «тестов» своё поддерево и своя лента: прокрутка «плана» ей не указ.
    const entry = entryWith([
      ...chatter,
      ...Array.from({ length: 8 }, (_, at) =>
        letter(`r-${at}`, `13:${10 + at}`, `ревью ${at}`, 'note', 's-03', 's-04'),
      ),
    ]);
    const app = render(<Probe entry={entry} panelCols={WIDE} height={5} />);
    await settle();

    app.stdin.write('u');
    await settle();
    expect(views.at(-1)?.below).toBe(2);

    app.rerender(<Probe entry={entry} panelCols={WIDE} height={5} sessionId="s-04" />);
    await settle();
    expect(views.at(-1)?.title).toBe('тред · ревью');
    expect(views.at(-1)?.below).toBe(0);
    app.unmount();
  });

  it('работа не выбрана — вида нет: показывать в доке нечего', async () => {
    const app = render(<Probe entry={undefined} panelCols={WIDE} />);
    await settle();
    expect(views.at(-1)).toBeNull();
    expect(app.lastFrame()).toBe('закрыт|—|нет');
    app.unmount();
  });
});
