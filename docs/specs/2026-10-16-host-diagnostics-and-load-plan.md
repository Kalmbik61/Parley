# Диагностика и разгрузка хоста — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** кнопка Diagnostics в строке статуса собирает zip с логами хоста, картиной ресурсов, журналом задержек и CPU-профилем, а хост получает два дешёвых ограничения (scrollback 1000, потолок батчера), каждое со своим замером «до/после».

**Architecture:** хост раз в 30 с пишет строку `host: состояние` (CPU, память, лаг цикла событий, счётчики) и журнал задержек с полем `op`; новые RPC `host.diagnostics`, `host.profile.start`, `host.profile.status` отдают мгновенный снимок и пишут `.cpuprofile` через `node:inspector`. Electron main собирает архив сам (логи с диска, `ps`, кольцо своих RPC-вызовов, ответ хоста с таймаутом) своим zip-писателем на `zlib` и показывает файл в Finder. Окно добавляет сегмент-поповер в строку статуса, действие палитры и метку `requestedAt` в outbox отправки.

**Tech Stack:** TypeScript, Node 22 (хост) / Electron 44 (Node 24), vitest, zod (протокол), `node:perf_hooks`, `node:inspector`, `node:zlib`, React + Radix Popover + Tailwind + lucide-react + sonner (окно), Playwright + Electron (E2E), pnpm workspace.

**Spec:** [`docs/specs/2026-10-16-host-diagnostics-and-load-design.md`](2026-10-16-host-diagnostics-and-load-design.md) — читать вместе с планом.

## Global Constraints

