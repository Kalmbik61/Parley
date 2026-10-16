import { describe, expect, it, vi } from 'vitest';
import { registerIslandIpc } from './ipc.js';

class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  on(channel: string, fn: (...args: unknown[]) => unknown): void { this.handlers.set(channel, fn); }
  emit(channel: string, event: unknown, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`нет обработчика для ${channel}`);
    return handler(event, ...args);
  }
}

const island = { id: 99 };
const stranger = { id: 1 };
const REF = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
const TARGET = { kind: 'session', ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' }, cardId: 'c-1' };

function setup() {
  const ipcMain = new FakeIpcMain();
  const controller = {
    isIsland: (sender: unknown) => sender === island,
    setHitRect: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
  };
  const options = {
    ipcMain,
    controller,
    config: vi.fn().mockResolvedValue({ sound: true, topInset: 38, anchor: 'center' }),
    pushConfig: vi.fn(),
    keyboard: vi.fn(),
    openTarget: vi.fn(),
    beep: vi.fn(),
    markSeen: vi.fn(),
    onFailed: vi.fn(),
  };
  registerIslandIpc(options);
  return { ipcMain, ...options };
}

/** Имена всех подменённых методов, которые хоть раз позвали: «ничего не случилось» — пустой список. */
function calledNames(state: ReturnType<typeof setup>): string[] {
  const mocks = {
    setHitRect: state.controller.setHitRect,
    setVisible: state.controller.setVisible,
    dragStart: state.controller.dragStart,
    dragMove: state.controller.dragMove,
    dragEnd: state.controller.dragEnd,
    config: state.config,
    pushConfig: state.pushConfig,
    keyboard: state.keyboard,
    openTarget: state.openTarget,
    beep: state.beep,
    markSeen: state.markSeen,
    onFailed: state.onFailed,
  };
  return Object.entries(mocks)
    .filter(([, mock]) => mock.mock.calls.length > 0)
    .map(([name]) => name);
}

describe('IPC острова', () => {
  it('failed от острова зовёт onFailed, от чужого окна — нет', () => {
    const { ipcMain, onFailed } = setup();
    ipcMain.emit('island:failed', { sender: stranger });
    expect(onFailed).not.toHaveBeenCalled();
    ipcMain.emit('island:failed', { sender: island });
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('keyboard: от острова с булевым значением зовёт options.keyboard, от чужого окна и не с булевым — нет', () => {
    const state = setup();
    state.ipcMain.emit('island:keyboard', { sender: stranger }, true);
    state.ipcMain.emit('island:keyboard', { sender: island }, 'true');
    state.ipcMain.emit('island:keyboard', { sender: island }, 1);
    state.ipcMain.emit('island:keyboard', { sender: island });
    expect(state.keyboard).not.toHaveBeenCalled();
    state.ipcMain.emit('island:keyboard', { sender: island }, true);
    expect(state.keyboard).toHaveBeenCalledWith(true);
    state.ipcMain.emit('island:keyboard', { sender: island }, false);
    expect(state.keyboard).toHaveBeenLastCalledWith(false);
  });

  it('видимость и перетаскивание — только от окна острова и только целые данные', () => {
    const { ipcMain, controller, pushConfig } = setup();
    ipcMain.emit('island:visible', { sender: island }, true);
    expect(controller.setVisible).toHaveBeenCalledWith(true);
    ipcMain.emit('island:drag-end', { sender: island }, { screenX: 10, screenY: 20 });
    expect(controller.dragEnd).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
    expect(pushConfig).toHaveBeenCalledTimes(1);
  });

  it('hit-rect: от острова проходят null и целая область (в том числе нулевого размера и с отрицательным сдвигом)', () => {
    const { ipcMain, controller } = setup();
    ipcMain.emit('island:hit-rect', { sender: island }, { x: 100, y: 0, width: 280, height: 40 });
    ipcMain.emit('island:hit-rect', { sender: island }, null);
    ipcMain.emit('island:hit-rect', { sender: island }, { x: 0, y: 0, width: 0, height: 0 });
    ipcMain.emit('island:hit-rect', { sender: island }, { x: -300, y: -20, width: 2000, height: 2000 });
    expect(controller.setHitRect.mock.calls).toEqual([
      [{ x: 100, y: 0, width: 280, height: 40 }],
      [null],
      [{ x: 0, y: 0, width: 0, height: 0 }],
      [{ x: -300, y: -20, width: 2000, height: 2000 }],
    ]);
  });

  it('hit-rect от чужого окна не передаётся контроллеру, даже целая область и null', () => {
    const state = setup();
    state.ipcMain.emit('island:hit-rect', { sender: stranger }, { x: 1, y: 2, width: 3, height: 4 });
    state.ipcMain.emit('island:hit-rect', { sender: stranger }, null);
    expect(calledNames(state)).toEqual([]);
  });

  it('config — острову; чужому окну — отказ', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.emit('island:config', { sender: island })).resolves.toEqual({ sound: true, topInset: 38, anchor: 'center' });
    await expect(ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
  });

  it('open ведёт в главное окно только целой целью', () => {
    const { ipcMain, openTarget } = setup();
    ipcMain.emit('island:open', { sender: island }, TARGET);
    ipcMain.emit('island:open', { sender: island }, { kind: 'session' });
    expect(openTarget.mock.calls).toEqual([[TARGET]]);
  });

  it.each<[string, unknown[]]>([
    ['island:hit-rect', [{ x: 1, y: 2, width: 3, height: 4 }]],
    ['island:visible', [true]],
    ['island:drag-start', [{ screenX: 1, screenY: 2 }]],
    ['island:drag-move', [{ screenX: 1, screenY: 2 }]],
    ['island:drag-end', [{ screenX: 1, screenY: 2 }]],
    ['island:open', [TARGET]],
    ['island:beep', []],
    ['island:mark-seen', [[REF]]],
    ['island:failed', []],
  ])('%s от чужого окна не делает ничего', (channel, args) => {
    const state = setup();
    state.ipcMain.emit(channel, { sender: stranger }, ...args);
    expect(calledNames(state)).toEqual([]);
  });

  it('island:config от чужого окна — отказ, настройки не читаются', async () => {
    const state = setup();
    await expect(state.ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
    expect(calledNames(state)).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ['island:hit-rect', ['yes']],
    ['island:hit-rect', [undefined]],
    ['island:hit-rect', [[]]],
    ['island:hit-rect', [{ x: 1, y: 2, width: 3 }]],
    ['island:hit-rect', [{ x: '1', y: 2, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: Number.NaN, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: Number.POSITIVE_INFINITY, y: 2, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: 2, width: -1, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: 2, width: 3, height: -0.5 }]],
    ['island:hit-rect', [{ x: 2001, y: 2, width: 3, height: 4 }]],
    ['island:hit-rect', [{ x: 1, y: 2, width: 3, height: 2001 }]],
    ['island:visible', ['yes']],
    ['island:mark-seen', [undefined]],
    ['island:mark-seen', [REF]],
    ['island:mark-seen', [[]]],
    ['island:mark-seen', [Array.from({ length: 51 }, () => REF)]],
    ['island:mark-seen', [[REF, { projectPath: '/p', workId: 'w-1' }]]],
    ['island:mark-seen', [[REF, 'мусор']]],
    ['island:mark-seen', [[{ projectPath: '/p', workId: 1, sessionId: 's-01' }]]],
    ['island:drag-start', [null]],
    ['island:drag-move', [{ screenX: '1', screenY: 2 }]],
    ['island:drag-end', [{ screenX: Number.POSITIVE_INFINITY, screenY: 0 }]],
  ])('%s с негодными данными от острова не делает ничего (%j)', (channel, args) => {
    const state = setup();
    state.ipcMain.emit(channel, { sender: island }, ...args);
    expect(calledNames(state)).toEqual([]);
  });

  it('mark-seen: верный список (от одной до 50 ссылок) доходит до main, лишние поля срезаются', () => {
    const { ipcMain, markSeen } = setup();
    const other = { projectPath: '/q', workId: 'w-2', sessionId: 's-02' };
    ipcMain.emit('island:mark-seen', { sender: island }, [REF, { ...other, extra: 1 }]);
    const fifty = Array.from({ length: 50 }, (_, at) => ({ ...REF, sessionId: `s-${at}` }));
    ipcMain.emit('island:mark-seen', { sender: island }, fifty);
    expect(markSeen.mock.calls).toEqual([[[REF, other]], [fifty]]);
  });

  it('звук; канала подсказки первого показа больше нет', () => {
    const { ipcMain, beep } = setup();
    ipcMain.emit('island:beep', { sender: island });
    ipcMain.emit('island:beep', { sender: stranger });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(ipcMain.handlers.has('island:hint-shown')).toBe(false);
  });
});
