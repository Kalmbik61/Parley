<!-- drone 2 s-405 model=haiku addedAt=2026-11-16T17:23:10.186Z handedAt=2026-11-16T17:24:28.982Z result=done -->
Drone B (s-405), sw-06, commit 9eabc014, copy /Users/kalmbik61/parley/pilot3-subject. Read whole: packages/host/src/wake/{wake-service.ts (2090 строк), limit-return.ts, resume-limiter.ts, opencode-prompt.ts — НЕ читан}, packages/host/src/sleep/{auto-sleep-service.ts, descendants.ts}, packages/core/src/work/auto-sleep.ts, packages/core/src/work/delivery.ts (блок 16–100, 200–300). Grep-only: core/src/mcp/tools.ts:1127–1133, 1429–1431; core/src/work/stuck.ts:36–40; core/src/config.ts:145. Файлы не менялись.

## Q05 — возврат после сброса лимита
1. Эпизод ведётся, только пока сессия `active` и `activity.need.kind === 'limit'` (wake-service.ts:1393–1397); иначе эпизод снимается (dropLimit, 1395–1396).
2. Срок: при известном `resetsAt` — resetsAt + LIMIT_RETURN_GRACE_MS (120 000, stuck.ts:36); без него — since + LIMIT_RETRY_MS (900 000, stuck.ts:38) (limit-return.ts:20–23; wake-service.ts:1421).
3. Срок переставляется, когда появилось или сменилось `resetsAt`, пока исход не принят (wake-service.ts:1422–1426). Сдвиг `since` в том же эпизоде срока не меняет (1401–1410, сравнение с settledAt).
4. Окно провайдера свободно при неизвестном сбросе: срок один раз встаёт на freeAt + grace (limit-return.ts:26–34; wake-service.ts:1433–1444).
5. Таймер ждёт ступенями по 60 с и сверяет часы (wake-service.ts:197, 1333–1357).
6. Срок наступил — `tryLimitReturn` (1445). Порядок проверок: не пауза, нет печати/указателя в полёте (1463); activity ∈ {unseen, idle} (1464). Если не выполнено — выход, повтор на следующем пересчёте.
7. Блок-проверка `returnBlock` (limit-return.ts:43–51), по порядку: счётчик `returns >= LIMIT_RETURNS_MAX` (=2, stuck.ts:40) → `repeated`; строка меню `LIMIT_MENU_TEXT` на экране → `menu`; черновик человека или наш leftover → `draft`.
8. Блок: `settledAt = now`, уведомление `limit-return-blocked` с текстом причины (wake-service.ts:1472–1480; limit-return.ts:54–63). Эпизод не повторяется до нового `since` (1401–1410).
9. Codex без режима вставки — повтор каждые 200 мс до 15 раз (1483–1486; wake-service.ts:180–181); смена модели/effort или ползунок — до 150 раз (1487–1490; 186).
10. Без блока: текст `limitReturnText` из непрочитанных, `beginAttempt`, `settledAt`, `returns += 1`, `returnTurn = 'pending'` (1494–1505).
11. Счётчик `returns` обнуляется: ходом, начатым не по возврату (промпт человека) — `returnTurn === null` и `working` (1384–1386); ходом возврата без ошибки лимита (`returnTurn === 'running'`, idle, need null) (1387–1390); в `switched` (1932).
12. Выход процесса: эпизод снимается, `returnTurn = null`, счётчик не трогается; спящую Parley сам не поднимает (1373–1378; 2026–2027).

## Q06 — отмена сна в последний момент
1. Шаг 1 под замком карты (auto-sleep-service.ts:318–333) отменяет сон при: сессия не active (`not-active`); уже стоит отметка `autoSleepPending` (`pending`); `keepAwake` (`keep-awake`); `switching` (`switching`); непрочитанные письма (`unread`); письмо выдано после начала простоя `deliveredSince` (`delivered`, core auto-sleep.ts:158–164). Причина пишется в лог, сон возвращает false, отметка не ставится (334–337).
2. До этого `consider`/`candidatePlan`/`planFor` проверяют: сторож тихих концов `holdsSleep` (auto-sleep-service.ts:250); `off`, `not-claude`, `not-active`, `keep-awake`, `pending`, `no-hooks`, `need`, `background`, `draft`, `pointer`, `unread`, `compacting`, `waiter-start-unknown`, `waiters-off`, `too-soon` — порядок в core auto-sleep.ts:97–132 и auto-sleep-service.ts:253–268.
3. Шаг 2 — `sessions.stop` (auto-sleep-service.ts:345). Если сессия осталась `active` с отметкой: `dropMark` снимает отметку, пишет warn «агент не уснул», возвращает false (351–354). `wake.retry` в этой ветке не вызывается. Исключение `stop` логируется и проход идёт дальше (344–348).
4. Успех: `deps.wake.retry(ref)` (359), `watchSurvivors` через SURVIVOR_CHECK_MS = 10 с (descendants.ts:15; auto-sleep-service.ts:365, 298–308).
5. Давление и слот: `sleepOne` (512–528) перебирает кандидатов по возрастанию idleSince; каждый перед сном проверяется заново (`candidatePlan`); если `sleepSession` вернул false — берётся следующий. Так отменённый кандидат не останавливает проход.
6. `onPressure` ставит `lastPressureSleepAt` только если `sleepOne` вернул true (542); темп PRESSURE_PACE_MS warn 30 с, critical 10 с (76).
7. `freeSlot` возвращает false, если никто не уснул (634). `slotCandidate()` смотрит только снимок и настройки без записи (641–645), поэтому может быть true, а реальный сон неудачен.
8. Порог давления: warn не ниже 30 мин, поднятая сессия не ниже 15 мин (core auto-sleep.ts:136–151; auto-sleep-service.ts:483–488).

