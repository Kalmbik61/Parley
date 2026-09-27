/**
 * Тест 1 куска 2.4 (часть про саму строку): при `portal` строка вкладок рисуется
 * порталом в `#titlebar-tabs`, а не на своём обычном месте в дереве; без
 * `portal` — на своём месте.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import type { GroupNode } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { TabStrip } from './TabStrip.js';

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
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
    worktree: null,
  };
}

function entry(sessions: WorkSession[], rooms: Room[] = []): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms,
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

const WORK_KEY = '/tmp/p w';

afterEach(() => {
  cleanup();
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

describe('TabStrip — тест 1', () => {
  it('portal: рисуется в #titlebar-tabs, не на своём обычном месте', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }], activeTabId: 'terminal:s-02' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry([session('s-02', 'исполнитель')]);

    const host = document.createElement('div');
    host.id = 'titlebar-tabs';
    document.body.appendChild(host);

    const { container } = render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal />);

    expect(container.querySelector('[data-tab-id]')).toBeNull();
    expect(host.querySelector('[data-tab-id]')).not.toBeNull();
    expect(screen.getByText('S02 исполнитель')).toBeTruthy();

    host.remove();
  });

  it('без portal: рисуется на своём месте', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [{ kind: 'mail', id: 'mail' }], activeTabId: 'mail' };
    useLayoutStore.setState({
      layouts: { [WORK_KEY]: { root: group, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [WORK_KEY]: true },
    });
    const e = entry([]);

    const { container } = render(<TabStrip workKey={WORK_KEY} group={group} entry={e} portal={false} />);
    expect(container.querySelector('[data-tab-id="mail"]')).not.toBeNull();
  });
});
