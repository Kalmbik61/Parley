/**
 * Диктовка окна (спека 3.2–3.4, 6): одна запись на окно, одна очередь распознавания. Цели — поле комнаты, поле чата,
 * первый промпт «New workspace», терминал сессии — регистрируются сами и умеют вставить текст. Store решает, когда
 * писать, куда отдавать результат и что показать при ошибке. Зависимости окна (мост, запись, тосты, таймеры) —
 * через `configure`: тесты подставляют свои.
 */
import { create } from 'zustand';
import { S } from '../../shared/strings.js';
import type { VoiceUi } from '../../shared/ui-types.js';
import type { TranscribeError, VoiceApi } from '../../shared/voice-types.js';
import { isSilent } from './level.js';
import { MicError, type Recording } from './recorder.js';

export type DictationPhase = 'idle' | 'recording' | 'transcribing';

export interface DictationTarget {
  id: string;
  /** Фокус внутри элемента — горячая клавиша про эту цель. */
  element(): HTMLElement | null;
  /** Начало записи: поле запоминает каретку, куда встанет текст. */
  remember?(): void;
  insert(text: string): void;
}

export interface ToastAction {
  label: string;
  onClick(): void;
}

export interface DictationDeps {
  voice: Pick<VoiceApi, 'transcribe' | 'micStatus' | 'requestMic' | 'openMicSettings'>;
  settings(): VoiceUi;
  record(onLevel: (level: number) => void): Promise<Recording>;
  toast(text: string, action?: ToastAction): void;
  openVoiceSettings(): void;
  copy(text: string): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const MAX_RECORDING_MS = 120_000;
const LEVEL_INTERVAL_MS = 50;

export interface DictationState {
  phase: DictationPhase;
  targetId: string | null;
  level: number;
  startedAt: number | null;
  configure(deps: DictationDeps): () => void;
  register(target: DictationTarget): () => void;
  isConfigured(): boolean;
  toggle(targetId: string): Promise<void>;
  cancel(): void;
  toggleFocused(): boolean;
  canToggleFocused(): boolean;
}

const IDLE = { phase: 'idle' as const, targetId: null, level: 0, startedAt: null };

export function createDictationStore() {
  let deps: DictationDeps | null = null;
  const targets = new Map<string, DictationTarget>();
  let recording: Recording | null = null;
  let capTimer: unknown = null;
  let starting = false;
  /** Номер попытки: отмена во время старта или стопа делает результат прежней попытки чужим. */
  let session = 0;
  let lastFocusedId: string | null = null;
  /** Ворклет шлёт ~125 кадров в секунду: в store уровень пишем не чаще раза в `LEVEL_INTERVAL_MS`. */
  let lastLevelAt = Number.NEGATIVE_INFINITY;

  return create<DictationState>((set, get) => {
    const configured = (): boolean => {
      if (deps === null) return false;
      const voice = deps.settings();
      return voice.enabled && voice.model !== null;
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // Раньше диалога и поля: Esc записи не закрывает «New workspace» и не уходит агенту.
      event.preventDefault();
      event.stopPropagation();
      get().cancel();
    };

    const stopListening = (): void => {
      window.removeEventListener('keydown', onEscape, true);
      if (capTimer !== null) deps?.clearTimeout(capTimer);
      capTimer = null;
    };

    const micDenied = (d: DictationDeps): void =>
      d.toast(S.voice.micDenied, { label: S.voice.openSystemSettings, onClick: () => void d.voice.openMicSettings() });

    const showError = (d: DictationDeps, error: TranscribeError): void => {
      if (error === 'model_missing') {
        d.toast(S.voice.modelMissing, { label: S.voice.openSettings, onClick: () => d.openVoiceSettings() });
        return;
      }
      d.toast(error === 'no_speech' ? S.voice.noSpeech : error === 'engine_missing' ? S.voice.engineMissing : S.voice.failed);
    };

    const begin = async (d: DictationDeps, id: string): Promise<void> => {
      const target = targets.get(id);
      if (target === undefined) return;
      starting = true;
      const attempt = ++session;
      try {
        const status = await d.voice.micStatus();
        const allowed = status === 'granted' || (status === 'not-determined' && (await d.voice.requestMic()));
        if (attempt !== session) return;
        if (!allowed) {
          micDenied(d);
          return;
        }
        target.remember?.();
        let started: Recording;
        try {
          lastLevelAt = Number.NEGATIVE_INFINITY;
          started = await d.record((level) => {
            if (attempt !== session) return;
            const at = d.now();
            if (at - lastLevelAt < LEVEL_INTERVAL_MS) return;
            lastLevelAt = at;
            set({ level });
          });
        } catch (error) {
          if (error instanceof MicError && error.kind === 'denied') micDenied(d);
          else d.toast(S.voice.noMicrophone);
          return;
        }
        if (attempt !== session) {
          started.cancel();
          return;
        }
        recording = started;
        set({ phase: 'recording', targetId: id, level: 0, startedAt: d.now() });
        capTimer = d.setTimeout(() => void finish(), MAX_RECORDING_MS);
        window.addEventListener('keydown', onEscape, true);
      } finally {
        starting = false;
      }
    };

    const finish = async (): Promise<void> => {
      const d = deps;
      const current = recording;
      const id = get().targetId;
      if (d === null || current === null || id === null) return;
      recording = null;
      stopListening();
      set({ phase: 'transcribing', level: 0 });
      const attempt = session;
      try {
        const audio = await current.stop();
        const voice = d.settings();
        if (isSilent(audio.peak) || voice.model === null) {
          d.toast(S.voice.noSpeech);
          return;
        }
        const result = await d.voice.transcribe({ pcm: audio.pcm, language: voice.language, model: voice.model });
        if ('error' in result) {
          showError(d, result.error);
          return;
        }
        const target = targets.get(id);
        if (target !== undefined) {
          target.insert(result.text);
          return;
        }
        await d.copy(result.text);
        d.toast(S.voice.copied);
      } catch (error) {
        console.warn('[parley] voice', error);
        d.toast(S.voice.failed);
      } finally {
        if (attempt === session) set(IDLE);
      }
    };

    const resolveFocused = (): string | null => {
      const active = document.activeElement;
      if (active !== null) {
        for (const target of targets.values()) if (target.element()?.contains(active) === true) return target.id;
      }
      return lastFocusedId !== null && targets.has(lastFocusedId) ? lastFocusedId : null;
    };

    return {
      ...IDLE,

      configure(next) {
        deps = next;
        const onFocusIn = (event: FocusEvent): void => {
          for (const target of targets.values()) {
            if (target.element()?.contains(event.target as Node | null) === true) {
              lastFocusedId = target.id;
              return;
            }
          }
        };
        window.addEventListener('focusin', onFocusIn);
        return () => {
          window.removeEventListener('focusin', onFocusIn);
          get().cancel();
          if (deps === next) deps = null;
        };
      },

      register(target) {
        targets.set(target.id, target);
        return () => {
          if (targets.get(target.id) === target) targets.delete(target.id);
        };
      },

      isConfigured: configured,

      async toggle(targetId) {
        const d = deps;
        if (d === null) return;
        if (!configured()) {
          d.openVoiceSettings();
          return;
        }
        const { phase, targetId: active } = get();
        if (phase === 'transcribing' || starting) return;
        if (phase === 'recording') {
          if (active === targetId) {
            await finish();
            return;
          }
          get().cancel();
        }
        await begin(d, targetId);
      },

      cancel() {
        session += 1;
        if (get().phase === 'transcribing') return;
        const current = recording;
        recording = null;
        stopListening();
        current?.cancel();
        set(IDLE);
      },

      toggleFocused() {
        if (!configured()) return false;
        const { phase, targetId } = get();
        if (phase === 'recording' && targetId !== null) {
          void get().toggle(targetId);
          return true;
        }
        const id = resolveFocused();
        if (id === null) return false;
        void get().toggle(id);
        return true;
      },

      canToggleFocused() {
        return configured() && (get().phase === 'recording' || resolveFocused() !== null);
      },
    };
  });
}

export const useDictationStore = createDictationStore();
