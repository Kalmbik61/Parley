/**
 * Вкладка комнаты (спека окна 2026-09-29, 1.3, 2.2–2.4; кусок 6 плана): шапка и лента участников, лента
 * сообщений (текст — Markdown, подробно в `RoomMarkdown.test.tsx`) с чипами, тегами видов и строкой
 * ожидания по `readBy`, блок `Decisions`, пустая комната,
 * отправка из поля ввода, карточка решения и ответ на неё (`rooms.resolveProposal` с `proposalId`, `rev`,
 * `action`, `note`; `conflict` — тост; двойное нажатие — один вызов), прочтение и прокрутка.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { Message, Room, WorkEntry, WorkSession } from '@parley/core';
import type { LiveMetrics, LiveTask } from '@parley/protocol';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { activityMap, makeActivity, makeLetter, makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { RoomPanel, type RoomPanelProps } from './RoomPanel.js';

vi.mock('sonner', async (importOriginal) => ({ ...(await importOriginal<typeof import('sonner')>()), toast: vi.fn() }));

const PROJECT = '/tmp/proj';
const WORK_ID = 'w-01';
const PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

function sessions(): WorkSession[] {
  return [
    makeSession('s-01', 'архитектор', { task: 'Спроектировать возвраты' }),
    makeSession('s-02', 'бэкенд', { task: 'Частичный возврат' }),
    makeSession('s-03', 'ревью', { provider: 'codex', task: 'Ревью диффа' }),
  ];
}

function room(patch: Partial<Room> = {}): Room {
  return { ...makeRoom('r-01', 'Возвраты'), members: ['s-01', 's-02', 's-03'], lead: 's-01', ...patch };
}

function message(id: string, patch: Partial<Message> = {}): Message {
  return makeLetter(id, { roomId: 'r-01', to: [], from: 'human', readBy: { human: 'x' }, ...patch });
}

function entryOf(patch: { room?: Room; sessions?: WorkSession[]; messages?: Message[] } = {}): WorkEntry {
  return makeWork(WORK_ID, {
    projectPath: PROJECT,
    title: 'Платежи',
    sessions: patch.sessions ?? sessions(),
    rooms: [patch.room ?? room()],
    messages: patch.messages ?? [],
  });
}

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('rooms.send', () => ({ messageId: 'm-new' }));
  useUiStore.setState({ composerDrafts: {}, windowFocused: true, documentVisible: true });
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS] } });
  vi.mocked(toast).mockClear();
  // Меню упоминаний прокручивает выбранный пункт в видимую область; в jsdom `scrollIntoView` нет.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

function props(entry: WorkEntry, patch: Partial<RoomPanelProps> = {}): RoomPanelProps {
  return {
    entry,
    roomId: 'r-01',
    providers: PROVIDERS,
    activity: {},
    bridge,
    active: true,
    onOpenExternal: vi.fn(),
    onOpenSession: vi.fn(),
    ...patch,
  };
}

function renderPanel(entry: WorkEntry, patch: Partial<RoomPanelProps> = {}) {
  const initial = props(entry, patch);
  const view = render(<RoomPanel {...initial} />);
  return { ...view, initial, update: (next: WorkEntry) => view.rerender(<RoomPanel {...initial} entry={next} />) };
}

/** Живая активность с моделью сессии: `metrics.model` — то, что раньше `RoomBody` собирал в `models`. */
const withModels = (models: Record<string, string | null>, activity: Parameters<typeof makeActivity>[1] = 'idle') =>
  activityMap(
    Object.entries(models).map(([sessionId, model]) =>
      makeActivity({ projectPath: PROJECT, workId: WORK_ID, sessionId }, activity, {
        metrics: { tokensIn: null, tokensOut: null, durationMs: null, unread: 0, subagents: 0, model },
      }),
    ),
  );

/** Живая активность с данными хоста о задачах и ожидании (`metrics.tasks`, `metrics.waitingFor`). */
const withDoing = (
  doing: Record<string, Partial<LiveMetrics>>,
  activity: Parameters<typeof makeActivity>[1] = 'working',
) =>
  activityMap(
    Object.entries(doing).map(([sessionId, extra]) =>
      makeActivity({ projectPath: PROJECT, workId: WORK_ID, sessionId }, activity, {
        metrics: {
          tokensIn: null,
          tokensOut: null,
          durationMs: null,
          unread: 0,
          subagents: 0,
          model: null,
          ...extra,
        },
      }),
    ),
  );
const liveTask = (
  id: string,
  description: string | null,
  extra: Partial<LiveTask> = {},
): LiveTask => ({
  id,
  agentType: 'general-purpose',
  description,
  background: true,
  ...extra,
});

const feed = (): HTMLElement => document.querySelector('[data-room-feed]') as HTMLElement;
const liveLine = (): HTMLElement | null => document.querySelector('[data-room-live]');
const messageRow = (id: string): HTMLElement => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
const REF = (sessionId: string) => ({ projectPath: PROJECT, workId: WORK_ID, sessionId });

describe('RoomPanel — шапка (1.3)', () => {
  it('название и подзаголовок: кто создал, сколько агентов, ведущий, работа', () => {
    renderPanel(entryOf());
    expect(screen.getByRole('heading', { name: 'Возвраты' })).toBeTruthy();
    expect(screen.getByText('Created by you · 3 agents · lead S01 · Платежи')).toBeTruthy();
  });

  it('комнаты нет в карте — «Room not found»', () => {
    renderPanel(entryOf(), { roomId: 'r-99' });
    expect(screen.getByText('Room not found')).toBeTruthy();
  });

  it('длинное название и подзаголовок — в одну строку с полным текстом в тултипе, а не вытолкнутые за край', () => {
    const long = 'В'.repeat(120);
    renderPanel(entryOf({ room: room({ title: long }) }));
    const heading = screen.getByRole('heading');
    expect(heading.textContent).toBe(long);
    expect(heading.getAttribute('title')).toBe(long);
    expect(heading.className).toContain('truncate');
  });
});

