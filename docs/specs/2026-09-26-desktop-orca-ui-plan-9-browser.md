# План, этап 9: браузер и Design Mode

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 12, строка 9 таблицы 14.3, раздел 1.3
(критерии MVP).

**Итог этапа:**
- вкладка браузера со страницами разработки, защищённая по спеке 12.2;
- Design Mode: выбрать элемент страницы и отдать его агенту одним действием;
- приёмка всего MVP.

**Перед стартом.** Сверить с кодом прошлых этапов:
- `main/window.ts` (`webPreferences`), `main/guest-shortcuts.ts` (6.1);
- `layout/SurfaceLayer.tsx` (слой поверхностей), `layout/ids.ts#tabId.browser`;
- `terminal/links.ts` и `files/preview/MarkdownPreview.tsx` — ссылки, которые теперь
  открывают браузер;
- `terminal/send.ts`, `main/drops.ts`.

---

## 9.1. Защита `<webview>` и мост браузера

**Зачем.** Страницы из сети живут в клетке: без Node, без preload, без разрешений, без
окон.
**Зависит от:** 6.1. **Спека:** 12.2, 12.5.

**Файлы**
- Создать:
  - `packages/desktop/src/main/browser/guard.ts` и тест;
  - `packages/desktop/src/renderer/browser/url.ts` и тест;
  - `packages/desktop/src/shared/browser-types.ts`.
- Изменить:
  - `src/main/window.ts` и тест — `webviewTag: true`;
  - `src/main/index.ts` — `installBrowserGuard` на `app.on('web-contents-created')`,
    `forwardGuestShortcuts` для гостей;
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` — группа
    `browser`: `openDevTools`, `clearData`, `onOpenTab`, `find`, `stopFind`, `zoom`;
  - `renderer/components/settings/SettingsDialog.tsx` — секция «Браузер» с «Очистить
    данные браузера».

**Интерфейсы**

```ts
// shared/browser-types.ts
export const BROWSER_PARTITION = 'persist:harnas-browser';
export interface PickResult { url: string; selector: string; text: string; html: string; styles: Record<string, string>; imagePath: string | null }
export interface BrowserApi {
  pickStart(webContentsId: number): Promise<PickResult | null>;   // 9.3
  pickCancel(webContentsId: number): Promise<void>;               // 9.3
  openDevTools(webContentsId: number): Promise<void>;
  find(webContentsId: number, text: string, forward: boolean): Promise<{ matches: number; active: number }>;
  stopFind(webContentsId: number): Promise<void>;
  zoom(webContentsId: number, step: 1 | -1 | 0): Promise<void>;
  clearData(): Promise<void>;
  onOpenTab(listener: (url: string) => void): () => void;
}

// main/browser/guard.ts
export type NavVerdict = 'allow' | 'deny';
/** Схемы http, https и file внутри корней работы; javascript:, data:, прочее — deny. */
export function navigationVerdict(url: string, isInsideRoots: (absPath: string) => boolean): NavVerdict;
/** Правка webPreferences на will-attach-webview; false — подключение запрещено. */
export function sanitizeWebviewAttach(webPreferences: Record<string, unknown>, params: { partition?: string; src?: string },
  isInsideRoots: (absPath: string) => boolean): boolean;
export function installBrowserGuard(deps: {
  app: Pick<App, 'on'>;
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>;  // раздел BROWSER_PARTITION
  isInsideRoots(absPath: string): boolean;
  openTab(url: string): void;                     // → окно, событие browser:open-tab
  forwardShortcuts(contents: WebContents): void;  // 6.1
}): void;

