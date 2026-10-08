import { describe, expect, it } from 'vitest';
import { HOST_ERROR_REASONS } from './index.js';
import type { LiveMetrics } from './index.js';

describe('HOST_ERROR_REASONS', () => {
  it('строки причин — прежние: их читают по значению хост и окно разных версий (fix-lane-post, п. 3)', () => {
    expect(HOST_ERROR_REASONS).toEqual({
      gitMissing: 'git-missing',
      notARepo: 'not-a-repo',
      noCommits: 'no-commits',
      worktreeMissing: 'worktree-missing',
      worktreeCorrupt: 'worktree-corrupt',
      worksUnreadable: 'works-unreadable',
      clientUpgradeRequired: 'client-upgrade-required',
      snapshotTooLarge: 'snapshot-too-large',
      // Нормалайзер модели и effort (5.7–5.8): «сессия занята» у `sessions.setEffort` и `sessions.setModel`.
      busy: 'busy',
    });
  });
});

describe('LiveMetrics.usage', () => {
  it('публичная форма: счётчики с null и происхождение, без нативных идентификаторов; поле необязательно для хоста прежней версии', () => {
    const older: LiveMetrics = { tokensIn: 1, tokensOut: 2, durationMs: null, unread: 0, subagents: 0, model: null };
    const current: LiveMetrics = {
      ...older,
      usage: {
        input: 1,
        output: 2,
        cacheRead: null,
        cacheWrite: null,
        totalInput: null,
        source: 'native-index',
        observedAt: null,
        stale: false,
        completeness: 'complete',
        coverage: 'conversation',
        attribution: { workId: 'w-1', sessionId: 's-01', roomId: null, runId: null },
      },
    };
    expect(older.usage).toBeUndefined();
    expect(Object.keys(current.usage ?? {}).sort()).toEqual(
      ['attribution', 'cacheRead', 'cacheWrite', 'completeness', 'coverage', 'input', 'observedAt', 'output', 'source', 'stale', 'totalInput'],
    );
  });
});
