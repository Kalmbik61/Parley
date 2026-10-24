/**
 * Переезд прежних `map.json` в базу на старте хоста (спека хранилища 6.6): вставка строк одной транзакцией, сверка с
 * разобранной картой до `COMMIT`, затем `map.json` → `map.v2.json`. Только временные дома и проекты.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeWorkDb } from './db.js';
import { unreadFor, unreadForHuman } from './letters.js';
import { addMessage, addSession, parseMap } from './map.js';
import { migrateMapsToDb } from './migrate-to-db.js';
import { reservePlanEffects } from './plan-effects.js';
import { resolveProposal, setProposal } from './proposals.js';
import { addRoom } from './rooms.js';
import { createWork, readMap, readStoredMap, readWorksIndex, replaceStoredMap, workExists, workVersion } from './store.js';
import { HUMAN, type PlanDraft, type WorkMap } from './types.js';

const AT = '2026-10-04T01:00:00.000Z';
const asRoot = process.getuid?.() === 0;

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

const emptyMap = (id = 'w-0001', title = 'Старая работа'): WorkMap => ({
  schemaVersion: 2,
  work: { id, title, goal: '', status: 'active', createdAt: AT, updatedAt: AT },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Карта со всеми коллекциями (как в `map-rows.test.ts`) и письмами с разной отметкой прочтения: людям и сессиям. */
function fullMap(): WorkMap {
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
    'r-01',
    proposed.proposalId,
    'accept',
    { rev: proposed.rev, planId: map.rooms[0]!.proposal!.plan!.id, planRev: 0 },
    AT,
  );
  reservePlanEffects(map, 20, AT);
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
function unreadDigest(map: WorkMap): { bySession: Record<string, string[]>; human: string[] } {
  return {
    bySession: Object.fromEntries(map.sessions.map((session) => [session.id, unreadFor(map, session.id).map((message) => message.id)])),
    human: map.messages.filter(unreadForHuman).map((message) => message.id),
  };
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
    const after = await readMap(project, 'w-0001');
    expect(after).toEqual(expected);
    expect(unreadDigest(after)).toEqual(digest);
    expect(readStoredMap(project, 'w-0001')).toEqual(expected);
  });

  it('карта v1 переезжает уже в виде v2; в map.v2.json остаётся прежний текст', async () => {
    const text = await legacyWork(v1Map());

    const result = await migrateMapsToDb();

    expect(result.migrated).toEqual([{ projectPath: project, workId: 'w-0001' }]);
    const after = await readMap(project, 'w-0001');
    expect(after.schemaVersion).toBe(2);
    expect(after.rooms).toEqual([]);
    expect(after.sessions[0]).toMatchObject({ lifecycle: 'sleeping', result: 'done' });
    expect(after.messages.map((message) => [message.id, message.to, Object.keys(message.readBy)])).toEqual([
      ['m-01', ['s-02'], ['s-02']],
      ['m-02', ['s-02'], []],
    ]);
    expect(await readFile(backupFile('w-0001'), 'utf8')).toBe(text);
  });

  it('карта с повторяющимися id писем сохраняет оба письма и порядок', async () => {
    const map = emptyMap();
    const letter = (id: string, text: string) => ({ id, roomId: null, from: 's-01', to: ['s-02'], text, kind: 'note', at: AT, readBy: {} });
    map.messages = [letter('m-07', 'первое'), letter('m-08', 'другое'), letter('m-07', 'второе')] as WorkMap['messages'];
    addSession(map, { provider: 'claude', label: 'a', task: '' }, AT);
    addSession(map, { provider: 'claude', label: 'b', task: '' }, AT);
    await legacyWork(map);

    const result = await migrateMapsToDb();

    expect(result.failed).toEqual([]);
    expect((await readMap(project, 'w-0001')).messages.map((message) => message.text)).toEqual(['первое', 'другое', 'второе']);
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

  it('прерванный переезд (строка есть, map.json лежит): только переименование, строка не перезаписана и версия прежняя', async () => {
    const original = await legacyWork(emptyMap());
    await migrateMapsToDb();
    const version = workVersion(project, 'w-0001');
    // Хост упал после коммита: файл остался на месте. Текст другой — чтобы вторая вставка была видна.
    await writeFile(mapFile('w-0001'), `${JSON.stringify(emptyMap('w-0001', 'Другое название'))}\n`);

    const result = await migrateMapsToDb();

    expect(result).toEqual({ migrated: [{ projectPath: project, workId: 'w-0001' }], failed: [], skipped: [] });
    expect(await exists(mapFile('w-0001'))).toBe(false);
    expect(await exists(backupFile('w-0001'))).toBe(true);
    expect(workVersion(project, 'w-0001')).toBe(version);
    expect((await readMap(project, 'w-0001')).work.title).toBe('Старая работа');
    expect(original).toContain('Старая работа');
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
