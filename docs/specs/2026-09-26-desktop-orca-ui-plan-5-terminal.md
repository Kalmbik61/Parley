# План, этап 5: терминал и отправка агенту

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 8, 10.8, строка 5 таблицы 14.3.

**Итог этапа:**
- окно умеет отдать агенту текст «сразу, но с защитой» (`pty.send`);
- ссылки на файлы и адреса в выводе кликаются;
- поиск по терминалу — полосой;
- WebGL не упирается в лимит контекстов;
- файлы из Finder и скриншоты из буфера вставляются путём.

**Перед стартом.** Сверить с кодом прошлых этапов:
- `host/src/wake/wake-service.ts#beginAttempt` — откуда выносится общий код;
- `host/src/pty/pty-manager.ts` (`PtyHandle`), `pty/screen.ts` (доступ к headless
  xterm);
- `renderer/terminal/use-terminal.ts`, `TerminalSurface.tsx`, `terminalSurfaces`;
- `lib/capabilities.ts`.

---

## 5.1. Хост: общий «напечатать и нажать Enter», `pty.send`

**Зачем.** Одна проверенная механика печати для будильника и для окна; окно пишет
агенту, не отвечая за него на диалоги.
**Зависит от:** —. **Спека:** 3.2, 8.6.

**Файлы**
- Создать в `packages/host/src/pty/`:
  - `type-and-submit.ts` и тест;
  - `send.ts` и тест.
- Изменить:
  - `packages/host/src/wake/wake-service.ts` — `beginAttempt` через `typeAndSubmit`,
    новый метод `inFlight(ref)` в `WakeService`;
  - `packages/host/src/pty/pty-manager.ts` — у `PtyHandle` новый метод
    `bracketedPaste()`;
  - `packages/host/src/pty/screen.ts` — доступ к режимам headless-терминала;
  - `packages/host/src/methods/pty.ts` и `pty.test.ts` — метод `pty.send`;
  - `packages/host/src/methods/index.ts` — `MethodDeps.wake` уже есть, регистрация;
  - `packages/protocol/src/methods.ts` и тест — схема и результат `pty.send`;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` +
    `pty.send`.

**Интерфейсы**

```ts
// pty/type-and-submit.ts
export type AttemptOutcome = 'submitted' | 'input' | 'restarted' | 'cancelled' | 'typed';
export interface Attempt { cancel(): void; done: Promise<AttemptOutcome> }
export interface TypeAndSubmitDeps {
  pty: PtyManager;
  enterDelayMs: number;                    // 500
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}
/**
 * Печатает text печатью хоста (черновик человека не меняется). При submit через
 * enterDelayMs жмёт Enter тому же pid, если за это время не было события draft;
 * был ввод — 'input', сменился pid — 'restarted'. Без submit — 'typed' сразу.
 */
export function typeAndSubmit(deps: TypeAndSubmitDeps, ref: SessionRef, text: string, submit: boolean): Attempt;

// pty/pty-manager.ts, дополнение PtyHandle
bracketedPaste(): boolean;   // screen.modes.bracketedPasteMode

// wake/wake-service.ts, дополнение WakeService
inFlight(ref: SessionRef): boolean;

