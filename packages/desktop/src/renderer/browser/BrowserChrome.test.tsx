import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    mode: 'off',
    onSelect: vi.fn(),
    onAnnotate: vi.fn(),
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
  it('порядок: назад, вперёд, обновить, адрес, размер, ⌖ Select, ✎ Annotate, консоль, ⋯; кнопки «DevTools» больше нет', () => {
    renderChrome();
    const chrome = screen.getByTestId('browser-chrome');
    expect(within(chrome).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Back',
      'Forward',
      'Reload',
      'Viewport size',
      'Select',
      'Annotate',
      'Console and network',
      'More browser actions',
    ]);
    const address = screen.getByRole('textbox', { name: 'Address' });
    const size = screen.getByRole('button', { name: 'Viewport size' });
    expect(address.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'DevTools' })).toBeNull();
  });

  it('«To» (этап B, спека 4.1): меню цели — после ⌖ Select и ✎ Annotate и до кнопки консоли', () => {
    renderChrome({ targetMenu: <button type="button">To: S01</button> });
    const names = within(screen.getByTestId('browser-chrome'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names.slice(names.indexOf('Select'), names.indexOf('Console and network') + 1)).toEqual(['Select', 'Annotate', 'To: S01', 'Console and network']);
  });

  it('⌖ Select (этап B, спека 4.6): подсвечена только в режиме select; клик — onSelect', () => {
    const props = renderChrome({ mode: 'select' });
    const select = screen.getByRole('button', { name: 'Select' });
    expect(select.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(select);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    cleanup();
    renderChrome({ mode: 'annotate' });
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('✎ Annotate (этап B, спека 4.7): подсвечена только в режиме annotate; клик — onAnnotate', () => {
    const props = renderChrome({ mode: 'annotate' });
    const annotate = screen.getByRole('button', { name: 'Annotate' });
    expect(annotate.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(annotate);
    expect(props.onAnnotate).toHaveBeenCalledTimes(1);
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

  it('счётчик не шире 999+: выше 999 — «999+», точное число в подсказке; 999 — как есть', () => {
    renderChrome({ counters: { errors: 12345, warnings: 1000 } });
    expect(screen.getByTestId('devtools-errors').textContent).toBe('999+');
    expect(screen.getByTestId('devtools-errors').getAttribute('title')).toContain('12345');
    expect(screen.getByTestId('devtools-warnings').textContent).toBe('999+');
    expect(screen.getByTestId('devtools-warnings').getAttribute('title')).toContain('1000');
    cleanup();
    renderChrome({ counters: { errors: 999, warnings: 999 } });
    expect(screen.getByTestId('devtools-errors').textContent).toBe('999');
    expect(screen.getByTestId('devtools-warnings').textContent).toBe('999');
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

  it('строка на 800 px (Фокус ревью 2): сжимается только адрес; прочее — значки с aria-label и shrink-0', () => {
    renderChrome({ viewport: { preset: 'mobile-m', rotated: false, dpr: 2 }, counters: { errors: 12, warnings: 3 } });
    const chrome = screen.getByTestId('browser-chrome');
    const address = screen.getByRole('textbox', { name: 'Address' }).parentElement as HTMLElement;
    expect(address.className).toMatch(/\bmin-w-0\b/);
    expect(address.className).toMatch(/\bflex-1\b/);
    for (const button of within(chrome).getAllByRole('button')) {
      expect(button.getAttribute('aria-label'), button.outerHTML).not.toBeNull();
      expect(button.className, button.getAttribute('aria-label') ?? '').toMatch(/\bshrink-0\b/);
    }
  });
});

/**
 * P2 (итоговое ревью этапа B): включённые после `dom-ready` кнопки строки раз в ~40 запусков окна оставались со стилем
 * выключенных (`pointer-events: none`, `opacity: .4`) при `disabled === false` и `:disabled` не подходит. Залипание снимало
 * только `container-type: normal` на строке (замер в живом окне, 2 случая из 80 запусков): Chromium теряет пересчёт
 * `:disabled` у потомков размерного контейнера. Поэтому в строке контейнерных запросов нет, а подпись кнопки размера зависит
 * от ширины строки, которую меряет `ResizeObserver` (порог прежний — 560 px содержимого).
 */
describe('BrowserChrome — без контейнерного запроса (P2)', () => {
  type Entry = { callback: ResizeObserverCallback; target: Element | null; disconnected: boolean };
  const observers: Entry[] = [];

  beforeEach(() => {
    observers.length = 0;
    class ResizeObserverStub {
      private readonly entry: Entry;
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, target: null, disconnected: false };
        observers.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.target = target;
      }
      unobserve(): void {}
      disconnect(): void {
        this.entry.disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Строке сообщили новую ширину содержимого (без отступов — как у контейнерного запроса). */
  function resizeRow(contentWidth: number): void {
    act(() => {
      for (const entry of observers) {
        entry.callback([{ target: entry.target, contentRect: { width: contentWidth } } as ResizeObserverEntry], {} as ResizeObserver);
      }
    });
  }

  const label = (): HTMLElement => screen.getByTestId('browser-chrome').querySelector('[data-viewport-name]') as HTMLElement;

  it('ни строка, ни её потомки не заводят контейнерного запроса: ни `@container`, ни `@min-`, ни `@max-` в разметке', () => {
    renderChrome({ viewport: { preset: 'mobile-m', rotated: false, dpr: 2 }, counters: { errors: 12, warnings: 3 }, targetMenu: <button type="button">To: S01</button> });
    const html = screen.getByTestId('browser-chrome').outerHTML;
    expect(html).not.toContain('@container');
    expect(html).not.toMatch(/@(min|max)-/);
    expect(html).not.toContain('container-type');
  });

  it('подпись размера: строка уже порога (559 px содержимого) — скрыта, 560 и шире — видна; порог пересекают в обе стороны', () => {
    renderChrome({ viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } });
    expect(label().className).toMatch(/\bhidden\b/);
    resizeRow(559);
    expect(label().className).toMatch(/\bhidden\b/);
    resizeRow(560);
    expect(label().className).toMatch(/\binline\b/);
    expect(label().className).not.toMatch(/\bhidden\b/);
    resizeRow(1200);
    expect(label().className).toMatch(/\binline\b/);
    resizeRow(300);
    expect(label().className).toMatch(/\bhidden\b/);
    expect(label().className).not.toMatch(/\binline\b/);
  });

  it('наблюдатель следит за самой строкой и отключается вместе с ней', () => {
    renderChrome();
    const row = screen.getByTestId('browser-chrome');
    expect(observers).toHaveLength(1);
    expect(observers[0]?.target).toBe(row);
    expect(observers[0]?.disconnected).toBe(false);
    cleanup();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it('размер строки не трогает кнопки: включённые остаются включёнными, а выключенные — выключенными', () => {
    renderChrome({ live: true, canGoBack: false });
    resizeRow(700);
    resizeRow(400);
    const buttons = within(screen.getByTestId('browser-chrome')).getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.filter((button) => button.disabled).map((button) => button.getAttribute('aria-label'))).toEqual(['Back', 'Forward']);
  });
});
