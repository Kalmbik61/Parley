# План, этап 6: палитра ⌘J и клавиши

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 9, строка 6 таблицы 14.3.

**Итог этапа:**
- все сочетания живут в одном реестре и ловятся одним обработчиком с учётом фокуса;
- системное меню строится из реестра;
- одна палитра ⌘J находит вкладки, работы, сессии, комнаты и действия;
- прежние палитры ⌘K и выбор сессии удалены.

**Перед стартом.** Сверить с кодом этапов 2–5 все места, которые сейчас ловят клавиши
или открывают палитру:
- `layout/keys.ts` (временный из 2.4, исход `work-step` — 3.4) и обработчик
  `keydown`/`keyup`/`blur` в `layout/LayoutView.tsx`: цикл ⌃Tab по снимку MRU (раунд
  исправлений 1 куска 2.4), ⌃1–9, ⌘⇧[ и ⌘⇧], ветка `tab-step` (3.4);
- `keydown` `work-step` (⌘⇧↑↓) в `shell/AppShell.tsx` (3.4), `onMenu` в `AppShell.tsx` и
  в `App.tsx` (`settings`, `new-session`);
- ветки ⌘K и ⌘F в `terminal/use-terminal.ts`, `onFind` в `UseTerminalOptions` и
  `TerminalSurface.tsx` (5.3); `lib/keys.ts#shouldForwardToTerminal`;
- `main/menu.ts` (`createAppMenu`, подписи из `S.menu`), тип `MenuAction` в
  `shared/bridge.ts`, `emitMenu` в `test-utils/fake-bridge.ts`, старые имена в тестах
  (`App.test.tsx`, `AppShell.test.tsx`, `TerminalSurface.test.tsx`) и `menu:action` в E2E;
- `components/palette/*`, `lib/commands.ts`, `lib/fuzzy.ts` и все, кто открывает выбор
  сессии: `layout/Tab.tsx`, `terminal/TerminalContextMenu.tsx` (5.3), `layout/TabStrip.tsx`
  (`openSessionIds`), `store/ui.ts` (`paletteOpen`, `picker`);
- `layout/store.ts` — история и MRU как значения стора (`entries()`, `mru`), действия
  `back`, `forward`, `requestCloseTabs`; `layout/persistence.ts` — `hydrateWork` и пометка
  «грязной первой гидрации»;
- `sidebar/use-sidebar-sections.ts` — `useSidebarSectionsStore` (писатель — дочерний
  компонент `AppShell`, решение по куску 3.3) и `sidebar/sort.ts` — `buildSections`,
  `visibleWorkOrder`: порядок работ обработчики берут через `getState()` стора секций;
- `lib/capabilities.ts` (`hostMethods`), `store/host.ts` (`useHostStore`);
  `attention/store.ts`, `attention/next.ts` (4.2); `shell/StatusBar.tsx` — подтверждение
  перезапуска хоста; `sidebar/CardMenu.tsx` — `Reopen` у архивной (3.4);
- `shared/strings.ts` — `S.menu` (его же читают `Tab.tsx` и меню терминала 5.3),
  `S.palette`, `S.picker`; страж `english-ui.test.ts`.

**Строки интерфейса** — правило индекса («Сквозные ограничения», кусок E.1):
- русские строки интерфейса в «…» ниже — смысл, а не текст. Текст — английский, ключом
  `S` в `packages/desktop/src/shared/strings.ts`: ключ и английский стоят в «Интерфейсах»
  куска. Кусок, который добавляет строки, вносит `shared/strings.ts` в «Изменить»;
- названия меню — `S.menu` (`Edit`, `View`, `Workspace`, `Tab`, `Terminal`; меню `app` —
  `Harnas`, как сейчас), заголовки действий — `S.actions`, `keywords` реестра —
  английские;
- тесты ждут английский текст. Литерал `ё` в `palette/score.ts` — с пометкой
  `// cyrillic-ok: ё = е (спека 9.2)`, иначе страж `english-ui` его не пропустит;
- ошибку хоста или main окно показывает как `errorText(decodeIpcError(err).code,
  S.errors.actions.<действие>)`. Текст хоста — только в консоль;
- название работы, ярлык сессии, заголовок вкладки и запрос палитры — данные, а не
  строки интерфейса: идут как есть.

**Два куска вместо 6.1.** 6.1 перерос «1–2 задачи» и разрезан (сверка этапа 6): 6.1a —
чистые модули и их тесты, ничего не подключает; 6.1b — подключение: меню, мост,
`AppShell`, `LayoutView`, терминал, подписи ⌘J, E2E.

---

## 6.1a. Реестр клавиш, контекст фокуса, обработчик — чистые модули

**Зачем.** Одно место знает все сочетания и правила фокуса. Модули чистые и
проверяются без окна; подключает их 6.1b.
**Зависит от:** —. **Спека:** 9.6.

**Файлы**
- Создать:
  - `packages/desktop/src/shared/keybindings.ts` и тест;
  - `packages/desktop/src/renderer/keys/focus-context.ts` и тест;
  - `packages/desktop/src/renderer/keys/handler.ts` и тест;
  - `packages/desktop/src/renderer/keys/mru-cycle.ts` и тест — цикл ⌃Tab из
    `layout/LayoutView.tsx` (раунд исправлений 1 куска 2.4) как есть;
  - `packages/desktop/src/main/guest-shortcuts.ts` и тест. Подключится к `<webview>`
    в 9.1.
- Изменить: `packages/desktop/src/shared/strings.ts` — `S.actions` и названия меню
  (ниже). Только дополнения: прежние ключи `S.menu` и `S.palette` ещё читают
  `main/menu.ts`, `layout/Tab.tsx`, `CommandPalette` и `lib/commands.ts`.
- Меню, `AppShell`, `LayoutView` и `use-terminal` кусок не трогает — это 6.1b.

**Интерфейсы**

