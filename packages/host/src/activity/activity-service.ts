/**
 * Живая активность сессий хоста: точка статуса и строка метрик, которые раньше
 * считал TUI (`use-activity.ts`, `use-log-index.ts`, `use-map-sync.ts`,
 * `use-session-link.ts`), здесь без React — свёртку по-прежнему делает core
 * (`activityOf`), сервис только подписывается и рассылает `activity.changed`
 * (дизайн TUI v2, 4.2, 4.3, 5.1).
 *
 * Опроса нет: пересчёт идёт по событиям наблюдателей (журнал хуков, лог
 * провайдера, список работ), по одному таймеру на сессию — на момент, когда
 * истечёт порог тишины, если сессия сейчас `working`, — и по дочитыванию
 * журналов после новых наблюдателей (`watch-settle`). Планового `setInterval`
 * в файле нет и не должно быть (приёмка куска 1.5).
 */

import { latestAgentPlan } from '@parley/core/agent-plan';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BACKGROUND_HOLD_MS,
  PARLEY_STARTUP_NOTIFICATION,
  PERMISSION_ANSWERED_EVENT,
  TERMINAL_WORKING_EVENT,
  activityOf,
  claudeProjectRoots,
  applyAutoTitle,
  autoTitleOf,
  bareEvent,
  clampDetail,
  codexFailureError,
  envValue,
  isNewLabel,
  isPointerText,
  isUntitledWork,
  linkSession,
  loadConfig,
  legacyUsage,
  openEvents,
  pickResetsAt,
  resetPointerLabel,
  selectUsage,
  sessionTag,
  unreadCount,
  watchEvents,
  workPaths,
  type Activity,
  type ContextFill,
  type ActivityLog,
  type EventRecord,
  type EventsLog,
  type EventsWatcher,
  type MetricsRoots,
  type ResetGuess,
  type SessionActivity,
  type SessionIndex,
  type SessionNeed,
  type TimelineReader,
  type UsageResolver,
  type UsageSummary,
  type WorkEntry,
  type WorkSession,
} from '@parley/core';
import {
  refKey,
  type EventData,
  type LiveMetrics,
  type MailWait,
  type LiveTask,
  type SessionRef,
} from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { WindowCounters } from '../health/window-counters.js';
import type { LimitsService } from '../limits/limits-service.js';
import type { CodexSignal } from '../pty/codex-terminal.js';
import { createSettler } from '../watch-settle.js';
import type { WorksService, WorksView } from '../works/works-service.js';
import { contextView, type CompactionTrack } from '../compaction/context-view.js';
import { createLogIndex, type LogChange, type LogIndex } from './log-index.js';
import { readSubagentMeta, type SubagentMeta } from './subagent-meta.js';

export interface SessionLive {
  activity: SessionActivity;
  metrics: LiveMetrics | null;
}

/**
 * `claudeRoot`/`codexRoot` — сверх интерфейса плана: без них индекс логов в
 * тестах читал бы настоящий `~/.claude`. Реестр `MetricsRoots` уже используется
 * этим же корнем данных в `work/metrics.ts` и `work/launch.ts` — свой велосипед
 * заводить незачем.
 */
export interface ActivityServiceOptions extends MetricsRoots {
  /** Чтение логов для шкал расхода — подмена для тестов. */
  timelineReader?: TimelineReader;
  /** Счётчики окна строки состояния: каждый `recompute` сессии — одна запись. */
  windowCounters?: WindowCounters;
  silenceThresholdMs?: number;
  /** Предел удержания фоновыми субагентами и ожиданием `wait_for` (`activityOf`); по умолчанию — час. */
  backgroundHoldMs?: number;
  /**
   * Чтение `meta.json` субагента — сверх интерфейса плана: тест подставляет читателя-счётчика и видит, что и
   * когда спросили. По умолчанию — `readSubagentMeta`.
   */
  readSubagentMeta?: (transcriptPath: string, agentId: string) => Promise<SubagentMeta | null>;
  /** Сессия в worktree без единого хука дольше этого срока — `trust-wait` (спека 8.2, план 4.2). */
  trustWaitMs?: number;
  /**
   * Codex не показал ни `Ready`, ни `Working` за этот срок после запуска процесса — он стоит на экране
   * входа или доверия к папке, и сессии «нужен ты» (спека комнат, 3.6, «Экраны старта»).
   */
  startupWaitMs?: number;
  /** Запас сверх ожидания вызова code mode Codex, после которого сессия «нужен ты» (`CODEX_CALL_GRACE_MS`). */
  codexCallGraceMs?: number;
  /**
   * Служба лимитов хоста: время сброса лимита берётся у неё раньше, чем из текста ошибки (спека «Застрявшие сессии»,
   * 3.4), а у GLM без окна квоту перечитывает `refresh(true)`. Без неё — только текст ошибки.
   */
  limits?: Pick<LimitsService, 'get' | 'refresh'>;
  now?: () => number;
}

export interface ActivityService {
  start(): Promise<void>;
  get(ref: SessionRef): SessionLive | undefined;
  /**
   * Журнал сессии у провайдера по индексу логов (лента вида «Chat» сеет из него историю); `null` —
   * сессии нет, `providerSessionId` ещё не известен или индекс журнала не знает.
   */
  logFile(ref: SessionRef): string | null;
  /** Журнал субагента Codex по id его треда; не найден — null. */
  childLogFile(ref: SessionRef, threadId: string): string | null;
  /** Файлы журналов сессии Codex: основной и субагентов; не Codex или журнала нет — []. */
  codexLogFiles(ref: SessionRef): string[];
  /** Перечитать журнал Codex в индексе логов (`codex-log-poll.ts`). */
  reindexLog(file: string): Promise<void>;
  /** Следить за корнем истории Claude Code своего провайдера (спека своих провайдеров 5.6); идемпотентно. */
  watchClaudeRoot(root: string): void;
  /** Пользователь смотрел на сессию: `pty.attach` и `pty.input` (1.6). */
  markSeen(ref: SessionRef, at?: string): void;
  onChange(listener: (ref: SessionRef, value: SessionLive) => void): () => void;
  /** Текущая активность всех сессий, которые держит сервис, — повтор для нового клиента. */
  current(): Array<EventData<'activity.changed'>>;
  /**
   * Состояние сессии codex по его терминалу, а не по хукам (спека комнат, 3.6): хуков Codex харнесс не
   * включает. Запущен процесс — прежние сигналы забыты и идёт срок экранов старта.
   */
  terminalStarted(ref: SessionRef): void;
  /** Сигнал терминала Codex (`pty/codex-terminal.ts`): заголовок окна или уведомление OSC 9. */
  terminalSignal(ref: SessionRef, signal: CodexSignal): void;
  /**
   * Процесс вышел: состояние по терминалу больше не действует, сессия снова читается по журналу и логу; запись о запуске
   * (`processStarted`) снята.
   */
  terminalStopped(ref: SessionRef): void;
  /**
   * Хост запустил процесс агента, не Codex (у Codex — `terminalStarted`): от этого запуска считаются срок экрана старта
   * и «новые» строки журнала (спека «Застрявшие сессии», 3.2). У возобновлённой сессии журнал прошлого запуска не пуст, и
   * экран старта ловится по тому, что с запуска нынешнего процесса ничего не прибавилось.
   */
  processStarted(ref: SessionRef): void;
  /**
   * План 2026-10-01, кусок 4a, решение О: окно держит вопрос агента (хук `PreToolUse`) — сессия
   * 'blocked', пока хук не отпущен: журнал событий удержанного вопроса не видит и по тишине считал бы её
   * idle. Таймер тишины и метрики при этом считаются по настоящему значению. Публикуемое `blocked` несёт `need`
   * вида `question`: `detail` — текст первого вопроса, `since` — момент удержания.
   */
  questionHeld(ref: SessionRef, held: boolean, detail?: string | null): void;
  /**
   * На запрос разрешения (`PermissionRequest`) ответили — в окне или в терминале. Хука «разрешили» у Claude
   * Code нет, а запись пользователя ложится в лог лишь после конца одобренного инструмента, и сессия до
   * тех пор числилась бы `blocked`. Дописывает в журнал сессии отметку `ParleyPermissionAnswered`;
   * пересчитает наблюдатель журнала. Best-effort: каталога `events/` нет (сессия без хуков) или диск
   * не пишет — молча ничего.
   */
  permissionAnswered(ref: SessionRef): void;
  /**
   * Почему письма сессии ещё не забраны (причина будильника) — уходит окну в `LiveMetrics.mailWaiting`:
   * комната пишет её рядом с «not picked up yet». `null` — писем нет.
   */
  mailWaiting(ref: SessionRef, reason: MailWait | null): void;
  /** Заполненность контекста (`ContextService`: Claude/GLM — файл строки статуса, Codex — хвост rollout); `null` — нет. */
  setContext(ref: SessionRef, fill: ContextFill | null): void;
  /** Сжатие сессии (`CompactionService`): фаза просьбы и конец последнего сжатия. */
  setCompaction(ref: SessionRef, track: CompactionTrack): void;
  /**
   * Журнал какой-то сессии изменился (индекс логов; живая лента по нему ловит прерывание Esc —
   * запись «[Request interrupted by user…]», план 2026-10-01, решение 5). Возвращает отписку.
   */
  onLogChange(listener: () => void): () => void;
  /** Источник цифр итога комнаты (спека расхода токенов, 5.2): итог сессии целиком, границы её лога и срез по окнам. */
  usageResolver(): UsageResolver;
  stop(): Promise<void>;
}

const workKeyOf = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

