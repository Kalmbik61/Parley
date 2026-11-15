/**
 * Слежение за сессией, которой помощник дал работу без подтверждения (спека автономии §6.2). Чистый модуль: часы,
 * таймеры, активность и обратные вызовы приходят снаружи; диска, ленты и процессов он не знает.
 *
 * Слежение ждёт СВОЙ ход: для письма и запуска с задачей — ход, начатый записью `prompt` в ленте после `since`
 * (её время — граница `boundary`); для ответа на запрос сессии граница — сам `since`. Пока границы нет, событий нет.
 * События: «конец хода» (после выдержки `WATCH_SETTLE_MS`, слежение после него снимается) и «ждёт человека» (сразу,
 * по одному на пару вид+начало эпизода). Одно событие сессии выдаётся один раз, сколько бы слежений на ней ни стояло.
 */

import type { SessionRef } from '@parley/protocol';

/** Выдержка «конца хода»: условие должно продержаться, иначе сессия вернулась к работе (RW-05). */
export const WATCH_SETTLE_MS = 3000;
/** Предел жизни слежения: после него оно снимается с заметкой. */
export const WATCH_MAX_MS = 2 * 60 * 60 * 1000;
/** Предел числа слежений: двадцать первое снимает старейшее с заметкой. */
export const WATCH_MAX_COUNT = 20;
/** Сколько последних сессий помнит `recent()`. */
export const RECENT_SESSIONS = 3;

/** Чем слежение поставлено: письмо/запуск с задачей (`prompt`) или ответ на запрос сессии (`resume`). */
export type WatchKind = 'prompt' | 'resume';

/** Что входит в событие слежения (снимок ответа добавляет сервис помощника). */
export interface WatchEvent {
  watchId: string;
  ref: SessionRef;
  name: string;
  /** `turn-end` — сессия закончила свой ход; `needs-human` — она ждёт человека. */
  event: 'turn-end' | 'needs-human';
  /** Ключ события: `turn:<turnEndedAt, мс>` или `need:<kind>:<need.since>`. Один ключ — одно событие на сессию. */
  key: string;
  /** Граница своего хода, мс. */
  boundary: number;
  /** Только `turn-end`: время конца хода, мс. */
  turnEndedAt?: number;
  /** Только `needs-human`: эпизод ожидания. */
  need?: { kind: string; since: string; detail: string | null };
}

/** Что слежению нужно от активности сессии. */
export interface WatchActivity {
  need: { kind: string; since: string; detail: string | null } | null;
}

export interface ReplyWatchDeps {
  now(): number;
  /** Таймер; возвращает отмену. */
  setTimer(fn: () => void, ms: number): () => void;
  onEvent(event: WatchEvent): void;
  /** Слежение снято по пределу или сроку: строка для человека. */
  onNote(note: string): void;
}

export interface RecentSession {
  ref: SessionRef;
  name: string;
  kind: WatchKind;
  /** Когда дана работа, мс. */
  since: number;
}

export interface ReplyWatch {
  /** Ставит слежение. `resume` на сессии, что уже под слежением, продолжает его же (один ответ — один конец хода). */
  arm(input: { ref: SessionRef; name: string; kind: WatchKind; since: number }): string;
  /** Активность сессии изменилась; `turnEnd` — результат `silentTurnEnd` (мс) или `null`. */
  onActivity(ref: SessionRef, activity: WatchActivity, turnEnd: number | null): void;
  /** В ленте сессии есть запись `prompt` со временем `at` (мс). */
  onPrompt(ref: SessionRef, at: number): void;
  /** Сессию закрывают или усыпляют: готовый конец хода выдаётся без выдержки, слежение снимается. */
  onClosing(ref: SessionRef): void;
  /** Режим выключен: все слежения снимаются без заметок. */
  clear(): void;
  /** Под слежением ли сессия. */
  watching(ref: SessionRef): boolean;
  /** Есть ли на сессии слежение, чей ход ещё не начался (ждёт записи `prompt` в ленте). */
  awaitingPrompt(ref: SessionRef): boolean;
  /** Сессии под слежением. */
  refs(): SessionRef[];
  /** Последние сессии, которым давали работу, новые первыми. */
  recent(): RecentSession[];
}

interface Watch {
  id: string;
  ref: SessionRef;
  name: string;
  since: number;
  /** `null` — свой ход ещё не начался. */
  boundary: number | null;
  /** Ждущая выдержка конца хода: его время и отмена таймера. */
  settling: { end: number; cancel: () => void } | null;
  cancelLimit: () => void;
}

