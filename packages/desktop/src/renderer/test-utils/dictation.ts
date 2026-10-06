import type { DictationDeps } from '../voice/dictation-store.js';

/**
 * Подставные зависимости диктовки: микрофон есть, запись громкая, распознавание отдаёт `text`.
 * Без vitest: файл попадает в tsconfig.web.json, а импорт vitest тянет Node-типы в проект рендерера.
 */
export function fakeDictationDeps(text: string): DictationDeps {
  return {
    voice: {
      transcribe: async () => ({ text }),
      micStatus: async () => 'granted' as const,
      requestMic: async () => true,
      openMicSettings: async () => undefined,
    },
    settings: () => ({ enabled: true, model: 'small', language: 'auto' }),
    record: async () => ({ stop: async () => ({ pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.5 }), cancel: () => undefined }),
    toast: () => undefined,
    openVoiceSettings: () => undefined,
    copy: async () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => Date.now(),
  };
}
