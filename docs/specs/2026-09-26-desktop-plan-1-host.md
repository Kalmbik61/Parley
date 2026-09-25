# План, этап 1: хост и окно — паритет с TUI

Дата: 2026-09-26. Индекс и общие правила — `2026-09-26-desktop-plan.md`. Спека —
`2026-09-26-desktop-design.md`, разделы 3–5, 7.2–7.3 (только живые сессии), 9–11.

**Итог этапа:** в окне можно проработать день вместо TUI. Закрыл окно — агенты
живы, открыл — экраны на месте. Сессия, порождённая агентом, стартует сама, без
нажатия Enter.

**Что сознательно не входит:** две оси состояния, комнаты и подъём по письму
(этап 3), сетка панелей (этап 2), worktree (этап 4). В этапе 1 у сессии прежние
статусы `pending`/`active`/`exited`/`done`/`failed`, а «Остановить» переводит её в
`exited`.

---

## 1.1. core: запуск сессий переезжает из TUI в core

**Зачем.** Хост и TUI поднимают сессии одним кодом: 477 строк логики запуска не
дублируем.
**Зависит от:** —. **Спека:** 3.1, 3.3.

**Файлы**
- Перенести через `git mv`:
  - `packages/tui/src/work-launch.ts` → `packages/core/src/work/launch.ts`;
  - `packages/tui/src/work-launch.test.ts` → `packages/core/src/work/launch.test.ts`;
  - `packages/tui/src/pty/find-binary.ts` → `packages/core/src/work/find-binary.ts`.
  
  Фикстуры, на которые опирается тест, копируются из `packages/tui/test/` в
  `packages/core/test/`, пути в тесте правятся.
- Изменить:
  - `packages/core/src/work/launch.ts` — импорты из `@harnas/core` заменить
    относительными (`./store.js`, `../providers.js`, …);
  - `packages/core/src/providers.ts` — удалить приватную `overrideVariable`, брать её
    из `./work/find-binary.js`;
  - `packages/core/src/work/types.ts` — `LaunchedBy` получает `'host'`;
  - `packages/core/src/index.ts` — экспорты ниже;
  - импорты в TUI на `@harnas/core`: `use-panel.ts`, `use-map-sync.ts`,
    `use-overlays.ts`, `use-session-link.ts`, `pty/use-agent-pty.ts` и тесты
    `app.test.tsx`, `overlays.app.test.tsx`, `pty/pty-session.test.ts`,
    `pty/use-agent-pty.test.tsx`.

**Интерфейсы.** Отдаёт из `@harnas/core`; имена и сигнатуры не меняются:

```ts
export {
  planLaunch, planResume, planNew, readBrief, createNewSession, createChildSession,
  applyAutoTitle, registerResumed, createPendingSession, deleteSession, deleteWork,
  startSession, linkSession, finishExited, NEW_LABEL, UNTITLED_WORK,
} from './work/launch.js';
export type { LaunchOptions, LaunchPlan, NewSessionResult, StartedProcess } from './work/launch.js';
export { findBinary, findRunnerBinary, overrideVariable, BinaryNotFoundError } from './work/find-binary.js';
// work/types.ts
export type LaunchedBy = 'tui' | 'cli' | 'host';
```

**Тесты**
1. Перенесённые тесты проходят без правок логики — меняются только импорты и пути
   фикстур.
2. Новый: `startSession(…, { pid, startedAtProcess: null, launchedBy: 'host' })`
   пишет в карту `launchedBy: 'host'`.

**Приёмка**
- [ ] `grep -rn "work-launch\|find-binary" packages/tui/src` ничего не находит.
- [ ] `packages/core/src/work/launch.ts` не импортирует `@harnas/core`.
- [ ] В `providers.ts` одна `overrideVariable` — из `work/find-binary.ts`.
- [ ] Тест на `launchedBy: 'host'` зелёный.
- [ ] Диф тестов TUI — только импорты. Все тесты tui и core зелёные.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint` зелёные.

---

## 1.2. Пакет протокола `@harnas/protocol`

**Зачем.** Хост и окно говорят на одном языке: общие типы, схемы и разбор строк.
**Зависит от:** —. **Спека:** 4.3, 4.5.

**Файлы**
- Создать `packages/protocol/`:
  - `package.json` (`@harnas/protocol`, `"type": "module"`, `build: tsc -p
    tsconfig.json`, `test: vitest run --passWithNoTests`; зависимости
    `@harnas/core: workspace:*` и `zod` той же мажорной версии, что тянет
    `@modelcontextprotocol/sdk` в `pnpm-lock.yaml`);
  - `tsconfig.json` (как у core, `references: [{ "path": "../core" }]`);
  - `src/index.ts`, `src/version.ts`, `src/types.ts`, `src/methods.ts`,
    `src/events.ts`, `src/framing.ts`;
  - тесты `src/framing.test.ts`, `src/methods.test.ts`.
- Протокол берёт из core **только типы** (`import type`). Иначе в renderer уедет код
  с `node:fs`.

**Интерфейсы**

```ts
// version.ts
export const PROTOCOL_VERSION = 1;

// types.ts
import type { HarnasConfig, SessionActivity, WorkEntry } from '@harnas/core';
export interface SessionRef { projectPath: string; workId: string; sessionId: string }
export const refKey = (ref: SessionRef): string =>
  `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;
export interface LiveMetrics {
  tokensIn: number | null; tokensOut: number | null; durationMs: number | null;
  unread: number; subagents: number; model: string | null;
}
export type NoticeKind =
  | 'map-lock' | 'map-corrupt' | 'hooks-missing' | 'launch-failed'
  | 'pointer-timeout' | 'pointer-cancelled';
export interface HostNotice { kind: NoticeKind; ref: SessionRef | null; text: string; at: string }
export type ErrorCode =
  | 'unauthorized' | 'protocol_mismatch' | 'bad_request' | 'unknown_method'
  | 'not_found' | 'conflict' | 'internal';
/** data — машинные подробности: у protocol_mismatch это { hostVersion, liveSessions }. */
export interface ProtocolError { code: ErrorCode; message: string; data?: Record<string, unknown> }
export interface WorksSnapshot { entries: WorkEntry[]; branches: Record<string, string | null> }

// methods.ts: схемы параметров на zod, результаты — типами
export const sessionRef = z.object({ projectPath: z.string(), workId: z.string(), sessionId: z.string() });
export const METHODS = {
  hello: z.object({ token: z.string(), protocol: z.number().int(), client: z.string() }),
  'host.info': z.object({}),
  'host.shutdown': z.object({}),
  'providers.list': z.object({}),
  'works.list': z.object({}),
  'works.create': z.object({ projectPath: z.string(), title: z.string(), goal: z.string() }),
  'works.delete': z.object({ projectPath: z.string(), workId: z.string() }),
  'sessions.create': z.object({
    projectPath: z.string(), workId: z.string().nullable(), provider: z.string(),
    label: z.string(), task: z.string(), parent: z.string().nullable(),
  }),
  'sessions.resume': z.object({ ref: sessionRef }),
  'sessions.stop': z.object({ ref: sessionRef }),
  'sessions.delete': z.object({ ref: sessionRef }),
  'pty.attach': z.object({ ref: sessionRef }),
  'pty.detach': z.object({ ref: sessionRef }),
  'wake.pause': z.object({}),
  'wake.resume': z.object({}),
  'wake.state': z.object({}),
  'settings.get': z.object({}),
  'settings.set': z.object({ key: z.string(), value: z.string() }),
} as const;
// Уведомления клиента — без id и без ответа: их слишком много, чтобы ждать каждое.
export const NOTIFICATIONS = {
  'pty.input': z.object({ ref: sessionRef, data: z.string() }),
  'pty.resize': z.object({ ref: sessionRef, cols: z.number().int().min(2), rows: z.number().int().min(2) }),
} as const;
export interface Results {
  hello: { hostVersion: string; protocol: number; pid: number };
  'host.info': { hostVersion: string; pid: number; startedAt: string; clients: number; liveSessions: number };
  'host.shutdown': { ok: true };
  'providers.list': { providers: Array<{ id: string; label: string; available: boolean }> };
  'works.list': WorksSnapshot;
  'works.create': { workId: string };
  'works.delete': { ok: true };
  'sessions.create': { ref: SessionRef };
  'sessions.resume': { ok: true };
  'sessions.stop': { ok: true };
  'sessions.delete': { ok: true };
  'pty.attach': { snapshot: string; cols: number; rows: number };
  'pty.detach': { ok: true };
  'wake.pause': { paused: boolean };
  'wake.resume': { paused: boolean };
  'wake.state': { paused: boolean };
  'settings.get': { config: HarnasConfig; locked: Record<string, string> };
  'settings.set': { config: HarnasConfig };
}
export type MethodName = keyof typeof METHODS;
export type NotificationName = keyof typeof NOTIFICATIONS;
export type Params<M extends MethodName | NotificationName> =
  z.infer<(typeof METHODS & typeof NOTIFICATIONS)[M]>;
export type Result<M extends MethodName> = Results[M];

// events.ts
export interface Events {
  'works.changed': WorksSnapshot;
  'activity.changed': { ref: SessionRef; activity: SessionActivity; metrics: LiveMetrics | null };
  'pty.output': { ref: SessionRef; data: string };
  'pty.resync': { ref: SessionRef };
  'pty.exit': { ref: SessionRef; exitCode: number; signal: number | null };
  'host.notice': HostNotice;
  'wake.changed': { paused: boolean };
}
export type EventName = keyof Events;
export type EventData<E extends EventName> = Events[E];

// framing.ts
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export type RequestMessage = { id: number; method: MethodName; params: unknown };
export type NotificationMessage = { method: NotificationName; params: unknown };
export type ResponseMessage = { id: number; result: unknown } | { id: number; error: ProtocolError };
export type EventMessage = { event: EventName; data: unknown };
export function encodeLine(message: RequestMessage | NotificationMessage | ResponseMessage | EventMessage): string;
export class LineTooLongError extends Error {}
/** Режет поток на строки; многобайтный знак на стыке кусков собирает StringDecoder. */
export class LineDecoder { push(chunk: Buffer): unknown[] }
export type Incoming =
  | { kind: 'request'; message: RequestMessage; params: unknown }
  | { kind: 'notification'; message: NotificationMessage; params: unknown }
  | { kind: 'invalid'; id: number | null; error: ProtocolError };
/** Разбор и проверка по схеме: params в результате уже прошли zod. */
export function parseIncoming(raw: unknown): Incoming;
```

