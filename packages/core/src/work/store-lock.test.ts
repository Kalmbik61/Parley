import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorkDb, WORK_DB_FILE, workDb } from './db.js';
import { readLetters, unreadLetters, writeLetters, writeLettersAsync, type LetterTx, type NewLetter } from './letter-store.js';
import { addSession, normalizeMap } from './map.js';
import { isPlainJsonTree, mapToRows, rowsToMap } from './map-rows.js';
import { addRoom } from './rooms.js';
import {
  createWork,
  MapLockTimeoutError,
  onMapWritten,
  pruneWorksIndex,
  readMap,
  updateMap,
  workExists,
  workPaths,
  workVersion,
  type MapWrittenEvent,
} from './store.js';
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

const require = createRequire(import.meta.url);
const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
const realMap = await vi.importActual<typeof import('./map.js')>('./map.js');

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  vi.mocked(normalizeMap).mockImplementation(realMap.normalizeMap);
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

describe('applyMapUpdate: разбор карты до замка', () => {
  /** Список событий: `begin` — `BEGIN IMMEDIATE` у соединения хранилища (перед ним вызывается `onBegin`), `normalize` — `normalizeMap`. */
  const watch = (onBegin: () => void = () => undefined): string[] => {
    const events: string[] = [];
    vi.mocked(normalizeMap).mockImplementation((...args) => {
      events.push('normalize');
      return realMap.normalizeMap(...args);
    });
    const db = workDb();
    const exec = db.exec.bind(db);
    db.exec = (sqlText: string): void => {
      if (sqlText === 'BEGIN IMMEDIATE') {
        events.push('begin');
        onBegin();
      }
      exec(sqlText);
    };
    return events;
  };

  /** Чужое соединение к той же базе: правка записи сессии и подъём версии работы, как у другого процесса. */
  const foreignEdit = (workId: string, sessionId: string, label: string): void => {
    const foreign = new Database(path.join(home, WORK_DB_FILE));
    try {
      foreign.exec('PRAGMA busy_timeout = 5000');
      foreign
        .prepare("UPDATE entries SET json = json_set(json, '$.label', ?) WHERE project_path = ? AND work_id = ? AND kind = 'session' AND key = ?")
        .run(label, project, workId, sessionId);
      foreign.prepare('UPDATE works SET version = version + 1 WHERE project_path = ? AND id = ?').run(project, workId);
    } finally {
      foreign.close();
    }
  };

  it('промах кэша разбирает карту до BEGIN IMMEDIATE; под замком не разбирает второй раз', async () => {
    const workId = await seed(5);
    foreignEdit(workId, 's-01', 'Foreign');
    const events = watch();
    clearRebuilders();

    writeLetters(project, workId, (letters) => {
      letters.add(note());
    });

    expect(events.slice(0, 2)).toEqual(['normalize', 'begin']);
    expect(events.indexOf('begin')).toBe(1);
    expect(rowsToMap).toHaveBeenCalledTimes(1);
    closeWorkDb();
    const fresh = await readMap(project, workId);
    expect(fresh.sessions.find((session) => session.id === 's-01')?.label).toBe('Foreign');
    expect(readLetters(project, workId, { limit: 10 })).toHaveLength(1);
  });

  it('чужая запись между разбором и замком не теряется: карта грузится под замком', async () => {
    const workId = await seed(5);
    foreignEdit(workId, 's-03', 'Other');
    let slipped = false;
    const events = watch(() => {
      if (slipped) return;
      slipped = true;
      foreignEdit(workId, 's-01', 'Slipped');
    });
    clearRebuilders();

    await updateMap(project, workId, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.summary = 'mine';
    });

    expect(events[0]).toBe('normalize');
    expect(events[1]).toBe('begin');
    // Разобрано дважды: до замка (версия устарела) и под замком.
    expect(rowsToMap).toHaveBeenCalledTimes(2);
    closeWorkDb();
    const fresh = await readMap(project, workId);
    const by = (id: string) => fresh.sessions.find((session) => session.id === id)!;
    expect(by('s-01').label).toBe('Slipped');
    expect(by('s-03').label).toBe('Other');
    expect(by('s-02').summary).toBe('mine');
  });

  it('письмо при чужой записи между разбором и замком: письмо и обе чужие правки на месте, версия +1 к чужой', async () => {
    const workId = await seed(5);
    foreignEdit(workId, 's-01', 'Foreign');
    const afterForeign = workVersion(project, workId)!;
    watch(() => foreignEdit(workId, 's-02', 'Slipped'));

    writeLetters(project, workId, (letters) => {
      letters.add(note());
    });

    // Чужая правка во время `begin` подняла версию ещё раз; письмо — следующая.
    expect(workVersion(project, workId)).toBe(afterForeign + 2);
    closeWorkDb();
    const fresh = await readMap(project, workId);
    expect(fresh.sessions.find((session) => session.id === 's-01')?.label).toBe('Foreign');
    expect(fresh.sessions.find((session) => session.id === 's-02')?.label).toBe('Slipped');
    expect(readLetters(project, workId, { limit: 10 })).toHaveLength(1);
  });
});

