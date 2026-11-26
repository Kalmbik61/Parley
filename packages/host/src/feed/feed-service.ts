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

import { hostText } from '../host-text.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  applyDecision,
  applyHookEvent,
  applyCodexHookEvent,
  applyCodexRecords,
  applyCodexTerminalPrompt,
  applyOpencodeMessages,
  applyQwenRecords,
  feedFromOpencodeMessages,
  feedFromQwenTranscript,
  claudeProjectRoots,
  closeFeedTurn,
  codexAgentMeta,
  codexPromptKey,
  codexHooksWanted,
  emptyCodexAgentMeta,
  emptyCodexCursor,
  emptyFeedState,
  finishTool,
  newText,
  newTool,
  FEED_AGENT_TEXT_LIMIT,
  FEED_IMAGE_SWEEP_MS,
  FEED_TEXT_LIMIT,
  feedFromCodexRollout,
  feedFromTranscript,
  mailFromInline,
  forEachJsonlRecord,
  interruptedAt,
  isCodexThreadBinding,
  kimiArchiveDirectory,
  byFamily,
  isClaudeCode,
  loadConfig,
  parleyHome,
  recogniseCodexPrompt,
  recogniseCodexStartupPrompt,
  retryFromTranscript,
  settleCards,
  turnActive,
  withCodexAgentMeta,
} from '@parley/core';
import type { KimiHistoryProjection, KimiHistoryReplay, KimiOutput, KimiReplayChunk } from '../kimi/sessions.js';
import { withoutKimiDateContext } from '../kimi/date-provenance.js';
import { createKimiWire, KIMI_SESSION_ID, projectKimiWire, record as kimiRecord, type KimiWireEvent } from '../kimi/native-wire.js';
import type {
  CodexAgentMeta,
  CodexCursor,
  CodexPrompt,
  OpencodeCursor,
  QwenCursor,
  FeedAgent,
  FeedCard,
  FeedCardState,
  FeedDecision,
  FeedItem,
  FeedQuestionCard,
  FeedState,
  FeedUpdate,
  RawRecord,
  RolloutRecord,
  WorkSession,
} from '@parley/core';
import { FEED_MAIL_FEATURE, FEED_SCHEMA_VERSION, FEED_PROGRESS_RETRY_AFTER_MAX_MS, FEED_RESYNC_FEATURE, feedItem, refKey, sessionRef } from '@parley/protocol';
import type { FeedDecisions, KimiRequest, KimiResponse, ProgressResult, Result, SendResult, SessionRef } from '@parley/protocol';
import { projectProgress } from './progress.js';
import { submitCodexFollowUp } from './codex-follow-up.js';
import { ANSWER_POLL_MS, ANSWER_STEP_MAX_MS, cleanAnswer, typeOwnAnswer } from './terminal-answer.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { LogChange } from '../activity/log-index.js';
import type { MailJournalEntry } from '@parley/core';
import type { Client } from '../client.js';
import { readMailJournal } from './mail-journal.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { EMPTY_HOOK_RESPONSE, hookDecisionResponse } from '../hooks/decisions.js';
import type { HookRequest } from '../hooks/hook-server.js';
import { createPendingHooks, PENDING_TIMEOUT_MS } from '../hooks/pending.js';
import type { PendingHooks } from '../hooks/pending.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createRolloutTail } from './codex-source.js';
import { confirmStartupChoice } from './folder-trust.js';
import { answerQwenPrompt, recogniseQwenPrompt, type QwenPrompt, type QwenPromptKind } from './qwen-prompt.js';
import { createQwenTail } from './qwen-source.js';
import { fetchOpencodeMessages, readOpencodeCache, writeOpencodeCache, type OpencodeAddress } from './opencode-source.js';
import { createFeedImageStore } from './image-store.js';
import { kimiInteraction, type KimiInteraction } from './kimi-interactions.js';
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
/** Сколько посевов лент идёт разом: остальные ждут в очереди (передний — снимок для окна). */
export const FEED_SEED_CONCURRENCY = 2;
/** Лента без подписчиков, которой не пользовались столько, уходит из памяти (решение 5 плана 11). */
export const FEED_IDLE_EVICT_MS = 10 * 60_000;
/**
 * Буфер записи окна с признаком `feed-resync` выше этого — хост снимает все его подписки на ленты и шлёт
 * `feed.resync` на каждую. Вдвое ниже потолка соединения (`CLIENT_HARD_CAP_BYTES`, 64 МиБ), чтобы окно успело
 * переподписаться до закрытия сокета.
 */
export const FEED_CLIENT_DROP_BYTES = 32 * 1024 * 1024;
/** Как часто обход ищет простаивающие ленты. */
const FEED_EVICT_SWEEP_MS = 60_000;
/**
 * Сколько байт хвоста журнала Claude читается при севе сначала; хвост удваивается, пока не накрыл файл, не набралось
 * `SEED_RECORD_WINDOW` записей и лента после редьюсера не дошла до `maxItems` или `maxBytes`.
 */
export const SEED_TAIL_BYTES = 16 * 1024 * 1024;
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

/**
 * Вопрос Codex на экране терминала (план слоя 2, задача 3): сколько и как часто хост ищет вопрос на экране после того,
 * как сессия стала ждать человека, как часто сверяет экран, пока карточка ждёт, и через сколько после решения
 * проверяет, что вопрос ушёл с экрана.
 */
export const TERMINAL_PROMPT_FIND_MS = 2_000;
export const TERMINAL_PROMPT_FIND_STEP_MS = 100;
export const TERMINAL_PROMPT_WATCH_MS = 1_000;
export const TERMINAL_PROMPT_CONFIRM_MS = 1_500;
/** Отказ с текстом: сколько после клавиши `3` ждать, пока сессия перестанет ждать (ход прерван), и как часто это сверять. */
export const TERMINAL_MESSAGE_WAIT_MS = 5_000;
export const TERMINAL_MESSAGE_POLL_MS = 100;

export interface FeedServiceDeps {
  host: Pick<HostContext, 'log'>;
  works: Pick<WorksService, 'entry' | 'onChange'>;
  activity: Pick<
    ActivityService,
    'onChange' | 'logFile' | 'childLogFile' | 'questionHeld' | 'permissionAnswered' | 'onLogChange'
  >;
  pty: Pick<PtyManager, 'on' | 'get' | 'write' | 'screenText'>;
  /**
   * Тот же отправитель, что у метода `pty.send` (вставка Codex и отдельный Enter): отказ с текстом уходит им обычным
   * сообщением человека. Нет — текст отказа не отправляется.
   */
  send?: (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult>;
}

export interface FeedServiceOptions {
  kimiRespond?: (ref: SessionRef, requestId: string, response: KimiResponse) => void;
  kimiBlocksChat?: (ref: SessionRef) => boolean;
  kimiNativeDecide?: (ref: SessionRef, requestId: string, decision: FeedDecision) => Promise<Result<'feed.decide'>>;
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
  /** Чтение записей журнала (последних `maxBytes` байт); тесты подставляют счётчик. */
  readRecords?: (file: string, maxBytes?: number) => Promise<RawRecord[]>;
  /** OpenCode 2.x: where the session's server answers now (the supervisor's `get`); `undefined` — no server runs. */
  opencodeServer?: (ref: SessionRef) => OpencodeAddress | undefined;
  /** HTTP for the OpenCode message polls; tests substitute it. */
  opencodeFetch?: typeof fetch;
  /** Чтение журнала почты Parley при севе; тесты подставляют своё. */
  readMailJournal?: (ref: SessionRef) => Promise<MailJournalEntry[]>;
  /** Первый хвост журнала Claude при севе; по умолчанию `SEED_TAIL_BYTES`. */
  seedTailBytes?: number;
  /** Каталог файлов картинок ленты; по умолчанию `<дом Parley>/feed-images`. */
  imagesDir?: string;
  /** Сроки карточек по вопросу терминала Codex; по умолчанию `TERMINAL_PROMPT_*`, тесты ставят короткие. */
  terminalPrompt?: { findMs?: number; findStepMs?: number; watchMs?: number; confirmMs?: number };
}

export type FeedSnapshot = Result<'feed.snapshot'>;

const MAIL_ID_PREFIX = 'mail:';

/** Элементы ленты для клиента: `mail` только с признаком `feed-mail` (спека почты 3.5). */
function mailFor(client: Client | undefined, items: readonly FeedItem[]): FeedItem[] {
  return client?.features.has(FEED_MAIL_FEATURE) === true ? [...items] : items.filter((item) => item.kind !== 'mail');
}

/** Дельта без `mail`: из `upsert` уходят элементы, из `removed` — id `mail:…`; `revision` и прочее то же, пустая пачка остаётся. */
export function withoutMail<D extends { upsert: FeedItem[]; removed: string[] }>(data: D): D {
  return { ...data, upsert: data.upsert.filter((item) => item.kind !== 'mail'), removed: data.removed.filter((id) => !id.startsWith(MAIL_ID_PREFIX)) };
}

export interface FeedService {
  kimiHasHistory(ref: SessionRef): boolean;
  kimiArchive(ref: SessionRef, archive: string): Promise<void>;
  kimiRemoveArchive(ref: SessionRef, archive: string): Promise<void>;
  kimiPruneArchives(ref: SessionRef, retain: readonly string[]): Promise<void>;
  kimiSeedCheckpoint(ref: SessionRef, archive: string): Promise<void>;
  kimiPrepareHistory(ref: SessionRef, archive: string, chunks: readonly KimiReplayChunk[], replay: KimiHistoryReplay): Promise<KimiHistoryProjection>;
  kimiOutput(ref: SessionRef, event: KimiOutput): void;
  kimiRequests(ref: SessionRef, requests: readonly KimiRequest[]): void;
  kimiNativeEvent(ref: SessionRef, source: string, event: KimiWireEvent, historical?: boolean): void;
  kimiNativeStartupFailed(ref: SessionRef, generation: string, message?: string): void;
  kimiNativeReset(ref: SessionRef, sameId: boolean): void;
  kimiNativeRequests(ref: SessionRef, requests: KimiRequest[], unresolved: boolean): void;
  /**
   * OpenCode: poll the session's messages now (called on its SSE events); joins the poll in flight. A session without a
   * feed in memory, a server or a seeded feed does nothing.
   */
  opencodePoll(ref: SessionRef): Promise<void>;
  /**
   * OpenCode: the last poll before a planned server stop (the supervisor's `beforeStop`): reads the messages from `server`
   * and stores them in the cache, with or without a feed in memory. Never throws.
   */
  opencodeLastPoll(ref: SessionRef, server: OpencodeAddress): Promise<void>;
  /**
   * Письма отданы хуку вместе с указателем (`inline-mail`): элемент `mail` встаёт в ленту после указателя-промпта.
   * `text` — точный `additionalContext`, `at` — время ответа хоста (то же, что в журнале почты). Не письмо — ничего.
   */
  delivered(ref: SessionRef, text: string, at: string): void;
  /** Событие хука от приёмника: ответ — сразу или после решения человека. */
  onHook(request: HookRequest): void;
  /** Снимок ленты сессии или, с `agentId`, ленты субагента из его журнала. */
  /**
   * `scope: 'attention'` — в `items` только ждущие карточки и последний `text` после последнего `prompt`
   * (нет `prompt` — последний `text` вообще); с `agentId` игнорируется.
   *
   * `client` — кому снимок: элементы `mail` получает только клиент с `feed-mail` в `hello.features`. Без клиента (внутренние
   * читатели: помощник, Telegram) `mail` не отдаётся, как и клиенту без признака.
   */
  snapshot(ref: SessionRef, agentId?: string, scope?: 'attention', client?: Client): Promise<FeedSnapshot>;
  /**
   * Current pending cards after snapshot preparation; reads reducer state before batched flush. `[]` — the feed is not
   * in memory (a card exists only with a held hook, and such a feed is never evicted); `undefined` — the feed is in
   * memory but not ready to answer.
   */
  peekAttention(ref: SessionRef): readonly FeedCard[] | undefined;
  /** Ограниченная проекция существующей ленты, без подписки и дополнительного source polling. */
  progress(ref: SessionRef, client: Client): Promise<ProgressResult>;
  subscribe(ref: SessionRef, client: Client): void;
  unsubscribe(ref: SessionRef, client: Client): void;
  /** Клиент отключился от хоста: все его подписки сняты. */
  dropClient(client: Client): void;
  /** Сколько подписок на ленты держит хост: сумма размеров множеств подписчиков по всем сессиям. */
  subscriberCount(): number;
  decide(ref: SessionRef, cardId: string, decision: FeedDecision): Result<'feed.decide'> | Promise<Result<'feed.decide'>>;
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

/** Qwen Code feed: the bound transcript read by its tail (spec 2026-11-11, 3.5). Hooks feed state only, never items. */
interface QwenFeed {
  tail: ReturnType<typeof createQwenTail>;
  cursor: QwenCursor;
  /** Tails are read one at a time: the position is the tail's own. */
  queue: Promise<void>;
}

/** OpenCode 2.x feed: messages read from the session's own server, or from Parley's cache when no server runs (spec 2026-11-12, 4.11). */
interface OpencodeFeed {
  cursor: OpencodeCursor;
  /** Fingerprint of the last applied answer: an equal one changes nothing. */
  digest: string | null;
  /** Polls run one at a time. */
  queue: Promise<void>;
}

interface CodexFeed {
  answeringFollowUp?: boolean;
  tail: ReturnType<typeof createRolloutTail>;
  cursor: CodexCursor;
  agents: Map<string, CodexAgentTrack>;
  /** Чтения хвостов идут по одному: у каждого хвоста своя позиция, второе чтение рядом её испортило бы. */
  queue: Promise<void>;
  /** Binding конкретного tail неизменен; другой thread/file требует настоящего пересоздания source. */
  progressBinding: { providerSessionId: string; file: string } | null;
  progressBindingValid: boolean;
  /** Привязка, из которой посеяна лента: другая привязка сессии (тред или файл) требует пересева (b-005). */
  seedBinding: { providerSessionId: string | null; file: string };
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

interface ProgressStart {
  ref: SessionRef;
  pid: number | null;
  previousStartedAt: string | null;
  confirmed: boolean;
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
  /** Provider owning this source; process starts and same-provider resumes do not replace it. */
  provider: string | undefined;
  /** Native output may arrive before the works cache publishes a newly created session. */
  awaitingRegistration: boolean;
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
  /** Когда лентой пользовались в последний раз (`feedOf`, уход последнего подписчика); от него считается простой. */
  usedAt: number;
  /** Provenance только для progress; существующая лента и подписчики не сбрасываются. */
  observedSource: SourceStamp | null;
  progressEpoch: ProgressEpoch | null;
  sourceGeneration: number;
  /** Последний `transcript_path` из хуков: запасной путь к журналам субагентов. */
  transcriptPath: string | null;
  /** Состояние ленты Codex: журнал сессии и журналы её агентов. */
  codex?: CodexFeed;
  /** Qwen Code: state of the feed read from the bound transcript. */
  qwen?: QwenFeed;
  /** A native OSC wait belongs to this feed and process, including while the user is navigating between questions. */
  qwenWait?: {
    kind: QwenPromptKind;
    pid: number;
    watch: NodeJS.Timeout;
    prompt: QwenPrompt | null;
    rawRevision?: number;
    answering: boolean;
  };

