/**
 * Сервис канала Telegram (план B, задача 10): корень композиции. Сам почти ничего не решает — разбор апдейтов,
 * тексты, карточки, очередь и опрос живут в чистых модулях рядом, здесь они связаны с хостом (работы, активность,
 * лента, помощник, письма, настройки) и между собой.
 */

import path from 'node:path';
import {
  maskTelegramTokens,
  needReason,
  participantLabel,
  pendingCards,
  planRefOf,
  providerLabel,
  secretHint,
  TELEGRAM_TOKEN_RE,
  telegramBotId,
  telegramTokenFingerprint,
} from '@parley/core';
import { sessionNeed } from '@parley/core/attention';
import type {
  FeedCard,
  FeedCardState,
  FeedDecision,
  FeedItem,
  FeedText,
  ParleyConfig,
  ProviderEntry,
  SessionActivity,
  WorkEntry,
  WorkSession,
} from '@parley/core';
import { refKey } from '@parley/protocol';
import type { AssistantProposal, Params, Result, SessionRef, TelegramPolling, TelegramStatus } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { AssistantService } from '../assistant/assistant-service.js';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import type { FeedService } from '../feed/feed-service.js';
import type { WorksService } from '../works/works-service.js';
import { BotApiError, createBotApi } from './api.js';
import type { BotApi } from './api.js';
import { createAssistantBridge } from './assistant-bridge.js';
import type { AssistantBridge } from './assistant-bridge.js';
import { CALLBACK_CODES, parseCallback } from './callbacks.js';
import { assistantCardMessage, feedCardMessage, feedDecisionFor, receiptText, roomCardMessage } from './cards.js';
import { clipText, escapeHtml, lastLines } from './format.js';
import { classify } from './ingress.js';
import { createLinkCode, deepLink, LINK_ATTEMPTS, matchLinkCode } from './link.js';
import { activityTransition, emptyMemory, sessionWhere, worksTriggers } from './notify.js';
import { createOutbox } from './outbox.js';
import type { Outbox, Priority } from './outbox.js';
import { createPoller } from './poller.js';
import type { Poller } from './poller.js';
import { createTelegramState } from './state.js';
import { T } from './texts.js';
import type { ReceiptKind } from './texts.js';
import type { CardRecord, InlineKeyboard, TgUpdate } from './types.js';
import { createVoiceTranscriber } from './voice.js';

export interface TelegramServiceDeps {
  home: string;
  host: Pick<HostContext, 'broadcast' | 'hold' | 'log'>;
  works: Pick<WorksService, 'snapshot' | 'onChange'>;
  activity: Pick<ActivityService, 'get' | 'onChange'>;
  feed?: Pick<FeedService, 'snapshot' | 'decide' | 'subscribe' | 'unsubscribe'>;
  /**
   * Реестр провайдеров хоста (`loadProviders()`): имя провайдера в причине «needs you» (спека подписок К16). Нет —
   * или id не найден — имя строится по одному id.
   */
  providers?(): Promise<Record<string, Pick<ProviderEntry, 'id' | 'label'>>>;
  assistant: Pick<AssistantService, 'ask' | 'cancel' | 'reset' | 'decide' | 'onState' | 'settings' | 'state'>;
  /** `sendHumanLetter(input, { via: 'telegram' })`. */
  sendLetter(input: Params<'rooms.send'>): Promise<string>;
  resolveRoomProposal(input: Params<'rooms.resolveProposal'>): Promise<string>;
  /** `loadConfig().config`. */
  config(): Promise<ParleyConfig>;
  secret: { read(): Promise<string | null>; write(token: string): Promise<string>; clear(): Promise<void> };
  fetch?: typeof fetch;
  apiBase?: string;
  /** `whisper-cli` и модель VAD, что передаёт окно; `null` — голос не распознаётся. */
  engine: { bin: string; vadModel: string } | null;
  macName: string;
  now?(): number;
  log(line: string): void;
}

export interface TelegramService {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): TelegramStatus;
  setToken(token: string): Promise<{ botUsername: string; hint: string }>;
  clearToken(): Promise<void>;
  link(): Promise<{ code: string; expiresAt: string; deepLink: string }>;
  unlink(): Promise<void>;
  takeOver(): Promise<void>;
  configChanged(config: ParleyConfig): void;
  /** Напоминание сработало при выключенном помощнике: канал сообщает об этом человеку. */
  reminderWhileOff(reminder: { id: string; what: string }): void;
}

type FeedRecord = Extract<CardRecord, { kind: 'feed' }>;
type RoomRecord = Extract<CardRecord, { kind: 'room' }>;
type SendOptions = { keyboard?: InlineKeyboard | null; silent?: boolean; plain?: boolean };
type FeedSnapshot = Result<'feed.snapshot'>;

const WAIT_MS = 10 * 60_000;
const NOTICE_MERGE_MS = 3_000;
const NOTICE_MAX = 4_000;
/** Когда после перехода в «нужен ты» ещё раз смотреть ленту: хук ложится позже активности (как на острове). */
const SNAPSHOT_RETRY_MS = [500, 1_500, 4_000] as const;
const GETME_ATTEMPTS = 3;
const GETME_TIMEOUT_MS = 15_000;
const NOTE_MAX = 4_000;

const EMOJI: Partial<Record<ReceiptKind, string>> = {
  allowed: '✅',
  denied: '⛔',
  answered: '✅',
  accepted: '✅',
  returned: '↩️',
  revised: '🔄',
  sent: '✅',
  done: '✅',
  cancelled: '✖️',
};

const isParseError = (error: unknown): boolean => error instanceof BotApiError && error.status === 400 && /can't parse entities/i.test(error.description);
/** Тот же текст без тегов: запасной вариант, когда Telegram не разобрал HTML. */
const plainOf = (html: string): string =>
  html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const isFeedCard = (item: FeedItem): item is FeedCard => item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan';
const withoutWait = (record: FeedRecord): FeedRecord => {
  const { wait, ...rest } = record;
  void wait;
  return rest;
};

/** Склеивает короткие тексты в сообщения не длиннее `NOTICE_MAX`. */
function pack(parts: string[]): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current !== '' && current.length + part.length + 2 > NOTICE_MAX) {
      out.push(current);
      current = part;
    } else current = current === '' ? part : `${current}\n\n${part}`;
  }
  if (current !== '') out.push(current);
  return out;
}

