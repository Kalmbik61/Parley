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
- `main/roots.ts` (`resolve`, `locate`), `main/files/fs-api.ts`, `shared/files-types.ts`;
- `layout/tree.ts` (`TabSpec` вида `file`), `layout/ids.ts#tabId.file`;
- `palette/store.ts` (режим `files`), `keys/focus-context.ts` (контекст `monaco`);
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
    `checkIgnored`;
  - `watch.ts` и тест: `watch`, `unwatch`, события `changed` и `treeChanged`;
  - `ipc.ts` — каналы `files:*` с проверкой аргументов.
- Изменить:
  - `src/shared/files-types.ts` — `FilesApi` целиком (спека 10.7);
  - `src/shared/bridge.ts`, `src/preload/index.ts` — группа `files`;
  - `src/main/index.ts` — регистрация `files/ipc.ts`.

**Интерфейсы** — спека 10.7 дословно, плюс внутренние:

```ts
// main/files/fs-api.ts
export const LIMITS: { editableBytes: 2 * 1024 * 1024; openableBytes: 20 * 1024 * 1024 };
export function detectText(buffer: Buffer): { binary: boolean; utf8: boolean }; // NUL в первых 8 КБ; строгое декодирование UTF-8
export async function writeAtomicPreservingMode(absPath: string, text: string): Promise<number>; // mtimeMs

// main/files/git-api.ts
export interface GitRunner { run(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: Buffer; stderr: string }> }
export function parseLsFiles(stdout: Buffer): string[];                     // -z
export function parseGitStatus(stdout: Buffer): Record<string, 'M' | 'A' | 'D' | 'U' | 'R'>;  // --porcelain=v1 -z
export function parseGrep(stdout: Buffer, query: GrepQuery, limits: { hits: 2000; files: 200 }): GrepResult; // --null -n
export function walkFiles(root: string, limit: 50_000): Promise<string[]>;  // для не-git корня, без node_modules и .git
```

**Поведение**
- **Проверка корней.** Каждый вызов сначала проходит `roots.resolve`. Отказ — ошибка
  с кодом `files:denied` и текстом «Путь вне папок работы».
- **`list`:**
  - записи папки без `.git`;
  - `ignored` — одним вызовом `git check-ignore --stdin -z` на все имена папки. Не
    git-корень — `ignored: false`;
  - симлинк — `kind: 'symlink'`, раскрывается только если цель внутри корня.
- **`readText`:**
  - `detectText` определяет `binary` и `utf8`;
  - `readOnlyReason`: больше 2 МБ — «Большой файл — правка выключена»; не UTF-8 —
    «Кодировка не UTF-8 — правка выключена»;
  - больше 20 МБ — ошибка «Файл больше 20 МБ».
- **`write`:**
  - `expectedMtimeMs` не совпал с диском — `{ ok: false, conflict }`, запись не
    делается;
  - запись — временный файл рядом, `chmod` прежних прав, `rename`;
  - новый файл — права 0644.
- **`lsFiles`:**
  - git: `git ls-files -co --exclude-standard -z`;
  - иначе `walkFiles` до 50 000;
  - кэш на корень до события `treeChanged`.
- **`grep`:**
  - git: `git grep -n -I --no-color --null`, флаги `-i`, `-w`, `-F` или `-E` по
    запросу;
  - иначе построчный поиск в main по `walkFiles`;
  - пределы 2000 совпадений и 200 файлов, `truncated`;
  - `cancel(signalId)` — `AbortController` процесса.
- **`gitShow(rev, path)`** — `git show <rev>:<path>`; файла в ревизии нет → `null`.
- **`gitStatus`** — `git status --porcelain=v1 -z`: `??` → `U`, `R` — новый путь.
- **Слежение:**
  - `watch(root, path)` — `fs.watch` на файл и на его папку, чтобы увидеть замену
    через `rename`; дроссель 100 мс, событие `changed` с `mtimeMs` или `deleted`;
  - дерево — один `fs.watch(root, { recursive: true })` на открытый корень,
    игнорирует `.git/` и `node_modules/`; пачка `treeChanged` раз в 300 мс;
  - `EMFILE` и прочие ошибки слежения — предупреждение в консоль main, событие не
    шлётся.
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
9. Любой вызов с путём `../x` → `files:denied`.

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
  - `renderer/keys/handler.ts` — `sidebar.right.toggle` и `sidebar.files` доступны;
  - `renderer/layout/dnd.ts` — `DragItem` `{ kind: 'file'; root: FileRoot; path }`:
    бросок в раскладку открывает вкладку файла, на терминал — путь через
    `sendToAgent(submit: false)`.

**Интерфейсы**

