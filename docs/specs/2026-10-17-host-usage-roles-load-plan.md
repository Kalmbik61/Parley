# Дешёвые `rooms.usage` и `roles.list` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** срез расхода комнаты считается по шкале наблюдений с дочитыванием хвоста лога вместо полного перечита, чип спрашивает раз в минуту; `roles.list` берёт сессию из снимка хоста и кэширует каталог ролей (и спавн codex) по рабочему каталогу на минуту, окно зовёт его один раз на каталог.

**Architecture:** ядро выносит правило «запись лога → наблюдение учёта» в чистые функции и получает `UsageTimeline` (смещение, ino, наблюдения) с `extendUsageTimeline` (чтение с `offset`) и `sliceUsageTimeline` (проигрывание в `createUsageLedger({ windows })`). `LogIndex.usageIn` хоста держит LRU шкал по файлу и кэш обнаружения подагентов. `createRolesList` получает `works.entry` и TTL-кэш по `cwd`. В окне чип расхода теряет зависимость от токенов, а чипы ролей читают общий стор по `cwd`.

**Tech Stack:** TypeScript, Node 22, vitest, zod (протокол не меняется), React + zustand (окно), pnpm workspace.

**Spec:** [`docs/specs/2026-10-17-host-usage-roles-load-design.md`](2026-10-17-host-usage-roles-load-design.md) — читать вместе с планом; baseline — раздел «Baseline 2026-10-17» в `2026-10-16-host-diagnostics-and-load-design.md`.

## Global Constraints

