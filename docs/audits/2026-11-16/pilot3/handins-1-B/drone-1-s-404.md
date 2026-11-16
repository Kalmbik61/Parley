<!-- drone 1 s-404 model=haiku addedAt=2026-11-16T17:23:09.716Z handedAt=2026-11-16T17:24:42.134Z result=done -->
Срез A (sessions/), коммит 9eabc014, копия /Users/kalmbik61/parley/pilot3-subject. Читал целиком: packages/host/src/sessions/interrupted.ts (86 строк), sessions-service.ts (2731 строка, целиком), model-choice.ts (38). Для перехода в другие папки прочитаны: core/src/work/launch.ts:760-805, :321, :532; host/src/pty/pty-manager.ts:195-210, :276-290. Ничего не менял.

Q01 — после перезапуска хоста, «прерванные посреди хода»
1. Список собирает collectInterrupted() → findInterrupted() по снимку работ; сессии с lifecycle ≠ 'sleeping' пропускаются, как и archived-работы. [interrupted.ts:58-63; sessions-service.ts:2704-2713; интерфейс 315-318]
2. Пропускаются сессии с autoSleep (усыпил хост, будить будет письмо) [interrupted.ts:64-66] и с queued (запуск ждёт слота машины) [interrupted.ts:67-68]. Сессия без журнала (events null) пропускается [interrupted.ts:74-75].
3. Из журнала выбрасываются строки: Notification idle_prompt [interrupted.ts:19-20, 77]; ParleyWaitStart, ParleyWaitEnd, PERMISSION_ANSWERED_EVENT [interrupted.ts:27-30]; SubagentStart/SubagentStop [interrupted.ts:36-37]. Последним остаётся последняя оставшаяся строка; пустой журнал — не прерван [interrupted.ts:76-79].
4. Ход закончен, если последняя оставшаяся строка — Stop или SessionEnd [interrupted.ts:12, 80]. Исключение: последний Stop при фоновых задачах в журнале — прерван [interrupted.ts:80]. hadBackgroundWork берёт последнее событие ПОЛНОГО журнала (включая отфильтрованные строки) и activityOf(...).tasks с background [interrupted.ts:44-47].
5. Окно видит список через interrupted(): фильтр stillSleeping (lifecycle sleeping на момент запроса) [sessions-service.ts:2658-2663, 2714].
6. resumeInterrupted(refs): для каждого — свежее readMap, пропуск, если не sleeping [sessions-service.ts:2715-2721]; затем launch(ref,'resume') — ошибка только логируется, наружу не уходит [:2722-2724]. Повторно НЕ проверяются autoSleep и queued (проверены только при сборе). Список прерванных очищается от запрошенных [:2726-2727].
7. Дальше launch → launchDetailed/launchHeld проверяют заново: closed, archived, готовность провайдера и т.д. (см. Q04).
Open: кто и когда вызывает collectInterrupted/resumeInterrupted (на старте, после сверки живости) — ожидает подтверждения в вызывающем коде вне среза (sessions-service.ts:315-316 — только комментарий); journal read (openEvents) — не читал в core.

Q02 — выход процесса и остановка
1. Событие pty 'exit' приходит из ptyProcess.onExit → notifyListeners [host/src/pty/pty-manager.ts:198-210]; подписка сессий [sessions-service.ts:710].
2. Причина остановки пишется до pty.stop: stop(ref, cause) кладёт exitCauses только если процесс существует; cause по умолчанию 'quiet' [sessions-service.ts:1827-1831]. Exit забирает и удаляет её синхронно [:713-714].
3. Кто поднял процесс: launchActors = {by: options.by ?? 'human', startedAt} при spawn [:1447]; забирается на exit [:715-716].
4. Порядок в обработчике exit: hooks.unregister и agent.unregister [:718-719]; ожидание записи старта (starting) [:720]; opencode detach/stop [:723-726]; finishExited (карта → sleeping, лог по activity.logFile) [:728-738]; checkGit [:740-744]; затем сторож тихих концовок [:746-754].
5. Причина 'human' → endings.stoppedByHuman(ref) [:747]. Причина 'quiet' (служебная: смена модели/агента, сон, архив, закрытие, выключение) → ничего [:746, 1829 комментарий и :2584-2585]. Причина не задана (процесс вышел сам) → endings.exited(ref, {exitCode, signal если не null}, launch) [:748-753], где launch = {by, runMs = now − startedAt} из launchActors или null [:752].
6. Ошибка в обработчике ловится общим catch с текстом «переход сессии в sleeping не записался» — включая сбой endings [:756-758].
7. Закрытие человеком (close(ref,'human')): сначала stop(ref) БЕЗ причины → 'quiet', письма о стопе нет; затем transitionSession 'closed' [:2586-2593]; затем endings.closedByHuman(ref) — безусловно, даже если процесса не было [:2597]. Остановка человеком (stop(ref,'human')) — письмо stoppedByHuman только если процесс был; карта → sleeping, не closed [:1827-1831, :747]. Стоп агентом через close_session (stopRetired) — 'quiet' [:2631-2651].
Open: finishExited (core) — что именно пишет в карту (sleeping/done/failed), не читал; endings.* — реализация сторожа, не читал; вызовы close/stop с by='human' из методов — вне среза.

