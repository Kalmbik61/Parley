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
  activityOf,
  applyAutoTitle,
  linkSession,
  loadConfig,
  NEW_LABEL,
  openEvents,
  sessionTag,
  unreadFor,
  watchEvents,
  workPaths,
  type ActivityLog,
  type EventRecord,
  type EventsLog,
  type EventsWatcher,
  type MetricsRoots,
  type SessionActivity,
  type SessionIndex,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import {
  refKey,
  type EventData,
  type LiveMetrics,
  type SessionRef,
  type WorksSnapshot,
} from '@harnas/protocol';
import type { HostContext } from '../context.js';
import type { WorksService } from '../works/works-service.js';
import { createLogIndex, type LogIndex } from './log-index.js';

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
  /** Сессия в worktree без единого хука дольше этого срока — `trust-wait` (спека 8.2, план 4.2). */
  trustWaitMs?: number;
  now?: () => number;
}

export interface ActivityService {
  start(): Promise<void>;
  get(ref: SessionRef): SessionLive | undefined;
  /** Пользователь смотрел на сессию: `pty.attach` и `pty.input` (1.6). */
  markSeen(ref: SessionRef, at?: string): void;
  onChange(listener: (ref: SessionRef, value: SessionLive) => void): () => void;
  /** Текущая активность всех сессий, которые держит сервис, — повтор для нового клиента. */
  current(): Array<EventData<'activity.changed'>>;
  stop(): Promise<void>;
}

const workKeyOf = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;

/** Спека 8.2: доверие к папке worktree подтверждают руками, и хук может не прийти вовсе. */
const DEFAULT_TRUST_WAIT_MS = 20_000;

interface WorkWatch {
  journal: EventsLog;
  /** `null` — каталога `events/` ещё нет или наблюдение сломалось: ждём повтора. */
  watcher: EventsWatcher | null;
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
  const trustWaitMs = options.trustWaitMs ?? DEFAULT_TRUST_WAIT_MS;

  const logIndex: LogIndex = createLogIndex(roots);
  const live = new Map<string, SessionLive>();
  const journals = new Map<string, readonly EventRecord[] | null>();
  const seenAt = new Map<string, string>();
  const silenceTimers = new Map<string, NodeJS.Timeout>();
  const autoTitled = new Set<string>();
  const hooksMissingNotified = new Set<string>();
  const trustWaitTimers = new Map<string, NodeJS.Timeout>();
  const trustWaitNotified = new Set<string>();
  const linkInFlight = new Set<string>();
  const workWatches = new Map<string, WorkWatch>();
  const listeners = new Set<(ref: SessionRef, value: SessionLive) => void>();

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

  /** Час икс тишины — либо уже прошёл (задержка 0), либо ставится единственный таймер. */
  function scheduleSilenceTimer(
    ref: SessionRef,
    key: string,
    activity: SessionActivity,
    log: ActivityLog | null,
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

    const delay = Math.max(0, quietAt + silenceThresholdMs - nowFn());
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

  function metricsFor(
    entry: WorkEntry,
    session: WorkSession,
    activity: SessionActivity,
    indexed: SessionIndex | undefined,
  ): LiveMetrics {
    // Метрики завершённой сессии зафиксированы в карте, у живой — в логе
    // провайдера; модель в карте не хранится никогда (work-rows.ts, sidebar.tsx).
    const tokens = session.metrics?.tokens ?? indexed?.tokens ?? null;
    return {
      tokensIn: tokens?.input ?? null,
      tokensOut: tokens?.output ?? null,
      durationMs: session.metrics?.durationMs ?? indexed?.durationMs ?? null,
      unread: unreadOf(entry, session.id),
      subagents: activity.subagents,
      model: indexed?.primaryModel ?? null,
    };
  }

  const sameLive = (a: SessionLive, b: SessionLive): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  /** Заголовок Claude Code доехал до индекса логов — переименование один раз (5.1). */
  function maybeAutoTitle(ref: SessionRef, key: string, session: WorkSession): void {
    if (session.label !== NEW_LABEL || autoTitled.has(key)) return;
    const title = logIndex.index(session)?.title;
    if (title === undefined || title === null) return;
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
    if (events !== null || hooksMissingNotified.has(key)) return;
    hooksMissingNotified.add(key);
    host.broadcast('host.notice', {
      kind: 'hooks-missing',
      ref,
      text: `хуки Claude Code не пришли для сессии ${ref.sessionId} — состояния по логу`,
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
    if (trustWaitNotified.has(key) || trustWaitTimers.has(key)) return;
    const startedAt = session.startedAt === null ? Number.NaN : Date.parse(session.startedAt);
    if (Number.isNaN(startedAt)) return;

    const delay = Math.max(0, startedAt + trustWaitMs - nowFn());
    trustWaitTimers.set(
      key,
      setTimeout(() => {
        trustWaitTimers.delete(key);
        // Хук успел прийти, пока таймер ждал, — журнал сейчас не пуст.
        if ((journals.get(key) ?? null) !== null) return;
        trustWaitNotified.add(key);
        host.broadcast('host.notice', {
          kind: 'trust-wait',
          ref,
          text: `${sessionTag(ref.sessionId)} не отвечает с запуска — возможно, ждёт доверия к папке`,
          at: new Date().toISOString(),
        });
      }, delay),
    );
  }

  function recompute(ref: SessionRef): void {
    if (stopped) return;
    const entry = works.entry(ref.projectPath, ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    if (entry === undefined || session === undefined) return;

    const key = refKey(ref);
    const events = journals.get(key) ?? null;
    const log = logIndex.log(session);
    const now = nowFn();

    // `seen` зависит от `turnEndedAt`, а он — результат самой свёртки: первый
    // проход узнаёт его, второй считает финальную `activity` (план, кусок 1.5).
    const draft = activityOf({ events, log, seen: false, now, silenceThresholdMs });
    const seen = isSeen(seenAt.get(key), draft.turnEndedAt);
    const activity = activityOf({ events, log, seen, now, silenceThresholdMs });

    const metrics = metricsFor(entry, session, activity, logIndex.index(session));
    const value: SessionLive = { activity, metrics };

    scheduleSilenceTimer(ref, key, activity, log);

    const previous = live.get(key);
    live.set(key, value);
    if (previous === undefined || !sameLive(previous, value)) {
      host.broadcast('activity.changed', { ref, activity, metrics });
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
    return { watch, renewed: true };
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
      workWatches.delete(wk);
    }

    for (const [key] of Array.from(journals)) if (!validSessions.has(key)) journals.delete(key);
    for (const [key] of Array.from(live)) if (!validSessions.has(key)) live.delete(key);
    for (const [key] of Array.from(seenAt)) if (!validSessions.has(key)) seenAt.delete(key);
    for (const key of Array.from(autoTitled)) if (!validSessions.has(key)) autoTitled.delete(key);
    for (const key of Array.from(hooksMissingNotified)) {
      if (!validSessions.has(key)) hooksMissingNotified.delete(key);
    }
    for (const key of Array.from(trustWaitNotified)) {
      if (!validSessions.has(key)) trustWaitNotified.delete(key);
    }
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
        // Первое чтение журнала новой сессии — читатель мог появиться раньше её
        // (работа известна, сессия только что добавлена); после нового
        // наблюдателя — всё, что хуки дописали без него.
        else void readJournal(entry.projectPath, entry.map.work.id, watch.journal, session.id);
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
      for (const watch of workWatches.values()) watch.watcher?.close();
      workWatches.clear();
      logIndex.stop();
    },
  };
}
