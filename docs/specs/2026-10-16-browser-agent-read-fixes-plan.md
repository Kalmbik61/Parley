# Браузер Parley, этап C: исправление находок аудита — план

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЕН навык superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans; задачи — по одной, шаги — чекбоксы `- [ ]`.

**Цель:** закрыть все находки аудита ветки `feat/browser-agent-read` до слияния: снимки показывают настоящую страницу, ответы агенту укладываются в бюджет, граница «только localhost» и маска держат, тайм-ауты и перезагрузки окна не ломают размер человека и паузу.

**Архитектура:** правки остаются в существующей цепочке MCP core → хост → main окна → рендерер. Главная новая механика — «поверхность снимка»: окно на время снимка ставит `<webview>` в размер снимка и подтверждает готовность, main снимает только после подтверждения. Остальное — точечные правки `agent-ops`, `emulation`, `redact`, форматирования core и протокола реестра; `agent-ops.ts` перед этим делится на модули без изменения поведения.

**Стек:** TypeScript, Electron 44 (`<webview>`, CDP через `webContents.debugger`), zod 4, vitest, Playwright E2E.

**Источники:** аудит `/Users/kalmbik61/Desktop/MY/my_harnas/docs/audits/2026-10-16/Parley-browser-agent-read-rea-2026-10-16.md` и улики в `browser-agent-read-evidence/` рядом (пробы `probe1-3`, отчёты `review-races.md`, `review-security-arch.md`, пробы ревьюеров `reviewer-probes/`). Спека: `docs/specs/2026-10-07-browser-devtools-agent-design.md` (5.1, 5.2, 6, 8, 9). План этапа: `docs/specs/2026-10-07-browser-devtools-agent-plan-c-agent-read.md`. Номера находок ниже — из аудита: S — безопасность, A — архитектура, R — гонки.

## Глобальные ограничения

- Работа в worktree `.claude/worktrees/browser-agent-read`, ветка `feat/browser-agent-read`. Push и слияние — только по просьбе человека.
- Тексты для агента (описания инструментов, ответы, ошибки) — английские. Строки окна — `S.*` в `shared/strings.ts`.
- Core не импортирует ни `@parley/protocol`, ни код окна. Протокол может импортировать core (зависимость уже есть).
- Маска до обрезки. JSON, который не разбирается целиком, агенту не отдаётся (`unmaskableJson`).
- Только loopback-страницы панелей чата и комнат сессии. Вкладки человека не регистрируются никогда.
- Тесты — только затронутых файлов: `npx vitest run <файлы>` из пакета. Полный прогон и все E2E — один раз, в задаче 19. Тяжёлые прогоны не параллелить.
- E2E читает `packages/desktop/out`: после правок main/preload/renderer — `pnpm --filter @parley/desktop build`; после core/protocol/host — `pnpm --filter <пакет> build`.
- Коммит на задачу: conventional commits, область (`desktop`, `core`, `protocol`, `host`), описание по-русски, последняя строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Фокус ревью

Пять случаев, которые легко пропустить. Тест под каждый — в задаче-владельце.

1. **Человек меняет размер или поле, пока агент снимает в чужом размере.** После снимка у человека ровно его последний выбор: пресет, DPR и поле. Тест: задача 6, «set человека и смена поля во время снимка».
2. **Страница уходит с localhost посреди fullPage-снимка** (редирект с dev-сервера). Агент получает `not_loopback`, PNG не сохранён. Тест: задача 3.
3. **Окно отменило свой переход** (файл брошен мимо зон приёма), а панель на паузе. Пауза держится, агент получает `access_denied`. Тест: задача 13 (E2E).
4. **Перемаскировка.** `{"error":{"code":404}}` и `{"id":9007199254740993}` остаются читаемыми и точными, при этом `?code=…` в URL и `password=` в тексте консоли маскируются. Тест: задача 8.
5. **Повтор сразу после тайм-аута.** Агент делает повтор, как советует подсказка. Размер человека прежний, вторая операция не стартует, пока идёт первая. Тесты: задача 5 (очередь) и задача 6, шаг 2 (с настоящим `createEmulation`).

---

### Задача 0. Спайк: поверхность снимка и DPR

Ничего не коммитит в продукт. Итог — раздел «Спайк 0» в конце этого плана: ответы и выбранные числа.

**Вопросы и критерий «да»:**
- **В1.** Панель 399×752, страница-сетка (`browser-agent-read-evidence/probe3-grid.spec.ts`, страница `/grid`), временная эмуляция 1440×900. Если на время снимка задать `<webview>` стиль `position:absolute; left:0; top:0; width:1440px; height:900px` (через `window.evaluate` теста), выйдет ли PNG 1440×900 без повторов? Проверка: пиксель (1300, 100) имеет цвет ячейки `1200,0`, а не ячейки 0-го столбца.
- **В2.** Сколько кадров окна (rAF) или миллисекунд нужно между сменой стиля и `Page.captureScreenshot`, чтобы первый же снимок был верным? Проверить для видимой и для скрытой (`opacity: 0`) страницы. Зафиксировать: нужен ли повтор и сколько.
- **В3.** При `--force-device-scale-factor=2` даёт ли `Page.captureScreenshot` с `clip: { x, y, width: W, height: H, scale: 1 / dpr }` PNG ровно W×H? `dpr` = `layoutViewport.clientWidth / cssLayoutViewport.clientWidth` из `Page.getLayoutMetrics`.

**Запасной путь**, если В1 — «нет»: 2D-нарезка клипами не больше поверхности (ширина и высота ≤ CSS-размера `<webview>` у человека) с `captureBeyondViewport: true` и склейка. Тогда задача 2 меняет механику, а интерфейс `prepareSurface` остаётся, но не меняет размер элемента.

- [ ] Ответить на В1–В3 пробой на каркасе `probe3-grid.spec.ts` (каталог проб — вне репозитория, как в аудите).
- [ ] Записать ответы и числа (`captureReadyFrames`, `captureRetries`) в раздел «Спайк 0».

---

### Задача 1. Разделить `agent-ops.ts` без изменения поведения (A7)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/agent-errors.ts` — `AgentOpError`.
- Создать: `.../agent-pages.ts` — реестр страниц, id агента, доступ (`pageOf`), пауза, `listTabs`.
- Создать: `.../agent-queue.ts` — очередь страницы и `withTimeout`.
- Создать: `.../agent-reads.ts` — `consoleOf`, `networkOf`, `detailOf`, `toAgentConsole`, `summaryOf`, `newest`, `bodyForAgent`.
- Создать: `.../agent-capture.ts` — `screenshotOf`, `captureSpec`, `fitLongSide`.
- Изменить: `.../agent-ops.ts` — сборка, `open`, разбор аргументов, `run`. Остаётся реэкспорт `AgentOpError`, `LayoutMetrics`, `captureSpec`, `loopbackHref`, `ownerOf`, `NOT_MOUNTED_NOTE`, чтобы импорты снаружи не менялись.

