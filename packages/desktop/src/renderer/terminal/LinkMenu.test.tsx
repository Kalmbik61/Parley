/**
 * Меню ссылки терминала (кусок 5.3, спека 8.3): тест 6 брифа.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { Located } from '../../shared/files-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { LinkMenu } from './LinkMenu.js';
import type { TerminalLink } from './links.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

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

  it('меню URL: Open in browser — адрес в externalOpened; Copy link — в буфере', async () => {
    open(urlLink);
    expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in browser' }));
    expect(bridge.externalOpened).toEqual(['https://example.com/x']);
    cleanup();
    open(urlLink);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(clipboard).toEqual(['https://example.com/x']));
  });
});
