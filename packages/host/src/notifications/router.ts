/**
 * Роутер уведомлений (спека 2026-11-03, T2): чистое решение «какие каналы» и применение его к outbox store. Режимы по
 * §6.2; в SMART Telegram получает только эскалацию критической неподтверждённой просьбы. Отправки здесь нет (Telegram —
 * T3, APNs — T4): роутер лишь заводит записи outbox каналов `app` и `telegram`. Закрытие строки (ack, expired) снимает
 * ожидающую запись store, поэтому отложенная эскалация отзывается сама, а push «окно закрылось» не шлётся.
 */

import type { NotificationRow, NotificationStore, NotificationVia } from './store.js';

export type DeliveryMode = 'APP_ONLY' | 'TELEGRAM_ONLY' | 'SMART' | 'BOTH';

/** Пилотный интервал эскалации, настраивается (T5). */
export const DEFAULT_ESCALATION_MS = 10 * 60_000;

export interface Presence {
  /** Экран приложения активен и host получает достоверный heartbeat: push по тому же событию не нужен (Inbox остаётся). */
  appActive: boolean;
  /** Telegram разрешён пользователем и привязан. */
  telegramAllowed: boolean;
}

export interface RouteEvent {
  severity: NotificationRow['severity'];
  requiresAction: boolean;
  state: NotificationRow['state'];
}

export interface Decision {
  /** Push в приложение сразу. */
  app: boolean;
  /** Telegram сразу. */
  telegram: boolean;
  /** Telegram как отложенная эскалация (через интервал, если до тех пор нет действия). */
  escalate: boolean;
}

const NONE: Decision = { app: false, telegram: false, escalate: false };

export function route(event: RouteEvent, mode: DeliveryMode, presence: Presence, deliveredInline: boolean): Decision {
  // Закрытое событие (ack, expired) ничего не рассылает.
  if (event.state !== 'new' && event.state !== 'seen') return NONE;
  const app = mode !== 'TELEGRAM_ONLY' && !deliveredInline && !presence.appActive;
  const telegram = presence.telegramAllowed && (mode === 'TELEGRAM_ONLY' || mode === 'BOTH');
  const escalate = mode === 'SMART' && presence.telegramAllowed && event.severity === 'critical' && event.requiresAction;
  return { app, telegram, escalate };
}

export interface RouterDeps {
  store: NotificationStore;
  /** Режим и присутствие читаются при каждом событии: смена режима действует без рестарта. */
  mode: () => DeliveryMode;
  presence: () => Presence;
  escalationMs?: () => number;
  now?: () => number;
}

export interface Router {
  /** Применяет решение к строке: заводит записи outbox. Повторный вызов ничего не дублирует. */
  dispatch(row: NotificationRow, deliveredInline: boolean): Decision;
  /** Решение принято в канале: `already_handled`, если строка уже закрыта (повторное нажатие не исполняет действие). */
  ack(dedupeKey: string, via: NotificationVia): 'acked' | 'already_handled';
}

export function createRouter(deps: RouterDeps): Router {
  const now = deps.now ?? Date.now;
  return {
    dispatch(row, deliveredInline) {
      const current = deps.store.get(row.dedupeKey) ?? row;
      const decision = route(current, deps.mode(), deps.presence(), deliveredInline);
      const at = now();
      if (decision.app) deps.store.enqueue(current.notificationId, 'app', at);
      if (decision.telegram) deps.store.enqueue(current.notificationId, 'telegram', at);
      // Эскалация — та же запись `telegram` того же notificationId, только позже; ack/expired её снимают.
      else if (decision.escalate) deps.store.enqueue(current.notificationId, 'telegram', current.createdAt + (deps.escalationMs?.() ?? DEFAULT_ESCALATION_MS));
      return decision;
    },
    ack(dedupeKey, via) {
      return deps.store.ack(dedupeKey, via, now()) ? 'acked' : 'already_handled';
    },
  };
}
