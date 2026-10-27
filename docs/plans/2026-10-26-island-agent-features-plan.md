# Остров Parley: план реализации выбранных возможностей для агентов

> Для исполнителя: применять `superpowers:executing-plans` к согласованному плану, выполняя задачи последовательно по зависимостям. Исходный docs-only этап завершён и принят по p-19 rev0. Решения человека о старте реализации переданы s-21 в m-935/936 и s-25 в m-939: D1–D4 приняты, D5=B, D6=origin/master d8d541a2. Код и английские коммиты разрешены назначенным исполнителям только в feature-worktree, после аудита базы; push/PR не разрешены. S-27 редактирует только два документа без коммитов.

> T7b opt2 — выбранный человеком option 2 (решение передано s-25 в m-1262); option 1 не выбран. Проверенная и принятая реализация/проверки следуют lineage: B1/I1 (`77dd9042`) → P1 (`4b9c91c8`, replay correction `086dcc8d`) → P2a (`96bd76b8`) → P2b (`96086b4f`) → first-start (`90d61a26`). D6 base остаётся точным `origin/master d8d541a21f937b77162fca0f1db03d10d5837584`. Existing Chat unchanged; r-01 room/plan контракты не правятся. T8 принят на `e0aaeab4`, T9 — на `7b672105`; открыты T10/T11.

**Цель:** реализовать B4 №1, 3, 4, 5 с субагентами и предложениями комнат, 7 и 8 по [дизайну](../specs/2026-10-26-island-agent-features-design.md).

**Архитектура:** использовать хост как источник состояния и единственную точку применения решений. Остров остаётся узким изолированным клиентом; протокол и доступ к нему расширяются только в пределах согласованного контракта.

**Стек:** TypeScript, Electron, React, Zustand, Zod, pnpm, Vitest; существующий Electron E2E.

## 1. База и сохранность рабочего дерева

Первоначальные документы подготовлены при `master = fbb7b82844c1ee256f98e33c46254714dff2b077`. Актуальная принятая база реализации — точный `origin/master = d8d541a21f937b77162fca0f1db03d10d5837584`; это значение подтверждено read-only `git rev-parse origin/master` при обновлении 2026-10-27. В master есть незакоммиченные правки человека, включая `AgentIcon.tsx`, `CustomProviderPanel.tsx` и их тесты. Их нельзя переносить в задачи острова, сбрасывать, форматировать или включать в чужие коммиты.

Историческая голова r-01 `parley/w-0054/s-20` — `b975adb4e7ec5d535b0b29babc0c710596b6b514`, с первоначальным общим предком master `fbb7b828`. **Прежняя рекомендация начать от b975adb4 заменена решением D6:** исполнитель использует отдельный worktree `feat/island-agents` от точного d8d541a21f937b77162fca0f1db03d10d5837584. Dirty master не используется; частичные ветки исполнителей не cherry-pick. Перед T0 проверяется аудит b975adb4→d8d541a2, включая PR111 и общие host/protocol/main lifecycle. При дальнейшем сдвиге базы повторить ancestry/diff/семантическую проверку и закрепить SHA, не подменять базу плавающим origin/master.

Прямые пересечения с r-01: `packages/protocol/src/{methods,types}.ts`, `packages/host/src/{host,methods/index}.ts`, `packages/desktop/src/shared/strings.ts`. Семантическое пересечение: предложения и планы комнат, `Proposal`, `RoomPlan`, `liveLead`, карточки `DecisionCard`, `CompletionCard`, `HaltCard`, `PlanPanel`. Их формат и права ответа не переопределяются островом.

Первоначальный аудит стека по m-746: s-05–s-07 без прямого пересечения; s-08–s-14 затрагивают host registration; s-16 — host/methods/index и protocol methods/tests; s-17–s-18 добавляют strings и plan-actions; s-19–s-20 — protocol/types. Прежний diff ветки s-22 без island/protocol пересечений относится только к тому снимку и не заменяет аудит актуального master. Halted без proposal не включается в выбранную pending room функцию и не даёт кнопки resume.

Повторный read-only аудит s-23 m-943/944, проверенный критиком m-946, выполнен на exact d8d541a2: b975adb4 — предок, после него 65 changed paths. Protocol/, desktop main/island/preload, renderer/island и host feed/activity между этими головами не менялись. Адреса protocol/methods.ts исправлены по точной базе: params snapshot300–310, decide314; result snapshot480–487, decide491. Это не rebase-дрейф protocol между b975 и d8. Остальные 23 числовые ссылки и четыре Markdown links проверены; это статический аудит, без runtime tests. Изменения core/work/store.ts (кэш/backup/лимит snapshot) и letters.ts не меняют процитированную семантику works.list/changed, Proposal и liveLead; strings.ts остаётся общим файлом с последовательным владением.

Новые integration seams базы: `packages/host/src/host.ts:399–412,426,501–506,676–677` сохраняет roleCatalog, общий `/agent/tools`, route и unregister→toolsEndpoint.forget; `packages/host/src/methods/index.ts:92,218,333` сохраняет deps.roleCatalog и текущую регистрацию feed. Не переносить старый host wiring поверх этого кода. Новый HTTP agent transport не расширяет island RPC/whitelist. PR111 меняет panel covering threshold720→560/minView240; это учитывается T5 без дублирования threshold. `packages/desktop/src/renderer/shell/AppShell.tsx:668` сохраняет onOpenSession у InterruptedBanner и visible-only resume; `packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx:166–185` скрывает closed по умолчанию, но liveLead/Proposal/room model не меняет. RoomHistoryMenu и S.roomHistory удалены, не восстанавливать их. Эти исходники — границы интеграции, а не дополнительные задачи острова.

Параллельная r-05 под руководством s-28 проектирует #9 sounds/motion (m-796/829/940). Пересечения: IslandApp/IslandView/main beep. Согласован desktop-only `IslandPresentationOutcome {key,kind:'permission'|'question'|'plan'|'consent'|'room-proposal'|'done'|'terminal-request',fresh,expand,soundEligible}` по дизайну §9; Codex card:null — terminal-request, не permission. Одна freshness/presentation dispatch точка, existing beep fallback; все Done soundEligible=false, quiet Done expand=false, #9 не переопределяет suppression и не дублирует cue тем же key. Без отдельного одноразового framework. R-04 не меняет swarm/ и island.css; r-05 владеет sound/*, motion.ts, swarm/* и CSS, перебазируется после r-04. По m-856 после нас #9 меняет RETRACT_MORPH_MS250→300 в IslandApp; сама анимация/#9/callbacks/pulse не реализуются здесь и не блокируют план. Общие файлы интегрируются последовательно владельцем по согласованному seam.

## 2. Условия запуска, владение и волны

Успех реализации: C1, Q1–Q5, P1–P4, H1–H8, S1–S5, R1–R4, D1–D5, V1 и K1–K5 дизайна покрыты соответствующими проверками; новый host method единственный, whitelist точен, основные Chat/assistant/consents сохранены. T7b opt2 принят на lineage до `90d61a26`, T8 — на `e0aaeab4`, T9 — на `7b672105`; открыты T10/T11 и итоговая приёмка. Интегратор s-31 владеет T0 и общим wiring; последовательные задания выдаёт s-25, каждую delta проверяет s-26.