  /** OpenCode 2.x: state of the feed read from the session's server or cache. */
  opencode?: OpencodeFeed;
  /** Only the live ACP process may resolve these cards. */
  kimiInteractions?: Map<string, KimiInteraction>;
  kimiNative?: { id: string; seen: Set<string>; legacy?: { rows: { kind: 'prompt' | 'text'; text: string }[]; at: number; failed: boolean } };
  /**
   * Qwen Code: when its last turn ended (Stop hook or the journal going idle). The transcript has no end-of-turn record, so
   * this closes the turn it leaves open; it survives reseeding and a reconnect.
   */
  qwenStoppedAt?: string | undefined;
  /** Опрос журналов Codex и Qwen, пока есть подписчики. */
  codexPoll?: NodeJS.Timeout | undefined;
  /** Кто отвечает на одобрения Codex: `null` — пока неизвестно (у Claude всегда). */
  decisions: FeedDecisions | null;
  /** `decisions` вернулся к `null` с прошлой дельты: дельта несёт `decisions: null` явно (без поля подписчик оставил бы прежнее). */
  decisionsReset?: true;
  /** Таймер ожидания первого хука Codex после старта процесса. */
  codexGrace?: NodeJS.Timeout | undefined;
}

const isCodexFollowUp = (item: FeedItem): item is FeedQuestionCard =>
  item.kind === 'question' && item.via === 'terminal' && item.toolName === 'request_user_input_async';

function presentedDecisions(feed: SessionFeed): FeedDecisions | null {
  return feed.decisions === 'terminal' && feed.state.items.some(item => isCodexFollowUp(item) && item.state === 'pending')
    ? 'window' : feed.decisions;
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

/**
 * Последние `window` записей файла по порядку: кольцевой буфер, файл целиком в память не ложится. С `maxBytes`
 * меньше файла читаются только его последние байты (первая, неполная строка отбрасывается).
 */
export async function readRecordsTail(
  file: string,
  window: number = SEED_RECORD_WINDOW,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<RawRecord[]> {
  const ring: RawRecord[] = [];
  let next = 0;
  let count = 0;
  const { size } = await stat(file);
  const start = size > maxBytes ? size - maxBytes : 0;
  await forEachJsonlRecord(
    file,
    (record) => {
      ring[next] = record;
      next = (next + 1) % window;
      count += 1;
    },
    undefined,
    { start },
  );
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
  const opencodeFetch = options.opencodeFetch ?? fetch;
  const interruptGraceMs = options.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  const codexHookGraceMs = options.codexHookGraceMs ?? CODEX_HOOK_GRACE_MS;
  const codexHooks =
    options.codexHooks ?? (async (): Promise<boolean> => codexHooksWanted((await loadConfig()).config));
  const roots = options.roots ?? (() => claudeProjectRoots());
  const readRecords = options.readRecords ?? ((file: string, bytes?: number) => readRecordsTail(file, SEED_RECORD_WINDOW, bytes));
  const seedTailBytes = options.seedTailBytes ?? SEED_TAIL_BYTES;

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
  const coldReads = new Map<string, { provider: string; run: Promise<void> }>();
  // Очередь посевов: не больше `FEED_SEED_CONCURRENCY` разом; впереди — посев для окна (`foreground`), затем по порядку.
  type SeedWaiter = { key: string; foreground: boolean; start: () => void };
  const seedWaiters: SeedWaiter[] = [];
  let seedRunning = 0;
  const progressClients = new Map<Client, ProgressClient>();
  /** Граница запуска живёт до удаления сессии, даже если feed ещё нет или pending уже подтверждён. */
  const progressStarts = new Map<string, ProgressStart>();
  const subscribers = new Map<string, Set<Client>>();
  const lastActivity = new Map<string, string>();
  /** Метки `markSent`: ключ сессии → время отправки, до первой пачки ленты (журнал задержек `feed.firstDelta`). */
  const sentAt = new Map<string, number>();
  /** Процессы Codex, чья сессия на старте ещё не попала в карту работ: таймер доверия взведут по её появлению. */
  const graceWaiting = new Map<string, SessionRef>();
  /** Таймеры присмотра за Esc из чата. */
  const interruptTimers = new Set<NodeJS.Timeout>();
  const terminalFindMs = options.terminalPrompt?.findMs ?? TERMINAL_PROMPT_FIND_MS;
  const terminalFindStepMs = options.terminalPrompt?.findStepMs ?? TERMINAL_PROMPT_FIND_STEP_MS;
  const terminalWatchMs = options.terminalPrompt?.watchMs ?? TERMINAL_PROMPT_WATCH_MS;
  const terminalConfirmMs = options.terminalPrompt?.confirmMs ?? TERMINAL_PROMPT_CONFIRM_MS;
  /** Карточки по вопросу терминала: ключ сессии → запись о вопросе, пока карточка ждёт (хук Codex такой записи не имеет). */
  interface TerminalPrompt {
    cardId: string;
    fingerprint: string;
    pid: number | undefined;
    answering?: boolean;
    /** `feed.decisions` до карточки: вернуть при закрытии. */
    decisionsBefore: FeedDecisions | null;
    watch: NodeJS.Timeout;
  }
  const terminalPrompts = new Map<string, TerminalPrompt>();
  /** Идущий поиск вопроса на экране (опрос раз в `terminalFindStepMs`) и проверка после решения. */
  const terminalFinders = new Map<string, NodeJS.Timeout>();
  const terminalConfirms = new Map<string, NodeJS.Timeout>();
  /** На старте и во время хода Codex показывает разные формы вопросов. */
  const terminalEligible = new Map<string, 'startup' | 'turn'>();
  /** Сессии, в которые хост сейчас печатает свой ответ по шагам: поиск и новые карточки по экрану ждут. */
  const terminalBusy = new Set<string>();
  /** Идущая печать своего ответа по сессии: `cancel` снимает её ожидания и не даёт продолжиться после выхода процесса. */
  const terminalTyping = new Map<string, { cancel(): void }>();
  /** Ожидание конца ожидания сессии после отказа с текстом: затем текст уходит сообщением человека. */
  const terminalMessages = new Map<string, NodeJS.Timeout>();
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

  function feedOf(ref: SessionRef, nativeProvider?: string): SessionFeed {
    const key = refKey(ref);
    let feed = feeds.get(key);
    let provider: string | undefined;
    try { provider = sessionOf(ref).provider; } catch { /* A late hook can outlive the session. */ }
    const owner = provider ?? nativeProvider ?? feed?.provider;
    const previous = feed !== undefined && feed.provider !== owner ? feed : undefined;
    if (previous !== undefined) {
      invalidateProgress(previous);
      dropFeed(key);
      feed = undefined;
    }
    if (feed === undefined) {
      feed = {
        ref: { ...ref },
        provider: owner,
        awaitingRegistration: provider === undefined,
        state: emptyFeedState(),
        revision: previous?.revision ?? 0,
        sizes: new Map(),
        bytes: 0,
        batch: { upsert: new Map(), removed: new Set() },
        modeChanged: false,
        timer: undefined,
        live: false,
        seeded: false,
        seeding: undefined,
        usedAt: now(),
        observedSource: sourceOf(ref),
        progressEpoch: null,
        sourceGeneration: previous?.sourceGeneration ?? (progressStarts.has(key) ? 1 : 0),
        transcriptPath: null,
        decisions: null,
      };
      feeds.set(key, feed);
      if (previous !== undefined) {
        // Remove before seeding: clients upsert in place, then remove. One combined delta would delete colliding ids
        // (or leave their previous positions), so the replacement transcript needs its own following revision.
        for (const id of previous.batch.removed) feed.batch.removed.add(id);
        for (const item of previous.state.items) feed.batch.removed.add(item.id);
        feed.modeChanged = previous.state.permissionMode !== null;
        flush(feed);
      }
    }
    if (provider !== undefined) feed.awaitingRegistration = false;
    if (!stopped && (subscribers.get(key)?.size ?? 0) > 0 && provider !== undefined &&
        byFamily(provider, { claude: false, codex: true, qwen: true, opencode: true, neutral: false })) startCodexPoll(feed);
    feed.usedAt = now();
    // Whichever caller first observes takeover must publish the new history, even ahead of works.onChange.
    if (previous !== undefined) void seedAside(ref);
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
    for (const id of evicted) {
      const interaction = feed.kimiInteractions?.get(id);
      if (interaction === undefined) continue;
      // Responding publishes a new pending set. Wait until this feed update has finished.
      queueMicrotask(() => {
        if (!feedCurrent(feed) || feed.kimiInteractions?.get(id) !== interaction) return;
        const { request } = interaction;
        const response: KimiResponse = request.kind === 'permission'
          ? { kind: 'permission', optionId: null }
          : { kind: 'elicitation', action: 'cancel' };
        try {
          options.kimiRespond?.(feed.ref, request.id, response);
        } catch {
          // A transport that has already gone away has nothing left to cancel.
          feed.kimiInteractions.delete(id);
        }
      });
    }
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
    const decisionsReset = feed.decisionsReset === true;
    delete feed.decisionsReset;
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
    const decisions = presentedDecisions(feed);
    const data = {
      ref: feed.ref,
      revision: feed.revision,
      upsert: Array.from(upsert.values()),
      removed: Array.from(removed),
      mode: feed.state.permissionMode,
      ...(decisions === null ? (decisionsReset ? { decisions: null } : {}) : { decisions }),
    };
    // Клиенту без `feed-mail` — то же событие без `mail` в `upsert` и `mail:` в `removed`; `revision` тот же, пустая пачка идёт.
    const plain = withoutMail(data);
    for (const client of Array.from(clients)) {
      client.send({ event: 'feed.changed', data: client.features.has(FEED_MAIL_FEATURE) ? data : plain });
      // Подписку по буферу снимаем только у окна, которое умеет переподписаться: без `feed.resync` оно об отписке
      // не узнало бы и ждало дельт вечно (буфер обычно полон собственным большим ответом, снимком ленты на
      // мегабайты, а дельты мелкие и идут пачками раз в 50 мс), поэтому старому окну и мосту телефона остаётся
      // только потолок соединения. 32 МиБ — вдвое ниже потолка: окно успевает переподписаться до закрытия сокета.
      // Зациклиться нельзя: `feed.resync` стоит в конце очереди записи, окно прочтёт его, лишь вычитав весь
      // накопленный буфер (подписку и снимок оно шлёт уже после этого), а ответ-снимок идёт в тот же буфер — следующая
      // отписка возможна, лишь когда окно снова накопит больше 32 МиБ.
      const queuedBytes = client.writableLength();
      if (client.features.has(FEED_RESYNC_FEATURE) && queuedBytes > FEED_CLIENT_DROP_BYTES) {
        const refs = removeSubscriptions(client);
        for (const ref of refs) client.send({ event: 'feed.resync', data: { ref } });
        log.info('лента: клиент отписан по буферу', {
          op: 'feed.clientDropped',
          client: client.name,
          queuedBytes,
          feeds: refs.length,
        });
      }
    }
  }

  /** Подписчик ленты ушёл последним: опрос Codex стоит, лента простаивает с этого момента и, возможно, уходит из памяти. */
  function subscribersGone(key: string): void {
    subscribers.delete(key);
    const feed = feeds.get(key);
    if (feed === undefined) return;
    stopCodexPoll(feed);
    feed.usedAt = now();
    evictIfIdle(feed);
  }

  /** Снимает клиента со всех лент; возвращает ссылки на сессии, на которые он был подписан. */
  function removeSubscriptions(client: Client): SessionRef[] {
    const refs: SessionRef[] = [];
    // Копия: `evictIfIdle` внутри `subscribersGone` может выгрузить ленту, но подписчиков других лент не трогает.
    for (const [key, clients] of Array.from(subscribers)) {
      if (!clients.delete(client)) continue;
      const [projectPath = '', workId = '', sessionId = ''] = key.split('\u0000');
      refs.push({ projectPath, workId, sessionId });
      if (clients.size === 0) subscribersGone(key);
    }
    return refs;
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
    delete feed.decisionsReset;
    // Дельта уходит и без элементов: окно должно узнать, кто отвечает на одобрения.
    feed.modeChanged = true;
    schedule(feed);
  }

  function restoreDecisions(feed: SessionFeed, before: FeedDecisions | null): void {
    if (feed.decisions === before) return;
    if (before !== null) {
      setDecisions(feed, before);
      return;
    }
    feed.decisions = null;
    feed.decisionsReset = true;
    feed.modeChanged = true;
    schedule(feed);
  }

  function isCodexSession(ref: SessionRef): boolean {
    try {
      return byFamily(sessionOf(ref).provider, { claude: false, codex: true, qwen: false, opencode: false, neutral: false });
    } catch {
      return false;
    }
  }

  /** Вопрос на экране сессии; `null` — экрана нет или вопрос не узнан. Строки экрана дальше этой функции не идут. */
  function readTerminalPrompt(ref: SessionRef): CodexPrompt | null {
    const lines = deps.pty.screenText(ref);
    if (lines === undefined) return null;
    return terminalEligible.get(refKey(ref)) === 'startup' ? recogniseCodexStartupPrompt(lines) : recogniseCodexPrompt(lines);
  }

  function clearTerminalTimer(timers: Map<string, NodeJS.Timeout>, key: string, kind: 'interval' | 'timeout'): void {
    const timer = timers.get(key);
    if (timer === undefined) return;
    if (kind === 'interval') clearInterval(timer);
    else clearTimeout(timer);
    timers.delete(key);
  }

  /** Снимает запись о вопросе терминала; `outcome` — во что перевести ждущую карточку (`null` — карточку не трогать). */
  function closeTerminalPrompt(ref: SessionRef, outcome: 'elsewhere' | 'stale' | null): void {
    const key = refKey(ref);
    const record = terminalPrompts.get(key);
    if (record === undefined) return;
    clearInterval(record.watch);
    terminalPrompts.delete(key);
    const feed = feeds.get(key);
    if (feed === undefined) return;
    restoreDecisions(feed, record.decisionsBefore);
    if (outcome !== null) settle(ref, outcome, [record.cardId]);
  }

  /** Всё, что хост держит по вопросам терминала сессии: поиск, проверку после решения и запись (карточка не меняется). */
  function dropTerminalState(key: string): void {
    clearTerminalTimer(terminalFinders, key, 'interval');
    clearTerminalTimer(terminalConfirms, key, 'timeout');
    clearTerminalTimer(terminalMessages, key, 'interval');
    terminalTyping.get(key)?.cancel();
    terminalTyping.delete(key);
    terminalBusy.delete(key);
    const record = terminalPrompts.get(key);
    if (record === undefined) return;
    clearInterval(record.watch);
    terminalPrompts.delete(key);
    const feed = feeds.get(key);
    if (feed !== undefined) restoreDecisions(feed, record.decisionsBefore);
  }

  /** Заводит карточку по узнанному вопросу и берёт её под присмотр: экран сверяется раз в `terminalWatchMs`. */
  function openTerminalPrompt(feed: SessionFeed, prompt: CodexPrompt): void {
    const key = refKey(feed.ref);
    if (!terminalEligible.has(key) || terminalBusy.has(key) || terminalPrompts.has(key) || feed.state.items.some(item => isPendingCard(item) && !isCodexFollowUp(item))) return;
    const pid = deps.pty.get(feed.ref)?.pid;
    if (prompt.kind === 'startup-choice' && pid === undefined) return;
    const update = applyCodexTerminalPrompt(feed.state, prompt, at(), prompt.kind === 'startup-choice' ? 'codex-startup:' + randomUUID() : undefined);
    const card = update.changes.find((item): item is FeedCard => isPendingCard(item));
    if (card === undefined) return;
    const decisionsBefore = feed.decisions;
    commit(feed, update);
    setDecisions(feed, 'window');
    const watch = setInterval(() => {
      const record = terminalPrompts.get(key);
      if (record === undefined) return;
      // Карточку унёс сев ленты из журнала (он заменяет состояние): запись снята, вопрос на экране ищется заново.
      const own = feed.state.items.find((item) => isCard(item) && item.cardId === record.cardId);
      if (own === undefined || !isPendingCard(own)) {
        closeTerminalPrompt(feed.ref, null);
        findTerminalPrompt(feed.ref);
        return;
      }
      const seen = readTerminalPrompt(feed.ref);
      // Ответили в терминале, вопрос сменился или ушёл, сессия перестала ждать: карточка отвечена в другом месте.
      if (!terminalEligible.has(key) || seen === null || seen.fingerprint !== record.fingerprint) {
        closeTerminalPrompt(feed.ref, 'elsewhere');
        if (terminalEligible.get(key) === 'startup') findTerminalPrompt(feed.ref);
      }
    }, terminalWatchMs);
    watch.unref();
    terminalPrompts.set(key, { cardId: card.cardId, fingerprint: prompt.fingerprint, pid, decisionsBefore, watch });
  }

  /**
   * Сессия Codex ждёт одобрения или ответа: ищет вопрос на экране (каждые `terminalFindStepMs` до `terminalFindMs`) и,
   * узнав, заводит карточку. Нет ждущей карточки в ленте, нет записи о вопросе и второго поиска — иначе ничего.
   */
  function findTerminalPrompt(ref: SessionRef): void {
    const key = refKey(ref);
    if (stopped || !terminalEligible.has(key) || terminalBusy.has(key) || terminalPrompts.has(key) || terminalFinders.has(key)) return;
    const feed = feedOf(ref);
    if (feed.state.items.some(item => isPendingCard(item) && !isCodexFollowUp(item))) return;
    const startup = terminalEligible.get(key) === 'startup';
    const startedAt = now();
    const finish = (): void => clearTerminalTimer(terminalFinders, key, 'interval');
    const step = (): void => {
      // Сессия перестала ждать до того, как вопрос узнали: поиск снят, карточку по экрану не заводим.
      if (stopped || !terminalEligible.has(key)) return finish();
      const found = readTerminalPrompt(ref);
      if (found !== null) {
        finish();
        openTerminalPrompt(feed, found);
        return;
      }
      if (!startup && now() - startedAt >= terminalFindMs) finish();
    };
    // После входа или выбора папки Codex может показать вопрос про хуки без нового события активности.
    const timer = setInterval(step, startup ? terminalWatchMs : terminalFindStepMs);
    timer.unref();
    terminalFinders.set(key, timer);
    step();
  }

  /** После решения человека: через `terminalConfirmMs` вопрос должен уйти с экрана; не ушёл — запись в журнал, поиск заново. */
  function confirmTerminalAnswer(ref: SessionRef, before: CodexPrompt): void {
    const key = refKey(ref);
    clearTerminalTimer(terminalConfirms, key, 'timeout');
    const timer = setTimeout(() => {
      terminalConfirms.delete(key);
      if (stopped || !terminalEligible.has(key)) return;
      const seen = readTerminalPrompt(ref);
      // Строки экрана в журнал не идут: только вид вопроса и исход.
      if (seen !== null && seen.fingerprint === before.fingerprint) {
        log.info('вопрос терминала не снят ответом', { op: 'feed.terminalPrompt', outcome: 'not-applied', kind: before.kind, sessionId: ref.sessionId });
      }
      // Следующий вопрос из нескольких или тот же, если клавиша не сработала: карточка по новому поиску.
      findTerminalPrompt(ref);
    }, terminalConfirmMs);
    timer.unref();
    terminalConfirms.set(key, timer);
  }

  /** Свой ответ на вопрос: текст ответа, которого нет среди вариантов карточки; `null` — решение другого вида или пустое. */
  function ownAnswerOf(prompt: CodexPrompt, decision: FeedDecision): string | null {
    if (prompt.kind !== 'question' || decision.kind !== 'question') return null;
    const entries = Object.entries(decision.answers);
    const answer = decision.answers[prompt.question] ?? (entries.length === 1 ? entries[0]![1] : undefined);
    return answer !== undefined && cleanAnswer(answer) !== '' ? answer : null;
  }

  /** Печатает свой ответ по шагам (`typeOwnAnswer`); исход не `done` — запись в журнал хоста без текста. */
  function startOwnAnswer(ref: SessionRef, prompt: CodexPrompt & { kind: 'question' }, text: string): void {
    const key = refKey(ref);
    terminalBusy.add(key);
    clearTerminalTimer(terminalFinders, key, 'interval');
    // Ожидания шагов записаны: выход процесса, выгрузка ленты и `stop()` снимают их и печать не продолжается.
    let cancelled = false;
    const sleepers = new Set<() => void>();
    const operation = {
      cancel(): void {
        cancelled = true;
        for (const wake of Array.from(sleepers)) wake();
      },
    };
    terminalTyping.set(key, operation);
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          sleepers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        timer.unref();
        sleepers.add(wake);
      });
    typeOwnAnswer({ pty: deps.pty, sleep, cancelled: () => cancelled || stopped }, ref, prompt, text)
      .then((outcome) => {
        // Печать отменена (процесс вышел, лента выгружена, хост остановлен): ни записи в журнал, ни нового поиска.
        if (cancelled) return;
        if (outcome !== 'done') {
          log.info('свой ответ на вопрос терминала не доведён', { op: 'feed.terminalPrompt', outcome: `own-answer-${outcome}`, sessionId: ref.sessionId });
          return;
        }
        // Следующий вопрос из нескольких: проверка и новый поиск, как после ответа клавишей.
        confirmTerminalAnswer(ref, prompt);
      })
      .catch((error: unknown) => {
        log.warn('свой ответ на вопрос терминала: ошибка', { op: 'feed.terminalPrompt', sessionId: ref.sessionId, error: String(error) });
      })
      .finally(() => {
        if (terminalTyping.get(key) !== operation) return;
        terminalTyping.delete(key);
        terminalBusy.delete(key);
      });
  }

  /**
   * Отказ с текстом: клавиша `3` прервала ход Codex; когда сессия перестала ждать (до `TERMINAL_MESSAGE_WAIT_MS`), текст
   * уходит обычным сообщением человека тем же отправителем, что у `pty.send`. Не дождались — текст не печатается, в журнал
   * идёт исход без текста.
   */
  function sendDenialMessage(ref: SessionRef, message: string): void {
    const key = refKey(ref);
    clearTerminalTimer(terminalMessages, key, 'interval');
    const outcome = (name: string, extra: Record<string, unknown> = {}): void => {
      log.info('отказ с текстом по вопросу терминала', { op: 'feed.terminalPrompt', outcome: name, sessionId: ref.sessionId, ...extra });
    };
    const send = deps.send;
    if (send === undefined) {
      outcome('denial-message-unavailable');
      return;
    }
    const startedAt = now();
    const timer = setInterval(() => {
      if (stopped) return clearTerminalTimer(terminalMessages, key, 'interval');
      // Готов, когда сессия вовсе перестала быть `blocked`: другая нужда при `blocked` (startup, лимит) — ещё не готов.
      const ready = lastActivity.get(key) !== 'blocked';
      if (!ready && now() - startedAt < TERMINAL_MESSAGE_WAIT_MS) return;
      clearTerminalTimer(terminalMessages, key, 'interval');
      if (!ready) return outcome('denial-message-timeout');
      send({ ref, text: message, submit: true }).then(
        (result) => outcome(result.submitted ? 'denial-message-sent' : 'denial-message-not-sent', result.submitted ? {} : { reason: result.reason }),
        (error: unknown) => outcome('denial-message-failed', { error: String(error) }),
      );
    }, TERMINAL_MESSAGE_POLL_MS);
    timer.unref();
    terminalMessages.set(key, timer);
  }

  /** Цифра в стартовом меню может как переместить курсор, так и подтвердить выбор.
   * Перемещаем курсор стрелками и сверяем выделение в том же процессе перед подтверждением. */
  async function decideStartupPrompt(feed: SessionFeed, record: TerminalPrompt, prompt: CodexPrompt & { kind: 'startup-choice' }, decision: FeedDecision): Promise<Result<'feed.decide'>> {
    if (record.answering || decision.kind !== 'question') return { applied: false, state: 'pending' };
    const answer = decision.values?.answer ?? decision.answers[prompt.question];
    const target = prompt.options.findIndex(option => option.label === answer);
    if (target < 0) return { applied: false, state: 'pending' };
    const key = refKey(feed.ref);
    const selected = (): number | undefined => {
      if (stopped || terminalPrompts.get(key) !== record || deps.pty.get(feed.ref)?.pid !== record.pid) return undefined;
      const seen = readTerminalPrompt(feed.ref);
      return seen?.fingerprint === record.fingerprint ? seen.selected : undefined;
    };
    const changed = (): Result<'feed.decide'> => {
      if (terminalPrompts.get(key) === record) {
        closeTerminalPrompt(feed.ref, 'elsewhere');
        findTerminalPrompt(feed.ref);
      }
      return { applied: false, state: 'elsewhere' };
    };
    record.answering = true;
    try {
      const outcome = await confirmStartupChoice(target, prompt.options.length, selected, data => deps.pty.write(feed.ref, data));
      if (outcome === 'changed') return changed();
      if (outcome === 'timeout') return { applied: false, state: 'pending' };
      const result = applyDecision(feed.state, record.cardId, {
        kind: 'question', answers: { [prompt.question]: prompt.options[target]!.label },
      }, at());
      commit(feed, result);
      closeTerminalPrompt(feed.ref, null);
      confirmTerminalAnswer(feed.ref, prompt);
      return { applied: true, state: 'answered' };
    } catch (error) {
      if (terminalPrompts.get(key) === record) closeTerminalPrompt(feed.ref, 'stale');
      throw error;
    } finally {
      record.answering = false;
    }
  }

  /** Решение по карточке терминала: клавиша уходит, только если экран прямо сейчас даёт тот же отпечаток. */
  function decideTerminalPrompt(feed: SessionFeed, record: TerminalPrompt, decision: FeedDecision, current: FeedCardState): Result<'feed.decide'> | Promise<Result<'feed.decide'>> {
    const seen = readTerminalPrompt(feed.ref);
    if (seen === null || seen.fingerprint !== record.fingerprint) {
      closeTerminalPrompt(feed.ref, 'elsewhere');
      return { applied: false, state: 'elsewhere' };
    }
    if (seen.kind === 'startup-choice') return decideStartupPrompt(feed, record, seen, decision);
    const keyToPress = codexPromptKey(seen, decision);
    const own = keyToPress === null ? ownAnswerOf(seen, decision) : null;
    // Ни клавиши, ни своего ответа: решение этим вопросом не выражается.
    if (keyToPress === null && own === null) return { applied: false, state: current };
    const result = applyDecision(feed.state, record.cardId, decision, at());
    if (!result.applied) return { applied: false, state: current };
    if (keyToPress === null) {
      // Свой ответ: карточка закрывается, текст печатается по шагам со сверкой экрана; ответ окну не ждёт конца печати.
      const next = result.changes.find((item): item is FeedCard => isCard(item) && item.cardId === record.cardId);
      commit(feed, result);
      closeTerminalPrompt(feed.ref, null);
      if (seen.kind === 'question') startOwnAnswer(feed.ref, seen, own as string);
      return { applied: true, state: next?.state ?? current };
    }
    // Между сверкой экрана и записью нет `await`: клавиша уходит в тот вопрос, который только что видели.
    try {
      deps.pty.write(feed.ref, keyToPress);
    } catch {
      closeTerminalPrompt(feed.ref, 'stale');
      return { applied: false, state: 'stale' };
    }
    const next = result.changes.find((item): item is FeedCard => isCard(item) && item.cardId === record.cardId);
    commit(feed, result);
    closeTerminalPrompt(feed.ref, null);
    confirmTerminalAnswer(feed.ref, seen);
    // Отказ с текстом: `3` прервал ход, текст пойдёт сообщением, когда Codex будет готов.
    if (decision.kind === 'permission' && decision.behavior === 'deny' && decision.message !== undefined && decision.message.trim() !== '') {
      sendDenialMessage(feed.ref, decision.message.trim());
    }
    return { applied: true, state: next?.state ?? current };
  }

  async function decideCodexFollowUp(feed: SessionFeed, card: FeedQuestionCard, decision: FeedDecision): Promise<Result<'feed.decide'>> {
    const codex = feed.codex;
    const process = deps.pty.get(feed.ref);
    const question = card.questions[0];
    const answer = question && decision.kind === 'question' ? decision.answers[question.question] : undefined;
    if (!codex || codex.answeringFollowUp || !process || !question || !answer) return { applied: false, state: card.state };
    const currentCard = () => feed.state.items.find((item): item is FeedQuestionCard => item.id === card.id && isCodexFollowUp(item));
    const sameSession = () => {
      const running = deps.pty.get(feed.ref);
      return !stopped && feedCurrent(feed) && feed.codex === codex && running?.pid === process.pid &&
        running.startedAt === process.startedAt && !codexRebound(feed, codex.seedBinding);
    };
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    codex.answeringFollowUp = true;
    try {
      // Terminal may have answered since the last feed poll.
      await pollCodex(feed);
      const sent = await submitCodexFollowUp({
        read: () => sameSession() && currentCard()?.state === 'pending' ? deps.pty.screenText(feed.ref) : undefined,
        write: key => deps.pty.write(feed.ref, key),
        sleep,
      }, question, answer, feed.state.items.filter(isCodexFollowUp).filter(item => item.state === 'pending').flatMap(item => item.questions));
      // A repaint or a changed prompt is not a receipt. The native response identifies the exact question.
      if (sent) {
        for (let elapsed = 0; elapsed <= ANSWER_STEP_MAX_MS && sameSession(); elapsed += ANSWER_POLL_MS) {
          await pollCodex(feed);
          if (currentCard()?.state !== 'pending') break;
          if (elapsed < ANSWER_STEP_MAX_MS) await sleep(ANSWER_POLL_MS);
        }
      }
      const result = sameSession() ? currentCard() : undefined;
      return { applied: sent && result?.state === 'answered' && result.answers?.[question.question] === answer, state: result?.state ?? 'stale' };
    } finally {
      delete codex.answeringFollowUp;
    }
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
    // Карточка хука и карточка по экрану вместе не живут: ждущая карточка экрана уступает хуку.
    if (body['hook_event_name'] === 'PermissionRequest') closeTerminalPrompt(ref, 'elsewhere');
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
    const hookFamily = provider === undefined ? 'claude' : byFamily(provider, { claude: 'claude' as const, codex: 'codex' as const, qwen: null, opencode: null, neutral: null });
    if (hookFamily === 'codex') {
      onCodexHook(request);
      return;
    }
    // Qwen Code, null or unknown family: no Claude hook handling, and the hook is answered at once — Qwen waits for the
    // HTTP answer (PermissionRequest and PreToolUse up to an hour) before it goes on. A Qwen hook creates no feed items
    // and no permission cards (spec 2026-11-11, 3.5, Feed ownership); it only prompts the transcript to be read now.
    if (hookFamily === null) {
      request.respond(EMPTY_HOOK_RESPONSE);
      if (provider !== undefined && byFamily(provider, { claude: false, codex: false, qwen: true, opencode: false, neutral: false })) {
        if (body['hook_event_name'] === 'Stop' || body['hook_event_name'] === 'StopFailure') {
          const stamp = textOf(body['timestamp']);
          feedOf(ref).qwenStoppedAt = stamp !== null && !Number.isNaN(Date.parse(stamp)) ? new Date(stamp).toISOString() : at();
        }
        void seedAside(ref);
      }
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
  function seed(feed: SessionFeed, provider: string, foreground = false): Promise<void> {
    if (stopped) return Promise.resolve();
    if (provider === 'kimi') {
      const { kimiTerminal, kimiChatCheckpoint, kimiNativeBinding, providerSessionId } = sessionOf(feed.ref);
      if (kimiNativeBinding !== undefined && providerSessionId !== null && KIMI_SESSION_ID.test(providerSessionId)) {
        feed.seeding ??= seedKimiNative(feed, providerSessionId, kimiNativeBinding).finally(() => { feed.seeding = undefined; });
        return feed.seeding;
      }
      const archive = kimiTerminal?.archive ?? kimiChatCheckpoint?.archive;
      return archive === undefined ? Promise.resolve() : seedKimiArchive(feed, archive, kimiTerminal === undefined);
    }
    const key = refKey(feed.ref);
    if (foreground) promoteSeed(key);
    const existing = coldReads.get(key);
    if (existing !== undefined) return existing.run.then(() => {
      // The old source still owns the cold-read slot, but may no longer own this SessionRef.
      if (existing.provider !== provider && feedCurrent(feed) && !feed.live && !feed.seeded) return seed(feed, provider, foreground);
    });
    const run = byFamily(provider, {
      claude: () => seedClaude(feed, provider, foreground),
      codex: () => seedCodex(feed, foreground),
      qwen: () => seedQwen(feed, foreground),
      opencode: () => seedOpencode(feed, foreground),
      neutral: () => Promise.resolve(),
    })();
    if (feed.seeding === undefined) return run;
    const held = run.finally(() => {
      if (coldReads.get(key)?.run === held) coldReads.delete(key);
    });
    coldReads.set(key, { provider, run: held });
    return held;
  }

  /**
   * Место в очереди посевов; ответ — функция освобождения (можно звать повторно). Освободившееся место берёт первый
   * ждущий с `foreground`, иначе первый по порядку; после `stop()` места не ждут.
   */
  function seedSlot(key: string, foreground: boolean): Promise<() => void> {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      seedRunning -= 1;
      while (seedRunning < FEED_SEED_CONCURRENCY && seedWaiters.length > 0) {
        const index = seedWaiters.findIndex((waiter) => waiter.foreground);
        seedWaiters.splice(index === -1 ? 0 : index, 1)[0]?.start();
      }
    };
    return new Promise((resolve) => {
      const start = (): void => {
        seedRunning += 1;
        resolve(release);
      };
      if (stopped || (seedRunning < FEED_SEED_CONCURRENCY && seedWaiters.length === 0)) start();
      else seedWaiters.push({ key, foreground, start });
    });
  }

  /** Снимок для окна поднимает уже ждущий в очереди посев той же ленты. */
  function promoteSeed(key: string): void {
    for (const waiter of seedWaiters) if (waiter.key === key) waiter.foreground = true;
  }

  function seedClaude(feed: SessionFeed, provider: string, foreground: boolean): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    const file = isClaudeCode(provider) ? deps.activity.logFile(feed.ref) : null;
    if (file === null) return Promise.resolve();
    const proof = captureProgress(feed);
    const key = refKey(feed.ref);
    feed.seeding = (async () => {
      const release = await seedSlot(key, foreground);
      try {
        if (feed.live || !feedCurrent(feed)) return;
        const journal = await (options.readMailJournal ?? readMailJournal)(feed.ref);
        const grown = await readFeedTail(file, 'root', journal);
        if (grown === null || feed.live || !feedCurrent(feed)) return;
        const seeded = closeBrokenTurn(grown);
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
        release();
        feed.seeded = true;
        feed.seeding = undefined;
      }
    })();
    return feed.seeding;
  }

  /** Сев ленты Codex из журнала сессии; потом — журналы её агентов. Хвост остаётся для опроса. */
  function seedCodex(feed: SessionFeed, foreground = false): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    const file = deps.activity.logFile(feed.ref);
    if (file === null) return Promise.resolve();
    const proof = captureProgress(feed);
    const binding = sessionOf(feed.ref).providerSessionId;
    const seedBinding = { providerSessionId: typeof binding === 'string' && binding.length > 0 ? binding : null, file };
    // Привязка сменилась, пока журнал читался: прочитанное принадлежит прежнему журналу, сев повторяется.
    let stale = false;
    const run = (async () => {
      const release = await seedSlot(refKey(feed.ref), foreground);
      try {
        if (!feedCurrent(feed)) return;
        const tail = createRolloutTail(file);
        const records = await tail.read();
        if (!feedCurrent(feed)) return;
        if (codexRebound(feed, seedBinding)) {
          stale = true;
          return;
        }
        const seeded = feedFromCodexRollout(stashCodex(records), { limit: maxItems });
        // Ход, оборванный в журнале, закрывается только без живого процесса: у живого он ещё идёт
        // (рестарт хоста — процесс умер с ним).
        let replayed = seeded.state;
        if (deps.pty.get(feed.ref) === undefined) {
          const followUps = replayed.items.filter(isCodexFollowUp).filter(card => card.state === 'pending');
          if (followUps.length) replayed = settleCards(replayed, 'stale', at(), followUps.map(card => card.cardId)).state;
          replayed = closeBrokenTurn(replayed);
        }
        // Журнал не содержит карточек по экрану: сохраняем их вместе с id, уже показанными в Chat.
        const terminalCards = feed.state.items.filter((item) => isCard(item) && 'via' in item && item.via === 'terminal' && !isCodexFollowUp(item));
        const state = terminalCards.length === 0 ? replayed : {
          ...replayed,
          items: [...replayed.items, ...terminalCards],
          seq: Math.max(replayed.seq, feed.state.seq),
        };
        feed.state = state;
        feed.codex = {
          tail, cursor: seeded.cursor, agents: new Map(), queue: Promise.resolve(),
          progressBinding: typeof binding === 'string' && binding.length > 0 ? { providerSessionId: binding, file } : null,
          progressBindingValid: typeof binding === 'string' && binding.length > 0,
          seedBinding,
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
        release();
        feed.seeded = true;
        feed.seeding = undefined;
      }
      if (feedCurrent(feed)) await serialCodex(feed, () => syncCodexAgents(feed));
    })();
    feed.seeding = run.then(() => (stale && feedCurrent(feed) ? seedCodex(feed, foreground) : undefined));
    return feed.seeding;
  }

  /**
   * Qwen Code seed: the transcript the log index trusts for the session (its `sessionId` and `cwd` match the binding),
   * parsed by the A4 parser. The tail stays for polling. A transcript the index does not know yet seeds nothing; the next
   * poll or hook tries again. The Chat view of Qwen has no permission cards: the terminal answers approvals.
   */
  function seedQwen(feed: SessionFeed, foreground = false): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    const file = deps.activity.logFile(feed.ref);
    if (file === null) return Promise.resolve();
    feed.seeding = (async () => {
      const release = await seedSlot(refKey(feed.ref), foreground);
      try {
        if (!feedCurrent(feed)) return;
        const tail = createQwenTail(file);
        const records = await tail.read();
        if (!feedCurrent(feed)) return;
        const seeded = feedFromQwenTranscript(records, { limit: maxItems });
        // A turn left open by the transcript is closed only without a live process (a host restart killed it with the host).
        const state = deps.pty.get(feed.ref) === undefined ? closeBrokenTurn(seeded.state) : closedByQwenStop(feed, seeded.state);
        // A transcript seed can finish after the native dialog has opened or been answered.
        const cards = feed.state.items.filter(item => isCard(item) && item.id.startsWith('qwen-dialog:'));
        feed.state = cards.length ? { ...state, items: [...state.items, ...cards].sort((a, b) => a.at.localeCompare(b.at)) } : state;
        feed.qwen = { tail, cursor: seeded.cursor, queue: Promise.resolve() };
        feed.sizes = new Map();
        feed.bytes = 0;
        for (const item of feed.state.items) {
          const size = itemBytes(item);
          feed.sizes.set(item.id, size);
          feed.bytes += size;
        }
        trim(feed, false);
        setDecisions(feed, cards.some(isPendingCard) ? 'window' : 'terminal');
        if (seeded.cursor.skipped > 0) {
          log.info('qwen feed: unknown transcript records skipped', { sessionId: feed.ref.sessionId, skipped: seeded.cursor.skipped });
        }
      } catch (error) {
        log.warn('qwen feed: transcript not read', { sessionId: feed.ref.sessionId, error: String(error) });
      } finally {
        release();
        feed.seeded = true;
        feed.seeding = undefined;
      }
    })();
    return feed.seeding;
  }

