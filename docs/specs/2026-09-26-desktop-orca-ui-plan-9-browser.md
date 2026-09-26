# План, этап 9: браузер и Design Mode

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 12, строка 9 таблицы 14.3, раздел 1.3
(критерии MVP).

**Итог этапа:**
- вкладка браузера со страницами разработки, защищённая по спеке 12.2;
- Design Mode: выбрать элемент страницы и отдать его агенту одним действием;
- приёмка всего MVP.

**Перед стартом.** Сверить с кодом прошлых этапов:
- `main/window.ts` (`webPreferences`, где `createMainWindow` зовёт `loadFile`),
  `main/index.ts` (порядок создания окна и регистрации IPC), `main/guest-shortcuts.ts`
  (6.1);
- `layout/SurfaceLayer.tsx` (слой поверхностей), `layout/ids.ts#tabId.browser`,
  `layout/tree.ts#updateTab`, `layout/use-tab-meta-extras.ts`;
- `palette/actions.ts` (`ActionContext`), действия `browser.*` в `shared/keybindings.ts`;
- `terminal/links.ts` и `files/preview/MarkdownPreview.tsx` — ссылки, которые теперь
  открывают браузер;
- `terminal/send.ts`, `main/drops.ts`.

---

## 9.1. Защита `<webview>` и мост браузера

**Зачем.** Страницы из сети живут в клетке: без Node, без preload, без разрешений, без
окон, без доступа к диску.
**Зависит от:** 6.1. **Спека:** 12.2, 12.5.

**Файлы**
- Создать:
  - `packages/desktop/src/main/browser/guard.ts` и тест;
  - `packages/desktop/src/renderer/browser/url.ts` и тест;
  - `packages/desktop/src/shared/browser-types.ts`.
- Изменить:
  - `src/main/window.ts` и тест — `webviewTag: true`; `createMainWindow` вешает
    `guardWebviewAttach` до `loadFile`; тест 1 куска 2.3 («`webviewTag` не задан»)
    меняется на `true`;
  - `src/main/index.ts` — `installBrowserGuard` до создания окна,
    `forwardGuestShortcuts` для гостей;
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` — группа
    `browser`: `openDevTools`, `clearData`, `onOpenTab`, `find`, `stopFind`, `zoom`;
  - `renderer/test-utils/fake-bridge.ts` — заглушки `browser.*`, эмиттер
    `emitBrowserOpenTab`;
  - `renderer/components/settings/SettingsDialog.tsx` — секция «Браузер» с «Очистить
    данные браузера».

**Интерфейсы**

```ts
// shared/browser-types.ts
export const BROWSER_PARTITION = 'persist:harnas-browser';
export interface PickResult {
  url: string; selector: string; text: string; html: string; styles: Record<string, string>;
  imagePath: string | null;
  thumbnail: string | null;   // 9.3: уменьшенный data:image/png для карточки
}
// Интерфейс растёт вместе с мостом: onFavicon добавит 9.2, pickStart и pickCancel — 9.3.
// Объявленные заранее, они не дали бы прелоаду 9.1 пройти pnpm typecheck.
export interface BrowserApi {
  openDevTools(webContentsId: number): Promise<void>;
  find(webContentsId: number, text: string, forward: boolean): Promise<{ matches: number; active: number }>;
  stopFind(webContentsId: number): Promise<void>;
  zoom(webContentsId: number, step: 1 | -1 | 0): Promise<void>;
  clearData(): Promise<void>;
  onOpenTab(listener: (url: string) => void): () => void;
}

// main/browser/guard.ts
export type NavVerdict = 'allow' | 'deny';
/**
 * Главный фрейм: только http, https и about:blank. Подфрейм: ещё about:srcdoc, data: и blob: —
 * у них непрозрачное или своё происхождение, к диску доступа нет. file:, javascript:,
 * chrome: и прочее — deny везде.
 */
