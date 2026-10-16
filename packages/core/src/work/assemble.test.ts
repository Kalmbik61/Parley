import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleMap, MapJournalReadonlyError } from './assemble.js';
import { journalFile, journalLine, type JournalLetter } from './journal.js';
import { recipientsOf } from './letters.js';
import { addMessage, addSession, parseMap } from './map.js';
import { addRoom } from './rooms.js';
import { createWork, readIndex, readMap, readWorksIndex, updateIndex, updateMap, workPaths } from './store.js';
import { HUMAN, type Message, type WorkMap } from './types.js';
import type { DecisionJournalIntent } from './decision-journal.js';

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const at = (second: number): string => new Date(T0 + second * 1000).toISOString();
const keyOf = (roomId: string | null): string => roomId ?? 'direct';

const decision = (workId: string, n: number): DecisionJournalIntent => ({
  file: `2026-10-10-${workId}-r-01-p-${n}-rev-01.md`,
  workId,
  roomId: 'r-01',
  proposalId: `p-${n}`,
  rev: 1,
  messageId: `m-${n}`,
  acceptedAt: at(n),
  kind: 'decision',
  snapshot: null,
  snapshotSha256: null,
  content: `решение ${n}`,
  status: 'pending',
});

/**
 * Синтетическая карта v2: 3 сессии, 3 комнаты и прямая почта, 50 писем вперемешку (порядок записи = порядок `at`),
 * у части писем `readBy` по сессии и по человеку, два экспорта решений. Форма важна, не содержание.
 * `readBy` ставится по правилу курсора (письмо и все более ранние в своём журнале), значение — время письма:
 * реальное время чтения курсор не хранит, сборщик подставляет время самого письма.
 * Отметка стоит только там, где её поставил бы v2: у адресата и у человека на видимых ему письмах.
 */
function fixtureV2(workId: string): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: { id: workId, title: 'fixture', goal: '', status: 'active', createdAt: at(0), updatedAt: at(5), planSeq: 0 },
    sessions: [],
    messages: [],
    rooms: [],
    decisionExports: [decision(workId, 1), decision(workId, 2)],
  };
  for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 't' }, at(0));
  for (const title of ['one', 'two', 'three']) addRoom(map, { title, creator: 's-01', members: ['s-02', 's-03'] }, at(0));
  const keys: (string | null)[] = [null, 'r-01', 'r-02', 'r-03'];
  for (let i = 0; i < 50; i += 1) {
    const roomId = keys[(i * 7) % 4] ?? null;
    addMessage(map, { roomId, from: i % 5 === 0 ? HUMAN : 's-01', to: roomId === null ? ['s-02'] : [], text: `письмо ${i}` }, at(10 + i));
  }
  // Курсоры: s-02 прочла по 3-8 писем в каждом журнале, человек — первые 4 в r-01 и r-02, s-03 — ничего.
  const reads: [string, Record<string, number>][] = [
    ['s-02', { direct: 5, 'r-01': 3, 'r-02': 8, 'r-03': 0 }],
    [HUMAN, { 'r-01': 4, 'r-02': 4 }],
  ];
  for (const [session, counts] of reads) {
    for (const [key, count] of Object.entries(counts)) {
      const own = map.messages.filter((message) => keyOf(message.roomId) === key);
      // Как v2: отметка только у адресата, у человека — только на письмах, которые он видит и пишет не сам.
      const eligible = (message: Message): boolean =>
        session === HUMAN ? message.from !== HUMAN && (message.roomId !== null || message.to.includes(HUMAN)) : recipientsOf(message, map).includes(session);
      for (const message of own.slice(0, count)) if (eligible(message)) message.readBy[session] = message.at;
    }
  }
  return map;
}