Один интегратор владеет общими `IslandApp.tsx`, `IslandView.tsx`, `main/index.ts`, `main/ipc.ts`, preload/shared bridge и strings. Локальные компоненты и чистые функции можно поручать независимым исполнителям после назначения владения; общие wiring-файлы интегрируются последовательно. Каждый исполнитель сохраняет правки коллег и не изменяет чужие задачи. Числа и поля в плане повторяют дизайн; при расхождении сначала исправляется согласованный контракт.

| Волна | Задачи | Зависимости и точка выхода |
|---|---|---|
| 0 | T0 | D1–D6 приняты; завершён аудит новой базы и подготовлен чистый feature-worktree от d8d541a21f937b77162fca0f1db03d10d5837584 |
| 1 — действующие host-контракты | T1; T2; затем T3/T4; T5 | Общая основа T1 перед формами; изменения IslandApp/View интегрировать по одному; новых host методов нет |
| 2 — ограниченный host-контракт | T6 → T7 → T8; T9 | Начинается после завершения всей волны1 (T1–T5). Сначала wire/schema, затем хост, затем renderer; T9 использует прежние metrics/works и принятый D5=B |
| 3 — клавиатура | T10 | Только после всей волны2, включая T8/T9; общий keyboard owner из T1 |
| Приёмка | T11 | Все targeted checks, package typecheck, focused E2E и macOS smoke |

Перед каждым meaningful изменением: добавить failing test нужного поведения, выполнить адресный Vitest, внести минимальную реализацию, повторить тот же набор. Не добавлять тесты, которые только копируют константы реализации. Для source bounds, sender и races нужны тесты наблюдаемого результата и отсутствия лишних действий. Английские коммиты назначенных задач разрешены в feature-worktree, без правок человека; повторное разрешение на каждый такой коммит не требуется. Push/PR не разрешены. Автор обновления документов не создаёт коммитов.

## 3. T0 — закрепить базу и проверить границы

**Владелец:** интегратор s-31. **Файлы:** изменений приложения нет. **Зависимость:** документы и D1–D6 приняты; аудит новой базы проверен ведущим и критиком. До этого только read-only подготовка, без изменения кода.

1. Прочитать принятый дизайн, план и аудит новой базы; read-only проверить `git rev-parse origin/master`, `git show -s --format=%H d8d541a21f937b77162fca0f1db03d10d5837584`, ancestry и `git diff --name-only b975adb4...d8d541a21f937b77162fca0f1db03d10d5837584`. Не выполнять reset/stash/checkout в master; фактическая execution база всегда полный d8d541a2 SHA, даже если origin/master уже сдвинулся.
2. Использовать существующий собственный worktree s-31 `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-31`; проверить его базу/HEAD/чистоту, feature-ветку `feat/island-agents` готовить только там от exact d8d541a2. Повторный worktree не создавать; чужую ветку не переиспользовать. Master checkout остаётся fbb7b828 и dirty, переключать его нельзя.
3. В существующем worktree проверить чистоту, зависимости и Node22; для T1+ использовать Node22 (проверенная версия22.23.3, CI выбирает major22: `.github/workflows/ci.yml:37`). Known baseline из отчётов T0 и критика m-962, принятого m-964: на Node20.15.1 builds PASS, renderer падает ERR_REQUIRE_ESM из locked jsdom30; тот же набор8files/391tests PASS на Node22.23.3. Это несовместимость окружения, не регрессия базы; deps/lockfile/engines в этой задаче не менять. Runtime-generated `.omc/project-memory.json` drift не стейджить и не включать в коммит; перед каждым коммитом проверять status и стейджить только явные файлы задачи, без `git add -A`. Прочие baseline failures фиксировать отдельно; не запускать install/build в dirty master ради документации.

**Приёмка:** `git rev-parse HEAD` равен принятой базе; `git status --short` в execution worktree пуст; master не изменён исполнителем. К артефактам задачи приложены полный SHA и карта пересечений, а не неопределённое «от master».

## 4. T1 — безопасная очередь, обновление карточек и общий keyboard owner

T1 завершена только после T1a, T1b и T1c. Общие файлы этих задач интегратор меняет последовательно; групповая зависимость `T1` ниже означает все три части.

### T1a — очередь и revalidation

**Владелец:** requests executor. **Зависимость:** T0. **Изменить:** `packages/desktop/src/renderer/island/{requests.ts,requests.test.ts,IslandApp.tsx,IslandApp.test.tsx}`; wiring IslandApp — последовательно с интегратором.

1. Добавить failing regressions: выбранный key при удалении соседа, поздний snapshot/decide после reconnect, тот же cardId с новым payload, resolved-elsewhere при другом pending той же сессии.
2. Хранить выбранный key, вычислять индекс. Обновлять card/summary/fingerprint известного key вместо сохранения старого `known.get(key)`. Не переносить draft/deciding между ref/card/content; подключить reset callback формы из T1c.
3. Revalidate selected pending через attention snapshot при открытии/возврате keyboard и каждые1000ms видимости, один in-flight/ref, generation guard. Остановить collapsed/disconnected; ошибка не выбирает allow/default. Не добавлять feed.changed.

```sh
pnpm --dir packages/desktop exec vitest run src/renderer/island/requests.test.ts src/renderer/island/IslandApp.test.tsx
```

**Приёмка:** payload обновлён, late response безопасен, resolved извне виден без activity transition, нет новых subscriptions.

### T1b — main snapshot boundary

**Владелец:** main IPC executor. **Зависимость:** T0. **Изменить:** `packages/desktop/src/main/{ipc.ts,ipc.test.ts}`; `packages/desktop/src/shared/island.test.ts` только если необходимо закрепить whitelist.

1. Failing sender tests: missing/wrong scope, agentId/extra fields отвергаются до HostConnection.call; legacy full feed, отсутствие prompt, несколько pending; обычный Chat получает неизменённый результат.
2. Для island sender строгий `{ref,scope:'attention'}`, ref через существующий sessionRef. Main до renderer оставляет все pending cards и последний text после последнего prompt, без prompt — последний text вообще. Применять на все snapshot callers, включая replies; не полагаться на DOM hiding.

```sh
pnpm --dir packages/desktop exec vitest run src/main/ipc.test.ts src/shared/island.test.ts
```

**Приёмка:** island получает только attention projection, Chat не изменён; whitelist не расширен.

### T1c — keyboard ownership, focus и arm

**Владелец:** keyboard интегратор. **Зависимость:** T1a. **Изменить:** `packages/desktop/src/renderer/island/{IslandApp.tsx,IslandApp.test.tsx,IslandView.tsx,IslandView.test.tsx,arm.ts}`, `packages/desktop/src/renderer/island/assistant/{store.ts,store.test.ts}`, `packages/desktop/src/shared/island.ts`, `packages/desktop/src/preload/{island.ts,island.test.ts}`, `packages/desktop/src/main/index.ts`, `packages/desktop/src/main/island/{ipc.ts,ipc.test.ts}`. IPC plumbing выполняется одним интегратором.

1. Failing tests owner assistant/request, blur/Escape/disconnect release, arm по showId/cardKey/fingerprint, native activation и сброс фокуса на обновлённом payload.
2. Ввести одного owner assistant|request|null и согласованно переименовать assistant-blur→keyboard-blur. Разделить keyboard acquisition и decision.
3. Fingerprint change равна новой карточке: blur decision button, reset500ms и focus container **только если request уже владеет keyboard**. Не захватывать фокус автоматически из чужого приложения. Сценарий focused Approve→payload change same cardId→500ms→Enter не отправляет решение до нового явного фокуса кнопки. Повторное раскрытие также rearm.

