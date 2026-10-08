import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addBacklogItem } from './backlog.js';
import { searchHistory } from './history-search.js';
import { addMessage, addSession, setResult } from './map.js';
import { addProjectMemory } from './project-memory.js';
import { rebuildRoomHistory, shareRoomHistory } from './room-history.js';
import { addRoom } from './rooms.js';
import { createWork, updateMap } from './store.js';
import { HUMAN } from './types.js';

let root = ''; let project = ''; let workId = ''; let previous: string | undefined; let previousHome: string | undefined;
const state = (...parts: string[]) => path.join(project, '.parley', ...parts);
const seed = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const lineOf = async (file: string, needle: string) => (await readFile(file, 'utf8')).split('\n').findIndex(row => row.includes(needle)) + 1;

const DECISION = (title: string, date: string, body = 'We decided.') => `# ${title}\n\nAccepted: ${date}\nWork: w-0001 — "Work"\nRoom: r-01 — "Room"\nDecision: p-01; revision: 1\n\n## Decision\n${body}\n`;
const PLAN = `# Plan pl-01 — revision 1 (accepted)\n\nWork: w-0001; room: r-01\nMode: checklist; status: active\nAccepted: 2026-10-04T09:00:00.000Z; completed: —; cancelled: —\n\n## Goal\nShip the importer\n\n## Items\n\n### 1. Write the parser\nOwner: s-01; label: "Lead"; role: —\nStatus: waiting; after: —; verifier: —\n\nScope:\nTokenize quoted fields\n\n### 2. Benchmark throughput\nOwner: s-01; label: "Lead"; role: —\nStatus: waiting; after: 1; verifier: —\n\nScope:\nMeasure with the large fixture\n`;