- База — `origin/master` (26da1d52 или новее, 0.15.0). Ветка `feat/host-usage-roles-load`, worktree `.claude/worktrees/host-usage-roles-load`; перед `pnpm install` и полными прогонами — `uptime`, при load ≥ 10 ждать.
- После правок `packages/core` или `packages/protocol` перед тестами хоста и окна — `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build`.
- Протокол не меняется. Старое окно / старый хост работают как раньше.
- Константы: `ROOM_USAGE_MIN_INTERVAL_MS = 60_000` (было 10 000), `ROOM_USAGE_REFRESH_MIN_MS = 5_000`, `USAGE_TIMELINE_CACHE_SIZE = 256`, `SUBAGENT_DISCOVERY_TTL_MS = 30_000`, `ROLE_CATALOG_TTL_MS = 60_000`, `ROLES_STORE_TTL_MS = 60_000`.
- Шкала только в памяти; усечение (`size < offset`) или подмена (`ino` другой) — чтение с нуля; неполная последняя строка не разбирается до следующего вызова.
- Цифры расхода не меняются: `sliceUsageTimeline` даёт тот же `UsageSummary`, что полный перечит с теми же окнами (тест эквивалентности на фикстурах обоих провайдеров).
- Тексты окна по-английски в `packages/desktop/src/shared/strings.ts` (страж `english-ui.test.ts`); в хосте кириллица только в первом аргументе `log.*` (страж `english-text.test.ts`). Комментарии, тесты, документы — по-русски.
- Тесты — только фокусные из плана, без мутационных прогонов и переборов; один процесс тестов за раз.
- Один коммит на задачу, сообщение по-русски в стиле репозитория, последней строкой `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Лог дописан не целой строкой (агент пишет запись по частям) — хвост без `\n` не разбирается и не теряется: следующий вызов начинает с того же `offset` (задача 2, тест «неполная последняя строка»).
2. Лог усечён или подменён (ротация Codex, удалённая и заново созданная сессия) — шкала строится заново, суммы не удваиваются (задача 2, тест «усечение и другой ino»).
3. У участника появился новый подагент между вызовами — он попадает в срез не позже чем через 30 с (задача 3, тест «новый файл подагента после TTL»).
4. Каталог ролей упал (codex не найден, таймаут) — ошибка не кэшируется на минуту, следующий вызов пробует снова; при этом 12 одновременных вызовов не плодят 12 спавнов (задача 5, тесты «ошибка не кэшируется» и «одновременные вызовы»).
5. Рабочий каталог сессии сменился (worktree появился после запуска) — `revision` чипа меняется, стор окна перечитывает роли для нового `cwd`, старый `cwd` не используется (задача 6, тест «смена revision и cwd»).

---

### Task 1: Наблюдения учёта — чистые функции ядра

**Files:**
- Create: `packages/core/src/work/usage-observations.ts`
- Test: `packages/core/src/work/usage-observations.test.ts`
- Modify: `packages/core/src/session-index.ts` (~214-226: `ledger.observe` для `assistant` с `usage`; ~289-310: подагенты с `child: true`), `packages/core/src/codex/index-session.ts` (~216-224: `event_msg`/`token_count`; все прочие вызовы `ledger.observe`, включая сбросы)
- Modify: `packages/core/src/index.ts` (экспорт)

**Interfaces:**
- Consumes: `createUsageLedger` (`work/usage-ledger.ts`), `SessionRecord`/`adapterV1` (`adapter-v1.ts`), `codexCounters` (`codex/index-session.ts:30-44`), `RawRecord` (`jsonl.ts`).
- Produces:
  ```ts
  export type UsageObservation = Parameters<ReturnType<typeof createUsageLedger>['observe']>[0];
  /** Запись лога Claude → наблюдение учёта или null (не assistant, нет usage). `child` ставит вызывающий. */
  export function claudeUsageObservation(record: SessionRecord, file: string, lineNo: number): UsageObservation | null;
  /** Сырая запись rollout Codex → наблюдение (cumulative по token_count, сброс и т.п.) или null. */
  export function codexUsageObservation(raw: RawRecord): UsageObservation | null;
  ```
  Индексаторы зовут эти функции вместо собственных веток `ledger.observe(...)`; порядок и содержимое наблюдений не меняются.

- [ ] **Step 1: Падающие тесты.** На фикстурах из `session-index.test.ts` и `codex/index-session.test.ts` (взять те же файлы): собрать массив наблюдений через новые функции и сравнить с массивом, который даёт перехват `ledger.observe` у существующего индексатора (подменить `createUsageLedger` шпионом в тесте индексатора или собрать ожидаемый список руками для короткой фикстуры). Минимум: Claude — три assistant-записи с usage, одна без usage, одна user; Codex — два `token_count` и сброс.
- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/usage-observations.test.ts` → FAIL (модуль не найден).
- [ ] **Step 3:** Реализовать функции, перевести оба индексатора на них (без изменения результата).
- [ ] **Step 4:** `pnpm --filter @parley/core exec vitest run src/work/usage-observations.test.ts src/session-index.test.ts src/codex` → PASS.
- [ ] **Step 5:** Commit — `refactor(core): правило «запись лога → наблюдение учёта» вынесено в usage-observations`.

---

### Task 2: Шкала расхода файла — дочитывание хвоста и срез

**Files:**
- Create: `packages/core/src/work/usage-timeline.ts`
- Test: `packages/core/src/work/usage-timeline.test.ts`
- Modify: `packages/core/src/index.ts` (экспорт)

