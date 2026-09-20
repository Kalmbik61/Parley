# Разговор агентов: план реализации

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. В этом проекте задачи исполняет Workflow с агентами на Opus (ревью с `effort: high`): одна задача плана = одна задача Workflow, см. раздел «Карта на Workflow» в конце.

**Goal:** сессии одной работы разговаривают сами (письмо будит адресата штатным channel Claude Code), а человек видит тред родителя и решения в панели справа от агента.

**Architecture:** три слоя, как в проекте: core (карта, MCP-сервер, тексты для агента), TUI (панель треда, клавиши, мышь), стоковый `claude`. Письмо остаётся в `map.json`; сервер получателя только **звонит** уведомлением `notifications/claude/channel` и карту не пишет; агент забирает письмо `check_inbox`, как сегодня. Источник истины — `docs/specs/2026-09-08-agent-conversation-design.md` (после инженерного ревью 2026-09-09, раздел 2.1 с решениями D3–D21). Расхождение плана со спецификацией решается в пользу спецификации.

**Tech Stack:** TypeScript, Node ≥ 20, pnpm workspace, vitest, `@modelcontextprotocol/sdk` 1.30 (`Server`, `InMemoryTransport`, `Client.setNotificationHandler`), Ink, node-pty, `@xterm/headless`. Настоящий `claude` в автотестах не запускается никогда; E2E — stub-бинарь через `HARNAS_CLAUDE_BIN`.

**Правила для исполнителя.** Перед задачей прочитать её раздел спецификации и файлы из «Files». Каждая задача: сначала падающий тест, потом код, потом зелёный прогон, потом коммит. Команды тестов: `pnpm --filter @harnas/core test -- <файл>` и `pnpm --filter @harnas/tui test -- <файл>`, полный прогон `pnpm test`, типы `pnpm build`, стиль `pnpm lint`. Стиль коммитов — как в `git log`: `feat(core): …`, `feat(tui): …`, `docs: …`, тело на русском, трейлер `Co-Authored-By`. Комментарии в коде — на русском, в манере соседних файлов: почему, а не что. Ничего рядом не «улучшать».

---

## Шаг 0. Спайк канала (вручную, за пользователем, до задач)

Решение D17. Скрипт и инструкция лежат вне репозитория:
`/private/tmp/claude-501/-Users-kalmbik61-Desktop-MY-my-harnas/2576b71e-db2c-4233-ad2c-0d416424108c/scratchpad/channel-spike/RUN.md`
(`server.mjs`, `mcp.json`, `settings.json` рядом). Прогон занимает десять минут.

Что записать по итогам (в TODOS, раздел «Спайк канала 2026-09-09», и в раздел 9
спецификации):

1. флаг `--dangerously-load-development-channels server:spike` принят, баннер показал регистрацию — да/нет;
2. событие у промпта начало ход само — да/нет;
3. судьба набранной и не отправленной строки при приходе события;
4. есть ли `UserPromptSubmit` в `events.jsonl` перед `Stop` у хода, начатого событием;
5. `--resume` и `--agent` с channel работают — да/нет;
6. что напечатал `getClientCapabilities()` в `spike.log`;
7. минимальная версия `claude` — если проверить не на чем, записать «2.1.263 проверена, нижняя граница по документации 2.1.211».

Если пункты 1–2 «нет»: в задаче B `channelPush` по умолчанию становится `false`, сторож всё равно пишется (он безвреден), README называет push экспериментом. Задачи A, C, D не меняются.

---

## Задача A. core: вид письма, тред, лимит, тексты, подстановки

Спецификация: 3.1, 3.3, 3.4, 4.4 (подстановки), 4.7, 5.2, 5.3, 8.1–8.6, 8.8, 8.10, 8.30, 8.34, 8.35, 8.40, 8.42.

### A1. `kind` у письма и нормализация в `parseMap`

**Files:**
- Modify: `packages/core/src/work/types.ts` (интерфейс `Message`)
- Modify: `packages/core/src/work/map.ts` (`NewMessage`, `addMessage`, `parseMap`, `isMessageShape`)
- Test: `packages/core/src/work/map.test.ts`

**Step 1: падающие тесты** — в `map.test.ts`, рядом с `describe('addMessage')`:

```ts
it('kind по умолчанию note, явный kind сохраняется', () => {
  const map = fixture(); // как в соседних тестах файла
  const plain = addMessage(map, { from: 's-01', to: 's-02', text: 'a' });
  const question = addMessage(map, { from: 's-01', to: 's-02', text: 'b', kind: 'question' });
  expect(plain.kind).toBe('note');
  expect(question.kind).toBe('question');
});

it('карта без kind у письма читается как note, остальные поля не тронуты', () => {
  const raw = JSON.stringify({ ...fixture(), messages: [
    { id: 'm-01', from: 's-01', to: 's-02', at: '2026-09-08T10:00:00.000Z', text: 'x', readAt: null },
  ] });
  const map = parseMap(raw, 'map.json');
  expect(map.messages[0]).toMatchObject({ id: 'm-01', kind: 'note', readAt: null });
});
```

**Step 2:** `pnpm --filter @harnas/core test -- map.test.ts` → FAIL (`kind` undefined / тип не компилируется).

**Step 3: реализация.** В `types.ts`:

