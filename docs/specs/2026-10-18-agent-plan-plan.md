# План агента в комнате и на вкладке Agents — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обзор плана агента в карточке участника комнаты и подробности в разделе Plan вкладки Agents; этапы субагентов снова видны у текущего Claude Code.

**Architecture:** Чистая свёртка плана живёт в `@parley/core/agent-plan`. В существующем проходе индекса (`indexSessionFile`, `indexCodexSession`) коллектор связывает плановые вызовы с результатами, отсекает повторы и сворачивает успешные вызовы в исходном порядке. Сводка считается до обрезки; ограниченный `AgentPlan` идёт в `SessionIndex.plan` и `LiveMetrics.plan`. Окно рисует его в карточке участника и Agents. Та же свёртка по `children` с настоящими ID из результатов даёт этапы субагента.

**Tech Stack:** TypeScript, pnpm-монорепо (`@parley/core`, `@parley/protocol`, `@parley/host`, `@parley/desktop`), vitest, React + Radix (`ui/hover-card.tsx`), zustand.

**Spec:** `docs/specs/2026-10-18-agent-plan-design.md` (уточнения ревью 2026-10-18: сводка, достоверность журнала, ID субагентов, пин и узкое окно).

## Global Constraints

- Тексты окна — только по-английски (`desktop/src/shared/strings.ts`; тест `english-text`). Комментарии и тесты — по-русски, как вокруг.
- Коммиты — по-английски, в конце `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Свёртка плана — только в `@parley/core/agent-plan`. Своего расчёта плана в окне или хосте нет (правило «статусы из одного места»).
- Новых чтений диска нет: план сворачивается только в существующем проходе индекса.
- Потолки: `PLAN_ITEMS_LIMIT = 50`, `PLAN_DESCRIPTION_LIMIT = 4096` символов; обрезанное описание кончается на `…`.
- Сводка считается по полному состоянию до обрезки; текущий/следующий пункт сохраняется среди 50. `partial` — неполный источник, `omitted` — только ограничение отображения. У `partial` точный общий счётчик не показывается.
- Только успешные завершённые вызовы меняют план. Нет ответа — нет подтверждённого изменения; нет ID задачи — `null`, порядковый ID не подставляется.
- У Codex без поддерживаемых вызовов плана нет. Приёмка парсера на фикстуре и наблюдение живого вызова отмечаются отдельно.
- Порядок второй строки карточки: `doing` → пункт плана → `task`.
- Поле `LiveMetrics.plan`: нет поля — хост старой версии, `null` — плана нет.
- Тесты одного файла: `pnpm --filter @parley/<pkg> exec vitest run <путь от корня пакета>`.

## Review Focus

- Длинный `subject` и длинное имя участника в карточке 230px при окне 800×500: текст обрезается, чип `3/7` и чип контекста целиком. Тест — в Task 6.
- Все пункты закрыты, затем новый `TaskCreate`: счётчик `0/1`, а не `N/N+1`. Тест — в Task 1.
- `TaskUpdate` с неизвестным `taskId`, `status: deleted`, `TaskCreate` без ответа: план не ломается. Тесты — в Task 1 и Task 2.
- Сессия без вида Chat (Codex, старый `claude`) на вкладке Agents: раздел Plan есть. Тест — в Task 5.
- Хост старой версии без поля `plan`: карточка и вкладка как сейчас. Тесты — в Task 5 и Task 6.
- 60 завершённых пунктов дают `60/60`, чип скрыт; текущий пункт №51 остаётся в списке и карточке. Tasks 1, 6.
- Повторы, ошибки, отсутствие и задержка ответов не создают ложный прогресс и не меняют порядок вызовов. Task 2.
- Усечённый хвост субагента не перенумеровывает задачи; `TaskUpdate #1` не меняет настоящий пункт №2. Task 4.
- Комната с MRU B → план A → активация B снимает пин, в том числе при закрытой панели. В 800×500 открывается сам план без ухода из комнаты. Task 5.

## Волны исполнения (файлы волны не пересекаются)

| Волна | Задачи |
|---|---|
| 1 | Task 1 |
| 2 | Task 2 ‖ Task 4 |
| 3 | Task 3 ‖ Task 5 |
| 4 | Task 6 |
| 5 | Task 7 |

---

### Task 1: Свёртка плана в core и поле протокола

**Files:**
- Create: `packages/core/src/agent-plan.ts`
- Test: `packages/core/src/agent-plan.test.ts`
- Modify: `packages/core/package.json` (exports `"./agent-plan": "./dist/agent-plan.js"`), `packages/core/src/index.ts` (реэкспорт типов), `packages/protocol/src/types.ts` (`LiveMetrics.plan`)