```sh
pnpm --dir packages/desktop exec vitest run src/renderer/island/IslandApp.test.tsx src/renderer/island/IslandView.test.tsx src/renderer/island/assistant/store.test.ts src/preload/island.test.ts src/main/island/ipc.test.ts
```

**Приёмка:** один keyboard owner, корректный возврат ввода и focus reset, no hotkey decision, native focused button activation после arm работает.

## 5. T2 — включить полную видимость Codex

**Владелец:** исполнитель модели; общие wiring интегрирует интегратор. **Зависимость:** T0, итоговая интеграция после T1.

**Изменить:** `packages/desktop/src/shared/{island.ts,island.test.ts}`, `packages/desktop/src/renderer/island/{model.ts,model.test.ts}`; при необходимости уточнить существующие `replies.test.ts`, `requests.test.ts` и `attention/notify.test.ts`. Только удаление устаревших ожиданий и проверка notification coexistence, без новой policy уведомлений.

1. Добавить C1 fixtures: Codex working/needs-you/Done, два worktree, неизвестный reply и terminal-only fallback; closed-Chat Done получает доступный reply после штатного source update, eventual freshness без SLA.
2. Удалить константу `ISLAND_ATTENTION_ONLY_PROVIDERS`, её фильтр, все импорты и устаревшие комментарии. Проверить `rg -n ISLAND_ATTENTION_ONLY_PROVIDERS packages/desktop/src`: совпадений не должно остаться.
3. Сохранить `needReason`, consents и проверку `decisions:'terminal'`. Проверить счётчики/комнаты и Clear без двойного учёта.

```sh
pnpm --dir packages/desktop exec vitest run src/shared/island.test.ts src/renderer/island/model.test.ts src/renderer/island/replies.test.ts src/renderer/island/requests.test.ts src/renderer/attention/notify.test.ts
```

**Ожидается:** C1 PASS; host protocol/whitelist unchanged.

## 6. T3 — QuestionForm и сериализация ответов

**Владелец:** исполнитель форм. **Зависимость:** T1.

**Создать:** `packages/desktop/src/renderer/island/{QuestionForm.tsx,QuestionForm.test.tsx}`, `packages/desktop/src/renderer/lib/{question-answer.ts,question-answer.test.ts}`.

**Изменить:** `packages/desktop/src/renderer/island/{IslandView.tsx,IslandView.test.tsx,IslandApp.tsx,IslandApp.test.tsx,simple-question.ts,simple-question.test.ts}` по необходимости удаления старого simple-only пути; `packages/desktop/src/renderer/chat/cards/QuestionCard.tsx` только для чистого shared serializer, и его существующие тесты; `packages/desktop/src/shared/strings.ts` последовательно с интегратором.

1. Зафиксировать Q1–Q5: payload single/multi/Other, Back/Next, duplicate text/labels, пустые/усечённые/5 вопросов, Other-only с `options:[]`, предел итогового ответа, IME и native activation после arm.
2. Вынести чистый answerOf без chat store/bridge и доказать parity с действующим `QuestionCard`. Один draft на активный `refKey/cardId/fingerprint`, без глобального накопления.
3. Реализовать 1–4 страницы, radio/checkbox/Other, scroll body в доступном frame. Пустые options допустимы как Other-only; пустые labels/question text и дубликаты дают объяснение с переходом. Не наследовать предел four options старого simpleChoices.
4. Подключить owner request, исключить drag с input/selection/scroll, не отправлять форму по Enter в Other. Проверять все ответы перед явным Submit; ошибка не стирает draft, resolved/disconnect — стирают.
5. Встроить компонент через интегратора; не импортировать chat component/store или широкий bridge. Удалить мёртвый simple-only путь, если больше не используется, и выполнить проверки.

```sh
pnpm --dir packages/desktop exec vitest run src/renderer/lib/question-answer.test.ts src/renderer/island/QuestionForm.test.tsx src/renderer/island/requests.test.ts src/renderer/island/IslandView.test.tsx src/renderer/island/IslandApp.test.tsx
```

**Ожидается:** точные payload, отсутствие решений из ввода/IME/navigation; native focused Submit работает после arm; draft не переживает смену identity.

## 7. T4 — PlanView и явный переход в terminal

**Владелец:** исполнитель планов; shared route — интегратор. **Зависимость:** T1.

**Создать:** `packages/desktop/src/renderer/island/{PlanView.tsx,PlanView.test.tsx}`.

**Изменить:** `packages/desktop/src/shared/bridge.ts`, `packages/desktop/src/main/{ipc.ts,ipc.test.ts}`, `packages/desktop/src/renderer/{App.tsx,App.test.tsx}`, `packages/desktop/src/renderer/attention/{focus-target.ts,focus-target.test.ts,focus-target.appshell.test.tsx}`, `packages/desktop/src/renderer/island/{IslandView.tsx,IslandView.test.tsx}`, `packages/desktop/src/shared/strings.ts`.

1. Добавить P1–P4: длинный escaped план, оба choice, terminal-only, truncated, тот же cardId с изменением текста; route при существующей Chat-вкладке, reject cardId+terminal.
2. Расширить session FocusTarget опциональным `view:'terminal'`; валидатор запрещает комбинацию с cardId, старые цели совместимы. Route должен менять сохранённый tab.view, а не только фокусировать session tab.
3. Реализовать plain text plan в body max-height до 280 px с дополнительным ограничением оставшимся frame/notch/header/footer; без line-clamp, fs/path read, RoomMarkdown/openExternal.
4. Две кнопки — существующие plan choices; Change plan только open target. Подключить arm/deciding/error из T1, выполнить тесты.

```sh
pnpm --dir packages/desktop exec vitest run src/renderer/island/PlanView.test.tsx src/renderer/island/IslandView.test.tsx src/renderer/attention/focus-target.test.ts src/renderer/attention/focus-target.appshell.test.tsx src/renderer/App.test.tsx src/main/ipc.test.ts
```

**Ожидается:** Change plan не вызывает decide/interrupt/pty.send, реально открывает terminal; ссылки/HTML — текст; choices и guard работают без изменения host wire.

## 8. T5 — visibility relay и quiet Done

**Владелец:** desktop integration. **Зависимость:** T1, T2 для Codex-регрессии.

**Создать:** `packages/desktop/src/main/island/{visibility.ts,visibility.test.ts}`, `packages/desktop/src/renderer/attention/{session-visibility.ts,session-visibility.test.ts}`.

**Изменить:** `packages/desktop/src/shared/{bridge.ts,island.ts}`, `packages/desktop/src/preload/{index.ts,island.ts,island.test.ts}`, `packages/desktop/src/main/{index.ts,ipc.ts,ipc.test.ts}`, `packages/desktop/src/main/island/{ipc.ts,ipc.test.ts}`, `packages/desktop/src/renderer/{App.tsx,App.test.tsx}`, `packages/desktop/src/renderer/island/{IslandApp.tsx,IslandApp.test.tsx}`, `packages/desktop/src/renderer/browser/panel/{PanelHost.tsx,PanelHost.test.tsx,runtime.ts,runtime.test.ts}`. Существующий `attention/seen.ts` и producers ChatView/TerminalSurface/SurfaceLayer в этой задаче не переписывать.

