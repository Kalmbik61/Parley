# Критик A46 — слово состояния агента (коммит 8b03aedf)

Ветка `parley/w-0054/s-246`, worktree `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-246`.
Контракт: план A46 (`docs/plans/2026-10-29-mobile-app-plan.md:1314-1331`), разбор
`docs/audits/2026-11-03/mobile-device-run-A46-investigation.md`, D1 §8.2, §8.3, §9.1. Эталон: `desktop/.../lib/session-word.ts`,
`core/src/work/session-state.ts`, `core/src/work/attention.ts`.

Коммит закрывает главное, о чём жаловался человек. `unseen` теперь называется «Finished a turn», `pending` — «Starting».
Шапка команды и подписи VoiceOver строк и шапки берут слово из `capsuleOf`, так что спящий и не запущенный лид больше
не «Idle». `attentionWord` удалён без последствий. Но перевод шапки на `capsuleOf` унаследовал старую ошибку
`capsuleOf` для закрытой сессии без итога. Спящая сессия с итогом всё ещё расходится с окном. А на вкладке Works работа
по-прежнему «idle», пока её агенты работают в комнате.

Блокеров нет.

## Major

### M1. Закрытая сессия без итога называется «Done» с зелёной галочкой. Окно пишет «closed». Шапка команды регрессировала

- **Где:** `packages/mobile/src/cards/status.ts:50-58`. Для `lifecycle === 'closed'` слово выбирается как
  `failed ? 'Failed' : 'Done'`, поэтому при `result === null` получается `Done` / `success` / `checkmark.circle.fill`.
  Теперь это слово стоит ещё в `works/TeamTree.tsx:276` (шапка команды) и в `:76`, `:284` (VoiceOver).
- **Эталон:** окно `liveStatus(closed) = result ?? 'exited'` → `stateWord('exited', 'closed') = 'closed'`
  (`core/src/work/session-state.ts:101-112,162-164`), точка — тире (`AgentStateDot.tsx:100-107`). D1 §8.2:684 —
  `Sleeping` / `Closed`, а `Done` только «при `result`». `transitionSession(…, 'closed')` итог не ставит
  (`core/src/work/map.ts:281-313`). Значит, у каждой сессии, закрытой человеком или `close_session` без `report`,
  `result === null`.
- **Сценарий:** человек закрывает в окне лида, у которого есть открытая комната. По A43 закрытый владелец открытой
  комнаты остаётся строкой-якорем, то есть шапкой команды. До коммита шапка писала `attentionWord('off')` = «Closed», и
  это было верно. Теперь она пишет «Done». Для той же сессии строка дерева (при «N more closed»), шапка экрана
  сессии (зелёная точка) и VoiceOver тоже говорят «Done». Проба (скрипт ниже) показывает:
  `closedNoResult -> Done | success`.
- **Исправить:** в ветке `closed` при `s.result === null` возвращать `{ label: 'Closed', tone: 'off', icon: … }`. В union
  `Capsule.icon` нужен нейтральный значок, например `minus.circle`; галочка для этого случая не подходит. Деталь — давность по
  `s.lastEvent?.at` (это запись `closed`). Тест: `closed` + `result: null` → «Closed», а также шапка команды с таким
  лидом (см. m4).

### M2. Спящая сессия с итогом называется «Sleeping». Окно и D1 §8.2 говорят «done» / «failed». Это ровно случай s-38

- **Где:** `packages/mobile/src/cards/status.ts:59-62`. Ветка `sleeping` не смотрит на `result`.
- **Эталон:** окно `liveStatus(sleeping) = result ?? 'exited'`, поэтому у спящей с `result: 'done'` слово «done», значок —
  галочка. Слово сна `autoSleepWord` окно ставит, только когда `agentStatus === 'asleep'`, то есть без итога
  (`session-word.ts:24-32`). D1 §8.2:684: `off` / `sleeping` → `Sleeping`; «при `result`: `Done · 1 h ago` … или
  `Failed · 1 h ago`». План ссылается на D1 §8.2 как на источник слов. В таблице разбора эта строка отмечена прямо:
  «sleeping + result done → window "done"».
