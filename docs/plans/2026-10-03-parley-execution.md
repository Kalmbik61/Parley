# Parley — журнал выполнения workflow

Дата запуска: 2026-10-03.

- Workflow: superpowers:subagent-driven-development, встроенные агенты Codex App.
- Исполнители и независимые проверяющие: gpt-6.1-sol, reasoning_effort=high.
- Worktree: /Users/kalmbik61/.codex/worktrees/parley-upgrade/my_harnas.
- Ветка: codex/parley-upgrade.
- Исходная кодовая база: master, 72a87361d8073c011e60f31e5d254f1045ff086b.
- Документация: snapshot из worktree docs/parley-md; исходные файлы не изменялись.
- План: [единый план](2026-10-03-parley-unified-implementation-plan.md).
- Задачи: [очередь агентов](2026-10-03-parley-agent-tasks.md).
- Переход к зависимой задаче — после независимого ревью и проверки результата.
- Документационный стартовый коммит: 1acc937.
- Текущая фаза: P00–P05 и P09 accepted; P06/P07 переданы на независимое review; P10 выполняется.
- Установка зависимостей: `pnpm install --frozen-lockfile`, exit 0; lockfile сохранён.
- Базовая сборка: `pnpm --filter '@parley/host...' build`, exit 0 (core, protocol, host).
- Базовые проверки: `pnpm --filter @parley/core exec vitest run src/capabilities src/work/launch.test.ts src/work/guidance.test.ts` — 5 файлов, 132 теста passed.
- P00: независимая проверка /root/p00_review приняла коммит `9aedc3e`, замечаний нет; сохранность исходных checkout и snapshot подтверждена повторно.

| ID | Задача | Статус | Evidence |
|---|---|---|---|
| P00 | Подготовить актуальную рабочую базу | done | agent /root/p00_prepare_base; model gpt-6.1-sol/high; commit 9aedc3e; review accepted by /root/p00_review |
| P01 | Проверить Claude: источники, budget, jev и инструменты | done | agent /root/p01_claude_probe; gpt-6.1-sol/high; commit 09eda36; review accepted by /root/p01_review; native full-list fallback |
| P02 | Проверить Codex: скиллы, слой, роли и resume | done | agent /root/p02_codex_probe; gpt-6.1-sol/high; commit ce3efc1; review accepted by /root/p00_review; native live gates remain |
| P03 | Проверить команды Capabilities и scopes | done | agent /root/p03_capabilities_probe; gpt-6.1-sol/high; commit 5debed1; review accepted by /root/p03_review; unsupported actions unavailable |
| P04 | Закрыть контракты разведки и выбор парсеров | done | /root/p00_prepare_base reassigned P04; gpt-6.1-sol/high; commits 8a71358/e4e61cc; reviewer /root/p01_review accepted |
| P05 | Реализовать общие типы и YAML/TOML-разборщики | done | /root/p01_claude_probe reassigned P05; gpt-6.1-sol/high; commits 5e95a38/eb24192; reviewer /root/p00_review accepted; 31 tests passed |
| P06 | Реализовать источники скиллов Claude | review | 32 fixtures / scoped ESLint / strict tsc passed; reviewer /root/p00_review |
| P07 | Реализовать источники скиллов Codex | review | 30 fixtures / scoped tsc passed; reviewer /root/p01_review |
| P08 | Собрать каталог, BM25 и перевести chat-view на него | pending | — |
| P09 | Собрать слой сессии и доставку Codex | done | c2ccbbd; reviewer /root/p03_review accepted; 225 core / 52 host, builds; targeted DEL/consumer fixes passed |
| P10 | Подключить создание PARLEY.md и Open/Create | running | /root/p02_codex_probe; gpt-6.1-sol/high; base c2ccbbd; reviewer /root/p03_review |
| P11 | Реализовать каталог ролей и умолчания | pending | — |
| P12 | Подключить роли к запуску, MCP и диалогу | pending | — |
| P13 | Реализовать find_skill и настройку MCP | pending | — |
| P14 | Подключить навигатор к CLI и Settings | pending | — |
| P15 | Реализовать безопасный снимок Capabilities | pending | — |
| P16 | Создать единую панель проекта и вкладку Capabilities | pending | — |
| P17 | Добавить native MCP add/remove/check | pending | — |
| P18 | Добавить native действия плагинов | pending | — |
| P19 | Добавить передачу скилла второму CLI | pending | — |
| P20 | Реализовать shared/local state и домен бэклога | pending | — |
| P21 | Подключить бэклог к MCP, host и панели | pending | — |
| P22 | Реализовать режимы, планы, ревизии и снимки | pending | — |
| P23 | Подключить инструменты планов и будильник | pending | — |
| P24 | Показать план и итог в комнате | pending | — |
| P25 | Реализовать рецепты и плейбук ведущего | pending | — |
| P26 | Подключить рецепты к диалогу и Save as recipe | pending | — |
| P27 | Реализовать журнал принятых версий и историю | pending | — |
| P28 | Подключить Decisions и Share history | pending | — |
| P29 | Реализовать память проекта и её слой | pending | — |
| P30 | Реализовать search_history по записям проекта | pending | — |
| P31 | Подключить память, поиск и UI | pending | — |
| P32 | Провести сквозную проверку и сравнение навигатора | pending | — |
| P33 | Обновить документацию по фактическому результату | pending | — |

