/**
 * Очередь отправки Chat (спека 2026-10-16, 4.3) поверх `lib/outbox.ts`: ключ — `refKey` сессии, элемент — уже
 * собранный текст промпта. Попытка — `pty.send` с Enter (`sendToAgent`).
 *
 * Сама очередь повторяет только `busy` (через `CHAT_RETRY_MS`) и `blocked` (не раньше чем через `CHAT_RETRY_MS` и когда
 * сессия выйдет из `blocked`). Это сознательное исключение из правила «никаких автоповторов» `terminal/send.ts`:
 * повторяется только то, что человек уже отправил. Пауза у `blocked` нужна и тогда, когда окно `blocked` не видит:
 * хост отказывает так и до первого хука сессии. Тостов у повторов нет — состояние видно на сером элементе; на
 * окончательных исходах тост прежний (`showSendToast`).
 *
 * Ушло во время хода — элемент переходит в серые «Queued» (`ui-store.ts`, тот же `id`), пока не придёт промпт с тем же
 * текстом. Ушло без хода — элемент просто уходит: промпт придёт в ленту хуком.
 */

import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createOutbox, type AttemptResult, type OutboxItem } from '../lib/outbox.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { sendToAgent, showSendToast, type SendWithToastDeps } from '../terminal/send.js';
import { turnActive } from './feed-model.js';
import { useFeedStore } from './store.js';
import { useChatUiStore } from './ui-store.js';

export interface ChatOutboxPayload {
  ref: SessionRef;
  /** Собранный текст: с упоминаниями вложений (`composePrompt`) или списком путей у Codex (`composeRoomMessage`). */
  text: string;
  deps: SendWithToastDeps;
  /** Момент нажатия Send (мс эпохи): ставится при постановке в очередь, повтор его не меняет; хост считает по нему `queueMs`. */
  requestedAt: number;
}

/** Пауза перед повтором `busy` и наименьшая пауза перед повтором `blocked`. */
export const CHAT_RETRY_MS = 1000;

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

export const chatOutbox = createOutbox<ChatOutboxPayload>(attemptChatSend);
