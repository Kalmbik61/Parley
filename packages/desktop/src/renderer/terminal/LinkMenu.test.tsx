/**
 * Меню ссылки терминала (кусок 5.3, спека 8.3): тест 6 брифа.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { Located } from '../../shared/files-types.js';
import type { TabSpec } from '../../shared/layout-types.js';
import { FileBody } from '../files/editor/FileBody.js';
import { useFilesStore } from '../files/store.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { monacoMock } from '../test-utils/monaco-mock.js';
import { makeWork } from '../test-utils/work-fixtures.js';
import { LinkMenu } from './LinkMenu.js';
import type { TerminalLink } from './links.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);

const located: Located = { root: { workKey: 'w', spec: { kind: 'project' } }, relPath: 'src/a.ts', stat: { kind: 'file', size: 1, mtimeMs: 0 } };
const pathLink: TerminalLink = { kind: 'path', absPath: '/p/src/a.ts', located, line: 12 };
const urlLink: TerminalLink = { kind: 'url', url: 'https://example.com/x' };

let bridge: FakeBridge;
let clipboard: string[];

beforeEach(() => {
  bridge = createFakeBridge();
  clipboard = [];
  vi.mocked(toast).mockClear();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => void clipboard.push(text) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(link: TerminalLink, onClose = vi.fn()) {
  render(<LinkMenu bridge={bridge} state={{ link, x: 10, y: 20 }} onClose={onClose} />);
  return onClose;
}

describe('тест 6: LinkMenu', () => {
  it('Reveal in Finder — app.showInFinder с абсолютным путём', async () => {
    open(pathLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }));
    await waitFor(() => expect(bridge.revealedPaths).toEqual(['/p/src/a.ts']));
  });

  it('Open in default app — app.openPath; revealed — тост', async () => {
    bridge.setOpenPathResult('revealed');
    open(pathLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in default app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("This file type doesn't open here — revealed in Finder"));
    expect(bridge.openedPaths).toEqual(['/p/src/a.ts']);
  });

  it('отказ files:denied и failed — тосты по коду, текст ошибки только в консоль', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setOpenPathResult({ error: { code: 'files:denied', message: 'вне корней' } });
    open(pathLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in default app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Path is outside the workspace folders'));
    cleanup();

    bridge.setOpenPathResult({ error: { code: 'failed', message: 'Не удалось открыть' } });
    open(pathLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in default app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't open file: failed."));
    expect(vi.mocked(toast).mock.calls.flat().join(' ')).not.toContain('Не удалось');
    warn.mockRestore();
  });

  it('Copy path — путь в буфере', async () => {
    open(pathLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(clipboard).toEqual(['/p/src/a.ts']));
  });

  it('меню URL: Open in browser — вкладка браузера (9.2b); Open in system browser — externalOpened; Copy link — в буфере', async () => {
    const key = '/tmp/p w-01';
    useLayoutStore.setState({
      activeWorkKey: key,
      layouts: { [key]: { root: { type: 'group', id: 'g1', tabs: [], activeTabId: null }, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [key]: true },
      pending: {},
    });
    open(urlLink);
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in browser' }));
    const layout = useLayoutStore.getState().layouts[key];
    expect(layout === undefined ? [] : groups(layout)[0]?.tabs).toMatchObject([{ kind: 'browser', url: 'https://example.com/x' }]);
    expect(bridge.externalOpened).toEqual([]);
    cleanup();
    open(urlLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in system browser' }));
    expect(bridge.externalOpened).toEqual(['https://example.com/x']);
    cleanup();
    open(urlLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(clipboard).toEqual(['https://example.com/x']));
  });

  it('Open in editor — вкладка file по located, курсор на строке и колонке (кусок 7.3b)', async () => {
    const W = '/p w-01';
    monacoMock.reset();
    useFilesStore.setState({ buffers: {}, reveals: {} });
    useLayoutStore.setState({
      activeWorkKey: W,
      layouts: { [W]: { root: { type: 'group', id: 'g1', tabs: [], activeTabId: null }, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [W]: true },
      pending: {},
      history: EMPTY_HISTORY,
      mru: {},
    });
    const root = { workKey: W, spec: { kind: 'project' as const } };
    bridge.setFile(root, 'src/a.ts', { text: 'a\nb\n', mtimeMs: 1, size: 4, binary: false, utf8: true, readOnlyReason: null });
    open({ kind: 'path', absPath: '/p/src/a.ts', located: { ...located, root }, line: 2, col: 5 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in editor' }));

    const layout = useLayoutStore.getState().layouts[W];
    if (layout === undefined) throw new Error('нет раскладки');
    const tab = groups(layout)[0]?.tabs[0] as Extract<TabSpec, { kind: 'file' }> | undefined;
    expect(tab).toEqual({ kind: 'file', id: 'file:p:src/a.ts', root: { kind: 'project' }, path: 'src/a.ts' });
    if (tab === undefined) throw new Error('нет вкладки');
    cleanup();
    render(<FileBody bridge={bridge} workKey={W} entry={makeWork('w-01', { projectPath: '/p' })} tab={tab} onClose={() => {}} />);
    await waitFor(() => expect(monacoMock.editors[0]?.position).toEqual({ lineNumber: 2, column: 5 }));
    expect(bridge.openedPaths).toEqual([]);
  });

  it('у ссылки на каталог пункта Open in editor нет', () => {
    open({ kind: 'path', absPath: '/p/src', located: { ...located, relPath: 'src', stat: { kind: 'dir', size: 0, mtimeMs: 0 } } });
    expect(screen.queryByRole('menuitem', { name: 'Open in editor' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Open in default app' })).toBeTruthy();
  });
});
