<!-- drone 1 s-407 model=haiku addedAt=2026-11-16T17:23:11.646Z handedAt=2026-11-16T17:25:05.098Z result=done -->
Drone A (s-407), subject 9eabc014, /Users/kalmbik61/parley/pilot3-subject. Read whole: packages/host/src/sessions/sessions-service.ts (2730 строк), interrupted.ts, model-choice.ts, ready-journal.ts. Excerpts only: packages/core/src/work/launch.ts (321-322, 532, 656-663), packages/host/src/host.ts (966-967, 1499-1501), methods/sessions.ts (92, 104). Пути относительно корня копии; sessions-service.ts сокращённо SS.

Q01 — прерванные посреди хода.
- Сбор: SS:2704-2713 `collectInterrupted` → `findInterrupted` (interrupted.ts:53-86) с журналом `openEvents(...).read(sessionId)` (SS:2705-2712; ошибка чтения → null). Зовётся на старте хоста после сверки живости: host.ts:1499-1501.
- Пропуски (interrupted.ts:60-79): работа `archived` (60); сессия не `sleeping` — active/closed/pending (63); `autoSleep != null` — усыплена хостом, поднимет письмо (66); `queued != null` — ждёт слота машины (68); журнал null (74-75); пустой журнал после фильтра (79).
- Игнорируются при поиске последнего хука (76-78): `Notification` с `idle_prompt` (19-20, 14-18); `ParleyWaitStart`/`ParleyWaitEnd`/`PERMISSION_ANSWERED_EVENT` (27-30); `SubagentStart`/`SubagentStop` (36-37).
- Ход закончен, если последний оставшийся хук — `Stop` или `SessionEnd` (ENDED, interrupted.ts:12; проверка 80). Любой другой последний хук → прервана (80-81).
- `Stop` при фоновых субагентах лида всё равно считается прерванным: `hadBackgroundWork` (interrupted.ts:44-47, core `activityOf`, `task.background`, момент — последнее событие, давность не важна) — условие interrupted.ts:80.
- Список для человека: `interrupted()` отдаёт только ещё спящих (SS:2714; `stillSleeping` SS:2658-2663).
- Resume: `resumeInterrupted` (SS:2715-2728): свежая карта (2719), только `lifecycle === 'sleeping'` (2721), затем `launch(ref,'resume')` без `by` → человек (SS:2722; `options.by ?? 'human'` SS:1042, 1100). Ошибка логируется, вызывающему не возвращается (2722-2724). `autoSleep`, `queued`, журнал при подъёме не перепроверяются; дальше полный `launchHeld` (см. Q04). Поднятые refs убираются из списка (2726-2727).

Q02 — выход процесса и остановка человеком.
- Обработчик выхода: SS:710-763. Забираются `exitCauses` (713-714) и `launchActors` (715-716); снимаются токены хуков (718-719); ждётся `starting` (720); OpenCode (723-726); `finishExited` (728-738); проверка git (739-745); и только потом сторож (746-754).
- Причина: `stop(ref, cause)` пишет `exitCauses = cause ?? 'quiet'` только если процесс жив (SS:1827-1831). `'human'` — из RPC sessions.ts:92 и host.ts:966 (`stop(ref,'human')`). `'quiet'` — все служебные: смена модели (SS:1927), замена агента (2273), close (2586), закрытие в карте (2644), выключение (2695), провал записи старта (1521), провал OpenCode TUI (780).
- Решение сторожа (SS:746-754): `'human'` → `endings.stoppedByHuman(ref)`; `'quiet'` → ничего; нет причины (процесс вышел или упал сам) → `endings.exited(ref, {exitCode, signal?}, {by, runMs} | null)`. Сигнал передаётся только если не null (SS:751).
- Launch info: SS:1447 `launchActors.set(key, {by: options.by ?? 'human', startedAt})`; `runMs = Date.now() - startedAt` (SS:752). Нет записи (запуск не этим хостом) → `null`. Карта в памяти процесса, поэтому после рестарта хоста она пуста (вывод из объявления SS:601).
- Человек закрывает (`close(ref,'human')`, SS:2580-2598): сначала `stop(ref)` без причины → `quiet`, письма о Stop нет; после перевода в `closed` (SS:2592) → `endings.closedByHuman(ref)` (SS:2597). Вызов без `'human'` письма не даёт.
- Человек останавливает (`stop(ref,'human')`): письмо `stoppedByHuman` только если PTY жив на момент вызова (SS:1828-1830); лифецикл остаётся `sleeping` по выходу.
- Сбой `endings` попадает в `.catch` SS:756-758 с текстом «переход сессии в sleeping не записался» (вывод из цепочки).

