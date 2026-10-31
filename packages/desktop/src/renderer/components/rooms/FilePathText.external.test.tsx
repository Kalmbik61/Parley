/**
 * Путь вне корней работы в тексте ленты (⌘-клик по пути вне корней, 2026-10-31): `files.locate` зовётся с
 * `{ external: true }`, ссылка по ⌘ открывает вкладку `file` с корнем `external`, внешний каталог — Finder,
 * а не приложение по умолчанию.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Located } from '../../../shared/files-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { useLayoutStore } from '../../layout/store.js';
import { groups } from '../../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { FilePathLinksContext } from './FilePathText.js';
import { RoomMarkdown } from './RoomMarkdown.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const WORK = 'w';
const MODIFIER = { metaKey: true, ctrlKey: true };

const external = (absPath: string, kind: 'file' | 'dir'): Located => ({
  root: { workKey: WORK, spec: { kind: 'external' } },
  relPath: absPath,
  stat: { kind, size: 1, mtimeMs: 0 },
});

afterEach(() => {
  fireEvent.keyUp(window, { key: 'Control' });
  fireEvent.keyUp(window, { key: 'Meta' });
  cleanup();
});

async function mountHeld(text: string, bridge: FakeBridge): Promise<HTMLElement> {
  useLayoutStore.setState({
    activeWorkKey: WORK,
    layouts: { [WORK]: { root: { type: 'group', id: 'g1', tabs: [], activeTabId: null }, activeGroupId: 'g1', closedTabs: [] } },
    hydrated: { [WORK]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
  });
  const { container } = render(
    <FilePathLinksContext.Provider value={{ bridge, workKey: WORK, cwd: '/proj' }}>
      <RoomMarkdown text={text} labelOf={() => null} onOpenExternal={() => {}} />
    </FilePathLinksContext.Provider>,
  );
  await act(async () => {
    fireEvent.keyDown(window, { key: 'Control', ...MODIFIER });
  });
  await act(async () => {
    fireEvent.mouseEnter(container.querySelector('[data-file-path]') as HTMLElement);
  });
  return container;
}

describe('FilePathText — путь вне корней', () => {
  it('locate зовётся с external: true; файл вне корней — ссылка, ⌘-клик открывает вкладку file с корнем external', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated(WORK, '/etc/hosts', external('/etc/hosts', 'file'));
    const container = await mountHeld('см. /etc/hosts', bridge);
    expect(bridge.locateCalls).toEqual([{ workKey: WORK, absPaths: ['/etc/hosts'], options: { external: true } }]);
    const link = container.querySelector('[data-file-link]') as HTMLElement;
    expect(link.textContent).toBe('/etc/hosts');
    fireEvent.click(link, MODIFIER);
    const layout = useLayoutStore.getState().layouts[WORK];
    if (layout === undefined) throw new Error('нет раскладки');
    expect(groups(layout)[0]?.tabs).toMatchObject([{ kind: 'file', root: { kind: 'external' }, path: '/etc/hosts' }]);
    expect(bridge.openedPaths).toEqual([]);
  });

  it('каталог вне корней — app.showInFinder, а не app.openPath', async () => {
    const bridge = createFakeBridge();
    bridge.setLocated(WORK, '/var/log', external('/var/log', 'dir'));
    const container = await mountHeld('/var/log', bridge);
    fireEvent.click(container.querySelector('[data-file-link]') as HTMLElement, MODIFIER);
    await vi.waitFor(() => expect(bridge.revealedPaths).toEqual(['/var/log']));
    expect(bridge.openedPaths).toEqual([]);
  });
});