// renderer/browser/url.ts — таблица спеки 12.1
export type NormalizedUrl = { ok: true; url: string } | { ok: false; error: 'Введите адрес — поиска нет' };
export function normalizeUrl(input: string): NormalizedUrl;
```

**Поведение**
- **Главное окно**, событие `will-attach-webview`:
  - удаляются `preload` и `preloadURL`;
  - `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`,
    `contextIsolation: true`, `sandbox: true`, `webSecurity: true`,
    `allowRunningInsecureContent: false`;
  - `partition` не `BROWSER_PARTITION` или `src` запрещён — `preventDefault`.
- **Гость** (`contents.getType() === 'webview'`):
  - `setWindowOpenHandler` → `deny` и `openTab(url)`, если адрес разрешён;
  - `will-navigate` и `will-redirect` с `navigationVerdict === 'deny'` —
    `preventDefault`;
  - `forwardShortcuts`.
- **Сессия раздела:** все запросы и проверки разрешений — отказ.
  `certificate-error` не перехватывается.
- **Мост** проверяет `webContentsId`: `webContents.fromId(id)` существует, тип
  `webview`, раздел — `BROWSER_PARTITION`. Иначе ошибка.
- **`clearData`** — `clearStorageData()` и `clearCache()` раздела.

**Тесты**
1. `normalizeUrl`: `localhost:3000/x` → `http://localhost:3000/x`; `127.0.0.1` →
   `http://127.0.0.1`; `example.com` → `https://example.com`;
   `https://a.b/c?d` — как есть; `привет мир` → ошибка; `javascript:alert(1)` →
   ошибка.
2. `navigationVerdict`:
   - `https://x` → `allow`;
   - `file:///etc/passwd` → `deny`;
   - `file://<корень>/index.html` → `allow`;
   - `javascript:x`, `data:text/html,…` → `deny`.
3. `sanitizeWebviewAttach` вычищает `preload`, ставит флаги; чужой `partition` →
   `false`.
4. `installBrowserGuard` на подставных объектах: `setWindowOpenHandler` гостя отдаёт
   `deny` и зовёт `openTab`; `permissionRequest` → `callback(false)`.
5. `mainWindowOptions` — `webviewTag: true`, остальное как в 2.3.
6. Мост: `openDevTools` с id главного окна → ошибка.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 9.2. Вкладка браузера

**Зачем.** Страница разработки рядом с агентом, в той же раскладке.
**Зависит от:** 9.1. **Спека:** 12.1, 12.4.

**Файлы**
- Создать в `packages/desktop/src/renderer/browser/`:
  - `BrowserSurface.tsx`, `BrowserChrome.tsx`, `AddressBar.tsx` и тесты;
  - `store.ts` и тест.
- Изменить в `packages/desktop/src/renderer/`:
  - `layout/SurfaceLayer.tsx` — поверхности вида `browser`;
  - `layout/bodies/` — тело `browser`: заглушка, сама страница в слое;
  - `layout/tab-meta.ts` — favicon и заголовок;
  - `palette/actions.ts`, `keys` — `browser.newTab` доступно;
  - `terminal/links.ts`, `terminal/LinkMenu.tsx` — ⌘-клик по URL и «Открыть в
    браузере» открывают вкладку браузера; «Открыть в системном браузере» — пункт меню;
  - `files/preview/MarkdownPreview.tsx` — `http(s)` открываются во вкладке браузера.

**Интерфейсы**

```ts
// browser/store.ts
export interface BrowserTabState {
  url: string; title: string | null; favicon: string | null;
  loading: boolean; canGoBack: boolean; canGoForward: boolean;
  crashed: boolean; webContentsId: number | null;
  pick: 'off' | 'picking' | { result: PickResult };   // 9.3
}
export interface BrowserState {
  tabs: Record<string /* tabId */, BrowserTabState>;
  update(tabId: string, patch: Partial<BrowserTabState>): void;
  remove(tabId: string): void;
}
export const BROWSER_LIMITS: { tabsPerWork: 10 };
/** Открыть адрес: в активной работе новая вкладка браузера, если их меньше 10. */
export function openBrowserTab(url: string, deps: { apply: LayoutState['apply']; activeWorkKey: string | null; toast(text: string): void }): void;
```

