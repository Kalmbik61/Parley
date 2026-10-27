/**
 * Вид острова: пилюля (без «×» и без подсказки первого показа), стрелка ⌃ внизу формы только под курсором и смахивание
 * вверх, пустая пилюля, список «в работе» (название работы, комнаты подзаголовком), строки Done
 * (ответ агента, время, Clear, пилюля `✅ N done`, комната `done`), карточка
 * разрешения и вопроса, стрелки очереди, «Open in Parley», пометки, отступ под чёлку, пауза
 * кнопок решения после показа карточки (таймеры подставные), перетаскивание за форму и курсоры, убранный остров
 * (форма сжимается в брусок или в `✅ N`, не уезжает), плавный размер формы (замер содержимого, переход, появление),
 * размеры текста; карточка согласия на папку встаёт раньше карточек ленты, но не раньше раскрытого помощника.
 */

import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { ConsentCard } from '@parley/protocol';
import type { IslandApi } from '../../shared/island.js';
import * as QuestionFormModule from './QuestionForm.js';
import { S } from '../../shared/strings.js';
import type { IslandModel } from './model.js';
import { useIslandReplies } from './replies.js';
import type { IslandRequest } from './requests.js';
import { SWIPE_UP_PX } from './drag.js';
import { HOST_IDLE } from './assistant/store.js';
import { CARD_ARM_MS, IslandView, type IslandAssistantProps, type IslandViewProps } from './IslandView.js';

const REF = { projectPath: '/tmp/proj', workId: 'w-1', sessionId: 's-02' };
const LABELS = new Map([['k', { session: 'S02 api', work: 'Backend', project: 'proj' }]]);

/** Поля `IslandConfig` для помощника и острова: в этих тестах помощник выключен. */
const ISLAND_BASE = {
  islandEnabled: true,
  assistant: { enabled: false, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null } },
};

function api(): IslandApi {
  return {
    visibility: vi.fn(), onVisibility: vi.fn(() => () => {}),
    config: vi.fn(), onConfig: vi.fn(), onHover: vi.fn(), setHitRect: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(),
    dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), markSeen: vi.fn(), failed: vi.fn(),
    keyboard: vi.fn(), onAssistantOpen: vi.fn(() => () => {}), onKeyboardBlur: vi.fn(() => () => {}),
    voice: { transcribe: vi.fn(), micStatus: vi.fn(), requestMic: vi.fn() },
  };
}

function permissionItem(patch: Partial<IslandRequest> = {}, suggestions: unknown[] = []): IslandRequest {
  const card = { id: 'c-1', at: '', kind: 'permission', cardId: 'c-1', state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, suggestions, notified: false } as unknown as FeedCard;
  return { key: 'k\u0000c-1', ref: REF, card, summary: 'Run: rm -rf build', inWindow: true, since: 1, deciding: false, note: null, ...patch };
}

function questionItem(options: string[]): IslandRequest {
  const card = {
    id: 'c-3', at: '', kind: 'question', cardId: 'c-3', state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {},
    questions: [{ question: 'Which DB?', header: null, multiSelect: false, options: options.map((label) => ({ label, description: null })) }],
  } as unknown as FeedCard;
  return permissionItem({ key: 'k\u0000c-3', card, summary: 'Question: Which DB?' });
}

function planItem(patch: Partial<IslandRequest> = {}, plan = 'Read the code\nChange the implementation'): IslandRequest {
  return permissionItem({ key: 'k\u0000p-1', summary: 'Plan', card: { kind: 'plan', id: 'p-1', cardId: 'p-1', state: 'pending', at: '', toolUseId: null, toolName: 'ExitPlanMode', toolInput: {}, plan, planFilePath: '/unread/plan.md' }, ...patch });
}

const MODEL: IslandModel = {
  working: 2, waiting: 1, done: 0, providers: ['claude'], active: true,
  groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: [
    { kind: 'session', key: 'k', ref: REF, label: 'S02 api', provider: 'claude', state: 'needs-you', inTerminal: true },
    { kind: 'room', key: 'r', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 1, done: false },
  ] }],
};

/** Ничего не идёт: пустая пилюля «No agents running». */
const IDLE_MODEL: IslandModel = { working: 0, waiting: 0, done: 0, providers: [], active: false, groups: [] };

const DONE_REF = { ...REF, sessionId: 's-05' };
const DONE_KEY = 'kd\u0000T';
const ENDED_AT = '2026-10-13T10:00:00.000Z';
const REPLY = 'Refactored the parser and updated three tests.';
/** Ничего не идёт, но один агент закончил ход, и их комната `done`: пилюля «✅ 1 done», в списке строка Done. */
const DONE_MODEL: IslandModel = {
  working: 0, waiting: 0, done: 1, providers: [], active: false,
  groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: [
    { kind: 'session', key: 'kd', ref: DONE_REF, label: 'S05 parser', provider: 'claude', state: 'done', inTerminal: false, doneKey: DONE_KEY, turnEndedAt: ENDED_AT, seen: false },
    { kind: 'room', key: 'rd', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 0, done: true },
  ] }],
};

function viewProps(patch: Partial<IslandViewProps> = {}): IslandViewProps {
  return {
    model: MODEL, items: [], index: 0, config: { ...ISLAND_BASE, sound: true, topInset: 0, anchor: 'center' }, listOpen: false, retracted: false, doneCount: 0, hovered: false, showId: 1,
    labels: LABELS, api: api(), shapeRef: createRef<HTMLDivElement>(), requestKeyboard: false, onTakeRequestKeyboard: vi.fn(),
    onDragStart: vi.fn(), onDragEnd: vi.fn(),
    onToggleList: vi.fn(), onHide: vi.fn(), onClearDone: vi.fn(), onSelect: vi.fn(), onDecide: vi.fn(),
    assistant: null,
    consent: null,
    ...patch,
  };
}

describe('selected progress detail', () => {
  it('opens one explicit session detail and preserves the existing session action', () => {
    const select = vi.fn(); const close = vi.fn();
    const progress = { selected: null, state: { kind: 'loading' as const }, onSelect: select, onClose: close };
    const props = viewProps({ listOpen: true, progress });
    const { rerender } = render(<IslandView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show recent actions' })); expect(select).toHaveBeenCalledWith(REF);
    expect(props.api.open).not.toHaveBeenCalled();
    rerender(<IslandView {...props} progress={{ ...progress, selected: REF }} />);
    expect(screen.getAllByTestId('island-progress')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open in Parley' }));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
    fireEvent.click(screen.getByRole('button', { name: 'Close history' })); expect(close).toHaveBeenCalledOnce();
    rerender(<IslandView {...props} progress={{ ...progress, selected: REF }} retracted />);
    expect(screen.queryByTestId('island-progress')).toBeNull();
  });
});

describe('subagents and room proposal badges', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), agentType: '<b>worker</b>', description: `Task ${index}`, background: true }));
  function childrenModel(items = tasks, total: number | null = 12, reported = 5): IslandModel {
    return { ...DONE_MODEL, active: true, subagents: Math.max(total ?? 0, reported), groups: DONE_MODEL.groups.map((group) => ({ ...group,
      rows: group.rows.map((row) => row.kind === 'session' ? { ...row, tasks: { items, total, reported } } : row),
    })) };
  }

  it('keeps one Done parent/reply, caps8 children, reports actual overflow independently and preserves keyed nodes', () => {
    useIslandReplies.setState({ texts: { [DONE_KEY]: REPLY } });
    const props = viewProps({ model: childrenModel(), listOpen: true });
    const { container, rerender } = render(<IslandView {...props} />);
    expect(screen.getAllByTestId('island-done')).toHaveLength(1);
    expect(screen.getByText(REPLY)).toBeTruthy(); expect(screen.getAllByTestId('island-subagent')).toHaveLength(8);
    expect(screen.getByText('+4 more')).toBeTruthy(); expect(screen.getByText('5 reported')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    const first = screen.getByText('Task 0').closest('li');
    rerender(<IslandView {...props} model={childrenModel([...tasks].reverse())} />);
    expect(screen.getByText('Task 0').closest('li')).toBe(first);
    rerender(<IslandView {...props} model={childrenModel(tasks.slice(0, 3), 3, 12)} />);
    expect(screen.getAllByTestId('island-subagent')).toHaveLength(3); expect(screen.queryByText('+9 more')).toBeNull();
    expect(screen.getByText('12 reported')).toBeTruthy();
    rerender(<IslandView {...props} model={childrenModel([], 0, 12)} />);
    expect(screen.getByText('No task details reported')).toBeTruthy();
    rerender(<IslandView {...props} model={childrenModel([], null, 12)} />);
    expect(screen.getByText('Task details unavailable')).toBeTruthy();
  });

  it('room waiting is a badge with current lead and Open room only, without proposal preview', () => {
    const model: IslandModel = { working: 0, waiting: 0, done: 0, providers: [], active: true, proposals: 1, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: [
      { kind: 'room', key: 'r', projectPath: '/p', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 0, done: false,
        proposal: { key: 'rev-key', kind: 'completion', lead: 's-02', leadLabel: 'S02 api' } },
    ] }] };
    Object.assign(model.groups[0]!.rows[0]!, { text: 'SECRET-proposal-preview' });
    const props = viewProps({ model, listOpen: true });
    render(<IslandView {...props} />);
    expect(screen.getByText('Waiting for you')).toBeTruthy(); expect(screen.getByText('Lead: S02 api')).toBeTruthy();
    expect(screen.queryByText('SECRET-proposal-preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open room' }).textContent).toBe('Open room');
    fireEvent.click(screen.getByRole('button', { name: 'Open room' }));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'room', projectPath: '/p', workId: 'w-1', roomId: 'r-1' });
    expect(props.onDecide).not.toHaveBeenCalled();
  });

  it('marks the selected room by proposal revision key', () => {
    const model: IslandModel = { ...MODEL, proposals: 1, groups: [{ ...MODEL.groups[0]!, rows: [
      { kind: 'room', key: 'room-row-key', projectPath: '/p', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 0, done: false,
        proposal: { key: 'proposal-rev-key', kind: 'completion', lead: 's-02', leadLabel: 'S02 api' } },
    ] }] };
    view({ model, listOpen: true, navigationKey: 'room:proposal-rev-key' });
    expect(screen.getByRole('button', { name: 'Open room' }).getAttribute('aria-current')).toBe('true');
  });
});

