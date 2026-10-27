# Письма в окно событиями и страницами (`rooms.mail`) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** запись, которая меняет только письма и отметки прочтения, доходит до окна событием `rooms.mail` без полного прохода хоста. Снимок работ для окна больше не несёт писем: ленту и Mail окно грузит страницами.

**Architecture:** `LetterTx` ведёт журнал транзакции, `emitMapWritten` несёт его вместе с признаком `structural`. Хост на запись только писем не запускает `refreshPass` и `onChange`. Вместо этого он:
- зовёт `onMail` у подписчиков;
- шлёт новым окнам пачку `rooms.mail` с письмами, отметками и точными числами;
- старым окнам пересобирает снимок одной работы.

Шаг 2: для окон с признаком `rooms-mail` снимок собирается без писем (`MapCompact` версии 2). Окно держит письма только открытых комнат и Mail и чинит разрывы по версии работы.

**Tech Stack:** TypeScript, Node ≥ 22.16 (`node:sqlite`), vitest, Electron + React (zustand-сторы), Playwright E2E.

**Spec:** `docs/specs/2026-10-27-rooms-mail-design.md` (одобрена автором 2026-10-27). Ссылки «спека N.M» ниже — на неё.

## Global Constraints

- Всё, что уходит из рабочей копии, — по-английски: сообщения коммитов, имена веток, тексты PR. Комментарии в коде — на языке окружающего кода, в основном по-русски; ссылка на спеку — «спека rooms.mail N.M». Тексты окна и агентов — по-английски. Имена тестов — на языке своего `describe`.
- Признак протокола — `ROOMS_MAIL_FEATURE = 'rooms-mail'`, рядом с `COMPACT_WORKS_FEATURE` в `packages/protocol/src/context-pages.ts`, в списке ре-экспорта `protocol/src/index.ts`.
- Числа в событии и снимке — **абсолютные**, никогда не прибавки (спека 6.3).
- Письма в событии — целиком, в виде `context.messages`: `readBy` и текст до `WINDOW_TEXT_MAX` = 32 КиБ, у обрезанных — `textBytes` (`core/src/work/context-pages.ts:419`, `shrinkText`).
- Запись только писем **никогда** не вызывает `WorksService.onChange`, даже при подключённом старом окне (спека 6.7).
- Ориентиры (спека 8):
  - пачка — `MAIL_BATCH_MS = 50`;
  - потолок события — `MAIL_EVENT_MAX_BYTES = 256 * 1024`;
  - медленный клиент — `client.writableLength() > MAIL_SLOW_CLIENT_BYTES = 1024 * 1024`;
  - окно держит на комнату `WINDOW_ROOM_KEEP = 300` писем.
