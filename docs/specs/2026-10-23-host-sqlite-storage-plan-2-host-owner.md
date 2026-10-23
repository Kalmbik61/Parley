# Хранилище работ, этап 1: хост — единственный владелец карты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP-серверы агентов, запущенных хостом, перестают читать и писать `map.json` сами: инструменты Parley исполняются в хосте, хост держит разобранную карту в кэше, а `wait_for` просыпается от сигнала хоста, а не от `fs.watch`.

**Architecture:** тело обработчиков `createParleyServer` выносится в `ToolRunner` — объект с `list()` и `call()`. В процессе MCP с каналом агента (`PARLEY_AGENT_URL`) работает удалённый исполнитель: он пересылает `list` и `call` на новый маршрут хоста `/agent/tools`. Хост исполняет их тем же `createToolRunner` в своём процессе, с контекстом, собранным по токену сессии. Под этим лежат кэш разобранной карты (сверка по `stat`), очередь замка внутри процесса и проверка изменения файла перед пробой `wait_for`. Хранилище остаётся прежним (`map.json` под `map.lock`).

**Tech Stack:** TypeScript, pnpm-монорепо (`@parley/core`, `@parley/host`, `@parley/protocol`), `@modelcontextprotocol/sdk`, `node:http`, vitest.

**Spec:** `docs/specs/2026-10-23-host-sqlite-storage-design.md` — разделы 6.3, 6.4, 6.5, 6.9 (этап 1), 7. Перед этим планом влит план 1 (`…-plan-1-quick-fixes.md`): в `updateMap` уже есть `backupDue`.

## Global Constraints

- Ветка `feat/host-owned-map` от `origin/master` **после слияния плана 1**, в своём worktree: `git worktree add .claude/worktrees/host-owned-map -b feat/host-owned-map origin/master`, затем `pnpm install --prefer-offline` и `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Коммиты — по-английски (`AGENTS.md`), в конце `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Тесты — только затронутых файлов: `pnpm --filter @parley/<pkg> exec vitest run <path>`; полный прогон запрещён; перед прогоном `uptime`, при load ≥ числа ядер — ждать. Хост берёт ядро из `dist/`: после правки ядра — `pnpm --filter @parley/core build`.
- Тексты, которые видит агент, — по-английски; комментарии — по-русски со ссылкой «спека хранилища N.M»; названия тестов — на языке файла.
- Новых зависимостей нет. Протокол окна (`@parley/protocol`) не меняется: маршрут `/agent/tools` описан типами в ядре.
- Исполнители — Sonnet, не больше двух параллельно и только по непересекающимся файлам: задачи 1 и 2 трогают `store.ts` и идут по очереди; задача 3 может идти параллельно с 1–2; 4 → 5 → 6 строго по очереди. Облегчённый режим проверок.
- **Решения этого плана** (спека оставила их строителю или этапу):
  - карта в этапе 1 пишется сразу, без накопления изменений;
  - агенту при чтении отдаётся **копия** закэшированной карты (`structuredClone`): защищает кэш от правок вызывающих;
  - сессии без канала агента (запущенные `parley-core`, старые) остаются в прежнем прямом режиме, CLI `parley-core` пишет карту сам под `map.lock` — оба пути корректны, пока источник истины `map.json`; перевод CLI на хост и отказ сессиям без канала (спека 6.5, 6.8) — в плане этапа 2, когда `map.json` исчезнет;
  - хост узнаёт о записях по-прежнему через `WorksService` (`fs.watch`); сигнал «изменилось» в процессе хоста получает только `wait_for`.

## Review Focus

1. **Ответ хоста потерялся, и агент повторил запись.** Письмо ложится один раз: повтор несёт тот же `callId`, хост отдаёт сохранённый результат. Тесты — задача 5 (`remote-tools.test.ts`, «повтор после обрыва несёт тот же callId») и задача 6 (`tools-endpoint.test.ts`, «a replayed callId does not run the tool twice»).
2. **Агент прервал долгий `wait_for` (Esc).** Хост перестаёт ждать сразу, таймеры не остаются. Тест — задача 6 («closing the request aborts a pending wait_for»).
3. **Токен снят** (сессию перезапустили, старый процесс MCP ещё жив). Агент получает понятный текст, повторов нет. Тест — задача 5 («401 — без повторов, текст про перезапуск»).
4. **Большие аргументы** (`plan_submit` с длинным планом). До 1 МиБ принимаются, больше — понятный отказ, а не зависание. Тесты — задача 5 (413 → текст) и задача 6 (200 КБ проходят, 1 МиБ + 1 → 413).
5. **Сессия без канала агента.** Работает как сегодня, прямым чтением карты: прежние тесты `server.test.ts` зелёные без правок ожиданий. Отдельно — задача 5, «в режиме канала MCP не открывает файл карты».