**Тесты**
1. `encodeLine` даёт одну строку с `\n` в конце и без переводов строки внутри.
2. `LineDecoder`:
   - два сообщения в одном куске;
   - одно сообщение, разрезанное на три куска;
   - `ё` и `😀`, разрезанные посередине байтов, собираются целыми.
3. Строка длиннее `MAX_LINE_BYTES` бросает `LineTooLongError`.
4. `parseIncoming`:
   - верный запрос;
   - уведомление без id;
   - неизвестный метод → `unknown_method` с id;
   - неверные params → `bad_request` с текстом zod;
   - мусор без id → `invalid` с `id: null`.
5. Типы (`expectTypeOf`): у `Params<'sessions.create'>` поле `workId` имеет тип
   `string | null`, у `Result<'pty.attach'>` есть `snapshot: string`.

**Приёмка**
- [ ] `pnpm -r build` собирает protocol после core.
- [ ] `grep -rn "from '@harnas/core'" packages/protocol/src` находит только
      `import type`.
- [ ] Все тесты зелёные.

---

## 1.3. Хост: процесс, сокет, рукопожатие

**Зачем.** Долгоживущий процесс с одним входом, который переживает окно и никого
не пускает без токена.
**Зависит от:** 1.2. **Спека:** 3.2, 4.3, 9.2, 10. **Ревью:** пункты 1, 2, 6 индекса.

**Файлы**
- Создать `packages/host/`:
  - `package.json` (`@harnas/host`, `bin: { "harnas-host": "./dist/main.js" }`,
    `exports: { ".": "./dist/index.js", "./main": "./dist/main.js" }`; зависимости
    `@harnas/core`, `@harnas/protocol`);
  - `tsconfig.json` (`references` на core и protocol);
  - `src/index.ts`, `src/main.ts`, `src/host.ts`, `src/paths.ts`, `src/log.ts`,
    `src/server.ts`, `src/client.ts`, `src/idle.ts`, `src/context.ts`,
    `src/methods/index.ts`, `src/methods/host.ts`;
  - тесты `src/host.test.ts`, `src/server.test.ts`, `src/log.test.ts`,
    `test/helpers.ts` (короткий временный `HARNAS_HOME` через `mkdtemp('/tmp/hh-')`
    и тестовый клиент).

**Интерфейсы**

```ts
// paths.ts
export interface HostPaths { dir: string; socket: string; token: string; pid: string; log: string }
export function hostPaths(home: string = harnasHome()): HostPaths; // <home>/host/{host.sock,host.token,host.pid,host.log}
export const MAX_SOCKET_PATH_BYTES = 103;

// host.ts
export interface HostOptions { home?: string; idleMs?: number; helloTimeoutMs?: number; version?: string }
export interface RunningHost { paths: HostPaths; context: HostContext; closed: Promise<string> }
export class HostAlreadyRunning extends Error {}
export class SocketPathTooLong extends Error {}
export async function startHost(options?: HostOptions): Promise<RunningHost>;

// context.ts
export interface HostContext {
  version: string; startedAt: string; paths: HostPaths; log: Log;
  clients(): readonly Client[];
  broadcast<E extends EventName>(event: E, data: EventData<E>): void;
  onShutdown(hook: () => Promise<void>): void;
  shutdown(reason: string): Promise<void>;
  busy(key: string, isBusy: boolean): void; // для таймера простоя: живые PTY
}
export interface RequestInfo { client: Client; host: HostContext }
export type Handler<M extends MethodName> = (params: Params<M>, request: RequestInfo) => Promise<Result<M>>;
export type NotificationHandler<N extends NotificationName> = (params: Params<N>, request: RequestInfo) => void;

// client.ts
export interface Client {
  id: string; name: string;
  send(message: ResponseMessage | EventMessage): boolean; // false — буфер выше порога
  writableLength(): number;
  close(): void;
}

// log.ts: JSON-строки со временем; ротация в host.log.1 при превышении лимита
export interface Log { info(msg: string, data?: object): void; warn(msg: string, data?: object): void; error(msg: string, data?: object): void }
export function createLog(file: string, options?: { maxBytes?: number }): Log; // по умолчанию 5 МБ
```

**Порядок старта `startHost`:**
1. Если путь сокета длиннее 103 байт — `SocketPathTooLong`, на диске ничего не
   создаётся.
2. `mkdir` каталога с правами 0700; если каталог уже есть, `chmod 0700`.
3. Если сокет существует — попытка подключиться (500 мс):
   - подключились → `HostAlreadyRunning`;
   - `ECONNREFUSED` или `ENOENT` → старые `host.sock`, `host.pid`, `host.token`
     удаляются.
4. Токен `randomBytes(32).toString('hex')` пишется в `host.token` с правами 0600.
5. `listen` на сокете, затем `chmod 0600`.
6. Пишется `host.pid`.
7. Запускается таймер простоя (`idleMs`, по умолчанию 300 000; в `main.ts` берётся
   из `HARNAS_HOST_IDLE_MS`).
8. На `SIGTERM` и `SIGINT` — `shutdown('signal')`.

**Остановка.** Хуки `onShutdown` по порядку регистрации (сессии добавятся в 1.7),
затем закрытие сервера, удаление сокета, токена и pid, закрытие лога.

**Рукопожатие:**
- первое сообщение должно быть `hello`, иначе `unauthorized` и закрытие;
- нет `hello` за `helloTimeoutMs` (5 000) — закрытие;
- чужой токен → `unauthorized`, закрытие;
- `protocol ≠ PROTOCOL_VERSION` → `protocol_mismatch` с
  `data: { hostVersion, liveSessions }` (живые сессии — по счётчику `busy`),
  закрытие;