```ts
// files/store.ts
export interface FilesState {
  rootByWork: Record<string, FileRootSpec>;                  // выбранный корень
  expanded: Record<string /* rootKey */, Set<string>>;       // раскрытые папки
  setRoot(workKey: string, spec: FileRootSpec): void;
  toggleDir(rootKey: string, dir: string): void;
}
export function rootKey(root: FileRoot): string;
/** Корень по умолчанию: worktree сессии в фокусе, иначе проект. */
export function defaultRoot(entry: WorkEntry, focusedSessionId: string | null): FileRootSpec;
```

**Поведение**
- **Правый сайдбар:**
  - ширина `ui.json.rightSidebar`, пределы 220 … окно − 320, тот же `Resizer`;
  - activity bar сверху: «Файлы» (⌘⇧E); «Изменения» появится в 8.2;
  - активная вкладка — `ui.json.rightSidebar.tab`.
- **`RootPicker`:** «Проект» и `⎇ S02 · harnas/w-0003/s02` у каждой сессии с
  созданным worktree.
- **Дерево** — спека 10.1:
  - ленивое раскрытие через `files.list`, виртуализация, отступ 18px;
  - папки первыми, сортировка без учёта регистра;
  - цвет имени и буква из `gitStatus` (палитра git 4.1);
  - игнорируемые по переключателю `filesShowIgnored`, приглушены;
  - `treeChanged` перечитывает раскрытые папки из события.
- **Клик** открывает вкладку `file` в активной группе, ⌘-клик — в новой группе справа.
- **Контекстное меню:** Открыть · Открыть справа · Показать в Finder · Скопировать
  путь · Скопировать относительный путь.
- **Корень исчез** (worktree удалён) — «Папка сессии больше не существует» и
  переключение на проект.

**Тесты**
1. `defaultRoot`: сессия с worktree → `worktree`; без — `project`.
2. `Tree`: раскрытие зовёт `files.list` один раз; второе раскрытие — из кэша до
   `treeChanged`; игнорируемые скрыты по умолчанию.
3. Буква `M` и цвет изменённого файла по `gitStatus`.
4. Клик открывает вкладку `file:w:s-02:src/a.ts`, ⌘-клик делает сплит справа.
5. Перетаскивание файла на терминал → `pty.send` с экранированным путём и
   `submit: false`.
6. `RightSidebar`: ⌘L открывает и закрывает, ширина пишется в `ui.json` на
   `pointerup`.

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
  - `CompareBody.tsx` — Monaco diff «диск ↔ буфер»;
  - `buffer.ts` и тест — машина состояний буфера.
- Изменить:
  - `renderer/files/store.ts` — буферы;
  - `renderer/layout/tab-meta.ts` — `dirty` из буфера файла;
  - `renderer/layout/bodies/` — вид `file` рисует `FileBody`;
  - `renderer/layout/tree.ts` — `closeTab` принимает `guard`: вкладка с несохранённым
    буфером не закрывается без ответа;
  - `renderer/terminal/LinkMenu.tsx` — «Открыть в редакторе», ⌘-клик по пути открывает
    вкладку файла на строке и колонке;
  - `packages/desktop/package.json` — `monaco-editor`, `@monaco-editor/react`;
  - `packages/desktop/electron.vite.config.ts` — воркеры Monaco через `?worker`.

**Интерфейсы**

```ts
// files/editor/monaco-setup.ts
export function setupMonaco(): typeof import('monaco-editor');   // loader.config({ monaco }), MonacoEnvironment.getWorker
export function applyEditorTheme(dark: boolean): void;            // 'harnas-dark' | 'harnas-light' из токенов

// files/editor/buffer.ts
export type BufferStatus = 'loading' | 'clean' | 'dirty' | 'disk-changed' | 'deleted' | 'error';
export interface BufferModel {
  status: BufferStatus; text: string; savedText: string;
  mtimeMs: number | null; diskMtimeMs: number | null;
  readOnlyReason: string | null; keepMine: boolean; error: string | null;
}
export type BufferEvent =
  | { type: 'loaded'; file: TextFile }
  | { type: 'edited'; text: string }
  | { type: 'saved'; mtimeMs: number }
  | { type: 'disk-changed'; mtimeMs: number }
  | { type: 'disk-deleted' }
  | { type: 'reloaded'; file: TextFile }
  | { type: 'keep-mine' }
  | { type: 'failed'; message: string };
export function bufferReducer(model: BufferModel, event: BufferEvent): BufferModel;
/** Что показать: баннер, плашку «Обновлён с диска», диалог перед записью. */
export function bufferView(model: BufferModel): { banner: 'none' | 'disk-changed' | 'deleted'; confirmOverwrite: boolean };
```