const refKey = (ref: SessionRef): string => `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;

export function createReplyWatch(deps: ReplyWatchDeps): ReplyWatch {
  const watches = new Map<string, Watch>();
  /** Ключи выданных событий по сессии: живут, пока на сессии есть слежения. */
  const emitted = new Map<string, Set<string>>();
  /** Последний известный готовый конец хода сессии (мс) — для `onClosing`. */
  const lastEnd = new Map<string, number>();
  let recentList: RecentSession[] = [];
  let counter = 0;

  const watchesOf = (key: string): Watch[] => [...watches.values()].filter((watch) => refKey(watch.ref) === key);

  function drop(watch: Watch): void {
    watch.settling?.cancel();
    watch.cancelLimit();
    watches.delete(watch.id);
    const key = refKey(watch.ref);
    if (watchesOf(key).length === 0) {
      emitted.delete(key);
      lastEnd.delete(key);
    }
  }

  function seen(watch: Watch, key: string): boolean {
    return emitted.get(refKey(watch.ref))?.has(key) === true;
  }
  function mark(watch: Watch, key: string): void {
    const rk = refKey(watch.ref);
    const set = emitted.get(rk) ?? new Set<string>();
    set.add(key);
    emitted.set(rk, set);
  }

  function emitTurnEnd(watch: Watch, end: number): void {
    const rk = refKey(watch.ref);
    const key = `turn:${end}`;
    const boundary = watch.boundary;
    const duplicate = seen(watch, key);
    if (!duplicate) mark(watch, key);
    // Другие слежения этой сессии, чей ход начался до этого конца, ждали тот же ход: событие у них общее.
    for (const other of watchesOf(rk)) if (other.id !== watch.id && other.boundary !== null && other.boundary < end) drop(other);
    drop(watch);
    if (!duplicate && boundary !== null) deps.onEvent({ watchId: watch.id, ref: watch.ref, name: watch.name, event: 'turn-end', key, boundary, turnEndedAt: end });
  }

  function evaluate(watch: Watch, activity: WatchActivity, turnEnd: number | null): void {
    const boundary = watch.boundary;
    if (boundary === null) return;
    const need = activity.need;
    if (need !== null) {
      const since = Date.parse(need.since);
      const key = `need:${need.kind}:${need.since}`;
      if (!Number.isNaN(since) && since > boundary && !seen(watch, key)) {
        mark(watch, key);
        deps.onEvent({ watchId: watch.id, ref: watch.ref, name: watch.name, event: 'needs-human', key, boundary, need: { kind: need.kind, since: need.since, detail: need.detail } });
      }
    }
    if (turnEnd === null || turnEnd <= boundary) {
      // Условие конца хода не держится: выдержка начинается заново.
      watch.settling?.cancel();
      watch.settling = null;
      return;
    }
    if (watch.settling?.end === turnEnd) return;
    watch.settling?.cancel();
    const end = turnEnd;
    const cancel = deps.setTimer(() => {
      if (!watches.has(watch.id)) return;
      watch.settling = null;
      emitTurnEnd(watch, end);
    }, WATCH_SETTLE_MS);
    watch.settling = { end, cancel };
  }

  function remember(ref: SessionRef, name: string, kind: WatchKind, since: number): void {
    const key = refKey(ref);
    recentList = [{ ref, name, kind, since }, ...recentList.filter((item) => refKey(item.ref) !== key)].slice(0, RECENT_SESSIONS);
  }

  return {
    arm({ ref, name, kind, since }) {
      remember(ref, name, kind, since);
      if (kind === 'resume') {
        const existing = watchesOf(refKey(ref))[0];
        if (existing !== undefined) return existing.id;
      }
      if (watches.size >= WATCH_MAX_COUNT) {
        const oldest = watches.values().next().value as Watch | undefined;
        if (oldest !== undefined) {
          drop(oldest);
          deps.onNote(`Stopped waiting for a reply from ${oldest.name}`);
        }
      }
      counter += 1;
      const id = `w-${counter}`;
      const watch: Watch = { id, ref, name, since, boundary: kind === 'resume' ? since : null, settling: null, cancelLimit: () => {} };
      watch.cancelLimit = deps.setTimer(() => {
        if (!watches.has(id)) return;
        drop(watch);
        deps.onNote(`Stopped waiting for a reply from ${name}`);
      }, WATCH_MAX_MS);
      watches.set(id, watch);
      return id;
    },

    onActivity(ref, activity, turnEnd) {
      const key = refKey(ref);
      if (turnEnd === null) lastEnd.delete(key);
      else if (watchesOf(key).length > 0) lastEnd.set(key, turnEnd);
      for (const watch of watchesOf(key)) evaluate(watch, activity, turnEnd);
    },

    onPrompt(ref, at) {
      for (const watch of watchesOf(refKey(ref))) {
        if (watch.boundary !== null) continue;
        // Запись не позже постановки — прежний ход, не свой.
        if (at > watch.since) watch.boundary = at;
      }
    },

    onClosing(ref) {
      const key = refKey(ref);
      const end = lastEnd.get(key);
      for (const watch of watchesOf(key)) {
        const boundary = watch.boundary;
        if (end !== undefined && boundary !== null && end > boundary && !seen(watch, `turn:${end}`)) {
          emitTurnEnd(watch, end);
        } else {
          drop(watch);
        }
      }
    },

    clear() {
      for (const watch of [...watches.values()]) drop(watch);
      recentList = [];
    },

    watching: (ref) => watchesOf(refKey(ref)).length > 0,
    awaitingPrompt: (ref) => watchesOf(refKey(ref)).some((watch) => watch.boundary === null),
    refs: () => [...watches.values()].map((watch) => watch.ref),
    recent: () => [...recentList],
  };
}
