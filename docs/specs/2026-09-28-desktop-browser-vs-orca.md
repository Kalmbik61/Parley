# Встроенный браузер: наш (этап 9) и Orca — сравнение

Дата: 2026-09-28. Работа только на чтение: ничего не запускалось, не собиралось и не качалось.

**Основание.**
- **Наш браузер.** Основное дерево, ветка `feat/orca-ui` на `e318a43`. Код браузера — коммиты от `5857223` (кусок 9.1) до `1e1bf79` (fix-9b). Документы:
  - спека `docs/specs/2026-09-26-desktop-orca-ui-design.md`, разделы 1.2, 12, 15.1, 18;
  - план `docs/specs/2026-09-26-desktop-orca-ui-plan-9-browser.md`;
  - отчёты `review-stage9-B.md` и `fix-9-report.md`.

  Пути ниже — от `packages/desktop/src`, если не сказано иное.
- **Orca.** Снимок `scratchpad/orca-harnas` — это апстрим `stablyai/orca` на коммите `acf8e679` от 2026-09-25, Electron 43.7.0 (у нас Electron 44).
  - Апстрим меняется очень быстро: 2436 коммитов за 30 дней (замер спеки 1.2). Всё, что ниже сказано про Orca, верно только для этого снимка.
  - Пути Orca даны от `src/` снимка. Сокращения: `browser-pane/` = `renderer/src/components/browser-pane/`, `main/browser/` = `src/main/browser/`.
- **Метод.** Выводы о поведении сделаны по коду, а не по живому прогону. Что по коду установить не удалось, собрано в разделе 6.

---

## 1. Устройство

**Наш браузер (этап 9).**
- **Где живёт страница.** Страница — тег `<webview>` в DOM главного окна. Он лежит в слое поверхностей работы (`renderer/layout/SurfaceLayer.tsx`) и привязан CSS-якорем к телу группы (`renderer/browser/BrowserSurface.tsx`).
  - Перенос вкладки меняет только `position-anchor`: узел не переезжает, страница не перезагружается.
  - У каждой страницы свой гостевой `webContents` со своим процессом рендерера.
  - Раздел один на все работы: `persist:harnas-browser` (`shared/browser-types.ts`). У окна — своя сессия.
- **Защита — целиком в main** (`main/browser/guard.ts`):
  - `will-attach-webview` главного окна вычищает `preload`, ставит `sandbox`, `contextIsolation`, `disableDialogs` и `webviewTag: false`; пускает только наш раздел и `src` вида http(s);
  - вложенный `<webview>` не пускается;
  - навигация всех фреймов идёт по белому списку схем; программную навигацию останавливает `stop()` на `did-start-navigation`;
  - `window.open` получает `deny`, а окну уходит событие `browser:open-tab`;
  - все разрешения — отказ; сертификат клиента не отдаётся; загрузки — через диалог сохранения;
  - сочетания окна из страницы пересылает `main/guest-shortcuts.ts`;
  - значок страницы качает main с пределами (`main/browser/favicon.ts`).
- **Рендерер** зовёт у `<webview>` только навигацию. Всё остальное идёт мостом `browser.*`: 7 вызовов в `main/ipc.ts`, каждый проверяет гостя через `browserGuest`, и 3 события main → окно (`browser:open-tab`, `browser:favicon`, `browser:focus`).
- **Состояние.**
  - Адрес хранится только в раскладке: `layouts.json` v2, http(s) без `user:pass@`.
  - Живое состояние — в zustand-сторе `renderer/browser/store.ts`, на диск не пишется: заголовок, значок, загрузка, «назад / вперёд», падение, поиск, Design Mode.
- **Пределы:** не больше 10 вкладок браузера на работу; смонтированы слои трёх последних работ (LRU).
- **Design Mode:**
  - скрипт `main/browser/guest-pick.js` исполняется в изолированном мире 1001;
  - main сам проверяет данные и делает снимок (`main/browser/design-mode.ts`);
  - результат показывает карточка `renderer/browser/DesignModeCard.tsx`, отправка агенту — через `pty.send`.

**Orca.**
- **Где живёт страница.** Тоже `<webview>`, но создаётся императивно: `document.createElement('webview')` в `browser-pane/host-guest/browser-page-webview.ts`.
  - Узел живёт в реестре `browser-pane/host-guest/webview-registry.ts` по id страницы.
  - Смена родителя в DOM пересоздаёт гостя (`replacePersistentWebview`).
  - Вкладка верхнего уровня — «browser workspace» со вложенными страницами (`shared/browser-workspace-types.ts`, поле `BrowserWorkspace.pageIds`).
- **Main.**
  - Фасад `main/browser/browser-manager.ts` — цепочка примерно из 20 классов-наследников `browser-manager-*.ts` (регистрация, состояние, навигация, политики гостя и попапов, загрузки, viewport, выбор элемента, события). Классы делят общие карты tabId ↔ webContentsId ↔ окно.
  - Страж `will-attach-webview` — в `main/window/main-window-webview-security.ts`. Разделы он берёт из реестра профилей и маршрутов. Гостю ставится свой preload `src/preload/browser-window-close.ts`, который глушит `window.close()`.
  - Политики гостя вешаются на `did-attach-webview`.
- **Разделы — по профилю:**
  - общий `persist:orca-browser` (`shared/constants.ts`);
  - изолированные и импортированные профили (`main/browser/browser-session-registry.ts`);
  - разделы маршрутов для SSH и удалённых работ;
  - непостоянный раздел превью `orca-preview`.
- **Кроме локальных `<webview>`:**
  - внеэкранные гости в main (`offscreen-browser-backend.ts`) для страниц на удалённом сервере; кадры транслируются через CDP (`browser-screencast-*`);
  - мост агента: бинарник `agent-browser` из npm подключается к отладчику гостя через CDP-прокси (`agent-browser-bridge-*.ts`, `cdp-ws-proxy.ts`, `electron-debugger-lease.ts`).
- **Состояние.**
  - zustand-срез `renderer/src/store/slices/browser/*`: вкладки, страницы, история адресов до 200 записей, заметки Design Mode, профили.
  - Сохраняется в сессии рабочей области по zod-схеме `shared/workspace-session-browser-schema.ts`.
  - Метаданные профилей и режим UA лежат в main: `browser-session-meta-store.ts`, `browser-identity-mode-store.ts`.
- **Удержание:** гости четырёх последних скрытых worktree остаются живыми (`browser-pane/host-guest/browser-guest-worktree-retention.ts`).

**Размер (строки без тестов):**

