/**
 * Кусок 7.2: `RootPicker` — «Project» и `⎇ S02 · ветка` у каждой сессии с созданным worktree.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { RootPicker, rootOptions } from './RootPicker.js';

const worktree = (branch: string, createdAt: string | null) => ({ path: `/wt/${branch}`, branch, base: 'main', createdAt });

const ENTRY = makeWork('w-01', {
  sessions: [
    makeSession('s-01', 'plain'),
    makeSession('s-02', 'two', { worktree: worktree('harnas/w-0003/s02', '2026-09-27T08:00:00.000Z') }),
    makeSession('s-04', 'planned', { worktree: worktree('harnas/w-0003/s04', null) }),
  ],
});

afterEach(cleanup);

describe('rootOptions', () => {
  it('проект и worktree сессий с созданной папкой', () => {
    expect(rootOptions(ENTRY)).toEqual([
      { value: 'project', label: 'Project', spec: { kind: 'project' } },
      { value: 'worktree:s-02', label: '⎇ S02 · harnas/w-0003/s02', spec: { kind: 'worktree', sessionId: 's-02' } },
    ]);
  });
});

describe('RootPicker', () => {
  it('показывает выбранный корень; длинная ветка — полный текст в title', () => {
    const long = `harnas/${'b'.repeat(200)}`;
    const entry = makeWork('w-01', { sessions: [makeSession('s-02', 'two', { worktree: worktree(long, '2026-09-27T08:00:00.000Z') })] });
    render(<RootPicker entry={entry} value={{ kind: 'worktree', sessionId: 's-02' }} onChange={() => {}} />);
    const trigger = screen.getByRole('combobox');
    expect(trigger.textContent).toContain(`⎇ S02 · ${long}`);
    expect(trigger.getAttribute('title')).toBe(`⎇ S02 · ${long}`);
  });
});
