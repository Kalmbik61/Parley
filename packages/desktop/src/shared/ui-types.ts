/**
 * Формат `~/.parley/desktop/ui.json` — состояние окна, не относящееся к
 * конкретной работе: активная работа, сайдбары, уведомления и прочее (спека
 * 3.4, кусок 1.1 плана окна). Хранилище — `main/ui-store.ts`; мост —
 * `ParleyBridge.app.loadUi`/`saveUi`/`setAppearance`.
 */

import type { AssistantLanguage } from '@parley/core/assistant';
import { DEFAULT_VOICE, isAssistantVoiceId, TTS_VOICES, type AssistantVoiceId, type TtsVoice } from './tts-types.js';
import { isVoiceLanguage, isVoiceModelId, type VoiceModelId } from './voice-types.js';

export type Appearance = 'system' | 'dark' | 'light';

/** Голосовой ввод (спека 2026-10-06-voice-input-design.md, 3.1): включён только при выбранной модели. */
export interface VoiceUi {
  enabled: boolean;
  model: VoiceModelId | null;
  /** `auto` или код Whisper (`WHISPER_LANGUAGES`). */
  language: string;
}

/** Вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.8): высота панели Console | Network — общая. */
export interface BrowserUi {
  /** null — 40 % высоты вкладки (`DEVTOOLS_PANEL.defaultShare`). */
  devtoolsHeight: number | null;
  /** «Let agents use the browser» (спека 4.8): выключен — все операции агента получают `access_denied`. */
  agentsAllowed: boolean;
}

/** Точка острова у верхнего края монитора (спека острова, раздел 4). */
export type IslandAnchor = 'left' | 'center' | 'right';

/** Палитра сигналов острова (#9 §3.2): тоника и тембр одного набора рецептов (`renderer/island/sound/palettes.ts`). */
export type IslandSoundPalette = 'soft' | 'crystal' | 'warm';

/** Движение острова (#9 §4.5): `system` — по системному `prefers-reduced-motion`, `reduce` — уменьшенное всегда. */
export type IslandMotion = 'system' | 'reduce';

/**
 * Звуки острова (#9 §5). Звук запросов и Done острова включают переключатели `notifications.sound` и
 * `notifications.finishedSound`, отдельного «звук острова вкл/выкл» нет.
 */
export interface IslandSoundUi {
  palette: IslandSoundPalette;
  /** Общая громкость сигналов острова, 0–1; 0 — то же, что выключено. */
  volume: number;
  /** «Interface sounds»: наведение, открыть/закрыть, начало работы. */
  ui: boolean;
}

/**
 * Остров одобрений (спека 2026-10-12): включён ли (по умолчанию да — у всех, включая обновившихся), где стоит
 * (`displayId` — id монитора Electron, `null` — основной; `anchor` — точка у его верхнего края).
 */
export interface IslandUi {
  enabled: boolean;
  displayId: number | null;
  anchor: IslandAnchor;
  /** null disables the pending queue global shortcut. */
  pendingHotkey: string | null;
  sound: IslandSoundUi;
  motion: IslandMotion;
}

/** Помощник на острове (спека 2026-10-14, 6.1). Выключен по умолчанию: тратит лимит провайдера. */
export interface AssistantUi {
  enabled: boolean;
  /** `null` — первый готовый: Claude, GLM, Codex. */
  provider: string | null;
  /** `null` — быстрая модель провайдера по умолчанию. */
  model: string | null;
  /** Глобальное сочетание в формате Electron accelerator. */
  hotkey: string;
  /** Код языка Whisper (`uk`, `de`, …), не `auto`; `null` — язык системы. */
  language: AssistantLanguage | null;
  /** «Speak answers» (план 3b, B15): помощник говорит ответы нейроголосом; выключено по умолчанию. */
  speak: boolean;
  /** Голос каталога (`shared/tts-types.ts`); `null` — `DEFAULT_VOICE`. */
  voice: AssistantVoiceId | null;
}

