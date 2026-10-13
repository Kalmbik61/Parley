/**
 * Окно острова (спека 2026-10-12, разделы 3 и 5.1). Параметры — из спайка на Electron 44: `panel`
 * (`NSWindowStyleMaskNonactivatingPanel` — клик не поднимает Parley), уровень `screen-saver`,
 * `acceptFirstMouse` (первый клик по неактивному окну доходит до кнопки) и
 * `enableLargerThanScreen` — без него macOS сдвигает видимое окно под строку меню (y = 25 на внешнем мониторе,
 * под строку чёлки на MacBook). Показ — только `showInactive()`: `show()` и `focus()` активировали бы приложение.
 *
 * Контроллер не знает Electron: окно, мониторы и запись места приходят зависимостями — так его можно проверить на
 * подменах. Место держит верхний край и точку (`anchor`): смена размера и перетаскивание пересчитывают прямоугольник
 * через `placement.ts`. Упал renderer — одно пересоздание; второе падение — острова нет до перезапуска приложения:
 * зависшее прозрачное окно поверх всего хуже, чем его отсутствие.
 */

import type { BrowserWindowConstructorOptions } from 'electron';
import type { IslandPoint } from '../../shared/island.js';
import {
  displayAt,
  islandBounds,
  notchInset,
  resolveDisplay,
  snapAnchor,
  type DisplayLike,
  type IslandPlacement,
  type Rect,
  type Size,
} from './placement.js';

export function islandWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 220,
    height: 40,
    type: 'panel',
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    // Панель никогда не становится ключевым окном: иначе после клика по острову нажатия клавиш (даже ⌘Q) шли бы в Parley.
    // Клики мышью по-прежнему доходят (`acceptFirstMouse`).
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    enableLargerThanScreen: true,
    show: false,
    // Скрытый остров не должен усыплять таймеры и ResizeObserver: иначе новый запрос не разбудит окно.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: preloadPath, webviewTag: false, backgroundThrottling: false },
  };
}

/** То, что контроллеру нужно от `BrowserWindow`. */
export interface IslandWindowLike {
  readonly webContents: { on(event: 'render-process-gone', listener: () => void): unknown; send(channel: string, ...args: unknown[]): void };
  setBounds(rect: Rect): void;
  getBounds(): Rect;
  setAlwaysOnTop(flag: boolean, level: 'screen-saver'): void;
  showInactive(): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: 'closed', listener: () => void): unknown;
}

export interface IslandControllerDeps<W extends IslandWindowLike> {
  createWindow(): W;
  displays(): readonly DisplayLike[];
  primaryDisplayId(): number;
  /** Текущее место из настроек (кеш main: запись в `ui.json` асинхронная). */
  placement(): IslandPlacement;
  savePlacement(placement: IslandPlacement): void;
  /** Окно создано: main вешает пересылку событий хоста и отдаёт настройки. */
  onCreated(window: W): void;
  log(message: string): void;
}

export interface IslandController<W extends IslandWindowLike> {
  open(): void;
  close(): void;
  current(): W | null;
  isIsland(sender: unknown): boolean;
  setSize(size: Size): void;
  setVisible(visible: boolean): void;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Мониторы изменились — место заново из сохранённой точки. */
  relayout(): void;
  /** Отступ содержимого под чёлку у текущего монитора острова. */
  topInset(): number;
}

const INITIAL_SIZE: Size = { width: 220, height: 40 };

export function createIslandController<W extends IslandWindowLike>(deps: IslandControllerDeps<W>): IslandController<W> {
  let window: W | null = null;
  let size: Size = INITIAL_SIZE;
  let crashes = 0;
  let dragging = false;
  let dragOffsetX = 0;

  const live = (): W | null => (window !== null && !window.isDestroyed() ? window : null);
  const display = (): DisplayLike => resolveDisplay(deps.displays(), deps.primaryDisplayId(), deps.placement().displayId);
  const place = (): void => {
    const current = live();
    if (current === null) return;
    current.setBounds(islandBounds(display(), deps.placement().anchor, size));
  };

  const open = (): void => {
    if (live() !== null) return;
    // Перетаскивание старого окна не переживает пересоздание (закрытие или падение renderer посреди жеста).
    dragging = false;
    const created = deps.createWindow();
    created.setAlwaysOnTop(true, 'screen-saver');
    // `setVisibleOnAllWorkspaces` не зовём: Electron на macOS превращает тип процесса, и иконка в Dock / Cmd-Tab может
    // пропасть. `type: 'panel'` и так плавает над полноэкранными приложениями и виден на всех рабочих столах (доки Electron).
    created.on('closed', () => {
      if (window === created) window = null;
    });
    created.webContents.on('render-process-gone', () => {
      crashes += 1;
      deps.log(`island renderer gone (${crashes})`);
      if (window === created) window = null;
      if (!created.isDestroyed()) created.destroy();
      if (crashes === 1) open();
    });
    window = created;
    place();
    deps.onCreated(created);
  };

  return {
    open,
    close: () => {
      const current = live();
      window = null;
      dragging = false;
      current?.destroy();
    },
    current: live,
    isIsland: (sender) => {
      const current = live();
      return current !== null && sender === current.webContents;
    },
    setSize: (next) => {
      size = next;
      if (!dragging) place();
    },
    setVisible: (visible) => {
      const current = live();
      if (current === null) return;
      if (!visible) {
        // Скрыли — жест уже не продолжится; потерянный `drag-end` не должен замораживать место.
        dragging = false;
        if (current.isVisible()) current.hide();
        return;
      }
      if (current.isVisible()) return;
      place();
      current.showInactive();
    },
    dragStart: (point) => {
      const current = live();
      if (current === null) return;
      dragging = true;
      dragOffsetX = point.screenX - current.getBounds().x;
    },
    dragMove: (point) => {
      const current = live();
      if (current === null || !dragging) return;
      const under = displayAt(deps.displays(), point.screenX, point.screenY);
      current.setBounds({ x: Math.round(point.screenX - dragOffsetX), y: under.bounds.y, width: size.width, height: size.height });
    },
    dragEnd: (point) => {
      if (live() === null || !dragging) return;
      dragging = false;
      const under = displayAt(deps.displays(), point.screenX, point.screenY);
      deps.savePlacement({ displayId: under.id, anchor: snapAnchor(under, point.screenX) });
      place();
    },
    relayout: () => {
      dragging = false;
      place();
    },
    topInset: () => notchInset(display()),
  };
}
