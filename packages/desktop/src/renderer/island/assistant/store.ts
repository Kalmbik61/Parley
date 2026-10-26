/**
 * Состояние помощника на острове (спека 2026-10-14, раздел 8): зеркало `assistant.changed` хоста и своё — открыт ли
 * режим, свёрнут ли он в мини-вид, идёт ли запись. Действия ходят в хост через белый список острова.
 *
 * Отправленное остров держит сам и не ждёт хоста: под нагрузкой его цикл событий стоит секундами, а вопрос должен быть
 * виден сразу. Вопрос уходит в очередь (`queue`); свободен помощник — очередь целиком уходит одним ходом с `askId` и
 * висит как `sending` («Sending…»), пока хост не вернёт этот `askId` в состоянии. Сменился id процесса хоста — хост
 * перезапустился, вопрос не дошёл: он и вся очередь возвращаются в поле. Пока идёт ход, новые сообщения ждут серыми
 * «Queued», как в чатах, и уйдут вместе, когда ход кончится; ход они не перебивают. Обмен, который сменил принятый
 * вопрос, остаётся выше в `history`: очередь уходит сама, и иначе только что дописанный ответ пропал бы, не дочитанный.
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

/** Предел текста `assistant.ask`: длиннее одно сообщение не уходит, очередь длиннее уходит частями. */
export const ASK_MAX = 4000;
/** Сколько прошлых обменов держит остров. */
const HISTORY_MAX = 10;

/** Прошлый обмен разговора: вопрос и ответ (или причина ошибки). */
export interface Exchange {
  id: number;
  question: string;
  answer: string;
}

export interface QueuedMessage {
  id: number;
  text: string;
}

/** Вопрос, отданный хосту, пока тот не принял его. */
export interface Sending {
  id: string;
  text: string;
  /** Номер хода хоста при отправке: старый хост `askId` не знает, и принятие узнаётся по смене номера. */
  turn: number;
  /** Id процесса хоста при отправке; `null` — ещё не знали (состояние хоста не пришло). */
  instance: string | null;
}

export function assistantBusy(state: { host: AssistantState; input: InputPhase; sending: Sending | null; queue: readonly QueuedMessage[] }): boolean {
  return state.input !== 'idle' || state.sending !== null || state.queue.length > 0 || BUSY_PHASES.has(state.host.phase);
}