**Поведение**
- **`BrowserSurface`:**
  - `<webview src partition={BROWSER_PARTITION} webpreferences="contextIsolation=yes, sandbox=yes">`
    в слое поверхностей: перенос вкладки не перезагружает страницу;
  - события `did-start-loading`, `did-stop-loading`, `page-title-updated`,
    `page-favicon-updated`, `did-navigate`, `did-navigate-in-page`,
    `render-process-gone` обновляют `store`;
  - адрес пишется в `TabSpec.url` (сохранение раскладки — 2.2).
- **`BrowserChrome`** 36px:
  - назад, вперёд, перезагрузка или остановка;
  - `AddressBar` с `normalizeUrl` и ошибкой под полем;
  - ⌖ (9.3), «DevTools»;
  - полоса загрузки 2px.
- **Клавиши в странице** — пересылаются окну (9.1).
  - ⌘F — полоса поиска по странице через `browser.find` / `stopFind`.
  - ⌘+, ⌘−, ⌘0 — `browser.zoom`.
- **Падение** (`render-process-gone`) — тело «Страница упала» и «Перезагрузить».
- **Пределы:** 10 вкладок браузера на работу — одиннадцатая откажет тостом. Слои —
  LRU трёх работ (2.5): при возврате страница грузит сохранённый адрес.
- **Новая вкладка** (палитра «Новая вкладка браузера», «+» строки вкладок) — пустая
  страница, фокус в адресной строке.

**Тесты**
1. `openBrowserTab`: одиннадцатая вкладка — тост, раскладка без изменений.
2. `AddressBar`: Enter с `example.com` зовёт навигацию на `https://example.com`;
   ввод `привет` показывает ошибку.
3. `BrowserSurface` (подставной `webview`): `page-title-updated` меняет заголовок
   вкладки; `render-process-gone` показывает «Страница упала».
4. Перенос вкладки браузера между группами не меняет ключ React поверхности и не
   пересоздаёт `webview`.
5. `LinkMenu`: ⌘-клик по `http://localhost:5173` открывает вкладку браузера;
   «Открыть в системном браузере» зовёт `app.openExternal`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 9.3. Design Mode; приёмка этапа 9 и MVP

**Зачем.** Показать агенту элемент страницы, не описывая его словами.
**Зависит от:** 9.2, 5.4. **Спека:** 12.3.

**Файлы**
- Создать:
  - `packages/desktop/src/main/browser/guest-pick.js` — скрипт изолированного мира;
  - `packages/desktop/src/main/browser/design-mode.ts` и тест;
  - `packages/desktop/src/renderer/browser/DesignModeCard.tsx` и тест;
  - `packages/desktop/src/renderer/browser/design-block.ts` и тест;
  - `packages/desktop/e2e/browser.spec.ts`, `packages/desktop/e2e/fixtures/page.html`.
- Изменить:
  - `src/main/ipc.ts`, `src/preload/index.ts` — `browser.pickStart` и `pickCancel`;
  - `renderer/browser/BrowserChrome.tsx` — ⌖;
  - `renderer/browser/store.ts` — состояние выбора.
- Документы:
  - `README.md`, раздел «Окно» — браузер и Design Mode; итоговый список возможностей;
  - `TODOS.md` — раздел «После MVP» из спеки 17.

**Интерфейсы**

```ts
// main/browser/design-mode.ts
export const PICK_WORLD_ID = 1001;
export const PICK_LIMITS: { html: 4096; text: 500; selectorLinks: 12 };
/** Проверка формы данных из гостя: лишние поля выкинуты, строки обрезаны, неверная форма → null. */
export function validatePick(raw: unknown): Omit<PickResult, 'imagePath'> & { rect: { x: number; y: number; width: number; height: number } } | null;
/** Прямоугольник снимка: пересечение с видимой областью гостя, в DIP. */
export function captureRect(rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }):
  { x: number; y: number; width: number; height: number } | null;
export function createDesignMode(deps: {
  fromId(id: number): WebContents | null;
  saveImage(png: Buffer): Promise<string | null>;     // main/drops.ts
  guestScript: string;                                // содержимое guest-pick.js
}): { start(id: number): Promise<PickResult | null>; cancel(id: number): Promise<void> };

// renderer/browser/design-block.ts — формат спеки 12.3
export function designBlock(pick: PickResult): string;
```