- Тесты — по пакету и каталогу (`pnpm --filter @parley/<pkg> exec vitest run <пути>`), **никогда** полным набором и никогда мутационными. Перед прогоном — `uptime`; при нагрузке ≥ 12 подождать.
- Не добавлять в индекс `.omc/`, `.superpowers/`, `.pnpm-store/`. Пуш и PR — только по слову автора; `gh` не установлен, PR открывается по ссылке compare.
- Сборки перед тестами хоста и окна: `pnpm --filter @parley/file-icons build && pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Если `feat/fewer-turns` или `feat/wake-settle` влиты в `origin/master` раньше задачи 5, перед задачей 5 влить `origin/master` в `feat/rooms-mail` (спека 9).

## Review Focus

1. **Пачка больше потолка.** Одна транзакция пишет 50 и больше писем: приглашения комнаты, «Go» плана. Ожидание: событие с `reread` вместо писем сверх 256 КиБ, окно дочитывает страницы, одно уведомление на работу, как сейчас. Тест — в задаче 4.
2. **Комната удалена или архивирована, пока пачка ждёт.** Событие по удалённой комнате окно выбрасывает, комнату не воскрешает. Тесты — в задаче 4 (хост держит пачку до публикации снимка) и в задаче 6 (окно выбрасывает).
3. **Переподключение посреди потока писем.** Нет повторных уведомлений, числа точные. Тест — в задаче 9.
4. **Остров.** Его рендерер тоже зовёт `useWorksStore.getState().init(bridge)` (`renderer/island/IslandApp.tsx:160`) и получает только события из белого списка (`main/ipc.ts:986`). Без `rooms.mail` в списке его числа застынут до следующего структурного снимка. Тест — в задаче 6.
5. **Человек отмечает прочитанным, пока событие в пути.** Итоговые числа и галочки совпадают с базой: числа абсолютные, отметки идемпотентны. Тест — в задаче 6.

---

## Карта файлов

| Файл | Что меняется | Задача |
|---|---|---|
| `packages/core/src/work/letter-tables.ts` | журнал транзакции в `createTableLetterTx` | 1 |
| `packages/core/src/work/letter-store.ts` | тип `LetterJournal`, экспорт | 1 |
| `packages/core/src/work/store.ts` | `MapWrittenEvent` + `structural`, `prevVersion`, `journal` | 1 |
| `packages/core/src/work/works.ts` | `watchWorks` не планирует обновление на запись только писем; `WindowWorkEntry.version?` | 2 |
| `packages/core/src/work/attention.ts` | `humanDecisionOutcome` | 7 |
| `packages/core/src/work/context-pages.ts`, `types.ts` | `mailWorkMap`, `MapCompact` версии 2 | 7 |
| `packages/protocol/src/{context-pages,types,events,index}.ts` | признак, `RoomsMailEvent`, `context.letter`, поля `HealthSample` | 3, 7, 8 |
| `packages/host/src/{client,context,server}.ts` | `sendLine`, `broadcast(..., encoded)`, признак в `HOST_FEATURES` | 3, 4 |
| `packages/host/src/health/window-counters.ts` | счётчики окна | 3 |
| `packages/host/src/works/works-service.ts` (+ новый `works/mail.ts`) | путь «только письма», пачки, `onMail`, старые окна, чужие записи | 4, 5a, 7 |
| `packages/host/src/methods/{works,context-pages}.ts` | снимок для окна с признаком, `context.letter` | 7, 8 |
| `packages/host/src/{wake/wake-service,activity/activity-service,rooms/history-service,telegram/service,telegram/notify,host}.ts` | подписка на `onMail` | 5b |
| `packages/desktop/src/main/{host-connection,ipc}.ts` | признак в `hello`, `rooms.mail` в белом списке острова | 6 |
| `packages/desktop/src/renderer/store/{works,room-pages}.ts`, `lib/window-merge.ts` | применение событий, версия, починка, удержание писем | 6, 8 |
| `packages/desktop/src/renderer/{attention,components,lib,layout,palette}/…` | потребители спеки 6.9 | 8, 9 |

---

### Task 1: Журнал писем транзакции (core)

**Files:**
- Modify: `packages/core/src/work/letter-tables.ts:464-651` (`createTableLetterTx`)
- Modify: `packages/core/src/work/letter-store.ts` (тип и экспорт)
- Modify: `packages/core/src/work/store.ts:549-554, 1065-1169` (событие, `applyMapUpdate`), прочие места `emitMapWritten` (`:668, :706, :810, :908, :990`)
- Modify: `packages/core/src/index.ts` (экспорт `LetterJournal`)
- Test: `packages/core/src/work/letter-store.test.ts`, `packages/core/src/work/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // letter-store.ts
  export interface LetterJournal {
    added: Message[];                                   // по возрастанию seq, как записаны
    reads: Array<{ id: string; reader: string; at: string }>;
    deleted: string[];                                  // id писем, помеченных удалёнными (flagDeleted)
    droppedRooms: string[];                             // комнаты, чьи письма удалены (deleteRoom)
    rereadRooms: string[];                              // комнаты с массовой отметкой (reopened): окно перечитывает
  }
  // letter-tables.ts
  createTableLetterTx(db, projectPath, workId, map): { letters: LetterTx; wrote: () => boolean; journal: () => LetterJournal }
  // store.ts
  export interface MapWrittenEvent { projectPath: string; workId: string; version: number; removed?: true;
    prevVersion?: number; structural?: boolean; journal?: LetterJournal }   // нет structural — считать true
  ```

- [ ] **Step 1: Write the failing tests** (`letter-store.test.ts`, describe на русском):
  - «журнал: add и markRead попадают в событие»: `onMapWritten` ловит событие от `writeLetters(... add(letter('a')); markRead('s-02', [id], T2))`. В событии `structural === false`, `prevVersion === version - 1`, `journal.added.map(m => m.id)` равно `[id]`, `journal.reads` равно `[{ id, reader: 's-02', at: T2 }]`.
  - «журнал: откат SAVEPOINT выбрасывает свои записи»: внутри `letters.savepoint(() => { add(b); throw })` письмо `b` не попадает в `journal.added`, письмо `a` до savepoint остаётся.
  - «смешанная запись — structural true»: `updateMap` с `addRoom` и `letters.add`: `structural === true`, `journal.added.length === 1`.
  - «reopened и flagDeleted»: `reopened('r-01', T3)` даёт `rereadRooms` равное `['r-01']`; `flagDeleted('s-03')` даёт в `deleted` id писем `s-03`; `deleteRoom('r-01')` даёт `droppedRooms` равное `['r-01']` и `structural === true`.
  - В `store.test.ts`: `createWork` и `replaceStoredMap` шлют событие без `journal`, и для подписчика `structural !== false`.
- [ ] **Step 2: Run** `pnpm --filter @parley/core exec vitest run src/work/letter-store.test.ts src/work/store.test.ts`. Expected: новые тесты FAIL.
- [ ] **Step 3: Implement.**
  - Журнал копится рядом с `wrote` в каждом изменяющем методе (таблица методов — в шапке `letter-tables.ts`).
  - `savepoint` запоминает длины массивов до `fn` и обрезает их в ветке отказа, как сейчас восстанавливает `wrote`.
  - `flagDeleted` берёт id писем `SELECT`-ом до `UPDATE`.
  - `reopened` пишет комнату в `rereadRooms`, а не отметки поштучно.
  - `applyMapUpdate`:
    - `structural = diff.upserts.length > 0 || diff.deletes.length > 0 || diff.workChanged`, считается до проверки на пустоту;
    - `prevVersion = stored` (`:1077`);
    - журнал возвращается только на непустом пути и уходит в `emitMapWritten` на `:1167`.
- [ ] **Step 4: Run** ту же команду. Expected: PASS, остальные тесты файлов зелёные.
- [ ] **Step 5: Commit** `feat(core): journal letter changes per transaction in the map-written event`

### Task 2: `watchWorks` и версия в записи окна (core)

**Files:**
- Modify: `packages/core/src/work/works.ts:166-250` (`watchWorks`), `:36` (`WindowWorkEntry`)
- Test: `packages/core/src/work/works.test.ts`

**Interfaces:**
- Consumes: `MapWrittenEvent.structural` (задача 1).
- Produces: `WindowWorkEntry { projectPath: string; map: WindowWorkMap; version?: number }`. Запись только писем больше не будит колбэк `watchWorks`.

- [ ] **Step 1: Write the failing tests:**
  - «запись только писем не будит watchWorks»: `watchWorks(spy, { debounceMs: 5, pollMs: 20 })`, затем `writeLetters(... add(...))`. Через 100 мс `spy` вызван только стартовым чтением.
  - «смешанная запись будит»: `updateMap` с `addRoom` будит.
  - «чужая запись будит»: запись вторым соединением `node:sqlite`, как в `letter-store.test.ts`, будит через опрос.
- [ ] **Step 2: Run** `pnpm --filter @parley/core exec vitest run src/work/works.test.ts`. Expected: первый тест FAIL.
- [ ] **Step 3: Implement.** В подписке `onMapWritten` (`:222`) событие с `structural === false` только обновляет `versions` и не зовёт `schedule()`. Опрос `data_version` сравнивает с `versions` и такую запись изменением не считает.
- [ ] **Step 4: Run** ту же команду. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): do not refresh works on letters-only writes`

