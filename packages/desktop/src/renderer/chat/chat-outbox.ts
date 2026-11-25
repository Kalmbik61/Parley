/**
 * Очередь отправки Chat (спека 2026-10-16, 4.3) поверх `lib/outbox.ts`: ключ — `refKey` сессии, элемент — уже
 * собранный текст промпта. Попытка — `pty.send` с Enter (`sendToAgent`).
 *
 * Пока у живой сессии идёт ход, сообщение держит окно (затвор `ready`), а не очередь CLI: из очереди CLI его не
 * забрать (нет ×), а после Stop (Esc) Claude Code не отправляет её, а перекладывает в поле ввода — промпт не приходит,
 * серый «Queued» висел бы вечно. Окно отдаёт сообщение, когда ход закрылся (сам или по Stop). «Send now»
 * (`payload.now`) отдаёт сразу, как раньше: агент может подобрать его посреди хода, и отменить его уже нельзя.
 * При любой успешной отправке серый элемент остаётся в ленте до настоящего промпта (`ui-store.ts`, тот же `id`).
 * Лента приходит хуком, независимо от ответа на отправку, поэтому сразу
 * после отправки без хода затвор ждёт промпт отправленного (не дольше `CHAT_AWAIT_PROMPT_MS`) — иначе следующее
 * сообщение прыгнуло бы в очередь CLI: слэш-команда, у которой промпта не будет, задерживает следующее не более чем
 * на эту паузу. Пока ленты нет или она ещё не готова (вкладку Chat закрыли, снимок грузится), о ходе судим по
 * активности сессии (`working` без `heldByBackground`).
 *
 * Так же затвор держит сообщение, пока сжатие контекста ждёт или идёт (`metrics.compaction`, спека 2026-10-15, 5.4):
 * слэш-команда `/compact` хода в ленте не открывает, а хост держит сессию замком, и `pty.send` отказал бы `blocked` —
 * сообщение висело бы «Sending…» без «Send now» и ×. Сжатие кончилось — сообщение уходит само.
 *
 * Сама очередь повторяет только `busy` (через `CHAT_RETRY_MS`) и `blocked` (не раньше чем через `CHAT_RETRY_MS` и когда
 * сессия выйдет из `blocked`). Это сознательное исключение из правила «никаких автоповторов» `terminal/send.ts`:
 * повторяется только то, что человек уже отправил. Пауза у `blocked` нужна и тогда, когда окно `blocked` не видит:
 * хост отказывает так и до первого хука сессии. Тостов у повторов нет — состояние видно на сером элементе; на
 * окончательных исходах тост прежний (`showSendToast`).
 */

import type { FeedItem } from '@parley/core';
import { KIMI_SHARED_TERMINAL_FEATURE, type SessionRef } from '@parley/protocol';
import { hostFeatures } from '../lib/capabilities.js';
import { createOutbox, type AttemptResult, type OutboxItem } from '../lib/outbox.js';
import { isCompletePointerText } from '../lib/participant.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useWorksStore } from '../store/works.js';
import { sendToAgent, showSendToast, type SendWithToastDeps } from '../terminal/send.js';
import { turnActive } from './feed-model.js';
import { useFeedStore } from './store.js';
import { useChatUiStore, type ChatPromptEcho } from './ui-store.js';

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

function promptMatches(receivedText: string, wanted: string): boolean {
  const received = receivedText.trim();
  if (received === wanted) return true;
  // Codex склеивает очередь Tab в один промпт. Убираем только служебные строки по краям:
  // совпадения с цитатой или частью другого сообщения недостаточно для подтверждения.
  const lines = received.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start]!.trim() === '' || isCompletePointerText(lines[start]!))) start += 1;
  while (end > start && (lines[end - 1]!.trim() === '' || isCompletePointerText(lines[end - 1]!))) end -= 1;
  return wanted !== '' && lines.slice(start, end).join('\n').trim() === wanted;
}

