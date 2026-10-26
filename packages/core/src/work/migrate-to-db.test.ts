/**
 * Переезд прежних `map.json` в базу на старте хоста (спека хранилища 6.6): вставка строк одной транзакцией, сверка с
 * разобранной картой до `COMMIT`, затем `map.json` → `map.v2.json`. Только временные дома и проекты.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeWorkDb, WORK_DB_FILE } from './db.js';
import { legacyUnread, verifyLetterMap } from './letter-upgrade.js';
import { unreadFor, unreadForHuman } from './letters.js';
import { mapToRows } from './map-rows.js';
import { addMessage, addSession, parseMap } from './map.js';
import { migrateMapsToDb } from './migrate-to-db.js';
import { reservePlanEffects } from './plan-effects.js';
import { resolveProposal, setProposal } from './proposals.js';
import { addRoom } from './rooms.js';
import { unreadLetters } from './letter-store.js';
import { createWork, readMap, readStoredMap, readWorksIndex, replaceStoredMap, storeDb, workExists, workVersion } from './store.js';
import type { DecisionJournalMap } from './decision-journal.js';
import { HUMAN, type Message, type PlanDraft, type Room, type WindowWorkMap, type WorkMap } from './types.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const AT = '2026-10-04T01:00:00.000Z';
const asRoot = process.getuid?.() === 0;

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

const emptyMap = (id = 'w-0001', title = 'Старая работа'): WindowWorkMap => ({
  schemaVersion: 2,
  work: { id, title, goal: '', status: 'active', createdAt: AT, updatedAt: AT },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Карта со всеми коллекциями (как в `map-rows.test.ts`) и письмами с разной отметкой прочтения: людям и сессиям. */
