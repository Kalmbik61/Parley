# План, этап 8: ревью изменений

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 11, строка 8 таблицы 14.3.

**Итог этапа:**
- вкладка «Изменения» правого сайдбара: шапка `ветка → база`, секции, одна главная
  кнопка, проверка конфликтов до слияния;
- дифф на Monaco со свёрнутым неизменённым;
- заметки к строкам уходят агенту одним блоком.

**Перед стартом.** Сверить с кодом этапов 3–7:
- core и хост: `core/src/work/worktree.ts` (`worktreeDiff`, `mergeWorktree`,
  `isDirty` с `:(exclude).harnas`, `parseNameStatus`, `parsePorcelain`,
  `parseUntrackedPaths`), `core/src/config.ts` (`worktreeRoot`, `HARNAS_WORKTREE_ROOT`),
  `host/src/methods/worktrees.ts`, `host/src/worktrees/worktrees-service.ts`,
  `host/src/errors.ts#HostError` (поле `data`), `host/src/server.ts` (отдаёт `data`);
- IPC: `shared/ipc-error.ts` (`IpcErrorInfo`), `main/ipc.ts` (`withIpcError` и
  `isValidWorkKey` — экспорт с 5.2, `RegisterIpcOptions`), `main/host-connection.ts#HostError`
  (`data` уже несёт), `shared/work-keys.ts` (5.2), `main/atomic-file.ts` (`writeAtomic`,
  `createFileQueue`);
- файлы и Monaco (этап 7): `main/roots.ts#rootPath` (7.1a), `main/files/git-api.ts`
  (`GitRunner`, `gitShow`, `isSafeRev` — 7.1b), `main/files/ipc.ts`,
  `shared/files-types.ts` (`FilesApi` без `gitCommitFiles`), `files/buffer.ts#bufferKey`
  (7.3a), `files/editor/monaco-setup.ts` (`setupMonaco`, `applyEditorTheme`),
  `files/editor/CompareView.tsx` (Monaco diff через `DiffEditor`),
  `test-utils/monaco-mock.ts` (7.3b);
- оболочка: `shell/RightSidebar.tsx` (7.2), `shell/AppShell.tsx` (`SendWithToastDeps`
  окна — 7.2), `shell/ErrorBoundary.tsx`, `store/ui.ts` (`setSidebar` с `tab`, `patchUi`,
  `confirmRestartHost` — 6.3), `layout/store.ts` (`focusedSessionOf` — 7.2, `entries()`),
  `layout/ids.ts#tabId.diff`, `layout/GroupView.tsx` (`LayoutBodyContext`),
  `layout/bodies/DiffBody.tsx`;
- клавиши и палитра: `keys/handler.ts` (`IMPLEMENTED_ACTIONS`, `isActionAvailable` —
  6.1a), `palette/actions.ts` (`runAction`, `ActionContext.ui.showRightTab` — 7.2);
- отправка: `terminal/send.ts` (`sendWithToast`, `SendWithToastDeps` с `onOutcome`,
  `SendOutcome` — 5.4), `attention/focus-target.ts#applyFocusTarget` (4.3),
  `e2e/stub-echo-agent.mjs` (`STUB_BRACKETED` — 5.4);
- прочее: `sidebar/SessionRowMenu.tsx` (3.4: «Changes» открывает вкладку `diff` и есть
  только у сессии с worktree), `components/changes/*` (что заменяется),
  `components/dialogs/ConfirmDialog.tsx`, `lib/capabilities.ts` (`REQUIRED_METHODS`,
  `useHostSupports`), `components/AgentStateDot.tsx`, `shared/strings.ts` (`S.changes`,
  `S.send`, `S.errors.actions`), страж `english-ui.test.ts`.

**Строки интерфейса** — правило индекса («Сквозные ограничения», кусок E.1):
- русские строки интерфейса в «…» ниже — смысл, а не текст. Текст — английский, ключом
  `S` в `packages/desktop/src/shared/strings.ts`: ключ и английский стоят в «Интерфейсах»
  куска. Кусок, который добавляет строки, вносит `shared/strings.ts` в «Изменить»;
- тесты и E2E ждут английский текст;
- тексты для агента — «Попросить агента разрешить» (`askAgentText`) и заметки
  (`formatNotes`) — тоже английские шаблоны из `S`: текст видно и можно править в окне,
  а русский литерал в `review/` страж `english-ui` не пропустит;
- ошибки хоста окно показывает по коду и причине: `HostError.data.reason` ошибок git
  (8.1) — `S.changes.gitMissing`, `S.changes.notARepo`; прочее —
  `errorText(decodeIpcError(err).code, S.errors.actions.<действие>)`. Сообщение хоста —
  русский текст, пришедший в рантайме, страж его не видит: только в консоль;
- путь, ветка, hash, тема и автор коммита, ярлык сессии (`S02`), текст заметки — данные,
  а не строки интерфейса: идут как есть. Время — `en-US`.

**Шесть кусков вместо четырёх.** 8.2 и 8.4 переросли «1–2 задачи» и разрезаны (сверка
этапа 8, по образцу 6.1a/6.1b и 7.3a/7.3b):
- 8.2a — данные «Изменений» без разметки: причина ошибки git через IPC, `review/state.ts`,
  `use-changes.ts`, стор ревью;
- 8.2b — вкладка «Изменения», главная кнопка, меню и клавиши;
- 8.4a — заметки без разметки: хранение в main, модель, формат, переезд;
- 8.4b — заметки в диффе, отправка, E2E и приёмка этапа.

В планах 7 и 9 «8.2» и «8.4» читаются как пары 8.2a/8.2b и 8.4a/8.4b.

---

## 8.1. core и хост: статистика диффа, коммиты, `mergeCheck`, изменения папки

**Зачем.** Окну нужны числа `+/−`, список коммитов ветки и знание о конфликтах до
слияния.
**Зависит от:** 3.1. **Спека:** 3.2, 11.5.

**Файлы**
- Изменить:
  - `packages/core/src/work/worktree.ts` и тест — расширенный `worktreeDiff` (`files`
    заново, `uncommittedPaths`, числа, коммиты), `mergeCheck`, `projectChanges`,
    `commitProject`, `gitStateReason`; `isDirty` исключает `.harnas` по пути проекта;
    конфликты `mergeWorktree` — с `-z`; `DiffFile` экспортируется;
  - `packages/core/src/index.ts` — экспорт, в том числе `DiffFile`, `BranchCommit`,
    `ProjectChanges`, `MergeCheck`, `GitStateError`, `NothingToCommitError` и
    разборщиков `-z` для 8.3;
  - `packages/protocol/src/methods.ts` и тест — `worktrees.mergeCheck`,
    `changes.project`, `changes.commitProject` (схемы и `Results`), расширенный
    `WorktreeDiff`, параметр `patch` у `worktrees.diff`;
  - `packages/host/src/worktrees/worktrees-service.ts` и тест — `mergeCheck`,
    `projectChanges`, `commitProject`, `gitFailure`: правила методов живут здесь, как у
    прежних `worktrees.*`;
  - `packages/host/src/methods/worktrees.ts` — обработчик `worktrees.mergeCheck`,
    `patch` у `worktrees.diff`. Своего теста у файла нет: правила проверяет тест
    сервиса;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` + три
    метода.
- Создать: `packages/host/src/methods/changes.ts` — обработчики `changes.*`: разбор
  параметров и форма ответа.

**Интерфейсы** — типы спеки 3.2 (`WorktreeDiff`, `DiffFile`, `BranchCommit`,
`ProjectChanges`) дословно, плюс:

```ts
// core/work/worktree.ts
export interface DiffFile {        // был внутренним; поля спеки 3.2
  path: string; status: 'A' | 'M' | 'D' | 'R'; oldPath: string | null;
  additions: number | null; deletions: number | null;
}
// WorktreeDiff спеки 3.2, дополнение (решение сверки, I3)
/** Пути с незакоммиченным в рабочем дереве worktree (porcelain -z, у R — новый путь): секция «Незакоммиченные». */
uncommittedPaths: string[];

export type MergeCheck = { status: 'clean' } | { status: 'conflicts'; files: string[] } | { status: 'unsupported' };
export async function mergeCheck(projectPath: string, info: WorktreeInfo): Promise<MergeCheck>;
/**
 * Код и stdout `git merge-tree --write-tree --name-only --no-messages -z`: 0 и id дерева первым полем — clean;
 * 1 и id дерева — conflicts (поля после id, без пустых и дублей); 129 — unsupported. Прочее, в том числе
 * код 1 без id дерева (ветки нет), — null: mergeCheck бросает ошибку.
 */
export function parseMergeTree(code: number, stdout: string): MergeCheck | null;
/** --numstat -z: у R и у --no-index путь — второй из пары (первый у --no-index — /dev/null). */
export function parseNumstat(raw: Buffer): Array<{ path: string; oldPath: string | null; additions: number | null; deletions: number | null }>;
/** `--name-status -z -M`: статус и старый путь; с parseNumstat собирает DiffFile — ими же пользуется files.gitCommitFiles (8.3). */
export function parseNameStatusZ(raw: Buffer): Array<{ path: string; oldPath: string | null; status: DiffFile['status'] }>;
/** `status --porcelain=v1 -z`: пути записей; у R и C старый путь — следующее поле без XY, пропускается. */
export function parsePorcelainPaths(raw: Buffer): string[];
export function joinDiffFiles(status: ReturnType<typeof parseNameStatusZ>, numstat: ReturnType<typeof parseNumstat>): DiffFile[];
export function parseCommits(raw: string): BranchCommit[];   // --format=%H%x00%s%x00%an%x00%aI, записи через \n
export async function worktreeDiff(projectPath: string, info: WorktreeInfo, options?: { patch?: boolean }): Promise<WorktreeDiff>;
export async function projectChanges(projectPath: string, options?: { patch?: boolean }): Promise<ProjectChanges>;
export async function commitProject(projectPath: string, message: string): Promise<{ commit: string }>;
/** Изменён только .harnas/ или ничего: commitProject не коммитит, хост отвечает conflict. */
export class NothingToCommitError extends Error {}
export type GitStateReason = 'git-missing' | 'not-a-repo' | 'no-commits';
/** Отказ функций выше, когда причина — состояние git папки; сообщение — для консоли. */
export class GitStateError extends Error { readonly reason: GitStateReason }
/**
 * Причина отказа git-вызова без разбора stderr (у человека git локализован): ENOENT запуска — git-missing;
 * `rev-parse --is-inside-work-tree` в projectPath не true — not-a-repo; `rev-parse --verify -q HEAD` не
 * прошёл — no-commits; иначе null — отказ по другой причине, он и бросается.
 */
