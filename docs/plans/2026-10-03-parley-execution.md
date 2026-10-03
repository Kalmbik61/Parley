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
- Текущая фаза: P00 принят; P01–P03 running, независимые проверки CLI.
- Установка зависимостей: `pnpm install --frozen-lockfile`, exit 0; lockfile сохранён.
- Базовая сборка: `pnpm --filter '@parley/host...' build`, exit 0 (core, protocol, host).
- Базовые проверки: `pnpm --filter @parley/core exec vitest run src/capabilities src/work/launch.test.ts src/work/guidance.test.ts` — 5 файлов, 132 теста passed.
- P00: независимая проверка /root/p00_review приняла коммит `9aedc3e`, замечаний нет; сохранность исходных checkout и snapshot подтверждена повторно.

| ID | Задача | Статус | Evidence |
|---|---|---|---|
| P00 | Подготовить актуальную рабочую базу | done | agent /root/p00_prepare_base; model gpt-6.1-sol/high; commit 9aedc3e; review accepted by /root/p00_review |
| P01 | Проверить Claude: источники, budget, jev и инструменты | running | agent /root/p01_claude_probe; gpt-6.1-sol/high; base 9aedc3e |
| P02 | Проверить Codex: скиллы, слой, роли и resume | running | agent /root/p02_codex_probe; gpt-6.1-sol/high; base 9aedc3e |
| P03 | Проверить команды Capabilities и scopes | running | agent /root/p03_capabilities_probe; gpt-6.1-sol/high; base 9aedc3e |
| P04 | Закрыть контракты разведки и выбор парсеров | pending | — |
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
