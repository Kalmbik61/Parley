/**
 * Полоса поиска ⌘F по терминалу (кусок 5.3, спека 8.2): 32px поверх правого верхнего
 * угла, «Aa» и «.*», счётчик `N/M`, ↑ ↓ и ×. Enter — следующее, ⇧Enter — предыдущее,
 * Esc и × закрывают и возвращают фокус в терминал.
 *
 * Счётчик приходит из `onDidChangeResults` `SearchAddon` 0.16, а тот шлёт его только с
 * `decorations` — отсюда цвета в каждом вызове. Декорации — предлагаемый API xterm 5.5,
 * без `allowProposedApi` (use-terminal) они бросили бы; исключение ловится и
 * показывается как «0/0» — только страховка.
 */

import { forwardRef, useEffect, useState } from 'react';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from 'lucide-react';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';

/** Цвета совпадений читаются на обеих темах (спека 8.2). */
const MATCH = '#f0c674';
const ACTIVE = '#ff9e3b';
/** `SearchAddon` считает совпадения до `highlightLimit` (use-terminal ставит 1001): больше 1000 — «1000+». */
const COUNT_LIMIT = 1000;

export interface SearchBarProps {
  search: SearchAddon | null;
  /** Закрыть полосу; фокус в терминал возвращает вызывающий. */
  onClose(): void;
}

function validRegex(query: string): boolean {
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar({ search, onClose }, inputRef) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const invalid = regex && query !== '' && !validRegex(query);

  useEffect(() => {
    if (search === null) return;
    const subscription = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults({ index: resultIndex, count: resultCount });
    });
    return () => subscription.dispose();
  }, [search]);

  const run = (direction: 'next' | 'previous'): void => {
    if (search === null || query === '' || invalid) return;
    const options: ISearchOptions = {
      caseSensitive,
      regex,
      decorations: {
        matchBackground: MATCH,
        matchOverviewRuler: MATCH,
        activeMatchBackground: ACTIVE,
        activeMatchColorOverviewRuler: ACTIVE,
      },
    };
    try {
      if (direction === 'next') search.findNext(query, options);
      else search.findPrevious(query, options);
    } catch (error) {
      console.warn('[harnas] terminal search', error);
      setResults({ index: -1, count: 0 });
    }
  };

  const close = (): void => {
    try {
      search?.clearDecorations();
    } catch {
      // Декорации не создались — снимать нечего.
    }
    onClose();
  };

  const counter =
    results === null
      ? null
      : `${results.count === 0 ? 0 : results.index + 1}/${results.count > COUNT_LIMIT ? `${COUNT_LIMIT}+` : results.count}`;

  const toggleClass = (on: boolean): string =>
    cn('flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent', on && 'bg-accent text-foreground');

  return (
    <div
      data-testid="terminal-search"
      className="absolute right-2 top-2 z-10 flex h-8 items-center gap-1 rounded border border-border bg-popover px-2"
    >
      <input
        ref={inputRef}
        autoFocus
        value={query}
        aria-invalid={invalid}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            run(event.shiftKey ? 'previous' : 'next');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        placeholder={S.terminal.findPlaceholder}
        className={cn(
          'h-6 w-48 rounded border bg-transparent px-1 text-sm text-popover-foreground outline-none',
          invalid ? 'border-red-500' : 'border-transparent',
        )}
      />
      <button type="button" aria-label={S.terminal.matchCase} aria-pressed={caseSensitive} className={toggleClass(caseSensitive)} onClick={() => setCaseSensitive((v) => !v)}>
        <CaseSensitive className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.terminal.useRegex} aria-pressed={regex} className={toggleClass(regex)} onClick={() => setRegex((v) => !v)}>
        <Regex className="h-4 w-4" />
      </button>
      {counter === null ? null : (
        <span data-testid="terminal-search-count" className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
          {counter}
        </span>
      )}
      <button type="button" aria-label={S.terminal.previousMatch} className={toggleClass(false)} onClick={() => run('previous')}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.terminal.nextMatch} className={toggleClass(false)} onClick={() => run('next')}>
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.common.close} className={toggleClass(false)} onClick={close}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
});