export async function gitStateReason(projectPath: string, error: unknown): Promise<GitStateReason | null>;

// protocol/methods.ts — параметр только добавляется: старый хост его отбросит, старое окно не шлёт
'worktrees.diff':        z.object({ ref: sessionRef, patch: z.boolean().optional() }),   // false — patch: ''
'worktrees.mergeCheck':  z.object({ ref: sessionRef }),
'changes.project':       z.object({ ref: sessionRef, patch: z.boolean().optional() }),
'changes.commitProject': z.object({ ref: sessionRef, message: z.string().min(1).max(10000) }),
// Results
'worktrees.mergeCheck': MergeCheck;
'changes.project': ProjectChanges;
'changes.commitProject': { commit: string };

// host/worktrees/worktrees-service.ts, дополнение WorktreesService
diff(ref: SessionRef, patch?: boolean): Promise<WorktreeDiff>;
mergeCheck(ref: SessionRef): Promise<MergeCheck>;
projectChanges(ref: SessionRef, patch?: boolean): Promise<ProjectChanges>;
commitProject(ref: SessionRef, message: string): Promise<{ commit: string }>;
/**
 * Ошибка git → HostError с причиной в data: окно показывает свой английский текст по ней (8.2a), сообщение
 * хоста — только в консоль. GitStateError: git-missing — internal, not-a-repo и no-commits — bad_request,
 * data: { reason }; NothingToCommitError — conflict; прочее — internal без data.
 */
export function gitFailure(error: unknown): HostError;
```

**Поведение**
- **Пути — с `-z`** (решение сверки, I4). Без него git берёт путь с кириллицей в
  кавычки с восьмеричными кодами (`"\321\204…txt"`): такой путь не совпал бы ни с
  файлом, ни с `gitShow`, а список конфликтов ушёл бы агенту кодами. Поэтому с `-z` все
  вызовы 8.1 с путями: numstat, name-status, porcelain, `merge-tree`, неотслеживаемые.
  Конфликты отказа `mergeWorktree` — тоже `git diff --name-only -z --diff-filter=U`:
  их показывает секция «Конфликты» (8.2b). Нынешний `parseUntrackedPaths` разбирает
  porcelain без `-z` и передаёт путь в кавычках в `git diff --no-index`: `worktrees.diff`
  падает целиком, если в worktree есть новый файл с кириллицей. Он уходит вместе с
  `parsePorcelain` и `parseNameStatus`.
- **Чтение не трогает индекс** (рамка: стейдж — только по кнопке):
  - все чтения — `git --no-optional-locks …`. Иначе фоновые `status` и `diff` раз в 2 с
    брали бы `index.lock` рядом с агентом (в worktree) и человеком (в папке базы);
  - неотслеживаемые — `git ls-files --others --exclude-standard -z`, их числа —
    `git diff --no-index --numstat -z -- /dev/null <файл>`, а не `git add -N`. Код 1 у
    `--no-index` — «отличаются», не сбой; запись приходит в двухпутевой форме, как у
    переименования. Двоичный (`-\t-`) → `null`.
- **`worktreeDiff`** — в `info.path`, кроме `merge-base` и `log` (они — в
  `projectPath`):
  - `mergeBase` уже вычисляется;
  - `files` строятся заново (решение сверки, M9): `git diff -M --name-status -z
    <mergeBase>` и `--numstat -z` того же сравнения по рабочему дереву
    (`joinDiffFiles`) плюс неотслеживаемые со статусом `A`. Прежнее объединение
    «закоммиченное ∪ porcelain» для `files` уходит: список и числа считаются по одной паре
    сторон;
  - `uncommittedPaths` — `git status --porcelain=v1 -z --untracked-files=all`
    (`parsePorcelainPaths`); `uncommitted` — `uncommittedPaths` не пуст;
  - `stats` — сумма без `null`;
  - `commits` — `git log -n 200 <mergeBase>..<branch>`, свежие первыми;
  - патч (без `patch: false`) — как сейчас; неотслеживаемые для него — из того же
    `ls-files -z`.
- **`patch: false`** у `worktrees.diff` и `changes.project` — патч не строится, в ответе
  `patch: ''`. Новое окно (8.2a) патч не просит: строка протокола ограничена 8 МБ
  (`protocol/src/framing.ts`), и дифф с lock-файлами обрушил бы вкладку. Без параметра —
  патч целиком, как сейчас: им живёт прежняя панель до 8.3.
- **`mergeCheck`** — `git merge-tree --write-tree --name-only --no-messages -z <base>
  <branch>` в `projectPath`, разбор — `parseMergeTree`:
  - код 0 и id дерева → `clean`;
  - код 1 и id дерева → `conflicts`: поля после id, без пустых и дублей;
  - код 129 → `unsupported`: git старше 2.38 не знает `--write-tree` и отвечает разбором
    параметров. Stderr не разбирается: у человека git локализован («использование: …»);
  - прочее — ошибка, в том числе код 1 без id дерева. Так `merge-tree` отвечает на
    несуществующую ветку (база переименована), и без проверки вышел бы «конфликт без
    файлов»;
  - рабочие копии не трогаются.
- **`.harnas/` — не изменения проекта.** Состояние харнесса (карта, журналы хуков,
  письма, брифы) лежит в `<проект>/.harnas/works/<id>/`, и без `.gitignore` git его не
  отслеживает. Иначе «Незакоммиченные» не пустели бы никогда, а первое «Закоммитить всё
  в папке» положило бы журналы в историю — по README это решение человека. Поэтому все
  команды `changes.*` идут с `-- . ':(exclude).harnas'`: дифф, numstat, список
  неотслеживаемых, `git add -A` и сам коммит. Так же уже делает `isDirty` в core — но
  от корня рабочей копии. У проекта-подкаталога журналы лежат в `<sub>/.harnas`, и
  `base_dirty` держался бы всегда (решение сверки, M8). Поэтому `isDirty` исключает
  `:(exclude)<prefix>.harnas`, где `prefix` — `git rev-parse --show-prefix` в
  `projectPath`.
- **`changes.project`:**
  - `git diff -M --relative HEAD` с name-status, numstat и неотслеживаемыми в
    `projectPath`, без `.harnas/`. `--relative` даёт пути от папки проекта, а не от корня
    репозитория (`ls-files --others` и так отдаёт их от cwd). Иначе у
    проекта-подкаталога `readText` и `gitShow` корня `project` не нашли бы файлов;
  - `branch` — `git rev-parse --abbrev-ref HEAD`, `HEAD` → `null`.
- **`changes.commitProject`:**
  - `git add -A -- . ':(exclude).harnas'`, затем `git diff --cached --quiet` с тем же
    pathspec: код 0 — нечего коммитить (изменён только `.harnas/` или ничего) →
    `NothingToCommitError`, хост отвечает `conflict` «нет изменений»;
  - `git commit -m <message> -- . ':(exclude).harnas'` (решение сверки, M6). Без
    pathspec `git commit` взял бы весь индекс: подготовленное человеком вне папки проекта
    (проект — подкаталог) и `.harnas/`, если его кто-то добавил. С pathspec чужое
    подготовленное остаётся в индексе нетронутым;
  - пустое сообщение и длиннее 10 000 символов отвергает схема.
- **Сессия с worktree** на `changes.project` и на `changes.commitProject` получает
  `bad_request` «у сессии свой worktree — смотрите worktrees.diff» (спека 11.5).
- **Ошибки git** — `gitFailure` (решение сверки, C1):
  - причина едет в `HostError.data.reason`. Окно показывает свой английский текст по ней,
    а русский текст хоста — только в консоль (8.2a). По одному коду «Git не найден» и
    «Папка не под git» не различить;
  - причину находит `gitStateReason` у всех функций 8.1, без разбора stderr. На русской
    macOS git пишет «fatal: не найден git репозиторий», и сверка по «not a git
    repository» промахнулась бы;
  - `server.ts` уже отдаёт `data` у `HostError`, как у `protocol_mismatch`.

**Тесты** (временные репозитории, настоящий `git`)
1. `parseNumstat` (`-z`):
   - обычный файл;
   - двоичный (`-\t-`) → `null`;
   - переименование с `-M` → `oldPath`;
   - запись `--no-index` (`/dev/null` и путь) → путь, `oldPath: null`.
2. `parseNameStatusZ`: `R100\0old\0new\0` → `R` с `oldPath`. `parsePorcelainPaths`:
   `RM new\0old\0?? файл.txt\0` → `['new', 'файл.txt']`.
3. `worktreeDiff`:
   - две правки, одно переименование, один новый файл → `files` с числами, `stats` —
     сумма, `commits` — два коммита ветки в порядке «свежие первыми»;
   - `uncommittedPaths` — только незакоммиченные пути; после `git commit -a` в worktree
     он пуст, а файлы коммита остались в `files`.
4. Кириллица:
   - новый `файл.txt` в worktree — `worktrees.diff` не падает, путь в `files` и
     `uncommittedPaths` как есть;
   - конфликт в `файл.txt`: `mergeCheck` → `conflicts: ['файл.txt']`, отказ
     `mergeWorktree` — `files: ['файл.txt']`.
5. `mergeCheck`:
   - непересекающиеся правки → `clean`;
   - правка одной строки в базе и в ветке → `conflicts: ['a.txt']`;
   - рабочие копии не изменились (`git status` чист).
6. `parseMergeTree`:
   - `(0, '<id>\0')` → `clean`;
   - `(1, '<id>\0a.txt\0a.txt\0файл.txt\0')` → `conflicts: ['a.txt', 'файл.txt']`;
   - `(129, '')` → `unsupported`;
   - `(1, '')` — ветки нет, id дерева нет → `null`; `mergeCheck` с несуществующей базой
     бросает.
7. `projectChanges` и причины (тест текст stderr не читает, локаль git любая):
   - с правкой — `files` и `branch`; detached HEAD → `branch: null`;
   - папка без коммитов → `GitStateError` с `no-commits`; папка не под git →
     `not-a-repo`; `PATH` без git (переменная на время вызова) → `git-missing`.
8. Проект — подкаталог `sub/` репозитория:
   - `projectChanges` — пути от `sub` (`a.txt`, а не `sub/a.txt`), новый
     `sub/новый.txt` — `новый.txt`; правки `top.txt` вне `sub` в ответе нет;
   - неотслеживаемый `sub/.harnas/works/w/log.jsonl` в папке базы → `baseDirty: false`.
9. `.harnas/`:
   - неотслеживаемый `.harnas/works/w-01/events/s-01.jsonl` и правка `a.txt` → в `files`
     только `a.txt`;
   - `commitProject` → в коммите нет `.harnas/` (`git show --name-only`);
   - изменён только `.harnas/` → `NothingToCommitError`;
   - проект — подкаталог: файл, подготовленный человеком вне него (`git add ../top.txt`),
     в коммит не попал и остался подготовленным.
10. Индекс не тронут: после `worktreeDiff` и `projectChanges` с неотслеживаемым файлом
    `.git/index` проекта и индекс worktree побайтно прежние, `git diff --cached` пуст.
11. `worktrees.diff` с `patch: false` → `patch: ''`, `files` и `stats` те же; без
    параметра — патч как раньше.
12. Сервис хоста: `changes.project` и `changes.commitProject` для сессии с worktree →
    `bad_request`; `commitProject` без изменений → `conflict`.
13. `gitFailure`:
    - `git-missing` → `internal` с `data: { reason: 'git-missing' }`;
    - `not-a-repo` и `no-commits` → `bad_request` со своей причиной;
    - `NothingToCommitError` → `conflict`;
    - прочая ошибка → `internal` без `data`.
14. Протокол: схемы трёх методов и `patch`; `changes.commitProject` с пустым сообщением
    и с 10 001 символом — отказ схемы. `REQUIRED_METHODS` содержит три метода,
    `missingMethods` нового хоста пуст.

**Приёмка**
- [ ] Все тесты зелёные во всех пакетах — сверка с базовым прогоном (индекс, «Правила
      проверки»).

---

## 8.2a. Данные «Изменений»: причина ошибки git, состояние, загрузка, стор ревью

**Зачем.** Вкладке «Изменения» и вкладке диффа нужны одна загрузка с правилами
обновления, таблица главной кнопки и причина ошибки git — до разметки.
**Зависит от:** 8.1, 7.3a (`bufferKey`), 7.2 (`focusedSessionOf`), 5.4 (`S.send`).
**Спека:** 11.1, 11.2, 11.5, 13.

**Файлы**
- Создать в `packages/desktop/src/renderer/review/`:
  - `state.ts` и тест;
  - `use-changes.ts` и тест;
  - `store.ts` и тест — несохраняемый стор ревью.
- Изменить:
  - `src/shared/ipc-error.ts` и тест — `IpcErrorInfo.data`;
  - `src/main/ipc.ts` и `ipc.test.ts` — `withIpcError` отдаёт `HostError.data`;
  - `src/shared/strings.ts` — строки ниже.

**Интерфейсы**

```ts
// shared/ipc-error.ts, дополнение IpcErrorInfo
/** HostError.data хоста — машинные подробности: у ошибок git 8.1 это { reason }. Не объект — поля нет. */
data?: Record<string, unknown>;