/** Проходит паузу `CARD_ARM_MS`: после неё кнопки решения нажимаются. */
function arm(): void {
  act(() => {
    vi.advanceTimersByTime(CARD_ARM_MS);
  });
}

/** Рисует вид; `armed: false` — без прохода паузы кнопок решения (тест самой паузы). */
function view(patch: Partial<IslandViewProps> = {}, armed = true): IslandViewProps {
  const props = viewProps(patch);
  render(<IslandView {...props} />);
  if (armed) arm();
  return props;
}

/** Колбэки подставного `ResizeObserver`: тест «шевелит» замер, вызывая их. */
let resizeCallbacks: Array<() => void> = [];

// jsdom не знает ResizeObserver — форма заводит его при монтировании, чтобы замерять содержимое.
class ResizeObserverStub {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T10:03:00.000Z'));
  useIslandReplies.setState({ texts: {} });
  resizeCallbacks = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('вид острова', () => {
  it('пилюля: только счётчики — ни «×», ни кнопок', () => {
    view();
    const pill = screen.getByTestId('island-pill');
    expect(pill.textContent).toContain('2 working · 1 waiting');
    expect(pill.textContent).not.toContain('×');
    expect(within(pill).queryByRole('button')).toBeNull();
  });

  it('пустая пилюля: «No agents running» вместо счётчиков, без «×», список не открывается', () => {
    view({ model: IDLE_MODEL, listOpen: true });
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    expect(screen.queryByTestId('island-counters')).toBeNull();
    expect(screen.queryByTestId('island-list')).toBeNull();
    expect(screen.getByTestId('island-pill').textContent).not.toContain('×');
  });

  it('строка пилюли по центру: при открытом списке содержимое шире, а пилюля не уезжает вбок', () => {
    view({ listOpen: true });
    const pill = screen.getByTestId('island-pill');
    expect(pill.className).toContain('justify-center');
    expect(screen.getByTestId('island-list').className).toContain('w-[400px]');
    expect(screen.getByTestId('island-list-scroll').className).toContain('max-h-[360px]');
  });

  it('клик по пилюле только открывает список — открытый наведением он не закрывает', () => {
    const props = view({ listOpen: true });
    // Счётчики — не кнопка: за кнопку остров не тащится, а это самое большое место пилюли.
    const counters = screen.getByTestId('island-counters');
    expect(counters.closest('button')).toBeNull();
    expect(within(screen.getByTestId('island-pill')).queryByRole('button', { name: /working/ })).toBeNull();
    fireEvent.click(counters);
    expect(props.onToggleList).toHaveBeenCalledWith(true);
    expect(props.onToggleList).not.toHaveBeenCalledWith(false);
  });

  it('пилюля не переносит строки — окно растёт по содержимому', () => {
    view();
    expect(screen.getByTestId('island-pill').className).toContain('whitespace-nowrap');
  });

  it('список: ждущая без карточки — «waiting in terminal», точка как в сайдбаре, клик по строке открывает её в Parley', () => {
    const props = view({ listOpen: true });
    expect(screen.getByText('waiting in terminal')).toBeTruthy();
    // Комната — подзаголовком работы, не строкой: точка одна, у сессии.
    expect(screen.getAllByTestId('agent-state-dot').map((dot) => dot.getAttribute('data-state'))).toEqual(['blocked']);
    fireEvent.click(screen.getByText('S02 api'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
  });

  it('список: комната работы — подзаголовок под названием («Refunds · 1 in work»), её имя открывает комнату', () => {
    const props = view({ listOpen: true });
    const room = screen.getByTestId('island-room');
    expect(room.textContent).toBe('Refunds· 1 in work');
    // Подзаголовок идёт сразу после названия работы и раньше строк сессий.
    const group = room.parentElement as HTMLElement;
    expect(Array.from(group.children).map((child) => child.getAttribute('data-testid') ?? child.tagName)).toEqual(['DIV', 'island-room', 'island-session']);
    fireEvent.click(within(room).getByRole('button', { name: 'Refunds' }));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'room', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1' });
  });

  it('список: несколько комнат работы — по строке подзаголовка на каждую; без комнат подзаголовка нет', () => {
    const rooms: IslandModel['groups'][number]['rows'] = [
      { kind: 'room', key: 'r1', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 2, done: false },
      { kind: 'room', key: 'r2', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-2', title: 'Billing', busy: 1, done: false },
    ];
    view({ listOpen: true, model: { ...MODEL, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: rooms }] } });
    expect(screen.getAllByTestId('island-room').map((line) => line.textContent)).toEqual(['Refunds· 2 in work', 'Billing· 1 in work']);
    cleanup();
    const sessionOnly = MODEL.groups[0]?.rows.filter((row) => row.kind === 'session') ?? [];
    view({ listOpen: true, model: { ...MODEL, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: sessionOnly }] } });
    expect(screen.queryByTestId('island-room')).toBeNull();
  });

  it('карточка разрешения: шапка без «×», суть, Allow и Deny; без правил — без Always', () => {
    const props = view({ items: [permissionItem()] });
    expect(screen.getByTestId('island-card').textContent).toContain('S02 api · Backend');
    expect(screen.getByTestId('island-card').textContent).not.toContain('×');
    expect(screen.queryByRole('button', { name: 'Tuck the island away' })).toBeNull();
    expect(screen.getByTitle('Run: rm -rf build')).toBeTruthy();
    expect(screen.queryByTestId('island-always')).toBeNull();
    fireEvent.click(screen.getByTestId('island-allow'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
    fireEvent.click(screen.getByTestId('island-deny'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'deny' });
  });

  it('правила есть — Always с подсказкой правил', () => {
    const props = view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }] }])] });
    expect(screen.getByTestId('island-always').getAttribute('title')).toBe('Bash(rm -rf build)');
    fireEvent.click(screen.getByTestId('island-always'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow', always: true });
  });

  it('вопрос выбирает вариант, но отправляется только явным Submit', () => {
    const props = view({ items: [questionItem(['Postgres', 'SQLite'])] });
    fireEvent.click(screen.getByRole('radio', { name: 'SQLite' }));
    expect(props.onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-3', { kind: 'question', answers: { 'Which DB?': 'SQLite' } });
  });

  it('дубликаты и пустые подписи дают объяснение и безопасный переход', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const props = view({ items: [questionItem(['Same', 'Same', '', ''])] });
      expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
      expect(screen.getByText('Open this question in Parley to answer it.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Open in Parley' }));
      expect(props.onDecide).not.toHaveBeenCalled();
      expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF, cardId: 'c-3' });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('несколько запросов — «1 of 2» и стрелки', () => {
    const props = view({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })], index: 0 });
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next request' }));
    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it('ответить из окна нельзя (Codex в терминале) или план — только Open in Parley с целью карточки', () => {
    const props = view({ items: [permissionItem({ inWindow: false })] });
    expect(screen.queryByTestId('island-allow')).toBeNull();
    fireEvent.click(screen.getByTestId('island-open'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
  });

  it('решается — кнопки выключены', () => {
    view({ items: [permissionItem({ deciding: true })] });
    expect((screen.getByTestId('island-allow') as HTMLButtonElement).disabled).toBe(true);
  });

  it('пометка «Answered elsewhere»', () => {
    view({ items: [permissionItem({ note: 'elsewhere' })] });
    expect(screen.getByText('Answered elsewhere')).toBeTruthy();
  });

  it('пометка «Couldn\'t send — try again»: кнопки снова нажимаются', () => {
    const props = view({ items: [permissionItem({ note: 'failed' })] });
    expect(screen.getByText("Couldn't send — try again")).toBeTruthy();
    fireEvent.click(screen.getByTestId('island-allow'));
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
  });

  it('подсказки первого показа нет; отступ под чёлку', () => {
    view({ config: { ...ISLAND_BASE, sound: true, topInset: 38, anchor: 'center' } });
    expect(screen.queryByText(/Drag me/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Got it' })).toBeNull();
    // Отступ под чёлку — на внутреннем содержимом, которое замеряется: внешняя форма лишь повторяет его размер.
    expect((screen.getByTestId('island-content') as HTMLElement).style.paddingTop).toBe('38px');
    expect((screen.getByTestId('island') as HTMLElement).style.paddingTop).toBe('');
  });
});

describe('стрелка ⌃ «убрать остров» и смахивание вверх', () => {
  /** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
  const pointer = (type: string, screenX: number, screenY: number, buttons = 1): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY, buttons });

  it('без наведения стрелки нет — ни у пилюли, ни у списка, ни у карточки', () => {
    for (const patch of [{}, { listOpen: true }, { items: [permissionItem()] }]) {
      view(patch);
      expect(screen.queryByTestId('island-tuck')).toBeNull();
      cleanup();
    }
  });

  it('курсор над островом: стрелка внизу содержимого — сразу после пилюли, списка или карточки; клик зовёт onHide', () => {
    const cases: Array<[string, Partial<IslandViewProps>, string]> = [
      ['пилюля', {}, 'island-pill'],
      ['список', { listOpen: true }, 'island-list'],
      ['карточка', { items: [permissionItem()] }, 'island-card'],
    ];
    for (const [name, patch, above] of cases) {
      const props = view({ ...patch, hovered: true });
      const arrow = screen.getByTestId('island-tuck');
      expect(screen.getByTestId('island-content').lastElementChild, name).toBe(arrow.parentElement);
      expect(arrow.parentElement?.previousElementSibling?.getAttribute('data-testid'), name).toBe(above);
      fireEvent.click(arrow);
      expect(props.onHide, name).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it('стрелка: ряд по центру с отступами pt-1.5 и pb-2, значок ChevronUp 18 px, зона не меньше 32×20, подпись и подсказка', () => {
    view({ hovered: true });
    const arrow = screen.getByTestId('island-tuck');
    expect(arrow.tagName).toBe('BUTTON');
    expect(arrow.getAttribute('aria-label')).toBe(S.island.tuckAway);
    expect(arrow.getAttribute('title')).toBe(S.island.tuckAway);
    const row = arrow.parentElement as HTMLElement;
    expect(row.className).toContain('flex');
    expect(row.className).toContain('justify-center');
    expect(row.className).toContain('pt-1.5');
    expect(row.className).toContain('pb-2');
    expect(arrow.className).toContain('h-5');
    expect(arrow.className).toContain('min-w-8');
    expect(arrow.className).toContain('cursor-pointer');
    const icon = arrow.querySelector('svg') as SVGElement;
    expect(icon.getAttribute('width')).toBe('18');
    expect(icon.getAttribute('height')).toBe('18');
  });

  it('остров убран — стрелки нет, даже если main ещё считает курсор над областью', () => {
    view({ hovered: true, retracted: true });
    expect(screen.queryByTestId('island-tuck')).toBeNull();
  });

  it('вверх по острову дальше SWIPE_UP_PX — onHide, перетаскивание не начинается', () => {
    const props = view();
    const pill = screen.getByTestId('island-pill');
    fireEvent(pill, pointer('pointerdown', 10, 100));
    fireEvent(pill, pointer('pointermove', 10, 100 - SWIPE_UP_PX));
    expect(props.onHide).toHaveBeenCalledTimes(1);
    fireEvent(pill, pointer('pointermove', 10, 0));
    fireEvent(pill, pointer('pointerup', 10, 0, 0));
    expect(props.onHide).toHaveBeenCalledTimes(1);
    expect(props.api.dragStart).not.toHaveBeenCalled();
    expect(props.onDragStart).not.toHaveBeenCalled();
    expect(props.api.dragEnd).not.toHaveBeenCalled();
    expect(props.onDragEnd).not.toHaveBeenCalled();
    expect(screen.getByTestId('island').className).toContain('cursor-grab');
    expect(screen.getByTestId('island').className).not.toContain('cursor-grabbing');
  });

  it('вверх по кнопке карточки или по самой стрелке — не смахивание', () => {
    const props = view({ items: [permissionItem()], hovered: true });
    for (const target of [screen.getByTestId('island-allow'), screen.getByTestId('island-tuck')]) {
      fireEvent(target, pointer('pointerdown', 10, 100));
      fireEvent(target, pointer('pointermove', 10, 0));
      fireEvent(target, pointer('pointerup', 10, 0, 0));
    }
    expect(props.onHide).not.toHaveBeenCalled();
  });
});

describe('Done на острове', () => {
  it('пилюля без работы: «✅ 1 done» вместо «No agents running», значков провайдеров нет, клик по счётчикам открывает список', () => {
    const props = view({ model: DONE_MODEL });
    const counters = screen.getByTestId('island-counters');
    expect(counters.textContent).toBe('✅ 1 done');
    expect(screen.queryByTestId('island-idle')).toBeNull();
    fireEvent.click(counters);
    expect(props.onToggleList).toHaveBeenCalledWith(true);
  });

  it('пилюля с работой и Done: «2 working · 1 waiting · ✅ 3 done»', () => {
    view({ model: { ...MODEL, done: 3 } });
    expect(screen.getByTestId('island-pill').textContent).toContain('2 working · 1 waiting · ✅ 3 done');
  });

  it('строка Done: точка unseen, имя, время конца хода, под ними ответ агента; клик открывает сессию', () => {
    useIslandReplies.setState({ texts: { [DONE_KEY]: REPLY } });
    const props = view({ model: DONE_MODEL, listOpen: true });
    const row = screen.getByTestId('island-done');
    expect(row.tagName).toBe('BUTTON');
    expect(within(row).getByTestId('agent-state-dot').getAttribute('data-state')).toBe('unseen');
    expect(within(row).getByText('S05 parser')).toBeTruthy();
    expect(within(row).getByText(S.time.minutes(3)).className).toContain('text-muted-foreground');
    const reply = within(row).getByText(REPLY);
    expect(reply.getAttribute('title')).toBe(REPLY);
    expect(reply.className).toContain('line-clamp-2');
    expect(reply.className).toContain('text-[13px]');
    expect(reply.className).toContain('text-foreground/75');
    fireEvent.click(row);
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: DONE_REF });
  });

  it('текста ответа нет (снимок не нашёл или ещё идёт) — строки ответа нет; времени конца хода нет — без времени', () => {
    useIslandReplies.setState({ texts: { [DONE_KEY]: null } });
    view({ model: DONE_MODEL, listOpen: true });
    const row = screen.getByTestId('island-done');
    expect(row.textContent).toBe('S05 parser' + S.time.minutes(3));
    cleanup();
    const [session, room] = DONE_MODEL.groups[0]?.rows ?? [];
    const rows = session?.kind === 'session' && session.state === 'done' && room !== undefined ? [{ ...session, turnEndedAt: null }, room] : [];
    view({ model: { ...DONE_MODEL, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows }] }, listOpen: true });
    expect(screen.getByTestId('island-done').textContent).toBe('S05 parser');
  });

  it('строки Done идут после строк в работе', () => {
    const [, room] = DONE_MODEL.groups[0]?.rows ?? [];
    const working = MODEL.groups[0]?.rows[0];
    const done = DONE_MODEL.groups[0]?.rows[0];
    const rows = working !== undefined && done !== undefined && room !== undefined ? [working, done, room] : [];
    view({ model: { ...MODEL, done: 1, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows }] }, listOpen: true });
    const list = screen.getByTestId('island-list');
    const labels = Array.from(list.querySelectorAll('button')).map((button) => button.textContent);
    expect(labels.findIndex((text) => text?.startsWith('S02 api'))).toBeLessThan(labels.findIndex((text) => text?.startsWith('S05 parser')));
  });

  it('комната: «Refunds · done», когда никто в ней не в работе; «· 1 in work», когда есть', () => {
    view({ model: DONE_MODEL, listOpen: true });
    expect(screen.getByTestId('island-room').textContent).toBe('Refunds· done');
    cleanup();
    view({ listOpen: true });
    expect(screen.getByTestId('island-room').textContent).toBe('Refunds· 1 in work');
  });

  it('Clear — под списком, вправо, вне прокрутки (стоит на месте); зовёт onClearDone; без Done кнопки нет', () => {
    const props = view({ model: DONE_MODEL, listOpen: true });
    const clear = screen.getByTestId('island-clear');
    expect(clear.textContent).toBe('Clear');
    expect(clear.className).toContain('text-muted-foreground');
    const scroll = screen.getByTestId('island-list-scroll');
    expect(scroll.className).toContain('overflow-y-auto');
    expect(scroll.contains(clear)).toBe(false);
    const row = screen.getByTestId('island-list').lastElementChild as HTMLElement;
    expect(row.contains(clear)).toBe(true);
    expect(row.className).toContain('justify-end');
    fireEvent.click(clear);
    expect(props.onClearDone).toHaveBeenCalledTimes(1);
    cleanup();
    view({ listOpen: true });
    expect(screen.queryByTestId('island-clear')).toBeNull();
  });
});

describe('плавный размер формы', () => {
  /** Подменяет размер, который jsdom не считает (там всегда 0): `offsetWidth` и `offsetHeight` содержимого. */
  function withOffsets(width: number, height: number, body: () => void): void {
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
    try {
      body();
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  }

  it('форма анимирует размер и облик: переход ширины, высоты, отступа, скругления и тени, у reduced motion перехода нет', () => {
    view();
    const shape = screen.getByTestId('island');
    expect(shape.className).toContain('transition-[width,height,margin-top,border-radius,box-shadow]');
    expect(shape.className).toContain('duration-[250ms]');
    expect(shape.className).toContain('ease-out');
    expect(shape.className).toContain('motion-reduce:transition-none');
    expect(shape.className).toContain('overflow-hidden');
    expect(shape.className).toContain('rounded-b-[22px]');
  });

  it('до первого замера у формы нет явного размера (нулевой замер jsdom не в счёт)', () => {
    view();
    const shape = screen.getByTestId('island') as HTMLElement;
    expect(shape.style.width).toBe('');
    expect(shape.style.height).toBe('');
  });

  it('форма берёт размер из замера содержимого в явных пикселях', () => {
    withOffsets(320, 64, () => {
      view();
      const shape = screen.getByTestId('island') as HTMLElement;
      expect(shape.style.width).toBe('320px');
      expect(shape.style.height).toBe('64px');
    });
  });

  it('ResizeObserver пересчитывает размер: список раздвигает форму', () => {
    const props = viewProps();
    const { rerender } = render(<IslandView {...props} />);
    const shape = screen.getByTestId('island') as HTMLElement;
    withOffsets(400, 220, () => {
      rerender(<IslandView {...props} listOpen />);
      act(() => {
        for (const callback of resizeCallbacks) callback();
      });
      expect(shape.style.width).toBe('400px');
      expect(shape.style.height).toBe('220px');
    });
  });

  it('содержимое замеряется по своему размеру, а не по размеру формы: оно w-max', () => {
    view();
    expect(screen.getByTestId('island-content').className).toContain('w-max');
  });

  it('форма доступна по ссылке, а наведение DOM-ом наверх не сообщается: его решает main', () => {
    const props = view();
    const shape = screen.getByTestId('island');
    expect(props.shapeRef).toHaveProperty('current', shape);
    fireEvent.mouseEnter(screen.getByTestId('island-pill'));
    fireEvent.mouseEnter(shape);
    fireEvent.mouseLeave(shape);
    expect(props.onToggleList).not.toHaveBeenCalled();
  });

  it('пилюля, список и карточка появляются с island-reveal', () => {
    view();
    expect(screen.getByTestId('island-pill').className).toContain('island-reveal');
    cleanup();
    view({ listOpen: true });
    expect(screen.getByTestId('island-list').className).toContain('island-reveal');
    cleanup();
    view({ items: [permissionItem()] });
    expect(screen.getByTestId('island-card').className).toContain('island-reveal');
  });

  it('другая карточка — новый элемент: появление проигрывается заново', () => {
    const props = viewProps({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })] });
    const { rerender } = render(<IslandView {...props} />);
    const first = screen.getByTestId('island-card');
    rerender(<IslandView {...props} index={1} />);
    expect(screen.getByTestId('island-card')).not.toBe(first);
  });
});