describe('RoomPanel — лента участников (1.3)', () => {
  it('карточка на участника: ярлык, слово состояния, задача', () => {
    const activity = activityMap([makeActivity(REF('s-02'), 'blocked'), makeActivity(REF('s-01'), 'working')]);
    renderPanel(entryOf(), { activity });
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-participant]'));
    expect(cards.map((card) => card.getAttribute('data-participant'))).toEqual(['s-01', 's-02', 's-03']);
    const second = cards[1] as HTMLElement;
    expect(within(second).getByText('S02 бэкенд')).toBeTruthy();
    expect(within(second).getByText('needs you')).toBeTruthy();
    expect(within(second).getByText('Частичный возврат')).toBeTruthy();
  });

  it('тултип — «провайдер · модель» из живых метрик; модель неизвестна — только провайдер', () => {
    const activity = withModels({ 's-01': 'claude-opus-5-5', 's-03': 'gpt-5.5' });
    renderPanel(entryOf(), { activity });
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-participant]'));
    expect(cards.map((card) => card.getAttribute('title'))).toEqual(['Claude Code · Opus 5.5', 'Claude Code', 'Codex · GPT-5.5']);
  });

  it('пришла модель — тултип обновился; нет метрик вовсе — только провайдер, без «null» и без слова состояния', () => {
    const { rerender, initial } = renderPanel(entryOf());
    expect(document.querySelector('[data-participant="s-01"]')?.getAttribute('title')).toBe('Claude Code');
    rerender(<RoomPanel {...initial} activity={withModels({ 's-01': 'claude-sonnet-5' }, 'working')} />);
    expect(document.querySelector('[data-participant="s-01"]')?.getAttribute('title')).toBe('Claude Code · Sonnet 5');
  });

  it('карточка 230px; подкраска: ждёт человека — accent-200, прочитайте — accent-2-200, иначе нейтральный фон', () => {
    const activity = activityMap([makeActivity(REF('s-02'), 'blocked'), makeActivity(REF('s-03'), 'unseen')]);
    renderPanel(entryOf(), { activity });
    const [first, second, third] = Array.from(document.querySelectorAll<HTMLElement>('[data-participant]'));
    expect(first?.className).toContain('w-[230px]');
    expect(first?.className).toContain('bg-[color-mix(in_srgb,currentColor_6%,transparent)]');
    expect(second?.className).toContain('bg-accent-200');
    expect(third?.className).toContain('bg-accent-2-200');
  });

  it('★ — только у ведущего, с подписью Lead', () => {
    renderPanel(entryOf());
    const stars = Array.from(document.querySelectorAll('[data-participant] [title="Lead"]'));
    expect(stars).toHaveLength(1);
    expect(stars[0]?.closest('[data-participant]')?.getAttribute('data-participant')).toBe('s-01');
  });

  it('клик по карточке открывает терминал участника', () => {
    const { initial } = renderPanel(entryOf());
    fireEvent.click(within(document.querySelector('[data-participant="s-03"]') as HTMLElement).getByRole('button'));
    expect(initial.onOpenSession).toHaveBeenCalledWith('s-03');
  });

  it('длинный ярлык и задача не выталкивают карточку: обрезка с многоточием', () => {
    const custom = sessions();
    custom[1] = makeSession('s-02', 'Я'.repeat(40), { task: 'З'.repeat(300) });
    renderPanel(entryOf({ sessions: custom }));
    const card = document.querySelector('[data-participant="s-02"]') as HTMLElement;
    expect(card.className).toContain('w-[230px]');
    expect(within(card).getByText(`S02 ${'Я'.repeat(40)}`).className).toContain('truncate');
    expect(within(card).getByText('З'.repeat(300)).className).toContain('truncate');
  });
});