- успех → `{ hostVersion, protocol, pid }`, клиент зарегистрирован.

**Разбор запросов.** Неизвестный метод — `unknown_method`. Исключение в обработчике
— `internal` с текстом и строкой в логе. Методы куска: `host.info`, `host.shutdown`
(ответ, затем остановка через 50 мс).

`main.ts` возвращает код выхода: 0 — обычный выход, 3 — хост уже запущен, 4 —
слишком длинный путь сокета.

**Тесты** (временные дома в `/tmp/hh-*`)
1. Старт: каталог 0700, сокет 0600, токен 0600, в pid-файле `process.pid`.
2. Второй `startHost` с тем же домом — `HostAlreadyRunning`, первый продолжает
   отвечать.
3. Остатки упавшего хоста: файл сокета без слушателя → новый хост стартует и
   отвечает.
4. Дом, при котором путь сокета больше 103 байт → `SocketPathTooLong`, каталог не
   создан.
5. Чужой токен → `unauthorized`, соединение закрыто.
6. `protocol: 999` → `protocol_mismatch`, в `data` версия хоста и `liveSessions: 0`.
7. Запрос до `hello` → `unauthorized`.
8. Нет `hello` за 100 мс (`helloTimeoutMs: 100`) → соединение закрыто.
9. `host.info` считает клиентов.
10. `host.shutdown` удаляет сокет, токен и pid.
11. Простой при `idleMs: 200`:
    - без клиентов хост уходит, `closed` разрешается;
    - с подключённым клиентом живёт дольше 200 мс.
12. Лог ротируется при `maxBytes: 1024`.
13. Процесс: `tsx src/main.ts` с `HARNAS_HOME` поднимает хост; `SIGTERM` убирает
    файлы; повторный запуск при живом первом выходит с кодом 3.

**Приёмка**
- [ ] Все 13 тестов зелёные.
- [ ] Хост не открывает ни одного сетевого порта (в коде нет `listen` на числе).
- [ ] Токен не попадает в лог (в тесте лог проверяется поиском по токену).

---

## 1.4. Хост: работы, карта, живость, аренда

**Зачем.** Хост знает все работы всех проектов и сообщает окну об изменениях. TUI
видит, что работу держит хост, и не запускает её сессии второй раз.
**Зависит от:** 1.3. **Спека:** 3.3, 4.2, 10. **Ревью:** пункт 5 индекса.

**Файлы**
- Создать:
  - `packages/core/src/work/lease.ts` и тест;
  - `packages/host/src/works/works-service.ts` и тест;
  - `packages/host/src/methods/works.ts`, `methods/providers.ts`,
    `methods/settings.ts` и тест методов.
- Изменить:
  - `packages/core/src/work/store.ts` — если таймаут лока сейчас бросает обычную
    `Error`, завести и бросать `MapLockTimeoutError`;
  - `packages/core/src/index.ts` — экспорты;
  - `packages/tui/src/use-auto-launch.ts` и его тест — пропуск работ с живой арендой.

**Интерфейсы**

```ts
// core/work/lease.ts — файл <project>/.harnas/works/<id>/host.lease
export interface HostLease { pid: number; startedAtProcess: string | null; since: string }
export async function writeHostLease(projectPath: string, workId: string, lease: HostLease): Promise<void>;
export async function readHostLease(projectPath: string, workId: string): Promise<HostLease | null>;
/** Жива ли аренда: pid жив и время старта процесса совпадает (START_TOLERANCE_MS). */
export async function hostLeaseActive(projectPath: string, workId: string): Promise<boolean>;
/** Снимает аренду, только если она своя: чужой хост мог уже переписать файл. */
export async function removeHostLease(projectPath: string, workId: string, pid: number): Promise<void>;
export class MapLockTimeoutError extends Error {} // core/work/store.ts

// host/works/works-service.ts
export interface WorksService {
  start(): Promise<void>;
  snapshot(): WorksSnapshot;
  entry(projectPath: string, workId: string): WorkEntry | undefined;
  /** Первое чтение этой работы хостом уже было: autoLaunch берёт только новое (1.7). */
  firstReadDone(projectPath: string, workId: string): boolean;
  onChange(listener: (snapshot: WorksSnapshot, previous: WorksSnapshot) => void): () => void;
  stop(): Promise<void>;
}
export function createWorksService(host: HostContext, options?: { debounceMs?: number; lockTimeoutMs?: number }): WorksService;
```

**Поведение**
- **Источник работ** — глобальный индекс `readWorksIndex()`. Для каждого различного
  `projectPath` работает `watchWorks(cb, projectPath)` из core. Изменение
  `works-index.json` (наблюдатель на каталоге `harnasHome()`) добавляет новые
  проекты.
- **Слияние и рассылка.** Записи сливаются по ключу `projectPath + workId`. Раз в
  `debounceMs` (100) уходит `works.changed` со снимком. `branches` считается через
  `gitBranch(projectPath)` из core, по одному разу на проект за изменение.
- **Живость.** После первого чтения и на каждом изменении — `reconcileMap` для
  работ, где есть `active`-сессии с pid.
- **Аренда:**
  - после первого чтения хост пишет `host.lease` во все работы, а новым работам —
    при появлении;
  - на остановке снимает все свои аренды.
- **Ошибка лока.** `MapLockTimeoutError` от любой записи даёт
  `host.notice { kind: 'map-lock' }` и строку в логе. Хост не падает; повтор идёт
  на следующем изменении.
- **Битая карта.** `readWorks` из core молча пропускает карту, которую не удалось
  разобрать. Хост так не делает: для каталога работы, у которого `map.json` есть,
  но не разбирается, он шлёт один раз `host.notice { kind: 'map-corrupt' }` с путём
  файла. Такую работу хост не трогает и ничего в неё не пишет.

**Методы**
- **`works.list`** → снимок.
- **`works.create`** → `createWork(projectPath, { title, goal })` из core →
  `{ workId }`.
- **`works.delete`**:
  - если в работе есть `active`-сессия с живым pid → `conflict`;
  - иначе `deleteWorkFiles`.
- **`providers.list`** → `loadProviders()` и `commandInPath(commandBinary(command))`
  для флага `available`.
- **`settings.get`** → `loadConfig()`. В `locked` попадают ключи, заданные
  переменными окружения из `ENV_NAMES`, со значением — именем переменной.
- **`settings.set`**:
  - `parseSetting` в core сейчас понимает только `prefix`, `sidebarWidth`,
    `silenceThresholdMs` и `messageRate`. Кусок расширяет его до
    `parseSetting(key: keyof HarnasConfig, text: string)`: булевы (`autoLaunch`,
    `channelPush`, `mouseCapture`, `ascii`) — те же множества «да/нет», что у
    загрузчика; `theme` — только из `THEME_NAMES`. Новые ключи следующих кусков
    (`fontFamily`, `fontSize`, `resumeRate`, `worktreeRoot`) добавляют свои ветки
    там же;
  - `parseSetting(key, value)` → `saveConfig({ [key]: parsed })` → новый конфиг;
  - ошибка разбора → `bad_request` с её текстом.

**TUI.** `useAutoLaunch` перед запуском pending-сессии работы вызывает
`hostLeaseActive(projectPath, workId)` и при `true` пропускает её.

**Тесты**
1. **core, аренда:**
   - запись и чтение;
   - `hostLeaseActive`: свой pid → `true`, pid 999999 → `false`, не совпало время
     старта → `false`;
   - `removeHostLease` с чужим pid файл не трогает.
2. **Сервис, источники:**
   - две работы в двух проектах из индекса попадают в один снимок;
   - новая работа появляется не позже `debounceMs + 50` мс;
   - новый проект в индексе подхватывается.
3. **Сервис, живость:** карта с `active`-сессией pid 999999 (`launchedBy: 'tui'`)
   после старта становится `exited`.
4. **Сервис, аренда:** файлы есть у всех работ после старта и исчезают после `stop`.
5. **Сервис, лок:** заранее созданный `map.lock` и `lockTimeoutMs: 50` → рассылается
   `host.notice` с `kind: 'map-lock'`, сервис продолжает работать; после снятия лока
   следующее изменение проходит.
