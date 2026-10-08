/**
 * Панель Console | Network снизу вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.3, 4.4).
 * - Шапка: виды Console и Network, «Preserve log», очистить и закрыть.
 * - Под шапкой — подсказка, если захват поздний или недоступен, с «Reload».
 * - Высота общая для вкладок (`ui.json`, `browser.devtoolsHeight`), ручка — `HeightResizer`.
 * - Узкая панель (уже `NARROW_PX`) кладёт детали запроса поверх списка.
 * - «Add errors to chat» и «Add to chat» строк и запросов — слоты этапа B.
 */
import { Ban, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../../shared/bridge.js';
import type { ConsoleEntry, NetworkEntry } from '../../../shared/browser-devtools.js';
import { S } from '../../../shared/strings.js';
import { DEVTOOLS_PANEL } from '../../../shared/ui-types.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.js';
import { ConsoleView } from './ConsoleView.js';
import { FilterToggle, PanelIconButton } from './controls.js';
import { HeightResizer } from './HeightResizer.js';
import { NetworkView } from './NetworkView.js';
import { devtoolsCounters, EMPTY_DEVTOOLS, useDevtoolsStore } from './store.js';

/** Уже этой ширины детали запроса ложатся поверх списка (спека 4.4). */
const NARROW_PX = 640;
const TRIGGER = 'px-2 py-0.5 text-[11px]';
const CONTENT = 'mt-0 flex min-h-0 min-w-0 flex-1 flex-col';

export interface DevtoolsPanelProps {
  tabId: string;
  webContentsId: number | null;
  pageUrl: string;
  bridge: ParleyBridge;
  /** Высота в пределах (`stage.ts#panelHeight`). */
  height: number;
  maxHeight: number;
  /** Новая высота после перетаскивания — в `ui.json`. */
  onResize(height: number): void;
  /** «Reload» подсказок `late` и `unavailable`. */
  onReload(): void;
  /** Очистить журнал вкладки — в main и в окне. */
  onClear(): void;
  onAddConsoleToChat?: ((entry: ConsoleEntry) => void) | undefined;
  onAddRequestToChat?: ((entry: NetworkEntry) => void) | undefined;
  onAddErrorsToChat?: (() => void) | undefined;
}

export function DevtoolsPanel(props: DevtoolsPanelProps): JSX.Element {
  const { tabId, onAddErrorsToChat } = props;
  const tab = useDevtoolsStore((state) => state.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const store = useDevtoolsStore.getState();
  const panelRef = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  useLayoutEffect(() => {
    const node = panelRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setNarrow(width < NARROW_PX);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const errors = devtoolsCounters(tab).errors;
  const notice = tab.capture === 'late' ? S.browser.devtools.late : S.browser.devtools.unavailable;

  return (
    <section
      ref={panelRef}
      data-testid="devtools-panel"
      aria-label={S.browser.devtools.toggle}
      style={{ height: props.height }}
      className="relative flex shrink-0 flex-col border-t border-border bg-card"
    >
      <HeightResizer
        height={props.height}
        min={DEVTOOLS_PANEL.minHeight}
        max={props.maxHeight}
        target={panelRef}
        onCommit={props.onResize}
      />
      {/* `overflow-hidden` — на вкладках, не на `section`: ручка торчит над его верхней кромкой. */}
      <Tabs
        value={tab.view}
        onValueChange={(view) =>
          store.patch(tabId, { view: view === 'network' ? 'network' : 'console' })
        }
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-1.5">
          <TabsList className="h-6 shrink-0 p-0.5">
            <TabsTrigger value="console" className={TRIGGER}>
              {S.browser.devtools.console}
            </TabsTrigger>
            <TabsTrigger value="network" className={TRIGGER}>
              {S.browser.devtools.network}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {errors > 0 && onAddErrorsToChat !== undefined ? (
              // Узкая шапка: подпись урезается первой, остальные кнопки остаются на месте.
              <button
                type="button"
                onClick={() => onAddErrorsToChat()}
                className="h-5 min-w-0 truncate rounded px-1.5 text-[11px] hover:bg-accent"
              >
                {S.browser.devtools.addErrorsToChat}
              </button>
            ) : null}
            <FilterToggle
              pressed={tab.preserve}
              onClick={() => store.patch(tabId, { preserve: !tab.preserve })}
            >
              {S.browser.devtools.preserveLog}
            </FilterToggle>
            <PanelIconButton label={S.browser.devtools.clear} onClick={() => props.onClear()}>
              <Ban className="size-3" aria-hidden="true" />
            </PanelIconButton>
            <PanelIconButton label={S.browser.devtools.close} onClick={() => store.hide(tabId)}>
              <X className="size-3.5" aria-hidden="true" />
            </PanelIconButton>
          </div>
        </div>
        {tab.capture === 'on' ? null : (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-2 py-0.5 text-[11px]"
          >
            <span className="min-w-0 truncate" title={notice}>
              {notice}
            </span>
            <button type="button" onClick={() => props.onReload()} className="shrink-0 underline">
              {S.browser.reload}
            </button>
          </div>
        )}
        <TabsContent value="console" className={CONTENT}>
          <ConsoleView tabId={tabId} onAddToChat={props.onAddConsoleToChat} />
        </TabsContent>
        <TabsContent value="network" className={CONTENT}>
          <NetworkView
            tabId={tabId}
            pageUrl={props.pageUrl}
            webContentsId={props.webContentsId}
            bridge={props.bridge}
            narrow={narrow}
            onAddToChat={props.onAddRequestToChat}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
