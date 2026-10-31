import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryPressure, QueuedLaunch } from '@parley/core';
import type { CapacitySnapshot, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { CAPACITY_PUBLISH_MS, createCapacityFeed } from './capacity-feed.js';
import type { CapacityFeed, CapacityFeedDeps } from './capacity-feed.js';

const GB = 2 ** 30;

const refOf = (id: string): SessionRef => ({ projectPath: '/p', workId: 'w-01', sessionId: id });
const queuedOf = (at: string): QueuedLaunch => ({ class: 'agent', mode: 'launch', by: 's-01', reason: 'machine-limit', at, live: 4, limit: 4 });

let occupied = 3;
let queue: Array<{ ref: SessionRef; queued: QueuedLaunch }> = [];
let reading: { level: MemoryPressure; swapGb: number | null; at: number } = { level: 'normal', swapGb: null, at: 0 };
let machineConcurrent: 'off' | 'auto' | number = 4;
let sleepAfterMinutes = 60;
let sleepUnderPressureMinutes = 5;
let exitListeners: Array<() => void> = [];
let startListeners: Array<() => void> = [];
let worksListeners: Array<() => void> = [];
let readingListeners: Array<() => void> = [];
let broadcasts: Array<{ event: string; data: CapacitySnapshot }> = [];
let warnings: string[] = [];
let feed: CapacityFeed | undefined;

const unsubscribe = (list: Array<() => void>, listener: () => void): (() => void) => {
  list.push(listener);
  return () => {
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  };
};

const host = {
  broadcast: (event: string, data: CapacitySnapshot) => {
    broadcasts.push({ event, data });
  },
  log: { warn: (msg: string) => warnings.push(msg), info: () => {}, error: () => {} },
} as unknown as HostContext;

function make(over: Partial<CapacityFeedDeps> = {}): CapacityFeed {
  const made = createCapacityFeed(host, {
    capacity: { occupied: () => occupied, queue: () => queue },
    pressure: {
      current: () => reading,
      onReading: (listener) => unsubscribe(readingListeners, () => listener(reading)),
    },
    works: { onChange: (listener) => unsubscribe(worksListeners, listener) },
    pty: {
      on: ((event: string, listener: () => void) =>
        unsubscribe(event === 'start' ? startListeners : exitListeners, listener)) as never,
    },
    config: async () => ({ machineConcurrent, sleepAfterMinutes, sleepUnderPressureMinutes }),
    totalMemBytes: 16 * GB,
    ...over,
  });
  feed = made;
  return made;
}

const fire = (list: Array<() => void>): void => {
  for (const listener of [...list]) listener();
};

beforeEach(() => {
  vi.useFakeTimers();
  occupied = 3;
  queue = [];
  reading = { level: 'normal', swapGb: null, at: 0 };
  machineConcurrent = 4;
  sleepAfterMinutes = 60;
  sleepUnderPressureMinutes = 5;
  exitListeners = [];
  startListeners = [];
  worksListeners = [];
  readingListeners = [];
  broadcasts = [];
  warnings = [];
  feed = undefined;
});

afterEach(() => {
  feed?.stop();
  vi.useRealTimers();
});

describe('лента ёмкости: снимок', () => {
  it('snapshot: числа машины из сервиса, датчика и настроек', async () => {
    queue = [
      { ref: refOf('s-02'), queued: queuedOf('2026-10-31T10:00:00.000Z') },
      { ref: refOf('s-03'), queued: queuedOf('2026-10-31T10:01:00.000Z') },
    ];
    reading = { level: 'warn', swapGb: 4.26, at: 1 };

    const snapshot = await make().snapshot();

    expect(snapshot).toEqual({
      machine: { live: 3, limit: 4, queued: 2, pressure: 'warn', swapGb: 4.3, sleepMinutes: 5 },
      queue,
    });
  });

  it('snapshot: потолок выключен и сон выключен — limit и sleepMinutes пустые', async () => {
    machineConcurrent = 'off';
    sleepAfterMinutes = 0;

    const snapshot = await make().snapshot();

    expect(snapshot.machine).toMatchObject({ live: 3, limit: null, queued: 0, pressure: 'normal', swapGb: null, sleepMinutes: null });
  });
});

describe('лента ёмкости: рассылка', () => {
  it('одна на серию событий в пределах publishMs, повтора с тем же снимком нет', async () => {
    make().start();

    fire(worksListeners);
    fire(exitListeners);
    fire(readingListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS - 1);
    expect(broadcasts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.event).toBe('capacity.changed');
    expect(broadcasts[0]!.data.machine).toMatchObject({ live: 3, limit: 4, queued: 0 });

    // Те же числа: новая серия событий ничего не рассылает.
    fire(readingListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);
    expect(broadcasts).toHaveLength(1);

    // Числа сменились: рассылка есть.
    occupied = 4;
    fire(exitListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]!.data.machine.live).toBe(4);
  });

  it('publishMs из зависимостей заменяет умолчание', async () => {
    make({ publishMs: 50 }).start();

    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(50);

    expect(broadcasts).toHaveLength(1);
  });

  it('stop снимает подписки: событие после stop не рассылает', async () => {
    const made = make();
    made.start();
    made.stop();

    expect(exitListeners).toHaveLength(0);
    expect(startListeners).toHaveLength(0);
    expect(worksListeners).toHaveLength(0);
    expect(readingListeners).toHaveLength(0);

    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS * 2);
    expect(broadcasts).toEqual([]);
  });

  it('stop снимает таймер, который уже стоит', async () => {
    const made = make();
    made.start();
    fire(worksListeners);
    made.stop();

    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS * 2);
    expect(broadcasts).toEqual([]);
  });

  it('старт процесса PTY ставит рассылку: слот занят, числа сменились', async () => {
    const made = make();
    made.start();

    occupied = 4;
    fire(startListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.data.machine.live).toBe(4);
  });

  it('stop посреди снимка: уже считающийся снимок не рассылается', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const made = make({
      config: async () => {
        await gate;
        return { machineConcurrent, sleepAfterMinutes, sleepUnderPressureMinutes };
      },
    });
    made.start();

    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);
    made.stop();
    release!();
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);

    expect(broadcasts).toEqual([]);
  });

  it('stop, затем start: прежний снимок рассылается заново', async () => {
    const made = make();
    made.start();
    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);
    expect(broadcasts).toHaveLength(1);

    made.stop();
    made.start();
    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1]!.data).toEqual(broadcasts[0]!.data);
  });

  it('ошибка снимка — предупреждение в журнал, без исключения; следующее событие пробует снова', async () => {
    let fail = true;
    make({
      config: async () => {
        if (fail) throw new Error('диск недоступен');
        return { machineConcurrent, sleepAfterMinutes, sleepUnderPressureMinutes };
      },
    }).start();

    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);
    expect(broadcasts).toEqual([]);
    expect(warnings).toHaveLength(1);

    fail = false;
    fire(worksListeners);
    await vi.advanceTimersByTimeAsync(CAPACITY_PUBLISH_MS);
    expect(broadcasts).toHaveLength(1);
  });
});
