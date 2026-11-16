<!-- drone 2 s-409 model=haiku addedAt=2026-11-16T17:23:16.504Z handedAt=2026-11-16T17:27:27.453Z result=done -->
Q05–Q08, снимок Parley 9eabc014 (/Users/kalmbik61/parley/pilot3-subject), только чтение. Тесты не читались.

**Q05. Возврат после сброса лимита: что останавливает печать, порядок, судьба эпизода, счётчик**
- Срок: `limitReturnDue` — время сброса + `LIMIT_RETURN_GRACE_MS` (120 с), без времени сброса — `since` + `LIMIT_RETRY_MS` (15 мин) — `packages/host/src/wake/limit-return.ts:20-23`; константы `packages/core/src/work/stuck.ts:36,38,40`. Окно свободно по данным провайдера — `limit-return.ts:26-34`, `wake-service.ts:1433-1444`. Ступени таймера по 60 с — `wake-service.ts:197, 1333-1357`.
- Эпизод ведёт `trackLimit` (`wake-service.ts:1366-1446`); нужен `need.kind === 'limit'` у активной сессии с живым процессом (1373-1397).
- Порядок остановок в `tryLimitReturn` (`wake-service.ts:1454-1506`):
  1. пауза, свой ввод в полёте (`typing`/`inFlight`) — молча ждём, 1463;
  2. активность не `idle`/`unseen` — ждём, 1464;
  3. `returnBlock` (`limit-return.ts:43-51`): сначала `repeated` (счётчик ≥ `LIMIT_RETURNS_MAX`=2), затем `menu` (на экране строка «Wait here, then continue automatically», `limit-return.ts:14`), затем `draft` (черновик человека или наш `leftover`), 1466-1470 → уведомление `limit-return-blocked` с причиной (`limit-return.ts:54-63`, `wake-service.ts:1472-1479`);
  4. Codex без режима вставки — повтор через 200 мс до 15 раз, 1483-1486;
  5. смена модели/effort, ползунок, сжатие — повтор, 1487-1490 (`choiceNow`, 565-567).
- При печати (`beforeEnter`, `wake-service.ts:1034-1053`) Enter отменяется, если: агент `blocked`, идёт смена; Qwen заблокирован или в ходе (ждёт конца хода, 1040-1043); Codex занят или (не `returnTurn === 'pending'` и письма прочитаны) — 1044-1052. Исход `input` (человек печатает) — 1189-1197; `blocked` — 1198-1238; оба вызывают `abandonReturn` (1249-1251).
- Эпизод: при блокировке `settledAt` ставится сразу (1473) и повтора в этом эпизоде нет (`trackLimit` пробует только при `settledAt === null`, 1445). После успешной печати `settledAt` (1502), `returns += 1` (1503), `returnTurn = 'pending'` (1504). Эпизод снимается, когда `need` пропал (1395) или появился с более поздним `since` — новый эпизод (1401-1410). По коду, после отмены Enter (`withdrawn`, 1209-1223) или `input` эпизод уже `settled` и в том же эпизоде не повторяется.
- Счётчик `returns` (`wake-service.ts:333, 486`) сбрасывается: ходом человека при отсутствии возврата в полёте — 1384-1386; концом хода возврата без `need` — 1387-1389; `switched` — 1932. Выход процесса (2023-2027) его не трогает.

**Q06. Отмена сна в последний момент; что после остановки; реакция давления и слота**
- Предпроверки вне замка: `consider` — замена агента и `autoSleepPending` (`auto-sleep-service.ts:446-452`); `planFor` — сторож тихих концов `holdsSleep` (250) и `autoSleepVerdict` (253-268; блоки `auto-sleep.ts:97-132`: `off`, `not-active`, `keep-awake`, `pending`, `no-hooks`, `need`, `background`, `draft`, `pointer`, `unread`, `compacting`, ожидание `wait_for`, `too-soon`).
- Под замком карты в шаге 1 (`sleepSession`, `auto-sleep-service.ts:317-333`) отмена по причинам: `not-active`, `pending`, `keep-awake`, `switching`, `unread` (непрочитанные есть), `delivered` (`deliveredSince`, `auto-sleep.ts:158-164`: `readBy` позже начала простоя). Отметка `autoSleepPending` ставится в строке 330 только если отмены не было.
- Шаг 3 (`auto-sleep-service.ts:350-354`): если после `sessions.stop` сессия осталась `active`, `dropMark` (277-292) снимает отметку, пишет warn «агент не уснул…», возвращает `false`. Письмо будильнику (`retry`) не идёт.
- Выбор кандидата: для слота и давления — кандидаты по самому давнему простою (`candidates`, 497-505); `sleepOne` (512-528) переходит к следующему после отмены, каждого перепроверяя `candidatePlan`. Давление: `lastPressureSleepAt` ставится только при успехе (534-548, строка 542) — отмена темп не тратит. Слот: `freeSlot` (628-639) возвращает `false`; вызывает `capacity-service.ts:276-294` (вызов 287), пересчёт — `machineAdmission`. `slotCandidate` (641-645) — проверка перед очередью, `capacity-service.ts:445`.
- Просьба `requestSleep`: `requested` удаляется только при успехе (`consider`, 460), значит отмена оставляет просьбу на следующий проход.