```ts
// shared/keybindings.ts
/** Системные меню; подписи — S.menu.edit/view/workspace/tab/terminal, у app — «Harnas», как сейчас. */
export type MenuName = 'app' | 'edit' | 'view' | 'workspace' | 'tab' | 'terminal';
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
  title: string;                 // из S.actions: для меню и палитры
  keywords: string[];            // для палитры, английские
  keys: string | null;           // accelerator Electron: 'CmdOrCtrl+J', 'Control+Tab'…
  menu: MenuName | null;         // null — без пункта меню (⌃Tab, ⌃1–9, палитровые действия)
  when: 'always' | 'terminal' | 'editor' | 'browser';
  inPalette: boolean;            // false — служебное: palette.open, work.goto.N, tab.goto.N, tab.mruNext/Prev
}
export const ACTIONS: readonly ActionDef[];     // таблица спеки 9.6 целиком
export interface KeyLike {
  key: string; code: string;
  metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean;
  isComposing: boolean;          // набор IME: такое нажатие окну не достаётся
}
export function matchesAccelerator(accelerator: string, event: KeyLike): boolean;

// renderer/keys/focus-context.ts
export type FocusContext = 'dialog' | 'terminal' | 'monaco' | 'input' | 'other';
export function focusContext(active: Element | null): FocusContext;   // по ролям, data-атрибутам и тегам

// renderer/keys/handler.ts
export type ResolvedKey = ActionId | { kind: 'palette.row'; index: number };   // index 0–8 — ⌘1–9
/** Что отдаётся полю, а что окну — таблица «Контекст фокуса» спеки 9.6. null — не окну. */
export function resolveAction(event: KeyLike, context: FocusContext, paletteOpen: boolean): ResolvedKey | null;
export function installKeyHandler(input: {
  run(id: ActionId): void;
  pickPaletteRow(index: number): void;      // ⌘1–9 при открытой палитре
  context(): FocusContext;
  paletteOpen(): boolean;
  available(id: ActionId): boolean;         // действие реализовано и поддержано хостом (6.1b)
  endMruCycle(): void;                      // keyup Control и blur окна — конец цикла ⌃Tab
}): () => void;                             // keydown на window в capture-фазе, keyup и blur

// renderer/keys/mru-cycle.ts
export interface MruCycle {
  /**
   * ⌃Tab (1) или ⌃⇧Tab (−1). Первый шаг снимает снимок mru работы, следующие идут по снимку.
   * Возвращает вкладку для focusTab; null — в снимке меньше двух записей.
   */
  step(workKey: string, mru: readonly string[], step: 1 | -1): string | null;
  /**
   * Конец цикла: новый mru работы — снятая вкладка первой, остальные снимка следом.
   * null — цикла не было или он шёл в другой работе: снимок отбрасывается без записи.
   */
  commit(activeWorkKey: string | null): { workKey: string; mru: string[] } | null;
}
export function createMruCycle(): MruCycle;

// main/guest-shortcuts.ts
/**
 * before-input-event гостя: Input Electron → KeyLike, только keyDown. Сочетания с when 'always' и
 * 'browser' гасятся в госте и уходят окну; ⌘⇧↑↓ остаются странице.
 */
export function forwardGuestShortcuts(contents: Pick<WebContents, 'on' | 'off'>, send: (id: ActionId) => void): () => void;

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
menu: { workspace: 'Workspace', tab: 'Tab', terminal: 'Terminal' },   // edit 'Edit' и view 'View' уже есть
actions: {
  commandPalette: 'Command palette', goToFile: 'Go to file', findInFiles: 'Find in files',
  newWorkspace: 'New workspace', newSession: 'New session', newRoom: 'New room',
  workspaceNumber: (n: number) => string,              // 'Workspace 2'
  previousWorkspace: 'Previous workspace', nextWorkspace: 'Next workspace',
  showArchivedWorkspaces: 'Show archived workspaces',
  back: 'Back', forward: 'Forward',
  toggleWorkspaceSidebar: 'Toggle workspace sidebar', toggleRightSidebar: 'Toggle right sidebar',
  showFiles: 'Show files', showChanges: 'Show changes',
  splitRight: 'Split right', splitDown: 'Split down',
  previousGroup: 'Previous group', nextGroup: 'Next group',
  closeTab: 'Close tab', reopenClosedTab: 'Reopen closed tab',
  previousTab: 'Previous tab', nextTab: 'Next tab',
  nextRecentTab: 'Next recent tab', previousRecentTab: 'Previous recent tab',
  tabNumber: (n: number) => string,                    // 'Tab 3'
  find: 'Find', clearTerminal: 'Clear terminal', settings: 'Settings',
  nextNeedsYou: 'Next session that needs you',
  pauseAutoWake: 'Pause auto-wake', resumeAutoWake: 'Resume auto-wake',   // реестр — pause; палитра — по wakePaused (6.2)
  restartHost: 'Restart host…',
  themeSystem: 'Theme: system', themeDark: 'Theme: dark', themeLight: 'Theme: light',
  newBrowserTab: 'New browser tab', findInPage: 'Find in page',
  zoomIn: 'Zoom in', zoomOut: 'Zoom out', actualSize: 'Actual size',
},
```

**Поведение**
- **Реестр** — таблица спеки 9.6 целиком. Столбец «Меню» переходит в `MenuName`:
  Harnas → `app`, Правка → `edit`, Вид → `view`, Работа → `workspace`, Вкладка → `tab`,
  Терминал → `terminal`; «—» и «палитра» → `null`. Действия без сочетания
  (`works.showArchived`, `room.new`, `attention.next`, `wake.toggle`, `host.restart`,
  `appearance.*`) — `keys: null`, `menu: null`, только палитра.
- **Кто ловит.** `installKeyHandler` вешает на `window` `keydown` в capture-фазе, до
  xterm и Monaco, а также `keyup` и `blur`.
  - Совпало с реестром по контексту и действие доступно — `preventDefault`,
    `stopPropagation`, `run(id)`.
  - `palette.row` — так же `preventDefault` и `stopPropagation`, затем
    `pickPaletteRow(index)`.
  - Гасится всё, что обработчик выполнил. На macOS ⌘-сочетание сначала получает
    страница, а пункт меню — только необработанное (спека 9.6): выполненное и
    непогашенное сработало бы второй раз пунктом меню.
  - `null` или недоступное действие — событие идёт дальше без изменений.
  - `keyup` клавиши `Control` и `blur` окна — `endMruCycle()`.
- **Контекст фокуса** (`focusContext`), проверки по порядку:
  - `dialog` — внутри `[role="dialog"]` или `[role="alertdialog"]`, кроме палитры
    (`[data-palette]`, 6.2): открыт модальный диалог — форма, подтверждение, настройки;
  - `terminal` — внутри `.xterm`. Фокус xterm — `textarea.xterm-helper-textarea`,
    поэтому `.xterm` проверяется раньше полей;
  - `monaco` — внутри `.monaco-editor`;
  - `input` — `textarea`, `input` текстового типа (`text`, `search`, `url`, `email`,
    `password`, `number`, `tel`, без `type`) или элемент с `isContentEditable`.
    `contenteditable="false"`, флажок и кнопка — не поле;
  - иначе `other`.
- **Что достаётся полю** — таблица спеки 9.6:
  - в `dialog` — всё: сочетания окна за модальным диалогом не действуют. ⌘W не
    закрывает вкладку под формой, ⌘T не открывает второй диалог, ⌘1–9 не меняют работу;
    Esc закрывает сам диалог;
  - в `monaco` окну не отдаются ⌘D, ⌘K, ⌘F, ⌘S, ⌘/, а также ⌘[ и ⌘] (отступ), ⌘L
    (выделить строку), ⌘⇧↑ и ⌘⇧↓ (выделить до края). В реестре те же сочетания заняты
    `group.prev/next`, `sidebar.right.toggle`, `work.prev/next` — в редакторе они
    уступают;
  - в `input` — ⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⌘⇧Z, ⌘←, ⌘→, ⌘⇧↑, ⌘⇧↓;
  - в `terminal` окну идут все ⌘-сочетания реестра, в том числе ⌘⇧↑↓ (`work.prev/next`,
    как в 3.4), а ⌘F и ⌘K — действия `find` и `terminal.clear` с `when: 'terminal'`;
  - ⌃Tab, ⌃⇧Tab, ⌃1–9 — окну в любом контексте, кроме `input` и `dialog`;
  - `isComposing` (набор IME) — `null` в любом контексте.
- **⌘1–9 при открытой палитре** → `{ kind: 'palette.row', index }`, а не `work.goto.N`.
- **Раскладка.** `matchesAccelerator` сравнивает букву по `key` или по `code`: в русской
  раскладке ⌘J даёт `key: 'о'` при `code: 'KeyJ'`. `Plus` совпадает с `key` `+` и `=`
  (`code: 'Equal'`), Shift у него не проверяется.
- **Цикл ⌃Tab** (`mru-cycle.ts`) — поведение 2.4 без изменений:
  - первое нажатие снимает снимок `mru[workKey]`, повторные идут по снимку. Живой `mru`
    переставляет каждый `apply(focusTab)` (`layout/store.ts#updateMru`), и без снимка
    при MRU [C, B, A] второй ⌃Tab вернул бы C, до A не дойти;
  - `commit` — снятая вкладка первой, остальные снимка следом в прежнем порядке;
  - снимок другой работы (активную сменили посреди удержания ⌃) отбрасывается без
    записи; меньше двух записей — цикла нет.
- **Гость** (`forwardGuestShortcuts`) — `before-input-event` страницы `<webview>`:
  - `Input` Electron переводится в `KeyLike`: `meta`, `control`, `alt`, `shift` →
    `metaKey`, `ctrlKey`, `altKey`, `shiftKey`. Только `type: 'keyDown'`; при
    `isComposing` — ничего;
  - сочетания с `when: 'always'` и `'browser'` гасятся в госте (`event.preventDefault()`)
    и уходят `send(id)`;
  - ⌘⇧↑↓ не пересылаются: таблица 9.6 отдаёт их полю ввода, а main не знает, в поле ли
    фокус страницы;
  - ⌘C и прочие роли «Правки» не трогаются.
- **Действия браузера** `browser.find` (⌘F), `browser.zoomIn` (⌘+), `browser.zoomOut`
  (⌘−), `browser.zoomReset` (⌘0) — `when: 'browser'`, без пункта меню. Рендерер их не
  ловит: фокус в странице, клавиши у гостя. Их пересылает `forwardGuestShortcuts` из
  main, в окно они приходят через `menu:action`.

