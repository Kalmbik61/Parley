/**
 * Состояние Live-голоса для вида острова: фаза, сигналы речи и сообщение об отказе (VA-13). Сам разговор ведёт
 * `LiveController`; стор только связывает его с React и держит текст для человека. Мост делегаций и очередь речи (T4)
 * подписываются на контроллер напрямую, не через стор.
 */
import { create } from 'zustand';
import { S } from '../../../shared/strings.js';
import { type VoiceAnalysis, type VoiceFrame, type SwarmEmotion } from '@parley/core/swarm';
import type { LiveCallPhase, LiveController, LiveStartResult } from './controller.js';
import type { LiveDelegation, LiveResultView } from './delegation.js';
import { createEmotionSmoother, type EmotionSmoother } from '@parley/core/voice-live';

/** Что стору нужно для кадра голоса: анализ признаков (создаётся лениво, как у TTS) и часы кадра, мс. */
export interface LiveVoiceDeps {
  analysis(): VoiceAnalysis;
  now(): number;
}

/** Сколько лицо держит `error` после ошибки контроллера, мс. */
export const ERROR_EMOTION_MS = 2000;

const FFT_SIZE = 2048;

export interface LiveStoreState {
  phase: LiveCallPhase;
  humanSpeaking: boolean;
  modelPlaying: boolean;
  /** Отказ запуска или причина неожиданного закрытия; `null` — сказать нечего. */
  notice: string | null;
  controller: LiveController | null;
  /** Итоги поручений на экране: вышедшие карточкой и удержанные (T4). */
  results: readonly LiveResultView[];
  /** Есть Request этой голосовой сессии без итога: рой показывает «проверяю». */
  checking: boolean;
  /** Эмоция лица, пока говорит модель; `calm` по умолчанию. Её ведут Decisions GPT-Live (V2) и ошибка контроллера. */
  emotion: SwarmEmotion;
  /** Задаёт эмоцию лица. Пока идёт вспышка ошибки (2 с), `error` сильнее: новое значение запоминается и появится после неё. */
  setEmotion(emotion: SwarmEmotion): void;
  /** Подключает анализ признаков голоса для `voiceFrame`. */
  configureVoice(deps: LiveVoiceDeps | null): void;
  /** Кадр голоса модели для рта лица; `null`, пока модель не играет или в треке нет данных. */
  voiceFrame(): VoiceFrame | null;
  dismissResult(requestId: string): void;
  bind(controller: LiveController | null): () => void;
  /** Подключает мост делегаций: стор отражает его итоги. Возврат — отключение. */
  attachDelegation(delegation: LiveDelegation | null): () => void;
  /** Запуск разговора; `null` — контроллера нет или фаза не `idle` (запускать нечего). Отказ ложится в `notice`. */
  start(): Promise<LiveStartResult | null>;
  toggle(): Promise<void>;
  /** Завершает диалог в любой фазе, кроме `idle` и `closing`: и во время подключения (`toggle` там ничего не делает). */
  end(): Promise<void>;
}

const INITIAL = { phase: 'idle', humanSpeaking: false, modelPlaying: false, notice: null, results: [], checking: false, emotion: 'calm' } as const;

