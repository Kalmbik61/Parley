/**
 * Поверхность вкладки браузера (кусок 9.2a, спека 12.1, 12.2): строка над страницей и
 * `<webview>` в слое поверхностей работы (`layout/SurfaceLayer.tsx`), привязанные CSS-якорем к телу
 * группы — как у терминала. Перенос вкладки меняет только якорь: узел `<webview>` в DOM не
 * переносится, иначе гость перезагрузился бы. Это держит сортировка слоя по id вкладки (2.5).
 *
 * Страница — недоверенная: мостов окна и Node в госте нет (страж main, 9.1), а рендерер зовёт
 * у `<webview>` только навигацию — `loadURL`, `goBack`, `goForward`, `reload`, `stop`.
 * Программный доступ к странице — только у main (спека 12.2): Design Mode (9.3b) тоже идёт мостом —
 * `pickStart` и `pickCancel`, а не `executeJavaScript` у `<webview>`.
 *
 * `src` ставится один раз, при монтировании `<webview>` (первый адрес http(s) вкладки). Гость сам
 * пишет в `src` адрес коммита, а любое присвоение `src` — новая загрузка: проп `src={url}`
 * перезагружал бы страницу на каждом переходе SPA и делал бы «назад» новой навигацией. Адрес идёт
 * только из страницы в раскладку (`updateTab`), обратно — нет; адресная строка живой страницы —
 * `loadURL`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { useLayoutStore } from '../layout/store.js';
import { focusTab, updateTab } from '../layout/tree.js';
import { isHttpUrl } from '../terminal/links.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { BrowserChrome } from './BrowserChrome.js';
import { DesignModeCard } from './DesignModeCard.js';
import { FindBar } from './FindBar.js';
import { clearAddressFocus, useBrowserStore, wantsAddressFocus, type BrowserTabState } from './store.js';
import { layoutUrl } from './url.js';

/** Методы `<webview>` Electron, которые зовёт окно; до `dom-ready` они бросают. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

/** Поля событий `<webview>` лежат на самом событии (`Electron.*Event` у `WebviewTag`). */
type WebviewEvent = Event & { url?: string; title?: string; isMainFrame?: boolean; errorCode?: number };

/** `net::ERR_ABORTED`: загрузку прервали (новый переход, Stop, скачивание) — это не ошибка страницы. */
const ERR_ABORTED = -3;

/**
 * Атрибуты `<webview>` строками: React 18 булев `allowpopups` у тега без дефиса не выводит, а
 * @types/react типизирует его как boolean. Без атрибута Electron гасит `window.open` и
 * `target=_blank` ещё до `setWindowOpenHandler` (9.1), и вкладка по ссылке не откроется.
 */
const WEBVIEW_ATTRIBUTES = {
  partition: BROWSER_PARTITION,
  webpreferences: 'contextIsolation=yes, sandbox=yes',
  allowpopups: 'true',
} as Record<string, string>;

export interface BrowserSurfaceProps {
  workKey: string;
  tabId: string;
  /** Адрес вкладки из раскладки; '' — новая вкладка. */
  url: string;
  groupId: string;
  visible: boolean;
  bridge: ParleyBridge;
  /** Работа вкладки — сессии получателей карточки Design Mode (9.3b). */
  entry: WorkEntry;
  sendDeps: SendWithToastDeps;
}

const IDLE: BrowserTabState = {
  title: null,
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
  webContentsId: null,
  findOpen: false,
  loadFailed: false,
  pick: 'off',
};

