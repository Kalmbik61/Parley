# План, этап 8: ревью изменений

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 11, строка 8 таблицы 14.3.

**Итог этапа:**
- вкладка «Изменения» правого сайдбара: шапка `ветка → база`, секции, одна главная
  кнопка, проверка конфликтов до слияния;
- дифф на Monaco со свёрнутым неизменённым;
- заметки к строкам уходят агенту одним блоком.

**Перед стартом.** Сверить с кодом прошлых этапов:
- `core/src/work/worktree.ts` (`worktreeDiff`, `mergeWorktree`, `parseNameStatus`);
- `host/src/methods/worktrees.ts`, `host/src/worktrees/worktrees-service.ts`;
- `renderer/components/changes/*` (что заменяется);
- `renderer/terminal/send.ts` (`sendToAgent`, `sendToast`);
- `files/editor/monaco-setup.ts`, `main/files/git-api.ts` (`gitShow`),
  `shell/RightSidebar.tsx`.

---

## 8.1. core и хост: статистика диффа, коммиты, `mergeCheck`, изменения папки

**Зачем.** Окну нужны числа `+/−`, список коммитов ветки и знание о конфликтах до
слияния.
**Зависит от:** 3.1. **Спека:** 3.2, 11.5.

**Файлы**
- Изменить:
  - `packages/core/src/work/worktree.ts` и тест — расширенный `worktreeDiff`,
    `mergeCheck`, `projectChanges`, `commitProject`;
  - `packages/core/src/index.ts` — экспорт;
  - `packages/protocol/src/methods.ts` и тест — `worktrees.mergeCheck`,
    `changes.project`, `changes.commitProject`, расширенный `WorktreeDiff`;
  - `packages/host/src/methods/worktrees.ts` и тест — `worktrees.mergeCheck`;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` + три
    метода.
- Создать: `packages/host/src/methods/changes.ts` и `changes.test.ts`.

**Интерфейсы** — типы спеки 3.2 (`WorktreeDiff`, `DiffFile`, `BranchCommit`,
`ProjectChanges`) дословно, плюс:

```ts
// core/work/worktree.ts
export type MergeCheck = { status: 'clean' } | { status: 'conflicts'; files: string[] } | { status: 'unsupported' };
export async function mergeCheck(projectPath: string, info: WorktreeInfo): Promise<MergeCheck>;
/** stdout и код `git merge-tree --write-tree --name-only --no-messages`; stderr для unsupported. */
export function parseMergeTree(code: number, stdout: string, stderr: string): MergeCheck;
export function parseNumstat(raw: Buffer): Array<{ path: string; oldPath: string | null; additions: number | null; deletions: number | null }>; // -z, -M
export function parseCommits(raw: string): BranchCommit[];   // --format=%H%x00%s%x00%an%x00%aI, записи через \n
export async function projectChanges(projectPath: string): Promise<ProjectChanges>;
export async function commitProject(projectPath: string, message: string): Promise<{ commit: string }>;
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
- **`mergeCheck`** — `git merge-tree --write-tree --name-only --no-messages <base>
  <branch>` в `projectPath`:
  - код 0 → `clean`;
  - код 1 → `conflicts`: строки после первой (id дерева), без пустых, без дублей;
  - другой код и stderr с `unknown option` или `usage:` → `unsupported`;
  - иначе — ошибка;
  - рабочие копии не трогаются.
- **`changes.project`:**
  - `git diff HEAD` с numstat и неотслеживаемыми в `projectPath`;
  - `branch` — `git rev-parse --abbrev-ref HEAD`, `HEAD` → `null`;
  - для сессии с `worktree` — `bad_request` «у сессии свой worktree — смотрите
    worktrees.diff».
- **`changes.commitProject`:**
  - `git add -A` и `git commit -m <message>` в `projectPath`, как `worktrees.commit`;
  - пустое сообщение отвергает схема (1..10000);
  - нечего коммитить → `conflict` «нет изменений».

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
6. Хост: `changes.project` для сессии с worktree → `bad_request`; `commitProject` без
   изменений → `conflict`.

