/**
 * Состояние самого окна: фокус окна (нужен уведомлениям — «сессия … не видна:
 * она не на экране или окно не в фокусе»), видимые терминалы, диалоги и пауза
 * будильника живых сессий (кусок 1.10 плана окна).
 *
 * Выбранной сессии здесь нет с куска 2.7: её выводит `layout/store.ts#selectedSessionOf`
 * из активной работы и её раскладки — отдельная копия могла бы разойтись с тем,
 * что на экране.
 */

import { create } from 'zustand';
import type { HarnasBridge } from '../../shared/bridge.js';
import { applyDarkClass } from '../theme/appearance.js';
import { DEFAULT_UI, normalizeUi, type Appearance, type UiFile } from '../../shared/ui-types.js';

/** Работа, для которой открыт диалог (кусок 3.4). */
export interface DialogWork {
  projectPath: string;
  workId: string;
}

export interface DialogsState {
  /** `projectPath` — проект «+» заголовка группы (кусок 3.5): форма откроется с ним; `null` — ⌘N. */
  newWork: { open: boolean; projectPath: string | null };
  /**
   * `work` — работа диалога: «New session» из меню карточки передаёт свою, и у неактивной
   * карточки диалог не должен уйти в чужую работу; `null` — активная работа (⌘T).
   */
  newSession: { open: boolean; parentSessionId: string | null; work: DialogWork | null };
  settings: boolean;
  /**
   * «Создать комнату с…» (кусок 2.3). `requiredMember` — сессия, с которой открыли пункт
   * меню строки; `null` — «New room» из меню карточки (кусок 3.4), обязательного нет.
   */
  createRoom: { projectPath: string; workId: string; requiredMember: { id: string; label: string } | null } | null;
}

const CLOSED_DIALOGS: DialogsState = {
  newWork: { open: false, projectPath: null },
  newSession: { open: false, parentSessionId: null, work: null },
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
  /** Флаг по событиям `focus`/`blur` окна; начальное — `document.hasFocus()`. */
  windowFocused: boolean;
  /**
   * Документ виден (`visibilitychange`, кусок 4.2): свёрнутое или скрытое окно при фокусе
   * не показывает терминал, и «просмотрено» тогда не ставится (спека 7.2).
   */
  documentVisible: boolean;
  /** `null` — состояние будильника ещё не пришло с хоста. */
  wakePaused: boolean | null;
  dialogs: DialogsState;
  /**
   * Сессии, чей терминал сейчас виден (активная вкладка своей группы,
   * `@harnas/protocol#refKey`) — уведомления считают видимой именно такую
   * сессию. Видимых терминалов может быть несколько, по одному на группу.
   * Пишет только `terminal/TerminalSurface.tsx` (кусок 2.5).
   */
  visibleSessionRefs: Record<string, true>;

  /** Зеркало `ui.json` (кусок 2.3, спека 3.4): до `app.loadUi()` — значения по умолчанию. */
  ui: UiFile;
  /** `true` — `app.loadUi()` уже ответил (или отказал), в `ui` не «слепок по умолчанию», а факт. */
  uiLoaded: boolean;
  paletteOpen: boolean;
  /** `null` — `SessionPicker` закрыт. */
  picker: PickerState | null;
  /**
   * Порядок сайдбара держится (кусок 3.3, спека 6.2): указатель над списком, открыто меню
   * сайдбара или идёт переименование — пересортировка ждёт (`sidebar/use-sidebar-sections.ts`).
   * Ставит только `WorkSidebar`, сводя указатель и `sidebarHolds`.
   */
  sidebarHovering: boolean;
  /**
   * Кто держит порядок помимо указателя (кусок 3.4): открытые меню карточки, строки,
   * секции, комнат и `InlineRename` — по своему id (`sidebar/use-sidebar-hold.ts`). Уход
   * указателя в портал меню — не уход с сайдбара.
   */
  sidebarHolds: Record<string, true>;

  /** Ставит/снимает `.dark` на `<html>` (`applyDarkClass`) и пишет в стор — единственная точка входа для обоих. */
  setDark: (dark: boolean) => void;
  /** `TerminalSurface.tsx` зовёт на каждую смену видимости и `false` при размонтировании. */
  setSessionVisible: (refKey: string, visible: boolean) => void;
  setWindowFocused: (focused: boolean) => void;
  openNewWorkDialog: (projectPath?: string) => void;
  closeNewWorkDialog: () => void;
  openNewSessionDialog: (parentSessionId: string | null, work?: DialogWork) => void;
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
  setSidebarHovering: (hovering: boolean) => void;
  setSidebarHold: (id: string, on: boolean) => void;

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
    windowFocused: typeof document === 'undefined' ? true : document.hasFocus(),
    documentVisible: typeof document === 'undefined' ? true : document.visibilityState === 'visible',
    wakePaused: null,
    dialogs: CLOSED_DIALOGS,
    visibleSessionRefs: {},
    ui: DEFAULT_UI,
    uiLoaded: false,
    paletteOpen: false,
    picker: null,
    sidebarHovering: false,
    sidebarHolds: {},

    setDark: (dark) => {
      applyDarkClass(dark);
      set({ dark });
    },

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

    openNewWorkDialog: (projectPath) =>
      set((state) => ({ dialogs: { ...state.dialogs, newWork: { open: true, projectPath: projectPath ?? null } } })),
    closeNewWorkDialog: () =>
      set((state) => ({ dialogs: { ...state.dialogs, newWork: { open: false, projectPath: null } } })),
    openNewSessionDialog: (parentSessionId, work) =>
      set((state) => ({
        dialogs: { ...state.dialogs, newSession: { open: true, parentSessionId, work: work ?? null } },
      })),
    closeNewSessionDialog: () =>
      set((state) => ({
        dialogs: { ...state.dialogs, newSession: { open: false, parentSessionId: null, work: null } },
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
    setSidebarHovering: (hovering) => set({ sidebarHovering: hovering }),
    setSidebarHold: (id, on) =>
      set((state) => {
        if (on === (id in state.sidebarHolds)) return state;
        if (on) return { sidebarHolds: { ...state.sidebarHolds, [id]: true } };
        return { sidebarHolds: Object.fromEntries(Object.entries(state.sidebarHolds).filter(([key]) => key !== id)) };
      }),

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
      const onVisibility = (): void => set({ documentVisible: document.visibilityState === 'visible' });
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);
      document.addEventListener('visibilitychange', onVisibility);

      return () => {
        disposed = true;
        unsubscribeWake();
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
});
