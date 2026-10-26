# Хранилище работ, этап 2б: письма в своих таблицах — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** запись письма, отметка прочитанного, `check_inbox` и открытие комнаты стоят одинаково в работе на 100 и на 100 000 писем. После плана 3 карта лежит в SQLite, но письма — это строки `entries` внутри общей карты, и каждая запись сериализует, сравнивает и заново разбирает всю карту (замер плана 3: 41 мс на запись при 10 000 писем, 246 мс при 50 000).

**Architecture:** письма уходят из `WorkMap` в свои таблицы: `messages` (по строке на письмо, колонки канала, отправителя, времени), `message_reads` (кто и когда прочитал — нынешний `readBy`) и `message_unread` (кандидаты в непрочитанное). Правила прочитанного не меняются: кандидаты — надмножество, а окончательно письмо отбирают те же предикаты, что сейчас (`recipientsOf`, `cancelledPlanLetter`), на маленьком наборе кандидатов. Код работает с письмами через API `LetterTx` (внутри транзакции `updateMap` или новой `writeLetters`) и функции чтения (вне транзакции). Переход идёт в два шага: сначала API поверх нынешнего `map.messages` и перевод всех мест вызова без смены поведения (задачи 1–4), потом смена хранилища под API (задача 7). Тексты записанных экспортов и отправленных эффектов уходят из карты: остаются путь и sha256 (спека 6.2). Окно не меняется: снимок для окна собирается запросами в прежнем виде (спека 6.7).

**Tech Stack:** TypeScript, `node:sqlite` (`DatabaseSync`), pnpm-монорепо (`@parley/core`, `@parley/host`, `@parley/protocol`, `@parley/desktop`), vitest, Playwright.

**Spec:** `docs/specs/2026-10-23-host-sqlite-storage-design.md` — разделы 2, 4, 6.2, 6.6, 6.7, 7, 8. План 3 (`feat/sqlite-store`, PR без слияния) — основа: этот план продолжает его ветку, и оба вливаются вместе (решение автора 2026-10-24: план 3 отдельно не выпускать).

## Global Constraints

