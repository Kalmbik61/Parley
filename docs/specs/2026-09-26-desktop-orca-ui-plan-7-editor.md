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
- `main/roots.ts` (`resolve`, `locate`), `main/files/fs-api.ts`, `main/files/ipc.ts`,
  `shared/files-types.ts`, `shared/work-keys.ts`, `shared/ipc-error.ts`;
- `layout/tree.ts` (`TabSpec` вида `file`), `layout/ids.ts#tabId.file`,
  `layout/store.ts` (`requestCloseTabs`, `setCloseGuard`), `layout/dnd.ts`
  (`acceptsTerminal`, `onTerminalDrop`), `layout/use-tab-meta-extras.ts`;
- `palette/store.ts` (режим `files`), `palette/score.ts`, `keys/focus-context.ts`
  (контекст `monaco`);
- `terminal/links.ts` и `LinkMenu.tsx` (пункт «Открыть в редакторе»).

---

## 7.1. Файловый API main

**Зачем.** Редактору, дереву и поиску нужны файлы — только внутри корней работы.
**Зависит от:** 5.2. **Спека:** 10.7, 10.8.

**Файлы**
- Изменить: `packages/desktop/src/main/files/fs-api.ts` и тест — `list`, `readText`,
  `readBytes`, `write`.
- Создать в `packages/desktop/src/main/files/`:
  - `git-api.ts` и тест: `lsFiles`, `grep`, `cancel`, `gitShow`, `gitStatus`,
    `checkIgnored`, `walkFiles`;
  - `watch.ts` и тест: `watch`, `unwatch`, события `changed` и `treeChanged`.
- Изменить:
  - `main/files/ipc.ts` и тест — остальные каналы `files:*` с проверкой аргументов
    (модуль из 5.2);
  - `main/roots.ts` и тест — `rootPath`;
  - `src/shared/files-types.ts` — `FilesApi` целиком (спека 10.7 и `locate` из 5.2);
  - `src/shared/bridge.ts`, `src/preload/index.ts` — группа `files`;
  - `src/main/index.ts` — подписки слежения окна снимаются при перезагрузке и закрытии;
  - `renderer/test-utils/fake-bridge.ts` — заглушки всех `files.*`, эмиттеры
    `emitFileChanged` и `emitTreeChanged`.

**Интерфейсы** — спека 10.7 дословно, плюс внутренние:

```ts
// main/files/fs-api.ts
export const LIMITS: { editableBytes: 2 * 1024 * 1024; openableBytes: 20 * 1024 * 1024 };
export function detectText(buffer: Buffer): { binary: boolean; utf8: boolean }; // NUL в первых 8 КБ; строгое декодирование UTF-8
/**
 * Запись по realpath из roots.resolve(…, 'write'): временный файл рядом со случайным
 * именем, open(…, 'wx'), права прежние (новый файл — 0644), rename. Имя занято — ошибка,
 * цель не тронута.
 */
export async function writeAtomicPreservingMode(absPath: string, text: string, random?: () => string): Promise<number>; // mtimeMs

// main/roots.ts, дополнение RootsRegistry
/** realpath корня — cwd для git (gitShow); нет корня — FilesDeniedError. */
rootPath(root: FileRoot): string;

// main/files/git-api.ts
export interface GitRunner { run(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: Buffer; stderr: string }> }
export function parseLsFiles(stdout: Buffer): string[];                     // -z
export function parseGitStatus(stdout: Buffer): Record<string, 'M' | 'A' | 'D' | 'U' | 'R'>;  // --porcelain=v1 -z
export function parseGrep(stdout: Buffer, query: GrepQuery, limits: { hits: 2000; files: 200 }): GrepResult; // --null -n
/** Не-git корень: обход по lstat до 50 000 файлов, без node_modules и .git; симлинки — правила ниже. */
export function walkFiles(root: string, limit: 50_000): Promise<string[]>;
/** rev для gitShow: HEAD или 7–40 hex, в конце допустим ^. */
export function isSafeRev(rev: string): boolean;
```

