# План, этап 7: редактор и превью

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 10, строка 7 таблицы 14.3.

**Итог этапа:**
- правый сайдбар с деревом файлов папки сессии;
- файлы открываются во вкладке Monaco и сохраняются по ⌘S; правка агента на диске не
  перетирается молча;
- ⌘P и поиск по содержимому;
- превью Markdown, картинок, PDF и CSV.

**Перед стартом.** Сверить с кодом этапов 2–6:
- main: `main/roots.ts` (`resolve`, `locate`, `FilesDeniedError`),
  `main/files/fs-api.ts`, `main/files/ipc.ts`, `main/files/open-path.ts`,
  `main/ipc.ts#withIpcError` (экспорт с 5.2), `main/host-connection.ts#HostError`,
  `main/shell-env.ts#captureShellEnv`;
- `main/atomic-file.ts`: его `writeAtomic` для файлов корня не годится — имя временного
  файла предсказуемо, а `writeFile` идёт по ссылке. Из модуля берётся только очередь
  (`createFileQueue`);
- общее: `shared/files-types.ts`, `shared/work-keys.ts`, `shared/ipc-error.ts`,
  `shared/strings.ts` (`S.files`, `S.links`, `S.terminal`, `S.errors.actions`), страж
  `english-ui.test.ts`;
- раскладка: `layout/tree.ts` (`TabSpec` вида `file`), `layout/ids.ts#tabId.file`,
  `layout/store.ts` (`requestCloseTabs`, `setCloseGuard`, `selectedSessionOf`,
  `entries()`), `layout/dnd.ts` (`acceptsTerminal`, `isDragItem`, `applyDrop`,
  `onTerminalDrop` и его мок в `shell/AppShell.dnd.test.tsx`),
  `layout/DropIndicator.tsx#useTerminalDropPreview`, `layout/GroupView.tsx` (`TabBody`
  бросает на виде `file`), `layout/tab-meta.ts` (`TabMetaExtras.dirtyTabIds`),
  `layout/Tab.tsx`, `layout/use-tab-meta-extras.ts` (4.2);
- палитра и клавиши: `palette/store.ts` (режим `files`), `palette/score.ts`,
  `palette/documents.ts`, `palette/actions.ts` (`ActionContext`), `keys/handler.ts`
  (`IMPLEMENTED_ACTIONS`, `isActionAvailable`) и его тест 2 куска 6.1b,
  `keys/focus-context.ts` (контекст `monaco`);
- терминал: `terminal/links.ts`, `LinkMenu.tsx` (пункт «Открыть в редакторе»),
  `TerminalSurface.tsx` (⌘-клик по ссылке), `terminal/send.ts` (`sendWithToast`,
  `SendWithToastDeps`), `terminal/drop.ts` (`pathsToInput`);
- прочее: `sidebar/CardMenu.tsx` («Delete…»), `sidebar/SessionRowMenu.tsx` («Delete»),
  `shell/Titlebar.tsx` и его тест («Right sidebar» неактивна до 7.2),
  `lib/capabilities.ts` (`useHostSupports`).

**Строки интерфейса** — правило индекса («Сквозные ограничения», кусок E.1):
- русские строки интерфейса в «…» ниже — смысл, а не текст. Текст — английский, ключом
  `S` в `packages/desktop/src/shared/strings.ts`: ключ и английский стоят в «Интерфейсах»
  куска. Кусок, который добавляет строки, вносит `shared/strings.ts` в «Изменить»;
- тесты ждут английский текст;
- main текста для человека не пишет. Его ошибки — `FilesDeniedError` (5.2) и
  `HostError(code, …)` (`main/host-connection.ts`) с английским техническим текстом для
  консоли: страж `english-ui` сканирует и `main/`. Коды файлового API — `files:denied`,
  `files:watch-failed`, `files:too-large`, `not_found`, `bad_request`. `readOnlyReason` —
  тоже код (`'too-large' | 'not-utf8'`), слова к нему берёт рендерер;
- окно показывает ошибку по коду: `files:denied` — `S.files.denied` (5.2),
  `files:too-large` — `S.files.tooLarge`, `not_found` файла — тело `S.files.notFound`,
  `files:watch-failed` — кнопка `S.files.refresh` в шапке «Файлов»; прочее —
  `errorText(decodeIpcError(err).code, S.errors.actions.<действие>)`. Кодов `files:*`
  `errorText` не знает и дал бы «Couldn't …: failed.». Сообщение ошибки — только в
  консоль;
- путь, имя файла, ветка, ярлык сессии (`S02`), текст файла и запрос поиска — данные, а
  не строки интерфейса: идут как есть.

**Семь кусков вместо пяти.** 7.1 и 7.3 переросли «1–2 задачи» и разрезаны (сверка
этапа 7, по образцу 6.1a и 6.1b):
- 7.1a — файлы main без git: `list`, `readText`, `readBytes`, `write`, мост и
  подставной мост;
- 7.1b — git, поиск и слежение;
- 7.3a — буферы, вопрос при закрытии, точка «не сохранён» — без редактора;
- 7.3b — Monaco, тело вкладки файла, баннер, сравнение, «Открыть в редакторе».

---

## 7.1a. Файловый API main: чтение и запись

**Зачем.** Редактору и дереву нужны файлы — только внутри корней работы.
**Зависит от:** 5.2. **Спека:** 10.7, 10.8.

**Файлы**
- Изменить:
  - `packages/desktop/src/main/files/fs-api.ts` и тест — `list`, `readText`,
    `readBytes`, `write`;
  - `main/roots.ts` и тест — `rootPath`; запись в `.harnas` — отказ, как в `.git`;
    чтение отсутствующей цели — `not_found`;
  - `main/files/ipc.ts` и тест — каналы этих четырёх методов с проверкой аргументов
    (модуль из 5.2);
  - `src/shared/files-types.ts` — из `FilesApi` спеки 10.7 `list`, `readText`,
    `readBytes`, `write` и типы `DirEntry`, `TextFile`. Остальное добавляет 7.1b, а
    `gitCommitFiles` — 8.3;
  - `src/shared/bridge.ts`, `src/preload/index.ts` — эти методы группы `files`;
  - `renderer/test-utils/fake-bridge.ts` — подставные методы, ответы и журналы для
    7.2–7.5 (ниже).

**Интерфейсы** — спека 10.7 (`DirEntry.target`, `readOnlyReason` кодом), плюс
внутренние:

```ts
// shared/files-types.ts — спека 10.7; в 7.1a
export interface DirEntry {
  name: string; kind: 'file' | 'dir' | 'symlink'; size: number; mtimeMs: number; ignored: boolean;
  /** У симлинка — вид цели внутри корня; null — цель вне корня или ссылка висячая; у прочих — null. */
  target: 'file' | 'dir' | null;
}
export interface TextFile {
  text: string; mtimeMs: number; size: number; binary: boolean; utf8: boolean;
  readOnlyReason: 'too-large' | 'not-utf8' | null;   // код: слова — S.files.readOnlyTooLarge, readOnlyNotUtf8 (7.3b)
}
// FilesApi, дополнение 7.1a (stat и locate — с 5.2)
list(root: FileRoot, dir: string): Promise<DirEntry[]>;     // dir относительный, '' — корень
readText(root: FileRoot, path: string): Promise<TextFile>;
readBytes(root: FileRoot, path: string, limit?: number): Promise<Uint8Array>;   // limit — 1 байт … 20 МБ, по умолчанию 20 МБ
/** expectedMtimeMs: null — файла быть не должно: создать; уже есть — conflict. */
write(root: FileRoot, path: string, text: string, expectedMtimeMs: number | null)
  : Promise<{ ok: true; mtimeMs: number } | { ok: false; conflict: { mtimeMs: number } }>;

// main/files/fs-api.ts
export const LIMITS: { editableBytes: 2 * 1024 * 1024; openableBytes: 20 * 1024 * 1024 };
export function detectText(buffer: Buffer): { binary: boolean; utf8: boolean }; // NUL в первых 8 КБ; строгое декодирование UTF-8
/** open(O_RDONLY | O_NONBLOCK), затем fstat().isFile(); не обычный файл — HostError('bad_request'), дескриптор закрыт. */
export async function openRegularFile(absPath: string): Promise<FileHandle>;
/**
 * Запись по realpath из roots.resolve(…, 'write'): временный файл рядом со случайным
 * именем, open(…, 'wx'), сверка realpath его каталога с каталогом absPath, права прежние
 * (новый файл — 0644), rename. Имя занято или каталог подменён — ошибка, цель не тронута.
 */
export async function writeAtomicPreservingMode(absPath: string, text: string, random?: () => string): Promise<number>; // mtimeMs

// main/roots.ts, дополнение RootsRegistry
/** realpath корня — cwd для git (7.1b); нет корня — FilesDeniedError. */
rootPath(root: FileRoot): string;

// test-utils/fake-bridge.ts, дополнение FakeBridge — ответы и журналы тестов 7.2–7.5
setDir(root: FileRoot, dir: string, entries: DirEntry[] | IpcErrorInfo): void;     // files.list; по умолчанию []
setFile(root: FileRoot, path: string, file: TextFile | IpcErrorInfo): void;         // readText; по умолчанию not_found
setBytes(root: FileRoot, path: string, bytes: Uint8Array | IpcErrorInfo): void;     // readBytes; по умолчанию not_found
/** Следующий write этого пути ответит conflict с этим mtimeMs; без него — ok с новым mtimeMs. */
setWriteConflict(root: FileRoot, path: string, mtimeMs: number): void;
readonly writes: Array<{ root: FileRoot; path: string; text: string; expectedMtimeMs: number | null }>;
readonly readTextCalls: Array<{ root: FileRoot; path: string }>;
```

**Поведение**
- **Проверка корней.** Каждый вызов с путём сначала проходит `roots.resolve` — правила
  чтения и записи 5.2. Отказ — `FilesDeniedError`, код `files:denied` (`withIpcError`,
  5.2).
- **Ошибки** — `HostError(code, …)` с английским техническим текстом, код отдаёт
  `withIpcError`:
  - `not_found` — цели нет: `resolve(…, 'read')` отличает `ENOENT` у `realpath` цели от
    выхода за корень. Иначе удалённый файл окно показало бы как «путь вне папок работы»;
  - `files:too-large` — больше 20 МБ у `readText`, больше `limit` у `readBytes`;
  - `bad_request` — неверные аргументы или не обычный файл.
- **Проверка аргументов** (спека 15.2) — до обращения к диску: `FileRoot` и пути — как в
  5.2; `limit` — целое от 1 до 20 МБ; `text` — строка; `expectedMtimeMs` — конечное число
  или `null`. Неверная форма — `bad_request`.
- **`list`:**
  - записи папки без `.git` и `.harnas` в любом регистре. `.harnas/` — карты, почта и
    журналы хуков core (`packages/core/src/work/store.ts`): правка из окна обошла бы
    `map.lock` хоста;
  - только файлы, папки и симлинки: FIFO, сокеты и устройства не показываются;
  - `ignored: false` у всех: `git check-ignore` подключает 7.1b;
  - симлинк — `kind: 'symlink'`, `target` — вид цели, если её `realpath` внутри корня,
    иначе `null`. Раскрывается и открывается только ссылка с `target`.
