# Панель агентов справа и вид Chat для Codex — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** вкладка «Agents» правого сайдбара показывает агентов активной сессии и экран одного агента; сессия Codex ≥ 0.160.0 открывается в виде Chat — лента из журнала у всех, карточки Allow/Deny при одобренных в `/hooks` хуках.

**Architecture:** панель — только окно, на готовых карточках `agent` ленты. Лента Codex — новый разбор журнала (rollout) в core на общих строительных блоках редьюсера, источник на хосте читает журнал хвостом, окно включает Chat по признаку хоста `feed-codex`. Хуки Codex — команда-мост к существующему приёмнику хуков, одобряет их человек в `/hooks`.

**Tech Stack:** TypeScript, pnpm monorepo (`@parley/core`, `@parley/protocol`, `@parley/host`, `@parley/desktop`), vitest, Electron + React + zustand + Tailwind, Playwright (E2E).

**Spec:** `docs/specs/2026-10-07-agents-panel-codex-chat-design.md` (одобрена 2026-10-07). Исполнитель читает спеку и этот план.

**Рабочая копия:** `/Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/agents-panel-codex-chat`, ветка `feat/agents-panel-codex-chat`. Все пути ниже — от корня этой копии.

## Global Constraints

- Тексты окна — английские, в `packages/desktop/src/shared/strings.ts`; комментарии, имена тестов, спеки и TODOS — по-русски; README и CHANGELOG — по-английски.
- `CODEX_FEED_MIN_VERSION = '0.160.0'`; признак хоста — строка `'feed-codex'` (`FEED_CODEX_FEATURE`).
- `PROTOCOL_VERSION` остаётся 1, `FEED_SCHEMA_VERSION` остаётся 2: новые поля протокола — только необязательные.
- Ничего не писать в `~/.codex` и `~/.claude`; свои файлы — только в `PARLEY_HOME` (по умолчанию `~/.parley`) и в каталоге работы.
- Не запускать Codex с `--dangerously-bypass-hook-trust` и не писать доверие хуков (`hooks.state`) за человека.
- Текст определения хуков Codex (`-c hooks.…`) побайтно одинаков между запусками, сессиями, resume и обновлениями Parley.
- Живые запуски настоящего `codex` и `claude` — только после явного «да» человека в чате (тратят недельный лимит подписки).
- Проверки раскладки — в окне 800×500 с длинными значениями: описание агента ≥ 80 знаков, команда и путь ≥ 100 знаков; E2E и при DPR 1, и при DPR 2 (`--force-device-scale-factor=2`).
- Один коммит на задачу: `feat|fix|test|docs(<пакет>): <что>` по-русски, в конце строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Не пушить без просьбы человека.
- Desktop-тесты и typecheck требуют собранных core и protocol: `pnpm --filter "@parley/desktop^..." build`. E2E — ещё `pnpm --filter @parley/host build && pnpm -C packages/desktop build`.
- Нестабильные под нагрузкой тесты (host: `log-index` «дописанный файл», `sessions-service` «autoLaunch…», `rooms` «два Accept подряд», `activity-terminal` «порог тишины…»): упавший — перезапустить в одиночку и сравнить с прогоном на `origin/master`, а не чинить вслепую.

## Review Focus

1. Очень длинные описание, задание и текущая команда агента в окне 800×500 — строки панели и экрана агента обрезаются многоточием, ничего не вылезает за край сайдбара (тест — задача 6).
2. Строка журнала Codex разрезана между двумя чтениями файла — элемент появляется в ленте один раз и целиком, без дубля и без потери (тест — задача 13).
3. Фокус ушёл с вкладки сессии на вкладку комнаты, файла или браузера — панель продолжает показывать прежнюю сессию, а не «Open a session…» (тест — задача 2).
4. Агент закончил, пока открыт его экран — статус сменился на done, появился итог, полный транскрипт перечитан один раз, экран не закрылся и не прыгнул к списку (тесты — задачи 3 и 4).
5. Хост перезапустили посреди хода Codex — лента сеется из журнала без дублей, недописанный ход закрыт чертой «Interrupted», как у Claude (`closeBrokenTurn`) (тест — задача 14).

## Отступления от спеки (сознательные)

- `item_completed` `Plan` пропускается как незнакомый тип: в журналах пользователя он не встречен. «Steps» у Codex — по вложенному вызову `update_plan` (вход `plan[].step`), если он есть.
- Сжатие контекста — заметка только по `item_completed` `ContextCompaction`; верхнеуровневая запись `compacted` пропускается, чтобы не было двух заметок на одно сжатие.
- Effort в подписи тулбара Codex — из карты сессии (`WorkSession.effort`), как у Claude; `turn_context.effort` не читается.
- «Ранняя история только в терминале» — элемент `error` с кодом `codex-history-in-terminal`, а не новый тип заметки: форма элементов не меняется, `FEED_SCHEMA_VERSION` прежний.
- Журнал Codex ещё не найден — лента просто пустая (ввод работает), без заметки «Codex log not found yet»: сев повторяется на каждом изменении индекса журналов, и заметка исчезала бы через секунды.

## Карта файлов

| Файл | Отвечает за | Задачи |
|---|---|---|
| `packages/desktop/src/renderer/agents/agents-model.ts` (новый) | чистые функции панели: строки, этапы, поиск агента | 1 |
| `packages/desktop/src/renderer/agents/AgentsPanel.tsx` (новый) | контейнер вкладки и список агентов | 2 |
| `packages/desktop/src/renderer/agents/AgentDetail.tsx` (новый) | экран одного агента | 4 |
| `packages/desktop/src/renderer/agents/open-agents.ts` (новый) | входы в панель из тулбара и поповера | 5 |
| `packages/desktop/src/renderer/chat/transcript.ts` (новый) | загрузка и живое обновление транскрипта агента | 3 |
| `packages/core/src/feed/codex/rollout-record.ts` (новый) | разбор строки журнала Codex | 10 |
| `packages/core/src/feed/codex/unified-diff.ts` (новый) | unified diff → `FeedPatchHunk[]` | 10 |
| `packages/core/src/feed/codex/apply-codex.ts` (новый) | записи журнала → элементы ленты (основной тред) | 11 |
| `packages/core/src/feed/codex/codex-agents.ts` (новый) | агенты Codex: карточки, вложенные вызовы, сведения из журнала агента | 12 |
| `packages/core/src/feed/codex/apply-codex-hook.ts` (новый) | хуки Codex → элементы ленты | 18 |
| `packages/host/src/feed/codex-source.ts` (новый) | чтение журнала Codex хвостом (позиция, неполные строки) | 13 |
| `packages/host/src/feed/codex-hook-bin.ts` (новый) | мост хука Codex: stdin → приёмник → stdout | 19 |
| `packages/host/src/feed/codex-hook-launcher.ts` (новый) | запускатель `PARLEY_HOME/bin/parley-codex-hook` | 19 |
| `packages/desktop/e2e/agents-panel.spec.ts`, `codex-chat.spec.ts` (новые) | E2E | 6, 17, 22 |

## Задачи

### Task 0: Подготовка рабочей копии

**Files:** нет изменений в коде.

- [ ] **Step 1: Установить зависимости**

Run: `cd /Users/kalmbik61/Desktop/MY/my_harnas/.claude/worktrees/agents-panel-codex-chat && pnpm install`
Expected: установка без ошибок (`postinstall` чинит права `node-pty`).

- [ ] **Step 2: Собрать пакеты и снять базовый прогон**

Run: `pnpm build && pnpm -C packages/core test && pnpm -C packages/protocol test && pnpm -C packages/host test && pnpm -C packages/desktop test`
Expected: всё зелёное. Упавшие тесты записать в `/private/tmp/…/scratchpad/baseline-failures.txt` (scratchpad сессии) — это базовая линия: их не чинить в рамках плана.

### Часть A. Панель агентов (только окно)

### Task 1: Модель панели агентов

**Files:**
- Create: `packages/desktop/src/renderer/agents/agents-model.ts`
- Test: `packages/desktop/src/renderer/agents/agents-model.test.ts`

**Interfaces:**
- Consumes: `toolHeadline(name, input): ToolHeadline` и тип `ToolHeadline` из `packages/desktop/src/renderer/chat/feed-model.ts:54`; типы `FeedAgent`, `FeedAgentStatus`, `FeedItem` из `@parley/core`.
- Produces:
```ts
export interface AgentRow {
  itemId: string;            // id карточки `agent` в ленте
  agentId: string | null;    // null — агент ещё не привязан (до SubagentStart)
  title: string | null;      // описание, иначе тип; null — ни того, ни другого
  type: string | null;
  model: string | null;
  status: FeedAgentStatus;
  background: boolean;
  toolCount: number;
  startedAt: string;         // `at` карточки
  durationMs: number | null; // у закончившего
  step: ToolHeadline | null; // строка последнего вложенного вызова
}
export interface AgentGroups { running: AgentRow[]; finished: AgentRow[] }
export type AgentPick = { by: 'item'; id: string } | { by: 'agent'; id: string };
export interface AgentStep { text: string; status: 'pending' | 'in_progress' | 'completed' }
export function agentRows(items: readonly FeedItem[]): AgentGroups;
export function agentSteps(agent: FeedAgent): AgentStep[] | null;
export function findAgent(items: readonly FeedItem[], pick: AgentPick): FeedAgent | null;
```

- [ ] **Step 1: Написать падающие тесты**

```ts
// packages/desktop/src/renderer/agents/agents-model.test.ts
import { describe, expect, it } from 'vitest';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import { agentRows, agentSteps, findAgent } from './agents-model.js';

const AT = '2026-10-07T10:00:00.000Z';
const LONG_PATH = `/Users/someone/projects/${'very-long-directory-name/'.repeat(5)}feed/types.ts`;

function agent(over: Partial<FeedAgent> = {}): FeedAgent {
  return {
    id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore',
    description: 'Найти все вызовы FeedAgent', prompt: 'Найди все вызовы', model: 'haiku', background: false,
    status: 'running', toolCount: 0, children: [], ...over,
  };
}
function child(id: string, name: string, input: Record<string, unknown>): FeedTool {
  return { id: `tool:${id}`, at: AT, kind: 'tool', toolUseId: id, name, input, status: 'done', agentId: 'a1' };
}

describe('agentRows', () => {
  it('работающие и закончившие — отдельными группами, в порядке ленты', () => {
    const items: FeedItem[] = [
      agent({ id: 'agent:t1', toolUseId: 't1', status: 'done', durationMs: 5000 }),
      agent({ id: 'agent:t2', toolUseId: 't2', agentId: 'a2' }),
      agent({ id: 'agent:t3', toolUseId: 't3', agentId: 'a3', status: 'failed' }),
      agent({ id: 'agent:t4', toolUseId: 't4', agentId: 'a4' }),
    ];
    const groups = agentRows(items);
    expect(groups.running.map((row) => row.itemId)).toEqual(['agent:t2', 'agent:t4']);
    expect(groups.finished.map((row) => row.itemId)).toEqual(['agent:t1', 'agent:t3']);
    expect(groups.finished[0]?.durationMs).toBe(5000);
    expect(groups.running[0]?.durationMs).toBeNull();
  });

  it('текущий шаг — строка последнего вложенного вызова; без вызовов — null', () => {
    const busy = agent({ children: [child('c1', 'Bash', { command: 'ls' }), child('c2', 'Read', { file_path: LONG_PATH })], toolCount: 2 });
    const idle = agent({ id: 'agent:t9', toolUseId: 't9', agentId: 'a9' });
    const [first, second] = agentRows([busy, idle]).running;
    expect(first?.step).toEqual({ name: 'Read', summary: LONG_PATH });
    expect(first?.toolCount).toBe(2);
    expect(second?.step).toBeNull();
  });

  it('заголовок — описание, иначе тип, иначе null', () => {
    const rows = agentRows([
      agent({ id: 'agent:a', toolUseId: 'a' }),
      agent({ id: 'agent:b', toolUseId: 'b', description: null }),
      agent({ id: 'agent:c', toolUseId: 'c', description: null, agentType: null }),
    ]).running;
    expect(rows.map((row) => row.title)).toEqual(['Найти все вызовы FeedAgent', 'Explore', null]);
  });

  it('агент без agentId — среди работающих, agentId null', () => {
    expect(agentRows([agent({ agentId: null })]).running[0]?.agentId).toBeNull();
  });

  it('прочие элементы ленты не дают строк', () => {
    expect(agentRows([{ id: 'p1', at: AT, kind: 'prompt', text: 'hi', images: 0 }])).toEqual({ running: [], finished: [] });
  });
});

describe('agentSteps', () => {
  it('этапы Claude — вход последнего TodoWrite', () => {
    const steps = agentSteps(agent({ children: [
      child('c1', 'TodoWrite', { todos: [{ content: 'старое', status: 'pending' }] }),
      child('c2', 'Bash', { command: 'ls' }),
      child('c3', 'TodoWrite', { todos: [{ content: 'Найти вызовы', status: 'completed' }, { content: 'Проверить тесты', status: 'in_progress' }] }),
    ] }));
    expect(steps).toEqual([{ text: 'Найти вызовы', status: 'completed' }, { text: 'Проверить тесты', status: 'in_progress' }]);
  });

  it('этапы Codex — вход update_plan (plan[].step)', () => {
    const steps = agentSteps(agent({ children: [child('c1', 'update_plan', { plan: [{ step: 'Прочитать журнал', status: 'completed' }] })] }));
    expect(steps).toEqual([{ text: 'Прочитать журнал', status: 'completed' }]);
  });

  it('без TodoWrite и update_plan — null; незнакомый статус — pending; пустой текст пропускается', () => {
    expect(agentSteps(agent({ children: [child('c1', 'Bash', { command: 'ls' })] }))).toBeNull();
    expect(agentSteps(agent({ children: [child('c1', 'TodoWrite', { todos: [{ content: 'a', status: 'blocked' }, { content: '', status: 'pending' }] })] })))
      .toEqual([{ text: 'a', status: 'pending' }]);
  });
});

describe('findAgent', () => {
  it('по id карточки и по agentId; нет — null', () => {
    const items = [agent(), agent({ id: 'agent:t2', toolUseId: 't2', agentId: 'a2' })];
    expect(findAgent(items, { by: 'item', id: 'agent:t2' })?.agentId).toBe('a2');
    expect(findAgent(items, { by: 'agent', id: 'a1' })?.id).toBe('agent:t1');
    expect(findAgent(items, { by: 'agent', id: 'nope' })).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/agents/agents-model.test.ts`
Expected: FAIL — `Failed to resolve import "./agents-model.js"`.

- [ ] **Step 3: Реализация**

```ts
// packages/desktop/src/renderer/agents/agents-model.ts
/**
 * Модель панели агентов (спека 2026-10-07, 5.1): строки по карточкам `agent` ленты сессии — работающие и закончившие
 * отдельно, в порядке ленты; текущий шаг — строка последнего вложенного вызова; этапы — последний `TodoWrite` (Claude)
 * или `update_plan` (Codex). Ни React, ни моста — только элементы ленты.
 */

import type { FeedAgent, FeedAgentStatus, FeedItem } from '@parley/core';
import { toolHeadline, type ToolHeadline } from '../chat/feed-model.js';

export interface AgentRow {
  itemId: string;
  agentId: string | null;
  title: string | null;
  type: string | null;
  model: string | null;
  status: FeedAgentStatus;
  background: boolean;
  toolCount: number;
  startedAt: string;
  durationMs: number | null;
  step: ToolHeadline | null;
}

export interface AgentGroups {
  running: AgentRow[];
  finished: AgentRow[];
}

/** Какой агент открыт на экране: по id карточки (из списка) или по `agentId` (из поповера). */
export type AgentPick = { by: 'item'; id: string } | { by: 'agent'; id: string };

export interface AgentStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const isAgent = (item: FeedItem): item is FeedAgent => item.kind === 'agent';

function rowOf(agent: FeedAgent): AgentRow {
  const last = agent.children[agent.children.length - 1];
  return {
    itemId: agent.id,
    agentId: agent.agentId,
    title: agent.description ?? agent.agentType,
    type: agent.agentType,
    model: agent.model,
    status: agent.status,
    background: agent.background,
    toolCount: agent.toolCount,
    startedAt: agent.at,
    durationMs: agent.durationMs ?? null,
    step: last === undefined ? null : toolHeadline(last.name, last.input),
  };
}

export function agentRows(items: readonly FeedItem[]): AgentGroups {
  const running: AgentRow[] = [];
  const finished: AgentRow[] = [];
  for (const item of items) {
    if (!isAgent(item)) continue;
    (item.status === 'running' ? running : finished).push(rowOf(item));
  }
  return { running, finished };
}

const STEP_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function stepsOf(list: unknown, textKey: 'content' | 'step'): AgentStep[] | null {
  if (!Array.isArray(list)) return null;
  const steps: AgentStep[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = record[textKey];
    if (typeof text !== 'string' || text === '') continue;
    const status = typeof record['status'] === 'string' && STEP_STATUSES.has(record['status']) ? (record['status'] as AgentStep['status']) : 'pending';
    steps.push({ text, status });
  }
  return steps.length === 0 ? null : steps;
}

export function agentSteps(agent: FeedAgent): AgentStep[] | null {
  for (let at = agent.children.length - 1; at >= 0; at -= 1) {
    const call = agent.children[at]!;
    if (call.name === 'TodoWrite') return stepsOf(call.input['todos'], 'content');
    if (call.name === 'update_plan') return stepsOf(call.input['plan'], 'step');
  }
  return null;
}

export function findAgent(items: readonly FeedItem[], pick: AgentPick): FeedAgent | null {
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]!;
    if (!isAgent(item)) continue;
    if (pick.by === 'item' ? item.id === pick.id : item.agentId === pick.id) return item;
  }
  return null;
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/agents/agents-model.test.ts`
Expected: PASS (все тесты файла).

- [ ] **Step 5: Коммит**

```bash
git add packages/desktop/src/renderer/agents/agents-model.ts packages/desktop/src/renderer/agents/agents-model.test.ts
git commit -m "feat(desktop): модель панели агентов — строки, текущий шаг, этапы" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Вкладка «Agents» и список агентов

**Files:**
- Modify: `packages/desktop/src/shared/ui-types.ts:24` (тип `tab`), `:121-131` (`normalizeRightSidebar`)
- Modify: `packages/desktop/src/renderer/store/ui.ts:181` (тип `patch.tab` в `setSidebar`)
- Modify: `packages/desktop/src/renderer/palette/actions.ts:58` (тип `showRightTab`), `:152-165` (`needsActiveWork`), `:227-232` (ветка `sidebar.agents`)
- Modify: `packages/desktop/src/renderer/shell/AppShell.tsx:492-498` (только тип аргумента, если он объявлен явно)
- Modify: `packages/desktop/src/shared/keybindings.ts:11-27` (`ActionId`), `:68-69` (запись `sidebar.agents`)
- Modify: `packages/desktop/src/renderer/keys/handler.ts:17` (`IMPLEMENTED_ACTIONS`)
- Modify: `packages/desktop/src/shared/strings.ts` (`S.actions.showAgents`, `S.agentsPanel`)
- Modify: `packages/desktop/src/renderer/chat/ui-store.ts` (выбор агента и раскрытие «Finished»)
- Modify: `packages/desktop/src/renderer/shell/RightSidebar.tsx:57-102`
- Create: `packages/desktop/src/renderer/agents/AgentsPanel.tsx`
- Test: `packages/desktop/src/shared/ui-types.test.ts`, `packages/desktop/src/renderer/agents/AgentsPanel.test.tsx`, `packages/desktop/src/renderer/shell/RightSidebar.test.tsx`, `packages/desktop/src/renderer/chat/ui-store.test.ts`, `packages/desktop/src/renderer/layout/store.test.ts`

**Interfaces:**
- Consumes: `agentRows`, `AgentRow`, `AgentPick` (задача 1); `focusedSessionOf(state, workKey)` (`layout/store.ts:111`); `useFeedAvailability()` (`lib/feed-view.ts:140`); `FeedSubscription` и `useFeed` (`chat/use-feed.ts`); `useActivityStore((s) => s.byRef)` (`store/activity.ts:14`, ключ — `refKey(ref)`); `formatDuration` (`lib/metrics-line.ts:14`); `useNow` (`lib/use-now.ts:10`).
- Produces:
```ts
// shared/ui-types.ts
export type RightSidebarTab = 'files' | 'changes' | 'agents';
// chat/ui-store.ts — новые поля и действия ChatUiState
agentPanel: Record<string /* refKey сессии */, AgentPick | null>;
finishedOpen: Record<string, boolean>;
selectAgent(sessionKey: string, pick: AgentPick | null): void;
setFinishedOpen(sessionKey: string, open: boolean): void;
// agents/AgentsPanel.tsx
export function AgentsPanel(props: { bridge: ParleyBridge; entry: WorkEntry }): JSX.Element;
export function AgentsPanelView(props: AgentsPanelViewProps): JSX.Element;
export interface AgentsPanelViewProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  hasFeed: boolean;              // у сессии есть вид Chat — можно провалиться в агента
  tasks: readonly LiveTask[];    // живые субагенты из метрик — для сессии без ленты
}
```
Экран агента (`AgentDetail`) появится в задаче 4; здесь `AgentsPanelView` при выбранном агенте показывает только список — строка списка уже ставит выбор (`selectAgent`).

- [ ] **Step 1: Тест нормализации вкладки**

```ts
// добавить в packages/desktop/src/shared/ui-types.test.ts
it('вкладка правого сайдбара agents сохраняется; незнакомая читается как files', () => {
  expect(normalizeUi({ rightSidebar: { open: true, width: 320, tab: 'agents' } }).rightSidebar.tab).toBe('agents');
  expect(normalizeUi({ rightSidebar: { open: true, width: 320, tab: 'terminal' } }).rightSidebar.tab).toBe('files');
});
```

- [ ] **Step 2: Тест выбора агента в ui-store**

```ts
// добавить в packages/desktop/src/renderer/chat/ui-store.test.ts
it('выбор агента и раскрытие Finished — по сессии', () => {
  resetChatUiStoreForTests();
  const store = useChatUiStore.getState();
  store.selectAgent('s1', { by: 'agent', id: 'a1' });
  store.setFinishedOpen('s1', true);
  expect(useChatUiStore.getState().agentPanel['s1']).toEqual({ by: 'agent', id: 'a1' });
  expect(useChatUiStore.getState().agentPanel['s2']).toBeUndefined();
  expect(useChatUiStore.getState().finishedOpen['s1']).toBe(true);
  useChatUiStore.getState().selectAgent('s1', null);
  expect(useChatUiStore.getState().agentPanel['s1']).toBeNull();
});
```

- [ ] **Step 3: Тесты списка панели**

```tsx
// packages/desktop/src/renderer/agents/AgentsPanel.test.tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { useFeedStore } from '../chat/store.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../chat/ui-store.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { AgentsPanelView } from './AgentsPanel.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-07T10:00:00.000Z';
const LONG = 'Найти все места, где карточка агента рисуется в ленте, и проверить, что длинные описания не ломают строку';

function agent(over: Partial<FeedAgent>): FeedAgent {
  return { id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore', description: LONG,
    prompt: 'p', model: 'haiku', background: false, status: 'running', toolCount: 0, children: [], ...over };
}
const bash: FeedTool = { id: 'tool:c1', at: AT, kind: 'tool', toolUseId: 'c1', name: 'Bash', input: { command: 'rg FeedAgent packages' }, status: 'running', agentId: 'a1' };

function withFeed(items: FeedItem[]): void {
  useFeedStore.setState({ feeds: { [refKey(REF)]: { items, revision: 1, mode: null, status: 'ready' } } });
}

beforeEach(() => resetChatUiStoreForTests());
afterEach(() => { cleanup(); useFeedStore.setState({ feeds: {} }); });

describe('AgentsPanelView', () => {
  it('работающие с текущим шагом; закончившие — свёрнутым блоком Finished (n)', () => {
    withFeed([
      agent({ children: [bash], toolCount: 1 }),
      agent({ id: 'agent:t2', toolUseId: 't2', agentId: 'a2', status: 'done', durationMs: 4000, description: 'Готовый' }),
    ]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    const running = screen.getAllByTestId('agents-row-running');
    expect(running).toHaveLength(1);
    expect(within(running[0]!).getByText(LONG)).toBeTruthy();
    expect(within(running[0]!).getByText('rg FeedAgent packages')).toBeTruthy();
    expect(screen.queryByText('Готовый')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.finished(1) }));
    expect(screen.getByText('Готовый')).toBeTruthy();
    expect(useChatUiStore.getState().finishedOpen[refKey(REF)]).toBe(true);
  });

  it('клик по строке выбирает агента по id карточки', () => {
    withFeed([agent({})]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    fireEvent.click(screen.getByTestId('agents-row-running'));
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toEqual({ by: 'item', id: 'agent:t1' });
  });

  it('агент без agentId — «Starting…»', () => {
    withFeed([agent({ agentId: null })]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    expect(screen.getByText(S.agentsPanel.starting)).toBeTruthy();
  });

  it('нет агентов — пустое состояние', () => {
    withFeed([]);
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed tasks={[]} />);
    expect(screen.getByText(S.agentsPanel.empty)).toBeTruthy();
  });

  it('сессия без ленты — список из метрик без провала и строка про Chat', () => {
    render(<AgentsPanelView bridge={createFakeBridge()} sessionRef={REF} hasFeed={false}
      tasks={[{ id: 'a1', agentType: 'Explore', description: LONG, background: true }]} />);
    expect(screen.getByText(LONG)).toBeTruthy();
    expect(screen.getByText(S.agentsPanel.needsChat)).toBeTruthy();
    expect(screen.queryByTestId('agents-row-running')).toBeNull();
  });
});
```

- [ ] **Step 4: Тест вкладки в сайдбаре**

Открыть `packages/desktop/src/renderer/shell/RightSidebar.test.tsx`, взять его способ отрисовки `RightSidebar` и добавить:

```tsx
it('вкладка Agents: третья кнопка, выбор пишет tab agents, панель — AgentsPanel', () => {
  // отрисовка — как в соседних тестах этого файла
  fireEvent.click(screen.getByRole('tab', { name: S.agentsPanel.tab }));
  expect(useUiStore.getState().ui.rightSidebar.tab).toBe('agents');
  expect(screen.getByTestId('agents-panel')).toBeTruthy();
});
```

- [ ] **Step 5: Тест «фокус ушёл на комнату — сессия панели прежняя» (Review Focus 3)**

В `packages/desktop/src/renderer/layout/store.test.ts` рядом с тестами `focusedSessionOf` (около строки 231) взять их способ построения раскладки и добавить тест: две вкладки в одной группе — терминал `s-02` и вкладка комнаты; история фокуса `[терминал s-02, комната]`; активна комната.

```ts
expect(focusedSessionOf(state, WORK_KEY)).toBe('s-02');
```

Если такой тест в файле уже есть — шаг пропустить и написать в коммите, какой тест это покрывает.

- [ ] **Step 6: Прогнать — падают**

Run: `pnpm --filter "@parley/desktop^..." build && pnpm -C packages/desktop exec vitest run src/shared/ui-types.test.ts src/renderer/chat/ui-store.test.ts src/renderer/agents src/renderer/shell/RightSidebar.test.tsx src/renderer/layout/store.test.ts`
Expected: FAIL — нет `agentPanel`, `AgentsPanel`, `S.agentsPanel`, вкладки `agents`.

- [ ] **Step 7: Тип вкладки и нормализация**

```ts
// packages/desktop/src/shared/ui-types.ts
export type RightSidebarTab = 'files' | 'changes' | 'agents';
// в UiFile:
  rightSidebar: { open: boolean; width: number; tab: RightSidebarTab };
