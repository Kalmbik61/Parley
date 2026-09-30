/**
 * Полоса поиска по странице вкладки браузера (кусок 9.2b, спека 9.6, 12.5): ⌘F в странице.
 * Ищет main (`browser.find` → `findInPage` гостя) — у рендерера программного доступа к странице
 * нет (спека 12.2). Ввод ищет сразу, Enter / ⇧Enter — следующее и предыдущее, счётчик
 * `active/matches`; Esc и × снимают подсветку (`stopFind`) и закрывают полосу.
 *
 * Отказ `find` и `stopFind` — только в консоль: вкладка могла закрыться между нажатием и ответом,
 * тост об этом был бы шумом.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { HarnasBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';

export interface FindBarProps {
  bridge: HarnasBridge;
  webContentsId: number;
  onClose(): void;
}

/** Запрос до 1000 символов (план, «Числа»). */
const QUERY_LIMIT = 1000;

// Наследство куска 1: на заливке hover `--accent` вторичный текст ниже 4.5:1 — на hover цвет основной.
const BUTTON =
  'flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground';

export function FindBar({ bridge, webContentsId, onClose }: FindBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ matches: number; active: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Ответы приходят асинхронно и могут обогнать друг друга: счётчик — только у последнего запроса.
  const seqRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const find = (text: string, forward: boolean): void => {
    seqRef.current += 1;
    const seq = seqRef.current;
    if (text === '') {
      setResult(null);
      bridge.browser.stopFind(webContentsId).catch((error: unknown) => console.warn('[harnas] browser stopFind', error));
      return;
    }
    bridge.browser
      .find(webContentsId, text, forward)
      .then((next) => {
        if (seq === seqRef.current) setResult(next);
      })
      .catch((error: unknown) => console.warn('[harnas] browser find', error));
  };

  const close = (): void => {
    seqRef.current += 1;
    bridge.browser.stopFind(webContentsId).catch((error: unknown) => console.warn('[harnas] browser stopFind', error));
    onClose();
  };

  const step = (forward: boolean): void => {
    if (query !== '') find(query, forward);
  };

  return (
    <div
      role="search"
      aria-label={S.actions.findInPage}
      className="absolute right-2 top-2 z-10 flex h-8 items-center gap-1 rounded-full border border-border bg-popover px-3 shadow-md"
    >
      <input
        ref={inputRef}
        value={query}
        maxLength={QUERY_LIMIT}
        spellCheck={false}
        autoComplete="off"
        placeholder={S.terminal.findPlaceholder}
        onChange={(event) => {
          setQuery(event.target.value);
          find(event.target.value, true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(!event.shiftKey);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        className="h-6 w-48 rounded border border-transparent bg-transparent px-1 text-sm text-popover-foreground outline-none"
      />
      {/* Живая область стоит всегда: появись она вместе с первым счётом, скринридер его не объявил бы. */}
      <span aria-live="polite" className="min-w-10 text-center text-xs tabular-nums text-muted-foreground">
        {result === null ? '' : `${result.active}/${result.matches}`}
      </span>
      <button type="button" aria-label={S.terminal.previousMatch} className={BUTTON} onClick={() => step(false)}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.terminal.nextMatch} className={BUTTON} onClick={() => step(true)}>
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" aria-label={S.common.close} className={BUTTON} onClick={close}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