**Тесты**
1. `ACTIONS`:
   - id уникальны;
   - у каждого сочетания разбор `matchesAccelerator` находит своё нажатие;
   - нет двух действий с одним сочетанием и пересекающимся `when`;
   - у каждого действия непустой `title` из `S.actions`, кириллицы нет;
   - `inPalette: false` ровно у `palette.open`, `work.goto.N`, `tab.goto.N`,
     `tab.mruNext`, `tab.mruPrev`.
2. `matchesAccelerator`:
   - `'CmdOrCtrl+Shift+['` совпадает с `{ key: '{', metaKey, shiftKey }` (раскладка с
     Shift) и по `code: 'BracketLeft'`;
   - `'CmdOrCtrl+J'` совпадает с `{ key: 'о', code: 'KeyJ', metaKey }`;
   - `'CmdOrCtrl+Plus'` совпадает с `key: '='` и с `key: '+'` при Shift.
3. `focusContext`:
   - `textarea.xterm-helper-textarea` внутри `.xterm` → `terminal`;
   - `input type="text"` и `[contenteditable="true"]` → `input`; `input type="checkbox"`,
     кнопка и `[contenteditable="false"]` → `other`;
   - поле внутри `[role="dialog"]` → `dialog`; поле внутри `[data-palette]` того же
     диалога → `input`.
