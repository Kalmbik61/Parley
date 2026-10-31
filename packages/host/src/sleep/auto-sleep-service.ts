/**
 * Сон агентов без процесса (спека 2026-10-30, 4.1). Раз в 30 с и на каждое изменение активности сервис проверяет живые PTY
 * и усыпляет агентов Claude Code, которым нечего делать: процесс останавливается, история остаётся у провайдера, а письмо
 * поднимает сессию прежним путём будильника.
 *
 * «Спать или нет» решает чистая `autoSleepVerdict` из core; здесь только сбор её входа из источников хоста и сам сон.
 * Сон идёт в четыре шага:
 * 1. под замком карты сессию перепроверяют и ставят отметку «засыпает» (`autoSleepPending`): с неё `check_inbox` и
 *    `wait_for` писем не выдают, и письмо не уйдёт в процесс, которого вот-вот не станет;
 * 2. обычный `stop` — тот же, что у кнопки Stop;
 * 3. при выходе процесса `transitionSession` превращает отметку в `autoSleep` (core); если сессия всё же осталась `active`,
 *    отметку снимает сервис: иначе письма этой сессии застряли бы за оградой;
 * 4. будильнику велено перепроверить письма уснувшей сессии (`wake.retry`), затем запись в журнал хоста.
 *
 * Между шагами 1 и 2 хост запоминает потомков процесса агента, а через `SURVIVOR_CHECK_MS` после сна пишет в журнал тех, кто
 * ещё жив (спека, 4.6). Хост ничего не убивает: общие сервисы и чужие процессы трогать нельзя, записи нужны этапу 3.
 *
 * Усыплённый на `wait_for(<id>)` сам не узнает, что с целью ожидания стало: процесса у него нет. Сервис следит за целью по
 * снимку работ и, когда `wait_for` ответил бы на неё сразу (итог, `stuck`, сон по решению хоста, закрытие, удаление), пишет
 * спящему системное письмо; оно поднимает сессию обычным путём будильника. Цель, остановленную человеком, письмом не
 * считают: без его согласия её не поднимают, и ждавший проснётся, когда её продолжат и она кончит.
 */

import {
  asleepHint,
  autoSleepVerdict,
  deliveredSince,
  finishedState,
  hookedSince,
  isClaudeCode,
  sessionTag,
  SYSTEM,
  unreadCount,
  updateMap,
  type AutoSleep,
  type AutoSleepReason,
  type SessionActivity,
  type WorkEntry,
  type WorkSession,
} from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyHandle, PtyManager } from '../pty/pty-manager.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { WorksService } from '../works/works-service.js';
import { SURVIVOR_CHECK_MS, alivePids, descendantPids } from './descendants.js';

/**
 * Ждущих в `wait_for` усыплять (итог спайка, задача 0 плана сна). Спайк пройден 2026-10-31: процесс claude, остановленный
 * посреди вызова MCP, поднялся через `--resume` с целой историей, оборванный вызов записан как ошибка «Connection closed»,
 * а первый ход разобрал указатель на письма. Выключатель оставлен для отката: `false` — ждущие не засыпают, засыпают
 * только те, у кого ход окончен.
 */
export const ALLOW_WAITER_SLEEP: boolean = true;

/** Как часто сервис проверяет живые PTY сам, не дожидаясь изменения активности (спека 4.1). */
export const AUTO_SLEEP_TICK_MS = 30_000;

export interface AutoSleepServiceDeps {
  /** `snapshot` — карты работ, в том числе спящих сессий без PTY; `onChange` — повод проверить цели их ожидания. */
  works: Pick<WorksService, 'snapshot' | 'onChange'>;
  activity: Pick<ActivityService, 'get' | 'onChange'>;
  pty: Pick<PtyManager, 'list' | 'get'>;
  sessions: Pick<SessionsService, 'stop'>;
  /**
   * Будильник: указатель на письма набирается в терминал сессии (`inFlight`); `retry` — перепроверить письма сессии,
   * которую только что усыпили.
   */
  wake: Pick<WakeService, 'inFlight' | 'retry'>;
  /** Идёт или ждёт сжатие контекста (`CompactionService.holds`). */
  compacting: (ref: SessionRef) => boolean;
  /** Настройки читаются на каждой проверке: человек меняет `sleepAfterMinutes` на ходу. */
  config: () => Promise<{ sleepAfterMinutes: number }>;
  /** Часы; тесты подставляют свои. */
  now?: () => number;
  tickMs?: number;
  /** Потомки процесса (pid), которых запоминают до остановки (`descendantPids`); тесты обходятся без настоящих процессов. */
  descendants?: (rootPid: number) => Promise<number[]>;
  /** Жив ли процесс с таким pid (`process.kill(pid, 0)`); тесты подставляют свой. */
  isAlive?: (pid: number) => boolean;
}