export function navigationVerdict(url: string, frame: 'main' | 'sub'): NavVerdict;
/** Правка webPreferences на will-attach-webview; false — подключение запрещено. */
export function sanitizeWebviewAttach(webPreferences: Record<string, unknown>, params: { partition?: string; src?: string }): boolean;
/** will-attach-webview главного окна: createMainWindow зовёт до loadFile. */
export function guardWebviewAttach(contents: Pick<WebContents, 'on'>): void;
export function installBrowserGuard(deps: {
  app: Pick<App, 'on'>;
  isMainWindow(contents: WebContents): boolean;
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>;  // раздел BROWSER_PARTITION
  openTab(url: string): void;                     // → окно, событие browser:open-tab
  forwardShortcuts(contents: WebContents): void;  // 6.1
}): void;

// renderer/browser/url.ts — таблица спеки 12.1
export type NormalizedUrl =
  | { ok: true; url: string }
  | { ok: false; error: 'Введите адрес — поиска нет' | 'Локальные файлы здесь не открываются' };
export function normalizeUrl(input: string): NormalizedUrl;
```

**Поведение**
- **Порядок установки.** Сейчас `main/index.ts` создаёт окно раньше, чем регистрирует
  IPC. Страж рядом с IPC опоздал бы: окно с `webviewTag: true` уже загружено, а
  `will-attach-webview` без обработчика прикрепит `<webview>` с `preload` или
  `nodeintegration` из атрибутов. Поэтому:
  - `createMainWindow` вешает `guardWebviewAttach` на своё `webContents` до `loadFile`;
  - `installBrowserGuard` ставится до создания окна.
- **Главное окно**, событие `will-attach-webview` (`sanitizeWebviewAttach`):
  - удаляются `preload` и `preloadURL`;
  - `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`,
    `contextIsolation: true`, `sandbox: true`, `webSecurity: true`,
    `allowRunningInsecureContent: false`, `webviewTag: false`;
  - `enableBlinkFeatures` и `experimentalFeatures` снимаются: их мог включить атрибут
    `webpreferences`;
  - `partition` не `BROWSER_PARTITION` или `src` не `http(s)` — `preventDefault`.
    Пустого `src` не бывает: `<webview>` монтируется только с адресом (9.2).
- **Любой другой `webContents`** (гость, DevTools) — `will-attach-webview` →
  `preventDefault`: вложенный `<webview>` мимо стража не прикрепится.
- **`file:` во встроенный браузер не пускается вовсе** (спека 12.1, 12.2):
  - у схемы `file:` в Electron лишние права — фьюз `GrantFileProtocolExtraPrivileges`
    включён по умолчанию, `electron-builder.yml` его не меняет. Страница `file://`
    делает `fetch` к любому `file://`: HTML, который агент положил в worktree, прочёл бы
    `~/.ssh/*` и отправил в сеть. Подзагрузки — не навигация, проверка навигации их не
    видит;
  - поэтому `file:` запрещён в адресной строке (`normalizeUrl`), в навигации всех
    фреймов и в `window.open`. Локальный HTML смотрят превью файла (7.5) или системным
    браузером — цена решения.
- **Гость** (`contents.getType() === 'webview'`):
  - `setWindowOpenHandler` → `deny` и `openTab(url)`, если
    `navigationVerdict(url, 'main') === 'allow'`;
  - `will-navigate`, `will-redirect` и `will-frame-navigate` (все фреймы, по
    `isMainFrame`) с `deny` — `preventDefault`;
  - `did-start-navigation` ловит и программную навигацию (`src`, `loadURL`), на которую
    `will-navigate` не срабатывает: `deny` → `contents.stop()`;
  - `forwardShortcuts`.
- **Сессия раздела:** все запросы и проверки разрешений — отказ.
  `certificate-error` не перехватывается.
- **Мост** проверяет `webContentsId`: `webContents.fromId(id)` существует, тип
  `webview`, раздел — `BROWSER_PARTITION`. Иначе ошибка.
