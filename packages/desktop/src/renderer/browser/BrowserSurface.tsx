// packages/desktop/src/renderer/browser/BrowserSurface.tsx
/**
 * Поверхность вкладки браузера (кусок 9.2a, спека 12.1, 12.2): строка над страницей и
 * `<webview>` в слое поверхностей работы (`layout/SurfaceLayer.tsx`), привязанные CSS-якорем к телу
 * группы — как у терминала. Перенос вкладки меняет только якорь: узел `<webview>` в DOM не
 * переносится, иначе гость перезагрузился бы. Это держит сортировка слоя по id вкладки (2.5).
 *
 * Место поверхности (`BrowserPlace`, этап B2, спека браузера 3.10): вкладка раскладки или страница панели браузера хозяина
 * (`panel/PanelSurface.tsx`). Страница панели — тот же браузер, но она заполняет поле своей панели, адрес и размер пишет в
 * запись панели (`panels`), а цель «To» закреплена за хозяином: меню «To» и «Move to browser of…» у неё нет.
 *
 * Страница — недоверенная: мостов окна и Node в госте нет (страж main, 9.1), а рендерер зовёт
 * у `<webview>` только навигацию — `loadURL`, `goBack`, `goForward`, `reload`, `stop`.
 * Программный доступ к странице — только у main (спека 12.2): Select и Annotate (этап B) тоже идут мостом —
 * `pickStart`, `annotateStart` и соседи, а не `executeJavaScript` у `<webview>`.
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
 *
 * Цель «To» (этап B, спека браузера 4.5): сессия или комната, куда лягут «Add to chat», Select и аннотации. Хранится в
 * раскладке (`TabSpec.target`, нет поля — умолчание); `usePageContext` разрешает её, откатывает пропавшую с тостом и
 * ведёт очередь добавлений, меню `TargetMenu` стоит в строке вкладки. «Add to chat» панели Console | Network (запись
 * консоли, запрос, все ошибки) — `context/actions.ts`: слоты `DevtoolsPanel` ведут их в `usePageContext().add`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { ParleyBridge } from '../../shared/bridge.js';
import { viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import { BROWSER_PARTITION, type PickResult, type ViewportFraction } from '../../shared/browser-types.js';
import { viewportNote } from '../../shared/context-markdown.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { ACTIONS, matchesAccelerator, type ActionId, type KeyLike } from '../../shared/keybindings.js';
import type { BrowserOwner, BrowserTarget } from '../../shared/layout-types.js';
import { errorText, S } from '../../shared/strings.js';
import { cn } from '../lib/cn.js';
import { ownerOfPage, panelOf, updatePanelPage, type PanelPagePatch } from '../layout/panels.js';
import { useLayoutStore } from '../layout/store.js';
import { focusTab, updateTab } from '../layout/tree.js';
import { useUiStore } from '../store/ui.js';
import { isHttpUrl } from '../terminal/links.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { AnnotationEditor } from './annotate/AnnotationEditor.js';
import { AnnotationTray } from './annotate/AnnotationTray.js';
import { EMPTY_ANNOTATE, useAnnotateStore } from './annotate/store.js';
import { addAnnotationsToChat, cancelMark, saveDraft, syncPins, useAnnotateMode } from './annotate/use-annotate-mode.js';
import { BrowserChrome } from './BrowserChrome.js';
import { createPageContextActions, elementDraft } from './context/actions.js';
import { TargetMenu } from './context/TargetMenu.js';
import { targetName } from './context/targets.js';
import { usePageContext } from './context/use-page-context.js';
import { DevtoolsPanel } from './devtools/DevtoolsPanel.js';
import { devtoolsCounters, EMPTY_DEVTOOLS, useDevtoolsStore } from './devtools/store.js';
import { useDevtoolsFeed } from './devtools/use-devtools-feed.js';
import { FindBar } from './FindBar.js';
import { reportAgentPage } from './panel/agent-registry.js';
import { moveTabToPanel, pausePanel } from './panel/actions.js';
import { MoveToMenu } from './panel/MoveToMenu.js';
import { fitArea, panelHeight, STAGE, stageBox, type FieldSize } from './stage.js';
import { clearAddressFocus, toggleBrowserMode, useBrowserStore, wantsAddressFocus, type BrowserTabState } from './store.js';
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
 * Клавиши панели, Select и Annotate (спека 2026-10-07, 4.9) — из реестра. В странице их пересылает main; с фокусом в
 * строке или панели вкладки — этот обработчик: рендерер окна действия `browser` не ловит (`keys/handler.ts#whenAllows`).
 */
