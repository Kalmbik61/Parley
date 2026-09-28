/**
 * Строка над страницей вкладки браузера (кусок 9.2a, спека 12.1), 36px: «назад», «вперёд»,
 * «перезагрузить» или «остановить», адресная строка, «DevTools» и полоса загрузки 2px под строкой.
 * ⌖ Design Mode встанет перед «DevTools» в 9.3b.
 *
 * Страницей строка не управляет сама: всё — колбэками `BrowserSurface`, у которого `<webview>`.
 */

import { ArrowLeft, ArrowRight, RotateCw, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { S } from '../../shared/strings.js';
import { AddressBar } from './AddressBar.js';

export interface BrowserChromeProps {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Страница есть и готова (`dom-ready`): без неё «перезагрузить» и «DevTools» некуда слать. */
  live: boolean;
  /** Новая вкладка без страницы — фокус в адресной строке (спека 12.1). */
  focusAddress: boolean;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onStop(): void;
  onNavigate(url: string): void;
  onDevTools(): void;
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function BrowserChrome(props: BrowserChromeProps): JSX.Element {
  const { url, loading, canGoBack, canGoForward, live } = props;
  return (
    <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
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
      <button
        type="button"
        disabled={!live}
        onClick={props.onDevTools}
        className="h-6 shrink-0 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        {S.browser.devTools}
      </button>
      {loading ? <div data-testid="browser-loading" className="absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-blue-500" /> : null}
    </div>
  );
}
