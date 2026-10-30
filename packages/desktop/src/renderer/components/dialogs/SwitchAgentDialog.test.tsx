/**
 * Диалог замены агента (спека 2026-10-30, 5.7): цели, предвыбор `suggested`, перенос транскрипта только у цели с
 * `transcript`, «Keeps», `blockers`, `force` после `busy`, один `requestId` на открытие.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { useProvidersStore } from '../../store/providers.js';
import { closeSwitchAgent, openSwitchAgent } from '../../store/switch-agent.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { SwitchAgentDialogHost } from './SwitchAgentDialog.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const REF = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-11' };
let bridge: FakeBridge;

const options = (patch: Partial<Result<'sessions.switchOptions'>> = {}): Result<'sessions.switchOptions'> => ({
  current: { provider: 'claude', available: true, reason: 'limit' },
  targets: [
    { id: 'claude-2', label: 'Claude Code 2', family: 'claude', available: true, needs: null, limits: null, transcript: true },
    { id: 'codex', label: 'Codex', family: 'codex', available: true, needs: null, limits: null, transcript: false },
    { id: 'glm', label: 'GLM', family: null, available: false, needs: 'Add a Z.ai key', limits: null, transcript: false },
  ],
  suggested: 'claude-2',
  keeps: { rooms: 2, leads: ['r-02'], owns: ['r-11'], children: 4, unread: 3, worktree: 'parley/w-0054/s-11' },
  blockers: [],
  ...patch,
});

const calls = (): Array<Record<string, unknown>> => bridge.calls.filter((call) => call.method === 'sessions.switchAgent').map((call) => call.params as Record<string, unknown>);

async function open(result = options()): Promise<void> {
  bridge.setHandler('sessions.switchOptions', () => result);
  render(<SwitchAgentDialogHost bridge={bridge} />);
  act(() => openSwitchAgent(REF));
  await screen.findByRole('radiogroup', { name: 'Provider' });
}

beforeEach(() => {
  bridge = createFakeBridge();
  useProvidersStore.setState({ providers: [], loaded: true });
});

afterEach(() => {
  act(() => closeSwitchAgent());
  cleanup();
});

describe('SwitchAgentDialog', () => {
  it('предвыбирает suggested; недоступная цель выключена, причина видна; Keeps — из keeps', async () => {
    await open();
    expect(screen.getByRole('radio', { name: /Claude Code 2/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Codex/ }).getAttribute('aria-checked')).toBe('false');
    const glm = screen.getByRole('radio', { name: /GLM/ }) as HTMLButtonElement;
    expect(glm.disabled).toBe(true);
    expect(glm.textContent).toContain('Add a Z.ai key');
    expect(document.querySelector('[data-switch-keeps]')?.textContent).toBe(
      'Keeps: s-11 · lead of r-02 · owner of r-11 · 4 child sessions · worktree parley/w-0054/s-11 · 3 unread',
    );
  });

  it('«Continue the conversation» и подсказка — только у цели с transcript', async () => {
    await open();
    expect(screen.getByText('Continue the conversation (same Claude account family)')).toBeTruthy();
    expect(document.querySelector('[data-transcript-hint]')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    expect(screen.queryByText('Continue the conversation (same Claude account family)')).toBeNull();
    expect(screen.getByText('Handover summary (any provider)')).toBeTruthy();
  });

  it('Continue: carry transcript у цели с transcript; у цели без него — handover', async () => {
    bridge.setHandler('sessions.switchAgent', () => ({ outcome: 'started' as const, carried: 'transcript' as const }));
    await open();
    fireEvent.click(screen.getByLabelText('Continue the conversation (same Claude account family)'));
    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]).toMatchObject({ ref: REF, provider: 'codex', carry: 'handover' });
    expect(calls()[0]?.['force']).toBeUndefined();
  });

  it('blockers — список, кнопка недоступна, вызова нет', async () => {
    await open(options({ blockers: ['The session is closed'] }));
    expect(screen.getByText('The session is closed')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(calls()).toHaveLength(0);
  });

  it('busy: предупреждение и «Stop and continue» — повтор с force и тем же requestId', async () => {
    let first = true;
    bridge.setHandler('sessions.switchAgent', () => {
      if (first) {
        first = false;
        throw encodeIpcError({ code: 'conflict', message: 'The agent is working', data: { reason: 'busy' } });
      }
      return { outcome: 'started' as const, carried: 'handover' as const };
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('button', { name: 'Stop and continue' });
    expect(document.querySelector('[data-switch-busy]')?.textContent).toContain('The agent is working');
    fireEvent.click(screen.getByRole('button', { name: 'Stop and continue' }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[0]?.['force']).toBeUndefined();
    expect(calls()[1]?.['force']).toBe(true);
    expect(calls()[1]?.['requestId']).toBe(calls()[0]?.['requestId']);
    expect(String(calls()[0]?.['requestId'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('held — диалог закрывается', async () => {
    bridge.setHandler('sessions.switchAgent', () => ({ outcome: 'held' as const, carried: 'handover' as const }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('radiogroup', { name: 'Provider' })).toBeNull());
  });
});
