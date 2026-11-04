// "Dictation check" (A47 spec 4.4): starts the REAL engine on a language without on-device recognition, twice in a row, and
// expects the patch guard to refuse both times: `error language-not-supported`, then `end`, never a `start` event.
import type { VoiceEngine } from './engine';

export const END_WAIT_MS = 3_000;

/** `fail` only for a `start` event; everything else that is not a clean refusal is `no-pass` with its reason. */
export type CheckVerdict = 'pass' | 'fail' | 'no-pass' | 'no-language';

export interface CheckReport {
  lang: string | null;
  verdict: CheckVerdict;
  /** For `no-pass`. */
  reason?: string;
  lines: string[];
}

type Outcome = 'refused' | 'started' | 'service' | 'no-end' | 'other';

/** One attempt. Resolves after the attempt's `end` (or 3 s after an abort), so a late `end` cannot reach the store. */
function attempt(engine: VoiceEngine, lang: string, log: (line: string) => void): Promise<Outcome> {
  return new Promise((resolve) => {
    let outcome: Outcome = 'other';
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      clearTimeout(timer);
      off();
      resolve(outcome);
    };
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      engine.abort();
      // Wait for the `end` of the abort, not longer than 3 s.
      clearTimeout(timer);
      timer = setTimeout(settle, END_WAIT_MS);
    };
    const off = engine.subscribe({
      start() {
        log('event start');
        outcome = 'started';
        // The first start is the failure: stop at once, the audio must not get a chance to leave the phone.
        abort();
      },
      result: () => log('event result'),
      nomatch: () => log('event nomatch'),
      error(code) {
        log(`event error ${code}`);
        if (outcome === 'started') return;
        if (code === 'language-not-supported') outcome = 'refused';
        else if (code === 'service-not-allowed') outcome = 'service';
      },
      end() {
        log('event end');
        settle();
      },
      volume() {},
    });
    timer = setTimeout(() => {
      log('no end within 3 s');
      if (outcome === 'other') outcome = 'no-end';
      abort();
    }, END_WAIT_MS);
    log(`engine.start(${lang})`);
    try {
      engine.start(lang);
    } catch (error) {
      log(`start threw: ${String(error)}`);
      settle();
    }
  });
}

export async function runGuardCheck(engine: VoiceEngine, log: (line: string) => void): Promise<CheckReport> {
  const lines: string[] = [];
  const write = (line: string): void => {
    lines.push(line);
    log(line);
  };
  const noPass = (lang: string | null, reason: string): CheckReport => {
    write(`No PASS: ${reason}`);
    return { lang, verdict: 'no-pass', reason, lines };
  };
  // Permissions first: without them the engine answers `not-allowed` and the guard is never reached.
  let permission = await engine.getPermissions();
  if (!permission.granted && !permission.restricted && permission.canAskAgain) permission = await engine.requestPermissions();
  if (!permission.granted) return noPass(null, 'microphone or speech permission is off');
  const locales = await engine.supportedLocales();
  const lang = locales.find((l) => !engine.supportsOnDevice(l)) ?? null;
  if (lang === null) {
    write('Every supported language has on-device recognition: nothing to try.');
    return { lang, verdict: 'no-language', lines };
  }
  for (const run of [1, 2]) {
    write(`Run ${run} on ${lang}`);
    const outcome = await attempt(engine, lang, write);
    if (outcome === 'started') {
      write('FAIL: recognition started');
      return { lang, verdict: 'fail', lines };
    }
    if (outcome === 'service') return noPass(lang, 'connect to the internet and run again');
    if (outcome === 'no-end') return noPass(lang, 'no end event within 3 s');
    if (outcome !== 'refused') return noPass(lang, 'no language-not-supported error');
  }
  write('PASS');
  return { lang, verdict: 'pass', lines };
}