beforeEach(async () => {
  root = await realpath(await mkdtemp('/private/tmp/parley-history-search-'));
  project = path.join(root, 'project'); await mkdir(project); await mkdir(path.join(root, 'home'));
  previous = process.env.PARLEY_HOME; process.env.PARLEY_HOME = path.join(root, 'home');
  previousHome = process.env.HOME;
  workId = (await createWork(project, { title: 'Work' })).work.id;
  await updateMap(project, workId, map => {
    addSession(map, { provider: 'codex', label: 'Lead', task: 'Bounded' });
    addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01'], lead: 's-01' });
    addMessage(map, { from: 's-01', to: [], roomId: 'r-01', kind: 'question', text: 'Should the cache be sharded?' });
    addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', kind: 'note', text: 'Sharding is fine for now' });
    map.sessions[0]!.summary = 'Migrated the cache layer\nAll tests pass; benchmark attached.';
    setResult(map, 's-01', 'done', '2026-10-05T12:00:00.000Z');
  });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = previous;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe('search_history: поиск по записям проекта', () => {
  it('находит решение, урок памяти, пункт плана, пункт бэклога и итог сессии с файлом, строкой и id', async () => {
    const decision = state('decisions', `2026-10-05-${workId}-r-01-p-01-rev-01.md`);
    await seed(decision, DECISION('Use PostgreSQL for the queue', '2026-10-05T10:00:00.000Z', 'Postgres beats Redis here.'));
    const lesson = await addProjectMemory(project, { kind: 'lesson', fact: 'PTY tests flake in worktrees with long paths', details: 'Compare with a baseline run' });
    await seed(state('plans', `${workId}-r-01-pl-01-rev-1-accepted.md`), PLAN);
    await addBacklogItem(project, { title: 'Document the importer retry policy', details: 'Mention backoff' });

    const found = await searchHistory(project, { query: 'postgres' });
    expect(found.hits).toMatchObject([{ source: 'decisions', title: 'Use PostgreSQL for the queue', file: decision, id: 'p-01', roomId: 'r-01', workId, date: '2026-10-05T10:00:00.000Z' }]);
    expect(found.hits[0]!.line).toBe(1);
    expect((await searchHistory(project, { query: 'beats redis' })).hits[0]!.line).toBe(await lineOf(decision, 'Postgres beats'));

    const memory = await searchHistory(project, { query: 'FLAKE long', scope: 'memory' });
    expect(memory.hits).toMatchObject([{ source: 'memory', id: lesson.id, state: 'current', date: null, complete: true }]);
    expect(memory.hits[0]!.line).toBe(await lineOf(state('memory.md'), 'PTY tests'));
    expect((await searchHistory(project, { query: 'baseline', scope: 'memory' })).hits[0]!.line).toBe(await lineOf(state('memory.md'), 'baseline'));

    const plan = await searchHistory(project, { query: 'throughput fixture' });
    expect(plan.hits).toMatchObject([{ source: 'plans', title: '2. Benchmark throughput', id: 'pl-01#2', workId, roomId: 'r-01', date: '2026-10-04T09:00:00.000Z' }]);
    expect(plan.hits[0]!.line).toBe(await lineOf(state('plans', `${workId}-r-01-pl-01-rev-1-accepted.md`), 'Benchmark throughput'));

    const backlog = await searchHistory(project, { query: 'retry backoff' });
    expect(backlog.hits).toMatchObject([{ source: 'backlog', id: 'b-001', state: 'open' }]);

    const session = await searchHistory(project, { query: 'cache benchmark' });
    expect(session.hits).toMatchObject([{ source: 'sessions', title: 'Migrated the cache layer', workId, sessionId: 's-01', date: '2026-10-05T12:00:00.000Z' }]);
    expect(session.hits[0]!.file).toBeUndefined();
  });

  it('требует все слова в одной записи, не различает регистр и учитывает scope', async () => {
    await seed(state('decisions', `2026-10-05-${workId}-r-01-p-01-rev-01.md`), DECISION('Alpha plan', '2026-10-05T10:00:00.000Z', 'Only alpha here.'));
    await seed(state('decisions', `2026-10-05-${workId}-r-01-p-02-rev-01.md`), DECISION('Beta plan', '2026-10-05T11:00:00.000Z', 'Only beta here.'));
    expect((await searchHistory(project, { query: 'alpha beta' })).total).toBe(0);
    expect((await searchHistory(project, { query: 'ALPHA' })).total).toBe(1);
    expect((await searchHistory(project, { query: 'alpha', scope: 'memory' })).total).toBe(0);
    expect((await searchHistory(project, { query: 'alpha', scope: 'decisions' })).total).toBe(1);
  });

  it('пустой результат и отказ на плохие аргументы', async () => {
    expect(await searchHistory(project, { query: 'nothing-like-this' })).toMatchObject({ total: 0, hits: [], unavailable: [], scope: 'all', limit: 10 });
    for (const bad of [{ query: '   ' }, { query: 'x', limit: 0 }, { query: 'x', limit: 31 }, { query: 'x', limit: 1.5 }, { query: 'x', scope: 'skills' as never }, { query: 'x'.repeat(1001) }])
      await expect(searchHistory(project, bad)).rejects.toMatchObject({ code: 'search-invalid' });
  });

  it('лимит: по умолчанию 10, не больше 30, total показывает обрезку', async () => {
    for (let index = 0; index < 35; index++) await addBacklogItem(project, { title: `Shared topic ${String(index).padStart(2, '0')}` });
    const byDefault = await searchHistory(project, { query: 'topic' });
    expect(byDefault.hits).toHaveLength(10); expect(byDefault.total).toBe(35);
    expect((await searchHistory(project, { query: 'topic', limit: 30 })).hits).toHaveLength(30);
    expect((await searchHistory(project, { query: 'topic', limit: 1 })).hits).toHaveLength(1);
  });

  it('порядок: заголовок выше тела, затем новее; повтор запроса даёт тот же результат', async () => {
    await seed(state('decisions', `2026-10-01-${workId}-r-01-p-01-rev-01.md`), DECISION('Old cache decision', '2026-10-01T10:00:00.000Z'));
    await seed(state('decisions', `2026-10-05-${workId}-r-01-p-02-rev-01.md`), DECISION('New cache decision', '2026-10-05T10:00:00.000Z'));
    await seed(state('decisions', `2026-10-06-${workId}-r-01-p-03-rev-01.md`), DECISION('Unrelated title', '2026-10-06T10:00:00.000Z', 'Mentions cache only in the body.'));
    const first = await searchHistory(project, { query: 'cache' });
    expect(first.hits.map(hit => [hit.source, hit.title])).toEqual([
      ['sessions', 'Migrated the cache layer'], ['decisions', 'New cache decision'], ['decisions', 'Old cache decision'], ['decisions', 'Unrelated title'],
    ]);
    expect(await searchHistory(project, { query: 'cache' })).toEqual(first);
    expect((await searchHistory(project, { query: 'cache' })).hits.map(hit => hit.hash)).toEqual(first.hits.map(hit => hit.hash));
  });

  it('отрывок ограничен, помечен неполным, указывает строку совпадения и знает хэш записи', async () => {
    const file = state('decisions', `2026-10-05-${workId}-r-01-p-01-rev-01.md`);
    const body = `${'filler words '.repeat(60)}\nneedle in the middle\n${'tail words '.repeat(60)}`;
    await seed(file, DECISION('Long decision', '2026-10-05T10:00:00.000Z', body));
    const [hit] = (await searchHistory(project, { query: 'needle' })).hits;
    expect(hit!.complete).toBe(false);
    expect(hit!.excerpt).toContain('needle in the middle'); expect(hit!.excerpt.length).toBeLessThanOrEqual(242);
    expect(hit!.excerpt.startsWith('…') && hit!.excerpt.endsWith('…')).toBe(true);
    expect(hit!.line).toBe(await lineOf(file, 'needle in the middle'));
    expect(hit!.length).toBe((await readFile(file, 'utf8')).length); expect(hit!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await searchHistory(project, { query: 'cache layer' })).hits[0]!.complete).toBe(true);
  });

  it('дубликат shared/local: письмо в одном экземпляре — локальном; письма только из снимка остаются', async () => {
    await shareRoomHistory(project, workId, 'r-01');
    await updateMap(project, workId, map => { addMessage(map, { from: HUMAN, to: [], roomId: 'r-01', kind: 'note', text: 'Later local-only remark about sharding' }); });
    await rebuildRoomHistory(project, workId, 'r-01');

    const both = await searchHistory(project, { query: 'sharded', scope: 'history' });
    expect(both.total).toBe(1);
    expect(both.hits[0]).toMatchObject({ source: 'history', roomId: 'r-01', workId, alsoShared: true });
    expect(both.hits[0]!.file).toBe(state('history', `${workId}-r-01.md`)); expect(both.hits[0]!.shared).toBeUndefined();
    expect(both.hits[0]!.line).toBe(await lineOf(state('history', `${workId}-r-01.md`), 'Should the cache be sharded?'));
    expect((await searchHistory(project, { query: 'later remark', scope: 'history' })).hits[0]!.alsoShared).toBeUndefined();

    // Локальной истории больше нет (работа удалена): остаётся выложенный снимок.
    await rm(state('history'), { recursive: true });
    const onlyShared = await searchHistory(project, { query: 'sharded', scope: 'history' });
    expect(onlyShared.hits).toMatchObject([{ shared: true, file: state('history-shared', `${workId}-r-01.md`) }]);
    expect((await searchHistory(project, { query: 'later', scope: 'history' })).total).toBe(0);
  });

  it('нечитаемый источник отмечается в unavailable, остальные продолжают работать', async () => {
    await seed(state('memory.md'), '# Project memory\n## Facts\n<<<<<<< ours\n- A\n=======\n- B\n>>>>>>> theirs\n');
    const result = await searchHistory(project, { query: 'cache' });
    expect(result.unavailable).toEqual(['memory']);
    expect(result.hits.map(hit => hit.source)).toEqual(['sessions']);
  });

  it('не читает каталоги скиллов и личную память CLI', async () => {
    const home = path.join(root, 'home');
    process.env.HOME = home;
    await seed(path.join(home, '.claude', 'skills', 'x', 'SKILL.md'), '# x\nskilltoken lives here\n');
    await seed(path.join(project, '.claude', 'skills', 'y', 'SKILL.md'), '# y\nskilltoken lives here\n');
    await seed(path.join(home, '.codex', 'memories', 'memory.md'), 'skilltoken in native memory\n');
    expect((await searchHistory(project, { query: 'skilltoken' })).total).toBe(0);
  });
});