**Interfaces:**
- Produces:
  ```ts
  export type AgentPlanStatus = 'pending' | 'in_progress' | 'completed';
  export interface AgentPlanItem { id: string | null; subject: string; description: string | null; activeForm: string | null; status: AgentPlanStatus }
  export interface AgentPlanState { items: AgentPlanItem[]; explanation: string | null; updatedAt: string; partial: boolean }
  export interface AgentPlanSummary { current: AgentPlanItem | null; next: AgentPlanItem | null; done: number; total: number }
  export interface AgentPlan extends AgentPlanState { omitted: number; summary: AgentPlanSummary }
  /** `result` — объект результата, JSON-строка или текст; у субагента — child.response?.text. */
  export interface PlanCall { name: string; input: Record<string, unknown>; result?: unknown; status: 'running' | 'done' | 'failed' | 'rejected'; at: string }
  export const PLAN_ITEMS_LIMIT = 50;
  export const PLAN_DESCRIPTION_LIMIT = 4096;
  export function applyPlanCall(plan: AgentPlanState | null, call: PlanCall): AgentPlanState | null;
  export function capPlan(plan: AgentPlanState): AgentPlan;
  export function planSummary(plan: AgentPlan): AgentPlanSummary;
  ```
- `LiveMetrics.plan?: AgentPlan | null` в `@parley/protocol` (тип — `import type` из `@parley/core`).

Правила `applyPlanCall` — раздел 4 спеки, дословно:
- Применяются только `status: 'done'` без явной ошибки результата (`success: false`, `is_error: true`); `running`, `failed`, `rejected` сохраняют прежнее состояние и `updatedAt`.
- `TaskCreate` добавляет `pending` в конец. ID: `result.task.id`, в том числе из JSON-строки; иначе `Task #N created successfully: …` из успешного текстового ответа. Успешный ответ без ID → `id: null`, `partial: true`; порядковая подстановка запрещена.
- `TaskUpdate` по известному ненулевому `taskId` меняет пришедшие `status` / `subject` / `description` / `activeForm`. `deleted` удаляет пункт. Неизвестный ID не меняет пункты, но выставляет `partial` у существующего плана; соответствие по позиции/тексту не используется.
- Успешные `TodoWrite` (`todos[].content|status|activeForm`) и `update_plan` (`plan[].step|status`, `explanation`) заменяют список и снимают `partial`, если сам снимок полный.
- Новый план при успешном `TaskCreate`, если все пункты полного, не `partial`, плана `completed` (и их больше нуля), или новый уникальный вызов возвращает ID уже имеющегося пункта. Повторы вызовов отсекает коллектор до свёртки; меньший, ещё не встречавшийся ID не сбрасывает план.
- Неизвестный статус — `pending`; пустой `subject` — пропуск; прочие имена инструментов — план без изменений.

`applyPlanCall` работает только с полным `AgentPlanState`, ограниченный снимок обратно в него не подаётся. `capPlan` вычисляет `summary` по всем пунктам: `total = state.items.length`, `done` — все `completed`, `current` — первый `in_progress`, `next` — первый `pending` только при отсутствии `current`. Затем оставляет первые 50; если `current ?? next` вне этого набора, заменяет им последний выбранный пункт, сохраняя исходный порядок. `omitted = summary.total - items.length`. `description` выбранных пунктов и ссылок `summary.current/next` обрезается до 4096 символов. `planSummary` возвращает сохранённую `summary`, ничего не пересчитывая по ограниченному `items`. `partial` сохраняется; `omitted > 0` само по себе его не выставляет.