/** Раскладывает карту v2 по формату v3: индекс, журналы с прежними id, курсоры, `decisions.json`. */
async function writeV3(map: WorkMap): Promise<void> {
  const paths = workPaths(project, map.work.id);
  const { messages, decisionExports, ...index } = map;
  await writeFile(paths.map, `${JSON.stringify({ ...index, schemaVersion: 3 }, null, 2)}\n`);
  const journals = new Map<string, Message[]>();
  for (const message of messages) journals.set(keyOf(message.roomId), [...(journals.get(keyOf(message.roomId)) ?? []), message]);
  const cursors = new Map<string, Record<string, string>>();
  for (const [key, list] of journals) {
    const file = journalFile(paths, key === 'direct' ? null : key);
    await mkdir(path.dirname(file), { recursive: true });
    const rows = list.map((message, seq): string => {
      const rest = { ...message };
      delete (rest as { readBy?: unknown }).readBy;
      delete (rest as { textBytes?: unknown }).textBytes;
      return journalLine({ ...rest, seq: seq + 1 } as JournalLetter);
    });
    await writeFile(file, rows.join(''));
    for (const message of list) {
      for (const session of Object.keys(message.readBy)) cursors.set(session, { ...(cursors.get(session) ?? {}), [key]: message.id });
    }
  }
  await mkdir(paths.cursors, { recursive: true });
  for (const [session, value] of cursors) await writeFile(path.join(paths.cursors, `${session}.json`), JSON.stringify(value));
  if (decisionExports !== undefined) await writeFile(paths.decisions, JSON.stringify(decisionExports));
}

/** Создаёт работу и кладёт на её место фикстуру: v2 как есть или в раскладке v3. */
async function seedWork(layout: 'v2' | 'v3'): Promise<{ id: string; expected: WorkMap }> {
  const { work } = await createWork(project, { title: 'fixture' });
  const expected = fixtureV2(work.id);
  if (layout === 'v3') await writeV3(expected);
  else await writeFile(workPaths(project, work.id).map, `${JSON.stringify(expected, null, 2)}\n`);
  return { id: work.id, expected };
}

describe('assembleMap', () => {
  it('даёт те же письма в том же порядке, что v2-карта: readBy у сессий и у человека, решения', async () => {
    const { id, expected } = await seedWork('v3');
    const assembled = await assembleMap(project, id);
    expect(assembled.messages).toHaveLength(50);
    expect(assembled.messages).toEqual(expected.messages);
    expect(assembled.messages.some((message) => message.readBy[HUMAN] !== undefined)).toBe(true);
    expect(assembled.messages.some((message) => message.readBy['s-02'] !== undefined)).toBe(true);
    expect(assembled.messages.every((message) => message.readBy['s-03'] === undefined)).toBe(true);
    expect(assembled.decisionExports).toEqual(expected.decisionExports);
    expect(assembled.sessions).toEqual(expected.sessions);
    expect(assembled.rooms).toEqual(expected.rooms);
    expect(assembled.schemaVersion).toBe(2);
  });

  it('письма разных журналов идут по времени, внутри журнала порядок записи; при равном времени прямые раньше комнаты', async () => {
    const { work } = await createWork(project, { title: 'ties' });
    const map = fixtureV2(work.id);
    map.messages = [];
    addMessage(map, { roomId: 'r-02', from: 's-01', to: [], text: 'комната 2, первое' }, at(100));
    addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'комната 1, то же время' }, at(100));
    addMessage(map, { roomId: null, from: 's-01', to: ['s-02'], text: 'прямое, то же время' }, at(100));
    addMessage(map, { roomId: 'r-02', from: 's-01', to: [], text: 'комната 2, позже' }, at(101));
    await writeV3(map);
    const texts = (await assembleMap(project, work.id)).messages.map((message) => message.text);
    expect(texts).toEqual(['прямое, то же время', 'комната 1, то же время', 'комната 2, первое', 'комната 2, позже']);
  });

  it('work.updatedAt следует за самым новым письмом, если индекс старше; новее индекса письма нет — его значение', async () => {
    const { id, expected } = await seedWork('v3');
    expect((await assembleMap(project, id)).work.updatedAt).toBe(at(59));
    const index = JSON.parse(await readFile(workPaths(project, id).map, 'utf8')) as WorkMap;
    index.work.updatedAt = at(1000);
    await writeFile(workPaths(project, id).map, JSON.stringify(index));
    expect((await assembleMap(project, id)).work.updatedAt).toBe(at(1000));
    expect(expected.work.updatedAt).toBe(at(5));
  });

  it('нет журналов, курсоров и decisions.json — пустая карта писем без decisionExports', async () => {
    const { id } = await seedWork('v3');
    const paths = workPaths(project, id);
    await rm(paths.rooms, { recursive: true });
    await rm(path.dirname(paths.direct), { recursive: true });
    await rm(paths.cursors, { recursive: true });
    await rm(paths.decisions);
    const assembled = await assembleMap(project, id);
    expect(assembled.messages).toEqual([]);
    expect('decisionExports' in assembled).toBe(false);
  });

  it('decisions.json с битой записью — отказ, как у карты v2', async () => {
    const { id } = await seedWork('v3');
    await writeFile(workPaths(project, id).decisions, JSON.stringify([{ file: 'x' }]));
    await expect(assembleMap(project, id)).rejects.toMatchObject({ code: 'journal-invalid' });
  });

  it('readMap на v3 возвращает собранную карту', async () => {
    const { id, expected } = await seedWork('v3');
    expect(await readMap(project, id)).toEqual(await assembleMap(project, id));
    expect((await readMap(project, id)).messages).toEqual(expected.messages);
  });
});