4. `resolveAction`, таблица:
   - ⌘D в `monaco` → `null`, в `other` → `group.splitRight`;
   - ⌘[ и ⌘L в `monaco` → `null`, ⌘[ в `other` → `group.prev`;
   - ⌘⇧↓ в `input` → `null`, в `other` и в `terminal` → `work.next` (тест 11 куска 3.4);
   - ⌘J в `terminal` → `palette.open`;
   - ⌘K в `terminal` → `terminal.clear`, в `other` и в `input` → `null`;
   - ⌃C в `terminal` → `null`;
   - ⌃Tab в `terminal` → `tab.mruNext`, в `input` → `null`;
   - ⌘1 при открытой палитре → `{ kind: 'palette.row', index: 0 }`;
   - ⌘A в `input` → `null`;
   - ⌘0 в `other` → `null`: действия `browser.*` рендерер не ловит;
   - ⌘W, ⌘T, ⌘1 и ⌃Tab в `dialog` → `null`;
   - ⌘J с `isComposing: true` → `null`.
5. `installKeyHandler`:
   - совпадение — `defaultPrevented` и `run(id)`; `palette.row` — `defaultPrevented` и
     `pickPaletteRow(0)`, `run` не вызван;
   - `null` и недоступное действие — событие идёт дальше, `defaultPrevented` ложно;
   - ⌘K при контексте `terminal` → `run('terminal.clear')`, `defaultPrevented`, а
     слушатель `keydown` на самом поле xterm события не получил: агенту ничего не уходит
     (тест 10 куска 5.3, перенос);
   - `keyup` клавиши `Control` и `blur` окна зовут `endMruCycle`, `keyup` другой клавиши —
     нет;
   - отписка снимает все три слушателя.
6. `createMruCycle` (перенос тестов «⌃ удержан…» и «потеря фокуса…» `LayoutView.test.tsx`):
   - MRU [C, B, A], два шага вперёд — B, затем A, а не снова C; `commit` → [A, C, B];
   - шаг назад с начала снимка — последняя запись;
   - шаги в работе W1, `commit('W2')` → `null`;
   - одна запись — `step` → `null`.
7. `forwardGuestShortcuts`:
   - ⌘J в госте (`{ type: 'keyDown', key: 'j', meta: true }`) → `preventDefault` у
     события и `send('palette.open')`; ⌘F → `browser.find`; ⌘= → `browser.zoomIn`; ⌘0 →
     `browser.zoomReset`;
   - то же с `type: 'keyUp'` или с `isComposing: true` — не трогается;
   - ⌘C и ⌘⇧↓ — не трогаются;
   - отписка зовёт `off`.

**Приёмка**
- [ ] Все тесты зелёные, страж `english-ui` зелёный.

---

## 6.1b. Меню из реестра и подключение обработчика

**Зачем.** Сочетаниями владеет один обработчик: меню и прежние обработчики `LayoutView`,
`AppShell`, `App` и терминала уходят в него.
**Зависит от:** 6.1a. **Спека:** 9.6.

**Файлы**
- Создать: `packages/desktop/src/main/menu.test.ts` — теста меню пока нет.
- Изменить:
  - `src/main/menu.ts` — `buildMenuTemplate(send)` из реестра, `createAppMenu` строит
    меню им;
  - `src/shared/bridge.ts` — `MenuAction` заменяется на `ActionId`, канал `menu:action`
    прежний; `src/preload/index.ts` — тот же тип;
  - `renderer/test-utils/fake-bridge.ts` — `emitMenu(id: ActionId)`;
  - `renderer/keys/handler.ts` и тест — `isActionAvailable` и набор реализованных
    действий (ниже);
  - `renderer/shell/AppShell.tsx` и `AppShell.test.tsx` — одна точка `run(id)`: её зовут
    `onMenu` и `installKeyHandler`. Ветки прежнего `onMenu` и `keydown` `work-step` (3.4)
    уходят в `run`. Все вызовы `emitMenu` в тестах получают новые имена (на `0dad07b` их
    11: `new-work`, `palette`, `toggle-left-sidebar`, `split-right`, `work-2`,
    `history-back`, `history-forward` и прежнее `find`; 3.4 добавит свои); тесты ниже;
  - `renderer/App.tsx` и `App.test.tsx` — без своего `onMenu`: `settings.open` и
    `session.new` — ветки `run` в `AppShell`. В `App.test.tsx` оба
    `emitMenu('new-session')` → `emitMenu('session.new')`;
  - `renderer/layout/LayoutView.tsx` и `LayoutView.test.tsx` — без обработчика
    `keydown`/`keyup`/`blur` (⌃Tab, ⌃1–9, ⌘⇧[ ], ветка `tab-step` 3.4). Проп `active`
    остаётся только для портала строки вкладок. Тесты «⌃ удержан…» и «потеря фокуса…»
    переезжают в `keys/mru-cycle.test.ts` (6.1a) и `AppShell.test.tsx`; из теста
    «active: false» уходит часть про клавиши (её держит тест 6 ниже), портал остаётся;
  - `renderer/terminal/use-terminal.ts` и `use-terminal.test.ts` — без веток ⌘K и ⌘F
    (5.3) в `attachCustomKeyEventHandler` и без `onFind` в `UseTerminalOptions`.
    Обработчик окна в capture-фазе со `stopPropagation` эти сочетания до xterm не
    пускает, ветки не вызывались бы. Тест 10 куска 5.3 переезжает в
    `keys/handler.test.ts` (6.1a) и `AppShell.test.tsx`;
  - `renderer/terminal/TerminalSurface.tsx` и `TerminalSurface.test.tsx` — без `onFind`;
    в тесте `emitMenu('find')` — имя прежнее, тип новый;
  - `renderer/lib/keys.ts` и `lib/keys.test.ts` — только комментарии: ссылка на
    `layout/keys.ts` → `keys/handler.ts`. Правило 9.6 код уже держит;
  - `renderer/layout/TabStrip.tsx` — комментарий про `layout/keys.ts`;
  - подписи палитры ⌘K → ⌘J — в том же коммите, где реестр переводит палитру на ⌘J, а ⌘K
    становится «Clear terminal»: `renderer/shell/Titlebar.tsx` и `Titlebar.test.tsx`,
    `renderer/shell/Landing.tsx`, `renderer/sidebar/WorkSidebar.tsx` и
    `WorkSidebar.test.tsx`, тест подписи в `AppShell.test.tsx`. Кнопки пока открывают
    прежнюю палитру, на `Palette` их переводит 6.2;
  - `shared/strings.ts`:
    - комментарий `S.sidebar.search` («подпись ⌘K до 6.2»);
    - без ключей `S.menu`, которые читал только `main/menu.ts`: `session`, `reopenTab`,
      `prevPanel`, `nextPanel`, `workspaceNumber`, `workspaceSidebar`, `back`, `forward`;
    - `splitRight`, `splitDown`, `find`, `commandPalette`, `newSession`, `newWork`,
      `settings`, `closePanel` живут до 6.2: их читают `Tab.tsx`, меню терминала 5.3,
      `CommandPalette` и `lib/commands.ts`;
  - `README.md`, раздел «Окно» — «⌘K — палитра» → «⌘J — палитра, ⌘K — очистить
    терминал»;
  - E2E `e2e/shell.spec.ts`, `e2e/layout.spec.ts` — в `menu:action` новые имена (таблица
    ниже).
- Удалить: `renderer/layout/keys.ts` и его тест. Его последние потребители —
  `LayoutView.tsx` и `AppShell.tsx` (3.4) — перестают его импортировать в этом же коммите.

**Интерфейсы**

```ts
// main/menu.ts
export function buildMenuTemplate(send: (id: ActionId) => void): MenuItemConstructorOptions[];
// Пункт реестра — { label: title, accelerator: keys, registerAccelerator: false,
//   click: (_item, _window, event) => { if (event.triggeredByAccelerator !== true) send(id); } }.
// «Harnas» (app): about, settings.open, quit. «Edit»: родные роли undo, redo, cut, copy, paste,
// selectAll с зарегистрированными сочетаниями и пункт find. Остальные — S.menu.view/workspace/tab/terminal.
export function createAppMenu(getFocusedWindow: () => BrowserWindow | null): Menu;   // шаблон — buildMenuTemplate

// shared/bridge.ts, HarnasBridge.app — MenuAction удаляется
onMenu(listener: (id: ActionId) => void): () => void;

// test-utils/fake-bridge.ts
emitMenu(id: ActionId): void;

// renderer/keys/handler.ts, дополнение
/** Действия с исполнителем: в 6.1b — ветки run в AppShell (таблица ниже); 6.3 и этапы 7–9 дописывают свои. */
export const IMPLEMENTED_ACTIONS: ReadonlySet<ActionId>;
/**
 * Реализовано и поддержано хостом. methods — hostMethods(useHostStore.getState().status) в момент
 * нажатия: хук useHostSupports обработчику клавиш не годится. Действию, которому нужен метод хоста,
 * — ещё и methods.has(метод): wake.toggle — wake.pause и wake.resume.
 */
export function isActionAvailable(id: ActionId, methods: ReadonlySet<string>): boolean;
```

**Поведение**
- **Меню** строит `buildMenuTemplate`, по модели спеки 9.6:
  - пункт реестра показывает сочетание. `registerAccelerator: false` стоит, как в спеке,
    но на macOS не действует (`@platform linux,win32` в типах Electron 44): там
    ⌘-сочетание сначала получает страница, а пункт меню — только необработанное;
  - необработанное — то, что обработчик окна отдал полю или не узнал: поле ввода,
    Monaco, диалог, `when` не совпал, `available` ложно. Такой клик приходит с
    `event.triggeredByAccelerator === true` и `menu:action` не шлёт: сочетаниями владеет
    рендерер, и действие в обход правил фокуса не выполняется. Пример: ⌘K в сайдбаре или
    в поле палитры — `resolveAction` даёт `null`, пункт «Clear terminal ⌘K»
    срабатывает, но ничего не шлёт;
  - клик мышью шлёт `menu:action` → `run(id)`, если действие доступно;
  - роли «Правки» и `quit` не трогаются: их сочетания работают в любом поле;
  - подписи меню — `S.menu`, пункты — `title` реестра. У `browser.*`, `tab.goto.N`,
    `tab.mruNext` и `tab.mruPrev` пунктов нет.
- **Живая проба флага** — в приёмке: держится ли `triggeredByAccelerator` на macOS.
  Не держится — запасной ход: `terminal.clear` чистит только терминал, в поверхности
  которого фокус ввода (`document.activeElement` внутри неё), без запасного «терминал
  активной вкладки». Тот же ход — в `runAction` 6.3.
- **Одна точка `run(id)`** в `AppShell`: её зовут `onMenu` и `installKeyHandler`, у
  `App.tsx` своего `onMenu` больше нет. Ветки 6.1b — они же `IMPLEMENTED_ACTIONS`:

| Действие | `run` в 6.1b |
|---|---|
| `palette.open` | `setPaletteOpen(true)` — прежняя палитра до 6.2 |
| `work.new`, `session.new`, `settings.open` | `openNewWorkDialog()`; `openNewSessionDialog(selectedSessionOf(…)?.ref.sessionId ?? null)` — родитель, как у ⌘T в `App.tsx`; `openSettingsDialog()` |
| `sidebar.left.toggle` | `setSidebar('left', { open: !open })` |
| `work.goto.N`, `work.prev`, `work.next` | по видимому порядку `visibleWorkOrder(useSidebarSectionsStore.getState().sections)` в момент нажатия (3.4); активной нет в порядке — `work.next` берёт первую видимую, `work.prev` — последнюю |
| `history.back`, `history.forward` | `back()` и `forward()` стора раскладки |
| `group.splitRight`, `group.splitDown` | прежний выбор сессии (`openPicker`) до 6.2 |
| `group.prev`, `group.next` | соседняя группа по кругу |
| `tab.close`, `tab.reopen` | `requestCloseTabs(activeWorkKey, [активная вкладка])`; `apply(reopenClosed)` |
| `tab.prev`, `tab.next`, `tab.goto.N` | соседняя вкладка активной группы по кругу; N-я вкладка активной группы — прежние ⌘⇧[ ] и ⌃1–9 `LayoutView` |
| `tab.mruNext`, `tab.mruPrev` | `mruCycle.step(activeWorkKey, mru[activeWorkKey], ±1)` → `apply(focusTab)`; `endMruCycle` → `mruCycle.commit(activeWorkKey)` → `mru` стора раскладки (`setState`, как в 2.4) |
| `find`, `terminal.clear` | `openSearch()` и `clear()` терминала активной вкладки активной группы, как `AppShell#openSearch` с 2.5: клик и фокус в терминале делают его группу активной (раунд исправлений 1 куска 2.5) |

- Ветки действуют на раскладку активной работы. Клавиши больше не висят в `LayoutView`
  трёх работ LRU, гейт `active` им не нужен. `AppShell` держит один `createMruCycle()` на
  окно.
- **Доступность.** `available` — `isActionAvailable(id, hostMethods(useHostStore
  .getState().status))`, одна и та же для нажатия и для `menu:action`. Остальные действия
  реестра (`files.*`, `sidebar.right.toggle`, `sidebar.files`, `sidebar.changes`,
  `works.showArchived`, `attention.next`, `wake.toggle`, `host.restart`, `appearance.*`,
  `room.new`, `browser.*`) недоступны до 6.3 и этапов 7–9. У тех, что в меню (`files.*`,
  `sidebar.right.toggle`, `sidebar.files`, `sidebar.changes`), пункт есть и активен: клик шлёт `menu:action`, а рендерер ничего не
  делает. Доступность в main не передаётся.
- **⌘1–9 при открытой палитре** — в 6.1b `pickPaletteRow` пустышка: прежняя палитра
  строк по номеру не выбирает. `paletteOpen()` — прежний флаг `useUiStore.paletteOpen`.
  `Palette` и её `pickRow` подключает 6.2.
- **Прежние имена `menu:action`** меняются на `ActionId` одним коммитом с
  `fake-bridge.ts`, тестами и E2E:

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
1. `buildMenuTemplate` (`menu.test.ts`):
   - подписи меню — `Harnas`, `Edit`, `View`, `Workspace`, `Tab`, `Terminal`, кириллицы
     нет;
   - «Edit» — роли `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll` и пункт `Find`;
   - клик по пункту `Command palette` с `{ triggeredByAccelerator: true }` не шлёт, без
     него — шлёт `palette.open`;
   - у `browser.*`, `tab.goto.N` и `tab.mru*` пунктов нет, у `files.quickOpen` — есть.
2. `isActionAvailable`: `group.splitRight` → `true`; `works.showArchived`,
   `files.quickOpen`, `sidebar.right.toggle` → `false`.
3. Прежние тесты `AppShell.test.tsx` с `emitMenu` зелёные с новыми именами;
   `emitMenu('files.quickOpen')` ничего не меняет и не бросает.
4. `emitMenu('settings.open')` открывает настройки; `emitMenu('session.new')` — диалог
   новой сессии с родителем — выбранной сессией (`App.test.tsx`).
5. Цикл ⌃Tab в окне (перенос тестов `LayoutView.test.tsx` 2.4): три вкладки, MRU
   [C, B, A]; ⌃ удержан, два `keydown` Tab — активна A; `keyup` `Control` — `mru`
   [A, C, B]; то же с `blur` вместо `keyup`.
6. Клавиши действуют только на активную работу: две работы в LRU, ⌃1 и ⌘⇧] меняют
   вкладку активной, раскладка скрытой — та же ссылка.
7. ⌘⇧↓ (перенос тестов 11 и 20 куска 3.4): в поле ввода работа прежняя,
   `defaultPrevented` ложно; в терминале (фокус в `textarea.xterm-helper-textarea`) и вне
   полей — соседняя по видимому порядку, активная вкладка активной группы прежняя;
   проект активной работы свёрнут — ⌘⇧↓ делает активной первую видимую работу, ⌘⇧↑ —
   последнюю.
8. ⌘K (перенос части теста 10 куска 5.3 из `AppShell.test.tsx`): в терминале —
   `clear()` его поверхности вызван, `pty.input` нет, палитра закрыта; при фокусе в
   сайдбаре — `clear()` не вызван.
9. Подписи: ⌘J в заголовке, на `Landing` и в сайдбаре, `⌘K` нигде нет — тесты
   `AppShell.test.tsx`, `Titlebar.test.tsx` и `WorkSidebar.test.tsx` переписаны.
10. E2E `shell.spec` и `layout.spec` зелёные с новыми именами в `menu:action`. Пуст:

    ```
    grep -rnE "MenuAction|(emitMenu|sendMenu)\(.*'[a-z]+-[a-z0-9-]+'|emitMenu\('(palette|settings)'\)|'menu:action', '[a-z]+-" \
      packages/desktop/src packages/desktop/e2e
    ```

    Старые имена — через дефис, новые — нет; `palette` и `settings` сменились без
    дефиса. Тесты `pnpm typecheck` не проверяет (`exclude` в `tsconfig.web.json`), и
    старая строка в них молча перестала бы совпадать.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.
- [ ] `grep -rn "layout/keys\|layoutKeyAction" packages/desktop/src` пуст, включая
      комментарии.
- [ ] Живая проба на macOS (`pnpm dev:desktop`): ⌘K в сайдбаре и в поле палитры
      терминал не чистит; ⌘⇧↓ в поле ввода выделяет текст, работа прежняя. Не держится
      `triggeredByAccelerator` — запасной ход из «Поведения» и повтор пробы.
- [ ] Все сочетания таблицы 9.6 видны в меню и работают из терминала, из сайдбара и
      из поля ввода по правилам контекста (ручная проверка).

---

## 6.2. Палитра ⌘J

**Зачем.** Всё открывается с клавиатуры за пару букв.
**Зависит от:** 6.1b. **Спека:** 9.1–9.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/palette/`:
  - `score.ts` и тест;
  - `documents.ts` и тест;
  - `store.ts` и тест;
  - `Palette.tsx` и тест.
- Создать: `renderer/layout/measure.ts` — `measureGroupSizes()`, вынесенный из
  `AppShell.tsx`: сплит из палитры меряет группы той же функцией. Если 3.4 уже вынес
  её ради «Open to the side», берётся оттуда.
- Изменить:
  - `renderer/shell/Titlebar.tsx` и `Titlebar.test.tsx` — «Поиск» (`Search`) открывает
    `Palette`; проверка `useUiStore.getState().paletteOpen` → стор палитры;
  - `renderer/shell/Landing.tsx` — кнопка «Палитра» (`Palette`) открывает `Palette`;
  - `renderer/sidebar/WorkSidebar.tsx` и `WorkSidebar.test.tsx` — «Поиск» открывает
    `Palette`; проверка `paletteOpen` → стор палитры. Подписи ⌘J — с 6.1b;
  - `renderer/layout/TabStrip.tsx` — «+» (`S.tabs.openTab`) сначала `focusGroup` своей
    группы, затем `openWith('open')`; без `openSessionIds`;
  - `renderer/layout/Tab.tsx` и `Tab.test.tsx` — «Разделить вправо/вниз»
    (`S.actions.splitRight`, `splitDown`): `focusGroup` своей группы, затем
    `openWith('splitRight' | 'splitDown')`; без пропа `openSessionIds`;
  - `renderer/terminal/TerminalContextMenu.tsx` и тест (5.3) — «Split right/down» так
    же; тексты `Find`, `Split right`, `Split down` — из `S.actions`. Тест 7 куска 5.3 —
    `openWith` вместо `openPicker`;
  - `renderer/shell/AppShell.tsx`:
    - монтирует `Palette` вместо `CommandPalette` и `SessionPicker`, без `buildCommands`
      и без подписки на `history`;
    - `run`: `palette.open` → `openWith('default')`, `group.splitRight` и
      `group.splitDown` → `openWith('splitRight' | 'splitDown')`;
    - `installKeyHandler` получает `pickPaletteRow` — `pickRow` палитры, `paletteOpen` —
      `open` палитры;
    - `NewWorkComposer` получает `title` пропом из `dialogs.newWork.title`;
  - `renderer/shell/AppShell.test.tsx` — тесты 9, 13 и 14: меню `palette.open` открывает
    `Palette`; сплит из меню и из меню вкладки неактивной группы — строка палитры
    вместо `SessionPicker`; проверки `paletteOpen` → стор палитры.
    `AppShell.dnd.test.tsx` — без `paletteOpen` и `picker` в начальном состоянии стора;
  - `renderer/layout/persistence.ts` и тест — `ensureHydrated`: вкладки работ, ещё не
    показанных за этот запуск;
  - `renderer/store/ui.ts` и тест:
    - `dialogs.newWork.title`, второй аргумент `openNewWorkDialog`;
    - без `paletteOpen`, `setPaletteOpen`, `picker`, `openPicker`, `closePicker`,
      `PickerState`: открыта ли палитра — `palette/store.ts` (спека 3.5), второй флаг
      лишний;
  - `renderer/sidebar/NewWorkComposer.tsx` и тест — начальное название из пропа `title`;
  - `shared/strings.ts` — новый `S.palette` (ниже). Без `S.picker`, прежних ключей
    `S.palette` и пунктов `S.menu` (`splitRight`, `splitDown`, `find`, `commandPalette`,
    `newSession`, `newWork`, `settings`, `closePanel`): их читатели удалены или перешли
    на `S.actions`;
  - E2E `e2e/shell.spec.ts`, `e2e/layout.spec.ts` — после `group.splitRight` щёлкают
    строку палитры (`getByRole('option', …)`) вместо строки диалога `SessionPicker`.
    E2E гоняются уже в 6.2;
  - комментарии, которые найдёт grep приёмки: `layout/Tab.tsx`, `layout/TabStrip.tsx`,
    `layout/tree.ts` (`openTerminalSessionIds` остаётся — его берёт режим разделения),
    `store/ui.ts`, `shared/strings.ts`, `shell/AppShell.tsx`.
- Удалить в `packages/desktop/src/renderer/`: `components/palette/CommandPalette.tsx`,
  `components/palette/SessionPicker.tsx`, `lib/commands.ts`, `lib/fuzzy.ts` и их тесты.
  Их потребители — `AppShell.tsx` и сам `CommandPalette` — меняются или удаляются в
  этом же коммите.

**Интерфейсы**

```ts
// palette/score.ts
export function normalize(text: string): string;                    // нижний регистр, ё → е (// cyrillic-ok:)
/** field — исходный текст поля: границы слов и смену регистра видно только до normalize; сравнение — после. */
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
  state?: DotState;              // сессии — их точка; работы — по уровню внимания (ниже)
  run(mode: 'default' | 'split'): void;
}
export function buildDocuments(input: {
  works: WorkEntry[]; activity: Record<string, ActivityEntry>;
  /** useSidebarAttention() (3.3): lastEventAt и уровень работ — один расчёт внимания (4.2). */
  attention: Record<string, WorkAttention>;
  /** useWorksStore.branches: ветка проекта — поле поиска работ (спека 9.1). */
  branches: Record<string, string | null>;
  /** visibleWorkOrder(useSidebarSectionsStore.getState().sections): последняя ступень ранжирования (спека 9.2, п. 5). */
  order: readonly string[];
  layouts: Record<string, WorkLayout>;
  /** useLayoutStore.getState().entries(): записи { workKey, tabId, at } (2.2). */
  history: readonly HistoryEntry[];
  actions: readonly ActionDef[]; available(id: ActionId): boolean;
  wakePaused: boolean | null;    // заголовок wake.toggle
  providers: Array<{ id: string; label: string }>;
  mode: PaletteMode;
  run(id: ActionId): void;       // действия — run из AppShell (6.1b), в 6.3 — runAction
}): PaletteDoc[];
export interface RankedSection { section: PaletteSection; docs: PaletteDoc[]; more: number }
export function rankDocuments(query: string, docs: PaletteDoc[], now: number): RankedSection[];

