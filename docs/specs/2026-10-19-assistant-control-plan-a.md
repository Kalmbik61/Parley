# Управление через помощника — план этапа A: права помощника и напоминания

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** помощник на острове умеет предлагать создание комнаты, решение по запросу агента (разрешение, вопрос, план), решение по комнате (принять или вернуть ведущему) и ставить себе напоминания «проверь через N минут»; каждое предложение — карточка с кнопками, которую подтверждает человек; напоминание держит хост и само начинает ход помощника.

**Architecture:** карточка помощника (`AssistantProposal`) получает поле `action` с четырьмя видами и общими полями `target`/`where`/`text`, чтобы старый остров рисовал любую карточку как письмо. Хост (`host/src/assistant/assistant-service.ts`) добавляет инструменты `propose_room`, `propose_decision`, `propose_room_decision` и подтверждает их через уже существующие функции `createHumanRoom`, `FeedService.decide`, `resolveRoomProposal`. Сводка запроса агента считается чистой функцией в core (`cardGist`), её же берёт окно для уведомлений. Напоминания — модуль хоста `reminders.ts` с файлом в `~/.parley/assistant/`, срабатывание — обычный `ask` с `origin: 'reminder'`. Остров (`renderer/island/assistant/`) рисует карточки по `action`, показывает «Done ✓» и раскрывается на ответ напоминания. Telegram в этом этапе не трогается.

**Tech Stack:** TypeScript strict + `exactOptionalPropertyTypes`, zod (protocol), vitest (+ jsdom у desktop), React 18, zustand, Playwright `_electron` со стабом `e2e/stub-assistant-agent.mjs`.

**Spec:** `docs/specs/2026-10-19-assistant-control-telegram-design.md` — разделы 2 (решения 2, 3, 4, 14, 17, 18, 19), 3 (что сейчас), 5 (карточки и инструменты), 6 (остров), 7 (напоминания), 13 (проверки). Код — `master` 8e06f0c3; номера строк ниже оттуда.

## Global Constraints

- Тексты UI только по-английски и только в `packages/desktop/src/shared/strings.ts`; тексты, которые хост отдаёт модели и в поля карточки (`summary`, `text` карточек, ошибки инструментов), — по-английски прямо в коде хоста, как сейчас (`'S03 is closed'`); комментарии, тесты, документы — по-русски.
- Статусы сессий — только из `@parley/core/session-state` (`sessionDotState`, `stateWord`); свой расчёт состояния — дефект.
- Parley пишет только в свои каталоги: напоминания — `~/.parley/assistant/reminders.json` (`assistantCwd(home)` из core, рядом с `sent.jsonl`), права 0600, атомарная запись (временный файл + `rename`).
- Помощник ничего не делает сам: любое изменение Parley — через карточку и `assistant.decide` (решение 2). Напоминание только начинает ход; ход может предложить карточку, но не нажать её.
- Никаких `secrets.json`, `ANTHROPIC_AUTH_TOKEN`, `--dangerously-*`; `CLAUDECODE` не трогать; новых зависимостей нет.
- Совместимость: новое окно со старым хостом — карточка без `action` читается как письмо; старое окно с новым хостом — любая карточка несёт `target`, `where`, `text` и рисуется как письмо, её Send делает то же, что новая кнопка (это тоже подтверждение человека).
- eslint: нет игнора `_x`, `prefer-const`, плагина react-hooks нет; `LC_ALL=C` для тестов; E2E 800×500 с длинными именами; собранное приложение локально не запускать.
- Коммит на задачу, сообщение по-английски (правило репозитория `AGENTS.md`), подпись `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; исполнители не запускают vitest/tsc/eslint/сборку и не коммитят — проверки и коммит делает ведущий после волны.

## Решения этого плана (нет в спеке, человек может поправить)

- **Общие поля у всех карточек.** Вместо объявления поддержки клиентом (спека 5.1 оставляла способ строителю) каждая карточка несёт `target`, `where`, `text`: у `room` — `target` = название комнаты, `text` = «Create room "Auth" with S02 Ruslan, S04 Igor (lead S02 Ruslan)» и задача второй строкой; у `decision` — `target` = сессия, `text` = `summary` и `detail`; у `room-decision` — `target` = комната, `text` = текст решения. Старый остров показывает это как письмо и работает.
- **Сводка карточки — структурой из core, а словами — на месте.** `cardGist` в core возвращает `{ kind: 'run', command } | { kind: 'tool', tool, path } | { kind: 'fetch', url } | { kind: 'tool', tool, path: null } | { kind: 'question', text } | { kind: 'plan' }`; окно формулирует её строками `S.notifications.ask*` (как сейчас), хост — своими английскими строками (`Bash: rm -rf dist`, `Edit src/a.ts`, `Fetch https://…`, `Question: …`, `Plan`). Так правило «UI-тексты в strings.ts» не нарушается и хост не зависит от desktop.
- **Ждущие карточки в обзоре** берутся из `feed.snapshot(ref, undefined, 'attention')` только для сессий в состоянии `blocked` (их немного), один запрос на сессию на вызов `parley_overview`.
- **Ответ напоминания** открывает вид помощника без захвата клавиатуры (`keyboard(false)` остаётся), далее обычное удержание и сворачивание острова.
- **Разрешение «always»** предлагается только при непустых `suggestions` карточки; иначе хост молча делает разовое `allow` и говорит об этом модели в ответе инструмента.