- **`clearData`** — `clearStorageData()` и `clearCache()` раздела.
- **Спайк** (результат — в описании коммита): страница `http://127.0.0.1:<порт>` с
  `<iframe src="file:///etc/hosts">`, `location.href = 'file:///etc/hosts'` и
  `window.open('file:///etc/hosts')` — ничего не загрузилось; `<webview
  src="file:///etc/hosts">`, вставленный в окно из DevTools, не прикрепился.

**Тесты**
1. `normalizeUrl`: `localhost:3000/x` → `http://localhost:3000/x`; `127.0.0.1` →
   `http://127.0.0.1`; `example.com` → `https://example.com`;
   `https://a.b/c?d` — как есть; `привет мир` → ошибка; `javascript:alert(1)` →
   ошибка; `file:///etc/passwd` → «Локальные файлы здесь не открываются».
2. `navigationVerdict`:
   - `https://x` → `allow`;
   - `file:///etc/passwd` → `deny` и для главного фрейма, и для подфрейма;
   - `about:blank` → `allow`; `about:srcdoc` → подфрейм `allow`, главный `deny`;
   - `data:text/html,…` → главный `deny`, подфрейм `allow`;
   - `javascript:x`, `chrome://gpu` → `deny`.
3. `sanitizeWebviewAttach` вычищает `preload` и `preloadURL`, ставит флаги с
   `webviewTag: false`, снимает `enableBlinkFeatures` и `experimentalFeatures`; чужой
   `partition` и `src` `file:///x` → `false`.
4. `installBrowserGuard` на подставных объектах:
   - `setWindowOpenHandler` гостя отдаёт `deny` и зовёт `openTab`; `window.open` на
     `file:` — `deny` без `openTab`;
   - `permissionRequest` → `callback(false)`;
   - `will-attach-webview` гостя → `preventDefault`;
   - `will-frame-navigate` подфрейма на `file:` → `preventDefault`;
   - `did-start-navigation` на `file:` → `stop()`.
5. `mainWindowOptions` — `webviewTag: true`, остальное как в 2.3.
6. `createMainWindow` на подставном `BrowserWindow`: `will-attach-webview` подписан
   раньше вызова `loadFile`.
7. Мост: `openDevTools` с id главного окна → ошибка.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Спайк выполнен, результат записан в описании коммита.

---

## 9.2. Вкладка браузера

**Зачем.** Страница разработки рядом с агентом, в той же раскладке.
**Зависит от:** 9.1. **Спека:** 12.1, 12.4.

**Файлы**
- Создать в `packages/desktop/src/renderer/browser/`:
  - `BrowserSurface.tsx`, `BrowserChrome.tsx`, `AddressBar.tsx` и тесты;
  - `store.ts` и тест.
- Создать: `packages/desktop/src/main/browser/favicon.ts` и тест.
- Изменить в `packages/desktop/src/`:
  - `main/browser/guard.ts` — `page-favicon-updated` гостя → `fetchFavicon` → событие
    `browser:favicon` окну;
  - `shared/browser-types.ts`, `shared/bridge.ts`, `preload/index.ts` —
    `browser.onFavicon`;
  - `renderer/test-utils/fake-bridge.ts` — `onFavicon` и эмиттер `emitFavicon`;
  - `renderer/layout/SurfaceLayer.tsx` — поверхности вида `browser`;
  - `renderer/layout/bodies/` — тело `browser`: заглушка, сама страница в слое;
  - `renderer/layout/use-tab-meta-extras.ts` — `browser` из `browser/store.ts`: заголовок
    и favicon (4.2);
  - `renderer/palette/actions.ts`, `renderer/keys/handler.ts` — `browser.newTab`,
    `browser.find`, `browser.zoomIn`, `browser.zoomOut`, `browser.zoomReset` доступны и
    выполняются, в `ActionContext` — `browser`;
  - `renderer/terminal/links.ts`, `renderer/terminal/LinkMenu.tsx` — ⌘-клик по URL и
    «Открыть в браузере» открывают вкладку браузера; «Открыть в системном браузере» —
    пункт меню;
  - `renderer/files/preview/MarkdownPreview.tsx` — `http(s)` открываются во вкладке
    браузера.