// main/ipc.ts — withIpcError (экспорт с 5.2): HostError → encodeIpcError({ code, message, data }),
// data — только если есть; FilesDeniedError и прочее — как было

// review/state.ts
export type ChangesSource =
  | { kind: 'worktree'; diff: WorktreeDiff; check: MergeCheck | null }
  | { kind: 'project'; changes: ProjectChanges }
  | { kind: 'pending' };            // worktree запланирован (createdAt: null): вызовов нет
export type PrimaryAction =
  | { kind: 'commit-project' } | { kind: 'commit' }
  | { kind: 'merge'; base: string } | { kind: 'ask-agent'; files: string[] }
  | { kind: 'nothing' };
/** Таблица спеки 11.2; check: null (ещё не пришёл, не звали или отказал) — как unsupported. */
export function primaryActionFor(source: ChangesSource): PrimaryAction;
/** Секции файлов: uncommitted — files с путём из uncommittedPaths (у project — все files), branch — остальные. */
export function changesSections(source: ChangesSource): { uncommitted: DiffFile[]; branch: DiffFile[] };
/** Тост ответа worktrees.merge — таблица спеки 11.2; conflicts — файлы для секции «Конфликты». */
export function mergeResultText(result: MergeResult, base: string): { text: string; conflicts: string[] | null };
/** Текст спеки 11.2 для «Попросить агента разрешить» — английский шаблон из S. */
export function askAgentText(branch: string, base: string, files: string[]): string;
/** Тело вкладки при отказе загрузки: git-missing — S.changes.gitMissing, not-a-repo — S.changes.notARepo, прочее — errorText(code, S.errors.actions.loadChanges). */
export function changesErrorText(error: IpcErrorInfo): string;
/** Текст влезает в один pty.send: UTF-8 не больше 65 536 байт (5.1). */
export function fitsSendLimit(text: string): boolean;

// review/use-changes.ts
/** Загрузка diff/mergeCheck или changes.project по сессии, всегда с patch: false; обновление по правилам 11.1, не чаще раза в 2 с. */
export function useChanges(input: {
  bridge: HarnasBridge; entry: WorkEntry; sessionId: string | null;
  /** false — без mergeCheck: вкладке диффа (8.3) нужны файлы и сигналы обновления, а не проверка. По умолчанию true. */
  mergeCheck?: boolean;
}): { source: ChangesSource | null; loading: boolean; error: string | null; refresh(): void };

// review/store.ts — не сохраняется: ни в ui.json, ни в раскладку
export interface ReviewState {
  /** Выбор сессии в шапке «Изменений» по работе; записи нет — сессия в фокусе. */
  changesSession: Record<string /* workKey */, string /* sessionId */>;
  selectChangesSession(workKey: string, sessionId: string): void;
  /** Разовый переход вкладки диффа к файлу; ключ — bufferKey(workKey, tabId) (7.3a). */
  revealed: Record<string, { path: string; nonce: number }>;
  revealFile(workKey: string, tabId: string, path: string): void;
}
export const useReviewStore: UseBoundStore<StoreApi<ReviewState>>;
/** Сессия шапки «Изменений»: выбор человека, пока сессия в карте; иначе focusedSessionOf (7.2). */
export function changesSessionOf(
  review: Pick<ReviewState, 'changesSession'>, layout: Pick<LayoutState, 'layouts' | 'entries'>,
  workKey: string, entry: WorkEntry,
): string | null;
/** Смена активной работы стирает выбор той, с которой ушли: подписка на activeWorkKey стора раскладки (AppShell, 8.2b). */
export function bindReviewToLayout(): () => void;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
changes: {
  gitMissing: 'Git not found',                                   // «Git не найден»
  notARepo: 'This folder is not a git repository',               // «Папка не под git»
  merged: (base: string) => string,                              // 'Merged into master'
  mergeFailed: {
    baseNotCheckedOut: (base: string) => string,   // "master isn't checked out anywhere — check it out in the project folder"
    baseDirty: (base: string) => string,           // 'master has uncommitted changes — commit or stash them'
    uncommitted: 'The worktree has uncommitted changes — commit first',
    conflict: (files: string) => string,           // 'Merge conflict in src/a.ts, src/b.ts'
  },
  askAgentIntro: (branch: string, base: string) => string,
                                     // 'Branch harnas/w-0003/s02 has merge conflicts with master in:'
  askAgentInstruction: (base: string) => string,
                                     // 'Merge master into your branch (git merge master), resolve the conflicts, commit, and tell me what you did.'
},   // прежние ключи S.changes живут до 8.3: ими рисует старая панель
send: { tooLong: 'Too long for one message to the agent — 64 KB max' },
```

**Поведение**
- **Причина ошибки через IPC** (решение сверки, C1):
  - `withIpcError` кладёт `HostError.data` в `encodeIpcError`, `decodeIpcError`
    сохраняет `data`, если это объект. Нужна она ради `reason` ошибок git 8.1: по одному
    коду `internal` или `bad_request` «Git не найден» и «Папка не под git» не различить,
    а `withIpcError` сейчас `data` теряет;
  - подставной мост отказывает объектом `{ code, message, data }` из обработчика
    `setHandler` — `decodeIpcError` берёт его как есть.
- **`changesErrorText`** — тело вкладки: `git-missing` — «Git не найден», `not-a-repo` —
  «Папка не под git» (спека 13); прочее, в том числе `no-commits`, —
  `errorText(code, S.errors.actions.loadChanges)`. Сообщение хоста — `console.warn`.
- **`primaryActionFor`** — таблица спеки 11.2 по порядку строк:
  - `project`: есть файлы → `commit-project`, нет → `nothing`;
  - `pending` → `nothing`;
  - `worktree`: `uncommitted` → `commit`, в том числе при конфликтах: слияние всё равно
    откажет `uncommitted`, а секция «Конфликты» видна;
  - есть коммиты ветки: `conflicts` → `ask-agent`; `clean`, `unsupported` и `check:
    null` → `merge` (конфликт узнаётся при слиянии, как сейчас); иначе `nothing`.
- **`changesSections`** (решение сверки, I3). `files` — всё отличие от `mergeBase`:
  закоммиченное в ветке и рабочее дерево вместе, а `uncommitted` — один флаг на весь
  дифф. Секция, показывающая `files`, не пустела бы после коммита. Поэтому:
  - у `worktree` «Незакоммиченные» — `files` с путём из `uncommittedPaths`, «Изменения
    ветки» — остальные: то, что уже в коммитах ветки;
  - путь из `uncommittedPaths` без записи в `files` (правка вернула файл к `mergeBase`)
    не показывается, кнопку «Закоммитить» держит `uncommitted`;
  - у `project` всё — «Незакоммиченные».
- **Тексты** — английские из `S` (строки выше):
  - `mergeResultText` — таблица 11.2 и успех «Merged into master»; `conflict` отдаёт
    файлы ответа в `conflicts`;
  - `askAgentText` — шаблон 11.2: `askAgentIntro`, по строке `- <путь>` на файл,
    `askAgentInstruction`.
- **`fitsSendLimit`** (решение сверки, M10) — UTF-8 текста до 65 536 байт, предел
  `pty.send` (5.1). Длиннее хост ответил бы `bad_request`, и тост сказал бы только
  «failed». Окно такой текст не шлёт, а показывает `S.send.tooLong` (8.2b, 8.4b).
- **`useChanges`:**
  - `pending` (`worktree.createdAt: null`) — вызовов нет;
  - сессия с worktree — `worktrees.diff { patch: false }`; после него, если у ветки есть
    коммиты и `mergeCheck` не выключен, — `worktrees.mergeCheck`. Отказ проверки —
    `check: null` и `console.warn`: тело вкладки из-за фоновой проверки не ломается;
  - без worktree — `changes.project { patch: false }`;
  - обновление — спека 11.1, не чаще раза в 2 с: монтирование; `works.changed`, в котором
    карта этой работы изменилась; переход сессии из `working` (`useActivityStore`);
    `refresh()` — сразу, мимо дросселя: кнопка «Обновить» и своё действие 8.2b;
  - «карта изменилась» — сравнение `JSON.stringify(entry.map)` с прошлым. Событие
    несёт весь снимок, объекты у каждого события новые, а карты малы. Изменение другой
    работы вкладку не будит (решение сверки, M16);
  - ответ запроса прежней сессии отбрасывается;
  - каждая загрузка — новый объект `source`: по нему вкладка диффа перечитывает стороны
    (8.3).
- **Стор ревью** (решение сверки, I8). Выбор сессии в шапке нигде не хранится, а
  `SessionRowMenu` до состояния панели не дотянется. `TabSpec` вида `diff` несёт только
  `sessionId` и `commit`, а путь в нём менял бы сохраняемый формат раскладки. Поэтому
  `review/store.ts`:
  - `changesSession` — выбор сессии в шапке по работе. `bindReviewToLayout` стирает
    выбор работы, с которой ушли: «выбор в шапке — до смены работы» (спека 11.1);
  - `changesSessionOf` — выбор, пока сессия в карте; иначе `focusedSessionOf(state,
    workKey)` (7.2): одна «сессия в фокусе» на «Файлы» и «Изменения»;
  - `revealFile(workKey, tabId, path)` — разовый переход вкладки диффа к файлу. `nonce`
    растёт на каждый вызов: повторный клик по тому же файлу снова прокручивает (8.3).
    Ключ — `bufferKey(workKey, tabId)`: id вкладки `diff:s-02` одинаков у двух работ.

**Тесты**
1. `primaryActionFor` — каждая строка таблицы 11.2, включая `unsupported` → `merge`;
   всё закоммичено, есть коммиты, `check: null` → `merge`; `pending` → `nothing`;
   `uncommitted` и конфликты разом → `commit`.
2. `mergeResultText` для четырёх причин и успеха — английские тексты: `master isn't
   checked out anywhere — check it out in the project folder`, `master has uncommitted
   changes — commit or stash them`, `The worktree has uncommitted changes — commit
   first`, `Merge conflict in src/a.ts, src/b.ts` с `conflicts`, `Merged into master`.
3. `askAgentText` для двух файлов совпадает с английским шаблоном; `файл.txt` — как
   есть.
4. `changesSections`: у worktree — по `uncommittedPaths`; у project — всё в
   `uncommitted`; путь из `uncommittedPaths` без записи в `files` не показан.
5. `changesErrorText`: `data.reason` `git-missing` → `Git not found`; `not-a-repo` →
   `This folder is not a git repository`; `no-commits` и `bad_request` без причины →
   `Couldn't load changes: invalid request.`