**Поведение**
- **Проверка корней.** Каждый вызов с путём сначала проходит `roots.resolve` — правила
  чтения и записи 5.2. Отказ — ошибка с кодом `files:denied` (`encodeIpcError`) и
  текстом «Путь вне папок работы». Исключение — `gitShow`, ниже.
- **`list`:**
  - записи папки без `.git` в любом регистре;
  - `ignored` — одним вызовом `git check-ignore --stdin -z` на все имена папки. Не
    git-корень — `ignored: false`;
  - симлинк — `kind: 'symlink'`, раскрывается только если цель внутри корня.
- **`readText`:**
  - `detectText` определяет `binary` и `utf8`;
  - `readOnlyReason`: больше 2 МБ — «Большой файл — правка выключена»; не UTF-8 —
    «Кодировка не UTF-8 — правка выключена»;
  - больше 20 МБ — ошибка «Файл больше 20 МБ».
- **`write`:**
  - путь — `resolve(…, 'write')` (5.2): висячая ссылка и ссылка наружу отказывают,
    запись идёт по `realpath`;
  - `expectedMtimeMs` не совпал с диском — `{ ok: false, conflict }`, запись не
    делается;
  - временный файл рядом со случайным именем (`.<имя>.<8 hex>.harnas-tmp`) создаётся
    `open(…, 'wx')`. Заранее подложенный файл или симлинк с этим именем даёт `EEXIST`:
    запись отказывает, цель не тронута. Предсказуемое имя можно было бы подложить
    ссылкой наружу;
  - затем `chmod` прежних прав (новый файл — 0644) и `rename`; ошибка — временный файл
    удаляется.
- **`walkFiles`** (⌘P и поиск в не-git корне) идёт по `readdir(withFileTypes)` и
  `lstat`:
  - в каталоги-симлинки не заходит: ссылка `docs/home → ~` иначе отдала бы окну строки
    `~/.aws/credentials` в ⌘⇧F;
  - файл-симлинк берёт, только если его `realpath` внутри `realpath` корня;
  - `node_modules` и `.git` пропускает.
- **`lsFiles`:**
  - git: `git ls-files -co --exclude-standard -z`;
  - иначе `walkFiles` до 50 000;
  - кэш — только у корня под слежением дерева, сброс по его `treeChanged`. Корень без
    слежения не кэшируется: сбросить кэш было бы нечем.
- **`grep`:**
  - git: `git grep -n -I --no-color --null`, флаги `-i`, `-w`, `-F` или `-E` по
    запросу;
  - иначе построчный поиск в main по `walkFiles`;
  - пределы 2000 совпадений и 200 файлов, `truncated`;
  - `cancel(signalId)` — `AbortController` процесса.
- **`gitShow(rev, path)`** — `git show --end-of-options <rev>:./<path>`:
  - `rev` проверяет `isSafeRev`: `HEAD` или `^[0-9a-f]{7,40}\^?$`, иначе `bad_request`.
    Иначе `--output=<файл>` из рендерера заставил бы git писать вне корней;
  - `path` проверяется лексически: относительный, без NUL и `..` после нормализации.
    Существование на диске не требуется: у `D` файла на диске нет, у `R` берётся
    `oldPath`. Через `resolve` путь не идёт — он требует существующую цель;
  - `cwd` — `rootPath(root)`: корень обязан быть в реестре;
  - `./` делает путь относительным `cwd`, а не корню репозитория: папка проекта может
    быть подкаталогом репозитория;
  - файла в ревизии нет или нет самой ревизии (`hash^` у корневого коммита) → `null`.
- **`gitStatus`** — `git status --porcelain=v1 -z`: `??` → `U`, `R` — новый путь.
- **Слежение:**
  - `watch(root, path)` — `fs.watch` на файл и на его папку, чтобы увидеть замену
    через `rename`; дроссель 100 мс, событие `changed` с `mtimeMs` или `deleted`;
  - `watch(root, '')` — дерево: один `fs.watch(root, { recursive: true })` на открытый
    корень, игнорирует `.git/` и `node_modules/`; пачка `treeChanged` раз в 300 мс с
    `rootKey` из `shared/work-keys.ts`;
  - слежение не запустилось (`EMFILE` и т.п.) — отказ `files:watch-failed` и
    предупреждение в консоль main; ошибки по ходу — только предупреждение, событие не
    шлётся;
  - подписки окна снимаются, когда оно перезагружается (`did-start-navigation` главного
    фрейма) или закрывается (`destroyed`): иначе после перезагрузки копились бы
    наблюдатели.