- **`readText`:**
  - файл открывает `openRegularFile`. Агент может положить в worktree FIFO (`mkfifo`):
    `readFile` на нём висит в `open()` в пуле потоков libuv, а их четыре. Несколько
    таких вызовов остановили бы все `fs` main, включая запись `ui.json` и
    `layouts.json`. С `O_NONBLOCK` `open` возвращается сразу, а `fstat().isFile()`
    отказывает;
  - `detectText` определяет `binary` и `utf8`;
  - `readOnlyReason`: больше 2 МБ — `'too-large'`; не UTF-8 — `'not-utf8'`;
  - больше 20 МБ — `files:too-large`.
- **`readBytes`** — тот же `openRegularFile`; больше `limit` — `files:too-large`.
- **`write`:**
  - путь — `resolve(…, 'write')` (5.2): висячая ссылка и ссылка наружу отказывают,
    запись идёт по `realpath`; `.git` и `.harnas` среди звеньев — отказ;
  - `expectedMtimeMs` не совпал с диском — `{ ok: false, conflict }`, запись не
    делается. `null` — «файла быть не должно»: «Сохранить заново» после удаления создаёт
    файл, а если его успел создать агент — `conflict`;
  - очередь на `realpath` — приём `createFileQueue` из `main/atomic-file.ts`: сверка
    `mtime` и запись одного файла идут по одной. Иначе ⌘S дважды подряд или две работы
    одного проекта прошли бы сверку с одним и тем же старым `mtime`;
  - временный файл рядом со случайным именем (`.<имя>.<8 hex>.harnas-tmp`) создаётся
    `open(…, 'wx')`. Заранее подложенный файл или симлинк с этим именем даёт `EEXIST`:
    запись отказывает, цель не тронута. Предсказуемое имя можно было бы подложить
    ссылкой наружу — поэтому не `writeAtomic` из `main/atomic-file.ts`;
  - после `open` `realpath` каталога временного файла сверяется с каталогом из
    `resolve`. Агент мог между ними заменить `src/` ссылкой наружу, а промежуточные
    звенья пути `open` проходит по ссылкам. Не совпало — временный файл удаляется, отказ
    `files:denied`. Подмена между сверкой и `rename` остаётся — остаточный риск спеки
    10.8;
  - затем `chmod` прежних прав (новый файл — 0644) и `rename`; ошибка — временный файл
    удаляется.

**Тесты** (временные каталоги)
1. `list`: `.git`, `.Git` и `.harnas` нет; симлинк наружу — `target: null`, симлинк на
   папку внутри корня — `target: 'dir'`; FIFO (`mkfifo`) в списке нет; у всех
   `ignored: false`.
2. `readText`:
   - двоичный (NUL) → `binary: true`;
   - 3 МБ текста → `readOnlyReason: 'too-large'`;
   - Latin-1 с байтом `0xE9` → `utf8: false`, `readOnlyReason: 'not-utf8'`;
   - 21 МБ → `decodeIpcError` даёт `files:too-large`;
   - файла нет → `not_found`.
3. FIFO в корне: `readText` и `readBytes` → `bad_request` быстрее чем за секунду, без
   писателя на другом конце.
4. `write`:
   - совпавший `mtime` — запись, права прежние;
   - устаревший — `conflict`, файл не изменён;
   - `expectedMtimeMs: null` — новый файл с правами 0644; файл уже есть — `conflict`.
5. Две записи одного файла без `await` между ними с одним `expectedMtimeMs` → первая
   `ok`, вторая `conflict`, на диске текст первой.
6. Любой вызов с путём `../x` → отказ, `decodeIpcError` даёт `files:denied`.
7. `write` через висячую ссылку `a.ts → <вне корня>/x` → `files:denied`, вне корня файла
   нет; через ссылку внутри корня — изменена цель, ссылка осталась ссылкой.
8. `write` при подложенном временном имени (подставной `random`, по этому имени —
   симлинк наружу) → ошибка; файл снаружи и цель не изменены.
9. Подмена родителя: `writeAtomicPreservingMode` с путём от `resolve`, после которого
   `src/` заменён ссылкой наружу, → `files:denied`; временного файла нет ни в корне, ни
   снаружи, файлы снаружи не изменены.
10. `write('.GIT/config')` и `write('.harnas/works/w/map.json')` → `files:denied`.
11. Проверка аргументов: `limit` 0 и 21 МБ, `expectedMtimeMs` `NaN` и строкой, путь с
    NUL → `bad_request`, диск не тронут.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.1b. Git, поиск и слежение в main

**Зачем.** Дереву — статус и живые обновления, ⌘P и поиску — список файлов и
совпадения. Ни git, ни регулярка человека не останавливают main.
**Зависит от:** 7.1a. **Спека:** 10.1–10.3, 10.7, 10.8, 13.

**Файлы**
- Создать в `packages/desktop/src/main/files/`:
  - `git-api.ts` и тест: `createGitRunner`, `gitRootOf`, `lsFiles`, `grep`, `cancel`,
    `gitShow`, `gitStatus`, `checkIgnored`, `walkFiles`, `runGrepWorker`;
  - `grep-worker.ts` и тест — воркер `worker_threads`: поиск без git и подсветка
    `ranges`;
  - `watch.ts` и тест: `watch`, `unwatch`, события `changed` и `treeChanged`.
- Изменить:
  - `main/files/fs-api.ts` и тест — `list` берёт `ignored` из `checkIgnored`;
  - `main/files/ipc.ts` и тест — остальные каналы `files:*` с проверкой аргументов;
  - `src/shared/files-types.ts` — остальной `FilesApi` спеки 10.7 без `gitCommitFiles`
    (его добавляет 8.3), `GrepQuery`, `GrepResult`;
  - `src/shared/bridge.ts`, `src/preload/index.ts` — эти методы и события группы
    `files`;
  - `src/main/index.ts` — `createGitRunner(shellEnv.env)`; подписки слежения и поиски
    окна снимаются при перезагрузке и закрытии;
  - `renderer/test-utils/fake-bridge.ts` — подставные методы, ответы, журналы и
    эмиттеры (ниже).

**Интерфейсы** — спека 10.7 без `gitCommitFiles`, плюс внутренние:

```ts
// shared/files-types.ts — FilesApi, дополнение 7.1b (gitCommitFiles добавит 8.3)
watch(root: FileRoot, path: string): Promise<string>;       // id подписки; path '' — дерево корня
unwatch(id: string): Promise<void>;
onChanged(listener: (e: { id: string; path: string; mtimeMs: number | null; deleted: boolean }) => void): () => void;
onTreeChanged(listener: (e: { rootKey: string; dirs: string[] }) => void): () => void;   // rootKey — shared/work-keys.ts
lsFiles(root: FileRoot): Promise<string[]>;
grep(root: FileRoot, query: GrepQuery, signalId: string): Promise<GrepResult>;
cancel(signalId: string): Promise<void>;
gitShow(root: FileRoot, rev: string, path: string): Promise<TextFile | null>;   // null — файла или ревизии нет
gitStatus(root: FileRoot): Promise<Record<string, 'M' | 'A' | 'D' | 'U' | 'R'>>;   // не git — {}
export interface GrepQuery { text: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export interface GrepResult { files: Array<{ path: string; hits: Array<{ line: number; text: string; ranges: [number, number][] }> }>; truncated: boolean }

// main/files/git-api.ts
export interface GitRunner {
  /**
   * git в cwd с PATH login-shell. onStdout — вывод по мере прихода: false — процесс гасится
   * (предел grep); maxBytes — предел накопленного stdout: выше — процесс гасится, truncated.
   * git нет в PATH — отказ с code 'ENOENT'.
   */
  run(args: string[], cwd: string, options?: { signal?: AbortSignal; maxBytes?: number; onStdout?(chunk: Buffer): boolean })
    : Promise<{ code: number | null; stdout: Buffer; stderr: string; truncated: boolean }>;
}
export function createGitRunner(env: NodeJS.ProcessEnv): GitRunner;         // main/index.ts: shellEnv.env
/** git rev-parse --show-prefix в cwd = rootPath; кэш на корень. null — не git: ENOENT или ненулевой выход. */
export function gitRootOf(git: GitRunner, rootPath: string): Promise<{ prefix: string } | null>;
export function parseLsFiles(stdout: Buffer): string[];                     // -z
/** --porcelain=v1 -z: пути от корня репозитория → от папки корня (срез prefix); вне корня — выброшены; буквы — таблица ниже. */
export function parseGitStatus(stdout: Buffer, prefix: string): Record<string, 'M' | 'A' | 'D' | 'U' | 'R'>;
/** Разбор вывода git grep --null -n кусками; push → false на пределе. ranges пустые — их считает воркер. */
export function createGrepParser(limits: { hits: 2000; files: 200 }): { push(chunk: Buffer): boolean; result(): GrepResult };
/** Не-git корень: обход по lstat до 50 000 обычных файлов, без node_modules, .git и .harnas; симлинки — правила ниже. */
export function walkFiles(root: string, limit: 50_000): Promise<string[]>;
/** rev для gitShow: HEAD или 7–40 hex, в конце допустим ^. */
export function isSafeRev(rev: string): boolean;
/** Воркер с заданием; cancel и предел времени — worker.terminate(), ответ — найденное к этому моменту с truncated. */
export function runGrepWorker(job: GrepJob, options: { signal: AbortSignal; timeoutMs: number; spawn?: () => Worker }): Promise<GrepResult>;  // 10 000 мс

// main/files/grep-worker.ts — тело воркера; в сборке его создаёт ?nodeWorker electron-vite, в тестах — spawn
export type GrepJob =
  | { kind: 'ranges'; query: GrepQuery; files: GrepResult['files'] }         // строки из git grep
  | { kind: 'walk'; query: GrepQuery; rootPath: string; paths: string[] };   // поиск без git
/** Совпадения в строке: [начало, конец) в кодовых единицах; регулярка и флаги — из запроса. */
export function matchRanges(query: GrepQuery, line: string): [number, number][];

// test-utils/fake-bridge.ts, дополнение FakeBridge
setLsFiles(root: FileRoot, paths: string[] | IpcErrorInfo): void;       // по умолчанию []
setGrepResult(result: GrepResult | IpcErrorInfo): void;                 // ответ следующих grep; по умолчанию пусто
setGitStatus(root: FileRoot, status: Record<string, 'M' | 'A' | 'D' | 'U' | 'R'>): void;   // по умолчанию {}
setWatchFails(root: FileRoot): void;                                    // watch корня → files:watch-failed
emitFileChanged(e: { id: string; path: string; mtimeMs: number | null; deleted: boolean }): void;
emitTreeChanged(e: { rootKey: string; dirs: string[] }): void;
readonly grepCalls: Array<{ root: FileRoot; query: GrepQuery; signalId: string }>;
readonly cancelCalls: string[];
readonly watchCalls: Array<{ root: FileRoot; path: string; id: string }>;
readonly unwatchCalls: string[];
readonly lsFilesCalls: FileRoot[];
readonly gitStatusCalls: FileRoot[];
```

**Поведение**
- **Git-корень** — `gitRootOf`: `git rev-parse --show-prefix` в `cwd = rootPath(root)`,
  кэш на `realpath` корня. Папка проекта может быть подкаталогом репозитория: `prefix` —
  её путь от корня репозитория (`sub/`). `ENOENT` при запуске (git нет в PATH
  login-shell) или ненулевой выход (не репозиторий) — корень не git (спека 13):
  - `gitStatus` → `{}`, `list` → `ignored: false`;
  - `lsFiles` — `walkFiles`, `grep` — воркер по `walkFiles`.