- База — `origin/master` (97f79578 или новее): локальный `master` отстаёт, а `timing.ts` и `loop-delay.ts` есть только на origin. Задачи 1–14 — ветка `feat/host-diagnostics`; задачи 16 и 17 — свои ветки от той же базы, сливаются только после baseline (задача 15).
- Worktree: `git worktree add .claude/worktrees/host-diagnostics -b feat/host-diagnostics origin/master`; перед `pnpm install` и тяжёлыми прогонами — `uptime`, при load average не меньше числа ядер отложить. После правок `packages/core` или `packages/protocol` перед тестами хоста и окна — `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Тексты окна и README архива — только по-английски, в `packages/desktop/src/shared/strings.ts` (страж `packages/desktop/src/english-ui.test.ts` сканирует все `.ts/.tsx` под `src`, включая main). В хосте кириллица допустима только в первом аргументе `log.*` (страж `packages/host/src/english-text.test.ts`): значения `op`, ключи и строковые значения данных журнала — ASCII. Комментарии, тесты и документы — по-русски.
- Приватность архива: только `comm` процессов (без argv), никаких текстов сообщений, вывода терминалов, `providers.json`, ключей и env. Новые записи журнала несут длины и идентификаторы, не текст.
- Ничего не отправляется само; архив — в `~/Downloads` (`app.getPath('downloads')`), для тестов — `PARLEY_DIAGNOSTICS_DIR`. Хост пишет только в `~/.parley/host/diagnostics/`.
- Совместимость: новые методы необязательны — окно гейтит через `useHostSupports('host.diagnostics')`; без них архив собирается из файлов и `ps`, а `host-info.json` помечает `responded: false`. `requestedAt` — необязательное поле `pty.send`/`rooms.send`; старый хост его отбрасывает (zod strip), новый без поля пишет `queueMs: null`.
- Кнопка не подвешивает окно и хост: сборка в main асинхронная, файлы читаются потоками кусками ≤ 1 МиБ, `ps` через `spawn` с таймаутом 5 с, ответ хоста с таймаутом 5 с.
- Константы: `HEALTH_INTERVAL_MS = 30_000`; `PROFILE_DEFAULT_SECONDS = 20`, `PROFILE_MAX_SECONDS = 60`, `PROFILE_KEEP = 5`, `PROFILE_SAMPLING_US = 1000`; `RPC_RING_CAPACITY = 1000`; `DIAGNOSTICS_CALL_TIMEOUT_MS = 5000`; `PROFILES_MAX_AGE_MS = 24 * 3600 * 1000`; `DEFAULT_SCROLLBACK = 1000` (задача 16); `OUTPUT_BATCH_MAX_CHARS = 256 * 1024` (задача 17).
- Новые методы не входят в `WORKS_GATED_METHODS` (тест `methods/index.test.ts` пиняет его состав) и не добавляются в `REQUIRED_METHODS` окна. `server.test.ts` требует, чтобы каждый ключ `METHODS` имел зарегистрированный обработчик в настоящем `startHost`.
- Раскладка строки статуса проверяется в окне 800×500 при масштабе 1 и 2: сегмент на узком окне — только иконка.
- Один коммит на задачу, сообщение по-русски в стиле репозитория (`feat(host): …`, `feat(desktop): …`), последней строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Хост завис и не отвечает на RPC — архив всё равно собирается не дольше ~6 с, `host-info.json` = `{responded:false, timeoutMs:5000}`, `hostResponded: false` (задача 11, тест «хост не ответил»).
2. `host.log.1` или `host.err` ещё не существуют (свежая установка) — архив собирается без них и без ошибки, `README.txt` на месте (задача 9, тест «отсутствующий файл пропускается»; задача 11, тест «свежий дом»).
3. Второй клик «Record profile» во время записи — второй профиль не стартует, хост отвечает текущим `running`, кнопки сегмента заблокированы до конца (задача 2, тест «повторный старт»; задача 12, тест «кнопки заблокированы»).
4. Старый хост без `host.diagnostics` — сегмент работает, кнопка профиля заблокирована, видна подсказка про перезапуск; main получает отказ `unknown method` и пишет `responded:false` (задача 12, тест «старый хост»; задача 11, тест «метод не поддержан»).
5. `requestedAt` из будущего (расхождение часов) или отсутствует — `queueMs` не отрицательный и не `NaN`, запись не падает (задача 4, тест «без requestedAt» и «requestedAt в будущем»).

---

### Task 1: Строка состояния хоста (HealthService)

**Files:**
- Create: `packages/host/src/health/health-service.ts`
- Test: `packages/host/src/health/health-service.test.ts`
- Modify: `packages/host/src/feed/feed-service.ts` (интерфейс `FeedService` ~154, `subscribers` ~312)
- Modify: `packages/host/src/methods/pty.ts` (возвращаемый объект `createPtyHandlers`, карта `attached` ~46)
- Modify: `packages/host/src/methods/index.ts` (`HostHandlers` ~130)
- Modify: `packages/host/src/host.ts` (после `startLoopDelayLog` ~213, после `createHostHandlers` ~377)

**Interfaces:**
- Consumes: `Log` (`log.ts`), `monitorEventLoopDelay` (`node:perf_hooks`), `HostContext.clients()`, `PtyManager.list()`, `WorksService.snapshot().entries`.
- Produces:
  ```ts
  export const HEALTH_INTERVAL_MS = 30_000;
  export interface HealthCounters { ptys: number; attached: number; feedSubs: number; works: number; rooms: number; clients: number }
  export interface HealthSample extends HealthCounters {
    cpuPct: number; rssMb: number; heapMb: number; extMb: number;
    loop: { maxMs: number; p99Ms: number; meanMs: number };
  }
  export interface HealthService { sample(): HealthSample; start(): void; stop(): void }
  export function createHealthService(deps: {
    log: Log; counters: () => HealthCounters;
    histogram?: Pick<IntervalHistogram, 'enable' | 'disable' | 'reset' | 'max' | 'mean' | 'percentile'>;
    cpuUsage?: typeof process.cpuUsage; memoryUsage?: typeof process.memoryUsage;
    now?: () => number; intervalMs?: number;
  }): HealthService;
  ```
  `FeedService.subscriberCount(): number` (сумма размеров множеств в `subscribers`); `createPtyHandlers(...)` дополнительно возвращает `attachedCount(): number` (сумма размеров множеств в `attached`) и `isAttached(ref: SessionRef): boolean`; `HostHandlers.counters: { ptyAttached(): number }`.

- [ ] **Step 1: Написать падающий тест**

```ts
// health-service.test.ts — fake timers, как в loop-delay.test.ts
it('раз в 30 с пишет host: состояние с CPU, памятью, лагом и счётчиками', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let usage = { user: 0, system: 0 };
  const cpuUsage = vi.fn((prev?: NodeJS.CpuUsage) => prev ? { user: usage.user - prev.user, system: usage.system - prev.system } : usage);
  const histogram = { enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), max: 120_000_000, mean: 3_000_000, percentile: vi.fn(() => 40_000_000) };
  const service = createHealthService({ log, counters: () => ({ ptys: 15, attached: 3, feedSubs: 2, works: 4, rooms: 2, clients: 1 }),
    histogram, cpuUsage: cpuUsage as typeof process.cpuUsage,
    memoryUsage: (() => ({ rss: 490 * 1024 * 1024, heapUsed: 200 * 1024 * 1024, external: 30 * 1024 * 1024 })) as typeof process.memoryUsage,
    intervalMs: 30_000 });
  service.start();
  usage = { user: 15_000_000, system: 0 }; // 15 с CPU за 30 с стены
  vi.advanceTimersByTime(30_000);
  expect(log.info).toHaveBeenCalledWith('host: состояние', {
    cpuPct: 50, rssMb: 490, heapMb: 200, extMb: 30, loop: { maxMs: 120, p99Ms: 40, meanMs: 3 },
    ptys: 15, attached: 3, feedSubs: 2, works: 4, rooms: 2, clients: 1 });
  expect(histogram.reset).toHaveBeenCalledTimes(1);
});
it('sample() отдаёт текущее окно без сброса гистограммы', ...); // reset не вызван, cpuPct по дельте от последнего тика
it('stop() снимает таймер и выключает гистограмму', ...);
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `pnpm --filter @parley/host exec vitest run src/health/health-service.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `createHealthService`**

`cpuPct = round1((user + system) / 1000 / wallMs * 100)` по дельте `cpuUsage(prev)` с прошлого тика (или старта); память в МиБ округлённо; лаг из гистограммы в мс как в `loop-delay.ts` (`NS_PER_MS`); таймер `unref()`; `sample()` считает то же без `reset()`.

- [ ] **Step 4: Добавить счётчики в сервисы и собрать `counters` в host.ts**

`feedService.subscriberCount()`, `createPtyHandlers` → `attachedCount()` и `isAttached(ref)`, пробросить `attachedCount` как `handlers.counters.ptyAttached`. В host.ts после 213: `const health = createHealthService({ log, counters: () => ({ ptys: ptyManager.list().length, attached: handlers.counters.ptyAttached(), feedSubs: feedService.subscriberCount(), works: worksService.snapshot().entries.length, rooms: <сумма комнат по entries — поле комнат в WorkMap, см. addRoom в core>, clients: handle.context.clients().length }) })`. Счётчики читаются лениво при `sample()`, поэтому замыкание вправе ссылаться на `handlers`, объявленный ниже; `health.start()` — сразу после `createHostHandlers`; `handle.context.onShutdown(async () => health.stop())`. Переменную `health` объявить до `createHostHandlers` (нужна задаче 3).

- [ ] **Step 5: Прогнать тесты хоста**

Run: `pnpm --filter @parley/host test`
Expected: PASS, включая `host.test.ts` и `methods/index.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/health packages/host/src/feed/feed-service.ts packages/host/src/methods/pty.ts packages/host/src/methods/index.ts packages/host/src/host.ts
git commit -m "feat(host): строка состояния host: состояние раз в 30 с — CPU, память, лаг цикла, счётчики"
```

---

### Task 2: Профилировщик CPU по запросу

**Files:**
- Create: `packages/host/src/diagnostics/profiler.ts`
- Test: `packages/host/src/diagnostics/profiler.test.ts`
- Modify: `packages/protocol/src/types.ts` (новый тип `ProfileStatus`), `packages/protocol/src/index.ts` (экспорт)
- Modify: `packages/host/src/host.ts` (создание, `onShutdown`)

**Interfaces:**
- Consumes: `node:inspector` `Session` (`connect`, `post(method, params?, cb)`), `Log`.
- Produces:
  ```ts
  // protocol/src/types.ts
  export type ProfileStatus =
    | { state: 'idle' }
    | { state: 'running'; startedAt: string; seconds: number }
    | { state: 'done'; file: string; finishedAt: string }
    | { state: 'failed'; error: string };
  // host/src/diagnostics/profiler.ts
  export const PROFILE_DEFAULT_SECONDS = 20; export const PROFILE_MAX_SECONDS = 60; export const PROFILE_KEEP = 5; export const PROFILE_SAMPLING_US = 1000;
  export interface ProfilerSession { connect(): void; disconnect(): void; post(method: string, params: object | undefined, cb: (err: Error | null, result?: unknown) => void): void }
  export interface Profiler { start(seconds?: number): ProfileStatus; status(): ProfileStatus; files(): Promise<string[]>; stop(): Promise<void> }
  export function createProfiler(deps: { dir: string; log: Log; session?: () => ProfilerSession; now?: () => Date; setTimer?: typeof setTimeout; keep?: number }): Profiler;
  ```
  Файл: `<dir>/host-YYYYMMDD-HHMMSS.cpuprofile`, содержимое — `JSON.stringify(profile)` из `Profiler.stop`. `files()` — пути `.cpuprofile` в `dir`, новые первыми. `start()` при `running` возвращает текущий статус, не трогая сессию; `seconds` ограничивается `PROFILE_MAX_SECONDS`; после записи лишние файлы (старше `keep` новых) удаляются; `stop()` при `running` останавливает профиль и пишет файл.

- [ ] **Step 1: Написать падающие тесты**

```ts
it('start пишет .cpuprofile через заданное число секунд и переводит статус в done', async () => {
  const posts: string[] = [];
  const session = { connect: vi.fn(), disconnect: vi.fn(),
    post: (m: string, _p: object | undefined, cb: (e: Error | null, r?: unknown) => void) => { posts.push(m); cb(null, m === 'Profiler.stop' ? { profile: { nodes: [], samples: [], timeDeltas: [] } } : undefined); } };
  const profiler = createProfiler({ dir, log, session: () => session, now: () => new Date('2026-10-16T10:00:00Z') });
  expect(profiler.start(2)).toEqual({ state: 'running', startedAt: '2026-10-16T10:00:00.000Z', seconds: 2 });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(profiler.status()).toMatchObject({ state: 'done', file: path.join(dir, 'host-20261016-100000.cpuprofile') });
  expect(posts).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop']);
  expect(JSON.parse(await readFile(path.join(dir, 'host-20261016-100000.cpuprofile'), 'utf8'))).toHaveProperty('nodes');
});
it('повторный start во время записи возвращает running и не открывает вторую сессию', ...);
it('seconds > 60 режется до 60, без аргумента — 20', ...);
it('хранит только 5 последних файлов', ...); // создать 6 файлов с разными mtime, затем start+done → самый старый удалён
it('настоящий inspector: профиль за 300 мс парсится и содержит nodes', async () => { /* без fake timers, реальный Session */ });
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `pnpm --filter @parley/host exec vitest run src/diagnostics/profiler.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Добавить `ProfileStatus` в протокол, собрать протокол, реализовать `createProfiler`**

`Profiler.setSamplingInterval` с `{ interval: PROFILE_SAMPLING_US }`; ошибка любого `post` → статус `failed` с `error.message`, сессия закрывается; `mkdir -p dir` перед записью; запись через `writeFile` в `.tmp` и `rename`.

- [ ] **Step 4: Подключить в host.ts**

`const profiler = createProfiler({ dir: path.join(paths.dir, 'diagnostics'), log })` рядом с `health`; `handle.context.onShutdown(async () => profiler.stop())`.

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter @parley/protocol build && pnpm --filter @parley/host test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types.ts packages/protocol/src/index.ts packages/host/src/diagnostics packages/host/src/host.ts
git commit -m "feat(host): CPU-профиль хоста по запросу через node:inspector"
```

