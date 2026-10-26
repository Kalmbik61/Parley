import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeWorkDb, workDb } from './db.js';
import {
  channelStats,
  letterById,
  letterCount,
  mapLetterReader,
  readLetters,
  storeLetterReader,
  unreadCount,
  unreadLetters,
  writeLetters,
  type LetterTx,
  type NewLetter,
} from './letter-store.js';
import { unreadFor, unreadForHuman } from './letters.js';
import { addRoom } from './rooms.js';
import {
  createWork,
  mapCacheStats,
  onMapWritten,
  readMap,
  readStoredMap,
  replaceStoredMap,
  updateMap,
  type MapWrittenEvent,
} from './store.js';
import { HUMAN, PARLEY, type Message, type PlanEffect, type Room, type WorkMap } from './types.js';

const WORK = 'w-0001';
const OLD = '2020-01-01T00:00:00.000Z';
const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';
const T3 = '2026-10-01T12:00:00.000Z';
const T4 = '2026-10-01T13:00:00.000Z';
const T5 = '2026-10-01T14:00:00.000Z';

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  closeWorkDb();
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const ids = (messages: readonly Message[]): string[] => messages.map((message) => message.id);

const letter = (init: Partial<NewLetter> & Pick<NewLetter, 'from' | 'to'>): NewLetter => ({
  roomId: null,
  text: 'text',
  kind: 'note',
  ...init,
});

/** Работа с комнатой r-01: создатель s-01, участники s-02 и s-03; s-04 вне её. */
async function seed(fill?: (map: WorkMap, letters: LetterTx) => void): Promise<void> {
  await createWork(project, { title: 'письма' });
  await updateMap(project, WORK, (map, letters) => {
    addRoom(map, { title: 'бэкенд', creator: 's-01', members: ['s-02', 's-03'] }, OLD);
    fill?.(map, letters);
  });
}

/** Письма из задачи: два прямых и три письма комнаты, у каждого свой момент. */
const fillFive = (_map: WorkMap, letters: LetterTx): void => {
  letters.add(letter({ from: 's-01', to: ['s-03'], at: T1 })); // m-01
  letters.add(letter({ from: 's-02', to: [], roomId: 'r-01', kind: 'question', at: T2 })); // m-02
  letters.add(letter({ from: 's-02', to: [], roomId: 'r-01', at: T3 })); // m-03
  letters.add(letter({ from: 's-03', to: [], roomId: 'r-01', at: T4 })); // m-04
  letters.add(letter({ from: 's-02', to: [HUMAN], kind: 'decision', at: T5 })); // m-05
};

/** Версия строки работы в базе: растёт на каждой записи. */
const versionOf = (): number =>
  Number(
    (
      workDb().prepare('SELECT version FROM works WHERE project_path = ? AND id = ?').get(project, WORK) as {
        version: number;
      }
    ).version,
  );

/** Состаривает `updatedAt`, чтобы увидеть, сдвинула ли его запись. */
function ageWork(): void {
  const stored = readStoredMap(project, WORK);
  stored.work.updatedAt = OLD;
  replaceStoredMap(project, WORK, stored);
}

/** Что `LetterTx.unreadFor` отдаёт каждому читателю — то же, что прежние правила `letters.ts` на этой карте. */
function expectParity(map: WorkMap, letters: LetterTx): void {
  for (const reader of ['s-01', 's-02', 's-03', 's-04']) {
    expect(ids(letters.unreadFor(reader)), reader).toEqual(ids(unreadFor(map, reader)));
  }
  expect(ids(letters.unreadFor(HUMAN)), HUMAN).toEqual(ids(map.messages.filter(unreadForHuman)));
}

const room = (map: WorkMap): Room => map.rooms[0] as Room;