```ts
/** Вид письма: вопрос ждёт ответа, решение фиксирует договорённость, заметка — всё остальное (спецификация 2026-09-08, 3.1). */
export type MessageKind = 'note' | 'question' | 'decision';
export const MESSAGE_KINDS: readonly MessageKind[] = ['note', 'question', 'decision'];

export interface Message {
  id: string;
  from: string;
  to: string;
  at: string;
  text: string;
  /** На диске может отсутствовать (карты до 2026-09-08): `parseMap` подставляет `note`. */
  kind: MessageKind;
  readAt: string | null;
  deleted?: boolean;
}
```

В `map.ts`: `NewMessage` получает `kind?: MessageKind`; `addMessage` кладёт `kind: init.kind ?? 'note'` (собирать объект явно, не `...init`, чтобы `kind` не остался `undefined`). В `parseMap` после цикла `migrateSession` добавить `for (const message of map.messages) migrateMessage(message as unknown as Record<string, unknown>)` с

```ts
/** Письма до 2026-09-08 не знали вида: заметка. Миграция при чтении, как у `idle`. */
function migrateMessage(message: Record<string, unknown>): void {
  message['kind'] ??= 'note';
}
```

**Step 4:** тесты зелёные; `pnpm build` без ошибок типов (места, где создаётся `Message` руками в тестах других файлов, получают `kind: 'note'`).

**Step 5: Commit** — `feat(core): a letter has a kind, old maps read it as note`.

### A2. `work/thread.ts`: тред, решения, подпись участника

**Files:**
- Create: `packages/core/src/work/thread.ts`
- Test: `packages/core/src/work/thread.test.ts`
- Modify: `packages/core/src/index.ts` (экспорт `threadOf`, `decisionsOf`, `participantLabel`, тип `Thread`)

**Step 1: падающие тесты** (`thread.test.ts`; карту собирать `createWork`-подобной фикстурой из `map.test.ts` или руками через `addSession`/`addMessage`):

```ts
describe('threadOf', () => {
  it('у сессии с родителем — поддерево родителя: родитель, братья, она, потомки', ...);
  it('корень с детьми — собственное поддерево, письма чужого корня не попадают', ...);
  it('одинокий корень — вся работа: owner null, все сессии, все письма', ...);
  it('письмо между двумя поддеревьями не попадает ни в один тред', ...);
  it('удалённая сессия не участник, её письма остаются', ...); // removeSession, потом threadOf
});
describe('decisionsOf', () => {
  it('только kind decision, по времени at', ...);
});
describe('participantLabel', () => {
  it('известная — ярлык; удалённая — «ярлык (удалена)» невозможен, id есть только в deletedSessions → «s-03 (удалена)»; чужой id — как есть', ...);
});
```

Ожидания в каждом `it` — конкретные массивы id писем (`messages.map(m => m.id)`).

**Step 2:** `pnpm --filter @harnas/core test -- thread.test.ts` → FAIL (модуля нет).

**Step 3: реализация** — весь файл:

```ts
import type { Message, WorkMap, WorkSession } from './types.js';

/**
 * Тред выводится из карты, а не хранится (спецификация 2026-09-08, 3.4):
 * письма, у которых и отправитель, и получатель лежат в поддереве владельца.
 * Группа сессии S — поддерево её родителя; корень с детьми — своё поддерево;
 * одинокий корень — вся работа (owner === null).
 */
export interface Thread {
  /** Владелец поддерева; `null` — тред всей работы. */
  owner: string | null;
  /** Участники: id сессий поддерева, живые записи карты. */
  members: string[];
  /** Письма треда по времени `at`. */
  messages: Message[];
}

const childrenOf = (map: WorkMap, id: string): WorkSession[] =>
  map.sessions.filter((session) => session.parent === id);

function subtree(map: WorkMap, root: string): string[] {
  const ids: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    ids.push(id);
    for (const child of childrenOf(map, id)) queue.push(child.id);
  }
  return ids;
}

export function threadOf(map: WorkMap, sessionId: string): Thread {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`сессии ${sessionId} нет в карте`);

  const owner =
    session.parent !== null
      ? session.parent
      : childrenOf(map, sessionId).length > 0
        ? sessionId
        : null;
  const members = owner === null ? map.sessions.map((item) => item.id) : subtree(map, owner);
  const inside = new Set(members);
  const messages = map.messages
    .filter((message) => inside.has(message.from) && inside.has(message.to))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { owner, members, messages };
}

/** Решения треда — его письма с `kind: decision`, по времени. */
export const decisionsOf = (thread: Thread): Message[] =>
  thread.messages.filter((message) => message.kind === 'decision');

/**
 * Единственное место, где id сессии становится подписью (решение D9 ревью):
 * ярлык у живой записи, «(удалена)» у следа в `deletedSessions`, голый id у чужого.
 */
export function participantLabel(map: WorkMap, id: string): string {
  const session = map.sessions.find((candidate) => candidate.id === id);
  if (session !== undefined) return session.label;
  return (map.work.deletedSessions ?? []).includes(id) ? `${id} (удалена)` : id;
}
```

Тонкость: у удалённой сессии ярлыка в карте нет (след — только id), поэтому подпись `«s-03 (удалена)»`; в спецификации написано `<ярлык> (удалена)` — уточнить там при коммите на «id (удалена)».

**Step 4:** тесты зелёные. **Step 5: Commit** — `feat(core): threadOf, decisionsOf and participantLabel derive the parent thread from the map`.

