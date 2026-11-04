# A46: статус агента на телефоне всегда «Idle» — расследование

Ветка `feat/mobile-a40-a43`, worktree `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-mobile-device-run` (HEAD `3286d6ac`).
Репозиторий не менялся. Скрипты лежат в `/private/tmp/claude-501/-Users-kalmbik61-parley-worktrees-my-harnas-00f205-w-0054-s-174/d0e89983-39a4-43bd-8f30-b1b31f3fd840/scratchpad/probe/`.

## Коротко

Активность до телефона доходит. Хост выдаёт её и для сессий Claude в PTY, мост её пересылает, редьюсер кладёт её
под тем ключом, по которому читает UI. Я проверил это живьём: код ветки (HostLink + Fanout моста → стор remote-client
→ селекторы и `capsuleOf` телефона) подключил к **живому хосту** этого Мака. Слова на телефоне меняются вместе с хостом:
`Working` в начале хода и `Idle` после него, задержка не больше 1 с.

«Idle» появляется в другом месте. Телефон **сводит в одно слово «Idle» пять разных состояний**, которые окно
различает. Чаще всего встречаются два:

1. `capsuleOf` (шапка экрана сессии и строки сессий на экране работы) отображает `unseen` («ход закончен, ещё не
   смотрели») в **«Idle»**. Окно в этом случае пишет `done · unseen`, а спека D1 §8.2/§8.3 требует «Finished a turn».
2. Шапка командной карточки (`SessionTeamCard`) пишет `attentionWord(sessionAttention(...))`. Для `sleeping` и `pending`
   `sessionAttention` всегда отдаёт `'idle'`, поэтому спящий, «готовый» (`done`) и ещё не стартовавший ведущий подписан **«Idle»**.
   Окно пишет `asleep · memory was low`, `done` или `not started`.

Ведущий (УЛУЧШАЙЗИНГ-ЛИД, `s-38`) сам работает короткими ходами: раздаёт задачи и ждёт. Всё остальное время он в `unseen`
или спит. Поэтому на телефоне он почти всегда «Idle», а в окне в это время работает его команда, и ряд ведущего
показывает `done · unseen` / `done`.

---

## Окружение живой системы

- Мост: pid 11642, `/Applications/Parley.app/.../remote/dist/main.js`, запущен в 19:32 местного времени,
  `bridge.started version 0.28.0` (`~/.parley/remote/bridge.log`). Хост: pid 84952, 0.28.1, перезапущен в 20:52. Мост
  переподключился как эпоха `dfe530fc20d2de8f:2` (17:52:55Z).
- `git diff --stat v0.28.0 HEAD -- packages/remote/src packages/protocol/src/remote packages/remote-client/src packages/host/src/client.ts packages/host/src/activity packages/core/src/work/attention.ts`
  пуст. Значит, в живом мосту и в ветке один и тот же код этих пакетов, и симуляция ниже его воспроизводит.
- Спарен один телефон (`devices.json`: iPhone, ios). Последнее подключение 19:34:00Z. `s-38` разбужен с телефона в
  19:35:31Z, `pty.send` в 19:36:57Z и 19:38:09Z (`audit.jsonl`).
- В `bridge.log` нет `fanout.slow_phone`, `fanout.frame_too_large`, `fanout.projection_failed`, `host.line_too_long`.

## 1. На чём окно строит своё состояние

| Где в окне | Что читает | Код |
|---|---|---|
| Слово в строке сессии сайдбара | `sessionWord(session, live, now)`. По порядку: `sessionNeed` (`activity.need`, только у `active`) → `queuedWord(session.queued)` (только `pending`/`sleeping`) → `autoSleepWord(session.autoSleep.reason)` (когда `sleeping` и без `result`) → `stateWord(sessionDotStateWithNeed(session, activity.activity, need), lifecycle)` | `desktop/src/renderer/lib/session-word.ts:21-33`, `sidebar/SessionRow.tsx:216-240`, `core/src/work/session-state.ts:115-176` |
| Таблица слов | `working`, `blocked`→`needs you`, `unseen`→`done · unseen`, `idle`, `pending`→`not started`, `asleep`, `closed`, `done`, `failed` | `core/src/work/session-state.ts:146-156` |
| Точка, кольцо, «нужен ты» в строке | `sessionAttention(session, live)` | `SessionRow.tsx:240`, `core/src/work/attention.ts:54-71` |
| Точка на вкладке (шапка вкладки сессии) | `dotState(liveStatus(session), activity.activity)` | `layout/TabStrip.tsx:161,294` |
| «Working…», Stop и Queue в чате | **лента**: `live && turnActive(items)`; `blocked` берётся из activity | `chat/ChatView.tsx:217-218`, `core/src/feed/turn.ts:17` |
| Источник activity | событие `activity.changed` плюс `host:activity-snapshot` (кэш main, туда же попадает повтор хоста после `hello`) | `renderer/store/activity.ts:25-58`, `main/host-connection.ts:206-212,270,545-548` |