| | Наш | Orca |
|---|---|---|
| main | `main/browser/*` — 4 файла, 782 строки; мост в `main/ipc.ts` — около 70; `main/guest-shortcuts.ts` | `main/browser` — 325 файлов, 41,3 тыс. |
| рендерер | `renderer/browser/*` — 8 файлов, 1030 строк | `browser-pane` — 190 файлов, 24,4 тыс.; стор `slices/browser*` — 3,5 тыс.; `lib/*browser*` — 1,5 тыс.; `tab-bar/*Browser*` — 0,7 тыс. |
| shared | `shared/browser-types.ts` — 46 | `shared/browser-*.ts` — 2,9 тыс. (плюс `window-shortcut-policy.ts`, `keybindings/`) |
| **итого** | **около 2,0 тыс.** | **около 74 тыс. (примерно в 37 раз больше)** |
| тесты | 2,4 тыс. юнит и 1,0 тыс. E2E (4 спеки) | около 74 тыс. (54 тыс. main и 20 тыс. рендерер) |
| Design Mode | около 570 строк (`design-mode.ts`, `guest-pick.js`, `DesignModeCard.tsx`, `design-block.ts`) | около 6,4 тыс. (`grab-*` в main — 1,7 тыс., `annotate/` — 4,4 тыс., типы — 0,3 тыс.) |

**Из чего состоит main Orca** (тыс. строк):

| Часть | Файлы | Строк, тыс. |
|---|---|---|
| Удалённые страницы и хостинг на клиенте | `browser-client-*`, `paired-runtime-*`, `browser-host-*` | 6,7 |
| Разделы маршрутов | `browser-route-*` | 4,9 |
| Сеть через SSH, SOCKS и WSL | `browser-network-*`, `remote-browser-socks-*`, `ssh-*`, `wsl-*`, `local-ssh-*` | 4,8 |
| Импорт куков | `browser-cookie-*` | 4,7 |
| Ядро гостя: менеджер, политики, загрузки, попапы | `browser-manager-*`, `browser-guest-*`, `popup-origin-bar-window.ts` | 4,4 |
| CDP | `cdp-*` | 4,0 |
| Мост агента | `agent-browser-bridge-*` | 3,3 |
| Профили, UA, прокси | `browser-session-*`, `browser-identity-*` | 2,3 |
| Design Mode | `grab-guest-*`, `browser-grab-*` | 1,7 |
| Трансляция экрана | `browser-screencast-*` | 1,1 |
| Превью документов | `doc-preview-*` | 1,0 |
| Сертификаты | `browser-certificate-*` | 0,6 |
| Снимок дерева доступности | `snapshot-*` | 0,45 |
| WebAuthn | `browser-webauthn-*` | 0,26 |

Собственно браузер для человека на этом Mac — это ядро, сертификаты, Design Mode и превью.
- В main это около 8 тыс. строк; ещё 2,3 тыс. — профили и UA.
- В рендерере это около 17,6 тыс.: `assemble-chrome/` 5,4, `host-guest/` 3,6, `navigate/` 2,1, `annotate/` 4,4, `workspace-doc/` 1,7, `describe-page/` 0,4.
- Остальное — удалённые страницы, автоматизация агентом и импорт.

---

## 2. Матрица функций

Строка Design Mode разобрана подробнее в 2.1.

