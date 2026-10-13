/**
 * Вид острова: пилюля и «×», пустая пилюля, список «в работе» (название работы, комнаты подзаголовком), карточка
 * разрешения и вопроса, стрелки очереди, «Open in Parley», пометки, подсказка первого показа и отступ под чёлку, пауза
 * кнопок решения после показа карточки (таймеры подставные), перетаскивание за форму и курсоры, убранный остров,
 * плавный размер формы (замер содержимого, переход, появление), размеры текста.
 */

import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { IslandApi } from '../../shared/island.js';
import { S } from '../../shared/strings.js';
import type { IslandModel } from './model.js';
import type { IslandRequest } from './requests.js';
import { CARD_ARM_MS, IslandView, type IslandViewProps } from './IslandView.js';

const REF = { projectPath: '/tmp/proj', workId: 'w-1', sessionId: 's-02' };
const LABELS = new Map([['k', { session: 'S02 api', work: 'Backend', project: 'proj' }]]);

function api(): IslandApi {
  return {
    config: vi.fn(), onConfig: vi.fn(), setInteractive: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(),
    dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(), failed: vi.fn(),
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

const MODEL: IslandModel = {
  working: 2, waiting: 1, providers: ['claude'], active: true,
  groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: [
    { kind: 'session', key: 'k', ref: REF, label: 'S02 api', provider: 'claude', state: 'needs-you', inTerminal: true },
    { kind: 'room', key: 'r', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 1 },
  ] }],
};

/** Ничего не идёт: пустая пилюля «No agents running». */
const IDLE_MODEL: IslandModel = { working: 0, waiting: 0, providers: [], active: false, groups: [] };