- **Сценарий:** лид s-38 из жалобы почти всё время `sleeping`, `result=done`, `autoSleep=pressure`. В сайдбаре окна он
  «done», а на телефоне после коммита «Sleeping» везде: в шапке команды, в строке и в шапке экрана. «Idle» ушло, но
  совпадения с окном для того самого агента нет. Проба: `sleepDone -> Sleeping | off`.
- **Исправить:** в ветке `sleeping` при `s.result !== null` отдавать то же, что у закрытой с итогом (`Done`/`Failed`,
  `success`/`danger`, деталь от `resultAt`). При `result === null` оставить `Sleeping`. Строка Resume над полем
  зависит от `lifecycle` (`session/[ref].tsx:542`), её это не задевает. Тесты: `sleeping` + `done` → «Done»,
  `sleeping` + `failed` → «Failed», `sleeping` без итога → «Sleeping».
  Если ведущий сознательно оставляет «Sleeping» ради Resume, это надо записать в план A46 и в D1 §8.2. Тогда находка
  становится minor.

### M3. Вкладка Works пишет «idle», когда агенты работы работают в комнате или рое. Точка в той же строке при этом «working»

- **Где:** `packages/mobile/src/works/summary.ts:5`:
  `v.rows.filter((r) => r.kind === 'session' && r.attention === 'working')`. Участники комнат и роёв — не строки
  `session`: они лежат внутри строк `room` / `swarm` (`remote-client/src/works-view.ts:136-143,164-176`). Поэтому их
  `working` не считается. Точку той же строки (`v.level`) считают по всем сессиям работы (`works-view.ts:202-207`).
- **Сценарий:** лид раздал задачи участникам своей комнаты (так устроена команда s-38: ведущий ждёт, команда работает).
  В окне эти участники «working», на телефоне строка работы — «4 sessions · 1 room · idle» с точкой цвета `working`.
  Проба: `rows [session:lead, room:r[lead,m1,m2], …] level working`, `worksSummary = "4 sessions · 1 room · idle"`
  при `m1`, `m2` в `working`. Это тот же симптом, на который жаловался человек («на телефоне Idle, а в окне работает»),
  только на первом экране. В план A46 он не попал, но по смыслу задачи его надо закрыть здесь же.
- **Исправить:** считать `working` по всем незакрытым сессиям работы, а не по строкам. Например, передать в
  `worksSummary` функцию внимания (`attentionOfSession(state, ref, s)`) и пройти `v.work.sessions`. Это правка в
  `packages/mobile`, протокол и мост не меняются. Тест в `works/summary.test.ts`: два работающих участника комнаты →
  «2 working».

## Minor

### m1. Точка «Finished a turn» в шапке экрана — зелёная заливка, в дереве — кольцо акцента. «Starting» — серая заливка

- `cards/status.ts:73` (`tone: 'success'`) и `session/[ref].tsx:58`: `HeaderTitle` красит точку по тону и кольца не
  рисует. В дереве та же сессия получает `attentionColor` + `ring` (`TeamTree.tsx:81`, `unseen` → `c.tint`, кольцо).
  На `session-finished-*.png` у Greta в шапке зелёная точка, а на `work-*.png` у неё же в комнате кольцо акцента.
  Зелёная залитая точка совпадает с точкой «Done».
- D1 §9.1:927 требует для `unseen` «акцент, кольцо», а разбор рекомендовал «тон акцентный». Окно рисует `unseen` залитой
  точкой `state-done` (`AgentStateDot.tsx:119-121`). Для `pending` D1 §9.1:929 требует `working` с пульсом, окно рисует
  полое кольцо `state-inactive` (`AgentStateDot.tsx:111-117`). Телефон в шапке и в дереве рисует серую заливку
  (`status.ts:63`, `tone: 'idle'`).
- **Исправить:** выбрать одно правило (D1 или окно) и применить его в обоих местах. Проще всего завести тон `unseen` →
  `c.tint` и дать `HeaderTitle` кольцо, как у `Dot`. Либо красить точку шапки по `attentionColor`, как в дереве.