5а. **Сервис, битая карта:** `map.json` с мусором → один `host.notice` с
   `kind: 'map-corrupt'` и путём; файл после этого не изменён ни на байт.
6. **Методы:**
   - `works.create` заводит каталог и запись индекса;
   - `works.delete` при живой сессии → `conflict`;
   - `providers.list` с `HARNAS_CLAUDE_BIN` на stub → у claude `available: true`;
   - `settings.get` при `HARNAS_MESSAGE_RATE=5` → `locked.messageRate ===
     'HARNAS_MESSAGE_RATE'`;
   - `settings.set('messageRate', 'абв')` → `bad_request`.
7. **TUI:** аренда с живым pid → autoLaunch не зовёт `launch`; с мёртвым pid — зовёт.

**Приёмка**
- [ ] Все тесты зелёные, включая тест TUI.
- [ ] Хост не пишет ничего вне `.harnas/works/<id>/` и `~/.harnas/host/`
      (проверка в тесте 4 по списку файлов временного проекта).

---

## 1.5. Хост: активность, метрики, автозаголовок

**Зачем.** Точка статуса и строка метрик в окне — те же, что в TUI, но считает их
хост.
**Зависит от:** 1.4. **Спека:** 5.1, 5.5.

**Эталон для переноса** (логика хуков, без React): `packages/tui/src/use-activity.ts`,
`use-log-index.ts`, `use-sessions.ts`, `use-map-sync.ts` (автозаголовок),
`use-session-link.ts` (привязка Codex).

**Файлы**
- Создать `packages/host/src/activity/`:
  - `activity-service.ts`;
  - `log-index.ts` — наблюдение за логами провайдеров;
  - тесты `activity-service.test.ts`, `log-index.test.ts`.

**Интерфейсы**

```ts
export interface SessionLive { activity: SessionActivity; metrics: LiveMetrics | null }
export interface ActivityService {
  start(): Promise<void>;
  get(ref: SessionRef): SessionLive | undefined;
  /** Пользователь смотрел на сессию: pty.attach и pty.input (1.6). */
  markSeen(ref: SessionRef, at?: string): void;
  onChange(listener: (ref: SessionRef, value: SessionLive) => void): () => void;
  stop(): Promise<void>;
}
export function createActivityService(
  host: HostContext, works: WorksService,
  options?: { silenceThresholdMs?: number; now?: () => number },
): ActivityService;
```

**Поведение**
- **Журнал хуков.** Для каждой работы — `openEvents(paths.events)` и
  `watchEvents(paths.events, onSession)` из core.
- **Логи провайдеров.** `watchSessions` из core по корням Claude и Codex. Для
  привязанных сессий `readSessionMetrics` даёт `lastRecordAt`, `lastUserRecordAt`,
  токены, длительность и модель.
- **Расчёт.** `activityOf({ events, log, seen, silenceThresholdMs, now })` из core.
  Событие `activity.changed` уходит только при изменении результата — сравнение по
  значению.
- **Таймер вместо опроса.** Если после расчёта впереди пересечение порога тишины,
  ставится один таймер на этот момент. Опроса нет.
- **`seen`** = `seenAt ≥ turnEndedAt`.
- **Метрики.** `unread` — число писем сессии с `readAt === null`; `subagents` — из
  `SessionActivity`.
- **Автозаголовок.** У сессии с ярлыком `NEW_LABEL` появился заголовок в индексе
  логов → один раз `applyAutoTitle`.
- **Привязка.** Для сессий без `providerSessionId` — `linkSession` на изменениях
  логов.
- **`hooks-missing`.** Сессия запущена хостом, активна, а журнала нет → один
  `host.notice` на сессию.
- **Порог тишины** берётся из `loadConfig()` при старте и после `settings.set`.

**Тесты** (журнал — строки JSON, как их пишет хук `cat >> events/<id>.jsonl`;
разбор — по `EventRecord` из `core/work/events.ts`)
1. `UserPromptSubmit` → `working`; `Stop` → `unseen`; `markSeen` → `idle`.
2. `PermissionRequest` → `blocked`; `Notification` с `elicitation_complete` →
   `working`.
3. Без хуков: тишина лога дольше порога → `idle`. Время подставное, таймер
   срабатывает ровно один раз.
4. `SubagentStart` ×2 и `SubagentStop` ×1 → `subagents: 1`.
5. `unread` считается по карте.
6. Автозаголовок: применяется один раз; переименованную руками сессию не трогает.
7. `hooks-missing` приходит один раз.
8. Одинаковый повторный расчёт не даёт второго события.

**Приёмка**
- [ ] Все 8 тестов зелёные.
- [ ] В коде сервиса нет `setInterval`.

---

## 1.6. Хост: PTY-менеджер, снимки, черновик, поток

**Зачем.** Хост держит процессы агентов, помнит экран и знает, что человек
набирает.
**Зависит от:** 1.5. **Спека:** 4.1, 4.3, 4.4. **Ревью:** пункты 3 и 4 индекса.

**Файлы**
- Создать:
  - `packages/host/src/pty/pty-process.ts`, `screen.ts`, `draft.ts`,
    `output-batcher.ts`, `pty-manager.ts` и тесты к каждому;
  - `packages/host/src/methods/pty.ts`;
  - `packages/host/test/stub-agent.mjs` — управляемый stub, режимы ниже.
- Изменить:
  - `packages/host/package.json` — `node-pty ^1`, `@xterm/headless ^5`,
    `@xterm/addon-serialize` (версия, совместимая с headless 5);
  - `scripts/fix-node-pty-perms.mjs` — если он чинит бит исполнения только у копии
    node-pty в tui, распространить на host;
  - `packages/host/src/server.ts` — поток `pty.output` только подключённым клиентам,
    пересинхронизация.

**stub-agent.mjs** (им пользуются 1.6–1.8 и этап 3):
- при старте печатает `STUB READY`, на каждую введённую строку отвечает
  `echo: <строка>`;
- `STUB_HOOKS=1` и заданы `HARNAS_WORK_DIR`, `HARNAS_SESSION_ID`:
  - при старте дописывает в `events/<id>.jsonl` `{"hook_event_name":"SessionStart"}`;
  - на каждую строку — `UserPromptSubmit` до ответа и `Stop` после;
- `STUB_TURN_MS=<n>` — ход длится n мс (между `UserPromptSubmit` и `Stop`);
- `STUB_ARGS_FILE=<путь>` — при старте пишет JSON
  `{ argv, cwd, env: { HARNAS_WORK_DIR, HARNAS_SESSION_ID, CLAUDE_CODE_SESSION_ID } }`;
- `STUB_FLOOD_MB=<n>` — при старте печатает n МБ строк;
- `STUB_IGNORE_SIGHUP=1` — игнорирует `SIGHUP`;
- `STUB_EXIT_AFTER_MS=<n>` — выходит с кодом 3;
- `STUB_PROMPT_FROM_ARGV=1` — последний элемент argv считается введённой строкой;
- на `SIGWINCH` печатает `SIZE <cols> <rows>`.

**Интерфейсы**