---

### Task 3: Методы `host.diagnostics`, `host.profile.start`, `host.profile.status`

**Files:**
- Modify: `packages/protocol/src/methods.ts` (схемы после `'host.info'` ~94; `Results` после ~296), `packages/protocol/src/types.ts` (`HostDiagnostics`), `packages/protocol/src/index.ts`
- Create: `packages/host/src/methods/diagnostics.ts`
- Test: `packages/host/src/methods/diagnostics.test.ts`
- Modify: `packages/host/src/methods/index.ts` (`MethodDeps` ~58, регистрация ~163), `packages/host/src/host.ts` (~360: `health`, `profiler`)

**Interfaces:**
- Consumes: `HealthService` (задача 1), `Profiler` (задача 2), `PtyManager.list()`, `ActivityService.get(ref)?.activity.activity`, `HostContext`.
- Produces:
  ```ts
  // protocol methods.ts
  'host.diagnostics': z.object({}),
  'host.profile.start': z.object({ seconds: z.number().int().min(1).max(60).optional() }),
  'host.profile.status': z.object({}),
  // Results
  'host.diagnostics': HostDiagnostics; 'host.profile.start': ProfileStatus; 'host.profile.status': ProfileStatus;
  // protocol types.ts
  export interface HostDiagnosticsSession { ref: SessionRef; provider: string | null; activity: string | null; pid: number; startedAt: string; attached: boolean }
  export interface HostDiagnostics {
    hostVersion: string; node: string; platform: string; release: string; arch: string; pid: number; startedAt: string; uptimeSec: number;
    health: HealthSample /* те же поля, что в задаче 1 — объявить тип в protocol и импортировать его в health-service.ts */;
    sessions: HostDiagnosticsSession[]; profiles: string[]; profile: ProfileStatus;
  }
  // host methods/diagnostics.ts
  export function createDiagnosticsHandlers(deps: { health: HealthService; profiler: Profiler; pty: Pick<PtyManager, 'list'>; activity: Pick<ActivityService, 'get'>; isAttached: (ref: SessionRef) => boolean }): {
    hostDiagnostics: Handler<'host.diagnostics'>; profileStart: Handler<'host.profile.start'>; profileStatus: Handler<'host.profile.status'>;
  };
  ```
  `MethodDeps` получает `health?: HealthService; profiler?: Profiler`; три метода регистрируются, когда оба заданы, `isAttached` берётся из объекта pty-обработчиков (задача 1) внутри `createHostHandlers`. `HealthSample` переезжает в `protocol/src/types.ts`, `health-service.ts` импортирует его оттуда.

- [ ] **Step 1: Написать падающий тест обработчиков** (по образцу `compaction-methods.test.ts`: `undefined as never` вместо request, кроме `hostDiagnostics`, которому нужен `{ host: fakeHost() }` как в `methods/pty.test.ts:43`)

```ts
it('host.diagnostics отдаёт версии, состояние, сессии и профили', async () => {
  const handlers = createDiagnosticsHandlers({ health: { sample: () => SAMPLE } as HealthService, profiler: { status: () => ({ state: 'idle' }), files: async () => ['/h/diagnostics/host-1.cpuprofile'] } as unknown as Profiler,
    pty: { list: () => [{ ref, pid: 42, startedAt: 1_700_000_000_000, provider: 'claude' } as PtyHandle] }, activity: { get: () => ({ activity: { activity: 'working' } }) } as never, isAttached: () => true });
  const result = await handlers.hostDiagnostics({}, { host: fakeHost(), client: undefined as never });
  expect(result).toMatchObject({ hostVersion: '0.0.0', node: process.version, platform: process.platform, arch: process.arch, health: SAMPLE,
    sessions: [{ ref, provider: 'claude', activity: 'working', pid: 42, startedAt: '2023-11-14T22:13:20.000Z', attached: true }], profiles: ['/h/diagnostics/host-1.cpuprofile'], profile: { state: 'idle' } });
  expect(typeof result.uptimeSec).toBe('number');
});
it('host.profile.start без seconds зовёт profiler.start(20), с seconds — как есть', ...);
it('host.profile.status отдаёт profiler.status()', ...);
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `pnpm --filter @parley/host exec vitest run src/methods/diagnostics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Протокол, обработчики, регистрация, проброс из host.ts**

`release` = `os.release()`, `uptimeSec` = `Math.round(process.uptime())`, `startedAt` сессии = `new Date(handle.startedAt).toISOString()`.

- [ ] **Step 4: Прогнать тесты хоста и окна**

