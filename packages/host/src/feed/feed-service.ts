/**
 * Служба ленты вида «Chat» (план 2026-10-01, Task 2, п. 3; решения 2, 5, 14): на каждую сессию —
 * состояние чистого редьюсера core, кольцо элементов, `revision` и пачка дельт для подписчиков.
 *
 * Источники: приёмник хуков (`onHook`), решения окна (`decide`), активность хоста (`idle` снимает
 * карточки), выход процесса агента (`pty.exit`: карточки `stale`, ход закрыт) и выключение хоста.
 * Ответ хуку `allow`/`deny` рождается только в `decide` — из решения, которое прислало окно
 * (Review Focus 5); всё остальное хост отвечает пустым `{}`.
 *
 * Кольцо держит не больше `maxItems` элементов и `maxBytes` их JSON (решение контролёра Г): строка
 * протокола не длиннее 8 МиБ, а снимок едет одной строкой. Дельты копятся пачкой не дольше
 * `batchMs` (решение Д): в пачке каждый элемент — один раз, в последней версии.
 */

import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  applyDecision,
  applyHookEvent,
  claudeProjectRoots,
  closeFeedTurn,
  emptyFeedState,
  feedFromTranscript,
  forEachJsonlRecord,
  settleCards,
} from '@parley/core';
import type {
  FeedCard,
  FeedCardState,
  FeedDecision,
  FeedItem,
  FeedState,
  FeedUpdate,
  RawRecord,
} from '@parley/core';
import { FEED_SCHEMA_VERSION, refKey } from '@parley/protocol';
import type { Result, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { Client } from '../client.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { EMPTY_HOOK_RESPONSE, hookDecisionResponse } from '../hooks/decisions.js';
import type { HookRequest } from '../hooks/hook-server.js';
import { createPendingHooks, PENDING_TIMEOUT_MS } from '../hooks/pending.js';
import type { PendingHooks } from '../hooks/pending.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';

/** Сколько элементов лента сессии держит (решение 2). */
export const FEED_MAX_ITEMS = 2_000;
/** Сколько байт JSON элементов лента сессии держит: снимок — половина предела строки протокола. */
export const FEED_MAX_BYTES = 4 * 1024 * 1024;
/** Не чаще одной дельты `feed.changed` на сессию за этот срок. */
export const FEED_BATCH_MS = 50;
/**
 * Сколько последних записей журнала читается при севе: на кольцо хватает с запасом (запись даёт не
 * больше пары элементов), а память не растёт с файлом — журналы долгих сессий весят десятки мегабайт.
 */
export const SEED_RECORD_WINDOW = 10_000;

const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';
/** id субагента — как у `meta.json` (0.2.0): ничего похожего на путь до файловой системы не доходит. */
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface FeedServiceDeps {
  host: Pick<HostContext, 'log'>;
  works: Pick<WorksService, 'entry' | 'onChange'>;
  activity: Pick<ActivityService, 'onChange' | 'logFile'>;
  pty: Pick<PtyManager, 'on'>;
}

export interface FeedServiceOptions {
  maxItems?: number;
  maxBytes?: number;
  batchMs?: number;
  /** Сколько хост держит хук без решения; дальше — `{}` и `stale`. */
  pendingTimeoutMs?: number;
  now?: () => number;
  /** Корни истории Claude Code, внутри которых читаются журналы; по умолчанию — `claudeProjectRoots()`. */
  roots?: () => readonly string[];
  /** Чтение записей журнала; тесты подставляют счётчик. */
  readRecords?: (file: string) => Promise<RawRecord[]>;
}

export type FeedSnapshot = Result<'feed.snapshot'>;

export interface FeedService {
  /** Событие хука от приёмника: ответ — сразу или после решения человека. */
  onHook(request: HookRequest): void;
  /** Снимок ленты сессии или, с `agentId`, ленты субагента из его журнала. */
  snapshot(ref: SessionRef, agentId?: string): Promise<FeedSnapshot>;
  subscribe(ref: SessionRef, client: Client): void;
  unsubscribe(ref: SessionRef, client: Client): void;
  /** Клиент отключился от хоста: все его подписки сняты. */
  dropClient(client: Client): void;
  decide(ref: SessionRef, cardId: string, decision: FeedDecision): Result<'feed.decide'>;
  /** Выключение хоста: всем удержанным хукам `{}`, таймеры сняты. */
  stop(): Promise<void>;
}

interface Batch {
  upsert: Map<string, FeedItem>;
  removed: Set<string>;
}

interface SessionFeed {
  ref: SessionRef;
  state: FeedState;
  revision: number;
  /** Байты JSON каждого элемента кольца и их сумма. */
  sizes: Map<string, number>;
  bytes: number;
  batch: Batch;
  timer: NodeJS.Timeout | undefined;
  /** Были живые события хуков: из журнала такую ленту не сеют. */
  live: boolean;
  /** Сев из журнала уже был (удачный или нет) — второй раз не сеем. */
  seeded: boolean;
  seeding: Promise<void> | undefined;
  /** Последний `transcript_path` из хуков: запасной путь к журналам субагентов. */
  transcriptPath: string | null;
}

const isCard = (item: FeedItem): item is FeedCard =>
  item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan';

const isPendingCard = (item: FeedItem): item is FeedCard =>
  isCard(item) && item.state === 'pending';

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const itemBytes = (item: FeedItem): number => Buffer.byteLength(JSON.stringify(item), 'utf8');

/** Путь строго внутри одного из корней — тот же приём, что у `meta.json` субагента (0.2.0). */
function insideRoots(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

/** Последние `window` записей файла по порядку: кольцевой буфер, файл целиком в память не ложится. */
export async function readRecordsTail(
  file: string,
  window: number = SEED_RECORD_WINDOW,
): Promise<RawRecord[]> {
  const ring: RawRecord[] = [];
  let next = 0;
  let count = 0;
  await forEachJsonlRecord(file, (record) => {
    ring[next] = record;
    next = (next + 1) % window;
    count += 1;
  });
  return count < window ? ring : [...ring.slice(next), ...ring.slice(0, next)];
}

/** Хвост списка, чей JSON не больше `maxBytes`. */
function tailByBytes(items: readonly FeedItem[], maxBytes: number): FeedItem[] {
  let bytes = 0;
  let start = items.length;
  while (start > 0) {
    const size = itemBytes(items[start - 1] as FeedItem);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return items.slice(start);
}

export function createFeedService(
  deps: FeedServiceDeps,
  options: FeedServiceOptions = {},
): FeedService {
  const { log } = deps.host;
  const maxItems = options.maxItems ?? FEED_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
  const batchMs = options.batchMs ?? FEED_BATCH_MS;
  const now = options.now ?? Date.now;
  const roots = options.roots ?? (() => claudeProjectRoots());
  const readRecords = options.readRecords ?? readRecordsTail;

  const feeds = new Map<string, SessionFeed>();
  const subscribers = new Map<string, Set<Client>>();
  const lastActivity = new Map<string, string>();
  let stopped = false;

  const pending: PendingHooks = createPendingHooks({
    timeoutMs: options.pendingTimeoutMs ?? PENDING_TIMEOUT_MS,
    // Хук ждал дольше предела и получил `{}`: отвечать теперь в терминале.
    onTimeout: (ref, cardId) => settle(ref, 'stale', [cardId]),
  });

  const at = (): string => new Date(now()).toISOString();

  function feedOf(ref: SessionRef): SessionFeed {
    const key = refKey(ref);
    let feed = feeds.get(key);
    if (feed === undefined) {
      feed = {
        ref: { ...ref },
        state: emptyFeedState(),
        revision: 0,
        sizes: new Map(),
        bytes: 0,
        batch: { upsert: new Map(), removed: new Set() },
        timer: undefined,
        live: false,
        seeded: false,
        seeding: undefined,
        transcriptPath: null,
      };
      feeds.set(key, feed);
    }
    return feed;
  }

  /**
   * Кольцо: старые элементы уходят, пока лента длиннее `maxItems` или тяжелее `maxBytes`. Самый новый
   * остаётся всегда — лента не пустеет, даже если он один тяжелее предела.
   */
  function trim(feed: SessionFeed, track: boolean): void {
    const items = feed.state.items;
    let drop = 0;
    const evicted: string[] = [];
    while (drop < items.length - 1 && (items.length - drop > maxItems || feed.bytes > maxBytes)) {
      const item = items[drop] as FeedItem;
      feed.bytes -= feed.sizes.get(item.id) ?? 0;
      feed.sizes.delete(item.id);
      if (track) {
        feed.batch.upsert.delete(item.id);
        feed.batch.removed.add(item.id);
      }
      if (isPendingCard(item)) evicted.push(item.cardId);
      drop += 1;
    }
    if (drop === 0) return;
    feed.state = { ...feed.state, items: items.slice(drop) };
    // Ждущая карточка ушла из ленты — решить её окну уже нечем: хуку `{}`, диалог остаётся в терминале.
    if (evicted.length > 0) pending.settle(feed.ref, evicted);
  }

  function commit(feed: SessionFeed, update: FeedUpdate): void {
    feed.state = update.state;
    for (const item of update.changes) {
      const size = itemBytes(item);
      feed.bytes += size - (feed.sizes.get(item.id) ?? 0);
      feed.sizes.set(item.id, size);
      feed.batch.upsert.set(item.id, item);
      feed.batch.removed.delete(item.id);
    }
    trim(feed, true);
    if (feed.timer === undefined && (feed.batch.upsert.size > 0 || feed.batch.removed.size > 0)) {
      feed.timer = setTimeout(() => flush(feed), batchMs);
    }
    // Карточки, которые шаг снял (PostToolUse, Stop, новый промпт, SessionEnd), — их хукам `{}`.
    const settled = update.changes.filter((item) => isCard(item) && item.state !== 'pending');
    if (settled.length > 0) {
      pending.settle(
        feed.ref,
        settled.map((card) => card.id),
      );
    }
  }

  /** Отправляет накопленную пачку подписчикам; `revision` растёт на 1 с каждой пачкой. */
  function flush(feed: SessionFeed): void {
    if (feed.timer !== undefined) {
      clearTimeout(feed.timer);
      feed.timer = undefined;
    }
    const { upsert, removed } = feed.batch;
    if (upsert.size === 0 && removed.size === 0) return;
    feed.batch = { upsert: new Map(), removed: new Set() };
    feed.revision += 1;
    const clients = subscribers.get(refKey(feed.ref));
    if (clients === undefined || clients.size === 0) return;
    const data = {
      ref: feed.ref,
      revision: feed.revision,
      upsert: Array.from(upsert.values()),
      removed: Array.from(removed),
    };
    for (const client of Array.from(clients)) {
      // Клиент не успевает читать — подписка снимается, как у `pty.output`: окно возьмёт снимок заново.
      if (!client.send({ event: 'feed.changed', data })) clients.delete(client);
    }
  }

  /** Снимает ждущие карточки сессии без решения: в ленте — `outcome`, хукам — `{}`. */
  function settle(
    ref: SessionRef,
    outcome: 'elsewhere' | 'stale',
    cardIds?: readonly string[],
  ): void {
    const feed = feeds.get(refKey(ref));
    if (feed === undefined) {
      pending.settle(ref, cardIds);
      return;
    }
    commit(feed, settleCards(feed.state, outcome, at(), cardIds));
    pending.settle(ref, cardIds);
  }

  /** Карточка, ради которой хук держится до решения человека (решение контролёра Б). */
  function heldCard(
    feed: SessionFeed,
    body: Record<string, unknown>,
    changes: readonly FeedItem[],
  ): FeedCard | undefined {
    const event = body['hook_event_name'];
    const tool = textOf(body['tool_name']);
    if (event === 'PermissionRequest') {
      // Одобрение плана: карточку `plan` завёл `PreToolUse(ExitPlanMode)`, а `PermissionRequest` новой
      // не делает — держим его за последнюю ждущую карточку плана.
      if (tool === PLAN_TOOL) {
        const plan = [...feed.state.items]
          .reverse()
          .find(
            (item): item is FeedCard =>
              isPendingCard(item) && item.kind === 'plan' && item.toolName === tool,
          );
        if (plan !== undefined) return plan;
      }
      return changes.find(
        (item): item is FeedCard => isPendingCard(item) && item.kind === 'permission',
      );
    }
    if (event === 'PreToolUse' && tool === QUESTION_TOOL && body['agent_id'] === undefined) {
      const id = `question:${textOf(body['tool_use_id']) ?? ''}`;
      return changes.find((item): item is FeedCard => isPendingCard(item) && item.id === id);
    }
    return undefined;
  }

  function onHook(request: HookRequest): void {
    if (stopped) {
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    const { ref, body } = request;
    const feed = feedOf(ref);
    feed.live = true;
    const transcript = textOf(body['transcript_path']);
    if (transcript !== null) feed.transcriptPath = transcript;

    const update = applyHookEvent(feed.state, body, at());
    commit(feed, update);

    const card = heldCard(feed, body, update.changes);
    if (card === undefined) {
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    const cardId = card.cardId;
    pending.hold({
      ref: feed.ref,
      cardId,
      hookEvent: body['hook_event_name'] === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest',
      rawToolInput: recordOf(body['tool_input']),
      kind: card.kind,
      respond: request.respond,
    });
    // CLI закрыл запрос сам (ответили в терминале, процесс вышел): решать в окне больше нечего.
    request.onAbandon(() => {
      if (pending.drop(feed.ref, cardId)) settle(feed.ref, 'elsewhere', [cardId]);
    });
  }

  /** Сев из журнала сессии: один раз и только пока живых событий не было (решение 2). */
  function seed(feed: SessionFeed, provider: string): Promise<void> {
    feed.seeding ??= (async () => {
      try {
        const file = provider === 'claude' ? deps.activity.logFile(feed.ref) : null;
        const records = file === null ? null : await readTranscript(file);
        if (records === null || feed.live || stopped) return;
        const state = feedFromTranscript(records, { limit: maxItems });
        feed.state = state;
        feed.sizes = new Map();
        feed.bytes = 0;
        for (const item of state.items) {
          const size = itemBytes(item);
          feed.sizes.set(item.id, size);
          feed.bytes += size;
        }
        trim(feed, false);
      } catch (error) {
        log.warn('лента: журнал сессии не прочитан', {
          sessionId: feed.ref.sessionId,
          error: String(error),
        });
      } finally {
        feed.seeded = true;
        feed.seeding = undefined;
      }
    })();
    return feed.seeding;
  }

  /**
   * Записи журнала; `null` — читать нельзя или нечего: путь не абсолютный или вне корней истории
   * Claude Code, файла нет или это не обычный файл (ссылка, FIFO). Проверки — до открытия файла.
   */
  async function readTranscript(file: string): Promise<RawRecord[] | null> {
    if (!path.isAbsolute(file) || !insideRoots(file, roots())) return null;
    try {
      const info = await lstat(file);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    return readRecords(file);
  }

  function sessionOf(ref: SessionRef): { provider: string } {
    const session = deps.works
      .entry(ref.projectPath, ref.workId)
      ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) throw new HostError('not_found', `no session ${ref.sessionId}`);
    return session;
  }

  async function agentSnapshot(ref: SessionRef, agentId: string): Promise<FeedSnapshot> {
    const notFound = (): HostError =>
      new HostError('not_found', `no transcript for agent ${agentId}`);
    if (!SAFE_AGENT_ID.test(agentId)) throw notFound();
    const base = deps.activity.logFile(ref) ?? feeds.get(refKey(ref))?.transcriptPath ?? null;
    if (base === null) throw notFound();
    const file = path.join(base.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
    const records = await readTranscript(file);
    if (records === null) throw notFound();
    const items = feedFromTranscript(records, { limit: maxItems }).items;
    return { items: tailByBytes(items, maxBytes), revision: 0, schemaVersion: FEED_SCHEMA_VERSION };
  }

  const unsubscribeActivity = deps.activity.onChange((ref, value) => {
    const key = refKey(ref);
    const activity = value.activity.activity;
    const previous = lastActivity.get(key);
    lastActivity.set(key, activity);
    if (stopped || activity !== 'idle' || previous === 'idle') return;
    const feed = feeds.get(key);
    if (feed === undefined) return;
    // Решение 5: агент у приглашения — карточки ответили в терминале (Esc и прерывание не дают `Stop`).
    // Удержанный `PreToolUse` вопроса не снимаем: пока он висит, CLI ждёт ответа хука и у приглашения
    // быть не может, а журнал событий его не видит и по тишине считает ход оконченным.
    const ids = feed.state.items
      .filter(isPendingCard)
      .filter((card) => pending.get(feed.ref, card.cardId)?.hookEvent !== 'PreToolUse')
      .map((card) => card.cardId);
    if (ids.length > 0) settle(feed.ref, 'elsewhere', ids);
  });

  /** Сессии больше нет в работах: её лента, подписчики и удержанные хуки никому не нужны. */
  function forget(key: string): void {
    const feed = feeds.get(key);
    if (feed !== undefined) {
      if (feed.timer !== undefined) clearTimeout(feed.timer);
      feed.timer = undefined;
      pending.settle(feed.ref);
      feeds.delete(key);
    }
    lastActivity.delete(key);
    subscribers.delete(key);
  }

  const unsubscribeWorks = deps.works.onChange((snapshot) => {
    if (stopped) return;
    const alive = new Set<string>();
    for (const entry of snapshot.entries) {
      for (const session of entry.map.sessions) {
        alive.add(
          refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }),
        );
      }
    }
    for (const key of [...feeds.keys(), ...subscribers.keys(), ...lastActivity.keys()]) {
      if (!alive.has(key)) forget(key);
    }
  });

  const unsubscribeExit = deps.pty.on('exit', (ref) => {
    if (stopped) return;
    const feed = feeds.get(refKey(ref));
    if (feed === undefined) {
      pending.settle(ref);
      return;
    }
    // Процесс вышел: висящим хукам `{}`, карточки — `stale` (терминал ответит уже новому процессу),
    // ход закрыт.
    const time = at();
    commit(feed, settleCards(feed.state, 'stale', time));
    pending.settle(feed.ref);
    commit(feed, closeFeedTurn(feed.state, time));
  });

  return {
    onHook,

    async snapshot(ref, agentId) {
      const session = sessionOf(ref);
      if (agentId !== undefined) return agentSnapshot(ref, agentId);
      const feed = feedOf(ref);
      if (!feed.live && !feed.seeded) await seed(feed, session.provider);
      // Накопленная пачка уходит до снимка: следующая дельта подписчику — ровно `revision + 1`.
      flush(feed);
      return {
        items: [...feed.state.items],
        revision: feed.revision,
        schemaVersion: FEED_SCHEMA_VERSION,
      };
    },

    subscribe(ref, client) {
      sessionOf(ref);
      const key = refKey(ref);
      let clients = subscribers.get(key);
      if (clients === undefined) {
        clients = new Set();
        subscribers.set(key, clients);
      }
      clients.add(client);
    },

    unsubscribe(ref, client) {
      const key = refKey(ref);
      const clients = subscribers.get(key);
      clients?.delete(client);
      if (clients?.size === 0) subscribers.delete(key);
    },

    dropClient(client) {
      for (const [key, clients] of subscribers) {
        clients.delete(client);
        if (clients.size === 0) subscribers.delete(key);
      }
    },

    decide(ref, cardId, decision) {
      const feed = feeds.get(refKey(ref));
      const card = feed?.state.items.find((item) => isCard(item) && item.cardId === cardId);
      if (feed === undefined || card === undefined || !isCard(card)) {
        throw new HostError('not_found', `no card ${cardId} in the session feed`);
      }
      const current: FeedCardState = card.state;
      // Решение без удержанного хука ушло бы в никуда: карточка в окне сказала бы «allowed», а CLI
      // ничего не получил. Такое решение не применяется (окно повторит, когда хук дойдёт).
      const held = pending.get(feed.ref, cardId);
      if (held === undefined || current !== 'pending') return { applied: false, state: current };
      const result = applyDecision(feed.state, cardId, decision, at());
      if (!result.applied) return { applied: false, state: current };
      const next =
        result.changes.find((item): item is FeedCard => isCard(item) && item.cardId === cardId) ??
        card;
      const response = hookDecisionResponse(
        {
          hookEvent: held.hookEvent,
          rawToolInput: held.rawToolInput,
          suggestions: next.kind === 'permission' ? next.suggestions : [],
        },
        decision,
      );
      // Сначала ответ хуку, потом лента: `commit` снимает хуки решённых карточек пустым `{}`.
      pending.resolve(feed.ref, cardId, response);
      commit(feed, result);
      return { applied: true, state: next.state };
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeActivity();
      unsubscribeExit();
      unsubscribeWorks();
      for (const feed of feeds.values()) {
        if (feed.timer !== undefined) clearTimeout(feed.timer);
        feed.timer = undefined;
      }
      pending.settleAll();
    },
  };
}
