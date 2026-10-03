# Parley: общий слой проекта и навигатор скиллов — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Дать Claude и Codex общие правила, роли, планы и память проекта, готовые комнаты и поиск нативных скиллов с проверяемым результатом работы.

**Architecture:** Core читает нативные источники и собирает один слой сессии; host управляет состоянием, снимками и доставкой событий; desktop показывает одну панель проекта и существующие комнаты. Навигатор и Capabilities используют общий каталог скиллов, но применяют разные фильтры и держат разные снимки. Оба CLI продолжают загружать выбранный скилл своим способом.

**Tech Stack:** TypeScript, Node.js ≥20, pnpm 9, Vitest; Electron/React и Playwright для desktop; существующий MCP SDK. Полноценные parsers: `yaml` **2.9.1** (ISC), `smol-toml` **1.9.0** (BSD-3-Clause), точные pins без caret.

Дата: 2026-10-03. Статус: документация сверена; workflow реализации запущен в отдельном worktree. P00–P04 независимо приняты; P05 и P09 выполняются, реализация не завершена. Evidence и ограничения — в [принятом контракте P04](../research/2026-10-03-parley-cli/contracts.md). Актуальные результаты — в [журнале выполнения](2026-10-03-parley-execution.md). Новые согласующие ограничения описаны ниже и внесены в исходные спеки. Принятие прежних дизайнов человеком не означает, что новые проверки уже пройдены.

План относится к ветке `docs/parley-md`. В момент сверки её база — `fecaea3`, текущий `master` — `72a8736`; исходники ветки старше реализации подсказок chat-view в `master`. До начала кода нужно согласовать рабочую базу с актуальным `master`, сохранив документацию и чужие изменения. Для реализации создана отдельная ветка `codex/parley-upgrade` от `master 72a8736`; согласованная документация перенесена snapshot-коммитом `1acc937`. Ветка `docs/parley-md` сохранена.

Критерий этой документальной задачи: все семь спек используют одни контракты; план покрывает их v1, задаёт порядок, точные места изменений и проверяемые критерии. Будущие тесты ниже — задания реализации, а не результаты текущего прогона.

## Источники и границы

| Спецификация | Что берём в v1 | Этапы |
|---|---|---|
| [PARLEY.md](../specs/2026-10-02-parley-md-design.md) | слой, мост Codex, шаблон и Open/Create | 2 |
| [Роли](../specs/2026-10-02-agent-roles-design.md) | восемь встроенных, нативные роли двух CLI, ограничения записи | 3 |
| [Навигатор](../specs/2026-10-03-skill-navigator-design.md) | локальный поиск, `for`, сокращение списка после проверки CLI | 0–1, 4 |
| [Capabilities](../specs/2026-10-02-capabilities-design.md) | одна панель, снимок, MCP/плагины, «дать второму» | 0–1, 5 |
| [Планы и бэклог](../specs/2026-10-02-plans-backlog-design.md) | общий/локальный state, предложения, Checklist/Verified и будильник | 6–7 |
| [Рецепты](../specs/2026-10-02-room-recipes-design.md) | Plan & build, Review, Debug и рецепты проекта | 8 |
| [Память и журнал](../specs/2026-10-03-memory-journal-design.md) | решения, история, общая память и текстовый поиск | 9–10 |

Вне этой реализации остаются отдельная модель выбора скилла, хуки на каждый промпт, свой маркетплейс, векторный поиск, импорт памяти CLI, API-цикл агента, изменение глобальных файлов правил и остальные исключения в исходных спеках. Встроенный GLM не получает новых флагов; Claude-подмена GLM получает текст слоя только через уже заявленный шаблон, без предположения о поддержке навигатора.

Отдельных планов с конкурирующей очередью не заводить: этапы этого документа — единая очередь. Мелкие подзадачи можно разделять на коммиты внутри этапа.

[Очередь задач для агентов](2026-10-03-parley-agent-tasks.md) раскладывает эти этапы на 34 задания с зависимостями, владением файлами и независимой приёмкой. Workflow запущен; назначения и evidence находятся в очереди и журнале выполнения.

<a id="shared-contracts"></a>

## Общие контракты

### Источники, провайдер и рабочая папка

- `projectPath` — основная копия проекта: PARLEY.md, память, бэклог, снимки, рецепты и журнал читаются/пишутся здесь через `stateDir`, включая поддержку прежнего `.harnas/`.
- `cwd` — папка конкретной сессии: нативные правила проекта, роли и скиллы берутся в контексте её CLI и worktree. Индекс `for: s-02` не использует папку ведущего.
- Общий каталог живёт в `packages/core/src/skills/`; уже существующий в актуальном `master` `capabilities/scan.ts` переводится на него с сохранением контракта подсказок chat-view.
- Каталог хранит установленную запись и доступность модели с причиной. Панель показывает оба состояния; навигатор фильтрует недоступное до поиска. Приоритеты имён, уровни настроек и источники подтверждает этап 0.
- Человеческие выключения читаются до построения временных флагов Parley. Они не теряются при наложении `skills.config`; глобальная конфигурация остаётся только источником чтения.
- Нативные источники разных CLI не смешиваются. Capabilities может создать симлинк по явному действию человека; `find_skill(for)` только читает второй каталог.

Минимальный внутренний контракт (не тип протокола панели):

```ts
interface NativeSkill {
  provider: 'claude' | 'codex';
  name: string; // имя загрузки CLI, включая префикс плагина
  description: string;
  source: 'user' | 'project' | 'plugin' | 'claude.ai' | 'system' | 'admin' | 'extra';
  path: string; // canonical полный document path; identity = provider + canonical path
  documentKind: 'skill' | 'command'; // internal origin; never infer from canonical basename
  modelAvailable: boolean;
  unavailableReason: string | null;
}
```

