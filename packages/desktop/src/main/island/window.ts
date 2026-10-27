/**
 * Окно острова (спека 2026-10-12, разделы 3 и 5.1). Параметры — из спайка на Electron 44: `panel`
 * (`NSWindowStyleMaskNonactivatingPanel` — клик не поднимает Parley), уровень `screen-saver`,
 * `acceptFirstMouse` (первый клик по неактивному окну доходит до кнопки) и
 * `enableLargerThanScreen` — без него macOS сдвигает видимое окно под строку меню (y = 25 на внешнем мониторе,
 * под строку чёлки на MacBook). Показ — только `showInactive()`: `show()` и `focus()` активировали бы приложение.
 *
 * Контроллер не знает Electron: окно, мониторы и запись места приходят зависимостями — так его можно проверить на
 * подменах. Окно всегда одного размера (`ISLAND_FRAME`) и целиком прозрачное: чёрная форма острова анимирует размер
 * внутри кадра (CSS), а окно не меняет границы. Прозрачная часть не должна перехватывать клики по приложениям под ней,
 * поэтому окно игнорирует мышь (`setIgnoreMouseEvents(true, …)`) и становится интерактивным только пока курсор над
 * областью острова. Наведение решает main, а не DOM: в сквозном окне с пересылкой движений Chromium не получал
 * `mouseleave` (`:hover` формы оставался истинным при курсоре за 1800 px). Renderer сообщает область
 * (`setHitRect`: форма или язычок в координатах окна), а раз в `HOVER_POLL_MS`, пока окно видно, main сверяет с ней
 * настоящий курсор (`deps.cursor()`) и при смене «над / не над» переключает окно и зовёт `deps.onHover`.
 * Место держит верхний край и точку (`anchor`): перетаскивание и смена монитора пересчитывают прямоугольник через
 * `placement.ts`. Вырез дисплея (#9 §12) даёт датчик (`deps.notch`): у точки `center` кадр стоит по центру выреза,
 * отступ — высота выреза; новый замер main применяет через `relayout()`. Упал renderer — одно пересоздание; второе
 * падение — острова нет до перезапуска приложения: зависшее прозрачное окно поверх всего хуже, чем его отсутствие.
 */

import type { BrowserWindowConstructorOptions } from 'electron';
import type { IslandConfig, IslandHitRect, IslandPoint } from '../../shared/island.js';
import type { IslandAnchor } from '../../shared/ui-types.js';
import {
  displayAt,
  islandBounds,
  notchInset,
  resolveDisplay,
  snapAnchor,
  type DisplayLike,
  type IslandPlacement,
  type NotchGeometry,
  type Rect,
  type Size,
} from './placement.js';

/**
 * Фиксированный прозрачный кадр окна острова под самое большое состояние: карточка запроса ~440 px шириной, список
 * до ~360 px высотой вместе с шапкой. Форма острова растёт и сжимается внутри кадра, само окно границ не меняет.
 */
export const ISLAND_FRAME: Size = { width: 480, height: 520 };

/** Как часто, пока окно видно, main сверяет настоящий курсор с областью острова. */
export const HOVER_POLL_MS = 100;

export function islandWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: ISLAND_FRAME.width,
    height: ISLAND_FRAME.height,
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
  setIgnoreMouseEvents(ignore: boolean, options: { forward: boolean }): void;
  setFocusable(focusable: boolean): void;
  focus(): void;
  isVisible(): boolean;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: 'closed' | 'blur', listener: () => void): unknown;
}

export interface IslandControllerDeps<W extends IslandWindowLike> {
  createWindow(): W;
  displays(): readonly DisplayLike[];
  primaryDisplayId(): number;
  /** Текущее место из настроек (кеш main: запись в `ui.json` асинхронная). */
  placement(): IslandPlacement;
  savePlacement(placement: IslandPlacement): void;
  /** Вырез дисплея по последнему замеру датчика (или подмена `PARLEY_NOTCH`); `null` — выреза нет. */
  notch(display: DisplayLike): NotchGeometry | null;
  /** Настоящее положение курсора на экране (DIP) — `screen.getCursorScreenPoint()`. */
  cursor(): { x: number; y: number };
  /** Курсор вошёл в область острова или ушёл из неё: main отдаёт это renderer острова. */
  onHover(hovered: boolean): void;
  /** Панель потеряла фокус, пока держала клавиатуру (клик в другое приложение): main велит острову выйти из режима. */
  onKeyboardLost(): void;
  /** Окно создано: main вешает пересылку событий хоста и отдаёт настройки. */
  onCreated(window: W): void;
  log(message: string): void;
}

