# Меньше ходов и легче контекст (часть C) — план реализации

Спека: `2026-10-16-fewer-turns-lean-context-design.md` (спайк C0 выполнен, таблица флагов там). Дата: 2026-10-16. Параллельно другая сессия исполняет части A и B (`2026-10-16-mail-economy-and-map-journal-plan.md`): куски 2–3 этого плана трогают `core/src/mcp/tools.ts` и `guide.ts` и начинаются **после слияния части A**; кусок 1 (lean-режим) с частью A не пересекается и идёт первым.

> **Для исполнителей-агентов:** задачи по одной, Workflow на Sonnet мелкими кусками (1–2 задачи), диф читает ведущий. Шаги отмечены флажками (`- [ ]`). Тексты для агентов и UI — по-английски, комментарии и тесты — по-русски. Код в плане не приводится: контракт — файлы, функции, ожидания тестов; исполнитель сверяет имена с кодом ветки.

## Global Constraints

- Ничего не писать в `~/.claude`, `~/.codex`, глобальные `CLAUDE.md`/`AGENTS.md` и настройки пользователя: lean-режим — только флаги, переменные окружения и свой файл `--settings` сессии. Пользовательские файлы читаются (список плагинов, список MCP Codex), но не меняются.
- `disableAllHooks` не использовать: хуки Parley лежат в том же файле `--settings` (`core/src/work/settings-file.ts:36-44`).
- Авторизация не трогается: `--bare` только для провайдера `glm` (ключ), и только если спайк на GLM покажет, что `CLAUDE.md` проекта доходит через `--add-dir`; в этом плане `--bare` не делается.
- Каждое письмо по-прежнему доходит каждому участнику и видно в окне; меняется только момент пробуждения простаивающего агента (C1.2) и пометка прочитанного (C1.1).
- Старые хост/окно/сессии: новое поле `lean` у сессии и новые поля конфига необязательны; старый хост их отбрасывает, старое окно не шлёт.
- Тесты — только свои файлы и соседи; полный прогон — в задаче проверки куска; перед `pnpm test` смотреть `uptime`.
- Платные ходы моделей (задача 13) — только с явного разрешения человека.

## Review Focus

- Lean-режим не отключает ничего из своего: сервер MCP `parley`, хуки Parley, `--append-system-prompt`, `PARLEY.md`, `CLAUDE.md` проекта.
- Решение «lean или нет» принимается один раз при создании сессии, хранится в карте и одинаково применяется при `resume`.
- C1.1: `wait_for` помечает прочитанным ровно то, что вернул, и ничего сверх; `check_inbox` после него не находит повторов.
- C1.2: срочные письма (человек, `to`, `@sNN`, `question`, `decision` ведущего, `roomTask`) будят сразу в тестах; несрочные — не раньше `SETTLE_MS` и одним указателем.
- Тексты гида короткие и повелительные; размеры вставки в пределах `GUIDANCE_MAX_BYTES`.

---

## Кусок 1. Lean-режим (ветка `feat/lean-sessions` от `origin/master`)

### Task 1: Конфиг и протокол

**Файлы:** `packages/core/src/config.ts` (`ParleyConfig` ~29-70, разбор и умолчания, `config.test.ts`), `packages/core/src/work/types.ts` (тип сессии ~100-135), `packages/protocol/src/methods.ts` (`sessions.create` ~118-142, `settings.get/set` 177-178, 411-412), `packages/protocol/src/types.ts`.

- [ ] `ParleyConfig`: `leanAgents: boolean` (умолчание `true`) — lean для сессий, созданных `spawn_session` и как участники комнаты из диалога. Разбор строки из `settings.set` (`'true'`/`'false'`), как у `autoLaunch`. (`leanSkills`/`--disable-slash-commands` сняты: навигатор уже оставляет в листинге одни имена, спайк C0 V7–V8.)
- [ ] Сессия в карте: `lean?: boolean` (отсутствие = `false`; старые карты читаются без миграции).
- [ ] `sessions.create`: необязательное `lean?: boolean` — явный выбор из диалога; без поля решает хост по `leanAgents` и источнику (задача 3).
- [ ] Тесты: умолчания конфига; разбор `settings.set('leanAgents','false')`; схема `sessions.create` принимает и опускает `lean`.