Q03 — смена модели.
- `setModel` SS:1863-1931 под замком `exclusive` (SS:1867). Замок: `createSwitchLock` SS:487-500, второй вызов той же сессии → busy «Another model or effort change of this session is in progress» (SS:491). Тот же замок у `setEffort` (SS:569-570).
- Проверки: только Claude Code (SS:1874-1877); пустой `{model}` в шаблоне → bad_request (SS:1879-1880); та же модель — ничего не пишется (SS:1882).
- Effort: нет записи effort → не трогается (SS:1886-1887). Есть → сохраняется, если новая модель его поддерживает (`effortsFor`, SS:1888), иначе становится явным `null` «Default» (SS:1889). Запись через `setChoice` (SS:1925; SS:1837-1854); разговор закрывает отрезок расхода `reason: 'model'` (SS:1906-1925).
- Busy для работающего агента: `launching` → «The session is starting» (SS:1893, проверяется и без процесса). Только при живом PTY (SS:1894-1905): не `atPrompt` (SS:1897; `atPrompt` SS:466-469 — только `idle`/`unseen`; нет сведений = занят); фоновые задачи (SS:1898-1900); непосланный текст `hasDraft()` (SS:1902-1904).
- Пикап: карта пишется до остановки (SS:1925), затем `stop(ref)` (quiet, SS:1927) и `launch(ref,'resume')` (SS:1928). `launchHeld` перечитывает карту (SS:957) и передаёт сессию в план (SS:1301-1315; `options.model` не задан). Core: `planResume` берёт `options.model ?? session.model` (core launch.ts:321-322, 532); effort переотправляется при resume, т.к. Claude Code его не восстанавливает (core launch.ts:656-658, 661-663). Ошибка resume уходит вызывающему, карта уже с новой моделью (SS:1860-1861, порядок SS:1925 до 1928).
- Без живого процесса: только запись (SS:1926), следующий запуск/resume возьмёт модель. Замечание: для неживой сессии `active` без процесса busy-проверок нет (SS:1894-1905 только при живом PTY).

Q04 — порядок отказов при одном запуске существующей сессии (до создания worktree).
- `launchDetailed` SS:896-918: `afterSweep` (902); при `launching`/`closing` возврат `started` без работы (903); живой PTY → `repairLive` → `started` (904-908).
- `launchHeld` SS:931+, по порядку:
 1. readMap; сессии нет — обычная Error (957-961).
 2. `closed` → Error (965-967).
 3. `archived` → conflict (969-971).
 4. Выбор handover/fork (974-989), без отказа.
 5. `readyProvider` SS:843-858 (994): записанный удалённый провайдер → conflict; неизвестный → bad_request; неготовность → bad_request.
 6. Роль при замене (999-1032): read-only потерян → conflict с reason roleChange и notice `role-missing` (1002-1011).
 7. Доверие к папке Codex (1039-1065): `held: 'folder-trust'` (1060-1063), до бюджета.
 8. Серверы `.mcp.json` (1070-1096): `held: 'project-mcp'` только если карточка создана; `null` — решение уже есть, запуск идёт.
 9. Бюджет `reserveLaunch` (SS:1100, 656-685): `ResourceDeniedError` → `refuseLaunch` SS:623-653 → conflict `code: 'resource-budget'` (ошибка, не held/queued); для автозапуска ещё notice и письмо родителю.
 10. Ёмкость машины (SS:1104-1147): `ticket.kind === 'queue'` и класс не `engine` (1108) → `queued` (1139). Слот `start`/`overflow` берётся (1141).
 11. Worktree (SS:1153-1238): только здесь создаётся каталог; ошибка → notice `launch-failed`, письмо родителю, throw (1171-1194).
- Бюджет при очереди: `settleLaunch(...,'released')` (1111), `attemptId = null` (1112), затем запись `queued` (1113-1132) и `capacity.pump()` (1138). Блок `finally` (1555) не снимает повторно. В `createTimed` тот же резерв при `held`/`queued` снимается ещё раз (SS:1809-1811), по комментарию идемпотентно (1805-1807, не проверено в core). При `held` резерв не брался вовсе (SS:1099 комментарий; SS:1741-1745 при `awaitsConsent` резерв не берётся).
- Итог `finally` SS:1551-1568: без процесса снимается резерв (1555) и слот машины (1558).

Open:
- Q01: `activityOf` и семантика `task.background` (core) не читались; `openEvents` и форма событий журнала (core) не читались; `Stop` с фоновыми субагентами полностью зависит от core.
- Q02: реализации сторожа (`endings`) и `capacity` вне моего среза не читались; `finishExited` (core) не читался; утверждение о сбросе `launchActors` после рестарта — вывод из кода, не из теста.
- Q03: поведение CLI при `--model` на resume не проверено; core `planResume` читался по выдержкам (launch.ts:312-322, 521-536, 650-663), не целиком; поддержка модели у шаблонов без `{model}` — только по комментарию SS:1879.
- Q04: `reserveAttempt`/`settleAttempt`/`mergeQueued` и `capacity.admit` (core и `resource-policy.ts`) не читались; заявление SS:1806 о подхвате ожидающего резерва не проверено; `providerReadiness` (core) не читался.

Coverage: partial (все части Q01–Q04 отвечены по SS, interrupted.ts, model-choice.ts; открыты части выше, связанные с core и сторожем).