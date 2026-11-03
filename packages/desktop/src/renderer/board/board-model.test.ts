import { describe, expect, it } from 'vitest';
import type { WindowWorkEntry } from '@parley/core';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { boardColumns, boardProjectPaths, boardProjects, cardKey, filterProjects, resolveTaken, reviewCount } from './board-model.js';
import type { BacklogRow, BoardProject } from './board-model.js';
import type { BoardSlot } from './board-store.js';

const snap = (projectPath: string, items: Partial<BacklogRow>[] = [], shared = projectPath): BacklogSnapshot => ({
  projectPath, sharedProjectPath: shared, version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [],
  items: items.map((item, i) => ({ id: `b-${String(i + 1).padStart(3, '0')}`, title: `Item ${i + 1}`, details: '', checked: false, section: null, ...item })),
});
const slots = (rows: [string, BacklogSnapshot | null, boolean?][]): Map<string, BoardSlot> =>
  new Map(rows.map(([path, snapshot, live]) => [path, { snapshot, live: live ?? true }]));
const entry = (projectPath: string, workId: string, status = 'active', sessions: string[] = [], rooms: string[] = []): WindowWorkEntry =>
  ({ projectPath, map: { work: { id: workId, status }, sessions: sessions.map(id => ({ id })), rooms: rooms.map(id => ({ id })) } }) as unknown as WindowWorkEntry;
const projects = (...rows: [string, BacklogSnapshot][]): BoardProject[] => boardProjects(slots(rows), null);

