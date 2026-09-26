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
- `host/src/pty/pty-manager.ts` (`PtyHandle`), `pty/draft.ts` (`DraftTracker`,
  `stripEscapes`), `pty/screen.ts` (доступ к headless xterm);
- `renderer/terminal/use-terminal.ts`, `TerminalSurface.tsx`, `terminalSurfaces`;
- `lib/capabilities.ts`, `lib/tree-order.ts#workKey`, `test-utils/fake-bridge.ts`.

---

## 5.1. Хост: общий «напечатать и нажать Enter», `pty.send`, черновик хоста

**Зачем.** Одна проверенная механика печати для будильника и для окна; окно пишет
агенту, не отвечая за него на диалоги. Текст, который окно оставило в поле ввода без
Enter, будильник видит как черновик и поверх него не печатает.
**Зависит от:** —. **Спека:** 3.2, 8.6.

**Файлы**
- Создать:
  - в `packages/host/src/pty/`: `type-and-submit.ts` и тест, `send.ts` и тест;
  - `packages/host/src/wake/host-draft.test.ts` — будильник поверх черновика хоста:
    настоящий `PtyManager`, stub-агент, заготовка по образцу `rig` из
    `wake-service.test.ts`. Сам `wake-service.test.ts` не меняется.
- Изменить:
  - `packages/host/src/wake/wake-service.ts` — `beginAttempt` через `typeAndSubmit`; в
    `WakeService` — `inFlight(ref)` и `enterDelayMs`;
  - `packages/host/src/pty/draft.ts` и `draft.test.ts` — `stripEscapes` экспортируется,
    черновик хоста в `DraftTracker`;
  - `packages/host/src/pty/pty-manager.ts` и `pty-manager.test.ts` —
    `PtyHandle.bracketedPaste()`, `PtyManager.setHostDraft`, `hasDraft()` с черновиком
    хоста;
  - `packages/host/src/pty/screen.ts` — доступ к режимам headless-терминала;
  - `packages/host/src/methods/pty.ts` и `pty.test.ts` — метод `pty.send`,
    `PtyMethodDeps.wake`; подставной `PtyManager` теста получает `setHostDraft`;
  - `packages/host/src/methods/index.ts` — регистрация (`MethodDeps.wake` уже есть);
  - `packages/protocol/src/types.ts` и `index.ts` — `SendReason` и `SendResult`;
  - `packages/protocol/src/methods.ts` и тест — схема и результат `pty.send`;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` +
    `pty.send`.

**Интерфейсы**

```ts
// protocol/src/types.ts — общие для хоста и окна: протокол хост не импортирует,
// а tsconfig.web.json окна видит только protocol и core
export type SendReason = 'blocked' | 'busy' | 'no-paste-mode' | 'draft' | 'input' | 'restarted';
export interface SendResult { inserted: boolean; submitted: boolean; reason: SendReason | null }

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
 * hostDraft (pty.send): печать ставит черновик хоста, свой Enter его снимает.
 * Будильник зовёт без него — его поведение прежнее.
 */
export function typeAndSubmit(deps: TypeAndSubmitDeps, ref: SessionRef, text: string, submit: boolean,
  options?: { hostDraft?: boolean }): Attempt;

// pty/draft.ts
/** Правила вырезания ESC-последовательностей; ими же чистит текст pty.send (спека 8.6, шаг 2). */
export function stripEscapes(data: string): string;
// DraftTracker, дополнение; hasDraft — по-прежнему только черновик человека
markHost(): void;             // вставка хоста без Enter осталась в поле ввода
clearHost(): void;            // Enter самого pty.send
get hasHostDraft(): boolean;  // input() снимает его на Enter, ⌃C и ⌃U человека

// pty/pty-manager.ts, PtyHandle — дополнение и уточнение
bracketedPaste(): boolean;    // screen.modes.bracketedPasteMode
hasDraft(): boolean;          // черновик человека ИЛИ черновик хоста
// PtyManager, дополнение
/** Черновик хоста: текст, вставленный печатью хоста без Enter. Событие draft не шлёт. */
setHostDraft(ref: SessionRef, value: boolean): void;

