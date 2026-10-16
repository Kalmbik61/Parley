import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleMap } from './assemble.js';
import { journalFile, readMessages } from './journal.js';
import { finishV2Cleanup, hasLiveSession, migrateMapToJournal, type MigrationStep } from './migrate-map.js';
import { addMessage, addSession, removeSession, transitionSession } from './map.js';
import { addRoom } from './rooms.js';
import { createWork, readIndex, readMap, workPaths, workSchemaVersion } from './store.js';
import { HUMAN, type Message, type WorkMap } from './types.js';
import type { DecisionJournalIntent } from './decision-journal.js';
import { recipientsOf } from './letters.js';

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
const ALL = { limit: Infinity, maxBytes: Infinity };

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

/** Отметка «прочитано» так, как её ставил v2: у адресата и у человека на видимых ему письмах. */
function markRead(map: WorkMap, session: string, message: Message): void {
  const eligible =
    session === HUMAN
      ? message.from !== HUMAN && (message.roomId !== null || message.to.includes(HUMAN))
      : recipientsOf(message, map).includes(session);
  if (eligible) message.readBy[session] = message.at;
}

/**
 * Синтетическая карта v2: 3 сессии, 3 комнаты (r-03 в архиве) и прямая почта, 50 писем вперемешку с возрастающим
 * временем, `readBy` у сессий и у человека — и по порядку, и вразнобой (s-03 в r-01 прочла 1, 2 и 4, а 3 — нет),
 * два экспорта решений.
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
  for (const label of ['a', 'b', 'c', 'd']) addSession(map, { provider: 'claude', label, task: 't' }, at(0));
  // r-04 — пустая комната: писем нет, журнала быть не должно.
  for (const title of ['one', 'two', 'three', 'four']) addRoom(map, { title, creator: 's-01', members: ['s-02', 's-03'] }, at(0));
  const keys: (string | null)[] = [null, 'r-01', 'r-02', 'r-03'];
  for (let i = 0; i < 50; i += 1) {
    const roomId = keys[(i * 7) % 4] ?? null;
    addMessage(map, { roomId, from: i % 5 === 0 ? HUMAN : 's-01', to: roomId === null ? ['s-02'] : [], text: `письмо ${i}` }, at(10 + i));
  }
  const own = (key: string): Message[] => map.messages.filter((message) => keyOf(message.roomId) === key);
  // По порядку: s-02 — по 3-8 писем в журнале, человек — первые 4 в r-01 и r-02.
  for (const [key, count] of Object.entries({ direct: 5, 'r-01': 3, 'r-02': 8 })) for (const message of own(key).slice(0, count)) markRead(map, 's-02', message);
  for (const key of ['r-01', 'r-02']) for (const message of own(key).slice(0, 4)) markRead(map, HUMAN, message);
  // Вразнобой: s-03 в r-01 прочла письма 1, 2 и 4, а 3-е нет; в r-02 — 1 и 3.
  for (const index of [0, 1, 3]) markRead(map, 's-03', own('r-01')[index]!);
  for (const index of [0, 2]) markRead(map, 's-03', own('r-02')[index]!);
  // Архивная комната: сессиям там читать нечего, человек прочёл первое.
  markRead(map, HUMAN, own('r-03')[0]!);
  map.rooms.find((room) => room.id === 'r-03')!.archivedAt = at(200);
  // Ответ через комнаты: письмо r-02 отвечает на письмо r-01 (в журнале r-02 такого id нет).
  own('r-02')[1]!.replyTo = own('r-01')[0]!.id;
  // Id не из ряда `m-NN`: прежние карты и правки руками такие допускали.
  own('direct').at(-1)!.id = 'legacy-letter-x';
  // Письма удалённой сессии: s-04 писала в r-01 и в прямую почту, потом её удалили — `deleted` у писем и id в `deletedSessions`.
  own('r-01')[4]!.from = 's-04';
  own('direct')[1]!.to = ['s-02', 's-04'];
  removeSession(map, 's-04');
  return map;
}

/** Работа с картой v2, написанной прямо в файл (как лежит у автора до миграции). */
async function seedV2(build: (workId: string) => WorkMap = fixtureV2): Promise<{ id: string; expected: WorkMap; original: string }> {
  const { work } = await createWork(project, { title: 'fixture' });
  const expected = build(work.id);
  const original = `${JSON.stringify(expected, null, 2)}\n`;
  await writeFile(workPaths(project, work.id).map, original);
  return { id: work.id, expected, original };
}