- Ветка `feat/sqlite-letters` от `origin/feat/sqlite-store` (55560048 или новее) в своём worktree: `git worktree add .claude/worktrees/sqlite-letters -b feat/sqlite-letters origin/feat/sqlite-store`, затем `pnpm install --prefer-offline`, `pnpm --filter "@parley/host^..." build`, `pnpm --filter @parley/file-icons build`. Первый коммит — этот план (`docs: add storage plan 4 (letters in their own tables)`).
- **Node ≥ 22.16.** Новых npm-зависимостей нет.
- Коммиты по-английски, с подписью Co-Authored-By той модели, которая их делает. Комментарии по-русски со ссылкой «спека хранилища N.M». Тексты агентам и окну — по-английски. Названия тестов — на языке блока `describe`.
- Тесты — только затронутых файлов: `pnpm --filter @parley/<pkg> exec vitest run <paths>`. Полный прогон и мутационные прогоны запрещены. Перед прогоном смотреть `uptime`; при load ≥ 12 ждать. Под нагрузкой флейкают `works-service.test.ts` и `sessions-service.test.ts` — упавший файл перезапустить в одиночку.
- Хост берёт `@parley/core` из `dist`: после правки ядра — `pnpm --filter @parley/core build`.
- Тесты, которые ломаются только из-за смены хранилища или сигнатур, переводит та задача, чья покрывающая команда их включает. Остальное — задача 9.
- **Тексты писем — контракт.** Окно и Telegram узнают решения и письма планов по тексту (`attention/derive.ts:118-124`, `telegram/notify.ts:58-64`, `components/rooms/plan-letter.ts`). Тексты писем этот план не меняет.
- Исполнители — Sonnet, задачи строго по одной, облегчённый режим проверок.
- **Решения этого плана** (спека оставила их строителю, раздел 8):
  - **Прочитанное — строки, а не курсор.** `message_reads(seq, reader, at)` хранит ровно нынешний `readBy`. Курсор не годится по двум причинам: окно показывает время прочтения у каждого получателя (`RoomMessage.tsx:202-214`), а у правил три части, которые не укладываются в «прочитал до N» (новичок комнаты, отменённое письмо плана, выборочные отметки человека). Отметка стоит одну строку на отмеченное письмо — пропорционально изменению.
  - **Непрочитанное — кандидаты плюс прежние правила.** `message_unread(reader, seq)` — надмножество непрочитанного; итог отбирают `recipientsOf` и `cancelledPlanLetter` на кандидатах, поэтому правила спеки 6.2 сохраняются один в один. Кандидаты появляются при записи письма (адресаты на этот момент и `human`) и при входе в комнату (все рассылки комнаты без отметки входящего — как сейчас новичок получает историю). Исчезают при отметке, выходе из комнаты, архиве (кроме `human`: человеку архивные письма по-прежнему непрочитанные), Reopen, удалении комнаты, удалении сессии и отмене эффекта плана.
  - **Счётчики не хранятся.** Число непрочитанного — `COUNT` по кандидатам читателя, итоги каналов — по индексу `messages(room, seq)`.
  - **Прямые письма** — канал с `room_id IS NULL`.
  - **Только письма — без разбора карты.** `writeLetters` пишет письма и отметки в транзакции без сравнения всей карты. Им пользуются `send_message`, `check_inbox`, `mail.markRead`, `rooms.send` и системные письма хоста. Мутации, которые меняют и письма, и состояние (`resolveProposal`, архив, удаление комнаты, планы), остаются в `updateMap` с `LetterTx` в той же транзакции.
  - **Черновики планов** (`plans.ts` `edit()`, `reservePlanEffects`) откатывают свои письма через `LetterTx.savepoint` — `SAVEPOINT` SQLite.
  - **Пустая запись не пишет.** `updateMap` и `writeLetters` без изменений не поднимают версию и не шлют `onMapWritten`; `check_inbox` без писем не трогает `work.updatedAt`.
  - **Страница — не больше 100 писем** (спека 6.2; было 500, `PAGE_MAX_ITEMS`). Бюджет байтов страницы прежний.
  - **Тексты экспортов** (`planExports`, `decisionExports`) после `written` хранятся как `file` + `sha256` + `bytes` + `title` (первая строка); пока `pending` — с текстом, как сейчас. **Текст отправленного или отменённого эффекта** заменяется на `textSha256`; принадлежность письма эффекту сверяется по sha256 текста письма.
  - **SQL — в главном потоке хоста**, запросы короткие и по индексам. Стенд задачи 10 это проверяет.
  - **Отложено:** события «новое письмо N в канале R» для окна и окно на страницах (план 5, фаза 3 спеки); работа, не прошедшая переезд, в списке с пометкой (спека 6.6, 7 — план 5, это окно); перевод CLI на хост (6.8) и отказ сессиям без канала (6.5); рабочий поток для SQL; асинхронное ожидание занятой базы.

## Review Focus

1. **Новичок длинной комнаты, выход и возвращение.** Вошедший получает непрочитанными все прежние рассылки комнаты, вышедший перестаёт их видеть, вернувшийся видит снова — как сейчас. Тест — задача 7.
2. **Письмо плана перестаёт быть актуальным.** Оно сразу пропадает из непрочитанного адресата (живое правило), а отметки других писем не страдают. Тест — задача 7.
3. **Человек и архив.** Человек выборочно отмечает письма архивной комнаты; счётчики окна по комнатам и по почте совпадают с прежними правилами (архив человеку считается). Тест — задача 7.
4. **Переезд карты формы w-0051** (3 795 писем, `readBy`, `deleted`, старая комната без `memberLog`, висячие `decisionExports.messageId`, записанные экспорты, отменённые эффекты): собранная из базы карта равна исходной после известного преобразования экспортов и эффектов, непрочитанное у каждой сессии и у человека совпадает. Тест — задача 8.
5. **Черновик плана упал после письма.** Письмо черновика не записано, остальная транзакция продолжается; два процесса пишут письма одновременно — номера уникальны, ни одно письмо не потеряно. Тесты — задачи 1 и 7.

---

### Task 1: API писем поверх нынешней карты

**Files:**
- Create: `packages/core/src/work/letter-store.ts`, `packages/core/src/work/letter-store.test.ts`
- Modify: `packages/core/src/work/store.ts` (`updateMap` отдаёт мутатору `LetterTx`; новая `writeLetters`; пустая запись без версии), `packages/core/src/index.ts`

**Interfaces:**
- Produces (`letter-store.ts`):