1. Добавить D1–D5 с fake main window: main frame sender, seq, lifecycle resets, event-before-getter, точный ref/split panes, same doneKey после blur. Layout V1: covered Chat/Terminal → ordinary Done; beside → quiet Done; split refs/open-close/resize559↔560/unknown measurement. Отдельно width0→600 при unchanged narrow=false: measured false→true обновляет runtime/relay и включает quiet; мокать ResizeObserver и getBoundingClientRect (jsdom сам не измерит600px).
2. Добавить host.measured:boolean в panel runtime и optional measured argument в mountHost с default false; PanelHost публикует width>0, narrow сохраняет через существующий PANEL_LIMITS.narrowBelow. UI narrow semantics не менять. Publisher использует visibleSessionRefs/documentVisible плюс layout.panels и runtime.hosts, подписан на оба источника; исключает ровно panel.open&&(host missing||!measured||narrow), не копируя threshold. Closed panel измерения не требует. Передать стабильные первые50 оставшихся refs. Main перепроверяет refs<=50/seq/frame и native focus/visibility/non-minimized. Focus перепубликует refs; lifecycle страницы меняет seq-generation только в main. Global seen/producers не менять.
   В runtime equality guard сравнивать narrow и measured, в PanelHost effect deps — runtimeKey/narrow/measured; иначе width0→600 не обновит host. Переиспользовать panelRuntimeKey(workKey, owner), не склеивать новый ключ; room-owner panel не исключает session pane.
3. Реализовать versioned snapshot `{version,refs}` и island-only getter/event. Подписка раньше snapshot; старые версии/поколения игнорировать, unknown → пусто.
4. При fresh Done точного ref пропускать только auto-expand/freshDone timer; consumed key записывать всегда. Не отправлять `activity.seen`, не менять held/Clear, pending не подавлять. Badge может штатно исчезнуть после main seen1s; не обещать постоянную отметку. В seam r-05 передавать suppressExpansion/outcome, не добавлять прямой beep/animation.

```sh
pnpm --dir packages/desktop exec vitest run src/main/island/visibility.test.ts src/renderer/attention/session-visibility.test.ts src/renderer/browser/panel/PanelHost.test.tsx src/renderer/browser/panel/runtime.test.ts src/main/ipc.test.ts src/main/island/ipc.test.ts src/preload/island.test.ts src/renderer/island/IslandApp.test.tsx src/renderer/attention/seen.test.ts
```

**Ожидается:** quiet exact-viewed Done, ordinary fallback для covering/неизвестности и прежняя seen semantics; native focus потребует T11. Known limitation m-946c: старый seen tracker всё ещё может пометить покрытую сессию просмотренной через1с; это отдельно от quietDone и не исправляется T5. Badge не обещается постоянным.

## 9. T6 — схема feed.progress

**Владелец:** protocol executor. **Зависимость:** завершение T1–T5; до host/renderer progress.

**Создать:** `packages/protocol/src/{feed-progress.ts,feed-progress.test.ts}`.

**Изменить:** `packages/protocol/src/{methods.ts,methods.test.ts,index.ts}`. `feed.ts`, `FeedDecision`, `FEED_SCHEMA_VERSION`, `events.ts` не расширять.

1. Сначала тесты строгих params/result: extra agentId/path/limit, >20 или duplicate ids, invalid date/status/category/revision, current вне recent, free-text поля, UTF-8 размер результата, unavailable shape.
2. Добавить schema/типы ровно по дизайну §7.2: opaque id wire≤128, host SHA-256 lowercase hex64; canonical UTC ISO24 at/endedAt из валидной даты (invalid → unavailable всей проекции), enums; method params `z.strictObject({ref:sessionRef})`. Результат доступен/недоступен, при unavailable current=null/recent=[], no-state revision0; retained revision не означает available.
3. Зарегистрировать в METHODS/results/exports. Существующий RPC code conflict не менять: typed `data.reason/retryAfterMs` задокументировать возле контракта, не добавлять `rate_limited` в ErrorCode.

```sh
pnpm --dir packages/protocol exec vitest run src/feed-progress.test.ts src/methods.test.ts src/feed.test.ts
pnpm --filter @parley/protocol build
```

**Ожидается:** schema не принимает запрещённые поля/формы; существующие feed tests PASS; host method name появляется в объявленном списке методов без нового host event.

## 10. T7 — host projector, source stamp, cold single-flight и квота

T7 завершена после T7a и T7b; групповая зависимость `T7` означает обе части.

### T7a — чистый projector

**Владелец:** projector executor. **Зависимость:** T6. **Создать:** `packages/host/src/feed/{progress.ts,progress.test.ts}`.

1. Добавить failing H1–H3: tail/current, повтор id и финальный статус, invalid date, secret canaries во всех запрещённых полях, serialized UTF-8 cap.
2. Реализовать canonical tail уникальных tools, current внутри recent, SHA-256 hex64 ids, ISO24 даты (invalid → unavailable), enum categories. Только чистая проекция, без source reads/кэша/подписок.

```sh
pnpm --dir packages/host exec vitest run src/feed/progress.test.ts
```

**Приёмка:** bounded schema-valid результат без free text и sensitive bytes, current не создаёт 21-ю строку.

### T7b — service, provenance и квота

**Владелец:** host service executor. **Зависимость:** T7a. **Создать:** `packages/host/src/methods/feed.test.ts`, если отдельного файла ещё нет. **Изменить:** `packages/host/src/feed/{feed-service.ts,feed-service.test.ts}`, `packages/host/src/methods/{feed.ts,index.ts}`, `packages/host/src/host.ts` только при необходимости wiring cleanup. Для binding lifecycle читать activity service и session model; общий журнал не переписывать.

1. Сначала failing H4–H8: source A→B/process restart/missing provenance/remove-readd, late delivery, quota-before-read, зависший cold seed и closed-Chat source update.
2. FeedService.progress принимает client для квоты. До чтения валидирует ref/sessionOf; internal source stamp provider/providerSessionId/startedAtProcess проверяется перед materialization и delivery. Неизвестность/смена → unavailable; raw source ids не выходят в wire, общая лента/Chat subscribers не сбрасываются.
3. Seed-if-needed → projector T7a. Codex обновляется штатным onLogChange→seedAside→pollCodex; progress не вызывает pollCodex/дополнительный serialCodex. Closed-Chat Done/progress и concurrent Chat poll проверяются без новых subscriptions.
4. Per-ref cold-read single-flight, host gate4/sec/client и concurrent1; excess conflict+reason/retryAfterMs до работы. Без LRU/TTL кэша/source poller/вечного таймера. Caller2s не освобождает underlying read; поздняя доставка после removal/stop/generation запрещена. Частоту delivery ограничивает main T8.
5. Подключить request.client, registry и dropClient/stop/removal cleanup. Проверить отсутствие cache/poller/subscription side effects. I/O существующего cold seed и eventual freshness остаются ограничением; log-index MIN interval2000ms не является SLA≤2s.

```sh
pnpm --dir packages/host exec vitest run src/feed/progress.test.ts src/feed/feed-service.test.ts src/feed/codex-source.test.ts src/methods/feed.test.ts
pnpm --filter @parley/host build
```

**Ожидается:** bounded result, никакого sensitive payload, source stamp защищает от старого журнала; quota проверяется до read, нет deadlock/subscribe side effects. Для fail-closed unavailable допустим честный переход в Parley, а не обязательный source rebind в этом этапе.