По пунктам из задачи:

- **«working»** — `activity.activity === 'working'` (в том числе удержание фоновыми субагентами `heldByBackground`).
  В открытом чате окно дополнительно смотрит `turnActive` по ленте.
- **«approval/question»** — `activity.need` (виды `approval`, `question`, `limit`, `sign-in`, `startup`) или `activity === 'blocked'`.
- **«asleep»** — `session.lifecycle === 'sleeping'` плюс `session.autoSleep` (причина сна).
- **«done»** — `session.result === 'done'` у спящей или закрытой сессии, а также `activity === 'unseen'` (`done · unseen`).

## 2. Доходит ли каждое поле до телефона

| Звено | Итог | Доказательство |
|---|---|---|
| Хост выдаёт activity для сессий Claude в PTY | **да** | Проба `host-probe.mjs` (клиент `remote`, как мост): после `hello` хост повторил 364 события `activity.changed`. Активность есть у 8 из 8 активных сессий: `working: 6, unseen: 2`, `src=hooks`/`log`. За 10 с пришло ещё 9 живых событий. Ни один ref не выпал из `works.list` |
| Повтор хоста после hello | после ответа на `hello`, в том же куске данных | `server.ts:314-326` (сначала `writeRaw` ответа, потом `registerClient`), `host.ts:1030-1033` |
| Граница роли `remote` у хоста | пропускает | `host/src/client.ts:35-42,78-81`. `activity.changed` входит в `A_EVENTS`: `protocol/src/remote/allowlist.ts:46-53` |
| Мост принимает повтор | да | `verified` ставится синхронно в `onHelloReply`, и следующий кадр того же куска уже проходит: `remote/src/host-link.ts:263-288,313-316`. Кэш по `refKey`: `host-link.ts:163-171` |
| Мост → телефон | да | Первым идёт `bridge.status`, затем `works.changed` и `activity.snapshot {epoch: host.epoch}`: `fanout.ts:90-117`. Живые события склеиваются по сессии за 1 с: `fanout.ts:145-169,189-194` |
| Эпохи | согласованы | `bridge.status` приходит первым и ставит `epoch`, после чего `activity.snapshot` той же эпохи принимается: `reducer.ts:244-268`. У `activity.changed` проверки эпохи нет: `reducer.ts:269-276` |
| Ключ | совпадает | `${projectPath}\0${workId}\0${sessionId}` везде: `protocol/src/types.ts:93`, `remote/src/host-link.ts:76`, `remote-client/src/state.ts:12`. `projectPath` нигде не нормализуется: и проекция (`projection.ts:177`), и `activityService.current()` (`activity-service.ts:1805-1818`) берут его как есть из `entries` |
| UI читает | да | `attentionOfSession` → `state.activity[sessionKey(ref)]` (`inbox.ts:60-63`), `TeamTree.tsx:29,65-67`, `session/[ref].tsx:297-300` |
| `lifecycle`, `result` | доходят (проекция) | `projection.ts:192-193` |
| `autoSleep`, `queued` | **не доходят** (их нет в `remoteSessionSchema`) | `projection.ts:19-36` |
| Ход по ленте (`turnActive`) | только на экране сессии, через подписку на ленту. Им пользуются поле ввода и меню, шапка — нет | `session/[ref].tsx:156-159,323-331` |

**Сквозная проверка с живым хостом** (`e2e-bridge-phone.mjs`, `e2e-words.mts`): HostLink и Fanout ветки, затем
`createRemoteStore` и `attentionOfSession` / `capsuleOf` телефона. В стор пришли `activity entries 364`, и слова
следуют за хостом:

```
+0.2s  s-174 [Mobile-stage-A-lead] lifecycle=active hostActivity=working phoneActivity=working -> header/row="Working" teamHead="Working"
+0.2s  s-240 [Mobile-A44-feed-bottom] lifecycle=active hostActivity=unseen phoneActivity=unseen -> header/row="Idle"    teamHead="Finished a turn"
+0.2s  s-38  [УЛУЧШАЙЗИНГ-ЛИД] lifecycle=sleeping hostActivity=unseen phoneActivity=unseen -> header/row="Sleeping" teamHead="Idle"
+36.8s s-243 [Relay-wizard-exec-B] lifecycle=active hostActivity=working phoneActivity=working -> header/row="Working" teamHead="Working"
+75.2s s-243 [Relay-wizard-exec-B] lifecycle=active hostActivity=unseen  phoneActivity=unseen  -> header/row="Idle"    teamHead="Finished a turn"
```