describe('RoomPanel — чем заняты участники (Parley 0.2.0)', () => {
  const card = (id: string): HTMLElement =>
    document.querySelector(`[data-participant="${id}"]`) as HTMLElement;

  it('вторая строка карточки — чем занят участник, а не задача; подсказка — полный список', () => {
    const activity = withDoing({
      's-01': { tasks: [liveTask('a', 'Orca mobile app research'), liveTask('b', 'Docs lookup')] },
      's-02': { waitingFor: 's-03' },
    });
    renderPanel(entryOf(), { activity });

    const first = within(card('s-01')).getByText('2 subagents: Orca mobile app research');
    expect(first.getAttribute('title')).toBe(
      '2 subagents\n• Orca mobile app research\n• Docs lookup',
    );
    expect(first.className).toContain('truncate');
    expect(within(card('s-01')).queryByText('Спроектировать возвраты')).toBeNull();
    expect(within(card('s-02')).getByText('Waiting for S03')).toBeTruthy();
    expect(within(card('s-02')).queryByText('Частичный возврат')).toBeNull();
  });

  it('никто ничем не занят — в карточке задача, как раньше, и подсказки у неё нет', () => {
    renderPanel(entryOf(), { activity: withDoing({ 's-01': { tasks: [], waitingFor: null } }) });

    const task = within(card('s-01')).getByText('Спроектировать возвраты');
    expect(task.getAttribute('title')).toBeNull();
    expect(liveLine()).toBeNull();
  });

  it('живая строка над полем ввода: по строке на занятого участника, «S02 · Subagent: …»', () => {
    const activity = withDoing({
      's-02': { tasks: [liveTask('a', 'Orca mobile app research')] },
      's-03': { waitingFor: 'inbox' },
    });
    renderPanel(entryOf(), { activity });

    const line = liveLine() as HTMLElement;
    expect(Array.from(line.children).map((row) => row.textContent)).toEqual([
      'S02 · Subagent: Orca mobile app research',
      'S03 · Waiting for messages',
    ]);
    // Над полем ввода: после ленты, перед Composer.
    expect(feed().compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      line.compareDocumentPosition(document.querySelector('[contenteditable]') as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Приглушённая и компактная: ничего не выталкивает, длинное обрезается.
    expect(line.className).toContain('text-muted-foreground');
    expect((line.children[0] as HTMLElement).className).toContain('truncate');
    // Много занятых участников ленту не выдавливают: блок выше 96px прокручивается.
    expect(line.className).toContain('max-h-24');
    expect(line.className).toContain('overflow-y-auto');
  });

  it('в ленту она не пишется: сообщений не прибавляется, текста в ленте нет', () => {
    const entry = entryOf({ messages: [message('m-1', { text: 'Задача' })] });
    renderPanel(entry, {
      activity: withDoing({ 's-02': { tasks: [liveTask('a', 'Orca mobile app research')] } }),
    });

    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(1);
    expect(feed().textContent).not.toContain('Orca mobile app research');
    expect(liveLine()?.textContent).toContain('Orca mobile app research');
  });

  it('появляется и исчезает вместе с данными хоста', () => {
    const { rerender, initial } = renderPanel(entryOf());
    expect(liveLine()).toBeNull();

    rerender(<RoomPanel {...initial} activity={withDoing({ 's-02': { waitingFor: 's-01' } })} />);
    expect(liveLine()?.textContent).toBe('S02 · Waiting for S01');

    // Ожидание кончилось — строки нет, в карточке снова задача.
    rerender(
      <RoomPanel {...initial} activity={withDoing({ 's-02': { waitingFor: null, tasks: [] } })} />,
    );
    expect(liveLine()).toBeNull();
    expect(within(card('s-02')).getByText('Частичный возврат')).toBeTruthy();
  });

  it('закрытый участник живой строки не даёт, даже если метрики ещё несут задачи', () => {
    const custom = sessions();
    custom[1] = makeSession('s-02', 'бэкенд', { lifecycle: 'closed' });
    renderPanel(entryOf({ sessions: custom }), {
      activity: withDoing({ 's-02': { tasks: [liveTask('a', 'Orca mobile app research')] } }),
    });

    expect(liveLine()).toBeNull();
  });

  // Кусок 4b плана 2026-10-01: строка субагентов карточки — бейдж с поповером; клик по агенту ведёт на его карточку в ленте.
  it('поповер агентов у участника из metrics.tasks: строки по агентам; клик по строке — onOpenSession(сессия, агент)', () => {
    const activity = withDoing({
      's-01': { subagents: 2, tasks: [liveTask('agent-1', 'Orca mobile app research'), liveTask('agent-2', 'Docs lookup', { agentType: 'Plan', background: false })] },
    });
    const { initial } = renderPanel(entryOf(), { activity });

    const trigger = within(card('s-01')).getByTestId('agents-badge');
    expect(trigger.textContent).toBe('2 subagents: Orca mobile app research');
    fireEvent.click(trigger);
    expect(initial.onOpenSession).not.toHaveBeenCalled();
    const rows = screen.getAllByTestId('agents-popover-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'general-purposebackgroundOrca mobile app research',
      'PlanDocs lookup',
    ]);
    fireEvent.click(rows[1]!);
    expect(initial.onOpenSession).toHaveBeenCalledWith('s-01', 'agent-2');
    // Карточка без субагентов — без бейджа.
    expect(within(card('s-02')).queryByTestId('agents-badge')).toBeNull();
  });

  it('участник ждёт — строка «Waiting…» без поповера, хотя субагенты есть: они в подсказке', () => {
    const activity = withDoing({ 's-01': { waitingFor: 's-03', subagents: 1, tasks: [liveTask('agent-1', 'Docs lookup')] } });
    renderPanel(entryOf(), { activity });
    expect(within(card('s-01')).queryByTestId('agents-badge')).toBeNull();
    expect(within(card('s-01')).getByText('Waiting for S03').getAttribute('title')).toBe('Waiting for S03\nSubagent: Docs lookup');
  });

  it('сессия с фоновыми субагентами — working и в карточке участника', () => {
    const activity = withDoing({
      's-01': { subagents: 3, tasks: [liveTask('a', 'A'), liveTask('b', 'B'), liveTask('c', 'C')] },
    });
    renderPanel(entryOf(), { activity });

    expect(within(card('s-01')).getByText('working')).toBeTruthy();
  });
});

describe('RoomPanel — лента при смене живой строки (Parley 0.2.0)', () => {
  /**
   * jsdom не считает раскладку: высоту содержимого (`scrollHeight` 1000) и окна ленты (`clientHeight` 400)
   * задаёт тест, дно ленты — `scrollTop` 600. Присвоение `scrollTop` jsdom не ограничивает дном, как браузер,
   * поэтому прижатая лента — это `scrollTop === scrollHeight`.
   */
  function withLayout(body: () => void): void {
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400),
    ];
    try {
      body();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }
  const waiting = (target: string) => withDoing({ 's-02': { waitingFor: target } });

  /** Лента прокручена до `scrollTop`, затем строка меняется; результат — позиция ленты после перерисовки. */
  function scrollAfter(
    scrollTop: number,
    before: ReturnType<typeof withDoing> | undefined,
    after: ReturnType<typeof withDoing>,
  ): number {
    let result = -1;
    withLayout(() => {
      const { rerender, initial } = renderPanel(
        entryOf({ messages: [message('m-1')] }),
        before === undefined ? {} : { activity: before },
      );
      // Человек прокрутил ленту: браузер присылает scroll, и положение запоминается.
      feed().scrollTop = scrollTop;
      fireEvent.scroll(feed());
      rerender(<RoomPanel {...initial} activity={after} />);
      result = feed().scrollTop;
    });
    return result;
  }

  it('лента у низа, строка появилась — остаётся у низа: сжатая лента прижимается заново', () => {
    expect(scrollAfter(600, undefined, waiting('s-01'))).toBe(1000);
    expect(liveLine()).not.toBeNull();
  });

  it('прокручена вверх (человек читает историю) — позиция не меняется', () => {
    expect(scrollAfter(100, undefined, waiting('s-01'))).toBe(100);
    expect(liveLine()).not.toBeNull();
  });

  it('«у низа» — не дальше 48px от дна: на границе прижимается, на пиксель дальше — нет', () => {
    expect(scrollAfter(552, undefined, waiting('s-01'))).toBe(1000);
    cleanup();
    expect(scrollAfter(551, undefined, waiting('s-01'))).toBe(551);
  });

  it('строка исчезла: у низа — прижата, прокручена вверх — не тронута', () => {
    expect(scrollAfter(600, waiting('s-01'), withDoing({}))).toBe(1000);
    cleanup();
    expect(scrollAfter(100, waiting('s-01'), withDoing({}))).toBe(100);
  });

  it('строка сменилась (другой текст или другой участник): у низа — прижата, вверх — не тронута', () => {
    expect(scrollAfter(600, waiting('s-01'), waiting('s-03'))).toBe(1000);
    cleanup();
    expect(scrollAfter(100, waiting('s-01'), waiting('s-03'))).toBe(100);
    cleanup();
    expect(scrollAfter(600, waiting('s-01'), withDoing({ 's-03': { waitingFor: 's-01' } }))).toBe(
      1000,
    );
  });

  it('«у низа» не мерится в render: перерисовка без смены строки раскладку ленты не читает', () => {
    withLayout(() => {
      const { rerender, initial } = renderPanel(entryOf({ messages: [message('m-1')] }), {
        activity: waiting('s-01'),
      });
      // Счётчики чтений раскладки — на самой ленте: каждое чтение `scrollHeight`, `clientHeight` и `scrollTop`
      // в render было бы синхронной перекладкой на каждое событие активности.
      const reads: string[] = [];
      let scrollTop = 600;
      Object.defineProperties(feed(), {
        scrollHeight: { configurable: true, get: () => (reads.push('scrollHeight'), 1000) },
        clientHeight: { configurable: true, get: () => (reads.push('clientHeight'), 400) },
        scrollTop: {
          configurable: true,
          get: () => (reads.push('scrollTop'), scrollTop),
          set: (value: number) => {
            scrollTop = value;
          },
        },
      });

      // Посторонняя перерисовка: у участника изменились метрики, а живая строка прежняя.
      rerender(
        <RoomPanel
          {...initial}
          activity={withDoing({ 's-02': { waitingFor: 's-01', tokensIn: 5 } })}
        />,
      );

      expect(reads).toEqual([]);
    });
  });

  it('строка прежняя — перерисовка позицию не трогает, даже у низа', () => {
    expect(scrollAfter(590, waiting('s-01'), waiting('s-01'))).toBe(590);
  });
});

