import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDictation,
  reasonNoLanguage,
  reasonOnDevice,
  reasonService,
  TOAST,
  type DictationDeps,
  type DictationTarget,
  type EngineEvents,
  type Fallback,
  type LanguageChoice,
  type Permission,
} from './dictation';

const GRANTED: Permission = { granted: true, canAskAgain: false, restricted: false };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function setup(over: { permission?: Permission; choice?: LanguageChoice; startThrows?: boolean } = {}) {
  let clock = 1000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let handlers: EngineEvents | null = null;
  const calls: string[] = [];
  const toasts: string[] = [];
  const inserted: string[] = [];
  const drafts: Array<{ fallback: Fallback; text: string }> = [];
  const copied: string[] = [];
  const alerts: string[] = [];
  let permission = over.permission ?? GRANTED;
  const request = vi.fn(async () => (permission = { ...permission, granted: true }));
  const state = { choice: over.choice ?? ({ ok: true, lang: 'ru-RU' } as LanguageChoice) };
  const deps: DictationDeps = {
    engine: {
      start: (lang) => {
        calls.push(`start:${lang}`);
        if (over.startThrows) throw new Error('boom');
      },
      stop: () => void calls.push('stop'),
      abort: () => void calls.push('abort'),
      releaseAudioSession: () => void calls.push('release'),
      subscribe: (h) => {
        handlers = h;
        return () => void (handlers = null);
      },
    },
    permissions: { get: async () => permission, request },
    chooseLanguage: vi.fn(async () => state.choice),
    showDenied: () => void alerts.push('denied'),
    showRestricted: () => void alerts.push('restricted'),
    copy: async (t) => void copied.push(t),
    appendDraft: (fallback, text) => void drafts.push({ fallback, text }),
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: clock + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    now: () => clock,
  };
  const dictation = createDictation();
  dictation.configure(deps);
  const advance = (ms: number): void => {
    const to = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = to;
  };
  const target = (id: string, fallback: Fallback = { kind: 'session', key: id }, focused = false): DictationTarget => ({
    id,
    fallback,
    isFocused: () => focused,
    insert: (t) => void inserted.push(`${id}:${t}`),
    toast: (t) => void toasts.push(t),
  });
  const ev = () => handlers!;
  const final = (t: string) => ev().result({ isFinal: true, results: [{ transcript: t }] });
  const setPermission = (p: Permission): void => void (permission = p);
  return { dictation, deps, calls, toasts, inserted, drafts, copied, alerts, advance, target, ev, final, request, state, setPermission };
}

type H = ReturnType<typeof setup>;
/** Tap, wait for permissions and language, own `start` event: recording. */
async function record(h: H, id: string): Promise<void> {
  h.dictation.toggle(id);
  await flush();
  h.ev().start();
}