describe('LetterTx.add', () => {
  it('выдаёт следующий m-NN и записывает поля письма', async () => {
    await seed();

    const [first, second] = writeLetters(project, WORK, (letters) => [
      letters.add(letter({ from: 's-01', to: ['s-02'], text: 'раз', at: T1 })),
      letters.add({
        roomId: 'r-01',
        from: 's-02',
        to: [],
        text: 'два',
        kind: 'question',
        replyTo: 'm-01',
        via: 'assistant',
        readBy: { 's-03': T2 },
        at: T2,
      }),
    ]) as [Message, Message];

    expect([first.id, second.id]).toEqual(['m-01', 'm-02']);
    const stored = letterById(project, WORK, 'm-02') as Message;
    expect(stored).toMatchObject({
      roomId: 'r-01',
      from: 's-02',
      to: [],
      text: 'два',
      kind: 'question',
      replyTo: 'm-01',
      via: 'assistant',
      readBy: { 's-03': T2 },
      at: T2,
    });
    const plain = letterById(project, WORK, 'm-01') as Message;
    expect(plain.readBy).toEqual({});
    expect('replyTo' in plain).toBe(false);
    expect('via' in plain).toBe(false);
  });

  it('после deleteRoom не переиспользует номера: work.messageSeq помнит наибольший', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-01
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01' })); // m-02
    });

    await updateMap(project, WORK, (map, letters) => {
      letters.deleteRoom('r-01');
      map.rooms = [];
    });
    const added = writeLetters(project, WORK, (letters) => letters.add(letter({ from: 's-01', to: ['s-02'] })));

    expect(added.id).toBe('m-03');
    const map = await readMap(project, WORK);
    expect(map.work.messageSeq).toBe(2);
    expect(ids(map.messages)).toEqual(['m-01', 'm-03']);
  });
});

describe('LetterTx.markRead', () => {
  it('возвращает только впервые отмеченные и не трогает уже стоящее время', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-01
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-02
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-03
    });

    const first = writeLetters(project, WORK, (letters) => letters.markRead('s-02', ['m-01', 'm-02', 'm-99'], T1));
    const second = writeLetters(project, WORK, (letters) => letters.markRead('s-02', ['m-02', 'm-03'], T2));

    expect(first).toEqual(['m-01', 'm-02']);
    expect(second).toEqual(['m-03']);
    expect((letterById(project, WORK, 'm-02') as Message).readBy).toEqual({ 's-02': T1 });
    expect((letterById(project, WORK, 'm-03') as Message).readBy).toEqual({ 's-02': T2 });
  });

  it('отметка у каждого читателя своя', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01
    });

    writeLetters(project, WORK, (letters) => {
      letters.markRead('s-02', ['m-01'], T1);
      letters.markRead('s-03', ['m-01'], T2);
    });

    expect((letterById(project, WORK, 'm-01') as Message).readBy).toEqual({ 's-02': T1, 's-03': T2 });
  });
});

describe('LetterTx.unreadFor', () => {
  it('новичок комнаты получает непрочитанными все прежние рассылки', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01' })); // m-02
    });
    await updateMap(project, WORK, (map, letters) => {
      room(map).members.push('s-04');
      letters.joined('r-01', 's-04');
      expectParity(map, letters);
      expect(ids(letters.unreadFor('s-04'))).toEqual(['m-01', 'm-02']);
    });
  });

  it('вышедший из комнаты перестаёт видеть письма комнаты', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01
    });
    await updateMap(project, WORK, (map, letters) => {
      expect(ids(letters.unreadFor('s-03'))).toEqual(['m-01']);
      room(map).members = ['s-02'];
      letters.left('r-01', 's-03');
      expectParity(map, letters);
      expect(letters.unreadFor('s-03')).toEqual([]);
      expect(ids(letters.unreadFor('s-02'))).toEqual(['m-01']);
    });
  });

  it('архивная комната непрочитанной у сессий не числится, а у человека числится', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01
      letters.add(letter({ from: 's-02', to: ['s-03'], roomId: 'r-01' })); // m-02
    });
    await updateMap(project, WORK, (map, letters) => {
      room(map).archivedAt = T3;
      letters.archived('r-01');
      expectParity(map, letters);
      expect(letters.unreadFor('s-02')).toEqual([]);
      expect(letters.unreadFor('s-03')).toEqual([]);
      expect(ids(letters.unreadFor(HUMAN))).toEqual(['m-01', 'm-02']);
    });
  });

  it('Reopen: старые письма комнаты отмечены прочитанными участниками, новые — нет', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01
    });
    await updateMap(project, WORK, (map, letters) => {
      room(map).archivedAt = T2;
      letters.archived('r-01');
    });
    await updateMap(project, WORK, (map, letters) => {
      room(map).archivedAt = null;
      letters.reopened('r-01', T3);
      const fresh = letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-02
      expectParity(map, letters);
      expect(ids(letters.unreadFor('s-02'))).toEqual([fresh.id]);
      expect(ids(letters.unreadFor('s-03'))).toEqual([fresh.id]);
    });
  });

  it('письмо плана, ставшее неактуальным, пропадает из непрочитанного адресата', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: PARLEY, to: ['s-02'], roomId: 'r-01', text: 'Switch the mode' })); // m-01
      letters.add(letter({ from: 's-01', to: ['s-02'], roomId: 'r-01' })); // m-02
    });
    await updateMap(project, WORK, (map, letters) => {
      expect(ids(letters.unreadFor('s-02'))).toEqual(['m-01', 'm-02']);
      const effect: PlanEffect = {
        key: 'r-01/mode/0/0/mode/m-01/s-02',
        roomId: 'r-01',
        planId: null,
        rev: 0,
        item: null,
        kind: 'mode',
        occurrence: 'm-01',
        target: 's-02',
        text: 'Switch the mode',
        createdAt: T1,
        status: 'cancelled',
        messageId: 'm-01',
      };
      map.planEffects = [effect];
      letters.effectCancelled('m-01');
      expectParity(map, letters);
      expect(ids(letters.unreadFor('s-02'))).toEqual(['m-02']);
    });
  });

  it('явный to в комнате: письмо видит только адресат', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-02', to: ['s-03'], roomId: 'r-01' })); // m-01
    });
    await updateMap(project, WORK, (map, letters) => {
      expectParity(map, letters);
      expect(ids(letters.unreadFor('s-03'))).toEqual(['m-01']);
      expect(letters.unreadFor('s-01')).toEqual([]);
      expect(letters.unreadFor('s-02')).toEqual([]);
    });
  });

  it('прямое письмо человеку — непрочитанное человека', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-02', to: [HUMAN] })); // m-01
      letters.add(letter({ from: HUMAN, to: ['s-02'] })); // m-02
    });
    await updateMap(project, WORK, (map, letters) => {
      expectParity(map, letters);
      expect(ids(letters.unreadFor(HUMAN))).toEqual(['m-01']);
      expect(ids(unreadFor(map, HUMAN))).toEqual(['m-01']);
      letters.markRead(HUMAN, ['m-01'], T1);
      expect(letters.unreadFor(HUMAN)).toEqual([]);
    });
  });
});