  /** The session is bound to another transcript than the one the feed was seeded from: seed again. */
  async function reseedQwenIfRebound(feed: SessionFeed): Promise<void> {
    const qwen = feed.qwen;
    if (qwen === undefined || feed.seeding !== undefined) return;
    const file = deps.activity.logFile(feed.ref);
    if (file === null || file === qwen.tail.file) return;
    feed.state = emptyFeedState();
    feed.sizes = new Map();
    feed.bytes = 0;
    delete feed.qwen;
    for (const clients of [subscribers.get(refKey(feed.ref))]) {
      if (clients !== undefined && clients.size > 0) feed.modeChanged = true;
    }
    await seedQwen(feed);
  }

  /** The turn the transcript leaves open is closed by the recorded end of the turn, unless a newer prompt followed it. */
  function closedByQwenStop(feed: SessionFeed, state: FeedState): FeedState {
    const stoppedAt = feed.qwenStoppedAt;
    if (stoppedAt === undefined || !turnActive(state.items)) return state;
    const prompt = state.items.findLast((item) => item.kind === 'prompt');
    if (prompt !== undefined && prompt.at > stoppedAt) return state;
    return closeFeedTurn(state, stoppedAt).state;
  }

  function closeQwenTurn(feed: SessionFeed): void {
    const closed = closedByQwenStop(feed, feed.state);
    if (closed !== feed.state) commit(feed, closeFeedTurn(feed.state, feed.qwenStoppedAt ?? at()));
  }

