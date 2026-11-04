/** Поддельный движок для разработки (PARLEY_MOBILE_DEV_VOICE=fake): события идут в настоящем асинхронном порядке. */
import type { EngineEvents } from './dictation';
import type { VoiceEngine } from './engine';

export const FAKE_SENTENCE = 'This is a dictated test sentence.';

/** `off`: у языка нет распознавания (кнопка тусклая, тап даёт тост). */
export function createFakeEngine(mode: 'on' | 'off' = 'on'): VoiceEngine {
  const subscribers = new Set<EngineEvents>();
  const emit = (fn: (h: EngineEvents) => void): void => subscribers.forEach(fn);
  let active = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let tick = 0;
  const stopTicker = (): void => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };
  const finish = (afterMs: number, text: string | null): void => {
    stopTicker();
    setTimeout(() => {
      if (!active) return;
      active = false;
      if (text !== null) emit((h) => h.result({ isFinal: true, results: [{ transcript: text }] }));
      emit((h) => h.end());
    }, afterMs);
  };
  return {
    start() {
      active = true;
      setTimeout(() => {
        if (!active) return;
        emit((h) => h.start());
        tick = 0;
        ticker = setInterval(() => {
          tick += 1;
          emit((h) => h.volume(5 + 4 * Math.sin(tick / 3)));
        }, 100);
      }, 1500);
    },
    stop() {
      finish(3000, FAKE_SENTENCE);
    },
    abort() {
      emit((h) => h.error('aborted', ''));
      finish(50, null);
    },
    releaseAudioSession() {},
    subscribe(events) {
      subscribers.add(events);
      return () => void subscribers.delete(events);
    },
    supportsOnDevice: () => mode === 'on',
    supportedLocales: async () => (mode === 'on' ? ['en-US', 'ru-RU'] : []),
    inputLanguage: async () => null,
    getPermissions: async () => ({ granted: true, canAskAgain: false, restricted: false }),
    requestPermissions: async () => ({ granted: true, canAskAgain: false, restricted: false }),
  };
}
