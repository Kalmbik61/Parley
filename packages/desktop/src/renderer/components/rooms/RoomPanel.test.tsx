/**
 * Вкладка комнаты (спека окна 2026-09-29, 1.3, 2.2–2.4; кусок 6 плана): шапка и лента участников, лента
 * сообщений с чипами, тегами видов и строкой ожидания по `readBy`, блок `Decisions`, пустая комната,
 * отправка из поля ввода, прочтение и прокрутка. Ответ на решение — `DecisionCard.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { Message, Room, WorkEntry, WorkSession } from '@harnas/core';
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
  useHostStore.setState({ status: { state: 'connected', hostVersion: 'test', methods: [...REQUIRED_METHODS, 'rooms.resolveProposal'] } });
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

const feed = (): HTMLElement => document.querySelector('[data-room-feed]') as HTMLElement;
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
  it('карточка на участника: ярлык, слово состояния, задача; тултип — провайдер и слово, без модели', () => {
    const activity = activityMap([makeActivity(REF('s-02'), 'blocked'), makeActivity(REF('s-01'), 'working')]);
    renderPanel(entryOf(), { activity });
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-participant]'));
    expect(cards.map((card) => card.getAttribute('data-participant'))).toEqual(['s-01', 's-02', 's-03']);
    const second = cards[1] as HTMLElement;
    expect(within(second).getByText('S02 бэкенд')).toBeTruthy();
    expect(within(second).getByText('needs you')).toBeTruthy();
    expect(within(second).getByText('Частичный возврат')).toBeTruthy();
    expect(second.getAttribute('title')).toBe('Claude Code · needs you');
    expect(cards[0]?.getAttribute('title')).toBe('Claude Code · working');
    expect(cards[2]?.getAttribute('title')).toBe('Codex · idle');
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
    fireEvent.click(document.querySelector('[data-participant="s-03"]') as HTMLElement);
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
    expect(within(messageRow('m-1')).getByText('note').className).toContain('bg-neutral-100');
    expect(messageRow('m-2').textContent).toContain('S03 ревью');
    expect(messageRow('m-2').textContent).toContain('→ S01 архитектор');
    expect(within(messageRow('m-2')).getByText('question').className).toContain('bg-accent-100');
    expect(messageRow('m-3').textContent).toContain('→ S02 бэкенд, S03 ревью');
    expect(within(messageRow('m-3')).getByText('decision').className).toContain('bg-accent-2-100');
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

  it('текст — pre-wrap: переносы и пробелы как в письме; разметка не разбирается', () => {
    renderPanel(entryOf({ messages: [message('m-1', { text: 'раз\n  два **не жирный**' })] }));
    const body = messageRow('m-1').querySelector('.whitespace-pre-wrap') as HTMLElement;
    expect(body.textContent).toBe('раз\n  два **не жирный**');
    expect(body.querySelector('strong')).toBeNull();
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
    expect(within(row).getByTitle('System')).toBeTruthy();
    expect(row.textContent).toContain('You accepted the decision');
    expect(row.textContent).not.toContain('→');
    expect(within(row).queryByRole('img', { name: 'New' })).toBeNull();
  });

  it('сообщение в 2000 знаков и слово без пробелов переносятся внутри колонки', () => {
    const word = 'Ы'.repeat(2000);
    renderPanel(entryOf({ messages: [message('m-1', { text: word })] }));
    const body = messageRow('m-1').querySelector('.whitespace-pre-wrap') as HTMLElement;
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