```ts
export interface PtyLaunch { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export interface ExitInfo { exitCode: number; signal: number | null }
export interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: ExitInfo) => void): () => void;
}
export function spawnPty(launch: PtyLaunch, size: { cols: number; rows: number }): PtyProcess;

export interface Screen { write(data: string): void; resize(cols: number, rows: number): void; snapshot(): string; dispose(): void }
export function createScreen(cols: number, rows: number, scrollback?: number): Screen; // 5000 по умолчанию

export class DraftTracker { input(data: string): void; readonly hasDraft: boolean; reset(): void }
export class OutputBatcher { constructor(flush: (data: string) => void, intervalMs?: number); push(data: string): void; dispose(): void } // 16 мс

export interface PtyHandle { ref: SessionRef; pid: number; cols: number; rows: number; hasDraft(): boolean }
export interface PtyManager {
  start(ref: SessionRef, launch: PtyLaunch, size?: { cols: number; rows: number }): PtyHandle; // 120×40 по умолчанию
  get(ref: SessionRef): PtyHandle | undefined;
  list(): PtyHandle[];
  write(ref: SessionRef, data: string): void;         // печать хоста (указатель) — черновик не трогает
  input(ref: SessionRef, data: string): void;         // ввод человека — через DraftTracker
  resize(ref: SessionRef, cols: number, rows: number): void;
  snapshot(ref: SessionRef): { snapshot: string; cols: number; rows: number };
  stop(ref: SessionRef, options?: { graceMs?: number }): Promise<ExitInfo>; // SIGHUP, через 3000 мс SIGKILL
  on(event: 'output', listener: (ref: SessionRef, data: string) => void): () => void;
  on(event: 'exit', listener: (ref: SessionRef, exit: ExitInfo) => void): () => void;
  on(event: 'draft', listener: (ref: SessionRef, hasDraft: boolean) => void): () => void;
}
export function createPtyManager(host: HostContext): PtyManager;
```

**Правила черновика** (`DraftTracker`):
- из входа вырезаются escape-последовательности: CSI `\x1b[…<финальный байт>`, SS3
  `\x1bO.`, прочие `\x1b.`;
- маркеры вставки `\x1b[200~` и `\x1b[201~` вырезаются, а содержимое вставки
  считается;
- `\r`, `\n`, `\x03` (Ctrl+C) и `\x15` (Ctrl+U) обнуляют счётчик;
- `\x7f` и `\x08` уменьшают его на 1, но не ниже 0;
- остальные управляющие знаки (< 0x20) игнорируются;
- каждая печатная кодовая точка (`Array.from`) даёт +1;
- `hasDraft` — счётчик больше 0.

**Методы и поток**
- **`pty.attach`** → снимок. Клиент подписывается на поток этой сессии, вызывается
  `activity.markSeen`.
- **`pty.detach`** снимает подписку.
- **Уведомление `pty.input`** → `manager.input` и `markSeen`; **`pty.resize`** →
  `manager.resize`.
- **Пересинхронизация.** `client.send` возвращает `false` при буфере сокета больше
  4 МБ. Тогда клиенту по этой сессии уходит `pty.resync`, и поток ему
  останавливается до нового `pty.attach`.
- **Выход процесса** → событие `pty.exit` всем клиентам.
- **Таймер простоя.** Живой PTY занимает его: `host.busy(refKey, true)`.

**Тесты** (stub через node)
1. `pty.attach` после старта → в снимке есть `STUB READY`.
2. Ввод `hello\r` → в потоке есть `echo: hello`.
3. `pty.resize(100, 30)` → stub печатает `SIZE 100 30`.
4. `STUB_IGNORE_SIGHUP=1`, `graceMs: 200` → процесс убит `SIGKILL`, `signal === 9`.
5. `STUB_FLOOD_MB=20`:
   - в снимке не больше 5 000 строк прокрутки;
   - клиент с приостановленным сокетом получает `pty.resync` и дальше ни одного
     `pty.output`;
   - после нового `pty.attach` получает снимок.
6. `OutputBatcher`: три `push` за 10 мс дают одну отправку (подставные таймеры).
7. Вывод `ёжик`, разрезанный по байтам между кусками, в снимке целый.
8. `DraftTracker` — таблица:

   | ввод | черновик |
   |---|---|
   | `привет` | да |
   | `привет\r` | нет |
   | `ab\x7f\x7f` | нет |
   | `ab\x7f` | да |
   | `\x1b[A` | не меняется |
   | вставка `\x1b[200~текст\x1b[201~` | да |
   | `😀\x7f` | нет |
   | `abc\x15` | нет |
9. `manager.write` (печать хоста) флаг черновика не ставит.

**Приёмка**
- [ ] Все 9 тестов зелёные.
- [ ] Поток идёт только клиентам, подключённым к этой сессии: второй клиент без
      `attach` его не получает.

---

## 1.7. Хост: сессии и autoLaunch

**Зачем.** Создание, запуск, остановка и удаление сессий, а также фоновый старт
сессий, порождённых агентом.
**Зависит от:** 1.1, 1.6, П0. **Спека:** 3.2, 7.2 (строка `pending`), 9.1.

**Файлы**
- Создать `packages/host/src/sessions/sessions-service.ts`, `auto-launch.ts`,
  `methods/sessions.ts` и тесты.

**Интерфейсы**

```ts
export interface CreateSessionInput {
  projectPath: string; workId: string | null; provider: string;
  label: string; task: string; parent: string | null;
}
export type LaunchMode = 'launch' | 'resume' | 'new';
export interface SessionsService {
  create(input: CreateSessionInput): Promise<SessionRef>;
  launch(ref: SessionRef, mode: LaunchMode): Promise<void>;
  stop(ref: SessionRef): Promise<void>;
  delete(ref: SessionRef): Promise<void>;
  live(ref: SessionRef): boolean;
  stopAll(): Promise<void>;
}
export function createSessionsService(
  host: HostContext, works: WorksService, pty: PtyManager, activity: ActivityService,
): SessionsService;
/** Какие pending-сессии поднять в фоне: только порождённые агентом и появившиеся после первого чтения. */
export function autoLaunchCandidates(
  previous: WorkEntry | undefined, next: WorkEntry, firstReadDone: boolean,
): string[];
```

**Запуск `launch(ref, mode)`:**
1. `planLaunch`, `planResume` или `planNew` из core с `{ channel: false }`.
2. `command = await findRunnerBinary(plan.command, env)` — подмена через
   `HARNAS_CLAUDE_BIN`.
3. `env = { ...agentEnv(process.env), ...plan.env }`. Окружение самого хоста — это
   окружение login-shell от окна.
4. `pty.start(ref, { command, args: plan.args, cwd: plan.cwd, env })`.
5. `startSession(projectPath, workId, sessionId, plan.providerSessionId,
   { pid, startedAtProcess: await processStartedAt(pid), launchedBy: 'host' })`.
6. На выходе процесса — `finishExited(…)` из core.
7. Ошибка запуска (нет бинаря и т. п.) → `host.notice { kind: 'launch-failed' }`,
   сессия остаётся `pending`, метод отвечает ошибкой.

**Создание `create(input)`:**
- `workId === null` → `createNewSession(projectPath, null)` (работа «без названия»),
  затем `launch(…, 'new')`;
- `task === ''` и `parent === null` → `createNewSession(projectPath, workId)`, затем
  `'new'`;
- `task === ''` и `parent` задан → `createChildSession`, затем `'launch'` (тихий
  старт);
- иначе `createPendingSession(projectPath, workId, { provider, label, task, parent,
  contextFrom: parent === null ? [] : [parent] })`, затем `'launch'`.

**Остальные действия**
- **`stop`** — `pty.stop` (SIGHUP, через 3 с SIGKILL); статус меняет обработчик
  выхода.
- **`delete`** — если сессия жива, сначала `stop`, затем `deleteSession` из core.
- **`stopAll`** регистрируется в `host.onShutdown`.
- **autoLaunch** — на каждом `works.onChange` для всех работ. Выполняется, только
  если `loadConfig().autoLaunch === true`; запуск идёт без `attach`.

**Методы:** `sessions.create`, `sessions.resume` (`launch(ref, 'resume')`),
`sessions.stop`, `sessions.delete`.

**Тесты** (stub через `HARNAS_CLAUDE_BIN`, `STUB_ARGS_FILE`)
1. `create` с задачей → argv stub:
   - есть `--settings <…>/settings.json`, `--mcp-config <…>`,
     `--append-system-prompt`;
   - последним аргументом идёт бриф;
   - **нет** `--dangerously-load-development-channels`.
2. Окружение stub:
   - есть `HARNAS_WORK_DIR` и `HARNAS_SESSION_ID`;
   - нет `CLAUDE_CODE_SESSION_ID`, даже если он задан в окружении хоста.
3. Карта после старта: `active`, `pid` stub, `launchedBy: 'host'`,
   `providerSessionId` равен uuid из `--session-id`.