**Интерфейсы (производит):**
- `createPageRegistry(deps: { fromId(id: number): WebContents | null }): PageRegistry` — методы `agentIdFor`, `register`, `reset`, `pageOf(request, agentId)`, `live(record)`, `fresh(record)` (запись по ключу на сейчас), `isPaused(workKey, owner)`, `listed(request)`.
- `createPageQueue(): { run<T>(key: string, task: () => Promise<T>): Promise<T> }` — нынешняя семантика `enqueue`.
- `createAgentOps(deps: AgentOpsDeps): AgentOps` — сигнатура прежняя.

- [ ] **Шаг 1.** Перенести код по модулям. Функции и тексты — без изменений.
- [ ] **Шаг 2.** Прогнать: `cd packages/desktop && npx vitest run src/main/browser/agent-ops.test.ts src/main/ipc.test.ts` — 56 + все тесты ipc, как до правки. Затем `npx tsc -p tsconfig.node.json --noEmit` без ошибок.
- [ ] **Шаг 3.** Коммит `refactor(desktop): agent-ops разделён на реестр, очередь, чтения и снимок без изменения поведения`.

---

### Задача 2. Поверхность снимка: `<webview>` в размере снимка, подтверждение окна (главный блокер, R10–R12)

**Файлы:**
- Изменить: `packages/protocol/src/browser-agent.ts` — `AGENT_LIMITS.captureReadyMs: 2000`, `AGENT_LIMITS.captureRetries` (число из спайка, по умолчанию 2).
- Изменить: `packages/desktop/src/shared/browser-types.ts` — `AgentActivity.capture?: { width: number; height: number; id: string }`; `BrowserApi.agentCaptureReady(id: string): Promise<void>`.
- Изменить: `packages/desktop/src/preload/index.ts` — `agentCaptureReady` → `ipcRenderer.invoke('browser:agent-capture-ready', id)`.
- Изменить: `packages/desktop/src/main/ipc.ts` — обработчик `browser:agent-capture-ready`: `id` — строка 1…64, иначе `bad_request`; зовёт `browser.agent.captureReady(id)`. Тип `agent` в опциях: `Pick<AgentOps, 'openTabResult' | 'registerTab' | 'captureReady'>`.
- Изменить: `.../agent-ops.ts` — `AgentOps.captureReady(id: string): void`.
- Изменить: `.../agent-capture.ts` — `prepareSurface`, ширина fullPage, повтор без текста ошибки.
- Изменить: `packages/desktop/src/renderer/browser/BrowserSurface.tsx` — размер `<webview>` на время снимка, подтверждение, сторож.
- Тесты: `agent-ops.test.ts` (или `agent-capture.test.ts`), `BrowserSurface.test.tsx`, `preload/index.test.ts`, `ipc.test.ts`, `e2e/browser-agent-read.spec.ts`.

**Интерфейсы:**
- Производит: `prepareSurface(contents: WebContents, request: BrowserAgentOpEvent, view: { width: number; height: number }): Promise<void>`. Шлёт `activity({ phase: 'start', capture: { ...view, id } })` и ждёт `captureReady(id)` не дольше `captureReadyMs`. Нет ответа — `AgentOpError('timeout', "Parley's window did not prepare the page for the screenshot within 2 s.")`.
- Производит (рендерер): `agentCapture: { width; height; id } | null`.

- [ ] **Шаг 1. Тесты main.**
  - `'снимок в заданном размере ждёт готовности поверхности: captureScreenshot не раньше captureReady(id)'` — событие `activity` с `capture.id`, снимка нет, затем `ops.captureReady(id)`, снимок есть.
  - `'окно не подтвердило за captureReadyMs — timeout, размер человека возвращён, PNG не сохранён'`.
  - `'видимая страница без размера поверхность не готовит: activity без capture, снимок сразу'`.
  - `'fullPage страницы шире вьюпорта: ширина = вьюпорт, заметка «The page is 6000 px wide; the screenshot shows the first 1280 px.»'` — `clip.width` каждой полосы = 1280.
  - `'скрытая страница: после готовности снимок повторяется при любой ошибке не больше captureRetries раз, затем tab_hidden'` — заменяет тесты на текст `Unable to capture screenshot`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3. Main.** `prepareSurface` — ожидание по `id` по образцу `pendingOpens`. Удалить `HIDDEN_CAPTURE_RETRIES`, `NOT_DRAWN`, `HIDDEN_CAPTURE_RETRY_MS`. Поверхность готовится, когда `spec !== null` или страница скрыта: видимость брать из `registry.fresh(record)`, а не из `record` начала операции (R11). Готовить после `withTemporary` (эмуляция уже стоит), до первого `shoot`. У fullPage ширина полосы — `view.width`.
- [ ] **Шаг 4. Тесты рендерера** (`BrowserSurface.test.tsx`).
  - `'activity start с capture: <webview> получает стиль left 0, top 0, width и height снимка; после двух кадров — agentCaptureReady(id)'`.
  - `'end: стиль стадии человека возвращается'`.
  - `'смена webContentsId сбрасывает capture'`.
  - `'без end capture снимается сторожем через AGENT_LIMITS.opMs'`.
- [ ] **Шаг 5. Рендерер.** Пока `agentCapture !== null`, стиль `<webview>` — `{ left: 0, top: 0, width, height }` с классом `absolute` (узел тот же — гость не перезагружается). Скрытая страница — как сейчас, `visibility: visible; opacity: 0`. Число кадров до `agentCaptureReady` — из спайка.
- [ ] **Шаг 6.** Прогнать тесты шагов 1 и 4, `preload/index.test.ts`, `ipc.test.ts` — ПРОХОДЯТ.
- [ ] **Шаг 7. E2E** в `browser-agent-read.spec.ts`, тест `'снимок больше панели — настоящая страница, без повторов'`. Страница-сетка из `probe3-grid.spec.ts`. Снимки `{ width: 1440, height: 900 }` и `{ width: 1440, height: 900, fullPage: true }`. Пиксель читать через `app.evaluate` и `nativeImage.createFromPath(file).crop({ x, y, width: 1, height: 1 }).toBitmap()` (BGRA):
  - точка (1300, 100) — цвет ячейки `1200,0`;
  - точка (100, 1000) у fullPage — цвет ячейки `0,960`.
  Сборка `pnpm --filter @parley/desktop build`, прогон `npx playwright test e2e/browser-agent-read.spec.ts -g 'больше панели'` — ПРОХОДИТ.