function fullMap(): WindowWorkMap {
  const map = emptyMap();
  for (const label of ['Lead', 'Owner', 'Reviewer']) {
    addSession(map, { provider: 'codex', label, task: 'Fixture' }, AT);
  }
  addRoom(map, { title: 'Plan', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01', mode: 'verified' }, AT);
  addRoom(map, { title: 'Chat', creator: HUMAN, members: ['s-01', 's-02'] }, AT);
  const draft: PlanDraft = {
    mode: 'verified',
    goal: 'Done',
    items: [{ id: 1, title: 'Item 1', owner: 's-02', scope: 'src/a.ts', criteria: ['Passing checks'], verifier: 's-03' }],
  };
  const proposed = setProposal(map, 'r-01', 's-01', 'Decision', AT, { plan: draft });
  resolveProposal(
    map,
    lt(map),
    'r-01',
    proposed.proposalId,
    'accept',
    { rev: proposed.rev, planId: map.rooms[0]!.proposal!.plan!.id, planRev: 0 },
    AT,
  );
  reservePlanEffects(map, lt(map), 20, AT);
  addMessage(map, { from: 's-02', to: ['s-01'], text: 'ping' }, AT);
  addMessage(map, { from: 's-01', to: [HUMAN], text: 'для человека' }, AT);
  addMessage(map, { from: 's-03', to: [], text: 'в комнату', roomId: 'r-02' }, AT);
  const read = addMessage(map, { from: 's-02', to: ['s-03'], text: 'уже прочитано' }, AT);
  read.readBy['s-03'] = AT;

  const plan = map.plans![0]!;
  plan.status = 'completed';
  plan.completedAt = AT;
  plan.backlog = ['b-001'];
  map.planBacklogIntents = [
    {
      key: `${plan.id}/${plan.rev}/b-001/${AT}`,
      planId: plan.id,
      rev: plan.rev,
      backlogId: 'b-001',
      completedAt: AT,
      status: 'pending',
    },
  ];
  map.resources = { seq: 1, spawned: 1, spawnedByRoom: { 'r-01': 1 }, attempts: [] };
  return map;
}

/** Карта формата v1 с единым статусом сессии и одним адресатом письма — такой её писала самая первая сборка. */
const v1Map = (): Record<string, unknown> => ({
  schemaVersion: 1,
  work: { id: 'w-0001', title: 'Первая сборка', goal: '', status: 'active', createdAt: AT, updatedAt: AT },
  sessions: [
    {
      id: 's-01',
      provider: 'claude',
      label: 'старая',
      task: 'задача',
      parent: null,
      contextFrom: [],
      status: 'done',
      history: [
        { status: 'pending', at: AT },
        { status: 'active', at: AT },
        { status: 'done', at: AT },
      ],
      startedAt: AT,
      endedAt: AT,
      providerSessionId: null,
      metrics: null,
      summary: null,
      summarySource: null,
      artifacts: [],
    },
  ],
  messages: [
    { id: 'm-01', from: 's-01', to: 's-02', text: 'прочитано', at: AT, readAt: AT },
    { id: 'm-02', from: 's-01', to: 's-02', text: 'не прочитано', at: AT },
  ],
});

/** Непрочитанное по каждой сессии и у человека: то, что сверка обязана сохранить. */
function unreadDigest(map: WindowWorkMap): { bySession: Record<string, string[]>; human: string[] } {
  return {
    bySession: Object.fromEntries(map.sessions.map((session) => [session.id, unreadFor(map, session.id).map((message) => message.id)])),
    human: map.messages.filter(unreadForHuman).map((message) => message.id),
  };
}

/** Непрочитанное по каждой сессии и у человека, как его отдаёт база (кандидаты и живые правила), а не чистые правила над картой. */
function storedUnread(project: string, map: WindowWorkMap): { bySession: Record<string, string[]>; human: string[] } {
  return {
    bySession: Object.fromEntries(
      map.sessions.map((session) => [session.id, unreadLetters(project, map.work.id, session.id).map((message) => message.id)]),
    ),
    human: unreadLetters(project, map.work.id, HUMAN).map((message) => message.id),
  };
}

/** Карта без писем: то, что отдаёт `readMap` (письма — в своих таблицах). */
function withoutLetters(map: WindowWorkMap): WorkMap {
  const rest: Partial<WindowWorkMap> = { ...map };
  delete rest.messages;
  return rest as WorkMap;
}

/** Сколько писем в карте формы w-0051 (спека хранилища, раздел 2): 3 795 за неделю работы. */
const W0051_LETTERS = 3795;

/**
 * Карта формы w-0051 (спека хранилища 2, план 4, ревью 4): три тысячи писем с отметками прочтения у разных читателей,
 * удалённые письма, старая комната без журнала участия, ведущего, решения и режима, висячая ссылка записи журнала решений
 * на письмо, записанные экспорты и отправленные эффекты со старым текстом, отменённый эффект и прямые письма человеку.
 * Часть писем такого вида, какого `LetterTx.add` не пишет: время не в каноническом виде, `deleted: false`, незнакомый ключ.
 */
function w0051Map(): WorkMap & DecisionJournalMap & Pick<WindowWorkMap, 'messages'> {
  const map = fullMap() as WindowWorkMap & DecisionJournalMap;
  // Старый вид: тексты записанных экспортов и отправленных эффектов лежат в самой карте.
  map.planExports![0]!.status = 'written';
  map.decisionExports![0]!.status = 'written';
  // Запись журнала решений ссылается на письмо, которого в карте нет.
  map.decisionExports![0]!.messageId = 'm-9990';
  for (const row of map.planEffects!) {
    if (row.status !== 'sent') continue;
    row.text = map.messages.find((message) => message.id === row.messageId)!.text;
    delete row.textSha256;
  }
  const source = map.planEffects![0]!;
  map.planEffects!.push({
    ...source,
    key: `${source.roomId}/${source.planId}/${source.rev}/${source.item}/${source.kind}/legacy/${source.target}`,
    occurrence: 'legacy',
    status: 'cancelled',
    messageId: null,
    text: 'Cancelled before it was sent',
  });

  // Комната, созданная до журнала участия, ведущего, решения, режима и архива (миграция комнат дописывает их при чтении).
  addRoom(map, { title: 'Old room', creator: 's-02', members: ['s-01', 's-02', 's-03'] }, AT);
  const old = map.rooms.at(-1) as Partial<Room>;
  for (const key of ['memberLog', 'ownerId', 'lead', 'proposal', 'archivedAt', 'mode', 'recipe'] as const) delete old[key];

  const senders = ['s-01', 's-02', 's-03', HUMAN, 'system'];
  for (let n = map.messages.length + 1; n <= W0051_LETTERS; n += 1) {
    const from = senders[n % senders.length]!;
    const roomId = n % 5 === 0 ? null : ['r-01', 'r-02', 'r-03'][n % 3]!;
    const to = roomId === null ? [from === 's-01' ? HUMAN : n % 2 === 0 ? 's-02' : HUMAN] : n % 4 === 0 ? ['s-02'] : [];
    const readBy: Record<string, string> = {};
    if (n % 7 === 0) readBy['s-01'] = AT;
    if (n % 11 === 0) readBy[HUMAN] = AT;
    if (n % 13 === 0) Object.assign(readBy, { 's-02': AT, 's-03': AT });
    if (from === 'system') readBy[HUMAN] = AT;
    const message: Message & Record<string, unknown> = {
      id: `m-${String(n).padStart(2, '0')}`,
      roomId,
      from,
      to,
      at: n % 53 === 0 ? '2026-10-04T04:00:00+03:00' : new Date(Date.parse(AT) + n * 60_000).toISOString(),
      text: `письмо ${n}`,
      kind: n % 29 === 0 ? 'question' : 'note',
      readBy,
    };
    if (n % 97 === 0) message.deleted = true;
    if (n % 101 === 0) message.deleted = false;
    if (n % 61 === 0) message.pinned = { by: HUMAN, n };
    if (n % 37 === 0) message.replyTo = `m-${String(n - 1).padStart(2, '0')}`;
    map.messages.push(message);
  }
  return map;
}

/** Пид процесса, которого уже нет. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('migrateMapsToDb — переезд map.json в базу', () => {
  let home = '';
  let root = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-m2db-home-'));
    root = await mkdtemp(path.join(tmpdir(), 'parley-m2db-projects-'));
    project = path.join(root, 'shop');
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    closeWorkDb();
    delete process.env.PARLEY_HOME;
    await chmod(root, 0o700);
    await Promise.all([home, root].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const workDir = (workId: string, stateDirName = '.parley', projectPath = project): string =>
    path.join(projectPath, stateDirName, 'works', workId);
  const mapFile = (workId: string, stateDirName?: string, projectPath?: string): string =>
    path.join(workDir(workId, stateDirName, projectPath), 'map.json');
  const backupFile = (workId: string, stateDirName?: string): string =>
    path.join(workDir(workId, stateDirName), 'map.v2.json');
  const indexFile = (): string => path.join(home, 'works-index.json');
  const indexBackup = (): string => path.join(home, 'works-index.v2.json');

  /** Работа прежнего формата: `map.json` в каталоге работы и запись в `works-index.json` дома. Возвращает текст файла. */
  async function legacyWork(
    map: unknown,
    options: { text?: string; stateDirName?: string; indexed?: boolean; projectPath?: string } = {},
  ): Promise<string> {
    const { stateDirName = '.parley', indexed = true, projectPath = project } = options;
    const record = map as { work: { id: string; title: string; status: string; updatedAt: string } };
    const dir = workDir(record.work.id, stateDirName, projectPath);
    await mkdir(path.join(dir, 'artifacts'), { recursive: true });
    await mkdir(path.join(dir, 'briefs'), { recursive: true });
    const text = options.text ?? `${JSON.stringify(map, null, 2)}\n`;
    await writeFile(path.join(dir, 'map.json'), text);
    if (indexed) {
      let works: unknown[] = [];
      try {
        works = (JSON.parse(await readFile(indexFile(), 'utf8')) as { works: unknown[] }).works;
      } catch {
        // Индекса ещё нет.
      }
      works.push({
        id: record.work.id,
        projectPath,
        title: record.work.title,
        status: record.work.status,
        updatedAt: record.work.updatedAt,
      });
      await writeFile(indexFile(), `${JSON.stringify({ schemaVersion: 1, works }, null, 2)}\n`);
    }
    return text;
  }

  it('карта v2 со всеми коллекциями переезжает: map.v2.json рядом, readMap отдаёт ту же карту, непрочитанное то же', async () => {
    const text = await legacyWork(fullMap());
    const expected = parseMap(text, 'fixture');
    // Фикстура и вправду с непрочитанным: иначе сверка сравнивала бы пустое с пустым.
    const digest = unreadDigest(expected);
    expect(digest.bySession['s-01']!.length).toBeGreaterThan(0);
    expect(digest.human.length).toBeGreaterThan(0);

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [{ projectPath: project, workId: 'w-0001' }], failed: [], skipped: [] });
    expect(await exists(mapFile('w-0001'))).toBe(false);
    expect(await readFile(backupFile('w-0001'), 'utf8')).toBe(text);
    const after = readStoredMap(project, 'w-0001');
    expect(after).toEqual(expected);
    expect(unreadDigest(after)).toEqual(digest);
    expect(storedUnread(project, after)).toEqual(digest);
    expect(await readMap(project, 'w-0001')).toEqual(withoutLetters(expected));
  });

  it('карта с записанными экспортами и отправленными эффектами переезжает сжатой и проходит сверку', async () => {
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    const map: WorkMap & DecisionJournalMap = fullMap();
    // Старый вид: тексты записанных экспортов и отправленных эффектов лежат в самой карте.
    const planText = map.planExports![0]!.content!;
    const decisionText = map.decisionExports![0]!.content!;
    map.planExports![0]!.status = 'written';
    map.decisionExports![0]!.status = 'written';
    const letterTexts = map.planEffects!.filter((row) => row.status === 'sent').map((row) => map.messages.find((message) => message.id === row.messageId)!.text);
    for (const row of map.planEffects!) {
      if (row.status !== 'sent') continue;
      row.text = map.messages.find((message) => message.id === row.messageId)!.text;
      delete row.textSha256;
    }
    const source = map.planEffects![0]!;
    map.planEffects!.push({ ...source, key: `${source.roomId}/${source.planId}/${source.rev}/${source.item}/${source.kind}/legacy/${source.target}`, occurrence: 'legacy', status: 'cancelled', messageId: null, text: 'Cancelled before it was sent' });
    const text = await legacyWork(map);
    const expected = parseMap(text, 'fixture');
    const digest = unreadDigest(expected);
    expect(digest.bySession['s-01']!.length).toBeGreaterThan(0);

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [{ projectPath: project, workId: 'w-0001' }], failed: [], skipped: [] });
    const after = readStoredMap(project, 'w-0001') as WindowWorkMap & DecisionJournalMap;
    expect(after).toEqual(expected);
    expect(await readMap(project, 'w-0001')).toEqual(withoutLetters(expected));
    expect(unreadDigest(after)).toEqual(digest);
    expect(storedUnread(project, after)).toEqual(digest);
    expect(after.planExports![0]).not.toHaveProperty('content');
    expect(after.planExports![0]).toMatchObject({ status: 'written', sha256: sha(planText), bytes: Buffer.byteLength(planText) });
    expect(after.decisionExports![0]).not.toHaveProperty('content');
    expect(after.decisionExports![0]).toMatchObject({ status: 'written', sha256: sha(decisionText), bytes: Buffer.byteLength(decisionText) });
    const settled = after.planEffects!.filter((row) => row.status !== 'queued');
    expect(settled.length).toBeGreaterThan(1);
    for (const row of settled) expect(row).not.toHaveProperty('text');
    expect(settled.filter((row) => row.status === 'sent').map((row) => row.textSha256)).toEqual(letterTexts.map(sha));
    expect(settled.find((row) => row.status === 'cancelled')!.textSha256).toBe(sha('Cancelled before it was sent'));
  });

  it('карта формы w-0051 переезжает и проходит сверку: письма с отметками, удалённые, прямые человеку, старая комната, висячая ссылка', async () => {
    const map = w0051Map();
    const text = await legacyWork(map);
    const expected = parseMap(text, 'fixture');
    // Фикстура и вправду с тем, что должна проверить сверка: иначе пустое сравнивалось бы с пустым.
    const digest = unreadDigest(expected);
    expect(expected.messages).toHaveLength(W0051_LETTERS);
    expect(digest.bySession['s-01']!.length).toBeGreaterThan(300);
    expect(digest.bySession['s-02']!.length).toBeGreaterThan(300);
    expect(digest.human.length).toBeGreaterThan(300);
    expect(expected.messages.some((message) => message.roomId === null && message.to.includes(HUMAN))).toBe(true);
    expect(expected.rooms.at(-1)).toMatchObject({ id: 'r-03', ownerId: 's-02', lead: null, mode: 'free', archivedAt: null });
    expect(expected.rooms.at(-1)).not.toHaveProperty('memberLog');

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [{ projectPath: project, workId: 'w-0001' }], failed: [], skipped: [] });
    expect(await readFile(backupFile('w-0001'), 'utf8')).toBe(text);
    const after = readStoredMap(project, 'w-0001') as WindowWorkMap & DecisionJournalMap;
    expect(after).toEqual(expected);
    expect(unreadDigest(after)).toEqual(digest);
    expect(storedUnread(project, after)).toEqual(digest);
    expect(await readMap(project, 'w-0001')).toEqual(withoutLetters(expected));
    // Висячая ссылка и тексты экспортов: ссылка остаётся как была, текст заменён отпечатком.
    expect(after.decisionExports![0]).toMatchObject({ messageId: 'm-9990', status: 'written' });
    expect(after.decisionExports![0]).not.toHaveProperty('content');
    expect(after.planEffects!.some((row) => row.status === 'cancelled' && row.textSha256 !== undefined)).toBe(true);
  });

  it('письмо прежней карты возвращается как было: время приведено к ISO, deleted: false убран, незнакомый ключ и ответ на месте', async () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    addSession(map, { provider: 'claude', label: 'b', task: '' }, AT);
    const letter = (id: string, extra: Record<string, unknown> = {}): Message =>
      ({ id, roomId: null, from: 's-01', to: ['s-02'], at: AT, text: id, kind: 'note', readBy: {}, ...extra }) as Message;
    map.messages = [
      letter('m-01', { at: '2026-10-04T04:00:00+03:00' }),
      letter('m-02', { deleted: false }),
      letter('m-03', { deleted: true, readBy: { 's-02': AT } }),
      letter('m-04', { pinned: { by: HUMAN, tags: ['a', 'b'] }, replyTo: 'm-01', via: 'telegram' }),
    ];
    await legacyWork(map);

    const result = await migrateMapsToDb();

    expect(result.failed).toEqual([]);
    const [first, second, third, fourth] = readStoredMap(project, 'w-0001').messages;
    expect(first!.at).toBe('2026-10-04T01:00:00.000Z');
    expect(second).not.toHaveProperty('deleted');
    expect(third).toMatchObject({ deleted: true, readBy: { 's-02': AT } });
    expect(fourth).toMatchObject({ pinned: { by: HUMAN, tags: ['a', 'b'] }, replyTo: 'm-01', via: 'telegram' });
  });

  it('письмо, которое не собирается из таблицы в точности (-0 в незнакомом ключе), — failed, файлы и база не тронуты', async () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    addMessage(map, { from: 's-01', to: [HUMAN], text: 'письмо' }, AT);
    const text = `${JSON.stringify(map, null, 2).replace('"readBy": {}', '"readBy": {},\n"weight": -0')}\n`;
    expect(text).toContain('"weight": -0');
    await legacyWork(map, { text });

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([]);
    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('does not match') }]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(await readFile(mapFile('w-0001'), 'utf8')).toBe(text);
    expect(await exists(backupFile('w-0001'))).toBe(false);
    expect(await exists(indexFile())).toBe(true);
  });

  it.each([
    ['номер m-07 и m-7 — один номер', ['m-07', 'm-7'], 'letter ids are not unique: m-07 and m-7 share the number 7'],
    ['номер не m-N', ['m-01', 'letter-2'], 'letter id letter-2 is not m-N'],
    ['номер m-0', ['m-0'], 'letter id m-0 is not m-N'],
    ['номер с суффиксом', ['m-1x'], 'letter id m-1x is not m-N'],
  ])('письма с неподходящими номерами не переезжают, номера не переписываются: %s', async (_name, ids, reason) => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    map.messages = ids.map((id) => ({ id, roomId: null, from: 's-01', to: [HUMAN], at: AT, text: id, kind: 'note', readBy: {} }));
    const text = await legacyWork(map);

    const result = await migrateMapsToDb();

    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason }]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(await readFile(mapFile('w-0001'), 'utf8')).toBe(text);
  });

  it.each([
    ['readBy', { readBy: 'нет' }],
    ['roomId', { roomId: 5 }],
    ['at', { at: 'вчера' }],
  ])('письмо с неверным полем %s — failed с понятной причиной, а не сырой ошибкой вставки; файл на месте', async (field, patch) => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    map.messages = [{ id: 'm-05', roomId: null, from: 's-01', to: [HUMAN], at: AT, text: 't', kind: 'note', readBy: {}, ...patch }] as Message[];
    const text = await legacyWork(map);

    const result = await migrateMapsToDb();

    expect(result.failed).toEqual([
      { projectPath: project, workId: 'w-0001', reason: expect.stringContaining(`letter m-05 has an invalid ${field}`) },
    ]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(await readFile(mapFile('w-0001'), 'utf8')).toBe(text);
  });

  it('карта v1 переезжает уже в виде v2; в map.v2.json остаётся прежний текст', async () => {
    const text = await legacyWork(v1Map());

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
    const after = readStoredMap(project, 'w-0001');
    expect(after.schemaVersion).toBe(2);
    expect(after.rooms).toEqual([]);
    expect(after.sessions[0]).toMatchObject({ lifecycle: 'sleeping', result: 'done' });
    expect(after.messages.map((message) => [message.id, message.to, Object.keys(message.readBy)])).toEqual([
      ['m-01', ['s-02'], ['s-02']],
      ['m-02', ['s-02'], []],
    ]);
    expect(await readFile(backupFile('w-0001'), 'utf8')).toBe(text);
  });

  it('карта с повторяющимися номерами писем не переезжает: failed с причиной, файл на месте, строк нет', async () => {
    // Письма живут в таблице с уникальным номером (спека хранилища 6.2): такой карте нечем лечь, и она остаётся в файле.
    const map = emptyMap();
    const letter = (id: string, text: string) => ({ id, roomId: null, from: 's-01', to: ['s-02'], text, kind: 'note', at: AT, readBy: {} });
    map.messages = [letter('m-07', 'первое'), letter('m-08', 'другое'), letter('m-07', 'второе')] as WindowWorkMap['messages'];
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    addSession(map, { provider: 'claude', label: 'b', task: '' }, AT);
    await legacyWork(map);

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([]);
    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('letter ids are not unique') }]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(await exists(mapFile('w-0001'))).toBe(true);
    expect(await exists(backupFile('w-0001'))).toBe(false);
  });

  it('битая map.json: failed, файл не тронут, строки нет, следующий запуск пробует снова', async () => {
    await legacyWork(emptyMap(), { text: '{ broken' });

    const first = await migrateMapsToDb();

    expect(first.migrated).toEqual([]);
    expect(first.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('cannot be parsed') }]);
    expect(await readFile(mapFile('w-0001'), 'utf8')).toBe('{ broken');
    expect(await exists(backupFile('w-0001'))).toBe(false);
    expect(workExists(project, 'w-0001')).toBe(false);
    // Индекс остаётся: по нему следующий старт найдёт проект.
    expect(await exists(indexFile())).toBe(true);
    expect(await exists(indexBackup())).toBe(false);

    expect((await migrateMapsToDb()).failed).toHaveLength(1);

    await writeFile(mapFile('w-0001'), `${JSON.stringify(emptyMap())}\n`);
    expect((await migrateMapsToDb()).migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
  });

  it('карта, которую нормализация не принимает, — failed с причиной, строки нет', async () => {
    const bad = emptyMap();
    (bad as unknown as { rooms: unknown }).rooms = 'не список';
    await legacyWork(bad);

    const result = await migrateMapsToDb();

    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('unexpected shape') }]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(await exists(mapFile('w-0001'))).toBe(true);
  });

  it('карта, которая не собирается из строк в точности, — failed и откат: строк нет, файл на месте, версий не прибавилось', async () => {
    // `-0` в неизвестном поле: JSON-текст строки даст `0`, и сверка с разобранной картой это видит.
    const map = emptyMap();
    await legacyWork(map, { text: `${JSON.stringify(map).replace(/}$/, ',"futureField":-0}')}\n` });

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([]);
    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('does not match') }]);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect((await readWorksIndex()).works).toEqual([]);
    expect(await exists(mapFile('w-0001'))).toBe(true);
    expect(await exists(backupFile('w-0001'))).toBe(false);
  });

  it('карта, чей id не совпадает с каталогом работы, — failed: обновить такую строку нечем', async () => {
    const mismatched = emptyMap('w-0009');
    const dir = workDir('w-0001');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'map.json'), JSON.stringify(mismatched));
    await writeFile(
      indexFile(),
      JSON.stringify({ schemaVersion: 1, works: [{ id: 'w-0001', projectPath: project, title: 'x', status: 'active', updatedAt: AT }] }),
    );

    const result = await migrateMapsToDb();

    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('w-0009') }]);
    expect(workExists(project, 'w-0001')).toBe(false);
  });

  it('занятая работа (map.lock с живым держателем): skipped busy, файлы не тронуты; снят замок — переезжает', async () => {
    await legacyWork(emptyMap());
    const lock = path.join(workDir('w-0001'), 'map.lock');
    await writeFile(lock, `${process.pid}\n`);

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [], failed: [], skipped: [{ projectPath: project, workId: 'w-0001', reason: 'busy' }] });
    expect(await exists(mapFile('w-0001'))).toBe(true);
    expect(workExists(project, 'w-0001')).toBe(false);
    expect(await exists(indexFile())).toBe(true);
    expect(await exists(indexBackup())).toBe(false);

    await rm(lock);
    expect((await migrateMapsToDb()).migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
  });

  it('замок упавшего процесса (pid мёртв) работу не держит', async () => {
    await legacyWork(emptyMap());
    await writeFile(path.join(workDir('w-0001'), 'map.lock'), `${deadPid()}\n`);

    const result = await migrateMapsToDb();

    expect(result.skipped).toEqual([]);
    expect(result.migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
  });

  it('занятая работа соседей не держит: остальные переезжают, индекс остаётся до следующего старта', async () => {
    await legacyWork(emptyMap('w-0001', 'Занята'));
    await legacyWork(emptyMap('w-0002', 'Свободна'));
    await writeFile(path.join(workDir('w-0001'), 'map.lock'), `${process.pid}\n`);

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([{ projectPath: project, workId: 'w-0002' }]);
    expect(result.skipped).toEqual([{ projectPath: project, workId: 'w-0001', reason: 'busy' }]);
    expect(await exists(indexFile())).toBe(true);
  });

  it('прерванный переезд (строка есть, map.json лежит и равен строке): только переименование, строка не перезаписана и версия прежняя', async () => {
    const original = await legacyWork(emptyMap());
    await migrateMapsToDb();
    const version = workVersion(project, 'w-0001');
    const stored = await readMap(project, 'w-0001');
    // Хост упал после коммита: файл остался на месте.
    await writeFile(mapFile('w-0001'), original);

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [{ projectPath: project, workId: 'w-0001' }], failed: [], skipped: [] });
    expect(await exists(mapFile('w-0001'))).toBe(false);
    expect(await exists(backupFile('w-0001'))).toBe(true);
    expect(workVersion(project, 'w-0001')).toBe(version);
    expect(await readMap(project, 'w-0001')).toEqual(stored);
  });

  it('вернулся map.json с письмом, которого нет в строках (откат сборки и запись в файл): failed с причиной, оба файла и строка не тронуты, map.v2.json не затёрт', async () => {
    await legacyWork(emptyMap());
    await migrateMapsToDb();
    const version = workVersion(project, 'w-0001');
    const stored = await readMap(project, 'w-0001');
    // Откат по рецепту: `map.v2.json` вернули в `map.json`, прежняя сборка дописала письмо. Прежний `map.v2.json` с первого переезда лежит рядом.
    const newer = emptyMap();
    addSession(newer, { provider: 'codex', label: 'Lead', task: 'Fixture' }, AT);
    addSession(newer, { provider: 'codex', label: 'Owner', task: 'Fixture' }, AT);
    addMessage(newer, { from: 's-01', to: ['s-02'], text: 'письмо из откатной сборки' }, AT);
    const newerText = `${JSON.stringify(newer, null, 2)}\n`;
    await writeFile(mapFile('w-0001'), newerText);
    const backupBefore = await readFile(backupFile('w-0001'), 'utf8');

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([]);
    expect(result.failed).toEqual([
      {
        projectPath: project,
        workId: 'w-0001',
        reason: 'map.json differs from the stored copy (newer edits after a downgrade?)',
      },
    ]);
    expect(await readFile(mapFile('w-0001'), 'utf8')).toBe(newerText);
    expect(await readFile(backupFile('w-0001'), 'utf8')).toBe(backupBefore);
    expect(backupBefore).toContain('Старая работа');
    expect(workVersion(project, 'w-0001')).toBe(version);
    expect(await readMap(project, 'w-0001')).toEqual(stored);
  });

  it('прерванный переезд, а строка не собирается в карту: failed, файл не переименован', async () => {
    await legacyWork(emptyMap());
    await migrateMapsToDb();
    // Комната с владельцем, которого нет среди сессий: `normalizeMap` такую карту не принимает.
    replaceStoredMap(project, 'w-0001', { ...emptyMap(), rooms: [{ id: 'r-01', ownerId: 'ghost' }] });
    await writeFile(mapFile('w-0001'), `${JSON.stringify(emptyMap())}\n`);

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([]);
    expect(result.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('invalid room owner') }]);
    expect(await exists(mapFile('w-0001'))).toBe(true);
  });

  it('после переезда всех работ индекс переименован в works-index.v2.json', async () => {
    await legacyWork(emptyMap('w-0001', 'Первая'));
    await legacyWork(emptyMap('w-0002', 'Вторая'));
    const indexText = await readFile(indexFile(), 'utf8');

    const result = await migrateMapsToDb();

    expect(result.migrated).toHaveLength(2);
    expect(await exists(indexFile())).toBe(false);
    expect(await readFile(indexBackup(), 'utf8')).toBe(indexText);
    // Второй запуск: переносить нечего, и ничего не ломается.
    expect(await migrateMapsToDb()).toEqual({ migrated: [], failed: [], skipped: [] });
  });

  it('порядок работ в списке — порядок прежнего индекса, а не номеров', async () => {
    await legacyWork(emptyMap('w-0002', 'Вторая по номеру, первая в индексе'));
    await legacyWork(emptyMap('w-0001', 'Первая по номеру, вторая в индексе'));

    await migrateMapsToDb();

    expect((await readWorksIndex()).works.map((work) => work.id)).toEqual(['w-0002', 'w-0001']);
  });

  it('проект из индекса недоступен (том не смонтирован): индекс остаётся и в журнале сказано почему; проект вернулся — карта переезжает, индекс переименован', async () => {
    const gone = path.join(root, 'gone');
    await legacyWork(emptyMap('w-0001', 'Доступна'));
    await writeFile(
      indexFile(),
      JSON.stringify({
        schemaVersion: 1,
        works: [
          { id: 'w-0001', projectPath: project, title: 'Доступна', status: 'active', updatedAt: AT },
          { id: 'w-0005', projectPath: gone, title: 'На томе, который не смонтирован', status: 'active', updatedAt: AT },
        ],
      }),
    );
    const lines: string[] = [];

    const first = await migrateMapsToDb({ log: (line) => lines.push(line) });

    expect(first).toEqual({ migrated: [{ projectPath: project, workId: 'w-0001' }], failed: [], skipped: [] });
    expect(await exists(indexFile())).toBe(true);
    expect(await exists(indexBackup())).toBe(false);
    expect(lines.some((line) => line.includes(gone) && line.includes('w-0005'))).toBe(true);

    // Том вернулся: карта лежит там, где лежала.
    await legacyWork(emptyMap('w-0005', 'На томе'), { indexed: false, projectPath: gone });
    const second = await migrateMapsToDb();

    expect(second.migrated).toEqual([{ projectPath: gone, workId: 'w-0005' }]);
    expect(await exists(indexFile())).toBe(false);
    expect(await exists(indexBackup())).toBe(true);
  });

  it('запись индекса, чей каталог работы цел, но карты в нём нет (переехала раньше), и запись, у которой в базе есть строка, индекс не держат', async () => {
    // Строка есть (w-0001), а файлов уже нет совсем.
    await createWork(project, { title: 'Только в базе' });
    await rm(workDir('w-0001'), { recursive: true });
    await legacyWork(emptyMap('w-0002', 'Переедет'));
    // Каталог без карты: так остаётся работа, чей `map.json` уже стал `map.v2.json`.
    await legacyWork(emptyMap('w-0003', 'Переехала раньше'));
    await rename(mapFile('w-0003'), backupFile('w-0003'));
    const index = JSON.parse(await readFile(indexFile(), 'utf8')) as { works: unknown[] };
    index.works.unshift({ id: 'w-0001', projectPath: project, title: 'Только в базе', status: 'active', updatedAt: AT });
    await writeFile(indexFile(), JSON.stringify(index));

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [{ projectPath: project, workId: 'w-0002' }], failed: [], skipped: [] });
    expect(await exists(indexBackup())).toBe(true);
  });

  it.skipIf(asRoot)('проект не читается (EACCES): остальные проекты переезжают, исключения нет, индекс остаётся, в журнале назван проект', async () => {
    // Проект, известный по строкам базы: его каталог работ не открыть.
    const locked = path.join(root, 'locked');
    await createWork(locked, { title: 'Закрыт' });
    await chmod(path.join(locked, '.parley', 'works'), 0o000);
    await legacyWork(emptyMap('w-0007', 'Читается'), { indexed: true });
    const lines: string[] = [];

    let first: Awaited<ReturnType<typeof migrateMapsToDb>>;
    try {
      first = await migrateMapsToDb({ log: (line) => lines.push(line) });
    } finally {
      await chmod(path.join(locked, '.parley', 'works'), 0o700);
    }
    expect(first).toEqual({ migrated: [{ projectPath: project, workId: 'w-0007' }], failed: [], skipped: [] });
    expect(lines.some((line) => line.includes(locked) && line.includes('EACCES'))).toBe(true);
    expect(await exists(indexFile())).toBe(true);
    expect(await exists(indexBackup())).toBe(false);

    // Доступ вернулся: переносить нечего, индекс больше ничего не держит.
    expect(await migrateMapsToDb()).toEqual({ migrated: [], failed: [], skipped: [] });
    expect(await exists(indexBackup())).toBe(true);
  });

  it('карта без записи в индексе (рядом с работой того же проекта) тоже переезжает, после работ индекса', async () => {
    await legacyWork(emptyMap('w-0001', 'В индексе'));
    await legacyWork(emptyMap('w-0002', 'Без записи'), { indexed: false });

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([
      { projectPath: project, workId: 'w-0001' },
      { projectPath: project, workId: 'w-0002' },
    ]);
    expect((await readMap(project, 'w-0002')).work.title).toBe('Без записи');
  });

  it('проект, известный только по строкам базы: его оставшиеся map.json тоже находятся', async () => {
    await createWork(project, { title: 'Уже в базе' });
    await legacyWork(emptyMap('w-0007', 'Лежит файлом'), { indexed: false });

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([{ projectPath: project, workId: 'w-0007' }]);
  });

  it('проект ещё на .harnas (не переехал): карта переезжает из него, map.v2.json остаётся там же', async () => {
    await legacyWork(emptyMap(), { stateDirName: '.harnas' });

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
    expect(await exists(backupFile('w-0001', '.harnas'))).toBe(true);
    expect(await exists(mapFile('w-0001', '.harnas'))).toBe(false);
  });

  it('индекса нет и проектов в базе нет — переносить нечего', async () => {
    expect(await migrateMapsToDb()).toEqual({ migrated: [], failed: [], skipped: [] });
    expect(await exists(indexBackup())).toBe(false);
  });

  it('прежний индекс не разобрался — исключение: проекты не назвать', async () => {
    await writeFile(indexFile(), '{ broken');

    await expect(migrateMapsToDb()).rejects.toThrow('cannot be parsed');
  });

  it('log получает строку на каждый исход: переехало, отложено, не вышло', async () => {
    await legacyWork(emptyMap('w-0001', 'Переедет'));
    await legacyWork(emptyMap('w-0002', 'Занята'));
    await legacyWork(emptyMap('w-0003', 'Битая'), { text: '{ broken' });
    await writeFile(path.join(workDir('w-0002'), 'map.lock'), `${process.pid}\n`);
    const lines: string[] = [];

    await migrateMapsToDb({ log: (line) => lines.push(line) });

    expect(lines.filter((line) => line.includes('w-0001') && line.includes('moved'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('w-0002') && line.includes('busy'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('w-0003') && line.includes('cannot be parsed'))).toHaveLength(1);
  });

  it('перед переездом в log одна строка «переезд карт в базу: N работ» — только карты, что ещё лежат файлами; нечего переносить — строки нет', async () => {
    await legacyWork(emptyMap('w-0001', 'Первая'));
    await legacyWork(emptyMap('w-0002', 'Вторая'));
    const lines: string[] = [];

    await migrateMapsToDb({ log: (line) => lines.push(line) });

    expect(lines[0]).toBe('переезд карт в базу: 2 работ');
    expect(lines.filter((line) => line.startsWith('переезд карт в базу'))).toHaveLength(1);

    // Всё переехало: каталоги работ остались, а файлов карт уже нет.
    const again: string[] = [];
    await migrateMapsToDb({ log: (line) => again.push(line) });
    expect(again.filter((line) => line.startsWith('переезд карт в базу'))).toEqual([]);
  });

  it.skipIf(asRoot)('после коммита rename не вышел: failed с кодом, строка остаётся, следующий запуск только переименует', async () => {
    await legacyWork(emptyMap());
    await chmod(workDir('w-0001'), 0o500);

    const first = await migrateMapsToDb();

    await chmod(workDir('w-0001'), 0o700);
    expect(first.migrated).toEqual([]);
    expect(first.failed).toEqual([{ projectPath: project, workId: 'w-0001', reason: expect.stringContaining('EACCES') }]);
    expect(workExists(project, 'w-0001')).toBe(true);
    expect(await exists(mapFile('w-0001'))).toBe(true);
    expect(await exists(indexBackup())).toBe(false);

    const second = await migrateMapsToDb();

    expect(second.migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
    expect(await exists(mapFile('w-0001'))).toBe(false);
  });
});

describe('verifyLetterMap — непрочитанное из базы против прежних правил', () => {
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-verify-home-'));
    project = path.join(home, 'shop');
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    closeWorkDb();
    delete process.env.PARLEY_HOME;
    await rm(home, { recursive: true, force: true });
  });

  /** Работа в базе с письмами полной карты; возвращает карту, как её отдаёт база, и непрочитанное по прежним правилам. */
  async function seeded(): Promise<{ stored: WindowWorkMap; before: ReturnType<typeof legacyUnread> }> {
    await createWork(project, { title: 'Старая работа' });
    replaceStoredMap(project, 'w-0001', fullMap());
    const stored = readStoredMap(project, 'w-0001');
    return { stored, before: legacyUnread(stored) };
  }

  it('сходится, когда кандидаты на месте', async () => {
    const { stored, before } = await seeded();
    expect(before.bySession['s-01']!.length).toBeGreaterThan(0);
    expect(before.human.length).toBeGreaterThan(0);

    expect(() => verifyLetterMap(storeDb(), project, 'w-0001', stored, before, 'fixture')).not.toThrow();
  });

  it('потерянный кандидат сессии — отказ с именем читателя, хотя карты равны', async () => {
    const { stored, before } = await seeded();
    storeDb().prepare(`DELETE FROM message_unread WHERE reader = 's-01'`).run();

    expect(() => verifyLetterMap(storeDb(), project, 'w-0001', stored, before, 'fixture')).toThrow(
      'unread letters of s-01 read back from the database differ from fixture',
    );
  });

  it('потерянный кандидат человека — отказ', async () => {
    const { stored, before } = await seeded();
    storeDb().prepare(`DELETE FROM message_unread WHERE reader = 'human'`).run();

    expect(() => verifyLetterMap(storeDb(), project, 'w-0001', stored, before, 'fixture')).toThrow(
      'unread letters of the human read back from the database differ from fixture',
    );
  });

  it('другая карта — отказ с переданным текстом', async () => {
    const { stored, before } = await seeded();
    const other = structuredClone(stored);
    other.messages[0]!.text = 'другой текст';

    expect(() => verifyLetterMap(storeDb(), project, 'w-0001', other, before, 'fixture', 'maps differ')).toThrow('maps differ');
  });
});

