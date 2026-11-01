/**
 * Жизненный цикл роя (спека роя v1, 3): один сервис хоста сверяет рои на каждом снимке работ — по образцу `stopRetired`
 * в `sessions-service.ts` — и по своему таймеру раз в 30 с, потому что у зависшего роя снимков может не быть. Поэтому
 * переходы переживают перезапуск хоста и не зависят от того, дошёл ли ответ модели.
 *
 * Сверка одной работы — одна запись карты (`updateMap`), в которой решения принимаются по карте под замком, а не по снимку:
 * повторная сверка ничего не меняет. Побочное (закрытие сессий, уведомление человеку) идёт после записи:
 * - сдача трутня: `handedAt` пишется раньше закрытия, и после падения хоста сверка дозакрывает сданного, но живого участника;
 * - итог создателю доходит «как минимум один раз»: письмо пишется в той же записи, что `deliveredAt`, уведомление человеку
 *   уходит раньше `deliveredAt`, и недоставленный итог при следующей сверке или перезапуске отправляется снова.
 *
 * Королеву завершённого роя хост не закрывает, а просит сервис сна её усыпить, как только итог доставлен (спека сна агентов,
 * 4.1): работа кончена, продолжить разговор можно письмом или кнопкой Resume. Просьба уходит, пока королева после этой
 * доставки ещё не засыпала по концу роя; иначе её, поднятую человеком, усыпляла бы каждая следующая сверка.
 *
 * Карта не помнит, кто закрыл королеву: человек — методом `sessions.close`, а агент — своим `close_session` прямо в карте.
 * Метод зовёт `humanClosed` до закрытия, и сверка отличает отмену от падения по этой памяти хоста (после перезапуска между
 * закрытием и сверкой она теряется, и закрытая без сдачи королева считается упавшей).
 */