**T7b addendum — recovery B2 по m-1111.** Восстанавливается только progress-эпоха, без reset/rebind общей Chat/feed. Pure projector T7a не меняется. Принятая последовательность — B1/I1 → P1 → P2a → P2b → first-start, с lineage, указанной выше; scope остаётся ограничен приведёнными файлами. Набор production-файлов не расширяется автоматически: при обнаружении необходимости исполнитель задаёт ведущему точный scope-вопрос.

1. Добавить отдельные RED-регрессии H5/H8 до реализации по принятой матрице m-1114/1115: cold Claude/Codex seed→onStart→завершение сохраняет Chat/tail, но не progress старых строк; unknown→binding; запасной link→MCP с тем же/другим thread; restart/resume mid-seed; ранний/чужой Claude hook; старый ID с новым status; prune/forget. I1 отдельным тестом: methods/feed.ts fallback сохраняет revision имеющейся ленты. Доказать отсутствие новых subscriptions/reset/rebind Chat/feed.
2. В существующей ленте хранить progress epoch `{stamp,eligible:Set<itemId>} | null`; eligible содержит только текущие parent tools (kind tool, agentId отсутствует), очищается при trim/remove/state replacement, ограничен FEED_MAX_ITEMS2000; forget удаляет его. Invalidation очищает eligible и запрещает доставку in-flight старой эпохи. Действующий cold-read single-flight/timeout не заменять новым кэшем или poller.
3. OnStart отмечает boundary и pending независимо от feed; при отсутствии observedSource previousStartedAt брать из карты. Lifecycle confirmation отдельно от source/file/proof: live handle.pid==captured start pid==map.pid плюс новый непустой startedAtProcess относительно previousStartedAt. OS stamp не сравнивать с Date.now-based startedAt. Works-change может снять pending по этим условиям, но не создаёт progress epoch. Exit не подтверждает; ранние строки не становятся eligible задним числом. Подтверждённая boundary сохраняется и до deferred feed creation, поэтому seed не получает initial generation0. Stopped cold seed с полным допустимым tuple остаётся разрешён; отсутствие log/proof в момент markStarted не мешает lifecycle confirmation. Claude matching hook, new-ID eligibility и old-ID update guard прежние.
4. Codex: providerSessionId обязателен, immutable tail binding providerSessionId+file сверяется с текущим; cwd/time logFile недостаточен. Без binding seed не ставит seeded; unknown→link допускает первый trustworthy seed. Запасной link→MCP с тем же thread не инвалидирует epoch, с другим thread/чужим tail → unavailable до host restart/removal, без reset/rebind Chat/feed. Существующий seed/tail read имеет stamp/generation guard до/после await; нового poller/cache/serial wrapper нет. Первый trustworthy seed до любого invalidation допускает историю; после invalidation только subsequent новые source rows, available empty допустим. Без thread binding №5 остаётся unavailable; после resume история начинается с новых действий.
5. Проверки recovery, guards до/после await, eligible bound/cleanup и Chat-unaffected evidence приняты вместе с T7b lineage до `90d61a26`. Указанные test commands остаются точным набором для воспроизведения проверки; этот docs delta их не запускал.

**Узкая lifecycle delta m-1195/1196/1199:** production/test scope только `packages/host/src/feed/{feed-service.ts,feed-service.test.ts}`, отдельный fix commit; raw Chat/source producers, proof producer и флаги не менять. RED/GREEN AC: onStart без feed→feed до неподтверждённого exit; onStart→exit→первое создание feed; live matching pid/new start подтверждён, source/proof ещё нет→exit→поздний qualifying file/proof; works-change подтвердил lifecycle до feed creation, boundary не потеряна и initial generation0 не восстановлена. Сохранить положительный stopped cold-seed контроль. Cleanup pending/boundary по forget/удалению/stop FeedService работает и без созданной ленты, без ref-state leak; обычный PTY exit не считается подтверждением. Новые адресные тесты входят в feed-service.test.ts/команды T7b выше. Это задания и ограничения, не runtime claims автора docs.

**T7b opt2 — authoritative binding evidence до Codex admission.** Выбран option 2; требование H4 сохраняется. Legacy providerSessionId не различает fallback и MCP; его одного нельзя принимать за proof. Recovery выше для Codex применяется только вместе с полным gate из §7.2 дизайна. Для stopped cold seed полный retained tuple допустим; без proof progress unavailable. Existing Chat fallback-проблема остаётся backlog b-005, а не принятым cross-session риском progress.

| Последовательность | Проверенная lineage | Контрактная граница |
|---|---|---|
| B1/I1 — host fixes | `77dd9042` | `preserve cold Chat seeds across process starts`; включает host `methods/feed.ts` fallback, сохраняющий revision существующей ленты |
| P1 — private evidence producer/schema/lifecycle | `4b9c91c8` + replay correction `086dcc8d` | Core work/map/launch/store и MCP proof producer; private record, reset/repair, replay guard, отдельный proof retry. Не менять `context.ts` или host activity |
| P2a — public projection stripping | `96bd76b8` | Core context-pages, host works-service и main island backstop: удалять proof из public/legacy/island projections без мутации внутренних maps |
| P2b — source-epoch gate/recovery | `96086b4f` | Feed progress consumer проверяет полный proof tuple, epochs/eligibility и late guards; новый RPC/events/whitelist не добавлять |
| first-start — lifecycle boundary | `90d61a26` | onStart ставит boundary до feed creation; сохраняются lifecycle AC m-1195/1196/1199 и ограниченный host feed-service scope |

Условные границы scope остаются: `packages/core/src/index.ts` разрешён только если нужен общий validated guard, без generic abstraction. Production `packages/host/src/sessions/sessions-service.ts` не включён: при доказанном wiring gap сначала точный scope-вопрос ведущему. Другие файлы не дают права менять r-01 room/plan семантику. Задачи, file scope и порядок lineage не переименовывать и не переставлять. Приёмка T7b атомарна по всему стеку. Push/PR по-прежнему запрещены.

P1 — сначала RED, затем минимальная реализация:

1. Optional strict `WorkSession.codexThreadBinding={launchRevision,pid,startedAtProcess,threadId}`: launchRevision canonical lowercase UUID36, pid positive safe int, startedAtProcess1..64 UTF-16 code units без controls и без trim/normalize, threadId null либо canonical lowercase UUID36. Malformed record drop, legacy отсутствие не synthesize trust; schema version прежняя. Non-Codex normalization удаляет чужое поле; map/store roundtrip сохраняет валидный Codex proof при чужом updateMap.
2. Использовать уже имеющийся launch env UUID/nativeContextRevision независимо от skillNavigator; новый descriptor/context.ts не нужен. Create/reset/proof только при provider==='codex', у Claude/non-Codex record не появляется — отдельный тест. Под map lock: новый valid UUID+полный process → reset threadId:null; same valid UUID с тем же **или другим полным** process сохраняет прежний record без изменений. Map process фактический incoming, поэтому different-process record mismatched и progress unavailable; повтор не создаёт authority. Структурно валидный mismatch record сохраняется через map roundtrip, отклоняется consumer, не удаляется normalization из-за process mismatch. Repair без UUID сохраняет только exact same process, иначе drop; invalid переданный UUID/incomplete process drop. RED/GREEN replay AC: start A/proof→same UUID processB дважды с map roundtrip→old record retained, old MCP не подтверждает B; new UUID затем reset. Это конкретная replay-защита доверенного host caller, не ledger запусков (m-1173). Fallback linkSession demotes threadId, не теряет launch identity и не меняет прежнюю raw bind семантику.
3. Separate raw/proof latch: proof требует valid UUID в обоих `_meta.threadId` и `_meta.sessionId`, canonical-normalized equality; первый qualifying root+launch захвачены, child/missing/invalid/mismatch не подтверждают. ThreadId-only test: raw bind successful, proof absent, progress unavailable до qualifying call; remote MCP имеет те же правила. Это availability limitation, не гарантия всех Codex версий. Под updateMap lock сравнить captured launch, record/current process и raw thread; raw+proof одного вызова менять атомарно. Same raw thread не skip proof; до markStarted pending, нужен следующий call, без него unavailable. Старый MCP после resume не пишет proof нового launch. Поздний proof после stop того же полного tuple допустим, новый launch его сбрасывает. Ошибка/отсутствие proof не меняет raw once latch и прежний Chat.