// в normalizeRightSidebar:
  const tab =
    source.tab === 'files' || source.tab === 'changes' || source.tab === 'agents' ? source.tab : DEFAULT_UI.rightSidebar.tab;
```
В `store/ui.ts:181` `patch: { open?: boolean; width?: number; tab?: RightSidebarTab }`; в `palette/actions.ts:58` `showRightTab(tab: RightSidebarTab): void`; в `AppShell.tsx:492` тип аргумента — тот же, если он объявлен явно.

- [ ] **Step 8: Тексты окна**

```ts
// packages/desktop/src/shared/strings.ts — S.actions рядом с showChanges
    showAgents: 'Show agents',
// новый раздел верхнего уровня S
  agentsPanel: {
    tab: 'Agents',
    noSession: 'Open a session to see its agents',
    empty: 'No agents in this session yet',
    finished: (count: number): string => `Finished (${count})`,
    starting: 'Starting…',
    thinking: 'Thinking…',
    needsChat: 'Agent details need the Chat view of this session',
    back: 'All agents',
    task: 'Task',
    steps: 'Steps',
    activity: 'Activity',
    result: 'Result',
    showAll: 'Show all',
    showLess: 'Show less',
    fullTranscript: 'Full transcript',
    hideTranscript: 'Hide transcript',
    showInChat: 'Show in chat',
    noActivity: 'No tool calls yet',
    gone: 'This agent is no longer in the feed',
  },
```

- [ ] **Step 9: Выбор агента в ui-store**

```ts
// packages/desktop/src/renderer/chat/ui-store.ts — в ChatUiState
  /** Экран агента в панели Agents по сессии (`refKey`); `null` — список (спека 2026-10-07, 5.1). */
  agentPanel: Record<string, AgentPick | null>;
  /** Раскрыт ли блок «Finished» панели по сессии. */
  finishedOpen: Record<string, boolean>;
  selectAgent(sessionKey: string, pick: AgentPick | null): void;
  setFinishedOpen(sessionKey: string, open: boolean): void;
// в create(...) и в resetChatUiStoreForTests — начальные {} и действия:
  agentPanel: {},
  finishedOpen: {},
  selectAgent: (sessionKey, pick) => set((state) => ({ agentPanel: { ...state.agentPanel, [sessionKey]: pick } })),
  setFinishedOpen: (sessionKey, open) => set((state) => ({ finishedOpen: { ...state.finishedOpen, [sessionKey]: open } })),
```
Импорт: `import type { AgentPick } from '../agents/agents-model.js';`.

- [ ] **Step 10: Панель**

```tsx
// packages/desktop/src/renderer/agents/AgentsPanel.tsx
/**
 * Вкладка «Agents» правого сайдбара (спека 2026-10-07, 5.1): агенты сессии `focusedSessionOf` — работающие с текущим
 * шагом, ниже свёрнутое «Finished (n)». У сессии с видом Chat панель сама держит подписку на её ленту (`FeedSubscription`;
 * подписки со счётчиком) и строит строки по карточкам `agent`; клик по строке — экран агента (выбор в `ui-store.ts`).
 * У сессии без вида Chat — список из `LiveMetrics.tasks` без провала внутрь.
 */

import { Bot, ChevronRight, LoaderCircle } from 'lucide-react';
import type { WorkEntry } from '@parley/core';
import { refKey, type LiveTask, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { FeedSubscription, useFeed } from '../chat/use-feed.js';
import { useChatUiStore } from '../chat/ui-store.js';
import { focusedSessionOf, useLayoutStore } from '../layout/store.js';
import { useFeedAvailability } from '../lib/feed-view.js';
import { formatDuration } from '../lib/metrics-line.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useNow } from '../lib/use-now.js';
import { useActivityStore } from '../store/activity.js';
import { agentRows, type AgentRow } from './agents-model.js';

export interface AgentsPanelProps {
  bridge: ParleyBridge;
  entry: WorkEntry;
}

export function AgentsPanel({ bridge, entry }: AgentsPanelProps): JSX.Element {
  const workKey = workKeyOf(entry.projectPath, entry.map.work.id);
  const sessionId = useLayoutStore((state) => focusedSessionOf(state, workKey));
  const availability = useFeedAvailability();
  const byRef = useActivityStore((state) => state.byRef);
  const session = sessionId === null ? undefined : entry.map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    return (
      <div data-testid="agents-panel" className="px-1 text-sm text-muted-foreground">
        {S.agentsPanel.noSession}
      </div>
    );
  }
  const sessionRef: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
  const tasks = session.lifecycle === 'active' ? (byRef[refKey(sessionRef)]?.metrics?.tasks ?? []) : [];
  return (
    <AgentsPanelView
      key={session.id}
      bridge={bridge}
      sessionRef={sessionRef}
      hasFeed={availability(session.provider) === true}
      tasks={tasks}
    />
  );
}

export interface AgentsPanelViewProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  hasFeed: boolean;
  tasks: readonly LiveTask[];
}

export function AgentsPanelView({ sessionRef, hasFeed, tasks }: AgentsPanelViewProps): JSX.Element {
  const key = refKey(sessionRef);
  const feed = useFeed(sessionRef);
  const finishedOpen = useChatUiStore((state) => state.finishedOpen[key] ?? false);
  const select = useChatUiStore((state) => state.selectAgent);
  const setFinishedOpen = useChatUiStore((state) => state.setFinishedOpen);

  if (!hasFeed) {
    return (
      <div data-testid="agents-panel" className="flex min-h-0 flex-col gap-2 overflow-y-auto px-1">
        {tasks.length === 0 ? <p className="text-sm text-muted-foreground">{S.agentsPanel.empty}</p> : null}
        {tasks.map((task) => (
          <div key={task.id} className="flex min-w-0 items-center gap-2 text-sm">
            <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{task.description ?? task.agentType ?? S.chat.agent.fallbackTitle}</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">{S.agentsPanel.needsChat}</p>
      </div>
    );
  }

  const { running, finished } = agentRows(feed?.items ?? []);
  return (
    <div data-testid="agents-panel" className="flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
      <FeedSubscription sessionRef={sessionRef} />
      {running.length === 0 && finished.length === 0 ? <p className="text-sm text-muted-foreground">{S.agentsPanel.empty}</p> : null}
      {running.map((row) => (
        <AgentRowButton key={row.itemId} row={row} testId="agents-row-running" onOpen={() => select(key, { by: 'item', id: row.itemId })} />
      ))}
      {finished.length > 0 ? (
        <button
          type="button"
          aria-expanded={finishedOpen}
          className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setFinishedOpen(key, !finishedOpen)}
        >
          <ChevronRight className={finishedOpen ? 'size-3 rotate-90' : 'size-3'} aria-hidden="true" />
          {S.agentsPanel.finished(finished.length)}
        </button>
      ) : null}
      {finishedOpen
        ? finished.map((row) => (
            <AgentRowButton key={row.itemId} row={row} testId="agents-row-finished" onOpen={() => select(key, { by: 'item', id: row.itemId })} />
          ))
        : null}
    </div>
  );
}

function AgentRowButton({ row, testId, onOpen }: { row: AgentRow; testId: string; onOpen: () => void }): JSX.Element {
  const now = useNow(1000);
  const running = row.status === 'running';
  const elapsed = running ? now.getTime() - Date.parse(row.startedAt) : row.durationMs;
  const step = row.agentId === null ? S.agentsPanel.starting : row.step === null ? S.agentsPanel.thinking : (row.step.summary ?? row.step.name);
  const meta = [row.type, row.model, S.chat.agent.toolCalls(row.toolCount), formatDuration(elapsed)].filter((part) => part !== null && part !== '');
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onOpen}
      className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/7"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : <Bot className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 truncate font-medium">{row.title ?? S.chat.agent.fallbackTitle}</span>
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{step}</span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{meta.join(' · ')}</span>
    </button>
  );
}
```

- [ ] **Step 11: Вкладка в сайдбаре**

```tsx
// packages/desktop/src/renderer/shell/RightSidebar.tsx
const TABS = [
  { tab: 'files', label: S.files.panel },
  { tab: 'changes', label: S.changes.panel },
  { tab: 'agents', label: S.agentsPanel.tab },
] as const;
// выбор панели:
        {entry === undefined ? null : current === 'changes' ? (
          <ChangesPanel bridge={bridge} workKey={workKey} entry={entry} sendDeps={sendDeps} />
        ) : current === 'agents' ? (
          <AgentsPanel key={workKey} bridge={bridge} entry={entry} />
        ) : (
          <FilesPanel key={workKey} bridge={bridge} entry={entry} />
        )}
```
В шапку файла — строка: «вкладка Agents (спека 2026-10-07, 5.1) — агенты сессии `focusedSessionOf`». Дописать в шапку `AgentsPanel` нечего — она уже описана.

- [ ] **Step 12: Действие `sidebar.agents` (⌘⇧A)**

```ts
// packages/desktop/src/shared/keybindings.ts — ActionId: добавить | 'sidebar.agents' рядом с 'sidebar.changes'
// ACTIONS — сразу после записи sidebar.changes:
  { id: 'sidebar.agents', title: S.actions.showAgents, keywords: ['agents', 'subagents', 'tasks'], keys: 'CmdOrCtrl+Shift+A', menu: 'view', when: 'always', inPalette: true },
// packages/desktop/src/renderer/keys/handler.ts — IMPLEMENTED_ACTIONS: 'sidebar.agents' после 'sidebar.changes'
// packages/desktop/src/renderer/palette/actions.ts — needsActiveWork: || id === 'sidebar.agents'
// runAction:
    case 'sidebar.agents':
      ctx.ui.showRightTab('agents');
      return;
```
Если в репо есть тест реестра клавиш, который сверяет полный список (`keybindings.test.ts`) — обновить ожидание.

- [ ] **Step 13: Прогнать тесты и typecheck**

Run: `pnpm -C packages/desktop exec vitest run src/shared src/renderer/chat/ui-store.test.ts src/renderer/agents src/renderer/shell src/renderer/layout src/renderer/keys src/renderer/palette && pnpm -C packages/desktop typecheck`
Expected: PASS; typecheck — exit 0.

- [ ] **Step 14: Коммит**

```bash
git add packages/desktop/src
git commit -m "feat(desktop): вкладка Agents правого сайдбара — агенты активной сессии, ⌘⇧A" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Транскрипт агента — общая загрузка и живое обновление

**Files:**
- Create: `packages/desktop/src/renderer/chat/transcript.ts`
- Modify: `packages/desktop/src/renderer/chat/items/AgentItem.tsx:31-86` (типы `Transcript`, `TranscriptUpdate`, `TRANSCRIPT_TAIL` переезжают в `transcript.ts`; `toggleTranscript` зовёт `requestTranscript`; живое обновление — `useLiveTranscript`)
- Modify: `packages/desktop/src/renderer/chat/FeedList.tsx` (импорт типов из нового места)
- Test: `packages/desktop/src/renderer/chat/transcript.test.ts`, существующий `packages/desktop/src/renderer/chat/items/items.test.tsx` (должен остаться зелёным)

**Interfaces:**
- Produces:
```ts
export const TRANSCRIPT_TAIL = 200;
export type Transcript = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: FeedItem[] };
export type TranscriptUpdate = (was: Transcript | null) => Transcript | null;
/** Загрузить ленту агента; уже показанный транскрипт при перечитывании не мигает «loading». */
export function requestTranscript(bridge: ParleyBridge, ref: SessionRef, agentId: string, set: (update: TranscriptUpdate) => void): void;
/** Пока транскрипт показан: перечитывать при росте `toolCount` работающего агента не чаще `periodMs`; на конец агента — один раз. */
export function useLiveTranscript(agent: Pick<FeedAgent, 'agentId' | 'status' | 'toolCount'>, shown: boolean, reload: () => void, periodMs?: number): void;
```
- Consumes: `bridge.call('feed.snapshot', { ref, agentId })` → `{ items }`.

- [ ] **Step 1: Падающие тесты**

```ts
// packages/desktop/src/renderer/chat/transcript.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { requestTranscript, useLiveTranscript, type Transcript, type TranscriptUpdate } from './transcript.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const ITEMS: FeedItem[] = [{ id: 'p', at: '2026-10-07T10:00:00.000Z', kind: 'prompt', text: 'go', images: 0 }];

function holder(initial: Transcript | null) {
  let value = initial;
  return { get: () => value, set: (update: TranscriptUpdate) => { value = update(value); } };
}

afterEach(() => vi.useRealTimers());

describe('requestTranscript', () => {
  it('впервые — loading, потом ready', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('feed.snapshot', () => ({ items: ITEMS, revision: 0, schemaVersion: 2, mode: null }));
    const box = holder(null);
    requestTranscript(bridge, REF, 'a1', box.set);
    expect(box.get()).toEqual({ state: 'loading' });
    await vi.waitFor(() => expect(box.get()).toEqual({ state: 'ready', items: ITEMS }));
  });

  it('перечитывание показанного не мигает loading, а ошибка оставляет прежние элементы', async () => {
    const bridge = createFakeBridge(); // без обработчика — вызов отклоняется
    const box = holder({ state: 'ready', items: ITEMS });
    requestTranscript(bridge, REF, 'a1', box.set);
    expect(box.get()).toEqual({ state: 'ready', items: ITEMS });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.get()).toEqual({ state: 'ready', items: ITEMS });
  });

  it('скрытый (null) пока шёл запрос — не воскресает', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('feed.snapshot', () => ({ items: ITEMS, revision: 0, schemaVersion: 2, mode: null }));
    const box = holder(null);
    requestTranscript(bridge, REF, 'a1', box.set);
    box.set(() => null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(box.get()).toBeNull();
  });
});

describe('useLiveTranscript', () => {
  it('рост toolCount у работающего — перечитать, но не чаще раза в 3 с; конец агента — ещё раз', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const { rerender } = renderHook(({ count, status }) => useLiveTranscript({ agentId: 'a1', status, toolCount: count }, true, reload), {
      initialProps: { count: 1, status: 'running' as const },
    });
    rerender({ count: 2, status: 'running' });
    expect(reload).toHaveBeenCalledTimes(1);
    rerender({ count: 3, status: 'running' });
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(reload).toHaveBeenCalledTimes(2);
    rerender({ count: 3, status: 'done' });
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('транскрипт скрыт — не перечитывать', () => {
    const reload = vi.fn();
    const { rerender } = renderHook(({ count }) => useLiveTranscript({ agentId: 'a1', status: 'running', toolCount: count }, false, reload), {
      initialProps: { count: 1 },
    });
    rerender({ count: 2 });
    expect(reload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/chat/transcript.test.ts`
Expected: FAIL — нет `./transcript.js`.

- [ ] **Step 3: Реализация**

```ts
// packages/desktop/src/renderer/chat/transcript.ts
/**
 * Транскрипт субагента — его лента `feed.snapshot { ref, agentId }` (план 2026-10-01, кусок 4b; панель агентов,
 * спека 2026-10-07, 5.1). Общий для карточки в ленте и экрана агента в панели. Состояние держит вызывающий (лента — по
 * `id` карточки, чтобы пережить размонтирование строки виртуальным списком). Показанный транскрипт перечитывается без
 * «loading», а ошибка перечитывания оставляет прежние элементы. Пока агент работает и транскрипт показан, он
 * перечитывается при росте `toolCount` не чаще `periodMs`; на конец агента — ещё раз.
 */

import { useEffect, useRef } from 'react';
import type { FeedAgent, FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

/** Сколько последних элементов транскрипта показывается. */
export const TRANSCRIPT_TAIL = 200;

export type Transcript = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: FeedItem[] };

/** Обновление транскрипта; `null` — свёрнут. */
export type TranscriptUpdate = (was: Transcript | null) => Transcript | null;

export function requestTranscript(bridge: ParleyBridge, ref: SessionRef, agentId: string, set: (update: TranscriptUpdate) => void): void {
  set((was) => (was?.state === 'ready' ? was : { state: 'loading' }));
  bridge.call('feed.snapshot', { ref, agentId }).then(
    (snapshot) => set((was) => (was === null ? was : { state: 'ready', items: snapshot.items })),
    (error: unknown) => {
      console.warn('[parley] feed.snapshot agent', decodeIpcError(error).message);
      set((was) => (was === null || was.state === 'ready' ? was : { state: 'error' }));
    },
  );
}

export function useLiveTranscript(
  agent: Pick<FeedAgent, 'agentId' | 'status' | 'toolCount'>,
  shown: boolean,
  reload: () => void,
  periodMs = 3000,
): void {
  const seen = useRef({ count: agent.toolCount, status: agent.status });
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const was = seen.current;
    seen.current = { count: agent.toolCount, status: agent.status };
    if (!shown || agent.agentId === null) return;
    if (was.status === 'running' && agent.status !== 'running') {
      clearTimeout(timer.current);
      timer.current = undefined;
      lastAt.current = Date.now();
      reloadRef.current();
      return;
    }
    if (agent.status !== 'running' || agent.toolCount === was.count || timer.current !== undefined) return;
    const wait = lastAt.current + periodMs - Date.now();
    if (wait <= 0) {
      lastAt.current = Date.now();
      reloadRef.current();
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      lastAt.current = Date.now();
      reloadRef.current();
    }, wait);
  }, [agent.agentId, agent.status, agent.toolCount, shown, periodMs]);

  useEffect(() => () => clearTimeout(timer.current), []);
}
```

- [ ] **Step 4: Перевести `AgentItem` на общий модуль**

В `chat/items/AgentItem.tsx`: удалить локальные `TRANSCRIPT_TAIL`, `Transcript`, `TranscriptUpdate` и реэкспортировать их из `../transcript.js` (их импортируют `FeedList.tsx` и тесты). `toggleTranscript` становится:

```tsx
  const reload = (): void => {
    if (item.agentId !== null) requestTranscript(bridge, sessionRef, item.agentId, setTranscript);
  };
  const toggleTranscript = (): void => {
    if (transcript !== null) {
      setTranscript(() => null);
      return;
    }
    reload();
  };
  useLiveTranscript(item, transcript !== null, reload);
```
Шапку файла дополнить: «Транскрипт грузит и обновляет общий `chat/transcript.ts` — он же у экрана агента в панели Agents».

- [ ] **Step 5: Прогнать**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/chat`
Expected: PASS, включая прежние тесты транскрипта в `items.test.tsx`.

- [ ] **Step 6: Коммит**

```bash
git add packages/desktop/src/renderer/chat
git commit -m "feat(desktop): транскрипт агента — общий модуль и живое обновление" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Экран агента в панели

**Files:**
- Create: `packages/desktop/src/renderer/agents/AgentDetail.tsx`
- Modify: `packages/desktop/src/renderer/agents/AgentsPanel.tsx` (`AgentsPanelView`: выбран агент — `AgentDetail`)
- Test: `packages/desktop/src/renderer/agents/AgentDetail.test.tsx`

**Interfaces:**
- Consumes: `findAgent`, `agentSteps`, `AgentPick` (задача 1); `requestTranscript`, `useLiveTranscript`, `TRANSCRIPT_TAIL`, `Transcript` (задача 3); `ToolItem` с `compact` (`chat/items/ToolItem.tsx:23`); `RoomMarkdown` (`components/rooms/RoomMarkdown.tsx:224`, пропсы `text`, `labelOf`, `onOpenExternal`); `openAgentCard(ref, agentId)` (`chat/open-agent.ts:18`); `ChatEnvContext` (`chat/chat-env.ts`) — `ToolItem` и `RoomMarkdown` ждут его.
- Produces:
```ts
export interface AgentDetailProps { bridge: ParleyBridge; sessionRef: SessionRef; items: readonly FeedItem[]; pick: AgentPick; onBack: () => void }
export function AgentDetail(props: AgentDetailProps): JSX.Element;
```

- [ ] **Step 1: Падающие тесты**

```tsx
// packages/desktop/src/renderer/agents/AgentDetail.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FeedAgent, FeedItem, FeedTool } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { AgentDetail } from './AgentDetail.js';

vi.mock('../chat/open-agent.js', () => ({ openAgentCard: vi.fn() }));
import { openAgentCard } from '../chat/open-agent.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const AT = '2026-10-07T10:00:00.000Z';
const PROMPT = Array.from({ length: 20 }, (_, n) => `Строка задания ${n + 1}`).join('\n');
function agent(over: Partial<FeedAgent> = {}): FeedAgent {
  return { id: 'agent:t1', at: AT, kind: 'agent', toolUseId: 't1', agentId: 'a1', agentType: 'Explore', description: 'Найти вызовы',
    prompt: PROMPT, model: 'haiku', background: false, status: 'running', toolCount: 1, children: [], ...over };
}
const call: FeedTool = { id: 'tool:c1', at: AT, kind: 'tool', toolUseId: 'c1', name: 'Bash', input: { command: 'rg FeedAgent' }, status: 'done', agentId: 'a1' };

afterEach(cleanup);

describe('AgentDetail', () => {
  it('шапка, задание свёрнуто до Show all, вызовы, итога у работающего нет', () => {
    render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ children: [call] })]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);
    expect(screen.getByText('Найти вызовы')).toBeTruthy();
    expect(screen.queryByText('Строка задания 20')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.showAll }));
    expect(screen.getByText(/Строка задания 20/)).toBeTruthy();
    expect(screen.getByText('rg FeedAgent')).toBeTruthy();
    expect(screen.queryByText(S.agentsPanel.result)).toBeNull();
  });

  it('этапы из TodoWrite показываются, без них раздела нет', () => {
    const todo: FeedTool = { ...call, id: 'tool:c2', toolUseId: 'c2', name: 'TodoWrite', input: { todos: [{ content: 'Шаг один', status: 'in_progress' }] } };
    const { rerender } = render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ children: [todo] })]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.steps)).toBeTruthy();
    expect(screen.getByText('Шаг один')).toBeTruthy();
    rerender(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ children: [call] })]} pick={{ by: 'item', id: 'agent:t1' }} onBack={() => undefined} />);
    expect(screen.queryByText(S.agentsPanel.steps)).toBeNull();
  });

  it('агент закончил при открытом экране — итог появился, экран остался (Review Focus 4)', () => {
    const { rerender } = render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent()]} pick={{ by: 'agent', id: 'a1' }} onBack={() => undefined} />);
    rerender(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[agent({ status: 'done', result: 'Нашёл 3 места', durationMs: 9000 })]} pick={{ by: 'agent', id: 'a1' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.result)).toBeTruthy();
    expect(screen.getByText('Нашёл 3 места')).toBeTruthy();
    expect(screen.getByRole('button', { name: S.agentsPanel.back })).toBeTruthy();
  });

  it('Full transcript грузит ленту агента; Show in chat ведёт к карточке; назад — onBack', () => {
    const bridge = createFakeBridge();
    bridge.setHandler('feed.snapshot', () => ({ items: [] as FeedItem[], revision: 0, schemaVersion: 2, mode: null }));
    const onBack = vi.fn();
    render(<AgentDetail bridge={bridge} sessionRef={REF} items={[agent()]} pick={{ by: 'item', id: 'agent:t1' }} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.fullTranscript }));
    expect(bridge.calls).toContainEqual({ method: 'feed.snapshot', params: { ref: REF, agentId: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.showInChat }));
    expect(openAgentCard).toHaveBeenCalledWith(REF, 'a1');
    fireEvent.click(screen.getByRole('button', { name: S.agentsPanel.back }));
    expect(onBack).toHaveBeenCalled();
  });

  it('агента больше нет в ленте — строка gone и кнопка назад', () => {
    render(<AgentDetail bridge={createFakeBridge()} sessionRef={REF} items={[]} pick={{ by: 'item', id: 'agent:zz' }} onBack={() => undefined} />);
    expect(screen.getByText(S.agentsPanel.gone)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/agents/AgentDetail.test.tsx`
Expected: FAIL — нет `./AgentDetail.js`.

- [ ] **Step 3: Реализация**