### m2. Давность у `idle` считается по записи истории, а не по `lastEventAt`, как требуют план и D1

- `cards/status.ts:75`: `timeAgo(s.lastEvent?.at …)`. `RemoteSession.lastEvent` — «последняя запись `history`»
  (`protocol/src/remote/projection.ts:32-33`): переходы lifecycle и итоги, а не события хуков. Код самого экрана сессии
  это оговаривает: «Only a hook event counts (the map's history holds lifecycle moves, not hooks)»
  (`session/[ref].tsx:173-174`). План: «у `idle` — давность от `lastEventAt`», D1 §8.2:683: «`Idle · 20 min ago`
  (`lastEventAt`)». Запасной вариант у `unseen` (`status.ts:72`) тоже идёт в историю.
- **Сценарий (проба):** сессия активна с 09:00, последний хук в 11:55. Деталь получается «3 h ago», а должна быть «5 min ago».
  Тест `status.test.ts:18` закрепляет неверный источник.
- **Исправить:** добавить `lastEventAt` в `CapsuleInput`, передавать `live?.activity.lastEventAt ?? null` из
  `TeamTree.tsx:32` и `session/[ref].tsx:300`, а `s.lastEvent` оставить запасным. Поправить тест.

### m3. «N ago» нигде не показывается, и при показе в дереве не обновлялось бы

- `detail` капсулы рисует только `StatusCapsule` (`ui/parts.tsx:44-61`), а его никто не вызывает (grep). Строка дерева
  показывает `cap.label · role` (`TeamTree.tsx:86-89`), шапка команды — только слово (`:296-298`), шапка экрана —
  `label · role · model · время` (`session/[ref].tsx:59-61`). Поэтому половина задачи плана («подробность "N ago" от
  `turnEndedAt`», «у `idle` — давность») пользователю не видна. D1 §8.2:682-683 ждёт в строке
  `Finished a turn · 3 min ago`. Кроме того, `capsuleInput` берёт `now: Date.now()` (`TeamTree.tsx:32`). Если деталь
  вывести, дерево перерисуется только при изменении стора, а не по таймеру. Шапка экрана тикает через `useNow(30_000)`.
- **Исправить:** вывести деталь в строке дерева и в шапке команды по D1 §8.2 и передавать `now` из `useNow` через
  `TreeEnv`. Если деталь сознательно отложена, записать это в план и удалить мёртвый `StatusCapsule`.

### m4. Тесты «шапки команды» шапку не проверяют

- `status.test.ts:31-38` вызывают тот же `capsuleOf`, что и первый тест. Они прошли бы и при старой проводке
  `attentionWord(attentionOf(…))` в `TeamTree.tsx`, а ошибка A46 была именно в проводке. План просит тесты шапки для
  спящего, закрытого и не запущенного лида. Не хватает и случаев, где расходились слова: закрытый без итога (M1),
  спящий с итогом (M2), спящий или `pending` с несвежей activity `unseen`/`working`, `pending` с `need`.
- `capsuleInput` экспортирован из `.tsx` с импортами React Native, поэтому vitest его не возьмёт. Экран сессии
  собирает тот же вход заново (`session/[ref].tsx:297-300`). В `TeamTree.tsx:276` осталась недостижимая ветка `'Idle'`
  (`SessionTeamCard` рисуется только при `look.kind === 'session'`, `:254`).
- **Исправить:** вынести сборку входа в чистую функцию (например, `capsuleOfSession(state, ref, session, now)` в
  `cards/status.ts`), вызывать её из дерева, шапки команды и экрана сессии. Тестировать её на `RemoteState` с activity, в
  том числе на случае s-38 (`sleeping`, `result: done`, activity `unseen`).

### m5. Меню упоминаний в комнате называет «idle» сессии в `unseen`, спящие, не запущенные и закрытые

- `app/room.tsx:95-96`: `a === 'needs-you' ? 'needs you' : a === 'working' ? 'working' : 'idle'`. Окно ставит здесь
  `stateWord(state, lifecycle)` (`desktop/.../rooms/feed-model.ts:327`): «done · unseen», «asleep», «not started» и
  т. п. Это то же «Idle вместо состояния», что и в жалобе, только в мета-строке `@`-меню и в её подписи VoiceOver
  (`room/RoomViews.tsx:182,194`).
- **Исправить:** брать слово из `capsuleOf` (в нижнем регистре, как у окна) или из `STATE_WORDS`.

### m6. Участники контейнеров без слова или с неверным словом; у шапки команды нет значка состояния (до коммита, вне A46)

- Участники комнаты в дереве (`TeamTree.tsx:148-157`) показаны только точкой, без слова. У `Pressable` нет
  `accessibilityLabel`, так что VoiceOver читает одно имя. D1 §8.2:583 требует строку «чем занят», а D1 §1.4 говорит,
  что точка не может быть единственным носителем смысла. Сон и `pending` при этом дают ту же серую точку, что `idle`.
- Участники роя (`TeamTree.tsx:213-215`): у любого, кто не сдал и не закрыт, слово `'working'`, даже если он спит,
  ждёт человека или закончил ход.
- Аватар шапки команды (`TeamTree.tsx:286`) рисуется без значка состояния, хотя D1 §8.2:553 его требует («в углу значок
  состояния»).
- **Исправить:** отдельной задачей, на том же `capsuleOf`.

### m7. Снимки: экран работы не показывает «Working» и «Sleeping» и исправленную шапку; «Finished a turn» противоречит сам себе

- Десять файлов, дев-лаунчера Expo среди них нет. Но:
  - `work-light.png`, `work-dark.png` показывают «Finished a turn» (шапка Greta), «Needs you», «Idle», «Starting».
    «Working» и «Sleeping» на экране работы не видны. В демо нет лида-шапки в `sleeping`, `pending` или `closed`,
    поэтому само исправление шапки (главное в коммите) на снимках не показано. План просит «экран работы и шапка
    сессии с "Working", "Finished a turn", "Sleeping", "Starting"».
  - На всех восьми снимках экрана сессии плавающая кнопка дев-клиента (шестерёнка) закрывает `⋯` в панели.
  - `session-finished-*.png`: в шапке «Finished a turn», а в ленте «Working…» и в подсказке под полем «The agent is working —
    your message waits for this turn». Причина в том, что лента демо-Greta кончается незакрытым промптом. Там же висит
    карточка смены провайдера, а D1 §9.1 называет сессию с такой карточкой «Needs you». Как доказательство снимок
    сбивает с толку.
- **Исправить:** добавить в демо спящего (лучше с `result: done`) и не запущенного лида с командой, снять экран работы с
  «Working» и «Sleeping» в кадре, спрятать кнопку дев-клиента, для «Finished a turn» взять ленту с законченным ходом.

## Проверено

- **Тесты:** `pnpm --filter @parley/mobile test`. Первый прогон дал 378/379: упал
  `markdown/parse.test.ts › one budget per message` («lists: 507 ms» при пороге 500 ms). Это таймерный флейк, к A46
  отношения не имеет: отдельный прогон файла и второй полный прогон прошли, 44 файла, 379/379. `status.test.ts` 3/3.
- **Typecheck:** `pnpm --filter @parley/mobile typecheck` — 0 ошибок. `eslint` по пяти изменённым файлам чистый.
  Корневой `pnpm lint` целиком не запускал. `pnpm -r build` не понадобился, `dist` уже собран.
- **`attentionWord`:** `git grep` по коду пуст, остались только упоминания в `docs/`. Удаление ничего не сломало.
  `attentionColor` по-прежнему нужен: точки дерева, комнат и Works.
- **Где телефон показывает слово или точку состояния:**

  | Место | Источник | Итог |
  |---|---|---|
  | Строки дерева работы и листа Team (`TeamTree.tsx:69-94`) | `capsuleOf` | верно, кроме M1/M2. Точка из `attentionColor` (m1) |
  | Шапка команды (`TeamTree.tsx:276,284,297`) | `capsuleOf` (новое) | верно, кроме M1/M2. Значка нет (m6) |
  | Шапка экрана сессии (`session/[ref].tsx:56-80,297-300`) | `capsuleOf` | верно, кроме M1/M2. Точка m1 |
  | VoiceOver строки, шапки команды, шапки экрана | `capsuleOf` | совпадает с видимым словом |
  | Участники комнаты в дереве (`TeamTree.tsx:148-157`) | точка, без слова | m6 |
  | Участники роя (`TeamTree.tsx:213-215`) | `'working'` / `'closed'` / `handed in` | m6 |
  | Шапка экрана комнаты (`room/model.ts:66-69`) | сводка комнаты: Decision / Needs you / N working / Idle | по D1 §9.7 |
  | `@`-меню комнаты (`room.tsx:95-96`) | своё `needs you / working / idle` | «idle» не к месту (m5) |
  | Строка Works (`works/summary.ts:5`) | счёт по строкам `session` | «idle» при работающих участниках (M3) |
  | Строки Inbox (`cards/InboxRow.tsx`) | `needReason` и вид карточки | слова состояния нет, верно |
  | Меню `⋯` (`feed/session-menu.ts`) | `lifecycle` и `working` / `turnRunning` | слов состояния нет |

- **Порядок выбора против окна:** у телефона `closed` → `sleeping` → `pending` → `needs-you` → `working` → `unseen` →
  `idle`. У окна `need` действует только у `active` (`sessionNeed`), так что у `pending`/`sleeping`/`closed` он и там
  не учитывается. Это совпадает. «Нужен ты» стоит раньше activity, как и в окне (`sessionAttention` и
  `sessionDotStateWithNeed`). Несвежая activity у спящей или закрытой не учитывается: `sessionAttention` отдаёт
  `idle`/`off`, а `capsuleOf` выходит раньше по `lifecycle`. Расхождения — только итог у `closed`/`sleeping` (M1, M2) и
  слова `queued` и `asleep · <причина>`, которые план сознательно вынес за A46.
- **Живое обновление:** экран работы и шапка сессии читают стор через `useSyncExternalStore` (`hooks/use-remote.ts:12-16`)
  и перерисовываются на каждом `activity.changed`. Слово от `now` не зависит. Таймер касается только детали (m3).
- **Проба** на коде ветки: стор `remote-client` из `dist`, `selectWorks`, `capsuleOf`, `worksSummary`. Скрипт:
  `/private/tmp/claude-501/-Users-kalmbik61-parley-worktrees-my-harnas-00f205-w-0054-s-174/d0e89983-39a4-43bd-8f30-b1b31f3fd840/scratchpad/probe-a46/probe.mts`.
  ```
  rows [ 'session:lead', 'room:r[lead,m1,m2]', 'session:sleepDone' ] level working
  worksSummary = "4 sessions · 1 room · idle"
  lead            -> Idle | idle | 3 h ago | activity.lastEventAt = 2026-11-03T11:55:00Z
  closedNoResult  -> Done | success | null
  sleepDone       -> Sleeping | off | Last active 3 h ago
  ```
- **Снимки** (`docs/audits/2026-11-03/screens-A46/`, 10 файлов, 1206×2622, открыт каждый). Ни один не дев-лаунчер.
  Шапка экрана сессии: «Working · opus · 42 min», «Finished a turn · feature-lead · opus», «Sleeping · writer · sonnet» (со
  строкой Sleeping/Resume), «Starting · writer · opus», каждый в светлой и тёмной теме. Экран работы: «Finished a turn»
  у шапки Greta, «Needs you», «Idle», «Starting» в обеих темах. Замечания — в m1 и m7.
- **Не проверял:** приёмку плана на устройстве (сессия «working» в окне за 1–2 с становится «Working» на iPhone). Она
  остаётся за ведущим.

## Вердикт

**accept after majors** — исправить M1 (закрытая без итога → «Closed»), M2 (спящая с итогом → «Done»/«Failed», как в
окне и D1 §8.2) и M3 (счёт «working» на Works по всем сессиям работы), каждое с тестом. Minor можно закрыть в том же
проходе (m2, m4, m5 — по несколько строк каждое) или записать в план.

## Перепроверка (коммит 439fa3f8)

Коммит `439fa3f8` лежит поверх `8b03aedf` и слияния `10191cae` с `feat/mobile-a40-a43`. Слияние не трогает
`packages/mobile`, `remote-client`, `protocol` и `core` (`git diff --stat 8b03aedf 10191cae` по ним пуст), поэтому
`dist` пробы годится.

### Прогоны

- `pnpm --filter @parley/mobile test`: 44 файла, **385/385** с первого прогона.
- `pnpm --filter @parley/mobile typecheck`: 0 ошибок.
- `eslint` по всем изменённым файлам mobile: чисто.
- Проба `probe-a46/probe.mts` переведена на новый API: `capsuleOfSession`, `worksSummary(v, attentionOf)`. Прежняя версия
  сохранена как `probe-v1.mts`. Тот же стор, что и в первом прогоне:
  ```
  rows [ 'session:lead', 'room:r[lead,m1,m2]', 'session:sleepDone' ] level working
  worksSummary = "4 sessions · 1 room · 2 working"
  lead            -> Idle | idle | ring false | 5 min ago | activity.lastEventAt = 2026-11-03T11:55:00Z
  closedNoResult  -> Closed | off | ring false | 3 h ago
  sleepDone       -> Done | success | ring false | 2 h ago
  ```
  До правки было `idle` / `3 h ago` / `Done` / `Sleeping`.

### Статус находок

| # | Статус | Чем подтверждено |
|---|---|---|
| M1 | **закрыто** | `status.ts:65-67`: при `result === null` — `Closed`, `off`, `minus.circle`, давность по записи `closed`. Тесты `status.test.ts` (`closed` без итога → «Closed», в том числе через `capsuleOfSession`). Проба: `Closed` |
| M2 | **закрыто** | `status.ts:69-72`: `sleeping` с итогом → `resultCapsule` (Done/Failed от `resultAt`), без итога → `Sleeping`. Тест «a sleeping lead that handed in a result reads Done (the window, s-38)». Проба: `Done · 2 h ago`. Строка Resume зависит от `lifecycle`, её это не задело |
| M3 | **закрыто** | `works/summary.ts:6-8` считает `working` по `v.work.sessions` через переданную функцию внимания, то есть по тому же набору, что и точка (`WorkView.level`). Вызов — `app/(tabs)/works.tsx:26,33,43`. Тест «room members included». Проба: `2 working` |
| m1 | **закрыто** | Новый тон `unseen` → `c.tint` и поле `ring`. И шапка (`session/[ref].tsx:58-70`), и дерево, и участники, и шапка команды рисуют точку из одного `Capsule` (`toneColor` + `ring`). «Finished a turn» — кольцо акцента (D1 §9.1), «Starting» — серое кольцо (как полое кольцо окна). На снимках шапка и строка дерева совпадают. Остаток по спящей — новая m10 |
| m2 | **закрыто** | `CapsuleInput.lastEventAt` из `activity.lastEventAt` (`status.ts:89-101`), запасной — `s.lastEvent`. У `unseen` цепочка `turnEndedAt → lastEventAt → lastEvent`. Тест «idle takes its age from the last hook event»: 5 min против 3 h |
| m3 | **закрыто** | `wordLine` (`TeamTree.tsx:35`): «Finished a turn · 3 min ago» в строке, у участника комнаты и в шапке команды. `TreeEnv.now` берётся из `useNow(30_000)` на экранах работы и сессии (`work/[ref].tsx:22,38`, `session/[ref].tsx:309-312`; лист Team наследует `env`). В шапке экрана сессии детали по-прежнему нет: D1 §9.1 хочет там «Working · 2 subagents». Это за пределом моей рекомендации, пусть остаётся заметкой. `StatusCapsule` (`ui/parts.tsx`) так и не используется |
| m4 | **закрыто** | Чистая функция `capsuleInputOf` / `capsuleOfSession` в `cards/status.ts:89-103`. Её вызывают дерево (`capsuleIn`), шапка команды, участники, `@`-меню и экран сессии; дубль на экране сессии убран, недостижимое `'Idle'` в шапке тоже. Тесты гоняют её на `RemoteState` с несвежей activity: спящий + `unseen`, `pending` + `working`, закрытый + `working`, s-38. Случай «`pending` + `need`» не покрыт, это мелочь |
| m5 | **закрыто** | `room.tsx:96`: `capsuleOfSession(...).label.toLowerCase()`, поэтому меню пишет «finished a turn», «sleeping», «starting», «closed», «done» |
| m6 | **закрыто** | `MemberLine` (`TeamTree.tsx:159-176`): слово с давностью, точка из капсулы, `accessibilityLabel` вида «имя. слово. Lead». Участники роя берут слово из капсулы (`:229`). У аватара шапки команды появился значок (`:303`). Регистр слов роя — новая m8 |
| m7 | **частично, открыто** | Сделано: новый `work-words-*.png` (работа «Status words») — шапка-лид «Sleeping · Last active 2 h ago», «Working», «Finished a turn · 3 min ago», шапка-лид «Starting», у шапок значки; `work-*.png` — слова и давность у участников комнаты; `session-finished-*` (Release-checker) больше себе не противоречит; все четыре слова в шапке сессии в обеих темах; дев-лаунчера нет ни на одном из 12 файлов. Осталось: плавающая шестерёнка дев-клиента по-прежнему на всех 12 снимках закрывает правую кнопку панели (`⋯` на экранах сессии). Попутно: на `session-starting-*` у ни разу не запущенной сессии показан законченный разговор («Completed in 6m 12s») — так в демо, слову это не мешает |

### Новые находки (minor)

#### m8. Слова участников роя смешивают регистры

- `works/TeamTree.tsx:229`: `capsuleIn(env, m.session).label` даёт «Working», «Idle», «Finished a turn», «Done» с большой
  буквы, а соседние слова того же столбца строчные: «handed in ✓», «closed». D1 §8.2 и окно пишут слова роя строчными
  («waiting», «handed in ✓», «failed», «closed»).
- **Исправить:** `.toLowerCase()`, как в `@`-меню (`room.tsx:96`).

#### m9. Название теста Markdown осталось со старым порогом; соседние пороги по 200 мс тоже могут флейкать

- `markdown/parse.test.ts:566`: тест называется «… in under 0.5 s», а проверяет `> 2000` (`:571`). Порог подняли, как
  просили (`:453-454`, `:512`, `:542`, `:571`), а имя теста — нет.
- В том же файле есть одиночные замеры `toBeLessThan(200)` без повтора (`:357`, `:366`, `:373`, `:391`). Под нагрузкой они
  могут дать тот же флейк, что был на 507 мс. Задачей это не было, поэтому только как наблюдение.
- **Исправить:** переименовать тест («… within the time bound»). Для 200-мс замеров при желании взять лучший из двух
  прогонов, как в остальных.

#### m10. Точка спящей сессии залита, а D1 требует полую

- `cards/status.ts:72`: у `Sleeping` стоит `ring: false`. D1 §8.2:684 («`systemGray3`, полая») и §9.1:931 («`idle`,
  полая») требуют полую точку. Сейчас спящая отличается от `idle` только оттенком серого (`off` против `idle`). На
  `work-words-*.png` и `session-sleeping-*.png` точка залита.
- **Исправить:** `ring: true` у `Sleeping` и, по D1 §8.2:684, у `Closed`. Тест на `ring`.

### Вердикт

**accept** — все три major закрыты, и это подтверждено кодом, тестами и пробой. Открыто minor: 4 (остаток m7 —
шестерёнка дев-клиента на снимках; m8 — регистр слов роя; m9 — имя теста Markdown; m10 — полая точка спящей). Каждую
можно закрыть одной строкой. Открытой остаётся и приёмка плана на устройстве (сессия «working» в окне за 1–2 с
становится «Working» на iPhone): её делает ведущий.