### A3. `send_message(kind)` и окно `messageRate`; ключи конфига

**Files:**
- Modify: `packages/core/src/config.ts` (`HarnasConfig`, `DEFAULT_CONFIG`, `fromFile`, `fromEnv`)
- Modify: `packages/core/src/mcp/context.ts` (`messageRate` в контексте) и `packages/core/src/mcp/tools.ts` (`sendMessage`, схема инструмента, `messageView`)
- Test: `packages/core/src/config.test.ts`, `packages/core/src/mcp/server.test.ts`

**Step 1: падающие тесты.**

`config.test.ts`: `channelPush` (boolean, по умолчанию `true`, `HARNAS_CHANNEL_PUSH=0` → `false`), `messageRate` (целое ≥ 1, по умолчанию 20, `HARNAS_MESSAGE_RATE`), `threadWidth` (целое ≥ 24, по умолчанию 30, `HARNAS_THREAD_WIDTH`; 20 → жалоба и дефолт). Образец — существующие тесты битых значений в том же файле.

`server.test.ts`, в `describe('send_message и check_inbox')`:

```ts
it('принимает три вида, четвёртый — ошибка с перечнем, без kind — note', async () => { ... });
it('ответ check_inbox и wait_for несёт kind', async () => { ... });
it('окно messageRate: N+1-е письмо за час отказано, письмо старше часа не считается, чужие не считаются', async () => {
  // connect с pollMs и messageRate: 2 в контексте; два письма проходят, третье — isError с текстом «слишком часто» и «report»
  // затем updateMap: сдвинуть at первого письма на 2 часа назад — третье проходит
});
```

**Step 2:** прогон → FAIL.

**Step 3: реализация.**

`config.ts`: три поля с дефолтами `channelPush: true`, `messageRate: 20`, `threadWidth: 30`; в `fromFile` — `take('channelPush', boolean)`, `take('messageRate', isPositiveInt)`, `take('threadWidth', (v) => isPositiveInt(v) && v >= 24, 'целое не меньше 24')`; в `fromEnv` — `flag('HARNAS_CHANNEL_PUSH', 'channelPush')`, `count('HARNAS_MESSAGE_RATE', 'messageRate')`, `threadWidth` с той же проверкой ≥ 24 (расширить типы `flag`/`count` на новые ключи).

`context.ts`: поле `messageRate?: number` (в проде берётся из `loadConfig()` в `server.ts` при старте; тесты передают явно). `server.ts`: `const { config } = await loadConfig(); createHarnasServer({ ...contextFromEnv(), messageRate: config.messageRate })`.

`tools.ts`:

```ts
/** Скользящий час для окна писем (спецификация 4.7, решение D20). */
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MESSAGE_RATE = 20;

function assertRate(map: WorkMap, sessionId: string, limit: number, now: number): void {
  const recent = map.messages.filter(
    (message) => message.from === sessionId && now - Date.parse(message.at) < RATE_WINDOW_MS,
  ).length;
  if (recent >= limit) {
    throw new Error(
      `слишком часто: ${recent} писем за час от этой сессии (лимит ${limit}); отчитайся report и обратись к человеку`,
    );
  }
}
```

В `sendMessage`: `const kind = args['kind'] === undefined ? 'note' : enumArg(args, 'kind', MESSAGE_KINDS)`; внутри `updateMap` после проверок сессий — `assertRate(current, sessionId, context.messageRate ?? DEFAULT_MESSAGE_RATE, Date.now())`; `addMessage(current, { from, to, text, kind })`. Схема инструмента: `kind: { type: 'string', enum: [...], description: 'question — жду ответа; decision — договорились; note — заметка (по умолчанию)' }`, описание инструмента дополнить «отвечай только на question». `messageView` возвращает и `kind`.

**Step 4:** зелёные. **Step 5: Commit** — `feat(core): send_message takes a kind and refuses more than messageRate letters an hour`.

### A4. Бриф, системная вставка, гид

**Files:**
- Modify: `packages/core/src/work/brief.ts`, `guidance.ts`, `guide.ts`
- Test: `brief.test.ts`, `guidance.test.ts`, новый `guide.test.ts` (проверка наличия фраз)

**Step 1: падающие тесты.** `brief.test.ts`: у порождённой сессии бриф содержит `## Коллеги` со строкой `- s-01 — план (родитель): active` и `## Решения треда` с `- 12:42 план: «…»` при наличии решения; без коллег и решений разделов нет; правило 2 — новый текст (проверять подстроку «на `note` и `decision` не отвечай»). `guidance.test.ts`: существующий счёт строк остаётся ≤ 12; строка про `send_message` содержит `question` и `decision`; строка про channel содержит `<channel source="harnas">`. `guide.test.ts`: `GUIDE` содержит «## Как разговаривать», «messageRate», «mcp__harnas__».

**Step 2:** FAIL. **Step 3:** тексты по спецификации 5.2 и 5.3 (формулировки там). В `buildBrief` коллеги = `threadOf(map, sessionId).members` без самой сессии, каждая строка `- <id> — <label>(, родитель)(, агент <agent>): <status>` — часть про агента появится в задаче D, сейчас без неё; решения = `decisionsOf(thread)` со временем `at` в `HH:MM` (взять `formatClock`-подобную функцию core? В core её нет — печатать `at.slice(11, 16)` по UTC не годится; добавить в `brief.ts` локальный `clock(at)` через `new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })`).

