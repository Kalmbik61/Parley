# Ревью «Замена агента на месте» (feat/session-takeover)

Дата: 2026-10-31. Критик: s-170 (Opus). Предмет: `git diff origin/master...627ad3ba` — этап 1 (T1–T9, T13–T15) и дельта
T10, T11a, T11b. Спека: `docs/specs/2026-10-30-session-takeover-design.md`.

Проверка: `pnpm build` зелёный; host `sessions-service.switch`, `wake-service`, `stuck-service`, `consents/*`,
`agent/switch-endpoint` — 129 тестов зелёные. Найденное ниже тестами не покрыто (в одном случае тест прячет дефект
моком). Порядок — по убыванию серьёзности: 1 blocker, 5 major, 7 minor.

## Blocker

### 1. «Deny» на карточке папки после перезапуска хоста закрывает заменённую сессию

`host/src/sessions/sessions-service.ts:1910-1931` (`clearStaleSwitches`) + `host/src/consents/held-launches.ts:44-52`.

Сценарий: замена на Codex в проекте без доверия → `held`, `switching` в карте, удержание лежит в `consents.json`
(переживает перезапуск, таймаута нет). Хост перезапускается (обновление, сбой) → `clearStaleSwitches` снимает
`switching`. Человек жмёт Deny на всё ещё висящей карточке → `refuseLaunch`: `hold.mode === 'launch'`, `switching` уже
`null` → ветка новой сессии: `setResult(failed)` и `deps.close(ref)`. Сессия-ведущий с комнатами, детьми и почтой
закрыта — ровно то, чего человек просил не делать (раздел 9, ответ 5).

Исправление: в `refuseLaunch` отличать замену не по `switching`, а по самой сессии — например, `previousAgents`
непуст и `providerSessionId === null` (как `awaitingAgent`) или `lifecycle !== 'pending'`; закрывать только сессию,
которая ещё ни разу не запускалась. Тест: held → `clearStaleSwitches` → deny → сессия не закрыта.

## Major

### 2. Причина замены всегда `manual` вместо `limit`/`sign-in`

`sessions-service.ts:1690-1696`. `endBySwitch` (stuck-service, `session.stuck = null`) выполняется **до** перечитывания
карты, и `switchReason(stopped, …)` смотрит уже снятый `stuck`. Итог для сессии в лимите: `previousAgents[].reason =
'manual'`, строка ленты «(Claude Code 2: replaced)», письмо ведущему «… was replaced» вместо «hit its usage limit»,
заголовок пакета «the human switched the agent», `transcriptNote` с тем же. Выход процесса через stuck-service тоже
снимает `stuck` у неактивной сессии — так что дефект есть и без `endBySwitch`. Тест
`sessions-service.switch.test.ts:270-293` зелёный только потому, что мок `endBySwitch` (`:138`) карту не трогает.
`resetsAt` автор уже берёт с запасным `session.stuck` — причину надо так же.

Исправление: `switchReason(session, registry)` по снимку до `stop`/`endBySwitch` (или вычислить до них). В тест —
мок `endBySwitch`, который снимает `stuck` в карте, как настоящий.

### 3. Будильник может уронить хост: `void checkProvider(...)` без обработки отказа

`host/src/wake/wake-service.ts:957` (вызов) и `:910-915`. `loadProviders()` бросает на битом `~/.parley/providers.json`
(`core/src/providers.ts:1253-1263`: «cannot be parsed», `checkShape`). Промис из `void checkProvider` никем не ловится,
обработчика `unhandledRejection` в хосте нет (`grep` по `packages/host/src` — только SIGTERM/SIGINT), хост — обычный
node (`desktop/src/main/host-launcher.ts`), значит необработанный отказ завершает процесс. Пересчёт идёт для каждой
спящей сессии с непрочитанным на каждом изменении карты → хост падает на старте снова и снова, пока человек не
починит файл. До T14 тот же `loadProviders` в `resumeSession` был внутри `try`.

Исправление: `void checkProvider(...).catch(log)`; при ошибке реестра — не публиковать `provider-missing`, а вести
себя как раньше (или считать провайдера присутствующим). Заодно: `loadProviders` читает три файла на каждый
пересчёт каждой такой сессии — кэш по mtime или по событию `providers.changed`.

### 4. «Default» модели и effort в диалоге и в карточке T10 перебивает умолчание роли

