/**
 * Панель терминала выбранной сессии (кусок 1.11 плана окна): сам xterm плюс
 * тонкая строка поиска поверх него по ⌘F. Протокольная обвязка — в
 * `use-terminal.ts`, эта часть только держит контейнер и состояние поиска.
 */

import '@xterm/xterm/css/xterm.css';
import { useEffect, useState } from 'react';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { S } from '../../../shared/strings.js';
import { useTerminal } from './use-terminal.js';

export interface TerminalPanelProps {
  bridge: HarnasBridge;
  sessionRef: SessionRef;
  fontFamily: string;
  fontSize: number;
  /** Видна ли панель в сетке (кусок 2.1 плана окна) — по умолчанию видна. */
  visible?: boolean;
}

export function TerminalPanel({
  bridge,
  sessionRef,
  fontFamily,
  fontSize,
  visible = true,
}: TerminalPanelProps): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const { search } = useTerminal({ bridge, ref: sessionRef, container, fontFamily, fontSize, visible });

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  // ⌘F открывает/закрывает строку поиска этой панели — только пока она
  // смонтирована, то есть сессия выбрана (`App.tsx`).
  useEffect(
    () => bridge.app.onMenu((action) => {
      if (action === 'find') setSearchOpen((open) => !open);
    }),
    [bridge],
  );

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {searchOpen ? (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-border bg-popover px-2 py-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search?.findNext(query);
              if (event.key === 'Escape') setSearchOpen(false);
            }}
            placeholder={S.terminal.findPlaceholder}
            className="w-48 bg-transparent text-sm text-popover-foreground outline-none"
          />
        </div>
      ) : null}
      {/* Отступ 4px — на обёртке, а не на самом контейнере xterm (спека 4.7):
          FitAddon меряет ширину/высоту РОДИТЕЛЯ терминала и вычитает падинг
          только у своего собственного элемента, так что падинг контейнера он
          бы не заметил и обрезал бы контент по краю. */}
      <div className="min-h-0 flex-1 p-1">
        <div ref={setContainer} className="h-full w-full" />
      </div>
    </div>
  );
}