**Интерфейсы**

```ts
// browser/store.ts
export interface BrowserTabState {
  url: string; title: string | null; favicon: string | null;   // favicon — data: из main
  loading: boolean; canGoBack: boolean; canGoForward: boolean;
  crashed: boolean; webContentsId: number | null;
  findOpen: boolean;
  pick: 'off' | 'picking' | { result: PickResult };   // 9.3
}
export interface BrowserState {
  tabs: Record<string /* tabId */, BrowserTabState>;
  update(tabId: string, patch: Partial<BrowserTabState>): void;
  remove(tabId: string): void;
}
export const BROWSER_LIMITS: { tabsPerWork: 10 };
/**
 * Открыть адрес ('' — новая вкладка без страницы) в активной работе. Считает вкладки browser
 * раскладки до apply: десятая есть — тост и 'limit'; OpError для этого не нужен.
 */
export function openBrowserTab(url: string, deps: {
  apply: LayoutState['apply']; layouts: LayoutState['layouts']; activeWorkKey: string | null; toast(text: string): void;
}): 'opened' | 'limit';

// shared/browser-types.ts, дополнение BrowserApi
onFavicon(listener: (e: { webContentsId: number; dataUrl: string }) => void): () => void;

// palette/actions.ts, дополнение ActionContext
/** Вкладка браузера активной группы активной работы — туда идут пересланные из страницы действия. */
browser: { focused(): { tabId: string; webContentsId: number } | null };

// main/browser/favicon.ts
export const FAVICON_LIMITS: { bytes: 64 * 1024; timeoutMs: 5000 };
/** Favicon в data:: только http(s) и image/*, не больше 64 КБ; иначе null. Качает сессия раздела браузера. */
export async function fetchFavicon(url: string, fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>): Promise<string | null>;
```

**Поведение**
- **`BrowserSurface`:**
  - `<webview>` монтируется только с адресом. У новой вкладки (`url: ''`) — заглушка с
    адресной строкой и фокусом в ней. Иначе `will-attach-webview` видел бы пустой `src`,
    а правило «только http(s)» его отвергает;
  - `<webview src partition={BROWSER_PARTITION} allowpopups webpreferences="contextIsolation=yes, sandbox=yes">`
    в слое поверхностей: перенос вкладки не перезагружает страницу;
  - `allowpopups` ставится: без него Electron гасит `window.open` и `target=_blank`
    гостя ещё до `setWindowOpenHandler`, и вкладка не откроется. Обработчик 9.1 всё
    равно отвечает `deny` — новых окон нет;
  - события `did-start-loading`, `did-stop-loading`, `page-title-updated`,
    `did-navigate`, `did-navigate-in-page`, `render-process-gone` обновляют `store`;
  - адрес пишется в раскладку операцией `apply(workKey, l => updateTab(l, tabId,
    { url }))` (2.1) на `did-navigate` и `did-navigate-in-page`; сохранение — 2.2.
- **Favicon.** Адреса из `page-favicon-updated` — http(s), а CSP окна пускает картинки
  только `'self' data: blob:`. Поэтому favicon качает main: гость сообщил
  `page-favicon-updated` → `fetchFavicon` первого адреса сессией раздела браузера →
  `browser:favicon { webContentsId, dataUrl }` → `store` → `extras.browser` → `tabMeta`
  (4.2). Не `image/*`, больше 64 КБ, не http(s) или таймаут — favicon нет, значок по
  умолчанию.
- **`BrowserChrome`** 36px:
  - назад, вперёд, перезагрузка или остановка;
  - `AddressBar` с `normalizeUrl` и ошибкой под полем;
  - ⌖ (9.3), «DevTools»;
  - полоса загрузки 2px.
- **Клавиши в странице** доходят до окна пересылкой main (9.1, 6.1) как действия
  `browser.*`; их цель — `ctx.browser.focused()`:
  - ⌘F (`browser.find`) — полоса поиска по странице: `browser.find` / `stopFind`;
  - ⌘+, ⌘−, ⌘0 (`browser.zoomIn`, `zoomOut`, `zoomReset`) — `browser.zoom(id, 1 | -1 |
    0)`.
