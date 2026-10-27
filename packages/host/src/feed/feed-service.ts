/**
 * Служба ленты вида «Chat» (план 2026-10-01, Task 2, п. 3; решения 2, 5, 14): на каждую сессию —
 * состояние чистого редьюсера core, кольцо элементов, `revision` и пачка дельт для подписчиков.
 *
 * Источники: приёмник хуков (`onHook`), решения окна (`decide`), активность хоста (`idle` снимает
 * карточки), запуск и выход процесса агента (`pty.start`: сев из журнала; `pty.exit`: карточки `stale`,
 * ход закрыт) и выключение хоста.
 * Ответ хуку `allow`/`deny` рождается только в `decide` — из решения, которое прислало окно
 * (Review Focus 5); всё остальное хост отвечает пустым `{}`.
 *
 * Кольцо держит не больше `maxItems` элементов и `maxBytes` их JSON (решение контролёра Г): строка
 * протокола не длиннее 8 МиБ, а снимок едет одной строкой. Дельты копятся пачкой не дольше
 * `batchMs` (решение Д): в пачке каждый элемент — один раз, в последней версии.
 *
 * Лента Codex (спека 2026-10-07, 5.3): журнал хвостом (`codex-source.ts`), опрос раз в 2 с при подписчиках
 * и живом процессе, агенты — по их журналам; оборванный ход сев закрывает только без живого процесса;
 * Stop — Esc без разбора экрана.
 *
 * Картинки результатов инструментов (план 2026-10-09, Task 3): лента несёт ссылки на файлы, а base64 хост кладёт
 * в `feed-images` (`image-store.ts`). Всё, что идёт в редьюсер, проходит обход картинок один раз и прямо перед
 * ним (`stash.ts`): тело хука (`onHook`, `onCodexHook`) и записи журналов Claude и Codex перед каждым
 * `feedFromTranscript` / `feedFromCodexRollout` / `applyCodexRecords`. Хвост журнала Claude (`readTail`) в
 * редьюсер не идёт — из него читаются только ретраи и прерывания, — поэтому картинок там не ищут.
 */

import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  applyDecision,
  applyHookEvent,
  applyCodexHookEvent,
  applyCodexRecords,
  claudeProjectRoots,
  closeFeedTurn,
  codexAgentMeta,
  codexHooksWanted,
  emptyCodexAgentMeta,
  emptyCodexCursor,
  emptyFeedState,
  FEED_IMAGE_SWEEP_MS,
  feedFromCodexRollout,
  feedFromTranscript,
  forEachJsonlRecord,
  interruptedAt,
  isCodexThreadBinding,
  isClaudeCode,
  loadConfig,
  parleyHome,
  retryFromTranscript,
  settleCards,
  turnActive,
  withCodexAgentMeta,
} from '@parley/core';
import type {
  CodexAgentMeta,
  CodexCursor,
  FeedCard,
  FeedCardState,
  FeedDecision,
  FeedItem,
  FeedState,
  FeedUpdate,
  RawRecord,
  RolloutRecord,
  WorkSession,
} from '@parley/core';
import { FEED_SCHEMA_VERSION, FEED_PROGRESS_RETRY_AFTER_MAX_MS, refKey, sessionRef } from '@parley/protocol';
import type { FeedDecisions, ProgressResult, Result, SessionRef } from '@parley/protocol';
import { projectProgress } from './progress.js';
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
import { createRolloutTail } from './codex-source.js';
import { createFeedImageStore } from './image-store.js';
import { stashClaudeRecord, stashCodexRecord, stashHookBody } from './stash.js';

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
/** Сколько байт хвоста журнала читается в поисках записи о прерывании: несколько последних записей. */
const INTERRUPT_TAIL_BYTES = 64 * 1024;

/**
 * Сколько ждать после Esc из чата, прежде чем закрыть ход самому: запись о прерывании хода с начатым
 * ответом Claude Code пишет сразу, и её успевает поймать `checkInterrupts`.
 */
export const INTERRUPT_GRACE_MS = 1_500;
const ESC = '\x1b';
const BACKSPACE = '\x7f';
/** Приглашение поля ввода Claude Code на экране: за ним — набранный текст. */
const INPUT_PROMPT = /^\s*❯\s?(.*)$/;
/** Сколько знаков начала промпта сверяется с полем ввода на экране. */
const RESTORED_PREFIX = 24;

const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';
/** id субагента — как у `meta.json` (0.2.0): ничего похожего на путь до файловой системы не доходит. */
const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** Как часто лента Codex перечитывает журналы, пока у сессии есть подписчики и живой процесс. */
const CODEX_POLL_MS = 2_000;
/** Сколько ждать первого хука после старта процесса Codex, прежде чем сказать «одобряет терминал» (спека 5.7). */
export const CODEX_HOOK_GRACE_MS = 15_000;
/**
 * Сколько хост держит `PermissionRequest` Codex: таймаут хука в его `-c` — 600 с, и хост отвечает
 * раньше, чем Codex оборвёт запрос сам (карточка станет `stale`, а не повиснет «ждущей»).
 */
export const CODEX_HOLD_MS = 590_000;

export interface FeedServiceDeps {
  host: Pick<HostContext, 'log'>;
  works: Pick<WorksService, 'entry' | 'onChange'>;
  activity: Pick<
    ActivityService,
    'onChange' | 'logFile' | 'childLogFile' | 'questionHeld' | 'permissionAnswered' | 'onLogChange'
  >;
  pty: Pick<PtyManager, 'on' | 'get' | 'write' | 'screenText'>;
}

export interface FeedServiceOptions {
  maxItems?: number;
  maxBytes?: number;
  batchMs?: number;
  /** Сколько хост держит хук без решения; дальше — `{}` и `stale`. */
  pendingTimeoutMs?: number;
  /** Срок ожидания хуков Codex после старта процесса; по умолчанию `CODEX_HOOK_GRACE_MS`. */
  codexHookGraceMs?: number;
  /**
   * Нужны ли хуки Codex — режим `parley` настройки `codexWriteApprovals` (`codexHooksWanted`); по умолчанию — из
   * `config.json`. Не нужны — подсказки про хуки нет.
   */
  codexHooks?: () => Promise<boolean>;
  /** Срок после Esc из чата, за который CLI сам пишет о прерывании; по умолчанию `INTERRUPT_GRACE_MS`. */
  interruptGraceMs?: number;
  now?: () => number;
  /** Корни истории Claude Code, внутри которых читаются журналы; по умолчанию — `claudeProjectRoots()`. */
  roots?: () => readonly string[];
  /** Чтение записей журнала; тесты подставляют счётчик. */
  readRecords?: (file: string) => Promise<RawRecord[]>;
  /** Каталог файлов картинок ленты; по умолчанию `<дом Parley>/feed-images`. */
  imagesDir?: string;
}

export type FeedSnapshot = Result<'feed.snapshot'>;