**Приёмка:** тесты core и protocol зелёные; `settings.get` отдаёт оба новых поля.

### Task 2: Флаги и окружение запуска (core)

**Файлы:** `packages/core/src/providers.ts` (шаблон Claude `runner.args` и `resumeArgs` ~186-232; `CODEX_CONFIG_FLAGS` ~129-140), `packages/core/src/work/launch.ts` (подстановки `subs.*` ~327-408, `env` ~103, запись `writeWorkSettings` ~338), `packages/core/src/work/settings-file.ts` (`workSettings` 171, `workSettingsJson` 205, `writeWorkSettings` 293), новый `packages/core/src/work/lean.ts` (+ тест), `launch.test.ts`, `settings-file.test.ts`.

- [ ] `lean.ts`: `readUserPluginIds()` — ключи `enabledPlugins` из `~/.claude/settings.json`, `<проект>/.claude/settings.json`, `<проект>/.claude/settings.local.json` (чтение, не запись; отсутствие файла — пустой список); `readCodexMcpServerIds(codexHome)` — имена `[mcp_servers.<id>]` из `config.toml` (разбор `smol-toml`, уже в зависимостях core).
- [ ] Шаблон Claude: плейсхолдер `{leanFlags}` в `args` и `resumeArgs` после `--settings {settingsFile}`; в `launch.ts` при `lean` подстановка `['--strict-mcp-config']`; без lean — пусто и плейсхолдер выпадает (механизм как у `{codexHooks}`: массив флагов, `codex-hooks.ts:10-15`).
- [ ] Окружение: при `lean` для провайдеров на бинаре `claude` (claude, glm) — `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` в `env` запуска и resume.
- [ ] Файл `--settings`: `workSettings` принимает `disabledPlugins: string[]` и пишет `enabledPlugins: { id: false }`; хуки Parley и `permissions` — без изменений.
- [ ] Codex: плейсхолдер `{leanFlags}` в `CODEX_CONFIG_FLAGS`; при `lean` — пары `-c mcp_servers.<id>.enabled=false` для каждого id из `readCodexMcpServerIds`, кроме `parley`.
- [ ] Тесты: lean Claude даёт ровно `--strict-mcp-config`, env с `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` рядом с уже стоящим `SLASH_COMMAND_TOOL_CHAR_BUDGET=1` навигатора, `enabledPlugins` все `false` в файле настроек, хуки Parley на месте; не-lean — ни одного из этих следов; `resumeArgs` lean-сессии совпадают по флагам с `args`; Codex lean — `-c mcp_servers.chrome-devtools.enabled=false` при фикстурном `config.toml` и ни одной пары для `parley`; отсутствующие пользовательские файлы — пустые списки без ошибки.

**Приёмка:** `pnpm --filter @parley/core test -- launch settings-file lean` зелёный; на фикстуре повторяется таблица спайка C0 по составу флагов.

### Task 3: Решение «lean» в хосте и хранение в карте

**Файлы:** `packages/host/src/sessions/sessions-service.ts` (создание записи ~444 и ~646, `launchedBy: 'host'`; вызов сборки запуска; `resume`), `packages/host/src/methods/sessions.ts`, `sessions-service.test.ts`.

- [ ] При `sessions.create`: `lean = params.lean ?? (config.leanAgents && source !== 'human-single')`, где источник: `spawn_session` (запись `pending` от агента) — всегда по настройке; создание из диалога комнаты — диалог передаёт `lean` сам (задача 4); одиночная сессия из диалога без поля — `false`.
- [ ] Поле `lean` пишется в запись сессии и читается при `resume`, `autoLaunch` и подъёме письмом: флаги и окружение одинаковы на всём пути сессии.
- [ ] `host.info`/`providers.list` не меняются; `sessions.create` старого окна без поля работает как раньше.
- [ ] Тесты: `pending` от агента при `leanAgents=true` → lean; при `false` → нет; явный `lean:false` из окна перекрывает настройку; `resume` lean-сессии передаёт те же флаги (шпион на сборку запуска).

**Приёмка:** тесты хоста зелёные; в карте тестовой работы у сессии `lean: true`.

