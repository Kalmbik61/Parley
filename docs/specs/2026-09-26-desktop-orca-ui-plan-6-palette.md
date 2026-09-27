# План, этап 6: палитра ⌘J и клавиши

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 9, строка 6 таблицы 14.3.

**Итог этапа:**
- все сочетания живут в одном реестре и ловятся одним обработчиком с учётом фокуса;
- системное меню строится из реестра;
- одна палитра ⌘J находит вкладки, работы, сессии, комнаты и действия;
- прежние палитры ⌘K и выбор сессии удалены.

**Перед стартом.** Сверить с кодом этапов 2–5 все места, которые сейчас ловят
клавиши:
- `layout/keys.ts` (временный из 2.4), `lib/keys.ts#shouldForwardToTerminal`;
- обработчик клавиш `use-terminal.ts` (⌘F, ⌘K) и ⌘K в `AppShell` (5.3);
- `main/menu.ts`, тип `MenuAction` в `shared/bridge.ts`, `emitMenu` в
  `test-utils/fake-bridge.ts`, `menu:action` в E2E;
- `components/palette/*`, `lib/commands.ts`, `lib/fuzzy.ts`;
- `layout/store.ts` — история и MRU как значения стора (`entries()`, `mru`), действия
  `back`, `forward`, `requestCloseTabs`.

---

## 6.1. Реестр клавиш и единый обработчик

**Зачем.** Одно место знает все сочетания. Monaco и страницы браузера получают свои
клавиши, окно — свои.
**Зависит от:** —. **Спека:** 9.6.

**Файлы**
- Создать:
  - `packages/desktop/src/shared/keybindings.ts` и тест;
  - `packages/desktop/src/renderer/keys/handler.ts` и тест;
  - `packages/desktop/src/renderer/keys/focus-context.ts` и тест;
  - `packages/desktop/src/main/guest-shortcuts.ts` и тест. Подключится к `<webview>`
    в 9.1.
- Изменить:
  - `packages/desktop/src/main/menu.ts` и тест — меню из реестра;
  - `src/shared/bridge.ts` — `MenuAction` заменяется на `ActionId`, канал
    `menu:action` прежний;
  - `src/preload/index.ts`, `renderer/App.tsx`, `renderer/shell/AppShell.tsx` —
    обработка `ActionId`; ⌘K в `AppShell` из 5.3 уходит в реестр;
  - `renderer/lib/keys.ts` и тест — правило терминала из спеки 9.6;
  - `renderer/terminal/use-terminal.ts` — ⌘F и ⌘K через реестр;
  - `renderer/test-utils/fake-bridge.ts` — `emitMenu(id: ActionId)`;
  - E2E `e2e/shell.spec.ts`, `e2e/layout.spec.ts` — в `menu:action` новые имена
    (таблица ниже).
- Удалить: `renderer/layout/keys.ts` и его тест.

**Интерфейсы**

