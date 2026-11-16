<!-- drone 4 s-408 model=haiku addedAt=2026-11-16T17:23:12.050Z handedAt=2026-11-16T17:26:54.865Z result=done -->
Drone D (s-408), срез works/ + stuck/, копия pilot3-subject @ 9eabc014. Пути — от корня копии. Читал целиком: packages/host/src/stuck/stuck-service.ts, works/works-sync.ts, works/mail.ts, works/works-service.ts (1–1290). Частично: packages/core/src/work/stuck.ts (1–34), packages/core/src/work/works.ts (215–330), packages/protocol/src/works-sync.ts (128–136). Тесты не читались.

## Q13 — какие виды сразу, какие ждут; когда «back»
1. Сразу докладываются limit, sign-in, startup: `packages/host/src/stuck/stuck-service.ts:74` (IMMEDIATE); `open()` вызывает `report` немедленно при `IMMEDIATE.has(kind)` — `stuck-service.ts:285-288`.
2. Остальные виды (approval, question; любой вид вне IMMEDIATE) ждут таймера: `stuck-service.ts:289-293`. Длительность — `options.reportMs ?? STUCK_REPORT_MS` (`stuck-service.ts:118`); `STUCK_REPORT_MS = 120_000` в `packages/core/src/work/stuck.ts:34`; опция — `stuck-service.ts:45-47`.
3. Переопределение через env: `stuckReportFromEnv` (`stuck-service.ts:62-71`): целое 100…600000, иначе игнор. Кто его вызывает и подаёт ли в `reportMs` — НЕ ПРОВЕРЕНО (вне среза).
4. Таймер не перезапускается при смене деталей или вида внутри эпизода: `episode.need = need` (`stuck-service.ts:329`), а доклад берёт `episode.need` в момент срабатывания (`stuck-service.ts:227, 290-291`).
5. Виды startup/question/approval сменяют друг друга в одном эпизоде: `stuck-service.ts:76, 78, 324-328`.
6. Доклад пишет `session.stuck`, строку в ленту комнаты и письма одной записью: `stuck-service.ts:223-250`, `post()` — `stuck-service.ts:209-221`.
7. Конец эпизода — `finish()` (`stuck-service.ts:266-280`). Строка «back» пишется только если эпизод был доложен (`told !== null`, `:270`), не `silent` (`:274`), сессия `lifecycle === 'active'` (`:274`) и комната не архивна (`post` `:212`).
8. Строка «back» идёт только если комната сессии существует (`post` `:215`); без комнаты письмо всё равно уходит (`:216-219`).
9. Письмо «back» — только для limit, sign-in, startup (`stuck-service.ts:277`). Для approval/question письма нет: `letter: null` → `post` выходит после строки (`:216`).
10. `silent` = true при замене эпизода другим видом (`:325`) и на первой сверке после старта, если нужда пуста (`:317`). Замена агента (`endBySwitch`, `:357-380`) снимает `stuck` без «back».
11. Если доклад не записался (`write` вернул false), `told` остаётся null и «back» не пишется (`:249, 270`).
Open: что `backLetter`/`backLine`/`stuckLetter` возвращают при null (core/stuck.ts не прочитан дальше строки 34); источники видов нужды в activity-service (не читал).

## Q14 — первое событие активности после рестарта
1. Первое событие сессии в процессе: `seen` (`stuck-service.ts:306-307`).
2. Если на первом событии `session.stuck` непуст и эпизода в памяти нет — эпизод заводится из карты с `need = told = known`, без таймера (`stuck-service.ts:310-311`); поэтому повторного письма по нему не будет.
3. (a) need = null: если эпизод есть — `finish(…, silent = first = true)` (`:314-318`): `stuck` снимается, строки и письма нет (`:272-274`). Если эпизода нет — ничего не пишется (`:317`).
4. (b) вид вне того же эпизода (`sameEpisode` false, `stuck-service.ts:78, 324`): старый эпизод закрывается тихо (`finish(…, true)`, `:325`), затем `open` для новой нужды: limit/sign-in/startup — доклад сразу; иначе таймер (`:326`).
5. (c) тот же эпизод, изменились детали: `episode.need = need` (`:329`); если карта уже доложена (`told !== null`) и `sameNeed` ложно — `refresh`: только `session.stuck = need`, без строки и письма (`:330, 253-259`). `sameNeed` сравнивает kind, since, detail, resetsAt, window, account (`:80-86`). Если эпизод ещё не доложен — `need` просто обновляется, доклад возьмёт его (`:227`).
6. До `handle` события фильтруются: null-need без предыдущего null не ставятся в очередь (`:333-341`), очередь на сессию — `enqueue` (`:132-141`).
7. Если сессии нет в карте работ — эпизод удаляется без записи (`:298-304`).