export type RightSidebarTab = 'files' | 'changes' | 'agents';

export interface UiFile {
  version: 1;
  appearance: Appearance;
  leftSidebar: { open: boolean; width: number };
  rightSidebar: { open: boolean; width: number; tab: RightSidebarTab };
  activeWorkKey: string | null;
  pinnedWorks: string[];
  collapsedProjects: string[];
  /**
   * Проекты, убранные из списка пунктом «Remove from list…» (спека архива комнат и проектов, 6.3): путь проекта.
   * Сайдбар их не рисует; в индексе хоста проекты остаются, и как только в скрытом появляется неархивная работа, окно
   * убирает путь отсюда само.
   */
  hiddenProjects: string[];
  showDoneWorks: boolean;
  /**
   * `sound` — звук «Sound when you're needed» (свой сигнал окна, `renderer/attention/chime.ts`); `finishedSound` —
   * «Sound when an agent finishes» (системный звук баннера, по умолчанию выключен; спека застрявших 7.5).
   */
  notifications: { needsYou: boolean; finished: boolean; mail: boolean; sound: boolean; finishedSound: boolean };
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
  /** Вкладки браузера (спека 2026-10-07, 4.3). */
  browser: BrowserUi;
  /** Остров одобрений (спека 2026-10-12). */
  island: IslandUi;
  /** Помощник на острове (спека 2026-10-14, 6.1). */
  assistant: AssistantUi;
}

export const DEFAULT_UI: UiFile = {
  version: 1,
  appearance: 'system',
  leftSidebar: { open: true, width: 288 },
  rightSidebar: { open: true, width: 320, tab: 'files' },
  activeWorkKey: null,
  pinnedWorks: [],
  collapsedProjects: [],
  hiddenProjects: [],
  showDoneWorks: true,
  notifications: { needsYou: true, finished: true, mail: true, sound: true, finishedSound: false },
  diffView: 'split',
  filesShowIgnored: false,
  lastProvider: null,
  checkForUpdates: true,
  dismissedUpdate: null,
  voice: { enabled: false, model: null, language: 'auto' },
  browser: { devtoolsHeight: null, agentsAllowed: true },
  island: {
    enabled: true,
    displayId: null,
    anchor: 'center',
    pendingHotkey: 'Control+Alt+I',
    sound: { palette: 'soft', volume: 0.6, ui: false },
    motion: 'system',
  },
  assistant: { enabled: false, provider: null, model: null, hotkey: 'Alt+Space', language: null, speak: false, voice: null },
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

/** Панель Console | Network (спека 2026-10-07, 4.3): не ниже 120 px, по умолчанию 40 % вкладки. Верх держит окно. */
export const DEVTOOLS_PANEL = { minHeight: 120, defaultShare: 0.4 } as const;

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

/**
 * Вложенные объекты `UiFile`, которые `save` сливает НЕ целиком поверх
 * текущего файла, а по одному уровню (текущее ⊕ патч) перед `normalizeUi`
 * (раунд исправлений 1, находка I1/тест 12): иначе `normalizeUi` подставляет
 * `DEFAULT_UI` в подполя, которых нет в патче, — частичный `{ sound: false }`
 * откатывал бы `needsYou`/`finished`/`mail` на дефолтный `true`, хотя патч их
 * не трогал.
 */
export const NESTED_UI_KEYS = [
  'leftSidebar',
  'rightSidebar',
  'notifications',
  'voice',
  'browser',
  'island',
  'assistant',
] as const satisfies ReadonlyArray<keyof UiFile>;

/** Слияние патча с текущим `UiFile`: верхний уровень — заменой, ключи `NESTED_UI_KEYS` — на один уровень вглубь. */
export function mergeUiPatch(
  current: UiFile,
  patch: Partial<Omit<UiFile, 'version'>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of NESTED_UI_KEYS) {
    const patchValue = (patch as Partial<Record<(typeof NESTED_UI_KEYS)[number], unknown>>)[key];
    if (isRecord(patchValue)) {
      merged[key] = { ...(current[key] as Record<string, unknown>), ...patchValue };
    }
  }
  return merged;
}

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
    source.tab === 'files' || source.tab === 'changes' || source.tab === 'agents'
      ? source.tab
      : DEFAULT_UI.rightSidebar.tab;
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

