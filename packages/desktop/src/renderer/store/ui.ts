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
import type { ParleyBridge } from '../../shared/bridge.js';
import { applyDarkClass } from '../theme/appearance.js';
import { DEFAULT_UI, normalizeUi, type Appearance, type UiFile } from '../../shared/ui-types.js';

/** Работа, для которой открыт диалог (кусок 3.4). */
export interface DialogWork {
  projectPath: string;
  workId: string;
}

/** Ephemeral prepared backlog context. The shared row already has a stable ID before creation. */
export interface BacklogTakeContext { projectPath: string; id: string; version: string; task: string }

/** Вкладки диалога настроек: `openSettingsDialog(section)` открывает его на нужной. */
export type SettingsSection = 'appearance' | 'terminal' | 'agents' | 'notifications' | 'browser' | 'voice';

export interface DialogsState {
  /**
   * `projectPath` — проект «+» заголовка группы (кусок 3.5): форма откроется с ним; `null` — ⌘N.
   * `title` — начальное название: «Create workspace …» палитры (кусок 6.2); `''` — пусто.
   */
  newWork: { open: boolean; projectPath: string | null; title: string };
  /**
   * Диалог «New session or room» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.5). `work` — работа диалога:
   * «New session» из меню карточки передаёт свою, и у неактивной карточки диалог не должен уйти в чужую работу;
   * `null` — активная работа (⌘T). `room` — «New room» (меню карточки, палитра): диалог открывается сразу с двумя
   * агентами, то есть комнатой.
   */
  newSession: { open: boolean; work: DialogWork | null; room: boolean; backlog?: BacklogTakeContext };
  settings: boolean;
  /**
   * Диалог «New room» из двух сессий (1.6): сессию `dragged` бросили на сессию `target` той же работы; `null` — диалог
   * закрыт. Название и ведущий — состояние самого диалога: в стор попадает только то, что нужно, чтобы его открыть.
   */
  mergeRoom: (DialogWork & { dragged: string; target: string }) | null;
  /**
   * Подтверждение перезапуска хоста (кусок 6.3): одно на «Host is outdated — restart» строки
   * статуса и действие палитры `host.restart`. Строка статуса с 4.2 работает на пропах —
   * поэтому состояние здесь, а не в её `useState`.
   */
  restartHost: boolean;
}

const CLOSED_DIALOGS: DialogsState = {
  newWork: { open: false, projectPath: null, title: '' },
  newSession: { open: false, work: null, room: false },
  settings: false,
  mergeRoom: null,
  restartHost: false,
};

export interface UiState {
  /**
   * Единственный источник тёмности в рендерере (спека 4.7, раунд исправлений 1
   * куска 1.1): терминал (кусок 1.3) и Monaco (кусок 7.3) берут тему отсюда, а
   * не читают `matchMedia` каждый сам по себе. Начальное значение — системное
   * предпочтение; до первого кадра React `main.tsx` заменяет его тёмностью
   * `nativeTheme` main (`followAppearance`, раунд main-r2) и ставит `.dark` на `<html>`.
   */
  dark: boolean;
  /**
   * Флаг по событиям `focus`/`blur` окна; начальное — `document.hasFocus()`. Фокус в странице
   * вкладки браузера окно из фокуса не выводит (спека 7.2, кусок 9.2b): DOM-`blur` при
   * `activeElement` — `<webview>` флаг не снимает, `browser:focus` и `app:window-focus` main — ставят.
   */
  windowFocused: boolean;
  /**
   * Документ виден (`visibilitychange`, кусок 4.2): свёрнутое или скрытое окно при фокусе
   * не показывает терминал, и «просмотрено» тогда не ставится (спека 7.2).
   */
  documentVisible: boolean;
  /** `null` — состояние будильника ещё не пришло с хоста. */
  wakePaused: boolean | null;
  dialogs: DialogsState;
  /** Selected project panel, only in window memory. */
  projectPanel: string | null;
  openProjectPanel(projectPath: string): void;
  closeProjectPanel(): void;
  /** Вкладка, с которой откроются настройки (`openSettingsDialog(section)`). */
  settingsSection: SettingsSection;
  /**
   * Сессии, чей терминал сейчас виден (активная вкладка своей группы,
   * `@parley/protocol#refKey`) — уведомления считают видимой именно такую
   * сессию. Видимых терминалов может быть несколько, по одному на группу.
   * Пишет только `terminal/TerminalSurface.tsx` (кусок 2.5).
   */
  visibleSessionRefs: Record<string, true>;
  /**
   * Черновики полей ввода комнат (дизайн комнат, 3.4): ключ — `lib/room-view.ts#roomKey`, значение — текст
   * поля с токенами `@s02`. Только в памяти окна, в `ui.json` не пишутся: переживают смену вкладок
   * и работ (тело комнаты при этом размонтируется), но не перезапуск окна. Пустого черновика в
   * записи нет.
   */
  composerDrafts: Record<string, string>;
  /**
   * Вложения поля ввода комнаты — абсолютные пути (скрепка и файлы, брошенные на вкладку комнаты), по тому же ключу и с
   * той же жизнью, что черновик: в памяти окна, переживают смену вкладок. Пустого списка в записи нет.
   */
  composerAttachments: Record<string, readonly string[]>;