Q03 — смена модели
1. Точка входа setModel: под замком exclusive [:1863-1867]. Замок: вторая смена той же сессии → busy «Another model or effort change … is in progress» [:476-500, 487-491].
2. Порядок проверок: нет сессии → not_found [:1871-1873]; провайдер не Claude Code → bad_request [:1874-1877]; модель не из каталога → bad_request [resolveModelChoice, model-choice.ts:21-36]; пустая модель → bad_request «does not accept a model» [:1878-1880]; та же модель → return без записи и перезапуска [:1882].
3. Effort (правило [:1885-1890]): session.effort undefined → без изменений; effort не null и есть у новой модели (effortsFor) → сохраняется; иначе → null (явный Default). null остаётся null.
4. Busy: при launching → busy «starting» (даже для спящей) [:1893]. Только для живого процесса: activity не idle/unseen → busy «Wait until the agent is idle» [:1894-1897; atPrompt :466-469 — при отсутствии activity тоже busy]; фоновые задачи → busy [:1898-1900]; непосланный текст → busy [:1902-1904].
5. Не проверяется в setModel: closing, sweeping, stuck-состояние (в runSwitch для stuck есть исключение: :2252).
6. Спящая/без процесса: только запись карты, restarted:false [:1926].
7. Живая: setChoice пишет модель/effort и закрытый отрезок (previousAgents, reason 'model', usage) [:1906-1925, :1837-1854]; затем stop(ref) (quiet) [:1927] и launch(ref,'resume') [:1928]. Новая модель попадает в команду так: launchHeld передаёт options.model только если задан [:1313], иначе planResume берёт session.model [core/src/work/launch.ts:321]. Итоговый вид: resume с флагом модели из карты (флаг в шаблоне — core:532, не полностью проверен).
8. Исход launch в setModel игнорируется: возвращается restarted:true даже при held/queued [:1928-1929]; ошибка resume уходит окну, карта уже с новой моделью [комментарий :1860-1861].
Open: setChoice вызывается без busy-проверки (кто её вызывает — sessions.setEffort, вне среза); точный шаблон флага модели в core не прочитан полностью.

Q04 — порядок проверок одного запуска существующей сессии (launchDetailed/launchHeld), до создания worktree
1. launchDetailed: ожидание уборки копии [:902]; если launching или closing — возврат 'started' молча, не held и не queued [:903]; если процесс жив — repairLive и 'started' [:905-908].
2. launchHeld: readMap; сессии нет → Error [:957-961]; closed → Error [:965-967]; work archived → HostError conflict [:969-971].
3. Замена/форк (awaitingAgent, forkWithoutFile, reforkOf) — может переписать карту [:974-989].
4. readyProvider (до бюджета, без следа в карте) → bad_request/conflict [:994; readyProvider :843-858].
5. Смена роли после замены: readOnlyLost → notice role-missing + conflict, reason roleChange [:999-1011]; иная смена роли пишется в карту [:1013-1031].
6. HELD folder-trust: только Codex, папка не доверена, есть consents → request карточки, heldKinds, return 'held' [:1039-1064]. Бюджет ещё не брался.
7. HELD project-mcp: runner.command === 'claude', есть undecided серверы → карточка; если card !== null → 'held' [:1070-1095]. card === null (решение уже есть) → запуск идёт.
8. Бюджет: reserveLaunch [:1100, :680-685]; отказ → refuseLaunch: для auto — notice и письмо родителю; затем HostError conflict code 'resource-budget' [:623-653, :681].
9. QUEUED (до worktree): capacity.admit [:1104-1106]; если ticket queue и класс не 'engine' → settleLaunch(…,'released') [:1111], attemptId = null, запись queued в карту (mergeQueued; не трогает, если closed/active) [:1113-1132], лог, capacity.pump() [:1138], return 'queued' [:1139]. Overflow — только помечает уведомление [:1142-1146].
10. Worktree: createWorktree при отказе — notice launch-failed, письмо родителю, throw [:1166-1195]. Ошибка до этого места → finally [:1555]: при !processStarted и attemptId ≠ null — settleLaunch 'released'.
11. Кто видит исход: createInteractive возвращает held/queued с причиной [:1579-1593]; create() при held/queued освобождает свой резерв (admitted) [:1804-1811] (сам launchHeld уже снял его).
Ответы на вопрос «что с резервом при queued»: резерв берётся на шаге 8 и снимается сразу перед записью очереди (шаг 9); в очереди резерва нет, поле queued хранит class/mode/by/at/reason/live/limit [:1120-1128]. При held резерв не берётся вовсе (проверки 6–7 раньше шага 8).
Open: capacity-service (admit/pump/settle, как запуск из очереди вызывает launch), resource-policy (reserveAttempt/settleAttempt), finishExited, endings-сервис — вне среза, не читал. Также не читал остальные методы, вызывающие launch (с by/launchClass), и packages/host/src/pty/pty-manager.ts целиком.

Coverage: partial — прочитаны все файлы среза sessions/ (кроме тестов по правилам, provider-env.ts, transcript-carry.ts, agent-skills.ts, ready-journal.ts, resource-budget.test.ts не требовались и не открывались) и четыре внешних места; не прочитаны core-функции резерва, ёмкости, сторожа, finishExited, methods/*-обработчики и вызывающие коды collectInterrupted/resumeInterrupted/setChoice. Вопросы Q01–Q04 отвечены по срезу; открытые части перечислены выше.