/** Сколько промптов с этим текстом уже в ленте — по нему затвор узнаёт новый промпт. */
export function promptCount(items: readonly FeedItem[], text: string): number {
  const wanted = text.trim();
  return items.filter((item) => item.kind === 'prompt' && promptMatches(item.text, wanted)).length;
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

/** Сжатие контекста сессии ждёт или идёт — то, о котором знает хост. */
function compacting(ref: SessionRef): boolean {
  const phase = activityFor(useActivityStore.getState().byRef, ref)?.metrics?.compaction;
  return phase === 'pending' || phase === 'running';
}

/** Ход у живой сессии идёт, сжатие ждёт или идёт, или она ещё ждёт промпт только что отправленного сообщения. */
function sessionBusy(key: string, ref: SessionRef): boolean {
  const entry = useWorksStore.getState().entries.find((e) => e.projectPath === ref.projectPath && e.map.work.id === ref.workId);
  if (entry?.map.sessions.find((session) => session.id === ref.sessionId)?.lifecycle !== 'active') return false;
  if (compacting(ref)) return true;
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

/** Привязать каждую новую запись только к одной попытке, начиная со старейшей. */
function confirmPrompts(key: string, items: readonly FeedItem[]): void {
  useChatUiStore.getState().updatePromptEchoes(key, (was) => {
    if (was.length === 0) return was;
    const indices = new Map(items.map((item, index) => [item.id, index]));
    const used = new Set(was.flatMap((entry) => entry.state === 'confirmed' ? [entry.promptId] : []));
    let changed = false;
    const next = was.flatMap<ChatPromptEcho>((entry) => {
      if (entry.state === 'confirmed') {
        if (indices.has(entry.promptId)) return [entry];
        changed = true;
        return [];
      }
      const after = entry.afterId === null ? undefined : indices.get(entry.afterId);
      const text = entry.text.trim();
      const prompt = items.find((item, index) =>
        item.kind === 'prompt' && !used.has(item.id) && promptMatches(item.text, text) &&
        (after === undefined ? Date.parse(item.at) >= entry.since : index > after),
      );
      if (prompt === undefined) return [entry];
      used.add(prompt.id);
      changed = true;
      return [{ id: entry.id, state: 'confirmed', promptId: prompt.id }];
    });
    return changed ? next : was;
  });
}

function forgetEcho(key: string, id: string, onlyUnconfirmed = false): void {
  useChatUiStore.getState().updatePromptEchoes(key, (was) => {
    const next = was.filter((entry) => entry.id !== id || (onlyUnconfirmed && entry.state === 'confirmed'));
    return next.length === was.length ? was : next;
  });
}

export async function attemptChatSend(key: string, item: OutboxItem<ChatOutboxPayload>): Promise<AttemptResult> {
  const { ref, text, deps, requestedAt } = item.payload;
  const feed = useFeedStore.getState().feeds[key];
  const before = feed?.items ?? NO_ITEMS;
  // Ход идёт — по тому же правилу, что в sessionBusy: замороженные элементы нечитаемой ленты не в счёт.
  const active = feed?.status === 'ready' ? turnActive(before) : workingNow(ref);
  const seen = promptCount(before, text);
  const last = before.at(-1);
  // Пока есть якорь, важен порядок строк. При переснимке без якоря сверяем время, не забирая старый промпт.
  const since = last !== undefined ? Date.parse(last.at) : feed?.status === 'ready' ? -Infinity : Date.now() - CHAT_AWAIT_PROMPT_MS;
  useChatUiStore.getState().updatePromptEchoes(key, (was) => [
    ...was, { id: item.id, state: 'sending', text, afterId: last?.id ?? null, since },
  ]);
  const outcome = await sendToAgent(deps.bridge, ref, text, true, requestedAt);
  deps.onOutcome?.(outcome);
  if (!('error' in outcome) && outcome.submitted) {
    if (!active && item.payload.now !== true) awaitPrompt(key, text, seen);
    useChatUiStore.getState().updatePromptEchoes(key, (was) =>
      was.map((entry) => entry.id === item.id && entry.state === 'sending' ? { ...entry, state: active ? 'queued' : 'submitted' } : entry),
    );
    // Локальные команды (например /clear) могут не оставить промпт вообще.
    if (/^\/[a-z][\w:-]*(?:\s|$)/i.test(text.trimStart())) {
      setTimeout(() => forgetEcho(key, item.id, true), CHAT_AWAIT_PROMPT_MS);
    }
    return { kind: 'sent' };
  }
  forgetEcho(key, item.id);
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
  ready: (key, item) => {
    const ref = item.payload.ref;
    const session = useWorksStore.getState().entries.find((entry) =>
      entry.projectPath === ref.projectPath && entry.map.work.id === ref.workId,
    )?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    const shared = session?.provider === 'kimi' && hostFeatures(useHostStore.getState().status).has(KIMI_SHARED_TERMINAL_FEATURE);
    return (session?.kimiTerminal === undefined || shared) && (item.payload.now === true || !sessionBusy(key, ref));
  },
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
useFeedStore.subscribe((state, previous) => {
  if (state.feeds === previous.feeds) return;
  for (const [key, feed] of Object.entries(state.feeds)) {
    if (feed.status === 'ready' && feed !== previous.feeds[key]) confirmPrompts(key, feed.items);
  }
  kickAll();
});
useWorksStore.subscribe(kickAll);
useActivityStore.subscribe(kickAll);
useHostStore.subscribe(({ status }, previous) => {
  if (hostFeatures(status).has(KIMI_SHARED_TERMINAL_FEATURE) !== hostFeatures(previous.status).has(KIMI_SHARED_TERMINAL_FEATURE)) kickAll();
});
