# Файл бэклога на выбор — план реализации

> **Для исполнителя:** обязательный навык — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans. Шаги — чекбоксы `- [ ]`.

**Цель:** человек выбирает на проект, где живёт бэклог Parley: `.parley/backlog.md` (как сейчас) или `TODOS.md`/`TODO.md` проекта; при переходе в `TODOS.md` пункты переносятся.

**Архитектура:** выбор лежит в локальном `.parley/preferences.json` (`backlogFile`). `sharedProjectPaths()` по нему решает `paths.backlog`, поэтому все читатели и писатели (MCP агентов, хост, поиск, планы) идут в нужный файл без правок. Переключение — `setBacklogFile` в core под замком проекта, метод хоста `backlog.file.set`, переключатель и разовая плашка на вкладке Backlog.

**Стек:** TypeScript, Node 20+, pnpm, vitest, zod, React + Testing Library, Electron.

**Спека:** `docs/specs/2026-10-07-backlog-todos-file-design.md` — исполнитель читает её вместе с планом.

## Общие ограничения

- Видимые тексты окна — только английские, в `packages/desktop/src/shared/strings.ts`; литералов интерфейса в компонентах нет (тест `english-ui` валит прогон при кириллице).
- Комментарии в коде — по-русски, кроме файлов, где все комментарии английские (`project-context.ts`): там — как в файле. Названия тестов — как в соседних тестах файла (в этих файлах — английские).
- Коммиты — по-русски, `feat(core): …`/`feat(host): …`/`feat(desktop): …`/`docs: …`, последняя строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Хост и окно берут `@parley/core` и `@parley/protocol` из `dist`: после правок core/protocol — `pnpm --filter @parley/protocol build && pnpm --filter @parley/core build`, потом тесты хоста и окна.
- Parley пишет в `TODOS.md` только при выборе `todos`. Без выбора файл человека не трогается.
- Безопасная сторона: испорченные настройки, ссылка вместо файла, непонятное содержимое — бэклог в `.parley/backlog.md` или прежняя ошибка, без порчи файлов.
- Ветка `feat/backlog-todos-file`, worktree `.claude/worktrees/backlog-todos-file`, база — `origin/master` 8d97474.

## На что смотреть ревьюеру

Входы, которые спека подразумевает, а прямые тесты задач легко пропустят. Тест на каждый добавлен в задачу-владельца.

1. `TODOS.md` с CRLF и без перевода строки в конце — перенесённые пункты встают отдельными строками и разбираются (задача 3, тест `CRLF`).
2. `TODOS.md` — ссылка: переключение отказывает, `.parley/backlog.md` и выбор не меняются (задача 3, тест `symlinked`).
3. Агент пишет в бэклог, пока человек переключает файл, — пункт попадает в новый файл, а не воскрешает `.parley/backlog.md` (задача 2, тест `waited for the lock`).
4. Переключение из сессии в worktree — `TODOS.md` основного checkout, не worktree (задача 3, тест `linked worktree`).
5. Чужой текст `TODOS.md` (абзацы, свои разделы) остаётся байт в байт, свои пункты человека получают только ID (задача 3, тест `moves state items`).
6. Переходы туда и обратно: новый пункт в `.parley` не повторяет ID из оставленного `TODOS.md`, иначе следующий перенос его потеряет (задача 3, тест `keeps IDs unique`).

---

### Задача 1: путь бэклога по выбору (core)

**Файлы:**
- Изменить: `packages/core/src/work/store.ts` (импорт `readdir`; тип `BacklogFileChoice`; `findTodosFile`, `readBacklogChoice`; поля `SharedProjectPaths`; `sharedProjectPaths`; `inspectSharedIgnore`)
- Изменить: `packages/core/src/index.ts:478` (экспорт типа `BacklogFileChoice`)
- Создать тест: `packages/core/src/work/backlog-file.test.ts`

**Интерфейсы:**
- Производит: `export type BacklogFileChoice = 'state' | 'todos'` (store.ts); `export async function findTodosFile(projectPath: string): Promise<string | null>`; поля `SharedProjectPaths.backlogChoice: BacklogFileChoice | null` и `SharedProjectPaths.todosFile: string | null`.

- [ ] **Шаг 1: падающие тесты.** Создать `packages/core/src/work/backlog-file.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectSharedIgnore, sharedProjectPaths } from './store.js';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});
let project = '';
beforeEach(async () => { project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-backlog-file-'))); });
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
const state = (): string => path.join(project, '.parley', 'backlog.md');
const todos = (): string => path.join(project, 'TODOS.md');
async function prefs(value: unknown): Promise<void> {
  await mkdir(path.join(project, '.parley'), { recursive: true });
  await writeFile(path.join(project, '.parley', 'preferences.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('backlog file choice', () => {
  it('keeps the backlog in the state folder without a choice and reports TODOS.md found on disk', async () => {
    await writeFile(todos(), '# TODOS\n');
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: state(), backlogChoice: null, todosFile: 'TODOS.md' });
  });
  it('points the chosen backlog at a new TODOS.md, then at TODO.md in its own case, then prefers TODOS.md', async () => {
    await prefs({ version: 1, backlogFile: 'todos' });
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: todos(), backlogChoice: 'todos', todosFile: null });
    await writeFile(path.join(project, 'Todo.md'), '');
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: path.join(project, 'Todo.md'), todosFile: 'Todo.md' });
    await writeFile(todos(), '');
    expect(await sharedProjectPaths(project)).toMatchObject({ backlog: todos(), todosFile: 'TODOS.md' });
  });
  it('falls back to the state folder on malformed preferences or an unknown choice', async () => {
    for (const value of ['{not json', { version: 2, backlogFile: 'todos' }, { version: 1, backlogFile: 'elsewhere' }]) {
      await prefs(value);
      expect(await sharedProjectPaths(project)).toMatchObject({ backlog: state(), backlogChoice: null });
    }
  });
  it('does not blame the state folder when the chosen TODOS.md is ignored by Git', async () => {
    await git(project, 'init', '-q'); await writeFile(path.join(project, '.gitignore'), 'TODOS.md\n');
    await prefs({ version: 1, backlogFile: 'todos' });
    const diagnostics = await inspectSharedIgnore(await sharedProjectPaths(project));
    expect(diagnostics.map(row => row.code)).not.toContain('parley-dir-ignored');
  });
});
```