// palette/store.ts
export type PaletteMode = 'default' | 'open' | 'splitRight' | 'splitDown' | 'files';
export interface PaletteState {
  open: boolean; mode: PaletteMode; query: string;
  openWith(mode: PaletteMode, query?: string): void;
  close(): void;
  setQuery(query: string): void;
  /** ⌘1–9 из обработчика окна (pickPaletteRow): Palette выбирает строку с этим номером среди видимых. */
  pickRow(index: number): void;
}
export const usePaletteStore: UseBoundStore<StoreApi<PaletteState>>;

// palette/Palette.tsx
export interface PaletteProps { bridge: HarnasBridge; run(id: ActionId): void }

// layout/persistence.ts, дополнение
/** Гидрирует раскладки работ, ещё не показанных за этот запуск: тот же hydrateWork, что у первого показа. */
export function ensureHydrated(input: { bridge: HarnasBridge; works: WorkEntry[] }): Promise<void>;

// layout/measure.ts
export function measureGroupSizes(): GroupSizes;   // из AppShell.tsx: группы по data-group-id

// store/ui.ts — dialogs.newWork (3.5) получает название
newWork: { open: boolean; projectPath: string | null; title: string };
openNewWorkDialog(projectPath?: string | null, title?: string): void;

// sidebar/NewWorkComposer.tsx, дополнение NewWorkComposerProps (3.5)
title: string;                   // начальное название: «Create workspace …» палитры; '' — пусто