describe('размеры текста', () => {
  it('форма и пилюля — text-sm', () => {
    view();
    expect(screen.getByTestId('island').className).toContain('text-sm');
    expect(screen.getByTestId('island-pill').className).toContain('text-sm');
  });

  it('список: проект, «waiting in terminal» и подзаголовок с комнатами — text-[13px], название работы — размера списка', () => {
    view({ listOpen: true });
    expect(screen.getByTestId('island-list').className).toContain('text-sm');
    expect(screen.getByText('· proj').className).toContain('text-[13px]');
    expect(screen.getByText('Backend').className).not.toContain('text-[13px]');
    expect(screen.getByText('waiting in terminal').className).toContain('text-[13px]');
    const room = screen.getByTestId('island-room');
    expect(room.className).toContain('text-[13px]');
    expect(room.textContent).toContain(S.island.roomBusy(1));
  });

  it('карточка: ширина 440, шапка text-sm, проект и «1 of 2» text-[13px], суть — font-mono text-sm', () => {
    view({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })] });
    const card = screen.getByTestId('island-card');
    expect(card.className).toContain('w-[440px]');
    expect(card.className).toContain('text-sm');
    expect(screen.getByText('· proj', { exact: false }).className).toContain('text-[13px]');
    expect(screen.getByText('1 of 2').className).toContain('text-[13px]');
    const summary = screen.getByTitle('Run: rm -rf build');
    expect(summary.className).toContain('font-mono');
    expect(summary.className).toContain('text-sm');
  });

  it('кнопки действий — обычного размера с text-sm', () => {
    view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }])] });
    for (const id of ['island-allow', 'island-always', 'island-deny']) {
      const classes = screen.getByTestId(id).className;
      expect(classes, id).toContain('text-sm');
      expect(classes, id).toContain('h-9');
    }
    cleanup();
    view({ items: [questionItem(['Postgres'])] });
    expect(screen.getByRole('button', { name: 'Submit' }).className).toContain('h-9');
    cleanup();
    view({ items: [permissionItem({ inWindow: false })] });
    expect(screen.getByTestId('island-open').className).toContain('h-9');
    expect(screen.getByTestId('island-open').className).toContain('text-sm');
  });
});

