# План: точность действий агента в браузере и меньше ходов (этапы 1–3)

> **Исполнителю:** прочитай «Global Constraints» и «Решения, принятые при планировании», затем только свою задачу. Шаги — флажки `- [ ]`, иди по порядку. Чужих файлов не трогай; если задача без них не делается, остановись и напиши ведущему.

**Goal:** Клик агента не уходит в перекрывающий элемент, ответ действия говорит, что изменилось на странице, снимок видит фреймы, а несколько действий идут одним вызовом.

**Architecture:** Протокол (`packages/protocol`) получает необязательные поля и один код ошибки; core печатает их агенту; вся работа — в main окна (`packages/desktop/src/main/browser`). Проверка перекрытия и проба изменений — функции Parley в мире страницы (`page-fns.ts`), которые main зовёт через `Runtime.callFunctionOn`: проба живёт в изолированном мире. Список шагов исполняет тот же `actionOf` в одной операции очереди. Новых инструментов нет: их по-прежнему 15.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes: true`), zod, Electron 44.4.5 (CDP через `webContents.debugger`), vitest 2, Playwright + Electron.

**Spec:** `docs/specs/2026-11-18-browser-agent-precision-design.md`. В именах, файлах и границах задач верен план; в поведении — спека. Этап 4 (секреты) получает свой план после приёмки этапов 1–3: к тому времени код этих файлов изменится.

**База:** три ветки от свежего `origin/master`, по одной на этап: `feat/browser-agent-precision` (этап 1), `feat/browser-agent-steps` (этап 3), `feat/browser-agent-frames` (этап 2). Порядок слияния: 1 → 3 → 2; каждая следующая ветка берётся после слияния предыдущей. Факты сверены с `origin/master` 196850cf (v0.37.1); номера строк — ориентир, искать по имени. Короткие пути: `browser/…` — от `packages/desktop/src/main/browser/`, `protocol/…` — от `packages/protocol/src/`, `core/…` — от `packages/core/src/`.

## Ход исполнения

Заполняет ведущий: что сделано, чем проверено, коммиты.

| Задача | Состояние |
|---|---|
| 0 (спайк) | |
| 1.1 → 1.2 → 1.3 → 1.4 | |
| 3.1 ∥ 3.2 → 3.3 | |
| 2.2 → 2.3 | |

## Исполнение в комнате (2026-11-18)

Где этот раздел расходится с текстом ниже, верен он.

- **Одна ветка, один исполнитель.** Все задачи идут по очереди в рабочей копии исполнителя, одним рядом коммитов. Три ветки из раздела «База» не создаются; границы этапов — границы будущих pull request, их нарезает ведущий по коммитам.
- **База — ветка сертификата** `feat/browser-client-certificate` (be5f9124), а не `origin/master`: она уже правит `agent-actions.ts`, `agent-ops.ts` и навык, и вторая ветка от master дала бы конфликты в тех же местах. В ней `withNavigation` и `settleLoad` получают четвёртым аргументом `humanWait(deps.basicAuth, deps.clientCert)` — это и есть параметр `auth` из задачи 1.3; новый параметр `settle` идёт пятым.
- **Порядок:** 0 → 1.1 → 1.2 → 1.3 → 1.4 → 3.1 → 3.2 → 3.3 → 2.2 → 2.3. Параллельных задач нет.
- **Пункты плана комнаты:** 1 — задача 0; 2 — 1.1; 3 — 1.2; 4 — 1.3; 5 — 1.4; 6 — 3.1; 7 — 3.2; 8 — 3.3; 9 — 2.2; 10 — 2.3.
- **Ворота после спайка.** Задачи 1.3 и 2.2 начинаются только после слова ведущего в комнате: он читает отчёт задачи 0 и говорит, стоят ли задачи как написаны.
- **Подпись коммита:** в строке `Co-Authored-By` — модель, которая писала коммит (строка из правил исполнителей написана для другой модели).
- **Правка коммита после возврата** — новым коммитом, без `--amend`.
- **Поправка ведущего к задаче 3.1 (2026-11-18), ошибка плана.** Stop человека, пауза панели и выключатель доступа обрывают вызов целиком, как сегодня: `run()` в `agent-ops.ts` отвечает `access_denied` сразу и отбрасывает результат задачи, чтобы Stop был мгновенным. Это поведение не меняется. Частичный ответ со `stopped` обязателен только для отказа шага (`stale_ref`, `covered`, `bad_request` и другие отказы самого шага), перехода и срока. Строка Review Focus 3 читается без слов «Stop, пауза панели». Тест `guard.check бросает access_denied перед шагом 2` остаётся проверкой `actionOf` в отрыве от очереди; сквозного требования «после Stop агент видит сделанные шаги» нет.

## Решения, принятые при планировании

| Вопрос | Решение |
|---|---|
| Старый core и код `covered` | Проверено по коду: core печатает любой строковый код (`browser-tools.ts`, ветка `error.code`), хост коды не сверяет. Запасной путь из раздела 7 спеки не нужен |
| Перекрывающий элемент в тексте отказа | Данные страницы: в сообщении отказа — в ограде `fence(…)`, как список опций у `select` (`optionsData` в `agent-actions.ts`) |
| Проверка перекрытия сама упала | Клик идёт как раньше. Отказ — только при ответе `covered: true` |
| Где исполняется проба | `Page.createIsolatedWorld` (мир `parley-agent`) и `Runtime.callFunctionOn` с `executionContextId` и функцией из `PAGE_FNS`. `Runtime.evaluate` не используется: рамочный тест пускает его только в `agent-evaluate.ts` |
| «Запрос в полёте» | Запись сети текущей эпохи журнала инспектора с `status === null`, `failure === null`, моложе `settleFreshRequestMs` |
| Проба пропала после действия | Прежние 300 мс и `change: 'unknown'`; «ничего не изменилось» без пробы не говорим |
| Срок списка шагов | Общий срок операции (`opMs`); перед шагом проверяется остаток против `stepReserveMs` |
| Отказ первого шага списка | Обычная ошибка операции: ничего не сделано, частичного ответа нет. Отказ на шаге 2 и дальше — успешный ответ с полем `stopped` |
| Результат одиночного действия | Форма прежняя: полей `steps` и `stopped` нет |
| Ссылки во фреймах того же процесса | Карта ссылок остаётся `Map<string, number>`: `backendNodeId` у таких фреймов общий с главным документом. Структура `{ backendNodeId, frameId, sessionId }` из спеки нужна только фреймам другого процесса |
| Фреймы другого процесса | В этом плане — строка `iframe` с пометкой `(content not available: another site)`. Если спайк покажет, что сеансы работают, ведущий пишет дополнение к плану |
| Вопрос об изолированном мире | Перенесён в спайк (задача 0): исполнителям задач приложение запускать нельзя |

## Global Constraints

- Правила исполнителей — `docs/plans/2026-11-10-review-fixes/executor-rules.md`: vitest не запускать, приложение не стартовать, `pnpm install` не звать; тесты пишутся, гоняет их CI. Исключение — задача 0: ей разрешён свой стенд Electron (не Parley). Шаг «Проверка» каждой задачи — команды раздела «Checks» правил для изменённых пакетов в порядке protocol → core → host → desktop и `pnpm exec eslint <изменённые файлы>`.
- Тексты агенту — по-английски; комментарии и названия тестов — по-русски. Стражи английского текста — в правилах исполнителей.
- Список инструментов (15) и их имена не меняются. Описание каждого `browser_*` — не длиннее 900 знаков (`core/mcp/browser-tools.test.ts`), схемы строгие (`additionalProperties: false`).
- Навык `parley-browser` — не длиннее 220 строк; таблица ошибок навыка сверяется с кодами протокола тестом.
- Всё новое в протоколе — необязательное: ответ без `change`, `steps`, `stopped`, `snapshot` печатается как сегодня; отсутствующее поле остаётся отсутствующим (тесты `toEqual` на целых объектах).
- Новые методы CDP добавляются в `CDP_ALLOWED` (`browser/inspector.ts`); новые страничные функции — в `PAGE_FNS` (`browser/page-fns.ts`): иначе `cdpCallAllowed` их не пустит. Страничные функции — ES5 без внешних глобалов.
- Рамочный тест `browser/agent-frame.test.ts`: строки `Runtime.evaluate`, `Input.dispatch…`, `Input.insertText`, `executeJavaScript(` в новые файлы не писать, в том числе в комментарии.
- Мышь и клавиши — только через `AgentInput`; перед каждой командой страницы — `guard.check()` (как `send` в `actionOf`).
- Один коммит на задачу, заголовок — из последнего шага. Push и pull request — по слову человека; описание PR несёт карточку влияния (`PARLEY.md`).

## Review Focus

1. **Проверка перекрытия не ломает рабочие клики.** Скрытый флажок под `<label>`, цель внутри открытого теневого корня, цель нулевого размера, ответ страничной функции не той формы — клик проходит. Тесты — 1.2.
2. **«Ничего не изменилось» только по факту.** Проба пропала, мир пересоздан, страница сменила документ без события перехода — `changed` или `unknown`, не `none`. Тесты — 1.3.
3. **Частичный ход списка не теряется.** Отказ, Stop, пауза панели или срок на шаге 2 и дальше — ответ называет сделанные шаги и первый несделанный. Тесты — 3.1.
4. **Старое окно, новый core и наоборот.** Ответ без новых полей печатается как сегодня; `steps` у старого окна — `bad_request` его схемы. Тесты — 1.1 и 3.2.
5. **Секреты во фреймах.** Поле с секретным именем во фрейме скрыто, как в главном документе; предел байт снимка общий. Тесты — 2.2.

## Порядок исполнения

| Шаг | Задачи | После |
|---|---|---|
| A | 0 ∥ 1.1 | Ведущий читает отчёт спайка; при отрицательном ответе на вопрос 1 задача 1.3 не начинается — ведущий правит план |
| B | 1.2 → 1.3 → 1.4 | Проверки, ревью ветки старшей моделью. **PR этапа 1** |
| C | 3.1 ∥ 3.2 → 3.3 | Проверки, ревью. **PR этапа 3** |
| D | 2.2 → 2.3 | Проверки, ревью. **PR этапа 2** |

`browser/agent-actions.ts` правят 1.2, 1.3, 3.1 и 2.2; `browser/page-fns.ts` — 1.2 и 1.3; `browser/inspector.ts` — 1.3 и 2.2. Всё — строго по очереди.

---

### Task 0: Спайк — изолированный мир и фреймы у гостя `<webview>`

**Files:**
- Create: `docs/research/2026-11-18-browser-frames-spike.md`
- Скрипты — в scratchpad сессии, в репозиторий не входят.

Стенд — по образцу `docs/research/2026-10-20-browser-agent-control-spike.md`: окно Electron 44.4.5 с `<webview>` в разделе, страж как у Parley, отладчик подключается до `loadURL`. Страница на `127.0.0.1` с тремя фреймами, каждый сдвинут на (100, 300): того же origin, `srcdoc` и другого сайта (`localhost` на другом порту — другой сайт относительно `127.0.0.1`). В каждом фрейме — кнопка, которая пишет в журнал.

**Вопросы (каждый — замером):**
1. `Page.createIsolatedWorld { frameId, worldName }` у гостя отвечает `executionContextId`; `Runtime.callFunctionOn { functionDeclaration, executionContextId, returnByValue: true }` исполняется; `MutationObserver` из этого мира видит изменения DOM страницы; страница не видит глобал этого мира.
2. `Accessibility.getFullAXTree { frameId }` для фрейма того же origin и для `srcdoc` отдаёт дерево; `DOM.getFrameOwner { frameId }` отдаёт `backendNodeId`, равный `backendDOMNodeId` узла `Iframe` в дереве родителя.
3. `DOM.getBoxModel` узла внутри таких фреймов: координаты в главном вьюпорте или во фрейме (сдвиг 100, 300 покажет).
4. `Input.dispatchMouseEvent` в координатах главного вьюпорта нажимает кнопку во фрейме каждого из трёх видов.
5. Фрейм другого сайта: есть ли он в `Page.getFrameTree`; чем отвечает `Accessibility.getFullAXTree { frameId }`; приходит ли `Target.attachedToTarget` после `Target.setAutoAttach { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }` и работает ли `debugger.sendCommand(method, params, sessionId)`.

- [ ] **Шаг 1.** Собрать стенд и страницу.
- [ ] **Шаг 2.** Прогнать вопросы 1–5, записать команды и ответы.
- [ ] **Шаг 3.** Отчёт: вопрос — замер — вывод; отдельной строкой — что это значит для задач 1.3 и 2.2 (координаты, нужен ли пересчёт).
- [ ] **Шаг 4. Коммит:** `docs(research): record the isolated world and frames spike`

---

## Этап 1 — перекрытие и строка изменения

### Task 1.1: Протокол и тексты

**Files:**
- Modify: `protocol/browser-agent.ts`, `core/mcp/browser-tools.ts`, `core/work/parley-browser-skill.ts` и их тесты (`protocol/browser-agent.test.ts`, `protocol/browser-agent-contract.test.ts`, `core/mcp/browser-tools.test.ts`, `core/work/parley-browser-skill.test.ts`)

**Interfaces — Produces:**

```ts
// protocol/browser-agent.ts
BROWSER_AGENT_ERROR_CODES: добавить 'covered' последним
AGENT_LIMITS: settleQuietMs: 100, settleCapMs: 1_000, settleFreshRequestMs: 1_500
export type BrowserAgentChange = 'navigated' | 'changed' | 'none' | 'unknown';
BrowserAgentActionResult: change?: BrowserAgentChange
```

- [ ] **Шаг 1. Тесты.**
  - протокол: `BROWSER_AGENT_ERROR_CODES` содержит `'covered'`; три новых предела равны 100, 1000, 1500;
  - core, `formatAction` через вызов инструмента (как соседние тесты действий): `change: 'changed'` → текст содержит `The page changed.`; `'none'` → `Nothing changed on the page: check the target with a new browser_snapshot.`; `'navigated'` или `navigated: true` → прежняя фраза про устаревшие ссылки, один раз; `'unknown'` и ответ без `change` → ни одной из трёх фраз (при `navigated: false`);
  - core: ошибка окна с кодом `covered` печатается `covered: <текст окна> <подсказка>`;
  - навык: в таблице ошибок есть строка `covered`.
- [ ] **Шаг 2. Протокол** — по блоку Interfaces.
- [ ] **Шаг 3. Core.** В `ActionResult` — `change?`. `formatAction`: при `navigated || change === 'navigated'` — прежняя фраза; иначе по `change` — фразы из шага 1; иначе пусто. `BROWSER_TOOL_HINTS.covered = 'Close or move what covers the element (a banner, a dialog, a sticky bar), take a new browser_snapshot and retry.'` Последнее предложение описания `browser_action`: `Fails with human_busy while the human selects or annotates in that page, with stale_ref when the ref is from an older snapshot, and with covered when another element lies over the target (nothing is clicked).`
- [ ] **Шаг 4. Навык.** Строка таблицы ошибок после `stale_ref`: ``| `covered` | Another element lies over the target (a banner, a dialog): nothing was clicked. Close it or scroll, take a new `browser_snapshot`, retry. |`` В рецепте «Walk through a flow» шаг 3 заменить на: ``3. Read the answer of each action: it says whether the page navigated, changed or stayed the same. Use `browser_wait_for` only for text that appears later.``
- [ ] **Шаг 5. Проверка** (protocol, core, host, desktop — все собираются с новым кодом).
- [ ] **Шаг 6. Коммит:** `feat(protocol): add the covered error and the change field of an agent action`

---

### Task 1.2: Проверка перекрытия

**Files:**
- Modify: `browser/page-fns.ts`, `browser/agent-actions.ts`; тесты `browser/page-fns.test.ts`, `browser/agent-actions.test.ts`

**Interfaces:**
- Consumes: код `'covered'` (1.1).
- Produces: `export const HIT_TEST_FN: string` в `page-fns.ts`, входит в `PAGE_FNS`. `this` — цель; аргумент `recenter: boolean`; ответ `{ covered: boolean; by?: string }`.

Тело функции (алгоритм тестами не определяется):

```js
function (recenter) {
  var el = this;
  if (!el || el.nodeType !== 1) return { covered: false };
  if (recenter) el.scrollIntoView({ block: 'center', inline: 'center' });
  var rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { covered: false };
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
  var top = root && root.elementFromPoint ? root.elementFromPoint(x, y) : el.ownerDocument.elementFromPoint(x, y);
  if (!top) return { covered: false };
  var node = top;
  while (node) {
    if (node === el) return { covered: false };
    node = node.parentNode || node.host;
  }
  if (top.contains && top.contains(el)) return { covered: false };
  var label = top.closest ? top.closest('label') : null;
  if (label && label.control === el) return { covered: false };
  var text = (top.getAttribute('aria-label') || top.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  var role = top.getAttribute('role');
  return { covered: true, by: top.tagName.toLowerCase() + (role ? '[role=' + role + ']' : '') + (text ? ' "' + text + '"' : '') };
}
```

- [ ] **Шаг 1. Тесты `page-fns.test.ts`** (jsdom, функция — через `new Function`, как у `SELECT_OPTION_FN`; `elementFromPoint` и `getBoundingClientRect` — подменой):
  - верхний элемент — цель или её потомок → `{ covered: false }`;
  - верхний — чужой `div role="dialog"` с текстом `Cookie consent` → `{ covered: true, by: 'div[role=dialog] "Cookie consent"' }`;
  - верхний — `<label>`, чей `control` — цель → `{ covered: false }`;
  - верхний — предок цели → `{ covered: false }`;
  - рамка нулевого размера и `elementFromPoint` → `null` → `{ covered: false }`;
  - `recenter: true` зовёт `scrollIntoView` с `{ block: 'center', inline: 'center' }`;
  - текст длиннее 60 знаков режется до 60;
  - `PAGE_FNS` содержит `HIT_TEST_FN`.
- [ ] **Шаг 2. Тесты `agent-actions.test.ts`.** В `setup` — опция `hits?: unknown[]`: ответы на `Runtime.callFunctionOn` с `functionDeclaration === HIT_TEST_FN`, по очереди; без опции подставной ответ прежний.
  - `click` по ссылке, `hits: [{ covered: false }]` → мышь послана;
  - `hits: [{ covered: true, by: 'div "x"' }, { covered: false }]` → второй вызов с аргументом `true`, `dom.centerOf` вызван дважды, мышь послана;
  - `hits: [{ covered: true, … }, { covered: true, by: 'div[role=dialog] "Cookie consent"' }]` → отказ с кодом `covered`, текст начинается с `Element e1 is covered by another element; nothing was clicked.` и содержит описание в ограде; `mouse` не вызван;
  - то же для `check`;
  - `click` по `x`, `y`, `hover`, `drag` → `HIT_TEST_FN` не вызывается;
  - `Runtime.callFunctionOn` бросил обычную ошибку или вернул `{ ok: true }` → мышь послана;
  - `Runtime.releaseObject` вызван и при отказе.
- [ ] **Шаг 3. `agent-actions.ts`.** Внутри `actionOf` — `async function clearPointOf(name: string): Promise<{ x: number; y: number }>`: `dom.centerOf` → `DOM.resolveNode` → `HIT_TEST_FN(false)` → при `covered === true` `HIT_TEST_FN(true)` и повторный `dom.centerOf` → всё ещё `covered === true` → `AgentOpError('covered', …)`. Команды — через `send` (он зовёт `guard.check()`), объект освобождается в `finally`. `click` и `double_click` со ссылкой, `check`, `uncheck` берут точку из `clearPointOf`; остальные действия — как были.
- [ ] **Шаг 4. Проверка.** Старые тесты, считающие вызовы `send`, сверить с новым числом.
- [ ] **Шаг 5. Коммит:** `feat(desktop): refuse an agent click on a covered element`

---

### Task 1.3: Проба изменений и ожидание по событиям

Начинается после отчёта задачи 0 с ответом «да» на вопрос 1.

**Files:**
- Create: `browser/agent-settle.ts`, `browser/agent-settle.test.ts`
- Modify: `browser/page-fns.ts`, `browser/inspector.ts` (`CDP_ALLOWED`: `Page.getFrameTree`, `Page.createIsolatedWorld`), `browser/agent-actions.ts` (`withNavigation`, зависимость `settle`), `browser/agent-ops.ts` (создание и проброс); тесты `browser/page-fns.test.ts`, `browser/agent-actions.test.ts`, `browser/inspector.test.ts`

**Interfaces — Produces:**

```ts
// page-fns.ts — в PAGE_FNS
export const PROBE_FN: string;   // ответ { n: number; idle: number; ready: string }

// agent-settle.ts
export interface PageProbe { n: number; idle: number; ready: string; world: number }
export interface AgentSettle {
  /** Проба документа; null — мира нет и создать не вышло. Не бросает, кроме обрыва. */
  probe(contents: WebContents): Promise<PageProbe | null>;
  /** Ждёт затишья (спека 3.2), не дольше settleCapMs; последняя проба или null. Обрыв signal — отказ с его причиной. */
  quiet(contents: WebContents, signal: AbortSignal): Promise<PageProbe | null>;
}
export function createAgentSettle(deps: {
  inspector: Pick<Inspector, 'send' | 'snapshot'>;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}): AgentSettle;
export function changeOf(before: PageProbe | null, after: PageProbe | null, navigated: boolean): BrowserAgentChange;

// agent-actions.ts
withNavigation<T>(contents, run, signal, auth?, settle?: AgentSettle): Promise<{ value: T; navigated: boolean; loaded: boolean; change: BrowserAgentChange }>
createAgentActions(deps: { …; settle?: AgentSettle })
```

`PROBE_FN`:

```js
function () {
  var g = globalThis;
  var p = g.__parleyProbe;
  if (!p) {
    p = g.__parleyProbe = { n: 0, at: Date.now() };
    new MutationObserver(function (list) { p.n += list.length; p.at = Date.now(); })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return { n: p.n, idle: Date.now() - p.at, ready: document.readyState };
}
```

Правила:
- **Мир.** `Page.getFrameTree` → `frameTree.frame.id`; `Page.createIsolatedWorld { frameId, worldName: 'parley-agent' }` → `executionContextId`. Запоминается по `contents.id` и эпохе `inspector.snapshot(id)?.epoch`. `Runtime.callFunctionOn { functionDeclaration: PROBE_FN, executionContextId, returnByValue: true }`. Ошибка вызова — мир пересоздаётся один раз; снова ошибка — `null`.
- **`quiet`.** Цикл: проба; запросы в полёте по «Решениям»; готово, если `ready !== 'loading'`, `idle >= settleQuietMs` и запросов нет; вышло `settleCapMs` — вернуть последнюю пробу; иначе `sleep(min(max(20, settleQuietMs - idle), остаток))`. Проба `null` — вернуть `null` сразу. Единицу поля `ts` записи сети сверить в `browser/cdp-entries.ts`; если это не `Date.now()` — остановиться и написать ведущему.
- **`changeOf`.** `navigated` → `'navigated'`; любая проба `null` → `'unknown'`; `world` разный или `n` разный → `'changed'`; иначе `'none'`.
- **`withNavigation`.** Без `settle` — поведение прежнее, `change`: `'navigated'` при переходе, иначе `'unknown'`. С `settle`: проба до `run()`; после — `quiet`; если до или после `null` — прежний `sleep(settleMs)`; затем прежняя проверка перехода и `settleLoad`.
- **Ответ действия.** `change` попадает в результат только при заданном `settle`: `...(deps.settle === undefined ? {} : { change: outcome.change })`. `agent-ops.ts` создаёт один `createAgentSettle({ inspector: deps.inspector })` и передаёт его в `createAgentActions`; `navigate` зовёт `withNavigation` без `settle`.

- [ ] **Шаг 1. Тесты `agent-settle.test.ts`** (подставные `now` и `sleep`):
  - тихая страница (`idle: 150`, запросов нет) → `quiet` вернул пробу, `sleep` не вызван;
  - `idle: 10`, затем `120` → один `sleep`, аргумент 90;
  - запрос текущей эпохи с `status: null`, моложе 1500 мс, не завершается → возврат по `settleCapMs`: суммарный сон не меньше 1000 и не больше 1100;
  - тот же запрос старше 1500 мс или прошлой эпохи → не держит;
  - `ready: 'loading'` держит до смены;
  - `Page.createIsolatedWorld` бросил → `probe` → `null`;
  - `Runtime.callFunctionOn` бросил один раз → мир пересоздан, проба с новым `world`;
  - обрыв `signal` во время сна → отказ с причиной сигнала;
  - `changeOf`: шесть случаев из правила выше.
- [ ] **Шаг 2. Тесты `agent-actions.test.ts`:** со `settle`-заглушкой действие отдаёт `change: 'changed'`, `'none'`; при `did-start-navigation` главного фрейма — `'navigated'`; `probe` → `null` → `'unknown'` и прежний сон 300 мс; без `settle` ключа `change` в результате нет.
- [ ] **Шаг 3. Тесты `page-fns.test.ts` и `inspector.test.ts`:** `PROBE_FN` дважды подряд даёт один наблюдатель (счёт растёт после правки DOM, `idle` падает); `PAGE_FNS` содержит `PROBE_FN`; `cdpCallAllowed('Page.createIsolatedWorld')` и `('Page.getFrameTree')` → `true`.
- [ ] **Шаг 4. Реализация** по блокам выше.
- [ ] **Шаг 5. Проверка.** Рамочный тест `agent-frame.test.ts` перечитать: новые файлы не должны попасть под его правила.
- [ ] **Шаг 6. Коммит:** `feat(desktop): report what an agent action changed on the page`

---

### Task 1.4: Сквозные сценарии и CHANGELOG этапа 1

**Files:**
- Modify: `packages/desktop/e2e/browser-agent-control.spec.ts`, `CHANGELOG.md`

- [ ] **Шаг 1. Страница сценария** (сервер файла уже есть): кнопка под фиксированным слоем `role="dialog"` с кнопкой закрытия; кнопка, которая через 150 мс после `fetch` дописывает текст; кнопка без обработчика; ссылка на вторую страницу.
- [ ] **Шаг 2. Сценарий «перекрытая цель»:** `browser_action click` по кнопке под слоем → `isError`, текст начинается с `covered:`; страница клика не получила (счётчик страницы через `guestEval` равен 0); после клика по кнопке закрытия тот же клик проходит.
- [ ] **Шаг 3. Сценарий «строка изменения»:** кнопка с отложенным `fetch` → `The page changed.`; кнопка без обработчика → `Nothing changed on the page`; ссылка → `The page navigated`.
- [ ] **Шаг 4. `CHANGELOG.md`,** Unreleased → Changed: `- Built-in browser, agents: a click on an element covered by a banner or a dialog is refused with "covered" instead of landing on the cover, and every action says whether the page navigated, changed or stayed the same.`
- [ ] **Шаг 5. Проверка:** typecheck файла e2e и eslint. Прогон сценариев — у ведущего или в CI, не у исполнителя.
- [ ] **Шаг 6. Коммит:** `test(desktop): cover the covered refusal and the change line end to end`

---

## Этап 3 — несколько шагов за вызов

### Task 3.1: Схема шагов и исполнение списка

**Files:**
- Modify: `protocol/browser-agent.ts`, `browser/agent-actions.ts`, `browser/agent-input.ts` (поле `deadline` у `InputGuard`), `browser/agent-ops.ts`; тесты `protocol/browser-agent.test.ts`, `browser/agent-actions.test.ts`, `browser/agent-ops-control.test.ts`

**Interfaces — Produces:**

```ts
// protocol/browser-agent.ts
AGENT_LIMITS: steps: 10, stepReserveMs: 3_000
export type BrowserAgentStep = { action: (typeof AGENT_ACTIONS)[number]; ref?; x?; y?; text?; key?; modifiers?; submit?; direction?; amount?; value?; toRef?; toX?; toY?; files? };
// args операции action: tab, далее ЛИБО поля шага (action обязателен), ЛИБО steps; плюс snapshot
steps?: BrowserAgentStep[]                      // 1…AGENT_LIMITS.steps
snapshot?: 'full' | 'interactive'
export interface BrowserAgentStepResult { done: string; change?: BrowserAgentChange; pageData?: string }
BrowserAgentActionResult:
  steps?: BrowserAgentStepResult[]
  /** at — номер (с 1) первого невыполненного шага; у 'failed' это шаг с отказом. */
  stopped?: { at: number; reason: 'failed' | 'navigated' | 'time'; code?: BrowserAgentErrorCode; message?: string }
  snapshot?: { text: string; refs: number; truncated: boolean }

// agent-input.ts
InputGuard: deadline?: number      // момент Date.now(), к которому операция получит timeout
```

Схема: проверки одного действия (те же `refine`, что сегодня) выносятся в общую функцию и применяются и к шагу, и к одиночной форме. Сообщения новых отказов: `Pass action or steps, not both.`; `Pass action or steps.`; `With steps, put ref, text and the other fields inside each step.`

Исполнение (`actionOf`): тело `act()` становится `runStep(step: BrowserAgentStep)`; одиночное действие — список из одного шага. Перед шагом с номером больше 1: `guard.check()`; если `guard.deadline - Date.now() < stepReserveMs` — `stopped` с `'time'`; если был переход и у шага есть `ref` или `toRef` — `stopped` с `'navigated'`. Шаг — через `withNavigation(…, deps.settle)`. Переход с `loaded: false` при оставшихся шагах — `stopped` с `'navigated'` на следующем. `AgentOpError` первого шага пробрасывается; на шаге 2 и дальше — `stopped` с `'failed'`, `code`, `message`. Обрыв не `AgentOpError` пробрасывается всегда. При `args.steps`: `done` — `Ran ${выполнено} of ${всего} steps.`, `navigated` — был ли переход, `change` — последнего выполненного шага. `snapshot` снимается `dom.snapshotOf` после списка, если остановка не по `'time'`; его отказ — заметка `Snapshot failed: call browser_snapshot.`, поля `snapshot` нет. `agent-ops.ts` кладёт `deadline` в `guard`.

- [ ] **Шаг 1. Тесты схемы:** `action` и `steps` вместе; ни того, ни другого; `steps` и `ref` на верхнем уровне; пустой `steps`; 11 шагов — отказы с сообщениями выше; шаг `type` без `text` — прежнее сообщение `type needs text.`; верный список из 10 шагов и `snapshot: 'interactive'` — проходит; одиночная форма — как раньше.
- [ ] **Шаг 2. Тесты `agent-actions.test.ts`:**
  - три шага без отказов → `steps` длины 3, `done: 'Ran 3 of 3 steps.'`, поля `stopped` нет;
  - отказ `stale_ref` на шаге 2 → `steps` длины 1, `stopped: { at: 2, reason: 'failed', code: 'stale_ref', message: … }`, шаг 3 не исполнялся;
  - отказ на шаге 1 → операция отклонена тем же `AgentOpError`;
  - переход на шаге 1, шаг 2 — `press` без ссылки, шаг 3 — `click` по ссылке → `steps` длины 2, `stopped: { at: 3, reason: 'navigated' }`;
  - `guard.deadline` через 2 с перед шагом 2 → `stopped: { at: 2, reason: 'time' }`, снимок не снимается;
  - `guard.check` бросает `access_denied` перед шагом 2 → `stopped` с `'failed'` и `code: 'access_denied'`;
  - `snapshot: 'interactive'` → `dom.snapshotOf` вызван с `interactiveOnly: true`, результат несёт `snapshot`; отказ снимка → заметка, поля нет;
  - одиночное действие → ключей `steps`, `stopped` нет; с `snapshot: 'full'` — поле `snapshot` есть.
- [ ] **Шаг 3. Тест `agent-ops-control.test.ts`:** `guard.deadline` равен моменту постановки плюс срок операции.
- [ ] **Шаг 4. Реализация** протокола и окна.
- [ ] **Шаг 5. Проверка** (protocol, core, host, desktop).
- [ ] **Шаг 6. Коммит:** `feat(desktop): run several agent actions in one call`

---

### Task 3.2: Core и навык

**Files:**
- Modify: `core/mcp/browser-tools.ts`, `core/work/parley-browser-skill.ts` и их тесты

**Interfaces — Consumes:** форма результата и аргументов из 3.1 (блок Interfaces; core держит свою копию типов результата).

Формат ответа со `steps` (вне ограды):

```
1. Clicked e4. The page changed.
2. Typed 12 characters into e7. Nothing changed on the page: check the target with a new browser_snapshot.
Step 3 failed: stale_ref: <message> <hint>
Not run: 4-5.
```

- Строка шага: `${номер}. ${done}${фраза изменения из 1.1}`.
- `stopped.reason`: `'failed'` → `Step ${at} failed: ${code}: ${message}` и подсказка кода, затем `Not run: ${диапазон}.`, если шаги остались; `'navigated'` → `Not run: ${диапазон} (refs are stale after the navigation).`; `'time'` → `Not run: ${диапазон} (out of time: call again).`
- Диапазон: `4` или `4-5`.
- `pageData` шагов — в ограде, строками `Step ${номер}: ${pageData}`.
- `snapshot`: после строк шагов — `New snapshot: ${refs} refs; they replace all earlier refs.` (при `truncated` — прежняя фраза обрезки из `formatSnapshot`), текст дерева — в ограде после `Page: ${url}`.

- [ ] **Шаг 1. Тесты core:** четыре ответа — без остановки, `'failed'`, `'navigated'`, `'time'` — совпадают с форматом выше построчно; `snapshot` у одиночного действия и у списка; ответ без `steps` — прежний текст; схема инструмента строгая, `required` — только `tab`, `steps.maxItems` равен 10; описание `browser_action` ≤ 900 знаков.
- [ ] **Шаг 2. Схема инструмента:** свойства действия вынести в общий объект и использовать на верхнем уровне и в `steps.items` (`additionalProperties: false`); добавить `steps` и `snapshot` (`enum: ['full', 'interactive']`). В описание — предложение: `steps runs up to 10 actions in one call and stops at the first failure or when a navigation makes the next ref stale; snapshot adds a fresh snapshot (full or interactive) to the answer.`
- [ ] **Шаг 3. `formatAction`** по формату выше.
- [ ] **Шаг 4. Навык.** Строка `browser_action` в таблице инструментов дополняется: ``; `steps` runs up to 10 of them in one call.`` Рецепт целиком:

  ```
  ### Walk through a flow
  1. `browser_snapshot` with `interactiveOnly` true.
  2. One `browser_action` with `steps`: every action you can already see in that snapshot — fill the fields, then click. Add `snapshot` `interactive` to get the next refs in the same answer.
  3. Read the answer: each step says whether the page navigated, changed or stayed the same; a failed step stops the list and names the steps that did not run.
  4. After a navigation the old refs are stale: use the snapshot from the answer, or take a new one.
  ```
- [ ] **Шаг 5. Проверка.** Тесты навыка, закрепляющие фразы старого рецепта, сверить.
- [ ] **Шаг 6. Коммит:** `feat(core): print the steps of a browser action and its snapshot`

---

### Task 3.3: Сквозной сценарий и CHANGELOG этапа 3

**Files:**
- Modify: `packages/desktop/e2e/browser-agent-control.spec.ts`, `CHANGELOG.md`

- [ ] **Шаг 1. Сценарий «форма одним вызовом»:** снимок; один `browser_action` со `steps` — три `type` по ссылкам и `click` по кнопке отправки, `snapshot: 'interactive'`. Проверки: в журнале вызовов MCP ровно один `browser_action`; значения полей на странице — введённые; ответ несёт четыре пронумерованные строки и `New snapshot:`.
- [ ] **Шаг 2. Сценарий «остановка»:** шаг 2 со ссылкой `e9999` → ответ: строка шага 1, `Step 2 failed: stale_ref`, `Not run: 3.`; третье поле на странице пустое.
- [ ] **Шаг 3. `CHANGELOG.md`,** Unreleased → Added: `- Built-in browser, agents: browser_action takes a list of up to 10 steps and can return a fresh snapshot in the same answer, so a form takes one call instead of one per field.`
- [ ] **Шаг 4. Проверка:** typecheck файла e2e и eslint.
- [ ] **Шаг 5. Коммит:** `test(desktop): cover a multi-step browser action end to end`

---

## Этап 2 — фреймы

### Task 2.2: Фреймы того же процесса в снимке, ожидании и действиях

Начинается после отчёта задачи 0. План исходит из ответов: вопрос 2 — «да», вопрос 3 — «координаты главного вьюпорта», вопрос 4 — «да». Другой ответ на вопрос 3 — ведущий дописывает пересчёт до начала задачи.

**Files:**
- Modify: `protocol/browser-agent.ts` (пределы), `browser/inspector.ts` (`CDP_ALLOWED`: `DOM.getFrameOwner`), `browser/ax-snapshot.ts`, `browser/agent-dom.ts`; тесты `browser/ax-snapshot.test.ts`, `browser/agent-dom.test.ts`, `browser/inspector.test.ts`

**Interfaces — Produces:**

```ts
AGENT_LIMITS: frames: 20, frameDepth: 3
/** backendDOMNodeId элемента iframe → дерево его документа; фрейма нет в карте — содержимое недоступно. */
export type AxFrames = ReadonlyMap<number, readonly AxNode[]>;
axSnapshot(nodes, options: { interactiveOnly: boolean; limitBytes: number; frames?: AxFrames }): AxSnapshot
axHasText(nodes, text, frames?: AxFrames): boolean
axState(nodes, backendNodeId, state, frames?: AxFrames): boolean | 'mixed' | null
```

Правила:
- `agent-dom.ts`: `treeOf` отдаёт `{ nodes, frames }`. Фреймы — обход `Page.getFrameTree` в глубину до `frameDepth`, не больше `frames` штук; на каждый — `DOM.getFrameOwner { frameId }` и `Accessibility.getFullAXTree { frameId }` параллельно; отказ любой из двух команд — фрейма нет в карте.
- `axSnapshot` и `walk`: у узла роли фрейма с `backendDOMNodeId` из карты обход продолжается с корня дерева фрейма на глубине на одну больше; корень `RootWebArea` фрейма своей строки не даёт. Карты узлов и `seen` — свои на каждое дерево: `nodeId` разных деревьев совпадают.
- Фрейм без дерева: строка `iframe` получает хвост ` (content not available: another site)`.
- Ссылки фрейма попадают в общую карту ссылок; предел `limitBytes` общий.

- [ ] **Шаг 1. Тесты `ax-snapshot.test.ts`:**
  - дерево с одним фреймом из карты: под строкой `[ref=e2] iframe "Pay"` — строки фрейма с отступом на уровень глубже; кнопка фрейма получает ссылку; строки `document` фрейма нет;
  - фрейм во фрейме — два уровня отступа;
  - фрейма нет в карте → `[ref=e2] iframe "Pay" (content not available: another site)`;
  - `interactiveOnly` — контролы фрейма в списке;
  - поле `API key` со значением во фрейме → `value=<redacted>`, дочерний текст не обходится;
  - предел байт срабатывает внутри фрейма: `truncated: true`, ссылок за пределом нет;
  - одинаковые `nodeId` в двух деревьях не путаются;
  - `axHasText` находит текст фрейма; `axState` находит флажок фрейма.
- [ ] **Шаг 2. Тесты `agent-dom.test.ts`:** два дочерних фрейма → две пары команд с их `frameId`; отказ `DOM.getFrameOwner` у одного — в карте один; 25 фреймов — запрошено 20; глубина 4 — четвёртый уровень не запрошен; `nodeOf` отдаёт `backendNodeId` ссылки из фрейма; `waitFor` находит текст фрейма.
- [ ] **Шаг 3. Реализация.**
- [ ] **Шаг 4. Проверка.**
- [ ] **Шаг 5. Коммит:** `feat(desktop): include frames of the same process in the agent snapshot`

---

### Task 2.3: Сквозной сценарий, навык и CHANGELOG этапа 2

**Files:**
- Modify: `packages/desktop/e2e/browser-agent-control.spec.ts`, `core/work/parley-browser-skill.ts` и его тест, `CHANGELOG.md`

- [ ] **Шаг 1. Сценарий «форма во фрейме»:** страница с `<iframe>` того же origin, в нём поле и кнопка; снимок показывает их со ссылками под строкой `iframe`; `type` и `click` по этим ссылкам меняют страницу фрейма (проверка через `guestEval` по `frames[0]`).
- [ ] **Шаг 2. Сценарий «чужой фрейм»:** фрейм с другого сайта → в снимке строка с `(content not available: another site)`; клик по `x`, `y` внутри фрейма доходит до его кнопки.
- [ ] **Шаг 3. Навык,** раздел Input details, одна строка: ``- Elements inside an `iframe` of the same site have refs like any other. A frame marked `content not available: another site` has none: take a `browser_screenshot` and click inside it by `x`, `y`.``
- [ ] **Шаг 4. `CHANGELOG.md`,** Unreleased → Added: `- Built-in browser, agents: the snapshot now includes the content of frames of the same site, with refs that actions can target.`
- [ ] **Шаг 5. Проверка.**
- [ ] **Шаг 6. Коммит:** `test(desktop): cover frames in the agent snapshot end to end`

## Not verified

- Изолированный мир, деревья и координаты фреймов у гостя `<webview>` — до задачи 0 предположения; задачи 1.3 и 2.2 от них зависят.
- Интерфейсы сняты чтением `origin/master` 196850cf; сборка и тесты не запускались.
- Гоняет ли CI сценарии Electron — не выяснял; если нет, их запускает ведущий по слову человека.
- Экономия токенов от шагов не измеряется: сценарий 3.3 считает только число вызовов.