describe('апгрейд базы со схемы 1 — письма из entries в таблицы', () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-v1up-home-'));
    project = path.join(home, 'shop');
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    closeWorkDb();
    delete process.env.PARLEY_HOME;
    await rm(home, { recursive: true, force: true });
  });

  /** Схема сборки плана 3 (user_version 1), как она лежала на диске: письма — строки `entries` вида `message`. */
  const SCHEMA_V1 = `
    CREATE TABLE works (
      project_path TEXT NOT NULL, id TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      work_json TEXT NOT NULL, extra_json TEXT NOT NULL,
      PRIMARY KEY (project_path, id));
    CREATE TABLE entries (
      project_path TEXT NOT NULL, work_id TEXT NOT NULL,
      kind TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (project_path, work_id, kind, key),
      FOREIGN KEY (project_path, work_id) REFERENCES works(project_path, id) ON DELETE CASCADE);
    CREATE INDEX entries_order ON entries(project_path, work_id, kind, ord);`;

  const dbFile = (): string => path.join(home, WORK_DB_FILE);

  /** Пишет базу схемы 1 из карт: строки списков — как их раскладывал план 3, письма — по строке `message` с полным письмом. */
  function writeV1Database(maps: WindowWorkMap[], mutate: (db: InstanceType<typeof DatabaseSync>) => void = () => undefined): void {
    const db = new DatabaseSync(dbFile());
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_V1);
    for (const map of maps) {
      const rows = mapToRows(map);
      db.prepare('INSERT INTO works (project_path, id, title, status, updated_at, version, work_json, extra_json) VALUES (?, ?, ?, ?, ?, 7, ?, ?)').run(
        project, map.work.id, map.work.title, map.work.status, map.work.updatedAt, rows.work, rows.extra,
      );
      const insert = db.prepare('INSERT INTO entries (project_path, work_id, kind, key, ord, json) VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of rows.rows) insert.run(project, map.work.id, row.kind, row.key, row.ord, row.json);
      map.messages.forEach((message, ord) => insert.run(project, map.work.id, 'message', message.id, ord, JSON.stringify(message)));
    }
    mutate(db);
    db.exec('PRAGMA user_version = 1');
    db.close();
  }

  /** Всё, что лежит в базе файла: версия схемы, таблицы и строки `works` и `entries` — чтобы видеть, что откат ничего не тронул. */
  function dump(): { version: number; tables: string[]; works: unknown[]; entries: unknown[] } {
    const db = new DatabaseSync(dbFile());
    const state = {
      version: Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
      tables: db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all().map((row) => String(row['name'])),
      works: db.prepare('SELECT * FROM works ORDER BY project_path, id').all(),
      entries: db.prepare('SELECT * FROM entries ORDER BY project_path, work_id, kind, key').all(),
    };
    db.close();
    return state;
  }

  it('база v1 с письмами формы w-0051 поднимается до v2: собранная карта равна прежней, непрочитанное то же, строк message нет', async () => {
    const raw = w0051Map();
    const expected = parseMap(JSON.stringify(raw), 'fixture');
    const digest = unreadDigest(expected);
    expect(expected.messages).toHaveLength(W0051_LETTERS);
    expect(digest.human.length).toBeGreaterThan(300);
    writeV1Database([raw]);

    const after = readStoredMap(project, 'w-0001') as WindowWorkMap & DecisionJournalMap;

    expect(after).toEqual(expected);
    expect(unreadDigest(after)).toEqual(digest);
    expect(storedUnread(project, after)).toEqual(digest);
    expect(await readMap(project, 'w-0001')).toEqual(withoutLetters(expected));
    expect(workVersion(project, 'w-0001')).toBe(7);
    const state = dump();
    expect(state.version).toBe(2);
    expect(state.tables).toEqual(expect.arrayContaining(['messages', 'message_reads', 'message_unread']));
    expect((state.entries as Array<{ kind: string }>).filter((row) => row.kind === 'message')).toEqual([]);
    // Тексты записанных экспортов и отправленных эффектов, что плана 3 лежали в строках, теперь только отпечатки.
    expect(after.planExports![0]).not.toHaveProperty('content');
    expect(after.planExports![0]).toMatchObject({ status: 'written' });
    expect((state.entries as Array<{ json: string }>).some((row) => row.json.includes('"content"'))).toBe(false);
    expect(after.messages.find((message) => message.id === 'm-61')).toMatchObject({ pinned: { by: HUMAN, n: 61 } });
  });

  it('несколько работ и проектов поднимаются все; работа без писем и пустая база тоже', async () => {
    const second = emptyMap('w-0002', 'Без писем');
    writeV1Database([fullMap(), second]);

    expect(readStoredMap(project, 'w-0002')).toEqual(parseMap(JSON.stringify(second), 'fixture'));
    expect(readStoredMap(project, 'w-0001').messages.length).toBeGreaterThan(3);
    expect(dump().version).toBe(2);

    closeWorkDb();
    await rm(dbFile());
    await rm(`${dbFile()}-wal`, { force: true });
    await rm(`${dbFile()}-shm`, { force: true });
    writeV1Database([]);
    expect(storeDb().prepare('SELECT COUNT(*) AS n FROM works').get()).toEqual({ n: 0 });
    expect(dump().version).toBe(2);
  });

  it('письма с одним номером в строках: апгрейд откатывается целиком, база остаётся v1, ошибка называет работу; починили — поднимается', () => {
    const good = fullMap();
    const bad = emptyMap('w-0002', 'С дублем');
    addSession(bad, { provider: 'claude', label: 'a', task: '' }, AT);
    addMessage(bad, { from: 's-01', to: [HUMAN], text: 'первое' }, AT);
    addMessage(bad, { from: 's-01', to: [HUMAN], text: 'второе' }, AT);
    // Дубль номера в строках `entries`: ключи разные (повтор получает суффикс), номер один.
    writeV1Database([good, bad], (db) => {
      db.prepare(`UPDATE entries SET json = replace(json, '"m-02"', '"m-01"') WHERE work_id = 'w-0002' AND kind = 'message' AND key = 'm-02'`).run();
    });
    const before = dump();

    expect(() => storeDb()).toThrow(/workspace w-0002 .*letter ids are not unique: m-01 appears more than once.*stays at schema 1/s);
    expect(() => storeDb()).toThrow(/could not be upgraded from schema 1 to schema 2/);

    // Ни версии, ни письменных таблиц, ни строк: работа w-0001, обработанная раньше, тоже как была.
    expect(dump()).toEqual(before);
    expect(before.version).toBe(1);
    expect(before.tables).not.toContain('messages');

    closeWorkDb();
    const fix = new DatabaseSync(dbFile());
    fix.prepare(`UPDATE entries SET json = replace(json, '"m-01"', '"m-02"') WHERE work_id = 'w-0002' AND kind = 'message' AND key = 'm-02'`).run();
    fix.close();
    expect(readStoredMap(project, 'w-0002').messages.map((message) => message.id)).toEqual(['m-01', 'm-02']);
    expect(dump().version).toBe(2);
  });

  it('письмо с неверным полем в строке (readBy не объект): откат, v1, причина называет письмо', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    addMessage(map, { from: 's-01', to: [HUMAN], text: 'письмо' }, AT);
    map.messages[0]!.readBy = 'нет' as unknown as Record<string, string>;
    writeV1Database([map]);
    const before = dump();

    expect(() => storeDb()).toThrow(/workspace w-0001 .*letter m-01 has an invalid readBy/s);
    expect(dump()).toEqual(before);
  });

  it('письма не по порядку номеров (карта и таблица разошлись бы): сверка не сошлась — откат, v1', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    addMessage(map, { from: 's-01', to: [HUMAN], text: 'первое' }, AT);
    addMessage(map, { from: 's-01', to: [HUMAN], text: 'второе' }, AT);
    map.messages.reverse();
    writeV1Database([map]);
    const before = dump();

    expect(() => storeDb()).toThrow(/workspace w-0001 .*does not match the schema 1 rows/s);
    expect(dump()).toEqual(before);
  });

  it('база v2 повторно не апгрейдится: версия и данные те же', async () => {
    writeV1Database([fullMap()]);
    const first = readStoredMap(project, 'w-0001');
    closeWorkDb();
    const state = dump();

    expect(readStoredMap(project, 'w-0001')).toEqual(first);
    expect(dump()).toEqual(state);
  });
});
