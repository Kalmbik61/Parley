/**
 * Общий потолок машины (спека сна агентов и ёмкости 2026-10-30, 4.2): решение «стартовать, стартовать сверх потолка или
 * встать в очередь» и порядок самой очереди. Функции чистые — число живых CLI и резервов, давление памяти, часы и
 * запись в карту живут в `host/capacity/`, здесь только решение по снимку состояния, как у `autoSleepVerdict`.
 */

import type { MachineConcurrent } from '../config.js';
import { ENGINE, HUMAN, type LaunchClass, type MemoryPressure, type QueueReason, type QueuedLaunch } from './types.js';

/** Сколько живых сессий, запущенных человеком, могут стоять сверх потолка (спека 4.2, «Классы запусков»). */
export const HUMAN_OVERFLOW = 2;

/** Доля памяти машины под потолок `auto`: `round(RAM_ГиБ × 0.75)`. */
export const AUTO_MACHINE_SHARE = 0.75;

/** Место класса в очереди: меньше — раньше. Движок в очередь не встаёт. */
export const QUEUE_ORDER: Readonly<Record<QueuedLaunch['class'], number>> = { human: 0, mail: 1, agent: 2 };

/**
 * Потолок живых CLI по настройке и памяти машины: `off` — потолка нет (`null`), `auto` — три четверти памяти в ГиБ,
 * но не меньше одного, число — как есть (границы 1–128 держит разбор настройки).
 */
export function machineLimit(setting: MachineConcurrent, totalMemBytes: number): number | null {
  if (setting === 'off') return null;
  if (setting === 'auto') return Math.max(1, Math.round((totalMemBytes / 2 ** 30) * AUTO_MACHINE_SHARE));
  return setting;
}

/** Класс запуска по `LaunchChoice.by`: нет значения — человек, `wake` — письмо, `engine` — движок, id сессии — агент. */
export function launchClassOf(by: string | undefined): LaunchClass {
  if (by === undefined || by === HUMAN) return 'human';
  if (by === 'wake') return 'mail';
  if (by === ENGINE) return 'engine';
  return 'agent';
}

/**
 * Порядок очереди: сначала класс (`QUEUE_ORDER`), внутри класса — кто встал раньше. Время — ISO одной длины, поэтому
 * строки сравниваются как время. Отрицательное число — `a` раньше `b`, ноль — равны.
 */
export function compareQueued(a: Pick<QueuedLaunch, 'class' | 'at'>, b: Pick<QueuedLaunch, 'class' | 'at'>): number {
  const byClass = QUEUE_ORDER[a.class] - QUEUE_ORDER[b.class];
  if (byClass !== 0) return byClass;
  if (a.at === b.at) return 0;
  return a.at < b.at ? -1 : 1;
}

/**
 * Повторная постановка той же сессии в очередь: запись не теряет ни места, ни класса.
 * - время — более раннее из двух;
 * - класс — старший по `QUEUE_ORDER`, а `mode` и `by` — той записи, чей класс победил (при равенстве — новой);
 * - `reason`, `live` и `limit` — из новой: это снимок на момент последней постановки.
 */
export function mergeQueued(previous: QueuedLaunch | null | undefined, next: QueuedLaunch): QueuedLaunch {
  if (previous == null) return next;
  const winner = QUEUE_ORDER[previous.class] < QUEUE_ORDER[next.class] ? previous : next;
  return {
    ...next,
    class: winner.class,
    mode: winner.mode,
    by: winner.by,
    at: previous.at < next.at ? previous.at : next.at,
  };
}

/** Сколько записей очереди, кроме самой `self` (по ключу), идут раньше неё: `compareQueued(запись, self) < 0`. */
export function queuedAhead(
  entries: readonly { key: string; queued: Pick<QueuedLaunch, 'class' | 'at'> }[],
  self: { key: string; class: QueuedLaunch['class']; at: string },
): number {
  return entries.filter((entry) => entry.key !== self.key && compareQueued(entry.queued, self) < 0).length;
}

export interface AdmissionInput {
  launchClass: LaunchClass;
  /** Живые PTY хоста плюс взятые резервы, без самого этого запуска. */
  occupied: number;
  /** `machineLimit(...)`; `null` — потолок выключен. */
  limit: number | null;
  pressure: MemoryPressure;
  /** Живые сессии, запущенные человеком сверх потолка. */
  overflowLive: number;
  /** Записи очереди (не в продвижении), которые идут раньше этого запуска (`queuedAhead`). */
  ahead: number;
}

/** Исход допуска: старт, старт сверх потолка (только человеку) или очередь; у двух последних есть причина. */
export type Admission =
  | { kind: 'start' }
  | { kind: 'overflow'; reason: QueueReason }
  | { kind: 'queue'; reason: QueueReason };

/**
 * Решение допуска (спека 4.2, «Допуск запуска»). Правила идут по порядку, первое сработавшее и есть ответ:
 * 1. движок — старт: очередь его не касается;
 * 2. потолок выключен — старт: выключенный потолок отключает весь допуск, давление тоже;
 * 3. слот свободен (занято меньше потолка, давление не `critical`): впереди в очереди никого — старт, иначе очередь
 *    с причиной `machine-limit`, любому классу и человеку тоже: кто встал раньше, идёт первым, а этот запуск стартует
 *    следом;
 * 4. слота нет; причина: `critical` — `memory-critical`, иначе `machine-limit`;
 * 5. слота нет, запуск человека и сверх потолка живо меньше `HUMAN_OVERFLOW` — старт сверх потолка с этой причиной;
 * 6. иначе — очередь с этой причиной.
 * Сон ради слота (спека, «Допуск запуска», пункт 2) в функцию не входит: ему нужны часы и остановка процесса, то есть хост.
 */
export function machineAdmission(input: AdmissionInput): Admission {
  if (input.launchClass === 'engine') return { kind: 'start' };
  if (input.limit === null) return { kind: 'start' };
  const slotFree = input.occupied < input.limit && input.pressure !== 'critical';
  if (slotFree && input.ahead === 0) return { kind: 'start' };
  // Слот есть, но впереди ждут: сверх потолка не идёт никто, даже человек — он идёт только тогда, когда слота нет.
  if (slotFree) return { kind: 'queue', reason: 'machine-limit' };
  const reason: QueueReason = input.pressure === 'critical' ? 'memory-critical' : 'machine-limit';
  if (input.launchClass === 'human' && input.overflowLive < HUMAN_OVERFLOW) return { kind: 'overflow', reason };
  return { kind: 'queue', reason };
}

/** Ответ сервиса ёмкости хоста: решение и числа на момент решения. */
export type MachineTicket = Admission & { live: number; limit: number | null };
