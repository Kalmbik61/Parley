/**
 * Формат `~/.parley/desktop/ui.json` — состояние окна, не относящееся к
 * конкретной работе: активная работа, сайдбары, уведомления и прочее (спека
 * 3.4, кусок 1.1 плана окна). Хранилище — `main/ui-store.ts`; мост —
 * `ParleyBridge.app.loadUi`/`saveUi`/`setAppearance`.
 */

import { isVoiceLanguage, isVoiceModelId, type VoiceModelId } from './voice-types.js';

export type Appearance = 'system' | 'dark' | 'light';

/** Голосовой ввод (спека 2026-10-06-voice-input-design.md, 3.1): включён только при выбранной модели. */
export interface VoiceUi {
  enabled: boolean;
  model: VoiceModelId | null;
  /** `auto` или код Whisper (`WHISPER_LANGUAGES`). */
  language: string;
}

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
  /**
   * Проверка новой версии на GitHub при старте и раз в сутки (V6 плана релиза 0.1.0, `main/update-check.ts`):
   * `false` — окно в сеть за версией не ходит и тоста не показывает.
   */
  checkForUpdates: boolean;
  /**
   * Версия, чей тост человек закрыл («Later», «Download» или смахнул): о ней больше не напоминаем, а о более
   * новой — да. `null` — ничего не закрыто.
   */
  dismissedUpdate: string | null;
  /** Голосовой ввод (спека 2026-10-06, 3.1). */
  voice: VoiceUi;
}

export const DEFAULT_UI: UiFile = {
  version: 1,
  appearance: 'system',
  leftSidebar: { open: true, width: 288 },
  rightSidebar: { open: true, width: 320, tab: 'files' },
  activeWorkKey: null,
  pinnedWorks: [],
  collapsedProjects: [],
  showDoneWorks: true,
  notifications: { needsYou: true, finished: true, mail: true, sound: true },
  diffView: 'split',
  filesShowIgnored: false,
  lastProvider: null,
  checkForUpdates: true,
  dismissedUpdate: null,
  voice: { enabled: false, model: null, language: 'auto' },
};

/**
 * Пределы левого сайдбара (спека 3.4, 4.4) — оба края статичные, `normalizeUi` приводит ширину сама.
 * `initial` — 288, а не 280 (Organic крупнее на 10%, спека окна 2026-09-29, 1.1); ресайз 220–500 прежний.
 * Сохранённая ширина прежних окон не переписывается — это выбор человека.
 */
export const LEFT_SIDEBAR = { min: 220, max: 500, initial: 288 } as const;
/**
 * Пределы правого сайдбара: верхняя граница — «ширина окна минус `reserveCenter`»,
 * а размер окна `normalizeUi` не знает, поэтому здесь приводится только нижняя
 * граница; верхнюю держит рендерер при ресайзе (этап 2 плана окна).
 */
export const RIGHT_SIDEBAR = { min: 220, initial: 320, reserveCenter: 320 } as const;

/**
 * Ширина правого сайдбара в окне (раунд main-r2, п. 7): центру остаётся не меньше
 * `reserveCenter` — предел «окно − левый сайдбар − reserveCenter», сохранённая ширина
 * ужимается до него. Не влезает и `min` — `null`: сайдбар скрыт на время, сохранённое
 * `open` не трогается, при расширении окна он вернётся. `leftWidth` — 0, если левый закрыт.
 */
export function fitRightSidebar(saved: number, windowWidth: number, leftWidth: number): { width: number; max: number } | null {
  const max = windowWidth - leftWidth - RIGHT_SIDEBAR.reserveCenter;
  if (max < RIGHT_SIDEBAR.min) return null;
  return { width: Math.min(Math.max(saved, RIGHT_SIDEBAR.min), max), max };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAppearance = (value: unknown): value is Appearance =>
  value === 'system' || value === 'dark' || value === 'light';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * `typeof value === 'number'` пропускает `NaN` и `±Infinity` — `Math.max`/
 * `Math.min` с таким аргументом дают `NaN` (спецификация ECMA), и клапан
 * пределов ниже такую ширину не ловит (раунд исправлений 1, находка C2/тест 11).
 * Нечисловые и нефинитные значения поэтому отсекаются ДО клапана, а не внутри
 * него — граница остаётся инвариантом по диапазону, а не «числом минус NaN».
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

function normalizeLeftSidebar(value: unknown): UiFile['leftSidebar'] {
  const source = isRecord(value) ? value : {};
  const open = typeof source.open === 'boolean' ? source.open : DEFAULT_UI.leftSidebar.open;
  const width = isFiniteNumber(source.width)
    ? clamp(source.width, LEFT_SIDEBAR.min, LEFT_SIDEBAR.max)
    : DEFAULT_UI.leftSidebar.width;
  return { open, width };
}

function normalizeRightSidebar(value: unknown): UiFile['rightSidebar'] {
  const source = isRecord(value) ? value : {};
  const open = typeof source.open === 'boolean' ? source.open : DEFAULT_UI.rightSidebar.open;
  // Верхний предел зависит от ширины окна — здесь недоступен, приводим только низ (см. `RIGHT_SIDEBAR`).
  const width = isFiniteNumber(source.width)
    ? Math.max(source.width, RIGHT_SIDEBAR.min)
    : DEFAULT_UI.rightSidebar.width;
  const tab =
    source.tab === 'files' || source.tab === 'changes' ? source.tab : DEFAULT_UI.rightSidebar.tab;
  return { open, width, tab };
}

function normalizeVoice(value: unknown): VoiceUi {
  const source = isRecord(value) ? value : {};
  const model = isVoiceModelId(source.model) ? source.model : null;
  return {
    // Включённый голос без модели нечем распознавать: это «выключен».
    enabled: source.enabled === true && model !== null,
    model,
    language: isVoiceLanguage(source.language) ? source.language : DEFAULT_UI.voice.language,
  };
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
    checkForUpdates:
      typeof source.checkForUpdates === 'boolean' ? source.checkForUpdates : DEFAULT_UI.checkForUpdates,
    dismissedUpdate:
      typeof source.dismissedUpdate === 'string' ? source.dismissedUpdate : DEFAULT_UI.dismissedUpdate,
    voice: normalizeVoice(source.voice),
  };
}
