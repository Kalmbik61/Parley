/**
 * Уведомления macOS в main (кусок 4.3, спека 7.4): одно уведомление на тег, клик поднимает
 * окно и отдаёт ему цель перехода. Тексты и цель собирает окно (`renderer/attention/notify.ts`),
 * форму и длину уже проверил `main/ipc.ts`.
 */

import type { AppNote, FocusTarget } from '../shared/bridge.js';

export interface NotificationLike {
  show(): void;
  close(): void;
  on(event: 'click' | 'close', cb: () => void): void;
}

export function createNotifier(deps: {
  create(options: { title: string; body: string; silent: boolean }): NotificationLike;
  /** restore → show → focus; окна нет (null или isDestroyed: macOS держит приложение без окон) — создать заново. */
  focusWindow(): void;
  /** Окну после did-finish-load — событием app:focus-target; иначе — в отложенные (createPendingFocusTarget). */
  sendFocusTarget(target: FocusTarget): void;
}): { notify(note: AppNote): void } {
  // Ссылка в Map держит уведомление живым: без неё объект с обработчиком `click` мог бы
  // уйти в сборку мусора, пока уведомление ещё висит в Центре уведомлений.
  const shown = new Map<string, NotificationLike>();

  return {
    notify(note) {
      const previous = shown.get(note.tag);
      if (previous !== undefined) {
        shown.delete(note.tag);
        previous.close();
      }
      const notification = deps.create({ title: note.title, body: note.body, silent: note.silent });
      // Сравнение по ссылке: `close` закрытого прежнего приходит и после показа нового.
      const forget = (): void => {
        if (shown.get(note.tag) === notification) shown.delete(note.tag);
      };
      notification.on('click', () => {
        forget();
        deps.focusWindow();
        deps.sendFocusTarget(note.target);
      });
      notification.on('close', forget);
      shown.set(note.tag, notification);
      notification.show();
    },
  };
}

/** Цель клика для окна, которое ещё грузится. Новая заменяет прежнюю; take отдаёт её один раз. */
export function createPendingFocusTarget(): { put(target: FocusTarget): void; take(): FocusTarget | null } {
  let pending: FocusTarget | null = null;
  return {
    put(target) {
      pending = target;
    },
    take() {
      const target = pending;
      pending = null;
      return target;
    },
  };
}

/** Запись журнала `PARLEY_NOTIFICATIONS=log`: E2E читает её через `app.evaluate` и кликает. */
export interface LoggedNotification {
  title: string;
  body: string;
  silent: boolean;
  shown: boolean;
  closed: boolean;
  click(): void;
}

/**
 * Уведомление без системного показа — для E2E (`PARLEY_NOTIFICATIONS=log`): настоящее
 * всплыло бы на экране человека, который в это время работает за машиной. `show` пишет
 * запись в журнал, `click` записи делает то же, что клик по настоящему уведомлению.
 */
export function createLoggedNotification(
  log: LoggedNotification[],
  options: { title: string; body: string; silent: boolean },
): NotificationLike {
  const listeners: Record<'click' | 'close', Array<() => void>> = { click: [], close: [] };
  const entry: LoggedNotification = {
    ...options,
    shown: false,
    closed: false,
    click: () => {
      for (const cb of listeners.click) cb();
    },
  };
  return {
    show() {
      entry.shown = true;
      log.push(entry);
    },
    close() {
      entry.closed = true;
      for (const cb of listeners.close) cb();
    },
    on(event, cb) {
      listeners[event].push(cb);
    },
  };
}