// wake/wake-service.ts, дополнение WakeService
/** Текст указателя напечатан, а Enter ещё не ушёл (таймер Enter взведён). */
inFlight(ref: SessionRef): boolean;
/** Пауза перед Enter из WakeServiceOptions — одна на будильник и pty.send. */
readonly enterDelayMs: number;

// pty/send.ts
/** Очистка спеки 8.6, шаг 2; пусто или > 64 КиБ — HostError('bad_request'). */
export function sanitizeForSend(text: string): string;
export function createSender(deps: {
  pty: PtyManager; activity: ActivityService; wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;
}): (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult>;

// methods/pty.ts
export interface PtyMethodDeps {
  pty: PtyManager;
  activity: ActivityService;
  wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;
}

// protocol/methods.ts
METHODS['pty.send'] = z.object({ ref: sessionRef, text: z.string().min(1), submit: z.boolean() });
Results['pty.send'] = SendResult;
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
  - черновик берётся **до** вставки: `handle.hasDraft()` — черновик человека или хоста,
    оставшийся от прошлой вставки без Enter;
  - предел 64 КиБ считается в байтах UTF-8: `Buffer.byteLength`;
  - текст чистит `stripEscapes` из `draft.ts` — правила те же, что у черновика;
  - пауза Enter — `wake.enterDelayMs`: у будильника и `pty.send` она одна.
- **Черновик хоста** (рамка 15.1, п. 5; спека 8.6):
  - зачем: текст, вставленный `pty.send` без Enter (путь файла, скриншот, исходы
    `draft` и `input`), остаётся в поле ввода агента, а `DraftTracker` о нём не знает.
    Будильник видел бы `hasDraft: false`, допечатал бы указатель после пути и через
    500 мс нажал бы Enter — промпт человека ушёл бы без его ведома;
  - ставит его `pty.send` (`typeAndSubmit` с `hostDraft`): на время ожидания своего
    Enter и после любой вставки без Enter;
  - снимают его Enter самого `pty.send`, а также Enter, ⌃C и ⌃U человека; у нового
    процесса сессии (`restarted`) его нет;
  - `hasDraft()` учитывает его: будильник (`recompute`) не печатает указатель, пока
    черновик хоста стоит, и во время ожидания Enter `pty.send` тоже;
  - событие `draft` по-прежнему шлёт только ввод человека: смена его черновика или
    снятие черновика хоста его Enter, ⌃C, ⌃U. Печать хоста и `setHostDraft` событий не
    шлют, иначе ожидание Enter приняло бы собственную вставку за ввод человека;
  - свой указатель без Enter (отмена вводом, предохранитель) будильник черновиком хоста
    не помечает: его правила не меняются (тест 1).
- **`inFlight`** — «текст указателя напечатан, Enter ещё не ушёл». Внутренний флаг
  попытки будильника держится дольше, до хода агента или предохранителя 10 с, но наружу
  не выходит: `busy` длится не дольше паузы Enter.
- **Метод `pty.send`** отвечает после ожидания Enter (около 500 мс). Сессии без PTY —
  `HostError('not_found', 'сессия не запущена')`.

**Тесты**
1. Прежние тесты `wake-service` зелёные **без правок**: поведение будильника то же.
2. `typeAndSubmit`, поддельные таймеры:
   - `submit: false` → `typed`, одна запись;
   - `submit: true` без ввода → `\r` через 500 мс, `submitted`;
   - событие `draft` в окне ожидания → `input`, `\r` нет;
   - смена `pid` → `restarted`;
   - `cancel()` до Enter → `cancelled`;
   - с `hostDraft`: после печати `setHostDraft(ref, true)`, после своего Enter —
     `setHostDraft(ref, false)`, при `input` черновик хоста остаётся; без опции
     `setHostDraft` не зовётся.
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
   - всё чисто → `submitted: true`, последняя запись `\r`;
   - после вставки `submit: false` следующая `submit: true` → `draft` без `\r`: черновик
     хоста от первой.
5. `pty.send` через сервер хоста для сессии без PTY → `not_found`. Схема отвергает
   пустой `text`.
6. `PtyManager` и `DraftTracker`:
   - `setHostDraft(ref, true)` → `hasDraft()` истинно, события `draft` нет;
   - ввод человека `x` черновик хоста не снимает;
   - `\r`, `\x03` и `\x15` человека снимают его и шлют `draft`;
   - `stripEscapes` экспортирован и вырезает `ESC[31m`.
7. `wake.inFlight`: истинно между печатью указателя и его Enter; сразу после Enter —
   ложно, хотя ход ещё не начался. `wake.enterDelayMs` — из опций будильника.
8. `host-draft.test.ts`, настоящий `PtyManager` и stub-агент:
   - `pty.send { text: "'/tmp/a b.png' ", submit: false }`, затем письмо сессии → за
     600 мс ни указателя, ни `echo:`;
   - человек жмёт Enter (`pty.input(ref, '\r')`) → `echo:` с путём, затем указатель
     уходит отдельным ходом;
   - `pty.send { submit: true }`, письмо пришло в окне ожидания его Enter → поверх
     указатель не напечатан, строка `echo:` содержит только текст `pty.send`.

**Приёмка**
- [ ] Все тесты зелёные — сверка с базовым прогоном (индекс, «Правила проверки»); тесты
      `wake-service` не менялись (`git diff` по `wake-service.test.ts` пуст).

---

## 5.2. Main: реестр корней, `files.stat` и `files.locate`, открыть и показать в Finder, коды ошибок IPC

**Зачем.** Ссылкам терминала и перетаскиванию нужна проверка, что путь внутри папок
работы. «Открыть в приложении» не должно запускать то, что агент положил в worktree.
**Зависит от:** —. Параллельно с 5.1. **Спека:** 10.7, 10.8.

**Файлы**
- Создать:
  - `packages/desktop/src/main/roots.ts` и тест;
  - `packages/desktop/src/main/files/fs-api.ts` и тест (в 5.2 — только `stat` и
    `locate`);
  - `packages/desktop/src/main/files/open-path.ts` и тест — открыть или только показать
    в Finder;
  - `packages/desktop/src/main/files/ipc.ts` и тест — каналы `files:stat`,
    `files:locate`. Все будущие каналы `files:*` регистрирует этот модуль;
  - `packages/desktop/src/shared/files-types.ts`;
  - `packages/desktop/src/shared/work-keys.ts` и тест — `workKey` и `rootKey`;
  - `packages/desktop/src/shared/ipc-error.ts` и тест — код ошибки через IPC.
- Изменить:
  - `src/shared/bridge.ts`, `src/preload/index.ts` — `files.stat`, `files.locate`,
    `app.openPath`, `app.showInFinder`;
  - `src/main/ipc.ts` и `ipc.test.ts` — каналы `app:open-path`, `app:show-in-finder`;
    отказы всех `ipcMain.handle` через `encodeIpcError`;
  - `src/main/index.ts` — реестр корней на `connection`, регистрация `files/ipc.ts`;
  - `renderer/lib/tree-order.ts` — `workKey` реэкспортируется из `shared/work-keys.ts`,
    прежние импорты не меняются;
  - `renderer/test-utils/fake-bridge.ts` — `files.stat` и `files.locate` (по умолчанию
    `null` на каждый путь, сеттер ответов), `app.openPath` (`'opened'`),
    `app.showInFinder`, журналы `openedPaths` и `revealedPaths`.

**Интерфейсы**

```ts
// shared/files-types.ts
export interface FileRoot { workKey: string; spec: FileRootSpec }        // FileRootSpec — shared/layout-types.ts
export interface FileStat { kind: 'file' | 'dir'; size: number; mtimeMs: number }
/** Абсолютный путь, найденный в корне работы. */
export interface Located { root: FileRoot; relPath: string; stat: FileStat }

// shared/work-keys.ts — один формат ключей для main и рендерера
export function workKey(projectPath: string, workId: string): string;   // `${projectPath} ${workId}`, формат прежний
/** Ключ корня (спека 10.8): workKey, вид и sessionId. */
export function rootKey(root: FileRoot): string;                        // `${workKey} project` | `${workKey} worktree s-02`

// shared/ipc-error.ts
export interface IpcErrorInfo { code: string; message: string }
/** Main: Error, чей message несёт код — ipcMain.handle отдаёт рендереру только message. */
export function encodeIpcError(info: IpcErrorInfo): Error;               // message = 'harnas-error:' + JSON
/** Рендерер: поле code (подставной мост) → метка в тексте (с префиксом Electron) → { code: 'failed', message }. */
export function decodeIpcError(error: unknown): IpcErrorInfo;

// main/roots.ts
export interface RootsSource {
  list(): Promise<WorksSnapshot>;                                   // connection.call('works.list', {})
  onChange(listener: (snapshot: WorksSnapshot) => void): () => void; // событие works.changed
}
export class FilesDeniedError extends Error {}                     // код files:denied, текст «Путь вне папок работы»
export interface RootsRegistry {
  /** realpath цели внутри realpath корня; для записи — правила ниже; иначе FilesDeniedError. */
  resolve(root: FileRoot, relPath: string, mode: 'read' | 'write'): Promise<string>;
  /** Какому корню принадлежит абсолютный путь: realpath, самый длинный корень всех работ. */
  locate(absPath: string): Promise<{ root: FileRoot; relPath: string } | null>;
  roots(workKey: string): Array<{ spec: FileRootSpec; absPath: string }>;   // absPath — realpath
}
export function createRootsRegistry(source: RootsSource): RootsRegistry;

// main/files/open-path.ts
export const EXECUTABLE_EXTENSIONS: readonly string[];   // .app .command .tool .terminal .workflow .action .pkg .mpkg .jar .scpt .sh .fileloc .webloc .inetloc
/** Имя и права и самого пути, и его realpath. */
export function openVerdict(paths: Array<{ name: string; isDirectory: boolean; mode: number }>): 'open' | 'reveal';

// bridge.ts
files: {
  stat(root: FileRoot, paths: string[]): Promise<Array<FileStat | null>>;   // до 200 путей
  locate(absPaths: string[]): Promise<Array<Located | null>>;             // до 200 путей; `~` раскрывает main
};
app: {
  /** Только внутри корней; исполняемое и бандлы не открываются, а показываются в Finder. */
  openPath(absPath: string): Promise<'opened' | 'revealed'>;
  showInFinder(absPath: string): Promise<void>;
};
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
  - отказ на абсолютный `relPath`, NUL, выход за корень после нормализации; неизвестный
    корень — отказ;
  - **чтение:** `realpath` цели обязан лежать внутри `realpath` корня — симлинк наружу
    отказывает;
  - **запись** — `lstat` последнего звена:
    - симлинк — его `realpath` внутри корня, иначе отказ; висячий симлинк — отказ.
      Иначе `realpath` цели упал бы с `ENOENT`, проверка ушла бы к родителю внутри
      корня, и новый файл создался бы по ссылке снаружи (`root/a.ts → ~/.ssh/…`);
    - обычный файл — его `realpath` внутри корня: так ловится симлинк в родителе;
    - файла нет — `realpath` родителя внутри корня, путь — он плюс имя;
  - **`.git`:** запись отказывает, если среди звеньев `relative(realpath(корня),
    realpath(цели))` есть `.git` в любом регистре. Так ловятся `.GIT/config` на APFS без
    учёта регистра, ссылка `foo → .git` и файл `.git` в корне worktree;
  - `resolve` отдаёт `realpath`: запись идёт по нему, а не по исходному имени.
- **`locate`:**
  - `~` и `~/…` раскрывает main (`os.homedir()`): у рендерера в песочнице дома нет;
  - после раскрытия путь абсолютный, иначе `null`; нет файла — `null`;
  - корень — самый длинный `realpath` корня всех работ, внутри которого `realpath`
    пути; `relPath` — от него. Так `/private/tmp/…` из вывода агента находит корень
    `/tmp/…`, а путь в папке проекта при сессии в worktree — корень проекта.
- **`files.locate`** — `locate` и `stat` на каждый путь. **`files.stat`** — `null` для
  отсутствующих путей и для путей вне корня. Отказ по одному пути пачку не валит; больше
  200 путей — отказ всего вызова.
- **`openPath`** — только после `locate(absPath) !== null`, иначе `files:denied`. Затем
  `openVerdict` по имени и правам пути и его `realpath`:
  - `reveal` — каталог с расширением (бандл: `.app`, `.workflow`, `.action`…), файл с
    расширением из `EXECUTABLE_EXTENSIONS` или с любым битом x (`mode & 0o111`). Ссылка
    `a.txt → b.command` — тоже `reveal`;
  - `reveal` → `shell.showItemInFolder`, ответ `'revealed'`; окно покажет тост
    «Исполняемый файл не открывается — показан в Finder» (5.3);
  - иначе `shell.openPath`, ответ `'opened'`; непустой ответ `shell.openPath` — ошибка.
  - Почему: `shell.openPath` на macOS — двойной клик Finder. `.command` выполняется в
    Terminal, `.app` запускается, а у файлов, созданных агентом, нет карантина, и
    Gatekeeper не спросит. Путь в выводе агента и ⌘-клик не должны запускать код в
    обход разрешений агента.
- **`showInFinder`** — `shell.showItemInFolder` после `locate(absPath) !== null`.
- **Коды ошибок через IPC** (сквозное правило индекса):
  - все `ipcMain.handle` бросают `encodeIpcError`: `HostError` хоста — со своим `code`
    (`not_found`, `bad_request`, `conflict`…), `FilesDeniedError` — `files:denied`,
    прочее — `failed`;
  - рендерер читает код и текст через `decodeIpcError(err)`: `not_found` отличает 5.4,
    `files:denied` — тосты 5.3 и 7.x;
  - прелоад отказ не переделывает: `contextBridge` копирует у `Error` только текст и
    стек, свои поля теряются (документация Electron, contextBridge). Поэтому код едет в
    тексте.
- **Ключи.** `workKey` и `rootKey` — из `shared/work-keys.ts`: main строит ими реестр,
  рендерер — `files/store.ts` (7.2), события `onTreeChanged` несут тот же `rootKey`
  (7.1). Разойдись форматы — все `files.*` получали бы отказ.

**Тесты**
1. `resolve`:
   - `../x` → отказ;
   - `/etc/passwd` → отказ;
   - `a\0b` → отказ;
   - `src/a.ts` → путь внутри корня.
2. Симлинк внутри корня на `/etc` → чтение через него — отказ.
3. `mode: 'write'`:
   - `.git/config`, `.GIT/config`, `foo/config` при ссылке `foo → .git` и `.git` при
     файле `.git` в корне worktree — отказ;
   - новый файл `src/new.ts` (родитель существует) — путь.
4. Корень в `/tmp/x`: `resolve` отдаёт путь под `/private/tmp/x`, `locate('/tmp/x/a')`
   находит корень.
5. После `works.changed` без работы её корень исчезает — `resolve` отказывает.
6. `files.stat`: существующий файл → `{ kind: 'file' }`, нет файла → `null`, путь вне
   корня → `null`.
7. `mode: 'write'` и симлинки:
   - висячая ссылка `a.ts → <вне корня>/new.ts` → отказ, вне корня файла нет;
   - ссылка внутри корня `link.ts → real.ts` → путь `real.ts`;
   - ссылка на существующий файл вне корня → отказ.
8. `locate`:
   - `~/x` раскрыт по подставному дому;
   - `/private/tmp/x/a` при корне `/tmp/x` → корень найден, `relPath` `a`;
   - путь внутри worktree, лежащего внутри папки проекта, → корень worktree;
   - путь вне корней и несуществующий → `null`;
   - `files:locate` с 201 путём → отказ.
9. `openVerdict`:
   - `x.command` и `x.SH` → `reveal`;
   - каталог `Foo.app` → `reveal`, каталог `docs` → `open`;
   - `a.txt` 0644 → `open`, `run` 0755 → `reveal`;
   - `a.txt`, чей `realpath` — `b.command`, → `reveal`.
10. `app:open-path`: `.command` в корне → `showItemInFolder`, `shell.openPath` не
    вызван, ответ `'revealed'`; путь вне корней → отказ, `decodeIpcError` даёт
    `files:denied`.
11. `ipc-error` и `host:call`:
    - `decodeIpcError(encodeIpcError(x))` = `x`;
    - текст с префиксом Electron «Error invoking remote method 'host:call': Error: …»
      → тот же код;
    - `Object.assign(new Error('m'), { code: 'not_found' })` → `not_found`; чужая
      ошибка → `failed`;
    - `host:call`, подставное соединение бросает `HostError('not_found')` → отказ,
      `decodeIpcError` даёт `not_found`.
12. `work-keys`: `workKey` прежнего формата; `rootKey` проекта и worktree разные;
    `lib/tree-order.ts#workKey` — та же функция.

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
  - `renderer/terminal/TerminalSurface.tsx` — меню, полоса поиска, у ручки
    `openSearch()` и `clear()`;
  - `src/main/menu.ts` и новый тест — шаблон выносится в `menuTemplate(send)` (его
    заменит `buildMenuTemplate` 6.1), у пунктов «Палитра команд» ⌘K и «Найти» ⌘F
    `registerAccelerator: false`;
  - `renderer/shell/AppShell.tsx` — ⌘K вне терминала открывает палитру (до 6.1);
  - `packages/desktop/package.json` — удалить `@xterm/addon-web-links`: адреса
    обрабатывает `links.ts`.

**Интерфейсы**

```ts
// terminal/links.ts
export interface LinkCandidate {
  start: number; end: number;               // ячейки логической строки буфера xterm
  kind: 'path' | 'url';
  path?: string; line?: number; col?: number; url?: string;
}
/**
 * Пути (абсолютные, ~, ./, ../, src/a.ts:12:3) и адреса http(s) в логической строке —
 * исправленные регулярки спеки 8.3. URL важнее пути, совпадения не пересекаются.
 */
export function findLinkCandidates(lineText: string): LinkCandidate[];
/** Абсолютный путь кандидата; `~` остаётся как есть — его раскрывает main (files.locate). */
export function resolveCandidatePath(candidate: LinkCandidate, cwd: string): string;
/** Кэш поверх files.locate: 500 путей, 10 с жизни. */
export interface StatCache { lookup(absPaths: string[]): Promise<Array<Located | null>> }
export function createStatCache(locate: (absPaths: string[]) => Promise<Array<Located | null>>,
  options?: { max?: number; ttlMs?: number; now?: () => number }): StatCache;   // 500, 10 000 мс
/** worktree.path, если worktree.createdAt !== null; иначе projectPath. */
export function sessionCwd(session: WorkSession, projectPath: string): string;

// terminal/TerminalSurface.tsx, дополнение TerminalSurfaceHandle (2.5)
openSearch(): void;   // полоса поиска с фокусом в поле
clear(): void;        // term.clear(): агенту ничего не уходит

// terminal/webgl-policy.ts
export interface WebglPolicy {
  shouldHaveWebgl(key: string, visible: boolean): boolean;   // видимые и 6 последних скрытых
  onContextLoss(key: string): 'retry' | 'dom';               // 'dom' после 3 потерь за 60 с
}
export function createWebglPolicy(options?: { keepHidden?: number; maxLosses?: number; windowMs?: number; now?: () => number }): WebglPolicy;
```

**Поведение**
- **Регулярки** — исправление спеки 8.3, флаг `u`:
  - путь: `(?:~|\.{1,2})?(?:/[\p{L}\p{N}_.@+-]+)+(?::\d+(?::\d+)?)?`;
  - относительный с расширением: `[\p{L}\p{N}_.@+-]+(?:/[\p{L}\p{N}_.@+-]+)*\.`,
    затем расширение `[\p{L}\p{N}]{1,8}`, в котором обязательна буква, и
    `(?::\d+(?::\d+)?)?`. Так `version 1.2.3` не ссылка;
  - слева от пути — не символ пути: `src/app/main.ts:12:3` не совпадает ещё и как
    `/app/main.ts:12:3`;
  - URL `https?://…` ищется первым; путь внутри найденного URL не ищется. Совпадения не
    пересекаются;
  - хвостовые `.,;:!?)` в путь не входят: `./docs/Отчёт.md.` → `./docs/Отчёт.md`.
- **Ссылки:**
  - провайдер ищет кандидатов в видимых строках. Перенесённая строка (`isWrapped`)
    склеивается с предыдущей: ссылка может занимать две строки буфера;
  - `start` и `end` — в ячейках, а не в кодовых единицах: широкие символы (эмодзи, CJK)
    занимают две ячейки, индекс строки переводится через `getCell(x).getWidth()`;
  - кандидат → `resolveCandidatePath(…, sessionCwd(…))` → `StatCache.lookup` (500
    путей, 10 с) → ссылка, только если путь найден и его `root.workKey` — работа этого
    терминала. Путь вне корней работы ссылкой не становится;
  - обычный клик по пути — `LinkMenu`: «Открыть в приложении по умолчанию», «Показать
    в Finder», «Скопировать путь»; «Открыть в редакторе» добавит 7.3 — по `located.root`
    и `relPath`;
  - ⌘-клик — приложение по умолчанию, до 7.3;
  - `app.openPath` ответил `'revealed'` — тост «Исполняемый файл не открывается —
    показан в Finder»; отказ — тост с текстом `decodeIpcError(err).message` («Путь вне
    папок работы»);
  - URL: клик — меню «Открыть в системном браузере», «Скопировать адрес»; ⌘-клик —
    `app.openExternal`, до 9.2.
- **Меню терминала** — спека 8.4: «Копировать» только при выделении, «Очистить экран» —
  `clear()`, «Найти» — `openSearch()`.
- **Поиск ⌘F:**
  - `SearchBar` 32px справа сверху;
  - переключатели «Aa» и «.*», счётчик `N/M` (свыше 1000 — `1000+`);
  - Enter / ⇧Enter, Esc возвращает фокус в терминал;
  - цвета декораций `#f0c674` и `#ff9e3b`;
  - неверная регулярка — красная рамка поля, поиска нет;
  - исключение декораций `SearchAddon` ловится и показывается как «0/0».
- **⌘K** — `term.clear()` в терминале с фокусом, агенту ничего не уходит.
- **⌘K и ⌘F до 6.1.** В меню ещё стоят «Палитра команд» ⌘K и «Найти» ⌘F. Меню macOS
  перехватывает зарегистрированное сочетание раньше страницы, и ⌘K в терминале открыл
  бы старую палитру. Поэтому у этих пунктов `registerAccelerator: false`, а сочетания
  ловит рендерер: в терминале — `clear()` и `openSearch()`, вне терминала ⌘K открывает
  палитру (`AppShell`). Клик по пункту меню работает, как прежде.
- **WebGL:**
  - `shouldHaveWebgl` решает, загружать ли `WebglAddon` при каждом изменении
    видимости;
  - `onContextLoss` → `dispose` аддона, через 1 с — повтор, либо DOM до перезагрузки
    окна;
  - `?renderer=dom` отключает WebGL совсем, как сейчас.

**Тесты**
1. `findLinkCandidates`:
   - `Error at src/app/main.ts:12:3` → один кандидат `src/app/main.ts`, строка 12,
     колонка 3, без второго `/app/main.ts`;
   - `см. ./docs/Отчёт.md.` → путь с кириллицей, без точки в конце;
   - `https://example.com/a/b.ts?x=1` → один url, пути внутри нет;
   - `version 1.2.3` → ничего;
   - `~/x/y.txt` → путь.
2. Ячейки: эмодзи и CJK перед путём — `start` и `end` в ячейках; путь, перенесённый на
   вторую строку (`isWrapped`), — одна ссылка на обе строки.
3. `resolveCandidatePath` относительно worktree; `~/x` остаётся `~/x`. `sessionCwd` при
   `worktree.createdAt: null` → `projectPath`.
4. `createStatCache`: повторный запрос в течение 10 с не зовёт `locate`; через 10 с —
   зовёт; 501-й путь вытесняет самый старый.
5. Кандидат, у которого `locate` → `null` или корень другой работы, ссылкой не
   становится.
6. `LinkMenu`:
   - «Показать в Finder» зовёт `app.showInFinder` с абсолютным путём;
   - «Открыть в приложении по умолчанию» → `app.openPath`; ответ `'revealed'` — тост про
     исполняемый файл; отказ с `files:denied` — тост «Путь вне папок работы»;
   - меню URL: «Открыть в системном браузере» → `app.openExternal`, «Скопировать адрес».
7. `TerminalContextMenu`: «Копировать» есть только при выделении; «Очистить экран» зовёт
   `clear` без `pty.input`; «Найти» открывает полосу поиска.
8. `SearchBar`: неверная регулярка `(` — рамка ошибки, `findNext` не вызван; Enter —
   `findNext`, ⇧Enter — `findPrevious`; Esc закрывает.
9. `createWebglPolicy`:
   - восемь скрытых — у шести последних `true`, у двух старых `false`;
   - три потери за 60 с → `dom`;
   - потери с разницей больше 60 с → `retry`.
10. ⌘K в терминале зовёт `clear` и не шлёт `pty.input`; ⌘K вне терминала открывает
    палитру.
11. `menuTemplate`: у «Палитра команд» и «Найти» `registerAccelerator: false`, клик шлёт
    прежние `palette` и `find`.
12. Ручка из `terminalSurfaces`: `openSearch()` показывает полосу с фокусом в поле,
    `clear()` зовёт `term.clear`.

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
  - `src/preload/index.ts` — `app.pathForFile` через `webUtils.getPathForFile`,
    `app.saveDropImage`;
  - `src/shared/bridge.ts`, `src/main/ipc.ts` и `ipc.test.ts` —
    `app.saveDropImage('clipboard')`, канал `app:save-drop-image`;
  - `src/main/index.ts` — очистка `drops/` при старте;
  - `renderer/terminal/use-terminal.ts` — событие `paste` с картинкой;
  - `renderer/terminal/TerminalSurface.tsx` — приём файлов (HTML5 `drop` с
    `dataTransfer.files`), рамка при наведении;
  - `renderer/test-utils/fake-bridge.ts` — `pathForFile` (подставной путь по имени
    файла), `saveDropImage` (сеттер ответа, по умолчанию `null`);
  - `packages/desktop/e2e/stub-echo-agent.mjs` — режим `STUB_BRACKETED=1`.
- Документы: `README.md`, раздел «Окно» — ссылки, поиск, перетаскивание, скриншоты.

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
/** В буфере вставки картинка и нет текста: clipboardData.items с image/* и без text/plain. */
export function pasteHasOnlyImage(data: DataTransfer): boolean;

// renderer/terminal/send.ts — SendResult и SendReason из @harnas/protocol (5.1)
export type SendOutcome = SendResult | { error: 'not_found' | 'failed'; message: string };
/** Отказ вызова разбирает decodeIpcError (5.2): код not_found → not_found, прочее → failed. */
export async function sendToAgent(bridge: HarnasBridge, ref: SessionRef, text: string, submit: boolean): Promise<SendOutcome>;
export interface SendToast { text: string; actions: Array<'copy' | 'open' | 'retry' | 'resume'>; error: boolean }
export function sendToast(outcome: SendOutcome, label: string): SendToast;   // таблица спеки 8.6
```

**Поведение**
- **Вставка** ловится событием `paste` на поверхности терминала (capture, до textarea
  xterm), а не нажатием ⌘V: так пункт меню «Вставить» идёт тем же путём, а картинки
  видны в `clipboardData.items`.
  - `pasteHasOnlyImage` → `preventDefault`, `app.saveDropImage('clipboard')`. Путь есть —
    `sendToAgent(…, path, submit: false)`, обычной вставки нет;
  - иначе событие не трогается: текст вставляет сама xterm (`term.paste`, bracketed
    paste — её забота). В буфере и картинка, и текст — вставляется текст;
  - `saveDropImage` отказал (`drops/` недоступна) — тост «Не удалось сохранить
    скриншот: <текст ошибки>», вставки нет (спека 13);
  - main для надёжности тоже отдаёт `null`, если в буфере есть текст.
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
6. Событие `paste`:
   - картинка без текста (подставной `saveDropImage` отдаёт путь) → `pty.send` с путём,
     `preventDefault`;
   - с текстом — событие не тронуто, `saveDropImage` не вызван;
   - `saveDropImage` отказал → тост «Не удалось сохранить скриншот…», `pty.send` нет.
7. `sendToAgent`: отказ моста с `not_found` (`encodeIpcError`) →
   `{ error: 'not_found' }`, тост с «Возобновить»; прочая ошибка → `failed`.
8. **E2E `terminal-send.spec.ts`** (`STUB_BRACKETED=1`):
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
- [ ] Путь в поле ввода и письмо сессии: будильник не допечатал указатель и не нажал
      Enter.
- [ ] `pty.send`, пока агент ждёт разрешения, ничего не вставляет — тост «ждёт ответа».
- [ ] ⌘-клик по `src/a.ts:12` открывает файл; ⌘F ищет по скроллбэку.
- [ ] `README.md`, раздел «Окно» — ссылки, поиск, перетаскивание, скриншоты.