**Приёмка**
- [ ] Все тесты зелёные во всех пакетах.

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
  - `renderer/keys/handler.ts` — `sidebar.changes` доступно;
  - `renderer/components/sidebar/*` и меню сессии — «Изменения» открывает вкладку
    сайдбара, а не старую панель.

**Интерфейсы**

```ts
// review/state.ts
export type ChangesSource =
  | { kind: 'worktree'; diff: WorktreeDiff; check: MergeCheck | null }
  | { kind: 'project'; changes: ProjectChanges };
export type PrimaryAction =
  | { kind: 'commit-project' } | { kind: 'commit' }
  | { kind: 'merge'; base: string } | { kind: 'ask-agent'; files: string[] }
  | { kind: 'nothing' };
/** Таблица спеки 11.2. */
export function primaryActionFor(source: ChangesSource): PrimaryAction;
export function mergeResultText(result: MergeResult, base: string): { text: string; conflicts: string[] | null };
/** Текст спеки 11.2 для «Попросить агента разрешить». */
export function askAgentText(branch: string, base: string, files: string[]): string;

// review/use-changes.ts
/** Загрузка diff/mergeCheck или changes.project по сессии; обновление по правилам 11.1, не чаще раза в 2 с. */
export function useChanges(input: {
  bridge: HarnasBridge; entry: WorkEntry; sessionId: string | null;
}): { source: ChangesSource | null; loading: boolean; error: string | null; refresh(): void };
```

**Поведение**
- **Сессия в фокусе:**
  - сессия вкладки терминала или диффа активной группы;
  - иначе последняя сессия работы из истории;
  - выбор в шапке переопределяет до смены работы.
- **Шапка:**
  - `ветка → база`, чип `+a −d`, «N коммитов»;
  - «⋯»: «Обновить», «Отбросить worktree…» — `ConfirmDialog` → `worktrees.discard`;
  - без worktree — `ветка (папка проекта)` и предупреждение спеки 11.1.
- **Секции** (сворачиваются): «Конфликты», «Незакоммиченные», «Коммиты ветки».
  - Клик по файлу — вкладка `diff` сессии с фокусом на файле (8.3).
  - Клик по коммиту — вкладка `diff` с `commit`.
- **Главная кнопка** — `primaryActionFor`:
  - поле сообщения коммита (⌘Enter), пустое — кнопка неактивна;
  - в `working` подтверждение добавляет «Агент ещё работает — изменения могут быть
    неполными».
- **Слияние:**
  - подтверждение с числами (спека 11.2) → `worktrees.merge`;
  - ответ — тост `mergeResultText`; `conflict` раскрывает секцию «Конфликты».
- **«Попросить агента разрешить»:**
  - `AskAgentDialog` с редактируемым `askAgentText` и получателем — сессией worktree;
  - «Отправить» → `sendToAgent(submit: true)` и тост `sendToast`.
- **Обновление** — спека 11.1, дроссель 2 с. `mergeCheck` — после каждого `diff` с
  коммитами ветки.

**Тесты**
1. `primaryActionFor` — каждая строка таблицы 11.2, включая `unsupported` → `merge`.
2. `mergeResultText` для четырёх причин `MergeResult` — тексты спеки.
3. `askAgentText` совпадает с шаблоном спеки для двух файлов.
4. `useChanges` (поддельные таймеры): три `works.changed` за секунду → один
   `worktrees.diff`; переход из `working` → обновление.
5. `PrimaryAction`: пустое сообщение — кнопка неактивна; `working` — строка
   предупреждения в подтверждении.
6. `AskAgentDialog` зовёт `pty.send` с отредактированным текстом и
   `submit: true`; ответ `blocked` показывает тост «ждёт ответа».

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
- Изменить: `renderer/layout/bodies/` — вид `diff` рисует `DiffTab` вместо
  `ChangesPanel`.
- Удалить:
  - `renderer/components/changes/ChangesPanel.tsx`, `DiffView.tsx`, `renderer/lib/diff.ts`
    и их тесты;
  - зависимости `react-diff-view`, `gitdiff-parser`.

**Интерфейсы**

