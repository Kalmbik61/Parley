/**
 * Уведомления macOS (кусок 1.10 плана окна): сессия перешла в `blocked` или
 * `unseen` и не видна (не выбрана или окно не в фокусе) — `app.notify` с
 * заголовком «S03 ждёт ответа»/«S03 закончила ход» и ярлыком в тексте.
 *
 * Бейдж с куска 4.2 ставит `App` по `attention/store.ts#badgeCount`: два источника
 * спорили бы. Сам файл заменяет 4.3.
 */

import { refKey, type SessionRef } from '@harnas/protocol';
import type { Activity } from '@harnas/core';
import { noticeTitle } from './lib/participant.js';
import type { HarnasBridge } from '../shared/bridge.js';
import { S } from '../shared/strings.js';

/** Заголовок уведомления для каждого «тревожного» activity; остальные — не тревога. */
const ALERT_SUFFIX: Partial<Record<Activity, string>> = {
  blocked: S.notifications.alertSuffixBlocked,
  unseen: S.notifications.alertSuffixUnseen,
};

export interface NotificationWatcher {
  /** Обработать одно `activity.changed` — вызывается и напрямую в тестах, и из `wire`. */
  handle: (ref: SessionRef, activity: Activity) => void;
}

export interface NotificationDeps {
  notify: (note: { title: string; body: string }) => void;
  /** Видна ли сессия сейчас: выбрана в сайдбаре И окно в фокусе. */
  isVisible: (ref: SessionRef) => boolean;
  getSessionLabel: (ref: SessionRef) => string;
}

/**
 * Чистая логика без подписки на бридж — чтобы тестировать без фейкового
 * бриджа, а `wire` ниже уже подключает её к реальным событиям.
 */
export function createNotificationWatcher(deps: NotificationDeps): NotificationWatcher {
  const alerting = new Map<string, SessionRef>();

  const handle = (ref: SessionRef, activity: Activity): void => {
    const key = refKey(ref);
    const suffix = ALERT_SUFFIX[activity];

    if (suffix === undefined) {
      alerting.delete(key);
      return;
    }

    // Уведомляем только на переход В тревогу, не на каждое повторное
    // `activity.changed` с тем же activity — иначе спам при каждом обновлении.
    const wasAlerting = alerting.has(key);
    alerting.set(key, ref);
    if (!wasAlerting && !deps.isVisible(ref)) {
      deps.notify({ title: noticeTitle(ref.sessionId, suffix), body: deps.getSessionLabel(ref) });
    }
  };

  return { handle };
}

/** Подключает наблюдатель к `bridge.on('activity.changed', …)`; возвращает отписку. */
export function wireNotifications(
  bridge: HarnasBridge,
  deps: Omit<NotificationDeps, 'notify'>,
): () => void {
  const watcher = createNotificationWatcher({
    ...deps,
    notify: (note) => bridge.app.notify(note),
  });
  return bridge.on('activity.changed', (event) => watcher.handle(event.ref, event.activity.activity));
}