### Task 3: Протокол, транспорт и счётчики

**Files:**
- Modify: `packages/protocol/src/context-pages.ts` (признак), `packages/protocol/src/types.ts` (`RoomsMailEvent`, поля `HealthSample` после `recomputes`, `:312-334`), `packages/protocol/src/events.ts` (`'rooms.mail'`), `packages/protocol/src/index.ts`
- Modify: `packages/host/src/client.ts:9-30` (`sendLine`), `packages/host/src/context.ts:16, 80-82` (`broadcast(..., encoded?)`)
- Modify: `packages/host/src/health/window-counters.ts`
- Test: `packages/protocol/src/types.test.ts` (если там проверяются события), `packages/host/src/context.test.ts`, `packages/host/src/health/health-service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ROOMS_MAIL_FEATURE = 'rooms-mail';
  export interface RoomsMailRoom {
    roomId: string | null; prevTop: number; top: number; total: number; lastAt: string | null;
    letters: Message[]; reads: Array<{ id: string; reader: string; at: string }>; deleted: string[];
    reread?: true;                                  // дочитай комнату: потолок, медленный клиент, массовая отметка, чужая запись
  }
  export interface RoomsMailEvent {
    projectPath: string; workId: string; version: number; prevVersion: number; updatedAt: string;
    rooms: RoomsMailRoom[]; droppedRooms: string[];
    unread: { letters: number; rooms: Record<string, number> };   // ключ '' — прямые письма
    mentionCandidates: Message[];                   // все нынешние непрочитанные человеком, прошедшие plainHumanMention, до WINDOW_UNREAD_MAX
  }
  // Events: 'rooms.mail': RoomsMailEvent
  // Client: sendLine?(line: string): boolean;  send(m) = sendLine(encodeLine(m))
  // HostContext.broadcast<E>(event: E, data: EventData<E>, only?: (c: Client) => boolean, encoded?: string): void
  // HealthSample += worksChangedEvents, worksChangedBytes, mailEvents, mailBytes, lettersOnlyRefreshes: number
  // WindowCounters += worksChanged(bytes: number), mail(bytes: number), lettersOnlyRefresh(): void
  ```
- [ ] **Step 1: Write the failing tests:**
  - `context.test.ts`: «broadcast с готовой строкой шлёт её как есть»: два клиента с `sendLine` получают одну и ту же строку, `encodeLine` вызван ноль раз (шпион).
  - Ещё тест: «клиент без sendLine получает send({event, data})».
  - `health-service.test.ts`: «строка состояния несёт счётчики окна»: после `counters.mail(1000); counters.worksChanged(500); counters.lettersOnlyRefresh()` в сэмпле `mailEvents: 1`, `mailBytes: 1000`, `worksChangedEvents: 1`, `worksChangedBytes: 500`, `lettersOnlyRefreshes: 1`; после `reset()` — нули.
- [ ] **Step 2: Run** `pnpm --filter @parley/protocol build && pnpm --filter @parley/host exec vitest run src/context.test.ts src/health/`. Expected: FAIL.
- [ ] **Step 3: Implement** по Interfaces. `sendLine` и `encoded` переносятся из `feat/map-journal` (`git show 0d12f72e:packages/host/src/client.ts`, `:17-27`; `context.ts:19, 80-86`). Признак в `HOST_FEATURES` здесь **не** добавлять: это задача 4.
- [ ] **Step 4: Run** ту же команду. Expected: PASS. Плюс `pnpm --filter @parley/protocol exec vitest run`.
- [ ] **Step 5: Commit** `feat(protocol,host): add the rooms.mail event type, one-encode broadcast and window counters`