Identity — `(provider, realpath(document))`, где document — полный SKILL.md или Claude command .md. Symlink aliases одного файла дедуплицируются; разные canonical файлы Codex с одинаковым именем сохраняются. Unknown availability даёт `modelAvailable=false` / `availability-unverified`; фильтр применяется до ranking. Человеческие Codex rules — native User и SessionFlags в исходном порядке (не project skills.config); policy и human rules вычисляются до Parley suppression с отдельным provenance. Source-backed system/admin/extra/plugin roots не означают проверенную доступность; неполный/unreadable root — partial, не успешный пустой каталог. Типы панели получают только whitelist безопасных полей; сырой конфиг MCP не пересылается.

### Слой и настройки запуска

Один сборщик для нового запуска, быстрого старта, autoLaunch и `resume`:

```text
systemGuidance (≤14 строк)
→ строка моста Codex
→ роль (без дублирования нативного промпта Claude)
→ снимок плейбука рецепта, только ведущему
→ бриф тихой сессии
→ обработанный PARLEY.md
→ факты памяти проекта
```

`find_skill` добавляет условную подсказку в существующую строку `read_guide`. Списки описаний, тела скиллов и подробности памяти в слой не входят. Все расширения guidance проверяются одним тестом в комбинациях флагов и режимов.

Лимиты: обработанные PARLEY.md, роль и плейбук — каждый ≤32 768 байт UTF-8 **включая конечную marker строку**, с documented обрезкой по последней строке и безопасным warning; native permissions/model/effort не усекаются. Память — 12 288 байт: builder при overflow возвращает безопасную числовую ошибку, P29 caller выбирает complete facts в бюджет, без marked truncation памяти. Окончательный сериализованный обязательный аргумент после preprocessing/escaping — ≤98 304 байт, включая ключ Codex; только его переполнение даёт `session-layer-too-large` до spawn, не повторную обрезку сборки.

Host проверяет final argv/env непосредственно перед `pty.start`, после `agentEnv(process.env)`, `plan.env` и `PARLEY_HOOK_TOKEN`: сумма UTF-8 байт executable/каждого argv/env `key=value` с NUL + `pointerSize * (argc + envc + 2)` + reserve 32 768 должна укладываться в runtime ARG_MAX. NUL запрещён; Linux требует отдельного bound каждой строки `32 * pageSize` с NUL. Runtime limits bounded/injectable, не переносить macOS ARG_MAX на Linux; недоступные limits дают безопасную ошибку, E2BIG очищается без raw argv/env. Core-only check не доказывает final env guard. Guard failure unregister hook token.