- **Пути git-вызовов** — от папки корня: `ls-files` и `grep` в подкаталоге так и
  отдают, у `status` срезается `prefix`. Все вызовы — с pathspec
  `-- . ':(exclude).harnas'`: `.harnas/` проекта нет ни в ⌘P, ни в поиске, ни в статусе
  (спека 10.1).
- **`list` → `ignored`** — одним вызовом `git check-ignore --stdin -z` на все имена
  папки. Выход 1 — «ничего не игнорируется», не ошибка; прочий ненулевой — `ignored:
  false` у всех и предупреждение в консоль main.
- **`walkFiles`** (⌘P и поиск в не-git корне) идёт по `readdir(withFileTypes)` и
  `lstat`:
  - берёт только обычные файлы: FIFO, сокеты и устройства пропускает; файл-симлинк —
    только если `stat().isFile()` и его `realpath` внутри `realpath` корня;
  - в каталоги-симлинки не заходит: ссылка `docs/home → ~` иначе отдала бы окну строки
    `~/.aws/credentials` в ⌘⇧F;
  - `node_modules`, `.git` и `.harnas` пропускает.
- **`lsFiles`:**
  - git: `git ls-files -co --exclude-standard -z -- . ':(exclude).harnas'`;
  - иначе `walkFiles` до 50 000;
  - кэш — только у корня под слежением дерева, сброс по его `treeChanged`. Корень без
    слежения не кэшируется: сбросить кэш было бы нечем.
- **`grep`:**
  - git: `['grep', '-n', '-I', '--no-color', '--null', ...флаги, '--untracked', '-e',
    query.text, '--', '.', ':(exclude).harnas']`; флаги — `-i` без `caseSensitive`,
    `-w` при `wholeWord`, `-F` или `-E` по `regex`;
  - запрос стоит после `-e`: без него `-f/путь/вне/корней` git прочёл бы как файл
    шаблонов, и ответ стал бы оракулом по чужому файлу — та же дыра, что закрыта для
    `rev` у `gitShow`. `--untracked` — новые незакоммиченные файлы: ⌘P их показывает, а
    в worktree агента они главные;
  - вывод разбирает `createGrepParser` по мере прихода; на пределе 2000 совпадений или
    200 файлов процесс гасится, `truncated: true`. Весь вывод в памяти не копится;
  - подсветку `ranges` git не отдаёт: её считает воркер (`kind: 'ranges'`);
  - не-git корень — воркер (`kind: 'walk'`) по файлам `walkFiles`. Каждый файл
    открывается как в `readText` (`O_NONBLOCK`, `fstat().isFile()`); больше 20 МБ и
    двоичные (NUL в первых 8 КБ, как `-I` у git) пропускаются;
  - регулярка человека по тексту агента исполняется только в воркере. Катастрофический
    откат (`(a+)+$`) в потоке main остановил бы события хоста и вывод терминалов, а
    `cancel` синхронный `exec` не прерывает;
  - `cancel(signalId)` — `AbortController` процесса git и `terminate()` воркера.
    Предел воркера — 10 с (план). Отменённый или остановленный по пределу поиск
    отвечает найденным к этому моменту с `truncated: true`.
- **`gitShow(rev, path)`** — `git show --end-of-options <rev>:./<path>`:
  - `rev` проверяет `isSafeRev`: `HEAD` или `^[0-9a-f]{7,40}\^?$`, иначе `bad_request`.
    Иначе `--output=<файл>` из рендерера заставил бы git писать вне корней;
  - `path` проверяется лексически: относительный, без NUL и `..` после нормализации.
    Существование на диске не требуется: у `D` файла на диске нет, у `R` берётся
    `oldPath`. Через `resolve` путь не идёт — он требует существующую цель;
  - `cwd` — `rootPath(root)`: корень обязан быть в реестре;
  - `./` делает путь относительным `cwd`, а не корню репозитория: папка проекта может
    быть подкаталогом репозитория;
  - вывод — не больше 20 МБ (`maxBytes`): больше — процесс гасится, отказ
    `files:too-large`. Большой блоб иначе копился бы в памяти целиком;
  - файла в ревизии нет или нет самой ревизии (`hash^` у корневого коммита) → `null`.
- **`gitStatus`** — `git --no-optional-locks status --porcelain=v1 -z -uall -- .
  ':(exclude).harnas'`:
  - `-uall`: без него новая папка пришла бы одной строкой `?? dir/`, и у файлов в ней
    не было бы `U`;
  - пути porcelain всегда от корня репозитория и по всему репозиторию: у каждого
    срезается `prefix`, записи вне корня отбрасываются. Иначе в подкаталоге буквы не
    легли бы ни на один файл дерева, а имена файлов вне корня ушли бы в окно;
  - `--no-optional-locks`: фоновый статус раз в 2 с не берёт `index.lock` рядом с
    агентом (то же решение, что у 8.1);
  - буква — по таблице, первое совпавшее правило:

| `XY` | Буква |
|---|---|
| `??` | `U` |
| конфликт: `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU` | `M` |
| `R` в X или Y | `R` на новом пути; старый путь идёт в `-z` следом отдельной записью и пропускается |
| `C` в X или Y | `A` |
| `D` в X или Y | `D` |
| `A` в X или Y | `A` |
| прочее (`M`, `T`) | `M` |

- **Слежение:**
  - `watch(root, path)` — `fs.watch` на файл и на его папку, чтобы увидеть замену
    через `rename`; дроссель 100 мс (план), событие `changed` с `mtimeMs` или `deleted`;
  - `watch(root, '')` — дерево: один `fs.watch(root, { recursive: true })` на открытый
    корень, игнорирует `.git/`, `.harnas/` и `node_modules/`; пачка `treeChanged` раз в
    300 мс с `rootKey` из `shared/work-keys.ts`. Хуки дописывают журнал в `.harnas/` на
    каждом шаге агента: без пропуска `treeChanged` шёл бы каждые 300 мс;
  - слежение не запустилось (`EMFILE` и т.п.) — отказ `files:watch-failed` и
    предупреждение в консоль main; ошибки по ходу — только предупреждение, событие не
    шлётся.
- **Проверка аргументов** (спека 15.2), неверная форма — `bad_request`: `GrepQuery` —
  непустой `text` до 1000 символов (план), флаги булевы; `signalId` и id подписки —
  непустые строки до 128 символов (план); `rev` — `isSafeRev`.
- **Окно ушло.** Подписки слежения и незавершённые поиски окна — процессы git и воркеры
  — снимаются, когда оно перезагружается (`did-start-navigation` главного фрейма) или
  закрывается (`destroyed`): иначе после перезагрузки копились бы наблюдатели и
  процессы.
- **Все git-вызовы** идут через `GitRunner` с `PATH` login-shell (`shellEnv.env`), как
  запуск хоста; его создаёт `main/index.ts`.

**Тесты** (временные каталоги, настоящий `git`)
1. `list`: файл из `.gitignore` — `ignored: true`; в папке без игнорируемых
   (`check-ignore` выходит с 1) — все `ignored: false`, ошибки нет.
2. `lsFiles` и `parseLsFiles`: отслеживаемый и новый неигнорируемый файл есть,
   игнорируемого и `.harnas/works/w/map.json` нет. Не-git корень — обход без
   `node_modules` и `.harnas`.
3. `grep`: регистр, слово, регулярка; `ranges` стоят на совпадениях; 3000 совпадений →
   2000 и `truncated`; новый неотслеживаемый файл находится (`--untracked`).
4. `grep` запросов `-f/etc/hosts` и `--open-files-in-pager=x` ищет их как текст:
   совпадения — только строки с этим текстом, `/etc/hosts` шаблонами не читается.
5. Поиск без git: `(a+)+$` по строке из 100 000 `a` с `b` в конце, затем `cancel` →
   ответ меньше чем за секунду, а поток вызова не заблокирован: его таймер срабатывает
   вовремя. Без `cancel` — ответ по пределу (в тесте `timeoutMs` 500) с
   `truncated: true`.
6. `gitShow` файла, которого нет в ревизии, → `null`; блоб больше предела (подставной
   `maxBytes`) → `files:too-large`.
7. `gitStatus`: изменённый — `M`, новый в новой папке — `U` у самого файла (`-uall`),
   удалённый — `D`, переименованный — `R` на новом пути, конфликт `UU` — `M`.
8. Корень — подкаталог `sub/` репозитория: буквы стоят на путях от `sub` (`a.txt`, а не
   `sub/a.txt`); изменённого `top.txt` вне корня в ответе нет.
9. Не git: подставной `GitRunner` с отказом `ENOENT` и обычная папка без git (выход
   128) → `gitStatus` — `{}`, `list` без ошибки и с `ignored: false`, `lsFiles` и
   `grep` — обходом.
10. `watch`: запись в файл → `changed`; замена через `rename` → `changed`; удаление →
    `deleted: true`; запись в `.harnas/works/w/log` → `treeChanged` нет.
11. `walkFiles` и поиск без git: каталог-ссылка `docs/home → <вне корня>` не обходится,
    строк оттуда нет; файл-ссылка наружу не в списке, файл-ссылка внутри корня — в
    списке; FIFO в корне не в списке, поиск не зависает.
12. `gitShow`:
    - `D`: файла на диске нет — текст из ревизии;
    - `rev` `--output=/tmp/x` и `HEAD;rm` → `bad_request`, `/tmp/x` не создан;
    - `<hash корневого коммита>^` → `null`;
    - папка проекта — подкаталог репозитория: `HEAD` и `a.ts` дают файл этой папки.
13. Перезагрузка окна (подставной `webContents`, `did-start-navigation` главного фрейма)
    снимает его слежение и гасит незавершённый `grep`; `watch` корня при `EMFILE` →
    `files:watch-failed`.
14. `lsFiles` корня без слежения не кэшируется: новый файл виден при следующем вызове.
15. Проверка аргументов: пустой `text`, `text` длиннее 1000, флаг строкой, `signalId`
    длиннее 128 → `bad_request`, git не запускался.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.2. Правый сайдбар и вкладка «Файлы»