## Review Focus

1. Карточка ленты была отвечена в окне или терминале, пока карточка помощника ждала: `feed.decide` вернёт `applied: false` — исход `cancelled` с системной строкой `already answered`, остров показывает «Already answered». Тест — Task 6.
2. Участник комнаты закрылся между `propose_room` и подтверждением: `createHumanRoom` бросит `bad_request` — `decide` возвращает `{ applied: false, error }`, карточка остаётся, текст ошибки виден. Тест — Task 5.
3. Напоминание созрело, пока идёт ход: срабатывает после конца хода, а не перебивает его; созрело, пока хост был выключен: срабатывает один раз при старте с пометкой `late`. Тест — Task 7.
4. Ведущий переделал решение (`rev` вырос), пока карточка `room-decision` ждала: `resolveRoomProposal` бросает `ProposalConflictError` → исход `cancelled` с системной строкой `the lead revised the decision`, остров показывает «Revised, look again». Тест — Task 5.
5. Старый остров получил карточку `room`: рисует её как письмо по `target`/`where`/`text`, Send зовёт `assistant.decide('send')` и создаёт комнату. Тест — Task 9 (вид без `action` в пропсах) и Task 2 (поля обязательны в типе).

---

### Task 1: `cardGist` и `cardDetail` в core; окно берёт сводку оттуда

**Files:**
- Create: `packages/core/src/feed/card-gist.ts`, `packages/core/src/feed/card-gist.test.ts`
- Modify: `packages/core/src/index.ts` (экспорт `cardGist`, `cardDetail`, `pendingCards`, тип `CardGist`), `packages/desktop/src/renderer/attention/ask-summary.ts:33-57` (`askSummary` и `pendingCards` через core)
- Test: `packages/desktop/src/renderer/attention/ask-summary.test.ts` (остаётся зелёным без правок ожиданий)

**Interfaces:**
- Produces:
  ```ts
  export type CardGist =
    | { kind: 'run'; command: string }            // первая непустая строка команды; argv Codex склеен пробелом
    | { kind: 'tool'; tool: string; path: string | null } // path — относительно проекта, из file_path | notebook_path | path
    | { kind: 'fetch'; url: string }
    | { kind: 'question'; text: string }           // первая строка первого вопроса
    | { kind: 'plan' };
  export function cardGist(card: FeedCard, projectPath: string): CardGist;
  /** Что человек должен увидеть, чтобы решить: команда или правка целиком, вопрос с вариантами, план; обрезка по max с «…». */
  export function cardDetail(card: FeedCard, max = 1500): string | null;
  export function pendingCards(items: readonly FeedItem[]): FeedCard[];   // state === 'pending', по порядку ленты
  ```
- Consumes: `FeedCard`, `FeedItem`, `FeedPermissionCard.toolInput`, `FeedQuestionCard.questions[].options[].label`, `FeedPlanCard.plan` из `core/src/feed/types.ts:154-208`. Логика `shownPath`/`firstLine` — из `ask-summary.ts:23-31`, переносится в core.

- [ ] **Step 1: Падающие тесты** `card-gist.test.ts`: permission `Bash` с `command: 'rm -rf dist\n# second'` → `{ kind: 'run', command: 'rm -rf dist' }`; Codex argv `['git','status']` → `run 'git status'`; `Edit` с `file_path: '/p/src/a.ts'` и `projectPath: '/p'` → `{ kind: 'tool', tool: 'Edit', path: 'src/a.ts' }`; `WebFetch` с `url` → `fetch`; `Read` без путей → `{ kind: 'tool', tool: 'Read', path: null }`; question → первая строка; plan → `plan`. `cardDetail`: permission с `command` → команда целиком; `Edit` с `old_string`/`new_string` → `old_string` и `new_string` через `\n→\n`; question → `Q: текст` и варианты `- label` по строке; plan → первые 1500 знаков с «…»; длиннее `max` — обрезано, заканчивается «…». `pendingCards` отфильтровывает `allowed`.
- [ ] **Step 2: Реализация** `card-gist.ts`; `ask-summary.ts`: `askSummary` = `switch (cardGist(card, projectPath).kind)` → те же `S.notifications.ask*` (`askRun`, `askTool`, `askFetch`, `askQuestion`, `askPlan`, у `tool` без пути — `card.toolName`); `pendingCards` реэкспорт из core; локальные `firstLine`, `shownPath`, `isCard` удалить.
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/core exec vitest run src/feed/card-gist.test.ts` и `LC_ALL=C pnpm --dir packages/desktop exec vitest run src/renderer/attention/ask-summary.test.ts`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(core): cardGist and cardDetail — structured summary of a pending feed card`.

---

### Task 2: Протокол — виды карточки, `outcome: 'done'`, `origin`

**Files:**
- Modify: `packages/protocol/src/assistant.ts:18-51`
- Test: `packages/protocol/src/assistant.test.ts` (создать, если нет; проверка типов через `expectTypeOf` и разбор схем)

