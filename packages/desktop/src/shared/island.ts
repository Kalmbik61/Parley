/**
 * Остров одобрений (спека 2026-10-12): общие типы main, preload острова и его renderer. Мост острова — узкий:
 * вызовы и события хоста, статус, снимок активности и свои каналы `island:*`; общий preload окна (файлы, диалоги,
 * браузер, голос, отложенная цель клика) острову не даётся.
 */

import type { AssistantLanguage } from '@parley/core/assistant';
import type { EventName, SessionRef } from '@parley/protocol';
import type { FocusTarget, ParleyBridge } from './bridge.js';
import type { IslandAnchor } from './ui-types.js';
import type { VoiceApi, VoiceModelId } from './voice-types.js';

/** Точка курсора на экране (DIP), из `PointerEvent.screenX/Y` острова. */
export interface IslandPoint {
  screenX: number;
  screenY: number;
}

/** Прямоугольник относительно окна острова (CSS px = DIP): то, что ловит мышь; вне него клики проходят сквозь окно. */
export interface IslandHitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Настройки помощника для острова (спека 2026-10-14, 6.1). */
export interface IslandAssistantConfig {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  /** Уже разрешённый язык (`null` из настроек → язык системы). */
  language: AssistantLanguage;
  /** Сочетание из настроек — для подсказки «⌥Space to talk». */
  hotkey: string;
  /** Голосовой ввод из настроек Voice: без модели помощник слушать не может. */
  voice: { enabled: boolean; model: VoiceModelId | null };
}

export interface AssistantOpenRequest {
  /** Хоткей — сразу слушать; палитра и клик — печать. */
  listen: boolean;
}

/** Состояние глобального хоткея помощника (`main/assistant/shortcut.ts`): его видят preload и renderer. */
export interface AssistantShortcutStatus {
  /** Сочетание, которое помощник хочет держать; `null` — помощник выключен. */
  accelerator: string | null;
  ok: boolean;
}

/** Что острову нужно из настроек и места: звук по Sound, отступ под чёлку, точка у края монитора. */
export interface IslandConfig {
  /** Остров выключен, а помощник включён — окно показывается только в режиме помощника. */
  islandEnabled: boolean;
  assistant: IslandAssistantConfig;
  sound: boolean;
  topInset: number;
  /** Точка, у которой стоит остров: форма выравнивается внутри фиксированного кадра окна влево, по центру или вправо. */
  anchor: IslandAnchor;
}

export interface IslandApi {
  config(): Promise<IslandConfig>;
  onConfig(listener: (config: IslandConfig) => void): () => void;
  /**
   * Курсор над областью острова (`setHitRect`) или нет — решает main по настоящему положению курсора: DOM-наведение
   * в сквозном окне ненадёжно (`mouseleave` могло не прийти вовсе). Над областью окно ловит мышь, вне её клики проходят
   * сквозь прозрачный кадр к приложениям под ним; во время перетаскивания main сообщает «над областью».
   */
  onHover(listener: (hovered: boolean) => void): () => void;
  /** Область, которую остров ловит мышью: форма (выдвинутый), язычок (убранный) или `null`, если ничего не показано. */
  setHitRect(rect: IslandHitRect | null): void;
  setVisible(visible: boolean): void;
  /** Режим помощника: панель берёт клавиатуру (`true`) или отдаёт её прежнему приложению (`false`). */
  keyboard(on: boolean): void;
  /** Хоткей или палитра открыли помощника. */
  onAssistantOpen(listener: (request: AssistantOpenRequest) => void): () => void;
  /** Панель потеряла фокус, пока держала клавиатуру (клик в другое приложение): выйти из режима, как по Esc или ⌃. */
  onAssistantBlur(listener: () => void): () => void;
  /** Голос для помощника — те же каналы `voice:*`, что у окна. */
  voice: Pick<VoiceApi, 'transcribe' | 'micStatus' | 'requestMic'>;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Показать главное окно (создать, если закрыто) и открыть в нём цель. */
  open(target: FocusTarget): void;
  beep(): void;
  /**
   * Clear: сессии строк Done просмотрены. Остров хосту уведомлений не шлёт (`host:notify` от него отбрасывается), поэтому
   * для этого есть узкий канал `island:mark-seen`: main проверяет список и шлёт хосту `activity.seen`, как главное окно, когда
   * видит сессию, — в Parley гаснет «непросмотрено».
   */
  markSeen(refs: SessionRef[]): void;
  /** Отрисовка острова упала: main снимает признак «страница загружена» (уведомления снова идут) и прячет окно. */
  failed(): void;
}

export type IslandBridge = Pick<ParleyBridge, 'call' | 'on' | 'onStatus' | 'activitySnapshot'> & { island: IslandApi };

/** Методы хоста, которые main пропускает от острова (`host:call` по отправителю). */
export const ISLAND_METHODS: ReadonlySet<string> = new Set([
  'works.list',
  'feed.snapshot',
  'feed.decide',
  'assistant.ask',
  'assistant.cancel',
  'assistant.decide',
  'assistant.reset',
  'assistant.state',
]);

/**
 * События хоста, которые main пересылает окну острова (`forwardHostToPages` с `events`): список работ и активность
 * сессий. Остальное (`pty.output` всех сессий, лимиты, `feed.changed` и т. д.) острову не нужно — иначе поток вывода
 * терминалов шёл бы в его renderer впустую. Тип `EventName` ловит опечатку при сборке.
 */
export const ISLAND_EVENTS: ReadonlySet<EventName> = new Set<EventName>(['works.changed', 'activity.changed', 'assistant.changed']);

/** У Codex остров показывает запросы действий; обычная работа и Done остаются вне острова. */
export const ISLAND_ATTENTION_ONLY_PROVIDERS: ReadonlySet<string> = new Set(['codex']);

/** Сколько ссылок на сессии принимает одно «просмотрено» острова (`island:mark-seen`); main отбрасывает список длиннее. */
export const ISLAND_MARK_SEEN_LIMIT = 50;

/** Ссылки для «просмотрено» порциями не длиннее `ISLAND_MARK_SEEN_LIMIT`: длинный Clear уходит несколькими сообщениями. */
export function markSeenBatches(refs: readonly SessionRef[]): SessionRef[][] {
  const batches: SessionRef[][] = [];
  for (let at = 0; at < refs.length; at += ISLAND_MARK_SEEN_LIMIT) batches.push(refs.slice(at, at + ISLAND_MARK_SEEN_LIMIT));
  return batches;
}