- [ ] **Шаг 8.** Коммит `fix(desktop): снимок агента — <webview> в размере снимка и подтверждение окна, fullPage по ширине вьюпорта`.

---

### Задача 3. Снимок: проверка после съёмки и fullPage выше трёх вьюпортов (R2, R14-часть, аудит 3.2)

**Файлы:** `.../agent-capture.ts`; тесты — `agent-ops.test.ts`.

- [ ] **Шаг 1. Тесты.**
  - `'страница ушла с localhost посреди fullPage — not_loopback «Page t1 left localhost during the screenshot; nothing was saved.», saveImage не вызван'`. У фейкового гостя `getURL` меняется после первого `Page.captureScreenshot`.
  - `'эпоха сменилась посреди снимка (переход на localhost) — tab_not_loaded «Page t1 navigated during the screenshot: take it again.», saveImage не вызван'`.
  - `'страница 3780 px при вьюпорте 752 — три полосы, ok, заметка «The page is 3780 px tall; the screenshot shows the first 2256 px (3 viewport heights).»'` — заменяет тест «длиннее трёх вьюпортов — bad_request».
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3. Реализация.** До первого снимка — `epoch0 = inspector.snapshot(id)?.epoch`. После снимков, до `saveImage`: `isLoopbackUrl(contents.getURL())` и `snapshot(id).epoch === epoch0`, иначе ошибки из теста. fullPage: высота = `min(total, view.height × AGENT_LIMITS.fullPageViewports)`, заметка при обрезке.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `fix(desktop): снимок агента не сохраняется, если страница ушла с localhost или сменила документ; fullPage режется на трёх вьюпортах`.

---

### Задача 4. Снимок: CSS-пиксели при любом DPR, предел байт, без декода на main (R8, аудит 4.4, S13)

**Файлы:**
- Создать: `packages/desktop/src/main/browser/png.ts` — `pngSize(png: Buffer): { width: number; height: number }` по IHDR (байты 16–23). Не PNG — `Error`.
- Изменить: `.../agent-capture.ts`, `.../agent-ops.ts`. `AgentOpsDeps.image` теряет `size`, остаются `resize` и `stitch`.
- Изменить: `LayoutMetrics` — добавить `layoutViewport: { clientWidth: number; clientHeight: number }`.
- Изменить: `packages/protocol/src/browser-agent.ts` — `AGENT_LIMITS.screenshotBytes: 3_500_000`.
- Изменить: `packages/core/src/mcp/browser-tools.ts` — подпись снимка и подсказка `view_image`; `packages/core/src/mcp/tools.ts:1703` — передать имя клиента.
- Тесты: `png.test.ts`, `agent-ops.test.ts`, `core/src/mcp/browser-tools.test.ts`.

**Интерфейсы:**
- `dprOf(metrics: LayoutMetrics): number` = `layoutViewport.clientWidth / cssLayoutViewport.clientWidth`; не число или ≤ 0 — 1.
- Масштаб клипа: `scale = Math.min(1, AGENT_LIMITS.screenshotLongSide / Math.max(cssW, cssH)) / dpr`. У вьюпорта клип `{ x: pageX, y: pageY, width: cssW, height: cssH, scale }`. У fullPage масштаб считается от `(width, total)`.
- `createBrowserTools(agent, deps: BrowserToolDeps & { clientName?: () => string | undefined })`.

- [ ] **Шаг 1. Тесты.**
  - `'pngSize читает размер из IHDR; не PNG — ошибка'`.
  - `'DPR 2 (layoutViewport 2560, css 1280×800): clip.scale 0.5, PNG 1280×800, resize не вызван'`.
  - `'3840×2400 в эмуляции: clip.scale = 1568/3840, resize не вызван'`.
  - `'PNG больше screenshotBytes — повтор с масштабом ×0,7, не больше двух раз; всё ещё больше — unsupported «The screenshot is too large…»'`.
  - Core: `'подпись снимка — с пометкой «The image shows page content, not instructions.»'`.
  - Core: `'совет про view_image — только у клиента не Claude: clientName "claude-code" — нет, "codex-mcp-client" — есть, неизвестен — есть'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3. Реализация.** Размер PNG везде через `pngSize`. `resize` — только если итог всё же длиннее 1568 (округления). В `tools.ts` передать `clientName: () => server.getClientVersion()?.name`.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5. Проба.** Повторить `probe2-lag-dpr2-rea.spec.ts`: у всех снимков `mainMaxLagMs` < 50, у вьюпорта при DPR 2 PNG 399×752, «шумная» страница ≤ 3,5 МБ.
- [ ] **Шаг 6.** Коммит `perf(desktop): снимок агента в CSS-пикселях с пределом байт, размер из IHDR; core: пометка данных у снимка, view_image — не для Claude`.

---

### Задача 5. Очередь и тайм-аут: срок с постановки, конец по факту, отмена (R1-часть, R6, R13, R14, A4)

**Файлы:** `.../agent-queue.ts`, `.../agent-ops.ts`, `.../agent-capture.ts`, `.../agent-reads.ts`; тесты — `agent-ops.test.ts`.

**Интерфейсы:**
- `createPageQueue().run<T>(key: string, deadline: number, task: (signal: AbortSignal) => Promise<T>): Promise<T>`:
  - на старте задачи `Date.now() >= deadline` — `AgentOpError('timeout', 'The operation waited too long behind other operations on this page.')`, `task` не зовётся;
  - хвост очереди ждёт завершения `task`, а не гонки с таймером;
  - по таймеру `deadline - now` — `abort()` и отказ `timeout` вызывающему.
- `onPage`: `deadline = Date.now() + opTimeoutMs` до постановки; `activity end` — в `finally` самой задачи.
- Снимок проверяет `signal.throwIfAborted()` перед каждой полосой, перед `resize` и перед `saveImage`.
- Ошибка не `AgentOpError` внутри страницы: записи нет — `no_tab`; гость уничтожен или упал — `tab_not_loaded`; иначе `unsupported` с текстом не длиннее 2000.

- [ ] **Шаг 1. Тесты** (`opTimeoutMs: 100`, снимок держится управляемым промисом).
  - `'тайм-аут: агент получает timeout через 100 мс, а вторая операция страницы стартует только после конца первой'`.
  - `'activity end — после реального конца операции, не на тайм-ауте'`.
  - `'после тайм-аута снимок не сохраняется: saveImage не вызван'`.
  - `'операция, простоявшая в очереди дольше срока, не запускается: timeout, ни activity, ни Emulation.*'`.
  - `'гость уничтожен посреди деталей запроса — tab_not_loaded, а не unsupported'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать по интерфейсам.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ. Прогнать и `agent-ops.test.ts` целиком: тест «операции одной страницы — по одной» проходит.
