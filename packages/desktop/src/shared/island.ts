/**
 * Остров одобрений (спека 2026-10-12): общие типы main, preload острова и его renderer. Мост острова — узкий:
 * вызовы и события хоста, статус, снимок активности и свои каналы `island:*`; общий preload окна (файлы, диалоги,
 * браузер, голос, отложенная цель клика) острову не даётся.
 */

import type { FocusTarget, ParleyBridge } from './bridge.js';

/** Точка курсора на экране (DIP), из `PointerEvent.screenX/Y` острова. */
export interface IslandPoint {
  screenX: number;
  screenY: number;
}

/** Что острову нужно из настроек и места: звук по Sound, показана ли подсказка, отступ под чёлку. */
export interface IslandConfig {
  sound: boolean;
  hintShown: boolean;
  topInset: number;
}

export interface IslandApi {
  config(): Promise<IslandConfig>;
  onConfig(listener: (config: IslandConfig) => void): () => void;
  setSize(width: number, height: number): void;
  setVisible(visible: boolean): void;
  dragStart(point: IslandPoint): void;
  dragMove(point: IslandPoint): void;
  dragEnd(point: IslandPoint): void;
  /** Показать главное окно (создать, если закрыто) и открыть в нём цель. */
  open(target: FocusTarget): void;
  beep(): void;
  hintShown(): void;
}

export type IslandBridge = Pick<ParleyBridge, 'call' | 'on' | 'onStatus' | 'activitySnapshot'> & { island: IslandApi };

/** Методы хоста, которые main пропускает от острова (`host:call` по отправителю). */
export const ISLAND_METHODS: ReadonlySet<string> = new Set(['works.list', 'feed.snapshot', 'feed.decide']);

/** Провайдеры вне острова (решение 2026-10-12): Codex — системными уведомлениями, как раньше. */
export const ISLAND_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(['codex']);
