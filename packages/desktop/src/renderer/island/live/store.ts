/**
 * Состояние Live-голоса для вида острова: фаза, сигналы речи и сообщение об отказе (VA-13). Сам разговор ведёт
 * `LiveController`; стор только связывает его с React и держит текст для человека. Мост делегаций и очередь речи (T4)
 * подписываются на контроллер напрямую, не через стор.
 */
import { create } from 'zustand';
import { S } from '../../../shared/strings.js';
import type { LiveCallPhase, LiveController } from './controller.js';
import type { LiveDelegation, LiveResultView } from './delegation.js';

export interface LiveStoreState {
  phase: LiveCallPhase;
  humanSpeaking: boolean;
  modelPlaying: boolean;
  /** Отказ запуска или причина неожиданного закрытия; `null` — сказать нечего. */
  notice: string | null;
  controller: LiveController | null;
  /** Итоги поручений на экране: вышедшие карточкой и удержанные (T4). */
  results: readonly LiveResultView[];
  dismissResult(requestId: string): void;
  bind(controller: LiveController | null): () => void;
  /** Подключает мост делегаций: стор отражает его итоги. Возврат — отключение. */
  attachDelegation(delegation: LiveDelegation | null): () => void;
  toggle(): Promise<void>;
}

const INITIAL = { phase: 'idle', humanSpeaking: false, modelPlaying: false, notice: null, results: [] } as const;

export const useLiveStore = create<LiveStoreState>((set, get) => ({
  ...INITIAL,
  controller: null,
  dismissResult: () => {},

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

  attachDelegation(delegation) {
    if (delegation === null) {
      set({ results: [], dismissResult: () => {} });
      return () => {};
    }
    const sync = (): void => set({ results: delegation.results() });
    sync();
    set({ dismissResult: (requestId) => delegation.dismiss(requestId) });
    const unsubscribe = delegation.subscribe(sync);
    return () => {
      unsubscribe();
      set({ results: [], dismissResult: () => {} });
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
