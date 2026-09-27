/**
 * Состояние самого окна: выбор в сайдбаре, фокус окна (нужен уведомлениям —
 * «сессия … не видна: она не выбрана или окно не в фокусе»), диалоги и пауза
 * будильника живых сессий (кусок 1.10 плана окна).
 *
 * `selectedRef`/`selectedWorkKey` с куска 2.1 плана окна больше не «единственная
 * открытая панель» (панелей теперь много, `Workspace.tsx`) — это адрес АКТИВНОЙ
 * панели сетки, если она терминальная; их выставляет сам `Workspace` по событию
 * dockview `onDidActivePanelChange`, а не сайдбар напрямую. Сайдбар и ⌘1…⌘9
 * по-прежнему читают их для подсветки и для «последней сессии работы».
 */

import { create } from 'zustand';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { applyDarkClass } from '../theme/appearance.js';
import { DEFAULT_UI, normalizeUi, type Appearance, type UiFile } from '../../shared/ui-types.js';

/** Сколько последних сессий держать для палитры ⌘K (кусок 2.3) — больше и не показать за один экран списка. */
const RECENT_SESSIONS_LIMIT = 20;

export interface DialogsState {
  newWork: boolean;
  newSession: { open: boolean; parentSessionId: string | null };
  settings: boolean;
  /** «Создать комнату с…» (кусок 2.3, до 3.4 обязателен участник — сессия, с которой открыли пункт меню). */
  createRoom: { projectPath: string; workId: string; requiredMember: { id: string; label: string } } | null;
}

const CLOSED_DIALOGS: DialogsState = {
  newWork: false,
  newSession: { open: false, parentSessionId: null },
  settings: false,
  createRoom: null,
};

/** Выбор сессии для ⌘D/⇧⌘D (`SessionPicker`, кусок 2.3) — что показывает `AppShell`. */
export interface PickerState {
  workKey: string;
  direction: 'right' | 'down';
  /** id сессий, у которых уже открыт терминал в этой работе — не кандидаты (спека 5.2). */
  openSessionIds: string[];
}

export interface UiState {
  /**
   * Единственный источник тёмности в рендерере (спека 4.7, раунд исправлений 1
   * куска 1.1): терминал (кусок 1.3) и Monaco (кусок 7.3) берут тему отсюда, а
   * не читают `matchMedia` каждый сам по себе. Начальное значение — системное
   * предпочтение; `main.tsx` синхронизирует `.dark` на `<html>` тем же полем
   * до первого кадра React.
   */
  dark: boolean;
  selectedRef: SessionRef | null;
  /** Работа выбранной сессии — ключ `lib/tree-order.ts#workKey`. */
  selectedWorkKey: string | null;
  windowFocused: boolean;
  /** `null` — состояние будильника ещё не пришло с хоста. */
  wakePaused: boolean | null;
  dialogs: DialogsState;
  /** Последняя открытая сессия каждой работы: для ⌘1…⌘9 (кусок 1.11). */
  lastSessionByWork: Record<string, string>;
  /** id активной панели сетки (`lib/panel-id.ts#panelId`) — `null`, если панелей нет вовсе (кусок 2.1). */
  activePanelId: string | null;
  /**
   * Сессии, чья панель терминала сейчас видна (активная вкладка своей группы,
   * `@harnas/protocol#refKey`) — кусок 2.1, «Уведомления теперь считают
   * видимой сессию, у которой видна панель в сетке, а не выбранную в
   * сайдбаре». В отличие от `activePanelId` (панель ОДНА — с фокусом), видимых
   * панелей в сетке может быть несколько одновременно, по одной на группу.
   */
  visibleSessionRefs: Record<string, true>;
  /**
   * Последние выбранные сессии, самая свежая первой — палитра ⌘K показывает
   * их первыми при пустом запросе (кусок 2.3, спека 5.2). Пишется там же,
   * где и `lastSessionByWork` (`selectSession`, на каждую активацию панели
   * терминала в сетке), но это отдельный список: `lastSessionByWork` держит
   * только ПО ОДНОЙ сессии на работу, а тут нужен общий порядок по всем
   * работам сразу.
   */
  recentSessionRefs: readonly SessionRef[];

  /** Зеркало `ui.json` (кусок 2.3, спека 3.4): до `app.loadUi()` — значения по умолчанию. */
  ui: UiFile;
  /** `true` — `app.loadUi()` уже ответил (или отказал), в `ui` не «слепок по умолчанию», а факт. */
  uiLoaded: boolean;
  paletteOpen: boolean;
  /** `null` — `SessionPicker` закрыт. */
  picker: PickerState | null;