```ts
// shared/keybindings.ts
export type MenuName = 'Harnas' | 'Правка' | 'Вид' | 'Работа' | 'Вкладка' | 'Терминал';
export type ActionId =
  | 'palette.open' | 'files.quickOpen' | 'files.search'
  | 'work.new' | 'session.new' | 'room.new'
  | 'work.goto.1' | 'work.goto.2' | 'work.goto.3' | 'work.goto.4' | 'work.goto.5'
  | 'work.goto.6' | 'work.goto.7' | 'work.goto.8' | 'work.goto.9'
  | 'work.prev' | 'work.next' | 'works.showArchived'
  | 'history.back' | 'history.forward'
  | 'sidebar.left.toggle' | 'sidebar.right.toggle' | 'sidebar.files' | 'sidebar.changes'
  | 'group.splitRight' | 'group.splitDown' | 'group.prev' | 'group.next'
  | 'tab.close' | 'tab.reopen' | 'tab.prev' | 'tab.next' | 'tab.mruNext' | 'tab.mruPrev'
  | 'tab.goto.1' | 'tab.goto.2' | 'tab.goto.3' | 'tab.goto.4' | 'tab.goto.5'
  | 'tab.goto.6' | 'tab.goto.7' | 'tab.goto.8' | 'tab.goto.9'
  | 'find' | 'terminal.clear' | 'settings.open'
  | 'attention.next' | 'wake.toggle' | 'host.restart'
  | 'appearance.system' | 'appearance.dark' | 'appearance.light'
  | 'browser.newTab'
  | 'browser.find' | 'browser.zoomIn' | 'browser.zoomOut' | 'browser.zoomReset';  // when: 'browser', menu: null
export interface ActionDef {
  id: ActionId;
  title: string;                 // для меню и палитры
  keywords: string[];            // для палитры
  keys: string | null;           // accelerator Electron: 'CmdOrCtrl+J', 'Control+Tab'…
  menu: MenuName | null;         // null — без пункта меню (⌃Tab, ⌃1–9, палитровые действия)
  when: 'always' | 'terminal' | 'editor' | 'browser';
}
export const ACTIONS: readonly ActionDef[];     // таблица спеки 9.6 целиком
export interface KeyLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
export function matchesAccelerator(accelerator: string, event: KeyLike): boolean;

// renderer/keys/focus-context.ts
export type FocusContext = 'terminal' | 'monaco' | 'input' | 'other';
export function focusContext(active: Element | null): FocusContext;   // по data-атрибутам и тегам

// renderer/keys/handler.ts
/** Что отдаётся полю, а что окну — таблица «Контекст фокуса» спеки 9.6. */
export function resolveAction(event: KeyLike, context: FocusContext, paletteOpen: boolean): ActionId | 'palette.row' | null;
export function installKeyHandler(input: {
  run(id: ActionId): void;
  pickPaletteRow(index: number): void;      // ⌘1–9 при открытой палитре
  context(): FocusContext;
  paletteOpen(): boolean;
  available(id: ActionId): boolean;         // действие реализовано и поддержано хостом
}): () => void;                             // keydown на window, capture-фаза

// main/menu.ts
export function buildMenuTemplate(send: (id: ActionId) => void): MenuItemConstructorOptions[];
// пункты реестра — { accelerator, registerAccelerator: false, click: () => send(id) };
// «Правка» — родные роли undo/redo/cut/copy/paste/selectAll с зарегистрированными сочетаниями.

// main/guest-shortcuts.ts
/** before-input-event гостя: сочетания с when 'always' и 'browser' гасятся в госте и уходят окну. */
export function forwardGuestShortcuts(contents: Pick<WebContents, 'on' | 'off'>, send: (id: ActionId) => void): () => void;
```

**Поведение**
- **Кто ловит.** Обработчик на `window` в capture-фазе, до xterm и Monaco. Совпало с
  реестром и действие доступно — `preventDefault`, `stopPropagation`, `run(id)`.
- **Контекст фокуса** (`focusContext`):
  - `terminal` — внутри `.xterm`;
  - `monaco` — внутри `.monaco-editor`;
  - `input` — `input`, `textarea` или `[contenteditable]`;
  - иначе `other`.
- **Что достаётся полю** — таблица спеки 9.6:
  - в `monaco` окну не отдаются ⌘D, ⌘K, ⌘F, ⌘S, ⌘/, а также ⌘[ и ⌘] (отступ), ⌘L
    (выделить строку), ⌘⇧↑ и ⌘⇧↓ (выделить до края). В реестре те же сочетания заняты
    `group.prev/next`, `sidebar.right.toggle`, `work.prev/next` — в редакторе они
    уступают;
  - в `input` — ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⌘⇧Z, ⌘←, ⌘→, ⌘⇧↑, ⌘⇧↓;
  - в `terminal` окну идут все ⌘-сочетания, а ⌘F и ⌘K — действия `find` и
    `terminal.clear` с `when: 'terminal'`;
  - ⌃Tab, ⌃⇧Tab, ⌃1–9 — окну в любом контексте, кроме `input`.