describe('PlanView — проводка родителя', () => {
  it('full escaped plan stays readable, truncated has a transition and Change plan only opens an explicit terminal target', () => {
    const plan = '<img src="https://example.com" onerror="bad()">\nhttps://example.com\n' + 'x'.repeat(16000) + '\nEND';
    const item = planItem({}, plan);
    const props = view({ items: [{ ...item, card: { ...item.card!, truncated: true } as FeedCard }] });
    const body = screen.getByRole('region', { name: 'Plan' });
    expect(body.textContent).toBe(plan);
    expect(body.querySelector('a,img,script')).toBeNull();
    expect(body.className).not.toContain('line-clamp');
    expect(screen.getByText('Truncated')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change plan in terminal' }));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF, view: 'terminal' });
    expect(props.onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Parley' }));
    expect(props.api.open).toHaveBeenLastCalledWith({ kind: 'session', ref: REF, cardId: 'p-1' });
  });

  it.each([['Approve, auto-accept edits', 'auto-accept'], ['Approve, approve each edit', 'manual']])('%s sends only the existing %s choice after arming', (label, choice) => {
    const props = view({ items: [planItem()] }, false);
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); arm();
    fireEvent.click(button);
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000p-1', { kind: 'plan', choice });
    expect(props.onTakeRequestKeyboard).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('same plan card/new text rearms and resets owned focus before native %s', (key) => {
    const props = viewProps({ items: [planItem()], requestKeyboard: true });
    const root = render(<IslandView {...props} />); arm();
    act(() => screen.getByRole('button', { name: 'Approve, auto-accept edits' }).focus());
    root.rerender(<IslandView {...props} items={[planItem({}, 'New plan text')]} />);
    const button = screen.getByRole('button', { name: 'Approve, auto-accept edits' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('island-card')); arm();
    fireEvent.keyDown(document.activeElement!, { key }); expect(props.onDecide).not.toHaveBeenCalled();
    act(() => button.focus()); const allowed = fireEvent.keyDown(button, { key }); fireEvent.keyUp(button, { key });
    if (allowed && document.activeElement === button && !button.disabled) fireEvent.click(button, { detail: 0 });
    expect(props.onDecide).toHaveBeenCalledTimes(1);
  });

  it('terminal-only keeps plan readable without approvals; deciding/elsewhere disable and errors allow retry', () => {
    const props = viewProps({ items: [planItem({ inWindow: false })] });
    const root = render(<IslandView {...props} />); arm();
    expect(screen.getByRole('region', { name: 'Plan' }).textContent).toContain('Read the code');
    expect(screen.getByText('Approval is available in the terminal')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve, auto-accept edits' })).toBeNull();
    for (const patch of [{ deciding: true }, { note: 'elsewhere' as const }, { note: 'failed' as const }]) {
      root.rerender(<IslandView {...props} items={[planItem(patch)]} />); arm();
      expect((screen.getByRole('button', { name: 'Approve, auto-accept edits' }) as HTMLButtonElement).disabled).toBe(patch.note !== 'failed');
    }
  });

  it('measured chrome and notch bound the scroll body to remaining frame; text/scroll cannot drag', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.dataset.testid === 'island-card' ? 300 : this.getAttribute('role') === 'region' ? 200 : 0, width: 440 } as DOMRect;
    });
    vi.stubGlobal('innerHeight', 520);
    try {
      const props = view({ items: [planItem()], config: { ...viewProps().config, topInset: 180 } });
      const body = screen.getByRole('region', { name: 'Plan' });
      expect(body.style.maxHeight).toBe('190px');
      expect(screen.getByTestId('island-card').style.maxHeight).toBe('calc(100vh - 230px)');
      for (const [type, at] of [['pointerdown', 10], ['pointermove', 50], ['pointerup', 50]] as const) fireEvent(body, new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, screenX: at, screenY: at }));
      fireEvent.scroll(body);
      expect(props.api.dragStart).not.toHaveBeenCalled(); expect(props.onHide).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});

describe('пауза кнопок решения после показа запроса', () => {
  it('late controlled draft callback from a previous selected identity cannot overwrite the current draft', () => {
    const spy = vi.spyOn(QuestionFormModule, 'QuestionForm');
    try {
      const a = questionItem(['Postgres', 'SQLite']);
      const b = questionItem(['Postgres', 'SQLite']); b.key = 'other\u0000c-3'; b.ref = { ...REF, projectPath: '/other' };
      const props = viewProps({ items: [a, b] });
      const root = render(<IslandView {...props} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Postgres' }));
      const old = spy.mock.calls.at(-1)![0].onDraftChange;
      root.rerender(<IslandView {...props} index={1} />);
      act(() => old({ step: 0, picked: { 0: ['SQLite'] }, otherOn: {}, otherText: {} }));
      expect((screen.getByRole('radio', { name: 'SQLite' }) as HTMLInputElement).checked).toBe(false);
      root.rerender(<IslandView {...props} index={0} />);
      expect((screen.getByRole('radio', { name: 'Postgres' }) as HTMLInputElement).checked).toBe(false);
      act(() => old({ step: 0, picked: { 0: ['SQLite'] }, otherOn: {}, otherText: {} }));
      expect((screen.getByRole('radio', { name: 'SQLite' }) as HTMLInputElement).checked).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each(['Enter', ' '])('question reopen re-arms Submit and restores only container focus before native %s', (key) => {
    const props = viewProps({ items: [questionItem(['Postgres'])], requestKeyboard: true });
    const root = render(<IslandView {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Postgres' })); arm();
    const first = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    act(() => first.focus());
    root.rerender(<IslandView {...props} retracted />);
    root.rerender(<IslandView {...props} showId={props.showId + 1} />);
    const current = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(document.activeElement).toBe(screen.getByTestId('island-card'));
    expect(current.disabled).toBe(true); arm(); expect(current.disabled).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key });
    expect(props.onDecide).not.toHaveBeenCalled();
    act(() => current.focus());
    const allowed = fireEvent.keyDown(current, { key }); fireEvent.keyUp(current, { key });
    if (allowed && document.activeElement === current && !current.disabled) fireEvent.click(current, { detail: 0 });
    expect(props.onDecide).toHaveBeenCalledTimes(1);
  });

  it('question Submit mouse click does not take keyboard and unowned Enter cannot repeat it', () => {
    const props = view({ items: [questionItem(['Postgres'])], requestKeyboard: false });
    fireEvent.click(screen.getByRole('radio', { name: 'Postgres' }));
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    fireEvent(submit, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    act(() => submit.focus());
    fireEvent.click(submit, { detail: 1 });
    expect(props.onTakeRequestKeyboard).not.toHaveBeenCalled();
    expect(props.onDecide).toHaveBeenCalledTimes(1);
    const allowed = fireEvent.keyDown(submit, { key: 'Enter' });
    fireEvent.keyUp(submit, { key: 'Enter' });
    if (allowed && document.activeElement === submit && !submit.disabled) fireEvent.click(submit, { detail: 0 });
    expect(props.onDecide).toHaveBeenCalledTimes(1);
  });

  it('question body fits remaining frame and editing/selection/scroll never start dragging', () => {
    const props = view({ items: [questionItem(['Postgres'])], config: { ...viewProps().config, topInset: 80 } });
    const card = screen.getByTestId('island-card');
    expect(card.style.maxHeight).toBe('calc(100vh - 130px)');
    const body = screen.getByTestId('island-question-body');
    expect(body.className).toContain('overflow-y-auto');
    const pointer = (type: string, screenX: number, screenY: number): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY, buttons: 1 });
    fireEvent(body, pointer('pointerdown', 10, 10));
    fireEvent(body, pointer('pointermove', 50, 50));
    fireEvent(body, pointer('pointerup', 50, 50));
    fireEvent.scroll(body);
    expect(props.api.dragStart).not.toHaveBeenCalled();
    expect(props.onHide).not.toHaveBeenCalled();
  });
  it.each(['Enter', ' '])('same cardId/fingerprint: rearm и новый явный фокус перед native %j', (key) => {
    const first = permissionItem({ fingerprint: 'first' });
    const props = viewProps({ items: [first], requestKeyboard: true, onTakeRequestKeyboard: vi.fn() });
    const { rerender } = render(<IslandView {...props} />);
    arm();
    act(() => screen.getByTestId('island-allow').focus());
    rerender(<IslandView {...props} items={[{ ...first, fingerprint: 'second', summary: 'Run: changed' }]} />);
    expect((screen.getByTestId('island-allow') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('island-card'));
    arm();
    // jsdom не создаёт default click от клавиши: моделируем его только для реально сфокусированной кнопки.
    const activateFocused = (): void => {
      const target = document.activeElement;
      if (target instanceof HTMLButtonElement && !target.disabled && fireEvent.keyDown(target, { key })) {
        fireEvent.keyUp(target, { key });
        fireEvent.click(target, { detail: 0 });
      }
    };
    activateFocused();
    expect(props.onDecide).not.toHaveBeenCalled();
    act(() => screen.getByTestId('island-allow').focus());
    activateFocused();
    expect(props.onDecide).toHaveBeenCalledTimes(1);
  });

  it('fingerprint change без request owner не уводит внешний DOM focus и не берёт OS keyboard', () => {
    const first = permissionItem({ fingerprint: 'first' });
    const props = viewProps({ items: [first], requestKeyboard: false, onTakeRequestKeyboard: vi.fn() });
    const { rerender, container } = render(<IslandView {...props} />);
    const input = document.createElement('input');
    container.append(input);
    input.focus();
    arm();
    rerender(<IslandView {...props} items={[{ ...first, fingerprint: 'second' }]} />);
    expect(document.activeElement).toBe(input);
    expect((screen.getByTestId('island-allow') as HTMLButtonElement).disabled).toBe(true);
    expect(props.onTakeRequestKeyboard).not.toHaveBeenCalled();
    expect(props.api.keyboard).not.toHaveBeenCalled();
  });
  it('сразу после показа Allow выключен, через 500 мс нажимается и зовёт onDecide', () => {
    const props = view({ items: [permissionItem()] }, false);
    const allow = screen.getByTestId('island-allow') as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    fireEvent.click(allow);
    expect(props.onDecide).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(CARD_ARM_MS - 1);
    });
    expect(allow.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(allow.disabled).toBe(false);
    fireEvent.click(allow);
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-1', { kind: 'permission', behavior: 'allow' });
  });

  it('Always, Deny и варианты ответа тоже выключены до конца паузы', () => {
    view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }])] }, false);
    expect((screen.getByTestId('island-always') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('island-deny') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    view({ items: [questionItem(['Postgres', 'SQLite'])] }, false);
    fireEvent.click(screen.getByRole('radio', { name: 'Postgres' }));
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    arm();
    expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('«Open in Parley» и стрелки не защищены паузой', () => {
    const props = view({ items: [permissionItem({ inWindow: false }), permissionItem({ key: 'k\u0000c-2' })] }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Next request' }));
    expect(props.onSelect).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByTestId('island-open'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
  });

  it('возврат к прежней карточке снова ставит паузу — даже к той, что уже нажималась', () => {
    const props = viewProps({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })] });
    const { rerender } = render(<IslandView {...props} />);
    const allowDisabled = (): boolean => (screen.getByTestId('island-allow') as HTMLButtonElement).disabled;
    expect(allowDisabled()).toBe(true);
    arm();
    expect(allowDisabled()).toBe(false);
    rerender(<IslandView {...props} index={1} />);
    expect(allowDisabled()).toBe(true);
    arm();
    expect(allowDisabled()).toBe(false);
    rerender(<IslandView {...props} index={0} />);
    expect(allowDisabled()).toBe(true);
    arm();
    expect(allowDisabled()).toBe(false);
  });

  it('возврат раньше, чем взвелась соседняя карточка, тоже ставит паузу заново', () => {
    const props = viewProps({ items: [permissionItem(), permissionItem({ key: 'k\u0000c-2' })] });
    const { rerender } = render(<IslandView {...props} />);
    const allowDisabled = (): boolean => (screen.getByTestId('island-allow') as HTMLButtonElement).disabled;
    arm();
    rerender(<IslandView {...props} index={1} />);
    act(() => {
      vi.advanceTimersByTime(CARD_ARM_MS / 2);
    });
    rerender(<IslandView {...props} index={0} />);
    expect(allowDisabled()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CARD_ARM_MS - 1);
    });
    expect(allowDisabled()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(allowDisabled()).toBe(false);
  });

  it('новый показ острова (showId) снова ставит паузу той же карточке', () => {
    const props = viewProps({ items: [permissionItem()] });
    const { rerender } = render(<IslandView {...props} showId={1} />);
    const allowDisabled = (): boolean => (screen.getByTestId('island-allow') as HTMLButtonElement).disabled;
    arm();
    expect(allowDisabled()).toBe(false);
    rerender(<IslandView {...props} showId={2} />);
    expect(allowDisabled()).toBe(true);
    arm();
    expect(allowDisabled()).toBe(false);
  });
});

describe('цвета острова', () => {
  /** Рампа `neutral-*` переворачивается в тёмной теме (100 — самый тёмный): на чёрном острове такой текст невидим. */
  const NEUTRAL = /\b(text|bg|border)-neutral-\d/;
  /** Классы всех элементов вида; точка состояния — общий компонент сайдбара со своими проверенными токенами. */
  const classesOf = (): string[] =>
    Array.from(document.body.querySelectorAll('*')).filter((node) => node.closest('[data-testid="agent-state-dot"]') === null).map((node) => node.getAttribute('class') ?? '');

  const states: Array<[string, Partial<IslandViewProps>]> = [
    ['пилюля со стрелкой под курсором', { hovered: true }],
    ['список со стрелкой', { listOpen: true, hovered: true }],
    ['список', { listOpen: true }],
    ['пустая пилюля', { model: IDLE_MODEL }],
    ['список со строкой Done и Clear', { model: DONE_MODEL, listOpen: true }],
    ['остров убран (брусок)', { retracted: true }],
    ['остров убран (✅ N)', { retracted: true, doneCount: 2 }],
    ['карточка с очередью и пометками', { items: [permissionItem({ note: 'elsewhere' }), permissionItem({ key: 'k\u0000c-2', note: 'failed' })] }],
    ['карточка вопроса со стрелкой', { items: [questionItem(['Postgres', 'SQLite'])], hovered: true }],
    ['карточка с одной кнопкой Open in Parley', { items: [permissionItem({ inWindow: false })] }],
  ];

  it('ни в одном состоянии нет классов text-/bg-/border-neutral-N — только токены темы', () => {
    useIslandReplies.setState({ texts: { [DONE_KEY]: REPLY } });
    for (const [name, patch] of states) {
      view(patch);
      expect(classesOf().filter((classes) => NEUTRAL.test(classes)), name).toEqual([]);
      cleanup();
    }
  });

  it('текст острова — text-foreground, второстепенный — text-muted-foreground', () => {
    view({ items: [permissionItem()], hovered: true });
    expect(screen.getByTestId('island').className).toContain('text-foreground');
    const arrow = screen.getByTestId('island-tuck');
    expect(arrow.className).toContain('text-muted-foreground');
    expect(arrow.className).toContain('hover:text-foreground');
  });
});

describe('оформление списка', () => {
  it('название работы — жирное белое, проект рядом — мелкий приглушённый', () => {
    view({ listOpen: true });
    const title = screen.getByText('Backend');
    expect(title.className).toContain('font-semibold');
    expect(title.className).toContain('text-foreground');
    const project = screen.getByText('· proj');
    expect(project.className).toContain('text-muted-foreground');
    expect(project.className).not.toContain('font-semibold');
  });

  it('подзаголовок с комнатами — text-foreground/75; имя комнаты — курсор-рука и подчёркивание при наведении', () => {
    view({ listOpen: true });
    expect(screen.getByTestId('island-room').className).toContain('text-foreground/75');
    const name = screen.getByRole('button', { name: 'Refunds' });
    expect(name.className).toContain('cursor-pointer');
    expect(name.className).toContain('hover:underline');
  });

  it('строки сессий прежние: кнопка с точкой, подписью и пометкой, курсор-рука', () => {
    view({ listOpen: true });
    const row = screen.getByText('S02 api').closest('button') as HTMLElement;
    expect(row.className).toContain('cursor-pointer');
    expect(row.className).toContain('hover:bg-white/10');
    expect(within(row).getByTestId('agent-state-dot')).toBeTruthy();
    expect(within(row).getByText('waiting in terminal')).toBeTruthy();
  });
});

describe('убранный остров', () => {
  const INSET = 38;
  const config = { ...ISLAND_BASE, sound: true, topInset: INSET, anchor: 'center' as const };
  /** Единственный элемент в содержимом убранной формы: брусок или текст `✅ N`. */
  const only = (): HTMLElement => {
    const content = screen.getByTestId('island-content');
    expect(content.children).toHaveLength(1);
    return content.firstElementChild as HTMLElement;
  };

  it('на месте: форма не сдвинута и не прячется; скругление снизу 22 px, тень, чёрное под чёлкой', () => {
    view({ config });
    const shape = screen.getByTestId('island') as HTMLElement;
    expect(shape.getAttribute('data-retracted')).toBe('false');
    expect(shape.hasAttribute('aria-hidden')).toBe(false);
    expect(shape.className).toContain('rounded-b-[22px]');
    expect(shape.className).toContain('shadow-lg');
    expect(shape.className).not.toContain('ring-1');
    expect(shape.className).not.toContain('translate');
    expect(parseFloat(shape.style.marginTop)).toBe(0);
    expect((screen.getByTestId('island-content') as HTMLElement).style.paddingTop).toBe(`${INSET}px`);
  });

  it('обёртки со сдвигом нет: убранная форма не уезжает вверх за кадр', () => {
    view({ retracted: true });
    expect(screen.queryByTestId('island-slide')).toBeNull();
    expect(screen.getByTestId('island').className).not.toContain('translate');
    cleanup();
    view({ retracted: true, doneCount: 2 });
    expect(screen.getByTestId('island').className).not.toContain('translate');
  });

  it('убран без Done — брусок: пустой блок 40×5 со скруглением rounded-[3px] и светлой обводкой, без тени, под чёлкой и на 2 px ниже', () => {
    view({ config, retracted: true });
    const shape = screen.getByTestId('island') as HTMLElement;
    expect(shape.getAttribute('data-retracted')).toBe('true');
    // Скрытое от читалки экрана: форму читает зона нажатия (`IslandTab`).
    expect(shape.getAttribute('aria-hidden')).toBe('true');
    expect(shape.className).toContain('rounded-[3px]');
    expect(shape.className).not.toContain('rounded-b-');
    expect(shape.className).toContain('bg-black');
    expect(shape.className).toContain('ring-1');
    expect(shape.className).toContain('ring-white/50');
    // Тень у верхнего края кадра даёт серую полосу.
    expect(shape.className).toContain('shadow-none');
    expect(shape.className).not.toContain('shadow-lg');
    expect(shape.style.marginTop).toBe(`${INSET + 2}px`);
    expect((screen.getByTestId('island-content') as HTMLElement).style.paddingTop).toBe('0px');
    const bar = only();
    expect(bar.className).toContain('h-[5px]');
    expect(bar.className).toContain('w-10');
    expect(bar.textContent).toBe('');
    // Пилюли, списка и стрелки в убранной форме нет.
    expect(screen.queryByTestId('island-pill')).toBeNull();
    expect(screen.queryByTestId('island-tuck')).toBeNull();
  });

  it('убран с Done — выглядывает «✅ N»: текст внутри формы, скругление снизу 14 px, обводка, без тени, сразу под чёлкой', () => {
    view({ config, retracted: true, doneCount: 2 });
    const shape = screen.getByTestId('island') as HTMLElement;
    expect(shape.getAttribute('data-retracted')).toBe('true');
    expect(shape.getAttribute('aria-hidden')).toBe('true');
    expect(shape.textContent).toBe('✅ 2');
    expect(shape.className).toContain('rounded-b-[14px]');
    expect(shape.className).not.toContain('rounded-[3px]');
    expect(shape.className).toContain('bg-black');
    expect(shape.className).toContain('ring-1');
    expect(shape.className).toContain('ring-white/50');
    expect(shape.className).toContain('shadow-none');
    expect(shape.className).not.toContain('shadow-lg');
    expect(shape.style.marginTop).toBe(`${INSET}px`);
    expect((screen.getByTestId('island-content') as HTMLElement).style.paddingTop).toBe('0px');
    const peek = only();
    for (const name of ['whitespace-nowrap', 'px-3', 'py-1', 'text-sm']) expect(peek.className).toContain(name);
    expect(screen.queryByTestId('island-pill')).toBeNull();
  });

  it('выдвинули обратно: пилюля вместо бруска, отступ под чёлку снова внутри содержимого, облик как у стоящего на месте острова', () => {
    const props = viewProps({ config, retracted: true });
    const { rerender } = render(<IslandView {...props} />);
    rerender(<IslandView {...props} retracted={false} />);
    const shape = screen.getByTestId('island') as HTMLElement;
    expect(shape.getAttribute('data-retracted')).toBe('false');
    expect(shape.hasAttribute('aria-hidden')).toBe(false);
    expect(shape.className).toContain('rounded-b-[22px]');
    expect(shape.className).toContain('shadow-lg');
    expect(shape.className).not.toContain('ring-1');
    expect(parseFloat(shape.style.marginTop)).toBe(0);
    expect((screen.getByTestId('island-content') as HTMLElement).style.paddingTop).toBe(`${INSET}px`);
    expect(screen.getByTestId('island-pill').className).toContain('island-reveal');
  });

  it('форма — тот же элемент в обоих состояниях: размер из замера содержимого и ссылка на неё работают у убранной', () => {
    const props = viewProps({ retracted: true });
    const { rerender } = render(<IslandView {...props} />);
    const shape = screen.getByTestId('island');
    expect(props.shapeRef).toHaveProperty('current', shape);
    rerender(<IslandView {...props} retracted={false} />);
    expect(screen.getByTestId('island')).toBe(shape);
    expect(props.shapeRef).toHaveProperty('current', shape);
  });

  it('убранная форма берёт размер бруска из замера, а не прежний размер острова', () => {
    const props = viewProps();
    const { rerender } = render(<IslandView {...props} />);
    const shape = screen.getByTestId('island') as HTMLElement;
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(40);
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(5);
    try {
      rerender(<IslandView {...props} retracted />);
      act(() => {
        for (const callback of resizeCallbacks) callback();
      });
      expect(shape.style.width).toBe('40px');
      expect(shape.style.height).toBe('5px');
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });
});

describe('перетаскивание за форму и курсоры', () => {
  /** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
  const pointer = (type: string, screenX: number, screenY: number, buttons = 1): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY, buttons });

  it('форма — курсор-рука `grab`, кнопки и строки списка — `pointer`', () => {
    view({ listOpen: true });
    expect(screen.getByTestId('island').className).toContain('cursor-grab');
    expect(screen.getByTestId('island').className).not.toContain('cursor-grabbing');
    expect(screen.getByText('S02 api').closest('button')?.className).toContain('cursor-pointer');
  });

  it('кнопки карточки (решение, «Open in Parley», стрелки очереди, стрелка ⌃) — курсор `pointer`', () => {
    view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }]), permissionItem({ key: 'k\u0000c-2' })], hovered: true });
    for (const id of ['island-allow', 'island-always', 'island-deny', 'island-tuck']) expect(screen.getByTestId(id).className, id).toContain('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Next request' }).className).toContain('cursor-pointer');
    cleanup();
    view({ items: [permissionItem({ inWindow: false })] });
    expect(screen.getByTestId('island-open').className).toContain('cursor-pointer');
  });

  it('тащится за любое место, кроме кнопок: сдвиг по пилюле шлёт dragStart с точкой нажатия и dragMove, форма — `grabbing`', () => {
    const props = view();
    const shape = screen.getByTestId('island');
    const pill = screen.getByTestId('island-pill');
    fireEvent(pill, pointer('pointerdown', 10, 20));
    // Нажатие без сдвига — ещё не жест: клики по пилюле работают.
    expect(props.api.dragStart).not.toHaveBeenCalled();
    expect(props.onDragStart).not.toHaveBeenCalled();
    fireEvent(pill, pointer('pointermove', 30, 20));
    expect(props.api.dragStart).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
    expect(props.api.dragMove).toHaveBeenLastCalledWith({ screenX: 30, screenY: 20 });
    expect(props.onDragStart).toHaveBeenCalledTimes(1);
    expect(shape.className).toContain('cursor-grabbing');
    fireEvent(pill, pointer('pointerup', 31, 21, 0));
    expect(props.api.dragEnd).toHaveBeenCalledWith({ screenX: 31, screenY: 21 });
    expect(props.onDragEnd).toHaveBeenCalledTimes(1);
    expect(shape.className).toContain('cursor-grab');
    expect(shape.className).not.toContain('cursor-grabbing');
  });

  it('пустая пилюля и суть запроса в карточке тоже тащатся', () => {
    const props = view({ model: IDLE_MODEL });
    fireEvent(screen.getByTestId('island-idle'), pointer('pointerdown', 0, 0));
    fireEvent(screen.getByTestId('island-idle'), pointer('pointermove', 20, 0));
    expect(props.api.dragStart).toHaveBeenCalledTimes(1);
    cleanup();
    const card = view({ items: [permissionItem()] });
    fireEvent(screen.getByTitle('Run: rm -rf build'), pointer('pointerdown', 0, 0));
    fireEvent(screen.getByTitle('Run: rm -rf build'), pointer('pointermove', 20, 0));
    expect(card.api.dragStart).toHaveBeenCalledTimes(1);
  });

  it('нажатие на стрелке ⌃, на строке списка и на кнопке решения жест не начинает', () => {
    const props = view({ listOpen: true, hovered: true });
    for (const target of [screen.getByTestId('island-tuck'), screen.getByText('S02 api'), screen.getByRole('button', { name: 'Refunds' })]) {
      fireEvent(target, pointer('pointerdown', 0, 0));
      fireEvent(target, pointer('pointermove', 50, 0));
      fireEvent(target, pointer('pointerup', 50, 0, 0));
    }
    expect(props.api.dragStart).not.toHaveBeenCalled();
    cleanup();
    const card = view({ items: [permissionItem()] });
    const allow = screen.getByTestId('island-allow');
    fireEvent(allow, pointer('pointerdown', 0, 0));
    fireEvent(allow, pointer('pointermove', 50, 0));
    expect(card.api.dragStart).not.toHaveBeenCalled();
  });

  it('потеря захвата посреди жеста заканчивает его', () => {
    const props = view();
    const pill = screen.getByTestId('island-pill');
    fireEvent(pill, pointer('pointerdown', 0, 0));
    fireEvent(pill, pointer('pointermove', 20, 0));
    fireEvent(pill, pointer('lostpointercapture', 33, 44, 0));
    expect(props.api.dragEnd).toHaveBeenCalledWith({ screenX: 33, screenY: 44 });
    expect(props.onDragEnd).toHaveBeenCalledTimes(1);
  });
});

/** Помощник включён: пропсы большого вида пустые, нужные поля задаёт тест. */
function assistantProps(patch: Partial<IslandAssistantProps> = {}): IslandAssistantProps {
  return {
    view: {
      host: HOST_IDLE, input: 'idle', level: 0, draft: '', notice: null, cardError: null, sending: null, queue: [], history: [], deciding: null, hotkey: 'Alt+Space', pending: null,
      onDraft: vi.fn(), onSubmit: vi.fn(), onMic: vi.fn(), onDecide: vi.fn(), onUnqueue: vi.fn(), onShowRequests: vi.fn(),
    },
    open: false, collapsed: false, busy: false, mini: null, onOpen: vi.fn(),
    ...patch,
  };
}

describe('помощник на острове', () => {
  it('открыт и не свёрнут: виден большой вид, пилюли нет', () => {
    render(<IslandView {...viewProps({ assistant: assistantProps({ open: true }) })} />);
    expect(screen.getByTestId('assistant-view')).toBeTruthy();
    expect(screen.queryByTestId('island-pill')).toBeNull();
  });

  it('свёрнут и занят: пилюля с мини-подписью', () => {
    render(<IslandView {...viewProps({ assistant: assistantProps({ open: true, collapsed: true, busy: true, mini: 'Thinking·' }) })} />);
    expect(screen.queryByTestId('assistant-view')).toBeNull();
    expect(screen.getByTestId('assistant-mini').textContent).toBe('Thinking·');
  });

  it('помощник включён: в пилюле точка, клик зовёт onOpen; выключен — точки нет', () => {
    const assistant = assistantProps();
    render(<IslandView {...viewProps({ assistant })} />);
    expect(screen.getByTestId('assistant-dot').querySelector('[data-testid="swarm"]')?.getAttribute('data-shape')).toBe('dot');
    fireEvent.click(screen.getByTestId('assistant-dot'));
    expect(assistant.onOpen).toHaveBeenCalled();
    cleanup();
    render(<IslandView {...viewProps()} />);
    expect(screen.queryByTestId('assistant-dot')).toBeNull();
  });
});

describe('карточка согласия на острове', () => {
  const CONSENT: ConsentCard = {
    id: 'c-01', kind: 'folder-trust', folder: '/tmp/proj', projectPath: '/tmp/proj',
    requestedBy: { source: 'agent', sessionId: 's-03', label: 'S03 Ruslan' }, at: '2026-10-21T10:00:00.000Z', state: 'pending',
  };
  const consent = (patch: Partial<NonNullable<IslandViewProps['consent']>> = {}): NonNullable<IslandViewProps['consent']> => ({
    card: CONSENT, deciding: false, note: null, onDecide: vi.fn(), ...patch,
  });

  it.each(['Enter', ' '])('consent same id/new folder: rearm, container focus и явная native активация %j', (key) => {
    const c = consent();
    const props = viewProps({ consent: c, requestKeyboard: true });
    const { rerender } = render(<IslandView {...props} />);
    arm();
    act(() => screen.getByTestId('island-consent-trust').focus());
    rerender(<IslandView {...props} consent={{ ...c, card: { ...CONSENT, folder: '/tmp/changed' } }} />);
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('island-consent-request'));
    arm();
    fireEvent.keyDown(document.activeElement!, { key });
    expect(c.onDecide).not.toHaveBeenCalled();
    act(() => screen.getByTestId('island-consent-trust').focus());
    const target = document.activeElement as HTMLButtonElement;
    expect(target.disabled).toBe(false);
    if (fireEvent.keyDown(target, { key })) {
      fireEvent.keyUp(target, { key });
      fireEvent.click(target, { detail: 0 });
    }
    expect(c.onDecide).toHaveBeenCalledTimes(1);
    expect(c.onDecide).toHaveBeenCalledWith('c-01', 'allow');
  });

  it('consent metadata/state отправки не перевзводят; changed requestedBy перевзводит без захвата фокуса', () => {
    const c = consent();
    const props = viewProps({ consent: c });
    const { rerender, container } = render(<IslandView {...props} />);
    const input = document.createElement('input');
    container.append(input);
    input.focus();
    arm();
    rerender(<IslandView {...props} consent={{ ...c, deciding: true, note: 'failed', card: { ...CONSENT, at: '2026-10-27T10:00:00.000Z' } }} />);
    rerender(<IslandView {...props} consent={{ ...c, card: { ...CONSENT, at: '2026-10-27T10:00:00.000Z' } }} />);
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(false);
    rerender(<IslandView {...props} consent={{ ...c, card: { ...CONSENT, requestedBy: { source: 'launch' } } }} />);
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(props.onTakeRequestKeyboard).not.toHaveBeenCalled();
  });

  it('есть и ждущий запрос ленты, и согласие — показано согласие, запрос ждёт за ним', () => {
    view({ items: [permissionItem()], consent: consent() });
    expect(screen.getByText('Trust folder for agents?')).toBeTruthy();
    expect(screen.getByTestId('island-consent-trust')).toBeTruthy();
    expect(screen.queryByTestId('island-allow')).toBeNull();
    expect(screen.queryByTestId('island-pill')).toBeNull();
  });

  it('согласия нет — карточка ленты, как прежде', () => {
    view({ items: [permissionItem()], consent: null });
    expect(screen.getByTestId('island-allow')).toBeTruthy();
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
  });

  it('помощник раскрыт — вид помощника важнее согласия', () => {
    render(<IslandView {...viewProps({ consent: consent(), assistant: assistantProps({ open: true }) })} />);
    expect(screen.getByTestId('assistant-view')).toBeTruthy();
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
  });

  it('помощник свёрнут — согласие показано', () => {
    render(<IslandView {...viewProps({ consent: consent(), assistant: assistantProps({ open: true, collapsed: true, busy: true, mini: 'Thinking·' }) })} />);
    expect(screen.getByTestId('island-consent-trust')).toBeTruthy();
  });

  it('Trust зовёт onDecide(id, "allow") после паузы; убранный остров согласия не рисует', () => {
    const c = consent();
    view({ consent: c });
    fireEvent.click(screen.getByTestId('island-consent-trust'));
    expect(c.onDecide).toHaveBeenCalledWith('c-01', 'allow');
    cleanup();
    view({ consent: c, retracted: true, doneCount: 0 });
    expect(screen.queryByTestId('island-consent-trust')).toBeNull();
  });

  it('новый показ острова (showId) снова ставит паузу кнопок той же карточки', () => {
    const c = consent();
    const first = viewProps({ consent: c, showId: 1 });
    const { rerender } = render(<IslandView {...first} />);
    arm();
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(false);
    rerender(<IslandView {...first} showId={2} />);
    expect((screen.getByTestId('island-consent-trust') as HTMLButtonElement).disabled).toBe(true);
  });
});