**Step 4:** зелёные. **Step 5: Commit** — `feat(core): the brief introduces the colleagues and the thread decisions; guidance and guide teach the conversation etiquette`.

### A5. Подстановки `{channel}` и `{agent}` в реестре

**Files:**
- Modify: `packages/core/src/providers.ts` (`RunnerSubstitutions`, `PLACEHOLDER`, запись `claude`)
- Test: `packages/core/src/providers.test.ts`

**Step 1: падающие тесты** (в `describe('подстановка аргументов запуска')`):

```ts
it('claude с channel получает пару --dangerously-load-development-channels server:harnas в args и resumeArgs', ...);
it('без channel пара выпадает целиком', ...);
it('claude с agent получает пару --agent <name>; без agent пара выпадает', ...);
```

**Step 2:** FAIL. **Step 3:** в `RunnerSubstitutions` добавить `channel?: string` («`server:harnas` при включённом push») и `agent?: string`; `PLACEHOLDER` → `/^\{(sessionUuid|mcpConfig|settingsFile|systemPrompt|prompt|providerSessionId|channel|agent)\}$/`; в `PROVIDERS.claude.runner.args` перед `'{prompt}'` вставить `'--dangerously-load-development-channels', '{channel}', '--agent', '{agent}'`, в `resumeArgs` — в конец те же четыре элемента. Комментарий: флаг документирован, скрыт из `--help`, research preview; подстановка пустая → пара выпадает, как у `--mcp-config`.

**Step 4:** зелёные. **Step 5: Commit** — `feat(core): the registry knows the channel and agent substitutions`.

### A6. Экспорт и полный прогон

`index.ts`: экспортировать `MessageKind`, `MESSAGE_KINDS`, `threadOf`, `decisionsOf`, `participantLabel`, `Thread`. `pnpm build && pnpm test && pnpm lint` зелёные. Commit при необходимости — `chore(core): export the thread helpers`.

---

## Задача B. channel: сторож-звонок, включение, проба версии, документы

Спецификация: 4.1–4.6, 7, 8.9, 8.12–8.17, 8.29, 8.31–8.33. Зависит от A (нужны `kind`, `participantLabel`, `{channel}`).

### B1. `mcp/inbox-watch.ts`

**Files:**
- Create: `packages/core/src/mcp/inbox-watch.ts`
- Test: `packages/core/src/mcp/inbox-watch.test.ts`

**Step 1: падающие тесты.** Поднимать сервер как в `server.test.ts` (`connect`), но клиенту ставить обработчик:

```ts
import { z } from 'zod';
const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});
const rung: { content: string; meta: Record<string, string> }[] = [];
client.setNotificationHandler(ChannelNotification, (n) => { rung.push(n.params); });
```

Тесты (§8.12–8.15, 8.31): письмо в карту → один звонок с `meta.message_id`, `from`, `from_label`, `kind`, `unread`, `content` без текста письма; после звонка `readAt === null` и второго звонка нет; письмо до старта звонит после `initialize`; при висящем `wait_for("inbox")` звонок всё равно приходит, `wait_for` отдаёт письмо один раз; транспорт закрыт → следующая попытка на следующем проходе (проверить через подменённый `notify`, который один раз бросает). Ожидание событий — `vi.waitFor` или цикл с `setTimeout`, как в `server.test.ts` для `wait_for`.

**Step 2:** FAIL. **Step 3: реализация** — весь файл:

```ts
import { readMap, workPaths } from '../work/store.js';
import { participantLabel } from '../work/thread.js';
import type { Message } from '../work/types.js';
import type { McpContext } from './context.js';
import { waitForMap } from './watch-map.js';

/*
 * Сторож входящих (спецификация 2026-09-08, 4.2; решения D8, D16). Только
 * читает карту и звонит, письмо агент забирает сам:
 *
 *   while (!stopped)
 *     found = await waitForMap(map, probe, LONG, pollMs)
 *             probe: письма to === me && readAt === null && id ∉ rung
 *     for letter of found:
 *       rung.add(id)                ← звоним про письмо один раз
 *       await notify(звонок)        ← сорвалось: rung.delete(id), позвоним позже
 *
 *   непрочитано ──звонок──▶ непрочитано, звонок сделан ──check_inbox / wait_for──▶ прочитано
 */

/** Звонок: что пришло и от кого, без текста — текст агент заберёт `check_inbox`. */
export interface Ring {
  content: string;
  meta: Record<string, string>;
}

export interface InboxWatchOptions {
  notify: (ring: Ring) => Promise<void>;
  pollMs: number;
  /** Ожидание в `waitForMap` за один оборот; тесты укорачивают. */
  waitMs?: number;
}

const LONG_MS = 60 * 60 * 1000;

export function ringFor(letter: Message, fromLabel: string, unread: number): Ring {
  return {
    content: `Новое письмо от ${fromLabel} (${letter.kind}): позови check_inbox.`,
    meta: {
      message_id: letter.id,
      from: letter.from,
      from_label: fromLabel,
      kind: letter.kind,
      unread: String(unread),
    },
  };
}

/** Запускает сторож; возвращает функцию остановки. */
export function watchInbox(
  context: McpContext & { sessionId: string },
  { notify, pollMs, waitMs = LONG_MS }: InboxWatchOptions,
): () => void {
  const rung = new Set<string>();
  let stopped = false;
  const mapFile = workPaths(context.projectPath, context.workId).map;

  const probe = async (): Promise<Message[] | null> => {
    const map = await readMap(context.projectPath, context.workId);
    const letters = map.messages
      .filter((m) => m.to === context.sessionId && m.readAt === null && !rung.has(m.id))
      .sort((a, b) => a.at.localeCompare(b.at));
    return letters.length === 0 ? null : letters;
  };

  void (async () => {
    while (!stopped) {
      let found: Message[] | null = null;
      try {
        found = await waitForMap(mapFile, probe, waitMs, pollMs);
      } catch {
        // Карта не парсится или исчезла: подождём следующего изменения.
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      if (stopped || found === null) continue;
      const map = await readMap(context.projectPath, context.workId);
      const unread = map.messages.filter((m) => m.to === context.sessionId && m.readAt === null).length;
      for (const letter of found) {
        rung.add(letter.id);
        try {
          await notify(ringFor(letter, participantLabel(map, letter.from), unread));
        } catch {
          rung.delete(letter.id);
        }
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
```