describe('RoomPanel — пустая комната и блок Decisions', () => {
  it('пустая комната — подсказка из 1.3', () => {
    renderPanel(entryOf());
    expect(screen.getByText('Write the task for everyone below. The lead collects positions and brings you a decision.')).toBeTruthy();
  });

  it('с сообщением подсказки нет', () => {
    renderPanel(entryOf({ messages: [message('m-1', { text: 'Задача' })] }));
    expect(screen.queryByText(/Write the task for everyone below/)).toBeNull();
  });

  it('решения — блоком Decisions первым в ленте: текст и автор', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-01', kind: 'decision', text: 'Сначала контракт', at: '2026-09-27T09:00:00.000Z' }),
        message('m-2', { from: 's-02', kind: 'note', text: 'Принял', at: '2026-09-27T09:01:00.000Z' }),
      ],
    });
    renderPanel(entry);
    const block = document.querySelector('[data-decisions]') as HTMLElement;
    expect(feed().firstElementChild).toBe(block);
    expect(within(block).getByText('Decisions')).toBeTruthy();
    expect(block.textContent).toContain('Сначала контракт');
    expect(block.textContent).toContain('S01 архитектор');
    expect(block.textContent).not.toContain('Принял');
  });

  it('решений нет — блока нет', () => {
    renderPanel(entryOf({ messages: [message('m-1')] }));
    expect(document.querySelector('[data-decisions]')).toBeNull();
  });

  it('текст решения в блоке — строчный Markdown: без #, маркеров и **, чип с ярлыком, ссылка наружу', () => {
    const entry = entryOf({
      messages: [
        message('m-1', {
          from: 's-01',
          kind: 'decision',
          text: '## План\n\n- **код** — @s02\n- [ревью](https://example.com/pr) — @s03',
        }),
      ],
    });
    const { initial } = renderPanel(entry);
    const item = (document.querySelector('[data-decisions]') as HTMLElement).querySelector(
      'li',
    ) as HTMLElement;
    expect((item.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      'План код — @S02 бэкенд ревью — @S03 ревью · S01 архитектор',
    );
    expect(item.textContent).not.toMatch(/[#*]/);
    expect(item.querySelector('strong')?.textContent).toBe('код');
    expect(item.querySelector('p, h2, ul, ol, li, br')).toBeNull();
    expect(
      Array.from(item.querySelectorAll('[data-mention]'), (chip) =>
        chip.getAttribute('data-mention'),
      ),
    ).toEqual(['s-02', 's-03']);
    expect(fireEvent.click(within(item).getByRole('link', { name: 'ревью' }))).toBe(false);
    expect(initial.onOpenExternal).toHaveBeenCalledWith('https://example.com/pr');
  });
});

describe('RoomPanel — сообщения (1.3)', () => {
  it('отправитель, адресаты, тег вида; человек — «You → all», агент — ярлыками', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { text: 'Задача для всех', at: '2026-09-27T09:00:00.000Z' }),
        message('m-2', { from: 's-03', to: ['s-01'], kind: 'question', text: 'Что с миграцией?', at: '2026-09-27T09:01:00.000Z', readBy: { human: 'x', 's-01': 'x' } }),
        message('m-3', { from: 's-01', to: ['s-02', 's-03'], kind: 'decision', text: 'Идём так', at: '2026-09-27T09:02:00.000Z' }),
      ],
    });
    renderPanel(entry);
    expect(messageRow('m-1').textContent).toContain('You');
    expect(messageRow('m-1').textContent).toContain('→ all');
    // Лента стоит на листе центра: там 100-е ступени светлой темы — почти сам лист (`neutral-100` — он и есть), и
    // теги всех трёх видов красятся заливкой 200 (в тёмной прежняя 100).
    const sheetFill = (kind: string, ramp: string): void => {
      const row = messageRow(kind === 'note' ? 'm-1' : kind === 'question' ? 'm-2' : 'm-3');
      const classes = within(row).getByText(kind).className.split(/\s+/);
      expect(classes, `${kind}: светлая`).toContain(`bg-${ramp}-200`);
      expect(classes, `${kind}: тёмная`).toContain(`dark:bg-${ramp}-100`);
      expect(classes, `${kind}: голой 100 нет`).not.toContain(`bg-${ramp}-100`);
    };
    sheetFill('note', 'neutral');
    expect(messageRow('m-2').textContent).toContain('S03 ревью');
    expect(messageRow('m-2').textContent).toContain('→ S01 архитектор');
    sheetFill('question', 'accent');
    expect(messageRow('m-3').textContent).toContain('→ S02 бэкенд, S03 ревью');
    sheetFill('decision', 'accent-2');
  });

  it('порядок ленты — по времени сообщений', () => {
    const entry = entryOf({
      messages: [message('m-2', { at: '2026-09-27T09:05:00.000Z' }), message('m-1', { at: '2026-09-27T09:00:00.000Z' })],
    });
    renderPanel(entry);
    expect(Array.from(document.querySelectorAll('[data-message-id]')).map((row) => row.getAttribute('data-message-id'))).toEqual(['m-1', 'm-2']);
  });

  it('★ у сообщений ведущего', () => {
    const entry = entryOf({ messages: [message('m-1', { from: 's-01', readBy: {} }), message('m-2', { from: 's-02', readBy: {} })] });
    renderPanel(entry);
    expect(within(messageRow('m-1')).queryByTitle('Lead')).not.toBeNull();
    expect(within(messageRow('m-2')).queryByTitle('Lead')).toBeNull();
  });

  it('упоминание @s02 в тексте — чип с ярлыком участника; неизвестный участник — чип с тегом', () => {
    const entry = entryOf({ messages: [message('m-1', { from: 's-01', text: 'Части: @s02 — код, @s-03 — ревью, @s09 — ?' })] });
    renderPanel(entry);
    const chips = Array.from(messageRow('m-1').querySelectorAll<HTMLElement>('[data-mention]'));
    expect(chips.map((chip) => [chip.getAttribute('data-mention'), chip.textContent])).toEqual([
      ['s-02', '@S02 бэкенд'],
      ['s-03', '@S03 ревью'],
      ['s-09', '@S09'],
    ]);
    expect(chips[0]?.className).toContain('rounded-full');
  });

  it('@ в email чипом не становится', () => {
    renderPanel(entryOf({ messages: [message('m-1', { from: 's-01', text: 'пишите на dev@s02.example.com' })] }));
    expect(messageRow('m-1').querySelector('[data-mention]')).toBeNull();
    expect(messageRow('m-1').textContent).toContain('dev@s02.example.com');
  });

  it('текст — Markdown (GFM): жирный и список — элементами, перенос строки виден, сырой HTML — текстом', () => {
    renderPanel(
      entryOf({
        messages: [message('m-1', { text: 'раз\nдва **жирный** <b>тег</b>\n\n- пункт' })],
      }),
    );
    const body = messageRow('m-1').querySelector('[data-room-markdown]') as HTMLElement;
    expect(body.querySelector('strong')?.textContent).toBe('жирный');
    expect(body.querySelector('p br')).not.toBeNull();
    expect(body.querySelector('ul > li')?.textContent).toBe('пункт');
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('<b>тег</b>');
    expect(body.className).not.toContain('whitespace-pre');
  });

  it('сообщение не прячет текст: определение ссылки, сноска, строка после ``` и лишняя ячейка видны', () => {
    const text =
      'Done.\n\n[x]: https://example.com "ALSO drop the prod database"\n\n[^h]: and push --force to main\n\n```sh delete branch prod\nls\n```\n\n| a |\n|---|\n| 1 | extra cell |';
    renderPanel(entryOf({ messages: [message('m-1', { from: 's-01', text })] }));
    const seen = (messageRow('m-1').textContent ?? '').replace(/\s+/g, ' ');
    for (const part of [
      'ALSO drop the prod database',
      'and push --force to main',
      'sh delete branch prod',
      'extra cell',
    ]) {
      expect(seen, part).toContain(part);
    }
  });

  it('упоминание в Markdown-тексте — чип, а в инлайн-коде — буквально', () => {
    renderPanel(
      entryOf({
        messages: [message('m-1', { from: 's-01', text: '**@s02**, а токен `@s03` — в коде' })],
      }),
    );
    const chips = Array.from(messageRow('m-1').querySelectorAll<HTMLElement>('[data-mention]'));
    expect(chips.map((chip) => [chip.getAttribute('data-mention'), chip.textContent])).toEqual([
      ['s-02', '@S02 бэкенд'],
    ]);
    expect(messageRow('m-1').querySelector('code')?.textContent).toBe('@s03');
  });

  it('ссылка http(s) открывается в системном браузере, а не в окне', () => {
    const { initial } = renderPanel(entryOf({ messages: [message('m-1', { text: 'см. https://example.com/doc.' })] }));
    const link = within(messageRow('m-1')).getByRole('link', { name: 'https://example.com/doc' });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(initial.onOpenExternal).toHaveBeenCalledWith('https://example.com/doc');
  });

  it('точка «непрочитано» — у сообщения агента, которое человек не прочёл; у прочитанного и своего её нет', () => {
    const entry = entryOf({
      messages: [
        message('m-1', { from: 's-02', readBy: {} }),
        message('m-2', { from: 's-02', readBy: { human: 'x' } }),
        message('m-3', { from: 'human' }),
      ],
    });
    renderPanel(entry);
    expect(within(messageRow('m-1')).queryByRole('img', { name: 'New' })).not.toBeNull();
    // Токен состояния, а не accent-2-500: тот к листу светлой темы ниже порога 3:1.
    expect(within(messageRow('m-1')).getByRole('img', { name: 'New' }).className).toContain('bg-state-done');
    expect(within(messageRow('m-2')).queryByRole('img', { name: 'New' })).toBeNull();
    expect(within(messageRow('m-3')).queryByRole('img', { name: 'New' })).toBeNull();
  });

  it('системная строка: аватар системы, без «→ …», без точки и без тега', () => {
    const entry = entryOf({
      messages: [message('m-1', { from: 'system', to: ['human'], text: 'You accepted the decision', readBy: {} })],
    });
    renderPanel(entry);
    const row = messageRow('m-1');
    expect(row.getAttribute('data-sender')).toBe('system');
    expect(within(row).getByTitle('Parley')).toBeTruthy();
    expect(row.textContent).toContain('Parley');
    expect(row.textContent).not.toContain('System');
    expect(row.textContent).toContain('You accepted the decision');
    expect(row.textContent).not.toContain('→');
    expect(within(row).queryByRole('img', { name: 'New' })).toBeNull();
  });

  it('сообщение в 2000 знаков и слово без пробелов переносятся внутри колонки', () => {
    const word = 'Ы'.repeat(2000);
    renderPanel(entryOf({ messages: [message('m-1', { text: word })] }));
    const body = messageRow('m-1').querySelector('[data-room-markdown]') as HTMLElement;
    expect(body.textContent).toBe(word);
    expect(body.className).toContain('break-words');
    expect(body.className).toContain('[overflow-wrap:anywhere]');
    expect(messageRow('m-1').className).toContain('max-w-[680px]');
  });
});