`desktop/.../SwitchAgentDialog.tsx:124-125` всегда шлёт `model: shownModel` (`null` при «Default») и `effort: null`;
`consents-service.ts:268` шлёт `model: card.model` (`null`, когда агент модель не указал). Хост пишет `session.model =
null` / `effort = null` (`agent-switch.ts`, `applyAgentSwitch`), а `resolveRoleChoice` (`core/src/roles/catalog.ts:134`)
при `choice.model !== undefined` берёт это значение, а не модель тира роли. Пример: критик (`builtin:critic`, тир
senior → Opus) переводится на `custom-claude-2` с «Default» → стартует на умолчании CLI, не на Opus; effort роли тоже
теряется. Спека 6.11: «без выбора — умолчание роли». `NewSessionOrRoomDialog` шлёт модель только при
`row.modelTouched`.

Исправление: в диалоге не передавать `model`/`effort`, если человек их не трогал (как в «New session»); в карточке
T10 — `model: undefined` при `null`. Тест: замена builtin-роли без выбора модели → в карте нет `model`/`effort`.

### 5. Отказ запуска после согласия на папку оставляет `switching` навсегда

`sessions-service.ts:1095-1103` (`launchHeld`: `finishSwitch` только при успехе, в `catch` — только уведомление) +
`held-launches.ts:32` (`continueLaunch` → `launch()`). Замена → Codex `held` → Allow → запуск падает (бюджет работы,
нет бинаря, `spawn-budget`, сеть) → `switching` остаётся. Следствия до ручного Resume или перезапуска хоста: будильник
пропускает сессию и публикует «resuming» (письма не будят), `wait_for` ждущих никогда не вернёт состояние
(`finishedState` → `null`), новая замена — `busy` «already continuing», баннер «Switching to …» висит. Спека 5.3 п. 9:
при отказе запуска `switching = null`.

Исправление: в `catch` `launchHeld` (или в `launch()`) при `session.switching != null` снимать его (`dropSwitch`) и
звать `wake.switched(ref)`. Тест: held → allow → запуск бросает → `switching` снят, письмо поднимает сессию.

### 6. T10: «Allow» почти всегда кончается `busy` для работающей цели

`consents-service.ts:268` вызывает `switchAgent` без `force`. Главный сценарий 5.5 — цель сама просит замену «пока её
лимит близок» (или ведущий просит за работающего участника): в момент Allow цель в ходе или ждёт в `wait_for` →
`atPrompt` ложно → `busy` (`sessions-service.ts:1667-1675`). Карточка уже решена (`trimDecided`), человек получает
уведомление «failed: Wait until the agent is idle», просившему уходит письмо, и замену приходится заново делать
диалогом. Застрявшая в лимите проходит, но это не случай «заранее».

Исправление (решает лид/человек): Allow на карточке = согласие остановить агента (`force: true`), текст карточки
об этом говорит; либо при `busy` карточка не закрывается, а открывает диалог с «Stop and continue».

## Minor

### 7. Пути отказа не сбрасывают состояние будильника

`wake.switched(ref)` зовётся только из `finishSwitch` (`sessions-service.ts` — успех). На отказе запуска после замены
(`dropSwitch`, шаг 9), на Deny согласия (`held-launches.ts:48`) и в `clearStaleSwitches` будильник держит состояние
прежнего агента. Конкретно: будильник начал `resumeSession` (ждёт `loadProviders`/`journalLength`), замена заняла
`launching`, `sessions.launch` вернул поддельное `started` → письма помечены `pointed` (при `{prompt}`) → замена
падает → эти письма больше не указываются до перезапуска хоста. Исправление: `wake.switched(ref)` на всех путях
снятия `switching`.

### 8. Почта не поднимает сессию, ждущую нового агента

`wake-service.ts:556`: `providerSessionId === null` → `resumeUnavailable`, ожидание показывается как обычное
`sleeping`. После отказа запуска (шаг 9), Deny согласия или оборванной замены у сессии `providerSessionId = null`, и
путь `awaitingAgent` в `launchHeld` (запуск с пакетом) достижим только ручным Resume. Отправители не узнают, что
письма ждут человека. Исправление: будильник для `awaitingAgent` зовёт `sessions.launch(ref, 'resume')` (его
`launchHeld` сам переведёт в `launch` с пакетом) или публикует отдельное ожидание.

### 9. Пакет, собранный заново, теряет хвост разговора

