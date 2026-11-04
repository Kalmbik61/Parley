// "Dictation check" (A47 spec 4.4): starts the REAL engine on a language without on-device recognition, twice in a row, and
// expects the patch guard to refuse both times: `error language-not-supported`, then `end`, never a `start` event.
import type { Engine } from './dictation';
import type { VoiceEngine } from './engine';

export const END_WAIT_MS = 3_000;

export type CheckVerdict = 'pass' | 'fail' | 'needs-network' | 'no-language';

export interface CheckReport {
  lang: string | null;
  verdict: CheckVerdict;
  lines: string[];
}

/** One attempt: the events it saw, whether recognition began (failure) and how it ended. */
async function attempt(engine: Engine, lang: string, log: (line: string) => void): Promise<'refused' | 'started' | 'service' | 'other'> {
  return new Promise((resolve) => {
    let outcome: 'refused' | 'started' | 'service' | 'other' = 'other';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(outcome);
    };
    const off = engine.subscribe({
      start() {
        log('event start');
        outcome = 'started';
        // The first start is the failure: stop at once, the audio must not get a chance to leave the phone.
        engine.abort();
        finish();
      },
      result: () => log('event result'),
      nomatch: () => log('event nomatch'),
      error(code) {
        log(`event error ${code}`);
        if (code === 'language-not-supported') outcome = 'refused';
        else if (code === 'service-not-allowed') outcome = 'service';
      },
      end() {
        log('event end');
        finish();
      },
      volume() {},
    });
    const timer = setTimeout(() => {
      log('no end within 3 s');
      engine.abort();
      finish();
    }, END_WAIT_MS);
    log(`engine.start(${lang})`);
    try {
      engine.start(lang);
    } catch (error) {
      log(`start threw: ${String(error)}`);
      finish();
    }
  });
}

export async function runGuardCheck(engine: VoiceEngine, log: (line: string) => void): Promise<CheckReport> {
  const lines: string[] = [];
  const write = (line: string): void => {
    lines.push(line);
    log(line);
  };
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
    if (outcome === 'service') {
      write('Connect to the internet and run again');
      return { lang, verdict: 'needs-network', lines };
    }
    if (outcome !== 'refused') {
      write('FAIL: no language-not-supported');
      return { lang, verdict: 'fail', lines };
    }
  }
  write('PASS');
  return { lang, verdict: 'pass', lines };
}
