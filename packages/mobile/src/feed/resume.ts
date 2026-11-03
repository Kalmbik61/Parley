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
  /** A consent card of this session (project MCP, folder trust) holds the launch. */
  held: boolean;
  /** Attention `idle` or `unseen` (not working, not needing the person). */
  idle: boolean;
  /** `lastEvent.at` of the session: a hook event after waking is the sign that the CLI takes input. */
  lastEventAt: string | null;
}

export interface ResumeDeps {
  resume(): Promise<ResumeSessionOutcome>;
  /** A normal `pty.send` with a NEW `clientMsgId`. */
  send(text: string): void;
  /** The text goes back to the field. */
  textBack(text: string): void;
  onChange(): void;
}

export const hostText = (outcome: { code: string; message: string }): string => (outcome.message.trim() === '' ? outcome.code : outcome.message);

export interface Resume {
  view(): ResumeView;
  /** The Resume / Retry button (`text` null) or "Resume and send" (`text` is the message). */
  start(text: string | null): void;
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
  let baseline: string | null = null;
  let last: ResumeFacts | null = null;
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimers = (): void => {
    if (stillTimer !== null) clearTimeout(stillTimer);
    if (readyTimer !== null) clearTimeout(readyTimer);
    stillTimer = readyTimer = null;
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
    change();
  };
  const settle = (): void => {
    clearTimers();
    answered = false;
    line = { kind: 'none' };
    change();
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
    if (facts.lifecycle === 'sleeping') return;
    // Left `sleeping`: the row is done. A waiting message goes once the CLI has shown a hook event after waking.
    if (line.kind !== 'none') {
      line = { kind: 'none' };
      if (stillTimer !== null) clearTimeout(stillTimer);
      stillTimer = null;
      change();
    }
    if (pending !== null && answered && !facts.held && facts.idle && facts.lastEventAt !== null && facts.lastEventAt !== baseline) {
      const text = pending.text;
      pending = null;
      clearTimers();
      answered = false;
      change();
      deps.send(text);
    }
  };

  return {
    view: () => ({ line, pending }),
    start(text) {
      if (inFlight || line.kind === 'waking' || line.kind === 'still') return;
      inFlight = true;
      answered = false;
      baseline = last?.lastEventAt ?? null;
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
          if (line.kind === 'waking') {
            stillTimer = setTimeout(() => {
              stillTimer = null;
              if (line.kind === 'waking') {
                line = { kind: 'still' };
                change();
              }
            }, STILL_WAKING_MS);
          }
          if (pending !== null) {
            readyTimer = setTimeout(() => {
              readyTimer = null;
              if (pending !== null) fail({ kind: 'failed', message: "Couldn't wake it — it did not get ready in 2 minutes" });
            }, READY_TIMEOUT_MS);
          }
          check();
        })
        .catch(() => {
          inFlight = false;
          fail({ kind: 'unconfirmed' });
        });
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
      line = view.line;
      pending = view.pending;
      change();
    },
  };
}