  /** Зеркало `ui.json` (кусок 2.3, спека 3.4): до `app.loadUi()` — значения по умолчанию. */
  ui: UiFile;
  /** `true` — `app.loadUi()` уже ответил (или отказал), в `ui` не «слепок по умолчанию», а факт. */
  uiLoaded: boolean;
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
  /**
   * Временный показ архивных работ (кусок 6.3, спека 6.7): в памяти окна до перезапуска, не в
   * `ui.json`. Счётчики, бейдж, `attention.next` и выбор соседа архивные не берут и при нём.
   */
  showArchived: boolean;
  /**
   * Развёрнутость строк комнат в карточках сайдбара (кусок 5 плана «Organic», спека окна 2026-09-29, 2.6 и 3.4):
   * ручной шеврон и клик по строке комнаты перекрывают правило «развёрнута, пока открыта вкладка комнаты или её
   * участника» до перезапуска окна. Ключ — `lib/room-view.ts#roomKey`; нет ключа — решает правило. Только в
   * памяти: в `ui.json` не пишется.
   */
  roomExpanded: Record<string, boolean>;

  /** Ставит/снимает `.dark` на `<html>` (`applyDarkClass`) и пишет в стор — единственная точка входа для обоих. */
  setDark: (dark: boolean) => void;
  /** `TerminalSurface.tsx` зовёт на каждую смену видимости и `false` при размонтировании. */
  setSessionVisible: (refKey: string, visible: boolean) => void;
  setWindowFocused: (focused: boolean) => void;
  /** Поле ввода комнаты зовёт на каждую правку; пустой текст убирает запись. */
  setComposerDraft: (draftKey: string, draft: string) => void;
  /** Вложения поля ввода комнаты; пустой список убирает запись. */
  setComposerAttachments: (draftKey: string, paths: readonly string[]) => void;
  openNewWorkDialog: (projectPath?: string | null, title?: string) => void;
  closeNewWorkDialog: () => void;
  /** `work` — работа диалога (`null` — активная); `room` — открыть сразу комнатой, с двумя агентами. */
  openNewSessionDialog: (work?: DialogWork, options?: { room?: boolean; backlog?: BacklogTakeContext }) => void;
  closeNewSessionDialog: () => void;
  openSettingsDialog: (section?: SettingsSection) => void;
  closeSettingsDialog: () => void;
  openMergeRoomDialog: (input: NonNullable<DialogsState['mergeRoom']>) => void;
  closeMergeRoomDialog: () => void;
  confirmRestartHost: () => void;
  closeRestartHostDialog: () => void;
  toggleShowArchived: () => void;
  setRoomExpanded: (key: string, expanded: boolean) => void;
  toggleWake: (bridge: ParleyBridge) => Promise<void>;

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
  /**
   * Сливает патч с объектом сайдбара из зеркала и отдаёт его целиком в `patchUi`. `tab` есть
   * только у правого (кусок 7.2); у левого он отбрасывается, а не уходит лишним ключом в ui.json.
   */
  setSidebar: (side: 'left' | 'right', patch: { open?: boolean; width?: number; tab?: 'files' | 'changes' }) => void;
  setSidebarHovering: (hovering: boolean) => void;
  setSidebarHold: (id: string, on: boolean) => void;

  /**
   * Подписывается на фокус окна и `wake.changed`, спрашивает `wake.state`
   * разом, грузит `ui.json` в зеркало; возвращает отписку. `bridge` заодно
   * запоминается для `patchUi`/`setAppearance`/`setSidebar` — им он тоже
   * нужен, а передавать его через каждый вызов от каждой кнопки заголовка и
   * диалога было бы тем же самым, только многословнее.
   */
  init: (bridge: ParleyBridge) => () => void;
}