describe('updateMap на карте-журнале', () => {
  it('мутатор, не трогающий письма, пишет один индекс: журналы, курсоры и decisions.json не тронуты', async () => {
    const { id } = await seedWork('v3');
    const paths = workPaths(project, id);
    const watched = [paths.decisions, journalFile(paths, null), journalFile(paths, 'r-01'), journalFile(paths, 'r-02'), journalFile(paths, 'r-03'), ...(await readdir(paths.cursors)).map((name) => path.join(paths.cursors, name))];
    const state = async (): Promise<Record<string, { text: string; mtimeNs: bigint }>> =>
      Object.fromEntries(await Promise.all(watched.map(async (file) => [file, { text: await readFile(file, 'utf8'), mtimeNs: (await stat(file, { bigint: true })).mtimeNs }] as const)));
    const before = await state();

    const result = await updateMap(project, id, (map) => {
      map.sessions[0]!.label = 'переименована';
      map.rooms[0]!.title = 'другое';
    });
    expect(result.sessions[0]!.label).toBe('переименована');

    const onDisk = JSON.parse(await readFile(paths.map, 'utf8')) as Record<string, unknown>;
    expect(onDisk['schemaVersion']).toBe(3);
    expect(onDisk).not.toHaveProperty('messages');
    expect(onDisk).not.toHaveProperty('decisionExports');
    expect((await readIndex(project, id)).sessions[0]!.label).toBe('переименована');
    expect((await stat(paths.bak)).isFile()).toBe(true);
    expect(await state()).toEqual(before);
    const entry = (await readWorksIndex()).works.find((work) => work.id === id);
    expect(entry?.updatedAt).toBe((await readIndex(project, id)).work.updatedAt);
  });

  it('письма читаются лениво и доступны мутатору: чтение работает, второй доступ даёт тот же объект', async () => {
    const { id, expected } = await seedWork('v3');
    let seen: Message[] = [];
    await updateMap(project, id, (map) => {
      seen = map.messages.filter((message) => message.roomId === 'r-01');
      expect(map.messages).toHaveLength(50);
      expect(map.messages).toBe(map.messages);
      expect(map.decisionExports).toHaveLength(2);
    });
    expect(seen).toEqual(expected.messages.filter((message) => message.roomId === 'r-01'));
  });

  it.each([
    ['push', (map: WorkMap) => map.messages.push({} as Message), /appendMessage/],
    ['splice', (map: WorkMap) => map.messages.splice(0, 1), /appendMessage/],
    ['присваивание по индексу', (map: WorkMap) => void (map.messages[0] = {} as Message), /appendMessage/],
    ['sort', (map: WorkMap) => map.messages.sort(), /appendMessage/],
    ['length', (map: WorkMap) => void (map.messages.length = 0), /appendMessage/],
    ['delete', (map: WorkMap) => void delete (map.messages as unknown as Record<number, unknown>)[0], /appendMessage/],
    ['правка readBy письма', (map: WorkMap) => void (map.messages[0]!.readBy['s-09'] = 'x'), /writeCursor/],
    ['другое содержимое messages', (map: WorkMap) => void (map.messages = []), /appendMessage/],
    ['delete map.messages', (map: WorkMap) => void delete (map as Partial<WorkMap>).messages, /appendMessage/],
    ['push в decisionExports', (map: WorkMap) => map.decisionExports!.push({} as DecisionJournalIntent), /decisions\.json/],
    ['правка решения', (map: WorkMap) => void (map.decisionExports![0]!.status = 'written'), /decisions\.json/],
  ])('%s: ошибка с названием API, на диске ничего не меняется', async (_name, mutate, hint) => {
    const { id } = await seedWork('v3');
    const mapText = await readFile(workPaths(project, id).map, 'utf8');
    const failure = await updateMap(project, id, (map) => void mutate(map)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MapJournalReadonlyError);
    expect((failure as MapJournalReadonlyError).code).toBe('map-journal-readonly');
    expect((failure as Error).message).toMatch(hint);
    expect(await readFile(workPaths(project, id).map, 'utf8')).toBe(mapText);
  });

  it('присвоить messages тем же содержимым можно: черновики планов делают так без писем', async () => {
    const { id } = await seedWork('v3');
    await expect(updateMap(project, id, (map) => void (map.messages = [...map.messages]))).resolves.toBeDefined();
  });
});

