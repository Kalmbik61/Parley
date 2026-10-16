# Браузер Parley, этап B: что даёт код Orca — карта для переписывания плана

**Дата:** 2026-10-08. **Основа:** worktree `browser-plan-b` (ветка `docs/browser-plan-b-orca`, голова `97d5e85` = origin/master с влитым этапом A, v0.8.1), план B (`2026-10-07-browser-devtools-agent-plan-b-context.md`, 8520 строк, 25 задач), спека, индекс, отчёт этапа 0 (`docs/research/2026-10-08-browser-stage0.md`, он в ветке есть). **Orca:** `stablyai/orca`, коммит `b1cd858`, MIT, Copyright (c) 2026 Lovecast Inc., Electron 43.7.5, React 19.2.8 (у нас Electron 44.4.5, React ^18). Код ни Parley, ни плана не менялся; это единственный новый файл.

Ссылки вида `orca:путь:строки` — в клоне Orca (`src/…`), `parley:путь:строки` — в worktree (`packages/desktop/src/…`), `план B:N` — строка файла плана B.

## 0. Вывод

1. Orca перекрывает у нас **узкую полосу**: DOM-часть скрипта выбора (селектор, ограниченный текст, фильтр хэшированных классов, очистка URL), поиск React-компонента, слой номерных меток и два UI-каркаса (карточка комментария, лоток). Доставки в цель, файлов-контекстов, маски, шаблонов, чипов, цели «To», хранилища и цикла аннотаций, областей-рамок, снимков, правок по клику в Orca **нет** вообще.
2. Из 25 задач: **21 остаётся как есть** (с точечными правками текста), **4 — «адаптировать копию»** (14, 15, 18, 21), **«заменить копией целиком» и «удалить» — ни одной**. Примерно 4840 строк плана (57 %) Orca не касается, ещё ~1670 (20 %: задачи 16, 19, 22) — наши, Orca там почти не помогает; затронуто ~1890 (22 %: задачи 14, 15, 18, 21).
3. **Экономия объёма скромная:** оценка (не замер) — брутто 300–450 строк плана в задачах 14, 15, 18, 21; нетто после новых задач Б2 (~+120) и Б26 (~+40) около 150–290 строк из 8520 (2–3 %). Выигрыш — в **качестве** отдельных функций (см. п. 2.1: селектор для Tailwind-страниц, имена React-компонентов через `forwardRef`/`memo`, ограниченный обход текста), а не в количестве кода.
4. **Три нарушения наших ограничений, которые копия «как есть» принесла бы:** всё исполняется в главном мире страницы (`executeJavaScript`); в скриптах нет проверки `isTrusted`; левый клик по элементу сам кладёт данные в буфер обмена, а меню «Send» отправляет аннотации агенту с автоподтверждением (`submit-after-ready`).
5. **Два события в master после написания плана ломают его тексты:** ⌘⇧A занят действием `sidebar.agents` (PR #34), а у Codex появился вид Chat (PR #36), поле которого принимает вложения списком `Attachments:`, а не `@"путь"`. Отчёт этапа 0 уже принят, но в план B его решения ещё не внесены (п. 4.4).
6. Нужны решения человека (п. 7): клавиша Annotate, насколько «богатый» payload брать у Orca (по умолчанию — нет), правка метки в лотке или в окне у метки, Popover вместо своих расчётов места редактора.

## 1. Задачи 1–25: вердикт

Строки — размер задачи в плане B (границы по заголовкам `## Задача N`).

| № | Задача (строк) | Вердикт | Файлы Orca (строки) | Что остаётся нашим |
|---|---|---|---|---|
| 1 | Сверка с этапом 0 и с A (113) | оставить, переписать шаги 2–3 | — | Решения этапа 0 уже приняты (stage0:211–235): `parseDebugStack` вместо ветки `_debugStack`; CDP-клип основной, `capturePage` запасной; `annotationFullPage` удалить. Добавить шаг «пин Orca b1cd858» |
| 2 | `redact.ts` (270) | оставить | не берём `GRAB_SECRET_PATTERNS` (`orca:shared/browser-grab-types.ts:231–245`) — 13 подстрок, проверка по **значению**, у нас по **имени** | Вся маска |
| 3 | `context-markdown.ts` (311) | оставить; убрать `annotationFullPage` (план B:460, 604, 613) | образец `fence`/`maxBacktickRunLength` (`orca:…/annotate/browser-annotation-output.ts:103–130`) — у нас такая же функция, спека 3.6 уже ссылается на «К3 сравнения с Orca» | `fence`, `assemble`, `header`, лимиты |
| 4 | Шаблоны element/console/request/errors (563) | оставить | формат Orca («Design Feedback», `Intent`, `Feedback`, без ограды и без `pageDataNote`) не подходит | Все шаблоны. `selectorTail` совместим с селекторами Orca (сверка по подмножеству классов, `parley:element-info` в плане B:4391–4403) |
| 5 | Шаблон `annotations` + типы (270) | оставить | `browser-annotation-output.ts:150–250` — только порядок полей как образец; `intent` не нужен (спека 2.13) | Шаблон, типы меток |
| 6 | `context-files.ts` (317) | оставить | аналога нет (Orca держит снимок data-URL в памяти окна) | Всё |
| 7 | Мост `saveContext` (159) | оставить | нет | Всё |
| 8 | `BrowserTarget` в раскладке (121) | оставить | нет | Всё |
| 9 | `targets.ts` (182) | оставить | нет | Всё |
| 10 | Чипы, `.png` в промпте и письме (382) | оставить + правка текста про Codex | нет | Всё. См. п. 4.2 |
| 11 | `deliver.ts` + тост (524) | оставить | `browser-page-grab-toast.tsx` (105) — тост у элемента, не нужен: у нас sonner | Всё |
| 12 | Меню «To» (374) | оставить | нет | Всё |
| 13 | «Add to chat» из Console/Network (307) | оставить | нет | Всё |
| 14 | CDP для Select: `REACT_INFO_FN` и пр. (551) | **адаптировать копию** (часть) | `orca:main/browser/grab-guest-react-script.ts:11–94` (поиск fiber, имена, путь исходника) | `guest-data.ts`, `element-info.ts` (роль и имя — **CDP AX**, у Orca они прикидываются по DOM: `grab-guest-content-script.ts:129–164`), `inspector.ts`, закрытый список, `parseReactInfo`. React 19 — `parseDebugStack` из этапа 0 (у Orca нет). Сама функция в плане — 42 строки (план B:4294–4335), экономии объёма нет, выигрыш в качестве |
| 15 | Select в main: точка, ⇧, снимок (403) | **адаптировать копию** | DOM-данные: новый `guest-dom` (п. 5, задача Б2) из `orca:grab-guest-{foundation,content,element-context}-script.ts`; запасной снимок: `orca:main/browser/browser-grab-screenshot.ts:21–105` | `point`/`shift`/`scroll` (в Orca их нет), `isTrusted`, `validatePick`, `captureClip`, основной снимок CDP-клипом (решение этапа 0), `design-mode.ts` как контроллер выбора (в нём уже есть навигация, падение процесса, загрузки — `parley:design-mode.ts:193–274`) |
| 16 | Select в окне, ⌘⇧C (447) | оставить | `useGrabMode.ts` (274) — автомат на `window.api.browser.*` и `translate`, не берём | `BrowserMode`, хранилище, строка вкладки, палитра |
| 17 | Гид агента (95) | оставить | нет | Всё |
| 18 | `guest-annotate.js` (577) | **адаптировать копию** (основная экономия) | слой меток: `orca:shared/browser-annotation-viewport-bridge.ts:80–263`; DOM-часть — `guest-dom` | Области-рамки, правка по клику на метку, `sync(pins)` по ключам, `waiting()`, `isTrusted`, ключевые 10 стилей, события. Реализация в плане — 348 строк (план B:5673–6020), из них ~160 уходят в общий `guest-dom` и адаптацию слоя меток |
| 19 | Аннотации в main (707) | оставить | стиль проверки полей: `orca:browser-grab-payload.ts:25–221` (образец для `validateAnnotationPick`) | Всё. Снимок — только видимая часть (этап 0): упрощается, убрать ветку «страница длиннее 8000 px» (план B:6046, 6283, 6575) |
| 20 | Лоток: состояние вкладки (274) | оставить | срез Orca (`orca:renderer/store/slices/browser/browser-page-annotation.ts`, 41) — другая модель: записи с `intent`/`priority`, без нумерации 1…N и Undo | Всё |
| 21 | Редактор и лоток (354) | **адаптировать копию**, по решению человека | карточка: `…/annotate/pending-browser-annotation-card.tsx` (167); лоток: `…/annotate/browser-page-annotation-tray.tsx` (333); якорь: `…/describe-page/browser-annotation-geometry.ts:50–72` | Сворачивание «N annotations», цель `Region 308 × 20`, пометка `element gone`, Clear, «Add to chat», строки `S.browser.annotate.*`. По коду копия не короче (500 строк Orca → ~250 после вырезания); плюс — Radix-Popover с коллизиями вместо `ANNOTATION_EDITOR`/`editorAt` |
| 22 | Annotate во вкладке (512) | оставить, сменить клавишу | нет | Цикл меток, `useAnnotateMode`, строка вкладки. ⌘⇧A занят (п. 4.1) |
| 23 | E2E (432) | оставить; правки: клавиша, сеть Codex-стаба (п. 4.2) | `orca:tests/e2e/…` нет полезного | Всё |
| 24 | Документы (122) | оставить | — | CHANGELOG, README, спека окна 12.2/12.3/12.5; ключ Annotate; убрать из текста «⌘⇧A» |
| 25 | Завершение (24) | оставить + поиск маркера Orca | — | Добавить в проверки команду сверки файлов с `NOTICE` (п. 6) |

Что **не** вошло в 25 задач, но нужно: общий `guest-dom` (Б2 в п. 5) и NOTICE (Б26).

## 2. Модули Orca, которые стоит копировать

Состояние «мир» — можно ли исполнить в изолированном мире 1001 (DOM-only). Orca исполняет **всё** в главном мире: `guest.executeJavaScript(...)` без `worldId` (`orca:browser-manager-grab.ts:69, 77, 117`, `browser-grab-session-controller.ts:132, 216`, `browser-grab-screenshot.ts:47, 52, 66`, `browser-guest-grab-shortcuts.ts:45`). Исключение — мост меток: `executeJavaScriptInIsolatedWorld(1207, …, false)` (`orca:main/browser/browser-manager-viewport.ts:117–122`), та же схема, что у нас с 1001.

Во всех файлах `@ts-nocheck` нет (grep по `grab-guest-*`, `browser-grab-*`, `browser-annotation-*`, `annotate/*`).

### 2.1 Брать (с адаптацией)

| Orca (путь, строки) | Что делает | Зависимости от Orca | Что вырезать/заменить | Мир 1001 |
|---|---|---|---|---|
| `main/browser/grab-guest-foundation-script.ts` (152) | `BUDGET` (18–31), `SAFE_ATTRS` (37), `SECRET_PATTERNS` (42–48), `clampStr`, `containsSecret` (63), `sanitizeUrl` (72–89: query и hash удалены, схемы только http/https/file), накопитель текста без регулярок, `getBoundedText` (TreeWalker, не больше 80 узлов, 128–146) | Нет. Это строка-шаблон (`\\` вместо `\`), в начале (11–20) сносит чужой `window.__orcaGrab` | Переименовать `__orcaGrab`; бюджеты — из наших `PICK_LIMITS` (подставить значения в начало скрипта или зеркало + тест сверки, как делает Orca в `grab-guest-script.test.ts:70–80`); убрать `SECRET_PATTERNS` — маска наша; `\\`→`\` | Да |
| `main/browser/grab-guest-content-script.ts` (164) | `getSelectedText` (1–58), `getHtmlSnippet` (60–69), `getSafeAttributes` (71–95), `getAccessibility` (129–164) | Нет | Брать `getSafeAttributes` как идею (очистка `href`/`src`/`action`) для нашей `cleanHtml`. **Не** брать `getHtmlSnippet`: снимает только `<script>` (наша `parley:guest-pick.js:107–121` ещё снимает `<style>`, `on*`, `srcdoc`, значения секретных полей). **Не** брать `getAccessibility` — у нас роль и имя из CDP AX. `getSelectedText` — по решению | Да |
| `main/browser/grab-guest-element-context-script.ts` (228) | `looksHashy`/`getStableClasses` (21–35: отсекает `css-xxxx` и хэшированные CSS-modules), `buildSelectorPart`/`isUniqueSelector`/`getNthOfTypeSuffix`/`buildSelector` (37–93: кратчайший **уникальный** суффикс пути, ≤10 звеньев, ≤2 класса на звено, `:nth-of-type` только когда нужно), `getComputedStyleSubset` (1–10, 16 свойств camelCase), дальше `buildReadablePath`, `buildFullPath`, `getNearbyText`, `getAncestorPath`, `getNearbyElements` (95–228) | Нет | **Брать `buildSelector` с вспомогательными** вместо `selectorOf` (`parley:guest-pick.js:73–97`, и копии в `guest-annotate.js` плана B:5719–5779): наш берёт все классы каждого звена без проверки уникальности — на Tailwind-странице (в том числе самом окне Parley) строка из 10–20 классов на звено режется пределом 1024. Стили оставить наши (23 ключа, kebab). `buildReadablePath` и далее — только при «богатом» payload (п. 7) | Да |
| `main/browser/grab-guest-react-script.ts` (152) | `getFiberFromElement` (11–23: ключи `__reactFiber$…` и `__reactInternalInstance$…`), `getComponentNameFromFiber` (25–37: `type.displayName`/`name`, `type.render` для forwardRef, `type.type` для memo), `shouldSkipReactName` (39–44), `cleanSourcePath` (46–60: webpack/turbopack/`http://host/`/`file://`, query), `getReactMetadata` (62–94: подъём по `return` до 35 звеньев, `_debugSource` или `_debugOwner._debugSource`) | Нет (использует `containsSecret`, `clampStr` из foundation — перенести внутрь) | Перенести в тело `REACT_INFO_FN` (см. п. 2.2). **Не копировать `shouldSkipReactName` целиком:** регулярка `^(Inner|Outer|Client|Server|RSC|Dev|React|Hot)` и суффиксы `Wrapper|Context|Provider…` выбросят нужные имена (`ClientList`, `ServerStatus`, `DevPanel`, `ButtonWrapper`). Оставить точные имена каркаса: `Fragment`, `Suspense`, `Profiler`, `*.Provider`, `*.Consumer`. Порядок у Orca — внешний → внутренний (`<A> <B>`), у нас по спеке 3.6 `SaveButton < SettingsForm < SettingsPage` (изнутри наружу) | **Нет, главный мир.** Свойства `__reactFiber$…` на узле видны только в мире страницы |
| `shared/browser-annotation-viewport-bridge.ts` (268), слой меток 80–263 | Закрытый shadow-корень на `document.body` с `pointer-events:none`, кружки 24 px (`#2563eb`, белая рамка, 155), перерисовка по `requestAnimationFrame` на `scroll` (capture, окно и документ) и `resize`, состояние в `globalThis[stateKey]`, очистка на `beforeunload`, `visible`-отсечение за экраном | Нет. Сборка строки скрипта, мир 1207 (`:26`), токен | Мир → `PICK_WORLD_ID` 1001. **Убрать `console.debug(prefix+token+…)` (138):** наш инспектор пишет все `Runtime.consoleAPICalled` в журнал Console (`parley:inspector.ts`), и служебные строки попали бы в панель человека. Данные меток: у Orca — прямоугольники в координатах **документа** (`rectPage`), они не следуют за элементом, прокрученным во вложенном контейнере; у нас по плану `sync(pins)` каждый кадр читает живой `getBoundingClientRect()` по ключу — оставить наше. Номера — по порядку пунктов лотка, ≤20 | Да |
| `main/browser/browser-grab-screenshot.ts` (106), функция 21–105 | `capturePage()` всей видимой части, масштаб **измеряется** как `bitmap.width / window.innerWidth` (66–70, учитывает zoom и DPR без знания о них), обрезка `NativeImage.crop` (79–83), отказ при пустой картинке и при PNG > 2 МиБ (87) | `GRAB_BUDGET`, прячет оверлей скриптом в главном мире (47, 52) | Брать как **запасной** путь Select вместо `captureRect` + `getZoomFactor() × scale` плана B:4753+. `innerWidth` взять из `pick.viewport.width` (у нас он уже в `ValidPick`), без запроса к странице. Скрытие оверлея не нужно: `guest-pick.js` снимает оверлей и ждёт два кадра до ответа. Вернуть `Buffer`, а не data-URL (в `saveImage` через IPC большие data-URL не гоняем). Сверить с данными этапа 0: `capturePage()` без прямоугольника при эмуляции отдаёт «вид × DPR» (stage0:83, 750×1624) — формула `ширина/innerWidth` даёт верный множитель | — (main) |
| `renderer/…/annotate/pending-browser-annotation-card.tsx` (167) | Radix `Popover` с якорем-точкой, `collisionBoundary`, `collisionPadding`, перенос вверх/вниз, textarea 2000, Enter с модификатором — отправка, Esc — отмена | `@/components/ui/{button,toggle-group,label,popover}`, `@/lib/ime-text-field` (`ImeTextarea`), `@/lib/screen-submit-shortcut`, `translate`, `GRAB_BUDGET`, `BROWSER_ANNOTATION_INTENT_OPTIONS` | `translate` → `S.browser.annotate.*`; убрать `intent`/ToggleGroup/Label; `ImeTextarea` → обычный `<textarea>` + `nativeEvent.isComposing` (как в плане B:7243); `portalContainer` — у нашего `ui/popover.tsx` нет (там `Portal` внутри, `parley:renderer/ui/popover.tsx:20–30`) → добавить необязательный проп или вынести `Portal`; Enter — сохранить (спека 4.7), а не ⌘Enter | — (окно) |
| `renderer/…/annotate/browser-page-annotation-tray.tsx` (333) | Лоток справа внизу, ряд: номер-кружок, цель, комментарий `line-clamp-2`, кнопки правки и удаления по наведению, правка в строке | `useAppStore`-пропсы, `translate` (в файле 91 вызов на всю папку), `can-hover:` (нашего варианта в стилях нет), `ReviewNotesSendMenuContent` через меню «Send», `Tooltip`, `ToggleGroup` | Вырезать «Send» (автоотправка, п. 3.7), «Copy», `intent`; добавить сворачивание, `gone`, `Region …`, Clear, «Add to chat»; `can-hover:opacity-0` заменить на `group-hover` | — (окно) |
| `renderer/…/describe-page/browser-annotation-geometry.ts` (102), `getBrowserOverlayAnchor` 50–72 | Якорь редактора относительно `<webview>` и контейнера, переворот вверх/вниз по высоте карточки | `translate`, `lucide`, типы Orca | Взять расчёт якоря, остальное — нет. У нас метки в долях вьюпорта (`AnnotationPosition.rect`), пересчёт по прямоугольнику `<webview>` — наш | — |

### 2.2 Как Orca читает React и может ли это стать `REACT_INFO_FN`

- Orca: скрипт в **главном мире** (`executeJavaScript`), `Object.keys(el)` → ключ с префиксом `__reactFiber$` или `__reactInternalInstance$` (React 16/17), затем цикл по `fiber.return` (≤35), имя компонента из `type`, исходник — `_debugSource` самого узла или `_debugOwner._debugSource` (`orca:grab-guest-react-script.ts:73`). `_debugStack` (React 19) **не читается**: источник у React 19 всегда `null`.
- В изолированном мире 1001 этого не сделать: expando-свойство лежит на обёртке главного мира, из другого мира `Object.keys` его не увидит (это и причина плана: CDP `Runtime.callFunctionOn`).
- **Да, логика ложится в `REACT_INFO_FN`**: функция Orca — чистый ES5 без внешних замыканий, кроме `containsSecret`/`clampStr` (инлайнятся). Оборачивается в `function () { var el = this; … return {…} }`, вызывается через `DOM.resolveNode` → `Runtime.callFunctionOn({ functionDeclaration: REACT_INFO_FN, returnByValue: true })` — путь плана B:3984, 4448 не меняется, проверка `cdpCallAllowed` (`functionDeclaration === REACT_INFO_FN`) тоже. Что добавить: ветка React 19 — `parseDebugStack` из stage0:161–177 (`approx: true`); структура ответа остаётся нашей (`{ name, source, approx }[]`, ≤3, имя 100, источник 300 — `REACT_LIMITS`), а не строка `<A> <B>` из ≤6 имён Orca. Источник элемента — `_debugSource` узла DOM, источник компонента — «где использован в родителе» (stage0:148): так в плане, у Orca одно поле `sourceFile`.
- При копировании из `*.ts` Orca помнить: тело там — шаблонная строка, обратные слэши удвоены (`\\/`, `\\(`). В `REACT_INFO_FN` (тоже строка, план B:4294) удвоение нужно ровно так же; если функция живёт как обычный `function` и берётся через `Function.prototype.toString`, удвоения нет — выбрать один способ и покрыть тестом `new Function('return (' + REACT_INFO_FN + ')')` (план B:3984).

### 2.3 Не копировать

| Orca | Строк | Почему |
|---|---|---|
| `grab-guest-overlay-script.ts` | 100 | Полноэкранный перехватчик кликов `pointer-events: all` (1–4) блокирует колесо и hover вложенных контейнеров; в файле `wheel` нет. Нам нужно, чтобы страница прокручивалась во время Select и Annotate (прокрутка «любого контейнера» — спека 4.7). Наш способ (слушатели на `window`, оверлей `pointer-events: none`, `parley:guest-pick.js:43`) лучше. Спека 4.6 требует рамку «как сейчас» |
| `grab-guest-selection-scripts.ts` | 130 | `awaitClick`/`finalize`/`extractHover`/`teardown`: нет `isTrusted`; обход Zone.js (`async` обёртка вокруг `Promise`) в мире 1001 не нужен; ПКМ-меню и `__orcaCancelled` — не наши |
| `grab-guest-script.ts` | 45 | Только сборка фрагментов в одну строку — идея в п. 5 (Б2) |
| `browser-grab-session-controller.ts` | 234 | У нас уже есть: отмена на навигации, `render-process-gone`, `destroyed`, загрузка (`parley:design-mode.ts:193–274`). Добавить 120 с тайм-аута? Не нужно |
| `browser-grab-ipc.ts`, `browser-manager-grab.ts` | 198 + 126 | Реестр гостей Orca, `isTrustedBrowserRenderer`, очередь `setGrabMode` |
| `browser-guest-grab-shortcuts.ts` | 86 | Голые `c`/`s` во время выбора (23) — копирование и снимок в буфер обмена; проверка редактируемого фокуса (45–60) — идея, но выполняется в главном мире. У нас `forwardGuestShortcuts` (`parley:main/guest-shortcuts.ts:18–40`) |
| `useGrabMode.ts`, `use-browser-page-grab-annotations.ts`, `use-browser-page-annotation-send.ts`, `browser-guest-annotate-overlays.tsx`, `browser-page-grab-action.ts`, `GrabConfirmationSheet.tsx`, `BrowserAnnotationSendMenuContent.tsx` | 274 + 318 + 233 + 203 + 103 + 302 + 32 | `useAppStore`, `window.api.*`, `recordFeatureInteraction`, `translate`, меню отправки агенту |
| Markup (рисование): `MarkupOverlay`, `useMarkup*`, `markup-*` | 3919 вместе с тестами | Спека 2.13: «рисование пером (Markup) не делаем» |
| `browser-grab-payload.ts` | 221 | Свой `validatePick` уже есть. Брать как образец, только если «богатый» payload (п. 7) |
| `cdp-screenshot.ts` (278), `snapshot-engine.ts` (142), `cdp-ref-resolution.ts` (224) | 644 | Для этапов C/D: AX-снимок со ссылками `@eN` и «зонд кадра» для скрытого гостя (`cdp-screenshot.ts:6–14`: 1×1 JPEG после 250/750/1750/3750 мс) — ровно проблема спайка 0.2 (`fromSurface:false` висит). Один абзац в планы C/D |

## 3. Конфликты с нашими ограничениями и спекой

### 3.1 Главный мир страницы

Весь скрипт выбора Orca — в главном мире: страница видит `window.__orcaGrab`, хост-элемент `#__orca-grab-host` в своём DOM и может подменить `Object.keys`, `Array.prototype.indexOf`, `Element.prototype.getBoundingClientRect` до запуска скрипта. Наше правило (план B:49): скрипты страницы — только мир 1001. DOM-часть Orca переносится в 1001 без правок (все вызовы — стандартный DOM: `TreeWalker`, `getComputedStyle`, `CSS.escape`, `attachShadow`, `getSelection`). Единственное, что нельзя: чтение `__reactFiber$…` — оно остаётся через CDP.

### 3.2 Нет `isTrusted`

В `grab-guest-*.ts` ни одной проверки (grep). Страница может сама вызвать `host.dispatchEvent(new MouseEvent('click'))` и «завершить выбор». У нас (`parley:guest-pick.js:169, 175, 186`) события недоверенные игнорируются; сохранить при любой переработке.

### 3.3 Что Orca отдаёт без маски (где наша `redact.ts` обязана работать)

- `htmlSnippet`: `cloneNode(true).outerHTML` без значений полей, без `on*`, без `style` — только `<script>` убран (`grab-guest-content-script.ts:60–69`). Наша `cleanHtml` строже; ради нескольких строк Orca её не менять.
- Атрибуты: разрешены `id class name type role href src alt title placeholder for action method` + `aria-*` (`foundation:37–40`); значение с подстрокой из 13 (`access_token`, `secret`, `password`…) → `[redacted]`. Маска по **значению**, у нас по **имени** (спека 6). `href`/`src`/`action` очищаются от query — это строже нашего: в HTML-блоке у нас `href="/cb?token=…"` остаётся. Можно ужесточить `cleanHtml` через `sanitizeUrl` Orca (идёт в `redactUrl` на стороне main) — улучшение, не обязательство спеки.
- `textSnippet` 200, `nearbyText` 10×200, `nearbyElements` 6×160, `selectedText` 500, `ancestorPath`, `elementPath` (aria-label до 40), `fullPath` — сырой текст страницы без маски; **`nearby*` и `selectedText` расширяют выдачу за пределы выбранного элемента** (соседи, выделение мыши): персональные данные соседних блоков уходят агенту. Спека 3.6 их не предусматривает. По умолчанию не брать.
- Ничто из этого не проходит `redact.ts` автоматически: свободный текст не имеет имён полей. Это то же ограничение, что и у текущего Design Mode; новых источников такого текста быть не должно без решения человека.

### 3.4 Пределы: Orca против `PICK_LIMITS`/`CONTEXT_LIMITS`

| Что | Orca (`GRAB_BUDGET`, `browser-grab-types.ts:178–196`) | Parley |
|---|---|---|
| HTML | 4096 | `PICK_LIMITS.html` 4096 (метка аннотации — `CONTEXT_LIMITS.annotationHtml` 1024) |
| Текст элемента | 200 (+ соседи 10×200) | `PICK_LIMITS.text` 500 |
| Селектор | 700 символов, ≤10 звеньев | `PICK_LIMITS.selector` 1024, `selectorLinks` 12 |
| Пути (`elementPath`/`fullPath`) | 900 | нет в спеке |
| React | строка до 500, до 6 имён; исходник 500 | ≤3 компонента, имя 100, исходник 300 (`REACT_LIMITS`) |
| Стили | 16 свойств | 23 у Select, 10 у метки |
| Комментарий метки | 2000 | `CONTEXT_LIMITS.comment` 2000 — совпадает |
| Меток на страницу | 20 (мост — до 50) | `CONTEXT_LIMITS.annotations` 20 — совпадает |
| Снимок | PNG ≤ 2 МиБ (data-URL), иначе без снимка | сторона ≤ `captureSide` 4096 CSS-px (план B:4753+), файл ≤ 20 МиБ (`MAX_DROP_IMAGE_BYTES`, `parley:main/drops.ts:20`) |

Новых чисел мимо констант быть не должно (индекс, «Пределы»): бюджеты Orca не копируются, берутся значения `PICK_LIMITS`/`CONTEXT_LIMITS`.

### 3.5 Electron 43.7.5 (Orca) и 44.4.5 (у нас)

Сверены сигнатуры в `electron.d.ts` 44.4.5: `executeJavaScriptInIsolatedWorld(worldId, scripts, userGesture?)` (`:18208`), `capturePage(rect?, opts?)` (`:18101`), `debugger.attach('1.3')` — все применяются так же. Единственная заметная разница: `did-start-navigation` у Orca слушается позиционными аргументами `(_e, _url, _isInPlace, isMainFrame)` (`browser-grab-session-controller.ts:173–181, 197`) — в 44.4.5 они помечены `@deprecated` (`:17123–17135`), у нас объектная форма `details` (`parley:design-mode.ts:196`). Копировать этот контроллер не нужно. Разницы релизов 43→44 в других вызовах не искал (release notes не читались); по видимому коду других расхождений нет.

### 3.6 React 19 (Orca) и React 18 (у нас)

TSX Orca написан под 19.2.8 (`React.JSX.Element`, без `forwardRef`). Каркасы лотка/карточки не используют `use()` и ref-как-проп; проверка `pnpm typecheck` покажет остальное. Имена иконок `lucide-react` 1.48 проверены: `MessageSquarePlus`, `CircleCheck`, `Pencil`, `Trash2`, `CornerDownLeft`, `PencilLine`, `Crosshair` есть.

### 3.7 Автоотправка агенту

Нашему правилу «ничего не уходит само» в Orca противоречат: (а) левый клик по элементу сразу пишет Markdown в буфер обмена (`orca:renderer/…/use-browser-page-grab-annotations.ts:163`); (б) меню «Send» лотка — `promptDelivery="submit-after-ready"` (`BrowserAnnotationSendMenuContent.tsx:26`), то есть с отправкой; (в) голые `c`/`s` во время выбора (`browser-guest-grab-shortcuts.ts:23`). Все три вырезаются целиком; «Add to chat» только кладёт вложение.

### 3.8 Строки, UI-кит, сторы

- Строки: `translate('auto.components…', 'English')` — 91 вызов в `annotate/*`. Заменить на `S.browser.annotate.*`, страж `english-ui.test.ts`.
- UI-кит: `@/components/ui/*` у Orca и `renderer/ui/*` у нас — родственные shadcn-копии (в NOTICE пункт shadcn). Различия: `PopoverContent` у нас без `portalContainer`; у `Button` размеры `xs`/`icon-xs` совпадают; `can-hover:` не определён; `ImeTextarea` и `isScreenSubmitShortcut` нет (`ime-text-field.tsx` 47 + `ime-composition-keyboard-event.ts` 122 + `screen-submit-shortcut.ts` 39 — можно взять отдельно, если IME-режим Enter потребует большего, чем `isComposing`).
- Сторы: `useAppStore` (зустанд-срез `browserAnnotationsByPageId`) → наш `useAnnotateStore` (задача 20); `window.api.browser.*` → `bridge.browser.*`.

### 3.9 Скрипты вне мира 1001 и инспектор A

Любое `console.*` из скриптов страницы попадёт в журнал Console: обработчик `Runtime.consoleAPICalled` (`parley:inspector.ts:365`) не фильтрует по `executionContextId` (grep), то есть пишет и изолированные миры. Скрипты Parley должны молчать (в плане B уже так); у Orca `console.debug(prefix…)` в мосте — единственное место (см. 2.1).

## 4. Что изменилось в master с момента написания плана

Проверено по коду worktree (`97d5e85`).

1. **⌘⇧A занят.** `sidebar.agents` — `CmdOrCtrl+Shift+A`, `menu: 'view'`, `when: 'always'` (`parley:shared/keybindings.ts:71`), коммит `21e06cc` (PR #34, 2026-10-07). Раз `when: 'always'`, `forwardGuestShortcuts` пересылает его и из страницы (`parley:main/guest-shortcuts.ts:18–20`). План B использует ⌘⇧A в строках 7158, 7367, 7379, 7611–7613 (тест «ровно одно действие с ⌘⇧A»), 7765, 7874, 8324, 8348, 8365 и в спеке 4.9. Свободны: все `CmdOrCtrl+Shift+*` кроме A, D, E, F, G, M, T, `[`, `]`, ↑, ↓; `CmdOrCtrl+Alt+*` кроме I, J, ←, →. ⌘⇧C для Select свободен (в реестре нет). На Windows/Linux `Ctrl+Shift+C` — копирование в веб-терминалах; Orca для этого разводит клавиши по платформам (`orca:shared/keybindings-default-bindings.test.ts:442–467`: annotate = ⌘⇧C на macOS, Alt+Shift+N на Linux/Windows). Сборка у нас пока только macOS. Варианты для Annotate: `CmdOrCtrl+Alt+A` (рядом с ⌘⌥I/⌘⌥J панели браузера) или `CmdOrCtrl+Shift+N`. Выбор — за человеком.
2. **Codex Chat.** PR #36 (`ac8164c`, в v0.8.0): `feedAvailable` для `provider === 'codex'` истинно при признаке хоста `feed-codex` и версии ≥ `0.160.0` (`parley:renderer/lib/feed-view.ts:45–54`; `protocol/feed.ts:37–39`). Поле Chat Codex принимает вложения: те же `useChatUiStore.attachments`, но при отправке — `composeRoomMessage(typed, paths)`, то есть список `Attachments:` с путями кодом, а не `@"путь"` (`parley:renderer/chat/ChatView.tsx:251`; `rooms/attachments.ts:11–15`). План B, задача 10, уже говорит «`composePrompt` и `composeRoomMessage` добавляют `.png`» — совпадает. Что устарело: спека 1.2 (строка 31 «У Codex вида Chat нет»), спека 4.5 (строка 426 «Chat для Codex проектируется отдельно»), фикстура плана B:2219 (`codex → chat: false`) и E2E, где `stubCodex` — «сессия без Chat» (B:7924, 8101): стаб по умолчанию отвечает `0.44.0` (`parley:e2e/stub-codex-agent.mjs:36`), то есть Chat у него выключен — тест остаётся верным, но зависит от умолчания; лучше задать `STUB_CODEX_VERSION=0.159.0` явно. Образец сообщения «Chat needs Codex 0.160.0 or newer» — `e2e/codex-chat.spec.ts:322–325`.
3. **Сессии без Chat сегодня:** провайдеры вне семейства claude и не codex (свои записи `providers.json`); claude/glm с версией ниже `2.1.286` или неизвестной (проба выключена, `PARLEY_SKIP_VERSION_PROBE`); Codex ниже `0.160.0` или у хоста без `feed-codex` (старый хост после обновления); хост без `feed.snapshot`; пока `providers.list` не пришёл — `feedAvailableNow` даёт `false` (`feed-view.ts:171–180`, а `feedAvailability` — `null`). Имена из плана (`feedAvailableNow`, `useFeedAvailability`) в коде есть.
4. **Имена этапа A и вложений совпадают с планом:** `onAddConsoleToChat`/`onAddRequestToChat`/`onAddErrorsToChat` (`DevtoolsPanel.tsx:41–43`), `data-testid="browser-chrome"` (`BrowserChrome.tsx:80`), `patchBrowser`/`parseViewport` (`layout/tree.ts:250, 540`), `fieldRef` (`BrowserSurface.tsx:134`), `useChatUiStore.attachments`/`setAttachments` (`chat/ui-store.ts:66, 85`), `composerAttachments`/`setComposerAttachments` (`store/ui.ts:110, 261`), `sendWithToast(…, submit)` (`terminal/send.ts:129`), `addAttachments` (`chat/attachments.ts`). Комнатные вложения (`0e4a33e`, 2026-10-07) на месте. `DesignModeCard`, `design-block`, `PickResult.thumbnail` пока в коде — удаляются задачами 16 и 17.
5. **Решения этапа 0, ещё не внесённые в план B** (stage0:211–235; в плане B и индексе их нет): React 19 — `parseDebugStack` вместо регулярки `sourceOf` (задача 14, шаг 3); `DOM.getNodeForLocation` принимает координаты **документа** — к точке добавить `scrollX/Y` (в плане `scroll` уже есть); снимок элемента — основной CDP-клип в страничных координатах × `getZoomFactor()` с `captureBeyondViewport` (клип не выше поверхности вида), запасной `capturePage(rect × getZoomFactor() × scale)` (задача 15; в плане B:4753+ уже стоит CDP-клип с `scale: 1` и запасной `captureRect` — сверить); снимок аннотаций — только видимая часть, `CONTEXT_LIMITS.annotationFullPage` и тест «страница длиннее 8000 px» удалить (план B:129, 460, 604, 613, 6046, 6283, 6575, 8461; индекс `…-plan.md:165`; спека 4.7: «Всей страницей через captureBeyondViewport» → «видимая часть»).
6. **Релиз v0.8.1** (`f95ba33`): раздел `## Unreleased` в CHANGELOG содержит записи этапа A — задача 24 дописывает в него.

## 5. Рекомендуемый список задач этапа B

Нумерация новая (Б1…Б27); в скобках — задача прежнего плана. Порядок сохраняет зависимости. Проекция размера — оценка.

| Новый № | Название | Суть | Файлы Orca |
|---|---|---|---|
| Б1 (1) | Сверка: этап 0, A, пин Orca | Читать отчёт этапа 0 и внести его решения (п. 4.5) в тексты задач; выбрать клавишу Annotate; записать пин Orca `b1cd858` и путь клона/что делать при его отсутствии (`git clone https://github.com/stablyai/orca` + `checkout b1cd858`) | — |
| Б2 (новая) | Общий DOM-экстрактор гостя `guest-dom.js` | Один файл-IIFE, ставит в мир 1001 `globalThis.__parleyDom = { selectorOf, textOf, htmlOf, stylesOf, … }` (если ещё нет). `guest-pick.js` и `guest-annotate.js` зовут его, копий `selectorOf`/`isSecretField`/`cleanHtml` в двух скриптах больше нет. Подключается вторым `WebSource` в том же `executeJavaScriptInIsolatedWorld(1001, [ {code: dom}, {code: mode} ])` (значение — результат последнего скрипта: проверить в тесте). Тесты поведения в jsdom (как `guest-pick.test.ts`): Orca проверяет эти скрипты подстроками и sha256 (`grab-guest-script.test.ts:9–30, 70–150`) — тесты не переносимы | `grab-guest-foundation-script.ts` (152), `…-content-script.ts` (71–95), `…-element-context-script.ts` (1–93) |
| Б3 (2) | `redact.ts` | как в плане | — |
| Б4 (3) | `context-markdown.ts` | как в плане; без `annotationFullPage` | `fence` — только сверка |
| Б5 (4) | Шаблоны element/console/request/errors | как в плане | — |
| Б6 (5) | Шаблон annotations + типы | как в плане | порядок полей |
| Б7 (6) | Файлы-контексты в main | как в плане | — |
| Б8 (7) | Мост `saveContext` | как в плане | — |
| Б9 (8) | `BrowserTarget` в раскладке | как в плане | — |
| Б10 (9) | `targets.ts` | как в плане | — |
| Б11 (10) | Чипы и `.png` | как в плане; тексты про Codex Chat по п. 4.2 | — |
| Б12 (11) | Доставка и тост | как в плане | — |
| Б13 (12) | Меню «To» | как в плане | — |
| Б14 (13) | «Add to chat» из Console/Network | как в плане | — |
| Б15 (14) | CDP для Select: `REACT_INFO_FN` из Orca + `parseDebugStack` | `guest-data.ts`, `element-info.ts`, закрытый список, `cdpCallAllowed`; `REACT_INFO_FN` — перенос функций Orca по п. 2.1–2.2 со сужением `shouldSkipReactName`, React 19 по этапу 0 | `grab-guest-react-script.ts:11–94` |
| Б16 (15) | Select в main: точка, ⇧, снимок | `guest-pick.js` на `guest-dom`; `point/shift/scroll`; основной снимок CDP-клипом, запасной по Orca (множитель = `bitmap.width / pick.viewport.width`); `validatePick` остаётся | `browser-grab-screenshot.ts:21–105` |
| Б17 (16) | Select в окне, ⌘⇧C | как в плане | — |
| Б18 (17) | Гид агента | как в плане | — |
| Б19 (18) | `guest-annotate.js` | Слой меток по Orca (закрытый shadow, rAF, scroll/resize capture, `beforeunload`, без `console.debug`), живой `getBoundingClientRect` по ключу вместо `rectPage`; области, правка по клику, `isTrusted`, `waiting()`; DOM — через `guest-dom` | `browser-annotation-viewport-bridge.ts:80–263` |
| Б20 (19) | Аннотации в main | как в плане; снимок только видимой части | — (образец проверки: `browser-grab-payload.ts`) |
| Б21 (20) | Лоток: состояние вкладки | как в плане | — |
| Б22 (21) | Редактор и лоток | Если человек выбрал адаптацию: редактор — Radix-Popover по `pending-browser-annotation-card.tsx` (+ `portalContainer` в `ui/popover.tsx`), лоток по `browser-page-annotation-tray.tsx`; иначе как в плане | `pending-browser-annotation-card.tsx`, `browser-page-annotation-tray.tsx`, `browser-annotation-geometry.ts:50–72` |
| Б23 (22) | Annotate во вкладке | как в плане, клавиша по Б1 | — |
| Б24 (23) | E2E | как в плане; `STUB_CODEX_VERSION` явно; формат селектора Orca (кратчайший уникальный) в ожиданиях | — |
| Б25 (24) | Документы | как в плане; ключ Annotate | — |
| Б26 (новая) | NOTICE и атрибуция | Раздел NOTICE (п. 6), шапки файлов, страж | все скопированные |
| Б27 (25) | Завершение | как в плане + команда сверки маркера с NOTICE | — |

Итог: задач 25 → 27 (две добавлены, ни одна не удалена). Размер плана: брутто −300…450 строк в Б15/Б16/Б19/Б22 (из ~570 строк текста «с нуля» по этим местам, который Orca перекрывает), плюс ~+120 на Б2 и ~+40 на Б26; нетто −150…290 (2–3 %). По коду модули п. 2.1 — ~1700 строк исходников Orca (сумма файлов целиком), после вырезания войдёт около 900.

### Что с чем поменять в текстах задач (чтобы переписчик плана не искал)

- Б15: план B:4294–4335 (тело `REACT_INFO_FN`) заменить функцией по п. 2.2; тест `react-info.test.ts` (план B:4008–4070) дополнить `forwardRef`/`memo` и React 19.
- Б16: план B:4692–4727 (шаг 3) — `dataOf` берёт поля у `guest-dom`; `selectorOf` в `guest-pick.js` удалить; план B:4753+ — `snapshot` с запасным путём по Orca.
- Б19: план B:5719–5779 (`selectorOf`, `isSecretField`, `cleanHtml`, `textOf`, `stylesOf`) — вызовы `__parleyDom`; слой меток по Orca.
- Б22: план B:7177–7355 (редактор и лоток) — по выбору человека; `ANNOTATION_EDITOR` и `editorAt` исчезают при Popover.

## 6. Задача NOTICE (Б26)

В `NOTICE` раздел Orca сейчас: «Источник: https://github.com/Kalmbik61/orca-harnas, коммит acf8e679» (форк), три блока «Скопированные файлы (кусок 1.1–1.3 …)» и «Адаптированные файлы (шаг P2 плана релиза …; источник — https://github.com/stablyai/orca, ветка main на 2026-09-30)». Правообладатель и текст MIT одни (Lovecast Inc.). Добавить:

```
Адаптированные файлы (этап B браузера — Select и Annotate; источник —
https://github.com/stablyai/orca, коммит b1cd858, MIT, Copyright (c) 2026 Lovecast
Inc.; полный текст лицензии — выше, в этом разделе):
- packages/desktop/src/main/browser/guest-dom.js — адаптация
  src/main/browser/grab-guest-foundation-script.ts,
  grab-guest-content-script.ts, grab-guest-element-context-script.ts: селектор,
  ограниченный обход текста, очистка URL; работает в изолированном мире.
- packages/desktop/src/main/browser/react-info.ts — адаптация
  src/main/browser/grab-guest-react-script.ts: поиск компонента React.
- packages/desktop/src/main/browser/design-mode.ts — запасной снимок элемента по
  src/main/browser/browser-grab-screenshot.ts.
- packages/desktop/src/main/browser/guest-annotate.js — слой меток по
  src/shared/browser-annotation-viewport-bridge.ts.
- packages/desktop/src/renderer/browser/annotate/AnnotationEditor.tsx и
  AnnotationTray.tsx — по src/renderer/src/components/browser-pane/annotate/
  pending-browser-annotation-card.tsx и browser-page-annotation-tray.tsx.
```

(список — по факту, после задач Б2, Б15, Б16, Б19, Б22). В шапке каждого такого файла — строка вида «Адаптация Orca `<файл>` (stablyai/orca b1cd858, MIT)» — как у `parley:renderer/components/AgentStateDot.tsx:4`. Первую строку раздела «Источник» дополнить вторым источником (`stablyai/orca`, `b1cd858`) — иначе читателю неясно, что файлы Б-задач не из форка.

Страж: в `packages/desktop/src/notice.test.ts` уже есть тест, который обходит `src/renderer` по маркеру `shadcn/ui` и требует каждый найденный файл в `NOTICE` (`:18–31`, `:60–66`). Добавить такой же по маркеру `stablyai/orca` для `src/main`, `src/renderer`, `src/shared`. Тогда забытый файл поймает `pnpm test`, а не ревью. Старый тест «NOTICE называет таблицу палитр терминала из Orca» (`:135+`) остаётся.

## 7. Решения, которые нужны от человека

1. **Клавиша Annotate** (п. 4.1): `⌘⌥A`, `⌘⇧N` или другая; ⌘⇧C для Select остаётся.
2. **Насколько «богатый» payload брать у Orca.** По умолчанию — только то, что есть в спеке 3.6 (селектор, роль, React, текст, стили, HTML, снимок). Orca умеет ещё `nearbyText`, `nearbyElements`, `ancestorPath`, `elementPath`, `fullPath`, `attributes`, `selectedText`, `isFixed`, `rectPage`. Это правка спеки 3.6/8, новые константы и запись в раздел 6 (соседний текст — чужие данные страницы). Рекомендация: не брать, максимум `elementPath` («Location:») по отдельному решению.
3. **Правка метки:** по клику на метку открывается редактор в окне (спека 4.7, как в плане) или править строку в лотке (как у Orca, проще, без позиционирования редактора). Рекомендация: оставить спеку — клик по метке и в лотке «карандаш» ведут к одному редактору.
4. **Popover вместо своих расчётов места редактора** (Б22): +1 небольшая правка `ui/popover.tsx` (`portalContainer`), минус `ANNOTATION_EDITOR`/`editorAt`. Рекомендация: да.
5. **Подсветка при выборе:** спека 4.6 требует «как сейчас» (синяя рамка, подпись `tag.class · W×H`); оверлей Orca (белая рамка, подпись роль+текст+размер) не берём.
6. **Размер файла снимка:** Orca отказывается от снимка > 2 МиБ; наш предел — 20 МиБ в `saveImage`. Claude и Codex ужимают картинку сами; нужен ли свой потолок в B — отдельное решение (в B не требуется).

## 8. Что осталось проверить при исполнении

- Возвращает ли `executeJavaScriptInIsolatedWorld(world, [dom, mode])` значение последнего скрипта (в Б2 — тест на глубину: `Promise` из `mode` дожидается main'ом).
- Формула запасного снимка Orca при эмуляции + `scale` поля: данные этапа 0 (stage0:83, 194–196) говорят «да», но проверка именно кодом Orca не проводилась.
- `selectorTail` на селекторах Orca с Tailwind-классами (`py-1\.5`, `md\:flex`) — парсер плана B:1057–1073 экранирование понимает; тест добавить.
- `getNodeForLocation` на кликах по элементам внутри `iframe`/shadow DOM (DOM-извлечение Orca iframe не обходит; наш скрипт тоже; поведение сохраняется).