- [ ] **Шаг 5.** Коммит `fix(desktop): операция агента — срок с постановки в очередь, очередь и end по факту завершения, отмена снимка`.

---

### Задача 6. Временная эмуляция без записи в состояние человека (R1-часть, R4)

**Файлы:** `packages/desktop/src/main/browser/emulation.ts`; тесты — `emulation.test.ts`, `agent-ops.test.ts`.

**Интерфейсы (сигнатуры `Emulation` прежние):**
- `withTemporary` шлёт `viewportCommands(spec, { width, height })` прямо через `inspector.send` и `state` не трогает. В `finally` применяет `state.get(id)` на этот момент (спека и поле человека), а без записи — `viewportCommands(null, …)`.
- Применения CDP на один `id` — `set` и `withTemporary` — идут по одному через цепочку промисов. `set` человека во время снимка ждёт его конца.
- `current(id)` никогда не отдаёт временный размер.

- [ ] **Шаг 1. Тесты** (`emulation.test.ts`).
  - `'временный размер не попадает в current'`.
  - `'set человека во время снимка применяется после возврата и остаётся'` — порядок команд CDP в журнале фейка.
  - `'смена поля во время снимка: после — размер человека с новым полем (scale из нового поля)'`.
  - `'отказ отладчика при Fit: current остаётся null, следующий снимок в конце снимает эмуляцию'`.
- [ ] **Шаг 2. Тест связки** (`agent-ops.test.ts`, с настоящим `createEmulation` и фейковым `inspector.send`): `'тайм-аут и немедленный повтор: у человека прежний laptop 2x'` — сценарий `reviewer-probes/race1.ts`.
- [ ] **Шаг 3.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 4.** Реализовать.
- [ ] **Шаг 5.** Прогнать — ПРОХОДЯТ. Плюс `npx vitest run src/renderer/browser/use-viewport` — если тест есть.
- [ ] **Шаг 6.** Коммит `fix(desktop): временная эмуляция снимка не пишется в размер человека, применения по одному на вкладку`.

---

### Задача 7. Сеть: эпоха деталей, предел деталей, короткий список, курсор `after` (R5, аудит 4.3 п. 1 и 4)

**Файлы:**
- `packages/protocol/src/browser-agent.ts`:
  - `AGENT_LIMITS.headerValue: 256`, `headers: 40`, `listQuery: 80`;
  - в схеме `network` — `after: z.string().min(1).max(AGENT_INPUT.requestId).optional()`;
  - у списка в `BrowserAgentNetworkResult` — поля `notes: string[]` и `next: string | null`.
- `.../agent-reads.ts`.
- `packages/core/src/mcp/browser-tools.ts` — схема `after`, `requestId.maxLength` 200, текст `Next: after=<id>.`, предел и для детали.

- [ ] **Шаг 1. Тесты** (`agent-ops.test.ts`).
  - `'деталь запроса прошлой эпохи — bad_request, как неизвестный'`.
  - `'60 заголовков по 2 КБ: значения по 256 знаков с «…», не больше 40 на сторону, заметка «20 more response headers are not shown.»'`.
  - `'список: query длиннее 80 знаков обрезан с «…»; в детали адрес полный (с маской)'`.
  - `'after: только запросы после названного в текущей эпохе; next — id последнего; неизвестный after — все и заметка «Request X is no longer in the log; all matching requests are listed.»'`.
  - Core: `'деталь длиннее 20 КБ режется с пометкой'`; `'в ответе списка — «Next: after=<id>.»'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать. В `detailOf` поиск — `c.id === requestId && c.epoch === snapshot.epoch`.
- [ ] **Шаг 4.** Прогнать: `agent-ops.test.ts`, `browser-tools.test.ts`, `browser-agent.test.ts` — ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `fix(desktop,core,protocol): сеть агента — детали только текущей эпохи и с пределом, короткие адреса в списке, курсор after`.

---

### Задача 8. Маска: текст консоли, имена, JSON-строки, формы, большие числа (S1–S4, S3, A8)

**Файлы:** `packages/desktop/src/shared/redact.ts`, `.../agent-reads.ts` (`toAgentConsole`), `.../agent-pages.ts` (заголовок в `tabs`); тесты — `shared/redact.test.ts`, `agent-ops.test.ts`. `redact.ts` использует и файл-контекст человека, поэтому прогнать и его тесты: `npx vitest run src/shared src/main/browser/context`.

**Интерфейсы:**
- `redactSecretsInText(text: string): string`. Маскирует только значение, имя и разделитель остаются. Покрывает:
  - схемы `Bearer|Basic|Token <значение>`;
  - JWT `eyJ…\.…\.…`;
  - пары `имя[:=]значение` и `"имя": "значение"`, если `isSecretName(имя)`;
  - относительные адреса с query (`/reset?token=…`) — через `redactUrl`.
- В `SECRET_PARTS` добавить: `signature`, `credential`, `jwt`, `bearer`, `xsrf`, `pwd`, `private`.
- Слова целиком (как сейчас `key`): `sid`, `sig`, `pass`, `otp`.
- Только для параметров URL: `code` (OAuth). В JSON `code` — не секрет.
- `redactParams` делит пары по `&` и по `;`.
- `maskJson`:
  - строковые значения — через `redactUrlsInText`, затем `redactSecretsInText`;
  - у объекта с полем `name` или `key`, чьё значение — секретное имя, маскируется соседнее `value`;
  - целые вне `Number.isSafeInteger` сохраняются точно (`JSON.parse` с `context.source` и `JSON.rawJSON`).
- `redactBody`: тело вида формы (`^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$`) под `text/plain` или без типа маскируется как форма.

- [ ] **Шаг 1. Тесты** (`redact.test.ts`, таблицей). Входы и выходы — из раздела 2.1 `review-security-arch.md`:
  - `'Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln; password=hunter2; api_key=AKIA…'` → три `<redacted>`;
  - `'GET /reset?token=abc 404'` → `token=<redacted>`;
  - `'http://x/cb?code=AUTH&state=1'` → `code=<redacted>`;
  - `'http://x/a?b=1;token=semicolon'` → `token=<redacted>`;
  - `{"link":"http://localhost:3000/verify?token=abc"}` → токен скрыт;
  - `[{"name":"password","value":"hunter2"}]` → `value` скрыт;
  - `user=bob&password=hunter2` под `text/plain` → `password=<redacted>`;
  - Фокус ревью 4: `{"error":{"code":404},"id":9007199254740993}` → без изменений, число точное.
- [ ] **Шаг 2. Тест связки:** `'консоль: секреты вида значения в тексте скрыты, pattern по сырому секрету ничего не находит'`.
- [ ] **Шаг 3.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 4.** Реализовать. В `toAgentConsole`: `redactSecretsInText(redactUrlsInText(entry.text))`. Заголовок страницы в `tabs` — так же.
- [ ] **Шаг 5.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 6.** Коммит `fix(desktop): маска секретов — текст консоли по виду значения, новые имена, строки JSON, формы без типа, точные большие числа`.

---

### Задача 9. Консоль: компактные записи, свёртка похожих, курсор `after` (аудит 4.3 п. 2–3, 6)

**Файлы:**
- `packages/protocol/src/browser-agent.ts`:
  - `AGENT_LIMITS.listStackFrames: 5`, `listEntryText: 1024`; удалить неиспользуемый `text`;
  - в схеме `console` — `after: z.number().int().min(0).optional()`;
  - `BrowserAgentConsoleEntry` — плюс `id: number` и `similar?: number`;
  - `BrowserAgentConsoleResult` — плюс `next: number | null`.
- `.../agent-reads.ts`, `packages/core/src/mcp/browser-tools.ts`.

**Правила:**
- Кадр вендорский, если URL совпадает с `/\/node_modules\/|^node:|^chrome-extension:|\/@vite\/|\/\.vite\/deps\/|^webpack-internal:/`.
- В список идут до 5 своих кадров; если своих нет — первый кадр.
- Текст записи — до 1024 кодовых точек, дальше «…».
- Свёртка похожих: ключ `level + text.replace(/\d+/g, '#')`. Остаётся новейшая запись группы; `count` — сумма, `similar` — размер группы.
- `after`: записи с `id > after`. `next` — наибольший `id` среди подходящих записей текущей эпохи.

- [ ] **Шаг 1. Тесты.**
  - `'ошибка с 20 кадрами (15 из node_modules) и 25-строчным текстом — 5 своих кадров, текст 1024 с «…»'`.
  - `'40 сообщений, различающихся числом, — одна запись, count 40, similar 40'`.
  - `'after: только записи новее; next — последний id'`.
  - `'46 React-подобных ошибок из пробы 1 укладываются в 20 КБ все'` — вход строится, как в `probe1-tokens.spec.ts`.
  - Core: `'похожие — «(+39 similar)»; заголовок — «Next: after=<id>.»'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `perf(desktop,core,protocol): консоль агента — 5 своих кадров, текст до 1 КБ, свёртка похожих, курсор after`.

