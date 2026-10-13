/**
 * Встроенный браузер (кусок 9.1, спека 12.2, 12.5): общие для main, прелоада и рендерера
 * раздел, форма данных и мост `browser.*`.
 */
import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody, ViewportSpec } from './browser-devtools.js';
import type { ContextKind } from './context-markdown.js';

/** Единственный раздел `<webview>`: страж main (`main/browser/guard.ts`) другой не пускает. */
export const BROWSER_PARTITION = 'persist:harnas-browser';

/** Компонент React выбранного элемента (спека браузера 3.8): имя до 100 знаков, источник до 300, `approx` — у React 19. */
export interface ReactComponentInfo {
  name: string;
  source: string | null;
  approx: boolean;
}

/** Вьюпорт страницы в момент выбора или метки: CSS-пиксели и devicePixelRatio (спека 3.6, строка Viewport). */
export interface PickViewport {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Точка как доля вьюпорта страницы (0…1). Окно переводит её в свои пиксели по прямоугольнику `<webview>`: масштаб
 * страницы и эмуляция размера в доле не участвуют.
 */
export interface ViewportFraction {
  fx: number;
  fy: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Метка на элементе (спека 4.7): данные на момент метки; роль, имя и React дочитывает main. */
export interface AnnotationElementTarget {
  kind: 'element';
  /**
   * Id цели в мире скрипта меток (`a1`, `a2`…): по нему скрипт рисует номер и идёт за элементом. Уникален только в
   * пределах одного документа: в новом документе скрипт нумерует с `a1` заново, поэтому лоток в `annotateSync` шлёт
   * метки одного, текущего документа — ключ прежнего документа в новом мире назвал бы чужую цель.
   */
  key: string;
  selector: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  role?: string;
  name?: string;
  react?: ReactComponentInfo[];
  anchor: ViewportFraction;
  viewport: PickViewport;
}

/** Рамка области (спека 4.7): прямоугольник в CSS-пикселях документа и до трёх элементов под ней. */
export interface AnnotationRegionTarget {
  kind: 'region';
  /** Как у метки на элементе: уникален только в пределах одного документа. */
  key: string;
  rect: Rect;
  elements: Array<{ selector: string; text: string }>;
  anchor: ViewportFraction;
  viewport: PickViewport;
}

export type AnnotationTarget = AnnotationElementTarget | AnnotationRegionTarget;

/** Ответ `annotateStart`: новая метка или клик по номеру готовой — её правка. */
export type AnnotationPick = AnnotationTarget | { kind: 'edit'; n: number };

/** Метка лотка для перерисовки в странице. */
export interface AnnotationPin {
  n: number;
  key: string;
}

/** Положение метки после перерисовки: прямоугольник цели в долях вьюпорта (`Rect` из долей); `null` — элемента нет. */
export interface AnnotationPosition {
  n: number;
  rect: Rect | null;
}

export interface PickResult {
  url: string;
  selector: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  imagePath: string | null;
  /** Точка, по которой main нашёл узел через CDP (CSS-пиксели вьюпорта; main прибавляет прокрутку); `null` — под точкой не выбранный элемент. */
  point: { x: number; y: number } | null;
  /** Клик с ⇧: Select остаётся включённым (спека браузера 4.6). */
  shift: boolean;
  /** Вьюпорт страницы в момент выбора: строка Viewport файла `element`. */
  viewport: PickViewport;
  /** Роль и доступное имя из дерева доступности (спека 3.8). */
  role?: string;
  name?: string;
  /** До трёх компонентов React снизу вверх. */
  react?: ReactComponentInfo[];
}

/** Favicon гостя (событие browser:favicon, 9.2a): main скачал значок и отдаёт его окну как data:. */
export interface BrowserFavicon {
  webContentsId: number;
  dataUrl: string;
}

/** window.open страницы (событие browser:open-tab): вкладка встаёт рядом с открывателем (9.2b). */
export interface BrowserOpenTab {
  url: string;
  openerWebContentsId: number;
}

/** Файл-контекст для `saveContext` (спека браузера 3.6): готовый Markdown и снимок в `drops/` (или нет). */
export interface ContextInput {
  kind: ContextKind;
  label: string;
  markdown: string;
  imagePath: string | null;
}

/** Где лёг файл-контекст: `.md` и, если был снимок, `.png` рядом. */
export interface SavedContext {
  mdPath: string;
  pngPath: string | null;
}

// Интерфейс растёт вместе с мостом: pickStart и pickCancel — с 9.3a.
export interface BrowserApi {
  /** null — выбор отменён: Esc, pickCancel, навигация главного фрейма, падение или закрытие страницы. */
  pickStart(webContentsId: number): Promise<PickResult | null>;
  pickCancel(webContentsId: number): Promise<void>;
  openDevTools(webContentsId: number): Promise<void>;
  /** Ответ — found-in-page своего requestId с finalUpdate, не дольше 2 с (план); иначе последний промежуточный. */
  find(webContentsId: number, text: string, forward: boolean): Promise<{ matches: number; active: number }>;
  stopFind(webContentsId: number): Promise<void>;
  zoom(webContentsId: number, step: 1 | -1 | 0): Promise<void>;
  clearData(): Promise<void>;
  onOpenTab(listener: (e: BrowserOpenTab) => void): () => void;
  onFavicon(listener: (e: BrowserFavicon) => void): () => void; // спека 12.1
  /** Гость получил фокус (focus его WebContents): окно делает его вкладку активной — клик в страницу DOM окна не видит. */
  onFocus(listener: (e: { webContentsId: number }) => void): () => void;
  /** Файл-контекст в `drops/context/` (спека браузера 3.6): main проверяет форму и снимок, сам выбирает имя. */
  saveContext(input: ContextInput): Promise<SavedContext>;
  /** Одна метка аннотаций (спека браузера 4.7); окно зовёт снова, пока режим включён. null — Esc, навигация, отмена. */
  annotateStart(webContentsId: number): Promise<AnnotationPick | null>;
  annotateCancel(webContentsId: number): Promise<void>;
  /** Перерисовать метки страницы по лотку (пункты её документа) и узнать, где они (доли вьюпорта) и какие элементы пропали. */
  annotateSync(webContentsId: number, pins: AnnotationPin[]): Promise<AnnotationPosition[]>;
  /** Снимок страницы с номерами меток в `drops/`; меток на странице нет — `null`. */
  annotateCapture(webContentsId: number): Promise<{ path: string | null }>;
  /**
   * Журнал консоли и сети гостя (спека 2026-10-07-browser-devtools-agent-design.md, 3.5). Журнала нет (захват не
   * подключался) — пустой с `capture: 'unavailable'`.
   */
  devtoolsSnapshot(webContentsId: number): Promise<DevtoolsSnapshot>;
  devtoolsClear(webContentsId: number): Promise<void>;
  /**
   * Захват включён (спайк 0.1, вариант D): все `enable` ответили, отказали или вышли по тайм-ауту. `<webview>` стартует
   * с about:blank; окно зовёт это на его первый `dom-ready` и только потом открывает адрес вкладки, иначе подресурсы
   * первой загрузки прошли бы мимо журнала. Журнала нет — готово сразу.
   */
  devtoolsReady(webContentsId: number): Promise<void>;
  /** Тело ответа до 1 МБ (`DEVTOOLS_LIMITS.panelBody`); null — Chromium его уже вытеснил. */
  responseBody(webContentsId: number, requestId: string): Promise<ResponseBody | null>;
  /** Пачки журнала всех гостей окна (событие browser:devtools); вкладка берёт свои по webContentsId. */
  onDevtools(listener: (batch: DevtoolsBatch) => void): () => void;
  /** Размер вьюпорта (спека 4.2), null — Fit; area — место под страницу в поле вкладки. Ответ — вписывание. */
  setViewport(webContentsId: number, spec: ViewportSpec | null, area: { width: number; height: number }): Promise<{ scale: number }>;
}
