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

function setup() {
  const ipcMain = new FakeIpcMain();
  const controller = {
    isIsland: (sender: unknown) => sender === island,
    setSize: vi.fn(), setVisible: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
  };
  const options = {
    ipcMain,
    controller,
    config: vi.fn().mockResolvedValue({ sound: true, hintShown: false, topInset: 38 }),
    pushConfig: vi.fn(),
    openTarget: vi.fn(),
    beep: vi.fn(),
    markHintShown: vi.fn(),
  };
  registerIslandIpc(options);
  return { ipcMain, ...options };
}

describe('IPC острова', () => {
  it('размер, видимость и перетаскивание — только от окна острова и только целые данные', () => {
    const { ipcMain, controller, pushConfig } = setup();
    ipcMain.emit('island:size', { sender: island }, 380, 150);
    ipcMain.emit('island:size', { sender: stranger }, 10, 10);
    ipcMain.emit('island:size', { sender: island }, -1, 'x');
    expect(controller.setSize.mock.calls).toEqual([[{ width: 380, height: 150 }]]);
    ipcMain.emit('island:visible', { sender: island }, true);
    expect(controller.setVisible).toHaveBeenCalledWith(true);
    ipcMain.emit('island:drag-end', { sender: island }, { screenX: 10, screenY: 20 });
    expect(controller.dragEnd).toHaveBeenCalledWith({ screenX: 10, screenY: 20 });
    expect(pushConfig).toHaveBeenCalledTimes(1);
  });

  it('config — острову; чужому окну — отказ', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.emit('island:config', { sender: island })).resolves.toEqual({ sound: true, hintShown: false, topInset: 38 });
    await expect(ipcMain.emit('island:config', { sender: stranger })).rejects.toBeTruthy();
  });

  it('open ведёт в главное окно только целой целью', () => {
    const { ipcMain, openTarget } = setup();
    const target = { kind: 'session', ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' }, cardId: 'c-1' };
    ipcMain.emit('island:open', { sender: island }, target);
    ipcMain.emit('island:open', { sender: island }, { kind: 'session' });
    expect(openTarget.mock.calls).toEqual([[target]]);
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
