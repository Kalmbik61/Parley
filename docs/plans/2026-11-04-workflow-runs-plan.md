# Запуски Workflow в Parley — план

**Спека:** `docs/specs/2026-11-04-workflow-runs-design.md`. **Ветка:** `parley/w-0054/s-255`.

## Общие правила для исполнителя

- Одна задача за раз, только свои файлы. Соседний код не трогаешь.
- Тесты запускаешь только для своих файлов: `pnpm vitest run <file>`. Весь набор не запускаешь. Перед тяжёлой
  командой проверь `uptime`: если нагрузка за 1 минуту ≥ 10, подожди.
- Фикстуры синтетические: пиши jsonl и json прямо в тесте во временный каталог (`mkdtemp`), как в
  `log-index.test.ts`. Живые логи из `~/.claude` не читаешь и не копируешь.
- Комментарии в коде на русском, как вокруг. Коммиты делает лид.
- В конце прогоняешь `pnpm --filter <пакет> typecheck` для затронутых пакетов.

## Задача 1. Core: чтение запусков

**Файлы:** `packages/core/src/workflow.ts`, `packages/core/src/workflow.test.ts`, `packages/core/src/session-index.ts`
(+ индексатор, если накопитель подключается там), `packages/core/src/index.ts`.

**Что сделать.**
- Накопитель строк запуска и конца (спека 4.1.1) кладёт результат в `SessionIndex.workflowLaunches`. Он должен
  переживать дочитывание хвоста так же, как `planCollector`.
- `readWorkflowRuns(sessionFile, launches, { live, cache })` (спека 4.1.2–4.1.4). Возвращает `WorkflowRun[]` в форме
  протокола, но типы пока свои в core. `WorkflowInfo` и `readSessionWorkflows` остаются совместимыми для CLI.
- Разбор терпит `workflowProgress` и `phases` и строкой, и массивом, а также отсутствие любого поля.

**Приёмка.**
1. Тест: запуск с дескриптором `completed` даёт имя, статус, фазы, агентов с метками, состояниями и
   длительностями, `startedAt`/`endedAt` и превью итога.
2. Тест: запуск без дескриптора, с журналом (`launched`, два `started`, один `result`, один `failed`) и строкой запуска
   в транскрипте даёт `running` при `live: true`. Имя берётся из строки запуска, у агентов состояния `done`, `failed`
   и `running`.
3. Тест: то же при `live: false` даёт `interrupted`, а незаконченные агенты — `stopped`. Если же есть
   `<task-notification>` со `stopped`, статус запуска — `stopped`.
4. Тест: дескриптор `killed` с `error` и агентом `progress` даёт статус `killed`, `error` и агента `stopped`.
5. Тест: второй вызов с тем же кэшем не перечитывает неизменённый дескриптор (проверка через подменённый читатель или
   счётчик).
6. Тест: строка запуска и строка конца, пришедшие в двух дочитываниях хвоста, сводятся в одну запись.
7. Существующие `workflow.test.ts` и `session-tree.test.ts` проходят.

## Задача 2. Протокол и хост

**Файлы:** `packages/protocol/src/types.ts`, `packages/protocol/src/methods.ts` (+ `index.ts`),
`packages/core/src/discover.ts`, `packages/host/src/activity/log-index.ts`,
`packages/host/src/activity/activity-service.ts`, `packages/host/src/methods/index.ts` и их тесты.

**Что сделать.** Сделать то, что описано в спеке 4.2 и 4.3:
- типы `WorkflowRunSummary`, `WorkflowRun`;
- поле `LiveMetrics.workflows` (не больше 20 запусков и `total`);
- метод `session.workflowRun`;
- `sessionFileForPath` для `<sid>/workflows/wf_*.json`;
- `logIndex.workflows(session)` со сводкой;
- заполнение поля в `metricsFor`.

Живость берётся из `session.lifecycle === 'active'` и процесса. Для Codex поле всегда `null`.

**Приёмка.**
1. Тест `discover`: путь `<project>/<sid>/workflows/wf_x.json` даёт `<project>/<sid>.jsonl`; путь
   `<project>/<sid>/workflows/scripts/a.js` даёт `null`.
2. Тест `log-index`: появление журнала, а затем дескриптора во временном корне вызывает `onChange`, который задевает
   сессию. Сводка меняется с `running` на `completed`.
3. Тест `activity-service`: в `activity.changed` приходят `metrics.workflows.runs[0]` с нужным статусом и `total`. При
   25 запусках в `runs` 20, а `total` = 25.
4. Тест метода: `session.workflowRun` отдаёт агентов запуска. Для чужого `runId` отдаёт `null`. Путей к файлам в
   ответе нет.
5. Typecheck protocol, core и host чистый.

## Задача 3. Окно: вкладка Agents

**Файлы:** `packages/desktop/src/renderer/agents/AgentsPanel.tsx`, новый `agents/WorkflowSection.tsx` и тест к нему,
`packages/desktop/src/shared/strings.ts`, клиент метода (рядом с вызовом `feed.snapshot` в `chat/transcript.ts`
или в общем клиенте хоста).

**Что сделать.** Раздел «Workflow» по спеке 4.4, только чтение. Строки на английском в `strings.ts`, как у соседей.

**Приёмка.**
1. Тест компонента: две сводки дают две строки с именем, чипом статуса, фазой и `done/total`.
2. Тест: при раскрытии строки вызывается `session.workflowRun`, и в раскрытом запуске видны метки агентов,
   состояния и превью итога. Когда сводка меняется (`done` растёт), запрос повторяется.
3. Тест: при `total > runs.length` показано «ещё N». Если поля нет или оно `null`, раздела нет.
4. Ручная проверка лида в живом Parley: Workflow, запущенный из сессии, виден на вкладке Agents во время работы и
   после конца.

## Задача 4. Окно: значок в сайдбаре и в комнате

**Файлы:** `packages/desktop/src/renderer/sidebar/SessionRow.tsx`,
`packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx` (+ модель участника, откуда берётся `agents`),
новый маленький компонент значка и тесты.

**Что сделать.** Значок «workflow · фаза · done/total», пока хотя бы один запуск `running`. Клик открывает вкладку
Agents этой сессии (`openAgentsPanel`).

**Приёмка.**
1. Тест: при `running` значок виден с фазой и счётчиком. При `completed` или без поля значка нет.
2. Тест: клик зовёт открытие вкладки Agents для этой сессии.
3. Существующие тесты `SessionRow` и `ParticipantStrip` проходят.

## Задача 5. Транскрипт агента Workflow

**Файлы:** `packages/host/src/feed/feed-service.ts` (`agentSnapshot`), `packages/host/src/activity/subagent-meta.ts` и
их тесты, `agents/WorkflowSection.tsx` (клик по агенту).

**Что сделать.** Сделать то, что описано в спеке 4.5. В окне клик по агенту открывает его транскрипт тем же путём, что
у карточки агента (`chat/open-agent.ts` / `chat/transcript.ts`).

**Приёмка.**
1. Тест `feed-service`: `feed.snapshot` с `agentId` агента из `subagents/workflows/wf_x/` отдаёт его элементы.
   Прямой путь по-прежнему находится первым.
2. Тест: ссылка `subagents/workflows/wf_evil -> /tmp` и каталог без префикса `wf_` не читаются. Отдаётся `not_found`.
3. Тест `subagent-meta`: `meta.json` агента Workflow находится. Проверка корней по-прежнему работает.
4. Тест компонента: клик по агенту зовёт открытие транскрипта с его `agentId`.