**Зачем.** Дерево файлов сессии рядом с агентом.
**Зависит от:** 7.1b. **Спека:** 5.1 (правый сайдбар), 5.4, 10.1.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/shell/RightSidebar.tsx` и тест;
  - в `packages/desktop/src/renderer/files/`: `FilesPanel.tsx`, `Tree.tsx`,
    `RootPicker.tsx` и тесты;
  - `packages/desktop/src/renderer/files/store.ts` и тест. В 7.2 — корень и раскрытые
    папки; буферы добавит 7.3a, режим поиска — 7.4.
- Изменить:
  - `renderer/shell/AppShell.tsx` — правый сайдбар; бросок файла на терминал —
    `sendWithToast`; `layoutCollision` берёт файл терминалом только при
    `useHostSupports('pty.send')`; `dragLabel` файла; `ActionContext.ui.showRightTab`;
  - `renderer/shell/AppShell.dnd.test.tsx` — вместо мока `onTerminalDrop`: бросок файла
    на терминал → `pty.send`;
  - `renderer/shell/Titlebar.tsx` и `Titlebar.test.tsx` — кнопка «Right sidebar» (⌘L)
    активна при активной работе; тест «неактивна до 7.2» переписывается;
  - `renderer/store/ui.ts` и тест — `setSidebar` принимает `tab` для правого сайдбара;
  - `renderer/layout/store.ts` и тест — `focusedSessionOf` (ниже);
  - `renderer/keys/handler.ts` и тест — `sidebar.right.toggle` и `sidebar.files` в
    `IMPLEMENTED_ACTIONS`; тест 2 куска 6.1b (`sidebar.right.toggle` → `false`)
    переписывается;
  - `renderer/palette/actions.ts` и тест — ветки `sidebar.right.toggle` и
    `sidebar.files`;
  - `renderer/layout/dnd.ts` и тест — `DragItem` `{ kind: 'file'; root: FileRoot;
    path }`: бросок в раскладку открывает вкладку файла (`applyDrop`); `acceptsTerminal`
    и `isDragItem` принимают файл, `dndId.file`. `onTerminalDrop` уходит: бросок файла на
    терминал разбирает `AppShell`, которому нужны мост и снимок работ;
  - `renderer/layout/GroupView.tsx` — временное тело вкладки `file` (ниже); 7.3b сменит
    его на `FileBody`;
  - `src/shared/strings.ts` — строки ниже.

**Интерфейсы**

```ts
// files/store.ts; rootKey — из shared/work-keys.ts (5.2), своего нет
export interface FilesState {
  rootByWork: Record<string, FileRootSpec>;                  // выбор человека в RootPicker
  expanded: Record<string /* rootKey */, Set<string>>;       // раскрытые папки
  setRoot(workKey: string, spec: FileRootSpec): void;
  toggleDir(rootKey: string, dir: string): void;
}
/** Корень по умолчанию: worktree сессии в фокусе (worktree.createdAt !== null), иначе проект. */
export function defaultRoot(entry: WorkEntry, focusedSessionId: string | null): FileRootSpec;
/** Корень «Файлов» работы: выбор человека, пока его нет — defaultRoot. Его же берут ⌘P и ⌘⇧F (7.4). */
export function filesRootSpec(rootByWork: FilesState['rootByWork'], entry: WorkEntry, focusedSessionId: string | null): FileRootSpec;

// layout/store.ts, дополнение — одна «сессия в фокусе» правого сайдбара: «Файлы» (7.2) и «Изменения» (8.2)
/**
 * Сессия вкладки terminal или diff активной группы работы; иначе — самой свежей записи entries()
 * этой работы, чья вкладка terminal или diff ещё в раскладке; иначе null. selectedSessionOf (2.7) —
 * другое: только терминал активной вкладки активной работы (⌘T, подсветка строки сайдбара).
 */
export function focusedSessionOf(state: Pick<LayoutState, 'layouts' | 'entries'>, workKey: string): string | null;

// store/ui.ts — setSidebar из 2.3; tab есть только у правого
setSidebar(side: 'left' | 'right', patch: { open?: boolean; width?: number; tab?: 'files' | 'changes' }): void;

// palette/actions.ts, дополнение ActionContext.ui (6.3)
/** Правый сайдбар на этой вкладке; открытый не прячет. */
showRightTab(tab: 'files' | 'changes'): void;   // setSidebar('right', { open: true, tab })

// layout/dnd.ts, дополнение
export type DragItem = /* 2.6 */ | { kind: 'file'; root: FileRoot; path: string };
// acceptsTerminal(item) — true для file; хост без pty.send отсекает AppShell: layoutCollision(activeWorkKey, accepts)
dndId.file(rootKey: string, path: string): string;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
files: {
  panel: 'Files',                                            // вкладка правого сайдбара
  project: 'Project',
  worktreeRoot: (tag: string, branch: string) => string,    // '⎇ S02 · harnas/w-0003/s02'
  rootGone: 'Session folder no longer exists',
  refresh: 'Refresh',
  showIgnored: 'Show ignored files',
  copyRelativePath: 'Copy relative path',
},   // denied — с 5.2, revealedInFinder — с 5.3; Open, Open to the side — S.sidebar.sessionMenu.open, openBeside;
     // Reveal in Finder, Copy path — S.cardMenu.reveal, copyPath
errors: { actions: { readFolder: 'read folder' } },
```

**Поведение**
- **Правый сайдбар:**
  - только при активной работе: без неё (`Landing`, `activeWorkKey === null`) его нет,
    кнопка заголовка неактивна;
  - ширина `ui.rightSidebar` зеркала, пределы 220 … окно − 320, тот же `Resizer`;
    пишется `setSidebar('right', { width })` на `pointerup`;
  - activity bar сверху: «Файлы» (⌘⇧E); «Изменения» появится в 8.2;
  - активная вкладка — `ui.rightSidebar.tab`, переключение —
    `setSidebar('right', { tab })`. Напрямую `app.saveUi` не зовётся (2.3).
    `tab: 'changes'` из `ui.json` до 8.2 показывает «Файлы»;
  - ⌘L (`sidebar.right.toggle`) — `ui.toggleSidebar('right')`; ⌘⇧E (`sidebar.files`) —
    `ui.showRightTab('files')`: открывает сайдбар на «Файлах», открытый не прячет. Без
    активной работы оба — тост `S.errors.noActiveWorkspace` (6.3).
- **Корень** — `filesRootSpec`: выбор человека в `RootPicker`, пока его нет —
  `defaultRoot` по `focusedSessionOf`. Выбор держится, пока человек его не сменит. Фокус
  на вкладке файла корень без выбора не сбрасывает на проект: `focusedSessionOf` берёт
  тогда последнюю сессию из истории.
- **`RootPicker`:** «Проект» и `⎇ S02 · harnas/w-0003/s02` у каждой сессии с
  созданным worktree.
- **Дерево** — спека 10.1:
  - ленивое раскрытие через `files.list`, виртуализация, отступ 18px;
  - папки первыми, сортировка без учёта регистра;
  - симлинк с `target` раскрывается или открывается как его цель; без `target` —
    приглушён и не открывается;
  - цвет имени и буква из `gitStatus` (палитра git 4.1);
  - `gitStatus` перечитывается не чаще раза в 2 с (спека 10.1): по `treeChanged`, по
    `works.changed`, по переходу в `idle` сессии, чья папка — этот корень (worktree
    сессии; у проекта — сессии работы без worktree), и при показе панели. Коммит агента
    файлов дерева не меняет, а `.git/` слежение пропускает — у worktree каталог git и
    вовсе вне корня. Без этих поводов буквы `M` и `U` висели бы до следующей правки;
  - игнорируемые по переключателю `filesShowIgnored` (`patchUi`), приглушены;
  - `treeChanged` перечитывает раскрытые папки из события.
- **Слежение** — `files.watch(root, '')` на открытый корень. Отказ
  (`files:watch-failed`) — в шапке «Файлов» кнопка «Обновить»: она перечитывает
  раскрытые папки и `gitStatus` (спека 13).
- **Клик** открывает вкладку `file` в активной группе, ⌘-клик — в новой группе справа.
- **Контекстное меню:** Открыть · Открыть справа · Показать в Finder · Скопировать
  путь · Скопировать относительный путь.
- **Перетаскивание файла:**
  - в строку, центр или край тела — вкладка файла (`applyDrop`);
  - на поверхность терминала — зона `terminal` (2.6), она важнее тела группы, рамка —
    `useTerminalDropPreview` (2.6). Абсолютный путь (корень из снимка работ плюс `path`)
    → `pathsToInput([abs])` → `sendWithToast(deps, ref, text, false)` (5.4), раскладка
    не меняется. Зависимости — `SendWithToastDeps` из `AppShell`: `session` — из
    `useWorksStore`, `openSession` — `applyFocusTarget` (4.3). Тосты — таблица 8.6, как
    у броска из Finder: при `blocked` путь не вставлен, тост с `Copy`;
  - зона терминала — только если у хоста есть `pty.send` (`useHostSupports`, как в
    5.4): `AppShell` передаёт `layoutCollision(activeWorkKey, accepts)`, и `accepts` без
    `pty.send` файл не берёт. Иначе старый хост ответил бы `unknown_method`. Без зоны
    файл падает в тело группы — вкладкой.
- **Вкладка `file` до 7.3b.** `TabBody` в `GroupView.tsx` бросал на виде `file`: клик и
  бросок показали бы «Couldn't show layout». Временное тело — текст `files.readText` в
  `<pre>` только для чтения; отказ — `errorText(code, S.errors.actions.openFile)`. 7.3b
  меняет его на `FileBody`.
- **Корень исчез** (worktree удалён) — «Папка сессии больше не существует» и
  переключение на проект.

**Тесты**
1. `defaultRoot`: сессия с worktree → `worktree`; без — `project`; worktree с
   `createdAt: null` → `project`.
2. `focusedSessionOf`: активна вкладка терминала S02 → `s-02`; активна вкладка файла, а
   последней в истории была вкладка диффа S03 → `s-03`; вкладка S03 закрыта — берётся
   запись раньше; вкладок сессий нет → `null`.
3. `Tree`: раскрытие зовёт `files.list` один раз; второе раскрытие — из кэша до
   `treeChanged`; игнорируемые скрыты по умолчанию; симлинк без `target` не открывается.
4. Буква `M` и цвет изменённого файла по `gitStatus`.
5. `gitStatus` (поддельные таймеры, 2 с): три `treeChanged` за секунду → один вызов;
   `works.changed`, переход сессии корня в `idle` и повторный показ панели —
   перечитывание.
6. Клик открывает вкладку `file:w:s-02:src/a.ts` с текстом файла только для чтения,
   `Couldn't show layout` нет; ⌘-клик делает сплит справа.
7. Перетаскивание файла на поверхность терминала → `pty.send` с экранированным
   абсолютным путём и `submit: false`, раскладка не изменилась; тот же файл в центр тела
   — вкладка файла.
8. Бросок на терминал с ответом `blocked` → тост `S02 is waiting for your answer — text
   not inserted` с кнопкой `Copy`. Хост без `pty.send` (`setHostMethods` без него) →
   зоны терминала нет, файл открылся вкладкой в теле группы.
9. `RightSidebar`:
   - ⌘L открывает и закрывает; ⌘⇧E при закрытом открывает на `Files`, при открытом —
     не прячет;
   - ширина уходит `setSidebar('right', { width })` на `pointerup`, вкладка —
     `setSidebar('right', { tab })`; `app.saveUi` получает целый `rightSidebar`;
   - `tab: 'changes'` показывает `Files`;
   - без активной работы сайдбара нет, `Right sidebar` в заголовке неактивна.
10. `watch` корня отказал → в шапке `Refresh`; клик перечитывает раскрытые папки и
    статус.
11. Корень: выбран worktree S02, фокус ушёл на вкладку файла и на терминал S03 — корень
    прежний; без выбора — worktree сессии в фокусе.
12. `isActionAvailable('sidebar.right.toggle')` и `('sidebar.files')` → `true`;
    `runAction('sidebar.files')` зовёт `ui.showRightTab('files')` (таблица теста 1 куска
    6.3).

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.3a. Буферы файлов, вопрос при закрытии, точка «не сохранён»

