import type { HealthSample } from '@parley/protocol';

/** Одиннадцать счётчиков окна строки состояния: сумма с прошлого тика `health-service`. */
export type WindowTally = Pick<
  HealthSample,
  | 'refreshCount'
  | 'refreshMs'
  | 'mapBytesParsed'
  | 'ptyBytes'
  | 'ptyChunks'
  | 'recomputes'
  | 'worksChangedEvents'
  | 'worksChangedBytes'
  | 'mailEvents'
  | 'mailBytes'
  | 'lettersOnlyRefreshes'
>;

/**
 * Счётчики окна для baseline «до/после» каскада карты. Создаётся в `host.ts` и передаётся тем сервисам, что
 * считают; читает и обнуляет их `health-service`. Своего состояния, кроме этих чисел, нет.
 */
export interface WindowCounters {
  /** Один проход `refresh` works-service (в том числе упавший): считается в его `finally`, `ms` — его длительность. */
  refresh(ms: number): void;
  /** Байты JSON карт после одного чтения списка: зовёт works-service там, где `readWorks` или наблюдатель вернули список; три перечитывания `readMap` внутри сервиса не считаются: `readMap` не отдаёт размер. */
  mapsParsed(bytes: number): void;
  /** Один кусок вывода PTY. */
  pty(bytes: number): void;
  /** Один пересчёт одной сессии (будильник или активность). */
  recompute(): void;
  /** Одна рассылка `works.changed` окнам: `bytes` — длина кадра, один раз на рассылку, не по клиентам (спека rooms.mail 6.12). */
  worksChanged(bytes: number): void;
  /** Одна рассылка `rooms.mail` окнам: `bytes` — длина кадра. */
  mail(bytes: number): void;
  /** Полный проход обновления, вызванный записью только писем: цель — ноль. */
  lettersOnlyRefresh(): void;
  read(): WindowTally;
  reset(): void;
}

const empty = (): WindowTally => ({
  refreshCount: 0,
  refreshMs: 0,
  mapBytesParsed: 0,
  ptyBytes: 0,
  ptyChunks: 0,
  recomputes: 0,
  worksChangedEvents: 0,
  worksChangedBytes: 0,
  mailEvents: 0,
  mailBytes: 0,
  lettersOnlyRefreshes: 0,
});

export function createWindowCounters(): WindowCounters {
  let tally = empty();
  return {
    refresh(ms) {
      tally.refreshCount += 1;
      tally.refreshMs += ms;
    },
    mapsParsed(bytes) {
      tally.mapBytesParsed += bytes;
    },
    pty(bytes) {
      tally.ptyChunks += 1;
      tally.ptyBytes += bytes;
    },
    recompute() {
      tally.recomputes += 1;
    },
    worksChanged(bytes) {
      tally.worksChangedEvents += 1;
      tally.worksChangedBytes += bytes;
    },
    mail(bytes) {
      tally.mailEvents += 1;
      tally.mailBytes += bytes;
    },
    lettersOnlyRefresh() {
      tally.lettersOnlyRefreshes += 1;
    },
    read: () => ({ ...tally }),
    reset() {
      tally = empty();
    },
  };
}

export const emptyWindowTally = empty;
