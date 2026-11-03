import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBacklogItem, readBacklog, takeBacklogItem } from './backlog.js';
import { boardCardMessage, boardInboxPath, boardMove, boardTake, boardTransfer, ensureBoardInbox, markBoardReview, planBacklogIds, readBoardItems } from './board.js';
import { readBoardMeta } from './board-meta.js';
import { sharedProjectPaths } from './store.js';
import type { WorkMap } from './types.js';

const T = '2026-11-01T10:00:00.000Z';
const LATER = '2026-11-02T12:30:00.000Z';
const WHO = 'w-1/s-2';

let project = '';
let other = '';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T));
  project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-board-')));
  other = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-board-other-')));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(project, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

const metaOf = async (target: string, id: string) => (await readBoardMeta(await sharedProjectPaths(target))).meta.items[id];
const stateOf = async (target: string, id: string) => (await readBoardItems(target)).items.find(row => row.id === id)?.state;
const conflictOf = async (run: () => Promise<unknown>) => expect(run()).rejects.toMatchObject({ code: 'backlog-conflict' });

describe('boardTake', () => {
  it('boardTake ставит taken и sent и снимает review', async () => {
    await addBacklogItem(project, { title: 'One' });
    await boardTake(project, 'b-001', WHO);
    vi.setSystemTime(new Date(LATER));
    await boardMove(project, 'b-001', 'review');
    expect((await metaOf(project, 'b-001'))?.review).toBe(LATER);
    await boardTake(project, 'b-001', WHO);
    expect(await metaOf(project, 'b-001')).toEqual({ created: T, sent: LATER });
    expect(await stateOf(project, 'b-001')).toBe('in-progress');
  });
  it('boardTake той же целью повторно — без ошибки', async () => {
    await addBacklogItem(project, { title: 'One' });
    await boardTake(project, 'b-001', WHO);
    await expect(boardTake(project, 'b-001', WHO)).resolves.toMatchObject({ id: 'b-001' });
  });
  it('boardTake другой целью — backlog-conflict', async () => {
    await addBacklogItem(project, { title: 'One' });
    await boardTake(project, 'b-001', WHO);
    await conflictOf(() => boardTake(project, 'b-001', 'w-1/s-3'));
  });
  it('boardTake по пункту с галочкой — backlog-conflict', async () => {
    await addBacklogItem(project, { title: 'One' });
    await boardMove(project, 'b-001', 'done');
    await conflictOf(() => boardTake(project, 'b-001', WHO));
  });
  it('boardTake по рукописному пункту без номера', async () => {
    await mkdir(path.join(project, '.parley'), { recursive: true });
    await writeFile(path.join(project, '.parley', 'backlog.md'), '# Backlog\n- [ ] Hand written\n');
    const { version } = await readBacklog(project);
    const result = await boardTake(project, 0, WHO, { expectedVersion: version });
    expect(result.id).toBe('b-001');
    expect((await metaOf(project, 'b-001'))?.sent).toBe(T);
  });
  it('boardTake с устаревшей версией — backlog-conflict', async () => {
    await addBacklogItem(project, { title: 'One' });
    await conflictOf(() => boardTake(project, 'b-001', WHO, { expectedVersion: 'stale' }));
  });
});