- **Все git-вызовы** идут с `PATH` login-shell (`shellEnv.env`), как запуск хоста.

**Тесты** (временные каталоги, настоящий `git`)
1. `list`: `.git` нет; файл из `.gitignore` с `ignored: true`; симлинк наружу не
   раскрывается.
2. `readText`:
   - двоичный (NUL) → `binary: true`;
   - 3 МБ текста → `readOnlyReason` про размер;
   - Latin-1 с байтом `0xE9` → `utf8: false`;
   - 21 МБ → ошибка.
3. `write`: совпавший `mtime` — запись, права прежние; устаревший — `conflict`, файл
   не изменён.
4. `lsFiles` и `parseLsFiles`: отслеживаемый и новый неигнорируемый файл есть,
   игнорируемого нет. Не-git корень — обход без `node_modules`.
5. `grep`: регистр, слово, регулярка; 3000 совпадений → 2000 и `truncated`; `cancel`
   прерывает долгий поиск.
6. `gitShow` файла, которого нет в ревизии, → `null`.
7. `gitStatus`: изменённый — `M`, новый — `U`, удалённый — `D`.
8. `watch`: запись в файл → `changed`; замена через `rename` → `changed`; удаление →
   `deleted: true`.
9. Любой вызов с путём `../x` → отказ, `decodeIpcError` даёт `files:denied`.
10. `write` через висячую ссылку `a.ts → <вне корня>/x` → `files:denied`, вне корня
    файла нет; через ссылку внутри корня — изменена цель, ссылка осталась ссылкой.
11. `write` при подложенном временном имени (подставной `random`, по этому имени —
    симлинк наружу) → ошибка; файл снаружи и цель не изменены.
12. `walkFiles` и поиск без git: каталог-ссылка `docs/home → <вне корня>` не обходится,
    строк оттуда нет; файл-ссылка наружу не в списке, файл-ссылка внутри корня — в
    списке.
13. `gitShow`:
    - `D`: файла на диске нет — текст из ревизии;
    - `rev` `--output=/tmp/x` и `HEAD;rm` → `bad_request`, `/tmp/x` не создан;
    - `<hash корневого коммита>^` → `null`;
    - папка проекта — подкаталог репозитория: `HEAD` и `a.ts` дают файл этой папки.
14. `write('.GIT/config')` → `files:denied`; `list` не показывает `.Git`.
15. Перезагрузка окна (подставной `webContents`, `did-start-navigation` главного фрейма)
    снимает его слежение; `watch` корня при `EMFILE` → `files:watch-failed`.
16. `lsFiles` корня без слежения не кэшируется: новый файл виден при следующем вызове.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.2. Правый сайдбар и вкладка «Файлы»

**Зачем.** Дерево файлов сессии рядом с агентом.
**Зависит от:** 7.1. **Спека:** 5.1 (правый сайдбар), 10.1.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/shell/RightSidebar.tsx` и тест;
  - в `packages/desktop/src/renderer/files/`: `FilesPanel.tsx`, `Tree.tsx`,
    `RootPicker.tsx` и тесты;
  - `packages/desktop/src/renderer/files/store.ts` и тест. В 7.2 — корень и раскрытые
    папки; буферы добавит 7.3.
- Изменить:
  - `renderer/shell/AppShell.tsx`, `Titlebar.tsx` — правый сайдбар, кнопка ⌘L активна;
    `onTerminalDrop` (2.6) → путь файла в терминал;
  - `renderer/store/ui.ts` и тест — `setSidebar` принимает `tab` для правого сайдбара;
  - `renderer/keys/handler.ts`, `renderer/palette/actions.ts` — `sidebar.right.toggle`
    и `sidebar.files` доступны и выполняются;
  - `renderer/layout/dnd.ts` и тест — `DragItem` `{ kind: 'file'; root: FileRoot;
    path }`: бросок в раскладку открывает вкладку файла; `acceptsTerminal` принимает
    файл.

**Интерфейсы**

```ts
// files/store.ts; rootKey — из shared/work-keys.ts (5.2), своего нет
export interface FilesState {
  rootByWork: Record<string, FileRootSpec>;                  // выбранный корень
  expanded: Record<string /* rootKey */, Set<string>>;       // раскрытые папки
  setRoot(workKey: string, spec: FileRootSpec): void;
  toggleDir(rootKey: string, dir: string): void;
}
/** Корень по умолчанию: worktree сессии в фокусе (worktree.createdAt !== null), иначе проект. */
export function defaultRoot(entry: WorkEntry, focusedSessionId: string | null): FileRootSpec;

