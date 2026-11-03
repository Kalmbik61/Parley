// Waking a sleeping session from the phone (D1 §9.5 "Пробуждение спящей сессии", plan A37b): the state of the Resume
// row and of the message waiting for the agent to wake up. No React. Nothing is retried by itself: Retry is a tap.
import type { ResumeSessionOutcome } from '@parley/remote-client';

/** The answer came, the session is still `sleeping` after this long: "Still waking up". */
export const STILL_WAKING_MS = 30_000;
/** A message waiting for the first idle gives up after this long and goes back to the field. */
export const READY_TIMEOUT_MS = 120_000;

export const OLD_SLEEPING_LINE = 'Sleeping — resume it on your Mac to message it';
export const WAITING_BUBBLE = 'Waiting for the agent to wake up…';
export const HELD_BUBBLE = 'Waits for your answer above';

/** What the row above the composer shows. */
export type ResumeLine =
  | { kind: 'none' }
  | { kind: 'waking' }
  | { kind: 'still' }
  | { kind: 'unconfirmed' }
  | { kind: 'failed'; message: string };

export interface ResumeView {
  line: ResumeLine;
  /** The text of "Resume and send" that has not gone yet. `held`: the launch waits for a card the person answers. */
  pending: { text: string; held: boolean } | null;
}

export interface ResumeFacts {
  /** `sleeping` — the only state that offers waking; anything else but `closed` counts as woken. */
  lifecycle: 'sleeping' | 'closed' | 'other';
  /** A consent card (project MCP, folder trust) of this session's work holds the launch. */
  held: boolean;
  /** Attention `idle` or `unseen` (not working, not needing the person). */
  idle: boolean;
  /** `activity.lastEventAt`: a hook event after waking is the sign the CLI takes input. `null` — not ready. */
  lastEventAt: string | null;
}

/** What became of a message sent after waking: taken (any answer the bubble shows), "not ready yet" (nothing reached the
 *  terminal: `busy`, `blocked`, `no-paste-mode`), or not started at all. */
export type AutoSend = 'done' | 'retry' | 'not-started';

export interface ResumeDeps {
  resume(): Promise<ResumeSessionOutcome>;
  /** A normal `pty.send` with a NEW `clientMsgId` each time. */
  send(text: string): Promise<AutoSend>;
  /** The text goes back to the field. */
  textBack(text: string): void;
  /** The failure when the row is not on screen any more (the session left `sleeping`): a toast. */
  notify(text: string): void;
  onChange(): void;
}

/** The line's words, for the row and for the toast. */
export const lineText = (line: ResumeLine): string =>
  line.kind === 'waking' ? 'Waking up…' : line.kind === 'still' ? 'Still waking up — check your Mac' : line.kind === 'failed' ? line.message : line.kind === 'unconfirmed' ? "We couldn't confirm it woke up" : 'Sleeping';

export const hostText = (outcome: { code: string; message: string }): string => (outcome.message.trim() === '' ? outcome.code : outcome.message);

export interface Resume {
  view(): ResumeView;
  /**
   * The Resume / Retry button (`text` null) or "Resume and send" (`text` is the message). `true` — the call took the
   * text (or started the wake); the field is cleared only then. A text during a running wake attaches to it.
   */
  start(text: string | null): boolean;
  /** The screen's facts changed (`works.changed`, activity, cards). */
  observe(facts: ResumeFacts): void;
  /** Screen closed: a waiting text is not lost. */
  dispose(): void;
  /** Developer preview: set a state without calls and timers. */
  seed(view: ResumeView): void;
}

