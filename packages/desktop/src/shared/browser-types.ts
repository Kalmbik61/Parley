/**
 * Встроенный браузер (кусок 9.1, спека 12.2, 12.5): общие для main, прелоада и рендерера
 * раздел, форма данных и мост `browser.*`.
 */
import type { DevtoolsBatch, DevtoolsSnapshot, ResponseBody, ViewportSpec } from './browser-devtools.js';

/** Единственный раздел `<webview>`: страж main (`main/browser/guard.ts`) другой не пускает. */
export const BROWSER_PARTITION = 'persist:harnas-browser';

export interface PickResult {
  url: string;
  selector: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  imagePath: string | null;
  thumbnail: string | null; // 9.3a: уменьшенный data:image/png для карточки
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