describe('pruneWorksIndex: копия снимаемой работы до замка', () => {
  const goneWork = async (): Promise<string> => {
    const created = await createWork(project, { title: 'Gone' });
    await updateMap(project, created.work.id, (map) => {
      addSession(map, { provider: 'claude', label: 'S', task: 't' });
    });
    await rm(workPaths(project, created.work.id).dir, { recursive: true, force: true });
    return created.work.id;
  };

  const onBegin = (hook: () => void): void => {
    const db = workDb();
    const exec = db.exec.bind(db);
    db.exec = (sqlText: string): void => {
      if (sqlText === 'BEGIN IMMEDIATE') hook();
      exec(sqlText);
    };
  };

  it('копия лежит до BEGIN IMMEDIATE', async () => {
    const workId = await goneWork();
    const seen: string[][] = [];
    onBegin(() => {
      seen.push(readdirSync(path.join(home, 'pruned')));
    });

    const removed = await pruneWorksIndex();

    expect(removed.map((entry) => entry.id)).toEqual([workId]);
    expect(workExists(project, workId)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(await readdir(path.join(home, 'pruned'))).toHaveLength(1);
  });

  it('изменённая между копией и снятием работа остаётся', async () => {
    const workId = await goneWork();
    onBegin(() => {
      const foreign = new Database(path.join(home, WORK_DB_FILE));
      try {
        foreign.exec('PRAGMA busy_timeout = 5000');
        foreign.prepare('UPDATE works SET version = version + 1 WHERE project_path = ? AND id = ?').run(project, workId);
      } finally {
        foreign.close();
      }
    });
    const report = vi.fn();

    const removed = await pruneWorksIndex({ report });

    expect(removed).toEqual([]);
    expect(workExists(project, workId)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(`workspace ${workId} (${project}) kept: it changed while its copy was saved`);
  });
});

describe('запись под чужим замком базы', () => {
  /** Второе соединение держит блокировку записи, как чужой процесс (CLI, MCP агента). */
  const holdWriteLock = (): { release: () => void } => {
    const foreign = new Database(path.join(home, WORK_DB_FILE));
    foreign.exec('PRAGMA busy_timeout = 0');
    foreign.exec('BEGIN IMMEDIATE');
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        foreign.exec('ROLLBACK');
        foreign.close();
      },
    };
  };
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const texts = (workId: string): string[] => readLetters(project, workId, { limit: 100 }).map((message) => message.text);

  it('writeLettersAsync ждёт освобождения, а цикл событий идёт: таймер, заведённый до записи, срабатывает раньше неё', async () => {
    const workId = await seed(3);
    const foreign = holdWriteLock();
    const order: string[] = [];
    try {
      const timer = pause(30).then(() => order.push('timer'));
      const write = writeLettersAsync(project, workId, (letters) => letters.add(note({ text: 'under lock' })), {
        lockTimeoutMs: 20_000,
      }).then(() => order.push('write'));
      await pause(400);
      // Замок ещё чужой: письма нет, запись не завершилась, а таймер уже сработал.
      expect(order).toEqual(['timer']);
      expect(texts(workId)).toEqual([]);
      foreign.release();
      await Promise.all([timer, write]);
    } finally {
      foreign.release();
    }

    expect(order).toEqual(['timer', 'write']);
    expect(texts(workId)).toEqual(['under lock']);
  });

  it('замок дольше срока: MapLockTimeoutError с прежним текстом, мутатор не вызывался', async () => {
    const workId = await seed(3);
    const foreign = holdWriteLock();
    let calls = 0;
    try {
      const started = Date.now();
      const error = await writeLettersAsync(
        project,
        workId,
        (letters) => {
          calls += 1;
          letters.add(note());
        },
        { lockTimeoutMs: 150 },
      ).catch((cause: Error) => cause);

      expect(error).toBeInstanceOf(MapLockTimeoutError);
      expect((error as Error).message).toMatch(/lock .*parley\.db was not released within 150 ms/);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(calls).toBe(0);
    } finally {
      foreign.release();
    }
    expect(texts(workId)).toEqual([]);
  });

  it('updateMap под чужим замком не держит цикл и пишет после освобождения; два писателя одного процесса оба применены', async () => {
    const workId = await seed(3);
    const foreign = holdWriteLock();
    let fired = false;
    const timer = pause(30).then(() => {
      fired = true;
    });
    const first = updateMap(project, workId, (map) => (map.work.title = 'First'), { lockTimeoutMs: 20_000 });
    const second = updateMap(project, workId, (map) => (map.work.goal = 'Second'), { lockTimeoutMs: 20_000 });
    try {
      await pause(300);
      expect(fired).toBe(true);
    } finally {
      foreign.release();
    }
    await Promise.all([first, second, timer]);

    const map = await readMap(project, workId);
    expect(map.work.title).toBe('First');
    expect(map.work.goal).toBe('Second');
  });

  it('ошибка тела не повторяется: мутатор вызван один раз', async () => {
    const workId = await seed(3);
    let calls = 0;
    await expect(
      updateMap(project, workId, () => {
        calls += 1;
        throw new Error('mutator failed');
      }),
    ).rejects.toThrow('mutator failed');
    expect(calls).toBe(1);
  });

  it('синхронный writeLetters по-прежнему блокирует цикл и падает по сроку', async () => {
    const workId = await seed(3);
    const foreign = holdWriteLock();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    try {
      const started = Date.now();
      expect(() => writeLetters(project, workId, (letters) => letters.add(note()), { lockTimeoutMs: 150 })).toThrow(
        MapLockTimeoutError,
      );
      // Цикл событий не освобождался: таймер на 0 мс не успел сработать, а ожидание длилось почти весь срок.
      expect(fired).toBe(false);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    } finally {
      foreign.release();
    }
  });
});