---

### Task 1: Кэш разобранной карты

**Files:**
- Modify: `packages/core/src/work/store.ts:312-315` (`readMap`), `:517-562` (`updateMap`)
- Test: `packages/core/src/work/store.test.ts`

**Interfaces:**
- Produces: в `store.ts` — `export const MAP_CACHE_LIMIT = 32`; `export function mapCacheStats(): { hits: number; misses: number }` (только для тестов, в `core/src/index.ts` не экспортируется). Сигнатуры `readMap` и `updateMap` не меняются.
- Устройство: ключ кэша — путь `map.json`; запись — `{ identity, map }`, где `identity = [dev, ino, size, mtimeNs, ctimeNs].join(':')` из `stat(file, { bigint: true })`. `readMap`: `stat` → совпало — `structuredClone(cached.map)` (hit); нет — прочитать и разобрать как сейчас, положить копию (miss). Ошибка `stat` — прежний путь без кэша (ошибки остаются теми же). `updateMap` под замком: совпало — `current = structuredClone(cached.map)` без чтения файла; сырой текст для `.bak` читается с диска, только когда `backupDue` вернул `true`. После записи — `stat` нового файла под тем же замком и `cache.set(file, { identity, map: structuredClone(current) })`. Исключение в `mutate` — кэш не трогается. Вытеснение — самый давний по вставке, когда записей больше `MAP_CACHE_LIMIT`.

- [ ] **Step 1: Write the failing tests** — в блок с тестами `updateMap` в `store.test.ts`:

```ts
it('повторное чтение неизменной карты идёт из кэша и не делит объект с вызывающим', async () => {
  await createWork(project, { title: 'Авторизация' });
  const before = mapCacheStats();
  const first = await readMap(project, 'w-0001');
  first.work.title = 'испорчено снаружи';
  expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
  expect(mapCacheStats().hits - before.hits).toBeGreaterThanOrEqual(1);
});

it('карту переписали мимо кэша — следующее чтение видит новую версию', async () => {
  await createWork(project, { title: 'Авторизация' });
  await readMap(project, 'w-0001');
  const paths = workPaths(project, 'w-0001');
  const raw = JSON.parse(await readFile(paths.map, 'utf8')) as WorkMap;
  raw.work.title = 'Снаружи';
  await writeFile(`${paths.map}.ext`, JSON.stringify(raw)); await rename(`${paths.map}.ext`, paths.map);
  expect((await readMap(project, 'w-0001')).work.title).toBe('Снаружи');
});

it('updateMap неизменной карты не читает файл, а результат и кэш независимы', async () => {
  await createWork(project, { title: 'Авторизация' });
  await readMap(project, 'w-0001');
  const before = mapCacheStats();
  const updated = await updateMap(project, 'w-0001', (map) => { map.work.title = 'Новая'; });
  updated.work.title = 'испорчено снаружи';
  expect((await readMap(project, 'w-0001')).work.title).toBe('Новая');
  expect(mapCacheStats().misses).toBe(before.misses);
});

it('брошенная мутация не портит кэш', async () => {
  await createWork(project, { title: 'Авторизация' });
  await readMap(project, 'w-0001');
  await expect(updateMap(project, 'w-0001', (map) => { map.work.title = 'Наполовину'; throw new Error('стоп'); })).rejects.toThrow('стоп');
  expect((await readMap(project, 'w-0001')).work.title).toBe('Авторизация');
});
```