**Поведение**
- **`start(id)`:**
  - `executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: guestScript }])`;
  - скрипт возвращает `Promise`: по клику — данные элемента, по Esc или
    `cancel` — `null`.
- **`guest-pick.js`:**
  - оверлей: рамка 2px `#3b82f6` поверх `document.elementFromPoint`, подпись
    `tag.class · W×H`;
  - перехват `click`, `mousedown`, `pointerdown` в capture-фазе (`preventDefault`,
    `stopPropagation`);
  - поля — таблица спеки 12.3: селектор до 12 звеньев, текст до 500, HTML-клон без
    `<script>`, `<style>`, `on*`, `srcdoc`, значений паролей, до 4096 символов,
    вычисленные стили по списку, `rect` и `devicePixelRatio`;
  - элемент вне видимой области сначала прокручивается к центру;
  - по завершении оверлей и перехватчики снимаются.
- **Main** проверяет данные (`validatePick`) и снимает прямоугольник:
  - `captureRect` → `contents.capturePage(rect)` → `saveImage`;
  - снимок не удался — `imagePath: null`, блок уходит без строки «Скриншот».
- **`DesignModeCard`** поверх вкладки браузера:
  - миниатюра, селектор, текст в 2 строки;
  - «Отправить агенту ▾» — меню сессий работы, как `SendMenu` из 8.4;
  - «Копировать» — `designBlock` в буфер;
  - «Ещё раз» — `pickStart` заново.
- **Отправка** — `sendToAgent(designBlock(pick), submit: true)`, тост `sendToast`.
- **Выключение режима** — Esc или повторный ⌖ зовёт `pickCancel`: `Promise` в госте
  разрешается `null`, оверлей снят.

**Тесты**
1. `validatePick`:
   - лишнее поле выкинуто;
   - `html` 10 000 символов → 4096 и «…(обрезано)»;
   - `text` 1000 → 500;
   - нет `selector` → `null`.
2. `captureRect`: элемент частично за правым краем — пересечение; целиком вне — `null`.
3. `designBlock`: формат спеки 12.3 построчно; без `imagePath` строки «Скриншот» нет.
4. Скрипт `guest-pick.js` в jsdom:
   - клик по кнопке в форме с `<input type=password value=secret>` → в `html` нет
     `secret`;
   - `onclick` у кнопки не сработал;
   - атрибута `onclick` в `html` нет.
5. `DesignModeCard`: «Отправить агенту» зовёт `pty.send` с блоком и `submit: true`;
   «Копировать» пишет блок в буфер.
6. **E2E `browser.spec.ts`:**
   - тест поднимает HTTP-сервер на случайном порту с `fixtures/page.html` (кнопка
     «Сохранить», форма с паролем, `window.open` по кнопке);
   - вкладка браузера на `http://127.0.0.1:<порт>/`;
   - ⌖, клик по кнопке → карточка; «Отправить агенту» → stub (`STUB_BRACKETED=1`)
     печатает `PASTE<<Элемент страницы` и строку `Скриншот:`.
7. **E2E:** клик по кнопке с `window.open` открыл вторую вкладку браузера, новых окон
   Electron нет (`app.windows().length === 1`).

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 9** (человек, на пересобранном `harnas.app`)
- [ ] `localhost` своего проекта открывается во вкладке; выбранный элемент уходит
      сессии — агент видит селектор, стили и скриншот.
- [ ] DevTools открываются; запрос камеры на странице отклонён без вопроса.

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
