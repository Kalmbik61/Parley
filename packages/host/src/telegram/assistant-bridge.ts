/**
 * Мост Telegram ↔ помощник (спека 2026-10-19, 10.3): текст из чата становится ходом помощника с `origin: 'telegram'`,
 * конец хода и новые карточки уходят обратно в чат. Все побочные эффекты — через `BridgeDeps`; реализацию сервиса мост
 * не знает, только его интерфейс.
 */

import { reportLine, type AssistantCardChanged, type AssistantProposal, type AssistantState } from '@parley/protocol';
import type { AssistantService } from '../assistant/assistant-service.js';
import { splitText } from './format.js';
import { T } from './texts.js';

const MAX_TEXT = 4000;
const TYPING_MS = 4000;
const STATUS_QUESTION = 'What is going on?';

export interface BridgeDeps {
  assistant: Pick<AssistantService, 'ask' | 'cancel' | 'reset' | 'decide' | 'onState' | 'settings' | 'state' | 'card' | 'onCardChanged'>;
  /** Одно сообщение (через outbox, `notice`); мост сам режет длинный текст `splitText`. */
  sendText(text: string): Promise<void>;
  /** Карточка предложения; messageId запоминает вызывающая сторона. */
  sendCard(proposal: AssistantProposal): Promise<void>;
  /** `extra` — строки под квитанцией (где остановился план, пометки); без него — только квитанция. */
  closeCard(proposalId: string, receipt: 'sent' | 'done' | 'stopped' | 'cancelled' | 'current', extra?: string): Promise<void>;
  /** `sendChatAction typing`. */
  typing(): void;
  /** `telegramCards`: карточки и для ходов с острова. */
  cardsToggle(): boolean;
  log(line: string): void;
  now?(): number;
  setInterval?: typeof setInterval;
}

export interface AssistantBridge {
  onText(text: string): Promise<void>;
  onCommand(name: 'status' | 'new'): Promise<void>;
  /** Тост для callback: пусто — принято. */
  onCallback(proposalId: string, code: 'send' | 'cancel'): Promise<string>;
  stop(): void;
}

const RUNNING = new Set<AssistantState['phase']>(['thinking', 'tool', 'answering']);
const TERMINAL = new Set<AssistantState['phase']>(['idle', 'awaiting-confirm', 'error', 'offline']);
const toChat = (state: AssistantState): boolean => state.origin === 'telegram' || state.origin === 'reminder';