const PANEL_KEYS = ACTIONS.filter(
  (action) => action.id === 'browser.devtools' || action.id === 'browser.console' || action.id === 'browser.select' || action.id === 'browser.annotate',
);

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

/**
 * Место поверхности (спека браузера 3.10): вкладка раскладки или страница панели хозяина.
 * - Вкладка встаёт CSS-якорем на тело своей группы, цель «To» у неё своя (нет поля — умолчание).
 * - Страница панели заполняет поле под полоской страниц (`browser/panel/PanelSurface.tsx`), а цель «To» закреплена за
 *   хозяином: контекст из браузера чата уходит в этот чат, из браузера комнаты — в комнату. Меню «To» нет.
 */
export type BrowserPlace =
  | { kind: 'tab'; tabId: string; groupId: string; target?: BrowserTarget | undefined }
  | { kind: 'panel'; owner: BrowserOwner; pageId: string };

export interface BrowserSurfaceProps {
  workKey: string;
  place: BrowserPlace;
  /** Адрес вкладки или страницы панели из раскладки; '' — новая страница. */
  url: string;
  /** Размер вьюпорта (`TabSpec.viewport` или `BrowserPanelPage.viewport`, спека 2026-10-07, 4.2); null — Fit. */
  viewport: ViewportSpec | null;
  visible: boolean;
  bridge: ParleyBridge;
  /** Работа вкладки: сессии и комнаты цели «To» (этап B). */
  entry: WorkEntry;
  /** Отправка агенту окна — строке в ввод CLI сессии без Chat (этап B). */
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
  mode: 'off',
};