> Примечание: счётчик `lettersOnlyRefreshes` и метод `lettersOnlyRefresh()` из этой задачи убраны до слияния. Запись только писем этого процесса не может начать полный проход по построению (подписка `onMapWritten` в `watchWorks` не зовёт `schedule()`), так что считать нечего; свидетельство — `refreshCount`: от писем он не растёт. Упоминания счётчика ниже (тест строки состояния, шаг приёмки в задаче 10) — исторический текст плана.

### Task 4: Хост — путь «только письма», событие и старые окна

**Files:**
- Create: `packages/host/src/works/mail.ts`. В нём сборка `RoomsMailEvent` из журнала и пачки по работе.
- Modify: `packages/host/src/works/works-service.ts`:
  - `ensureWatcher` `:438-456` — добавить подписку `onMapWritten`;
  - `publish` `:291-315` — принимает фильтр клиентов;
  - `isCompactClient` `:109` — рядом `isMailClient`;
  - `refreshPass` `:498-534`;
  - `WorksService` `:61-77`.
- Modify: `packages/host/src/server.ts:41` (`HOST_FEATURES` += `ROOMS_MAIL_FEATURE`)
- Test: create `packages/host/src/works/works-service.mail.test.ts`, based on the fixtures of `works-service.window.test.ts` (`fakeClient(features)`, `fakeHost()` with a working `only` filter, `debounceMs: 5`)

**Interfaces:**
- Consumes: `MapWrittenEvent`, `LetterJournal` (задача 1); `RoomsMailEvent`, `broadcast(..., encoded)`, счётчики (задача 3); `roomLetterTops`, `letterCount`, `unreadCount`, `unreadLetters`, `plainHumanMention` из `@parley/core`.
- Produces:
  ```ts
  export interface MailNotice { projectPath: string; workId: string; version: number; prevVersion: number;
    journal: LetterJournal; foreign: boolean }
  WorksService.onMail(listener: (notice: MailNotice) => void): () => void
  ```
  `onMail` зовётся на **каждый** коммит с непустым журналом. Для записи только писем — сразу. Для смешанной записи — после публикации снимка, который включает её.

- [ ] **Step 1: Write the failing tests** (`works-service.mail.test.ts`, describe на русском). Порт первых шести случаев `git show 2cc79d95:packages/host/src/works/works-service.mail.test.ts` на запись через SQLite, плюс новые:
  - «письмо без смены карты»: окну с `rooms-mail` уходит одно `rooms.mail`, `works.changed` — ноль, `windowCounters.read().refreshCount` не вырос. Слушатель `onChange` не вызван, `onMail` вызван один раз.
  - «форма события»: после `add` в `r-01` у события `prevVersion === version - 1`, `rooms[0].prevTop` — прежний `MAX(seq)`, `top` — новый, `total` — `letterCount` комнаты, `letters[0].text` целиком, `unread.letters` равно `unreadCount(HUMAN).total`.
  - «окно без признака получает works.changed по одной работе»: клиент только с `compact-works` получает `works.changed`, в котором у этой работы новое письмо в хвосте; `refreshPass` не вызван (счётчик `refreshCount` не вырос).
  - «пачка: три письма за 10 мс — одно событие с тремя письмами».
  - «потолок»: 300 писем по 1 КиБ одной транзакцией дают событие не больше 256 КиБ с `reread: true` у комнаты.
  - «медленный клиент»: при `writableLength() > 1 MiB` клиент получает склеенное событие с `reread: true`, быстрый — полное.
  - «смешанная запись: снимок раньше события»: `updateMap` с `addRoom` и письмом в новую комнату. Порядок в `broadcasts` — сначала `works.changed`, потом `rooms.mail`, у которого `version` ≤ версии работы в снимке.
  - «удаление комнаты, пока пачка ждёт»: событие несёт комнату в `droppedRooms`, писем удалённой комнаты в `rooms[]` нет.
  - «одна сериализация»: два клиента с признаком получают одинаковую строку (порт `works-service.encode.test.ts` из `2cc79d95`).
  - «hello отдаёт rooms-mail»: в `server.test.ts`, рядом с проверкой `feed-codex` на `:56`.