**Зачем.** Правки человека живут, пока открыта вкладка, а не пока смонтировано её
тело; закрытие не теряет их молча.
**Зависит от:** 7.2. **Спека:** 5.3, 10.4, 10.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/files/`:
  - `buffer.ts` и тест — машина состояний буфера и `bufferKey`;
  - `close-guard.ts` и тест — вопрос о несохранённых буферах для `setCloseGuard` (2.2);
  - `SaveChangesDialog.tsx` — вопрос «Сохранить / Не сохранять / Отмена»;
  - `file-kind.ts` и тест — вид файла по расширению: значок вкладки (здесь), тело и
    превью (7.3b, 7.5).
- Изменить:
  - `renderer/files/store.ts` и тест — буферы, их жизнь по раскладке, `revealAt`;
  - `renderer/layout/use-tab-meta-extras.ts` — `dirtyTabIds` из `files/store.ts` (4.2);
  - `renderer/layout/tab-meta.ts` и тест — `dirty` вкладки `file` по `bufferKey`;
    `fileTabTitles`;
  - `renderer/layout/TabStrip.tsx` — заголовки файлов строки через `fileTabTitles`;
  - `renderer/layout/Tab.tsx` и тест — точка «не сохранён» по `meta.dirty` (сейчас
    `Tab.tsx` смотрит только `meta.unread`), значок по `fileKind`;
  - `renderer/shell/AppShell.tsx` и `AppShell.test.tsx` — при монтировании
    `bindBuffersToLayouts(bridge)` и `setCloseGuard(createCloseGuard(…))`,
    `SaveChangesDialog` (тест 6);
  - `renderer/sidebar/CardMenu.tsx` и тест — «Delete…» сначала закрывает вкладки файлов
    работы через `requestCloseTabs`;
  - `renderer/sidebar/SessionRowMenu.tsx` и тест — «Delete» сессии сначала закрывает её
    вкладки `file:w:<id>:*`;
  - `src/shared/strings.ts` — строки ниже;
  - `src/main/window.ts` и тест, `src/shared/bridge.ts`, `src/preload/index.ts`,
    `renderer/test-utils/fake-bridge.ts` — вопрос при закрытии окна (ниже): каналы
    `app:dirty-buffers` (рендерер → main, число грязных буферов) и `app:confirm-close` /
    `app:close-answer`.

**Интерфейсы**

```ts
// files/buffer.ts — имена состояний спеки 10.5 плюс служебные
/** Ключ буфера и точки «не сохранён»: у двух работ одного проекта id вкладки `file:p:src/a.ts` одинаковый. */
export function bufferKey(workKey: string, tabId: string): string;   // `${workKey}\0${tabId}`
export type BufferStatus = 'loading' | 'clean' | 'dirty' | 'saving'
  | 'disk-changed-clean' | 'disk-changed-dirty' | 'deleted' | 'error';
export interface BufferModel {
  status: BufferStatus; text: string; savedText: string;
  mtimeMs: number | null; diskMtimeMs: number | null;
  ownWriteMtimeMs: number | null;       // mtime последней своей записи: её эхо слежения пропускается
  pendingDiskMtimeMs: number | null;    // событие, пришедшее во время saving
  readOnlyReason: 'too-large' | 'not-utf8' | null;
  keepMine: boolean;
  errorCode: string | null;             // код decodeIpcError; слова — у FileBody (7.3b)
  reloadedAt: number | null;            // тихая перезагрузка: плашка «Обновлён с диска» 2 с
}
export type BufferEvent =
  | { type: 'loaded'; file: TextFile }
  | { type: 'edited'; text: string }
  | { type: 'save-started' }                      // во время saving — пропускается
  | { type: 'saved'; mtimeMs: number }
  | { type: 'save-conflict'; mtimeMs: number }    // write ответил conflict
  | { type: 'disk-changed'; mtimeMs: number }
  | { type: 'disk-deleted' }
  | { type: 'reloaded'; file: TextFile; at: number }
  | { type: 'keep-mine' }
  | { type: 'failed'; code: string };             // при loading — error; при saving — назад в dirty
export function bufferReducer(model: BufferModel, event: BufferEvent): BufferModel;
/** Что показать: баннер, диалог перед записью, плашку «Обновлён с диска» (2 с после reloadedAt). */
export function bufferView(model: BufferModel, now: number)
  : { banner: 'none' | 'disk-changed' | 'deleted'; confirmOverwrite: boolean; reloadedFlash: boolean };

// files/store.ts, дополнение FilesState (7.3a)
buffers: Record<string /* bufferKey */, { root: FileRoot; path: string; watchId: string | null; model: BufferModel }>;
/** Первое открытие: readText → loaded, files.watch на файл. Повтор — перемонтированное тело — ничего не делает. */
openBuffer(bridge: HarnasBridge, workKey: string, tabId: string, root: FileRoot, path: string): void;
dispatch(key: string, event: BufferEvent): void;
/** ⌘S и «Сохранить» вопроса закрытия: save-started, write с mtimeMs буфера (у deleted — null), затем saved, save-conflict или failed. */
save(bridge: HarnasBridge, workKey: string, tabId: string, options?: { overwrite?: boolean }): Promise<'saved' | 'conflict' | 'failed'>;
/** Разовая позиция курсора (строка и колонка с 1): её забирает FileBody при монтировании и при смене. */
revealAt(workKey: string, tabId: string, line: number, col: number): void;
takeReveal(key: string): { line: number; col: number } | null;
/**
 * Жизнь буферов: подписка на useLayoutStore — вкладки больше нет в layouts (requestCloseTabs, drop,
 * pruneLayout), и буфер отпускается с files.unwatch; files.onChanged разводится по буферам.
 */
export function bindBuffersToLayouts(bridge: HarnasBridge): () => void;   // AppShell при монтировании

// files/close-guard.ts
/** CloseGuard (2.2): среди закрываемых — вкладки file с грязным буфером; вопрос по каждой, ответы — после всех. */
export function createCloseGuard(deps: {
  isDirty(workKey: string, tabId: string): boolean;
  ask(workKey: string, tabId: string): Promise<'save' | 'discard' | 'cancel'>;   // SaveChangesDialog
  save(workKey: string, tabId: string): Promise<boolean>;                         // false — конфликт или ошибка записи
}): CloseGuard;

// files/file-kind.ts
export type FileKind = 'text' | 'markdown' | 'csv' | 'tsv' | 'image' | 'pdf';
/** По расширению без учёта регистра: md markdown; csv; tsv; png jpg jpeg gif webp svg; pdf; прочее — text. */
export function fileKind(path: string): FileKind;

// layout/tab-meta.ts, дополнение — dirty вкладки file: extras.dirtyTabIds (4.2) с ключами bufferKey
/** Заголовки вкладок file одной строки: имя; при совпадении имён — `папка/имя`. */
export function fileTabTitles(tabs: readonly TabSpec[]): ReadonlyMap<string /* tabId */, string>;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
files: {
  saveChanges: (name: string) => string,   // 'Save changes to a.ts?'
  save: 'Save',
  dontSave: "Don't save",
},   // Cancel — S.common.cancel
```

**Поведение**
- **Буфер живёт с вкладкой, а не с телом.** `GroupView` монтирует тело только активной
  вкладки группы (`key={activeTab.id}`), перенос в другую группу монтирует тело заново
  (спека 5.5), работа вне трёх последних LRU размонтируется целиком (`AppShell.tsx`).
  Буфер, открытый и закрытый по монтированию тела, перечитал бы файл поверх правок при
  смене вкладки или пропал бы. Поэтому:
  - буфер `bufferKey(workKey, tabId)` живёт в `files/store.ts` с первого `openBuffer`
    до исчезновения вкладки из `layouts`;
  - повторный `openBuffer` ничего не делает: перемонтированное тело берёт прежний
    буфер, файл не перечитывается;
  - отпускает буфер только `bindBuffersToLayouts` — подписка на `useLayoutStore`
    покрывает `requestCloseTabs`, `drop` (работа удалена) и `pruneLayout`; вместе с
    буфером — `files.unwatch`;
  - вопрос закрытия спрашивает и про неактивные вкладки: тела у них нет, буфер — в
    сторе.
- **Эхо своей записи.** После ⌘S слежение присылает `changed` с новым `mtime` — это не
  правка агента:
  - `disk-changed` с `mtimeMs ≤ ownWriteMtimeMs` пропускается;
  - во время `saving` событие не применяется сразу, а откладывается до ответа `write`.
    После `saved { mtimeMs }` оно применяется, только если новее записанного: агент
    успел записать между нашим `rename` и ответом;
  - иначе после каждого сохранения появлялась бы плашка «Обновлён с диска», а при правке
    сразу после ⌘S — ложный баннер.
- **Изменение на диске** — таблица спеки 10.5; `files.onChanged` разводит по буферам
  `bindBuffersToLayouts`:
  - `clean` → `disk-changed-clean`: стор перечитывает файл → `reloaded` → `clean`,
    плашка «Обновлён с диска» 2 с (`bufferView.reloadedFlash`); курсор и прокрутку
    сохраняет тело (7.3b);
  - `dirty` → `disk-changed-dirty`: баннер «Перезагрузить», «Сравнить», «Оставить мои»
    (`keep-mine`);
  - удалён — `deleted`, баннер «Сохранить заново» или «Закрыть». «Сохранить заново»
    пишет с `expectedMtimeMs: null`;
  - `deleted`, а файл появился снова (например, `git checkout` агента) — `disk-changed`
    → `disk-changed-clean` без правок или `disk-changed-dirty` с ними;
  - `write` ответил `conflict` — `save-conflict` → `disk-changed-dirty`: диск изменился
    после открытия;
  - ⌘S во время `saving` второй записи не делает: `save-started` в `saving`
    пропускается. Две записи из разных вкладок одного файла держит очередь `write`
    (7.1a).
- **Закрытие** — только `requestCloseTabs` (2.2): крестик, средняя кнопка, «Закрыть
  остальные / справа», ⌘W. `createCloseGuard` спрашивает про каждую грязную вкладку
  `file` из списка (`SaveChangesDialog`) и применяет ответы, когда получены все:
  - «Отмена» на любой — `false`: ни одна вкладка не закрыта, ничего не записано и не
    отброшено;
  - иначе «Сохранить» — `save` по очереди. Конфликт или ошибка — `false`, закрытие
    отменено; буфер конфликта — в `disk-changed-dirty`, баннер и сравнение — у его тела
    (7.3b);
  - «Не сохранять» — вкладка закрывается, её буфер отпускает `bindBuffersToLayouts`;
  - ответы, применённые по одному, сломали бы «Отмену»: «Не сохранять» на A и «Отмена»
    на B отбросили бы правки A, а вкладка A осталась бы открытой;
  - без вопроса вкладки убирают `pruneLayout` (корня нет — записывать некуда) и `drop`.
- **Удаление — сначала вкладки файлов:**
  - «Delete…» работы (3.4) после подтверждения и перед остановкой сессий зовёт
    `requestCloseTabs` всех её вкладок `file`: «Отмена» — ни `sessions.stop`, ни
    `works.delete`;
  - «Delete» сессии (3.4) удаляет и её worktree (`sessions.delete` хоста). После
    подтверждения — `requestCloseTabs` её вкладок `file:w:<id>:*`, «Отмена» —
    `sessions.delete` нет;
  - раскладка работы не гидрирована — ни её вкладок, ни буферов нет, вопроса нет.
- **Закрытие окна**, ⌘Q и перезагрузка с несохранёнными буферами спрашивают в самом окне
  (решение контролёра: потеря правок молча недопустима, а родной диалог `beforeunload`
  E2E не нажать). Рендерер держит main в курсе числа грязных буферов (`app:dirty-buffers`
  при каждом изменении). Main на `close` окна (⌘Q — через него же, `before-quit`),
  если число больше нуля, зовёт `preventDefault` и шлёт `app:confirm-close`; рендерер
  показывает тот же `SaveChangesDialog` по всем грязным буферам (`Save all` / `Don't save` /
  `Cancel`, тексты из `S`) и отвечает `app:close-answer`: `Save all` — сохранить и закрыть,
  если все записи удались (ошибка — окно остаётся, тост); `Don't save` — закрыть; `Cancel` —
  окно остаётся. Нет грязных буферов — окно закрывается сразу, вопроса нет (E2E без правок
  не меняются). Перезагрузка из меню — тот же путь.
