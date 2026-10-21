/**
 * Очередь отправки Chat (спека 2026-10-16, 4.3) поверх `lib/outbox.ts`: ключ — `refKey` сессии, элемент — уже
 * собранный текст промпта. Попытка — `pty.send` с Enter (`sendToAgent`).
 *
 * Пока у живой сессии идёт ход, сообщение держит окно (затвор `ready`), а не очередь CLI: из очереди CLI его не
 * забрать (нет ×), а после Stop (Esc) Claude Code не отправляет её, а перекладывает в поле ввода — промпт не приходит,
 * серый «Queued» висел бы вечно. Окно отдаёт сообщение, когда ход закрылся (сам или по Stop). «Send now»
 * (`payload.now`) отдаёт сразу, как раньше: агент может подобрать его посреди хода, элемент становится серым «Queued»
 * CLI (`ui-store.ts`, тот же `id`), и отменить его уже нельзя. Лента приходит хуком позже отправки, поэтому сразу
 * после отправки без хода затвор ждёт промпт отправленного (не дольше `CHAT_AWAIT_PROMPT_MS`) — иначе следующее
 * сообщение прыгнуло бы в очередь CLI: слэш-команда, у которой промпта не будет, задерживает следующее не более чем
 * на эту паузу. Пока ленты нет или она ещё не готова (вкладку Chat закрыли, снимок грузится), о ходе судим по
 * активности сессии (`working` без `heldByBackground`).
 *
 * Сама очередь повторяет только `busy` (через `CHAT_RETRY_MS`) и `blocked` (не раньше чем через `CHAT_RETRY_MS` и когда
 * сессия выйдет из `blocked`). Это сознательное исключение из правила «никаких автоповторов» `terminal/send.ts`:
 * повторяется только то, что человек уже отправил. Пауза у `blocked` нужна и тогда, когда окно `blocked` не видит:
 * хост отказывает так и до первого хука сессии. Тостов у повторов нет — состояние видно на сером элементе; на
 * окончательных исходах тост прежний (`showSendToast`).
 */

import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createOutbox, type AttemptResult, type OutboxItem } from '../lib/outbox.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { sendToAgent, showSendToast, type SendWithToastDeps } from '../terminal/send.js';
import { turnActive } from './feed-model.js';
import { useFeedStore } from './store.js';
import { useChatUiStore } from './ui-store.js';

export interface ChatOutboxPayload {
  ref: SessionRef;
  /** Собранный текст: с упоминаниями вложений (`composePrompt`) или списком путей у Codex (`composeRoomMessage`). */
  text: string;
  deps: SendWithToastDeps;
  /** Момент нажатия Send (мс эпохи): ставится при постановке в очередь, автоповтор его не меняет, ручной Retry ставит заново; хост считает по нему `queueMs`. */
  requestedAt: number;
  /** «Send now»: уходит в CLI, даже пока идёт ход (затвор не держит). */
  now?: boolean;
}

/** Пауза перед повтором `busy` и наименьшая пауза перед повтором `blocked`. */
export const CHAT_RETRY_MS = 1000;

/** Сколько после отправки без хода затвор ждёт промпт отправленного, прежде чем пустить следующее сообщение. */
export const CHAT_AWAIT_PROMPT_MS = 5000;

/** Сколько промптов с этим текстом уже в ленте — по нему серый «Queued» узнаёт свой настоящий промпт. */
export function promptCount(items: readonly FeedItem[], text: string): number {
  const wanted = text.trim();
  return items.filter((item) => item.kind === 'prompt' && item.text.trim() === wanted).length;
}

const NO_ITEMS: readonly FeedItem[] = [];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ждать, пока сессия не `blocked`; уже не `blocked` (или активности нет) — сразу. */
function untilNotBlocked(ref: SessionRef): Promise<void> {
  const blocked = (): boolean => activityFor(useActivityStore.getState().byRef, ref)?.activity.activity === 'blocked';
  if (!blocked()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = useActivityStore.subscribe(() => {
      if (blocked()) return;
      off();
      resolve();
    });
  });
}

