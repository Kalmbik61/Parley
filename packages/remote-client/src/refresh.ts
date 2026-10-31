// Перечитывание карточек в этапе A без подписок (спека §10.3): события со склейкой 300 мс, таймер экрана сессии
// (3 с), таймер Inbox (10 с, два бюджета). Только на переднем плане и при соединении; одна заявка на сессию.
import { attentionOfSession, needsYouSessions } from './inbox.js';
import { readCards, type Rpc } from './actions.js';
import type { RemoteStore } from './store.js';
import { sessionKey, type SessionRef } from './state.js';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Открытый экран, от которого зависят таймеры. */
export type Screen =
  | { kind: 'session'; ref: SessionRef }
  /** `visible` — сессии, чьи карточки сейчас на экране (в порядке списка). */
  | { kind: 'inbox'; visible: readonly SessionRef[] }
  | { kind: 'other' };

export const COALESCE_MS = 300;
export const SESSION_POLL_MS = 3000;
export const INBOX_POLL_MS = 10_000;
export const VISIBLE_BUDGET = 10;
export const CIRCLE_BUDGET = 10;

export interface RefresherOptions {
  store: RemoteStore;
  rpc: Rpc;
  clock: Clock;
}

export interface Refresher {
  setScreen(screen: Screen): void;
  setForeground(foreground: boolean): void;
  /** Соединение готово (`ready`); после переподключения — перечитывание экрана. */
  setConnected(connected: boolean): void;
  /** Причина перечитать эту сессию: склеивается 300 мс. */
  request(ref: SessionRef): void;
  dispose(): void;
}

export function createRefresher({ store, rpc, clock }: RefresherOptions): Refresher {
  let screen: Screen = { kind: 'other' };
  let foreground = true;
  let connected = false;
  let timer: unknown = null;
  let coalesce: unknown = null;
  const pending = new Map<string, SessionRef>();
  const inflight = new Set<string>();
  const dirty = new Map<string, SessionRef>();

  const active = (): boolean => foreground && connected;

  const read = (ref: SessionRef): void => {
    if (!active()) return;
    const key = sessionKey(ref);
    if (inflight.has(key)) {
      dirty.set(key, ref);
      return;
    }
    inflight.add(key);
    void readCards(store, rpc, () => clock.now(), ref).finally(() => {
      inflight.delete(key);
      const again = dirty.get(key);
      if (again !== undefined) {
        dirty.delete(key);
        read(again);
      }
    });
  };

  const onScreen = (): SessionRef[] =>
    screen.kind === 'session' ? [screen.ref] : screen.kind === 'inbox' ? screen.visible.slice(0, VISIBLE_BUDGET) : [];

  const flush = (): void => {
    coalesce = null;
    const refs = [...pending.values()];
    pending.clear();
    for (const ref of refs) read(ref);
  };

  const request = (ref: SessionRef): void => {
    if (!active()) return;
    pending.set(sessionKey(ref), ref);
    coalesce ??= clock.setTimeout(flush, COALESCE_MS);
  };

  /** Тик Inbox: видимые (≤ 10) и круг по остальным `needs-you` (≤ 10, самые давние первыми, без только что прочитанных). */
  const inboxTick = (visible: readonly SessionRef[]): void => {
    const shown = visible.slice(0, VISIBLE_BUDGET);
    const shownKeys = new Set(shown.map(sessionKey));
    for (const ref of shown) read(ref);
    const state = store.getState();
    const rest = needsYouSessions(state)
      .filter((w) => !shownKeys.has(w.key))
      .map((w) => ({ w, at: state.cards[w.key]?.readAt ?? 0 }))
      .sort((a, b) => a.at - b.at || (a.w.key < b.w.key ? -1 : 1))
      .slice(0, CIRCLE_BUDGET);
    for (const { w } of rest) read(w.ref);
  };

  const stopTimers = (): void => {
    if (timer !== null) clock.clearInterval(timer);
    if (coalesce !== null) clock.clearTimeout(coalesce);
    timer = null;
    coalesce = null;
    pending.clear();
  };

  const restart = (): void => {
    stopTimers();
    if (!active()) return;
    if (screen.kind === 'session') {
      const { ref } = screen;
      read(ref);
      timer = clock.setInterval(() => read(ref), SESSION_POLL_MS);
    } else if (screen.kind === 'inbox') {
      // Видимость берётся у экрана на каждый тик: список мог прокрутиться.
      const tick = (): void => inboxTick(screen.kind === 'inbox' ? screen.visible : []);
      tick();
      timer = clock.setInterval(tick, INBOX_POLL_MS);
    }
  };

  // События: сессия на экране, чьё состояние (внимание или запись активности) сменилось, а также новая эпоха и
  // `activity.snapshot` — все видимые. Остальных перечитывает круг таймера.
  const unsubscribe = store.subscribe((next, prev) => {
    if (!active()) return;
    const shown = onScreen();
    if (shown.length === 0) return;
    if (next.epoch !== prev.epoch) {
      for (const ref of shown) request(ref);
      return;
    }
    if (next.activity === prev.activity && next.snapshot === prev.snapshot) return;
    for (const ref of shown) {
      const key = sessionKey(ref);
      const work = next.snapshot?.works.find((w) => w.projectPath === ref.projectPath && w.id === ref.workId);
      const session = work?.sessions.find((s) => s.id === ref.sessionId);
      const was = prev.snapshot?.works.find((w) => w.projectPath === ref.projectPath && w.id === ref.workId)?.sessions.find((s) => s.id === ref.sessionId);
      const changed =
        next.activity[key] !== prev.activity[key] ||
        (session !== undefined && was !== undefined && attentionOfSession(next, ref, session) !== attentionOfSession(prev, ref, was));
      if (changed) request(ref);
    }
  });

  return {
    setScreen(s) {
      screen = s;
      restart();
    },
    setForeground(f) {
      if (foreground === f) return;
      foreground = f;
      restart();
    },
    setConnected(c) {
      if (connected === c) return;
      connected = c;
      restart();
    },
    request,
    dispose() {
      unsubscribe();
      stopTimers();
    },
  };
}
