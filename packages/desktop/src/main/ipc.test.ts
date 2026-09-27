import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { decodeIpcError } from '../shared/ipc-error.js';
import { DEFAULT_UI } from '../shared/ui-types.js';
import { HostError, type HostConnection } from './host-connection.js';
import { LayoutTooLargeError, type LayoutStore } from './layout-store.js';
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

function setup(overrides: { uiStore?: UiStore; layoutStore?: LayoutStore } = {}): {
  ipcMain: FakeIpcMain;
  connection: HostConnection;
  layoutStore: LayoutStore;
  uiStore: UiStore;
  setAppearance: ReturnType<typeof vi.fn>;
  titlebarDoubleClick: ReturnType<typeof vi.fn>;
} {
  const ipcMain = new FakeIpcMain();
  const connection = {
    call: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
    restartHost: vi.fn(),
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    activitySnapshot: vi.fn().mockReturnValue([{ ref: { sessionId: 's-1' } }]),
  } as unknown as HostConnection;
  const layoutStore: LayoutStore =
    overrides.layoutStore ??
    ({
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    } satisfies LayoutStore);
  const uiStore: UiStore =
    overrides.uiStore ??
    ({
      load: vi.fn().mockResolvedValue(DEFAULT_UI),
      save: vi.fn().mockResolvedValue(DEFAULT_UI),
    } satisfies UiStore);
  const setAppearance = vi.fn();
  const titlebarDoubleClick = vi.fn();

  registerIpc({
    ipcMain: ipcMain as unknown as IpcMain,
    connection,
    layoutStore,
    uiStore,
    setAppearance,
    titlebarDoubleClick,
    openExternal: vi.fn().mockResolvedValue(undefined),
    chooseFolder: vi.fn(),
    showNotification: vi.fn(),
    setBadge: vi.fn(),
  });

  return { ipcMain, connection, layoutStore, uiStore, setAppearance, titlebarDoubleClick };
}