export function createAssistantBridge(deps: BridgeDeps): AssistantBridge {
  const now = deps.now ?? Date.now;
  const every = deps.setInterval ?? setInterval;
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  /** Карточки, что окно уже показывало: каждая рассматривается для чата один раз, даже когда она снова становится видимой. */
  const offered = new Set<string>();
  /** Карточки, что мы отправили в чат: закрывать нужно только их. */
  const cards = new Set<string>();
  /** Карточка `actions`, что ушла в выполнение: её квитанцию даёт итог отчёта, а не исход карточки. */
  let runningPlan: string | null = null;
  /** Номер хода, чей текст уже ушёл в чат: на ход текст уходит один раз. */
  let lastSentTurn: number | null = null;
  /** Ход, что мост сам отменил ради нового текста: его оборванный ответ в чат не идёт. */
  let cancelledTurn: number | null = null;
  let asks = 0;

  const fail = (what: string) => (error: unknown): void => deps.log(`telegram: assistant bridge ${what}: ${(error as Error).message}`);

  function stopTyping(): void {
    if (typingTimer === null) return;
    clearInterval(typingTimer);
    typingTimer = null;
  }

  async function say(text: string): Promise<void> {
    for (const part of splitText(text)) await deps.sendText(part);
  }

  function onState(state: AssistantState): void {
    const running = RUNNING.has(state.phase);
    if (running && state.origin === 'telegram') {
      if (typingTimer === null) {
        deps.typing();
        typingTimer = every(() => deps.typing(), TYPING_MS);
      }
    } else stopTyping();

    // Закрытие карточек (решена, вытеснена, просрочена) идёт по событиям карточек — `onCard`: при двух активных карточках
    // из разных источников состояние окна показывает только последнюю и не говорит, какая из них решена.
    const proposal = state.proposal;
    if (proposal !== null && !offered.has(proposal.id)) {
      offered.add(proposal.id);
      if (toChat(state) || deps.cardsToggle()) {
        cards.add(proposal.id);
        void deps.sendCard(proposal).catch(fail('sendCard'));
      }
    }
    const report = state.report ?? null;
    if (report?.status === 'running' && report.proposalId !== runningPlan && cards.delete(report.proposalId)) {
      // План пошёл: кнопки карточки уже ничего не решают, но квитанцию закроет итог отчёта.
      runningPlan = report.proposalId;
    }
    if (runningPlan !== null && report?.proposalId === runningPlan && report.status !== 'running') {
      const id = runningPlan;
      runningPlan = null;
      const lines = [...(report.status === 'stopped' ? [reportLine(report)] : []), ...report.notes];
      const receipt = report.status === 'done' ? 'done' : 'stopped';
      void (lines.length === 0 ? deps.closeCard(id, receipt) : deps.closeCard(id, receipt, lines.join('\n'))).catch(fail('closeCard'));
    }

    if (TERMINAL.has(state.phase) && toChat(state) && state.turn !== lastSentTurn && state.turn !== cancelledTurn) {
      const text = state.answer !== '' ? state.answer : (state.error ?? '');
      if (text !== '') {
        lastSentTurn = state.turn;
        void say(text).catch(fail('sendText'));
      }
    }
  }

  /** Квитанция по исходу ядра; неожиданный исход (`failed`, `unknown`) — «больше не актуальна». */
  const receiptOf = (outcome: string | null): 'sent' | 'done' | 'stopped' | 'cancelled' | 'current' =>
    outcome === 'sent' || outcome === 'done' || outcome === 'stopped' || outcome === 'cancelled' ? outcome : 'current';

  function onCard(change: AssistantCardChanged): void {
    // Закрываем ровно ту карточку, что решена, вытеснена или просрочена, и только если мы её отправили в чат.
    if (change.state === 'needs_confirmation' || (change.state === 'decided' && change.outcome === null)) return;
    // Терминальная карточка больше не предлагается: id выводим из `offered`, если окно её уже не показывает (иначе её вернёт onState).
    if (deps.assistant.state().proposal?.id !== change.cardId) offered.delete(change.cardId);
    if (!cards.delete(change.cardId)) return;
    void deps.closeCard(change.cardId, change.state === 'decided' ? receiptOf(change.outcome) : 'current').catch(fail('closeCard'));
  }

  const unsubscribe = deps.assistant.onState(onState);
  const unsubscribeCards = deps.assistant.onCardChanged(onCard);

  async function onText(text: string): Promise<void> {
    if (text.length > MAX_TEXT) return deps.sendText(T.tooLong);
    const settings = deps.assistant.settings();
    if (settings === null || !settings.enabled) return deps.sendText(T.assistantOff);
    const current = deps.assistant.state();
    if (RUNNING.has(current.phase)) {
      cancelledTurn = current.turn;
      deps.assistant.cancel();
    }
    asks += 1;
    await deps.assistant.ask({ text, provider: settings.provider, model: settings.model, language: settings.language, askId: `tg-${now()}-${asks}` }, 'telegram');
  }

  return {
    onText,
    async onCommand(name) {
      if (name === 'status') return onText(STATUS_QUESTION);
      deps.assistant.reset();
      await deps.sendText(T.newConversation);
    },
    async onCallback(proposalId, code) {
      // Карточка плана подтверждается только с `action: 'actions'`: хост без него план не выполнит. Вид берём из
      // durable-карточки ядра, а не из того, что сейчас показывает остров. Решение идёт через ядро, канал — telegram.
      const forPlan = deps.assistant.card(proposalId)?.kind === 'actions';
      const result = await deps.assistant.decide(proposalId, code, forPlan ? 'actions' : undefined, 'telegram');
      return result.applied ? (result.error ?? '') : (result.error ?? T.noLongerCurrent);
    },
    stop() {
      unsubscribe();
      unsubscribeCards();
      stopTyping();
    },
  };
}
