/**
 * Меню терминала по правой кнопке (кусок 5.3, спека 8.4): тест 7 брифа — на живой
 * `TerminalSurface`, чтобы проверить и пункты, и их связь с xterm, мостом и раскладкой.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionRef } from '@harnas/protocol';
import { usePaletteStore } from '../palette/store.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { xtermMock } from '../test-utils/xterm-mock.js';
import { TerminalSurface } from './TerminalSurface.js';

vi.mock('@xterm/xterm', async () => (await import('../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: () => {} })) }));
vi.mock('@xterm/addon-search', async () => (await import('../test-utils/xterm-mock.js')).searchModule);
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({ onContextLoss: () => {}, dispose: () => {} })),
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };
let bridge: FakeBridge;
let clipboard: string[];

beforeEach(() => {
  xtermMock.reset();
  clipboard = [];
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => void clipboard.push(text) } });
  bridge = createFakeBridge();
  bridge.setHandler('pty.attach', () => ({ snapshot: '', cols: 80, rows: 24 }));
  bridge.setHandler('pty.detach', () => ({ ok: true as const }));
  usePaletteStore.setState({ open: false, mode: 'default', query: '' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openMenu(selection = ''): Promise<void> {
  render(<TerminalSurface bridge={bridge} sessionRef={ref} tabId="terminal:s-01" groupId="g-1" visible fontFamily="Menlo" fontSize={13} />);
  await act(async () => {
    await Promise.resolve();
  });
  const term = xtermMock.terminals[0];
  if (term !== undefined) term.selection = selection;
  fireEvent.contextMenu(screen.getByTestId('terminal-surface-pad'));
}

const item = (name: string): HTMLElement => screen.getByRole('menuitem', { name });

/** Пункт меню выполняется после закрытия — в onCloseAutoFocus, из setTimeout(0) Radix. */
async function closeTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('тест 7: TerminalContextMenu', () => {
  it('семь пунктов по порядку спеки 8.4; Copy — только при выделении', async () => {
    await openMenu('picked');
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Copy',
      'Paste',
      'Select all',
      'Clear',
      'Find',
      'Split right',
      'Split down',
    ]);
    fireEvent.click(item('Copy'));
    await closeTimers();
    expect(clipboard).toEqual(['picked']);
    cleanup();

    await openMenu('');
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).toBeNull();
    expect(screen.getAllByRole('menuitem')).toHaveLength(6);
  });

  it('Paste фокусирует терминал и пишет запись в pastes', async () => {
    await openMenu();
    fireEvent.click(item('Paste'));
    await closeTimers();
    expect(xtermMock.callsOf('focus', 0)).toHaveLength(1);
    expect(bridge.pastes).toHaveLength(1);
  });

  it('Select all — selectAll; Clear — clear без pty.input', async () => {
    await openMenu();
    fireEvent.click(item('Select all'));
    await closeTimers();
    expect(xtermMock.callsOf('selectAll', 0)).toHaveLength(1);
    fireEvent.contextMenu(screen.getByTestId('terminal-surface-pad'));
    fireEvent.click(item('Clear'));
    await closeTimers();
    expect(xtermMock.callsOf('clear', 0)).toHaveLength(1);
    expect(bridge.notified.filter((n) => n.method === 'pty.input')).toEqual([]);
  });

  it('Find открывает полосу поиска', async () => {
    await openMenu();
    fireEvent.click(item('Find'));
    await closeTimers();
    expect(screen.getByPlaceholderText('Find…')).toBeTruthy();
  });

  it('Split right — палитра в режиме splitRight (openWith, кусок 6.2)', async () => {
    await openMenu();
    fireEvent.click(item('Split right'));
    await closeTimers();
    expect(usePaletteStore.getState()).toMatchObject({ open: true, mode: 'splitRight' });
  });
});

/**
 * Раунд fix-main-r1, п.2: Radix при закрытии меню возвращает фокус туда, где он был до правого
 * клика, через setTimeout(0) — Paste и Find не должны его отдавать.
 */
describe('фокус после Paste и Find', () => {
  /** Поле ввода xterm: настоящий фейк только пишет focus() в журнал, здесь он двигает фокус. */
  function wireXtermTextarea(): void {
    xtermMock.onOpen = (element) => {
      const textarea = document.createElement('textarea');
      textarea.className = 'xterm-helper-textarea';
      element.appendChild(textarea);
    };
    xtermMock.onCall = (term, method) => {
      if (method === 'focus') term.element?.querySelector('textarea')?.focus();
    };
  }

  async function openMenuWithFocusElsewhere(): Promise<HTMLButtonElement> {
    wireXtermTextarea();
    const other = document.createElement('button');
    other.textContent = 'sidebar';
    document.body.appendChild(other);
    await openMenu();
    other.focus();
    // Фокус до правого клика — вне терминала (так его и запомнит FocusScope меню).
    fireEvent.contextMenu(screen.getByTestId('terminal-surface-pad'));
    return other;
  }

  it('Paste: фокус в терминале до app.paste() и остаётся там после закрытия меню', async () => {
    const other = await openMenuWithFocusElsewhere();
    const focusAtPaste: (Element | null)[] = [];
    const originalPaste = bridge.app.paste;
    bridge.app.paste = () => {
      focusAtPaste.push(document.activeElement);
      originalPaste();
    };
    fireEvent.click(item('Paste'));
    await closeTimers();
    const textarea = xtermMock.terminals[0]?.element?.querySelector('textarea');
    expect(textarea).toBeTruthy();
    expect(focusAtPaste).toEqual([textarea]);
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(other);
    other.remove();
  });

  it('Find: фокус в поле поиска и остаётся там после закрытия меню', async () => {
    const other = await openMenuWithFocusElsewhere();
    fireEvent.click(item('Find'));
    await closeTimers();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Find…'));
    other.remove();
  });

  it('Find при уже открытой полосе: фокус снова в поле', async () => {
    const other = await openMenuWithFocusElsewhere();
    fireEvent.click(item('Find'));
    await closeTimers();
    other.focus();
    fireEvent.contextMenu(screen.getByTestId('terminal-surface-pad'));
    fireEvent.click(item('Find'));
    await closeTimers();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Find…'));
    other.remove();
  });
});