Run: `pnpm --filter @parley/protocol build && pnpm --filter @parley/host test && pnpm --filter @parley/desktop exec vitest run src/renderer/lib/capabilities.test.ts src/main/ipc.test.ts`
Expected: PASS; `server.test.ts` «hello перечисляет все методы» зелёный.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src packages/host/src/methods/diagnostics.ts packages/host/src/methods/diagnostics.test.ts packages/host/src/methods/index.ts packages/host/src/host.ts packages/host/src/health/health-service.ts
git commit -m "feat(protocol,host): методы host.diagnostics и host.profile.*"
```

---

### Task 4: Журнал задержек: `requestedAt`, `pty.send`, `rooms.send`, `room.create`, `pty.clientDropped`

**Files:**
- Modify: `packages/protocol/src/methods.ts` (`'pty.send'` ~265, `'rooms.send'` ~239: `requestedAt: z.number().optional()`)
- Modify: `packages/host/src/pty/send.ts` (`createSender` ~50, возврат ~115-126)
- Modify: `packages/host/src/methods/pty.ts` (`PtyMethodDeps` ~22, fan-out ~58-72, `ptySend` ~130)
- Modify: `packages/host/src/methods/rooms.ts` (`roomsCreate` ~28, `roomsSend` ~32)
- Modify: `packages/host/src/methods/index.ts` (`MethodDeps.log?: Log`), `packages/host/src/host.ts` (~360: `log`)
- Test: `packages/host/src/pty/send.test.ts`, `packages/host/src/methods/pty.test.ts`, `packages/host/src/methods/rooms.test.ts`

**Interfaces:**
- Consumes: `Log`, `typeAndSubmit` (`AttemptOutcome`), `RequestInfo.host.log`.
- Produces: `createSender(deps)` возвращает `(params: { ref; text; submit; requestedAt?: number }, log?: Log) => Promise<SendResult>`; записи:
  - `log.info('сообщение в сессию', { op: 'pty.send', ref, chars: clean.length, queueMs: number | null, typeMs, enterMs: number | null, outcome })` — `queueMs = requestedAt === undefined ? null : Math.max(0, now - requestedAt)`, `typeMs` — от входа в обработчик до возврата `typeAndSubmit`, `enterMs` — от возврата `typeAndSubmit` до `attempt.done` (при `submit=false` или `hadDraft` — `null`), `outcome` — `SendReason` при отказе (`'blocked'`, `'busy'`, `'no-paste-mode'`), иначе `AttemptOutcome` или `'draft'`/`'typed'`. Пишется один раз на вызов, включая отказы.
  - `log.info('клиент PTY отброшен', { op: 'pty.clientDropped', ref, client: client.name, queuedBytes: client.writableLength() })` в fan-out при `!delivered`.
  - `roomsCreate`: `host.log.info('комната создана', { op: 'room.create', roomId, members: params.members.length, ms })`; `roomsSend`: `host.log.info('письмо принято', { op: 'rooms.send', messageId, to: params.to.length, roomId: params.roomId, queueMs, ms })`.

- [ ] **Step 1: Написать падающие тесты**

```ts
// send.test.ts (есть фабрика fake pty/activity/wake — дополнить)
it('пишет op pty.send с queueMs, typeMs, enterMs и outcome submitted', async () => { /* requestedAt = now - 1200 → queueMs 1200; enterDelayMs 0 */ });
it('без requestedAt queueMs null; requestedAt в будущем даёт queueMs 0', ...);
it('отказ busy пишется с outcome busy и enterMs null', ...);
// methods/pty.test.ts
it('недоставленный чанк пишет op pty.clientDropped с queuedBytes', ...); // fakeClient(false)
// methods/rooms.test.ts
it('rooms.create пишет op room.create с числом участников и ms', ...);
it('rooms.send пишет op rooms.send с queueMs от requestedAt', ...);
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `pnpm --filter @parley/host exec vitest run src/pty/send.test.ts src/methods/pty.test.ts src/methods/rooms.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализовать**

Схемы в протоколе; `ptySend: (params, { host }) => send(params, host.log)`; `deps.log?.info(...)` в fan-out; в `methods/rooms.ts` обработчики принимают `{ host }` и меряют `performance.now()`.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter @parley/protocol build && pnpm --filter @parley/host test`
Expected: PASS, страж `english-text.test.ts` зелёный (значения данных — ASCII).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/methods.ts packages/host/src/pty/send.ts packages/host/src/pty/send.test.ts packages/host/src/methods packages/host/src/host.ts
git commit -m "feat(host): журнал задержек — pty.send с requestedAt, rooms.send, room.create, pty.clientDropped"
```

---

### Task 5: Журнал задержек: `session.ready`

**Files:**
- Create: `packages/host/src/sessions/ready-journal.ts`
- Test: `packages/host/src/sessions/ready-journal.test.ts`
- Modify: `packages/host/src/host.ts` (диспетчер хуков ~248-257; создание рядом с `feedService`)

**Interfaces:**
- Consumes: `PtyManager.on('start' | 'exit' | 'signal')`, `PtyManager.get(ref)` (`PtyHandle.startedAt`, `provider`), `HookRequest.ref`.
- Produces:
  ```ts
  export function createReadyJournal(deps: { log: Log; pty: Pick<PtyManager, 'on' | 'get'>; now?: () => number }): { onHook(ref: SessionRef): void; stop(): void };
  ```
  Первый хук (или первый сигнал `ready` Codex) после старта PTY → `log.info('сессия готова', { op: 'session.ready', ref, provider, readyMs })`; повторные хуки той же сессии молчат до следующего `start`/`exit`.

- [ ] **Step 1: Написать падающий тест** (fake pty с ручными `emit` как в `feed-service.test.ts`/`test/fake-pty.ts`)

```ts
it('первый хук после старта пишет session.ready с readyMs от startedAt', () => { /* startedAt = now-3500 → readyMs 3500 */ });
it('второй хук молчит, после exit и нового start пишет снова', ...);
it('сигнал ready у Codex считается готовностью', ...);
it('хук без живого PTY ничего не пишет', ...);
```

- [ ] **Step 2: Запустить, убедиться, что падает** — Run: `pnpm --filter @parley/host exec vitest run src/sessions/ready-journal.test.ts`; Expected: FAIL.

- [ ] **Step 3: Реализовать и подключить** — в host.ts: `const readyJournal = createReadyJournal({ log, pty: ptyManager })`, в `onHook` диспетчера первой строкой `readyJournal.onHook(request.ref)`, `onShutdown(async () => readyJournal.stop())`.

- [ ] **Step 4: Прогнать тесты** — Run: `pnpm --filter @parley/host test`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/sessions/ready-journal.ts packages/host/src/sessions/ready-journal.test.ts packages/host/src/host.ts
git commit -m "feat(host): журнал задержек — session.ready по первому хуку или сигналу ready"
```

---

### Task 6: Журнал задержек: `mail.deliver`

**Files:**
- Modify: `packages/host/src/wake/wake-service.ts` (`deliveryAction` ~551, `beginAttempt` ~427-480, ветка `sessions.launch(ref, 'resume', …)` ~386)
- Test: `packages/host/src/wake/wake-service.test.ts`

