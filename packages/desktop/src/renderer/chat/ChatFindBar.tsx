/**
 * Полоса поиска ⌘F по ленте Chat (план 2026-11-01, задача 9): 32px поверх правого верхнего угла ленты, поле,
 * счётчик `n/m` (`0/0`, когда нет совпадений; больше `FIND_LIMIT` — `1000+`), ↑ ↓ и ×. Enter — следующее, ⇧Enter —
 * предыдущее, по кругу; Esc и × закрывают. Вид — как у полосы терминала (`terminal/SearchBar.tsx`), без «Aa» и regex.
 *
 * Ищет `searchFeed` по модели ленты, поэтому находит и то, чего нет в DOM (свёрнутые ходы, вывод вызовов, вне экрана).
 * Куда прыгнуть, лента узнаёт из `onChange`: у цели свой `nonce`, растёт на каждый шаг человека (ввод, Enter, стрелки),
 * поэтому повторный Enter на единственном совпадении прокручивает снова, а рост стримящегося текста — нет. Текущее
 * совпадение держится по (элемент, часть, номер): лента растёт, а выбор остаётся на месте; пропало — ближайший индекс.
 * Номер живёт здесь и теряется вместе с полосой; запрос ещё и отдаётся наружу (`onQueryChange`), а вернувшийся
 * ChatView кладёт его обратно через `initialQuery`: полоса переживает перемонтирование (вкладка, раскладка).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { FeedItem } from '@parley/core';
import { S } from '../../shared/strings.js';
import { FIND_LIMIT, searchFeed, type FindMatch, type FindPart } from './find.js';

/** Что полоса сообщает ленте: запрос для подсветки и куда прокрутить. */
export interface FindView {
  query: string;
  target: {
    itemId: string;
    /** Часть элемента: от неё зависит, нужно ли раскрывать вызов или карточку агента. */
    part: FindPart;
    /** Номер текущего совпадения среди совпадений этого элемента: по нему подсвечивается вхождение в строке. */
    itemNth: number;
    nonce: number;
  } | null;
}

export interface ChatFindBarProps {
  items: readonly FeedItem[];
  /** Растёт на каждый ⌘F: открытая полоса берёт фокус и выделяет запрос. */
  focusNonce: number;
  onChange(view: FindView): void;
  /** Запрос, с которым полоса открывается (после перемонтирования — прежний); номер совпадения начинается с первого. */
  initialQuery?: string;
  /** Запрос изменился (ввод человека). */
  onQueryChange?(query: string): void;
  /** Закрыть полосу; фокус в поле сообщения возвращает вызывающий. */
  onClose(): void;
}

interface Cursor {
  index: number;
  key: FindMatch | null;
}

const same = (a: FindMatch, b: FindMatch): boolean => a.itemId === b.itemId && a.part === b.part && a.nth === b.nth;

export function ChatFindBar({ items, focusNonce, onChange, initialQuery = '', onQueryChange, onClose }: ChatFindBarProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState<Cursor>({ index: 0, key: null });
  const [step, setStep] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { matches, capped } = useMemo(() => searchFeed(items, query), [items, query]);

  const keyed = cursor.key === null ? -1 : matches.findIndex((match) => same(match, cursor.key!));
  const index = matches.length === 0 ? -1 : keyed !== -1 ? keyed : Math.min(cursor.index, matches.length - 1);
  const current = index === -1 ? null : matches[index]!;
  const itemNth = current === null ? 0 : matches.slice(0, index).filter((match) => match.itemId === current.itemId).length;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const targetItemId = current?.itemId ?? null;
  const targetPart = current?.part ?? null;
  useEffect(() => {
    onChangeRef.current({
      query,
      target: targetItemId === null || targetPart === null ? null : { itemId: targetItemId, part: targetPart, itemNth, nonce: step },
    });
  }, [query, targetItemId, targetPart, itemNth, step]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  const go = (delta: 1 | -1): void => {
    if (matches.length === 0) return;
    const next = (index + delta + matches.length) % matches.length;
    setCursor({ index: next, key: matches[next]! });
    setStep((value) => value + 1);
  };

  const counter = `${current === null ? 0 : index + 1}/${capped ? `${FIND_LIMIT}+` : matches.length}`;
  const arrow = 'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent';

  return (
    <div
      role="search"
      aria-label={S.chat.find.label}
      data-testid="chat-find"
      className="absolute right-2 top-2 z-10 flex h-8 items-center gap-1 rounded border border-border bg-popover px-2"
    >
      <input
        ref={inputRef}
        autoFocus
        value={query}
        aria-label={S.chat.find.label}
        placeholder={S.chat.find.placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          onQueryChange?.(event.target.value);
          setCursor({ index: 0, key: null });
          setStep((value) => value + 1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        className="h-6 w-48 rounded border border-transparent bg-transparent px-1 text-sm text-popover-foreground outline-none"
      />
      {/* Живая область стоит всегда: появись она вместе с первым счётом, скринридер его не объявил бы. */}
      <span data-testid="chat-find-count" aria-live="polite" className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
        {counter}
      </span>
      <button type="button" aria-label={S.terminal.previousMatch} className={arrow} onClick={() => go(-1)}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.terminal.nextMatch} className={arrow} onClick={() => go(1)}>
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.common.close} className={arrow} onClick={onClose}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