- **Точка «не сохранён»** — `tabMeta` берёт её из `extras.dirtyTabIds` (4.2):
  `useTabMetaExtras` кладёт туда `bufferKey` грязных буферов, а `tabMeta` ищет
  `bufferKey(workKey(entry…), tab.id)`. По одному `tabId` грязный буфер одной работы
  поставил бы точку на такой же вкладке другой работы того же проекта. `Tab.tsx` рисует
  точку по `meta.dirty`.
- **Заголовок и значок** (спека 5.3): имя файла, при совпадении имён в строке —
  `папка/имя` (`fileTabTitles`); значок — по `fileKind`.

**Тесты**
1. `bufferReducer`:
   - `clean` + `disk-changed` → `disk-changed-clean`, после `reloaded` — `clean` с новым
     текстом, `bufferView` без баннера, `reloadedFlash` — 2 с и не дольше;
   - `dirty` + `disk-changed` → `disk-changed-dirty`, баннер;
   - `keep-mine` → баннер снят, `confirmOverwrite: true`;
   - `saved` → `clean`, `confirmOverwrite: false`;
   - `disk-deleted` → `deleted`; затем `disk-changed` → `disk-changed-clean` без правок
     и `disk-changed-dirty` с ними;
   - `save-conflict` → `disk-changed-dirty`;
   - `save-started` в `saving` → модель та же;
   - `failed { code: 'not_found' }` при `loading` → `error`, `errorCode: 'not_found'`;
     при `saving` → `dirty`.
2. Эхо записи: после `saved { mtimeMs: 5 }` событие `disk-changed { 5 }` статус не
   меняет; `disk-changed` во время `saving` отложено — после `saved { 5 }` событие с 5
   пропущено, с 7 — `disk-changed-clean` или `disk-changed-dirty`.
3. Стор: `openBuffer` дважды — один `readText` и один `watch`; вкладка ушла из
   раскладки через `requestCloseTabs`, `drop` работы и `pruneLayout` → буфер отпущен,
   его id в `unwatchCalls`; перенос вкладки в другую группу (`moveTab`) буфер не трогает.
4. `save` буфера `deleted` → `write` с `expectedMtimeMs: null`; два `save` подряд без
   `await` → одна запись.
5. `createCloseGuard`:
   - `discard` на A, `cancel` на B → `false`, текст буфера A прежний, `write` нет;
   - `save` на A с конфликтом → `false`, A в `disk-changed-dirty`;
   - `save` на A, `discard` на B → `true`, одна запись A.
6. Закрытие грязной вкладки крестиком, средней кнопкой и `Close others` идёт через
   `requestCloseTabs` и спрашивает `Save changes to a.ts?`: `Cancel` оставляет все
   вкладки, `Don't save` закрывает без `write`, `Save` пишет и закрывает. Грязная
   неактивная вкладка среди закрываемых — тоже вопрос.
7. «Delete…» работы с грязным файлом: `Cancel` в вопросе о буфере — ни `sessions.stop`,
   ни `works.delete`.
8. «Delete» сессии с грязным файлом в её worktree: `Cancel` — `sessions.delete` нет;
   `Don't save` — вкладка закрыта, `sessions.delete` вызван.
9. Точка и заголовок:
   - грязный буфер `file:p:src/a.ts` работы A — точка на её вкладке, на такой же вкладке
     работы B того же проекта точки нет;
   - `src/index.ts` и `docs/index.ts` в одной строке — `src/index.ts` и
     `docs/index.ts`, одиночный `a.ts` — `a.ts`.
10. `fileKind`: `README.MD` → `markdown`, `x.tsv` → `tsv`, `logo.SVG` → `image`,
    `a.pdf` → `pdf`, `Makefile` → `text`.
11. Закрытие окна (`main/window.ts`, подставной `BrowserWindow`): грязных буферов 0 —
    `close` без `preventDefault`; 2 — `preventDefault` и `app:confirm-close`; ответ
    `Don't save` — окно закрыто; `Cancel` — нет; `Save all` с ошибкой записи — окно
    остаётся, тост. Рендерер: `app:confirm-close` открывает `SaveChangesDialog` по всем
    грязным буферам. E2E: правка файла → закрыть окно → вопрос в окне → `Don't save` →
    приложение закрылось.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.3b. Monaco: вкладка файла, сохранение, изменения на диске

**Зачем.** Поправить файл рядом с агентом и не потерять его правки.
**Зависит от:** 7.3a. **Спека:** 10.4, 10.5, 13, 15.2.

**Файлы**
- Создать в `packages/desktop/src/renderer/files/editor/`:
  - `monaco-setup.ts` — локальный Monaco, воркеры, темы;
  - `MonacoEditor.tsx` и тест;
  - `FileBody.tsx` и тест;
  - `DiskChangeBanner.tsx` и тест;
  - `CompareView.tsx` — Monaco diff «диск ↔ буфер», режим `FileBody`, а не отдельная
    вкладка.
- Создать: `packages/desktop/src/renderer/test-utils/monaco-mock.ts` — общий подставной
  Monaco (ниже). Поддельный diff-редактор живёт здесь же, его дополняют 8.3 и 8.4
  (решение сверки этапа 8, D3).
- Создать: `packages/desktop/src/renderer/csp.test.ts` — CSP `index.html` против строки
  спеки 15.2.
- Создать: `packages/desktop/e2e/editor.spec.ts` — файл `.ts` на собранном окне
  (`file://`); 7.5 дописывает свои сценарии.
- Изменить:
  - `renderer/layout/GroupView.tsx` — вид `file` рисует `FileBody` вместо временного
    тела 7.2;
  - `renderer/shell/AppShell.test.tsx` — тест 2: работа вытеснена из LRU и возвращена;
  - `renderer/shell/ErrorBoundary.tsx` и тест — необязательный проп `actions`: кнопки
    рядом с «Повторить»;
  - `renderer/terminal/LinkMenu.tsx` и тест — «Открыть в редакторе»;
  - `renderer/terminal/TerminalSurface.tsx` и тест — ⌘-клик по пути файла открывает
    вкладку на строке и колонке вместо приложения по умолчанию;
  - `renderer/index.html` — `worker-src 'self'`;
  - `packages/desktop/package.json` и корневой `pnpm-lock.yaml` — `monaco-editor`,
    `@monaco-editor/react` в `devDependencies`: рендерер собирает их Vite, а
    electron-builder кладёт в `app.asar` все `dependencies` (`electron-builder.yml`,
    ключ `files`);
  - `packages/desktop/electron.vite.config.ts` — воркеры Monaco через `?worker`;
  - `src/shared/strings.ts` — строки ниже.

**Интерфейсы**

```ts
// files/editor/monaco-setup.ts
export function setupMonaco(): typeof import('monaco-editor');   // loader.config({ monaco }), MonacoEnvironment.getWorker
export function applyEditorTheme(dark: boolean): void;            // 'harnas-dark' | 'harnas-light' из токенов

// files/editor/FileBody.tsx — тело вкладки file; к буферу стора только подключается
export interface FileBodyProps {
  bridge: HarnasBridge; workKey: string; entry: WorkEntry;
  tab: Extract<TabSpec, { kind: 'file' }>;
  onClose(): void;
}

// shell/ErrorBoundary.tsx, дополнение ErrorBoundaryProps
actions?: Array<{ label: string; onClick(): void }>;   // кнопки рядом с «Повторить»

// test-utils/monaco-mock.ts — общий подставной Monaco: jsdom настоящий не грузит (тесты 7.3b, 7.5, 8.3, 8.4)
/** Модули для vi.mock('@monaco-editor/react') и vi.mock('…/files/editor/monaco-setup.js'): monaco-editor и ?worker не импортируются. */
export const monacoReactMock: Record<string, unknown>;   // Editor, DiffEditor, loader
export const monacoSetupMock: Record<string, unknown>;   // setupMonaco (KeyMod, KeyCode), applyEditorTheme
/**
 * Editor — textarea внутри div.monaco-editor с тем же onChange; onMount получает поддельный
 * редактор. DiffEditor — две такие textarea и поддельный diff-редактор: getOriginalEditor,
 * getModifiedEditor, updateOptions, dispose (8.3 и 8.4 дописывают своё).
 */
export const monacoMock: {
  editors: FakeEditor[];                  // смонтированные, по порядку
  rejectInit(error: Error): void;         // следующий loader.init() отклонится — сбой загрузки Monaco
  reset(): void;
};
export interface FakeEditor {
  options: Record<string, unknown>;                          // опции монтирования и updateOptions
  position: { lineNumber: number; column: number } | null;   // setPosition и revealLineInCenter
  press(keybinding: number): void;                           // команда addCommand, как нажатие
}

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
files: {
  readOnlyTooLarge: 'Large file — editing disabled',
  readOnlyNotUtf8: 'Not UTF-8 — editing disabled',
  tooLarge: 'File is larger than 20 MB',
  binary: 'Binary file',
  notFound: 'File not found',
  editorFailed: "Editor didn't load",
  reloadedFromDisk: 'Reloaded from disk',
  changedOnDisk: 'File changed on disk (probably by the agent)',
  deletedOnDisk: 'File deleted on disk',
  reload: 'Reload', compare: 'Compare', keepMine: 'Keep mine', saveAgain: 'Save again', overwrite: 'Overwrite',
  overwriteQuestion: 'File changed on disk after you opened it. Overwrite the changes on disk?',
},   // Open in default app — S.links.openInDefaultApp (5.3); Reveal in Finder — S.cardMenu.reveal;
     // Close, Retry, Cancel — S.common
links: { openInEditor: 'Open in editor' },
errors: { actions: { saveFile: 'save file' } },
```

**Поведение**
- **Monaco:**
  - `setupMonaco` один раз на окно: воркеры `editor`, `json`, `css`, `html`, `ts` из
    локальной сборки (`?worker`), CDN не используется;
  - у TS и JS `noSemanticValidation: true`;
  - опции спеки 10.4: шрифт терминала минус 1, без миникарты,
    `renderWhitespace: 'selection'`, `wordWrap` выключен, `scrollBeyondLastLine: false`;
  - ⌥Z — `editor.addCommand(KeyMod.Alt | KeyCode.KeyZ)` переключает `wordWrap`: своего
    такого сочетания у Monaco нет, и на macOS ⌥Z напечатал бы «Ω»;
  - тема меняется вместе с `.dark`;
  - `readOnly` при `readOnlyReason`, плашка — по коду: `S.files.readOnlyTooLarge`,
    `readOnlyNotUtf8`.