| Функция | Orca: как сделано, файлы | У нас: как сделано, файлы | Разрыв |
|---|---|---|---|
| **Адресная строка и навигация** | `assemble-chrome/BrowserAddressBar.tsx` (490 строк). Подсказки из истории: до 200 адресов, нечёткий поиск (`lib/browser-history-match.ts`), до 8 строк (`browser-address-bar-suggestions.ts`). Поиск Google, DDG, Bing или Kagi (`shared/browser-url.ts#buildSearchUrl`). `localhost:порт` открывается по http, абсолютный путь — как `file://`. Кнопки: назад, вперёд, перезагрузка, стоп, жёсткая перезагрузка (`browser-reload-control.tsx`). Клавиши: ⌘R, ⌘⇧R, ⌘L, ⌘[ и ⌘] (`shared/keybindings/definitions-core-2.ts`, `-3.ts`) | `renderer/browser/AddressBar.tsx`, `url.ts#normalizeUrl` по таблице 12.1: только http(s); `file:` — ошибка; поиска нет. `BrowserChrome.tsx`: назад, вперёд, перезагрузить или стоп, полоса загрузки. Клавиш навигации нет: ⌘L занят правым сайдбаром, ⌘[ и ⌘] — группами | Нет истории и подсказок. Нет жёсткой перезагрузки, ⌘R и ⌘⇧R. Фокус адресной строки с клавиатуры недоступен. Поиска нет сознательно (12.1) |
| **Вкладки и их предел** | Вкладка верхнего уровня `tab-bar/BrowserTab.tsx` и страницы внутри неё. ⌘T — новая страница, ⌘⇧T — вернуть закрытую (`docs/site/content/docs/browser/overview.mdx`), ⌘⇧B — новая вкладка браузера. Меню вкладки: Duplicate, Pin, Close Others / To Right / To Left, Open In Browser. Жёсткого предела числа вкладок в снимке не нашёл. Страница может открыть не больше 4 вкладок за 2 с (`main/browser/browser-page-initiated-tab-budget.ts`) | Вкладка вида `browser` в общей раскладке: одна вкладка — одна страница, значок и заголовок (`layout/Tab.tsx`, `tab-meta.ts`). Новая вкладка — из палитры ⌘J или «+»; ⌘⇧T — общий `tab.reopen`. Меню: Close others, Close to right, сплит. Не больше 10 на работу (`renderer/browser/store.ts#BROWSER_LIMITS`), при пределе — тост; от `window.open` — один тост на открыватель | Для вкладки браузера нет Duplicate, «Open in system browser» и «Copy URL». Темп вкладок, которые открывает страница, не ограничен |
| **Восстановление после перезапуска** | Сохраняются вкладки и страницы: адрес, заголовок, значок, ошибка загрузки, пресет viewport, профиль и раздел (`shared/workspace-session-browser-schema.ts`). История адресов — до 200 (`shared/workspace-session-browser-history.ts`). Гости 4 скрытых worktree живут. Стек «назад / вперёд» не восстанавливается: вызовов `navigationHistory.restore` нет | В `layouts.json` сохраняется только адрес http(s) без учётных данных (спека 5.8, 12.1). Заголовок, значок, масштаб и история не сохраняются. Слой работы вне LRU-3 размонтируется, страница грузится заново (5.5) | Небольшой: нет заголовка до загрузки и истории адресов. Стек «назад / вперёд» не восстанавливают ни они, ни мы |
| **Попапы и `window.open`** | `main/browser/browser-manager-guest-popup-policy.ts`:<br>• клик по ссылке с `target=_blank`, с ⌘ или средней кнопкой помечает скрипт в изолированном мире 1208 (`browser-clicked-link-routing.ts`); ссылка открывается вкладкой на переднем или заднем плане;<br>• безымянный `window.open` без features открывается вкладкой в пределах бюджета;<br>• именованный или с features (OAuth) открывается настоящим окном `BaseWindow` с полосой origin (`popup-origin-bar-window.ts`), `opener` сохраняется;<br>• без владельца — открывается в системном браузере;<br>• остальное — отказ и уведомление (`browser-pane/navigate/browser-notices.ts#formatPopupNotice`) | Всегда `deny`. Адрес http(s) открывается вкладкой рядом с открывателем (`store.ts#openBrowserTabFrom`); невидимый открыватель фокус не уводит. Окон нет, у новой вкладки `window.opener === null` — проверено живьём (review-stage9-B, п. 3) | Вход через всплывающее окно OAuth/SSO, которому нужен `opener` или `postMessage`, у нас по коду не работает (живьём не проверялось). Фоновая вкладка по ⌘-клику не отличается от обычной. Темп не ограничен |
| **Скачивания** | Файл без вопроса сохраняется в `~/Downloads` с уникальным именем (`main/browser/browser-download-destination.ts`, `shared/browser-download-filename.ts`). Полка под строкой: прогресс, отмена, «открыть файл», «показать в папке», «убрать» (`navigate/browser-page-download-list.tsx`, `main/browser/browser-manager-download-*.ts`). Страницы удалённых работ качают на удалённый хост | `will-download` показывает стандартный диалог сохранения: папка по умолчанию — Downloads, имя — `basename` (`guard.ts#promptDownload`). Прогресса и списка нет. Начало загрузки снимает Design Mode (fix-9b) | Нет прогресса, отмены и «показать в Finder». Автосохранение Orca мы сознательно не делаем (12.2) |
| **Разрешения сайтов** | `main/browser/browser-session-partition-policies.ts`:<br>• сами выдаются `fullscreen`, `clipboard-read`, `clipboard-sanitized-write`, `notifications`, `persistent-storage`, `pointerLock`, `storage-access` (`browser-session-permission-policy.ts`);<br>• камера и микрофон — по разрешению macOS TCC, с запросом (`browser-media-access.ts`);<br>• захват экрана — отказ; ключи FIDO — `browser-webauthn-access.ts`;<br>• прочее — отказ и уведомление «X asked for Y, and Orca denied it» (`browser-notices.ts#formatPermissionNotice`) | Отказ во всём без вопроса: `setPermissionRequestHandler` и `setPermissionCheckHandler` возвращают `false` (`guard.ts`). Человеку ничего не показывается | Человек не узнаёт, что страница просила, например, геолокацию. Нет полноэкранного режима элемента (видео). Выдачу разрешений не берём |
| **Сертификаты и ошибки TLS** | `app.on('certificate-error')` (`main/startup/main-process-ready-foundation.ts`) передаёт ошибку в `main/browser/browser-certificate-trust-controller.ts`:<br>• по умолчанию — отказ;<br>• для https на `localhost`, `*.localhost`, `127.x` или `[::1]` с `ERR_CERT_AUTHORITY_INVALID` оверлей ошибки даёт кнопку Proceed;<br>• разрешение привязано к гостю, адресу и SHA-256 листового сертификата, живёт 5 мин и снимается навигацией;<br>• кэш Chromium на уровне сессии перекрывает `webRequest.onBeforeRequest` (`browser-certificate-request-guard.ts`).<br>Тексты ошибок −200 / −201 / −202 — в `browser-notices.ts`. Обработчика `select-client-certificate` в снимке нет | `certificate-error` не перехватывается: отказ, затем слой «Couldn't load page». На `select-client-certificate` уходит пустой ответ (`guard.ts`) | Dev-сервер с самоподписанным https на localhost у нас не открыть. Текст ошибки не называет причину. Сертификат клиента у нас защищён строже |
| **Поиск на странице и масштаб** | ⌘F — `assemble-chrome/BrowserFind.tsx`, вызывает `webview.findInPage` прямо из рендерера. Масштаб — уровни от −3 до +5 шагом 0,5, это 58–249 %, с индикатором процента (`shared/browser-page-zoom.ts`, `browser-page-zoom-indicator.tsx`). ⌘+, ⌘− и ⌘ с колесом (`main/browser/browser-guest-wheel-zoom.ts`) | ⌘F — `renderer/browser/FindBar.tsx` через main: `browser:find`, ответ не дольше 2 с. ⌘+, ⌘− и ⌘0 — `browser:zoom`, `setZoomLevel(текущий ± 1)` без пределов и без индикатора (`main/ipc.ts`). Режим `setZoomMode('isolated')`, масштаб не сохраняется | Нет пределов масштаба и видимого процента, нет ⌘ с колесом |
| **DevTools** | «Open browser devtools» в меню панели и «Inspect Page» в контекстном меню вызывают `guest.openDevTools({ mode: 'detach' })` (`browser-manager-viewport.ts`) | Кнопка «DevTools» вызывает `browser:open-devtools`, а он — `openDevTools()` | Паритет |
| **Крах страницы и ошибки загрузки** | После `render-process-gone` гость прячется и пересоздаётся (`host-guest/browser-page-guest-recovery.ts`: 8 с, 3 проверки), после сна системы — перепроверка (`browser-system-resume.ts`). Оверлей ошибки `navigate/browser-load-failure-overlay.tsx`:<br>• описание по коду; для сертификатов — имя ошибки;<br>• для localhost: «We couldn't connect to your local server» и совет проверить, запущен ли сервер;<br>• кнопки Retry, Try HTTPS (для localhost), Copy, Open externally (у удалённых страниц — не для loopback) и Proceed для сертификата | Слой «Page crashed» с кнопкой Reload. Слой «Couldn't load page» с Reload — для главного фрейма, кроме `ERR_ABORTED` (`BrowserSurface.tsx`, fix-9) | Текст общий: без причины и без подсказки про незапущенный dev-сервер. Нет Try HTTPS и Copy URL. Автовосстановление после краха не обязательно |
| **Фокус и сочетания клавиш** | `before-input-event` гостя обрабатывают `main/browser/browser-guest-shortcut-forwarding.ts` и `browser-guest-shortcut-dispatch.ts` по `shared/window-shortcut-policy.ts` и переназначаемому реестру `shared/keybindings/*`. У браузера своя область клавиш. Фокусом адресной строки и страницы управляет `host-guest/browser-focus.ts`. Жест человека для попапов маршрутных гостей определяется по `input-event` (`browser-route-guest-popup-gesture.ts`) | `main/guest-shortcuts.ts` (идея Orca): сочетания `always` и `browser` гасятся в госте и уходят окну; ⌘⇧↑↓ и ⌃Tab остаются странице. `focus` гостя → `browser:focus` → вкладка становится активной. Остаточный риск 12.2: самофокус страницы в ключевом окне не проверен (fix-9, review-stage9-B) | Нет клавиш навигации браузера. `browser:focus` не привязан к настоящему вводу человека |
| **Перетаскивание поверх страницы** | На время перетаскивания у всех гостей `pointer-events: none` со счётчиком захватов (`host-guest/webview-drag-passthrough.ts`) | Полноэкранный щит `drag-shield` (`renderer/shell/AppShell.tsx`), при ресайзе сайдбаров — оверлей (`shell/Resizer.tsx`) | Паритет |
| **Выбор элемента и отправка агенту** | Design Mode из трёх режимов — «copy», «annotate», «markup». Скрипт работает в **главном** мире страницы. См. 2.1 | ⌖ Design Mode: изолированный мир, один элемент, карточка, Send to agent. См. 2.1 | У нас нет пачки заметок с комментарием, рисования и части полей. У нас строже изоляция и есть пометка «это данные страницы» |
| **Управление браузером агентом** | Есть. Команды `orca goto`, `snapshot`, `click`, `fill`, `type`, `eval`, `cookie get`, `upload`, `pdf`, `console`, `network` (`skill-guides/orca-cli/references/browser.md`). Бинарник `agent-browser` (npm `~0.27.0`) работает через CDP-прокси (`agent-browser-bridge-*.ts`, `cdp-*.ts`, `snapshot-engine.ts`) | Нет, запрещено: 15.1 п. 9 и 12.2 | Сознательный |
| **Удалённые и SSH-работы, поток экрана** | Страница удалённой работы рисуется здесь, а HTTP, WebSocket, DNS и loopback идут через удалённый хост: `browser-network-tunnel-*`, `remote-browser-socks-server.ts`, `ssh-browser-network-execution-route.ts`, `wsl-browser-network-*`. Другой вариант — страница живёт на сервере и транслируется кадрами CDP (`browser-screencast-*`, `browser-pane/stream-remote/`). Загрузки и выгрузки — на удалённом хосте | Нет: работы только локальные | Не нужен, пока нет работ на других хостах |
| **Импорт данных браузера** | Куки из Chrome, Edge, Arc, Brave, Firefox, Safari или из файла импортируются в профиль, кроме куков Google. Ключи «… Safe Storage» берутся из Keychain (`browser-cookie-*.ts`, `browser-cookie-detection-types.ts`). Для входа в Google подменяется UA (`browser-google-auth-ua.ts`). Импорта закладок не нашёл | Нет | Сознательный: это учётные данные |
| **Профили, разделы, изоляция от окна** | Общий `persist:orca-browser` плюс профили — изолированный и импортированный — со своими разделами; профиль выбирается на вкладку (`browser-session-registry.ts`, `docs/site/content/docs/browser/profiles.mdx`). Прокси приложения распространяется на разделы (`browser-session-proxy.ts`), UA работает в режиме «cleaned» или «native». Гость получает свой preload. CSP в `renderer/index.html` окна нет; значок грузится через `<img>` прямо в окне (`components/browser-favicon.tsx`) | Один раздел на все работы, у окна своя сессия. У гостя preload нет вовсе, CSP окна строгая (15.2). Значок — `data:` из main. «Clear browser data» — в настройках | Нет изоляции по проектам: куки `localhost:3000` общие у всех работ. У Orca по умолчанию тоже общие, но есть профили. Изоляция от окна у нас строже |
| **Контекстное меню страницы** | `main/browser/browser-guest-context-menu.ts` → рендерер `assemble-chrome/browser-page-context-menu.tsx`. Пункты: Open Link In Orca Browser, Open Link In Default Browser, Copy Link Address, Copy (выделение), Back, Forward, Reload, Open Page In Default Browser, Copy Page URL, Inspect Page | Нет: обработчика `context-menu` у гостя нет, правый клик по странице ничего не делает | Заметный в ежедневной работе |
| **Эмуляция размеров** | Пресеты Mobile S, M, L, Tablet, Laptop, Laptop L, Desktop (`shared/browser-viewport-presets.ts`). Работает через CDP `Emulation` (`browser-manager-viewport.ts`), пресет сохраняется у страницы | Нет | Есть |
| **Локальный HTML** | • `file://` открывается прямо во вкладке: `shared/browser-url.ts#normalizeBrowserNavigationUrl` пускает `file:` и превращает абсолютный путь в `file://`. Отключения фьюза `GrantFileProtocolExtraPrivileges` в снимке не нашёл.<br>• Документы SSH и удалённых работ открываются по схеме `orca-preview://` с грантом на каталог (`doc-preview-protocol.ts`, `doc-preview-grant-registry.ts`, `doc-preview-guest-policy.ts`) | `file:` не пускается вовсе (12.2). Локальный HTML — после MVP (17.11) | Разрыв по плану. Образец `orca-preview://` пригодится |
| **Диалоги страницы и уход со страницы** | `disableDialogs` не ставится. `will-prevent-unload` есть только в мосте агента, для браузерных гостей его нет. `will-frame-navigate` стоит только у превью, у браузерных гостей нет | `disableDialogs: true`; `will-prevent-unload` → `preventDefault`; проверка всех фреймов (`guard.ts`) | У нас строже |
| **Ссылки из терминала и Markdown** | Настройка «Link Routing»: встроенный или системный браузер; Shift+⌘-клик меняет выбор на один клик | ⌘-клик открывает вкладку браузера (`renderer/terminal/TerminalSurface.tsx`). В меню ссылки есть Open in browser и Open in system browser (`LinkMenu.tsx`) | Мелкий: нет настройки |