Заметка исполнителю: `waitForMap` при `found` закрывает свой watcher, цикл открывает новый — это принято (решение D8). Остановка сторожа при закрытии транспорта: `server.onclose` в B2.

**Step 4:** зелёные. **Step 5: Commit** — `feat(core): the inbox watcher rings the session about an unread letter without touching the map`.

### B2. Capability, `instructions`, запуск сторожа в сервере

**Files:**
- Modify: `packages/core/src/mcp/context.ts` (`channel: boolean` из `HARNAS_CHANNEL`)
- Modify: `packages/core/src/mcp/tools.ts` (`createHarnasServer`) и `packages/core/src/mcp/server.ts`
- Test: `packages/core/src/mcp/server.test.ts` (§8.16, 8.17, 8.33)

**Step 1: падающие тесты:** `contextFromEnv` с `HARNAS_CHANNEL=1` даёт `channel: true`, без — `false`; сервер с `channel: true` и сессией объявляет `capabilities.experimental['claude/channel']` и `instructions` с `source="harnas"` и «только на question» (проверять через `client.getServerCapabilities()` и `client.getInstructions()`); без `HARNAS_CHANNEL` — ни capability, ни звонка; с `HARNAS_CHANNEL` без `HARNAS_SESSION_ID` — сторожа нет.

**Step 2:** FAIL. **Step 3:** в `createHarnasServer`:

```ts
const channel = context.channel === true && context.sessionId !== null;
const server = new Server(
  { name: 'harnas', version: '0.0.0' },
  {
    capabilities: channel ? { tools: {}, experimental: { 'claude/channel': {} } } : { tools: {} },
    ...(channel ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
  },
);
if (channel) {
  let stop: (() => void) | null = null;
  server.oninitialized = () => {
    stop = watchInbox({ ...context, sessionId: context.sessionId as string }, {
      pollMs: context.pollMs ?? POLL_MS,
      notify: (ring) =>
        server.notification({ method: 'notifications/claude/channel', params: ring } as never),
    });
  };
  server.onclose = () => stop?.();
}
```

`as never` — потому что `Server` без генерика ограничен `ServerNotification`; альтернатива с генериком `new Server<Request, ChannelNotification>(…)` предпочтительнее, если `tsc` её принимает — проверить, выбрать её. `CHANNEL_INSTRUCTIONS` — текст из спецификации 4.5, шаблонная строка в `tools.ts`. В `server.ts` — `loadConfig()` для `messageRate` (A3) там же.

**Step 4:** зелёные. **Step 5: Commit** — `feat(core): harnas-mcp declares the channel and starts the inbox watcher when HARNAS_CHANNEL is set`.

### B3. Включение: конфиг MCP, проба версии, запуск из TUI и CLI

**Files:**
- Create: `packages/core/src/work/channel.ts` (проба версии)
- Modify: `packages/core/src/work/mcp-config.ts` (`env.HARNAS_CHANNEL`), `packages/core/src/cli.ts`, `packages/tui/src/work-launch.ts`, `packages/tui/src/use-panel.ts`, `packages/tui/src/app.tsx`
- Test: `mcp-config.test.ts`, новый `channel.test.ts`, `cli-work.test.ts`, `work-launch.test.ts`, `e2e.app.test.tsx` (§8.9, 8.27, 8.32)

**Step 1: падающие тесты.**

`channel.test.ts`: `parseVersion('2.1.263 (Claude Code)')` → `[2,1,263]`; `channelSupported('2.1.263')` true, `('2.0.9')` false; `probeChannelSupport('claude')` со stub-бинарём (`HARNAS_CLAUDE_BIN` на скрипт, печатающий версию) → `{ supported, version }`; бинаря нет → `{ supported: true, version: null }` (проба не удалась — push включён, спецификация 4.4).

`mcp-config.test.ts`: `mcpConfig({ …, channel: true })` пишет `env.HARNAS_CHANNEL = '1'`, без — переменной нет.

`work-launch.test.ts`: с `channel: true` аргументы содержат пару флага, env конфига MCP содержит `HARNAS_CHANNEL`; с `false` — нет; оверрайд `providers.json` без `{channel}` при `channel: true` даёт `warnings: ['providers.json без {channel}: push выключен']`.

`cli-work.test.ts`: `work session new` печатает команду с флагом при `channelPush` (по умолчанию) и без при `HARNAS_CHANNEL_PUSH=0`.