describe('индекс и разбор', () => {
  it('parseMap отказывает карте v3: формат новее, нужен перезапуск сессии', async () => {
    const { id } = await seedWork('v3');
    const raw = await readFile(workPaths(project, id).map, 'utf8');
    expect(() => parseMap(raw, 'map.json')).toThrow(/newer format.*restart the session/);
  });

  it('readIndex читает индекс без писем; updateIndex пишет его и сдвигает updatedAt', async () => {
    const { id } = await seedWork('v3');
    const index = await readIndex(project, id);
    expect(index.schemaVersion).toBe(3);
    expect(index).not.toHaveProperty('messages');
    const updated = await updateIndex(project, id, (draft) => void (draft.work.title = 'новое'));
    expect(updated.work.title).toBe('новое');
    expect(updated.work.updatedAt > index.work.updatedAt).toBe(true);
    expect(JSON.parse(await readFile(workPaths(project, id).map, 'utf8'))).not.toHaveProperty('messages');
  });

  it('индекс неверной формы и карта v2 получают свои понятные ошибки', async () => {
    const { id } = await seedWork('v2');
    await expect(readIndex(project, id)).rejects.toThrow(/not in the journal format \(schemaVersion 2\).*readMap/);
    await expect(updateIndex(project, id, () => undefined)).rejects.toThrow(/not in the journal format/);
    await writeFile(workPaths(project, id).map, JSON.stringify({ schemaVersion: 3, work: { id }, sessions: [] }));
    await expect(readIndex(project, id)).rejects.toThrow(/cannot be parsed: unexpected shape/);
    await writeFile(workPaths(project, id).map, '{ not json');
    await expect(readIndex(project, id)).rejects.toThrow(/index .* cannot be parsed/);
  });
});

