import { describe, expect, it, vi } from 'vitest';
import type { EngineEvents, Permission } from './dictation';
import type { VoiceEngine } from './engine';
import { runGuardCheck } from './guard-check';

type Script = (events: EngineEvents, abort: () => void) => void;

/** An engine whose every `start(lang)` plays `script` asynchronously; `abort()` ends with `aborted`+`end` like the library. */
function engineWith(script: Script, over: { permission?: Permission; request?: Permission; onDevice?: string[] } = {}) {
  const handlers: EngineEvents[] = [];
  const starts: string[] = [];
  const aborts = vi.fn();
  const engine: VoiceEngine = {
    start(lang) {
      starts.push(lang);
      setTimeout(() => handlers.forEach((h) => script(h, () => undefined)), 0);
    },
    stop() {},
    abort() {
      aborts();
      setTimeout(() => handlers.forEach((h) => (h.error('aborted', ''), h.end())), 0);
    },
    releaseAudioSession() {},
    subscribe(h) {
      handlers.push(h);
      return () => void handlers.splice(handlers.indexOf(h), 1);
    },
    supportsOnDevice: (l) => (over.onDevice ?? ['ru-RU']).includes(l),
    supportedLocales: async () => ['ru-RU', 'xx-XX'],
    inputLanguage: async () => null,
    getPermissions: async () => over.permission ?? { granted: true, canAskAgain: false, restricted: false },
    requestPermissions: async () => over.request ?? { granted: true, canAskAgain: false, restricted: false },
  };
  return { engine, starts, aborts };
}

const refuse: Script = (h) => (h.error('language-not-supported', ''), h.end());

describe('Dictation check', () => {
  it('PASS: both runs on the same language are refused without a start event', async () => {
    const { engine, starts } = engineWith(refuse);
    const report = await runGuardCheck(engine, () => undefined);
    expect(report.verdict).toBe('pass');
    expect(starts).toEqual(['xx-XX', 'xx-XX']);
  });

  it('FAIL only on a start event: aborts at once, then waits for the end', async () => {
    const { engine, aborts } = engineWith((h) => (h.start(), setTimeout(() => h.end(), 0)));
    const report = await runGuardCheck(engine, () => undefined);
    expect(report.verdict).toBe('fail');
    expect(aborts).toHaveBeenCalledOnce();
    expect(report.lines).toContain('FAIL: recognition started');
  });

  it('permissions off → No PASS, not FAIL, and the engine is never started', async () => {
    const { engine, starts } = engineWith(refuse, { permission: { granted: false, canAskAgain: false, restricted: false } });
    const report = await runGuardCheck(engine, () => undefined);
    expect(report).toMatchObject({ verdict: 'no-pass', reason: 'microphone or speech permission is off' });
    expect(starts).toEqual([]);
  });

  it('permissions are requested when askable', async () => {
    const { engine, starts } = engineWith(refuse, { permission: { granted: false, canAskAgain: true, restricted: false } });
    expect((await runGuardCheck(engine, () => undefined)).verdict).toBe('pass');
    expect(starts).toHaveLength(2);
  });

  it('service-not-allowed (no network) → No PASS with the reason', async () => {
    const { engine } = engineWith((h) => (h.error('service-not-allowed', ''), h.end()));
    expect(await runGuardCheck(engine, () => undefined)).toMatchObject({ verdict: 'no-pass', reason: 'connect to the internet and run again' });
  });

  it('another error → No PASS, not FAIL', async () => {
    const { engine } = engineWith((h) => (h.error('audio-capture', ''), h.end()));
    expect((await runGuardCheck(engine, () => undefined)).verdict).toBe('no-pass');
  });

  it('no language without on-device recognition → says so', async () => {
    const { engine, starts } = engineWith(refuse, { onDevice: ['ru-RU', 'xx-XX'] });
    expect((await runGuardCheck(engine, () => undefined)).verdict).toBe('no-language');
    expect(starts).toEqual([]);
  });
});
