# План, этап 8: ревью изменений

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 11, строка 8 таблицы 14.3.

**Итог этапа:**
- вкладка «Изменения» правого сайдбара: шапка `ветка → база`, секции, одна главная
  кнопка, проверка конфликтов до слияния;
- дифф на Monaco со свёрнутым неизменённым;
- заметки к строкам уходят агенту одним блоком.

**Перед стартом.** Сверить с кодом прошлых этапов:
- `core/src/work/worktree.ts` (`worktreeDiff`, `mergeWorktree`, `parseNameStatus`,
  `isDirty` с `:(exclude).harnas`);
- `host/src/methods/worktrees.ts`, `host/src/worktrees/worktrees-service.ts`;
- `renderer/components/changes/*` (что заменяется), `renderer/sidebar/SessionRowMenu.tsx`
  и `CardMenu.tsx` (3.4);
- `renderer/terminal/send.ts` (`sendToAgent`, `sendToast`), `shared/ipc-error.ts`;
- `files/editor/monaco-setup.ts`, `main/files/git-api.ts` (`gitShow`, `isSafeRev`),
  `shell/RightSidebar.tsx`, `store/ui.ts` (`setSidebar`, `patchUi`), `layout/store.ts`
  (`entries()`).

---

## 8.1. core и хост: статистика диффа, коммиты, `mergeCheck`, изменения папки

**Зачем.** Окну нужны числа `+/−`, список коммитов ветки и знание о конфликтах до
слияния.
**Зависит от:** 3.1. **Спека:** 3.2, 11.5.

**Файлы**
- Изменить:
  - `packages/core/src/work/worktree.ts` и тест — расширенный `worktreeDiff`,
    `mergeCheck`, `projectChanges`, `commitProject`; `DiffFile` экспортируется;
  - `packages/core/src/index.ts` — экспорт, в том числе `DiffFile` и разборщиков
    `-z` для 8.3;
  - `packages/protocol/src/methods.ts` и тест — `worktrees.mergeCheck`,
    `changes.project`, `changes.commitProject`, расширенный `WorktreeDiff`, параметр
    `patch` у `worktrees.diff`;
  - `packages/host/src/worktrees/worktrees-service.ts` и тест — `mergeCheck`,
    `projectChanges`, `commitProject`, ошибки git: правила методов живут здесь, как у
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
export type MergeCheck = { status: 'clean' } | { status: 'conflicts'; files: string[] } | { status: 'unsupported' };
export async function mergeCheck(projectPath: string, info: WorktreeInfo): Promise<MergeCheck>;
/** stdout и код `git merge-tree --write-tree --name-only --no-messages`; stderr для unsupported. */
export function parseMergeTree(code: number, stdout: string, stderr: string): MergeCheck;
export function parseNumstat(raw: Buffer): Array<{ path: string; oldPath: string | null; additions: number | null; deletions: number | null }>; // -z, -M
/** `--name-status -z -M`: статус и старый путь; с parseNumstat собирает DiffFile — ими же пользуется files.gitCommitFiles (8.3). */
export function parseNameStatusZ(raw: Buffer): Array<{ path: string; oldPath: string | null; status: DiffFile['status'] }>;
export function joinDiffFiles(status: ReturnType<typeof parseNameStatusZ>, numstat: ReturnType<typeof parseNumstat>): DiffFile[];
export function parseCommits(raw: string): BranchCommit[];   // --format=%H%x00%s%x00%an%x00%aI, записи через \n
export async function worktreeDiff(projectPath: string, info: WorktreeInfo, options?: { patch?: boolean }): Promise<WorktreeDiff>;
export async function projectChanges(projectPath: string, options?: { patch?: boolean }): Promise<ProjectChanges>;
export async function commitProject(projectPath: string, message: string): Promise<{ commit: string }>;

// protocol/methods.ts — параметр только добавляется: старый хост его отбросит, старое окно не шлёт
'worktrees.diff':  z.object({ ref: sessionRef, patch: z.boolean().optional() }),   // false — patch: ''
'changes.project': z.object({ ref: sessionRef, patch: z.boolean().optional() }),