export function createTelegramService(deps: TelegramServiceDeps): TelegramService {
  const now = deps.now ?? Date.now;
  const log = (line: string): void => deps.log(maskTelegramTokens(line));
  const state = createTelegramState({ home: deps.home, now, log });
  const iso = (): string => new Date(now()).toISOString();
  const clock = (): string => new Date(now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const line = (kind: ReceiptKind): string => `${EMOJI[kind] ?? ''} ${T.receipt(kind, clock())}`.trim();
  const stateLine = (value: FeedCardState): string => {
    if (value === 'allowed' || value === 'denied' || value === 'answered') return line(value);
    return value === 'elsewhere' ? T.answeredAtMac : T.expired;
  };

  let cfg: ParleyConfig | null = null;
  let token: string | null = null;
  let hint: string | null = null;
  let started = false;
  let api: BotApi | null = null;
  let outbox: Outbox | null = null;
  let poller: Poller | null = null;
  let voice: ReturnType<typeof createVoiceTranscriber> | null = null;
  let bridge: AssistantBridge | null = null;
  let polling: TelegramPolling = 'off';
  let lastError: string | null = null;
  let lastUpdateAt: string | null = null;
  let held = false;
  /** Растёт при каждом `begin()` и `disable()`: апдейты и смещение старого опроса игнорируются. */
  let generation = 0;
  let memory = emptyMemory();
  /** Карточки ленты, чьё сообщение ещё уходит: повторный повод не должен слать их второй раз. */
  const inflight = new Map<string, SessionRef>();
  /** Ключи карточек комнаты и помощника, чьё сообщение ещё уходит (`room:…`, `assistant:…`). */
  const sending = new Set<string>();
  /** Квитанция для карточки, решённой раньше, чем её сообщение ушло: `onSent` закрывает её сразу. Ключи как у `sending` и `feed:<cardId>`. */
  const closeEarly = new Map<string, string>();
  /** Карточки с несколькими вопросами, чей следующий вопрос ещё уходит: повторное нажатие не должно слать его снова. */
  const advancing = new Set<string>();
  /** Повторные обходы ленты пока сессия `blocked`, по `refKey`. */
  const watches = new Map<string, Array<ReturnType<typeof setTimeout>>>();
  let voiceTail: Promise<void> = Promise.resolve();
  /** HTML отправленных карточек: квитанция дописывается под ним. После перезапуска хоста — заголовок по записи. */
  const originals = new Map<string, string>();
  const subscribed = new Map<string, SessionRef>();
  const unsubs: Array<() => void> = [];
  let noticeBuffer: string[] = [];
  let noticeSilent = true;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  const owner = () => state.get().owner;
  const canSend = (): boolean => cfg?.telegramEnabled === true && token !== null && api !== null && owner() !== null && polling !== 'conflict';

  const status = (): TelegramStatus => {
    const current = state.get();
    const pending = current.pendingLink;
    return {
      enabled: cfg?.telegramEnabled ?? false,
      token: token === null ? 'none' : 'set',
      botUsername: current.botUsername,
      hint,
      owner: current.owner === null ? null : { username: current.owner.username, linkedAt: current.owner.linkedAt },
      pendingLink: pending !== null && Date.parse(pending.expiresAt) > now() ? { expiresAt: pending.expiresAt } : null,
      polling,
      error: lastError,
      lastUpdateAt,
    };
  };
  /** Рассылка только при изменении статуса: `settings.set` зовёт `configChanged` до ответа метода. */
  let lastBroadcast: string | null = null;
  const statusKey = (): string => JSON.stringify({ ...status(), lastUpdateAt: null });
  const changed = (): void => {
    const current = status();
    const key = statusKey();
    if (key === lastBroadcast) return;
    lastBroadcast = key;
    deps.host.broadcast('telegram.changed', current);
  };

  /** Хост не засыпает, пока канал слушает и у него есть владелец. */
  const syncHold = (): void => {
    const want = cfg?.telegramEnabled === true && token !== null && owner() !== null && poller?.running() === true;
    if (want === held) return;
    held = want;
    deps.host.hold('telegram', want);
  };

  const setPolling = (next: TelegramPolling, error: string | null): void => {
    if (next === polling && error === lastError) return;
    polling = next;
    lastError = error;
    if (next === 'conflict') outbox?.clear();
    syncHold();
    changed();
  };

  // ── Очередь исходящих ──────────────────────────────────────────────────────────────────────────

  const enqueue = (priority: Priority, run: (bot: BotApi) => Promise<void>, key?: string): void => {
    if (outbox === null) return;
    outbox.enqueue({
      priority,
      ...(key === undefined ? {} : { key }),
      run: async () => {
        if (api === null) return;
        await run(api);
      },
    });
  };

  async function post(bot: BotApi, chatId: number, text: string, options: SendOptions): Promise<number> {
    const base = {
      chat_id: chatId,
      ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
      ...(options.silent === true ? { disable_notification: true } : {}),
    };
    try {
      const sent = await bot.call<{ message_id: number }>('sendMessage', { ...base, text, ...(options.plain === true ? {} : { parse_mode: 'HTML' }) });
      return sent.message_id;
    } catch (error) {
      if (options.plain === true || !isParseError(error)) throw error;
      const sent = await bot.call<{ message_id: number }>('sendMessage', { ...base, text: plainOf(text) });
      return sent.message_id;
    }
  }

  /**
   * Сообщение владельцу. `onSent` зовётся с id отправленного сообщения (если владелец за это время не сменился),
   * `settled` — когда задание больше не ждёт: после отправки, при отбрасывании очереди и после неудачи.
   */
  const send = (
    priority: Priority,
    text: string,
    options: SendOptions = {},
    onSent?: (messageId: number, chatId: number) => void,
    settled?: () => void,
  ): void => {
    const chatId = owner()?.chatId;
    if (chatId === undefined || outbox === null) {
      settled?.();
      return;
    }
    outbox.enqueue({
      priority,
      run: async () => {
        if (api === null) return;
        const messageId = await post(api, chatId, text, options);
        if (owner()?.chatId === chatId) onSent?.(messageId, chatId);
        settled?.();
      },
      ...(settled === undefined ? {} : { onDrop: settled }),
    });
  };

  /** Правка карточки в квитанцию: текст, пустая клавиатура; не вышло — хотя бы снять кнопки. */
  const edit = (chatId: number, messageId: number, html: string): void => {
    enqueue('card', async (bot) => {
      const keyboard = { inline_keyboard: [] };
      const params = { chat_id: chatId, message_id: messageId, reply_markup: keyboard };
      const retryable = (error: unknown): boolean => !(error instanceof BotApiError) || error.status === 0 || error.status === 429;
      try {
        await bot.call('editMessageText', { ...params, text: html, parse_mode: 'HTML' });
        return;
      } catch (error) {
        if (error instanceof BotApiError && /message is not modified/i.test(error.description)) return;
        if (retryable(error)) throw error;
        if (isParseError(error)) {
          try {
            await bot.call('editMessageText', { ...params, text: plainOf(html) });
            return;
          } catch (second) {
            if (retryable(second)) throw second;
          }
        }
      }
      try {
        await bot.call('editMessageReplyMarkup', params);
      } catch (error) {
        if (retryable(error)) throw error;
      }
    });
  };

  /** Снимает кнопки, не трогая текст: сообщение, чью карточку мы уже не помним, может быть честной квитанцией. */
  const stripKeyboard = (chatId: number, messageId: number): void => {
    enqueue('card', async (bot) => {
      try {
        await bot.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      } catch (error) {
        if (!(error instanceof BotApiError) || error.status === 0 || error.status === 429) throw error;
      }
    });
  };

  /** Уведомления (не карточки) в пределах трёх секунд уходят одним сообщением. */
  const flushNotices = (): void => {
    noticeTimer = null;
    const parts = noticeBuffer;
    const silent = noticeSilent;
    noticeBuffer = [];
    noticeSilent = true;
    if (!canSend()) return;
    for (const chunk of pack(parts)) send('notice', chunk, { silent });
  };
  const notice = (html: string, silent: boolean): void => {
    noticeBuffer.push(html);
    noticeSilent = noticeSilent && silent;
    noticeTimer ??= setTimeout(flushNotices, NOTICE_MERGE_MS);
  };

  // ── Карточки: закрытие и подписка на ленту ─────────────────────────────────────────────────────

  const cardHeader = (record: CardRecord): string => {
    if (record.kind === 'feed') return `<b>${escapeHtml(record.sessionName)}</b>`;
    return record.kind === 'room' ? `<b>${escapeHtml(record.roomTitle)}</b>` : '';
  };
  const closedText = (shortId: string, record: CardRecord, text: string): string => {
    const base = originals.get(shortId) ?? cardHeader(record);
    return base === '' ? escapeHtml(text) : receiptText(base, escapeHtml(text));
  };

  const feedClient: Client = {
    id: 'telegram',
    name: 'telegram',
    features: new Set<string>(),
    send(message) {
      if ('event' in message && message.event === 'feed.changed') onFeedChanged(message.data as { ref: SessionRef; upsert: FeedItem[]; removed: string[]; decisions?: string | null });
      return true;
    },
    writableLength: () => 0,
    close: () => undefined,
  };

  const subscribe = (ref: SessionRef): void => {
    const key = refKey(ref);
    if (deps.feed === undefined || subscribed.has(key)) return;
    try {
      deps.feed.subscribe(ref, feedClient);
      subscribed.set(key, ref);
    } catch (error) {
      log(`telegram: feed subscribe failed: ${(error as Error).message}`);
    }
  };
  const release = (ref: SessionRef): void => {
    const key = refKey(ref);
    if (!subscribed.has(key)) return;
    if ([...inflight.values()].some((pending) => refKey(pending) === key)) return;
    if (state.cardsFor((card) => card.kind === 'feed' && refKey(card.ref) === key).length > 0) return;
    deps.feed?.unsubscribe(ref, feedClient);
    subscribed.delete(key);
  };
  const unsubscribeAll = (): void => {
    for (const ref of subscribed.values()) deps.feed?.unsubscribe(ref, feedClient);
    subscribed.clear();
  };

  /** Запись удаляется сразу, правка сообщения идёт через очередь: повторное закрытие ничего не делает. */
  function closeCard(shortId: string, text: string): void {
    const record = state.get().cards[shortId];
    if (record === undefined) return;
    const html = closedText(shortId, record, text);
    state.dropCard(shortId);
    originals.delete(shortId);
    edit(record.chatId, record.messageId, html);
    if (record.kind === 'feed') release(record.ref);
  }

  function onFeedChanged(data: { ref: SessionRef; upsert: FeedItem[]; removed: string[]; decisions?: string | null }): void {
    const key = refKey(data.ref);
    const open = state.cardsFor((card): boolean => card.kind === 'feed' && refKey(card.ref) === key) as Array<[string, FeedRecord]>;
    const fresh: FeedCard[] = [];
    for (const item of data.upsert) {
      if (!isFeedCard(item)) continue;
      if (item.state === 'pending') {
        fresh.push(item);
        continue;
      }
      for (const [shortId, record] of open) if (record.cardId === item.cardId) closeCard(shortId, stateLine(item.state));
      // Решение пришло, пока сообщение карточки ещё в очереди: закроем её, как только она уйдёт.
      if (inflight.has(item.cardId)) closeEarly.set(`feed:${item.cardId}`, stateLine(item.state));
    }
    for (const id of data.removed) {
      for (const [shortId, record] of open) if (record.cardId === id) closeCard(shortId, T.expired);
      if (inflight.has(id)) closeEarly.set(`feed:${id}`, T.expired);
    }
    // Новый запрос подписанной сессии (второй подряд, запоздавший хук) уходит и без повода от активности.
    if (fresh.length === 0 || cfg?.telegramNeedsYou !== true || !canSend() || !subscribed.has(key)) return;
    const known = new Set((state.cardsFor((card) => card.kind === 'feed') as Array<[string, FeedRecord]>).map(([, card]) => card.cardId));
    const found = sessionOf(data.ref);
    for (const card of fresh) {
      if (known.has(card.cardId) || inflight.has(card.cardId)) continue;
      sendFeedCard(data.ref, found?.session.label ?? data.ref.sessionId, whereOf(data.ref), card, data.decisions !== 'terminal');
    }
  }

  // ── Поиск в картах работ ────────────────────────────────────────────────────────────────────────

  const entryOf = (projectPath: string, workId: string): WorkEntry | undefined =>
    deps.works.snapshot().entries.find((entry) => entry.projectPath === projectPath && entry.map.work.id === workId);
  const sessionOf = (ref: SessionRef): { entry: WorkEntry; session: WorkSession } | null => {
    const entry = entryOf(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    return entry === undefined || session === undefined ? null : { entry, session };
  };
  const roomKey = (projectPath: string, workId: string, roomId: string, proposalId: string, rev: number): string =>
    `room:${projectPath}\u0000${workId}\u0000${roomId}\u0000${proposalId}\u0000${rev}`;
  const whereOf = (ref: SessionRef): string => {
    const found = sessionOf(ref);
    return found === null ? path.basename(ref.projectPath) : sessionWhere(found.entry);
  };

  /** Базовая линия поводов: что уже есть сейчас, о том бот не пишет. */
  function rebase(): void {
    cancelWatches();
    memory = emptyMemory();
    if (owner() === null) return;
    const snapshot = deps.works.snapshot();
    worksTriggers(memory, snapshot);
    for (const entry of snapshot.entries) {
      for (const session of entry.map.sessions) {
        const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
        activityTransition(memory, ref, session, deps.activity.get(ref)?.activity ?? null);
      }
    }
  }

  // ── Карточки ленты ──────────────────────────────────────────────────────────────────────────────

  async function findCard(record: FeedRecord): Promise<FeedCard | null> {
    if (deps.feed === undefined) return null;
    try {
      const snapshot = await deps.feed.snapshot(record.ref, undefined, 'attention');
      return pendingCards(snapshot.items).find((card) => card.cardId === record.cardId) ?? null;
    } catch (error) {
      log(`telegram: feed snapshot failed: ${(error as Error).message}`);
      return null;
    }
  }

  function sendFeedCard(ref: SessionRef, name: string, where: string, card: FeedCard, buttons: boolean): void {
    const shortId = state.newShortId();
    const message = feedCardMessage(card, { sessionName: name, where, projectPath: ref.projectPath, shortId, buttons }, 0);
    inflight.set(card.cardId, ref);
    subscribe(ref);
    send(
      'card',
      message.text,
      { keyboard: message.keyboard },
      (messageId, chatId) => {
        state.putCard(shortId, { kind: 'feed', ref, cardId: card.cardId, cardKind: card.kind, sessionName: name, chatId, messageId, at: iso(), question: 0 });
        originals.set(shortId, message.text);
        const early = closeEarly.get(`feed:${card.cardId}`);
        if (early !== undefined) closeCard(shortId, early);
      },
      () => {
        inflight.delete(card.cardId);
        closeEarly.delete(`feed:${card.cardId}`);
        release(ref);
      },
    );
  }

  const decisionReceipt = (decision: FeedDecision): ReceiptKind => {
    if (decision.kind === 'permission') return decision.behavior === 'deny' ? 'denied' : 'allowed';
    return decision.kind === 'plan' ? 'accepted' : 'answered';
  };

  /** Свежая запись карточки ленты: после каждого `await` прежняя могла быть закрыта событием ленты. */
  const freshFeed = (shortId: string): FeedRecord | null => {
    const record = state.get().cards[shortId];
    return record !== undefined && record.kind === 'feed' ? record : null;
  };

  /**
   * Применяет решение; у карточки с несколькими вопросами копит ответы и шлёт следующий вопрос новым сообщением.
   * Возвращает тост для нажатия: пусто — всё принято.
   */
  async function applyFeedDecision(shortId: string, record: FeedRecord, card: FeedCard, decision: FeedDecision, onApplied?: () => void): Promise<string> {
    if (deps.feed === undefined) return '';
    let final = decision;
    if (card.kind === 'question' && decision.kind === 'question') {
      const answers = { ...record.answers, ...decision.answers };
      const next = record.question + 1;
      if (next < card.questions.length) {
        const answered = card.questions[record.question]?.question ?? '';
        const [answer = ''] = Object.values(decision.answers);
        const message = feedCardMessage(card, { sessionName: record.sessionName, where: whereOf(record.ref), projectPath: record.ref.projectPath, shortId, buttons: true }, next);
        const base = originals.get(shortId) ?? cardHeader(record);
        edit(record.chatId, record.messageId, receiptText(base, escapeHtml(`✅ ${T.assistantAnswerLine(answered.split('\n')[0] ?? '', answer)}`)));
        advancing.add(shortId);
        send(
          'card',
          message.text,
          { keyboard: message.keyboard },
          (messageId) => {
            const fresh = freshFeed(shortId);
            if (fresh === null) return;
            state.putCard(shortId, { ...withoutWait(fresh), question: next, answers, messageId });
            originals.set(shortId, message.text);
          },
          () => advancing.delete(shortId),
        );
        state.audit({ kind: 'decision', shortId, cardId: record.cardId, result: `question ${record.question + 1} answered` });
        onApplied?.();
        return '';
      }
      final = { kind: 'question', answers };
    }
    let result: Result<'feed.decide'>;
    try {
      result = deps.feed.decide(record.ref, record.cardId, final);
    } catch (error) {
      if (error instanceof HostError && error.code === 'not_found') {
        closeCard(shortId, T.expired);
        return '';
      }
      throw error;
    }
    state.audit({ kind: 'decision', shortId, cardId: record.cardId, result: result.applied ? 'applied' : `not applied (${result.state})` });
    if (result.applied) {
      closeCard(shortId, line(decisionReceipt(final)));
      onApplied?.();
      return '';
    }
    // Хук ещё не удержан: карточка в окне жива, пусть нажмут позже. Любое решённое состояние — ответили у Mac.
    if (result.state === 'pending') return T.notReadyYet;
    closeCard(shortId, T.answeredAtMac);
    return '';
  }

  async function feedAction(shortId: string, record: FeedRecord, code: string): Promise<string> {
    if (advancing.has(shortId)) return '';
    const card = await findCard(record);
    const fresh = freshFeed(shortId);
    if (fresh === null || advancing.has(shortId)) return '';
    if (card === null) {
      closeCard(shortId, T.expired);
      return '';
    }
    const decision = feedDecisionFor(card, code, undefined, fresh.question);
    if (decision === null) return '';
    if (decision === 'other') {
      state.putCard(shortId, { ...fresh, wait: { kind: 'other', until: new Date(now() + WAIT_MS).toISOString() } });
      send('notice', T.otherPrompt, { plain: true });
      return '';
    }
    return applyFeedDecision(shortId, fresh, card, decision);
  }

  // ── Карточки комнаты ────────────────────────────────────────────────────────────────────────────

  function sendRoomCard(entry: WorkEntry, roomId: string): void {
    const room = entry.map.rooms.find((candidate) => candidate.id === roomId);
    const proposal = room?.proposal;
    if (room === undefined || proposal === null || proposal === undefined) return;
    const shortId = state.newShortId();
    const from = participantLabel(entry.map, proposal.from);
    const message = roomCardMessage({ roomTitle: room.title, where: sessionWhere(entry), proposal: { ...proposal, from }, shortId });
    const sendKey = roomKey(entry.projectPath, entry.map.work.id, room.id, proposal.id, proposal.rev);
    sending.add(sendKey);
    send('card', message.text, { keyboard: message.keyboard }, (messageId, chatId) => {
      state.putCard(shortId, {
        kind: 'room',
        projectPath: entry.projectPath,
        workId: entry.map.work.id,
        roomId: room.id,
        roomTitle: room.title,
        from,
        proposalId: proposal.id,
        rev: proposal.rev,
        ...(planRefOf(proposal) ?? {}),
        chatId,
        messageId,
        at: iso(),
      });
      originals.set(shortId, message.text);
      const early = closeEarly.get(sendKey);
      if (early !== undefined) closeCard(shortId, early);
    }, () => {
      sending.delete(sendKey);
      closeEarly.delete(sendKey);
    });
  }

  /** Возвращает `true`, когда решение применено (не `conflict` и не отказ). */
  async function resolveRoom(shortId: string, record: RoomRecord, action: 'accept' | 'return', note?: string): Promise<boolean> {
    try {
      await deps.resolveRoomProposal({
        projectPath: record.projectPath,
        workId: record.workId,
        roomId: record.roomId,
        proposalId: record.proposalId,
        action,
        ...(note === undefined ? {} : { note: note.slice(0, NOTE_MAX) }),
        rev: record.rev,
        ...(record.planId !== undefined && record.planRev !== undefined ? { planId: record.planId, planRev: record.planRev } : {}),
      });
    } catch (error) {
      if (error instanceof HostError && error.code === 'conflict') {
        state.audit({ kind: 'decision', shortId, result: 'revised' });
        closeCard(shortId, line('revised'));
        return false;
      }
      if (error instanceof HostError) {
        log(`telegram: room decision failed: ${error.message}`);
        closeCard(shortId, T.expired);
        return false;
      }
      throw error;
    }
    state.audit({ kind: 'decision', shortId, result: action });
    closeCard(shortId, line(action === 'accept' ? 'accepted' : 'returned'));
    return true;
  }

  async function roomAction(shortId: string, record: RoomRecord, code: string): Promise<void> {
    if (code === CALLBACK_CODES.accept) {
      await resolveRoom(shortId, record, 'accept');
      return;
    }
    if (code !== CALLBACK_CODES.returnNote) return;
    const fresh = state.get().cards[shortId];
    if (fresh === undefined || fresh.kind !== 'room') return;
    state.putCard(shortId, { ...fresh, wait: { kind: 'note', until: new Date(now() + WAIT_MS).toISOString() } });
    send('notice', T.returnNotePrompt(record.from), { plain: true });
  }

  // ── Поводы ──────────────────────────────────────────────────────────────────────────────────────

  const lastText = (items: readonly FeedItem[]): FeedText | undefined =>
    [...items].reverse().find((item): item is FeedText => item.kind === 'text');

  const cancelWatch = (key: string): void => {
    for (const timer of watches.get(key) ?? []) clearTimeout(timer);
    watches.delete(key);
  };
  const cancelWatches = (): void => {
    for (const key of [...watches.keys()]) cancelWatch(key);
  };

  /** Один обход ленты: новые ждущие карточки уходят в чат. `null` — ленты нет или снимок не вышел. */
  async function sendNewCards(ref: SessionRef, name: string, where: string): Promise<{ pending: number; last: FeedText | undefined } | null> {
    if (deps.feed === undefined) return null;
    let snapshot: FeedSnapshot;
    try {
      snapshot = await deps.feed.snapshot(ref, undefined, 'attention');
    } catch (error) {
      log(`telegram: feed snapshot failed: ${(error as Error).message}`);
      return null;
    }
    if (!canSend()) return null;
    const cards = pendingCards(snapshot.items);
    const known = new Set((state.cardsFor((card) => card.kind === 'feed') as Array<[string, FeedRecord]>).map(([, card]) => card.cardId));
    for (const card of cards) {
      if (known.has(card.cardId) || inflight.has(card.cardId)) continue;
      sendFeedCard(ref, name, where, card, snapshot.decisions !== 'terminal');
    }
    return { pending: cards.length, last: lastText(snapshot.items) };
  }

  /**
   * Сессия перешла в «нужен ты»: хук ложится позже активности, поэтому лента смотрится сразу и ещё раз через
   * `SNAPSHOT_RETRY_MS`. Уведомление без кнопок уходит, только если последний обход не нашёл ни одной карточки.
   */
  function watchBlocked(ref: SessionRef, entry: WorkEntry, session: WorkSession, triggered: SessionActivity | null): void {
    if (cfg?.telegramNeedsYou !== true) return;
    const key = refKey(ref);
    cancelWatch(key);
    const name = session.label;
    const where = sessionWhere(entry);
    /**
     * « — <причина>» у сессии с `need` (спека подписок К16): текст `needReason` ядра, как в окне и на острове. `need`
     * берётся на момент сообщения, а не перехода: хук и время сброса ложатся чуть позже активности. Без `need` — пусто.
     */
    const reason = async (): Promise<string> => {
      const need = sessionNeed(session, deps.activity.get(ref)?.activity ?? triggered);
      if (need === null) return '';
      const registry = await deps.providers?.().catch(() => undefined);
      return ` — ${needReason(need, new Date(now()), providerLabel(registry?.[session.provider] ?? { id: session.provider, label: '' }))}`;
    };
    const tell = async (last: FeedText | undefined): Promise<void> => {
      const why = await reason();
      // Пока читался реестр, человек мог ответить: «нужен ты» уже снят.
      if (!canSend() || memory.levels.get(key) !== 'blocked') return;
      const tail = last === undefined ? '' : `\n<pre>${escapeHtml(lastLines(last.text))}</pre>`;
      notice(`${escapeHtml(`${T.needsYou(name, where)}${why}`)}${tail}`, false);
    };
    const fail = (error: unknown): void => log(`telegram: needs-you failed: ${(error as Error).message}`);
    if (deps.feed === undefined) {
      void tell(undefined).catch(fail);
      return;
    }
    let found = false;
    let last: FeedText | undefined;
    const check = async (final: boolean): Promise<void> => {
      if (!canSend() || memory.levels.get(key) !== 'blocked') return;
      const result = await sendNewCards(ref, name, where);
      if (result !== null) {
        found ||= result.pending > 0;
        last = result.last ?? last;
      }
      if (final && !found && canSend() && memory.levels.get(key) === 'blocked') await tell(last);
    };
    watches.set(
      key,
      SNAPSHOT_RETRY_MS.map((delay, index) => setTimeout(() => void check(index === SNAPSHOT_RETRY_MS.length - 1).catch(fail), delay)),
    );
    void check(false).catch(fail);
  }

  function onActivity(ref: SessionRef, live: { activity: Parameters<typeof activityTransition>[3] }): void {
    if (!canSend()) return;
    const found = sessionOf(ref);
    if (found === null) return;
    const trigger = activityTransition(memory, ref, found.session, live.activity);
    const key = refKey(ref);
    if (trigger === 'needs-you') {
      watchBlocked(ref, found.entry, found.session, live.activity);
    } else if (memory.levels.get(key) === 'blocked') {
      // Сессия всё ещё ждёт: это может быть следующий запрос подряд или запоздавший хук.
      if (cfg?.telegramNeedsYou === true) {
        void sendNewCards(ref, found.session.label, sessionWhere(found.entry)).catch((error: unknown) => log(`telegram: needs-you failed: ${(error as Error).message}`));
      }
    } else {
      cancelWatch(key);
      if (trigger === 'unseen' && cfg?.telegramFinished === true) {
        notice(escapeHtml(T.finished(found.session.label, sessionWhere(found.entry))), true);
      }
    }
  }

  function onWorks(snapshot: Parameters<typeof worksTriggers>[1]): void {
    if (!canSend()) return;
    const triggers = worksTriggers(memory, snapshot);
    for (const { entry, roomId, previous, now: result } of triggers.closed) {
      const open = state.cardsFor(
        (card) => card.kind === 'room' && card.projectPath === entry.projectPath && card.workId === entry.map.work.id && card.roomId === roomId && card.proposalId === previous.id && card.rev === previous.rev,
      );
      const text = result === 'gone' ? T.expired : line(result);
      for (const [shortId] of open) closeCard(shortId, text);
      const sendKey = roomKey(entry.projectPath, entry.map.work.id, roomId, previous.id, previous.rev);
      if (sending.has(sendKey)) closeEarly.set(sendKey, text);
    }
    if (cfg?.telegramNeedsYou === true) for (const { entry, room } of triggers.decisions) sendRoomCard(entry, room.id);
    if (cfg?.telegramMail !== true) return;
    for (const { entry, message } of triggers.letters) {
      const from = participantLabel(entry.map, message.from);
      const roomTitle = message.roomId === null ? null : entry.map.rooms.find((room) => room.id === message.roomId)?.title;
      const where = roomTitle === undefined || roomTitle === null ? sessionWhere(entry) : `${roomTitle} · ${sessionWhere(entry)}`;
      send('card', `<b>${escapeHtml(T.letter(from, where))}</b>\n<pre>${escapeHtml(clipText(message.text))}</pre>`, {}, (messageId) => {
        state.putLetter(messageId, { projectPath: entry.projectPath, workId: entry.map.work.id, roomId: message.roomId, from: message.from, at: iso() });
      });
    }
  }

  // ── Карточки помощника ──────────────────────────────────────────────────────────────────────────

  function sendAssistantCard(proposal: AssistantProposal): void {
    if (!canSend()) return;
    const shortId = state.newShortId();
    const message = assistantCardMessage(proposal);
    const sendKey = `assistant:${proposal.id}`;
    sending.add(sendKey);
    send(
      'card',
      message.text,
      { keyboard: message.keyboard },
      (messageId, chatId) => {
        state.putCard(shortId, { kind: 'assistant', proposalId: proposal.id, chatId, messageId, at: iso() });
        originals.set(shortId, message.text);
        const early = closeEarly.get(sendKey);
        if (early !== undefined) closeCard(shortId, early);
      },
      () => {
        sending.delete(sendKey);
        closeEarly.delete(sendKey);
      },
    );
  }

  function closeAssistantCard(proposalId: string, receipt: 'sent' | 'done' | 'cancelled' | 'current'): void {
    const text = receipt === 'current' ? T.noLongerCurrent : line(receipt);
    for (const [shortId] of state.cardsFor((card) => card.kind === 'assistant' && card.proposalId === proposalId)) closeCard(shortId, text);
    if (sending.has(`assistant:${proposalId}`)) closeEarly.set(`assistant:${proposalId}`, text);
  }

  // ── Входящие ────────────────────────────────────────────────────────────────────────────────────

  const waitingCard = (): [string, FeedRecord | RoomRecord] | null => {
    const waiting = state.cardsFor((card) => card.kind !== 'assistant' && card.wait !== undefined && Date.parse(card.wait.until) > now()) as Array<[string, FeedRecord | RoomRecord]>;
    waiting.sort(([, a], [, b]) => Date.parse(b.wait?.until ?? '') - Date.parse(a.wait?.until ?? ''));
    return waiting[0] ?? null;
  };

  async function answerWaiting(shortId: string, record: FeedRecord | RoomRecord, text: string): Promise<void> {
    if (record.kind === 'room') {
      if (await resolveRoom(shortId, record, 'return', text)) send('notice', T.sentAsNote(record.from), { plain: true });
      return;
    }
    if (advancing.has(shortId)) return;
    const card = await findCard(record);
    const fresh = freshFeed(shortId);
    if (fresh === null) return;
    if (card === null) {
      closeCard(shortId, T.expired);
      return;
    }
    const decision = feedDecisionFor(card, CALLBACK_CODES.other, text, fresh.question);
    if (decision === null || decision === 'other') return;
    const toast = await applyFeedDecision(shortId, fresh, card, decision, () => send('notice', T.sentAsAnswer(fresh.sessionName), { plain: true }));
    if (toast !== '') send('notice', toast, { plain: true });
  }

  async function replyToLetter(chatId: number, messageId: number, replyTo: number, text: string): Promise<boolean> {
    const letter = state.letter(replyTo);
    if (letter === null) return false;
    await deps.sendLetter({ projectPath: letter.projectPath, workId: letter.workId, roomId: letter.roomId, to: [letter.from], text, kind: 'note' });
    state.audit({ kind: 'reply', text, result: 'sent' });
    try {
      await requireApi().call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji: '👍' }] });
    } catch {
      const entry = entryOf(letter.projectPath, letter.workId);
      send('notice', T.sentTo(entry === undefined ? letter.from : participantLabel(entry.map, letter.from)), { plain: true });
    }
    return true;
  }

  const requireApi = (): BotApi => {
    if (api === null) throw new Error('telegram: not polling');
    return api;
  };

  async function onText(text: string, messageId: number, replyTo: number | null): Promise<void> {
    const waiting = waitingCard();
    if (waiting !== null) return answerWaiting(waiting[0], waiting[1], text);
    const chatId = owner()?.chatId;
    if (chatId !== undefined && replyTo !== null && (await replyToLetter(chatId, messageId, replyTo, text))) return;
    state.audit({ kind: 'assistant', text, result: 'asked' });
    await bridge?.onText(text);
  }

  async function onVoice(fileId: string, duration: number, messageId: number): Promise<void> {
    const result = (await voice?.transcribe(fileId, duration)) ?? { error: 'off' as const };
    if (!canSend()) return;
    if ('error' in result) {
      state.audit({ kind: 'voice', result: result.error });
      const text = result.error === 'off' ? T.voiceOff : result.error === 'too-long' ? T.voiceTooLong : T.voiceFailed;
      send('notice', text, { plain: true });
      return;
    }
    state.audit({ kind: 'voice', text: result.text, result: 'heard' });
    send('notice', T.heard(result.text), { plain: true });
    await onText(result.text, messageId, null);
  }

  async function onCommand(name: 'status' | 'new' | 'help' | 'skip' | 'start'): Promise<void> {
    if (name === 'help' || name === 'start') {
      send('notice', T.help, { plain: true });
      return;
    }
    if (name === 'skip') {
      const waiting = waitingCard();
      if (waiting === null) return;
      const [shortId, record] = waiting;
      if (record.kind === 'room') {
        await resolveRoom(shortId, record, 'return');
        return;
      }
      state.putCard(shortId, withoutWait(record));
      send('notice', T.waitCancelled, { plain: true });
      return;
    }
    if (name === 'new') {
      // Карточка прежнего разговора больше ничего не решает.
      for (const [shortId] of state.cardsFor((card) => card.kind === 'assistant')) closeCard(shortId, T.noLongerCurrent);
    }
    await bridge?.onCommand(name);
  }

  async function onStart(inbound: { code: string | null; from: { id: number; username?: string }; chatId: number }): Promise<void> {
    const pending = state.get().pendingLink;
    if (pending === null || inbound.code === null) return;
    const result = matchLinkCode(pending, inbound.code, now());
    if (result === 'expired') {
      state.update({ pendingLink: null });
      changed();
      return;
    }
    if (result === 'mismatch') {
      const attempts = pending.attempts + 1;
      state.update({ pendingLink: attempts >= LINK_ATTEMPTS ? null : { ...pending, attempts } });
      if (attempts >= LINK_ATTEMPTS) changed();
      return;
    }
    state.update({
      owner: { userId: inbound.from.id, chatId: inbound.chatId, username: inbound.from.username ?? null, linkedAt: iso() },
      pendingLink: null,
    });
    rebase();
    syncHold();
    state.audit({ kind: 'link', result: 'linked' });
    await requireApi()
      .call('setMyCommands', { commands: T.commands })
      .catch((error: unknown) => log(`telegram: setMyCommands failed: ${(error as Error).message}`));
    send('notice', T.linked(deps.macName), { plain: true });
    changed();
  }

  async function onCallback(inbound: { id: string; data: string; messageId: number | null }): Promise<void> {
    const bot = requireApi();
    const parsed = parseCallback(inbound.data);
    const answer = (text?: string): Promise<unknown> =>
      bot.call('answerCallbackQuery', { callback_query_id: inbound.id, ...(text === undefined || text === '' ? {} : { text }) }).catch(() => undefined);
    const chatId = owner()?.chatId;
    const forget = (): string => {
      // Записи нет: текст сообщения мог быть честной квитанцией, поэтому снимаем только кнопки.
      if (chatId !== undefined && inbound.messageId !== null) stripKeyboard(chatId, inbound.messageId);
      return T.noLongerCurrent;
    };
    if (parsed?.family === 'pa1') {
      const recorded = state
        .cardsFor((card) => card.kind === 'assistant' && card.proposalId === parsed.proposalId && card.messageId === inbound.messageId)
        .length;
      const toast = recorded === 0 ? forget() : await bridge?.onCallback(parsed.proposalId, parsed.code);
      state.audit({ kind: 'assistant', text: parsed.code, result: toast === undefined || toast === '' ? 'applied' : 'not applied' });
      await answer(toast);
      return;
    }
    let toast = '';
    try {
      const record = parsed === null ? undefined : state.get().cards[parsed.shortId];
      if (parsed === null || record === undefined || record.kind === 'assistant') toast = forget();
      else if (record.kind === 'feed') toast = await feedAction(parsed.shortId, record, parsed.code);
      else await roomAction(parsed.shortId, record, parsed.code);
    } finally {
      await answer(toast);
    }
  }

  const detached = (task: () => Promise<void>): void => {
    voiceTail = voiceTail.then(task).catch((error: unknown) => {
      if (error instanceof HostError && canSend()) send('notice', T.couldNot(maskTelegramTokens(error.message)), { plain: true });
      else log(`telegram: voice failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  async function onUpdate(update: TgUpdate): Promise<void> {
    const current = state.get();
    const inbound = classify(update, current.owner, current.pendingLink);
    if (inbound.kind === 'ignored') return;
    if (inbound.kind === 'foreign-callback') {
      await requireApi()
        .call('answerCallbackQuery', { callback_query_id: inbound.id })
        .catch(() => undefined);
      return;
    }
    lastUpdateAt = iso();
    try {
      switch (inbound.kind) {
        case 'start':
          return await onStart(inbound);
        case 'command':
          return await onCommand(inbound.name);
        case 'text':
          // Текст идёт по той же очереди, что и голосовые: порядок сообщений владельца сохраняется.
          detached(() => onText(inbound.text, inbound.messageId, inbound.replyTo));
          return;
        case 'voice':
          // Расшифровка долгая: опрос не ждёт её, нажатия кнопок обрабатываются сразу; голосовые и тексты идут по очереди.
          detached(() => onVoice(inbound.fileId, inbound.duration, inbound.messageId));
          return;
        case 'callback':
          return await onCallback(inbound);
      }
    } catch (error) {
      if (!(error instanceof HostError)) throw error;
      log(`telegram: update failed: ${error.message}`);
      send('notice', T.couldNot(maskTelegramTokens(error.message)), { plain: true });
    }
  }

  // ── Жизненный цикл ──────────────────────────────────────────────────────────────────────────────

  /** Выключает опрос, очередь и подписки на ленту; записи в state.json остаются. */
  function disable(): void {
    generation += 1;
    cancelWatches();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeBuffer = [];
    noticeSilent = true;
    poller?.stop();
    poller = null;
    outbox?.clear();
    outbox = null;
    api = null;
    voice = null;
    inflight.clear();
    unsubscribeAll();
    setPolling('off', null);
    syncHold();
  }

  /** Карточки прошлого запуска закрываются квитанцией: решить их из бота уже нельзя. */
  function closeStaleCards(text: string): void {
    state.pruneCards();
    for (const [shortId, record] of state.cardsFor(() => true)) {
      const html = closedText(shortId, record, text);
      state.dropCard(shortId);
      edit(record.chatId, record.messageId, html);
    }
  }

  /** `staleText` — квитанция для карточек, оставшихся от прошлого запуска: хост перезапущен или канал включили заново. */
  function begin(staleText: string): void {
    if (cfg?.telegramEnabled !== true || token === null) return;
    const mine = (generation += 1);
    const bot = createBotApi({
      token,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.apiBase === undefined ? {} : { baseUrl: deps.apiBase }),
    });
    api = bot;
    outbox = createOutbox({ log });
    voice = createVoiceTranscriber({
      api: bot,
      tmpDir: path.join(deps.home, 'telegram', 'tmp'),
      engine: deps.engine,
      language: () => deps.assistant.settings()?.language ?? 'en',
      model: () => deps.assistant.settings()?.voiceModel ?? null,
      log,
    });
    rebase();
    if (owner() !== null) closeStaleCards(staleText);
    poller = createPoller({
      api: bot,
      offset: () => state.get().offset,
      setOffset: (next) => {
        if (mine === generation) state.update({ offset: next });
      },
      seen: (updateId) => state.seen(updateId),
      onUpdate: async (update) => {
        if (mine === generation) await onUpdate(update);
      },
      onStatus: (next, error) => setPolling(next, error === null ? null : maskTelegramTokens(error)),
      log,
    });
    poller.start({ skipBacklog: true });
    syncHold();
  }

  async function getMe(bot: BotApi): Promise<{ username: string }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const me = await bot.call<{ username?: string }>('getMe', {}, { timeoutMs: GETME_TIMEOUT_MS });
        return { username: me.username ?? '' };
      } catch (error) {
        if (error instanceof BotApiError && (error.status === 401 || error.status === 404)) throw new HostError('bad_request', 'Telegram rejected the token');
        if (error instanceof BotApiError && error.status === 0 && attempt < GETME_ATTEMPTS) continue;
        throw new HostError('internal', maskTelegramTokens(`Could not reach Telegram: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      cfg = await deps.config();
      token = await deps.secret.read();
      if (token !== null) {
        hint = secretHint(token);
        state.applyToken(telegramBotId(token), telegramTokenFingerprint(token));
      }
      bridge = createAssistantBridge({
        assistant: deps.assistant,
        sendText: async (text) => {
          if (canSend()) send('notice', text, { plain: true });
        },
        sendCard: async (proposal) => sendAssistantCard(proposal),
        closeCard: async (proposalId, receipt) => closeAssistantCard(proposalId, receipt),
        typing: () => {
          const chatId = owner()?.chatId;
          if (chatId === undefined || !canSend()) return;
          enqueue(
            'typing',
            async (bot) => {
              await bot.call('sendChatAction', { chat_id: chatId, action: 'typing' });
            },
            'typing',
          );
        },
        cardsToggle: () => cfg?.telegramCards === true,
        log,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      unsubs.push(
        deps.works.onChange((snapshot) => onWorks(snapshot)),
        deps.activity.onChange((ref, live) => onActivity(ref, live)),
      );
      begin(T.restarted);
      // База для `changed()`: окно уже знает это состояние из `telegram.status`, повторять его событием незачем.
      lastBroadcast = statusKey();
    },

    async stop() {
      disable();
      bridge?.stop();
      bridge = null;
      for (const unsubscribe of unsubs.splice(0)) unsubscribe();
      started = false;
    },

    status,

    async setToken(raw) {
      const candidate = raw.trim();
      if (!TELEGRAM_TOKEN_RE.test(candidate)) throw new HostError('bad_request', 'Token looks wrong');
      const me = await getMe(
        createBotApi({
          token: candidate,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.apiBase === undefined ? {} : { baseUrl: deps.apiBase }),
        }),
      );
      const savedHint = await deps.secret.write(candidate);
      const kind = state.applyToken(telegramBotId(candidate), telegramTokenFingerprint(candidate));
      state.update({ botUsername: me.username });
      hint = savedHint;
      if (kind === 'same' && token === candidate && (poller?.running() === true || cfg?.telegramEnabled !== true)) {
        // Тот же токен: опрос и открытые карточки не трогаем, обновляем только имя бота и подсказку.
        changed();
        return { botUsername: me.username, hint: savedHint };
      }
      disable();
      token = candidate;
      begin(T.noLongerCurrent);
      changed();
      return { botUsername: me.username, hint: savedHint };
    },

    async clearToken() {
      disable();
      await deps.secret.clear();
      token = null;
      hint = null;
      state.remove();
      changed();
    },

    async link() {
      if (token === null) throw new HostError('conflict', 'Set the bot token first');
      if (owner() !== null) throw new HostError('conflict', 'Unlink first');
      const { code, pending } = createLinkCode(now());
      state.update({ pendingLink: pending });
      changed();
      return { code, expiresAt: pending.expiresAt, deepLink: deepLink(state.get().botUsername ?? '', code) };
    },

    async unlink() {
      const chatId = owner()?.chatId;
      // Всё, что ещё стоит в очереди, к прежнему владельцу уже не уходит; правки и «Unlinked» ставятся после очистки.
      const receipts = state.cardsFor(() => true).map(([shortId, record]) => ({ shortId, record, html: closedText(shortId, record, line('unlinked')) }));
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = null;
      noticeBuffer = [];
      noticeSilent = true;
      outbox?.clear();
      unsubscribeAll();
      inflight.clear();
      originals.clear();
      for (const { shortId, record, html } of receipts) {
        state.dropCard(shortId);
        edit(record.chatId, record.messageId, html);
      }
      if (chatId !== undefined) send('notice', T.unlinked, { plain: true });
      state.clearLetters();
      state.update({ owner: null, pendingLink: null });
      memory = emptyMemory();
      state.audit({ kind: 'unlink', result: 'unlinked' });
      syncHold();
      changed();
    },

    async takeOver() {
      if (cfg?.telegramEnabled !== true || token === null) throw new HostError('conflict', 'Telegram is not active');
      rebase();
      if (poller === null) begin(T.noLongerCurrent);
      else poller.start({ skipBacklog: true });
      syncHold();
    },

    configChanged(config) {
      const was = cfg?.telegramEnabled === true;
      cfg = config;
      if (!started) return;
      if (!config.telegramEnabled) {
        if (was || poller !== null) disable();
      } else if (!was || poller === null) begin(T.noLongerCurrent);
      changed();
    },

    reminderWhileOff(reminder) {
      if (canSend()) send('notice', T.reminderOff(reminder.id, reminder.what), { plain: true });
    },
  };
}