export interface FeedService {
  /** Событие хука от приёмника: ответ — сразу или после решения человека. */
  onHook(request: HookRequest): void;
  /** Снимок ленты сессии или, с `agentId`, ленты субагента из его журнала. */
  /**
   * `scope: 'attention'` — в `items` только ждущие карточки и последний `text` после последнего `prompt`
   * (нет `prompt` — последний `text` вообще); с `agentId` игнорируется.
   */
  snapshot(ref: SessionRef, agentId?: string, scope?: 'attention'): Promise<FeedSnapshot>;
  /** Ограниченная проекция существующей ленты, без подписки и дополнительного source polling. */
  progress(ref: SessionRef, client: Client): Promise<ProgressResult>;
  subscribe(ref: SessionRef, client: Client): void;
  unsubscribe(ref: SessionRef, client: Client): void;
  /** Клиент отключился от хоста: все его подписки сняты. */
  dropClient(client: Client): void;
  /** Сколько подписок на ленты держит хост: сумма размеров множеств подписчиков по всем сессиям. */
  subscriberCount(): number;
  decide(ref: SessionRef, cardId: string, decision: FeedDecision): Result<'feed.decide'>;
  /**
   * Режим разрешений, который хост сверил по подвалу терминала (`sessions.setMode`): ставит его в
   * ленту и шлёт дельту подписчикам, не дожидаясь события хука с `permission_mode`.
   */
  noteMode(ref: SessionRef, mode: string): void;
  /**
   * «Stop» вида «Chat»: Esc агенту по нажатию человека. Ход, который CLI бросил без записи в журнале
   * (ответа ещё не было), лента закрывает сама, а текст промпта, возвращённый CLI в поле ввода, стирает.
   */
  interrupt(ref: SessionRef): void;
  /**
   * Сообщение из Chat ушло в сессию (`pty.send` с `submitted`): запоминает время. Первая пачка ленты после метки,
   * где есть не только эхо промпта человека, пишет в журнал задержек `feed.firstDelta` — сколько агент молчал
   * до первого ответа, — и метка снимается; выход и новый запуск процесса метку тоже снимают.
   */
  markSent(ref: SessionRef): void;
  /** Выключение хоста: всем удержанным хукам `{}`, таймеры сняты. */
  stop(): Promise<void>;
}

/** Хвост журнала одного агента Codex: позиция чтения, курсор записей, сведения и признак «дочитан». */
interface CodexAgentTrack {
  tail: ReturnType<typeof createRolloutTail> | null;
  cursor: CodexCursor;
  meta: CodexAgentMeta;
  done: boolean;
}

interface CodexFeed {
  tail: ReturnType<typeof createRolloutTail>;
  cursor: CodexCursor;
  agents: Map<string, CodexAgentTrack>;
  /** Чтения хвостов идут по одному: у каждого хвоста своя позиция, второе чтение рядом её испортило бы. */
  queue: Promise<void>;
  /** Binding конкретного tail неизменен; другой thread/file требует настоящего пересоздания source. */
  progressBinding: { providerSessionId: string; file: string } | null;
  progressBindingValid: boolean;
}

interface Batch {
  upsert: Map<string, FeedItem>;
  removed: Set<string>;
}

interface SourceStamp {
  provider: string;
  providerSessionId: string;
  startedAtProcess: string;
  launchRevision?: string;
  pid?: number;
  file?: string;
}

interface ProgressEpoch {
  stamp: SourceStamp;
  eligible: Set<string>;
}

interface ProgressProof {
  stamp: SourceStamp | null;
  generation: number;
}

interface ProgressCall {
  key: string;
  cancel(): void;
}

interface ProgressClient {
  calls: Array<{ at: number; key: string }>;
  active: ProgressCall | null;
}

interface SessionFeed {
  ref: SessionRef;
  state: FeedState;
  revision: number;
  /** Байты JSON каждого элемента кольца и их сумма. */
  sizes: Map<string, number>;
  bytes: number;
  batch: Batch;
  /** Режим разрешений сменился с прошлой дельты: дельта уходит и без элементов. */
  modeChanged: boolean;
  timer: NodeJS.Timeout | undefined;
  /** Были живые события хуков: из журнала такую ленту не сеют. */
  live: boolean;
  /** Сев из журнала уже был (удачный или нет) — второй раз не сеем. */
  seeded: boolean;
  seeding: Promise<void> | undefined;
  /** Provenance только для progress; существующая лента и подписчики не сбрасываются. */
  observedSource: SourceStamp | null;
  progressEpoch: ProgressEpoch | null;
  sourceGeneration: number;
  pendingStart: { pid: number | null; previousStartedAt: string | null } | null;
  /** Последний `transcript_path` из хуков: запасной путь к журналам субагентов. */
  transcriptPath: string | null;
  /** Состояние ленты Codex: журнал сессии и журналы её агентов. */
  codex?: CodexFeed;
  /** Опрос журналов Codex, пока есть подписчики. */
  codexPoll?: NodeJS.Timeout | undefined;
  /** Кто отвечает на одобрения Codex: `null` — пока неизвестно (у Claude всегда). */
  decisions: FeedDecisions | null;
  /** Таймер ожидания первого хука Codex после старта процесса. */
  codexGrace?: NodeJS.Timeout | undefined;
}

const isCard = (item: FeedItem): item is FeedCard =>
  item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan';

const isPendingCard = (item: FeedItem): item is FeedCard =>
  isCard(item) && item.state === 'pending';