export function BrowserSurface({ workKey, place, url, viewport, visible, bridge, entry, sendDeps }: BrowserSurfaceProps): JSX.Element {
  // Ключ записей стора вкладок, журнала и меток: id вкладки или страницы панели (оба случайные на всё окно, `layout/ids.ts`).
  const tabId = place.kind === 'tab' ? place.tabId : place.pageId;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<WebviewElement | null>(null);
  const readyRef = useRef(false);
  // Адрес вкладки уже открывали после захвата (спайк 0.1): повторные dom-ready страницы его не открывают.
  const firstPageRef = useRef(false);
  const state = useBrowserStore((store) => store.tabs[tabId]) ?? IDLE;
  const pageContext = usePageContext({
    bridge,
    workKey,
    tabId,
    entry,
    stored: place.kind === 'tab' ? place.target : undefined,
    ...(place.kind === 'panel' ? { fixed: place.owner } : {}),
    sendDeps,
  });
  // Адрес и размер живут в раскладке: у вкладки — её поля, у страницы панели — запись панели хозяина.
  const placeRef = useRef(place);
  placeRef.current = place;
  const patchPage = useCallback(
    (patch: PanelPagePatch): void => {
      useLayoutStore.getState().apply(workKey, (layout) => {
        const at = placeRef.current;
        return at.kind === 'tab' ? updateTab(layout, at.tabId, patch) : updatePanelPage(layout, at.owner, at.pageId, patch);
      });
    },
    [workKey],
  );
  // Адрес страницы на момент клика «Add to chat»: TabSpec.url, его ведёт сама поверхность.
  const urlRef = useRef(url);
  urlRef.current = url;
  const contextActions = useMemo(
    () =>
      createPageContextActions({
        bridge,
        webContentsId: () => useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null,
        pageUrl: () => urlRef.current,
        devtools: () => useDevtoolsStore.getState().tabs[tabId] ?? EMPTY_DEVTOOLS,
        add: pageContext.add,
      }),
    [bridge, tabId, pageContext.add],
  );

  // Select (спека браузера 4.6): выбор за выбором, пока режим включён; ⇧-клик режим держит, обычный клик снимает.
  // Каждый элемент — файл-контекст в цель «To»: одна очередь на вкладку, чипы — в порядке кликов.
  const selecting = state.mode === 'select' && state.webContentsId !== null;
  const addRef = useRef(pageContext.add);
  addRef.current = pageContext.add;
  const noteRef = useRef<string | null>(null);
  noteRef.current = viewportNote(viewport);
  useEffect(() => {
    const id = useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null;
    if (!selecting || id === null) return undefined;
    let alive = true;
    const off = (): void => useBrowserStore.getState().update(tabId, { mode: 'off' });
    void (async () => {
      while (alive) {
        let result: PickResult | null;
        try {
          result = await bridge.browser.pickStart(id);
        } catch (error) {
          if (!alive) return;
          console.error('[parley] pickStart failed', error);
          toast(errorText(decodeIpcError(error).code, S.errors.actions.pickElement));
          off();
          return;
        }
        // Режим сняли (⌖, Esc в окне, навигация, скрытая вкладка) — поздний ответ ничего не добавляет.
        if (!alive) return;
        if (result === null) {
          off();
          return;
        }
        void addRef.current(elementDraft(result, noteRef.current));
        if (!result.shift) {
          off();
          return;
        }
      }
    })();
    return () => {
      alive = false;
      bridge.browser.pickCancel(id).catch((error: unknown) => console.warn('[parley] pickCancel failed', error));
    };
  }, [selecting, bridge, tabId]);

  // Annotate (спека браузера 4.7): цикл меток и метки страницы — по лотку; лоток вкладки живёт, пока жива вкладка.
  const annotate = useAnnotateStore((store) => store.tabs[tabId]) ?? EMPTY_ANNOTATE;
  useAnnotateMode({ bridge, tabId, webContentsId: state.webContentsId, active: state.mode === 'annotate', urlRef });
  useEffect(() => () => useAnnotateStore.getState().drop(tabId), [tabId]);
  const [annotateBusy, setAnnotateBusy] = useState(false);
  const pageId = (): number | null => useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null;

  // Редактор закрыт (Save, Delete, Esc) или лоток исчез («Add to chat», Clear): снятое поле или кнопка держали фокус, он падает
  // на body, и клавиши корня (Esc, ⌘⌥A) перестают приходить. Возвращаем его странице — следующая метка и так там. Чужой фокус
  // (адресная строка, поле чата) не трогаем.
  const editorOpen = annotate.editing !== null;
  const trayShown = annotate.items.length > 0;
  const overlays = useRef({ editorOpen: false, trayShown: false });
  useEffect(() => {
    const was = overlays.current;
    overlays.current = { editorOpen, trayShown };
    if (!(was.editorOpen && !editorOpen) && !(was.trayShown && !trayShown)) return;
    const holder = document.activeElement;
    if (holder === null || holder === document.body) viewRef.current?.focus();
  }, [editorOpen, trayShown]);

  /**
   * Метка → точка в поле страницы (`fieldRef` A): доля вьюпорта по прямоугольнику `<webview>` — при эмуляции он стоит по
   * центру поля и уменьшен — плюс его сдвиг в поле, как `getBrowserOverlayAnchor` у Orca. Край поля и переворот
   * редактора вверх держит Radix (`AnnotationEditor`, `collisionBoundary`).
   */
  const anchorAt = (anchor: ViewportFraction): { left: number; top: number } => {
    const page = fieldRef.current?.getBoundingClientRect();
    const view = viewRef.current?.getBoundingClientRect();
    if (page === undefined || view === undefined) return { left: 0, top: 0 };
    return { left: view.left - page.left + anchor.fx * view.width, top: view.top - page.top + anchor.fy * view.height };
  };

  // ✎ в строке лотка: положение метки — с прошлой перерисовки, а страницу могли прокрутить; редактор открывается после свежей.
  const editAnnotation = (n: number): void => {
    const open = (): void => {
      // Вкладку могли закрыть, пока шла перерисовка.
      if (useAnnotateStore.getState().tabs[tabId] === undefined) return;
      saveDraft(tabId);
      useAnnotateStore.getState().startEdit(tabId, n);
    };
    const id = pageId();
    if (id === null) open();
    else void syncPins(bridge, tabId, id).then(open);
  };

  const addAnnotations = (): void => {
    setAnnotateBusy(true);
    void addAnnotationsToChat({
      bridge,
      tabId,
      webContentsId: pageId(),
      pageUrl: urlRef.current,
      viewportNote: noteRef.current,
      add: pageContext.add,
    }).finally(() => setAnnotateBusy(false));
  };

  // Скрытую вкладку человек не видит: Select и Annotate в ней снимаются, а не едят клики страницы до возврата.
  useEffect(() => {
    if (!visible && state.mode !== 'off') useBrowserStore.getState().update(tabId, { mode: 'off' });
  }, [visible, state.mode, tabId]);

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
  const { applied, failed: viewportFailed, retry: retryViewport } = useViewport({
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

  // Якорные свойства — через `setProperty`, как у терминала: в `CSSProperties` @types/react 18 их нет. Страница панели
  // якоря не ставит: она заполняет поле своей панели (`inset-0` на корне).
  const groupId = place.kind === 'tab' ? place.groupId : null;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null || groupId === null) return;
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
      if (safe !== null) patchPage({ url: safe });
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
      // Режим Select или Annotate прошлой страницы к новой не относится; main и сам ответит выбору null.
      // Касания у нового документа — как у эмуляции в этот миг (спайк 0.3); пустая страница документом вкладки не считается.
      'did-navigate': (event) => {
        saveUrl(event.url);
        if (event.url !== BLANK_SRC) setDocMobile(appliedMobileRef.current);
        update({ title: null, favicon: null, mode: 'off' });
        // Новый документ: меток на странице больше нет, данные в лотке остаются.
        useAnnotateStore.getState().markAllGone(tabId);
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
  }, [bridge, src, tabId, workKey, patchPage]);

  // Favicon качает main (CSP окна внешних картинок не пускает) и шлёт всем вкладкам окна; своя — по id гостя.
  useEffect(
    () =>
      bridge.browser.onFavicon((event) => {
        const own = useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null;
        if (own !== null && event.webContentsId === own) useBrowserStore.getState().update(tabId, { favicon: event.dataUrl });
      }),
    [bridge, tabId],
  );

  // Снимок агента (спека 4.8; спайк 0.2): `start` с `capture` — размер, в котором страницу снимают; пока он идёт, на видимой
  // странице висит подпись «Agent capture W×H», а невидимую поверхность окно делает «видимой, но прозрачной»: у скрытого
  // `<webview>` кадр не рисуется, у `opacity: 0` — рисуется.
  const [agentCapture, setAgentCapture] = useState<{ width: number; height: number } | null>(null);
  useEffect(
    () =>
      bridge.browser.onAgentActivity((event) => {
        const own = useBrowserStore.getState().tabs[tabId]?.webContentsId ?? null;
        if (own === null || event.webContentsId !== own) return;
        if (event.phase === 'end') setAgentCapture(null);
        else if (event.capture !== undefined) setAgentCapture(event.capture);
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
    if (safe !== null) patchPage({ url: safe });
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
    // Повторный выбор того же пресета не меняет ни раскладку, ни эмуляцию — если прошлая попытка удалась.
    // После отказа тот же выбор (в том числе Fit) шлёт команды заново.
    if (sameViewport(next, viewport)) {
      if (viewportFailed) retryViewport();
      return;
    }
    patchPage({ viewport: next });
  };

  // Поверхность — сосед тела группы, а не потомок: клик в строку сама делает свою вкладку активной. Страница панели
  // вкладки не имеет: вид хозяина фокусирует вся панель (`PanelSurface`).
  const focusOwnTab = (): void => {
    if (place.kind !== 'tab') return;
    useLayoutStore.getState().apply(workKey, (layout) => focusTab(layout, tabId));
  };

  // «⋯ → Move to browser of…» (спека браузера 3.10): адрес и размер уходят в панель хозяина, вкладка закрывается.
  const moveToPanel = (owner: BrowserOwner): void => {
    if (place.kind !== 'tab') return;
    if (moveTabToPanel(workKey, place.tabId, owner) === null) toast(S.browser.panel.moved(targetName(entry, owner)));
  };

  // Страница панели для main (реестр агента, этап C): гость и видимость — точно то, что видит человек. Вкладки человека агенту закрыты.
  const panelOwner = place.kind === 'panel' ? place.owner : null;
  const panelPageId = place.kind === 'panel' ? place.pageId : null;
  const panelPaused = useLayoutStore((store) => {
    const layout = store.layouts[workKey];
    return panelOwner !== null && layout !== undefined && panelOf(layout, panelOwner)?.paused === true;
  });
  useEffect(() => {
    if (panelOwner === null || panelPageId === null) return;
    reportAgentPage(bridge, workKey, panelOwner, panelPageId, state.webContentsId, visible);
  }, [bridge, workKey, panelOwner, panelPageId, state.webContentsId, visible]);
  // Панель выгружена, а страница в раскладке жива — main помнит её без гостя. Закрытую страницу воскрешать нельзя:
  // `gone` уже ушёл от подписчика на раскладки, раньше размонтирования.
  useEffect(() => {
    if (panelOwner === null || panelPageId === null) return;
    return () => {
      const layout = useLayoutStore.getState().layouts[workKey];
      if (layout !== undefined && ownerOfPage(layout, panelPageId) !== null) reportAgentPage(bridge, workKey, panelOwner, panelPageId, null, false);
    };
  }, [bridge, workKey, panelOwner, panelPageId]);

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
      className={cn('absolute flex flex-col overflow-hidden bg-background', place.kind === 'panel' && 'inset-0')}
      style={visible ? { visibility: 'visible' } : agentCapture !== null ? { visibility: 'visible', opacity: 0, pointerEvents: 'none' } : { visibility: 'hidden' }}
      onPointerDownCapture={focusOwnTab}
      onFocusCapture={focusOwnTab}
      onKeyDown={(event) => {
        // Esc при фокусе в окне (после клика по ⌖ или ✎ он на кнопке): в странице Esc ловит сам скрипт. Esc, который уже
        // закрыл меню Radix (его события идут по дереву React сквозь портал, в том числе из меню «To») или полосу поиска,
        // помечен preventDefault — режим он не выключает. Так же с открытым редактором метки: слой Radix гасит каждый Esc
        // окна для себя, и вне редактора (заголовок лотка, адресная строка) он ни отменяет метку, ни выключает режим — редактор
        // владеет Esc, набранное не пропадает; отменяет Esc в самом поле (`AnnotationEditor`, не доходит сюда).
        if (event.key === 'Escape' && !event.defaultPrevented && state.mode !== 'off') {
          event.preventDefault();
          useBrowserStore.getState().update(tabId, { mode: 'off' });
          return;
        }
        // ⌘⌥I и ⌘⌥J с фокусом в строке или панели вкладки (спека 2026-10-07, 4.9).
        const action = live ? panelKey(event.nativeEvent) : null;
        if (action === null) return;
        event.preventDefault();
        if (action === 'browser.select' || action === 'browser.annotate') {
          // Удержанная клавиша шлёт автоповтор (`repeat`): режим переключает только первое нажатие, а не мигает вкл и выкл.
          if (!event.repeat) toggleBrowserMode(tabId, action === 'browser.select' ? 'select' : 'annotate');
          return;
        }
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
        mode={state.mode}
        onSelect={() => toggleBrowserMode(tabId, 'select')}
        onAnnotate={() => toggleBrowserMode(tabId, 'annotate')}
        viewport={viewport}
        onViewport={setViewport}
        devtoolsOpen={devtools.open}
        counters={counters}
        onToggleDevtools={() => useDevtoolsStore.getState().toggle(tabId)}
        onClearDevtools={clearDevtools}
        {...(place.kind === 'tab'
          ? {
              targetMenu: <TargetMenu entry={entry} target={pageContext.target} onChange={pageContext.setTarget} />,
              moveMenu: <MoveToMenu entry={entry} onMove={moveToPanel} />,
            }
          : {
              paused: panelPaused,
              onPause: (next: boolean) => pausePanel(workKey, place.owner, next),
            })}
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
        {agentCapture !== null && visible ? (
          <div data-testid="agent-capture" className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground shadow-sm">
            {S.browser.panel.agentCapture(agentCapture.width, agentCapture.height)}
          </div>
        ) : null}
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
        {!visible || annotate.editing === null ? null : (
          // Редактор — только у видимой вкладки: слой Radix (DismissableLayer) ловит Esc на документе и помечает его preventDefault,
          // пока смонтирован, в том числе у скрытой поверхности — тогда ветка Esc корня видимой вкладки (выше) не выключала бы
          // Select и Annotate. Черновик остаётся в сторе и возвращается вместе с вкладкой. Остаток: две группы рядом показывают
          // две вкладки сразу, и редактор в группе, где человек сейчас не работает, по-прежнему гасит Esc в другой.
          <AnnotationEditor
            key={`${annotate.editing.n}:${annotate.editing.isNew ? 'new' : 'edit'}`}
            n={annotate.editing.n}
            draft={annotate.editing.draft}
            anchor={anchorAt(annotate.editing.anchor)}
            container={fieldRef.current}
            onDraft={(text) => useAnnotateStore.getState().setDraft(tabId, text)}
            onSave={() => useAnnotateStore.getState().save(tabId)}
            onDelete={() => {
              const editing = useAnnotateStore.getState().tabs[tabId]?.editing ?? null;
              if (editing === null) return;
              // Delete новой метки — та же отмена, что Esc; готовой — удаление пункта.
              if (editing.isNew) void cancelMark(bridge, tabId, pageId());
              else useAnnotateStore.getState().remove(tabId, editing.n);
            }}
            onCancel={() => void cancelMark(bridge, tabId, pageId())}
          />
        )}
        {annotate.items.length === 0 ? null : (
          <AnnotationTray
            items={annotate.items}
            collapsed={annotate.collapsed}
            busy={annotateBusy}
            visible={visible}
            onToggle={() => useAnnotateStore.getState().setCollapsed(tabId, !annotate.collapsed)}
            onEdit={editAnnotation}
            onDelete={(n) => {
              saveDraft(tabId);
              useAnnotateStore.getState().remove(tabId, n);
            }}
            onClear={() => {
              saveDraft(tabId);
              useAnnotateStore.getState().clear(tabId);
            }}
            onAddToChat={addAnnotations}
          />
        )}
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
          onAddConsoleToChat={contextActions.console}
          onAddRequestToChat={contextActions.request}
          onAddErrorsToChat={contextActions.errors}
        />
      ) : null}
    </div>
  );
}
