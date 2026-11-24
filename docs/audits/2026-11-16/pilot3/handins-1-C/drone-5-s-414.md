<!-- drone 5 s-414 model=haiku addedAt=2026-11-16T17:28:31.789Z handedAt=2026-11-16T17:30:48.892Z result=done -->
Q01, Q02, Q04 по срезу packages/host/src/sessions/ at 9eabc014 (копия /Users/kalmbik61/parley/pilot3-subject), только чтение. Пути относительно корня копии. Тесты не читались.

## Q01 — прерванные посреди хода после падения хоста

**Вызов.** host.ts:1499-1501 вызывает `sessionsService.collectInterrupted()` (ошибка только логируется). SS:2704-2713 → `findInterrupted(works.snapshot().entries, …)` с читателем журнала `openEvents(...).read(sessionId).catch(() => null)`. Ожидание с предшественника подтверждено.

**Пропуски (interrupted.ts:58-79):**
- `status === 'archived'` — 60 (подтверждено).
- `lifecycle !== 'sleeping'` — 63 (подтверждено).
- `autoSleep != null` — 66 (подтверждено).
- `queued != null` — 68 (подтверждено).
- журнал `null` (нет файла или ошибка чтения, `catch → null`) — 74-75; ошибка чтения тоже даёт `null`, SS:2711 (уточнение).
- пустой журнал после фильтра — 79 (подтверждено).

**Игнорируемые строки (interrupted.ts:76-77)** — исключаются только при поиске ПОСЛЕДНЕГО события:
- `Notification` с `notificationType === 'idle_prompt'` — 19-20 (подтверждено).
- `ParleyWaitStart`, `ParleyWaitEnd`, `PERMISSION_ANSWERED_EVENT` (`'ParleyPermissionAnswered'`, events.ts:144) — 27-30 (подтверждено).
- `SubagentStart`, `SubagentStop` — 36-37 (подтверждено).

**Правило «прерван» — ИСПРАВЛЕНИЕ.** Предшественник написал «конец = Stop или SessionEnd». Точно: interrupted.ts:12 `ENDED = {'Stop','SessionEnd'}`, interrupted.ts:80 `if (!ENDED.has(last.name) || (last.name === 'Stop' && hadBackgroundWork(journal))) found.push(ref)`. Значит прерванной считается сессия, у которой последнее значимое событие — ЛЮБОЕ, кроме Stop/SessionEnd. Сюда попадают:
- `StopFailure` (не в ENDED, хотя activity.ts:502-507 считает его концом хода) — ИСПРАВЛЕНИЕ, см. ниже;
- `SessionStart` (процесс стартовал, промпта не было, `Stop` не пришёл) — вывод из кода, не проверено на практике;
- `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PermissionRequest`, `Notification` с не-idle типом — все прерваны.

**Когда завершённый ход считается прерванным (уточнено):** только при `last.name === 'Stop'` И `hadBackgroundWork(journal)` (interrupted.ts:44-47):
- `journal` — полный журнал, а не отфильтрованный;
- `now` = время последней СЫРОЙ строки журнала (`journal.at(-1)?.at`), поэтому порог `backgroundHoldMs` (час, activity.ts:273) не срабатывает: `now − quietAt = 0` (activity.ts:634);
- `activityOf` возвращает `tasks.some(task => task.background)`.

Точное условие фоновой работы из `activityOf` (activity.ts:300-308, 425-431, 523-526, 661-666):
- берётся последний снимок `background_tasks` — последнее событие с `backgroundTasks !== null` (425-428; пустой список стирает);
- в нём должен быть субагент `type === 'subagent' && status === 'running'` (activity.ts:230-231), не остановленный позже: `SubagentStop` убирает id (523-526);
- `SessionStart` сбрасывает `background` и `runningTasks` (419-421);
- тогда `phase` ушёл из `ended` в `working` (661-666), и задача попадает в `tasks` с `background: true` (tasksOf, activity.ts:240-266).
Итог: Stop-последний + живой фоновый субагент в последнем снимке без срока давности. Остальные виды фоновых задач (shell, monitor) не держат ход (activity.ts:226-231, 327-331) и сюда не входят.

**Что «прерван» не проверяет:** фильтр `isIdleNotice` / wait / subagent применяется только к `last`; `hadBackgroundWork` видит полный журнал, так что `SubagentStop` или `idle_prompt` после Stop не отменяют проверку фона.

**Возврат к списку (SS:2714):** `interrupted: () => interruptedRefs.filter(stillSleeping)`; `stillSleeping` (SS:2658-2663) = `lifecycle === 'sleeping'`. Подтверждено.

**Подъём по согласию (SS:2715-2728), уточнено:**
- свежий `readMap` (SS:2719); `session?.lifecycle !== 'sleeping'` → `continue` (2721). Повторно проверяется ТОЛЬКО lifecycle: `autoSleep` и `queued` при подъёме не перепроверяются, но и не нужны (их пропуск ставится на сборе).
- `launch(ref, 'resume')` (2722) без `by` — `options.by ?? 'human'` в launchHeld (SS:1043, 1073, 1447).
- ошибка → `host.log.error` (2722-2724).
- `asked` убирает ВСЕ запрошенные ссылки из `interruptedRefs` (2726-2727), даже неудавшиеся.
- весь путь запуска (бюджет, очередь машины, согласие на папку) выполняется заново — см. Q04.

