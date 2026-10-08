// packages/desktop/src/renderer/browser/BrowserChrome.tsx
/**
 * Строка над страницей вкладки браузера (кусок 9.2a, спека 12.1; спека 2026-10-07-browser-devtools-agent-design.md,
 * 4.1), 36px. Слева направо:
 * - «назад», «вперёд», «перезагрузить» или «остановить»;
 * - адрес;
 * - размер вьюпорта (`ViewportMenu`);
 * - ⌖ Design Mode — подсвечен, пока идёт выбор элемента;
 * - консоль: значок со счётчиками ошибок (красный) и предупреждений (жёлтый); нули не показываются;
 * - «⋯»: «Open full DevTools» (прежняя кнопка «DevTools») и «Clear console and network».
 * Под строкой — полоса загрузки 2px. ⌖ Select, ✎ Annotate и «To» займут место ⌖ на этапе B.
 *
 * Узкая строка (окно 800×500): подписи прячет контейнерный запрос самой строки (`@container`), остаются значки;
 * сжимается первым адрес — у остальных `shrink-0`.
 *
 * Страницей строка не управляет сама: всё — колбэками `BrowserSurface`, у которого `<webview>`.
 */

import { ArrowLeft, ArrowRight, Crosshair, MoreHorizontal, RotateCw, SquareTerminal, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { AddressBar } from './AddressBar.js';
import { ViewportMenu } from './ViewportMenu.js';

export interface BrowserChromeProps {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Страница есть и готова (`dom-ready`): без неё «перезагрузить», размер, консоль и «⋯» некуда слать. */
  live: boolean;
  /** Новая вкладка без страницы — фокус в адресной строке (спека 12.1). */
  focusAddress: boolean;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onNavigate(url: string): void;
  /** «⋯ → Open full DevTools»: полный Chromium DevTools отдельным окном. */
  onDevTools(): void;
  /** Идёт выбор элемента Design Mode: ⌖ подсвечен, повторное нажатие выбор снимает. */
  picking: boolean;
  onDesignMode(): void;
  /** Размер вьюпорта вкладки (`TabSpec.viewport`); null — Fit. */
  viewport: ViewportSpec | null;
  onViewport(spec: ViewportSpec | null): void;
  /** Панель Console | Network открыта. */
  devtoolsOpen: boolean;
  /** Счётчики текущей страницы (`devtools/store.ts#devtoolsCounters`). */
  counters: { errors: number; warnings: number };
  onToggleDevtools(): void;
  /** «⋯ → Clear console and network». */
  onClearDevtools(): void;
}

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40';

function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className={ICON_BUTTON}>
      {children}
    </button>
  );
}

export function BrowserChrome(props: BrowserChromeProps): JSX.Element {
  const { url, loading, canGoBack, canGoForward, live, counters } = props;
  return (
    <div data-testid="browser-chrome" className="@container relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
      <IconButton label={S.actions.back} disabled={!live || !canGoBack} onClick={props.onBack}>
        <ArrowLeft className="size-3.5" aria-hidden="true" />
      </IconButton>
      <IconButton label={S.actions.forward} disabled={!live || !canGoForward} onClick={props.onForward}>
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </IconButton>
      {loading ? (
        <IconButton label={S.browser.stop} disabled={!live} onClick={props.onStop}>
          <X className="size-3.5" aria-hidden="true" />
        </IconButton>
      ) : (
        <IconButton label={S.browser.reload} disabled={!live} onClick={props.onReload}>
          <RotateCw className="size-3.5" aria-hidden="true" />
        </IconButton>
      )}
      <AddressBar url={url} onNavigate={props.onNavigate} autoFocus={props.focusAddress} />
      <ViewportMenu viewport={props.viewport} disabled={!live} onChange={props.onViewport} />
      <button
        type="button"
        aria-label={S.browser.designMode}
        title={S.browser.designMode}
        aria-pressed={props.picking}
        disabled={!live}
        onClick={props.onDesignMode}
        className={
          props.picking
            ? 'flex size-6 shrink-0 items-center justify-center rounded bg-blue-500/15 text-blue-600 dark:text-blue-400'
            : ICON_BUTTON
        }
      >
        <Crosshair className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={S.browser.devtools.toggle}
        title={S.browser.devtools.toggle}
        aria-pressed={props.devtoolsOpen}
        disabled={!live}
        onClick={props.onToggleDevtools}
        className={cn(
          'flex h-6 shrink-0 items-center gap-1 rounded px-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40',
          props.devtoolsOpen && 'bg-accent text-accent-foreground',
        )}
      >
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
        {counters.errors > 0 ? (
          <span
            data-testid="devtools-errors"
            title={S.browser.devtools.errors(counters.errors)}
            className="rounded-full bg-red-500/15 px-1 text-[10px] font-medium leading-4 text-red-600 dark:text-red-400"
          >
            {counters.errors}
          </span>
        ) : null}
        {counters.warnings > 0 ? (
          <span
            data-testid="devtools-warnings"
            title={S.browser.devtools.warnings(counters.warnings)}
            className="rounded-full bg-amber-500/15 px-1 text-[10px] font-medium leading-4 text-amber-700 dark:text-amber-400"
          >
            {counters.warnings}
          </span>
        ) : null}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={S.browser.devtools.more} title={S.browser.devtools.more} disabled={!live} className={ICON_BUTTON}>
            <MoreHorizontal className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={props.onDevTools}>{S.browser.devtools.openFull}</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onClearDevtools}>{S.browser.devtools.clearAll}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {loading ? <div data-testid="browser-loading" className="absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-blue-500" /> : null}
    </div>
  );
}
