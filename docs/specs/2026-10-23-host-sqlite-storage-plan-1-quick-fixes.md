# Хранилище работ, этап 0: быстрые правки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** бэклог перестаёт ломаться на картах больше 1 МиБ, а `updateMap` перестаёт писать полную копию карты в `map.json.bak` при каждой записи.

**Architecture:** две независимые правки на нынешнем формате `map.json`, без смены хранилища. `readSharedFile` получает необязательный потолок; бэклог читает карту с потолком побольше и сохраняет все прежние проверки безопасности. `updateMap` пишет `.bak` только тогда, когда прежняя копия старше 10 минут или её нет.

**Tech Stack:** TypeScript, pnpm-монорепо (`@parley/core`, `@parley/host`), vitest.

**Spec:** `docs/specs/2026-10-23-host-sqlite-storage-design.md`, раздел 6.9, этап 0.

## Global Constraints

- Ветка `fix/map-quick-fixes` от `origin/master` в своём worktree: `git worktree add .claude/worktrees/map-quick-fixes -b fix/map-quick-fixes origin/master`, затем `pnpm install --prefer-offline` и `pnpm --filter @parley/core build`. Локальный `master` может отставать — код сверять с `origin/master`.
- Коммиты — по-английски (`AGENTS.md`): `fix(core): …` / `fix(host): …`, в конце `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Тесты — только затронутых файлов: `pnpm --filter @parley/<pkg> exec vitest run <path>`. Полный `vitest run` и `pnpm -r test` запрещены. Перед прогоном — `uptime`; при load ≥ числа ядер подождать.
- Хост берёт `@parley/core` из `dist/`: после правки ядра — `pnpm --filter @parley/core build`, потом тесты хоста.
- Комментарии — по-русски, со ссылкой «спека хранилища 6.9». Названия тестов — на языке файла: в `store.test.ts` по-русски, в `backlog.test.ts` по-английски.
- Исполнители — Sonnet; две задачи трогают `store.ts`, поэтому идут **по очереди**, не параллельно. Проверки в облегчённом режиме: без мутационных прогонов и переборов.
- **Не входят в этап** (они «по желанию» в спеке, и их снимает этап 2):
  - сброс `content` у записанных `planExports`/`decisionExports` — `content` сравнивается при повторном захвате (`plan-snapshots.ts`, `snapshot-conflict`);
  - удаление завершённых `planEffects` — их `key` защищает от повторной отправки.

## Review Focus

1. **Карта больше 1 МиБ в пути авторов подсказок, а не только в `backlog.take`.** Автор подсказки определяется, как у маленькой карты; тест — задача 1 (`backlog.test.ts`, «projects the author from a map larger than 1 MiB»).
2. **Карта-симлинк после снятия потолка.** Прежние проверки (`realpath`, `O_NOFOLLOW`) по-прежнему отказывают; тест — задача 1 (`backlog.test.ts`, «a symlinked map is still not a target»).
3. **Пропавший `.bak`** (человек удалил). Следующая запись кладёт его сразу, не дожидаясь 10 минут; тест — задача 2.
4. **`.bak` с mtime в будущем** (часы сдвинули назад). Копия не застревает навсегда; тест — задача 2.
5. **Битая карта.** `.bak` по-прежнему хранит последнюю хорошую версию: прежний тест `store.test.ts` «битую карту не переписываем, а .bak хранит прежнюю версию» остаётся зелёным без правок.

---

### Task 1: Бэклог читает большие карты

**Files:**
- Modify: `packages/core/src/work/store.ts:670-700` (`SHARED_FILE_LIMIT`, `readSharedFile`, `readSharedFileOnce`)
- Modify: `packages/core/src/index.ts:620` (экспорт новой константы)
- Modify: `packages/host/src/methods/backlog.ts:29-37` (`knownMap`)
- Test: `packages/core/src/work/store.test.ts` (блок `shared storage primitives`)
- Test: `packages/host/src/methods/backlog.test.ts`

**Interfaces:**
- Produces: `readSharedFile(file: string, limit?: number): Promise<SharedFileSnapshot>` — `limit` по умолчанию `SHARED_FILE_LIMIT` (1 МиБ), поведение без второго аргумента прежнее; `export const MAP_SNAPSHOT_LIMIT = 256 * 1024 * 1024` из `store.ts` и `@parley/core`.
- `writeSharedFile` не меняется: его потолок 1 МиБ относится к общим файлам проекта, не к картам.

- [ ] **Step 1: Write the failing core test** — в `store.test.ts`, блок `shared storage primitives`:

```ts
it('reads past the default bound only when the caller raises it', async () => {
  const file = path.join(project, 'big.json');
  await writeFile(file, 'x'.repeat(2 * 1024 * 1024));
  await expect(readSharedFile(file)).rejects.toMatchObject({ code: 'shared-file-too-large' });
  const snapshot = await readSharedFile(file, MAP_SNAPSHOT_LIMIT);
  expect(snapshot.text).toHaveLength(2 * 1024 * 1024);
  await expect(readSharedFile(file, 1024)).rejects.toMatchObject({ code: 'shared-file-too-large' });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`MAP_SNAPSHOT_LIMIT` не экспортирован / второй аргумент игнорируется)

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts -t "raises it"`
Expected: FAIL

- [ ] **Step 3: Implement** `readSharedFile(file, limit = SHARED_FILE_LIMIT)` и `readSharedFileOnce(file, limit)` — сравнение `before.size > BigInt(limit)`; объявить и экспортировать `MAP_SNAPSHOT_LIMIT`, добавить его в экспорт `core/src/index.ts:620`. Комментарий: карта — свой файл Parley, общий потолок 1 МиБ для неё не годится (спека хранилища 6.9).

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts`
Expected: PASS, включая прежний «bounds regular-file reads…» (потолок по умолчанию не изменился)

- [ ] **Step 5: Write the failing host tests** — в `backlog.test.ts`, внутри `describe('human backlog handlers')`, хелпер и три теста:

```ts
async function padPastOneMiB(workId: string, roomId: string): Promise<void> {
  await updateMap(project, workId, map => {
    for (let i = 0; i < 300; i++) addMessage(map, { from: 'human', to: [], roomId, text: 'x'.repeat(4000) });
  });
  expect((await stat(workPaths(project, workId).map)).size).toBeGreaterThan(1024 * 1024);
}

it('take reaches a live room of a map larger than 1 MiB', async () => {
  const created = await target(); await padPastOneMiB(created.workId, created.roomId);
  const added = await add(); const id = added.items[0]!.id!;
  const marked = await handlers['backlog.take']({ projectPath: project, id, version: added.version, target: created });
  expect(marked.items[0]!.taken).toBe(`${created.workId}/${created.roomId}`);
});

it('projects the author from a map larger than 1 MiB', async () => {
  const created = await target(); await padPastOneMiB(created.workId, created.roomId);
  const session = (await readMap(project, created.workId)).sessions[0]!;
  await handlers['backlog.preferences.set']({ projectPath: project, rule: 'ask' });
  await suggestBacklog(project, { kind: 'idea', title: 'Suggestion', why: 'Consider', workId: created.workId, sessionId: session.id });
  expect((await get()).suggestions[0]!.author).toMatchObject({ workId: created.workId, sessionId: session.id, label: 'Reviewer' });
});

it('a symlinked map is still not a target', async () => {
  const created = await target(); const map = workPaths(project, created.workId).map;
  const copy = path.join(root, 'elsewhere.json'); await writeFile(copy, await readFile(map, 'utf8'));
  await rm(map); await symlink(copy, map);
  const added = await add(); const id = added.items[0]!.id!;
  await expect(handlers['backlog.take']({ projectPath: project, id, version: added.version, target: created }))
    .rejects.toMatchObject({ code: 'not_found' });
  expect((await get()).items[0]!.taken).toBeUndefined();
});
```

  Импорты: `addMessage` из `@parley/core`; `stat`, `symlink` из `node:fs/promises`.

- [ ] **Step 6: Run, expect FAIL** на первых двух (третий может пройти уже сейчас — это страховка, не новая логика)

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host exec vitest run src/methods/backlog.test.ts`
Expected: FAIL — take отвечает `code: 'not_found'` («An active target workspace is required.»), у второго `author` undefined

- [ ] **Step 7: Implement** — в `knownMap` (`backlog.ts:33`) `readSharedFile(file, MAP_SNAPSHOT_LIMIT)`; остальные проверки (`realpath`, `map.work.id`, `sessions.length > 100_000`) не трогать.

- [ ] **Step 8: Run, expect PASS**

Run: `pnpm --filter @parley/host exec vitest run src/methods/backlog.test.ts src/methods/backlog-auth.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/work/store.ts packages/core/src/work/store.test.ts packages/core/src/index.ts packages/host/src/methods/backlog.ts packages/host/src/methods/backlog.test.ts
git commit -m "fix(host): let the backlog read workspace maps larger than 1 MiB"
```

### Task 2: `.bak` не чаще раза в 10 минут

**Files:**
- Modify: `packages/core/src/work/store.ts:517-562` (`updateMap`), рядом — константа и хелпер
- Modify: `packages/core/src/work/letters.ts:61` (комментарий «updateMap пишет индекс, .bak и карту всегда»)
- Test: `packages/core/src/work/store.test.ts` (блок с «пишет карту, кладёт прежнюю версию в .bak…», около строки 312)

**Interfaces:**
- Consumes: ничего из задачи 1.
- Produces: `export const MAP_BACKUP_INTERVAL_MS = 10 * 60 * 1000` в `store.ts`; внутренний `backupDue(file: string, now: number): Promise<boolean>`: `true`, если файла нет (`ENOENT`) или `Math.abs(now - mtimeMs) >= MAP_BACKUP_INTERVAL_MS`.
- `createWork` по-прежнему кладёт `.bak` сразу (`store.ts:498-499`).

- [ ] **Step 1: Write the failing tests** — рядом с «пишет карту, кладёт прежнюю версию в .bak…»:

```ts
it('вторая запись в течение 10 минут не переписывает .bak', async () => {
  await createWork(project, { title: 'Авторизация' });
  const paths = workPaths(project, 'w-0001');
  const created = await readFile(paths.map, 'utf8');
  await updateMap(project, 'w-0001', (map) => { map.work.title = 'Первая'; });
  await updateMap(project, 'w-0001', (map) => { map.work.title = 'Вторая'; });
  expect(await readFile(paths.bak, 'utf8')).toBe(created);
});

it('копия старше 10 минут обновляется: в ней версия перед этой записью', async () => {
  await createWork(project, { title: 'Авторизация' });
  const paths = workPaths(project, 'w-0001');
  await updateMap(project, 'w-0001', (map) => { map.work.title = 'Первая'; });
  const before = await readFile(paths.map, 'utf8');
  const old = new Date(Date.now() - 11 * 60 * 1000); await utimes(paths.bak, old, old);
  await updateMap(project, 'w-0001', (map) => { map.work.title = 'Вторая'; });
  expect(await readFile(paths.bak, 'utf8')).toBe(before);
});

it('пропавший .bak кладётся следующей записью', async () => {
  await createWork(project, { title: 'Авторизация' });
  const paths = workPaths(project, 'w-0001');
  await rm(paths.bak);
  const before = await readFile(paths.map, 'utf8');
  await updateMap(project, 'w-0001', (map) => { map.work.title = 'Первая'; });
  expect(await readFile(paths.bak, 'utf8')).toBe(before);
});

it('.bak из будущего (часы сдвинули) не застревает', async () => {
  await createWork(project, { title: 'Авторизация' });
  const paths = workPaths(project, 'w-0001');
  const future = new Date(Date.now() + 60 * 60 * 1000); await utimes(paths.bak, future, future);
  const before = await readFile(paths.map, 'utf8');
  await updateMap(project, 'w-0001', (map) => { map.work.title = 'Первая'; });
  expect(await readFile(paths.bak, 'utf8')).toBe(before);
});
```

- [ ] **Step 2: Run, expect FAIL** на первом (сейчас `.bak` переписывается каждой записью); остальные три могут пройти уже сейчас

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts -t "bak"`
Expected: FAIL — «вторая запись в течение 10 минут не переписывает .bak»

- [ ] **Step 3: Implement** — в `updateMap` заменить безусловный `writeFile(paths.bak, raw, 'utf8')` (`store.ts:555`) на запись только при `await backupDue(paths.bak, Date.now())`; хелпер — `stat` с разбором `ENOENT`. Обновить doc-комментарий `updateMap` (`store.ts:506-510`) и комментарий в `letters.ts:61`: копия кладётся не чаще раза в `MAP_BACKUP_INTERVAL_MS` (спека хранилища 6.9).

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts src/work/letters.test.ts`
Expected: PASS, включая прежние «кладёт map.json.bak сразу…», «пишет карту, кладёт прежнюю версию в .bak…», «битую карту не переписываем…» и «после записи в каталоге работы не остаётся временных файлов»

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/work/store.ts packages/core/src/work/store.test.ts packages/core/src/work/letters.ts
git commit -m "fix(core): write map.json.bak at most once per ten minutes"
```

### Task 3: Сводная проверка ветки

**Files:** без правок. `CHANGELOG.md` не трогаем: записи собираются при подготовке выпуска по списку PR.

- [ ] **Step 1: Сборки и линт**

Run: `pnpm --filter @parley/core build && pnpm --filter @parley/host build && pnpm lint`
Expected: без ошибок

- [ ] **Step 2: Тесты затронутых файлов ещё раз, одним прогоном на пакет**

Run: `pnpm --filter @parley/core exec vitest run src/work/store.test.ts src/work/letters.test.ts && pnpm --filter @parley/host exec vitest run src/methods/backlog.test.ts src/methods/backlog-auth.test.ts`
Expected: PASS

- [ ] **Step 3: Текст для PR** (по-английски) — две строки для будущей записи в CHANGELOG: «The backlog no longer refuses to take an item into a workspace whose map is larger than 1 MiB.» и «Workspace map writes no longer copy the whole previous map to `map.json.bak` every time; the backup is refreshed at most once per ten minutes.»
