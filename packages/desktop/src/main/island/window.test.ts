import { describe, expect, it, vi } from 'vitest';
import type { DisplayLike, IslandPlacement, Rect } from './placement.js';
import { createIslandController, ISLAND_FRAME, islandWindowOptions, type IslandWindowLike } from './window.js';

const EXTERNAL: DisplayLike = { id: 3, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 25, width: 3440, height: 1415 }, internal: false };
const MACBOOK: DisplayLike = { id: 1, bounds: { x: 0, y: 1440, width: 1512, height: 982 }, workArea: { x: 0, y: 1478, width: 1512, height: 944 }, internal: true };

class FakeWindow implements IslandWindowLike {
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  destroyed = false;
  readonly calls: string[] = [];
  /** Вызовы `setIgnoreMouseEvents` по порядку: первый — начальный сквозной режим, остальные — `setInteractive`. */
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
  isVisible(): boolean { return this.visible; }
  destroy(): void { this.destroyed = true; this.emit('closed'); }
  isDestroyed(): boolean { return this.destroyed; }
  on(event: 'closed', listener: () => void): void { this.add(event, listener); }
  emit(event: string): void { for (const listener of this.listeners.get(event) ?? []) listener(); }
  private add(event: string, listener: () => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
}

function setup(placement: IslandPlacement = { displayId: null, anchor: 'center' }) {
  const windows: FakeWindow[] = [];
  let saved = placement;
  let displays: DisplayLike[] = [EXTERNAL, MACBOOK];
  const log = vi.fn();
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
    onCreated: vi.fn(),
    log,
  });
  return { controller, windows, log, setDisplays: (next: DisplayLike[]) => { displays = next; }, placement: () => saved };
}

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

  it('open: окно сразу сквозное для мыши (с пересылкой движений), интерактивным его делает setInteractive', () => {
    const { controller, windows } = setup();
    controller.open();
    expect(windows[0]?.mouseCalls).toEqual([[true, { forward: true }]]);
    controller.setInteractive(true);
    controller.setInteractive(false);
    expect(windows[0]?.mouseCalls).toEqual([
      [true, { forward: true }],
      [false, { forward: true }],
      [true, { forward: true }],
    ]);
  });

  it('скрытие возвращает окну сквозной режим: интерактивный остров после hide снова пропускает клики', () => {
    const { controller, windows } = setup();
    controller.open();
    controller.setVisible(true);
    controller.setInteractive(true);
    controller.setVisible(false);
    expect(windows[0]?.mouseCalls).toEqual([
      [true, { forward: true }],
      [false, { forward: true }],
      [true, { forward: true }],
    ]);
    expect(windows[0]?.visible).toBe(false);
  });

  it('setInteractive без окна ничего не делает; после close старое окно не трогает', () => {
    const { controller, windows } = setup();
    expect(() => controller.setInteractive(true)).not.toThrow();
    controller.open();
    controller.close();
    controller.setInteractive(true);
    expect(windows[0]?.mouseCalls).toEqual([[true, { forward: true }]]);
  });

  it('новое окно (после close и open) снова начинает сквозным', () => {
    const { controller, windows } = setup();
    controller.open();
    controller.setInteractive(true);
    controller.close();
    controller.open();
    expect(windows[1]?.mouseCalls).toEqual([[true, { forward: true }]]);
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

  it('после падения renderer пересозданное окно снова сквозное, даже если упавшее было интерактивным', () => {
    const { controller, windows } = setup();
    controller.open();
    controller.setInteractive(true);
    windows[0]?.emit('wc:render-process-gone');
    expect(windows[1]?.mouseCalls).toEqual([[true, { forward: true }]]);
  });
});