```tsx
// packages/desktop/src/renderer/agents/AgentDetail.tsx
/**
 * Экран агента в панели Agents (спека 2026-10-07, 5.1): шапка (описание, тип · модель, статус, время), задание
 * Markdown (длиннее 12 строк — свёрнуто), этапы (`agentSteps`), вызовы вживую компактными строками, итог, полный
 * транскрипт (`chat/transcript.ts`, живое обновление) и «Show in chat». Агент ищется в ленте по выбору (`AgentPick`)
 * на каждом рендере — поэтому экран живой и переживает конец агента.
 */

import { useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { ChatEnvContext } from '../chat/chat-env.js';
import { ToolItem } from '../chat/items/ToolItem.js';
import { openAgentCard } from '../chat/open-agent.js';
import { requestTranscript, TRANSCRIPT_TAIL, useLiveTranscript, type Transcript } from '../chat/transcript.js';
import { RoomMarkdown } from '../components/rooms/RoomMarkdown.js';
import { formatDuration } from '../lib/metrics-line.js';
import { useNow } from '../lib/use-now.js';
import { agentSteps, findAgent, type AgentPick } from './agents-model.js';

const PROMPT_LINES = 12;
const noLabel = (): null => null;
const openExternal = (url: string): void => void window.parley?.call('app.openExternal', { url });

export interface AgentDetailProps {
  bridge: ParleyBridge;
  sessionRef: SessionRef;
  items: readonly FeedItem[];
  pick: AgentPick;
  onBack: () => void;
}

export function AgentDetail({ bridge, sessionRef, items, pick, onBack }: AgentDetailProps): JSX.Element {
  const agent = findAgent(items, pick);
  const [promptOpen, setPromptOpen] = useState(false);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const now = useNow(1000);
  const reload = (): void => {
    if (agent?.agentId != null) requestTranscript(bridge, sessionRef, agent.agentId, setTranscript);
  };
  useLiveTranscript(agent ?? { agentId: null, status: 'done', toolCount: 0 }, transcript !== null, reload);

  const back = (
    <button type="button" onClick={onBack} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-3" aria-hidden="true" />
      {S.agentsPanel.back}
    </button>
  );
  if (agent === null) {
    return (
      <div data-testid="agent-detail" className="flex flex-col gap-2 px-1">
        {back}
        <p className="text-sm text-muted-foreground">{S.agentsPanel.gone}</p>
      </div>
    );
  }

  const running = agent.status === 'running';
  const elapsed = running ? now.getTime() - Date.parse(agent.at) : (agent.durationMs ?? null);
  const promptLines = (agent.prompt ?? '').split('\n');
  const prompt = promptOpen || promptLines.length <= PROMPT_LINES ? agent.prompt ?? '' : promptLines.slice(0, PROMPT_LINES).join('\n');
  const steps = agentSteps(agent);
  const tail = transcript?.state === 'ready' ? transcript.items.slice(-TRANSCRIPT_TAIL) : [];

  return (
    <ChatEnvContext.Provider value={{ bridge, sessionRef }}>
      <div data-testid="agent-detail" className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-1 pb-2">
        {back}
        <header className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
            <span className="min-w-0 truncate">{agent.description ?? agent.agentType ?? S.chat.agent.fallbackTitle}</span>
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {[agent.agentType, agent.model, S.chat.agent.status[agent.status], formatDuration(elapsed)].filter(Boolean).join(' · ')}
          </span>
        </header>

        {agent.prompt !== null ? (
          <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.task}</h3>
            <div className="min-w-0 break-words text-sm">
              <RoomMarkdown text={prompt} labelOf={noLabel} onOpenExternal={openExternal} />
            </div>
            {promptLines.length > PROMPT_LINES ? (
              <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => setPromptOpen(!promptOpen)}>
                {promptOpen ? S.agentsPanel.showLess : S.agentsPanel.showAll}
              </button>
            ) : null}
          </section>
        ) : null}

        {steps !== null ? (
          <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.steps}</h3>
            <ul className="flex flex-col gap-0.5 text-sm">
              {steps.map((step, index) => (
                <li key={index} className="flex min-w-0 items-start gap-1.5">
                  {step.status === 'completed' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : step.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <Circle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
                  <span className="min-w-0 break-words">{step.text}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex min-w-0 flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.activity}</h3>
          {agent.children.length === 0 ? <p className="text-xs text-muted-foreground">{S.agentsPanel.noActivity}</p> : null}
          {agent.children.map((child) => (
            <ToolItem key={child.id} item={child} compact />
          ))}
        </section>

        {agent.result !== undefined ? (
          <section className="flex min-w-0 flex-col gap-1">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">{S.agentsPanel.result}</h3>
            <div className="min-w-0 break-words text-sm">
              <RoomMarkdown text={agent.result} labelOf={noLabel} onOpenExternal={openExternal} />
            </div>
          </section>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {agent.agentId !== null ? (
            <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => (transcript === null ? reload() : setTranscript(null))}>
              {transcript === null ? S.agentsPanel.fullTranscript : S.agentsPanel.hideTranscript}
            </button>
          ) : null}
          {agent.agentId !== null ? (
            <button type="button" className="text-xs underline-offset-2 hover:underline" onClick={() => openAgentCard(sessionRef, agent.agentId as string)}>
              {S.agentsPanel.showInChat}
            </button>
          ) : null}
        </div>
        {transcript?.state === 'loading' ? <p className="text-xs text-muted-foreground">{S.chat.agent.transcriptLoading}</p> : null}
        {transcript?.state === 'error' ? <p className="text-xs text-muted-foreground">{S.chat.agent.transcriptFailed}</p> : null}
        {tail.map((item) => (item.kind === 'tool' ? <ToolItem key={item.id} item={item} compact /> : item.kind === 'text' || item.kind === 'prompt' ? (
          <div key={item.id} className="min-w-0 break-words text-sm"><RoomMarkdown text={item.text} labelOf={noLabel} onOpenExternal={openExternal} /></div>
        ) : null))}
      </div>
    </ChatEnvContext.Provider>
  );
}
```
Если у `AgentItem` открытие внешних ссылок сделано иначе (своя функция) — взять ту же, а не `window.parley?.call('app.openExternal', …)`: проверить в `AgentItem.tsx`, как он задаёт `onOpenExternal`, и повторить.

В `AgentsPanelView` (задача 2) перед списком:

```tsx
  const pick = useChatUiStore((state) => state.agentPanel[key] ?? null);
  // после проверки hasFeed:
  if (pick !== null) {
    return (
      <div data-testid="agents-panel" className="flex min-h-0 flex-col">
        <FeedSubscription sessionRef={sessionRef} />
        <AgentDetail bridge={bridge} sessionRef={sessionRef} items={feed?.items ?? []} pick={pick} onBack={() => select(key, null)} />
      </div>
    );
  }
```
(`bridge` теперь используется в `AgentsPanelView` — добавить его в деструктуризацию.)

- [ ] **Step 4: Прогнать**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/agents && pnpm -C packages/desktop typecheck`
Expected: PASS; exit 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/desktop/src/renderer/agents
git commit -m "feat(desktop): экран агента в панели Agents — задание, этапы, вызовы, итог, транскрипт" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Входы в панель — тулбар, поповер агентов, комната

**Files:**
- Create: `packages/desktop/src/renderer/agents/open-agents.ts`
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx:363-367` (`showAgent`)
- Modify: `packages/desktop/src/renderer/sidebar/SessionRow.tsx:316`
- Modify: `packages/desktop/src/renderer/layout/bodies/RoomBody.tsx:44`
- Test: `packages/desktop/src/renderer/agents/open-agents.test.ts`, `packages/desktop/src/renderer/chat/ChatView.test.tsx`

**Interfaces:**
- Consumes: `rightSidebarHasRoom()` (`shell/RightSidebar.tsx`), `useUiStore.getState().setSidebar`, `applyFocusTarget`/`buildFocusTargetDeps` (`attention/focus-target.ts`), `openAgentCard` (`chat/open-agent.ts`), `useChatUiStore.getState().selectAgent` и `requestReveal`.
- Produces:
```ts
/** Тулбар «N agents running»: вкладка Agents; нет места — прокрутка к первой карточке (прежнее поведение). */
export function openAgentsPanel(sessionKey: string, firstAgentId: string | null): void;
/** Строка поповера агентов: вкладка сессии в фокусе, вкладка Agents и экран агента; нет места — openAgentCard. */
export function openAgentInPanel(ref: SessionRef, agentId: string): void;
```

- [ ] **Step 1: Падающие тесты**

```ts
// packages/desktop/src/renderer/agents/open-agents.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey, type SessionRef } from '@parley/protocol';

const room = vi.hoisted(() => ({ value: true }));
vi.mock('../shell/RightSidebar.js', () => ({ rightSidebarHasRoom: () => room.value }));
vi.mock('../attention/focus-target.js', () => ({ applyFocusTarget: vi.fn(() => true), buildFocusTargetDeps: vi.fn(() => ({})) }));
vi.mock('../chat/open-agent.js', () => ({ openAgentCard: vi.fn() }));

import { openAgentCard } from '../chat/open-agent.js';
import { resetChatUiStoreForTests, useChatUiStore } from '../chat/ui-store.js';
import { useUiStore } from '../store/ui.js';
import { openAgentInPanel, openAgentsPanel } from './open-agents.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

beforeEach(() => {
  resetChatUiStoreForTests();
  vi.mocked(openAgentCard).mockClear();
  room.value = true;
});

describe('openAgentsPanel', () => {
  it('есть место — вкладка Agents и список (выбор сброшен)', () => {
    useChatUiStore.getState().selectAgent(refKey(REF), { by: 'agent', id: 'old' });
    openAgentsPanel(refKey(REF), 'a1');
    expect(useUiStore.getState().ui.rightSidebar).toMatchObject({ open: true, tab: 'agents' });
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toBeNull();
  });

  it('нет места — просьба показать первую карточку, сайдбар не трогается', () => {
    room.value = false;
    openAgentsPanel(refKey(REF), 'a1');
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: refKey(REF), agentId: 'a1' });
  });
});

describe('openAgentInPanel', () => {
  it('есть место — экран этого агента во вкладке Agents', () => {
    openAgentInPanel(REF, 'a7');
    expect(useUiStore.getState().ui.rightSidebar.tab).toBe('agents');
    expect(useChatUiStore.getState().agentPanel[refKey(REF)]).toEqual({ by: 'agent', id: 'a7' });
    expect(openAgentCard).not.toHaveBeenCalled();
  });

  it('нет места — прежний переход к карточке', () => {
    room.value = false;
    openAgentInPanel(REF, 'a7');
    expect(openAgentCard).toHaveBeenCalledWith(REF, 'a7');
  });
});
```

Если `useUiStore` в тестах требует инициализации (`patchUi` пишет через мост) — посмотреть, как это делают соседние тесты `store/ui.test.ts`, и повторить в `beforeEach`.

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/agents/open-agents.test.ts`
Expected: FAIL — нет `./open-agents.js`.

- [ ] **Step 3: Реализация**

```ts
// packages/desktop/src/renderer/agents/open-agents.ts
/**
 * Входы в панель Agents (спека 2026-10-07, 5.1). «N agents running» в тулбаре открывает вкладку со списком; строка
 * поповера агентов в сайдбаре и у участника комнаты — вкладку сессии и сразу экран этого агента. Правому сайдбару не
 * хватает места — прежнее поведение: прокрутка ленты к карточке агента.
 */

import { refKey, type SessionRef } from '@parley/protocol';
import { toast } from 'sonner';
import { S } from '../../shared/strings.js';
import { applyFocusTarget, buildFocusTargetDeps } from '../attention/focus-target.js';
import { openAgentCard } from '../chat/open-agent.js';
import { useChatUiStore } from '../chat/ui-store.js';
import { rightSidebarHasRoom } from '../shell/RightSidebar.js';
import { useUiStore } from '../store/ui.js';

export function openAgentsPanel(sessionKey: string, firstAgentId: string | null): void {
  if (!rightSidebarHasRoom()) {
    if (firstAgentId !== null) useChatUiStore.getState().requestReveal(sessionKey, firstAgentId);
    return;
  }
  useChatUiStore.getState().selectAgent(sessionKey, null);
  useUiStore.getState().setSidebar('right', { open: true, tab: 'agents' });
}

export function openAgentInPanel(ref: SessionRef, agentId: string): void {
  if (!rightSidebarHasRoom()) {
    openAgentCard(ref, agentId);
    return;
  }
  if (!applyFocusTarget({ kind: 'session', ref }, buildFocusTargetDeps())) {
    toast(S.notifications.targetGone);
    return;
  }
  useChatUiStore.getState().selectAgent(refKey(ref), { by: 'agent', id: agentId });
  useUiStore.getState().setSidebar('right', { open: true, tab: 'agents' });
}
```

- [ ] **Step 4: Подключить**

```tsx
// packages/desktop/src/renderer/chat/ChatView.tsx:363-367
  const showAgent = (): void => {
    const agentId = agents.map((agent) => agent.agentId).find((id): id is string => id !== null) ?? null;
    openAgentsPanel(sessionKey, agentId);
  };
// packages/desktop/src/renderer/sidebar/SessionRow.tsx:316
              onOpen={(task) => openAgentInPanel({ projectPath, workId, sessionId: session.id }, task.id)}
// packages/desktop/src/renderer/layout/bodies/RoomBody.tsx:44 — в openSession(sessionId, agentId?) ветка с агентом:
//   вместо openAgentCard(ref, agentId) → openAgentInPanel(ref, agentId)
```
Обновить шапки `ChatView.tsx` (абзац «Агенты (кусок 4b)…»), `SessionRow.tsx` и `RoomBody.tsx` одной фразой: клик ведёт в панель Agents, без места — к карточке.

В `ChatView.test.tsx` найти тест кнопки «N agents running» (`chat-agents-running`) и поменять ожидание: при месте для сайдбара — `useUiStore.getState().ui.rightSidebar.tab === 'agents'`; прежнее ожидание `reveal` оставить в тесте с `rightSidebarHasRoom` → `false` (замокать как в шаге 1).

- [ ] **Step 5: Прогнать**

Run: `pnpm -C packages/desktop exec vitest run src/renderer/agents src/renderer/chat src/renderer/sidebar src/renderer/layout && pnpm -C packages/desktop typecheck`
Expected: PASS; exit 0.

- [ ] **Step 6: Коммит**

```bash
git add packages/desktop/src/renderer
git commit -m "feat(desktop): тулбар и поповер агентов ведут в панель Agents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: E2E панели и документы части A

**Files:**
- Create: `packages/desktop/e2e/agents-panel.spec.ts`
- Modify: `CHANGELOG.md` (Unreleased → Added), `README.md` (раздел о виде Chat: панель Agents и ⌘⇧A), `TODOS.md` (раздел 21: панель сделана, что осталось — Codex)

**Interfaces:**
- Consumes: стаб `packages/desktop/e2e/stub-echo-agent.mjs` и способ из `e2e/chat-hooks.spec.ts`: строки `STUB_HOOK <json>` через `pty.input`; запуск приложения — как в `chat-hooks.spec.ts:284-311` (`PARLEY_HOME`, `PARLEY_CLAUDE_BIN`, `STUB_BRACKETED: '1'`, `STUB_HOOK_LOG`); последовательность субагента — как в `chat-hooks.spec.ts:756-792`.

- [ ] **Step 1: Написать E2E**

Скопировать в новый файл из `chat-hooks.spec.ts` вспомогательные части: запуск приложения, класс/функции `hold`/`fire` для хуков, `makeTempHome`/`makeTempProject`, `stopApp`/`stopHost`. Тесты:

1. **Тулбар → панель → экран агента → назад** (окно 1400×900):
   - запустить агента: `PreToolUse` `Agent` с `description` из 120 знаков (`'Explore the feed reducer and find every place where agent cards are created, merged and finished — '.repeat(2)`) и `prompt` из 30 строк; `PostToolUse` с `isAsync: true`; `SubagentStart` `{ agent_id: 'agE2E', agent_type: 'Explore' }`; вложенный `PreToolUse` `Bash` с командой из 140 знаков и `agent_id: 'agE2E'`;
   - клик `chat-agents-running` → видна вкладка `Agents` (`role=tab`, `aria-selected=true`), строка `agents-row-running` содержит начало описания и начало команды;
   - клик по строке → `agent-detail`; «Show all» раскрывает задание; в «Activity» — строка команды;
   - `SubagentStop` с `last_assistant_message: 'Done: 3 places'` → на экране раздел `Result` и текст итога, экран не закрылся;
   - «All agents» → снова список; «Finished (1)» → строка агента.
2. **Поповер в сайдбаре → экран агента**: тот же запуск агента; клик по бейджу агентов в строке сессии сайдбара, затем по строке поповера → вкладка Agents с `agent-detail` этого агента.
3. **Раскладка 800×500 с длинными значениями (Review Focus 1)**: окно 800×500 (`resize(app, 800, 500)` из `chat-hooks.spec.ts`); если правый сайдбар не помещается — проверить, что клик по «N agents running» прокрутил ленту к карточке (прежнее поведение) и сайдбара нет; если помещается — для `agents-panel` и `agent-detail`: `scrollWidth <= clientWidth` у корня панели и у каждой строки, правый край каждой строки ≤ правому краю сайдбара (`[data-testid="right-sidebar"]`). Снимок — в `test-results/agents-panel/`.

- [ ] **Step 2: Собрать и прогнать**

Run: `pnpm --filter @parley/host build && pnpm -C packages/desktop build && pnpm -C packages/desktop exec playwright test e2e/agents-panel.spec.ts`
Expected: 3 passed.

Затем с DPR 2: если в `playwright.config` нет проекта с `--force-device-scale-factor=2` — прогнать тест 3 с `args: [mainEntry, '--force-device-scale-factor=2']` в `electron.launch` (параметр через env `E2E_DPR=2`, как сделано в других спеках, если есть; иначе — отдельный вариант теста 3).

- [ ] **Step 3: Соседние E2E не сломаны**

Run: `pnpm -C packages/desktop exec playwright test e2e/chat-hooks.spec.ts e2e/chat-view.spec.ts e2e/files-sidebar.spec.ts e2e/layout.spec.ts`
Expected: passed (флейк — перезапуск в одиночку, см. Global Constraints).

- [ ] **Step 4: Документы**

- `CHANGELOG.md`, `## Unreleased` → `### Added`:
  `- **Agents panel.** "N agents running" in the Chat toolbar opens an "Agents" tab in the right sidebar (⌘⇧A): the session's agents with what each is doing now, finished ones below. Click an agent to see its task, steps, tool calls as they happen, result and full transcript. The agents badge in the sidebar and in a room opens the same panel.`
- `README.md`: в разделе о виде Chat — абзац о панели Agents и ⌘⇧A (по-английски, тем же стилем, что соседние абзацы).
- `TODOS.md`, раздел 21: в начало — «**Сделано (2026-10-xx, ветка `feat/agents-panel-codex-chat`):** панель Agents для Claude и GLM». Остальные пункты раздела оставить: они про Codex и закрываются в задаче 22.

- [ ] **Step 5: Коммит**

```bash
git add packages/desktop/e2e/agents-panel.spec.ts CHANGELOG.md README.md TODOS.md
git commit -m "test(desktop): E2E панели агентов; docs: панель Agents" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Точка остановки.** Часть A самостоятельна: её можно отдать на ревью и влить отдельным PR до Codex. Спросить человека, вливать ли сейчас.

### Часть B. Этап 0 — проверки до кода Codex

### Task 7: Потребители `notify` без запуска Codex (характеризующие тесты)

**Files:**
- Test: `packages/host/src/activity/activity-terminal.test.ts`, `packages/host/src/sessions/interrupted.test.ts` (если файла нет — создать)
- Modify: `docs/specs/2026-10-07-agents-panel-codex-chat-design.md` (новый раздел «13. Факты этапа 0»)

**Interfaces:**
- Consumes: `linkTerminalActivity` и разбор сигналов Codex (`host/src/activity/activity-service.ts:204-217`, `eventsFor` `:323-348`); `hookedSince` (`core/src/work/activity.ts:437`); `findInterrupted` (`host/src/sessions/interrupted.ts`); `journalLength` в `host/src/wake/wake-service.ts:157`.
- Produces: решение для задачи 16 — «подмену `notify` убираем» или «оставляем, потому что …», записанное в спеке.

Цель — доказать тестами, что сессия Codex **без единой строки `notify`** в журнале событий получает всё, что сейчас даёт `notify`.

- [ ] **Step 1: Тест — конец хода и «хуки приходили» только из терминала и журнала**

В `activity-terminal.test.ts` взять существующую настройку теста Codex (файл журнала `rollout-…-rollout-state.jsonl` около строк 157-181, сигналы через `terminalSignal`) и добавить тест: журнал событий работы пуст; сигналы `working`, затем `turn-complete` (OSC 9 «Agent turn complete»); в rollout — `task_started`, затем `task_complete`. Ожидать:

```ts
expect(live.activity.turnEndedAt).not.toBeNull();
expect(hookedSince(live.activity, startedAtMs)).toBe(true);
expect(live.activity.activity).not.toBe('working');
```

- [ ] **Step 2: Тест — прерванные сессии**

```ts
// packages/host/src/sessions/interrupted.test.ts — новый тест (или добавить в существующий)
it('сессия codex без строк notify в журнале событий не считается прерванной', async () => {
  const entry = workEntryWith({ id: 's-01', provider: 'codex', lifecycle: 'sleeping' });
  const found = await findInterrupted([entry], async () => []);
  expect(found).toEqual([]);
});
```
`workEntryWith` — взять фабрику записи работы из соседних тестов хоста (поиск: `lifecycle: 'sleeping'` в `packages/host/src/**/*.test.ts`); если подходящей нет — собрать объект `WorkEntry` вручную по типу из `@parley/core`.

- [ ] **Step 3: Прочитать `journalLength` (`wake-service.ts:157`) и его вызовы**

Run: `grep -n "journalLength" -r packages/host/src`
Записать, на что влияет длина журнала событий у сессии Codex и что изменится, если строк `Stop` от `notify` не будет.

- [ ] **Step 4: Прогнать**

Run: `pnpm -C packages/host exec vitest run src/activity/activity-terminal.test.ts src/sessions/interrupted.test.ts`
Expected: PASS — значит, `notify` можно убрать; FAIL — записать, какой потребитель зависит от `notify`, и задача 16 сначала доводит его, потом убирает подмену.

- [ ] **Step 5: Записать факты в спеку**

В конец спеки — раздел:

```markdown
## 13. Факты этапа 0

### 13.1 Потребители `notify` (задача 7, 2026-10-xx)
- активность Codex без строк `notify`: <итог теста шага 1>;
- прерванные сессии: <итог шага 2>;
- `journalLength` будильника: <что нашлось в шаге 3>;
- решение для задачи 16: <убираем / оставляем, почему>.
```

- [ ] **Step 6: Коммит**

```bash
git add packages/host/src docs/specs/2026-10-07-agents-panel-codex-chat-design.md
git commit -m "test(host): Codex без notify — конец хода и прерванные; спека: факты этапа 0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Живые пробы Codex (только с разрешения человека)

**Files:**
- Modify: `docs/specs/2026-10-07-agents-panel-codex-chat-design.md` (раздел 13.2)

- [ ] **Step 1: Спросить разрешение**

Написать человеку: «Этап 0, живые пробы Codex 0.160: 8 коротких сессий в `/tmp/parley-probe`, тратят лимит подписки Codex. Запускать?» — и ждать явного «да». Без него задача остаётся открытой, а задачи 13–22 идут по фактам из спеки (раздел 3) с пометкой «не проверено вживую».

- [ ] **Step 2: Подготовить папку и журнал-скрипт хука**

```bash
mkdir -p /tmp/parley-probe && cd /tmp/parley-probe && git init -q
cat > /tmp/parley-probe/hook.sh <<'SH'
#!/bin/sh
# Проба: записать вход хука и вернуть решение из файла decision.json, если он есть.
input=$(cat)
printf '%s\n' "$input" >> /tmp/parley-probe/hooks.log
event=$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("hook_event_name",""))')
if [ "$event" = "PermissionRequest" ] && [ -f /tmp/parley-probe/decision.json ]; then cat /tmp/parley-probe/decision.json; fi
SH
chmod +x /tmp/parley-probe/hook.sh
```

- [ ] **Step 3: Пробы**

Каждую — в отдельном окне Terminal.app (не в Parley); второе окно смотрит журнал:
`tail -f "$(ls -t ~/.codex/sessions/$(date +%Y/%m/%d)/rollout-*.jsonl | head -1)" | /usr/bin/python3 -c 'import json,sys; [print(r.get("ordinal"), r["type"], r["payload"].get("type"), (r["payload"].get("item") or {}).get("type")) for r in map(json.loads, sys.stdin)]'`

1. **Журнал вживую.** `codex --no-daemon -a on-request "run: sleep 4 && echo one; then sleep 4 && echo two"` — `CommandExecution` появляются по одному, с паузой ~4 с, а не разом в конце хода.
2. **Esc.** Попросить `sleep 30`, нажать Esc во время команды — в журнале `turn_aborted`; что осталось в поле ввода TUI.
3. **Resume.** `codex resume <id из session_meta>` и один промпт — дописан тот же файл или создан новый.
4. **Хуки и доверие.** Запуск с флагом
   `-c 'hooks.SessionStart=[{hooks=[{type="command",command="/tmp/parley-probe/hook.sh"}]}]' -c 'hooks.PreToolUse=[{hooks=[{type="command",command="/tmp/parley-probe/hook.sh"}]}]' -c 'hooks.PermissionRequest=[{hooks=[{type="command",command="/tmp/parley-probe/hook.sh"}]}]' -c 'hooks.SubagentStart=[{hooks=[{type="command",command="/tmp/parley-probe/hook.sh"}]}]' -c 'hooks.SubagentStop=[{hooks=[{type="command",command="/tmp/parley-probe/hook.sh"}]}]'`.
   Записать: что TUI показывает при неодобренных хуках, блокирует ли старт; как выглядит `/hooks`; одобрить; перезапустить с теми же флагами — хуки срабатывают без вопроса; поменять **содержимое** `hook.sh` (не путь) — доверие остаётся; `resume` с теми же флагами — доверие остаётся. Какой `session_id` приходит в `SessionStart` (сравнить с `session_meta.id`).
