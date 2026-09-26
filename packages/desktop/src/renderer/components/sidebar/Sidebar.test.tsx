import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { WorkEntry, WorkSession } from '@harnas/core';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useActivityStore } from '../../store/activity.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { Sidebar } from './Sidebar.js';

function session(id: string, label: string, status: WorkSession['status'] = 'active'): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    status,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function work(id: string, createdAt: string, title: string, sessions: WorkSession[]): WorkEntry {
  return {
    projectPath: `/tmp/${id}`,
    map: {
      schemaVersion: 1,
      work: { id, title, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions,
      messages: [],
    },
  };
}

afterEach(cleanup);

beforeEach(() => {
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useUiStore.setState({
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false },
    lastSessionByWork: {},
  });
});

describe('Sidebar', () => {
  it('номера 1…3 по порядку создания, у выбранной сессии есть строка метрик', () => {
    const w1 = work('w-01', '2026-01-01', 'Первая', [session('s-01', 'план')]);
    const w2 = work('w-02', '2026-01-02', 'Вторая', [session('s-02', 'бэкенд')]);
    const w3 = work('w-03', '2026-01-03', 'Третья', [session('s-03', 'фронт')]);
    useWorksStore.setState({ entries: [w3, w1, w2], branches: {}, loading: false, error: null });
    useActivityStore.setState({
      byRef: {
        '/tmp/w-02\u0000w-02\u0000s-02': {
          ref: { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-02' },
          activity: { activity: 'working', subagents: 1, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
          metrics: { tokensIn: 1200, tokensOut: 845, durationMs: 12 * 60_000, unread: 1, subagents: 1, model: 'sonnet' },
        },
      },
    });
    useUiStore.setState({
      selectedRef: { projectPath: '/tmp/w-02', workId: 'w-02', sessionId: 's-02' },
      selectedWorkKey: '/tmp/w-02 w-02',
      windowFocused: true,
      wakePaused: null,
      dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false },
      lastSessionByWork: {},
    });

    render(<Sidebar bridge={createFakeBridge()} onOpenSession={() => {}} />);

    const numbers = screen.getAllByText(/^[123]$/).map((el) => el.textContent);
    expect(numbers).toEqual(['1', '2', '3']);

    expect(screen.getByText('↑1.2к ↓845 · 12м · ▤1 · ⋮1')).toBeTruthy();
  });

  it('длинный ярлык (200 знаков) не ломает ширину — обрезается через CSS truncate', () => {
    const longLabel = 'я'.repeat(200);
    useWorksStore.setState({
      entries: [work('w-01', '2026-01-01', 'Работа', [session('s-01', longLabel)])],
      branches: {},
      loading: false,
      error: null,
    });

    render(<Sidebar bridge={createFakeBridge()} onOpenSession={() => {}} />);

    const row = screen.getByText(`S01 ${longLabel}`);
    expect(row.className).toContain('truncate');
    // Родительская строка не растягивается по контенту — `min-w-0` пускает truncate в дело.
    expect(row.parentElement?.className).toContain('min-w-0');
  });

  it('«Работ пока нет» — пустой список', () => {
    render(<Sidebar bridge={createFakeBridge()} onOpenSession={() => {}} />);
    expect(screen.getByText('Работ пока нет')).toBeTruthy();
  });
});