/**
 * Неудачное чтение `meta.json` субагента повторяется не чаще: Claude пишет файл рядом со стартом, а пересчётов
 * сессии за секунду десятки (события, лог), и ждать файла — не повод ходить за ним на каждом.
 */
const META_RETRY_MS = 10_000;

/** Что известно про `meta.json` живых субагентов одной сессии. */
interface SubagentCache {
  /** Прочитанное по id задачи. */
  found: Map<string, SubagentMeta>;
  /** Когда чтение задачи не удалось в последний раз: до `META_RETRY_MS` не повторяется. */
  failedAt: Map<string, number>;
}

/** Спека 8.2: доверие к папке worktree подтверждают руками, и хук может не прийти вовсе. */
const DEFAULT_TRUST_WAIT_MS = 20_000;

/**
 * Экраны старта Codex (вход, доверие к папке, миграция модели) проходит человек, а Codex до них не
 * пишет ни заголовка `Ready`, ни `Working`. 20 секунд — с запасом на холодный старт и на MCP-сервер
 * (`startup_timeout_sec` у него 30, но заголовок не ждёт сервера); ложная тревога стоит человеку одного
 * взгляда в терминал, а не тревога — сессии, которая молча ждёт входа.
 */
const DEFAULT_STARTUP_WAIT_MS = 20_000;
/**
 * Запас сверх заявленного ожидания вызова code mode Codex (`exec`/`wait`): вызов без вывода дольше
 * `yield_time_ms` плюс этот запас считается застрявшим на запросе одобрения (разбор 2026-10-16).
 */
export const CODEX_CALL_GRACE_MS = 120_000;
/** Ожидание вызова code mode, когда оно не указано (`yieldMs === null`): по умолчанию у Codex около 30 с. */
export const CODEX_DEFAULT_YIELD_MS = 30_000;

/**
 * Рычаг E2E окна: `PARLEY_CODEX_STARTUP_MS` (и прежняя `HARNAS_CODEX_STARTUP_MS`) — срок экранов старта Codex в миллисекундах. Тест не может
 * ждать двадцать секунд, пока сессия на экране доверия станет «нужен ты». Не число, меньше 100 мс или
 * больше десяти минут — переменная игнорируется, срок остаётся по умолчанию.
 */
export function startupWaitFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = envValue(env, 'CODEX_STARTUP_MS')?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 100 && value <= 600_000 ? value : undefined;
}

/**
 * Состояние сессии codex по его терминалу: последнее известное и когда. Живёт, пока жив процесс под
 * хостом, — сигналы прошлого процесса той же сессии не переносятся.
 */
interface TerminalState {
  /** Последнее известное состояние как событие журнала; `null` — с запуска не было ни одного известного. */
  last: EventRecord | null;
  /**
   * События ожидания человека идущего эпизода — первое и первое одобрение (`episodeWith`); вне эпизода пусто.
   * Свёртке от терминала достаётся одно событие, `last`, а заголовок `Action Required` и OSC 9 об одобрении приходят
   * вместе и в любом порядке: по одному последнему начало эпизода (`since`) и вид (одобрение, а не вопрос) терялись бы.
   */
  waiting: EventRecord[];
  /** Срок экранов старта: сработает, если `last` так и останется `null`. */
  startupTimer: NodeJS.Timeout | undefined;
  /**
   * С запуска процесса был хоть один сигнал хода: работа, вопрос человеку или конец хода. До него `Ready`
   * — приглашение у ещё не начатой сессии, а не конец хода.
   */
  turnSeen: boolean;
  /** Когда запущен этот процесс, мс: ошибка хода в rollout старше него — прошлого процесса того же разговора. */
  startedAt: number;
}

/**
 * Первый `Ready` с запуска: агент у приглашения, ни один ход не кончался. `activityOf` такое событие
 * пропускает (фазу не меняет), но `lastEventAt` учитывает — хост «в курсе», и отправка из окна с
 * будильником разрешены. Иначе свежая сессия, поднятая в фоне (autoLaunch, `spawn_session`), стала бы
 * `unseen` и дала ложное «finished» ещё до первого хода. У свежей сессии Claude состояние тоже `idle`.
 */
const TERMINAL_READY_EVENT = 'TerminalReady';

/**
 * Событие журнала, которым `activityOf` читает сигнал терминала: те же имена, что у хуков Claude Code, а
 * первый `Ready` с запуска — нейтральное (`TERMINAL_READY_EVENT`). Кадр спиннера — своё имя
 * (`TERMINAL_WORKING_EVENT`): время сигнала обновляется на каждом кадре, и `UserPromptSubmit` с таким
 * временем снимал бы ожидание `wait_for` (его строку дописал MCP-сервер), хотя нового хода нет. Ожидание
 * человека — `Notification` с типом, как у Claude Code, и причина доходит до свёртки: одобрение
 * (`permission_prompt`, `message` — команда или правка) и вопрос (`agent_needs_input`) дают `approval` и
 * `question` (спека «Застрявшие сессии», 3.2).
 */
const eventOfSignal = (signal: CodexSignal, turnSeen: boolean, at: string): EventRecord | null => {
  switch (signal.kind) {
    case 'working':
      return bareEvent(at, TERMINAL_WORKING_EVENT);
    case 'ready':
      return bareEvent(at, turnSeen ? 'Stop' : TERMINAL_READY_EVENT);
    case 'turn-complete':
      return bareEvent(at, 'Stop');
    case 'needs-you':
      return signal.reason === 'approval-requested'
        ? {
            ...bareEvent(at, 'Notification'),
            notificationType: 'permission_prompt',
            message: signal.detail,
          }
        : { ...bareEvent(at, 'Notification'), notificationType: 'agent_needs_input' };
    default:
      return null;
  }
};

const isApproval = (event: EventRecord): boolean => event.notificationType === 'permission_prompt';

/**
 * Эпизод ожидания человека продолжается, пока приходят сигналы `needs-you`; в нём остаются первое событие (его
 * время — `since`) и первое одобрение (вид и команда): внутри эпизода одобрение не понижается до вопроса, а
 * вопрос, за которым пришло одобрение, повышается с прежним `since` — «конкретнее — сильнее» (3.2).
 */
const episodeWith = (episode: readonly EventRecord[], event: EventRecord): EventRecord[] =>
  episode.length === 0
    ? [event]
    : isApproval(event) && !episode.some(isApproval)
      ? [...episode, event]
      : [...episode];

/** Тот же сигнал терминала: имя, вид уведомления и текст совпадают (время не в счёт). */
const sameSignal = (a: EventRecord, b: EventRecord): boolean =>
  a.name === b.name && a.notificationType === b.notificationType && a.message === b.message;

/**
 * Ход Codex, оборванный ошибкой, которая ждёт человека, — как `StopFailure` Claude Code: лимит подписки
 * (`usage_limit_exceeded`) и слетевший вход (`unauthorized`); прочее Codex повторяет сам, и `need` оно не даёт.
 * Ошибка раньше запуска нынешнего процесса принадлежит прошлому процессу того же разговора (resume) и не в счёт.
 */
function failureOf(
  turn: NonNullable<SessionIndex['lastTurnEvent']>,
  startedAt: number,
): EventRecord | null {
  if (turn.type !== 'task_complete' || turn.error === undefined) return null;
  const error = codexFailureError(turn.error.info);
  if (error === null || !(Date.parse(turn.at) >= startedAt)) return null;
  return {
    ...bareEvent(turn.at, 'StopFailure'),
    error,
    lastAssistantMessage: turn.error.message === '' ? null : turn.error.message,
  };
}

/**
 * Согласно ли выведенное состояние с последним сигналом терминала. Расходятся они, когда в свёртку
 * вмешалось чужое событие новее сигнала: `Stop` от notify с временем файла позже последнего кадра
 * спиннера или мигания `Action Required`. Следующий сигнал того же вида такое расхождение чинит.
 */
/** Предел задержки `setTimeout` в Node (2^31 − 1 мс): больше — таймер срабатывает через 1 мс. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const agreesWith = (derived: Activity | undefined, signal: CodexSignal): boolean => {
  switch (signal.kind) {
    case 'working':
      return derived === 'working';
    case 'needs-you':
      return derived === 'blocked';
    default:
      return derived !== undefined && derived !== 'working' && derived !== 'blocked';
  }
};

/** Запуск процесса агента, который видел хост: когда (мс) и сколько строк было в журнале до него. */
interface Launch {
  at: number;
  journalLength: number;
}

/**
 * Граница нового процесса у Claude и GLM: сразу за строками журнала, что были при запуске (`Launch.journalLength`),
 * ставится внутренний `SessionStart` с `source: 'startup'`. Строки до него — прошлого процесса, а свёртка узнаёт новый
 * процесс по настоящему `SessionStart`, который приходит спустя ~0,3 с, а на экране входа или доверия не приходит вовсе:
 * всё это время хвост прошлого журнала (одобрение, вопрос, лимит, вход, оборванный ход) давал бы `need`. Правило запуска
 * свёртки (`SessionStart` в `activityOf`) снимает прежнее ожидание и кончает оборванный ход, а настоящий `SessionStart`
 * потом повторит тот же переход. Граница — по позиции, а не по времени: у строк, прочитанных после записи нового процесса,
 * время одно — mtime файла. Её время — запуск процесса: новее всего прошлого, в том числе записи об ошибке API в логе, с
 * которой запасной путь лимита сверяет начало работы.
 */
function withLaunchBoundary(
  journal: readonly EventRecord[] | null,
  launch: Launch | null,
): readonly EventRecord[] | null {
  if (journal === null || launch === null) return journal;
  const boundary: EventRecord = {
    ...bareEvent(new Date(launch.at).toISOString(), 'SessionStart'),
    source: 'startup',
  };
  return [
    ...journal.slice(0, launch.journalLength),
    boundary,
    ...journal.slice(launch.journalLength),
  ];
}