- [ ] **Step 2: Run, expect FAIL** (`mapCacheStats` не существует)

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts -t "кэш"`
Expected: FAIL

- [ ] **Step 3: Implement** кэш по описанию в Interfaces; комментарий у кэша: копия на выдаче — потому что вызывающие свободно меняют полученную карту (спека хранилища 6.9, этап 1).

- [ ] **Step 4: Run, expect PASS** — весь файл и соседи, которые читают карту:

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts src/work/letters.test.ts src/work/rooms.test.ts src/mcp/server.test.ts`
Expected: PASS, включая «битую карту не переписываем, а .bak хранит прежнюю версию» (запись на месте меняет `mtimeNs`/`size` — кэш не отвечает старым)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/store.ts packages/core/src/work/store.test.ts
git commit -m "perf(core): cache parsed workspace maps by file identity"
```

### Task 2: Очередь замка внутри процесса

**Files:**
- Modify: `packages/core/src/work/store.ts:235-264` (`withLock`)
- Test: `packages/core/src/work/store.test.ts`

**Interfaces:**
- Consumes: задачу 1 (тот же файл).
- Produces: сигнатура `withLock` не меняется. Внутри — `Map<string, Promise<void>>` по пути файла замка: писатели одного процесса встают в цепочку и берут файловый замок по одному, без опроса каждые 20 мс. Таймаут `lockTimeoutMs` считается только для файлового замка, когда очередь дошла; ожидание в очереди ограничено тем, что каждый держатель либо закончит, либо упадёт по своему таймауту. Запись цепочки удаляется, когда за ней никого нет.

- [ ] **Step 1: Write the failing test**

```ts
it('50 одновременных updateMap одного процесса проходят без MapLockTimeoutError и все применяются', async () => {
  await createWork(project, { title: 'Авторизация' });
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    updateMap(project, 'w-0001', (map) => { addSession(map, { provider: 'claude', label: `s${i}`, task: 't' }); }, { lockTimeoutMs: 100 })));
  expect((await readMap(project, 'w-0001')).sessions).toHaveLength(50);
});
```

- [ ] **Step 2: Run, expect FAIL** — с `lockTimeoutMs: 100` часть вызовов падает `MapLockTimeoutError`

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts -t "50 одновременных"`
Expected: FAIL

- [ ] **Step 3: Implement** цепочку в `withLock`; комментарий: внутри процесса хоста писатели встают в очередь, файловый замок остаётся для других процессов (CLI, сессии без канала) — спека хранилища 6.9.

- [ ] **Step 4: Run, expect PASS** — весь `store.test.ts`, включая прежние тесты замка с дочерним процессом и «украденного» замка

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts src/work/works.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/store.ts packages/core/src/work/store.test.ts
git commit -m "perf(core): queue same-process lock waiters instead of polling the lock file"
```

### Task 3: `waitForMap` — проба только после изменения файла и внешний сигнал

**Files:**
- Modify: `packages/core/src/mcp/watch-map.ts:20-83`
- Create: `packages/core/src/mcp/watch-map.test.ts`

**Interfaces:**
- Produces: `export type MapChanges = (onChange: () => void) => () => void;` и `waitForMap<T>(mapFile: string, probe: Probe<T>, timeoutMs: number, pollMs: number, signal?: AbortSignal, changes?: MapChanges): Promise<T | null>`.
- Поведение: первая проба — всегда. Дальше на каждом поводе (событие `fs.watch`, тик опроса, вызов `onChange`) сначала `stat(mapFile, { bigint: true })`; та же тройка `ino:size:mtimeNs`, что у прошлой пробы, — проба не зовётся. Ошибка `stat` — проба зовётся (прежнее поведение при пропавшей карте). С `changes` — `fs.watch` не заводится, подписка снимается при любом исходе (найдено, таймаут, отмена); опрос `pollMs` остаётся запасным.

- [ ] **Step 1: Write the failing tests** — новый файл, временная карта в `mkdtemp`, хелпер `touch(file)` переписывает файл через `.tmp` + `rename` (меняет идентичность), `tick = () => new Promise(r => setTimeout(r, 30))`:

```ts
it('внешний сигнал будит ожидание без fs.watch и отписывается', async () => {
  let listener: (() => void) | null = null;
  const changes: MapChanges = (onChange) => { listener = onChange; return () => { listener = null; }; };
  let ready = false;
  const waiting = waitForMap(mapFile, async () => (ready ? 'ok' : null), 5_000, 60_000, undefined, changes);
  await tick(); ready = true; await touch(mapFile); listener!();
  await expect(waiting).resolves.toBe('ok');
  expect(listener).toBeNull();
});