**Interfaces:**
- Consumes: задача 1; `createUsageLedger`, `withDescendants`, `DescendantUsage` (`usage-ledger.ts:485-557`); `adapterV1.toSessionRecord` для Claude; `node:fs` `stat`, `createReadStream({ start })`.
- Produces:
  ```ts
  export interface UsageTimeline { file: string; family: 'claude' | 'codex'; offset: number; size: number; ino: number; lineNo: number; observations: UsageObservation[] }
  export interface TimelineReader { stat(file: string): Promise<{ size: number; ino: number }>; open(file: string, start: number): NodeJS.ReadableStream }  // для тестов; по умолчанию fs
  export async function extendUsageTimeline(previous: UsageTimeline | null, file: string, family: 'claude' | 'codex', reader?: TimelineReader): Promise<UsageTimeline>;
  export function sliceUsageTimeline(main: UsageTimeline, descendants: ReadonlyArray<{ timeline: UsageTimeline; descendant: Omit<DescendantUsage, 'usage'> }>, windows: readonly UsageWindow[]): UsageSummary | undefined;
  ```
  `extendUsageTimeline`: файла нет → `{ offset: 0, size: 0, ino: 0, observations: [] }`; `previous` с другим `ino` или `size < offset` → с нуля; иначе чтение с `offset` кусками, разбор только полных строк (`\n`), битая строка пропускается, `offset` — конец последней полной строки. Для Claude запись проходит `adapterV1.toSessionRecord` → `claudeUsageObservation(record, file, lineNo)`; для Codex — `codexUsageObservation(raw)`. Подагенты Claude: вызывающий проигрывает их наблюдения с `child: true` (как `indexSessionFile` ~289-310).
  `sliceUsageTimeline`: ledger с окнами, наблюдения главной шкалы, затем потомки через `withDescendants(own, descendants.map(d => ({ ...d.descendant, usage: slice(d.timeline) })))` — тем же способом, что `usageIn` сейчас для Codex; `undefined`, если у главной шкалы нет ни одного наблюдения (как `usage === undefined` сейчас).

- [ ] **Step 1: Падающие тесты**

```ts
it('второй вызов читает только дописанные байты', ...);      // fake reader записывает start каждого open: [0, N]
it('неполная последняя строка не разбирается и ждёт следующего вызова', ...); // offset на конце предыдущей полной строки; после дописывания "\n" запись учтена один раз
it('усечение файла и другой ino строят шкалу заново', ...);   // суммы не удваиваются
it('срез по окнам равен полному перечиту', async () => {
  // фикстура Claude с подагентом и фикстура Codex со сбросом; окна [{from, to}] и открытое [{from, to: null}];
  // expect(sliceUsageTimeline(...)).toEqual((await indexSessionFile(file, root, { subagents, usageWindows })).usage) и то же для indexCodexSession
});
it('файла нет — пустая шкала, срез undefined', ...);
```

- [ ] **Step 2:** `pnpm --filter @parley/core exec vitest run src/work/usage-timeline.test.ts` → FAIL.
- [ ] **Step 3:** Реализовать (чтение кусками ≤ 1 МиБ, carry-буфер для хвоста без `\n`).
- [ ] **Step 4:** тот же прогон → PASS; затем `pnpm --filter @parley/core test` (один процесс) → PASS.
- [ ] **Step 5:** Commit — `feat(core): шкала расхода с дочитыванием хвоста лога и срезом по окнам`.

---

### Task 3: `LogIndex.usageIn` через шкалы

**Files:**
- Modify: `packages/host/src/activity/log-index.ts` (`usageIn` 203-228; кэш `slices` 139-159 остаётся; добавить кэш шкал и кэш обнаружения подагентов)
- Test: `packages/host/src/activity/log-index.test.ts` (блок «usageIn: срез по окнам» ~297-352)

**Interfaces:**
- Consumes: задача 2; `discoverSession(file, root)` (`core/src/discover.ts:137`), `descendantIndexes`, `descendantOf` (`log-index.ts:113-134`), `logKey`.
- Produces: внутри `createLogIndex`: `const timelines = new Map<string, UsageTimeline>()` (LRU, `USAGE_TIMELINE_CACHE_SIZE = 256`, вытеснение самого давнего по использованию) и `const subagentCache = new Map<string, { at: number; subagents: DiscoveredSubagent[] }>()` (`SUBAGENT_DISCOVERY_TTL_MS = 30_000`). `usageIn`: Codex — `extendUsageTimeline` главного файла и файлов `descendantIndexes`, `sliceUsageTimeline` с `descendantOf(child, …)`-ключами; Claude — подагенты из кэша обнаружения (просроченный → `discoverSession` заново), шкалы файлов, срез с `child`-потомками. Кэш `slices` по старому ключу (окна + подпись файлов) остаётся перед этим шагом: при неизменных файлах файлы не трогаются вовсе. Экспортировать константы для тестов.