describe('LetterTx.reopened', () => {
  it('ставит readBy ??= at текущим адресатам каждого письма комнаты', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01', readBy: { 's-02': OLD } })); // m-01
      letters.add(letter({ from: 's-02', to: ['s-03'], roomId: 'r-01' })); // m-02
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-03: прямое, комнату не касается
    });

    await updateMap(project, WORK, (_map, letters) => {
      letters.reopened('r-01', T2);
    });

    expect((letterById(project, WORK, 'm-01') as Message).readBy).toEqual({ 's-02': OLD, 's-03': T2 });
    expect((letterById(project, WORK, 'm-02') as Message).readBy).toEqual({ 's-03': T2 });
    expect((letterById(project, WORK, 'm-03') as Message).readBy).toEqual({});
  });

  it('у архивной комнаты адресатов нет — отметок не ставит', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01
    });

    await updateMap(project, WORK, (map, letters) => {
      room(map).archivedAt = T1;
      letters.reopened('r-01', T2);
    });

    expect((letterById(project, WORK, 'm-01') as Message).readBy).toEqual({});
  });
});

describe('LetterTx.deleteRoom и flagDeleted', () => {
  it('deleteRoom уносит письма комнаты и запоминает наибольший номер', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-01
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01' })); // m-02
      letters.add(letter({ from: 's-03', to: [], roomId: 'r-01' })); // m-03
    });

    await updateMap(project, WORK, (map, letters) => {
      letters.deleteRoom('r-01');
      map.rooms = [];
    });

    const map = await readMap(project, WORK);
    expect(ids(map.messages)).toEqual(['m-01']);
    expect(map.work.messageSeq).toBe(3);
  });

  it('flagDeleted помечает письма от сессии и к ней', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-02', to: ['s-01'] })); // m-01: от сессии
      letters.add(letter({ from: 's-01', to: ['s-02', 's-03'] })); // m-02: к сессии
      letters.add(letter({ from: 's-01', to: ['s-03'] })); // m-03: чужое
    });

    await updateMap(project, WORK, (_map, letters) => {
      letters.flagDeleted('s-02');
    });

    const flags = (await readMap(project, WORK)).messages.map((message) => message.deleted === true);
    expect(flags).toEqual([true, true, false]);
  });
});