export const useLiveStore = create<LiveStoreState>((set, get) => {
  const frameTime = new Float32Array(FFT_SIZE);
  const frameFreq = new Float32Array(FFT_SIZE / 2);
  let voiceDeps: LiveVoiceDeps | null = null;
  let analysis: VoiceAnalysis | null = null;
  let frameAt: number | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Что должно быть на лице без вспышки ошибки: последнее значение `setEmotion` (пока вспышка идёт, лицо его не показывает). */
  let wanted: SwarmEmotion = 'calm';
  let smoother: EmotionSmoother | null = null;

  const clearErrorTimer = (): void => {
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = null;
  };
  /** Ошибка контроллера: лицо показывает `error` две секунды, потом возвращается к спокойному. */
  const flashError = (): void => {
    clearErrorTimer();
    set({ emotion: 'error' });
    errorTimer = setTimeout(() => {
      errorTimer = null;
      if (get().emotion === 'error') set({ emotion: wanted });
    }, ERROR_EMOTION_MS);
  };

  return {
    ...INITIAL,
    controller: null,
    dismissResult: () => {},

    setEmotion(emotion) {
      wanted = emotion;
      if (errorTimer !== null) return;
      set({ emotion });
    },

    configureVoice(deps) {
      voiceDeps = deps;
      analysis = null;
      frameAt = null;
    },

    voiceFrame() {
      const { controller, modelPlaying } = get();
      if (voiceDeps === null || controller === null || !modelPlaying || !controller.readVoice(frameTime, frameFreq)) {
        frameAt = null;
        return null;
      }
      analysis ??= voiceDeps.analysis();
      const now = voiceDeps.now();
      const dt = frameAt === null ? 1 / 60 : Math.max(0, now - frameAt) / 1000;
      frameAt = now;
      return analysis.step(frameTime, frameFreq, dt, now, false);
    },

    bind(controller) {
      get().controller?.dispose();
      clearErrorTimer();
      smoother?.reset();
      smoother = null;
      wanted = 'calm';
      analysis = null;
      frameAt = null;
      set({ ...INITIAL, controller });
      if (controller === null) return () => {};
      // Эмоцию Decisions сглаживает чистый модуль; на лицо она идёт через `setEmotion`, который вспышку ошибки не прерывает.
      const faces = createEmotionSmoother({
        now: () => Date.now(),
        setTimer: (callback, ms) => {
          const id = setTimeout(callback, ms);
          return () => clearTimeout(id);
        },
        apply: (emotion) => get().setEmotion(emotion),
      });
      smoother = faces;
      const unsubscribe = controller.subscribe((event) => {
        if (event.type === 'phase') {
          set({ phase: event.phase });
          if (event.phase === 'idle') {
            clearErrorTimer();
            faces.reset();
            wanted = 'calm';
            set({ emotion: 'calm' });
          }
        } else if (event.type === 'error') flashError();
        else if (event.type === 'emotion') faces.decision({ value: event.value, confidence: event.confidence, sourceEndMs: event.sourceEndMs });
        else if (event.type === 'humanSpeaking') set({ humanSpeaking: event.value });
        else if (event.type === 'modelPlaying') {
          set({ modelPlaying: event.value });
          faces.setPlaying(event.value);
        } else if (event.type === 'sessionClosed') set({ notice: event.reason === 'close_requested' ? null : S.assistant.live.closed(event.reason) });
      });
      return () => {
        unsubscribe();
        faces.reset();
        if (smoother === faces) smoother = null;
        clearErrorTimer();
        if (get().controller === controller) set({ ...INITIAL, controller: null });
        controller.dispose();
      };
    },

    attachDelegation(delegation) {
      if (delegation === null) {
        set({ results: [], checking: false, dismissResult: () => {} });
        return () => {};
      }
      const sync = (): void => set({ results: delegation.results(), checking: delegation.checking() });
      sync();
      set({ dismissResult: (requestId) => delegation.dismiss(requestId) });
      const unsubscribe = delegation.subscribe(sync);
      return () => {
        unsubscribe();
        set({ results: [], checking: false, dismissResult: () => {} });
      };
    },

    async start() {
      const { controller, phase } = get();
      if (controller === null || phase !== 'idle') return null;
      set({ notice: null });
      const result = await controller.start();
      if (!result.ok) set({ notice: result.message });
      return result;
    },

    async toggle() {
      const { controller, phase } = get();
      if (controller === null) return;
      if (phase === 'live') {
        await controller.stop();
        return;
      }
      await get().start();
    },

    async end() {
      const { controller, phase } = get();
      if (controller === null || phase === 'idle' || phase === 'closing') return;
      await controller.stop();
    },
  };
});