**Interfaces:**
- Consumes: `Message.at`, `Message.roomId` (core `types.ts:299`), `unreadFor`, `typeAndSubmit`, `host.log`.
- Produces: действие `type-pointer` несёт `newestAt: string | null` и `roomId: string | null` (самое новое письмо из `letterIds`); запись `host.log.info('письмо доставлено', { op: 'mail.deliver', ref, roomId, letters: letterIds.length, sinceSentMs, mode: 'pointer' | 'resume', ms, outcome })` — для `pointer` при завершении `typing.done` (`outcome` = `AttemptOutcome`), для `resume` вокруг `await sessions.launch(...)` (`outcome: 'launched' | 'failed'`). `sinceSentMs = max(0, now - Date.parse(newestAt))`, `null` без `newestAt`.

- [ ] **Step 1: Написать падающие тесты** (в `wake-service.test.ts` есть фабрика с fake pty, works и host; дополнить)

```ts
it('указатель пишет mail.deliver с sinceSentMs от самого нового письма и outcome submitted', ...);
it('подъём спящей сессии пишет mail.deliver mode resume', ...);
```

- [ ] **Step 2: Запустить, убедиться, что падает** — Run: `pnpm --filter @parley/host exec vitest run src/wake/wake-service.test.ts -t "mail.deliver"`; Expected: FAIL.

- [ ] **Step 3: Реализовать** — `newestAt` считается в `deliveryAction` из писем, которые там уже есть; `beginAttempt` запоминает `performance.now()` до `typeAndSubmit`.

- [ ] **Step 4: Прогнать тесты** — Run: `pnpm --filter @parley/host test`; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/wake
git commit -m "feat(host): журнал задержек — mail.deliver для указателя и подъёма"
```

---

### Task 7: Журнал задержек: `feed.firstDelta`

**Files:**
- Modify: `packages/host/src/feed/feed-service.ts` (`FeedService` ~154, `flush` ~453)
- Modify: `packages/host/src/methods/pty.ts` (`PtyMethodDeps.feed?: Pick<FeedService, 'markSent'>`, `ptySend`), `packages/host/src/methods/index.ts` (`createPtyHandlers(deps)` уже получает `deps.feed`)
- Test: `packages/host/src/feed/feed-service.test.ts`, `packages/host/src/methods/pty.test.ts`

**Interfaces:**
- Produces: `FeedService.markSent(ref: SessionRef): void` — запоминает `now()` по ключу сессии; первый `flush` с непустым батчем после метки пишет `log.info('лента: первая дельта после отправки', { op: 'feed.firstDelta', ref, sinceSendMs })` и снимает метку (пишется до проверки подписчиков, чтобы считаться и без открытого Chat). `ptySend` после ответа с `submitted === true` зовёт `deps.feed?.markSent(params.ref)`.

- [ ] **Step 1: Написать падающие тесты**

```ts
// feed-service.test.ts
it('после markSent первый flush пишет feed.firstDelta и больше не повторяет', ...);
// methods/pty.test.ts
it('pty.send с submitted зовёт feed.markSent, отказ — нет', ...);
```

- [ ] **Step 2: Запустить, убедиться, что падает** — Run: `pnpm --filter @parley/host exec vitest run src/feed/feed-service.test.ts src/methods/pty.test.ts`; Expected: FAIL.

- [ ] **Step 3: Реализовать.** — [ ] **Step 4: `pnpm --filter @parley/host test` → PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/feed/feed-service.ts packages/host/src/feed/feed-service.test.ts packages/host/src/methods
git commit -m "feat(host): журнал задержек — feed.firstDelta после отправки из Chat"
```

---

### Task 8: Кольцо RPC-вызовов в окне

**Files:**
- Create: `packages/desktop/src/main/diagnostics/rpc-ring.ts`
- Test: `packages/desktop/src/main/diagnostics/rpc-ring.test.ts`
- Modify: `packages/desktop/src/main/host-connection.ts` (`call` ~437)
- Test: `packages/desktop/src/main/host-connection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const RPC_RING_CAPACITY = 1000;
  export interface RpcRecord { t: string; method: string; ms: number; ok: boolean; error?: string; ref?: string }
  export function createRpcRing(capacity = RPC_RING_CAPACITY): { push(record: RpcRecord): void; entries(): RpcRecord[] };
  // HostConnection
  recentCalls(): RpcRecord[];
  ```
  `call` меряет `performance.now()` от записи в сокет до resolve/reject; `error` — `HostError.code` или `message.slice(0, 120)`; `ref` — `params.ref.sessionId`, если есть. Запись при reject тоже.

- [ ] **Step 1: Падающие тесты** — `rpc-ring.test.ts`: хранит последние N, старые вытесняются, `entries()` по порядку; `host-connection.test.ts`: после `await connection.call('host.shutdown', {})` `recentCalls()` содержит `{ method: 'host.shutdown', ok: true }` с числовым `ms`; вызов без ответа при закрытии соединения записан с `ok: false`.
- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/main/diagnostics/rpc-ring.test.ts src/main/host-connection.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** — [ ] **Step 4: тот же прогон → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): кольцо последних RPC-вызовов к хосту"`

---

### Task 9: Zip-писатель на zlib

**Files:**
- Create: `packages/desktop/src/main/diagnostics/zip.ts`
- Test: `packages/desktop/src/main/diagnostics/zip.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ZipEntry { name: string; source: Buffer | string | { file: string } }
  export async function writeZip(target: string, entries: readonly ZipEntry[]): Promise<{ skipped: string[] }>;
  ```
  Формат: локальный заголовок с флагом бита 3 и дескриптором данных после данных, метод 8 (deflate), `zlib.createDeflateRaw()` потоком, `crc32` накопительно через `zlib.crc32(chunk, prev)`, чтение файлов `createReadStream(file, { highWaterMark: 1024 * 1024 })`, центральный каталог и EOCD в конце; запись в `${target}.tmp` и `rename`. Отсутствующий `{ file }` → имя в `skipped`, остальное пишется. Zip64 не нужен (архив < 4 ГиБ).

- [ ] **Step 1: Падающие тесты** (`it.skipIf(!existsSync('/usr/bin/unzip'))` для проверок через `spawnSync('unzip')`)

```ts
it('архив из строки, Buffer и файла 3 МиБ проходит unzip -t', ...);      // stdout содержит 'No errors detected'
it('unzip -p возвращает исходный текст README.txt', ...);
it('отсутствующий файл попадает в skipped, архив цел', ...);
it('пустой список даёт корректный пустой архив', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/main/diagnostics/zip.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** Структуры заголовков — по спецификации PKWARE APPNOTE 4.4.x; время DOS из `now`.
- [ ] **Step 4: тот же прогон → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): zip-писатель для архива диагностики без зависимостей"`

---

### Task 10: Дерево процессов и сводка системы

**Files:**
- Create: `packages/desktop/src/main/diagnostics/processes.ts`
- Test: `packages/desktop/src/main/diagnostics/processes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PS_ARGS = ['-axo', 'pid,ppid,%cpu,%mem,rss,etime,comm'];
  export async function processTree(rootPids: readonly number[], deps?: { spawn?: typeof spawn; timeoutMs?: number }): Promise<string>;
  export function systemSummary(deps?: { os?: Pick<typeof os, 'loadavg' | 'cpus' | 'totalmem' | 'freemem' | 'uptime'> }): string;
  ```
  `processTree` возвращает заголовок `ps` и строки, чьи pid входят в замыкание `rootPids` по `ppid`; `comm` — остаток строки (в нём могут быть пробелы); при таймауте — `ps: timed out after 5000 ms`, при ошибке запуска — `ps: <message>`. `systemSummary` — `load average`, `cpus`, `mem total/free` в МиБ, `uptime` в секундах, по строке на значение.