- [ ] **Step 1: Падающие тесты** (в стиле блока ~297-352: временный корень, фикстуры логов)

```ts
it('дописанный лог читается с прежнего offset, а не целиком', ...);  // через spy на fs createReadStream (vi.spyOn) проверить start > 0 во втором вызове; результат равен прежнему способу
it('новый файл подагента попадает в срез после TTL обнаружения', ...);  // fake timers: до 30 с не виден, после — виден
it('шкалы вытесняются по LRU при 256 файлах', ...);                  // USAGE_TIMELINE_CACHE_SIZE маленький через параметр createLogIndex(roots, { timelineCacheSize: 2 })
```

- [ ] **Step 2:** `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/activity/log-index.test.ts` → FAIL.
- [ ] **Step 3:** Реализовать; `createLogIndex(roots, options?: { timelineCacheSize?; subagentTtlMs?; now? })`.
- [ ] **Step 4:** `pnpm --filter @parley/host exec vitest run src/activity/log-index.test.ts src/rooms/room-usage.test.ts src/activity/activity-service.test.ts` → PASS.
- [ ] **Step 5:** Commit — `perf(host): срез расхода по шкалам с дочитыванием хвоста — usageIn не перечитывает логи`.

---

### Task 4: Чип расхода — минута и Refresh

**Files:**
- Modify: `packages/desktop/src/renderer/components/rooms/RoomUsageChip.tsx` (`ROOM_USAGE_MIN_INTERVAL_MS` :29; эффект 80-98; поповер)
- Modify: `packages/desktop/src/shared/strings.ts` (раздел строк чипа — тот, откуда берётся `U.copied`: добавить `refresh: 'Refresh'`)
- Test: `packages/desktop/src/renderer/components/rooms/RoomUsageChip.test.tsx`

**Interfaces:**
- Produces: `export const ROOM_USAGE_MIN_INTERVAL_MS = 60_000; export const ROOM_USAGE_REFRESH_MIN_MS = 5_000;` Эффект запроса зависит от `[active, supported, connected, identity, composition]` и таймера: пока `active`, повторяет запрос каждые `ROOM_USAGE_MIN_INTERVAL_MS`; `signal` (токены участников) из зависимостей убран. Кнопка **Refresh** в поповере (`S.<раздел>.refresh`) зовёт запрос сразу, но не чаще `ROOM_USAGE_REFRESH_MIN_MS`; во время запроса кнопка `disabled`. «Updated HH:MM» без изменений.

- [ ] **Step 1: Падающие тесты** (fake timers как в файле)

```ts
it('повтор не чаще раза в минуту: через 59 с запроса нет, через 60 — есть', ...);
it('рост токенов участников сам по себе запрос не рождает', ...);     // меняем activity store, advance 5 с → calls не выросли
it('Refresh спрашивает сразу и не чаще раза в 5 с', ...);
```
   Существующий тест «repeat not more often than 10s» переписать под 60 с.
- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/components/rooms/RoomUsageChip.test.tsx src/english-ui.test.ts` → FAIL.
- [ ] **Step 3:** Реализовать. — [ ] **Step 4:** тот же прогон → PASS.
- [ ] **Step 5:** Commit — `feat(desktop): чип расхода комнаты спрашивает раз в минуту и по кнопке Refresh`.

---

### Task 5: `roles.list` — снимок работ и кэш каталога

**Files:**
- Modify: `packages/host/src/methods/roles.ts` (весь файл, 15 строк), `packages/host/src/methods/index.ts` (:216 регистрация)
- Test: `packages/host/src/methods/roles.test.ts`

**Interfaces:**
- Consumes: `WorksService.entry(projectPath, workId)` (`works/works-service.ts:57`), `sessionRoleCatalog`, `roleSummaries` (`core/src/work/agents.ts`).
- Produces:
  ```ts
  export const ROLE_CATALOG_TTL_MS = 60_000;
  export function createRolesList(deps: {
    works: Pick<WorksService, 'entry'>;
    catalog?: typeof sessionRoleCatalog;
    now?: () => number;
    ttlMs?: number;
  }): Handler<'roles.list'>;
  ```
  Сессия — из `deps.works.entry(projectPath, ref.workId)?.map.sessions` (работы нет → `HostError('not_found', 'work is not open')`, сессии нет → прежний `not_found`); `cwd = session.worktree?.path ?? projectPath`. Кэш `Map<cwd, { at: number; value: Promise<RoleList> }>`: живой (`now() - at < ttlMs`) промис отдаётся как есть; отклонённый — удаляется из кэша в `catch`. Регистрация: `'roles.list': createRolesList({ works: deps.works }) as AnyHandler`.

- [ ] **Step 1: Падающие тесты** (как в файле: `catalog` подменяется; добавить fake `works` с `entry`)

```ts
it('сессия берётся из снимка работ, карта с диска не читается', ...);   // vi.spyOn на readMap из @parley/core не вызван / либо works.entry с worktree → catalog получил путь worktree
it('12 одновременных вызовов одного cwd — один вызов каталога', ...);
it('после TTL каталог запрашивается снова, разные cwd — разные записи', ...);  // fake now
it('ошибка каталога не кэшируется: следующий вызов пробует снова', ...);
it('работы нет в снимке — not_found', ...);
```

- [ ] **Step 2:** `pnpm --filter @parley/host exec vitest run src/methods/roles.test.ts` → FAIL.
- [ ] **Step 3:** Реализовать и поправить регистрацию. — [ ] **Step 4:** `pnpm --filter @parley/host exec vitest run src/methods/roles.test.ts src/methods/index.test.ts src/server.test.ts` → PASS.
- [ ] **Step 5:** Commit — `perf(host): roles.list берёт сессию из снимка работ и кэширует каталог ролей по каталогу на минуту`.

---

### Task 6: Стор ролей в окне — один запрос на каталог

**Files:**
- Create: `packages/desktop/src/renderer/store/roles.ts`
- Test: `packages/desktop/src/renderer/store/roles.test.ts`
- Modify: `packages/desktop/src/renderer/lib/role-summary.ts` (`useRoleSummary`, `RoleChipProps`), `packages/desktop/src/renderer/sidebar/SessionRow.tsx` (:308), `packages/desktop/src/renderer/chat/ChatToolbar.tsx` (:249), `packages/desktop/src/renderer/components/rooms/feed-model.ts` (`ParticipantModel` ~53-57, `roleRevision` ~292: добавить `cwd`), `packages/desktop/src/renderer/components/rooms/ParticipantStrip.tsx` (:54), `packages/desktop/src/renderer/components/rooms/PlanPanel.tsx` (:313-322)
- Test: `packages/desktop/src/renderer/lib/role-summary.test.tsx`

**Interfaces:**
- Consumes: образец `chat/capabilities-store.ts` (TTL, `byProject`, `load`, `resetForTests`), `hostMethods` (`lib/capabilities.ts`), `WorkSession.worktree?.path`.
- Produces:
  ```ts
  export const ROLES_STORE_TTL_MS = 60_000;
  export interface RolesEntry { status: 'loading' | 'ready' | 'error'; roles: RoleSummary[]; at: number }
  export interface RolesState {
    byCwd: Record<string, RolesEntry>;
    load(bridge: ParleyBridge, input: { projectPath: string; ref: SessionRef; cwd: string; force?: boolean }): void;
  }
  export const useRolesStore: UseBoundStore<StoreApi<RolesState>>;
  export function resetRolesStoreForTests(): void;
  // role-summary.ts
  export function useRoleSummary(bridge, sessionRef, role, revision = '', cwd?: string): RoleSummary | null;
  export interface RoleChipProps { role; sessionRef?; bridge?; revision?; cwd?: string }
  ```
  `load`: без метода у хоста — ничего; свежая запись (`now - at < TTL`) и не `force` — ничего; в полёте — дедуп; ошибка — `status: 'error'` с прежними ролями. `useRoleSummary`: `cwd ?? sessionRef.projectPath`; при смене `revision` — `load(..., { force: true })`; роль — `byCwd[cwd].roles.find(id)`. Вызовы `RoleChip` в SessionRow, ChatToolbar, PlanPanel передают `cwd={session.worktree?.path ?? projectPath}`; `ParticipantModel` получает `cwd`, ParticipantStrip передаёт его; ProjectPanel и NewSessionOrRoomDialog без изменений.

- [ ] **Step 1: Падающие тесты**

```ts
// roles.test.ts (стор)
it('load по одному cwd — один вызов roles.list, повтор в пределах TTL — ноль', ...);
it('force перечитывает, ошибка оставляет прежние роли со status error', ...);
// role-summary.test.tsx
it('12 чипов одного cwd дают один roles.list', ...);
it('смена revision и cwd перечитывает роли для нового cwd', ...);  // Review Focus 5
```
   Существующие тесты файла, которые ждут 2 вызова, пересмотреть: «rereads the same role after launch/cwd revision» — остаётся 2 (force), «drops lock across participant scope changes» — вызовов по числу разных cwd.
- [ ] **Step 2:** `pnpm --filter @parley/desktop exec vitest run src/renderer/store/roles.test.ts src/renderer/lib/role-summary.test.tsx` → FAIL.
- [ ] **Step 3:** Реализовать стор, хук и места вызова.
- [ ] **Step 4:** `pnpm --filter @parley/desktop exec vitest run src/renderer/store/roles.test.ts src/renderer/lib/role-summary.test.tsx src/renderer/sidebar src/renderer/components/rooms src/renderer/chat/ChatToolbar.test.tsx src/english-ui.test.ts` → PASS.
- [ ] **Step 5:** Commit — `perf(desktop): чипы ролей читают общий стор по рабочему каталогу — один roles.list на каталог`.

---

### Task 7: Проверка группы и CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (раздел `## Unreleased` над `## 0.15.0`; создать, если нет)

