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
const TARGET = { kind: 'session', ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' }, cardId: 'c-1' };

function setup() {
  const ipcMain = new FakeIpcMain();
  const controller = {
    isIsland: (sender: unknown) => sender === island,
    setInteractive: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
  };
  const options = {
    ipcMain,
    controller,
    config: vi.fn().mockResolvedValue({ sound: true, hintShown: false, topInset: 38, anchor: 'center' }),
    pushConfig: vi.fn(),
    openTarget: vi.fn(),
    beep: vi.fn(),
    markHintShown: vi.fn(),
    onFailed: vi.fn(),
  };
  registerIslandIpc(options);
  return { ipcMain, ...options };
}

/** Имена всех подменённых методов, которые хоть раз позвали: «ничего не случилось» — пустой список. */
function calledNames(state: ReturnType<typeof setup>): string[] {
  const mocks = {
    setInteractive: state.controller.setInteractive,
    setVisible: state.controller.setVisible,
    dragStart: state.controller.dragStart,
    dragMove: state.controller.dragMove,
    dragEnd: state.controller.dragEnd,
    config: state.config,
    pushConfig: state.pushConfig,
    openTarget: state.openTarget,
    beep: state.beep,
    markHintShown: state.markHintShown,
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

  it('интерактивность, видимость и перетаскивание — только от окна острова и только целые данные', () => {
    const { ipcMain, controller, pushConfig } = setup();
    ipcMain.emit('island:interactive', { sender: island }, true);
    ipcMain.emit('island:interactive', { sender: island }, false);
    ipcMain.emit('island:interactive', { sender: stranger }, true);
    ipcMain.emit('island:interactive', { sender: island }, 1);
    expect(controller.setInteractive.mock.calls).toEqual([[true], [false]]);
    ipcMain.emit('island:visible', { sender: island }, true);
    expect(controller.setVisible).toHaveBeenCalledWith(true);
    ipcMain.emit('island:drag-end', { sender: island }, { screenX: 10, screenY: 20 });
    expect(controller.dragEnd).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
    expect(pushConfig).toHaveBeenCalledTimes(1);
  });

  it('config — острову; чужому окну — отказ', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.emit('island:config', { sender: island })).resolves.toEqual({ sound: true, hintShown: false, topInset: 38, anchor: 'center' });
    await expect(ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
  });

  it('open ведёт в главное окно только целой целью', () => {
    const { ipcMain, openTarget } = setup();
    ipcMain.emit('island:open', { sender: island }, TARGET);
    ipcMain.emit('island:open', { sender: island }, { kind: 'session' });
    expect(openTarget.mock.calls).toEqual([[TARGET]]);
  });

  it.each<[string, unknown[]]>([
    ['island:interactive', [true]],
    ['island:visible', [true]],
    ['island:drag-start', [{ screenX: 1, screenY: 2 }]],
    ['island:drag-move', [{ screenX: 1, screenY: 2 }]],
    ['island:drag-end', [{ screenX: 1, screenY: 2 }]],
    ['island:open', [TARGET]],
    ['island:beep', []],
    ['island:hint-shown', []],
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
    ['island:interactive', ['yes']],
    ['island:interactive', [1]],
    ['island:interactive', [undefined]],
    ['island:visible', ['yes']],
    ['island:drag-start', [null]],
    ['island:drag-move', [{ screenX: '1', screenY: 2 }]],
    ['island:drag-end', [{ screenX: Number.POSITIVE_INFINITY, screenY: 0 }]],
  ])('%s с негодными данными от острова не делает ничего (%j)', (channel, args) => {
    const state = setup();
    state.ipcMain.emit(channel, { sender: island }, ...args);
    expect(calledNames(state)).toEqual([]);
  });

  it('звук и подсказка', () => {
    const { ipcMain, beep, markHintShown } = setup();
    ipcMain.emit('island:beep', { sender: island });
    ipcMain.emit('island:hint-shown', { sender: island });
    ipcMain.emit('island:beep', { sender: stranger });
    expect(beep).toHaveBeenCalledTimes(1);
    expect(markHintShown).toHaveBeenCalledTimes(1);
  });
});