function viewProps(patch: Partial<IslandViewProps> = {}): IslandViewProps {
  return {
    model: MODEL, items: [], index: 0, config: { sound: true, hintShown: true, topInset: 0, anchor: 'center' }, listOpen: false, retracted: false, showId: 1,
    labels: LABELS, api: api(), shapeRef: createRef<HTMLDivElement>(),
    onShapeEnter: vi.fn(), onShapeLeave: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(),
    onToggleList: vi.fn(), onHide: vi.fn(), onSelect: vi.fn(), onDecide: vi.fn(), onHintDone: vi.fn(),
    ...patch,
  };
}

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
  resizeCallbacks = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('вид острова', () => {
  it('пилюля: счётчики и «×»', () => {
    const props = view();
    expect(screen.getByTestId('island-pill').textContent).toContain('2 working · 1 waiting');
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(props.onHide).toHaveBeenCalled();
  });

  it('пустая пилюля: «No agents running» вместо счётчиков, «×» на месте, список не открывается', () => {
    const props = view({ model: IDLE_MODEL, listOpen: true });
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    expect(screen.queryByTestId('island-counters')).toBeNull();
    expect(screen.queryByTestId('island-list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(props.onHide).toHaveBeenCalled();
  });

  it('строка пилюли по центру: при открытом списке содержимое шире, а пилюля не уезжает вбок', () => {
    view({ listOpen: true });
    const pill = screen.getByTestId('island-pill');
    expect(pill.className).toContain('justify-center');
    expect(screen.getByTestId('island-list').className).toContain('w-[400px]');
    expect(screen.getByTestId('island-list').className).toContain('max-h-[360px]');
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

  it('пилюля и подсказка не переносят строки — окно растёт по содержимому', () => {
    view({ config: { sound: true, hintShown: false, topInset: 0, anchor: 'center' } });
    expect(screen.getByTestId('island-pill').className).toContain('whitespace-nowrap');
    expect(screen.getByText('Drag me · × to hide · turn off in Settings').parentElement?.className).toContain('whitespace-nowrap');
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
    expect(Array.from(group.children).map((child) => child.getAttribute('data-testid') ?? child.tagName)).toEqual(['DIV', 'island-room', 'BUTTON']);
    fireEvent.click(within(room).getByRole('button', { name: 'Refunds' }));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'room', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1' });
  });

  it('список: несколько комнат работы — по строке подзаголовка на каждую; без комнат подзаголовка нет', () => {
    const rooms: IslandModel['groups'][number]['rows'] = [
      { kind: 'room', key: 'r1', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1', title: 'Refunds', busy: 2 },
      { kind: 'room', key: 'r2', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-2', title: 'Billing', busy: 1 },
    ];
    view({ listOpen: true, model: { ...MODEL, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: rooms }] } });
    expect(screen.getAllByTestId('island-room').map((line) => line.textContent)).toEqual(['Refunds· 2 in work', 'Billing· 1 in work']);
    cleanup();
    const sessionOnly = MODEL.groups[0]?.rows.filter((row) => row.kind === 'session') ?? [];
    view({ listOpen: true, model: { ...MODEL, groups: [{ key: 'g', title: 'Backend', project: 'proj', rows: sessionOnly }] } });
    expect(screen.queryByTestId('island-room')).toBeNull();
  });

  it('карточка разрешения: шапка, суть, Allow и Deny; без правил — без Always', () => {
    const props = view({ items: [permissionItem()] });
    expect(screen.getByTestId('island-card').textContent).toContain('S02 api · Backend');
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

  it('простой вопрос — кнопки вариантов, ответ по тексту вопроса', () => {
    const props = view({ items: [questionItem(['Postgres', 'SQLite'])] });
    const buttons = screen.getAllByTestId('island-option');
    expect(buttons.map((button) => button.textContent)).toEqual(['Postgres', 'SQLite']);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-3', { kind: 'question', answers: { 'Which DB?': 'SQLite' } });
  });

  it('варианты с одинаковой или пустой подписью — по кнопке на каждый, без предупреждения React о ключах', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const props = view({ items: [questionItem(['Same', 'Same', '', ''])] });
      const buttons = screen.getAllByTestId('island-option');
      expect(buttons.map((button) => button.textContent)).toEqual(['Same', 'Same', '', '']);
      fireEvent.click(buttons[1] as HTMLElement);
      expect(props.onDecide).toHaveBeenCalledWith('k\u0000c-3', { kind: 'question', answers: { 'Which DB?': 'Same' } });
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

  it('подсказка первого показа и отступ под чёлку', () => {
    const props = view({ config: { sound: true, hintShown: false, topInset: 38, anchor: 'center' } });
    expect(screen.getByText('Drag me · × to hide · turn off in Settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onHintDone).toHaveBeenCalled();
    // Отступ под чёлку — на внутреннем содержимом, которое замеряется: внешняя форма лишь повторяет его размер.
    expect((screen.getByTestId('island-content') as HTMLElement).style.paddingTop).toBe('38px');
    expect((screen.getByTestId('island') as HTMLElement).style.paddingTop).toBe('');
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

  it('форма анимирует размер: переход ширины и высоты, у reduced motion перехода нет', () => {
    view();
    const shape = screen.getByTestId('island');
    expect(shape.className).toContain('transition-[width,height]');
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

  it('мышь: вход в форму и уход с неё сообщаются наверх, форма доступна по ссылке', () => {
    const props = view();
    const shape = screen.getByTestId('island');
    expect(props.shapeRef).toHaveProperty('current', shape);
    fireEvent.mouseEnter(shape);
    expect(props.onShapeEnter).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(shape);
    expect(props.onShapeLeave).toHaveBeenCalledTimes(1);
  });

  it('список и карточка появляются с island-reveal', () => {
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
  it('форма и пилюля — text-sm, подсказка — text-xs', () => {
    view({ config: { sound: true, hintShown: false, topInset: 0, anchor: 'center' } });
    expect(screen.getByTestId('island').className).toContain('text-sm');
    expect(screen.getByTestId('island-pill').className).toContain('text-sm');
    expect(screen.getByText('Drag me · × to hide · turn off in Settings').parentElement?.className).toContain('text-xs');
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
    expect(screen.getByTestId('island-option').className).toContain('h-9');
    cleanup();
    view({ items: [permissionItem({ inWindow: false })] });
    expect(screen.getByTestId('island-open').className).toContain('h-9');
    expect(screen.getByTestId('island-open').className).toContain('text-sm');
  });
});

describe('пауза кнопок решения после показа запроса', () => {
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
    expect(screen.getAllByTestId('island-option').every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    arm();
    expect(screen.getAllByTestId('island-option').every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
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
    ['пилюля с подсказкой', { config: { sound: true, hintShown: false, topInset: 0, anchor: 'center' } }],
    ['список', { listOpen: true }],
    ['пустая пилюля', { model: IDLE_MODEL }],
    ['остров убран', { retracted: true }],
    ['карточка с очередью и пометками', { items: [permissionItem({ note: 'elsewhere' }), permissionItem({ key: 'k\u0000c-2', note: 'failed' })] }],
    ['карточка вопроса', { items: [questionItem(['Postgres', 'SQLite'])] }],
    ['карточка с одной кнопкой Open in Parley', { items: [permissionItem({ inWindow: false })] }],
  ];

  it('ни в одном состоянии нет классов text-/bg-/border-neutral-N — только токены темы', () => {
    for (const [name, patch] of states) {
      view(patch);
      expect(classesOf().filter((classes) => NEUTRAL.test(classes)), name).toEqual([]);
      cleanup();
    }
  });

  it('текст острова — text-foreground, второстепенный — text-muted-foreground', () => {
    view({ items: [permissionItem()] });
    expect(screen.getByTestId('island').className).toContain('text-foreground');
    expect(screen.getByRole('button', { name: 'Tuck the island away' }).className).toContain('text-muted-foreground');
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
  it('на месте: обёртка не сдвинута', () => {
    view();
    const slide = screen.getByTestId('island-slide');
    expect(slide.getAttribute('data-retracted')).toBe('false');
    expect(slide.className).not.toContain('-translate-y-');
    expect(slide.hasAttribute('aria-hidden')).toBe(false);
  });

  it('убран: обёртка уезжает вверх на свою высоту плюс 40 px, плавно; у reduced motion перехода нет', () => {
    view({ retracted: true });
    const slide = screen.getByTestId('island-slide');
    expect(slide.getAttribute('data-retracted')).toBe('true');
    expect(slide.className).toContain('-translate-y-[calc(100%_+_40px)]');
    expect(slide.className).toContain('transition-transform');
    expect(slide.className).toContain('duration-300');
    expect(slide.className).toContain('ease-out');
    expect(slide.className).toContain('motion-reduce:transition-none');
    // Скрытое за кадром читалка экрана не зачитывает.
    expect(slide.getAttribute('aria-hidden')).toBe('true');
    // Форма внутри сохраняет свой размерный переход: у размера и сдвига разная длительность.
    expect(screen.getByTestId('island').className).toContain('duration-[250ms]');
  });

  it('убран: у формы нет тени (иначе у верхнего края кадра серая полоса); на месте — shadow-lg', () => {
    view({ retracted: true });
    expect(screen.getByTestId('island').className).toContain('shadow-none');
    expect(screen.getByTestId('island').className).not.toContain('shadow-lg');
    cleanup();
    view();
    expect(screen.getByTestId('island').className).toContain('shadow-lg');
    expect(screen.getByTestId('island').className).not.toContain('shadow-none');
  });

  it('форма внутри обёртки: ссылка на неё и мышь работают, как у стоящего на месте острова', () => {
    const props = view({ retracted: true });
    expect(screen.getByTestId('island-slide').contains(screen.getByTestId('island'))).toBe(true);
    expect(props.shapeRef).toHaveProperty('current', screen.getByTestId('island'));
  });
});

describe('перетаскивание за форму и курсоры', () => {
  /** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
  const pointer = (type: string, screenX: number, screenY: number, buttons = 1): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY, buttons });

  it('форма — курсор-рука `grab`, кнопки и строки списка — `pointer`', () => {
    view({ listOpen: true });
    expect(screen.getByTestId('island').className).toContain('cursor-grab');
    expect(screen.getByTestId('island').className).not.toContain('cursor-grabbing');
    expect(screen.getByRole('button', { name: 'Tuck the island away' }).className).toContain('cursor-pointer');
    expect(screen.getByText('S02 api').closest('button')?.className).toContain('cursor-pointer');
  });

  it('кнопки карточки (решение, «Open in Parley», стрелки, «Got it») — курсор `pointer`', () => {
    view({ items: [permissionItem({}, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }]), permissionItem({ key: 'k\u0000c-2' })], config: { sound: true, hintShown: false, topInset: 0, anchor: 'center' } });
    for (const id of ['island-allow', 'island-always', 'island-deny']) expect(screen.getByTestId(id).className, id).toContain('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Next request' }).className).toContain('cursor-pointer');
    expect(screen.getByRole('button', { name: 'Got it' }).className).toContain('cursor-pointer');
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

  it('нажатие на «×», на строке списка и на кнопке решения жест не начинает', () => {
    const props = view({ listOpen: true });
    for (const target of [screen.getByRole('button', { name: 'Tuck the island away' }), screen.getByText('S02 api'), screen.getByRole('button', { name: 'Refunds' })]) {
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