- **Падение** (`render-process-gone`) — тело «Страница упала» и «Перезагрузить».
- **Пределы:** 10 вкладок браузера на работу. `openBrowserTab` считает их до `apply`:
  одиннадцатая — тост «Больше 10 вкладок браузера в работе» (спека 12.4), раскладка не
  меняется. Слои — LRU трёх работ (2.5): при возврате страница грузит сохранённый адрес.
- **Новая вкладка** (палитра «Новая вкладка браузера», «+» строки вкладок) —
  `openBrowserTab('')`: заглушка без страницы, фокус в адресной строке. Enter с
  адресом → `updateTab` и `<webview>` с `src`.
- **Заголовок вкладки** — заголовок страницы, иначе адрес: `tabMeta` берёт его и favicon
  из `extras.browser`.

**Тесты**
1. `openBrowserTab`: одиннадцатая вкладка — тост «Больше 10 вкладок браузера в работе»,
   ответ `'limit'`, раскладка без изменений.
2. `AddressBar`: Enter с `example.com` зовёт навигацию на `https://example.com`;
   ввод `привет` показывает ошибку.
3. `BrowserSurface` (подставной `webview`): `page-title-updated` меняет заголовок
   вкладки; `render-process-gone` показывает «Страница упала».
4. Перенос вкладки браузера между группами не меняет ключ React поверхности и не
   пересоздаёт `webview`.
5. `LinkMenu`: ⌘-клик по `http://localhost:5173` открывает вкладку браузера;
   «Открыть в системном браузере» зовёт `app.openExternal`.
6. Новая вкладка без адреса: `<webview>` нет, фокус в адресной строке; Enter с
   `localhost:5173` → `updateTab` с `http://localhost:5173` и `<webview>` с этим `src`.
7. `did-navigate` на новый адрес → в раскладке `url` новый, id вкладки прежний.
8. `<webview>` вкладки несёт атрибут `allowpopups`.
9. `fetchFavicon`: `image/png` 1 КБ → `data:image/png;base64,…`; `text/html` → `null`;
   70 КБ → `null`; `file:///x.png` → `null`, `fetch` не вызван.
10. Действие `browser.find` из пересылки открывает полосу поиска активной вкладки
    браузера; `browser.zoomIn` зовёт `browser.zoom(id, 1)`.
11. `tabMeta` вкладки браузера: заголовок страницы и favicon из `extras.browser`, без
    них — адрес.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 9.3. Design Mode; приёмка этапа 9 и MVP

**Зачем.** Показать агенту элемент страницы, не описывая его словами.
**Зависит от:** 9.2, 5.4. **Спека:** 12.3.

**Файлы**
- Создать:
  - `packages/desktop/src/main/browser/guest-pick.js` — скрипт изолированного мира;
  - `packages/desktop/src/main/browser/guest-pick.test.ts` — с
    `// @vitest-environment jsdom`: `vitest.config.ts` даёт `src/main/**` среду node;
  - `packages/desktop/src/main/browser/design-mode.ts` и тест;
  - `packages/desktop/src/renderer/browser/DesignModeCard.tsx` и тест;
  - `packages/desktop/src/renderer/browser/design-block.ts` и тест;
  - `packages/desktop/e2e/browser.spec.ts`, `packages/desktop/e2e/fixtures/page.html`.
- Изменить:
  - `src/shared/browser-types.ts`, `src/shared/bridge.ts`, `src/main/ipc.ts`,
    `src/preload/index.ts` — `browser.pickStart` и `pickCancel`;
  - `renderer/test-utils/fake-bridge.ts` — `pickStart` (сеттер ответа), `pickCancel`;
  - `renderer/browser/BrowserChrome.tsx` — ⌖;
  - `renderer/browser/store.ts` — состояние выбора.
