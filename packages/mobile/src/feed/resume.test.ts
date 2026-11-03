import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeSessionOutcome } from '@parley/remote-client';
import { createResume, READY_TIMEOUT_MS, STILL_WAKING_MS, type AutoSend, type ResumeFacts } from './resume';
import { composerMode, type ComposerFacts } from './send';

const asleep: ResumeFacts = { lifecycle: 'sleeping', held: false, idle: true, lastEventAt: 't0' };
const up = (over: Partial<ResumeFacts> = {}): ResumeFacts => ({ lifecycle: 'other', held: false, idle: true, lastEventAt: 't0', ...over });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(outcome: ResumeSessionOutcome | Promise<ResumeSessionOutcome> = { outcome: 'ok' }, answers: AutoSend[] = []) {
  const sent: string[] = [];
  const back: string[] = [];
  const notes: string[] = [];
  const resume = vi.fn(async () => outcome);
  const r = createResume({
    resume,
    send: async (t) => {
      sent.push(t);
      return answers.shift() ?? 'done';
    },
    textBack: (t) => void back.push(t),
    notify: (t) => void notes.push(t),
    onChange: () => {},
  });
  r.observe(asleep);
  return { r, sent, back, resume, notes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Resume button', () => {
  it('waking while in flight, the line goes when the session leaves sleeping', async () => {
    const { r, resume } = setup();
    r.start(null);
    expect(r.view().line).toEqual({ kind: 'waking' });
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(r.view().line).toEqual({ kind: 'waking' });
    r.observe(up());
    expect(r.view()).toEqual({ line: { kind: 'none' }, pending: null });
  });

  it('a second plain tap while waking does nothing and reports not-taken', async () => {
    const { r, resume } = setup();
    expect(r.start(null)).toBe(true);
    expect(r.start(null)).toBe(false);
    await flush();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('the host refuses: "Couldn\'t wake it — <host text>", Retry calls again', async () => {
    const { r, resume } = setup({ outcome: 'rejected', code: 'conflict', message: 'Archived work' });
    r.start(null);
    await flush();
    expect(r.view().line).toEqual({ kind: 'failed', message: "Couldn't wake it — Archived work" });
    r.start(null);
    await flush();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('connection_lost is "unconfirmed", not a refusal', async () => {
    const { r } = setup({ outcome: 'lost' });
    r.start(null);
    await flush();
    expect(r.view().line).toEqual({ kind: 'unconfirmed' });
  });

  it('answered but still sleeping after 30 s: "Still waking up", no automatic retry', async () => {
    const { r, resume } = setup();
    r.start(null);
    await flush();
    await vi.advanceTimersByTimeAsync(STILL_WAKING_MS - 1);
    expect(r.view().line).toEqual({ kind: 'waking' });
    await vi.advanceTimersByTimeAsync(1);
    expect(r.view().line).toEqual({ kind: 'still' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(resume).toHaveBeenCalledTimes(1);
    r.observe(up());
    expect(r.view().line).toEqual({ kind: 'none' });
  });
});

describe('Resume and send', () => {
  it('waits for the first hook event after waking, then sends once', async () => {
    const { r, sent } = setup();
    r.start('hello');
    await flush();
    expect(r.view().pending).toEqual({ text: 'hello', held: false });
    r.observe(asleep);
    r.observe(up()); // woke, attention idle, but no hook event yet (same lastEventAt)
    await flush();
    expect(sent).toEqual([]);
    r.observe(up({ idle: false, lastEventAt: 't1' })); // working
    expect(sent).toEqual([]);
    r.observe(up({ lastEventAt: 't2' }));
    expect(sent).toEqual(['hello']);
    expect(r.view().pending).toBeNull();
    r.observe(up({ lastEventAt: 't3' }));
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2);
    expect(sent).toEqual(['hello']);
  });

  it('M1: "Resume and send" during a running wake attaches the text to it and sends once', async () => {
    const { r, sent, resume } = setup();
    r.start(null);
    await flush();
    expect(r.start('typed while waking')).toBe(true);
    expect(r.start('a second one')).toBe(false); // only one waiting text; the field keeps this one
    expect(resume).toHaveBeenCalledTimes(1);
    expect(r.view().pending).toEqual({ text: 'typed while waking', held: false });
    r.observe(up({ lastEventAt: 't1' }));
    await flush();
    expect(sent).toEqual(['typed while waking']);
  });

  it('M1: the text attached after the answer still gets its 2 minutes', async () => {
    const { r, back } = setup();
    r.start(null);
    await flush();
    r.start('late');
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(back).toEqual(['late']);
  });

  it('M2: a refusal where nothing reached the terminal keeps the text and retries on the next activity event', async () => {
    const { r, sent, back } = setup({ outcome: 'ok' }, ['retry', 'retry', 'done']);
    r.start('hello');
    await flush();
    r.observe(up({ lastEventAt: 't1' }));
    await flush();
    expect(sent).toEqual(['hello']);
    expect(r.view().pending).toEqual({ text: 'hello', held: false });
    r.observe(up({ lastEventAt: 't1' })); // the same event again: no second attempt
    await flush();
    expect(sent).toHaveLength(1);
    r.observe(up({ lastEventAt: 't2' }));
    await flush();
    r.observe(up({ lastEventAt: 't3' }));
    await flush();
    expect(sent).toEqual(['hello', 'hello', 'hello']);
    expect(r.view().pending).toBeNull();
    expect(back).toEqual([]);
  });

  it('M2: still refused when the 2 minutes are up: the text goes back', async () => {
    const { r, back } = setup({ outcome: 'ok' }, ['retry']);
    r.start('hello');
    await flush();
    r.observe(up({ lastEventAt: 't1' }));
    await flush();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(back).toEqual(['hello']);
  });

  it('m1: no hook event (lastEventAt null) is not ready', async () => {
    const { r, sent } = setup();
    r.start('hello');
    await flush();
    r.observe(up({ lastEventAt: null }));
    await flush();
    expect(sent).toEqual([]);
  });

  it('m2: a card hides the row and pauses the 2 minutes', async () => {
    const { r, back } = setup();
    r.start('hello');
    await flush();
    await vi.advanceTimersByTimeAsync(STILL_WAKING_MS - 1);
    r.observe(asleep);
    r.observe({ ...asleep, held: true });
    expect(r.view().line).toEqual({ kind: 'none' });
    await vi.advanceTimersByTimeAsync(10 * 60_000); // a person deciding the card
    expect(back).toEqual([]);
    expect(r.view().line).toEqual({ kind: 'none' });
    r.observe({ ...asleep, held: false });
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - STILL_WAKING_MS + 1);
    expect(back).toEqual(['hello']);
  });

  it('m3: a failure when the row is gone reaches the person as a toast', async () => {
    const { r, notes } = setup({ outcome: 'ok' });
    r.start('hello');
    await flush();
    r.observe(up({ idle: false })); // woke, not ready
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(notes).toEqual(["Couldn't wake it — it did not get ready in 2 minutes"]);
  });

  it('m4: a send that did not start gives the text back at once', async () => {
    const { r, back } = setup({ outcome: 'ok' }, ['not-started']);
    r.start('hello');
    await flush();
    r.observe(up({ lastEventAt: 't1' }));
    await flush();
    expect(back).toEqual(['hello']);
    expect(r.view().pending).toBeNull();
  });

  it('never sends before the resume call is answered', async () => {
    let done!: (o: ResumeSessionOutcome) => void;
    const { r, sent } = setup(new Promise<ResumeSessionOutcome>((res) => (done = res)));
    r.start('hi');
    r.observe(up({ lastEventAt: 't1' }));
    expect(sent).toEqual([]);
    done({ outcome: 'ok' });
    await flush();
    expect(sent).toEqual(['hi']);
  });

  it('held by a consent card: "Waits for your answer", the text goes after the decision and the first idle', async () => {
    const { r, sent } = setup();
    r.start('hi');
    await flush();
    r.observe(up({ held: true, idle: false, lastEventAt: 't1' }));
    expect(r.view().pending).toEqual({ text: 'hi', held: true });
    expect(sent).toEqual([]);
    r.observe(up({ held: false, lastEventAt: 't2' }));
    expect(sent).toEqual(['hi']);
  });

  it('the host refuses: the text goes back to the field with the failure line', async () => {
    const { r, back, sent } = setup({ outcome: 'rejected', code: 'busy', message: 'No free slot' });
    r.start('keep me');
    await flush();
    expect(back).toEqual(['keep me']);
    expect(sent).toEqual([]);
    expect(r.view()).toEqual({ line: { kind: 'failed', message: "Couldn't wake it — No free slot" }, pending: null });
  });

  it('2 minutes without ready: the text comes back and is never sent later', async () => {
    const { r, back, sent } = setup();
    r.start('slow');
    await flush();
    r.observe(up({ idle: false }));
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(back).toEqual(['slow']);
    expect(r.view().line.kind).toBe('failed');
    r.observe(up({ lastEventAt: 't9' }));
    expect(sent).toEqual([]);
  });

  it('screen closed while waiting: the text is not lost', async () => {
    const { r, back } = setup();
    r.start('bye');
    await flush();
    r.dispose();
    expect(back).toEqual(['bye']);
  });
});

describe('switch off', () => {
  const base: ComposerFacts = { hasMethod: true, closed: false, sleeping: true, hasResume: true, hasCard: false, blockedNoCard: false, working: false, online: true, limitNote: null, feedReady: true };
  it('without sessions.resume the old line replaces the composer; closed stays closed', () => {
    expect(composerMode({ ...base, hasResume: false })).toEqual({ kind: 'hidden', text: 'Sleeping — resume it on your Mac to message it' });
    expect(composerMode({ ...base, closed: true })).toEqual({ kind: 'hidden', text: 'This session is closed' });
    expect(composerMode(base)).toMatchObject({ kind: 'input', sendEnabled: true });
    expect(composerMode({ ...base, online: false })).toMatchObject({ kind: 'input', sendEnabled: false });
  });
});
