/**
 * Проводка острова на подставном мосту: новый запрос выбирается в карточке (а не остаётся прежний) и выдвигает убранный
 * остров, «×» убирает его (окно при этом остаётся видимым, пока хост подключён), покой в 4 с убирает сам, язычок
 * выдвигает остров кликом или потяжкой вниз, корень заполняет кадр окна и выравнивает форму по точке, окно ловит мышь
 * только над формой (и не отпускает её посреди перетаскивания). Где нужна цепочка «событие → снимок ленты → карточка»,
 * таймеры настоящие; отсчёт покоя идёт на подставных таймерах и на заранее заполненных сторах (без обмена с хостом).
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
import { IDLE_RETRACT_MS, IslandApp } from './IslandApp.js';
import { PULL_EXPAND_PX } from './IslandTab.js';
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

// jsdom не знает ResizeObserver — форма острова заводит его при монтировании, чтобы замерять содержимое.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function islandApi(config: Partial<IslandConfig> = {}): IslandApi {
  return {
    config: vi.fn(async (): Promise<IslandConfig> => ({ sound: false, hintShown: true, topInset: 0, anchor: 'center', ...config })),
    onConfig: vi.fn(() => () => undefined),
    setInteractive: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), open: vi.fn(), beep: vi.fn(), hintShown: vi.fn(), failed: vi.fn(),
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
  return { island, bridge, blocked, working, disconnect, reconnect };
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
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useIslandRequests.getState().clear();
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
    // Форма уехала из-под курсора: окно снова сквозное, мышь ловит только язычок.
    expect(island.setInteractive).toHaveBeenLastCalledWith(false);
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

  it('курсор над формой — окно ловит мышь, ушёл — снова сквозное, а список закрыт', async () => {
    const { island, bridge, working } = setup();
    render(<IslandApp bridge={bridge} />);
    working('s-01');
    await screen.findByText('1 working');
    const shape = screen.getByTestId('island');
    fireEvent.mouseEnter(screen.getByTestId('island-pill'));
    expect(island.setInteractive).toHaveBeenLastCalledWith(true);
    expect(screen.queryByTestId('island-list')).not.toBeNull();
    fireEvent.mouseLeave(shape);
    expect(island.setInteractive).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('island-list')).toBeNull();
  });

  describe('перетаскивание', () => {
    /** Нажимает на пилюле и уводит указатель дальше порога: жест идёт. */
    function startDrag(): HTMLElement {
      const pill = screen.getByTestId('island-pill');
      fireEvent(pill, pointer('pointerdown', 10, 20));
      fireEvent(pill, pointer('pointermove', 40, 20));
      return pill;
    }

    /** Остров с работой и открытым списком: курсор вошёл в форму. */
    async function openedList() {
      const rig = setup();
      render(<IslandApp bridge={rig.bridge} />);
      rig.working('s-01');
      await screen.findByText('1 working');
      fireEvent.mouseEnter(screen.getByTestId('island-pill'));
      return rig;
    }

    it('уход курсора с формы посреди жеста не делает окно сквозным и не закрывает список', async () => {
      const { island } = await openedList();
      startDrag();
      expect(island.dragStart).toHaveBeenCalledTimes(1);
      vi.mocked(island.setInteractive).mockClear();
      fireEvent.mouseLeave(screen.getByTestId('island'));
      expect(island.setInteractive).not.toHaveBeenCalled();
      expect(screen.queryByTestId('island-list')).not.toBeNull();
    });

    it('нажатие без сдвига за порог — не жест: уход курсора по-прежнему делает окно сквозным', async () => {
      const { island } = await openedList();
      fireEvent(screen.getByTestId('island-pill'), pointer('pointerdown', 10, 20));
      fireEvent(screen.getByTestId('island-pill'), pointer('pointermove', 12, 20));
      expect(island.dragStart).not.toHaveBeenCalled();
      vi.mocked(island.setInteractive).mockClear();
      fireEvent.mouseLeave(screen.getByTestId('island'));
      expect(island.setInteractive).toHaveBeenCalledWith(false);
      expect(screen.queryByTestId('island-list')).toBeNull();
    });

    it('после жеста курсор не над формой — окно снова сквозное и список закрыт', async () => {
      const { island } = await openedList();
      const pill = startDrag();
      fireEvent.mouseLeave(screen.getByTestId('island'));
      // jsdom не считает `:hover`: курсор «не над формой».
      fireEvent(pill, pointer('pointerup', 41, 20, 0));
      expect(island.dragEnd).toHaveBeenCalledWith({ screenX: 41, screenY: 20 });
      expect(island.setInteractive).toHaveBeenLastCalledWith(false);
      expect(screen.queryByTestId('island-list')).toBeNull();
    });

    it('после жеста курсор всё ещё над формой — окно остаётся интерактивным', async () => {
      const { island } = await openedList();
      const pill = startDrag();
      vi.mocked(island.setInteractive).mockClear();
      const original = Element.prototype.matches;
      const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        return selector === ':hover' ? true : original.call(this, selector);
      });
      try {
        fireEvent(pill, pointer('pointerup', 41, 20, 0));
      } finally {
        spy.mockRestore();
      }
      expect(island.setInteractive).not.toHaveBeenCalled();
    });

    it('жест закончен — следующий уход курсора снова делает окно сквозным', async () => {
      const { island } = await openedList();
      const pill = startDrag();
      fireEvent(pill, pointer('pointerup', 41, 20, 0));
      vi.mocked(island.setInteractive).mockClear();
      fireEvent.mouseLeave(screen.getByTestId('island'));
      expect(island.setInteractive).toHaveBeenCalledWith(false);
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

  it('наведение делает окно интерактивным, уход — сквозным', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    const tab = screen.getByTestId('island-tab');
    fireEvent.mouseEnter(tab);
    expect(island.setInteractive).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(tab);
    expect(island.setInteractive).toHaveBeenLastCalledWith(false);
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

  it('покой 4 с — остров убирается; за мгновение до срока ещё нет, окно сквозное и мышь ловит язычок', () => {
    const { island, bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
    expect(screen.getByTestId('island-tab')).toBeTruthy();
    expect(island.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it('курсор над формой посреди отсчёта — остров не убирается; ушёл — отсчёт заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    advance(IDLE_RETRACT_MS - 1000);
    fireEvent.mouseEnter(screen.getByTestId('island'));
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
    fireEvent.mouseLeave(screen.getByTestId('island'));
    advance(IDLE_RETRACT_MS - 1);
    expect(isRetracted()).toBe(false);
    advance(1);
    expect(isRetracted()).toBe(true);
  });

  it('форму тащат — остров не убирается; отпустили не над формой — отсчёт заново', () => {
    const { bridge } = setup();
    render(<IslandApp bridge={bridge} />);
    expand();
    const pill = screen.getByTestId('island-pill');
    fireEvent(pill, pointer('pointerdown', 10, 20));
    fireEvent(pill, pointer('pointermove', 40, 20));
    advance(IDLE_RETRACT_MS * 3);
    expect(isRetracted()).toBe(false);
    // jsdom не считает `:hover`: курсор «не над формой» — отпускание приравнено к уходу.
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