it('пока файл карты не менялся, проба не зовётся', async () => {
  let calls = 0; let listener!: () => void;
  const changes: MapChanges = (onChange) => { listener = onChange; return () => {}; };
  const abort = new AbortController();
  const waiting = waitForMap(mapFile, async () => { calls++; return null; }, 5_000, 60_000, abort.signal, changes);
  await tick(); listener(); listener(); await tick();
  expect(calls).toBe(1);
  await touch(mapFile); listener(); await tick();
  expect(calls).toBe(2);
  abort.abort(); await expect(waiting).resolves.toBeNull();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @parley/core exec vitest run src/mcp/watch-map.test.ts`
Expected: FAIL (`changes` не поддержан, проба зовётся на каждый сигнал)

- [ ] **Step 3: Implement** по описанию в Interfaces.

- [ ] **Step 4: Run, expect PASS** — вместе с теми, кто ждёт через `waitForMap`

Run: `pnpm --filter @parley/core exec vitest run src/mcp/watch-map.test.ts src/mcp/inbox-watch.test.ts src/mcp/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/watch-map.ts packages/core/src/mcp/watch-map.test.ts
git commit -m "perf(core): probe a waited map only after the file changed; accept an external change signal"
```

### Task 4: `ToolRunner` — инструменты Parley без транспорта

**Files:**
- Modify: `packages/core/src/mcp/tools.ts:1564-1638` (`createParleyServer`), `:597-626` (`getMap`), `:805-900` (`waitFor`)
- Modify: `packages/core/src/mcp/context.ts:14-63` (`McpContext`)
- Modify: `packages/core/src/index.ts:577` (экспорт)
- Test: `packages/core/src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `MapChanges` из задачи 3.
- Produces:
  - `export interface ToolRunner { list(): Promise<Tool[]>; call(name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult>; }`
  - `export function createToolRunner(context: McpContext): ToolRunner` — в `tools.ts`. Внутри то, что сейчас в обработчиках сервера: `TOOLS.filter(declaredInProfile)` и инструмент навигатора в `list()`; в `call()` — отказ `find_skill` без навигатора, `bindCodexThread` до первого успеха (флаг живёт в замыкании исполнителя), `dispatch`/`navigator.find`, превращение результата в текст и ошибок в `isError` (`deniedForAgent` для `ResourceDeniedError`). Браузерных инструментов и `create_session` в исполнителе **нет**.
  - `createParleyServer(context: McpContext, runner: ToolRunner = createToolRunner(context))`: `ListTools` = `[...await runner.list(), ...(browser?.tools ?? []), ...(sessionAgent ? [CREATE_SESSION_TOOL] : [])]`; `CallTool`: `browser_*` и `create_session` — как сейчас, остальное — `runner.call(name, args, request.params._meta, extra.signal)`. Звонок `watchInbox` — только когда `runner` не передан явно.
  - В `McpContext`: `providerRows?: (signal: AbortSignal) => Promise<ProviderRow[] | null>` и `mapChanges?: MapChanges`. `getMap` берёт строки так: `context.providerRows` → иначе `fetchProviderRows(context.agent, …)` → иначе локальный реестр с `HOST_UNREACHABLE_NOTE`. `waitFor` передаёт `context.mapChanges` шестым аргументом в `waitForMap`.
  - Экспорт из `@parley/core`: `createToolRunner`, тип `ToolRunner`, тип `MapChanges`.

- [ ] **Step 1: Write the failing tests** — в `server.test.ts` (фикстура файла: работа с сессией `s-01`):

```ts
it('исполнитель без сервера: в list нет браузера и create_session, call пишет письмо как MCP', async () => {
  await updateMap(project, workId, (map) => { addSession(map, { provider: 'claude', label: 'ревью', task: 't' }); });
  const runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate });
  const names = (await runner.list()).map((tool) => tool.name);
  expect(names).toContain('send_message');
  expect(names).not.toContain('create_session');
  expect(names.some((name) => name.startsWith('browser_'))).toBe(false);
  const sent = await runner.call('send_message', { to: 's-02', text: 'привет' }, undefined);
  expect(sent.isError).not.toBe(true);
  expect((await readMap(project, workId)).messages.at(-1)).toMatchObject({ from: 's-01', to: ['s-02'], text: 'привет' });
});

it('get_map берёт строки провайдеров из context.providerRows — без запроса к хосту и без пометки', async () => {
  const row = { id: 'claude', label: 'Claude', family: 'claude' as const, available: true, needs: null, models: null, effort: false, limits: null };
  const runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, providerRows: async () => [row] });
  const body = JSON.parse((await runner.call('get_map', {}, undefined)).content[0]!.text as string);
  expect(body.providers).toEqual([{ id: 'claude', label: 'Claude', family: 'claude', available: true, models: null, effort: false }]);
  expect(body.note).toBeUndefined();
});

it('wait_for inbox просыпается от context.mapChanges', async () => {
  await updateMap(project, workId, (map) => { addSession(map, { provider: 'claude', label: 'ревью', task: 't' }); });
  let listener: (() => void) | null = null;
  const runner = createToolRunner({ projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 60_000,
    mapChanges: (onChange) => { listener = onChange; return () => { listener = null; }; } });
  const waiting = runner.call('wait_for', { target: 'inbox', timeoutSec: 30 }, undefined);
  await delay(50);
  await updateMap(project, workId, (map) => { addMessage(map, { from: 's-02', to: ['s-01'], text: 'есть' }); });
  listener!();
  const body = JSON.parse((await waiting).content[0]!.text as string);
  expect(body.state).toBe('message');
});
```

- [ ] **Step 2: Run, expect FAIL** (`createToolRunner` не существует)

Run: `pnpm --filter @parley/core exec vitest run src/mcp/server.test.ts -t "исполнитель|providerRows|mapChanges"`
Expected: FAIL

- [ ] **Step 3: Implement** по Interfaces. Поведение `createParleyServer(context)` без второго аргумента не меняется.

- [ ] **Step 4: Run, expect PASS** — все тесты MCP, они ловят регрессии переноса

Run: `pnpm --filter @parley/core exec vitest run src/mcp/`
Expected: PASS без правок ожиданий в прежних тестах

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/tools.ts packages/core/src/mcp/context.ts packages/core/src/index.ts packages/core/src/mcp/server.test.ts
git commit -m "refactor(core): run Parley tools through a transport-free ToolRunner"
```

### Task 5: Удалённый исполнитель в процессе MCP

**Files:**
- Create: `packages/core/src/mcp/remote-tools.ts`
- Create: `packages/core/src/mcp/remote-tools.test.ts`
- Modify: `packages/core/src/mcp/server.ts:22-28`
- Modify: `packages/core/src/index.ts` (экспорт типов маршрута)

**Interfaces:**
- Consumes: `ToolRunner`, `createParleyServer(context, runner)`, `waitTimeoutMs` (`tools.ts:118`).
- Produces (в `remote-tools.ts`, экспорт из `@parley/core`):
  - `export const AGENT_TOOLS_PATH = '/agent/tools'`; `export const AGENT_TOOLS_REQUEST_BYTES = 1024 * 1024`
  - `export interface ToolLaunch { skillNavigator?: boolean; skillListReduced?: boolean; nativeContextRevision?: string; toolProfile?: ToolProfile }`; `export function launchOf(context: McpContext): ToolLaunch`
  - `export type RemoteToolRequest = { op: 'list'; launch: ToolLaunch } | { op: 'call'; launch: ToolLaunch; name: string; args: Record<string, unknown>; meta?: Record<string, unknown>; callId: string };` ответ — `{ ok: true; result: { tools: Tool[] } | CallToolResult } | { ok: false; error: { code: string; message: string } }`
  - `export function createRemoteToolRunner(agent: AgentChannel, launch: ToolLaunch, options?: { retryBudgetMs?: number; retryDelaysMs?: readonly number[]; callTimeoutMs?: number }): ToolRunner`
  - Тексты агенту: `HOST_NOT_RESPONDING = 'Parley host is not responding, try again.'`, `SESSION_LINK_EXPIRED = "This session's link to Parley has expired: ask the human to restart the session from Parley."`, `ARGUMENTS_TOO_LARGE = 'The tool arguments are larger than 1 MiB: write the long part to a file and pass its path.'`
- Значения: POST на `new URL(AGENT_TOOLS_PATH, agent.url)`, `Authorization: Bearer <token>`, `redirect: 'error'`. `callId` — `randomUUID()` один на вызов и на все его повторы. Таймаут запроса: `list` — 30 с; `call` — `callTimeoutMs` (120 000); для `wait_for` — `waitTimeoutMs(args.timeoutSec) + 30_000`. Повторы — при сетевой ошибке, таймауте запроса и ответах 502/503/504; паузы `retryDelaysMs` (по умолчанию 250, 500, 1000, 2000, 4000, 8000, дальше 8000), пока суммарно не выйдет `retryBudgetMs` (30 000). 401 → `SESSION_LINK_EXPIRED`, 413 → `ARGUMENTS_TOO_LARGE`, без повторов. `{ ok: false }` → `isError` с `error.message`. Отмена `signal` вызывающим — повторов нет, ответ `isError` с текстом `Cancelled.`.
- `server.ts`: канал агента есть и `sessionId !== null` → `createParleyServer(context, createRemoteToolRunner(context.agent, launchOf(context)))`; иначе как сейчас.

- [ ] **Step 1: Write the failing tests** — фальшивый хост на `node:http` (как в `provider-rows.test.ts`), запросы складываются в массив `seen`:

```ts
it('list и call уходят на /agent/tools с токеном, launch и _meta', async () => { /* хост отвечает { ok: true, result: { tools: [{ name: 'get_map', inputSchema: { type: 'object' } }] } } на list и { ok: true, result: { content: [{ type: 'text', text: '{}' }] } } на call */
  const threadId = '019a0c2e-5d3f-7b11-9c44-8e2f6a1b3c4d';
  const runner = createRemoteToolRunner(agent, { toolProfile: 'short' });
  expect((await runner.list()).map((tool) => tool.name)).toEqual(['get_map']);
  await runner.call('get_map', {}, { threadId });
  expect(seen.map((r) => r.url)).toEqual(['/agent/tools', '/agent/tools']);
  expect(seen[0]!.authorization).toBe(`Bearer ${agent.token}`);
  expect(seen[1]!.body).toMatchObject({ op: 'call', name: 'get_map', launch: { toolProfile: 'short' }, meta: { threadId } });
  expect(seen[1]!.body.callId).toMatch(/^[0-9a-f-]{36}$/);
});

it('повтор после обрыва несёт тот же callId', async () => { /* первый запрос хост рвёт (req.socket.destroy()), второй отвечает ok */
  const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 1_000 });
  const result = await runner.call('send_message', { to: 's-02', text: 'x' }, undefined);
  expect(result.isError).not.toBe(true);
  expect(seen).toHaveLength(2);
  expect(seen[1]!.body.callId).toBe(seen[0]!.body.callId);
});