export interface AutoSleepService {
  start(): void;
  stop(): void;
  /** Сейчас, без порога, при первом простое (королева завершённого роя); повтор безвреден. */
  requestSleep(ref: SessionRef, reason: 'swarm-done'): void;
}

/** Что решено: сессию усыпляют, с какой причиной, с какого момента она простаивает и что ждала. */
interface Plan {
  reason: AutoSleepReason;
  idleSince: number;
  waitTarget: string | null;
}

/**
 * Конец хода из журнала мог остаться от прошлого процесса: `SessionStart` его не обновляет, если прежний процесс кончил ход
 * сам (`Stop`). Поднятую сессию (Resume, письмо) без нового хода по такому концу сочли бы простоявшей часы и тут же
 * усыпили бы снова. Часы простоя идут не раньше запуска нынешнего процесса.
 */
function sinceLaunch(activity: SessionActivity | null, startedAt: number): SessionActivity | null {
  if (activity?.turnEndedAt == null) return activity;
  // Нечитаемое время (`NaN`) не раньше запуска: оно остаётся как есть, его разберёт вердикт.
  return Date.parse(activity.turnEndedAt) < startedAt
    ? { ...activity, turnEndedAt: new Date(startedAt).toISOString() }
    : activity;
}

/**
 * Что ответил бы `wait_for(<id>)` на цель ожидания прямо сейчас (`finishedState` из core): итог, `stuck`, `asleep` (усыплена
 * хостом), `closed`; `deleted` — цели нет в карте. Одно отличие: остановленная человеком цель (`sleeping` без `autoSleep`;
 * так же выглядят выход приложения и сверка мёртвого процесса) — не конец. Её без согласия человека не поднимают, поэтому
 * письма нет, а ждавший проснётся, когда её продолжат и она кончит. `null` — ждать дальше.
 */
function targetState(target: WorkSession | undefined): string | null {
  if (target === undefined) return 'deleted';
  const state = finishedState(target);
  return state === 'sleeping' ? null : state;
}

/**
 * Письмо ждавшему о состоянии цели (`targetState`). Усыплённая хостом цель итога не сдаст, пока её не разбудят: подсказка
 * та же, что `wait_for` даёт на неё (`asleepHint`).
 */
function waiterLetter(targetId: string, state: string): string {
  const tag = sessionTag(targetId);
  return state === 'asleep' ? asleepHint(tag) : `${tag} finished: ${state}`;
}

