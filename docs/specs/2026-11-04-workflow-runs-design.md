# Запуски Workflow в Parley — дизайн

**Дата:** 2026-11-04. **Статус:** место показа и транскрипт агента выбраны человеком 2026-11-04 (раздел 7); ждёт согласования. **База:** `feat/raise-default-limits` f7978af8.

---

## 1. Зачем

Сессия Claude Code вызывает инструмент `Workflow`, и он запускает своих субагентов. Parley этот запуск не видит:
его нет ни в сайдбаре, ни в комнате, ни на вкладке Agents. Человек узнаёт о нём только командой `/workflows` в
терминале CLI.

Цель — показать **только для чтения** запуски Workflow каждой сессии: имя, статус, текущую фазу, агентов (метка,
фаза, состояние), начало и конец, итог. Показ обновляется вживую. Управления (остановить, перезапустить) нет.

## 2. Что пишет Claude Code (проверено 2026-11-04 на 383 запусках из `~/.claude/projects`)

Все пути ниже относятся к одному транскрипту `<project>/<sid>.jsonl`.

| Где | Когда появляется | Что там есть |
|---|---|---|
| `<sid>/subagents/workflows/<runId>/journal.jsonl` | при старте запуска, дописывается по ходу | `{"type":"launched"}`; `started {key, agentId, label, phase}`; `result {key, agentId, result, toolsUsed}`; `failed {key, agentId}`. Ни времени, ни имени запуска, ни записи о его конце. |
| `<sid>/subagents/workflows/<runId>/agent-<id>.jsonl` и `.meta.json` | при старте агента | транскрипт агента; в meta есть `description` (это метка), `workflowPhase`, `model`, `agentType` |
| `<sid>/workflows/<runId>.json` (дескриптор) | **только по окончании** запуска; у двух оборванных запусков его нет | `workflowName`, `summary`, `status` (`completed` · `killed`), `startTime`, `durationMs`, `timestamp` (конец), `phases`, `result`, `error`, `agentCount`, `totalTokens`, `totalToolCalls`, `workflowProgress`. В нём же весь `script` (16–64 КБ). |
| `workflowProgress` в дескрипторе | там же | `workflow_phase {index, title}`; `workflow_agent {agentId, label, phaseIndex, phaseTitle, model, state: done·error·progress, startedAt, durationMs, tokens, toolCalls, resultPreview, error?}` |
| строка `user` в транскрипте `<sid>.jsonl` | при запуске | `toolUseResult = {status:"async_launched", taskType:"local_workflow", taskId, runId, workflowName, summary, transcriptDir, scriptPath}`, время берётся из поля `timestamp` строки |
| `<task-notification>` в транскрипте (`queue-operation` и строка `user`) | при конце запуска; у оборванного — при следующем `--resume` | `<task-id>`, `<status>` (`completed` · `failed` · `killed` · `stopped`), `<summary>` |

Поле `workflowProgress` и поле `phases` бывают и строкой с JSON, и массивом: читать надо оба вида.

Выводы:
- **Пока запуск идёт**, дескриптора ещё нет. Имя запуска есть только в строке запуска в транскрипте. Агенты и их
  фазы видны по `journal.jsonl`, время старта агента — по `mtime` его `meta.json`.
- **Когда запуск кончился**, всё нужное есть в дескрипторе. Журнал больше не нужен.
- Если запуск оборвался вместе с процессом, дескриптора нет вовсе. Статус `stopped` приходит в транскрипт только при
  следующем подъёме сессии.
- У одной сессии бывает больше сотни запусков (максимум на диске — 107).

## 3. Что уже есть в Parley

- `packages/core/src/workflow.ts` читает дескрипторы (`readSessionWorkflows` → `WorkflowInfo`), а
  `session-tree.ts` группирует по ним подсессии. Пользуется этим только CLI (`cli.ts:335`). Хост, протокол и окно
  о запусках ничего не знают.
