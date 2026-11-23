# План: отвечать на вопросы терминала в Chat (спайк и слой 1)

> **Исполнителю:** прочитай «Global Constraints» и «Решения, принятые при планировании», затем только свою задачу. Шаги — флажки `- [ ]`, иди по порядку. Чужих файлов не трогай; если задача без них не делается, остановись и напиши ведущему.

**Goal:** Когда агент ждёт человека в терминале, в Chat видно сам вопрос с экрана терминала и на него можно ответить клавишами и текстом, не переключая вкладку.

**Architecture:** Хост отдаёт окну нижние строки безголового терминала сессии новым запросом `pty.screenText`. Окно в виде Chat показывает их в панели на месте строки «…is waiting in the terminal» и шлёт нажатия существующим уведомлением `pty.input`. Панель одинакова для всех агентов. Карточки с кнопками для узнанных вопросов Codex (слой 2) — следующий этап: его задачи пишутся после спайка, поправкой плана.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes: true`), zod, `@xterm/headless` (уже в хосте), React 18, Tailwind 4, vitest 2.

**Spec:** `docs/specs/2026-11-18-chat-terminal-prompts-design.md`. В именах, файлах и границах задач верен план; в поведении — спека.

**База:** свежий `origin/master` на момент старта (после слияния pull request браузера, если они уже влиты). Факты сверены с 196850cf (v0.37.1); номера строк — ориентир, искать по имени. Короткие пути: `host/…` — от `packages/host/src/`, `protocol/…` — от `packages/protocol/src/`, `renderer/…` и `shared/…` — от `packages/desktop/src/`.

## Ход исполнения

| Задача | Состояние |
|---|---|
| 0 (спайк) | |
| 1 → 2 → 3 → 4 | |
| Слой 2 | задачи — поправкой после спайка |

## Поправка 1 — после спайка (2026-11-18)

Отчёт: `docs/research/2026-11-18-codex-terminal-prompts-spike.md` (коммиты 939d5f85, 516a7424). Где текст задач ниже расходится с этим разделом, верен этот раздел.

- **Вопрос не всегда внизу экрана.** На пустом экране (доверие хукам, доверие папке, начало сессии) он стоит вверху, а низ пуст. Поэтому окно запрашивает **весь видимый экран**, а пустое начало и хвост срезает само.
- **Задача 1:** в запросе `pty.screenText` поле `rows` необязательное, целое от 1 до 200; без него хост отдаёт весь видимый экран (`PtyManager.screenText(ref)` без второго аргумента). Тесты: без `rows` — `screenText` вызван без числа строк; `rows: 0` и `rows: 201` отвергнуты.
- **Задача 2:** константы `PROMPT_ROWS_ASKED` нет — запрос идёт без `rows`. `PROMPT_ROWS_SHOWN = 20`: блок одобрения занимает 14–15 строк и растёт с длиной команды. `promptLines(lines, max = PROMPT_ROWS_SHOWN)` срезает пустое начало и хвост и берёт последние `max` строк. `<pre>` ограничен по высоте, прокручивается внутри и после каждого обновления стоит на последней строке.
- **Что известно о клавишах Codex** (для текста подсказок и для слоя 2): цифра и буква в скобках у варианта срабатывают одним нажатием, без Enter; стрелки двигают метку `›`; Esc на одобрении правки прерывает ход. Свободный ответ на вопрос — это пункт «None of the above», затем Tab, текст, Enter.
- **Экраны доверия хукам и папке** не ставят заголовок `Action Required`: Parley узнаёт о них только от сторожа старта через 20 с, тогда и появится панель (нужда `startup`).
- **Auto-review на стенде до человека вопросы не доводит.** Вопросы, которые автор видит при Auto-review, — скорее вопросы режима Plan и экраны старта.

## Решения, принятые при планировании

| Вопрос | Решение |
|---|---|
| Чтение экрана | Запрос `pty.screenText { ref, rows }` → `{ lines: string[] }`, обёртка над `PtyManager.screenText`. `rows` от 1 до 40. Сессии нет — пустой список |
| Обновление | Окно опрашивает запрос раз в 400 мс, только пока панель видна и вкладка активна; сразу после каждого нажатия — внеочередной запрос через 80 мс |
| Запись | Только существующий `pty.input`. Текст из поля уходит как есть, затем через 80 мс — `\r` отдельным сообщением: Codex принимает быстрый текст с Enter за вставку и не отправляет его (та же причина, что у `CODEX_SUBMIT_DELAY_MS` в `host/pty/send.ts`) |
| Сколько строк | Запрашивается 24, показываются до 16 последних непустых (пустой хвост и пустое начало срезаны). Спайк может поправить числа |
| Когда панель | Там же, где сегодня `WaitingBanner` в `ChatView` (`showBanner`), и ещё при нужде вида `startup`. Хост без метода `pty.screenText` — прежний `WaitingBanner` |
| Заголовок панели | `needReason(need, now, имя провайдера)` из core, когда нужда известна; иначе прежний текст баннера (общий, Qwen, OpenCode) |
| Клавиши с клавиатуры | Панель — фокусируемый блок. В фокусе: стрелки, Enter, Esc, Tab, Backspace, пробел и печатные знаки уходят в терминал; сочетания с ⌘ не перехватываются |
| Текст экрана в журналах | Не пишется нигде: ни хост, ни окно не логируют строки |
| Остров | Запись Codex без карточки ведёт в Chat сессии (кнопка «Open in Parley»), когда хост знает `pty.screenText` |
| Сквозной сценарий | Пишется, не запускается исполнителем |

## Global Constraints

- Правила исполнителей — `docs/plans/2026-11-10-review-fixes/executor-rules.md`: vitest не запускать, приложение Parley не стартовать, `pnpm install` не звать. Исключение — задача 0. Шаг «Проверка» — команды раздела «Checks» правил для изменённых пакетов в порядке protocol → core → host → desktop и `pnpm exec eslint <изменённые файлы>`.
- В строке `Co-Authored-By` — модель, которая писала коммит. Правка после возврата — новым коммитом, без `--amend`.
- Тексты окна — по-английски, только из `S` (`shared/strings.ts`); комментарии и названия тестов — по-русски.
- Список методов хоста закреплён тестами (`host/methods/index.test.ts` и соседние): новый метод добавляется во все списки, которые они сверяют.
- Строки экрана — данные терминала: в окне рисуются только текстом (никакого `dangerouslySetInnerHTML`), в журнал не идут.
- Новые пропсы существующих компонентов — необязательные, с прежним поведением по умолчанию.
- Тесты окна: без jest-dom, `cleanup` вручную; сторы сбрасываются в `beforeEach`.
- Один коммит на задачу, заголовок — из последнего шага. Push и pull request — по слову человека.

## Review Focus

1. **Клавиши не уходят, когда панели нет.** Фокус потерян, сессия перестала ждать, вкладка неактивна — ни одного `pty.input` от панели. Тесты — задача 2.
2. **Старый хост.** Нет `pty.screenText` — прежний баннер, без ошибок в консоли. Тесты — задачи 2 и 3.
3. **Быстрый текст и Enter.** Текст и `\r` уходят двумя сообщениями с паузой; пустой текст шлёт только `\r`. Тест — задача 2.
4. **Экран не течёт.** Строки не попадают в журнал хоста и в `console` окна. Проверка чтением — задачи 1 и 2.
5. **Опрос останавливается.** Панель скрыта или размонтирована — запросов нет, таймер снят. Тест — задача 2.

## Порядок исполнения

| Шаг | Задачи | После |
|---|---|---|
| A | 0 ∥ 1 | Ведущий читает отчёт спайка: правит числа строк и пишет поправку плана с задачами слоя 2 |
| B | 2 → 3 → 4 | Проверки, ревью ветки старшей моделью, PR по слову человека |

---

### Task 0: Спайк — вопросы Codex 0.166.0 на экране терминала

**Files:**
- Create: `docs/research/2026-11-18-codex-terminal-prompts-spike.md`, `packages/core/src/feed/codex/__fixtures__/prompts/*.txt` (образцы экранов)
- Скрипты — в scratchpad сессии, в репозиторий не входят.

**Стенд.** Свой скрипт Node: `node-pty` запускает `codex`, поток идёт в `@xterm/headless` (оба пакета — из `node_modules` рабочей копии, как в `host/src/pty/screen.ts`), экран снимается строками так же, как `Screen.text`. Parley не запускается.

**Настройки Codex.** Отдельный временный каталог `CODEX_HOME` в scratchpad. В него копируется только файл входа из личного каталога Codex (без него модель не ответит) и ничего больше; личный каталог не меняется, временный стирается в конце. Каждый запуск тратит лимит Codex: сценарии — короткие, по одному ходу.

**Вопросы (каждый — замером; образец экрана — файлом):**
1. Одобрение команды: режим `-a on-request`, песочница `read-only`, просьба выполнить команду с записью. Строки экрана, варианты, какой выбран, какие клавиши принимает (цифры, стрелки, Enter, Esc, буквы).
2. Одобрение правки файла (`apply_patch`) — то же.
3. Вопрос агента с вариантами (`request_user_input`): попросить модель задать уточняющий вопрос своим инструментом вопросов. Экран, клавиши, как выглядит вариант «свой ответ».
4. Вопрос со свободным вводом — то же; как вводится текст и чем отправляется.
5. Режим Auto-review (`-c approvals_reviewer="auto_review"`): те же сценарии 1–2. Доходит ли вопрос до человека, когда и с каким экраном.
6. Доверие хукам: запуск с `-c hooks.…` (как собирает `packages/core/src/work/codex-hooks.ts`) — экран, блокирует ли он ход.
7. Что видит Parley на каждом экране: заголовок окна (OSC 0/2), уведомление OSC 9 — сырой поток сохранить и выписать последовательности.
8. Где на экране стоит вопрос и сколько строк он занимает при 80×24 и 120×40.

Не воспроизводится за разумное время (запрос MCP, предложение сменить модель, лимит) — так и записать, без догадок.

- [ ] **Шаг 1.** Стенд и временный `CODEX_HOME`.
- [ ] **Шаг 2.** Прогнать вопросы 1–8; на каждый экран — файл образца `<имя>-<cols>x<rows>.txt` (только строки экрана; секретов и личных путей в образцах нет — пути заменить на `/work/project`).
- [ ] **Шаг 3.** Отчёт: вопрос — замер — вывод; таблица «экран → клавиши → сигнал Parley»; отдельной строкой — годятся ли 24 запрошенные и 16 показанных строк.
- [ ] **Шаг 4. Уборка:** временный `CODEX_HOME` и скрипты стёрты; в отчёте — строка об этом.
- [ ] **Шаг 5. Коммит:** `docs(research): record Codex terminal prompts on screen`

---

### Task 1: Запрос хоста `pty.screenText`

**Files:**
- Modify: `protocol/methods.ts`, `host/methods/pty.ts`, `host/methods/index.ts`; тесты `host/methods/pty.test.ts`, `host/methods/index.test.ts`, тесты протокола, сверяющие список методов (найти по `'pty.send'`)

**Interfaces — Produces:**

```ts
// protocol/methods.ts
'pty.screenText': z.strictObject({ ref: sessionRef, rows: z.number().int().min(1).max(40) })   // запрос
'pty.screenText': { lines: string[] }                                                           // ответ
// host/methods/pty.ts
PtyHandlers.ptyScreenText: Handler<'pty.screenText'>
```

Обработчик: `{ lines: deps.pty.screenText(ref, rows) ?? [] }`. Ничего не логирует. Метод входит в список методов, который хост объявляет клиентам (`hello`), — рядом с `'pty.send'`.

- [ ] **Шаг 1. Тесты:** живая сессия с подставным экраном → `lines` равны тому, что отдал `screenText`, вызванный с теми же `ref` и `rows`; сессии нет → `{ lines: [] }`; `rows: 0` и `rows: 41` отвергнуты схемой; метод есть в списке методов хоста; журнал хоста после вызова не содержит строк экрана.
- [ ] **Шаг 2. Реализация.**
- [ ] **Шаг 3. Проверка** (protocol, host, desktop).
- [ ] **Шаг 4. Коммит:** `feat(host): return the visible terminal lines of a session`

---

### Task 2: Панель «вопрос терминала» в Chat

**Files:**
- Create: `renderer/chat/TerminalPromptPanel.tsx`, `renderer/chat/terminal-prompt.ts` и их тесты
- Modify: `renderer/chat/ChatView.tsx`, `shared/strings.ts`; тест `ChatView` рядом с проверками `chat-waiting-banner`

**Interfaces:**
- Consumes: запрос `pty.screenText` (задача 1); `bridge.call`, `bridge.notify('pty.input', { ref, data })`; `useHostSupports` (`renderer/lib/capabilities.ts`); `needReason` из `@parley/core`.
- Produces:

```ts
// renderer/chat/terminal-prompt.ts
export const PROMPT_ROWS_ASKED = 24;
export const PROMPT_ROWS_SHOWN = 16;
export const PROMPT_POLL_MS = 400;
export const PROMPT_AFTER_KEY_MS = 80;
/** Последние непустые строки: пустой хвост и пустое начало срезаны, не больше `max`. */
export function promptLines(lines: readonly string[], max?: number): string[];
/** Байты для терминала по нажатию; null — клавиша не наша (сочетание с ⌘, одиночный модификатор, F-клавиши). */
export function keyData(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): string | null;