// store/ui.ts — setSidebar из 2.3; tab есть только у правого
setSidebar(side: 'left' | 'right', patch: { open?: boolean; width?: number; tab?: 'files' | 'changes' }): void;

// layout/dnd.ts, дополнение
export type DragItem = /* 2.6 */ | { kind: 'file'; root: FileRoot; path: string };
// acceptsTerminal(item) — true для file
```

**Поведение**
- **Правый сайдбар:**
  - ширина `ui.rightSidebar` зеркала, пределы 220 … окно − 320, тот же `Resizer`;
    пишется `setSidebar('right', { width })` на `pointerup`;
  - activity bar сверху: «Файлы» (⌘⇧E); «Изменения» появится в 8.2;
  - активная вкладка — `ui.rightSidebar.tab`, переключение —
    `setSidebar('right', { tab })`. Напрямую `app.saveUi` не зовётся (2.3).
- **`RootPicker`:** «Проект» и `⎇ S02 · harnas/w-0003/s02` у каждой сессии с
  созданным worktree.
- **Дерево** — спека 10.1:
  - ленивое раскрытие через `files.list`, виртуализация, отступ 18px;
  - папки первыми, сортировка без учёта регистра;
  - цвет имени и буква из `gitStatus` (палитра git 4.1). `gitStatus` перечитывается по
    `treeChanged` не чаще раза в 2 с (спека 10.1);
  - игнорируемые по переключателю `filesShowIgnored` (`patchUi`), приглушены;
  - `treeChanged` перечитывает раскрытые папки из события.
- **Слежение** — `files.watch(root, '')` на открытый корень. Отказ
  (`files:watch-failed`) — в шапке «Файлов» кнопка «Обновить»: она перечитывает
  раскрытые папки и `gitStatus` (спека 13).
- **Клик** открывает вкладку `file` в активной группе, ⌘-клик — в новой группе справа.
- **Контекстное меню:** Открыть · Открыть справа · Показать в Finder · Скопировать
  путь · Скопировать относительный путь.
- **Перетаскивание файла:** в строку, центр или край тела — вкладка файла; на
  поверхность терминала — зона `terminal` (2.6), она важнее тела группы: абсолютный путь
  (корень из снимка работ плюс `path`) → `pathsToInput` → `sendToAgent(…, submit:
  false)`, раскладка не меняется.
- **Корень исчез** (worktree удалён) — «Папка сессии больше не существует» и
  переключение на проект.

**Тесты**
1. `defaultRoot`: сессия с worktree → `worktree`; без — `project`; worktree с
   `createdAt: null` → `project`.
2. `Tree`: раскрытие зовёт `files.list` один раз; второе раскрытие — из кэша до
   `treeChanged`; игнорируемые скрыты по умолчанию.
3. Буква `M` и цвет изменённого файла по `gitStatus`.
4. Клик открывает вкладку `file:w:s-02:src/a.ts`, ⌘-клик делает сплит справа.
5. Перетаскивание файла на поверхность терминала → `pty.send` с экранированным
   абсолютным путём и `submit: false`, раскладка не изменилась; тот же файл в центр тела
   — вкладка файла.
6. `RightSidebar`: ⌘L открывает и закрывает; ширина уходит `setSidebar('right',
   { width })` на `pointerup`, вкладка — `setSidebar('right', { tab })`; `app.saveUi`
   получает целый `rightSidebar`.
7. Три `treeChanged` за секунду → один `gitStatus` (поддельные таймеры, 2 с).
8. `watch` корня отказал → в шапке «Обновить»; клик перечитывает раскрытые папки и
   статус.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 7.3. Monaco: вкладка файла, сохранение, изменения на диске

**Зачем.** Поправить файл рядом с агентом и не потерять его правки.
**Зависит от:** 7.2. **Спека:** 10.4, 10.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/files/editor/`:
  - `monaco-setup.ts` — локальный Monaco, воркеры, темы;
  - `MonacoEditor.tsx` и тест;
  - `FileBody.tsx` и тест;
  - `DiskChangeBanner.tsx` и тест;
  - `CompareView.tsx` — Monaco diff «диск ↔ буфер», режим `FileBody`, а не отдельная
    вкладка;
  - `buffer.ts` и тест — машина состояний буфера.