describe('RoomPanel — строка ожидания по readBy (1.3)', () => {
  it('«Not picked up yet by …» — теги тех, кто ещё не прочитал', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { human: 'x', 's-02': 'x' } })] });
    renderPanel(entry);
    expect(within(messageRow('m-1')).getByText('▤ Not picked up yet by S01, S03')).toBeTruthy();
  });

  it('все прочитали — строки нет; пришла отметка чтения — строка пропадает', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { human: 'x', 's-02': 'x' } })] });
    const { update } = renderPanel(entry);
    expect(messageRow('m-1').querySelector('[data-message-waiting]')).not.toBeNull();
    update(entryOf({ messages: [message('m-1', { readBy: { human: 'x', 's-01': 'x', 's-02': 'x', 's-03': 'x' } })] }));
    expect(messageRow('m-1').querySelector('[data-message-waiting]')).toBeNull();
  });

  it('закрытая сессия сообщение не подхватит — её в строке нет', () => {
    const custom = sessions();
    custom[0] = makeSession('s-01', 'архитектор', { lifecycle: 'closed' });
    renderPanel(entryOf({ sessions: custom, messages: [message('m-1', { readBy: { human: 'x' } })] }));
    expect(within(messageRow('m-1')).getByText('▤ Not picked up yet by S02, S03')).toBeTruthy();
  });
});

describe('RoomPanel — старая карта', () => {
  it('карта без lead и proposal читается: ведущий — первый из members', () => {
    const legacy = room();
    Reflect.deleteProperty(legacy, 'lead');
    Reflect.deleteProperty(legacy, 'proposal');
    renderPanel(entryOf({ room: legacy, messages: [message('m-1')] }));
    expect(screen.getByText('Created by you · 3 agents · lead S01 · Платежи')).toBeTruthy();
    expect(document.querySelector('[data-decision-card]')).toBeNull();
  });
});