- Документы:
  - `README.md`, раздел «Окно» — браузер и Design Mode; итоговый список возможностей;
  - `TODOS.md` — раздел «После MVP» из спеки 17.

**Интерфейсы**

```ts
// shared/browser-types.ts, дополнение BrowserApi
pickStart(webContentsId: number): Promise<PickResult | null>;   // null — отменён Esc
pickCancel(webContentsId: number): Promise<void>;

// main/browser/design-mode.ts
export const PICK_WORLD_ID = 1001;
export const PICK_LIMITS: { html: 4096; text: 500; selectorLinks: 12; thumbnailWidth: 320 };
/** Проверка формы данных из гостя: лишние поля выкинуты, строки обрезаны, неверная форма → null. */
export function validatePick(raw: unknown): Omit<PickResult, 'url' | 'imagePath' | 'thumbnail'> & {
  rect: { x: number; y: number; width: number; height: number };   // CSS-пиксели страницы
  viewport: { width: number; height: number };                      // innerWidth и innerHeight гостя
} | null;
/** Прямоугольник снимка в DIP: CSS-пиксели × zoomFactor, пересечение с видимой областью. */
export function captureRect(rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number }, zoomFactor: number):
  { x: number; y: number; width: number; height: number } | null;
export function createDesignMode(deps: {
  fromId(id: number): WebContents | null;
  saveImage(png: Buffer): Promise<string | null>;     // адаптер к main/drops.ts#saveImage({ png, dir: dropsDir() })
  guestScript: string;                                // import guestScript from './guest-pick.js?raw'
}): { start(id: number): Promise<PickResult | null>; cancel(id: number): Promise<void> };

// renderer/browser/design-block.ts — формат спеки 12.3
export function designBlock(pick: PickResult): string;
```

**Поведение**
- **`start(id)`:**
  - `executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: guestScript }])`; скрипт
    встраивается в сборку main как текст (`?raw` у electron-vite);
  - скрипт возвращает `Promise`: по клику — данные элемента, по Esc или
    `cancel` — `null`.
- **`guest-pick.js`:**
  - оверлей: рамка 2px `#3b82f6` поверх `document.elementFromPoint`, подпись
    `tag.class · W×H`;
  - перехват `click`, `mousedown`, `pointerdown` в capture-фазе (`preventDefault`,
    `stopPropagation`); события с `isTrusted: false` пропускаются — страница не выберет
    элемент за человека;
  - поля — таблица спеки 12.3: селектор до 12 звеньев, текст до 500, HTML-клон без
    `<script>`, `<style>`, `on*`, `srcdoc`, значений паролей, до 4096 символов,
    вычисленные стили по списку, `rect`, `viewport` и `devicePixelRatio`;
  - элемент вне видимой области сначала прокручивается к центру;
  - по завершении оверлей и перехватчики снимаются.
- **Main** проверяет данные (`validatePick`) и снимает прямоугольник:
  - `url` берётся из `contents.getURL()` без query и hash, а не из данных страницы;
  - `captureRect(rect, viewport, contents.getZoomFactor())` — масштаб страницы (12.4)
    переводит CSS-пиксели в DIP → `contents.capturePage(rect)` → `saveImage`;
  - `thumbnail` — тот же снимок, `resize` до 320 px по ширине, `toDataURL()`: PNG в
    `drops/` вне корней работы, и `files.readBytes` его не отдаст, а `file://` в
    рендерере запрещён;
  - снимок не удался — `imagePath: null` и `thumbnail: null`, блок уходит без строки
    «Скриншот».
- **`DesignModeCard`** поверх вкладки браузера:
  - миниатюра (`<img src={thumbnail}>`, нет её — без картинки), селектор, текст в 2
    строки;
  - «Отправить агенту ▾» — меню сессий работы, как `SendMenu` из 8.4;
  - «Копировать» — `designBlock` в буфер;
  - «Ещё раз» — `pickStart` заново.