```sh
pnpm --dir packages/core exec vitest run src/work/map.test.ts src/work/launch.test.ts src/work/store.test.ts src/mcp/thread-binding.test.ts
pnpm --dir packages/host exec vitest run src/sessions/sessions-service.start-write.test.ts
pnpm --filter @parley/core build
```

P2 — сначала RED exposure/gate, затем реализация:

1. Core context-pages strips record из всех agent/map projections. Host works-service strips из public compact **и legacy** works.list/works.changed; internal entry/snapshot/onChange сохраняют record. Main island works.list/works.changed strips одинаково как backstop для старого host с новым optional полем. Не мутировать исходные объекты; не добавлять field в MCP/get_map. Canary launchRevision/proof object/новые proof keys отсутствуют в serialized public payload, internal proof сохранён; существующий raw providerSessionId может иметь то же значение, что удалённый proof.threadId, это не failure strip (m-1150). Полный запрет raw IDs в feed.progress остаётся прежним.
2. Progress требует full proof tuple==current raw binding/process, плюс существующий pid gate только при live PTY. Codex epoch/read token=(provider,threadId,proof.launchRevision,pid,startedAtProcess,tail file), guards до/после await и delivery. Отдельная RED/GREEN регрессия: same thread/pid/start + new launchRevision инвалидирует старое чтение/epoch и не допускает прежние IDs. Consumer regression m-1173: retained record A после двух same-UUID start processB даёт unavailable по mismatch с actual map process B. Нет proof/malformed/mismatch → unavailable. Token/nonce не идут в wire; нового source enum/RPC/event/whitelist нет, feed.progress уже определён T6.
3. Initial fallback seed raw-only. Same-thread authority после fallback требует proof write; matching existing tail binding/file подтверждает progress только для subsequent новых IDs, без старых fallback rows. Different-thread tail остаётся unavailable до host restart/removal. Первый trustworthy seed под полным proof до invalidation может включить историю; stopped full tuple cold seed допустим; ранний неподтверждённый onStart не легализуется exit. Проверить соседние Codex-сессии в одном cwd без ослабления H4.

```sh
pnpm --dir packages/core exec vitest run src/work/context-pages.test.ts src/work/map.test.ts src/work/store.test.ts
pnpm --dir packages/host exec vitest run src/works/works-service.test.ts src/feed/feed-service.test.ts
pnpm --dir packages/desktop exec vitest run src/main/ipc.test.ts
```

Если создан отдельный чистый works-projection.ts, добавить `src/main/island/works-projection.test.ts` к desktop команде. P2b проверяет RED/GREEN матрицу recovery выше с opt2 gate: stale MCP/start retry/repair/same-thread/child/early call/stop, seed в полёте и bounded eligible. Для стека зафиксированы Node22 и соответствующие package builds/typecheck; код T7a, зависимости, lockfile и engines не меняются. T7b принят на lineage до `90d61a26`; T8/T9 также приняты (`e0aaeab4`, `7b672105` соответственно).

## 11. T8 — selected progress detail и polling lifecycle

**Владелец:** renderer executor, wiring интегратор. **Зависимость:** T7, T1.

**Создать:** `packages/desktop/src/renderer/island/{progress.ts,progress.test.ts,ProgressView.tsx,ProgressView.test.tsx}`.

**Изменить:** `packages/desktop/src/shared/{island.ts,island.test.ts}`, `packages/desktop/src/main/ipc.test.ts`, `packages/desktop/src/renderer/island/{IslandApp.tsx,IslandApp.test.tsx,IslandView.tsx,IslandView.test.tsx}`, `packages/desktop/src/shared/strings.ts`.

1. Тесты: один selected ref, stop collapsed/hidden/disconnected/assistant/pending, late selection response, deadline/backoff со stale результатом, старый host methods null/без feed.progress, available vs unavailable revision.
2. В ISLAND_METHODS добавить **только feed.progress**, ISLAND_EVENTS неизменен. Тестом подтвердить, что feed subscriptions/pty/rooms/plans по-прежнему запрещены.
3. Main sender-specific limiter feed.progress ≥250ms (добавить изменение `main/ipc.ts` к владению T8); renderer следующий запрос по умолчанию планирует через500ms после settled, один in-flight, только раскрытая selected detail. Данные keyed full ref + connection generation + известный lifecycle process; available revision сравнивается только в этой области, unavailable не понижает expected revision. Missing source — unavailable; generic error без raw message. На throttle сохранить последний результат stale/Update delayed и выдержать retryAfterMs; без результата сохранить loading. Не мигать unavailable.
4. Показывать категории локальным словарём, current/history≤20/empty/loading/unavailable/truncated и stale/delayed, переход к session. Не показывать raw tool names или metrics.plan; последнее удаляется main activity projection в T9. Новый source poller/кэш не вводить.

```sh
pnpm --dir packages/desktop exec vitest run src/renderer/island/progress.test.ts src/renderer/island/ProgressView.test.tsx src/renderer/island/IslandApp.test.tsx src/renderer/island/IslandView.test.tsx src/shared/island.test.ts src/main/ipc.test.ts
```

**Ожидается:** H1/H4/H6/H7 на стороне renderer; ни один background session не опрашивается автоматически, closed detail не воскрешается поздним ответом.

## 12. T9 — subagents, privacy projection и room proposals

**Владелец:** desktop model/integration. **Зависимость:** завершение всей волны1 (T1–T5), до T10. **D5=B принят:** type48/description160 и known credential masking с явно принятым остаточным риском; повторный privacy gate не требуется.

**Создать:** `packages/desktop/src/main/island/{activity-projection.ts,activity-projection.test.ts}`.

**Изменить:** `packages/desktop/src/main/{ipc.ts,ipc.test.ts,index.ts}`, `packages/desktop/src/renderer/island/{model.ts,model.test.ts,requests.test.ts,IslandView.tsx,IslandView.test.tsx,IslandApp.tsx,IslandApp.test.tsx}`, `packages/desktop/src/shared/{island.ts,strings.ts}`, `packages/desktop/src/renderer/store/{activity.ts,activity.test.ts}`. Использовать существующий `renderer/lib/{room-lead.ts,room-lead.test.ts}`; не добавлять дубликат core liveLead.

