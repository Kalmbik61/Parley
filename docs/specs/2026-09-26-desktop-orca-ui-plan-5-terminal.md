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
- `host/src/methods/pty.ts`: `PtyMethodDeps.works` пришёл с 4.1, тесты `pty.test.ts`
  зовут фабрику с подставным `works`;
- `renderer/terminal/use-terminal.ts`, `TerminalSurface.tsx` (`terminalSurfaces`,
  `openSearch()` с 2.5);
- `lib/capabilities.ts` (`REQUIRED_METHODS`, `useHostSupports`),
  `lib/tree-order.ts#workKey`, `test-utils/fake-bridge.ts`;
- из E.1: `shared/ipc-error.ts` (`encodeIpcError`, `decodeIpcError`), `main/ipc.ts`
  (`withIpcError` и `isValidWorkKey` — пока приватные), `shared/strings.ts` (`S`,
  `errorText`);
- клавиши: `main/menu.ts` (⌘K — «Command palette», ⌘F — «Find»), `shell/AppShell.tsx`
  (`openSearch`, `onMenu`), `lib/keys.ts#shouldForwardToTerminal`, `layout/keys.ts`
  (3.4 добавляет `work-step`);
- `main/window.ts#guardNavigation`: бросок файла мимо терминала гасит `will-navigate`;
- из 3.4: `app.revealWork`, `showItemInFolder` в `RegisterIpcOptions`, `S.cardMenu`
  (`reveal`, `copyPath`); из 4.3: `applyFocusTarget`;
- семь тестов с моком `@xterm/addon-web-links` и литералами моков `@xterm/xterm`:
  `layout/SurfaceLayer.test.tsx`, `layout/dnd-zones.test.tsx`,
  `layout/LayoutView.test.tsx`, `shell/AppShell.test.tsx`,
  `shell/AppShell.dnd.test.tsx`, `terminal/TerminalSurface.test.tsx`,
  `terminal/use-terminal.test.ts`;
- `e2e/terminal.spec.ts`, `e2e/stub-echo-agent.mjs`.

**Строки интерфейса** — правило индекса («Сквозные ограничения», кусок E.1):
- русские строки интерфейса в «…» ниже — смысл, а не текст. Текст — английский, ключом
  `S` в `packages/desktop/src/shared/strings.ts`: ключ и английский стоят рядом или в
  «Интерфейсах» куска. Кусок, который добавляет строки, вносит `shared/strings.ts` в
  «Изменить»;
- тесты ждут английский текст;
- ошибку main и хоста окно показывает по коду: `files:denied` — `S.files.denied`,
  прочее — `errorText(decodeIpcError(err).code, S.errors.actions.<действие>)`, по
  образцу `CreateRoomDialog.tsx`. Сообщение ошибки — текст хоста, `shell.openPath` или
  Node, на русской macOS локализованное — только в консоль;
- ошибки main (`FilesDeniedError` и прочие) несут английский технический текст для
  консоли: страж `english-ui` сканирует и `main/`;
- путь, адрес, ярлык сессии (`S02`) и текст, отправленный агенту, — данные, а не строки
  интерфейса: идут как есть.

---

## 5.1. Хост: общий «напечатать и нажать Enter», `pty.send`, черновик хоста

**Зачем.** Одна проверенная механика печати для будильника и для окна; окно пишет
агенту, не отвечая за него на диалоги. Текст, который окно оставило в поле ввода без
Enter, будильник видит как черновик и поверх него не печатает.
**Зависит от:** —. **Спека:** 3.2, 8.6.

**Файлы**
- Создать:
  - в `packages/host/src/pty/`: `type-and-submit.ts` и тест, `send.ts` и тест;
  - `packages/host/src/wake/host-draft.test.ts` — будильник поверх черновика хоста
    (тест 8) и `wake.inFlight` (тест 7): настоящий `PtyManager`, stub-агент, заготовка
    по образцу `rig` из `wake-service.test.ts`. Сам `wake-service.test.ts` не меняется.
- Изменить:
  - `packages/host/src/wake/wake-service.ts` — `beginAttempt` через `typeAndSubmit`; в
    `WakeService` — `inFlight(ref)` и `enterDelayMs`; пересчёт сессии по событию
    `host-draft`;
  - `packages/host/src/pty/draft.ts` и `draft.test.ts` — `stripEscapes` экспортируется,
    черновик хоста в `DraftTracker`, `\r` внутри вставки человека — не Enter;
  - `packages/host/src/pty/pty-manager.ts` и `pty-manager.test.ts` —
    `PtyHandle.bracketedPaste()`, `PtyManager.setHostDraft` и событие `host-draft`,
    `hasDraft()` с черновиком хоста;
  - `packages/host/src/pty/screen.ts` и `screen.test.ts` — режим bracketed paste
    headless-терминала;
  - `packages/host/src/methods/pty.ts` и `pty.test.ts` — метод `pty.send`,
    `PtyMethodDeps.wake`. После 4.1 тесты зовут фабрику с подставным `works`, 5.1
    добавляет им подставной `wake`; подставной `PtyManager` теста получает
    `setHostDraft`. Тест 5 — новый `describe` на `startHost({ home })` по образцу
    `methods/works.test.ts`;
  - `packages/host/src/methods/index.ts` — регистрация (`MethodDeps.wake` уже есть);
  - `packages/protocol/src/types.ts` и `index.ts` — `SendReason` и `SendResult`;
  - `packages/protocol/src/methods.ts` и тест — схема и результат `pty.send`;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` +
    `pty.send`.

**Интерфейсы**

```ts
// protocol/src/types.ts — общие для хоста и окна: окно хост не видит,
// tsconfig.web.json окна ссылается только на protocol и core
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
// input(): \r и \n между ESC[200~ и ESC[201~ (вставка человека; маркеры могут прийти
// разными кусками) — печатные символы, а не Enter

// pty/screen.ts, Screen — дополнение
bracketedPaste(): boolean;    // terminal.modes.bracketedPasteMode headless-терминала

// pty/pty-manager.ts, PtyHandle — дополнение и уточнение
bracketedPaste(): boolean;    // screen.bracketedPaste()
hasDraft(): boolean;          // черновик человека ИЛИ черновик хоста
// PtyManager, дополнение
/** Черновик хоста: текст, вставленный печатью хоста без Enter. Событие draft не шлёт; смена значения — host-draft. */
setHostDraft(ref: SessionRef, value: boolean): void;
/** Черновик хоста поставлен или снят. Слушает будильник (пересчёт сессии); typeAndSubmit — нет. */
on(event: 'host-draft', listener: (ref: SessionRef, hasHostDraft: boolean) => void): () => void;

// wake/wake-service.ts, дополнение WakeService
/** Текст указателя напечатан, а Enter ещё не ушёл (таймер Enter взведён). */
inFlight(ref: SessionRef): boolean;
/** Пауза перед Enter из WakeServiceOptions — одна на будильник и pty.send. */
readonly enterDelayMs: number;