/** Все файлы работы (кроме замков и временных) → содержимое: сравнение «ничего не изменилось» по байтам. */
async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.endsWith('.lock') && !entry.name.endsWith('.tmp')) out[path.relative(dir, full)] = await readFile(full, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
/** Запуск хоста, заведомо более поздний, чем любая миграция в этих тестах. */
const LATER = '9999-01-01T00:00:00.000Z';
const v2Copy = (workId: string): string => path.join(workPaths(project, workId).dir, 'map.v2.json');

describe('migrateMapToJournal', () => {
  it('мигрирует фикстуру за один вызов: те же письма в том же порядке с тем же readBy, решения на месте', async () => {
    const { id, expected, original } = await seedV2();
    const result = await migrateMapToJournal(project, id);
    expect(result).toMatchObject({ status: 'migrated', letters: 50, orphaned: 0, orderMismatches: 0, readByMismatches: 0 });

    expect(await workSchemaVersion(project, id)).toBe(3);
    const assembled = await assembleMap(project, id);
    expect(assembled.messages).toHaveLength(50);
    expect(assembled.messages).toEqual(expected.messages);
    expect(assembled.decisionExports).toEqual(expected.decisionExports);
    expect(assembled.rooms).toEqual(expected.rooms);
    expect(assembled.sessions).toEqual(expected.sessions);

    // Письма комнаты, как их отдаёт read_room: те же id в том же порядке, номер строки по позиции, прежние id на месте.
    for (const key of ['direct', 'r-01', 'r-02', 'r-03']) {
      const want = expected.messages.filter((message) => keyOf(message.roomId) === key);
      const letters = await readMessages(project, id, key === 'direct' ? null : key, ALL);
      expect(letters.map((letter) => letter.id)).toEqual(want.map((message) => message.id));
      expect(letters.map((letter) => letter.seq)).toEqual(want.map((_, position) => position + 1));
    }
    // Углы, где миграция могла бы потерять данные: пустая комната, удалённая сессия, ответ через комнаты, чужой формат id.
    expect(await exists(journalFile(workPaths(project, id), 'r-04'))).toBe(false);
    expect(await readMessages(project, id, 'r-04', ALL)).toEqual([]);
    const byId = new Map(assembled.messages.map((message) => [message.id, message]));
    expect(expected.messages.filter((message) => message.deleted === true).length).toBeGreaterThan(0);
    for (const message of expected.messages.filter((item) => item.deleted === true)) expect(byId.get(message.id)?.deleted).toBe(true);
    const reply = expected.messages.find((message) => message.replyTo !== undefined)!;
    expect(byId.get(reply.id)?.replyTo).toBe(reply.replyTo);
    expect(byId.get(reply.id)?.roomId).not.toBe(byId.get(reply.replyTo!)?.roomId);
    expect(byId.has('legacy-letter-x')).toBe(true);
    // v2-копия — байт в байт прежняя карта.
    expect(await readFile(v2Copy(id), 'utf8')).toBe(original);
    // Индекс не несёт ни писем, ни решений, `schemaVersion` — первый ключ, `v2Removed` пока ложь.
    const rawIndex = await readFile(workPaths(project, id).map, 'utf8');
    expect(rawIndex.startsWith('{\n  "schemaVersion": 3')).toBe(true);
    expect(rawIndex).not.toContain('"messages"');
    expect((await readIndex(project, id)).v2Removed).toBe(false);
  });

  it('курсор — точные диапазоны: прочитанное подряд один диапазон, прочитанное вразнобой несколько, ничего не потеряно', async () => {
    const { id, expected } = await seedV2();
    await migrateMapToJournal(project, id);
    const paths = workPaths(project, id);
    const r01 = expected.messages.filter((message) => message.roomId === 'r-01');
    const read = async (session: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(path.join(paths.cursors, `${session}.json`), 'utf8')) as Record<string, unknown>;

    // s-02 читала по порядку: письма 1–3 одним диапазоном.
    expect((await read('s-02'))['r-01']).toEqual([[1, 3]]);
    // s-03 в r-01 прочла 1, 2 и 4: два диапазона, 3-е осталось непрочитанным.
    expect((await read('s-03'))['r-01']).toEqual([[1, 2], [4, 4]]);
    // Человек — читатель как сессия; свои письма он не «читает» (разрыва они не образуют), поэтому диапазон — от первого
    // чужого письма из первых четырёх до последнего.
    const seen = r01.slice(0, 4).map((message, at) => [message, at + 1] as const).filter(([message]) => message.from !== HUMAN);
    expect((await read(HUMAN))['r-01']).toEqual([[seen[0]![1], seen.at(-1)![1]]]);
    // Диапазоны дают в точности прежний readBy: 3-е письмо s-03 не прочитано.
    const third = (await assembleMap(project, id)).messages.find((message) => message.id === r01[2]!.id)!;
    expect(third.readBy['s-03']).toBeUndefined();
  });

  it('письма, адресованные не этой сессии, разрыва в чтении не образуют', async () => {
    const { id } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.messages = [];
      addMessage(map, { roomId: 'r-01', from: HUMAN, to: [], text: 'всем' }, at(10));
      addMessage(map, { roomId: 'r-01', from: HUMAN, to: ['s-03'], text: 'только s-03' }, at(11));
      addMessage(map, { roomId: 'r-01', from: HUMAN, to: [], text: 'снова всем' }, at(12));
      for (const message of map.messages) markRead(map, 's-02', message);
      return map;
    });
    await migrateMapToJournal(project, id);
    const cursor = JSON.parse(await readFile(path.join(workPaths(project, id).cursors, 's-02.json'), 'utf8')) as Record<string, unknown>;
    // Письмо 2 s-02 не адресовано: разрыва нет, диапазон сплошной.
    expect(cursor['r-01']).toEqual([[1, 3]]);
  });

  it('второй вызов ничего не меняет: файлы те же по байтам, письма не дублируются', async () => {
    const { id } = await seedV2();
    await migrateMapToJournal(project, id);
    const before = await snapshotFiles(workPaths(project, id).dir);
    expect(await migrateMapToJournal(project, id)).toEqual({ status: 'skipped', reason: 'already-journal' });
    expect(await snapshotFiles(workPaths(project, id).dir)).toEqual(before);
    expect((await assembleMap(project, id)).messages).toHaveLength(50);
  });

  it.each<MigrationStep>(['copy', 'journals', 'cursors', 'decisions', 'verify'])(
    'сбой после шага %s до записи индекса оставляет работу читаемой как v2, ничего не потеряно',
    async (step) => {
      const { id, expected, original } = await seedV2();
      const result = await migrateMapToJournal(project, id, {
        afterStep: (done) => {
          if (done === step) throw new Error('инъекция сбоя');
        },
      });
      expect(result).toMatchObject({ status: 'failed', step });
      expect(await workSchemaVersion(project, id)).toBe(2);
      expect(await readFile(workPaths(project, id).map, 'utf8')).toBe(original);
      expect((await readMap(project, id)).messages).toEqual(expected.messages);

      // Повтор после сбоя доводит дело до конца, не удваивая письма уже записанных журналов.
      expect(await migrateMapToJournal(project, id)).toMatchObject({ status: 'migrated', letters: 50 });
      expect((await assembleMap(project, id)).messages).toEqual(expected.messages);
      for (const key of ['direct', 'r-01', 'r-02', 'r-03']) {
        const lines = (await readFile(journalFile(workPaths(project, id), key === 'direct' ? null : key), 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(expected.messages.filter((message) => keyOf(message.roomId) === key).length);
      }
    },
  );

  it('остатки сорванной попытки (курсор несуществующей сессии) повтор убирает', async () => {
    const { id, expected } = await seedV2();
    await migrateMapToJournal(project, id, {
      afterStep: (done) => {
        if (done === 'decisions') throw new Error('сбой');
      },
    });
    const stray = path.join(workPaths(project, id).cursors, 's-09.json');
    await writeFile(stray, '{"r-01":"m-01"}');
    await migrateMapToJournal(project, id);
    expect(await exists(stray)).toBe(false);
    expect((await assembleMap(project, id)).messages).toEqual(expected.messages);
  });

  it('карта без файла и карта не v2 пропускаются с причиной', async () => {
    expect(await migrateMapToJournal(project, 'w-9999')).toEqual({ status: 'skipped', reason: 'no-map' });
    const { id } = await seedV2();
    const raw = JSON.parse(await readFile(workPaths(project, id).map, 'utf8')) as Record<string, unknown>;
    await writeFile(workPaths(project, id).map, JSON.stringify({ ...raw, schemaVersion: 1 }));
    expect(await migrateMapToJournal(project, id)).toEqual({ status: 'skipped', reason: 'not-v2' });
  });

  it('порядок: равное время в порядке «прямые, затем комнаты индекса» собирается как в v2', async () => {
    const { id, expected } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.messages = [];
      addMessage(map, { roomId: null, from: 's-01', to: ['s-02'], text: 'прямое' }, at(100));
      addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'комната 1' }, at(100));
      addMessage(map, { roomId: 'r-02', from: 's-01', to: [], text: 'комната 2' }, at(100));
      addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'комната 1, позже' }, at(101));
      return map;
    });
    expect(await migrateMapToJournal(project, id)).toMatchObject({ orderMismatches: 0 });
    expect((await assembleMap(project, id)).messages.map((message) => message.id)).toEqual(expected.messages.map((message) => message.id));
  });

  it('порядок: равное время в обратном порядке журналов и часы, ушедшие назад между комнатами, сообщаются', async () => {
    const { id, expected } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.messages = [];
      addMessage(map, { roomId: 'r-02', from: 's-01', to: [], text: 'комната 2, раньше записана' }, at(100));
      addMessage(map, { roomId: null, from: 's-01', to: ['s-02'], text: 'прямое, то же время' }, at(100));
      addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'комната 1' }, at(300));
      addMessage(map, { roomId: 'r-02', from: 's-01', to: [], text: 'комната 2, часы назад' }, at(200));
      return map;
    });
    const result = await migrateMapToJournal(project, id);
    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') return;
    expect(result.orderMismatches).toBeGreaterThan(0);
    // Письма не потеряны, расходится только порядок слияния: тот же набор id.
    const assembled = (await assembleMap(project, id)).messages.map((message) => message.id);
    expect([...assembled].sort()).toEqual(expected.messages.map((message) => message.id).sort());
  });

  it('readBy, который сборщик не воспроизведёт (не адресат), считается и не теряет письма', async () => {
    const { id } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.messages = [];
      const letter = addMessage(map, { roomId: null, from: 's-01', to: ['s-02'], text: 'только s-02' }, at(10));
      letter.readBy['s-03'] = at(11);
      return map;
    });
    expect(await migrateMapToJournal(project, id)).toMatchObject({ status: 'migrated', letters: 1, readByMismatches: 1 });
  });

  it('письмо комнаты, которой нет в индексе, в журнал не идёт, но считается и остаётся в map.v2.json', async () => {
    const { id } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.messages = [];
      addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'своё' }, at(10));
      addMessage(map, { roomId: 'r-77', from: 's-01', to: [], text: 'чужое' }, at(11));
      return map;
    });
    expect(await migrateMapToJournal(project, id)).toMatchObject({ status: 'migrated', letters: 1, orphaned: 1 });
    expect(await readFile(v2Copy(id), 'utf8')).toContain('чужое');
  });
});