### 2.1 Выбор элемента: наш Design Mode и их grab, annotate и markup

**Orca** (`main/browser/browser-manager-grab.ts`, `grab-guest-*.ts`, `browser-grab-payload.ts`, `shared/browser-grab-types.ts`, `browser-pane/annotate/*`):
- **Внедрение.** `guest.executeJavaScript` исполняет скрипт в **главном мире** страницы.
  - Перехватчик кликов — полноэкранный хост `#__orca-grab-host` с закрытым shadow root; объект `window.__orcaGrab` виден странице.
  - Проверки `isTrusted` нет ни в одном `grab-guest-*.ts`.
  - Прямоугольник снимка пересчитывается по `window.innerWidth`, прочитанному в мире страницы (`browser-grab-screenshot.ts`).
- **Данные.**
  - Страница: адрес без query и hash, заголовок, viewport, прокрутка, DPR.
  - Селектор до 700 символов, читаемый и полный путь, классы, до 6 соседних элементов, выделенный текст.
  - React-компоненты и `файл:строка` из `_debugSource` (`grab-guest-react-script.ts`).
  - Текст до 200, HTML до 4096 символов.
  - Атрибуты по белому списку `GRAB_SAFE_ATTRIBUTE_NAMES` с вычисткой по `GRAB_SECRET_PATTERNS`.
  - Роль и доступное имя, до 10 соседних текстов и до 10 предков, 16 стилей.
  - Main повторно режет и проверяет форму (`clampGrabPayload`).
- **Режимы.**
  - **copy.** Клик копирует текст элемента в буфер. Клавиши C и S копируют текст или снимок элемента под курсором без клика (`annotate/browser-page-grab-action.ts`).
  - **annotate.** На странице ставятся метки (мост viewport в изолированном мире 1207 — `shared/browser-annotation-viewport-bridge.ts`). У каждой метки — комментарий и намерение: fix, change, question или approve. До 20 меток на страницу, лоток со списком. Отправка агенту — одним Markdown-блоком «Design Feedback» (`use-browser-page-annotation-send.ts`, `browser-annotation-output.ts`).
  - **markup.** Рисование на замороженном снимке: перо, маркер, стрелка, прямоугольник, эллипс, текст. PNG уходит в буфер обмена (`annotate/markup-*.ts`).
