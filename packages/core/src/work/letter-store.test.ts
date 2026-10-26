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
import { mapLetterTx, previewLetterTx } from './letter-store.js';
import { messagePage, type LetterReader } from './context-pages.js';
import { agentLetterAudience, agentLetterVisible } from './thread.js';
import { addSession } from './map.js';
import { addRoom } from './rooms.js';
import {
  createWork,
  mapCacheStats,
  onMapWritten,
  readMap,
  readStoredMap,
  replaceStoredMap,
  updateMap,
  WorkNotFoundError,
  type MapWrittenEvent,
} from './store.js';
import { HUMAN, PARLEY, type Message, type PlanEffect, type Room, type WindowWorkMap, type WorkMap } from './types.js';

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

/**
 * Что `LetterTx.unreadFor` отдаёт каждому читателю — то же, что прежние чистые правила `letters.ts` на полной карте:
 * черновик карты плюс все письма работы, собранные запросом (независимый от таблицы кандидатов оракул).
 */
function expectParity(map: WorkMap, letters: LetterTx): void {
  const full: WindowWorkMap = { ...map, messages: letters.query({ limit: letters.count({}) }) };
  for (const reader of ['s-01', 's-02', 's-03', 's-04']) {
    expect(ids(letters.unreadFor(reader)), reader).toEqual(ids(unreadFor(full, reader)));
  }
  expect(ids(letters.unreadFor(HUMAN)), HUMAN).toEqual(ids(full.messages.filter(unreadForHuman)));
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
    const map = readStoredMap(project, WORK);
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
      expect(ids(unreadFor({ ...map, messages: letters.query({ limit: 10 }) }, HUMAN))).toEqual(['m-01']);
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

    const map = readStoredMap(project, WORK);
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

    const flags = readStoredMap(project, WORK).messages.map((message) => message.deleted === true);
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

    const map = readStoredMap(project, WORK);
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

    const map = readStoredMap(project, WORK);
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

    const map = readStoredMap(project, WORK);
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

  // Спека хранилища 6.2: пересчёт будильника и метрик идёт по снимку хоста; карты из базы он не грузит и кэш не перебирает.
  it('с options.map читаются только кандидаты, живые правила идут по карте вызывающего, карта из базы не загружается', async () => {
    await seed(fillFive);
    const map = await readMap(project, WORK);
    await readMap(project, WORK);
    const before = mapCacheStats();

    expect(ids(unreadLetters(project, WORK, 's-03', { map }))).toEqual(['m-01', 'm-02', 'm-03']);
    expect(unreadCount(project, WORK, 's-03', { map })).toEqual({ total: 3, byRoom: { '': 1, 'r-01': 2 } });
    expect(unreadCount(project, WORK, HUMAN, { map })).toEqual({ total: 4, byRoom: { 'r-01': 3, '': 1 } });
    expect(mapCacheStats()).toEqual(before);

    // Правила идут по карте вызывающего: в ней s-03 не участник комнаты, и рассылки комнаты ему уже не непрочитанные.
    const away = structuredClone(map);
    (away.rooms[0] as Room).members = ['s-02'];
    expect(ids(unreadLetters(project, WORK, 's-03', { map: away }))).toEqual(['m-01']);
    expect(ids(unreadLetters(project, WORK, 's-03'))).toEqual(['m-01', 'm-02', 'm-03']);

    // Работы в базе нет — кандидатов нет: ответ пуст и ничего не бросает; без карты вызова — отказ.
    expect(unreadCount(project, 'w-9999', 's-03', { map }).total).toBe(0);
    expect(unreadLetters(project, 'w-9999', 's-03', { map })).toEqual([]);
    expect(() => unreadCount(project, 'w-9999', 's-03')).toThrow(WorkNotFoundError);
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
    const map = readStoredMap(project, WORK);
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
    returned.rooms.length = 0;

    expect(mapCacheStats().misses).toBe(stats.misses);
    const again = await readMap(project, WORK);
    expect(again.work.title).toBe('письма');
    expect(again.rooms).toHaveLength(1);
    expect(letterCount(project, WORK, {})).toBe(5);
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

/**
 * Непрочитанное из базы (кандидаты и живые правила) равно прежним чистым правилам `letters.ts` на собранной полной карте:
 * письма каждой сессии и человека, их число и разбивка по каналам (спека хранилища 6.2, план 4, задача 7).
 */
function expectDbParity(readers: readonly string[] = ['s-01', 's-02', 's-03', 's-04']): void {
  const full = readStoredMap(project, WORK);
  for (const reader of readers) {
    const expected = unreadFor(full, reader);
    expect(ids(unreadLetters(project, WORK, reader)), reader).toEqual(ids(expected));
    const counted = unreadCount(project, WORK, reader);
    expect(counted.total, reader).toBe(expected.length);
    expect(Object.values(counted.byRoom).reduce((sum, n) => sum + n, 0), reader).toBe(expected.length);
  }
  const human = full.messages.filter(unreadForHuman);
  expect(ids(unreadLetters(project, WORK, HUMAN)), HUMAN).toEqual(ids(human));
  const counted = unreadCount(project, WORK, HUMAN);
  expect(counted.total).toBe(human.length);
  expect(counted.byRoom['r-01'] ?? 0).toBe(human.filter((message) => message.roomId === 'r-01').length);
  expect(counted.byRoom[''] ?? 0).toBe(human.filter((message) => message.roomId === null).length);
}

describe('кандидаты в непрочитанное против прежних правил (Review Focus 1–3)', () => {
  it('новичок длинной комнаты, выход и возвращение: история непрочитанной, у вышедшего пропадает, у вернувшегося снова', async () => {
    await seed((_map, letters) => {
      for (let n = 0; n < 60; n += 1) letters.add(letter({ from: n % 2 === 0 ? 's-01' : 's-02', to: [], roomId: 'r-01', text: `рассылка ${n}` }));
    });
    writeLetters(project, WORK, (letters) => letters.markRead('s-03', ['m-01', 'm-02', 'm-03'], T1));
    expectDbParity();

    await updateMap(project, WORK, (map, letters) => {
      room(map).members.push('s-04');
      letters.joined('r-01', 's-04');
    });
    expect(unreadLetters(project, WORK, 's-04')).toHaveLength(60);
    expectDbParity();

    // Явное письмо новичку и рассылка, пока он в комнате.
    writeLetters(project, WORK, (letters) => {
      letters.add(letter({ from: 's-01', to: ['s-04'], roomId: 'r-01', text: 'тебе лично' }));
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01', text: 'всем ещё' }));
    });
    expectDbParity();

    await updateMap(project, WORK, (map, letters) => {
      room(map).members = room(map).members.filter((id) => id !== 's-04');
      letters.left('r-01', 's-04');
    });
    // Рассылки комнаты вышедшему не видны; письмо с явным `to` остаётся адресату и после выхода.
    expect(unreadLetters(project, WORK, 's-04').map((message) => message.text)).toEqual(['тебе лично']);
    expectDbParity();

    writeLetters(project, WORK, (letters) => letters.add(letter({ from: 's-01', to: [], roomId: 'r-01', text: 'пока тебя нет' })));
    expect(unreadLetters(project, WORK, 's-04')).toHaveLength(1);
    expectDbParity();

    await updateMap(project, WORK, (map, letters) => {
      room(map).members.push('s-04');
      letters.joined('r-01', 's-04');
    });
    // Вернувшийся видит все рассылки заново, не от него и без его отметки, и явное письмо один раз.
    expect(unreadLetters(project, WORK, 's-04')).toHaveLength(60 + 1 + 1 + 1);
    expectDbParity();
  });

  it('архив и Reopen: у сессий архивные письма не числятся, человеку числятся и он отмечает выборочно; после Reopen — только новое', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01', text: 'раз' })); // m-01
      letters.add(letter({ from: 's-02', to: ['s-03'], roomId: 'r-01', text: 'лично' })); // m-02
      letters.add(letter({ from: 's-03', to: [], roomId: 'r-01', text: 'три' })); // m-03
      letters.add(letter({ from: 's-02', to: [HUMAN], text: 'прямое человеку' })); // m-04
    });
    expectDbParity();

    await updateMap(project, WORK, (map, letters) => {
      room(map).archivedAt = T2;
      letters.archived('r-01');
    });
    for (const reader of ['s-01', 's-02', 's-03']) expect(unreadLetters(project, WORK, reader)).toEqual([]);
    expect(ids(unreadLetters(project, WORK, HUMAN))).toEqual(['m-01', 'm-02', 'm-03', 'm-04']);
    expectDbParity();

    // Человек выборочно отмечает письма архивной комнаты: остальные остаются непрочитанными.
    writeLetters(project, WORK, (letters) => letters.markRead(HUMAN, ['m-02', 'm-04'], T3));
    expect(ids(unreadLetters(project, WORK, HUMAN))).toEqual(['m-01', 'm-03']);
    expect(unreadCount(project, WORK, HUMAN)).toEqual({ total: 2, byRoom: { 'r-01': 2 } });
    expectDbParity();

    await updateMap(project, WORK, (map, letters) => {
      room(map).archivedAt = null;
      letters.reopened('r-01', T4);
    });
    // Сессиям старое отмечено прочитанным; человек архивных писем не терял и не получил заново.
    for (const reader of ['s-01', 's-02', 's-03']) expect(unreadLetters(project, WORK, reader)).toEqual([]);
    expect(ids(unreadLetters(project, WORK, HUMAN))).toEqual(['m-01', 'm-03']);
    expectDbParity();

    writeLetters(project, WORK, (letters) => letters.add(letter({ from: 's-01', to: [], roomId: 'r-01', text: 'новое' })));
    expect(ids(unreadLetters(project, WORK, 's-02'))).toEqual(['m-05']);
    expectDbParity();
  });

  it('письмо плана стало неактуальным: пропадает из непрочитанного адресата сразу (живое правило), отметки других писем целы', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: PARLEY, to: ['s-02'], roomId: 'r-01', text: 'Switch the mode' })); // m-01
      letters.add(letter({ from: PARLEY, to: ['s-02'], roomId: 'r-01', text: 'Other effect' })); // m-02
      letters.add(letter({ from: 's-01', to: ['s-02'], roomId: 'r-01', text: 'обычное' })); // m-03
    });
    expectDbParity();
    const effect = (id: string, text: string, status: PlanEffect['status']): PlanEffect => ({
      key: `r-01/mode/0/0/mode/${id}/s-02`,
      roomId: 'r-01',
      planId: null,
      rev: 0,
      item: null,
      kind: 'mode',
      occurrence: id,
      target: 's-02',
      text,
      createdAt: T1,
      status,
      messageId: id,
    });

    // Эффект отменён в карте, а кандидат в таблице остался: чтение отсеивает его живым правилом.
    await updateMap(project, WORK, (map) => {
      map.planEffects = [effect('m-01', 'Switch the mode', 'cancelled'), effect('m-02', 'Other effect', 'sent')];
    });
    expect(ids(unreadLetters(project, WORK, 's-02'))).toEqual(['m-03']);
    expect(unreadCount(project, WORK, 's-02')).toEqual({ total: 1, byRoom: { 'r-01': 1 } });
    expectDbParity();

    // effectCancelled убирает кандидатов письма у сессий, но не у человека: его правило письма плана не различает.
    await updateMap(project, WORK, (_map, letters) => letters.effectCancelled('m-02'));
    expect(
      workDb().prepare('SELECT reader FROM message_unread WHERE seq = 2 ORDER BY reader').all().map((row) => (row as { reader: string }).reader),
    ).toEqual([HUMAN]);
    expectDbParity();
  });

  it('случайная последовательность операций: после каждой базу и прежние правила нельзя различить', async () => {
    await seed();
    let state = 20_261_024;
    const roll = (n: number): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return (state >>> 8) % n;
    };
    const readers = ['s-01', 's-02', 's-03', 's-04'];
    let clock = Date.parse(T1);
    const stamp = (): string => new Date((clock += 1000)).toISOString();

    for (let step = 0; step < 160; step += 1) {
      const kind = roll(9);
      const reader = readers[roll(4)] as string;
      const other = readers[roll(4)] as string;
      await updateMap(project, WORK, (map, letters) => {
        const r = room(map);
        const archived = r.archivedAt !== undefined && r.archivedAt !== null;
        if (kind <= 2 && !archived) {
          const to = roll(3) === 0 ? [other] : [];
          letters.add(letter({ from: reader, to, roomId: 'r-01', at: stamp() }));
        } else if (kind === 3) {
          letters.add(letter({ from: reader, to: [roll(2) === 0 ? HUMAN : other], at: stamp() }));
        } else if (kind === 4) {
          const unread = letters.unreadFor(reader).slice(0, 2).map((message) => message.id);
          letters.markRead(reader, unread, stamp());
        } else if (kind === 5 && !archived && !r.members.includes(reader)) {
          r.members.push(reader);
          letters.joined('r-01', reader);
        } else if (kind === 6 && !archived && r.members.includes(reader)) {
          r.members = r.members.filter((id) => id !== reader);
          letters.left('r-01', reader);
        } else if (kind === 7) {
          if (archived) {
            r.archivedAt = null;
            letters.reopened('r-01', stamp());
          } else {
            r.archivedAt = stamp();
            letters.archived('r-01');
          }
        } else if (kind === 8) {
          const mine = letters.unreadFor(HUMAN).slice(0, 2).map((message) => message.id);
          letters.markRead(HUMAN, mine, stamp());
        }
      });
      expectDbParity();
    }
    // Прогон не пустой: письма есть, и у кого-то непрочитанное.
    expect(letterCount(project, WORK, {})).toBeGreaterThan(20);
  });
});

