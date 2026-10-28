# Руки помощника, план 1: глаза — обзор без потерь и инструменты чтения

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** помощник видит каждую открытую работу, комнату и сессию в обзоре, находит их по словам человека и читает комнату и историю сессии целиком, в том числе закрытые и архивные.

**Architecture:** изменения только в хосте, в каталоге `packages/host/src/assistant/`, и в списке инструментов MCP помощника в `packages/core`. Обзор (`overview.ts`) сжимает описания по ступеням и больше не выкидывает работы. Три новых модуля чтения — чистые функции над снимком работ, письмами и лентой: `find.ts`, `room-page.ts`, `session-history.ts`. Сервис помощника подключает их тремя новыми инструментами. План 2 (`2026-10-28-assistant-hands-plan-2-hands.md`) строится поверх этого.

**Tech Stack:** TypeScript, Node ≥ 22.16, vitest, MCP SDK (`@modelcontextprotocol/sdk`).

**Spec:** `docs/specs/2026-10-28-assistant-hands-design.md` (утверждена автором 2026-10-28). Ссылки «спека N.M» ниже ведут на неё. Этот план — её разделы 4, 5, 7 (часть про чтение) и 8.

## Global Constraints

- Ветка `feat/assistant-hands`, worktree `.claude/worktrees/assistant-hands`, основа — `origin/master` 2966d9e8. Локальный `master` отстаёт; код сверять с `origin/master`.
- По-английски пишутся:
  - сообщения коммитов, имена веток и тексты PR;
  - тексты для модели (ответы инструментов, ошибки, описания инструментов) и строки окна.

  По-русски пишутся комментарии в коде и имена тестов, как в соседних файлах.
- Каждое сообщение коммита кончается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Кириллицу в строковых литералах ловят тесты `core/src/english-text.test.ts` (core и protocol) и `host/src/english-text.test.ts` (host). Если без неё не обойтись, строку помечают `// cyrillic-ok: <почему>` на той же строке.
- Слова состояний сессий берутся только из `@parley/core` (`sessionDotStateWithNeed`, `stateWord`, `needWord`), своих правил нет (память «статусы из одного места»).
- Помощник ничего не пишет на диск сам (спека 9). Новые инструменты этого плана — только чтение, с `annotations: { readOnlyHint: true }`.
- Перед запуском тестов смотреть `uptime`. При load ≥ числа ядер — подождать.
- Тесты пакета запускаются так: `pnpm --filter @parley/host exec vitest run <путь от packages/host>`, для core — `pnpm --filter @parley/core exec vitest run …`. Если в worktree нет `node_modules`, сначала нужен `pnpm install`, тоже после проверки нагрузки.
- Числа из спеки:
  - бюджет обзора — 12 000 знаков (мягкий);
  - находок `parley_find` — до 20;
  - письмо и запись истории — до 4000 знаков;
  - по умолчанию 30 писем и 20 записей;
  - ход помощника — 180 с.

## Review Focus

1. **Пустой или пробельный `query` в `parley_find`.** Ответ — 400 `query is empty`, а не список всего подряд. Тест — в задаче 6.
2. **Комната без писем, а также страница, которая дошла до начала.** Курсора нет, в конце строка `This is the beginning of the room.` Тест — в задаче 4.
3. **Курсор `before` сессии, которого уже нет в кольце ленты** (старые записи вытеснены). Ответ — ошибка с советом вызвать без `before`, а не пустая страница. Тест — в задаче 5.
4. **Закрытая сессия, у которой журнал ещё не прочитан** (пустая лента). Ответ — шапка и `No history for this session yet.`, а не ошибка. Тест — в задаче 5.
5. **Имя проекта совпало с названием работы другого проекта** (проект `parley` и работа «Parley»). Побеждает название работы, имя проекта — только запасной путь, без молчаливого выбора между двумя проектами. Тест — в задаче 2.

---

### Task 1: Обзор без потерь

