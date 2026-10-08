// packages/desktop/src/renderer/browser/BrowserSurface.tsx
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
 * `<webview>` монтируется один раз, при первом адресе http(s) вкладки, и с `src="about:blank"` (спайк 0.1, вариант D):
 * к пустому гостю main уже подключил отладчик, а адрес вкладки окно открывает на первом `dom-ready` после
 * `devtoolsReady` — иначе подресурсы первой загрузки (стили, картинки, скрипты из HTML) прошли бы мимо журнала.
 * Гость сам пишет в `src` адрес коммита, а любое присвоение `src` — новая загрузка: проп с адресом вкладки
 * перезагружал бы страницу на каждом переходе SPA и делал бы «назад» новой навигацией. Адрес идёт только из
 * страницы в раскладку (`updateTab`), обратно — нет; адресная строка живой страницы — `loadURL`.
 *
 * Консоль, сеть и размер (спека 2026-10-07-browser-devtools-agent-design.md, 4.1–4.3, 4.9):
 * - журнал гостя — снимок и пачки main (`devtools/use-devtools-feed.ts`); панель — снизу вкладки, высота общая
 *   (`ui.json`); ⌘⌥I и ⌘⌥J с фокусом в строке или панели ловит этот компонент;
 * - размер — из раскладки (`TabSpec.viewport`): эмуляцию ставит main (`use-viewport.ts`), а окно ставит тот же узел
 *   `<webview>` размером ширина×scale на высота×scale по центру нейтрального поля с подписью.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import { BROWSER_PARTITION } from '../../shared/browser-types.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { ACTIONS, matchesAccelerator, type ActionId, type KeyLike } from '../../shared/keybindings.js';