`e2e.app.test.tsx`: аргументы stub содержат `--dangerously-load-development-channels server:harnas`.

**Step 2:** FAIL. **Step 3: реализация.**

`work/channel.ts`:

```ts
import { execFile } from 'node:child_process';
import { commandBinary } from '../providers.js';

/** Нижняя граница по документации channels (2026-09); уточняется спайком шага 0. */
export const CHANNEL_MIN_VERSION = '2.1.211';

export const parseVersion = (text: string): [number, number, number] | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

export function channelSupported(version: string, min = CHANNEL_MIN_VERSION): boolean {
  const have = parseVersion(version);
  const need = parseVersion(min) as [number, number, number];
  if (have === null) return true; // непонятную версию не считаем старой
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

export interface ChannelProbe { supported: boolean; version: string | null }

/** `claude --version` один раз на процесс; проба не удалась — push остаётся включённым (4.4). */
export function probeChannelSupport(command = 'claude', timeoutMs = 3000): Promise<ChannelProbe> {
  return new Promise((resolve) => {
    execFile(commandBinary(command), ['--version'], { timeout: timeoutMs }, (error, stdout) => {
      if (error) return resolve({ supported: true, version: null });
      const version = stdout.trim();
      resolve({ supported: channelSupported(version), version });
    });
  });
}
```

`mcp-config.ts`: `McpConfigParams` получает `channel?: boolean`; в `mcpConfig` `env` дополняется `...(channel ? { HARNAS_CHANNEL: '1' } : {})`; `writeMcpConfig(projectPath, workId, sessionId, command?, channel = false)`; `codexMcpOverride` не меняется (Codex push не получает).

`work-launch.ts`: `plan(...)` получает `channel: boolean` (из `LaunchOptions`, которые `use-panel` берёт из конфига `channelPush && probe.supported`); `writeMcpConfig(..., undefined, channel)`; если `channel && template.includes('{channel}')` — `subs.channel = 'server:' + MCP_SERVER_NAME`; если `channel && entry.id === 'claude' && !template.includes('{channel}')` — `warnings.push('providers.json без {channel}: push выключен')`; `LaunchPlan` получает `warnings: string[]`. `use-panel.ts` передаёт `channel` и пушит `warnings` в строку статуса один раз на ключ работы.

`app.tsx`: рядом с `useConfig` — `useChannelProbe(config.channelPush, push)` (маленький хук в `use-channel.ts`: при `channelPush` зовёт `probeChannelSupport()` один раз; `supported === false` → `push([{ text: `⚑ push выключен: claude ${version} младше ${CHANNEL_MIN_VERSION}` }])`), результат идёт в `usePanel({ channel })`.

`cli.ts`: перед сборкой `subs` — `const { config } = await loadConfig(); const probe = config.channelPush ? await probeChannelSupport(entry.runner.command) : { supported: false, version: null }; const channel = config.channelPush && probe.supported;` далее как в `plan()`; предупреждения — в stderr.

**Step 4:** зелёные, `pnpm build`. **Step 5: Commit** — `feat: channel push is on by default, gated by a claude --version probe, and reaches both the panel and the CLI command`.

### B4. Двухсторонний разговор (§8.29)

**Files:** `packages/core/src/mcp/server.test.ts` (или `inbox-watch.test.ts`).

Тест: две сессии A и B в одной карте, два `connect()` с `channel: true` и обработчиками звонка. A `send_message(B, 'где миграция?', 'question')` → у B звонок с `kind: question` → B `check_inbox` → B `send_message(A, 'в db/…')` → у A звонок → A `check_inbox` → A `send_message(B, 'миграции отдельным PR', 'decision')` → `threadOf(map, B)` даёт три письма, `decisionsOf` одно; звонков ровно три, `readAt` у всех трёх писем стоит (их забрали `check_inbox`). Второй сценарий: A вместо ожидания звонка держит `wait_for("inbox")` — итог тот же, письмо у A одно.

Commit — `test(core): two sessions talk through the channel and the inbox`.

### B5. Документы

**Files:** `README.md` (схема архитектуры: стрелка `stdio MCP` → `stdio MCP ⇄ channel`, строка `harnas-mcp: … · send/inbox · guide · звонок`; раздел «Координация агентов»: тред, виды писем, push, `messageRate`, минимальная версия; настройки: `channelPush`, `messageRate`, `threadWidth`; таблица инструментов: `send_message(to, text, kind)`), `docs/specs/2026-09-02-coordination-design.md` (строка «Доставка сообщений» таблицы и пункт «Push сообщений в PTY» раздела 10: «перекрыто 2026-09-08: push через channel, см. `2026-09-08-agent-conversation-design.md`»), `TODOS.md` (перенести раздел 10 спецификации: письма от человека, `to: all`, пикер агента, PTY/Codex push, поиск, правка решений, выгрузка).

Commit — `docs: channel push in the README diagram, the v3 spec rows superseded, deferrals in TODOS`.

---

## Задача D. Роли: `agent` у сессии и `claude --agent` (независима от B и C, после A)

Спецификация: 3.2, 5.1, 6.4 (детали, карточка), 8.7, 8.11, 8.25, 8.27.

### D1. Поле `agent`, `work/agents.ts`, `spawn_session(agent)`, CLI `--agent`

