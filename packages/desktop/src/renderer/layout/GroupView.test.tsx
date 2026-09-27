/**
 * Тесты 8 и 12 куска 2.4: вкладка удалённой сессии показывает `MissingBody` и
 * закрывается по «Закрыть»; пустая корневая группа показывает подсказку.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkEntry } from '@harnas/core';
import type { GroupNode } from '../../shared/layout-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';
import { GroupView } from './GroupView.js';
import { LayoutBodyContext } from './GroupView.js';

function entry(): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions: [],
      messages: [],
    },
  };
}

const WORK_KEY = '/tmp/p w';
let bridge: FakeBridge;

function renderGroup(group: GroupNode): void {
  bridge = createFakeBridge();
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root: group, activeGroupId: group.id, closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  render(
    <LayoutBodyContext.Provider value={{ bridge, fontFamily: 'Menlo', fontSize: 13, active: true }}>
      <GroupView workKey={WORK_KEY} group={group} entry={entry()} singleGroup />
    </LayoutBodyContext.Provider>,
  );
}

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

describe('GroupView — тест 8', () => {
  it('вкладка удалённой сессии показывает «Session deleted», «Закрыть» убирает вкладку', async () => {
    const group: GroupNode = {
      type: 'group',
      id: 'g1',
      tabs: [{ kind: 'terminal', id: 'terminal:s-09', sessionId: 's-09' }],
      activeTabId: 'terminal:s-09',
    };
    renderGroup(group);

    expect(screen.getByText('Session deleted')).toBeTruthy();
    // Крестик самой вкладки тоже называется «Close» (aria-label) — берём кнопку
    // MissingBody по видимому тексту, а не по доступному имени.
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    const missingBodyClose = closeButtons.find((button) => button.textContent === 'Close');
    if (missingBodyClose === undefined) throw new Error('кнопка «Закрыть» MissingBody не найдена');
    fireEvent.click(missingBodyClose);

    await waitFor(() => {
      const root = useLayoutStore.getState().layouts[WORK_KEY]?.root;
      expect(root?.type === 'group' ? root.tabs : null).toEqual([]);
    });
  });
});

describe('GroupView — тест 12', () => {
  it('пустая корневая группа показывает подсказку', () => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [], activeTabId: null };
    renderGroup(group);

    expect(screen.getByText('Open a session from the sidebar, ⌘T for a new session')).toBeTruthy();
  });
});
