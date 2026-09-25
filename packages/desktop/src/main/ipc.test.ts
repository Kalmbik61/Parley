import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { HostConnection } from './host-connection.js';
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

function setup(): { ipcMain: FakeIpcMain; connection: HostConnection } {
  const ipcMain = new FakeIpcMain();
  const connection = {
    call: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
    restartHost: vi.fn(),
    onEvent: vi.fn(),
    onStatus: vi.fn(),
  } as unknown as HostConnection;

  registerIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    connection,
    openExternal: vi.fn().mockResolvedValue(undefined),
    chooseFolder: vi.fn(),
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  });

  return { ipcMain, connection };
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
});
