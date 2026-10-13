import { describe, expect, it, vi } from 'vitest';
import type { DisplayLike, IslandPlacement, Rect } from './placement.js';
import { createIslandController, islandWindowOptions, type IslandWindowLike } from './window.js';

const EXTERNAL: DisplayLike = { id: 3, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, workArea: { x: 0, y: 25, width: 3440, height: 1415 }, internal: false };
const MACBOOK: DisplayLike = { id: 1, bounds: { x: 0, y: 1440, width: 1512, height: 982 }, workArea: { x: 0, y: 1478, width: 1512, height: 944 }, internal: true };

class FakeWindow implements IslandWindowLike {
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  destroyed = false;
  readonly calls: string[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  readonly webContents = {
    on: (event: string, listener: () => void) => this.add(`wc:${event}`, listener),
    send: vi.fn(),
  };
  setBounds(rect: Rect): void { this.bounds = rect; }
  getBounds(): Rect { return this.bounds; }
  setAlwaysOnTop(flag: boolean, level: string): void { this.calls.push(`top:${flag}:${level}`); }
  setVisibleOnAllWorkspaces(flag: boolean, options: { visibleOnFullScreen: boolean }): void { this.calls.push(`spaces:${flag}:${options.visibleOnFullScreen}`); }
  showInactive(): void { this.visible = true; this.calls.push('showInactive'); }
  hide(): void { this.visible = false; this.calls.push('hide'); }
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
      alwaysOnTop: true, acceptFirstMouse: true, skipTaskbar: true, hiddenInMissionControl: true,
      enableLargerThanScreen: true, show: false,
    });
    expect(options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, preload: '/x/preload/island.js' });
  });

  it('open: уровень поверх всего, все рабочие столы и полноэкранные приложения, место по центру основного', () => {
    const { controller, windows } = setup();
    controller.open();
    expect(windows[0]?.calls).toEqual(['top:true:screen-saver', 'spaces:true:true']);
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

  it('смена размера держит точку: правый край остаётся у правого поля', () => {
    const { controller, windows } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    controller.setSize({ width: 220, height: 40 });
    expect(windows[0]?.bounds).toEqual({ x: 3440 - 220 - 12, y: 0, width: 220, height: 40 });
    controller.setSize({ width: 380, height: 160 });
    expect(windows[0]?.bounds).toEqual({ x: 3440 - 380 - 12, y: 0, width: 380, height: 160 });
  });

  it('перетаскивание: вдоль верхнего края, на другой монитор, прилипание и запись места', () => {
    const { controller, windows, placement } = setup();
    controller.open();
    controller.setSize({ width: 380, height: 150 });
    controller.dragStart({ screenX: 1720, screenY: 10 });
    controller.dragMove({ screenX: 700, screenY: 1500 });
    expect(windows[0]?.bounds.y).toBe(1440);
    controller.dragEnd({ screenX: 700, screenY: 1500 });
    expect(placement()).toEqual({ displayId: 1, anchor: 'center' });
    expect(windows[0]?.bounds).toEqual({ x: 566, y: 1440, width: 380, height: 150 });
    expect(controller.topInset()).toBe(38);
  });

  it('close посреди перетаскивания сбрасывает жест: после нового open размер снова двигает окно', () => {
    const { controller, windows } = setup({ displayId: 3, anchor: 'right' });
    controller.open();
    controller.setSize({ width: 380, height: 150 });
    controller.dragStart({ screenX: 1720, screenY: 10 });
    controller.close();
    controller.open();
    controller.setSize({ width: 220, height: 40 });
    expect(windows[1]?.bounds).toEqual({ x: 3440 - 220 - 12, y: 0, width: 220, height: 40 });
  });

  it('монитор пропал — relayout переносит остров на основной', () => {
    const { controller, windows, setDisplays } = setup({ displayId: 1, anchor: 'center' });
    controller.open();
    controller.setSize({ width: 380, height: 150 });
    setDisplays([EXTERNAL]);
    controller.relayout();
    expect(windows[0]?.bounds).toEqual({ x: 1530, y: 0, width: 380, height: 150 });
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
});