## Текущая разведка — ещё до независимой приёмки

- P01: Claude 2.1.287; settings schema отклоняет `skillListingBudgetFraction: 0`; env budget=1 требует проверки. До подтверждения — полный нативный список.
- P02: Codex 0.156.1; `debug prompt-input` подтверждает `developer_instructions`, CLAUDE fallback и read-only; `--no-daemon` принят текущим CLI. Нативные дубликаты имён скиллов сохраняются. Это не evidence живого launch/resume/MCP.
- P03: Claude plugin details только для установленного/plugin-dir, text output; Codex plugin add/remove и list, без enable/disable/update/details. Codex MCP list не health-check. Local MCP Claude привязан к canonical main checkout и виден в worktree.
- Итоговые доказательства и запасные пути будут приняты отдельным review P01–P03, затем закреплены в P04. Неподтверждённые флаги не разрешены для реализации.

## Назначение агентов после первой волны

Лимит созданных agent threads достигнут при запросе reviewer P02. Свободные агенты той же модели переиспользуются с новым bounded назначением; автор результата и независимый reviewer остаются разными. Не создаём другую модель или фоновые runtime-состояния. P01 принят review без замечаний; оставшиеся native release gates сохраняются.

## Подготовка следующей волны (код ещё не изменён)

- Read-only P05: общий YAML/TOML mapping parser, whole-file SKILL.md 65 536-byte limit, boolean availability с явной reason; старый capabilities parser мигрирует в P08.
- Read-only P09: один layer builder для systemPrompt/developerInstructions/quiet; окончательный env известен только в host. Для complete guard выданы P09 host sessions-service.ts/test и единственный необходимый core export; P10 получает их последовательно.
- P04 проверяет pins `yaml 2.9.1` / `smol-toml 1.9.0`; выбор вступает в силу после независимого review.

## Незакрытые release gates (не блокируют базовую реализацию)

| Область | Фактический статус | Безопасный путь до приёмки |
|---|---|---|
| Claude listing reduction | loader/roles проверены synthetic transport; account/synced/policy и host lifecycle неполны | native full list, navigator default false |
| Codex listing reduction | offline config подтверждён; live turn failed | native full list; не добавлять временные disables/include_instructions |
| Native runtime | debug не доказывает model read, enforcement, resume, report | P32 smoke на configured supported CLI model |
| Hook lifecycle | synthetic command hooks подтверждены; statusLine/report/wake не приняты | сохранить функциональные hooks; не выключать их все |
| Linux argv/env | macOS Node probes пройдены; Linux runtime отсутствует | pre-spawn guards; Linux проверка остаётся P32 |
| Remote/managed Capabilities | изолированные local fixtures пройдены, remote/OAuth/managed unverified | unsupported actions unavailable, structured safe fields only |

P04 review: root передал на независимую проверку три расхождения формулировок: PARLEY.md marked preprocessing truncation, custom runner override-gap warning, once-per-host/project notices. До уточнения контрактов P05/P09 остаются pending.

## Начало реализации