Открыто в Q01: чтение журнала (`openEvents`, events.ts) не читал — только его контракт `null`.

## Q02 — выход процесса и сторож тихих концовок

**Обработчик выхода (SS:710-763) — подтверждено.**
- `exitCauses` объявлен SS:599 (`Map<string,'human'|'quiet'>`); в обработчике `cause` берётся и удаляется (713-714).
- `launchActor` берётся из `launchActors` и удаляется (715-716).
- `finishExited` (728-738) ждёт `starting`, затем пишет `sleeping` и итог.
- решение (746-754):
  - `cause === 'human'` → `endings?.stoppedByHuman(ref)` (747);
  - `cause === undefined` → `endings?.exited(ref, {exitCode, signal?}, launchActor ? {by, runMs: Date.now() − startedAt} : null)` (748-754);
  - `cause === 'quiet'` → ничего.

**Откуда причина (уточнено):**
- `stop(ref, cause?)` (SS:1827-1835): `exitCauses.set(refKey, cause ?? 'quiet')` ТОЛЬКО если `pty.get(ref) !== undefined` (1828-1829). Подтверждено.
- `'human'` приходит из:
  - `sessionsStop` → `sessionsService.stop(ref,'human')` — methods/sessions.ts:92 и host.ts:966 (подтверждено);
  - `close(ref,'human')` НЕ передаёт cause в `stop` — см. ниже.
- Служебные остановки — `quiet` без письма: `stopRetired` (SS:2644), `stopAll` (SS:2694), остановка без процесса после провала записи старта (SS:1521), OpenCode (SS:780), замена модели и агента (через `stop` без cause).

**`launchActors` (SS:601, 715-716, 1447) — подтверждено.**
- `launchActors.set(key, {by: options.by ?? 'human', startedAt})` ставится ТОЛЬКО в ветке spawn `launchHeld` (1439-1447), после `pty.start`.
- `repairLive` (SS:864-887) процесс не запускает и `launchActors` не заполняет → для такого процесса launch = `null` (уточнение: это не «не запущен хостом» вообще, а «не запущен этим вызовом launchHeld»).
- `runMs` = `Date.now() − startedAt` (SS:752).

**Закрытие человеком vs остановка человеком (SS:2580-2598; host.ts:967 closeSession → `close(ref,'human')`):**
- `close` вызывает `stop(ref)` БЕЗ cause (SS:2586) → exitCause `quiet` → exit-обработчик ничего не шлёт (подтверждено предшественника, уточнено по коду).
- затем `closing` до `closed` (2587-2593), далее `closedByHuman` ТОЛЬКО при `by === 'human'` (2597).
- `stop` (человек) → `stoppedByHuman` из обработчика выхода (747); `close` (человек) → `closedByHuman` из `close` (2597). Разница: `stop` даёт письмо о Stop после выхода, `close` — о закрытии, без письма о выходе.

**Сторож — silent-endings.ts (прочитан целиком, 181 строка).**
- `exited(ref, exit, launch)` (168-174): если `launch.by === 'wake' && launch.runMs < EARLY_EXIT_MS (5000)` → `forget`, письма нет (169-172; «did not resume» — забота будильника); иначе `tell(ref, {kind:'exit', exitCode, signal?})` (173). `launch === null` тоже даёт письмо.
- `stoppedByHuman` → `tell(ref,{kind:'stop'})` (175); `closedByHuman` → `tell(ref,{kind:'close'})` (176).
- `tell` (101-106): `forget(ref)` (102), затем `write` → `updateMap` → `tellSilentEnding` (84-93, 103-105). `write` ничего не делает после `stopped` (85).

**Ядро — core/src/work/silent-endings.ts `tellSilentEnding` (прочитано полностью, функция):**
- нет сессии или она в рое → `false`;
- состояние: `exit` → `lifecycle === 'sleeping' && autoSleep == null`; `stop` → `sleeping`; `close` → `closed`;
- `hasCurrentResult` → `false`; `told` уже содержит вид → `false`;
- получатели: `reportRecipients` без тех, кто ждёт `wait_for` при `close`; пусто → `false`;
- записывается `silentEnding.told` и письмо `note`.
Итог: письмо уходит, только если сессия в нужном состоянии, не отчиталась и вид ещё не посылался.

Открыто в Q02: `lastTaskLetter`, `reportRecipients`, `markFor`, `hasCurrentResult` (core silent-endings.ts) — не читал.

## Q04 — порядок отказов одного запуска и бюджет при очереди