Размеры кадров на телефон: `activity.snapshot` 566 КБ (364 записи вместе с метриками, включая закрытые сессии всех
12 работ), проекция `works.changed` 139 КБ. Это в пределах 8 МиБ. Тесты `remote-client` (reducer, inbox, works-view) и
`remote` (`host-link`, `bridge-app`) зелёные.

**Слова телефона и окна для одного и того же состояния** (`words-table.mts`, чистые функции ветки, включая `sessionWord` окна):

```
active + working               window="working"                 phone header/row="Working"   phone team head="Working"
active + unseen                window="done · unseen"           phone header/row="Idle"      phone team head="Finished a turn"
active + idle                  window="idle"                    phone header/row="Idle"      phone team head="Idle"
pending (starting/queued)      window="not started"             phone header/row="Idle"      phone team head="Idle"
sleeping (autoSleep pressure)  window="asleep · memory was low" phone header/row="Sleeping"  phone team head="Idle"
sleeping + result done         window="done"                    phone header/row="Sleeping"  phone team head="Idle"
closed + done                  window="done"                    phone header/row="Done"      phone team head="Closed"
```

## 3. Причины, по убыванию уверенности

### П1. Слова телефона сводят разные состояния в «Idle» (уверенность высокая, ~80 %)

- `packages/mobile/src/cards/status.ts:63-71`: у `capsuleOf` есть ветки только для `needs-you` и `working`. Всё
  остальное, включая `attention === 'unseen'` и `lifecycle === 'pending'`, получает `label: 'Idle'`. «Finished a turn»
  уходит только в `detail`, а шапка (`HeaderTitle`, `session/[ref].tsx:56-75`) и строка (`TeamTree.tsx:81-84`)
  показывают только `label`. Спека D1 расходится с этим: в `docs/design/2026-10-31-mobile-mvp-screens.md:676-683` (строка
  `unseen` — «Finished a turn · 3 min ago») и `:921-932` (слово в подзаголовке `unseen` — **Finished a turn**, только что
  запущенная — **Starting/Queued**). В `status.test.ts` нет случаев `unseen` и `pending`.
- `packages/mobile/src/works/TeamTree.tsx:271,279,292` (а также `:71`, подпись VoiceOver строки): шапка команды пишет
  `attentionWord(a)` (`ui/parts.tsx:14-15`), где `a = sessionAttention(...)`. Функция `core/src/work/attention.ts:57`
  отдаёт `'idle'` для **любой** неактивной незакрытой сессии (`sleeping`, `pending`). В итоге спящий, «готовый»
  (`result: done`) и ещё не запущенный ведущий подписан «Idle», хотя `capsuleOf` той же сессии сказал бы «Sleeping».
- Живые данные. В момент пробы 6 из 8 активных сессий были в `unseen`, то есть на телефоне «Idle» при `done · unseen` в
  окне. Ведущий `s-38` сейчас `sleeping`, `result=done`, `autoSleep=pressure`: окно пишет «done», шапка его команды на
  телефоне — «Idle».
- Почему кажется, что «работает, а показывает Idle». По транскрипту `s-38` (`~/.claude/projects/.../3d080726-....jsonl`)
  его собственные ходы после пробуждения длились 19:36:57–19:37:27, 19:38:09–19:38:20 и 19:38:45–19:38:52 (UTC): 30 с,
  11 с и 7 с. В них он отправил задачи `send_message` своей команде, а в 19:44:55Z хост его усыпил (`агент усыплён`,
  `pressure`, `host.log`). Остальные минуты ведущий в `unseen` («Idle» в шапке и строке) или спит («Idle» в шапке команды).
  В это время в окне видно, как работает его команда (`s-238`, `s-241…s-244`), и ряд ведущего с кольцом `done · unseen`.

### П2. На самом устройстве живые `activity.changed` не применяются (уверенность низкая, ~15 %)

В коде я этого не нашёл. Цепочка ветки с живым хостом работает, а код моста совпадает с 0.28.0. Остаётся то, что
симуляция не покрывает: Noise/relay, Hermes и сборка на iPhone (она может быть не с этого HEAD). Только эта причина
объяснила бы «Idle» в тот момент, когда сам этот агент в окне `working`, а не `done · unseen`.

### П3. Устаревший `lifecycle` в снимке телефона (уверенность очень низкая, ~5 %)

`works.changed` для моста приходит: в `host.log` идут `worksChangedEvents` по ~5,11 МБ, и хост их рассылает. Замечу
попутно: письмолёгкий снимок для моста занимает уже ~97,5 % от `WINDOW_SNAPSHOT_MAX_BYTES = 5 MiB`
(`works-service.ts:160`). Есть запасная сборка с урезанными текстами, так что сейчас это не причина, но запас почти выбран.

### Как отличить П1 от П2 на живой системе

