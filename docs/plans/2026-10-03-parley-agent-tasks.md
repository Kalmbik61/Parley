# Parley: задачи для последующей реализации агентами

Дата: 2026-10-03. Workflow запущен в отдельном worktree; текущий ход отражён в [журнале выполнения](2026-10-03-parley-execution.md). Это декомпозиция [единого плана](2026-10-03-parley-unified-implementation-plan.md), а не новая архитектура или отдельная очередь релизов. Общие контракты и семь спек из плана имеют приоритет.

## Как выдавать задачи

1. Ведущий начинает с P00 и хранит точный базовый SHA/checkout. Агент работает на выданной рабочей базе, не на старом коде docs/parley-md.
2. Выдавать только задачу, все зависимости которой приняты как `done`. Не запускать весь список одновременно. P01/P02/P03 и затем P06/P07 можно выполнять параллельно в своих файлах; P09 независима от обходов скиллов после P04.
3. Одна задача — один ответственный исполнитель и отдельный проверяющий. Профили агентов в карточках — рекомендации для назначения, не настройки модели или нативной роли Parley. Если у выбранного агента роль только для чтения, файлы исследования записывает ведущий из его отчёта.
4. Исполнитель владеет перечисленными файлами и необходимыми целевыми тестами. Общие точки из таблицы ниже меняются только после выдачи права записи ведущим. Агент не один в репозитории: чужие правки не откатывать, интегрироваться с ними; при конфликте области вернуть запрос ведущему.
5. Результат сдать с commit/SHA или воспроизводимым diff, списком изменённых файлов, командами и итогом проверок, ограничениями. Нельзя отмечать задачу выполненной по одному сообщению «готово».
6. Проверяющий сверяет дифф с карточкой и спекой; ведущий интегрирует, проверяет затронутые общие контракты и только затем закрывает чекбокс. Непроверенная живая проверка остаётся явным блокером приёмки, а не успешным тестом.

Статусы: `pending → running → review → done`; `blocked` означает конкретную недостающую зависимость/внешнюю проверку с причиной. Статусы, ответственных и evidence в этом файле обновляет только ведущий. Текущие назначения и статусы — в таблице очереди и журнале выполнения; готовность определяется принятыми зависимостями.

### Общие файлы: один писатель в каждый момент

| Область | Файлы | Правило |
|---|---|---|
| Контракты wire | `packages/protocol/src/types.ts`, `methods.ts`, `events.ts` и их тесты | ведущий интегрирует согласованный DTO/метод и выдаёт право записи одному агенту |
| Host registry | `packages/host/src/methods/index.ts` | ведущий регистрирует методы из проверенного патча |
| Exports | `packages/core/src/index.ts` | один согласованный набор exports; P08 владеет исходным переходом |
| Запуск и общие модели | `providers.ts`, `work/launch.ts`, `types.ts`, `map.ts`, `session-layer.ts`, `state-dir.ts` | готовые зависимости недостаточны: пересекающиеся задачи получают последовательное право записи |
| MCP и инструкции | `mcp/tools.ts`, `work/guide.ts`, `work/guidance.ts`, `english-text.test.ts` | последовательная интеграция, ≤14 строк проверяется на полном сочетании функций |
| Панель и диалоги | `ProjectPanel.tsx`, `CapabilitiesPanel.tsx`, `SectionMenu.tsx`, `NewSessionOrRoomDialog.tsx`, `RoomHeader.tsx`, main/preload IPC | параллельно писать независимые компоненты; общий файл изменяет один агент |
| Зависимости | `packages/core/package.json`, `pnpm-lock.yaml` | P05 — единственный писатель после выбора P04 |
| План, спеки, очередь | `docs/plans/`, согласованные `docs/specs/`, таблица статусов | ведущий принимает согласующие изменения; P33 закрывает фактические результаты |

Изолированные worktree не отменяют правило общего писателя: ведущий обязан проверить возможные конфликты перед параллельной выдачей. Не создавать tmux/OMX runtime, goals или отдельные чаты только на основании этой очереди.

### Шаблон сообщения исполнителю

```text
Выполни задачу <ID> из docs/plans/2026-10-03-parley-agent-tasks.md.
Рабочий checkout: <path>, базовый SHA: <sha>.
Зависимости приняты: <IDs и evidence>.
Разрешённые общие файлы: <список либо «нет»>.
Прочитай карточку, соответствующий этап единого плана и нужную исходную спеку.
Ты владеешь областью карточки и её целевыми тестами. Ты не один в репозитории:
не откатывай чужие правки, согласуй пересекающиеся изменения с ведущим.
Сохраняй общий каталог, cwd/projectPath, default false, порядок слоя и ≤14 строк.
Сделай минимальную реализацию и необходимые поведенческие проверки.
Сдай diff/SHA, файлы, команды, результаты и конкретные оставшиеся ограничения.
Не начинай соседние задачи и не меняй статус очереди самостоятельно.
```

### Шаблон сообщения проверяющему

```text
Независимо проверь задачу <ID> по её карточке и исходной спеке.
Проверяемый checkout: <path>, base/head: <sha>/<sha> либо точный diff.
Сверь область, приёмку, миграции, выключенный режим и общие контракты.
Укажи actionable findings с файлом/строкой; отдели проведённые проверки от
заявленных исполнителем. Верни accepted либо needs rework с доказательствами.
Файлы автора не исправляй в рамках ревью.
```

## Очередь