function normalizeBrowser(value: unknown): BrowserUi {
  const source = isRecord(value) ? value : {};
  // Высоты вкладки ui.json не знает: здесь — только низ; верх держит окно (`renderer/browser/stage.ts#panelHeight`).
  const height = isFiniteNumber(source.devtoolsHeight) ? Math.max(Math.round(source.devtoolsHeight), DEVTOOLS_PANEL.minHeight) : null;
  return {
    devtoolsHeight: height,
    agentsAllowed: typeof source.agentsAllowed === 'boolean' ? source.agentsAllowed : DEFAULT_UI.browser.agentsAllowed,
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
    finishedSound: bool('finishedSound'),
  };
}

const ISLAND_ANCHORS: readonly IslandAnchor[] = ['left', 'center', 'right'];
const ISLAND_PALETTES: readonly IslandSoundPalette[] = ['soft', 'crystal', 'warm'];

/** Звук острова — по образцу `notifications`: чужое значение поля даёт умолчание, громкость — в пределах 0–1. */
function normalizeIslandSound(value: unknown): IslandSoundUi {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_UI.island.sound;
  return {
    palette: ISLAND_PALETTES.includes(source.palette as IslandSoundPalette) ? (source.palette as IslandSoundPalette) : fallback.palette,
    volume: isFiniteNumber(source.volume) ? clamp(source.volume, 0, 1) : fallback.volume,
    ui: typeof source.ui === 'boolean' ? source.ui : fallback.ui,
  };
}

function normalizeIsland(value: unknown): IslandUi {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_UI.island;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    displayId: Number.isInteger(source.displayId) ? (source.displayId as number) : fallback.displayId,
    anchor: ISLAND_ANCHORS.includes(source.anchor as IslandAnchor) ? (source.anchor as IslandAnchor) : fallback.anchor,
    pendingHotkey: typeof source.pendingHotkey === 'string' && source.pendingHotkey.trim() !== ''
      ? source.pendingHotkey : source.pendingHotkey === null ? null : fallback.pendingHotkey,
    sound: normalizeIslandSound(source.sound),
    motion: source.motion === 'system' || source.motion === 'reduce' ? source.motion : fallback.motion,
  };
}

function normalizeAssistant(value: unknown): AssistantUi {
  const source = isRecord(value) ? value : {};
  const fallback = DEFAULT_UI.assistant;
  const text = (item: unknown): string | null => (typeof item === 'string' && item.trim() !== '' ? item : null);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    provider: text(source.provider),
    model: text(source.model),
    hotkey: text(source.hotkey) ?? fallback.hotkey,
    language: isVoiceLanguage(source.language) && source.language !== 'auto' ? source.language : null,
    speak: typeof source.speak === 'boolean' ? source.speak : fallback.speak,
    voice: isAssistantVoiceId(source.voice) ? source.voice : null,
  };
}

/** Голос помощника из настроек: выбранный или `DEFAULT_VOICE` (G4). Род голоса — для зеркала хосту и острова. */
export function assistantVoice(assistant: AssistantUi): TtsVoice {
  const id = assistant.voice ?? DEFAULT_VOICE;
  return TTS_VOICES.find((voice) => voice.id === id) ?? TTS_VOICES[0]!;
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
    hiddenProjects: isStringArray(source.hiddenProjects) ? source.hiddenProjects : DEFAULT_UI.hiddenProjects,
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
    browser: normalizeBrowser(source.browser),
    island: normalizeIsland(source.island),
    assistant: normalizeAssistant(source.assistant),
  };
}