---

### Задача 10. Core: URL в ограде, один бюджет по новейшим, описания (S6, аудит 4.3 п. 5, 4.1, R15)

**Файлы:** `packages/core/src/mcp/browser-tools.ts`, `.../agent-ops.ts` и модули (обрезка URL); тесты — `browser-tools.test.ts`, `agent-ops.test.ts`.

**Интерфейсы:**
- Main: все поля `url` ответов проходят `clipUrl(url): string` — до 512 знаков и «…».
- Core: `fitNewest(blocks: string[], bytes: number): { kept: string[]; dropped: number }` — отбрасывает старейшие блоки; первая строка ограды — `… N older entries are not shown.`. Заменяет `cut` у списков консоли и сети; `cut` остаётся у детали.
- Core: первая строка внутри ограды — `Page: <url>`. В заголовке вне ограды URL нет. У снимка URL тоже уходит в ограду под подписью.
- Описания:
  - `browser_tabs` — плюс «Ids can change after Parley restarts: call browser_tabs again.»;
  - `browser_screenshot` — плюс «With width/height the page is briefly resized for the capture, then returns to the human's size.»;
  - `browser_open` — не длиннее 600 знаков, смысл прежний.

- [ ] **Шаг 1. Тесты.**
  - `'URL страницы — внутри ограды; в первой строке ответа его нет'` — переписать прежний тест `browser-tools.test.ts:232-234`.
  - `'URL в 1 МБ — в ответе не длиннее 512 знаков'` — main.
  - `'список больше 20 КБ: отброшены старейшие с пометкой, новейшая запись на месте'`.
  - `'описание browser_open — не длиннее 600 знаков'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `fix(core,desktop): адрес страницы в ограде и не длиннее 512, бюджет списков по новейшим, описания инструментов`.

---

### Задача 11. `browser_tabs`: чужие сайты без пути и заголовка, параллельные метрики, `no_tab` для чужих (S7, R7, S11)

**Файлы:** `.../agent-pages.ts`; `AGENT_LIMITS.metricsMs: 1500` в протоколе; тесты — `agent-ops.test.ts`.

- [ ] **Шаг 1. Тесты.**
  - `'не-loopback страница: url — только origin, title пустой, viewport null, Page.getLayoutMetrics не вызван'` — переписать прежний тест «чужой сайт — loopback: false».
  - `'три гостя с зависшим getLayoutMetrics: tabs отвечает меньше чем за 2 с, у них viewport null'`.
  - `'страница чужого хозяина по id — no_tab, как несуществующая'` — правит ожидание `access_denied` в тесте хозяев.
  - `'пауза своей панели по id — по-прежнему access_denied «paused by the human»'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать: `viewportOf` через `Promise.all` и срок `metricsMs`. Origin — через `new URL(u).origin`; не разбирается — `''`.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `fix(desktop): browser_tabs — чужие сайты только origin, метрики параллельно со сроком, чужие страницы как no_tab`.

---

### Задача 12. Пауза панели для `browser_open` (S5)

**Файлы:** `.../agent-ops.ts` (`openOf`); тесты — `agent-ops.test.ts`.

- [ ] **Шаг 1. Тест:** `'панель хозяина на паузе: browser_open — access_denied «paused by the human», окну ничего (asked пуст)'` — и для `own`, и для `room`.
- [ ] **Шаг 2.** Прогнать — ПАДАЕТ.
- [ ] **Шаг 3.** Реализовать: после `ownerOf` — `if (registry.isPaused(workKey, owner))` выбросить ошибку из теста.
- [ ] **Шаг 4.** Прогнать — ПРОХОДИТ.
- [ ] **Шаг 5.** Коммит `fix(desktop): browser_open не открывает страницы в панели на паузе`.