- **Раскладка.** `matchesAccelerator` сравнивает букву по `key` или по `code`: в русской
  раскладке ⌘J даёт `key: 'о'` при `code: 'KeyJ'`. `Plus` совпадает с `key` `+` и `=`
  (`code: 'Equal'`), Shift у него не проверяется.
- **⌘1–9 при открытой палитре** → `pickPaletteRow(index)`, а не `work.goto.N`.
- **Меню** строится `buildMenuTemplate`:
  - пункты показывают сочетание, но с `registerAccelerator: false`, чтобы macOS не
    перехватывал его раньше страницы;
  - клик по пункту шлёт `menu:action`.
- **Действия браузера** `browser.find` (⌘F), `browser.zoomIn` (⌘+), `browser.zoomOut`
  (⌘−), `browser.zoomReset` (⌘0) — `when: 'browser'`, без пункта меню. Рендерер их не
  ловит: фокус в странице, клавиши у гостя. Их пересылает `forwardGuestShortcuts` из
  main, в окно они приходят через `menu:action`.
- **Действия будущих этапов** (`files.*`, `sidebar.files`, `sidebar.changes`,
  `browser.*`) есть в реестре, но `available` возвращает для них `false`, пока нет
  реализации. Пункт меню у них есть и активен: клик шлёт `menu:action`, а рендерер
  ничего не делает, пока `available` ложно. Доступность в main не передаётся.
- **Прежние имена `menu:action`** меняются на `ActionId` одним коммитом с
  `fake-bridge.ts` и E2E:

| Было (`MenuAction`) | Стало (`ActionId`) |
|---|---|
| `new-session`, `new-work` | `session.new`, `work.new` |
| `close-panel`, `reopen-tab` | `tab.close`, `tab.reopen` |
| `split-right`, `split-down` | `group.splitRight`, `group.splitDown` |
| `prev-panel`, `next-panel` | `group.prev`, `group.next` |
| `palette`, `find`, `settings` | `palette.open`, `find`, `settings.open` |
| `toggle-left-sidebar` | `sidebar.left.toggle` |
| `history-back`, `history-forward` | `history.back`, `history.forward` |
| `work-1` … `work-9` | `work.goto.1` … `work.goto.9` |

**Тесты**
1. `ACTIONS`:
   - id уникальны;
   - у каждого сочетания разбор `matchesAccelerator` находит своё нажатие;
   - нет двух действий с одним сочетанием и пересекающимся `when`.
2. `matchesAccelerator`:
   - `'CmdOrCtrl+Shift+['` совпадает с `{ key: '{', metaKey, shiftKey }` (раскладка с
     Shift) и по `code: 'BracketLeft'`;
   - `'CmdOrCtrl+J'` совпадает с `{ key: 'о', code: 'KeyJ', metaKey }`;
   - `'CmdOrCtrl+Plus'` совпадает с `key: '='` и с `key: '+'` при Shift.