4. `STUB_EXIT_AFTER_MS=100` → `exited`, в `history` код 3, пришло событие `pty.exit`.
5. Быстрая сессия (`task: ''`, без родителя) — промпта в argv нет.
6. autoLaunch — `autoLaunchCandidates` и сервис:
   - pending с родителем, дописанная в карту через `updateMap` после первого
     чтения, → поднята без `attach`;
   - pending без родителя → не поднята;
   - pending, которая была до старта хоста, → не поднята;
   - `autoLaunch: false` → не поднята.
7. `stop` → `exited`. `delete` живой сессии → процесс остановлен, записи и файлов
   нет.
8. Бинаря нет → `launch-failed`, сессия осталась `pending`.
9. `host.shutdown` → все stub получили `SIGHUP`, в картах `exited`.

**Приёмка**
- [ ] Все 9 тестов зелёные.
- [ ] `grep -n "dangerously-load-development-channels\|HARNAS_CHANNEL"
      packages/host/src` ничего не находит.

---

## 1.8. Хост: будильник живых сессий

**Зачем.** Письмо будит простаивающего агента без канала — хост печатает указатель.
**Зависит от:** 1.5, 1.7. **Спека:** 7.2 (строка `active`), 7.3, 10. **Ревью:**
пункт 4 индекса.

**Файлы**
- Создать:
  - `packages/core/src/work/delivery.ts` и тест — чистые правила;
  - `packages/host/src/wake/wake-service.ts` и тест;
  - `packages/host/src/methods/wake.ts`.
- Изменить `packages/core/src/index.ts`.

**Интерфейсы**

```ts
// core/work/delivery.ts
export interface DeliveryInput {
  session: WorkSession;
  activity: SessionActivity | null;
  hasDraft: boolean;
  paused: boolean;
  unread: readonly Message[];      // письма сессии с readAt === null, без deleted
  pointed: ReadonlySet<string>;    // id писем, на которые указатель уже печатали
  inFlight: boolean;
}
export type DeliveryAction =
  | { kind: 'none'; reason: 'paused' | 'no-letters' | 'already-pointed' | 'not-live' | 'busy' | 'draft' | 'in-flight' }
  | { kind: 'type-pointer'; text: string; letterIds: string[] };
export function deliveryAction(input: DeliveryInput): DeliveryAction;
/** 'Новые письма (N). Вызови check_inbox.' — этап 3 добавит комнаты. */
export function pointerText(count: number): string;

// host/wake/wake-service.ts
export interface WakeService { start(): void; paused(): boolean; pause(): void; resume(): void; stop(): void }
export function createWakeService(
  host: HostContext, works: WorksService, activity: ActivityService, pty: PtyManager,
  options?: { enterDelayMs?: number; pointerTimeoutMs?: number }, // 500 и 10 000
): WakeService;
```

**Правила `deliveryAction`** — по порядку, первое сработавшее:
1. `paused` → `none(paused)`.
2. Нет непрочитанных → `none(no-letters)`. Все непрочитанные уже в `pointed` →
   `none(already-pointed)`.
3. `session.status !== 'active'` → `none(not-live)`.
4. `activity === null` или состояние не `unseen` и не `idle` → `none(busy)`.
5. `hasDraft` → `none(draft)`.
6. `inFlight` → `none(in-flight)`.
7. Иначе `type-pointer`: текст — `pointerText(unread.length)`, в `letterIds` — все
   непрочитанные.

**Сервис**
- **Когда пересчитывать.** На `works.onChange`, `activity.onChange`, событие
  `draft` менеджера и `resume`. Пересчёт идёт только для сессий, чьим PTY владеет
  этот хост (`pty.get(ref)`); сессии TUI живут со своим каналом.
- **Печать.** `pty.write(ref, text)`. Через `enterDelayMs` — `'\r'`, если pid тот же
  и между печатью и Enter человек ничего не вводил. Если вводил — Enter не
  отправляется, приходит `host.notice { kind: 'pointer-cancelled' }`, текст остаётся
  в поле ввода у человека.
- **Указатель в полёте.** `inFlight` снимается, когда activity стала `working`
  (`UserPromptSubmit`). Если за `pointerTimeoutMs` хода не случилось, приходит
  `host.notice { kind: 'pointer-timeout' }`; `inFlight` снимается, а письма остаются
  в `pointed`, поэтому повторного набора нет.
- **Пауза.** `pause` и `resume` рассылают `wake.changed`. Пауза хранится в памяти.

**Методы:** `wake.pause`, `wake.resume`, `wake.state`.

**Тесты**
1. **core, `deliveryAction`** — таблица на все семь ветвей. Письма к удалённой сессии
   (`deleted`) не считаются.
2. **core, `pointerText(1)`** — ровно `Новые письма (1). Вызови check_inbox.`;
   `pointerText(3)` — `(3)`.
3. **Хост** (stub с `STUB_HOOKS=1`):
   - письмо простаивающей сессии → stub печатает
     `echo: Новые письма (1). Вызови check_inbox.`;
   - письмо во время хода (`STUB_TURN_MS=500`) → указатель уходит только после
     `Stop`;
   - `pty.input('пр')` (черновик) → указателя нет; после `\r` и `Stop` — есть;
   - три письма → `(3)` одним указателем;
   - stub без хуков, `pointerTimeoutMs: 300` → `pointer-timeout`, повторного набора
     нет;
   - пауза держит письма; `resume` доставляет;
   - кириллица указателя в echo совпадает байт в байт;
   - ввод человека между текстом и Enter (`enterDelayMs: 300`, ввод на 100 мс) →
     Enter не отправлен, пришёл `pointer-cancelled`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Тело письма не появляется в выводе stub ни в одном тесте.

---

## 1.9. Окно: оболочка Electron и связь с хостом

**Зачем.** Безопасное окно, которое само находит или поднимает хост и переживает его
перезапуск.
**Зависит от:** 1.2; для E2E — 1.3. **Спека:** 3.2, 4.5, 9.2. **Ревью:** пункты 1 и 2
индекса.

**Файлы**
- Создать `packages/desktop/`:
  - `package.json` (`@harnas/desktop`; скрипты `dev: electron-vite dev`,
    `build: electron-vite build`, `test: vitest run`, `e2e: playwright test`;
    зависимости: `electron` — текущая стабильная, **точной версией**,
    `electron-vite`, `@vitejs/plugin-react`, `react` и `react-dom` 18 (как в tui),
    `zustand`, `tailwindcss` 4 и `@tailwindcss/vite`, `@harnas/protocol`;
    dev-зависимости: `vitest`, `jsdom`, `@testing-library/react`,
    `@playwright/test`);
  - `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`,
    `tsconfig.web.json` (в `lib` у renderer есть `DOM`), `vitest.config.ts`
    (`environment: 'jsdom'` для renderer), `playwright.config.ts`;
  - `src/main/index.ts`, `security.ts`, `shell-env.ts`, `host-launcher.ts`,
    `host-connection.ts`, `ipc.ts`, `menu.ts`;
  - `src/preload/index.ts`;
  - `src/shared/bridge.ts`;
  - `src/renderer/index.html` (с CSP), `main.tsx`, `App.tsx`, `host-client.ts`,
    `styles.css`;
  - тесты `src/main/shell-env.test.ts`, `host-connection.test.ts`, `ipc.test.ts` и
    `e2e/smoke.spec.ts`.
- Изменить:
  - корневой `package.json` — скрипт
    `"dev:desktop": "pnpm --filter @harnas/host build && pnpm --filter @harnas/desktop dev"`;
  - `eslint.config.js` — браузерные глобалы для `packages/desktop/src/renderer/**`
    и `preload/**`, игнор `packages/desktop/out/**`;
  - `.gitignore` — `packages/desktop/out/`, `test-results/`.

**Интерфейсы**