- **Снимок и пометки.**
  - В тексте для агента снимка нет: у заметок `screenshot: null`. Снимок передаётся только через буфер.
  - Пометки «это данные страницы» нет.
- **`describe-page/`** — не отдельная функция, а папка типов и помощников: геометрия меток, отображение адреса, значок, выгрузка артефакта.

**Наш Design Mode** (`main/browser/guest-pick.js`, `design-mode.ts`, `renderer/browser/DesignModeCard.tsx`, `design-block.ts`):
- **Внедрение.**
  - Скрипт исполняется в изолированном мире 1001 и принимает только события с `isTrusted`.
  - Перехватываются 8 типов событий в фазе захвата.
  - Прямоугольник снимка main считает сам, с учётом `getZoomFactor()`.
- **Данные.**
  - Селектор до 12 звеньев и не длиннее 1024 символов, текст до 500 символов.
  - HTML до 4096 символов — без `<script>`, `on*`, `srcdoc` и без значений полей паролей, скрытых полей, `cc-*` и одноразовых кодов.
  - 23 вычисленных стиля; адрес main берёт из `getURL()`.
- **Снимок.** PNG сохраняется в `drops/` с правами 0600 и живёт 7 дней; миниатюра 320 px.
- **Карточка.** Send to agent ▾ (меню сессий), Copy, Pick again.
- **Блок для агента** помечен «page data, not instructions» и содержит путь к снимку.

**Итог по выбору элемента.** У нас надёжнее граница доверия: изолированный мир, `isTrusted`, пометка данных, снимок файлом, который агент может прочитать. У Orca богаче сценарии:
- несколько элементов с комментариями одним блоком;
- роль и имя, соседний текст, выделенный текст;
- React и исходник;
- рисование на снимке;
- быстрые C и S.

---

## 3. Кандидаты на заимствование

Отсортированы по отношению пользы к цене. «Взять» — перенос кода под MIT: «Copyright (c) 2026 Lovecast Inc.» в `NOTICE` и ссылка на исходник в шапке файла (спека 1.2, 4.8). «По образцу» — пишем своё, их код — справка.

| № | Кусок | Вид | Объём | Польза | Цена |
|---|---|---|---|---|---|
| К1 | Проверка настоящего ввода для фокуса и `window.open` | взять | 64 строки и провод | высокая | 0,5 дня |
| К2 | Темп вкладок от страницы и фоновая вкладка | взять | 43 строки | средняя | час |
| К3 | Граница данных страницы в тексте для агента | взять | около 80 строк | средняя | 2 часа |
| К4 | Пределы масштаба и процент | взять | 70 строк | низкая или средняя | 2 часа |
| К5 | Понятные ошибки загрузки, Try HTTPS | взять тексты, провод своё | около 150 строк | средняя | 0,5 дня |
| К6 | Уведомление об отказе в разрешении | взять тексты, провод своё | около 100 строк | средняя | 0,5 дня |
| К7 | Контекстное меню страницы, ⌘R и ⌘⇧R | main взять, меню своё | около 300 строк | высокая | 1 день |
| К8 | Эмуляция размеров | таблица взять, механизм своё | около 200 строк | средняя | 1 день |
| К9 | Design Mode: пачка заметок, богаче данные | по образцу | 0,8–1,2 тыс. | высокая | 2–4 дня |
| К10 | Markup: рисование на снимке | модель и отрисовку взять, провод своё | около 1,5 тыс. | средняя или высокая | 2–3 дня |
| К11 | История адресов и подсказки | взять чистые функции | около 400 строк | средняя | 1–2 дня |
| К12 | Самоподписанный сертификат для localhost | взять с обвязкой | около 700 строк | узкая | 1–2 дня |
| К13 | Полка загрузок | по образцу | около 400 строк | низкая или средняя | 1–2 дня |
| К14 | Локальный HTML по образцу `orca-preview://` (после MVP) | по образцу | около 700 строк | средняя | 2–3 дня |

### К1. Проверка настоящего ввода — `main/browser/browser-route-guest-popup-gesture.ts` (64 строки)

- **Что даёт.** Закрывает остаточный риск 12.2: страница сама берёт фокус и делает активной свою группу. Способ тот же, что спека уже назвала: принимать `browser:focus` только рядом с `input-event` гостя. Заодно `window.open` без жеста человека, например по таймеру в скрытой вкладке, больше не открывает вкладки.
- **Самодостаточность.** Полная: файл зависит только от типа `WebContents`. Жест одноразовый, окно — 1 с; если поток ввода недоступен, жест не засчитывается.
- **Перенос.** Файл как есть, около 20 строк в `main/browser/guard.ts#guardGuest` и тесты.
  - Трекеров два: для фокуса — проверка без расходования жеста, для `window.open` — одноразовый.
- **Рамка и модель угроз.** Совместим: усиливает 12.2, странице ничего не выдаёт.
- **Что доработать.**
  - Окно для `window.open` сверить с пользовательской активацией Chromium (около 5 с). Окно в 1 с может отрезать сценарий «клик → fetch → `window.open`».
  - Проверить живьём, приходит ли `input-event` от `sendInputEvent` — без этого E2E на эту проверку не написать.
  - Программный фокус окна, например `viewRef.focus()` после закрытия FindBar, проверку не пройдёт. Это безвредно: вкладка и так активна.

### К2. Темп вкладок и намерение вкладки — `browser-page-initiated-tab-budget.ts` (26), `browser-popup-new-tab-intent.ts` (17)

- **Что даёт.** Один клик на враждебной странице не набьёт 10 вкладок: не больше 4 за 2 с на одного открывателя. `disposition: 'background-tab'` (⌘-клик) открывает вкладку без фокуса.
- **Самодостаточность.** Полная, это чистые функции.
- **Перенос.** Около часа.
  - В `guard.ts` передавать `disposition` в `browser:open-tab`: в `shared/browser-types.ts#BrowserOpenTab` добавить поле `background`.
  - В `renderer/browser/store.ts#openBrowserTabFrom` ставить `focus: visible && !background`.
- **Рамка.** Совместим.
- **Что доработать.** Строку тоста для отказа по темпу добавить в `S.browser`.

### К3. Граница данных в тексте для агента — `browser-pane/annotate/browser-annotation-output.ts`

Берутся функции `maxBacktickRunLength`, `fence`, `inlineCode` и `inlineText` — около 80 из 228 строк.
- **Что даёт.**
  - HTML страницы в блоке Design Mode (`renderer/browser/design-block.ts`) уходит в ограде из обратных кавычек, которая длиннее любой их серии внутри. Агент однозначно видит, где кончаются данные страницы.
  - `inlineText` схлопывает пробелы Unicode и режет текст по кодовым точкам.
- **Самодостаточность.** Полная.
- **Перенос.** Около 2 часов и правка ожиданий в `design-block.test.ts` и `e2e/browser.spec.ts`.
- **Рамка.** Усиливает 15.1, п. 10. Управляющие символы уже режет `packages/host/src/pty/send.ts#sanitizeForSend`, так что это только про ясную границу для агента.