- [ ] **Step 1: Падающие тесты** — fake `spawn` с готовым выводом (хост 100, дети 101 и 102 → ppid 101, чужой 200): остаются 100, 101, 102; таймаут через fake, не завершающий процесс; настоящий `ps` с `[process.pid]` содержит строку с `process.pid`.
- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/main/diagnostics/processes.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** — [ ] **Step 4: → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): дерево процессов хоста и сводка системы для диагностики"`

---

### Task 11: Сборка архива: `bundle.ts`, ipc, preload, bridge, README

**Files:**
- Create: `packages/desktop/src/main/diagnostics/bundle.ts`
- Test: `packages/desktop/src/main/diagnostics/bundle.test.ts`
- Modify: `packages/desktop/src/main/ipc.ts` (`RegisterIpcOptions` ~155: `saveDiagnostics`; обработчик рядом с `app:save-recipe` ~620)
- Modify: `packages/desktop/src/main/index.ts` (сборка deps рядом с `saveDropImage`; `outDir`)
- Modify: `packages/desktop/src/preload/index.ts` (~245), `packages/desktop/src/shared/bridge.ts` (`app` ~163)
- Modify: `packages/desktop/src/shared/strings.ts` (новый раздел `S.diagnostics` с `readme`)
- Modify: `packages/desktop/src/renderer/test-utils/fake-bridge.ts`
- Test: `packages/desktop/src/main/ipc.test.ts`

**Interfaces:**
- Consumes: `writeZip` (задача 9), `processTree`/`systemSummary` (задача 10), `RpcRecord` (задача 8), `HostDiagnostics`/`ProfileStatus` (задача 3), `showItemInFolder` (deps ipc).
- Produces:
  ```ts
  // shared/bridge.ts
  export interface DiagnosticsSaveResult { file: string; hostResponded: boolean }
  // app: saveDiagnostics(options: { profile: boolean }): Promise<DiagnosticsSaveResult>;
  // preload: saveDiagnostics: (options) => ipcRenderer.invoke('app:save-diagnostics', options)
  // main/diagnostics/bundle.ts
  export const DIAGNOSTICS_CALL_TIMEOUT_MS = 5000; export const PROFILES_MAX_AGE_MS = 24 * 3600 * 1000;
  export interface SaveDiagnosticsDeps {
    call: (method: MethodName, params: unknown) => Promise<unknown>; recentCalls: () => RpcRecord[];
    hostDir: string; outDir: string; appInfo: () => Record<string, unknown>; readme: string;
    now?: () => Date; callTimeoutMs?: number; profileSeconds?: number; profilePollMs?: number;
    processTree?: typeof processTree; systemSummary?: typeof systemSummary; writeZip?: typeof writeZip;
  }
  export async function saveDiagnostics(deps: SaveDiagnosticsDeps, options: { profile: boolean }): Promise<DiagnosticsSaveResult>;
  // ipc: RegisterIpcOptions.saveDiagnostics: (options: { profile: boolean }) => Promise<DiagnosticsSaveResult>
  ```
  Порядок в `saveDiagnostics`: (1) при `profile` — `host.profile.start { seconds: 20 }`, затем `host.profile.status` каждые 500 мс до `done`/`failed`, не дольше `seconds * 1000 + 10_000`; (2) `host.diagnostics` с `Promise.race` на `callTimeoutMs` → `host-info.json` = `{ responded: true, ...result }` или `{ responded: false, timeoutMs, error }`; (3) pid хоста из файла `<hostDir>/host.pid` → `processes.txt` = `processTree([pid])` + пустая строка + `systemSummary()` (без pid — строка `host.pid: missing`); (4) записи: `README.txt`, `host.log`, `host.log.1`, `host.err`, `host-info.json`, `app-info.json`, `processes.txt`, `actions.jsonl` (по JSON в строке), `<hostDir>/diagnostics/*.cpuprofile` с mtime не старше `PROFILES_MAX_AGE_MS`; (5) `mkdir -p outDir`, имя `parley-diagnostics-YYYYMMDD-HHMMSS.zip` по `now()`; (6) `{ file, hostResponded }`. Обработчик ipc: `withIpcError(async (_e, options) => { const result = await saveDiagnostics(options); showItemInFolder(result.file); return result; })` с проверкой `typeof options?.profile === 'boolean'` (иначе `HostError('bad_request', …)`). В index.ts: `outDir = process.env.PARLEY_DIAGNOSTICS_DIR ?? app.getPath('downloads')`, `hostDir = paths.dir`, `appInfo = () => ({ appVersion, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, release: os.release(), arch: process.arch, windows: BrowserWindow.getAllWindows().length, uptimeSec: Math.round(process.uptime()), host: <последний HostStatus: state и hostVersion> })`, `readme = S.diagnostics.readme`.
  README (`S.diagnostics.readme`, точный текст):
  ```
  Parley diagnostics bundle

  Contents: host.log and host.log.1 (host journal), host.err (host stderr), host-info.json (host versions, health sample, live sessions), app-info.json (app and OS versions), processes.txt (host process tree: pid, cpu, memory, executable name only), actions.jsonl (recent window-to-host calls with timings), host-*.cpuprofile (CPU profiles, open in Chrome DevTools > Performance > Load profile).

  Privacy: project paths and session or room names are included. Message text, terminal output, provider keys and environment variables are not.

  Send: attach this file to a GitHub issue at https://github.com/Kalmbik61/Parley/issues or to your message to the author.
  ```

- [ ] **Step 1: Падающие тесты**

```ts
// bundle.test.ts — temp hostDir с host.log и host.pid (= process.pid), temp outDir; fake call по методу
it('собирает архив со всеми файлами и responded:true', async () => { /* unzip -l содержит README.txt, host.log, host-info.json, app-info.json, processes.txt, actions.jsonl; unzip -p host-info.json → responded true, health.cpuPct */ });
it('хост не ответил за таймаут — responded:false и hostResponded false, архив есть', ...);     // call висит; callTimeoutMs 50
it('метод не поддержан (call отвергает) — responded:false с error', ...);
it('свежий дом без host.log.1 и host.err — архив без них', ...);
it('profile: ждёт done по статусам и включает свежий .cpuprofile, старый (25 ч) — нет', ...);
// ipc.test.ts
it('app:save-diagnostics зовёт saveDiagnostics и показывает файл в Finder', ...);
it('app:save-diagnostics без boolean profile — bad_request', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/main/diagnostics/bundle.test.ts src/main/ipc.test.ts` → FAIL.
- [ ] **Step 3: Реализовать** `bundle.ts`, ipc, index.ts, preload, bridge, strings, fake-bridge (`saveDiagnosticsCalls: Array<{ profile: boolean }>`, `setSaveDiagnosticsAnswer(result | Error)`).
- [ ] **Step 4: Run** `pnpm --filter @parley/desktop test` → PASS, включая `english-ui.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): сборка архива диагностики и app:save-diagnostics"`

