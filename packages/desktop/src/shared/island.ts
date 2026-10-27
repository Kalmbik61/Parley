/**
 * Остров одобрений (спека 2026-10-12): общие типы main, preload острова и его renderer. Мост острова — узкий:
 * вызовы и события хоста, статус, снимок активности и свои каналы `island:*`; общий preload окна (файлы, диалоги,
 * браузер, голос, отложенная цель клика) острову не даётся.
 */

import type { AssistantLanguage } from '@parley/core/assistant';
import { sessionRef, type EventData, type EventName, type SessionRef } from '@parley/protocol';
import type { FocusTarget, ParleyBridge } from './bridge.js';
import type { AssistantVoiceId, VoiceGender } from './tts-types.js';
import type { IslandAnchor, IslandMotion, IslandSoundUi } from './ui-types.js';
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
  /**
   * Нейроголос (план 3b, B15). Main присылает его всегда; необязательное поле — только ради начального конфига
   * `IslandApp.tsx` до B22: без поля голоса нет.
   */
  speech?: IslandSpeechConfig;
}

/** Речь помощника на острове (план 3b, B15). */
export interface IslandSpeechConfig {
  /** «Speak answers» (`assistant.speak`). */
  enabled: boolean;
  /** Голос каталога; на чистой установке — `DEFAULT_VOICE` (G4). */
  voice: AssistantVoiceId;
  /** Род голоса: шаблонные фразы помощника (G2). */
  gender: VoiceGender;
  /** Голос может звучать (`ttsAvailable`); нет — ответы текстом, само ничего не качается (G3, Р8). */
  available: boolean;
}

/** Состояние нейроголоса в main (`TtsService.state()`, B10): его видят остров (порт) и настройки. */
export type TtsEngineState =
  | { state: 'unavailable'; reason: string }
  | { state: 'not-downloaded' }
  | { state: 'warming' }
  | { state: 'ready' }
  | { state: 'speaking' };

/** Голос может звучать: веса скачаны и движок не отказал (`warming` — `speak` дождётся `ready`). */
export function ttsAvailable(state: TtsEngineState): boolean {
  return state.state === 'ready' || state.state === 'speaking' || state.state === 'warming';
}

/** Предел текста одного предложения в `island:tts-speak`: длиннее — `bad_request`. */
export const ISLAND_TTS_TEXT_LIMIT = 2000;

/** Предложение на синтез (`island:tts-speak`). */
export interface IslandSpeakRequest {
  utteranceId: string;
  text: string;
  voice: AssistantVoiceId;
  language: AssistantLanguage;
}

/** Кусок `island:tts-chunk` (#9 §6.3): моно f32 с родной частотой движка; `final` — пустой последний кусок предложения. */
export interface IslandTtsChunk {
  utteranceId: string;
  seq: number;
  sampleRate: number;
  channels: 1;
  format: 'f32';
  pcm: Float32Array;
  final: boolean;
}

/**
 * Сообщения порта голоса — по порядку на одном `MessagePort`: куски, срыв по длине (выбросить куски `utteranceId` с
 * `seq >= fromSeq`, повтор идёт старшими `seq`) и состояние движка.
 */
export type IslandTtsMessage =
  | { type: 'chunk'; chunk: IslandTtsChunk }
  | { type: 'discard'; utteranceId: string; fromSeq: number }
  | { type: 'state'; state: TtsEngineState };

export { ISLAND_TTS_PORT } from './island-port.js';

