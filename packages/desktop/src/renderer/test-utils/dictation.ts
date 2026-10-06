import { vi } from 'vitest';
import type { DictationDeps } from '../voice/dictation-store.js';

/** Подставные зависимости диктовки: микрофон есть, запись громкая, распознавание отдаёт `text`. */
export function fakeDictationDeps(text: string): DictationDeps {
  return {
    voice: {
      transcribe: vi.fn(async () => ({ text })),
      micStatus: vi.fn(async () => 'granted' as const),
      requestMic: vi.fn(async () => true),
      openMicSettings: vi.fn(async () => undefined),
    },
    settings: () => ({ enabled: true, model: 'small', language: 'auto' }),
    record: vi.fn(async () => ({ stop: async () => ({ pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.5 }), cancel: vi.fn() })),
    toast: vi.fn(),
    openVoiceSettings: vi.fn(),
    copy: vi.fn(async () => undefined),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => Date.now(),
  };
}