- [ ] **Step 2: Run** `pnpm --filter @parley/host exec vitest run src/works/works-service.mail.test.ts src/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - В `ensureWatcher` добавить `onMapWritten`. Событие с `structural === false` идёт в `mail.queue(event)`, а не в `scheduleRefresh`. Смешанное событие ставит журнал в очередь «после публикации».
  - Пачка по работе живёт `MAIL_BATCH_MS`. Работа с ожидающим структурным обновлением держит свою пачку до `publish()`.
  - Сборка события:
    - `top`/`prevTop` — `roomLetterTops`;
    - `total` — `letterCount` по комнате;
    - `lastAt` — `at` верхнего письма;
    - `unread` — `unreadCount(HUMAN)`;
    - `mentionCandidates` — `unreadLetters(HUMAN)` с фильтром `plainHumanMention`, до `WINDOW_UNREAD_MAX`;
    - текст режется как в `messagePage`;
    - `journal.reads` уходит в `rooms[].reads`, `journal.deleted` — в `rooms[].deleted` своей комнаты;
    - `journal.rereadRooms` даёт `reread: true` у комнаты;
    - `journal.droppedRooms` уходит в `droppedRooms` события.
  - Запись работы в снимке (`buildWindow`, `legacyEntries`, `worksList`) несёт `version: work.version` (задача 2, спека 6.3).
  - Одна сериализация, байты идут в `windowCounters.mail(bytes)`; `works.changed` идёт в `worksChanged(bytes)`.
  - Окна без признака: перечитать запись одной работы (`readEntry`), `revision += 1`, сбросить кэши снимка, `publish(c => !isMailClient(c))`. `onChange` при этом не звать.
  - В `refreshPass` не трогать ничего, кроме фильтра `publish`: окнам с признаком тоже уходит `works.changed` при структурной записи.
  - Добавить признак в `HOST_FEATURES`.
- [ ] **Step 4: Run** ту же команду и прежние тесты каталога `src/works/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(host): send letters-only writes as rooms.mail without a full works refresh`

### Task 5a: Записи из других процессов (host)

**Files:**
- Modify: `packages/host/src/works/works-service.ts` (колбэк `watchWorks`), `packages/host/src/works/mail.ts`
- Test: `packages/host/src/works/works-service.mail.test.ts`

**Interfaces:**
- Consumes: `readLetters(projectPath, workId, { afterSeq, limit, roomId: undefined })` — без `roomId` по всем каналам (`letter-store.ts:59-72`).
- Produces: `MailNotice.foreign = true` для писем чужой записи.

- [ ] **Step 1: Write the failing test** «чужая запись»: письмо, записанное вторым соединением `node:sqlite`, через опрос даёт полный проход (как сейчас) и `rooms.mail` с этим письмом. У комнат с этим письмом стоит `reread: true`, `onMail` вызван с `foreign: true`.
- [ ] **Step 2: Run** `pnpm --filter @parley/host exec vitest run src/works/works-service.mail.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Хост помнит по работе наибольший объявленный `seq` и версию, известную из своих событий. Версия, сменившаяся без своего события, считается чужой записью: письма `afterSeq` объявляются, а отметки покрывает `reread`.
- [ ] **Step 4: Run** ту же команду. Expected: PASS.
- [ ] **Step 5: Commit** `feat(host): announce letters written by another process`

### Task 5b: Подписчики хоста на `onMail`

**Files:**
- Modify:
  - `packages/host/src/wake/wake-service.ts:860, 1040-1078` (`recompute`, `recomputeAll`, подписки);
  - `packages/host/src/activity/activity-service.ts:742, 862, 1399-1450`;
  - `packages/host/src/rooms/history-service.ts:64-81, 162`;
  - `packages/host/src/telegram/service.ts:794-815, 1235`, `packages/host/src/telegram/notify.ts:93-130`;
  - `packages/host/src/host.ts:425` (`onWorksChange` для `mapChanges`, будит `wait_for inbox` в `core/src/mcp/tools.ts:885-893`).
- Test:
  - create `packages/host/src/wake/wake-service.mail.test.ts` (порт из `2cc79d95`);
  - `activity/activity-service.test.ts`, `rooms/history-service.test.ts`, `telegram/notify.test.ts`, `telegram/service.test.ts`, `agent/tools-endpoint.test.ts`.

**Interfaces:**
- Consumes: `WorksService.onMail`, `MailNotice` (задача 4); `recipientsOf(message, map)` (`core/src/work/letters.ts:16`, читает `map.rooms` — хватает хранимой карты).
- Produces: нет новых имён.

Правило — по таблице разведки:

| Подписчик | Зависит от записи только писем | Что делает на `onMail` |
|---|---|---|
| wake | да | `recompute` адресатов `added` (через `recipientsOf`) и читателей из `reads` |
| activity | частично: `metrics.unread` | `recompute` тех же сессий |
| history | да: `identity` включает `MAX(seq)` комнат | `scan()`, если `added` не пуст |
| telegram | да: ветка `triggers.letters` | новые письма человеку из `added`; первый вызов после старта молчит; решения и закрытие карточек остаются на `onChange` |
| `mapChanges` (`host.ts:425`) | да: будит `wait_for inbox` | вызвать слушателя |
| feed, autonomous-engine, plan-effects, sessions | нет | ничего |

- [ ] **Step 1: Write the failing tests:**
  - wake: «письмо в комнате из трёх пересчитывает ровно двух адресатов, не отправителя»; «прямое письмо — одного; письмо человеку — никого»; «отметка прочтения пересчитывает читателя»; «onChange по-прежнему пересчитывает всех».
  - activity: «новое письмо обновляет metrics.unread адресата без works.changed».
  - history: «письмо без смены карты пересобирает историю комнаты».
  - telegram: «письмо человеку через onMail даёт одну карточку; повтор того же id — ничего; первый onMail после старта молчит».
  - tools-endpoint: «wait_for inbox просыпается на письмо без works.changed» (рядом с `:689`).
- [ ] **Step 2: Run** `pnpm --filter @parley/host exec vitest run src/wake/ src/activity/ src/rooms/history-service.test.ts src/telegram/ src/agent/tools-endpoint.test.ts`. Expected: новые тесты FAIL.
- [ ] **Step 3: Implement** по таблице. Telegram: множество увиденных писем больше не пересобирается на каждый снимок в `onWorks`, оно пополняется из `onMail`.
- [ ] **Step 4: Run** ту же команду. Expected: PASS. Прежние тесты каталогов зелёные.
- [ ] **Step 5: Commit** `feat(host): wake, activity, history, telegram and wait_for follow rooms.mail`

### Task 6: Окно, шаг 1 — применять события