### К4. Пределы масштаба — `shared/browser-page-zoom.ts` (47), `assemble-chrome/browser-page-zoom-indicator.tsx` (23)

- **Что даёт.** Масштаб держится в пределах 58–249 % шагом 0,5 уровня; при изменении виден процент. Сейчас у нас `getZoomLevel() ± 1` без пределов (`main/ipc.ts`, канал `browser:zoom`).
- **Самодостаточность.** Функции — полная. Индикатор нужно перевести на наши токены и `S`.
- **Перенос.** Около 2 часов.
  - В `main/ipc.ts` считать уровень через `nextBrowserPageZoomLevel` и возвращать его.
  - Показать процент в `BrowserChrome.tsx`.
- **Рамка.** Совместим.

### К5. Понятные ошибки загрузки — `browser-pane/navigate/browser-notices.ts`

Берутся `formatLoadFailureDescription` и `formatLoadFailureRecoveryHint`, а также `shared/browser-certificate-errors.ts` (коды −200…−219) и `shared/browser-url.ts#isEligibleLocalCertificateHost`, `#toHttpsRecoveryUrl`.
- **Что даёт.**
  - Вместо «Couldn't load page» для localhost: «Couldn't connect to your local server…» и совет проверить, запущен ли сервер на нужном порту.
  - Ошибка сертификата называется по имени.
  - Кнопки «Try HTTPS» (для localhost) и «Copy URL».
- **Самодостаточность.** Высокая: это чистые функции, `translate` меняется на `S.browser.*`.
- **Перенос.** Около полудня. `BrowserSurface.tsx` должен хранить из `did-fail-load` код и адрес — сейчас хранится только флаг `loadFailed`.
- **Рамка.** Совместим. Английские строки идут через `S` (страж `english-ui`).

### К6. Уведомление об отказе в разрешении

Тексты — `browser-notices.ts#humanizePermission` и `#formatPermissionNotice`. Адрес для уведомления — по образцу `browser-session-partition-policies.ts#resolvePermissionNoticeUrl`.
- **Что даёт.** Человек видит, например, «localhost:5173 asked for your location, and Harnas denied it» и понимает, почему функция страницы не работает.
- **Самодостаточность.** Тексты — полная. Провод свой: `guard.ts` шлёт окну событие `browser:permission-denied { webContentsId, permission, origin }`.
- **Перенос.** Около полудня.
- **Рамка и модель угроз.** Отказ остаётся отказом.
  - В окно идёт только origin — без пути и query, в них бывают токены.
  - Тост — один на пару «origin + разрешение» за жизнь страницы, иначе страница завалит окно тостами.

### К7. Контекстное меню страницы и клавиши навигации

Main — `main/browser/browser-guest-context-menu.ts` (92 строки). Меню — своё по образцу `assemble-chrome/browser-page-context-menu.tsx`. Клавиши — по образцу `shared/keybindings/definitions-core-3.ts` (`browser.reload`, `browser.hardReload`, `browser.focusAddressBar`).
- **Что даёт.**
  - Правый клик: открыть ссылку во вкладке или в системном браузере, копировать адрес ссылки, копировать выделение, назад, вперёд, перезагрузить, открыть страницу в системном браузере, копировать адрес страницы, DevTools.
  - ⌘R и ⌘⇧R. Жёсткая перезагрузка (`reloadIgnoringCache`) важна при правке фронтенда.
- **Самодостаточность.**
  - Main-часть — высокая: выкинуть работу с токенами Kagi, `readGuestNavigationState` заменить на `canGoBack` и `canGoForward`.
  - Меню рендерера у Orca держится на их сторе и `window.api` — переписать на наш shadcn `DropdownMenu`.
- **Перенос.** Около дня.
- **Рамка и модель угроз.**
  - Ссылка из меню проходит `navigationVerdict` и `layoutUrl`.
  - Во внешний браузер уходит только http(s), через существующий `app.openExternal`.
  - `selectionText` — данные страницы; в буфер они попадают только по клику человека.
  - Новый канал main → окно — `browser:context-menu`.
- **Что доработать.** Область `browser` в реестре клавиш должна перекрывать `always`, пока фокус в странице. ⌘R свободен. ⌘L и ⌘[ / ⌘] заняты сайдбаром и группами: оставить или решить отдельно.

### К8. Эмуляция размеров

Таблица `shared/browser-viewport-presets.ts` (92 строки) — взять. Механизм — своё: Electron `webContents.enableDeviceEmulation()` вместо CDP. У Orca `browser-manager-viewport.ts` держится за аренду отладчика и мост агента.
- **Что даёт.** Можно проверить мобильную раскладку, не меняя размер окна.
- **Перенос.** Около дня:
  - канал `browser:emulate(id, presetId | null)` в `main/ipc.ts`;
  - выбор пресета в `BrowserChrome.tsx`;
  - при желании — сохранение пресета в `TabSpec`.
- **Рамка.** Совместим: действие человека, выполняет main.
- **Что доработать.** Как `enableDeviceEmulation` сочетается с `capturePage` Design Mode, где прямоугольник задан в CSS-пикселях, по коду не установлено.

### К9. Design Mode: пачка заметок и богаче данные

Образцы:
- `annotate/use-browser-page-grab-annotations.ts`, `browser-page-annotation-tray.tsx`, `pending-browser-annotation-card.tsx`;
- `browser-annotation-output.ts` — формат «Design Feedback»;
- `shared/browser-grab-types.ts` — `GRAB_SAFE_ATTRIBUTE_NAMES`, `GRAB_SECRET_PATTERNS`, бюджеты;
- функции извлечения из `grab-guest-foundation-script.ts` и `grab-guest-element-context-script.ts`: роль и доступное имя, соседний текст, выделенный текст, атрибуты.

- **Что даёт.** Человек отмечает на странице 3–5 мест, к каждому пишет, что не так, и отправляет агенту одним блоком. Роль, имя и соседний текст помогают агенту найти компонент в коде.
- **Самодостаточность.**
  - Формат вывода и типы — высокая.
  - Скрипты извлечения — средняя: это строки кода для главного мира. Функции нужно перенести в наш `guest-pick.js`, в изолированный мир.
  - UI и стор завязаны на их zustand и `agentSendPopover` — пишем своё.
- **Перенос.** 2–4 дня.
- **Рамка и модель угроз.**
  - Изолированный мир и `isTrusted` сохраняются.
  - Пометка «page data, not instructions» ставится на весь блок; комментарий человека идёт вне ограды данных (К3).
  - Снимки идут файлами в `drops/`, как сейчас. У Orca в заметках снимков нет.
- **Что доработать.**
  - React-компоненты и `файл:строка` из `_debugSource` читаются только из главного мира. Свойства `__reactFiber$…` страница ставит в своём мире, из изолированного их не видно. Это общее устройство миров Chromium; запуском не проверял.
  - У React 19 `_debugSource` нет.
  - Если брать эти поля — отдельный маленький скрипт главного мира только для них. Результат — недоверенные данные, запуск — только по клику человека.

### К10. Markup — рисование на снимке