describe('finishV2Cleanup', () => {
  it('map.v2.json переживает сборку, а после удачной сборки удаляется и индекс помечается v2Removed', async () => {
    const { id } = await seedV2();
    await migrateMapToJournal(project, id);
    await assembleMap(project, id);
    expect(await exists(v2Copy(id))).toBe(true);
    expect((await readIndex(project, id)).v2Removed).toBe(false);

    expect(await finishV2Cleanup(project, id, LATER)).toBe('removed');
    expect(await exists(v2Copy(id))).toBe(false);
    expect((await readIndex(project, id)).v2Removed).toBe(true);
    expect((await assembleMap(project, id)).messages).toHaveLength(50);
    expect(await finishV2Cleanup(project, id, LATER)).toBe('nothing');
  });

  it('копии уже нет (сорвалось между удалением и флагом) — ставится только флаг', async () => {
    const { id } = await seedV2();
    await migrateMapToJournal(project, id);
    await rm(v2Copy(id));
    expect(await finishV2Cleanup(project, id, LATER)).toBe('removed');
    expect((await readIndex(project, id)).v2Removed).toBe(true);
  });

  it('карта, которая не собралась, копию не трогает', async () => {
    const { id } = await seedV2();
    await migrateMapToJournal(project, id);
    await writeFile(workPaths(project, id).decisions, '{ не json');
    expect(await finishV2Cleanup(project, id, LATER)).toBe('kept');
    expect(await exists(v2Copy(id))).toBe(true);
    expect((await readIndex(project, id)).v2Removed).toBe(false);
  });

  it('работа на v2 со случайной копией рядом не затрагивается', async () => {
    const { id } = await seedV2();
    await copyFile(workPaths(project, id).map, v2Copy(id));
    expect(await finishV2Cleanup(project, id, LATER)).toBe('nothing');
    expect(await exists(v2Copy(id))).toBe(true);
  });
});