describe('board-model', () => {
  it('проекты доски — пути работ без архивных, без повторов', () => {
    const entries = [entry('/a', 'w-01'), entry('/a', 'w-02'), entry('/b', 'w-01', 'archived'), entry('/c', 'w-01', 'done')];
    expect(boardProjectPaths(entries)).toEqual(['/a', '/c']);
  });

  it('worktree и основная копия — один проект доски', () => {
    const result = boardProjects(slots([
      ['/repo/wt', snap('/repo/wt', [{ title: 'A' }], '/repo')],
      ['/repo', snap('/repo', [{ title: 'A' }], '/repo')],
    ]), null);
    expect(result.length).toBe(1);
    expect(result[0]!.projectPath).toBe('/repo');
    expect(result[0]!.key).toBe('/repo');
    expect([...result[0]!.paths]).toEqual(['/repo', '/repo/wt']);
    expect(result[0]!.title).toBe('repo');
  });

  it('Входящие — последними, слот без снимка пропускается', () => {
    const result = boardProjects(slots([['/z', snap('/z')], ['/inbox', snap('/inbox')], ['/a', snap('/a')], ['/none', null]]), '/inbox');
    expect(result.map(p => p.title)).toEqual(['a', 'z', S.board.noProject]);
    expect(result[2]!.inbox).toBe(true);
  });

  it('колонки по state; без state — по checked, taken и review', () => {
    const list = projects(['/p', snap('/p', [
      { state: 'review' }, { checked: false }, { taken: 'w-01/s-01' }, { taken: 'w-01/s-01', review: '2026-11-01T00:00:00Z' },
      { checked: true, done: '2026-11-14' },
    ])]);
    const cols = boardColumns(list, { kind: 'all' }, '2026-11-14');
    expect(cols.backlog.map(c => c.item.title)).toEqual(['Item 2']);
    expect(cols.inProgress.map(c => c.item.title)).toEqual(['Item 3']);
    expect(cols.review.map(c => c.item.title).sort()).toEqual(['Item 1', 'Item 4']);
    expect(cols.done.map(c => c.item.title)).toEqual(['Item 5']);
  });

  it('новые сверху по created, без created ниже в порядке файла', () => {
    const list = projects(['/p', snap('/p', [
      { title: 'none-1' }, { title: 'old', created: '2026-10-01T00:00:00Z' }, { title: 'none-2' }, { title: 'new', created: '2026-11-01T00:00:00Z' },
    ])]);
    const cols = boardColumns(list, { kind: 'all' }, '2026-11-14');
    expect(cols.backlog.map(c => c.item.title)).toEqual(['new', 'old', 'none-1', 'none-2']);
  });

  it('Done за 14 дней', () => {
    const list = projects(['/p', snap('/p', [
      { title: 'in', checked: true, done: '2026-11-01' }, { title: 'out', checked: true, done: '2026-10-31' },
      { title: 'nodate', checked: true }, { title: 'latest', checked: true, done: '2026-11-10' },
    ])]);
    const cols = boardColumns(list, { kind: 'all' }, '2026-11-14');
    expect(cols.done.map(c => c.item.title)).toEqual(['latest', 'in']);
    expect(cols.olderDone.map(c => c.item.title).sort()).toEqual(['nodate', 'out']);
  });

  it('фильтр по проекту ловит и путь worktree', () => {
    const list = boardProjects(slots([['/repo', snap('/repo', [{}], '/repo')], ['/repo/wt', snap('/repo/wt', [{}], '/repo')], ['/other', snap('/other', [{}])], ['/inbox', snap('/inbox', [{}])]]), '/inbox');
    expect(filterProjects(list, { kind: 'project', path: '/repo/wt' }).map(p => p.key)).toEqual(['/repo']);
    expect(filterProjects(list, { kind: 'project', path: '/repo' }).map(p => p.key)).toEqual(['/repo']);
    expect(filterProjects(list, { kind: 'inbox' }).map(p => p.key)).toEqual(['/inbox']);
    expect(filterProjects(list, { kind: 'all' }).length).toBe(3);
    expect(boardColumns(list, { kind: 'project', path: '/other' }, '2026-11-14').backlog.length).toBe(1);
  });

  it('reviewCount считает Review всех проектов', () => {
    const list = projects(['/a', snap('/a', [{ state: 'review' }, {}])], ['/b', snap('/b', [{ state: 'review' }, { state: 'review' }])]);
    expect(reviewCount(list)).toBe(3);
  });

  it('cardKey — путь проекта и номер, без номера — позиция', () => {
    const list = projects(['/p', snap('/p', [{}, { id: null }])]);
    const cols = boardColumns(list, { kind: 'all' }, '2026-11-14');
    expect(cols.backlog.map(cardKey).sort()).toEqual(['/p#@1', '/p#b-001']);
  });

  describe('resolveTaken', () => {
    const entries = [entry('/repo', 'w-01', 'active', ['s-02'], ['r-03']), entry('/repo/wt', 'w-05', 'active', ['s-01'])];
    const list = boardProjects(slots([['/repo', snap('/repo', [], '/repo')], ['/repo/wt', snap('/repo/wt', [], '/repo')]]), null);
    const project = list[0]!;

    it('сессия и комната', () => {
      const session = resolveTaken('w-01/s-02', project, entries);
      expect(session?.kind === 'session' && session.session.id).toBe('s-02');
      const room = resolveTaken('w-01/r-03', project, entries);
      expect(room?.kind === 'room' && room.room.id).toBe('r-03');
      expect(resolveTaken('w-01/s-99', project, entries)).toBeNull();
    });
    it('работа в worktree-пути группы', () => {
      const target = resolveTaken('w-05/s-01', project, entries);
      expect(target?.kind === 'session' && target.entry.projectPath).toBe('/repo/wt');
    });
    it('две работы с одним номером в группе — null', () => {
      expect(resolveTaken('w-01/s-02', project, [...entries, entry('/repo/wt', 'w-01', 'active', ['s-02'])])).toBeNull();
    });
    it('Входящие, мусор и пустой taken — null', () => {
      const inbox = boardProjects(slots([['/inbox', snap('/inbox')]]), '/inbox')[0]!;
      expect(resolveTaken('w-01/s-02', inbox, entries)).toBeNull();
      expect(resolveTaken('garbage', project, entries)).toBeNull();
      expect(resolveTaken(undefined, project, entries)).toBeNull();
    });
  });
});
