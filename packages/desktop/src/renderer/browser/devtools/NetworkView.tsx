/**
 * Вид Network панели (спека 2026-10-07-browser-devtools-agent-design.md, 4.4).
 * - Фильтры: типы, «Failed only», подстрока URL.
 * - Список запросов по времени начала — виртуальный: в DOM видимые строки и запас.
 * - Status: ошибки красным; без ответа — `CORS`, `blocked` или `failed`, `(canceled)` серым.
 * - Name: путь и query, у чужого origin — ещё хост.
 * - Выбор строки — детали справа, на узкой панели — поверх списка.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, type CSSProperties } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { isFailed, type NetworkEntry } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { FilterInput, FilterToggle } from './controls.js';
import { nameParts, sizeText, statusCell } from './format.js';
import { RequestDetails } from './RequestDetails.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, visibleNetwork, type NetworkFilter } from './store.js';

const FILTERS: readonly NetworkFilter[] = ['all', 'fetch', 'doc', 'js', 'css', 'img', 'other'];
const ROW_PX = 24;
/** Размер списка до первого замера (jsdom, первый кадр): первые строки есть сразу — как `review/VirtualRows.tsx`. */
const INITIAL_RECT = { width: 600, height: 400 };
const GRID = 'grid grid-cols-[4.5rem_3.5rem_minmax(0,1fr)_4.5rem_4rem_4rem] items-center gap-2 px-2';

function NetworkRow(props: { entry: NetworkEntry; pageUrl: string; selected: boolean; style: CSSProperties; onSelect(): void }): JSX.Element {
  const { entry } = props;
  const status = statusCell(entry);
  const name = nameParts(entry.url, props.pageUrl);
  return (
    <button
      type="button"
      data-network-row={entry.id}
      data-failed={isFailed(entry)}
      aria-pressed={props.selected}
      title={entry.url}
      onClick={props.onSelect}
      style={props.style}
      className={cn(GRID, 'h-6 w-full border-b border-border/60 text-left hover:bg-accent', props.selected && 'bg-accent')}
    >
      <span
        data-tone={status.tone}
        className={cn('truncate', status.tone === 'error' && 'text-destructive', status.tone === 'muted' && 'text-muted-foreground')}
      >
        {status.text}
      </span>
      <span className="truncate">{entry.method}</span>
      <span className="min-w-0 truncate">
        {name.path}
        {name.host === null ? null : <span className="text-muted-foreground">{` · ${name.host}`}</span>}
      </span>
      <span className="truncate text-muted-foreground">{entry.kind}</span>
      <span className="truncate text-muted-foreground">{sizeText(entry)}</span>
      <span className="truncate text-muted-foreground">{entry.durationMs === null ? '—' : S.browser.devtools.ms(entry.durationMs)}</span>
    </button>
  );
}

export interface NetworkViewProps {
  tabId: string;
  /** Адрес страницы вкладки: у запросов её origin хост в Name не пишется. */
  pageUrl: string;
  webContentsId: number | null;
  bridge: ParleyBridge;
  /** Узкая панель: детали — поверх списка (спека 4.4). */
  narrow: boolean;
  /** «Add to chat» запроса — этап B; нет колбэка — нет кнопки. */
  onAddToChat?: ((entry: NetworkEntry) => void) | undefined;
}

export function NetworkView({ tabId, pageUrl, webContentsId, bridge, narrow, onAddToChat }: NetworkViewProps): JSX.Element {
  const tab = useDevtoolsStore((state) => state.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const patch = useDevtoolsStore.getState().patch;
  const rows = useMemo(() => visibleNetwork(tab), [tab]);
  const selected = tab.selected === null ? null : (tab.network.find((entry) => entry.id === tab.selected) ?? null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    initialRect: INITIAL_RECT,
    overscan: 10,
  });
  const columns = S.browser.devtools.columns;

  return (
    <div data-testid="network-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-1.5 py-1">
        {FILTERS.map((filter) => (
          <FilterToggle key={filter} pressed={tab.networkFilter === filter} onClick={() => patch(tabId, { networkFilter: filter })}>
            {S.browser.devtools.kinds[filter]}
          </FilterToggle>
        ))}
        <FilterToggle pressed={tab.failedOnly} onClick={() => patch(tabId, { failedOnly: !tab.failedOnly })}>
          {S.browser.devtools.failedOnly}
        </FilterToggle>
        <FilterInput label={S.browser.devtools.filterUrl} value={tab.urlText} onChange={(value) => patch(tabId, { urlText: value })} />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', selected !== null && !narrow ? 'w-1/2' : 'flex-1')}>
          <div className={cn(GRID, 'h-6 shrink-0 border-b border-border text-[11px] text-muted-foreground')}>
            <span>{columns.status}</span>
            <span>{columns.method}</span>
            <span>{columns.name}</span>
            <span>{columns.type}</span>
            <span>{columns.size}</span>
            <span>{columns.time}</span>
          </div>
          <div ref={scrollRef} data-testid="network-scroll" className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
            {rows.length === 0 ? (
              <div className="p-2 text-muted-foreground">{S.browser.devtools.emptyNetwork}</div>
            ) : (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = rows[item.index];
                  if (entry === undefined) return null;
                  return (
                    <NetworkRow
                      key={entry.id}
                      entry={entry}
                      pageUrl={pageUrl}
                      selected={entry.id === tab.selected}
                      style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
                      onSelect={() => patch(tabId, { selected: entry.id })}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {selected === null ? null : (
          <div
            data-testid="request-details-pane"
            data-overlay={narrow}
            className={cn('min-h-0 min-w-0 bg-card', narrow ? 'absolute inset-0 z-10' : 'w-1/2 border-l border-border')}
          >
            <RequestDetails
              entry={selected}
              webContentsId={webContentsId}
              bridge={bridge}
              onClose={() => patch(tabId, { selected: null })}
              onAddToChat={onAddToChat}
            />
          </div>
        )}
      </div>
    </div>
  );
}
