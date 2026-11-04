/**
 * Состояние Live-голоса для вида острова: фаза, сигналы речи и сообщение об отказе (VA-13). Сам разговор ведёт
 * `LiveController`; стор только связывает его с React и держит текст для человека. Мост делегаций и очередь речи (T4)
 * подписываются на контроллер напрямую, не через стор.
 */
import { create } from 'zustand';
import { S } from '../../../shared/strings.js';
import type { LiveCallPhase, LiveController } from './controller.js';

export interface LiveStoreState {
  phase: LiveCallPhase;
  humanSpeaking: boolean;
  modelPlaying: boolean;
  /** Отказ запуска или причина неожиданного закрытия; `null` — сказать нечего. */
  notice: string | null;
  controller: LiveController | null;
  bind(controller: LiveController | null): () => void;
  toggle(): Promise<void>;
}

const INITIAL = { phase: 'idle', humanSpeaking: false, modelPlaying: false, notice: null } as const;

export const useLiveStore = create<LiveStoreState>((set, get) => ({
  ...INITIAL,
  controller: null,

  bind(controller) {
    get().controller?.dispose();
    set({ ...INITIAL, controller });
    if (controller === null) return () => {};
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === 'phase') set({ phase: event.phase });
      else if (event.type === 'humanSpeaking') set({ humanSpeaking: event.value });
      else if (event.type === 'modelPlaying') set({ modelPlaying: event.value });
      else if (event.type === 'sessionClosed') set({ notice: event.reason === 'close_requested' ? null : S.assistant.live.closed(event.reason) });
    });
    return () => {
      unsubscribe();
      if (get().controller === controller) set({ ...INITIAL, controller: null });
      controller.dispose();
    };
  },

  async toggle() {
    const { controller, phase } = get();
    if (controller === null) return;
    if (phase === 'live') {
      await controller.stop();
      return;
    }
    if (phase !== 'idle') return;
    set({ notice: null });
    const result = await controller.start();
    if (!result.ok) set({ notice: result.message });
  },
}));