```ts
export interface NewLetter {
  roomId: string | null; from: string; to: string[]; text: string; kind: MessageKind;
  replyTo?: string; via?: MessageVia; readBy?: Record<string, string>; at?: string;
}
export interface LetterQuery {
  roomId?: string | null; from?: string; kind?: MessageKind; sinceAt?: string;
  ids?: readonly string[]; beforeSeq?: number; afterSeq?: number;
  limit: number; newestFirst?: boolean;
}
export interface LetterTx {
  add(letter: NewLetter): Message;                    // номер m-NN, как сейчас
  markRead(reader: string, ids: readonly string[], at: string): string[]; // readBy[reader] ??= at, вернуть отмеченные
  byId(id: string): Message | undefined;
  query(q: LetterQuery): Message[];
  count(q: Omit<LetterQuery, 'limit'>): number;
  unreadFor(reader: string): Message[];               // прежние правила letters.ts
  joined(roomId: string, reader: string): void;
  left(roomId: string, reader: string): void;
  archived(roomId: string): void;
  reopened(roomId: string, at: string): void;         // как rooms.ts:484-493
  deleteRoom(roomId: string): void;                   // письма комнаты и work.messageSeq, как rooms.ts:386-391
  flagDeleted(sessionId: string): void;               // как map.ts:176-180
  effectCancelled(messageId: string): void;
  savepoint<T>(fn: () => T): T;                       // откат писем и отметок, сделанных внутри fn
}
export function writeLetters<T>(projectPath: string, workId: string,
  fn: (letters: LetterTx, map: Readonly<WorkMap>) => T, options?: { touch?: boolean; lockTimeoutMs?: number }): T;
export function readLetters(projectPath: string, workId: string, q: LetterQuery): Message[];
export function letterById(projectPath: string, workId: string, id: string): Message | undefined;
export function unreadLetters(projectPath: string, workId: string, reader: string): Message[];
export function unreadCount(projectPath: string, workId: string, reader: string): { total: number; byRoom: Record<string, number> }; // ключ комнаты '' — прямые
export function channelStats(projectPath: string, workId: string): Record<string, { total: number; latestId: string | null }>;  // '' — прямые
```

- `updateMap(projectPath, workId, mutate: (map, letters: LetterTx) => void, options?)` — второй аргумент мутатора; старые мутаторы с одним аргументом компилируются без правок.
- В этой задаче `LetterTx` и функции чтения работают на `map.messages` текущей карты (внутри — тот же черновик, что у мутатора; снаружи — `readMap`). Поведение каждого метода — ровно нынешнего кода, на который он ссылается. `joined`, `left`, `archived`, `effectCancelled` здесь ничего не делают: непрочитанное считается из всех писем. Смысл они получат в задаче 7.

- [ ] **Step 1: Failing tests** (`letter-store.test.ts`, русские названия) — это контракт API, задача 7 прогонит его же на таблицах:
  - `add` выдаёт следующий `m-NN` и после `deleteRoom` не переиспользует номера (`work.messageSeq`);
  - `markRead` возвращает только впервые отмеченные и не трогает уже стоящее время;
  - `unreadFor` совпадает с `unreadFor(map, s)` из `letters.ts` на фикстурах: новичок комнаты, вышедший, архив, Reopen, отменённое письмо плана, явный `to` в комнате, прямое письмо человеку;
  - `reopened` ставит `readBy ??= at` текущим адресатам каждого письма комнаты;
  - `savepoint`: письмо и отметка внутри упавшего `fn` пропадают, транзакция продолжается;
  - `query` с `limit` и `newestFirst`, `count` с `sinceAt` и `from`;
  - `writeLetters` без изменений не меняет версию работы и не зовёт подписчиков `onMapWritten`; `updateMap`, мутатор которого ничего не изменил, — тоже.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/letter-store.test.ts` — падает.
- [ ] **Step 3:** реализовать; пустая запись определяется по `diff` строк и флагу «были записи писем».
- [ ] **Step 4:** тест и `src/work/store.test.ts` — зелёные; `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** — `feat(core): add a letters API inside and outside map transactions`.

### Task 2: Ядро пишет и читает письма через API