describe('boardMove', () => {
  const taken = async () => { await addBacklogItem(project, { title: 'One' }); await boardTake(project, 'b-001', WHO); };

  it('in-progress → review ставит review', async () => {
    await taken();
    vi.setSystemTime(new Date(LATER));
    await boardMove(project, 'b-001', 'review');
    expect((await metaOf(project, 'b-001'))?.review).toBe(LATER);
    expect(await stateOf(project, 'b-001')).toBe('review');
  });
  it('review → in-progress снимает review', async () => {
    await taken();
    await boardMove(project, 'b-001', 'review');
    await boardMove(project, 'b-001', 'in-progress');
    expect((await metaOf(project, 'b-001'))?.review).toBeUndefined();
    expect(await stateOf(project, 'b-001')).toBe('in-progress');
  });
  it('в backlog после review стираются review и sent', async () => {
    await taken();
    await boardMove(project, 'b-001', 'review');
    await boardMove(project, 'b-001', 'backlog');
    expect(await metaOf(project, 'b-001')).toEqual({ created: T });
    expect(await stateOf(project, 'b-001')).toBe('backlog');
    expect((await readBacklog(project)).items[0]?.taken).toBeUndefined();
  });
  it('in-progress → backlog снимает taken и sent', async () => {
    await taken();
    await boardMove(project, 'b-001', 'backlog');
    expect(await metaOf(project, 'b-001')).toEqual({ created: T });
  });
  it('done → backlog снимает галочку, done, taken, sent и review', async () => {
    await taken();
    await boardMove(project, 'b-001', 'review');
    await boardMove(project, 'b-001', 'done');
    await boardMove(project, 'b-001', 'backlog');
    const row = (await readBacklog(project)).items[0];
    expect(row).toMatchObject({ checked: false });
    expect(row?.taken).toBeUndefined();
    expect(row?.done).toBeUndefined();
    expect(await metaOf(project, 'b-001')).toEqual({ created: T });
  });
  it('backlog, in-progress и review → done ставят галочку и дату', async () => {
    for (const steps of [[], ['take'], ['take', 'review']] as const) {
      const id = (await addBacklogItem(project, { title: `Item ${steps.length}` })).id;
      if (steps.includes('take')) await boardTake(project, id, WHO);
      if (steps.includes('review')) await boardMove(project, id, 'review');
      await boardMove(project, id, 'done');
      const row = (await readBacklog(project)).items.find(candidate => candidate.id === id);
      expect(row).toMatchObject({ checked: true, done: '2026-11-01' });
      expect(await stateOf(project, id)).toBe('done');
    }
  });
  it('то же → то же ничего не меняет', async () => {
    await taken();
    const before = await readBacklog(project);
    const result = await boardMove(project, 'b-001', 'in-progress');
    expect(result.document.version).toBe(before.version);
    expect(result.document.source).toBe(before.source);
  });
  it('то же → то же с устаревшей версией — backlog-conflict', async () => {
    await taken();
    await conflictOf(() => boardMove(project, 'b-001', 'in-progress', { expectedVersion: 'stale' }));
  });
  it('backlog → review запрещён', async () => {
    await addBacklogItem(project, { title: 'One' });
    await conflictOf(() => boardMove(project, 'b-001', 'review'));
  });
  it('backlog → in-progress запрещён', async () => {
    await addBacklogItem(project, { title: 'One' });
    await conflictOf(() => boardMove(project, 'b-001', 'in-progress'));
  });
  it('done → in-progress запрещён', async () => {
    await addBacklogItem(project, { title: 'One' });
    await boardMove(project, 'b-001', 'done');
    await conflictOf(() => boardMove(project, 'b-001', 'in-progress'));
  });
  it('устаревшая версия — backlog-conflict', async () => {
    await taken();
    await conflictOf(() => boardMove(project, 'b-001', 'review', { expectedVersion: 'stale' }));
    await conflictOf(() => boardMove(project, 'b-001', 'done', { expectedVersion: 'stale' }));
  });
});

describe('markBoardReview', () => {
  it('переводит свою карточку в review', async () => {
    await addBacklogItem(project, { title: 'One' });
    await boardTake(project, 'b-001', WHO);
    vi.setSystemTime(new Date(LATER));
    expect(await markBoardReview(project, ['b-001'], [WHO])).toEqual({ review: ['b-001'], skipped: [] });
    expect((await metaOf(project, 'b-001'))?.review).toBe(LATER);
  });
  it('пропускает чужую, несуществующую, с галочкой, исключённую; повтор — already', async () => {
    for (const title of ['Mine', 'Foreign', 'Done', 'Plan', 'Free']) await addBacklogItem(project, { title });
    await boardTake(project, 'b-001', WHO);
    await boardTake(project, 'b-002', 'w-1/s-9');
    await boardMove(project, 'b-003', 'done');
    await boardTake(project, 'b-004', WHO);
    const ids = ['b-001', 'b-002', 'b-003', 'b-004', 'b-005', 'b-099'];
    const first = await markBoardReview(project, ids, [WHO], new Set(['b-004']));
    expect(first.review).toEqual(['b-001']);
    expect(first.skipped).toEqual([
      { id: 'b-002', reason: 'not-yours' }, { id: 'b-003', reason: 'done' }, { id: 'b-004', reason: 'plan' },
      { id: 'b-005', reason: 'not-yours' }, { id: 'b-099', reason: 'missing' },
    ]);
    const again = await markBoardReview(project, ['b-001'], [WHO]);
    expect(again).toEqual({ review: [], skipped: [{ id: 'b-001', reason: 'already' }] });
  });
});

