import { describe, expect, it } from 'vitest';
import { HOST_ERROR_REASONS } from './index.js';

describe('HOST_ERROR_REASONS', () => {
  it('строки причин — прежние: их читают по значению хост и окно разных версий (fix-lane-post, п. 3)', () => {
    expect(HOST_ERROR_REASONS).toEqual({
      gitMissing: 'git-missing',
      notARepo: 'not-a-repo',
      noCommits: 'no-commits',
      worktreeMissing: 'worktree-missing',
      worktreeCorrupt: 'worktree-corrupt',
      worksUnreadable: 'works-unreadable',
      // Нормалайзер модели и effort (5.7–5.8): «сессия занята» у `sessions.setEffort` и `sessions.setModel`.
      busy: 'busy',
    });
  });
});