### Task 4: Окно: настройка и диалог создания

**Файлы:** `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx` (раздел с `autoLaunch` ~262-275), `packages/desktop/src/shared/strings.ts`, `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx` (создание участников комнаты ~575-689), `packages/desktop/src/shared/bridge.ts`, тесты диалогов.

- [ ] Settings → Agents: тумблер «Lean agent sessions» (`leanAgents`) с подсказкой: `Agents Parley starts for rooms and spawn_session run without your plugins, other MCP servers and auto-memory — about 40 % less context per turn. Parley's own tools and hooks, your skills, the project CLAUDE.md and skills stay; MCP servers for a work are chosen in Capabilities.` Блокировка `locked` как у `autoLaunch`.
- [ ] Диалог комнаты: участники создаются с `lean: config.leanAgents`; одиночная сессия — чекбокс «Lean session» (по умолчанию выключен), значение уходит в `sessions.create`. `useHostSupports` не нужен: старый хост поле отбросит.
- [ ] Тесты: тумблеры читают и пишут `settings.set`; диалог комнаты шлёт `lean: true` при включённой настройке и `lean: false` при выключенной; одиночная сессия без галочки поля не шлёт.

**Приёмка:** тесты окна зелёные; раскладка 800×500 диалога настроек не ломается (E2E настроек, если есть; иначе снимок в задаче 5).

### Task 5: Проверка куска 1