/** Отправленное без хода, чей промпт ещё не пришёл в ленту: пока ждём, ключ считается занятым. */
const awaiting = new Map<string, { text: string; seen: number; until: number }>();

function awaitPrompt(key: string, text: string, seen: number): void {
  awaiting.set(key, { text, seen, until: Date.now() + CHAT_AWAIT_PROMPT_MS });
  setTimeout(() => baseOutbox.kick(key), CHAT_AWAIT_PROMPT_MS);
}

/** Сессия работает сама (не держат её одни фоновые субагенты) — по активности, без ленты. */
function workingNow(ref: SessionRef): boolean {
  const activity = activityFor(useActivityStore.getState().byRef, ref)?.activity;
  return activity?.activity === 'working' && !activity.heldByBackground;
}

/** Ход у живой сессии идёт или она ещё ждёт промпт только что отправленного сообщения. */
function sessionBusy(key: string, ref: SessionRef): boolean {
  const entry = useWorksStore.getState().entries.find((e) => e.projectPath === ref.projectPath && e.map.work.id === ref.workId);
  if (entry?.map.sessions.find((session) => session.id === ref.sessionId)?.lifecycle !== 'active') return false;
  const feed = useFeedStore.getState().feeds[key];
  const feedItems = feed?.items ?? NO_ITEMS;
  // Ленты нет или она не готова (вкладку Chat закрыли и стор её забыл, либо снимок ещё грузится) — судим по активности сессии.
  const running = feed?.status === 'ready' ? turnActive(feedItems) : workingNow(ref);
  if (running) return true;
  const wait = awaiting.get(key);
  if (wait === undefined) return false;
  if (promptCount(feedItems, wait.text) > wait.seen || Date.now() >= wait.until) {
    awaiting.delete(key);
    return false;
  }
  return true;
}

export async function attemptChatSend(key: string, item: OutboxItem<ChatOutboxPayload>): Promise<AttemptResult> {
  const { ref, text, deps, requestedAt } = item.payload;
  const before = useFeedStore.getState().feeds[key]?.items ?? NO_ITEMS;
  const active = turnActive(before);
  const seen = promptCount(before, text);
  const outcome = await sendToAgent(deps.bridge, ref, text, true, requestedAt);
  deps.onOutcome?.(outcome);
  if (!('error' in outcome)) {
    if (outcome.reason === 'busy') return { kind: 'retry', wait: () => delay(CHAT_RETRY_MS) };
    if (outcome.reason === 'blocked') {
      return {
        kind: 'retry',
        wait: async () => {
          await delay(CHAT_RETRY_MS);
          await untilNotBlocked(ref);
        },
      };
    }
    if (outcome.submitted) {
      if (!active && item.payload.now !== true) awaitPrompt(key, text, seen);
      if (active) useChatUiStore.getState().updateQueued(key, (was) => [...was, { id: item.id, text, seen }]);
      return { kind: 'sent' };
    }
    // Вставлено без Enter (`draft`, `input`, `restarted`, `blocked-before-enter`): текст уже в поле терминала.
    if (outcome.inserted) {
      showSendToast(deps, ref, text, true, outcome);
      return { kind: 'sent' };
    }
  }
  showSendToast(deps, ref, text, true, outcome);
  return { kind: 'failed' };
}

const baseOutbox = createOutbox<ChatOutboxPayload>(attemptChatSend, {
  ready: (key, item) => item.payload.now === true || !sessionBusy(key, item.payload.ref),
});

/** Тестам нужна и очистка ожидания промптов. */
export const chatOutbox = {
  ...baseOutbox,
  resetForTests(): void {
    awaiting.clear();
    baseOutbox.resetForTests();
  },
};

/** Затвор мог открыться (ход закрылся, сессия ожила): будим каждый ключ, где есть очередь. */
function kickAll(): void {
  for (const key of Object.keys(baseOutbox.store.getState().byKey)) baseOutbox.kick(key);
}
useFeedStore.subscribe(kickAll);
useWorksStore.subscribe(kickAll);
useActivityStore.subscribe(kickAll);