describe('записанные письма в таблицах', () => {
  it('readStoredMap после replaceStoredMap возвращает структурно ту же полную карту с письмами, readBy и пометками', async () => {
    await seed();
    const full: WindowWorkMap = readStoredMap(project, WORK);
    full.messages = [
      { id: 'm-01', roomId: null, from: 's-01', to: ['s-02'], at: T1, text: 'прямое', kind: 'note', readBy: { 's-02': T2 } },
      { id: 'm-02', roomId: 'r-01', from: 's-02', to: [], at: T2, text: 'ответ', kind: 'question', replyTo: 'm-01', via: 'telegram', readBy: {} },
      { id: 'm-03', roomId: 'r-01', from: HUMAN, to: ['s-03'], at: T3, text: 'решение', kind: 'decision', readBy: { 's-03': T4, [HUMAN]: T4 }, deleted: true },
    ];
    full.work.messageSeq = 3;

    replaceStoredMap(project, WORK, full);

    expect(readStoredMap(project, WORK)).toEqual(full);
    expect(await readMap(project, WORK)).toEqual({ ...full, messages: undefined });
    expectDbParity();
  });

  it('replaceStoredMap без messages письма не трогает, с пустым списком — стирает', async () => {
    await seed(fillFive);
    const stored = readStoredMap(project, WORK);
    const bare: Partial<WindowWorkMap> = { ...stored };
    delete bare.messages;

    replaceStoredMap(project, WORK, bare);
    expect(letterCount(project, WORK, {})).toBe(5);

    replaceStoredMap(project, WORK, { ...bare, messages: [] });
    expect(letterCount(project, WORK, {})).toBe(0);
    expect(workDb().prepare('SELECT COUNT(*) AS n FROM message_unread').get()).toEqual({ n: 0 });
  });

  it('номера выдаёт база под блокировкой: max(work.messageSeq, наибольший номер) + 1; формат m-NN и m-NNNN', async () => {
    await seed();
    await updateMap(project, WORK, (map) => {
      map.work.messageSeq = 98;
    });

    const added = writeLetters(project, WORK, (letters) => [1, 2, 3].map(() => letters.add(letter({ from: 's-01', to: ['s-02'] })).id));

    expect(added).toEqual(['m-99', 'm-100', 'm-101']);
    expect(letterById(project, WORK, 'm-101')?.at).toBeDefined();
  });

  it('письмо при записи проверяется: чужая форма адресатов и вида — ошибка, записи нет', async () => {
    await seed();
    const before = versionOf();

    expect(() => writeLetters(project, WORK, (letters) => letters.add({ ...letter({ from: 's-01', to: [] }), to: 's-02' as unknown as string[] }))).toThrow(TypeError);
    expect(() => writeLetters(project, WORK, (letters) => letters.add({ ...letter({ from: 's-01', to: [] }), kind: 'shout' as never }))).toThrow(TypeError);

    expect(versionOf()).toBe(before);
    expect(letterCount(project, WORK, {})).toBe(0);
  });

  it('deleteRoom комнаты без писем ничего не меняет: версия и work.messageSeq прежние', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-01, прямое
    });
    await updateMap(project, WORK, (map) => {
      addRoom(map, { title: 'пустая', creator: 's-01', members: [] }, OLD);
    });
    ageWork();
    const before = versionOf();
    const seq = readStoredMap(project, WORK).work.messageSeq;

    await updateMap(project, WORK, (map, letters) => {
      letters.deleteRoom('r-02');
      map.rooms = map.rooms.filter((candidate) => candidate.id !== 'r-02');
    });

    // Версия выросла от удаления самой комнаты, а номер письма не сдвинулся: писем комнаты не было.
    expect(versionOf()).toBe(before + 1);
    expect(readStoredMap(project, WORK).work.messageSeq).toBe(seq);
    const afterNoop = versionOf();
    await updateMap(project, WORK, (_map, letters) => letters.deleteRoom('r-99'));
    expect(versionOf()).toBe(afterNoop);
  });

  it('deleteRoom убирает отметки и кандидатов комнаты каскадом, чужие остаются', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01', readBy: { 's-02': T1 } })); // m-01
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-02, прямое
    });

    await updateMap(project, WORK, (map, letters) => {
      letters.deleteRoom('r-01');
      map.rooms = [];
    });

    const rows = (table: string): number => Number((workDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    expect([rows('messages'), rows('message_reads'), rows('message_unread')]).toEqual([1, 0, 1]);
  });

  it('flagDeleted убирает кандидатов самой сессии; письма других остаются', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: [], roomId: 'r-01' })); // m-01: кандидаты s-02 и s-03
    });

    await updateMap(project, WORK, (map, letters) => {
      map.sessions = map.sessions.filter((session) => session.id !== 's-02');
      letters.flagDeleted('s-02');
    });

    expect(unreadLetters(project, WORK, 's-02', { map: readStoredMap(project, WORK) })).toEqual([]);
    expect(ids(unreadLetters(project, WORK, 's-03'))).toEqual(['m-01']);
  });
});

