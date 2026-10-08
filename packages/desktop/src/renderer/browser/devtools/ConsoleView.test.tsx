import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ConsoleEntry } from '../../../shared/browser-devtools.js';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import { ConsoleView } from './ConsoleView.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, type TabDevtools } from './store.js';

const TAB = 'browser:0000c1';
const APP = 'http://localhost:5173/src/app.js';

const BOOM = consoleEntry(1, {
  level: 'error',
  origin: 'exception',
  text: 'Uncaught Error: boom',
  location: { url: APP, line: 10, column: 5 },
  stack: [
    { fn: 'save', url: APP, line: 10, column: 5 },
    { fn: 'click', url: APP, line: 3, column: 1 },
  ],
});
const HELLO = consoleEntry(3, {
  text: "hello {theme: 'dark', items: Array(12)}",
  location: { url: APP, line: 2, column: 1 },
  stack: [{ fn: 'run', url: APP, line: 2, column: 1 }],
});
const ENTRIES: ConsoleEntry[] = [
  BOOM,
  consoleEntry(2, { level: 'warning', text: 'careful', count: 3 }),
  HELLO,
  consoleEntry(4, { level: 'debug', text: 'trace details' }),
];

function seed(patch: Partial<TabDevtools>): void {
  useDevtoolsStore.setState({ tabs: { [TAB]: { ...EMPTY_DEVTOOLS, ...patch } } });
}

function rowIds(): Array<string | null> {
  return [...document.querySelectorAll('[data-console-row]')].map((row) => row.getAttribute('data-console-row'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useDevtoolsStore.setState({ tabs: {} });
});

describe('ConsoleView (спека 4.3)', () => {
  it('строки: уровень, предпросмотр объекта, ×N, источник файл:строка с полным адресом в подсказке; Debug скрыт', () => {
    seed({ console: ENTRIES });
    render(<ConsoleView tabId={TAB} />);
    expect([...document.querySelectorAll('[data-console-row]')].map((row) => row.getAttribute('data-level'))).toEqual(['error', 'warning', 'info']);
    expect(screen.getByText("hello {theme: 'dark', items: Array(12)}")).toBeTruthy();
    expect(screen.getByTestId('console-count').textContent).toBe('×3');
    expect(screen.getByText('app.js:2').getAttribute('title')).toBe(APP);
  });

  it('уровни: Debug показывает отладку, Errors прячет ошибки; фильтр — подстрока без учёта регистра', () => {
    seed({ console: ENTRIES });
    render(<ConsoleView tabId={TAB} />);
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    expect(screen.getByText('trace details')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.queryByText('Uncaught Error: boom')).toBeNull();
    expect(screen.getByRole('button', { name: 'Errors' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter' }), { target: { value: 'CAREF' } });
    expect(rowIds()).toEqual(['2']);
  });

  it('ошибка со стеком раскрывается кадрами; многострочное описание — остальными строками; у info раскрытия нет', () => {
    seed({ console: [BOOM, consoleEntry(5, { level: 'error', text: 'Error: broken\n    at x (a.js:1:1)' }), HELLO] });
    render(<ConsoleView tabId={TAB} />);
    const toggles = screen.getAllByRole('button', { name: 'Show stack' });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0] as HTMLElement);
    expect(screen.getByTestId('console-stack').textContent).toBe(`    at save (${APP}:10:5)\n    at click (${APP}:3:1)`);
    fireEvent.click(screen.getByRole('button', { name: 'Hide stack' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Show stack' })[1] as HTMLElement);
    expect(screen.getByTestId('console-stack').textContent).toBe('    at x (a.js:1:1)');
  });

  it('многострочное сообщение любого уровня раскрывается: свёрнуто — первая строка, раскрыто — остальные', () => {
    seed({ console: [consoleEntry(6, { text: 'a\nb' })] });
    render(<ConsoleView tabId={TAB} />);
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.queryByText('b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show stack' }));
    expect(screen.getByTestId('console-stack').textContent).toBe('b');
  });

  it('Copy — текст и стек в буфер; Add to chat — только с колбэком этапа B', () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    seed({ console: [BOOM] });
    const { rerender } = render(<ConsoleView tabId={TAB} />);
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`Uncaught Error: boom\n    at save (${APP}:10:5)\n    at click (${APP}:3:1)`);
    const onAddToChat = vi.fn();
    rerender(<ConsoleView tabId={TAB} onAddToChat={onAddToChat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));
    expect(onAddToChat).toHaveBeenCalledWith(BOOM);
  });

  it('без Preserve log — только текущая страница; с ним — все и разделитель «Navigated to» с адресом документа', () => {
    const entries = [consoleEntry(1, { epoch: 0, text: 'first page' }), consoleEntry(2, { epoch: 1, text: 'second page' })];
    const network = [networkEntry('doc', { epoch: 1, kind: 'document', url: 'http://localhost:5173/next' })];
    seed({ epoch: 1, console: entries, network });
    const { unmount } = render(<ConsoleView tabId={TAB} />);
    expect(screen.queryByText('first page')).toBeNull();
    expect(document.querySelector('[data-console-nav]')).toBeNull();
    unmount();
    seed({ epoch: 1, console: entries, network, preserve: true });
    render(<ConsoleView tabId={TAB} />);
    expect(screen.getByText('first page')).toBeTruthy();
    expect(document.querySelector('[data-console-nav]')?.textContent).toBe('Navigated to http://localhost:5173/next');
    // Длинный адрес документа переносится, лог не получает горизонтальной прокрутки.
    expect(document.querySelector('[data-console-nav]')?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
  });

  it('пусто — No messages', () => {
    seed({});
    render(<ConsoleView tabId={TAB} />);
    expect(screen.getByText('No messages')).toBeTruthy();
  });
});