---

### Задача 13. Реестр страниц v2: поколение документа, подтверждение, привязка (R3, A1, S9)

**Файлы:**
- `packages/desktop/src/shared/browser-types.ts`:
  ```ts
  type AgentPageRegistration =
    | { kind: 'hello'; generation: string }
    | { kind: 'page'; generation: string; webContentsId: number | null; workKey: string; owner: BrowserOwner; pageId: string; visible: boolean }
    | { kind: 'gone'; generation: string; workKey: string; pageId: string }
    | { kind: 'paused'; generation: string; workKey: string; owner: BrowserOwner; paused: boolean };
  ```
- `packages/desktop/src/main/ipc.ts` — `parseAgentRegistration` по `kind`; `generation` — строка 1…64.
- `.../agent-pages.ts`:
  - `hello` сбрасывает страницы и паузы и запоминает поколение;
  - записи другого поколения пропускаются;
  - `page` с известным `pageId` и другим `owner` пропускается;
  - `webContentsId`, уже привязанный к другому `pageId`, пропускается.
- `packages/desktop/src/main/index.ts` — убрать сброс по `did-start-navigation` (строки 344–347). `AgentOps.reset` больше не нужен.
- `packages/desktop/src/renderer/browser/panel/agent-registry.ts`:
  - поколение — случайный hex при `startAgentRegistry`, `hello` уходит первым;
  - кеш `pages`/`pauses` обновляется после успешного `registerTab`, при отказе — удаляется, и следующий `sync` шлёт запись снова.

- [ ] **Шаг 1. Тесты.**
  - `ipc.test.ts`: `'parseAgentRegistration: четыре вида, неверный kind и generation — null'`.
  - `agent-registry.test.ts`: `'hello — первым'`; `'отказ registerTab — запись уйдёт снова при следующем sync'`.
  - `agent-ops.test.ts`: `'hello сбрасывает реестр; запись старого поколения пропущена'`; `'pageId с другим owner и webContentsId у второй страницы не перепривязываются'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5. E2E** `'пауза переживает отменённый переход окна'` (Фокус ревью 3):
  1. пауза панели;
  2. `window.evaluate(() => { location.href = 'file:///tmp/parley-e2e-drop' })` — `guardNavigation` отменяет переход;
  3. смена активной страницы панели;
  4. `browser_console` — `access_denied`.

  Плюс прежний тест перезагрузки окна проходит.
- [ ] **Шаг 6.** Коммит `fix(desktop): реестр страниц агента по поколению документа окна, с подтверждением доставки и без перепривязки`.

---

### Задача 14. Совместимость хоста и окна: неизвестные коды, длина сообщения, список операций (A3)

**Файлы:**
- `packages/protocol/src/browser-agent.ts`:
  - `browserAgentResultParams`: `code: z.string().min(1).max(64)`, `message: z.string().max(10_000)`;
  - `BROWSER_AGENT_OP_FEATURE = (op: BrowserAgentOp) => \`browser-agent:${op}\``.
- `packages/host/src/methods/index.ts` (`browser.agentResult`):
  - код не из `BROWSER_AGENT_ERROR_CODES` → `unsupported`, текст сохраняется;
  - сообщение режется до 2000.
- `packages/host/src/agent/browser-endpoint.ts`: если у окна есть хоть одна `browser-agent:<op>`, но нет нужной — сразу `unsupported` «Parley's window does not support <op> yet: ask the human to update Parley.».
- `packages/desktop/src/main/host-connection.ts:370`: в `features` — плюс `BROWSER_AGENT_OPS.map(BROWSER_AGENT_OP_FEATURE)`.
- `.../agent-ops.ts`: `failure()` режет сообщение до 2000.

- [ ] **Шаг 1. Тесты.**
  - Хост: `'неизвестный код окна — агенту unsupported с текстом окна, не timeout'`.
  - Хост: `'сообщение 5000 знаков — агенту 2000'`.
  - Хост: `'окно с browser-agent:tabs, но без browser-agent:screenshot — unsupported сразу, окну не отправлено'`.
  - Хост: `'окно без browser-agent:* (сборка C) — как раньше'`.
  - Окно: `'hello несёт browser-agent и browser-agent:<op> на каждую операцию'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** Прогнать: `cd packages/host && npx vitest run src/agent src/methods`; desktop — `host-connection.test.ts`. ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `fix(protocol,host,desktop): канал агента принимает неизвестные коды окна, режет сообщения и знает операции окна`.

---

### Задача 15. Контракт core ↔ протокол, умолчания, мелкие правки (A2, A6, аудит 3.3)

**Файлы:**
- `packages/protocol/src/browser-agent.ts`: `AGENT_DEFAULTS = { limit: 50, level: 'error', failedOnly: true, fullPage: false } as const`.
- `.../agent-reads.ts`: умолчания из `AGENT_DEFAULTS` вместо `DEFAULT_LIST`.
- `packages/core/src/mcp/browser-tools.ts`: экспорт `BROWSER_TOOL_HINTS` (нынешние `HINTS`).
- Создать: `packages/protocol/src/browser-agent-contract.test.ts`.
- Изменить: `core/src/mcp/browser-tools.test.ts` — удалить тавтологию (строка 99).
- Изменить: `packages/desktop/src/renderer/layout/panels.ts:70` — снятие паузы через `const { paused: _, ...rest } = panel`.
- Изменить: строку `AGENTS_OFF` — название пункта из `S` (`strings.ts:984`), а не литералом.

- [ ] **Шаг 1. Тесты.**
  - `browser-agent-contract.test.ts`: `'схемы MCP core совпадают с zod протокола'` — по каждой операции:
    - сравнить `pick(BROWSER_TOOLS[i].inputSchema)` и `pick(z.toJSONSchema(browserAgentArgs[op]))`;
    - `pick` берёт свойства (`type`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `enum`), `required` и `additionalProperties`.
  - Там же: `'умолчания схем MCP равны AGENT_DEFAULTS'`.
  - Там же: `'ключи BROWSER_TOOL_HINTS — коды BROWSER_AGENT_ERROR_CODES'`.
  - Desktop: `'PAGE_DATA_NOTE core равна S.contextFile.pageDataNote'`.
  - `panels.test.ts`: `'Resume сохраняет неизвестное поле панели'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ на расхождениях: `requestId` 64 против 200, если задача 7 не закрыла.