**Q07. Лимит подъёмов письмами**
- Счёт: `ResumeLimiter` (`packages/host/src/wake/resume-limiter.ts`) — на каждую сессию, скользящий час (`HOUR_MS`, 13), `tryTake` 28-36 (разрешает, если за час меньше `rate`), `release` 43-45 (снимает последний подъём). `rate` = `resumeRate`, по умолчанию 6 (`packages/core/src/config.ts:145`, env `RESUME_RATE`, 176, разбор 411-415). Лимитер создаётся с замыканием на переменную, которую читают при `start()` (`wake-service.ts:441-442, 1950-1953`).
- Берётся только при выбранном подъёме (`tryTake` в 1630), когда `deliveryAction` дал `resume` (`packages/core/src/work/delivery.ts:262-270`).
- Не расходуют: подъём сессии, остановленной хостом (`autoSleep != null`, `wake-service.ts:1629-1630`); отложенные (`trustHeld`, `queued`, отказ бюджета меньше `BUDGET_RETRY_MS`=30 с, 1618-1621, 174) — `tryTake` короткозамыкается; подъём без провайдера или id сессии — слот возвращается (`releaseSlot`, 826).
- Счётчик в карте (второй, переживает перезапуск): `sessions-service.ts:675` передаёт `sessionResumeRate` для `by === 'wake'`; `resource-policy.ts:361-363` считает `resume`-резервы не `released` за час (`resumesInWindow`, 294-298; `RESOURCE_WINDOW_MS`, `resource-policy.ts:21`, `within` 200); отказ — `ResourceDeniedError` → `HostError` `resource-budget` (`sessions-service.ts:647`, `refuseLaunch` с 623) → будильник `isResourceDenial` (`wake-service.ts:378-379, 885`) → ветка бюджета (885-894).
- Сообщение человеку: `limitNotice` (`wake-service.ts:679-686`) — уведомление `resume-limit` «was not resumed: the hourly resume limit is reached, messages are waiting», не чаще раза в час на сессию (`LIMIT_NOTICE_EVERY_MS`, 172; карта `limitNoticedAt`, 443, в памяти — сбрасывается перезапуском). Вызовы: 1640 (лимит, без удержания), 893 (бюджет — текст «the workspace budget is exhausted»).
- Возврат единицы: `releaseSlot` (790-795) — при отсутствии способа подъёма (826), при `held`/`queued` (865), при отказе бюджета (888). Не возвращается при сбое подъёма (`resumeFailed`, 896-897). В карте резерв `released` — при закрытии сессии (`settleByEvidence`, `resource-policy.ts:245-262`), `settleAttempt` (396-410).

**Q08. Почему письма после сна хоста поднимают сессию, а после Stop человека — нет**
- Маркер: `autoSleepPending` → `autoSleep` при уходе в `sleeping` (`core/src/work/map.ts:296-303`); снимается при `active`/`closed` (300-305).
- Ограда для выдачи писем: `inboxFenced` (`core/src/work/auto-sleep.ts:172-174`) — `check_inbox` отдаёт пусто, не помечая (`core/src/mcp/tools.ts:1429-1431`), `wait_for` отвечает `running` (1127-1133).
- Правило будильника для спящей (`delivery.ts:262-270`) маркер не смотрит — поднимает любое непрочитанное письмо.
- Разница — в учёте «указанных» писем в хосте (`wake-service.ts`):
  - Выход процесса (`exit`, 2023-2041): `hostSleeps` (645-654, `autoSleepPending` или `autoSleep`) → `pointed.clear()` (2040); для Stop человека — `markUnreadPointed` (630-638, 2041): письма, непрочитанные при выходе, считаются указанными и не будят.
  - Шаг 4 сна (`auto-sleep-service.ts:359`) → `wake.retry` (1906-1916): у сессии без процесса `pointed.clear()` (1914) и пересчёт; подъём не режется лимитом (1629-1630).
  - Перезапуск хоста: `ensureKnown` (662-676) не помечает письма, если процесса нет и `autoSleep` есть (668) → письма поднимают сессию; для Stop человека помечает → не поднимают.
- Письма до отметки: отмена сна под замком (`auto-sleep-service.ts:327-328`) — сон не начинается.
- Stop вызывается с `cause` `human` или без (`sessions-service.ts:1827-1830`; `host.ts:966`, `methods/sessions.ts:92`); `cause` влияет только на сторож тихих концов (`sessions-service.ts:713-747`), будильник различает оба случая по маркеру.

Open:
- Q08, часть «письма вокруг момента»: между отметкой (`auto-sleep-service.ts:330`) и выходом процесса будильник не проверяет `autoSleepPending` (`wake-service.ts:1548-1766`, `delivery.ts:215-290`). Указатель может быть напечатан в ещё живую сессию; по коду защиты нет, во время выполнения не проверено.
- Q08: сессия с одной отметкой `autoSleepPending` без `autoSleep` при перезапуске хоста идёт путём Stop человека (`wake-service.ts:668` по `autoSleep == null`) — что делает с ней дальше, не прослежено.
- Q07: резерв `reserved` без свидетельства держится до часа (`resource-policy.ts:245-249`); поведение при сбое процесса не проверено выполнением.
- Q05: зависимость от текста меню Claude Code (`limit-return.ts:9-13`) и гонка с собственным автопродолжением Claude Code — по коду, не проверено на живой сессии.
- Не читался `packages/host/src/sleep/descendants.ts` (вне вопросов).

Coverage: covered (все части Q05–Q08 с путями и строками; открытые пункты выше — неподтверждённые выполнением места, не пропущенные части вопросов).