  /** New transcript records of a Qwen session go into the feed. */
  function pollQwen(feed: SessionFeed): Promise<void> {
    const qwen = feed.qwen;
    if (qwen === undefined) return Promise.resolve();
    const run = qwen.queue.then(async () => {
      if (!feedCurrent(feed) || feed.qwen !== qwen) return;
      const records = await qwen.tail.read();
      // The feed was seeded again from another transcript while the tail read: these records are foreign.
      if (!feedCurrent(feed) || feed.qwen !== qwen) return;
      if (records.length === 0) {
        closeQwenTurn(feed);
        return;
      }
      const { update, cursor } = applyQwenRecords(feed.state, records, qwen.cursor);
      qwen.cursor = cursor;
      commit(feed, update);
      closeQwenTurn(feed);
    });
    qwen.queue = run.catch(() => {});
    return run;
  }

  /**
   * Сессия привязана к другому треду или журналу, чем тот, из которого посеяна лента. Догадка по папке и
   * времени могла отдать чужой тред; доказательство MCP потом его исправило, а лента осталась на чужом журнале.
   * Лента, посеянная из привязки, при снятой привязке (`null`) или неизвестном индексу журнале тоже
   * перепосеяна: она пуста и ждёт нового журнала. Лента без привязки при неизвестном журнале остаётся как есть.
   */
  function codexRebound(feed: SessionFeed, seed: { providerSessionId: string | null; file: string }): boolean {
    let session: WorkSession;
    try { session = sessionOf(feed.ref); } catch { return false; }
    const file = deps.activity.logFile(feed.ref);
    const id = session.providerSessionId;
    const bound = typeof id === 'string' && id.length > 0;
    if (seed.providerSessionId !== null && (!bound || file === null)) return true;
    if (file === null) return false;
    return file !== seed.file || (bound && seed.providerSessionId !== null && id !== seed.providerSessionId);
  }

