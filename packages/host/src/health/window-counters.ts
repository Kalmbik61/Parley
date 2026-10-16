import type { HealthSample } from '@parley/protocol';

/** Семь счётчиков окна строки состояния: сумма с прошлого тика `health-service`. */
export type WindowTally = Pick<
  HealthSample,
  'refreshCount' | 'refreshMs' | 'mapBytesParsed' | 'journalBytesRead' | 'ptyBytes' | 'ptyChunks' | 'recomputes'
>;

/**
 * Счётчики окна для baseline «до/после» каскада карты. Создаётся в `host.ts` и передаётся тем сервисам, что
 * считают; читает и обнуляет их `health-service`. Своего состояния, кроме шести чисел, нет.
 */
export interface WindowCounters {
  /** Один проход `refresh` works-service (в том числе упавший): считается в его `finally`, `ms` — его длительность. */
  refresh(ms: number): void;
  /** Байты JSON карт после одного чтения списка: зовёт works-service там, где `readWorks` или наблюдатель вернули список; три перечитывания `readMap` внутри сервиса не считаются: `readMap` не отдаёт размер. */
  mapsParsed(bytes: number): void;
  /** Байты журналов писем, прочитанные хвостом (`journal-tail.ts`): не карты, поэтому не в `mapsParsed`. */
  journalBytes(bytes: number): void;
  /** Один кусок вывода PTY. */
  pty(bytes: number): void;
  /** Один пересчёт одной сессии (будильник или активность). */
  recompute(): void;
  read(): WindowTally;
  reset(): void;
}

const empty = (): WindowTally => ({
  refreshCount: 0,
  refreshMs: 0,
  mapBytesParsed: 0,
  journalBytesRead: 0,
  ptyBytes: 0,
  ptyChunks: 0,
  recomputes: 0,
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
    journalBytes(bytes) {
      tally.journalBytesRead += bytes;
    },
    pty(bytes) {
      tally.ptyChunks += 1;
      tally.ptyBytes += bytes;
    },
    recompute() {
      tally.recomputes += 1;
    },
    read: () => ({ ...tally }),
    reset() {
      tally = empty();
    },
  };
}

export const emptyWindowTally = empty;