1. Тесты S1–S5 и regression privacy/fallback: background после idle/Done, absent/empty/mismatch, >8, reordering, parent removal. Main одинаково проецирует event/snapshot только для island sender, raw основной Chat не меняется; явные Island metrics содержат только нужные numeric counters, `model:null`, bounded policy-B task labels/hashed IDs и top-level total, без `metrics.plan`, usage/arbitrary metadata. Каждый task.id всегда SHA-256 hex64, даже raw short-id canary отсутствует в serialized payload. Не удалять и не ослаблять существующие тесты K16/`needReason(detail)` для общего Chat.
2. Реализовать desktop-only IslandActivityEntry с optional top-level islandTasksTotal; ActivityEntry renderer принимает optional intersection, host/protocol LiveMetrics unchanged. Total=valid unique source ids до take8; absent→absent, []→0. +N=total-delivered, reported subagents отдельно. AC12tasks/count5→8,+4,count5;3/count12→3,без+9;[]/count12 known empty;absent unknown. Реализовать принятый B: type48/description160 plain text, controls stripped, credential/URL-auth/key=value masking, generic fallback. Остаточный риск принят человеком; абсолютную no-secrets гарантию не заявлять.
3. Parent Done ортогонален детям: одна строка с doneKey/reply/badge/tasks, working0/done1; Clear→done0 и Subagents active остаётся; после последнего ребёнка очищенный idle parent исчезает без повторного Done; новый turnEndedAt даёт новый Done. Idle с активными детьми также остаётся без fake working/count identities.
4. Тесты R1–R4 и pending rows даже busy0/Done0, только work.status active; proposal в suspended/closed/done work не добавляет island visibility. Lead — `roomLiveLead`, не proposal.from/owner. decision/completion/legacy, revision key, archived/removal, full work refs; halted alone не создаёт proposal/action. Не передавать preview предложения в DOM; только Open room. Сверить r-01 DecisionCard/CompletionCard/PlanPanel, не менять их протоколы, не разрешать rooms.resolveProposal/plans.resumeAutonomous с острова.
5. Подключить pending badge/reveal с сохранением активного ввода и stable selection. Не добавлять rooms/plan host методы в whitelist.
6. Activity projection выдаёт `tasks:[]` (не пропускает вложенные raw tasks/transcriptPath и не добавляет отдельный transcriptPath), `waitingFor:null`, `need.detail:null`; сохраняет `need.kind` и штатную permission/consent карточку. `main/ipc.test.ts` проверяет эти границы в island event/snapshot; activity-derived fallback renderer показывает generic «approval in terminal», без подавления сессии. В `requests.test.ts` отдельный regression проверяет generic Island fallback при очищенном detail; общий Chat остаётся на прежнем `needReason(detail)` с существующей K16-проверкой (не удалять и не ослаблять общий тест). `heldByBackground` без реального `turnEndedAt` удерживает `Subagents active` при working=0/done=0; Done создаётся/сохраняется только по существующему marker, без синтеза timestamp.

```sh
pnpm --dir packages/desktop exec vitest run src/main/island/activity-projection.test.ts src/main/ipc.test.ts src/renderer/store/activity.test.ts src/renderer/island/model.test.ts src/renderer/island/requests.test.ts src/renderer/island/IslandView.test.tsx src/renderer/island/IslandApp.test.tsx src/renderer/lib/room-lead.test.ts
```

**Ожидается:** реальные дети видны после конца родителя, room waiting не исчезает из пустой комнаты; sensitive projection одинакова для event/snapshot, activity detail с approval-командой не выходит в Island и заменяется generic fallback, отдельная permission/consent карточка остаётся доступна, Chat/Telegram K16 неизменны; held-only без end marker не превращается в Done.

## 13. T10 — единая pending navigation и настраиваемый hotkey

**Владелец:** keyboard интегратор. **Зависимость:** завершение всей волны2, включая T8/T9 (и предшествующую волну1).

**Создать:** `packages/desktop/src/main/island/{shortcut.ts,shortcut.test.ts}`, `packages/desktop/src/renderer/island/{navigation.ts,navigation.test.ts}`.

**Изменить:** `packages/desktop/src/shared/{ui-types.ts,ui-types.test.ts,bridge.ts,island.ts,strings.ts}`, `packages/desktop/src/preload/{index.ts,island.ts,island.test.ts}`, `packages/desktop/src/main/{index.ts,ipc.ts,ipc.test.ts}`, `packages/desktop/src/main/island/{ipc.ts,ipc.test.ts}`, `packages/desktop/src/renderer/components/settings/{SettingsDialog.tsx,SettingsDialog.test.tsx}`, `packages/desktop/src/renderer/island/{IslandApp.tsx,IslandApp.test.tsx,IslandView.tsx,IslandView.test.tsx}`. Переиспользовать `ShortcutField.tsx`; existing assistant shortcut использовать как образец lifecycle, не вытеснять его registration.

1. Тесты K1–K5: стабильная consent/feed/room очередь, selected key, снятие выбранного, revision, repeat coalescing, empty, input/IME, все navigation handlers без decisions, native focused activation после arm.
2. IslandUi получает pendingHotkey:string|null; принятый default Control+Alt+I, null — off. Нормализация старого ui.json, patch только изменяемого поля, без перезаписи displayId/anchor.
3. Main registry и status/suspend IPC: conflict виден, assistant ownership сохраняется, выключенный island/disconnect не регистрирует shortcut, recording ShortcutField временно снимает только собственный hotkey. Dispose/quit освобождают регистрацию.
4. Main→island navigate pending ставит focus на container, стрелки вне ввода/IME меняют key, Ctrl+Enter открывает только feed/room цель, Escape отдаёт клавиатуру. Consent показывается inline, без выдуманного target/SessionRef из optional requestedBy; Ctrl+Enter для него no-op и без Open session hint. Тест consent без workId/sessionId: no host call. Очередь shared для mouse/keyboard; consent priority не делает выбранный feed/room недостижимым.
5. Новые pending не уносят активный draft; обновляются badge/звук. Ни один global/navigation handler не вызывает feed.decide/consents.decide/rooms.resolveProposal. Tab и Enter/Space на явной кнопке сохраняют доступность.

```sh
pnpm --dir packages/desktop exec vitest run src/main/island/shortcut.test.ts src/renderer/island/navigation.test.ts src/shared/ui-types.test.ts src/renderer/components/settings/SettingsDialog.test.tsx src/renderer/island/IslandApp.test.tsx src/renderer/island/IslandView.test.tsx src/preload/island.test.ts src/main/ipc.test.ts src/main/assistant/shortcut.test.ts
```

**Ожидается:** K1–K5 PASS; реальное возвращение фокуса/конфликт системного сочетания подтверждает T11.

## 14. T11 — интеграция и приёмка без расширения объёма

**Владелец:** интегратор + критик. **Зависимость:** T1–T10.

**Изменить:** `packages/desktop/e2e/island.spec.ts`; связанные fixtures только если они действительно нужны и назначены владельцу. После обнаружения дефекта менять только относящиеся к нему файлы задач.

1. Пройти все AC дизайна по тестам задач. Проверить итоговый diff против exact base, отсутствие чужих файлов, новые host methods/events/whitelist и shared routes. Убедиться, что scope snapshot не расширился, а progress не возвращает source ids/free text.
2. Добавить focused E2E: Codex working→Done; multi/Other; чтение плана и terminal route; source unavailable; фоновый ребёнок после родителя; room pending; quiet Done exact pane; keyboard только navigation. Не использовать реальные аккаунты или запуск референсных приложений.
3. Выполнить проверки сборки/типов и focused E2E в execution worktree, с фоновым запуском долгих операций по возможностям среды:

```sh
pnpm --filter @parley/core build
pnpm --filter @parley/protocol build
pnpm --filter @parley/host build
pnpm --filter @parley/desktop typecheck
pnpm --filter @parley/desktop build
pnpm --dir packages/desktop exec playwright test e2e/island.spec.ts
```

4. Если targeted checks и типы зелёные, не гонять бесконечно весь монорепозиторий. Расширять проверку только при конкретном shared regression risk: r-01 proposal fixtures, assistant keyboard, notification/seen, main reload. Зафиксировать заранее известные сбои отдельно; не выдавать mock за native proof.
5. Ручной macOS smoke: стороннее приложение получает текст после Escape/blur; открытие вопроса даёт клавиатуру; IME/раскладка не шлют решений; shortcut conflict/record/off работает; true split Chat/Terminal visibility, covering/beside panel, resize559↔560 и minimized main; notch/frame/scroll, перенос на другой монитор, отключение дисплея; скрытые/старые pending не активируются. Проверить, что proposal badge виден рядом с permission/question и не закрывает их, а активная child row остаётся читаемой. Для web-страниц использовать Parley browser; Electron native smoke нельзя подменить browser screenshot.
6. WATCH m-1190: проверить transient source stamp non-null→null→valid после задержки log indexing/перечитывания works или на реальном хосте при переиндексации. Null инвалидирует progress history; recovery допускает available empty и только последующие новые строки, прежняя history не восстанавливается. Зафиксировать это ограничение, не исправлять raw Chat/source producers в T11. Подтвердить сохранение `CODEX_EARLY_TOOLS=false`: включение флага вне scope и требует отдельного eligibility review, поскольку hook-created IDs уже есть в before, а последующий tail update не делает их новыми. Текущая задача флаг не меняет и не заявляет поддержку этого будущего режима.
   Уточнение m-1213 для чтения результатов: любой observed onStart ставит boundary; ранние новые Codex rows первого raw seed до confirmed source не восстанавливаются в progress задним числом. После start/resume допустима пустая история, далее только subsequent verified rows; Claude — новые matching hooks. Полная seed-история разрешена только trustworthy generation0 до observed lifecycle boundaries, не исключительно stopped cold seed. Это критерий интерпретации ограничения без изменения семантики и без runtime claims автора документа.
7. WATCH UX по T9: `IslandModel.active` включает фоновые active children и pending room proposals, поэтому они могут сохранять раскрытое состояние часами. Это принятое сохранение видимости/held-parent semantics; не вводить таймер или менять код в T11. В native acceptance оценить длительное удержание и проверить обычное обновление видимости после завершения child/снятия proposal по текущим active/idle правилам; длительность сама по себе не дефект.

**Артефакты:** принятая база/full head SHA реализации, список задач/файлов, вывод адресных тестов/typecheck/build/E2E, отметки ручных сценариев и конкретные ограничения. Push/PR/merge/release — отдельные действия человека, этот план их не разрешает.

## 15. Конфликты и интеграционные ворота

| Область | Риск | Действие интегратора |
|---|---|---|
| protocol methods/tests, host registration | Актуальная база включает изменения после r-01 | Сохранить весь реестр от d8d541a21f937b77162fca0f1db03d10d5837584, добавить feed.progress с учётом аудита PR111/agent channel, проверить список методов |
| host.ts/methods/index.ts | Новый shared roleCatalog и agent tools endpoint | Сохранить wiring `/agent/tools`, route, unregister→forget и deps.roleCatalog по §1; не копировать старый файл целиком |
| PR111 panel/layout | Raw visibleSessionRefs считает покрытые panes видимыми | QuietDone publisher исключает covering через layout.panels/runtime hosts; beside сохраняет, unknown conservative; shared seen/producers без правок |
| AppShell/InterruptedBanner, ParticipantStrip | Новые API и фильтрация closed; старый room history удалён | Сохранить onOpenSession/visible-only resume и текущий room model; не восстанавливать RoomHistoryMenu/S.roomHistory |
| protocol/types и ErrorCode | Не перепутать provider rate limit с RPC code | Использовать существующий conflict+data.reason, не добавлять новый code |
| Room proposals и r-01 UI | completion/legacy/новые плановые состояния | Использовать существующую форму proposal, roomLiveLead и только Open room; не переносить resolve логику |
| IslandApp/View/main/index/shared strings | Конфликты всех волн | Один владелец wiring, последовательная интеграция, targeted regression после каждого объединения |
| HostConnection и feed subscriptions | Один клиент для нескольких renderer | Не добавлять subscribe/unsubscribe/changed; attention snapshot и progress pull раздельны |
| Source journal lifecycle | Тот же ref может сменить provider binding/process | Internal source stamp и fail-closed unavailable; не сбрасывать общую feed state/подписки |
| Dirty master/AgentIcon/CustomProviderPanel | Правки человека вне задачи | Только isolated execution worktree; документы этого этапа — ровно два новых файла |
| Metadata privacy | Arbitrary descriptions несовместимы с абсолютной гарантией no-secrets | Реализовать принятый D5=B, masking/bounds/generic fallback; явно сохранить принятый остаточный риск |
| r-05 #9 sounds/motion | Общие IslandApp/View/swarm/main beep | QuietDone только suppressExpansion; существующий callback/outcome seam согласуется владельцами, shared files интегрируются последовательно, #9 вне scope |

## Принятые решения D1–D6

Решения человека переданы s-25 в m-939 со ссылкой на m-935/936 владельца. Docs-only этап завершён; реализация разрешена назначенным исполнителям.

- **D1 принято:** вопросы1–4, history20/16КиБ, default polling500мс после settled/main limiter250мс, host4Hz/concurrent1, caller2s, tasks8/type48/description160, visibility50; без нового cache/source poller. Изменения чисел синхронизируются с AC/тестами.
- **D2 принято:** default Control+Alt+I с настройкой/off/conflict status; navigation не решает, native focused button activation после arm сохранена.
- **D3 принято:** quiet Done только для exact visible Chat/Terminal panes focused/non-minimized main с исключением covering browser panel; beside учитывается, unknown measurement — обычный Done, suppress не шлёт seen.
- **D4 принято:** live lead + badge + Open room, без текста/ответа на острове; активный ввод сохраняется; active-work-only и proposal-presence не расширяются.
- **D5=B принято:** type48/description160 plain text, known credential masking, controls stripped, generic fallback; остаточный риск произвольных секретов явно принят человеком. Повторное разрешение B не требуется.
- **D6 принято:** exact origin/master d8d541a21f937b77162fca0f1db03d10d5837584 вместо b975adb4; существующий worktree s-31 `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-31`, ветка только там, аудит перед T0. Разрешены английские feature-worktree commits, push/PR запрещены; s-27 только обновляет два docs без коммитов, dirty master не переключается.

## Решения, ещё открытые для человека

T7b принят на lineage до `90d61a26`, T8 — на `e0aaeab4`, T9 — на `7b672105`. Открыты T10/T11 и итоговая приёмка. Рекомендация — завершить их по отдельным gates, сохраняя принятые контракты и границы T7b–T9. Push/PR и внешняя публикация требуют отдельного поручения; рекомендация — решать их после проверок T10/T11. Новый дефект или конфликт требований сначала получает решение ведущего; исполнители не расширяют scope самостоятельно.