- [ ] **Step 1: Write the failing tests** в `agent-plan.test.ts`:
  Общий helper успешных вызовов задаёт `status: 'done'` и результат; тесты отсутствующего/ошибочного ответа переопределяют их явно. Для проверок сводки сначала вызывается `capPlan(state)`.
  - `создаёт пункты TaskCreate с номером из ответа` — два вызова с `result: { task: { id: '1', subject: 'A' } }` и `'2'` → `items.map(i => [i.id, i.subject, i.status])` равно `[['1','A','pending'],['2','B','pending']]`;
  - `ID из текста и JSON-строки ответа` — текст `Task #7 created successfully: X` и сериализованный `{ task: { id: '7' } }` → id `'7'`;
  - `успешное создание без ID не угадывает номер` — `status: 'done'`, непустой subject, нераспознаваемый ответ → `id: null`, `partial: true`; Update с числовым ID не меняет этот пункт;
  - `TaskUpdate меняет статус и описание, deleted удаляет, неизвестный taskId не меняет пункты и помечает partial`;
  - `running, failed, rejected и явная ошибка не меняют план и updatedAt` — проверить для создания, обновления и замены списка;
  - `TodoWrite и update_plan заменяют список` — `update_plan` с `explanation: 'why'` → `plan.explanation === 'why'`, `id === null`;
  - `новый план после закрытия всех пунктов` — два `completed`, затем `TaskCreate` → `state.items.length === 1`, `planSummary(capPlan(state)).total === 1`;
  - `повтор ID новым вызовом начинает план, меньший новый ID — нет` — пункты 1..3, новый Create с ID `'1'` → один пункт; Create с ID `'2'`, затем ранее не встречавшийся `'1'` → два пункта;
  - `partial не позволяет считать прежний план завершённым` — известные пункты completed, partial true, новый Create с новым ID → старые пункты остаются;
  - `capPlan режет до 50 пунктов и описание до 4096` — 60 completed → `items.length === 50`, `omitted === 10`, `summary.done === summary.total === 60`, `partial === false`; описание 5000 символов → длина 4096 и последний символ `…`;
  - `текущий или следующий пункт за пределом 50 сохранён` — 60 пунктов, первые 50 completed, №51 in_progress (второй вариант pending) → пункт №51 в `items` и `summary`, `omitted === 10`, порядок сохранён, описание в summary тоже ограничено;
  - `planSummary: current, next, done` — `[completed, in_progress, pending]` → `current.subject` второго, `next === null`, `done === 1`; без `in_progress` → `next` — первый `pending`.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/agent-plan.test.ts` → FAIL (модуля нет).
- [ ] **Step 3:** Реализовать `agent-plan.ts` по Interfaces; обновить `package.json` exports, реэкспорт типов в `index.ts`, поле в `protocol/src/types.ts` с JSDoc в духе соседних полей («Поля нет у хоста более ранней версии»).
- [ ] **Step 4:** Тест → PASS; `pnpm --filter @parley/core build && pnpm --filter @parley/protocol exec tsc --noEmit` → без ошибок.
- [ ] **Step 5: Commit** — `feat(core): fold agent plans from TaskCreate/TaskUpdate/TodoWrite/update_plan`.

### Task 2: План в индексе лога (Claude и Codex)

**Files:**
- Create: `packages/core/src/agent-plan-log.ts`, test `packages/core/src/agent-plan-log.test.ts`
- Modify: `packages/core/src/session-index.ts` (поле `SessionIndex.plan?: AgentPlan | null`, вызов в `onRecord` и в конце `indexSessionFile`), `packages/core/src/codex/index-session.ts` (то же для `indexCodexSession`), `packages/core/src/codex/codex.test.ts`, `packages/core/src/session-index.test.ts`

**Interfaces:**
- Consumes: `applyPlanCall`, `capPlan`, `PlanCall`, `AgentPlan` (Task 1).
- Produces:
  ```ts
  export interface PlanCollector { onRecord(raw: Record<string, unknown>): void; finish(): AgentPlan | null }
  export function createClaudePlanCollector(): PlanCollector;
  export function createCodexPlanCollector(): PlanCollector;
  ```
  и `SessionIndex.plan` — результат `finish()` (`capPlan` полного состояния или `null`). Коллектор не хранит сырые неплановые записи.

Формы записей Claude из логов 2.1.227–2.1.302 и синтетическая пара Codex:
```jsonl
{"type":"assistant","isSidechain":false,"timestamp":"T1","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"TaskCreate","input":{"subject":"A","description":"D","activeForm":"Doing A"}}]}}
{"type":"user","timestamp":"T2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Task #1 created successfully: A"}]},"toolUseResult":{"task":{"id":"1","subject":"A"}}}
{"type":"assistant","timestamp":"T3","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"TaskUpdate","input":{"taskId":"1","status":"in_progress"}}]}}
{"type":"user","timestamp":"T3a","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"Updated task #1"}]},"toolUseResult":{"success":true,"taskId":"1"}}
{"timestamp":"T4","type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":"call_1","arguments":"{\"explanation\":\"E\",\"plan\":[{\"step\":\"S\",\"status\":\"in_progress\"}]}"}}
{"timestamp":"T5","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"Plan updated"}}
```

Примеры показывают форму записей; `T*` в тестах заменить ISO-временем. Пару Codex считать синтетической фикстурой до наблюдения такого вызова живьём.

Claude-коллектор хранит только плановые вызовы в `Map<tool_use_id, PlanCall>` в порядке первого появления и связывает результаты по `tool_use_id`. Повторный вызов/ответ не добавляет операцию и не переносит её в конец. `tool_result.is_error: true`, явный отказ или `toolUseResult.success: false` дают `failed`/`rejected`; прочий завершённый успешный ответ — `done`, отсутствие ответа — `running`. `result` нормализуется из `toolUseResult` или текста/текстовых блоков `tool_result.content`. В `finish()` вызовы проигрываются в исходном порядке, затем один раз применяется `capPlan`. Незавершённые вызовы не превращаются в успешные и не дописываются в конец. Следующий проход с появившимся ответом восстанавливает их на исходной позиции. `isSidechain: true` пропускается для вызовов и результатов.

Codex-коллектор связывает `function_call` и `function_call_output` по `call_id`, сохраняет порядок первого вызова и отсекает повторы. `arguments` — `JSON.parse` в `try`, битый JSON — пропуск. Успешный ответ даёт `done`, явная ошибка результата — `failed`, отсутствие ответа — `running`; неподдерживаемая/неоднозначная форма результата не считается подтверждением успеха. Проверить нормализацию результата на фикстурах успеха и ошибки; приёмка не ограничивается одним `function_call` без результата. Никакого разбора произвольного JavaScript внутри code mode.

- [ ] **Step 0: Замер «до»** (спека 9.4). На текущем master: `pnpm --filter @parley/core build`, затем однократный скрипт в scratchpad, который импортирует `indexSessionFile` из `packages/core/dist/session-index.js` и 5 раз индексирует самый большой лог (`ls -S ~/.claude/projects/*/*.jsonl | head -1`). Записать медиану в журнал задачи.
- [ ] **Step 1: Write the failing tests:**
  - `agent-plan-log.test.ts`: `Claude: TaskCreate применяется с номером из ответа, TaskUpdate меняет статус` — записи выше → `items[0]` равно `{ id: '1', subject: 'A', description: 'D', activeForm: 'Doing A', status: 'in_progress' }`;
  - `Claude: вызов без ответа не меняет план` — Create без ответа → `null`; обновление/замена без ответа сохраняют предыдущее состояние;
  - `Claude: задержанный ответ не меняет порядок` — Create A, Update A, успешный ответ Update, успешный ответ Create → A in_progress; до ответа Create A не выдумывается;
  - `Claude: старый Create не дописывается после замены` — Create A, успешный TodoWrite B, задержанный успешный ответ Create → только B;
  - `Claude: ошибки создания, обновления и замены не меняют план` — `is_error: true`, `success: false`, отказ;
  - `Claude: повтор старого Create/ответа не сбрасывает план` — Create №1, Create №2, Update №2, повтор первой пары с теми же ID → оба пункта и статус №2 сохранены;
  - `Claude: успешный ответ без ID даёт null ID и partial; текстовые блоки результата извлекаются`;
  - `Claude: isSidechain пропускается`;
  - `Codex: успешная пара вызов/ответ даёт план; битый JSON, ошибка и отсутствие ответа не меняют его; повтор старого call_id не откатывает новый снимок`;
  - `session-index.test.ts`: `индекс несёт plan; без плановых вызовов plan === null`;
  - `codex.test.ts`: `индекс Codex несёт plan из успешного update_plan; без поддерживаемых вызовов plan === null`.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/agent-plan-log.test.ts src/session-index.test.ts src/codex/codex.test.ts` → новые тесты FAIL.
- [ ] **Step 3:** Реализовать коллекторы и подключить их в оба индекса: один коллектор на проход, `onRecord(raw)` в существующем обходчике записей, `plan: collector.finish()` в результат.
- [ ] **Step 4:** Тесты → PASS; весь `pnpm --filter @parley/core test` → PASS.
- [ ] **Step 5: Замер «после»** тем же скриптом: медиана не больше «до» × 1.1. При превышении оптимизировать отбор по типу записи и ID планового вызова. Не фильтровать все записи только по имени инструмента: ответы не обязаны его содержать, и такая фильтрация потеряет подтверждение результата.
- [ ] **Step 6: Commit** — `feat(core): carry the agent plan in the session log index`.

### Task 3: План в живых метриках хоста

**Files:**
- Modify: `packages/host/src/activity/activity-service.ts` (`metricsFor`, ~стр. 578–614)
- Test: `packages/host/src/activity/activity-service.test.ts`

**Interfaces:**
- Consumes: `SessionIndex.plan` (Task 2), `LiveMetrics.plan` (Task 1).
- Produces: `metricsFor(...).plan === indexed?.plan ?? null` — у сессий в любом `lifecycle`.

- [ ] **Step 1: Write the failing tests** (по образцу соседних тестов, которые подменяют индекс лога):
  - `метрики несут plan из индекса лога` — индекс с планом из одного пункта → в `activity.changed` `metrics.plan.items[0].subject === 'A'`;
  - `смена плана в индексе снова шлёт activity.changed, тот же план — нет`;
  - `спящая сессия тоже несёт plan`.
- [ ] **Step 2:** `pnpm --filter @parley/host exec vitest run src/activity/activity-service.test.ts` → новые FAIL.
- [ ] **Step 3:** Добавить `plan: indexed?.plan ?? null` в `metricsFor`.
- [ ] **Step 4:** Тест → PASS; `pnpm --filter @parley/host test` → PASS (при флейках сравнить с базовым прогоном, см. «капризы tui-тестов»).
- [ ] **Step 5: Commit** — `feat(host): send the agent plan in live metrics`.

### Task 4: Этапы субагента на той же свёртке

**Files:**
- Modify: `packages/desktop/src/renderer/agents/agents-model.ts`, `agents-model.test.ts`, `AgentDetail.tsx`, `AgentDetail.test.tsx`, `packages/desktop/src/shared/strings.ts` (`agentsPanel.planIncomplete`)

**Interfaces:**
- Consumes: `applyPlanCall`, `capPlan`, `AgentPlanState`, `AgentPlan` из `@parley/core/agent-plan` (Task 1).
- Produces: `agentSteps(agent: FeedAgent): AgentPlan | null` — свёртка полного состояния по `children` в порядке вызовов, передаются `result: child.response?.text`, `status: child.status`, `at: child.at`; в конце `capPlan`.
- `agentStepsPartial(agent: FeedAgent): boolean` — `agent.toolCount > agent.children.length` либо усечён `input`/`response` планового вызова (`child.truncated`, `child.response?.truncated`). Признак вычисляется до свёртки и консервативно добавляется к `partial` каждого ненулевого состояния сразу после шага, до следующего `applyPlanCall`, включая шаг замены списка. Только выставить его перед `capPlan` недостаточно: правило завершённого плана могло бы уже сбросить восстановленные пункты. Тип `AgentStep` удаляется.

`response.text` у вложенного вызова уже есть (`finishTool` в `core/src/feed/reduce.ts`); ID может быть в JSON-сводке или успешном текстовом ответе. Парсинг ID — общий в core, собственной нумерации в окне нет. Неплановые вызовы не влияют на состояние; running/failed/rejected пропускаются. Если `plan === null`, но `agentStepsPartial(agent)`, раздел Steps всё равно показывает предупреждение.

- [ ] **Step 1: Write the failing tests:**
  - `agents-model.test.ts`: успешные `TaskCreate A/B` с ответами ID 1/2, успешный `TaskUpdate #1 completed` → `[['A','completed'],['B','pending']]`; варианты ID из JSON и текста;
  - `хвост не перенумеровывает задачи` — Create №1 выпал, сохранился успешный Create №2 и Update №1 → пункт №2 pending, `partial === true`;
  - `неполнота учитывается до следующего вызова` — начало выпало, известный Create №2 → Update №2 completed → Create №3: оба известных пункта сохранены, завершение неизвестной части не запускает новый план;
  - `нет ID — нет угадывания` — успешный Create с нераспознаваемым ответом имеет null ID; Update №1 не меняет его;
  - `ошибка, отказ и running не меняют этапы; усечённый плановый input/response даёт partial`;
  - прежние `TodoWrite`/`update_plan` проверяют успешные завершённые вызовы; отсутствующий результат не маскируется в фикстуре под успех;
  - `AgentDetail.test.tsx`: `toolCount: 150`, 100 детей → `S.agentsPanel.planIncomplete` виден, точного общего счётчика нет; предупреждение видно и без восстановленных пунктов.
- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/agents/agents-model.test.ts src/renderer/agents/AgentDetail.test.tsx` → FAIL.
- [ ] **Step 3:** Реализовать; `AgentDetail` рисует `plan.items` прежними значками, при `plan.partial` или `agentStepsPartial` показывает `planIncomplete: 'Plan may be incomplete'`, при `omitted > 0` — число скрытых пунктов. Предупреждение доступно и когда пункты восстановить не удалось.
- [ ] **Step 4:** Тесты → PASS.
- [ ] **Step 5: Commit** — `fix(desktop): show subagent steps from TaskCreate/TaskUpdate`.

### Task 5: Раздел Plan и явная сессия на вкладке Agents

**Files:**
- Create: `packages/desktop/src/renderer/agents/PlanSection.tsx` (+ `PlanSection.test.tsx`), `packages/desktop/src/renderer/agents/plan-links.ts` (+ `plan-links.test.ts`)
- Modify: `agents/AgentsPanel.tsx` (+ test), `agents/open-agents.ts` (+ `open-agents.test.ts`), `chat/ui-store.ts` (+ test), `chat/ChatView.tsx` (+ существующие тесты), `shell/AppShell.tsx`, `shared/strings.ts` (`agentsPanel.plan*`)

**Interfaces:**
- Consumes: `AgentPlan`, `planSummary` (Task 1); `LiveMetrics.plan` из `useActivityStore` (`byRef[refKey(ref)]?.metrics?.plan`).
- Produces:
  - `ui-store`: `agentsPin: Record<string, string | null>` (ключ — `workKey`), `pinAgentsSession(workKey: string, sessionId: string | null): void`; сброс в `reset` вместе с `agentPanel`. `bindAgentsPinToLayout(): () => void` подписывается на `useLayoutStore`; `AppShell` устанавливает подписку один раз через `useEffect` и возвращает отписку, как существующий `bindReviewToLayout`. Поэтому сброс работает и при закрытом правом сайдбаре или выбранных Files/Changes, когда `AgentsPanel` размонтирован.
  - Подписка сравнивает фактическую активную вкладку активной группы до и после изменения (`workKey`, `groupId`, `tabId`). Если новая активная вкладка — `terminal` или `diff` и эта тройка изменилась, снимает пин её работы. Переход на комнату или файл пин не снимает. `focusedSessionOf` и его MRU не являются сигналом сброса: комната с MRU B → пин A → переход на терминал B обязан снять пин, хотя `focusedSessionOf` всё время возвращает B.
  - `open-agents.ts`: `openPlanInPanel(ref: SessionRef): void` — если `rightSidebarHasRoom()` возвращает `false`, сначала `setSidebar('left', { open: false })`; затем `pinAgentsSession(workKey, ref.sessionId)`, `selectAgent(refKey(ref), null)`, `setSidebar('right', { open: true, tab: 'agents' })`. Фокус главной вкладки, в том числе комнаты, не меняется. Минимальная ширина desktop-окна — 800; без левого сайдбара места хватает существующей правой панели. Левый сайдбар автоматически не восстанавливаем.
  - Существующие `openAgentsPanel` и `openAgentInPanel` явно снимают пин работы перед своим обычным поведением, включая ветки нехватки места: открытие списка или выбранного субагента не должно оставаться на ранее закреплённом участнике. `openAgentsPanel` принимает `SessionRef` вместо строки `sessionKey`, внутри получает `refKey(ref)`; единственный вызов в `ChatView` передаёт уже имеющийся `sessionRef`. `openAgentInPanel` уже получает `SessionRef`.
  - `plan-links.ts`: `roomPlanLinks(entry: WorkEntry, sessionId: string): { roomId: string; planId: string; itemId: number; title: string; scope: string }[]` — планы со `status` `active`/`completing`, пункты с `owner === sessionId` и `status` из `ready`, `in_progress`, `blocked`, `returned`.
  - `PlanSection({ plan, links, onOpenRoom }: { plan: AgentPlan; links: ReturnType<typeof roomPlanLinks>; onOpenRoom: (roomId: string) => void })`.

`AgentsPanel`: `sessionId = pin ?? focusedSessionOf(...)`. При пине в шапке — `sessionRowLabel` участника. `PlanSection` стоит сверху в обеих ветках (`hasFeed` и без ленты), когда `plan` не `null`/`undefined`. Открытие комнаты — тем же путём, что клик по строке комнаты в сайдбаре (`sidebar/RoomRow.tsx`). Раздел Plan: заголовок `Plan · {done}/{total}` из сохранённой `plan.summary` через `planSummary`, ссылки `{planId} · item {itemId}: {title}` (подсказка — `scope`), `explanation`, пункты со значками `CheckCircle2` / `LoaderCircle` / `Circle`; клик раскрывает `description` через `RoomMarkdown`; `in_progress` раскрыт сразу; без описания не раскрывается; при `omitted > 0` — строка `+{omitted} more`. При `partial` заголовок только `Plan`, без точного общего счётчика; под ним `Plan may be incomplete`. `omitted` означает только скрытые отображением пункты и не заменяет предупреждение о неполных исходных данных. Счётчики и текущий пункт не пересчитываются из усечённого `items`.

- [ ] **Step 1: Write the failing tests:**
  - `plan-links.test.ts`: `берёт пункты сессии из активных планов` — пункт чужого `owner`, пункт `done`, план `completed` → не попадают;
  - `PlanSection.test.tsx`: `in_progress раскрыт, клик раскрывает другой`, `пункт без описания не раскрывается`, `ссылка на комнату зовёт onOpenRoom`, `omitted показан`; 60 завершённых пунктов, из которых видны 50, дают заголовок `Plan · 60/60`; исходный текущий пункт №51 остаётся в списке после ограничения; `partial` показывает `Plan may be incomplete` и не показывает `n/m`;
  - `AgentsPanel.test.tsx`: `пин показывает сессию участника и её Plan`, `сессия без ленты тоже показывает Plan`, `metrics без поля plan — раздела нет`;
  - `ui-store.test.ts`: подписка снимает пин при активации `terminal` и `diff`, включая `MRU B → комната → пин A → терминал B`; не снимает при открытии комнаты/файла; работает без смонтированного `AgentsPanel`; после отписки не реагирует;
  - `open-agents.test.ts`: `openPlanInPanel ставит пин и вкладку agents, фокус не трогает`; интеграция с настоящим `rightSidebarHasRoom`/`fitRightSidebar` при `window.innerWidth = 800`, открытом левом сайдбаре шириной 288: левый закрыт, правый помещается и открыт на Agents, пин у нужной сессии, активная вкладка остаётся комнатой; существующие `openAgentsPanel`/`openAgentInPanel` снимают пин другой сессии, даже когда выбранная сессия уже была в фокусе;
  - существующие тесты `ChatView`: кнопка списка агентов передаёт `SessionRef` после изменения сигнатуры.
- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/agents src/renderer/chat/ui-store.test.ts src/renderer/chat/ChatView.test.tsx` → новые FAIL.
- [ ] **Step 3:** Реализовать по Interfaces; английские строки в `S.agentsPanel`.
- [ ] **Step 4:** Тесты → PASS; `pnpm --filter @parley/desktop exec tsc --noEmit` → без ошибок.
- [ ] **Step 5: Commit** — `feat(desktop): plan section and pinned session in the Agents tab`.

### Task 6: План в карточке участника комнаты

**Files:**
- Create: `packages/desktop/src/renderer/components/rooms/PlanChip.tsx` (+ `PlanChip.test.tsx`)
- Modify: `components/rooms/feed-model.ts` (+ test), `ParticipantStrip.tsx` (+ test), `RoomHeader.tsx`, `RoomPanel.tsx`, `shared/strings.ts` (`rooms.plan*`)

**Interfaces:**
- Consumes: `planSummary`, `AgentPlan` (Task 1); `openPlanInPanel` (Task 5).
- Produces:
  - `ParticipantModel.plan: AgentPlan | null` (из `metrics.plan`, при любом `lifecycle`; нет поля — `null`) и `ParticipantModel.planLine: { kind: 'current' | 'next'; text: string } | null` — `current` → `▸ {subject}`, иначе `next` → `Next: {subject}`, иначе `null`. `current`, `next`, `done`, `total` берутся через `planSummary` из сводки, посчитанной до ограничения `items`.
  - `PlanHover({ plan, onOpen, children }: { plan: AgentPlan; onOpen: () => void; children: ReactElement })` — `HoverCard` (`ui/hover-card.tsx`) вокруг любого триггера: им обёрнуты и чип, и текст пункта во второй строке (спека 6.3).
  - `PlanChip({ plan, onOpen }: { plan: AgentPlan; onOpen: () => void })` — `PlanHover` вокруг кнопки `{done}/{total}`; при `partial` вместо счётчика надпись `Plan`. Содержимое `PlanHover`: `explanation`, список пунктов со значками, у `in_progress` — первые 6 строк `description`, при `omitted > 0` строка `+{omitted} more`, при `partial` предупреждение `Plan may be incomplete`, кнопка `Open in Agents`. Неполный план нигде в поповере не показывает точный общий `n/m`. Клик по чипу и по `Open in Agents` зовёт `onOpen`. Длинный список прокручивается внутри.
  - `ParticipantStrip` получает `onOpenPlan: (sessionId: string) => void`; `RoomHeader` его пробрасывает; `RoomPanel` передаёт `(id) => openPlanInPanel({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: id })`.

Вторая строка: текст `doing ?? planLine?.text ?? task`. Клик по тексту при `planLine` (и пустом `doing`) → `onOpenPlan`, иначе как сейчас. `PlanChip` стоит перед чипом контекста, когда `plan` есть и (`partial` или `done < total`), в том числе рядом с `doing`. Если данные неполны и все известные пункты закрыты, текст возвращается к `task`, но чип `Plan` оставляет доступ к предупреждению: завершение всего плана неизвестно. Полный план с 60 закрытыми пунктами возвращается к `task` без чипа независимо от ограничения списка до 50. Чипы `shrink-0`, текст `min-w-0 truncate`.

- [ ] **Step 1: Write the failing tests:**
  - `feed-model.test.ts`: `planLine: current, next, null при всех закрытых`, `нет поля plan — plan null, строка — task`; текущий пункт №51 из исходных 60 остаётся текущей строкой после ограничения списка;
  - `ParticipantStrip.test.tsx`: `doing важнее плана, чип 3/7 рядом`, `без doing — ▸ subject, клик зовёт onOpenPlan`, `все 60 пунктов закрыты, видны 50 — task, чипа нет`, `partial без известных открытых пунктов — task и чип Plan без n/m`, `длинный subject и имя: чипы видны целиком` (проверить классы `shrink-0` у чипов и `truncate` у текста);
  - `PlanChip.test.tsx`: `наведение показывает список и 6 строк описания in_progress`, `Open in Agents зовёт onOpen`, `наведение на текст пункта во второй строке открывает тот же список`, `omitted показан`, `partial показывает Plan may be incomplete без точного общего счётчика`.
- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms` → новые FAIL.
- [ ] **Step 3:** Реализовать по Interfaces; строки `S.rooms.planNext`, `S.rooms.planOpenInAgents` и т. п. — по-английски.
- [ ] **Step 4:** Тесты → PASS; `pnpm --filter @parley/desktop test` → PASS (флейки — сравнить с базовым прогоном).
- [ ] **Step 5: Commit** — `feat(desktop): agent plan in room participant cards`.

### Task 7: Живая приёмка и CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (раздел Unreleased, по-английски)

- [ ] **Step 1:** Перед запуском — загрузка машины (`uptime`, `memory_pressure`); при load ≥ числа ядер ждать.
- [ ] **Step 2:** Dev-окно (рецепт — память «окно без терминала»), комната с двумя Claude и одним Codex. Для сессии, где в логе есть подтверждённые успешные вызовы планирования, проверить:
  - карточка: `▸ subject`, чип `n/m`, наведение — список и описание, клик — вкладка Agents на этом участнике без ухода из комнаты;
  - раздел Plan: раскрытие описаний, ссылка на пункт плана комнаты;
  - пин: комната с последней сессией B → открыть план участника A → активировать терминал B; Agents показывает B. Повторить с закрытым правым сайдбаром перед переходом и затем открыть Agents; старый пин не возвращается. Существующий вход к субагенту B также снимает пин A;
  - окно 800×500 с открытым левым сайдбаром шириной 288: клик по плану закрывает левый сайдбар, показывает правую вкладку Agents с правильным участником, комната остаётся активной. После открытия плана левый сайдбар сам не восстанавливается;
  - субагент с подтверждёнными вызовами: этапы и статусы соответствуют реальным ID. Потеря начала истории не меняет статус чужого пункта и обозначается `Plan may be incomplete`, без точного общего счётчика;
  - подготовленные фикстуры длинного плана: 60 закрытых пунктов → чипа нет; текущий пункт №51 → виден в строке и подробностях; `omitted` и `partial` имеют отдельные пометки.
  Длинные названия пунктов и проекта, светлая и тёмная тема. Снимки — в отчёт. Если Codex в живом запуске не вызывает `update_plan`, отсутствие плана — правильный результат; в отчёте это ограничение живой проверки, а успешный `update_plan` проверяется фикстурой. Не заявлять наблюдённую живую поддержку Codex без таких записей. То же ограничение записать, если субагент не вызвал инструмент планирования.
- [ ] **Step 3:** Запись в `CHANGELOG.md`: «Show agent-authored plans from successful planning calls on room participant cards and in the Agents tab; support Claude task IDs in subagent steps and mark incomplete plans.»
- [ ] **Step 4: Commit** — `docs(changelog): agent plans in rooms and the Agents tab`.