- [ ] **Шаг 2: прогон — падают.** `cd packages/core && npx vitest run src/work/backlog-file.test.ts`. Ожидается: 4 падения (`backlogChoice`/`todosFile` отсутствуют, `backlog` указывает на `.parley`, в последнем тесте есть `parley-dir-ignored`).

- [ ] **Шаг 3: реализация в `store.ts`.**

В импорт из `node:fs/promises` (строки 4–15) добавить `readdir`.

Над `export interface SharedProjectPaths` (строка ~468):

```ts
/** Где лежит бэклог проекта: `state` — `<каталог состояния>/backlog.md`, `todos` — TODOS.md/TODO.md папки проекта. */
export type BacklogFileChoice = 'state' | 'todos';
```

В `SharedProjectPaths` после `lock: string;` добавить:

```ts
  /** Сохранённый выбор файла бэклога; null — выбора не было или настройки не читаются. */
  backlogChoice: BacklogFileChoice | null;
  /** TODOS.md/TODO.md папки проекта — имя как на диске; null — такого файла нет. */
  todosFile: string | null;
```

Перед `export async function sharedProjectPaths`:

```ts
/** TODOS.md или TODO.md папки проекта, имя — как на диске, регистр не важен. Порядок: точное TODOS.md, другое написание
 * todos.md, точное TODO.md, другое написание todo.md; внутри ранга — по кодам символов. */
export async function findTodosFile(projectPath: string): Promise<string | null> {
  let names: string[];
  try { names = (await readdir(projectPath)).filter(name => /^todos?\.md$/i.test(name)); } catch { return null; }
  const rank = (name: string): number => (name.toLowerCase() === 'todos.md' ? 0 : 2) + (name === 'TODOS.md' || name === 'TODO.md' ? 0 : 1);
  return names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))[0] ?? null;
}

/** Выбор файла бэклога для пути — без исключений: испорченные настройки дают каталог состояния. Строгая проверка — при записи. */
async function readBacklogChoice(file: string): Promise<BacklogFileChoice | null> {
  try {
    const value: unknown = JSON.parse((await readSharedFile(file)).text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const choice = record['backlogFile'];
    return record['version'] === 1 && (choice === 'state' || choice === 'todos') ? choice : null;
  } catch { return null; }
}
```

В `sharedProjectPaths` заменить `return { context, dir, backlog: path.join(dir, 'backlog.md'), … lock: path.join(dir, 'backlog.lock') };` на:

```ts
  const preferences = path.join(dir, 'preferences.json');
  const [backlogChoice, todosFile] = await Promise.all([readBacklogChoice(preferences), findTodosFile(context.projectPath)]);
  const backlog = backlogChoice === 'todos' ? path.join(context.projectPath, todosFile ?? 'TODOS.md') : path.join(dir, 'backlog.md');
  return { context, dir, backlog, plans: path.join(dir, 'plans'), decisions: path.join(dir, 'decisions'), historyShared: path.join(dir, 'history-shared'),
    preferences, suggestions: path.join(dir, 'backlog-suggestions.json'),
    memory: path.join(dir, 'memory.md'), memorySuggestions: path.join(dir, 'memory-suggestions.json'),
    lock: path.join(dir, 'backlog.lock'), backlogChoice, todosFile };
```

В `inspectSharedIgnore` заменить строку с `parley-dir-ignored` на:

```ts
  // Бэклог в TODOS.md — файл проекта, а не каталога состояния: его игнор к `.parley` отношения не имеет.
  const backlogInState = path.dirname(paths.backlog) === paths.dir;
  if ((backlogInState && await sharedPathIgnored(paths.context, paths.backlog, options)) || await sharedPathIgnored(paths.context, paths.memory, options))
    diagnostics.push({ code: 'parley-dir-ignored' });
```

В `packages/core/src/index.ts:478` в `export type { SharedProjectPaths, … } from './work/store.js';` добавить `BacklogFileChoice`.

- [ ] **Шаг 4: прогон — зелёный.** `cd packages/core && npx vitest run src/work/backlog-file.test.ts src/work/store.test.ts src/work/backlog.test.ts src/work/project-context.test.ts && npx tsc --noEmit -p .`. Ожидается: всё зелёное, tsc без ошибок. Если tsc нашёл объекты `SharedProjectPaths`, собранные руками в тестах, — дописать им `backlogChoice: null, todosFile: null`.

- [ ] **Шаг 5: коммит.**