// shared/strings.ts — S.palette заново (английский текст; русский в плане — смысл)
palette: {
  placeholder: 'Search tabs, workspaces, sessions, rooms, and actions…',
  splitTitle: 'Open in new group',                   // заголовок режимов splitRight и splitDown
  sections: { tabs: 'Tabs', works: 'Workspaces', sessions: 'Sessions', rooms: 'Rooms', actions: 'Actions', files: 'Files' },
  more: (n: number) => string,                       // '3 more'
  createWorkspace: (query: string) => string,        // 'Create workspace "query"'
  footer: '↑↓ select · Enter open · ⌘Enter open to the side · Esc close',
},
// Заголовок диалога для скринридера — S.actions.commandPalette; «Open mail» — S.cardMenu.openMail (3.4).
```

**Поведение**
- **Документы** — таблица спеки 9.1:
  - вкладки всех работ (из `layouts`). В `layouts` лежат только показанные за этот
    запуск работы, поэтому палитра при открытии зовёт `ensureHydrated` для остальных:
    их вкладки появляются в секции, как только раскладки прочитаны;
  - работы, кроме архивных. Поля — название, имя проекта, `projectPath`, id и ветка
    проекта (`branches[projectPath]`). Точка — по уровню внимания работы: `needs-you` →
    `blocked`, `unseen`, `working` и `idle` — как есть, `off` — без точки. `maxDotState`
    удалён в 3.5;
  - у работы с письмами — документ «Open mail» (`S.cardMenu.openMail`, подпись —
    название работы) в секции работ: вкладка `mail`, как у прежней команды «All workspace
    mail»;
  - сессии, кроме закрытых;
  - комнаты;
  - действия реестра с `inPalette` и `available`. Заголовок `wake.toggle` — `Resume
    auto-wake`, пока `wakePaused`, иначе `Pause auto-wake`.
- **Свежесть** (спека 9.2, п. 5): у вкладки — самое позднее `at` её записей в `history`
  (`workKey` и `tabId`); у работ — `attention[workKey].lastEventAt`, у сессий — их
  `lastEventAt`. Последняя ступень — `order`, порядок сайдбара.
- **Режимы:**
  - `splitRight` и `splitDown` — вкладки активной работы, её сессии без открытой вкладки
    и её комнаты. Сессия с открытой вкладкой есть только как вкладка
    (`openTerminalSessionIds`), иначе она была бы в списке дважды. Выбор —
    `apply(splitGroup(активная группа, …, measureGroupSizes()))`; отказ
    `too-many-groups` и `too-small` — тосты `S.tabs.tooManyGroups` и `S.tabs.tooSmall`,
    как у прежнего выбора. Заголовок — `S.palette.splitTitle`;
  - `open` — без действий;
  - `files` — заготовка до 7.4.
- **Подписки.** `Palette` сама подписывается на работы, активность, раскладки, историю и
  секции — и только пока открыта: содержимое монтируется при `open`. `AppShell` на
  `history` не подписан, как и на поток активности (решение по куску 3.3).
- **`ensureHydrated`** идёт тем же `hydrateWork`, что первый показ работы. Пометка
  «грязной первой гидрации» — общая на модуль `persistence.ts`, а не `useRef` хука.
  Иначе операция из очереди (например, клик по строке сессии), влитая в гидрацию
  палитрой, попала бы на диск только со следующей правкой.
- **Ранжирование** — алгоритм спеки 9.2. `scoreToken` ищет границы слов и смену регистра
  в исходном поле, а сравнивает после `normalize`. Секции упорядочены по лучшему
  документу. «ещё N» (`S.palette.more`) раскрывает секцию.
- **Вид** — спека 9.3, `ui/command` на cmdk с собственным ранжированием:
  `shouldFilter={false}`, список из `rankDocuments`.
  - У строки `value={doc.id}`: «S01 …» есть в каждой работе, а cmdk выделяет строку по
    значению.
  - Содержимое палитры несёт `data-palette`: `focusContext` (6.1a) отличает её поле от
    модального диалога.
  - Строки: значок или `AgentStateDot`, название, подпись, ⌘1…⌘9 у первых девяти.
  - Пустой запрос — шесть последних вкладок и четыре последние работы из `history`:
    свежие первыми, без повторов. Эти числа главнее `SECTION_LIMITS` (у вкладок там 5).
  - Нет совпадений — «Создать работу „<запрос>“» (`S.palette.createWorkspace`) →
    `openNewWorkDialog(null, запрос)`: форма открывается с этим названием.
  - Футер — `S.palette.footer`.
- **Клавиши:** ↑↓; Enter — выбор `'default'`; ⌘Enter — выбор `'split'`; Esc.
  - ⌘Enter ловит свой `onKeyDown` поля с `preventDefault` раньше cmdk: cmdk 1.1.1
    разбирает Enter в корне без учёта модификаторов, и ⌘Enter ушёл бы в `'default'`.
  - ⌘1–9 приходят из обработчика окна как `pickRow(index)` — строка с этим номером среди
    видимых.
- **Закрытие** (спека 9.4): выбор сначала зовёт `close()`, потом `doc.run(mode)`. Действие
  может открыть палитру снова (`group.split*`, `palette.open`, с 7.4 — `files.quickOpen`),
  и закрытие после `run` закрыло бы её. Действие со своим диалогом (форма работы,
  сессии, комнаты, настройки, подтверждение) получает фокус в диалоге.
- **Рамка** (спека 15.1):
  - палитра не создаёт работ и сессий и не пишет в PTY. Создание — только формой или
    диалогом: «Create workspace …» открывает форму, `session.new` и `room.new` —
    диалоги; `terminal.clear` — `term.clear()`, в `pty.input` ничего не уходит;
  - выбор (Enter, ⌘Enter, ⌘1–9) гасит `keydown` до `run`. `run` переводит фокус в
    терминал, и непогашенное нажатие Enter досталось бы xterm — агенту ушёл бы `\r`,
    ответ за человека;
  - `onCloseAutoFocus` не возвращает фокус на кнопку, открывшую палитру, если `run` его
    перевёл (в терминал, в диалог). Esc без выбора — возвращает.

**Тесты**
1. `scoreToken`:
   - `'s02'` и `'S02'` → 100;
   - `'исп'` и `'исполнитель'` → 80;
   - `'ред'` и `'Редизайн окна'` → 80;
   - `'окн'` и `'Редизайн окна'` → 60;
   - `'api'` и `'room-api-review'` → 40; `'api'` и `'roomApiReview'` → 40: смена
     регистра видна в исходном поле;
   - `'ё'` и `'ещё'` совпадает, как `'е'`;
   - `'xyz'` и `'Редизайн окна'` → 0;
   - `'sprt'` и `'sprint'` — нечёткое совпадение, очки от 1 до 10.
2. `scoreDocument`: токен не совпал ни с одним полем → `null`; совпадение по
   названию весит больше, чем по подписи.
3. `recencyBucket`: 30 мин → 0, 5 ч → 1, 3 сут → 2, 30 сут и `null` → 3.
4. `rankDocuments`:
   - при равных очках свежее выше, при равной свежести — меньший `order`;
   - секция с лучшим документом первая; лимит секции и `more` верны;
   - пустой запрос — шесть вкладок и четыре работы, хотя лимит вкладок — 5.
5. `buildDocuments`:
   - архивной работы и закрытой сессии нет; действия с `available: false` нет;
     `palette.open`, `work.goto.2` и `tab.mruNext` нет;
   - в режиме `splitRight` нет действий и чужих работ; сессия с открытой вкладкой есть
     только как вкладка;
   - вкладка с записью истории `at` час назад — `recencyAt` этой записи; вкладка без
     записей — `null`; у работы — `lastEventAt` из `attention`, ветка проекта — в полях;
   - «Open mail» есть только у работы с письмами;
   - `wake.toggle` при `wakePaused: true` — `Resume auto-wake`.
6. `Palette`:
   - ввод `S02` — первая строка — сессия; Enter открывает её вкладку, палитра закрыта;
   - ⌘Enter — в новой группе справа, `'default'` не выполнен;
   - две работы с сессией `S01`: ↓ выделяет вторую строку `S01`, а не первую;
   - пустой результат — строка `Create workspace "…"` открывает форму с названием из
     запроса; `works.create` и `sessions.create` не вызваны;
   - `pickRow(1)` (⌘2) выбирает вторую строку;
   - Enter на строке сессии — `defaultPrevented`, `pty.input` не вызван; фокус не
     вернулся на кнопку, открывшую палитру. Esc без выбора — вернулся;
   - `splitRight` при восьми группах — тост `No more than 8 groups per workspace`.
7. `ensureHydrated`:
   - работа, не показанная за запуск, → один `loadLayout`, её вкладки в документах
     палитры; уже гидрированная — без вызова;
   - операция в очереди, влитая в гидрацию палитрой, уходит в `saveLayout`.
8. Подписки: при закрытой палитре запись истории не перерисовывает `AppShell` (счётчик
   отрисовок `Profiler`); открытая палитра обновляет список.
9. Меню вкладки и меню терминала (тесты 13 и 14 куска 2.4, тест 7 куска 5.3): «Split
   right» на вкладке неактивной группы — её группа активна, палитра в режиме
   `splitRight`; выбор сессии делит эту группу, прежняя активная не тронута. «+»
   строки вкладок неактивной группы — палитра в режиме `open`, выбор открывается в этой
   группе.
10. `store/ui.ts`: `openNewWorkDialog(null, 'X')` → `dialogs.newWork.title === 'X'`;
    тест `paletteOpen` и `openPicker` удалён вместе с полями.
11. E2E `shell.spec` и `layout.spec` зелёные: после `group.splitRight` выбор — строка
    палитры.

**Приёмка**
- [ ] Все тесты зелёные, E2E `shell.spec` и `layout.spec` зелёные.
- [ ] Удалённые файлы и состояние не упоминаются в коде, включая комментарии. Пуст:

      ```
      grep -rnE "CommandPalette|SessionPicker|fuzzyScore|openPicker|closePicker|PickerState|setPaletteOpen|\.paletteOpen|S\.picker|paletteOpen: (false|true)|picker: null" \
        packages/desktop/src packages/desktop/e2e
      ```

      Последние две ветки ловят начальное состояние стора в тестах: `pnpm typecheck` тесты
      не проверяет.

---

## 6.3. Действия палитры; приёмка этапа 6

**Зачем.** Каждое действие реестра делает ровно то, что написано.
**Зависит от:** 6.2. **Спека:** 6.1, 6.7, 7.6, 9.4, 9.6.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/palette/actions.ts` и тест;
  - `packages/desktop/e2e/palette.spec.ts`.