- [ ] **Step 1:** `uptime`; при load < 10: `pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host build`, затем по одному процессу: `pnpm --filter @parley/core test`, `pnpm --filter @parley/host test`, `pnpm --filter @parley/desktop test`, `pnpm typecheck`, `pnpm lint`. Упавший файл перегнать отдельно: прошёл — флейк (known: `works-service.serial`, `wake-service` под нагрузкой), не прошёл — чинить в рамках задач 1–6.
- [ ] **Step 2:** CHANGELOG `### Changed` (по-английски): «**Room usage and role chips no longer load the host.** The room usage chip refreshes once a minute (or on Refresh) and the host reads only what was appended to the agents' logs since the last request instead of the whole file; role chips share one request per working directory and the host keeps the role catalog for a minute. A room with seven busy agents kept the host at 60–97 % CPU; now it should stay below 20 %.»
- [ ] **Step 3:** Commit — `docs(changelog): дешёвые rooms.usage и roles.list`.

---

### Task 8: Приёмка на машине автора (руками)

- [ ] **Step 1:** Dev-окно из ветки против обычного `~/.parley` (как для baseline: закрыть Parley.app, `PARLEY_LOGIN_SHELL=skip npx electron out/main/index.js` из `packages/desktop`, «Restart host…»).
- [ ] **Step 2:** Открыть Room 1 с семью живыми участниками на 5 минут, затем Diagnostics → Record 20-second profile.
- [ ] **Step 3:** В архиве: `host: состояние` cpuPct < 20 при открытой комнате; в `actions.jsonl` `rooms.usage` < 500 мс после первого вызова, `roles.list` ≤ 1 на каталог в минуту; в профиле `forEachJsonlRecord`/readline не в верхних строках. Цифры — в раздел «Baseline 2026-10-17» спеки диагностики как «после».
- [ ] **Step 4:** Если cpuPct всё ещё > 20 — профиль покажет следующего кандидата (`handleLogChange`/`recompute`, карта работы); это отдельная спека.