describe('RoomPanel — поле ввода и отправка (2.2)', () => {
  const editor = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' });

  function typeAndSend(text: string): void {
    const node = document.createTextNode(text);
    editor().append(node);
    document.getSelection()?.collapse(node, text.length);
    fireEvent.input(editor());
    fireEvent.keyDown(editor(), { key: 'Enter' });
  }

  it('письмо без упоминаний уходит всем: rooms.send с to: [], kind note, roomId и работой', async () => {
    renderPanel(entryOf());
    typeAndSend('Всем привет');
    await waitFor(() => expect(bridge.calls.filter((call) => call.method === 'rooms.send')).toHaveLength(1));
    expect(bridge.calls.find((call) => call.method === 'rooms.send')?.params).toEqual({
      projectPath: PROJECT,
      workId: WORK_ID,
      roomId: 'r-01',
      to: [],
      text: 'Всем привет',
      kind: 'note',
    });
  });

  it('черновик — на комнату: ключ `{workKey}/{roomId}`', () => {
    renderPanel(entryOf());
    const node = document.createTextNode('недописано');
    editor().append(node);
    document.getSelection()?.collapse(node, node.data.length);
    fireEvent.input(editor());
    expect(useUiStore.getState().composerDrafts).toEqual({ [`${PROJECT} ${WORK_ID}/r-01`]: 'недописано' });
  });

  it('в меню упоминаний ★ у ведущего комнаты', () => {
    renderPanel(entryOf());
    const node = document.createTextNode('@');
    editor().append(node);
    document.getSelection()?.collapse(node, 1);
    fireEvent.input(editor());
    const starred = screen.getAllByRole('option').filter((item) => within(item).queryByTitle('Lead') !== null);
    expect(starred.map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01']);
  });

  it('мета пункта меню — «модель · состояние» из живых метрик; модель неизвестна — только состояние', () => {
    const activity = withModels({ 's-01': 'claude-opus-5-5', 's-03': 'gpt-5.5' }, 'working');
    renderPanel(entryOf(), { activity });
    const node = document.createTextNode('@');
    editor().append(node);
    document.getSelection()?.collapse(node, 1);
    fireEvent.input(editor());
    const meta = screen.getAllByRole('option').map((item) => item.lastElementChild?.textContent);
    expect(meta).toEqual(['Opus 5.5 · working', 'idle', 'GPT-5.5 · working']);
  });

  it('фильтр меню ищет и по модели', () => {
    const activity = withModels({ 's-01': 'claude-opus-5-5', 's-03': 'gpt-5.5' });
    renderPanel(entryOf(), { activity });
    const node = document.createTextNode('@opus');
    editor().append(node);
    document.getSelection()?.collapse(node, node.data.length);
    fireEvent.input(editor());
    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01']);
  });

  it('в меню упоминаний — живые участники; закрытый не предлагается', () => {
    const custom = sessions();
    custom[2] = makeSession('s-03', 'ревью', { provider: 'codex', lifecycle: 'closed' });
    renderPanel(entryOf({ sessions: custom }));
    const node = document.createTextNode('@');
    editor().append(node);
    document.getSelection()?.collapse(node, 1);
    fireEvent.input(editor());
    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01', 's-02']);
  });

  it('не ушло: тост с причиной, текст возвращается в поле', async () => {
    bridge.setHandler('rooms.send', () => {
      throw Object.assign(new Error('нет'), { code: 'not_found', message: 'нет' });
    });
    renderPanel(entryOf());
    typeAndSend('Важное');
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't send the message: not found."));
    await waitFor(() => expect(editor().textContent).toBe('Важное'));
  });
});

describe('RoomPanel — прокрутка к низу', () => {
  function setScrollHeight(el: HTMLElement, height: number): void {
    Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true });
  }

  it('при открытии лента прижата к низу', () => {
    // jsdom не считает раскладку: высота прокручиваемого содержимого задаётся у прототипа элемента до рендера.
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    try {
      renderPanel(entryOf({ messages: [message('m-1'), message('m-2')] }));
      expect(feed().scrollTop).toBe(900);
    } finally {
      spy.mockRestore();
    }
  });

  it('новое сообщение снова прижимает ленту к низу, даже если её прокрутили вверх', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      expect(feed().scrollTop).toBe(500);
      feed().scrollTop = 40;
      setScrollHeight(feed(), 800);
      update(entryOf({ messages: [message('m-1'), message('m-2', { at: '2026-09-27T10:00:00.000Z' })] }));
      expect(feed().scrollTop).toBe(800);
    } finally {
      spy.mockRestore();
    }
  });

  it('перерисовка без нового сообщения позицию не трогает', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      feed().scrollTop = 40;
      update(entryOf({ messages: [message('m-1')] }));
      expect(feed().scrollTop).toBe(40);
    } finally {
      spy.mockRestore();
    }
  });
});

/** IntersectionObserver для jsdom: видимость объявляет тест (`show`), как в `use-mark-read.test.tsx`. */
class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.all.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  fire(el: Element, visible: boolean): void {
    if (!this.targets.has(el)) return;
    const entry = { target: el, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as unknown as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
}

describe('RoomPanel — прочтение существующим механизмом (mail.markRead)', () => {
  let marked: string[][];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeIntersectionObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    marked = [];
    bridge.setHandler('mail.markRead', (params) => {
      marked.push([...params.messageIds]);
      return { marked: params.messageIds.length };
    });
  });

  function showMeta(...ids: string[]): void {
    act(() => {
      for (const id of ids) {
        const el = document.querySelector(`[data-message-meta="${id}"]`);
        if (el === null) throw new Error(`нет сообщения ${id}`);
        for (const observer of FakeIntersectionObserver.all) observer.fire(el, true);
      }
    });
  }

  async function wait(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const unread = (): Message[] => [
    message('m-1', { from: 's-02', readBy: {} }),
    message('m-2', { from: 's-03', readBy: {} }),
    message('m-3', { from: 's-02', readBy: { human: 'x' } }),
    message('m-4', { from: 'system', to: ['human'], readBy: { human: 'x' } }),
  ];

  it('видимое непрочитанное сообщение уходит в mail.markRead: через секунду видимости и паузу пачки, прочитанные и системная — нет', async () => {
    renderPanel(entryOf({ messages: unread() }));
    showMeta('m-1', 'm-2', 'm-3', 'm-4');
    await wait(999);
    expect(marked).toEqual([]);
    await wait(1 + 500);
    expect(marked).toEqual([['m-1', 'm-2']]);
    expect(bridge.calls.find((call) => call.method === 'mail.markRead')?.params).toEqual({
      projectPath: PROJECT,
      workId: WORK_ID,
      messageIds: ['m-1', 'm-2'],
    });
  });

  it('системная строка без отметки человека тоже отмечается: счётчик сайдбара не должен висеть', async () => {
    renderPanel(entryOf({ messages: [message('m-1', { from: 'system', to: ['human'], readBy: {} })] }));
    showMeta('m-1');
    await wait(1600);
    expect(marked).toEqual([['m-1']]);
  });

  it('работа неактивна (скрыта в LRU) — не отмечается, как и при окне без фокуса', async () => {
    renderPanel(entryOf({ messages: unread() }), { active: false });
    showMeta('m-1');
    await wait(3000);
    expect(marked).toEqual([]);
    cleanup();
    FakeIntersectionObserver.all = [];

    useUiStore.setState({ windowFocused: false });
    renderPanel(entryOf({ messages: unread() }));
    showMeta('m-1');
    await wait(3000);
    expect(marked).toEqual([]);
  });

  it('высокое сообщение, половина которого никогда не помещается в окно, всё равно отмечается: наблюдается строка меты', () => {
    renderPanel(entryOf({ messages: [message('m-1', { from: 's-02', readBy: {}, text: 'Ы'.repeat(2000) })] }));
    const observed = FakeIntersectionObserver.all.flatMap((observer) => Array.from(observer.targets));
    expect(observed).toEqual([document.querySelector('[data-message-meta="m-1"]')]);
  });
});