// pty/send.ts
export type SendReason = 'blocked' | 'busy' | 'no-paste-mode' | 'draft' | 'input' | 'restarted';
export interface SendResult { inserted: boolean; submitted: boolean; reason: SendReason | null }
/** Очистка спеки 8.6, шаг 2; пусто или > 64 КиБ — HostError('bad_request'). */
export function sanitizeForSend(text: string): string;
export function createSender(deps: {
  pty: PtyManager; activity: ActivityService; wake: Pick<WakeService, 'inFlight'>; enterDelayMs: number;
}): (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult>;

// protocol/methods.ts
METHODS['pty.send'] = z.object({ ref: sessionRef, text: z.string().min(1), submit: z.boolean() });
Results['pty.send'] = { inserted: boolean; submitted: boolean; reason: SendReason | null };
```

**Поведение**
- **`typeAndSubmit`** — ровно та механика, что сейчас внутри `beginAttempt`:
  - печать через `pty.write`;
  - таймер Enter;
  - `sawInput` по событию `draft`;
  - Enter тому же `pid`.
  - Предохранитель указателя (`pointerTimeoutMs`) остаётся в будильнике: это его
    логика, а не печати.
- **`createSender`** — алгоритм спеки 8.6, шаги 1–10:
  - порядок проверок: `blocked` → `busy` → `no-paste-mode`, затем вставка, затем
    `draft` → ожидание;
  - `busy` — `wake.inFlight(ref)`;
  - `blocked` — `activity.get(ref)?.activity.activity === 'blocked'`;
  - черновик берётся **до** вставки: `handle.hasDraft()`;
  - предел 64 КиБ считается в байтах UTF-8: `Buffer.byteLength`.
- **Метод `pty.send`** отвечает после ожидания Enter (около 500 мс). Сессии без PTY —
  `HostError('not_found', 'сессия не запущена')`.

**Тесты**
1. Прежние тесты `wake-service` зелёные **без правок**: поведение будильника то же.
2. `typeAndSubmit`, поддельные таймеры:
   - `submit: false` → `typed`, одна запись;
   - `submit: true` без ввода → `\r` через 500 мс, `submitted`;
   - событие `draft` в окне ожидания → `input`, `\r` нет;
   - смена `pid` → `restarted`;
   - `cancel()` до Enter → `cancelled`.
3. `sanitizeForSend`:
   - `a\r\nb` → `a\nb`;
   - `\x1b[31mred\x1b[0m` → `red`;
   - `\x07` и `\x7f` вырезаны, `\t` и `\n` остались;
   - только ESC → `bad_request`;
   - 64 КиБ + 1 байт (кириллица) → `bad_request`.
4. `createSender`:
   - `blocked` → нет ни одной записи в PTY, `{ inserted: false, reason: 'blocked' }`;
   - `busy` — то же с `busy`;
   - многострочный текст без режима вставки → `no-paste-mode`, записей нет;
   - с режимом — запись `ESC[200~…ESC[201~`;
   - `submit: false` → `inserted: true, reason: null`, без `\r`;
   - черновик до вставки → `draft`, без `\r`;
   - ввод в ожидании → `input`;
   - всё чисто → `submitted: true`, последняя запись `\r`.
5. `pty.send` через сервер хоста для сессии без PTY → `not_found`. Схема отвергает
   пустой `text`.

**Приёмка**
- [ ] Все тесты зелёные, тесты `wake-service` не менялись (`git diff` по
      `wake-service.test.ts` пуст).

---

## 5.2. Main: реестр корней, `files.stat`, открыть и показать в Finder

**Зачем.** Ссылкам терминала и перетаскиванию нужна проверка, что путь внутри папок
работы.
**Зависит от:** —. Параллельно с 5.1. **Спека:** 10.7, 10.8.

**Файлы**
- Создать:
  - `packages/desktop/src/main/roots.ts` и тест;
  - `packages/desktop/src/main/files/fs-api.ts` и тест (в 5.2 — только `stat`);
  - `packages/desktop/src/shared/files-types.ts`.
- Изменить:
  - `src/shared/bridge.ts` — `files.stat`, `app.openPath`, `app.showInFinder`;
  - `src/preload/index.ts`, `src/main/ipc.ts` — каналы `files:stat`, `app:open-path`,
    `app:show-in-finder`;
  - `src/main/index.ts` — реестр корней на `connection`.

**Интерфейсы**

```ts
// shared/files-types.ts
export interface FileRoot { workKey: string; spec: FileRootSpec }        // FileRootSpec — shared/layout-types.ts
export interface FileStat { kind: 'file' | 'dir'; size: number; mtimeMs: number }

// main/roots.ts
export interface RootsSource {
  list(): Promise<WorksSnapshot>;                                   // connection.call('works.list', {})
  onChange(listener: (snapshot: WorksSnapshot) => void): () => void; // событие works.changed
}
export class FilesDeniedError extends Error {}                     // текст «Путь вне папок работы»
export interface RootsRegistry {
  /** Абсолютный realpath внутри корня; для write — realpath родителя; иначе FilesDeniedError. */
  resolve(root: FileRoot, relPath: string, mode: 'read' | 'write'): Promise<string>;
  /** Для ссылок и Finder: какому корню принадлежит абсолютный путь. */
  locate(absPath: string): Promise<{ root: FileRoot; relPath: string } | null>;
  roots(workKey: string): Array<{ spec: FileRootSpec; absPath: string }>;
}
export function createRootsRegistry(source: RootsSource): RootsRegistry;

// bridge.ts
files: { stat(root: FileRoot, paths: string[]): Promise<Array<FileStat | null>> };   // до 200 путей
app: { openPath(absPath: string): Promise<void>; showInFinder(absPath: string): Promise<void> };
```

**Поведение**
- **Корни:**
  - `projectPath` каждой работы;
  - `worktree.path` каждой сессии с `worktree.createdAt !== null`.
  - Реестр строится из `works.list` при подключении и обновляется по
    `works.changed`.
  - Пути корней приводятся через `realpath`: на macOS `/tmp` — это `/private/tmp`,
    сравнивать надо реальные пути.
- **Проверка** — спека 10.8:
  - отказ на абсолютный `relPath`, NUL, выход за корень после нормализации, симлинк
    наружу после `realpath`, запись в `.git/` или внутрь него;
  - неизвестный корень — отказ.
- **`files.stat`** — `null` для отсутствующих путей и для путей вне корня. Отказ по
  одному пути не валит пачку.
- **`openPath`** — `shell.openPath` и **`showInFinder`** — `shell.showItemInFolder`,
  только после `locate(absPath) !== null`.

**Тесты**
1. `resolve`:
   - `../x` → отказ;
   - `/etc/passwd` → отказ;
   - `a\0b` → отказ;
   - `src/a.ts` → путь внутри корня.
2. Симлинк внутри корня на `/etc` → чтение через него — отказ.
3. `mode: 'write'` в `.git/config` — отказ; новый файл `src/new.ts` (родитель
   существует) — путь.
4. Корень в `/tmp/x`: `resolve` отдаёт путь под `/private/tmp/x`, `locate('/tmp/x/a')`
   находит корень.
5. После `works.changed` без работы её корень исчезает — `resolve` отказывает.
6. `files.stat`: существующий файл → `{ kind: 'file' }`, нет файла → `null`, путь вне
   корня → `null`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 5.3. Ссылки, меню, поиск, WebGL-политика

**Зачем.** Вывод агента кликабелен, поиск удобен, много терминалов не ломают WebGL.
**Зависит от:** 5.2. **Спека:** 8.1–8.4.

**Файлы**
- Создать в `packages/desktop/src/renderer/terminal/`:
  - `links.ts` и тест;
  - `LinkMenu.tsx`, `TerminalContextMenu.tsx` и тесты;
  - `SearchBar.tsx` и тест;
  - `webgl-policy.ts` и тест.
- Изменить:
  - `renderer/terminal/use-terminal.ts` — провайдер ссылок, WebGL через политику, ⌘F
    и ⌘K в своём обработчике клавиш;
  - `renderer/terminal/TerminalSurface.tsx` — меню, полоса поиска;
  - `packages/desktop/package.json` — удалить `@xterm/addon-web-links`: адреса
    обрабатывает `links.ts`.

**Интерфейсы**

```ts
// terminal/links.ts
export interface LinkCandidate {
  start: number; end: number;               // индексы в строке (кодовые единицы xterm)
  kind: 'path' | 'url';
  path?: string; line?: number; col?: number; url?: string;
}
/** Пути (абсолютные, ~, ./, ../, src/a.ts:12:3) и адреса http(s) — регулярки спеки 8.3. */
export function findLinkCandidates(lineText: string): LinkCandidate[];
export function resolveCandidatePath(candidate: LinkCandidate, cwd: string, home: string): string;
export interface StatCache { exists(absPaths: string[]): Promise<boolean[]> }
export function createStatCache(stat: (absPaths: string[]) => Promise<boolean[]>,
  options?: { max?: number; ttlMs?: number; now?: () => number }): StatCache;   // 500, 10 000 мс
export function sessionCwd(session: WorkSession, projectPath: string): string;  // worktree.path или projectPath

// terminal/webgl-policy.ts
export interface WebglPolicy {
  shouldHaveWebgl(key: string, visible: boolean): boolean;   // видимые и 6 последних скрытых
  onContextLoss(key: string): 'retry' | 'dom';               // 'dom' после 3 потерь за 60 с
}
export function createWebglPolicy(options?: { keepHidden?: number; maxLosses?: number; windowMs?: number; now?: () => number }): WebglPolicy;
```

**Поведение**
- **Ссылки:**
  - провайдер ищет кандидатов в видимых строках;
  - пути сверяются с `files.stat` через кэш (500 путей, 10 с); путь вне корней
    ссылкой не становится;
  - обычный клик по пути — `LinkMenu`: «Открыть в приложении по умолчанию», «Показать
    в Finder», «Скопировать путь»; «Открыть в редакторе» добавит 7.3;
  - ⌘-клик — приложение по умолчанию, до 7.3;
  - URL: клик — меню «Открыть в браузере», «Скопировать адрес»; ⌘-клик —
    `app.openExternal`, до 9.2.
- **Меню терминала** — спека 8.4: «Копировать» только при выделении.
- **Поиск ⌘F:**
  - `SearchBar` 32px справа сверху;
  - переключатели «Aa» и «.*», счётчик `N/M` (свыше 1000 — `1000+`);
  - Enter / ⇧Enter, Esc возвращает фокус в терминал;
  - цвета декораций `#f0c674` и `#ff9e3b`;
  - неверная регулярка — красная рамка поля, поиска нет;
  - исключение декораций `SearchAddon` ловится и показывается как «0/0».
- **⌘K** — `term.clear()` в терминале с фокусом, агенту ничего не уходит.
- **WebGL:**
  - `shouldHaveWebgl` решает, загружать ли `WebglAddon` при каждом изменении
    видимости;
  - `onContextLoss` → `dispose` аддона, через 1 с — повтор, либо DOM до перезагрузки
    окна;
  - `?renderer=dom` отключает WebGL совсем, как сейчас.

**Тесты**
1. `findLinkCandidates`:
   - `Error at src/app/main.ts:12:3` → путь `src/app/main.ts`, строка 12, колонка 3;
   - `см. ./docs/Отчёт.md` → путь с кириллицей;
   - `https://example.com/a?b=1` → url;
   - `version 1.2.3` → ничего;
   - `~/x/y.txt` → путь.
2. `resolveCandidatePath` относительно worktree, `~` — относительно `home`.
3. `createStatCache`: повторный запрос в течение 10 с не зовёт `stat`; через 10 с —
   зовёт; 501-й путь вытесняет самый старый.
4. `LinkMenu`: «Показать в Finder» зовёт `app.showInFinder` с абсолютным путём.
5. `SearchBar`: неверная регулярка `(` — рамка ошибки, `findNext` не вызван; Enter —
   `findNext`, ⇧Enter — `findPrevious`; Esc закрывает.
6. `createWebglPolicy`:
   - восемь скрытых — у шести последних `true`, у двух старых `false`;
   - три потери за 60 с → `dom`;
   - потери с разницей больше 60 с → `retry`.
7. ⌘K в терминале зовёт `clear` и не шлёт `pty.input`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] ⌘-клик по `src/a.ts:12` в выводе stub-агента открывает файл в приложении
      (ручная проверка).

---

## 5.4. Вставка скриншота, перетаскивание, отправка из окна; приёмка этапа 5

**Зачем.** Файлы и картинки попадают в промпт агента, а окно честно говорит, что
отправлено.
**Зависит от:** 5.1, 5.3. **Спека:** 8.5, 8.6 (таблица тостов).

**Файлы**
- Создать:
  - `packages/desktop/src/main/drops.ts` и тест;
  - `packages/desktop/src/renderer/terminal/drop.ts` и тест;
  - `packages/desktop/src/renderer/terminal/send.ts` и тест;
  - `packages/desktop/e2e/terminal-send.spec.ts`.
- Изменить:
  - `src/preload/index.ts` — `app.pathForFile` через `webUtils.getPathForFile`;
  - `src/shared/bridge.ts`, `src/main/ipc.ts` — `app.saveDropImage('clipboard')`,
    канал `app:save-drop-image`;
  - `src/main/index.ts` — очистка `drops/` при старте;
  - `renderer/terminal/use-terminal.ts` — ⌘V с картинкой;
  - `renderer/terminal/TerminalSurface.tsx` — приём файлов (HTML5 `drop` с
    `dataTransfer.files`), рамка при наведении;
  - `packages/desktop/e2e/stub-echo-agent.mjs` — режим `STUB_BRACKETED=1`.

**Интерфейсы**

```ts
// main/drops.ts
export function dropsDir(home?: string): string;                  // ~/.harnas/desktop/drops
/** PNG из картинки буфера: имя YYYYMMDD-HHMMSS-<4 hex>.png, права 0600; пустая картинка → null. */
export async function saveImage(input: { png: Buffer | null; dir: string; now?: Date; random?: () => number }): Promise<string | null>;
export async function cleanupDrops(dir: string, maxAgeMs: number, now?: number): Promise<number>; // 7 суток

// renderer/terminal/drop.ts
export function shellQuote(path: string): string;       // 'a b' → 'a b' в кавычках; ' внутри → '\''
export function pathsToInput(paths: string[]): string;  // через пробел, пробел в конце

// renderer/terminal/send.ts
export type SendOutcome = SendResult | { error: 'not_found' | 'failed'; message: string };
export async function sendToAgent(bridge: HarnasBridge, ref: SessionRef, text: string, submit: boolean): Promise<SendOutcome>;
export interface SendToast { text: string; actions: Array<'copy' | 'open' | 'retry' | 'resume'>; error: boolean }
export function sendToast(outcome: SendOutcome, label: string): SendToast;   // таблица спеки 8.6
```

**Поведение**
- **⌘V в терминале:**
  - сначала `app.saveDropImage('clipboard')`. Путь есть — `sendToAgent(…, path,
    submit: false)`, обычной вставки нет;
  - `null` — обычная вставка текста через `term.paste` (bracketed paste — забота
    xterm);
  - в буфере и картинка, и текст — main отдаёт `null`: вставляется текст.
- **Файлы из Finder:**
  - `drop` на поверхность терминала → `app.pathForFile(file)` для каждого;
  - `pathsToInput` → `sendToAgent(…, submit: false)`: **без Enter**;
  - пустой путь (синтетический `File`) пропускается.
- **Тосты** — `sendToast` по таблице спеки 8.6, через `sonner`:
  - кнопка «Скопировать» кладёт исходный текст в буфер;
  - «Открыть S02» — вкладка сессии;
  - «Повторить» — тот же вызов;
  - «Возобновить» — `sessions.resume`.
- **Stub-агент с `STUB_BRACKETED=1`:**
  - при старте печатает `ESC[?2004h`;
  - текст между `ESC[200~` и `ESC[201~` печатает как `PASTE<<текст>>` и держит в
    буфере строки;
  - Enter — `echo: <буфер>`, как сейчас.

**Тесты**
1. `saveImage`: PNG записан с правами 0600 и именем по шаблону; `png: null` → `null`
   без файла.
2. `cleanupDrops`: файл старше 7 суток удалён, свежий на месте, вернулось 1.
3. `shellQuote("a b")` → `'a b'`; `shellQuote("it's")` → `'it'\''s'`; `pathsToInput`
   двух путей → `'…' '…' ` с пробелом в конце.
4. `sendToast` для каждой строки таблицы 8.6: текст и набор кнопок.
5. Компонентный тест поверхности: `drop` двух файлов с подставным `pathForFile` →
   один `pty.send` с `submit: false` и экранированными путями.
6. ⌘V при картинке в буфере (подставной `saveDropImage` отдаёт путь) → `pty.send` с
   путём, `term.paste` не вызван; при `null` — вызван `term.paste`.
7. **E2E `terminal-send.spec.ts`** (`STUB_BRACKETED=1`):
   - `pty.send { text: 'многострочный\nтекст', submit: true }` через
     `window.harnas.call` → в терминале `PASTE<<многострочный`, затем `echo:`;
     результат `submitted: true`;
   - в терминале набрано `abc` без Enter → `pty.send … submit: true` →
     `reason: 'draft'`, новой строки `echo:` нет.

Перетаскивание из Finder в E2E не воспроизводится: у синтетического `File` нет пути
на диске. Его закрывают тест 5 и живая приёмка.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 5** (человек, на пересобранном `harnas.app`)
- [ ] Файл из Finder, брошенный на сессию Claude, — путь в поле ввода, Enter не нажат.
- [ ] Скриншот (⌘⇧⌃4) и ⌘V в сессии — путь к PNG, Claude видит картинку.
- [ ] `pty.send`, пока агент ждёт разрешения, ничего не вставляет — тост «ждёт ответа».
- [ ] ⌘-клик по `src/a.ts:12` открывает файл; ⌘F ищет по скроллбэку.
- [ ] `README.md`, раздел «Окно» — ссылки, поиск, перетаскивание, скриншоты.