  /** Ставит/снимает `.dark` на `<html>` (`applyDarkClass`) и пишет в стор — единственная точка входа для обоих. */
  setDark: (dark: boolean) => void;
  selectSession: (workKey: string, ref: SessionRef) => void;
  /** `Workspace.tsx` зовёт на каждую смену активной панели dockview. */
  setActivePanelId: (id: string | null) => void;
  /** `panel-registry.tsx` зовёт при каждом `onDidActiveChange` панели терминала и при её закрытии. */
  setSessionVisible: (refKey: string, visible: boolean) => void;
  setWindowFocused: (focused: boolean) => void;
  openNewWorkDialog: () => void;
  closeNewWorkDialog: () => void;
  openNewSessionDialog: (parentSessionId: string | null) => void;
  closeNewSessionDialog: () => void;
  openSettingsDialog: () => void;
  closeSettingsDialog: () => void;
  openCreateRoomDialog: (input: NonNullable<DialogsState['createRoom']>) => void;
  closeCreateRoomDialog: () => void;
  toggleWake: (bridge: HarnasBridge) => Promise<void>;

  /**
   * Единственный путь записи `ui.json` из рендерера (кроме `setAppearance`
   * ниже): патч сразу сливается в зеркало `ui` (через `normalizeUi`, как и
   * `main/ui-store.ts`), а сырой патч уходит в `app.saveUi` — main сам
   * сольёт его со своей копией на диске. Массивы и вложенные объекты
   * (`leftSidebar` и т. п.) берутся из ТЕКУЩЕГО зеркала, а не из копии,
   * которая могла устареть у вызывающего компонента, поэтому `setSidebar`
   * ниже читает `get().ui`, а не свой параметр целиком.
   */
  patchUi: (patch: Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>) => void;
  /** `app.setAppearance` (ui.json пишет main, кусок 1.1) и `appearance` в зеркале. */
  setAppearance: (mode: Appearance) => void;
  /** Сливает патч с объектом сайдбара из зеркала и отдаёт его целиком в `patchUi`. */
  setSidebar: (side: 'left' | 'right', patch: { open?: boolean; width?: number }) => void;
  setPaletteOpen: (open: boolean) => void;
  openPicker: (picker: PickerState) => void;
  closePicker: () => void;

  /**
   * Подписывается на фокус окна и `wake.changed`, спрашивает `wake.state`
   * разом, грузит `ui.json` в зеркало; возвращает отписку. `bridge` заодно
   * запоминается для `patchUi`/`setAppearance`/`setSidebar` — им он тоже
   * нужен, а передавать его через каждый вызов от каждой кнопки заголовка и
   * диалога было бы тем же самым, только многословнее.
   */
  init: (bridge: HarnasBridge) => () => void;
}