describe('выборка писем в таблицах', () => {
  it('agentsOnly отбрасывает письма человека, хоста и плана и в query, и в count; границы — по индексу времени', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'], at: T1 })); // m-01
      letters.add(letter({ from: HUMAN, to: ['s-02'], at: T2 })); // m-02
      letters.add(letter({ from: 'system', to: [HUMAN], roomId: 'r-01', at: T3 })); // m-03
      letters.add(letter({ from: PARLEY, to: ['s-02'], roomId: 'r-01', at: T4 })); // m-04
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01', at: T5 })); // m-05
    });
    const inside = await updateMapResult((tx) => ({
      all: tx.count({ agentsOnly: true }),
      since: tx.count({ agentsOnly: true, sinceAt: T2 }),
      room: tx.count({ agentsOnly: true, roomId: 'r-01' }),
      rows: ids(tx.query({ agentsOnly: true, limit: 10 })),
    }));

    expect(inside).toEqual({ all: 2, since: 1, room: 1, rows: ['m-01', 'm-05'] });
    expect(letterCount(project, WORK, { agentsOnly: true })).toBe(2);
    // Тот же ответ у читателя над картой в памяти: оба читателя взаимозаменяемы.
    const full = readStoredMap(project, WORK);
    expect(ids(mapLetterReader(full).page({ agentsOnly: true, limit: 10 }))).toEqual(['m-01', 'm-05']);
    expect(mapLetterReader(full).count({ agentsOnly: true, roomId: 'r-01' })).toBe(1);
  });

  it('границы номера: бесконечные и нечисловые ведут себя как сравнение чисел', async () => {
    await seed(fillFive);
    const q = (query: Parameters<LetterTx['query']>[0]): string[] => ids(readLetters(project, WORK, query));

    expect(q({ beforeSeq: Number.POSITIVE_INFINITY, limit: 10 })).toEqual(['m-01', 'm-02', 'm-03', 'm-04', 'm-05']);
    expect(q({ afterSeq: Number.NEGATIVE_INFINITY, limit: 10 })).toHaveLength(5);
    expect(q({ afterSeq: Number.POSITIVE_INFINITY, limit: 10 })).toEqual([]);
    expect(q({ beforeSeq: Number.NaN, limit: 10 })).toEqual([]);
  });

  it('involving отбирает письма, где названный — отправитель или адресат; читатель над картой и над базой согласны', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-01', to: ['s-02'] })); // m-01
      letters.add(letter({ from: 's-03', to: ['s-04'] })); // m-02
      letters.add(letter({ from: 's-04', to: ['s-01', 's-03'] })); // m-03
      letters.add(letter({ from: HUMAN, to: ['s-03'] })); // m-04
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01' })); // m-05
    });
    const full = readStoredMap(project, WORK);

    const stored = ids(readLetters(project, WORK, { involving: ['s-01', 's-02'], limit: 10 }));
    expect(stored).toEqual(['m-01', 'm-03', 'm-05']);
    expect(ids(mapLetterReader(full).page({ involving: ['s-01', 's-02'], limit: 10 }))).toEqual(stored);
    expect(letterCount(project, WORK, { involving: ['s-01', 's-02'], roomId: null })).toBe(2);
    expect(readLetters(project, WORK, { involving: [], limit: 10 })).toEqual([]);
    // Условие с OR не расползается по остальным: канал и предотбор складываются по «и».
    expect(ids(readLetters(project, WORK, { involving: ['s-01', 's-02'], roomId: 'r-01', limit: 10 }))).toEqual(['m-05']);
  });

  it('страница прямых писем с правилом видимости и предотбором: те же письма и итог, но канал целиком не читается', async () => {
    await seed((map, letters) => {
      for (const id of ['s-01', 's-02', 's-03', 's-04']) addSession(map, { provider: 'claude', label: id, task: 't' });
      for (let n = 0; n < 40; n += 1) letters.add(letter({ from: 's-03', to: ['s-04'], text: `чужое ${n}` }));
      letters.add(letter({ from: 's-01', to: ['s-02'], text: 'моё' }));
      letters.add(letter({ from: 's-02', to: ['s-01'], text: 'мне' }));
    });
    const map = readStoredMap(project, WORK);
    const visible = agentLetterVisible(map, 's-01');
    const reader = storeLetterReader(project, WORK);
    let loaded = 0;
    const counting: LetterReader = { ...reader, page: (q) => { const rows = reader.page(q); loaded += rows.length; return rows; } };

    const narrowed = messagePage(map, { roomId: null, filter: visible, involving: agentLetterAudience(map, 's-01'), view: (m) => m }, counting);
    const wide = messagePage(map, { roomId: null, filter: visible, view: (m) => m }, reader);

    expect(narrowed.messages.map((m) => m.text)).toEqual(['моё', 'мне']);
    expect(narrowed.messages).toEqual(wide.messages);
    expect(narrowed.page.total).toBe(wide.page.total);
    expect(narrowed.page.total).toBe(2);
    // Сорок чужих писем между двумя другими сессиями выборка не принесла.
    expect(loaded).toBeLessThanOrEqual(4);
  });

  it('читатель из базы возвращает письма с readBy только отобранных; пустой список id — пусто', async () => {
    await seed(fillFive);
    writeLetters(project, WORK, (letters) => letters.markRead('s-03', ['m-02', 'm-04'], T1));

    const picked = readLetters(project, WORK, { ids: ['m-04', 'm-01'], limit: 10 });

    expect(picked.map((message) => [message.id, Object.keys(message.readBy)])).toEqual([
      ['m-01', []],
      ['m-04', ['s-03']],
    ]);
    expect(readLetters(project, WORK, { ids: [], limit: 10 })).toEqual([]);
  });

  it('работы нет — чтение писем бросает WorkNotFoundError', () => {
    expect(() => readLetters(project, 'w-0042', { limit: 1 })).toThrow(WorkNotFoundError);
    expect(() => letterById(project, 'w-0042', 'm-01')).toThrow(WorkNotFoundError);
    expect(() => channelStats(project, 'w-0042')).toThrow(WorkNotFoundError);
    expect(() => letterCount(project, 'w-0042', {})).toThrow(WorkNotFoundError);
  });
});