describe('миграция и живые сессии под замком', () => {
  it('сессия, живая в карте, прочитанной под map.lock, останавливает миграцию: карта и каталог работы не тронуты', async () => {
    const { id, original } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.sessions[0]!.pid = process.pid;
      transitionSession(map, map.sessions[0]!.id, 'active');
      return map;
    });
    const before = await snapshotFiles(workPaths(project, id).dir);
    expect(await migrateMapToJournal(project, id)).toEqual({ status: 'skipped', reason: 'live-session' });
    expect(await readFile(workPaths(project, id).map, 'utf8')).toBe(original);
    expect(await snapshotFiles(workPaths(project, id).dir)).toEqual(before);
    expect(await exists(v2Copy(id))).toBe(false);
  });
});

describe('когда map.v2.json нельзя убирать', () => {
  const withOrphan = (workId: string): WorkMap => {
    const map = fixtureV2(workId);
    map.messages = [];
    addMessage(map, { roomId: 'r-01', from: 's-01', to: [], text: 'своё' }, at(10));
    addMessage(map, { roomId: 'r-77', from: 's-01', to: [], text: 'чужое' }, at(11));
    return map;
  };

  it('письмо без комнаты в индексе: копия остаётся после уборки, причина лежит в индексе, v2Removed ложен', async () => {
    const { id } = await seedV2(withOrphan);
    expect(await migrateMapToJournal(project, id)).toMatchObject({ status: 'migrated', orphaned: 1 });
    expect(await finishV2Cleanup(project, id, LATER)).toBe('kept-dropped');
    expect(await exists(v2Copy(id))).toBe(true);
    const index = await readIndex(project, id);
    expect(index.v2Removed).toBe(false);
    expect(index.v2Kept).toEqual({ orphaned: 1, readByMismatches: 0, orderMismatches: 0 });
    expect(await readFile(v2Copy(id), 'utf8')).toContain('чужое');
  });

  it('расхождение порядка или читателей тоже оставляет копию', async () => {
    const { id } = await seedV2((workId) => {
      const map = fixtureV2(workId);
      map.messages = [];
      const letter = addMessage(map, { roomId: null, from: 's-01', to: ['s-02'], text: 'только s-02' }, at(10));
      letter.readBy['s-03'] = at(11);
      return map;
    });
    await migrateMapToJournal(project, id);
    expect(await finishV2Cleanup(project, id, LATER)).toBe('kept-dropped');
    expect(await exists(v2Copy(id))).toBe(true);
  });

  it('копия, сделанная этим запуском хоста, переживает его; следующий запуск убирает', async () => {
    const { id } = await seedV2();
    const first = '2026-10-16T10:00:00.000Z';
    await migrateMapToJournal(project, id, { run: first });
    expect((await readIndex(project, id)).migratedRun).toBe(first);
    expect(await finishV2Cleanup(project, id, first)).toBe('same-run');
    expect(await exists(v2Copy(id))).toBe(true);
    expect((await readIndex(project, id)).v2Removed).toBe(false);
    // Запуск, начатый раньше миграции (чужой, ещё идущий), тоже не убирает.
    expect(await finishV2Cleanup(project, id, '2026-10-16T09:00:00.000Z')).toBe('same-run');
    expect(await exists(v2Copy(id))).toBe(true);

    expect(await finishV2Cleanup(project, id, '2026-10-16T11:00:00.000Z')).toBe('removed');
    expect(await exists(v2Copy(id))).toBe(false);
    expect((await readIndex(project, id)).v2Removed).toBe(true);
  });
});

describe('hasLiveSession', () => {
  it('живая сессия — работа занята; ожидающая и уснувшая с мёртвым pid — нет', async () => {
    const map = fixtureV2('w-0001');
    expect(await hasLiveSession(map)).toBe(false);
    const [first, second] = map.sessions;
    first!.pid = 999_999;
    transitionSession(map, first!.id, 'active');
    transitionSession(map, first!.id, 'sleeping');
    expect(await hasLiveSession(map)).toBe(false);
    second!.pid = process.pid;
    transitionSession(map, second!.id, 'active');
    expect(await hasLiveSession(map)).toBe(true);
  });
});
