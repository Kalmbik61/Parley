import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { DEFAULT_UI } from '../shared/ui-types.js';
import type { HostConnection } from './host-connection.js';
import type { LayoutStore } from './layout-store.js';
import type { UiStore } from './ui-store.js';
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

function setup(overrides: { uiStore?: UiStore } = {}): {
  ipcMain: FakeIpcMain;
  connection: HostConnection;
  layoutStore: LayoutStore;
  uiStore: UiStore;
  setAppearance: ReturnType<typeof vi.fn>;
} {
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
  const uiStore: UiStore =
    overrides.uiStore ??
    ({
      load: vi.fn().mockResolvedValue(DEFAULT_UI),
      save: vi.fn().mockResolvedValue(DEFAULT_UI),
    } satisfies UiStore);
  const setAppearance = vi.fn();

  registerIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    connection,
    layoutStore,
    uiStore,
    setAppearance,
    openExternal: vi.fn().mockResolvedValue(undefined),
    chooseFolder: vi.fn(),
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  });

  return { ipcMain, connection, layoutStore, uiStore, setAppearance };
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
    await expect(
      ipcMain.invoke('app:open-external', 'https://example.com'),
    ).resolves.toBeUndefined();
  });

  it('app:load-layout и app:save-layout уходят в LayoutStore (кусок 2.2)', async () => {
    const { ipcMain, layoutStore } = setup();
    await ipcMain.invoke('app:load-layout', 'window');
    expect(layoutStore.load).toHaveBeenCalledWith('window');

    await ipcMain.invoke('app:save-layout', 'window', { a: 1 });
    expect(layoutStore.save).toHaveBeenCalledWith('window', { a: 1 });
  });

  it('app:load-ui и app:save-ui уходят в UiStore (кусок 1.1)', async () => {
    const { ipcMain, uiStore } = setup();
    await ipcMain.invoke('app:load-ui');
    expect(uiStore.load).toHaveBeenCalled();

    await ipcMain.invoke('app:save-ui', { appearance: 'dark' });
    expect(uiStore.save).toHaveBeenCalledWith({ appearance: 'dark' });
  });

  // Тест 14 раунда исправлений (находка I3): `typeof [] === 'object'` — старая
  // проверка `typeof patch !== 'object' || patch === null` пропускала массивы.
  it('app:save-ui отвергает массив, null и не-объект (тест 14)', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('app:save-ui', [1, 2, 3])).rejects.toThrow();
    await expect(ipcMain.invoke('app:save-ui', null)).rejects.toThrow();
    await expect(ipcMain.invoke('app:save-ui', 'oops')).rejects.toThrow();
  });

  it('app:set-appearance меняет тему и пишет ui.json (спека 4.7)', async () => {
    const { ipcMain, uiStore, setAppearance } = setup();
    await ipcMain.invoke('app:set-appearance', 'dark');

    expect(setAppearance).toHaveBeenCalledWith('dark');
    expect(uiStore.save).toHaveBeenCalledWith({ appearance: 'dark' });
  });

  it('app:set-appearance с неверным режимом отвергается', async () => {
    const { ipcMain, setAppearance } = setup();
    await expect(ipcMain.invoke('app:set-appearance', 'blue')).rejects.toThrow();
    expect(setAppearance).not.toHaveBeenCalled();
  });

  // Тест 14 раунда исправлений (находка I4): запись на диск должна случиться
  // ДО смены nativeTheme.themeSource — иначе при отказе записи окно уже
  // сменило тему в памяти, а ui.json остался со старой, и на следующем
  // перезапуске тема «откатится» без действия пользователя.
  it('app:set-appearance: падение uiStore.save отклоняет промис и не трогает тему (тест 14)', async () => {
    const failingUiStore: UiStore = {
      load: vi.fn().mockResolvedValue(DEFAULT_UI),
      save: vi.fn().mockRejectedValue(new Error('диск сломался')),
    };
    const { ipcMain, setAppearance } = setup({ uiStore: failingUiStore });

    await expect(ipcMain.invoke('app:set-appearance', 'dark')).rejects.toThrow('диск сломался');
    expect(setAppearance).not.toHaveBeenCalled();
  });
});