6. `fitsSendLimit`: 65 536 байт ASCII → `true`, 65 537 → `false`; 32 769 букв «я»
   (65 538 байт) → `false`.
7. IPC:
   - `encodeIpcError`/`decodeIpcError` с `data` туда и обратно; `data` не объект — поля
     нет;
   - `withIpcError`: `HostError('bad_request', 'm', { reason: 'not-a-repo' })` →
     `decodeIpcError` отдаёт `data.reason`; `HostError` без `data` — поля нет, как
     раньше.
8. `useChanges` (поддельные таймеры):
   - три `works.changed` этой работы за секунду → один `worktrees.diff` с
     `patch: false`;
   - `works.changed`, где изменилась только другая работа, → вызова нет;
   - переход из `working` → обновление; `refresh()` — сразу, мимо дросселя;
   - `worktrees.mergeCheck` — после `diff` с коммитами; с `mergeCheck: false` — нет;
     отказ проверки → `check: null`, `error: null`;
   - `pending` → ни `worktrees.diff`, ни `changes.project`.
9. `review/store`:
   - выбор S03 в работе A, смена активной работы на B → выбора A нет;
   - `changesSessionOf`: выбранная сессия пропала из карты → `focusedSessionOf`;
   - `revealFile` дважды с тем же путём — `nonce` вырос.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 8.2b. Вкладка «Изменения», главная кнопка, меню

**Зачем.** Одна кнопка ведёт от правки агента до слияния, без знания git-команд.
**Зависит от:** 8.2a, 6.3 (`runAction`, `confirmRestartHost`), 5.4 (`sendWithToast`).
**Спека:** 11.1, 11.2.

**Файлы**
- Создать в `packages/desktop/src/renderer/review/`: `ChangesPanel.tsx`,
  `PrimaryAction.tsx`, `ConflictsSection.tsx`, `AskAgentDialog.tsx` и тесты.
- Изменить:
  - `renderer/shell/RightSidebar.tsx` и тест — вкладка «Изменения» (⌘⇧G), проп
    `sendDeps`; тест 9 куска 7.2 («`tab: 'changes'` показывает `Files`»)
    переписывается;
  - `renderer/shell/AppShell.tsx` и `AppShell.test.tsx` — `sendDeps` в `RightSidebar`,
    `bindReviewToLayout()` при монтировании; ⌘⇧G;
  - `renderer/keys/handler.ts` и тест — `sidebar.changes` в `IMPLEMENTED_ACTIONS`;
  - `renderer/palette/actions.ts` и тест — ветка `sidebar.changes`; строка в таблице
    теста 1 куска 6.3;
  - `renderer/sidebar/SessionRowMenu.tsx` и тест — «Changes» у каждой сессии открывает
    вкладку «Изменения» правого сайдбара, а не вкладку `diff`. `CardMenu` не меняется:
    пункта «Изменения» у карточки нет (спека 6.4);
  - `src/shared/strings.ts` — строки ниже.

**Интерфейсы**

```ts
// review/ChangesPanel.tsx — тело вкладки «Изменения» правого сайдбара
export interface ChangesPanelProps {
  bridge: HarnasBridge;
  workKey: string;
  entry: WorkEntry;                 // активная работа
  sendDeps: SendWithToastDeps;      // окна, из AppShell (7.2)
}

// review/AskAgentDialog.tsx
export interface AskAgentDialogProps {
  open: boolean;
  ref: SessionRef;                  // сессия worktree
  initialText: string;              // askAgentText (8.2a)
  sendDeps: SendWithToastDeps;
  onOpenChange(open: boolean): void;
}

// shell/RightSidebar.tsx, дополнение пропов (7.2)
sendDeps: SendWithToastDeps;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
common: { send: 'Send' },
changes: {
  panel: 'Changes',                                      // вкладка правого сайдбара
  headerMenu: 'Changes options',                         // aria-label «⋯»
  sessionPicker: 'Session',                              // aria-label выбора сессии в шапке
  noSession: 'Choose a session to see its changes',
  commitCount: (n: number) => string,                    // '1 commit', '12 commits'
  projectFolder: (branch: string | null) => string,      // 'master (project folder)'; null — 'Detached HEAD (project folder)'
  projectFolderWarning: "A commit takes every change in the folder, not only this session's",
  worktreePending: 'The worktree will be created when the session starts',
  sections: { conflicts: 'Conflicts', uncommitted: 'Uncommitted', branchChanges: 'Branch changes', commits: 'Branch commits' },
  commit: 'Commit',
  commitProject: 'Commit all in folder',
  askAgent: 'Ask agent to resolve',
  commitConfirmTitle: (branch: string) => string,        // 'Commit to harnas/w-0003/s02?'
  mergeConfirmTitle: (branch: string, base: string) => string,   // 'Merge harnas/w-0003/s02 into master?'
  mergeConfirmDescription: (commits: number, additions: number, deletions: number, base: string, checkout: string) => string,
                                                         // '3 commits, +120 −34. master is checked out in /Users/me/proj.'
  agentStillWorking: 'The agent is still working — changes may be incomplete',
  askAgentTitle: (session: string) => string,            // 'Ask S02 to resolve conflicts'
  discardWorktreeEllipsis: 'Discard worktree…',
  discardWorktreeTitle: (session: string) => string,     // 'Discard the worktree of S02?'
  discardWorktreeDescription: 'The session will be stopped and closed. Its worktree folder and branch will be deleted.',
},   // живут дальше прежние: mergeInto ('Merge into master'), commitMessagePlaceholder, noChanges, loading,
     // discard, discardAllConfirmTitle, discardAllConfirm, fileStatus (подсказка буквы файла);
     // Refresh — S.files.refresh (7.2); Host is outdated — restart — S.statusBar.hostOutdated
errors: { actions: { discardWorktree: 'discard worktree' } },   // коммит обоих видов — commit, слияние — merge (E.1)
```

**Поведение**
- **Хост старее окна** (решение сверки, I9). После обновления приложения прежний хост
  продолжает работать (спека 3.2): его `worktrees.diff` отвечает без `stats`, `commits`
  и `mergeBase`, и отрисовка упала бы на `diff.stats.additions`. Поэтому вкладка — только
  при `useHostSupports('worktrees.mergeCheck')`, признаке хоста этапа 8. Без него —
  тело-кнопка «Host is outdated — restart»: клик — `confirmRestartHost()` стора
  `store/ui.ts` (6.3), тот же `ConfirmDialog` строки статуса. Вызовов
  `worktrees.diff` и `changes.project` нет.
- **Сессия шапки** — `changesSessionOf` (8.2a): выбор в шапке, пока работа та же;
  иначе сессия вкладки терминала или диффа активной группы, иначе самой свежей записи
  `entries()` этой работы с такой вкладкой ещё в раскладке (7.2). Сессии нет — текст
  «Выберите сессию» и выбор в шапке.
- **Шапка:**
  - выбор сессии работы; `ветка → база`, чип `+a −d` (`stats`), «N коммитов»;
  - «⋯»: «Обновить» (`refresh()`), «Отбросить worktree…» (ниже);
  - без worktree — `ветка (папка проекта)` и предупреждение спеки 11.1;
  - worktree ещё не создан (`createdAt: null`) — «Worktree появится при запуске
    сессии», ни `worktrees.diff`, ни `changes.project`, кнопка «Нет изменений».
- **Секции** (сворачиваются): «Конфликты», «Незакоммиченные», «Изменения ветки»
  (`changesSections`, 8.2a), «Коммиты ветки».
  - Файл — буква статуса (подсказка — `S.changes.fileStatus`), `+a −d`, путь.
  - Клик по файлу любой секции — вкладка `diff` сессии в активной группе (`openTab`) и
    `revealFile(workKey, tabId.diff(sessionId, null), path)`: переход к файлу делает
    8.3. До 8.3 тело вкладки — прежний `DiffBody`: у сессии без worktree он показывает
    `This session has no worktree of its own`. Это временно, 8.3 меняет тело (решение
    сверки, M21).
  - Клик по коммиту — вкладка `diff` с `commit`.