P04 accepted после fix `e4e61cc`. P05 и P09 реализуются параллельно в непересекающихся файлах. P05 — единственный writer package/lockfile; P09 — единственный writer launch/provider/host/index. Общие builds/host tests выполняются после готовности обоих patch/dependencies; целевые тесты независимы. /root/p03_capabilities_probe переносит принятые P04 контракты в пять спек и unified plan; не пишет код или tracker.

P05: exact dependencies установлены (`yaml 2.9.1`, `smol-toml 1.9.0`), pnpm exit 0; целевые P09 tests больше не ждут install. P09 дополнительно получил только NoticeKind union в protocol/types.ts для существующего host notice канала; wire DTO/event contract сохранён, UI/e2e acceptance остаётся P10.

P05 implementation ready: bounded strict UTF-8 readers и общие full YAML/TOML parsers; 30 целевых тестов passed, ESLint/isolated tsc passed. Передано /root/p00_review; общий core build пока не является результатом P05, ожидает завершения P09 patch.

P05 code review needs rework: один Important finding — FIFO SKILL.md блокирует open до stat. Исправление общего reader и regression test назначены автору; P06/P07 не открыты.

P04 docs-integration (unified plan + пять спек) передана /root/p01_review. P09 сообщил 18 processor/guard tests passed; общий целевой core batch и host-патч ещё выполняются, задача не принята.

P05 принят повторным review после FIFO fix `eb24192`: 31/31 независимо повторены, замечаний нет. P09 core targeted batch — 5 файлов/220 tests passed; dependency build и целевые host tests запускает его автор, root не повторяет их без новой причины. P06/P07 откроются после текущей общей build-точки. P04 docs review потребовал две targeted поправки (plugin skillOverrides exception и запрет arbitrary CLI excerpts), автор исправляет.

P04 docs-integration accepted /root/p01_review после fix `1c8282d` к `081f3ea`: оба Important закрыты, 35 links/anchors корректны, whitespace clean. Unified plan и пять спек теперь содержат approved research contracts; остальные две спеки сохраняют ранее согласованные rev/state/privacy контракты.

P09 build/targeted verification: core/protocol/host builds, 225 core tests, 52 host tests, scoped lint passed. Root desktop typecheck нашёл TS2739 NoticeKind mapping; исправлены пять detail strings и существующий strings test consumer. Reviewer подтвердил DEL raw TOML ошибку: исправлено escaping + настоящий TOML roundtrip/escaped byte boundary. После fixes: desktop typecheck passed, 72 strings tests и 11 session-layer tests passed. Snapshot передан reviewer; native UI/real CLI/Linux execution не объявлены принятыми.

P09 snapshot `c2ccbbd` accepted /root/p03_review: нет оставшихся findings; независимо подтверждены TOML control roundtrip/encoded ceiling, 38 noticeText tests и oversized custom Claude pre-spawn. P06/P07/P10 запущены с базы c2ccbbd; disjoint ownership skills/claude, skills/codex и PARLEY host/desktop соответственно. P10 общий export/wire/registry получает только после явного назначения ведущим.

P10 выданы минимальные integration points: core exports, единственный NoticeKind, bridge typed IPC, English labels/mapping, App created-notice Open action и IPC allowlist tests. Host registry/wire methods не расширяются; остальные workers не пишут эти файлы.

P10 transaction clarification approved: reserve receipt before wx creation; failed initial receipt means no file, creation failure rolls back only owned reservation, failed final update retains receipt. Spec согласована; поведенческая приёмка этого пути ещё ожидает P10 tests/review. Второй marker не добавляется.

P07 готов: 30/30 fixtures и scoped tsc passed, owned diff только codex.ts/test. P06 — 32 fixtures green, final scoped checks ещё выполняются. P10 общий core/protocol/host/desktop build exit 0 на compile-ready source snapshots; fake-bridge.ts выдан только как обязательный typed consumer. Это ещё не acceptance P06/P07/P10.

P06 snapshot готов: 32/32 fixtures, scoped ESLint/strict production tsc passed. Verified source/native context API описан caller-facing; unknown availability closed. Только claude.ts/test, без shared mutations. P07 snapshot `a0c8f2c` проверяет /root/p01_review.
