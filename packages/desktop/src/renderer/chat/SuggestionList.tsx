/**
 * Попап подсказок над полем ввода «Chat» (живая проверка 2026-10-02): простой список под `role="listbox"`
 * без своего поля — печатает человек в textarea, выбор и приём ведёт `Composer` (↑/↓, Enter/Tab, Esc).
 * Клик принимает строку; `mousedown` не отбирает фокус у textarea.
 */

import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn.js';
import { S } from '../../shared/strings.js';
import type { SuggestionItem } from './use-suggestions.js';

export interface SuggestionListProps {
  items: readonly SuggestionItem[];
  selected: number;
  onSelect: (index: number) => void;
  onAccept: (item: SuggestionItem) => void;
}

export function SuggestionList({ items, selected, onSelect, onAccept }: SuggestionListProps): JSX.Element {
  const current = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // В jsdom метода нет.
    current.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, items]);
  return (
    <div
      role="listbox"
      id="chat-suggestions"
      aria-label={S.chat.suggestions.label}
      data-testid="chat-suggestions"
      className="absolute bottom-full left-4 right-4 z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((item, index) => (
        <div
          key={item.id}
          ref={index === selected ? current : undefined}
          role="option"
          aria-selected={index === selected}
          data-testid="chat-suggestion"
          data-value={item.insert}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onSelect(index)}
          onClick={() => onAccept(item)}
          className={cn('flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1.5 text-sm', index === selected && 'bg-accent text-accent-foreground')}
        >
          <span className="shrink-0 font-mono text-xs">{item.label}</span>
          {item.description === undefined ? null : <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.description}</span>}
          {item.tag === undefined ? null : <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{item.tag}</span>}
        </div>
      ))}
    </div>
  );
}