/** Урезанный снимок «нужен ты»: ждущие карточки и последний ответ модели после последнего промпта, порядок ленты. */
const attentionItems = (items: readonly FeedItem[]): FeedItem[] => {
  const lastPrompt = items.findLastIndex((item) => item.kind === 'prompt');
  let reply = -1;
  for (let index = items.length - 1; index > lastPrompt; index -= 1) {
    if (items[index]?.kind === 'text') {
      reply = index;
      break;
    }
  }
  return items.filter((item, index) => index === reply || isPendingCard(item));
};

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Текст первого вопроса `AskUserQuestion` по его `tool_input`; `null` — вопросов или их текста нет. */
const firstQuestionOf = (toolInput: Record<string, unknown>): string | null => {
  const questions = toolInput['questions'];
  return Array.isArray(questions) ? textOf(recordOf(questions[0])['question']) : null;
};

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
  const interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  const codexHookGraceMs = options.codexHookGraceMs ?? CODEX_HOOK_GRACE_MS;
  const codexHooks =
    options.codexHooks ?? (async (): Promise<boolean> => codexHooksWanted((await loadConfig()).config));
  const roots = options.roots ?? (() => claudeProjectRoots());
  const readRecords = options.readRecords ?? readRecordsTail;

  const imageStore = createFeedImageStore({
    dir: options.imagesDir ?? path.join(parleyHome(), 'feed-images'),
  });
  const saveImage = imageStore.save;
  const stashClaude = (records: readonly RawRecord[]): RawRecord[] =>
    records.map((record) => stashClaudeRecord(record, saveImage));
  const stashCodex = (records: readonly RolloutRecord[]): RolloutRecord[] =>
    records.map((record) => stashCodexRecord(record, saveImage));
  // Старые файлы картинок убираются при создании службы и дальше раз в `FEED_IMAGE_SWEEP_MS`; хост живёт
  // клиентами и сессиями, а не этим таймером, поэтому он не держит процесс. `stop()` его снимает. Уборка
  // асинхронная и не отклоняется: службу и хуки она не ждёт.
  void imageStore.sweep();
  const imageSweep = setInterval(() => void imageStore.sweep(), FEED_IMAGE_SWEEP_MS);
  imageSweep.unref();

  const feeds = new Map<string, SessionFeed>();
  // Это lock underlying cold seed, не кэш ответа. Removal/timeout не освобождают незавершённый I/O.
  const coldReads = new Map<string, Promise<void>>();
  const progressClients = new Map<Client, ProgressClient>();
  const subscribers = new Map<string, Set<Client>>();
  const lastActivity = new Map<string, string>();
  /** Метки `markSent`: ключ сессии → время отправки, до первой пачки ленты (журнал задержек `feed.firstDelta`). */
  const sentAt = new Map<string, number>();
  /** Процессы Codex, чья сессия на старте ещё не попала в карту работ: таймер доверия взведут по её появлению. */
  const graceWaiting = new Map<string, SessionRef>();
  /** Таймеры присмотра за Esc из чата. */
  const interruptTimers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const rawPending: PendingHooks = createPendingHooks({
    timeoutMs: options.pendingTimeoutMs ?? PENDING_TIMEOUT_MS,
    // Хук ждал дольше предела и получил `{}`: отвечать теперь в терминале.
    onTimeout: (ref, cardId) => settle(ref, 'stale', [cardId]),
  });

  /**
   * Сессии, у которых службе активности сказано «вопрос агента удержан» (решение О): последнее
   * переданное значение по ключу сессии; служба зовётся только при смене.
   */
  const questionHeld = new Map<string, SessionRef>();

  function syncHeld(ref: SessionRef): void {
    const key = refKey(ref);
    const question = rawPending.list(ref).find((info) => info.hookEvent === 'PreToolUse');
    const held = question !== undefined;
    if (held === questionHeld.has(key)) return;
    if (held) questionHeld.set(key, ref);
    else questionHeld.delete(key);
    // Вместе с удержанием уходит текст первого вопроса: из него `detail` потребности «вопрос агента».
    if (question === undefined) deps.activity.questionHeld(ref, false);
    else deps.activity.questionHeld(ref, true, firstQuestionOf(question.rawToolInput));
  }

  /** Удержанные хуки; каждое место, где удержание меняется, сверяет «вопрос удержан» со службой активности. */
  const pending: PendingHooks = {
    ...rawPending,
    hold(held) {
      rawPending.hold(held);
      syncHeld(held.ref);
    },
    resolve(ref, cardId, json) {
      const result = rawPending.resolve(ref, cardId, json);
      syncHeld(ref);
      return result;
    },
    settle(ref, cardIds) {
      const settled = rawPending.settle(ref, cardIds);
      syncHeld(ref);
      return settled;
    },
    drop(ref, cardId) {
      const result = rawPending.drop(ref, cardId);
      syncHeld(ref);
      return result;
    },
    settleAll() {
      rawPending.settleAll();
      for (const ref of Array.from(questionHeld.values())) syncHeld(ref);
    },
  };

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
        modeChanged: false,
        timer: undefined,
        live: false,
        seeded: false,
        seeding: undefined,
        observedSource: sourceOf(ref),
        progressEpoch: null,
        sourceGeneration: 0,
        pendingStart: null,
        transcriptPath: null,
        decisions: null,
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
    if (drop === 0) {
      pruneProgress(feed);
      return;
    }
    feed.state = { ...feed.state, items: items.slice(drop) };
    // Ждущая карточка ушла из ленты — решить её окну уже нечем: хуку `{}`, диалог остаётся в терминале.
    if (evicted.length > 0) pending.settle(feed.ref, evicted);
    pruneProgress(feed);
  }

  /** Таймер пачки заведён, если есть что слать: элементы, вытеснения или смена режима. */
  function schedule(feed: SessionFeed): void {
    if (
      feed.timer === undefined &&
      (feed.batch.upsert.size > 0 || feed.batch.removed.size > 0 || feed.modeChanged)
    ) {
      feed.timer = setTimeout(() => flush(feed), batchMs);
    }
  }

  function commit(feed: SessionFeed, update: FeedUpdate, proof?: ProgressProof): void {
    if (!feedCurrent(feed)) return;
    const before = proof === undefined ? null : new Set(feed.state.items.map((item) => item.id));
    const epoch = proof === undefined ? null : confirmProgress(feed, proof);
    if (update.state.permissionMode !== feed.state.permissionMode) feed.modeChanged = true;
    feed.state = update.state;
    for (const item of update.changes) {
      if (proof !== undefined && item.kind === 'tool' && item.agentId === undefined) {
        if (epoch !== null && !before?.has(item.id)) epoch.eligible.add(item.id);
        else if (epoch === null) feed.progressEpoch?.eligible.delete(item.id);
      }
      const size = itemBytes(item);
      feed.bytes += size - (feed.sizes.get(item.id) ?? 0);
      feed.sizes.set(item.id, size);
      feed.batch.upsert.set(item.id, item);
      feed.batch.removed.delete(item.id);
    }
    trim(feed, true);
    schedule(feed);
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
    if (!feedCurrent(feed)) return;
    if (feed.timer !== undefined) {
      clearTimeout(feed.timer);
      feed.timer = undefined;
    }
    const { upsert, removed } = feed.batch;
    if (upsert.size === 0 && removed.size === 0 && !feed.modeChanged) return;
    feed.batch = { upsert: new Map(), removed: new Set() };
    feed.modeChanged = false;
    feed.revision += 1;
    // Журнал задержек (спека диагностики, A4): запись нужна и без открытого Chat, поэтому до проверки подписчиков.
    // Эхо промпта человека — не ответ агента: пачка только из промптов метку не снимает.
    const key = refKey(feed.ref);
    const sent = sentAt.get(key);
    if (sent !== undefined && Array.from(upsert.values()).some((item) => item.kind !== 'prompt')) {
      sentAt.delete(key);
      log.info('лента: первая дельта после отправки', {
        op: 'feed.firstDelta',
        ref: feed.ref,
        sinceSendMs: Math.max(0, now() - sent),
      });
    }
    const clients = subscribers.get(key);
    if (clients === undefined || clients.size === 0) return;
    const data = {
      ref: feed.ref,
      revision: feed.revision,
      upsert: Array.from(upsert.values()),
      removed: Array.from(removed),
      mode: feed.state.permissionMode,
      ...(feed.decisions === null ? {} : { decisions: feed.decisions }),
    };
    for (const client of Array.from(clients)) {
      // В отличие от `pty.output`, подписку по буферу не снимаем: он обычно полон собственным большим ответом
      // окну (снимок ленты на мегабайты), а дельты мелкие и идут пачками раз в 50 мс. Окно об отписке не
      // узнало бы и ждало дельт вечно; ушедшего клиента снимает `dropClient`.
      client.send({ event: 'feed.changed', data });
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

  function setDecisions(feed: SessionFeed, value: FeedDecisions): void {
    if (feed.decisions === value) return;
    feed.decisions = value;
    // Дельта уходит и без элементов: окно должно узнать, кто отвечает на одобрения.
    feed.modeChanged = true;
    schedule(feed);
  }

  function clearCodexGrace(feed: SessionFeed): void {
    if (feed.codexGrace !== undefined) clearTimeout(feed.codexGrace);
    feed.codexGrace = undefined;
  }

  /**
   * Хук Codex (спека 5.6): лента продолжает читать журнал, хук лишь добавляет карточки одобрения и
   * раннее состояние; `PermissionRequest` держится до решения окна, но не дольше `CODEX_HOLD_MS`.
   */
  function onCodexHook(request: HookRequest): void {
    const { ref, body } = request;
    const feed = feedOf(ref);
    clearCodexGrace(feed);
    setDecisions(feed, 'window');
    const update = applyCodexHookEvent(feed.state, stashHookBody(body, saveImage), at());
    commit(feed, update);
    const card =
      body['hook_event_name'] === 'PermissionRequest'
        ? update.changes.find(
            (item): item is FeedCard => isPendingCard(item) && item.kind === 'permission',
          )
        : undefined;
    if (card === undefined) {
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    const cardId = card.cardId;
    pending.hold({
      ref: feed.ref,
      cardId,
      hookEvent: 'PermissionRequest',
      rawToolInput: recordOf(body['tool_input']),
      kind: card.kind,
      timeoutMs: CODEX_HOLD_MS,
      respond: request.respond,
    });
    request.onAbandon(() => {
      if (pending.drop(feed.ref, cardId)) settle(feed.ref, 'elsewhere', [cardId]);
    });
  }

  function onHook(request: HookRequest): void {
    if (stopped) {
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    const { ref, body } = request;
    let provider: string | undefined;
    try {
      provider = sessionOf(ref).provider;
    } catch {
      provider = undefined;
    }
    if (provider === 'codex') {
      onCodexHook(request);
      return;
    }
    const feed = feedOf(ref);
    feed.live = true;
    const proof = captureProgress(feed);
    if (body['session_id'] !== proof.stamp?.providerSessionId) proof.stamp = null;
    const transcript = textOf(body['transcript_path']);
    if (transcript !== null) feed.transcriptPath = transcript;

    const update = applyHookEvent(feed.state, stashHookBody(body, saveImage), at());
    const retry = feed.state.items.at(-1);
    if (retry?.kind === 'error' && retry.retry !== undefined && retry.retry.resolved !== true &&
      update.changes.some((item) => item.kind === 'text' || item.kind === 'prompt' || item.kind === 'turn' ||
        (item.kind === 'tool' && item.agentId === undefined) || isCard(item))) {
      const resolved = { ...retry, retry: { ...retry.retry, resolved: true as const } };
      update.state = { ...update.state, items: update.state.items.map((item) => item.id === retry.id ? resolved : item) };
      update.changes.push(resolved);
    }
    commit(feed, update, proof);

    const card = heldCard(feed, body, update.changes);
    if (card === undefined) {
      request.respond(EMPTY_HOOK_RESPONSE);
      return;
    }
    const cardId = card.cardId;
    const hookEvent = body['hook_event_name'] === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest';
    pending.hold({
      ref: feed.ref,
      cardId,
      hookEvent,
      rawToolInput: recordOf(body['tool_input']),
      kind: card.kind,
      respond: request.respond,
    });
    // CLI закрыл запрос сам (ответили в терминале, процесс вышел): решать в окне больше нечего.
    request.onAbandon(() => {
      if (!pending.drop(feed.ref, cardId)) return;
      // Ответили в терминале: инструмент пошёл, `blocked` пора снять. Таймаут (`stale`) сюда не попадает.
      if (hookEvent === 'PermissionRequest') deps.activity.permissionAnswered(feed.ref);
      settle(feed.ref, 'elsewhere', [cardId]);
    });
  }

  /**
   * Сев из журнала сессии: один раз и только пока живых событий не было (решение 2). Журнал ещё не
   * известен индексу (он строится после старта хоста, не дожидаясь окна) — сев не состоялся, и его
   * повторит следующий снимок или изменение журналов (`seedAside`).
   */
  function seed(feed: SessionFeed, provider: string): Promise<void> {
    if (stopped) return Promise.resolve();
    const key = refKey(feed.ref);
    const existing = coldReads.get(key);
    if (existing !== undefined) return existing;
    const run = provider === 'codex' ? seedCodex(feed) : seedClaude(feed, provider);
    if (feed.seeding === undefined) return run;
    const held = run.finally(() => {
      if (coldReads.get(key) === held) coldReads.delete(key);
    });
    coldReads.set(key, held);
    return held;
  }

  function seedClaude(feed: SessionFeed, provider: string): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    const file = isClaudeCode(provider) ? deps.activity.logFile(feed.ref) : null;
    if (file === null) return Promise.resolve();
    const proof = captureProgress(feed);
    feed.seeding = (async () => {
      try {
        const records = await readTranscript(file);
        if (records === null || feed.live || !feedCurrent(feed)) return;
        const seeded = closeBrokenTurn(feedFromTranscript(stashClaude(records), { limit: maxItems }));
        // Режим, который хост уже сверил по подвалу (`noteMode`), свежее записи журнала.
        const state = { ...seeded, permissionMode: feed.state.permissionMode ?? seeded.permissionMode };
        feed.state = state;
        feed.sizes = new Map();
        feed.bytes = 0;
        for (const item of state.items) {
          const size = itemBytes(item);
          feed.sizes.set(item.id, size);
          feed.bytes += size;
        }
        trim(feed, false);
        seedProgress(feed, proof);
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

  /** Сев ленты Codex из журнала сессии; потом — журналы её агентов. Хвост остаётся для опроса. */
  function seedCodex(feed: SessionFeed): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    const file = deps.activity.logFile(feed.ref);
    if (file === null) return Promise.resolve();
    const proof = captureProgress(feed);
    const binding = sessionOf(feed.ref).providerSessionId;
    feed.seeding = (async () => {
      try {
        const tail = createRolloutTail(file);
        const records = await tail.read();
        if (!feedCurrent(feed)) return;
        const seeded = feedFromCodexRollout(stashCodex(records), { limit: maxItems });
        // Ход, оборванный в журнале, закрывается только без живого процесса: у живого он ещё идёт
        // (рестарт хоста — процесс умер с ним).
        const state =
          deps.pty.get(feed.ref) === undefined ? closeBrokenTurn(seeded.state) : seeded.state;
        feed.state = state;
        feed.codex = {
          tail, cursor: seeded.cursor, agents: new Map(), queue: Promise.resolve(),
          progressBinding: typeof binding === 'string' && binding.length > 0 ? { providerSessionId: binding, file } : null,
          progressBindingValid: typeof binding === 'string' && binding.length > 0,
        };
        feed.sizes = new Map();
        feed.bytes = 0;
        for (const item of state.items) {
          const size = itemBytes(item);
          feed.sizes.set(item.id, size);
          feed.bytes += size;
        }
        trim(feed, false);
        seedProgress(feed, proof);
        if (seeded.cursor.skipped > 0) {
          log.info('лента Codex: пропущены незнакомые элементы', {
            sessionId: feed.ref.sessionId,
            skipped: seeded.cursor.skipped,
          });
        }
      } catch (error) {
        log.warn('лента Codex: журнал не прочитан', {
          sessionId: feed.ref.sessionId,
          error: String(error),
        });
      } finally {
        feed.seeded = true;
        feed.seeding = undefined;
      }
      if (feedCurrent(feed)) await serialCodex(feed, () => syncCodexAgents(feed));
    })();
    return feed.seeding;
  }

  function serialCodex(feed: SessionFeed, task: () => Promise<void>): Promise<void> {
    const codex = feed.codex;
    if (codex === undefined) return Promise.resolve();
    const run = codex.queue.then(task);
    codex.queue = run.catch(() => {});
    return run;
  }

  /** Новые записи журнала сессии и журналов её агентов — в ленту. */
  function pollCodex(feed: SessionFeed): Promise<void> {
    return serialCodex(feed, async () => {
      const codex = feed.codex;
      // Raw Chat сохраняет свой source lifecycle. Исходный progress stamp проверяется только при проекции.
      if (codex === undefined || !feedCurrent(feed)) return;
      const proof = captureProgress(feed);
      const records = await codex.tail.read();
      if (!feedCurrent(feed)) return;
      if (records.length > 0) {
        const { update, cursor } = applyCodexRecords(feed.state, stashCodex(records), codex.cursor);
        codex.cursor = cursor;
        commit(feed, update, proof);
      } else confirmProgress(feed, proof);
      await syncCodexAgents(feed);
    });
  }

  /** Карточки агентов ленты получают сведения и вызовы из журналов агентов; дочитанный агент больше не читается. */
  async function syncCodexAgents(feed: SessionFeed): Promise<void> {
    const codex = feed.codex;
    if (codex === undefined) return;
    for (const item of feed.state.items) {
      if (!feedCurrent(feed)) return;
      if (item.kind !== 'agent' || item.agentId === null) continue;
      let track = codex.agents.get(item.agentId);
      if (track?.done === true) continue;
      if (track === undefined) {
        track = { tail: null, cursor: emptyCodexCursor(), meta: emptyCodexAgentMeta(), done: false };
        codex.agents.set(item.agentId, track);
      }
      if (track.tail === null) {
        const file = deps.activity.childLogFile(feed.ref, item.agentId);
        if (file === null) continue;
        track.tail = createRolloutTail(file);
      }
      const records = await track.tail.read();
      if (!feedCurrent(feed)) return;
      if (records.length > 0) {
        const firstRead = track.meta.threadId === null;
        track.meta = codexAgentMeta(records, track.meta);
        // Копия истории родителя в начале журнала агента в ленту не попадает.
        if (firstRead) track.cursor = { ...track.cursor, lastOrdinal: track.meta.historyStart - 1 };
        commit(feed, withCodexAgentMeta(feed.state, item.agentId, track.meta));
        const { update, cursor } = applyCodexRecords(
          feed.state,
          stashCodex(records),
          track.cursor,
          item.agentId,
        );
        track.cursor = cursor;
        commit(feed, update);
      }
      if (item.status !== 'running') track.done = true;
    }
  }

  function startCodexPoll(feed: SessionFeed): void {
    if (feed.codexPoll !== undefined || stopped) return;
    const timer = setInterval(() => {
      if (deps.pty.get(feed.ref) === undefined) return;
      void seedAside(feed.ref);
    }, CODEX_POLL_MS);
    timer.unref();
    feed.codexPoll = timer;
  }

  function stopCodexPoll(feed: SessionFeed): void {
    if (feed.codexPoll !== undefined) clearInterval(feed.codexPoll);
    feed.codexPoll = undefined;
  }

  /**
   * Журнал оборван посреди хода: хост перезапустили или процесс убили, пока агент работал, либо ход
   * бросили Esc до ответа (записи о прерывании тогда нет). Сев идёт, пока живых событий не было, — того
   * хода уже нет, и без черты окно показывало бы у возобновлённой сессии «Working…» и Stop. Время черты —
   * последнего элемента: когда оборвалось на самом деле, журнал не знает.
   */
  function closeBrokenTurn(state: FeedState): FeedState {
    if (!turnActive(state.items)) return state;
    const endedAt = state.items.at(-1)?.at ?? at();
    const startedAt = state.items.findLast((item) => item.kind === 'prompt')?.at ?? endedAt;
    return closeFeedTurn({ ...state, turnStartedAt: startedAt }, endedAt, { interrupted: true }).state;
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

  /**
   * Последние записи журнала (хвост в `INTERRUPT_TAIL_BYTES`); `null` — читать нельзя, те же проверки,
   * что у `readTranscript`. Первая, обрезанная строка хвоста отбрасывается, битые строки пропускаются.
   */
  async function readTail(file: string): Promise<RawRecord[] | null> {
    if (!path.isAbsolute(file) || !insideRoots(file, roots())) return null;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await lstat(file);
      if (!info.isFile()) return null;
      handle = await open(file, 'r');
      const length = Math.min(info.size, INTERRUPT_TAIL_BYTES);
      const offset = info.size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const lines = buffer.toString('utf8').split('\n');
      if (offset > 0) lines.shift();
      const records: RawRecord[] = [];
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            records.push(parsed as RawRecord);
          }
        } catch {
          // Недописанная или битая строка — журнал ещё пишется.
        }
      }
      return records;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  function sessionOf(ref: SessionRef): WorkSession {
    const session = deps.works
      .entry(ref.projectPath, ref.workId)
      ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (session === undefined) throw new HostError('not_found', `no session ${ref.sessionId}`);
    return session;
  }

  function sourceOf(ref: SessionRef): SourceStamp | null {
    try {
      const session = sessionOf(ref);
      if ((!isClaudeCode(session.provider) && session.provider !== 'codex') ||
          typeof session.providerSessionId !== 'string' || session.providerSessionId.length === 0 ||
          typeof session.startedAtProcess !== 'string' || session.startedAtProcess.length === 0) return null;
      const handle = deps.pty.get(ref);
      if (handle !== undefined && session.pid !== handle.pid) return null;
      const stamp = { provider: session.provider, providerSessionId: session.providerSessionId, startedAtProcess: session.startedAtProcess };
      if (session.provider !== 'codex') return stamp;
      const proof = session.codexThreadBinding;
      if (!isCodexThreadBinding(proof) || proof.threadId === null || proof.threadId !== session.providerSessionId ||
          proof.pid !== session.pid || proof.startedAtProcess !== session.startedAtProcess) return null;
      const file = deps.activity.logFile(ref);
      if (file === null) return null;
      return { ...stamp, launchRevision: proof.launchRevision, pid: proof.pid, file };
    } catch {
      return null;
    }
  }

  function sameSource(left: SourceStamp, right: SourceStamp | null): boolean {
    return right !== null && left.provider === right.provider && left.providerSessionId === right.providerSessionId &&
      left.startedAtProcess === right.startedAtProcess && left.launchRevision === right.launchRevision &&
      left.pid === right.pid && left.file === right.file;
  }

  function feedCurrent(feed: SessionFeed): boolean {
    return !stopped && feeds.get(refKey(feed.ref)) === feed;
  }

  function invalidateProgress(feed: SessionFeed): void {
    feed.progressEpoch?.eligible.clear();
    feed.progressEpoch = null;
    feed.sourceGeneration += 1;
    clearProgress(refKey(feed.ref));
  }

  function observeSource(feed: SessionFeed): SourceStamp | null {
    let stamp = sourceOf(feed.ref);
    if (feed.pendingStart !== null) {
      const handle = deps.pty.get(feed.ref);
      if (stamp === null || handle === undefined || handle.pid !== feed.pendingStart.pid ||
          stamp.startedAtProcess === feed.pendingStart.previousStartedAt) stamp = null;
      else feed.pendingStart = null;
    }
    // Чужой binding/file фиксируется даже при missing proof и до works.changed.
    if (feed.codex !== undefined && !codexBindingCurrent(feed, stamp)) stamp = null;
    if (feed.observedSource !== null && !sameSource(feed.observedSource, stamp)) invalidateProgress(feed);
    feed.observedSource = stamp;
    return stamp;
  }

  function codexBindingCurrent(feed: SessionFeed, stamp: SourceStamp | null): boolean {
    const codex = feed.codex;
    if (codex === undefined || !codex.progressBindingValid || codex.progressBinding === null) return false;
    const binding = codex.progressBinding;
    let session: WorkSession;
    try { session = sessionOf(feed.ref); } catch { return false; }
    const file = deps.activity.logFile(feed.ref);
    if (session.provider !== 'codex' ||
        (session.providerSessionId !== null && session.providerSessionId !== binding.providerSessionId) ||
        (file !== null && file !== binding.file)) {
      codex.progressBindingValid = false;
      invalidateProgress(feed);
      return false;
    }
    return stamp !== null && stamp.provider === 'codex' && stamp.providerSessionId === binding.providerSessionId &&
      stamp.file === binding.file && file === binding.file;
  }

  function captureProgress(feed: SessionFeed): ProgressProof {
    let stamp = observeSource(feed);
    if (stamp?.provider === 'codex' && feed.codex !== undefined && !codexBindingCurrent(feed, stamp)) stamp = null;
    return { stamp, generation: feed.sourceGeneration };
  }

  function confirmProgress(feed: SessionFeed, proof: ProgressProof): ProgressEpoch | null {
    const current = observeSource(feed);
    if (!feedCurrent(feed) || proof.stamp === null || proof.generation !== feed.sourceGeneration || !sameSource(proof.stamp, current)) return null;
    if (proof.stamp.provider === 'codex' && !codexBindingCurrent(feed, current)) return null;
    feed.progressEpoch ??= { stamp: proof.stamp, eligible: new Set() };
    return feed.progressEpoch;
  }

  function pruneProgress(feed: SessionFeed): void {
    if (feed.progressEpoch === null) return;
    const current = new Set(feed.state.items.filter((item) => item.kind === 'tool' && item.agentId === undefined).slice(-FEED_MAX_ITEMS).map((item) => item.id));
    for (const id of feed.progressEpoch.eligible) if (!current.has(id)) feed.progressEpoch.eligible.delete(id);
  }

  function seedProgress(feed: SessionFeed, proof: ProgressProof): void {
    const epoch = confirmProgress(feed, proof);
    if (epoch === null) {
      if (feed.progressEpoch !== null) invalidateProgress(feed);
      return;
    }
    epoch.eligible.clear();
    // Вся история допустима только для первого verified seed до любой lifecycle invalidation.
    if (proof.generation === 0) {
      for (const item of feed.state.items) if (item.kind === 'tool' && item.agentId === undefined) epoch.eligible.add(item.id);
    }
    pruneProgress(feed);
  }

  function progressCurrent(feed: SessionFeed): boolean {
    const current = observeSource(feed);
    const epoch = feed.progressEpoch;
    if (!feedCurrent(feed) || epoch === null || !sameSource(epoch.stamp, current)) return false;
    if (epoch.stamp.provider === 'codex' && !codexBindingCurrent(feed, current)) {
      if (feed.progressEpoch !== null) invalidateProgress(feed);
      return false;
    }
    return feed.progressEpoch === epoch;
  }

  function unavailableProgress(feed?: SessionFeed): ProgressResult {
    return { revision: feed?.revision ?? 0, availability: 'unavailable', current: null, recent: [], truncated: false };
  }

  function clearProgress(key: string): void {
    for (const [client, state] of progressClients) {
      state.calls = state.calls.filter((call) => call.key !== key);
      if (state.active?.key === key) state.active.cancel();
      if (state.calls.length === 0) progressClients.delete(client);
    }
  }

  /**
   * Сев вне снимка — по запуску процесса сессии и по изменению журналов; посеянное уходит подписчикам
   * дельтой. Без него лента зависела бы от того, когда окно попросило снимок: раньше, чем индекс
   * журналов построился (секунды после старта хоста, а окно подключается сразу), — снимок пуст, и
   * второго окно не попросит (живая проверка 2026-10-02: после возобновления чат пуст, пока не
   * переключишь вид); позже первого живого события — историю до него лента уже не посеет.
   */
  async function seedAside(ref: SessionRef): Promise<void> {
    let provider: string;
    try {
      provider = sessionOf(ref).provider;
    } catch {
      return;
    }
    if (provider === 'codex') {
      const known = feedOf(ref);
      if (known.codex !== undefined) {
        await pollCodex(known);
        flush(known);
        return;
      }
    } else if (!isClaudeCode(provider)) return;
    const feed = feedOf(ref);
    if (feed.live || feed.seeded || feed.seeding !== undefined) return;
    const before = feed.state;
    await seed(feed, provider);
    if (stopped || feed.live || feed.state === before) return;
    const clients = subscribers.get(refKey(feed.ref));
    if (clients === undefined || clients.size === 0) return;
    for (const item of feed.state.items) feed.batch.upsert.set(item.id, item);
    if (feed.state.permissionMode !== before.permissionMode) feed.modeChanged = true;
    flush(feed);
  }

  /** Поле ввода на экране показывает начало этого текста (пробелы не в счёт: CLI рисует их сдвигом каретки). */
  function inputShows(screen: readonly string[], text: string): boolean {
    // Многострочный промпт стоит в поле первой строкой за приглашением — с ней и сверяем.
    const wanted = (text.trim().split('\n')[0] ?? '').replace(/\s+/g, '').slice(0, RESTORED_PREFIX);
    if (wanted === '') return false;
    const line = screen.findLast((candidate) => INPUT_PROMPT.test(candidate));
    const shown = (line === undefined ? '' : (INPUT_PROMPT.exec(line)?.[1] ?? '')).replace(/\s+/g, '');
    // Длинную вставку CLI держит в поле меткой `[Pasted text #N …]` — это тоже возвращённый промпт.
    return shown.startsWith(wanted) || shown.startsWith('[Pastedtext#');
  }

  /**
   * Срок после Esc вышел. Лента за это время не менялась — ни записи о прерывании, ни событий хуков: CLI
   * бросил ход молча (ответа ещё не было) и вернул текст промпта в поле ввода. Ход закрывается чертой
   * `interrupted`; текст стирается Backspace-ами — столько, сколько в нём знаков (лишние на пустом поле
   * ничего не делают), и только если экран его показывает, а человек в терминале сам ничего не набирал.
   */
  function settleInterrupt(feed: SessionFeed, state: FeedState, pid: number): void {
    if (stopped || feed.state !== state || feeds.get(refKey(feed.ref)) !== feed) return;
    const handle = deps.pty.get(feed.ref);
    if (handle === undefined || handle.pid !== pid) return;
    const prompt = state.items.findLast((item) => item.kind === 'prompt');
    commit(feed, closeFeedTurn(feed.state, at(), { interrupted: true }));
    if (prompt === undefined || prompt.kind !== 'prompt' || handle.hasDraft()) return;
    const screen = deps.pty.screenText(feed.ref);
    if (screen === undefined || !inputShows(screen, prompt.text)) return;
    try {
      deps.pty.write(feed.ref, BACKSPACE.repeat(Array.from(prompt.text).length));
    } catch (error) {
      log.warn('лента: возвращённый текст промпта не стёрт', {
        sessionId: feed.ref.sessionId,
        error: String(error),
      });
    }
  }

  async function agentSnapshot(ref: SessionRef, agentId: string): Promise<FeedSnapshot> {
    const notFound = (): HostError =>
      new HostError('not_found', `no transcript for agent ${agentId}`);
    if (!SAFE_AGENT_ID.test(agentId)) throw notFound();
    if (sessionOf(ref).provider === 'codex') {
      const file = deps.activity.childLogFile(ref, agentId);
      if (file === null) throw notFound();
      const records = await createRolloutTail(file).read();
      const meta = codexAgentMeta(records);
      const { state } = feedFromCodexRollout(stashCodex(records), {
        limit: maxItems,
        historyStart: meta.historyStart,
      });
      return {
        items: tailByBytes(state.items, maxBytes),
        revision: 0,
        schemaVersion: FEED_SCHEMA_VERSION,
        mode: state.permissionMode,
      };
    }
    const base = deps.activity.logFile(ref) ?? feeds.get(refKey(ref))?.transcriptPath ?? null;
    if (base === null) throw notFound();
    const file = path.join(base.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
    const records = await readTranscript(file);
    if (records === null) throw notFound();
    const state = feedFromTranscript(stashClaude(records), { limit: maxItems });
    return {
      items: tailByBytes(state.items, maxBytes),
      revision: 0,
      schemaVersion: FEED_SCHEMA_VERSION,
      mode: state.permissionMode,
    };
  }

  const unsubscribeActivity = deps.activity.onChange((ref, value) => {
    const key = refKey(ref);
    const activity = value.activity.activity;
    const previous = lastActivity.get(key);
    lastActivity.set(key, activity);
    if (stopped || activity !== 'idle' || previous === 'idle') return;
    const feed = feeds.get(key);
    if (feed === undefined) return;
    // У Codex запрос одобрения идёт из ячейки code mode, а она живёт дольше хода и приглашения: снятая карточка
    // отдала бы хуку `{}`, Codex ушёл бы в окно TUI, и `exec` ждал бы там без срока (разбор 2026-10-16).
    try {
      if (sessionOf(feed.ref).provider === 'codex') return;
    } catch {
      // Сессии уже нет в работах — поведение прежнее.
    }
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
      clearCodexGrace(feed);
      stopCodexPoll(feed);
      pending.settle(feed.ref);
      feed.progressEpoch?.eligible.clear();
      feed.progressEpoch = null;
      feeds.delete(key);
    }
    lastActivity.delete(key);
    sentAt.delete(key);
    subscribers.delete(key);
    graceWaiting.delete(key);
    clearProgress(key);
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
    for (const feed of feeds.values()) {
      const stamp = observeSource(feed);
      if (feed.codex !== undefined) codexBindingCurrent(feed, stamp);
    }
    for (const [key, ref] of [...graceWaiting]) {
      if (!alive.has(key)) continue;
      graceWaiting.delete(key);
      void armCodexGrace(ref);
    }
  });

  // Запуск и возобновление: журнал читается до первого события нового процесса.
  const unsubscribeStart = deps.pty.on('start', (ref) => {
    if (stopped) return;
    // Новый процесс не ответит на отправку старого: метка дала бы ложные минуты в `feed.firstDelta`.
    sentAt.delete(refKey(ref));
    const previous = feeds.get(refKey(ref));
    if (previous !== undefined) {
      previous.pendingStart = {
        pid: deps.pty.get(ref)?.pid ?? null,
        previousStartedAt: previous.observedSource?.startedAtProcess ?? null,
      };
      invalidateProgress(previous);
    }
    void seedAside(ref);
    void armCodexGrace(ref);
  });

  /**
   * Процесс Codex стартовал: если за `codexHookGraceMs` ни один хук не пришёл, одобрения отвечает
   * терминал (Codex не доверил хукам Parley или их нет). Только в режиме `parley` (`codexHooksWanted`).
   */
  async function armCodexGrace(ref: SessionRef): Promise<void> {
    try {
      if (sessionOf(ref).provider !== 'codex' || !(await codexHooks())) return;
    } catch (error) {
      // Новая сессия попадает в карту работ чуть позже старта процесса: таймер взведём, когда она появится.
      if (error instanceof HostError && error.code === 'not_found') graceWaiting.set(refKey(ref), ref);
      return;
    }
    if (stopped) return;
    const feed = feedOf(ref);
    if (feed.decisions === 'window') return;
    clearCodexGrace(feed);
    feed.codexGrace = setTimeout(() => {
      feed.codexGrace = undefined;
      if (!stopped && feed.decisions !== 'window') setDecisions(feed, 'terminal');
    }, codexHookGraceMs);
    feed.codexGrace.unref();
  }

  const unsubscribeExit = deps.pty.on('exit', (ref) => {
    if (stopped) return;
    // Ответа вышедшего процесса не будет: метка отправки не должна дожить до чужой пачки.
    sentAt.delete(refKey(ref));
    graceWaiting.delete(refKey(ref));
    const feed = feeds.get(refKey(ref));
    if (feed === undefined) {
      pending.settle(ref);
      return;
    }
    clearCodexGrace(feed);
    // Процесс вышел: висящим хукам `{}`, карточки — `stale` (терминал ответит уже новому процессу),
    // ход закрыт.
    const time = at();
    commit(feed, settleCards(feed.state, 'stale', time));
    pending.settle(feed.ref);
    commit(feed, closeFeedTurn(feed.state, time));
  });

  /**
   * Прерывание Esc (решение 5): `Stop` не приходит, и ход в ленте остался бы открытым (Stop, Queue в
   * окне). Его видно только записью «[Request interrupted by user…]» в журнале сессии — по изменению
   * журнала хост читает его хвост у лент с идущим ходом и, найдя запись новее начала хода, закрывает
   * ход чертой `interrupted`: идущие вызовы отклонены, ждущие карточки — `elsewhere`, их хукам `{}`.
   * Из того же хвоста читаются `system/api_error`: ретраи не присылают хуков, но должны появляться
   * в живой ленте. Проверка одна за раз; пришедшее за время чтения изменение — ещё один круг.
   */
  let checkingInterrupts = false;
  let recheckInterrupts = false;
  async function checkInterrupts(): Promise<void> {
    if (checkingInterrupts) {
      recheckInterrupts = true;
      return;
    }
    checkingInterrupts = true;
    try {
      do {
        recheckInterrupts = false;
        for (const feed of Array.from(feeds.values())) {
          if (stopped) return;
          const started = feed.state.turnStartedAt;
          if (started === null) continue;
          const file = deps.activity.logFile(feed.ref) ?? feed.transcriptPath;
          if (file === null) continue;
          const records = await readTail(file);
          // За время чтения ход мог кончиться или начаться заново — тогда записи сверяются уже с ним.
          if (records === null || stopped || feed.state.turnStartedAt !== started) continue;
          const seen = new Set(feed.state.items.map((item) => item.id));
          const retries = records.flatMap((record) => {
            const retry = retryFromTranscript(record);
            if (retry === null || retry.at < started || seen.has(retry.id)) return [];
            // A hook may have delivered recovered output while the log tail was being read.
            if (feed.state.items.some((item) => item.at > retry.at && item.kind !== 'error')) return [];
            seen.add(retry.id);
            return [retry];
          });
          if (retries.length > 0) {
            commit(feed, {
              state: { ...feed.state, items: [...feed.state.items, ...retries] },
              changes: retries,
            });
          }
          const latest = records
            .map(interruptedAt)
            .filter((time): time is string => time !== null)
            .sort()
            .at(-1);
          if (latest === undefined || latest <= started) continue;
          commit(feed, closeFeedTurn(feed.state, at(), { interrupted: true }));
        }
      } while (recheckInterrupts);
    } finally {
      checkingInterrupts = false;
    }
  }
  const unsubscribeLogs = deps.activity.onLogChange(() => {
    if (stopped) return;
    void checkInterrupts();
    // Индекс узнал журнал позже снимка или запуска — ленты без сева сеются сейчас.
    for (const feed of Array.from(feeds.values())) void seedAside(feed.ref);
  });

  return {
    onHook,

    async progress(ref, client) {
      const parsed = sessionRef.safeParse(ref);
      if (!parsed.success) throw new HostError('bad_request', 'invalid session ref');
      const session = sessionOf(parsed.data);
      const key = refKey(parsed.data);
      if (stopped) return unavailableProgress(feeds.get(key));
      const time = now();
      let quota = progressClients.get(client);
      if (quota === undefined) {
        quota = { calls: [], active: null };
        progressClients.set(client, quota);
      }
      quota.calls = quota.calls.filter((call) => call.at > time - 1000);
      if (quota.active !== null || quota.calls.length >= 4) {
        const wait = quota.active !== null ? FEED_PROGRESS_RETRY_AFTER_MAX_MS : (quota.calls[0]?.at ?? time) + 1000 - time;
        throw new HostError('conflict', 'progress request rate limited', {
          reason: 'island-progress-rate-limit',
          retryAfterMs: Math.max(0, Math.min(FEED_PROGRESS_RETRY_AFTER_MAX_MS, Math.ceil(wait))),
        });
      }
      quota.calls.push({ at: time, key });
      let cancel!: () => void;
      const cancelled = new Promise<boolean>((resolve) => { cancel = () => resolve(false); });
      const call: ProgressCall = { key, cancel };
      quota.active = call;
      const timer = setTimeout(cancel, 2000);
      timer.unref();
      const feed = feedOf(parsed.data);
      try {
        const stamp = observeSource(feed);
        const generation = feed.sourceGeneration;
        if (stamp === null) return unavailableProgress(feed);
        if (!feed.live && !feed.seeded) {
          const settled = await Promise.race([seed(feed, session.provider).then(() => true, () => false), cancelled]);
          if (!settled) return unavailableProgress(feed);
        }
        if (progressClients.get(client) !== quota || quota.active !== call || generation !== feed.sourceGeneration || !progressCurrent(feed) || feed.progressEpoch === null) return unavailableProgress(feed);
        // Как snapshot: feed revision принадлежит уже накопленной пачке, не числу progress вызовов.
        flush(feed);
        const eligible = feed.progressEpoch.eligible;
        const result = projectProgress({ ...feed.state, items: feed.state.items.filter((item) => eligible.has(item.id)) }, feed.revision);
        return progressCurrent(feed) && progressClients.get(client) === quota ? result : unavailableProgress(feed);
      } finally {
        clearTimeout(timer);
        if (quota.active === call) quota.active = null;
      }
    },

    async snapshot(ref, agentId, scope) {
      const startedAt = performance.now();
      const session = sessionOf(ref);
      if (agentId !== undefined) {
        const sub = await agentSnapshot(ref, agentId);
        log.info('лента: снимок', {
          sessionId: ref.sessionId,
          workId: ref.workId,
          agentId,
          items: sub.items.length,
          bytes: null,
          seedMs: null,
          totalMs: Math.round(performance.now() - startedAt),
        });
        return sub;
      }
      const feed = feedOf(ref);
      let seedMs: number | null = null;
      if (!feed.live && !feed.seeded) {
        const seedStartedAt = performance.now();
        await seed(feed, session.provider);
        seedMs = Math.round(performance.now() - seedStartedAt);
      }
      // Накопленная пачка уходит до снимка: следующая дельта подписчику — ровно `revision + 1`.
      flush(feed);
      const snapshot: FeedSnapshot = {
        items: scope === 'attention' ? attentionItems(feed.state.items) : [...feed.state.items],
        revision: feed.revision,
        schemaVersion: FEED_SCHEMA_VERSION,
        mode: feed.state.permissionMode,
        ...(feed.decisions === null ? {} : { decisions: feed.decisions }),
      };
      log.info('лента: снимок', {
        sessionId: ref.sessionId,
        workId: ref.workId,
        items: snapshot.items.length,
        bytes: feed.bytes,
        scope: scope ?? null,
        sentBytes: scope === 'attention' ? Buffer.byteLength(JSON.stringify(snapshot.items)) : feed.bytes,
        seedMs,
        totalMs: Math.round(performance.now() - startedAt),
      });
      return snapshot;
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
      if (!stopped && sessionOf(ref).provider === 'codex') startCodexPoll(feedOf(ref));
    },

    unsubscribe(ref, client) {
      const key = refKey(ref);
      const clients = subscribers.get(key);
      clients?.delete(client);
      if (clients?.size === 0) {
        subscribers.delete(key);
        const feed = feeds.get(key);
        if (feed !== undefined) stopCodexPoll(feed);
      }
    },

    dropClient(client) {
      progressClients.get(client)?.active?.cancel();
      progressClients.delete(client);
      for (const [key, clients] of subscribers) {
        clients.delete(client);
        if (clients.size === 0) {
          subscribers.delete(key);
          const feed = feeds.get(key);
          if (feed !== undefined) stopCodexPoll(feed);
        }
      }
    },

    subscriberCount() {
      let count = 0;
      for (const clients of subscribers.values()) count += clients.size;
      return count;
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
      // Хука «разрешили» у Claude Code нет: без отметки сессия числилась бы `blocked` до конца инструмента.
      if (held.hookEvent === 'PermissionRequest') deps.activity.permissionAnswered(feed.ref);
      commit(feed, result);
      return { applied: true, state: next.state };
    },

    noteMode(ref, mode) {
      if (stopped || mode === '') return;
      const feed = feedOf(ref);
      commit(feed, { state: { ...feed.state, permissionMode: mode }, changes: [] });
    },

    interrupt(ref) {
      const handle = deps.pty.get(ref);
      if (handle === undefined) throw new HostError('not_found', 'session is not running');
      deps.pty.write(ref, ESC);
      // У Codex приглашения `❯` и возвращённого в поле промпта нет: ход закроет запись `turn_aborted`.
      if (sessionOf(ref).provider === 'codex') return;
      const feed = feeds.get(refKey(ref));
      // Хода в ленте нет — присматривать не за чем: Esc ушёл, остальное за CLI.
      if (stopped || feed === undefined || feed.state.turnStartedAt === null) return;
      const state = feed.state;
      const pid = handle.pid;
      const timer = setTimeout(() => {
        interruptTimers.delete(timer);
        settleInterrupt(feed, state, pid);
      }, interruptGraceMs);
      interruptTimers.add(timer);
    },

    markSent(ref) {
      sentAt.set(refKey(ref), now());
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      for (const state of progressClients.values()) state.active?.cancel();
      progressClients.clear();
      unsubscribeActivity();
      unsubscribeStart();
      unsubscribeExit();
      unsubscribeWorks();
      unsubscribeLogs();
      clearInterval(imageSweep);
      for (const feed of feeds.values()) {
        if (feed.timer !== undefined) clearTimeout(feed.timer);
        feed.timer = undefined;
        clearCodexGrace(feed);
        stopCodexPoll(feed);
      }
      for (const timer of interruptTimers) clearTimeout(timer);
      interruptTimers.clear();
      pending.settleAll();
    },
  };
}
