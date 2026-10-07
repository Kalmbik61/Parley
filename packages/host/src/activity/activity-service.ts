/**
 * Живая активность сессий хоста: точка статуса и строка метрик, которые раньше
 * считал TUI (`use-activity.ts`, `use-log-index.ts`, `use-map-sync.ts`,
 * `use-session-link.ts`), здесь без React — свёртку по-прежнему делает core
 * (`activityOf`), сервис только подписывается и рассылает `activity.changed`
 * (дизайн TUI v2, 4.2, 4.3, 5.1).
 *
 * Опроса нет: пересчёт идёт по событиям наблюдателей (журнал хуков, лог
 * провайдера, список работ) и по одному таймеру на сессию — на момент, когда
 * истечёт порог тишины, если сессия сейчас `working`. Планового `setInterval` в
 * файле нет и не должно быть (приёмка куска 1.5).
 */

import { existsSync } from 'node:fs';
import {
  DEFAULT_BACKGROUND_HOLD_MS,
  TERMINAL_WORKING_EVENT,
  activityOf,
  claudeProjectRoots,
  applyAutoTitle,
  autoTitleOf,
  bareEvent,
  envValue,
  isNewLabel,
  isPointerText,
  linkSession,
  loadConfig,
  legacyUsage,
  openEvents,
  resetPointerLabel,
  selectUsage,
  sessionTag,
  unreadFor,
  watchEvents,
  workPaths,
  type Activity,
  type ActivityLog,
  type EventRecord,
  type EventsLog,
  type EventsWatcher,
  type MetricsRoots,
  type SessionActivity,
  type SessionIndex,
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
  type WorksSnapshot,
} from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { CodexSignal } from '../pty/codex-terminal.js';
import { createSettler, type Settler } from '../watch-settle.js';
import type { WorksService } from '../works/works-service.js';
import { createLogIndex, type LogIndex } from './log-index.js';
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
  /** Процесс вышел: состояние по терминалу больше не действует, сессия снова читается по журналу и логу. */
  terminalStopped(ref: SessionRef): void;
  /**
   * План 2026-10-01, кусок 4a, решение О: окно держит вопрос агента (хук `PreToolUse`) — сессия
   * 'blocked', пока хук не отпущен: журнал событий удержанного вопроса не видит и по тишине считал бы её
   * idle. Таймер тишины и метрики при этом считаются по настоящему значению.
   */
  questionHeld(ref: SessionRef, held: boolean): void;
  /**
   * Почему письма сессии ещё не забраны (причина будильника) — уходит окну в `LiveMetrics.mailWaiting`:
   * комната пишет её рядом с «not picked up yet». `null` — писем нет.
   */
  mailWaiting(ref: SessionRef, reason: MailWait | null): void;
  /**
   * Журнал какой-то сессии изменился (индекс логов; живая лента по нему ловит прерывание Esc —
   * запись «[Request interrupted by user…]», план 2026-10-01, решение 5). Возвращает отписку.
   */
  onLogChange(listener: () => void): () => void;
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
  /** Срок экранов старта: сработает, если `last` так и останется `null`. */
  startupTimer: NodeJS.Timeout | undefined;
  /**
   * С запуска процесса был хоть один сигнал хода: работа, вопрос человеку или конец хода. До него `Ready`
   * — приглашение у ещё не начатой сессии, а не конец хода.
   */
  turnSeen: boolean;
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
 * временем снимал бы ожидание `wait_for` (его строку дописал MCP-сервер), хотя нового хода нет.
 */
const eventNameOf = (signal: CodexSignal, turnSeen: boolean): string | null => {
  switch (signal.kind) {
    case 'working':
      return TERMINAL_WORKING_EVENT;
    case 'ready':
      return turnSeen ? 'Stop' : TERMINAL_READY_EVENT;
    case 'turn-complete':
      return 'Stop';
    case 'needs-you':
      return 'PermissionRequest';
    default:
      return null;
  }
};

/**
 * Согласно ли выведенное состояние с последним сигналом терминала. Расходятся они, когда в свёртку
 * вмешалось чужое событие новее сигнала: `Stop` от notify с временем файла позже последнего кадра
 * спиннера или мигания `Action Required`. Следующий сигнал того же вида такое расхождение чинит.
 */
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