- **Сбой загрузки.** `@monaco-editor/react` при отказе `loader.init()` только пишет в
  консоль и остаётся в загрузке, а сбой воркера молча уводит работу в главный поток. У
  `FileBody` своя граница ошибки с пропом `actions`: «Editor didn't load», «Retry» и
  «Open in default app» (спека 13). Отказ `loader.init()` уходит в состояние и
  бросается из рендера. Граница `GroupView` (`S.shell.layoutError`, без «Open in default
  app») — запасная.
- **Воркеры и CSP.** CSP получает `worker-src 'self'`. `pnpm dev:desktop` отдаёт окно с
  `http://localhost`, а `harnas.app` и E2E — с `file://` (`main/window.ts`): создание
  воркеров там ведёт себя иначе. Поэтому проверка — E2E на собранном окне. Если без
  `blob:` воркеры на `file://` не создаются (запасной ход — `?worker&inline`), `blob:`
  добавляется в `worker-src` и в строку спеки 15.2 с причиной в коммите — только по
  такой пробе.
- **Открытие** — `openBuffer` (7.3a): тело только подключается к буферу стора. Текст,
  курсор и прокрутка переживают смену вкладки, перенос и вытеснение работы из LRU.
  - Больше 20 МБ (`files:too-large`) — тело «File is larger than 20 MB» и «Reveal in
    Finder».
  - Файла нет (`not_found`: удалён до клика, есть в индексе `ls-files`, но не на диске)
    — тело «File not found» и «Close», как у `MissingBody`.
  - `files:denied` — worktree удалён, а `pruneLayout` работает только при
    восстановлении: тело «Session folder no longer exists» и «Close».
  - Двоичный — «Binary file» и «Open in default app» (`app.openPath`; ответ
    `'revealed'` — тост `S.files.revealedInFinder`, 5.3). Картинки и PDF превью
    покажет 7.5.
- **⌘S** — команда Monaco (`editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS)`) → `save`
  стора:
  - `confirmOverwrite` (после «Оставить мои») — сначала диалог перезаписи;
  - `conflict` — диалог «Файл изменён на диске после открытия. Перезаписать изменения
    на диске?»: «Перезаписать» (`save` с `overwrite`: запись с новым `mtime`),
    «Сравнить» (`FileBody` в режиме `CompareView`, новой вкладки нет — вида для неё в
    раскладке нет), «Отмена»;
  - ошибка записи — тост по коду: `files:denied` — `S.files.denied`, прочее —
    `errorText(code, S.errors.actions.saveFile)`.
- **Изменение на диске** — `DiskChangeBanner` по `bufferView`: «Файл изменён на диске
  (вероятно, агентом)» — «Перезагрузить», «Сравнить», «Оставить мои»; «Файл удалён на
  диске» — «Сохранить заново», «Закрыть». Тихая перезагрузка `clean` сохраняет курсор и
  прокрутку; плашка «Обновлён с диска» 2 с — в шапке тела вкладки файла (спека 10.5).
- **Позиция** — `takeReveal` стора при монтировании и при смене: ⌘-клик по ссылке,
  «Открыть в редакторе» и клик по совпадению поиска (7.4) ставят курсор на строку и
  колонку. У `TabSpec` вида `file` строки нет, а `openTab` уже открытой вкладки её
  только фокусирует.
- **«Открыть в редакторе»** в `LinkMenu` — вкладка `file` по `located.root` и
  `located.relPath` из `files.locate` (5.3), затем `revealAt`. У ссылки на каталог
  (`located.stat.kind === 'dir'`) пункта нет. ⌘-клик по пути файла — то же сразу; по
  каталогу — как прежде, приложение по умолчанию.
- **⌘F, ⌘D, ⌘K, ⌘/, ⌘S** в Monaco достаются редактору (6.1a, контекст `monaco`).
- **Тесты в jsdom.** `monaco-editor` в jsdom не работает. Тесты подменяют
  `@monaco-editor/react` и `files/editor/monaco-setup.ts` через `vi.mock` модулями
  `test-utils/monaco-mock.ts`: мок одного `@monaco-editor/react` не спасёт —
  `MonacoEditor.tsx` через `monaco-setup.ts` притянул бы настоящий `monaco-editor` и
  модули `?worker`. `textarea` мока лежит внутри `div.monaco-editor` — по нему
  `focusContext` узнаёт редактор. `IntersectionObserver` — заглушкой.

**Тесты**
1. `FileBody` с подставными `files.*`:
   - ⌘S (команда поддельного редактора) зовёт `write` с `expectedMtimeMs`;
   - ответ `conflict` открывает диалог `File changed on disk after you opened it.
     Overwrite the changes on disk?`;
   - `Overwrite` пишет с новым `mtime`;
   - `Compare` переводит тело в `CompareView`, число вкладок раскладки прежнее.
2. Буфер переживает тело: правка, другая вкладка той же группы, обратно — текст
   прежний, в `readTextCalls` один вызов; перенос вкладки в другую группу — то же;
   работа вытеснена из трёх последних LRU (четыре работы) и возвращена — то же.
3. `readOnlyReason: 'too-large'` → редактор только для чтения и плашка `Large file —
   editing disabled`.
4. Тела по коду:
   - `not_found` — `File not found` и `Close`;
   - `files:denied` — `Session folder no longer exists` и `Close`;
   - `files:too-large` — `File is larger than 20 MB` и `Reveal in Finder`;
   - двоичный — `Binary file`; `Open in default app` → `app.openPath`, ответ
     `'revealed'` — тост.
5. `DiskChangeBanner` — каждое состояние буфера 10.5 (спека 14.2): `disk-changed-dirty`
   — `Reload`, `Compare`, `Keep mine`; `deleted` — `Save again`, `Close`; прочие —
   баннера нет. `Save again` зовёт `write` с `expectedMtimeMs: null`.
6. `LinkMenu`: `Open in editor` открывает `file`-вкладку по `located` и ставит курсор на
   строку и колонку (`position` поддельного редактора); у ссылки на каталог пункта нет.
   ⌘-клик по пути файла — вкладка, `app.openPath` не вызван.
7. Контекст фокуса: ⌘D внутри `.monaco-editor` мока группу не делит.
8. Сбой загрузки: `rejectInit` → граница `FileBody`: `Editor didn't load`, `Retry`,
   `Open in default app`; синхронный бросок редактора — то же. Опции редактора — с
   `renderWhitespace: 'selection'`.
9. ⌥Z: команда `KeyMod.Alt | KeyCode.KeyZ` переключает `wordWrap` в опциях поддельного
   редактора.
10. `csp.test.ts`: CSP из `index.html` совпадает со строкой спеки 15.2 без `blob:` в
    `img-src` (его добавит 7.5).
11. **E2E `editor.spec.ts`** на собранном окне (`file://`):
    - работа в `/tmp` с файлом `src/a.ts`;
    - `Files` → клик по `a.ts` — редактор показал текст файла;
    - собранные ошибки и предупреждения `console`, `pageerror` и события
      `securitypolicyviolation` (слушатель на `document`) пусты; строки «Could not
      create web worker» нет.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.
- [ ] В `pnpm dev:desktop` нет запросов к CDN: вкладка «Network» DevTools при
      открытии файла пуста от внешних адресов (ручная проверка).

---

## 7.4. ⌘P и поиск в файлах

**Зачем.** Любой файл сессии — за пару нажатий, любая строка — поиском.
**Зависит от:** 7.3b. **Спека:** 9.1 (префикс `/`), 10.2, 10.3.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/files/SearchPanel.tsx` и тест;
  - `packages/desktop/src/renderer/files/quick-open.ts` и тест.
- Изменить:
  - `renderer/palette/score.ts` и тест — вес названия берётся из документа;
  - `renderer/palette/documents.ts` и тест — `PaletteDoc.titleWeight`, вход `files`;
    секция `files` в режиме `files` и по префиксу `/`: без «Create workspace», вместо
    «ещё N» — строка «Refine your query»;
  - `renderer/palette/store.ts` — `openWith('files')`;
  - `renderer/palette/Palette.tsx` и тест — запрос с `/` в начале ищет файлы;
    `files.lsFiles` при открытии режима `files` или вводе `/`, строка загрузки;
  - `renderer/keys/handler.ts` и тест — `files.quickOpen` и `files.search` в
    `IMPLEMENTED_ACTIONS`; тест 2 куска 6.1b (`files.quickOpen` → `false`)
    переписывается;
  - `renderer/palette/actions.ts` и тест — ветки `files.quickOpen` (⌘P) и
    `files.search` (⌘⇧F), `ActionContext.files`;
  - `renderer/shell/AppShell.tsx` и `AppShell.test.tsx` — `ActionContext.files`; тест 3
    куска 6.1b («`emitMenu('files.quickOpen')` ничего не меняет») переписывается;
  - `renderer/files/store.ts` и тест — режим `tree | search`, `openSearch()`;
  - `renderer/files/FilesPanel.tsx` — режим поиска;
  - `src/shared/strings.ts` — строки ниже.

**Интерфейсы**

```ts
// palette/documents.ts, дополнение PaletteDoc
titleWeight?: number;   // по умолчанию 1.5 (спека 9.2); имя файла — 2 (спека 10.2)
// buildDocuments, дополнение входа
/** Документы файлов корня «Файлов» активной работы (режим files или запрос с /); null — lsFiles ещё идёт. */
files: PaletteDoc[] | null;

// palette/score.ts — вес названия из документа
export function scoreDocument(tokens: string[], doc: Pick<PaletteDoc, 'title' | 'fields' | 'titleWeight'>): number | null;

// files/quick-open.ts
/** Документы на все пути lsFiles: title — имя файла (titleWeight 2), fields — [путь]. 50 показывает секция после ранжирования. */
export function fileDocuments(root: FileRoot, paths: string[], open: (path: string, split: boolean) => void): PaletteDoc[];

// files/store.ts, дополнение FilesState (7.4)
mode: 'tree' | 'search';
/** ⌘⇧F: режим поиска с фокусом в поле. Сайдбар открывает ActionContext.ui.showRightTab('files'). */
openSearch(): void;
showTree(): void;

