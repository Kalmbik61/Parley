/**
 * Вкладка комнаты (спека окна 2026-09-29, 1.3, 2.2–2.4; кусок 6 плана): шапка и лента участников, лента
 * сообщений (текст — Markdown, подробно в `RoomMarkdown.test.tsx`) с чипами, тегами видов и строкой
 * доставки по `readBy` и метрикам хоста, блок `Decisions`, пустая комната,
 * отправка из поля ввода, карточка решения и ответ на неё (`rooms.resolveProposal` с `proposalId`, `rev`,
 * `action`, `note`; `conflict` — тост; двойное нажатие — один вызов), прочтение и прокрутка.
 */

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { Message, Room, WorkEntry, WorkSession } from '@parley/core';
import type { LiveMetrics, LiveTask, MailWait } from '@parley/protocol';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { ErrorBoundary } from '../../shell/ErrorBoundary.js';
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

/** Живая активность с данными хоста о задачах, ожидании и письмах (`metrics.tasks`, `metrics.waitingFor`, `metrics.mailWaiting`). */
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
/** Кнопка «↓N» над низом ленты: сколько пришло снизу, пока человек читал историю. */
const newBelow = (): HTMLElement | null => document.querySelector('[data-room-new-below]');
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

  it('свой @human человека — текст, а не чип «@you»; у сообщения агента чип остаётся (Parley 0.3.0)', () => {
    renderPanel(
      entryOf({
        messages: [
          message('m-1', { text: 'Сам себе, @human и @s02', at: '2026-09-27T09:00:00.000Z' }),
          message('m-2', {
            from: 's-02',
            to: ['human'],
            text: 'Нужен ответ, @human',
            readBy: { human: 'x' },
            at: '2026-09-27T09:01:00.000Z',
          }),
        ],
      }),
    );
    const own = messageRow('m-1');
    expect(own.querySelector('[data-mention-human]')).toBeNull();
    expect(own.querySelector('[title="Mentions you"]')).toBeNull();
    // Чипы сессий у человека, как и прежде.
    expect(own.querySelector('[data-mention="s-02"]')?.textContent).toBe('@S02 бэкенд');
    expect(own.querySelector('[data-room-markdown]')?.textContent).toBe(
      'Сам себе, @human и @S02 бэкенд',
    );

    const theirs = messageRow('m-2');
    expect(theirs.querySelector('[data-mention-human]')?.textContent).toBe('@you');
    expect(theirs.querySelector('[data-room-markdown]')?.textContent).toBe('Нужен ответ, @you');
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

describe('RoomPanel — ответы с цитатой (Parley 0.3.0)', () => {
  /** Вопрос человека и ответ агента на него: у ответа `replyTo` — id вопроса. */
  const replyMessages = (): Message[] => [
    message('m-1', {
      text: 'Что с миграцией?\n\nПодробности ниже',
      kind: 'question',
      at: '2026-09-27T09:00:00.000Z',
    }),
    message('m-2', {
      from: 's-02',
      to: ['human'],
      text: 'Миграция **готова**',
      replyTo: 'm-1',
      at: '2026-09-27T09:01:00.000Z',
    }),
  ];
  const quote = (id: string): HTMLElement =>
    document.querySelector(`[data-message-reply="${id}"]`) as HTMLElement;
  const flashed = (id: string): boolean => messageRow(id).hasAttribute('data-reply-flash');
  /** Куда звали `scrollIntoView`: на каком элементе и с какими параметрами. */
  let scrolled: Array<{ element: Element; options: unknown }>;

  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push({ element: this, options });
    });
  });

  it('ответ — цитата между метой и текстом: «↩ подпись: выдержка», кнопка с именем из видимого текста и подсказкой', () => {
    renderPanel(entryOf({ messages: replyMessages() }));
    const button = quote('m-1');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('↩ You: Что с миграцией?');
    expect(button.querySelector('.font-semibold')?.textContent).toBe('You');
    // Имя — видимый текст без стрелки: aria-label выдержку не прячет.
    expect(button.hasAttribute('aria-label')).toBe(false);
    expect(screen.getByRole('button', { name: 'You: Что с миграцией?' })).toBe(button);
    expect(button.getAttribute('title')).toBe('Что с миграцией?');
    // Мелкий текст, одна строка с обрезкой, акцентная черта слева.
    for (const token of ['text-xs', 'truncate', 'border-l-2', 'border-(--color-accent)']) {
      expect(button.className, token).toContain(token);
    }
    // Внутри строки ответа, между метой и текстом.
    const row = messageRow('m-2');
    const meta = row.querySelector('[data-message-meta]') as HTMLElement;
    const body = row.querySelector('[data-room-markdown]') as HTMLElement;
    expect(row.contains(button)).toBe(true);
    expect(meta.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Текст ответа — Markdown, как у любого сообщения; у оригинала цитаты нет.
    expect(body.querySelector('strong')?.textContent).toBe('готова');
    expect(
      messageRow('m-1').querySelector('[data-message-reply], [data-message-reply-missing]'),
    ).toBeNull();
  });

  it('подпись и выдержка — как в ленте: ярлык агента, упоминания чипами-ярлыками, разметка снята', () => {
    renderPanel(
      entryOf({
        messages: [
          message('m-1', {
            from: 's-01',
            text: '## @s02, @human — что **скажете**?',
            at: '2026-09-27T09:00:00.000Z',
          }),
          message('m-2', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:01:00.000Z' }),
        ],
      }),
    );
    expect(quote('m-1').textContent).toBe('↩ S01 архитектор: @S02 бэкенд, @you — что скажете?');
    expect(
      screen.getByRole('button', { name: 'S01 архитектор: @S02 бэкенд, @you — что скажете?' }),
    ).toBe(quote('m-1'));
  });

  it('цитата сообщения человека — его @human текстом, как в ленте; цитата сообщения агента — «@you»', () => {
    renderPanel(
      entryOf({
        messages: [
          message('m-1', { text: 'Сам себе, @human', at: '2026-09-27T09:00:00.000Z' }),
          message('m-2', {
            from: 's-01',
            text: 'Нужен ответ, @human',
            at: '2026-09-27T09:01:00.000Z',
          }),
          message('m-3', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:02:00.000Z' }),
          message('m-4', { from: 's-02', replyTo: 'm-2', at: '2026-09-27T09:03:00.000Z' }),
        ],
      }),
    );
    expect(quote('m-1').textContent).toBe('↩ You: Сам себе, @human');
    expect(quote('m-2').textContent).toBe('↩ S01 архитектор: Нужен ответ, @you');
  });

  it('от текста оригинала ничего не осталось (одна картинка без alt) — цитата показывает одну подпись', () => {
    renderPanel(
      entryOf({
        messages: [
          message('m-1', {
            text: '![](https://example.com/a.png)',
            at: '2026-09-27T09:00:00.000Z',
          }),
          message('m-2', { from: 's-02', replyTo: 'm-1', at: '2026-09-27T09:01:00.000Z' }),
        ],
      }),
    );
    expect(quote('m-1').textContent).toBe('↩ You');
  });

  it('клик по цитате зовёт scrollIntoView у сообщения-оригинала: по центру, плавно', () => {
    renderPanel(entryOf({ messages: replyMessages() }));
    fireEvent.click(quote('m-1'));
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.element).toBe(messageRow('m-1'));
    expect(scrolled[0]?.options).toEqual({ block: 'center', behavior: 'smooth' });
  });

  it('оригинал выше ленты встаёт к верху, а не по центру: строка меты (по ней — прочтение) остаётся на экране', () => {
    renderPanel(entryOf({ messages: replyMessages() }));
    const feed = document.querySelector('[data-room-feed]') as HTMLElement;
    // В jsdom раскладки нет: высоты задаём сами — лента 400px, оригинал 900px, то есть выше ленты.
    Object.defineProperty(feed, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(messageRow('m-1'), 'offsetHeight', { configurable: true, value: 900 });

    fireEvent.click(quote('m-1'));
    expect(scrolled.at(-1)?.options).toEqual({ block: 'start', behavior: 'smooth' });

    // Ровно в высоту ленты — ещё по центру.
    Object.defineProperty(messageRow('m-1'), 'offsetHeight', { configurable: true, value: 400 });
    fireEvent.click(quote('m-1'));
    expect(scrolled.at(-1)?.options).toEqual({ block: 'center', behavior: 'smooth' });
  });

  it('клик по цитате переносит фокус на строку оригинала: после прокрутки и без собственной прокрутки', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      renderPanel(entryOf({ messages: replyMessages() }));
      // Строка принимает фокус программно, но в порядок Tab не входит.
      expect(messageRow('m-1').getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(document.body);

      fireEvent.click(quote('m-1'));
      expect(document.activeElement).toBe(messageRow('m-1'));
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus.mock.contexts[0]).toBe(messageRow('m-1'));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      const scroll = vi.mocked(Element.prototype.scrollIntoView);
      expect(scroll.mock.invocationCallOrder[0]).toBeLessThan(
        focus.mock.invocationCallOrder[0] as number,
      );
    } finally {
      focus.mockRestore();
    }
  });

  it('prefers-reduced-motion: reduce — прокрутка без плавности (behavior: auto); без него — smooth', () => {
    const reduce = (matches: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: matches && query === '(prefers-reduced-motion: reduce)',
        media: query,
      }));
    reduce(true);
    renderPanel(entryOf({ messages: replyMessages() }));
    fireEvent.click(quote('m-1'));
    expect(scrolled[0]?.options).toEqual({ block: 'center', behavior: 'auto' });

    reduce(false);
    fireEvent.click(quote('m-1'));
    expect(scrolled[1]?.options).toEqual({ block: 'center', behavior: 'smooth' });
  });

  it('оригинал получает data-reply-flash на 1,2 с, по таймеру атрибут снимается', () => {
    vi.useFakeTimers();
    renderPanel(entryOf({ messages: replyMessages() }));
    expect(flashed('m-1')).toBe(false);

    fireEvent.click(quote('m-1'));
    expect(flashed('m-1')).toBe(true);
    // Подсвечено только то, к чему перешли: не ответ и не вся лента.
    expect(document.querySelectorAll('[data-reply-flash]')).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(flashed('m-1')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(flashed('m-1')).toBe(false);
  });

  it('повторный клик перезапускает отсчёт: подсветка держится 1,2 с от последнего клика', () => {
    vi.useFakeTimers();
    renderPanel(entryOf({ messages: replyMessages() }));
    fireEvent.click(quote('m-1'));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    fireEvent.click(quote('m-1'));
    expect(scrolled).toHaveLength(2);

    // От первого клика прошло 1600 мс, от второго — 800: прежний таймер подсветку не снимает.
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(flashed('m-1')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(flashed('m-1')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(flashed('m-1')).toBe(false);
  });

  it('подсветка одна на ленту: переход к другому оригиналу снимает прежнюю', () => {
    vi.useFakeTimers();
    const messages = [
      ...replyMessages(),
      message('m-3', {
        from: 's-03',
        to: ['human'],
        replyTo: 'm-2',
        at: '2026-09-27T09:02:00.000Z',
      }),
    ];
    renderPanel(entryOf({ messages }));
    fireEvent.click(quote('m-2'));
    expect(flashed('m-2')).toBe(true);

    fireEvent.click(quote('m-1'));
    expect(flashed('m-2')).toBe(false);
    expect(flashed('m-1')).toBe(true);
    expect(document.querySelectorAll('[data-reply-flash]')).toHaveLength(1);
  });

  it('вкладку закрыли — таймер подсветки не остаётся', () => {
    vi.useFakeTimers();
    const { unmount } = renderPanel(entryOf({ messages: replyMessages() }));
    fireEvent.click(quote('m-1'));
    unmount();
    // Перенос фокуса в jsdom ставит свою отложенную задачу (`selectionchange`): она не наша и срабатывает сразу.
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('плавная прокрутка: подсветка перезапускается по scrollend', () => {
    /** Цепочка: m-2 отвечает на m-1, m-3 — на m-2; цитат две, и переходов можно сделать два подряд. */
    const chain = (): Message[] => [
      ...replyMessages(),
      message('m-3', {
        from: 's-03',
        to: ['human'],
        replyTo: 'm-2',
        at: '2026-09-27T09:02:00.000Z',
      }),
    ];
    /** Лента доехала: браузер присылает `scrollend` на самой ленте. */
    const scrollEnd = (): void => {
      fireEvent(feed(), new Event('scrollend'));
    };
    /** Сколько слушателей `scrollend` сейчас висит на элементе: поставленных минус снятых. */
    const watchScrollEnd = (element: HTMLElement): (() => number) => {
      const add = vi.spyOn(element, 'addEventListener');
      const remove = vi.spyOn(element, 'removeEventListener');
      const count = (spy: { mock: { calls: unknown[][] } }): number =>
        spy.mock.calls.filter((call) => call[0] === 'scrollend').length;
      return () => count(add) - count(remove);
    };
    const advance = (ms: number): void => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };

    it('scrollend перезапускает подсветку: атрибут жив через 1,2 с после клика, если лента доехала на 1 с', () => {
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: replyMessages() }));
      const row = messageRow('m-1');
      const set = vi.spyOn(row, 'setAttribute');
      const remove = vi.spyOn(row, 'removeAttribute');
      fireEvent.click(quote('m-1'));
      expect(set).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();

      advance(1000);
      scrollEnd();
      // Снято и поставлено заново: анимация CSS идёт сначала.
      expect(remove).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledTimes(2);
      expect(flashed('m-1')).toBe(true);

      // 1,2 с от клика прошло — без перезапуска подсветка уже погасла бы; отсчёт идёт от `scrollend`.
      advance(200);
      expect(flashed('m-1')).toBe(true);
      advance(999);
      expect(flashed('m-1')).toBe(true);
      advance(1);
      expect(flashed('m-1')).toBe(false);
    });

    it('дорога длиннее подсветки: та успела погаснуть по пути, scrollend зажигает её снова на месте', () => {
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: replyMessages() }));
      fireEvent.click(quote('m-1'));
      advance(1500);
      expect(flashed('m-1')).toBe(false);

      scrollEnd();
      expect(flashed('m-1')).toBe(true);
      advance(1199);
      expect(flashed('m-1')).toBe(true);
      advance(1);
      expect(flashed('m-1')).toBe(false);
    });

    it('перезапуск один: второй scrollend подряд подсветку не продлевает', () => {
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: replyMessages() }));
      fireEvent.click(quote('m-1'));
      advance(500);
      scrollEnd();
      advance(500);
      scrollEnd();
      // Продлила бы второй раз — подсветка жила бы до 2,2 с; живёт до 1,7 (500 + 1200).
      advance(699);
      expect(flashed('m-1')).toBe(true);
      advance(1);
      expect(flashed('m-1')).toBe(false);
    });

    it('без scrollend всё как раньше: подсветка гаснет на 1,2 с, ожидание — на 2 с, опоздавший scrollend её не возвращает', () => {
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: replyMessages() }));
      // Таймер панели, не связанный с переходом: обновление относительного времени сообщений.
      const idle = vi.getTimerCount();
      const listeners = watchScrollEnd(feed());
      fireEvent.click(quote('m-1'));
      expect(listeners()).toBe(1);

      advance(1199);
      expect(flashed('m-1')).toBe(true);
      advance(1);
      expect(flashed('m-1')).toBe(false);
      // Подсветка погасла, а ожидание живёт: лента могла ещё ехать.
      expect(listeners()).toBe(1);
      advance(799);
      expect(listeners()).toBe(1);
      advance(1);
      expect(listeners()).toBe(0);

      scrollEnd();
      expect(flashed('m-1')).toBe(false);
      expect(vi.getTimerCount()).toBe(idle);
    });

    it('второй переход до scrollend первого снимает первое ожидание: слушатель один, и срабатывает он для второго', () => {
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: chain() }));
      const listeners = watchScrollEnd(feed());
      fireEvent.click(quote('m-2'));
      expect(flashed('m-2')).toBe(true);
      expect(listeners()).toBe(1);
      const firstTarget = vi.spyOn(messageRow('m-2'), 'setAttribute');

      fireEvent.click(quote('m-1'));
      expect(flashed('m-1')).toBe(true);
      expect(flashed('m-2')).toBe(false);
      expect(listeners()).toBe(1);

      scrollEnd();
      expect(listeners()).toBe(0);
      // Подсветка первого сообщения не возвращалась: его ожидание снято вместе с переходом.
      expect(firstTarget).not.toHaveBeenCalled();
      expect(flashed('m-2')).toBe(false);
      expect(flashed('m-1')).toBe(true);
      expect(document.querySelectorAll('[data-reply-flash]')).toHaveLength(1);
    });

    it('новый переход снимает и страховочный таймер прежнего ожидания: он не обрывает новое', () => {
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: chain() }));
      const listeners = watchScrollEnd(feed());
      fireEvent.click(quote('m-2'));
      advance(1500);
      // Страховка первого ожидания сработала бы на 2 с, то есть через 500 мс; второе ждёт до 3,5 с.
      fireEvent.click(quote('m-1'));
      advance(600);
      expect(listeners()).toBe(1);

      scrollEnd();
      expect(flashed('m-1')).toBe(true);
      advance(1199);
      expect(flashed('m-1')).toBe(true);
      advance(1);
      expect(flashed('m-1')).toBe(false);
    });

    it('вкладку закрыли — слушателя scrollend и таймеров не остаётся, а опоздавшее событие ничего не зажигает', () => {
      vi.useFakeTimers();
      const { unmount } = renderPanel(entryOf({ messages: replyMessages() }));
      const feedElement = feed();
      const row = messageRow('m-1');
      const listeners = watchScrollEnd(feedElement);
      fireEvent.click(quote('m-1'));
      expect(listeners()).toBe(1);

      unmount();
      expect(listeners()).toBe(0);
      // Перенос фокуса в jsdom ставит свою отложенную задачу (`selectionchange`): она не наша и срабатывает сразу.
      vi.advanceTimersByTime(0);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent(feedElement, new Event('scrollend'));
      expect(row.hasAttribute('data-reply-flash')).toBe(false);
    });

    it('prefers-reduced-motion: reduce — ничего не ждёт: слушателя scrollend нет, подсветка идёт как раньше', () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
      }));
      vi.useFakeTimers();
      renderPanel(entryOf({ messages: replyMessages() }));
      const idle = vi.getTimerCount();
      const listeners = watchScrollEnd(feed());
      fireEvent.click(quote('m-1'));
      expect(scrolled[0]?.options).toEqual({ block: 'center', behavior: 'auto' });
      expect(listeners()).toBe(0);
      expect(flashed('m-1')).toBe(true);

      scrollEnd();
      expect(flashed('m-1')).toBe(true);
      advance(1200);
      expect(flashed('m-1')).toBe(false);
      // Страховочного таймера нет: после подсветки ничего не осталось.
      expect(vi.getTimerCount()).toBe(idle);
    });
  });

  it('id оригинала с кавычкой, скобкой и косой чертой находится без подстановки в селектор', () => {
    const id = 'm-"1"]\\';
    renderPanel(
      entryOf({
        messages: [
          message(id, { text: 'Вопрос', at: '2026-09-27T09:00:00.000Z' }),
          message('m-2', { from: 's-02', replyTo: id, at: '2026-09-27T09:01:00.000Z' }),
        ],
      }),
    );
    fireEvent.click(document.querySelector('[data-message-reply]') as HTMLElement);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.element.getAttribute('data-message-id')).toBe(id);
    expect(scrolled[0]?.element.hasAttribute('data-reply-flash')).toBe(true);
  });

  it('оригинала уже нет в ленте — клик ничего не делает: ни прокрутки, ни подсветки, ни ошибки', () => {
    renderPanel(entryOf({ messages: replyMessages() }));
    const button = quote('m-1');
    messageRow('m-1').remove();
    expect(() => fireEvent.click(button)).not.toThrow();
    expect(scrolled).toEqual([]);
    expect(document.querySelector('[data-reply-flash]')).toBeNull();
    // Переходить некуда — фокус не двигается.
    expect(document.activeElement).toBe(document.body);
  });

  it('оригинала нет в этой комнате (чужая комната, несуществующий id) — тот же блок, но не кнопка', () => {
    renderPanel(
      entryOf({
        messages: [
          message('m-0', { roomId: 'r-02', text: 'Чужая комната', at: '2026-09-27T09:00:00.000Z' }),
          message('m-1', { from: 's-02', replyTo: 'm-0', at: '2026-09-27T09:01:00.000Z' }),
          message('m-2', { from: 's-03', replyTo: 'm-99', at: '2026-09-27T09:02:00.000Z' }),
        ],
      }),
    );
    expect(document.querySelector('[data-message-reply]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Original message/ })).toBeNull();
    const blocks = Array.from(
      document.querySelectorAll<HTMLElement>('[data-message-reply-missing]'),
    );
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.tagName).toBe('DIV');
      expect(block.textContent).toBe('↩ Original message is not in this room');
      for (const token of ['text-xs', 'truncate', 'border-l-2']) {
        expect(block.className, token).toContain(token);
      }
    }
    // Это не кнопка: клик ничего не прокручивает и не подсвечивает.
    fireEvent.click(blocks[0] as HTMLElement);
    expect(scrolled).toEqual([]);
    expect(document.querySelector('[data-reply-flash]')).toBeNull();
  });

  it('после перехода к оригиналу новое сообщение агента ленту не уводит: человек читает вопрос, пришедшее — в «↓1»', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(800);
    try {
      const { update } = renderPanel(entryOf({ messages: replyMessages() }));
      expect(feed().scrollTop).toBe(800);
      fireEvent.click(quote('m-1'));
      // Браузер доскроллил ленту к оригиналу и прислал `scroll`: до дна далеко.
      feed().scrollTop = 100;
      fireEvent.scroll(feed());
      update(
        entryOf({
          messages: [
            ...replyMessages(),
            message('m-3', { from: 's-03', to: ['human'], at: '2026-09-27T10:00:00.000Z' }),
          ],
        }),
      );
      expect(feed().scrollTop).toBe(100);
      expect(newBelow()?.textContent).toBe('↓1');
    } finally {
      spy.mockRestore();
    }
  });

  it('после перехода к оригиналу читают историю: живая строка ленту не дёргает', () => {
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400),
    ];
    try {
      const { rerender, initial } = renderPanel(entryOf({ messages: replyMessages() }));
      fireEvent.click(quote('m-1'));
      feed().scrollTop = 100;
      fireEvent.scroll(feed());
      rerender(<RoomPanel {...initial} activity={withDoing({ 's-02': { waitingFor: 's-01' } })} />);
      expect(liveLine()).not.toBeNull();
      expect(feed().scrollTop).toBe(100);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('RoomPanel — сообщение, которое Markdown не осилил (Parley 0.3.0)', () => {
  it("'>'.repeat(5000) + ' текст' в сообщении и в цитате ответа — вкладка жива: сырой текст в ленте, соседи и поле ввода на месте", () => {
    // React логирует пойманную ошибку в консоль — тестовому выводу это не нужно.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deep = `${'>'.repeat(5000)} текст`;
      const entry = entryOf({
        messages: [
          message('m-1', { text: deep, at: '2026-09-27T09:00:00.000Z' }),
          message('m-2', {
            from: 's-02',
            to: ['human'],
            text: 'Ответ **жирным** и @human',
            replyTo: 'm-1',
            at: '2026-09-27T09:01:00.000Z',
          }),
        ],
      });
      render(
        <ErrorBoundary title="Tab crashed">
          <RoomPanel {...props(entry)} />
        </ErrorBoundary>,
      );
      // Вкладка не ушла в `ErrorBoundary`: панель, лента, сообщения и поле ввода — на месте.
      expect(screen.queryByText('Tab crashed')).toBeNull();
      expect(document.querySelector('[data-room-panel]')).not.toBeNull();
      expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
      // Упавшее сообщение — сырой текст (или цитаты Markdown, если стек больше обычного): текст виден в любом случае.
      expect(messageRow('m-1').textContent).toContain('текст');
      const fallback = messageRow('m-1').querySelector('[data-markdown-fallback]');
      if (fallback === null) expect(messageRow('m-1').querySelector('blockquote')).not.toBeNull();
      else expect(fallback.textContent).toBe(deep);
      // Соседнее сообщение отрисовано как обычно, а цитата ответа не уронила ленту.
      expect(messageRow('m-2').querySelector('strong')?.textContent).toBe('жирным');
      expect(messageRow('m-2').querySelector('[data-mention-human]')?.textContent).toBe('@you');
      expect(
        (document.querySelector('[data-message-reply="m-1"]') as HTMLElement).textContent,
      ).toMatch(/^↩ You/);
    } finally {
      errorSpy.mockRestore();
    }
  }, 30_000);
});

