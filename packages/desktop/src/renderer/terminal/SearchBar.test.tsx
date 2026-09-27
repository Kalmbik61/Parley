/**
 * Полоса поиска ⌘F (кусок 5.3, спека 8.2): тест 8 брифа. `SearchAddon` — подставной:
 * подсветку и счётчик настоящего аддона проверяет живая приёмка.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SearchAddon } from '@xterm/addon-search';
import { SearchBar } from './SearchBar.js';

afterEach(cleanup);

/** Событие счётчика: у `SearchAddon` 0.15 (под xterm 5) именованного типа `ISearchResultChangeEvent` нет. */
type ResultsEvent = { resultIndex: number; resultCount: number };

function fakeSearch() {
  let listener: ((event: ResultsEvent) => void) | null = null;
  const addon = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: (next: (event: ResultsEvent) => void) => {
      listener = next;
      return { dispose: () => (listener = null) };
    },
  };
  return { addon, search: addon as unknown as SearchAddon, fire: (event: ResultsEvent) => listener?.(event) };
}

const DECORATIONS = {
  matchBackground: '#f0c674',
  matchOverviewRuler: '#f0c674',
  activeMatchBackground: '#ff9e3b',
  activeMatchColorOverviewRuler: '#ff9e3b',
};

describe('тест 8: SearchBar', () => {
  it('aria-label кнопок и фокус в поле', () => {
    const { search } = fakeSearch();
    render(<SearchBar search={search} onClose={() => {}} />);
    for (const label of ['Match case', 'Use regular expression', 'Previous match', 'Next match', 'Close']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Find…'));
  });

  it('неверная регулярка ( — рамка ошибки, findNext не вызван', () => {
    const { addon, search } = fakeSearch();
    render(<SearchBar search={search} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    const input = screen.getByPlaceholderText('Find…');
    fireEvent.change(input, { target: { value: '(' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.className).toContain('border-red-500');
    expect(addon.findNext).not.toHaveBeenCalled();
  });

  it('Enter — findNext с «Aa», «.*» и decorations; ⇧Enter — findPrevious; ↑ и ↓', () => {
    const { addon, search } = fakeSearch();
    render(<SearchBar search={search} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    const input = screen.getByPlaceholderText('Find…');
    fireEvent.change(input, { target: { value: 'a.c' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const options = { caseSensitive: true, regex: true, decorations: DECORATIONS };
    expect(addon.findNext).toHaveBeenLastCalledWith('a.c', options);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(addon.findPrevious).toHaveBeenLastCalledWith('a.c', options);
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(addon.findPrevious).toHaveBeenCalledTimes(2);
    expect(addon.findNext).toHaveBeenCalledTimes(2);
  });

  it('счётчик N/M, свыше 1000 — 1000+; исключение аддона — 0/0', () => {
    const { addon, search, fire } = fakeSearch();
    render(<SearchBar search={search} onClose={() => {}} />);
    // Живая область есть до первого счёта: иначе скринридер не объявит первое N/M.
    expect(screen.getByTestId('terminal-search-count').getAttribute('aria-live')).toBe('polite');
    act(() => fire({ resultIndex: 2, resultCount: 17 }));
    expect(screen.getByTestId('terminal-search-count').textContent).toBe('3/17');
    expect(screen.getByTestId('terminal-search-count').getAttribute('aria-live')).toBe('polite');
    act(() => fire({ resultIndex: 0, resultCount: 1001 }));
    expect(screen.getByTestId('terminal-search-count').textContent).toBe('1/1000+');

    addon.findNext.mockImplementation(() => {
      throw new Error('proposed api');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = screen.getByPlaceholderText('Find…');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('terminal-search-count').textContent).toBe('0/0');
    warn.mockRestore();
  });

  it('× и Esc закрывают: onClose и снятие декораций', () => {
    const { addon, search } = fakeSearch();
    const onClose = vi.fn();
    render(<SearchBar search={search} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(screen.getByPlaceholderText('Find…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(addon.clearDecorations).toHaveBeenCalledTimes(2);
  });
});