export interface IslandController<W extends IslandWindowLike> {
  open(): void;
  close(): void;
  current(): W | null;
  isIsland(sender: unknown): boolean;
  /** Область острова в координатах окна (форма или язычок) от renderer; `null` — ничего не показано, курсор всегда «вне». */
  setHitRect(rect: IslandHitRect | null): void;
  setVisible(visible: boolean): void;
  /** Режим помощника: панель берёт клавиатуру (`true`) или отдаёт её прежнему приложению (`false`). */
  setKeyboard(on: boolean): void;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Мониторы изменились или датчик выреза дал новый замер — место заново из сохранённой точки. */
  relayout(): void;
  /** Отступ содержимого под чёлку у текущего монитора острова. */
  topInset(): number;
  /**
   * Форма выреза для renderer (`IslandConfig.notch`): только у точки `center` (Н-3), центр — в координатах кадра окна;
   * у левой и правой точки или без выреза — `null`, остаётся полоса.
   */
  notch(): NonNullable<IslandConfig['notch']> | null;
  /** Точка, у которой стоит остров, — renderer по ней выравнивает форму внутри кадра. */
  anchor(): IslandAnchor;
}

export function createIslandController<W extends IslandWindowLike>(deps: IslandControllerDeps<W>): IslandController<W> {
  let window: W | null = null;
  let crashes = 0;
  let dragging = false;
  let dragOffsetX = 0;
  let hitRect: IslandHitRect | null = null;
  /** Курсор над областью острова (или остров тащат): окно ловит мышь, renderer знает об этом из `onHover`. */
  let hovered = false;
  /** Панель взяла клавиатуру (режим помощника): потеря фокуса в этом состоянии сообщается через `onKeyboardLost`. */
  let keyboard = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const live = (): W | null => (window !== null && !window.isDestroyed() ? window : null);
  const display = (): DisplayLike => resolveDisplay(deps.displays(), deps.primaryDisplayId(), deps.placement().displayId);
  const frame = (): Rect => {
    const target = display();
    return islandBounds(target, deps.placement().anchor, ISLAND_FRAME, deps.notch(target));
  };
  const place = (): void => {
    const current = live();
    if (current === null) return;
    current.setBounds(frame());
  };

  const stopPolling = (): void => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };
  const insideHitRect = (current: W): boolean => {
    if (hitRect === null) return false;
    const bounds = current.getBounds();
    const cursor = deps.cursor();
    const left = bounds.x + hitRect.x;
    const top = bounds.y + hitRect.y;
    return cursor.x >= left && cursor.x < left + hitRect.width && cursor.y >= top && cursor.y < top + hitRect.height;
  };
  const poll = (): void => {
    const current = live();
    // Окно спрятали мимо контроллера (`window.hide()` в main) или закрыли — опрашивать нечего.
    if (current === null || !current.isVisible()) {
      stopPolling();
      return;
    }
    // Остров тащат — окно едет за курсором и остаётся ловящим мышь, что бы ни говорила область.
    const inside = dragging || insideHitRect(current);
    if (inside === hovered) return;
    hovered = inside;
    current.setIgnoreMouseEvents(!inside, { forward: false });
    deps.onHover(inside);
  };
  const startPolling = (): void => {
    if (pollTimer === null) pollTimer = setInterval(poll, HOVER_POLL_MS);
  };

  const open = (): void => {
    if (live() !== null) return;
    // Перетаскивание и область старого окна не переживают пересоздание (закрытие или падение renderer посреди жеста).
    dragging = false;
    hovered = false;
    hitRect = null;
    stopPolling();
    const created = deps.createWindow();
    created.setAlwaysOnTop(true, 'screen-saver');
    // Прозрачный кадр не ловит клики: ловящим окно делает опрос курсора (`poll`), пока курсор над областью острова.
    created.setIgnoreMouseEvents(true, { forward: false });
    // `setVisibleOnAllWorkspaces` не зовём: Electron на macOS превращает тип процесса, и иконка в Dock / Cmd-Tab может
    // пропасть. `type: 'panel'` и так плавает над полноэкранными приложениями и виден на всех рабочих столах (доки Electron).
    created.on('closed', () => {
      if (window === created) {
        window = null;
        stopPolling();
      }
    });
    // Клавиатура ушла сама (клик в другое приложение) — как Esc. `hide()`/`showInactive()` внутри `setKeyboard(false)` тоже
    // дают blur, но флаг к тому моменту уже снят.
    created.on('blur', () => {
      if (!keyboard || window !== created) return;
      keyboard = false;
      deps.onKeyboardLost();
    });
    created.webContents.on('render-process-gone', () => {
      crashes += 1;
      deps.log(`island renderer gone (${crashes})`);
      if (window === created) {
        window = null;
        stopPolling();
      }
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
      hovered = false;
      stopPolling();
      current?.destroy();
    },
    current: live,
    isIsland: (sender) => {
      const current = live();
      return current !== null && sender === current.webContents;
    },
    setHitRect: (rect) => {
      hitRect = rect;
      // Опрос мог остановиться, пока остров на экране (`isVisible()` на миг дал `false`), а `island:visible` от renderer приходит
      // только при смене значения — без этого окно оставалось бы сквозным до перезапуска. Область шлётся при каждой смене формы.
      const current = live();
      if (rect !== null && pollTimer === null && current !== null && current.isVisible()) {
        deps.log('island hover polling restarted');
        startPolling();
      }
    },
    setVisible: (visible) => {
      const current = live();
      if (current === null) return;
      if (!visible) {
        // Скрыли — жест уже не продолжится; потерянный `drag-end` не должен замораживать место.
        dragging = false;
        stopPolling();
        // Скрытое окно возвращается сквозным: опроса нет, и после показа прозрачный кадр ловил бы клики, пока не придёт
        // первый опрос. Renderer узнаёт об уходе курсора, иначе его «над островом» пережило бы скрытие.
        current.setIgnoreMouseEvents(true, { forward: false });
        if (hovered) {
          hovered = false;
          deps.onHover(false);
        }
        if (current.isVisible()) current.hide();
        return;
      }
      if (!current.isVisible()) {
        place();
        current.showInactive();
      }
      startPolling();
    },
    setKeyboard: (on) => {
      const current = live();
      if (current === null) return;
      keyboard = on;
      if (on) {
        current.setFocusable(true);
        current.focus();
        return;
      }
      current.setFocusable(false);
      // Снять с панели ключевое окно: иначе печать в других приложениях шла бы в никуда. Проба 2026-10-15: hide и
      // showInactive возвращают ввод прежнему приложению, не трогая передний план.
      if (current.isVisible()) {
        current.hide();
        current.showInactive();
        current.setIgnoreMouseEvents(!hovered, { forward: false });
      }
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
      current.setBounds({ x: Math.round(point.screenX - dragOffsetX), y: under.bounds.y, width: ISLAND_FRAME.width, height: ISLAND_FRAME.height });
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
    topInset: () => {
      const target = display();
      // У точек слева и справа на дисплее с вырезом остаётся сегодняшняя полоса (Н-3): вырез — только в центре.
      return notchInset(target, deps.placement().anchor === 'center' ? deps.notch(target) : null);
    },
    anchor: () => deps.placement().anchor,
    notch: () => {
      const target = display();
      const geometry = deps.notch(target);
      if (geometry === null || deps.placement().anchor !== 'center') return null;
      // Кадр стоит в целых точках, поэтому центр выреза внутри него может прийтись на половину точки — её держит CSS.
      return { width: geometry.width, height: geometry.height, centerX: target.bounds.x + geometry.centerX - frame().x };
    },
  };
}