```ts
// shared/bridge.ts
export type HostStatus =
  | { state: 'connecting' }
  | { state: 'connected'; hostVersion: string }
  | { state: 'mismatch'; hostVersion: string; liveSessions: number | null }
  | { state: 'disconnected'; reason: string };
export type MenuAction =
  | 'new-session' | 'close-panel' | 'split-right' | 'split-down' | 'prev-panel' | 'next-panel'
  | 'palette' | 'find' | 'settings' | `work-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export interface HarnasBridge {
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  notify<N extends NotificationName>(method: N, params: Params<N>): void;
  on<E extends EventName>(event: E, listener: (data: EventData<E>) => void): () => void;
  onStatus(listener: (status: HostStatus) => void): () => void;
  app: {
    openExternal(url: string): Promise<void>;          // только http и https
    notify(note: { title: string; body: string }): void;
    setBadge(count: number): void;
    chooseFolder(): Promise<string | null>;
    restartHost(): Promise<void>;
    onMenu(listener: (action: MenuAction) => void): () => void;
  };
}
declare global { interface Window { harnas: HarnasBridge } }

// main/shell-env.ts
export interface ShellEnvResult { env: NodeJS.ProcessEnv; fromShell: boolean; warning: string | null }
export async function captureShellEnv(options?: {
  shell?: string; timeoutMs?: number; // $SHELL или /bin/zsh; 5000
  run?: (shell: string, args: string[], timeoutMs: number) => Promise<string>;
}): Promise<ShellEnvResult>;

// main/host-launcher.ts
export function resolveHostEntry(): string; // require.resolve('@harnas/host/main')
export function spawnHost(options: { env: NodeJS.ProcessEnv; entry: string; nodeBin: string }): void; // detached + unref

// main/host-connection.ts
export class HostConnection {
  constructor(options: {
    paths: HostPaths; env: NodeJS.ProcessEnv;
    spawn: () => void; connectTimeoutMs?: number; // 5000
  });
  connect(): Promise<void>;
  call(method: MethodName, params: unknown): Promise<unknown>;
  notify(method: NotificationName, params: unknown): void;
  onEvent(listener: (message: EventMessage) => void): () => void;
  onStatus(listener: (status: HostStatus) => void): () => void;
  restartHost(): Promise<void>; // host.shutdown → spawn → connect
  close(): void;
}
```

**Поведение**
- **`index.ts`:**
  - `app.requestSingleInstanceLock()`; если лок не получен — `app.quit()`;
  - на `second-instance` — показать и сфокусировать окно;
  - затем `captureShellEnv` → `HostConnection.connect()` → окно.
- **`security.ts`:**
  - `webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload }`;
  - `setWindowOpenHandler` → `deny`;
  - на `will-navigate` — `preventDefault` для любого адреса, кроме своего
    `index.html`.
- **CSP в `index.html`:** `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'`.
- **`shell-env.ts`:**
  - запускает `$SHELL -ilc 'printf "\n__HARNAS_ENV__\n"; env -0'` и разбирает вывод
    после маркера (шум rc-файлов до маркера отбрасывается);
  - при таймауте или ошибке возвращает `process.env` и `warning`.
- **`host-connection.ts`:**
  - подключение к сокету; при `ENOENT` или `ECONNREFUSED` — `spawn()` и ожидание
    сокета до 5 с;
  - токен читается из файла, затем `hello` с `client: 'desktop'`;
  - `protocol_mismatch` → статус `mismatch` с `hostVersion` и `liveSessions` из
    `error.data`;
  - обрыв → `disconnected` и переподключение: 500 мс с удвоением до 5 с;
  - ответы сопоставляются по `id`.
- **`ipc.ts`:**
  - `ipcMain.handle('host:call')` — белый список = ключи `METHODS`;
  - `ipcMain.on('host:notify')` — белый список = ключи `NOTIFICATIONS`;
  - события хоста → `webContents.send('host:event', …)`, статус → `'host:status'`;
  - `app:*` — `openExternal` только `http:` и `https:`, `Notification`,
    `app.dock.setBadge`, `dialog.showOpenDialog` (выбор каталога), `restartHost`.
- **`menu.ts`:**
  - меню приложения с ⌘T, ⌘W, ⌘D, ⇧⌘D, ⌘[, ⌘], ⌘K, ⌘F, ⌘, и ⌘1…⌘9 →
    `webContents.send('menu:action', action)`;
  - меню Edit со стандартными ролями `copy`, `paste`, `selectAll`.
- **Renderer:** статус связи, пустое состояние «Работ пока нет» и кнопка «Новая
  работа» (выбор каталога → `works.create`). При `mismatch` — диалог «Хост старой
  версии. Перезапустить? Живых сессий: N».

**Тесты**
1. **`shell-env`:**
   - `A=1\0B=два\0` после маркера разбирается;
   - шум до маркера игнорируется;
   - таймаут → `fromShell: false` и `warning`.
2. **`host-connection`** против настоящего `startHost` во временном доме:
   - к живому хосту подключается без `spawn`;
   - без хоста зовёт `spawn` (в тесте он поднимает хост в процессе);
   - после `host.shutdown` переподключается к новому;
   - на `protocol_mismatch` статус `mismatch`;
   - файл сокета без слушателя → путь через `spawn`.
3. **`ipc`:**
   - неизвестный метод отвергается;
   - `openExternal('file:///etc/passwd')` и `javascript:` отвергаются.
4. **E2E** (Playwright `_electron.launch`, `HARNAS_HOME` в `/tmp/hh-*`,
   `HARNAS_CLAUDE_BIN` на stub):
   - окно показывает «Работ пока нет», `host.sock` существует;
   - в renderer `typeof require === 'undefined'`, а `window.harnas` определён;
   - второй запуск приложения завершается сам, первое окно на месте.

**Приёмка**
- [ ] Все тесты зелёные, E2E проходит локально.
- [ ] `pnpm dev:desktop` открывает окно, хост поднимается сам.
- [ ] Закрытие приложения не останавливает хост (`host.sock` на месте).

---

## 1.10. Окно: сайдбар, строка статуса, уведомления, настройки

**Зачем.** Навигация по работам и сессиям мышью, точки статуса, уведомления macOS,
настройки в окне.
**Зависит от:** 1.9; живые данные — из 1.4 и 1.5. Тесты идут на подставном
`HarnasBridge`. **Спека:** 5.1, 5.4, 5.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `store/works.ts`, `store/activity.ts`, `store/ui.ts`, `store/notices.ts`
    (zustand);
  - `lib/tree-order.ts`, `lib/dot-state.ts`, `lib/metrics-line.ts`,
    `lib/participant.ts`;
  - `components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx`,
    `StatusDot.tsx`, `MetricsLine.tsx`, `SessionMenu.tsx`;
  - `components/StatusBar.tsx`;
  - `components/dialogs/NewWorkDialog.tsx`, `NewSessionDialog.tsx`,
    `ConfirmDialog.tsx`;
  - `components/settings/SettingsDialog.tsx`;
  - `theme/palettes.ts`, `theme/apply-theme.ts`;
  - `notifications.ts`;
  - тесты рядом.
- Изменить:
  - `packages/core/src/config.ts` и тест — ключи `fontFamily` (`'Menlo'`) и
    `fontSize` (13, допустимо 8…32), переменные `HARNAS_FONT_FAMILY` и
    `HARNAS_FONT_SIZE`, ветки в `parseSetting`;
  - `package.json` desktop — `@radix-ui/react-context-menu`,
    `@radix-ui/react-dialog`, `@radix-ui/react-select`.

**Перенос из TUI.** Копия чистых функций с комментарием-ссылкой на источник:
- `treeOrder` и `sessionSequence` — из `tui/src/work-rows.ts`;
- `dotState`, `maxDotState` и слова состояний — из
  `tui/src/components/activity-dot.tsx`;
- формат строки метрик `↑1.2к ↓845 · 12м · ▤1 · ⋮1` — из `tui/src/format.ts`;
- палитры `mocha`, `latte`, `gruvbox`, `nord`, `tokyo-night` — из
  `tui/src/theme/palettes.ts`. Тема `terminal` в окне показывается как `mocha`.

**Поведение**
- **Хранилище.** Старт — `works.list`, дальше `works.changed`. Активность — из
  `activity.changed` по `refKey`. Последние 20 записей `host.notice` хранятся.
