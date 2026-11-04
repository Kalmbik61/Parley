// Живые подписки телефона (A31): лента открытых сессий (`feed.subscribe` + `feed.snapshot` + `feed.changed` по `revision`)
// и согласия хоста (`consents.list` + `consents.changed`). Подписка живёт, пока открыт экран сессии, и только на переднем
// плане при готовом соединении; после переподключения подписываемся заново, после новой эпохи берём новый снимок.
import type { Rpc } from './actions.js';
import type { Clock } from './refresh.js';
import type { RemoteStore } from './store.js';
import { roomKey, sessionKey, type RoomRef, type SessionRef } from './state.js';

export interface LiveSync {
  /** Экран сессии открыт. Возвращает закрытие; ссылки на одну сессию считаются. */
  openFeed(ref: SessionRef): () => void;
  /** Перечитать ленту после ошибки снимка. */
  reloadFeed(ref: SessionRef): void;
  /** Соединение готово (`ready`). */
  setConnected(connected: boolean): void;
  setForeground(foreground: boolean): void;
  /** A room screen is open: its newest page is read, `rooms.mail` keeps it current. Returns the close. */
  openRoom(ref: RoomRef): () => void;
  /** Read the newest page again (after an error). */
  reloadRoom(ref: RoomRef): void;
  /** The next older page. */
  loadOlder(ref: RoomRef): void;
  /** Перечитать согласия сейчас. */
  reloadConsents(): void;
  dispose(): void;
}

/** Pauses between retries after a transient failure; the last one repeats. */
export const FEED_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

/** A refusal that a retry will not change (`unknown_method`, `bad_request`, ...): no automatic retry. */
const TRANSIENT = new Set(['timeout', 'connection_lost', 'not_connected', 'rate_limited']);
const isTransient = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  // No code: a parse failure of the answer or a thrown non-RPC error — treat as final, the person can press Try again.
  return typeof code === 'string' && TRANSIENT.has(code);
};

interface Open {
  ref: SessionRef;
  count: number;
  /** Consecutive transient failures; the retry pause grows with it. */
  failures: number;
  /** A final refusal: only "Try again" (`reloadFeed`) or a new epoch lifts it. */
  blocked: boolean;
  retryTimer: unknown;
  /** Мост подписан от имени этого телефона. */
  subscribed: boolean;
  running: boolean;
  again: boolean;
}