- **Главная кнопка** — `primaryActionFor` (решения сверки, M16):
  - поле сообщения (многострочное, ⌘Enter) — у `commit` и `commit-project`; пустое —
    кнопка коммита неактивна. У «Слить» и «Попросить агента» поля нет: пустое поле их
    не блокирует;
  - подтверждения. `commit` — без вопроса, в `working` — вопрос `commitConfirmTitle` со
    строкой «Агент ещё работает — изменения могут быть неполными». `commit-project` —
    вопрос всегда, с предупреждением 11.1 «Коммит заберёт все изменения папки…», в
    `working` — и со строкой про агента. `merge` — вопрос всегда (спека 11.2), в
    `working` — и со строкой про агента;
  - `uncommitted` и конфликты разом — «Закоммитить» (8.2a);
  - после своего коммита, слияния и отбрасывания — `refresh()` сразу, мимо дросселя.
- **Слияние:**
  - подтверждение спеки 11.2: ветка и база, «N коммитов, +a −d», «<база> выгружена в
    <baseCheckout>» → `worktrees.merge`;
  - `baseCheckout: null` — подтверждения нет: сразу тост `mergeResultText` причины
    `base_not_checked_out`, `worktrees.merge` не зовётся — слияние заведомо откажет;
  - ответ — тост `mergeResultText`; `conflict` раскрывает «Конфликты» с файлами ответа
    до следующего обновления.
- **«Попросить агента разрешить»** (решение сверки, I2):
  - `AskAgentDialog` с редактируемым `askAgentText` и получателем — сессией worktree;
  - «Отправить»: `fitsSendLimit`, иначе тост `S.send.tooLong` и отправки нет; затем
    `sendWithToast(sendDeps, ref, text, true)` (5.4). Тосты — таблица спеки 8.6, повтор —
    только кнопкой `Retry` тоста;
  - `sendDeps` — `SendWithToastDeps` окна из `AppShell` (7.2): `session` — из
    `useWorksStore`, `openSession` — `applyFocusTarget` (4.3). В `RightSidebar` — пропом.
- **«Отбросить worktree…»** (решение сверки, I10) — двухшаговый поток прежней панели как
  есть:
  - первый вопрос называет цену: сессия будет остановлена и закрыта, папка worktree и
    ветка удалены. `worktrees.discard` закрывает сессию — это закрытие с согласия (рамка
    15.1, п. 7);
  - чистый worktree — `worktrees.discard { force: false }` после первого вопроса. При
    `uncommitted` — второй вопрос «Незакоммиченное пропадёт», и `force: true` уходит
    только из него. Без `force` хост отвечает `conflict`;
  - второй вопрос — своё состояние: `ConfirmDialog` сам закрывается после `onConfirm`, и
    общий флаг стёр бы переход на второй шаг;
  - у сессии без worktree и у `pending` пункта нет.
- **Ошибки:**
  - загрузка — тело вкладки `changesErrorText` (8.2a): «Git не найден», «Папка не под
    git» (спека 13), прочее — `Couldn't load changes: …`;
  - действия — тост `errorText(code, S.errors.actions.<commit | merge |
    discardWorktree>)`;
  - сообщение хоста — только в консоль.
- **Правый сайдбар** (7.2): вкладка «Изменения» в activity bar, `tab: 'changes'` из
  `ui.json` теперь показывает её.
- **⌘⇧G** — `sidebar.changes` → `ui.showRightTab('changes')` (7.2): открывает сайдбар на
  «Изменениях», открытый не прячет; без активной работы — тост
  `S.errors.noActiveWorkspace` (6.3).
- **Из меню сессии** (решение сверки, M2) «Изменения» есть у каждой сессии, не только
  с worktree: новая вкладка умеет и папку проекта. Пункт:
  - делает работу активной (`setActiveWork`);
  - затем `selectChangesSession(workKey, sessionId)` и `setSidebar('right', { open: true,
    tab: 'changes' })`. Порядок важен: смена работы стирает выбор (8.2a);
  - вкладку `diff` больше не открывает.

**Тесты**
1. `PrimaryAction`:
   - пустое сообщение — неактивны только кнопки коммита, «Merge into master» активна;
   - `commit` вне `working` — `worktrees.commit` без вопроса; в `working` — вопрос со
     строкой `The agent is still working — changes may be incomplete`;
   - `commit-project` — вопрос с `A commit takes every change in the folder, not only
     this session's`;
   - после коммита `worktrees.diff` зовётся сразу, без ожидания 2 с.
2. Слияние:
   - подтверждение с числами → `worktrees.merge`; ответ `conflict` → тост и раскрытые
     `Conflicts` с файлами ответа;
   - `baseCheckout: null` → тост `master isn't checked out anywhere — check it out in
     the project folder`, подтверждения и `worktrees.merge` нет.
3. `AskAgentDialog`:
   - зовёт `pty.send` с отредактированным текстом и `submit: true`;
   - ответ `blocked` показывает тост `S02 is waiting for your answer — text not
     inserted` (`S.send.blocked`);
   - текст больше 64 КБ → тост `Too long for one message to the agent — 64 KB max`,
     `pty.send` нет.
4. Секции: у worktree файл из `uncommittedPaths` — в `Uncommitted`, прочие — в `Branch
   changes`; новый ответ `worktrees.diff` после коммита с пустым `uncommittedPaths` —
   `Uncommitted` пуста; у сессии без worktree всё — в `Uncommitted`.
5. Сессия с `worktree.createdAt: null` → ни `worktrees.diff`, ни `changes.project`,
   текст `The worktree will be created when the session starts`, кнопка `No changes`.
6. Ошибки в теле: отказ `changes.project` с `{ code: 'bad_request', data: { reason:
   'not-a-repo' } }` → `This folder is not a git repository`; с `git-missing` →
   `Git not found`; русского сообщения хоста в DOM нет.
7. Хост без методов 8.1 (`setHostMethods` без них) → тело `Host is outdated — restart`,
   ни `worktrees.diff`, ни `changes.project`; клик открывает подтверждение перезапуска
   (`dialogs.restartHost`).
8. «Discard worktree…»:
   - первый вопрос — `Discard the worktree of S02?` с остановкой и закрытием;
   - чистый worktree — `worktrees.discard { force: false }` после первого;
   - при `uncommitted` — второй вопрос, `force: true` только после него; отмена второго —
     вызова нет;
   - у сессии без worktree пункта нет.
9. «Changes» в `SessionRowMenu` у сессии с worktree и без него → `setSidebar('right', {
   open: true, tab: 'changes' })`, в шапке эта сессия; у сессии неактивной работы
   работа стала активной, выбор не стёрт.
10. Шапка:
    - активна вкладка почты — в шапке сессия последней записи `entries()` этой работы с
      вкладкой терминала;
    - выбор S03 держится, когда фокус ушёл на терминал S02; после смены работы и
      возврата — снова сессия в фокусе;
    - у работы без вкладок сессий — `Choose a session to see its changes`.
11. Клавиши: `isActionAvailable('sidebar.changes')` → `true`;
    `runAction('sidebar.changes')` зовёт `ui.showRightTab('changes')` (строка таблицы
    теста 1 куска 6.3); ⌘⇧G открывает правый сайдбар на `Changes`; `tab: 'changes'` из
    `ui.json` показывает `Changes`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 8.3. Вкладка диффа на Monaco

**Зачем.** Большие изменения читаются, а заметки встают прямо в текст (8.4b).
**Зависит от:** 8.2b, 7.3b (Monaco, `monaco-mock.ts`), 7.1b (`GitRunner`,
`isSafeRev`). **Спека:** 11.3.

**Файлы**
- Создать в `packages/desktop/src/renderer/review/`:
  - `DiffTab.tsx`, `FileDiffSection.tsx`, `DiffToolbar.tsx` и тесты;
  - `diff-sides.ts` и тест.
- Изменить:
  - `renderer/layout/bodies/DiffBody.tsx` — рисует `DiffTab`; заглушка «нет worktree»
    уходит;
  - `renderer/layout/GroupView.tsx` — `DiffBody` получает `workKey`, `entry` и `tab`
    (`commit`);
  - `renderer/test-utils/monaco-mock.ts` — поддельный diff-редактор (ниже; модуль с
    7.3b, 8.4b его дописывает);
  - `src/main/files/git-api.ts` и тест — `gitCommitFiles`;
  - `src/main/files/ipc.ts` и тест — канал `files:git-commit-files`;
  - `src/shared/files-types.ts`, `src/shared/bridge.ts`, `src/preload/index.ts` —
    `files.gitCommitFiles`;
  - `packages/desktop/tsconfig.node.json` — в `references` `{ "path": "../core" }`;
  - `renderer/test-utils/fake-bridge.ts` — `gitCommitFiles`: ответы и журнал;
  - `src/shared/strings.ts` — строки ниже; осиротевшие ключи удаляются, шапка файла
    поправляется (ниже);
  - `packages/desktop/package.json` и корневой `pnpm-lock.yaml` — без `react-diff-view`
    и `gitdiff-parser`.
- Удалить:
  - `renderer/components/changes/ChangesPanel.tsx`, `DiffView.tsx` и их тесты;
  - `renderer/lib/diff.ts` и `renderer/lib/gitdiff-parser.d.ts` — объявление модуля
    `gitdiff-parser` из куска 0.1.

**Интерфейсы**

```ts
// shared/files-types.ts, дополнение FilesApi
import type { DiffFile } from '@harnas/core';   // 8.1; только тип — рантайм core в окно не собирается
/** Файлы коммита от первого родителя (у merge-коммита тоже), у корневого — от пустого дерева. */
gitCommitFiles(root: FileRoot, hash: string): Promise<DiffFile[]>;

// main/files/git-api.ts, дополнение
/** isSafeRev(hash), затем diff-tree с --name-status и с --numstat в cwd = rootPath(root) → joinDiffFiles (8.1). */
export async function gitCommitFiles(git: GitRunner, rootPath: string, hash: string): Promise<DiffFile[]>;

// review/diff-sides.ts
export interface DiffSides { original: string | null; modified: string | null; tooLarge: boolean; binary: boolean }
/**
 * Стороны файла: ветка — base ↔ рабочее дерево (base — mergeBase, у сессии без worktree — 'HEAD');
 * коммит — родитель ↔ коммит; R — original по oldPath.
 */
export async function loadSides(input: {
  files: FilesApi; root: FileRoot; file: DiffFile;
  mode: { kind: 'branch'; base: string } | { kind: 'commit'; hash: string };
}): Promise<DiffSides>;
export const DIFF_LIMITS: { maxEditors: 20; maxFileBytes: 1024 * 1024 };

// review/DiffTab.tsx — тело вкладки diff
export interface DiffTabProps {
  bridge: HarnasBridge; workKey: string; entry: WorkEntry;
  tab: Extract<TabSpec, { kind: 'diff' }>;
}

// test-utils/monaco-mock.ts, дополнение (7.3b) — DiffEditor мока отдаёт в onMount поддельный diff-редактор
export interface FakeDiffEditor {
  options: Record<string, unknown>;   // опции монтирования и updateOptions (renderSideBySide, wordWrap…)
  original: FakeEditor;               // getOriginalEditor()
  modified: FakeEditor;               // getModifiedEditor()
  disposed: boolean;                  // dispose()
}
// monacoMock, дополнение
diffEditors: FakeDiffEditor[];        // смонтированные, по порядку
// FakeEditor, дополнение
text: string;                         // getValue / setValue модели
scrollTop: number;                    // getScrollTop / setScrollTop

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
changes: {
  inline: 'Inline', sideBySide: 'Side by side',
  collapseAll: 'Collapse all', expandAll: 'Expand all', wrapLines: 'Wrap lines',
  collapse: 'Collapse', expand: 'Expand',
  list: 'List', tree: 'Tree',
  fileTooLarge: 'File is larger than 1 MB',
  showAnyway: 'Show anyway',
},   // Binary file — S.files.binary, Editor didn't load — S.files.editorFailed (7.3b); заголовок вкладки —
     // S.tabs.diffTitle ('Changes S02 · a1b2c3d', 2.4); No changes, Loading… — S.changes (живут дальше)
errors: { actions: { loadDiff: 'load diff' } },
```