5. **`PermissionRequest`.** `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' > /tmp/parley-probe/decision.json`; попросить команду вне песочницы (`touch ~/parley-probe-outside && rm ~/parley-probe-outside`) и правку файла через `apply_patch`; приходит ли хук на каждую, пропало ли окно одобрения в TUI. Затем `behavior: "deny"` — команда отклонена.
6. **id вызова.** Для одной команды сравнить `tool_use_id` из `PreToolUse` в `hooks.log` и `item.id` из `item_completed` `CommandExecution`.
7. **Субагент.** «Spawn a subagent to list the files here and report back» — журнал агента: `subagent_history_start_ordinal`, где лежит задание (`response_item/agent_message`), итог; `SubagentStart`/`SubagentStop`: `agent_id` против id треда агента.
8. **Удалить** `~/parley-probe-outside`, если остался; доверие проб в `~/.codex/config.toml` не трогать — человек снимет его сам в `/hooks`, если захочет.

- [ ] **Step 4: Записать факты**

Раздел спеки `### 13.2 Живые пробы (2026-10-xx, codex-cli <версия>)` — по пункту на пробу. Расхождения с разделами 3 и 5 спеки — исправить спеку и шаги задач 13–22 этого плана **до** начала кода, отдельным коммитом.

- [ ] **Step 5: Коммит**

```bash
git add docs/specs/2026-10-07-agents-panel-codex-chat-design.md docs/specs/2026-10-07-agents-panel-codex-chat-plan.md
git commit -m "docs(spec): живые пробы Codex 0.160 — факты этапа 0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Часть C. Chat для Codex из журнала

### Task 9: Константы протокола и признак хоста в окне

**Files:**
- Modify: `packages/protocol/src/feed.ts` (константы, `feedDecisions`)
- Modify: `packages/protocol/src/methods.ts:405` (результат `feed.snapshot`) и данные события `feed.changed` (найти `'feed.changed'` в `packages/protocol/src`)
- Modify: `packages/core/src/work/feed-version.ts`, `packages/core/src/index.ts:394` (экспорт)
- Modify: `packages/desktop/src/shared/bridge.ts:34-39` (`HostStatus.connected.features`)
- Modify: `packages/desktop/src/main/host-connection.ts:311` (`features: result.features ?? null`)
- Modify: `packages/desktop/src/renderer/lib/capabilities.ts` (`hostFeatures`, `useHostFeature`)
- Modify: `packages/desktop/src/renderer/test-utils/fake-bridge.ts` (статус с `features`)
- Test: `packages/protocol/src/feed.test.ts`, `packages/core/src/work/feed-version.test.ts` (если нет — создать), `packages/desktop/src/renderer/lib/capabilities.test.ts`

**Interfaces:**
- Produces:
```ts
// @parley/protocol
export const CODEX_FEED_MIN_VERSION = '0.160.0';
export const FEED_CODEX_FEATURE = 'feed-codex';
export const feedDecisions = z.enum(['window', 'terminal']);
export type FeedDecisions = z.infer<typeof feedDecisions>;
// 'feed.snapshot' result: { items; revision; schemaVersion; mode; decisions?: FeedDecisions | null }
// 'feed.changed' data: + decisions?: FeedDecisions | null
// @parley/core
export const CODEX_FEED_MIN_VERSION = '0.160.0';
export function codexFeedSupported(version: string): boolean;
// desktop
// HostStatus connected: { state: 'connected'; hostVersion: string; methods: string[] | null; features: string[] | null }
export function hostFeatures(status: HostStatus): Set<string>;
export function useHostFeature(feature: string): boolean;
```

- [ ] **Step 1: Падающие тесты**

```ts
// packages/protocol/src/feed.test.ts — добавить
it('пределы Codex совпадают с core; признак хоста — feed-codex', async () => {
  const core = await import('../../core/src/work/feed-version.js');
  expect(CODEX_FEED_MIN_VERSION).toBe(core.CODEX_FEED_MIN_VERSION);
  expect(FEED_CODEX_FEATURE).toBe('feed-codex');
});
```
(Если соседний тест сверяет `FEED_MIN_VERSION` с core иначе — повторить его способ.)

```ts
// packages/core/src/work/feed-version.test.ts
import { describe, expect, it } from 'vitest';
import { codexFeedSupported } from './feed-version.js';
describe('codexFeedSupported', () => {
  it('0.160.0 и новее — да, 0.159.9 и мусор — нет', () => {
    expect(codexFeedSupported('0.160.0')).toBe(true);
    expect(codexFeedSupported('0.162.0-alpha.3')).toBe(true);
    expect(codexFeedSupported('0.159.9')).toBe(false);
    expect(codexFeedSupported('codex')).toBe(false);
  });
});
```

```ts
// packages/desktop/src/renderer/lib/capabilities.test.ts — добавить
it('hostFeatures: признаки подключённого хоста; иначе пусто', () => {
  expect(hostFeatures({ state: 'connected', hostVersion: '0.8.0', methods: null, features: ['feed-codex'] }).has('feed-codex')).toBe(true);
  expect(hostFeatures({ state: 'connected', hostVersion: '0.7.0', methods: null, features: null }).size).toBe(0);
  expect(hostFeatures({ state: 'connecting' }).size).toBe(0);
});
```
Строку `'0.162.0-alpha.3'` проверить против `parseVersion` (`core/src/work/channel.ts`): если пред-релиз он не разбирает — заменить в тесте на `'0.162.0'`.

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/core exec vitest run src/work/feed-version.test.ts && pnpm -C packages/protocol exec vitest run src/feed.test.ts`
Expected: FAIL — нет `codexFeedSupported`, `CODEX_FEED_MIN_VERSION`.

- [ ] **Step 3: Реализация**

```ts
// packages/core/src/work/feed-version.ts — дописать
/** Наименьшая версия `codex`, чей журнал (`item_completed`) разбирает лента (спека 2026-10-07, 5.4). */
export const CODEX_FEED_MIN_VERSION = '0.160.0';

export function codexFeedSupported(version: string): boolean {
  return feedSupported(version, CODEX_FEED_MIN_VERSION);
}
```
Экспорт из `packages/core/src/index.ts:394` рядом с `FEED_MIN_VERSION, feedSupported`.

```ts
// packages/protocol/src/feed.ts — рядом с FEED_MIN_VERSION
/** = `CODEX_FEED_MIN_VERSION` core: наименьшая версия `codex` для вида «Chat» (спека 2026-10-07, 5.4). */
export const CODEX_FEED_MIN_VERSION = '0.160.0';
/** Признак `hello.features` хоста, который строит ленту Codex из журнала. */
export const FEED_CODEX_FEATURE = 'feed-codex';
/** Может ли окно отвечать на одобрения сессии (`window`) или только терминал (`terminal`); спека 5.7. */
export const feedDecisions = z.enum(['window', 'terminal']);
export type FeedDecisions = z.infer<typeof feedDecisions>;
```
В `methods.ts` результат `'feed.snapshot'`: `{ items: FeedItem[]; revision: number; schemaVersion: number; mode: string | null; decisions?: FeedDecisions | null }`; в данных `'feed.changed'` — то же необязательное поле. Если у этих типов есть zod-схемы — добавить `decisions: feedDecisions.nullable().optional()`.

```ts
// packages/desktop/src/shared/bridge.ts
  | { state: 'connected'; hostVersion: string; methods: string[] | null; features: string[] | null }
// packages/desktop/src/main/host-connection.ts:311
      this.setStatus({ state: 'connected', hostVersion: result.hostVersion, methods: result.methods ?? null, features: result.features ?? null });
// packages/desktop/src/renderer/lib/capabilities.ts
/** Признаки хоста сверх протокола 1 (`hello.features`); хост без поля — пусто. */
export function hostFeatures(status: HostStatus): Set<string> {
  return status.state === 'connected' ? new Set(status.features ?? []) : new Set();
}
export function useHostFeature(feature: string): boolean {
  return useHostStore((state) => hostFeatures(state.status).has(feature));
}
```
Все места, где строится `{ state: 'connected', … }` (main, тесты, `fake-bridge.ts`), получают `features: null` или список; `tsc` покажет каждое.

- [ ] **Step 4: Прогнать**

Run: `pnpm build && pnpm -C packages/core exec vitest run src/work && pnpm -C packages/protocol test && pnpm -C packages/desktop exec vitest run src/renderer/lib src/main && pnpm -C packages/desktop typecheck`
Expected: PASS; exit 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/core packages/protocol packages/desktop
git commit -m "feat(protocol,core,desktop): CODEX_FEED_MIN_VERSION, признак feed-codex и поле decisions ленты" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Разбор строки журнала Codex и unified diff

**Files:**
- Create: `packages/core/src/feed/codex/rollout-record.ts`, `packages/core/src/feed/codex/unified-diff.ts`
- Test: `packages/core/src/feed/codex/rollout-record.test.ts`, `packages/core/src/feed/codex/unified-diff.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RolloutRecord { ordinal: number | null; at: string; type: string; payload: Record<string, unknown> }
export function rolloutRecordOf(raw: unknown): RolloutRecord | null;
export function parseRolloutLine(line: string): RolloutRecord | null;
export function parseUnifiedDiff(diff: string, limit?: number): { hunks: FeedPatchHunk[]; truncated: boolean };
```

- [ ] **Step 1: Падающие тесты**

```ts
// packages/core/src/feed/codex/rollout-record.test.ts
import { describe, expect, it } from 'vitest';
import { parseRolloutLine, rolloutRecordOf } from './rollout-record.js';

describe('rollout-record', () => {
  it('строка 0.160: ordinal, время, тип, payload', () => {
    const line = JSON.stringify({ timestamp: '2026-10-07T10:00:00.000Z', ordinal: 7, type: 'event_msg', payload: { type: 'task_started' } });
    expect(parseRolloutLine(line)).toEqual({ ordinal: 7, at: '2026-10-07T10:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } });
  });
  it('без ordinal (журналы до 0.160) — ordinal null', () => {
    expect(rolloutRecordOf({ timestamp: 't', type: 'session_meta', payload: {} })?.ordinal).toBeNull();
  });
  it('битая, пустая и чужая строки — null', () => {
    expect(parseRolloutLine('{"timestamp":')).toBeNull();
    expect(parseRolloutLine('   ')).toBeNull();
    expect(parseRolloutLine('[1,2]')).toBeNull();
    expect(rolloutRecordOf({ timestamp: 't', type: 'x', payload: 'nope' })).toBeNull();
  });
});
```

```ts
// packages/core/src/feed/codex/unified-diff.test.ts
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './unified-diff.js';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '@@ -10 +10,2 @@',
  ' tail',
  '+added',
  '\\ No newline at end of file',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('хунки с началом и длиной; длина по умолчанию 1; служебные строки пропущены', () => {
    const { hunks, truncated } = parseUnifiedDiff(DIFF);
    expect(truncated).toBe(false);
    expect(hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [' tail', '+added'] },
    ]);
  });
  it('строк больше предела — хвост отброшен, truncated', () => {
    const { hunks, truncated } = parseUnifiedDiff(DIFF, 3);
    expect(truncated).toBe(true);
    expect(hunks.flatMap((hunk) => hunk.lines)).toHaveLength(3);
  });
  it('пустой дифф — нет хунков', () => {
    expect(parseUnifiedDiff('')).toEqual({ hunks: [], truncated: false });
  });
});
```

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/core exec vitest run src/feed/codex`
Expected: FAIL — нет модулей.

- [ ] **Step 3: Реализация**

```ts
// packages/core/src/feed/codex/rollout-record.ts
/**
 * Строка журнала Codex (`~/.codex/sessions/…/rollout-*.jsonl`; спека 2026-10-07, разделы 3 и 5.2):
 * `{ timestamp, ordinal, type, payload }`. Разбор без исключений: битая или чужая строка — `null`.
 */

