/**
 * Состояние вида «Chat», которое переживает размонтирование `ChatView` (ревью куска 3): черновик поля
 * ввода, вложения над ним и серые элементы очереди по `refKey` сессии. Тело вкладки рисуется только у
 * активной вкладки группы и только в виде «Chat», поэтому переход Chat → Terminal → Chat или на соседнюю
 * вкладку размонтирует вид — а набранный текст, добавленные файлы и сообщение, уже ушедшее в очередь CLI,
 * пропадать не должны. Здесь же — просьба показать карточку агента (`reveal`, кусок 4b): её ставят места
 * вне ленты (сайдбар, комната, тулбар), а лента сессии исполняет, когда смонтируется и найдёт карточку.
 */

import { create } from 'zustand';
import { useLayoutStore, type LayoutState } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import type { AgentPick } from '../agents/agents-model.js';
import type { QueuedPrompt } from './FeedList.js';

/** Ключ карточки: `cardId` у разных сессий может совпасть, поэтому с ключом сессии. */
export function cardKey(sessionKey: string, cardId: string): string {
  return `${sessionKey}\n${cardId}`;
}

/**
 * Черновик ответа на карточку (план 2026-10-01, кусок 4a): строки ленты виртуализированы и
 * размонтируются при прокрутке, поэтому выбранное и набранное живёт здесь.
 */
export interface CardDraft {
  /** Разрешение: текст отказа для модели. */
  message: string;
  /** Вопрос: номер показанного вопроса. */
  step: number;
  /** Вопрос: выбранные подписи по номеру вопроса. */
  picked: Readonly<Record<number, readonly string[]>>;
  /** Вопрос: выбран пункт «Other». */
  otherOn: Readonly<Record<number, boolean>>;
  /** Вопрос: текст «Other». */
  otherText: Readonly<Record<number, string>>;
}

export const EMPTY_CARD_DRAFT: CardDraft = { message: '', step: 0, picked: {}, otherOn: {}, otherText: {} };

/** Ждущее сообщение и сколько промптов с тем же текстом было в ленте, когда оно ушло. */
export interface Queued extends QueuedPrompt {
  seen: number;
}

/**
 * Просьба «показать» в ленте (план 2026-10-01, кусок 4b): её ставят бейдж агентов, поповер, тулбар и клик по
 * уведомлению, а исполняет лента сессии — прокручивает к цели и гасит просьбу. Цель — карточка агента (`agentId`)
 * или любой элемент ленты по `id` (`itemId`: например, ждущая карточка разрешения). `nonce` растёт на каждую:
 * повторная просьба про ту же цель — новая, а не та же.
 */
export type RevealRequest = { sessionKey: string; nonce: number } & ({ agentId: string } | { itemId: string });

/**
 * Сколько просьба ждёт карточку. Вкладку, которой ещё не было, лента открывает не сразу (подписка и снимок), а
 * сессия без вида «Chat» (Codex, старый `claude`) не исполнит её никогда — просрочена, она не должна сработать
 * позже сама, когда человек откроет ленту по другому поводу.
 */
export const REVEAL_TTL_MS = 15_000;

let lastNonce = 0;

export interface ChatUiState {
  drafts: Record<string /* refKey */, string>;
  /** Вложения поля ввода: пути файлов, которые уйдут упоминаниями вместе с текстом (`attachments.ts`). */
  attachments: Record<string /* refKey */, readonly string[]>;
  queued: Record<string /* refKey */, readonly Queued[]>;
  /** Экран агента в панели Agents по сессии (`refKey`); `null` — список (спека 2026-10-07, 5.1). */
  agentPanel: Record<string, AgentPick | null>;
  agentsPin: Record<string, string | null>;
  pinAgentsSession(workKey: string, sessionId: string | null): void;
  /** Раскрыт ли блок «Finished» панели по сессии. */
  finishedOpen: Record<string, boolean>;
  /** Подсказка про хуки Codex скрыта человеком («Got it») до закрытия окна; по `refKey` сессии. */
  hooksHintDismissed: Record<string, true>;
  dismissHooksHint(sessionKey: string): void;
  selectAgent(sessionKey: string, pick: AgentPick | null): void;
  setFinishedOpen(sessionKey: string, open: boolean): void;
  /** Одна просьба на окно: новая заменяет прежнюю. */
  reveal: RevealRequest | null;
  /** Поставить просьбу; сама гаснет через `REVEAL_TTL_MS`. */
  requestReveal(sessionKey: string, agentId: string): void;
  /** То же для элемента ленты по `id` (карточки разрешения, вопроса, плана); те же `nonce` и срок жизни. */
  requestRevealItem(sessionKey: string, itemId: string): void;
  /** Погасить просьбу с этим `nonce`; ушедшая раньше или уже заменённая новой — не трогается. */
  clearReveal(nonce: number): void;
  setDraft(key: string, text: string): void;
  /** Заменить вложения сессии; тот же массив — стор не трогается. */
  setAttachments(key: string, paths: readonly string[]): void;
  /** Черновики карточек по `cardKey`. */
  cardDrafts: Record<string, CardDraft>;
  setCardDraft(key: string, patch: Partial<CardDraft>): void;
  /** Забыть черновики карточек сессии (лента закрыта); `only` — только этих `cardId` (карточка перестала быть `pending`). */
  clearCardDrafts(sessionKey: string, only?: readonly string[]): void;
  /** Обновить очередь сессии; тот же массив — стор не трогается. */
  updateQueued(key: string, update: (was: readonly Queued[]) => readonly Queued[]): void;
}

