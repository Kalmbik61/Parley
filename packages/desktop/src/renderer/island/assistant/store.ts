/**
 * Состояние помощника на острове (спека 2026-10-14, раздел 8): зеркало `assistant.changed` хоста и своё — открыт ли
 * режим, свёрнут ли он в мини-вид, идёт ли запись. Действия ходят в хост через белый список острова.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { matchConfirm } from '@parley/core/assistant';
import type { AssistantState } from '@parley/protocol';
import type { IslandAssistantConfig, IslandBridge } from '../../../shared/island.js';
import { S } from '../../../shared/strings.js';
import type { Listening } from './listen.js';

export type InputPhase = 'idle' | 'listening' | 'transcribing';

export const HOST_IDLE: AssistantState = { phase: 'idle', detail: null, question: null, answer: '', mood: 'calm', proposal: null, outcome: null, error: null, turn: 0 };

const TURN_PHASES: ReadonlySet<AssistantState['phase']> = new Set(['thinking', 'tool', 'answering']);
const BUSY_PHASES: ReadonlySet<AssistantState['phase']> = new Set(['thinking', 'tool', 'answering', 'awaiting-confirm']);

export function assistantBusy(state: { host: AssistantState; input: InputPhase }): boolean {
  return state.input !== 'idle' || BUSY_PHASES.has(state.host.phase);
}

export interface AssistantDeps {
  call: IslandBridge['call'];
  keyboard(on: boolean): void;
  config(): IslandAssistantConfig;
  /** `null` — голос выключен или модель Whisper не скачана. */
  listen(hooks: { onLevel(level: number): void; onTranscribing(): void }): Listening | null;
}

export interface AssistantStoreState {
  host: AssistantState;
  open: boolean;
  collapsed: boolean;
  /** Раскрыт наведением — уход курсора сворачивает обратно. */
  byHover: boolean;
  input: InputPhase;
  level: number;
  /** Когда началась запись (для таймера); `null` — не записываем. */
  listenStartedAt: number | null;
  draft: string;
  notice: string | null;
  cardError: string | null;
  /** Номер хода на момент открытия: ответ после него — повод свернуться через 8 с. */
  openedTurn: number;
  configure(deps: AssistantDeps): void;
  applyHost(state: AssistantState): void;
  openMode(request: { listen: boolean }): void;
  close(): void;
  collapse(): void;
  expand(byHover: boolean): void;
  setDraft(text: string): void;
  submit(text: string): Promise<void>;
  toggleListening(): void;
  decide(decision: 'send' | 'cancel'): Promise<void>;
  reset(): Promise<void>;
}

export function createAssistantStore(): UseBoundStore<StoreApi<AssistantStoreState>> {
  let deps: AssistantDeps | null = null;
  let listening: Listening | null = null;
  /**
   * Что делать с распознанным: `send` — хоткей (⌥Space), голосовой сценарий без рук, вопрос уходит сразу (спека 8.4);
   * `draft` — кнопка микрофона, как диктовка в чатах: текст ложится в поле, отправляет человек Enter-ом.
   */
  let listenMode: 'send' | 'draft' = 'send';
  return create<AssistantStoreState>((set, get) => {
    const stopTurn = (): void => {
      if (TURN_PHASES.has(get().host.phase)) void deps?.call('assistant.cancel', {});
    };
    const startListening = (mode: 'send' | 'draft'): void => {
      if (deps === null) return;
      const session = deps.listen({
        onLevel: (level) => set({ level }),
        onTranscribing: () => set({ input: 'transcribing', level: 0, listenStartedAt: null }),
      });
      if (session === null) {
        set({ notice: S.assistant.voiceOff });
        return;
      }
      listening = session;
      listenMode = mode;
      set({ input: 'listening', notice: null, listenStartedAt: Date.now() });
      void session.result.then((result) => {
        if (listening === session) listening = null;
        set({ input: 'idle', level: 0, listenStartedAt: null });
        if ('text' in result) {
          if (listenMode === 'send') void get().submit(result.text);
          else set({ draft: result.text });
        } else if (result.error === 'mic') set({ notice: S.assistant.micDenied });
        else if (result.error === 'no_speech') set({ notice: S.assistant.noSpeech });
        else if (result.error === 'voice') set({ notice: S.assistant.voiceFailed });
      });
    };
    return {
      host: HOST_IDLE,
      open: false,
      collapsed: false,
      byHover: false,
      input: 'idle',
      level: 0,
      listenStartedAt: null,
      draft: '',
      notice: null,
      cardError: null,
      openedTurn: 0,
      configure: (next) => {
        deps = next;
      },
      applyHost: (host) => {
        const state = get();
        const reveal = host.phase === 'answering' && state.open && state.collapsed;
        set({ host, ...(reveal ? { collapsed: false, byHover: false } : {}), ...(host.proposal === null ? { cardError: null } : {}) });
      },
      openMode: (request) => {
        const state = get();
        if (state.open && state.input === 'listening') {
          listening?.stop();
          return;
        }
        set({ open: true, collapsed: false, byHover: false, notice: null, openedTurn: state.open ? state.openedTurn : state.host.turn });
        deps?.keyboard(true);
        if (request.listen) {
          stopTurn();
          startListening('send');
        }
      },
      close: () => {
        listening?.cancel();
        listening = null;
        stopTurn();
        set({ open: false, collapsed: false, byHover: false, input: 'idle', level: 0, listenStartedAt: null, notice: null });
        deps?.keyboard(false);
      },
      collapse: () => {
        set({ collapsed: true, byHover: false });
        deps?.keyboard(false);
      },
      expand: (byHover) => set({ collapsed: false, byHover }),
      setDraft: (draft) => set({ draft }),
      submit: async (raw) => {
        const text = raw.trim();
        if (text === '' || deps === null) return;
        set({ draft: '', notice: null });
        const { proposal } = get().host;
        const answer = proposal === null ? null : matchConfirm(text);
        if (answer !== null) {
          await get().decide(answer);
          return;
        }
        const config = deps.config();
        await deps.call('assistant.ask', { text, provider: config.provider, model: config.model, language: config.language });
      },
      toggleListening: () => {
        if (get().input === 'listening') listening?.stop();
        else if (get().input === 'idle') {
          stopTurn();
          startListening('draft');
        }
      },
      decide: async (decision) => {
        const proposal = get().host.proposal;
        if (proposal === null || deps === null) return;
        const result = await deps.call('assistant.decide', { proposalId: proposal.id, decision });
        set({ cardError: result.error });
      },
      reset: async () => {
        await deps?.call('assistant.reset', {});
      },
    };
  });
}

export const useAssistantStore = createAssistantStore();
