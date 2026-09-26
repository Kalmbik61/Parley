/**
 * Тест 1 куска 4.3 плана worktree: флажок «в своём worktree» неактивен для
 * не-git проекта и активен для git-проекта, даже с отсоединённой головой
 * (`branches` для этого не годится — см. комментарий в самом компоненте).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { NewSessionDialog } from './NewSessionDialog.js';

afterEach(cleanup);

describe('NewSessionDialog — тест 1: флажок «в своём worktree»', () => {
  it('не-git проект — флажок неактивен', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', async () => ({ providers: [] }));
    bridge.setHandler('worktrees.available', async () => ({ available: false }));

    render(
      <NewSessionDialog
        open
        bridge={bridge}
        projectPath="/tmp/not-git"
        workId="w-01"
        selectedSessionId={null}
        onOpenChange={() => {}}
      />,
    );

    const checkbox = await screen.findByText('в своём worktree');
    const input = checkbox.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('git-проект (даже с отсоединённой головой — worktrees.available смотрит не на ветку) — флажок активен', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', async () => ({ providers: [] }));
    bridge.setHandler('worktrees.available', async () => ({ available: true }));

    render(
      <NewSessionDialog
        open
        bridge={bridge}
        projectPath="/tmp/detached-head-repo"
        workId="w-01"
        selectedSessionId={null}
        onOpenChange={() => {}}
      />,
    );

    const checkbox = await screen.findByText('в своём worktree');
    const input = checkbox.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
});