export function createAutoSleepService(host: HostContext, deps: AutoSleepServiceDeps): AutoSleepService {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? AUTO_SLEEP_TICK_MS;
  const collectDescendants = deps.descendants ?? descendantPids;

  /**
   * Начало текущего `wait_for` сессии, как его увидел хост (мс), и цель ожидания; ключ — `refKey`. Время строки журнала
   * для этого не годится — это mtime файла при чтении. После перезапуска хоста отсчёт начинается заново: сон откладывается,
   * а не ускоряется.
   */
  const waits = new Map<string, { target: string; since: number }>();
  /** Сессии, которым велено уснуть при первом простое, без порога (`requestSleep`). */
  const requested = new Map<string, AutoSleepReason>();
  /** Сессии, которые проверяются или усыпляются сейчас: вторая проверка той же сессии не начинается. */
  const inWork = new Set<string>();
  /** Таймеры проверки выживших потомков, по одному на сон; `stop()` их снимает. */
  const survivorTimers = new Set<ReturnType<typeof setTimeout>>();

  let stopped = true;
  let ticking = false;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeWorks: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Начало ожидания: `waitingFor` из `null` в значение — запомнить, обратно в `null` — забыть. Другая цель без паузы —
   * новый вызов `wait_for`, а каждый возврат из него — ход модели: часы идут заново.
   */
  function trackWait(key: string, waitingFor: string | null): void {
    if (waitingFor === null) waits.delete(key);
    else if (waits.get(key)?.target !== waitingFor) waits.set(key, { target: waitingFor, since: now() });
  }

  /** Забыть сессии, у которых процесса уже нет: ни начало ожидания, ни просьба уснуть им больше не нужны. */
  function forget(live: readonly PtyHandle[]): void {
    const alive = new Set(live.map((handle) => refKey(handle.ref)));
    for (const key of waits.keys()) if (!alive.has(key)) waits.delete(key);
    for (const key of requested.keys()) if (!alive.has(key)) requested.delete(key);
  }

  /** Сессия в снимке работ хоста. Снимок отстаёт от базы, поэтому решающая проверка идёт под замком карты. */
  function locate(ref: SessionRef): { entry: WorkEntry; session: WorkSession } | undefined {
    const entry = deps.works
      .snapshot()
      .entries.find((candidate) => candidate.projectPath === ref.projectPath && candidate.map.work.id === ref.workId);
    const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
    return entry === undefined || session === undefined ? undefined : { entry, session };
  }

  /** Вход `autoSleepVerdict` из источников хоста и его ответ. `null` — сессию не усыплять. */
  function planFor(
    ref: SessionRef,
    entry: WorkEntry,
    session: WorkSession,
    handle: PtyHandle,
    sleepAfterMinutes: number,
  ): Plan | null {
    const key = refKey(ref);
    const asked = requested.get(key);
    const live = deps.activity.get(ref);
    const verdict = autoSleepVerdict({
      session,
      claudeCode: isClaudeCode(session.provider),
      activity: sinceLaunch(live?.activity ?? null, handle.startedAt),
      // Как у будильника: хуки процесса были с его запуска.
      hooked: hookedSince(live?.activity, handle.startedAt),
      hasDraft: handle.hasDraft(),
      pointerInFlight: deps.wake.inFlight(ref),
      unread: unreadCount(entry.projectPath, entry.map.work.id, session.id, { map: entry.map }).total,
      compacting: deps.compacting(ref),
      waitStartedAt: waits.get(key)?.since ?? null,
      now: now(),
      enabled: sleepAfterMinutes > 0,
      // Просьба `requestSleep` — без порога, остальное — по настройке.
      thresholdMs: asked === undefined ? sleepAfterMinutes * 60_000 : 0,
      allowWaiters: ALLOW_WAITER_SLEEP,
    });
    if (!verdict.sleep) return null;
    return { reason: asked ?? 'idle', idleSince: verdict.idleSince, waitTarget: verdict.waitTarget };
  }

  /**
   * Снимает отметку «засыпает» с сессии, которая осталась `active`: ключ удаляется, а не пишется `null`. Под замком карты;
   * отметки уже нет — не делает ничего. Возвращает, снята ли она.
   */
  async function dropMark(ref: SessionRef): Promise<boolean> {
    let dropped = false;
    await updateMap(
      ref.projectPath,
      ref.workId,
      (map) => {
        const current = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (current?.lifecycle !== 'active' || current.autoSleepPending == null) return;
        delete current.autoSleepPending;
        dropped = true;
      },
      // Служебная пометка, не событие работы: карточка работы не всплывает в сайдбаре.
      { touch: false },
    );
    return dropped;
  }

  /**
   * Через `SURVIVOR_CHECK_MS` после сна пишет в журнал потомков агента, что остались живы (спека 4.6); не пережил никто —
   * не пишет ничего. Ничего не убивает.
   */
  function watchSurvivors(ref: SessionRef, pids: readonly number[]): void {
    // Сервис остановлен, пока сессию усыпляли: журнал после остановки не пишем.
    if (stopped) return;
    const survivorTimer = setTimeout(() => {
      survivorTimers.delete(survivorTimer);
      const survivors = alivePids(pids, deps.isAlive);
      if (survivors.length > 0) host.log.warn('потомки пережили сон агента', { ref, pids: survivors });
    }, SURVIVOR_CHECK_MS);
    survivorTimer.unref();
    survivorTimers.add(survivorTimer);
  }

  /** Усыпляет сессию (шаги 1–4). `true` — сессия ушла в сон. */
  async function sleepSession(ref: SessionRef, plan: Plan): Promise<boolean> {
    const idleSince = new Date(plan.idleSince).toISOString();
    const mark: AutoSleep = { reason: plan.reason, at: new Date(now()).toISOString(), waitTarget: plan.waitTarget };

    // 1. Под замком карты письма и карта в одной записи: письмо, пришедшее или выданное после снимка, отменяет сон.
    // Выданное письмо (`readBy` позже начала простоя) модель ещё не видела, хотя непрочитанным оно уже не числится.
    const check: { cancelled: string | null } = { cancelled: null };
    await updateMap(
      ref.projectPath,
      ref.workId,
      (map, letters) => {
        const current = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        if (current === undefined || current.lifecycle !== 'active') check.cancelled = 'not-active';
        else if (current.autoSleepPending != null) check.cancelled = 'pending';
        else if (current.keepAwake === true) check.cancelled = 'keep-awake';
        else if (current.switching != null) check.cancelled = 'switching';
        else if (letters.unreadFor(ref.sessionId).length > 0) check.cancelled = 'unread';
        else if (deliveredSince(letters, ref.sessionId, idleSince)) check.cancelled = 'delivered';
        if (current === undefined || check.cancelled !== null) return;
        current.autoSleepPending = mark;
      },
      { touch: false },
    );
    if (check.cancelled !== null) {
      host.log.info('сон отменён под замком карты', { ref, reason: plan.reason, why: check.cancelled });
      return false;
    }

    // Потомков CLI запоминаем до остановки: когда родитель выйдет, их усыновит init, и родство пропадёт (спека 4.6).
    const rootPid = deps.pty.get(ref)?.pid;
    const descendants = rootPid === undefined ? [] : await collectDescendants(rootPid);

    // 2. Тот же `stop`, что у кнопки Stop: ждёт выхода процесса и записи перехода в `sleeping`.
    try {
      await deps.sessions.stop(ref);
    } catch (error) {
      host.log.warn('остановка агента при усыплении не удалась', { ref, error: String(error) });
    }

    // 3. Сессия осталась `active` с отметкой: письма на ней застряли бы, пока отметка стоит.
    if (await dropMark(ref)) {
      host.log.warn('агент не уснул: сессия осталась active, отметка «засыпает» снята', { ref, reason: plan.reason });
      return false;
    }

    // 4. Письма, пришедшие, пока стояла отметка, ждали за оградой, а будильник при выходе процесса мог записать их как
    // уже указанные (`markUnreadPointed`): сами они сессию не поднимут. `retry` забывает указанное у сессии без процесса
    // и пересчитывает её — письма поднимут её обычным путём, как бы поздно ни обновился снимок работ.
    deps.wake.retry(ref);
    host.log.info('агент усыплён', {
      ref,
      reason: plan.reason,
      idleMin: Math.round((now() - plan.idleSince) / 60_000),
    });
    watchSurvivors(ref, descendants);
    return true;
  }

  /**
   * Пишет усыплённому письмо о том, что стало с целью его `wait_for(<id>)`, и снимает цель ожидания. Одна запись, решающая
   * проверка под замком карты: снимок работ отстаёт от базы, и за это время сессию могли поднять или письмо могла записать
   * другая проверка — тогда не пишется ничего. Не бросает: сбой одной записи не должен остановить проход по остальным.
   */
  async function notifyWaiter(ref: SessionRef, targetId: string): Promise<void> {
    const done: { state: string | null } = { state: null };
    try {
      await updateMap(
        ref.projectPath,
        ref.workId,
        (map, letters) => {
          const sleeper = map.sessions.find((candidate) => candidate.id === ref.sessionId);
          if (sleeper?.lifecycle !== 'sleeping' || sleeper.autoSleep?.waitTarget !== targetId) return;
          const state = targetState(map.sessions.find((candidate) => candidate.id === targetId));
          if (state === null) return;
          letters.add({
            roomId: null,
            from: SYSTEM,
            to: [ref.sessionId],
            text: waiterLetter(targetId, state),
            kind: 'note',
          });
          // Причина и время сна остаются: сессия спит по-прежнему, письмо поднимет её будильником.
          sleeper.autoSleep = { ...sleeper.autoSleep, waitTarget: null };
          done.state = state;
        },
        // Служебная запись, не событие работы: карточка работы не всплывает в сайдбаре.
        { touch: false },
      );
    } catch (error) {
      host.log.error('сон агентов: письмо усыплённому о цели его ожидания не записалось', { ref, error: String(error) });
      return;
    }
    if (done.state !== null) {
      host.log.info('усыплённому записано письмо о цели его ожидания', {
        ref,
        target: targetId,
        state: done.state,
      });
    }
  }

  /**
   * Проход по снимку работ: каждому `sleeping` с целью ожидания, о которой есть что сказать (`targetState`), — письмо. У
   * спящих нет PTY, поэтому цикл по `pty.list()` их не видит. Зовут подписчик службы работ и таймер.
   */
  async function notifyWaiters(): Promise<void> {
    if (stopped) return;
    for (const entry of deps.works.snapshot().entries) {
      for (const session of entry.map.sessions) {
        const targetId = session.lifecycle === 'sleeping' ? session.autoSleep?.waitTarget : null;
        if (targetId == null) continue;
        if (targetState(entry.map.sessions.find((candidate) => candidate.id === targetId)) === null) continue;
        if (stopped) return;
        await notifyWaiter({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id }, targetId);
      }
    }
  }

  /**
   * Проверяет одну сессию и усыпляет, если пора. `config` передаёт таймер: настройки читаются раз на проход, а не на
   * каждую сессию. Не бросает: сбой одной сессии не должен остановить проход по остальным.
   */
  async function consider(ref: SessionRef, config?: { sleepAfterMinutes: number }): Promise<void> {
    const key = refKey(ref);
    if (stopped || inWork.has(key) || deps.pty.get(ref) === undefined) return;
    inWork.add(key);
    try {
      const { sleepAfterMinutes } = config ?? (await deps.config());
      if (stopped) return;
      // Дальше до отметки в карте — ни одного `await`: решение и отметка видят одно и то же состояние хоста.
      const found = locate(ref);
      const handle = deps.pty.get(ref);
      // Нет в карте (помощник острова) или процесса этого хоста уже нет.
      if (found === undefined || handle === undefined) return;
      const { entry, session } = found;
      // Идёт замена агента (спека замены агента, 6.3): сон встал бы поперёк неё.
      if (session.switching != null) return;
      if (session.autoSleepPending != null) {
        // Сессия не в середине сна (вторую проверку той же сессии `inWork` не пускает): отметку оставил сбой прошлого сна.
        if (await dropMark(ref)) host.log.warn('отметка «засыпает» осталась на живой сессии, снята', { ref });
        return;
      }
      const plan = planFor(ref, entry, session, handle, sleepAfterMinutes);
      if (plan !== null && (await sleepSession(ref, plan))) requested.delete(key);
    } catch (error) {
      host.log.error('сон агентов: проверка сессии не удалась', { ref, error: String(error) });
    } finally {
      inWork.delete(key);
    }
  }

  /** Сначала письма ждавшим усыплённым, затем проход по живым PTY хоста, по одной сессии за раз. */
  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      await notifyWaiters();
      const live = deps.pty.list();
      forget(live);
      const config = await deps.config();
      for (const handle of live) {
        if (stopped) break;
        await consider(handle.ref, config);
      }
    } catch (error) {
      host.log.error('сон агентов: проход не удался', { error: String(error) });
    } finally {
      ticking = false;
    }
  }

  /** Изменилась активность сессии: ведём начало ожидания и, если сессия не работает, проверяем её. */
  function onActivity(ref: SessionRef, live: SessionLive): void {
    try {
      const { activity, waitingFor } = live.activity;
      trackWait(refKey(ref), waitingFor);
      // Работающей сессии (не в `wait_for`) усыплять нечего — ради неё настройки с диска не читаем.
      if (activity !== 'working' || waitingFor !== null) void consider(ref);
    } catch (error) {
      // Слушателя зовёт пересчёт активности: его сбой не должен мешать остальным подписчикам.
      host.log.error('сон агентов: разбор изменения активности не удался', { ref, error: String(error) });
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = deps.activity.onChange(onActivity);
      unsubscribeWorks = deps.works.onChange(() => {
        void notifyWaiters();
      });
      timer = setInterval(() => {
        void tick();
      }, tickMs);
      timer.unref();
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeWorks?.();
      unsubscribeWorks = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const survivorTimer of survivorTimers) clearTimeout(survivorTimer);
      survivorTimers.clear();
      waits.clear();
      requested.clear();
    },

    requestSleep(ref, reason) {
      requested.set(refKey(ref), reason);
      void consider(ref);
    },
  };
}