```ts
// review/diff-sides.ts
export interface DiffSides { original: string | null; modified: string | null; tooLarge: boolean; binary: boolean }
/** Стороны файла: ветка — mergeBase ↔ рабочее дерево; коммит — родитель ↔ коммит; R — oldPath. */
export async function loadSides(input: {
  files: FilesApi; root: FileRoot; file: DiffFile; mode: { kind: 'branch'; mergeBase: string } | { kind: 'commit'; hash: string };
}): Promise<DiffSides>;
export const DIFF_LIMITS: { maxEditors: 20; maxFileBytes: 1024 * 1024 };
```

**Поведение**
- **Список файлов** сверху: список или дерево, клик прокручивает к секции.
- **Секция файла:**
  - заголовок: путь, `+a −d`, «Свернуть»;
  - тело — `monaco.editor.createDiffEditor` с `hideUnchangedRegions: { enabled: true,
    contextLineCount: 3 }`, `renderSideBySide` по `ui.json.diffView`, `readOnly`.
- **Ленивость:**
  - секция монтирует редактор, когда входит в экран (`IntersectionObserver`,
    `rootMargin` 400px), с заглушкой оценочной высоты: 20px × (строк + 2), не больше
    600px;
  - живых редакторов не больше 20 — самый дальний от экрана освобождается.
- **Панель:** «Одна колонка / Две колонки» (`saveUi({ diffView })`), «Свернуть всё»,
  «Развернуть всё», «Переносить строки».
- **Режим коммита** (`commit` во вкладке) — стороны `hash^` и `hash`, заголовок
  вкладки с hash.
- **Большой или двоичный файл** — заглушка спеки 11.3, «Показать всё равно» для
  текстового.

**Тесты**
1. `loadSides`:
   - `M` — `gitShow(mergeBase)` и `readText`;
   - `A` — `original: null`;
   - `D` — `modified: null`;
   - `R` — `gitShow` по `oldPath`;
   - режим коммита — `hash^` и `hash`;
   - 2 МБ → `tooLarge`.
2. `DiffTab`: 30 файлов — смонтировано не больше 20 редакторов; прокрутка к 25-му
   монтирует его и освобождает дальний.
3. Переключатель колонок пишет `diffView` и меняет `renderSideBySide` у живых
   редакторов.
4. Поиск `react-diff-view` и `gitdiff-parser` по `packages/desktop` пуст.

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
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` —
    `app.loadNotes`, `app.saveNotes`;
  - `renderer/review/FileDiffSection.tsx` — оверлей гаттера, view zones заметок;
  - `renderer/review/DiffToolbar.tsx` — «Отправить все неотправленные».
- Документы: `README.md`, раздел «Окно» — «Изменения», главная кнопка, заметки агенту.

**Интерфейсы** — `NotesFile` и `DiffNote` спеки 11.4, плюс:

```ts
// main/notes-store.ts — ~/.harnas/desktop/notes/<sha1(workKey)>/<sessionId>.json
export function notesPath(home: string, workKey: string, sessionId: string): string;
export function createNotesStore(home?: string): {
  load(workKey: string, sessionId: string): Promise<NotesFile>;   // битый → пустой + переименование в *.corrupt-<время>.json
  save(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;
};

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
- **Хранение.** `notes-store` через 300 мс после изменения, атомарно. Загрузка при
  открытии вкладки диффа.
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
3. `notes-store`: туда-обратно; битый файл → пустой и файл `*.corrupt-*` рядом.
4. `store` заметок: после `submitted` у отправленных `sentAt`; после `blocked` —
   `sentAt: null`.
5. `GutterAdd`: протяжка со строки 10 до 14 открывает редактор с диапазоном 10–14.
6. `SendMenu`: по умолчанию сессия диффа; не запущенная сессия неактивна.
7. **E2E `review.spec.ts`** (`STUB_BRACKETED=1`, сессия в worktree):
   - тест пишет файл в worktree;
   - «Изменения» → файл в «Незакоммиченных»;
   - вкладка диффа → заметка к строке → «Отправить»;
   - stub печатает `PASTE<<Заметки к изменениям S01` и `echo:`.
8. **E2E:** коммит из «Изменений» с сообщением, затем «Слить в <база>» с подтверждением
   → в базе появился merge-коммит (`git log` из теста).
9. **E2E:** правка одной строки в базе и в ветке → секция «Конфликты» с файлом до
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
- [ ] `README.md` обновлён.