export interface AssistantDeps {
  call: IslandBridge['call'];
  keyboard(on: boolean): void;
  ownsKeyboard(): boolean;
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
  queue: QueuedMessage[];
  sending: Sending | null;
  history: Exchange[];
  /** Решение карточки в пути: кнопка крутится, повторно не жмётся. */
  deciding: 'send' | 'cancel' | null;
  configure(deps: AssistantDeps): void;
  applyHost(state: AssistantState): void;
  openMode(request: { listen: boolean }): void;
  close(): void;
  collapse(): void;
  /** Забрать клавиатуру у острова, открытого сам (напоминание, Telegram): панель до этого не фокусируема. */
  takeKeyboard(): void;
  expand(byHover: boolean): void;
  setDraft(text: string): void;
  submit(text: string): Promise<void>;
  unqueue(id: number): void;
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
  let queued = 0;
  let exchanges = 0;
  return create<AssistantStoreState>((set, get) => {
    const stopTurn = (): void => {
      if (TURN_PHASES.has(get().host.phase)) void deps?.call('assistant.cancel', {});
    };
    /** Свободен помощник (нет хода, вопроса в пути и записи) — очередь уходит одним ходом, в пределах `ASK_MAX`. */
    const pump = (): void => {
      const state = get();
      if (deps === null || state.sending !== null || state.queue.length === 0 || state.input !== 'idle' || TURN_PHASES.has(state.host.phase)) return;
      const items: QueuedMessage[] = [];
      let size = 0;
      for (const item of state.queue) {
        const next = size + (items.length === 0 ? 0 : 2) + item.text.length;
        if (items.length > 0 && next > ASK_MAX) break;
        items.push(item);
        size = next;
      }
      const text = items.map((item) => item.text).join('\n\n');
      const sending: Sending = { id: crypto.randomUUID(), text, turn: state.host.turn, instance: state.host.instance ?? null };
      set({ queue: state.queue.slice(items.length), sending, cardError: null });
      const config = deps.config();
      deps.call('assistant.ask', { text, provider: config.provider, model: config.model, language: config.language, askId: sending.id }).catch(() => {
        if (get().sending === sending) giveBack(text);
      });
    };
    /** Вопрос не дошёл: он и всё, что ждало за ним, — в поле по порядку; повтор — Enter, без автоповторов. */
    const giveBack = (text: string): void => {
      const line = (part: string): string => part.replace(/\s+/g, ' ').trim();
      set((state) => ({
        sending: null,
        queue: [],
        draft: [text, ...state.queue.map((item) => item.text), state.draft].map(line).filter((part) => part !== '').join(' '),
        notice: S.assistant.notSent,
      }));
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
        // После `submit`: сказанное уходит одним ходом с тем, что набрали, пока шла запись.
        pump();
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
      queue: [],
      sending: null,
      history: [],
      deciding: null,
      configure: (next) => {
        deps = next;
      },
      applyHost: (host) => {
        const state = get();
        const { sending } = state;
        const reveal = host.phase === 'answering' && state.open && state.collapsed;
        // Старый хост `askId` не шлёт — тогда вопрос принят, когда сменился номер хода.
        const accepted = sending !== null && (host.askId === undefined ? host.turn !== sending.turn : host.askId === sending.id);
        const restarted = sending !== null && !accepted && sending.instance !== null && host.instance !== undefined && host.instance !== sending.instance;
        // Принятый вопрос сменил обмен на острове: прошлый уходит выше, в историю.
        const previous = state.host;
        const archived = accepted && previous.question !== null ? [{ id: ++exchanges, question: previous.question, answer: previous.answer === '' ? (previous.error ?? '') : previous.answer }] : [];
        // Ответ на напоминание или ход из Telegram приходит без вопроса: открываем помощника сами, но клавиатуру не отбираем.
        const reminderOpen = (host.origin === 'reminder' || host.origin === 'telegram') && host.turn !== previous.turn && !state.open;
        set({
          host,
          ...(reminderOpen ? { open: true, collapsed: false, byHover: false } : {}),
          ...(accepted ? { sending: null, history: [...state.history, ...archived].slice(-HISTORY_MAX) } : {}),
          ...(sending !== null && !accepted && sending.instance === null && host.instance !== undefined ? { sending: { ...sending, instance: host.instance } } : {}),
          ...(reveal ? { collapsed: false, byHover: false } : {}),
          // Ошибку на карточке стирает только новая карточка: публикация той же (смена фазы) её не трогает.
          // Новый ход (карточки и итога нет) тоже стирает причину: она жила вместе с итогом прошлой карточки.
          ...((host.proposal !== null && host.proposal.id !== previous.proposal?.id) || (host.proposal === null && host.outcome === null) ? { cardError: null } : {}),
        });
        if (restarted && sending !== null) giveBack(sending.text);
        pump();
      },
      openMode: (request) => {
        const state = get();
        if (state.open && state.input === 'listening') {
          listening?.stop();
          return;
        }
        set({ open: true, collapsed: false, byHover: false, notice: null });
        deps?.keyboard(true);
        if (request.listen) {
          stopTurn();
          startListening('send');
        }
      },
      close: () => {
        listening?.cancel();
        listening = null;
        // Вопрос в пути тоже отменяется: хост бросит ход, который ещё запускается.
        if (get().sending !== null) void deps?.call('assistant.cancel', {});
        else stopTurn();
        set({ open: false, collapsed: false, byHover: false, input: 'idle', level: 0, listenStartedAt: null, notice: null, cardError: null, queue: [], sending: null, history: [] });
        deps?.keyboard(false);
      },
      collapse: () => {
        set({ collapsed: true, byHover: false });
        deps?.keyboard(false);
      },
      takeKeyboard: () => {
        const state = get();
        if (!state.open || state.collapsed || deps === null || deps.ownsKeyboard()) return;
        deps.keyboard(true);
      },
      expand: (byHover) => set({ collapsed: false, byHover }),
      setDraft: (draft) => set({ draft }),
      submit: async (raw) => {
        const text = raw.trim();
        if (text === '' || deps === null) return;
        if (text.length > ASK_MAX) {
          set({ draft: text, notice: S.assistant.tooLong });
          return;
        }
        set({ draft: '', notice: null });
        const { proposal } = get().host;
        const answer = proposal === null ? null : matchConfirm(text);
        if (answer !== null) {
          await get().decide(answer);
          return;
        }
        queued += 1;
        set((state) => ({ queue: [...state.queue, { id: queued, text }] }));
        pump();
      },
      unqueue: (id) => set((state) => ({ queue: state.queue.filter((item) => item.id !== id) })),
      toggleListening: () => {
        if (get().input === 'listening') listening?.stop();
        // Диктовка только кладёт текст в поле — идущий ход она не перебивает (перебивает хоткей, `openMode`).
        else if (get().input === 'idle') startListening('draft');
      },
      decide: async (decision) => {
        const proposal = get().host.proposal;
        if (proposal === null || deps === null || get().deciding !== null) return;
        set({ deciding: decision, cardError: null });
        try {
          const result = await deps.call('assistant.decide', { proposalId: proposal.id, decision });
          set({ cardError: result.error });
        } catch (error) {
          set({ cardError: (error as Error).message });
        } finally {
          set({ deciding: null });
        }
      },
      reset: async () => {
        set({ queue: [], sending: null, history: [], cardError: null });
        await deps?.call('assistant.reset', {});
      },
    };
  });
}

export const useAssistantStore = createAssistantStore();
