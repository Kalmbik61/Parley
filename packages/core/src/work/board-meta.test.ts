import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addBacklogItem, readBacklog } from './backlog.js';
import type { BacklogItem } from './backlog.js';
import { acceptBacklogSuggestion, suggestBacklog } from './backlog-suggestions.js';
import { backlogState, boardItems, readBoardMeta } from './board-meta.js';
import { setBacklogFile, setBacklogRule } from './project-preferences.js';
import { sharedProjectPaths } from './store.js';

const T = '2026-11-01T10:00:00.000Z';
const item = (patch: Partial<BacklogItem> = {}): BacklogItem => ({ id: 'b-001', title: 'Task', details: '', checked: false, section: null, ...patch });

let project = '';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T));
  project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-board-meta-')));
});
afterEach(async () => { vi.useRealTimers(); await rm(project, { recursive: true, force: true }); });

describe('backlogState', () => {
  it('выводит состояние из галочки, taken и review', () => {
    expect(backlogState(item())).toBe('backlog');
    expect(backlogState(item({ taken: 'w-1/s-2' }))).toBe('in-progress');
    expect(backlogState(item({ taken: 'w-1/s-2' }), { review: T })).toBe('review');
    expect(backlogState(item({ checked: true, taken: 'w-1/s-2' }), { review: T })).toBe('done');
    expect(backlogState(item(), { review: T })).toBe('backlog');
  });
});

describe('board.json', () => {
  it('addBacklogItem пишет created в board.json, а строку не трогает', async () => {
    await addBacklogItem(project, { title: 'Contrast' });
    const paths = await sharedProjectPaths(project);
    expect((await readBoardMeta(paths)).meta.items['b-001']).toEqual({ created: T });
    expect(await readFile(path.join(project, '.parley', 'backlog.md'), 'utf8')).toContain('- [ ] Contrast <!-- b-001 -->');
  });
  it('принятое предложение тоже получает created', async () => {
    await setBacklogRule(project, 'ask');
    const suggested = await suggestBacklog(project, { kind: 'bug', title: 'Pending', why: 'Concrete finding', workId: 'w-0001', sessionId: 's-03' });
    expect(suggested.status).toBe('pending');
    const accepted = await acceptBacklogSuggestion(project, suggested.id);
    const paths = await sharedProjectPaths(project);
    expect((await readBoardMeta(paths)).meta.items[accepted.id]).toEqual({ created: T });
  });
  it('испорченный board.json читается как пустой', async () => {
    await addBacklogItem(project, { title: 'One' });
    const paths = await sharedProjectPaths(project);
    await writeFile(path.join(paths.dir, 'board.json'), '{');
    const { meta } = await readBoardMeta(paths);
    expect(meta).toEqual({ version: 1, items: {} });
    const document = await readBacklog(project);
    expect(boardItems(document, meta).map(row => row.state)).toEqual(['backlog']);
  });
  it('каталог на месте board.json не роняет добавление', async () => {
    const paths = await sharedProjectPaths(project);
    await mkdir(path.join(paths.dir, 'board.json'), { recursive: true });
    const added = await addBacklogItem(project, { title: 'Survives' });
    expect(added.id).toBe('b-001');
    expect(await readFile(path.join(project, '.parley', 'backlog.md'), 'utf8')).toContain('- [ ] Survives <!-- b-001 -->');
  });
  it('при выборе TODOS.md board.json остаётся в каталоге состояния', async () => {
    await writeFile(path.join(project, 'TODOS.md'), '# TODOS\n\n## Backlog\n- [ ] Mine\n');
    await setBacklogFile(project, 'todos');
    await addBacklogItem(project, { title: 'Added' });
    expect(await readFile(path.join(project, '.parley', 'board.json'), 'utf8')).toContain('created');
    expect(await readFile(path.join(project, 'TODOS.md'), 'utf8')).not.toContain('created');
  });
});