## Q15 — письмо-only запись этого процесса
1. Признак: `structural = event.structural !== false` (`packages/host/src/works/works-service.ts:858`). Запись только писем не меняет `watchWorks` и не зовёт `onChange` (`works-service.ts:13-16, 145-149`; `packages/core/src/work/works.ts:89`).
2. Подписчики хоста (`onMail`): уведомляются синхронно в `onWritten` — `works-service.ts:869-890` (ветка `else` → `notify` на `:889`), `notify` — `:694-702`.
3. Окна с rooms-mail: через пачку. `joinBatch` + `armBatch` (`works-service.ts:880-891`); таймер = `mailBatchMs` = `MAIL_BATCH_MS` = 50 мс (`packages/host/src/works/mail.ts:32`; `works-service.ts:207`; переопределение `:99-103`, `:207`). По срабатывании — `flushMail` (`works-service.ts:897-909`), в нём `sendMail(batch)` (`:808`) → событие `rooms.mail` только окнам с признаком и не sync (`:761-777`, фильтр `:762`). Сборка и ужатие — `mail.ts:202-278`, `mail.ts:312-372`, потолок кадра 256 КиБ (`mail.ts:34`). Медленный клиент (буфер > 1 МиБ, `mail.ts:36`) получает склеенное `gluedMailEvent` (`works-service.ts:767-775`, `mail.ts:381-394`).
4. Окна без признака: `flushMail` вызывает `refreshEntry` (`works-service.ts:806`, `727-758`); при успехе — `publish(lacksMail)` (`:816`) → `works.changed` окнам compact/legacy (`:479-482, 491-500, 513`; `broadcastWorks` `:457-461`). Если `refreshEntry` вернул false — их догоняет полный проход (`works-service.ts:724-725`; `works.ts:85-90`, разрыв версий запускает проход) — часть не проверена до конца.
5. Что удлиняет ожидание: смешанная/структурная запись (`structuralVersion` взводится при структурной записи, `:880-888`; из-за ещё не опубликованной структуры `pendingStructural`, `:705-714, 887-888`; из-за чужой записи `holdForeign`, `:958-971`). Такая пачка выходит после публикации снимка с версией не ниже `structuralVersion`: `releaseMail` (`:826-837`, из `publish` на `:517`), либо в `refreshPass` (`:1219-1222`). Потолок: после первых 50 мс таймер ждёт до `MAIL_HOLD_MAX_MS` = 2000 мс от начала пачки (`mail.ts:42`; `works-service.ts:895-909`).
6. Sync-окна (`works.sync`): `sendMail(batch, true)` только когда снимок имеет `structuralSourceVersion ≥ required` (`works-service.ts:780-788, 809-811`); таймерный путь `flushMail` с `force = true` шлёт sync-событие без этой проверки (`:811`).
7. Пачка удаляется, когда отправлены и legacy, и sync-варианты: `retireMail` (`:795-799`).

## Q16 — постраничная синхронизация окон
1. Запрос: ровно одно из `cursor` или `base` (`packages/protocol/src/works-sync.ts:128-136`). Без курсора — `start(client, request.base!)` (`packages/host/src/works/works-sync.ts:396`).
2. Полный сброс (`reset`) при: `base === 0`, `!reader.completed`, `base < floor`, `base > revision` (`works-sync.ts:319`). Иначе дельта от `base` (`:320`).
3. Сброс отдаёт все записи, без надгробий, все ветки (`works-sync.ts:324-336`). Дельта: записи после `base`, надгробия работ с `revision > base` (`:327, 334`), ветки и их удаления с `revision > base` (`:329-330`).
4. Нижняя граница `floor` двигается только в `publish` при `changed` (`works-sync.ts:211-218`): вытеснение журнала (лимиты `WORKS_SYNC_JOURNAL_COMMITS` = 256 и `WORKS_SYNC_JOURNAL_BYTES` = 4 МиБ, `packages/protocol/src/works-sync.ts:32, 34`) поднимает `floor` до вытесненной ревизии (`:214-216`); переупорядочивание или `retire` ставит `floor = nextRevision` (`:217`). Дальше: `rows.prune(floor)` (`:221`), надгробия `≤ floor` отбрасываются (`:225`). Публикация без изменений `floor` не трогает и ревизию не поднимает (`:262-263`).
5. Смена эпохи: `retire = true`, если из каталога ушла работа или сменился `incarnation` (`:165, 129`); тогда `nextEpoch = randomUUID()` (`:176`). Адаптация при `nextEpoch !== epoch` (`:241-249`).
6. Что делает смена эпохи с клиентами: сбрасываются пины (`:243-244`), `reader.completed = false` (`:245`, поэтому следующий pull без курсора — сброс, `:319`), очищаются transfers, expired и кэш (`:246-247`), подменяется `currentEpoch` (`:248`). Старый курсор → `cursor-unknown`/`cursor-expired` → `reset-required` (`:391-394, 420-423`). Страницы старой эпохи не отдаются (`:356, 372`).
7. Уведомление: при любом изменении (`changed`, `:262-276`) клиентам уходит `works.invalidated` с `epoch` и `revision`; повтор запрещён флагом `notified` до следующего pull (`:273-274, 342`); флаг сбрасывается при смене эпохи (`:245`).
8. Ревизия растёт только при `changed` (`:263`).

## Open
- Клиентская обработка `works.invalidated` и `reset-required` (не в срезе).
- Источники видов нужды (activity-service.ts), кто вызывает `stuckReportFromEnv`.
- core/src/work/stuck.ts после строки 34 (тексты, null-возвраты backLetter/stuckLetter); core/src/work/works.ts вне 215–330 (определение `onMapWritten`, `event.structural`).
- Q15 п.4 (ветка `refreshEntry` = false) проверена по комментариям и `works.ts:85-90`, не трассирована до конца.
- sync-rows.ts, remote-snapshot.ts не читались.

Coverage: partial (см. список чтения в начале отчёта).