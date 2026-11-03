/**
 * Settings → Projects → Worktrees (спека 2026-11-03, 4.3): строки из `worktrees.leftovers`, «Remove copy» и
 * «Remove all» зовут `worktrees.removeCopy` после подтверждения и перечитывают список.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorktreeLeftover } from '@parley/core';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { WorktreeLeftovers } from './WorktreeLeftovers.js';

afterEach(cleanup);

function leftover(over: Partial<WorktreeLeftover> & { sessionId: string }): WorktreeLeftover {
  const { sessionId, ...rest } = over;
  return {
    ref: { projectPath: '/Users/me/app', workId: 'w1', sessionId },
    label: `Task ${sessionId}`,
    path: `/Users/me/.parley/worktrees/app/${sessionId}`,
    branch: `parley/${sessionId}`,
    reason: 'dirty',
    files: 3,
    message: null,
    sizeBytes: 52_428_800,
    ...rest,
  };
}

function bridgeWith(items: WorktreeLeftover[]): ReturnType<typeof createFakeBridge> {
  const bridge = createFakeBridge();
  let current = items;
  bridge.setHandler('worktrees.leftovers', () => ({ items: current }));
  bridge.setHandler('worktrees.removeCopy', (params) => {
    current = current.filter((item) => item.ref.sessionId !== params.ref.sessionId);
    return { removed: true, branchDeleted: false };
  });
  return bridge;
}

describe('WorktreeLeftovers', () => {
  it('строки из leftovers с причиной и размером', async () => {
    const bridge = bridgeWith([
      leftover({ sessionId: 'S01' }),
      leftover({ sessionId: 'S02', reason: 'refused', files: null, message: 'locked', sizeBytes: null }),
    ]);
    render(<WorktreeLeftovers bridge={bridge} />);

    const first = (await screen.findByText('Task S01')).closest('li') as HTMLElement;
    expect(within(first).getByText('3 uncommitted files')).toBeTruthy();
    expect(within(first).getByText('≈ 50 MB')).toBeTruthy();
    const second = screen.getByText('Task S02').closest('li') as HTMLElement;
    expect(within(second).getByText('Git refused: locked')).toBeTruthy();
    expect(within(second).queryByText(/≈/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove all' })).toBeTruthy();
  });

  it('Remove copy после подтверждения зовёт removeCopy и перезагружает', async () => {
    const bridge = bridgeWith([leftover({ sessionId: 'S01' }), leftover({ sessionId: 'S02' })]);
    render(<WorktreeLeftovers bridge={bridge} />);

    const row = (await screen.findByText('Task S01')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Remove copy/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Uncommitted changes in this copy will be lost. Commits stay in its branch.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove copy' }));

    await waitFor(() => expect(screen.queryByText('Task S01')).toBeNull());
    expect(bridge.calls).toContainEqual({
      method: 'worktrees.removeCopy',
      params: { ref: { projectPath: '/Users/me/app', workId: 'w1', sessionId: 'S01' } },
    });
    expect(bridge.calls.filter((call) => call.method === 'worktrees.leftovers')).toHaveLength(2);
  });

  it('Remove all зовёт removeCopy для каждой строки по очереди', async () => {
    const bridge = bridgeWith([leftover({ sessionId: 'S01' }), leftover({ sessionId: 'S02' })]);
    render(<WorktreeLeftovers bridge={bridge} />);

    await screen.findByText('Task S01');
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove all' }));

    expect(await screen.findByText('Nothing to clean up.')).toBeTruthy();
    const removed = bridge.calls.filter((call) => call.method === 'worktrees.removeCopy').map((call) => call.params);
    expect(removed).toEqual([
      { ref: { projectPath: '/Users/me/app', workId: 'w1', sessionId: 'S01' } },
      { ref: { projectPath: '/Users/me/app', workId: 'w1', sessionId: 'S02' } },
    ]);
  });

  it('длинный путь виден целиком в title', async () => {
    const long = '/Users/me/.parley/worktrees/a-very-long-project-name/the-room-with-a-really-long-directory-name/session-copy';
    const bridge = bridgeWith([leftover({ sessionId: 'S01', path: long })]);
    render(<WorktreeLeftovers bridge={bridge} />);

    const path = await screen.findByTitle(long);
    expect(path.textContent).toContain('…');
    expect(path.textContent?.length).toBeLessThan(long.length);
  });
});