describe('LetterTx.savepoint', () => {
  it('письмо и отметка внутри упавшего fn пропадают, транзакция продолжается', async () => {
    await seed();

    writeLetters(project, WORK, (letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'], text: 'до' }));
      expect(() =>
        letters.savepoint(() => {
          letters.add(letter({ from: 's-01', to: ['s-02'], text: 'внутри' }));
          letters.markRead('s-02', ['m-01'], T1);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      letters.add(letter({ from: 's-01', to: ['s-02'], text: 'после' }));
    });

    const map = await readMap(project, WORK);
    expect(map.messages.map((message) => message.text)).toEqual(['до', 'после']);
    expect(map.messages[0]?.readBy).toEqual({});
  });

  it('вернувшийся fn отдаёт результат и оставляет письма; внешний откат уносит и вложенный', async () => {
    await seed();

    writeLetters(project, WORK, (letters) => {
      expect(letters.savepoint(() => letters.add(letter({ from: 's-01', to: ['s-02'], text: 'цел' })).id)).toBe('m-01');
      expect(() =>
        letters.savepoint(() => {
          letters.savepoint(() => letters.add(letter({ from: 's-01', to: ['s-02'], text: 'вложенное' })));
          letters.markRead('s-02', ['m-01'], T1);
          throw new Error('outer');
        }),
      ).toThrow('outer');
    });

    const map = await readMap(project, WORK);
    expect(map.messages.map((message) => message.text)).toEqual(['цел']);
    expect(map.messages[0]?.readBy).toEqual({});
  });

  it('откат возвращает письма удалённой комнаты и номер work.messageSeq', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01' })); // m-01
    });

    await updateMap(project, WORK, (_map, letters) => {
      expect(() =>
        letters.savepoint(() => {
          letters.deleteRoom('r-01');
          letters.flagDeleted('s-02');
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });

    const map = await readMap(project, WORK);
    expect(map.messages).toHaveLength(1);
    expect(map.messages[0]?.deleted).toBeUndefined();
    expect(map.work.messageSeq).toBeUndefined();
  });
});

describe('выборка писем', () => {
  it('query с limit и newestFirst', async () => {
    await seed(fillFive);

    const inside = await updateMapResult((letters) => ({
      oldest: ids(letters.query({ limit: 2 })),
      newest: ids(letters.query({ limit: 2, newestFirst: true })),
      none: ids(letters.query({ limit: 0 })),
    }));

    expect(inside).toEqual({ oldest: ['m-01', 'm-02'], newest: ['m-05', 'm-04'], none: [] });
    expect(ids(readLetters(project, WORK, { limit: 2 }))).toEqual(['m-01', 'm-02']);
    expect(ids(readLetters(project, WORK, { limit: 2, newestFirst: true }))).toEqual(['m-05', 'm-04']);
  });

  it('query по каналу, отправителю, виду, номерам и границам номера', async () => {
    await seed(fillFive);
    const q = (query: Parameters<LetterTx['query']>[0]): string[] => ids(readLetters(project, WORK, query));

    expect(q({ roomId: 'r-01', limit: 10 })).toEqual(['m-02', 'm-03', 'm-04']);
    expect(q({ roomId: null, limit: 10 })).toEqual(['m-01', 'm-05']);
    expect(q({ from: 's-02', kind: 'note', limit: 10 })).toEqual(['m-03']);
    expect(q({ kind: 'decision', limit: 10 })).toEqual(['m-05']);
    expect(q({ ids: ['m-04', 'm-02', 'm-09'], limit: 10 })).toEqual(['m-02', 'm-04']);
    expect(q({ beforeSeq: 4, afterSeq: 1, limit: 10 })).toEqual(['m-02', 'm-03']);
    expect(q({ sinceAt: T3, limit: 10 })).toEqual(['m-04', 'm-05']);
  });

  it('query без предела или с негодным пределом — ошибка вызова', async () => {
    await seed(fillFive);

    expect(() => readLetters(project, WORK, { limit: -1 })).toThrow(RangeError);
    expect(() => readLetters(project, WORK, { limit: Number.NaN })).toThrow(RangeError);
    expect(() => readLetters(project, WORK, { limit: 5, sinceAt: 'не дата' })).toThrow(RangeError);
  });

  it('count с sinceAt и from', async () => {
    await seed(fillFive);

    const counts = await updateMapResult((letters) => ({
      since: letters.count({ sinceAt: T2 }),
      from: letters.count({ from: 's-02' }),
      both: letters.count({ sinceAt: T2, from: 's-02' }),
      direct: letters.count({ roomId: null }),
      room: letters.count({ roomId: 'r-01', kind: 'question' }),
    }));

    expect(counts).toEqual({ since: 3, from: 3, both: 2, direct: 2, room: 1 });
  });

  it('byId находит письмо; чужого номера нет', async () => {
    await seed(fillFive);

    const found = await updateMapResult((letters) => [letters.byId('m-03')?.from, letters.byId('m-09')]);

    expect(found).toEqual(['s-02', undefined]);
    expect(letterById(project, WORK, 'm-03')?.from).toBe('s-02');
    expect(letterById(project, WORK, 'm-09')).toBeUndefined();
  });
});

describe('чтение вне транзакции', () => {
  it('unreadLetters и unreadCount считают прежними правилами; ключ «» — прямые письма', async () => {
    await seed(fillFive);

    expect(ids(unreadLetters(project, WORK, 's-03'))).toEqual(['m-01', 'm-02', 'm-03']);
    expect(unreadCount(project, WORK, 's-03')).toEqual({ total: 3, byRoom: { '': 1, 'r-01': 2 } });
    expect(unreadCount(project, WORK, 's-02')).toEqual({ total: 1, byRoom: { 'r-01': 1 } });
    expect(unreadCount(project, WORK, HUMAN)).toEqual({ total: 4, byRoom: { 'r-01': 3, '': 1 } });
    expect(unreadCount(project, WORK, 's-04')).toEqual({ total: 0, byRoom: {} });
  });

  it('channelStats: число писем и номер новейшего по каналам', async () => {
    await seed(fillFive);

    expect(channelStats(project, WORK)).toEqual({
      '': { total: 2, latestId: 'm-05' },
      'r-01': { total: 3, latestId: 'm-04' },
    });
  });

  it('возвращённые письма — копии: правка результата карту не портит', async () => {
    await seed(fillFive);

    const [first] = readLetters(project, WORK, { limit: 1 }) as [Message];
    first.text = 'испорчено';
    first.readBy['s-03'] = T1;
    const [unread] = unreadLetters(project, WORK, 's-03') as [Message];
    unread.readBy['s-03'] = T1;

    expect((letterById(project, WORK, 'm-01') as Message).text).toBe('text');
    expect(ids(unreadLetters(project, WORK, 's-03'))).toEqual(['m-01', 'm-02', 'm-03']);
  });
});

describe('читатель писем для страниц и снимка', () => {
  it('над картой и над базой даёт одно и то же: страница, итоги, хвосты, цитируемые, непрочитанное человеком', async () => {
    await seed(fillFive);
    const map = await readMap(project, WORK);
    for (const reader of [mapLetterReader(map), storeLetterReader(project, WORK)]) {
      expect(ids(reader.page({ roomId: 'r-01', limit: 2, newestFirst: true }))).toEqual(['m-04', 'm-03']);
      expect(ids(reader.page({ roomId: 'r-01', afterSeq: 2, limit: 5 }))).toEqual(['m-03', 'm-04']);
      expect(reader.count({ roomId: 'r-01' })).toBe(3);
      expect(reader.count({ roomId: 'r-01', kind: 'question' })).toBe(1);
      expect(reader.count({ roomId: null, from: 's-02' })).toBe(1);
      expect(ids(reader.byIds(['m-05', 'm-02', 'm-99']))).toEqual(['m-02', 'm-05']);
      expect(reader.byIds([])).toEqual([]);
      expect(ids(reader.tail('r-01', 2))).toEqual(['m-03', 'm-04']);
      expect(ids(reader.tail(null, 5))).toEqual(['m-01', 'm-05']);
      expect(reader.tail('r-01', 0)).toEqual([]);
      expect(ids(reader.humanUnread(2))).toEqual(['m-04', 'm-05']);
      expect(ids(reader.humanUnread(10))).toEqual(['m-02', 'm-03', 'm-04', 'm-05']);
      expect(reader.humanUnread(0)).toEqual([]);
      expect(reader.unreadCount(HUMAN)).toEqual({ total: 4, byRoom: { 'r-01': 3, '': 1 } });
      expect(reader.unreadCount('s-03')).toEqual({ total: 3, byRoom: { '': 1, 'r-01': 2 } });
      expect(reader.channelStats()).toEqual({
        '': { total: 2, latestId: 'm-05' },
        'r-01': { total: 3, latestId: 'm-04' },
      });
    }
  });

  it('letterCount считает те же условия, что count внутри транзакции, и пустую выборку нулём', async () => {
    await seed(fillFive);

    expect(letterCount(project, WORK, {})).toBe(5);
    expect(letterCount(project, WORK, { roomId: 'r-01', sinceAt: T2 })).toBe(2);
    expect(letterCount(project, WORK, { kind: 'decision' })).toBe(1);
    expect(letterCount(project, WORK, { from: 's-09' })).toBe(0);
    expect(await updateMapResult((letters) => letters.count({ roomId: 'r-01', sinceAt: T2 }))).toBe(2);
  });
});

/** Результат чтения внутри транзакции, без изменений карты. */
async function updateMapResult<T>(read: (letters: LetterTx) => T): Promise<T> {
  let result: T | undefined;
  await updateMap(project, WORK, (_map, letters) => {
    result = read(letters);
  });
  return result as T;
}

describe('пустая запись не пишет', () => {
  const events: MapWrittenEvent[] = [];
  let stop = (): void => {};

  beforeEach(() => {
    events.length = 0;
    stop = onMapWritten((event) => events.push(event));
  });
  afterEach(() => stop());

  const updatedAt = async (): Promise<string> => (await readMap(project, WORK)).work.updatedAt;

  it('writeLetters без изменений не меняет версию и updatedAt и не зовёт onMapWritten', async () => {
    await seed(fillFive);
    ageWork();
    events.length = 0;
    const before = versionOf();

    const result = writeLetters(project, WORK, (letters) => {
      letters.markRead('s-02', ['m-99'], T1);
      letters.query({ limit: 5 });
      return 'готово';
    });

    expect(result).toBe('готово');
    expect(versionOf()).toBe(before);
    expect(events).toEqual([]);
    expect(await updatedAt()).toBe(OLD);
  });

  it('updateMap, мутатор которого ничего не изменил, не пишет и не двигает updatedAt', async () => {
    await seed(fillFive);
    ageWork();
    events.length = 0;
    const before = versionOf();

    await updateMap(project, WORK, () => {});
    await updateMap(project, WORK, (map) => {
      map.work.title = `${map.work.title}`;
    });

    expect(versionOf()).toBe(before);
    expect(events).toEqual([]);
    expect(await updatedAt()).toBe(OLD);
  });

  it('пустая запись отдаёт копию, а не объект кэша, и кэш остаётся годным', async () => {
    await seed(fillFive);
    await readMap(project, WORK);
    const stats = mapCacheStats();

    const returned = await updateMap(project, WORK, () => {});
    returned.work.title = 'испорчено';
    returned.messages.length = 0;

    expect(mapCacheStats().misses).toBe(stats.misses);
    const again = await readMap(project, WORK);
    expect(again.work.title).toBe('письма');
    expect(again.messages).toHaveLength(5);
    expect(mapCacheStats().misses).toBe(stats.misses);
  });

  it('упавший savepoint без других записей — тоже пустая запись', async () => {
    await seed(fillFive);
    ageWork();
    events.length = 0;
    const before = versionOf();

    writeLetters(project, WORK, (letters) => {
      expect(() =>
        letters.savepoint(() => {
          letters.add(letter({ from: 's-01', to: ['s-02'] }));
          letters.markRead('s-02', ['m-01'], T1);
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });

    expect(versionOf()).toBe(before);
    expect(events).toEqual([]);
    expect(await updatedAt()).toBe(OLD);
  });

  it('запись с изменением поднимает версию, двигает updatedAt и зовёт подписчиков один раз', async () => {
    await seed(fillFive);
    ageWork();
    events.length = 0;
    const before = versionOf();

    writeLetters(project, WORK, (letters) => letters.add(letter({ from: 's-01', to: ['s-02'] })));

    expect(versionOf()).toBe(before + 1);
    expect(events).toEqual([{ projectPath: project, workId: WORK, version: before + 1 }]);
    expect(await updatedAt()).not.toBe(OLD);
  });

  it('touch: false при записи письма updatedAt не двигает', async () => {
    await seed(fillFive);
    ageWork();
    const before = versionOf();

    writeLetters(project, WORK, (letters) => letters.markRead(HUMAN, ['m-02'], T1), { touch: false });

    expect(versionOf()).toBe(before + 1);
    expect(await updatedAt()).toBe(OLD);
  });

  it('мутатор, изменивший карту, пишет как прежде', async () => {
    await seed();
    ageWork();
    const before = versionOf();

    await updateMap(project, WORK, (map) => {
      map.work.title = 'другое';
    });

    expect(versionOf()).toBe(before + 1);
    expect((await readMap(project, WORK)).work.title).toBe('другое');
    expect(await updatedAt()).not.toBe(OLD);
  });
});
