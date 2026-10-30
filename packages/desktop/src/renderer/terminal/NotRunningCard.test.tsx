import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkSession } from '@parley/core';
import { S } from '../../shared/strings.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useSwitchAgentStore } from '../store/switch-agent.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { NotRunningCard } from './NotRunningCard.js';

const REF = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const CLAUDE = { id: 'claude', label: 'Claude Code', available: true, version: null, limits: null } as never;
const stuck = (kind: 'limit' | 'sign-in') => ({ kind, since: '2026-10-30T10:00:00.000Z', detail: null, resetsAt: null, window: null, account: null }) as never;

function show(session: WorkSession, methods: string[] = ['sessions.switchAgent']): { onResume: ReturnType<typeof vi.fn> } {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.0.0-test', methods } });
  useProvidersStore.setState({ providers: [CLAUDE], loaded: true });
  useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/p', sessions: [session] })], branches: {}, loading: false, error: null });
  const onResume = vi.fn();
  render(<NotRunningCard sessionRef={REF} onResume={onResume} />);
  return { onResume };
}

afterEach(() => {
  cleanup();
  useHostStore.setState({ status: { state: 'connecting' } });
  useProvidersStore.setState({ providers: [], loaded: false });
  useSwitchAgentStore.setState({ ref: null });
});

describe('NotRunningCard — замена агента', () => {
  it('провайдера нет в списке: «removed from Parley» и замена вместо Resume', () => {
    const { onResume } = show(makeSession('s-01', 'S01', { lifecycle: 'sleeping', provider: 'codex' }));
    expect(screen.getByTestId('terminal-not-running').textContent).toContain('codex was removed from Parley');
    expect(screen.queryByText(S.sidebar.sessionMenu.resume)).toBeNull();
    fireEvent.click(screen.getByText(S.chat.switchBanner.action));
    expect(useSwitchAgentStore.getState().ref).toEqual(REF);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('спящая в limit/sign-in: рядом с Resume вторая кнопка', () => {
    show(makeSession('s-01', 'S01', { lifecycle: 'sleeping', stuck: stuck('limit') }));
    expect(screen.getByText(S.sidebar.sessionMenu.resume)).not.toBeNull();
    fireEvent.click(screen.getByText(S.chat.switchBanner.action));
    expect(useSwitchAgentStore.getState().ref).toEqual(REF);
  });

  it('без sessions.switchAgent и у сессии движка autonomous замены нет', () => {
    show(makeSession('s-01', 'S01', { lifecycle: 'sleeping', provider: 'codex' }), []);
    expect(screen.queryByText(S.chat.switchBanner.action)).toBeNull();
    cleanup();
    show(makeSession('s-01', 'S01', { lifecycle: 'sleeping', stuck: stuck('sign-in'), workspace: { kind: 'clone', path: '/x' } } as never));
    expect(screen.queryByText(S.chat.switchBanner.action)).toBeNull();
    expect(screen.getByText(S.sidebar.sessionMenu.resume)).not.toBeNull();
  });
});