export function BrowserSurface({ workKey, tabId, url, groupId, visible, bridge, entry, sendDeps }: BrowserSurfaceProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<WebviewElement | null>(null);
  const readyRef = useRef(false);
  // Номер текущего выбора Design Mode: ответ выбора, который уже сняли (⌖, Esc, навигация), карточку не ставит.
  const pickTokenRef = useRef(0);
  const state = useBrowserStore((store) => store.tabs[tabId]) ?? IDLE;

  // Первый адрес http(s) — и только он — становится `src`. Без адреса (новая вкладка) и с чужим
  // адресом (раскладку правили руками) — заглушка: страж main отверг бы такой `src` (9.1).
  const [src, setSrc] = useState<string | null>(() => (isHttpUrl(url) ? url : null));
  if (src === null && isHttpUrl(url)) setSrc(url);

  // Фокус адресной строки — только у вкладки, которую человек открыл сейчас (перенос 9.2a), а не у
  // пустой вкладки восстановленной раскладки. Просьба читается при монтировании и снимается эффектом.
  const [addressFocus] = useState(() => wantsAddressFocus(tabId));
  useEffect(() => clearAddressFocus(tabId), [tabId]);

  // Якорные свойства — через `setProperty`, как у терминала: в `CSSProperties` @types/react 18 их нет.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    el.style.setProperty('position-anchor', `--g-${groupId}`);
    el.style.setProperty('top', 'anchor(top)');
    el.style.setProperty('left', 'anchor(left)');
    el.style.setProperty('width', 'anchor-size(width)');
    el.style.setProperty('height', 'anchor-size(height)');
  }, [groupId]);

  // `inert` в React 18 — не булев проп. Скрытая вкладка не получает ни фокуса, ни кликов.
  useLayoutEffect(() => {
    rootRef.current?.toggleAttribute('inert', !visible);
  }, [visible]);

  const setView = useCallback((node: HTMLElement | null) => {
    viewRef.current = node as WebviewElement | null;
  }, []);

  // События `<webview>` React не знает — только `addEventListener`.
  useEffect(() => {
    const view = viewRef.current;
    if (src === null || view === null) return;
    readyRef.current = false;
    const update = (patch: Partial<BrowserTabState>): void => useBrowserStore.getState().update(tabId, patch);
    const history = (): void => {
      if (!readyRef.current) return;
      try {
        update({ canGoBack: view.canGoBack(), canGoForward: view.canGoForward() });
      } catch (error) {
        console.warn('[parley] webview history unavailable', error);
      }
    };
    // Адрес — только в раскладку, и только http(s) без user:pass@ (спека 12.1).
    const saveUrl = (next: string | undefined): void => {
      const safe = next === undefined ? null : layoutUrl(next);
      if (safe !== null) useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { url: safe }));
    };

    const listeners: Record<string, (event: WebviewEvent) => void> = {
      // Раньше dom-ready getWebContentsId() бросает.
      'dom-ready': () => {
        readyRef.current = true;
        update({ webContentsId: view.getWebContentsId() });
        history();
      },
      'did-start-loading': () => update({ loading: true, crashed: false, loadFailed: false }),
      'did-stop-loading': () => update({ loading: false }),
      'page-title-updated': (event) => update({ title: event.title ?? null }),
      // Новый документ: заголовок и значок прежней страницы ему не принадлежат.
      // Карточка и выбор прошлой страницы к новой не относятся; main и сам ответит выбору null (9.3a).
      'did-navigate': (event) => {
        saveUrl(event.url);
        pickTokenRef.current += 1;
        update({ title: null, favicon: null, pick: 'off' });
        history();
      },
      'did-navigate-in-page': (event) => {
        if (event.isMainFrame === true) saveUrl(event.url);
        history();
      },
      // Полоса поиска мёртвой страницы искать не может: закрывается вместе с падением.
      'render-process-gone': () => update({ crashed: true, loading: false, findOpen: false }),
      // Chromium в `<webview>` своей страницы ошибки не рисует — без слоя человек видел бы пустоту.
      'did-fail-load': (event) => {
        if (event.isMainFrame === true && event.errorCode !== ERR_ABORTED) update({ loadFailed: true });
      },
    };
    for (const [type, listener] of Object.entries(listeners)) view.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of Object.entries(listeners)) view.removeEventListener(type, listener);
    };
  }, [src, tabId, workKey]);

  // Favicon качает main (CSP окна внешних картинок не пускает) и шлёт всем вкладкам окна; своя — по id гостя.
  useEffect(
    () =>
      bridge.browser.onFavicon((event) => {
        const own = useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null;
        if (own !== null && event.webContentsId === own) useBrowserStore.getState().update(tabId, { favicon: event.dataUrl });
      }),
    [bridge, tabId],
  );

  useEffect(() => () => useBrowserStore.getState().remove(tabId), [tabId]);

  /** Метод живой страницы; до `dom-ready` Electron бросает — это не повод ронять окно. */
  const onPage = (action: (view: WebviewElement) => unknown): void => {
    const view = viewRef.current;
    if (view === null) return;
    try {
      const result = action(view);
      if (result instanceof Promise) result.catch((error: unknown) => console.warn('[parley] webview navigation failed', error));
    } catch (error) {
      console.warn('[parley] webview is not ready', error);
    }
  };

  const navigate = (next: string): void => {
    if (src !== null) {
      onPage((view) => view.loadURL(next));
      return;
    }
    // Страницы ещё нет: адрес — в раскладку, и `<webview>` смонтируется с ним как с первым `src`.
    const safe = layoutUrl(next);
    if (safe !== null) useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { url: safe }));
  };

  const reload = (): void => {
    useBrowserStore.getState().update(tabId, { crashed: false, loadFailed: false });
    onPage((view) => view.reload());
  };

  const openDevTools = (): void => {
    const id = state.webContentsId;
    if (id === null) return;
    bridge.browser.openDevTools(id).catch((error: unknown) => {
      console.error('[parley] openDevTools failed', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.openDevTools));
    });
  };

  // Design Mode (спека 12.3): выбор — только по ⌖ или «Pick again» человека.
  const startPick = (): void => {
    const id = state.webContentsId;
    if (id === null) return;
    pickTokenRef.current += 1;
    const token = pickTokenRef.current;
    const update = (patch: Partial<BrowserTabState>): void => {
      if (token === pickTokenRef.current) useBrowserStore.getState().update(tabId, patch);
    };
    update({ pick: 'picking' });
    bridge.browser.pickStart(id).then(
      (result) => update({ pick: result === null ? 'off' : { result } }),
      (error: unknown) => {
        if (token !== pickTokenRef.current) return;
        console.error('[parley] pickStart failed', error);
        toast(errorText(decodeIpcError(error).code, S.errors.actions.pickElement));
        update({ pick: 'off' });
      },
    );
  };

  const cancelPick = (): void => {
    const id = state.webContentsId;
    pickTokenRef.current += 1;
    useBrowserStore.getState().update(tabId, { pick: 'off' });
    if (id !== null) bridge.browser.pickCancel(id).catch((error: unknown) => console.warn('[parley] pickCancel failed', error));
  };

  const picking = state.pick === 'picking';

  // Скрытую вкладку человек не видит: выбор в ней снимается, а не ест клики страницы до возврата.
  const cancelPickRef = useRef(cancelPick);
  cancelPickRef.current = cancelPick;
  useEffect(() => {
    if (!visible && picking) cancelPickRef.current();
  }, [visible, picking]);

  // Поверхность — сосед тела группы, а не потомок: клик в строку сама делает свою вкладку активной.
  const focusOwnTab = (): void => {
    useLayoutStore.getState().apply(workKey, (layout) => focusTab(layout, tabId));
  };

  const live = src !== null && state.webContentsId !== null;

  return (
    <div
      ref={rootRef}
      data-tab-id={tabId}
      className="absolute flex flex-col overflow-hidden bg-background"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      onPointerDownCapture={focusOwnTab}
      onFocusCapture={focusOwnTab}
      // Esc при фокусе в окне (после клика по ⌖ он на кнопке): в странице Esc ловит сам скрипт выбора.
      onKeyDown={(event) => {
        if (event.key === 'Escape' && picking) {
          event.preventDefault();
          cancelPick();
        }
      }}
    >
      <BrowserChrome
        url={url}
        loading={state.loading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        live={live}
        focusAddress={addressFocus && src === null && visible}
        onBack={() => onPage((view) => view.goBack())}
        onForward={() => onPage((view) => view.goForward())}
        onReload={reload}
        onStop={() => onPage((view) => view.stop())}
        onNavigate={navigate}
        onDevTools={openDevTools}
        picking={picking}
        onDesignMode={picking ? cancelPick : startPick}
      />
      <div className="relative min-h-0 flex-1">
        {src === null ? (
          <div data-testid="browser-placeholder" className="h-full w-full bg-background" />
        ) : (
          // Белая подложка: гость прозрачен, и страница без своего фона легла бы на тёмную тему окна.
          <webview ref={setView} src={src} className="flex h-full w-full bg-white" {...WEBVIEW_ATTRIBUTES} />
        )}
        {state.findOpen && state.webContentsId !== null ? (
          // Полоса поиска (⌘F в странице, 9.2b) — поверх страницы, как у терминала.
          <FindBar
            bridge={bridge}
            webContentsId={state.webContentsId}
            onClose={() => {
              useBrowserStore.getState().update(tabId, { findOpen: false });
              // Поиск открыли из страницы (⌘F в ней) — туда и фокус, как у терминала с его SearchBar.
              viewRef.current?.focus();
            }}
          />
        ) : null}
        {typeof state.pick === 'object' ? (
          <DesignModeCard workKey={workKey} entry={entry} result={state.pick.result} sendDeps={sendDeps} onPickAgain={startPick} />
        ) : null}
        {state.loadFailed && !state.crashed ? (
          <div
            data-testid="browser-load-failed"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
          >
            <span>{S.browser.loadFailed}</span>
            <button
              type="button"
              onClick={reload}
              className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              {S.browser.reload}
            </button>
          </div>
        ) : null}
        {state.crashed ? (
          // Слой поверх страницы: тело группы лежит под поверхностью, и заглушка в нём была бы не видна.
          <div
            data-testid="browser-crashed"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
          >
            <span>{S.browser.pageCrashed}</span>
            <button
              type="button"
              onClick={reload}
              className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              {S.browser.reload}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