it('хост молчит дольше бюджета — HOST_NOT_RESPONDING', async () => { /* хост всегда 503 */
  const runner = createRemoteToolRunner(agent, {}, { retryDelaysMs: [10], retryBudgetMs: 100 });
  const result = await runner.call('get_map', {}, undefined);
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: HOST_NOT_RESPONDING }] });
});

it('401 — без повторов, текст про перезапуск', async () => { /* хост отвечает 401 */
  const result = await createRemoteToolRunner(agent, {}, { retryDelaysMs: [10] }).call('get_map', {}, undefined);
  expect(result.content[0]).toMatchObject({ text: SESSION_LINK_EXPIRED });
  expect(seen).toHaveLength(1);
});

it('413 — понятный отказ про размер', async () => { /* хост отвечает 413 */
  const result = await createRemoteToolRunner(agent, {}).call('plan_submit', { goal: 'x' }, undefined);
  expect(result).toMatchObject({ isError: true, content: [{ text: ARGUMENTS_TOO_LARGE }] });
});

it('в режиме канала MCP не открывает файл карты', async () => {
  // Работа во временном проекте (createWork), затем её map.json удалён: любое чтение карты в процессе MCP упало бы.
  await rm(workPaths(project, workId).map);
  const context = { projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false, agent };
  const server = createParleyServer(context, createRemoteToolRunner(agent, {}));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(['get_map', 'create_session', 'browser_open']));
  expect((await client.callTool({ name: 'get_map', arguments: {} })).isError).not.toBe(true);
  await client.close(); await server.close();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @parley/core exec vitest run src/mcp/remote-tools.test.ts`
Expected: FAIL (модуля нет)

- [ ] **Step 3: Implement** `remote-tools.ts` по Interfaces и развилку в `server.ts`.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @parley/core exec vitest run src/mcp/remote-tools.test.ts src/mcp/server.test.ts src/mcp/context.test.ts src/mcp/legacy-env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/remote-tools.ts packages/core/src/mcp/remote-tools.test.ts packages/core/src/mcp/server.ts packages/core/src/index.ts
git commit -m "feat(core): forward Parley tool calls to the host when the session has an agent channel"
```

### Task 6: Маршрут хоста `/agent/tools`

**Files:**
- Create: `packages/host/src/agent/tools-endpoint.ts`
- Create: `packages/host/src/agent/tool-context.ts`
- Create: `packages/host/src/agent/tools-endpoint.test.ts`
- Modify: `packages/host/src/host.ts:366-392` (создание и монтирование), `:466-467` (снятие токена)

**Interfaces:**
- Consumes: из `@parley/core` — `createToolRunner`, `ToolRunner`, `ToolLaunch`, `RemoteToolRequest`, `AGENT_TOOLS_PATH`, `AGENT_TOOLS_REQUEST_BYTES`, `MapChanges`, `McpContext`, `ProviderRow`, `loadConfig`, `workPaths`; из `@parley/protocol` — `SessionRef`.
- Produces:
  - `tool-context.ts`: `export async function hostToolContext(ref: SessionRef, launch: ToolLaunch, deps: { providerRows(): Promise<ProviderRow[]>; onWorksChange(listener: () => void): () => void }): Promise<McpContext>` → `{ projectPath, workId, workDir: workPaths(projectPath, workId).dir, sessionId, channel: false, messageRate, worktreeRoot (из loadConfig), ...launch, providerRows: ошибка → null, mapChanges: deps.onWorksChange }`. Поля `agent` нет.
  - `tools-endpoint.ts`: `export function createToolsEndpoint(options: { authenticate(req: IncomingMessage): SessionRef | undefined; contextFor(ref: SessionRef, launch: ToolLaunch): Promise<McpContext>; now?: () => number }): { handle(req: IncomingMessage, res: ServerResponse): void; forget(ref: SessionRef): void }`.
- Поведение `handle`:
  - нет токена — 401; `content-length` или поток тела больше `AGENT_TOOLS_REQUEST_BYTES` — 413 (чтение тела — как в `session-endpoint.ts`, но со своим потолком);
  - неверная форма тела — `{ ok: false, error: { code: 'bad_request', message } }`;
  - исполнитель на сессию (ключ `projectPath\0workId\0sessionId`) создаётся `createToolRunner(await contextFor(ref, launch))` и живёт, пока `launch` тот же; новый `launch` — новый исполнитель;
  - `call` с уже виденным `callId` отдаёт тот же `Promise<CallToolResult>` (и для идущего, и для законченного); запоминание — 10 минут (`CALL_REPLAY_TTL_MS = 10 * 60_000`), не больше 256 на сессию (`CALL_REPLAY_LIMIT`);
  - `res.on('close')` при незаконченном ответе отменяет `AbortController` вызова;
  - перед ответом токен проверяется ещё раз (как у соседних маршрутов).
  - `forget(ref)` убирает исполнителя и память `callId` сессии.
- `host.ts`: `const toolsEndpoint = createToolsEndpoint({ authenticate: (req) => browserEndpoint.authenticate(req), contextFor: (ref, launch) => hostToolContext(ref, launch, { providerRows: <как list у providersEndpoint>, onWorksChange: (l) => worksService.onChange(() => l()) }) })`; маршрут `[AGENT_TOOLS_PATH]: (req, res) => toolsEndpoint.handle(req, res)`; `unregister: (ref) => { browserEndpoint.unregister(ref); toolsEndpoint.forget(ref); }`.

- [ ] **Step 1: Write the failing tests** — `tools-endpoint.test.ts`: временная работа через `createWork` с сессиями `s-01` и `s-02`, настоящий `http.createServer((req, res) => endpoint.handle(req, res))` на порту 0, `authenticate` — по таблице токенов, `contextFor` — `hostToolContext` с заглушками `providerRows: async () => []` и ручным `onWorksChange`:

```ts
it('runs a tool for the bearer session and writes the map in the host process', async () => {
  const reply = await post({ op: 'call', launch: {}, name: 'send_message', args: { to: 's-02', text: 'hi' }, callId: randomUUID() });
  expect(reply.ok).toBe(true);
  expect((await readMap(project, workId)).messages.at(-1)).toMatchObject({ from: 's-01', to: ['s-02'], text: 'hi' });
});

it('a replayed callId does not run the tool twice', async () => {
  const callId = randomUUID();
  const body = { op: 'call', launch: {}, name: 'send_message', args: { to: 's-02', text: 'once' }, callId };
  await Promise.all([post(body), post(body)]); await post(body);
  expect((await readMap(project, workId)).messages.filter((m) => m.text === 'once')).toHaveLength(1);
});

it('lists the profile tools without browser tools or create_session', async () => {
  const reply = await post({ op: 'list', launch: { toolProfile: 'short' } });
  const names = (reply.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  expect(names).toContain('get_map'); expect(names).not.toContain('remember'); expect(names).not.toContain('create_session');
});

it('closing the request aborts a pending wait_for', async () => {
  const controller = new AbortController();
  const pending = post({ op: 'call', launch: {}, name: 'wait_for', args: { target: 'inbox', timeoutSec: 600 }, callId: randomUUID() }, { signal: controller.signal }).catch(() => null);
  await delay(100); controller.abort(); await pending;
  await expect.poll(() => waiters()).toBe(0); // waiters() — число живых подписок onWorksChange
});

it('401 without a token, 413 past 1 MiB, 200 KB arguments pass', async () => {
  expect((await raw({ op: 'list', launch: {} }, { token: null })).status).toBe(401);
  expect((await raw({ op: 'call', launch: {}, name: 'get_map', args: { pad: 'x'.repeat(AGENT_TOOLS_REQUEST_BYTES) }, callId: randomUUID() })).status).toBe(413);
  const big = await post({ op: 'call', launch: {}, name: 'get_map', args: { pad: 'x'.repeat(200_000) }, callId: randomUUID() });
  expect(big.ok).toBe(true);
});
```

  `post` возвращает разобранный конверт, `raw` — `Response`. Ошибка самого инструмента приходит внутри `result` с `isError: true` при `ok: true`; `ok: false` — только отказ маршрута. Поэтому `big.ok === true` значит «тело принято», даже если `get_map` отверг лишний `pad`.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/agent/tools-endpoint.test.ts`
Expected: FAIL (модуля нет)

- [ ] **Step 3: Implement** `tool-context.ts`, `tools-endpoint.ts` и привязку в `host.ts` по Interfaces.

- [ ] **Step 4: Run, expect PASS** — новый файл и соседи по маршрутам

Run: `pnpm --filter @parley/host exec vitest run src/agent/ src/hooks/hook-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/agent/tools-endpoint.ts packages/host/src/agent/tool-context.ts packages/host/src/agent/tools-endpoint.test.ts packages/host/src/host.ts
git commit -m "feat(host): run agents' Parley tools in the host over /agent/tools"
```

### Task 7: Сводная проверка и живая приёмка

**Files:** без правок.

- [ ] **Step 1: Сборки, типы, линт, страж рамки**

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host build && pnpm --filter @parley/desktop typecheck && pnpm lint && pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`
Expected: без ошибок

- [ ] **Step 2: Тесты затронутых каталогов, по пакету за прогон**

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts src/mcp/ && pnpm --filter @parley/host exec vitest run src/agent/ src/works/works-service.test.ts src/sessions/sessions-service.test.ts`
Expected: PASS (флейки под нагрузкой — `works-service`, `sessions-service`: перезапустить файл в одиночку)

- [ ] **Step 3: Живая приёмка — делает человек на dev-окне с отдельным домом** (рецепт: `PARLEY_LOGIN_SHELL=skip PARLEY_HOME=~/.parley-dev PARLEY_WORKTREE_ROOT=~/.parley-dev/worktrees npx electron out/main/index.js` из `packages/desktop` после `pnpm --filter @parley/desktop build`):
  - комната из трёх агентов (Claude и Codex) обменивается письмами: письма доходят, ответы приходят;
  - `wait_for inbox` у агента возвращается в пределах ~1 с после письма;
  - `lsof -p <pid процесса MCP агента> | grep map.json` — пусто;
  - в журнале хоста строки `host: состояние` при той же нагрузке — задержка цикла p99 не хуже, чем до правки (снять до и после).

- [ ] **Step 4: Текст для PR** — по-английски, абзац о сути (tools of host-launched agents now run in the host; MCP processes no longer read `map.json`; sessions without an agent channel keep the old direct path) и строка для будущей записи в CHANGELOG.