**Поведение**
- **Хост старее окна** — как у «Изменений» (8.2b): без
  `useHostSupports('worktrees.mergeCheck')` тело-кнопка «Host is outdated — restart», без
  вызовов.
- **Список файлов** сверху: список или дерево, клик прокручивает к секции.
  - Режим ветки — `files` из `useChanges({ …, mergeCheck: false })` (8.2a): те же
    `worktrees.diff` или `changes.project` с `patch: false`.
  - Режим коммита — `files.gitCommitFiles(root, hash)`: в `BranchCommit` списка файлов
    нет.
  - Корень — worktree сессии (`createdAt !== null`), иначе проект. У `pending` — текст
    «Worktree появится при запуске сессии».
- **Секция файла:**
  - заголовок: путь, `+a −d`, «Свернуть»;
  - тело — `DiffEditor` из `@monaco-editor/react`, как у `CompareView` (7.3b): `onMount`
    отдаёт `IStandaloneDiffEditor`, Monaco локальный через `setupMonaco()` (7.3b).
    `monaco.editor.createDiffEditor` напрямую не зовётся: у тестов один путь — мок
    `@monaco-editor/react` (решение сверки, I6);
  - опции — `hideUnchangedRegions: { enabled: true, contextLineCount: 3 }`,
    `renderSideBySide` по `ui.diffView` зеркала, `readOnly`.
- **Стороны** (`loadSides`):
  - ветка: `original` — `gitShow(base)`, у `R` — по `oldPath`; `modified` — `readText`;
  - сессия без worktree: `mergeBase` нет — `base` = `HEAD`;
  - коммит: `hash^` и `hash`; у корневого коммита `hash^` нет — `gitShow` отдаёт
    `null`, сторона пустая;
  - `D` — `modified: null`; `A` — `original: null`;
  - больше 1 МБ — `tooLarge`: по `size` ответа или по отказу `files:too-large` (больше
    20 МБ, 7.1a); двоичный — `binary`.
- **`gitCommitFiles`** в main (решение сверки, I5):
  - `isSafeRev(hash)`, иначе `bad_request`;
  - двухдеревная форма `git diff-tree -r -M -z --relative --end-of-options <hash>^
    <hash>`, с `--name-status` и с `--numstat`, у корневого (`<hash>^` не резолвится) —
    `--root <hash>`. Однокоммитный `diff-tree` у merge-коммита не печатает ничего, а
    merge-коммиты в ветке ожидаемы: «Попросить агента разрешить» велит агенту `git merge
    <база>` (спека 11.2). Двухдеревная форма даёт изменения от первого родителя — те же
    стороны `hash^` и `hash`, что у `loadSides`;
  - `--relative`: пути от папки корня, как у `gitShow` (7.1b);
  - `cwd = rootPath(root)` (7.1a), git — `GitRunner` (7.1b) → `joinDiffFiles` из core
    (8.1).
- **`DiffFile` в `shared/files-types.ts`** — `import type` из `@harnas/core` (решение
  сверки, M19). Main и сейчас резолвит core через `dist` (`main/ui-store.ts` берёт
  `harnasHome`), но ссылки на core в `tsconfig.node.json` нет: 8.3 её добавляет, и
  `pnpm typecheck` держит тип явно. Шапка `shared/strings.ts` («main не резолвит
  `@harnas/core`») поправляется.
- **Обновление** (решение сверки, I7). Правила 11.1 записаны для вкладки «Изменения», а
  вкладка, загруженная один раз, держала бы стороны до переоткрытия — и заметка 8.4b не
  переехала бы. Поэтому:
  - режим ветки обновляется по тем же сигналам, что `useChanges` той же сессии: каждая
    загрузка — новый `source`;
  - на новый `source` список файлов пересчитывается, живые редакторы перечитывают
    стороны; новый текст — `setValue` модели, прокрутка — прежняя (`getScrollTop` до,
    `setScrollTop` после);
  - файл ушёл из списка — секция уходит;
  - режим коммита не обновляется: коммит неизменен.
- **Переход к файлу** (решение сверки, I8) — `revealed[bufferKey(workKey, tab.id)]`
  стора ревью (8.2a): на смену `nonce` секция файла монтируется и прокручивается в
  экран.
- **Ленивость:**
  - секция монтирует редактор, когда входит в экран (`IntersectionObserver`,
    `rootMargin` 400px), с заглушкой оценочной высоты: 20px × (строк + 2), не больше
    600px;
  - живых редакторов не больше 20 — самый дальний от экрана освобождается.
- **Панель:** «Одна колонка / Две колонки» (`patchUi({ diffView })` стора
  `store/ui.ts`, не `app.saveUi`), «Свернуть всё», «Развернуть всё», «Переносить
  строки».
- **Режим коммита** (`commit` во вкладке) — стороны `hash^` и `hash`, заголовок
  вкладки с hash (`S.tabs.diffTitle`).
- **Большой или двоичный файл** — заглушка спеки 11.3, «Показать всё равно» для
  текстового.
- **Ошибки:**
  - `gitCommitFiles` и `loadSides` — `errorText(code, S.errors.actions.loadDiff)`: у
    списка — в теле, у секции — в ней;
  - сбой Monaco — своя граница `ErrorBoundary` с заголовком `S.files.editorFailed` и
    «Retry» (решение сверки, M4). Отказ `loader.init()` уходит в состояние и бросается
    из рендера, как у `FileBody` (7.3b). «Open in default app» здесь нет: файлов во
    вкладке много. Граница `GroupView` (`S.shell.layoutError`) — запасная.
- **Строки прежней панели.** Со старой панелью и заглушкой `DiffBody` осиротевшие ключи
  удаляются (сверка этапа 8, I1): их находит поиск по `packages/desktop/src`. Ожидаемо:
  - `S.changes`: `mergeBlockedBaseDirty`, `mergeBlockedUncommitted`, `mergeFailReason`,
    `noFiles`, `commitAll`, `conflictLabel`, `messageSent`, `assignToAgent`,
    `discardConfirmTitle`, `mergeConflictMessage`, `binaryFile`;
  - `S.errors.noWorktree` и `S.errors.actions.discard`;
  - `S.errors.actions.assignToAgent` остаётся: им говорит тост отказа `sendWithToast`
    (5.4). Комментарий группы `S.changes` — на `review/*`.
- **Тесты в jsdom.** Monaco в jsdom не работает, `IntersectionObserver` там нет:
  - `vi.mock('@monaco-editor/react')` и `vi.mock('…/files/editor/monaco-setup.js')`
    модулями `test-utils/monaco-mock.ts` (7.3b). Мок одного `@monaco-editor/react` не
    спасёт: `monaco-setup.ts` притянул бы настоящий `monaco-editor`;
  - заглушка IO, которую тест вызывает сам.

**Тесты**
1. `loadSides`:
   - `M` — `gitShow(mergeBase)` и `readText`;
   - `A` — `original: null`;
   - `D` — `modified: null`;
   - `R` — `gitShow` по `oldPath`;
   - режим коммита — `hash^` и `hash`;
   - корневой коммит: `gitShow('<hash>^')` → `null`, `original: null`;
   - сессия без worktree — `original` из `gitShow('HEAD')`;
   - 2 МБ → `tooLarge`.
2. `DiffTab`: 30 файлов — живых (`disposed: false`) `monacoMock.diffEditors` не больше
   20; прокрутка к 25-му монтирует его и освобождает дальний.
3. Переключатель колонок зовёт `patchUi({ diffView })` и меняет `renderSideBySide` в
   `options` живых редакторов.
4. Поиск `react-diff-view`, `gitdiff-parser` и `components/changes` по
   `packages/desktop` (исходники и `package.json`) пуст.
5. `gitCommitFiles` (настоящий `git`):
   - коммит с переименованием → `R`, `oldPath` и числа;
   - корневой коммит → все `A`;
   - merge-коммит → файлы от первого родителя, список не пуст;
   - `файл.txt` — путь как есть;
   - `hash` `--output=x` → `bad_request`.
6. `DiffTab` режима коммита берёт список файлов из `gitCommitFiles`, а не из
   `worktrees.diff`; заголовок вкладки — `Changes S02 · a1b2c3d`.
7. Обновление:
   - `works.changed` этой работы → новый `worktrees.diff` (дроссель 2 с);
   - живой редактор перечитал сторону (`readText` ещё раз): `text` новый, `scrollTop`
     прежний;
   - файл ушёл из списка — секции нет.
8. Переход: `revealFile(workKey, 'diff:s-02', 'src/b.ts')` → секция `src/b.ts`
   смонтирована, `scrollIntoView` вызван; повтор с тем же путём — снова.
9. Хост без `worktrees.mergeCheck` → тело `Host is outdated — restart`, `worktrees.diff`
   нет.
10. Сбой Monaco: `monacoMock.rejectInit` → `Editor didn't load` и `Retry`.
11. Сессия без worktree: вкладка показывает файлы `changes.project`, стороны —
    `gitShow('HEAD')` и `readText` корня проекта; текста `This session has no worktree
    of its own` нет.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 8.4a. Заметки: хранение и модель

**Зачем.** Заметка переживает перезапуск окна и уходит агенту одним текстом, а
рендерер не пишет JSON вне `notes/`.
**Зависит от:** 8.3, 5.4 (`SendOutcome`). **Спека:** 11.4, 15.2.