**Files:**
- Modify:
  - `packages/desktop/src/main/host-connection.ts:388` (`ROOMS_MAIL_FEATURE` в `hello`);
  - `packages/desktop/src/main/ipc.ts:986` (белый список острова += `rooms.mail`);
  - `packages/desktop/src/renderer/store/works.ts` (`init`, `applyMail`, версия работ, слушатели писем);
  - `packages/desktop/src/renderer/lib/window-merge.ts` (`withMail`);
  - `packages/desktop/src/renderer/store/room-pages.ts` (`repairWork`, `followRoom`).
- Test: `store/works.test.ts`, `store/works.compact.test.ts`, `store/room-pages.test.ts`, `lib/window-merge.test.ts`, `main/host-connection.oversize.test.ts` (проверка `hello` на `:83`), `preload/island.test.ts`

**Interfaces:**
- Consumes: `RoomsMailEvent` (задача 3), `WindowWorkEntry.version` (задача 2, в снимке — с задачи 4).
- Produces:
  ```ts
  // window-merge.ts
  export function withMail(entry: WindowWorkEntry, event: RoomsMailEvent): WindowWorkEntry
  // письма — dedupe по id, копия события выигрывает (свежий readBy); reads — readBy[reader] = at;
  // deleted и droppedRooms — убрать; compact.unread и compact.messages.rooms[*].total — присвоить из события;
  // map.work.updatedAt — из события
  // works.ts
  onMail(listener: (event: RoomsMailEvent) => void): () => void      // в сторе; зовётся после применения
  // room-pages.ts
  repairWork(bridge, entry): Promise<void>       // перечитать держимый диапазон каждой держимой комнаты и Mail страницами after:
  ```
  Правила версии (спека 6.5): `event.version <= held` → идемпотентное слияние, `held` не меняется; `event.prevVersion === held` → применить, `held = event.version`; иначе — применить и `repairWork`, `held = event.version`. Снимок ставит `held = max(held, entry.version)`. Событие про комнату, которой нет в снимке, ждёт снимка этой работы с `version >= event.version`. Если комната там есть — применить, нет — выбросить.

- [ ] **Step 1: Write the failing tests:**
  - `room-pages.test.ts`: порт четырёх случаев describe «init: rooms.mail» из `git show 2cc79d95:packages/desktop/src/renderer/store/room-pages.test.ts` (`:105-162`), переписанных на полные письма в событии.
  - `works.test.ts`:
    - «событие с prevVersion = held применяется без запросов»;
    - «разрыв версии → repairWork читает after: от наименьшего держимого seq и обновляет readBy старых писем»;
    - «событие раньше снимка с комнатой ждёт снимка и применяется»;
    - «событие удалённой комнаты выбрасывается»;
    - «числа присваиваются, а не прибавляются: два одинаковых события дают те же числа»;
    - «отметка человека во время события в пути: итог равен событию» (Review Focus 5).
  - `host-connection.oversize.test.ts`: в `hello.features` есть `rooms-mail`.
  - `preload/island.test.ts` или тест `ipc`: белый список острова пропускает `rooms.mail` (Review Focus 4).
  - «старый хост»: без `rooms-mail` в `status.features` окно не подписывается на `rooms.mail` и работает как сейчас.
- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/renderer/store/ src/renderer/lib/window-merge.test.ts src/main/host-connection.oversize.test.ts src/preload/`. Expected: FAIL.
- [ ] **Step 3: Implement** по Interfaces. На шаге 1 снимок ещё несёт письма. События сливаются в `entry.map.messages`, поэтому лента, уведомления и очередь отправки работают без правки.
- [ ] **Step 4: Run** ту же команду + `pnpm --filter @parley/desktop typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): apply rooms.mail events and repair gaps by work version`

### Task 7: Снимок без писем (core + host)

**Files:**
- Modify: `packages/core/src/work/types.ts:493-510` (`MapCompact` версии 2 рядом с версией 1), `packages/core/src/work/context-pages.ts` (`mailWorkMap`), `packages/core/src/work/attention.ts` (`humanDecisionOutcome`), `packages/core/src/index.ts`
- Modify: `packages/host/src/works/works-service.ts` (вариант части снимка для окон с признаком), `packages/host/src/methods/works.ts:21` (`worksList`)
- Modify: `packages/desktop/src/renderer/attention/derive.ts:117-125` (литералы — через `humanDecisionOutcome`; страж — `main/decision-letters-sync.test.ts`)
- Test: `packages/core/src/work/context-pages.test.ts`, `packages/core/src/work/attention.test.ts`, `packages/host/src/works/works-service.window.test.ts`, `packages/host/src/methods/works.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MapCompactMail {               // MapCompact версии 2
    version: 2;
    rooms: Record<string, { total: number; top: number; lastAt: string | null; unread: number;
      decision: 'accepted' | 'returned' | null }>;   // ключ '' — прямые письма; decision — по последнему письму человека
    unread: { letters: number; rooms: Record<string, number> };
    mentionCandidates: Message[];
    cut: Array<{ path: string; bytes: number }>; omitted: Record<string, number>;
  }
  // WindowWorkMap.compact?: MapCompact | MapCompactMail
  export function mailWorkMap(map: WorkMap, letters: LetterReader, options: { textMax?: number }): WindowWorkMap  // messages: []
  export function humanDecisionOutcome(text: string): 'accepted' | 'returned' | null
  ```
  Часовые счётчики писем не несутся. `NewSessionOrRoomDialog.tsx:479-488` читает из `resourceStatus` только `concurrent` и `launches` (спека 6.8; записать в коммит).

- [ ] **Step 1: Write the failing tests:**
  - core: «mailWorkMap не несёт писем и даёт total/top/lastAt/unread по комнатам и прямым».
  - core: «размер не меняется от 10 000 писем»: `JSON.stringify(mailWorkMap(...)).length` до и после `writeLetters` с 10 000 письмами отличается меньше чем на 200 байт.
  - core: «humanDecisionOutcome: 'Decision accepted.' → accepted, 'Returned for rework…' → returned, прочее → null».
  - host: «окно с rooms-mail получает снимок без писем, окно с compact-works — с хвостами, works.list — тот же вариант».
- [ ] **Step 2: Run** `pnpm --filter @parley/core exec vitest run src/work/context-pages.test.ts src/work/attention.test.ts && pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/works/works-service.window.test.ts src/methods/works.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `total` — `letterCount` по комнате.
  - `top` — `roomLetterTops`.
  - `lastAt` — `at` верхнего письма.
  - `decision` — `readLetters({ roomId, from: HUMAN, limit: 1, newestFirst: true })` → `humanDecisionOutcome`.
  - `unread` — `unreadCount(HUMAN)`.
  - `mentionCandidates` — как в задаче 4.
  - Без `channelStats`. Сессии, комнаты и планы ужимаются как в `compactWorkMap` (`:546-565`).
  - Окна без признака получают прежний вариант.