---

### Task 12: Сегмент Diagnostics в строке статуса и действие палитры

**Files:**
- Create: `packages/desktop/src/renderer/shell/diagnostics-flow.ts`, `packages/desktop/src/renderer/shell/DiagnosticsSegment.tsx`
- Test: `packages/desktop/src/renderer/shell/diagnostics-flow.test.ts`, `packages/desktop/src/renderer/shell/DiagnosticsSegment.test.tsx`, `packages/desktop/src/renderer/shell/StatusBar.test.tsx`, `packages/desktop/src/renderer/palette/actions.test.ts`
- Modify: `packages/desktop/src/renderer/shell/StatusBar.tsx` (правая группа ~251-280: перед кнопкой wake), `packages/desktop/src/shared/strings.ts` (`S.diagnostics`, `S.actions.diagnostics`, `S.errors.actions.saveDiagnostics`), `packages/desktop/src/shared/keybindings.ts` (`ActionId` ~11-28, запись после `host.restart` ~103), `packages/desktop/src/renderer/palette/actions.ts` (`runAction` ~290)

**Interfaces:**
- Consumes: `bridge.app.saveDiagnostics`, `bridge.app.showInFinder`, `useHostSupports('host.diagnostics')`, `SEGMENT_BUTTON` (экспортировать из StatusBar.tsx или вынести в `shell/segment.ts`), `Popover*`, `toast`.
- Produces:
  ```ts
  // diagnostics-flow.ts
  export const PROFILE_SECONDS = 20;
  export async function runSaveDiagnostics(bridge: ParleyBridge, options: { profile: boolean }): Promise<DiagnosticsSaveResult | null>;
  // DiagnosticsSegment.tsx
  export function DiagnosticsSegment(): JSX.Element;   // кнопка data-diagnostics-segment, поповер side="top" align="end"
  // strings
  S.diagnostics = { segment: 'Diagnostics', save: 'Save diagnostics', profile: 'Record 20-second profile, then save', saving: 'Saving…', profiling: (left: number) => `Profiling ${left} s…`,
    hint: 'Includes host logs, process list and timings. No message text, terminal output or keys. The file is saved to Downloads; attach it to a GitHub issue.',
    hostOutdated: 'Host is outdated — restart it for full diagnostics', saved: 'Diagnostics saved', showInFinder: 'Show in Finder', readme: … };
  S.actions.diagnostics = 'Save diagnostics…'; S.errors.actions.saveDiagnostics = 'save diagnostics';
  // keybindings: ActionId + 'host.diagnostics'; paletteOnly('host.diagnostics', S.actions.diagnostics, ['diagnostics', 'logs', 'report', 'profile'])
  ```
  Поведение: успех → `toast(S.diagnostics.saved, { action: { label: S.diagnostics.showInFinder, onClick: () => void bridge.app.showInFinder(file) } })`; ошибка → `toast(errorText(decodeIpcError(error).code, S.errors.actions.saveDiagnostics))`, возврат `null`. Сегмент: состояние `'idle' | 'saving' | 'profiling'`; при `profiling` обратный отсчёт от `PROFILE_SECONDS` раз в секунду в тексте кнопки-триггера, при `saving` — `S.diagnostics.saving`; обе кнопки поповера `disabled`, пока не `idle`; при `!supported` кнопка профиля `disabled` и под подсказкой строка `S.diagnostics.hostOutdated`. Иконка `Activity` из lucide-react размером 14; подпись `S.diagnostics.segment` в `<span className="hidden min-[960px]:inline">`. Палитра: `case 'host.diagnostics': void runSaveDiagnostics(ctx.bridge, { profile: false }); return;`.

- [ ] **Step 1: Падающие тесты** (по образцу `StatusBar.test.tsx`: `createFakeBridge`, `window.parley = bridge`, `vi.mock('sonner')`)

```ts
// diagnostics-flow.test.ts
it('успех — toast saved с действием Show in Finder, которое зовёт showInFinder(file)', ...);
it('ошибка — toast errorText и null', ...);
// DiagnosticsSegment.test.tsx
it('Save diagnostics зовёт saveDiagnostics({profile:false})', ...);
it('Record profile показывает Profiling 20 s… и через 1 с Profiling 19 s…, кнопки заблокированы', ...);  // fake timers, ответ bridge отложен
it('старый хост: кнопка профиля disabled, подсказка hostOutdated видна, Save работает', ...);     // bridge.setHostMethods без host.diagnostics
// StatusBar.test.tsx
it('в правой группе есть сегмент диагностики перед переключателем wake', ...);
// actions.test.ts
it('host.diagnostics запускает сохранение без профиля', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/renderer/shell src/renderer/palette/actions.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** — [ ] **Step 4: Run** `pnpm --filter @parley/desktop test` → PASS (включая `english-ui.test.ts` и тесты keybindings, если есть).
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): сегмент Diagnostics в строке статуса и действие палитры"`

---

### Task 13: Метка `requestedAt` в outbox Chat и комнаты

**Files:**
- Modify: `packages/desktop/src/renderer/chat/chat-outbox.ts` (`ChatOutboxPayload` ~24, `attemptChatSend` ~57), `packages/desktop/src/renderer/chat/ChatView.tsx` (`chatOutbox.enqueue` :275 и :389), `packages/desktop/src/renderer/terminal/send.ts` (`sendToAgent` ~21), `packages/desktop/src/renderer/components/rooms/room-outbox.ts` (`RoomOutboxPayload`, `attemptRoomSend`), `packages/desktop/src/renderer/components/rooms/RoomPanel.tsx` (`roomOutbox.enqueue` :375)
- Test: `packages/desktop/src/renderer/chat/chat-outbox.test.ts`, `packages/desktop/src/renderer/components/rooms/room-outbox.test.ts` (создать, если нет), тест `terminal/send` (если есть — дополнить)

**Interfaces:**
- Produces: `ChatOutboxPayload.requestedAt: number` и `RoomOutboxPayload.requestedAt: number`, ставятся в `enqueue` как `Date.now()`; `sendToAgent(bridge, ref, text, submit, requestedAt?: number)` передаёт `requestedAt` в `pty.send`, когда задан; `attemptRoomSend` передаёт `requestedAt` в `rooms.send`.

- [ ] **Step 1: Падающие тесты** — `attemptChatSend` зовёт `pty.send` с `requestedAt` из payload; `attemptRoomSend` — `rooms.send` с `requestedAt`; `sendToAgent` без пятого аргумента не добавляет поле.
- [ ] **Step 2: Run** `pnpm --filter @parley/desktop exec vitest run src/renderer/chat/chat-outbox.test.ts src/renderer/components/rooms` → FAIL.
- [ ] **Step 3: Реализовать.** — [ ] **Step 4: Run** `pnpm --filter @parley/desktop test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): requestedAt в отправке из Chat и комнаты"`

