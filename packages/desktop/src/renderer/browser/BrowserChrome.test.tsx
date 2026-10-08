import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BrowserChrome, type BrowserChromeProps } from './BrowserChrome.js';

afterEach(cleanup);

function renderChrome(extra: Partial<BrowserChromeProps> = {}): BrowserChromeProps {
  const props: BrowserChromeProps = {
    url: 'http://localhost:5173/',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    live: true,
    focusAddress: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onStop: vi.fn(),
    onNavigate: vi.fn(),
    onDevTools: vi.fn(),
    picking: false,
    onDesignMode: vi.fn(),
    viewport: null,
    onViewport: vi.fn(),
    devtoolsOpen: false,
    counters: { errors: 0, warnings: 0 },
    onToggleDevtools: vi.fn(),
    onClearDevtools: vi.fn(),
    ...extra,
  };
  render(<BrowserChrome {...props} />);
  return props;
}

describe('BrowserChrome (спека 2026-10-07, 4.1)', () => {
  it('порядок: назад, вперёд, обновить, адрес, размер, ⌖, консоль, ⋯; кнопки «DevTools» больше нет', () => {
    renderChrome();
    const chrome = screen.getByTestId('browser-chrome');
    expect(within(chrome).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Back',
      'Forward',
      'Reload',
      'Viewport size',
      'Design Mode',
      'Console and network',
      'More browser actions',
    ]);
    const address = screen.getByRole('textbox', { name: 'Address' });
    const size = screen.getByRole('button', { name: 'Viewport size' });
    expect(address.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'DevTools' })).toBeNull();
  });

  it('счётчики: нули не показываются; ошибки и предупреждения — числа с подсказкой; кнопка показывает и прячет панель', () => {
    const props = renderChrome({ counters: { errors: 3, warnings: 1 }, devtoolsOpen: true });
    expect(screen.getByTestId('devtools-errors').textContent).toBe('3');
    expect(screen.getByTestId('devtools-errors').getAttribute('title')).toBe('3 errors');
    expect(screen.getByTestId('devtools-warnings').textContent).toBe('1');
    expect(screen.getByTestId('devtools-warnings').getAttribute('title')).toBe('1 warning');
    const toggle = screen.getByRole('button', { name: 'Console and network' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(props.onToggleDevtools).toHaveBeenCalledTimes(1);
    cleanup();
    renderChrome();
    expect(screen.queryByTestId('devtools-errors')).toBeNull();
    expect(screen.queryByTestId('devtools-warnings')).toBeNull();
  });

  it('⋯: Open full DevTools и Clear console and network', () => {
    const props = renderChrome();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open full DevTools' }));
    expect(props.onDevTools).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More browser actions' }), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Clear console and network' }));
    expect(props.onClearDevtools).toHaveBeenCalledTimes(1);
  });

  it('без страницы размер, консоль и ⋯ неактивны', () => {
    renderChrome({ live: false });
    for (const name of ['Viewport size', 'Console and network', 'More browser actions']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
  });

  it('строка на 800 px (Фокус ревью 2): сжимается только адрес; прочее — значки с aria-label и shrink-0; подпись размера прячет контейнерный запрос', () => {
    renderChrome({ viewport: { preset: 'mobile-m', rotated: false, dpr: 2 }, counters: { errors: 12, warnings: 3 } });
    const chrome = screen.getByTestId('browser-chrome');
    expect(chrome.className).toContain('@container');
    const address = screen.getByRole('textbox', { name: 'Address' }).parentElement as HTMLElement;
    expect(address.className).toMatch(/\bmin-w-0\b/);
    expect(address.className).toMatch(/\bflex-1\b/);
    for (const button of within(chrome).getAllByRole('button')) {
      expect(button.getAttribute('aria-label'), button.outerHTML).not.toBeNull();
      expect(button.className, button.getAttribute('aria-label') ?? '').toMatch(/\bshrink-0\b/);
    }
    expect(chrome.querySelector('[data-viewport-name]')?.className).toContain('@min-[560px]:inline');
  });
});
