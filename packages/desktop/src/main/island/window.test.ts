import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IslandHitRect } from '../../shared/island.js';
import type { DisplayLike, IslandPlacement, Rect } from './placement.js';
import { createIslandController, HOVER_POLL_MS, ISLAND_FRAME, islandWindowOptions, type IslandWindowLike } from './window.js';

const EXTERNAL: DisplayLike = { id: 3, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 25, width: 3440, height: 1415 }, internal: false };
const MACBOOK: DisplayLike = { id: 1, bounds: { x: 0, y: 1440, width: 1512, height: 982 }, workArea: { x: 0, y: 1478, width: 1512, height: 944 }, internal: true };

class FakeWindow implements IslandWindowLike {
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  destroyed = false;
  readonly calls: string[] = [];
  /** Вызовы `setIgnoreMouseEvents` по порядку: первый — начальный сквозной режим, остальные — опрос курсора и скрытие. */
  readonly mouseCalls: Array<[boolean, { forward: boolean }]> = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly webContents = {
    on: (event: string, listener: () => void) => this.add(`wc:${event}`, listener),
    send: vi.fn(),
  };
  setBounds(rect: Rect): void { this.bounds = rect; }
  getBounds(): Rect { return this.bounds; }
  setAlwaysOnTop(flag: boolean, level: string): void { this.calls.push(`top:${flag}:${level}`); }
  showInactive(): void { this.visible = true; this.calls.push('showInactive'); }
  hide(): void { this.visible = false; this.calls.push('hide'); }
  setIgnoreMouseEvents(ignore: boolean, options: { forward: boolean }): void { this.mouseCalls.push([ignore, options]); }
  readonly setFocusable = vi.fn((focusable: boolean): void => { this.calls.push(`focusable:${focusable}`); });
  readonly focus = vi.fn((): void => { this.calls.push('focus'); });
  isVisible(): boolean { return this.visible; }
  destroy(): void { this.destroyed = true; this.emit('closed'); }
  isDestroyed(): boolean { return this.destroyed; }
  on(event: 'closed' | 'blur', listener: () => void): void { this.add(event, listener); }
  emit(event: string): void { for (const listener of this.listeners.get(event) ?? []) listener(); }
  private add(event: string, listener: () => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
}

function setup(placement: IslandPlacement = { displayId: null, anchor: 'center' }) {
  const windows: FakeWindow[] = [];
  let saved = placement;
  let displays: DisplayLike[] = [EXTERNAL, MACBOOK];
  let cursor = { x: 0, y: 0 };
  const log = vi.fn();
  const onHover = vi.fn();
  const onKeyboardLost = vi.fn();
  const cursorSpy = vi.fn(() => cursor);
  const controller = createIslandController<FakeWindow>({
    createWindow: () => {
      const window = new FakeWindow();
      windows.push(window);
      return window;
    },
    displays: () => displays,
    primaryDisplayId: () => 3,
    placement: () => saved,
    savePlacement: (next) => { saved = next; },
    cursor: cursorSpy,
    onHover,
    onKeyboardLost,
    onCreated: vi.fn(),
    log,
  });
  return {
    controller, windows, log, onHover, onKeyboardLost, cursorSpy,
    setDisplays: (next: DisplayLike[]) => { displays = next; },
    setCursor: (next: { x: number; y: number }) => { cursor = next; },
    placement: () => saved,
  };
}

/** Кадр по центру внешнего монитора: окно в (1480, 0), размер 480×520. */
const FRAME_X = 1480;
/** Область формы в координатах окна: на экране это x 1580…1860, y 0…40. */
const SHAPE: IslandHitRect = { x: 100, y: 0, width: 280, height: 40 };
const INSIDE = { x: 1700, y: 20 };
const OUTSIDE = { x: 3000, y: 900 };

// Показанное окно опрашивает курсор по таймеру: таймеры подставные во всех тестах файла.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('окно острова', () => {
  it('параметры спайка: panel, без рамки, прозрачное, без активации, выше экрана можно', () => {
    const options = islandWindowOptions('/x/preload/island.js');
    expect(options).toMatchObject({
      type: 'panel', frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
      alwaysOnTop: true, acceptFirstMouse: true, focusable: false, skipTaskbar: true, hiddenInMissionControl: true,
      enableLargerThanScreen: true, show: false,
    });
    expect(options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false, preload: '/x/preload/island.js' });
  });

  it('кадр окна фиксированный: 480×520 в параметрах окна и в константе', () => {
    expect(ISLAND_FRAME).toEqual({ width: 480, height: 520 });
    expect(islandWindowOptions('/x/preload/island.js')).toMatchObject({ width: 480, height: 520 });
  });

  it('open: уровень поверх всего (без setVisibleOnAllWorkspaces — он меняет тип процесса), место по центру основного', () => {
    const { controller, windows } = setup();
    controller.open();
    expect(windows[0]?.calls).toEqual(['top:true:screen-saver']);
    expect(windows[0]?.bounds.y).toBe(0);
    controller.open();
    expect(windows).toHaveLength(1);
  });

  it('показ — только showInactive; повторный показ видимого окна ничего не делает', () => {
    const { controller, windows } = setup();
    controller.open();
    controller.setVisible(true);
    controller.setVisible(true);
    controller.setVisible(false);
    expect(windows[0]?.calls.filter((call) => call === 'showInactive' || call === 'hide')).toEqual(['showInactive', 'hide']);
  });

  it.each<[IslandPlacement['anchor'], number]>([
    ['left', 12],
    ['center', 1480],
    ['right', 3440 - 480 - 12],
  ])('окно всегда фиксированного кадра у своей точки (%s)', (anchor, x) => {
    const { controller, windows } = setup({ displayId: 3, anchor });
    controller.open();
    expect(windows[0]?.bounds).toEqual({ x, y: 0, width: 480, height: 520 });
  });

  it('перетаскивание: вдоль верхнего края, на другой монитор, прилипание и запись места', () => {
    const { controller, windows, placement } = setup();
    controller.open();
    controller.dragStart({ screenX: 1720, screenY: 10 });
    controller.dragMove({ screenX: 700, screenY: 1500 });
    expect(windows[0]?.bounds).toEqual({ x: 460, y: 1440, width: 480, height: 520 });
    controller.dragEnd({ screenX: 700, screenY: 1500 });
    expect(placement()).toEqual({ displayId: 1, anchor: 'center' });
    expect(windows[0]?.bounds).toEqual({ x: 516, y: 1440, width: 480, height: 520 });
    expect(controller.topInset()).toBe(38);
    expect(controller.anchor()).toBe('center');
  });

  it('anchor — текущая точка из настроек, после отпускания перетаскивания — новая', () => {
    const { controller } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    expect(controller.anchor()).toBe('right');
    controller.dragStart({ screenX: 3000, screenY: 10 });
    controller.dragEnd({ screenX: 100, screenY: 10 });
    expect(controller.anchor()).toBe('left');
  });

  it('close посреди перетаскивания сбрасывает жест: после нового open движение без drag-start окно не двигает', () => {
    const { controller, windows } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    controller.dragStart({ screenX: 1720, screenY: 10 });
    controller.close();
    controller.open();
    controller.dragMove({ screenX: 100, screenY: 10 });
    expect(windows[1]?.bounds).toEqual({ x: 3440 - 480 - 12, y: 0, width: 480, height: 520 });
  });

  it('скрытие посреди перетаскивания сбрасывает жест: потерянный drag-end не замораживает место', () => {
    const { controller, windows } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    controller.dragStart({ screenX: 3000, screenY: 10 });
    controller.setVisible(false);
    controller.setVisible(true);
    controller.dragMove({ screenX: 100, screenY: 10 });
    expect(windows[0]?.bounds).toEqual({ x: 3440 - 480 - 12, y: 0, width: 480, height: 520 });
  });

  it('relayout посреди перетаскивания сбрасывает жест', () => {
    const { controller, windows } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    controller.dragStart({ screenX: 3000, screenY: 10 });
    controller.relayout();
    controller.dragMove({ screenX: 100, screenY: 10 });
    expect(windows[0]?.bounds).toEqual({ x: 3440 - 480 - 12, y: 0, width: 480, height: 520 });
  });

  it('монитор пропал — relayout переносит остров на основной', () => {
    const { controller, windows, setDisplays } = setup({ displayId: 1, anchor: 'center' });
    controller.open();
    expect(windows[0]?.bounds).toEqual({ x: 516, y: 1440, width: 480, height: 520 });
    setDisplays([EXTERNAL]);
    controller.relayout();
    expect(windows[0]?.bounds).toEqual({ x: 1480, y: 0, width: 480, height: 520 });
  });

  it('open: окно сразу сквозное для мыши, без пересылки движений и без опроса, пока оно скрыто', () => {
    const { controller, windows, cursorSpy } = setup();
    controller.open();
    expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }]]);
    vi.advanceTimersByTime(HOVER_POLL_MS * 5);
    expect(cursorSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('setHitRect без окна не падает; после close старое окно не трогается', () => {
    const { controller, windows } = setup();
    expect(() => controller.setHitRect(SHAPE)).not.toThrow();
    controller.open();
    controller.close();
    controller.setHitRect(SHAPE);
    expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }]]);
  });

  it('isIsland — только webContents живого окна острова', () => {
    const { controller, windows } = setup();
    expect(controller.isIsland({})).toBe(false);
    controller.open();
    expect(controller.isIsland(windows[0]?.webContents)).toBe(true);
    expect(controller.isIsland({})).toBe(false);
    controller.close();
    expect(controller.isIsland(windows[0]?.webContents)).toBe(false);
  });

  it('renderer упал — одно пересоздание и запись в лог; второе падение — окна нет', () => {
    const { controller, windows, log } = setup();
    controller.open();
    windows[0]?.emit('wc:render-process-gone');
    expect(windows).toHaveLength(2);
    expect(controller.current()).toBe(windows[1]);
    windows[1]?.emit('wc:render-process-gone');
    expect(windows).toHaveLength(2);
    expect(controller.current()).toBeNull();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('после падения renderer пересозданное окно снова сквозное и без области, даже если упавшее ловило мышь', () => {
    const { controller, windows, setCursor } = setup();
    controller.open();
    controller.setHitRect(SHAPE);
    controller.setVisible(true);
    setCursor(INSIDE);
    vi.advanceTimersByTime(HOVER_POLL_MS);
    expect(windows[0]?.mouseCalls.at(-1)).toEqual([false, { forward: false }]);
    windows[0]?.emit('wc:render-process-gone');
    expect(windows[1]?.mouseCalls).toEqual([[true, { forward: false }]]);
    // Область прежнего renderer новому окну не принадлежит: пока он не пришлёт свою, курсор «вне».
    controller.setVisible(true);
    vi.advanceTimersByTime(HOVER_POLL_MS * 3);
    expect(windows[1]?.mouseCalls).toEqual([[true, { forward: false }]]);
  });

  describe('клавиатура помощника', () => {
    it('setKeyboard(true): окно становится фокусируемым и берёт фокус', () => {
      const { controller, windows } = setup();
      controller.open();
      controller.setVisible(true);
      controller.setKeyboard(true);
      expect(windows[0]?.setFocusable).toHaveBeenCalledWith(true);
      expect(windows[0]?.focus).toHaveBeenCalledTimes(1);
    });

    it('setKeyboard(false) у видимого окна: setFocusable(false), затем hide и showInactive', () => {
      const { controller, windows } = setup();
      controller.open();
      controller.setVisible(true);
      controller.setKeyboard(true);
      windows[0]?.calls.splice(0);
      controller.setKeyboard(false);
      expect(windows[0]?.calls).toEqual(['focusable:false', 'hide', 'showInactive']);
      expect(windows[0]?.visible).toBe(true);
    });

    it('setKeyboard(false) у скрытого окна: только setFocusable(false)', () => {
      const { controller, windows } = setup();
      controller.open();
      windows[0]?.calls.splice(0);
      controller.setKeyboard(false);
      expect(windows[0]?.calls).toEqual(['focusable:false']);
    });

    it('blur после setKeyboard(true) зовёт onKeyboardLost один раз, второй blur подряд — нет', () => {
      const { controller, windows, onKeyboardLost } = setup();
      controller.open();
      controller.setVisible(true);
      controller.setKeyboard(true);
      windows[0]?.emit('blur');
      expect(onKeyboardLost).toHaveBeenCalledTimes(1);
      windows[0]?.emit('blur');
      expect(onKeyboardLost).toHaveBeenCalledTimes(1);
    });

    it('blur без взятой клавиатуры и blur сразу после setKeyboard(false) onKeyboardLost не зовут', () => {
      const { controller, windows, onKeyboardLost } = setup();
      controller.open();
      controller.setVisible(true);
      windows[0]?.emit('blur');
      controller.setKeyboard(true);
      controller.setKeyboard(false);
      windows[0]?.emit('blur');
      expect(onKeyboardLost).not.toHaveBeenCalled();
    });
  });

  describe('наведение по настоящему курсору', () => {
    /** Остров показан, область формы известна, курсор вне неё. */
    function shown(placement?: IslandPlacement) {
      const rig = setup(placement ?? { displayId: 3, anchor: 'center' });
      rig.controller.open();
      rig.controller.setHitRect(SHAPE);
      rig.controller.setVisible(true);
      rig.setCursor(OUTSIDE);
      return rig;
    }

    it('курсор над областью — окно ловит мышь и renderer узнаёт об этом один раз', () => {
      const { windows, onHover, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS - 1);
      expect(onHover).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }], [false, { forward: false }]]);
      expect(onHover.mock.calls).toEqual([[true]]);
    });

    it('курсор ушёл — окно снова сквозное, renderer узнаёт об уходе', () => {
      const { windows, onHover, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      setCursor(OUTSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }], [false, { forward: false }], [true, { forward: false }]]);
      expect(onHover.mock.calls).toEqual([[true], [false]]);
    });

    it('пока состояние то же, повторных вызовов нет: ни вне области, ни над ней', () => {
      const { windows, onHover, setCursor } = shown();
      vi.advanceTimersByTime(HOVER_POLL_MS * 5);
      expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }]]);
      expect(onHover).not.toHaveBeenCalled();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS * 5);
      setCursor({ x: 1750, y: 30 });
      vi.advanceTimersByTime(HOVER_POLL_MS * 5);
      expect(windows[0]?.mouseCalls).toHaveLength(2);
      expect(onHover).toHaveBeenCalledTimes(1);
    });

    it.each<[string, { x: number; y: number }, boolean]>([
      ['левый верхний угол — внутри', { x: 1580, y: 0 }, true],
      ['правее правого края — вне', { x: 1860, y: 20 }, false],
      ['ниже нижнего края — вне', { x: 1700, y: 40 }, false],
      ['левее левого края — вне', { x: 1579, y: 20 }, false],
      ['выше верха кадра — вне', { x: 1700, y: -1 }, false],
    ])('граница области: %s', (_name, point, inside) => {
      const { onHover, setCursor } = shown();
      setCursor(point);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(onHover.mock.calls).toEqual(inside ? [[true]] : []);
    });

    it('область — в координатах окна: сдвиг окна сдвигает и её', () => {
      const { controller, windows, onHover, setCursor, setDisplays } = shown({ displayId: 1, anchor: 'center' });
      // Окно на втором мониторе: (516, 1440). Курсор на прежнем месте над первым монитором — уже вне области.
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(onHover).not.toHaveBeenCalled();
      setCursor({ x: 516 + 100 + 10, y: 1440 + 10 });
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(onHover.mock.calls).toEqual([[true]]);
      // Монитор пропал — окно переехало на основной, прежняя точка экрана снова вне области.
      setDisplays([EXTERNAL]);
      controller.relayout();
      expect(windows[0]?.bounds.x).toBe(FRAME_X);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(onHover.mock.calls).toEqual([[true], [false]]);
    });

    it('перетаскивание: окно остаётся ловящим мышь, а наведение «над», даже если курсор вне области', () => {
      const { controller, windows, onHover, setCursor } = shown();
      controller.dragStart({ screenX: 1700, screenY: 20 });
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }], [false, { forward: false }]]);
      expect(onHover.mock.calls).toEqual([[true]]);
      // Окно едет за курсором — область уходит из-под него, но жест не прерывается.
      setCursor(OUTSIDE);
      controller.dragMove({ screenX: 700, screenY: 20 });
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(windows[0]?.mouseCalls).toHaveLength(2);
      expect(onHover).toHaveBeenCalledTimes(1);
      // Отпустили вне области: следующий опрос возвращает сквозной режим.
      controller.dragEnd({ screenX: 700, screenY: 20 });
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }], [false, { forward: false }], [true, { forward: false }]]);
      expect(onHover.mock.calls).toEqual([[true], [false]]);
    });

    it('перетаскивание закончилось над областью — окно остаётся ловящим мышь', () => {
      const { controller, windows, onHover, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      controller.dragStart({ screenX: 1700, screenY: 20 });
      vi.advanceTimersByTime(HOVER_POLL_MS);
      controller.dragEnd({ screenX: 1700, screenY: 20 });
      // Прилипание сдвинуло окно, но курсор остался над формой: оно снова под ним.
      setCursor({ x: (windows[0]?.bounds.x ?? 0) + 150, y: 20 });
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(onHover.mock.calls).toEqual([[true]]);
    });

    it('область null — курсор вне: окно снова сквозное', () => {
      const { controller, windows, onHover, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      controller.setHitRect(null);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(windows[0]?.mouseCalls.at(-1)).toEqual([true, { forward: false }]);
      expect(onHover.mock.calls).toEqual([[true], [false]]);
    });

    it('без области курсор вне, как бы он ни стоял', () => {
      const { controller, onHover, setCursor } = setup({ displayId: 3, anchor: 'center' });
      controller.open();
      controller.setVisible(true);
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(onHover).not.toHaveBeenCalled();
    });

    it('опрос идёт только пока окно показано: скрытое окно курсор не читает', () => {
      const { controller, cursorSpy } = setup();
      controller.open();
      controller.setHitRect(SHAPE);
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(cursorSpy).not.toHaveBeenCalled();
      controller.setVisible(true);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(HOVER_POLL_MS * 2);
      expect(cursorSpy).toHaveBeenCalledTimes(2);
    });

    it('повторный показ не заводит второй таймер', () => {
      const { controller } = shown();
      controller.setVisible(true);
      controller.setVisible(true);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('скрытие останавливает опрос, возвращает окну сквозной режим и сообщает об уходе курсора', () => {
      const { controller, windows, onHover, cursorSpy, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      controller.setVisible(false);
      expect(windows[0]?.mouseCalls.at(-1)).toEqual([true, { forward: false }]);
      expect(onHover.mock.calls).toEqual([[true], [false]]);
      expect(windows[0]?.visible).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      cursorSpy.mockClear();
      vi.advanceTimersByTime(HOVER_POLL_MS * 5);
      expect(cursorSpy).not.toHaveBeenCalled();
    });

    it('скрытие без наведения об уходе не сообщает', () => {
      const { controller, onHover } = shown();
      controller.setVisible(false);
      expect(onHover).not.toHaveBeenCalled();
    });

    it('показ после скрытия снова запускает опрос, а курсор над областью ловится заново', () => {
      const { controller, windows, onHover, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      controller.setVisible(false);
      controller.setVisible(true);
      expect(windows[0]?.visible).toBe(true);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(onHover.mock.calls).toEqual([[true], [false], [true]]);
      expect(windows[0]?.mouseCalls.at(-1)).toEqual([false, { forward: false }]);
    });

    it('close останавливает опрос; новое окно после open начинает сквозным и без области', () => {
      const { controller, windows, onHover, setCursor } = shown();
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      controller.close();
      expect(vi.getTimerCount()).toBe(0);
      controller.open();
      controller.setVisible(true);
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(windows[1]?.mouseCalls).toEqual([[true, { forward: false }]]);
      expect(onHover.mock.calls).toEqual([[true]]);
    });

    it('падение renderer останавливает опрос упавшего окна', () => {
      const { windows, cursorSpy } = shown();
      windows[0]?.emit('wc:render-process-gone');
      expect(vi.getTimerCount()).toBe(0);
      cursorSpy.mockClear();
      vi.advanceTimersByTime(HOVER_POLL_MS * 3);
      expect(cursorSpy).not.toHaveBeenCalled();
    });

    it('окно спрятано мимо контроллера — опрос сам останавливается, не трогая окно', () => {
      const { windows, cursorSpy } = shown();
      windows[0]?.hide();
      cursorSpy.mockClear();
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(cursorSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(windows[0]?.mouseCalls).toEqual([[true, { forward: false }]]);
    });

    it('опрос, остановленный мимо контроллера, оживает, когда окно снова видно и renderer шлёт область', () => {
      const { controller, windows, setCursor, onHover } = shown();
      windows[0]?.hide();
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(vi.getTimerCount()).toBe(0);
      windows[0]?.showInactive();
      controller.setHitRect(SHAPE);
      expect(vi.getTimerCount()).toBe(1);
      setCursor(INSIDE);
      vi.advanceTimersByTime(HOVER_POLL_MS);
      expect(onHover).toHaveBeenLastCalledWith(true);
      expect(windows[0]?.mouseCalls.at(-1)).toEqual([false, { forward: false }]);
    });

    it('область от renderer не заводит опрос у скрытого окна', () => {
      const { controller, windows } = shown();
      controller.setVisible(false);
      controller.setHitRect(SHAPE);
      expect(vi.getTimerCount()).toBe(0);
      expect(windows[0]?.visible).toBe(false);
    });
  });
});
