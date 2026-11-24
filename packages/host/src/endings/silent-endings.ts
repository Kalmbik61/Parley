/**
 * Служба «тихие концовки» (план 07, решения 1, 5–7): сессия с заданием вышла, упала, остановлена или закрыта человеком
 * без итога либо кончила ход без `report` — давшему задание и ведущему комнаты уходит одно письмо. Правила и тексты — в
 * core (`work/silent-endings.ts`); здесь решается только, КОГДА их звать: событие — одна запись карты под замком.
 *
 * Выход, Stop и Close сообщает `sessions-service` (он один знает причину выхода); конец хода служба ловит сама по
 * активности и проверяет через `SILENT_TURN_MS` по таймеру. Сбой записи — строка в журнале, наружу не бросается;
 * после `stop()` служба ничего не пишет.
 */

import {
  isRoomArchived,
  liveLead,
  silentTurnEnd,
  silentTurnStep,
  swarmOfSession,
  tellSilentEnding,
  updateMap,
  type LetterTx,
  type SilentEnding,
  type WorkMap,
} from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';

/** Сколько ход молчит без `report`, прежде чем сторож напомнит (решение 6). */
export const SILENT_TURN_MS = 5 * 60_000;
/** Как часто сторож смотрит, не созрел ли конец хода. */
export const SILENT_TURN_TICK_MS = 30_000;
/** Выход раньше этого срока после подъёма будильником — забота «did not resume» будильника (= его окно провала). */
export const EARLY_EXIT_MS = 5_000;

export interface SilentEndingsDeps {
  works: Pick<WorksService, 'entry'>;
  activity: Pick<ActivityService, 'get' | 'onChange'>;
  pty: Pick<PtyManager, 'get'>;
  now?: () => number;
  tickMs?: number;
}

export interface SilentEndings {
  start(): void;
  stop(): void;
  /** Процесс вышел сам (не по `stop`); `launch` — кто поднял процесс и сколько он прожил, `null` — неизвестно. */
  exited(ref: SessionRef, exit: { exitCode: number; signal?: number }, launch: { by: string; runMs: number } | null): Promise<void>;
  stoppedByHuman(ref: SessionRef): Promise<void>;
  closedByHuman(ref: SessionRef): Promise<void>;
  /** Конец хода ждёт проверки (c): сон хоста подождёт. */
  holdsSleep(ref: SessionRef): boolean;
  /** Один проход по созревшим концам хода: таймер и тесты. */
  checkTurns(): Promise<void>;
}

interface PendingTurn {
  ref: SessionRef;
  /** Конец хода (мс), как его считает `silentTurnEnd`. */
  end: number;
}

export function createSilentEndings(host: HostContext, deps: SilentEndingsDeps): SilentEndings {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? SILENT_TURN_TICK_MS;
  /** Концы хода, ждущие проверки. */
  const pending = new Map<string, PendingTurn>();
  /** Конец хода, который уже проверен: повторное событие активности его не заводит заново. */
  const checked = new Map<string, number>();
  let stopped = false;
  let checking = false;
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  const stamp = (): string => new Date(now()).toISOString();

  /** Сессию стоит ждать: активна, не в рое, не ведущий живой комнаты (о них пишут другие). */
  function watchable(map: WorkMap, sessionId: string): boolean {
    const session = map.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined || session.lifecycle !== 'active' || swarmOfSession(map, sessionId) !== null) return false;
    return !map.rooms.some((room) => !isRoomArchived(room) && room.members.includes(sessionId) && liveLead(map, room) === sessionId);
  }

  async function write(ref: SessionRef, mutate: (map: WorkMap, letters: LetterTx) => void): Promise<void> {
    if (stopped) return;
    try {
      await updateMap(ref.projectPath, ref.workId, (map, letters) => {
        if (!stopped) mutate(map, letters);
      });
    } catch (error) {
      host.log.error('служба тихих концовок не записала карту', { ref, error: String(error) });
    }
  }

  function forget(ref: SessionRef): void {
    const key = refKey(ref);
    pending.delete(key);
    checked.delete(key);
  }

  async function tell(ref: SessionRef, ending: SilentEnding): Promise<void> {
    forget(ref);
    await write(ref, (map, letters) => {
      tellSilentEnding(map, letters, ref.sessionId, ending, stamp());
    });
  }

  function onActivity(ref: SessionRef, value: SessionLive): void {
    if (stopped) return;
    const key = refKey(ref);
    const handle = deps.pty.get(ref);
    const end = handle === undefined ? null : silentTurnEnd(value.activity, handle.startedAt);
    if (end === null) {
      forget(ref);
      return;
    }
    if (checked.get(key) === end || pending.get(key)?.end === end) return;
    const entry = deps.works.entry(ref.projectPath, ref.workId);
    checked.delete(key);
    if (entry === undefined || !watchable(entry.map, ref.sessionId)) {
      pending.delete(key);
      return;
    }
    pending.set(key, { ref, end });
  }

  async function checkTurns(): Promise<void> {
    if (stopped || checking) return;
    checking = true;
    try {
      for (const [key, turn] of [...pending]) {
        if (stopped) return;
        if (now() - turn.end < SILENT_TURN_MS) continue;
        // Одна проверка на конец хода: созревший забывается, а событие активности с тем же концом не заводит его снова.
        pending.delete(key);
        const handle = deps.pty.get(turn.ref);
        if (handle === undefined) continue;
        if (silentTurnEnd(deps.activity.get(turn.ref)?.activity, handle.startedAt) !== turn.end) continue;
        checked.set(key, turn.end);
        if (handle.hasDraft()) continue;
        await write(turn.ref, (map, letters) => {
          silentTurnStep(map, letters, turn.ref.sessionId, stamp());
        });
      }
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      if (unsubscribe !== undefined) return;
      unsubscribe = deps.activity.onChange(onActivity);
      timer = setInterval(() => {
        void checkTurns();
      }, tickMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      pending.clear();
      checked.clear();
    },
    async exited(ref, exit, launch) {
      if (launch !== null && launch.by === 'wake' && launch.runMs < EARLY_EXIT_MS) {
        forget(ref);
        return;
      }
      await tell(ref, { kind: 'exit', exitCode: exit.exitCode, ...(exit.signal === undefined ? {} : { signal: exit.signal }) });
    },
    stoppedByHuman: (ref) => tell(ref, { kind: 'stop' }),
    closedByHuman: (ref) => tell(ref, { kind: 'close' }),
    holdsSleep: (ref) => pending.has(refKey(ref)),
    checkTurns,
  };
}