describe('boardTransfer', () => {
  it('из «Входящих» в проект: новый номер, пункта в источнике нет, created перенесён', async () => {
    await addBacklogItem(project, { title: 'Existing' });
    await addBacklogItem(other, { title: 'Idea', details: 'Some details' });
    vi.setSystemTime(new Date(LATER));
    const moved = await boardTransfer(other, 'b-001', project);
    expect(moved.id).toBe('b-002');
    const target = await readBacklog(project);
    expect(target.items.find(row => row.id === 'b-002')).toMatchObject({ title: 'Idea', details: 'Some details' });
    expect((await readBacklog(other)).items).toEqual([]);
    expect((await metaOf(project, 'b-002'))?.created).toBe(T);
  });
  it('устаревшая версия — backlog-conflict, копии в цели нет', async () => {
    await addBacklogItem(other, { title: 'Idea' });
    await conflictOf(() => boardTransfer(other, 'b-001', project, { version: 'stale' }));
    expect((await readBacklog(project)).items).toEqual([]);
  });
  it('взятая карточка — backlog-conflict', async () => {
    await addBacklogItem(other, { title: 'Idea' });
    await takeBacklogItem(other, 'b-001', WHO);
    await conflictOf(() => boardTransfer(other, 'b-001', project));
  });
  it('номер из planIds — backlog-conflict', async () => {
    await addBacklogItem(other, { title: 'Idea' });
    await conflictOf(() => boardTransfer(other, 'b-001', project, { planIds: new Set(['b-001']) }));
  });
});

describe('«Входящие»', () => {
  it('boardInboxPath учитывает PARLEY_HOME', () => {
    expect(boardInboxPath({ PARLEY_HOME: '/tmp/parley-home-x' })).toBe(path.join('/tmp/parley-home-x', 'board', 'inbox'));
  });
  it('ensureBoardInbox создаёт каталог, readBoardItems работает как на проекте', async () => {
    const inbox = await ensureBoardInbox({ PARLEY_HOME: project });
    expect(inbox).toBe(path.join(project, 'board', 'inbox'));
    await addBacklogItem(inbox, { title: 'Inbox card' });
    const board = await readBoardItems(inbox);
    expect(board.items).toMatchObject([{ id: 'b-001', title: 'Inbox card', state: 'backlog', created: T }]);
    expect(await readFile(path.join(inbox, '.parley', 'backlog.md'), 'utf8')).toContain('Inbox card');
  });
});

describe('planBacklogIds', () => {
  it('собирает номера из map.plans и предложенного плана комнаты', () => {
    const map = {
      plans: [{ backlog: ['b-001'] }],
      rooms: [{ proposal: { plan: { backlog: ['b-002', 'b-003'] } } }, { proposal: null }],
    } as unknown as WorkMap;
    expect([...planBacklogIds(map)].sort()).toEqual(['b-001', 'b-002', 'b-003']);
  });
});

describe('boardCardMessage', () => {
  it('с деталями', () => {
    expect(boardCardMessage({ id: 'b-007', title: 'Fix it', details: '  Look at X.  ', project: 'demo' })).toBe(
      'Board card b-007 (demo): Fix it\n\nLook at X.\n\nWhen it is done, call report with status done and backlog ["b-007"].');
  });
  it('без деталей', () => {
    expect(boardCardMessage({ id: 'b-007', title: 'Fix it', details: ' ', project: 'demo' })).toBe(
      'Board card b-007 (demo): Fix it\n\nWhen it is done, call report with status done and backlog ["b-007"].');
  });
});