**Поведение**
- **Monaco:**
  - `setupMonaco` один раз на окно: воркеры `editor`, `json`, `css`, `html`, `ts` из
    локальной сборки, CDN не используется;
  - у TS и JS `noSemanticValidation: true`;
  - опции спеки 10.4: шрифт терминала минус 1, без миникарты, `wordWrap` выключен
    (⌥Z переключает), `scrollBeyondLastLine: false`;
  - тема меняется вместе с `.dark`;
  - `readOnly` при `readOnlyReason`.
- **Открытие:** `files.readText` → `loaded`; `files.watch` на файл.
  - Больше 20 МБ — тело «Файл больше 20 МБ» и «Показать в Finder».
  - Двоичный — превью, если картинка или PDF (7.5), иначе «Двоичный файл» и «Открыть
    в приложении».
- **⌘S** — команда Monaco (`editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS)`):
  - `files.write` с `mtimeMs` буфера;
  - `conflict` — диалог «Файл изменён на диске после открытия. Перезаписать изменения
    на диске?»: «Перезаписать» (запись с новым `mtime`), «Сравнить» (вкладка
    `CompareBody`), «Отмена».
- **Изменение на диске** — таблица спеки 10.5:
  - `clean` — тихая перезагрузка с сохранением курсора и прокрутки, плашка «Обновлён с
    диска» 2 с;
  - `dirty` — баннер: «Перезагрузить», «Сравнить», «Оставить мои» (`keep-mine`);
  - удалён — баннер «Сохранить заново» или «Закрыть».
- **Закрытие** вкладки с `dirty` — «Сохранить», «Не сохранять», «Отмена».
- **Точка «не сохранён»** на вкладке — `tabMeta` берёт `dirty` из `files/store.ts`.
- **⌘F, ⌘D, ⌘K, ⌘/** в Monaco достаются редактору (6.1).

**Тесты**
1. `bufferReducer`:
   - `clean` + `disk-changed` → статус `clean` с новым текстом после `reloaded`,
     `bufferView` без баннера;
   - `dirty` + `disk-changed` → `disk-changed`, баннер;
   - `keep-mine` → баннер снят, `confirmOverwrite: true`;
   - `saved` → `clean`, `confirmOverwrite: false`;
   - `disk-deleted` → `deleted`.
2. `FileBody` с подставными `files.*`:
   - ⌘S зовёт `write` с `expectedMtimeMs`;
   - ответ `conflict` открывает диалог;
   - «Перезаписать» пишет с новым `mtime`.
3. Закрытие грязной вкладки: «Отмена» оставляет вкладку, «Не сохранять» закрывает,
   `write` не вызван.
4. `readOnlyReason` → редактор только для чтения и плашка с причиной.
5. `LinkMenu` «Открыть в редакторе» открывает `file`-вкладку и ставит курсор на
   строку и колонку.
6. Контекст фокуса: ⌘D внутри `.monaco-editor` не делит группу.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] В `pnpm dev:desktop` нет запросов к CDN: вкладка «Network» DevTools при
      открытии файла пуста от внешних адресов (ручная проверка).

---

## 7.4. ⌘P и поиск в файлах

**Зачем.** Любой файл сессии — за пару нажатий, любая строка — поиском.
**Зависит от:** 7.3. **Спека:** 10.2, 10.3.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/files/SearchPanel.tsx` и тест;
  - `packages/desktop/src/renderer/files/quick-open.ts` и тест.
- Изменить:
  - `renderer/palette/documents.ts` — секция `files` в режиме `files`;
  - `renderer/palette/store.ts` — `openWith('files')`;
  - `renderer/keys/handler.ts` — `files.quickOpen` (⌘P) и `files.search` (⌘⇧F)
    доступны;
  - `renderer/files/FilesPanel.tsx` — режим поиска.

**Интерфейсы**

```ts
// files/quick-open.ts
/** Документы палитры из lsFiles: имя файла весит 2, путь — 1; до 50 строк. */
export function fileDocuments(root: FileRoot, paths: string[], open: (path: string, split: boolean) => void): PaletteDoc[];
```

**Поведение**
- **⌘P** — палитра в режиме `files` по корню «Файлов» активной работы:
  - список `files.lsFiles`;
  - ранжирование — `scoreDocument` с полями `имя` (×2) и `путь`;
  - 50 строк, «Уточните запрос» при большем числе;
  - Enter открывает, ⌘Enter — справа.
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
  - `packages/desktop/package.json` — `pdfjs-dist`;
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
5. **E2E `editor.spec.ts`:**
   - работа в `/tmp` с файлом `notes.md`;
   - «Файлы» → клик — вкладка, превью;
   - «Код», правка, ⌘S — файл на диске изменён.
6. **E2E:**
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
