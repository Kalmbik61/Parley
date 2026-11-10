import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorkDb } from './db.js';
import { readLetters, unreadLetters, writeLetters, type LetterTx, type NewLetter } from './letter-store.js';
import { addSession, normalizeMap } from './map.js';
import { isPlainJsonTree, mapToRows, rowsToMap } from './map-rows.js';
import { addRoom } from './rooms.js';
import { createWork, onMapWritten, readMap, updateMap, workVersion, type MapWrittenEvent } from './store.js';
import { HUMAN, PARLEY, SYSTEM } from './types.js';

// Обёртки над настоящими функциями: считают вызовы, поведение прежнее.
vi.mock('./map-rows.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./map-rows.js')>();
  return {
    ...original,
    mapToRows: vi.fn(original.mapToRows),
    rowsToMap: vi.fn(original.rowsToMap),
    isPlainJsonTree: vi.fn(original.isPlainJsonTree),
  };
});
vi.mock('./map.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./map.js')>();
  return { ...original, normalizeMap: vi.fn(original.normalizeMap) };
});

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  vi.useRealTimers();
  closeWorkDb();
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const rebuilders = [normalizeMap, mapToRows, rowsToMap, isPlainJsonTree] as unknown as Array<ReturnType<typeof vi.fn>>;
const clearRebuilders = (): void => rebuilders.forEach((spy) => spy.mockClear());
const rebuilderCalls = (): number => rebuilders.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

/** Работа из `sessions` сессий и одной комнаты с тремя участниками; кэш карты после записи прогрет. */
const seed = async (sessions: number): Promise<string> => {
  const created = await createWork(project, { title: 'Big', goal: '' });
  await updateMap(project, created.work.id, (map) => {
    for (let i = 0; i < sessions; i += 1) addSession(map, { provider: 'claude', label: `S${i}`, task: 'x'.repeat(200) });
    addRoom(map, { title: 'Room', creator: 's-01', members: ['s-01', 's-02', 's-03'] });
  });
  return created.work.id;
};

const note = (over: Partial<NewLetter> = {}): NewLetter => ({
  roomId: 'r-01',
  from: 's-01',
  to: [],
  text: 'hello',
  kind: 'note',
  at: '2030-01-01T00:00:00.000Z',
  ...over,
});

describe('writeLetters: запись писем без пересборки карты', () => {
  it('письмо в работе из 300 сессий не нормализует и не раскладывает карту', async () => {
    const workId = await seed(300);
    clearRebuilders();

    writeLetters(project, workId, (letters) => {
      letters.add(note());
    });

    expect(rebuilderCalls()).toBe(0);
    expect(readLetters(project, workId, { limit: 10 })).toHaveLength(1);
  });

  it('карта, разобранная из базы, идёт общим путём один раз, дальше — быстрым', async () => {
    const workId = await seed(5);
    closeWorkDb();
    await readMap(project, workId);

    clearRebuilders();
    writeLetters(project, workId, (letters) => {
      letters.add(note());
    });
    expect(mapToRows).toHaveBeenCalled();

    clearRebuilders();
    writeLetters(project, workId, (letters) => {
      letters.add(note({ text: 'again' }));
    });
    expect(rebuilderCalls()).toBe(0);
  });

  it('после письма кэш равен свежей загрузке; updatedAt сдвинут, версия +1', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const workId = await seed(5);
    const before = await readMap(project, workId);
    const v0 = workVersion(project, workId)!;

    vi.setSystemTime(new Date('2030-01-02T00:00:00.000Z'));
    writeLetters(project, workId, (letters) => {
      letters.add(note());
    });

    const cached = await readMap(project, workId);
    closeWorkDb();
    const fresh = await readMap(project, workId);
    expect(cached).toStrictEqual(fresh);
    expect(fresh.work.updatedAt).toBe('2030-01-02T00:00:00.000Z');
    expect(fresh.work.updatedAt).not.toBe(before.work.updatedAt);
    expect(workVersion(project, workId)).toBe(v0 + 1);
  });

  it('событие письма прежнее; с touch: false updatedAt прежний', async () => {
    const workId = await seed(5);
    const events: MapWrittenEvent[] = [];
    const off = onMapWritten((event) => events.push(event));
    const v0 = workVersion(project, workId)!;
    const updatedAt = (await readMap(project, workId)).work.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeLetters(project, workId, (letters) => {
      letters.add(note());
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ structural: false, prevVersion: v0, version: v0 + 1 });
    expect(events[0]!.journal?.added).toHaveLength(1);
    const touched = (await readMap(project, workId)).work.updatedAt;
    expect(touched).not.toBe(updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeLetters(
      project,
      workId,
      (letters) => {
        letters.add(note({ text: 'quiet' }));
      },
      { touch: false },
    );
    off();
    expect(events[1]).toMatchObject({ structural: false, prevVersion: v0 + 1, version: v0 + 2 });
    expect((await readMap(project, workId)).work.updatedAt).toBe(touched);
  });

  it('deleteRoom внутри writeLetters: messageSeq в базе, структурная запись', async () => {
    const workId = await seed(5);
    writeLetters(project, workId, (letters) => {
      letters.add(note());
      letters.add(note({ text: 'two' }));
    });
    const events: MapWrittenEvent[] = [];
    const off = onMapWritten((event) => events.push(event));

    writeLetters(project, workId, (letters) => {
      letters.deleteRoom('r-01');
    });
    off();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ structural: true });
    expect(events[0]!.journal?.droppedRooms).toEqual(['r-01']);
    closeWorkDb();
    expect((await readMap(project, workId)).work.messageSeq).toBe(2);
  });

  it('пустая запись: версия та же, событий нет', async () => {
    const workId = await seed(5);
    const events: MapWrittenEvent[] = [];
    const off = onMapWritten((event) => events.push(event));
    const v0 = workVersion(project, workId);

    writeLetters(project, workId, () => undefined);
    off();

    expect(workVersion(project, workId)).toBe(v0);
    expect(events).toEqual([]);
  });

  it('в тестах fn получает замороженную копию: правка карты — TypeError, в базе прежнее', async () => {
    const workId = await seed(5);
    const v0 = workVersion(project, workId);

    expect(() =>
      writeLetters(project, workId, (_letters, map) => {
        (map.work as { title: string }).title = 'changed';
      }),
    ).toThrow(TypeError);

    closeWorkDb();
    expect((await readMap(project, workId)).work.title).toBe('Big');
    expect(workVersion(project, workId)).toBe(v0);
  });
});