  /**
   * Лента Codex посеяна из другого треда или журнала, чем сессия привязана сейчас: прежние элементы
   * уходят подписчикам в `removed`, хвост создаётся заново и читает только новый журнал с начала.
   */
  async function reseedCodexIfRebound(feed: SessionFeed): Promise<void> {
    const codex = feed.codex;
    // Идущий сев сам проверит привязку, когда дочитает.
    if (codex === undefined || feed.seeding !== undefined || !codexRebound(feed, codex.seedBinding)) return;
    const before = feed.state;
    invalidateProgress(feed);
    const waiting = before.items.filter(isPendingCard).map((card) => card.cardId);
    if (waiting.length > 0) pending.settle(feed.ref, waiting);
    feed.batch.upsert.clear();
    for (const item of before.items) feed.batch.removed.add(item.id);
    feed.state = emptyFeedState();
    delete feed.codex;
    feed.sizes = new Map();
    feed.bytes = 0;
    feed.seeded = false;
    await seedCodex(feed);
    if (!feedCurrent(feed)) return;
    for (const item of feed.state.items) {
      feed.batch.upsert.set(item.id, item);
      feed.batch.removed.delete(item.id);
    }
    if (feed.state.permissionMode !== before.permissionMode) feed.modeChanged = true;
    flush(feed);
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
      // Лента пересеяна на другой журнал, пока хвост читал: его записи чужие.
      if (!feedCurrent(feed) || feed.codex !== codex) return;
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
      if (!feedCurrent(feed) || feed.codex !== codex) return;
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

  /** The OpenCode session id Parley gave the session (`ses_<uuid>`); `null` before the first launch. */
  function opencodeSessionId(ref: SessionRef): string | null {
    const id = sessionOf(ref).providerSessionId;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /**
   * OpenCode seed: a running server first (its messages are the truth and refresh the cache), else Parley's cache, which
   * keeps the Chat of a closed session or of a restarted host. With neither the feed is empty and the next poll fills it.
   */
  function seedOpencode(feed: SessionFeed, foreground = false): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    feed.seeding = (async () => {
      const release = await seedSlot(refKey(feed.ref), foreground);
      try {
        if (!feedCurrent(feed)) return;
        const id = opencodeSessionId(feed.ref);
        const address = options.opencodeServer?.(feed.ref);
        const live = address !== undefined && id !== null ? await fetchOpencodeMessages(address, id, opencodeFetch) : null;
        const messages = live?.messages ?? (await readOpencodeCache(feed.ref)) ?? [];
        if (!feedCurrent(feed)) return;
        const seeded = feedFromOpencodeMessages(messages, { limit: maxItems });
        // Without a server nothing of the last turn is running any more: an open turn is a broken one.
        const state = live === null ? closeBrokenTurn(seeded.state) : seeded.state;
        feed.state = state;
        feed.opencode = { cursor: seeded.cursor, digest: live?.digest ?? null, queue: Promise.resolve() };
        feed.sizes = new Map();
        feed.bytes = 0;
        for (const item of state.items) {
          const size = itemBytes(item);
          feed.sizes.set(item.id, size);
          feed.bytes += size;
        }
        trim(feed, false);
        setDecisions(feed, 'terminal');
        if (live !== null) await writeOpencodeCache(feed.ref, live.messages, now()).catch(cacheFailed(feed.ref));
        if (seeded.cursor.skipped > 0) log.info('opencode feed: unknown messages skipped', { sessionId: feed.ref.sessionId, skipped: seeded.cursor.skipped });
      } catch (error) {
        log.warn('opencode feed: messages not read', { sessionId: feed.ref.sessionId, error: String(error) });
      } finally {
        release();
        feed.seeded = true;
        feed.seeding = undefined;
      }
    })();
    return feed.seeding;
  }

  const cacheFailed = (ref: SessionRef) => (error: unknown): void => {
    log.warn('opencode feed: cache not written', { sessionId: ref.sessionId, error: String(error) });
  };

  /** New messages of an OpenCode session go into the feed and the cache. One poll at a time; a poll in flight is joined. */
  function pollOpencode(feed: SessionFeed): Promise<void> {
    const opencode = feed.opencode;
    if (opencode === undefined) return Promise.resolve();
    const run = opencode.queue.then(async () => {
      if (!feedCurrent(feed) || feed.opencode !== opencode) return;
      const address = options.opencodeServer?.(feed.ref);
      const id = opencodeSessionId(feed.ref);
      if (address === undefined || id === null) return;
      const fetched = await fetchOpencodeMessages(address, id, opencodeFetch);
      if (fetched === null || !feedCurrent(feed) || feed.opencode !== opencode || fetched.digest === opencode.digest) return;
      opencode.digest = fetched.digest;
      const { update, cursor } = applyOpencodeMessages(feed.state, fetched.messages, opencode.cursor);
      opencode.cursor = cursor;
      commit(feed, update);
      await writeOpencodeCache(feed.ref, fetched.messages, now()).catch(cacheFailed(feed.ref));
    });
    opencode.queue = run.catch(() => {});
    return run;
  }

  function endQwenWait(feed: SessionFeed, outcome: 'elsewhere' | 'stale'): void {
    const wait = feed.qwenWait;
    if (!wait) return;
    clearInterval(wait.watch);
    delete feed.qwenWait;
    if (wait.prompt && feedCurrent(feed)) {
      settle(feed.ref, outcome, [wait.prompt.card.id]);
      setDecisions(feed, 'terminal');
    }
  }

  const unsubscribeQwenStatus = deps.pty.on('program-status', (ref, status) => {
    const kind = status.state === 'blocked' ? status.kind : null;
    if (kind !== 'question' && kind !== 'permission') {
      const feed = feeds.get(refKey(ref));
      if (feed) endQwenWait(feed, 'elsewhere');
      return;
    }
    const feed = feedOf(ref, 'qwen');
    const pid = deps.pty.get(ref)?.pid;
    if (pid === undefined || feed.provider === undefined || !byFamily(feed.provider, { claude: false, codex: false, qwen: true, opencode: false, neutral: false })) return;
    if (feed.qwenWait?.pid === pid && feed.qwenWait.kind === kind) return;
    endQwenWait(feed, 'elsewhere');
    function refresh(): void {
      const wait = feed.qwenWait;
      if (!wait || wait.answering || !feedCurrent(feed) || deps.pty.get(ref)?.pid !== pid) return;
      const parsed = recogniseQwenPrompt(deps.pty.screenText(ref) ?? [], wait.kind, '', at());
      // When someone is typing a custom answer in the terminal, leave its editor in their hands.
      const next = parsed?.card.kind === 'question' && !parsed.review && !parsed.folderTrust && parsed.rows.at(-1)?.selected ? null : parsed;
      const revision = next?.folderTrust ? deps.pty.get(ref)?.rawInputRevision?.() : undefined;
      if (next?.fingerprint === wait.prompt?.fingerprint && revision === wait.rawRevision) return;
      if (revision === undefined) delete wait.rawRevision;
      else wait.rawRevision = revision;
      if (wait.prompt) settle(ref, 'elsewhere', [wait.prompt.card.id]);
      wait.prompt = next;
      if (!next) {
        setDecisions(feed, 'terminal');
        return;
      }
      // The next question may arrive under the same OSC wait. Its card gets its own decision identity.
      const cardId = 'qwen-dialog:' + randomUUID();
      next.card = { ...next.card, id: cardId, cardId };
      commit(feed, { state: { ...feed.state, items: [...feed.state.items, next.card] }, changes: [next.card] });
      setDecisions(feed, 'window');
    }
    const watch = setInterval(refresh, terminalWatchMs);
    watch.unref();
    feed.qwenWait = { kind, pid, watch, prompt: null, answering: false };
    refresh();
  });

  async function decideQwen(feed: SessionFeed, prompt: QwenPrompt, decision: FeedDecision): Promise<Result<'feed.decide'>> {
    const wait = feed.qwenWait!;
    if (wait.answering) return { applied: false, state: 'pending' };
    const current = () => feedCurrent(feed) && feed.qwenWait === wait && wait.prompt === prompt &&
      deps.pty.get(feed.ref)?.pid === wait.pid && (!prompt.folderTrust || deps.pty.get(feed.ref)?.rawInputRevision?.() === wait.rawRevision);
    wait.answering = true;
    try {
      const applied = await answerQwenPrompt(prompt, decision, {
        current,
        screen: () => deps.pty.screenText(feed.ref),
        write: keys => deps.pty.write(feed.ref, keys),
      });
      if (!applied || !current()) return { applied: false, state: 'pending' };
      const reviewAnswer = decision.kind === 'question' ? decision.values?.answer : undefined;
      const recorded = (prompt.review || prompt.folderTrust) && prompt.card.kind === 'question' && decision.kind === 'question' && typeof reviewAnswer === 'string'
        ? { ...decision, answers: { [prompt.card.questions[0]!.question]: reviewAnswer } } : decision;
      const result = applyDecision(feed.state, prompt.card.id, recorded, at());
      commit(feed, result);
      const next = result.changes.find(isCard);
      return { applied: result.applied, state: next?.state ?? 'pending' };
    } finally {
      wait.answering = false;
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
  async function readTranscript(
    file: string,
    maxBytes?: number,
  ): Promise<{ records: RawRecord[]; size: number } | null> {
    if (!path.isAbsolute(file) || !insideRoots(file, roots())) return null;
    let size: number;
    try {
      const info = await lstat(file);
      if (!info.isFile()) return null;
      size = info.size;
    } catch {
      return null;
    }
    return { records: await readRecords(file, maxBytes), size };
  }

  /**
   * Лента из хвоста журнала Claude (сессии или субагента): сначала `seedTailBytes`, потом вдвое больше, пока не
   * выполнено одно из трёх — хвост накрыл файл, набрано `SEED_RECORD_WINDOW` записей или лента после редьюсера
   * дошла до `maxItems` либо `maxBytes`. В первых двух случаях результат равен чтению файла целиком, в третьем
   * могут отличаться только самые старые элементы у края хвоста. `null` — читать нельзя (см. `readTranscript`).
   */
  async function readFeedTail(file: string, context: 'root' | 'child' = 'root', mailJournal?: readonly MailJournalEntry[]): Promise<FeedState | null> {
    let bytes = seedTailBytes;
    for (;;) {
      const read = await readTranscript(file, bytes);
      if (read === null) return null;
      const state = feedFromTranscript(stashClaude(read.records), { limit: maxItems, context, ...(mailJournal === undefined ? {} : { mailJournal }) });
      if (bytes >= read.size || read.records.length >= SEED_RECORD_WINDOW || state.items.length >= maxItems) return state;
      let total = 0;
      for (const item of state.items) {
        total += itemBytes(item);
        if (total >= maxBytes) return state;
      }
      bytes *= 2;
    }
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
    if (session === undefined) throw new HostError('not_found', hostText('noSession', { sessionId: ref.sessionId }));
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
    if (stopped || feeds.get(refKey(feed.ref)) !== feed) return false;
    try {
      const current = sessionOf(feed.ref).provider;
      feed.awaitingRegistration = false;
      return current === feed.provider;
    } catch {
      return feed.awaitingRegistration;
    }
  }

  function invalidateProgress(feed: SessionFeed): void {
    feed.progressEpoch?.eligible.clear();
    feed.progressEpoch = null;
    feed.sourceGeneration += 1;
    clearProgress(refKey(feed.ref));
  }

  function confirmStart(ref: SessionRef): boolean {
    const start = progressStarts.get(refKey(ref));
    if (start === undefined || start.confirmed) return true;
    const handle = deps.pty.get(ref);
    if (handle === undefined || handle.pid !== start.pid) return false;
    try {
      const session = sessionOf(ref);
      if (session.pid !== start.pid || typeof session.startedAtProcess !== 'string' || session.startedAtProcess.length === 0 ||
          session.startedAtProcess === start.previousStartedAt) return false;
      start.confirmed = true;
      return true;
    } catch { return false; }
  }

  function observeSource(feed: SessionFeed): SourceStamp | null {
    let stamp = confirmStart(feed.ref) ? sourceOf(feed.ref) : null;
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
        await reseedCodexIfRebound(known);
        await pollCodex(known);
        flush(known);
        return;
      }
    } else if (provider !== undefined && byFamily(provider, { claude: false, codex: false, qwen: true, opencode: false, neutral: false })) {
      const known = feedOf(ref);
      if (known.qwen !== undefined) {
        await reseedQwenIfRebound(known);
        await pollQwen(known);
        flush(known);
        return;
      }
    } else if (provider !== undefined && byFamily(provider, { claude: false, codex: false, qwen: false, opencode: true, neutral: false })) {
      const known = feedOf(ref);
      if (known.opencode !== undefined) {
        await pollOpencode(known);
        flush(known);
        return;
      }
    } else if (!isClaudeCode(provider)) return;
    const feed = feedOf(ref);
    if (feed.live || feed.seeded || feed.seeding !== undefined) return;
    const before = feed.state;
    await seed(feed, provider);
    if (!feedCurrent(feed) || feed.live || feed.state === before) return;
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
      new HostError('not_found', hostText('noTranscript', { agentId }));
    if (!SAFE_AGENT_ID.test(agentId)) throw notFound();
    // Providers without a feed transcript reader must not fall through to the Claude layout.
    const provider = sessionOf(ref).provider;
    if (provider === 'kimi' || byFamily(provider, { claude: false, codex: false, qwen: true, opencode: true, neutral: false })) throw notFound();
    if (provider === 'codex') {
      const file = deps.activity.childLogFile(ref, agentId);
      if (file === null) throw notFound();
      const records = await createRolloutTail(file).read();
      const meta = codexAgentMeta(records);
      const { state } = feedFromCodexRollout(stashCodex(records), {
        limit: maxItems,
        historyStart: meta.historyStart,
        context: 'child',
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
    const state = await readFeedTail(file, 'child');
    if (state === null) throw notFound();
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
    if (!stopped) {
      const need = value.activity.need?.kind;
      const waitingForPrompt = need === 'startup' || (activity === 'blocked' && (need === 'approval' || need === 'question'));
      if (waitingForPrompt && isCodexSession(ref)) {
        const scope = need === 'startup' ? 'startup' : 'turn';
        if (terminalEligible.has(key) && terminalEligible.get(key) !== scope) {
          clearTerminalTimer(terminalFinders, key, 'interval');
          closeTerminalPrompt(ref, 'elsewhere');
        }
        terminalEligible.set(key, scope);
        findTerminalPrompt(ref);
      } else {
        // Сессия перестала ждать (или ждёт не этого): идущий поиск снят, ждущая карточка — ответили в терминале.
        terminalEligible.delete(key);
        clearTerminalTimer(terminalFinders, key, 'interval');
        if (terminalPrompts.has(key)) closeTerminalPrompt(ref, 'elsewhere');
      }
    }
    if (stopped || activity !== 'idle' || previous === 'idle') return;
    const feed = feeds.get(key);
    if (feed === undefined) return;
    // У Codex запрос одобрения идёт из ячейки code mode, а она живёт дольше хода и приглашения: снятая карточка
    // отдала бы хуку `{}`, Codex ушёл бы в окно TUI, и `exec` ждал бы там без срока (разбор 2026-10-16).
    try {
      const provider = sessionOf(feed.ref).provider;
      // Kimi's ACP pending set is authoritative even if activity goes idle.
      if (provider === 'codex' || provider === 'kimi') return;
      // Qwen Code has no feed cards to settle (approvals are answered in the terminal). Its journal going idle ends the turn.
      if (byFamily(provider, { claude: false, codex: false, qwen: true, opencode: false, neutral: false })) {
        if (turnActive(feed.state.items)) {
          feed.qwenStoppedAt = at();
          void seedAside(feed.ref);
        }
        return;
      }
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

  /**
   * Лента уходит из памяти: таймеры пачки и ожидания хука Codex, опрос Codex, эпоха прогресса. Работа, что уже
   * держит объект ленты (круг `checkInterrupts`, опрос Codex, отложенный `flush`), в него не пишет:
   * `commit` и `flush` сверяются с `feeds` (`feedCurrent`) и ничего не делают.
   */
  function dropFeed(key: string): void {
    const feed = feeds.get(key);
    if (feed === undefined) return;
    if (feed.timer !== undefined) clearTimeout(feed.timer);
    feed.timer = undefined;
    clearCodexGrace(feed);
    stopCodexPoll(feed);
    if (feed.qwenWait) clearInterval(feed.qwenWait.watch);
    dropTerminalState(key);
    pending.settle(feed.ref);
    feed.progressEpoch?.eligible.clear();
    feed.progressEpoch = null;
    feeds.delete(key);
  }

  /** Сессия закрыта или её работа в архиве (сессии, которой нет в работах, касается `forget`). */
  function sessionRetired(ref: SessionRef): boolean {
    const entry = deps.works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    return entry !== undefined && session !== undefined &&
      (entry.map.work.status === 'archived' || session.lifecycle === 'closed');
  }

  /**
   * Решение 5: лента уходит, если у неё нет подписчиков, удержанных хуков, живого процесса, идущего посева и
   * холодного чтения, и при этом сессия закрыта или её работа в архиве, либо лентой не пользовались
   * `FEED_IDLE_EVICT_MS`. Ленту работающей сессии (живой процесс) не трогаем никогда.
   */
  function evictable(feed: SessionFeed): 'closed' | 'idle' | null {
    const key = refKey(feed.ref);
    if ((subscribers.get(key)?.size ?? 0) > 0) return null;
    if (feed.seeding !== undefined || coldReads.has(key)) return null;
    if (deps.pty.get(feed.ref) !== undefined) return null;
    if (pending.list(feed.ref).length > 0) return null;
    if (sessionRetired(feed.ref)) return 'closed';
    return now() - feed.usedAt >= FEED_IDLE_EVICT_MS ? 'idle' : null;
  }

  function evictIfIdle(feed: SessionFeed): void {
    if (stopped || !feedCurrent(feed)) return;
    const reason = evictable(feed);
    if (reason === null) return;
    dropFeed(refKey(feed.ref));
    log.info('лента выгружена', { op: 'feed.evicted', sessionId: feed.ref.sessionId, reason });
  }

  const evictSweep = setInterval(() => {
    for (const feed of Array.from(feeds.values())) evictIfIdle(feed);
  }, FEED_EVICT_SWEEP_MS);
  evictSweep.unref();

  /** Сессии больше нет в работах: её лента, подписчики и удержанные хуки никому не нужны. */
  function forget(key: string): void {
    progressStarts.delete(key);
    dropFeed(key);
    lastActivity.delete(key);
    sentAt.delete(key);
    subscribers.delete(key);
    graceWaiting.delete(key);
    terminalEligible.delete(key);
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
    for (const key of [...feeds.keys(), ...subscribers.keys(), ...lastActivity.keys(), ...progressStarts.keys()]) {
      if (!alive.has(key)) forget(key);
    }
    for (const start of progressStarts.values()) confirmStart(start.ref);
    for (const feed of Array.from(feeds.values())) evictIfIdle(feed);
    for (const previous of Array.from(feeds.values())) {
      const feed = previous.provider === sessionOf(previous.ref).provider ? previous : feedOf(previous.ref);
      const stamp = observeSource(feed);
      if (feed.codex !== undefined) {
        codexBindingCurrent(feed, stamp);
        void reseedCodexIfRebound(feed);
      }
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
    if (previous) endQwenWait(previous, 'stale');
    let previousStartedAt = previous?.observedSource?.startedAtProcess ?? null;
    if (previousStartedAt === null) {
      try { previousStartedAt = sessionOf(ref).startedAtProcess ?? null; } catch { /* Карта ещё не прочитана. */ }
    }
    progressStarts.set(refKey(ref), { ref: { ...ref }, pid: deps.pty.get(ref)?.pid ?? null, previousStartedAt, confirmed: false });
    confirmStart(ref);
    if (previous !== undefined) invalidateProgress(previous);
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
    const exiting = feeds.get(refKey(ref));
    if (exiting) endQwenWait(exiting, 'stale');
    if (stopped) return;
    confirmStart(ref);
    // Ответа вышедшего процесса не будет: метка отправки не должна дожить до чужой пачки.
    sentAt.delete(refKey(ref));
    graceWaiting.delete(refKey(ref));
    terminalEligible.delete(refKey(ref));
    const feed = feeds.get(refKey(ref));
    if (feed === undefined) {
      pending.settle(ref);
      return;
    }
    clearCodexGrace(feed);
    dropTerminalState(refKey(ref));
    // Процесс вышел: висящим хукам `{}`, карточки — `stale` (терминал ответит уже новому процессу),
    // ход закрыт.
    const time = at();
    commit(feed, settleCards(feed.state, 'stale', time));
    pending.settle(feed.ref);
    commit(feed, closeFeedTurn(feed.state, time));
    // Процесс ушёл: лента закрытой сессии больше никому не нужна.
    evictIfIdle(feed);
  });

  /**
   * Прерывание Esc (решение 5): `Stop` не приходит, и ход в ленте остался бы открытым (Stop, Queue в
   * окне). Его видно только записью «[Request interrupted by user…]» в журнале сессии — по изменению
   * журнала хост читает его хвост у лент с идущим ходом и, найдя запись новее начала хода, закрывает
   * ход чертой `interrupted`: идущие вызовы отклонены, ждущие карточки — `elsewhere`, их хукам `{}`.
   * Из того же хвоста читаются `system/api_error`: ретраи не присылают хуков, но должны появляться
   * в живой ленте. Проверка одна за раз; пришедшее за время чтения изменение — ещё один круг. Изменение
   * журнала будит только ленты задетых им сессий (`LogChange.affects`): ключи лент ждут в очереди.
   */
  let checkingInterrupts = false;
  const interruptQueue = new Set<string>();
  async function checkInterrupts(): Promise<void> {
    // Идущий разбор доберёт и ключи, пришедшие за время чтения: очередь он разбирает, пока она не пуста.
    if (checkingInterrupts) return;
    checkingInterrupts = true;
    try {
      while (interruptQueue.size > 0) {
        const keys = Array.from(interruptQueue);
        interruptQueue.clear();
        for (const key of keys) {
          const feed = feeds.get(key);
          if (feed === undefined) continue;
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
      }
    } finally {
      checkingInterrupts = false;
    }
  }
  /** Задело ли изменение журнала сессию ленты; сессии в работах нет — не задело. */
  function touchedBy(change: LogChange, ref: SessionRef): boolean {
    try {
      return change.affects(sessionOf(ref));
    } catch {
      return false;
    }
  }
  const unsubscribeLogs = deps.activity.onLogChange((change) => {
    if (stopped) return;
    // Без аргумента (первый полный список) — все ленты; иначе только задетые.
    const woken = Array.from(feeds.values()).filter((feed) => change === undefined || touchedBy(change, feed.ref));
    for (const feed of woken) interruptQueue.add(refKey(feed.ref));
    void checkInterrupts();
    // Индекс узнал журнал позже снимка или запуска — ленты без сева сеются сейчас.
    for (const feed of woken) void seedAside(feed.ref);
  });

  async function kimiArchiveFile(ref: SessionRef, archive: string, create = false): Promise<string | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(archive)) return undefined;
    const dir = await kimiArchiveDirectory(ref.projectPath, ref.workId, ref.sessionId, create);
    return dir === undefined ? undefined : path.join(dir, `${archive}.json`);
  }

  async function readKimiArchiveItems(ref: SessionRef, archive: string): Promise<FeedItem[]> {
    const file = await kimiArchiveFile(ref, archive);
    if (file === undefined) throw new Error('Kimi archive directory is missing or unsafe');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes + 1024) throw new Error('Invalid Kimi archive file');
      const saved: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!Array.isArray(saved) || saved.length > maxItems) throw new Error('Invalid Kimi archive');
      return saved.map((item) => feedItem.parse(item));
    } finally {
      await handle.close();
    }
  }

  async function writeKimiArchiveItems(ref: SessionRef, archive: string, items: readonly FeedItem[]): Promise<void> {
    const text = JSON.stringify(items);
    if (items.length > maxItems || Buffer.byteLength(text) > maxBytes + 1024) throw oversizedKimiReplay();
    const file = await kimiArchiveFile(ref, archive, true);
    if (file === undefined) throw new HostError('conflict', 'Kimi Chat archive directory is missing or unsafe. The prior Chat is unchanged.');
    // The map can select this immutable file only after the write and flush succeed.
    await writeFile(file, text, { mode: 0o600, flag: 'wx', flush: true });
  }

  function seedKimiArchive(feed: SessionFeed, archive: string, mandatory: boolean): Promise<void> {
    if (feed.live || feed.seeded) return Promise.resolve();
    feed.seeding ??= readKimiArchive(feed, archive, mandatory).finally(() => { feed.seeding = undefined; });
    return feed.seeding;
  }

  async function readKimiArchive(feed: SessionFeed, archive: string, mandatory: boolean): Promise<void> {
    try {
      const items = await readKimiArchiveItems(feed.ref, archive);
      if (!feedCurrent(feed) || feed.live) return;
      commit(feed, { state: { ...emptyFeedState(), items, seq: kimiArchiveSequence(items) }, changes: items });
      feed.seeded = true;
    } catch (error) {
      log.warn('Kimi Chat archive could not be loaded', { ref: feed.ref, error: String(error) });
      if (mandatory) throw new HostError('conflict', 'Kimi could not read the committed Chat checkpoint.');
    }
  }

  function reduceKimi(state: FeedState, event: KimiOutput, time: string): FeedUpdate {
    if (event.kind === 'end' && event.error === undefined) {
      return closeFeedTurn(state, time, { interrupted: event.reason === 'cancelled' });
    }
    const body = event.kind === 'prompt' ? { hook_event_name: 'UserPromptSubmit', prompt: event.text }
      : event.kind === 'text' ? { hook_event_name: 'MessageDisplay', message_id: event.messageId, delta: event.text }
      : { hook_event_name: 'StopFailure', error: event.reason, last_assistant_message: event.error };
    return applyHookEvent(state, body, time);
  }

  type NativeBinding = NonNullable<WorkSession['kimiNativeBinding']>;

  async function seedKimiNative(feed: SessionFeed, id: string, binding: NativeBinding): Promise<void> {
    if (feed.live || feed.seeded) return;
    try {
      if (binding.legacyArchive !== undefined && binding.legacyProviderId === id) await readKimiArchive(feed, binding.legacyArchive, false);
      const wire = await createKimiWire({ ...binding, sessionId: id }, { snapshot: true });
      for (;;) {
        const result = await wire.read();
        if (!feedCurrent(feed) || feed.live) return;
        if (result.limitation !== undefined) nativeKimiEvent(feed, id, { kind: 'unsupported', at: now() }, true);
        for (const row of result.rows) {
          const event = projectKimiWire(row);
          if (event !== undefined) nativeKimiEvent(feed, id, event, true);
        }
        if (!result.more) break;
      }
      if (!feed.live) commit(feed, closeFeedTurn(feed.state, at(), { interrupted: true }));
    } catch {
      nativeKimiEvent(feed, id, { kind: 'unsupported', at: now() }, true);
    } finally {
      feed.seeded = true;
    }
  }

  function nativeKimiAgent(
    feed: SessionFeed,
    id: (suffix: string) => string,
    event: Extract<KimiWireEvent, { kind: 'subagent' }>,
    time: string,
    put: (item: FeedAgent) => void,
  ): void {
    const itemId = id('subagent:' + event.id);
    const item = feed.state.items.find(row => row.id === itemId);
    const old = item?.kind === 'agent' ? item : undefined;
    const elapsed = (since: string) => Date.parse(time) - Date.parse(since);
    const base: FeedAgent = {
      id: itemId, at: time, kind: 'agent', agentId: event.id, toolUseId: itemId,
      agentType: null, description: null, model: null, prompt: null, background: false,
      status: 'running', children: [], toolCount: 0,
    };
    const limit = (text: string | null): string | null => text?.slice(0, FEED_AGENT_TEXT_LIMIT) ?? null;

    if (event.phase === 'spawned') {
      // A resumed native agent emits a fresh spawn for the same ID. Only a
      // newer spawn can reopen a finished row, and old replay cannot rewind it.
      if (old?.endedAt !== undefined && elapsed(old.endedAt) <= 0) return;
      if (old?.status === 'running' && old.agentType !== null) return;
      put({
        ...base,
        toolUseId: event.toolUseId === null ? itemId : id(event.toolUseId),
        agentType: limit(event.name),
        description: limit(event.description),
        model: limit(event.model),
        background: event.background,
        ...([event.name, event.description, event.model].some(text => (text?.length ?? 0) > FEED_AGENT_TEXT_LIMIT) ? { truncated: true } : {}),
      });
    } else if (event.phase === 'started') {
      if (old === undefined) put(base);
    } else {
      if (old?.endedAt !== undefined || (old !== undefined && elapsed(old.at) < 0)) return;
      const result = event.result;
      put({
        ...(old ?? base),
        status: event.phase === 'completed' ? 'done' : 'failed',
        endedAt: time,
        ...(old === undefined ? {} : { durationMs: elapsed(old.at) }),
        ...(result === undefined ? {} : { result: result.slice(0, FEED_AGENT_TEXT_LIMIT) }),
        ...((result?.length ?? 0) > FEED_AGENT_TEXT_LIMIT ? { truncated: true } : {}),
      });
    }
  }

  function nativeKimiEvent(feed: SessionFeed, source: string, event: KimiWireEvent, historical: boolean): void {
    // Live model steps drive host activity only, never Chat history or source reconciliation.
    if (event.kind === 'working') return;
    const time = event.at > 0 ? new Date(event.at).toISOString() : at();
    let native = feed.kimiNative;
    if (native?.id !== source) {
      const legacy = native === undefined && feed.state.items.some(item => item.kind === 'prompt' || item.kind === 'text')
        ? { rows: archiveKimiTurns(feed.state.items).flatMap(({ prompt, reply }) => [
          ...(prompt === null ? [] : [{ kind: 'prompt' as const, text: prompt }]),
          ...(reply === '' ? [] : [{ kind: 'text' as const, text: reply }]),
        ]), at: 0, failed: false }
        : undefined;
      native = { id: source, seen: new Set(), ...(legacy === undefined ? {} : { legacy }) };
      feed.kimiNative = native;
    }
    const id = (suffix: string) => `kimi-native:${source}:${suffix}`;
    const marker = event.kind === 'unsupported' ? 'limitation' : event.kind === 'subagent'
      ? `${event.kind}:${event.id}:${event.phase}:${event.at}`
      : event.kind + ':' + ('id' in event ? event.id : event.at);
    if (native.seen.has(marker)) return;
    if (native.seen.size >= 32768) native.seen.delete(native.seen.values().next().value!);
    native.seen.add(marker);

    const put = (item: FeedItem, move = false): void => {
      const items = feed.state.items;
      const old = items.findIndex(candidate => candidate.id === item.id);
      if (move) feed.batch.upsert.delete(item.id);
      const next = old < 0 ? [...items, item] : move ? [...items.toSpliced(old, 1), item] : items.toSpliced(old, 1, item);
      commit(feed, { state: { ...feed.state, items: next }, changes: [item] });
    };
    // Lifecycle does not depend on aligning old Chat text with the native wire.
    if (event.kind === 'subagent') {
      nativeKimiAgent(feed, id, event, time, put);
      return;
    }

    // An old archive is kept intact. Suppress only a positively matched wire prefix.
    // If it cannot be aligned, omit the ambiguous historical suffix and show the limitation.
    const legacy = native.legacy;
    if (legacy !== undefined) {
      if (historical && (legacy.failed || legacy.rows.length > 0)) {
        if (legacy.failed || (event.kind !== 'prompt' && event.kind !== 'text')) return;
        const row = legacy.rows[0];
        if (row?.kind === event.kind && (event.kind === 'prompt' ? row.text === event.text
            : row.text.startsWith(event.text, legacy.at))) {
          legacy.at += event.text.length;
          if (legacy.at >= row.text.length) { legacy.rows.shift(); legacy.at = 0; }
          return;
        }
        legacy.failed = true;
        nativeKimiEvent(feed, source, { kind: 'unsupported', at: event.at }, false);
        return;
      }
      if (!historical) {
        delete native.legacy;
        if (legacy.failed || legacy.rows.length > 0) nativeKimiEvent(feed, source, { kind: 'unsupported', at: event.at }, false);
      }
    }
    if (event.kind === 'prompt' || event.kind === 'steer') {
      const promptId = id('prompt:' + event.id);
      const previous = feed.state.items.find(item => item.id === promptId);
      const steered = previous?.kind === 'prompt' && previous.steered === true;
      if (event.kind === 'steer') {
        if (previous === undefined) put({ kind: 'prompt', id: promptId, at: time, text: event.text, images: 0, steered: true });
        return;
      }
      // A matching append inside the active turn is only a second record for the
      // same steer. If Kimi instead materializes it in a new turn, keep the id
      // and move the one visible row to the actual turn boundary.
      if (previous !== undefined && (!steered || feed.state.turnStartedAt !== null)) return;
      const began = settleCards(feed.state, 'stale', time);
      commit(feed, { ...began, state: { ...began.state, turnStartedAt: time } });
      put({ kind: 'prompt', id: promptId, at: time, text: event.text, images: 0 }, steered);
    } else if (event.kind === 'text') {
      put(newText(id('text:' + event.id), time, id(event.id), event.text, false));
    } else if (event.kind === 'tool') {
      put(newTool(id(event.id), event.name, kimiRecord(event.input) ?? {}, time, null));
    } else if (event.kind === 'result') {
      const tool = feed.state.items.find(item => item.kind === 'tool' && item.toolUseId === id(event.id));
      if (tool?.kind === 'tool') put(finishTool(tool, event.isError ? 'failed' : 'done', event.output, time));
    } else if (event.kind === 'end') {
      commit(feed, closeFeedTurn(feed.state, time, { interrupted: event.reason !== 'completed' }));
    } else if (event.kind === 'resolved') {
      const cardId = `kimi:${event.id}`;
      const answer = kimiRecord(event.response);
      const value = answer?.decision;
      const answers = kimiRecord(answer?.answers);
      if (typeof value === 'string' && /^(approved|rejected)/.test(value)) {
        commit(feed, applyDecision(feed.state, cardId, { kind: 'permission', behavior: value.startsWith('approved') ? 'allow' : 'deny' }, time));
      } else if (answers !== undefined && Object.values(answers).every(value => typeof value === 'string')) {
        commit(feed, applyDecision(feed.state, cardId, { kind: 'question', answers: answers as Record<string, string> }, time));
      } else commit(feed, settleCards(feed.state, 'elsewhere', time, [cardId]));
    } else if (event.kind === 'compact-start' || event.kind === 'compact') {
      put({ kind: 'notice', id: id(marker), at: time, notice: { type: 'compact', phase: event.kind === 'compact' ? 'post' : 'pre', trigger: null } });
    } else if (event.kind === 'undo' || event.kind === 'clear' || event.kind === 'unsupported') {
      const message = event.kind === 'unsupported' ? 'Kimi history could not be fully projected. Prior Chat is preserved. See Terminal for the native history.'
        : `Kimi changed its context (${event.kind}). Prior Chat messages are kept as history.`;
      put({ kind: 'error', id: id(marker), at: time, error: 'kimi-native-history', message });
    }
  }

  type KimiTextTurn = { prompt: string | null; reply: string };
  type ArchivedKimiTurn = KimiTextTurn & { replyTruncated: boolean; items: FeedItem[] };
  const KIMI_AMBIGUOUS_REPLAY = 'kimi-replay-ambiguous';
  const ambiguousKimiReplay = () => new HostError('conflict', 'Kimi history does not identify separate prompts. The prior Chat is unchanged.', { reason: KIMI_AMBIGUOUS_REPLAY });
  const oversizedKimiReplay = () => new HostError('conflict', 'Kimi history exceeds the Chat handback limit. The prior Chat is unchanged.');

  function archiveKimiTurns(items: readonly FeedItem[]): ArchivedKimiTurn[] {
    const turns: ArchivedKimiTurn[] = [];
    let turn: ArchivedKimiTurn | undefined;
    for (const item of items) {
      if (item.kind === 'mail') continue;
      if (turn === undefined || item.kind === 'prompt') {
        turn = { prompt: item.kind === 'prompt' ? item.text : null, reply: '', replyTruncated: false, items: [] };
        turns.push(turn);
      }
      turn.items.push(item);
      if (item.kind === 'text') {
        turn.reply += item.text;
        turn.replyTruncated ||= item.truncated === true;
      }
    }
    return turns;
  }

  function matchesKimiReply(prior: ArchivedKimiTurn, reply: string): boolean {
    // The archive holds the reducer's display projection, not the full provider reply.
    return prior.reply === reply.slice(0, FEED_TEXT_LIMIT) && prior.replyTruncated === (reply.length > FEED_TEXT_LIMIT);
  }

  function legacyKimiPrompts(chunks: readonly KimiReplayChunk[], archive: readonly ArchivedKimiTurn[], offset: number): string[] {
    if (chunks.length === 1) return [chunks[0]!.text];
    const prompts: string[] = [];
    let cursor = 0;
    while (cursor < chunks.length) {
      const previous = archive[offset + prompts.length];
      if (previous?.prompt == null) throw ambiguousKimiReplay();
      let text = '';
      do {
        text += chunks[cursor++]!.text;
      } while (cursor < chunks.length && text !== previous.prompt && previous.prompt.startsWith(text));
      // Only a known prompt with no reply can be followed by another prompt in this run.
      if (text !== previous.prompt || (cursor < chunks.length && previous.reply !== '')) throw ambiguousKimiReplay();
      prompts.push(text);
    }
    return prompts;
  }

  function kimiReplayPrompts(user: readonly KimiReplayChunk[], archive: readonly ArchivedKimiTurn[], offset: number, seenIds: Set<string>): (string | null)[] {
    if (user.length === 0) return [null];
    // ACP v1 makes messageId optional. Use archive boundaries only while the earlier turns still align.
    if (!user.some((chunk) => chunk.messageId !== undefined)) return legacyKimiPrompts(user, archive, offset);
    const prompts: string[] = [];
    let priorId: string | undefined;
    for (const { text, messageId } of user) {
      if (messageId === undefined) throw ambiguousKimiReplay();
      if (messageId === priorId) prompts[prompts.length - 1] += text;
      else {
        if (seenIds.has(messageId)) throw ambiguousKimiReplay();
        seenIds.add(messageId);
        prompts.push(text);
        priorId = messageId;
      }
    }
    return prompts;
  }

  function reconcileKimiTurns(chunks: readonly KimiReplayChunk[], archive: readonly ArchivedKimiTurn[]): {
    retained: FeedItem[];
    suffix: KimiTextTurn[];
    matched: number;
    failure: HostError | undefined;
  } {
    const retained: FeedItem[] = [];
    const suffix: KimiTextTurn[] = [];
    const seenIds = new Set<string>();
    let matched = 0;
    let cursor = 0;
    let failure: HostError | undefined;
    while (cursor < chunks.length) {
      const start = cursor;
      while (chunks[cursor]?.author === 'user') cursor++;
      const user = chunks.slice(start, cursor);
      let reply = '';
      while (chunks[cursor]?.author === 'agent') reply += chunks[cursor++]!.text;
      let prompts: (string | null)[];
      try {
        prompts = kimiReplayPrompts(user, archive, suffix.length === 0 ? matched : archive.length, seenIds);
        if (prompts.some((prompt) => prompt !== null && prompt.length > 64 * 1024)) throw oversizedKimiReplay();
      } catch (error) {
        if (!(error instanceof HostError) || error.code !== 'conflict') throw error;
        failure = error;
        break;
      }
      for (const [index, prompt] of prompts.entries()) {
        const turn = { prompt, reply: index === prompts.length - 1 ? reply : '' };
        const prior = suffix.length === 0 ? archive[matched] : undefined;
        if (prior !== undefined && prior.prompt === turn.prompt && matchesKimiReply(prior, turn.reply)) {
          retained.push(...prior.items);
          matched++;
        } else suffix.push(turn);
      }
    }
    return { retained, suffix, matched, failure };
  }

  function kimiArchiveSequence(items: readonly FeedItem[]): number {
    return items.reduce((max, { id }) => {
      const value = Number(/:#(\d+)$/.exec(id)?.[1]);
      return Number.isSafeInteger(value) ? Math.max(max, value) : max;
    }, 0);
  }

  return {
    onHook,
    kimiHasHistory(ref) {
      return feeds.get(refKey(ref))?.state.items.some((item) => item.kind === 'prompt' || item.kind === 'text') ?? false;
    },
    kimiArchive(ref, archive) {
      const items = feeds.get(refKey(ref))?.state.items ?? [];
      return writeKimiArchiveItems(ref, archive, items);
    },
    async kimiRemoveArchive(ref, archive) {
      const file = await kimiArchiveFile(ref, archive);
      if (file !== undefined) await rm(file, { force: true });
    },
    async kimiPruneArchives(ref, retain) {
      const directory = () => kimiArchiveDirectory(ref.projectPath, ref.workId, ref.sessionId);
      const dir = await directory();
      if (dir === undefined || retain.length === 0) return;
      const keep = new Set(retain.map((id) => `${id}.json`));
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name) && !keep.has(entry.name)) {
          if (await directory() !== dir) return;
          await rm(path.join(dir, entry.name), { force: true });
        }
      }
    },
    kimiSeedCheckpoint(ref, archive) {
      return seedKimiArchive(feedOf(ref, 'kimi'), archive, true);
    },
    async kimiPrepareHistory(ref, archive, chunks, replay) {
      const feed = feedOf(ref, 'kimi');
      const evidence = await readKimiArchiveItems(ref, archive).catch(() => {
        throw new HostError('conflict', 'Kimi could not read the prior Chat archive. The prior Chat is unchanged.');
      });
      const preferLive = replay.kind === 'checkpoint';
      const liveTurns = feed.state.items.filter((item) => item.kind !== 'mail');
      const history = preferLive && feed.live && evidence.filter((item) => item.kind !== 'mail').every(({ id }, i) => liveTurns[i]?.id === id)
        ? feed.state.items : evidence;
      const archived = archiveKimiTurns(history);
      let reconciled = reconcileKimiTurns(chunks, archived);
      if (reconciled.failure?.data?.['reason'] === KIMI_AMBIGUOUS_REPLAY) {
        const aligned = await withoutKimiDateContext(replay, chunks);
        if (aligned !== chunks) reconciled = reconcileKimiTurns(aligned, archived);
      }
      if (!preferLive && reconciled.failure !== undefined) throw reconciled.failure;
      // Only explicit handback may replace a divergent checkpoint. A routine resume
      // cannot append safely unless the provider's replay confirms the whole prior prefix.
      const keepPrior = preferLive && reconciled.matched !== archived.length;
      const retained = keepPrior ? history.filter((item) => item.kind !== 'mail') : reconciled.retained;
      let partial = replay.incomplete || reconciled.failure !== undefined || keepPrior;
      let state = { ...emptyFeedState(), seq: Math.max(feed.state.seq, kimiArchiveSequence(evidence)) };
      const time = at();
      const newRows: FeedItem[] = [];
      const mail = preferLive ? (feed.state.items.length === 0 ? evidence : feed.state.items).filter((item) => item.kind === 'mail') : [];
      let remainingItems = maxItems - retained.length - mail.length;
      let remainingBytes = maxBytes - [...retained, ...mail].reduce((sum, item) => sum + itemBytes(item), 0);
      for (const turn of keepPrior ? [] : reconciled.suffix) {
        let next = state;
        if (turn.prompt !== null) next = reduceKimi(next, { kind: 'prompt', text: turn.prompt }, time).state;
        if (turn.reply !== '') next = reduceKimi(next, { kind: 'text', messageId: randomUUID(), text: turn.reply }, time).state;
        next = closeFeedTurn(next, time).state;
        // ACP does not report timestamps or durations for the imported suffix.
        const added = next.items.slice(state.items.length).map((item) => item.kind === 'turn' ? { ...item, durationMs: null } : item);
        const bytes = added.reduce((sum, item) => sum + itemBytes(item), 0);
        if (added.length > remainingItems || bytes > remainingBytes) {
          if (!preferLive) throw oversizedKimiReplay();
          partial = true;
          break;
        }
        remainingItems -= added.length;
        remainingBytes -= bytes;
        newRows.push(...added);
        state = next;
      }
      const current = () => feed.provider === 'kimi' && feedCurrent(feed);
      function check(): void {
        if (!current()) {
          throw new HostError('conflict', 'The Kimi Chat source changed during handback');
        }
      }
      function projectItems(before: readonly FeedItem[]): FeedItem[] {
        const basis = before.length === 0 ? evidence : before;
        const priorTurns = basis.filter((item) => item.kind !== 'mail');
        const keptIds = new Set(retained.map(({ id }) => id));
        return retained.every(({ id }, i) => priorTurns[i]?.id === id)
          ? [...basis.filter((item) => item.kind === 'mail' || keptIds.has(item.id)), ...newRows]
          : [...retained, ...basis.filter((item) => item.kind === 'mail'), ...newRows];
      }
      let staged: FeedItem[] | undefined;
      async function writeCheckpoint(id: string): Promise<void> {
        check();
        const rows = projectItems(feed.state.items);
        if (rows.length > maxItems || rows.reduce((sum, item) => sum + itemBytes(item), 0) > maxBytes) throw oversizedKimiReplay();
        await writeKimiArchiveItems(ref, id, rows);
        staged = rows;
      }
      function publish(): void {
        if (!current()) return;
        const before = feed.state.items;
        const items = staged ?? projectItems(before);
        let unchanged = 0;
        while (unchanged < before.length && unchanged < items.length && before[unchanged] === items[unchanged]) unchanged++;
        feed.live = true;
        feed.seeded = true;
        if (unchanged < before.length) {
          // Clients upsert in place, then remove. Publish the changed suffix in two deltas so
          // surviving rows that move keep their IDs and order. Pending changes still go first.
          flush(feed);
          for (const { id } of before.slice(unchanged)) {
            feed.batch.removed.add(id);
            feed.bytes -= feed.sizes.get(id) ?? 0;
            feed.sizes.delete(id);
          }
          flush(feed);
        }
        commit(feed, {
          state: { ...state, items, permissionMode: feed.state.permissionMode },
          changes: items.slice(unchanged),
        });
        flush(feed);
      }
      return { partial, check, writeCheckpoint, publish };
    },
    kimiOutput(ref, event) {
      if (stopped) return;
      const feed = feedOf(ref, 'kimi');
      if (feed.provider !== 'kimi') return;
      feed.live = true;
      commit(feed, reduceKimi(feed.state, event, at()));
    },
    kimiRequests(ref, requests) {
      if (stopped || options.kimiRespond === undefined) return;
      const feed = requests.length === 0 ? feeds.get(refKey(ref)) : feedOf(ref, 'kimi');
      if (feed?.provider !== 'kimi' || !feedCurrent(feed)) return;
      feed.live = true;
      setDecisions(feed, 'window');
      const live = (feed.kimiInteractions ??= new Map());
      const ids = new Set(requests.map((request) => request.id));
      const removed: string[] = [];
      for (const [id, interaction] of live) {
        if (ids.has(interaction.request.id)) continue;
        live.delete(id);
        removed.push(id);
      }
      const time = at();
      const settled = settleCards(feed.state, 'stale', time, removed);
      const added = requests.flatMap((request) => {
        const id = `kimi:${request.id}`;
        if (live.has(id)) return [];
        const interaction = kimiInteraction(request, time);
        if (interaction === undefined) return [];
        live.set(id, interaction);
        return [interaction.card];
      });
      if (added.length === 0 && settled.changes.length === 0) return;
      commit(feed, {
        state: { ...settled.state, items: [...settled.state.items, ...added] },
        changes: [...settled.changes, ...added],
      });
    },
    kimiNativeEvent(ref, source, event, historical = false) {
      if (stopped || event.kind === 'working') return;
      const feed = feedOf(ref, 'kimi');
      if (feed.provider !== 'kimi') return;
      feed.live = true;
      nativeKimiEvent(feed, source, event, historical);
    },
    kimiNativeStartupFailed(ref, generation, message) {
      if (stopped) return;
      const feed = feedOf(ref, 'kimi');
      const item: FeedItem = { kind: 'error', id: `kimi-startup:${generation}`, at: at(), error: 'kimi-native-startup',
        message: message ?? 'Kimi could not confirm Always Ask. Startup input is blocked. Stop and resume this session to retry.' };
      if (feed.provider !== 'kimi' || feed.state.items.some(row => row.id === item.id)) return;
      commit(feed, { state: { ...feed.state, items: [...feed.state.items, item] }, changes: [item] });
    },
    kimiNativeReset(ref, sameId) {
      const feed = feeds.get(refKey(ref));
      if (feed === undefined || feed.provider !== 'kimi') return;
      commit(feed, settleCards(feed.state, 'stale', at()));
      if (!sameId) commit(feed, closeFeedTurn(feed.state, at(), { interrupted: true }));
      setDecisions(feed, 'terminal');
    },
    kimiNativeRequests(ref, requests, unresolved) {
      if (stopped) return;
      const feed = unresolved || requests.length ? feedOf(ref, 'kimi') : feeds.get(refKey(ref));
      if (feed?.provider !== 'kimi') return;
      setDecisions(feed, requests.length > 0 ? 'window' : 'terminal');
      const ids = new Set(requests.map(request => `kimi:${request.id}`));
      // A native screen can change before the wire commits its resolution. Keep the card
      // pending (Terminal-only while unrecognized) rather than losing the authoritative outcome.
      const gone = feed.state.items.filter(item => isPendingCard(item) && item.id.startsWith('kimi:') && !ids.has(item.id) &&
        (!unresolved || item.id.startsWith('kimi:folder-trust:'))).map(item => item.id);
      const settled = settleCards(feed.state, 'stale', at(), gone);
      const added = requests.flatMap(request => {
        if (settled.state.items.some(item => item.id === `kimi:${request.id}`)) return [];
        const interaction = kimiInteraction(request, at());
        return interaction === undefined ? [] : [interaction.card];
      });
      if (added.length || settled.changes.length) commit(feed, {
        state: { ...settled.state, items: [...settled.state.items, ...added] }, changes: [...settled.changes, ...added],
      });
    },
    opencodePoll(ref) {
      const feed = feeds.get(refKey(ref));
      if (stopped || feed === undefined || feed.opencode === undefined) return Promise.resolve();
      return pollOpencode(feed).then(() => flush(feed));
    },
    async opencodeLastPoll(ref, server) {
      try {
        const id = opencodeSessionId(ref);
        if (id === null) return;
        const feed = feeds.get(refKey(ref));
        const fetched = await fetchOpencodeMessages(server, id, opencodeFetch);
        if (fetched === null) return;
        // A feed in memory takes the same answer; the cache is written either way (the Chat may be closed).
        if (feed?.opencode !== undefined && feed.opencode.digest !== fetched.digest && feedCurrent(feed)) {
          feed.opencode.digest = fetched.digest;
          const { update, cursor } = applyOpencodeMessages(feed.state, fetched.messages, feed.opencode.cursor);
          feed.opencode.cursor = cursor;
          commit(feed, update);
          flush(feed);
        }
        await writeOpencodeCache(ref, fetched.messages, now());
      } catch (error) {
        cacheFailed(ref)(error);
      }
    },
    delivered(ref, text, at) {
      if (stopped) return;
      const mail = mailFromInline(text, at);
      if (mail === null) return;
      const feed = feedOf(ref);
      if (feed.state.items.some((item) => item.id === mail.id)) return;
      commit(feed, { state: { ...feed.state, items: [...feed.state.items, mail] }, changes: [mail] });
    },

    async progress(ref, client) {
      const parsed = sessionRef.safeParse(ref);
      if (!parsed.success) throw new HostError('bad_request', hostText('invalidSessionRef'));
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
        throw new HostError('conflict', hostText('progressRateLimit'), {
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

    snapshot: async function readSnapshot(ref, agentId, scope, client) {
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
        await seed(feed, session.provider, scope === undefined);
        seedMs = Math.round(performance.now() - seedStartedAt);
      } else if (feed.opencode !== undefined) {
        // OpenCode has no hooks: a snapshot of a seeded feed first takes what the server has by now.
        await pollOpencode(feed);
      }
      // A provider takeover can replace the source while this snapshot is awaiting the previous cold read.
      if (!stopped && !feedCurrent(feed)) return readSnapshot(ref, agentId, scope, client);
      // Накопленная пачка уходит до снимка: следующая дельта подписчику — ровно `revision + 1`.
      flush(feed);
      const decisions = presentedDecisions(feed);
      const snapshot: FeedSnapshot = {
        items: scope === 'attention' ? attentionItems(feed.state.items) : mailFor(client, feed.state.items),
        revision: feed.revision,
        schemaVersion: FEED_SCHEMA_VERSION,
        mode: feed.state.permissionMode,
        ...(decisions === null ? {} : { decisions }),
      };
      // Лёгкий опрос острова (`scope: 'attention'`) раз в 15 с не пишется: строка нужна для разбора
      // медленных снимков — с севом или от 250 мс она остаётся.
      const totalMs = Math.round(performance.now() - startedAt);
      if (scope !== 'attention' || seedMs !== null || totalMs >= 250) {
        log.info('лента: снимок', {
          sessionId: ref.sessionId,
          workId: ref.workId,
          items: snapshot.items.length,
          bytes: feed.bytes,
          scope: scope ?? null,
          sentBytes: scope === 'attention' ? Buffer.byteLength(JSON.stringify(snapshot.items)) : feed.bytes,
          seedMs,
          totalMs,
        });
      }
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
      const subscribed = sessionOf(ref).provider;
      if (!stopped && (subscribed === 'codex' || byFamily(subscribed, { claude: false, codex: false, qwen: true, opencode: true, neutral: false }))) startCodexPoll(feedOf(ref));
    },

    unsubscribe(ref, client) {
      const key = refKey(ref);
      const clients = subscribers.get(key);
      clients?.delete(client);
      if (clients?.size === 0) subscribersGone(key);
    },

    dropClient(client) {
      progressClients.get(client)?.active?.cancel();
      progressClients.delete(client);
      removeSubscriptions(client);
    },

    peekAttention(ref) {
      const feed = feeds.get(refKey(ref));
      // Ленты нет в памяти — карточек нет: их держит только живой хук, а с ним лента не выгружается (`evictable`).
      if (!feed) return [];
      if (!feedCurrent(feed) || (!feed.live && !feed.seeded) || feed.seeding) return undefined;
      const current = sourceOf(ref);
      if (feed.observedSource === null ? current !== null : !sameSource(feed.observedSource, current)) return undefined;
      return feed.state.items.filter(isPendingCard) as FeedCard[];
    },

    subscriberCount() {
      let count = 0;
      for (const clients of subscribers.values()) count += clients.size;
      return count;
    },

    decide(ref, cardId, decision) {
      if (options.kimiBlocksChat?.(ref)) throw new HostError('conflict', 'Kimi Chat is read-only while Terminal has control');
      const feed = feeds.get(refKey(ref));
      const card = feed?.state.items.find((item) => isCard(item) && item.cardId === cardId);
      if (feed === undefined || card === undefined || !isCard(card)) {
        throw new HostError('not_found', hostText('cardMissing', { cardId }));
      }
      const current: FeedCardState = card.state;
      if (current !== 'pending') return { applied: false, state: current };
      if (options.kimiNativeDecide !== undefined && feed.provider === 'kimi' && cardId.startsWith('kimi:')) {
        const result = options.kimiNativeDecide(ref, cardId.slice(5), decision);
        // A startup decision precedes the wire session, so no wire event can settle this card.
        if (card.kind !== 'question' || !cardId.startsWith('kimi:folder-trust:') || decision.kind !== 'question') return result;
        return result.then(outcome => {
          const question = card.questions[0]!.question;
          const answer = decision.values?.answer ?? decision.answers[question];
          if (outcome.applied && typeof answer === 'string' && feedCurrent(feed)) {
            const update = applyDecision(feed.state, cardId, { kind: 'question', answers: { [question]: answer } }, at());
            if (update.applied) commit(feed, update);
          }
          return outcome;
        });
      }
      if (isCodexFollowUp(card)) return decideCodexFollowUp(feed, card, decision);
      const qwen = feed.qwenWait?.prompt;
      if (qwen?.card.id === cardId) return decideQwen(feed, qwen, decision);
      const interaction = feed.kimiInteractions?.get(cardId);
      if (interaction !== undefined && options.kimiRespond !== undefined) {
        const answer = interaction.answer(decision);
        if (answer === undefined) return { applied: false, state: current };
        const time = at();
        // The transport publishes its new pending set synchronously while responding.
        // Unlink this card first so that publication does not mark a valid answer stale.
        feed.kimiInteractions?.delete(cardId);
        try {
          options.kimiRespond(feed.ref, interaction.request.id, answer.response);
        } catch (error) {
          commit(feed, settleCards(feed.state, 'stale', time, [cardId]));
          throw error;
        }
        const result = applyDecision(feed.state, cardId, answer.decision, time);
        commit(feed, result);
        const next = result.changes.find((item): item is FeedCard => isCard(item) && item.cardId === cardId);
        return { applied: result.applied, state: next?.state ?? current };
      }
      // Решение без удержанного хука ушло бы в никуда: карточка в окне сказала бы «allowed», а CLI
      // ничего не получил. Такое решение не применяется (окно повторит, когда хук дойдёт).
      const held = pending.get(feed.ref, cardId);
      if (held === undefined) {
        // Карточка по вопросу терминала Codex: хука нет, клавишу вводит хост.
        const record = terminalPrompts.get(refKey(feed.ref));
        if (record !== undefined && record.cardId === cardId) return decideTerminalPrompt(feed, record, decision, current);
        return { applied: false, state: current };
      }
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
      if (options.kimiBlocksChat?.(ref)) throw new HostError('conflict', 'Use the Kimi Terminal to interrupt the native process');
      const handle = deps.pty.get(ref);
      if (handle === undefined) throw new HostError('not_found', hostText('sessionNotRunning'));
      deps.pty.write(ref, ESC);
      // У Codex приглашения `❯` и возвращённого в поле промпта нет: ход закроет запись `turn_aborted`.
      // Qwen Code: no `❯` prompt check as Claude's; the next transcript record or hook settles the turn.
      if (sessionOf(ref).provider === 'kimi' || sessionOf(ref).provider === 'codex' || byFamily(sessionOf(ref).provider, { claude: false, codex: false, qwen: true, opencode: true, neutral: false })) return;
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
      progressStarts.clear();
      for (const state of progressClients.values()) state.active?.cancel();
      progressClients.clear();
      unsubscribeQwenStatus();
      unsubscribeActivity();
      unsubscribeStart();
      unsubscribeExit();
      unsubscribeWorks();
      unsubscribeLogs();
      clearInterval(imageSweep);
      clearInterval(evictSweep);
      // Ждущие посевы запускаются и сразу выходят (`stopped`): снимок, ждавший место, завершается пустой лентой.
      for (const waiter of seedWaiters.splice(0)) waiter.start();
      // До снятия таймеров лент: возврат `decisions` ставит пачку дельты.
      for (const key of new Set([...terminalFinders.keys(), ...terminalConfirms.keys(), ...terminalPrompts.keys(), ...terminalMessages.keys(), ...terminalTyping.keys()])) dropTerminalState(key);
      for (const feed of feeds.values()) {
        if (feed.qwenWait) clearInterval(feed.qwenWait.watch);
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
