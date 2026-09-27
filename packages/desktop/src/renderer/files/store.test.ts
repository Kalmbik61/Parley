/**
 * Тесты 1 и 11 (чистая часть) куска 7.2: корень «Файлов» по умолчанию и выбор человека,
 * раскрытые папки по ключу корня.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { defaultRoot, filesRootSpec, useFilesStore } from './store.js';

const worktree = (createdAt: string | null) => ({ path: '/wt/s02', branch: 'harnas/w-0003/s02', base: 'main', createdAt });

const entry = makeWork('w-01', {
  projectPath: '/tmp/proj',
  sessions: [
    makeSession('s-01', 'plain'),
    makeSession('s-02', 'wt', { worktree: worktree('2026-09-27T08:00:00.000Z') }),
    makeSession('s-04', 'planned', { worktree: worktree(null) }),
  ],
});
const key = '/tmp/proj w-01';

beforeEach(() => {
  useFilesStore.setState({ rootByWork: {}, expanded: {} });
});

describe('defaultRoot (тест 1)', () => {
  it('сессия с worktree → worktree; без — project; worktree с createdAt: null → project', () => {
    expect(defaultRoot(entry, 's-02')).toEqual({ kind: 'worktree', sessionId: 's-02' });
    expect(defaultRoot(entry, 's-01')).toEqual({ kind: 'project' });
    expect(defaultRoot(entry, 's-04')).toEqual({ kind: 'project' });
    expect(defaultRoot(entry, null)).toEqual({ kind: 'project' });
    expect(defaultRoot(entry, 's-99')).toEqual({ kind: 'project' });
  });
});

describe('filesRootSpec (тест 11)', () => {
  it('выбор человека держится при любом фокусе; без выбора — worktree сессии в фокусе', () => {
    expect(filesRootSpec({}, entry, 's-02')).toEqual({ kind: 'worktree', sessionId: 's-02' });
    useFilesStore.getState().setRoot(key, { kind: 'project' });
    const chosen = useFilesStore.getState().rootByWork;
    expect(filesRootSpec(chosen, entry, 's-02')).toEqual({ kind: 'project' });
    useFilesStore.getState().setRoot(key, { kind: 'worktree', sessionId: 's-02' });
    expect(filesRootSpec(useFilesStore.getState().rootByWork, entry, 's-01')).toEqual({ kind: 'worktree', sessionId: 's-02' });
    expect(filesRootSpec(useFilesStore.getState().rootByWork, entry, null)).toEqual({ kind: 'worktree', sessionId: 's-02' });
  });
});

describe('toggleDir', () => {
  it('раскрывает и сворачивает папку своего корня, чужой корень не трогает; Set — новый', () => {
    const { toggleDir } = useFilesStore.getState();
    toggleDir('r1', 'src');
    const first = useFilesStore.getState().expanded.r1;
    expect([...(first ?? [])]).toEqual(['src']);
    toggleDir('r1', 'src/lib');
    expect(useFilesStore.getState().expanded.r1).not.toBe(first);
    expect([...(useFilesStore.getState().expanded.r1 ?? [])]).toEqual(['src', 'src/lib']);
    toggleDir('r1', 'src');
    expect([...(useFilesStore.getState().expanded.r1 ?? [])]).toEqual(['src/lib']);
    expect(useFilesStore.getState().expanded.r2).toBeUndefined();
  });
});