describe('writeLetters: тот же результат, что у общего пути', () => {
  /** Одна и та же последовательность писем; `write` — быстрый путь (`writeLetters`) или общий (`updateMap` с теми же письмами). */
  type Write = (workId: string, run: (letters: LetterTx) => void) => Promise<void>;
  const viaFast: Write = async (workId, run) => {
    writeLetters(project, workId, (letters) => run(letters));
  };
  const viaGeneral: Write = async (workId, run) => {
    await updateMap(project, workId, (_map, letters) => run(letters));
  };

  const script = async (workId: string, write: Write): Promise<number[]> => {
    const versions: number[] = [];
    const step = async (run: (letters: LetterTx) => void): Promise<void> => {
      await write(workId, run);
      versions.push(workVersion(project, workId)!);
    };
    await step((letters) => {
      letters.add(note({ roomId: null, to: ['s-02'], text: 'direct' }));
    });
    await step((letters) => {
      letters.add(note({ text: 'broadcast' }));
    });
    await step((letters) => {
      letters.add(note({ text: 'with marks', readBy: { 's-02': '2030-01-01T00:00:00.000Z' } }));
    });
    await step((letters) => {
      letters.markRead('s-02', ['m-01', 'm-02'], '2030-01-01T00:00:01.000Z');
    });
    await step((letters) => {
      letters.add(note({ from: SYSTEM, roomId: null, to: ['s-01'], text: 'system' }));
      letters.add(note({ from: PARLEY, roomId: null, to: ['s-03'], text: 'parley' }));
    });
    await step((letters) => {
      letters.add(note({ from: HUMAN, text: 'human in room' }));
    });
    await step((letters) => {
      letters.add(note({ from: 's-02', roomId: null, to: [HUMAN], text: 'to human' }));
    });
    return versions;
  };

  const snapshot = async (workId: string): Promise<unknown> => {
    closeWorkDb();
    const map = await readMap(project, workId);
    return {
      map: { ...map, work: { ...map.work, id: 'w' } },
      letters: readLetters(project, workId, { limit: 1000 }),
      unread: ['s-01', 's-02', 's-03', 's-04', HUMAN].map((reader) => unreadLetters(project, workId, reader)),
    };
  };

  it('письма, отметки и кандидаты непрочитанного, карта и шаг версии совпадают; новичок с joinedSeq тоже', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const fast = await seed(4);
    const general = await seed(4);
    // Новичок: s-04 вошёл в комнату после второго письма; порог входа в карте.
    for (const id of [fast, general]) {
      await updateMap(project, id, (map) => {
        const room = map.rooms[0]!;
        room.members.push('s-04');
        room.joinedSeq = { 's-04': 2 };
      });
    }
    const base = { fast: workVersion(project, fast)!, general: workVersion(project, general)! };

    vi.setSystemTime(new Date('2030-01-02T00:00:00.000Z'));
    const fastVersions = await script(fast, viaFast);
    const generalVersions = await script(general, viaGeneral);

    expect(fastVersions.map((v) => v - base.fast)).toEqual(generalVersions.map((v) => v - base.general));
    expect(await snapshot(fast)).toStrictEqual(await snapshot(general));
  });
});