const NONE: readonly Queued[] = [];
const NO_PATHS: readonly string[] = [];

export const useChatUiStore = create<ChatUiState>((set, get) => ({
  drafts: {},
  attachments: {},
  queued: {},
  reveal: null,
  agentPanel: {},
  agentsPin: {},
  pinAgentsSession: (workKey, sessionId) => set((state) => ({ agentsPin: { ...state.agentsPin, [workKey]: sessionId } })),
  finishedOpen: {},
  hooksHintDismissed: {},
  dismissHooksHint: (sessionKey) => set((state) => ({ hooksHintDismissed: { ...state.hooksHintDismissed, [sessionKey]: true } })),
  selectAgent: (sessionKey, pick) => set((state) => ({ agentPanel: { ...state.agentPanel, [sessionKey]: pick } })),
  setFinishedOpen: (sessionKey, open) => set((state) => ({ finishedOpen: { ...state.finishedOpen, [sessionKey]: open } })),
  requestReveal: (sessionKey, agentId) => {
    lastNonce += 1;
    const nonce = lastNonce;
    set({ reveal: { sessionKey, agentId, nonce } });
    setTimeout(() => get().clearReveal(nonce), REVEAL_TTL_MS);
  },
  requestRevealItem: (sessionKey, itemId) => {
    lastNonce += 1;
    const nonce = lastNonce;
    set({ reveal: { sessionKey, itemId, nonce } });
    setTimeout(() => get().clearReveal(nonce), REVEAL_TTL_MS);
  },
  clearReveal: (nonce) => set((state) => (state.reveal?.nonce === nonce ? { reveal: null } : state)),
  cardDrafts: {},
  setCardDraft: (key, patch) =>
    set((state) => ({ cardDrafts: { ...state.cardDrafts, [key]: { ...(state.cardDrafts[key] ?? EMPTY_CARD_DRAFT), ...patch } } })),
  clearCardDrafts: (sessionKey, only) =>
    set((state) => {
      const prefix = `${sessionKey}\n`;
      const drop = (key: string): boolean =>
        only === undefined ? key.startsWith(prefix) : only.some((id) => key === cardKey(sessionKey, id));
      if (!Object.keys(state.cardDrafts).some(drop)) return state;
      return { cardDrafts: Object.fromEntries(Object.entries(state.cardDrafts).filter(([key]) => !drop(key))) };
    }),
  setDraft: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: text } })),
  setAttachments: (key, paths) =>
    set((state) => ((state.attachments[key] ?? NO_PATHS) === paths ? state : { attachments: { ...state.attachments, [key]: paths } })),
  updateQueued: (key, update) =>
    set((state) => {
      const was = state.queued[key] ?? NONE;
      const next = update(was);
      return next === was ? state : { queued: { ...state.queued, [key]: next } };
    }),
}));

/** Только для тестов. */
export function resetChatUiStoreForTests(): void {
  useChatUiStore.setState({ drafts: {}, attachments: {}, queued: {}, reveal: null, cardDrafts: {}, agentPanel: {}, agentsPin: {}, finishedOpen: {}, hooksHintDismissed: {} });
}

/** Pin resets follow actual tab activation, including while the Agents panel is unmounted. */
export function bindAgentsPinToLayout(): () => void {
  const active = (state: LayoutState) => {
    const workKey = state.activeWorkKey;
    const layout = workKey === null ? undefined : state.layouts[workKey];
    if (workKey === null || layout === undefined) return null;
    const group = groups(layout).find((candidate) => candidate.id === layout.activeGroupId);
    const tab = group?.tabs.find((candidate) => candidate.id === group.activeTabId);
    return group === undefined || tab === undefined ? null : { workKey, groupId: group.id, tab };
  };
  return useLayoutStore.subscribe((state, previous) => {
    const next = active(state);
    if (next === null || (next.tab.kind !== 'terminal' && next.tab.kind !== 'diff')) return;
    const before = active(previous);
    if (before?.workKey === next.workKey && before.groupId === next.groupId && before.tab.id === next.tab.id) return;
    if (useChatUiStore.getState().agentsPin[next.workKey] != null) useChatUiStore.getState().pinAgentsSession(next.workKey, null);
  });
}