export function createLiveSync({ store, rpc, clock }: { store: RemoteStore; rpc: Rpc; clock: Clock }): LiveSync {
  const open = new Map<string, Open>();
  let connected = false;
  let foreground = true;
  const active = (): boolean => connected && foreground;

  /** The bridge hello says the Mac cannot do it: no call is made. `null` hello — not known yet, ask. */
  const lacks = (method: string): boolean => {
    const methods = store.getState().methods;
    return methods !== null && !methods.includes(method);
  };

  const clearRetry = (o: Open): void => {
    if (o.retryTimer !== null) clock.clearTimeout(o.retryTimer);
    o.retryTimer = null;
  };

  async function syncFeed(key: string, force = false): Promise<void> {
    const o = open.get(key);
    if (o === undefined || !active()) return;
    if (force) {
      o.blocked = false;
      o.failures = 0;
      clearRetry(o);
    }
    // One call in flight per ref, none while a retry is waiting or the refusal is final.
    if (o.blocked || o.retryTimer !== null) return;
    if (lacks('feed.subscribe') || lacks('feed.snapshot')) {
      o.blocked = true;
      store.dispatch({ t: 'feed.failed', ref: o.ref, epoch: store.getState().epoch });
      return;
    }
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
          o.failures = 0;
        } catch (error) {
          if (store.getState().epoch === epoch) store.dispatch({ t: 'feed.failed', ref: o.ref, epoch });
          if (isTransient(error)) {
            // Transient: the same call again after a growing pause (1 s, 2 s, 5 s, 10 s, then 30 s).
            const wait = FEED_RETRY_MS[Math.min(o.failures, FEED_RETRY_MS.length - 1)]!;
            o.failures++;
            o.again = false;
            o.retryTimer = clock.setTimeout(() => {
              o.retryTimer = null;
              void syncFeed(key);
            }, wait);
          } else {
            o.blocked = true;
            o.again = false;
          }
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

  // ---- rooms ----
  const rooms = new Map<string, { ref: RoomRef; count: number; running: boolean }>();
  async function syncRoom(key: string): Promise<void> {
    const r = rooms.get(key);
    if (r === undefined || !active() || r.running) return;
    if (lacks('context.messages')) {
      store.dispatch({ t: 'room.failed', ref: r.ref, epoch: store.getState().epoch, more: false });
      return;
    }
    r.running = true;
    try {
      const epoch = store.getState().epoch;
      try {
        const res = (await rpc.call('context.messages', { projectPath: r.ref.projectPath, workId: r.ref.workId, roomId: r.ref.roomId })) as {
          messages?: unknown;
          page?: { next?: unknown; complete?: unknown };
        } | null;
        if (res === null || !Array.isArray(res.messages)) throw new Error('bad context.messages');
        const next = typeof res.page?.next === 'string' && res.page.complete !== true ? res.page.next : null;
        store.dispatch({ t: 'room.loaded', ref: r.ref, epoch, messages: res.messages as never[], next });
      } catch {
        store.dispatch({ t: 'room.failed', ref: r.ref, epoch, more: false });
      }
    } finally {
      r.running = false;
    }
  }

  // ---- согласия ----
  let consentsRunning = false;
  let consentsAgain = false;
  let applyingList = false;
  async function syncConsents(): Promise<void> {
    if (!active() || lacks('consents.list')) return;
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
      // Снимок заново; подписку мост восстанавливает сам (A30), повторно её не просим. Новая эпоха — новый Мак/хост:
      // окончательный отказ снимается.
      for (const key of open.keys()) void syncFeed(key, true);
      for (const key of rooms.keys()) void syncRoom(key);
      return;
    }
    // The hello arrived or changed: what was held back for a missing hello may go now.
    if (next.methods !== prev.methods) {
      for (const key of rooms.keys()) void syncRoom(key);
      void syncConsents();
      for (const key of open.keys()) void syncFeed(key);
    }
    // `rooms.mail` said `reread` for an open room: read it again.
    for (const [key, chat] of Object.entries(next.roomChats)) {
      if (chat.status === 'stale' && prev.roomChats[key]?.status !== 'stale' && rooms.has(key)) {
        store.dispatch({ t: 'room.reload', ref: rooms.get(key)!.ref });
        void syncRoom(key);
      }
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
        o = { ref, count: 0, failures: 0, blocked: false, retryTimer: null, subscribed: false, running: false, again: false };
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
        clearRetry(cur);
        store.dispatch({ t: 'feed.close', ref });
        void unsubscribe(cur);
      };
    },
    reloadFeed(ref) {
      const key = sessionKey(ref);
      if (!open.has(key)) return;
      store.dispatch({ t: 'feed.reload', ref });
      void syncFeed(key, true);
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
    openRoom(ref) {
      const key = roomKey(ref);
      let r = rooms.get(key);
      if (r === undefined) {
        r = { ref, count: 0, running: false };
        rooms.set(key, r);
        store.dispatch({ t: 'room.open', ref });
      }
      r.count++;
      void syncRoom(key);
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const cur = rooms.get(key);
        if (cur === undefined || --cur.count > 0) return;
        rooms.delete(key);
        store.dispatch({ t: 'room.close', ref });
      };
    },
    reloadRoom(ref) {
      const key = roomKey(ref);
      if (!rooms.has(key)) return;
      store.dispatch({ t: 'room.reload', ref });
      void syncRoom(key);
    },
    loadOlder(ref) {
      const key = roomKey(ref);
      const chat = store.getState().roomChats[key];
      if (chat === undefined || chat.older === null || chat.more === 'loading' || !active()) return;
      const epoch = store.getState().epoch;
      store.dispatch({ t: 'room.more', ref });
      void rpc
        .call('context.messages', { projectPath: ref.projectPath, workId: ref.workId, roomId: ref.roomId, cursor: chat.older })
        .then((res) => {
          const r = res as { messages?: unknown; page?: { next?: unknown; complete?: unknown } } | null;
          if (r === null || !Array.isArray(r.messages)) throw new Error('bad page');
          store.dispatch({ t: 'room.older', ref, epoch, messages: r.messages as never[], next: typeof r.page?.next === 'string' && r.page.complete !== true ? r.page.next : null });
        })
        .catch(() => store.dispatch({ t: 'room.failed', ref, epoch, more: true }));
    },
    reloadConsents: () => void syncConsents(),
    dispose() {
      unsubscribeStore();
      unsubscribeEvents();
      for (const o of open.values()) clearRetry(o);
      open.clear();
      rooms.clear();
    },
  };

  function handle(was: boolean): void {
    const now = active();
    if (was === now) return;
    if (!now) {
      // Фон или обрыв: подписки сняты (мост снимает сам при обрыве, при фоне просим), записи ждут нового снимка.
      for (const o of open.values()) {
        void unsubscribe(o);
        // A refused feed stays in its error state (and a waiting retry stays scheduled): a reconnect is no new reason.
        if (!o.blocked) store.dispatch({ t: 'feed.reload', ref: o.ref });
      }
      // A44c: an open room is marked the same way, so the screen tells a re-read from a new letter.
      for (const r of rooms.values()) store.dispatch({ t: 'room.reload', ref: r.ref });
      return;
    }
    void syncConsents();
    for (const key of open.keys()) void syncFeed(key);
    for (const key of rooms.keys()) void syncRoom(key);
  }
}