- Создать: `packages/desktop/src/renderer/files/close-guard.ts` и тест — вопрос о
  несохранённых буферах для `setCloseGuard` (2.2).
- Изменить:
  - `renderer/files/store.ts` — буферы;
  - `renderer/layout/use-tab-meta-extras.ts` — `dirtyTabIds` из `files/store.ts` (4.2);
  - `renderer/layout/bodies/` — вид `file` рисует `FileBody`;
  - `renderer/shell/ErrorBoundary.tsx` — необязательный проп `actions`: кнопки рядом с
    «Повторить»;
  - `renderer/shell/AppShell.tsx` — `setCloseGuard(createCloseGuard(…))` при
    монтировании;
  - `renderer/sidebar/CardMenu.tsx` — «Удалить…» сначала закрывает вкладки файлов
    работы через `requestCloseTabs`;
  - `renderer/terminal/LinkMenu.tsx` — «Открыть в редакторе», ⌘-клик по пути открывает
    вкладку файла на строке и колонке;
  - `packages/desktop/package.json` — `monaco-editor`, `@monaco-editor/react`;
  - `packages/desktop/electron.vite.config.ts` — воркеры Monaco через `?worker`.

**Интерфейсы**

```ts
// files/editor/monaco-setup.ts
export function setupMonaco(): typeof import('monaco-editor');   // loader.config({ monaco }), MonacoEnvironment.getWorker
export function applyEditorTheme(dark: boolean): void;            // 'harnas-dark' | 'harnas-light' из токенов

// files/editor/buffer.ts — имена состояний спеки 10.5 плюс служебные
export type BufferStatus = 'loading' | 'clean' | 'dirty' | 'saving'
  | 'disk-changed-clean' | 'disk-changed-dirty' | 'deleted' | 'error';
export interface BufferModel {
  status: BufferStatus; text: string; savedText: string;
  mtimeMs: number | null; diskMtimeMs: number | null;
  ownWriteMtimeMs: number | null;       // mtime последней своей записи: её эхо слежения пропускается
  pendingDiskMtimeMs: number | null;    // событие, пришедшее во время saving
  readOnlyReason: string | null; keepMine: boolean; error: string | null;
}
export type BufferEvent =
  | { type: 'loaded'; file: TextFile }
  | { type: 'edited'; text: string }
  | { type: 'save-started' }
  | { type: 'saved'; mtimeMs: number }
  | { type: 'disk-changed'; mtimeMs: number }
  | { type: 'disk-deleted' }
  | { type: 'reloaded'; file: TextFile }
  | { type: 'keep-mine' }
  | { type: 'failed'; message: string };
export function bufferReducer(model: BufferModel, event: BufferEvent): BufferModel;
/** Что показать: баннер, плашку «Обновлён с диска», диалог перед записью. */
export function bufferView(model: BufferModel): { banner: 'none' | 'disk-changed' | 'deleted'; confirmOverwrite: boolean };

// files/close-guard.ts
/** CloseGuard (2.2): среди закрываемых вкладки file с грязным буфером — вопрос по каждой. */
export function createCloseGuard(deps: {
  isDirty(workKey: string, tabId: string): boolean;
  ask(tabId: string): Promise<'save' | 'discard' | 'cancel'>;   // «Сохранить / Не сохранять / Отмена»
  save(workKey: string, tabId: string): Promise<boolean>;       // false — конфликт или ошибка записи
}): CloseGuard;
```