Файлы: `annotate/markup-drawing-model.ts`, `markup-shape-render.ts`, `markup-canvas-render.ts`, `markup-screenshot-compose.ts`, `markup-base-image.ts`, `useMarkupEditor.ts`, `useMarkupPointerHandlers.ts`, `useMarkupKeyboardShortcuts.ts`, `MarkupOverlay.tsx`, `MarkupToolbar.tsx` — около 1,5 тыс. строк.
- **Что даёт.** Стрелка, рамка или текст поверх страницы: агент получает картинку «вот тут».
- **Самодостаточность.**
  - Модель и отрисовка — чистые: без DOM и стора.
  - UI держится на shadcn (`button`, `tooltip`, `popover` у нас есть), `sonner`, `translate` → `S` и `@/lib/browser-uuid`.
- **Перенос.** 2–3 дня.
- **Рамка и модель угроз.** У Orca снимок делает рендерер (`webview.capturePage()` в `markup-base-image.ts`), а у нас рендерер страницей не управляет (12.2). Поэтому:
  - снимок — через main: новый вызов моста `browser.capture(id)` возвращает `data:`;
  - итоговый PNG — в `drops/` через main и `pty.send` с путём, как у Design Mode (12.5);
  - буфер обмена — дополнительно.

### К11. История адресов и подсказки

Файлы: `shared/workspace-session-browser-history.ts` (63), `renderer/src/lib/browser-history-match.ts` (143, плюс `browser-palette-search.ts#formatBrowserPaletteUrl`). Идея — `browser-address-bar-suggestions.ts`, но без поисковиков.
- **Что даёт.** Ввод «5173» или «settings» подсказывает недавние локальные адреса.
- **Самодостаточность.** Высокая, это чистые функции.
- **Перенос.** 1–2 дня:
  - хранилище в `~/.harnas/desktop/` — новый файл или `ui.json`, до 200 записей, адреса только после `layoutUrl`;
  - выпадающий список в `AddressBar.tsx`.
- **Рамка.** Адреса пишутся на диск — нужно решить, резать ли query: в адресах бывают токены.

### К12. Самоподписанный сертификат для localhost

Файлы:
- main: `browser-certificate-trust-controller.ts` (307), `browser-certificate-request-guard.ts` (212), `browser-certificate-challenge.ts` (77), `browser-certificate-identity.ts` (29);
- shared: `shared/browser-certificate-errors.ts`, части `shared/browser-url.ts`;
- UI: кнопка Proceed в `navigate/browser-load-failure-overlay.tsx`.

- **Что даёт.** `https://localhost` с самоподписанным сертификатом открывается после явного клика — например, `vite` с basic-ssl.
- **Самодостаточность.** Средняя:
  - хуки менеджера (контекст гостя, начало и коммит навигации, уведомление окна) заменить событиями нашего `guard.ts`;
  - `getProxySessionApplicationReadiness` выкинуть;
  - `webRequest.onBeforeRequest` ставится на весь раздел.
- **Перенос.** 1–2 дня.
- **Рамка и модель угроз.**
  - Нужна правка спеки 12.2: там сказано «`certificate-error` не перехватывается».
  - Модель угроз приемлема: страница не может нажать Proceed — кнопка в окне. Только loopback, только `ERR_CERT_AUTHORITY_INVALID`, привязка к SHA-256 и к гостю, 5 минут.
  - Польза узкая: сертификаты `mkcert` с доверенным корнем и так проходят.

### К13. Полка загрузок

По образцу `main/browser/browser-manager-download-lifecycle.ts` (события прогресса), `navigate/browser-page-download-list.tsx`, `browser-download-progress.ts`. Наш диалог сохранения остаётся.
- **Что даёт.** Видно, что качается; загрузку можно отменить и показать в Finder.
- **Перенос.** 1–2 дня.
- **Рамка и модель угроз.**
  - Путь файла в окно не отдаётся (15.2: рендерер не получает путей вне корней). Окно знает только id загрузки и имя.
  - «Show in Finder» — вызов `browser.revealDownload(id)` в main.
  - «Открыть файл» не делать.

### К14. Локальный HTML по образцу `orca-preview://` — после MVP, спека 17.11

Файлы: `doc-preview-protocol.ts` (145), `doc-preview-grant-registry.ts` (327), `doc-preview-guest-policy.ts` (240), `shared/doc-preview-scheme.ts`.
- **Что даёт.** HTML из worktree открывается во вкладке без `file:`.
- **Самодостаточность.** Протокол и грант — средняя. Читатель файлов `doc-preview-file-reader.ts` у Orca завязан на SSH и runtime — свой на `fs` и `main/roots.ts` с `realpath`.
- **Рамка.** Это строже, чем предлагает 17.11 (`protocol.handle('file')`):
  - своя привилегированная схема и непостоянный раздел;
  - CSP-заголовок `default-src 'self'`;
  - все внешние запросы отклоняются через `webRequest`;
  - без загрузок и разрешений; WebRTC — `disable_non_proxied_udp`.

  Их принятый остаток: DNS-prefetch может отправить наружу «маяк» (`browser-route-dns-prefetch.electron.test.ts`).
- **Перенос.** 2–3 дня.

**Мелочи — по часу:**
- `describe-page/browser-favicon-url.ts#pickDisplayableFaviconUrl` — брать первый пригодный значок, а не первый в списке. У нас `guard.ts` берёт первый: если это `data:,` страницы без значка, значка не будет, даже когда дальше в списке есть настоящий.
- Полноэкранный режим элемента внутри вкладки: `shared/browser-guest-web-preferences.ts` (`disableHtmlFullscreenWindowResize`) и разрешение только `fullscreen`. Окно не растягивается. Требует исключения в 12.2, где сказано «все разрешения — отказ».

---

## 4. Чего не брать