export interface RolloutRecord {
  /** Монотонный номер строки; `null` — его нет (журналы до 0.160). */
  ordinal: number | null;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function rolloutRecordOf(raw: unknown): RolloutRecord | null {
  if (!isRecord(raw)) return null;
  const { type, timestamp, payload, ordinal } = raw;
  if (typeof type !== 'string' || typeof timestamp !== 'string' || !isRecord(payload)) return null;
  return { ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : null, at: timestamp, type, payload };
}

export function parseRolloutLine(line: string): RolloutRecord | null {
  if (line.trim() === '') return null;
  try {
    return rolloutRecordOf(JSON.parse(line));
  } catch {
    return null;
  }
}
```

```ts
// packages/core/src/feed/codex/unified-diff.ts
/**
 * Unified diff (`FileChange.changes[путь].unified_diff` журнала Codex) в хунки ленты (`FeedPatchHunk`). Заголовки
 * файла до первого хунка и «\ No newline at end of file» пропускаются; строк больше предела — хвост отброшен.
 */

import { FEED_PATCH_LINES, type FeedPatchHunk } from '../types.js';

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string, limit: number = FEED_PATCH_LINES): { hunks: FeedPatchHunk[]; truncated: boolean } {
  const hunks: FeedPatchHunk[] = [];
  let current: FeedPatchHunk | null = null;
  let count = 0;
  for (const line of diff.split('\n')) {
    const header = HEADER.exec(line);
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    const mark = line[0];
    if (mark !== ' ' && mark !== '-' && mark !== '+') continue;
    if (count >= limit) return { hunks, truncated: true };
    current.lines.push(line);
    count += 1;
  }
  return { hunks, truncated: false };
}
```

- [ ] **Step 4: Прогнать**

Run: `pnpm -C packages/core exec vitest run src/feed/codex`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/core/src/feed/codex
git commit -m "feat(core): разбор строки журнала Codex и unified diff в хунки ленты" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Лента основного треда Codex из журнала

**Files:**
- Modify: `packages/core/src/feed/reduce.ts` (экспортировать `closeTurn` и `withChild` — сейчас внутренние)
- Create: `packages/core/src/feed/codex/apply-codex.ts`
- Create: `packages/core/src/feed/fixtures/codex-main.rollout.jsonl`
- Modify: `packages/core/src/feed/index.ts`, `packages/core/src/index.ts` (экспорт нового API)
- Test: `packages/core/src/feed/codex/apply-codex.test.ts`

**Interfaces:**
- Consumes: `RolloutRecord`, `parseRolloutLine` (задача 10); `parseUnifiedDiff` (задача 10); из `reduce.ts`: `FeedDraft`, `newTool`, `newText`, `finishTool`, `limitText`, `blocksText`, `emptyFeedState`, `closeTurn(draft, at, interrupted)`, `withChild(agent, child)`, `agentById(draft, agentId)`.
- Produces:
```ts
export interface CodexCursor { lastOrdinal: number; skipped: number; modern: boolean }
export const emptyCodexCursor: () => CodexCursor;
export const CODEX_HISTORY_IN_TERMINAL = 'codex-history-in-terminal';
export const CODEX_HISTORY_MESSAGE = 'Earlier history of this session is only in Terminal';
/** Применить новые записи журнала; `agentId` — записи журнала субагента: вызовы идут в `children` его карточки. */
export function applyCodexRecords(state: FeedState, records: readonly RolloutRecord[], cursor: CodexCursor, agentId?: string | null): { update: FeedUpdate; cursor: CodexCursor };
/** Сев ленты из журнала целиком; `historyStart` — первая собственная запись (журнал субагента). */
export function feedFromCodexRollout(records: readonly RolloutRecord[], options?: { limit?: number; historyStart?: number }): { state: FeedState; cursor: CodexCursor };
export function commandText(argv: unknown): string;
```

- [ ] **Step 1: Фикстура**

`packages/core/src/feed/fixtures/codex-main.rollout.jsonl` — строки по одной на запись (структура — как в журналах Codex 0.160, текст синтетический; длинные значения нарочно):

```jsonl
{"timestamp":"2026-10-07T10:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"th-main","cwd":"/tmp/p","cli_version":"0.160.0","source":"cli"}}
{"timestamp":"2026-10-07T10:00:01.000Z","ordinal":1,"type":"turn_context","payload":{"turn_id":"u1","model":"gpt-6-astra","effort":"high","approval_policy":"on-request","sandbox_policy":{"type":"workspace-write"}}}
{"timestamp":"2026-10-07T10:00:01.000Z","ordinal":2,"type":"event_msg","payload":{"type":"task_started","turn_id":"u1"}}
{"timestamp":"2026-10-07T10:00:01.100Z","ordinal":3,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367201100,"completed_at_ms":1791367201100,"item":{"type":"UserMessage","id":"um1","content":[{"type":"text","text":"Почини тесты ленты"}]}}}
{"timestamp":"2026-10-07T10:00:02.000Z","ordinal":4,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367201500,"completed_at_ms":1791367202000,"item":{"type":"Reasoning","id":"r1","summary":[]}}}
{"timestamp":"2026-10-07T10:00:03.000Z","ordinal":5,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367202000,"completed_at_ms":1791367203000,"item":{"type":"CommandExecution","id":"call_cmd1","command":["/bin/zsh","-lc","pnpm -C packages/core exec vitest run src/feed/codex --reporter=verbose 2>&1 | tail -n 40"],"cwd":"/tmp/p","parsed_cmd":[],"source":"agent","status":"completed","aggregated_output":"Test Files 2 passed","exit_code":0,"duration":{"secs":1,"nanos":0}}}}
{"timestamp":"2026-10-07T10:00:04.000Z","ordinal":6,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367203000,"completed_at_ms":1791367204000,"item":{"type":"CommandExecution","id":"call_cmd2","command":["git","commit","-m","fix: тесты"],"cwd":"/tmp/p","parsed_cmd":[],"source":"agent","status":"completed","aggregated_output":"nothing to commit","exit_code":1}}}
{"timestamp":"2026-10-07T10:00:05.000Z","ordinal":7,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367204000,"completed_at_ms":1791367205000,"item":{"type":"FileChange","id":"fc1","status":"completed","changes":{"/tmp/p/src/a.ts":{"type":"update","unified_diff":"@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n"},"/tmp/p/src/new.ts":{"type":"add","content":"export const x = 1;\n"},"/tmp/p/src/old.ts":{"type":"delete"}}}}}
{"timestamp":"2026-10-07T10:00:06.000Z","ordinal":8,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367205000,"completed_at_ms":1791367206000,"item":{"type":"McpToolCall","id":"mcp1","server":"parley","tool":"report","arguments":{"status":"done"},"status":"completed","result":{"content":[{"type":"text","text":"ok"}]}}}}
{"timestamp":"2026-10-07T10:00:07.000Z","ordinal":9,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u1","started_at_ms":1791367206000,"completed_at_ms":1791367207000,"item":{"type":"AgentMessage","id":"am1","phase":"final_answer","content":[{"type":"text","text":"Готово: тесты зелёные."}]}}}
{"timestamp":"2026-10-07T10:00:07.100Z","ordinal":10,"type":"event_msg","payload":{"type":"task_complete","turn_id":"u1","last_agent_message":"Готово: тесты зелёные.","duration_ms":6100}}
{"timestamp":"2026-10-07T10:01:00.000Z","ordinal":11,"type":"event_msg","payload":{"type":"task_started","turn_id":"u2"}}
{"timestamp":"2026-10-07T10:01:00.100Z","ordinal":12,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u2","started_at_ms":1791367260100,"completed_at_ms":1791367260100,"item":{"type":"UserMessage","id":"um2","content":[{"type":"text","text":"Стоп"}]}}}
{"timestamp":"2026-10-07T10:01:02.000Z","ordinal":13,"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"u2","reason":"interrupted"}}
{"timestamp":"2026-10-07T10:01:03.000Z","ordinal":14,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-main","turn_id":"u3","item":{"type":"BrandNewThing","id":"x1"}}}
```

- [ ] **Step 2: Падающие тесты**

```ts
// packages/core/src/feed/codex/apply-codex.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyFeedState } from '../reduce.js';
import type { FeedAgent, FeedItem, FeedNotice, FeedPrompt, FeedText, FeedTool, FeedTurn } from '../types.js';
import { applyCodexRecords, CODEX_HISTORY_IN_TERMINAL, commandText, emptyCodexCursor, feedFromCodexRollout } from './apply-codex.js';
import { parseRolloutLine, type RolloutRecord } from './rollout-record.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const records = (name: string): RolloutRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.rollout.jsonl`), 'utf8')
    .split('\n')
    .map(parseRolloutLine)
    .filter((record): record is RolloutRecord => record !== null);
const ofKind = <K extends FeedItem['kind']>(items: readonly FeedItem[], kind: K): Array<Extract<FeedItem, { kind: K }>> =>
  items.filter((item): item is Extract<FeedItem, { kind: K }> => item.kind === kind);

describe('feedFromCodexRollout — основной тред', () => {
  const { state, cursor } = feedFromCodexRollout(records('codex-main'));

  it('порядок элементов ленты', () => {
    expect(state.items.map((item) => item.kind)).toEqual([
      'notice', 'prompt', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'text', 'turn', 'prompt', 'turn',
    ]);
  });

  it('модель из turn_context — заметка session-start; режим — approval · sandbox', () => {
    const notice = ofKind(state.items, 'notice')[0] as FeedNotice;
    expect(notice.notice).toEqual({ type: 'session-start', source: 'codex', model: 'gpt-6-astra' });
    expect(state.permissionMode).toBe('on-request · workspace-write');
  });

  it('промпт и итоговый текст', () => {
    expect((ofKind(state.items, 'prompt')[0] as FeedPrompt).text).toBe('Почини тесты ленты');
    const text = ofKind(state.items, 'text')[0] as FeedText;
    expect(text).toMatchObject({ text: 'Готово: тесты зелёные.', streaming: false, messageId: 'am1' });
  });

  it('команды: скрипт оболочки как есть, вывод, ненулевой код — failed', () => {
    const [cmd1, cmd2] = ofKind(state.items, 'tool') as FeedTool[];
    expect(cmd1).toMatchObject({ name: 'Bash', status: 'done', toolUseId: 'call_cmd1' });
    expect(cmd1?.input['command']).toBe('pnpm -C packages/core exec vitest run src/feed/codex --reporter=verbose 2>&1 | tail -n 40');
    expect(cmd1?.response?.text).toBe('Test Files 2 passed');
    expect(cmd2).toMatchObject({ name: 'Bash', status: 'failed' });
    expect(cmd2?.input['command']).toBe('git commit -m "fix: тесты"');
  });

  it('правка файла: Edit с хунками, Write без хунков, Delete', () => {
    const files = (ofKind(state.items, 'tool') as FeedTool[]).filter((tool) => ['Edit', 'Write', 'Delete'].includes(tool.name));
    expect(files.map((tool) => [tool.name, tool.input['file_path']])).toEqual([
      ['Edit', '/tmp/p/src/a.ts'], ['Write', '/tmp/p/src/new.ts'], ['Delete', '/tmp/p/src/old.ts'],
    ]);
    expect(files[0]?.patch?.[0]?.lines).toEqual([' const a = 1;', '-const b = 2;', '+const b = 3;']);
    expect(files[1]?.patch).toBeUndefined();
    expect(files[1]?.input['content']).toBe('export const x = 1;\n');
  });

  it('MCP — сервер и инструмент в имени, ответ текстом', () => {
    const mcp = (ofKind(state.items, 'tool') as FeedTool[]).find((tool) => tool.name.startsWith('mcp__'));
    expect(mcp).toMatchObject({ name: 'mcp__parley__report', input: { status: 'done' }, status: 'done' });
    expect(mcp?.response?.text).toBe('ok');
  });

  it('конец хода; прерванный ход — interrupted', () => {
    const [done, aborted] = ofKind(state.items, 'turn') as FeedTurn[];
    expect(done?.interrupted).toBeUndefined();
    expect(aborted?.interrupted).toBe(true);
  });

  it('незнакомый тип элемента считается и пропускается; журнал современный', () => {
    expect(cursor.skipped).toBe(1);
    expect(cursor.modern).toBe(true);
    expect(cursor.lastOrdinal).toBe(14);
  });
});

describe('applyCodexRecords', () => {
  it('записи с ordinal не больше применённого — без дублей', () => {
    const all = records('codex-main');
    const first = applyCodexRecords(emptyFeedState(), all.slice(0, 6), emptyCodexCursor());
    const again = applyCodexRecords(first.update.state, all.slice(3, 9), first.cursor);
    const once = feedFromCodexRollout(all.slice(0, 9)).state;
    expect(again.update.state.items.map((item) => item.id)).toEqual(once.items.map((item) => item.id));
  });

  it('смена модели — заметка model-switch', () => {
    const ctx = (ordinal: number, model: string): RolloutRecord => ({ ordinal, at: '2026-10-07T10:00:00.000Z', type: 'turn_context', payload: { model, approval_policy: 'on-request' } });
    const { update } = applyCodexRecords(emptyFeedState(), [ctx(1, 'gpt-6'), ctx(2, 'gpt-6'), ctx(3, 'gpt-6-mini')], emptyCodexCursor());
    const notices = ofKind(update.state.items, 'notice').map((item) => item.notice);
    expect(notices).toEqual([
      { type: 'session-start', source: 'codex', model: 'gpt-6' },
      { type: 'model-switch', from: 'gpt-6', to: 'gpt-6-mini', source: 'codex' },
    ]);
  });

  it('записи журнала субагента — вызовы в children его карточки, текст и ход не в ленту', () => {
    const agent: FeedAgent = { id: 'agent:th-sub', at: 't', kind: 'agent', toolUseId: 'th-sub', agentId: 'th-sub', agentType: null, description: null, prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [] };
    const base = { ...emptyFeedState(), items: [agent] };
    const all = records('codex-main');
    const { update } = applyCodexRecords(base, all, emptyCodexCursor(), 'th-sub');
    const card = update.state.items.find((item) => item.kind === 'agent') as FeedAgent;
    expect(update.state.items).toHaveLength(1);
    expect(card.children.map((child) => child.name)).toEqual(['Bash', 'Bash', 'Edit', 'Write', 'Delete', 'mcp__parley__report']);
    expect(card.toolCount).toBe(6);
    expect(card.children[2]?.patch).toBeUndefined();
  });
});

describe('журнал без item_completed (Codex до 0.160)', () => {
  it('одна ошибка-заметка «история в терминале», без элементов разговора', () => {
    const legacy: RolloutRecord[] = [
      { ordinal: null, at: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'old', cli_version: '0.150.0' } },
      { ordinal: null, at: '2026-09-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      { ordinal: null, at: '2026-09-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ];
    const { state, cursor } = feedFromCodexRollout(legacy);
    expect(cursor.modern).toBe(false);
    expect(state.items).toEqual([expect.objectContaining({ kind: 'error', error: CODEX_HISTORY_IN_TERMINAL })]);
  });
});

describe('commandText', () => {
  it('оболочка -lc — скрипт; иначе аргументы, с пробелами — в кавычках; не массив — пусто', () => {
    expect(commandText(['/bin/bash', '-lc', 'ls -la'])).toBe('ls -la');
    expect(commandText(['rg', 'Feed Agent', 'src'])).toBe('rg "Feed Agent" src');
    expect(commandText('ls')).toBe('');
  });
});
```

- [ ] **Step 3: Прогнать — падают**

Run: `pnpm -C packages/core exec vitest run src/feed/codex/apply-codex.test.ts`
Expected: FAIL — нет `./apply-codex.js`.

- [ ] **Step 4: Открыть `closeTurn` и `withChild` в `reduce.ts`**

Поставить `export` перед `function closeTurn(` и `function withChild(` (сигнатуры не менять: `closeTurn(draft: FeedDraft, at: string, interrupted: boolean): void`, `withChild(agent: FeedAgent, child: FeedTool): FeedAgent`). Из `feed/index.ts` их **не** экспортировать — это внутренности core.

- [ ] **Step 5: Реализация**

```ts
// packages/core/src/feed/codex/apply-codex.ts
/**
 * Лента Codex из журнала сессии (спека 2026-10-07, 5.2). Журнал пишет только законченные элементы хода
 * (`event_msg/item_completed` с `TurnItem`), поэтому вызовы появляются в ленте сразу законченными. Записи с `ordinal`
 * не больше применённого пропускаются — повторное чтение файла не даёт дублей. Id элементов — id элементов Codex
 * (`toolUseId` вызова — `item.id`: с ним совпадёт `tool_use_id` хука, если этап 0 это подтвердит). Строительные блоки —
 * те же, что у ленты Claude (`reduce.ts`).
 *
 * С `agentId` записи — из журнала субагента: его вызовы ложатся в `children` карточки (`withChild`, без хунков), а текст,
 * промпты и ходы агента в ленту родителя не идут — итог и задание карточке даёт `codex-agents.ts`.
 *
 * `Reasoning` пропускается (thinking у Claude тоже не показывается); `ContextCompaction` — заметка `compact`; запись
 * `compacted` её не дублирует. Незнакомый тип элемента — пропуск и счётчик `skipped` для `host.log`.
 */

import {
  agentById,
  blocksText,
  closeTurn,
  emptyFeedState,
  FeedDraft,
  finishTool,
  limitText,
  newText,
  newTool,
  withChild,
} from '../reduce.js';
import {
  FEED_TEXT_LIMIT,
  type FeedError,
  type FeedItem,
  type FeedNotice,
  type FeedNoticeData,
  type FeedPrompt,
  type FeedState,
  type FeedTool,
  type FeedToolStatus,
  type FeedUpdate,
} from '../types.js';
import type { RolloutRecord } from './rollout-record.js';
import { parseUnifiedDiff } from './unified-diff.js';

export interface CodexCursor {
  /** Последний применённый `ordinal`; `-1` — ничего не применено. */
  lastOrdinal: number;
  /** Сколько элементов незнакомых типов пропущено. */
  skipped: number;
  /** Встретилась ли запись `item_completed` — журнал в формате 0.160+. */
  modern: boolean;
}

export const emptyCodexCursor = (): CodexCursor => ({ lastOrdinal: -1, skipped: 0, modern: false });

export const CODEX_HISTORY_IN_TERMINAL = 'codex-history-in-terminal';
export const CODEX_HISTORY_MESSAGE = 'Earlier history of this session is only in Terminal';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: Json | null | undefined, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const msAt = (value: unknown, fallback: string): string =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : fallback;

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
    .filter((text) => text !== '')
    .join('\n');
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => isRecord(part) && typeof part['type'] === 'string' && part['type'].includes('image')).length;
}

const SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh', 'fish']);

export function commandText(argv: unknown): string {
  if (!Array.isArray(argv)) return '';
  const parts = argv.filter((part): part is string => typeof part === 'string');
  const shell = parts[0]?.split('/').pop() ?? '';
  if (parts.length === 3 && SHELLS.has(shell) && (parts[1] === '-lc' || parts[1] === '-c')) return parts[2] as string;
  return parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function statusOf(item: Json): FeedToolStatus {
  const status = str(item, 'status');
  if (status === 'declined') return 'rejected';
  if (status === 'failed' || status === 'interrupted') return 'failed';
  const code = item['exit_code'];
  return typeof code === 'number' && code !== 0 ? 'failed' : 'done';
}

/** Вызов — в основную ленту или в `children` карточки субагента. */
function putTool(draft: FeedDraft, agentId: string | null, tool: FeedTool): void {
  if (agentId === null) {
    draft.put(tool);
    return;
  }
  const agent = agentById(draft, agentId);
  if (agent !== undefined) draft.put(withChild(agent, tool));
}

function modeOf(payload: Json): string | null {
  const approval = str(payload, 'approval_policy');
  const sandboxRaw = payload['sandbox_policy'];
  const sandbox = typeof sandboxRaw === 'string' ? sandboxRaw : isRecord(sandboxRaw) ? str(sandboxRaw, 'type') : null;
  const parts = [approval, sandbox].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

function lastModel(draft: FeedDraft): string | null {
  for (let at = draft.items.length - 1; at >= 0; at -= 1) {
    const item = draft.items[at] as FeedItem;
    if (item.kind !== 'notice') continue;
    if (item.notice.type === 'session-start') return item.notice.model;
    if (item.notice.type === 'model-switch') return item.notice.to;
  }
  return null;
}

function onTurnContext(draft: FeedDraft, record: RolloutRecord): void {
  const mode = modeOf(record.payload);
  if (mode !== null) draft.permissionMode = mode;
  const model = str(record.payload, 'model');
  if (model === null) return;
  const was = lastModel(draft);
  if (was === model) return;
  const notice: FeedNoticeData =
    was === null ? { type: 'session-start', source: 'codex', model } : { type: 'model-switch', from: was, to: model, source: 'codex' };
  const item: FeedNotice = { id: draft.nextId('notice'), at: record.at, kind: 'notice', notice };
  draft.put(item);
}

function onItem(draft: FeedDraft, record: RolloutRecord, cursor: CodexCursor, agentId: string | null): void {
  const item = record.payload['item'];
  if (!isRecord(item)) return;
  const type = str(item, 'type');
  const id = str(item, 'id');
  if (type === null || id === null) return;
  const startAt = msAt(record.payload['started_at_ms'], record.at);
  const endAt = msAt(record.payload['completed_at_ms'], record.at);

  switch (type) {
    case 'Reasoning':
      return;
    case 'UserMessage': {
      if (agentId !== null) return;
      const { text } = limitText(contentText(item['content']), FEED_TEXT_LIMIT);
      const prompt: FeedPrompt = { id: `prompt:${id}`, at: startAt, kind: 'prompt', text, images: imageCount(item['content']) };
      draft.put(prompt);
      return;
    }
    case 'AgentMessage': {
      if (agentId !== null) return;
      const text = contentText(item['content']);
      if (text !== '') draft.put(newText(`text:${id}`, endAt, id, text, false));
      return;
    }
    case 'CommandExecution': {
      const cwd = str(item, 'cwd');
      const output =
        typeof item['aggregated_output'] === 'string'
          ? item['aggregated_output']
          : [item['stdout'], item['stderr']].filter((part) => typeof part === 'string' && part !== '').join('\n');
      const tool = newTool(id, 'Bash', { command: commandText(item['command']), ...(cwd === null ? {} : { cwd }) }, startAt, agentId);
      putTool(draft, agentId, finishTool(tool, statusOf(item), output, endAt));
      return;
    }
    case 'FileChange': {
      const changes = item['changes'];
      if (!isRecord(changes)) return;
      const status = statusOf(item);
      Object.entries(changes).forEach(([file, raw], index) => {
        if (!isRecord(raw)) return;
        const kind = str(raw, 'type');
        const move = str(raw, 'move_path');
        const base = { file_path: file, ...(move === null ? {} : { move_path: move }) };
        const toolUseId = `${id}:${index}`;
        if (kind === 'add') {
          const content = typeof raw['content'] === 'string' ? raw['content'] : '';
          putTool(draft, agentId, finishTool(newTool(toolUseId, 'Write', { ...base, content }, startAt, agentId), status, undefined, endAt));
          return;
        }
        if (kind === 'delete') {
          putTool(draft, agentId, finishTool(newTool(toolUseId, 'Delete', base, startAt, agentId), status, undefined, endAt));
          return;
        }
        const done = finishTool(newTool(toolUseId, 'Edit', base, startAt, agentId), status, undefined, endAt);
        const diff = typeof raw['unified_diff'] === 'string' ? raw['unified_diff'] : '';
        const patch = agentId === null ? parseUnifiedDiff(diff) : { hunks: [], truncated: false };
        putTool(draft, agentId, patch.hunks.length === 0 ? done : { ...done, patch: patch.hunks, ...(patch.truncated ? { patchTruncated: true } : {}) });
      });
      return;
    }
    case 'McpToolCall': {
      const server = str(item, 'server') ?? 'mcp';
      const name = str(item, 'tool') ?? 'tool';
      const args = isRecord(item['arguments']) ? item['arguments'] : {};
      const result = isRecord(item['result']) ? (blocksText(item['result']['content']) ?? JSON.stringify(item['result'])) : undefined;
      const error = isRecord(item['error']) ? str(item['error'], 'message') : str(item, 'error');
      putTool(draft, agentId, finishTool(newTool(id, `mcp__${server}__${name}`, args, startAt, agentId), statusOf(item), result ?? error ?? undefined, endAt));
      return;
    }
    case 'Extension': {
      const query = str(item, 'query');
      if (query === null) break;
      const results = Array.isArray(item['results'])
        ? item['results'].filter(isRecord).map((hit) => [str(hit, 'title'), str(hit, 'url')].filter(Boolean).join(' — ')).join('\n')
        : undefined;
      putTool(draft, agentId, finishTool(newTool(id, 'WebSearch', { query }, startAt, agentId), 'done', results, endAt));
      return;
    }
    case 'ImageView': {
      const file = str(item, 'path');
      putTool(draft, agentId, finishTool(newTool(id, 'ViewImage', file === null ? {} : { file_path: file }, startAt, agentId), 'done', undefined, endAt));
      return;
    }
    case 'ContextCompaction': {
      if (agentId !== null) return;
      const notice: FeedNotice = { id: `notice:${id}`, at: endAt, kind: 'notice', notice: { type: 'compact', phase: 'post', trigger: null } };
      draft.put(notice);
      return;
    }
    default:
      break;
  }
  cursor.skipped += 1;
}

function applyRecord(draft: FeedDraft, record: RolloutRecord, cursor: CodexCursor, agentId: string | null): void {
  if (record.type === 'turn_context') {
    if (agentId === null) onTurnContext(draft, record);
    return;
  }
  if (record.type !== 'event_msg') return;
  const kind = str(record.payload, 'type');
  if (kind === 'item_completed') {
    cursor.modern = true;
    onItem(draft, record, cursor, agentId);
    return;
  }
  if (agentId !== null) return;
  if (kind === 'task_started') draft.turnStartedAt = record.at;
  else if (kind === 'task_complete') closeTurn(draft, record.at, false);
  else if (kind === 'turn_aborted') closeTurn(draft, record.at, true);
}

export function applyCodexRecords(
  state: FeedState,
  records: readonly RolloutRecord[],
  cursor: CodexCursor,
  agentId: string | null = null,
): { update: FeedUpdate; cursor: CodexCursor } {
  const draft = new FeedDraft(state);
  const next: CodexCursor = { ...cursor };
  for (const record of records) {
    if (record.ordinal !== null) {
      if (record.ordinal <= next.lastOrdinal) continue;
      next.lastOrdinal = record.ordinal;
    }
    applyRecord(draft, record, next, agentId);
  }
  return { update: draft.done(), cursor: next };
}

export function feedFromCodexRollout(
  records: readonly RolloutRecord[],
  options: { limit?: number; historyStart?: number } = {},
): { state: FeedState; cursor: CodexCursor } {
  const start: CodexCursor = { ...emptyCodexCursor(), lastOrdinal: (options.historyStart ?? 0) - 1 };
  const { update, cursor } = applyCodexRecords(emptyFeedState(), records, start);
  let { state } = update;
  const conversational = records.some((record) => record.type === 'response_item' || (record.type === 'event_msg' && str(record.payload, 'type') !== 'token_count'));
  if (!cursor.modern && conversational) {
    const note: FeedError = { id: 'error:codex-history', at: records[0]?.at ?? new Date(0).toISOString(), kind: 'error', error: CODEX_HISTORY_IN_TERMINAL, message: CODEX_HISTORY_MESSAGE };
    state = { ...state, items: [note, ...state.items] };
  }
  if (options.limit !== undefined && state.items.length > options.limit) state = { ...state, items: state.items.slice(-options.limit) };
  return { state, cursor };
}
```

Экспорт в `packages/core/src/feed/index.ts`:

```ts
export { applyCodexRecords, CODEX_HISTORY_IN_TERMINAL, CODEX_HISTORY_MESSAGE, commandText, emptyCodexCursor, feedFromCodexRollout } from './codex/apply-codex.js';
export type { CodexCursor } from './codex/apply-codex.js';
export { parseRolloutLine, rolloutRecordOf } from './codex/rollout-record.js';
export type { RolloutRecord } from './codex/rollout-record.js';
```

Если у `FeedError` нет поля `message: string | null` в виде, как выше, — привести к его типу (`packages/core/src/feed/types.ts`, `FeedError`). Если тип `FeedNoticeData` для `session-start` требует `source: string | null` — `'codex'` подходит.

- [ ] **Step 6: Прогнать**

Run: `pnpm -C packages/core exec vitest run src/feed`
Expected: PASS — новые тесты и все прежние тесты ленты Claude (экспорт `closeTurn`/`withChild` поведение не меняет).

- [ ] **Step 7: Коммит**

```bash
git add packages/core/src/feed
git commit -m "feat(core): лента Codex из журнала сессии — промпты, ответы, команды, правки, MCP, ходы" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Агенты Codex в ленте

**Files:**
- Create: `packages/core/src/feed/codex/codex-agents.ts`
- Modify: `packages/core/src/feed/codex/apply-codex.ts` (`onItem`: `SubAgentActivity`, `CollabAgentToolCall`)
- Create: `packages/core/src/feed/fixtures/codex-parent.rollout.jsonl`, `packages/core/src/feed/fixtures/codex-child.rollout.jsonl`
- Modify: `packages/core/src/feed/index.ts` (экспорт)
- Test: `packages/core/src/feed/codex/codex-agents.test.ts`

**Interfaces:**
- Consumes: `applyCodexRecords`, `feedFromCodexRollout`, `CodexCursor` (задача 11); из `reduce.ts`: `agentById`, `finishAgent(agent, status, at)`, `withResult(agent, value)`, `limitText`.
- Produces:
```ts
export interface CodexAgentMeta {
  threadId: string | null; parentThreadId: string | null; nickname: string | null; role: string | null;
  model: string | null; historyStart: number; task: string | null; result: string | null;
}
export const emptyCodexAgentMeta: () => CodexAgentMeta;
/** Сведения из журнала агента; `prior` — уже собранное с прошлых чтений (хвостом). */
export function codexAgentMeta(records: readonly RolloutRecord[], prior?: CodexAgentMeta): CodexAgentMeta;
/** Сведения — в карточку агента: тип, описание, модель, задание, итог. */
export function withCodexAgentMeta(state: FeedState, agentId: string, meta: CodexAgentMeta): FeedUpdate;
```

- [ ] **Step 1: Фикстуры**

`codex-parent.rollout.jsonl`:

```jsonl
{"timestamp":"2026-10-07T11:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"th-parent","cwd":"/tmp/p","cli_version":"0.160.0","source":"cli"}}
{"timestamp":"2026-10-07T11:00:01.000Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"u1"}}
{"timestamp":"2026-10-07T11:00:02.000Z","ordinal":2,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-parent","turn_id":"u1","item":{"type":"SubAgentActivity","id":"sa1","kind":"started","agent_thread_id":"th-child","agent_path":"/root/explorer"}}}
{"timestamp":"2026-10-07T11:00:03.000Z","ordinal":3,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-parent","turn_id":"u1","item":{"type":"SubAgentActivity","id":"sa2","kind":"interacted","agent_thread_id":"th-child","agent_path":"/root/explorer"}}}
{"timestamp":"2026-10-07T11:00:09.000Z","ordinal":4,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-parent","turn_id":"u1","item":{"type":"CollabAgentToolCall","id":"cw1","tool":"wait","status":"completed","sender_thread_id":"th-parent","receiver_thread_ids":["th-child"],"receiver_agents":[],"agents_states":{}}}}
{"timestamp":"2026-10-07T11:00:10.000Z","ordinal":5,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-parent","turn_id":"u1","item":{"type":"SubAgentActivity","id":"sa3","kind":"completed","agent_thread_id":"th-child","agent_path":"/root/explorer"}}}
```

`codex-child.rollout.jsonl` (ordinal 1–2 — копия истории родителя, своё — с 3):

```jsonl
{"timestamp":"2026-10-07T11:00:02.000Z","ordinal":0,"type":"session_meta","payload":{"id":"th-child","parent_thread_id":"th-parent","forked_from_id":"th-parent","agent_nickname":"explorer","subagent_history_start_ordinal":3,"source":{"subagent":{"thread_spawn":{"parent_thread_id":"th-parent","depth":1,"agent_path":"/root/explorer","agent_nickname":"explorer","agent_role":"explorer"}}}}}
{"timestamp":"2026-10-07T11:00:02.000Z","ordinal":1,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-parent","turn_id":"u0","item":{"type":"CommandExecution","id":"parent_old","command":["ls"],"cwd":"/tmp/p","parsed_cmd":[],"source":"agent","status":"completed","aggregated_output":"","exit_code":0}}}
{"timestamp":"2026-10-07T11:00:02.000Z","ordinal":2,"type":"response_item","payload":{"type":"agent_message","author":"/root","recipient":"/root/explorer","content":[{"type":"input_text","text":"старое сообщение из истории"}]}}
{"timestamp":"2026-10-07T11:00:02.100Z","ordinal":3,"type":"turn_context","payload":{"turn_id":"c1","model":"gpt-6-mini","approval_policy":"on-request"}}
{"timestamp":"2026-10-07T11:00:02.200Z","ordinal":4,"type":"response_item","payload":{"type":"agent_message","author":"/root","recipient":"/root/explorer","content":[{"type":"input_text","text":"Найди все места, где строится карточка агента, и перечисли файлы со строками"}]}}
{"timestamp":"2026-10-07T11:00:04.000Z","ordinal":5,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-child","turn_id":"c1","item":{"type":"CommandExecution","id":"child_cmd","command":["/bin/zsh","-lc","rg -n newAgent packages/core/src"],"cwd":"/tmp/p","parsed_cmd":[],"source":"agent","status":"completed","aggregated_output":"reduce.ts:452","exit_code":0}}}
{"timestamp":"2026-10-07T11:00:08.000Z","ordinal":6,"type":"event_msg","payload":{"type":"item_completed","thread_id":"th-child","turn_id":"c1","item":{"type":"AgentMessage","id":"child_final","phase":"final_answer","content":[{"type":"text","text":"Нашёл: reduce.ts:452"}]}}}
```

- [ ] **Step 2: Падающие тесты**

```ts
// packages/core/src/feed/codex/codex-agents.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FeedAgent, FeedTool } from '../types.js';
import { applyCodexRecords, emptyCodexCursor, feedFromCodexRollout } from './apply-codex.js';
import { codexAgentMeta, withCodexAgentMeta } from './codex-agents.js';
import { parseRolloutLine, type RolloutRecord } from './rollout-record.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const records = (name: string): RolloutRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.rollout.jsonl`), 'utf8').split('\n').map(parseRolloutLine).filter((r): r is RolloutRecord => r !== null);
const agentOf = (items: readonly unknown[]): FeedAgent => items.find((item) => (item as FeedAgent).kind === 'agent') as FeedAgent;

describe('агенты Codex в ленте родителя', () => {
  it('SubAgentActivity started — карточка с agentId = id треда; completed — done; interacted — без изменений', () => {
    const { state } = feedFromCodexRollout(records('codex-parent'));
    const agent = agentOf(state.items);
    expect(agent).toMatchObject({ id: 'agent:th-child', agentId: 'th-child', toolUseId: 'th-child', status: 'done' });
    expect(state.items.filter((item) => item.kind === 'agent')).toHaveLength(1);
  });

  it('CollabAgentToolCall wait — вызов с получателями', () => {
    const { state } = feedFromCodexRollout(records('codex-parent'));
    const wait = state.items.find((item) => item.kind === 'tool') as FeedTool;
    expect(wait).toMatchObject({ name: 'wait', status: 'done', input: { receivers: ['th-child'] } });
  });
});

describe('журнал агента', () => {
  const child = records('codex-child');

  it('сведения: роль, прозвище, модель, отметка истории, задание после отметки, итог', () => {
    expect(codexAgentMeta(child)).toEqual({
      threadId: 'th-child', parentThreadId: 'th-parent', nickname: 'explorer', role: 'explorer', model: 'gpt-6-mini', historyStart: 3,
      task: 'Найди все места, где строится карточка агента, и перечисли файлы со строками', result: 'Нашёл: reduce.ts:452',
    });
  });

  it('сведения хвостом: prior сохраняется, новое дописывается', () => {
    const head = codexAgentMeta(child.slice(0, 5));
    expect(head.result).toBeNull();
    expect(codexAgentMeta(child.slice(5), head)).toMatchObject({ task: head.task, result: 'Нашёл: reduce.ts:452', historyStart: 3 });
  });

  it('вызовы агента — в children с отметки истории; сведения — в карточку', () => {
    const parent = feedFromCodexRollout(records('codex-parent').slice(0, 3)).state;
    const meta = codexAgentMeta(child);
    const withMeta = withCodexAgentMeta(parent, 'th-child', meta).state;
    const { update } = applyCodexRecords(withMeta, child, { ...emptyCodexCursor(), lastOrdinal: meta.historyStart - 1 }, 'th-child');
    const agent = agentOf(update.state.items);
    expect(agent).toMatchObject({ agentType: 'explorer', description: 'explorer', model: 'gpt-6-mini', result: 'Нашёл: reduce.ts:452' });
    expect(agent.prompt).toBe(meta.task);
    expect(agent.children.map((call) => call.toolUseId)).toEqual(['child_cmd']);
    expect(agent.toolCount).toBe(1);
  });

  it('снимок агента — лента его журнала с отметки истории, без копии родителя', () => {
    const meta = codexAgentMeta(child);
    const { state } = feedFromCodexRollout(child, { historyStart: meta.historyStart });
    expect(state.items.some((item) => item.kind === 'tool' && item.toolUseId === 'parent_old')).toBe(false);
    expect(state.items.some((item) => item.kind === 'tool' && item.toolUseId === 'child_cmd')).toBe(true);
  });

  it('карточки нет — withCodexAgentMeta ничего не меняет', () => {
    const empty = feedFromCodexRollout([]).state;
    expect(withCodexAgentMeta(empty, 'th-x', codexAgentMeta(child)).changes).toEqual([]);
  });
});
```

- [ ] **Step 3: Прогнать — падают**

Run: `pnpm -C packages/core exec vitest run src/feed/codex/codex-agents.test.ts`
Expected: FAIL — нет `./codex-agents.js`; карточек агентов нет.

- [ ] **Step 4: Реализация `codex-agents.ts`**

```ts
// packages/core/src/feed/codex/codex-agents.ts
/**
 * Агенты Codex (спека 2026-10-07, 3 п. 10–11 и 5.2). Карточку ставит `SubAgentActivity started` в журнале родителя:
 * `agentId` — id треда агента. У агента свой журнал: в начале — копия истории родителя до
 * `subagent_history_start_ordinal`, своё — после неё. Задание — первое межагентное сообщение агенту после отметки
 * (`response_item/agent_message`), итог — последний `AgentMessage` с фазой `final_answer`, тип — `agent_role`, иначе
 * прозвище, модель — `turn_context` агента.
 */

import { agentById, FeedDraft, limitText, withResult } from '../reduce.js';
import { FEED_AGENT_TEXT_LIMIT, type FeedAgent, type FeedState, type FeedUpdate } from '../types.js';
import type { RolloutRecord } from './rollout-record.js';

export interface CodexAgentMeta {
  threadId: string | null;
  parentThreadId: string | null;
  nickname: string | null;
  role: string | null;
  model: string | null;
  historyStart: number;
  task: string | null;
  result: string | null;
}

export const emptyCodexAgentMeta = (): CodexAgentMeta => ({
  threadId: null, parentThreadId: null, nickname: null, role: null, model: null, historyStart: 0, task: null, result: null,
});

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: Json | null | undefined, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.filter(isRecord).map((part) => (typeof part['text'] === 'string' ? part['text'] : '')).filter(Boolean).join('\n') : '';

function spawnOf(payload: Json): Json | null {
  const source = payload['source'];
  const subagent = isRecord(source) ? source['subagent'] : null;
  const spawn = isRecord(subagent) ? subagent['thread_spawn'] : null;
  return isRecord(spawn) ? spawn : null;
}

export function codexAgentMeta(records: readonly RolloutRecord[], prior: CodexAgentMeta = emptyCodexAgentMeta()): CodexAgentMeta {
  const meta: CodexAgentMeta = { ...prior };
  for (const record of records) {
    const payload = record.payload;
    if (record.type === 'session_meta') {
      if (meta.threadId !== null) continue;
      const spawn = spawnOf(payload);
      meta.threadId = str(payload, 'id');
      meta.parentThreadId = str(payload, 'parent_thread_id') ?? str(spawn, 'parent_thread_id');
      meta.nickname = str(payload, 'agent_nickname') ?? str(spawn, 'agent_nickname');
      meta.role = str(spawn, 'agent_role');
      const start = payload['subagent_history_start_ordinal'];
      if (typeof start === 'number' && Number.isFinite(start)) meta.historyStart = start;
      continue;
    }
    if (record.ordinal !== null && record.ordinal < meta.historyStart) continue;
    if (record.type === 'turn_context') {
      meta.model = str(payload, 'model') ?? meta.model;
    } else if (record.type === 'response_item' && str(payload, 'type') === 'agent_message' && meta.task === null) {
      const text = textOf(payload['content']);
      if (text !== '') meta.task = text;
    } else if (record.type === 'event_msg' && str(payload, 'type') === 'item_completed') {
      const item = payload['item'];
      if (isRecord(item) && str(item, 'type') === 'AgentMessage' && str(item, 'phase') === 'final_answer') {
        const text = textOf(item['content']);
        if (text !== '') meta.result = text;
      }
    }
  }
  return meta;
}

export function withCodexAgentMeta(state: FeedState, agentId: string, meta: CodexAgentMeta): FeedUpdate {
  const draft = new FeedDraft(state);
  const agent = agentById(draft, agentId);
  if (agent === undefined) return draft.done();
  let next: FeedAgent = {
    ...agent,
    agentType: meta.role ?? meta.nickname ?? agent.agentType,
    description: meta.nickname ?? agent.description,
    model: meta.model ?? agent.model,
  };
  if (meta.task !== null) {
    const { text, truncated } = limitText(meta.task, FEED_AGENT_TEXT_LIMIT);
    next = { ...next, prompt: text, ...(truncated ? { truncated: true } : {}) };
  }
  if (meta.result !== null) next = withResult(next, meta.result);
  draft.put(next);
  return draft.done();
}
```

Если `withResult` или `limitText` в `reduce.ts` не экспортированы — экспортировать (по отчёту разведки оба экспортированы).

- [ ] **Step 5: Ветки агентов в `apply-codex.ts`**

В `onItem` перед `default:`:

```ts
    case 'SubAgentActivity': {
      if (agentId !== null) return;
      const thread = str(item, 'agent_thread_id');
      if (thread === null) return;
      const kind = str(item, 'kind');
      const known = agentById(draft, thread);
      if (kind === 'started') {
        if (known === undefined) {
          const card: FeedAgent = {
            id: `agent:${thread}`, at: endAt, kind: 'agent', toolUseId: thread, agentId: thread, agentType: null, description: null,
            prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [],
          };
          draft.put(card);
        }
        return;
      }
      if (known !== undefined && known.status === 'running' && (kind === 'completed' || kind === 'interrupted')) {
        draft.put(finishAgent(known, kind === 'completed' ? 'done' : 'failed', endAt));
      }
      return;
    }
    case 'CollabAgentToolCall': {
      const tool = str(item, 'tool');
      if (tool === null || tool === 'spawn_agent') return;
      const receivers = Array.isArray(item['receiver_thread_ids']) ? item['receiver_thread_ids'].filter((id) => typeof id === 'string') : [];
      const prompt = str(item, 'prompt');
      putTool(draft, agentId, finishTool(newTool(id, tool, { receivers, ...(prompt === null ? {} : { prompt }) }, startAt, agentId), statusOf(item), undefined, endAt));
      return;
    }
```
Импорт `finishAgent` из `../reduce.js` и тип `FeedAgent`. Экспорт в `feed/index.ts`: `codexAgentMeta`, `emptyCodexAgentMeta`, `withCodexAgentMeta`, тип `CodexAgentMeta`. Если `finishAgent` в журнале агента ставит `durationMs` от `at` карточки — оставить как есть.

- [ ] **Step 6: Прогнать**

Run: `pnpm -C packages/core exec vitest run src/feed`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add packages/core/src/feed
git commit -m "feat(core): агенты Codex — карточка по SubAgentActivity, сведения и вызовы из журнала агента" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Хост — чтение журнала хвостом и журналы агентов

**Files:**
- Create: `packages/host/src/feed/codex-source.ts`
- Modify: `packages/host/src/activity/log-index.ts:27` (интерфейс), `:54-110` (реализация `childLogs`)
- Modify: `packages/host/src/activity/activity-service.ts:101, 885` (`childLogFile`)
- Test: `packages/host/src/feed/codex-source.test.ts`, `packages/host/src/activity/log-index.test.ts`

**Interfaces:**
- Consumes: `parseRolloutLine`, `RolloutRecord` из `@parley/core` (задачи 10–11).
- Produces:
```ts
// feed/codex-source.ts
export const ROLLOUT_SEED_MAX_BYTES = 32 * 1024 * 1024;
export interface RolloutTail {
  readonly file: string;
  /** Новые законченные строки с прошлого вызова; первый вызов — с начала (или с хвоста не больше `seedMaxBytes`). Файла нет — []. */
  read(): Promise<RolloutRecord[]>;
}
export function createRolloutTail(file: string, options?: { seedMaxBytes?: number }): RolloutTail;
// LogIndex
childLogs(session: WorkSession): Array<{ threadId: string; file: string }>;
// ActivityService
childLogFile(ref: SessionRef, threadId: string): string | null;
```

- [ ] **Step 1: Падающие тесты хвоста (Review Focus 2)**

```ts
// packages/host/src/feed/codex-source.test.ts
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRolloutTail } from './codex-source.js';

const line = (ordinal: number, text = 'x'): string =>
  JSON.stringify({ timestamp: '2026-10-07T10:00:00.000Z', ordinal, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: `m${ordinal}`, content: [{ type: 'text', text }] } } });

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'codex-tail-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createRolloutTail', () => {
  it('файла нет — пусто; появился — читается с начала', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    const tail = createRolloutTail(file);
    expect(await tail.read()).toEqual([]);
    await writeFile(file, `${line(0)}\n${line(1)}\n`);
    expect((await tail.read()).map((record) => record.ordinal)).toEqual([0, 1]);
    expect(await tail.read()).toEqual([]);
  });

  it('строка разрезана между записями — один элемент, целиком (Review Focus 2)', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    const full = line(5, 'кириллица и длинный текст '.repeat(20));
    const cut = Buffer.from(full, 'utf8');
    await writeFile(file, `${line(4)}\n`);
    await appendFile(file, cut.subarray(0, 101)); // режем посреди многобайтового символа
    const tail = createRolloutTail(file);
    expect((await tail.read()).map((record) => record.ordinal)).toEqual([4]);
    await appendFile(file, Buffer.concat([cut.subarray(101), Buffer.from('\n')]));
    const next = await tail.read();
    expect(next.map((record) => record.ordinal)).toEqual([5]);
    expect(JSON.stringify(next[0]?.payload)).toContain('кириллица');
  });

  it('файл стал короче (пересоздан) — чтение с начала', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, `${line(0)}\n${line(1)}\n${line(2)}\n`);
    const tail = createRolloutTail(file);
    await tail.read();
    await writeFile(file, `${line(9)}\n`);
    expect((await tail.read()).map((record) => record.ordinal)).toEqual([9]);
  });

  it('первое чтение большого файла — только хвост, первая неполная строка отброшена', async () => {
    const file = path.join(dir, 'rollout.jsonl');
    await writeFile(file, Array.from({ length: 100 }, (_, n) => line(n)).join('\n') + '\n');
    const tail = createRolloutTail(file, { seedMaxBytes: 2_000 });
    const records = await tail.read();
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(100);
    expect(records.at(-1)?.ordinal).toBe(99);
  });
});
```

- [ ] **Step 2: Падающий тест `childLogs`**

В `log-index.test.ts` рядом с `writeThread` (около строки 204) добавить тест: родитель `th-parent` (сессия работы с `providerSessionId: 'th-parent'`, провайдер `codex`) и два журнала с `payload.parent_thread_id: 'th-parent'` (`writeThread('th-a', 1, { parent_thread_id: 'th-parent' })`, `writeThread('th-b', 1, { parent_thread_id: 'th-parent' })`) и один чужой. Ожидать:

```ts
expect(index.childLogs(parentSession).map((child) => child.threadId).sort()).toEqual(['th-a', 'th-b']);
expect(index.childLogs(parentSession).every((child) => child.file.endsWith('.jsonl'))).toBe(true);
expect(index.childLogs(sessionWithoutLog)).toEqual([]);
```
(Сессии работы и запуск индекса — как в соседних тестах файла.)

- [ ] **Step 3: Прогнать — падают**

Run: `pnpm --filter @parley/core build && pnpm -C packages/host exec vitest run src/feed/codex-source.test.ts src/activity/log-index.test.ts`
Expected: FAIL — нет `codex-source.js`, нет `childLogs`.

- [ ] **Step 4: Реализация хвоста**

```ts
// packages/host/src/feed/codex-source.ts
/**
 * Журнал Codex хвостом (спека 2026-10-07, 5.3): с запомненной позиции байтов; неполная последняя строка (в том числе
 * разрезанная посреди многобайтового символа) ждёт продолжения — остаток хранится байтами. Файл стал короче
 * (пересоздан) — чтение с начала. Первое чтение большого файла — только хвост не больше `seedMaxBytes`: первая неполная
 * строка хвоста отбрасывается.
 */