export function createResume(deps: ResumeDeps): Resume {
  let line: ResumeLine = { kind: 'none' };
  let pending: { text: string; held: boolean } | null = null;
  let inFlight = false;
  let answered = false;
  let attempting = false;
  let baseline: string | null = null;
  let lastAttempt: string | null = null;
  let last: ResumeFacts | null = null;
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  // The 2 minutes run only while no card holds the launch: `readyLeft` is what remains when paused.
  let readyLeft = READY_TIMEOUT_MS;
  let readyFrom = 0;
  let expired = false;
  // A developer preview is frozen: no timers move it off the seeded state.
  let frozen = false;
  let disposed = false;

  const timeUp = (): void => fail({ kind: 'failed', message: "Couldn't wake it — it did not get ready in 2 minutes" });
  const stopReady = (): void => {
    if (readyTimer === null) return;
    clearTimeout(readyTimer);
    readyTimer = null;
    readyLeft = Math.max(0, readyLeft - (Date.now() - readyFrom));
  };
  const startReady = (): void => {
    if (frozen || readyTimer !== null || pending === null || !answered) return;
    readyFrom = Date.now();
    readyTimer = setTimeout(() => {
      readyTimer = null;
      expired = true;
      if (pending !== null && !attempting) timeUp();
    }, readyLeft);
  };
  const clearTimers = (): void => {
    if (stillTimer !== null) clearTimeout(stillTimer);
    if (readyTimer !== null) clearTimeout(readyTimer);
    stillTimer = readyTimer = null;
    readyLeft = READY_TIMEOUT_MS;
  };
  const change = (): void => {
    if (!disposed) deps.onChange();
  };
  const giveBack = (): void => {
    if (pending === null) return;
    const text = pending.text;
    pending = null;
    deps.textBack(text);
  };
  const fail = (next: ResumeLine): void => {
    clearTimers();
    answered = false;
    line = next;
    giveBack();
    if (!disposed && last !== null && last.lifecycle !== 'sleeping') deps.notify(lineText(next));
    change();
  };
  const settle = (): void => {
    clearTimers();
    answered = false;
    line = { kind: 'none' };
    change();
  };
  const arm = (): void => {
    if (!frozen && line.kind === 'waking' && stillTimer === null && !(last?.held ?? false)) {
      stillTimer = setTimeout(() => {
        stillTimer = null;
        if (line.kind === 'waking' && !(last?.held ?? false)) {
          line = { kind: 'still' };
          change();
        }
      }, STILL_WAKING_MS);
    }
  };

  const attempt = (): void => {
    if (pending === null || last === null) return;
    const text = pending.text;
    lastAttempt = last.lastEventAt;
    attempting = true;
    change();
    void deps
      .send(text)
      .catch((): AutoSend => 'not-started')
      .then((result) => {
        attempting = false;
        if (disposed || pending === null) return;
        if (result === 'retry') {
          // Nothing reached the terminal: not ready yet. The same text goes again on the next activity event.
          if (expired) timeUp();
          else change();
          return;
        }
        pending = null;
        clearTimers();
        answered = false;
        if (result === 'not-started') {
          deps.textBack(text);
          fail({ kind: 'failed', message: "Couldn't send it — try again" });
          return;
        }
        change();
      });
  };

  const check = (): void => {
    const facts = last;
    if (facts === null || (line.kind === 'none' && pending === null)) return;
    if (facts.lifecycle === 'closed') {
      if (pending !== null) fail({ kind: 'failed', message: "Couldn't wake it — the session is closed" });
      else settle();
      return;
    }
    if (pending !== null && pending.held !== facts.held) {
      pending = { ...pending, held: facts.held };
      change();
    }
    // A card holds the launch: the row is hidden, the "still waking" and 2-minute timers wait for the answer.
    if (facts.held) {
      if (stillTimer !== null) clearTimeout(stillTimer);
      stillTimer = null;
      stopReady();
      if (line.kind === 'still') line = { kind: 'waking' };
      change();
    } else {
      arm();
      startReady();
    }
    if (facts.lifecycle === 'sleeping') return;
    // Left `sleeping`: the row is done. A waiting message goes once the CLI has shown a hook event after waking.
    if (line.kind !== 'none') {
      line = { kind: 'none' };
      if (stillTimer !== null) clearTimeout(stillTimer);
      stillTimer = null;
      change();
    }
    if (pending !== null && answered && !attempting && !facts.held && facts.idle && facts.lastEventAt !== null && facts.lastEventAt !== baseline && facts.lastEventAt !== lastAttempt) attempt();
  };

  return {
    // While a send is under way the chat's own bubble stands in for the waiting one.
    view: () => ({ line: last?.held === true && (line.kind === 'waking' || line.kind === 'still') ? { kind: 'none' } : line, pending: attempting ? null : pending }),
    start(text) {
      if (inFlight || line.kind === 'waking' || line.kind === 'still') {
        // A wake is running: a message attaches to it (once), a plain Resume has nothing to add.
        if (text === null || pending !== null) return false;
        pending = { text, held: last?.held ?? false };
        startReady();
        change();
        check();
        return true;
      }
      inFlight = true;
      answered = false;
      attempting = false;
      baseline = last?.lastEventAt ?? null;
      lastAttempt = null;
      expired = false;
      readyLeft = READY_TIMEOUT_MS;
      line = { kind: 'waking' };
      if (text !== null) pending = { text, held: false };
      change();
      void deps
        .resume()
        .then((outcome) => {
          inFlight = false;
          if (disposed) return;
          if (outcome.outcome === 'rejected') return fail({ kind: 'failed', message: `Couldn't wake it — ${hostText(outcome)}` });
          if (outcome.outcome === 'lost') return fail({ kind: 'unconfirmed' });
          answered = true;
          arm();
          startReady();
          check();
        })
        .catch(() => {
          inFlight = false;
          fail({ kind: 'unconfirmed' });
        });
      return true;
    },
    observe(facts) {
      last = facts;
      check();
    },
    dispose() {
      disposed = true;
      clearTimers();
      giveBack();
    },
    seed(view) {
      frozen = true;
      line = view.line;
      pending = view.pending;
      change();
    },
  };
}