- [ ] **Step 4: Run** ту же команду. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core,host): window snapshot without letters for rooms-mail windows`

### Task 8: Окно, шаг 2 — лента, Mail, значки, решения

**Files:**
- Modify:
  - `packages/protocol/src/context-pages.ts` (метод `context.letter`), `packages/host/src/methods/context-pages.ts` (обработчик);
  - `packages/desktop/src/renderer/store/works.ts` (`keepHeld` вместо `retainSeen`, `WINDOW_ROOM_KEEP`), `store/room-pages.ts` (`openRoom`, `openMail`), `lib/window-merge.ts` (удалить `retainSeen`, `earlierRemaining`/`earlierCursor` от `compact` версии 2);
  - `components/rooms/feed-model.ts:347-368` (цитата по id), `components/rooms/RoomPanel.tsx:137-140, 366-373`;
  - `lib/mail-view.ts`, `components/mail/MailPanel.tsx:49-92`;
  - `attention/derive.ts:117-125, 146-160, 174-219`, `lib/room-view.ts:41`, `layout/tab-meta.ts:164`, `palette/documents.ts:182`.
- Test:
  - `packages/host/src/methods/context-pages.test.ts`;
  - desktop: `store/room-pages.test.ts`, `components/rooms/feed-model.test.ts`, `RoomPanel.earlier.test.tsx`, `lib/mail-view.test.ts`, `components/mail/MailPanel.test.tsx`;
  - desktop: `attention/derive.compact.test.ts`, `lib/room-view.test.ts`, `layout/tab-meta.test.ts`, `palette/documents.test.ts`.

**Interfaces:**
- Consumes: `MapCompactMail` (задача 7), `withMail`, `repairWork`, версия (задача 6).
- Produces:
  ```ts
  // protocol: 'context.letter': z.strictObject({ projectPath, workId, id: /^m-\d+$/ }) → { message: Message | null }
  // room-pages.ts
  openRoom(bridge, entry, roomId: string | null): Promise<void>   // newest page, если комната не держится; roomId null — Mail
  // works.ts
  keepHeld(prev: WindowWorkEntry | undefined, next: WindowWorkEntry): WindowWorkEntry  // держимые письма переходят в новый снимок, кроме комнат, которых нет
  ```
  Каждый потребитель берёт данные из `compact` версии 2, если он есть, иначе — по-старому, для старого хоста (спека 6.10).
  - «для вас» — комната последнего письма из `mentionCandidates`, прошедшего точное `hasHumanMention` (`components/rooms/room-remark.ts:385`).
  - Значок упоминаний — число таких писем.
  - Карточка решения — `compact.rooms[id].decision === 'returned'`.
- [ ] **Step 1: Write the failing tests:**
  - host: «context.letter отдаёт письмо по id с обрезкой как у страниц и null для чужого id».
  - desktop:
    - «открытие комнаты без писем читает последнюю страницу»;
    - «загрузить раньше: total из compact v2, курсор before:<наименьший держимый seq>»;
    - «цитата неподгруженного письма запрашивает context.letter и показывает оригинал»;
    - «Mail при открытии читает roomId null»;
    - «значок упоминаний считает только кандидатов, прошедших hasHumanMention: @human внутри кода не считается»;
    - «decision returned из compact v2»;
    - «держится не больше 300 писем на комнату»;
    - «старый хост (compact v1): потребители работают по письмам снимка».
- [ ] **Step 2: Run** `pnpm --filter @parley/host exec vitest run src/methods/context-pages.test.ts && pnpm --filter @parley/desktop exec vitest run src/renderer/store/ src/renderer/components/rooms/ src/renderer/components/mail/ src/renderer/lib/ src/renderer/attention/derive.compact.test.ts src/renderer/layout/tab-meta.test.ts src/renderer/palette/documents.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** по Interfaces и таблице спеки 6.9.
- [ ] **Step 4: Run** ту же команду + `pnpm --filter @parley/desktop typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): page room history and Mail, read counts from the letterless snapshot`