**Files:**
- Modify: `packages/core/src/work/` — `map.ts` (`addMessage`, `removeSession`, `nextMessageId` уходят за API), `rooms.ts`, `proposals.ts`, `plans.ts` (`edit()` → `savepoint`), `plan-effects.ts` (`reserve`: недавние письма PARLEY через `count`/`query`; принадлежность — через `byId`; отмена — `effectCancelled`), `decision-journal.ts`, `recipe-lead.ts`, `launch.ts`, `letters.ts` (`markHumanRead` → `writeLetters` + `markRead`), `resource-policy.ts`, `room-membership.ts`, `room-history.ts`, `thread.ts`, `brief.ts`; их тесты.
- Modify (механически): все места вызова изменённых функций в `packages/core/src/mcp/` и `packages/host/src/` (`rooms/rooms-service.ts`, `methods/rooms.ts`, `rooms/plan-effects.ts` и другие — по ошибкам сборки) передают `letters` из своего мутатора `updateMap`. Хост берёт ядро из `dist`: без этого он сломался бы во время работы до задачи 4.

**Interfaces:**
- Consumes: задача 1.
- Produces: функции, которые клали письма в `map.messages`, принимают `letters: LetterTx` следующим параметром после `map`. `setRoomMode` возвращает id добавленных писем — вместо позиционного `slice(before)` у вызывающих (`host/methods/rooms.ts:116-118`, `mcp/plan-tools.ts:312-322`, их переведут задачи 3 и 4). Вход в комнату и выход зовут `joined`/`left`, архив — `archived`, Reopen — `reopened`.
- Запросы внутри транзакции всегда ограничены (`limit`) или считают `count`: окно «последний час» для лимитов (`resource-policy.ts:359-377`, `plan-effects.ts:328`) берёт письма с `sinceAt`, и их число ограничено самими лимитами.
- Видимость письма для агента (`get_map {field: message}`) — предикат на одно письмо с тем же результатом, что `agentThreadOf(map, caller)`, без сортировки всех писем.

- [ ] **Step 1:** тесты модулей из списка остаются зелёными по смыслу; новые: `setRoomMode` возвращает id своей системной строки; `edit()` упал после письма — письма нет, отметок нет; видимость одного письма совпадает с `agentThreadOf` на фикстуре с комнатами и прямыми письмами.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/ src/mcp/`, `pnpm --filter @parley/core build`, `pnpm --filter @parley/host build` (её `tsc` ловит пропущенные места вызова), `pnpm --filter @parley/host exec vitest run src/rooms/ src/methods/` — зелёные.
- [ ] **Step 3: Commit** — `refactor(core): write and read letters through the letters API`.

### Task 3: Инструменты агентов и страницы через API

**Files:**
- Modify: `packages/core/src/mcp/tools.ts` (`send_message` и `check_inbox` → `writeLetters`; `create_room`, `add_to_room`; `get_map` страницы и одно письмо; `read_room`; `wait_for`), `packages/core/src/mcp/plan-tools.ts` (id вместо позиции), `packages/core/src/mcp/inbox-watch.ts`, `packages/core/src/work/context-pages.ts` (`messagePage`, `mapTopology`, `compactWorkMap` берут письма у читателя, а не из `map.messages`); их тесты.

**Interfaces:**
- Produces: `interface LetterReader` в `context-pages.ts` — то, что нужно страницам и снимку: `page(q: LetterQuery)`, `byIds(ids)`, `tail(roomId: string | null, n)`, `humanUnread(limit)`, `unreadCount(reader)`, `channelStats()`. Реализация для базы — над функциями задачи 1; для чистых тестов — над массивом писем. До задачи 7 читатель в `messagePage`, `mapTopology` и `compactWorkMap` — последний необязательный параметр: без него берётся массив `map.messages`, поэтому хост (задачи 4 и 5 передают читатель явно) между задачами не ломается. Задача 7 делает его обязательным.
- `PAGE_MAX_ITEMS = 100` (было 500). Курсоры `before:N`/`after:N` прежние.
- `check_inbox` без непрочитанного ничего не пишет; с письмами — `touch` как сейчас.
- Комментарий в `inbox-watch.ts:11,25` говорит, что `wait_for` отмечает прочитанным, а код этого не делает (`tools.ts:822-829`). Поправить комментарий, поведение не менять.
- Снимок окна (`compactWorkMap`) — тот же вид и те же бюджеты: по 100 последних писем на канал, до 200 непрочитанных человеком, цитируемые оригиналы, `compact.messages`/`compact.unread`.

- [ ] **Step 1: Failing tests:** страница никогда не отдаёт больше 100 писем; `check_inbox` с пустым ящиком не меняет версию работы и `updatedAt`; `set_room_mode` сообщает свою системную строку, даже если между записью и ответом в комнату пришло другое письмо; `compactWorkMap` через читатель над массивом даёт тот же результат, что прежняя функция, на фикстуре с архивной комнатой и длинными текстами.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/mcp/ src/work/context-pages.test.ts` — зелёный; `pnpm --filter @parley/core build`.
- [ ] **Step 3: Commit** — `refactor(core): serve agent tools and pages through the letters API`.