import {
  PARLEY,
  SWARM_SUMMARY_MAX,
  isRoomArchived,
  isSwarmExpired,
  isSwarmTerminal,
  limitsFromConfig,
  liveLead,
  loadConfig,
  parleyNote,
  swarmOfSession,
  swarmProgress,
  updateMap,
} from '@parley/core';
import type { LetterTx, ResourceLimits, SwarmStatus, WorkMap, WorkSession, WorkSwarm } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { NoticeKind, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { AutoSleepService } from '../sleep/auto-sleep-service.js';
import type { WorksService } from '../works/works-service.js';

/** Как часто сервис сверяет рои сам, не дожидаясь снимка (3.0). */
export const SWARM_TICK_MS = 30_000;
/** Сколько после `expiredAt` ждать `report` королевы, прежде чем отдать итог без сводки (3.0). */
export const SWARM_EXPIRY_GRACE_MS = 10 * 60_000;

export interface SwarmsServiceOptions {
  /** Часы; тесты подставляют свои. */
  now?: () => number;
  /** Срок жизни роя; по умолчанию из настроек хоста. */
  limits?: () => Promise<Pick<ResourceLimits, 'swarmMinutes'>>;
}

export interface SwarmsService {
  /** Подписка на снимки работ, таймер и первая сверка. */
  start(): void;
  /** Снимает подписку и таймер и ждёт начатую сверку и закрытия. */
  stop(): Promise<void>;
  /** Одна сверка; сверки идут по очереди, наложившиеся вызовы склеиваются в одну следующую. */
  reconcile(): Promise<void>;
  /** Человек закрывает сессию через `sessions.close`: закрытая так королева отменяет рой, а не роняет его. */
  humanClosed(ref: SessionRef): void;
}

/** Итог роя уходит человеку уведомлением; пишет его сервис после записи карты. */
interface Notice {
  swarmId: string;
  ref: SessionRef;
  kind: NoticeKind;
  text: string;
}

/** Побочное сверки одной работы. */
interface Effects {
  close: string[];
  /** Королевы доставленных роёв, которым пора уснуть. */
  sleep: string[];
  notices: Notice[];
}

/** Итог не длиннее предела; полный текст читается из сессии королевы (`get_map`). */
function cutSummary(text: string): string {
  return text.length > SWARM_SUMMARY_MAX ? `${text.slice(0, SWARM_SUMMARY_MAX - 1)}…` : text;
}

/** `m:ss` от создания до конца. */
function elapsed(swarm: WorkSwarm, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - Date.parse(swarm.createdAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Живая сессия: есть в карте и не закрыта. */
const isLive = (session: WorkSession | undefined): session is WorkSession =>
  session !== undefined && session.lifecycle !== 'closed';

/** Участник уже не работает: сдал, упал, закрыт или удалён. */
function isSettled(session: WorkSession | undefined, handedAt: string | null): boolean {
  return handedAt !== null || session === undefined || session.lifecycle === 'closed' || session.result === 'failed';
}

/** Итог просроченного роя ушёл без сводки, а королева потом сдала `report` со сводкой. */
function lateReport(map: WorkMap, swarm: WorkSwarm): boolean {
  if (swarm.expiredAt === null || swarm.result === null || swarm.result.deliveredAt === null || swarm.result.summary !== '') return false;
  const queen = map.sessions.find((session) => session.id === swarm.queen);
  return queen?.result != null && (queen.summary ?? '') !== '';
}

/** Рою нужна сверка: он идёт, его итог не доставлен или в нём ещё есть живые трутни и проверяющие. */
function needsReconcile(map: WorkMap, swarm: WorkSwarm): boolean {
  if (!isSwarmTerminal(swarm.status) || swarm.result === null || swarm.result.deliveredAt === null) return true;
  if (lateReport(map, swarm)) return true;
  return swarm.members.some(
    (member) => member.role !== 'queen' && isLive(map.sessions.find((session) => session.id === member.sessionId)),
  );
}

/**
 * Королеве пора уснуть: итог роя доставлен, она `active` и после этой доставки ещё не засыпала по концу роя
 * (запись истории `sleeping` с причиной `swarm-done` не раньше `deliveredAt`).
 */
function queenAwaitsSleep(map: WorkMap, swarm: WorkSwarm): boolean {
  const deliveredAt = swarm.result?.deliveredAt;
  if (deliveredAt == null || !isSwarmTerminal(swarm.status)) return false;
  const queen = map.sessions.find((session) => session.id === swarm.queen);
  if (queen?.lifecycle !== 'active') return false;
  const since = Date.parse(deliveredAt);
  return !queen.history.some(
    (entry) => entry.event === 'sleeping' && entry.reason === 'swarm-done' && Date.parse(entry.at) >= since,
  );
}

export function createSwarmsService(
  host: HostContext,
  works: Pick<WorksService, 'snapshot' | 'onChange'>,
  sessions: Pick<SessionsService, 'close'>,
  options: SwarmsServiceOptions = {},
  /** Сервис сна: королеве завершённого роя пора спать. Без него королеву не трогают. */
  autoSleep?: Pick<AutoSleepService, 'requestSleep'>,
): SwarmsService {
  const now = options.now ?? Date.now;
  const readLimits =
    options.limits ??
    (async () => {
      const { config } = await loadConfig();
      return limitsFromConfig(config);
    });

  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  /** Закрытия трутней и проверяющих в полёте: повторная сверка их не дублирует. */
  const closing = new Map<string, Promise<void>>();
  /** Королевы, которых человек закрыл (`humanClosed`); запись снимается сверкой. */
  const closedByHuman = new Set<string>();

  /** Письмо королеве от `parley`: вне комнаты, как письма хоста сессиям. */
  function noteQueen(letters: LetterTx, queen: WorkSession | undefined, text: string, at: string): void {
    if (isLive(queen)) letters.add({ from: PARLEY, to: [queen.id], roomId: null, kind: 'note', text, at });
  }

  /** Текст итога создателю (3.3): заголовок, сводка и путь к полному отчёту королевы. */
  function deliveryText(swarm: WorkSwarm, endMs: number): string {
    const { handed, total } = swarmProgress(swarm);
    const verdict = swarm.status === 'done' ? 'done' : swarm.status === 'cancelled' ? 'cancelled' : 'failed';
    const head = `Swarm ${swarm.id} [${swarm.tag}] ${verdict}, ${handed}/${total} handed in, ${elapsed(swarm, endMs)}`;
    const reason = swarm.status === 'done' || swarm.failure === null ? '' : `\nReason: ${swarm.failure}`;
    const summary = swarm.result?.summary ?? '';
    const tail = `\n\nThe queen's full report: get_map {session: "${swarm.queen}", field: "summary"}`;
    if (summary !== '') return `${head}${reason}\n\n${summary}${tail}`;
    return `${head}${reason}${swarm.expiredAt === null ? '' : '\n\nThe time limit ran out and the queen did not report.'}`;
  }

  /**
   * Итог создателю. `true` — доставлен письмом в этой же записи; `false` — письма некому писать, итог идёт человеку
   * (`creator` — человек, сессия закрыта, комната в архиве, удалена или без живого ведущего).
   */
  function deliverByLetter(map: WorkMap, letters: LetterTx, swarm: WorkSwarm, text: string, at: string): boolean {
    const { creator } = swarm;
    if (creator.kind === 'session') {
      const target = map.sessions.find((session) => session.id === creator.sessionId);
      if (!isLive(target)) return false;
      letters.add({ from: PARLEY, to: [target.id], roomId: null, kind: 'note', text, at });
      return true;
    }
    if (creator.kind === 'room') {
      const room = map.rooms.find((candidate) => candidate.id === creator.roomId);
      if (room === undefined || isRoomArchived(room)) return false;
      const lead = liveLead(map, room);
      if (lead === null) return false;
      parleyNote(map, letters, room.id, lead, text, at);
      return true;
    }
    return false;
  }

  function reconcileSwarm(
    map: WorkMap,
    letters: LetterTx,
    swarm: WorkSwarm,
    projectPath: string,
    limits: Pick<ResourceLimits, 'swarmMinutes'> | null,
    effects: Effects,
  ): void {
    const nowMs = now();
    const at = new Date(nowMs).toISOString();
    const sessionOf = (id: string): WorkSession | undefined => map.sessions.find((session) => session.id === id);
    const queen = sessionOf(swarm.queen);
    const workers = swarm.members.filter((member) => member.role !== 'queen');
    const queenSummary = (): string => (queen?.summary == null ? '' : cutSummary(queen.summary));
    const end = (status: SwarmStatus, failure: string | null): void => {
      swarm.status = status;
      swarm.failure = failure;
      swarm.endedAt = at;
    };
    // Итог доставлен: королеве пора спать. Повтор на каждой сверке безвреден — сервис сна держит просьбу, пока она не сбудется.
    const sleepQueen = (): void => {
      if (queenAwaitsSleep(map, swarm)) effects.sleep.push(swarm.queen);
    };

    // Сдача (3.2): сначала запись `handedAt`, закрытие — после неё и без согласия человека. `progress` не сдаёт.
    for (const member of workers) {
      const session = sessionOf(member.sessionId);
      if (member.handedAt === null && session?.result === 'done') member.handedAt = session.resultAt ?? at;
    }

    if (!isSwarmTerminal(swarm.status)) {
      const queenRef = refKey({ projectPath, workId: map.work.id, sessionId: swarm.queen });
      if (queen?.result === 'done') {
        end('done', null);
        swarm.result = { summary: queenSummary(), at, deliveredAt: null };
      } else if (queen?.result === 'failed') {
        end('failed', 'the queen reported failure');
        swarm.result = { summary: queenSummary(), at, deliveredAt: null };
      } else if (queen?.lifecycle === 'closed') {
        // Закрытие королевы без сдачи: человек отменяет рой, всё остальное его роняет.
        if (closedByHuman.delete(queenRef)) end('cancelled', 'the queen was closed by the human');
        else end('failed', 'the queen was closed without a report');
      } else if (limits !== null && isSwarmExpired(swarm, limits, nowMs)) {
        // Срок жизни (3.0): одна запись, участников закрывает общий код терминального состояния, королеве — письмо.
        end('failed', `time limit: ${limits.swarmMinutes} min`);
        swarm.expiredAt = at;
        noteQueen(
          letters,
          queen,
          `The time limit of swarm ${swarm.id} has run out (${limits.swarmMinutes} min). All members are closed. ` +
            'Hand in what you have: call report with a summary of what was collected and a note that not everything was covered.',
          at,
        );
      } else if (
        swarm.status === 'running' &&
        workers.length > 0 &&
        workers.every((member) => isSettled(sessionOf(member.sessionId), member.handedAt))
      ) {
        swarm.status = 'collecting';
        noteQueen(letters, queen, `All members of swarm ${swarm.id} have handed in. Write the summary: call report with the combined result.`, at);
      }
    }

    // Терминальный рой: таймер встал; участников закрывает хост, королеву — нет.
    const terminal = isSwarmTerminal(swarm.status);
    if (terminal && swarm.endedAt === null) swarm.endedAt = at;
    for (const member of workers) {
      const session = sessionOf(member.sessionId);
      if (isLive(session) && (terminal || member.handedAt !== null || session.result === 'failed')) {
        effects.close.push(session.id);
      }
    }
    if (!terminal) return;
    // Королева сдала после срока ожидания: итог без сводки уже ушёл, теперь уходит ещё раз со сводкой (дубль безвреден).
    if (lateReport(map, swarm)) swarm.result = { summary: queenSummary(), at, deliveredAt: null };
    if (swarm.result?.deliveredAt != null) {
      sleepQueen();
      return;
    }

    // Итог просроченного роя ждёт `report` королевы, но не дольше `SWARM_EXPIRY_GRACE_MS` (3.0).
    if (
      swarm.expiredAt !== null &&
      isLive(queen) &&
      queen.result === null &&
      nowMs < Date.parse(swarm.expiredAt) + SWARM_EXPIRY_GRACE_MS
    ) {
      return;
    }
    swarm.result ??= { summary: queen?.result == null ? '' : queenSummary(), at, deliveredAt: null };
    const text = deliveryText(swarm, Date.parse(swarm.endedAt ?? at));
    if (deliverByLetter(map, letters, swarm, text, at)) {
      swarm.result.deliveredAt = at;
      sleepQueen();
      return;
    }
    effects.notices.push({
      swarmId: swarm.id,
      ref: { projectPath, workId: map.work.id, sessionId: swarm.queen },
      kind: swarm.status === 'done' ? 'swarm-done' : 'swarm-failed',
      text,
    });
  }

  function closeMember(ref: SessionRef): void {
    const key = refKey(ref);
    if (closing.has(key)) return;
    const task = sessions
      .close(ref)
      .catch((error: unknown) => {
        host.log.error('закрытие участника роя не удалось', { ref, error: String(error) });
      })
      .finally(() => closing.delete(key));
    closing.set(key, task);
  }

  /** Итог доставлен уведомлением человеку — только теперь `deliveredAt`. `true` — королеве пора уснуть. */
  async function markDelivered(notice: Notice): Promise<boolean> {
    let sleep = false;
    await updateMap(
      notice.ref.projectPath,
      notice.ref.workId,
      (map) => {
        const swarm = map.swarms?.find((candidate) => candidate.id === notice.swarmId);
        if (swarm?.result != null && swarm.result.deliveredAt === null) {
          swarm.result.deliveredAt = new Date(now()).toISOString();
          sleep = queenAwaitsSleep(map, swarm);
        }
      },
      { touch: false },
    );
    return sleep;
  }

  async function reconcileWork(projectPath: string, workId: string, limits: Pick<ResourceLimits, 'swarmMinutes'> | null): Promise<void> {
    const effects: Effects = { close: [], sleep: [], notices: [] };
    await updateMap(projectPath, workId, (map, letters) => {
      for (const swarm of map.swarms ?? []) reconcileSwarm(map, letters, swarm, projectPath, limits, effects);
    });
    for (const sessionId of effects.close) closeMember({ projectPath, workId, sessionId });
    for (const sessionId of effects.sleep) autoSleep?.requestSleep({ projectPath, workId, sessionId }, 'swarm-done');
    for (const notice of effects.notices) {
      host.broadcast('host.notice', { kind: notice.kind, ref: notice.ref, text: notice.text, at: new Date(now()).toISOString() });
      // Королева — `notice.ref`: итог человеку идёт от её имени. Просят уже после записи `deliveredAt`.
      if (await markDelivered(notice)) autoSleep?.requestSleep(notice.ref, 'swarm-done');
    }
  }

  async function pass(): Promise<void> {
    const entries = works
      .snapshot()
      .entries.filter((entry) => (entry.map.swarms ?? []).some((swarm) => needsReconcile(entry.map, swarm)));
    if (entries.length === 0) return;
    // Срок жизни нужен, только пока есть идущий рой.
    const watching = entries.some((entry) => (entry.map.swarms ?? []).some((swarm) => !isSwarmTerminal(swarm.status)));
    const limits = watching ? await readLimits().catch(() => null) : null;
    for (const entry of entries) {
      if (stopped) return;
      try {
        await reconcileWork(entry.projectPath, entry.map.work.id, limits);
      } catch (error) {
        host.log.error('сверка роёв не удалась', { projectPath: entry.projectPath, workId: entry.map.work.id, error: String(error) });
      }
    }
  }

  function reconcile(): Promise<void> {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const trigger = (): void => {
    void reconcile();
  };

  return {
    start() {
      stopped = false;
      unsubscribe = works.onChange(trigger);
      timer = setInterval(trigger, SWARM_TICK_MS);
      timer.unref();
      trigger();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
      await Promise.all(closing.values());
    },
    reconcile,
    humanClosed(ref) {
      const entry = works.snapshot().entries.find(
        (candidate) => candidate.projectPath === ref.projectPath && candidate.map.work.id === ref.workId,
      );
      const found = entry === undefined ? null : swarmOfSession(entry.map, ref.sessionId);
      if (found?.member.role === 'queen' && !isSwarmTerminal(found.swarm.status)) closedByHuman.add(refKey(ref));
    },
  };
}