### Task 9: Окно, шаг 2 — уведомления и очередь отправки

**Files:**
- Modify: `packages/desktop/src/renderer/attention/notify.ts:245-267, 407-445, 519`, `components/rooms/RoomPanel.tsx:342-347`
- Test: `attention/notify.test.ts`, `components/rooms/room-outbox.test.ts`, `components/rooms/RoomPanel.test.tsx`

**Interfaces:**
- Consumes: `useWorksStore.getState().onMail` (задача 6).
- Produces: `createAttentionNotifier(deps).onMail(event: RoomsMailEvent): void`.

- [ ] **Step 1: Write the failing tests:**
  - «письмо в неподгруженной комнате даёт уведомление из события»;
  - «повтор события с тем же id — без уведомления»;
  - «события до первого снимка и первый снимок молчат»;
  - «после переподключения письма, дочитанные починкой и не новее последнего применённого события, не уведомляют» (Review Focus 3);
  - «пачка из 50 писем — одно уведомление на работу, как сейчас» (Review Focus 1);
  - «очередь отправки снимает отправленное, когда id пришёл в rooms.mail».
- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/renderer/attention/notify.test.ts src/renderer/components/rooms/`. Expected: FAIL.
- [ ] **Step 3: Implement.** На окне с `compact` версии 2 уведомления о письмах идут из `onMail`, а не из `onWorks`. Множество увиденных id и правило «первый молчит» сохраняются. Решения (`trackDecisions`) остаются на снимке. Очередь сверяет `sentAs` с id из событий и из держимой ленты.
- [ ] **Step 4: Run** ту же команду. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): notify and clear the outbox from rooms.mail`

### Task 10: Проверка ветки, E2E и замер

**Files:**
- Modify: E2E-спеки, которые кладут письма в снимок (через `e2e/stored-map.ts`), — только если их приготовления ломаются. Ожидания не меняются (спека 7.6). `CHANGELOG.md` не трогать: он пишется при выпуске.
- Create: текст PR и чек-лист замера в `.omc/reviews/2026-10-27-rooms-mail-pr-and-acceptance.md` (не в git).

- [ ] **Step 1: Run** сборки и тесты по каталогам:
  - core `src/work/ src/mcp/`;
  - host `src/works/ src/wake/ src/activity/ src/rooms/ src/telegram/ src/agent/ src/methods/ src/health/ src/server.test.ts src/context.test.ts`;
  - protocol целиком;
  - desktop `src/renderer/store/ src/renderer/attention/ src/renderer/components/ src/renderer/lib/ src/renderer/layout/ src/renderer/palette/ src/main/ src/preload/`;
  - `pnpm --filter @parley/desktop typecheck`;
  - eslint по изменённым файлам.
- [ ] **Step 2: Run** E2E по одному файлу: `room-decision`, `attention`, `room-actions`, `archive`, `room-owner`, `rooms-dialogs`, `stuck-notify`, `parley-integration`, `telegram`, `room-context`, `room-usage`, `migration`, `window-ready`. Expected: PASS без правки ожиданий.
- [ ] **Step 3: Замер на стенде** (скрипт вне репозитория, как у плана хранилища 4). Записать в файл PR таблицу «до/после»:
  - 60 писем в комнату из трёх при одном окне с признаком: `lettersOnlyRefreshes` = 0, `refreshCount` прироста от писем нет, `mailBytes` на письмо ≤ JSON письма + 1 КиБ, пересчётов будильника на письмо ≤ число адресатов;
  - `works.changed` в байтах до/после 10 000 писем в работе — не растёт;
  - открытие комнаты со 100 000 писем — одна страница.
- [ ] **Step 4:** чек-лист живой приёмки для автора: копия данных, как в `.omc/reviews/2026-10-27-sqlite-letters-pr-and-acceptance.md`; новое окно; старое окно. Текст PR по-английски, с концовкой `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 5: Commit** правки E2E, если были: `test(e2e): seed letters for the letterless window snapshot`

---

## Порядок и исполнение

| Волна | Задачи | Почему так |
|---|---|---|
| 1 | 1 | журнал нужен всем |
| 2 | 2 ‖ 3 | файлы не пересекаются (core `works.ts` / protocol + host transport) |
| 3 | 4 | путь хоста, на нём стоят 5a, 5b и 6 |
| 4 | 5a ‖ 5b ‖ 6 | `works-service`+`mail.ts` / подписчики хоста / окно — файлы не пересекаются |
| 5 | 7 | снимок без писем, после того как окно умеет события |
| 6 | 8 ‖ 9 | лента, Mail, значки / уведомления и очередь — пересекаются только в `RoomPanel.tsx`: 9 трогает `:342-347`, 8 — `:137-140, 366-373`; при конфликте — 9 после 8 |
| 7 | 10 | проверка, замер, PR |

Каждая волна: `get_usage` перед стартом, исполнитель Sonnet, ревью отдельным агентом, дифф читает ведущий, коммит — после ревью. Задачи 4 и 6 — на ревью более сильной моделью: в них порядок событий и разрывы.
