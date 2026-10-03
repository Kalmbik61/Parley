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
- Текущая фаза: P00 принят; P00–P03 accepted; P04 running, закрытие контрактов.
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
| P04 | Закрыть контракты разведки и выбор парсеров | running | /root/p00_prepare_base reassigned P04; gpt-6.1-sol/high |
| P05 | Реализовать общие типы и YAML/TOML-разборщики | pending | — |
| P06 | Реализовать источники скиллов Claude | pending | — |
| P07 | Реализовать источники скиллов Codex | pending | — |
| P08 | Собрать каталог, BM25 и перевести chat-view на него | pending | — |
| P09 | Собрать слой сессии и доставку Codex | pending | — |
| P10 | Подключить создание PARLEY.md и Open/Create | pending | — |
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