`sessions-service.ts:1477-1500` (`recollectHandover`) → `core/src/work/handover.ts:269`: хвост ищется по
`session.providerSessionId`, а он после `applyAgentSwitch` уже `null`. После перезапуска хоста (оборванная замена,
согласие Codex через перезапуск) новый агент получает пакет без хвоста, хотя `previousAgents.at(-1).providerSessionId`
и транскрипт на диске есть. Исправление: передать в `collectHandover` id разговора прежнего агента явно (из привязки).

### 10. Форк, не записавший файл, оставляет висячий id и голый бриф

`sessions-service.ts:1761` + `core/src/work/launch.ts:289-294`. Если процесс форка запустился (`started`), но вышел до
записи `<F>.jsonl` (аккаунт цели сразу в лимите или на входе, сбой CLI в pty — интерактивный режим T0 не проверял,
5.4.1 п. 5), в карте `providerSessionId = F`. Следующий Resume: `claudeConversationExists(F)` → нет → свежий запуск
по брифу с тем же id, а `awaitingAgent` ложно → ни пакета, ни разговора. Копия `<from>.jsonl` в папке цели остаётся
навсегда (`watchFork` сдаётся через 10 мин, `clearStaleSwitches` ждёт файл форка). Исправление: при запуске, когда
файла `providerSessionId` нет, а последняя привязка `carried: 'transcript'`, — повторить форк от
`last.providerSessionId` или откатиться к пакету передачи.

### 11. Проверки занятости смотрят на устаревший снимок карты

`sessions-service.ts:1635` читает карту, затем идут `resolveModelChoice`, `readyProvider` (проба версии CLI, секунды),
`loadProviders`, и лишь потом `const stuck = session.stuck?.kind …` (`:1667`) по старому снимку. Лимит сбросился,
будильник вернул агента к работе за время пробы → `stuck` по снимку истинен → проверки «у приглашения / фоновые
задачи / черновик» пропущены → работающий агент гасится посреди хода без `force`. Исправление: перечитать сессию
перед проверками (между ними и `launching.add` по-прежнему без `await`).

### 12. Ограда не останавливает уже идущий `wait_for` прежнего агента

`core/src/mcp/tools.ts:1775`: `staleAgent` проверяется только в начале вызова. `wait_for("inbox", 1800)`, начатый
осиротевшим MCP-сервером до замены, по приходу письма пометит его прочитанным — новый агент его не увидит (именно
сирот 6.1 и ограждает). Исправление: повторить проверку ревизии в той же транзакции, где `wait_for`/`check_inbox`
забирают письма.

### 13. Пакет ищет «ведущего» не так, как вся система

`core/src/work/handover.ts:152`: `r.lead ?? r.members[0]` вместо `liveLead`. Ждущее предложение в комнате, где лидер
закрыт и ведущим стала эта сессия, не попадёт в «Obligations»; а комната с закрытым ведущим, где сессия первая в
`members`, попадёт ошибочно. Исправление: `liveLead(map, r) === sessionId`.

## Что проверено и в порядке

- Деление `launch`/`launchHeld` и ключ `launching`: между проверкой и `launching.add` нет `await`; поднятие письмом во
  время замены получает `started` без процесса; `pty.send`, сжатие и `setModel` уступают `exclusive`.
- Ограда: старый процесс без `AGENT_REVISION` получает отказ на всех пишущих инструментах; `create_session`,
  `request_agent_switch`, браузер идут по токену канала, который новый запуск заменяет. `bindCodexThread` идёт до
  ограды, но пишет только при `provider === 'codex'`, а замена codex → codex сейчас запрещена — дыры нет.
- `finishedState` при `switching` → `null`; ложного «is back» нет (граница журнала в activity и `endBySwitch`).
- Пакет: бюджеты частей и итога ≤ 12 КБ; хвост в `.parley/works/<w>/handover/`; порядок «после stop, до apply» верный.
- T14: будильник не поднимает сессию удалённого провайдера, `resume-failed` нет, ручной Resume — понятный `conflict`.
- T11a: источник в папке прежнего аккаунта не трогается; удаление — только `<from>.jsonl` в папке цели и только при
  файле форка и разных корнях.
- T11b: текущий отрезок — окно `[последняя замена, …)` плюс отсечение id ответов прежних отрезков; итог — сумма.
  Не проверено (нужен настоящий форк): переписывает ли Claude Code время скопированной записи `cost-state` — если да,
  `claudeCostIn` для отрезка форка вернёт накопитель целиком, с прежними $ (двойной счёт стоимости, не токенов).
