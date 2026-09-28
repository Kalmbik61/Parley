/**
 * Встроенный браузер (кусок 9.1, спека 12.2, 12.5): общие для main, прелоада и рендерера
 * раздел, форма данных и мост `browser.*`.
 */

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

// Интерфейс растёт вместе с мостом: pickStart и pickCancel добавит 9.3a.
// Объявленные заранее, они не дали бы прелоаду 9.1 пройти pnpm typecheck.
export interface BrowserApi {
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
}