- **Отправка** — `sendToAgent(designBlock(pick), submit: true)`, тост `sendToast`.
- **Выключение режима** — Esc или повторный ⌖ зовёт `pickCancel`: `Promise` в госте
  разрешается `null`, оверлей снят.
- **Тест скрипта в jsdom.** В jsdom нет `innerText`, `scrollIntoView` и
  `elementFromPoint` — тест ставит заглушки, а скрипт читает их через `document` и
  элемент, как в браузере.

**Тесты**
1. `validatePick`:
   - лишнее поле выкинуто;
   - `html` 10 000 символов → 4096 и «…(обрезано)»;
   - `text` 1000 → 500;
   - нет `selector` или `viewport` → `null`.
2. `captureRect`: элемент частично за правым краем — пересечение; целиком вне — `null`;
   `zoomFactor` 1.5 умножает прямоугольник.
3. `designBlock`: формат спеки 12.3 построчно; без `imagePath` строки «Скриншот» нет.
4. Скрипт `guest-pick.js` в jsdom:
   - клик по кнопке в форме с `<input type=password value=secret>` → в `html` нет
     `secret`;
   - `onclick` у кнопки не сработал;
   - атрибута `onclick` в `html` нет;
   - событие с `isTrusted: false` ничего не выбирает.
5. `createDesignMode.start` на подставном `WebContents`: `url` — из `getURL()` без
   query, даже если скрипт прислал другой; `thumbnail` — `data:image/png…` шириной не
   больше 320; `capturePage` бросил — `imagePath` и `thumbnail` равны `null`.
6. `DesignModeCard`: «Отправить агенту» зовёт `pty.send` с блоком и `submit: true`;
   «Копировать» пишет блок в буфер; миниатюра — `<img>` с `thumbnail`.
7. **E2E `browser.spec.ts`:**
   - тест поднимает HTTP-сервер на случайном порту с `fixtures/page.html` (кнопка
     «Сохранить», форма с паролем, `window.open` по кнопке);
   - вкладка браузера на `http://127.0.0.1:<порт>/`;
   - ⌖, клик по кнопке → карточка; «Отправить агенту» → stub (`STUB_BRACKETED=1`)
     печатает `PASTE<<Элемент страницы` и строку `Скриншот:`;
   - Playwright гостя `<webview>` страницей не отдаёт: клик — `app.evaluate` с
     `webContents.fromId(id).sendInputEvent` (`mouseDown` и `mouseUp`, координаты
     кнопки из `executeJavaScript` в госте). Такие события доверенные, как клик
     человека.
8. **E2E:** клик по кнопке с `window.open` (тем же `sendInputEvent`) открыл вторую
   вкладку браузера, новых окон Electron нет (`app.windows().length === 1`); без
   `allowpopups` (9.2) вкладки не было бы.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 9** (человек, на пересобранном `harnas.app`)
- [ ] `localhost` своего проекта открывается во вкладке; выбранный элемент уходит
      сессии — агент видит селектор, стили и скриншот.
- [ ] DevTools открываются; запрос камеры на странице отклонён без вопроса.
- [ ] `file:///etc/hosts` в адресной строке — ошибка под полем, страница не открылась.

**Приёмка MVP** (человек) — критерии спеки 1.3:
- [ ] 1. Работа с `blocked` сессией первая в своей группе за секунду после события.
- [ ] 2. Клик по уведомлению macOS приводит на вкладку нужной сессии.
- [ ] 3. Любая работа, сессия, комната, вкладка или действие находится через ⌘J;
      ⌘1–9 выбирают строки.
- [ ] 4. Дифф → заметка → агенту → коммит → слияние — не выходя из окна.
- [ ] 5. Файл открыт, поправлен, сохранён ⌘S; правка агента на диске не перетёрта без
      подтверждения.
- [ ] 6. Элемент локальной страницы отдан агенту одним действием.
- [ ] 7. Рамочный тест зелёный, правила спеки 15.1 соблюдены (ревью диффа всех
      этапов).
- [ ] `README.md` и `TODOS.md` обновлены, `NOTICE` полный.
