/**
 * Панель терминала выбранной сессии (кусок 1.11 плана окна): сам xterm плюс
 * тонкая строка поиска поверх него по ⌘F. Протокольная обвязка — в
 * `use-terminal.ts`, эта часть только держит контейнер и состояние поиска.
 */

import '@xterm/xterm/css/xterm.css';
import { useEffect, useState } from 'react';
import type { SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { useTerminal } from './use-terminal.js';

export interface TerminalPanelProps {
  bridge: HarnasBridge;
  sessionRef: SessionRef;
  theme: string;
  fontFamily: string;
  fontSize: number;
}

export function TerminalPanel({ bridge, sessionRef, theme, fontFamily, fontSize }: TerminalPanelProps): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const { search } = useTerminal({ bridge, ref: sessionRef, container, theme, fontFamily, fontSize });

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
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-[var(--h-overlay)] bg-[var(--h-mantle)] px-2 py-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search?.findNext(query);
              if (event.key === 'Escape') setSearchOpen(false);
            }}
            placeholder="Найти…"
            className="w-48 bg-transparent text-sm text-[var(--h-text)] outline-none"
          />
        </div>
      ) : null}
      <div ref={setContainer} className="min-h-0 flex-1" />
    </div>
  );
}