| Задача | Этап плана | Зависимости | Ответственный | Состояние |
|---|---|---|---|---|
| [P00 — Подготовить актуальную рабочую базу](#p00) | 0 | — | /root/p00_prepare_base | done |
| [P01 — Проверить Claude: источники, budget, jev и инструменты](#p01) | 0 | P00 | /root/p01_claude_probe | done |
| [P02 — Проверить Codex: скиллы, слой, роли и resume](#p02) | 0 | P00 | /root/p02_codex_probe | done |
| [P03 — Проверить команды Capabilities и scopes](#p03) | 0 | P00 | /root/p03_capabilities_probe | done |
| [P04 — Закрыть контракты разведки и выбор парсеров](#p04) | 0 | P01, P02, P03 | /root/p00_prepare_base (P04) | done |
| [P05 — Реализовать общие типы и YAML/TOML-разборщики](#p05) | 1 | P04 | /root/p01_claude_probe (P05) | done |
| [P06 — Реализовать источники скиллов Claude](#p06) | 1 | P05 | /root/p01_claude_probe (P06) | review |
| [P07 — Реализовать источники скиллов Codex](#p07) | 1 | P05 | /root/p02_codex_probe (P07 fixes) | running |
| [P08 — Собрать каталог, BM25 и перевести chat-view на него](#p08) | 1 | P06, P07 | не назначен | pending |
| [P09 — Собрать слой сессии и доставку Codex](#p09) | 2 | P04 | /root/p02_codex_probe (P09) | done |
| [P10 — Подключить создание PARLEY.md и Open/Create](#p10) | 2 | P09 | /root/p02_codex_probe (P10) | review |
| [P11 — Реализовать каталог ролей и умолчания](#p11) | 3 | P05, P09 | /root/p01_claude_probe (P11) | running |
| [P12 — Подключить роли к запуску, MCP и диалогу](#p12) | 3 | P11, P10 | не назначен | pending |
| [P13 — Реализовать find_skill и настройку MCP](#p13) | 4 | P08, P12 | не назначен | pending |
| [P14 — Подключить навигатор к CLI и Settings](#p14) | 4 | P13 | не назначен | pending |
| [P15 — Реализовать безопасный снимок Capabilities](#p15) | 5 | P08, P03 | не назначен | pending |
| [P16 — Создать единую панель проекта и вкладку Capabilities](#p16) | 5 | P15, P10 | не назначен | pending |
| [P17 — Добавить native MCP add/remove/check](#p17) | 5 | P15, P16 | не назначен | pending |
| [P18 — Добавить native действия плагинов](#p18) | 5 | P17 | не назначен | pending |
| [P19 — Добавить передачу скилла второму CLI](#p19) | 5 | P18 | не назначен | pending |
| [P20 — Реализовать shared/local state и домен бэклога](#p20) | 6 | P16 | не назначен | pending |
| [P21 — Подключить бэклог к MCP, host и панели](#p21) | 6 | P20 | не назначен | pending |
| [P22 — Реализовать режимы, планы, ревизии и снимки](#p22) | 7 | P20, P12 | не назначен | pending |
| [P23 — Подключить инструменты планов и будильник](#p23) | 7 | P22 | не назначен | pending |
| [P24 — Показать план и итог в комнате](#p24) | 7 | P23, P21 | не назначен | pending |
| [P25 — Реализовать рецепты и плейбук ведущего](#p25) | 8 | P12, P24 | не назначен | pending |
| [P26 — Подключить рецепты к диалогу и Save as recipe](#p26) | 8 | P25 | не назначен | pending |
| [P27 — Реализовать журнал принятых версий и историю](#p27) | 9 | P23, P20 | не назначен | pending |
| [P28 — Подключить Decisions и Share history](#p28) | 9 | P27, P16 | не назначен | pending |
| [P29 — Реализовать память проекта и её слой](#p29) | 10 | P20, P09 | не назначен | pending |
| [P30 — Реализовать search_history по записям проекта](#p30) | 10 | P27, P29, P22 | не назначен | pending |
| [P31 — Подключить память, поиск и UI](#p31) | 10 | P30, P28 | не назначен | pending |
| [P32 — Провести сквозную проверку и сравнение навигатора](#p32) | 11 | P14, P17, P18, P19, P24, P26, P31 | не назначен | pending |
| [P33 — Обновить документацию по фактическому результату](#p33) | 11 | P32 | не назначен | pending |

## Карточки

<a id="p00"></a>

### P00: Подготовить актуальную рабочую базу

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p00_prepare_base, gpt-6.1-sol/high; профиль `git-master`. **Проверяющий:** /root/p00_review, gpt-6.1-sol/high.

**Зависимости:** нет. **Источник:** [этап 0 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-0).

**Владение файлами** (общие файлы — после выдачи права записи):

- `docs/research/2026-10-03-parley-integration-spike.md`

**Работа:** Сверить master, docs/parley-md, merge-base и незакоммиченные изменения; подготовить изолированную базу реализации с актуальным chat-view и всей согласованной документацией. Записать checkout, branch и точный базовый SHA. Сохранить чужие изменения; не заменять новый код старой копией из docs/parley-md.

**Приёмка:** Документация доступна на рабочей базе; сканер и capabilities.list актуального master сохранены. Определены исходный SHA, рабочая ветка и состояние до начала кода.

**Проверки:**

- `git status --short`
- `git log -1 --oneline`
- `git diff --check`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** коммит `9aedc3e`; seed `1acc937` от master `72a8736`. Независимый вердикт: accepted, замечаний нет. Исходные checkout сохранены; девять документов совпадают с seed; код, manifests и lockfile совпадают с master. `pnpm install --frozen-lockfile`, сборка `@parley/host...` и стартовые проверки core: 5 файлов, 132 теста passed. Подробности — в [журнале](2026-10-03-parley-execution.md).

<a id="p01"></a>

### P01: Проверить Claude: источники, budget, jev и инструменты

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p01_claude_probe, gpt-6.1-sol/high; профиль `researcher`. **Проверяющий:** /root/p01_review, gpt-6.1-sol/high.

**Зависимости:** P00. **Источник:** [этап 0 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-0).

**Владение файлами** (общие файлы — после выдачи права записи):

- `docs/research/2026-10-03-parley-cli/claude.md`

**Работа:** В тестовом проекте проверить источники и приоритеты скиллов, commands, плагины/synced, скрытия; budget в settings/env; выключение jev только в сессии; Skill/find_skill главной нативной роли и субагента. Записать версии, argv и обезличенные transcript-свидетельства. Проверить сохранность хуков Parley и statusLine.

**Приёмка:** Для каждого механизма есть подтверждение либо явный запасной путь. Нет изменения глобального settings или файлов jev; родной список сопоставлен с каталогом.

**Проверки:**

- Ручная сверка skill_listing.names и наблюдаемого списка инструментов.
- Проверка конца хода, report, statusLine и пробуждения на тестовой сессии.

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** `09eda36`; /root/p01_review — accepted, замечаний нет. Версия/schema, captured payload, loader/role/MCP fixture, jev/hooks и AST трёх scripts проверены независимо. Synthetic transport не считается release acceptance; production full-list fallback до P32 gates. [Evidence](../research/2026-10-03-parley-cli/claude.md).

<a id="p02"></a>

### P02: Проверить Codex: скиллы, слой, роли и resume

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p02_codex_probe, gpt-6.1-sol/high; профиль `researcher`. **Проверяющий:** /root/p00_review (новая задача P02), gpt-6.1-sol/high.

**Зависимости:** P00. **Источник:** [этап 0 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-0).

**Владение файлами** (общие файлы — после выдачи права записи):

- `docs/research/2026-10-03-parley-cli/codex.md`

**Работа:** Проверить пользовательские/проектные корни, плагины, приоритеты и policy; влияние skills.config и возможность чтения выключенного только Parley SKILL.md. Проверить developer_instructions, CLAUDE.md fallback, роль и sandbox при launch/resume. Ошибочные overrides проверять в временном конфиге.

**Приёмка:** Подтверждены формы argv и реальные ограничения либо записан запасной режим. Человеческие выключения сохраняются; MCP/report работают; глобальный config.toml не менялся.

**Проверки:**

- codex debug prompt-input с временным проектом и проверяемыми argv.
- Живые launch/resume в тестовом проекте; сравнение ожидаемого и полученного.

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** `ce3efc1`; /root/p00_review — accepted, замечаний нет. Независимо повторены 11 offline CLI probes, argv UTF-8/JSON, macOS границы и сверка pinned source. Native live JSONL показывает failed turn, не приёмку launch/resume/MCP. До P32 — полный native list. [Evidence](../research/2026-10-03-parley-cli/codex.md).

<a id="p03"></a>

### P03: Проверить команды Capabilities и scopes

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p03_capabilities_probe, gpt-6.1-sol/high; профиль `researcher`. **Проверяющий:** /root/p03_review, gpt-6.1-sol/high.

**Зависимости:** P00. **Источник:** [этап 0 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-0).

**Владение файлами** (общие файлы — после выдачи права записи):

- `docs/research/2026-10-03-parley-cli/capabilities.md`

**Работа:** Зафиксировать фактические формы Claude/Codex list/available/details/check, команды MCP и плагинов, scopes и видимость local MCP из worktree. Для действий использовать только изолированные тестовые конфиги. Сырые значения секретов не включать в evidence.

**Приёмка:** Для каждого действия v1 есть argv, fixture результата, ограничения и путь восстановления. Неподдержанный путь помечен недоступным, не угадан.

**Проверки:**

- Сверка JSON/text fixtures с реальными CLI и versions.
- Проверка обезличивания evidence и отсутствия реальных секретов.

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** `5debed1`; /root/p03_review — accepted, замечаний нет. Независимо сверены CLI help/версии, JSON fixtures, canonical main local MCP и безопасные Codex add/list/get/remove без запуска сервера. Remote/OAuth/managed policy и native Parley остаются P32 gates. [Evidence](../research/2026-10-03-parley-cli/capabilities.md).

<a id="p04"></a>

### P04: Закрыть контракты разведки и выбор парсеров

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p00_prepare_base (новое назначение P04), gpt-6.1-sol/high; профиль `architect`. **Проверяющий:** /root/p01_review (новое назначение P04), gpt-6.1-sol/high.

**Зависимости:** P01, P02, P03. **Источник:** [этап 0 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-0).

**Владение файлами** (общие файлы — после выдачи права записи):

- `docs/research/2026-10-03-parley-cli/contracts.md`
- `docs/research/2026-10-03-parley-integration-spike.md`

**Работа:** Свести разведку: NativeSkill, приоритеты источников, доступность модели, fallback и версии парсеров YAML/TOML с лицензиями/API. Проверить общий argv/env и 96 КиБ после экранирования на доступных целевых ОС; недоступную платформу явно отметить. Изменения спек предложить ведущему для интеграции.

**Приёмка:** Контракт пригоден обоим провайдерам; неподтверждённые флаги не разрешены к включению. Версии зависимостей обоснованы; общий предел argv имеет evidence или явное ограничение проверки.

**Проверки:**

- Проверка таблицы этапа 0 единого плана: у каждой строки evidence/fallback.
- Ревью контрактов отдельно от автора разведки.

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** `8a71358` + fix `e4e61cc`; /root/p01_review — accepted после исправления двух Important и одного Minor finding. Pins/API independently checked на Node20; P00 prefix preserved; scripts durable. [Принятые контракты](../research/2026-10-03-parley-cli/contracts.md) уточняют устаревшие native CLI примеры спек. Перенос этих уточнений в спеки назначен отдельному агенту под контролем root.

<a id="p05"></a>

### P05: Реализовать общие типы и YAML/TOML-разборщики

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p01_claude_probe (новое назначение P05), gpt-6.1-sol/high; профиль `worker`. **Проверяющий:** /root/p00_review (новое назначение P05), gpt-6.1-sol/high.

**Зависимости:** P04. **Источник:** [этап 1 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-1).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/skills/types.ts`
- `packages/core/src/skills/frontmatter.ts`
- `packages/core/src/skills/frontmatter.test.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`

**Уточняющий источник:** [принятый P04 контракт](../research/2026-10-03-parley-cli/contracts.md).

**Работа:** Ввести утверждённый внутренний контракт и общие полноценные парсеры. Поддержать многострочные descriptions, кавычки, disable-model-invocation и Codex policy/config. Зависимости добавить в версиях из P04. Тела SKILL.md не включать в метаданные; соблюдать предел 64 КиБ.

**Приёмка:** Полное описание переживает разбор; битые/слишком большие файлы не роняют каталог. Один YAML/TOML-путь переиспользуется ролями, рецептами и настройками скиллов.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/skills/frontmatter.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** `5e95a38` + FIFO fix `eb24192`; /root/p00_review — accepted после исправления Important. Целевые tests независимо повторены: 31/31 passed, включая реальный POSIX FIFO всех трёх reader; Windows test skipped. ESLint/isolated tsc passed; последующий общий core build с P09 также passed.

<a id="p06"></a>

### P06: Реализовать источники скиллов Claude

- [ ] Принято ведущим после независимой проверки.

**Статус:** review. **Исполнитель:** /root/p01_claude_probe (новое назначение P06), gpt-6.1-sol/high; профиль `worker`. **Проверяющий:** /root/p01_review (последовательно после P07), gpt-6.1-sol/high.

**Зависимости:** P05. **Источник:** [этап 1 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-1).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/skills/claude.ts`
- `packages/core/src/skills/claude.test.ts`

**Работа:** Собрать подтверждённые пользовательские, проектные, plugin/synced и command-источники в контексте cwd. Применить эффективные уровни включения и скрытия. Зафиксировать коллизии, симлинки, циклы, unreadable и приоритеты временными папками.

**Приёмка:** Фикстуры воспроизводят нативный каталог и причины недоступности; worktree использует свои проектные источники, а не папку ведущего.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/skills/claude.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence перед ревью:** 32/32 targeted fixtures passed; scoped ESLint и isolated strict tsc passed; owned diff только claude.ts/test. Native evidence cwd-bound, unknown state unavailable, bodies не возвращаются. Независимый reviewer: /root/p01_review после P07 (лимит platform threads).

<a id="p07"></a>

### P07: Реализовать источники скиллов Codex

- [ ] Принято ведущим после независимой проверки.

**Статус:** running (review needs rework). **Исполнитель:** /root/p03_capabilities_probe (исходный P07); fixes — /root/p02_codex_probe, gpt-6.1-sol/high; профиль `worker`. **Проверяющий:** /root/p01_review (новое назначение P07), gpt-6.1-sol/high.

**Зависимости:** P05. **Источник:** [этап 1 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-1).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/skills/codex.ts`
- `packages/core/src/skills/codex.test.ts`

**Работа:** Реализовать подтверждённые корни и обход до корня репозитория, пределы глубины/каталогов, policy и человеческие skills.config всех эффективных уровней. Технические overrides Parley применять позднее, не читать их как человеческое выключение.

**Приёмка:** Коллизии разрешены по CLI; policy/disabled исключают навигацию, но запись остаётся для панели. Симлинки не дают циклов и дубликатов.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/skills/codex.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence перед ревью:** 30/30 isolated fixtures passed; scoped `tsc --noEmit` passed; автор изменил только codex.ts/test. Safe unknown roots/product policy unavailable; native live checks не объявлены. Независимый reviewer: /root/p01_review.

**Замечания review:** Important — native whitespace normalization до name-selector matching (human disable теряется) и две ошибки ESLint `no-control-regex`. Fix ownership: только codex.ts/test, отдельный snapshot/recheck.

<a id="p08"></a>

### P08: Собрать каталог, BM25 и перевести chat-view на него

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P06, P07. **Источник:** [этап 1 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-1).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/skills/catalog.ts`
- `packages/core/src/skills/catalog.test.ts`
- `packages/core/src/skills/search.ts`
- `packages/core/src/skills/search.test.ts`
- `packages/core/src/capabilities/scan.ts`
- `packages/core/src/capabilities/frontmatter.ts`
- `packages/core/src/capabilities/scan.test.ts`
- `packages/core/src/capabilities/frontmatter.test.ts`
- `packages/core/src/index.ts`

**Работа:** Объединить источники, фильтр modelAvailable и детерминированный BM25 по спеке. Перевести чтение скиллов подсказок chat-view на общий resolver, сохранив capabilities.list и команды/агентов. Удалять только заменённое дублирование.

**Приёмка:** Один каталог обслуживает панель, навигатор и существующие подсказки. Скрытая запись видна в каталоге, отсутствует в поиске; порядок первых трёх и tie-break проверены.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/skills src/capabilities`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p09"></a>

### P09: Собрать слой сессии и доставку Codex

- [x] Принято ведущим после независимой проверки.

**Статус:** done. **Исполнитель:** /root/p02_codex_probe (новое назначение P09), gpt-6.1-sol/high; профиль `worker`. **Проверяющий:** /root/p03_review (новое назначение P09), gpt-6.1-sol/high.

**Зависимости:** P04. **Источник:** [этап 2 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-2).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/session-layer.ts`
- `packages/core/src/work/session-layer.test.ts`
- `packages/core/src/work/parley-md.ts`
- `packages/core/src/work/parley-md.test.ts`
- `packages/core/src/work/launch.ts`
- `packages/core/src/work/launch.test.ts`
- `packages/core/src/providers.ts`
- `packages/core/src/providers.test.ts`
- `packages/core/src/work/guidance.ts`
- `packages/core/src/work/guidance.test.ts`
- `packages/core/src/index.ts` — только export проверки аргументов/окружения
- `packages/host/src/sessions/sessions-service.ts` — окончательный env guard и доставка warning до spawn
- `packages/host/src/sessions/sessions-service.test.ts` — поведенческие проверки этих точек
- `packages/protocol/src/types.ts` — только расширение NoticeKind для доставляемых предупреждений слоя
- `packages/desktop/src/shared/strings.ts` и `strings.test.ts` — только обязательный consumer mapping новых NoticeKind и существующие проверки

**Уточняющий источник:** [принятый P04 контракт](../research/2026-10-03-parley-cli/contracts.md).

**Работа:** Добавить обработку PARLEY.md и один сборщик слоя с необязательными блоками роли/рецепта/памяти. Передать Codex developer_instructions и CLAUDE.md fallback. Сохранить тихий бриф, launch/new/resume; проверить окончательный argv после экранирования и предупреждение override-gap. Полный argv/env проверять в host после слияния inherited env и hook token, до pty.start; host обязан обработать warnings. P10 получает эти host-файлы позже, после принятия P09.

**Приёмка:** Порядок совпадает с единым планом; шаблон пуст, fenced code сохранён, UTF-8-лимиты работают. Guidance ≤14 строк; переполнение даёт session-layer-too-large до spawn.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/session-layer.test.ts src/work/parley-md.test.ts src/work/launch.test.ts src/work/guidance.test.ts src/providers.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** `c2ccbbd`; /root/p03_review — accepted, оставшихся findings нет. Core 225 / host 52 tests и builds passed; fixes: desktop typecheck, 72 strings / 11 session-layer tests passed. Reviewer независимо проверил TOML roundtrip/escaped ceiling (1 targeted), NoticeKind mapping (38 tests), oversized custom Claude до spawn и diff. Live UI/CLI/Linux acceptance остаётся P32.

<a id="p10"></a>

### P10: Подключить создание PARLEY.md и Open/Create

- [ ] Принято ведущим после независимой проверки.

**Статус:** review. **Исполнитель:** /root/p02_codex_probe (новое назначение P10), gpt-6.1-sol/high; профиль `worker`. **Проверяющий:** /root/p01_review (после source reviews), gpt-6.1-sol/high.

**Зависимости:** P09. **Источник:** [этап 2 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-2).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/parley-md.ts`
- `packages/core/src/work/parley-md.test.ts`
- `packages/host/src/sessions/sessions-service.ts`
- `packages/host/src/sessions/sessions-service.test.ts`
- `packages/desktop/src/renderer/sidebar/SectionMenu.tsx`
- `packages/desktop/src/main/ipc.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/e2e/parley-md.spec.ts`
- `packages/core/src/index.ts` — только exports ensure/create PARLEY helpers
- `packages/protocol/src/types.ts` — только NoticeKind `parley-md-created`
- `packages/desktop/src/shared/bridge.ts` — только typed PARLEY status/create IPC
- `packages/desktop/src/shared/strings.ts` и `strings.test.ts` — необходимые English labels и NoticeKind consumer
- `packages/desktop/src/renderer/App.tsx` — только созданное уведомление с Open в существующем редакторе
- `packages/desktop/src/main/ipc.test.ts` — allowlist/channel validation этих IPC
- `packages/desktop/src/renderer/test-utils/fake-bridge.ts` — обязательный app.parleyMd typed fixture consumer

**Работа:** Добавить эксклюзивное создание шаблона, receipt в stateDir и проверку перед всеми режимами запуска. Удалённый файл не возвращать автоматически; явный Create работает. Подключить меню проекта, вкладку редактора и адресные уведомления.

**Приёмка:** Create → файл → редактор; создание идемпотентно, занятый путь не повреждён, сбой не мешает старту. agentSkills не влияет на PARLEY.md.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/parley-md.test.ts`
- `pnpm --filter @parley/host exec vitest run src/sessions/sessions-service.test.ts`
- `pnpm --filter @parley/desktop e2e e2e/parley-md.spec.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence перед ревью:** 15 core PARLEY / 57 host / 149 desktop IPC+strings tests, desktop typecheck, dependency builds и scoped lint passed; 4 isolated Electron e2e passed. Один intermediate watcher timeout; isolated и full reruns passed. Portable receipt stat/read→unlink TOCTOU оставлен явным ограничением для review.

<a id="p11"></a>

### P11: Реализовать каталог ролей и умолчания

- [ ] Принято ведущим после независимой проверки.

**Статус:** running. **Исполнитель:** /root/p01_claude_probe (новое назначение P11), gpt-6.1-sol/high; профиль `worker`. **Проверяющий:** /root/p02_codex_probe (после P10), gpt-6.1-sol/high.

**Зависимости:** P05, P09. **Источник:** [этап 3 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-3).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/roles/types.ts`
- `packages/core/src/roles/builtin.ts`
- `packages/core/src/roles/catalog.ts`
- `packages/core/src/roles/claude.ts`
- `packages/core/src/roles/codex.ts`

**Работа:** Добавить восемь собственных английских ролей и чтение нативных ролей через общие парсеры. Уровни моделей брать из актуального provider-models. Реализовать приоритет явного выбора, коллизии и отсутствующий файл. Создать соответствующие .test.ts.

**Приёмка:** Stable ids уникальны, тексты ≤40 строк; native role остаётся в своём CLI; умолчания не маскируются под явный выбор человека.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/roles src/english-text.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p12"></a>

### P12: Подключить роли к запуску, MCP и диалогу

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P11, P10. **Источник:** [этап 3 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-3).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/agents.ts`
- `packages/core/src/work/types.ts`
- `packages/core/src/work/map.ts`
- `packages/core/src/work/launch.ts`
- `packages/core/src/work/session-layer.ts`
- `packages/core/src/providers.ts`
- `packages/core/src/mcp/tools.ts`
- `packages/core/src/mcp/server.test.ts`
- `packages/host/src/methods/sessions.ts`
- `packages/host/src/sessions/sessions-service.ts`
- `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx`
- `packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx`

**Работа:** Мигрировать agent → role, добавить list_roles/spawn_session(role)/get_map.role. Доставить текст и ограничения при launch/resume; отказать роли без обязательного канала/read-only. В UI добавить выбор, чип и lock; отправлять только явно изменённые model/effort. Изменения protocol/guide согласовать с ведущим.

**Приёмка:** Роль реально применяется; native Claude не дублируется в слое; ограничения не исчезают при resume. Старый agent работает, сочетание agent+role — ошибка.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/roles src/work/agents.test.ts src/work/map.test.ts src/work/launch.test.ts src/providers.test.ts src/mcp/server.test.ts`
- `pnpm --filter @parley/protocol test`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx src/renderer/components/rooms/ParticipantStrip.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p13"></a>

### P13: Реализовать find_skill и настройку MCP

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P08, P12. **Источник:** [этап 4 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-4).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/mcp/context.ts`
- `packages/core/src/mcp/server.ts`
- `packages/core/src/mcp/tools.ts`
- `packages/core/src/mcp/find-skill.test.ts`
- `packages/core/src/mcp/annotations.test.ts`
- `packages/core/src/config.ts`
- `packages/core/src/config.test.ts`

**Работа:** Добавить схему query/for/limit, READS, cached catalog и описания с родным load. Claude строить лениво, Codex — для имён при старте. for использует CLI/cwd участника той же работы; удалённый worktree возвращает пустой результат с причиной. Добавить skillNavigator=false и env.

**Приёмка:** Выключенный инструмент отсутствует; пустой query и чужая работа — ошибки; закрытая сессия читается; hidden отфильтрован; no-match не требует скилла.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/mcp/find-skill.test.ts src/mcp/annotations.test.ts src/config.test.ts src/skills`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p14"></a>

### P14: Подключить навигатор к CLI и Settings

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P13. **Источник:** [этап 4 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-4).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/mcp-config.ts`
- `packages/core/src/work/settings-file.ts`
- `packages/core/src/work/launch.ts`
- `packages/core/src/providers.ts`
- `packages/core/src/skills/navigator-launch.test.ts`
- `packages/host/src/methods/settings.ts`
- `packages/desktop/src/renderer/components/settings/SettingsDialog.tsx`
- `packages/desktop/src/renderer/components/settings/SettingsDialog.test.tsx`

**Работа:** Один snapshot skillNavigator передать argv/settings/guidance и дочернему MCP. Включённым сессиям дать отдельный settings/<id>.json, сохранить хуки/statusLine. Применять только механизмы из P04; human skills.config не терять, большие/неподдержанные overrides пропускать. Добавить переключатель и условную подсказку в guide/guidance через ведущего.

**Приёмка:** Off воспроизводит прежний старт; agentSkills=false не выключает поиск. Нет короткого списка без find_skill/пути загрузки; параллельные старты не перетирают настройки. Значение по умолчанию false.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/skills/navigator-launch.test.ts src/work/settings-file.test.ts src/work/mcp-config.test.ts src/work/launch.test.ts src/work/guidance.test.ts src/providers.test.ts`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/settings/SettingsDialog.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p15"></a>

### P15: Реализовать безопасный снимок Capabilities

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P08, P03. **Источник:** [этап 5 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-5).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/host/src/capabilities/snapshot.ts`
- `packages/host/src/capabilities/claude.ts`
- `packages/host/src/capabilities/codex.ts`
- `packages/host/src/capabilities/redact.ts`
- `packages/host/src/methods/capabilities.ts`
- `packages/host/src/methods/capabilities.test.ts`

**Работа:** Собрать независимые колонки провайдеров, installed/hidden reason, separate copies и builtin parley. Добавить get/refresh/changed с безопасными типами. skills брать из resolver; capabilities.list оставить. Protocol/registry — через ведущего. Создать тесты новых модулей и fixture-secret.

**Приёмка:** Сырой MCP config и секреты не появляются в ответах, событиях, логируемых ошибках. Частичная колонка доступна раньше другой; Refresh не обещает обновления сессии.

**Проверки:**

- `pnpm --filter @parley/host exec vitest run src/capabilities src/methods/capabilities.test.ts`
- `pnpm --filter @parley/protocol test`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p16"></a>

### P16: Создать единую панель проекта и вкладку Capabilities

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P15, P10. **Источник:** [этап 5 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-5).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/desktop/src/renderer/components/project/ProjectPanel.tsx`
- `packages/desktop/src/renderer/components/project/CapabilitiesPanel.tsx`
- `packages/desktop/src/renderer/shell/AppShell.tsx`
- `packages/desktop/src/renderer/shell/RightSidebar.tsx`
- `packages/desktop/src/renderer/sidebar/SectionMenu.tsx`
- `packages/desktop/src/renderer/palette/actions.ts`

**Работа:** Добавить один каркас панели с вкладкой Capabilities, отдельной загрузкой колонок, hidden reason, Refresh и builtin-lock. Открывать из проекта и палитры. Предусмотреть подключение последующих вкладок без второго диалога проекта. Создать .test.tsx.

**Приёмка:** Снимок отображается без секретов; доступна частичная загрузка, обновление и причина скрытия; открытие/закрытие и английские тексты корректны.

**Проверки:**

- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project src/renderer/shell/RightSidebar.test.tsx src/renderer/palette/actions.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p17"></a>

### P17: Добавить native MCP add/remove/check

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P15, P16. **Источник:** [этап 5 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-5).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/host/src/capabilities/actions.ts`
- `packages/host/src/capabilities/actions.test.ts`
- `packages/desktop/src/renderer/components/project/CapabilitiesPanel.tsx`

**Работа:** Реализовать подтверждённые argv для MCP add/remove/check, форму и вставку JSON из README. Команды выполнять execFile без shell, действия сериализовать по провайдеру. stdout/stderr публиковать только после предусмотренной очистки; обновлять снимок после действия.

**Приёмка:** Все scopes из спеки поддержаны или явно недоступны по P03. Check отдаёт состояние, add/remove работают в тестовом проекте; чувствительные значения не выходят в UI.

**Проверки:**

- `pnpm --filter @parley/host exec vitest run src/capabilities/actions.test.ts src/capabilities/redact.test.ts`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project/CapabilitiesPanel.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p18"></a>

### P18: Добавить native действия плагинов

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P17. **Источник:** [этап 5 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-5).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/host/src/capabilities/actions.ts`
- `packages/host/src/capabilities/actions.test.ts`
- `packages/desktop/src/renderer/components/project/CapabilitiesPanel.tsx`

**Работа:** Добавить available/details/install/uninstall/enable/disable/addMarketplace по evidence P03. Сохранять очередь и очистку ошибок P17; показывать состав до установки. Не создавать собственный каталог и не писать глобальные конфиги напрямую.

**Приёмка:** Все действия v1 проверены построением argv и тестовым запуском; неподдержанные источники помечены. Колонка обновляется после действия, модель сессии не обещает мгновенное обновление.

**Проверки:**

- `pnpm --filter @parley/host exec vitest run src/capabilities/actions.test.ts src/capabilities/redact.test.ts`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project/CapabilitiesPanel.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p19"></a>

### P19: Добавить передачу скилла второму CLI

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P18. **Источник:** [этап 5 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-5).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/host/src/capabilities/share-skill.ts`
- `packages/host/src/capabilities/share-skill.test.ts`
- `packages/desktop/src/renderer/components/project/CapabilitiesPanel.tsx`

**Работа:** Реализовать share/unshare относительным симлинком с receipt и защитой builtin. Занятый путь, separate copies, чужой симлинк и чужая папка не изменяются. Использовать нативные папки второго CLI; Refresh пересобирает панель.

**Приёмка:** Действие не теряет чужие данные; новая сессия второго CLI видит скилл по своим правилам. for лишь читает и не запускает передачу автоматически.

**Проверки:**

- `pnpm --filter @parley/host exec vitest run src/capabilities/share-skill.test.ts`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project/CapabilitiesPanel.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p20"></a>

### P20: Реализовать shared/local state и домен бэклога

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P16. **Источник:** [этап 6 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-6).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/state-dir.ts`
- `packages/core/src/work/state-dir.test.ts`
- `packages/core/src/work/store.ts`
- `packages/core/src/work/backlog.ts`
- `packages/core/src/work/backlog.test.ts`
- `packages/core/src/work/backlog-suggestions.ts`
- `packages/core/src/work/backlog-suggestions.test.ts`
- `packages/core/src/work/project-preferences.ts`

**Работа:** Добавить версионируемый белый список .gitignore и точный переход со старого/сгенерированного файла. Реализовать lossless Markdown, ids, taken/done, lock/mtime/retry/conflict. Добавить ask/problems/everything, локальные suggestions и dedup.

**Приёмка:** Чужой текст/корневой ignore не повреждён; runtime не попадает в git. Bug/debt записываются по умолчанию, idea ждёт; worktree использует состояние основного проекта.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/state-dir.test.ts src/work/backlog.test.ts src/work/backlog-suggestions.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p21"></a>

### P21: Подключить бэклог к MCP, host и панели

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P20. **Источник:** [этап 6 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-6).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/mcp/tools.ts`
- `packages/host/src/methods/backlog.ts`
- `packages/desktop/src/renderer/components/project/BacklogPanel.tsx`
- `packages/desktop/src/renderer/components/project/BacklogPanel.test.tsx`
- `packages/desktop/src/renderer/components/project/ProjectPanel.tsx`

**Работа:** Добавить backlog_list/suggest и UI Suggested/Add/Edit/Dismiss, правило, Open file/Take into room. Taken писать только после успешного создания комнаты. Protocol/registry/guide/guidance и ленту согласовать с ведущим.

**Приёмка:** Агент не закрывает и не редактирует существующие пункты; идея проходит человеческий приём. UI и инструменты показывают ошибки конфликта; предел guidance остаётся общим.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/backlog.test.ts src/work/backlog-suggestions.test.ts src/mcp/server.test.ts src/work/guidance.test.ts`
- `pnpm --filter @parley/protocol test`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project/BacklogPanel.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p22"></a>

### P22: Реализовать режимы, планы, ревизии и снимки

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P20, P12. **Источник:** [этап 7 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-7).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/plans.ts`
- `packages/core/src/work/plans.test.ts`
- `packages/core/src/work/plan-snapshots.ts`
- `packages/core/src/work/plan-snapshots.test.ts`
- `packages/core/src/work/types.ts`
- `packages/core/src/work/map.ts`
- `packages/core/src/work/rooms.ts`
- `packages/core/src/work/proposals.ts`

**Работа:** Добавить Free/Checklist/Verified, draft/active/completing/completed/cancelled и DAG пунктов. Проверять planId/rev, права, 30 пунктов, независимого verifier. Семантическая правка инвалидирует результат и зависимые проверки. Export accepted/completed/cancelled в обоих режимах без перезаписи версий.

**Приёмка:** Checklist закрывается по done; Verified требует проверки и Accept итога. Старый rev не мутирует карту; scope/verifier/after-change не сохраняет verified; миграция старой карты даёт Free.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/plans.test.ts src/work/plan-snapshots.test.ts src/work/map.test.ts src/work/rooms.test.ts src/work/proposals.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p23"></a>

### P23: Подключить инструменты планов и будильник

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P22. **Источник:** [этап 7 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-7).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/mcp/tools.ts`
- `packages/host/src/rooms/rooms-service.ts`
- `packages/host/src/methods/rooms.ts`
- `packages/host/src/methods/rooms.test.ts`
- `packages/host/src/wake/wake-service.ts`
- `packages/host/src/wake/wake-service.test.ts`

**Работа:** Добавить mode/plan/completion методы, права и системного отправителя parley. Доставлять ready/returned/blocked/completing и события закрытия владельца через существующий wake/autoLaunch. Дедуплицировать события по rev/item/переходу; сохранить rate limits. Protocol и guide — через ведущего.

**Приёмка:** Принятый scope, включая подсказку скилла, доставлен владельцу; дубликатов назначения нет. Возврат будит владельца, закрытый владелец блокирует пункт; лимит удерживает очередь.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/mcp/server.test.ts src/work/plans.test.ts`
- `pnpm --filter @parley/host exec vitest run src/wake/wake-service.test.ts src/methods/rooms.test.ts`
- `pnpm --filter @parley/protocol test`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p24"></a>

### P24: Показать план и итог в комнате

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P23, P21. **Источник:** [этап 7 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-7).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/desktop/src/renderer/components/rooms/PlanPanel.tsx`
- `packages/desktop/src/renderer/components/rooms/CompletionCard.tsx`
- `packages/desktop/src/renderer/components/rooms/RoomHeader.tsx`
- `packages/desktop/src/renderer/components/rooms/DecisionCard.tsx`
- `packages/desktop/src/renderer/components/rooms/feed-model.ts`
- `packages/desktop/src/renderer/sidebar/WorkSidebar.tsx`

**Работа:** Добавить режим, критерии/evidence/notes, прогресс, карточки принятия и итога, человеческие действия и подтверждение понижения/отмены. Показывать scope обычным текстом. Создать тесты новых карточек и адаптировать существующие.

**Приёмка:** UI воспроизводит Verified return/resubmit/verify/Accept, Checklist done и downgrade; устаревший rev показывает конфликт. Отдельного поля skill нет.

**Проверки:**

- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms src/renderer/sidebar/WorkSidebar.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p25"></a>

### P25: Реализовать рецепты и плейбук ведущего

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P12, P24. **Источник:** [этап 8 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-8).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/recipes/types.ts`
- `packages/core/src/recipes/builtin.ts`
- `packages/core/src/recipes/parse.ts`
- `packages/core/src/recipes/catalog.ts`
- `packages/core/src/work/types.ts`
- `packages/core/src/work/rooms.ts`
- `packages/core/src/work/session-layer.ts`
- `packages/core/src/work/state-dir.ts`
- `packages/host/src/rooms/rooms-service.ts`

**Работа:** Добавить три собственных плейбука и project recipes общим YAML-parser. Проверить строгую схему, role ids/count/lead/mode. Сохранить snapshot комнаты и доставку только lead, письмо новому lead; не хранить индекс или постоянный skill.

**Приёмка:** Рецепты валидируются, тексты ≤30 строк на английском. Без навигатора сценарий работает; изменённый файл не меняет комнату; новый lead получает исходный snapshot.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/recipes src/work/rooms.test.ts src/work/session-layer.test.ts src/work/state-dir.test.ts src/english-text.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p26"></a>

### P26: Подключить рецепты к диалогу и Save as recipe

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P25. **Источник:** [этап 8 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-8).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.tsx`
- `packages/desktop/src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx`
- `packages/desktop/src/renderer/components/rooms/RoomHeader.tsx`
- `packages/desktop/src/main/ipc.ts`
- `packages/desktop/e2e/room-recipes.spec.ts`

**Работа:** Рецепт заполняет состав/mode/lead, count разворачивается; поля дальше редактируются. Сохранить различие явного выбора и role defaults. Save as recipe пишет через main, предлагает rename/replace занятого имени и открывает редактор. Показать чип/плейбук.

**Приёмка:** Диалог запускает нужный состав и режим; неверные строки не создаются, retry повторяет только упавших. Save не перезаписывает файл без выбора человека.

**Проверки:**

- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/dialogs/NewSessionOrRoomDialog.test.tsx`
- `pnpm --filter @parley/desktop e2e e2e/room-recipes.spec.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p27"></a>

### P27: Реализовать журнал принятых версий и историю

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P23, P20. **Источник:** [этап 9 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-9).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/decision-journal.ts`
- `packages/core/src/work/decision-journal.test.ts`
- `packages/core/src/work/room-history.ts`
- `packages/core/src/work/room-history.test.ts`
- `packages/host/src/rooms/rooms-service.ts`
- `packages/host/src/works/works-service.ts`
- `packages/core/src/work/state-dir.ts`

**Работа:** Записывать accepted decision/completion по rev и ссылке на конкретный snapshot. Повтор события идемпотентен, disk-error не отменяет Accept. Собрать локальную history из карты с debounce и Share/Unshare semantics. Recipe metadata использовать при наличии, отсутствие рецептов не блокирует работу.

**Приёмка:** Две версии дают отдельные файлы; Return не идёт в принятый журнал. Удаление работы удаляет локальную историю, shared остаётся; карта — источник правды.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/decision-journal.test.ts src/work/room-history.test.ts src/work/plan-snapshots.test.ts`
- `pnpm --filter @parley/host exec vitest run src/methods/rooms.test.ts src/works/works-service.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p28"></a>

### P28: Подключить Decisions и Share history

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P27, P16. **Источник:** [этап 9 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-9).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/desktop/src/renderer/components/project/DecisionsPanel.tsx`
- `packages/desktop/src/renderer/components/project/DecisionsPanel.test.tsx`
- `packages/desktop/src/renderer/components/project/ProjectPanel.tsx`
- `packages/desktop/src/renderer/components/rooms/RoomHeader.tsx`

**Работа:** Добавить вкладку решений, фильтр и открытие файла, Share/Unshare меню с явным подтверждением публикации snapshot в git. Показывать shared at и ошибку экспорта. Host/protocol-методы запрашивать у ведущего.

**Приёмка:** Клик открывает конкретный принятый rev; Share требует выбора человека; Unshare не обещает удаления истории git. Новые вкладки используют существующую панель.

**Проверки:**

- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project/DecisionsPanel.test.tsx src/renderer/components/rooms/RoomPanel.test.tsx`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p29"></a>

### P29: Реализовать память проекта и её слой

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P20, P09. **Источник:** [этап 10 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-10).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/project-memory.ts`
- `packages/core/src/work/project-memory.test.ts`
- `packages/core/src/work/memory-suggestions.ts`
- `packages/core/src/work/memory-suggestions.test.ts`
- `packages/core/src/work/session-layer.ts`
- `packages/core/src/work/state-dir.ts`

**Работа:** Добавить lossless memory.md, ids/dedup/lock/conflicts, suggested/onHumanRequest и Undo. Вставить последним блок только фактов с id, без details, до 12 КиБ. Индексы, тела SKILL.md и настройки машины не копировать в память.

**Приёмка:** Обычный remember ждёт человека, прямой запрос отражён отдельной пометкой. Память общая из основного проекта; ограничения слоя и отсутствие деталей проверены.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/project-memory.test.ts src/work/memory-suggestions.test.ts src/work/session-layer.test.ts src/work/state-dir.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p30"></a>

### P30: Реализовать search_history по записям проекта

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P27, P29, P22. **Источник:** [этап 10 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-10).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/work/history-search.ts`
- `packages/core/src/work/history-search.test.ts`

**Работа:** Искать по decisions/memory/plans/backlog/history/sessions/all без постоянного индекса. Все слова — в одной записи; rank по первой строке/новизне, snippets, даты, file/line/id и limit 1–30. В нативные скиллы и личную память CLI не ходить.

**Приёмка:** Находит решение, урок, пункт и итог; порядок и excerpts детерминированы. Дубликат shared/local history обработан по согласованному правилу; лимиты и пустой результат проверены.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/work/history-search.test.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p31"></a>

### P31: Подключить память, поиск и UI

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `worker`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P30, P28. **Источник:** [этап 10 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-10).

**Владение файлами** (общие файлы — после выдачи права записи):

- `packages/core/src/mcp/tools.ts`
- `packages/host/src/methods/memory.ts`
- `packages/host/src/methods/history.ts`
- `packages/desktop/src/renderer/components/project/MemoryPanel.tsx`
- `packages/desktop/src/renderer/components/project/ProjectSearch.tsx`
- `packages/desktop/src/renderer/components/project/ProjectPanel.tsx`

**Работа:** Добавить remember/memory_read/search_history, Memory/Suggested/Edit/Add/Dismiss/Undo и поиск с открытием файла на строке, комнаты или сессии. Protocol/registry/guide/guidance интегрирует ведущий; сохранить ≤14 строк в комбинации всех функций.

**Приёмка:** Предложенный урок принимается и виден новой сессии; Undo работает. Search не читает каталог скиллов. Память и журнал не требуют включённого навигатора.

**Проверки:**

- `pnpm --filter @parley/core exec vitest run src/mcp/server.test.ts src/work/guidance.test.ts src/work/project-memory.test.ts src/work/history-search.test.ts`
- `pnpm --filter @parley/protocol test`
- `pnpm --filter @parley/desktop exec vitest run src/renderer/components/project`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p32"></a>

### P32: Провести сквозную проверку и сравнение навигатора

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `test-engineer`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P14, P17, P18, P19, P24, P26, P31. **Источник:** [этап 11 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-11).

**Владение файлами** (общие файлы — после выдачи права записи):

- `docs/research/2026-10-03-parley-integration-spike.md`
- `packages/desktop/e2e/parley-integration.spec.ts`

**Работа:** Пройти матрицу единого плана: off/on, agentSkills, quiet, resume, worktree, provider overrides, restricted roles, plan rev, конфликты/ошибки диска и отсутствие утечек. Подготовить около 15 промптов; получить человеческую разметку и сравнить Claude/Codex с навигатором и без. Непроверенную платформу/живой сценарий явно оставить незакрытым.

**Приёмка:** Целевые и итоговые проверки пройдены, evidence сохранено. Выбор скилла/«не нужен» не хуже родного списка; короткий режим подтверждён контрольным transcript, хуки живы. Default false не меняется автоматически.

**Проверки:**

- `pnpm test`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm --filter @parley/desktop e2e e2e/parley-integration.spec.ts`

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.

<a id="p33"></a>

### P33: Обновить документацию по фактическому результату

- [ ] Принято ведущим после независимой проверки.

**Статус:** pending. **Исполнитель:** не назначен; профиль `writer`. **Проверяющий:** другой агент, профиль `code-reviewer`.

**Зависимости:** P32. **Источник:** [этап 11 единого плана](2026-10-03-parley-unified-implementation-plan.md#step-11).

**Владение файлами** (общие файлы — после выдачи права записи):

- `README.md`
- `CHANGELOG.md`
- `TODOS.md`
- `docs/plans/2026-10-03-parley-unified-implementation-plan.md`
- `docs/specs/2026-10-02-parley-md-design.md`
- `docs/specs/2026-10-02-agent-roles-design.md`
- `docs/specs/2026-10-02-plans-backlog-design.md`
- `docs/specs/2026-10-02-room-recipes-design.md`
- `docs/specs/2026-10-03-memory-journal-design.md`
- `docs/specs/2026-10-03-skill-navigator-design.md`
- `docs/specs/2026-10-02-capabilities-design.md`

**Работа:** Описать реализованные функции и ограничения: cwd/projectPath, defaults, resume/Refresh, роли/read-only, placeholders, лимиты, ошибки и рекомендации jev restore. Записать результаты живых проверок в спеки; закрыть только действительно выполненные пункты.

**Приёмка:** Документация соответствует диффу и evidence, README/окно/тексты агентам на английском, specs/TODOS на русском. Не объявлены непроверенные этапы, включение по умолчанию или внешний выпуск.

**Проверки:**

- `git diff --check`
- Проверка локальных ссылок и соответствия README фактическим настройкам/argv.

**Передача агенту:** используй шаблон выше с этим ID, выданным checkout/SHA и правами на общие файлы.

**Evidence после выполнения:** diff/SHA, фактические проверки и вердикт проверяющего — заполняет ведущий.