- Индекс логов хоста (`packages/host/src/activity/log-index.ts`) через `watchSessions` (`fs.watch`, debounce 300 мс,
  не чаще раза в 2 с) перечитывает транскрипт. Новые файлы под `<sid>/subagents/...` тоже ведут к переиндексации
  родителя. Изменения в `<sid>/workflows/` фильтр `sessionFileForPath` (`core/src/discover.ts:189`) отбрасывает.
- Живые цифры идут в окно полем `LiveMetrics` (`protocol/src/types.ts:140`) по событию `activity.changed`. Ближайший
  образец — план агента (`docs/specs/2026-10-18-agent-plan-design.md`): `SessionIndex.plan` → `LiveMetrics.plan` →
  `PlanSection` на вкладке Agents.
- Сессия Parley связана с транскриптом через `providerSessionId`, а запись индекса находится через `logIndex.index(session)`.
  Второй наблюдатель не нужен.

**Codex.** Инструмента Workflow у Codex нет. Есть `spawn_agent` (порождённые треды с `parent_thread_id`), и Parley уже
показывает их на вкладке Agents. Эта фича Codex не касается.

## 4. Решение

### 4.1 Данные (core)

Расширяем `workflow.ts`: второго модуля не будет, а CLI не ломается, потому что новые поля `WorkflowInfo`
необязательные.

1. **Строки запуска и конца из транскрипта.** Это накопитель в индексаторе сессии, по образцу `planCollector`: он так
   же переживает дочитывание хвоста через `clone`. Результат — `SessionIndex.workflowLaunches:
   Array<{runId, taskId, name, summary, launchedAt, status|null, endedAt|null}>`. Строку конца связываем со строкой
   запуска по `taskId`. Строки с `isSidechain: true` пропускаем.
2. **`readWorkflowRuns(sessionFile, launches, cache)`.**
   - Читает дескрипторы `<sid>/workflows/wf_*.json`. Кэш держит ключ `(путь, mtime, size)`: законченный дескриптор
     больше не меняется, поэтому сотня запусков не перечитывается на каждое событие.
   - Читает журналы `<sid>/subagents/workflows/wf_*/journal.jsonl` тех запусков, у которых дескриптора нет.
   - Сводит всё по `runId` и сортирует по началу, новые первыми.
3. **Статус запуска.**
   - Есть дескриптор → его `status`.
   - Иначе есть `<task-notification>` → её статус.
   - Иначе процесс сессии жив → `running`.
   - Иначе → `interrupted`.
4. **Состояние агента.**
   - В журнале: `result` → `done`; `failed` → `failed`; только `started` → `running`, а у оконченного запуска →
     `stopped`.
   - В дескрипторе: `done` → `done`; `error` → `failed`; `progress` → `stopped`.

### 4.2 Протокол

```ts
type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stopped' | 'interrupted';
type WorkflowAgentState = 'running' | 'done' | 'failed' | 'stopped';

interface WorkflowRunSummary {
  runId: string;
  name: string | null;              // workflowName
  summary: string | null;           // описание из meta скрипта
  status: WorkflowRunStatus;
  phase: string | null;             // фаза последнего начатого агента
  agents: { total: number; running: number; done: number; failed: number };
  startedAt: number | null;         // мс
  endedAt: number | null;
}

interface WorkflowRun extends WorkflowRunSummary {
  phases: string[];
  agentList: Array<{ agentId: string; label: string; phase: string | null; state: WorkflowAgentState;
                     model: string | null; startedAt: number | null; durationMs: number | null;
                     resultPreview: string | null; error: string | null }>;
  result: string | null;            // первые 2000 символов итога
  error: string | null;
}
```

- `LiveMetrics.workflows?: { runs: WorkflowRunSummary[]; total: number } | null`. В `runs` лежат не больше 20 новых
  запусков. Если запусков нет, приходит `null`. У хоста более ранней версии этого поля нет совсем. Полный список
  агентов в `activity.changed` не кладём: событие частое, а запусков бывает сотня.