interface WorkWatch {
  journal: EventsLog;
  /** `null` — каталога `events/` ещё нет или наблюдение сломалось: ждём повтора. */
  watcher: EventsWatcher | null;
  /** Дочитывание журналов после создания наблюдателя (`watch-settle`); `null` — наблюдателя нет. */
  settler: Settler | null;
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

  const logIndex: LogIndex = createLogIndex(roots);
  const live = new Map<string, SessionLive>();
  const journals = new Map<string, readonly EventRecord[] | null>();
  const seenAt = new Map<string, string>();
  const silenceTimers = new Map<string, NodeJS.Timeout>();
  const autoTitled = new Set<string>();
  /** Сессии, чей ярлык-указатель хост уже возвращает (или вернул) к метке новой сессии (`resetPointerLabel`). */
  const pointerLabelReset = new Set<string>();
  /** Сессии, чей вопрос агента удержан окном (`questionHeld`): им публикуется `blocked`. */
  const questionHeldKeys = new Set<string>();
  /** Причина, по которой письма сессии ждут (`mailWaiting`), по ключу сессии. */
  const mailWaits = new Map<string, MailWait>();
  const hooksMissingNotified = new Set<string>();
  const trustWaitTimers = new Map<string, NodeJS.Timeout>();
  const trustWaitNotified = new Set<string>();
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
  const metaRoots = options.claudeRoot === undefined ? claudeProjectRoots() : [options.claudeRoot];
  const readMeta =
    options.readSubagentMeta ??
    ((transcriptPath: string, agentId: string) => readSubagentMeta(transcriptPath, agentId, metaRoots));
  /** Чтения `meta.json` в полёте (ключ сессии и id задачи): одно на задачу, пока оно не вернулось. */
  const metaReads = new Set<string>();

  let stopped = false;
  let unsubscribeWorks: (() => void) | undefined;
  let unsubscribeLog: (() => void) | undefined;

  function clearSilenceTimer(key: string): void {
    const timer = silenceTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    silenceTimers.delete(key);
  }