- **Список работ.** Номер 1…9 по порядку создания, заголовок, хвост пути проекта и
  ветка (`branches`), точка работы — максимум по её сессиям.
- **Дерево сессий:**
  - дерево по `parent`, порядок по `createdAt`;
  - строка: точка, `S03`, ярлык, слово состояния;
  - под выбранной строкой — строка метрик.
- **Меню сессии** (Radix ContextMenu):
  - «Открыть»;
  - «Возобновить» для `exited`, `done` и `failed`;
  - «Остановить» с подтверждением → `sessions.stop`;
  - «Удалить» с подтверждением → `sessions.delete`.
- **Строка статуса:** последнее событие, состояние связи и переключатель паузы
  будильника (`wake.pause` и `wake.resume`, состояние из `wake.changed`).
- **Уведомления.** Сессия перешла в `blocked` или `unseen` и не видна: она не
  выбрана или окно не в фокусе. Тогда уходит `app.notify` с заголовком «S03 ждёт
  ответа» или «S03 закончила ход» и ярлыком в тексте. Бейдж — число сессий в
  `blocked` или `unseen`.
- **Настройки.** Поля: `silenceThresholdMs`, `messageRate`, `autoLaunch`, `theme`,
  `fontFamily`, `fontSize`.
  - Заблокированное переменной окружения поле неактивно и подписано «задано
    HARNAS_…».
  - Сохранение идёт по одному полю через `settings.set`, ошибка показывается под
    полем.
- **Новая работа:** каталог, заголовок, цель → `works.create`.
- **Новая сессия (⌘T):**
  - провайдер из `providers.list`, недоступный — неактивен;
  - ярлык;
  - задача — пустая означает тихий старт;
  - флажок «дочерняя выбранной» → `sessions.create`.

**Тесты**
1. `tree-order`: вложенность и порядок не меняются от смены статусов.
2. `dot-state`: таблица всех сочетаний статуса и активности; у `done` цвета нет.
3. `metrics-line`:
   - токенов нет → `—`;
   - тысячи — с `к`, минуты — с `м`;
   - нулевые `▤` и `⋮` не печатаются.
4. `Sidebar` на фикстуре: номера 1…3, у выбранной сессии есть строка метрик.
5. Уведомления:
   - `blocked` у невидимой сессии → `notify` ровно один раз;
   - у видимой — ни разу;
   - бейдж считает сессии в `blocked` и `unseen`.
6. Настройки: поле, заданное окружением, неактивно и подписано именем переменной;
   ошибка хоста видна под полем.
7. core, `config`: значения по умолчанию, переопределение из окружения, границы
   `fontSize`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Ни одна строка ярлыка не ломает ширину сайдбара — длинный ярлык обрезается
      многоточием (тест на ярлыке в 200 знаков).

---

## 1.11. Окно: панель терминала и клавиши

**Зачем.** Настоящий терминал агента в окне: обычные выделение, копирование и
прокрутка.
**Зависит от:** 1.9; живые данные — из 1.6. **Спека:** 5.2, 5.3.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `components/terminal/TerminalPanel.tsx`, `use-terminal.ts`, `xterm-theme.ts`;
  - `lib/keys.ts`;
  - тесты рядом и `e2e/terminal.spec.ts`.
- Изменить:
  - `App.tsx` — выбранная сессия показывается в `TerminalPanel`;
  - `package.json` desktop — `@xterm/xterm` ^5 и совместимые `@xterm/addon-webgl`,
    `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-web-links`.

**Поведение**
- **Подключение.** При монтировании — `pty.attach(ref)`, `term.write(snapshot)` и
  подписка на `pty.output` этой сессии.
- **Пересинхронизация.** `pty.resync` → `term.reset()` и новый `attach`.
- **Отключение.** При размонтировании — `pty.detach`.
- **Размер.** `ResizeObserver` → fit → через 50 мс тишины `pty.resize`.
- **Ввод.** `term.onData` → уведомление `pty.input`. Сочетания с ⌘ агенту не уходят:
  `attachCustomKeyEventHandler` возвращает `false`, когда нажат `metaKey`, и их
  обрабатывает меню.
- **Копирование.** ⌘C при выделении копирует `term.getSelection()`. ⌘V — роль
  `paste` меню; вставка в скобках (bracketed paste) идёт через xterm.
- **WebGL.** Используется WebGL-рендер; при `webglcontextlost` — откат на DOM.
- **Ссылки** открываются через `app.openExternal`.
- **Шрифт и тема** — из конфига и палитры.
- **Клавиши этапа 1:**
  - ⌘T — новая сессия;
  - ⌘W — закрыть панель: окно показывает пустое место, сессия не трогается;
  - ⌘F — поиск;
  - ⌘, — настройки;
  - ⌘1…⌘9 — работа и её последняя открытая сессия (запоминается в `store/ui.ts`).
  
  ⌘D, ⇧⌘D, ⌘[, ⌘] и ⌘K до этапа 2 ничего не делают.

**Тесты** (xterm в jsdom подменяется фейковым `Terminal`, который пишет в массив)
1. `attach` → первым записан снимок, затем вывод.
2. `pty.resync` → `reset` и повторный `attach`.
3. Три ресайза за 30 мс → один `pty.resize`.
4. Клавиша с `metaKey` не уходит в `pty.input`.
5. Ссылка `https://…` → `openExternal`; `file://…` не открывается.
6. Размонтирование → `pty.detach`.
7. **E2E со stub:**
   - ввод `hello` и Enter → на экране `echo: hello`;
   - выход из приложения и новый запуск → сессия жива, экран восстановлен из
     снимка.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Выделение мышью и ⌘C кладут текст в буфер обмена (ручная проверка).

---

## 1.12. Документы и живая приёмка этапа 1

**Файлы**
- `README.md` — раздел «Окно»:
  - запуск `pnpm dev:desktop`;
  - что такое хост и где его файлы (`~/.harnas/host/`);
  - чем окно отличается от TUI;
  - пункты рамки из спеки 9.1.
- `TODOS.md`:
  - закрыть «Фоновый сервер и detach/reattach» со ссылкой на коммиты;
  - записать хвосты этапа 1.
- Спека, раздел 12, допущение 3 — итог живой проверки.

**Живая приёмка** (человек, настоящий `claude`)
- [ ] Рабочий день в окне вместо TUI.
- [ ] Закрыл окно — агенты работают; открыл — экраны на месте.
- [ ] Вышел из приложения — хост жив; новый запуск — сессии на месте.
- [ ] Сессия от `spawn_session` стартует сама: без Enter и без диалога канала.
- [ ] Письмо простаивающему Claude — указатель стал его ходом. В спеке, §12,
      записано, сколько было попыток и сбоев.
- [ ] Уведомление macOS пришло для невидимой сессии, ждущей ответа.
- [ ] Настройки сохраняются и переживают перезапуск.
- [ ] Замер к открытому вопросу спеки 14: stub выводит 20 МБ, окно подключено.
      Записаны время до последней строки на экране и загрузка процессора хоста. Если
      окно отстаёт больше чем на секунду — в `TODOS.md` уходит задача на бинарный
      кадр `pty.output`.

---

## 1.13. По желанию: `.app` для себя

**Зачем.** Запуск из Dock, а не из терминала.
**Зависит от:** 1.12.

**Файлы**
- `packages/desktop/electron-builder.yml`: `mac.target: dir`, `identity: null` —
  без подписи.
- Скрипт `dist` в `package.json` desktop:
  `pnpm --filter @harnas/host deploy --prod out/host && electron-builder`.
  Каталог `out/host` попадает в `extraResources` как `host`.
- `src/main/host-launcher.ts`:
  - в собранном приложении `resolveHostEntry()` возвращает
    `process.resourcesPath/host/dist/main.js`;
  - `node` ищется по PATH из login-shell;
  - если `node` не найден — диалог с инструкцией.

**Приёмка**
- [ ] `.app`, запущенный из Finder, поднимает хост из `Resources/host`.
- [ ] `claude` находится через PATH login-shell (проверка с `claude` из nvm или
      Homebrew).
- [ ] Выход из приложения оставляет хост работать.
