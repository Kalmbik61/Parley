import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { DevtoolsSnapshot } from '../../../shared/browser-devtools.js';
import { consoleEntry, devtoolsBatch, networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useDevtoolsStore } from './store.js';
import { useDevtoolsFeed } from './use-devtools-feed.js';

const TAB = 'browser:abc123';

afterEach(() => {
  cleanup();
  useDevtoolsStore.setState({ tabs: {} });
});

describe('useDevtoolsFeed — смена гостя той же вкладки (ревью задачи 9)', () => {
  it('новый гость начинает номера с 1 без reset: ранняя пачка смешивается со старым журналом лишь до снимка, после снимка списки равны ему', async () => {
    const bridge = createFakeBridge();
    const snapshotA: DevtoolsSnapshot = {
      epoch: 0,
      capture: 'on',
      console: [consoleEntry(1, { text: 'A first' }), consoleEntry(2, { text: 'A second' })],
      network: [networkEntry('a1')],
    };
    const snapshotB: DevtoolsSnapshot = { epoch: 0, capture: 'on', console: [consoleEntry(1, { text: 'B snapshot' })], network: [] };
    let releaseB: (snapshot: DevtoolsSnapshot) => void = () => {};
    bridge.browser.devtoolsSnapshot = vi.fn((webContentsId: number) =>
      webContentsId === 7 ? Promise.resolve(snapshotA) : new Promise<DevtoolsSnapshot>((resolve) => (releaseB = resolve)),
    );

    const hook = renderHook(({ id }) => useDevtoolsFeed(bridge, TAB, id, false), { initialProps: { id: 7 as number | null } });
    await act(async () => {});
    expect(useDevtoolsStore.getState().tabs[TAB]?.console.map((item) => item.text)).toEqual(['A first', 'A second']);

    // Гость B: его снимок ещё в пути, а пачка с номером 1 уже пришла. Пачка гостя A после смены не принимается.
    hook.rerender({ id: 8 });
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 7, console: [consoleEntry(3, { text: 'A stray' })] })));
    act(() => bridge.emitDevtools(devtoolsBatch({ webContentsId: 8, console: [consoleEntry(1, { text: 'B early' })] })));
    expect(useDevtoolsStore.getState().tabs[TAB]?.console.map((item) => item.text)).toEqual(['B early', 'A second']);

    await act(async () => releaseB(snapshotB));
    const tab = useDevtoolsStore.getState().tabs[TAB];
    expect(tab?.console).toEqual(snapshotB.console);
    expect(tab?.network).toEqual(snapshotB.network);
  });
});