### Task 4: Хост через API

**Files:**
- Modify: `packages/host/src/rooms/rooms-service.ts` (письмо человека → `writeLetters`; создание комнаты, участник, ведущий, решение, архив, Reopen, удаление), `methods/rooms.ts` (id вместо позиции), `methods/mail.ts`, `methods/context-pages.ts` (страница и текст письма — запросом, без `readMap`), `methods/works.ts` (`requireWork` → `workExists`), `wake/wake-service.ts` (непрочитанное — `unreadLetters`; `resumeFailed`), `activity/activity-service.ts` (`unreadCount`), `stuck/stuck-service.ts`, `telegram/notify.ts`, `assistant/overview.ts`, `sessions/sessions-service.ts`, `consents/held-launches.ts`, `rooms/room-usage.ts`; их тесты.

**Interfaces:**
- Consumes: задачи 1–3.
- Системные письма хоста, которые не меняют состояние (`wake-service.ts:472`, `sessions-service.ts:369,651`, `held-launches.ts:51`), идут через `writeLetters`.
- Последнее письмо человека в комнате (`telegram/notify.ts:59`) — `readLetters({roomId, from: 'human', limit: 1, newestFirst: true})`. Непрочитанное человеком для Telegram — `unreadLetters(…, 'human')` с прежним фильтром упоминаний.

- [ ] **Step 1:** тесты затронутых файлов зелёные по смыслу; новые: `mail.markRead` не читает карту целиком (шпион на `readMap` — ноль вызовов); страница `context.messages` — тоже.
- [ ] **Step 2:** `pnpm --filter @parley/host exec vitest run src/rooms/ src/methods/ src/wake/ src/activity/ src/stuck/ src/telegram/ src/assistant/ src/sessions/ src/consents/` — зелёный.
- [ ] **Step 3: Commit** — `refactor(host): use the letters API for mail, rooms and wake-ups`.

### Task 5: Снимок окна по версии и дешёвая запись карты

**Files:**
- Modify: `packages/host/src/works/works-service.ts` (снимок каждой работы кэшируется по версии и бюджету), `packages/core/src/work/store.ts` (после коммита кэш берёт уже нормализованную карту, без повторного разбора строк; `loadStored` сортирует в SQL — `ORDER BY kind, ord`), `packages/core/src/work/map-rows.ts` (`rowsToMap` раскладывает строки за один проход), `parleyHome()` запоминается по снимку переменных окружения; их тесты.

**Interfaces:**
- Снимок работы пересобирается, только когда изменились её версия или бюджет (бюджет зависит от числа живых работ, `works-service.ts:72-79`). Остальное в `buildWindow` прежнее: потолок 5 МиБ, повтор без писем, `snapshot-too-large`.
- Кэш после записи: карта, которую вернул бы `readMap` сразу после коммита, — прежний инвариант «записавший видит то же, что другие».

- [ ] **Step 1: Failing tests:** запись в работу A не пересобирает снимок работы B (шпион на `compactWorkMap`); после `updateMap` `readMap` возвращает структурно ту же карту, что вернул бы свежий разбор строк; `parleyHome()` замечает смену `PARLEY_HOME`.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/store.test.ts src/work/map-rows.test.ts`, `pnpm --filter @parley/core build`, `pnpm --filter @parley/host exec vitest run src/works/` — зелёные.
- [ ] **Step 3: Commit** — `perf: rebuild a work's window snapshot only when its version changes`.

### Task 6: Тексты экспортов и эффектов — только в файле и в письме