- Изменить:
  - `renderer/shell/AppShell.tsx` — `run(id)` из 6.1b зовёт `runAction` с контекстом;
    отдаёт `StatusBar` состояние подтверждения перезапуска хоста;
  - `renderer/keys/handler.ts` и тест — `IMPLEMENTED_ACTIONS` дополняется:
    `works.showArchived`, `attention.next`, `wake.toggle`, `host.restart`,
    `appearance.*`, `room.new`;
  - `renderer/store/ui.ts` и тест — `showArchived` и `toggleShowArchived` (в памяти
    окна, не в `ui.json`); `dialogs.restartHost`, `confirmRestartHost`,
    `closeRestartHostDialog`;
  - `renderer/sidebar/sort.ts` и тест — `buildSections` получает `showArchived`;
  - `renderer/sidebar/use-sidebar-sections.ts` — передаёт его из `store/ui.ts`;
  - `renderer/sidebar/WorkCard.tsx` и тест — архивная карточка приглушена, как `done`;
  - `renderer/layout/persistence.ts` и тест — выбор соседа пропускает архивные (ниже);
  - `renderer/shell/StatusBar.tsx` и тест — подтверждение перезапуска хоста (3.1)
    открывается через стор, тем же путём, что из палитры; локальный `useState`
    уходит;
  - `shared/strings.ts` — `S.errors.noActiveWorkspace` и действия ошибок (ниже).
- Правило «архивные не входят в счётчики и в `attention.next` при любом
  `showArchived`» держат `attentionTotals` и `nextAttentionTarget` с 4.2 (план этапа 4):
  здесь — только проверка вместе с показом.
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
  /** Цикл ⌃Tab окна (keys/mru-cycle.ts, 6.1a): tab.mruNext/Prev — его шаг; фиксирует endMruCycle (6.1b). */
  mruCycle: MruCycle;
  /** Видимый порядок работ в момент действия: visibleWorkOrder(useSidebarSectionsStore.getState().sections). */
  sidebar: { order(): string[] };
  ui: {
    toggleSidebar(side: 'left' | 'right'): void;
    openNewWork(title?: string): void;          // openNewWorkDialog(null, title)
    openNewSession(): void;                     // openNewSessionDialog(selectedSessionOf(…)?.ref.sessionId ?? null) — родитель, как у ⌘T
    openNewRoom(): void;                        // CreateRoomDialog активной работы без участника (3.4)
    openSettings(): void;
    setAppearance(mode: Appearance): void;      // store/ui.ts: app.setAppearance, ui.json пишет main
    toggleShowArchived(): void;
    toggleWake(): Promise<void>;                // useUiStore.getState().toggleWake(bridge)
    confirmRestartHost(): void;                 // dialogs.restartHost: ConfirmDialog строки статуса → app.restartHost()
  };
  palette: Pick<PaletteState, 'openWith' | 'close'>;
  terminals: {
    /** Терминал, в поверхности которого фокус ввода. */
    focused(): TerminalSurfaceHandle | null;
    /** Терминал активной вкладки активной группы. */
    active(): TerminalSurfaceHandle | null;
  };
  attention: { next(): SessionRef | null };     // openNextAttention (4.2)
  toast(text: string): void;
}
export function runAction(id: ActionId, ctx: ActionContext): void;