**Поведение**
- **Monaco:**
  - `setupMonaco` один раз на окно: воркеры `editor`, `json`, `css`, `html`, `ts` из
    локальной сборки, CDN не используется;
  - у TS и JS `noSemanticValidation: true`;
  - опции спеки 10.4: шрифт терминала минус 1, без миникарты,
    `renderWhitespace: 'selection'`, `wordWrap` выключен (⌥Z переключает),
    `scrollBeyondLastLine: false`;
  - тема меняется вместе с `.dark`;
  - `readOnly` при `readOnlyReason`.
- **Открытие:** `files.readText` → `loaded`; `files.watch` на файл.
  - Больше 20 МБ — тело «Файл больше 20 МБ» и «Показать в Finder».
  - Двоичный — превью, если картинка или PDF (7.5), иначе «Двоичный файл» и «Открыть
    в приложении» (`app.openPath`; ответ `'revealed'` — тост про исполняемый файл, 5.2).
  - Monaco или воркер не загрузился — граница ошибки вкладки: «Редактор не загрузился»,
    «Повторить» и «Открыть в приложении» (проп `actions`, спека 13).
- **⌘S** — команда Monaco (`editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS)`):
  - `save-started`, затем `files.write` с `mtimeMs` буфера;
  - `conflict` — диалог «Файл изменён на диске после открытия. Перезаписать изменения
    на диске?»: «Перезаписать» (запись с новым `mtime`), «Сравнить» (`FileBody` в
    режиме `CompareView`, новой вкладки нет — вида для неё в раскладке нет), «Отмена».
- **Эхо своей записи.** После ⌘S слежение присылает `changed` с новым `mtime` — это не
  правка агента:
  - `disk-changed` с `mtimeMs ≤ ownWriteMtimeMs` пропускается;
  - во время `saving` событие не применяется сразу, а откладывается до ответа `write`.
    После `saved { mtimeMs }` оно применяется, только если новее записанного: агент
    успел записать между нашим `rename` и ответом;
  - иначе после каждого сохранения появлялась бы плашка «Обновлён с диска», а при правке
    сразу после ⌘S — ложный баннер.
- **Изменение на диске** — таблица спеки 10.5:
  - `clean` → `disk-changed-clean`: тихая перезагрузка с сохранением курсора и
    прокрутки → `reloaded` → `clean`, плашка «Обновлён с диска» 2 с;
  - `dirty` → `disk-changed-dirty`: баннер «Перезагрузить», «Сравнить», «Оставить мои»
    (`keep-mine`);
  - удалён — `deleted`, баннер «Сохранить заново» или «Закрыть».
- **Закрытие** — только `requestCloseTabs` (2.2): крестик, средняя кнопка, «Закрыть
  остальные / справа», ⌘W. `createCloseGuard` спрашивает про каждую грязную вкладку
  `file` из списка:
  - «Сохранить» — `files.write`; конфликт или ошибка — закрытие отменено, дальше
    диалог конфликта;
  - «Не сохранять» — буфер отброшен;
  - «Отмена» на любой — `false`, ни одна вкладка не закрыта.
  - Без вопроса вкладки убирают `pruneLayout` (корня нет — записывать некуда) и `drop`.
    «Удалить…» работы (3.4) перед остановкой сессий зовёт `requestCloseTabs` всех её
    вкладок `file`: «Отмена» — удаления нет.
  - Закрытая вкладка отпускает буфер и `files.unwatch`.
- **Точка «не сохранён»** на вкладке — `tabMeta` берёт её из `extras.dirtyTabIds`
  (4.2), хук `useTabMetaExtras` читает `files/store.ts`.
- **«Открыть в редакторе»** в `LinkMenu` — вкладка `file` по `located.root` и
  `located.relPath` из `files.locate` (5.3); ⌘-клик — то же, курсор на строке и
  колонке.
