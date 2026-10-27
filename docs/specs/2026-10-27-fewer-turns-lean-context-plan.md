# Меньше ходов и легче контекст (часть C), куски 2–3 — обновлённый план

Дата: 2026-10-27. База: `origin/master` 5f4dd71a (после PR #113, письма в SQLite). Спека: `2026-10-16-fewer-turns-lean-context-design.md`. Заменяет куски 2–4 плана `2026-10-16-fewer-turns-lean-context-plan.md`; кусок 1 (lean-режим) влит PR #65 и здесь не повторяется.

> **Для исполнителей-агентов:** задачи по одной-две, исполнители Sonnet, после каждого куска — ревью, диф читает ведущий. Шаги отмечены флажками (`- [ ]`). Тексты для агентов — по-английски, комментарии и тесты — по-русски, как вокруг. Код в плане не приводится: контракт — файлы, функции, ожидания тестов; исполнитель сверяет имена с кодом ветки.

**Цель:** меньше вызовов модели у агентов комнаты (C1.1–C1.3) и меньше байт на каждый вызов (C1.4, C2.1). Целевой эффект спеки — −30 % входных токенов комнаты — мерится только куском 4.

## Что изменилось с b16ef1c7 (сверка с кодом)

| Пункт старого плана | Что в коде сейчас | Что из этого следует |
|---|---|---|
| C1.1: пометка через `readBy` | Письма в своих таблицах SQLite. Пишет `writeLetters(projectPath, workId, (letters: LetterTx, map) => …)` из `core/src/work/letter-store.ts`: `letters.unreadFor(reader)`, `letters.markRead(reader, ids, at)`. `check_inbox` — `checkInbox` (`mcp/tools.ts:1023`), пустой ящик ничего не пишет. Проба `wait_for("inbox")` (`tools.ts:821-829`) только читает (`unreadLetters`) | Пометка — тем же `writeLetters`, что у `check_inbox` |
| — | Старое поведение закреплено тестами: `server.test.ts:2206` («прочитанным помечает только check_inbox»), `annotations.test.ts:231`; аннотация `wait_for` — `READS` (`tools.ts:429`) | Тесты переворачиваются, `wait_for` — `WRITES` |
| — | Инструменты сессии исполняет и хост (`host/src/agent/tools-endpoint.ts`): повтор с тем же `callId` получает сохранённый итог 10 минут; `wait_for` и `get_map` отменяемы — при отмене запись о вызове снимается и повтор исполняется заново | Отметка не должна ставиться у отменённого `wait_for` (Review Focus 1) |
| C1.4: `spawn_session` и ошибка неверной модели | Инструмент теперь `create_session` (`mcp/session-tools.ts`, через хост). Ошибка модели уже называет допустимые (`providers.ts:919`), ошибка усилия — уровни. Неизвестный провайдер — `unknown provider X` (`host/src/sessions/sessions-service.ts:561`) | Из старой задачи 7 остаются ответ `get_map` и подсказка в ошибке провайдера |
| C1.4: каталог провайдеров | `get_map` без аргументов отдаёт `providers` — строки хоста с `needs` и `limits` (спека подписок 5.8); описание `create_session` отсылает к `providers[].limits` | Переезд в `field: "providers"` трогает и описание `create_session` |
| C2.1: «19 инструментов, JSON ≤ 60 %» | 26 инструментов в `TOOLS` и `create_session`: JSON схем 25 742 байта, из них тексты `description` (все уровни) — 10 226 (40 %). Самые тяжёлые: `propose_decision` 3 819 (почти всё — `PLAN_DRAFT_SCHEMA`), `attempt_submit` 2 162, `get_map` 1 943, `create_session` 1 632, `send_message` 1 535 | «≤ 60 % JSON» без правки схем недостижимо; цель пересчитана (решение 2) |
| C1.3: правила во вставку | Стабильная политика (`stableGuidance`, `work/guidance.ts`) — 3 896 из 4 096 байт (`STABLE_POLICY_MAX_BYTES`), 13 строк + строка сессии = 14 из 14 (`GUIDANCE_MAX_LINES`) | Новые правила — переписыванием строк, а не добавлением |
| C2.1: «гид участника — только темы rooms, mail, rules» | Гид целиком во вставку не идёт: вставка — `stableGuidance` и строка сессии (≈ 4 КБ), гид — только по `read_guide` | Пункт снят |
| C1.2: звонок через channel | Хост запускает сессии с `channel: false` (`sessions-service.ts:765`): звонок `watchInbox` есть только у сессий CLI `parley-core` | `inbox-watch.ts` в куске 3 не трогается (только комментарий в куске 2) |
| C1.3: системная строка «план принят» | Уже есть: ведущему приходит «Decision accepted.», решение уходит в комнату от его имени как `kind: decision` (гид, тема `lead`, шаг 4) | Пункт снят |
| C1.1: хвост указателя «…or wait_for("inbox")» | Указатель печатается простаивающему агенту; `check_inbox` — один вызов. Хвост распознают `POINTER_TEXT`/`isPointerText` (автозаголовок) | Хвост не меняем (решение 1) |
| C1.2: будильник | `wake-service.ts`: решение — чистая `deliveryAction` (`core/work/delivery.ts`), таймеры — `retryLater`/`clearTimers` в `AttemptState`. Причины ожидания — `MailWait` (`protocol/src/types.ts:117`), подписи — `strings.ts:1049` (`satisfies Record<MailWait, string>`); незнакомую причину старое окно пишет `waiting` | Таймер тишины — по образцу `retryLater`; новая причина `settling` безопасна для старых окон |
| CHANGELOG `Unreleased` | Раздела `Unreleased` нет: рецепт релиза собирает CHANGELOG по списку PR | Ветки CHANGELOG не правят; текст — в описании PR |
| Кусок 4: драйвер `spike-room.cjs` | Лежал в scratchpad сессии 2026-10-16, на диске его нет | Замер начинается с восстановления драйвера по `2026-10-16-mail-economy-spike-0.md`, раздел 3 |

## Решения, отличные от старого плана (на утверждение)

1. **Хвост указателя прежний** — `Call check_inbox.`: правка трогала бы распознавание указателя и автозаголовок, а вызовов не убавила бы.
2. **Цель C2.1:** все тексты `description` в `TOOLS` и `CREATE_SESSION_TOOL` — не больше 5 600 байт (−45 %), JSON схем целиком — не больше 21 000 байт (−18 %). Схемы планов автономной комнаты (`PLAN_DRAFT_SCHEMA`, `attempt_*`) не трогаем: комната свежая (PR #110), её схема — договор с движком.
3. **`wait_for` — запись (`WRITES`)**: аннотация обязана быть правдой (`annotations.test.ts`). Codex одобряет все инструменты `parley` (`default_tools_approval_mode="approve"`), у Claude `wait_for` встаёт рядом с `check_inbox`, который и сейчас запись.
4. **Отметка — после ожидания, а не в пробе**: проба только читает, как сейчас; найденные письма помечаются одной синхронной записью `writeLetters` после конца `waitForMap` и только если вызов не отменён. Иначе отмена посреди пробы помечала бы письма, которых агент не увидит.
5. **Срочность и тишина (C1.2):** будит сразу письмо от человека, адресное (непустой `to`), `kind` не `note` (`question`, `decision`) и `note` с упоминанием получателя `@sNN`. Остальное — заметка всем без упоминания, системные строки комнаты — ждёт `SETTLE_MS = 30 000` тишины после самого нового такого письма, но не дольше `SETTLE_MAX_MS = 120 000` от самого старого: болтовня раз в 20 с не откладывает доставку навсегда. Срочное письмо забирает пачку с собой.
6. **Спящая сессия — то же правило**: подъём по несрочным письмам — после тишины; лимит подъёмов (`resumeRate`) тратится только на настоящий подъём.
7. **`wait_for("inbox")` по своему таймауту** отдаёт и неустоявшиеся письма, а не `running`: письмо уже лежит, держать его дольше вызова незачем.
8. **Таймаут по умолчанию `wait_for` остаётся 600 с**; гид советует `wait_for("inbox", 1500)`. Умолчание не трогаем: оно в спеке (раздел 4) и в старых сессиях. *Проверено 2026-10-27 (задача 4, первый шаг):* у Claude Code 2.1.311 кроме жёсткого предела вызова есть таймаут простоя `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` — для stdio-серверов 1 800 000 мс, для остальных 300 000 мс; сервер `parley` у Claude — stdio и progress-уведомлений не шлёт. Ожидание в 1800 с поэтому упиралось бы в этот предел вровень, и совет — 1500 с. Потолок `MAX_TIMEOUT_SEC` = 1800 оставлен как есть — отдельный вопрос.
9. **CHANGELOG в ветках не правится** (см. сверку).

## Global Constraints

- Каждое письмо по-прежнему доходит каждому участнику и видно в окне сразу; меняется только пометка прочитанного (C1.1) и момент пробуждения простаивающего агента (C1.2).
- Ничего не писать в `~/.claude`, `~/.codex` и глобальные файлы пользователя.
- Старые хост, окно и сессии: новое значение `MailWait` старое окно показывает как `waiting`; старый агент, зовущий `check_inbox` после `wait_for`, получает пустой ящик без ошибки.
- Вставка: `stableGuidance` ≤ 4 096 байт и вся вставка ≤ 14 строк — существующие тесты `guidance.test.ts` остаются зелёными.
- Тесты — только свои файлы и соседи, по пакету и каталогу, никогда весь набор и не мутационные. Перед тестами `uptime`: при load за минуту ≥ 12 ждать. Под `LC_ALL=C` (локаль `ru_RU` ломает чужие тесты liveness, TODOS).
- Линт — только изменённых файлов (`pnpm exec eslint <файлы>`): `pnpm lint` на master чинит другая сессия.
- Коммиты и ветки по-английски (AGENTS.md); push — только по слову человека; `gh` нет — ссылка compare.
- Платные ходы моделей (кусок 4) — только с явного разрешения человека.

## Review Focus

1. **Отмена `wait_for` в момент прихода письма** (Esc в Claude Code, обрыв соединения с хостом): письмо не помечено прочитанным, следующий `check_inbox` его отдаёт. Тест — в задаче 1.
2. **`wait_for("inbox")` и `check_inbox` одновременно** (Codex зовёт инструменты из кода параллельно): ни одно письмо не помечено, не будучи отданным хотя бы одному из вызовов. Тест — в задаче 1.
3. **Болтовня без тишины** — заметки всем каждые 20 с: указатель всё равно печатается не позже `SETTLE_MAX_MS` от первой. Тест — в задаче 6.
4. **Перезапуск хоста посреди окна тишины**: таймеры в памяти пропали, но срок считается по `at` писем — после старта пересчёт печатает указатель на устоявшуюся пачку без нового письма. Тест — в задаче 7.
5. **Агент создаёт сессию, не зная каталога провайдеров** (старая привычка или резюме разговора): ошибка неизвестного провайдера называет `get_map {field: "providers"}`, ошибки модели и усилия — допустимые значения. Тест — в задаче 2.

---

## Кусок 2. Меньше ходов: MCP и гид (ветка `feat/fewer-turns` от `origin/master`)

### Task 1: `wait_for("inbox")` помечает отданное прочитанным (C1.1)

**Файлы:** `packages/core/src/mcp/tools.ts` (`waitFor` ~809-906, `checkInbox` ~1023-1034, описание `wait_for` ~428-443, комментарий `READS` ~316), `packages/core/src/mcp/inbox-watch.ts` (только комментарий в шапке: «`wait_for` … ничего не отмечает»), тесты `packages/core/src/mcp/server.test.ts` (блоки `wait_for`, `send_message и check_inbox`, `двухсторонний разговор`, `channel`), `packages/core/src/mcp/annotations.test.ts`.

**Interfaces:** produces `takeInbox` — общий помощник: письма в ответ и пометка по одному снимку; задача 8 пользуется им же.

- [x] Помощник в `tools.ts`: `takeInbox(context: McpContext, sessionId: string): ReturnType<typeof inboxView>[]` — внутри одного `writeLetters`: `unreadFor`, виды `inboxView`, `markRead` всех отданных. `checkInbox` переходит на него без изменения поведения.
- [x] `waitFor`, ветка `inbox`: проба по-прежнему только читает (`unreadLetters`) и возвращает признак «есть письма»; после `waitForMap` при найденном и `signal?.aborted !== true` — синхронно `takeInbox` и ответ `{ state: 'message', messages }`. Пусто после `takeInbox` (письма забрал параллельный `check_inbox`) — ждать дальше до конца таймаута, а не отвечать пустым `message`.
- [x] Аннотация `wait_for` — `WRITES`; из комментария `READS` убрать «ожидание»; таблица в `annotations.test.ts` и список read-only там же.
- [x] Описание `wait_for`: письма возвращаются и помечаются прочитанными; `check_inbox` после него не нужен.
- [x] Тесты (`server.test.ts`, блок `wait_for`): «inbox: отданные письма помечены прочитанными, check_inbox после — пустой»; «повторный wait_for без новых писем ждёт до таймаута и отвечает running»; «письмо, пришедшее во время ожидания, возвращается и помечается»; «отменённый wait_for не помечает: check_inbox отдаёт письмо» (через `AbortController`/`signal` исполнителя `createToolRunner`, как в блоке `createToolRunner`); «wait_for и check_inbox одновременно: каждое письмо отдано хотя бы одним, непомеченных-неотданных нет». Перевернуть `server.test.ts:2206` и `annotations.test.ts:231` (новое имя: «read_room прочитанным не отмечает, wait_for("inbox") — отмечает отданное»), сверить ожидания `двухсторонний разговор` (~2717) и `channel` (~2618).

**Проверка:** `cd packages/core && LC_ALL=C npx vitest run src/mcp/server.test.ts src/mcp/annotations.test.ts src/mcp/inbox-watch.test.ts` — зелёный.

### Task 2: `get_map` без каталога провайдеров (C1.4)

**Файлы:** `packages/core/src/mcp/tools.ts` (`getMap` ~597-631, `mapPage` ~641-734, enum `field` и описание `get_map` ~379-400), `packages/core/src/mcp/session-tools.ts` (описание `create_session` и полей `provider`, `model`, `effort`), `packages/core/src/work/guidance.ts` (строка `get_map` в `stableGuidance`), `packages/core/src/work/guide.ts` (тема `tools`: абзацы `get_map`, `create_session`, `model`/`effort`), `packages/host/src/sessions/sessions-service.ts:561`, тесты `server.test.ts` (блоки `get_map` ~471, `строки провайдеров от хоста` ~560, `GLM readiness in MCP` ~863), `guidance.test.ts`, `guide.test.ts`, тест хоста на `unknown provider`.

- [x] `getMap` без аргументов: `{ sessionId, map }` — без `providers` и без `note`. Сборка каталога (строки хоста, иначе локальный реестр с `HOST_UNREACHABLE_NOTE`) — в отдельную `providerCatalog(context, signal)`; `getMap` передаёт `signal` в `mapPage`.
- [x] `field: "providers"` в enum и в `mapPage`: `{ providers, note? }` — ровно прежний список и прежняя пометка.
- [x] Тексты: описание `get_map` — каталог по `field: "providers"`; `create_session` — провайдер, модели, усилие и `limits` из `get_map {field: "providers"}`; строка вставки — без «and providers»; гид — те же отсылки.
- [x] Хост: `unknown provider ${provider}; see get_map {field: "providers"}`.
- [x] Тесты: «get_map без аргументов — без providers и note»; прежние проверки провайдеров (`провайдеры несут то же, что providers.list`, строки хоста, GLM) — через `field: "providers"`; «с каналом агента и без хоста — note рядом с providers»; описание `create_session` называет `field: "providers"` (вместо теста `~632` про `providers[].limits`); хост — текст ошибки неизвестного провайдера.

**Проверка:** core — `LC_ALL=C npx vitest run src/mcp/server.test.ts src/mcp/session-tools.test.ts src/work/guidance.test.ts src/work/guide.test.ts`; host — тестовый файл `sessions-service` по имени.

### Task 3: Короче описания инструментов (C2.1)

**Файлы:** `packages/core/src/mcp/tools.ts` (массив `TOOLS`), `packages/core/src/mcp/session-tools.ts`, при необходимости `agent-plan-tool.ts`, `plan-tools.ts`, `attempt-tools.ts` (только `description`, не схемы), `packages/core/src/work/guide.ts` (темы принимают переехавшие правила), новый `packages/core/src/mcp/tools-size.test.ts`.

- [x] Описание — назначение, аргументы, одна фраза об ошибке. Правила, исключения, примеры — в тему `read_guide`, где их ещё нет (каждое снятое правило должно найтись в гиде; гид ≤ `READ_GUIDE_MAX_BYTES`). Остаются в описаниях подсказки, которые экономят ход: `wait_for` по id у сдавшей `report` сессии отдаёт старый итог — ждать через `inbox`; `stuck` — не ждать снова; `send_message` — отвечать только на `question`; `replyTo` — id из `check_inbox`/`read_room`.
- [x] `tools-size.test.ts`: сумма байт всех строк `description` (рекурсивно по схеме) в `TOOLS` + `CREATE_SESSION_TOOL` ≤ 5 600; `Buffer.byteLength(JSON.stringify([...TOOLS, CREATE_SESSION_TOOL]))` ≤ 21 000. В комментарии — откуда числа: 10 226 и 25 742 на 5f4dd71a.
- [x] Сверить тесты, которые читают описания: `server.test.ts` ~305 (`replyTo`), ~391 (`wait_for` и сдавшая сессия), ~3153 (`stuck`) и тест из задачи 2 — формулировки обновить, смысл проверок оставить.

**Проверка:** `LC_ALL=C npx vitest run src/mcp src/work/guide.test.ts` в `packages/core`.

### Task 4: Гид и вставка: тишина вместо подтверждений, одно ожидание (C1.3)

**Файлы:** `packages/core/src/work/guidance.ts` (`stableGuidance`, `CODEX_TOOL_EXAMPLES`), `packages/core/src/work/brief.ts` (`LEAD_ROLE`, `memberRole`), `packages/core/src/work/guide.ts` (темы `letters`, `lead`, `member`, `tools`), тесты `guidance.test.ts`, `brief.test.ts`, `guide.test.ts`, при необходимости `server.test.ts` (`roomTask.hint` несёт те же тексты).

- [x] До правки текстов: подтвердить, что таймаут вызова MCP в Claude Code не меньше 30 минут. Итог — решение 8: таймаут простоя stdio ровно 30 минут, совет `1500` вместо `1800` везде ниже.
- [x] Вставка (переписать строки `wait_for` и `check_inbox`, новых строк не добавлять): не подтверждать получение и не объявлять начало работы — молчание значит «получил»; писать результат, вопрос или решение. Ждать одним `wait_for("inbox", 1500)`: без текста до и после, без `Monitor`, `sleep` и циклов; на `running` — один повтор, затем закончить ход: Parley разбудит указателем. Место освобождается переносом в гид оговорки про тег `<channel source="parley">` (в окне его не бывает).
- [x] `LEAD_ROLE`: ждать позиций и отчётов одним `wait_for("inbox")`, не по id исполнителей; `memberRole`: не подтверждать раздачу частей — следующее письмо ведущему уже результат.
- [x] `CODEX_TOOL_EXAMPLES`: пример `wait_for` — `timeoutSec: 1500`, комментарий — «returns and marks messages read».
- [x] Гид: те же правила подробнее в `letters`, `lead`, `member`; в теме `tools` — что `wait_for("inbox")` помечает отданное.
- [x] Тесты: вставка содержит «silence», «1500» и запрет на `Monitor`; `LEAD_ROLE` — «one wait_for»; бюджет вставки (`guidanceBudgetProblems`) пуст для всех трёх наборов опций (`{}`, навигатор с `names`, `toolProfile: 'short'`).

**Проверка:** `LC_ALL=C npx vitest run src/work/guidance.test.ts src/work/brief.test.ts src/work/guide.test.ts src/mcp/server.test.ts` в `packages/core`.

### Task 5: Проверка куска 2

- [x] `uptime`; тесты core целиком по каталогу `src/mcp` и `src/work`, хоста — каталоги, чьи файлы трогали (`src/sessions`, `src/agent`).
- [x] `pnpm --filter @parley/core build`, `pnpm --filter @parley/host exec tsc --noEmit -p tsconfig.json`; eslint изменённых файлов.
- [x] Замер «до/после» тем же скриптом, что дал числа сверки: байты описаний, JSON схем, `stableGuidance`, ответ `get_map` на тестовой карте с тремя сессиями.
- [x] Финальное ревью ветки целиком; ссылка compare `master...feat/fewer-turns` и текст PR (что изменилось для агентов).

**Итоги куска 2 (2026-10-27).**

| Что | master 5f4dd71a | ветка |
|---|---|---|
| Все строки `description` инструментов | 10 226 Б | 5 580 Б |
| JSON схем инструментов | 25 742 Б | 20 881 Б |
| Обычный `get_map`, работа с тремя сессиями, локальный реестр | ≈ 16 836 Б | 3 100 Б |
| `stableGuidance`, набор по умолчанию | 3 896 Б | 3 894 Б (два правила добавлены, повторы срезаны) |

Сверх плана, по ревью: ждущий по id продолжает ждать, пока сессия работает (правило «один повтор и конец хода» — только для `"inbox"`); ведущий, у которого на `running` уже есть часть позиций, предлагает решение, а не заканчивает ход; конец хода при ожидании — без `report`.

Риск, закрытый стражем (решение человека 2026-10-27: «делай сторожа до части 3»): «отменённый `wait_for` ничего не помечает» держится, пока отмена доходит до хоста. Claude Code её шлёт; шлёт ли Codex при прерывании хода посреди `wait_for`, не проверено. Если нет, повисший вызов забрал бы следующее письмо, а ответ ушёл бы в никуда.

### Task 2б: Страж брошенного `wait_for` (сверх плана)

**Файлы:** `packages/core/src/work/activity.ts` (`SessionActivity.turnBoundaryAt`), `packages/core/src/mcp/context.ts` (`turnBoundarySince?`), `packages/core/src/mcp/tools.ts` (`waitFor`), `packages/host/src/agent/tool-context.ts`, `packages/host/src/host.ts`, тесты активности, `wait_for`, хоста и окна.

- [x] `turnBoundaryAt` — время последней границы хода в потоке событий: `UserPromptSubmit`, `Stop`, `StopFailure`, конец хода по `idle_prompt`, `SessionStart` нового процесса; у Codex — `turn_aborted`/`task_complete` из журнала сессии (хост уже вливает их как `Stop`). Догадки по тишине и логу границей не считаются. В отличие от `turnEndedAt`, началом следующего хода не сбрасывается.
- [x] `waitFor` запоминает начало вызова; перед `takeInbox`, если хост говорит, что граница хода была позже, — `{state: "running"}` без забора: вызов брошен, письмо остаётся непрочитанным и приходит указателем. Без хоста (CLI) — как раньше. Проверка — только у сессий Codex: Claude Code сам отменяет прерванный вызов, а его `UserPromptSubmit` приходит и при сообщении, поставленном в очередь посреди работы. Хост держит наибольшую границу по сессии (защёлка): у Codex `eventsFor` оставляет только последнее событие хода, и `Stop` прерывания пропадал бы с началом следующего.
- [x] Тесты: границы и не-границы в `reduceActivity`; `wait_for` с «брошенным» и «живым» предикатом; Codex `turn_aborted` даёт границу; контекст хоста сравнивает с живой активностью.

Уже идущие сессии получают новые правила только новым запуском: при возобновлении меняется ревизия брифа (новые `LEAD_ROLE`/`memberRole`) — один лишний ход на уведомление о брифе. Замер куска 4 — на свежих сессиях.

---

## Кусок 3. Пробуждение по срочности (ветка `feat/wake-settle` от `feat/fewer-turns`)

### Task 6: Правило срочности и окна тишины (core, протокол, подпись окна)

**Файлы:** `packages/core/src/work/delivery.ts`, `packages/core/src/work/delivery.test.ts`, `packages/protocol/src/types.ts` (`MailWait`), `packages/desktop/src/shared/strings.ts` (`mailWait`).

**Interfaces:** produces `SETTLE_MS = 30_000`, `SETTLE_MAX_MS = 120_000`; `wakesAtOnce(message: Message, recipientId: string): boolean`; `settleDelayMs(letters: readonly Message[], recipientId: string, now: number, settleMs?: number, settleMaxMs?: number): number` — 0, если доставлять сейчас, иначе сколько ждать; в `DeliveryInput` — `now: number` и необязательные `settleMs`/`settleMaxMs`; новый отказ `{ kind: 'none'; reason: 'settling'; retryInMs: number }`; `MailWait` += `'settling'`.

- [x] `wakesAtOnce`: `from === HUMAN`; `to.length > 0`; `kind !== 'note'`; упоминание получателя в тексте — `sessionMention(recipientId)` по правилу `plainHumanMention` (`attention.ts:118`: не часть слова, `@s02` не находится в `@s020`).
- [x] `settleDelayMs` по переданным письмам (`deliveryAction` передаёт ещё не указанные, `wait_for` — все непрочитанные; `at` — ISO, `Date.parse`): есть срочное — 0; иначе `min(newest.at + settleMs, oldest.at + settleMaxMs) − now`, не меньше 0.
- [x] `deliveryAction`: проверка тишины — только там, где сейчас получился бы `type-pointer` или `resume`; все прежние причины и их порядок не меняются. Текст указателя считает все непрочитанные, как сейчас.
- [x] `MailWait` и подпись окна: `settling: 'batched, waits for a quiet room'`.
- [x] Тесты: три срочных случая и упоминание (включая `@s020` для `s-02` — не срочно); одна заметка всем — `settling` с `retryInMs` 30 000, через 30 с — `type-pointer` на пачку; заметки каждые 20 с — указатель не позже 120 с от первой; срочное среди несрочных — сразу указатель на все; спящая с одной заметкой — сначала `settling`, потом `resume`; занятая — по-прежнему `busy`.

**Проверка:** `LC_ALL=C npx vitest run src/work/delivery.test.ts` в core; `pnpm --filter @parley/protocol build`; `pnpm --filter @parley/desktop exec tsc -p tsconfig.web.json --noEmit`.

### Task 7: Таймер тишины в будильнике (host)

**Файлы:** `packages/host/src/wake/wake-service.ts` (`AttemptState`, `clearTimers`, `recompute` ~860-992, `waitingOf` ~995), тест будильника в `packages/host/src/wake/`.

**Interfaces:** consumes задачу 6; `WakeServiceOptions.settleMs?`/`settleMaxMs?` — для тестов, как `enterDelayMs`.

- [x] `recompute` передаёт `now: Date.now()` в обе ветки `deliveryAction`. На `settling` — один таймер на сессию (`settleTimer` в `AttemptState`, `unref`): новый срок заменяет старый; по сроку — `recompute(ref)`. Снимается в `clearTimers` (а значит при выходе процесса и `stop`).
- [x] `waitingOf`: `settling` → `'settling'`; ветка без PTY (спящая) публикует `'settling'` тоже.
- [x] Тесты (fake timers): три участника и заметка всем — указатель каждому через 30 с, один на пачку; `question` — сразу; письмо человека — сразу всем; новая заметка в окне сдвигает срок; `stop` снимает таймер; «перезапуск» — новый будильник над картой с заметкой старше 30 с печатает указатель на первом пересчёте; мок-комната из трёх агентов и пяти заметок — 3 указателя, а не 15.

**Проверка:** `cd packages/host && LC_ALL=C npx vitest run src/wake`.

**Принятое ограничение (ревью 2026-10-27).** Перезапуск хоста (`ensureKnown`) и выход процесса агента (`pty.on('exit')`) помечают непрочитанное указанным, чтобы старт хоста и «Остановить» не поднимали всех. Несрочная заметка, которая в этот миг ждала тишины, поэтому не поднимет уснувшую сессию; письмо не теряется — агент прочтёт его при следующем ходе. До окна тишины заметка поднимала спящую сразу, и такого окна не было; правило «будят новые письма, а не лежавшие при выходе» оставлено как есть.

### Task 8: `wait_for("inbox")` по тому же правилу (core)

**Файлы:** `packages/core/src/mcp/tools.ts` (`waitFor`), `packages/core/src/mcp/context.ts` (`settleMs?`, `settleMaxMs?` для тестов, как `pollMs`), `server.test.ts`.

**Interfaces:** consumes `takeInbox` (задача 1) и `settleDelayMs`, `SETTLE_MS`, `SETTLE_MAX_MS` (задача 6).

- [x] Проба отвечает «есть срочное или пачка устоялась» по `settleDelayMs(unread, sessionId, now)`; пока нет — `waitForMap` ждёт не дольше `min(остаток таймаута, задержка)` и проба повторяется по сроку (проба зависит от времени, а `waitForMap` зовёт её только на смене карты — поэтому цикл ожиданий снаружи). Конец таймаута при лежащих письмах — отдать их (решение 7). Отметка — как в задаче 1, только отданных.
- [x] Тесты (короткие `settleMs` через контекст): заметка всем — возврат не раньше окна; `question` — сразу; срочное во время окна — вместе с ранней заметкой; таймаут вызова меньше окна — письмо отдаётся по таймауту, а не `running`.

**Проверка:** `LC_ALL=C npx vitest run src/mcp/server.test.ts -t wait_for` в core.

### Task 9: Проверка куска 3

- [x] Гид, тема `letters`: заметка всем без упоминания будит пачкой после 30 с тишины; вопрос, адресное, упоминание и письмо человека — сразу. Вставка не меняется.
- [x] `uptime`; тесты core `src/work src/mcp`, host `src/wake`, сборка protocol, typecheck окна, eslint изменённых файлов.
- [x] Финальное ревью ветки; ссылка compare `feat/fewer-turns...feat/wake-settle` (после слияния куска 2 — от `master`) и текст PR.

**Итоги куска 3 (2026-10-27).** Ветка `feat/wake-settle` (от `feat/fewer-turns`). Сверх плана, по ревью: письмо с `at` дальше окна тишины в будущее доставляется сразу, срок ожидания не выше `SETTLE_MAX_MS`; упоминание `@s-02` будит, как `@s02`; запас к сроку — 50 мс у будильника, 20 мс у `wait_for`. Принято как есть: позиции участников ведущему — рассылки и приходят ему пачкой через ~30 с после последней; Codex внутри `wait_for` под нагрузкой может получить лишний указатель в очередь на уже прочитанное (как и раньше со срочными письмами) — один пустой ход.

---

## Кусок 4. Замер (только с разрешения человека)

- [ ] Восстановить драйвер комнаты через сокет хоста по `2026-10-16-mail-economy-spike-0.md` (раздел 3): `works.create` → три `sessions.create` → `rooms.create` → `rooms.send` задачи → ожидание `report` ведущего → `rooms.usage`; принимать предложение ведущего сразу. Положить в `docs/research/2026-10-16-mail-economy-spike/` вместе с разбором транскриптов.
- [ ] Та же задача и состав, что в прогоне B спайка 0.2; три прогона после кусков 2–3; медиана против прогона B: `rooms.usage.totalInput`, ходы ведущего, стартовый контекст.
- [ ] Критерии спеки: входные токены −30 % и больше; ходов ведущего ≤ 20; `wait_for` подряд без нового письма — 0; подтверждений — 0; результат не хуже по разбору человеком. Codex — только при остатке недельной квоты.

## Порядок и исполнение

| Волна | Задачи | Ветка | Почему так |
|---|---|---|---|
| 1 | 1 + 2 | `feat/fewer-turns` | обе в `tools.ts` и `server.test.ts` — один исполнитель |
| 2 | 3 | `feat/fewer-turns` | переписывает описания после 1–2 |
| 3 | 4 | `feat/fewer-turns` | `guidance.ts`, `guide.ts` после 2–3 |
| 4 | 5 | `feat/fewer-turns` | проверка, compare |
| 5 | 6 | `feat/wake-settle` | правило, от него зависят 7 и 8 |
| 6 | 7 ‖ 8 | `feat/wake-settle` | файлы не пересекаются (host / core `tools.ts`) — параллельно |
| 7 | 9 | `feat/wake-settle` | проверка, compare |
| — | кусок 4 | — | после слияния, по разрешению |

Каждая волна: `get_usage` перед стартом, исполнитель Sonnet, ревью отдельным агентом, диф читает ведущий, коммит — после ревью. Оценка: кусок 2 — M, кусок 3 — M.
