# Хранилище работ, этап 2 (путь A): карта в SQLite — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** состояние каждой работы живёт в одной базе `~/.parley/parley.db` (SQLite) вместо `map.json` и `works-index.json`. Запись меняет на диске только изменённые строки. Карты переезжают в базу один раз, при старте хоста, со сверкой.

**Architecture (путь A, выбран автором 2026-10-24):** модель `WorkMap` и все мутаторы остаются как есть. Хост по-прежнему держит разобранную карту в кэше. Меняется слой под `readMap`/`updateMap`/`createWork`: карта раскладывается в строки — `works` (заголовок и сама работа) и `entries` (по строке на сессию, письмо, комнату, план и т. д., с JSON записи). `updateMap` в одной транзакции сравнивает JSON записей с прошлым состоянием и пишет только разницу. Кэш сверяется по номеру версии работы в базе, а не по `stat` файла. Хост узнаёт об изменениях из события в процессе и опроса `PRAGMA data_version` — так видны и записи других процессов. `fs.watch` карт и индекса уходит.

**Tech Stack:** TypeScript, `node:sqlite` (`DatabaseSync`), pnpm-монорепо (`@parley/core`, `@parley/host`, `@parley/protocol`, `@parley/desktop`), vitest, Playwright.

**Spec:** `docs/specs/2026-10-23-host-sqlite-storage-design.md` — разделы 2–4, 6.1, 6.2, 6.6, 6.9 (этап 2), 7, 8. Перед этим планом в master влиты план 1 (#107) и план 2 (#108).

## Global Constraints

- Ветка `feat/sqlite-store` от `origin/master` (285ed9e2 или новее) в своём worktree: `git worktree add .claude/worktrees/sqlite-store -b feat/sqlite-store origin/master`, затем `pnpm install --prefer-offline`, `pnpm --filter "@parley/host^..." build` и `pnpm --filter @parley/file-icons build` (без него не пройдёт проверка типов окна).
- **Node ≥ 22.13** — с этой версии `node:sqlite` работает без флага. Корневой `engines.node` → `">=22.13"`. CI (`ci.yml`, `release.yml`) уже на Node 22; приложение везёт 22.23.3 (`fetch-node.mjs:35`).
- **Новых npm-зависимостей нет.** База — встроенный `node:sqlite`.
- Коммиты по-английски, с подписью Co-Authored-By той модели, которая их делает. Комментарии по-русски со ссылкой «спека хранилища N.M». Тексты агентам и окну — по-английски. Названия тестов — на языке блока `describe`.
- Тесты — только затронутых файлов: `pnpm --filter @parley/<pkg> exec vitest run <paths>`. Полный прогон запрещён, мутационные прогоны запрещены. Перед прогоном смотреть `uptime`; при load ≥ 12 ждать. Под нагрузкой флейкают `works-service.test.ts` и `sessions-service.test.ts` — упавший файл перезапустить в одиночку.
- Хост берёт `@parley/core` из `dist`: после правки ядра — `pnpm --filter @parley/core build`.
- Исполнители — Sonnet, задачи строго по одной, облегчённый режим проверок.
- **Решения этого плана** (спека оставила их строителю):
  - драйвер — `node:sqlite`: без нативной сборки под встроенный Node и без шага в упаковке. Предупреждение `ExperimentalWarning` в stderr хоста допустимо;
  - запросы к базе — в главном потоке хоста: операции короткие, разбор целой работы бывает только при промахе кэша. Отдельный поток — потом, по замеру;
  - схема общая на все коллекции: `entries(kind, key, ord, json)`. Колонки под письма (канал, номер, курсоры) появятся в плане 4;
  - процессор при записи по-прежнему тратит время, пропорциональное размеру карты: сериализация записей для сравнения и разбор для кэша. Пропорциональной изменению становится запись на диск. Выгрузку старого из памяти, курсоры и страницы делает план 4;
  - писать в базу могут и CLI `parley-core`, и сессии без канала агента (в них MCP открывает базу сам). SQLite сериализует запись, хост замечает чужие записи по `data_version`. Поэтому перевод CLI на хост (спека 6.8) и отказ таким сессиям (6.5) не нужны для корректности и откладываются;
  - если мутация даёт карту, которую не принимает `normalizeMap`, запись отменяется целиком: транзакция откатывается, вызывающий получает ошибку. Раньше такая карта записывалась на диск и ломала следующее чтение;
  - `map.json.bak`, `map.lock` и `works-index.lock` уходят: целостность держат транзакции и WAL. После переезда остаётся `map.v2.json`;
  - экспорт работы в JSON (спека 6.6) — существующая `parley-core work map`: она читает базу.

## Review Focus

1. **Старая карта с повторяющимися id, схемой v1 или незнакомыми полями верхнего уровня.** Переезд сохраняет всё: собранная из базы карта равна разобранной `map.json`. Тесты — задачи 2 и 5.
2. **Две стороны пишут одну работу** (хост и CLI или MCP без канала). Обновления не теряются, хост видит чужую запись примерно за секунду. Тесты — задачи 3 и 6.
3. **Мутация, которую отвергает `normalizeMap`.** Ничего не записано, кэш цел, вызывающий получил ошибку. Тест — задача 3.
4. **Переезд прерван** между коммитом в базу и переименованием файла. На следующем старте база побеждает, `map.json` переименовывается, второго переезда нет. Тест — задача 5.
5. **Старый хост без `/agent/tools` и новые файлы MCP.** Запасной путь читает базу; если работы там ещё нет, агент получает понятную ошибку «workspace … does not exist», а не падение. Тест — задача 7.

---

### Task 1: База и схема

**Files:**
- Create: `packages/core/src/work/db.ts`, `packages/core/src/work/db.test.ts`
- Modify: `package.json` (`engines.node`)

**Interfaces:**
- Produces:
  - `export const WORK_DB_FILE = 'parley.db'`, `export const WORK_DB_SCHEMA_VERSION = 1`;
  - `export function workDb(): DatabaseSync` — база по пути `path.join(parleyHome(), WORK_DB_FILE)`. Дескриптор кэшируется по пути и открывается заново, когда меняется `parleyHome()` (тесты меняют `PARLEY_HOME` между тестами). При открытии: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`; схема создаётся, если `PRAGMA user_version < 1`;
  - `export function closeWorkDb(): void` — для тестов и остановки хоста.
- Схема:

```sql
CREATE TABLE works (
  project_path TEXT NOT NULL, id TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  work_json TEXT NOT NULL, extra_json TEXT NOT NULL,
  PRIMARY KEY (project_path, id));
CREATE TABLE entries (
  project_path TEXT NOT NULL, work_id TEXT NOT NULL,
  kind TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (project_path, work_id, kind, key),
  FOREIGN KEY (project_path, work_id) REFERENCES works(project_path, id) ON DELETE CASCADE);
CREATE INDEX entries_order ON entries(project_path, work_id, kind, ord);
```

- [ ] **Step 1: Failing tests** (`db.test.ts`, Russian names): база создаётся в `PARLEY_HOME` с WAL и `user_version = 1`; повторное открытие не пересоздаёт схему и сохраняет данные; смена `PARLEY_HOME` открывает другую базу; удаление строки `works` каскадно удаляет её `entries`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @parley/core exec vitest run src/work/db.test.ts`.
- [ ] **Step 3: Implement** `db.ts` по Interfaces; `engines.node` → `">=22.13"`.
- [ ] **Step 4: Run, expect PASS**; затем `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** — `feat(core): add the SQLite work database (node:sqlite, WAL)`.

### Task 2: Раскладка карты в строки и разделение `parseMap`

**Files:**
- Create: `packages/core/src/work/map-rows.ts`, `packages/core/src/work/map-rows.test.ts`
- Modify: `packages/core/src/work/map.ts:339-386` (`parseMap`)

**Interfaces:**
- `map.ts`: `export function parseMapText(raw: string, source: string): unknown` (строки 340-345) и `export function normalizeMap(data: unknown, source: string): WorkMap` (347-385). `parseMap(raw, file)` = `normalizeMap(parseMapText(raw, file), file)`, поведение то же; `map.test.ts` остаётся зелёным без правок ожиданий.
- `map-rows.ts`:
  - `export type EntryKind = 'session' | 'message' | 'room' | 'plan' | 'planExport' | 'decisionExport' | 'planEffect' | 'planBacklogIntent'` и `export const ENTRY_FIELDS: Record<EntryKind, 'sessions' | 'messages' | 'rooms' | 'plans' | 'planExports' | 'decisionExports' | 'planEffects' | 'planBacklogIntents'>`.
  - Естественный ключ: `id` (session, message, room, plan), `file` (planExport), `` `${roomId}/${proposalId}/${rev}` `` (decisionExport), `key` (planEffect, planBacklogIntent). Повтор ключа внутри массива получает суффикс `#2`, `#3` в порядке массива: старые карты не проверяли уникальность id сессий, писем, комнат и экспортов.
  - `export interface StoredRow { kind: EntryKind; key: string; ord: number; json: string }`; `export interface MapRows { work: string; extra: string; rows: StoredRow[] }`. `extra` хранит `schemaVersion`, `resources`, все незнакомые поля верхнего уровня и список присутствовавших необязательных коллекций (`present`), чтобы сборка вернула ровно тот же набор полей. `compact` не хранится.
  - `export function mapToRows(map: WorkMap, previous?: ReadonlyMap<string, StoredRow>): MapRows` — `json` = `JSON.stringify(entry)`. `ord`: прежний `ord` сохраняется, пока порядок прежних ключей не нарушен; новые ключи в конце получают `max + 1`; если порядок изменился или новый ключ встал перед старым — коллекция нумеруется заново с 0.
  - `export function rowsToMap(work: string, extra: string, rows: readonly StoredRow[]): unknown` — сырой объект в порядке `ord` (без `normalizeMap`).
  - `export function rowIndex(rows: readonly StoredRow[]): Map<string, StoredRow>` с ключом `` `${kind}\u0000${key}` ``.
  - `export interface RowsDiff { upserts: StoredRow[]; deletes: { kind: EntryKind; key: string }[]; workChanged: boolean }`; `export function diffRows(previous: { work: string; extra: string; index: ReadonlyMap<string, StoredRow> }, next: MapRows): RowsDiff` — upsert при отличии `json` или `ord`.

- [ ] **Step 1: Failing tests** (`map-rows.test.ts`, Russian names):
  - туда и обратно: `normalizeMap(rowsToMap(mapToRows(m)))` глубоко равна `m` для карты со всеми коллекциями, с незнакомым полем верхнего уровня и без необязательных коллекций;
  - повторяющиеся id писем дают ключи `m-07` и `m-07#2` и оба возвращаются в исходном порядке;
  - добавление письма в конец даёт ровно один upsert;
  - изменение `readBy` одного письма даёт ровно один upsert;
  - удаление сессии из середины даёт один delete и ни одного upsert остальным;
  - перестановка двух комнат даёт перенумерацию только коллекции комнат;
  - изменение `work.title` выставляет `workChanged`.
  - в `map.test.ts`: `parseMap` равна `normalizeMap(parseMapText(...))`, `normalizeMap` идемпотентна.
- [ ] **Step 2: Run, expect FAIL**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — `vitest run src/work/map-rows.test.ts src/work/map.test.ts`.
- [ ] **Step 5: Commit** — `feat(core): lay a workspace map out as database rows and split parseMap`.

### Task 3: `readMap` / `updateMap` / `createWork` на базе

**Files:**
- Modify: `packages/core/src/work/store.ts` (`readMap`, `updateMap`, `createWork`, кэш карт, `backupDue`, `MAP_BACKUP_INTERVAL_MS`, `withLock` для `map.lock`), `packages/core/src/work/store.test.ts`, `packages/core/src/index.ts`
- Delete: `packages/core/test/work-writer.ts` и `work-lock-race.ts` — их заменяет тест с двумя процессами на базе

**Interfaces:**
- Consumes: `workDb`, `mapToRows`, `rowsToMap`, `rowIndex`, `diffRows`, `normalizeMap`.
- Produces (сигнатуры `readMap`, `updateMap`, `createWork` не меняются):
  - кэш: ключ `` `${projectPath}\0${workId}` ``, запись `{ version, map, work, extra, index }`; `MAP_CACHE_LIMIT` и `mapCacheStats` остаются;
  - `readMap`: `SELECT version FROM works WHERE project_path=? AND id=?`. Нет строки — `WorkNotFoundError` (текст с id работы и путём проекта). Версия совпала — отдаётся копия (`structuredClone`). Иначе загрузить строки, собрать `normalizeMap(rowsToMap(...), source)`, положить в кэш, отдать копию;
  - `updateMap`: синхронное тело внутри `BEGIN IMMEDIATE … COMMIT` (при исключении — `ROLLBACK`):
    1. проверить версию; при попадании забрать объект из кэша (удалить запись), иначе загрузить;
    2. `mutate(current)`; `touch` → `updatedAt`;
    3. `normalizeMap(current, source)` — бросает → откат;
    4. `mapToRows(current, index)`, `diffRows`, upsert/delete, `UPDATE works SET title, status, updated_at, work_json, extra_json, version = version + 1`, `COMMIT`;
    5. в кэш — `normalizeMap(rowsToMap(новые строки))`, не тот объект, что возвращается: так кэш равен свежей загрузке;
    6. событие `mapWritten`; вернуть `current`.
  - `export function onMapWritten(listener: (event: { projectPath: string; workId: string; version: number }) => void): () => void`;
  - `export function workExists(projectPath: string, workId: string): boolean`;
  - `export function readStoredMap(projectPath: string, workId: string): WorkMap` — собрать из базы мимо кэша (для тестов и сверки переезда);
  - `export function replaceStoredMap(projectPath: string, workId: string, data: unknown): void` — записать строки из произвольного объекта без `normalizeMap` и поднять версию (для тестов: «чужая запись» и «битая карта»);
  - `createWork`: `INSERT` в `works` (существующая → прежняя ошибка «already exists»), создать каталоги `briefs` и `artifacts`;
  - убрать: `.bak`, `backupDue`, `MAP_BACKUP_INTERVAL_MS`, `map.lock`, `works-index.lock`. Очередь `withLock` убрать, если её больше никто не зовёт (`withSharedProjectLock` и `withLocalHistoryLock` используют `acquireLock` напрямую).

- [ ] **Step 1: Failing tests** — переписать блоки `store.test.ts` про карту, `.bak`, замок и кэш (Russian names):
  - запись письма в работу с 5 000 писем меняет в `entries` ровно одну строку (`SELECT changes()` или подсчёт по `ord`/`json`);
  - `readMap` после `updateMap` в том же процессе — попадание в кэш; после `replaceStoredMap` (чужая запись) — новая версия;
  - мутация, после которой `normalizeMap` бросает (комната с `mode: 'bogus'`), откатывает транзакцию: версия та же, `readStoredMap` без изменений, вызывающий получил ошибку;
  - брошенная мутация не портит кэш;
  - два процесса (дочерний `node` с `updateMap` по 200 записей и родитель с тем же) — в итоге 400 сессий, ни одна не потеряна;
  - отсутствующая работа → `WorkNotFoundError` у `readMap` и `updateMap`;
  - `createWork` дважды с тем же id → прежняя ошибка.
- [ ] **Step 2: Run, expect FAIL** — `vitest run src/work/store.test.ts`.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — `vitest run src/work/store.test.ts src/work/letters.test.ts src/work/rooms.test.ts src/work/map.test.ts`, затем `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** — `feat(core): store workspace maps in SQLite and write only the changed rows`.

### Task 4: Список работ и жизненный цикл на базе

**Files:**
- Modify: `packages/core/src/work/store.ts` (`readWorksIndex`, `withWorksIndex`, `upsert`, `entryOf`, `pruneWorksIndex`, `deleteWorkFiles`, `nextWorkId`, `worksIndexPath`), `packages/core/src/work/letters.ts:66-69`, `packages/core/src/work/works.ts`, `packages/core/src/cli.ts` (текст `work prune`), их тесты

**Interfaces:**
- `readWorksIndex(): Promise<WorksIndex>` — та же форма `{ schemaVersion: 1, works: WorkIndexEntry[] }`, теперь из таблицы `works`; вызывающие (works.ts, works-service, cli, get_map `archive`) не меняются.
- `withWorksIndex` и `upsert` уходят: строку `works` пишет `updateMap`/`createWork`.
- `pruneWorksIndex()`: удаляет работы, чей проект или каталог работы исчез с диска; форма ответа прежняя; текст `work prune` — «remove from the list the workspaces whose project or folder is gone».
- `deleteWorkFiles`: `DELETE FROM works` (каскадом строки) + удаление каталога.
- `nextWorkId`: максимум по таблице `works` плюс прежний пропуск занятых каталогов.
- `worksIndexPath()` остаётся только для переезда (задача 5), читает старый файл.
- `letters.ts`: вместо проверки ENOENT ловить `WorkNotFoundError`.
- `works.ts` `readWorks`: список из `readWorksIndex`, карты — через `readMap` с замороженной копией в своём кэше по версии; `readdir` каталогов `works` уходит. Работа, которую `normalizeMap` не принимает, попадает в список «битых», как сейчас.

- [ ] **Step 1: Failing tests** — `store.test.ts` (prune, delete, nextWorkId), `works.test.ts` (список из базы, битая работа через `replaceStoredMap`), `letters.test.ts:169` (пропавшая работа → `WorkNotFoundError`), `cli-work.test.ts` (list/map/new/session new на базе; сырое чтение `map.json` → `readStoredMap`).
- [ ] **Step 2: Run, expect FAIL**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — `vitest run src/work/ src/cli-work.test.ts`, `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** — `feat(core): keep the workspace list in the database`.

### Task 5: Переезд `map.json` → база

**Files:**
- Create: `packages/core/src/work/migrate-to-db.ts`, `packages/core/src/work/migrate-to-db.test.ts`
- Modify: `packages/core/src/index.ts`; `packages/host/src/host.ts` (вызов при старте); `packages/protocol/src/types.ts:179-181, 218-223` (новый вид notice); окно: `packages/desktop/src/renderer/store/notices.ts`, `AppShell.tsx` (`noticeText`), `strings.ts`

**Interfaces:**
- `export interface MapMigrationResult { migrated: { projectPath: string; workId: string }[]; failed: { projectPath: string; workId: string; reason: string }[]; skipped: { projectPath: string; workId: string; reason: 'busy' }[] }`
- `export async function migrateMapsToDb(options?: { log?: (line: string) => void }): Promise<MapMigrationResult>`
  - Кандидаты: записи старого `works-index.json` (если файл есть) и `map.json` в каталогах `works` каждого известного проекта.
  - Работа занята (есть `map.lock` с живым держателем, как в `busyWork`, migrate.ts:236-273) → `skipped`, попытка на следующем старте.
  - Строки ещё нет → `parseMap(map.json)`, вставка всех строк одной транзакцией, затем сверка: `readStoredMap` глубоко равна разобранной карте, а `unreadFor` каждой сессии и непрочитанное человека совпадают до и после. Сошлось → `COMMIT`, затем `rename map.json → map.v2.json`. Не сошлось или карта битая → `ROLLBACK`, `failed`, файлы не трогаются.
  - Строка уже есть, а `map.json` ещё лежит (переезд прерван после коммита) → `readStoredMap` должна загрузиться; тогда только переименовать файл.
  - Когда в старом индексе не осталось непереехавших работ → `rename works-index.json → works-index.v2.json`.
- Хост: вызвать после переезда дома (`host.ts:842`) и до старта `WorksService` и автозапуска сессий. Для каждого `failed` — `host.notice { kind: 'map-migration-failed', ref: null, text: <путь map.json>, at }`.
- Окно: текст notice — «A workspace couldn't be moved to the new storage; it stays in its old file.»

- [ ] **Step 1: Failing tests** (`migrate-to-db.test.ts`, Russian names; фикстуры — файлы во временном доме и проекте):
  - карта v2 со всеми коллекциями переезжает, `map.v2.json` на месте, `readMap` отдаёт то же;
  - карта v1 переезжает уже в виде v2;
  - карта с повторяющимися id писем сохраняет оба письма;
  - битая `map.json` → `failed`, файл не тронут, строки нет, следующий запуск снова пробует;
  - занятая работа (живой `map.lock`) → `skipped`;
  - прерванный переезд (строка есть, `map.json` есть) → только переименование, без второй вставки;
  - после переезда всех работ индекс переименован.
- [ ] **Step 2: Run, expect FAIL**.
- [ ] **Step 3: Implement** ядро, затем вызов в хосте, notice в протоколе и окне.
- [ ] **Step 4: Run, expect PASS** — ядро `vitest run src/work/migrate-to-db.test.ts`; после сборки ядра и протокола — `pnpm --filter @parley/host exec vitest run src/host-migrate.test.ts` и `pnpm --filter @parley/desktop typecheck`. В `host-migrate.test.ts` добавить тест (English name): хост, стартующий на доме со старой `map.json`, публикует работу в первом `works.changed`, а `map.v2.json` лежит рядом.
- [ ] **Step 5: Commit** — `feat: move workspace maps into the database on host start, with a check`.

### Task 6: Хост узнаёт об изменениях без файлов

**Files:**
- Modify: `packages/host/src/works/works-service.ts` (`ensureWatcher`, `settleRead`, `refreshPass`, `checkCorruption`), `packages/core/src/work/works.ts` (`watchWorks`), `packages/host/src/methods/journal.ts:45-51`, `packages/host/src/methods/backlog.ts:29-45`, `packages/host/src/methods/rooms.ts:106`, `packages/host/src/methods/sessions.ts:104`, `packages/host/src/rooms/rooms-service.ts:58`, `packages/host/src/rooms/history-service.ts:45`, их тесты

**Interfaces:**
- Источник изменений `WorksService`:
  - в процессе — `onMapWritten` (событие ядра), с прежним дебаунсом 75 мс;
  - извне — опрос `PRAGMA data_version` раз в 500 мс; при изменении сравнить `SELECT project_path, id, version FROM works` с прошлым снимком и обновить изменившиеся работы.
  - `fs.watch` карт и индекса уходит; `watchWorks` удаляется или сводится к этому источнику.
- `checkCorruption`: работа, которую не загрузил `normalizeMap`, — прежний `map-corrupt` (один раз на работу).
- Проверки существования (`existsSync(map)`, `lstat(map)`) → `workExists`.
- `journal.freshMap` → `readMap`.
- `backlog.knownMap` → `readMap`; `revision` — `` `${projectPath}:${workId}:${version}` ``. Сырое чтение индекса (backlog.ts:45) → `readWorksIndex`.

- [ ] **Step 1: Failing tests** (`works-service.test.ts` и соседние, English names там, где файл английский):
  - `updateMap` в процессе хоста — `works.changed` и вызов слушателей без `fs.watch`;
  - запись из дочернего процесса (`replaceStoredMap` в отдельном `node`) — слушатели вызваны в течение 2 с;
  - битая работа (`replaceStoredMap` с невалидной комнатой) — один `map-corrupt`;
  - `backlog.take` и `journal` на базе;
  - удалённая работа — «deleted» в history-service.
- [ ] **Step 2: Run, expect FAIL**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter @parley/host exec vitest run src/works/ src/methods/ src/rooms/` (флейки перезапускать по одному).
- [ ] **Step 5: Commit** — `feat(host): learn about map changes from the database instead of file watching`.

### Task 7: Ожидание и сессии без канала — по версии работы

**Files:**
- Modify: `packages/core/src/mcp/watch-map.ts`, `packages/core/src/mcp/inbox-watch.ts`, `packages/core/src/mcp/tools.ts` (`waitFor`), `packages/core/src/mcp/remote-tools.ts:86-95` (комментарий), `packages/core/src/work/guide.ts:108, 582-583`, их тесты

**Interfaces:**
- `waitForMap<T>(identity: () => string | null, probe: Probe<T>, timeoutMs: number, pollMs: number, signal?: AbortSignal, changes?: MapChanges)` — первый аргумент теперь функция идентичности вместо пути файла; `fs.watch` уходит совсем. Поводы — тик опроса и `changes`; проба только при смене идентичности, как сейчас.
- `export function workVersionKey(projectPath: string, workId: string): string | null` в store.ts — `` `${version}` `` или `null`, если работы нет.
- `waitFor` и `watchInbox` передают `() => workVersionKey(context.projectPath, context.workId)`.
- Запасной путь при 404 и сессии без канала работают с базой напрямую; если работы в базе ещё нет — ответ «workspace … does not exist».
- Гид для агентов (английский): карта — память работы, её хранит Parley; читать — только через `get_map`, `read_room`, `check_inbox`; упоминание `map.json` убрать.

- [ ] **Step 1: Failing tests**:
  - `watch-map.test.ts` — идентичность-функция вместо файла; без `changes` будит тик опроса;
  - `inbox-watch.test.ts` — письмо, записанное `updateMap`, звонит без `fs.watch`;
  - `remote-tools.test.ts` — запасной путь на работе, которой нет в базе, отвечает текстом «does not exist».
- [ ] **Step 2: Run, expect FAIL**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run, expect PASS** — `vitest run src/mcp/`, `pnpm --filter @parley/core build`.
- [ ] **Step 5: Commit** — `feat(core): wait on the workspace version instead of the map file`.

### Task 8: Тесты, читавшие и писавшие `map.json`

**Files (по фактам разведки 2026-10-24):**
- core: `server.test.ts` (хелпер `readMapFile` :131 и чтения :1281, :1424, :2257, :2916), `agent-plan-tool.test.ts:74-77`, `legacy-env.test.ts:111`, `launch.test.ts:288-292`, `find-skill.test.ts:64-67`, `metrics.test.ts:433-442`, `thread-binding.test.ts:115-120, 213-217`, `resource-policy.test.ts:383`, `state-dir.test.ts:259-298`, `migrate.test.ts:856`
- host: `methods/works.test.ts:61, 87`, `methods/rooms.test.ts:677`, `methods/journal.test.ts` (хелпер `bloatMap`), `methods/backlog.test.ts:153, 177-178, 200`, `works-service.test.ts:257`, `host-migrate.test.ts`

**Interfaces:**
- Сырое чтение `map.json` → `readStoredMap`; запись «мимо хоста» → `replaceStoredMap`; сравнение байтов или mtime файла («карта не переписана») → сравнение `version` строки `works`.
- Тесты, которые проверяли только файловое поведение (симлинк на `map.json` в backlog, `.bak`), удаляются вместе с поведением, с короткой строкой в отчёте.

- [ ] **Step 1** — по пакету: заменить чтения и записи, прогнать файлы пакета (`vitest run <files>`), убедиться, что ожидания по смыслу не ослаблены.
- [ ] **Step 2: Commit** по пакету — `test(core): read workspace maps from the database in tests`, `test(host): …`.

### Task 9: E2E окна

**Files:** `packages/desktop/e2e/agent-plans.spec.ts` (180, 339-352), `migration.spec.ts:73, 85`, `works-unreadable.spec.ts:37`, а также спеки, читающие `map.json`: archive, parley-integration, agent-skills, room-actions, room-owner. Новый хелпер `packages/desktop/e2e/stored-map.ts`.

**Interfaces:**
- `stored-map.ts`: `readStoredMapE2E(home, projectPath, workId)` и `replaceStoredMapE2E(...)` через `@parley/core` из `dist` с `PARLEY_HOME` теста.
- `migration.spec.ts` становится проверкой переезда: засеянная `map.json` после старта хоста лежит как `map.v2.json`, а работа видна в окне.
- `works-unreadable.spec.ts`: нечитаемый старый `works-index.json` при переезде → прежний `works-unreadable`.

- [ ] **Step 1** — переписать спеки; `pnpm --filter @parley/desktop build`.
- [ ] **Step 2** — прогнать затронутые E2E по одному файлу: `pnpm --filter @parley/desktop exec playwright test e2e/<file>`.
- [ ] **Step 3: Commit** — `test(desktop): seed and read workspaces through the database in e2e`.

### Task 10: Сводная проверка, замер и приёмка

- [ ] **Step 1: Сборки, типы, линт, страж рамки** — `pnpm --filter @parley/file-icons build && pnpm --filter @parley/core build && pnpm --filter @parley/protocol build && pnpm --filter @parley/host build && pnpm --filter @parley/desktop typecheck && pnpm lint && pnpm --filter @parley/core exec vitest run test/frame-check.test.ts`.
- [ ] **Step 2: Тесты затронутых каталогов** — ядро `src/work/ src/mcp/ src/cli-work.test.ts`, хост `src/works/ src/methods/ src/rooms/ src/agent/ src/host-migrate.test.ts`.
- [ ] **Step 3: Замер** — скрипт в scratchpad, не в репозитории: временный дом, работа на 1 000 / 10 000 / 50 000 писем по ~1 КБ. Для каждой — время `updateMap` с одним письмом (медиана из 20), прирост байтов `parley.db` и `-wal` на одно письмо, время первого `readMap` (промах). Ожидание: байты на запись не растут с историей; время записи растёт, но меньше прежнего (было ≈ сериализация, запись и разбор всей карты). Цифры — в текст PR.
- [ ] **Step 4: Приёмка — делает человек.** Перед первым запуском сделать копию `~/.parley` и `.parley` проектов. Запустить dev-окно с отдельным домом на копии настоящих данных (w-0051, w-0045):
  - все работы переехали (`map.v2.json` рядом), письма, сессии и планы на месте, непрочитанное совпадает;
  - комната из трёх агентов обменивается письмами, `wait_for` просыпается;
  - `parley-core work map --work <id>` печатает карту из базы;
  - `host: состояние` — задержка цикла p99 не хуже, чем на плане 2.
- [ ] **Step 5: Текст PR** — суть, решения этого плана, замер, предупреждение для заметок к выпуску: «после установки карты переезжают в `~/.parley/parley.db` при первом старте хоста; откат на старую версию автоматически не поддерживается — работу можно вернуть, переименовав `map.v2.json` в `map.json`».