- **⌘F, ⌘D, ⌘K, ⌘/** в Monaco достаются редактору (6.1).
- **Тесты в jsdom.** `monaco-editor` в jsdom не работает: тесты `FileBody` и
  `MonacoEditor` подменяют `@monaco-editor/react` через `vi.mock` простым `textarea` с
  тем же `onChange`, а `IntersectionObserver` — заглушкой.

**Тесты**
1. `bufferReducer`:
   - `clean` + `disk-changed` → `disk-changed-clean`, после `reloaded` — `clean` с новым
     текстом, `bufferView` без баннера;
   - `dirty` + `disk-changed` → `disk-changed-dirty`, баннер;
   - `keep-mine` → баннер снят, `confirmOverwrite: true`;
   - `saved` → `clean`, `confirmOverwrite: false`;
   - `disk-deleted` → `deleted`.
2. Эхо записи: после `saved { mtimeMs: 5 }` событие `disk-changed { 5 }` статус не
   меняет; `disk-changed` во время `saving` отложено — после `saved { 5 }` событие с 5
   пропущено, с 7 — `disk-changed-clean` или `disk-changed-dirty`.
3. `FileBody` с подставными `files.*`:
   - ⌘S зовёт `write` с `expectedMtimeMs`;
   - ответ `conflict` открывает диалог;
   - «Перезаписать» пишет с новым `mtime`;
   - «Сравнить» переводит тело в `CompareView`, число вкладок раскладки прежнее.
4. Закрытие грязной вкладки крестиком, средней кнопкой и «Закрыть остальные» идёт через
   `requestCloseTabs`: «Отмена» оставляет все вкладки, «Не сохранять» закрывает без
   `write`, «Сохранить» пишет и закрывает.
5. «Удалить…» работы с грязным файлом: «Отмена» в вопросе о буфере — ни
   `sessions.stop`, ни `works.delete`.
6. `readOnlyReason` → редактор только для чтения и плашка с причиной.
7. `LinkMenu` «Открыть в редакторе» открывает `file`-вкладку по `located` и ставит
   курсор на строку и колонку.
8. Контекст фокуса: ⌘D внутри `.monaco-editor` не делит группу.
9. Подставной Monaco бросает при загрузке → «Редактор не загрузился», «Повторить»,
   «Открыть в приложении»; опции редактора — с `renderWhitespace: 'selection'`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] В `pnpm dev:desktop` нет запросов к CDN: вкладка «Network» DevTools при
      открытии файла пуста от внешних адресов (ручная проверка).

---

## 7.4. ⌘P и поиск в файлах

**Зачем.** Любой файл сессии — за пару нажатий, любая строка — поиском.
**Зависит от:** 7.3. **Спека:** 9.1 (префикс `/`), 10.2, 10.3.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/files/SearchPanel.tsx` и тест;
  - `packages/desktop/src/renderer/files/quick-open.ts` и тест.
- Изменить:
  - `renderer/palette/score.ts` и тест — вес названия берётся из документа;
  - `renderer/palette/documents.ts` и тест — `PaletteDoc.titleWeight`, секция `files`
    в режиме `files` и по префиксу `/`;
  - `renderer/palette/store.ts` — `openWith('files')`;
  - `renderer/palette/Palette.tsx` — запрос с `/` в начале ищет файлы;
  - `renderer/keys/handler.ts`, `renderer/palette/actions.ts` — `files.quickOpen` (⌘P)
    и `files.search` (⌘⇧F) доступны и выполняются;
  - `renderer/files/FilesPanel.tsx` — режим поиска.

**Интерфейсы**

```ts
// palette/documents.ts, дополнение PaletteDoc
titleWeight?: number;   // по умолчанию 1.5 (спека 9.2); имя файла — 2 (спека 10.2)

// palette/score.ts — вес названия из документа
export function scoreDocument(tokens: string[], doc: Pick<PaletteDoc, 'title' | 'fields' | 'titleWeight'>): number | null;

// files/quick-open.ts
/** Документы палитры из lsFiles: title — имя файла (titleWeight 2), fields — [путь]; до 50 строк. */
export function fileDocuments(root: FileRoot, paths: string[], open: (path: string, split: boolean) => void): PaletteDoc[];
```

**Поведение**
- **⌘P** — палитра в режиме `files` по корню «Файлов» активной работы:
  - список `files.lsFiles`;
  - ранжирование — `scoreDocument`: имя файла — название с весом 2, путь — поле;
  - 50 строк, «Уточните запрос» при большем числе;
  - Enter открывает, ⌘Enter — справа.
- **Префикс `/`** в палитре режима `default` (спека 9.1) — та же секция «Файлы» по
  запросу без `/`.
- **⌘⇧F** — «Файлы» в режиме поиска:
  - поле, «Aa», «Слово», «.*»;
  - запрос уходит через 250 мс тишины; новый запрос отменяет прежний
    (`files.cancel`);
  - результаты по файлам, свёрнутые группы, подсветка `ranges`;
  - клик открывает файл на строке;
  - `truncated` — строка «Показаны первые 2000».

**Тесты**
1. `fileDocuments`: запрос `main` поднимает `src/main.ts` выше `docs/main-notes/x.md`;
   51 путь → 50 строк.
2. `SearchPanel`: ввод с паузой 250 мс — один `grep`; второй ввод до ответа — `cancel`
   прежнего; `truncated` показывает строку.
3. Клик по совпадению открывает вкладку файла и ставит курсор на строку.
4. `scoreDocument`: одно совпадение по названию при `titleWeight: 2` даёт больше очков,
   чем при весе по умолчанию; без `titleWeight` — вес 1.5, как в 6.2.
5. Палитра: ввод `/main` показывает секцию «Файлы» с `src/main.ts`, других секций нет.

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
  - `renderer/files/editor/FileBody.tsx` — переключатель «Код / Превью» для `.md` и
    «Таблица / Код» для CSV;
  - `renderer/index.html` — CSP спеки 15.2;
  - `packages/desktop/package.json` — `pdfjs-dist` не ниже 4.2.67;
  - `packages/desktop/electron.vite.config.ts` — воркер pdf.js локально.
- Создать: `packages/desktop/e2e/editor.spec.ts`.
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
```