import { open } from 'node:fs/promises';
import { parseRolloutLine, type RolloutRecord } from '@parley/core';

export const ROLLOUT_SEED_MAX_BYTES = 32 * 1024 * 1024;

export interface RolloutTail {
  readonly file: string;
  read(): Promise<RolloutRecord[]>;
}

export function createRolloutTail(file: string, options: { seedMaxBytes?: number } = {}): RolloutTail {
  const seedMax = options.seedMaxBytes ?? ROLLOUT_SEED_MAX_BYTES;
  let offset = -1;
  let rest: Buffer = Buffer.alloc(0);
  return {
    file,
    async read() {
      let handle;
      try {
        handle = await open(file, 'r');
      } catch {
        return [];
      }
      try {
        const { size } = await handle.stat();
        let dropFirst = false;
        if (offset === -1) {
          offset = size > seedMax ? size - seedMax : 0;
          dropFirst = offset > 0;
        } else if (size < offset) {
          offset = 0;
          rest = Buffer.alloc(0);
        }
        if (size === offset) return [];
        const chunk = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        offset += bytesRead;
        let data = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
        if (dropFirst) {
          const first = data.indexOf(0x0a);
          data = first === -1 ? Buffer.alloc(0) : data.subarray(first + 1);
        }
        const end = data.lastIndexOf(0x0a);
        if (end === -1) {
          rest = data;
          return [];
        }
        rest = Buffer.from(data.subarray(end + 1));
        return data
          .subarray(0, end)
          .toString('utf8')
          .split('\n')
          .map(parseRolloutLine)
          .filter((record): record is RolloutRecord => record !== null);
      } finally {
        await handle.close();
      }
    },
  };
}
```

- [ ] **Step 5: `childLogs` и `childLogFile`**

```ts
// packages/host/src/activity/log-index.ts — в интерфейс LogIndex
  /** Журналы прямых субагентов треда Codex этой сессии (`parent_thread_id`); у сессии без журнала — []. */
  childLogs(session: WorkSession): Array<{ threadId: string; file: string }>;
// реализация (рядом с indexOf/descendantsOf)
    childLogs(session) {
      if (session.provider !== 'codex') return [];
      const root = indexOf(session);
      if (root === undefined) return [];
      return (byParent.get(logKey('codex', root.id)) ?? []).map((child) => ({ threadId: child.id, file: child.file }));
    },
```
```ts
// packages/host/src/activity/activity-service.ts — интерфейс (рядом с logFile, :101)
  /** Журнал субагента Codex по id его треда; не найден — null. */
  childLogFile(ref: SessionRef, threadId: string): string | null;
// реализация (рядом с logFile, :885)
    childLogFile(ref, threadId) {
      const session = works.entry(ref.projectPath, ref.workId)?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return null;
      return logIndex.childLogs(session).find((child) => child.threadId === threadId)?.file ?? null;
    },
```
Если у `SessionIndex` путь к файлу называется не `file` — взять его имя из типа `SessionIndex` (`core/src/session-index.ts`). Фейки `ActivityService` в тестах хоста (поиск `logFile:` в `packages/host/test` и `*.test.ts`) получают `childLogFile: () => null`.

- [ ] **Step 6: Прогнать**

Run: `pnpm -C packages/host exec vitest run src/feed/codex-source.test.ts src/activity && pnpm -C packages/host exec tsc -p tsconfig.json --noEmit`
Expected: PASS; exit 0.

- [ ] **Step 7: Коммит**

```bash
git add packages/host/src packages/host/test
git commit -m "feat(host): журнал Codex хвостом и журналы субагентов по id треда" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Хост — лента Codex в службе ленты

**Files:**
- Modify: `packages/host/src/feed/feed-service.ts` (`FeedServiceDeps.activity` — `childLogFile`; `SessionFeed.codex`; `seed`, `seedAside`, `onLogChange`, `agentSnapshot`, `interrupt`; опрос раз в 2 с)
- Modify: `packages/host/src/server.ts:34` (`HOST_FEATURES` + `FEED_CODEX_FEATURE`)
- Modify: `packages/host/test/feed-fakes.ts` (`childLogFile`, `setChildLogFile`)
- Test: `packages/host/src/feed/feed-service.test.ts`

**Interfaces:**
- Consumes: `createRolloutTail` (задача 13), `activity.logFile`, `activity.childLogFile` (задача 13), из `@parley/core`: `feedFromCodexRollout`, `applyCodexRecords`, `codexAgentMeta`, `withCodexAgentMeta`, `emptyCodexCursor`, `emptyCodexAgentMeta`; `FEED_CODEX_FEATURE` из `@parley/protocol`.
- Produces: снимок и дельты ленты сессии Codex; `hello.features` содержит `'feed-codex'`.

Состояние Codex в записи сессии:

```ts
interface CodexAgentTrack { tail: ReturnType<typeof createRolloutTail> | null; cursor: CodexCursor; meta: CodexAgentMeta; done: boolean }
interface CodexFeed { tail: ReturnType<typeof createRolloutTail>; cursor: CodexCursor; agents: Map<string, CodexAgentTrack> }
// в SessionFeed: codex?: CodexFeed
```

- [ ] **Step 1: Фейки**

В `packages/host/test/feed-fakes.ts`: `deps.activity.childLogFile(ref, threadId)` берёт путь из карты, которую задаёт `setChildLogFile(threadId, file, ref = REF)`.

- [ ] **Step 2: Падающие тесты**

В `feed-service.test.ts` — новый `describe('лента Codex', …)`; сессия `fakeFeedDeps([{ ref: REF, provider: 'codex' }])`; журнал — временный файл (`mkdtemp` в `tmpdir()`, путь в `tempDirs`), путь — `fakes.setLogFile(REF, file)`. Строки — функцией, как в фикстурах задачи 11. Тесты:

```ts
it('снимок — лента из журнала Codex', async () => {
  await writeRollout(file, [meta('th-main'), started(1), userMessage(2, 'um1', 'Почини тесты'), command(3, 'c1', 'ls'), complete(4)]);
  start();
  const snapshot = await service.snapshot(REF);
  expect(snapshot.items.map((item) => item.kind)).toEqual(['prompt', 'tool', 'turn']);
});

it('дописанные строки приходят дельтой по изменению журналов', async () => {
  await writeRollout(file, [meta('th-main'), started(1)]);
  start();
  const client = fakeClient();
  service.subscribe(REF, client);
  await service.snapshot(REF);
  await appendRollout(file, [userMessage(2, 'um1', 'go')]);
  fakes.emitLog();
  await vi.waitFor(() => expect(feedChanged(client).flatMap((delta) => delta.upsert.map((item) => item.kind))).toContain('prompt'));
});

it('рестарт хоста посреди хода: процесса нет — ход закрыт Interrupted; процесс жив — не закрыт (Review Focus 5)', async () => {
  await writeRollout(file, [meta('th-main'), started(1), userMessage(2, 'um1', 'go'), command(3, 'c1', 'sleep 100')]);
  fakes.setProcess(null);
  start();
  const dead = await service.snapshot(REF);
  expect(dead.items.at(-1)).toMatchObject({ kind: 'turn', interrupted: true });
  await service.stop();
  fakes = fakeFeedDeps([{ ref: REF, provider: 'codex' }]);
  fakes.setLogFile(REF, file);
  fakes.setProcess({ pid: 42 });
  start();
  const alive = await service.snapshot(REF);
  expect(alive.items.some((item) => item.kind === 'turn')).toBe(false);
});

it('агент Codex: карточка, сведения и вызовы из его журнала; снимок агента — его лента', async () => {
  await writeRollout(file, [meta('th-main'), started(1), subagent(2, 'th-child', 'started')]);
  const childFile = path.join(dir, 'child.jsonl');
  await writeRollout(childFile, [childMeta('th-child', 'th-main', 3), parentCopy(1), parentCopy(2), task(3, 'Найди newAgent'), command(4, 'cc1', 'rg newAgent')]);
  fakes.setChildLogFile('th-child', childFile);
  start();
  await service.snapshot(REF);
  await vi.waitFor(async () => {
    const card = (await service.snapshot(REF)).items.find((item) => item.kind === 'agent');
    expect(card).toMatchObject({ prompt: 'Найди newAgent', toolCount: 1 });
  });
  const sub = await service.snapshot(REF, 'th-child');
  expect(sub.items.some((item) => item.kind === 'tool' && item.toolUseId === 'cc1')).toBe(true);
});

it('Stop у Codex — только Esc, без стирания промпта', () => {
  fakes.setProcess({ pid: 42 });
  start();
  service.interrupt(REF);
  expect(fakes.writes()).toEqual(['\x1b']);
});
```
Функции строк (`meta`, `started`, `complete`, `userMessage`, `command`, `subagent`, `childMeta`, `parentCopy`, `task`) и `writeRollout`/`appendRollout` — в начале `describe`, формы — как в фикстурах `codex-main`/`codex-parent`/`codex-child` задачи 11–12. Если `fakes.writes()` возвращает другой формат — сверить с существующим тестом `interrupt` в этом файле.

Тест признака:

```ts
// packages/host/src/server.test.ts (или где тестируется hello) — добавить
expect(hello.features).toContain('feed-codex');
```

- [ ] **Step 3: Прогнать — падают**

Run: `pnpm --filter @parley/core build && pnpm -C packages/host exec vitest run src/feed/feed-service.test.ts src/server.test.ts`
Expected: FAIL.

- [ ] **Step 4: Реализация в `feed-service.ts`**

1. `FeedServiceDeps.activity`: `Pick<ActivityService, 'onChange' | 'logFile' | 'childLogFile' | 'questionHeld' | 'onLogChange'>`.
2. В `seed(feed, provider)` (`:481`) — ветка Codex до Claude:

```ts
    if (provider === 'codex') return seedCodex(feed);
```
```ts
  function seedCodex(feed: SessionFeed): Promise<void> {
    if (feed.seeding !== undefined) return feed.seeding;
    const file = deps.activity.logFile(feed.ref);
    if (file === null) return Promise.resolve();
    feed.seeding = (async () => {
      try {
        const tail = createRolloutTail(file);
        const records = await tail.read();
        if (stopped) return;
        const seeded = feedFromCodexRollout(records, { limit: maxItems });
        // Ход, оборванный в журнале, закрывается только без живого процесса: у живого он ещё идёт (рестарт хоста — процесс умер с ним).
        const state = deps.pty.get(feed.ref) === undefined ? closeBrokenTurn(seeded.state) : seeded.state;
        feed.state = state;
        feed.codex = { tail, cursor: seeded.cursor, agents: new Map() };
        feed.sizes = new Map();
        feed.bytes = 0;
        for (const item of state.items) { const size = itemBytes(item); feed.sizes.set(item.id, size); feed.bytes += size; }
        trim(feed, false);
        if (seeded.cursor.skipped > 0) log.info('лента Codex: пропущены незнакомые элементы', { sessionId: feed.ref.sessionId, skipped: seeded.cursor.skipped });
      } catch (error) {
        log.warn('лента Codex: журнал не прочитан', { sessionId: feed.ref.sessionId, error: String(error) });
      } finally {
        feed.seeded = true;
        feed.seeding = undefined;
      }
      await syncCodexAgents(feed);
    })();
    return feed.seeding;
  }
```
`closeBrokenTurn` — та же функция, что у Claude (`:520`).

3. Хвост и агенты:

```ts
  async function pollCodex(feed: SessionFeed): Promise<void> {
    const codex = feed.codex;
    if (codex === undefined || stopped) return;
    const records = await codex.tail.read();
    if (records.length > 0) {
      const { update, cursor } = applyCodexRecords(feed.state, records, codex.cursor);
      codex.cursor = cursor;
      commit(feed, update);
    }
    await syncCodexAgents(feed);
  }

  async function syncCodexAgents(feed: SessionFeed): Promise<void> {
    const codex = feed.codex;
    if (codex === undefined) return;
    for (const item of feed.state.items) {
      if (item.kind !== 'agent' || item.agentId === null) continue;
      let track = codex.agents.get(item.agentId);
      if (track?.done === true) continue;
      if (track === undefined) {
        track = { tail: null, cursor: emptyCodexCursor(), meta: emptyCodexAgentMeta(), done: false };
        codex.agents.set(item.agentId, track);
      }
      if (track.tail === null) {
        const file = deps.activity.childLogFile(feed.ref, item.agentId);
        if (file === null) continue;
        track.tail = createRolloutTail(file);
      }
      const records = await track.tail.read();
      if (records.length > 0) {
        const firstRead = track.meta.threadId === null;
        track.meta = codexAgentMeta(records, track.meta);
        if (firstRead) track.cursor = { ...track.cursor, lastOrdinal: track.meta.historyStart - 1 };
        commit(feed, withCodexAgentMeta(feed.state, item.agentId, track.meta));
        const { update, cursor } = applyCodexRecords(feed.state, records, track.cursor, item.agentId);
        track.cursor = cursor;
        commit(feed, update);
      }
      if (item.status !== 'running') track.done = true;
    }
  }
```
4. `seedAside` (`:594`): заменить `if (!isClaudeCode(provider)) return;` на

```ts
    if (provider === 'codex') {
      const feed = feedOf(ref);
      if (feed.codex !== undefined) { await pollCodex(feed); flush(feed); return; }
    } else if (!isClaudeCode(provider)) return;
```
(остальное — как было: для Codex без `feed.codex` идёт обычный сев через `seed`, который уже знает ветку Codex).

5. Опрос: в `subscribe` — для сессии Codex, пока есть подписчики и процесс жив, таймер `setInterval(() => void pollCodex(feed).then(() => flush(feed)), 2000)`, `unref()`; снимается в `unsubscribe`, `dropClient` и `stop`. Хранить таймер в `SessionFeed` (`codexPoll?: NodeJS.Timeout`).
6. `agentSnapshot` (`:650`): для Codex (провайдер сессии — через `sessionOf(ref).provider`):

```ts
      const file = deps.activity.childLogFile(ref, agentId);
      if (file === null) throw notFound();
      const records = await createRolloutTail(file).read();
      const meta = codexAgentMeta(records);
      const { state } = feedFromCodexRollout(records, { limit: maxItems, historyStart: meta.historyStart });
      return { items: tailByBytes(state.items, maxBytes), revision: 0, schemaVersion: FEED_SCHEMA_VERSION, mode: state.permissionMode };
```
7. `interrupt` (`:876`): у Codex — `deps.pty.write(ref, ESC)` и выход, без таймера `settleInterrupt` (приглашение `❯` и стирание промпта — механика Claude; ход закроет `turn_aborted`).
8. `packages/host/src/server.ts:34`: `const HOST_FEATURES = [COMPACT_WORKS_FEATURE, FEED_CODEX_FEATURE];`.
9. Шапку `feed-service.ts` дополнить абзацем: «Лента Codex (спека 2026-10-07, 5.3): журнал хвостом (`codex-source.ts`), опрос раз в 2 с при подписчиках и живом процессе, агенты — по их журналам; оборванный ход сев закрывает только без живого процесса; Stop — Esc без разбора экрана».

- [ ] **Step 5: Прогнать**

Run: `pnpm -C packages/host exec vitest run src/feed src/server.test.ts && pnpm -C packages/host test`
Expected: PASS (флейки — по Global Constraints).

- [ ] **Step 6: Коммит**

```bash
git add packages/host
git commit -m "feat(host): лента Codex из журнала — сев, хвост, агенты, снимок агента, Stop; признак feed-codex" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Окно — Chat для Codex

**Files:**
- Modify: `packages/desktop/src/renderer/lib/feed-view.ts:42-68, 140-170` (гейт с признаком и версией Codex)
- Modify: `packages/desktop/src/shared/strings.ts:968` (подсказка для Codex)
- Modify: `packages/desktop/src/renderer/chat/ChatToolbar.tsx` (подсказка недоступности по провайдеру; меню у Codex — только подписи)
- Modify: `packages/desktop/src/renderer/layout/bodies/TerminalBody.tsx:35-50` (провайдер в тулбар)
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx` (Codex: без меню модели/effort/режима, без подсказок `/`, вложения списком)
- Modify: `packages/desktop/src/renderer/chat/items/ErrorItem.tsx` (код `codex-history-in-terminal` — строка окна и кнопка «Open terminal»)
- Modify: `packages/desktop/src/renderer/chat/feed-model.ts:45` (`PATH_TOOLS`: `Delete`, `ViewImage`)
- Test: `packages/desktop/src/renderer/lib/feed-view.test.ts`, `packages/desktop/src/renderer/chat/ChatView.test.tsx`, `packages/desktop/src/renderer/chat/ChatToolbar.test.tsx`, `packages/desktop/src/renderer/chat/items/items.test.tsx`