describe('savepoint и пробный расчёт', () => {
  it('асинхронная fn отвергается: откатить отложенную работу нечем, письма внутри пропадают', async () => {
    await seed();

    expect(() =>
      writeLetters(project, WORK, (letters) =>
        letters.savepoint((() => {
          letters.add(letter({ from: 's-01', to: ['s-02'] }));
          return Promise.resolve(1);
        }) as () => number),
      ),
    ).toThrow('synchronous');

    expect(letterCount(project, WORK, {})).toBe(0);
  });

  it('deleteRoom внутри упавшего savepoint возвращает письма комнаты и номер', async () => {
    await seed((_map, letters) => {
      letters.add(letter({ from: 's-02', to: [], roomId: 'r-01' })); // m-01
    });

    await updateMap(project, WORK, (map, letters) => {
      expect(() =>
        letters.savepoint(() => {
          letters.deleteRoom('r-01');
          expect(map.work.messageSeq).toBe(1);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(map.work.messageSeq).toBeUndefined();
    });

    expect(letterCount(project, WORK, { roomId: 'r-01' })).toBe(1);
  });

  it('previewLetterTx читает таблицы, add отдаёт следующий номер и ничего не пишет', async () => {
    await seed(fillFive);
    const map = readStoredMap(project, WORK);
    const before = versionOf();
    const preview = previewLetterTx(project, WORK, map);

    const next = preview.add(letter({ from: PARLEY, to: ['s-02'], roomId: 'r-01', text: 'пробное' }));

    expect(next.id).toBe('m-06');
    expect(preview.add(letter({ from: PARLEY, to: ['s-02'] })).id).toBe('m-07');
    expect(preview.count({ roomId: 'r-01' })).toBe(3);
    expect(preview.byId('m-03')?.from).toBe('s-02');
    expect(letterCount(project, WORK, {})).toBe(5);
    expect(versionOf()).toBe(before);
  });

  it('mapLetterTx над картой в памяти: deleteRoom комнаты без писем номер не двигает и не пишет', async () => {
    await seed(fillFive);
    const map = readStoredMap(project, WORK);
    const { letters, wrote } = mapLetterTx(map);

    letters.deleteRoom('r-99');
    expect(wrote()).toBe(false);
    expect(map.work.messageSeq).toBeUndefined();

    letters.deleteRoom('r-01');
    expect(wrote()).toBe(true);
    expect(map.work.messageSeq).toBe(5);
    expect(ids(map.messages)).toEqual(['m-01', 'm-05']);
  });
});
