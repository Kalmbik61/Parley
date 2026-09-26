import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { HostConnection } from './host-connection.js';
import type { LayoutStore } from './layout-store.js';
import { registerIpc } from './ipc.js';

/** Подставной `ipcMain`: сохраняет обработчики и умеет их дёргать, как настоящий `invoke`. */
class FakeIpcMain {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>();

  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  on(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  invoke(channel: string, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`нет обработчика для ${channel}`);
    return handler({}, ...args);
  }
}

function setup(): { ipcMain: FakeIpcMain; connection: HostConnection; layoutStore: LayoutStore } {
  const ipcMain = new FakeIpcMain();
  const connection = {
    call: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
    restartHost: vi.fn(),
    onEvent: vi.fn(),
    onStatus: vi.fn(),
  } as unknown as HostConnection;
  const layoutStore: LayoutStore = {
    load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
  };

  registerIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    connection,
    layoutStore,
    openExternal: vi.fn().mockResolvedValue(undefined),
    chooseFolder: vi.fn(),
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  });

  return { ipcMain, connection, layoutStore };
}

describe('registerIpc', () => {
  it('неизвестный метод отвергается', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('host:call', 'no.such.method', {})).rejects.toThrow();
  });

  it('известный метод уходит в HostConnection.call', async () => {
    const { ipcMain, connection } = setup();
    await ipcMain.invoke('host:call', 'works.list', {});
    expect(connection.call).toHaveBeenCalledWith('works.list', {});
  });

  it('openExternal(file:///etc/passwd) и javascript: отвергаются', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('app:open-external', 'file:///etc/passwd')).rejects.toThrow();
    await expect(ipcMain.invoke('app:open-external', 'javascript:alert(1)')).rejects.toThrow();
  });

  it('openExternal с http/https проходит', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('app:open-external', 'https://example.com')).resolves.toBeUndefined();
  });

  it('app:load-layout и app:save-layout уходят в LayoutStore (кусок 2.2)', async () => {
    const { ipcMain, layoutStore } = setup();
    await ipcMain.invoke('app:load-layout', 'window');
    expect(layoutStore.load).toHaveBeenCalledWith('window');

    await ipcMain.invoke('app:save-layout', 'window', { a: 1 });
    expect(layoutStore.save).toHaveBeenCalledWith('window', { a: 1 });
  });
});