```bash
git add packages/core/src/work/store.ts packages/core/src/index.ts packages/core/src/work/backlog-file.test.ts
git commit -m "feat(core): путь бэклога по выбору — .parley/backlog.md или TODOS.md проекта

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 2: транзакция бэклога берёт пути под замком, права файла сохраняются (core)

**Файлы:**
- Изменить: `packages/core/src/work/backlog.ts` (`withBacklogTransaction` ~строка 144; три вызова `writeSharedFile(tx.paths.backlog, source, before, 0o644)` — строки ~246, ~289, ~338; новый `backlogMode`)
- Тест: `packages/core/src/work/backlog-file.test.ts`

**Интерфейсы:**
- Потребляет: `sharedProjectPaths` с `backlogChoice` (задача 1).
- Производит: `export async function backlogMode(file: string): Promise<number>` (backlog.ts).

- [ ] **Шаг 1: падающие тесты.** В `backlog-file.test.ts` добавить импорты `chmod, lstat, readFile, stat` из `node:fs/promises`, `addBacklogItem` из `./backlog.js`, `withSharedProjectLock` из `./store.js`, и блок:

```ts
describe('backlog writes under the chosen file', () => {
  it('a writer that waited for the lock during a switch lands in the new file', async () => {
    const paths = await sharedProjectPaths(project);
    let pending: Promise<unknown> = Promise.resolve();
    await withSharedProjectLock(paths, async () => {
      pending = addBacklogItem(project, { title: 'Late' });
      // Писатель успевает вычислить пути (ещё .parley) и ждёт замок; таймаут замка — 3 с.
      await new Promise(resolve => setTimeout(resolve, 500));
      await writeFile(paths.preferences, JSON.stringify({ version: 1, backlogFile: 'todos' }));
    });
    await pending;
    expect(await readFile(todos(), 'utf8')).toContain('Late');
    await expect(lstat(state())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps the mode of an existing backlog file', async () => {
    await prefs({ version: 1, backlogFile: 'todos' });
    await writeFile(todos(), '# TODOS\n'); await chmod(todos(), 0o755);
    await addBacklogItem(project, { title: 'Keeps mode' });
    expect((await stat(todos())).mode & 0o777).toBe(0o755);
  });
});
```

- [ ] **Шаг 2: прогон — падают.** `cd packages/core && npx vitest run src/work/backlog-file.test.ts`. Ожидается: первый тест — пункт в `.parley/backlog.md` (TODOS.md нет), второй — режим `0o644`.

- [ ] **Шаг 3: реализация в `backlog.ts`.**

Добавить импорт `import { lstat } from 'node:fs/promises';`.

`withBacklogTransaction` заменить на:

```ts
export async function withBacklogTransaction<T>(projectPath: string, options: SharedWriteOptions,
  body: (tx: BacklogTransaction) => Promise<T>): Promise<T> {
  const locked = await sharedProjectPaths(projectPath, options);
  return withSharedProjectLock(locked, async () => {
    // Пока ждали замок, человек мог сменить файл бэклога: пути — заново, под замком. Замок у обоих файлов один.
    const paths = await sharedProjectPaths(projectPath, options);
    if (paths.dir !== locked.dir) throw new SharedStateError('backlog-conflict');
    const tx = { paths, ...await readBacklogLocal(paths) };
    // Recover only reserved appends whose known base or already-written identity proves the operation.
    for (const operation of tx.state.operations.filter(row => row.status === 'reserved')) await applyAppend(tx, operation, options, true);
    return body(tx);
  }, options);
}
```

После `withBacklogTransaction` добавить:

```ts
/** Права записи бэклога: у существующего файла — его собственные (бит исполнения у TODOS.md человека видит git), у нового — 0o644. */
export async function backlogMode(file: string): Promise<number> {
  try { return (await lstat(file)).mode & 0o777; } catch { return 0o644; }
}
```

Во всех трёх местах `writeSharedFile(tx.paths.backlog, source, before, 0o644)` заменить `0o644` на `await backlogMode(tx.paths.backlog)`.

- [ ] **Шаг 4: прогон — зелёный.** `cd packages/core && npx vitest run src/work/backlog-file.test.ts src/work/backlog.test.ts src/work/backlog-suggestions.test.ts`. Ожидается: всё зелёное.

- [ ] **Шаг 5: коммит.**

```bash
git add packages/core/src/work/backlog.ts packages/core/src/work/backlog-file.test.ts
git commit -m "feat(core): транзакция бэклога берёт пути под замком, права файла бэклога сохраняются

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 3: переключение с переносом пунктов — `setBacklogFile` (core)

**Файлы:**
- Изменить: `packages/core/src/work/backlog.ts` (`appendSource` → `insertBlock` + `appendSource`; новый `mergeBacklogInto`)
- Изменить: `packages/core/src/work/project-preferences.ts` (новый `setBacklogFile`)
- Изменить: `packages/core/src/index.ts:483` (экспорт `setBacklogFile`)
- Тест: `packages/core/src/work/backlog-file.test.ts`

**Интерфейсы:**
- Потребляет: `BacklogFileChoice`, `paths.backlogChoice`, `paths.todosFile` (задача 1); `backlogMode` (задача 2); `ensureBacklogIdsInTransaction`, `withBacklogTransaction` (есть).
- Производит: `export function mergeBacklogInto(target: string, source: string): string` и `export function raiseBacklogSeq(state: BacklogLocalState, source: string): void` (backlog.ts); `export async function setBacklogFile(projectPath: string, file: BacklogFileChoice, options?: SharedWriteOptions): Promise<SharedDiagnostic[]>` (project-preferences.ts, экспорт из `@parley/core`).

- [ ] **Шаг 1: падающие тесты.** В `backlog-file.test.ts` добавить импорты `symlink` из `node:fs/promises`, `parseBacklog` из `./backlog.js`, `setBacklogFile` из `./project-preferences.js`, помощники и блок:

```ts
async function seedState(source: string): Promise<void> {
  await mkdir(path.join(project, '.parley'), { recursive: true }); await writeFile(state(), source);
}
const rows = async (file: string) => parseBacklog(await readFile(file, 'utf8'))
  .map(({ id, title, section, details, checked }) => ({ id, title, section, details, checked }));

describe('switching the backlog file', () => {
  it('moves state items with sections, details and IDs into TODOS.md and removes the state file', async () => {
    await writeFile(todos(), '# TODOS\n\nFree text stays.\n\n## Bugs\n- [ ] Mine\n');
    await seedState('# Backlog\n- [ ] First <!-- b-001 · by: s-01 -->\n  Detail line\n## Bugs\n- [x] Fixed <!-- b-002 · done: 2026-10-07 -->\n- [ ] Handwritten\n');
    await setBacklogFile(project, 'todos');
    const text = await readFile(todos(), 'utf8');
    expect(text.startsWith('# TODOS\n\nFree text stays.\n\n## Bugs\n- [ ] Mine')).toBe(true);
    expect(await rows(todos())).toEqual([
      { id: null, title: 'Mine', section: 'Bugs', details: '', checked: false },
      { id: 'b-002', title: 'Fixed', section: 'Bugs', details: '', checked: true },
      { id: 'b-003', title: 'Handwritten', section: 'Bugs', details: '', checked: false },
      { id: 'b-001', title: 'First', section: 'Backlog', details: 'Detail line', checked: false },
    ]);
    expect(parseBacklog(text).find(item => item.id === 'b-001')).toMatchObject({ by: 's-01' });
    expect(parseBacklog(text).find(item => item.id === 'b-002')).toMatchObject({ done: '2026-10-07' });
    await expect(lstat(state())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await sharedProjectPaths(project)).backlogChoice).toBe('todos');
  });
  it('creates TODOS.md from the state file when the project has none', async () => {
    await seedState('# Backlog\n- [ ] Only <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    expect(await readFile(todos(), 'utf8')).toBe('# Backlog\n- [ ] Only <!-- b-001 -->\n');
  });
  it('a repeated move after a crash does not duplicate items', async () => {
    // Сбой после записи TODOS.md и до удаления файла состояния.
    await writeFile(todos(), '# TODOS\n\n## Backlog\n- [ ] Once <!-- b-001 -->\n');
    await seedState('# Backlog\n- [ ] Once <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.id)).toEqual(['b-001']);
    await expect(lstat(state())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps moved items on their own lines in a CRLF TODOS.md without a final newline', async () => {
    await writeFile(todos(), '# TODOS\r\n- [ ] Mine <!-- b-009 -->');
    await seedState('# Backlog\n- [ ] Moved <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.title)).toEqual(['Mine', 'Moved']);
  });
  it('refuses duplicate IDs or a symlinked TODOS.md and changes nothing', async () => {
    await seedState('# Backlog\n- [ ] Stay <!-- b-001 -->\n');
    await writeFile(todos(), '- [ ] One <!-- b-007 -->\n- [ ] Two <!-- b-007 -->\n');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'backlog-invalid' });
    await rm(todos()); await writeFile(path.join(project, 'elsewhere.md'), ''); await symlink(path.join(project, 'elsewhere.md'), todos());
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'shared-file-unreadable' });
    expect(await readFile(state(), 'utf8')).toContain('Stay');
    expect((await sharedProjectPaths(project)).backlogChoice).toBeNull();
  });
  it('refuses the switch over malformed preferences before touching files', async () => {
    await seedState('# Backlog\n- [ ] Stay <!-- b-001 -->\n'); await prefs('{broken');
    await expect(setBacklogFile(project, 'todos')).rejects.toMatchObject({ code: 'preferences-invalid' });
    expect(await readFile(state(), 'utf8')).toContain('Stay');
    await expect(lstat(todos())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('switching back leaves TODOS.md untouched and new items go to the state file', async () => {
    await seedState('# Backlog\n- [ ] Moved <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos');
    const before = await readFile(todos(), 'utf8');
    await setBacklogFile(project, 'state');
    await addBacklogItem(project, { title: 'Back home' });
    expect(await readFile(todos(), 'utf8')).toBe(before);
    expect(await readFile(state(), 'utf8')).toContain('Back home');
  });
  it('keeps IDs unique across both files after switching back and forth, so nothing is lost on the next move', async () => {
    await seedState('# Backlog\n- [ ] Moved <!-- b-001 -->\n');
    await setBacklogFile(project, 'todos'); await setBacklogFile(project, 'state');
    expect((await addBacklogItem(project, { title: 'Back home' })).id).toBe('b-002');
    await setBacklogFile(project, 'todos');
    expect((await rows(todos())).map(row => row.title)).toEqual(['Moved', 'Back home']);
  });
  it('moves into TODOS.md of the main checkout when switched from a linked worktree', async () => {
    const main = path.join(project, 'main'); await mkdir(main);
    await git(main, 'init', '-q', '-b', 'main'); await writeFile(path.join(main, 'a'), 'a'); await git(main, 'add', '.');
    await git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'fixture');
    const linked = path.join(project, 'linked'); await git(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
    await addBacklogItem(linked, { title: 'From worktree' });
    await setBacklogFile(linked, 'todos');
    expect(await readFile(path.join(main, 'TODOS.md'), 'utf8')).toContain('From worktree');
    await expect(lstat(path.join(linked, 'TODOS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

- [ ] **Шаг 2: прогон — падают.** `cd packages/core && npx vitest run src/work/backlog-file.test.ts`. Ожидается: ошибка импорта `setBacklogFile` (файл не собирается) — это и есть «красный».

- [ ] **Шаг 3: `insertBlock` и `mergeBacklogInto` в `backlog.ts`.** `appendSource` заменить на две функции (поведение `appendSource` не меняется — его покрывают тесты `backlog.test.ts`):

```ts
function insertBlock(source: string, block: string, section?: string): string {
  const eol = eolOf(source);
  if (!source) source = `# Backlog${eol}`;
  const headings = sectionHeadings(source);
  if (section) {
    const selected = headings.findIndex(heading => heading.title === section.trim());
    if (selected >= 0) {
      const at = headings[selected + 1]?.start ?? source.length;
      const before = source.slice(0, at);
      const separator = before.endsWith('\n') || before.endsWith('\r') ? '' : eol;
      return before + separator + block + source.slice(at);
    }
    if (!source.endsWith('\n') && !source.endsWith('\r')) source += eol;
    source += `${eol}## ${section.trim()}${eol}`;
  }
  const separator = source.endsWith('\n') || source.endsWith('\r') ? '' : eol;
  return source + separator + block;
}
function appendSource(source: string, id: string, input: BacklogInput): string {
  const eol = eolOf(source);
  const tokens = input.by ? [`by: ${input.by}`] : [];
  const block = renderLine({ id, title: input.title.trim(), details: '', checked: false, section: null }, tokens, eol) +
    (input.details ? input.details.split(/\r\n|\n|\r/).map(line => `  ${line}${eol}`).join('') : '');
  return insertBlock(source, block, input.section);
}

/** Дописывает в target пункты source, чьих ID в target ещё нет: строка с пометками и подробности — как есть, в свой раздел
 * (нет раздела — новый `## <раздел>` в конце). Пустой target — это source целиком. Повтор ничего не дублирует. */
export function mergeBacklogInto(target: string, source: string): string {
  const present = new Set(parseItems(target).map(item => item.id).filter(id => id !== null));
  const moving = parseItems(source).filter(item => item.id === null || !present.has(item.id));
  if (moving.length === 0) return target;
  if (!target) return source;
  let result = target;
  for (const item of moving) {
    const raw = source.slice(item.start, item.end).replace(/^﻿/, '');
    result = insertBlock(result, /[\r\n]$/.test(raw) ? raw : raw + eolOf(target), item.section ?? undefined);
  }
  parseItems(result); // Дубль ID или маркеры конфликта — ошибка до записи.
  return result;
}

/** Счётчик ID — не ниже любого ID в тексте. Счётчик сохраняется только при записи, а у оставленного файла записей нет:
 * без этого новый пункт повторил бы ID из него, и следующий перенос счёл бы пункт уже перенесённым. */
export function raiseBacklogSeq(state: BacklogLocalState, source: string): void {
  for (const item of parseItems(source)) if (item.id) {
    const sequence = Number(item.id.slice(2)); if (!boundedSequence(sequence)) fail();
    state.backlogSeq = Math.max(state.backlogSeq, sequence);
  }
}
```

- [ ] **Шаг 4: `setBacklogFile` в `project-preferences.ts`.** Импорты привести к:

```ts
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { backlogMode, ensureBacklogIdsInTransaction, mergeBacklogInto, raiseBacklogSeq, saveBacklogLocal, withBacklogTransaction } from './backlog.js';
import { MISSING_SHARED_VERSION, SharedStateError, readSharedFile, sharedProjectPaths, withSharedProjectLock, writeSharedFile } from './store.js';
import type { BacklogFileChoice, SharedDiagnostic, SharedProjectPaths, SharedWriteOptions } from './store.js';
```

В конец файла:

```ts
/** Файл бэклога проекта (спека 2026-10-07-backlog-todos-file, раздел 5). `.parley` → TODOS.md переносит пункты и удаляет
 * `.parley/backlog.md`; обратно — только выбор, TODOS.md человека не трогается. */
export async function setBacklogFile(projectPath: string, file: BacklogFileChoice, options: SharedWriteOptions = {}): Promise<SharedDiagnostic[]> {
  if (file !== 'state' && file !== 'todos') throw new SharedStateError('preferences-invalid');
  return withBacklogTransaction(projectPath, options, async tx => {
    // Строгое чтение до любых изменений: испорченные настройки — отказ, а не перенос без записи выбора.
    const before = await preferencesRecord(tx.paths);
    let diagnostics: SharedDiagnostic[] = [];
    if (file === 'todos' && tx.paths.backlogChoice !== 'todos') {
      // Сейчас tx.paths.backlog — файл каталога состояния. ID рукописным пунктам — чтобы перенос узнал их и при повторе.
      diagnostics = await ensureBacklogIdsInTransaction(tx, options);
      const source = await readSharedFile(tx.paths.backlog);
      if (source.version !== MISSING_SHARED_VERSION) {
        const targetFile = path.join(tx.paths.context.projectPath, tx.paths.todosFile ?? 'TODOS.md');
        const target = await readSharedFile(targetFile);
        const merged = mergeBacklogInto(target.text, source.text);
        if (merged !== target.text) await writeSharedFile(targetFile, merged, target, await backlogMode(targetFile));
        if ((await readSharedFile(tx.paths.backlog)).version !== source.version) throw new SharedStateError('backlog-conflict');
        await rm(tx.paths.backlog);
      }
    }
    // ID уникальны в обоих файлах. Нечитаемый или непонятный файл не мешает переключению.
    for (const candidate of [path.join(tx.paths.dir, 'backlog.md'), path.join(tx.paths.context.projectPath, tx.paths.todosFile ?? 'TODOS.md')]) {
      try { raiseBacklogSeq(tx.state, (await readSharedFile(candidate)).text); } catch { /* безопасная сторона: только счётчик */ }
    }
    await saveBacklogLocal(tx);
    await writeSharedFile(tx.paths.preferences, `${JSON.stringify({ ...before.value, backlogFile: file }, null, 2)}\n`, before);
    return diagnostics;
  });
}
```

В `packages/core/src/index.ts:483` экспорт сделать `export { readProjectPreferences, setBacklogFile, setBacklogRule } from './work/project-preferences.js';`.

- [ ] **Шаг 5: прогон — зелёный.** `cd packages/core && npx vitest run src/work/backlog-file.test.ts src/work/backlog.test.ts src/work/backlog-suggestions.test.ts src/work/project-context.test.ts && npx tsc --noEmit -p .`. Ожидается: зелёное. Если первый тест расходится только в порядке пунктов раздела `Bugs` — сверить с правилом «в конец своего раздела, в порядке файла состояния» и править код, а не ожидание.

- [ ] **Шаг 6: весь core и линт.** `cd packages/core && npx vitest run && npx eslint src/work/backlog.ts src/work/project-preferences.ts src/work/store.ts src/work/backlog-file.test.ts`. Ожидается: все тесты core зелёные (на 2026-10-07 — 116 файлов), линт чистый.

- [ ] **Шаг 7: коммит.**

```bash
git add packages/core/src/work/backlog.ts packages/core/src/work/project-preferences.ts packages/core/src/index.ts packages/core/src/work/backlog-file.test.ts
git commit -m "feat(core): setBacklogFile — переход в TODOS.md с переносом пунктов, обратно без правки TODOS.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 4: метод `backlog.file.set` и поля снимка (protocol + host)

**Файлы:**
- Изменить: `packages/protocol/src/backlog.ts` (`backlogFileChoice`; `file` в `backlogSnapshot`; метод в `backlogMethodSchemas`; тип)
- Изменить: `packages/protocol/src/index.ts:85-86` (экспорт `backlogFileChoice`, `BacklogFileChoice`)
- Изменить: `packages/host/src/methods/backlog.ts` (импорт `setBacklogFile`; `file` в `readBacklogSnapshot`; обработчик)
- Тесты: `packages/protocol/src/backlog.test.ts`, `packages/host/src/methods/backlog.test.ts`

**Интерфейсы:**
- Потребляет: `setBacklogFile`, `paths.backlogChoice`, `paths.todosFile` из `@parley/core` (задачи 1, 3).
- Производит: метод `'backlog.file.set': { projectPath: string; file: 'state' | 'todos' } → BacklogSnapshot`; `BacklogSnapshot['file']` = `{ relativePath: string; exists: boolean; choice?: 'state' | 'todos' | null; todos?: string | null }`.

- [ ] **Шаг 1: падающие тесты протокола.** В `packages/protocol/src/backlog.test.ts` в существующий `describe` добавить:

```ts
  it('accepts the backlog file choice and TODOS names, and an older snapshot without them', () => {
    expect(backlogMethodSchemas['backlog.file.set'].safeParse({ projectPath: '/project', file: 'todos' }).success).toBe(true);
    expect(backlogMethodSchemas['backlog.file.set'].safeParse({ projectPath: '/project', file: 'notes' }).success).toBe(false);
    const base = { projectPath: '/p', sharedProjectPath: '/p', version: 'v', items: [], suggestions: [], rule: 'ask', diagnostics: [] };
    expect(backlogSnapshot.safeParse({ ...base, file: { relativePath: '.parley/backlog.md', exists: false } }).success).toBe(true);
    expect(backlogSnapshot.safeParse({ ...base, file: { relativePath: 'Todo.md', exists: true, choice: 'todos', todos: 'Todo.md' } }).success).toBe(true);
    expect(backlogSnapshot.safeParse({ ...base, file: { relativePath: 'notes.md', exists: true } }).success).toBe(false);
    expect(backlogSnapshot.safeParse({ ...base, file: { relativePath: '.parley/backlog.md', exists: true, choice: null, todos: '../TODOS.md' } }).success).toBe(false);
  });
```

- [ ] **Шаг 2: прогон — падает.** `cd packages/protocol && npx vitest run src/backlog.test.ts`. Ожидается: падение (нет схемы `backlog.file.set`).

- [ ] **Шаг 3: протокол.** В `packages/protocol/src/backlog.ts`:

```ts
export const backlogFileChoice = z.enum(['state', 'todos']);
const todosName = z.string().regex(/^todos?\.md$/i);
```

поле `file` в `backlogSnapshot`:

```ts
  file: z.strictObject({
    relativePath: z.union([z.enum(['.parley/backlog.md', '.harnas/backlog.md']), todosName]), exists: z.boolean(),
    /** Нет у старого хоста — окно тогда прячет выбор файла. */
    choice: backlogFileChoice.nullable().optional(), todos: todosName.nullable().optional(),
  }),
```

в `backlogMethodSchemas` после `'backlog.preferences.set'`:

```ts
  'backlog.file.set': z.strictObject({ projectPath: project, file: backlogFileChoice }),
```

и `export type BacklogFileChoice = z.infer<typeof backlogFileChoice>;`. В `packages/protocol/src/index.ts` добавить `backlogFileChoice` в строку 85 и `BacklogFileChoice` в строку 86.

- [ ] **Шаг 4: прогон протокола — зелёный, сборка.** `cd packages/protocol && npx vitest run src/backlog.test.ts && cd ../.. && pnpm --filter @parley/protocol build && pnpm --filter @parley/core build`. Ожидается: зелёное, сборки без ошибок.

- [ ] **Шаг 5: падающие тесты хоста.** В `packages/host/src/methods/backlog.test.ts` в `describe('human backlog handlers'` добавить:

```ts
  it('offers TODOS.md, moves the backlog there and back without touching it', async () => {
    const todos = path.join(project, 'TODOS.md');
    await writeFile(todos, '# TODOS\n');
    expect((await get()).file).toEqual({ relativePath: '.parley/backlog.md', exists: false, choice: null, todos: 'TODOS.md' });
    await add('Moved item');
    const moved = await handlers['backlog.file.set']({ projectPath: project, file: 'todos' });
    expect(moved.file).toEqual({ relativePath: 'TODOS.md', exists: true, choice: 'todos', todos: 'TODOS.md' });
    expect(moved.items.map(item => item.title)).toEqual(['Moved item']);
    await add('Second');
    const before = await readFile(todos, 'utf8'); expect(before).toContain('Second');
    const back = await handlers['backlog.file.set']({ projectPath: project, file: 'state' });
    expect(back.file).toMatchObject({ relativePath: '.parley/backlog.md', exists: false, choice: 'state' });
    expect(await readFile(todos, 'utf8')).toBe(before);
  });
  it('refuses a switch over malformed preferences with a safe error code', async () => {
    await mkdir(path.join(project, '.parley'), { recursive: true });
    await writeFile(path.join(project, '.parley', 'preferences.json'), '{broken');
    await expect(handlers['backlog.file.set']({ projectPath: project, file: 'todos' })).rejects.toMatchObject({ data: { code: 'preferences-invalid' } });
  });
```

- [ ] **Шаг 6: прогон — падает.** `cd packages/host && npx vitest run src/methods/backlog.test.ts`. Ожидается: нет обработчика `backlog.file.set` / в `file` нет `choice`.

- [ ] **Шаг 7: хост.** В `packages/host/src/methods/backlog.ts` в импорт из `@parley/core` добавить `setBacklogFile`. В `readBacklogSnapshot` строку `file: { … }` заменить на:

```ts
      file: { relativePath: paths.backlogChoice === 'todos' ? path.basename(paths.backlog) : path.basename(paths.dir) === '.harnas' ? '.harnas/backlog.md' : '.parley/backlog.md',
        exists: before[0]!.version !== 'missing', choice: paths.backlogChoice, todos: paths.todosFile },
```

В объект обработчиков после `'backlog.preferences.set'`:

```ts
    'backlog.file.set': params => run('backlog.file.set', params, async input => setBacklogFile(input.projectPath, input.file)),
```

- [ ] **Шаг 8: прогон — зелёный.** `cd packages/host && npx vitest run src/methods/backlog.test.ts src/backlog && npx tsc --noEmit -p .`. Ожидается: зелёное. Затем весь хост: `npx vitest run` — все зелёные.

- [ ] **Шаг 9: коммит.**

```bash
git add packages/protocol/src/backlog.ts packages/protocol/src/index.ts packages/protocol/src/backlog.test.ts packages/host/src/methods/backlog.ts packages/host/src/methods/backlog.test.ts
git commit -m "feat(host): метод backlog.file.set и выбор файла в снимке бэклога

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 5: переключатель и плашка на вкладке Backlog (desktop)

**Файлы:**
- Изменить: `packages/desktop/src/shared/strings.ts:130-143` (раздел `backlog`)
- Изменить: `packages/desktop/src/renderer/components/project/BacklogPanel.tsx:159-167` (после селектора «Agent suggestions»)
- Тест: `packages/desktop/src/renderer/components/project/BacklogPanel.test.tsx`

**Интерфейсы:**
- Потребляет: `'backlog.file.set'`, `snapshot.file.choice`, `snapshot.file.todos` (задача 4).

- [ ] **Шаг 1: падающие тесты.** В `BacklogPanel.test.tsx` в `describe('BacklogPanel'` добавить:

```ts
  it('offers TODOS.md once and saves either answer', async () => {
    const offered: BacklogSnapshot = { ...snapshot(), file: { relativePath: '.parley/backlog.md', exists: true, choice: null, todos: 'TODOS.md' } };
    const { props, call } = fixture(offered); render(<BacklogPanel {...props} />);
    await screen.findByText('This project has TODOS.md. Keep the backlog there?');
    fireEvent.click(screen.getByRole('button', { name: 'Use TODOS.md' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('backlog.file.set', { projectPath: project, file: 'todos' }));
    // Пока идёт первый вызов, кнопки заблокированы: ждём конца.
    await waitFor(() => expect((screen.getByRole('button', { name: 'Keep in .parley' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Keep in .parley' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('backlog.file.set', { projectPath: project, file: 'state' }));
  });
  it('switches the backlog file from the selector and shows no offer after a choice', async () => {
    const chosen: BacklogSnapshot = { ...snapshot(), file: { relativePath: '.parley/backlog.md', exists: true, choice: 'state', todos: 'TODO.md' } };
    const { props, call } = fixture(chosen); render(<BacklogPanel {...props} />);
    await screen.findByText('Open item');
    expect(screen.queryByText(/Keep the backlog there/)).toBeNull();
    expect(screen.getByRole('option', { name: 'TODO.md' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Backlog file'), { target: { value: 'todos' } });
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('backlog.file.set', { projectPath: project, file: 'todos' }));
  });
  it('hides the file choice with an older host', async () => {
    const { props } = fixture(); render(<BacklogPanel {...props} />);
    await screen.findByText('Open item');
    expect(screen.queryByLabelText('Backlog file')).toBeNull();
    expect(screen.queryByText(/Keep the backlog there/)).toBeNull();
  });
```

- [ ] **Шаг 2: прогон — падают.** `cd packages/desktop && npx vitest run src/renderer/components/project/BacklogPanel.test.tsx`. Ожидается: первые два теста падают (нет текста и селектора), третий проходит.

- [ ] **Шаг 3: строки.** В `strings.ts`, раздел `backlog`, после `everything: 'Add everything',` добавить:

```ts
    file: 'Backlog file', stateFile: '.parley/backlog.md', todosFile: 'TODOS.md',
    todosOffer: (name: string): string => `This project has ${name}. Keep the backlog there?`,
    useTodos: (name: string): string => `Use ${name}`, keepState: 'Keep in .parley',
```

- [ ] **Шаг 4: панель.** В `BacklogPanel.tsx` сразу после `</label>` селектора «Agent suggestions» вставить:

```tsx
      {snapshot.file.choice !== undefined && <>
        {snapshot.file.choice === null && snapshot.file.todos && <div role="note" className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
          <span>{S.backlog.todosOffer(snapshot.file.todos)}</span>
          <Button size="xs" disabled={busy} onClick={() => { void mutate('backlog.file.set', { projectPath, file: 'todos' }); }}>{S.backlog.useTodos(snapshot.file.todos)}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => { void mutate('backlog.file.set', { projectPath, file: 'state' }); }}>{S.backlog.keepState}</Button>
        </div>}
        <label className="flex items-center gap-2">{S.backlog.file}
          <select aria-label={S.backlog.file} value={snapshot.file.choice ?? 'state'} disabled={busy} onChange={event => {
            const file = event.target.value;
            if (file === 'state' || file === 'todos') void mutate('backlog.file.set', { projectPath, file });
          }}>
            <option value="state">{S.backlog.stateFile}</option><option value="todos">{snapshot.file.todos ?? S.backlog.todosFile}</option>
          </select>
        </label>
      </>}
```

В первом тесте шага 1 «Keep in .parley» нажимается после «Use TODOS.md»: мок возвращает тот же снимок с `choice: null`, поэтому плашка остаётся, а тест ждёт, пока кнопки снова станут доступны.

- [ ] **Шаг 5: прогон — зелёный.** `cd packages/desktop && npx vitest run src/renderer/components/project/BacklogPanel.test.tsx src/shared && npx tsc --noEmit -p .`. Ожидается: зелёное (в `src/shared` — тест `english-ui`). Если `tsc` проекта окна требует сборки зависимостей — `cd ../.. && pnpm typecheck`.

- [ ] **Шаг 6: коммит.**

```bash
git add packages/desktop/src/shared/strings.ts packages/desktop/src/renderer/components/project/BacklogPanel.tsx packages/desktop/src/renderer/components/project/BacklogPanel.test.tsx
git commit -m "feat(desktop): выбор файла бэклога на вкладке Backlog — переключатель и разовая плашка TODOS.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Задача 6: документы, полный прогон, живая приёмка

**Файлы:**
- Изменить: `README.md` (раздел «Plans, modes and the backlog» ~строка 1470; схема `.parley/` ~строка 1080)
- Изменить: `CHANGELOG.md` (`## Unreleased` → `### Added`)
- Изменить: `docs/specs/2026-10-02-plans-backlog-design.md` (раздел 2, строка «Где бэклог»)
- Изменить: `docs/specs/2026-10-07-backlog-todos-file-design.md` (статус)

- [ ] **Шаг 1: README.** В схеме `.parley/` строку `backlog.md          shared: the project backlog` дополнить: `shared: the project backlog (unless you chose TODOS.md)`. В раздел «Plans, modes and the backlog» добавить абзац:

```markdown
**Where the backlog lives.** By default the backlog is `.parley/backlog.md`. The Backlog tab has
a "Backlog file" switch: pick `TODOS.md` and Parley keeps the backlog in the project's own
`TODOS.md` (or `TODO.md`, whichever exists; a new `TODOS.md` is created on the first item).
Switching moves the items of `.parley/backlog.md` to the end of that file, each under its
section, and removes `.parley/backlog.md`; switching back leaves `TODOS.md` as it is. When the
project already has `TODOS.md`, the tab offers it once. Parley gives every `- [ ]` line of the
chosen file an ID comment on its first write; other text stays byte for byte. The choice is
local to your machine (`.parley/preferences.json`). Agents read and suggest through the same
tools either way.
```

- [ ] **Шаг 2: CHANGELOG.** В `## Unreleased` → `### Added` дописать:

```markdown
- **Keep the backlog in TODOS.md.** The Backlog tab has a "Backlog file" switch:
  `.parley/backlog.md` (the default) or the project's `TODOS.md`/`TODO.md`. A project that
  already has one is offered it once. Switching to it moves the existing items there with their
  IDs and sections; switching back leaves the file untouched. Agents' backlog tools follow the
  choice.
```

- [ ] **Шаг 3: старая спека и статус.** В `docs/specs/2026-10-02-plans-backlog-design.md`, раздел 2, строку `| Где бэклог | \`.parley/backlog.md\`, в git |` заменить на `| Где бэклог | \`.parley/backlog.md\`, в git; по выбору — \`TODOS.md\` проекта (спека \`2026-10-07-backlog-todos-file-design.md\`) |`. В шапке новой спеки статус: `реализовано в ветке feat/backlog-todos-file`.

- [ ] **Шаг 4: полный прогон.** Из корня worktree: `pnpm build && pnpm test && pnpm lint && pnpm typecheck`. Ожидается: всё зелёное. Красные тесты, не связанные с задачей, сверить с прогоном на `origin/master` (известные флейки — e2e и `fs.watch`) и назвать в отчёте поимённо.

- [ ] **Шаг 5: живая приёмка (раздел 9 спеки).** Dev-окно с отдельным `PARLEY_HOME` (рецепт — `RUN.md`), окно 800×500, проект во временной папке с длинным путём (не короче 120 символов):
  1. В проекте `TODOS.md` и `.parley/backlog.md` с двумя пунктами → на вкладке Backlog плашка → «Use TODOS.md» → пункты в конце `TODOS.md`, `.parley/backlog.md` нет, плашки нет, переключатель на `TODOS.md`. Снимок экрана.
  2. Агент в этом проекте вызывает `backlog_suggest` (правило «Add everything») → строка в `TODOS.md`, вкладка обновилась без «Refresh».
  3. Переключатель обратно → `TODOS.md` байт в байт прежний, новый пункт — в `.parley/backlog.md`.
  4. Проект без `TODOS.md` → плашки нет; переключатель на `TODOS.md` и «Add item» создают `TODOS.md`.
  Записать, что проверено живьём, на какой версии CLI агента, и что не проверено.

- [ ] **Шаг 6: коммит.**

```bash
git add README.md CHANGELOG.md docs/specs/2026-10-02-plans-backlog-design.md docs/specs/2026-10-07-backlog-todos-file-design.md
git commit -m "docs: бэклог в TODOS.md — README, CHANGELOG, ссылки в спеках

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
