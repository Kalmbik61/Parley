/**
 * Формат `~/.harnas/desktop/ui.json` — состояние окна, не относящееся к
 * конкретной работе: активная работа, сайдбары, уведомления и прочее (спека
 * 3.4, кусок 1.1 плана окна). Хранилище — `main/ui-store.ts`; мост —
 * `HarnasBridge.app.loadUi`/`saveUi`/`setAppearance`.
 */

export type Appearance = 'system' | 'dark' | 'light';

export interface UiFile {
  version: 1;
  appearance: Appearance;
  leftSidebar: { open: boolean; width: number };
  rightSidebar: { open: boolean; width: number; tab: 'files' | 'changes' };
  activeWorkKey: string | null;
  pinnedWorks: string[];
  collapsedProjects: string[];
  showDoneWorks: boolean;
  notifications: { needsYou: boolean; finished: boolean; mail: boolean; sound: boolean };
  diffView: 'inline' | 'split';
  filesShowIgnored: boolean;
  lastProvider: string | null;
}

export const DEFAULT_UI: UiFile = {
  version: 1,
  appearance: 'system',
  leftSidebar: { open: true, width: 280 },
  rightSidebar: { open: true, width: 350, tab: 'files' },
  activeWorkKey: null,
  pinnedWorks: [],
  collapsedProjects: [],
  showDoneWorks: true,
  notifications: { needsYou: true, finished: true, mail: true, sound: true },
  diffView: 'split',
  filesShowIgnored: false,
  lastProvider: null,
};

/** Пределы левого сайдбара (спека 3.4, 4.4) — оба края статичные, `normalizeUi` приводит ширину сама. */
export const LEFT_SIDEBAR = { min: 220, max: 500, initial: 280 } as const;
/**
 * Пределы правого сайдбара: верхняя граница — «ширина окна минус `reserveCenter`»,
 * а размер окна `normalizeUi` не знает, поэтому здесь приводится только нижняя
 * граница; верхнюю держит рендерер при ресайзе (этап 2 плана окна).
 */
export const RIGHT_SIDEBAR = { min: 220, initial: 350, reserveCenter: 320 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAppearance = (value: unknown): value is Appearance =>
  value === 'system' || value === 'dark' || value === 'light';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function normalizeLeftSidebar(value: unknown): UiFile['leftSidebar'] {
  const source = isRecord(value) ? value : {};
  const open = typeof source.open === 'boolean' ? source.open : DEFAULT_UI.leftSidebar.open;
  const width =
    typeof source.width === 'number'
      ? clamp(source.width, LEFT_SIDEBAR.min, LEFT_SIDEBAR.max)
      : DEFAULT_UI.leftSidebar.width;
  return { open, width };
}

function normalizeRightSidebar(value: unknown): UiFile['rightSidebar'] {
  const source = isRecord(value) ? value : {};
  const open = typeof source.open === 'boolean' ? source.open : DEFAULT_UI.rightSidebar.open;
  // Верхний предел зависит от ширины окна — здесь недоступен, приводим только низ (см. `RIGHT_SIDEBAR`).
  const width =
    typeof source.width === 'number'
      ? Math.max(source.width, RIGHT_SIDEBAR.min)
      : DEFAULT_UI.rightSidebar.width;
  const tab =
    source.tab === 'files' || source.tab === 'changes' ? source.tab : DEFAULT_UI.rightSidebar.tab;
  return { open, width, tab };
}

function normalizeNotifications(value: unknown): UiFile['notifications'] {
  const source = isRecord(value) ? value : {};
  const bool = (key: keyof UiFile['notifications']): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_UI.notifications[key];
  return {
    needsYou: bool('needsYou'),
    finished: bool('finished'),
    mail: bool('mail'),
    sound: bool('sound'),
  };
}

/**
 * Приводит сырой JSON `ui.json` к `UiFile`: неизвестные ключи выкинуты (результат
 * собирается по известной схеме, а не копированием входа), неверные значения —
 * по умолчанию, ширины сайдбаров — в пределах (план куска 1.1, «ui.json»).
 */
export function normalizeUi(raw: unknown): UiFile {
  const source = isRecord(raw) ? raw : {};
  return {
    version: 1,
    appearance: isAppearance(source.appearance) ? source.appearance : DEFAULT_UI.appearance,
    leftSidebar: normalizeLeftSidebar(source.leftSidebar),
    rightSidebar: normalizeRightSidebar(source.rightSidebar),
    activeWorkKey:
      typeof source.activeWorkKey === 'string' ? source.activeWorkKey : DEFAULT_UI.activeWorkKey,
    pinnedWorks: isStringArray(source.pinnedWorks) ? source.pinnedWorks : DEFAULT_UI.pinnedWorks,
    collapsedProjects: isStringArray(source.collapsedProjects)
      ? source.collapsedProjects
      : DEFAULT_UI.collapsedProjects,
    showDoneWorks:
      typeof source.showDoneWorks === 'boolean' ? source.showDoneWorks : DEFAULT_UI.showDoneWorks,
    notifications: normalizeNotifications(source.notifications),
    diffView:
      source.diffView === 'inline' || source.diffView === 'split'
        ? source.diffView
        : DEFAULT_UI.diffView,
    filesShowIgnored:
      typeof source.filesShowIgnored === 'boolean'
        ? source.filesShowIgnored
        : DEFAULT_UI.filesShowIgnored,
    lastProvider:
      typeof source.lastProvider === 'string' ? source.lastProvider : DEFAULT_UI.lastProvider,
  };
}