  function clearTrustWaitTimer(key: string): void {
    const timer = trustWaitTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    trustWaitTimers.delete(key);
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
   * от `applyChoice`, а запуск уже знает провайдера точно.
   */
  function eventsFor(session: WorkSession, key: string): readonly EventRecord[] | null {
    const journal = journals.get(key) ?? null;
    const terminal = terminals.get(key);
    if (terminal === undefined && session.provider !== 'codex') return journal;
    let base = journal ?? [];
    const last = terminal?.last;
    if (last === null || last === undefined) return base;
    const signals = [last];
    // Codex может не прислать Ready/notify после ответа. Явное событие rollout
    // завершает такой ход; старый конец хода не перекрывает более новый сигнал терминала.
    const turn = logIndex.index(session)?.lastTurnEvent;
    if (turn !== undefined && Date.parse(turn.at) >= Date.parse(last.at)) {
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

  const unreadOf = (entry: WorkEntry, sessionId: string): number =>
    unreadFor(entry.map, sessionId).length;

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

  function metricsFor(
    ref: SessionRef,
    key: string,
    entry: WorkEntry,
    session: WorkSession,
    activity: SessionActivity,
    indexed: SessionIndex | undefined,
  ): LiveMetrics {
    // Токены: у идущей сессии побеждает свежий индекс лога, а снимок из карты (его ставят `report` и
    // усыпление) годится для остановленной и как запасной, когда свежего индекса нет. Какой источник
    // выбран, видно в `usage.source`; сумма не выдумывается (`selectUsage`). Снимок чужого разговора
    // (сессию перепривязали) за свой не принимается. Модель в карте не хранится никогда (work-rows.ts, sidebar.tsx).
    const snapshot = session.metrics;
    const frozen =
      snapshot === null
        ? null
        : snapshot.usage === undefined
          ? legacyUsage(snapshot.tokens)
          : snapshot.usage.binding === session.providerSessionId
            ? snapshot.usage
            : null;
    const selected = selectUsage({
      active: session.lifecycle === 'active',
      epoch: session.startedAtProcess,
      live: logIndex.usage(session) ?? null,
      frozen,
    });
    const usage: UsageSummary = {
      ...selected,
      // Комнату и прогон по одной сессии не определить: сессия бывает в нескольких комнатах.
      attribution: { workId: ref.workId, sessionId: session.id, roomId: null, runId: null },
    };
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
      tasks: liveTasksOf(ref, key, activity),
      waitingFor: activity.waitingFor,
      mailWaiting: mailWaits.get(key) ?? null,
    };
  }

  const sameLive = (a: SessionLive, b: SessionLive): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  /**
   * Заголовок Claude Code доехал до индекса логов — переименование один раз (5.1). Разговор, начатый
   * указателем на письма, имени из лога не получает (`autoTitleOf`); ярлык-указатель, оставленный прежними
   * сборками, тогда возвращается к метке новой сессии — один раз на сессию.
   */
  function maybeAutoTitle(ref: SessionRef, key: string, session: WorkSession): void {
    if (!isNewLabel(session.label) || autoTitled.has(key)) return;
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
   * доверия к папке (спека комнат, 3.6). Проходит их человек, в терминале Codex, — сессия «нужен ты»,
   * а причину называет уведомление хоста. Как только придёт известный сигнал, состояние заменится им.
   */
  function startupExpired(ref: SessionRef, key: string, state: TerminalState): void {
    state.startupTimer = undefined;
    if (stopped || terminals.get(key) !== state || state.last !== null) return;
    const at = new Date(nowFn()).toISOString();
    state.last = bareEvent(at, 'PermissionRequest');
    host.broadcast('host.notice', {
      kind: 'startup-wait',
      ref,
      text: `${sessionTag(ref.sessionId)} has not shown a status since launch — it may be waiting for sign-in or folder trust in the Codex terminal`,
      at,
    });
    recompute(ref);
  }

  function recompute(ref: SessionRef): void {
    if (stopped) return;
    const entry = works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (entry === undefined || session === undefined) return;

    const key = refKey(ref);
    const events = eventsFor(session, key);
    // Под хостом состояние Codex ведут сигналы терминала и явные события хода из rollout (eventsFor).
    // Общая свежесть лога не годится: token_count после ответа снова вернул бы working.
    // Процесс вышел — сессия снова читается по журналу и логу, как всякая спящая.
    const driven = terminals.has(key);
    const log = driven ? null : logIndex.log(session);
    const now = nowFn();
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
    const activity = activityOf({
      events,
      log,
      seen,
      now,
      silenceThresholdMs: threshold,
      backgroundHoldMs,
    });

    const metrics = metricsFor(ref, key, entry, session, activity, logIndex.index(session));
    // Удержанный вопрос агента: публикуется 'blocked', а таймер тишины и метрики — по настоящему значению.
    const published: SessionActivity =
      questionHeldKeys.has(key) && activity.activity !== 'blocked'
        ? { ...activity, activity: 'blocked' }
        : activity;
    const value: SessionLive = { activity: published, metrics };

    if (driven) clearSilenceTimer(key);
    else scheduleSilenceTimer(ref, key, activity, log, now);

    const previous = live.get(key);
    live.set(key, value);
    if (previous === undefined || !sameLive(previous, value)) {
      host.broadcast('activity.changed', { ref, activity: published, metrics });
      for (const listener of listeners) listener(ref, value);
    }

    maybeAutoTitle(ref, key, session);
    maybeLink(ref, key, session);
    maybeHooksMissing(ref, key, session, events);
    maybeTrustWait(ref, key, session);
  }

  /**
   * Наблюдение за журналами работы. `renewed` — наблюдатель только что заведён:
   * всё, что хуки успели дописать до него, никто не прочёл, журналы работы
   * нужно перечитать.
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
      watch = { journal: openEvents(eventsDir), watcher: null, settler: null };
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
          current.settler?.cancel();
        },
      },
    );
    if (failed) {
      watcher.close();
      return { watch, renewed: false };
    }
    watch.watcher = watcher;
    // Хук, дописанный в окно включения наблюдателя, он теряет: журналы работы перечитываются ещё несколько раз.
    watch.settler = createSettler(() => settleJournals(entry.projectPath, entry.map.work.id));
    watch.settler.schedule();
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

  /** Работы и сессии, которых в свежем снимке больше нет: состояние не копится вечно. */
  function pruneRemoved(snapshot: WorksSnapshot): void {
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
      watch.settler?.cancel();
      workWatches.delete(wk);
    }

    for (const [key] of Array.from(journals)) if (!validSessions.has(key)) journals.delete(key);
    for (const [key] of Array.from(live)) if (!validSessions.has(key)) live.delete(key);
    for (const [key] of Array.from(subagentCaches)) {
      if (!validSessions.has(key)) subagentCaches.delete(key);
    }
    for (const [key] of Array.from(seenAt)) if (!validSessions.has(key)) seenAt.delete(key);
    for (const key of Array.from(autoTitled)) if (!validSessions.has(key)) autoTitled.delete(key);
    for (const key of Array.from(pointerLabelReset)) if (!validSessions.has(key)) pointerLabelReset.delete(key);
    for (const key of Array.from(mailWaits.keys())) {
      if (!validSessions.has(key)) mailWaits.delete(key);
    }
    for (const key of Array.from(questionHeldKeys)) {
      if (!validSessions.has(key)) questionHeldKeys.delete(key);
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
  }

  function handleWorksChange(snapshot: WorksSnapshot): void {
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

  function handleLogChange(): void {
    if (stopped) return;
    for (const entry of works.snapshot().entries) {
      for (const session of entry.map.sessions) {
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
      void logIndex.start().catch((error: unknown) => {
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
    questionHeld(ref, held) {
      const key = refKey(ref);
      if (questionHeldKeys.has(key) === held) return;
      if (held) questionHeldKeys.add(key);
      else questionHeldKeys.delete(key);
      recompute(ref);
    },
    onLogChange(listener) {
      return logIndex.onChange(listener);
    },
    logFile(ref) {
      const session = works
        .entry(ref.projectPath, ref.workId)
        ?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      return session === undefined ? null : (logIndex.index(session)?.file ?? null);
    },
    terminalStarted(ref) {
      if (stopped) return;
      const key = refKey(ref);
      // Новый процесс — своё состояние: сигналы прошлого (resume) к нему не относятся.
      clearTerminal(key);
      const state: TerminalState = { last: null, startupTimer: undefined, turnSeen: false };
      state.startupTimer = setTimeout(() => startupExpired(ref, key, state), startupWaitMs);
      terminals.set(key, state);
      recompute(ref);
    },
    terminalSignal(ref, signal) {
      if (stopped) return;
      const key = refKey(ref);
      const state = terminals.get(key);
      if (state === undefined) return;
      // Неизвестное состояния не меняет и «работает» не значит (спека комнат, 3.6).
      const name = eventNameOf(signal, state.turnSeen);
      if (name === null) return;
      if (signal.kind !== 'ready') state.turnSeen = true;
      const previous = state.last;
      // Время обновляется на каждом сигнале, даже повторном: он новее любого `Stop` от notify, который
      // журнал успел принять между кадрами, — так следующий кадр спиннера ставит терминальное событие
      // после него.
      state.last = bareEvent(new Date(nowFn()).toISOString(), name);
      if (state.startupTimer !== undefined) {
        clearTimeout(state.startupTimer);
        state.startupTimer = undefined;
      }
      // Пересчёт и рассылка — на смене сигнала и когда выведенное состояние с ним разошлось (чужое
      // событие журнала новее сигнала), а не на каждом кадре спиннера: согласный повтор ничего не меняет.
      if (
        previous === null ||
        previous.name !== name ||
        !agreesWith(live.get(key)?.activity.activity, signal)
      ) {
        recompute(ref);
      }
    },
    terminalStopped(ref) {
      const key = refKey(ref);
      if (!terminals.has(key)) return;
      clearTerminal(key);
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
      for (const timer of silenceTimers.values()) clearTimeout(timer);
      silenceTimers.clear();
      for (const timer of trustWaitTimers.values()) clearTimeout(timer);
      trustWaitTimers.clear();
      for (const key of Array.from(terminals.keys())) clearTerminal(key);
      for (const watch of workWatches.values()) {
        watch.watcher?.close();
        watch.settler?.cancel();
      }
      workWatches.clear();
      logIndex.stop();
    },
  };
}