export const useUiStore = create<UiState>((set, get) => {
  // Не часть реактивного состояния — тот же приём, что `closeGuard` в
  // `layout/store.ts`: разовая ссылка на мост, а не данные, за которыми
  // должны следить подписки. Ставится в `init`, живёт весь жизненный цикл
  // окна (`window.parley` не меняется), поэтому сбрасывать её на отписку
  // не нужно — переподключение хоста эту ссылку не трогает (запись
  // `ui.json` идёт в main-процесс напрямую, а не через хост).
  let bridgeRef: ParleyBridge | null = null;

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
    projectPanel: null,
    openProjectPanel: (projectPath) => set({ projectPanel: projectPath }),
    closeProjectPanel: () => set({ projectPanel: null }),
    settingsSection: 'appearance',
    visibleSessionRefs: {},
    composerDrafts: {},
    composerAttachments: {},
    ui: DEFAULT_UI,
    uiLoaded: false,
    sidebarHovering: false,
    sidebarHolds: {},
    showArchived: false,
    roomExpanded: {},

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

    setComposerDraft: (draftKey, draft) =>
      set((state) => {
        // Тот же текст — тот же стор: поле ввода зовёт это на каждый `input`, а подписчики не должны
        // перерисовываться зря.
        if ((state.composerDrafts[draftKey] ?? '') === draft) return state;
        if (draft === '') {
          return { composerDrafts: Object.fromEntries(Object.entries(state.composerDrafts).filter(([key]) => key !== draftKey)) };
        }
        return { composerDrafts: { ...state.composerDrafts, [draftKey]: draft } };
      }),

    setComposerAttachments: (draftKey, paths) =>
      set((state) => {
        if ((state.composerAttachments[draftKey] ?? []) === paths) return state;
        if (paths.length === 0) {
          return { composerAttachments: Object.fromEntries(Object.entries(state.composerAttachments).filter(([key]) => key !== draftKey)) };
        }
        return { composerAttachments: { ...state.composerAttachments, [draftKey]: paths } };
      }),

    openNewWorkDialog: (projectPath, title) =>
      set((state) => ({
        dialogs: { ...state.dialogs, newWork: { open: true, projectPath: projectPath ?? null, title: title ?? '' } },
      })),
    closeNewWorkDialog: () =>
      set((state) => ({ dialogs: { ...state.dialogs, newWork: { open: false, projectPath: null, title: '' } } })),
    openNewSessionDialog: (work, options) =>
      set((state) => ({
        dialogs: { ...state.dialogs, newSession: { open: true, work: work ?? null, room: options?.room === true, ...(options?.backlog ? { backlog: options.backlog } : {}) } },
      })),
    closeNewSessionDialog: () =>
      set((state) => ({
        dialogs: { ...state.dialogs, newSession: { open: false, work: null, room: false } },
      })),
    openSettingsDialog: (section) =>
      set((state) => ({ dialogs: { ...state.dialogs, settings: true }, settingsSection: section ?? 'appearance' })),
    closeSettingsDialog: () => set((state) => ({ dialogs: { ...state.dialogs, settings: false } })),
    openMergeRoomDialog: (input) => set((state) => ({ dialogs: { ...state.dialogs, mergeRoom: input } })),
    closeMergeRoomDialog: () => set((state) => ({ dialogs: { ...state.dialogs, mergeRoom: null } })),
    confirmRestartHost: () => set((state) => ({ dialogs: { ...state.dialogs, restartHost: true } })),
    closeRestartHostDialog: () => set((state) => ({ dialogs: { ...state.dialogs, restartHost: false } })),
    toggleShowArchived: () => set((state) => ({ showArchived: !state.showArchived })),
    setRoomExpanded: (key, expanded) =>
      set((state) => (state.roomExpanded[key] === expanded ? state : { roomExpanded: { ...state.roomExpanded, [key]: expanded } })),

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
        const left = {
          ...current.leftSidebar,
          ...(patch.open === undefined ? {} : { open: patch.open }),
          ...(patch.width === undefined ? {} : { width: patch.width }),
        };
        get().patchUi({ leftSidebar: left });
      } else {
        get().patchUi({ rightSidebar: { ...current.rightSidebar, ...patch } });
      }
    },

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
      // Фокус ушёл в страницу <webview>: DOM окна видит blur, а человек по-прежнему смотрит в окно.
      const onBlur = (): void => {
        if (document.activeElement?.tagName === 'WEBVIEW') return;
        set({ windowFocused: false });
      };
      const onVisibility = (): void => set({ documentVisible: document.visibilityState === 'visible' });
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);
      document.addEventListener('visibilitychange', onVisibility);
      // Уход из приложения при фокусе в странице DOM окна не показывает, а focus и blur WebContents
      // на macOS при смене окон не приходят: его приносит main (BrowserWindow focus/blur).
      const unsubscribeWindowFocus = bridge.app.onWindowFocus((focused) => set({ windowFocused: focused }));
      const unsubscribeBrowserFocus = bridge.browser.onFocus(() => set({ windowFocused: true }));

      return () => {
        disposed = true;
        unsubscribeWake();
        unsubscribeWindowFocus();
        unsubscribeBrowserFocus();
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
});