/** Нейроголос острова (план 3b, B15). */
export interface IslandSpeechApi {
  /**
   * Просит у main новый порт голоса; он придёт сообщением окна с `data === ISLAND_TTS_PORT`. Звать после подписки на
   * `message`; новый порт закрывает прежний, а речь прежнего порта отменяется.
   */
  connect(): void;
  /** Ставит предложение в очередь; ответ — когда оно кончилось (или сразу, если голоса нет). Куски — в порт. */
  speak(request: IslandSpeakRequest): Promise<TtsEngineState>;
  /** Отмена предложения; без id — всей очереди (E3). */
  cancel(utteranceId?: string): void;
  warmup(): Promise<TtsEngineState>;
  /** Значок динамика: пишет `assistant.speak` в ui.json — тот же флаг, что «Speak answers» в Settings. */
  setSpeak(on: boolean): Promise<void>;
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

/**
 * Звук острова (#9 §5): `needs` — «Sound when you're needed» (`notifications.sound`), `finished` — «Sound when an agent
 * finishes» (`notifications.finishedSound`, звук Done острова), остальное — `island.sound` из `ui.json`.
 */
export interface IslandSoundConfig extends IslandSoundUi {
  needs: boolean;
  finished: boolean;
}

/** Что острову нужно из настроек и места: звук и движение, отступ под чёлку, точка у края монитора. */
export interface IslandConfig {
  /** Остров выключен, а помощник включён — окно показывается только в режиме помощника. */
  islandEnabled: boolean;
  assistant: IslandAssistantConfig;
  islandSound: IslandSoundConfig;
  motion: IslandMotion;
  topInset: number;
  /** Точка, у которой стоит остров: форма выравнивается внутри фиксированного кадра окна влево, по центру или вправо. */
  anchor: IslandAnchor;
  /**
   * Вырез дисплея острова (#9 §12), pt: ширина, высота и центр выреза от левого края кадра окна. Только у точки
   * `center` (Н-3); `null` или нет поля — выреза нет, остаётся полоса. Необязательное — только ради фикстур
   * `IslandConfig` в тестах renderer (план 3b, B27).
   */
  notch?: { width: number; height: number; centerX: number } | null;
}

export interface IslandApi {
  config(): Promise<IslandConfig>;
  onConfig(listener: (config: IslandConfig) => void): () => void;
  visibility(): Promise<SessionVisibilitySnapshot>;
  onVisibility(listener: (snapshot: SessionVisibilitySnapshot) => void): () => void;
  /**
   * Курсор над областью острова (`setHitRect`) или нет — решает main по настоящему положению курсора: DOM-наведение
   * в сквозном окне ненадёжно (`mouseleave` могло не прийти вовсе). Над областью окно ловит мышь, вне её клики проходят
   * сквозь прозрачный кадр к приложениям под ним; во время перетаскивания main сообщает «над областью».
   */
  onHover(listener: (hovered: boolean) => void): () => void;
  /** Область, которую остров ловит мышью: форма (выдвинутый), язычок (убранный) или `null`, если ничего не показано. */
  setHitRect(rect: IslandHitRect | null): void;
  setVisible(visible: boolean): void;
  /** Общий owner assistant/request: панель берёт клавиатуру (`true`) или отдаёт её прежнему приложению (`false`). */
  keyboard(on: boolean): void;
  /** Хоткей или палитра открыли помощника. */
  onAssistantOpen(listener: (request: AssistantOpenRequest) => void): () => void;
  /** Main registered the queue shortcut; focus the island and arm pending-item navigation. */
  onNavigatePending(listener: () => void): () => void;
  /** Панель потеряла фокус, пока держала клавиатуру (клик в другое приложение): выйти из режима, как по Esc или ⌃. */
  onKeyboardBlur(listener: () => void): () => void;
  /** Голос для помощника — те же каналы `voice:*`, что у окна. */
  voice: Pick<VoiceApi, 'transcribe' | 'micStatus' | 'requestMic'>;
  speech: IslandSpeechApi;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Показать главное окно (создать, если закрыто) и открыть в нём цель. */
  open(target: FocusTarget): void;
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
/** Только desktop delivery: число валидных уникальных tasks до ограничения списка. */
export type IslandActivityEntry = EventData<'activity.changed'> & { islandTasksTotal?: number };

export const SESSION_VISIBILITY_LIMIT = 50;
export interface SessionVisibilityReport {
  refs: SessionRef[];
  documentVisible: boolean;
  seq: number;
}
export interface SessionVisibilitySnapshot {
  version: number;
  refs: SessionRef[];
}

/** Неизвестная видимость не является доказательством просмотра. */
export function parseVisibilitySnapshot(value: unknown): SessionVisibilitySnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, refs } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(version) || (version as number) < 0 || !Array.isArray(refs) || refs.length > SESSION_VISIBILITY_LIMIT) return null;
  const parsed = sessionRef.array().safeParse(refs);
  return parsed.success ? { version: version as number, refs: parsed.data } : null;
}

/** Единый исход показа для r-05; Done не даёт звука, quiet Done не раскрывает остров. */
export interface IslandPresentationOutcome {
  key: string;
  kind: 'permission' | 'question' | 'plan' | 'consent' | 'room-proposal' | 'done' | 'terminal-request';
  fresh: boolean;
  expand: boolean;
  soundEligible: boolean;
}

/**
 * Методы хоста, которые main пропускает от острова (`host:call` по отправителю). `context.messages` — чтение страниц писем:
 * остров держит тот же стор работ, и при разрыве версии он перечитывает держимое так же, как главное окно
 * (спека rooms.mail 6.5); без него каждое такое чтение отказывало бы и сыпало предупреждения в консоль. `providers.list` —
 * строки провайдеров для значков: без них `AgentIcon` не знает пресет своего провайдера и рисует значок Parley.
 */
export const ISLAND_METHODS: ReadonlySet<string> = new Set([
  'works.list',
  'providers.list',
  'context.messages',
  'feed.snapshot',
  'feed.progress',
  'feed.decide',
  'assistant.ask',
  'assistant.cancel',
  'assistant.decide',
  'assistant.reset',
  'assistant.state',
  'consents.list',
  'consents.decide',
]);

/**
 * События хоста, которые main пересылает окну острова (`forwardHostToPages` с `events`): список работ, письма работ
 * (`rooms.mail`: запись одних писем `works.changed` уже не шлёт, и без него числа острова застыли бы до следующего
 * структурного снимка), активность сессий, состояние помощника, карточки согласия на папку и смена списка провайдеров
 * (значки). Остальное (`pty.output`
 * всех сессий, лимиты, `feed.changed` и т. д.) острову не нужно — иначе поток вывода терминалов шёл бы в его renderer
 * впустую. Тип `EventName` ловит опечатку при сборке.
 */
export const ISLAND_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  'works.changed',
  'rooms.mail',
  'activity.changed',
  'assistant.changed',
  'consents.changed',
  'providers.changed',
]);

/** Сколько ссылок на сессии принимает одно «просмотрено» острова (`island:mark-seen`); main отбрасывает список длиннее. */
export const ISLAND_MARK_SEEN_LIMIT = 50;

/** Ссылки для «просмотрено» порциями не длиннее `ISLAND_MARK_SEEN_LIMIT`: длинный Clear уходит несколькими сообщениями. */
export function markSeenBatches(refs: readonly SessionRef[]): SessionRef[][] {
  const batches: SessionRef[][] = [];
  for (let at = 0; at < refs.length; at += ISLAND_MARK_SEEN_LIMIT) batches.push(refs.slice(at, at + ISLAND_MARK_SEEN_LIMIT));
  return batches;
}
