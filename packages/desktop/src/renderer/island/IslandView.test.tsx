/**
 * Вид острова: пилюля и «×», список «в работе», карточка разрешения и вопроса, стрелки очереди, «Open in Parley»,
 * пометки, подсказка первого показа и отступ под чёлку, пауза кнопок решения после показа карточки (таймеры подставные),
 * ручка перетаскивания, плавный размер формы (замер содержимого, переход, появление), размеры текста.
 */

import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import type { IslandApi } from '../../shared/island.js';
import { S } from '../../shared/strings.js';
import type { IslandModel } from './model.js';
import type { IslandRequest } from './requests.js';
import { DragHandle } from './DragHandle.js';
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

function viewProps(patch: Partial<IslandViewProps> = {}): IslandViewProps {
  return {
    model: MODEL, items: [], index: 0, config: { sound: true, hintShown: true, topInset: 0, anchor: 'center' }, listOpen: false, showId: 1,
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
    fireEvent.click(screen.getByRole('button', { name: 'Hide until the next request' }));
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
    fireEvent.click(within(screen.getByTestId('island-pill')).getByRole('button', { name: /working/ }));
    expect(props.onToggleList).toHaveBeenCalledWith(true);
    expect(props.onToggleList).not.toHaveBeenCalledWith(false);
  });

  it('пилюля и подсказка не переносят строки — окно растёт по содержимому', () => {
    view({ config: { sound: true, hintShown: false, topInset: 0, anchor: 'center' } });
    expect(screen.getByTestId('island-pill').className).toContain('whitespace-nowrap');
    expect(screen.getByText('Drag me · × to hide · turn off in Settings').parentElement?.className).toContain('whitespace-nowrap');
  });

  it('список: ждущая без карточки — «waiting in terminal», точки как в сайдбаре, клик по строке открывает её в Parley', () => {
    const props = view({ listOpen: true });
    expect(screen.getByText('waiting in terminal')).toBeTruthy();
    expect(screen.getAllByTestId('agent-state-dot').map((dot) => dot.getAttribute('data-state'))).toEqual(['blocked', 'working']);
    fireEvent.click(screen.getByText('S02 api'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'session', ref: REF });
    fireEvent.click(screen.getByText('Refunds'));
    expect(props.api.open).toHaveBeenCalledWith({ kind: 'room', projectPath: '/tmp/proj', workId: 'w-1', roomId: 'r-1' });
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

  it('список: названия групп, «waiting in terminal» и счётчики комнат — text-[13px]', () => {
    view({ listOpen: true });
    expect(screen.getByTestId('island-list').className).toContain('text-sm');
    expect(screen.getByText('Backend', { exact: false }).className).toContain('text-[13px]');
    expect(screen.getByText('waiting in terminal').className).toContain('text-[13px]');
    expect(screen.getByText(S.island.roomBusy(1)).className).toContain('text-[13px]');
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
    expect(screen.getByRole('button', { name: 'Hide until the next request' }).className).toContain('text-muted-foreground');
    expect(screen.getByTestId('island-drag').className).toContain('text-muted-foreground');
  });
});

describe('ручка перетаскивания', () => {
  /** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
  const pointer = (type: string, screenX: number, screenY: number): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY });

  it('отпускание, отмена жеста и потеря захвата — каждое шлёт dragEnd с точкой своего события', () => {
    const props = view();
    const handle = screen.getByTestId('island-drag');
    fireEvent(handle, pointer('pointerup', 5, 6));
    expect(props.api.dragEnd).toHaveBeenLastCalledWith({ screenX: 5, screenY: 6 });
    fireEvent(handle, pointer('pointercancel', 11, 22));
    expect(props.api.dragEnd).toHaveBeenLastCalledWith({ screenX: 11, screenY: 22 });
    fireEvent(handle, pointer('lostpointercapture', 33, 44));
    expect(props.api.dragEnd).toHaveBeenLastCalledWith({ screenX: 33, screenY: 44 });
    expect(props.api.dragEnd).toHaveBeenCalledTimes(3);
  });

  it('начало и конец жеста сообщаются наверх вместе с вызовами моста', () => {
    const props = view();
    const handle = screen.getByTestId('island-drag');
    fireEvent(handle, pointer('pointerdown', 1, 2));
    expect(props.api.dragStart).toHaveBeenCalledWith({ screenX: 1, screenY: 2 });
    expect(props.onDragStart).toHaveBeenCalledTimes(1);
    expect(props.onDragEnd).not.toHaveBeenCalled();
    fireEvent(handle, pointer('pointerup', 5, 6));
    expect(props.api.dragEnd).toHaveBeenCalledWith({ screenX: 5, screenY: 6 });
    expect(props.onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('ручка работает и без колбэков жеста: они необязательные', () => {
    const handleApi = api();
    render(<DragHandle api={handleApi} />);
    const handle = screen.getByTestId('island-drag');
    fireEvent(handle, pointer('pointerdown', 1, 2));
    fireEvent(handle, pointer('pointerup', 3, 4));
    expect(handleApi.dragStart).toHaveBeenCalledTimes(1);
    expect(handleApi.dragEnd).toHaveBeenCalledTimes(1);
  });
});