- [ ] `pnpm build`, полный `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- [ ] Живая проверка автором (dev-окно): создать комнату из двух сессий Claude при включённой настройке; в `ps` у процессов `claude` видны `--strict-mcp-config`; `~/.parley/.../settings/<id>.json` содержит `enabledPlugins` со всеми `false`; в сессии `/mcp` показывает только `parley`; хуки Parley работают (статус сессии меняется, `report` доходит); `CLAUDE.md` проекта и `PARLEY.md` в контексте (спросить агента, что он видит в системных инструкциях — один дешёвый ход, по разрешению).
- [ ] Замер контекста: первый `cache_creation_input_tokens` в транскрипте lean-сессии против обычной той же задачи — ожидание ≈ −19 тыс.
- [ ] CHANGELOG `Unreleased`: Added — Lean agent sessions.

---

## Кусок 2. Меньше ходов: MCP и гид (ветка `feat/fewer-turns` после слияния части A)

### Task 6: `wait_for` помечает прочитанным (C1.1)

**Файлы:** `packages/core/src/mcp/tools.ts` (`wait_for` ~945-1012, `check_inbox` ~1117-1121), `packages/core/src/work/delivery.ts` (хвост указателя `:71`), `tools.test.ts`, `delivery.test.ts`.

- [ ] При возврате `state: "message"` письма помечаются прочитанными тем же путём, что в `check_inbox` (`readBy`; после части B — курсор). Пометка — после формирования ответа, в одной записи.
- [ ] Описание `wait_for` и гид (`guide.ts:183-189`): «returns and marks delivered messages as read; call check_inbox only when you are not waiting».
- [ ] Хвост указателя: `Call check_inbox or wait_for("inbox").`
- [ ] Тесты: после `wait_for` с письмом `check_inbox` пуст; повторный `wait_for` без новых писем ждёт до таймаута и отдаёт `running`; письмо, пришедшее во время ожидания, возвращается и помечается; старый клиент, зовущий `check_inbox` после `wait_for`, получает пусто без ошибки.

**Приёмка:** в тестовой комнате последовательность `wait_for → wait_for` без новых писем не возвращается мгновенно.

### Task 7: `get_map` без справочника провайдеров (C1.4)

**Файлы:** `packages/core/src/mcp/tools.ts` (`get_map` описание ~378, обработчик ~631-645, `field` enum), `tools.test.ts`.

- [ ] `providers` уходит из ответа по умолчанию; `field: "providers"` возвращает каталог; `spawn_session` при неверной модели или усилии добавляет в текст ошибки допустимые значения этого провайдера (чтобы не звать `get_map` заново).
- [ ] Описание `get_map` и `spawn_session` обновлены; гид — одна фраза в теме сессий.
- [ ] Тесты: размер ответа `get_map` на фикстуре спайка ≤ 40 % прежнего; `field: "providers"` отдаёт прежний список; ошибка `spawn_session` называет модели провайдера.

**Приёмка:** на карте спайка (`w-0055`) ответ ≤ 1000 токенов o200k вместо 2332.

### Task 8: Короче описания инструментов (C2.1)

**Файлы:** `packages/core/src/mcp/tools.ts` (массив инструментов), `packages/core/src/work/guide.ts` (темы `mail`, `rooms`, `sessions` принимают переехавшие правила), новый тест `tools-size.test.ts`.

- [ ] Каждое описание — назначение, аргументы, одна фраза об ошибке; правила, исключения и примеры — в соответствующую тему `read_guide`. Самые длинные сейчас: `get_map`, `spawn_session` (`model`, `effort`), `read_room`, `send_message`, `wait_for`.
- [ ] Тест размера: `Buffer.byteLength(JSON.stringify(TOOLS))` ≤ 60 % от значения на `master` до задачи (число фиксируется в тесте с комментарием, откуда).
- [ ] Гид после переноса — в пределах `STABLE_POLICY_MAX_BYTES`/`GUIDANCE_MAX_BYTES` (`context-budget.ts`), существующий тест размера остаётся зелёным.

**Приёмка:** первый ход lean-сессии легче ещё на 2–3 тыс. токенов (замер в задаче 13).

### Task 9: Гид: тишина, одно ожидание, ведущий ждёт один раз (C1.3)

**Файлы:** `packages/core/src/work/guide.ts` (темы переписки ~191-217 и комнат ~265-304), `packages/core/src/work/brief.ts` (бриф участника комнаты), `guide.test.ts`, `brief.test.ts`.

- [ ] Правила: не подтверждать получение и не объявлять начало — молчание значит «получил»; писать результат, вопрос или решение; ждать одним `wait_for("inbox", 1800)` без текста до и после, без `Monitor`, `sleep` и циклов; на `running` — один повтор, затем закончить ход: Parley разбудит указателем; ведущему — ждать ответов одним `wait_for("inbox")`, не по id исполнителей.
- [ ] Строка о принятии плана: убедиться, что системная строка `rooms.resolveProposal` видна участникам в `check_inbox` (сейчас `m-05 system→human`): если нет — адресовать её ведущему и участникам, чтобы ведущий не писал «план принят».
- [ ] Тесты: тема переписки содержит «silence», «1800», «do not narrate»; бриф участника комнаты — ссылку на правило.

**Приёмка:** тесты зелёные; размер вставки в пределах.

### Task 10: Проверка куска 2

- [ ] Полный прогон core и host, `pnpm typecheck`, `pnpm lint`.
- [ ] CHANGELOG `Unreleased`: Changed — `wait_for` marks messages read, `get_map` without the providers catalog, shorter tool descriptions, correspondence rules.
- [ ] Линза: Review Focus пп. 3 и 5.

---

## Кусок 3. Пробуждение по значимости (ветка `feat/wake-settle`)

### Task 11: Срочность письма и окно тишины

**Файлы:** `packages/core/src/work/delivery.ts` (`deliveryAction`, текст указателя ~67-91), `packages/core/src/work/letters.ts` (новая `urgencyOf(message, sessionId, room)`), `packages/host/src/wake/wake-service.ts` (`recompute` 506, `beginAttempt` 427, отложенные указатели), `packages/core/src/mcp/tools.ts` (`wait_for` — та же срочность), тесты всех трёх.

- [ ] `urgencyOf`: `urgent` — от `human`; `to` включает меня; `@sNN` на меня в тексте; `kind: question`; `kind: decision` от ведущего; `roomTask`/системные строки комнаты. Иначе `deferred`.
- [ ] Будильник: простаивающему агенту `urgent` — указатель сразу (как сейчас); `deferred` — таймер `SETTLE_MS = 30_000` на сессию, сброс при новом письме, по истечении один указатель «New messages (N)»; `urgent` сбрасывает пачку вместе с собой. Занятый агент — без изменений (ждёт конца хода). Таймеры `unref`, снимаются при остановке и удалении сессии.
- [ ] `wait_for("inbox")`: `urgent` возвращается сразу; `deferred` — после `SETTLE_MS` тишины или вместе со срочным; все отдаваемые помечаются прочитанными (задача 6).
- [ ] Тесты: три участника, `note` без адресата — указатель адресатам через 30 с, один на пачку из трёх; `question` — сразу; письмо человека — сразу всем; удаление сессии снимает таймер; `wait_for` с несрочным письмом возвращается не раньше окна (fake timers).

**Приёмка:** на мок-комнате из трёх агентов и пяти несрочных заметок — 3 указателя вместо 15.

### Task 12: Проверка куска 3

- [ ] Полный прогон хоста и core, `pnpm typecheck`, `pnpm lint`; E2E комнат после `pnpm build`.
- [ ] CHANGELOG `Unreleased`: Changed — room notes without a mention wake idle agents in batches after 30 s; questions, mentions and human messages wake at once.
- [ ] Линза: Review Focus п. 4.

---

## Кусок 4. Замер

### Task 13: Три прогона драйвером спайка (по разрешению человека)

**Файлы:** драйвер `spike-room.cjs` и тексты задач A/B из спайка 0.2 (scratchpad сессии 2026-10-16; перенести в `docs/research/2026-10-16-mail-economy-spike/` вместе со скриптом разбора транскриптов), результаты — в спеку части C.

- [ ] Та же задача (ревью отчёта), тот же состав (Claude Sonnet ведущий и ревьюер, Codex ревьюер), правила части A в гиде (не в задаче). Три прогона после кусков 1–3, сравнение медианы с прогоном B спайка 0.2: `rooms.usage.totalInput`, ходы ведущего по транскрипту, стартовый контекст.
- [ ] Критерии: входные токены комнаты −30 % и больше; ходов ведущего ≤ 20; `wait_for` подряд без нового письма — 0; подтверждений — 0; результат не хуже по разбору человеком.
- [ ] Codex только при остатке недельной квоты; иначе второй ревьюер — Claude с пометкой в результатах.

---

## Порядок

| Шаг | Задачи | Ветка | Условие |
|---|---|---|---|
| 1 | 1–5 | `feat/lean-sessions` | сразу; с частью A не пересекается |
| 2 | 6–10 | `feat/fewer-turns` | после слияния части A (общий `tools.ts`, `guide.ts`) |
| 3 | 11–12 | `feat/wake-settle` | после шага 2 (использует пометку прочитанного из задачи 6) |
| 4 | 13 | — | после слияния шагов 1–3, с разрешения на платные ходы |

Оценка: кусок 1 — S–M (день–два мелкими кусками), кусок 2 — M, кусок 3 — M, замер — два часа работы комнат.

## Кандидаты в кусок 1б (по решению пользователя)

- **MCP на работу.** Панель Capabilities: отметка серверов пользователя, которые получают агенты этой работы; Parley копирует их определения из `~/.claude.json` (чтение) в свой `--mcp-config`, у Codex — `-c mcp_servers.<id>.enabled=true` для отмеченных; хранится в карте работы (`work.mcpServers: string[]`), применяется при создании и `resume`. Гид: «нужен чужой MCP — назови человеку сервер». Размер: M.
- **Скиллы отключённых плагинов в `find_skill`.** Каталог читает `SKILL.md` из кэша плагинов (`~/.claude/plugins/…`) и отдаёт путь с пометкой `plugin (disabled)`; агент читает текст и следует ему, хуки и команды плагина не работают. Размер: S–M. Нужно, если агентам комнат нужны superpowers-подобные скиллы при выключенных плагинах.
- **Ponytail (`minimal-development`) v5.** Ветка `feat/minimal-development-v5` (origin, 7aae322, 10 строк: перечислить зону поражения правки до неё; переносимый код сохраняет свои гарантии; финальный отчёт называет пропущенное) конфликтует с master после v0.11.0 — влить master, разрешить, открыть PR. Размер: S.

## Что откладывается

- `--bare` для GLM: отдельный спайк на ключе (проверить `--add-dir` для `CLAUDE.md` проекта и хуки).
- Lean-режим для сессий, которые человек запускает сам из окна, по умолчанию: решение после живого использования.
- Дельты в `works.changed`, вынос экранов в воркер — не часть C.