**Interfaces:**
- Consumes: `CODEX_FEED_MIN_VERSION`, `FEED_CODEX_FEATURE` (`@parley/protocol`, задача 9); `hostFeatures` (задача 9); `composeRoomMessage(text, paths)` (`components/rooms/attachments.ts:11`); `CODEX_HISTORY_IN_TERMINAL` — строкой `'codex-history-in-terminal'` (core в рендерер не импортируется).
- Produces:
```ts
export interface FeedAvailabilityInput { hostMethods: ReadonlySet<string>; features?: ReadonlySet<string>; provider: string; family?: 'claude' | null; version: string | null }
// strings
S.chat.terminalOnlyFor(provider: string): string; // 'Chat needs Codex 0.160.0 or newer' | прежний текст Claude
S.chat.codexHistoryInTerminal: 'Earlier history of this session is only in Terminal';
S.chat.openTerminal: 'Open terminal';
```

- [ ] **Step 1: Падающие тесты гейта**

```ts
// packages/desktop/src/renderer/lib/feed-view.test.ts — добавить
const FEED = new Set(['feed.snapshot']);
it('Codex: нужен признак feed-codex и версия не ниже 0.160.0', () => {
  const codex = { hostMethods: FEED, provider: 'codex', version: '0.160.0' };
  expect(feedAvailable({ ...codex, features: new Set(['feed-codex']) })).toBe(true);
  expect(feedAvailable({ ...codex, features: new Set() })).toBe(false);
  expect(feedAvailable({ ...codex, features: new Set(['feed-codex']), version: '0.159.0' })).toBe(false);
  expect(feedAvailable({ ...codex, features: new Set(['feed-codex']), version: null })).toBe(false);
});
it('Codex до загрузки провайдеров — неизвестно (null), как у Claude', () => {
  expect(feedAvailability({ hostMethods: FEED, features: new Set(['feed-codex']), provider: 'codex', version: null, loaded: false })).toBeNull();
});
it('Claude без признака — как раньше', () => {
  expect(feedAvailable({ hostMethods: FEED, provider: 'claude', family: 'claude', version: '2.1.289' })).toBe(true);
});
```

- [ ] **Step 2: Падающие тесты вида**

В `ChatView.test.tsx` — сессия `provider: 'codex'` (найти, как соседние тесты задают `provider`, `storedModel`, `storedEffort`) с лентой из `prompt` и `tool`:
- меню модели (кнопка с `aria-haspopup="menu"` у подписи модели) и меню режима **не** показываются; подпись модели из заметки `session-start` видна текстом;
- ввод `/` в поле не открывает список подсказок команд;
- отправка с вложением `'/tmp/a b.png'` зовёт `pty.send` с текстом `composeRoomMessage('hi', ['/tmp/a b.png'])`.

В `items.test.tsx`: элемент `{ kind: 'error', error: 'codex-history-in-terminal', message: '…' }` рисуется строкой `S.chat.codexHistoryInTerminal` и кнопкой `S.chat.openTerminal`.

- [ ] **Step 3: Прогнать — падают**

Run: `pnpm --filter "@parley/desktop^..." build && pnpm -C packages/desktop exec vitest run src/renderer/lib/feed-view.test.ts src/renderer/chat`
Expected: FAIL.

- [ ] **Step 4: Гейт**

```ts
// packages/desktop/src/renderer/lib/feed-view.ts
import { CODEX_FEED_MIN_VERSION, FEED_CODEX_FEATURE, FEED_MIN_VERSION } from '@parley/protocol';

export interface FeedAvailabilityInput {
  hostMethods: ReadonlySet<string>;
  /** Признаки хоста (`hello.features`); нет — хост до ленты Codex. */
  features?: ReadonlySet<string>;
  provider: string;
  family?: 'claude' | null | undefined;
  version: string | null;
}

export function feedAvailable({ hostMethods: methods, features, provider, family, version }: FeedAvailabilityInput): boolean {
  if (!methods.has('feed.snapshot')) return false;
  if (provider === 'codex') return (features?.has(FEED_CODEX_FEATURE) ?? false) && version !== null && atLeast(version, CODEX_FEED_MIN_VERSION);
  if (family !== 'claude' && !(family === undefined && provider === 'claude')) return false;
  return version !== null && atLeast(version, FEED_MIN_VERSION);
}

export function feedAvailability(input: FeedAvailabilityInput & { loaded: boolean }): boolean | null {
  if (!input.hostMethods.has('feed.snapshot')) return false;
  if (!input.loaded && (input.provider === 'claude' || input.provider === 'glm' || input.provider === 'codex' || input.family === 'claude')) return null;
  if (!input.loaded) return false;
  return feedAvailable(input);
}
```
В `useFeedAvailability` и `feedAvailableNow` — `features: hostFeatures(useHostStore… .status)` (в хуке — через `useHostStore((state) => state.status)` и `useMemo`).

- [ ] **Step 5: Тексты и тулбар**

```ts
// packages/desktop/src/shared/strings.ts, раздел chat
    terminalOnlyFor: (provider: string): string =>
      provider === 'codex' ? `Chat needs Codex ${CODEX_FEED_MIN_VERSION} or newer` : `Chat needs Claude Code ${FEED_MIN_VERSION} or newer`,
    codexHistoryInTerminal: 'Earlier history of this session is only in Terminal',
    openTerminal: 'Open terminal',
```
`terminalOnly` заменить вызовами `terminalOnlyFor(provider)`: `ChatToolbar` получает новый проп `provider: string` (его передают `TerminalBody` и `ChatView` — `session.provider` / `provider`).

- [ ] **Step 6: Вид Chat у Codex**

В `ChatView.tsx`:
- `const codex = provider === 'codex';`
- меню модели/effort: показывать только `!codex` (у Codex — подпись `модель · effort` текстом: модель — `currentModel(items)`, effort — `storedEffort`);
- меню режима: у Codex — подпись `mode` ленты текстом, без меню (`sessions.setMode` у Codex не зовётся);
- подсказки `/`: не открывать у Codex (условие в месте, где `Composer`/`use-suggestions` решают по первому символу — передать флаг `slashCommands={!codex}`);
- сборка текста отправки: `codex ? composeRoomMessage(text, paths) : composePrompt(text, paths)`;
- шапку `ChatView.tsx` дополнить абзацем: «Codex (спека 2026-10-07, 5.4): лента из журнала; меню модели, effort и режима — подписи; подсказок `/` нет; вложения — списком путей, как в комнате».

В `ErrorItem.tsx`: при `item.error === 'codex-history-in-terminal'` — строка `S.chat.codexHistoryInTerminal` и кнопка `S.chat.openTerminal`, которая переключает вкладку в вид Terminal тем же путём, что сегмент тулбара (`updateTab(…, { view: 'terminal' })` в `ChatToolbar.tsx` — взять оттуда).

- [ ] **Step 6a: Строка вызова для новых инструментов**

В `packages/desktop/src/renderer/chat/feed-model.ts:45` — `const PATH_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit', 'Delete', 'ViewImage']);`. Тест в `feed-model.test.ts`:

```ts
it('Delete и ViewImage Codex — строка с путём', () => {
  expect(toolHeadline('Delete', { file_path: '/tmp/p/old.ts' })).toEqual({ name: 'Delete', summary: '/tmp/p/old.ts' });
  expect(toolHeadline('ViewImage', { file_path: '/tmp/p/shot.png' })).toEqual({ name: 'ViewImage', summary: '/tmp/p/shot.png' });
});
```

- [ ] **Step 7: Прогнать**

Run: `pnpm -C packages/desktop exec vitest run src/renderer && pnpm -C packages/desktop typecheck`
Expected: PASS; exit 0.

- [ ] **Step 8: Коммит**

```bash
git add packages/desktop/src
git commit -m "feat(desktop): вид Chat у Codex — гейт по feed-codex и версии, подписи вместо меню, вложения списком" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Убрать подмену `notify` (по итогам задачи 7)

**Files:**
- Modify: `packages/core/src/providers.ts:146` (строки `'-c', '{notify}'`)
- Modify: `packages/core/src/work/launch.ts:346-349`
- Modify: `packages/core/src/work/mcp-config.ts:186` (`codexNotifyOverride`)
- Delete (если вызовов не осталось): `packages/core/src/work/codex-notify.ts`, `packages/core/src/work/codex-notify-bin.ts` и их тесты; запись бинаря в сборке (поиск `codex-notify` по `packages/*/package.json`, `electron-builder*`, `packages/host/scripts`)
- Modify: `packages/host/test/stub-codex.mjs`, `packages/desktop/e2e/stub-codex-agent.mjs`, `packages/desktop/e2e/codex.spec.ts` — проверки, опиравшиеся на `STUB_NOTIFY`, переводятся на OSC 9 `Agent turn complete` (`STUB_NOTE`)
- Test: тесты `providers`/`launch` (аргументы запуска Codex), `activity-terminal.test.ts`

**Условие.** Задача выполняется, только если в спеке (13.1) записано «убираем». Иначе — пропустить и записать в TODOS (раздел 10), почему подмена осталась.

- [ ] **Step 1: Падающий тест аргументов**

В тесте аргументов запуска Codex (поиск: `tui.notification_method` в `packages/core/src/**/*.test.ts`) добавить:

```ts
expect(args.some((arg) => arg.startsWith('notify='))).toBe(false);
expect(args).not.toContain('{notify}');
```

- [ ] **Step 2: Прогнать — падает**

Run: `pnpm -C packages/core exec vitest run src/providers.test.ts src/work/launch.test.ts`
Expected: FAIL — `notify=[…]` в аргументах.

- [ ] **Step 3: Убрать**

- `providers.ts`: удалить пару `'-c', '{notify}'` из `CODEX_CONFIG_FLAGS`;
- `launch.ts`: удалить блок `if (template.includes('{notify}')) { … subs.notify = codexNotifyOverride(); }` и поле `notify` из `RunnerSubstitutions`, если больше не используется;
- `mcp-config.ts`: удалить `codexNotifyOverride` и импорт `CODEX_NOTIFY_ENTRY`;
- `grep -rn "codex-notify\|codexNotify\|CODEX_NOTIFY" packages` — убрать оставшиеся вызовы, тесты и запись в сборке;
- стабы и `codex.spec.ts`: проверки конца хода — через `STUB_NOTE Agent turn complete`.
- Шапки затронутых файлов, где упомянут `notify`, — поправить одной фразой: «конец хода Codex — OSC 9 и журнал (`task_complete`), `notify` человека не подменяется (спека 2026-10-07, 5.5)».

- [ ] **Step 4: Прогнать всё затронутое**

Run: `pnpm build && pnpm -C packages/core test && pnpm -C packages/host test && pnpm -C packages/desktop build && pnpm -C packages/desktop exec playwright test e2e/codex.spec.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add -A packages
git commit -m "fix(core): Parley больше не подменяет notify у Codex — конец хода из OSC 9 и журнала" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: E2E — Chat у Codex на журнале

**Files:**
- Modify: `packages/desktop/e2e/stub-codex-agent.mjs` (версия из env; запись журнала)
- Create: `packages/desktop/e2e/codex-chat.spec.ts`

**Interfaces:**
- Consumes: стаб Codex (`e2e/stub-codex-agent.mjs`: `--version`, OSC 0/9, bracketed paste, команды `STUB_*`); корень журналов в E2E — `PARLEY_CODEX_SESSIONS_DIR` (как в `e2e/limits.spec.ts:224-226`); запуск — как в `e2e/codex.spec.ts`.

- [ ] **Step 1: Стаб пишет журнал**

В `stub-codex-agent.mjs`:
- `--version` отвечает `codex-cli ${process.env.STUB_CODEX_VERSION ?? '0.44.0'}` (прежние спеки не меняются);
- если задан `STUB_CODEX_SESSIONS` — при старте создать `<STUB_CODEX_SESSIONS>/YYYY/MM/DD/rollout-<ISO с дефисами>-<thread>.jsonl` с `session_meta` (`id` = thread из `STUB_CODEX_THREAD` или uuid, `cwd` = `process.cwd()`, `cli_version` = версия выше, `source: 'cli'`) и `turn_context` (`model: 'gpt-6-astra'`, `approval_policy: 'on-request'`, `sandbox_policy: { type: 'workspace-write' }`); счётчик `ordinal`;
- обычный ввод (Enter) — `task_started`, `item_completed UserMessage` с текстом ввода;
- `STUB_CMD <command>` — `item_completed CommandExecution` (`command: ['/bin/zsh','-lc', command]`, `aggregated_output: 'ok'`, `exit_code: 0`);
- `STUB_EDIT <path>` — `item_completed FileChange` с `update` и коротким `unified_diff`;
- `STUB_SAY <text>` — `item_completed AgentMessage` (`final_answer`) и `task_complete`, затем OSC 9 `Agent turn complete`;
- `STUB_SUBAGENT <threadId>` — в журнал родителя `SubAgentActivity started`, рядом — журнал агента с `subagent_history_start_ordinal: 1`, `response_item/agent_message` с заданием из 200 знаков и `CommandExecution`; `STUB_SUBAGENT_DONE <threadId>` — итог агента и `SubAgentActivity completed`;
- Esc во время `STUB_WORK` — `turn_aborted`.

- [ ] **Step 2: E2E**

`codex-chat.spec.ts` (запуск как в `codex.spec.ts`, env: `PARLEY_CODEX_BIN`, `PARLEY_CODEX_SESSIONS_DIR: codexRoot`, `STUB_CODEX_SESSIONS: codexRoot`, `STUB_CODEX_VERSION: '0.160.0'`, `STUB_CODEX_THREAD`):
1. сегмент Chat у сессии Codex включён; ввод «Почини тесты» из поля Chat → в ленте промпт; `STUB_CMD` с командой из 140 знаков → строка `Bash` с этой командой; `STUB_EDIT` с путём из 120 знаков → правка с диффом; `STUB_SAY Готово` → текст и черта конца хода; переключение на Terminal и обратно — тот же тред (экран стаба показывает введённое);
2. Stop во время `STUB_WORK` → черта «Interrupted»;
3. `STUB_APPROVAL` → баннер ожидания в терминале (`WaitingBanner`) и автопоказ терминала — как у Claude без хука;
4. агент: `STUB_SUBAGENT th-sub` → карточка агента в ленте, «1 agent running» → вкладка Agents, строка с текущей командой; экран агента — задание; `STUB_SUBAGENT_DONE th-sub` → итог;
5. стаб с `STUB_CODEX_VERSION: '0.159.0'` → сегмент Chat выключен, подсказка `Chat needs Codex 0.160.0 or newer`;
6. окно 800×500 — лента и панель без вылезания за край (проверка `scrollWidth <= clientWidth`, как в задаче 6).

- [ ] **Step 3: Собрать и прогнать**

Run: `pnpm --filter @parley/host build && pnpm -C packages/desktop build && pnpm -C packages/desktop exec playwright test e2e/codex-chat.spec.ts e2e/codex.spec.ts`
Expected: passed.

- [ ] **Step 4: Коммит**

```bash
git add packages/desktop/e2e
git commit -m "test(desktop): E2E Chat у Codex на журнале — лента, Stop, ожидание, агенты, версия" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Точка остановки.** Части A–C дают рабочий Chat у Codex без хуков. Спросить человека: вливать сейчас или после части D.

### Часть D. Хуки Codex по доверию

Перед частью D перечитать раздел 13.2 спеки (живые пробы). Шаги ниже написаны по фактам раздела 3 спеки; если пробы показали другое (id вызова не совпадает, `session_id` — не id треда, TUI блокирует старт при неодобренных хуках) — сначала поправить спеку и эти задачи отдельным коммитом.

### Task 18: Хуки Codex в ленте (core)

**Files:**
- Create: `packages/core/src/feed/codex/apply-codex-hook.ts`
- Modify: `packages/core/src/feed/index.ts` (экспорт)
- Test: `packages/core/src/feed/codex/apply-codex-hook.test.ts`

**Interfaces:**
- Consumes: из `reduce.ts`: `FeedDraft`, `newTool`, `finishTool`, `limitInput`, `agentById`, `withChild`, `finishAgent`, `withResult`, `closeTurn`; `FeedPermissionCard` (`types.ts`).
- Produces:
```ts
export const CODEX_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
/** Раннее «идёт» по PreToolUse: id хука совпадает с id элемента журнала (спека 13.2, проба 6). */
export const CODEX_EARLY_TOOLS: boolean;
export function applyCodexHookEvent(state: FeedState, body: Record<string, unknown>, at: string): FeedUpdate;
```

Правила (спека 5.6):
- `SessionStart` — без изменений ленты (доверие отмечает хост);
- `PreToolUse` — при `CODEX_EARLY_TOOLS` и `tool_name` `Bash` или `mcp__…`: вызов со статусом `running` и `toolUseId = tool_use_id` (у субагента — в `children` по `agent_id`); `apply_patch` — без раннего вызова (у правок в журнале свои id `<id>:<n>`);
- `PostToolUse` — если вызов с этим id ещё `running`: закончить по `tool_response` (`done`); законченный элемент журнала потом заменит его по тому же id;
- `PermissionRequest` — карточка `permission`: `state: 'pending'`, `toolUseId: null`, `toolName`, `toolInput` (обрезка `limitInput`), `suggestions: []`, `notified: false`, `agentId` при `agent_id`;
- `SubagentStart` — карточка агента (как `SubAgentActivity started`), если её ещё нет; `agentType` из `agent_type`;
- `SubagentStop` — карточка `done`, итог из `last_assistant_message`;
- `Stop` без `agent_id` — закрыть ход, только если `turnStartedAt !== null` (повторное закрытие по `task_complete` журнала — без нового элемента; то же правило задача 18 вносит в `apply-codex.ts`: `task_complete` и `turn_aborted` закрывают ход только при `turnStartedAt !== null`).

- [ ] **Step 1: Падающие тесты**

```ts
// packages/core/src/feed/codex/apply-codex-hook.test.ts
import { describe, expect, it } from 'vitest';
import { emptyFeedState } from '../reduce.js';
import type { FeedAgent, FeedPermissionCard, FeedState, FeedTool } from '../types.js';
import { applyCodexRecords, emptyCodexCursor } from './apply-codex.js';
import { applyCodexHookEvent, CODEX_EARLY_TOOLS } from './apply-codex-hook.js';

const AT = '2026-10-07T12:00:00.000Z';
const run = (events: Array<Record<string, unknown>>, from: FeedState = emptyFeedState()): FeedState =>
  events.reduce<FeedState>((state, body) => applyCodexHookEvent(state, body, AT).state, from);

describe('applyCodexHookEvent', () => {
  it('PermissionRequest — карточка pending без suggestions', () => {
    const state = run([{ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch ~/outside' } }]);
    const card = state.items[0] as FeedPermissionCard;
    expect(card).toMatchObject({ kind: 'permission', state: 'pending', toolName: 'Bash', toolInput: { command: 'touch ~/outside' }, suggestions: [], toolUseId: null });
    expect(card.cardId).toBe(card.id);
  });

  it.runIf(CODEX_EARLY_TOOLS)('PreToolUse Bash — вызов running; запись журнала с тем же id его закрывает без дубля', () => {
    const early = run([{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'ls' } }]);
    expect((early.items[0] as FeedTool).status).toBe('running');
    const { update } = applyCodexRecords(early, [{
      ordinal: 1, at: AT, type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'call_1', command: ['ls'], cwd: '/tmp', status: 'completed', aggregated_output: 'a', exit_code: 0 } },
    }], emptyCodexCursor());
    expect(update.state.items).toHaveLength(1);
    expect((update.state.items[0] as FeedTool).status).toBe('done');
  });

  it('PreToolUse apply_patch — без раннего вызова', () => {
    expect(run([{ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: {} }]).items).toEqual([]);
  });

  it('SubagentStart и SubagentStop — карточка агента и итог', () => {
    const state = run([
      { hook_event_name: 'SubagentStart', agent_id: 'th-sub', agent_type: 'explorer' },
      { hook_event_name: 'SubagentStop', agent_id: 'th-sub', last_assistant_message: 'Готово' },
    ]);
    expect(state.items[0] as FeedAgent).toMatchObject({ agentId: 'th-sub', agentType: 'explorer', status: 'done', result: 'Готово' });
  });

  it('Stop закрывает ход один раз: task_complete журнала потом не добавляет черту', () => {
    const started = applyCodexRecords(emptyFeedState(), [{ ordinal: 1, at: AT, type: 'event_msg', payload: { type: 'task_started' } }], emptyCodexCursor());
    const stopped = run([{ hook_event_name: 'Stop', last_assistant_message: 'ok' }], started.update.state);
    const { update } = applyCodexRecords(stopped, [{ ordinal: 2, at: AT, type: 'event_msg', payload: { type: 'task_complete' } }], started.cursor);
    expect(update.state.items.filter((item) => item.kind === 'turn')).toHaveLength(1);
  });

  it('незнакомое событие — без изменений', () => {
    expect(applyCodexHookEvent(emptyFeedState(), { hook_event_name: 'Nope' }, AT).changes).toEqual([]);
  });
});
```

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/core exec vitest run src/feed/codex/apply-codex-hook.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация**

```ts
// packages/core/src/feed/codex/apply-codex-hook.ts
/**
 * Хуки Codex поверх ленты из журнала (спека 2026-10-07, 5.6). Хуки приходят, только если человек одобрил их в `/hooks`.
 * Содержимое ленты — из журнала; хуки дают карточку разрешения, раннее «идёт» вызова и привязку агента до журнала.
 * Повторное закрытие хода (`Stop`, затем `task_complete`) не добавляет второй черты.
 */

import { agentById, closeTurn, FeedDraft, finishAgent, finishTool, limitInput, newTool, withChild, withResult } from '../reduce.js';
import type { FeedAgent, FeedPermissionCard, FeedState, FeedUpdate } from '../types.js';