describe('карта v2 не изменилась', () => {
  it('readMap и updateMap работают как прежде: письмо в массиве, на диске v2', async () => {
    const { id, expected } = await seedWork('v2');
    expect((await readMap(project, id)).messages).toEqual(expected.messages);
    const result = await updateMap(project, id, (map) => {
      addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'новое' }, at(500));
    });
    expect(result.messages).toHaveLength(51);
    const onDisk = JSON.parse(await readFile(workPaths(project, id).map, 'utf8')) as WorkMap;
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.messages).toHaveLength(51);
    await expect(updateMap(project, id, () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});

describe('вид карты-журнала: поля, которых нет в индексе, видны как на v2', () => {
  const plain = (map: WorkMap): WorkMap => JSON.parse(JSON.stringify(map)) as WorkMap;

  it('в мутаторе: in, Object.keys, расширение и JSON.stringify содержат messages и decisionExports', async () => {
    const { id, expected } = await seedWork('v3');
    let probe: Record<string, unknown> = {};
    await updateMap(project, id, (map) => {
      probe = {
        hasMessages: 'messages' in map,
        hasDecisions: 'decisionExports' in map,
        keys: Object.keys(map),
        spread: { ...map },
        json: JSON.parse(JSON.stringify(map)),
        ownDescriptor: Object.getOwnPropertyDescriptor(map, 'messages')?.enumerable,
      };
    });
    expect(probe['hasMessages']).toBe(true);
    expect(probe['hasDecisions']).toBe(true);
    expect(probe['keys']).toEqual(expect.arrayContaining(['messages', 'decisionExports', 'work', 'sessions', 'rooms']));
    expect(probe['ownDescriptor']).toBe(true);
    expect((probe['spread'] as WorkMap).messages).toEqual(expected.messages);
    expect((probe['spread'] as WorkMap).decisionExports).toEqual(expected.decisionExports);
    expect((probe['json'] as WorkMap).messages).toEqual(plain(expected).messages);
    expect((probe['json'] as WorkMap).decisionExports).toEqual(expected.decisionExports);
  });

  it('без decisions.json decisionExports нет ни в in, ни в ключах — как у v2 без решений', async () => {
    const { id } = await seedWork('v3');
    await rm(workPaths(project, id).decisions);
    await updateMap(project, id, (map) => {
      expect('decisionExports' in map).toBe(false);
      expect(Object.keys(map)).not.toContain('decisionExports');
      expect(Object.keys(map)).toContain('messages');
    });
  });

  it('возвращённая карта — обычный объект: ключи, расширение, JSON и structuredClone как у v2', async () => {
    const { id, expected } = await seedWork('v3');
    const result = await updateMap(project, id, (map) => void (map.sessions[0]!.label = 'x'));
    expect('messages' in result).toBe(true);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['messages', 'decisionExports']));
    expect({ ...result }.messages).toEqual(expected.messages);
    expect(JSON.parse(JSON.stringify(result)).messages).toEqual(plain(expected).messages);
    const cloned = structuredClone(result);
    expect(cloned.messages).toEqual(expected.messages);
    expect(cloned.decisionExports).toEqual(expected.decisionExports);
    expect(cloned.sessions[0]!.label).toBe('x');
    expect(structuredClone(await readMap(project, id)).messages).toEqual(expected.messages);
    expect(result.schemaVersion).toBe(2);
  });

  it('охрана на месте после добавленных ловушек: push, splice, индекс, sort, length, delete', async () => {
    const { id } = await seedWork('v3');
    const attempts: [string, (map: WorkMap) => void][] = [
      ['push', (map) => void map.messages.push({} as Message)],
      ['splice', (map) => void map.messages.splice(0, 1)],
      ['индекс', (map) => void (map.messages[0] = {} as Message)],
      ['sort', (map) => void map.messages.sort()],
      ['length', (map) => void (map.messages.length = 0)],
      ['delete', (map) => void delete (map.messages as unknown as Record<number, unknown>)[0]],
    ];
    for (const [, attempt] of attempts) {
      const failure = await updateMap(project, id, (map) => {
        // Сначала перечисление: ловушки перечисления не должны подменить охраняемый массив.
        void Object.keys(map);
        void { ...map };
        attempt(map);
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MapJournalReadonlyError);
      expect((failure as Error).message).toMatch(/appendMessage/);
    }
  });
});