// sidebar/sort.ts, дополнение входа buildSections
showArchived: boolean;   // false — archived скрыты, как в 3.2; true — в конце своей секции, после done

// store/ui.ts, дополнения
showArchived: boolean;                 // в памяти окна, до перезапуска
toggleShowArchived(): void;
// DialogsState
restartHost: boolean;
confirmRestartHost(): void;            // открыть подтверждение
closeRestartHostDialog(): void;

// shell/StatusBar.tsx, дополнение StatusBarProps (с 4.2 строка статуса на пропах)
restartHostOpen: boolean;                        // AppShell: dialogs.restartHost
onRestartHostOpenChange(open: boolean): void;    // true — confirmRestartHost(), false — closeRestartHostDialog()
// onRestartHost — как было: «Restart» в подтверждении

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
errors: {
  noActiveWorkspace: 'No active workspace',
  actions: { toggleAutoWake: 'toggle auto-wake', restartHost: 'restart host', closeTab: 'close tab' },
},
```

**Поведение**
- **Одна ветка на каждый `ActionId`.** Действия, требующие активной работы
  (`session.new`, `room.new`, `group.*`, `tab.*`), без активной работы показывают тост
  «Нет активной работы» (`S.errors.noActiveWorkspace` — `No active workspace`).
- **Контекст читается в момент действия.** `ctx.layout` — `useLayoutStore.getState()`,
  а не снимок при монтировании: история и MRU — значения стора, объектов с методами у
  них нет. Порядок работ — `getState()` стора секций, а не хук (решение по куску 3.3).
  - `history.back` и `history.forward` → `layout.back()` и `layout.forward()`;
  - `tab.mruNext` и `tab.mruPrev` → шаг цикла MRU 2.4:
    `mruCycle.step(activeWorkKey, mru[activeWorkKey], ±1)` → `apply(focusTab(…))`, а не
    сосед живого `mru`. Итог фиксирует `endMruCycle` обработчика клавиш (6.1b);
  - `tab.close` → `requestCloseTabs(activeWorkKey, [активная вкладка])` — с 7.3 он
    спросит про несохранённый файл.
- **Особые действия:**
  - `host.restart` — `ui.confirmRestartHost()`: тот же `ConfirmDialog` строки статуса
    (3.1), что у «Host is outdated — restart». `app.restartHost()` — только после
    «Restart». Строка статуса с 4.2 работает на пропах, поэтому состояние диалога — в
    сторе (`dialogs.restartHost`), а не в `useState` строки;
  - `appearance.*` — `ui.setAppearance(mode)` стора `store/ui.ts`: он зовёт
    `app.setAppearance`, а `ui.json` пишет main (1.1). `app.saveUi` напрямую не зовётся;
  - `works.showArchived` — переключатель `showArchived` в памяти окна, до перезапуска.
    `buildSections` при нём показывает архивные работы в конце своей секции, после
    `done`; `WorkCard` приглушает их, как `done`. Вернуть работу — пункт `Reopen` её меню
    (3.4: у `archived` он вместо `Mark as done` и `Archive`). Раньше 3.2 скрывал архивные
    всегда (спека 6.1, 6.7);
  - архивные при любом `showArchived` не входят в счётчики, бейдж и `attention.next`
    (`attentionTotals` и `nextAttentionTarget` отсекают их по `status`, 4.2) и в выбор
    соседней работы (`persistence`, 3.4): сосед пропавшей или архивированной активной и
    «первая в `visibleOrder`» — только неархивные, хотя показанные архивные в
    `visibleOrder` есть. Повод сменить активную — переход работы в `archived` между
    снимками, а не сам статус: показанную архивную можно сделать активной кликом, и
    следующий снимок её не выталкивает;
  - `find` и `terminal.clear` — `(terminals.focused() ?? terminals.active())?.openSearch()`
    и `?.clear()`; терминала нет — ничего. Если живая проба 6.1b показала, что
    `triggeredByAccelerator` не держится, `terminal.clear` берёт только
    `terminals.focused()`;
  - `attention.next` — `openNextAttention()` из 4.2;
  - `wake.toggle` — `ui.toggleWake()`; заголовок в палитре — по `wakePaused` (6.2);
  - `session.new` — `ui.openNewSession()`: родитель — выбранная сессия, как у ⌘T;
  - `room.new` — `ui.openNewRoom()`;
  - `work.new` — `ui.openNewWork()`, «Create workspace …» из 6.2 — с названием.
- **Ошибки асинхронных действий** — `toggleWake`, `app.restartHost`, `requestCloseTabs` —
  тост `errorText(decodeIpcError(err).code, S.errors.actions.<…>)`: `toggleAutoWake`,
  `restartHost`, `closeTab`. Необработанного отказа промиса нет, окно не падает.
- **Действия будущих этапов** (`files.*`, `sidebar.files`, `sidebar.changes`,
  `sidebar.right.toggle`, `browser.*`) получают ветки в 7.2, 7.4, 8.2 и 9.2. До этого их
  нет в `IMPLEMENTED_ACTIONS`, `available` ложно, и `runAction` их не зовёт.

**Тесты**
1. `runAction` для каждого `ActionId` из `IMPLEMENTED_ACTIONS` зовёт ожидаемую функцию
   контекста: таблица тестов по реестру, один случай на действие.
2. `tab.close` без активной работы — тост `No active workspace`, `requestCloseTabs` не
   вызван; с активной — вызван с id активной вкладки.
3. Контекст свежий: после `apply(openTab)` в тесте `tab.mruNext` берёт снимок нового
   `mru` и фокусирует прежнюю вкладку; `history.back` зовёт `layout.back()`.
4. `appearance.dark` → `ui.setAppearance('dark')`, `app.saveUi` не вызван.
5. `find` и `terminal.clear` зовут `openSearch()` и `clear()` у `terminals.focused()`,
   без него — у `terminals.active()`; оба `null` — без ошибки.
6. `works.showArchived`: архивная работа появилась в конце своей секции, её карточка
   приглушена, как `done`; второй вызов прячет её снова. `buildSections` с
   `showArchived: false` — как в 3.2.
7. Показ архивных включён:
   - архивная работа с сессией `needs-you` в секциях, но строка статуса её не считает, а
     `attention.next` её сессию не выбирает;
   - активная работа архивирована — активна соседняя неархивная, хотя архивный сосед
     виден;
   - клик по показанной архивной карточке делает её активной, и следующий снимок работ
     её не выталкивает.
8. `host.restart` открывает подтверждение (`dialogs.restartHost`); `app.restartHost` —
   только после `Restart`. Кнопка `Host is outdated — restart` строки статуса открывает
   тот же диалог.
9. `session.new` — диалог новой сессии с родителем — выбранной сессией. `wake.toggle` —
   `wake.pause`; отказ — тост `Couldn't toggle auto-wake: …`, необработанного отказа
   промиса нет.
10. **E2E `palette.spec.ts`:**
    - две работы, три сессии;
    - ⌘J (нажатие клавиш — обработчик в рендерере) и ввод `исп` → первая строка
      `S02 исполнитель`;
    - Enter — её вкладка активна.
11. **E2E:** ⌘J, ввод `S0`, ⌘2 — открыта вкладка второй строки списка, а не вторая
    работа сайдбара (спека 14.3).
12. **E2E:** пустой результат по `нетакойработы` → Enter открывает форму новой работы с
    названием `нетакойработы`.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 6** (человек, на пересобранном `harnas.app`)
- [ ] Любая сессия открывается ⌘J и 2–4 буквами ярлыка.
- [ ] Сочетания таблицы 9.6 работают и видны в меню; ⌘D в будущем редакторе не
      мешает (проверяется в этапе 7).
- [ ] ⌘K в сайдбаре терминал не чистит; ⌃Tab с удержанием ⌃ обходит все недавние
      вкладки.
- [ ] «Show archived workspaces» показывает архивную работу приглушённой, `Reopen` в
      её меню возвращает её.
- [ ] `README.md` — таблица клавиш.