**Files:**
- Modify: `packages/core/src/work/types.ts` (`PlanExportIntent`, `DecisionJournalIntent`, `PlanEffect`), `plan-snapshots.ts`, `decision-journal.ts`, `plan-effects.ts`, `map.ts` (валидаторы; старый вид — `written` с `content` — переводится при разборе), `migrate-to-db.ts` (сверка против преобразованной исходной карты), `packages/host/src/methods/journal.ts`, `packages/host/src/rooms/plan-effects.ts`; их тесты.

**Interfaces:**
- Produces: `export function compactStoredTexts(map: WorkMap): WorkMap` — `written`-экспорт: `content` убирается, добавляются `sha256`, `bytes`, `title` (первая непустая строка, как `firstLine` в `journal.ts:98-103`); эффект со статусом `sent` или `cancelled`: `text` → `textSha256`. Её же вызывает переезд перед сверкой.
- `capturePlanSnapshot` сравнивает новый текст с прежним по sha256: тот же — вернуть прежний, другой — `snapshot-conflict`, как сейчас. `flush*` подтверждает запись по `(file, sha256)` и тут же убирает текст. `classifyDecisionFile` и `snapshotSha256` берут готовый `sha256`.
- `planEffectOwnsLetter` сравнивает `sha256(letter.text)` с `textSha256`, если текста в эффекте нет.
- Окно и так получает `content: ''` (`context-pages.ts:426`) и смотрит только `status`; его код не меняется.

- [ ] **Step 1: Failing tests:** записанный экспорт без `content`, его `sha256` равен sha256 файла `.md`; повторная фиксация того же текста возвращает прежний экспорт, другого — `snapshot-conflict`; `classifyDecisionFile` различает `accepted` и `edited` по sha256; эффект после отправки хранит `textSha256`, и `cancelledPlanLetter` по-прежнему прячет его письмо; переезд карты с записанными экспортами проходит сверку.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/` и `pnpm --filter @parley/host exec vitest run src/methods/journal.test.ts src/rooms/` — зелёные.
- [ ] **Step 3: Commit** — `feat(core): keep written plan and decision texts only in their files`.

### Task 7: Письма в своих таблицах

**Files:**
- Modify: `packages/core/src/work/db.ts` (схема v2), `letter-store.ts` (реализация на таблицах вместо `map.messages`), `store.ts` и `map-rows.ts` (письма больше не строки `entries`; `readStoredMap`/`replaceStoredMap` собирают и раскладывают полную карту с письмами), `types.ts` (разделение типов), `map.ts` (проверка писем — при `add`, а не в `normalizeMap`), `packages/protocol/src/types.ts`, типы в `packages/desktop/src` (только переименование типа); тесты.

**Interfaces:**
- Схема v2 (`WORK_DB_SCHEMA_VERSION = 2`; `user_version` 1 → 2 — задача 8):

```sql
CREATE TABLE messages (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL,
  seq INTEGER NOT NULL, id TEXT NOT NULL,
  room_id TEXT, sender TEXT NOT NULL, recipients TEXT NOT NULL,
  at TEXT NOT NULL, kind TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  PRIMARY KEY (project_path, work_id, seq),
  FOREIGN KEY (project_path, work_id) REFERENCES works(project_path, id) ON DELETE CASCADE);
CREATE UNIQUE INDEX messages_id ON messages(project_path, work_id, id);
CREATE INDEX messages_channel ON messages(project_path, work_id, room_id, seq);
CREATE INDEX messages_at ON messages(project_path, work_id, at);
CREATE TABLE message_reads (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL, seq INTEGER NOT NULL,
  reader TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (project_path, work_id, seq, reader),
  FOREIGN KEY (project_path, work_id, seq) REFERENCES messages(project_path, work_id, seq) ON DELETE CASCADE);
CREATE TABLE message_unread (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL, reader TEXT NOT NULL,
  seq INTEGER NOT NULL, room_id TEXT,
  PRIMARY KEY (project_path, work_id, reader, seq),
  FOREIGN KEY (project_path, work_id, seq) REFERENCES messages(project_path, work_id, seq) ON DELETE CASCADE);