**Файлы**
- Создать:
  - `packages/desktop/src/shared/notes-types.ts` и тест — `NotesFile`, `DiffNote`,
    пределы, `isNotesFile`: тип нужен мосту, main и рендереру. Из `shared/` импорт
    рендерера `tsconfig.node.json` не пропустит — `composite` требует, чтобы все файлы
    проекта были в `include`;
  - `packages/desktop/src/main/notes-store.ts` и тест;
  - в `packages/desktop/src/renderer/review/notes/`: `store.ts`, `format.ts`,
    `anchor.ts` и тесты.
- Изменить:
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` —
    `app.loadNotes`, `app.saveNotes` с проверкой аргументов, поле `notesStore` в
    `RegisterIpcOptions` (как `uiStore` и `layoutStore`);
  - `src/main/index.ts` — `createNotesStore()` в `registerIpc`;
  - `src/shared/work-keys.ts` и тест — `isSessionId`;
  - `renderer/test-utils/fake-bridge.ts` — `loadNotes`, `saveNotes`, ответы и журнал
    записей;
  - `src/shared/strings.ts` — строки ниже.

**Интерфейсы** — `NotesFile` и `DiffNote` спеки 11.4, плюс:

```ts
// shared/notes-types.ts — модель спеки 11.4
export const NOTES_LIMITS: { notes: 1000; fileBytes: 1024 * 1024; body: 4000; anchor: 4000 };   // план
/** Форма NotesFile спеки 11.4 с пределами NOTES_LIMITS; sentTo — isSessionId или null, startLine ≤ endLine. */
export function isNotesFile(value: unknown): value is NotesFile;

// shared/work-keys.ts, дополнение
/** Формат id сессии core: `s-` и цифры (core/work/map.ts#nextSessionId, та же регулярка в core/work/thread.ts). */
export function isSessionId(id: string): boolean;   // ^s-\d+$