describe('dictation: the happy path', () => {
  let h: H;
  beforeEach(() => {
    h = setup();
    h.dictation.register(h.target('a'));
  });

  it('tap → starting → start event → recording → stop → result → end inserts once', async () => {
    h.dictation.toggle('a');
    expect(h.dictation.getState().phase).toBe('starting');
    await flush();
    expect(h.calls).toEqual(['start:ru-RU']);
    expect(h.dictation.getState().phase).toBe('starting');
    h.advance(300);
    h.ev().start();
    expect(h.dictation.getState()).toMatchObject({ phase: 'recording', startedAt: 1300, lang: 'ru-RU' });
    h.ev().volume(5);
    expect(h.dictation.getState().level).toBe(0.5);
    h.dictation.toggle('a');
    expect(h.calls).toContain('stop');
    expect(h.dictation.getState().phase).toBe('transcribing');
    h.final('hello');
    h.ev().result({ isFinal: true, results: [] });
    expect(h.inserted).toEqual([]);
    h.ev().end();
    expect(h.inserted).toEqual(['a:hello']);
    expect(h.dictation.getState().phase).toBe('idle');
    expect(h.calls.at(-1)).toBe('release');
  });

  it('a tap during starting does nothing', async () => {
    h.dictation.toggle('a');
    h.dictation.toggle('a');
    await flush();
    expect(h.calls).toEqual(['start:ru-RU']);
    h.ev().start();
    h.dictation.toggle('a');
    h.dictation.toggle('a');
    expect(h.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });

  it('toggle does nothing while transcribing or cancelling', async () => {
    await record(h, 'a');
    h.dictation.toggle('a');
    h.dictation.toggle('a');
    expect(h.calls.filter((c) => c === 'start:ru-RU')).toHaveLength(1);
    h.ev().end();
    await record(h, 'a');
    h.dictation.cancel();
    expect(h.dictation.getState().phase).toBe('cancelling');
    h.dictation.toggle('a');
    expect(h.calls.filter((c) => c === 'start:ru-RU')).toHaveLength(2);
  });

  it('nomatch and an empty final result in the middle do not end the attempt', async () => {
    await record(h, 'a');
    h.final('one');
    h.ev().nomatch();
    h.ev().result({ isFinal: true, results: [] });
    expect(h.dictation.getState().phase).toBe('recording');
    h.final(' two');
    h.dictation.toggle('a');
    h.ev().end();
    expect(h.inserted).toEqual(['a:one two']);
  });

  it('2 minutes from the start event stop the recording and insert', async () => {
    h.dictation.toggle('a');
    await flush();
    h.advance(2000);
    h.ev().start();
    h.advance(119_000);
    expect(h.dictation.getState().phase).toBe('recording');
    h.advance(1_000);
    expect(h.dictation.getState().phase).toBe('transcribing');
    expect(h.calls).toContain('stop');
    h.final('long');
    h.ev().end();
    expect(h.inserted).toEqual(['a:long']);
  });
});

describe('dictation: cancel', () => {
  let h: H;
  beforeEach(() => {
    h = setup();
    h.dictation.register(h.target('a'));
  });

  it('Cancel in recording aborts and inserts nothing', async () => {
    await record(h, 'a');
    h.final('lost');
    h.dictation.cancel();
    expect(h.calls).toContain('abort');
    expect(h.dictation.getState().phase).toBe('cancelling');
    h.ev().error('aborted', '');
    h.ev().end();
    expect(h.inserted).toEqual([]);
    expect(h.toasts).toEqual([]);
    expect(h.dictation.getState().phase).toBe('idle');
  });

  it('Cancel during starting: the start event comes after → abort, not idle until end, nothing inserted', async () => {
    h.dictation.toggle('a');
    await flush();
    h.dictation.cancel();
    expect(h.dictation.getState().phase).toBe('cancelling');
    expect(h.calls).not.toContain('abort');
    h.ev().start();
    expect(h.calls).toContain('abort');
    expect(h.dictation.getState().phase).toBe('cancelling');
    h.final('x');
    h.ev().end();
    expect(h.dictation.getState().phase).toBe('idle');
    expect(h.inserted).toEqual([]);
  });

  it('Cancel while permissions are pending leaves nothing native', async () => {
    h.dictation.toggle('a');
    h.dictation.cancel();
    await flush();
    expect(h.calls).toEqual([]);
    expect(h.dictation.getState().phase).toBe('idle');
  });
});

describe('dictation: one recording per app', () => {
  it('a second target aborts the first and starts only after its end; a foreign end does not finish the second', async () => {
    const h = setup();
    h.dictation.register(h.target('a'));
    h.dictation.register(h.target('b'));
    await record(h, 'a');
    h.dictation.toggle('b');
    expect(h.calls).toEqual(['start:ru-RU', 'abort']);
    expect(h.dictation.getState().phase).toBe('cancelling');
    h.ev().end();
    await flush();
    expect(h.calls.filter((c) => c.startsWith('start'))).toHaveLength(2);
    expect(h.dictation.getState()).toMatchObject({ phase: 'starting', targetId: 'b' });
    h.ev().start();
    expect(h.dictation.getState().phase).toBe('recording');
    h.final('for b');
    h.dictation.toggle('b');
    h.ev().end();
    expect(h.inserted).toEqual(['b:for b']);
  });
});

describe('dictation: finishBeforeSend', () => {
  let h: H;
  beforeEach(() => {
    h = setup();
    h.dictation.register(h.target('a'));
    h.dictation.register(h.target('b'));
  });

  it('false when nothing is recording or another field records', async () => {
    expect(h.dictation.finishBeforeSend('a')).toBe(false);
    await record(h, 'a');
    expect(h.dictation.finishBeforeSend('b')).toBe(false);
  });

  it('in recording: stops like a tap and returns true', async () => {
    await record(h, 'a');
    expect(h.dictation.finishBeforeSend('a')).toBe(true);
    expect(h.dictation.getState().phase).toBe('transcribing');
    h.final('text');
    h.ev().end();
    expect(h.inserted).toEqual(['a:text']);
  });

  it('in starting: stop after the start event; true', async () => {
    h.dictation.toggle('a');
    await flush();
    expect(h.dictation.finishBeforeSend('a')).toBe(true);
    expect(h.dictation.getState().phase).toBe('transcribing');
    h.ev().start();
    expect(h.calls).toContain('stop');
    expect(h.calls).not.toContain('abort');
    h.final('quick');
    h.ev().end();
    expect(h.inserted).toEqual(['a:quick']);
  });

  it('in transcribing: true', async () => {
    await record(h, 'a');
    h.dictation.toggle('a');
    expect(h.dictation.finishBeforeSend('a')).toBe(true);
  });
});

describe('dictation: the field goes away', () => {
  it('removed while transcribing: a session draft gets the text and a toast; the toast is of the old screen', async () => {
    const h = setup();
    const off = h.dictation.register(h.target('s', { kind: 'session', key: 'k1' }));
    await record(h, 's');
    h.dictation.toggle('s');
    off();
    h.final('tail');
    h.ev().end();
    expect(h.drafts).toEqual([{ fallback: { kind: 'session', key: 'k1' }, text: 'tail' }]);
    expect(h.toasts).toEqual([TOAST.draft]);
  });

  it('a room draft goes through its own key', async () => {
    const h = setup();
    const off = h.dictation.register(h.target('r', { kind: 'room', key: 'room-key' }));
    await record(h, 'r');
    h.dictation.toggle('r');
    off();
    h.final('hi');
    h.ev().end();
    expect(h.drafts).toEqual([{ fallback: { kind: 'room', key: 'room-key' }, text: 'hi' }]);
  });

  it('New session: the clipboard and a toast', async () => {
    const h = setup();
    const off = h.dictation.register(h.target('n', 'clipboard'));
    await record(h, 'n');
    h.dictation.toggle('n');
    off();
    h.final('task');
    h.ev().end();
    await flush();
    expect(h.copied).toEqual(['task']);
    expect(h.toasts).toEqual([TOAST.copied]);
  });

  it('removed or blurred during recording → abort, nothing inserted', async () => {
    const h = setup();
    const off = h.dictation.register(h.target('a'));
    await record(h, 'a');
    off();
    expect(h.calls).toContain('abort');
    h.ev().end();
    expect(h.inserted).toEqual([]);
    h.dictation.register(h.target('b'));
    await record(h, 'b');
    h.dictation.onBlur('b');
    expect(h.calls.filter((c) => c === 'abort')).toHaveLength(2);
  });

  it('removing a foreign object with the same id keeps the target', async () => {
    const h = setup();
    const first = h.target('a');
    const second = h.target('a');
    const offFirst = h.dictation.register(first);
    h.dictation.register(second);
    await record(h, 'a');
    offFirst();
    expect(h.dictation.getState().phase).toBe('recording');
    h.dictation.toggle('a');
    h.final('ok');
    h.ev().end();
    expect(h.inserted).toEqual(['a:ok']);
  });

  it('background during recording aborts', async () => {
    const h = setup();
    h.dictation.register(h.target('a'));
    await record(h, 'a');
    h.dictation.onBackground();
    expect(h.calls).toContain('abort');
  });
});

describe('dictation: permissions', () => {
  it('not granted + canAskAgain → request, then start at once', async () => {
    const h = setup({ permission: { granted: false, canAskAgain: true, restricted: false } });
    h.dictation.register(h.target('a'));
    h.dictation.toggle('a');
    await flush();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.calls).toEqual(['start:ru-RU']);
  });
  it('denied → the alert, start not called', async () => {
    const h = setup({ permission: { granted: false, canAskAgain: false, restricted: false } });
    h.dictation.register(h.target('a'));
    h.dictation.toggle('a');
    await flush();
    expect(h.alerts).toEqual(['denied']);
    expect(h.calls).toEqual([]);
    expect(h.dictation.getState().phase).toBe('idle');
  });
  it('restricted → its own alert', async () => {
    const h = setup({ permission: { granted: false, canAskAgain: true, restricted: true } });
    h.dictation.register(h.target('a'));
    h.dictation.toggle('a');
    await flush();
    expect(h.alerts).toEqual(['restricted']);
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe('dictation: errors and the table of 3.4', () => {
  async function failWith(code: string | null, text?: string, over?: Parameters<typeof setup>[0]) {
    const h = setup(over);
    h.dictation.register(h.target('a'));
    await record(h, 'a');
    if (text !== undefined) h.final(text);
    if (code !== null) h.ev().error(code, '');
    h.ev().end();
    await flush();
    return h;
  }
  it('not-allowed with permissions not granted → the denied alert', async () => {
    const h = setup();
    h.dictation.register(h.target('a'));
    await record(h, 'a');
    h.setPermission({ granted: false, canAskAgain: false, restricted: false });
    h.ev().error('not-allowed', '');
    h.ev().end();
    await flush();
    expect(h.alerts).toEqual(['denied']);
  });
  it('not-allowed with permissions granted → failed toast', async () => {
    expect((await failWith('not-allowed')).toasts).toEqual([TOAST.failed]);
  });
  it('language-not-supported → reason 1, the button becomes unavailable', async () => {
    const h = await failWith('language-not-supported');
    expect(h.toasts).toEqual([reasonOnDevice('ru-RU')]);
    expect(h.dictation.getState().availability).toMatchObject({ state: 'unavailable', lang: 'ru-RU' });
  });
  it('service-not-allowed → reason 3', async () => {
    const h = await failWith('service-not-allowed');
    expect(h.toasts).toEqual([reasonService]);
    expect(h.dictation.getState().availability.state).toBe('unavailable');
  });
  it('no-speech, nomatch or no error → No speech detected', async () => {
    expect((await failWith('no-speech')).toasts).toEqual([TOAST.noSpeech]);
    expect((await failWith('nomatch')).toasts).toEqual([TOAST.noSpeech]);
    expect((await failWith(null)).toasts).toEqual([TOAST.noSpeech]);
  });
  it('interrupted → toast; aborted → nothing; the rest → failed', async () => {
    expect((await failWith('interrupted')).toasts).toEqual([TOAST.interrupted]);
    expect((await failWith('aborted')).toasts).toEqual([TOAST.noSpeech]);
    expect((await failWith('audio-capture')).toasts).toEqual([TOAST.failed]);
    expect((await failWith('network')).toasts).toEqual([TOAST.failed]);
  });
  it('interrupted after two pieces: the text is inserted and the toast shown', async () => {
    const h = setup();
    h.dictation.register(h.target('a'));
    await record(h, 'a');
    h.final('one');
    h.final('two');
    h.ev().error('interrupted', '');
    h.ev().end();
    expect(h.inserted).toEqual(['a:one two']);
    expect(h.toasts).toEqual([TOAST.interrupted]);
  });
  it('no-speech after a piece: the text is inserted, no toast', async () => {
    const h = await failWith('no-speech', 'piece');
    expect(h.inserted).toEqual(['a:piece']);
    expect(h.toasts).toEqual([]);
  });
});

describe('dictation: timeouts (4.2 item 8)', () => {
  let h: H;
  beforeEach(() => {
    h = setup();
    h.dictation.register(h.target('a'));
  });

  it('starting without start and end for 5 s → abort, toast, cancelling', async () => {
    h.dictation.toggle('a');
    await flush();
    h.advance(5000);
    expect(h.calls).toContain('abort');
    expect(h.toasts).toEqual([TOAST.failed]);
    expect(h.dictation.getState().phase).toBe('cancelling');
  });

  it('transcribing without end for 10 s → collected text inserted at once, abort, cancelling', async () => {
    await record(h, 'a');
    h.final('kept');
    h.dictation.toggle('a');
    h.advance(10_000);
    expect(h.inserted).toEqual(['a:kept']);
    expect(h.calls).toContain('abort');
    expect(h.dictation.getState().phase).toBe('cancelling');
    h.ev().end();
    expect(h.inserted).toEqual(['a:kept']);
  });

  it('cancelling without end for 3 s → idle', async () => {
    await record(h, 'a');
    h.dictation.cancel();
    h.advance(3000);
    expect(h.dictation.getState().phase).toBe('idle');
  });

  it('an error without end for 1 s counts as the end', async () => {
    await record(h, 'a');
    h.ev().error('audio-capture', '');
    expect(h.dictation.getState().phase).toBe('recording');
    h.advance(1000);
    expect(h.dictation.getState().phase).toBe('idle');
    expect(h.toasts).toEqual([TOAST.failed]);
  });

  it('a synchronous failure of engine.start → idle and a toast without waiting 5 s', async () => {
    const failing = setup({ startThrows: true });
    failing.dictation.register(failing.target('a'));
    failing.dictation.toggle('a');
    await flush();
    expect(failing.dictation.getState().phase).toBe('idle');
    expect(failing.toasts).toEqual([TOAST.failed]);
  });
});

describe('dictation: a foreign start and the debt of late ends (4.2 items 10–11)', () => {
  let h: H;
  beforeEach(() => {
    h = setup();
    h.dictation.register(h.target('a'));
  });

  it('a start after the starting timeout and its end → abort at once, phase stays idle', async () => {
    h.dictation.toggle('a');
    await flush();
    h.advance(5000);
    h.ev().end();
    expect(h.dictation.getState().phase).toBe('idle');
    h.calls.length = 0;
    h.ev().start();
    expect(h.calls).toEqual(['abort']);
    expect(h.dictation.getState().phase).toBe('idle');
  });

  it('a start in cancelling after the own start was seen → abort', async () => {
    await record(h, 'a');
    h.dictation.cancel();
    h.calls.length = 0;
    h.ev().start();
    expect(h.calls).toEqual(['abort']);
    expect(h.dictation.getState().phase).toBe('cancelling');
  });

  it('payment 1: the end of a foreign start arrives in idle and pays the debt', async () => {
    h.dictation.toggle('a');
    await flush();
    h.advance(5000);
    h.ev().end();
    h.ev().start(); // foreign: debt 1
    h.ev().error('aborted', '');
    h.ev().end(); // idle: pays
    // The next attempt is not closed by a stray end (debt is 0 now: a real end of the new attempt counts).
    await record(h, 'a');
    h.ev().end();
    expect(h.dictation.getState().phase).toBe('idle');
    expect(h.toasts.at(-1)).toBe(TOAST.noSpeech);
  });

  it('payment 2: a late end in the new attempt starting before its start is swallowed', async () => {
    await record(h, 'a');
    h.dictation.cancel();
    h.advance(3000); // cancelling timeout: debt 1, idle
    expect(h.dictation.getState().phase).toBe('idle');
    h.dictation.toggle('a');
    await flush();
    h.ev().error('aborted', '');
    h.ev().end(); // the late end of the old attempt
    expect(h.dictation.getState().phase).toBe('starting');
    h.ev().start();
    expect(h.dictation.getState().phase).toBe('recording');
    h.ev().end(); // the debt is paid: this one is real
    expect(h.dictation.getState().phase).toBe('idle');
  });

  it('with its own error before the end, the new attempt is closed (no swallowing)', async () => {
    await record(h, 'a');
    h.dictation.cancel();
    h.advance(3000);
    h.dictation.toggle('a');
    await flush();
    h.ev().error('audio-capture', '');
    h.ev().end();
    expect(h.dictation.getState().phase).toBe('idle');
    expect(h.toasts).toEqual([TOAST.failed]);
  });

  it('the debt does not go below zero', async () => {
    h.ev().end();
    h.ev().end();
    await record(h, 'a');
    h.ev().end();
    expect(h.dictation.getState().phase).toBe('idle');
  });

  it('error without end (1 s) adds to the debt too', async () => {
    await record(h, 'a');
    h.ev().error('audio-capture', '');
    h.advance(1000);
    h.dictation.toggle('a');
    await flush();
    h.ev().end();
    expect(h.dictation.getState().phase).toBe('starting');
  });
});

describe('dictation: suspend (Dictation check)', () => {
  it('events are skipped and toggle does nothing; resume restores', async () => {
    const h = setup();
    h.dictation.register(h.target('a'));
    h.dictation.suspend();
    h.dictation.toggle('a');
    await flush();
    expect(h.calls).toEqual([]);
    h.ev().start();
    h.ev().end();
    expect(h.calls).toEqual([]);
    h.dictation.resume();
    await record(h, 'a');
    expect(h.dictation.getState().phase).toBe('recording');
  });
});

describe('dictation: availability', () => {
  it('unavailable → a tap picks again; failing gives the reason toast and start is not called', async () => {
    const h = setup({ choice: { ok: false, reason: reasonNoLanguage('xx'), lang: 'xx' } });
    h.dictation.register(h.target('a'));
    await h.dictation.refreshAvailability();
    expect(h.dictation.getState().availability).toMatchObject({ state: 'unavailable' });
    h.dictation.toggle('a');
    await flush();
    expect(h.deps.chooseLanguage).toHaveBeenCalledTimes(2);
    expect(h.toasts).toEqual([reasonNoLanguage('xx')]);
    expect(h.calls).toEqual([]);
    expect(h.dictation.getState().phase).toBe('idle');
  });
  it('the keyboard language fits → start although the button was dim', async () => {
    const h = setup({ choice: { ok: false, reason: 'r', lang: 'ru-RU' } });
    h.dictation.register(h.target('a'));
    await h.dictation.refreshAvailability();
    h.state.choice = { ok: true, lang: 'en-US' };
    h.dictation.toggle('a');
    await flush();
    expect(h.calls).toEqual(['start:en-US']);
    expect(h.dictation.getState().availability).toEqual({ state: 'ready', lang: 'en-US' });
  });
  it('the tap passes the focus of the field', async () => {
    const h = setup();
    h.dictation.register(h.target('a', { kind: 'session', key: 'a' }, true));
    h.dictation.toggle('a');
    await flush();
    expect(h.deps.chooseLanguage).toHaveBeenCalledWith({ useKeyboard: true, focused: true });
  });
});