describe('RoomPanel — строка доставки: кто забрал сообщение и кто ещё нет (1.3)', () => {
  const deliveryLine = (id = 'm-1'): HTMLElement | null => messageRow(id).querySelector('[data-message-delivery]');
  const pickedPart = (id = 'm-1'): HTMLElement | null => messageRow(id).querySelector('[data-message-picked]');
  const waitingPart = (id = 'm-1'): HTMLElement | null => messageRow(id).querySelector('[data-message-waiting]');

  it('«Not picked up yet by …» — теги тех, кто ещё не прочитал', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { human: 'x', 's-02': 'x' } })] });
    renderPanel(entry);
    expect(within(messageRow('m-1')).getByText('▤ Not picked up yet by S01, S03')).toBeTruthy();
  });

  it('и забравшие, и ждущие: одна строка, части через « · », у ждущего причина от хоста в скобках', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { human: 'x', 's-02': 'x' } })] });
    renderPanel(entry, { activity: withDoing({ 's-01': { mailWaiting: 'busy' } }) });
    expect(document.querySelectorAll('[data-message-delivery]')).toHaveLength(1);
    expect(deliveryLine()?.textContent).toBe('✓ Picked up by S02 · ▤ Not picked up yet by S01 (busy), S03');
    expect(pickedPart()?.textContent).toBe('✓ Picked up by S02');
    expect(waitingPart()?.textContent).toBe('▤ Not picked up yet by S01 (busy), S03');
  });

  it('все забрали — только «Picked up by …»: части «не забрали» и разделителя нет', () => {
    const entry = entryOf({ messages: [message('m-1', { readBy: { human: 'x', 's-01': 'x', 's-02': 'x', 's-03': 'x' } })] });
    renderPanel(entry);
    expect(deliveryLine()?.textContent).toBe('✓ Picked up by S01, S02, S03');
    expect(waitingPart()).toBeNull();
  });

  it('никто не забрал — только «Not picked up yet by …»: части «забрали» и разделителя нет', () => {
    renderPanel(entryOf({ messages: [message('m-1')] }), { activity: withDoing({ 's-01': { mailWaiting: 'busy' } }) });
    expect(deliveryLine()?.textContent).toBe('▤ Not picked up yet by S01 (busy), S02, S03');
    expect(pickedPart()).toBeNull();
  });

  it('подсказка у «забрали» — тег и время отметки каждого, в порядке адресатов', () => {
    // Местное время: подсказка пишет часы в поясе окна, а не в UTC.
    const at = (second: number): string => new Date(2026, 8, 27, 20, 30, second).toISOString();
    const entry = entryOf({
      messages: [message('m-1', { to: ['s-03', 's-02', 's-01'], readBy: { 's-02': at(15), 's-03': at(11) } })],
    });
    renderPanel(entry);
    expect(pickedPart()?.getAttribute('title')).toBe('S03 20:30:11 · S02 20:30:15');
    // У части «не забрали» подсказки нет: ждущему ставить время нечем.
    expect(waitingPart()?.getAttribute('title')).toBeNull();
  });

  it('отметка не ISO-временем — в подсказке один тег, а не «Invalid Date»', () => {
    renderPanel(entryOf({ messages: [message('m-1', { readBy: { 's-02': 'x' } })] }));
    expect(pickedPart()?.getAttribute('title')).toBe('S02');
  });

  it('каждая причина хоста — своими словами в скобках после тега', () => {
    const words: Record<MailWait, string> = {
      busy: 'busy',
      draft: 'unsent text in its terminal',
      'no-hooks': 'waiting in its terminal',
      'in-flight': 'notified, not started',
      pointed: 'notified',
      paused: 'auto-wake paused',
      sleeping: 'sleeping',
      resuming: 'resuming',
      'resume-limit': 'resume limit reached',
      pending: 'not launched',
    };
    for (const [reason, text] of Object.entries(words) as Array<[MailWait, string]>) {
      renderPanel(entryOf({ messages: [message('m-1', { to: ['s-01'] })] }), {
        activity: withDoing({ 's-01': { mailWaiting: reason } }),
      });
      expect(waitingPart()?.textContent, reason).toBe(`▤ Not picked up yet by S01 (${text})`);
      cleanup();
    }
  });

  it('причины нет — один тег, без пустых скобок: хост прежней версии поля не шлёт, у новой причина `null`', () => {
    for (const metrics of [{}, { mailWaiting: null }] as const) {
      renderPanel(entryOf({ messages: [message('m-1', { to: ['s-01'] })] }), {
        activity: withDoing({ 's-01': metrics }),
      });
      expect(waitingPart()?.textContent).toBe('▤ Not picked up yet by S01');
      cleanup();
    }
  });

  it('причина и отметка приходят позже — строка меняется на месте', () => {
    const { rerender, initial } = renderPanel(entryOf({ messages: [message('m-1')] }));
    expect(deliveryLine()?.textContent).toBe('▤ Not picked up yet by S01, S02, S03');
    rerender(<RoomPanel {...initial} activity={withDoing({ 's-01': { mailWaiting: 'busy' } })} />);
    expect(deliveryLine()?.textContent).toBe('▤ Not picked up yet by S01 (busy), S02, S03');
    // S01 забрал: он уходит из ждущих вместе с причиной и встаёт среди забравших.
    rerender(
      <RoomPanel
        {...initial}
        entry={entryOf({ messages: [message('m-1', { readBy: { 's-01': 'x' } })] })}
        activity={withDoing({ 's-01': { mailWaiting: 'busy' } })}
      />,
    );
    expect(deliveryLine()?.textContent).toBe('✓ Picked up by S01 · ▤ Not picked up yet by S02, S03');
  });

  it('закрытая сессия сообщение не подхватит — её в строке нет; все адресаты закрыты — строки нет вовсе', () => {
    const custom = sessions();
    custom[0] = makeSession('s-01', 'архитектор', { lifecycle: 'closed' });
    renderPanel(entryOf({ sessions: custom, messages: [message('m-1', { readBy: { human: 'x' } })] }));
    expect(within(messageRow('m-1')).getByText('▤ Not picked up yet by S02, S03')).toBeTruthy();
    cleanup();

    const closed = sessions().map((session) => ({ ...session, lifecycle: 'closed' as const }));
    renderPanel(entryOf({ sessions: closed, messages: [message('m-1', { readBy: { human: 'x' } })] }));
    expect(deliveryLine()).toBeNull();
  });

  it('у системной строки и у письма человеку строки доставки нет', () => {
    renderPanel(
      entryOf({
        messages: [
          message('m-1', { from: 'system', to: ['human'], text: 'You accepted the decision', readBy: {} }),
          message('m-2', { from: 's-02', to: ['human'], text: 'Готово' }),
        ],
      }),
    );
    expect(deliveryLine('m-1')).toBeNull();
    expect(deliveryLine('m-2')).toBeNull();
  });

  it('длинный список переносится по словам и по знакам, а не распирает колонку: ни обрезки, ни горизонтальной прокрутки', () => {
    const entry = entryOf({
      messages: [message('m-1', { to: ['s-01', 's-02', 's-03'], readBy: { 's-02': 'x' } })],
    });
    renderPanel(entry, {
      activity: withDoing({
        's-01': { mailWaiting: 'draft' },
        's-03': { mailWaiting: 'resume-limit' },
      }),
    });
    const line = deliveryLine();
    expect(line?.className).toContain('break-words');
    expect(line?.className).not.toMatch(/truncate|whitespace-nowrap|overflow/);
    expect(line?.textContent).toBe(
      '✓ Picked up by S02 · ▤ Not picked up yet by S01 (unsent text in its terminal), S03 (resume limit reached)',
    );
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
    const starred = within(screen.getByRole('listbox')).getAllByRole('option').filter((item) => within(item).queryByTitle('Lead') !== null);
    expect(starred.map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01']);
  });

  it('мета пункта меню — «модель · состояние» из живых метрик; модель неизвестна — только состояние', () => {
    const activity = withModels({ 's-01': 'claude-opus-5-5', 's-03': 'gpt-5.5' }, 'working');
    renderPanel(entryOf(), { activity });
    const node = document.createTextNode('@');
    editor().append(node);
    document.getSelection()?.collapse(node, 1);
    fireEvent.input(editor());
    const meta = within(screen.getByRole('listbox')).getAllByRole('option').map((item) => item.lastElementChild?.textContent);
    expect(meta).toEqual(['Opus 5.5 · working', 'idle', 'GPT-5.5 · working']);
  });

  it('фильтр меню ищет и по модели', () => {
    const activity = withModels({ 's-01': 'claude-opus-5-5', 's-03': 'gpt-5.5' });
    renderPanel(entryOf(), { activity });
    const node = document.createTextNode('@opus');
    editor().append(node);
    document.getSelection()?.collapse(node, node.data.length);
    fireEvent.input(editor());
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01']);
  });

  it('в меню упоминаний — живые участники; закрытый не предлагается', () => {
    const custom = sessions();
    custom[2] = makeSession('s-03', 'ревью', { provider: 'codex', lifecycle: 'closed' });
    renderPanel(entryOf({ sessions: custom }));
    const node = document.createTextNode('@');
    editor().append(node);
    document.getSelection()?.collapse(node, 1);
    fireEvent.input(editor());
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01', 's-02']);
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

  /** Ленту прокрутили вверх, браузер прислал `scroll`: до дна далеко — человек читает историю. */
  function scrollUp(top = 40): void {
    feed().scrollTop = top;
    fireEvent.scroll(feed());
  }
  const fromAgent = (id: string, at: string): Message =>
    message(id, { from: 's-02', readBy: {}, at });
  const PROPOSAL = {
    id: 'p-01',
    from: 's-01',
    text: 'Делаем так',
    rev: 0,
    at: '2026-09-27T11:00:00.000Z',
  };

  it('у низа новое сообщение агента прижимает ленту, кнопки «↓N» нет', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      expect(feed().scrollTop).toBe(500);
      setScrollHeight(feed(), 800);
      update(entryOf({ messages: [message('m-1'), fromAgent('m-2', '2026-09-27T10:00:00.000Z')] }));
      expect(feed().scrollTop).toBe(800);
      expect(newBelow()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('читают историю — новое сообщение агента ленту не трогает, внизу кнопка «↓1» (Parley 0.3.0)', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      scrollUp();
      setScrollHeight(feed(), 800);
      update(entryOf({ messages: [message('m-1'), fromAgent('m-2', '2026-09-27T10:00:00.000Z')] }));
      expect(feed().scrollTop).toBe(40);
      const button = newBelow() as HTMLElement;
      expect(button.tagName).toBe('BUTTON');
      expect(button.textContent).toBe('↓1');
      expect(button.getAttribute('aria-label')).toBe('1 new below');
    } finally {
      spy.mockRestore();
    }
  });

  it('«↓N» копит новые сообщения и решение; клик ведёт к низу, и кнопка гаснет', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const two = [
        message('m-1'),
        fromAgent('m-2', '2026-09-27T10:00:00.000Z'),
        fromAgent('m-3', '2026-09-27T10:01:00.000Z'),
      ];
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      scrollUp();
      update(entryOf({ messages: two }));
      expect(newBelow()?.textContent).toBe('↓2');
      // Новое решение ведущего — тоже снизу, ленту оно не уводит.
      setScrollHeight(feed(), 900);
      update(entryOf({ room: room({ proposal: PROPOSAL }), messages: two }));
      expect(feed().scrollTop).toBe(40);
      expect(newBelow()?.textContent).toBe('↓3');
      expect(newBelow()?.getAttribute('aria-label')).toBe('3 new below');

      fireEvent.click(newBelow() as HTMLElement);
      expect(feed().scrollTop).toBe(900);
      expect(newBelow()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('дошёл до низа прокруткой сам — «↓N» гаснет', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      scrollUp();
      update(entryOf({ messages: [message('m-1'), fromAgent('m-2', '2026-09-27T10:00:00.000Z')] }));
      expect(newBelow()).not.toBeNull();
      // 500 − 460 − 0 = 40 ≤ 48: у низа.
      scrollUp(460);
      expect(newBelow()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('своё сообщение (от человека) прижимает ленту к низу и гасит «↓N», даже когда читают историю', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const first = [message('m-1'), fromAgent('m-2', '2026-09-27T10:00:00.000Z')];
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      scrollUp();
      update(entryOf({ messages: first }));
      expect(newBelow()?.textContent).toBe('↓1');
      setScrollHeight(feed(), 800);
      // `message()` по умолчанию — от человека: это его ответ из поля ввода.
      update(entryOf({ messages: [...first, message('m-3', { at: '2026-09-27T10:05:00.000Z' })] }));
      expect(feed().scrollTop).toBe(800);
      expect(newBelow()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('новое решение, пока читают историю, ленту не уводит: карточка при появлении не прижимает ленту к низу', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
    try {
      const { update } = renderPanel(entryOf({ messages: [message('m-1')] }));
      scrollUp();
      setScrollHeight(feed(), 700);
      update(entryOf({ room: room({ proposal: PROPOSAL }), messages: [message('m-1')] }));
      expect(feed().scrollTop).toBe(40);
      expect(newBelow()?.textContent).toBe('↓1');
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

describe('RoomPanel — открытие комнаты: к самому раннему непрочитанному упоминанию (Parley 0.3.0)', () => {
  /** Сообщение агента, не прочитанное человеком (`message()` по умолчанию — прочитанное и от человека). */
  const agent = (id: string, patch: Partial<Message> = {}): Message =>
    message(id, { from: 's-02', readBy: {}, ...patch });
  /** Лента с упоминаниями: m-1 уже прочитано, m-3 и m-4 — непрочитанные упоминания, m-5 — после них. */
  const mentionMessages = (): Message[] => [
    agent('m-1', { text: 'старое, @human', readBy: { human: 'x' } }),
    agent('m-2', { text: 'без упоминаний' }),
    agent('m-3', { text: 'первое, @human' }),
    agent('m-4', { text: 'второе, @human' }),
    agent('m-5', { text: 'после всех' }),
  ];
  const flashed = (id: string): boolean => messageRow(id).hasAttribute('data-reply-flash');
  /** Куда звали `scrollIntoView`: на каком элементе и с какими параметрами. */
  let scrolled: Array<{ element: Element; options: unknown }>;
  /** jsdom не считает раскладку: высота ленты 900, окно 400 — `scrollTop` 0 это «далеко от дна». */
  let layout: Array<{ mockRestore(): void }>;

  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (
      this: Element,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push({ element: this, options });
    });
    layout = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400),
    ];
  });

  afterEach(() => {
    for (const spy of layout) spy.mockRestore();
  });

  it('есть непрочитанные упоминания — лента открывается на самом раннем: по центру, сразу, с подсветкой, не у низа', () => {
    renderPanel(entryOf({ messages: mentionMessages() }));
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.element).toBe(messageRow('m-3'));
    expect(scrolled[0]?.options).toEqual({ block: 'center', behavior: 'auto' });
    expect(flashed('m-3')).toBe(true);
    expect(document.querySelectorAll('[data-reply-flash]')).toHaveLength(1);
    // К низу (900) лента не прижата: упоминание осталось на экране.
    expect(feed().scrollTop).toBe(0);
  });

  it('при открытии фокус не трогается: он остаётся там, где был, а строка сообщения его не получает', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      renderPanel(entryOf({ messages: mentionMessages() }));
      expect(focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);
    } finally {
      focus.mockRestore();
    }
  });

  it('переход при открытии мгновенный (behavior: auto), даже когда плавность не отключена: клик по цитате — другое дело', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    renderPanel(entryOf({ messages: mentionMessages() }));
    expect(scrolled[0]?.options).toEqual({ block: 'center', behavior: 'auto' });
  });

  it('подсветка гаснет через 1,2 с, и таймера после закрытия вкладки не остаётся', () => {
    vi.useFakeTimers();
    const { unmount } = renderPanel(entryOf({ messages: mentionMessages() }));
    expect(flashed('m-3')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(flashed('m-3')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(flashed('m-3')).toBe(false);

    cleanup();
    const second = renderPanel(entryOf({ messages: mentionMessages() }));
    second.unmount();
    vi.advanceTimersByTime(0);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it('при открытии ничего не ждёт: слушателя scrollend нет, а подсветка — единственный таймер перехода', () => {
    vi.useFakeTimers();
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener');
    try {
      const { unmount } = renderPanel(entryOf({ messages: mentionMessages() }));
      expect(add.mock.calls.filter((call) => call[0] === 'scrollend')).toEqual([]);
      expect(flashed('m-3')).toBe(true);
      // Таймер панели, не связанный с переходом, — обновление относительного времени сообщений.
      const withFlash = vi.getTimerCount();
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(flashed('m-3')).toBe(false);
      expect(vi.getTimerCount()).toBe(withFlash - 1);
      unmount();
    } finally {
      add.mockRestore();
    }
  });

  it('прочитанное упоминание, @human в коде и в ссылке, упоминание от человека и системное — не цель: лента у низа', () => {
    renderPanel(
      entryOf({
        messages: [
          agent('m-1', { text: 'прочитано, @human', readBy: { human: 'x' } }),
          agent('m-2', { text: 'в коде `@human`' }),
          agent('m-3', { text: '[ask @human](https://x.dev)' }),
          message('m-4', { from: 'human', text: 'сам, @human' }),
          message('m-5', { from: 'system', to: ['human'], text: '@human', readBy: {} }),
          agent('m-6', { text: 'просто статус' }),
        ],
      }),
    );
    expect(scrolled).toEqual([]);
    expect(document.querySelector('[data-reply-flash]')).toBeNull();
    expect(feed().scrollTop).toBe(900);
  });

  it('непрочитанные сообщения без упоминаний — лента открывается у низа, как раньше', () => {
    renderPanel(entryOf({ messages: [agent('m-1'), agent('m-2'), agent('m-3')] }));
    expect(scrolled).toEqual([]);
    expect(feed().scrollTop).toBe(900);
  });

  it('упоминание в чужой комнате и в комнате без сообщений — цели нет', () => {
    renderPanel(entryOf({ messages: [agent('m-1', { roomId: 'r-02', text: 'чужое, @human' })] }));
    expect(scrolled).toEqual([]);
    expect(feed().scrollTop).toBe(900);
  });

  it('новое сообщение после открытия на упоминании ленту не уводит: человек читает упоминание, пришедшее — в «↓1»', () => {
    const { update } = renderPanel(entryOf({ messages: mentionMessages() }));
    expect(feed().scrollTop).toBe(0);
    update(
      entryOf({
        messages: [
          ...mentionMessages(),
          agent('m-6', { text: 'новое', at: '2026-09-27T10:00:00.000Z' }),
        ],
      }),
    );
    expect(feed().scrollTop).toBe(0);
    expect(document.querySelector('[data-room-new-below]')?.textContent).toBe('↓1');
    // Второго перехода к упоминанию нет: цель выбирают один раз, при открытии.
    expect(scrolled).toHaveLength(1);
  });

  it('упоминание пришло, когда лента уже открыта, — лента прижимается к низу, перехода к нему нет', () => {
    const { update } = renderPanel(entryOf({ messages: [agent('m-1', { text: 'раз' })] }));
    expect(feed().scrollTop).toBe(900);
    update(
      entryOf({
        messages: [
          agent('m-1', { text: 'раз' }),
          agent('m-2', { text: 'новое, @human', at: '2026-09-27T10:00:00.000Z' }),
        ],
      }),
    );
    expect(scrolled).toEqual([]);
    expect(feed().scrollTop).toBe(900);
  });

  it('живая строка после открытия на упоминании ленту к низу не прижимает: человек уже читает с упоминания', () => {
    const { rerender, initial } = renderPanel(entryOf({ messages: mentionMessages() }));
    expect(feed().scrollTop).toBe(0);
    rerender(<RoomPanel {...initial} activity={withDoing({ 's-02': { waitingFor: 's-01' } })} />);
    expect(liveLine()).not.toBeNull();
    expect(feed().scrollTop).toBe(0);
  });

  it('упоминание в конце ленты: после перехода лента у низа, и живая строка прижимает её, как обычно', () => {
    const { rerender, initial } = renderPanel(
      entryOf({
        messages: [agent('m-1', { text: 'раз' }), agent('m-2', { text: 'последнее, @human' })],
      }),
    );
    // Браузер доскроллил до дна: `scrollTop` 500, окно 400 — всего 900.
    expect(scrolled[0]?.element).toBe(messageRow('m-2'));
    feed().scrollTop = 500;
    fireEvent.scroll(feed());
    rerender(<RoomPanel {...initial} activity={withDoing({ 's-02': { waitingFor: 's-01' } })} />);
    expect(feed().scrollTop).toBe(900);
  });

  it('комнаты нет в карте, когда панель смонтирована, а потом она появилась, — это и есть открытие ленты', () => {
    const { rerender, initial } = renderPanel(entryOf({ messages: mentionMessages() }), {
      roomId: 'r-99',
    });
    expect(screen.getByText('Room not found')).toBeTruthy();
    expect(scrolled).toEqual([]);
    rerender(<RoomPanel {...initial} roomId="r-01" />);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.element).toBe(messageRow('m-3'));
    expect(flashed('m-3')).toBe(true);
  });

  it('StrictMode гоняет эффекты дважды и между прогонами снимает подсветку: переход и подсветка остаются', () => {
    const initial = props(entryOf({ messages: mentionMessages() }));
    render(
      <StrictMode>
        <RoomPanel {...initial} />
      </StrictMode>,
    );
    expect(scrolled.length).toBeGreaterThanOrEqual(1);
    expect(scrolled.every((call) => call.element === messageRow('m-3'))).toBe(true);
    expect(flashed('m-3')).toBe(true);
    expect(feed().scrollTop).toBe(0);
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

it('resolves the displayed completion with paired plan identity and ignores a late reply after reconnect',async()=>{
 useHostStore.setState({connections:1});
 const entry=entryOf(); const plan: import('@parley/core').RoomPlan={id:'pl-01',roomId:'r-01',rev:4,mode:'verified',status:'completing',goal:'Release',items:[],backlog:[],acceptedAt:'x',completedAt:null,cancelledAt:null,completionSummary:null};entry.map.plans=[plan];entry.map.rooms[0]!.mode='verified';entry.map.rooms[0]!.proposal={id:'p-01',rev:1,from:'s-01',at:'x',text:'Complete now',kind:'completion',planId:'pl-01',planRev:4};
 let finish!: (value: {messageId:string})=>void;bridge.setHandler('rooms.resolveProposal',()=>new Promise(resolve=>{finish=resolve;}));
 const view=renderPanel(entry);fireEvent.click(screen.getByText('Accept'));await waitFor(()=>expect(finish).toBeTypeOf('function'));
 expect(bridge.calls.find(c=>c.method==='rooms.resolveProposal')?.params).toMatchObject({proposalId:'p-01',rev:1,planId:'pl-01',planRev:4});
 act(()=>useHostStore.setState({connections:2}));await act(async()=>finish({messageId:'m-01'}));
 expect(document.querySelector('[data-completion-card]')).not.toBeNull();expect((screen.getByText('Accept') as HTMLButtonElement).disabled).toBe(false);view.unmount();
});

it('shows accepted plan controls in the room and passes the proposed plan revision on acceptance',async()=>{
 const entry=entryOf(); const plan: import('@parley/core').RoomPlan={id:'pl-01',roomId:'r-01',rev:3,mode:'checklist',status:'active',goal:'Accepted goal',items:[{id:1,title:'Recovery',owner:'s-01',scope:'plain',after:[],criteria:[],verifier:null,status:'ready',evidence:null,note:null,log:[]}],backlog:[],acceptedAt:'x',completedAt:null,cancelledAt:null,completionSummary:null};entry.map.plans=[plan];entry.map.rooms[0]!.mode='checklist';entry.map.rooms[0]!.proposal={id:'p-01',rev:2,from:'s-01',at:'x',text:'Proposed amendment',plan:{...plan,rev:4,status:'proposed',goal:'New goal'}};
 bridge.setHandler('rooms.resolveProposal',()=>({messageId:'m-01'}));renderPanel(entry);
 expect(screen.getByText('Mark done')).toBeTruthy();expect(screen.getByText('New goal')).toBeTruthy();fireEvent.click(screen.getByText('Accept'));await waitFor(()=>expect(bridge.calls.some(c=>c.method==='rooms.resolveProposal')).toBe(true));expect(bridge.calls.find(c=>c.method==='rooms.resolveProposal')?.params).toMatchObject({planId:'pl-01',planRev:4,rev:2});
});

it('disables archived completion responses and ignores a response when its work closes',async()=>{
 useHostStore.setState({connections:1});
 const entry=entryOf(); const plan: import('@parley/core').RoomPlan={id:'pl-01',roomId:'r-01',rev:4,mode:'verified',status:'completing',goal:'Release',items:[],backlog:[],acceptedAt:'x',completedAt:null,cancelledAt:null,completionSummary:null};entry.map.plans=[plan];entry.map.rooms[0]!.mode='verified';entry.map.rooms[0]!.proposal={id:'p-01',rev:1,from:'s-01',at:'x',text:'Complete now',kind:'completion',planId:'pl-01',planRev:4};
 let finish!: (value:{messageId:string})=>void;bridge.setHandler('rooms.resolveProposal',()=>new Promise(resolve=>{finish=resolve;}));
 const view=renderPanel(entry);fireEvent.click(screen.getByText('Accept'));await waitFor(()=>expect(finish).toBeTypeOf('function'));
 const closed=structuredClone(entry);closed.map.work.status='archived';view.update(closed);
 await act(async()=>finish({messageId:'m-01'}));
 expect(document.querySelector('[data-completion-card]')).not.toBeNull();
 expect(screen.getByText('Accept')).toHaveProperty('disabled',true);
 expect(screen.getByText('Return for rework')).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByText('Accept'));expect(bridge.calls.filter(call=>call.method==='rooms.resolveProposal')).toHaveLength(1);
 expect(screen.getAllByText('Reopen this workspace to change the plan.').length).toBeGreaterThan(0);
});

describe('room history menu in the header (P28)', () => {
  const sharedStatus = { state: 'shared' as const, sharedAt: '2026-10-05T10:00:00.000Z', version: 'v1', diagnostics: [] };
  const notShared = { state: 'not-shared' as const, sharedAt: null, version: 'missing', diagnostics: [] };
  it('is part of the room header and does not touch the host until opened', () => {
    renderPanel(entryOf());
    expect(document.querySelector('[data-room-header] [data-room-history]')).not.toBeNull();
    expect(bridge.calls.some(call => call.method.startsWith('rooms.history.'))).toBe(false);
  });
  it('Share publishes the snapshot of this room only after the explicit confirmation, with the host version', async () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS, 'rooms.history.get', 'rooms.history.share', 'rooms.history.unshare'] } });
    bridge.setHandler('rooms.history.get', () => notShared); bridge.setHandler('rooms.history.share', () => sharedStatus);
    renderPanel(entryOf());
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share history…' }));
    expect(bridge.calls.some(call => call.method === 'rooms.history.share')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }));
    await screen.findByText(/^Shared at /);
    expect(bridge.calls.find(call => call.method === 'rooms.history.share')?.params).toEqual({ projectPath: PROJECT, workId: WORK_ID, roomId: 'r-01', expectedVersion: 'missing', confirmed: true });
  });
  it('an old host leaves the room usable and the history actions unavailable', () => {
    renderPanel(entryOf());
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByText('Update or restart the host to share room history.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  });
});