/** Удержанный вопрос агента: когда окно его удержало и текст первого вопроса. */
interface HeldQuestion {
  since: string;
  detail: string | null;
}

const questionNeedOf = (held: HeldQuestion): SessionNeed => ({
  kind: 'question',
  since: held.since,
  detail: held.detail,
  resetsAt: null,
  window: null,
  account: null,
});

interface WorkWatch {
  journal: EventsLog;
  /** `null` — каталога `events/` ещё нет или наблюдение сломалось: ждём повтора. */
  watcher: EventsWatcher | null;
}

/**
 * Итог сессии целиком для комнаты (спека расхода токенов, 5.2): выбранный `selectUsage`. Лог уже есть, а ответов модели
 * в нём ещё нет — ноль, а не «нет данных» (запись в кэш у Codex не наблюдается — она неизвестна). Ни лога, ни снимка — `null`.
 */
export function wholeSessionUsage(selected: UsageSummary, hasLog: boolean, provider: string): UsageSummary | null {
  if (selected.source !== 'unavailable') return selected;
  if (!hasLog) return null;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: provider === 'codex' ? null : 0,
    totalInput: 0,
    source: 'native-index',
    observedAt: null,
    stale: false,
    completeness: 'complete',
    coverage: 'conversation',
  };
}

export function createActivityService(
  host: HostContext,
  works: WorksService,
  options: ActivityServiceOptions = {},
): ActivityService {
  const roots: MetricsRoots = {
    ...(options.claudeRoot === undefined ? {} : { claudeRoot: options.claudeRoot }),
    ...(options.codexRoot === undefined ? {} : { codexRoot: options.codexRoot }),
  };
  const nowFn = options.now ?? Date.now;
  let silenceThresholdMs = options.silenceThresholdMs ?? 30_000;
  const backgroundHoldMs = options.backgroundHoldMs ?? DEFAULT_BACKGROUND_HOLD_MS;
  const trustWaitMs = options.trustWaitMs ?? DEFAULT_TRUST_WAIT_MS;
  const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
  const codexCallGraceMs = options.codexCallGraceMs ?? CODEX_CALL_GRACE_MS;
  const limits = options.limits;

  const logIndex: LogIndex = createLogIndex(roots, options.timelineReader === undefined ? {} : { reader: options.timelineReader });
  const live = new Map<string, SessionLive>();
  /** Выведенная активность до подмены на `blocked` (вопрос, сторож): с ней сверяются сигналы терминала. */
  const derivedActivity = new Map<string, Activity>();
  /**
   * Наибольшая граница хода (`SessionActivity.turnBoundaryAt`), виденная у сессии, по ключу сессии. У Codex `eventsFor`
   * держит только последнее событие хода: `Stop` от прерывания человеком (`turn_aborted`) пропадает из потока, как только
   * начался следующий ход, и без защёлки брошенный `wait_for` увидел бы границу снятой и забрал следующее письмо.
   * Старое значение вреда не делает: вызов сравнивает его со своим временем старта.
   */
  const turnBoundaries = new Map<string, string>();
  const journals = new Map<string, readonly EventRecord[] | null>();
  const seenAt = new Map<string, string>();
  const silenceTimers = new Map<string, NodeJS.Timeout>();
  const autoTitled = new Set<string>();
  /** Сессии, чей ярлык-указатель хост уже возвращает (или вернул) к метке новой сессии (`resetPointerLabel`). */
  const pointerLabelReset = new Set<string>();
  /** Сессии, чей вопрос агента удержан окном (`questionHeld`): им публикуется `blocked` с `need` вопроса. */
  const questionHeldKeys = new Map<string, HeldQuestion>();
  /** Таймеры сторожа вызова code mode Codex по ключу сессии: срабатывают в момент, когда вызов считается застрявшим. */
  const codexCallTimers = new Map<string, NodeJS.Timeout>();
  /** Время вызова (`openCodeCall.at`), о котором сторож уже сообщил, по ключу сессии: одно уведомление на вызов. */
  const codexCallNotified = new Map<string, string>();
  /** Причина, по которой письма сессии ждут (`mailWaiting`), по ключу сессии. */
  const mailWaits = new Map<string, MailWait>();
  const contexts = new Map<string, ContextFill>();
  const compactions = new Map<string, CompactionTrack>();
  const hooksMissingNotified = new Set<string>();
  const trustWaitTimers = new Map<string, NodeJS.Timeout>();
  const trustWaitNotified = new Set<string>();
  /** Срок экрана старта у Claude и GLM (`startupEventOf`): по таймеру на сессию, чтобы пересчитать её на сроке. */
  const startupTimers = new Map<string, NodeJS.Timeout>();
  /** Запуски процессов, которые видел хост (`processStarted`), по ключу сессии: отсчёт срока и «новых» строк журнала. */
  const launches = new Map<string, Launch>();
  /**
   * Сессии GLM, у которых лимит уже вызвал перечитывание квоты Z.ai (`maybeRefreshQuota`). Ключ живёт, пока `need`
   * лимита идёт без перерыва: эпизод — это сессия плюс вид, а не точное `since` (оно сдвигается, когда индекс лога
   * догоняет журнал, а после перезапуска хоста равно времени файла).
   */
  const quotaRefreshed = new Set<string>();
  /**
   * Время сброса лимита, выбранное для идущего эпизода, по ключу сессии (`publishedNeed`): первое непустое держится до
   * конца эпизода — сессия, пока её опубликованный `need` остаётся лимитом без перерыва.
   */
  const limitResets = new Map<string, ResetGuess>();
  const linkInFlight = new Set<string>();
  const terminals = new Map<string, TerminalState>();
  const workWatches = new Map<string, WorkWatch>();
  const listeners = new Set<(ref: SessionRef, value: SessionLive) => void>();
  /**
   * `meta.json` субагентов, у которых снимок хуков не назвал описания: прочитанное и неудачи по ключу
   * сессии и id задачи. Хранится, пока задача жива, — запись ушедшей задачи снимает следующий пересчёт.
   */
  const subagentCaches = new Map<string, SubagentCache>();
  // Корни истории для `meta.json`: свой корень сервиса (тесты), иначе — где Claude Code держит историю.
  // Корни считаются при каждом чтении: папка своего провайдера может появиться уже после старта хоста (спека 5.6).
  const metaRoots = (): string[] => (options.claudeRoot === undefined ? claudeProjectRoots() : [options.claudeRoot]);
  const readMeta =
    options.readSubagentMeta ??
    ((transcriptPath: string, agentId: string) => readSubagentMeta(transcriptPath, agentId, metaRoots()));
  /** Чтения `meta.json` в полёте (ключ сессии и id задачи): одно на задачу, пока оно не вернулось. */
  const metaReads = new Set<string>();

  let stopped = false;
  let unsubscribeWorks: (() => void) | undefined;
  let unsubscribeLog: (() => void) | undefined;
  /**
   * На macOS fs.watch каталогов живёт в одном на процесс потоке FSEvents, и libuv пересоздаёт его на каждом
   * новом наблюдателе: запись, сделанная в этот миг, не доходит ни до одного наблюдателя процесса (опыт
   * 2026-10-06: 3 записи из 150, если в миг записи заводится наблюдатель другого каталога). Поэтому после
   * новых наблюдателей — своих журналов и индекса логов — перечитываются журналы всех работ, а не только той,
   * чей наблюдатель заведён.
   */
  const catchUp = createSettler(() => settleAllJournals());

  function clearSilenceTimer(key: string): void {
    const timer = silenceTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    silenceTimers.delete(key);
  }

  function clearCodexCallTimer(key: string): void {
    const timer = codexCallTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    codexCallTimers.delete(key);
  }

  function clearTrustWaitTimer(key: string): void {
    const timer = trustWaitTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    trustWaitTimers.delete(key);
  }

  function clearStartupTimer(key: string): void {
    const timer = startupTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    startupTimers.delete(key);
  }

  /** Забывает состояние терминала сессии и срок экранов старта. */
  function clearTerminal(key: string): void {
    const state = terminals.get(key);
    if (state === undefined) return;
    if (state.startupTimer !== undefined) clearTimeout(state.startupTimer);
    terminals.delete(key);
  }

  /**
   * События сессии для свёртки. У Claude Code — журнал хуков. У codex хуков нет: журнал `events/` пишет
   * только скрипт `notify` (конец хода), поэтому его отсутствие не поломка хуков, а к журналу добавляется
   * последнее известное состояние терминала — по времени, как если бы это был хук. Сессия codex — и та,
   * чей процесс под хостом (`terminals`), и та, что записана в карте как codex: снимок работ мог отстать
   * от `applyChoice`, а запуск уже знает провайдера точно. У Claude и GLM после строк прошлого запуска — граница
   * нового процесса (`withLaunchBoundary`).
   */
  function eventsFor(session: WorkSession, key: string): readonly EventRecord[] | null {
    const journal = journals.get(key) ?? null;
    const terminal = terminals.get(key);
    if (terminal === undefined && session.provider !== 'codex') {
      return withLaunchBoundary(journal, launchBoundaryOf(session, key));
    }
    let base = journal ?? [];
    const last = terminal?.last;
    if (terminal === undefined || last === null || last === undefined) return base;
    // События ожидания человека идущего эпизода идут раньше последнего сигнала (`TerminalState.waiting`).
    const signals = [...terminal.waiting.filter((event) => event !== last), last];
    // Codex может не прислать Ready/notify после ответа. Явное событие rollout
    // завершает такой ход; старый конец хода не перекрывает более новый сигнал терминала.
    const turn = logIndex.index(session)?.lastTurnEvent;
    const failure = turn === undefined ? null : failureOf(turn, terminal.startedAt);
    if (failure !== null) {
      // Ошибка, ждущая человека (лимит, вход), встаёт по своему времени всегда, а не только когда новее сигнала:
      // Codex пишет заголовок `Ready` сразу за ошибкой, и правило конца хода выше потеряло бы её.
      signals.push(failure);
    } else if (turn !== undefined && Date.parse(turn.at) >= Date.parse(last.at)) {
      signals.push(
        bareEvent(turn.at, turn.type === 'task_started' ? TERMINAL_WORKING_EVENT : 'Stop'),
      );
    }
    // Журнал идёт в порядке файла, а его время не убывает: терминальное событие встаёт после последнего
    // не более позднего — конец хода от `notify`, пришедший позже сигнала следующего хода, его не перекроет.
    for (const signal of signals) {
      const at = Date.parse(signal.at);
      let index = base.length;
      while (index > 0 && Date.parse(base[index - 1]?.at ?? '') > at) index -= 1;
      base = [...base.slice(0, index), signal, ...base.slice(index)];
    }
    return base;
  }

  /**
   * Когда запущен нынешний процесс: по метке хоста (`processStarted`), без неё — по первому запуску сессии (`startedAt`).
   * Метка точнее: у возобновлённой сессии `startedAt` остаётся прежним. `NaN` — запуск неизвестен.
   */
  const launchedAtOf = (session: WorkSession, key: string): number =>
    launches.get(key)?.at ??
    (session.startedAt === null ? Number.NaN : Date.parse(session.startedAt));

  /** Срок экрана старта: через `trustWaitMs` после запуска нынешнего процесса — тот же, что у уведомления `trust-wait`. */
  const startupDue = (session: WorkSession, key: string): number =>
    launchedAtOf(session, key) + trustWaitMs;

  /**
   * Процесс Claude или GLM поднят хостом и жив: к нему относятся запись о запуске, граница в журнале и экран старта.
   * Codex сюда не входит — у него свой срок (`startupExpired`) и своё состояние по терминалу.
   */
  function hostProcessLive(session: WorkSession, key: string): boolean {
    return (
      session.launchedBy === 'host' &&
      session.lifecycle === 'active' &&
      session.provider !== 'codex' &&
      !terminals.has(key)
    );
  }

  /**
   * Запуск нынешнего процесса, если за ним нужна граница (`withLaunchBoundary`): хост его видел (`processStarted`), а в
   * журнале есть строки прошлого запуска. `null` — границы нет: процесса нет, журнал пуст (свежая сессия: стирать нечего)
   * или стал короче записанного (его переписали, позиции не доверяем).
   */
  function launchBoundaryOf(session: WorkSession, key: string): Launch | null {
    const launch = launches.get(key);
    if (launch === undefined || launch.journalLength === 0 || !hostProcessLive(session, key)) return null;
    return (journals.get(key)?.length ?? 0) >= launch.journalLength ? launch : null;
  }

  /**
   * Ждёт ли хост первого события от Claude или GLM: процесс запущен им, жив, а строк журнала с запуска нынешнего
   * процесса не прибавилось. Без записи о запуске (`processStarted`) отсчёт идёт от пустого журнала.
   */
  function waitsForStartup(session: WorkSession, key: string): boolean {
    return (
      hostProcessLive(session, key) &&
      (journals.get(key)?.length ?? 0) === (launches.get(key)?.journalLength ?? 0)
    );
  }

  /**
   * Claude и GLM, от которых с запуска процесса не пришло ни одной новой строки журнала за `trustWaitMs`, стоят на экране
   * входа или доверия к папке: хуков оттуда нет. К событиям свёртки (не к журналу) добавляется внутреннее `Notification`
   * `parley_startup` со временем истечения срока — свёртка читает его как `need` вида `startup`. Первая же новая строка
   * снимает его совсем (`waitsForStartup`): иначе `SessionStart` после него превратил бы «нужен ты» в «закончил ход».
   * Новых строк нет, поэтому событие встаёт в самый конец — сразу за границей нового процесса, а не за хвостом прошлого.
   * Транскрипт, показавший работу после запуска, экран старта отменяет: экран входа и доверия в него не пишет, и если
   * журнал молчит оттого, что хуки не доходят (старый Claude Code, выключены), «ждёт на старте» залипло бы навсегда.
   */
  function startupEventOf(
    session: WorkSession,
    key: string,
    now: number,
    log: ActivityLog | null,
  ): EventRecord | null {
    if (!waitsForStartup(session, key)) return null;
    const due = startupDue(session, key);
    if (!(due <= now)) return null;
    if (Date.parse(log?.lastRecordAt ?? '') > launchedAtOf(session, key)) return null;
    return {
      ...bareEvent(new Date(due).toISOString(), 'Notification'),
      notificationType: PARLEY_STARTUP_NOTIFICATION,
    };
  }

  /**
   * Срок экрана старта наступает сам, без события: пересчёт на нём — один таймер на сессию. Срок, уже вышедший,
   * таймера не заводит — `startupEventOf` читает его по часам. Сессия, у которой ждать уже нечего (событие пришло,
   * процесс ушёл), таймер теряет.
   */
  function maybeStartupWait(ref: SessionRef, key: string, session: WorkSession): void {
    if (!waitsForStartup(session, key)) {
      clearStartupTimer(key);
      return;
    }
    if (startupTimers.has(key)) return;
    const delay = startupDue(session, key) - nowFn();
    if (!(delay > 0)) return;
    startupTimers.set(
      key,
      setTimeout(() => {
        startupTimers.delete(key);
        recompute(ref);
      }, delay),
    );
  }

  /**
   * Час икс — либо уже наступил (задержка 0), либо ставится единственный таймер. Время само меняет
   * состояние дважды: на пороге тишины, а у удерживаемой сессии (фоновые субагенты, ожидание `wait_for`) —
   * ещё и на пределе удержания. `now` — тот же миг, по которому `activityOf` только что вывел состояние:
   * порог пройден, а сессия всё ещё `working`, значит её держат, и ждать надо предела; пройден и он —
   * время больше ничего не изменит, и таймер не нужен, иначе он пересчитывал бы сессию с нулевой
   * задержкой без конца.
   */
  function scheduleSilenceTimer(
    ref: SessionRef,
    key: string,
    activity: SessionActivity,
    log: ActivityLog | null,
    now: number,
  ): void {
    clearSilenceTimer(key);
    if (activity.activity !== 'working') return;

    const eventAt = activity.lastEventAt === null ? Number.NaN : Date.parse(activity.lastEventAt);
    const recordAt = log?.lastRecordAt == null ? Number.NaN : Date.parse(log.lastRecordAt);
    const quietAt = Math.max(
      Number.isNaN(eventAt) ? -Infinity : eventAt,
      Number.isNaN(recordAt) ? -Infinity : recordAt,
    );
    if (!Number.isFinite(quietAt)) return;
    const silenceAt = quietAt + silenceThresholdMs;
    const holdAt = quietAt + backgroundHoldMs;
    const deadline = silenceAt >= now ? silenceAt : holdAt >= now ? holdAt : null;
    if (deadline === null) return;

    const delay = Math.max(0, deadline - nowFn());
    silenceTimers.set(
      key,
      setTimeout(() => {
        silenceTimers.delete(key);
        recompute(ref);
      }, delay),
    );
  }

  function isSeen(seenAtIso: string | undefined, turnEndedAt: string | null): boolean {
    if (seenAtIso === undefined || turnEndedAt === null) return false;
    const seenMs = Date.parse(seenAtIso);
    const endedMs = Date.parse(turnEndedAt);
    return !Number.isNaN(seenMs) && !Number.isNaN(endedMs) && seenMs >= endedMs;
  }

  /**
   * Число непрочитанного сессией — счётом по карте снимка, которую хост уже держит (`entry.map`): метрики собираются для
   * каждой сессии на каждое изменение, и из базы при числе работ больше кэша карт каждый проход грузил бы их заново
   * (спека хранилища 6.2).
   */
  const unreadOf = (entry: WorkEntry, sessionId: string): number =>
    unreadCount(entry.projectPath, entry.map.work.id, sessionId, { map: entry.map }).total;

  /**
   * Чтение `meta.json` субагента в фоне: пока оно идёт, окно видит задачу без описания. Прочитано —
   * описание кладётся в кэш сессии и сессия пересчитывается. Не нашлось — запоминается время неудачи, и
   * пересчёт не раньше чем через `META_RETRY_MS` попробует снова: Claude может записать файл чуть позже
   * старта.
   */
  function loadSubagentMeta(
    ref: SessionRef,
    key: string,
    id: string,
    transcriptPath: string,
  ): void {
    const read = `${key}\u0000${id}`;
    if (metaReads.has(read)) return;
    metaReads.add(read);
    void readMeta(transcriptPath, id)
      .then((meta) => {
        metaReads.delete(read);
        if (stopped) return;
        const cache = subagentCaches.get(key) ?? { found: new Map(), failedAt: new Map() };
        subagentCaches.set(key, cache);
        if (meta === null) {
          cache.failedAt.set(id, nowFn());
          return;
        }
        cache.failedAt.delete(id);
        cache.found.set(id, meta);
        recompute(ref);
      })
      .catch((error: unknown) => {
        metaReads.delete(read);
        host.log.error('описание субагента не применилось', { ref, id, error: String(error) });
      });
  }

  /**
   * Живые субагенты для окна. Описание из снимка хуков главнее; когда его нет, берётся `meta.json`
   * субагента (и тип агента, если он пуст): из кэша, а нет в кэше — в фоне запускается чтение (не чаще
   * раза в `META_RETRY_MS` после неудачи), и окно получит описание следующим пересчётом. Кэш `meta.json`
   * остаётся только у живых задач.
   */
  function liveTasksOf(ref: SessionRef, key: string, activity: SessionActivity): LiveTask[] {
    const cache = subagentCaches.get(key);
    const kept: SubagentCache = { found: new Map(), failedAt: new Map() };
    const tasks = activity.tasks.map((task): LiveTask => {
      let { agentType, description } = task;
      if (description === null) {
        const meta = cache?.found.get(task.id);
        if (meta !== undefined) {
          kept.found.set(task.id, meta);
          description = meta.description;
          agentType ??= meta.agentType;
        } else if (task.transcriptPath !== null) {
          const failedAt = cache?.failedAt.get(task.id);
          if (failedAt !== undefined) kept.failedAt.set(task.id, failedAt);
          if (failedAt === undefined || nowFn() - failedAt >= META_RETRY_MS) {
            loadSubagentMeta(ref, key, task.id, task.transcriptPath);
          }
        }
      }
      return { id: task.id, agentType, description, background: task.background };
    });
    if (kept.found.size === 0 && kept.failedAt.size === 0) subagentCaches.delete(key);
    else subagentCaches.set(key, kept);
    return tasks;
  }

  /**
   * Токены сессии: у идущей побеждает свежий индекс лога, а снимок из карты (его ставят `report` и усыпление) годится для
   * остановленной и как запасной, когда свежего индекса нет. Какой источник выбран, видно в `usage.source`; сумма не
   * выдумывается (`selectUsage`). Снимок чужого разговора (сессию перепривязали) за свой не принимается.
   */
  function selectedUsage(session: WorkSession): UsageSummary {
    const snapshot = session.metrics;
    const frozen =
      snapshot === null
        ? null
        : snapshot.usage === undefined
          ? legacyUsage(snapshot.tokens)
          : snapshot.usage.binding === session.providerSessionId
            ? snapshot.usage
            : null;
    return selectUsage({
      active: session.lifecycle === 'active',
      epoch: session.startedAtProcess,
      live: logIndex.usage(session) ?? null,
      frozen,
    });
  }

  function metricsFor(
    ref: SessionRef,
    key: string,
    entry: WorkEntry,
    session: WorkSession,
    activity: SessionActivity,
    indexed: SessionIndex | undefined,
  ): LiveMetrics {
    // Модель в карте не хранится никогда (work-rows.ts, sidebar.tsx).
    const snapshot = session.metrics;
    const selected = selectedUsage(session);
    const usage: UsageSummary = {
      ...selected,
      // Комнату и прогон по одной сессии не определить: сессия бывает в нескольких комнатах.
      attribution: { workId: ref.workId, sessionId: session.id, roomId: null, runId: null },
    };
    // Все провайдеры — из `ContextService`: Claude и GLM — файл строки статуса, Codex — хвост rollout.
    const fill = contexts.get(key) ?? null;
    const view = contextView(fill, compactions.get(key));
    return {
      usage,
      tokensIn: usage.input,
      tokensOut: usage.output,
      durationMs:
        usage.source === 'native-index'
          ? (indexed?.durationMs ?? snapshot?.durationMs ?? null)
          : (snapshot?.durationMs ?? indexed?.durationMs ?? null),
      unread: unreadOf(entry, session.id),
      subagents: activity.subagents,
      model: indexed?.primaryModel ?? null,
      plan: latestAgentPlan(session.agentPlan, indexed?.plan),
      tasks: liveTasksOf(ref, key, activity),
      waitingFor: activity.waitingFor,
      mailWaiting: mailWaits.get(key) ?? null,
      context: view.context,
      compaction: view.compaction,
    };
  }

  const sameLive = (a: SessionLive, b: SessionLive): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  /**
   * Заголовок Claude Code доехал до индекса логов — переименование один раз (5.1). Ярлык сессии меняется, только пока он
   * `NEW_LABEL` (карты старых сборок), название работы — пока оно `untitled`: сессия с именем безымянную работу всё
   * равно называет (спека архива комнат, раздел 14), поэтому ранний выход — когда не нужно ни то, ни другое.
   * Разговор, начатый указателем на письма, имени из лога не получает (`autoTitleOf`); ярлык-указатель, оставленный
   * прежними сборками, тогда возвращается к метке новой сессии — один раз на сессию.
   */
  function maybeAutoTitle(ref: SessionRef, key: string, session: WorkSession, workTitle: string): void {
    if (!(isNewLabel(session.label) || isUntitledWork(workTitle)) || autoTitled.has(key)) return;
    const title = autoTitleOf(logIndex.index(session));
    if (title === null) {
      if (!isPointerText(session.label) || pointerLabelReset.has(key)) return;
      pointerLabelReset.add(key);
      void resetPointerLabel(ref.projectPath, ref.workId, ref.sessionId).catch((error) => {
        pointerLabelReset.delete(key);
        host.log.error('ярлык-указатель не вернулся к метке новой сессии', { ref, error: String(error) });
      });
      return;
    }
    autoTitled.add(key);
    void applyAutoTitle(ref.projectPath, ref.workId, ref.sessionId, title).catch((error) => {
      // Не удалось записать карту — пробуем на следующем изменении.
      autoTitled.delete(key);
      host.log.error('автозаголовок не применился', { ref, error: String(error) });
    });
  }

  /** Привязка сессии к логу провайдера, который не принимает id снаружи (5). */
  function maybeLink(ref: SessionRef, key: string, session: WorkSession): void {
    if (session.providerSessionId !== null || session.startedAt === null) return;
    if (session.lifecycle !== 'active' || linkInFlight.has(key)) return;
    linkInFlight.add(key);
    void linkSession(ref.projectPath, ref.workId, session, roots)
      .catch(() => {})
      .finally(() => linkInFlight.delete(key));
  }

  /** Сессия хоста без журнала хуков — предупреждение один раз (раздел 10). */
  function maybeHooksMissing(
    ref: SessionRef,
    key: string,
    session: WorkSession,
    events: readonly EventRecord[] | null,
  ): void {
    if (session.launchedBy !== 'host' || session.lifecycle !== 'active') return;
    // Хуков Codex харнесс не включает: их отсутствие у него — норма, состояние ведёт терминал.
    if (terminals.has(key) || session.provider === 'codex') return;
    if (events !== null || hooksMissingNotified.has(key)) return;
    hooksMissingNotified.add(key);
    host.broadcast('host.notice', {
      kind: 'hooks-missing',
      ref,
      text: `Claude Code hooks did not arrive for session ${ref.sessionId} — status comes from the log`,
      at: new Date().toISOString(),
    });
  }

  /**
   * Сессия в worktree запущена, но за `trustWaitMs` ни одного хука — возможно,
   * терминал ждёт подтверждения доверия к незнакомой папке (спека 8.2). В
   * отличие от `hooks-missing` (сразу), здесь даётся срок: доверие подтверждают
   * руками, а не за долю секунды после старта процесса.
   */
  function maybeTrustWait(ref: SessionRef, key: string, session: WorkSession): void {
    if (session.worktree === null || session.launchedBy !== 'host' || session.lifecycle !== 'active') {
      clearTrustWaitTimer(key);
      return;
    }
    // Экраны старта Codex ловит свой срок (`terminalStarted`): хуков у него не будет ни в одной папке.
    if (terminals.has(key) || session.provider === 'codex') {
      clearTrustWaitTimer(key);
      return;
    }
    if (trustWaitNotified.has(key) || trustWaitTimers.has(key)) return;
    const startedAt = session.startedAt === null ? Number.NaN : Date.parse(session.startedAt);
    if (Number.isNaN(startedAt)) return;

    const delay = Math.max(0, startedAt + trustWaitMs - nowFn());
    trustWaitTimers.set(
      key,
      setTimeout(() => {
        trustWaitTimers.delete(key);
        // Хук успел прийти, пока таймер ждал, — в журнале есть событие. Именно длина, а не
        // `!== null`: каталог `events/` заводится при старте сессии, и журнал без событий
        // читается пустым массивом (раунд исправлений 1 куска 3.3).
        if ((journals.get(key)?.length ?? 0) > 0) return;
        trustWaitNotified.add(key);
        host.broadcast('host.notice', {
          kind: 'trust-wait',
          ref,
          text: `${sessionTag(ref.sessionId)} has not responded since launch — it may be waiting for folder trust`,
          at: new Date().toISOString(),
        });
      }, delay),
    );
  }

  /**
   * Codex не показал ни `Ready`, ни `Working` за `startupWaitMs` после запуска: он на экране входа или
   * доверия к папке (спека комнат, 3.6). Проходит их человек, в терминале Codex, — сессия «нужен ты»
   * (`need` вида `startup`), а причину называет уведомление хоста. Как только придёт известный сигнал,
   * состояние заменится им.
   */
  function startupExpired(ref: SessionRef, key: string, state: TerminalState): void {
    state.startupTimer = undefined;
    if (stopped || terminals.get(key) !== state || state.last !== null) return;
    const at = new Date(nowFn()).toISOString();
    state.last = {
      ...bareEvent(at, 'Notification'),
      notificationType: PARLEY_STARTUP_NOTIFICATION,
    };
    host.broadcast('host.notice', {
      kind: 'startup-wait',
      ref,
      text: `${sessionTag(ref.sessionId)} has not shown a status since launch — it may be waiting for sign-in or folder trust in the Codex terminal`,
      at,
    });
    recompute(ref);
  }

  /**
   * Пересчёт из слушателя `start` менеджера PTY (`terminalStarted`, `processStarted`): слушатели там идут без защиты, и
   * бросок оборвал бы `pty.start` уже после запуска процесса — PTY остался бы сиротой. Сбой пишется в журнал хоста, а
   * сессия досчитается на следующем событии.
   */
  function recomputeOnStart(ref: SessionRef): void {
    try {
      recompute(ref);
    } catch (error) {
      host.log.error('пересчёт активности при запуске процесса не удался', { ref, error: String(error) });
    }
  }

  function recompute(ref: SessionRef): void {
    if (stopped) return;
    const entry = works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (entry === undefined || session === undefined) return;
    options.windowCounters?.recompute();

    const key = refKey(ref);
    const now = nowFn();
    const journalEvents = eventsFor(session, key);
    // Под хостом состояние Codex ведут сигналы терминала и явные события хода из rollout (eventsFor).
    // Общая свежесть лога не годится: token_count после ответа снова вернул бы working.
    // Процесс вышел — сессия снова читается по журналу и логу, как всякая спящая.
    const driven = terminals.has(key);
    const log = driven ? null : logIndex.log(session);
    // Экран старта Claude и GLM — событие свёртки, а не журнала: настоящих строк с запуска процесса ещё нет, а работы в
    // транскрипте — тоже.
    const startup = startupEventOf(session, key, now, log);
    const events = startup === null ? journalEvents : [...(journalEvents ?? []), startup];
    // Порог тишины у такой сессии не действует: заголовок Codex пишет не весь ход (личный
    // `tui.animations=false`, долгий инструмент), а ложный конец хода — это «finished» в macOS и Enter
    // вместо Tab в идущий ход. Выход процесса известен (`terminalStopped`), конец хода — сигнал терминала
    // (`Ready`, OSC 9) или `Stop` от notify.
    const threshold = driven ? Number.POSITIVE_INFINITY : silenceThresholdMs;

    // `seen` зависит от `turnEndedAt`, а он — результат самой свёртки: первый
    // проход узнаёт его, второй считает финальную `activity` (план, кусок 1.5).
    const draft = activityOf({
      events,
      log,
      seen: false,
      now,
      silenceThresholdMs: threshold,
      backgroundHoldMs,
    });
    const seen = isSeen(seenAt.get(key), draft.turnEndedAt);
    const folded = activityOf({
      events,
      log,
      seen,
      now,
      silenceThresholdMs: threshold,
      backgroundHoldMs,
    });
    // Пока от нынешнего процесса не пришло ни одной строки, свёртка видит прошлое (журнал прошлого запуска) и то, что
    // дописал хост: границу процесса (`withLaunchBoundary`) и экран старта (`startupEventOf`). Хука нового процесса в них
    // не было, и от них не наступают ни «хост в курсе» (`hookedSince`: печатать в экран старта нельзя), ни «сессия
    // стартовала» (по ней окно выбирает вид Chat). Граница времени события не меняет — вкладка возобновлённой сессии не
    // мигает терминалом (`effectiveView`); с экраном старта человеку нужен терминал, и время скрыто совсем.
    const boundary = launchBoundaryOf(session, key);
    let lastEventAt = folded.lastEventAt;
    if (startup !== null) {
      lastEventAt = null;
    } else if (boundary !== null && (journals.get(key)?.length ?? 0) === boundary.journalLength) {
      lastEventAt = journals.get(key)?.[boundary.journalLength - 1]?.at ?? null;
    }
    // `hooksMissing` — по настоящему журналу: экран старта делает события непустыми, но хуки от этого не появились.
    const hooksMissing = journalEvents === null;
    // Граница хода только растёт (`turnBoundaries`); `null` свёртки её не снижает. Непонятное время ни ставится, ни мешает:
    // защёлка с ним уступает любому разобранному.
    const latched = turnBoundaries.get(key) ?? null;
    const nextMs = Date.parse(folded.turnBoundaryAt ?? '');
    const turnBoundaryAt =
      folded.turnBoundaryAt !== null && !Number.isNaN(nextMs) && !(Date.parse(latched ?? '') >= nextMs)
        ? folded.turnBoundaryAt
        : latched;
    if (turnBoundaryAt !== null) turnBoundaries.set(key, turnBoundaryAt);
    const activity: SessionActivity =
      lastEventAt === folded.lastEventAt && hooksMissing === folded.hooksMissing && turnBoundaryAt === folded.turnBoundaryAt
        ? folded
        : { ...folded, lastEventAt, hooksMissing, turnBoundaryAt };

    const index = logIndex.index(session);
    const metrics = metricsFor(ref, key, entry, session, activity, index);

    // Сторож Codex: долгий вызов без вывода или конец хода с ещё незавершённой ячейкой (s21).
    let codexStuck: { since: string; detail: string | null } | null = null;
    const pendingCell = driven && index?.lastTurnEvent?.type === 'task_complete' ? index.pendingCodeCell : undefined;
    const call = pendingCell === undefined
      ? driven && activity.activity === 'working' ? index?.openCodeCall : undefined
      : { at: pendingCell.at, yieldMs: 0 };
    if (call === undefined) {
      clearCodexCallTimer(key);
    } else {
      const stuckAt = pendingCell === undefined
        ? Date.parse(call.at) + (call.yieldMs ?? CODEX_DEFAULT_YIELD_MS) + codexCallGraceMs
        : now;
      if (Number.isNaN(stuckAt)) {
        clearCodexCallTimer(key);
      } else if (now >= stuckAt) {
        clearCodexCallTimer(key);
        const text = `${sessionTag(ref.sessionId)} ${pendingCell === undefined ? 'has not returned from a Codex tool call' : 'finished its turn with an unfinished tool operation'}. Check pending approvals; if already answered, stop the stuck operation and verify its effects before retrying.`;
        // Начало эпизода — время вызова (у незавершённой ячейки — её время), а не `now`: срок сторожа в ветке ячейки
        // равен «сейчас», и `since` уезжал бы на каждом пересчёте.
        // `detail` попадает в строку комнаты и письмо ведущему: он нейтральный, без указания «проверь и остановись» —
        // агент мог бы принять его за своё. Полный текст с инструкцией остаётся только в уведомлении хоста (`codex-call-wait`).
        codexStuck = {
          since: call.at,
          detail: pendingCell === undefined ? 'a Codex tool call has not returned' : 'its turn finished with an unfinished tool operation',
        };
        const noticeKey = pendingCell === undefined ? call.at : `cell:${pendingCell.id}:${pendingCell.at}`;
        if (codexCallNotified.get(key) !== noticeKey) {
          codexCallNotified.set(key, noticeKey);
          host.broadcast('host.notice', {
            kind: 'codex-call-wait',
            ref,
            text,
            at: new Date(now).toISOString(),
          });
        }
      } else {
        clearCodexCallTimer(key);
        codexCallTimers.set(
          key,
          setTimeout(() => {
            codexCallTimers.delete(key);
            recompute(ref);
          }, Math.min(stuckAt - now, MAX_TIMER_DELAY_MS)),
        );
      }
    }

    derivedActivity.set(key, activity.activity);
    // Удержанный вопрос агента или застрявший вызов: публикуется 'blocked', а таймер тишины и метрики — по настоящему
    // значению. Если свёртка и так 'blocked', её `need` (одобрение, экран старта) точнее и остаётся. Вопросу в окне
    // соответствует `need` вопроса; застрявшему вызову Codex — одобрение: сторож не знает, чего ждёт ход, но самая
    // частая причина — неотвеченный запрос к человеку, и текст его уведомления становится `detail`. `need` из
    // событий самого CLI (лимит, вход: ход ими оборван, а не стоит) главнее — они остаются, сторож к ним ничего не
    // добавляет: `blocked` с таким `need` несогласован (`reportedNeed`).
    const held = questionHeldKeys.get(key);
    const waiting: SessionActivity =
      activity.activity === 'blocked'
        ? activity
        : held !== undefined
          ? { ...activity, activity: 'blocked', need: questionNeedOf(held) }
          : codexStuck !== null && activity.need === null
            ? {
                ...activity,
                activity: 'blocked',
                need: {
                  kind: 'approval',
                  since: codexStuck.since,
                  detail: codexStuck.detail,
                  resetsAt: null,
                  window: null,
                  account: null,
                },
              }
            : activity;
    const need = publishedNeed(key, session, waiting.need, now);
    const published: SessionActivity = need === waiting.need ? waiting : { ...waiting, need };
    const value: SessionLive = { activity: published, metrics };

    if (driven) clearSilenceTimer(key);
    else scheduleSilenceTimer(ref, key, activity, log, now);

    const previous = live.get(key);
    live.set(key, value);
    if (previous === undefined || !sameLive(previous, value)) {
      host.broadcast('activity.changed', { ref, activity: published, metrics });
      for (const listener of listeners) listener(ref, value);
    }

    maybeAutoTitle(ref, key, session, entry.map.work.title);
    maybeLink(ref, key, session);
    // Журнал настоящий, без границы и экрана старта: они не должны прятать отсутствие хуков.
    maybeHooksMissing(ref, key, session, journals.get(key) ?? null);
    maybeTrustWait(ref, key, session);
    maybeStartupWait(ref, key, session);
    maybeRefreshQuota(ref, key, session, need, now);
  }

  /**
   * `need` в том виде, в каком его видят окно и службы. У спящей и закрытой сессии его нет: процесса нет, ждать человека
   * в терминале некому (спека «Застрявшие сессии», 3.1). Время сброса лимита уточняет служба лимитов (3.4): исчерпанное
   * окно провайдера главнее времени из текста ошибки, а текст — «уже сброшен». Первое непустое время держится весь
   * эпизод (та же сессия и тот же вид `need` без перерыва): «сейчас» из «уже сброшен» иначе уезжало бы на каждом
   * пересчёте (и рассылалось заново), а исчерпанное окно после сброса служба лимитов убирает, и время откатилось бы к
   * тексту или к `null`. Эпизод кончился (`need` снят, другой вид, сессия уснула) — защёлка снимается, следующий
   * выбирает время заново.
   */
  function publishedNeed(
    key: string,
    session: WorkSession,
    need: SessionNeed | null,
    now: number,
  ): SessionNeed | null {
    if (need === null || session.lifecycle !== 'active') {
      limitResets.delete(key);
      return null;
    }
    if (need.kind !== 'limit') {
      limitResets.delete(key);
      return need;
    }
    let reset = limitResets.get(key);
    if (reset === undefined) {
      const picked = pickResetsAt(need, limits?.get(session.provider) ?? null, need.since, now);
      reset = { resetsAt: picked.resetsAt, window: picked.window };
      if (reset.resetsAt !== null) limitResets.set(key, reset);
    }
    return { ...need, ...reset };
  }

  /**
   * Квоту Z.ai служба лимитов читает только по явному запросу, а время сброса берётся из неё раньше текста ошибки (3.4).
   * Поэтому, когда у GLM данные провайдера времени сброса не дали, квота перечитывается один раз за эпизод лимита, а по
   * готовности сессия пересчитывается. Эпизод — сессия, пока её `need` остаётся лимитом без перерыва: `since` тут не
   * ключ, он сдвигается, когда индекс лога догоняет журнал.
   */
  function maybeRefreshQuota(
    ref: SessionRef,
    key: string,
    session: WorkSession,
    need: SessionNeed | null,
    now: number,
  ): void {
    if (need?.kind !== 'limit') {
      quotaRefreshed.delete(key);
      return;
    }
    if (limits === undefined || session.provider !== 'glm' || quotaRefreshed.has(key)) return;
    const quota = pickResetsAt(
      { resetsAt: null, window: need.window },
      limits.get(session.provider),
      need.since,
      now,
    );
    if (quota.resetsAt !== null) return;
    quotaRefreshed.add(key);
    void limits.refresh(true).then(
      () => {
        if (!stopped) recompute(ref);
      },
      // Ключа Z.ai нет или квота не прочиталась: время сброса остаётся из текста ошибки или неизвестным.
      (error: unknown) => {
        host.log.warn('квота Z.ai не перечитана — время сброса лимита остаётся из текста ошибки', {
          ref,
          error: String(error),
        });
      },
    );
  }

  /**
   * Наблюдение за журналами работы. `renewed` — наблюдатель только что заведён:
   * всё, что хуки успели дописать до него, никто не прочёл, журналы работы
   * нужно перечитать. Дописанное, пока наблюдатель включался и пересоздавал поток
   * FSEvents, перечитает `catchUp`.
   *
   * `createWork` каталога `events/` не заводит — его создаёт запись настроек
   * при запуске сессии, а `watchEvents` на несуществующий каталог падает один
   * раз и больше не пробует. Поэтому без каталога наблюдатель не запоминается,
   * и каждое следующее изменение списка работ (запуск сессии пишет карту уже
   * после каталога) пробует снова. Сами каталог не заводим: его отсутствие —
   * признак сессии без хуков (`hooks-missing`), `openEvents` отличает его от
   * пустого журнала.
   */
  function ensureWorkWatch(entry: WorkEntry): { watch: WorkWatch; renewed: boolean } {
    const wk = workKeyOf(entry.projectPath, entry.map.work.id);
    const eventsDir = workPaths(entry.projectPath, entry.map.work.id).events;
    let watch = workWatches.get(wk);
    if (watch === undefined) {
      watch = { journal: openEvents(eventsDir), watcher: null };
      workWatches.set(wk, watch);
    }
    if (watch.watcher !== null || !existsSync(eventsDir)) return { watch, renewed: false };

    const current = watch;
    let failed = false;
    const watcher = watchEvents(
      eventsDir,
      (sessionId) =>
        void readJournal(entry.projectPath, entry.map.work.id, current.journal, sessionId),
      {
        onError: (error) => {
          host.log.warn('наблюдение за журналом активности: событие пропущено', {
            error: String(error),
          });
          // Сломавшийся наблюдатель (каталог удалили, гонка с его созданием)
          // заводится заново на следующем изменении списка работ.
          failed = true;
          if (current.watcher !== null) {
            current.watcher.close();
            current.watcher = null;
          }
        },
      },
    );
    if (failed) {
      watcher.close();
      return { watch, renewed: false };
    }
    watch.watcher = watcher;
    // Хук, дописанный в окно включения наблюдателя, теряет и он, и наблюдатели других работ: журналы
    // перечитываются ещё несколько раз.
    catchUp.schedule();
    return { watch, renewed: true };
  }

  /** Дочитывание журналов работы после включения наблюдателя: чтение без новых байт состояния не меняет. */
  function settleJournals(projectPath: string, workId: string): void {
    const current = works.entry(projectPath, workId);
    const watch = workWatches.get(workKeyOf(projectPath, workId));
    if (stopped || current === undefined || watch === undefined) return;
    for (const session of current.map.sessions) void readJournal(projectPath, workId, watch.journal, session.id);
  }

  async function readJournal(
    projectPath: string,
    workId: string,
    journal: EventsLog,
    sessionId: string,
  ): Promise<void> {
    if (stopped) return;
    const events = await journal.read(sessionId).catch(() => null);
    if (stopped) return;
    const ref: SessionRef = { projectPath, workId, sessionId };
    journals.set(refKey(ref), events);
    recompute(ref);
  }

  /**
   * Дочитывание всех журналов после новых наблюдателей (`catchUp`): иначе потерянная строка ждала бы
   * следующей записи того же журнала — у свежей сессии это первый хук, без которого хост не пускает
   * отправку из окна (`hookedSince`).
   */
  function settleAllJournals(): void {
    for (const entry of works.snapshot().entries) settleJournals(entry.projectPath, entry.map.work.id);
  }

  /** Работы и сессии, которых в свежем снимке больше нет: состояние не копится вечно. */
  function pruneRemoved(snapshot: WorksView): void {
    const validSessions = new Set<string>();
    const validWorks = new Set<string>();
    for (const entry of snapshot.entries) {
      validWorks.add(workKeyOf(entry.projectPath, entry.map.work.id));
      for (const session of entry.map.sessions) {
        validSessions.add(
          refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }),
        );
      }
    }

    for (const [wk, watch] of Array.from(workWatches)) {
      if (validWorks.has(wk)) continue;
      watch.watcher?.close();
      workWatches.delete(wk);
    }

    for (const [key] of Array.from(journals)) if (!validSessions.has(key)) journals.delete(key);
    for (const [key] of Array.from(live)) if (!validSessions.has(key)) live.delete(key);
    for (const key of Array.from(derivedActivity.keys())) if (!validSessions.has(key)) derivedActivity.delete(key);
    for (const key of Array.from(turnBoundaries.keys())) if (!validSessions.has(key)) turnBoundaries.delete(key);
    for (const [key] of Array.from(subagentCaches)) {
      if (!validSessions.has(key)) subagentCaches.delete(key);
    }
    for (const [key] of Array.from(seenAt)) if (!validSessions.has(key)) seenAt.delete(key);
    for (const key of Array.from(autoTitled)) if (!validSessions.has(key)) autoTitled.delete(key);
    for (const key of Array.from(pointerLabelReset)) if (!validSessions.has(key)) pointerLabelReset.delete(key);
    for (const key of Array.from(mailWaits.keys())) {
      if (!validSessions.has(key)) mailWaits.delete(key);
    }
    for (const key of Array.from(contexts.keys())) {
      if (!validSessions.has(key)) contexts.delete(key);
    }
    for (const key of Array.from(compactions.keys())) {
      if (!validSessions.has(key)) compactions.delete(key);
    }
    for (const key of Array.from(questionHeldKeys.keys())) {
      if (!validSessions.has(key)) questionHeldKeys.delete(key);
    }
    for (const key of Array.from(codexCallTimers.keys())) {
      if (!validSessions.has(key)) clearCodexCallTimer(key);
    }
    for (const key of Array.from(codexCallNotified.keys())) {
      if (!validSessions.has(key)) codexCallNotified.delete(key);
    }
    for (const key of Array.from(quotaRefreshed)) {
      if (!validSessions.has(key)) quotaRefreshed.delete(key);
    }
    for (const key of Array.from(limitResets.keys())) {
      if (!validSessions.has(key)) limitResets.delete(key);
    }
    for (const key of Array.from(launches.keys())) {
      if (!validSessions.has(key)) launches.delete(key);
    }
    for (const key of Array.from(hooksMissingNotified)) {
      if (!validSessions.has(key)) hooksMissingNotified.delete(key);
    }
    for (const key of Array.from(trustWaitNotified)) {
      if (!validSessions.has(key)) trustWaitNotified.delete(key);
    }
    for (const [key] of Array.from(terminals)) if (!validSessions.has(key)) clearTerminal(key);
    for (const [key] of Array.from(silenceTimers)) if (!validSessions.has(key)) clearSilenceTimer(key);
    for (const [key] of Array.from(trustWaitTimers)) if (!validSessions.has(key)) clearTrustWaitTimer(key);
    for (const [key] of Array.from(startupTimers)) if (!validSessions.has(key)) clearStartupTimer(key);
  }

  function handleWorksChange(snapshot: WorksView): void {
    if (stopped) return;
    for (const entry of snapshot.entries) {
      const { watch, renewed } = ensureWorkWatch(entry);
      for (const session of entry.map.sessions) {
        const ref: SessionRef = {
          projectPath: entry.projectPath,
          workId: entry.map.work.id,
          sessionId: session.id,
        };
        if (journals.has(refKey(ref)) && !renewed) recompute(ref);
        // Журнал читается и у уже известной сессии: событие, дописанное в окно между созданием fs-наблюдателя
        // и его реальным включением, наблюдатель теряет, и до следующей записи хука его не увидел бы никто.
        // Чтение инкрементальное — без новых байт это один stat. Первое чтение журнала новой сессии —
        // читатель мог появиться раньше её (работа известна, сессия только что добавлена); после нового
        // наблюдателя — всё, что хуки дописали без него.
        void readJournal(entry.projectPath, entry.map.work.id, watch.journal, session.id);
      }
    }
    pruneRemoved(snapshot);
  }

  /** `change` — какая запись индекса изменилась: пересчитываются только задетые ею сессии; без него (первый список) — все. */
  function handleLogChange(change?: LogChange): void {
    if (stopped) return;
    for (const entry of works.snapshot().entries) {
      for (const session of entry.map.sessions) {
        if (change !== undefined && !change.affects(session)) continue;
        recompute({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
      }
    }
  }

  return {
    async start() {
      if (options.silenceThresholdMs === undefined) {
        const { config } = await loadConfig();
        silenceThresholdMs = config.silenceThresholdMs;
      }
      unsubscribeLog = logIndex.onChange(handleLogChange);
      // Не ждём: полный список сессий провайдера может читать гигабайты истории
      // (`~/.claude/projects`), а старт хоста ждать это не должен — до готовности
      // индекса activity просто не видит страховки по логу и живёт одними хуками.
      // Готовый индекс заводит свои наблюдатели, и журналы перечитываются ещё раз.
      void logIndex.start().then(() => catchUp.schedule(), (error: unknown) => {
        host.log.error('индекс логов провайдера не построился', { error: String(error) });
      });
      unsubscribeWorks = works.onChange((snapshot) => handleWorksChange(snapshot));
      handleWorksChange(works.snapshot());
    },
    get: (ref) => live.get(refKey(ref)),
    mailWaiting(ref, reason) {
      const key = refKey(ref);
      if ((mailWaits.get(key) ?? null) === reason) return;
      if (reason === null) mailWaits.delete(key);
      else mailWaits.set(key, reason);
      recompute(ref);
    },
    setContext(ref, fill) {
      const key = refKey(ref);
      if (JSON.stringify(contexts.get(key) ?? null) === JSON.stringify(fill)) return;
      if (fill === null) contexts.delete(key);
      else contexts.set(key, fill);
      recompute(ref);
    },
    setCompaction(ref, track) {
      const key = refKey(ref);
      if (JSON.stringify(compactions.get(key) ?? null) === JSON.stringify(track)) return;
      if (track.phase === null && track.finishedAt === null) compactions.delete(key);
      else compactions.set(key, track);
      recompute(ref);
    },
    questionHeld(ref, held, detail = null) {
      const key = refKey(ref);
      if (questionHeldKeys.has(key) === held) return;
      if (held) {
        questionHeldKeys.set(key, { since: new Date(nowFn()).toISOString(), detail: clampDetail(detail) });
      } else {
        questionHeldKeys.delete(key);
      }
      recompute(ref);
    },
    permissionAnswered(ref) {
      // Каталог не создаём: его отсутствие — признак сессии без хуков (`hooks-missing`).
      const file = path.join(
        workPaths(ref.projectPath, ref.workId).events,
        `${ref.sessionId}.jsonl`,
      );
      appendFile(file, `${JSON.stringify({ hook_event_name: PERMISSION_ANSWERED_EVENT })}\n`, 'utf8').catch(
        () => {
          // Отметка — подсказка состоянию: без неё `blocked` снимет страховка по логу.
        },
      );
    },
    onLogChange(listener) {
      return logIndex.onChange(listener);
    },
    usageResolver() {
      return {
        whole: (session) => wholeSessionUsage(selectedUsage(session), logIndex.index(session) !== undefined, session.provider),
        bounds: (session) => {
          const found = logIndex.index(session);
          return found === undefined ? null : { startedAt: found.startedAt, endedAt: found.endedAt };
        },
        slice: async (session, windows) => (await logIndex.usageIn(session, windows)) ?? null,
      };
    },
    logFile(ref) {
      const session = works
        .entry(ref.projectPath, ref.workId)
        ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      return session === undefined ? null : (logIndex.index(session)?.file ?? null);
    },
    childLogFile(ref, threadId) {
      const session = works
        .entry(ref.projectPath, ref.workId)
        ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return null;
      return logIndex.childLogs(session).find((child) => child.threadId === threadId)?.file ?? null;
    },
    codexLogFiles(ref) {
      const session = works
        .entry(ref.projectPath, ref.workId)
        ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined || session.provider !== 'codex') return [];
      const main = logIndex.index(session)?.file;
      return [...(main === undefined ? [] : [main]), ...logIndex.childLogs(session).map((child) => child.file)];
    },
    watchClaudeRoot(root) {
      logIndex.watchClaudeRoot(root);
    },
    reindexLog(file) {
      return logIndex.reindex(file);
    },
    terminalStarted(ref) {
      if (stopped) return;
      const key = refKey(ref);
      // Новый процесс — своё состояние: сигналы прошлого (resume) к нему не относятся.
      clearTerminal(key);
      const state: TerminalState = {
        last: null,
        waiting: [],
        startupTimer: undefined,
        turnSeen: false,
        startedAt: nowFn(),
      };
      state.startupTimer = setTimeout(() => startupExpired(ref, key, state), startupWaitMs);
      terminals.set(key, state);
      recomputeOnStart(ref);
    },
    processStarted(ref) {
      if (stopped) return;
      const key = refKey(ref);
      launches.set(key, { at: nowFn(), journalLength: journals.get(key)?.length ?? 0 });
      // Срок и счёт новых строк начинаются заново: таймер прежнего запуска (Resume) к этому процессу не относится.
      clearStartupTimer(key);
      recomputeOnStart(ref);
    },
    terminalSignal(ref, signal) {
      if (stopped) return;
      const key = refKey(ref);
      const state = terminals.get(key);
      if (state === undefined) return;
      // Неизвестное состояния не меняет и «работает» не значит (спека комнат, 3.6).
      // Время обновляется на каждом сигнале, даже повторном: он новее любого `Stop` от notify, который
      // журнал успел принять между кадрами, — так следующий кадр спиннера ставит терминальное событие
      // после него.
      const event = eventOfSignal(signal, state.turnSeen, new Date(nowFn()).toISOString());
      if (event === null) return;
      if (signal.kind !== 'ready') state.turnSeen = true;
      const previous = state.last;
      state.last = event;
      // Эпизод ожидания человека длится, пока идут сигналы `needs-you`; любой другой его заканчивает.
      state.waiting = signal.kind === 'needs-you' ? episodeWith(state.waiting, event) : [];
      if (state.startupTimer !== undefined) {
        clearTimeout(state.startupTimer);
        state.startupTimer = undefined;
      }
      // Пересчёт и рассылка — на смене сигнала (имя, вид уведомления, текст) и когда выведенное состояние с ним
      // разошлось (чужое событие журнала новее сигнала), а не на каждом кадре спиннера: согласный повтор ничего не
      // меняет.
      if (
        previous === null ||
        !sameSignal(previous, event) ||
        !agreesWith(derivedActivity.get(key), signal)
      ) {
        recompute(ref);
      }
    },
    terminalStopped(ref) {
      const key = refKey(ref);
      // Запись о запуске относится к процессу: у Claude и GLM состояния терминала нет, и выход иначе её не снимал бы.
      launches.delete(key);
      if (!terminals.has(key)) return;
      clearTerminal(key);
      clearCodexCallTimer(key);
      recompute(ref);
    },
    markSeen(ref, at = new Date().toISOString()) {
      seenAt.set(refKey(ref), at);
      recompute(ref);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current() {
      // Идём по снимку работ, а не по ключам `live`: из ключа ref не собрать, а
      // снимок и так единственный источник того, какие сессии существуют.
      const result: Array<EventData<'activity.changed'>> = [];
      for (const entry of works.snapshot().entries) {
        for (const session of entry.map.sessions) {
          const ref: SessionRef = {
            projectPath: entry.projectPath,
            workId: entry.map.work.id,
            sessionId: session.id,
          };
          const value = live.get(refKey(ref));
          if (value !== undefined) result.push({ ref, activity: value.activity, metrics: value.metrics });
        }
      }
      return result;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeWorks?.();
      unsubscribeLog?.();
      catchUp.cancel();
      for (const timer of silenceTimers.values()) clearTimeout(timer);
      silenceTimers.clear();
      for (const timer of trustWaitTimers.values()) clearTimeout(timer);
      trustWaitTimers.clear();
      for (const timer of codexCallTimers.values()) clearTimeout(timer);
      codexCallTimers.clear();
      derivedActivity.clear();
      for (const timer of startupTimers.values()) clearTimeout(timer);
      startupTimers.clear();
      for (const key of Array.from(terminals.keys())) clearTerminal(key);
      for (const watch of workWatches.values()) watch.watcher?.close();
      workWatches.clear();
      logIndex.stop();
    },
  };
}