import { errorText, S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { useLayoutStore } from '../layout/store.js';
import { focusTab, updateTab } from '../layout/tree.js';
import { useUiStore } from '../store/ui.js';
import { isHttpUrl } from '../terminal/links.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { BrowserChrome } from './BrowserChrome.js';
import { DesignModeCard } from './DesignModeCard.js';
import { DevtoolsPanel } from './devtools/DevtoolsPanel.js';
import { devtoolsCounters, EMPTY_DEVTOOLS, useDevtoolsStore } from './devtools/store.js';
import { useDevtoolsFeed } from './devtools/use-devtools-feed.js';
import { FindBar } from './FindBar.js';
import { fitArea, panelHeight, STAGE, stageBox, type FieldSize } from './stage.js';
import { clearAddressFocus, useBrowserStore, wantsAddressFocus, type BrowserTabState } from './store.js';
import { layoutUrl } from './url.js';
import { useViewport } from './use-viewport.js';

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

/** Стартовая страница `<webview>` (спайк 0.1, вариант D): страж пускает такой `src`, адрес вкладки открывается позже. */
const BLANK_SRC = 'about:blank';

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

/**
 * Клавиши панели (спека 2026-10-07, 4.9) — из реестра. В странице их пересылает main; с фокусом в строке или панели
 * вкладки — этот обработчик: рендерер окна действия `browser` не ловит (`keys/handler.ts#whenAllows`).
 */
const PANEL_KEYS = ACTIONS.filter((action) => action.id === 'browser.devtools' || action.id === 'browser.console');

function panelKey(event: KeyLike): ActionId | null {
  return PANEL_KEYS.find((action) => action.keys !== null && matchesAccelerator(action.keys, event))?.id ?? null;
}

/** Те же поля — тот же размер: пресет и свой размер одной величины остаются разными записями раскладки. */
function sameViewport(a: ViewportSpec | null, b: ViewportSpec | null): boolean {
  if (a === null || b === null) return a === b;
  if ('preset' in a || 'preset' in b) {
    return 'preset' in a && 'preset' in b && a.preset === b.preset && a.rotated === b.rotated && a.dpr === b.dpr;
  }
  return a.width === b.width && a.height === b.height && a.mobile === b.mobile && a.dpr === b.dpr;
}

export interface BrowserSurfaceProps {
  workKey: string;
  tabId: string;
  /** Адрес вкладки из раскладки; '' — новая вкладка. */
  url: string;
  /** Размер вьюпорта вкладки (`TabSpec.viewport`, спека 2026-10-07, 4.2); null — Fit. */
  viewport: ViewportSpec | null;
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

export function BrowserSurface({ workKey, tabId, url, viewport, groupId, visible, bridge, entry, sendDeps }: BrowserSurfaceProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<WebviewElement | null>(null);
  const readyRef = useRef(false);
  // Адрес вкладки уже открывали после захвата (спайк 0.1): повторные dom-ready страницы его не открывают.
  const firstPageRef = useRef(false);
  // Номер текущего выбора Design Mode: ответ выбора, который уже сняли (⌖, Esc, навигация), карточку не ставит.
  const pickTokenRef = useRef(0);
  const state = useBrowserStore((store) => store.tabs[tabId]) ?? IDLE;
  const devtools = useDevtoolsStore((store) => store.tabs[tabId]) ?? EMPTY_DEVTOOLS;
  const counters = useMemo(() => devtoolsCounters(devtools), [devtools]);
  const devtoolsHeight = useUiStore((store) => store.ui.browser.devtoolsHeight);

  // Первый адрес http(s) — и только он — открывается в `<webview>`. Без адреса (новая вкладка) и с чужим
  // адресом (раскладку правили руками) — заглушка: открывать нечего.
  const [src, setSrc] = useState<string | null>(() => (isHttpUrl(url) ? url : null));
  if (src === null && isHttpUrl(url)) setSrc(url);

  // Фокус адресной строки — только у вкладки, которую человек открыл сейчас (перенос 9.2a), а не у
  // пустой вкладки восстановленной раскладки. Просьба читается при монтировании и снимается эффектом.
  const [addressFocus] = useState(() => wantsAddressFocus(tabId));
  useEffect(() => clearAddressFocus(tabId), [tabId]);

  // Поле страницы и вкладка целиком (спека 2026-10-07, 4.2, 4.3): поле — место под страницу при эмуляции, вкладка —
  // предел высоты панели. Размеры — из ResizeObserver: CSS-якорь меняет их без React.
  const [field, setField] = useState<FieldSize | null>(null);
  const [rootHeight, setRootHeight] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const fieldNode = fieldRef.current;
    if (root === null || fieldNode === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((items) => {
      for (const item of items) {
        if (item.target === root) setRootHeight(item.contentRect.height);
        else setField({ width: item.contentRect.width, height: item.contentRect.height });
      }
    });
    observer.observe(root);
    observer.observe(fieldNode);
    return () => observer.disconnect();
  }, []);

  // Свежие значения для первой загрузки: `openFirstPage` живёт в эффекте слушателей и состояние не перечитывает.
  const fieldSizeRef = useRef(field);
  fieldSizeRef.current = field;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Журнал гостя: снимок на dom-ready и при открытии панели, дальше — пачки своего гостя (Фокус ревью 4).
  useDevtoolsFeed(bridge, tabId, state.webContentsId, devtools.open);
  const applied = useViewport({
    bridge,
    webContentsId: state.webContentsId,
    viewport,
    field,
    captureLost: devtools.capture === 'unavailable',
  });
  const stage = applied === null || field === null ? null : stageBox(field, applied.spec, applied.scale);
  // Касания включаются с новым документом (спайк 0.3): мобильный размер на странице без них — подсказка «Reload».
  // `docMobile` — как была настроена эмуляция в момент, когда открылся документ вкладки; null — документа ещё нет
  // (пустая страница варианта D не в счёт), и спрашивать о касаниях рано.
  const appliedMobile = applied !== null && viewportSize(applied.spec).mobile;
  const appliedMobileRef = useRef(appliedMobile);
  appliedMobileRef.current = appliedMobile;
  const [docMobile, setDocMobile] = useState<boolean | null>(null);
  const touchStale = stage !== null && docMobile !== null && appliedMobile !== docMobile;

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
    // Первая страница вкладки (спайк 0.1, вариант D): `<webview>` стартует с about:blank, main к его первому dom-ready
    // уже подключил отладчик и ждёт ответов enable. Адрес открываем после `devtoolsReady`: иначе подресурсы первой
    // загрузки прошли бы мимо журнала. Размер вкладки — тоже до загрузки: касания включаются только с новым документом
    // (спайк 0.3), а `useViewport` ставит размер кадром позже. Отказ того и другого страницу не держит: `useViewport`
    // повторит размер сам, а журнал останется без раннего.
    const openFirstPage = async (id: number): Promise<void> => {
      if (firstPageRef.current) return;
      firstPageRef.current = true;
      try {
        await bridge.browser.devtoolsReady(id);
      } catch (error) {
        console.warn('[parley] devtools capture is not ready, opening the page anyway', error);
      }
      const spec = viewportRef.current;
      const area = fieldSizeRef.current;
      if (spec !== null && area !== null) {
        try {
          await bridge.browser.setViewport(id, spec, fitArea(area));
        } catch (error) {
          console.warn('[parley] viewport is not set before the first page', error);
        }
      }
      try {
        await view.loadURL(src);
      } catch (error) {
        console.warn('[parley] first page load failed', error);
      }
    };

    const listeners: Record<string, (event: WebviewEvent) => void> = {
      // Раньше dom-ready getWebContentsId() бросает.
      'dom-ready': () => {
        readyRef.current = true;
        const id = view.getWebContentsId();
        update({ webContentsId: id });
        history();
        void openFirstPage(id);
      },
      'did-start-loading': () => update({ loading: true, crashed: false, loadFailed: false }),
      'did-stop-loading': () => update({ loading: false }),
      'page-title-updated': (event) => update({ title: event.title ?? null }),
      // Новый документ: заголовок и значок прежней страницы ему не принадлежат.
      // Карточка и выбор прошлой страницы к новой не относятся; main и сам ответит выбору null (9.3a).
      // Касания у нового документа — как у эмуляции в этот миг (спайк 0.3); пустая страница документом вкладки не считается.
      'did-navigate': (event) => {
        saveUrl(event.url);
        pickTokenRef.current += 1;
        if (event.url !== BLANK_SRC) setDocMobile(appliedMobileRef.current);
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
    // Слушатели могли встать позже `dom-ready` пустой страницы (несколько вкладок поднимаются разом, рендерер занят):
    // событие не повторится, и вкладка осталась бы пустой с отключёнными кнопками. До `dom-ready` `getWebContentsId()`
    // бросает — это безопасная проба; `openFirstPage` повторного открытия не допустит.
    try {
      view.getWebContentsId();
      listeners['dom-ready']?.(new Event('dom-ready'));
    } catch {
      /* гость ещё не готов — придёт событие */
    }
    return () => {
      for (const [type, listener] of Object.entries(listeners)) view.removeEventListener(type, listener);
    };
  }, [bridge, src, tabId, workKey]);

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

  // «⋯ → Clear console and network» и «Clear» панели (спека 2026-10-07, 4.1, 4.3): журнал окна — сразу, main — мостом.
  const clearDevtools = (): void => {
    useDevtoolsStore.getState().clear(tabId);
    const id = state.webContentsId;
    if (id === null) return;
    bridge.browser.devtoolsClear(id).catch((error: unknown) => {
      console.error('[parley] devtoolsClear failed', error);
      toast(errorText(decodeIpcError(error).code, S.errors.actions.clearDevtools));
    });
  };

  // Размер вьюпорта (спека 2026-10-07, 4.2) — в раскладку: он переживает перезапуск; эмуляцию ставит useViewport.
  const setViewport = (next: ViewportSpec | null): void => {
    // Повторный выбор того же пресета не меняет ни раскладку, ни эмуляцию.
    if (sameViewport(next, viewport)) return;
    useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId, { viewport: next }));
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
  const panel = panelHeight(devtoolsHeight, rootHeight);
  const commitPanelHeight = (height: number): void => {
    // Клик по ручке без сдвига не должен превращать 40 % по умолчанию в сохранённое число.
    if (height === panel.height) return;
    const ui = useUiStore.getState();
    ui.patchUi({ browser: { ...ui.ui.browser, devtoolsHeight: height } });
  };

  return (
    <div
      ref={rootRef}
      data-tab-id={tabId}
      className="absolute flex flex-col overflow-hidden bg-background"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      onPointerDownCapture={focusOwnTab}
      onFocusCapture={focusOwnTab}
      onKeyDown={(event) => {
        // Esc при фокусе в окне (после клика по ⌖ он на кнопке): в странице Esc ловит сам скрипт выбора.
        if (event.key === 'Escape' && picking) {
          event.preventDefault();
          cancelPick();
          return;
        }
        // ⌘⌥I и ⌘⌥J с фокусом в строке или панели вкладки (спека 2026-10-07, 4.9).
        const action = live ? panelKey(event.nativeEvent) : null;
        if (action === null) return;
        event.preventDefault();
        if (action === 'browser.console') useDevtoolsStore.getState().show(tabId, 'console');
        else useDevtoolsStore.getState().toggle(tabId);
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
        viewport={viewport}
        onViewport={setViewport}
        devtoolsOpen={devtools.open}
        counters={counters}
        onToggleDevtools={() => useDevtoolsStore.getState().toggle(tabId)}
        onClearDevtools={clearDevtools}
      />
      <div ref={fieldRef} data-testid="browser-field" className={cn('relative min-h-0 flex-1 overflow-hidden', stage !== null && 'bg-muted')}>
        {src === null ? (
          <div data-testid="browser-placeholder" className="h-full w-full bg-background" />
        ) : (
          // Белая подложка: гость прозрачен, и страница без своего фона легла бы на тёмную тему окна. При эмуляции —
          // тот же узел, другие класс и стиль: новый узел перезагрузил бы гостя. `src` всегда about:blank: адрес вкладки
          // открывает openFirstPage (вариант D).
          <webview
            ref={setView}
            src={BLANK_SRC}
            className={stage === null ? 'flex h-full w-full bg-white' : 'absolute flex bg-white shadow-md'}
            {...(stage === null ? {} : { style: { left: stage.left, top: stage.top, width: stage.width, height: stage.height } })}
            {...WEBVIEW_ATTRIBUTES}
          />
        )}
        {stage === null ? null : (
          <div
            data-testid="viewport-label"
            className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1 text-[11px] text-muted-foreground"
            style={{ top: stage.top - STAGE.label, height: STAGE.label }}
          >
            <span>{stage.label}</span>
            {touchStale ? (
              <button type="button" onClick={reload} className="pointer-events-auto underline">
                {S.browser.viewport.touchReload}
              </button>
            ) : null}
          </div>
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
      {devtools.open ? (
        <DevtoolsPanel
          tabId={tabId}
          webContentsId={state.webContentsId}
          pageUrl={url}
          bridge={bridge}
          height={panel.height}
          maxHeight={panel.max}
          onResize={commitPanelHeight}
          onReload={reload}
          onClear={clearDevtools}
        />
      ) : null}
    </div>
  );
}
