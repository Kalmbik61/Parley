/**
 * Тест 1 куска 4.3 плана worktree: флажок «в своём worktree» неактивен для
 * не-git проекта и активен для git-проекта, даже с отсоединённой головой
 * (`branches` для этого не годится — см. комментарий в самом компоненте).
 * Кусок 1.4 плана «облик Orca»: флажок — `ui/switch` (кнопка с `role="switch"`,
 * не `input[type="checkbox"]`), поэтому проверка ищет `button`, а не `input`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { useUiStore } from '../../store/ui.js';
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

    const row = await screen.findByText('In its own worktree');
    const toggle = row.closest('label')?.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
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

    const row = await screen.findByText('In its own worktree');
    const toggle = row.closest('label')?.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
  });
});

describe('NewSessionDialog — агент по умолчанию, как у формы новой работы (кусок 3.5, тест 8)', () => {
  const PROVIDERS = [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'codex', label: 'Codex', available: true },
  ];

  async function launchWith(
    providers: Array<{ id: string; label: string; available: boolean }>,
    lastProvider: string | null,
  ): Promise<Record<string, unknown>> {
    useUiStore.setState({ ui: { ...DEFAULT_UI, lastProvider } });
    const bridge = createFakeBridge();
    bridge.setHandler('providers.list', async () => ({ providers }));
    bridge.setHandler('worktrees.available', async () => ({ available: false }));
    bridge.setHandler('sessions.create', async () => ({ ref: { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' } }));
    render(
      <NewSessionDialog open bridge={bridge} projectPath="/tmp/p" workId="w-01" selectedSessionId={null} onOpenChange={() => {}} />,
    );
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'sessions.create')).toBe(true));
    return bridge.calls.find((call) => call.method === 'sessions.create')?.params as Record<string, unknown>;
  }

  it('ui.lastProvider — он; при создании lastProvider запоминается', async () => {
    expect(await launchWith(PROVIDERS, 'codex')).toMatchObject({ provider: 'codex' });
    expect(useUiStore.getState().ui.lastProvider).toBe('codex');
  });

  it('без lastProvider — claude, а не первый в списке', async () => {
    expect(await launchWith([...PROVIDERS].reverse(), null)).toMatchObject({ provider: 'claude' });
    expect(useUiStore.getState().ui.lastProvider).toBe('claude');
  });

  it('claude недоступен — первый доступный', async () => {
    const providers = [
      { id: 'cursor', label: 'Cursor', available: false },
      { id: 'claude', label: 'Claude Code', available: false },
      { id: 'codex', label: 'Codex', available: true },
    ];
    expect(await launchWith(providers, null)).toMatchObject({ provider: 'codex' });
  });
});