// main/notes-store.ts — ~/.harnas/desktop/notes/<sha1(workKey)>/<sessionId>.json
/** sessionId не isSessionId или workKey не isValidWorkKey (5.2) — ошибка: sessionId идёт в имя файла как есть. */
export function notesPath(home: string, workKey: string, sessionId: string): string;
export interface NotesStore {
  /**
   * Битый файл (не JSON, не isNotesFile, больше 1 МБ) → пустые заметки; файл переименован в
   * <sessionId>.corrupt-<время>.json рядом. corruptedTo — только это имя, полный путь — в консоль main.
   */
  load(workKey: string, sessionId: string): Promise<{ file: NotesFile; corruptedTo: string | null }>;
  save(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;
}
export function createNotesStore(home?: string): NotesStore;

// main/ipc.ts, RegisterIpcOptions — дополнение
notesStore: NotesStore;

// bridge.ts, app
loadNotes(workKey: string, sessionId: string): Promise<{ file: NotesFile; corruptedTo: string | null }>;   // corruptedTo — имя файла
saveNotes(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;

// test-utils/fake-bridge.ts, дополнение FakeBridge
/** Ответ app.loadNotes этой сессии; по умолчанию { file: { version: 1, notes: [] }, corruptedTo: null }. */
setNotes(workKey: string, sessionId: string, answer: { file: NotesFile; corruptedTo: string | null } | IpcErrorInfo): void;
readonly loadNotesCalls: Array<{ workKey: string; sessionId: string }>;
readonly savedNotes: Array<{ workKey: string; sessionId: string; notes: NotesFile }>;

// review/notes/format.ts
export function formatNotes(input: { sessionLabel: string; branch: string | null; notes: DiffNote[] }): string;

// review/notes/anchor.ts
/** Ищет anchor.text: своя строка → ±20 строк → не нашла (stale). */
export function relocate(note: DiffNote, lines: string[]): { startLine: number; endLine: number; stale: boolean };

// review/notes/store.ts
export function notesKey(workKey: string, sessionId: string): string;   // `${workKey}\0${sessionId}`
export interface NotesState {
  /** Заметки загруженных сессий по notesKey. */
  bySession: Record<string, DiffNote[]>;
  /** Первый вызов — app.loadNotes (мост запоминается для записи); повтор — ничего. corruptedTo — тост S.notes.corrupted. */
  load(bridge: HarnasBridge, workKey: string, sessionId: string): Promise<void>;
  /** Новая заметка: id — 8 hex, createdAt и updatedAt — сейчас, anchor.text — строка startLine. */
  add(workKey: string, sessionId: string, note: Pick<DiffNote, 'path' | 'side' | 'startLine' | 'endLine' | 'body'>, anchorText: string): void;
  update(workKey: string, sessionId: string, id: string, body: string): void;
  remove(workKey: string, sessionId: string, id: string): void;
  /** relocate заметок файла и стороны по свежим строкам; 8.4b зовёт на каждом чтении сторон. */
  relocateFile(workKey: string, sessionId: string, path: string, side: DiffNote['side'], lines: string[]): void;
  /** Исход попытки отправки (onOutcome sendWithToast, 5.4): inserted — sentAt и sentTo; прочее — без изменений. */
  applyOutcome(workKey: string, sessionId: string, ids: string[], sentTo: string, outcome: SendOutcome): void;
}
export const useNotesStore: UseBoundStore<StoreApi<NotesState>>;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
notes: {
  header: (session: string, branch: string | null) => string,
                          // 'Review notes for S02 (branch harnas/w-0003/s02):'; branch null — 'Review notes for S02:'
  file: (path: string) => string,                    // 'File: src/a.ts'
  line: (n: number) => string,                       // 'Line: 7'
  lines: (from: number, to: number) => string,       // 'Lines: 10-14'
  sideOriginal: 'Side: original',
  note: (body: string) => string,                    // 'Note: …' — тело как есть, с переводами строк
  corrupted: (name: string) => string,               // 'Session notes were damaged — saved as s-02.corrupt-20260927-140501.json'
},
```

**Поведение**
- **Хранение.** `notes-store` пишет атомарно и очередью на файл (`writeAtomic`,
  `createFileQueue` из `main/atomic-file.ts`, 1.1): каталог `notes/` — свой, как у
  `ui.json`. Нет файла — пустые заметки. Битый файл — не JSON, не `isNotesFile` или
  больше 1 МБ — переименовывается в `<sessionId>.corrupt-<время>.json` рядом.
- **Путь битого файла** (решение сверки, M14). В рендерер уходит только имя —
  `corruptedTo`, полный путь — `console.warn` main. Путь `~/.harnas/desktop/notes/…`
  лежит вне корней работы, а такие рендерер не получает (спека 15.2). Тост — «Заметки
  сессии повреждены — сохранены как <имя>» (спека 13).
- **Проверка аргументов** в `app:load-notes` и `app:save-notes` (сквозное правило
  индекса; решение сверки, M12):
  - `sessionId` — только `isSessionId`: иначе `../..` из рендерера читал бы и писал JSON
    вне `notes/`;
  - `workKey` — общая `isValidWorkKey` (5.2): непустая строка до 4096, не `__proto__`.
    В имя каталога идёт только её `sha1`;
  - `notes` — `isNotesFile`: `version: 1`, поля спеки 11.4, `body` 1..4000 символов, до
    1000 заметок, `anchor.text` до 4000 символов, JSON до 1 МБ (пределы — план).
    Иначе отказ `bad_request`, файл не пишется.
- **Стор заметок:**
  - `load` — при открытии вкладки диффа (8.4b), один раз на сессию;
  - запись — `app.saveNotes` через 300 мс тишины после изменения, по сессии;
  - `relocateFile` двигает заметки по свежим строкам стороны: нашла — новые
    `startLine`/`endLine`, не нашла — `stale: true`;
  - `applyOutcome` (решение сверки, I2) — исход каждой попытки отправки: первой и
    каждого `Retry` тоста (`onOutcome` у `sendWithToast`, 5.4). `inserted: true` —
    `submitted` и вставка без Enter (`draft`, `input`, `restarted`) → `sentAt`, `sentTo`.
    `blocked`, `busy`, `no-paste-mode` и отказ `{ error: 'not_found' | 'failed' }` →
    без изменений. Без `onOutcome` цепочка `busy` → `Retry` → `submitted` оставила бы
    заметки неотправленными, и человек отправил бы их второй раз.
- **Формат** — `formatNotes`, английский шаблон из `S` (сверка этапа 8, I1): заголовок
  `S.notes.header`, пустая строка, затем блоки заметок через пустую строку:
  - `File: <путь>`; `Line: N` или `Lines: A-B`; у заметки к старой стороне —
    `Side: original`; `Note: <текст как есть>`;
  - порядок — по файлу, потом по строке; переводы строк в тексте сохраняются.

**Тесты**
1. `formatNotes`:
   - одна строка → `Line: 7`;
   - диапазон → `Lines: 10-14`;
   - старая сторона → строка `Side: original`;
   - две заметки разделены пустой строкой;
   - порядок — по файлу, потом по строке;
   - переводы строк в тексте сохранены;
   - заголовок — `Review notes for S02 (branch harnas/w-0003/s02):`, без ветки —
     `Review notes for S02:`.
2. `relocate`:
   - строка на месте → та же;
   - сдвиг на 5 строк → новая позиция;
   - текст исчез → `stale: true`;
   - сдвиг на 25 строк → `stale: true`.
3. `notes-store`: туда и обратно; битый файл → пустые заметки, файл `*.corrupt-*`
   рядом, `corruptedTo` — его имя без каталога, полный путь — в `console.warn`; файл
   больше 1 МБ — битый.
4. `isNotesFile`: 1001 заметка, `anchor.text` из 4001 символа, `body` пустой и из 4001
   символа, `sentTo: '../x'`, `startLine` больше `endLine` → `false`; верная форма →
   `true`.
5. `applyOutcome`:
   - `submitted` и вставка с `reason: 'draft'` → `sentAt` и `sentTo`;
   - `blocked`, `busy`, `no-paste-mode`, `{ error: 'not_found' }` → `sentAt: null`;
   - цепочка `busy`, затем `submitted` (два вызова, как у `Retry`) → `sentAt`
     поставлен.
6. Стор: три правки за 300 мс → одна `saveNotes`; `load` дважды → один `loadNotes`;
   `corruptedTo` → тост `Session notes were damaged — saved as <имя>`.
7. Проверка аргументов:
   - `notesPath` и `app:load-notes` с `sessionId` `../x`, `s-1/../../x` и `S-01` →
     отказ, файлов вне `notes/` нет;
   - `workKey` `__proto__` и длиной 4097 → отказ;
   - `app:save-notes` с заметкой без `body`, с `body` из 4001 символа и с 1001 заметкой
     → отказ, файл не записан.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 8.4b. Заметки в диффе и отправка; приёмка этапа 8

**Зачем.** Ревью, как у Orca: заметка к строке уходит агенту, агент правит.
**Зависит от:** 8.4a, 5.4 (`sendWithToast` с `onOutcome`, `STUB_BRACKETED`).
**Спека:** 11.4, 14.3.

**Файлы**
- Создать:
  - в `packages/desktop/src/renderer/review/notes/`: `GutterAdd.tsx`, `NoteZone.tsx`,
    `NoteEditor.tsx`, `SendMenu.tsx` и тесты;
  - `packages/desktop/e2e/review.spec.ts`.
- Изменить:
  - `renderer/review/FileDiffSection.tsx` и тест — оверлей гаттера, view zones заметок,
    «Отправить заметки файла» в заголовке секции, полоса заметок старой стороны в режиме
    «одна колонка»;
  - `renderer/review/DiffTab.tsx` и тест — загрузка заметок сессии, `relocateFile` на
    каждом чтении сторон, режим коммита без заметок;
  - `renderer/review/DiffToolbar.tsx` — «Отправить все неотправленные»;
  - `renderer/shell/AppShell.tsx`, `renderer/layout/LayoutView.tsx`,
    `renderer/layout/GroupView.tsx` и `renderer/layout/bodies/DiffBody.tsx` — `sendDeps`
    окна (7.2): `AppShell` → проп `LayoutView` → `LayoutBodyContext` → проп `DiffBody` →
    `DiffTab`, так же, как `active` доходит до тел почты. Тесты, что строят
    `LayoutBodyContext` сами, получают подставной `sendDeps`;
  - `renderer/test-utils/monaco-mock.ts` — view zones, координаты строк и выделение
    поддельного редактора (ниже);
  - `src/shared/strings.ts` — строки ниже.
- Документы: `README.md`, раздел «Окно» — «Изменения», главная кнопка, заметки агенту.

**Интерфейсы**

```ts
// review/notes/SendMenu.tsx — меню получателя; его же берёт 9.3 (Design Mode)
export interface SendMenuProps {
  entry: WorkEntry;                    // сессии работы: AgentStateDot, ярлык, время последней активности
  defaultSessionId: string | null;     // по умолчанию — сессия диффа
  label: string;                       // подпись кнопки: S.common.send, S.notes.sendFile…
  disabled?: boolean;
  onSend(sessionId: string): void;     // выбран получатель — отправка
}

// layout/GroupView.tsx, дополнение LayoutBodyContextValue; LayoutViewProps и DiffTabProps (8.3) — то же поле
sendDeps: SendWithToastDeps;           // окна, из AppShell (7.2)

// test-utils/monaco-mock.ts, дополнение FakeEditor
zones: Array<{ afterLineNumber: number; domNode: HTMLElement }>;   // changeViewZones: addZone и removeZone
selection: { startLineNumber: number; endLineNumber: number } | null;   // getSelection
// getTopForLineNumber(n) — (n − 1) × 20: оверлей гаттера считает строки этим шагом

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
notes: {
  add: 'Add note',                                        // aria-label «+» гаттера
  placeholder: 'Note for the agent — ⌘Enter to save',
  edit: 'Edit',
  sendFile: 'Send file notes',
  sendAllUnsent: 'Send all unsent',
  sent: (session: string, time: string) => string,        // 'Sent to S02 · 2:05 PM'
  stale: 'Outdated',                                      // «устарела»
  original: (from: number, to: number) => string,         // 'Original · line 7'; диапазон — 'Original · lines 10-14'
  chooseRecipient: 'Choose recipient',                    // aria-label «▾» у SendMenu
  notRunning: 'not running',                              // подпись неактивной сессии в SendMenu
},   // автор «ты» — S.participants.human ('You'); Send — S.common.send (8.2b); Save — S.files.save (7.3a);
     // Delete, Cancel — S.common; слишком длинный текст — S.send.tooLong (8.2a)
```

**Поведение**
- **Постановка** — только в режиме ветки (решение сверки, M22):
  - наведение на строку гаттера — «+» (свой оверлей: glyph-декорации Monaco не
    кликабельны);
  - протяжка с зажатой кнопкой — диапазон строк;
  - ⌘⇧A — заметка на выделение (`addCommand` в обоих редакторах diff; ⌘⇧A реестр
    клавиш не занимает, в контексте `monaco` сочетание достаётся редактору, 6.1a);
  - `NoteEditor` под строкой: ⌘Enter сохраняет (1–4000 символов), Esc отменяет.
- **Режим коммита заметок не ставит и не показывает.** У `DiffNote` нет поля `commit`
  (спека 11.4). Заметка из вкладки `diff:s-02:<hash>` ездила бы по тексту рабочего
  дерева и ложно устаревала. Во вкладке коммита нет ни «+», ни ⌘⇧A, ни view zones.
- **Показ.** Заметка — view zone под `endLine` своей стороны: текст, автор «ты», время
  (`en-US`), «Править», «Удалить», «Отправить».
  - Отправленная свёрнута в строку «отправлено S02 · 14:05».
  - Устаревшая — приглушена с меткой «устарела».
- **Одна колонка** (решение сверки, M18). При `renderSideBySide: false` редактор
  `original` скрыт, и его view zone не видна. Заметки к `original` в этом режиме —
  полоса над редактором секции: «Original · line 7», текст и те же кнопки. «+» и ⌘⇧A в
  одной колонке ставят заметку к `modified`; к старой стороне — в двух колонках.
- **Загрузка** — `useNotesStore.load` при открытии вкладки диффа, один раз на сессию.
- **Переезд** (решение сверки, I7). На каждом чтении сторон — монтирование секции и
  обновление вкладки (8.3) — `relocateFile` для заметок этого файла и стороны. Не
  нашла — `stale: true`.
- **Отправка:**
  - одна заметка; заметки файла — кнопка «Отправить заметки файла» в заголовке секции;
    все неотправленные — кнопка панели. Без `stale`, если их не выбрали явно;
  - получатель — `SendMenu`: сессии работы с `AgentStateDot`, ярлыком и временем
    последней активности. По умолчанию — сессия диффа. Сессии без живого процесса
    (`lifecycle` не `active`) неактивны с подписью «not running»;
  - текст — `formatNotes` (8.4a). `fitsSendLimit` (8.2a) не прошёл — тост
    `S.send.tooLong`, отправки нет (решение сверки, M10). «Все неотправленные» по 4000
    символов каждая предел 64 КиБ превысят;
  - `sendWithToast({ ...sendDeps, onOutcome }, ref, text, true)` (5.4): `onOutcome`
    зовёт `applyOutcome` (8.4a) на первой попытке и на каждом `Retry`. Тосты — таблица
    спеки 8.6.
- **Рамка.** В агента уходит только нажатие «Отправить». `relocate`, обновление
  вкладки, загрузка заметок и ⌘Enter в `NoteEditor` `pty.send` не зовут; повтор после
  `blocked`, `busy` и `no-paste-mode` — только кнопкой `Retry` тоста (решение сверки,
  M17).
- **`SendMenu`** — со своими пропами: его переиспользует 9.3 (решение сверки, M13).
- **Тесты в jsdom** — те же подставные Monaco и `IntersectionObserver`, что в 8.3.

**Тесты**
1. `GutterAdd`: протяжка со строки 10 до 14 открывает редактор с диапазоном 10–14 (по
   `getTopForLineNumber` поддельного редактора); ⌘⇧A (`press`) — заметка на
   `selection`.
2. `NoteZone`:
   - view zone под `endLine` (`zones`) с текстом, `You`, временем `en-US`, `Edit`,
     `Delete`, `Send`;
   - отправленная — строка `Sent to S02 · 2:05 PM`;
   - устаревшая — метка `Outdated`.
3. `SendMenu`: по умолчанию сессия диффа; сессия с `lifecycle` `sleeping` неактивна с
   подписью `not running`.
4. Отправка:
   - ответ `busy` → тост с `Retry` → `Retry` отвечает `submitted` → у заметки `sentAt`
     (через `onOutcome`);
   - `blocked` → `sentAt: null`;
   - `Send all unsent` пропускает `stale`;
   - `Send file notes` в заголовке секции берёт только заметки файла;
   - текст больше 64 КБ → тост `Too long for one message to the agent — 64 KB max`,
     `pty.send` нет.
5. Рамка: `relocate`, обновление вкладки, загрузка заметок и ⌘Enter в `NoteEditor` —
   `pty.send` в журнале `calls` нет ни одного.
6. Переезд:
   - заметка к строке 10; выше на диске вставлены 5 строк, сессия вышла из `working` →
     заметка на строке 15;
   - строку убрали → метка `Outdated`.
7. Одна колонка: заметка к `original` видна полосой `Original · line 7` над
   редактором; «+» ставит заметку к `modified`.
8. Режим коммита: «+» нет, ⌘⇧A заметку не ставит, `zones` пусты.
9. Открытие вкладки диффа грузит заметки сессии один раз (`loadNotesCalls`); битые →
   тост `Session notes were damaged — saved as …`, полного пути в DOM нет.
10. **E2E `review.spec.ts`.** Подготовка (решение сверки, I11):
    - `STUB_BRACKETED=1`;
    - `HARNAS_HOME` и `HARNAS_WORKTREE_ROOT` — внутри каталога теста в `/tmp`. Корень
      worktree по умолчанию — `~/harnas/worktrees` настоящего дома, `HARNAS_HOME` его не
      переносит;
    - каждый сценарий проверяет, что worktree сессии лежит под этим корнем.

    Сценарий:
    - сессия в worktree; тест пишет файл в worktree;
    - `Changes` → файл в `Uncommitted`;
    - вкладка диффа → заметка к строке → `Send`;
    - stub печатает `PASTE<<Review notes for S01` и `echo:`.
11. **E2E:** коммит из `Changes` с сообщением → секция `Uncommitted` пуста, файл — в
    `Branch changes`; затем `Merge into <база>` с подтверждением → в базе появился
    merge-коммит (`git log` из теста).
12. **E2E:** правка одной строки в базе и в ветке → секция `Conflicts` с файлом до
    попытки слияния.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 8** (человек, на пересобранном `harnas.app`)
- [ ] Полный цикл на реальной сессии Claude в worktree: заметка → агент исправил →
      коммит → слияние.
- [ ] Заметка переезжает, когда агент сдвинул строки, и помечается «устарела», когда
      строку убрал.
- [ ] Конфликт виден до слияния, «Попросить агента разрешить» уходит только по
      нажатию.
- [ ] Сессия без worktree: «Закоммитить всё в папке» не кладёт `.harnas/` в историю.
- [ ] Файл с кириллицей в имени виден в «Изменениях», в диффе и в конфликте по имени.
- [ ] `README.md` обновлён.
