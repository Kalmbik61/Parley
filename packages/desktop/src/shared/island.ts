/**
 * Остров одобрений (спека 2026-10-12): общие типы main, preload острова и его renderer. Мост острова — узкий:
 * вызовы и события хоста, статус, снимок активности и свои каналы `island:*`; общий preload окна (файлы, диалоги,
 * браузер, голос, отложенная цель клика) острову не даётся.
 */

import type { EventName } from '@parley/protocol';
import type { FocusTarget, ParleyBridge } from './bridge.js';
import type { IslandAnchor } from './ui-types.js';

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

/** Что острову нужно из настроек и места: звук по Sound, показана ли подсказка, отступ под чёлку, точка у края монитора. */
export interface IslandConfig {
  sound: boolean;
  hintShown: boolean;
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
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Показать главное окно (создать, если закрыто) и открыть в нём цель. */
  open(target: FocusTarget): void;
  beep(): void;
  hintShown(): void;
  /** Отрисовка острова упала: main снимает признак «страница загружена» (уведомления снова идут) и прячет окно. */
  failed(): void;
}

export type IslandBridge = Pick<ParleyBridge, 'call' | 'on' | 'onStatus' | 'activitySnapshot'> & { island: IslandApi };

/** Методы хоста, которые main пропускает от острова (`host:call` по отправителю). */
export const ISLAND_METHODS: ReadonlySet<string> = new Set(['works.list', 'feed.snapshot', 'feed.decide']);

/**
 * События хоста, которые main пересылает окну острова (`forwardHostToPages` с `events`): список работ и активность
 * сессий. Остальное (`pty.output` всех сессий, лимиты, `feed.changed` и т. д.) острову не нужно — иначе поток вывода
 * терминалов шёл бы в его renderer впустую. Тип `EventName` ловит опечатку при сборке.
 */
export const ISLAND_EVENTS: ReadonlySet<EventName> = new Set<EventName>(['works.changed', 'activity.changed']);

/** Провайдеры вне острова (решение 2026-10-12): Codex — системными уведомлениями, как раньше. */
export const ISLAND_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(['codex']);