| Кусок | Файлы Orca | Почему |
|---|---|---|
| Управление браузером агентом | `agent-browser-*.ts` (24 файла, 3,3 тыс.), `cdp-*.ts` (26, 4,0 тыс.), `snapshot-*.ts`, `electron-debugger-lease.ts`, `agent-browser-orphan-sweep.ts`; CLI — `skill-guides/orca-cli/references/browser.md` | Рамка 15.1, п. 9 и 12.2. Команды `eval` и `cookie get` прямо выносят данные страницы и куки. Бинарник `agent-browser` из npm исполняет main; если его нет — берётся из `PATH` (`agent-browser-bridge-process.ts#resolveAgentBrowserBinary`) |
| Импорт куков и «идентичность» браузера | `browser-cookie-*.ts`, `chromium-cookie-*.ts`, `client-route-cookie-import-*`, `browser-session-cookie-staging.ts` (около 4,7 тыс.); `browser-google-auth-ua.ts`, `browser-session-ua*.ts`, `browser-process-user-agent.ts`, `browser-identity-mode-*.ts` | Код читает ключи «Chrome / Edge / Arc / Brave Safe Storage» из Keychain и `Cookies.binarycookies` Safari — учётные данные чужих приложений (дух 15.1, п. 1). Подмена UA для входа в Google обходит политику Google против встроенных браузеров |
| Авто-разрешения | `browser-session-permission-policy.ts`, `browser-media-access.ts`, `browser-webauthn-*.ts` | 12.2: страница недоверенная. `clipboard-read` читает буфер человека; `notifications` шлёт уведомления от имени приложения; камера и микрофон открываются по одному разрешению macOS на всё приложение |
| Автосохранение загрузок и «открыть файл» | `browser-download-destination.ts`, `browser-manager-download-creation.ts` | Страница кладёт файлы в `~/Downloads` без человека, а «открыть» запускает скачанное одним кликом. По 12.2 — только диалог сохранения |
| `file:` во вкладке | `shared/browser-url.ts#normalizeBrowserNavigationUrl` пускает `file:` и превращает абсолютный путь в `file://`; в `browser-manager-guest-navigation-policy.ts` сказано «initial file:// attach is allowed» | 12.2: фьюз `GrantFileProtocolExtraPrivileges` включён по умолчанию, его выключения в снимке не нашёл |
| Внедрение Design Mode в главный мир | `grab-guest-*.ts` через `executeJavaScript` (`browser-manager-grab.ts`), `window.__orcaGrab` | Клик принимается без `isTrusted`, ширина окна для обрезки снимка берётся из мира страницы (`browser-grab-screenshot.ts`). Это слабее нашего изолированного мира 1001: страница может подделать или вызвать выбор. Брать только правила извлечения полей (К9) |
| Нативные окна-попапы с полосой origin | `popup-origin-bar-window.ts` (281), `SAFE_POPUP_WINDOW_OPTIONS` в `browser-manager-types.ts` | 12.2: окон нет. Если понадобится вход OAuth во всплывающем окне — отдельное решение со своей моделью угроз |
| Удалённые страницы, туннели, трансляция | `browser-client-*`, `paired-runtime-*`, `browser-host-*`, `browser-network-*`, `remote-browser-socks-*`, `ssh-*`, `wsl-*`, `local-ssh-*`, `browser-route-*`, `browser-screencast-*`, `offscreen-browser-backend.ts`, `browser-pane/stream-remote/`, `ClientHosted*` (около 17,5 тыс. в main и 6,5 тыс. в рендерере) | У нас нет удалённых работ. Код завязан на их paired runtime и протокол; большой объём |
| «Share as artifact» | `describe-page/browser-artifact-upload.ts` | Публикует в облако Orca (15.1, п. 8) |
| Профили с отдельными разделами | `browser-session-registry.ts`, `browser-session-meta-store.ts`, `browser-route-partition-*` | Завязаны на их профили, импорт и маршруты. Если понадобится изоляция проектов — свой «раздел на работу» и реестр разделов в `guard.ts` |
| Preload гостя | `src/preload/browser-window-close*.ts` | У нашего гостя preload нет вовсе (12.2). Нужен ли `<webview>` в Electron 44 заглушённый `window.close()`, по коду не установлено |
| Машина восстановления и удержания гостей | `host-guest/browser-page-guest-recovery.ts`, `browser-guest-worktree-retention.ts`, `browser-guest-paint-retention.ts`, `webview-registry.ts` | Держится на их реестре страниц и сторе. Нам хватает слоя «Page crashed» и LRU-3 |
| Значок через `<img>` в окне | `components/browser-favicon.tsx` | У нас строже: значок качает main с пределами и без редиректов (fix-9), у окна есть CSP |
| Фасад `BrowserManager` | `browser-manager*.ts` — цепочка наследования около 20 классов с общими картами | Архитектура: куски не вынимаются без базы |
| Фоновые гости без троттлинга | `setBackgroundThrottling(false)` для всех гостей (`browser-manager-guest-policy.ts`) | Им это нужно для фоновых снимков агента. Нам — лишний расход CPU скрытыми вкладками |
| Поисковики в адресной строке | `buildSearchUrl`, работа с токенами Kagi в `shared/browser-url.ts` | 12.1: поиска нет |

---

## 5. Рекомендация

1. **Взять сейчас, отдельным куском fix-9c, около дня.**
   - `browser-route-guest-popup-gesture.ts` — проверка настоящего ввода для `browser:focus` и `window.open`. Закрывает остаточный риск 12.2.
   - `browser-page-initiated-tab-budget.ts` и `browser-popup-new-tab-intent.ts`.
   - `shared/browser-page-zoom.ts`.
   - Ограду из `browser-annotation-output.ts` — в `design-block.ts`.

   Всё — с записью в `NOTICE`.
2. **Сделать своё по их образцу — ежедневные удобства, около двух дней.** Понятные ошибки загрузки и отказов в разрешениях (тексты из `navigate/browser-notices.ts`), контекстное меню страницы (`browser-guest-context-menu.ts`), ⌘R и ⌘⇧R.
3. **Развить Design Mode по образцу annotate и markup, около недели.**
   - Пачка заметок с комментарием.
   - Роль, имя и соседний текст — из изолированного мира.
   - Markup: снимок через main, доставка в `drops/` и `pty.send`.

   Изоляцию, `isTrusted` и пометку данных сохранить.
4. **После MVP — по образцу.** `orca-preview://` для локального HTML (17.11), эмуляция размеров через `enableDeviceEmulation`, история адресов. Самоподписанный сертификат localhost и полку загрузок — только с правкой 12.2 и 15.2 и если попросят.
5. **Не брать.** Управление агентом (CDP, `agent-browser`), импорт куков и подмену UA, авто-разрешения, автосохранение загрузок, `file:`, окна-попапы, удалённые страницы и туннели.

---

## 6. Что не удалось установить по коду

- Как Orca делает панель активной по клику в страницу. Файлы `host-guest/browser-focus.ts` и `assemble-chrome/use-browser-page-chrome-focus.ts` есть, но связь «клик в госте → активная панель» не прослежена.
- Приходит ли в Electron 44 `input-event` от `sendInputEvent` — это нужно для E2E проверки из К1.
- Есть ли в Electron 44 у `<webview>` с `allowpopups` собственная блокировка `window.open` без жеста. Если есть — проверка К1 для `window.open` избыточна, для фокуса она остаётся.
- Ограничивает ли Chromium сам уровень `setZoomLevel`: своих пределов у нас нет.
- Нужен ли гостю `<webview>` заглушённый `window.close()`. Orca ставит preload именно ради этого.
- Работает ли у нас вход OAuth во всплывающем окне. По коду — нет, потому что `window.opener === null`; живьём не проверялось.
- README Orca обещает снимок элемента прямо в запросе агенту. В снимке кода у заметок `screenshot: null`, а лист `GrabConfirmationSheet.tsx` с кнопкой «Attach to AI» не подключён — используется только его форматтер текста. Снимок идёт через буфер обмена.
- Что React-метаданные недоступны из изолированного мира, выведено из устройства миров Chromium, а не проверено запуском.
- Обработчика `select-client-certificate` в снимке Orca нет. Что Electron делает по умолчанию, известно только из нашей спеки 12.2 («первый сертификат из хранилища»); не проверено.
