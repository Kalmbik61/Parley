// packages/desktop/src/renderer/browser/BrowserChrome.tsx
/**
 * Строка над страницей вкладки браузера (кусок 9.2a, спека 12.1; спека 2026-10-07-browser-devtools-agent-design.md,
 * 4.1), 36px. Слева направо:
 * - «назад», «вперёд», «перезагрузить» или «остановить»;
 * - адрес;
 * - размер вьюпорта (`ViewportMenu`);
 * - ⌖ Select и ✎ Annotate (этап B) — после меню размеров, перед «To»; подсвечена кнопка включённого режима;
 * - меню цели «To» (`targetMenu`, этап B, спека браузера 4.1) — после ⌖ и ✎, перед консолью;
 * - консоль: значок со счётчиками ошибок (красный) и предупреждений (жёлтый); нули не показываются;
 * - «⋯»: «Open full DevTools» (прежняя кнопка «DevTools») и «Clear console and network».
 * Под строкой — полоса загрузки 2px.
 *
 * Узкая строка (окно 800×500): подпись кнопки размера прячет флаг ширины строки (`ResizeObserver`), остаются значки;
 * сжимается первым адрес — у остальных `shrink-0`. Контейнерного запроса в строке нет (размерного контейнера — тем более):
 * Chromium порой не пересчитывал `:disabled` у его потомков, и включённые после `dom-ready` кнопки оставались со стилем
 * выключенных (`pointer-events: none`, `opacity: .4`) — мёртвые тусклые значки (P2 итогового ревью этапа B).
 *
 * Страницей строка не управляет сама: всё — колбэками `BrowserSurface`, у которого `<webview>`.
 */

import { ArrowLeft, ArrowRight, Crosshair, MoreHorizontal, PencilLine, RotateCw, SquareTerminal, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { AddressBar } from './AddressBar.js';
import type { BrowserMode } from './store.js';
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
  /** Режим вкладки: подсвечены ⌖ или ✎ (этап B, спека браузера 4.6, 4.7). */
  mode: BrowserMode;
  onSelect(): void;
  onAnnotate(): void;
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
  /** Меню цели «To» (этап B, спека браузера 4.1): после ⌖ и ✎, перед консолью. */
  targetMenu?: ReactNode;
}

/** Ширина содержимого строки (без отступов), с которой видна подпись кнопки размера: порог прежнего контейнерного запроса. */
const VIEWPORT_NAME_MIN_WIDTH = 560;

/** Выше этого значка счётчика пишут «999+»: число в журнале не ограничено, а строка 36px и так узка. */
const BADGE_MAX = 999;

function badgeText(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
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

function ModeButton({ label, title, pressed, disabled, onClick, children }: { label: string; title: string; pressed: boolean; disabled: boolean; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={pressed ? 'flex size-6 shrink-0 items-center justify-center rounded bg-blue-500/15 text-blue-600 dark:text-blue-400' : ICON_BUTTON}
    >
      {children}
    </button>
  );
}

export function BrowserChrome(props: BrowserChromeProps): JSX.Element {
  const { url, loading, canGoBack, canGoForward, live, counters } = props;
  // Ширину строки меряет сам компонент: пересчёт стиля потомков не зависит от размера контейнера (см. шапку файла).
  const rowRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      // `contentRect` — содержимое без отступов, как мерил контейнерный запрос.
      const width = entries[entries.length - 1]?.contentRect.width;
      if (width !== undefined) setWide(width >= VIEWPORT_NAME_MIN_WIDTH);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={rowRef} data-testid="browser-chrome" className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
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
      <ViewportMenu viewport={props.viewport} disabled={!live} showName={wide} onChange={props.onViewport} />
      <ModeButton label={S.browser.select.button} title={S.browser.select.title} pressed={props.mode === 'select'} disabled={!live} onClick={props.onSelect}>
        <Crosshair className="size-3.5" aria-hidden="true" />
      </ModeButton>
      <ModeButton label={S.browser.annotate.button} title={S.browser.annotate.title} pressed={props.mode === 'annotate'} disabled={!live} onClick={props.onAnnotate}>
        <PencilLine className="size-3.5" aria-hidden="true" />
      </ModeButton>
      {props.targetMenu}
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
            className="rounded-full bg-destructive/15 px-1 text-[10px] font-medium leading-4 tabular-nums text-destructive"
          >
            {badgeText(counters.errors)}
          </span>
        ) : null}
        {counters.warnings > 0 ? (
          <span
            data-testid="devtools-warnings"
            title={S.browser.devtools.warnings(counters.warnings)}
            className="rounded-full bg-status-warning-background px-1 text-[10px] font-medium leading-4 tabular-nums text-status-warning-text"
          >
            {badgeText(counters.warnings)}
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