- Метод `session.workflowRun { ref, runId }` → `WorkflowRun | null` (zod-схема в `METHODS`, тип в `Results`).

Пути к файлам наружу не отдаём, как и в `LiveTask`.

### 4.3 Хост

- `sessionFileForPath` принимает ещё и `<project>/<sid>/workflows/wf_*.json`. Тогда законченный запуск
  переиндексирует родителя.
- Индекс логов после переиндексации Claude-сессии считает `readWorkflowRuns`, хранит сводку при записи и отдаёт её
  через `logIndex.workflows(session)`.
- `metricsFor` кладёт сводку в `LiveMetrics.workflows`.
- Обработчик метода читает полный запуск по требованию через тот же кэш.

### 4.4 Окно

- **Вкладка Agents.** Добавляется раздел «Workflow» рядом с `PlanSection` (`agents/AgentsPanel.tsx`).
  - Каждый запуск — одна строка: имя, чип статуса, текущая фаза, `done/total` агентов, начало и длительность.
  - Строка раскрывается. Окно запрашивает `session.workflowRun` и запрашивает его снова, когда сводка этого
    запуска меняется.
  - В раскрытом запуске видны агенты (метка, фаза, состояние, модель, длительность, превью итога или ошибка) и итог
    запуска.
  - Внизу стоит «ещё N», если `total > runs.length`.
- **Строка сессии в сайдбаре** (`sidebar/SessionRow.tsx`, рядом с `AgentsBadge`) и **карточка участника комнаты**
  (`ParticipantStrip`). Там короткий значок «workflow · фаза · 3/5», пока хотя бы один запуск `running`. Клик
  открывает вкладку Agents этой сессии.

### 4.5 Транскрипт агента Workflow

Клик по агенту в раскрытом запуске открывает его транскрипт тем же способом, что у обычного субагента: через
`feed.snapshot {ref, agentId}`. Протокол не меняется.

- `agentSnapshot` (`host/src/feed/feed-service.ts:1241`) сначала ищет файл по прямому пути
  `subagents/agent-<id>.jsonl`. Если его там нет, он обходит `subagents/workflows/wf_*/` и берёт
  `agent-<id>.jsonl`. Каталоги берутся только с префиксом `wf_` и только настоящие, без ссылок (`lstat`). `agentId`
  уже проверяется по `SAFE_AGENT_ID`.
- `readSubagentMeta` (`host/src/activity/subagent-meta.ts:50`) ищет `meta.json` тем же способом.

## 5. Не входит

- Управление запусками: остановка, перезапуск, правка скрипта.
- Запуски Workflow в Codex: инструмента нет.
- Показ запусков в `get_map`.

## 6. Риски

- Формат не задокументирован Anthropic и может поменяться. Чтение терпит отсутствие любого поля и оба вида
  строка/массив. Неизвестный статус показываем как есть, и окно не падает.
- Хуки `SubagentStart` для агентов Workflow, возможно, уже попадают в `LiveMetrics.tasks` и бейдж «N agents». Это не
  проверено; если попадают, агентов не дублируем, а бейдж оставляем как есть.
- Нагрузка: дескрипторы кэшируются по mtime. Журнал нужен только живому запуску; самый большой журнал на диске весит
  1,4 МБ, потому что в нём лежат полные итоги агентов. Поэтому журнал тоже кэшируется по `(mtime, size)` и
  дочитывается с прошлой длины. Пересчёт идёт не чаще индекса (2 с).

## 7. Решения человека (2026-11-04)

1. Место показа: значок в строке сессии и в карточке участника комнаты, подробности на вкладке Agents. Отдельных
   строк для запусков в сайдбаре нет.
2. Транскрипт агента Workflow открывается в этой же фиче (4.5).
