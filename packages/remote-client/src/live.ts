// Живые подписки телефона (A31): лента открытых сессий (`feed.subscribe` + `feed.snapshot` + `feed.changed` по `revision`)
// и согласия хоста (`consents.list` + `consents.changed`). Подписка живёт, пока открыт экран сессии, и только на переднем
// плане при готовом соединении; после переподключения подписываемся заново, после новой эпохи берём новый снимок.
import type { Rpc } from './actions.js';
import type { RemoteStore } from './store.js';
import { sessionKey, type SessionRef } from './state.js';

export interface LiveSync {
  /** Экран сессии открыт. Возвращает закрытие; ссылки на одну сессию считаются. */
  openFeed(ref: SessionRef): () => void;
  /** Перечитать ленту после ошибки снимка. */
  reloadFeed(ref: SessionRef): void;
  /** Соединение готово (`ready`). */
  setConnected(connected: boolean): void;
  setForeground(foreground: boolean): void;
  /** Перечитать согласия сейчас. */
  reloadConsents(): void;
  dispose(): void;
}

interface Open {
  ref: SessionRef;
  count: number;
  /** Мост подписан от имени этого телефона. */
  subscribed: boolean;
  running: boolean;
  again: boolean;
}

export function createLiveSync({ store, rpc }: { store: RemoteStore; rpc: Rpc }): LiveSync {
  const open = new Map<string, Open>();
  let connected = false;
  let foreground = true;
  const active = (): boolean => connected && foreground;

  async function syncFeed(key: string): Promise<void> {
    const o = open.get(key);
    if (o === undefined || !active()) return;
    if (o.running) {
      o.again = true;
      return;
    }
    o.running = true;
    try {
      do {
        o.again = false;
        const epoch = store.getState().epoch;
        try {
          // Сначала подписка, потом снимок: дельта между ними ждёт в очереди записи и ложится по `revision`.
          if (!o.subscribed) {
            await rpc.call('feed.subscribe', { ref: o.ref });
            o.subscribed = true;
            if (!open.has(key) || !active()) {
              // Закрыли или ушли с переднего плана, пока шла подписка.
              void unsubscribe(o);
              return;
            }
          }
          const res = (await rpc.call('feed.snapshot', { ref: o.ref })) as {
            items?: unknown;
            revision?: unknown;
            mode?: unknown;
            decisions?: unknown;
          } | null;
          if (res === null || !Array.isArray(res.items) || typeof res.revision !== 'number') throw new Error('bad feed.snapshot');
          store.dispatch({
            t: 'feed.loaded',
            ref: o.ref,
            epoch,
            items: res.items as never[],
            revision: res.revision,
            mode: typeof res.mode === 'string' ? res.mode : null,
            decisions: (res.decisions ?? null) as never,
          });
          // Дельта с пропуском за время чтения: сразу новый снимок.
          if (store.getState().feeds[key]?.status === 'stale') o.again = true;
          // Эпоха сменилась за время чтения: ответ отброшен, читаем заново.
          if (store.getState().epoch !== epoch) o.again = true;
        } catch {
          // Ленту читать не удалось: `error`, пока человек не нажмёт «повторить» или не придёт переподключение.
          if (store.getState().epoch === epoch) store.dispatch({ t: 'feed.failed', ref: o.ref, epoch });
        }
      } while (o.again && open.has(key) && active());
    } finally {
      o.running = false;
    }
  }

  async function unsubscribe(o: Open): Promise<void> {
    if (!o.subscribed) return;
    o.subscribed = false;
    try {
      await rpc.call('feed.unsubscribe', { ref: o.ref });
    } catch {
      // Соединения нет — мост снял подписку сам.
    }
  }

  // ---- согласия ----
  let consentsRunning = false;
  let consentsAgain = false;
  let applyingList = false;
  async function syncConsents(): Promise<void> {
    if (!active()) return;
    if (consentsRunning) {
      consentsAgain = true;
      return;
    }
    consentsRunning = true;
    try {
      do {
        consentsAgain = false;
        const epoch = store.getState().epoch;
        try {
          const res = (await rpc.call('consents.list', {})) as { items?: unknown } | null;
          if (Array.isArray(res?.items)) {
            applyingList = true;
            try {
              store.dispatch({ t: 'consents.loaded', epoch, items: res.items as never[] });
            } finally {
              applyingList = false;
            }
          }
        } catch {
          // Список прочтётся при следующем событии или переподключении.
        }
        if (store.getState().epoch !== epoch) consentsAgain = true;
      } while (consentsAgain && active());
    } finally {
      consentsRunning = false;
    }
  }

  const unsubscribeStore = store.subscribe((next, prev) => {
    if (!active()) return;
    if (next.epoch !== prev.epoch) {
      void syncConsents();
      // Снимок заново; подписку мост восстанавливает сам (A30), повторно её не просим.
      for (const key of open.keys()) void syncFeed(key);
      return;
    }
    // Дельта с пропуском: нужен новый снимок.
    for (const [key, entry] of Object.entries(next.feeds)) {
      if (entry.status === 'stale' && prev.feeds[key]?.status !== 'stale') void syncFeed(key);
    }
  });

  // Событие согласий, пришедшее, пока список читается: ответ мог быть снят раньше события — читаем ещё раз.
  const unsubscribeEvents = store.subscribe((next, prev) => {
    if (consentsRunning && !applyingList && next.epoch === prev.epoch && next.consents.items !== prev.consents.items) consentsAgain = true;
  });

  return {
    openFeed(ref) {
      const key = sessionKey(ref);
      let o = open.get(key);
      if (o === undefined) {
        o = { ref, count: 0, subscribed: false, running: false, again: false };
        open.set(key, o);
        store.dispatch({ t: 'feed.open', ref });
      }
      o.count++;
      void syncFeed(key);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const cur = open.get(key);
        if (cur === undefined) return;
        cur.count--;
        if (cur.count > 0) return;
        open.delete(key);
        store.dispatch({ t: 'feed.close', ref });
        void unsubscribe(cur);
      };
    },
    reloadFeed(ref) {
      const key = sessionKey(ref);
      if (!open.has(key)) return;
      store.dispatch({ t: 'feed.reload', ref });
      void syncFeed(key);
    },
    setConnected(c) {
      if (connected === c) return;
      const was = active();
      connected = c;
      handle(was);
    },
    setForeground(f) {
      if (foreground === f) return;
      const was = active();
      foreground = f;
      handle(was);
    },
    reloadConsents: () => void syncConsents(),
    dispose() {
      unsubscribeStore();
      unsubscribeEvents();
      open.clear();
    },
  };

  function handle(was: boolean): void {
    const now = active();
    if (was === now) return;
    if (!now) {
      // Фон или обрыв: подписки сняты (мост снимает сам при обрыве, при фоне просим), записи ждут нового снимка.
      for (const o of open.values()) {
        void unsubscribe(o);
        store.dispatch({ t: 'feed.reload', ref: o.ref });
      }
      return;
    }
    void syncConsents();
    for (const key of open.keys()) void syncFeed(key);
  }
}