describe('ленивая сборка: запись индекса не читает журналы', () => {
  /** Подкладывает вместо журналов, курсора и решений то, что нельзя прочитать: любое чтение либо бросит, либо предупредит. */
  async function plantUnreadable(id: string, { decisions }: { decisions: boolean }): Promise<void> {
    const paths = workPaths(project, id);
    for (const file of [journalFile(paths, null), journalFile(paths, 'r-01'), path.join(paths.cursors, 's-02.json')]) {
      await rm(file);
      await mkdir(file); // каталог на месте файла: readFile даёт EISDIR
    }
    if (decisions) await writeFile(paths.decisions, '{ not json');
  }

  it('запись индекса не читает ни журналов, ни курсоров, ни decisions.json, а возврат отдаёт письма по первому обращению', async () => {
    const { id } = await seedWork('v3');
    await plantUnreadable(id, { decisions: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Любое чтение подложенного бросило бы (журнал, решения) или предупредило бы (курсор): здесь не бросает и молчит.
      const result = await updateMap(project, id, (map) => void (map.sessions[0]!.label = 'без писем'));
      expect(result.sessions[0]!.label).toBe('без писем');
      expect(warn).not.toHaveBeenCalled();
      expect((await readIndex(project, id)).sessions[0]!.label).toBe('без писем');
      // Аксессоры перечислимы и настраиваемы, а карта — обычный объект.
      for (const field of ['messages', 'decisionExports'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(result, field)!;
        expect([typeof descriptor.get, descriptor.enumerable, descriptor.configurable]).toEqual(['function', true, true]);
      }
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      // Контроль: те же файлы при первом обращении действительно читаются.
      expect(() => result.messages).toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it('битый decisions.json не мешает записи индекса и письмам; ошибка — только тому, кто читает решения', async () => {
    const { id, expected } = await seedWork('v3');
    await writeFile(workPaths(project, id).decisions, '{ not json');
    const result = await updateMap(project, id, (map) => void (map.sessions[0]!.label = 'x'));
    expect(result.messages).toEqual(expected.messages);
    expect(() => result.decisionExports).toThrow(/decisions .* cannot be parsed/);
    await expect(updateMap(project, id, (map) => void map.decisionExports)).rejects.toThrow(/cannot be parsed/);
    await expect(updateMap(project, id, (map) => void map.messages.length)).resolves.toBeDefined();
  });

  it('ленивое поле запоминается и после чтения не отличается от поля карты v2', async () => {
    const { id } = await seedWork('v3');
    const result = await updateMap(project, id, () => undefined);
    expect(result.messages).toBe(result.messages);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['messages', 'decisionExports', 'work', 'sessions', 'rooms']));
    // readMap собирает один раз и отдаёт данные, а не аксессоры.
    const read = await readMap(project, id);
    expect(Object.getOwnPropertyDescriptor(read, 'messages')).toMatchObject({ value: expect.any(Array) });
  });

  it('мутатор: присвоение messages из фильтра (удаление комнаты) бросает ошибку с названием API; чтение и структура индекса работают', async () => {
    const { id } = await seedWork('v3');
    const mapText = await readFile(workPaths(project, id).map, 'utf8');
    const failure = await updateMap(project, id, (map) => {
      map.messages = map.messages.filter((message) => message.roomId !== 'r-01');
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MapJournalReadonlyError);
    expect((failure as Error).message).toMatch(/appendMessage/);
    expect(await readFile(workPaths(project, id).map, 'utf8')).toBe(mapText);
    await updateMap(project, id, (map) => {
      expect(structuredClone(map.sessions)).toEqual(map.sessions);
      expect(structuredClone(map.rooms)).toEqual(map.rooms);
    });
  });

  it('мутатор: верхнеуровневые поля индекса, присвоенные в мутаторе, доходят до диска', async () => {
    const { id } = await seedWork('v3');
    await updateMap(project, id, (map) => {
      map.planEffects ??= [];
      map.rooms = map.rooms.slice(0, 2);
    });
    const onDisk = JSON.parse(await readFile(workPaths(project, id).map, 'utf8')) as WorkMap;
    expect(onDisk.planEffects).toEqual([]);
    expect(onDisk.rooms).toHaveLength(2);
    expect(onDisk).not.toHaveProperty('messages');
  });

  it('мутатор: значение, присвоенное несуществующему decisionExports, — ошибка до записи', async () => {
    const { id } = await seedWork('v3');
    await rm(workPaths(project, id).decisions);
    const mapText = await readFile(workPaths(project, id).map, 'utf8');
    const failure = await updateMap(project, id, (map) => void (map.decisionExports ??= [])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MapJournalReadonlyError);
    expect(await readFile(workPaths(project, id).map, 'utf8')).toBe(mapText);
  });
});

describe('readBy собирается как в v2: только адресаты и человек', () => {
  const room = (map: WorkMap, from: string, text: string, second: number, roomId: string | null = 'r-01', to: string[] = []): Message =>
    addMessage(map, { roomId, from, to, text }, at(second));

  async function build(fill: (map: WorkMap) => void): Promise<{ id: string; map: WorkMap }> {
    const { work } = await createWork(project, { title: 'readby' });
    const map = fixtureV2(work.id);
    map.messages = [];
    fill(map);
    await writeV3(map);
    return { id: work.id, map };
  }

  it('сессия, чей курсор за письмом, которого она не адресат, отметки не получает', async () => {
    const { id } = await build((map) => {
      const letter = room(map, 's-01', 'прямое s-02', 100, null, ['s-02']);
      letter.readBy = { 's-02': letter.at, 's-03': letter.at };
    });
    const [letter] = (await assembleMap(project, id)).messages;
    expect(Object.keys(letter!.readBy)).toEqual(['s-02']);
  });

  it('отправитель не получает отметку на своё письмо, даже если его курсор за ним', async () => {
    const { id } = await build((map) => {
      const letter = room(map, 's-02', 'из комнаты', 100);
      letter.readBy = { 's-02': letter.at, 's-03': letter.at };
    });
    const [letter] = (await assembleMap(project, id)).messages;
    expect(letter!.readBy).toEqual({ 's-03': letter!.at });
  });

  it('курсор человека отмечает видимое окну (письма комнаты, прямые ему), но не его письма и не чужие прямые', async () => {
    const { id } = await build((map) => {
      const rows = [room(map, 's-01', 'комната', 100), room(map, HUMAN, 'свое', 101), room(map, 's-01', 'прямое человеку', 102, null, [HUMAN]), room(map, 's-01', 'прямое s-02', 103, null, ['s-02'])];
      for (const row of rows) row.readBy = { [HUMAN]: row.at };
    });
    const marked = (await assembleMap(project, id)).messages.filter((message) => message.readBy[HUMAN] !== undefined).map((message) => message.text);
    expect(marked.sort()).toEqual(['комната', 'прямое человеку']);
  });

  it('курсор человека на последнем письме комнаты отмечает и прямые ему в том же журнале', async () => {
    const { id } = await build((map) => {
      const rows = [room(map, 's-01', 'первое', 100, null, [HUMAN]), room(map, 's-01', 'второе', 101, null, [HUMAN])];
      rows[1]!.readBy = { [HUMAN]: rows[1]!.at };
    });
    const marked = (await assembleMap(project, id)).messages.map((message) => message.readBy[HUMAN] !== undefined);
    expect(marked).toEqual([true, true]);
  });

  it('разреженная отметка человека v2 после перехода значит «всё до неё прочитано»: курсор — водораздел', async () => {
    const { id } = await build((map) => {
      const rows = [room(map, 's-01', 'первое', 100), room(map, 's-01', 'второе', 101), room(map, 's-01', 'третье', 102)];
      // v2: окно погасило одно третье письмо, первое и второе остались непрочитанными.
      rows[2]!.readBy = { [HUMAN]: rows[2]!.at };
    });
    const letters = (await assembleMap(project, id)).messages;
    expect(letters.map((message) => message.readBy[HUMAN] !== undefined)).toEqual([true, true, true]);
  });
});

describe('журнал комнаты, которой нет в индексе', () => {
  it('сборщик предупреждает о журнале и не берёт его письма: асинхронно и в мутаторе', async () => {
    const { id, expected } = await seedWork('v3');
    const paths = workPaths(project, id);
    const stray = journalFile(paths, 'r-99');
    await mkdir(path.dirname(stray), { recursive: true });
    await writeFile(stray, journalLine({ seq: 1, id: 'm-r-99-1', roomId: 'r-99', from: 's-01', to: [], text: 'ничья', kind: 'note', at: at(900) } as JournalLetter));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const assembled = await assembleMap(project, id);
      expect(assembled.messages).toEqual(expected.messages);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/r-99.*not in the index/));
      warn.mockClear();
      await updateMap(project, id, (map) => void map.messages.length);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/r-99.*not in the index/));
    } finally {
      warn.mockRestore();
    }
  });

  it('все журналы известны — предупреждений нет', async () => {
    const { id } = await seedWork('v3');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await assembleMap(project, id);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
