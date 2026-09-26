import { METHODS, NOTIFICATIONS } from '@harnas/protocol';
import type { MethodName, NotificationName } from '@harnas/protocol';
import type { BrowserWindow, IpcMain } from 'electron';
import type { HostConnection } from './host-connection.js';
import type { LayoutStore } from './layout-store.js';

const METHOD_NAMES = new Set<string>(Object.keys(METHODS));
const NOTIFICATION_NAMES = new Set<string>(Object.keys(NOTIFICATIONS));

export function isMethodName(value: string): value is MethodName {
  return METHOD_NAMES.has(value);
}

export function isNotificationName(value: string): value is NotificationName {
  return NOTIFICATION_NAMES.has(value);
}

/** Внешние ссылки открываются только по http/https — `file:` и `javascript:` наружу не пускаем. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface RegisterIpcOptions {
  ipcMain: IpcMain;
  connection: HostConnection;
  openExternal: (url: string) => Promise<void>;
  chooseFolder: () => Promise<string | null>;
  showNotification: (note: { title: string; body: string }) => void;
  setBadge: (count: number) => void;
  /** Раскладка dockview (кусок 2.2 плана окна). */
  layoutStore: LayoutStore;
}

/**
 * Белый список IPC: рендерер не может позвать ничего, кроме методов и
 * уведомлений из `@harnas/protocol`, и не может открыть ничего, кроме
 * http/https. Всё остальное (Node, произвольные каналы) ему недоступно —
 * `contextIsolation` и `sandbox` в `security.ts` это обеспечивают на уровне
 * процесса, а этот список — на уровне протокола.
 */
export function registerIpc(options: RegisterIpcOptions): void {
  const { ipcMain, connection, openExternal, chooseFolder, showNotification, setBadge, layoutStore } = options;

  ipcMain.handle('host:call', async (_event, method: unknown, params: unknown) => {
    if (typeof method !== 'string' || !isMethodName(method)) {
      throw new Error(`неизвестный метод: ${String(method)}`);
    }
    return connection.call(method, params);
  });

  ipcMain.on('host:notify', (_event, method: unknown, params: unknown) => {
    if (typeof method !== 'string' || !isNotificationName(method)) return;
    connection.notify(method, params);
  });

  ipcMain.handle('app:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isAllowedExternalUrl(url)) {
      throw new Error(`запрещённый адрес: ${String(url)}`);
    }
    await openExternal(url);
  });

  ipcMain.on('app:notify', (_event, note: { title: string; body: string }) => {
    showNotification(note);
  });

  ipcMain.on('app:set-badge', (_event, count: number) => {
    setBadge(count);
  });

  ipcMain.handle('app:choose-folder', () => chooseFolder());

  ipcMain.handle('app:restart-host', () => connection.restartHost());

  ipcMain.handle('app:load-layout', (_event, workKey: unknown) => {
    if (typeof workKey !== 'string') throw new Error(`неверный ключ раскладки: ${String(workKey)}`);
    return layoutStore.load(workKey);
  });

  ipcMain.handle('app:save-layout', (_event, workKey: unknown, layout: unknown) => {
    if (typeof workKey !== 'string') throw new Error(`неверный ключ раскладки: ${String(workKey)}`);
    return layoutStore.save(workKey, layout);
  });
}

/**
 * Прокидывает события и статус хоста в конкретное окно. Отдельно от
 * `registerIpc` и вызывается не раньше `did-finish-load`: `HostConnection.onStatus`
 * отдаёт текущий статус немедленно при подписке, а если подписаться до того,
 * как прелоад этого окна навесил свои слушатели `ipcRenderer.on`, самое первое
 * сообщение (обычно самое важное — «хост подключён») уйдёт в пустоту.
 */
export function forwardHostToWindow(
  connection: HostConnection,
  window: BrowserWindow,
): { dispose: () => void } {
  const unsubEvent = connection.onEvent((message) => {
    if (window.isDestroyed()) return;
    window.webContents.send('host:event', message);
  });
  const unsubStatus = connection.onStatus((status) => {
    if (window.isDestroyed()) return;
    window.webContents.send('host:status', status);
  });
  return {
    dispose: () => {
      unsubEvent();
      unsubStatus();
    },
  };
}