// palette/actions.ts, дополнение ActionContext (6.3)
files: Pick<FilesState, 'openSearch'>;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
files: {
  searchPlaceholder: 'Search in files',
  matchWholeWord: 'Match whole word',
  truncated: (n: number) => string,          // 'Showing first 2000 matches' — n совпадений в ответе
  filesTruncated: (n: number) => string,     // 'Showing first 50000 files' — n путей в ответе lsFiles
  refineQuery: 'Refine your query',
  noFiles: 'No matching files',
  loadingFiles: 'Loading files…',
},   // «Aa» и «.*» — S.terminal.matchCase, useRegex (5.3)
errors: { actions: { searchFiles: 'search in files' } },   // отказ lsFiles — readFolder (7.2)
```

**Поведение**
- **⌘P** — `files.quickOpen` → `palette.openWith('files')` по корню «Файлов» активной
  работы (`filesRootSpec`, 7.2); без активной работы — тост
  `S.errors.noActiveWorkspace` (6.3):
  - список `files.lsFiles`. Пока он идёт — строка «Loading files…» (`files: null`);
    отказ — тост `errorText(code, S.errors.actions.readFolder)`;
  - ответ с `truncated: true` (обход не-git корня упёрся в предел 50 000 или во время,
    спека 10.7) — под секцией строка «Showing first N files» (`S.files.filesTruncated(n)`,
    n — число путей ответа): файла за пределом в списке нет, и человек должен это знать;
  - ранжирование — `scoreDocument` по всем путям: имя файла — название с весом 2, путь
    — поле. Документы — на все пути: 50 — предел секции после ранжирования (6.2), и
    файл за первыми 50 путями иначе не нашёлся бы;
  - показываются первые 50; при большем числе вместо «ещё N» — строка «Refine your
    query»: раскрытая секция на 50 000 путей встала бы в cmdk;
  - совпадений нет — «No matching files». Строки «Create workspace …» (6.2) в режиме
    `files` и после `/` нет;
  - Enter открывает, ⌘Enter — справа.
- **Префикс `/`** в палитре режима `default` (спека 9.1) — та же секция «Файлы» по
  запросу без `/`.
- **⌘⇧F** — `files.search` → `ui.showRightTab('files')` и `files.openSearch()`: «Файлы»
  в режиме поиска, фокус в поле:
  - поле, «Aa», «Слово», «.*» (`S.terminal.matchCase`, `S.files.matchWholeWord`,
    `S.terminal.useRegex`);
  - запрос уходит через 250 мс тишины (план); новый запрос отменяет прежний
    (`files.cancel`), ответ отменённого не показывается;
  - результаты по файлам, свёрнутые группы, подсветка `ranges`;
  - клик открывает файл на строке: вкладка и `revealAt` (7.3a);
  - `truncated` — строка «Showing first N matches» (`S.files.truncated(n)`): предел
    2000/200 или предел времени поиска без git (7.1b);
  - отказ — тост `errorText(code, S.errors.actions.searchFiles)`.

**Тесты**
1. `fileDocuments`: запрос `main` поднимает `src/main.ts` выше `docs/main-notes/x.md`;
   60 путей → 60 документов, секция показывает 50 и строку `Refine your query`;
   шестидесятый путь находится по имени.
2. `SearchPanel`: ввод с паузой 250 мс — один `grep`; второй ввод до ответа — `cancel`
   прежнего; `truncated` показывает `Showing first 2000 matches`.
3. Клик по совпадению открывает вкладку файла и ставит курсор на строку (`revealAt`
   стора).
4. `scoreDocument`: одно совпадение по названию при `titleWeight: 2` даёт больше очков,
   чем при весе по умолчанию; без `titleWeight` — вес 1.5, как в 6.2.
5. Палитра:
   - ввод `/main` показывает секцию `Files` с `src/main.ts`, других секций нет;
   - `/нетакого` — `No matching files`, строки `Create workspace` нет;
   - пока `lsFiles` не ответил — `Loading files…`;
   - ответ `{ paths: [...], truncated: true }` — строка `Showing first N files`; при
     `truncated: false` её нет.
6. ⌘P и ⌘⇧F: `emitMenu('files.quickOpen')` открывает палитру в режиме `files`;
   `runAction('files.search')` открывает сайдбар на `Files` в режиме поиска; без
   активной работы — тост `No active workspace`; `isActionAvailable('files.quickOpen')`
   → `true`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.5. Превью; приёмка этапа 7

**Зачем.** Markdown, картинки, PDF и таблицы читаются прямо в окне.
**Зависит от:** 7.4. **Спека:** 10.6, 15.2 (CSP).

**Файлы**
- Создать в `packages/desktop/src/renderer/files/preview/`:
  - `MarkdownPreview.tsx`, `ImagePreview.tsx`, `PdfPreview.tsx`, `CsvPreview.tsx` и
    тесты;
  - `csv.ts` и тест.
- Изменить:
  - `renderer/files/editor/FileBody.tsx` и тест — тело по `fileKind` (7.3a);
    переключатели «Код / Превью» для Markdown и «Таблица / Код» для CSV и TSV — в шапке
    тела вкладки;
  - `renderer/index.html` — `img-src 'self' data: blob:`: CSP — строка спеки 15.2;
  - `renderer/csp.test.ts` — строка спеки 15.2 целиком;
  - `packages/desktop/package.json` и корневой `pnpm-lock.yaml` — `pdfjs-dist` не ниже
    4.2.67 в `devDependencies`;
  - `packages/desktop/electron.vite.config.ts` — воркер pdf.js локально; каталоги
    `cmaps/` и `standard_fonts/` из `pdfjs-dist` — в сборку рендерера;
  - `packages/desktop/e2e/editor.spec.ts` — сценарии ниже;
  - `src/shared/strings.ts` — строки ниже.
- Документы:
  - `README.md`, раздел «Окно» — файлы, редактор, ⌘P, ⌘⇧F, превью;
  - `NOTICE` — Monaco (MIT), pdf.js (Apache-2.0).

**Интерфейсы**

```ts
// files/preview/csv.ts — RFC 4180: кавычки, "" внутри, переводы строк в кавычках
export function parseCsv(text: string, delimiter: ',' | '\t', maxRows: number): { rows: string[][]; truncated: boolean };
// files/preview/MarkdownPreview.tsx
export function resolveMarkdownLink(href: string, filePath: string):
  | { kind: 'external'; url: string } | { kind: 'file'; path: string } | { kind: 'anchor'; id: string } | null;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
files: {
  code: 'Code', preview: 'Preview', table: 'Table', fit: 'Fit', actualSize: '100%',
  imageSize: (width: number, height: number) => string,   // '1280 × 720 px'
  rowsTruncated: 'Showing first 10,000 rows',
},   // поиск ⌘F в PDF — строки полосы поиска терминала: S.terminal.findPlaceholder, previousMatch, nextMatch;
     // × — S.common.close
```

**Поведение**
- **Тело по виду файла** (`fileKind`, 7.3a):
  - картинки (вместе с `svg`) и PDF сразу читаются `files.readBytes` — без `readText`:
    файл не читается дважды, а `svg` — текст, который спека 10.6 показывает картинкой;
  - Markdown — превью по умолчанию, «Код» — Monaco буфера;
  - CSV и TSV — таблица, «Код» — Monaco;
  - переключатели — в шапке тела вкладки файла (спека 10.6).
- **Markdown:**
  - `react-markdown` + `remark-gfm`, без сырого HTML;
  - `http(s)` — `app.openExternal` (во встроенном браузере — с 9.2);
  - относительная ссылка — вкладка файла;
  - картинки с относительным путём — `files.readBytes` → `Blob` → `URL.createObjectURL`,
    `revokeObjectURL` при размонтировании.
- **Картинки** `png jpg jpeg gif webp svg`: `<img>` из `Blob`, «Вписать / 100%»,
  размер в пикселях.
- **PDF** — `pdfjs-dist` с локальным воркером, прокрутка страниц:
  - данные — `getDocument({ data })` из `files.readBytes`, а не URL: проверка корней
    действует и здесь, `file://` в рендерере нет;
  - версия не ниже 4.2.67 и `isEvalSupported: false`: закрытие CVE-2024-4367. CSP и так
    запрещает `eval`, это страховка;
  - `enableScripting: false`, без `pdf.sandbox`: скрипты PDF не исполняются;
  - ссылки аннотаций открываются только `http(s)` и только через `app.openExternal`
    (свой `linkService`); прочие схемы — ничего;
  - `cMapUrl` и `standardFontDataUrl` — локальные каталоги сборки: без них CJK и
    стандартные шрифты рисуются неверно. CDN нет;
  - ⌘F — свой обработчик `PdfPreview`. У `find` реестра `when: 'terminal'` (6.1a):
    обработчик окна ⌘F в превью пропускает, а пункт «Find» меню ведёт в `runAction`, и
    тот знает только терминалы. Корень превью фокусируемый (`tabIndex={0}`); `keydown`
    ⌘F зовёт `preventDefault` и открывает полосу поиска по тексту страниц (`find`
    pdf.js), Esc закрывает её.
- **CSV и TSV:** `parseCsv` до 10 000 строк, таблица с виртуализацией, первая строка —
  заголовок; больше 10 000 — строка «Showing first 10,000 rows».
- **CSP** — строка спеки 15.2: 7.5 добавляет `blob:` в `img-src` (картинки из `Blob`),
  `worker-src` — с 7.3b. Если pdf.js потребует WebAssembly для JPX, в `script-src`
  добавляется `'wasm-unsafe-eval'` с записью причины в коммите и в строке спеки.
- **Размер `.app`.** `pdfjs-dist`, как Monaco (7.3b), — в `devDependencies`:
  electron-builder кладёт в `app.asar` все `dependencies`, а рендерер и так собирает их
  Vite.

**Тесты**
1. `parseCsv`:
   - `a,"b,c",d` → три поля;
   - `"x""y"` → `x"y`;
   - перевод строки в кавычках не рвёт строку;
   - 10 001 строка → 10 000 и `truncated`.
2. `resolveMarkdownLink`: `https://…` → `external`; `./img/a.png` относительно
   `docs/x.md` → `docs/img/a.png`; `#section` → `anchor`; `javascript:` → `null`.
3. `MarkdownPreview`: `<script>` в тексте показан текстом; картинка грузится через
   `files.readBytes`.
4. `ImagePreview`: `revokeObjectURL` при размонтировании.
5. `PdfPreview`, подставной `getDocument`:
   - получил `data`, не получил `url`;
   - получил `isEvalSupported: false` и `enableScripting: false`;
   - ссылка аннотации `https://…` → `app.openExternal`; `file:///etc/passwd` и
     `javascript:` — ничего.
6. `PdfPreview` в фокусе: ⌘F — `defaultPrevented`, полоса поиска открыта, `find` pdf.js
   вызван с запросом; Esc закрывает.
7. `FileBody`: `.png`, `logo.svg` и `.pdf` → `readBytes` без `readText`; `.md` —
   превью, `Code` — редактор; `.csv` — таблица.
8. `csp.test.ts`: CSP из `index.html` — строка спеки 15.2 целиком.
9. **E2E `editor.spec.ts`:**
   - работа в `/tmp` с файлом `notes.md`;
   - `Files` → клик — вкладка, превью;
   - `Code`, правка, ⌘S — файл на диске изменён, баннера и плашки `Reloaded from disk`
     нет.
10. **E2E:**
    - файл открыт и изменён без сохранения;
    - тест пишет в файл с диска (`fs.writeFile` из теста) → баннер `File changed on disk
      (probably by the agent)`;
    - `Keep mine` и ⌘S → диалог перезаписи; `Overwrite` — на диске текст буфера.
11. **E2E:** `.png` и `.pdf` из дерева — превью показано; ошибок и предупреждений
    `console`, `pageerror` и нарушений CSP нет (сборщик — из 7.3b).

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.
- [ ] `app.asar` собранного `harnas.app` вырос за этап в пределах спеки 18, п. 4
      (порядка 6–10 МБ); размер до этапа — сборка коммита перед 7.1a.

**Приёмка этапа 7** (человек, на пересобранном `harnas.app`)
- [ ] Открыть файл, который правит агент, увидеть баннер при его правке, сравнить.
- [ ] ⌘P находит файл по трём буквам имени; ⌘⇧F находит строку.
- [ ] Markdown, картинка, PDF и CSV открываются превью.
- [ ] В редакторе ⌘D выделяет следующее вхождение и группу не делит, ⌘K ⌘C
      комментирует строку, ⌘F открывает поиск Monaco, ⌘S сохраняет, ⌥Z переключает
      перенос строк (перенос из приёмки этапа 6).
- [ ] `README.md` и `NOTICE` обновлены.