// pty/send.ts
/** Очистка спеки 8.6, шаг 2; пусто или > 64 КиБ — HostError('bad_request'). */
export function sanitizeForSend(text: string): string;
/** Держит «свой Enter в полёте» по ref: второй вызов той же сессии до исхода первого — busy. */
export function createSender(deps: {
  pty: PtyManager; activity: ActivityService; wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;
}): (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult>;

// methods/pty.ts — works пришёл с 4.1
export interface PtyMethodDeps {
  pty: PtyManager;
  activity: ActivityService;
  works: WorksService;
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
  - `busy` — `wake.inFlight(ref)` **или свой Enter в полёте**: отправитель держит
    множество `ref`, у которых вставка `submit: true` ждёт своего Enter. Второй вызов
    той же сессии в это время (любой `submit`) — `busy`, записей нет: иначе Enter
    первого отправил бы оба текста, а тост второго сказал бы «без Enter»;
  - `blocked` — `activity.get(ref)?.activity.activity === 'blocked'`;
  - черновик берётся **до** вставки: `handle.hasDraft()` — черновик человека или хоста,
    оставшийся от прошлой вставки без Enter;
  - **между проверками и вставкой нет `await`**: `blocked`, `busy`, `no-paste-mode`,
    черновик и `pty.write` — в одном тике. Иначе будильник успел бы напечатать
    указатель между проверкой и вставкой;
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
  - смена черновика хоста шлёт `host-draft`, и будильник пересчитывает сессию
    (`recompute`). Иначе после своего Enter `pty.send` письмо, пришедшее за 500 мс
    ожидания, ждало бы следующего события сессии — у агента без хуков бесконечно.
    `typeAndSubmit` `host-draft` не слушает;
  - событие `draft` по-прежнему шлёт только ввод человека: смена его черновика или
    снятие черновика хоста его Enter, ⌃C, ⌃U. Печать хоста и `setHostDraft` событий
    `draft` не шлют, иначе ожидание Enter приняло бы собственную вставку за ввод
    человека;
  - `\r` и `\n` внутри вставки человека (между `ESC[200~` и `ESC[201~`, маркеры могут
    прийти разными кусками) — не Enter: ни черновик человека, ни черновик хоста не
    снимают. xterm переводит `\n` вставки в `\r`, и многострочная вставка с переводом
    строки в конце сняла бы черновик хоста — будильник допечатал бы указатель с Enter
    поверх промпта человека;
  - человек стёр вставку Backspace — черновик хоста держится до Enter, ⌃C или ⌃U, и
    будильник этой сессии до тех пор ждёт. Остаточный случай, записан в спеке 8.6;
  - свой указатель без Enter (отмена вводом, предохранитель) будильник черновиком хоста
    не помечает: его правила не меняются (тест 1).
- **Остаточное окно до `blocked`** (спека 8.6). `blocked` хост узнаёт из хуков с
  задержкой: журнал склеивается около 100 мс. Только что показанный диалог разрешения
  ещё `idle` или `working`, и `pty.send` вставит текст в него. Кода против этого нет;
  живая приёмка этапа проверяет отказ после значка «ждёт тебя».
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
     хоста от первой;
   - два вызова подряд: второй (любой `submit`) в окне ожидания Enter первого
     `submit: true` → `busy`, записей от него нет: в PTY только текст первого и один
     `\r`;
   - вставка без `await` после проверок: запись `pty.write` видна сразу после вызова,
     до первого `await` теста.
5. `methods/pty.test.ts`, `pty.send` через сервер хоста (`startHost({ home })`) для
   сессии без PTY → `not_found`. Схема отвергает пустой `text`.
6. `PtyManager` и `DraftTracker`:
   - `setHostDraft(ref, true)` → `hasDraft()` истинно, события `draft` нет, событие
     `host-draft` есть; повтор того же значения `host-draft` не шлёт;
   - ввод человека `x` черновик хоста не снимает;
   - `\r`, `\x03` и `\x15` человека снимают его и шлют `draft`;
   - вставка человека `ESC[200~a\rb\r`, затем отдельным куском `ESC[201~` — ни черновик
     человека, ни черновик хоста не сняты; `\r` после `ESC[201~` снимает оба;
   - `stripEscapes` экспортирован и вырезает `ESC[31m`.
7. `host-draft.test.ts`, `wake.inFlight`: истинно между печатью указателя и его Enter;
   сразу после Enter — ложно, хотя ход ещё не начался. `wake.enterDelayMs` — из опций
   будильника.
8. `host-draft.test.ts`, настоящий `PtyManager` и stub-агент:
   - `pty.send { text: "'/tmp/a b.png' ", submit: false }`, затем письмо сессии → за
     600 мс ни указателя, ни `echo:`;
   - человек жмёт Enter (`pty.input(ref, '\r')`) → `echo:` с путём, затем указатель
     уходит отдельным ходом;
   - `pty.send { submit: true }`, письмо пришло в окне ожидания его Enter → поверх
     указатель не напечатан, строка `echo:` содержит только текст `pty.send`; затем
     указатель уходит отдельным ходом — будильник пересчитал сессию по `host-draft`.
9. `screen.test.ts`: после обработки записи `ESC[?2004h` `bracketedPaste()` истинно,
   после `ESC[?2004l` — ложно.

**Приёмка**
- [ ] Все тесты зелёные — сверка с базовым прогоном (индекс, «Правила проверки»); тесты
      `wake-service` не менялись (`git diff` по `wake-service.test.ts` пуст).

---

## 5.2. Main: реестр корней, `files.stat` и `files.locate`, открыть и показать в Finder, отказ `files:denied`

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
  - `packages/desktop/src/shared/work-keys.ts` и тест — `workKey` и `rootKey`.
- Изменить:
  - `src/shared/bridge.ts`, `src/preload/index.ts` — `files.stat`, `files.locate`,
    `app.openPath`, `app.showInFinder`;
  - `src/main/ipc.ts` и `ipc.test.ts` — `withIpcError` и `isValidWorkKey`
    экспортируются (их зовёт `files/ipc.ts`), `withIpcError` отдаёт `FilesDeniedError`
    как `files:denied`; каналы `app:open-path`, `app:show-in-finder`; поля `roots` и
    `openPath` в `RegisterIpcOptions` (`showItemInFolder` — с 3.4).
    `shared/ipc-error.ts` и его тест есть с E.1 и не меняются;
  - `src/main/index.ts` — реестр корней на `connection` (`RootsSource`: `call`,
    `onEvent` → `works.changed`, `onStatus` → `connected`), регистрация `files/ipc.ts`,
    `openPath: (path) => shell.openPath(path)`;
  - `renderer/lib/tree-order.ts` — `workKey` реэкспортируется из `shared/work-keys.ts`,
    прежние импорты не меняются;
  - `renderer/test-utils/fake-bridge.ts` — `files.stat` и `files.locate(workKey,
    absPaths)` (по умолчанию `null` на каждый путь, сеттер ответов, журнал
    `locateCalls`), `app.openPath` (`'opened'`), `app.showInFinder`, журналы
    `openedPaths` и `revealedPaths`;
  - `src/shared/strings.ts` — `S.files.denied` (ниже).

**Интерфейсы**

```ts
// shared/files-types.ts
export interface FileRoot { workKey: string; spec: FileRootSpec }        // FileRootSpec — shared/layout-types.ts
export interface FileStat { kind: 'file' | 'dir'; size: number; mtimeMs: number }
/** Абсолютный путь, найденный в корне работы, которую назвал вызов. */
export interface Located { root: FileRoot; relPath: string; stat: FileStat }

// shared/work-keys.ts — один формат ключей для main и рендерера
export function workKey(projectPath: string, workId: string): string;   // `${projectPath} ${workId}`, формат прежний
/** Ключ корня (спека 10.8): workKey, вид и sessionId. */
export function rootKey(root: FileRoot): string;                        // `${workKey} project` | `${workKey} worktree s-02`

// main/ipc.ts — обёртка с E.1 (shared/ipc-error.ts не меняется); 5.2 экспортирует её и проверку ключа
/** HostError → свой code, FilesDeniedError → 'files:denied', прочее → 'failed'; всё через encodeIpcError. */
export function withIpcError(handler: (event: unknown, ...args: unknown[]) => unknown): (event: unknown, ...args: unknown[]) => Promise<unknown>;
export function isValidWorkKey(value: unknown): value is string;   // непустая строка до 4096, не __proto__ и т. п.
// RegisterIpcOptions, дополнение (showItemInFolder — с 3.4)
roots: RootsRegistry;
openPath: (absPath: string) => Promise<string>;   // shell.openPath: '' — успех, иначе текст ошибки

// main/roots.ts
export interface RootsSource {
  list(): Promise<WorksSnapshot>;                                    // connection.call('works.list', {})
  onChange(listener: (snapshot: WorksSnapshot) => void): () => void; // событие works.changed
  /** Каждое (пере)подключение к хосту: connection.onStatus → connected. Снимок работ новому клиенту хост не шлёт. */
  onConnected(listener: () => void): () => void;
}
/** Код files:denied. Текст — английский технический, для консоли: человеку окно показывает S.files.denied по коду. */
export class FilesDeniedError extends Error {}
export interface RootsRegistry {
  /** realpath цели внутри realpath корня; для записи — правила ниже; иначе FilesDeniedError. */
  resolve(root: FileRoot, relPath: string, mode: 'read' | 'write'): Promise<string>;
  /** Корень работы workKey, которому принадлежит путь: самый длинный realpath среди её корней (проект и worktree её сессий). */
  locate(workKey: string, absPath: string): Promise<{ root: FileRoot; relPath: string } | null>;
  /** realpath пути, если он внутри корня любой работы (openPath, showInFinder); иначе null. */
  insideAnyRoot(absPath: string): Promise<string | null>;
  roots(workKey: string): Array<{ spec: FileRootSpec; absPath: string }>;   // absPath — realpath
}
/** `~` в locate и insideAnyRoot раскрывается по home (по умолчанию os.homedir()). */
export function createRootsRegistry(source: RootsSource, options?: { home?: string }): RootsRegistry;

// main/files/open-path.ts
/** Белый список «открыть в приложении» (спека 10.8): расширения без точки, в нижнем регистре. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string>;
/** Имена — самого пути и его realpath; isDirectory и mode — stat по ссылке. */
export function openVerdict(paths: Array<{ name: string; isDirectory: boolean; mode: number }>): 'open' | 'reveal';

// bridge.ts
files: {
  stat(root: FileRoot, paths: string[]): Promise<Array<FileStat | null>>;   // до 200 путей
  /** До 200 путей; корень ищется только среди корней работы workKey; `~` раскрывает main. */
  locate(workKey: string, absPaths: string[]): Promise<Array<Located | null>>;
};
app: {
  /** Только внутри корней любой работы; открывается только белый список, остальное показывается в Finder. */
  openPath(absPath: string): Promise<'opened' | 'revealed'>;
  showInFinder(absPath: string): Promise<void>;
};

// shared/strings.ts, дополнение S (английский текст; русский в плане — смысл)
files: {
  denied: 'Path is outside the workspace folders',   // код files:denied: main текста не пишет, окно показывает его по коду (5.3, 7.x)
},
```

**Поведение**
- **Корни:**
  - `projectPath` каждой работы;
  - `worktree.path` каждой сессии с `worktree.createdAt !== null`.
  - Реестр строится из `works.list` на каждое (пере)подключение (`onConnected`) и
    обновляется по `works.changed`. Хост снимок работ новому клиенту не повторяет, а
    первый `connect()` main может упасть (дальше — переподключение): один `list()` при
    старте оставил бы реестр пустым, и все ссылки и `openPath` получали бы
    `files:denied`, пока не изменится какая-нибудь карта.
  - Отказ `list()` оставляет прежние корни. `works.changed`, пришедший, пока `list()`
    в пути, главнее: ответ такого `list()` отбрасывается.
  - Пути корней приводятся через `realpath`: на macOS `/tmp` — это `/private/tmp`,
    сравнивать надо реальные пути. Корень, чей `realpath` упал (worktree удалён),
    пропускается: пересборка реестра не падает.
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
- **`locate(workKey, absPath)`:**
  - `~` и `~/…` раскрывает main (`os.homedir()`): у рендерера в песочнице дома нет;
  - после раскрытия путь абсолютный, иначе `null`; нет файла — `null`;
  - корень — самый длинный `realpath` среди корней **работы `workKey`** (проект и
    worktree её сессий), внутри которого `realpath` пути; `relPath` — от него. Так
    `/private/tmp/…` из вывода агента находит корень `/tmp/…`, а путь в папке проекта
    при сессии в worktree — корень проекта;
  - почему только своя работа: корень `project` заводится на каждую работу, и у N работ
    одного проекта — N корней с одним `realpath` и разными `workKey`. Поиск по всем
    работам выбрал бы одну, и ссылки появились бы только в её терминалах. Worktree
    сессии чужой работы внутри папки проекта путь своей работы тоже не перехватывает.
- **`files.locate(workKey, absPaths)`** — `locate` и `stat` на каждый путь.
  **`files.stat`** — `null` для отсутствующих путей и для путей вне корня. Отказ по
  одному пути пачку не валит; больше 200 путей — отказ всего вызова.
- **Проверка аргументов** каналов `files:*`, `app:open-path` и `app:show-in-finder` —
  до обращения к диску, неверная форма — отказ:
  - `workKey` — `isValidWorkKey` (непустая строка до 4096, не `__proto__`,
    `constructor`, `prototype`);
  - `FileRoot` — объект с `workKey` и `spec` одного из двух видов: `{ kind: 'project' }`
    или `{ kind: 'worktree', sessionId }` с непустой строкой `sessionId`;
  - пути — строки без NUL; массив — не больше 200.
- **`openPath`** — `~` раскрывает main, как `locate`, и работает с раскрытым путём.
  Путь должен лежать внутри корня **любой** работы (`insideAnyRoot !== null`): его
  прислало меню ссылки или 7.x, а своя ли это работа, проверил `files.locate`. Иначе
  `files:denied`. Затем `openVerdict`: имена — самого пути и его `realpath`, вид и
  права — `stat` (по ссылке). У `lstat` симлинка на macOS режим 0755, и любой симлинк
  ушёл бы в `reveal`:
  - `open` — файл, у которого расширения и имени пути, и имени `realpath` есть в
    `OPENABLE_EXTENSIONS` (без учёта регистра), и нет ни одного бита x
    (`mode & 0o111`); ещё — каталог без расширения (Finder откроет папку);
  - белый список — спека 10.8: картинки `png jpg jpeg gif webp heic bmp tiff ico svg`;
    `pdf`; простой текст и данные `txt md markdown rtf csv tsv json yaml yml toml xml
    log`; документы `docx xlsx pptx pages numbers key odt ods odp`; медиа `mp3 wav m4a
    aac flac mp4 mov m4v webm`;
  - `reveal` — всё прочее: `html` и `htm`, офис с макросами (`docm`, `xlsm`, `pptm`),
    скрипты и исходники (`.py`, `.sh`, `.command`, `.js`…), архивы, приложения и
    установщики, каталог с расширением (бандл), файл без расширения, файл с битом x
    при любом расширении. Ссылка `a.txt → b.command` — тоже `reveal`;
  - `reveal` → `showItemInFolder` (3.4), ответ `'revealed'`; окно покажет тост
    «Такой файл отсюда не открывается — показан в Finder» (5.3);
  - иначе `openPath` из `RegisterIpcOptions`, ответ `'opened'`; непустой ответ
    `shell.openPath` — ошибка `failed`.
  - Почему белый список: `shell.openPath` на macOS — двойной клик Finder. `.command`
    выполняется в Terminal, `.app` запускается, `.py` без бита x открывает Python
    Launcher и исполняется, а у файлов, созданных агентом, нет карантина, и Gatekeeper
    не спросит. Запрещающий список неполон по устройству. Путь в выводе агента и
    ⌘-клик не должны запускать код в обход разрешений агента; цена — часть файлов
    показывается в Finder вместо открытия.
- **`showInFinder`** — `~` раскрывает main; `showItemInFolder` после
  `insideAnyRoot(absPath) !== null`, иначе `files:denied`.
- **Коды ошибок через IPC** — с E.1 (сквозное правило индекса):
  - `shared/ipc-error.ts` и обёртка `withIpcError` (`main/ipc.ts`) уже есть и
    оборачивают все каналы. 5.2 экспортирует `withIpcError` для `files/ipc.ts` и учит
    её отдавать `FilesDeniedError` как `files:denied`; `HostError` — со своим `code`,
    прочее — `failed`;
  - рендерер читает код через `decodeIpcError(err)`: `not_found` отличает 5.4,
    `files:denied` — тосты 5.3 и 7.x (`S.files.denied`). Сообщение ошибки — только в
    консоль.
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
4. Корень в `/tmp/x`: `resolve` отдаёт путь под `/private/tmp/x`,
   `locate(workKey, '/tmp/x/a')` находит корень.
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
   - путь внутри worktree сессии этой работы, лежащего внутри папки проекта, →
     корень worktree;
   - путь вне корней и несуществующий → `null`;
   - `files:locate` с 201 путём → отказ.
9. Две работы A и B одного проекта:
   - путь в папке проекта: `locate(A, p)` → корень `project` с `workKey` A,
     `locate(B, p)` → с `workKey` B — ссылка будет в терминале каждой;
   - worktree сессии работы B внутри папки проекта: путь в нём при `locate(A, …)` →
     корень проекта работы A (чужой worktree путь не перехватывает), при
     `locate(B, …)` → worktree B.
10. Подключение, подставной `RootsSource`:
    - первый `list()` отклонён — корней нет; `onConnected` → новый `list()` — корень
      есть;
    - отказ следующего `list()` оставляет прежние корни;
    - `works.changed`, пришедший, пока `list()` в пути, главнее: устаревший ответ
      `list()` его не затирает.
11. Worktree сессии удалён с диска (`realpath` корня падает) — пересборка реестра не
    падает, корень пропущен, остальные на месте.
12. `openVerdict`:
    - `x.command`, `x.SH`, `index.html` и `x.py` 0644 (Python Launcher исполняет и без
      бита x) → `reveal`;
    - `report.pdf` 0644, `a.txt` 0644, `IMG.PNG` 0644 → `open`;
    - `notes.txt` 0755 → `reveal`: бит x главнее белого списка;
    - каталог `Foo.app` → `reveal`, каталог `docs` → `open`;
    - `a.txt`, чей `realpath` — `b.command`, → `reveal`.
13. `app:open-path` и `app:show-in-finder`:
    - `.command` в корне → `showItemInFolder`, `openPath` не вызван, ответ
      `'revealed'`;
    - симлинк `link.txt → a.txt` (0644) в корне → `openPath`: права по ссылке
      (`stat`), хотя у самой ссылки (`lstat`) на macOS 0755;
    - `~/…` внутри корня (подставной дом) → раскрыт и открыт; путь в корне другой
      работы → открыт;
    - путь вне корней → отказ, `decodeIpcError` даёт `files:denied`; `showInFinder` —
      то же, а внутри корня зовёт `showItemInFolder` с раскрытым путём.
14. Проверка аргументов: `FileRoot` без `spec`, `spec.kind: 'other'`, `worktree` без
    `sessionId`, `workKey` `'__proto__'` и длиннее 4096, путь с NUL, путь не строкой —
    отказ, `resolve` и `stat` не вызваны; `app:open-path` и `app:show-in-finder` с
    не-строкой — отказ.
15. `withIpcError` (экспорт): `FilesDeniedError` → `files:denied`, `HostError` — свой
    код, прочее — `failed`; каналы `files:*` из `files/ipc.ts` отказывают с кодом.
    Круг `encodeIpcError`/`decodeIpcError` и `host:call` с кодом проверены с E.1
    (`shared/ipc-error.test.ts`, `main/ipc.test.ts`).
16. `work-keys`: `workKey` прежнего формата; `rootKey` проекта и worktree разные;
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
- Создать: `renderer/test-utils/xterm-mock.ts` — общий мок `@xterm/xterm` для семи
  тестов вместо литералов: заглушка `Terminal` со всеми методами, которые зовёт
  `use-terminal.ts` (в том числе `registerLinkProvider`, `clear`, `selectAll`), и общий
  журнал вызовов. Новый метод xterm в `use-terminal.ts` дописывается в одно место.
- Изменить:
  - `renderer/terminal/use-terminal.ts` и `use-terminal.test.ts` — без `WebLinksAddon`
    (`isHttpUrl` переезжает в `links.ts`); провайдер ссылок и `linkHandler` OSC 8;
    `allowProposedApi: true`; WebGL через `webglPolicy`; ⌘K и ⌘F в своём обработчике
    клавиш с `preventDefault`; новые поля `UseTerminalOptions`. Тест `:301` («https
    открывается наружу, file — нет») проверял обработчик аддона — его заменяют тесты
    `links.ts` (13);
  - `renderer/terminal/TerminalSurface.tsx` и `TerminalSurface.test.tsx` — `SearchBar`
    вместо полосы 2.5, `LinkMenu`, `TerminalContextMenu`, у ручки новое `clear()`;
    `workKey`, `cwd`, `onFind`, `onLink` для `useTerminal`. Тест `:89` («`openSearch()`
    ручки…») переписывается под `SearchBar`;
  - семь тестов с моками xterm (список — «Перед стартом») — без
    `vi.mock('@xterm/addon-web-links')`, мок `@xterm/xterm` берут из
    `test-utils/xterm-mock.ts`: провайдер ссылок и ручка 5.3 уронили бы литералы без
    `registerLinkProvider` и `clear`;
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` —
    `app.paste()`, канал `app:paste` → `event.sender.paste()`;
  - `renderer/test-utils/fake-bridge.ts` — журналы `externalOpened` (`app.openExternal`)
    и `pastes` (`app.paste`);
  - `src/shared/strings.ts` — строки ниже;
  - `packages/desktop/package.json` и корневой `pnpm-lock.yaml` — удалить
    `@xterm/addon-web-links`: адреса обрабатывает `links.ts`;
  - `packages/desktop/e2e/terminal.spec.ts` — E2E наведения (тест 15).
- Не меняются: `src/main/menu.ts` и `renderer/shell/AppShell.tsx`. Меню, ⌘K вне
  терминала и ⌘F через пункт меню остаются как есть до 6.1.

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
/** Наружу — только http и https, как main/ipc.ts#isAllowedExternalUrl; переезжает из use-terminal.ts. */
export function isHttpUrl(url: string): boolean;
/**
 * Абсолютный путь кандидата: относительный — от cwd; `.` и `..` снимаются лексически (в рендерере
 * нет node:path), выше `/` не поднимается. `~` остаётся как есть — его раскрывает main (files.locate).
 */
export function resolveCandidatePath(candidate: LinkCandidate, cwd: string): string;
/** Кэш поверх files.locate: ключ — workKey и путь, 500 записей, 10 с жизни; null кэшируется тоже. */
export interface StatCache { lookup(workKey: string, absPaths: string[]): Promise<Array<Located | null>> }
export function createStatCache(locate: (workKey: string, absPaths: string[]) => Promise<Array<Located | null>>,
  options?: { max?: number; ttlMs?: number; now?: () => number }): StatCache;   // 500, 10 000 мс
/** worktree.path, если worktree.createdAt !== null; иначе projectPath. */
export function sessionCwd(session: WorkSession, projectPath: string): string;
/** Ссылка под указателем: путь — только найденный в корне своей работы, URL — только http(s). */
export type TerminalLink =
  | { kind: 'path'; absPath: string; located: Located; line?: number; col?: number }
  | { kind: 'url'; url: string };

// terminal/use-terminal.ts, дополнение UseTerminalOptions — всё даёт TerminalSurface
workKey: string;       // работа терминала (из sessionRef): files.locate(workKey, …), сверка located.root.workKey
cwd: string;           // sessionCwd(сессия из useWorksStore, projectPath): от него относительные пути
onFind(): void;        // ⌘F в терминале — openSearch() своей поверхности
onLink(link: TerminalLink, event: MouseEvent): void;   // клик по ссылке и по OSC 8; ⌘-клик или меню решает TerminalSurface

// terminal/TerminalSurface.tsx, TerminalSurfaceHandle (2.5)
openSearch(): void;   // с 2.5; 5.3 переводит его на SearchBar
clear(): void;        // новое: term.clear(), агенту ничего не уходит

// terminal/webgl-policy.ts
export interface WebglPolicy {
  /** Видимость терминала key; перемены решений политика шлёт подписчикам — в том числе давно скрытым. */
  update(key: string, visible: boolean): void;
  /** Решение для key: текущее — сразу, дальше — каждая перемена. want: false — освободить WebglAddon. */
  subscribe(key: string, listener: (want: boolean) => void): () => void;
  /** Терминал размонтирован: уходит из LRU, его место получает следующий скрытый. */
  forget(key: string): void;
  onContextLoss(key: string): 'retry' | 'dom';               // 'dom' после 3 потерь за 60 с
}
export function createWebglPolicy(options?: { keepHidden?: number; maxLosses?: number; windowMs?: number; now?: () => number }): WebglPolicy;
/** Один экземпляр на окно: его берут все use-terminal, ключ — refKey сессии. */
export const webglPolicy: WebglPolicy;

// bridge.ts, дополнение к app — пункт «Вставить» меню терминала (спека 8.4)
/** Main: webContents.paste() окна — то же событие paste, что у ⌘V; execCommand('paste') в песочнице не работает. */
paste(): void;

// test-utils/fake-bridge.ts, дополнение к FakeBridge
readonly externalOpened: string[];   // app.openExternal
readonly pastes: number[];           // app.paste, по записи на вызов

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
common: { copy: 'Copy' },
files: {
  revealedInFinder: "This file type doesn't open here — revealed in Finder",   // ответ 'revealed'; denied — с 5.2
},
links: {
  openInDefaultApp: 'Open in default app', openInBrowser: 'Open in browser', copyLink: 'Copy link',
},   // «Показать в Finder» и «Скопировать путь» — S.cardMenu.reveal и copyPath (3.4); 'Open in editor' — 7.3
terminal: {
  paste: 'Paste', selectAll: 'Select all', clear: 'Clear',
  matchCase: 'Match case', useRegex: 'Use regular expression',
  previousMatch: 'Previous match', nextMatch: 'Next match',
},   // Copy — S.common.copy; Find, Split right, Split down — S.menu; × — S.common.close; поле — S.terminal.findPlaceholder
errors: { actions: { openFile: 'open file', revealInFinder: 'reveal in Finder' } },
```

**Поведение**
- **Регулярки** — исправление спеки 8.3, флаг `u`:
  - путь: `(?:~|\.{1,2})?(?:/[\p{L}\p{N}_.@+-]+)+(?::\d+(?::\d+)?)?`;
  - относительный с расширением: `[\p{L}\p{N}_.@+-]+(?:/[\p{L}\p{N}_.@+-]+)*\.`,
    затем расширение `[\p{L}\p{N}]{1,8}`, в котором обязательна буква, и
    `(?::\d+(?::\d+)?)?`. Так `version 1.2.3` не ссылка;
  - слева от пути — не символ пути: `src/app/main.ts:12:3` не совпадает ещё и как
    `/app/main.ts:12:3`;
  - URL — умолчание `WebLinksAddon` 0.12 (`strictUrlRegex`, перенести в `links.ts` до
    удаления пакета): последний символ не пунктуация, `https://x.y/z).` →
    `https://x.y/z`. URL ищется первым; путь внутри найденного URL не ищется.
    Совпадения не пересекаются;
  - хвостовые `.,;:!?)` в путь не входят: `./docs/Отчёт.md.` → `./docs/Отчёт.md`;
  - регулярки создаются один раз, сразу с флагами `gu`; флаг к готовой регулярке не
    дописывается. `WebLinksAddon` строил `new RegExp(source, flags + 'g')`, и на флагах
    `gg` падал `SyntaxError` на каждом наведении.
- **Ссылки:**
  - провайдер — `term.registerLinkProvider`. xterm зовёт его на строку под указателем
    (`provideLinks(y)`). Кандидаты логической строки под ним уходят одной пачкой;
    перенесённая строка (`isWrapped`) склеивается с предыдущей: ссылка может занимать
    две строки буфера;
  - `start` и `end` — в ячейках, а не в кодовых единицах: широкие символы (эмодзи, CJK)
    занимают две ячейки, индекс строки переводится через `getCell(x).getWidth()`;
  - `workKey` и `cwd` терминал получает от `TerminalSurface`: `workKey` — из
    `sessionRef`, `cwd` — `sessionCwd(сессия из useWorksStore, projectPath)`;
  - кандидат → `resolveCandidatePath(…, cwd)` → `StatCache.lookup(workKey, …)` (500
    путей, 10 с; кэш у каждого терминала свой) → ссылка, только если путь найден.
    `files.locate` ищет корень только среди корней работы терминала (5.2), поэтому
    путь вне корней работы ссылкой не становится; сверка `root.workKey === workKey` —
    страховка;
  - `null` тоже живёт в кэше 10 с: путь, напечатанный до создания файла или до
    готовности реестра корней, станет ссылкой не раньше чем через 10 с. Цена — меньше
    вызовов `files.locate` при движении указателя;
  - клик по ссылке → `onLink(link, event)`, решает `TerminalSurface`: обычный клик —
    `LinkMenu` у курсора, ⌘-клик — сразу действие;
  - `LinkMenu` пути: `Open in default app` → `app.openPath`, `Reveal in Finder`
    (`S.cardMenu.reveal`) → `app.showInFinder`, `Copy path` (`S.cardMenu.copyPath`) →
    буфер обмена; «Открыть в редакторе» добавит 7.3 — по `located.root` и `relPath`;
  - ⌘-клик по пути — приложение по умолчанию, до 7.3;
  - `app.openPath` ответил `'revealed'` — тост `S.files.revealedInFinder`. Отказ —
    тост по коду: `files:denied` → `S.files.denied`, прочее — `errorText(code,
    S.errors.actions.openFile)`, у «Reveal in Finder» — `revealInFinder`. Сообщение
    ошибки — только в консоль;
  - URL: клик — меню `Open in browser` (`app.openExternal`) и `Copy link`; ⌘-клик —
    `app.openExternal`, до 9.2;
  - ссылки OSC 8 — `linkHandler` в опциях `Terminal`: `activate(event, text)` →
    `onLink({ kind: 'url', url: text }, event)`, только если `isHttpUrl(text)`, прочие
    схемы — ничего. Без обработчика xterm показал бы свой `confirm()` с английским
    текстом не из `S` и позвал бы `window.open`.
- **Меню терминала** — спека 8.4, семь пунктов:
  - `Copy` — только при выделении: `term.getSelection()` в буфер обмена;
  - `Paste` — фокус в терминал, затем `app.paste()`: main зовёт `webContents.paste()`,
    и срабатывает то же событие `paste`, что у ⌘V, — картинку из буфера ловит 5.4.
    `document.execCommand('paste')` в песочнице окна не работает;
  - `Select all` — `term.selectAll()`;
  - `Clear` — `clear()`;
  - `Find` — `openSearch()`;
  - `Split right` и `Split down` — как в меню вкладки (`layout/Tab.tsx#beginSplit`):
    фокус своей вкладки, затем `openPicker({ workKey, direction, openSessionIds })`.
- **Поиск ⌘F:**
  - `SearchBar` 32px справа сверху;
  - переключатели «Aa» (`Match case`) и «.*» (`Use regular expression`), счётчик `N/M`
    (свыше 1000 — `1000+`), кнопки ↑ (`Previous match`), ↓ (`Next match`) и ×
    (`S.common.close`);
  - Enter / ⇧Enter; Esc и × закрывают полосу и возвращают фокус в терминал;
  - цвета декораций `#f0c674` и `#ff9e3b`;
  - неверная регулярка — красная рамка поля, поиска нет;
  - в опциях `Terminal` — `allowProposedApi: true`. `SearchAddon` 0.16 рисует
    совпадения декорациями и шлёт `onDidChangeResults` (счётчик) только с
    `decorations`, а декорация — `registerDecoration`, предлагаемый API xterm 5.5: без
    опции он бросает;
  - исключение декораций `SearchAddon` ловится и показывается как «0/0» — только
    страховка. Моки `SearchAddon` в jsdom дефекта не видят: подсветку и счётчик
    проверяет живая приёмка.
- **⌘K и ⌘F в терминале.** Обработчик клавиш xterm (`attachCustomKeyEventHandler`) на
  keydown ⌘K зовёт `term.clear()`, на ⌘F — `onFind()`, и в обоих случаях
  `event.preventDefault()`; агенту ничего не уходит.
  - Почему `preventDefault`: на macOS ⌘-сочетание сначала получает страница, а пункт
    меню — только необработанное. Обработчик xterm, вернув `false`, `preventDefault` не
    зовёт, и без него ⌘K в терминале заодно открыл бы палитру пунктом «Command
    palette». `registerAccelerator: false` на macOS не действует: в типах Electron 44
    у него `@platform linux,win32`.
  - Меню и `AppShell` не меняются: вне терминала ⌘K открывает палитру пунктом меню, ⌘F
    — полосу поиска активного терминала (`AppShell#openSearch`), как с 2.5. До 6.1.
  - Ветки временные: 6.1b переносит ⌘K и ⌘F в обработчик окна (`terminal.clear` и
    `find`, спека 9.6) и убирает их из `use-terminal.ts` вместе с `onFind`. Обработчик
    окна в capture-фазе до xterm их не пустит. Тест 10 переезжает в
    `keys/handler.test.ts` и `AppShell.test.tsx`.
- **WebGL:**
  - `use-terminal` подписан на `webglPolicy`, ключ — `refKey` сессии: `update(key,
    visible)` на каждую смену видимости, `subscribe` — загрузить `WebglAddon` при
    `want: true` и освободить при `want: false`, `forget` при размонтировании;
  - решение приходит и давно скрытому терминалу: когда прячется седьмой, самый старый
    скрытый получает `want: false`, хотя его видимость не менялась. Вопрос «при
    каждом изменении своей видимости» контекст у него не отнял бы, и предел «видимые и
    6 скрытых» не держался бы;
  - `onContextLoss` → `dispose` аддона, через 1 с — повтор, либо DOM до перезагрузки
    окна: дальше `want: true` не действует;
  - `?renderer=dom` отключает WebGL совсем, как сейчас: подписки нет.

**Тесты**
1. `findLinkCandidates`:
   - `Error at src/app/main.ts:12:3` → один кандидат `src/app/main.ts`, строка 12,
     колонка 3, без второго `/app/main.ts`;
   - `см. ./docs/Отчёт.md.` → путь с кириллицей, без точки в конце;
   - `https://example.com/a/b.ts?x=1` → один url, пути внутри нет;
   - `(см. https://x.y/z).` → url `https://x.y/z` без `).`;
   - `version 1.2.3` → ничего;
   - `~/x/y.txt` → путь;
   - два вызова подряд на одной строке дают одно и то же: регулярки с `g` не держат
     `lastIndex` между вызовами.
2. Ячейки: эмодзи и CJK перед путём — `start` и `end` в ячейках; путь, перенесённый на
   вторую строку (`isWrapped`), — одна ссылка на обе строки.
3. `resolveCandidatePath` относительно worktree; `../x/./y.ts` от `/p/w` → `/p/x/y.ts`;
   `~/x` остаётся `~/x`. `sessionCwd` при `worktree.createdAt: null` → `projectPath`.
4. `createStatCache`: повторный запрос в течение 10 с не зовёт `locate`, и для
   `null` тоже; через 10 с — зовёт; 501-й путь вытесняет самый старый; тот же путь с
   другим `workKey` — отдельный вызов.
5. Провайдер: `lookup` получает `workKey` своего терминала (журнал `locateCalls`);
   кандидат, у которого `locate` → `null` или (страховка) корень другой работы,
   ссылкой не становится.
6. `LinkMenu`:
   - `Reveal in Finder` зовёт `app.showInFinder` с абсолютным путём;
   - `Open in default app` → `app.openPath`; ответ `'revealed'` — тост `This file type
     doesn't open here — revealed in Finder`; отказ с `files:denied` — тост `Path is
     outside the workspace folders`; отказ с `failed` — `Couldn't open file: failed.`;
   - меню URL: `Open in browser` → адрес в `externalOpened`; `Copy link` — адрес в
     буфере.
7. `TerminalContextMenu`: семь пунктов по порядку спеки 8.4; `Copy` есть только при
   выделении; `Paste` фокусирует терминал и пишет запись в `pastes`; `Select all` зовёт
   `selectAll`; `Clear` зовёт `clear` без `pty.input`; `Find` открывает полосу поиска;
   `Split right` — `openPicker` с `direction: 'right'` и работой терминала.
8. `SearchBar`: неверная регулярка `(` — рамка ошибки, `findNext` не вызван; Enter —
   `findNext` с опциями «Aa» и «.*» и `decorations`, ⇧Enter — `findPrevious`; ↑ и ↓ —
   `findPrevious` и `findNext`; × и Esc закрывают и возвращают фокус в терминал;
   `aria-label` — `Match case`, `Use regular expression`, `Previous match`, `Next
   match`, `Close`.
9. `createWebglPolicy`:
   - восемь видимых терминалов скрываются по очереди — после седьмого и восьмого
     подписчики двух старейших получают `want: false` без своего `update`, у шести
     последних — `true`;
   - `forget` одного из шести — седьмой получает `want: true`;
   - три потери за 60 с → `dom`;
   - потери с разницей больше 60 с → `retry`.
10. Клавиши в терминале (`use-terminal`): keydown ⌘K — `clear` вызван,
    `defaultPrevented`, `pty.input` нет; ⌘F — `onFind` вызван, `defaultPrevented`. В
    `AppShell.test.tsx` палитра после ⌘K в терминале не открыта. Меню macOS в jsdom
    нет — его проверяет приёмка.
11. `use-terminal`:
    - конструктор `Terminal` получает `allowProposedApi: true` и `linkHandler`;
    - `registerLinkProvider` вызван, модуля `@xterm/addon-web-links` в импортах нет;
    - `linkHandler.activate` с `https://…` → `onLink` с `kind: 'url'`, с
      `file:///etc/passwd` — `onLink` не вызван;
    - `want: false` от `webglPolicy` — `dispose` аддона WebGL; размонтирование —
      `forget`.
12. Ручка из `terminalSurfaces`: `clear()` зовёт `term.clear`, `pty.input` нет. Тест
    `TerminalSurface.test.tsx:89` под `SearchBar`: `openSearch()` — полоса с фокусом в
    поле, Enter — `findNext`, Esc закрывает.
13. `isHttpUrl` (вместо `use-terminal.test.ts:301`): `https:` и `http:` → `true`,
    `file:` и `javascript:` → `false`.
14. `ipc`: `app:paste` зовёт `paste()` у `event.sender`.
15. **E2E `terminal.spec.ts`**: в терминал stub-агента вводится строка с URL и путём
    (`https://example.com/x ./src/a.ts:12`) и Enter — стаб печатает её эхом; указатель
    проходит по строкам экрана (`.xterm-screen`, DOM-рендер E2E); собранные события
    `pageerror` и ошибки `console` пусты. На коде до 5.3 тест красный: `WebLinksAddon`
    бросает `SyntaxError` на наведении, а неперехваченное исключение Playwright отдаёт
    событием `pageerror`, не `console`.

**Приёмка**
- [ ] Все тесты зелёные, E2E `terminal.spec.ts` зелёный.
- [ ] ⌘-клик по `src/a.ts:12` в выводе stub-агента открывает файл в приложении
      (ручная проверка).
- [ ] ⌘F показывает счётчик `N/M` и цвета совпадений (ручная проверка: моки jsdom
      декораций не видят).
- [ ] ⌘K в терминале очищает экран и палитру не открывает; вне терминала ⌘K открывает
      палитру (ручная проверка на macOS: меню видит только необработанное сочетание).

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
    `app.saveDropImage('clipboard')`, канал `app:save-drop-image` (источник — только
    `'clipboard'`), поле `saveDropImage` в `RegisterIpcOptions`;
  - `src/main/index.ts` — очистка `drops/` при старте; `saveDropImage` из `clipboard`
    и `saveImage`;
  - `renderer/terminal/TerminalSurface.tsx` и `TerminalSurface.test.tsx` — слушатель
    `paste` в фазе capture на корне поверхности; приём файлов (HTML5 `drop` с
    `dataTransfer.files`), рамка при наведении; оба — только при
    `useHostSupports('pty.send')`; отправка через `sendWithToast`;
  - `renderer/test-utils/fake-bridge.ts` — `pathForFile` (подставной путь по имени
    файла), `setSaveDropImage` (ниже, по умолчанию `null`) и журнал
    `saveDropImageCalls`;
  - `packages/desktop/e2e/stub-echo-agent.mjs` — режим `STUB_BRACKETED=1`;
  - `src/shared/strings.ts` — строки ниже.
- Документы: `README.md`, раздел «Окно» — ссылки, поиск, перетаскивание, скриншоты.

**Интерфейсы**

```ts
// main/drops.ts
export function dropsDir(home?: string): string;                  // ~/.harnas/desktop/drops
/**
 * PNG из картинки буфера: имя YYYYMMDD-HHMMSS-<4 hex>.png, open(…, 'wx', 0o600). Занятое имя (в том
 * числе симлинк) не перезаписывается: EEXIST — новое случайное имя. Пустая картинка → null.
 */
export async function saveImage(input: { png: Buffer | null; dir: string; now?: Date; random?: () => number }): Promise<string | null>;
/** Старше maxAgeMs — удалить: по lstat только обычные файлы и сами ссылки (цель ссылки цела), каталоги — нет. */
export async function cleanupDrops(dir: string, maxAgeMs: number, now?: number): Promise<number>; // 7 суток

// main/ipc.ts, RegisterIpcOptions — дополнение
/** Картинка буфера → drops/ (main/index.ts: clipboard и saveImage); null — картинки нет или в буфере есть текст. */
saveDropImage: () => Promise<string | null>;

// renderer/terminal/drop.ts
export function shellQuote(path: string): string;       // 'a b' → 'a b' в кавычках; ' внутри → '\''
export function pathsToInput(paths: string[]): string;  // через пробел, пробел в конце
/** В буфере вставки картинка и нет текста: clipboardData.items с image/* и без text/plain. */
export function pasteHasOnlyImage(data: DataTransfer): boolean;
/** Перетаскивают файлы: dataTransfer.types содержит 'Files'. */
export function dragHasFiles(data: DataTransfer): boolean;

// renderer/terminal/send.ts — SendResult и SendReason из @harnas/protocol (5.1)
export type SendOutcome = SendResult | { error: 'not_found' | 'failed'; message: string };
/** Отказ вызова разбирает decodeIpcError (E.1): код not_found → not_found, прочее → failed. */
export async function sendToAgent(bridge: HarnasBridge, ref: SessionRef, text: string, submit: boolean): Promise<SendOutcome>;
/** «Resume» уместна: status exited, done или failed и lifecycle не closed — как RESUMABLE меню сессии. */
export function canResume(session: WorkSession): boolean;
export interface SendToast { text: string; actions: Array<'copy' | 'open' | 'retry' | 'resume'>; error: boolean }
/** Таблица спеки 8.6; null — тоста нет: вставлено без Enter по просьбе (submit: false, reason: null). */
export function sendToast(outcome: SendOutcome, label: string, resumable: boolean): SendToast | null;
export interface SendWithToastDeps {
  bridge: HarnasBridge;
  /** Сессия из снимка работ (useWorksStore) — для canResume; null — её нет. */
  session(ref: SessionRef): WorkSession | null;
  /**
   * «Open S02»: applyFocusTarget({ kind: 'session', ref }, …) из 4.3 — работа, вкладка и фокус терминала;
   * зависимости — как у обработчика onFocusTarget в App.tsx.
   */
  openSession(ref: SessionRef): void;
}
/**
 * Одна отправка окна на 5.4, 8.x и 9.x: sendToAgent, тост sendToast через sonner (ярлык — sessionTag) и его
 * кнопки: Copy — исходный текст в буфер, Open — openSession, Retry — тот же вызов, Resume — sessions.resume.
 * Возвращает исход: 8.4 ставит по нему sentAt.
 */
export async function sendWithToast(deps: SendWithToastDeps, ref: SessionRef, text: string, submit: boolean): Promise<SendOutcome>;

// test-utils/fake-bridge.ts, дополнение к FakeBridge
/** Ответ app.saveDropImage: путь, null (картинки нет) или отказ — объект с code, как отказы подставного моста. */
setSaveDropImage(answer: string | null | IpcErrorInfo): void;
readonly saveDropImageCalls: Array<'clipboard'>;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл). session — sessionTag: 'S02'
send: {
  sent: (session: string) => string,               // 'Sent to S02'
  insertedDraft: (session: string) => string,      // 'Inserted into S02 without Enter — your draft is in the input'
  insertedInput: (session: string) => string,      // 'Inserted into S02 without Enter — you were typing in the terminal'
  insertedRestarted: (session: string) => string,  // 'Inserted into S02 without Enter — the session restarted'
  blocked: (session: string) => string,            // 'S02 is waiting for your answer — text not inserted'
  busy: (session: string) => string,               // 'S02 is busy with another message — retry in a second'
  noPasteMode: (session: string) => string,        // "S02 doesn't accept multi-line paste"
  notRunning: (session: string) => string,         // "S02 isn't running"
  openSession: (session: string) => string,        // 'Open S02'
},   // Copy — S.common.copy (5.3), Retry — S.common.retry, Resume — S.sidebar.sessionMenu.resume
errors: { actions: { saveScreenshot: 'save screenshot' } },   // отправка агенту — assignToAgent ('send to agent', E.1)
```

**Поведение**
- **Вставка** ловится событием `paste` в фазе capture на корне поверхности терминала
  (до textarea xterm), а не нажатием ⌘V: так пункт `Paste` меню терминала
  (`app.paste()`, 5.3) идёт тем же путём, а картинки видны в `clipboardData.items`.
  - `pasteHasOnlyImage` → `preventDefault()` и `stopPropagation()`. Одного
    `preventDefault` мало: xterm слушает `paste` на textarea и на корне терминала,
    `defaultPrevented` не смотрит и вставил бы пустой `getData('text/plain')` — при
    bracketed paste агент получил бы `ESC[200~ESC[201~` через `pty.input` вдобавок к
    пути;
  - затем `app.saveDropImage('clipboard')`. Путь есть —
    `sendWithToast(…, pathsToInput([path]), submit: false)`: путь в кавычках и с
    пробелом в конце, как у файлов — дом с пробелом вложение не ломает. Обычной
    вставки нет;
  - иначе событие не трогается: текст вставляет сама xterm (`term.paste`, bracketed
    paste — её забота). В буфере и картинка, и текст — вставляется текст;
  - `saveDropImage` отказал (`drops/` недоступна) — тост `errorText(code,
    S.errors.actions.saveScreenshot)`, вставки нет (спека 13); сообщение ошибки — в
    консоль;
  - main для надёжности тоже отдаёт `null`, если в буфере есть текст.
- **Файлы из Finder:**
  - `dragover` принимает бросок (`preventDefault`), только если `dragHasFiles`: иначе
    строка текста или ссылка из другого приложения тоже стала бы «файлом»;
  - `drop` на поверхность терминала → `app.pathForFile(file)` для каждого;
  - `pathsToInput` → `sendWithToast(…, submit: false)`: **без Enter**;
  - пустой путь (синтетический `File`) пропускается.
- **Хост без `pty.send`** (спека 3.2, 13): перехват вставки и приём файлов — только при
  `useHostSupports('pty.send')`. Без него вставка идёт в xterm как прежде, бросок не
  принимается, а файл, брошенный мимо, окно не уводит (`guardNavigation`).
- **Тосты** — `sendWithToast`, одна функция на 5.4, 8.x и 9.x: `sendToast` по таблице
  спеки 8.6, через `sonner`, ярлык — `sessionTag(ref.sessionId)`:
  - `null` — тоста нет: успех `submit: false` (`inserted: true`, `reason: null`) —
    главный случай перетаскивания и скриншота, путь и так виден в поле ввода;
  - кнопка `Copy` кладёт исходный текст в буфер;
  - `Open S02` — `applyFocusTarget({ kind: 'session', ref })` (4.3): работа, вкладка
    сессии и фокус терминала;
  - `Retry` — тот же вызов `sendWithToast`;
  - `Resume` — `sessions.resume`, только если `canResume`: `status` `exited`, `done` или
    `failed` (набор `RESUMABLE` меню сессии: `SessionRowMenu` 3.4, прежде
    `components/sidebar/SessionMenu.tsx:24`) и сессия не закрыта. У закрытой
    `sessions.resume` падает (`host/sessions/sessions-service.ts:160–162`), у активной
    без PTY хост поднял бы второй процесс;
  - ошибка вызова (`failed`) — тост `errorText('failed',
    S.errors.actions.assignToAgent)` («Couldn't send to agent: failed.»), без кнопок;
    сообщение — в консоль.
- **Stub-агент с `STUB_BRACKETED=1`:**
  - при старте печатает `ESC[?2004h`;
  - текст между `ESC[200~` и `ESC[201~` печатает как `PASTE<<текст>>` и держит в
    буфере строки;
  - Enter — `echo: <буфер>`, как сейчас.

**Тесты**
1. `saveImage`: PNG записан с правами 0600 и именем по шаблону; `png: null` → `null`
   без файла; имя занято (в том числе симлинком на файл вне `drops/`) → другое имя,
   цель ссылки не тронута.
2. `cleanupDrops`: файл старше 7 суток удалён, свежий на месте, вернулось 1; старый
   симлинк удалён сам, его цель цела; каталог не тронут.
3. `shellQuote("a b")` → `'a b'`; `shellQuote("it's")` → `'it'\''s'`; `pathsToInput`
   двух путей → `'…' '…' ` с пробелом в конце.
4. `sendToast` для каждой строки таблицы 8.6: английский текст и набор кнопок; успех
   `submit: false` → `null`; `not_found` при `resumable: false` — без `resume`.
5. Компонентный тест поверхности:
   - `drop` двух файлов с подставным `pathForFile` → один `pty.send` с
     `submit: false` и экранированными путями;
   - `dragover` без `Files` в `dataTransfer.types` — бросок не принят
     (`preventDefault` не вызван);
   - хост без `pty.send` (`setHostMethods` без него) — бросок не принят, вставка
     картинки не перехвачена.
6. Событие `paste`:
   - картинка без текста (`setSaveDropImage('/h/drops/a b.png')`) → `pty.send` с
     `'/h/drops/a b.png' `, `preventDefault`; слушатель `paste` на элементе внутри
     терминала не вызван, `pty.input` нет;
   - с текстом — событие не тронуто, `saveDropImageCalls` пуст;
   - `saveDropImage` отказал (`setSaveDropImage({ code: 'failed', message: 'm' })`) →
     тост `Couldn't save screenshot: failed.`, `pty.send` нет.
7. `sendToAgent`: отказ моста с `not_found` (`encodeIpcError`) → `{ error: 'not_found' }`;
   прочая ошибка → `failed`.
8. `sendWithToast`:
   - `blocked` → тост с `Copy` и `Open S02`: `Copy` кладёт исходный текст в буфер,
     `Open S02` зовёт `openSession(ref)`;
   - `busy` → `Retry` повторяет вызов (второй `pty.send`);
   - `not_found` у сессии `exited` → `Resume` зовёт `sessions.resume`; у закрытой
     кнопки `Resume` нет;
   - возвращает исход вызова.
9. `ipc`: `app:save-drop-image` с `'clipboard'` зовёт `saveDropImage`; другой источник —
   отказ.
10. **E2E `terminal-send.spec.ts`** (`STUB_BRACKETED=1`):
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
- [ ] `pty.send`, когда у сессии уже виден значок «ждёт тебя» (агент ждёт разрешения),
      ничего не вставляет — тост `… is waiting for your answer — text not inserted`.
      Окно до появления значка — остаточный риск спеки 8.6.
- [ ] ⌘-клик по `src/a.ts:12` открывает файл; ⌘F ищет по скроллбэку.
- [ ] `README.md`, раздел «Окно» — ссылки, поиск, перетаскивание, скриншоты.