describe('registerIpc', () => {
  it('host:activity-snapshot отдаёт снимок активности из HostConnection (раунд исправлений 1 куска 3.1)', async () => {
    const { ipcMain } = setup();
    expect(await ipcMain.invoke('host:activity-snapshot')).toEqual([{ ref: { sessionId: 's-1' } }]);
  });

  it('неизвестный метод отвергается', async () => {
    const { ipcMain } = setup();
    await expect(ipcMain.invoke('host:call', 'no.such.method', {})).rejects.toThrow();
  });

  it('известный метод уходит в HostConnection.call', async () => {
    const { ipcMain, connection } = setup();
    await ipcMain.invoke('host:call', 'works.list', {});
    expect(connection.call).toHaveBeenCalledWith('works.list', {});
  });

  // Кусок E.1: HostError, дошедший от хоста через HostConnection.call, обязан
  // нести свой код протокола через encodeIpcError — рендерер читает его
  // decodeIpcError и показывает errorText(code), а не русский текст хоста
  // (тот — только console.warn у вызывающей стороны).
  it('HostError от HostConnection.call доходит до рендерера с кодом (тест 4 куска E.1)', async () => {
    const { ipcMain, connection } = setup();
    vi.mocked(connection.call).mockRejectedValueOnce(new HostError('conflict', 'у работы есть живая сессия'));

    await expect(ipcMain.invoke('host:call', 'works.delete', {})).rejects.toSatisfy((error: unknown) => {
      expect(decodeIpcError(error)).toEqual({ code: 'conflict', message: 'у работы есть живая сессия' });
      return true;
    });
  });

  it('прочая (не HostError) ошибка host:call доходит до рендерера с кодом failed', async () => {
    const { ipcMain, connection } = setup();
    vi.mocked(connection.call).mockRejectedValueOnce(new Error('socket разорван'));

    await expect(ipcMain.invoke('host:call', 'works.list', {})).rejects.toSatisfy((error: unknown) => {
      expect(decodeIpcError(error)).toEqual({ code: 'failed', message: 'socket разорван' });
      return true;
    });
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

  it('app:remove-layout и app:retain-layouts уходят в LayoutStore (кусок 2.2)', async () => {
    const { ipcMain, layoutStore } = setup();
    await ipcMain.invoke('app:remove-layout', 'w-01');
    expect(layoutStore.remove).toHaveBeenCalledWith('w-01');

    await ipcMain.invoke('app:retain-layouts', ['w-01', 'w-02']);
    expect(layoutStore.retain).toHaveBeenCalledWith(['w-01', 'w-02']);
  });

  it('app:retain-layouts с не-строкой в списке отвергается', async () => {
    const { ipcMain, layoutStore } = setup();
    await expect(ipcMain.invoke('app:retain-layouts', ['w-01', 1])).rejects.toThrow();
    expect(layoutStore.retain).not.toHaveBeenCalled();
  });

  // Раунд исправлений 1, Important B: "__proto__"/"constructor"/"prototype" —
  // валидные строки по `typeof`, но ломают `filterWorks`/плоские объекты
  // ниже по цепочке (main/layout-store.ts) — канал обязан отвергать их сам,
  // как единственный слой с «проверкой аргументов» из сквозных правил.
  it('app:load-layout/app:save-layout/app:remove-layout отвергают "__proto__"/"constructor"/"prototype", пустую строку и слишком длинный ключ', async () => {
    const { ipcMain, layoutStore } = setup();
    const bad = ['__proto__', 'constructor', 'prototype', '', 'x'.repeat(4097)];

    for (const workKey of bad) {
      await expect(ipcMain.invoke('app:load-layout', workKey)).rejects.toThrow();
      await expect(ipcMain.invoke('app:save-layout', workKey, {})).rejects.toThrow();
      await expect(ipcMain.invoke('app:remove-layout', workKey)).rejects.toThrow();
    }
    expect(layoutStore.load).not.toHaveBeenCalled();
    expect(layoutStore.save).not.toHaveBeenCalled();
    expect(layoutStore.remove).not.toHaveBeenCalled();
  });

  it('app:retain-layouts отвергает массив с "__proto__"/"constructor"/"prototype"', async () => {
    const { ipcMain, layoutStore } = setup();
    await expect(ipcMain.invoke('app:retain-layouts', ['ok', '__proto__'])).rejects.toThrow();
    await expect(ipcMain.invoke('app:retain-layouts', ['constructor'])).rejects.toThrow();
    expect(layoutStore.retain).not.toHaveBeenCalled();
  });

  it('app:load-layout принимает обычный workKey и ключ ровно в 4096 символов', async () => {
    const { ipcMain, layoutStore } = setup();
    const maxLenKey = 'x'.repeat(4096);

    await ipcMain.invoke('app:load-layout', 'window');
    await ipcMain.invoke('app:load-layout', maxLenKey);

    expect(layoutStore.load).toHaveBeenCalledWith('window');
    expect(layoutStore.load).toHaveBeenCalledWith(maxLenKey);
  });

  // Тест 14 куска 2.2: раскладка больше лимита не должна доходить до рендерера
  // отказом — план требует тихого предупреждения в консоль main и успешного ответа.
  it('app:save-layout при LayoutTooLargeError пишет console.warn и отвечает успехом (тест 14)', async () => {
    const tooLarge = new LayoutTooLargeError('/tmp/layouts.json', 2_000_000, 1_000_000);
    const layoutStore: LayoutStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(tooLarge),
      remove: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    };
    const { ipcMain } = setup({ layoutStore });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ipcMain.invoke('app:save-layout', 'w-01', { huge: true })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(tooLarge.message));

    warnSpy.mockRestore();
  });

  it('app:save-layout пробрасывает прочие ошибки LayoutStore (не глотает их вслепую)', async () => {
    const layoutStore: LayoutStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockRejectedValue(new Error('диск сломался')),
      remove: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    };
    const { ipcMain } = setup({ layoutStore });

    await expect(ipcMain.invoke('app:save-layout', 'w-01', { a: 1 })).rejects.toThrow('диск сломался');
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

  it('app:titlebar-double-click зовёт обработчик (кусок 2.3)', () => {
    const { ipcMain, titlebarDoubleClick } = setup();
    ipcMain.invoke('app:titlebar-double-click');
    expect(titlebarDoubleClick).toHaveBeenCalled();
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