**Files:**
- Modify: `packages/core/src/work/types.ts` (`agent: string | null`), `map.ts` (`NewSession.agent?`, `addSession`, `migrateSession`: `session['agent'] ??= null`)
- Create: `packages/core/src/work/agents.ts`
- Modify: `packages/core/src/mcp/tools.ts` (`spawnSession`), `packages/core/src/cli.ts` (`--agent`), `packages/core/src/work/brief.ts` (`, агент <name>` в строке коллеги), `packages/core/src/work/guide.ts` (описание `agent`, оговорка про `tools`)
- Test: `agents.test.ts`, `map.test.ts`, `server.test.ts`, `cli-work.test.ts`, `brief.test.ts`

`agents.ts`:

```ts
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Каталоги агентов Claude Code: проект и пользователь; `~/.claude` только читается (`stat`). */
export function agentDirs(projectPath: string, claudeHome = path.join(homedir(), '.claude')): string[] {
  return [path.join(projectPath, '.claude', 'agents'), path.join(claudeHome, 'agents')];
}

export async function listAgents(dirs: string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of dirs) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) if (entry.endsWith('.md')) names.add(entry.slice(0, -3));
  }
  return [...names].sort();
}

/** Имя агента должно существовать файлом `<dir>/<name>.md`; иначе ошибка с перечнем найденных. */
export async function assertAgent(name: string, dirs: string[]): Promise<void> {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`агент ${name}: имя — буквы, цифры, точка, дефис, подчёркивание`);
  for (const dir of dirs) {
    const ok = await stat(path.join(dir, `${name}.md`)).then((s) => s.isFile()).catch(() => false);
    if (ok) return;
  }
  const known = await listAgents(dirs);
  throw new Error(
    known.length === 0
      ? `агента ${name} нет: ни в .claude/agents/ проекта, ни в ~/.claude/agents/`
      : `агента ${name} нет; найдены: ${known.join(', ')}`,
  );
}
```

Тесты — с временными каталогами (`mkdtemp`), `claudeHome` параметром. В `spawnSession` — `const agent = args['agent'] === undefined ? null : stringArg(args, 'agent')`; если задан: провайдер должен иметь `{agent}` в `runner.args`, иначе ошибка «провайдер … агентов не принимает»; `await assertAgent(agent, agentDirs(context.projectPath))`; `addSession(..., { agent })`. CLI: `--agent` в `work session new`, та же проверка, `subs.agent = agent`. Схема инструмента и гид — описание поля и оговорка «определение агента с ограниченным `tools` обязано включать `mcp__harnas__*`».

Commit — `feat(core): a session can run as a named Claude Code agent`.

### D2. Запуск с `--agent` и показ в TUI

**Files:** `packages/tui/src/work-launch.ts` (`subs.agent = session.agent ?? undefined` в `launch`/`resume`), `packages/tui/src/overlays.ts` (`detailsView`: поле `АГЕНТ` после `ЗАДАЧА`, только если задан), `packages/tui/src/components/panel.tsx` (карточка `pending`: строка `агент: <name>`), тесты `work-launch.test.ts`, `overlays.test.ts`, `panel.test.tsx`, `e2e.app.test.tsx` (`--agent <name>` в аргументах stub).

Commit — `feat(tui): the launch passes --agent, the details and the pending card name the agent`.

---

## Задача C. TUI: панель треда (после A и B)

Спецификация: 6.1–6.4, 7, 8.18–8.26, 8.36–8.39, 8.41.

### C1. `thread-view.ts` — чистый вид треда

**Files:**
- Create: `packages/tui/src/thread-view.ts`
- Test: `packages/tui/src/thread-view.test.ts`

**Step 1: падающие тесты** (§8.18, 8.36, 8.39): фикстура карты с родителем `план`, детьми `бэкенд`, `тесты`, пятью письмами трёх видов, одним решением, одним непрочитанным, одним от удалённой сессии. Проверить: заголовок `тред · план` и `▤1`; блок `РЕШЕНИЯ` с `✓ 12:42 план: «…»` и `+N раньше` при шести решениях; строки ленты `12:40 план → бэкенд ?`, `▤` у непрочитанного, `(удалена)`, перенос по ширине 30 без обрезки; пустой тред → заголовок и строка `писем пока нет`; `slice(scroll, scroll + height)` и `↓N` при `scroll` выше хвоста; `threadView` для одинокого корня — `тред · работа`.

**Step 2:** FAIL. **Step 3:** сигнатура и каркас:

```ts
export interface ThreadViewOptions {
  entry: WorkEntry;
  sessionId: string;
  width: number;   // ширина тела треда, без разделителя
  height: number;  // строк на экране
  /** Смещение от начала ленты; `null` — держаться хвоста. */
  scroll: number | null;
  g: Glyphs;
}
export interface ThreadView {
  title: string;         // «тред · план» / «тред · работа»
  unread: number;
  lines: OverlayLine[];  // уже нарезанные под height
  /** Сколько новых строк ниже окна, когда пользователь ушёл вверх. */
  below: number;
  /** Полный список строк — для оверлея-запасника и для прокрутки. */
  total: number;
}
export function threadView(options: ThreadViewOptions): ThreadView
```