3. `resolveAction`, таблица:
   - ⌘D в `monaco` → `null`, в `other` → `group.splitRight`;
   - ⌘[ и ⌘L в `monaco` → `null`, ⌘[ в `other` → `group.prev`;
   - ⌘⇧↓ в `input` → `null`, в `other` → `work.next`;
   - ⌘J в `terminal` → `palette.open`;
   - ⌃C в `terminal` → `null`;
   - ⌃Tab в `terminal` → `tab.mruNext`, в `input` → `null`;
   - ⌘1 при открытой палитре → `palette.row`;
   - ⌘A в `input` → `null`;
   - ⌘0 в `other` → `null`: действия `browser.*` рендерер не ловит.
4. `installKeyHandler`: совпадение — `preventDefault` и `run`; недоступное действие —
   событие идёт дальше без изменений.
5. `buildMenuTemplate`:
   - у пунктов реестра `registerAccelerator: false`;
   - «Правка» — роли;
   - клик по пункту «Палитра» шлёт `palette.open`;
   - у действий `browser.*` пунктов нет.
6. `forwardGuestShortcuts`: ⌘J в госте → `preventDefault` у события и
   `send('palette.open')`; ⌘F → `browser.find`; ⌘= → `browser.zoomIn`; ⌘0 →
   `browser.zoomReset`; ⌘C — не трогается.
7. `shouldForwardToTerminal`: ⌘K → `false`; ⌃Tab → `false`; ⌃R → `true`.
8. E2E `shell.spec` и `layout.spec` зелёные с новыми именами в `menu:action`;
   `grep -rn "'split-right'\|'history-back'\|MenuAction" packages/desktop/src
   packages/desktop/e2e` пуст.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Все сочетания таблицы 9.6 видны в меню и работают из терминала, из сайдбара и
      из поля ввода по правилам контекста (ручная проверка).

---

## 6.2. Палитра ⌘J

**Зачем.** Всё открывается с клавиатуры за пару букв.
**Зависит от:** 6.1. **Спека:** 9.1–9.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/palette/`:
  - `score.ts` и тест;
  - `documents.ts` и тест;
  - `store.ts` и тест;
  - `Palette.tsx` и тест.
- Изменить:
  - `renderer/shell/Titlebar.tsx` — поле «Поиск» открывает `Palette`, подпись ⌘K
    (2.3) меняется на ⌘J;
  - `renderer/shell/Landing.tsx` — кнопка «Палитра» открывает `Palette`, подпись ⌘K
    (2.3) меняется на ⌘J;
  - `renderer/sidebar/WorkSidebar.tsx` — кнопка «Поиск» открывает `Palette`, подпись ⌘K
    (3.3) меняется на ⌘J;
  - `renderer/layout/TabStrip.tsx` — «+» открывает `Palette` в режиме «открыть»;
  - `renderer/shell/AppShell.tsx` — `group.splitRight` и `group.splitDown` открывают
    палитру в режиме «Открыть в новой группе»;
  - `renderer/layout/persistence.ts` и тест — `ensureHydrated`: вкладки работ, ещё не
    показанных за этот запуск;
  - `renderer/store/ui.ts` и тест — `dialogs.newWork.title`, второй аргумент
    `openNewWorkDialog`;
  - `renderer/sidebar/NewWorkComposer.tsx` и тест — начальное название из
    `dialogs.newWork.title`.
- Удалить в `packages/desktop/src/renderer/`: `components/palette/CommandPalette.tsx`,
  `components/palette/SessionPicker.tsx`, `lib/commands.ts`, `lib/fuzzy.ts` и их тесты.

**Интерфейсы**

```ts
// palette/score.ts
export function normalize(text: string): string;                    // нижний регистр, ё → е
export function scoreToken(token: string, field: string): number;   // 100/80/60/40/20/нечёткое 10−разрывы (не ниже 1), 0 — нет
export function scoreDocument(tokens: string[], doc: Pick<PaletteDoc, 'title' | 'fields'>): number | null;  // title × 1.5; null — токен не совпал
export function recencyBucket(ageMs: number | null): 0 | 1 | 2 | 3;  // <1ч, <1сут, <1нед, старше или нет данных

// palette/documents.ts
export type PaletteSection = 'tabs' | 'works' | 'sessions' | 'rooms' | 'actions' | 'files';
export const SECTION_LIMITS: Record<PaletteSection, number>;         // 5, 6, 8, 4, 6, 50
export interface PaletteDoc {
  id: string; section: PaletteSection;
  title: string; subtitle: string; fields: string[];
  recencyAt: number | null; order: number;
  state?: DotState;
  run(mode: 'default' | 'split'): void;
}
export function buildDocuments(input: {
  works: WorkEntry[]; activity: Record<string, ActivityEntry>;
  layouts: Record<string, WorkLayout>;
  /** useLayoutStore.getState().entries(): записи { workKey, tabId, at } (2.2). */
  history: readonly HistoryEntry[];
  actions: ActionDef[]; available(id: ActionId): boolean;
  providers: Array<{ id: string; label: string }>;
  mode: PaletteMode;
}): PaletteDoc[];
export interface RankedSection { section: PaletteSection; docs: PaletteDoc[]; more: number }
export function rankDocuments(query: string, docs: PaletteDoc[], now: number): RankedSection[];

// palette/store.ts
export type PaletteMode = 'default' | 'open' | 'split-right' | 'split-down' | 'files';
export interface PaletteState {
  open: boolean; mode: PaletteMode; query: string;
  openWith(mode: PaletteMode, query?: string): void;
  close(): void;
}

// layout/persistence.ts, дополнение
/** Гидрирует раскладки работ, ещё не показанных за этот запуск: путь первого показа (loadLayout → parse → prune → hydrate). */
export function ensureHydrated(input: { bridge: HarnasBridge; works: WorkEntry[] }): Promise<void>;

// store/ui.ts — dialogs.newWork (3.5) получает название
newWork: { open: boolean; projectPath: string | null; title: string };
openNewWorkDialog(projectPath?: string | null, title?: string): void;
```

**Поведение**
- **Документы** — таблица спеки 9.1:
  - вкладки всех работ (из `layouts`). В `layouts` лежат только показанные за этот
    запуск работы, поэтому палитра при открытии зовёт `ensureHydrated` для остальных:
    их вкладки появляются в секции, как только раскладки прочитаны;
  - работы, кроме архивных;
  - сессии, кроме закрытых;
  - комнаты;
  - действия реестра с `available`.
- **Свежесть** (спека 9.2, п. 5): у вкладки — самое позднее `at` её записей в `history`
  (`workKey` и `tabId`), у работ и сессий — `lastEventAt`.
- **Режимы:**
  - `split-right` и `split-down` — только сессии, комнаты и вкладки активной работы;
    выбор делает `splitGroup` активной группы;
  - `open` — без действий;
  - `files` — заготовка до 7.4.
- **Ранжирование** — алгоритм спеки 9.2. Секции упорядочены по лучшему документу.
  «ещё N» раскрывает секцию.
- **Вид** — спека 9.3, `ui/command` на cmdk с собственным ранжированием:
  `shouldFilter={false}`, список из `rankDocuments`.
  - Строки: значок или `AgentStateDot`, название, подпись, ⌘1…⌘9 у первых девяти.
  - Пустой запрос — шесть последних вкладок и четыре последние работы из `history`:
    свежие первыми, без повторов.
  - Нет совпадений — «Создать работу „<запрос>“» → `openNewWorkDialog(null, запрос)`:
    форма открывается с этим названием.
- **Клавиши:** ↑↓, Enter — `run('default')`, ⌘Enter — `run('split')`, Esc. ⌘1–9
  приходят из 6.1 как `pickPaletteRow`.
- **Закрытие** (спека 9.4): после `run` палитра закрывается. Действие, которое открывает
  свой диалог (форма работы, сессии, комнаты, настройки, подтверждение), закрывает её до
  открытия диалога — фокус уходит в диалог.

**Тесты**
1. `scoreToken`:
   - `'s02'` и `'S02'` → 100;
   - `'исп'` и `'исполнитель'` → 80;
   - `'ред'` и `'Редизайн окна'` → 80;
   - `'окн'` и `'Редизайн окна'` → 60;
   - `'api'` и `'room-api-review'` → 40;
   - `'ё'` и `'ещё'` совпадает, как `'е'`;
   - `'xyz'` и `'Редизайн окна'` → 0;
   - `'sprt'` и `'sprint'` — нечёткое совпадение, очки от 1 до 10.
2. `scoreDocument`: токен не совпал ни с одним полем → `null`; совпадение по
   названию весит больше, чем по подписи.
3. `recencyBucket`: 30 мин → 0, 5 ч → 1, 3 сут → 2, 30 сут и `null` → 3.
4. `rankDocuments`: при равных очках свежее выше; секция с лучшим документом первая;
   лимит секции и `more` верны.
5. `buildDocuments`:
   - архивная работа и закрытая сессия отсутствуют; действие с `available: false`
     отсутствует; в режиме `split-right` нет действий и чужих работ;
   - вкладка с записью истории `at` час назад — `recencyAt` этой записи; вкладка без
     записей — `null`.
6. `Palette`:
   - ввод `S02` — первая строка — сессия;
   - Enter открывает её вкладку, палитра закрыта;
   - ⌘Enter — в новой группе справа;
   - пустой результат — строка «Создать работу „…“» открывает форму с названием из
     запроса;
   - ⌘2 (через `pickPaletteRow(1)`) выбирает вторую строку.
7. `ensureHydrated`: работа, не показанная за запуск, → один `loadLayout`, её вкладки в
   документах палитры; уже гидрированная — без вызова.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Удалённые файлы не упоминаются в коде (`grep -rn "CommandPalette\|SessionPicker\|fuzzyScore" packages/desktop/src` пуст).

---

## 6.3. Действия палитры; приёмка этапа 6

**Зачем.** Каждое действие реестра делает ровно то, что написано.
**Зависит от:** 6.2. **Спека:** 7.6, 9.4, 9.6.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/palette/actions.ts` и тест;
  - `packages/desktop/e2e/palette.spec.ts`.
- Изменить:
  - `renderer/shell/AppShell.tsx` — `run(id)` из 6.1 зовёт `runAction` с контекстом;
  - `renderer/store/ui.ts` и тест — `showArchived` и `toggleShowArchived` (в памяти
    окна, не в `ui.json`), `confirmRestartHost`;
  - `renderer/sidebar/sort.ts` и тест — `buildSections` получает `showArchived`;
  - `renderer/sidebar/use-sidebar-sections.ts` — передаёт его из `store/ui.ts`;
  - `renderer/shell/StatusBar.tsx` — подтверждение перезапуска хоста (3.1) открывается
    через `confirmRestartHost`, тем же путём, что из палитры.
- Документы: `README.md`, раздел «Окно» — таблица клавиш 9.6 целиком.

**Интерфейсы**

```ts
// palette/actions.ts
export interface ActionContext {
  bridge: HarnasBridge;
  /**
   * useLayoutStore.getState() на момент действия. История и MRU — значения стора (2.2):
   * entries() и mru[activeWorkKey]; переходы — его действия back и forward.
   */
  layout: Pick<LayoutState, 'activeWorkKey' | 'layouts' | 'mru' | 'entries' | 'apply'
    | 'setActiveWork' | 'back' | 'forward' | 'requestCloseTabs'>;
  /** Видимый порядок работ: visibleWorkOrder(useSidebarSections()) (3.4). */
  sidebar: { order(): string[] };
  ui: {
    toggleSidebar(side: 'left' | 'right'): void;
    openNewWork(title?: string): void;          // openNewWorkDialog(null, title)
    openNewSession(): void;                     // диалог новой сессии активной работы
    openNewRoom(): void;                        // CreateRoomDialog без участника (3.4)
    openSettings(): void;
    setAppearance(mode: Appearance): void;      // store/ui.ts: app.setAppearance, ui.json пишет main
    toggleShowArchived(): void;
    confirmRestartHost(): void;                 // ConfirmDialog 3.1 → app.restartHost()
  };
  palette: Pick<PaletteState, 'openWith' | 'close'>;
  /** Терминал с фокусом ввода, иначе терминал активной вкладки активной группы. */
  terminals: { focused(): TerminalSurfaceHandle | null };
  attention: { next(): SessionRef | null };
  toast(text: string): void;
}
export function runAction(id: ActionId, ctx: ActionContext): void;

// sidebar/sort.ts, дополнение входа buildSections
showArchived: boolean;   // false — archived скрыты, как в 3.2
```

**Поведение**
- **Одна ветка на каждый `ActionId`.** Действия, требующие активной работы (`session.new`,
  `room.new`, `group.*`, `tab.*`), без активной работы показывают тост «Нет активной
  работы».
- **Контекст читается в момент действия.** `ctx.layout` — `useLayoutStore.getState()`,
  а не снимок при монтировании: история и MRU — значения стора, объектов с методами у
  них нет.
  - `history.back` и `history.forward` → `layout.back()` и `layout.forward()`;
  - `tab.mruNext` и `tab.mruPrev` → `apply(focusTab(…))` соседа активной вкладки по
    `mru[activeWorkKey]`;
  - `tab.close` → `requestCloseTabs(activeWorkKey, [активная вкладка])` — с 7.3 он
    спросит про несохранённый файл.
- **Особые действия:**
  - `host.restart` — `ui.confirmRestartHost()`: то же подтверждение, что у строки
    статуса (3.1), `app.restartHost()` — только после «Да»;
  - `appearance.*` — `ui.setAppearance(mode)` стора `store/ui.ts`: он зовёт
    `app.setAppearance`, а `ui.json` пишет main (1.1). `app.saveUi` напрямую не зовётся;
  - `works.showArchived` — переключатель `showArchived` в памяти окна, до перезапуска.
    `buildSections` при нём показывает архивные работы в конце своей группы проекта,
    приглушёнными, как `done`. Раньше 3.2 скрывал их всегда;
  - `find` и `terminal.clear` — `terminals.focused()?.openSearch()` и `?.clear()`;
    терминала нет — ничего;
  - `attention.next` — из 4.2;
  - `work.new` — `ui.openNewWork()`, «Создать работу „…“» из 6.2 — с названием.
- **Действия будущих этапов** (`files.*`, `sidebar.files`, `sidebar.changes`,
  `sidebar.right.toggle`, `browser.*`) получают ветки в 7.2, 7.4, 8.2 и 9.2. До этого
  `available` ложно, и `runAction` их не зовёт.

**Тесты**
1. `runAction` для каждого `ActionId` из списка доступных зовёт ожидаемую функцию
   контекста: таблица тестов по реестру, один случай на действие.
2. `tab.close` без активной работы — тост, `requestCloseTabs` не вызван; с активной —
   вызван с id активной вкладки.
3. Контекст свежий: после `apply(openTab)` в тесте `tab.mruNext` фокусирует вкладку по
   новому `mru`; `history.back` зовёт `layout.back()`.
4. `appearance.dark` → `ui.setAppearance('dark')`, `app.saveUi` не вызван.
5. `find` и `terminal.clear` зовут `openSearch()` и `clear()` у `terminals.focused()`;
   `focused()` вернул `null` — без ошибки.
6. `works.showArchived`: архивная работа появилась в конце своей секции; второй вызов
   прячет её снова. `buildSections` с `showArchived: false` — как в 3.2.
7. `host.restart` открывает подтверждение; `app.restartHost` — только после «Да».
8. **E2E `palette.spec.ts`:**
   - две работы, три сессии;
   - ⌘J (нажатие клавиш — обработчик в рендерере, меню больше не перехватывает) и
     ввод `исп` → первая строка `S02 исполнитель`;
   - Enter — её вкладка активна.
9. **E2E:** ⌘J, ввод `S0`, ⌘2 — открыта вкладка второй строки списка, а не вторая
   работа сайдбара (спека 14.3).
10. **E2E:** пустой результат по `нетакойработы` → Enter открывает форму новой работы с
    названием `нетакойработы`.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 6** (человек, на пересобранном `harnas.app`)
- [ ] Любая сессия открывается ⌘J и 2–4 буквами ярлыка.
- [ ] Сочетания таблицы 9.6 работают и видны в меню; ⌘D в будущем редакторе не
      мешает (проверяется в этапе 7).
- [ ] `README.md` — таблица клавиш.