**Interfaces:**
- Produces:
  ```ts
  export interface ProposalCardView { cardId: string; kind: 'permission' | 'question' | 'plan'; summary: string; detail: string | null }
  export interface RoomProposalView { proposalId: string; rev: number; kind: 'decision' | 'completion'; from: string; text: string; planId?: string; planRev?: number }
  interface ProposalBase { id: string; target: string; where: string; text: string }
  export type AssistantProposal =
    | (ProposalBase & { action?: 'message'; kind: 'note' | 'question' | 'decision' | null; mentions?: string[]; wake: boolean })
    | (ProposalBase & { action: 'room'; title: string; members: string[]; lead: string; task: string | null })
    | (ProposalBase & { action: 'decision'; card: ProposalCardView; decision: FeedDecision })
    | (ProposalBase & { action: 'room-decision'; proposal: RoomProposalView; choice: 'accept' | 'return'; note: string | null });
  export type AssistantOrigin = 'island' | 'reminder';
  // AssistantState: outcome: 'sent' | 'done' | 'cancelled' | null; origin?: AssistantOrigin (старый хост не шлёт = island)
  ```
  `FeedDecision` — из `@parley/core` (`protocol/src/types.ts:70` уже реэкспортирует тип). У письма `action` необязателен и равен `'message'`: старый хост поля не шлёт, новый шлёт всегда.
- Схемы методов не меняются (`assistant.decide` по-прежнему `{ proposalId, decision: 'send' | 'cancel' }`).