1. Откройте на телефоне сессию, которая сейчас **в длинном ходе**: в сайдбаре окна её строка показывает `working`, а не
   `done · unseen`. Хорошо подходит лид `s-174` во время работы. Через 1–2 с шапка должна сменить «Idle» на «Working».
   - Сменилась → активность доходит, причина П1.
   - Остаётся «Idle», пока окно показывает `working` → П2.
2. Сессия, ждущая одобрения на Маке, должна попасть на телефоне в Inbox или получить «Needs you». `blocked` и `need`
   приходят тем же потоком activity, а `stuck` в проекции появляется только после порога «застрял». Если появилась сразу,
   поток доходит.
3. Мост не пишет в лог ничего о пересылке activity, поэтому в `bridge.log` различающей строки нет (там пусто). Если
   подтвердится П2, нужно поле в стейте телефона: `Object.keys(state.activity).length` и время последнего
   `activity.changed` (например, строкой в Settings → Diagnostics). `0` значит, что не принят снимок; число растёт, но
   значения старые — значит, не доходят живые события.

## 4. Минимальное исправление (для П1)

Нужен только телефон. Мосту новые поля и события не нужны: `activity` (`activity`, `need`, `turnEndedAt`,
`lastEventAt`, `waitingFor`, `subagents`), а также `lifecycle` и `result` у телефона уже есть.

1. `packages/mobile/src/cards/status.ts`, `capsuleOf`: добавить ветки до завершающего `Idle`:
   - `attention === 'unseen'` → `label: 'Finished a turn'`, `detail: '<ago> ago'` по `turnEndedAt ?? lastEvent.at`,
     тон акцентный (D1: «акцент, кольцо»);
   - `lifecycle === 'pending'` → `label: 'Starting'` (D1 §8.3; «Queued» без поля `queued` не отличить);
   - у `idle` деталь по `lastEventAt` («Idle · N min ago», D1 §8.2), а не «Finished a turn».
2. `packages/mobile/src/works/TeamTree.tsx:271-292` (шапка `SessionTeamCard`) и `:71`, `:279` (подписи VoiceOver):
   слово брать из `capsuleOf(...)` головной сессии, как уже делает `SessionLine` (`:65-67,83`), а не из `attentionWord`.
   После этого `attentionWord` (`ui/parts.tsx:14-15`) больше нигде не используется, и его нужно удалить (других
   вызовов нет). Цвет и кольцо точки по-прежнему считает `attentionColor`.
3. Тесты: в `packages/mobile/src/cards/status.test.ts` добавить случаи `unseen` → «Finished a turn», `pending` →
   «Starting», `idle` с деталью из `lastEventAt`; ещё один тест на слово головы команды для `sleeping` → «Sleeping».

**Необязательно, ради полного совпадения с окном** («asleep · memory was low», «queued · limit 18/18»). Для этого в
проекцию нужны новые read-only поля `autoSleep: {reason} | null` и `queued: {reason} | null` в `remoteSessionSchema`
(`projection.ts:19-36`, `projectWorksSnapshot`). Нового события и правки allow-list не требуется (`works.changed` уже в
`A_EVENTS`). Но `remoteSessionSchema` и `remoteWorksSnapshotSchema` построены на `z.strictObject`, а телефон разбирает
`works.changed` через `safeParse` (`reducer.ts:445-447`). Телефон старой версии **отбросит каждый снимок** с новым
полем. Поэтому сначала нужен телефон с нестрогой схемой или поднятие `REMOTE_PROTOCOL`, и только потом новые поля.
Тесты кадров, которые затронет такая правка: `packages/protocol/src/remote/projection.test.ts`,
`packages/protocol/src/remote/remote.test.ts`, фикстуры `packages/remote-client/test/fixtures.ts`. Для симптома
«всегда Idle» это не нужно.

Если подтвердится П2, исправлять нужно транспорт на устройстве, а не слова. По коду место пока не определить: нужно
наблюдение из п. 3.

## Скрипты (только чтение; к хосту подключаются как мост, вызывают `hello` и `works.list`)

- `.../scratchpad/probe/host-probe.mjs` — повтор и живая activity, которые хост отдаёт клиенту `remote`.
- `.../scratchpad/probe/find-label.mjs` — сессия по метке: `lifecycle`, `result`, `autoSleep`, activity.
- `.../scratchpad/probe/e2e-bridge-phone.mjs` — HostLink и Fanout ветки → стор телефона → `attentionOfSession` и размеры кадров.
- `.../scratchpad/probe/e2e-words.mts` — временной ряд слов телефона (`capsuleOf` и голова команды) против activity хоста.
- `.../scratchpad/probe/words-table.mts` — таблица «окно против телефона» на одних и тех же состояниях.

Запуск: `node <script>` (нужен `/Applications/Parley.app/Contents/Resources/node/bin/node`), а для `.mts` —
`../../node_modules/.bin/tsx <script>` из `packages/mobile` или `packages/desktop`.