**Поведение**
- **Markdown:**
  - `react-markdown` + `remark-gfm`, без сырого HTML;
  - `http(s)` — `app.openExternal` (во встроенном браузере — с 9.2);
  - относительная ссылка — вкладка файла;
  - картинки с относительным путём — `files.readBytes` → `Blob` → `URL.createObjectURL`,
    `revokeObjectURL` при размонтировании;
  - по умолчанию «Превью».
- **Картинки** `png jpg jpeg gif webp svg`: `<img>` из `Blob`, «Вписать / 100%»,
  размер в пикселях.
- **PDF** — `pdfjs-dist` с локальным воркером: прокрутка страниц, ⌘F по тексту
  страницы через `find` pdf.js.
  - Версия не ниже 4.2.67 и `getDocument({ …, isEvalSupported: false })`: закрытие
    CVE-2024-4367. CSP и так запрещает `eval`, это страховка.
- **CSV и TSV:** `parseCsv` до 10 000 строк, таблица с виртуализацией, первая строка —
  заголовок.
- **CSP** — строка спеки 15.2. Если pdf.js потребует WebAssembly для JPX, в
  `script-src` добавляется `'wasm-unsafe-eval'` с записью причины в коммите.

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
5. `PdfPreview`: подставной `getDocument` получил `isEvalSupported: false`.
6. **E2E `editor.spec.ts`:**
   - работа в `/tmp` с файлом `notes.md`;
   - «Файлы» → клик — вкладка, превью;
   - «Код», правка, ⌘S — файл на диске изменён, баннера и плашки «Обновлён с диска»
     нет.
7. **E2E:**
   - файл открыт и изменён без сохранения;
   - тест пишет в файл с диска (`fs.writeFile` из теста) → баннер «Файл изменён на
     диске»;
   - «Оставить мои» и ⌘S → диалог перезаписи.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 7** (человек, на пересобранном `harnas.app`)
- [ ] Открыть файл, который правит агент, увидеть баннер при его правке, сравнить.
- [ ] ⌘P находит файл по трём буквам имени; ⌘⇧F находит строку.
- [ ] Markdown, картинка, PDF и CSV открываются превью.
- [ ] `README.md` и `NOTICE` обновлены.