// host/worktrees/worktrees-service.ts
/** Ошибка git → HostError: ENOENT запуска — internal «Git не найден»; «not a git repository» — bad_request «Папка не под git». */
export function gitFailure(error: unknown): HostError;
```

**Поведение**
- **`worktreeDiff`:**
  - `mergeBase` уже вычисляется;
  - numstat — `git diff -M --numstat -z <mergeBase>` по рабочему дереву плюс
    неотслеживаемые, как сейчас в патче: у неотслеживаемого `additions` — число
    строк, `deletions` — 0;
  - `stats` — сумма без `null`;
  - `commits` — `git log -n 200 <mergeBase>..<branch>`, свежие первыми;
  - поле `oldPath` у `R`.
- **`patch: false`** у `worktrees.diff` и `changes.project` — патч не строится, в ответе
  `patch: ''`. Новое окно (8.2) патч не просит: строка протокола ограничена 8 МБ
  (`protocol/src/framing.ts`), и дифф с lock-файлами обрушил бы вкладку. Без параметра —
  патч целиком, как сейчас: им живёт прежняя панель до 8.3.
- **`mergeCheck`** — `git merge-tree --write-tree --name-only --no-messages <base>
  <branch>` в `projectPath`:
  - код 0 → `clean`;
  - код 1 → `conflicts`: строки после первой (id дерева), без пустых, без дублей;
  - другой код и stderr с `unknown option` или `usage:` → `unsupported`;
  - иначе — ошибка;
  - рабочие копии не трогаются.
- **`.harnas/` — не изменения проекта.** Состояние харнесса (карта, журналы хуков,
  письма, брифы) лежит в `<проект>/.harnas/works/<id>/`, и без `.gitignore` git его не
  отслеживает. Иначе «Незакоммиченные» не пустели бы никогда, а первое «Закоммитить всё
  в папке» положило бы журналы в историю — по README это решение человека. Поэтому все
  команды `changes.*` идут с `-- . ':(exclude).harnas'`: дифф, numstat, список
  неотслеживаемых и `git add -A`. Так же уже делает `isDirty` в core.
- **`changes.project`:**
  - `git diff HEAD` с numstat и неотслеживаемыми в `projectPath`, без `.harnas/`;
  - `branch` — `git rev-parse --abbrev-ref HEAD`, `HEAD` → `null`;
  - для сессии с `worktree` — `bad_request` «у сессии свой worktree — смотрите
    worktrees.diff».
- **`changes.commitProject`:**
  - `git add -A -- . ':(exclude).harnas'` и `git commit -m <message>` в `projectPath`,
    как `worktrees.commit`;
  - пустое сообщение отвергает схема (1..10000);
  - нечего коммитить (изменён только `.harnas/` или ничего) → `conflict` «нет
    изменений».
- **Ошибки git** — `gitFailure`: окно показывает текст как есть (спека 13, 8.2).

**Тесты** (временные репозитории, настоящий `git`)
1. `parseNumstat`:
   - обычный файл;
   - двоичный (`-\t-`) → `null`;
   - переименование с `-M` → `oldPath`.
2. `worktreeDiff`: две правки, одно переименование, один новый файл → `files` с
   числами, `stats` — сумма, `commits` — два коммита ветки в порядке «свежие первыми».
3. `mergeCheck`:
   - непересекающиеся правки → `clean`;
   - правка одной строки в базе и в ветке → `conflicts: ['a.txt']`;
   - рабочие копии не изменились (`git status` чист).
4. `parseMergeTree(129, '', 'error: unknown option `write-tree'…')` → `unsupported`.
5. `projectChanges` в папке без коммитов → понятная ошибка; с правкой — `files` и
   `branch`.
6. Сервис хоста: `changes.project` для сессии с worktree → `bad_request`;
   `commitProject` без изменений → `conflict`.
7. `.harnas/`: неотслеживаемый `.harnas/works/w-01/events/s-01.jsonl` и правка
   `a.txt` → в `files` только `a.txt`; `commitProject` → в коммите нет `.harnas/`
   (`git show --name-only`); изменён только `.harnas/` → `conflict` «нет изменений».
8. `worktrees.diff` с `patch: false` → `patch: ''`, `files` и `stats` те же; без
   параметра — патч как раньше.
9. `gitFailure`: ошибка с кодом `ENOENT` → `internal` «Git не найден»; stderr
   `fatal: not a git repository` → `bad_request` «Папка не под git».

**Приёмка**
- [ ] Все тесты зелёные во всех пакетах — сверка с базовым прогоном (индекс, «Правила
      проверки»).

---

## 8.2. Вкладка «Изменения» и главная кнопка

**Зачем.** Одна кнопка ведёт от правки агента до слияния, без знания git-команд.
**Зависит от:** 8.1, 7.2. **Спека:** 11.1, 11.2.

**Файлы**
- Создать в `packages/desktop/src/renderer/review/`:
  - `ChangesPanel.tsx`, `PrimaryAction.tsx`, `ConflictsSection.tsx`,
    `AskAgentDialog.tsx` и тесты;
  - `state.ts` и тест;
  - `use-changes.ts` и тест.
- Изменить:
  - `renderer/shell/RightSidebar.tsx` — вкладка «Изменения» (⌘⇧G);
  - `renderer/keys/handler.ts`, `renderer/palette/actions.ts` — `sidebar.changes`
    доступно и выполняется;
  - `renderer/sidebar/SessionRowMenu.tsx` и `renderer/sidebar/CardMenu.tsx` (3.4) —
    «Изменения» открывает вкладку «Изменения» правого сайдбара, а не старую панель.
    Прежние `components/sidebar/*` удалены в 3.5.

**Интерфейсы**

```ts
// review/state.ts
export type ChangesSource =
  | { kind: 'worktree'; diff: WorktreeDiff; check: MergeCheck | null }
  | { kind: 'project'; changes: ProjectChanges }
  | { kind: 'pending' };            // worktree запланирован (createdAt: null): вызовов нет
export type PrimaryAction =
  | { kind: 'commit-project' } | { kind: 'commit' }
  | { kind: 'merge'; base: string } | { kind: 'ask-agent'; files: string[] }
  | { kind: 'nothing' };
/** Таблица спеки 11.2; check: null (ещё не пришёл) — как unsupported. */
export function primaryActionFor(source: ChangesSource): PrimaryAction;
export function mergeResultText(result: MergeResult, base: string): { text: string; conflicts: string[] | null };
/** Текст спеки 11.2 для «Попросить агента разрешить». */
export function askAgentText(branch: string, base: string, files: string[]): string;

// review/use-changes.ts
/** Загрузка diff/mergeCheck или changes.project по сессии, всегда с patch: false; обновление по правилам 11.1, не чаще раза в 2 с. */
export function useChanges(input: {
  bridge: HarnasBridge; entry: WorkEntry; sessionId: string | null;
}): { source: ChangesSource | null; loading: boolean; error: string | null; refresh(): void };
```

**Поведение**
- **Сессия в фокусе:**
  - сессия вкладки терминала или диффа активной группы;
  - иначе последняя сессия работы из истории: самая свежая запись `entries()` (2.2) этой
    работы с вкладкой `terminal` или `diff`;
  - выбор в шапке переопределяет до смены работы.
- **Шапка:**
  - `ветка → база`, чип `+a −d`, «N коммитов»;
  - «⋯»: «Обновить», «Отбросить worktree…» — `ConfirmDialog` → `worktrees.discard`;
  - без worktree — `ветка (папка проекта)` и предупреждение спеки 11.1;
  - worktree ещё не создан (`createdAt: null`) — «Worktree появится при запуске
    сессии», ни `worktrees.diff`, ни `changes.project`, кнопка «Нет изменений».
- **Секции** (сворачиваются): «Конфликты», «Незакоммиченные», «Коммиты ветки».
  - Клик по файлу — вкладка `diff` сессии с фокусом на файле (8.3).
  - Клик по коммиту — вкладка `diff` с `commit`.
- **Главная кнопка** — `primaryActionFor`:
  - поле сообщения коммита (⌘Enter), пустое — кнопка неактивна;
  - в `working` подтверждение добавляет «Агент ещё работает — изменения могут быть
    неполными»;
  - `check: null` (проверка ещё идёт или её не звали) — как `unsupported`: «Слить в
    <база>» доступна, конфликт узнаётся при слиянии, как сейчас.
- **Слияние:**
  - подтверждение с числами (спека 11.2) → `worktrees.merge`;
  - ответ — тост `mergeResultText`; `conflict` раскрывает секцию «Конфликты».
- **«Попросить агента разрешить»:**
  - `AskAgentDialog` с редактируемым `askAgentText` и получателем — сессией worktree;
  - «Отправить» → `sendToAgent(submit: true)` и тост `sendToast`.
- **Обновление** — спека 11.1, дроссель 2 с. `mergeCheck` — после каждого `diff` с
  коммитами ветки. Вызовы — с `patch: false` (8.1).
- **Ошибки** — тело вкладки показывает `decodeIpcError(err).message`: «Git не найден»,
  «Папка не под git» (спека 13) и прочее — текстом хоста.
- **Из меню сессии и карточки** «Изменения» → `setSidebar('right', { open: true, tab:
  'changes' })` и выбор этой сессии в шапке.

**Тесты**
1. `primaryActionFor` — каждая строка таблицы 11.2, включая `unsupported` → `merge`;
   всё закоммичено, есть коммиты, `check: null` → `merge`; `pending` → `nothing`.
2. `mergeResultText` для четырёх причин `MergeResult` — тексты спеки.
3. `askAgentText` совпадает с шаблоном спеки для двух файлов.
4. `useChanges` (поддельные таймеры): три `works.changed` за секунду → один
   `worktrees.diff` с `patch: false`; переход из `working` → обновление.
5. `PrimaryAction`: пустое сообщение — кнопка неактивна; `working` — строка
   предупреждения в подтверждении.
6. `AskAgentDialog` зовёт `pty.send` с отредактированным текстом и
   `submit: true`; ответ `blocked` показывает тост «ждёт ответа».
7. Сессия с `worktree.createdAt: null` → ни `worktrees.diff`, ни `changes.project`,
   текст «Worktree появится при запуске сессии».
8. Активна вкладка почты — сессия в фокусе из последней записи `entries()` этой работы
   с вкладкой терминала.
9. `changes.project` отказал с текстом «Папка не под git» → он в теле вкладки.
10. «Изменения» в `SessionRowMenu` → `setSidebar('right', { open: true, tab:
    'changes' })`, в шапке эта сессия.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 8.3. Вкладка диффа на Monaco

**Зачем.** Большие изменения читаются, а заметки встают прямо в текст (8.4).
**Зависит от:** 8.2, 7.3. **Спека:** 11.3.

**Файлы**
- Создать в `packages/desktop/src/renderer/review/`:
  - `DiffTab.tsx`, `FileDiffSection.tsx`, `DiffToolbar.tsx` и тесты;
  - `diff-sides.ts` и тест.
- Изменить:
  - `renderer/layout/bodies/` — вид `diff` рисует `DiffTab` вместо `ChangesPanel`;
  - `src/main/files/git-api.ts` и тест — `gitCommitFiles`;
  - `src/main/files/ipc.ts` — канал `files:git-commit-files`;
  - `src/shared/files-types.ts`, `src/shared/bridge.ts`, `src/preload/index.ts` —
    `files.gitCommitFiles`;
  - `renderer/test-utils/fake-bridge.ts` — заглушка `gitCommitFiles`.
- Удалить:
  - `renderer/components/changes/ChangesPanel.tsx`, `DiffView.tsx`, `renderer/lib/diff.ts`
    и их тесты;
  - зависимости `react-diff-view`, `gitdiff-parser`.

**Интерфейсы**

```ts
// shared/files-types.ts, дополнение FilesApi
/** Файлы коммита: --name-status и --numstat по hash^..hash, у корневого — от пустого дерева. */
gitCommitFiles(root: FileRoot, hash: string): Promise<DiffFile[]>;   // DiffFile — тип @harnas/core (8.1)

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
```

**Поведение**
- **Список файлов** сверху: список или дерево, клик прокручивает к секции.
  - Режим ветки — `files` из `worktrees.diff` или `changes.project`.
  - Режим коммита — `files.gitCommitFiles(root, hash)`: в `BranchCommit` списка файлов
    нет.
- **Секция файла:**
  - заголовок: путь, `+a −d`, «Свернуть»;
  - тело — `monaco.editor.createDiffEditor` с `hideUnchangedRegions: { enabled: true,
    contextLineCount: 3 }`, `renderSideBySide` по `ui.diffView` зеркала, `readOnly`.
- **Стороны** (`loadSides`):
  - ветка: `original` — `gitShow(base)`, у `R` — по `oldPath`; `modified` — `readText`;
  - сессия без worktree: `mergeBase` нет — `base` = `HEAD`;
  - коммит: `hash^` и `hash`; у корневого коммита `hash^` нет — `gitShow` отдаёт
    `null`, сторона пустая;
  - `D` — `modified: null`; `A` — `original: null`.
- **`gitCommitFiles`** в main: `isSafeRev(hash)`, затем `git diff-tree -r -M --root
  --no-commit-id -z --end-of-options <hash>` с `--name-status` и с `--numstat` в
  `cwd = rootPath(root)` (7.1) → `joinDiffFiles` из core (8.1).
- **Ленивость:**
  - секция монтирует редактор, когда входит в экран (`IntersectionObserver`,
    `rootMargin` 400px), с заглушкой оценочной высоты: 20px × (строк + 2), не больше
    600px;
  - живых редакторов не больше 20 — самый дальний от экрана освобождается.
- **Панель:** «Одна колонка / Две колонки» (`patchUi({ diffView })` стора
  `store/ui.ts`, не `app.saveUi`), «Свернуть всё», «Развернуть всё», «Переносить
  строки».
- **Режим коммита** (`commit` во вкладке) — стороны `hash^` и `hash`, заголовок
  вкладки с hash.
- **Большой или двоичный файл** — заглушка спеки 11.3, «Показать всё равно» для
  текстового.
- **Тесты в jsdom.** Monaco в jsdom не работает, `IntersectionObserver` там нет:
  `vi.mock('@monaco-editor/react')` и заглушка IO, которую тест вызывает сам.

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
2. `DiffTab`: 30 файлов — смонтировано не больше 20 редакторов; прокрутка к 25-му
   монтирует его и освобождает дальний.
3. Переключатель колонок зовёт `patchUi({ diffView })` и меняет `renderSideBySide` у
   живых редакторов.
4. Поиск `react-diff-view` и `gitdiff-parser` по `packages/desktop` пуст.
5. `gitCommitFiles` (настоящий `git`): коммит с переименованием → `R`, `oldPath` и
   числа; корневой коммит → все `A`; `hash` `--output=x` → `bad_request`.
6. `DiffTab` режима коммита берёт список файлов из `gitCommitFiles`, а не из
   `worktrees.diff`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 8.4. Заметки к строкам; приёмка этапа 8

**Зачем.** Ревью, как у Orca: заметка к строке уходит агенту, агент правит.
**Зависит от:** 8.3, 5.1. **Спека:** 11.4.

**Файлы**
- Создать:
  - `packages/desktop/src/main/notes-store.ts` и тест;
  - в `packages/desktop/src/renderer/review/notes/`: `types.ts`, `store.ts`,
    `format.ts`, `anchor.ts` и тесты;
  - в `packages/desktop/src/renderer/review/notes/`: `GutterAdd.tsx`, `NoteZone.tsx`,
    `NoteEditor.tsx`, `SendMenu.tsx` и тесты;
  - `packages/desktop/e2e/review.spec.ts`.
- Изменить:
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` —
    `app.loadNotes`, `app.saveNotes` с проверкой аргументов;
  - `src/shared/work-keys.ts` и тест — `isSessionId`;
  - `renderer/test-utils/fake-bridge.ts` — `loadNotes`, `saveNotes` и журнал записей;
  - `renderer/review/FileDiffSection.tsx` — оверлей гаттера, view zones заметок;
  - `renderer/review/DiffToolbar.tsx` — «Отправить все неотправленные».
- Документы: `README.md`, раздел «Окно» — «Изменения», главная кнопка, заметки агенту.

**Интерфейсы** — `NotesFile` и `DiffNote` спеки 11.4, плюс:

```ts
// shared/work-keys.ts, дополнение
/** Формат id сессии core: `s-` и цифры (core/work/map.ts#nextSessionId, та же регулярка в core/work/thread.ts). */
export function isSessionId(id: string): boolean;   // ^s-\d+$

// main/notes-store.ts — ~/.harnas/desktop/notes/<sha1(workKey)>/<sessionId>.json
/** sessionId не isSessionId или workKey не 1..4096 символов — ошибка: sessionId идёт в имя файла как есть. */
export function notesPath(home: string, workKey: string, sessionId: string): string;
export function createNotesStore(home?: string): {
  /** Битый файл → пустые заметки, файл переименован в *.corrupt-<время>.json, его путь — corruptedTo. */
  load(workKey: string, sessionId: string): Promise<{ file: NotesFile; corruptedTo: string | null }>;
  save(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;
};

// bridge.ts, app
loadNotes(workKey: string, sessionId: string): Promise<{ file: NotesFile; corruptedTo: string | null }>;
saveNotes(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;

// review/notes/format.ts
export function formatNotes(input: { sessionLabel: string; branch: string | null; notes: DiffNote[] }): string;

// review/notes/anchor.ts
/** Ищет anchor.text: своя строка → ±20 строк → не нашла (stale). */
export function relocate(note: DiffNote, lines: string[]): { startLine: number; endLine: number; stale: boolean };
```

**Поведение**
- **Постановка:**
  - наведение на строку гаттера — «+» (свой оверлей: glyph-декорации Monaco не
    кликабельны);
  - протяжка с зажатой кнопкой — диапазон строк;
  - ⌘⇧A — заметка на выделение.
  - `NoteEditor` под строкой: ⌘Enter сохраняет (1–4000 символов), Esc отменяет.
- **Показ.** Заметка — view zone под `endLine`: текст, автор «ты», время, «Править»,
  «Удалить», «Отправить».
  - Отправленная свёрнута в строку «отправлено S02 · 14:05».
  - Устаревшая — приглушена с меткой «устарела».
- **Хранение.** `notes-store` через 300 мс после изменения, атомарно и очередью на
  файл (`atomic-file.ts`, 1.1). Загрузка при открытии вкладки диффа. `corruptedTo` не
  `null` — тост «Заметки сессии повреждены — сохранены в <путь>» (спека 13).
- **Проверка аргументов** в `app:load-notes` и `app:save-notes` (сквозное правило
  индекса):
  - `sessionId` — только `isSessionId`: иначе `../..` из рендерера читал бы и писал JSON
    вне `notes/`;
  - `workKey` — строка 1..4096 символов: в имя каталога идёт только её `sha1`;
  - `notes` — форма `NotesFile`: `version: 1`, массив заметок с полями спеки 11.4,
    `body` 1..4000 символов. Иначе отказ, файл не пишется.
- **Переезд.** При каждом обновлении диффа `relocate` двигает заметки. Не нашла —
  `stale: true`.
- **Отправка:**
  - одна, заметки файла или все неотправленные (без `stale`, если их не выбрали
    явно);
  - получатель — `SendMenu`: сессии работы с `AgentStateDot` и временем, по
    умолчанию сессия диффа, не запущенные неактивны;
  - текст — `formatNotes` (спека 11.4), `sendToAgent(submit: true)`, тост `sendToast`;
  - `submitted` или `inserted` (`draft`, `input`, `restarted`) → `sentAt`, `sentTo`;
  - `blocked`, `busy`, `no-paste-mode` → без изменений.
- **Тесты в jsdom** — те же заглушки Monaco и `IntersectionObserver`, что в 8.3.

**Тесты**
1. `formatNotes`:
   - одна строка → `Строка: 7`;
   - диапазон → `Строки: 10-14`;
   - старая сторона → строка `Сторона: до изменений`;
   - две заметки разделены пустой строкой;
   - порядок — по файлу, потом по строке;
   - переводы строк в тексте сохранены.
2. `relocate`:
   - строка на месте → та же;
   - сдвиг на 5 строк → новая позиция;
   - текст исчез → `stale: true`;
   - сдвиг на 25 строк → `stale: true`.
3. `notes-store`: туда-обратно; битый файл → пустые заметки, файл `*.corrupt-*` рядом,
   `corruptedTo` — его путь.
4. `store` заметок: после `submitted` у отправленных `sentAt`; после `blocked` —
   `sentAt: null`.
5. `GutterAdd`: протяжка со строки 10 до 14 открывает редактор с диапазоном 10–14.
6. `SendMenu`: по умолчанию сессия диффа; не запущенная сессия неактивна.
7. Проверка аргументов:
   - `notesPath` и `app:load-notes` с `sessionId` `../x`, `s-1/../../x` и `S-01` →
     отказ, файлов вне `notes/` нет;
   - `workKey` длиной 4097 → отказ;
   - `app:save-notes` с заметкой без `body` или с `body` из 4001 символа → отказ.
8. Загрузка битых заметок во вкладке диффа → тост «Заметки сессии повреждены — сохранены
   в …».
9. **E2E `review.spec.ts`** (`STUB_BRACKETED=1`, сессия в worktree):
   - тест пишет файл в worktree;
   - «Изменения» → файл в «Незакоммиченных»;
   - вкладка диффа → заметка к строке → «Отправить»;
   - stub печатает `PASTE<<Заметки к изменениям S01` и `echo:`.
10. **E2E:** коммит из «Изменений» с сообщением, затем «Слить в <база>» с
    подтверждением → в базе появился merge-коммит (`git log` из теста).
11. **E2E:** правка одной строки в базе и в ветке → секция «Конфликты» с файлом до
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
- [ ] `README.md` обновлён.