export const useUiStore = create<UiState>((set, get) => {
  // Не часть реактивного состояния — тот же приём, что `closeGuard` в
  // `layout/store.ts`: разовая ссылка на мост, а не данные, за которыми
  // должны следить подписки. Ставится в `init`, живёт весь жизненный цикл
  // окна (`window.harnas` не меняется), поэтому сбрасывать её на отписку
  // не нужно — переподключение хоста эту ссылку не трогает (запись
  // `ui.json` идёт в main-процесс напрямую, а не через хост).
  let bridgeRef: HarnasBridge | null = null;

  return {
    // `matchMedia` не определён в jsdom (тесты рендерера) — как и `document`
    // выше в `windowFocused`, читаем его защищённо: в настоящем окне Electron
    // (полноценный Chromium) он есть всегда, а в тестах стор просто не должен
    // падать при импорте.
    dark:
      typeof matchMedia === 'undefined' ? false : matchMedia('(prefers-color-scheme: dark)').matches,
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: typeof document === 'undefined' ? true : document.hasFocus(),
    wakePaused: null,
    dialogs: CLOSED_DIALOGS,
    lastSessionByWork: {},
    activePanelId: null,
    visibleSessionRefs: {},
    recentSessionRefs: [],
    ui: DEFAULT_UI,
    uiLoaded: false,
    paletteOpen: false,
    picker: null,

    setDark: (dark) => {
      applyDarkClass(dark);
      set({ dark });
    },

    selectSession: (workKey, ref) =>
      set((state) => {
        const key = refKey(ref);
        const withoutCurrent = state.recentSessionRefs.filter((item) => refKey(item) !== key);
        return {
          selectedRef: ref,
          selectedWorkKey: workKey,
          lastSessionByWork: { ...state.lastSessionByWork, [workKey]: ref.sessionId },
          recentSessionRefs: [ref, ...withoutCurrent].slice(0, RECENT_SESSIONS_LIMIT),
        };
      }),

    setActivePanelId: (id) => set({ activePanelId: id }),

    setSessionVisible: (key, visible) =>
      set((state) => {
        if (!visible) {
          if (!(key in state.visibleSessionRefs)) return state;
          const rest = Object.fromEntries(
            Object.entries(state.visibleSessionRefs).filter(([entryKey]) => entryKey !== key),
          );
          return { visibleSessionRefs: rest };
        }
        return { visibleSessionRefs: { ...state.visibleSessionRefs, [key]: true } };
      }),

    setWindowFocused: (focused) => set({ windowFocused: focused }),

    openNewWorkDialog: () => set((state) => ({ dialogs: { ...state.dialogs, newWork: true } })),
    closeNewWorkDialog: () => set((state) => ({ dialogs: { ...state.dialogs, newWork: false } })),
    openNewSessionDialog: (parentSessionId) =>
      set((state) => ({
        dialogs: { ...state.dialogs, newSession: { open: true, parentSessionId } },
      })),
    closeNewSessionDialog: () =>
      set((state) => ({
        dialogs: { ...state.dialogs, newSession: { open: false, parentSessionId: null } },
      })),
    openSettingsDialog: () => set((state) => ({ dialogs: { ...state.dialogs, settings: true } })),
    closeSettingsDialog: () => set((state) => ({ dialogs: { ...state.dialogs, settings: false } })),
    openCreateRoomDialog: (input) => set((state) => ({ dialogs: { ...state.dialogs, createRoom: input } })),
    closeCreateRoomDialog: () => set((state) => ({ dialogs: { ...state.dialogs, createRoom: null } })),

    toggleWake: async (bridge) => {
      const paused = get().wakePaused;
      const result =
        paused === true ? await bridge.call('wake.resume', {}) : await bridge.call('wake.pause', {});
      set({ wakePaused: result.paused });
    },

    patchUi: (patch) => {
      set((state) => ({ ui: normalizeUi({ ...state.ui, ...patch }) }));
      // Сырой патч, а не слитое зеркало: main сам знает своё текущее
      // содержимое диска и сольёт с ним ровно эти ключи (`main/ui-store.ts`,
      // `mergeUiPatch`) — отправка уже слитого зеркала переписала бы поля,
      // которые с диска мог поменять кто-то другой (тест 8: два патча по
      // одному ключу должны дойти до `app.saveUi` порознь).
      bridgeRef?.app.saveUi(patch).catch(() => {
        // Не критично: следующий успешный `patchUi` снова попробует сохранить.
      });
    },

    setAppearance: (mode) => {
      set((state) => ({ ui: { ...state.ui, appearance: mode } }));
      bridgeRef?.app.setAppearance(mode).catch(() => {
        // Main уже перекрасил бы тему сам при живой записи — здесь только не падать.
      });
    },

    setSidebar: (side, patch) => {
      const current = get().ui;
      if (side === 'left') {
        get().patchUi({ leftSidebar: { ...current.leftSidebar, ...patch } });
      } else {
        get().patchUi({ rightSidebar: { ...current.rightSidebar, ...patch } });
      }
    },

    setPaletteOpen: (open) => set({ paletteOpen: open }),
    openPicker: (picker) => set({ picker }),
    closePicker: () => set({ picker: null }),

    init: (bridge) => {
      bridgeRef = bridge;
      let disposed = false;
      bridge
        .call('wake.state', {})
        .then((result) => {
          if (!disposed) set({ wakePaused: result.paused });
        })
        .catch(() => {
          // Строка статуса просто не покажет состояние будильника — не повод падать.
        });
      const unsubscribeWake = bridge.on('wake.changed', ({ paused }) => set({ wakePaused: paused }));

      bridge.app
        .loadUi()
        .then((ui) => {
          if (!disposed) set({ ui, uiLoaded: true });
        })
        .catch(() => {
          // Зеркало остаётся на DEFAULT_UI — окно всё равно должно открыться.
          if (!disposed) set({ uiLoaded: true });
        });

      const onFocus = (): void => set({ windowFocused: true });
      const onBlur = (): void => set({ windowFocused: false });
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);

      return () => {
        disposed = true;
        unsubscribeWake();
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
      };
    },
  };
});
