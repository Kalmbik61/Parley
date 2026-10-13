/**
 * Проводка острова на подставном мосту: новый запрос выбирается в карточке (а не остаётся прежний) и выдвигает убранный
 * остров, «×» убирает его (окно при этом остаётся видимым, пока хост подключён), покой в 4 с убирает сам, язычок
 * выдвигает остров кликом или потяжкой вниз, корень заполняет кадр окна и выравнивает форму по точке, наведение приходит
 * от main (`onHover`) и открывает список, а область под мышь (форма или язычок) уходит main и не повторяется. Где нужна
 * цепочка «событие → снимок ленты → карточка», таймеры настоящие; отсчёт покоя идёт на подставных таймерах и на заранее заполненных сторах (без обмена с хостом).
 * Строки Done: новый конец хода выдвигает остров (без звука), конец хода до подключения — нет, удержание `DONE_HOLD_MS`
 * вместо покоя, Clear прячет строки до нового конца хода. Показанная строка Done держится до конца показа: сессию отметили
 * просмотренной (`idle` с прежним концом хода) — строка остаётся, пока курсор не ушёл с острова или остров не убрался.
 * Пауза кнопок решения и анимация формы проверены в `IslandView.test.tsx`.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedCard } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { IslandApi, IslandBridge, IslandConfig } from '../../shared/island.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { DONE_HOLD_MS, IDLE_RETRACT_MS, IslandApp } from './IslandApp.js';
import { PULL_EXPAND_PX } from './IslandTab.js';
import { useIslandReplies } from './replies.js';
import { useIslandRequests } from './requests.js';

const PROJECT = '/tmp/proj';
const ref = (sessionId: string) => ({ projectPath: PROJECT, workId: 'w-1', sessionId });
const ENTRIES = [makeWork('w-1', { projectPath: PROJECT, sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b')] })];

function permission(cardId: string, command: string): FeedCard {
  return {
    id: cardId, at: '2026-10-12T10:00:00.000Z', kind: 'permission', cardId, state: 'pending', toolUseId: null,
    toolName: 'Bash', toolInput: { command }, suggestions: [], notified: false,
  };
}

const CARDS: Record<string, FeedCard[]> = { 's-01': [permission('c-1', 'rm -rf build')], 's-02': [permission('c-2', 'ls')] };

/** Колбэки живых подставных `ResizeObserver` и то, что они наблюдают: тест «шевелит» замер, вызывая последний колбэк. */
let resizeCallbacks: Array<() => void> = [];
let observed: Element[] = [];

// jsdom не знает ResizeObserver — форма острова заводит его при монтировании, чтобы замерять содержимое.
class ResizeObserverStub {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }
  observe(element: Element): void {
    observed.push(element);
  }
  unobserve(): void {}
  disconnect(): void {
    resizeCallbacks = resizeCallbacks.filter((callback) => callback !== this.callback);
  }
}

function islandApi(config: Partial<IslandConfig> = {}): IslandApi {
  return {
    config: vi.fn(async (): Promise<IslandConfig> => ({ sound: false, hintShown: true, topInset: 0, anchor: 'center', ...config })),
    onConfig: vi.fn(() => () => undefined),
    onHover: vi.fn(() => () => undefined), setHitRect: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(), failed: vi.fn(),
  };
}

/** Мост острова поверх подставного моста окна: хост «подключён», `works.list` и `feed.snapshot` отвечают из таблиц выше. */
function setup(config: Partial<IslandConfig> = {}) {
  const fake = createFakeBridge();
  fake.setHandler('works.list', () => ({ entries: ENTRIES, branches: {} }) as never);
  fake.setHandler('feed.snapshot', ({ ref: target }) => ({ items: CARDS[target.sessionId] ?? [], revision: 1, mode: null, decisions: 'window' }) as never);
  const island = islandApi(config);
  const bridge: IslandBridge = { call: fake.call, on: fake.on, onStatus: fake.onStatus, activitySnapshot: fake.activitySnapshot, island };
  const blocked = (sessionId: string): void => {
    act(() => {
      fake.emit('activity.changed', makeActivity(ref(sessionId), 'blocked'));
    });
  };
  const working = (sessionId: string): void => {
    act(() => {
      fake.emit('activity.changed', makeActivity(ref(sessionId), 'working'));
    });
  };
  const disconnect = (): void => {
    act(() => {
      fake.emitStatus({ state: 'disconnected', reason: 'host gone' });
    });
  };
  const reconnect = (): void => {
    act(() => {
      fake.emitStatus({ state: 'connected', hostVersion: '0.0.0-test', methods: [] });
    });
  };
  /** Main сообщает «курсор над областью острова» / «ушёл»: вызывает всех, кто подписан на `onHover`. */
  const hover = (over: boolean): void => {
    act(() => {
      for (const [listener] of vi.mocked(island.onHover).mock.calls) listener(over);
    });
  };
  return { island, bridge, blocked, working, disconnect, reconnect, hover };
}