- [ ] **Шаг 3.** Исправить расхождения.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ.
- [ ] **Шаг 5.** Коммит `test(protocol): контракт схем MCP core с zod протокола; умолчания в одном месте, пауза панели сохраняет поля`.

---

### Задача 16. `drops/`: снимки агента отдельно и с уборкой по часам (S8)

**Файлы:** `packages/desktop/src/main/drops.ts`, `packages/desktop/src/main/index.ts`, `.../agent-capture.ts`; тесты — `drops.test.ts`.

**Интерфейсы:**
- `saveImage(input: { png; dir; now?; random?; prefix?: string })` — имя файла `${prefix}YYYYMMDD-HHMMSS-xxxx.png`.
- `cleanupDrops(dir, maxAgeMs, now?, accept?: (name: string) => boolean)`.
- Проводка `saveImage` агента в `index.ts` передаёт `prefix: 'agent-'`.
- `index.ts` раз в час (`setInterval(...).unref()`) удаляет `agent-*` старше суток: `AGENT_SHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000`.

- [ ] **Шаг 1. Тесты:** `'prefix в имени'`; `'уборка с accept трогает только agent-*'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЮТ.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** Прогнать — ПРОХОДЯТ. Проверка core (путь — прямо в `drops/`, `.png`) не меняется.
- [ ] **Шаг 5.** Коммит `fix(desktop): снимки агента в drops с префиксом agent- и уборкой раз в час`.

---

### Задача 17. Разрешения читающих инструментов у Claude (S10) — нужно решение человека

Сейчас у Claude и GLM заранее разрешён только `browser_open`. Каждый из четырёх читающих инструментов спрашивает человека при первом вызове. Codex по `readOnlyHint` не спрашивает.

**Варианты:**
- **А (рекомендуется):** у Claude и GLM заранее разрешить все пять. `readOnlyHint` у снимка оставить, а побочный эффект описан в описании (задача 10). Поведение одинаково у всех провайдеров.
- **Б:** читающие спрашивают. У `browser_screenshot` `readOnlyHint: false`, то есть Codex тоже спросит.

**Файлы (вариант А):** `packages/core/src/work/settings-file.ts`, `launch.ts:381`; тесты — `settings-file.test.ts`, `launch.test.ts`.
- `BROWSER_PERMISSIONS = BROWSER_TOOL_OPS.map((op) => \`mcp__${MCP_SERVER_NAME}__browser_${op}\`)`.
- `allowBrowserOpen` → `allowBrowser`.

- [x] **Шаг 0.** Решение человека (16.10.2026): **вариант А**.
- [ ] **Шаг 1. Тест:** `'с каналом агента — permissions.allow ровно пять browser_*; без канала — поля нет'`.
- [ ] **Шаг 2.** Прогнать — ПАДАЕТ.
- [ ] **Шаг 3.** Реализовать.
- [ ] **Шаг 4.** Прогнать — ПРОХОДИТ.
- [ ] **Шаг 5.** Коммит `feat(core): читающие инструменты браузера разрешены заранее, как browser_open`.

---

### Задача 18. E2E, повтор проб аудита, документы

**Файлы:** `packages/desktop/e2e/browser-agent-read.spec.ts`, `CHANGELOG.md` (Unreleased), спека `docs/specs/2026-10-07-browser-devtools-agent-design.md`, аудит `docs/audits/2026-10-16/…` (в основном checkout, раздел «Повторная проверка»).

- [ ] **Шаг 1. E2E** в `browser-agent-read.spec.ts`, тест `'бюджеты и маска на настоящей странице'`:
  - деталь запроса с 60 заголовками по 2 КБ — текст ≤ 20 КБ;
  - консоль с `Bearer eyJ…` и `password=` — секретов в ответе нет;
  - страница панели ушла на `data:text/html,<title>Private</title>` — в `browser_tabs` нет ни `Private`, ни `data:` после origin;
  - пауза и `browser_open` — `access_denied`.
- [ ] **Шаг 2.** `pnpm --filter @parley/desktop build`, прогнать `npx playwright test e2e/browser-agent-read.spec.ts` — ПРОХОДИТ.
- [ ] **Шаг 3. Повтор проб.** Повторить `probe1-tokens`, `probe2-lag-dpr2-rea` и `probe3-grid` из `browser-agent-read-evidence/` (путь `OUT` поменять). Ожидание:
  - деталь ≤ 20 КБ;
  - по умолчанию в ответе все 46 ошибок (свёрнутые) ≤ 20 КБ;
  - строка списка сети ≤ 150 байт;
  - стоп main < 50 мс;
  - плиток нет.

  Числа — в раздел «Повторная проверка» аудита.
- [ ] **Шаг 4. Документы.**
  - Спека 5.1: аргументы `after`; `browser_tabs` для чужих сайтов — только origin; поверхность снимка.
  - Спека 6: маска текста консоли по виду значения; `code` — только в URL.
  - Спека 8: новые пределы.
  - CHANGELOG.
- [ ] **Шаг 5.** Коммит `test(desktop): E2E бюджетов, маски и чужих сайтов; docs: спека и CHANGELOG по итогам аудита`.

---

### Задача 19. Завершение

- [ ] Перед прогоном — `uptime`, ничего тяжёлого параллельно. Один полный прогон: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter @parley/desktop e2e`. Флейки сверять с прогоном задачи 1 плана C, не чинить мимоходом.
- [ ] Ревью всей ветки свежим ревьюером на самой сильной модели. На виду у ревьюера — «Фокус ревью» этого плана и таблицы аудита.
- [ ] Живая проверка (лимит подписки — с согласия человека):
  - Claude, Codex и GLM читают консоль, сеть и снимок;
  - снимок 1440×900 из узкой панели;
  - картинку видит каждый провайдер (GLM — по возможности).
- [ ] Отметить в плане C, задача 19, что находки аудита закрыты этим планом.

---

## Сознательно не делаем

| Находка | Почему |
|---|---|
| Двойной разбор JSON в `unmaskableJson` и `redactBody` (A8) | Только время. Тела ≤ 1 МБ, разбор — миллисекунды. Совмещение меняет API, общий с файлом-контекстом человека |
| Маска литералов GraphQL в `query` (S2) | Нужен разбор GraphQL. Секрет литералом в мутации — редкость. В спеке 6 записать, что литералы `query` не маскируются |
| `name*=UTF-8''…` в multipart (S2, RFC 5987) | Chromium так не шлёт |
| Секрет в сегменте пути (`/reset/ABCDEF`) | Маска по имени его не видит. В спеке 6 — оговорка |
| Устойчивые `tN` после перезапуска main (R15) | Для чтения достаточно описания (задача 10). Для действий — решение этапа D |
| Печать `at`, `origin` и `statusText` (аудит 4.3 п. 6) | Время нужно было, чтобы отличать новые записи от старых. Это закрывает курсор `after` (задачи 7, 9) без лишних токенов на каждую запись. Поля протокола остаются |
| Склейка в утилити-процессе (R8) | После задачи 4 полосы уже в итоговом размере, склейка — мегабайты. Проверка — `mainMaxLagMs` < 50 в задаче 18 |

## Спайк 0

Проба вне репозитория: `/private/tmp/claude-501/-Users-kalmbik61/d786ce0d-e805-449d-9e7e-65e509f760f2/scratchpad/spike0/` (каркас `probe3-grid.spec.ts`, страница `/grid`, панель 399×752, окно 1400×900, системный DPR 1, 1,5 и 2 через `--force-device-scale-factor`). Снимок через `webContents.debugger` на гостя, стиль `<webview>` — через `window.evaluate`, содержимое проверялось по цвету ячеек сетки и шагу ячейки в пикселях.

**Выбранная механика: размер элемента (задача 2 идёт основным путём, не запасным).** Но с четырьмя поправками ниже; без них задачи 2–4 не заработают на DPR > 1 и на fullPage.

**В1 — да.** Временная эмуляция 1440×900 плюс `<webview>` со стилем `position:absolute; left:0; top:0; width:1440px; height:900px` (родитель `position:relative; overflow:hidden` не мешает, его трогать не нужно) даёт PNG 1440×900 с настоящей страницей. Пиксель (1300, 100) = (240, 168, 169), то есть ячейка `1200,0`; без поверхности (контроль) тот же вызов даёт (204, 83, 76), то есть ячейку 0-го столбца (баг аудита). Видимая страница и `opacity: 0` ведут себя одинаково, `Page.captureScreenshot` у скрытой страницы ошибок не бросал.

**В2 — `captureReadyFrames = 2`, `captureRetries = 2`.** DPR 1: первый снимок верный уже при 0 кадров (36 из 36, видимая и скрытая). DPR 2, снимок без `clip` (PNG в пикселях устройства): при 0 кадров 2 из 12 первых снимков неверны и лечатся вторым, при 1 и больше кадрах — 0 из 48. Поэтому ждать 2 кадра окна (rAF) после стиля и эмуляции. Повтор нужен только как страховка от ошибок CDP: верность содержимого в проде проверить нельзя, ошибка у скрытой страницы в пробе не возникала. Число 2 в `AGENT_LIMITS.captureRetries` оставить.

**В3 — размер получается, но не надёжно; рецепт плана менять.** Условие «`dpr = layoutViewport.clientWidth / cssLayoutViewport.clientWidth`» верно (DPR 2: 2880/1440). Результат при DPR 2:
- `deviceScaleFactor: 1` в `setDeviceMetricsOverride` на экране с DPR 2 не действует: `captureSpec` ставит `dpr: 1`, и снимок ломается (PNG 1440×900, но в нём левая верхняя четверть страницы вдвое крупнее; с `clip.scale = 0,5` — PNG 720×450 и ещё меньше страницы). Системный DPR (1,5 и 2) обязателен в `deviceScaleFactor` эмуляции.
- При `deviceScaleFactor` = системному DPR снимок без `clip` всегда верный (PNG W·dpr × H·dpr, DPR 2 и 1,5), а `clip {x:0, y:0, width: W, height: H, scale: 1/dpr}` даёт PNG ровно W×H (1440×900 при DPR 2, `captureBeyondViewport` не задавать), но на DPR 2 в первые ~300 мс после смены размера возвращает вместо него неверную четверть страницы того же размера PNG: 30 из 60 первых снимков неверны, и отличить их по размеру нельзя. На DPR 1 тот же клип надёжен.
- `captureBeyondViewport: true` на DPR 1,5 ломает масштаб клипа даже внутри вида.
- У PNG без `clip` на DPR > 1 есть профиль Display P3 (`iCCP`), у PNG с `clip` — нет, при тех же числах: цвета у клипа чуть бледнее при просмотре как sRGB.

**Поправки к задачам:**
1. **Задача 4.** При DPR > 1 снимать без `clip` в пикселях устройства и уменьшать до CSS-размера (нативный `resize` или, если решено не декодировать на main, отдавать PNG W·dpr × H·dpr, если он влезает в `screenshotBytes`). Масштаб клипом `1/dpr` оставить только для DPR 1 (там он равен 1). `captureSpec` и `withTemporary` обязаны брать `deviceScaleFactor` из системного DPR (DPR окна, `window.devicePixelRatio`), а не 1.
2. **Задача 2, fullPage.** Полосы через `clip` с `y` ниже вида и `captureBeyondViewport: true` не работают: на DPR 1 и 2 полоса повторяет верх страницы, без `captureBeyondViewport` полоса пустая (чёрная). Работает прокрутка гостя между полосами: `Runtime.evaluate window.scrollTo(0, y)`, 2 кадра, снимок вида (строка на `y = 900` совпала с эталоном на DPR 1 и 2). Последняя полоса: брать фактический `window.scrollY` из ответа, он зажимается у конца документа.
3. **Задача 2, предел размера поверхности.** Поверхность выше предела тайлится: страница повторяется. При окне 900 px высоты верна высота ≤ 1100 и тайлится с 1300 (период 1200 CSS-px); при окне 600 период около 960, при окне 1200 около 1680. Ширина 1920 в окне 1400 верна. Эмуляция с `scale < 1` и уменьшенным элементом не помогает (PNG полного размера, нарисована только его часть). Значит, `<webview>` в размер снимка годится лишь до порога около 1,3 высоты окна: 1440×900, 1920×1080 работают, 2560×1440 и 3840×2400 в окне 1400×900 тайлятся. Для больших размеров нужно решение (отказ с понятной ошибкой `bad_request` «размер больше окна» или срез размера до окна с пометкой), и тест. Высоту fullPage одной поверхностью не снимать (поправка 2).
4. **Задача 2, тесты.** E2E-проверка пикселя (1300, 100) ловит прошлый баг, но на DPR 2 сравнивать цвет надо с поправкой на профиль или проверять только отличие от ячейки 0-го столбца.

Числа для задачи 2: `AGENT_LIMITS.captureReadyMs: 2000` оставить; в рендерере до `agentCaptureReady` ждать 2 кадра; `captureRetries: 2`.
