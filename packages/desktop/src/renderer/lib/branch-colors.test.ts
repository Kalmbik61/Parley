/**
 * Цвет значка ветки по базе (`branch-colors.ts`): красится только база, общая у двух и более открытых
 * worktree-сессий; разные общие базы — разные слоты; порядок сессий цвета не меняет.
 *
 * Хэш — FNV-1a 32 бит `% 5`: `master` и `release` дают 0 (пара с одинаковым хэшем), `base-a…base-f` — 3, 4, 0, 1, 2, 3.
 */

import { describe, expect, it } from 'vitest';
import type { WorkSession } from '@parley/core';
import { makeSession } from '../test-utils/work-fixtures.js';
import { BRANCH_COLOR_CLASS, branchColors, sessionBranchColor } from './branch-colors.js';

/** Сессия со своим worktree от базы `base`. */
function onBase(id: string, base: string, patch: Partial<WorkSession> = {}): WorkSession {
  return makeSession(id, id, { worktree: { path: `/tmp/${id}`, branch: `parley/w/${id}`, base, createdAt: null }, ...patch });
}

describe('branchColors', () => {
  it('одна worktree-сессия на базу — карта пуста', () => {
    expect(branchColors([onBase('s-01', 'main'), onBase('s-02', 'develop')]).size).toBe(0);
  });

  it('две открытые сессии с одной базой получают один слот', () => {
    const sessions = [onBase('s-01', 'main'), onBase('s-02', 'main')];
    const colors = branchColors(sessions);
    expect(colors.get('main')).toBe(2);
    expect(sessionBranchColor(colors, sessions[0]!)).toBe(2);
    expect(sessionBranchColor(colors, sessions[1]!)).toBe(2);
  });

  it('закрытая сессия не считается: открытая и закрытая с одной базой — слота нет', () => {
    const sessions = [onBase('s-01', 'main'), onBase('s-02', 'main', { lifecycle: 'closed' })];
    const colors = branchColors(sessions);
    expect(colors.size).toBe(0);
    expect(sessionBranchColor(colors, sessions[0]!)).toBeNull();
    expect(sessionBranchColor(colors, sessions[1]!)).toBeNull();
  });

  it('закрытая сессия общей базы слота не получает, открытые — получают', () => {
    const closed = onBase('s-03', 'main', { lifecycle: 'closed' });
    const colors = branchColors([onBase('s-01', 'main'), onBase('s-02', 'main'), closed]);
    expect(sessionBranchColor(colors, closed)).toBeNull();
    expect(colors.get('main')).toBe(2);
  });

  it('сессия без worktree не считается', () => {
    const plain = makeSession('s-03', 's-03');
    const colors = branchColors([onBase('s-01', 'main'), plain]);
    expect(colors.size).toBe(0);
    expect(sessionBranchColor(new Map([['main', 2]]), plain)).toBeNull();
  });

  it('две общие базы — разные слоты', () => {
    const colors = branchColors([onBase('s-01', 'main'), onBase('s-02', 'main'), onBase('s-03', 'dev'), onBase('s-04', 'dev')]);
    expect(colors.get('main')).toBe(2);
    expect(colors.get('dev')).toBe(1);
  });

  it('базы с одинаковым хэшем (master и release, оба 0) получают разные слоты', () => {
    const colors = branchColors([
      onBase('s-01', 'release'),
      onBase('s-02', 'release'),
      onBase('s-03', 'master'),
      onBase('s-04', 'master'),
    ]);
    // Порядок обхода — по строкам: `master` раньше `release`; занятый слот — следующий свободный.
    expect(colors.get('master')).toBe(0);
    expect(colors.get('release')).toBe(1);
  });

  it('перестановка сессий не меняет карту', () => {
    const sessions = [
      onBase('s-01', 'release'),
      onBase('s-02', 'master'),
      onBase('s-03', 'release'),
      onBase('s-04', 'master'),
      onBase('s-05', 'main'),
      onBase('s-06', 'main'),
    ];
    const forward = [...branchColors(sessions)].sort();
    const backward = [...branchColors([...sessions].reverse())].sort();
    expect(backward).toEqual(forward);
  });

  it('шесть общих баз: заняты все пять слотов, шестая берёт слот по хэшу', () => {
    const bases = ['base-a', 'base-b', 'base-c', 'base-d', 'base-e', 'base-f'];
    const sessions = bases.flatMap((base, index) => [onBase(`s-${index}a`, base), onBase(`s-${index}b`, base)]);
    const colors = branchColors(sessions);
    expect(bases.map((base) => colors.get(base))).toEqual([3, 4, 0, 1, 2, 3]);
    expect(new Set(colors.values()).size).toBe(5);
  });
});

describe('BRANCH_COLOR_CLASS', () => {
  it('пять классов по слотам 0…4', () => {
    expect(BRANCH_COLOR_CLASS).toEqual(['text-branch-1', 'text-branch-2', 'text-branch-3', 'text-branch-4', 'text-branch-5']);
  });
});