---

### Task 14: E2E, раскладка 800×500, CHANGELOG

**Files:**
- Create: `packages/desktop/e2e/diagnostics.spec.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: образцы `e2e/restart-host.spec.ts` (запуск, `call`, `stopApp`/`stopHost`), `e2e/providers-refresh-visual.spec.ts` (окно 800×500), `globalThis.__parleyShell` при `PARLEY_SHELL=log`, `PARLEY_DIAGNOSTICS_DIR`.

- [ ] **Step 1: Написать спеку**

```ts
test('Save diagnostics кладёт zip в PARLEY_DIAGNOSTICS_DIR и показывает его в Finder', async () => {
  // env: PARLEY_HOME, PARLEY_CLAUDE_BIN=stub, PARLEY_DIAGNOSTICS_DIR=<temp>
  await window.locator('[data-diagnostics-segment]').click();
  await window.getByRole('button', { name: 'Save diagnostics', exact: true }).click();
  await expect(window.getByText('Diagnostics saved')).toBeVisible({ timeout: 15_000 });
  const shell = await app.evaluate(() => (globalThis as { __parleyShell?: unknown[] }).__parleyShell ?? []);
  // последний элемент: { action: 'showItemInFolder', path } с path под temp и именем /^parley-diagnostics-\d{8}-\d{6}\.zip$/
  // spawnSync('unzip', ['-l', path]) содержит README.txt, host.log, host-info.json, app-info.json, processes.txt, actions.jsonl
  // unzip -p host-info.json → responded === true, typeof health.cpuPct === 'number', sessions — массив
});
test('в окне 800×500 строка статуса не переполняется, сегмент показывает только иконку', async () => {
  // как в providers-refresh-visual.spec.ts; у `[data-diagnostics-segment] span` display none; scrollWidth строки статуса <= clientWidth
});
```

- [ ] **Step 2: Собрать и прогнать** — Run: `uptime && pnpm --filter @parley/desktop build && pnpm --filter @parley/desktop exec playwright test e2e/diagnostics.spec.ts`; Expected: 2 passed. Затем тот же прогон с `--force-device-scale-factor=2` по образцу существующих визуальных спек (аргументы Electron в `electron.launch`).

- [ ] **Step 3: CHANGELOG** — над `## 0.13.1` добавить раздел `## Unreleased` (если его нет) с абзацем и `### Added`: «Diagnostics in the status bar: one click saves a zip with host logs, a process list, request timings and an optional 20-second CPU profile of the host — attach it to an issue when Parley feels slow. The host journal now records where delays happen: session readiness, Chat sends, room mail delivery and the first reply.» (по-английски).

- [ ] **Step 4: Полный прогон** — Run: `pnpm -r test && pnpm typecheck && pnpm lint`; Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "test(desktop): E2E сохранения диагностики и раскладка 800×500; CHANGELOG"`

---

### Task 15: Baseline-архив (выполняет автор, не агент)

Не кодовая задача: это точка, после которой можно сливать задачи 16–17 и выбирать B2.

- [ ] **Step 1:** Собрать dev-окно из ветки (`pnpm --filter @parley/desktop build`) и запустить его против своего `~/.parley` с обычными ~15 сессиями по рецепту dev-окна из памяти `terminal-less-hybrid-idea`; хост должен быть новой сборки (перезапустить через «Restart host…»).
- [ ] **Step 2:** Поработать 10 минут как обычно (комнаты, Chat, письма), затем Diagnostics → **Record 20-second profile, then save**.
- [ ] **Step 3:** Выписать из `host.log` строки `host: состояние` (cpuPct, loop.p99Ms при ~15 сессиях) и из журнала `op:"pty.send"` (queueMs, enterMs) в новый раздел спеки `## Baseline 2026-…` рядом с B3; архив отдать сессии «Чат не подтягивает ответы из терминала» и открыть `.cpuprofile` в DevTools.
- [ ] **Step 4:** По профилю выбрать пункты B2 и B1.3–B1.4 — отдельная спека.

---

### Task 16: B1.1 — scrollback экрана хоста 1000 (ветка `feat/host-scrollback-1000` от origin/master, после задачи 15)

**Files:**
- Modify: `packages/host/src/pty/screen.ts` (:33 `DEFAULT_SCROLLBACK`)
- Test: `packages/host/src/pty/screen.test.ts`

- [ ] **Step 1: Падающий тест**

```ts
it('по умолчанию снимок держит последние 1000 строк истории плюс экран', () => {
  const screen = createScreen(80, 24);
  for (let i = 0; i < 1500; i += 1) screen.write(`line ${i}\r\n`);
  const snapshot = screen.snapshot();
  expect(snapshot).toContain('line 1499');
  expect(snapshot).toContain('line 500');
  expect(snapshot).not.toContain('line 400');
});
```

- [ ] **Step 2: Run** `pnpm --filter @parley/host exec vitest run src/pty/screen.test.ts` → FAIL (при 5000 строка 400 ещё в снимке).
- [ ] **Step 3:** `const DEFAULT_SCROLLBACK = 1000;` — поправить существующие тесты экрана, если они опирались на 5000.
- [ ] **Step 4: Run** `pnpm --filter @parley/host test` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "perf(host): scrollback экрана хоста 5000 → 1000"`. PR открывает пользователь; замер «после» — архивом по шагам задачи 15.

---

### Task 17: B1.2 — потолок батчера вывода PTY (ветка `feat/pty-batch-cap` от origin/master, после задачи 15)

**Files:**
- Modify: `packages/host/src/pty/output-batcher.ts`
- Test: `packages/host/src/pty/output-batcher.test.ts`

**Interfaces:**
- Produces: `export const OUTPUT_BATCH_MAX_CHARS = 256 * 1024;` `constructor(flush, intervalMs = 16, maxChars = OUTPUT_BATCH_MAX_CHARS)`. `push`: буфер пополняется; пока `buffer.length >= maxChars` — синхронный `flush(buffer.slice(0, maxChars))`, буфер = остаток; непустой остаток ждёт таймера как раньше.

- [ ] **Step 1: Падающие тесты**

```ts
it('после накопления 256 КиБ сбрасывает сразу, остаток — по таймеру', () => { /* 3 × 128 КиБ: после второго push flush один раз с 256 КиБ, через 16 мс — 128 КиБ */ });
it('один push на 1 МиБ даёт четыре сброса по 256 КиБ без таймера', ...);
it('кусок меньше потолка ведёт себя как раньше — один сброс через 16 мс', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @parley/host exec vitest run src/pty/output-batcher.test.ts` → FAIL.
- [ ] **Step 3: Реализовать.** — [ ] **Step 4: Run** `pnpm --filter @parley/host test` → PASS (`pty-manager.test.ts` без изменений).
- [ ] **Step 5: Commit** — `git commit -m "perf(host): потолок 256 КиБ на кусок вывода PTY"`.
