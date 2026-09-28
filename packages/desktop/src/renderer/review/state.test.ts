import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffFile, MergeCheck, WorktreeDiff } from '@harnas/core';
import {
  askAgentText,
  changesErrorText,
  changesSections,
  fitsSendLimit,
  mergeResultText,
  primaryActionFor,
  type ChangesSource,
} from './state.js';

function file(path: string, status: DiffFile['status'] = 'M'): DiffFile {
  return { path, status, oldPath: null, additions: 1, deletions: 0 };
}

function diff(patch: Partial<WorktreeDiff> = {}): WorktreeDiff {
  return {
    patch: '',
    files: [],
    uncommitted: false,
    baseCheckout: '/tmp/proj',
    baseDirty: false,
    mergeBase: 'a'.repeat(40),
    stats: { additions: 0, deletions: 0 },
    commits: [],
    uncommittedPaths: [],
    ...patch,
  };
}

const commit = { hash: 'b'.repeat(40), subject: 'feat', author: 'agent', at: '2026-09-27T09:00:00Z' };

function worktree(d: WorktreeDiff, check: MergeCheck | null = null): ChangesSource {
  return { kind: 'worktree', branch: 'harnas/w-0003/s02', base: 'master', diff: d, check };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('primaryActionFor (тест 1: таблица спеки 11.2)', () => {
  it('project: есть файлы → commit-project, нет → nothing', () => {
    const changes = { patch: '', files: [file('a.ts')], stats: { additions: 1, deletions: 0 }, branch: 'master' };
    expect(primaryActionFor({ kind: 'project', changes })).toEqual({ kind: 'commit-project' });
    expect(primaryActionFor({ kind: 'project', changes: { ...changes, files: [] } })).toEqual({ kind: 'nothing' });
  });

  it('pending → nothing', () => {
    expect(primaryActionFor({ kind: 'pending' })).toEqual({ kind: 'nothing' });
  });

  it('незакоммиченное → commit, в том числе при конфликтах', () => {
    expect(primaryActionFor(worktree(diff({ uncommitted: true, files: [file('a.ts')] })))).toEqual({ kind: 'commit' });
    const both = worktree(diff({ uncommitted: true, commits: [commit] }), { status: 'conflicts', files: ['a.ts'] });
    expect(primaryActionFor(both)).toEqual({ kind: 'commit' });
  });

  it('всё закоммичено, есть коммиты: clean, unsupported, null → merge; conflicts → ask-agent', () => {
    const d = diff({ commits: [commit], files: [file('a.ts')] });
    expect(primaryActionFor(worktree(d, { status: 'clean' }))).toEqual({ kind: 'merge', base: 'master' });
    expect(primaryActionFor(worktree(d, { status: 'unsupported' }))).toEqual({ kind: 'merge', base: 'master' });
    expect(primaryActionFor(worktree(d, null))).toEqual({ kind: 'merge', base: 'master' });
    expect(primaryActionFor(worktree(d, { status: 'conflicts', files: ['src/a.ts', 'src/b.ts'] }))).toEqual({
      kind: 'ask-agent',
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('нет изменений и коммитов → nothing', () => {
    expect(primaryActionFor(worktree(diff()))).toEqual({ kind: 'nothing' });
  });
});

describe('mergeResultText (тест 2)', () => {
  it('четыре причины и успех — английские тексты', () => {
    expect(mergeResultText({ ok: true, commit: 'c' }, 'master')).toEqual({ text: 'Merged into master', conflicts: null });
    expect(mergeResultText({ ok: false, reason: 'base_not_checked_out', files: [] }, 'master')).toEqual({
      text: "master isn't checked out anywhere — check it out in the project folder",
      conflicts: null,
    });
    expect(mergeResultText({ ok: false, reason: 'base_dirty', files: [] }, 'master')).toEqual({
      text: 'master has uncommitted changes — commit or stash them',
      conflicts: null,
    });
    expect(mergeResultText({ ok: false, reason: 'uncommitted', files: [] }, 'master')).toEqual({
      text: 'The worktree has uncommitted changes — commit first',
      conflicts: null,
    });
    expect(mergeResultText({ ok: false, reason: 'conflict', files: ['src/a.ts', 'src/b.ts'] }, 'master')).toEqual({
      text: 'Merge conflict in src/a.ts, src/b.ts',
      conflicts: ['src/a.ts', 'src/b.ts'],
    });
  });
});

describe('askAgentText (тест 3)', () => {
  it('два файла — английский шаблон, кириллица пути как есть', () => {
    expect(askAgentText('harnas/w-0003/s02', 'master', ['src/a.ts', 'файл.txt'])).toBe(
      'Branch harnas/w-0003/s02 has merge conflicts with master in:\n' +
        '- src/a.ts\n' +
        '- файл.txt\n' +
        'Merge master into your branch (git merge master), resolve the conflicts, commit, and tell me what you did.',
    );
  });
});

describe('changesSections (тест 4)', () => {
  it('worktree — по uncommittedPaths; путь без записи в files не показан', () => {
    const d = diff({
      files: [file('a.ts'), file('b.ts', 'A'), file('c.ts')],
      uncommittedPaths: ['b.ts', 'gone.ts'],
      uncommitted: true,
    });
    const sections = changesSections(worktree(d));
    expect(sections.uncommitted.map((f) => f.path)).toEqual(['b.ts']);
    expect(sections.branch.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
  });

  it('project — всё в uncommitted; pending — пусто', () => {
    const changes = { patch: '', files: [file('a.ts'), file('b.ts')], stats: { additions: 2, deletions: 0 }, branch: null };
    const sections = changesSections({ kind: 'project', changes });
    expect(sections.uncommitted.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(sections.branch).toEqual([]);
    expect(changesSections({ kind: 'pending' })).toEqual({ uncommitted: [], branch: [] });
  });
});

describe('changesErrorText (тест 5)', () => {
  it('причины git — свои тексты, прочее — errorText; сообщение хоста — в консоль', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(changesErrorText({ code: 'internal', message: 'git не найден', data: { reason: 'git-missing' } })).toBe('Git not found');
    expect(changesErrorText({ code: 'bad_request', message: 'не репозиторий', data: { reason: 'not-a-repo' } })).toBe(
      'This folder is not a git repository',
    );
    expect(changesErrorText({ code: 'bad_request', message: 'нет коммитов', data: { reason: 'no-commits' } })).toBe(
      "Couldn't load changes: invalid request.",
    );
    expect(changesErrorText({ code: 'bad_request', message: 'x' })).toBe("Couldn't load changes: invalid request.");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.join(' '))).toContain('git не найден');
  });
});

describe('fitsSendLimit (тест 6)', () => {
  it('предел — 65 536 байт UTF-8', () => {
    expect(fitsSendLimit('a'.repeat(65_536))).toBe(true);
    expect(fitsSendLimit('a'.repeat(65_537))).toBe(false);
    expect(fitsSendLimit('я'.repeat(32_768))).toBe(true);
    expect(fitsSendLimit('я'.repeat(32_769))).toBe(false);
  });
});
