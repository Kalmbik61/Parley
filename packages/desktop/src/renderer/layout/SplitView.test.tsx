/**
 * Тесты 9 и 16 куска 2.4: во время перетаскивания `setRatio` не зовётся, на
 * отпускании — один раз с посчитанной долей (размеры подставлены —
 * `getBoundingClientRect` замокан); при нулевом размере сплита (jsdom без
 * мока) отпускание оставляет раскладку той же ссылкой, и в стиле DOM нет `NaN`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkEntry } from '@parley/core';
import type { GroupNode, SplitNode } from '../../shared/layout-types.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { EMPTY_HISTORY } from './history.js';
import { LayoutBodyContext } from './GroupView.js';
import { useLayoutStore } from './store.js';
import { SplitView } from './SplitView.js';

const WORK_KEY = '/tmp/p w';

function group(id: string, tabId: string): GroupNode {
  return { type: 'group', id, tabs: [{ kind: 'terminal', id: tabId, sessionId: tabId }], activeTabId: tabId };
}

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

function setLayout(root: SplitNode): void {
  useLayoutStore.setState({
    activeWorkKey: WORK_KEY,
    layouts: { [WORK_KEY]: { root, activeGroupId: root.children[0].id, closedTabs: [] } },
    hydrated: { [WORK_KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

function renderSplit(node: SplitNode): void {
  const bridge = createFakeBridge();
  render(
    <LayoutBodyContext.Provider value={{ bridge, fontFamily: 'Menlo', fontSize: 13, active: true, sendDeps: { bridge, session: () => null, openSession: () => {} } }}>
      <SplitView workKey={WORK_KEY} node={node} entry={entry()} singleGroup={false} />
    </LayoutBodyContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

describe('SplitView — тест 9', () => {
  it('во время движения setRatio (apply) не зовётся; на отпускании — один раз', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const node: SplitNode = { type: 'split', id: 's1', direction: 'row', ratio: 0.5, children: [group('g1', 'a'), group('g2', 'b')] };
    setLayout(node);
    const applySpy = vi.spyOn(useLayoutStore.getState(), 'apply');

    renderSplit(node);
    const divider = screen.getByRole('separator');

    fireEvent.pointerDown(divider, { clientX: 400 });
    fireEvent.pointerMove(divider, { clientX: 450 });
    fireEvent.pointerMove(divider, { clientX: 500 });
    expect(applySpy).not.toHaveBeenCalled();

    fireEvent.pointerUp(divider, { clientX: 500 });
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy.mock.calls[0]?.[0]).toBe(WORK_KEY);

    const newRoot = useLayoutStore.getState().layouts[WORK_KEY]?.root;
    expect(newRoot?.type === 'split' ? newRoot.ratio : null).toBeCloseTo(0.625, 5);
  });
});

describe('SplitView — тест 16', () => {
  it('нулевой размер сплита: отпускание оставляет раскладку той же ссылкой, без NaN в стиле', async () => {
    const node: SplitNode = { type: 'split', id: 's1', direction: 'row', ratio: 0.5, children: [group('g1', 'a'), group('g2', 'b')] };
    setLayout(node);
    const before = useLayoutStore.getState().layouts[WORK_KEY];

    renderSplit(node);
    const divider = screen.getByRole('separator');
    const firstPane = screen.getByTestId('split-first');
    expect(firstPane.style.flexBasis).toBe('50%');

    fireEvent.pointerDown(divider, { clientX: 100 });
    fireEvent.pointerMove(divider, { clientX: 150 });
    // Ждём кадр rAF, которым `SplitView` пишет долю в DOM — без ожидания
    // проверка ниже была бы верна и без охраны NaN (кадр ещё не случился).
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(firstPane.style.flexBasis).not.toContain('NaN');
    expect(firstPane.style.flexBasis).toBe('50%'); // нечисловая доля — DOM не тронут вовсе

    fireEvent.pointerUp(divider, { clientX: 150 });
    expect(firstPane.style.flexBasis).not.toContain('NaN');

    const after = useLayoutStore.getState().layouts[WORK_KEY];
    expect(after).toBe(before);
  });
});