**Files:**
- Modify: `packages/host/src/assistant/overview.ts` (`OverviewSource`, `sessionLine`, строка комнаты и срез в `overviewText`, строки 39–231)
- Test: `packages/host/src/assistant/overview.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `export const OVERVIEW_BUDGET = 12_000`.
  - `overviewText(source: OverviewSource, maxChars = OVERVIEW_BUDGET): string` — всегда все открытые работы.
  - `OverviewSource.home?: string`: домашняя папка пользователя для `~`, нет — путь как есть.
  - `export function projectLabel(entries: readonly WorkEntry[], projectPath: string, home?: string): string`. Обычно это имя папки (`scanum`). Если среди `entries` (любого статуса) есть другой `projectPath` с тем же именем папки — `scanum in ~/Desktop`, где родительская папка дана с заменой `home` на `~`.
  - `export const projectName = (projectPath: string): string` — уже есть, сделать экспортом.

Ступени сжатия (спека 4) — внутренний параметр `level: 0 | 1 | 2 | 3` у `sessionLine` и строки комнаты:

| level | Сессии | Комнаты |
|---|---|---|
| 0 | как сейчас | как сейчас |
| 1 | без `task:` и `summary:` у состояний, кроме `working`, `blocked`, `unseen` | как сейчас |
| 2 | без `task:` и `summary:` у всех, кроме `blocked` | как сейчас |
| 3 | не `blocked`: `  Session <label> [session:…] <provider> · <слово состояния>` и ` · in room "<title>"`, если состоит в комнате | без `proposal`: `  Room "<title>" [room:…]: N members, M working` и `, K need the person` при K > 0; с `proposal` — полная строка |

`overviewText` строит блоки работ один раз в нынешнем порядке. Дальше собирает текст на уровне 0, 1, 2 и отдаёт первый, что влез в `maxChars`, иначе — уровень 3 целиком. Строки `…N more works not shown` больше нет. После выбранного текста (бюджет его не считает) идёт строка о скрытом:

```
Also 4 closed sessions, 2 archived rooms, 1 archived work — use parley_find with include_closed to see them.
```

Как считать скрытое:
- закрытые сессии — только в открытых работах;
- архивные комнаты — в открытых работах;
- архивные работы — по одной на работу.

Части с нулём опускаются, единственное число — `1 closed session`, `1 archived room`. Если скрытого нет, строки нет. Если открытых работ нет, текст `No works are open in Parley right now.`, а за ним строка о скрытом, если оно есть. Строка работы: `Work "<title>" [work:…] (project <projectLabel>)`.

- [ ] **Step 1: Write the failing tests** в `describe('overviewText')` файла `overview.test.ts`. Существующий тест `'длинный снимок срезается по работам с пометкой'` (строка 160) заменить первым из новых.

Фикстура `src` — 12 работ `w-1…w-12`, в каждой:
- 8 сессий `s-01…s-08` с `task` в 150 знаков (`task of <label>…`) и `summary` в 200;
- активность: s-03 «S03 Ruslan» — `working`, s-05 «S05 Vera» — `idle`, s-07 «S07 Lena» — `live('blocked', 'Bash: rm')`, остальные — `idle`;
- комнаты: r-1 «Auth» с участниками s-03, s-05, s-07; r-2 с `proposal` (решение ведущего); r-3 без участников.

Фикстура `hiddenSrc` — одна открытая работа с закрытой сессией и архивной комнатой и одна архивная работа.

```ts
// 12 работ по 8 сессий (task 150 знаков, summary 200) и 3 комнаты; s-07 каждой работы — blocked.
it('обзор без потерь: 12 работ по 8 сессий и 3 комнаты — все id в тексте', () => {
  const text = overviewText(src);
  for (const target of targetsOf(src)) expect(text).toContain(`[${target.id}]`);
  expect(text).not.toContain('not shown');
});
it('ступень 1: у простаивающих нет task, у работающих есть', () => {
  const full = overviewText(src, Number.POSITIVE_INFINITY);
  const one = overviewText(src, full.length - 1);
  expect(one).toContain('task: task of S03 Ruslan'); // working
  expect(one).not.toContain('task: task of S05 Vera'); // idle
});
it('ступень 2: task остаётся только у ждущих человека', () => {
  const one = overviewText(src, overviewText(src, Number.POSITIVE_INFINITY).length - 1);
  const two = overviewText(src, one.length - 1);
  expect(two).not.toContain('task: task of S03 Ruslan');
  expect(two).toContain('task: task of S07 Lena');
});
it('ступень 3: сжатые строки, ждущие и решения ведущих — целиком', () => {
  const three = overviewText(src, 1);
  expect(three).toMatch(/^  Session S05 Vera \[session:[0-9a-f]{6}:w-1:s-05\] claude · idle · in room "Auth"$/m);
  expect(three).toMatch(/^  Room "Auth" \[room:[0-9a-f]{6}:w-1:r-1\]: 3 members, 1 working, 1 need the person$/m);
  expect(three).toContain('waiting for: Bash: rm');
  expect(three).toContain('waits: decision from');
});
it('строка о скрытом: закрытые, архивные комнаты и работы', () => {
  expect(overviewText(hiddenSrc)).toMatch(/Also 1 closed session, 1 archived room, 1 archived work — use parley_find with include_closed/);
  expect(overviewText(src)).not.toContain('Also ');
});
it('две папки с одним именем — у работы родительская папка', () => {
  const text = overviewText({ ...source([entry('/u/me/Desktop/scanum', 'w-1', 'A'), entry('/u/me/work/scanum', 'w-2', 'B')], {}), home: '/u/me' });
  expect(text).toContain('(project scanum in ~/Desktop)');
  expect(text).toContain('(project scanum in ~/work)');
  expect(overviewText(source([entry('/p/parley', 'w-1', 'A')], {}))).toContain('(project parley)');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/overview.test.ts`
Expected: FAIL. Среди упавших — «обзор без потерь…» (в тексте `not shown`) и «две папки…».

- [ ] **Step 3: Implement** ступени, строку о скрытом и `projectLabel` в `overview.ts`. `detailText` работы зовёт `overviewText` с одной работой и не меняется.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/overview.test.ts`
Expected: PASS, все тесты файла.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/overview.ts packages/host/src/assistant/overview.test.ts
git commit -m "feat(host): list every open work, room and session in the assistant overview"
```

### Task 2: Цели — скрытые, по имени проекта, строки и шапка комнаты

**Files:**
- Modify: `packages/host/src/assistant/overview.ts` (`AssistantTarget`, `targetsOf`, `resolveTarget`, комнатная часть `detailText`)
- Test: `packages/host/src/assistant/overview.test.ts`

**Interfaces:**
- Consumes: `projectName`, `projectLabel` из задачи 1.
- Produces:
  - `AssistantTarget`: каждый вид получает необязательное `hidden?: 'closed' | 'archived'`.
  - `targetsOf(source: OverviewSource, options?: { hidden?: boolean }): AssistantTarget[]`:
    - без опции — как сейчас;
    - с `hidden: true` — ещё и архивные работы со всеми их комнатами и сессиями (все с `hidden: 'archived'`), архивные комнаты открытых работ (`'archived'`) и закрытые сессии открытых работ (`'closed'`).
  - `resolveTarget(targets, wanted, options?: { hidden?: readonly AssistantTarget[] }): { target: AssistantTarget } | { error: string }`. Порядок поиска:
    1. id;
    2. имя и первое слово имени, как сейчас;
    3. запасной путь — имя папки проекта (без учёта регистра) у целей-работ. Одна открытая работа в одном проекте — она. Несколько работ или два проекта с таким именем — ошибка со списком `work:… (<title>, <where>)`;
    4. если ничего не нашлось и передан `hidden` — точный id или точное полное имя (без учёта регистра) среди скрытых, и цель возвращается со своим `hidden`.

    Текст «не найдено»: `No work, room or session "<key>". Call parley_overview for the current ids, or parley_find to search.`
  - `export function briefLine(source: OverviewSource, target: AssistantTarget): string` — одна строка с id:
    - работа: `Work "<title>" [work:…] (project <projectLabel>)`;
    - комната: `Room "<title>" [room:…] in <where>`;
    - сессия: `Session <label> [session:…] <provider> · <слово состояния> · in <where>`;
    - в конце ` · role <name>`, если у сессии есть роль, и ` · archived` у целей с `hidden: 'archived'`. У закрытой сессии пометки нет: слово состояния уже `closed`.
  - `export function roomHeader(source: OverviewSource, entry: WorkEntry, roomId: string, where: string): string[]` — строки шапки, которые сейчас пишет комнатная часть `detailText`: участники, решение ведущего, план и его пункты. `detailText` комнаты начинает с них.

- [ ] **Step 1: Write the failing tests** в `describe('targetsOf и resolveTarget')`

```ts
it('hidden: true — архивные и закрытые с пометкой', () => {
  const targets = targetsOf(source([archived, roomArchived], {}), { hidden: true });
  expect(targets.filter((t) => t.hidden === 'archived').map((t) => t.kind)).toEqual(expect.arrayContaining(['work', 'room']));
  expect(targets.find((t) => t.kind === 'session' && t.hidden === 'closed')).toBeDefined();
});
it('имя проекта — запасной путь к его единственной работе', () => {
  const targets = targetsOf(source([entry('/u/scanum', 'w-1', 'Billing')], {}));
  expect(resolveTarget(targets, 'Scanum')).toMatchObject({ target: { kind: 'work', name: 'Billing' } });
});
it('название работы побеждает имя проекта другого проекта', () => {
  const targets = targetsOf(source([entry('/u/parley', 'w-1', 'Site'), entry('/u/other', 'w-2', 'Parley')], {}));
  expect(resolveTarget(targets, 'parley')).toMatchObject({ target: { kind: 'work', name: 'Parley' } });
});
it('проект с двумя работами — ошибка со списком', () => {
  const targets = targetsOf(source([entry('/u/scanum', 'w-1', 'A'), entry('/u/scanum', 'w-2', 'B')], {}));
  expect(resolveTarget(targets, 'scanum')).toMatchObject({ error: expect.stringMatching(/several works.*work:/) });
});
it('скрытая цель — только по id или полному имени и с пометкой', () => {
  const src = source([roomArchived], {});
  const hidden = targetsOf(src, { hidden: true }).filter((t) => t.hidden !== undefined);
  const closed = hidden.find((t) => t.kind === 'session')!;
  expect(resolveTarget(targetsOf(src), closed.id, { hidden })).toEqual({ target: closed });
  expect(resolveTarget(targetsOf(src), 'S03 Ruslan', { hidden })).toMatchObject({ target: { hidden: 'closed' } });
  expect(resolveTarget(targetsOf(src), 'S03 Ruslan')).toMatchObject({ error: expect.stringContaining('parley_find') });
});
it('briefLine сессии — состояние, где, роль и пометка', () => {
  // у s-03 роль { source: 'builtin', name: 'Reviewer' }, lifecycle closed
  expect(briefLine(src, closedTarget)).toMatch(/^Session S03 Ruslan \[session:[^\]]+\] claude · closed · in B · b · role Reviewer$/);
  expect(briefLine(src, archivedRoomTarget)).toMatch(/^Room "Gone" \[room:[^\]]+\] in B · b · archived$/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/overview.test.ts`
Expected: FAIL — `briefLine` не экспортирован, `hidden` нет.

- [ ] **Step 3: Implement** в `overview.ts`. `detailText` комнаты строится из `roomHeader` и хвоста писем, как сейчас, и выводит то же, что и до правки.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/overview.test.ts src/assistant/assistant-service.test.ts`
Expected: PASS. Старые тесты `detailText` и сервиса не меняются.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/overview.ts packages/host/src/assistant/overview.test.ts
git commit -m "feat(host): resolve assistant targets by project name and reach closed and archived ones"
```

### Task 3: `parley_find` — поиск по словам человека

**Files:**
- Create: `packages/host/src/assistant/find.ts`
- Test: `packages/host/src/assistant/find.test.ts`

**Interfaces:**
- Consumes: `targetsOf(source, { hidden })`, `briefLine`, `projectName` из задач 1–2.
- Produces:
  - `export function soundKey(text: string): string` — «звучание» строки.
  - `export function findText(source: OverviewSource, query: string, options: { includeClosed: boolean }): string` — ответ инструмента. Пустой `query` проверяет вызывающий (задача 6).

Поля поиска (спека 5.1):
- работа — название и имя папки проекта;
- комната — название;
- сессия — ярлык (`participantLabel`), `role?.name`, `task`, `summary`.

Совпадение — подстрока без учёта регистра. Если прямых совпадений нет, второй проход идёт по `soundKey(поле).includes(soundKey(query))` при непустом `soundKey(query)`.

Порядок находок:
1. точные: имя цели, а у работы ещё и имя папки, равно запросу без учёта регистра;
2. остальные — в порядке `targetsOf`.

Строка находки — `briefLine`. Если совпало `task` или `summary`, к ней приписывается ` — matched task: <первые 120 знаков>` или `matched summary: …`. Ответ — до 20 строк. Дальше `…and N more; say more precisely.`, при пустом итоге — `Nothing found for "<query>".`

`soundKey` — ровно так, по шагам:
1. нижний регистр, `ё` → `е`;
2. кириллица в латиницу таблицей: а a, б b, в v, г g, д d, е e, ж zh, з z, и i, й i, к k, л l, м m, н n, о o, п p, р r, с s, т t, у u, ф f, х h, ц ts, ч ch, ш sh, щ sch, ъ —, ы y, ь —, э e, ю yu, я ya;
3. убрать всё, кроме `[a-z0-9]`;
4. `ph` → `f`, `x` → `ks`, затем `c` и `q` → `k`, `w` → `v`, `y` → `i`;
5. подряд идущие одинаковые буквы — одна.

- [ ] **Step 1: Write the failing tests** (`find.test.ts`; фабрики `entry`/`session`/`source` — как в `overview.test.ts`, переписать в файл)

```ts
describe('soundKey', () => {
  it('«Сканум» и scanum звучат одинаково', () => {
    expect(soundKey('Сканум')).toBe('skanum');
    expect(soundKey('scanum')).toBe('skanum');
    expect(soundKey('Парлей')).toBe(soundKey('Parley'));
    expect(soundKey('my-harnas')).toBe('miharnas');
  });
});
describe('findText', () => {
  it('по имени проекта — работа', () => {
    expect(findText(src, 'scanum', { includeClosed: false })).toMatch(/^Work "Billing" \[work:[^\]]+\] \(project scanum\)$/m);
  });
  it('«Сканум» находит проект scanum по звучанию', () => {
    expect(findText(src, 'Сканум', { includeClosed: false })).toContain('(project scanum)');
  });
  it('по роли и по задаче — сессия, с пометкой совпавшего поля', () => {
    expect(findText(src, 'reviewer', { includeClosed: false })).toMatch(/Session S03 Ruslan .* · role Reviewer/);
    expect(findText(src, 'safari', { includeClosed: false })).toMatch(/Session S05 Vera .* — matched task: fix Safari login/);
  });
  it('закрытые — только с include_closed и с пометкой', () => {
    expect(findText(src, 'S09', { includeClosed: false })).toBe('Nothing found for "S09".');
    expect(findText(src, 'S09', { includeClosed: true })).toMatch(/^Session S09 Old \[[^\]]+\] claude · closed · /m);
  });
  it('точное имя — первым', () => {
    // работа «Auth» и сессия с task «auth refactor»
    expect(findText(src, 'auth', { includeClosed: false }).split('\n')[0]).toMatch(/^Room "Auth"/);
  });
  it('больше 20 — 20 строк и хвост', () => {
    const lines = findText(manySrc, 'task', { includeClosed: false }).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toMatch(/^…and \d+ more; say more precisely\.$/);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/find.test.ts`
Expected: FAIL — модуля `./find.js` нет.

- [ ] **Step 3: Implement** `soundKey` и `findText` в `find.ts`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/find.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/find.ts packages/host/src/assistant/find.test.ts
git commit -m "feat(host): find works, rooms and sessions by the words the person used"
```

### Task 4: `parley_room` — комната целиком, страницами назад

**Files:**
- Create: `packages/host/src/assistant/room-page.ts`
- Test: `packages/host/src/assistant/room-page.test.ts`

**Interfaces:**
- Consumes: `roomHeader` из задачи 2. Тип `Message` из `@parley/core`, его поля — `id` (`m-NN`), `from`, `kind`, `at`, `text`.
- Produces:
  - `export type LetterPage = (entry: WorkEntry, roomId: string, query: { beforeSeq?: number; limit: number }) => readonly Message[]` — страница писем от новых к старым (сервис зовёт `readLetters(…, { roomId, beforeSeq, limit, newestFirst: true })`).
  - `export function roomPageText(source: OverviewSource, target: Extract<AssistantTarget, { kind: 'room' }>, page: { before?: number; limit?: number }, read: LetterPage): string`.
  - `export const ROOM_PAGE = 30`, `ROOM_PAGE_MAX = 50`, `LETTER_MAX = 4000`, `PAGE_BUDGET = 40_000`.

Вид ответа:

```
<строки roomHeader>
Messages, oldest first:
[m-12 · 2026-10-28T11:02:31.000Z · S03 Ruslan · note]
<полный текст, до 4000 знаков, длиннее — первые 3999 и «…»>
…
Older messages: call parley_room with before=12
```

Правила:
- `limit` зажимается в 1…50, по умолчанию 30;
- хост просит `limit + 1` письмо, лишнее значит, что есть старше;
- письма добавляются от новых к старым, пока их текст влезает в `PAGE_BUDGET`; сработал бюджет — тоже есть старше;
- курсор — число из `id` самого старого показанного письма;
- старше нет — последняя строка `This is the beginning of the room.`;
- писем нет совсем — шапка, затем `No messages yet.` и `This is the beginning of the room.`;
- имя автора — `participantLabel(map, from)`.

Комната, которой уже нет в снимке, даёт `<name> is no longer in Parley.`, как у `detailText`.

- [ ] **Step 1: Write the failing tests**

```ts
// read — фейк поверх массива из 45 писем m-1…m-45 комнаты r-1
it('по умолчанию 30 последних, старые — по курсору', () => {
  const text = roomPageText(src, room, {}, read);
  expect(text).toContain('[m-45 · ');
  expect(text).not.toContain('[m-15 · ');
  expect(text).toMatch(/Older messages: call parley_room with before=16$/);
  const older = roomPageText(src, room, { before: 16 }, read);
  expect(older).toContain('[m-1 · ');
  expect(older).toMatch(/This is the beginning of the room\.$/);
});
it('письмо длиннее 4000 — с многоточием, бюджет страницы держится', () => {
  const text = roomPageText(src, room, {}, readLong); // 30 писем по 5000 знаков
  expect(text).toContain(`${'x'.repeat(3999)}…`);
  expect(text.length).toBeLessThanOrEqual(PAGE_BUDGET + 2000);
  expect(text).toMatch(/before=\d+$/);
});
it('комната без писем — начало ленты без курсора', () => {
  expect(roomPageText(src, room, {}, () => [])).toMatch(/No messages yet\.\nThis is the beginning of the room\.$/);
});
it('шапка — участники, ведущий и решение', () => {
  expect(roomPageText(src, room, {}, read)).toMatch(/^Room "Auth" in Parley · one; members: S03 Ruslan, S05 Vera/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/room-page.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Implement** `roomPageText` в `room-page.ts`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/room-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/room-page.ts packages/host/src/assistant/room-page.test.ts
git commit -m "feat(host): read a whole room for the assistant, page by page"
```

### Task 5: `parley_session` — история сессии из ленты

**Files:**
- Create: `packages/host/src/assistant/session-history.ts`
- Test: `packages/host/src/assistant/session-history.test.ts`

**Interfaces:**
- Consumes: `FeedItem` и его виды из `@parley/core` (`packages/core/src/feed/types.ts:79–291`): `prompt { text }`, `text { text, streaming }`, `tool { name, input, status }`, `agent { description, agentType }`, `error { error, message }`, `turn { interrupted? }`. У каждого есть строковый `id`.
- Produces:
  - `export function toolLine(item: FeedTool): string`.
  - `export function historyText(header: string, items: readonly FeedItem[], page: { before?: string; limit?: number }): { text: string } | { error: string }`.
  - `export const HISTORY_PAGE = 20`, `HISTORY_PAGE_MAX = 50`, `TOOLS_PER_GAP = 8`. `LETTER_MAX` и `PAGE_BUDGET` импортируются из `room-page.ts`.

Записи страницы считает `limit`, по одной на элемент:
- `prompt` — `Asked: <text>`;
- `text` с непустым текстом — `Agent: <text>`, у `streaming` в конце ` (still writing)`;
- `error` — `Error: <message ?? error>`;
- `agent` — `Subagent: <description ?? agentType ?? 'task'>`;
- `turn` с `interrupted` — `(turn interrupted)`.

Текст записи — до 4000 знаков с «…».

`tool` записью не считается. Это строка `  · <toolLine>` под предыдущей записью, не больше 8 подряд, дальше `  · …and N more tool calls`. Остальные виды (`notice`, карточки, `turn` без прерывания) пропускаются.

`toolLine` строится так:
- `Bash` с `input.command` → `ran: <команда>`;
- `Edit`, `Write`, `MultiEdit`, `NotebookEdit` с `input.file_path` → `edited: <путь>`;
- `Read` → `read: <путь>`;
- `Grep`, `Glob` с `input.pattern` → `searched: <pattern>`;
- `WebFetch` с `input.url` → `fetched: <url>`;
- иначе `<name>` и первое строковое значение `input`, если оно есть;
- всё в одну строку до 160 знаков;
- при `status` `failed` или `rejected` в конце ` (failed)` или ` (rejected)`.

Страница и курсор:
- `before` — `id` элемента; страница — до `limit` записей строго старше него;
- `before` не найден среди `items` — `{ error: 'This cursor is no longer in the session feed; call parley_session without before.' }`;
- старше есть — последняя строка `Older: call parley_session with before=<id самой старой показанной записи>`, иначе `This is the beginning of the session history.`;
- записей нет совсем — `<header>` и `No history for this session yet.`;
- бюджет страницы — `PAGE_BUDGET`, как у комнаты.

- [ ] **Step 1: Write the failing tests.** Фикстура `items30` — 30 пар `prompt` («ask N») и `text` («reply N»), а после каждого ответа один `tool` `Bash` с `command: 'pnpm test'`. Всего 60 записей.

```ts
it('toolLine: команда, правка, прочие', () => {
  expect(toolLine(tool('Bash', { command: 'pnpm test' }))).toBe('ran: pnpm test');
  expect(toolLine(tool('Edit', { file_path: 'src/a.ts' }, 'failed'))).toBe('edited: src/a.ts (failed)');
  expect(toolLine(tool('mcp__x__y', { query: 'abc' }))).toBe('mcp__x__y abc');
});
it('20 последних записей, инструменты — строкой под записью', () => {
  const { text } = historyText('Session S03 …', items30, {}) as { text: string };
  expect(text).toContain('Agent: reply 30');
  expect(text).not.toContain('Agent: reply 10\n');
  expect(text).toContain('  · ran: pnpm test');
  expect(text).toMatch(/Older: call parley_session with before=\S+$/);
});
it('больше 8 инструментов подряд — хвост', () => {
  const { text } = historyText('h', [prompt('go'), ...Array.from({ length: 12 }, (_, i) => tool('Read', { file_path: `f${i}` }))], {}) as { text: string };
  expect(text).toContain('  · …and 4 more tool calls');
});
it('курсор назад до начала: 60 записей — три страницы', () => {
  let page = historyText('h', items30, {}) as { text: string };
  let pages = 1;
  for (let match = /before=(\S+)$/.exec(page.text); match !== null; match = /before=(\S+)$/.exec(page.text)) {
    page = historyText('h', items30, { before: match[1] }) as { text: string };
    pages += 1;
  }
  expect(pages).toBe(3);
  expect(page.text).toMatch(/This is the beginning of the session history\.$/);
});
it('курсора нет в ленте — ошибка с советом', () => {
  expect(historyText('h', items30, { before: 'text:#999999' })).toEqual({ error: expect.stringContaining('without before') });
});
it('пустая лента — шапка и «нет истории»', () => {
  expect(historyText('Session S09 …', [], {})).toEqual({ text: 'Session S09 …\nNo history for this session yet.' });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/session-history.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Implement** `toolLine` и `historyText` в `session-history.ts`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @parley/host exec vitest run src/assistant/session-history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/assistant/session-history.ts packages/host/src/assistant/session-history.test.ts
git commit -m "feat(host): read a session's history for the assistant, page by page"
```

### Task 6: Подключить инструменты, длину хода и промпт

**Files:**
- Modify: `packages/core/src/mcp/assistant.ts` (`ASSISTANT_TOOLS`, комментарий шапки «десять инструментов»)
- Modify: `packages/core/src/mcp/assistant.test.ts` (список имён, строки 18–31)
- Modify: `packages/host/src/assistant/assistant-endpoint.ts` (`ASSISTANT_TOOL_NAMES`)
- Modify: `packages/host/src/assistant/assistant-service.ts`:
  - `ASSISTANT_TURN_MS`, `source()`, `detailOf`, `finish()`, ветки `tool()`;
  - `parley_detail` получает `hidden`;
  - чтение комнаты — функция модуля рядом с `roomTailOf`.
- Modify: `packages/core/src/assistant/launch.ts` (`assistantPrompt`, строки 109 и ниже)
- Test: `packages/host/src/assistant/assistant-service.test.ts`, `packages/core/src/assistant/launch.test.ts`

**Interfaces:**
- Consumes: `findText` (задача 3), `roomPageText` и `LetterPage` (задача 4), `historyText` (задача 5), `targetsOf(…, { hidden })`, `resolveTarget(…, { hidden })`, `briefLine` (задача 2).
- Produces:
  - Инструменты `parley_find`, `parley_room`, `parley_session` в `ASSISTANT_TOOLS` встают сразу после `parley_detail`, в `ASSISTANT_TOOL_NAMES` — в том же порядке.
  - `export const ASSISTANT_TURN_MS = 180_000`.

Схемы инструментов (`readOnlyHint: true`):
- `parley_find`: `{ query: string, include_closed?: boolean }`, `required: ['query']`. Описание: `Search works, projects, rooms and sessions by the person's words: names, project folders, roles, tasks and summaries. Spelling and alphabet may differ (Сканум finds scanum). include_closed also searches closed sessions and archived rooms and works.` Это описание — строка в `packages/core`, поэтому с `// cyrillic-ok: пример транслита для модели`.
- `parley_room`: `{ target: TARGET, before?: number, limit?: number }`, `required: ['target']`. Описание: `The whole room: members, lead, decision, plan and the messages in full, newest page first. before (from the last reply) pages back to older messages. Works for archived rooms too.`
- `parley_session`: `{ target: TARGET, before?: string, limit?: number }`, `required: ['target']`. Описание: `The history of one agent session: what it was asked, what it answered and which tools it ran, newest page first. before (from the last reply) pages back. Works for closed sessions too.`

Ветки `tool()`:
- `const hidden = targetsOf(src, { hidden: true }).filter((target) => target.hidden !== undefined)` — для `parley_detail`, `parley_room` и `parley_session`. Они резолвят через `resolveTarget(targets, wanted, { hidden })`.
- `parley_find`: пустой `query` после `trim()` — `400 { error: 'query is empty' }`, иначе `200 { text: findText({ ...src, ...(await reasonContext()) }, query, { includeClosed: input.include_closed === true }) }`.
- `parley_room`: цель не комната — `400 '<name> is not a room'`. Иначе `roomPageText(src, target, { before, limit }, letterPageOf)`, где `letterPageOf` — функция модуля рядом с `roomTailOf`: `readLetters` с `beforeSeq` и `newestFirst: true`, при `WorkNotFoundError` — `[]`. `before` не целое положительное число — `400 'before must be the number from the last reply'`.
- `parley_session`: цель не сессия — `400 '<name> is not a session'`.
  - Шапка: `detailText(src, target, null, await waitingCardsOf(ref))`.
  - Лента: `deps.feed.snapshot(ref)`, а при сбое или без `deps.feed` — `items: []`.
  - Ответ: `historyText(шапка, items, { before, limit })`; `{ error }` превращается в `400`.

Остальная проводка:
- `source()` получает `home: os.homedir()`.
- `detailOf`: `parley_room`, `parley_session` → `{ tool: 'detail', target: <имя цели> }`, как у `parley_detail`; `parley_find` → `{ tool: 'overview', target: null }` (подпись острова «Checking…»).
- `finish()`: текст таймаута — `` `No answer in ${Math.round((deps.turnTimeoutMs ?? ASSISTANT_TURN_MS) / 1000)} s` ``.

Промпт (спека 7, часть чтения), правки в `assistantPrompt`:
- Строку `For anything about the current state call parley_overview first…` дополнить: `The overview lists every open work, room and session; never tell the person that something is not shown.`
- После неё добавить: `- If the person names a work, project, room or agent you do not see in the overview, call parley_find with their words before saying you do not know; set include_closed when they ask about closed or archived ones. To read a room in full call parley_room; to see what an agent did call parley_session. Both page back with before.`

- [ ] **Step 1: Write the failing tests**

В `core/src/mcp/assistant.test.ts` список имён в `'отдаёт … инструментов в заданном порядке'` получает три новых имени после `parley_detail`, а название теста — `тринадцать`. Ещё:

```ts
expect(byName('parley_find').inputSchema.required).toEqual(['query']);
expect(byName('parley_room').annotations).toEqual({ readOnlyHint: true });
```

В `assistant-service.test.ts` — `describe('assistant-service: чтение')`:

```ts
it('parley_find: пустой запрос — 400, имя проекта — работа', async () => {
  const service = createAssistantService(deps);
  await service.ask(ASK);
  expect(await service.tool('parley_find', { query: '  ' })).toEqual({ status: 400, body: { error: 'query is empty' } });
  expect(await service.tool('parley_find', { query: 'Parley' })).toMatchObject({ status: 200, body: { text: expect.stringContaining('Work "Parley"') } });
});
it('parley_room читает письма из базы работы целиком', async () => {
  // работа создана createWork в home, writeLetters кладёт 2 письма в r-1, одно на 4500 знаков
  const reply = await service.tool('parley_room', { target: 'Auth' });
  expect(reply.status).toBe(200);
  expect((reply.body as { text: string }).text).toContain('This is the beginning of the room.');
});
it('parley_session: закрытая сессия по id читается, лента — из feed.snapshot', async () => {
  const reply = await service.tool('parley_session', { target: closedId });
  expect(reply).toMatchObject({ status: 200, body: { text: expect.stringContaining('Agent: done') } });
});
it('parley_detail по id закрытой сессии — не 404', async () => {
  expect((await service.tool('parley_detail', { target: closedId })).status).toBe(200);
});
it('ход дольше минуты не обрывается; таймаут называет свою длину', async () => {
  await service.ask(ASK);
  expect(turns[0]?.spec.timeoutMs).toBe(180_000);
  turns[0]?.end({ ok: false, kind: 'timeout', message: '' });
  await flush();
  expect(last().error).toBe('No answer in 180 s');
});
it('подпись: parley_room — detail с именем комнаты, parley_find — overview', async () => {
  await service.ask(ASK);
  turns[0]?.emit({ type: 'tool', name: 'parley_room', input: { target: 'Auth' } });
  expect(last().detail).toEqual({ tool: 'detail', target: 'Auth' });
  turns[0]?.emit({ type: 'tool', name: 'parley_find', input: { query: 'x' } });
  expect(last().detail).toEqual({ tool: 'overview', target: null });
});
```

Тест `parley_room` строит работу так же, как существующие тесты сервиса, что уже пишут письма через `createWork` и `writeLetters`; найти их по `writeLetters` в файле. `closedId` — id `s-09` из `MAP` (закрыта), `feed.snapshot` фейка отдаёт `[{ kind: 'text', id: 'text:#1', at: '', messageId: null, text: 'done', streaming: false }]`.

В `launch.test.ts`:

```ts
it('промпт: поиск и чтение, без «не показано»', () => {
  const prompt = assistantPrompt('ru');
  expect(prompt).toContain('call parley_find with their words before saying you do not know');
  expect(prompt).toContain('never tell the person that something is not shown');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm --filter @parley/core exec vitest run src/mcp/assistant.test.ts src/assistant/launch.test.ts && pnpm --filter @parley/host exec vitest run src/assistant/assistant-service.test.ts src/assistant/assistant-endpoint.test.ts`
Expected: FAIL — новых инструментов нет, таймаут 60 000.

- [ ] **Step 3: Implement** проводку в четырёх файлах.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter @parley/core exec vitest run src/mcp src/assistant src/english-text.test.ts && pnpm --filter @parley/host exec vitest run src/assistant`
Expected: PASS. `assistant-endpoint.test.ts` проходит без правки: он сверяет маршруты с `ASSISTANT_TOOL_NAMES`.

- [ ] **Step 5: Typecheck и lint затронутых пакетов**

Run: `pnpm --filter "@parley/host^..." build && pnpm --filter @parley/host exec tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: без ошибок.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/mcp packages/core/src/assistant/launch.ts packages/core/src/assistant/launch.test.ts packages/host/src/assistant
git commit -m "feat(assistant): give the assistant tools to find and read rooms and sessions"
```

---

## Порядок и волны

- Задачи 1 и 2 правят `overview.ts`, поэтому идут по очереди.
- Задачи 3, 4 и 5 — разные новые файлы, их можно делать одной волной.
- Задача 6 идёт последней.

После задачи 6 план 1 — рабочий кусок сам по себе: помощник видит всё и читает всё.