describe('RoomPanel — карточка решения (1.3, 2.4)', () => {
  const PROPOSAL = {
    id: 'p-01',
    from: 's-01',
    text: 'Возврат больше суммы — ошибка. Части: @s02 — код, @s03 — ревью. Жду твоего решения.',
    rev: 0,
    at: '2026-09-27T09:10:00.000Z',
  };

  const withProposal = (patch: Partial<typeof PROPOSAL> = {}, extra: { messages?: Message[] } = {}): WorkEntry =>
    entryOf({ room: room({ proposal: { ...PROPOSAL, ...patch } }), ...extra });

  const card = (): HTMLElement => document.querySelector('[data-decision-card]') as HTMLElement;
  const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
  const resolveCalls = () => bridge.calls.filter((call) => call.method === 'rooms.resolveProposal');

  beforeEach(() => {
    bridge.setHandler('rooms.resolveProposal', () => ({ messageId: 'm-decision' }));
  });

  it('последней в ленте, после сообщений: ведущий, тег «decision · waiting for you», время, текст с чипами', () => {
    renderPanel(withProposal({}, { messages: [message('m-1', { text: 'Задача' })] }));
    expect(feed().lastElementChild).toBe(card());
    expect(card().getAttribute('data-proposal-id')).toBe('p-01');
    expect(within(card()).getByText('S01 архитектор')).toBeTruthy();
    expect(within(card()).getByText('decision · waiting for you').className).toContain('bg-accent-100');
    expect(card().querySelectorAll('[data-mention]')).toHaveLength(2);
    expect(card().textContent).toContain('@S02 бэкенд');
    expect(card().textContent).toContain('@S03 ревью');
    expect(within(card()).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Return for rework' })).toBeTruthy();
  });

  it('рамка 1.5px accent и фон accent 9%, до 680px', () => {
    renderPanel(withProposal());
    expect(card().className).toContain('border-[1.5px]');
    expect(card().className).toContain('border-(--color-accent)');
    expect(card().className).toContain('bg-[color-mix(in_srgb,var(--color-accent)_9%,transparent)]');
    expect(card().className).toContain('max-w-[680px]');
  });

  it('решение одно ждёт — комната не «пустая»: подсказки нет; решения нет — нет и карточки', () => {
    renderPanel(withProposal());
    expect(screen.queryByText(/Write the task for everyone below/)).toBeNull();
    cleanup();
    renderPanel(entryOf());
    expect(document.querySelector('[data-decision-card]')).toBeNull();
  });

  it('новая версия (rev вырос) заменяет текст на месте: карточка одна', () => {
    const { update } = renderPanel(withProposal({ text: 'Версия один' }));
    expect(card().textContent).toContain('Версия один');
    update(withProposal({ text: 'Версия два, с учётом замечания', rev: 1 }));
    expect(document.querySelectorAll('[data-decision-card]')).toHaveLength(1);
    expect(card().textContent).toContain('Версия два, с учётом замечания');
    expect(card().textContent).not.toContain('Версия один');
    expect(card().getAttribute('data-proposal-rev')).toBe('1');
  });

  it('Accept зовёт rooms.resolveProposal с proposalId, rev и action; заметки в принятии нет', async () => {
    renderPanel(withProposal({ rev: 2 }));
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(resolveCalls()).toHaveLength(1));
    expect(resolveCalls()[0]?.params).toEqual({
      projectPath: PROJECT,
      workId: WORK_ID,
      roomId: 'r-01',
      proposalId: 'p-01',
      rev: 2,
      action: 'accept',
    });
  });

  it('Return for rework → поле заметки и Send to lead / Cancel; кнопки Accept на время заметки нет', () => {
    renderPanel(withProposal());
    fireEvent.click(button('Return for rework'));
    expect(screen.getByPlaceholderText('What should the lead change?')).toBeTruthy();
    expect(button('Send to lead')).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return for rework' })).toBeNull();
  });

  it('Send to lead зовёт rooms.resolveProposal с proposalId, rev, action и note (без пробелов по краям)', async () => {
    renderPanel(withProposal({ id: 'p-07', rev: 3 }));
    fireEvent.click(button('Return for rework'));
    fireEvent.change(screen.getByPlaceholderText('What should the lead change?'), { target: { value: '  Добавь тесты на границы  ' } });
    fireEvent.click(button('Send to lead'));
    await waitFor(() => expect(resolveCalls()).toHaveLength(1));
    expect(resolveCalls()[0]?.params).toEqual({
      projectPath: PROJECT,
      workId: WORK_ID,
      roomId: 'r-01',
      proposalId: 'p-07',
      rev: 3,
      action: 'return',
      note: 'Добавь тесты на границы',
    });
  });

  it('пустая заметка допустима (2.4): note — пустая строка', async () => {
    renderPanel(withProposal());
    fireEvent.click(button('Return for rework'));
    fireEvent.click(button('Send to lead'));
    await waitFor(() => expect(resolveCalls()).toHaveLength(1));
    expect(resolveCalls()[0]?.params).toMatchObject({ action: 'return', note: '' });
  });

  it('Cancel возвращает две кнопки, ничего не отправляя; заметка при этом не теряется', () => {
    renderPanel(withProposal());
    fireEvent.click(button('Return for rework'));
    fireEvent.change(screen.getByPlaceholderText('What should the lead change?'), { target: { value: 'черновик заметки' } });
    fireEvent.click(button('Cancel'));
    expect(button('Accept')).toBeTruthy();
    expect(resolveCalls()).toHaveLength(0);
    fireEvent.click(button('Return for rework'));
    expect((screen.getByPlaceholderText('What should the lead change?') as HTMLTextAreaElement).value).toBe('черновик заметки');
  });

  it('уходит rev показанной карточки: пришла новая версия — следующий ответ на неё', async () => {
    const { update } = renderPanel(withProposal({ rev: 0 }));
    update(withProposal({ rev: 1, text: 'Новый текст' }));
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(resolveCalls()).toHaveLength(1));
    expect(resolveCalls()[0]?.params).toMatchObject({ proposalId: 'p-01', rev: 1 });
  });

  it('форма возврата переживает новую версию текста: заметка на месте', () => {
    const { update } = renderPanel(withProposal({ rev: 0 }));
    fireEvent.click(button('Return for rework'));
    fireEvent.change(screen.getByPlaceholderText('What should the lead change?'), { target: { value: 'заметка' } });
    update(withProposal({ rev: 1, text: 'Новый текст' }));
    expect((screen.getByPlaceholderText('What should the lead change?') as HTMLTextAreaElement).value).toBe('заметка');
    expect(card().textContent).toContain('Новый текст');
  });

  it('conflict: тост, карточка на месте, кнопки снова доступны; новая версия приходит событием карты', async () => {
    let attempts = 0;
    bridge.setHandler('rooms.resolveProposal', () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('устарело'), { code: 'conflict', message: 'устарело' });
      return { messageId: 'm-decision' };
    });
    const { update } = renderPanel(withProposal({ rev: 0 }));
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('The decision changed — review the latest version.'));
    await waitFor(() => expect(button('Accept').disabled).toBe(false));
    expect(button('Return for rework').disabled).toBe(false);
    expect(document.querySelectorAll('[data-decision-card]')).toHaveLength(1);

    update(withProposal({ rev: 1, text: 'Текст после замены' }));
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(resolveCalls()).toHaveLength(2));
    expect(resolveCalls()[1]?.params).toMatchObject({ rev: 1 });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('прочая ошибка: тост с причиной, кнопки снова доступны', async () => {
    bridge.setHandler('rooms.resolveProposal', () => {
      throw Object.assign(new Error('нет'), { code: 'not_found', message: 'нет' });
    });
    renderPanel(withProposal());
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't answer the decision: not found."));
    await waitFor(() => expect(button('Accept').disabled).toBe(false));
  });

  it('двойное нажатие Accept — один вызов; кнопки заняты, пока ответа нет', async () => {
    let finish: () => void = () => {};
    bridge.setHandler(
      'rooms.resolveProposal',
      () => new Promise<{ messageId: string }>((resolve) => (finish = () => resolve({ messageId: 'm-decision' }))),
    );
    renderPanel(withProposal());
    const accept = button('Accept');
    fireEvent.click(accept);
    fireEvent.click(accept);
    fireEvent.click(accept);
    expect(resolveCalls()).toHaveLength(1);
    expect(button('Accept').disabled).toBe(true);
    expect(button('Return for rework').disabled).toBe(true);
    await act(async () => {
      finish();
    });
    expect(resolveCalls()).toHaveLength(1);
  });

  it('два клика в один тик, до перерисовки, тоже дают один вызов', async () => {
    renderPanel(withProposal());
    const accept = button('Accept');
    await act(async () => {
      accept.click();
      accept.click();
    });
    expect(resolveCalls()).toHaveLength(1);
  });

  it('после успеха кнопки остаются занятыми, пока карточка не сменилась; новое решение — снова отвечаемо', async () => {
    const { update } = renderPanel(withProposal({ id: 'p-01' }));
    fireEvent.click(button('Accept'));
    await waitFor(() => expect(resolveCalls()).toHaveLength(1));
    expect(button('Accept').disabled).toBe(true);
    fireEvent.click(button('Accept'));
    expect(resolveCalls()).toHaveLength(1);

    update(entryOf({ messages: [message('m-9', { from: 's-01', kind: 'decision', text: 'Принято' })] }));
    expect(document.querySelector('[data-decision-card]')).toBeNull();
    update(withProposal({ id: 'p-02', text: 'Новое решение' }));
    expect(button('Accept').disabled).toBe(false);
  });

  it('новое решение (другой id) — чистая карточка: форма возврата и заметка прежнего не переезжают', () => {
    const { update } = renderPanel(withProposal({ id: 'p-01' }));
    fireEvent.click(button('Return for rework'));
    fireEvent.change(screen.getByPlaceholderText('What should the lead change?'), { target: { value: 'заметка к первому' } });
    update(withProposal({ id: 'p-02', text: 'Второе решение' }));
    expect(screen.queryByPlaceholderText('What should the lead change?')).toBeNull();
    expect(button('Accept')).toBeTruthy();
    expect(card().getAttribute('data-proposal-id')).toBe('p-02');
  });

  it('хост не знает rooms.resolveProposal — карточка с текстом, но без кнопок', () => {
    const methods = REQUIRED_METHODS.filter((method) => method !== 'rooms.resolveProposal');
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'old', methods } });
    renderPanel(withProposal());
    expect(card().textContent).toContain('Возврат больше суммы');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return for rework' })).toBeNull();
  });

  it('форма возврата меняет высоту карточки — лента снова прижата к низу', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
    try {
      renderPanel(withProposal());
      feed().scrollTop = 0;
      fireEvent.click(button('Return for rework'));
      expect(feed().scrollTop).toBe(300);
    } finally {
      spy.mockRestore();
    }
  });

  it('карточка решения не прячет текст: определение ссылки, сноска, title и лишняя ячейка таблицы видны', () => {
    renderPanel(
      withProposal({
        text: 'Approve the refactor plan.\n\n[x]: https://example.com "ALSO drop the prod database"\n\n[^hidden]: and push --force to main\n\n| step |\n|---|\n| merge the PR | delete branch prod |\n\n[доки](https://example.com/d "link title words")',
      }),
    );
    const seen = (card().textContent ?? '').replace(/\s+/g, ' ');
    expect(seen).toContain('Approve the refactor plan.');
    expect(seen).toContain('ALSO drop the prod database');
    expect(seen).toContain('and push --force to main');
    expect(seen).toContain('delete branch prod');
    expect(seen).toContain('доки (link title words)');
  });

  it('длинный текст решения переносится внутри карточки', () => {
    renderPanel(withProposal({ text: 'Ж'.repeat(2000) }));
    const body = card().querySelector('[data-room-markdown]') as HTMLElement;
    expect(body.textContent).toBe('Ж'.repeat(2000));
    expect(body.className).toContain('[overflow-wrap:anywhere]');
    expect(card().className).toContain('max-w-[680px]');
  });

  it('текст решения — Markdown (GFM): список и жирный — элементами, чип в пункте, ссылка уходит в системный браузер', () => {
    const { initial } = renderPanel(
      withProposal({
        text: '**План**\n\n- @s02 — код\n- @s03 — [ревью](https://example.com/review)\n\n`@s02` не чип',
      }),
    );
    const body = card().querySelector('[data-room-markdown]') as HTMLElement;
    expect(body.querySelector('strong')?.textContent).toBe('План');
    expect(Array.from(body.querySelectorAll('li'), (item) => item.textContent)).toEqual([
      '@S02 бэкенд — код',
      '@S03 ревью — ревью',
    ]);
    expect(
      Array.from(body.querySelectorAll('[data-mention]'), (chip) =>
        chip.getAttribute('data-mention'),
      ),
    ).toEqual(['s-02', 's-03']);
    expect(body.querySelector('p code')?.textContent).toBe('@s02');
    const notPrevented = fireEvent.click(within(card()).getByRole('link', { name: 'ревью' }));
    expect(notPrevented).toBe(false);
    expect(initial.onOpenExternal).toHaveBeenCalledWith('https://example.com/review');
  });
});