```

  `id` хранит номер как записан (`m-01`, `m-3795`), `seq` — его число; `recipients` — JSON `to`; `body` — JSON `{text, replyTo?, via?}`. `readBy` письма собирается из `message_reads` только для отдаваемых писем.
- Типы: `WorkMap` (хранимая карта) теряет `messages`. `WindowWorkMap = WorkMap & { messages: Message[]; compact?: … }` — снимок окна, страницы, разбор старой `map.json`, `readStoredMap`, выгрузка `parley-core work map`. Протокол (`WorksSnapshot`) и окно переходят на `WindowWorkMap`; код окна не меняется, кроме имени типа. Чистые предикаты (`isUnreadFor`, `recipientsOf`, `unreadFor(map, s)`, `isHumanUnread`) работают на `WindowWorkMap` — ими пользуются окно и сверка переезда.
- Кандидаты в непрочитанное (`message_unread`):
  - `add`: каждый адресат по `recipientsOf` на момент записи плюс `human`, если письмо от не-человека и это письмо комнаты или `to` содержит `human`; кому `readBy` задан сразу (системные строки) — строка в `message_reads`, а не кандидат;
  - `joined(room, reader)`: все рассылки комнаты (`to` пуст) без отметки `reader` и не от него; `left`: удалить кандидатов `reader` среди рассылок комнаты (письма с явным `to` по нынешним правилам остаются адресату и после выхода, `letters.ts:14-24`);
  - `archived(room)`: удалить кандидатов комнаты, кроме `human`; `reopened`: отметки текущим адресатам, их кандидаты удалить;
  - `markRead`: строка в `message_reads`, кандидат удалить; `effectCancelled(id)`: удалить кандидатов письма; `flagDeleted(s)`: `deleted = 1` у писем от `s` или с `s` в `recipients` (`json_each`), кандидатов `s` удалить;
  - чтение: кандидаты читателя, затем `isUnreadFor(message, reader, map)` на карте без писем — живые правила (`recipientsOf`, `cancelledPlanLetter`) решают окончательно; для `human` — `isHumanUnread` (`attention.ts:73-79`).
- Номер письма: `max(work.messageSeq ?? 0, MAX(seq)) + 1` внутри транзакции записи — уникален и при двух процессах.

- [ ] **Step 1:** контракт задачи 1 (`letter-store.test.ts`) прогнать на таблицах без изменений ожиданий. Новые тесты:
  - запись письма в работу с 5 000 писем меняет одну строку `messages` и по строке кандидата на адресата (`changes()`);
  - отметка удаляет кандидата и добавляет строку `message_reads`;
  - непрочитанное из базы равно `unreadFor(собранная карта, s)` на фикстурах Review Focus 1–3: новичок, вышедший и вернувшийся, архив и Reopen, письмо плана стало неактуальным, человек выборочно отмечает в архивной комнате, явный `to`;
  - два процесса (дочерний Node, как `store.test.ts:793-824`) пишут по 200 писем в одну работу — 400 разных номеров, ни одно не потеряно;
  - `readStoredMap` после `replaceStoredMap` возвращает структурно ту же полную карту с письмами и `readBy`.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/ src/mcp/`, `pnpm --filter @parley/core build`, `pnpm --filter @parley/protocol build`, `pnpm --filter @parley/host build`, `pnpm --filter @parley/host exec vitest run src/works/ src/methods/ src/rooms/ src/wake/`, `pnpm --filter @parley/desktop typecheck` — зелёные.
- [ ] **Step 3: Commit(s)** — `feat(core): store letters, reads and unread candidates in their own tables` (можно двумя: схема и реализация, затем типы).

### Task 8: Переезд в схему v2

**Files:**
- Modify: `packages/core/src/work/migrate-to-db.ts`, `packages/core/src/work/db.ts` (подъём `user_version` 1 → 2), их тесты.

**Interfaces:**
- Старая `map.json` переезжает сразу в v2: письма — в `messages`, `readBy` — в `message_reads`, кандидаты — по правилам задачи 7 на составе комнат в момент переезда; экспорты и эффекты — через `compactStoredTexts`.
- Сверка (спека 6.6): собранная из базы полная карта (`readStoredMap`) структурно равна `compactStoredTexts(разобранная map.json)`, и непрочитанное у каждой сессии и у человека совпадает (`unreadFor`/`unreadForHuman` на исходной карте против `unreadLetters` из базы). Не сошлось — `failed`, как в плане 3.
- База v1 (только у тех, кто запускал сборку плана 3: разработка и приёмка; план 3 не выпускается) поднимается до v2 при открытии одной транзакцией: каждая работа собирается из строк `entries` прежним `rowsToMap`, раскладывается в v2 и сверяется так же; строки писем из `entries` удаляются. Не сошлось — транзакция откатывается, хост не стартует с понятной ошибкой в журнале.