Внутри: `threadOf`, `decisionsOf`, `participantLabel` из core; знаки `?` / `✓` (`g.done`) / ничего; `wrapText(text, width - 2, Infinity, g.ellipsis)` с отступом два пробела; заголовок ленты `HH:MM from → to <знак>`; непрочитанные строки `dim: false`, прочитанные — обычные; `▤` (`g.mail`) перед временем непрочитанного. РЕШЕНИЯ — до пяти последних, старше — `+N раньше`, между блоком и лентой `rule: true`.

**Step 4:** зелёные. **Step 5: Commit** — `feat(tui): a pure thread view — decisions block, kinds, unread marks, wrap and window`.

### C2. Док справа, клавиша `t`, оверлей-запасник, ресайз PTY

*(Эта задача и `width: number; // ширина тела треда, без разделителя` в C1 —
как задумывалось тогда: одна левая грань `│`, без своей рамки. План рамок
`2026-09-19-tui-frames-plan.md` это отменил: у треда теперь рамка со всех
сторон, `width + 2`, а не `width + 1` с разделителем. Как есть сейчас —
`2026-09-08-agent-conversation-design.md`, §6.1.)*

**Files:**
- Create: `packages/tui/src/components/thread.tsx` (рендер `ThreadView` столбцом: заголовок, строки, разделитель `│` слева — по образцу `sidebar.tsx`)
- Create: `packages/tui/src/use-thread.ts` (состояние: `open`, `scroll`, `docked`, `width`; `toggle()`, `scrollBy(lines)`, `follow()`; правило дока `panelCols - 1 - width >= 80`; `useMemo` строк по `[entry, sessionId, width, height, scroll]`)
- Modify: `packages/tui/src/app.tsx` (раскладка: `panelCols` уменьшается на `width + 1` при доке; `<Thread>` после `<Panel>`; при недоке `t` открывает `overlays.open('thread')`)
- Modify: `packages/tui/src/use-actions.ts` (`t` → `thread.toggle()`), `packages/tui/src/use-overlays.ts` и `overlays.ts` (kind `'thread'`: `OverlayView` из `threadView` с `desired = threadWidth + 2`, прокрутка стрелками как у деталей, `Esc` закрывает), `packages/tui/src/overlays.ts` `helpView` (строка `['t', 'тред выбранной сессии справа от панели']`)
- Test: `app.test.tsx` (§8.19–8.21, 8.23, 8.26, 8.37, 8.41), `use-thread.test.tsx`

Тесты: на 138 колонках `t` докует и PTY получает `cols` на 31 меньше, второй `t` возвращает; на 120 с сайдбаром `t` открывает оверлей с теми же строками; ввод при открытом доке уходит гостю; смена выбранной сессии меняет заголовок; ресайз терминала со 138 на 120 при открытом доке переключает в оверлей; справка содержит `t`.

Commit — `feat(tui): prefix t docks the thread right of the panel, or opens it as an overlay when the panel would drop below 80 columns`.

### C3. Мышь: правая граница и прокрутка треда

**Files:** `packages/tui/src/use-prefix-input.ts` (`PrefixInputOptions.panelRight?: number`, `onThreadScroll?: (lines) => void`; в `routeMouse` перед веткой гостя: `if (panelRight !== undefined && event.x > panelRight) { const lines = wheelLines(event); if (lines !== 0) onThreadScroll?.(lines); return; }`), `packages/tui/src/use-actions.ts` (прокидывает `panelRight = panelLeft + panelCols` и `thread.scrollBy` при доке), тесты `use-prefix-input.test.ts` (§8.22: событие правее `panelRight` при `mouseTracking: 'sgr'` не уходит гостю и крутит тред; клик там ничего не делает; событие в панели по-прежнему уходит гостю с пересчётом колонок).

Commit — `feat(tui): the mouse router knows the panel's right edge, so the wheel over the thread scrolls it`.

### C4. События строки статуса и макеты

**Files:** `packages/tui/src/work-events.ts` (`decisionEvents`: новое письмо `kind: decision` → `✓ <from>: решение «…»`, источник — получатель; `rateEvents`: сессия достигла `messageRate` за час → один раз `⚑ слишком частые письма · <ярлык>`; `labelOf` заменить на `participantLabel`), `packages/tui/src/overlays.ts` (детали: карта ярлыков → `participantLabel`), `docs/specs/2026-09-05-tui-v2-mockups.md` (раздел «Тред»: док 138×40 честной высоты, оверлей 80×24), `README.md` (таблица клавиш: `t`; известное ограничение — судьба набранной строки, по итогам спайка), тесты `work-events.test.ts` (§8.24, 8.38), `overlays.test.ts`.

Commit — `feat(tui): decisions and overheated threads reach the status line; thread mockups and the key table`.

---

## Карта на Workflow

| Задача Workflow | Разделы плана | Зависит от | Модель / ревью |
|---|---|---|---|
| spike (ручной, пользователь) | Шаг 0 | — | — |
| A | A1–A6 | Шаг 0 (только для текста README/гида) | opus / high |
| B | B1–B5 | A | opus / high |
| D | D1–D2 | A | opus / high, параллельно B; сливать после B (общие `tools.ts`, `cli.ts`) |
| C | C1–C4 | A, B | opus / high |

Приёмка каждой задачи — чек-лист раздела 8 спецификации (номера пунктов указаны в заголовках задач), `pnpm build && pnpm test && pnpm lint` зелёные, README не расходится с кодом. Живой прогон после B и сценарий-eval (спецификация, раздел 9) — за пользователем, результат в TODOS.