export const CODEX_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** `tool_use_id` хука совпадает с `item.id` элемента журнала (спека 13.2, проба 6). Не совпадает — false: раннего «идёт» нет. */
export const CODEX_EARLY_TOOLS = true;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (source: Json, key: string): string | null => {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

function earlyTool(name: string): boolean {
  return name === 'Bash' || name.startsWith('mcp__');
}

export function applyCodexHookEvent(state: FeedState, body: Json, at: string): FeedUpdate {
  const draft = new FeedDraft(state);
  const event = str(body, 'hook_event_name');
  const agentId = str(body, 'agent_id');
  const toolName = str(body, 'tool_name');
  const toolUseId = str(body, 'tool_use_id');
  const input = isRecord(body['tool_input']) ? body['tool_input'] : {};

  switch (event) {
    case 'PreToolUse': {
      if (!CODEX_EARLY_TOOLS || toolName === null || toolUseId === null || !earlyTool(toolName)) break;
      if (agentId !== null) {
        const agent = agentById(draft, agentId);
        if (agent !== undefined && !agent.children.some((child) => child.toolUseId === toolUseId)) {
          draft.put(withChild(agent, newTool(toolUseId, toolName, input, at, agentId)));
        }
        break;
      }
      if (!draft.has(`tool:${toolUseId}`)) draft.put(newTool(toolUseId, toolName, input, at, null));
      break;
    }
    case 'PostToolUse': {
      if (toolUseId === null || agentId !== null) break;
      const tool = draft.get(`tool:${toolUseId}`);
      if (tool?.kind === 'tool' && tool.status === 'running') draft.put(finishTool(tool, 'done', body['tool_response'], at));
      break;
    }
    case 'PermissionRequest': {
      if (toolName === null) break;
      const limited = limitInput(input);
      const id = draft.nextId('card');
      const card: FeedPermissionCard = {
        id, at, kind: 'permission', cardId: id, state: 'pending', toolUseId: null, toolName, toolInput: limited.input,
        suggestions: [], notified: false,
        ...(limited.truncated ? { truncated: true } : {}),
        ...(agentId === null ? {} : { agentId }),
      };
      draft.put(card);
      break;
    }
    case 'SubagentStart': {
      if (agentId === null || agentById(draft, agentId) !== undefined) break;
      const card: FeedAgent = {
        id: `agent:${agentId}`, at, kind: 'agent', toolUseId: agentId, agentId, agentType: str(body, 'agent_type'), description: null,
        prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [],
      };
      draft.put(card);
      break;
    }
    case 'SubagentStop': {
      const agent = agentId === null ? undefined : agentById(draft, agentId);
      if (agent === undefined || agent.status !== 'running') break;
      const message = str(body, 'last_assistant_message');
      const finished = finishAgent(agent, 'done', at);
      draft.put(message === null ? finished : withResult(finished, message));
      break;
    }
    case 'Stop': {
      if (agentId === null && draft.turnStartedAt !== null) closeTurn(draft, at, false);
      break;
    }
    default:
      break;
  }
  return draft.done();
}
```
Если `FeedPermissionCard` требует других обязательных полей (см. `types.ts:177-196`) — заполнить их так же, как редьюсер Claude заполняет карточку на `PermissionRequest` (`reduce.ts`, `case 'PermissionRequest'`).

В `apply-codex.ts` (`applyRecord`): `task_complete` и `turn_aborted` закрывают ход только при `draft.turnStartedAt !== null`. Прогнать тесты задачи 11 — фикстура `codex-main` начинается с `task_started`, ожидания не меняются.

Экспорт в `feed/index.ts`: `applyCodexHookEvent`, `CODEX_EARLY_TOOLS`, `CODEX_HOOK_EVENTS`, тип `CodexHookEvent`.

Значение `CODEX_EARLY_TOOLS` выставить по разделу 13.2 спеки (проба 6). Если пробы ещё не было — `false`, и тест `runIf` пропускается.

- [ ] **Step 4: Прогнать**

Run: `pnpm -C packages/core exec vitest run src/feed`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/core/src/feed
git commit -m "feat(core): хуки Codex в ленте — карточка разрешения, раннее «идёт», агенты, конец хода" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Мост хука и запуск Codex с хуками

**Files:**
- Create: `packages/host/src/feed/codex-hook-bin.ts` (мост: stdin → приёмник → stdout)
- Create: `packages/host/src/feed/codex-hook-launcher.ts` (запускатель в `PARLEY_HOME/bin`)
- Modify: `packages/core/src/providers.ts:127-150` (элемент `'{codexHooks}'` в `CODEX_CONFIG_FLAGS`), `:453` (`substituteArgs`: элемент-массив)
- Modify: `packages/core/src/work/launch.ts:319-347` (`subs.codexHooks`), тип опций запуска (`codexHookCommand?: string`)
- Create: `packages/core/src/work/codex-hooks.ts` (`codexHookFlags`)
- Modify: `packages/host/src/sessions/sessions-service.ts:388-397, 499, 532-538` (адрес и токен для Codex, `PARLEY_HOOK_URL`, `codexHookCommand`)
- Modify: сборка хоста — новый вход `codex-hook-bin` рядом с остальными bin хоста (поиск: как собирается и упаковывается `codex-notify-bin` или другой `*-bin.ts` хоста)
- Test: `packages/core/src/work/codex-hooks.test.ts`, `packages/host/src/feed/codex-hook-bin.test.ts`, `packages/host/src/feed/codex-hook-launcher.test.ts`, тест аргументов запуска Codex, `packages/host/src/sessions/sessions-service.test.ts`

**Interfaces:**
- Consumes: `CODEX_HOOK_EVENTS` (задача 18), `codexFeedSupported` (задача 9), `hooks.register(ref, providerSessionId)` и `hooks.url()` (`hook-server.ts`).
- Produces:
```ts
// core/src/work/codex-hooks.ts
/** Флаги `-c hooks.<Event>=[…]` — текст побайтно стабилен для одной команды (спека 5.6). */
export function codexHookFlags(command: string): string[];
// host/src/feed/codex-hook-launcher.ts
export const CODEX_HOOK_LAUNCHER = 'parley-codex-hook';
/** Записать `<parleyHome>/bin/parley-codex-hook` (если содержимое другое) и вернуть его путь. */
export function ensureCodexHookLauncher(parleyHome: string, nodePath: string, bridgePath: string): Promise<string>;
// host/src/feed/codex-hook-bin.ts
export function runCodexHook(input: string, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<string>; // строка для stdout ('' — молчать)
```

- [ ] **Step 1: Падающие тесты**

```ts
// packages/core/src/work/codex-hooks.test.ts
import { describe, expect, it } from 'vitest';
import { codexHookFlags } from './codex-hooks.js';

describe('codexHookFlags', () => {
  it('пара -c на каждое событие; таймаут PermissionRequest 600, прочих 30; путь в TOML-кавычках', () => {
    const flags = codexHookFlags('/Users/me/.parley/bin/parley-codex-hook');
    expect(flags).toHaveLength(14);
    expect(flags[0]).toBe('-c');
    expect(flags[1]).toBe('hooks.SessionStart=[{hooks=[{type="command",command="/Users/me/.parley/bin/parley-codex-hook",timeout=30}]}]');
    expect(flags).toContain('hooks.PermissionRequest=[{hooks=[{type="command",command="/Users/me/.parley/bin/parley-codex-hook",timeout=600}]}]');
  });
  it('стабильно: два вызова — тот же текст побайтно', () => {
    expect(codexHookFlags('/a b/hook').join('\u0000')).toBe(codexHookFlags('/a b/hook').join('\u0000'));
  });
});
```

```ts
// packages/host/src/feed/codex-hook-bin.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runCodexHook } from './codex-hook-bin.js';

const ENV = { PARLEY_HOOK_URL: 'http://127.0.0.1:5555/hooks', PARLEY_HOOK_TOKEN: 'tok', PARLEY_SESSION_ID: 's-01' };

describe('runCodexHook', () => {
  it('шлёт stdin в приёмник с токеном и сессией, печатает ответ', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    const out = await runCodexHook('{"hook_event_name":"PermissionRequest"}', ENV, fetchImpl as unknown as typeof fetch);
    expect(JSON.parse(out)).toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENV.PARLEY_HOOK_URL);
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok', 'x-parley-session': 's-01', 'content-type': 'application/json' });
  });
  it('пустой ответ {} — молчать', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await runCodexHook('{}', ENV, fetchImpl as unknown as typeof fetch)).toBe('');
  });
  it('хост недоступен, не 200 или нет окружения — молчать (Codex покажет своё окно)', async () => {
    const failing = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await runCodexHook('{}', ENV, failing as unknown as typeof fetch)).toBe('');
    const denied = vi.fn(async () => new Response('no', { status: 401 }));
    expect(await runCodexHook('{}', ENV, denied as unknown as typeof fetch)).toBe('');
    expect(await runCodexHook('{}', {}, failing as unknown as typeof fetch)).toBe('');
  });
});
```

```ts
// packages/host/src/feed/codex-hook-launcher.test.ts
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCodexHookLauncher } from './codex-hook-launcher.js';

let home = '';
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });

describe('ensureCodexHookLauncher', () => {
  it('путь постоянный, содержимое — node и мост, права на запуск; повтор с другим node — тот же путь', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    const first = await ensureCodexHookLauncher(home, '/usr/local/bin/node', '/Apps/Parley.app/host/codex-hook-bin.js');
    expect(first).toBe(path.join(home, 'bin', 'parley-codex-hook'));
    expect(await readFile(first, 'utf8')).toContain('exec "/usr/local/bin/node" "/Apps/Parley.app/host/codex-hook-bin.js"');
    expect((await stat(first)).mode & 0o111).not.toBe(0);
    const second = await ensureCodexHookLauncher(home, '/opt/node', '/Apps/Parley 2.app/host/codex-hook-bin.js');
    expect(second).toBe(first);
    expect(await readFile(second, 'utf8')).toContain('"/Apps/Parley 2.app/host/codex-hook-bin.js"');
  });
});
```

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm -C packages/core exec vitest run src/work/codex-hooks.test.ts && pnpm -C packages/host exec vitest run src/feed/codex-hook-bin.test.ts src/feed/codex-hook-launcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация**

```ts
// packages/core/src/work/codex-hooks.ts
/**
 * Хуки Codex от Parley (спека 2026-10-07, 5.6): `-c hooks.<Event>=[…]` по событию — подключ, а не вся таблица `hooks`,
 * чтобы не заслонить хуки и доверие человека. Команда — постоянный запускатель `PARLEY_HOME/bin/parley-codex-hook`, поэтому
 * текст определения побайтно одинаков между запусками и обновлениями Parley, и одобрение в `/hooks` не слетает.
 */

import { CODEX_HOOK_EVENTS } from '../feed/codex/apply-codex-hook.js';

const toml = (value: string): string => JSON.stringify(value);

export function codexHookFlags(command: string): string[] {
  return CODEX_HOOK_EVENTS.flatMap((event) => [
    '-c',
    `hooks.${event}=[{hooks=[{type="command",command=${toml(command)},timeout=${event === 'PermissionRequest' ? 600 : 30}}]}]`,
  ]);
}
```
(`JSON.stringify` даёт строку в двойных кавычках с экранированием, совместимую с базовой строкой TOML; если в репо уже есть `tomlString` (`work/mcp-config.ts`) — взять его.)

```ts
// packages/host/src/feed/codex-hook-launcher.ts
/**
 * Запускатель хука Codex (спека 2026-10-07, 5.6): `PARLEY_HOME/bin/parley-codex-hook` — постоянный путь, на который ссылается
 * определение хука. Содержимое (путь к node и к мосту в сборке хоста) хост переписывает при старте, если оно другое; путь и
 * текст хука не меняются, поэтому одобрение человека в `/hooks` переживает обновления Parley.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CODEX_HOOK_LAUNCHER = 'parley-codex-hook';

const shellQuote = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

export async function ensureCodexHookLauncher(parleyHome: string, nodePath: string, bridgePath: string): Promise<string> {
  const dir = path.join(parleyHome, 'bin');
  const file = path.join(dir, CODEX_HOOK_LAUNCHER);
  const body = `#!/bin/sh\n# Хук Codex от Parley: путь постоянный, содержимое переписывает хост при старте.\nexec ${shellQuote(nodePath)} ${shellQuote(bridgePath)} "$@"\n`;
  await mkdir(dir, { recursive: true });
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== body) await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
  return file;
}
```

```ts
// packages/host/src/feed/codex-hook-bin.ts
/**
 * Мост хука Codex (спека 2026-10-07, 5.6): JSON хука из stdin — в приёмник хуков хоста (`PARLEY_HOOK_URL`, токен сессии
 * `PARLEY_HOOK_TOKEN`, `x-parley-session` = `PARLEY_SESSION_ID`), ответ — в stdout. Любая ошибка — пустой вывод и код 0:
 * Codex тогда показывает своё окно одобрения в TUI (безопасная сторона). `PermissionRequest` ждёт решения окна до 590 с —
 * меньше предела Codex 600 с.
 */

const PERMISSION_WAIT_MS = 590_000;
const OTHER_WAIT_MS = 10_000;

export async function runCodexHook(input: string, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = env['PARLEY_HOOK_URL'];
  const token = env['PARLEY_HOOK_TOKEN'];
  const session = env['PARLEY_SESSION_ID'];
  if (!url || !token || !session) return '';
  const permission = input.includes('"PermissionRequest"');
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-parley-session': session, 'content-type': 'application/json' },
      body: input,
      signal: AbortSignal.timeout(permission ? PERMISSION_WAIT_MS : OTHER_WAIT_MS),
    });
    if (response.status !== 200) return '';
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : '';
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const out = await runCodexHook(Buffer.concat(chunks).toString('utf8'), process.env);
  if (out !== '') process.stdout.write(out);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
```
Способ «запуск как файл» — взять тот же, что у других `*-bin.ts` хоста (если их нет — у `core/src/work/codex-notify-bin.ts`).

- [ ] **Step 4: Подстановка массива и запуск**

- `providers.ts`: в конец `CODEX_CONFIG_FLAGS` — одиночный элемент `'{codexHooks}'` (без `'-c'` перед ним);
- `substituteArgs` (`:453`): значение-массив разворачивается на месте элемента; нет значения — элемент удаляется (проверить, как сейчас удаляются пустые `'{skillCatalog}'` и `'-c'` перед ним, и сделать для `{codexHooks}` то же без `'-c'`);
- `RunnerSubstitutions`: `codexHooks?: string[]`;
- `launch.ts`: `if (template.includes('{codexHooks}') && options.hookUrl !== undefined && options.codexHookCommand !== undefined) subs.codexHooks = codexHookFlags(options.codexHookCommand);`;
- `sessions-service.ts`:
  - `feedHookUrl(provider)`: у `codex` — `codexFeedSupported(version)` вместо `feedSupported(version)`, остальное как у Claude;
  - при старте хоста — `ensureCodexHookLauncher(parleyHome, process.execPath, <путь к собранному codex-hook-bin.js>)`, путь кешируется и передаётся в план запуска как `codexHookCommand` (`PARLEY_HOME` — тем же способом, что остальной хост: поиск `PARLEY_HOME` в `packages/host/src`);
  - в окружение процесса Codex: `PARLEY_HOOK_URL = hookUrl` и `PARLEY_HOOK_TOKEN` (как у Claude, `:532-538`); `PARLEY_SESSION_ID` уже есть.
- Тест аргументов запуска Codex: с `hookUrl` и `codexHookCommand` в аргументах 7 пар `-c hooks.…`, без них — ни одной; у `resume` — те же 7 пар.
- Тест `sessions-service`: сессия Codex ≥ 0.160 получает в окружении `PARLEY_HOOK_URL` и `PARLEY_HOOK_TOKEN`; Codex 0.159 — не получает.

- [ ] **Step 5: Прогнать**

Run: `pnpm build && pnpm -C packages/core test && pnpm -C packages/host test`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add packages/core packages/host
git commit -m "feat(host,core): хуки Codex — мост к приёмнику, постоянный запускатель, -c hooks при запуске и resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: Приёмник и служба ленты — хуки Codex, решения окна

**Files:**
- Modify: `packages/host/src/hooks/hook-server.ts:58-92, 206-229` (набор событий по провайдеру: `register(ref, providerSessionId, provider)`)
- Modify: `packages/host/src/hooks/pending.ts` (необязательный `timeoutMs` у `HeldHook`)
- Modify: `packages/host/src/feed/feed-service.ts:434-474` (`onHook` для Codex), `SessionFeed.decisions`, таймер доверия, поле `decisions` в снимке (`:807-812`) и дельте (`:375-381`)
- Modify: `packages/host/src/sessions/sessions-service.ts:537` (провайдер в `register`)
- Test: `packages/host/src/hooks/hook-server.test.ts`, `packages/host/src/hooks/pending.test.ts`, `packages/host/src/feed/feed-service.test.ts`

**Interfaces:**
- Consumes: `applyCodexHookEvent`, `CODEX_HOOK_EVENTS` (задача 18); `hookDecisionResponse` (`hooks/decisions.ts`) — для Codex подходит как есть: `{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior, message? } } }`.
- Produces: `FeedService.snapshot` и `feed.changed` с `decisions`; константы `CODEX_HOOK_GRACE_MS = 15_000` (переопределяется опцией `codexHookGraceMs` и в E2E env `PARLEY_CODEX_HOOK_GRACE_MS`), `CODEX_HOLD_MS = 590_000`.

- [ ] **Step 1: Падающие тесты**

- `hook-server.test.ts`: регистрация с провайдером `codex` — `PermissionRequest`/`SubagentStart` проходят, `MessageDisplay` (только Claude) — 400; первая `SessionStart` с `session_id` при `providerSessionId: null` привязывает id, следующий запрос с другим `session_id` (не `SessionStart`) — 404.
- `pending.test.ts`: `hold({ …, timeoutMs: 100 })` отвечает `{}` и зовёт `onTimeout` через 100 мс, а не через `PENDING_TIMEOUT_MS`.
- `feed-service.test.ts`, `describe('хуки Codex')`:

```ts
it('первый хук сессии Codex — decisions window; PermissionRequest удерживается и отвечается решением окна', async () => {
  start();
  const client = fakeClient();
  service.subscribe(REF, client);
  send({ hook_event_name: 'SessionStart', session_id: 'th-main', source: 'startup' });
  const held = send({ hook_event_name: 'PermissionRequest', session_id: 'th-main', tool_name: 'Bash', tool_input: { command: 'touch ~/x' } });
  const snapshot = await service.snapshot(REF);
  expect(snapshot.decisions).toBe('window');
  const card = snapshot.items.find((item) => item.kind === 'permission');
  expect(held.responses).toEqual([]);
  service.decide(REF, (card as { cardId: string }).cardId, { kind: 'permission', behavior: 'allow' });
  expect(held.responses).toEqual([{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }]);
});

it('хуков нет за 15 с после старта процесса — decisions terminal, лента на журнале работает', async () => {
  vi.useFakeTimers();
  start({ codexHookGraceMs: 15_000 });
  fakes.emitStart(REF);
  vi.advanceTimersByTime(15_000);
  expect((await service.snapshot(REF)).decisions).toBe('terminal');
});

it('удержание PermissionRequest Codex — не дольше 590 с, потом карточка stale и пустой ответ', async () => {
  vi.useFakeTimers();
  start();
  send({ hook_event_name: 'SessionStart', session_id: 'th-main' });
  const held = send({ hook_event_name: 'PermissionRequest', session_id: 'th-main', tool_name: 'Bash', tool_input: { command: 'ls' } });
  vi.advanceTimersByTime(590_000);
  expect(held.responses).toEqual([{}]);
  const card = (await service.snapshot(REF)).items.find((item) => item.kind === 'permission');
  expect(card).toMatchObject({ state: 'stale' });
});
```
Сессия в этих тестах — `fakeFeedDeps([{ ref: REF, provider: 'codex' }])`; если `hookRequest` проверяет события по набору Claude — он не проверяет (это делает сервер), сверить с `test/feed-fakes.ts`.

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm --filter @parley/core build && pnpm -C packages/host exec vitest run src/hooks src/feed/feed-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация**

1. `hook-server.ts`: `register(ref, providerSessionId, provider = 'claude')`; в `Registration` — `events: ReadonlySet<string>` = `provider === 'codex' ? new Set(CODEX_HOOK_EVENTS) : FEED_EVENTS`; проверка `:208` — `registration.events.has(event)`. Привязка `session_id` при `providerSessionId === null` уже есть (`:211-229`) — для Codex она и даёт привязку по первому хуку; лог `'новый id сессии Claude Code'` поправить на нейтральный.
2. `sessions-service.ts:537`: `hooks.register(ref, plan.providerSessionId ?? session.providerSessionId, session.provider)`.
3. `pending.ts`: `HeldHook.timeoutMs?: number`; таймер удержания — `held.timeoutMs ?? timeoutMs`.
4. `feed-service.ts`:
   - `SessionFeed.decisions: FeedDecisions | null` (начально `null`), `codexGrace?: NodeJS.Timeout`;
   - `onHook(request)`: провайдер сессии `codex` → ветка Codex: `feed.decisions = 'window'` (снять `codexGrace`; если было другое — `feed.modeChanged = true`, чтобы дельта ушла); `commit(feed, applyCodexHookEvent(feed.state, request.body, at))`; новая карточка `permission` со `state: 'pending'` в `update.changes` — удержать, как удерживает Claude (`pending.hold({ ref, cardId, hookEvent: 'PermissionRequest', rawToolInput, kind: 'permission', respond: request.respond, timeoutMs: CODEX_HOLD_MS })`); иначе — `request.respond({})`. `feed.live` у Codex **не** ставится: лента продолжает читать журнал;
   - `pty.on('start')` (`:715`): у сессии Codex, если `feed.decisions !== 'window'`, — таймер `codexHookGraceMs` → `feed.decisions = 'terminal'`, дельта подписчикам;
   - снимок и дельта: поле `decisions: feed.decisions`;
   - `stop()` снимает таймеры.

- [ ] **Step 4: Прогнать**

Run: `pnpm -C packages/host test`
Expected: PASS (флейки — по Global Constraints).

- [ ] **Step 5: Коммит**

```bash
git add packages/host
git commit -m "feat(host): хуки Codex в приёмнике и ленте — карточки с удержанием до 590 с, decisions window/terminal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 21: Окно — подсказка про `/hooks` и карточки Codex

**Files:**
- Modify: `packages/desktop/src/renderer/chat/store.ts` (`FeedEntry.decisions` из снимка и дельт)
- Modify: `packages/desktop/src/renderer/chat/ui-store.ts` (`hooksHintDismissed: Record<string, true>`, `dismissHooksHint(sessionKey)`)
- Modify: `packages/desktop/src/renderer/chat/ChatView.tsx` (строка-подсказка над полем ввода у Codex с `decisions: 'terminal'`)
- Modify: `packages/desktop/src/shared/strings.ts` (`S.chat.codexHooksHint`, `S.chat.gotIt`)
- Test: `packages/desktop/src/renderer/chat/store.test.ts`, `packages/desktop/src/renderer/chat/ChatView.test.tsx`, `packages/desktop/src/renderer/chat/cards/cards.test.tsx`

**Interfaces:**
- Consumes: `decisions` снимка и `feed.changed` (задачи 9, 20); `S.chat.openTerminal` (задача 15).
- Produces: `S.chat.codexHooksHint = "Approve Parley's hooks in /hooks to answer approvals here"`, `S.chat.gotIt = 'Got it'`.

- [ ] **Step 1: Падающие тесты**

- `store.test.ts`: снимок с `decisions: 'terminal'` → `FeedEntry.decisions === 'terminal'`; дельта с `decisions: 'window'` → `'window'`; снимок без поля (старый хост) → `null`.
- `ChatView.test.tsx`: Codex, `decisions: 'terminal'` → видна строка `S.chat.codexHooksHint` и кнопки `S.chat.openTerminal`, `S.chat.gotIt`; «Got it» прячет её до смены сессии (`hooksHintDismissed`); у `decisions: 'window'` и у Claude — строки нет.
- `cards.test.tsx`: карточка разрешения с `suggestions: []` (как у Codex) — кнопки «Allow» и «Deny» есть, «Allow and don't ask again» нет. Если тест уже это покрывает — шаг пропустить, записать в коммите.

- [ ] **Step 2: Прогнать — падают**

Run: `pnpm --filter "@parley/desktop^..." build && pnpm -C packages/desktop exec vitest run src/renderer/chat`
Expected: FAIL.

- [ ] **Step 3: Реализация**

- `store.ts`: `FeedEntry.decisions: FeedDecisions | null`; при снимке — `snapshot.decisions ?? null`; при дельте — `data.decisions === undefined ? entry.decisions : data.decisions`;
- `ChatView.tsx`: над `Composer` при `provider === 'codex' && feed?.decisions === 'terminal' && !dismissed`:

```tsx
        <div data-testid="codex-hooks-hint" className="mx-3 mb-2 flex min-w-0 items-center gap-2 rounded-lg bg-foreground/5 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">{S.chat.codexHooksHint}</span>
          <Button size="sm" variant="ghost" onClick={showTerminal}>{S.chat.openTerminal}</Button>
          <Button size="sm" variant="ghost" onClick={() => useChatUiStore.getState().dismissHooksHint(sessionKey)}>{S.chat.gotIt}</Button>
        </div>
```
  `showTerminal` — то же переключение вида, что у `ErrorItem` (задача 15). Шапку `ChatView.tsx` дополнить фразой про подсказку.

- [ ] **Step 4: Прогнать**

Run: `pnpm -C packages/desktop exec vitest run src/renderer && pnpm -C packages/desktop typecheck`
Expected: PASS; exit 0.

- [ ] **Step 5: Коммит**

```bash
git add packages/desktop/src
git commit -m "feat(desktop): Codex без одобренных хуков — подсказка про /hooks; decisions в ленте окна" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 22: E2E хуков Codex, документы, живые прогоны

**Files:**
- Modify: `packages/desktop/e2e/stub-codex-agent.mjs` (хуки из `-c hooks.*`)
- Modify: `packages/desktop/e2e/codex-chat.spec.ts` (сценарии с хуками)
- Modify: `README.md`, `CHANGELOG.md`, `TODOS.md`, `docs/specs/2026-10-07-agents-panel-codex-chat-design.md` (раздел «14. Приёмка»)

- [ ] **Step 1: Стаб зовёт хуки**

В `stub-codex-agent.mjs`: если среди аргументов есть `hooks.<Event>=[…command="<путь>"…]` и `STUB_CODEX_HOOKS_TRUSTED=1` — разобрать путь команды и вызывать её дочерним процессом с JSON на stdin (окружение процесса стаба передаётся как есть): `SessionStart` при старте (`session_id` = id треда); `STUB_CMD` — `PreToolUse` с `tool_use_id` = id элемента журнала, затем запись журнала, затем `PostToolUse`; `STUB_PERMISSION <command>` — `PermissionRequest`, печать в терминал `approved` / `denied` / `prompt` (пустой ответ — как окно одобрения TUI) по ответу моста. Без `STUB_CODEX_HOOKS_TRUSTED` хуки не вызываются (как неодобренные).

- [ ] **Step 2: Сценарии E2E**

В `codex-chat.spec.ts` (env как в задаче 17 плюс `STUB_CODEX_HOOKS_TRUSTED: '1'`, `PARLEY_CODEX_HOOK_GRACE_MS: '1000'`):
1. доверенные хуки: `STUB_PERMISSION touch ~/outside` → карточка Allow/Deny с командой; Allow → в терминале стаба `approved`; второй раз Deny → `denied`;
2. доверенные хуки: `STUB_CMD` с длинной командой → строка вызова появляется до записи журнала (статус running), потом — done, без дубля;
3. без `STUB_CODEX_HOOKS_TRUSTED`: через ~1 с — строка `codex-hooks-hint`; «Open terminal» показывает терминал; `STUB_APPROVAL` → баннер ожидания, карточки нет;
4. 800×500 и DPR 2 — карточка и подсказка не вылезают за край.

Run: `pnpm --filter @parley/host build && pnpm -C packages/desktop build && pnpm -C packages/desktop exec playwright test e2e/codex-chat.spec.ts e2e/codex.spec.ts e2e/chat-hooks.spec.ts e2e/agents-panel.spec.ts`
Expected: passed.

- [ ] **Step 3: Полный прогон**

Run: `pnpm build && pnpm test && pnpm lint && pnpm typecheck && pnpm -C packages/desktop exec playwright test`
Expected: всё зелёное; упавшее — сравнить с базовой линией задачи 0 и прогоном на `origin/master` (Global Constraints).

- [ ] **Step 4: Документы**

- `README.md` (по-английски): раздел о виде Chat — «Codex 0.160.0+ opens in Chat too: the feed is read from the session log; approvals stay in the terminal until you approve Parley's hooks once in `/hooks` — then they show up as Allow/Deny cards»; где лежит запускатель (`~/.parley/bin/parley-codex-hook`) и что Parley не пишет в `~/.codex`.
- `CHANGELOG.md`, Unreleased → Added: «Chat view for Codex 0.160.0+ …»; если задача 16 сделана — Fixed: «Parley no longer replaces your Codex `notify` program in its sessions».
- `TODOS.md`: раздел 21 — закрыть с итогом; раздел 18 — убрать хвост «Codex: хуков нет»; раздел 10 — меню модели/effort у Codex в чате остаётся открытым (вне подпроекта, спека 12).
- Спека: раздел «14. Приёмка (2026-10-xx)» — пункты 1–12 раздела 10 с отметками и ссылками на тесты/коммиты.

- [ ] **Step 5: Живые прогоны (только с разрешения)**

Спросить человека: «Живая приёмка: Parley из этой ветки (dev-окно) с настоящими `claude` и `codex` — панель агентов с фоновыми агентами Claude; Codex без одобренных хуков; Codex после одобрения в `/hooks`; Codex с субагентом. Тратит лимит. Запускать?» После «да» — прогнать, итог дописать в раздел 14 спеки. Непройденное — в TODOS раздел 21.

- [ ] **Step 6: Коммит**

```bash
git add packages/desktop/e2e README.md CHANGELOG.md TODOS.md docs/specs/2026-10-07-agents-panel-codex-chat-design.md
git commit -m "test(desktop): E2E хуков Codex; docs: Chat у Codex, приёмка" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Финал.** Спросить человека: пушить ветку и открывать PR (через встроенный браузер — `gh` не установлен).