- [ ] **Step 1: Failing tests:** фикстура формы w-0051 (письма с `readBy`, `deleted`, старая комната без `memberLog`, висячие `decisionExports.messageId`, записанные экспорты, отменённые эффекты, прямые письма человеку) переезжает и проходит сверку; испорченная сверка — `failed`, файлы и база не тронуты; база v1 с письмами поднимается до v2, собранная карта равна прежней.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/migrate-to-db.test.ts src/work/db.test.ts src/work/store.test.ts`, `pnpm --filter @parley/core build`, `pnpm --filter @parley/host exec vitest run src/host-migrate.test.ts src/host.test.ts` — зелёные.
- [ ] **Step 3: Commit** — `feat(core): migrate maps and plan-3 databases to the letters schema`.

### Task 9: Остальные тесты и E2E

**Files:**
- Modify: тесты ядра, хоста и окна, которые после задачи 7 ещё читают `readMap(...).messages` или кладут письма в хранимую карту; `packages/desktop/e2e/stored-map.ts` и спеки, которые сеют письма (`room-actions`, `room-owner`, `parley-integration`, `archive`, `agent-plans`, `migration`).

**Interfaces:**
- Чтение писем в тестах — `readStoredMap` (полная карта) или `readLetters`; посев — `replaceStoredMap` с полной картой. Ожидания по смыслу не ослабляются.

- [ ] **Step 1:** перевести; прогнать файлы пакетов пачками по 2–3, не весь пакет.
- [ ] **Step 2:** `pnpm --filter @parley/desktop build`, затем E2E по одному файлу: `pnpm --filter @parley/desktop exec playwright test e2e/<file>`.
- [ ] **Step 3: Commit** — `test: read and seed letters through the database`.

### Task 10: Стенд, сводная проверка, приёмка

- [ ] **Step 1: Сборки, типы, страж рамки, линт** — `pnpm --filter @parley/file-icons build && pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host build && pnpm --filter @parley/desktop typecheck && pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`; eslint на изменённых файлах ветки.
- [ ] **Step 2: Тесты затронутых каталогов** — ядро `src/work/ src/mcp/ src/cli-work.test.ts`, хост `src/works/ src/methods/ src/rooms/ src/wake/ src/activity/ src/agent/ src/host-migrate.test.ts`.
- [ ] **Step 3: Стенд** (спека 7) — скрипт в scratchpad, не в репозитории: временный дом, работы на 100 / 1 000 / 10 000 / 100 000 писем по ~1 КБ в 10 комнатах с 7 участниками, посев одним `replaceStoredMap`. Для каждой — медиана из 20: запись письма (`writeLetters`), `check_inbox` с одним новым письмом, `unreadLetters` для 7 сессий, снимок окна работы (`compactWorkMap`), страница из 100 писем, первый `readMap` (промах); байты `parley.db` + `-wal` на письмо. Ожидание: от 1 000 до 100 000 время записи, отметки, `check_inbox` и страницы растёт не больше чем вдвое, байты на письмо не растут. Сравнить с замером плана 3 (41 мс на запись при 10 000). Цифры — в текст PR.
- [ ] **Step 4: Приёмка — делает человек**, на копии данных в отдельном доме, по рецепту плана 3 (`.omc/reviews/2026-10-24-sqlite-store-pr-and-acceptance.md`): все работы переехали, письма и непрочитанное совпадают; комната из трёх агентов обменивается письмами, `wait_for` просыпается; новый участник длинной комнаты получает историю непрочитанной; задержка цикла хоста p99 не хуже, чем на плане 3. Нагрузка спеки 7 (50 агентов в 10 комнатах) — только если автор захочет: она дорогая по токенам; без неё стенд шага 3 — главная проверка.
- [ ] **Step 5: Текст PR** — PR `feat/sqlite-letters` поверх `feat/sqlite-store`; вливаются вместе. Суть, решения плана, стенд, предупреждение для заметок к выпуску из плана 3 (переезд в `~/.parley/parley.db`, откат вручную через `map.v2.json` и `works-index.v2.json`).