Overflow необязательного generated suppression убирает его **целиком**, сохраняет human flags и полный native list; args/env пересобираются и проверяются вновь. Если overflow остаётся, возвращается отдельная безопасная spawn-budget ошибка. Host log получает warning на каждой попытке; notices PARLEY.md — один раз host/project, `provider-override-gap` — один раз host global. Обычная custom Codex подмена без placeholder даёт warning и запуск без слоя/моста; отказ применяется только к недоставимой обязательной роли/permissions. macOS synthetic argv/env evidence принято; Linux, long paths/custom env/provider overrides и live lifecycle остаются [gates P32](../research/2026-10-03-parley-cli/contracts.md#10-оставшиеся-gates-и-сдача).

`skillNavigator` читается один раз на запуск. Значение используется для флагов, подсказки и явно передаётся дочернему MCP через его окружение; сервер не решает независимо по более новому глобальному конфигу. При включении файл настроек Claude — `settings/<session-id>.json` внутри каталога работы; обычные хуки и statusLine сохраняются. При выключении навигатора остаётся прежний путь настроек и поведение запуска.

### Роль, назначение и рецепт

- Роль задаёт ограничения и умолчания. Скилл не меняет модель, усилие, права записи или провайдера роли.
- В Free ведущий раздаёт части сообщениями. В Checklist/Verified он выбирает скилл до предложения плана и пишет подсказку в `scope`; после Accept назначение доставляет Parley. Повторная самостоятельная раздача тех же пунктов не нужна.
- Поля `skill` у сессии, рецепта и пункта нет. `find_skill` ищет подходящий вариант, участник сам загружает его. «Скилл не нужен» — полноценный результат.
- Проверяющему скилл ищется отдельно по его CLI. Наличие или загрузка скилла не означает выполнения критериев.
- Recipe хранит снимок плейбука, а не снимок каталога машины. Правка рецепта действует на новые комнаты; новый ведущий получает старый снимок письмом и при следующем запуске.
- `skillNavigator: false` и отсутствие подходящих скиллов не блокируют роли, планы, рецепты, бэклог или память. `agentSkills` независимо управляет установкой встроенного скилла `parley`.

### Снимки, версии и локальное состояние

- Панель Capabilities: снимок host в памяти, Refresh/повторное открытие обновляют его; watcher не добавляется.
- Навигатор: индекс в процессе MCP, отдельно по контексту провайдера/cwd; новый запуск или `resume` MCP обновляет его. Для закрытой сессии `for` читает текущий каталог, не обещает исторический снимок. Удалённый worktree — пустой результат с причиной, без подмены основной копией.
- Решения: файл `<дата>-<работа>-<комната>-<решение>-rev-<rev>.md`.
- Планы: файл `<работа>-<комната>-<план>-rev-<rev>-<событие>.md`, события `accepted`, `completed`, `cancelled`. Принятые версии не затираются; повтор события идемпотентен.
- Мутации плана несут `planId` и `rev`. Сохранение статуса при переделке требует неизменных title/owner/scope/after/criteria/verifier; изменения инвалидируют сдачу и проверку затронутых пунктов и зависимых результатов. Старый ответ проверяющего получает конфликт.
- Решение ссылается на снимок своей версии/события. Share history намеренно обновляет пользовательский снимок истории; к нему правило неизменяемости решений не относится.

Полный белый список состояния после этапа 10:

```gitignore
*
!.gitignore
!backlog.md
!plans/
!plans/**
!recipes/
!recipes/**
!decisions/
!decisions/**
!memory.md
!history-shared/
!history-shared/**
```

Индексы, settings, works, истории без Share, receipt, suggestions, locks и preferences остаются локальными. Добавление исключений выполняется только для файла Parley: старого `*` или точной прежней сгенерированной версии; правленный человеком файл не переписывается. Корневой `.gitignore` Parley не меняет.

### Память и поиск

`find_skill` ищет по имени/полному описанию нативного скилла (BM25, кеш MCP); `search_history` читает записи проекта и не имеет постоянного индекса. `remember` не копирует тела SKILL.md, списки машины и настройки плагинов. Короткий урок проекта допустим, но доступность скилла в следующей задаче проверяется заново.

## Очередь и зависимости

| Этап | Результат | Требует |
|---|---|---|
| 0 | актуальная база, доказательства CLI и выбранные парсеры | документация |
| 1 | общий каталог, YAML/TOML и переход сканера chat-view | 0: источники |
| 2 | сборщик слоя, PARLEY.md и доставка Codex | 0: доставка |
| 3 | каталог ролей и ограничения запуска | 1–2 |
| 4 | навигатор, MCP, настройки и проверенный короткий список | 1–3, 0: конкретные CLI-флаги |
| 5 | панель Capabilities и нативные действия | 1, 0: команды Capabilities |
| 6 | общее/локальное состояние, бэклог и предложения | 2, 5: каркас панели |
| 7 | Checklist/Verified, версии и будильник | 6 |
| 8 | встроенные и проектные рецепты | 3, 7; 4 необязателен |
| 9 | журнал принятых версий и история | 7; 8 необязателен |
| 10 | память и поиск по всем источникам проекта | 2, 6, 9 |
| 11 | проверки целиком, документация и выпуск | готовые этапы выбранного выпуска |

Это рекомендуемый последовательный порядок; независимые этапы 1/2 и 4/5 допускают независимые коммиты после своих проверок. Полная панель и установка плагинов не являются условием работы `find_skill`. Этап 6 требует только каркас панели этапа 5, а не всех её действий.

В каждом этапе: сначала поведенческий падающий тест, затем минимальное изменение, затем указанный целевой прогон и коммит ограниченного объёма. Для текста/кнопки без новой логики достаточно существующей проверки и ручного просмотра. Не запускать все тесты после каждой правки текста.

<a id="step-0"></a>

### Task 0: База и разведка CLI

**Файлы:** создать `docs/research/2026-10-03-parley-integration-spike.md`; обновить открытые вопросы спек навигатора, Capabilities и ролей; проверить `package.json`, `pnpm-lock.yaml` и исходники базовой ветки.

1. Сверить `git status`, рабочие ветки и merge-base; подготовить реализацию на актуальной базе chat-view без потери этой документации. Не переносить старую версию кода поверх новой.
2. Во временных проектах и пользовательских тестовых конфигах проверить таблицу ниже. Записать версии CLI, argv, ожидаемое/полученное поведение и обезличенные транскрипты. Не запускать регистрацию серверов или изменение глобальных настроек ради этой проверки.
3. Приняты точные pins `yaml@2.9.1` / `smol-toml@1.9.0`, лицензии и API Node 20 smoke по [P04](../research/2026-10-03-parley-cli/contracts.md#5-p05-полноценные-parsers-и-пределы); фиксация в core/lockfile — P05. Собственный частичный parser не расширять.
4. Вписать результаты в исходные спеки. Неподтверждённое сокращение списка оставлять выключенным для соответствующего CLI; базовый поиск/слой не блокируется чужим провайдером.

| Проверка | Положительное доказательство | Если не подтверждено |
|---|---|---|
| Claude budget: env budget=1 candidate; fraction=0 invalid | P01 подтвердил имена небандлённых скиллов при env1; schema отвергает fraction0 | production full list до resolver parity, role/lifecycle P32 gates |
| Выключение jev только в сессии | нет вставок jev; сохраняются хуки Parley, statusLine, конец хода и будильник | не гасить все функциональные хуки; диагностика и полный список |
| Skill/`find_skill` у главной нативной роли и субагента Claude | разрешённые инструменты доступны; урезанный tools обработан | не сокращать список у роли без проверенного пути загрузки |
| Источники Claude, commands и приоритеты/включённость плагинов | совпадение с родным `skill_listing.names`, скрытия отражены отдельно | уточнить общий resolver до сокращения списка |
| Codex roots, plugins, `skills.config` и policy | источники, приоритеты и человеческие выключения известны; отключённый только Parley файл читается по пути | сохранить родной список; непроверенный источник не объявлять поддержанным |
| Codex ошибочная запись и длинный argv | нет падающего запуска из неподдержанного/переполненного необязательного override | не передавать такой override |
| Codex слой, мост, роль, read-only при launch/resume | `debug prompt-input` и сессия показывают доставку; MCP/report работает | соответствующий способ доставки не считать готовым |
| Capabilities команды/JSON и local MCP в worktree | формы list/available/details/check/actions и scope подтверждены | соответствующая часть панели отмечена недоступной, без догадок |
| Размер полного слоя/argv/env на macOS и Linux | проверены UTF-8, экранирование, длинные пути и окружение | ошибка до spawn и корректировка бюджета |

Принятая матрица evidence/fallback для каждой строки — [P04 §8](../research/2026-10-03-parley-cli/contracts.md#8-все-строки-этапа-0-evidence--fallback). Offline/source evidence не заменяет живые проверки.

MCP sampling для v1 не нужен; ответ о нём можно записать отдельно, он не задерживает код. Настройка `/jev-skill-suggestion:setup restore` принадлежит человеку и не выполняется автоматическим запуском Parley.

**Приёмка:** у каждого обязательного механизма есть evidence или явный запасной путь; новые флаги не попадают в код по одной неподтверждённой гипотезе. Пользовательские подмены провайдеров учитываются в отдельных фикстурах.

<a id="step-1"></a>

### Task 1: Общие источники и парсеры

**Создать:** `packages/core/src/skills/{types,frontmatter,claude,codex,catalog,search}.ts` и одноимённые `.test.ts`.
**Изменить:** `packages/core/package.json`, `pnpm-lock.yaml`, `packages/core/src/index.ts`; после актуализации базы — `packages/core/src/capabilities/{scan,frontmatter}.ts` и их тесты.

1. Зафиксировать временными папками поиск по CLI/cwd, настройки разных уровней, disabled/user-only/policy, коллизии, симлинки, циклы, битый файл и пределы обхода. Полное многострочное YAML-описание обязано пережить разбор, не только его первая строка.
2. Реализовать общий resolver с инъекцией корней. Предел **всего** SKILL.md — 65 536 байт inclusive; bounded max+1 read, strict UTF-8, frontmatter valid/missing/invalid, только начальный YAML mapping без body. Shared `yaml@2.9.1` parseDocument проверяет errors/unique keys и bounded aliases; `smol-toml@1.9.0` parse/stringify поддерживает multiline, таблицы/arrays; mapping/schema boolean/string fields без coercion. Исключения очищаются до code/position без source excerpts. Роли/recipes/settings используют эти же parsers с собственными input ceilings. Claude commands включены; synced требует account/manifest/config. Codex config-folder/deprecated/user/project/system/admin/plugin/extra roots и native User/SessionFlags order — по P04; непроверенные source/availability остаются unavailable, unreadable root partial.
3. Перевести чтение скиллов для существующих подсказок chat-view на resolver. Сохранить сигнатуру `capabilities.list`, подсказки команд/агентов и их ограничения; не превращать их в новый протокол панели.
4. Реализовать BM25: имя ×3, tokenizer/стоп-слова/окончания по спеке. Фиксировать порядок первых трёх, tie-break по native имени и canonical document path (побайтно), нулевой результат и детерминированность.

Показательная проверка: один скрытый скилл существует в каталоге с причиной, виден в данных панели и отсутствует в поиске; проектный скилл worktree находится для участника, но не подменяет каталог ведущего.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/skills src/capabilities`.
**Приёмка:** один обход источников обслуживает обе функции; текущие подсказки chat-view не регрессируют; fixtures проверяют whole-file boundary, strict UTF-8, missing/invalid header, multiline description, duplicate keys, bounded aliases, boolean/string schema и safe code/position diagnostics. NativeSkill canonical path остаётся внутренним: прежний chat-view `CapabilitySkill.path` — папка SKILL.md либо файл command; старый source enum не расширяется молча. Unknown availability исключается из ranking; полного native list это не сокращает.

<a id="step-2"></a>

### Task 2: Слой Parley и PARLEY.md

**Создать:** `packages/core/src/work/{session-layer,parley-md}.ts`, соответствующие тесты.
**Изменить:** `packages/core/src/{providers,providers.test,index}.ts`, `packages/core/src/work/{launch,launch.test,guidance,guidance.test}.ts`, `packages/host/src/sessions/{sessions-service,sessions-service.test}.ts`, `packages/desktop/src/renderer/sidebar/SectionMenu.tsx`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/preload/index.ts`.
**Дополнительное владение P09:** `packages/protocol/src/types.ts` — только NoticeKind additions для layer warnings в существующем wire DTO; новый notice DTO не вводится. Фактическое desktop принятие — P10.
**Создать UI-проверку:** `packages/desktop/e2e/parley-md.spec.ts` по образцу существующего `agent-skills.spec.ts`.

1. Проверить обработку комментариев вне fenced code, пустых вложенных разделов, UTF-8-предела с меткой; нетронутый шаблон даёт пустую часть. Проверить порядок полного слоя, тихий бриф и отсутствие ролей/памяти до появления соответствующих модулей.
2. Добавить сборщик с marked block preprocessing и проверкой final serialized args; host aggregate guard после final env/hook token — общий контракт выше и P04 §6. Передавать Codex `developer_instructions` и fallback CLAUDE.md по спекам; argv — массив, без shell. P09 последовательно владеет sessions-service/test и необходимым core export; P10 получает их позднее.
3. Добавить launch/resume/new/autoLaunch и предупреждения plain custom Codex без канала слоя с сохранением запуска; недоставимая обязательная роль/permissions — отказ. Проверить кавычки, backslash, newline, non-ASCII, final env и hook-token cleanup; dedup notices не подавляет host log каждой попытки.
4. Реализовать шаблон, эксклюзивное создание и receipt в stateDir. Удалённый файл не восстанавливается автоматически; явный Create работает; ошибка создания не мешает запуску.
5. Подключить Open/Create в меню проекта и вкладку редактора; проверить полную доставку через `codex debug prompt-input` и живую сессию Claude.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/providers.test.ts src/work/launch.test.ts src/work/session-layer.test.ts src/work/parley-md.test.ts src/work/guidance.test.ts`; целевой host-тест `src/sessions/sessions-service.test.ts`; `pnpm --filter @parley/desktop e2e e2e/parley-md.spec.ts`.
**Приёмка:** оба CLI получают слой, тихий Codex — бриф; старый предел guidance проходит; большой экранированный аргумент даёт диагностируемый отказ до spawn. Изменения при resume документируются с ожиданием сжатия контекста, без обещания немедленной доставки.

<a id="step-3"></a>

### Task 3: Роли

**Создать:** `packages/core/src/roles/{types,builtin,catalog,claude,codex}.ts` с тестами.
**Изменить:** `packages/core/src/work/{agents,types,map,launch,session-layer}.ts`, `packages/core/src/{providers,index}.ts`, `packages/core/src/mcp/{tools,server.test}.ts`, `packages/core/src/work/guide.ts`, `packages/protocol/src/{types,methods}.ts`, `packages/host/src/methods/sessions.ts`, `packages/host/src/sessions/sessions-service.ts`, `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx`, `packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx`.

1. Проверить миграцию `agent` в `role`, каталог восьми ролей, нативные коллизии, priority «явное → роль → provider», отсутствующий файл и пустой текст. Модельные id сверить с актуальным `provider-models.ts`, не дублировать независимую таблицу.
2. Подключить shared pinned YAML/TOML parsers; Codex auto-discovered agents/**/*.toml требует name и непустой developer_instructions, description после native layer merge, без filename fallback. Declared config_file name-hint вне v1; source-backed recursive roots/late same-name winner не заменяют live enforcement gate. Claude text отдаёт CLI, Codex main fields — args и блоком слоя, native main role flag отсутствует. Умолчания роли не писать как явный выбор в карту.
3. Добавить подстановки ограничений при launch/resume. Создание роли без канала текста или обещанного read-only отвергать до записи успешной сессии; Claude Bash ограничен инструкцией, это явно описать в README.
4. Добавить `list_roles`, `spawn_session(role)` и `get_map.role`; сохранить legacy `agent`, но сочетание `agent` и `role` отклонять.
5. Подключить выбор, чип и lock в UI; проверить MCP/report у ролей с ограничениями. В роли planner план сдаётся через Parley, запрет записи файлов не превращает его в исполнителя.

**Проверка:** core `pnpm --filter @parley/core exec vitest run src/roles src/work/agents.test.ts src/work/map.test.ts src/work/launch.test.ts src/providers.test.ts src/mcp/server.test.ts src/english-text.test.ts`; protocol `pnpm --filter @parley/protocol test`; целевые host/UI-тесты затронутых файлов.
**Приёмка:** роль — действующий текст/ограничения, а не подпись; явный выбор сохраняется; native-role tools доступны или ограничение отражено без обещания навигатора. Английские тексты восьми ролей просматривает человек перед выпуском.

<a id="step-4"></a>

### Task 4: Навигатор и запуск CLI

**Изменить:** `packages/core/src/mcp/{context,server,tools,annotations.test}.ts`, `packages/core/src/work/{mcp-config,mcp-config.test,settings-file,settings-file.test,launch,launch.test,guidance,guidance.test,guide}.ts`, `packages/core/src/{config,config.test,providers,providers.test}.ts`, `packages/host/src/methods/settings.ts`, `packages/desktop/src/renderer/components/settings/{SettingsDialog,SettingsDialog.test}.tsx`.
**Создать:** `packages/core/src/mcp/find-skill.test.ts`, `packages/core/src/skills/navigator-launch.test.ts`.

1. Сначала проверить схему, `READS`, отсутствие инструмента при выключении, свои/чужие/закрытые `for`, blank query, limit 1–10 и отсутствие подходящего скилла. Чужая работа — ошибка; удалённый cwd — пустой результат с причиной.
2. Подключить cached catalog/search к серверу. Claude индексируется лениво; Codex — при старте для имён в описании. Названия и полные descriptions возвращаются с родным способом загрузки.
3. Зафиксировать конфиг/env-snapshot на launch и передачу в MCP. `agentSkills=false, skillNavigator=true` работает; выключение навигатора удаляет только его поведение. Два одновременных запуска с разными snapshot не портят settings друг друга.
4. Production сохраняет оба полных native списка до resolver parity и positive live P32 gates. Claude fraction0 invalid; env1 только candidate, bundled exception сохраняется. Jev candidate — точный обнаруженный `jev-skill-suggestion@skills-dir` в session enabledPlugins=false, без выключения функциональных хуков/statusLine/report/end-turn/wake и без setup restore. Codex budget/include_instructions и canonical-file/name suppression — candidate off; human User/SessionFlags/policy/provenance неизменны. Partial/unsupported/oversized → omit весь generated suppression, полный список и поиск, не launch retry с invalid flags.
5. Объединить guidance с ролями/планами/памятью: `find_skill — skills by task, if needed`; в lead guide — `for` и выбор до предложения плана. Добавить английский переключатель рядом с agentSkills, значение по умолчанию false.

Пример контрактов инструмента:

```json
{"query":"review typescript tests","for":"s-02","limit":5}
```

```json
{"provider":"codex","skills":[{"name":"review","description":"Review a code change.","source":"project","load":"Read /project/.agents/skills/review/SKILL.md"}]}
```

Текст `load` — подсказка своему CLI, не команда загрузки другого провайдера.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/skills src/mcp/find-skill.test.ts src/mcp/annotations.test.ts src/config.test.ts src/providers.test.ts src/work/settings-file.test.ts src/work/mcp-config.test.ts src/work/launch.test.ts src/work/guidance.test.ts`; UI `pnpm --filter @parley/desktop exec vitest run src/renderer/components/settings/SettingsDialog.test.tsx`.
**Приёмка:** агент находит и загружает свой скилл; ведущий находит скилл CLI участника; выключенный флаг воспроизводит прежний запуск. Сокращение отдельно подтверждено транскриптом, а report/конец хода/будильник работают. Включение по умолчанию не входит в этот этап.

<a id="step-5"></a>

### Task 5: Панель Capabilities

**Создать:** `packages/host/src/capabilities/{snapshot,claude,codex,actions,redact,share-skill}.ts` с тестами; `packages/desktop/src/renderer/components/project/{ProjectPanel,CapabilitiesPanel}.tsx` с тестами.
**Изменить:** `packages/protocol/src/{types,methods,events}.ts` и тесты, `packages/host/src/methods/{capabilities,index}.ts`, `packages/desktop/src/renderer/shell/{AppShell,RightSidebar}.tsx`, `packages/desktop/src/renderer/sidebar/SectionMenu.tsx`, `packages/desktop/src/renderer/palette/actions.ts`.

1. Проверить безопасный снимок, отдельную загрузку колонок, hidden reason, separate copies и builtin parley. Отдельный fixture-secret не должен появиться в сериализованном ответе, логируемой ошибке или событии.
2. Добавить `capabilities.get/refresh` и событие панели, сохранив `capabilities.list` подсказок. Скиллы брать только из общего resolver; команды native MCP/plugin — из подтверждённых форм этапа 0.
3. Сделать каркас единой панели проекта и просмотр; Backlog/Decisions/Memory подключаются позднее как её вкладки. Refresh не обещает изменения уже запущенной сессии.
4. Использовать [provider-specific actions P04 §7](../research/2026-10-03-parley-cli/contracts.md#7-provider-actions-и-безопасные-scopes): Claude plugin install/uninstall/enable/disable/update с user/project/local scope; details installed-only, pre-install inventory/cost unknown. Codex plugin add/remove без scope; details/toggle/update/check unavailable. Claude MCP ordinary snapshot из файлов, explicit Check text; local identity canonical main, .mcp.json session cwd. Codex MCP list/get JSON — metadata/auth, не connection check; add/remove user-only, unsupported JSON fields unavailable. Marketplace actions и rollback только по подтверждённым формам. `execFile`, argv; whitelist DTO/redaction **включая success stdout**, raw config/output в UI не отправлять.
5. Добавить «дать второму/забрать» через проверенные симлинки и receipt: занятая папка — отказ, чужая ссылка не удаляется, builtin защищён. Скрытый или несовместимый скилл не становится автоматически доступным модели.

**Проверка:** `pnpm --filter @parley/host exec vitest run src/capabilities src/methods/capabilities.test.ts`; protocol и тесты новой панели; native действия в отдельном тестовом проекте.
**Приёмка:** один безопасный снимок, все действия из v1 исходной спеки покрыты; установленное видно независимо от навигатора. После передачи скилла новая сессия второго CLI обнаруживает его с учётом собственных правил. Каркас панели можно сдать раньше действий, чтобы не задерживать этап 6.

<a id="step-6"></a>

### Task 6: State, бэклог и предложения

**Создать:** `packages/core/src/work/{backlog,backlog-suggestions,project-preferences}.ts` с тестами, `packages/host/src/methods/backlog.ts`, `packages/desktop/src/renderer/components/project/BacklogPanel.tsx` с тестами.
**Изменить:** `packages/core/src/work/{state-dir,state-dir.test,store}.ts`, `packages/core/src/mcp/tools.ts`, `packages/core/src/work/{guide,guidance}.ts`, protocol types/methods/events, `packages/host/src/methods/index.ts` и панель проекта.

1. Проверить переход только с точного старого/сгенерированного gitignore; custom и корневой запрет дают уведомление, не правку. Runtime-файлы не попадают в git при белом списке.
2. Реализовать разбор/редактирование backlog с сохранением чужого текста байт в байт, назначением id, lock/mtime и конфликтными маркерами; проверить concurrent write повторным чтением.
3. Добавить `backlog_list`, `backlog_suggest`, local preferences/suggestions, dedup и три правила ask/problems/everything. Агент не закрывает и не редактирует существующие пункты.
4. Подключить вкладку, Suggested, правило, Open file и Take into room; после успешного создания писать `taken`, не раньше. Добавить короткую подсказку в guidance, сохранив общий лимит.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/work/backlog.test.ts src/work/backlog-suggestions.test.ts src/work/state-dir.test.ts src/work/guidance.test.ts`; целевые protocol/host/UI-тесты.
**Приёмка:** `bug/debt` по умолчанию записываются, `idea` ждёт человека; чужой Markdown сохранён; worktree обращается к backlog основной копии; runtime локален.

<a id="step-7"></a>

### Task 7: Режимы, планы и доставка

**Создать:** `packages/core/src/work/{plans,plan-snapshots}.ts` с тестами, `packages/desktop/src/renderer/components/rooms/{PlanPanel,CompletionCard}.tsx` с тестами.
**Изменить:** `packages/core/src/work/{types,map,rooms,proposals,guide,guidance}.ts`, `packages/core/src/mcp/tools.ts`, `packages/host/src/{rooms/rooms-service,wake/wake-service}.ts`, `packages/host/src/methods/rooms.ts`, protocol types/methods/events, desktop `RoomHeader.tsx`, `DecisionCard.tsx`, `feed-model.ts`, `WorkSidebar.tsx`.

1. Проверить migration `mode=free`, права lead/owner/verifier/human, DAG, лимиты, один активный план и все разрешённые переходы. Минимальные пары: submit не закрывает Verified, owner не проверяет себя, старый rev не меняет новый план.
2. Добавить mode/plan model и MCP-сигнатуры из обновлённой спеки. Семантическая правка owner/scope/after/criteria/verifier/title сбрасывает результаты и зависимые проверки; пересчитывать очередь в том же обновлении карты.
3. Добавить system sender parley и события для ready/returned/blocked/completing/закрытия владельца. Использовать существующий wake, autoLaunch и лимиты; события дедуплицируются по plan/rev/item/переходу, а не посылаются при каждом чтении карты.
4. Реализовать принятие/возврат решения и итога, человеческие действия, понижение режима с подтверждением, отмену и закрытие связанных backlog-пунктов. Снимки accepted/completed/cancelled — по конкретному rev в обоих режимах;
   экспорт Checklist не требует дополнительного действия человека.
5. Добавить карточки, панель, прогресс и системные строки; `scope` с подсказкой скилла приходит в карточку, письмо и снимок без отдельного поля skill.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/work/plans.test.ts src/work/plan-snapshots.test.ts src/work/proposals.test.ts src/work/map.test.ts src/work/guidance.test.ts`; host `pnpm --filter @parley/host exec vitest run src/wake/wake-service.test.ts src/methods/rooms.test.ts`; целевые UI-тесты карточек/плана.
**Приёмка:** Checklist закрывается по done, Verified — после проверки и принятия итога человеком; возврат будит владельца; rate limit удерживает очередь; изменение области не сохраняет verified. Один принятый пункт не раздаётся повторно ведущим и host.

<a id="step-8"></a>

### Task 8: Рецепты комнат

**Создать:** `packages/core/src/recipes/{types,builtin,parse,catalog}.ts` с тестами; `packages/desktop/e2e/room-recipes.spec.ts`.
**Изменить:** `packages/core/src/work/{types,rooms,session-layer,state-dir}.ts`, `packages/host/src/rooms/rooms-service.ts`, protocol room/session types/methods, desktop `NewSessionOrRoomDialog.tsx`, `RoomHeader.tsx`, `packages/desktop/src/main/ipc.ts` для Save as recipe.

1. Проверить YAML и строгую схему: два участника, один lead с count=1, остальные count 1–3, известный mode, корректный role id; неизвестные поля не принимаются.
2. Добавить три собственных английских плейбука и рецепты проекта с общим parser. Рекомендация `find_skill(for)` условна и не превращается в обязательное применение скилла.
3. Подключить диалог, разворачивание count, сохранение только явно изменённых model/effort, выбор mode и Save as recipe; занятое имя требует rename/replace от человека.
4. Хранить snapshot комнаты, доставлять плейбук только lead; проверить смену lead, письмо и следующий запуск. Добавить исключения recipes к точному сгенерированному gitignore.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/recipes src/work/rooms.test.ts src/work/session-layer.test.ts src/work/state-dir.test.ts src/english-text.test.ts`; `pnpm --filter @parley/desktop e2e e2e/room-recipes.spec.ts`.
**Приёмка:** Plan & build, Review и Debug работают с включённым и выключенным навигатором; новый рецепт не меняет старую комнату; роли и запреты остаются действующими. Тексты трёх плейбуков просматривает человек перед выпуском.

<a id="step-9"></a>

### Task 9: Журнал и история

**Создать:** `packages/core/src/work/{decision-journal,room-history}.ts` с тестами, `packages/desktop/src/renderer/components/project/DecisionsPanel.tsx` с тестами.
**Изменить:** `packages/host/src/rooms/rooms-service.ts`, `packages/host/src/works/works-service.ts`, protocol types/methods/events, desktop `RoomHeader.tsx`, панель проекта и `state-dir.ts`.

1. Проверить имя/содержимое для accepted decision/completion, отдельность rev, повтор события и ссылку на точный snapshot. Return не создаёт принятого решения.
2. Подключить журнал к принятому переходу карты: ошибка записи не отменяет Accept; лог/уведомление и возможность повторить экспорт без дубля.
3. Добавить history из карты с debounce, системными событиями и metadata ролей/рецепта/mode. Карта остаётся источником правды, локальную историю можно пересобрать.
4. Добавить Decisions, Share/Unshare с подтверждением человека, shared timestamp и сохранением shared-файлов при удалении работы. Не добавлять историю одиночных сессий.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/work/decision-journal.test.ts src/work/room-history.test.ts src/work/plan-snapshots.test.ts`; соответствующие host/UI-тесты.
**Приёмка:** две принятые версии дают два файла и корректные ссылки; повтор Accept не дублирует; локальная история скрыта от git, shared — видна; принятие не теряется из-за сбоя диска.

<a id="step-10"></a>

### Task 10: Общая память и поиск

**Создать:** `packages/core/src/work/{project-memory,memory-suggestions,history-search}.ts` с тестами; `packages/host/src/methods/{memory,history}.ts`; desktop `project/MemoryPanel.tsx` и `project/ProjectSearch.tsx` с тестами.
**Изменить:** `packages/core/src/work/{session-layer,guide,guidance,state-dir}.ts`, MCP tools, protocol types/methods/events, `packages/host/src/methods/index.ts` и панель проекта.

1. Проверить сохранение Markdown, ids, dedup, lock/mtime/conflict, remember suggested/onHumanRequest и Undo. Прямую просьбу человека отражать отдельной пометкой; обычное предложение всегда ждёт приёма.
2. Реализовать memory_read и последний блок слоя: только факты с id, без details, ограничение 12 КиБ и метка. Проверить полный состав слоя и предел guidance вместе с навигатором, ролью и рецептом.
3. Добавить search_history по семи scope из спеки: all words в одной записи, rank по первой строке/новизне, excerpts, limit 1–30, файлы/строки/id. В каталоги скиллов и родную память CLI не ходить.
4. Добавить Memory/Suggested/Undo, поиск и открытие результата на нужной строке/комнате/сессии; расширить только сгенерированный gitignore.

**Проверка:** `pnpm --filter @parley/core exec vitest run src/work/project-memory.test.ts src/work/memory-suggestions.test.ts src/work/history-search.test.ts src/work/session-layer.test.ts src/work/guidance.test.ts`; новые host/UI-тесты.
**Приёмка:** принятый урок виден обоим CLI с учётом жизненного цикла слоя; приватная история не копируется в память; search_history находит прошлое решение, а find_skill продолжает искать только нативные скиллы.

<a id="step-11"></a>

### Task 11: Проверка целиком и выпуск

**Изменить:** `README.md`, `CHANGELOG.md`, `TODOS.md`, семь исходных спек; записать результаты в `docs/research/2026-10-03-parley-integration-spike.md`.

1. Пройти матрицу ниже в учебном проекте: default/off, on, normal/quiet, launch/resume, root/worktree, native role и provider override. Для неизвестного CLI-пути должен работать заявленный запасной путь.
2. Провести размеченный человеком набор около 15 промптов на Claude и Codex, с навигатором и без: верный скилл или «не нужен», без лишних загрузок. Сравнить качество с родным списком; для проверенного короткого режима Claude измерить ≤3000 знаков skill_listing на контрольной машине и записать состав каталога. Это размер контрольного набора, не универсальный предел любого каталога.
3. Проверить реальные сценарии рецептов, возврат Verified, изменение rev, ограничения записи, симптомы конфликта backlog/memory, ошибку snapshot и отсутствие утечек конфигов в UI.
4. Запустить один итоговый набор: `pnpm test`, `pnpm build`, `pnpm lint`, `pnpm typecheck`; затем релевантные desktop e2e. Повторять полный набор только после новых изменений/ошибок.
5. README на английском: источники/cwd, настройки, Create/Open, snapshot/refresh/resume, ограничения Claude read-only, override placeholders, пределы и рекомендации jev restore. Обновить CHANGELOG/TODOS по фактическому выпуску, не объявлять все этапы готовыми заранее.

**Приёмка:** критерии выбранных этапов пройдены, известные ограничения отражены, живые результаты сохранены. Навигатор выпускается opt-in; включение по умолчанию — отдельное решение человека по результатам качества и доставки. Для частичного выпуска честно перечислить оставшиеся этапы.

## Сквозная матрица приёмки

| Сценарий | Проверяемый результат |
|---|---|
| Навигатор off | нет find_skill, budget, jev-disable и skills.config от Parley; остальные функции работают |
| agentSkills off + navigator on | свои скиллы находятся, MCP жив, PARLEY.md создаётся независимо |
| Codex lead → Claude executor | for возвращает Claude-имена/Skill; lead не читает их как собственные Codex-скиллы |
| Claude lead → Codex reviewer | for возвращает Codex-путь; роль/ограничения рецензента сохраняются |
| Разные worktree | проектные скиллы каждого — свои; правила команды, backlog и memory — основной проект |
| Роль с урезанными tools | нет короткого списка без инструмента загрузки/поиска; предупреждение, подтверждённый запасной путь |
| Переключение настройки при старте | argv, guidance и MCP используют один snapshot; settings сессий не перетираются |
| Refresh панели во время работы | панель свежая, индекс идущего MCP не обещает обновления; после нового запуска каталог свежий |
| Изменение scope или verifier принятого пункта | прежняя проверка и зависимые результаты инвалидированы; старый rev отклонён |
| Принятие двух rev | отдельные решения/снимки, ссылки каждой версии открывают её собственный план |
| Слой с большими UTF-8/escaped блоками | проверен окончательный argv; диагностируемая ошибка до spawn |
| Подмена providers.json | нет обещания потерянного слоя/ограничений; роль без нужного канала не создаётся |
| Конфликт/ошибка файлов | чужой файл не повреждён; карта/принятое решение сохраняются; уведомление адресное |
| Память и скиллы | тела скиллов и каталоги машины не попадают в общий memory.md; поиски разделены |

## Что исправлено при сверке

1. Пять исходных дизайнов, навигатор и зависимая спека Capabilities собраны в одну очередь; отдельные обещания будущих планов заменены этапами.
2. Зафиксированы общий resolver, полный YAML/TOML, переход уже существующего сканера chat-view и различие установленного/доступного скилла.
3. Порядок слоя дополнен ролью, рецептом и памятью; предел считается после экранирования, а guidance проверяется целиком.
4. Навигатор включается одним snapshot запуска, не зависит от agentSkills и не разрушает хуки; запасной путь не обещает список из одних имён.
5. Выбор ведущего относится к CLI/cwd участника и попадает текстом в назначение. Постоянного поля skill и копирования SKILL.md в общий слой нет.
6. Переделки плана инвалидируют изменённые результаты; planId/rev защищают от запоздалой проверки, журнал и снимки сохраняют принятую версию.
7. Непроверенные сведения CLI оставлены в разведке, включение навигатора по умолчанию не объявлено принятым.