/** Работа идёт к моменту открытия острова: сторы заполнены заранее, обмена с хостом ждать не надо. */
function seedWorking(): void {
  useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'working') }, loaded: true });
}

/** Работа кончилась: активности нет. */
function seedIdle(): void {
  useActivityStore.setState({ byRef: {}, loaded: true });
}

/** Событие указателя с точкой на экране: `MouseEvent` нужного типа — не зависит от того, знает ли jsdom `PointerEvent`. */
const pointer = (type: string, screenX = 10, screenY = 20, buttons = 1): MouseEvent => new MouseEvent(type, { bubbles: true, screenX, screenY, buttons });

const isRetracted = (): boolean => screen.getByTestId('island-slide').getAttribute('data-retracted') === 'true';
/** Выдвигает убранный остров кликом по язычку. */
const expand = (): void => {
  fireEvent.click(screen.getByTestId('island-tab'));
};

beforeEach(() => {
  resizeCallbacks = [];
  observed = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useIslandRequests.getState().clear();
  useIslandReplies.getState().prune(new Set());
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useActivityStore.setState({ byRef: {}, loaded: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('проводка острова', () => {
  it('новый запрос выбирается в карточке: прежний на экране не остаётся', async () => {
    const { bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    expect(await screen.findByTitle('Run: rm -rf build')).toBeTruthy();
    blocked('s-02');
    expect(await screen.findByTitle('Run: ls')).toBeTruthy();
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(useIslandRequests.getState().index).toBe(1);
  });

  it('новый запрос выдвигает убранный остров: язычок уходит, форма на месте', async () => {
    const { bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('«×» убирает остров, но окно остаётся видимым; новый запрос выдвигает его снова', async () => {
    const { island, bridge, blocked } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(isRetracted()).toBe(false));
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    vi.mocked(island.setVisible).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
    // Окно не прячется: убирается только то, что нарисовано.
    expect(island.setVisible).not.toHaveBeenCalled();
    blocked('s-02');
    await screen.findByTitle('Run: ls');
    await waitFor(() => expect(isRetracted()).toBe(false));
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('окно видно, пока хост подключён, даже в покое; хост отключился — окно спрятано, очередь пуста', async () => {
    const { island, bridge, blocked, disconnect, reconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    expect(isRetracted()).toBe(true);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    disconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(false));
    expect(useIslandRequests.getState().items).toEqual([]);
    reconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
  });

  it('после переподключения всё ещё ждущая карточка — новая: выдвигает убранный «×» остров', async () => {
    const { island, bridge, blocked, disconnect, reconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    blocked('s-01');
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(isRetracted()).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(isRetracted()).toBe(true);
    disconnect();
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(false));
    reconnect();
    await screen.findByTitle('Run: rm -rf build');
    await waitFor(() => expect(island.setVisible).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(isRetracted()).toBe(false));
  });

  it('корень заполняет кадр окна, а форма по умолчанию стоит по центру', () => {
    const { bridge } = setup();
    const { container } = render(<IslandApp bridge={bridge} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('inset-0');
    expect(root.className).toContain('flex');
    expect(root.className).toContain('items-start');
    expect(root.className).toContain('justify-center');
  });

  it('точка справа — форма прижата вправо кадра, слева — влево', async () => {
    const right = setup({ anchor: 'right' });
    const first = render(<IslandApp bridge={right.bridge} />);
    await waitFor(() => expect(first.container.firstElementChild?.className).toContain('justify-end'));
    first.unmount();
    const left = setup({ anchor: 'left' });
    const second = render(<IslandApp bridge={left.bridge} />);
    await waitFor(() => expect(second.container.firstElementChild?.className).toContain('justify-start'));
  });

  it('наведение приходит от main: над областью список открыт, ушёл — закрыт', async () => {
    const { bridge, working, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    working('s-01');
    await screen.findByText('1 working');
    expect(screen.queryByTestId('island-list')).toBeNull();
    hover(true);
    expect(screen.queryByTestId('island-list')).not.toBeNull();
    hover(false);
    expect(screen.queryByTestId('island-list')).toBeNull();
  });

  it('DOM-наведение остров не слушает: mouseenter и mouseleave по форме список не трогают', async () => {
    const { bridge, working } = setup();
    render(<IslandApp bridge={bridge} />);
    working('s-01');
    await screen.findByText('1 working');
    fireEvent.mouseEnter(screen.getByTestId('island-pill'));
    fireEvent.mouseEnter(screen.getByTestId('island'));
    expect(screen.queryByTestId('island-list')).toBeNull();
  });

  it('подписка на наведение снимается при размонтировании', () => {
    const { island, bridge } = setup();
    const off = vi.fn();
    vi.mocked(island.onHover).mockReturnValue(off);
    render(<IslandApp bridge={bridge} />).unmount();
    expect(island.onHover).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
  });

  describe('перетаскивание', () => {
    /** Нажимает на пилюле и уводит указатель дальше порога: жест идёт. */
    function startDrag(): HTMLElement {
      const pill = screen.getByTestId('island-pill');
      fireEvent(pill, pointer('pointerdown', 10, 20));
      fireEvent(pill, pointer('pointermove', 40, 20));
      return pill;
    }

    /** Остров с работой и открытым списком: main сообщил, что курсор над формой. */
    async function openedList() {
      const rig = setup();
      render(<IslandApp bridge={rig.bridge} />);
      rig.working('s-01');
      await screen.findByText('1 working');
      rig.hover(true);
      return rig;
    }

    it('жест уходит main: старт с точкой нажатия, отпускание с точкой отпускания; окно едет за курсором без участия renderer', async () => {
      const { island } = await openedList();
      const pill = startDrag();
      expect(island.dragStart).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
      expect(island.dragMove).toHaveBeenCalledWith({ screenX: 40, screenY: 20 });
      fireEvent(pill, pointer('pointerup', 41, 20, 0));
      expect(island.dragEnd).toHaveBeenCalledWith({ screenX: 41, screenY: 20 });
    });

    it('посреди жеста список остаётся открытым: main сообщает «над» и во время жеста', async () => {
      await openedList();
      startDrag();
      expect(screen.queryByTestId('island-list')).not.toBeNull();
    });

    it('после жеста main сообщает «вне» — список закрыт; сам renderer список по отпусканию не трогает', async () => {
      const { hover } = await openedList();
      const pill = startDrag();
      fireEvent(pill, pointer('pointerup', 41, 20, 0));
      expect(screen.queryByTestId('island-list')).not.toBeNull();
      hover(false);
      expect(screen.queryByTestId('island-list')).toBeNull();
    });

    it('нажатие без сдвига за порог — не жест', async () => {
      const { island } = await openedList();
      fireEvent(screen.getByTestId('island-pill'), pointer('pointerdown', 10, 20));
      fireEvent(screen.getByTestId('island-pill'), pointer('pointermove', 12, 20));
      expect(island.dragStart).not.toHaveBeenCalled();
    });

    it('нажатие на «×» остров не тащит: только убирает', async () => {
      const { island } = await openedList();
      const tuck = screen.getByRole('button', { name: 'Tuck the island away' });
      fireEvent(tuck, pointer('pointerdown', 10, 20));
      fireEvent(tuck, pointer('pointermove', 80, 20));
      fireEvent(tuck, pointer('pointerup', 80, 20, 0));
      expect(island.dragStart).not.toHaveBeenCalled();
    });
  });
});

describe('область под мышь', () => {
  const SHAPE = { x: 100, y: 0, width: 280, height: 40 };
  const TAB = { x: 208, y: 0, width: 64, height: 16 };
  /** Что вернёт `getBoundingClientRect` форме и язычку; тест меняет, как будто форма выросла или уехала. */
  let rects = { shape: SHAPE, tab: TAB };
  let spy: { mockRestore(): void } | null = null;

  beforeEach(() => {
    rects = { shape: SHAPE, tab: TAB };
    spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset.testid;
      // Язычок стоит там же, где форма: у правой точки кадра он правее.
      const shifted = this.parentElement?.className.includes('justify-end') === true ? 208 : 0;
      const rect = id === 'island' ? rects.shape : id === 'island-tab' ? { ...rects.tab, x: rects.tab.x + shifted } : { x: 0, y: 0, width: 0, height: 0 };
      return rect as DOMRect;
    });
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  /** Последний вызов `setHitRect`. */
  const lastRect = (island: IslandApi): unknown => vi.mocked(island.setHitRect).mock.calls.at(-1)?.[0];
  /** Наблюдатели замера пересчитали размер: вызывает последний живой колбэк. */
  const resized = (): void => {
    act(() => {
      resizeCallbacks.at(-1)?.();
    });
  };

  it('до подключения хоста область null, потом язычок убранного острова; хост отключился — снова null', () => {
    const { island, bridge, disconnect, reconnect } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(vi.mocked(island.setHitRect).mock.calls[0]).toEqual([null]);
    expect(lastRect(island)).toEqual(TAB);
    disconnect();
    expect(lastRect(island)).toBeNull();
    reconnect();
    expect(lastRect(island)).toEqual(TAB);
  });

  it('выдвинутый остров сообщает область формы, убранный — язычка', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    expect(lastRect(island)).toEqual(SHAPE);
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(lastRect(island)).toEqual(TAB);
  });

  it('форму и язычок замеряет ResizeObserver', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(observed).toContain(screen.getByTestId('island'));
    expect(observed).toContain(screen.getByTestId('island-tab'));
  });

  it('форма выросла — уходит новая область; равная прежней не повторяется', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    const before = vi.mocked(island.setHitRect).mock.calls.length;
    resized();
    resized();
    expect(vi.mocked(island.setHitRect).mock.calls).toHaveLength(before);
    rects.shape = { x: 40, y: 0, width: 400, height: 220 };
    resized();
    expect(lastRect(island)).toEqual({ x: 40, y: 0, width: 400, height: 220 });
    expect(vi.mocked(island.setHitRect).mock.calls).toHaveLength(before + 1);
    resized();
    expect(vi.mocked(island.setHitRect).mock.calls).toHaveLength(before + 1);
  });

  it('форма доехала до места (transitionend), размер при этом не менялся — область обновляется', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    // Начало выдвижения: форма ещё за кадром.
    rects.shape = { x: 100, y: -200, width: 280, height: 40 };
    fireEvent.transitionEnd(screen.getByTestId('island-slide'));
    expect(lastRect(island)).toEqual({ x: 100, y: -200, width: 280, height: 40 });
    rects.shape = SHAPE;
    fireEvent.transitionEnd(screen.getByTestId('island-slide'));
    expect(lastRect(island)).toEqual(SHAPE);
  });

  it('точка острова сменилась — область замеряется заново', async () => {
    const { island, bridge } = setup({ anchor: 'right' });
    render(<IslandApp bridge={bridge} />);
    await waitFor(() => expect(lastRect(island)).toEqual({ ...TAB, x: 416 }));
  });

  it('смена вида пересоздаёт наблюдателя: прежний отключён, новый следит за формой, а не за ушедшим язычком', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const before = resizeCallbacks.length;
    expand();
    // Язычок ушёл — остался один живой наблюдатель, а колбэк прежнего вида не сработает.
    expect(resizeCallbacks).toHaveLength(before);
    expect(observed.at(-1)).toBe(screen.getByTestId('island'));
  });
});

describe('язычок убранного острова', () => {
  it('в покое при открытии остров убран: форма за кадром, язычок «Show the island» на месте', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    const tab = screen.getByRole('button', { name: 'Show the island' });
    expect(tab).toBe(screen.getByTestId('island-tab'));
    // Чёрная полоска 40×5 со светлой обводкой (видна и на светлом фоне) и невидимой областью нажатия 64×16.
    expect(tab.className).toContain('w-16');
    expect(tab.className).toContain('h-4');
    const bar = tab.firstElementChild as HTMLElement;
    expect(bar.className).toContain('h-[5px]');
    expect(bar.className).toContain('w-10');
    expect(bar.className).toContain('rounded-full');
    expect(bar.className).toContain('bg-black');
    expect(bar.className).toContain('ring-1');
    expect(bar.className).toContain('ring-white/50');
  });

  it('язычок стоит там же, где форма: по точке и под чёлкой', async () => {
    const { bridge } = setup({ anchor: 'right', topInset: 38 });
    render(<IslandApp bridge={bridge} />);
    const wrapper = screen.getByTestId('island-tab').parentElement as HTMLElement;
    await waitFor(() => {
      expect(wrapper.className).toContain('justify-end');
      expect(wrapper.style.top).toBe('38px');
    });
  });

  it('клик выдвигает остров: язычок уходит, в покое пилюля «No agents running»', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('потяжка вниз дальше 8 px выдвигает остров; ровно 8 px, вверх и без нажатия — нет; окно при этом не тащится', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const tab = screen.getByTestId('island-tab');
    fireEvent(tab, pointer('pointermove', 100, 100));
    fireEvent(tab, pointer('pointermove', 100, 200));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointerdown', 100, 10));
    fireEvent(tab, pointer('pointermove', 100, 10 + PULL_EXPAND_PX));
    fireEvent(tab, pointer('pointermove', 100, 0));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointermove', 100, 10 + PULL_EXPAND_PX + 1));
    expect(isRetracted()).toBe(false);
    expect(island.dragStart).not.toHaveBeenCalled();
  });

  it('потяжка отпущена до порога — остров не выдвигается, а новое нажатие считает заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const tab = screen.getByTestId('island-tab');
    fireEvent(tab, pointer('pointerdown', 100, 10));
    fireEvent(tab, pointer('pointermove', 100, 14));
    fireEvent(tab, pointer('pointerup', 100, 14, 0));
    fireEvent(tab, pointer('pointermove', 100, 40));
    expect(isRetracted()).toBe(true);
    fireEvent(tab, pointer('pointerdown', 100, 30));
    fireEvent(tab, pointer('pointermove', 100, 40));
    expect(isRetracted()).toBe(false);
  });
});

describe('убирание острова в покое', () => {
  /** Подставные таймеры: четыре секунды покоя проходят за один вызов. */
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('покой 4 с — остров убирается; за мгновение до срока ещё нет', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
  });

  it('курсор над формой (по main) посреди отсчёта — остров не убирается; ушёл — отсчёт заново', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(IDLE_RETRACT_MS - 1000);
    hover(true);
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
    hover(false);
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('форму тащат — остров не убирается; отпустили — отсчёт заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    const pill = screen.getByTestId('island-pill');
    fireEvent(pill, pointer('pointerdown', 10, 20));
    fireEvent(pill, pointer('pointermove', 40, 20));
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
    fireEvent(pill, pointer('pointerup', 41, 20, 0));
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('работа идёт к открытию — остров на месте с первого кадра и не убирается', () => {
    seedWorking();
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(screen.getByTestId('island-pill').textContent).toContain('1 working');
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
  });

  it('работа кончилась — через 4 с остров убирается', () => {
    seedWorking();
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    advance(IDLE_RETRACT_MS * 2);
    act(seedIdle);
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('работа началась, пока остров убран, — он выдвигается сам', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    act(seedWorking);
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
  });

  it('«×» среди работы убирает остров, и сама по себе работа его не возвращает — только новая работа после покоя', () => {
    seedWorking();
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(isRetracted()).toBe(true);
    // Работа идёт и дальше (другое событие того же признака) — убранный остров остаётся убранным.
    act(() => {
      useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'working', { lastEventAt: '2026-09-27T09:05:00.000Z' }) } });
    });
    advance(IDLE_RETRACT_MS);
    expect(isRetracted()).toBe(true);
    // Покой и снова работа: признак сменился с нет на да.
    act(seedIdle);
    act(seedWorking);
    expect(isRetracted()).toBe(false);
  });

  it('«×» посреди отсчёта покоя убирает остров сразу', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(isRetracted()).toBe(true);
    // Отсчёт отменён: повторного убирания нет, язычок не мигает.
    advance(IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
  });
});

describe('Done на острове', () => {
  /** Момент подключения; конец хода не раньше него — свежий, раньше — остров застал его уже готовым. */
  const CONNECTED_AT = new Date('2026-10-13T10:00:00.000Z');
  const FRESH = '2026-10-13T10:00:05.000Z';
  const FRESHER = '2026-10-13T10:00:10.000Z';
  const STALE = '2026-10-13T09:59:00.000Z';

  /** Сессия s-01 закончила ход в `endedAt`: ждёт, пока на неё посмотрят в Parley. */
  function seedDone(endedAt: string): void {
    useWorksStore.setState({ entries: ENTRIES, branches: {}, loading: false, error: null });
    useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'unseen', { turnEndedAt: endedAt }) }, loaded: true });
  }
  /** Сессию s-01 посмотрели в Parley: хост перевёл её в idle, конец хода остался прежним. */
  function seedSeen(endedAt: string): void {
    useActivityStore.setState({ byRef: { [refKey(ref('s-01'))]: makeActivity(ref('s-01'), 'idle', { turnEndedAt: endedAt }) }, loaded: true });
  }
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CONNECTED_AT);
  });

  it('новый конец хода выдвигает убранный остров: в пилюле «✅ 1 done», язычка нет', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(false);
    expect(screen.queryByTestId('island-tab')).toBeNull();
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });

  it('выдвигает без звука, даже если Sound включён', async () => {
    const { island, bridge } = setup({ sound: true });
    render(<IslandApp bridge={bridge} />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(false);
    expect(island.beep).not.toHaveBeenCalled();
  });

  it('Done застали готовым (конец хода до подключения) — остров не выдвигается, язычок зелёный, в список строка попадает', () => {
    seedDone(STALE);
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Agents finished — show the island');
    expect(tab.title).toBe('Agents finished — show the island');
    expect((tab.firstElementChild as HTMLElement).className).toContain('bg-[var(--state-done)]');
    expect((tab.firstElementChild as HTMLElement).className).not.toContain('bg-black');
    expand();
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
  });

  it('конец хода раньше подключения, но пришедший после, тоже не выдвигает', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(STALE));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Agents finished — show the island');
  });

  it('с Done остров убирается через DONE_HOLD_MS, а не через IDLE_RETRACT_MS', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    advance(IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(false);
    advance(DONE_HOLD_MS - IDLE_RETRACT_MS * 2 - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Agents finished — show the island');
  });

  it('новый конец хода при выдвинутом острове заводит удержание заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    advance(DONE_HOLD_MS - 5000);
    act(() => seedDone(FRESHER));
    advance(DONE_HOLD_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('Clear прячет строки Done, пилюля снова «No agents running», язычок обычный; тот же конец хода не возвращается, новый — да', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    fireEvent.click(screen.getByTestId('island-clear'));
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.queryByTestId('island-clear')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
    // Done нет — покой обычный, 4 с.
    hover(false);
    advance(IDLE_RETRACT_MS);
    expect(isRetracted()).toBe(true);
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Show the island');
    expect((tab.firstElementChild as HTMLElement).className).toContain('bg-black');
    // Хост прислал ту же активность заново — тот же ключ, строка скрыта.
    act(() => seedDone(FRESH));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Show the island');
    // Новый конец хода — новый ключ: остров выдвигается.
    act(() => seedDone(FRESHER));
    expect(isRetracted()).toBe(false);
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });

  it('активность сессии пропала (конца хода нет) — строка уходит сама', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    act(seedIdle);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('показанную строку не убирает отметка «просмотрено» (idle, тот же конец хода): остаётся, пока курсор не ушёл с острова', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
    act(() => seedSeen(FRESH));
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    hover(false);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('удержанная строка не сокращает показ: остров убирается через DONE_HOLD_MS, и строка уходит вместе с ним', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    advance(IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(false);
    advance(DONE_HOLD_MS - IDLE_RETRACT_MS * 2);
    expect(isRetracted()).toBe(true);
    // Язычок обычный, не зелёный: Done больше нет.
    const tab = screen.getByTestId('island-tab');
    expect(tab.getAttribute('aria-label')).toBe('Show the island');
    expect((tab.firstElementChild as HTMLElement).className).toContain('bg-black');
    expand();
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('«×» тоже кончает показ: удержанная строка после него не возвращается', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    fireEvent.click(screen.getByRole('button', { name: 'Tuck the island away' }));
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab').getAttribute('aria-label')).toBe('Show the island');
    expand();
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
  });

  it('unseen после ухода курсора остаётся: уходят только просмотренные', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    hover(true);
    hover(false);
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
  });

  it('Done, что убранный остров застал готовым, не удерживается: просмотрели до выдвижения — после него строки нет', () => {
    seedDone(STALE);
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    expect(isRetracted()).toBe(true);
    act(() => seedSeen(STALE));
    expand();
    hover(true);
    expect(screen.queryByTestId('island-done')).toBeNull();
    expect(screen.getByTestId('island-idle').textContent).toBe('No agents running');
  });

  it('сессия заработала снова — удержание не нужно: строка в работе, потом новый конец хода — новая Done', () => {
    const { bridge, hover } = setup();
    render(<IslandApp bridge={bridge} />);
    act(() => seedDone(FRESH));
    act(() => seedSeen(FRESH));
    act(seedWorking);
    expect(screen.getByTestId('island-pill').textContent).toContain('1 working');
    expect(screen.getByTestId('island-pill').textContent).not.toContain('done');
    act(() => seedDone(FRESHER));
    hover(true);
    expect(screen.getByTestId('island-done')).toBeTruthy();
    expect(screen.getByTestId('island-counters').textContent).toBe('✅ 1 done');
  });
});