- [ ] **Step 1: Падающие тесты** — `expectTypeOf<AssistantProposal>()` допускает четыре объекта из примеров спеки 5.1 и не допускает `room` без `text`; `AssistantState` принимает `outcome: 'done'` и `origin: 'reminder'`.
- [ ] **Step 2: Реализация** типов с комментариями по-русски (что несёт каждое поле; почему `target`/`where`/`text` общие — решение плана).
- [ ] **Step 3 (ведущий): PASS** — `pnpm --dir packages/protocol exec vitest run src/assistant.test.ts`, `pnpm --dir packages/protocol exec tsc --noEmit`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(protocol): assistant proposal actions — room, decision, room-decision; outcome done; origin`.

---

### Task 3: Инструменты в `parley-mcp` и промпт

**Files:**
- Modify: `packages/core/src/mcp/assistant.ts:15-53` (`ASSISTANT_TOOLS`), `packages/core/src/assistant/launch.ts:86-103` (`assistantPrompt`)
- Test: `packages/core/src/mcp/assistant.test.ts`, `packages/core/src/assistant/launch.test.ts`

**Interfaces:**
- Produces в `ASSISTANT_TOOLS` (имена и схемы — точно):
  - `propose_room` — `{ work: string, title: string, members: string[], lead?: string, task?: string }`, required `work`, `title`, `members`; описание: работа — id `work:…` из обзора или точное название, участники — id или имена сессий этой работы, задача — первое письмо в комнату; «Nothing is created: the person sees a card and confirms».
  - `propose_decision` — `{ target: TARGET, decision: { kind: 'permission', behavior: 'allow' | 'deny', always?: true } | { kind: 'question', answers: Record<string,string> } | { kind: 'plan', choice: 'auto-accept' | 'manual' } }` (в JSON Schema — `oneOf` по `kind`); описание: только для сессии, которая ждёт человека; `always` — только если карточка сама предложила «don't ask again»; у плана оба выбора одобряют (`manual` — каждая правка отдельной карточкой).
  - `propose_room_decision` — `{ target: TARGET, choice: 'accept' | 'return', note?: string }`; описание: решение или завершение, которое ведущий комнаты ждёт от человека; `note` — заметка ведущему при `return`.
  - `schedule_check` — `{ in_minutes?: number, at?: string, every_minutes?: number, what: string }`, required `what`; описание: «Ask Parley to wake you later to check something; say the time back to the person. This is not a card.»
  - `list_reminders` — `{}`; `cancel_reminder` — `{ id: string }` («`*` cancels all»).
  - `annotations: { readOnlyHint: true }` у `list_reminders`.
- `assistantPrompt`: строка «You cannot approve agent requests, start or stop sessions, or create rooms…» заменяется абзацем правил: разрешения, вопросы и планы — только `propose_decision` (слова «разреши», «запрети», «allow», «deny» — повод для карточки, `cardId` не выдумывать; у плана оба выбора одобряют); комнаты — `propose_room` (участники из этой работы); решения ведущего — `propose_room_decision`; «проверь через…», «напомни» — `schedule_check`, назвать время ответа; запуск и остановка сессий недоступны. Строки `[reminder …]` в начале вопроса — просьба человека, сделанная раньше: проверить и доложить коротко.

- [ ] **Step 1: Падающие тесты** — `ASSISTANT_TOOLS.map(t => t.name)` = `['parley_overview','parley_detail','propose_message','propose_room','propose_decision','propose_room_decision','schedule_check','list_reminders','cancel_reminder','end_conversation']`; у `propose_decision.inputSchema.properties.decision.oneOf` три ветки по `kind`; `schedule_check` требует только `what`; `assistantPrompt('ru')` содержит `propose_decision`, `propose_room`, `propose_room_decision`, `schedule_check` и не содержит «cannot approve agent requests»; сервер (`createAssistantServer` с фейковым `fetch`) принимает `propose_room` и шлёт POST на `/propose_room`.
- [ ] **Step 2: Реализация.**
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/core exec vitest run src/mcp/assistant.test.ts src/assistant/launch.test.ts`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(core): assistant tools for rooms, decisions and reminders; prompt rules`.

---

### Task 4: Обзор — работы как цели, ждущие карточки и решения комнат

**Files:**
- Modify: `packages/host/src/assistant/overview.ts` (`AssistantTarget`, `OverviewSource`, `targetsOf`, `resolveTarget`, `sessionLine`, `overviewText`, `detailText`)
- Test: `packages/host/src/assistant/overview.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AssistantTarget =
    | { kind: 'work'; id: string; projectPath: string; workId: string; name: string; where: string }   // id `work:<projectKey>:<workId>`
    | { kind: 'room'; … }      // как сейчас
    | { kind: 'session'; … };  // как сейчас
  export interface OverviewSource {
    entries: readonly WorkEntry[];
    live(ref: SessionRef): SessionLive | undefined;
    /** Ждущие карточки сессии, если сервис их уже достал; нет функции или `undefined` — строка `waits:` без карточки. */
    cards?(ref: SessionRef): readonly FeedCard[] | undefined;
  }
  export function cardLine(card: FeedCard, projectPath: string): string;  // `permission — Bash: rm -rf dist (card c12)` / `question — <первая строка> (card …)` / `plan — N lines (card …)` через cardGist
  ```
- Текст обзора: строка работы — `Work "Parley" [work:ab12cd:w-0003] (project my_harnas)`; у сессии в `blocked` после `waiting for: …` добавляется `waits: <cardLine>` для каждой ждущей карточки (до 3); у комнаты со слотом `proposal` — `, waits: decision from S01 Ruslan (p-03, rev 1): <первые 200 знаков>` (`completion` — `completion from …`). `resolveTarget` находит работу по id и по точному названию (как комнаты).
- `detailText` комнаты показывает решение целиком до 1500 знаков строкой `Decision from S01 Ruslan (p-03, rev 1): …`.

- [ ] **Step 1: Падающие тесты** — `targetsOf` отдаёт `work:` цели первыми в каждой работе; `resolveTarget(targets, 'Parley')` → работа, когда название уникально; `overviewText` с `cards: () => [permissionCard]` у `blocked`-сессии содержит `waits: permission — Bash: rm -rf dist (card c12)`; без `cards` — строка `waiting for:` как раньше; комната с `proposal` → `waits: decision from S01`; `detailText` комнаты с решением содержит `Decision from`.
- [ ] **Step 2: Реализация** (чистые функции; `cardGist`/`cardDetail` из core, Task 1).
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/host exec vitest run src/assistant/overview.test.ts`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(host): assistant overview — works as targets, pending cards and room decisions`.

---

### Task 5: Сервис помощника — `propose_room` и `propose_room_decision`

**Files:**
- Modify: `packages/host/src/assistant/assistant-service.ts` (`AssistantServiceDeps`, `Pending`, `detailOf`, `propose*`, `decide`, `settle`, `tool`), `packages/host/src/assistant/assistant-endpoint.ts:17` (`ASSISTANT_TOOL_NAMES`), `packages/host/src/host.ts:420-440` (deps)
- Test: `packages/host/src/assistant/assistant-service.test.ts`, `packages/host/src/assistant/assistant-endpoint.test.ts`

**Interfaces:**
- Consumes: `createHumanRoom(input: Params<'rooms.create'>): Promise<string>` и `resolveRoomProposal(input: Params<'rooms.resolveProposal'>): Promise<string>` из `host/src/rooms/rooms-service.ts:98, 236` (ошибки — `HostError` с `code` `bad_request`/`conflict`, текст по-английски); `sendHumanLetter` уже в deps; `Proposal` из `core/src/work/types.ts:219`; типы Task 2; цели Task 4.
- Produces (deps): `createRoom(input: Params<'rooms.create'>): Promise<string>`; `resolveRoomProposal(input: Params<'rooms.resolveProposal'>): Promise<string>`. В `host.ts`: `createRoom: (input) => createHumanRoom(input)`, `resolveRoomProposal: (input) => resolveRoomProposal(input)`.
- `Pending` становится объединением по `view.action`; `settle(current, outcome: 'sent' | 'done' | 'cancelled', reason?: string)` пишет `outcomeNote = '[system: proposal <id> was <outcome>' + (reason ? ': ' + reason : '') + ']'`.
- `tool('propose_room', input)`: `work` через `resolveTarget` (только `kind: 'work'`, иначе 404 «… is not a work»); `title` 1–80 знаков после `trim`; `members` — сессии этой работы через `resolveTarget` среди её `session`-целей, `lifecycle !== 'closed'`, без повторов, минимум одна; `lead` — одна из них, иначе первая; `task` — `trim`, до 4000, пусто → `null`. Карточка: `action: 'room'`, `target: title`, `where`, `text: 'Create room "<title>" with <имена через запятую> (lead <имя>)' + (task ? '\n' + task : '')`, `title`, `members: имена`, `lead: имя`, `task`. Ответ модели — как у `propose_message`. Ошибки — 400/404 с текстом.
- `decide(id, 'send')` для `room`: `createRoom({ projectPath, workId, title, members: [ids], lead: id })` → при `task` `sendLetter({ projectPath, workId, roomId, to: [], text: task, kind: 'note' })` → `settle(current, 'done', 'room "<title>" created')`. Ошибка → `{ applied: false, error: message }`, карточка остаётся.
- `tool('propose_room_decision', input)`: `target` — комната; слот `room.proposal` из `deps.works.snapshot()`; `null` → 409 «<room> has no decision waiting»; `choice` ∈ `accept | return`; `note` до 4000, при `accept` игнорируется. Карточка: `action: 'room-decision'`, `target: room.name`, `where`, `text: proposal.text`, `proposal: { proposalId: id, rev, kind: kind ?? 'decision', from: participantLabel(map, from), text, planId?, planRev? }`, `choice`, `note`.
- `decide` для `room-decision`: `resolveRoomProposal({ projectPath, workId, roomId, proposalId, action: choice, note: note ?? undefined, rev, planId, planRev })` → `settle(current, 'done')`; ошибка с `code === 'conflict'` (так `asHostError` переводит `ProposalConflictError` — проверить в `rooms-service.ts`/`host-error`) → `settle(current, 'cancelled', 'the lead revised the decision')` и `{ applied: true, error: 'The lead revised the decision — look again' }`; иные ошибки → `{ applied: false, error }`.
- `detailOf`: `propose_room` и `propose_room_decision` → `{ tool: 'propose', target: null }`.
- `propose` (письмо) теперь ставит `action: 'message'` явно: новый хост шлёт поле всегда.
- `ASSISTANT_TOOL_NAMES` — все десять имён (как в Task 3).

- [ ] **Step 1: Падающие тесты** (фикстуры `MAP`/`deps` из `assistant-service.test.ts:12-58`, добавить в `MAP` вторую сессию и комнату с `proposal`):
  - `propose_room` с работой по имени и участниками `['S03', 'S02']` → `state.proposal.action === 'room'`, `text` начинается с `Create room "Auth" with`, `members` — имена, `lead` — первый; `decide('send')` зовёт `createRoom` с id сессий и `lead`, затем `sendLetter` с `task`, исход `done`, `outcomeNote` содержит `room "Auth" created` (виден в `prompt` следующего хода).
  - `propose_room` с участником из другой работы → 404, карточки нет; с закрытым участником → 409.
  - Review Focus 2: `createRoom` бросает `Error('S02 is closed')` → `decide` вернул `{ applied: false, error: 'S02 is closed' }`, `state.proposal` на месте.
  - `propose_room_decision('Auth', 'return', 'add tests')` → карточка `room-decision` с `proposal.rev` из карты и `note`; `decide('send')` зовёт `resolveRoomProposal` с `action: 'return'`, `note`, `rev`; исход `done`.
  - Review Focus 4: `resolveRoomProposal` бросает `HostError('conflict', …)` → исход `cancelled`, `outcomeNote` содержит `revised`, `decide` вернул `error` «look again».
  - Комната без слота → 409 `has no decision waiting`.
  - Эндпойнт: `POST /assistant/propose_room` с токеном доходит до `service.tool('propose_room', …)`.
- [ ] **Step 2: Реализация** (структура `propose*` как у `propose`, общие проверки вынести в маленькие функции; `host.ts` — две строки deps).
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/host exec vitest run src/assistant/`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(host): assistant proposes rooms and room decisions through cards`.

---

### Task 6: Сервис помощника — `propose_decision` и ждущие карточки в обзоре

**Files:**
- Modify: `packages/host/src/assistant/assistant-service.ts` (deps `feed: Pick<FeedService, 'snapshot' | 'decide'>`, `tool('parley_overview')`, `propose_decision`, `decide`), `packages/host/src/host.ts` (deps `feed: feedService` уже передан целиком — проверить тип)
- Test: `packages/host/src/assistant/assistant-service.test.ts`

**Interfaces:**
- Consumes: `FeedService.snapshot(ref, undefined, 'attention')` → `{ items, decisions? }` (`feed-service.ts:159-162`), `FeedService.decide(ref, cardId, decision): Promise<{ applied: boolean; state: FeedCardState }>`; `pendingCards`, `cardGist`, `cardDetail` (Task 1); `cardLine` (Task 4); `FeedDecision` из core.
- `parley_overview`: перед `overviewText` сервис собирает карты ждущих карточек для сессий, у которых `sessionDotState(...) === 'blocked'`: `Promise.all` по `feed.snapshot(ref, undefined, 'attention')`, ошибки → без карточек; отдаёт `overviewText({ ...src, cards: (ref) => map.get(key(ref)) })`. Сессии не `blocked` не опрашиваются.
- `tool('propose_decision', input)`: `target` — сессия; `decision` разбирается по `kind` (zod-схема `feedDecision` из `@parley/protocol` — переиспользовать `feedDecision.safeParse`); `snapshot(ref, undefined, 'attention')`; если `decisions === 'terminal'` → 409 «<name> answers at your Mac only»; карточки нужного `kind` среди `pendingCards(items)`: 0 → 409 «<name> is not waiting for a <kind>»; >1 → 409 со списком `cardId — summary` («say which one»); `always: true` при пустых `suggestions` → снимается, в ответе модели «(always is not offered for this request, proposed a one-time allow)». Карточка: `action: 'decision'`, `target: name`, `where`, `card: { cardId, kind, summary: hostSummary(cardGist(card, projectPath)), detail: cardDetail(card) }`, `decision`, `text: summary + (detail ? '\n' + detail : '')`. `hostSummary`: `run` → `Bash: <command>` (имя инструмента карточки, не буквально Bash), `tool` → `<tool> <path>` / `<tool>`, `fetch` → `Fetch <url>`, `question` → `Question: <text>`, `plan` → `Plan`.
- `decide` для `decision`: `feed.decide(ref, cardId, decision)` → `applied: true` → `settle(current, 'done')`; `applied: false` → `settle(current, 'cancelled', 'already answered')` и `{ applied: true, error: 'Already answered' }` (Review Focus 1); исключение → `{ applied: false, error }`.
- `detailOf('propose_decision')` → `{ tool: 'propose', target: null }`.

- [ ] **Step 1: Падающие тесты** — фейковый `feed` с `snapshot` по `ref` и `decide` со счётчиком: `parley_overview` вызывает `snapshot` только для `blocked` сессии и текст содержит `waits: permission — Bash: rm -rf dist`; `propose_decision('S03', { kind: 'permission', behavior: 'allow' })` → карточка с `card.summary === 'Bash: rm -rf dist'`, `text` содержит детали; `decide('send')` зовёт `feed.decide` с `cardId` и решением, исход `done`; `always: true` без `suggestions` → карточка с `allow` без `always` и ответ инструмента упоминает `one-time`; две ждущие карточки → 409 со списком; `decisions: 'terminal'` → 409; Review Focus 1: `decide` вернул `{ applied: false, state: 'allowed' }` → исход `cancelled`, `outcomeNote` содержит `already answered`.
- [ ] **Step 2: Реализация.**
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/host exec vitest run src/assistant/`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(host): assistant proposes decisions on pending agent requests`.

---

### Task 7: Напоминания в хосте

**Files:**
- Create: `packages/host/src/assistant/reminders.ts`, `packages/host/src/assistant/reminders.test.ts`
- Modify: `packages/host/src/assistant/assistant-service.ts` (deps `reminders`, инструменты `schedule_check`/`list_reminders`/`cancel_reminder`, `origin` в `AssistantState`, запуск хода по напоминанию), `packages/host/src/host.ts` (создание и остановка модуля)
- Test: `packages/host/src/assistant/assistant-service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Reminder { id: string; what: string; at: string; every: number | null; createdAt: string; askedAt: string }
  export const REMINDERS_MAX = 10;        // активных
  export const REMINDER_HORIZON_MS = 24 * 60 * 60_000;
  export interface ReminderStore {
    add(input: { what: string; inMinutes?: number; at?: string; everyMinutes?: number; now: number }): Reminder | { error: string };
    list(): Reminder[];
    cancel(id: string): number;            // '*' — все; возвращает, сколько снято
    start(onDue: (reminder: Reminder, late: boolean) => Promise<'fired' | 'skipped'>): void; // таймер до ближайшего; просроченные при старте — по одному, late=true
    stop(): void;
  }
  export function createReminderStore(deps: { home: string; now?(): number; log(line: string): void }): ReminderStore;
  ```
  Файл `<assistantCwd(home)>/reminders.json` — `{ version: 1, reminders: Reminder[] }`, 0600, атомарно; читается при `start`, пишется при каждом изменении. Валидация `add`: `inMinutes` 1…1440 или `at` в будущем и не дальше 24 ч, ровно одно из двух; `everyMinutes` 5…1440; `what` 1…500; больше `REMINDERS_MAX` активных → `{ error: 'Too many reminders (10 at most)' }`. Повторяющееся после срабатывания получает `at = at + every`, пока `at − createdAt ≤ 24 ч`, иначе удаляется после срабатывания с пометкой `last` (в тексте хода).
- Сервис: `schedule_check` → `reminders.add(...)` → ответ модели `Scheduled r3 for 14:07 (in 5 minutes)` (время в локали системы `Intl.DateTimeFormat` `HH:mm`); `list_reminders` → строки `r3 — 14:07 — every 10 min — check the release room`; `cancel_reminder` → `Cancelled N reminder(s)`. Срабатывание: `onDue` → если `turn !== null` — ждать конца хода (обещание, которое `finish` разрешает), затем `ask({ text: '[reminder ' + id + ', asked at ' + askedAt + (late ? ', late' : '') + (last ? ', last check' : '') + '] Check: ' + what, provider: last.provider, model: last.model, language: last.language })`, где `last` — параметры последнего `ask` человека, а без них — `{ provider: null, model: null, language: 'en' }`; состояние хода публикуется с `origin: 'reminder'`; человеческий `ask` публикует `origin: 'island'`. `onDue` возвращает `'skipped'`, если помощник не может ходить (нет готового провайдера) — тогда напоминание остаётся на следующий тик (повторяющееся) или удаляется (разовое) с записью в лог. (Поведение «помощник выключен» — зеркало настроек — появится в этапе B; здесь выключенность = `offline`.)
- `AssistantService` получает метод `onReminder(reminder: Reminder, late: boolean): Promise<'fired' | 'skipped'>` (то, что хост отдаёт в `reminders.start`), а `AssistantServiceDeps` — `reminders: Pick<ReminderStore, 'add' | 'list' | 'cancel'>`.
- `host.ts`: `const reminders = createReminderStore({ home, log })`; `assistantService` получает `reminders`; после создания сервиса `reminders.start((reminder, late) => assistantService.onReminder(reminder, late))`; `onShutdown(() => reminders.stop())`.

- [ ] **Step 1: Падающие тесты** `reminders.test.ts` (с `mkdtemp`, фейковым `now` и `vi.useFakeTimers()`): `add` разовое через 5 мин → `at` = now+5 мин, файл записан 0600; `add` одиннадцатое → ошибка; `add` с `at` в прошлом → ошибка; `start` с просроченным напоминанием в файле зовёт `onDue(…, true)` один раз и удаляет его (Review Focus 3б); повторяющееся каждые 10 мин — после `onDue` `at` сдвинут, после 24 ч удалено; `cancel('*')` → все сняты, файл пуст. В `assistant-service.test.ts`: `schedule_check` → ответ содержит `Scheduled r1`; срабатывание во время хода (`turns[0]` не завершён) не запускает второй `run`, после `end` запускается ход с `prompt`, начинающимся с `[reminder r1`, и `last().origin === 'reminder'` (Review Focus 3а); человеческий вопрос после — `origin: 'island'`.
- [ ] **Step 2: Реализация.**
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/host exec vitest run src/assistant/`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(host): assistant reminders — schedule_check, list and cancel, fired by the host`.

---

### Task 8: Строки и стор острова

**Files:**
- Modify: `packages/desktop/src/shared/strings.ts` (блок `assistant`), `packages/desktop/src/renderer/island/assistant/store.ts` (`applyHost`), `packages/desktop/src/renderer/island/assistant/labels.ts` (без изменений, если `statusLabel` не трогается)
- Test: `packages/desktop/src/renderer/island/assistant/store.test.ts`

**Interfaces:**
- Строки (`S.assistant`): `done: 'Done ✓'`, `alreadyAnswered: 'Already answered'`, `revised: 'Revised, look again'`, `card: { newRoom: 'New room in', roomLine: (title: string, members: string, lead: string) => `${title} · ${members} · lead ${lead}`, create: 'Create', allow: 'Allow', allowAlways: "Allow, don't ask again", deny: 'Deny', answer: 'Answer', acceptPlan: 'Accept plan', approveEachEdit: 'Approve each edit', acceptDecision: (room: string) => `Accept decision in ${room}?`, returnDecision: (lead: string) => `Return to ${lead} for rework?`, accept: 'Accept', return: 'Return', askTitle: (verb: string, name: string) => `${verb} ${name}?` }`, `miniCard: 'Card'`.
- Стор: `applyHost` — если `host.origin === 'reminder'`, ход новый (`host.turn !== previous.turn`) и `!state.open` → `set({ open: true, collapsed: false, byHover: false })` без `deps.keyboard(true)` (решение плана); `outcome === 'done'` обрабатывается как `sent` для `cardError` сброса. `assistantBusy` без изменений (`awaiting-confirm` уже занятость).

- [ ] **Step 1: Падающие тесты** — `applyHost({ ...HOST_IDLE, origin: 'reminder', turn: 1, phase: 'answering', answer: 'Room is fine' })` при закрытом помощнике → `open === true`, `keyboard` не вызывался; тот же ход с `origin: 'island'` при закрытом → остаётся закрытым; повторное состояние того же хода не открывает снова после `close()`.
- [ ] **Step 2: Реализация.**
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/desktop exec vitest run src/renderer/island/assistant/store.test.ts`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(island): strings for proposal cards; reminder answers open the assistant`.

---

### Task 9: Вид острова — карточки по `action`

**Files:**
- Modify: `packages/desktop/src/renderer/island/assistant/AssistantView.tsx:149-183` (карточка), `packages/desktop/src/renderer/island/assistant/labels.ts` (`miniLabel`: `awaiting-confirm` → `S.assistant.miniCard`, если `proposal.action` не `message`), `packages/desktop/src/renderer/island/IslandApp.tsx:369` (`pending` скрывается, когда карточка — `decision` по первой ждущей сессии)
- Test: `packages/desktop/src/renderer/island/assistant/AssistantView.test.tsx`, `labels.test.ts`, `IslandApp.test.tsx`

**Interfaces:**
- Рендер по `proposal.action ?? 'message'`:
  - `message` — как сейчас.
  - `room` — заголовок `S.assistant.card.newRoom` + `where`; строка `roomLine(title, members.join(', '), lead)`; `task` в блоке с левой полосой; кнопки `create` (`data-testid="assistant-send"`, остаётся тот же testid — Enter в пустом поле подтверждает) и `cancel`.
  - `decision` — заголовок `askTitle(verb, target)`, где `verb` по `decision`: `allow`/`deny` → `Allow`/`Deny`, `question` → `Answer`, `plan` → `Accept plan`/`Approve each edit`; под ним `card.summary` и `card.detail` в `<pre data-testid="assistant-card-detail">` с `max-h-40 overflow-auto` моноширинным; кнопка подтверждения с подписью по `decision` (`allowAlways` при `always`), `cancel`.
  - `room-decision` — заголовок `acceptDecision(target)` или `returnDecision(proposal.from)`; текст `proposal.text` (первые 1500) в блоке с прокруткой; `note` строкой «Note: …»; кнопки `accept`/`return` и `cancel`.
  - Исход: `outcome === 'done'` → `S.assistant.done` (`data-testid="assistant-done"`); `cardError` показывается как сейчас (туда приходят «Already answered» и «look again»).
  - Без `action` в пропсах (старый хост) — ветка `message`.
- `IslandApp`: `pending` → `null`, если `assistant.host.proposal?.action === 'decision'` и `proposal.target` совпадает с именем первой ждущей сессии (`labels.get(...)?.session`).

- [ ] **Step 1: Падающие тесты** (jsdom, `render(<AssistantView …/>)` как в `AssistantView.test.tsx`): карточка `room` показывает `New room in`, строку участников и кнопку `Create`; `decision` с `allow` + `always` показывает `Allow S03 Ruslan?`, `summary`, `detail` в `pre` и кнопку «Allow, don't ask again»; `plan manual` → кнопка «Approve each edit»; `room-decision return` → заголовок «Return to S01 Ruslan for rework?» и «Note: …»; `outcome: 'done'` → «Done ✓»; Review Focus 5: карточка `{ id, target, where, text, kind: null, wake: false }` без `action` рисуется как письмо с `Send`; `miniLabel` при `awaiting-confirm` и `action: 'room'` → `Card`; `IslandApp`: при карточке `decision` по `S03` строка `assistant-pending` не рисуется.
- [ ] **Step 2: Реализация.**
- [ ] **Step 3 (ведущий): PASS** — `LC_ALL=C pnpm --dir packages/desktop exec vitest run src/renderer/island/`.
- [ ] **Step 4 (ведущий): Коммит** — `feat(island): proposal cards for rooms, decisions and room decisions`.

---

### Task 10: E2E — комната и напоминание через помощника

**Files:**
- Modify: `packages/desktop/e2e/stub-assistant-agent.mjs:18-46`, `packages/desktop/e2e/assistant.spec.ts`

**Interfaces:**
- Стаб: промпт `^create room (.+)` → `propose_room({ work: <первая работа из обзора по id work:…>, title: $1, members: [<первая сессия>], task: 'Start with tests.' })` и текст «[[calm]] Prepared a room card.»; промпт `^check in 2 seconds` → `schedule_check({ at: new Date(Date.now() + 2000).toISOString(), what: 'the room' })` и текст «[[calm]] I will check in 2 seconds.»; промпт, начинающийся с `[reminder` → `parley_overview` и текст «[[joy]] Reminder: the room is fine.»; остальное — как сейчас. Id работы стаб берёт из обзора регулярным выражением `\[work:[^\]]+\]`.
- Спек: (1) «create room Release» → карточка с «New room in» и кнопкой Create → клик → «Done ✓» и в сайдбаре главного окна появляется комната «Release» (как проверяют существующие тесты комнат: `getByText('Release')`); (2) «check in 2 seconds» → ответ «I will check…» → закрыть остров Esc → в течение 10 с остров раскрывается сам с ответом «Reminder: the room is fine.» (`assistant-answer`), поле ввода без фокуса не проверяем.

- [ ] **Step 1: Тесты** по описанию (Playwright, `timeout: 30_000` на карточку и 10 с на напоминание).
- [ ] **Step 2: Стаб.**
- [ ] **Step 3 (ведущий): PASS** — `pnpm --dir packages/desktop build && pnpm --dir packages/desktop exec playwright test e2e/assistant.spec.ts` (на главном экране DPR 1, как остальные E2E острова).
- [ ] **Step 4 (ведущий): Коммит** — `test(e2e): assistant creates a room and fires a reminder`.

---

## Порядок и волны

| Волна | Задачи (параллельно, файлы не пересекаются) | Зависит от |
|---|---|---|
| 1 | Task 1 (core gist + ask-summary), Task 2 (protocol), Task 3 (core mcp + prompt) | — |
| 2 | Task 4 (overview), Task 8 (strings + store) | 1, 2 |
| 3 | Task 5 (service: rooms), Task 9 (AssistantView) | 2, 3, 4 / 2, 8 |
| 4 | Task 6 (service: decisions, cards в обзоре) | 1, 5 |
| 5 | Task 7 (reminders) | 6 |
| 6 | Task 10 (E2E) | все |

После каждой волны ведущий: `pnpm typecheck` и `pnpm lint` по затронутым пакетам, vitest по задачам, чтение дифа, коммит на задачу. Тесты host и desktop берут `@parley/core` и `@parley/protocol` из `dist` (алиасов в vitest нет): после правок core или protocol — сначала `pnpm --dir packages/core build` и `pnpm --dir packages/protocol build`. Полные прогоны (`pnpm test`, `pnpm build`) — после волны 5 и после волны 6.

## Вне плана

- Telegram целиком (этап B): модуль хоста, привязка, уведомления, `assistant.configure`, голос из Telegram.
- Переезд функций внимания (`sessionAttention`, `roomAwaitsDecision`, `humanUnreadLetters`) в core — этап B, там они нужны хосту для поводов.
- Этап C: запуск, остановка, архив сессий, роли в комнате.
- Правка текста на карточке; озвучивание новых карточек голосом (этап 3 помощника идёт отдельным планом; «Done» там читается по тому же `outcome`).