**Порядок в `launchHeld` (SS:931-1238) — подтверждено и дополнено:**
1. `afterSweep` и ранний возврат `started` при `launching`/`closing` (SS:902-903) и живом PTY через `repairLive` (905-908) — не отказ.
2. `readMap`; нет сессии → Error (957-961).
3. `closed` → Error (965-967).
4. `archived` → HostError conflict (969-971).
5. переход handover/fork (974-989): `recollectHandover`/`reforkOf` — не читал.
6. `readyProvider(provider, true)` (994; 843-858): нет записи → conflict (847-849), не готов → bad_request (856). До карты и резерва.
7. роль при замене (999-1032): `readOnlyLost` → conflict (1011), роль не трогается; иначе роль молча чинится и уходит уведомление (1013-1031).
8. Codex, папка не доверена → `held: 'folder-trust'` (1039-1063).
9. `.mcp.json` Claude-семейства с решением не принятым → `held: 'project-mcp'` (1070-1095).
10. бюджет `reserveLaunch` (1100; 656-685). `ResourceDeniedError` → `refuseLaunch` (623-653): уведомление и письмо родителю только при `by === 'auto'` (630-644); HostError `conflict` с `data.code = 'resource-budget'` (646-652).
11. машина `capacity.admit` (1104-1147):
   - `queue` (и класс не `engine`, 1108) → `settleLaunch(…,'released')` (1111), `attemptId = null` (1112), запись `queued` (1113-1132), `queued = true`, `capacity.pump()` (1138), `return 'queued'` (1139);
   - `start`/`overflow` → `machineReserved = true` (1141), `overflow` → уведомление `machine-over-limit` после старта (1142-1146, 1529-1531).
12. worktree (1153-1238), скилл (1242), PARLEY.md (1244), хуки (1260), spawn (1435-1447), запись старта (1490-1501).

Held (шаги 8-9) стоят ДО бюджета — удержанный запуск бюджет не занимает и ничего не создаёт (комментарий 1034-1036).

**Бюджет при очереди (подтверждено, уточнено):**
- резерв `reserveAttempt` берётся на шаге 10 (SS:1100): сначала проверка порогов и только потом запись `reserved` (core resource-policy.ts:338-396).
- на шаге 11 при `queue` резерв ОСВОБОЖДАЕТСЯ `settleAttempt(…,'released')` (SS:1111 → SS:688-699 → core resource-policy.ts:403-415, state `released`, `settledAt`). Снятый резерв выпадает из окна запусков (`launchAttempts`, resource-policy.ts:288-291) и из занятых слотов (`occupied`, 280-282).
- `capacity.admit` при `queue` не добавляет ключ в `reserved` (capacity-service.ts:300-304): слот машины тоже не занят.
- итог: очередь не держит ни резерва бюджета, ни слота машины, ни worktree.
- `settleLaunch` ошибку ловит и только логирует (SS:696-698). Если запись не прошла, резерв остаётся `reserved` и занимает слот параллельных сессий. `attemptId` уже `null`, поэтому `finally` (1555) его не снимет. Вывод из кода (не проверено на практике): следующий `reserveAttempt` той же сессии вернёт этот же ожидающий резерв (resource-policy.ts:345-351), то есть самоисправление при повторном запуске.
- Насос: `capacity-service.ts:379-381` `launchFromQueue` → `deps.launch` = `sessionsService.launch` (host.ts:755) — полный путь заново, бюджет проверяется снова. При отказе бюджета `isResourceDenial` (capacity-service.ts:137-138) → `pause` на `BUDGET_BACKOFF_MS = 30 000` (57; 374-376; 387-389); запись очереди остаётся.
- `createTimed`: при `queued` строка 1809-1811 вызывает `settleLaunch` ещё раз; резерв уже `released`, `settleAttempt` возвращает `false` (resource-policy.ts:411), поэтому двойное снятие безвредно — комментарий 1805-1807 ПОДТВЕРЖДЁН. Id совпадает, потому что `reserveLaunch` берёт ожидающий резерв той же сессии (345-351).

**Поправка к предшественнику:** в `createTimed` без `queued` и без `held` резерв `admitted` сохраняется до старта; при ошибке `launchHeld` его снимает `finally` (1555), затем 1816 — повторно, без эффекта.

Открыто в Q04: `inputOf`, `machineAdmission`, ветви решения `queue` (capacity-service.ts) — не читал полностью; `recollectHandover`/`reforkOf`/`awaitingAgent` — не читал; `providerReadiness` — не читал; `settleLaunch` при падении карты — путь восстановления не проверен.

Open: Q01 — журнал `openEvents` (events.ts) не читан, только контракт `null`. Q02 — helpers core silent-endings (`lastTaskLetter`, `reportRecipients`, `markFor`, `hasCurrentResult`) не читаны. Q04 — `capacity.admit` внутренности (`inputOf`, `machineAdmission`), `pump` по ветвям, handover-переход (974-989), `providerReadiness` не читаны.

Coverage: partial (Q01 — covered по коду сессий и activityOf; Q02 — covered по обработчику, сторожу и tellSilentEnding, helpers ядра открыты; Q04 — covered по порядку и бюджету, внутренности допуска машины открыты).