// renderer/chat/TerminalPromptPanel.tsx
export interface TerminalPromptPanelProps {
  workKey: string; tabId: string; sessionRef: SessionRef; bridge: ParleyBridge;
  /** Заголовок: причина ожидания. */
  title: string;
  /** Панель видна и вкладка активна: только тогда идёт опрос. */
  active: boolean;
}
export function TerminalPromptPanel(props: TerminalPromptPanelProps): JSX.Element;   // data-testid="chat-terminal-prompt"
```

`keyData`: `ArrowUp` `\x1b[A`, `ArrowDown` `\x1b[B`, `ArrowRight` `\x1b[C`, `ArrowLeft` `\x1b[D`, `Enter` `\r`, `Escape` `\x1b`, `Tab` `\t`, `Backspace` `\x7f`, пробел и любой одиночный печатный знак — сам знак; `metaKey` или `ctrlKey` или `altKey` → `null`.

Строки — блок `S.chat.terminalPrompt`:

```ts
terminalPrompt: {
  keysHint: 'Keys go to the terminal',
  focusHint: 'Click here to answer with the keyboard',
  typeAnswer: 'Type an answer',
  send: 'Send',
  empty: 'The terminal shows nothing yet',
  up: 'Up', down: 'Down', enter: 'Enter', escape: 'Esc',
  open: 'Open terminal',
},
```

Поведение:
- **Опрос.** При `active` — `bridge.call('pty.screenText', { ref, rows: PROMPT_ROWS_ASKED })` сразу и каждые `PROMPT_POLL_MS`; после нажатия — ещё раз через `PROMPT_AFTER_KEY_MS`. Отказ запроса — прошлые строки остаются, повтор по расписанию. При `active: false` и при размонтировании таймеры сняты, ответы опоздавших запросов отбрасываются.
- **Экран.** `<pre>` с `promptLines(lines)`, моноширинный, `overflow-x-auto`, `aria-live="polite"`; строк нет — `S.chat.terminalPrompt.empty`.
- **Клавиши.** Корень панели — `tabIndex={0}`, `role="group"`. `onKeyDown`: `keyData(event)` не `null` → `preventDefault`, `stopPropagation`, `pty.input`. Нажатия внутри поля «Type an answer» панель не перехватывает. В фокусе — подпись `keysHint`, без фокуса — `focusHint`.
- **Кнопки** ↑ ↓ Enter Esc шлют те же байты, что клавиши.
- **Поле.** Отправка (кнопка `Send` или Enter в поле): непустой текст → `pty.input` с текстом, через `PROMPT_AFTER_KEY_MS` — `pty.input` с `\r`; пустой — только `\r`. Поле очищается.
- **«Open terminal»** — как в `WaitingBanner` (`updateTab(…, { view: 'terminal' })`).

`ChatView`: условие показа — прежнее `showBanner` или нужда вида `startup`; при `useHostSupports('pty.screenText')` рисуется `TerminalPromptPanel` с заголовком по «Решениям», иначе прежний `WaitingBanner` с прежними текстами.

- [ ] **Шаг 1. Тесты `terminal-prompt.test.ts`:** `promptLines(['', 'a', '', 'b', '', ''])` → `['a', '', 'b']`; 30 непустых строк и `max` 16 → последние 16; все пустые → `[]`; `keyData` — таблица выше, включая `{ key: 'a', metaKey: true }` → `null`, `{ key: 'Shift' }` → `null`, `{ key: 'F5' }` → `null`, `{ key: '1' }` → `'1'`.
- [ ] **Шаг 2. Тесты `TerminalPromptPanel.test.tsx`** (подставной мост, фальшивые таймеры):
  - при `active` первый запрос сразу, второй через 400 мс; строки ответа видны в `<pre>`;
  - `active: false` — запросов нет; смена на `false` снимает таймер; размонтирование — тоже;
  - нажатие `ArrowDown` на панели в фокусе → `notify('pty.input', { ref, data: '\x1b[B' })` и внеочередной запрос через 80 мс;
  - нажатие с `metaKey` → `notify` не вызван, `preventDefault` не вызван;
  - клик по кнопке Enter → `data: '\r'`;
  - поле: текст `yes please`, отправка → два `notify`: `'yes please'`, затем через 80 мс `'\r'`; пустое поле → один `'\r'`;
  - нажатие клавиши внутри поля не даёт `pty.input` до отправки;
  - отказ запроса не роняет панель, прошлые строки на месте;
  - в `console` ничего не пишется (шпион на `console.log`, `console.warn`, `console.error`).
- [ ] **Шаг 3. Тест `ChatView`:** хост с методом — при ожидании виден `chat-terminal-prompt`, баннера нет; хост без метода — виден прежний `chat-waiting-banner`; ждущая карточка в ленте — нет ни того, ни другого; нужда `startup` показывает панель.
- [ ] **Шаг 4. Реализация.** Карточка панели в 800×500 помещается: экран прокручивается внутри, кнопки не уезжают.
- [ ] **Шаг 5. Проверка.**
- [ ] **Шаг 6. Коммит:** `feat(desktop): answer a terminal prompt from the Chat view`

---

### Task 3: Остров ведёт в Chat

**Files:**
- Modify: `renderer/island/requests.ts`, `renderer/island/IslandView.tsx` (и то место, где остров открывает сессию, если вид вкладки выбирается там), их тесты

Сегодня запись Codex без карточки собирается с `inWindow: false` (`requests.ts`, ветка `session.provider === 'codex'`), и кнопка подписана «Open terminal». Нужно: когда хост знает `pty.screenText`, такая запись получает `inWindow: true`, кнопка — «Open in Parley», а переход открывает сессию в виде Chat. Без метода — как сегодня.

- [ ] **Шаг 1. Тесты:** хост с методом → запись Codex без карточки имеет `inWindow: true`, кнопка с текстом `S.island.openInParley`; хост без метода → прежние `inWindow: false` и `S.island.openTerminal`; запись с карточкой не меняется; переход для записи без карточки не переключает вкладку в терминал.
- [ ] **Шаг 2. Реализация.** Найти, что делает `api.open({ kind: 'session', ref })` с видом вкладки, и добиться вида Chat для этой записи наименьшей правкой.
- [ ] **Шаг 3. Проверка.**
- [ ] **Шаг 4. Коммит:** `feat(desktop): open the Chat view from an island entry that waits in the terminal`

---

### Task 4: Сквозной сценарий, CHANGELOG, документы

**Files:**
- Modify: `packages/desktop/e2e/codex-chat.spec.ts` (или соседний сценарий Chat с заглушкой агента — выбрать тот, где уже есть ожидание в терминале), `CHANGELOG.md`
- Add to git: `docs/specs/2026-11-18-chat-terminal-prompts-design.md`, `docs/plans/2026-11-18-chat-terminal-prompts-plan.md` (копии из основной рабочей копии)

- [ ] **Шаг 1. Сценарий** (пишется, не запускается): заглушка агента печатает вопрос с тремя вариантами и ждёт клавишу; в Chat виден `chat-terminal-prompt` с текстом вопроса; клик по Enter доходит до заглушки (она печатает подтверждение, оно появляется в панели или панель исчезает); текст из поля доходит до заглушки целиком.
- [ ] **Шаг 2. `CHANGELOG.md`,** Unreleased → Added: `- Chat: when an agent waits at a prompt in its terminal, the prompt is shown in Chat and you can answer it there with keys or text, without opening the terminal. Works for Codex, Claude Code, Qwen Code and OpenCode.`
- [ ] **Шаг 3. Проверка:** typecheck файла сценария, eslint по всем изменённым файлам ветки.
- [ ] **Шаг 4. Коммит:** `test(desktop): cover answering a terminal prompt from Chat`

---

## Слой 2 — после спайка

Задачи пишет ведущий поправкой плана, когда есть образцы экранов: функция распознавания в core с образцами спайка; служба хоста, которая заводит карточку `permission` или `question` по экрану и отвечает на неё клавишами со сверкой экрана; состояние «Answered in the terminal»; проверка карточек на острове, в Telegram и на телефоне.

## Not verified

- Вид вопросов Codex и клавиши — до задачи 0 предположения; числа строк панели могут измениться.
- Интерфейсы сняты чтением кода 196850cf; сборка и тесты не запускались.
- Что делает переход острова с видом вкладки — исполнитель задачи 3 выясняет по коду.