## Q07 — лимит подъёмов письмами
1. Счётчик — `ResumeLimiter` на сессию: скользящий час HOUR_MS = 3 600 000, `taken` по refKey (resume-limiter.ts:13, 28–36).
2. Лимит `resumeRate`, по умолчанию 6 (core config.ts:145). Читается при старте и при изменении (wake-service.ts:441, 1950–1953; resume-limiter.ts:22).
3. Берётся в `recompute` только если `deliveryAction` дал `resume` и подъём не отложен: `slotTaken = !backedOff && !hostSlept && limiter.tryTake(ref)` (wake-service.ts:1626–1630). Нет слота — `resumeAllowed:false`, причина `resume-limit` (1631; core delivery.ts:63–64).
4. Не тратят слот: подъём, усыплённый хостом (`autoSleep != null`) (wake-service.ts:1628–1630); подъём с `trustHeld`, `queued`, или бюджетной паузой `BUDGET_RETRY_MS` (1618–1621).
5. Возвращают слот (`releaseSlot`, 790–795 → `limiter.release` pops последний момент, resume-limiter.ts:43–45): подъём не нужен — нет `resumeArgs` или `providerSessionId` (821–826); запуск `held` (согласие на папку) или `queued` (очередь машины) (862–865, 855–875); отказ бюджета `resource-budget` (885–888).
6. Ошибка запуска, не бюджетная (`resumeFailed`), — слот не возвращается (ветка else, 895–898).
7. Человек узнаёт об исчерпании: `limitNotice` (679–686), не чаще раза в час на сессию (LIMIT_NOTICE_EVERY_MS, 172). Вызов: при `resume-limit` без удержания (1640), и при отказе бюджета (893).
8. Не открыто: откуда ещё вызывается `limiter.tryTake` (grep по wake-service только), и что делает ручной Resume человека.

## Q08 — письма вокруг сна хоста и остановки человеком
1. Хост ставит `autoSleepPending` (auto-sleep-service.ts:330) до остановки; затем core переводит её в `autoSleep` (комментарий 11–13; сама transition не читана).
2. Пока стоит отметка или `autoSleep`, `check_inbox` и `wait_for` письма не выдают: `inboxFenced` (core auto-sleep.ts:172–174; core mcp/tools.ts:1127–1133, 1429–1431 — только grep). Письма остаются непрочитанными.
3. Выход процесса (wake-service.ts:2023–2041): если `hostSleeps(ref)` — `pointed.clear()`, письма свежие (2040). Иначе — `markUnreadPointed` (2041), и непрочитанные при остановке человеком считаются уже указанными — не поднимают сессию. Комментарий 2035–2039.
4. `hostSleeps` смотрит карту через `viewMap` и истинно при `autoSleepPending != null` или `autoSleep != null` (wake-service.ts:645–654).
5. Перезапуск хоста: `ensureKnown` (662–676) для сессии без процесса и без `autoSleep` вызывает `markUnreadPointed(…, true)` (668) — письма указаны. Для усыплённой хостом (`autoSleep != null`) этого нет — письма не указаны и поднимают сессию.
6. Шаг 4 сна: `wake.retry` (auto-sleep-service.ts:359) → в `retry`: для сессии без процесса `pointed.clear()` (wake-service.ts:1914) и пересчёт.
7. Подъём усыплённой: `deliveryAction` при `sleeping` → `resume` (core delivery.ts:63–72) с обходом слота (wake-service.ts:1628–1630).
8. Письма, которые ждали у хоста, но не были выданы, остаются непрочитанными и поднимают сессию (inboxFenced + выход с `pointed.clear()`). Письмо, выданное за окном, отменяет сон (auto-sleep-service.ts:328).
9. Письма ожидания (`notifyWaiter`) пишутся в карту как непрочитанные и поднимают усыплённую обычным путём (auto-sleep-service.ts:374–410, 385–393).

## Open
- Не читано: sessions-service `stop` и переход в `sleeping`/`autoSleep` (core `transitionSession`) — п. Q06.2–3 и Q08.1 опираются на комментарии и вызовы.
- Не читано: core/src/mcp/tools.ts целиком (только grep), `hookedSince` (core activity.ts:731), `works.onMail`, `wake/opencode-prompt.ts`, sessions-service `launch` (где принимается решение `held`/`queued`).
- Q07: вызовы `limiter.tryTake`/`release` вне wake-service не искались; ручной Resume человека не проверен.
- Q06: `silentTurns.holdsSleep` (SilentEndings) и `compacting` — не читаны, только сигнатуры.

Coverage: partial — прочитаны все файлы подсистемы wake/sleep целиком (кроме opencode-prompt.ts); core-функции решений прочитаны целиком; остальное из перечисленного в Open — только по вызовам и комментариям.