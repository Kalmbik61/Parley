# План, этап 2: каркас

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 5, строки 1, 3, 5, 6 таблицы 14.3.

**Итог этапа:**
- у каждой работы своя раскладка: дерево сплитов из групп вкладок;
- вкладки стоят в заголовке окна, пока группа одна;
- терминал переносится между группами без пересоздания;
- dockview удалён.

**Перед стартом.** Сверить с кодом этапа 1:
- `store/ui.ts`, `src/shared/ui-types.ts`, `ui/*`, `AgentStateDot`;
- `main/atomic-file.ts` (очередь и уникальный tmp — ими пишет и `layout-store.ts`);
- как `use-terminal.ts` подключается по видимости (`visible`);
- чем `Workspace.tsx` открывает вкладки (`openSession`, `openMail`, `openRoom`,
  `openChanges`): эти входы переезжают в `layout/store.ts`.

---

## 2.1. Модель раскладки и операции

**Зачем.** Вся логика раскладки — чистые функции, проверяемые без DOM.
**Зависит от:** —. **Спека:** 5.2.

**Файлы**
- Создать:
  - `packages/desktop/src/shared/layout-types.ts`;
  - `packages/desktop/src/renderer/layout/ids.ts` и тест;
  - `packages/desktop/src/renderer/layout/tree.ts` и тест.

**Интерфейсы**

```ts
// shared/layout-types.ts — спека 5.2; id вкладок — `string`, а не шаблонные типы спеки:
// их строит `layout/ids.ts`
export type LayoutNode = GroupNode | SplitNode;
export interface GroupNode { type: 'group'; id: string; tabs: TabSpec[]; activeTabId: string | null }
export interface SplitNode { type: 'split'; id: string; direction: 'row' | 'column'; ratio: number; children: [LayoutNode, LayoutNode] }
export type FileRootSpec = { kind: 'project' } | { kind: 'worktree'; sessionId: string };
export type TabSpec =
  | { kind: 'terminal'; id: string; sessionId: string }
  | { kind: 'mail'; id: 'mail' }
  | { kind: 'room'; id: string; roomId: string }
  | { kind: 'diff'; id: string; sessionId: string; commit: string | null }
  | { kind: 'file'; id: string; root: FileRootSpec; path: string }
  | { kind: 'browser'; id: string; url: string };
export interface WorkLayout { root: LayoutNode; activeGroupId: string; closedTabs: TabSpec[] }

// renderer/layout/ids.ts
export const tabId: {
  terminal(sessionId: string): string;                 // 'terminal:s-01'
  mail(): 'mail';
  room(roomId: string): string;                        // 'room:r-01'
  diff(sessionId: string, commit: string | null): string; // 'diff:s-01' | 'diff:s-01:<hash>'
  file(root: FileRootSpec, path: string): string;      // 'file:p:src/a.ts' | 'file:w:s-01:src/a.ts'
  browser(random?: () => number): string;              // 'browser:<6 hex>'
};
export function nodeId(prefix: 'g' | 's', random?: () => number): string; // 'g-<6 hex>'

// renderer/layout/tree.ts
export const LIMITS: {
  maxGroups: 8; minGroup: { width: 240; height: 160 };
  ratio: { min: 0.1; max: 0.9 }; closedTabs: 10;
};
export type GroupSizes = Record<string, { width: number; height: number }>;
export type OpError = 'too-many-groups' | 'too-small' | 'not-found';
export interface OpResult { layout: WorkLayout; error: OpError | null }
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Where = 'active' | { groupId: string; index?: number };

export function emptyLayout(random?: () => number): WorkLayout;
export function groups(layout: WorkLayout): GroupNode[];                 // визуальный порядок: слева направо, сверху вниз
export function findTab(layout: WorkLayout, tabId: string): { group: GroupNode; index: number } | null;
export function openTab(layout: WorkLayout, tab: TabSpec, where?: Where): WorkLayout;   // есть — фокус, нет — вставка
export function closeTab(layout: WorkLayout, tabId: string): WorkLayout;
export function moveTab(layout: WorkLayout, tabId: string,
  target: { groupId: string; index: number } | { groupId: string; edge: Edge }, sizes?: GroupSizes): OpResult;
export function splitGroup(layout: WorkLayout, groupId: string, direction: 'row' | 'column',
  tab: TabSpec, sizes?: GroupSizes): OpResult;
export function setRatio(layout: WorkLayout, splitId: string, ratio: number): WorkLayout;
export function focusGroup(layout: WorkLayout, groupId: string): WorkLayout;
export function focusTab(layout: WorkLayout, tabId: string): WorkLayout;
export function reopenClosed(layout: WorkLayout): WorkLayout;
export function pruneLayout(layout: WorkLayout, alive: (tab: TabSpec) => boolean): WorkLayout;
export function validateLayout(layout: WorkLayout): string[];            // нарушения инвариантов 1–6 спеки 5.2
export function parseWorkLayout(raw: unknown): WorkLayout | null;        // разбор с диска; мусор → null
```

**Поведение**
- **`openTab`.**
  - Вкладка с таким id уже есть — фокус на её группу и на неё, место не меняется.
  - Иначе вкладка встаёт в группу `where` (по умолчанию активную) на `index` или
    последней.
- **`closeTab`:**
  - вкладка уходит в начало `closedTabs`: без дублей, не больше 10;
  - новая активная вкладка группы — соседняя справа, иначе слева;
  - группа опустела и она не корень — удаляется, её сосед по сплиту занимает место
    сплита;
  - `activeGroupId` переходит на соседа.
- **`moveTab` с `edge`** создаёт новую группу с вкладкой на указанной стороне
  целевой группы:
  - `left` и `top` — новая группа первым ребёнком;
  - `row` для `left` и `right`, `column` для `top` и `bottom`;
  - `ratio` 0.5.
  - Перенос единственной вкладки группы к краю этой же группы ничего не меняет.
- **`splitGroup` с уже открытой вкладкой** переносит её в новую группу, как `moveTab` к
  краю: исходная группа, оставшаяся пустой, удаляется. Единственная вкладка самой
  `groupId` — раскладка без изменений.
- **`splitGroup` и `moveTab` с `edge` отказывают** без изменения раскладки:
  - групп уже 8 и после операции их стало бы 9 — `too-many-groups`. Если исходная
    группа переносимой вкладки исчезает, число групп не растёт, и операция разрешена;
  - по `sizes` целевая группа уже, чем `2 × 240` для `row`, или ниже `2 × 160` для
    `column` — `too-small`;
  - без `sizes` проверяется только число групп.
- **`setRatio`** приводит долю к 0.1–0.9. Пиксельный минимум держит интерфейс при
  перетаскивании (2.4).
- **`reopenClosed`** снимает первую из `closedTabs` и открывает её в активной группе.
  Если такая вкладка уже открыта — фокус.
- **`pruneLayout`** выкидывает вкладки, для которых `alive` ложно, и схлопывает
  опустевшие группы. Пустой корень остаётся пустой группой.
- **`parseWorkLayout`** проверяет форму узлов, вид и поля вкладок, пересчитывает
  `activeGroupId`, если он битый. Любая ошибка формы → `null`.

**Тесты**
1. `openTab` уже открытой вкладки из другой группы: групп и вкладок столько же, фокус
   на ней.
2. `openTab` в группу `{ groupId, index: 0 }` ставит вкладку первой.
3. Закрытие последней вкладки некорневой группы: группа удалена, сплит заменён
   соседом, `validateLayout` пуст.
4. Закрытие последней вкладки корня: корень — пустая группа, `activeTabId: null`.
5. `closedTabs`: 12 закрытий подряд оставляют 10 последних; повторное закрытие той же
   вкладки не дублирует её.
6. `moveTab` внутри строки меняет порядок; в другую группу — переносит, пустая
   исходная удаляется.
7. `moveTab` к каждому из четырёх краёв даёт правильные `direction` и порядок детей.
8. Девятая группа → `too-many-groups`, раскладка та же ссылка по значению (deep equal).
9. `splitGroup` при ширине группы 400 px (`row`) → `too-small`; при 600 px — сплит.
10. `setRatio(…, 0.05)` → 0.1, `(…, 0.95)` → 0.9.
11. `reopenClosed` возвращает последнюю закрытую в активную группу и снимает её со
    стека.
12. `pruneLayout` с «мёртвой» сессией: вкладка убрана, группа схлопнута.
13. `parseWorkLayout` отвергает неизвестный вид вкладки, сплит с одним ребёнком,
    `ratio: 'x'`; принимает результат `JSON.parse(JSON.stringify(layout))`.
14. **Инвариант по диапазону.** Генератор с зерном делает 500 случайных операций из
    таблицы: `open`, `close`, `move` в строку и к краю, `split`, `setRatio`,
    `reopen`, `prune`. После каждой `validateLayout` пуст, а число групп ≤ 8.
15. `tabId` детерминирован. `nodeId` с подставным `random` даёт ожидаемую строку
    `g-xxxxxx`.
16. `splitGroup` вкладкой, уже открытой в другой группе: вкладка одна на раскладку,
    стоит в новой группе; опустевшая исходная группа удалена, `validateLayout` пуст.
17. При 8 группах `moveTab` единственной вкладки группы к краю другой группы разрешён:
    групп по-прежнему 8. Та же операция со второй вкладкой группы →
    `too-many-groups`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 2.2. Хранение раскладки v2 и история

**Зачем.** Раскладка каждой работы переживает перезапуск окна, «назад / вперёд»
помнит путь.
**Зависит от:** 2.1. **Спека:** 3.4, 5.6, 5.7, 5.8.

**Файлы**
- Изменить:
  - `packages/desktop/src/main/layout-store.ts` и тест — формат v2, `remove`, `retain`;
    запись через `atomic-file.ts` (1.1);
  - `src/shared/bridge.ts` — новые `removeLayout` и `retainLayouts`. `loadLayout` и
    `saveLayout` остаются на `unknown` до 2.7: ими же прежний `Workspace` пишет dockview
    под ключом `window`;
  - `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` — каналы
    `app:remove-layout`, `app:retain-layouts`; `app:save-layout` ловит
    `LayoutTooLargeError`;
  - `renderer/test-utils/fake-bridge.ts` — `removeLayout`, `retainLayouts` и журналы
    `layoutRemovals`, `layoutRetains`.
- Создать в `packages/desktop/src/renderer/layout/`:
  - `store.ts` и тест;
  - `persistence.ts` и тест;
  - `history.ts` и тест.

**Интерфейсы**

```ts
// main/layout-store.ts
export interface LayoutsFileV2 { version: 2; works: Record<string, unknown> } // ключ — workKey
export interface LayoutStore {
  load(workKey: string): Promise<unknown | null>;
  save(workKey: string, layout: unknown): Promise<void>;   // предел 1 МБ; очередь и уникальный tmp
  remove(workKey: string): Promise<void>;
  /** Оставляет раскладки только этих работ и ключ `window` прежнего Workspace (до 2.7). */
  retain(workKeys: string[]): Promise<void>;
}

// bridge.ts, дополнение к app
removeLayout(workKey: string): Promise<void>;
retainLayouts(workKeys: string[]): Promise<void>;

// renderer/layout/history.ts — чистые функции над неизменяемыми значениями
export interface HistoryEntry { workKey: string; tabId: string | null; at: number } // at — Date.now() записи, свежесть палитры 6.2
export interface History { entries: readonly HistoryEntry[]; index: number }       // index — текущая запись, -1 — пусто
export const EMPTY_HISTORY: History;
/** Подряд одинаковые (workKey и tabId) не пишутся; хвост «вперёд» обрезается; предел 50. */
export function pushHistory(history: History, entry: HistoryEntry, limit?: number): History;
/** Шаг назад (-1) или вперёд (1) мимо записей, для которых isAlive ложно; null — шагать некуда. */
export function stepHistory(history: History, step: -1 | 1,
  isAlive: (entry: HistoryEntry) => boolean): { history: History; entry: HistoryEntry } | null;
export type Mru = Readonly<Record<string /* workKey */, readonly string[] /* tabId, свежие первыми */>>;
export function touchMru(mru: Mru, workKey: string, tabId: string, limit?: number): Mru;   // 20 на работу
export function removeMru(mru: Mru, workKey: string, tabId: string): Mru;

// renderer/layout/store.ts
export type LayoutOp = (layout: WorkLayout) => WorkLayout | OpResult;
export interface LayoutState {
  /** Владелец активной работы; `ui.json.activeWorkKey` — её копия на диске (persistence). */
  activeWorkKey: string | null;
  layouts: Record<string, WorkLayout>;
  hydrated: Record<string, true>;              // раскладка работы загружена или признана пустой
  /** Операции над работой до её hydrate — применяются по порядку сразу после него. */
  pending: Record<string, LayoutOp[]>;
  history: History;
  mru: Mru;
  /** true на время перехода самой историей: смена работы и вкладки в историю не пишется. */
  navigating: boolean;
  setActiveWork(workKey: string | null): void;
  hydrate(workKey: string, layout: WorkLayout | null): void;
  /** Применяет операцию к раскладке работы; ошибку операции возвращает, раскладку не трогает. */
  apply(workKey: string, op: LayoutOp): OpError | null;
  drop(workKey: string): void;
  back(): void;
  forward(): void;
  canBack(): boolean;
  canForward(): boolean;
  entries(): readonly HistoryEntry[];
}
export const useLayoutStore: UseBoundStore<StoreApi<LayoutState>>;

// renderer/layout/persistence.ts
export function useLayoutPersistence(input: {
  bridge: HarnasBridge; works: WorkEntry[]; worksLoaded: boolean;
  /** workKey в порядке сайдбара: до 3.4 — `orderedWorks`, с 3.4 — `visibleWorkOrder`. */
  order: string[];
}): void;
/** Жива ли вкладка по картам работ; используется при восстановлении. */
export function isTabAlive(entry: WorkEntry, tab: TabSpec): boolean;
/** Соседняя работа в прежнем порядке: следующая, у последней — предыдущая, иначе null. */
export function neighborWork(order: string[], workKey: string): string | null;
```

**Поведение**
- **`layouts.json`.**
  - `version: 1` или битый файл читаются как пустой `{ version: 2, works: {} }`.
  - `save` читает файл, заменяет ключ работы и пишет атомарно.
  - `save`, `remove` и `retain` идут одной очередью на файл через уникальный tmp
    (`atomic-file.ts`, 1.1): таймеры разных работ пишут одновременно и не теряют чужие
    ключи.
  - Больше 1 МБ — `LayoutTooLargeError`, старый файл цел. Обработчик `app:save-layout`
    ловит её, пишет `console.warn` в консоль main и отвечает успехом: рендереру делать
    нечего.
- **Восстановление.** Первый показ работы после `worksLoaded`:
  `loadLayout` → `parseWorkLayout` → `pruneLayout(isTabAlive)` → `hydrate`. `null` →
  `emptyLayout()`. До `worksLoaded` ничего не восстанавливается — правило куска 2.2
  прошлого плана.
- **Операции до `hydrate`.**
  - `apply` над негидрированной работой `layouts` не трогает: операция встаёт в
    `pending[workKey]`, вызов отвечает `null`.
  - `hydrate` кладёт раскладку и сразу применяет очередь по порядку. Операция с ошибкой
    раскладку не меняет.
  - Так поздний `hydrate` не затирает вкладку, открытую кликом по сессии непоказанной
    работы (2.7), новой работой (3.5) или переходом по уведомлению (4.3).
- **`isTabAlive`:**
  - `terminal` и `diff` — сессия есть в карте;
  - `room` — комната есть;
  - `mail` — всегда;
  - `file` — корень есть: проект всегда, worktree — у сессии есть `worktree` с
    `createdAt`;
  - `browser` — всегда.
- **Сохранение.** Изменение раскладки работы пишет её через 500 мс тишины. Таймер свой
  на каждую работу.
- **Первый снимок** после `worksLoaded` зовёт `retainLayouts` с ключами всех его работ:
  раскладки работ, удалённых при закрытом окне, уходят. Работа с битой картой временно
  выпадает из снимка (`readEntry` → `null`), и её раскладка тоже сотрётся — это
  принято.
- **Работа исчезла** из `works.changed` → `drop` и `app.removeLayout`.
- **Активная работа.**
  - Владелец — `activeWorkKey` этого стора. В `ui.json` его пишет только persistence:
    `saveUi({ activeWorkKey })` через 300 мс тишины.
  - На старте берётся из `ui.json`, если такая работа есть, иначе — первая в `order`.
  - Активная работа пропала из снимка (удалена) → активной становится `neighborWork` по
    прежнему `order`; `removeLayout` — только у удалённой. Архивную так же переключит
    3.4.
- **`useLayoutPersistence`** монтирует `AppShell` (2.3) с `order` из `orderedWorks`.
- **История:**
  - запись `{ workKey, tabId, at }` добавляется на каждую смену активной работы или её
    активной вкладки — в `setActiveWork`, `apply` и `hydrate`, кроме переходов самой
    историей (`navigating`). `hydrate` активной работы дописывает `tabId` в её последнюю
    запись, а не делает новую;
  - подряд одинаковые не пишутся, хвост «вперёд» обрезается новой записью, предел 50;
  - `back` и `forward` ставят `navigating`, делают `setActiveWork` и `focusTab` записи и
    снимают флаг. Запись пропускается, если раскладки её работы нет в `layouts` или
    вкладка закрыта;
  - `canBack`, `canForward` и `entries` читают `history` стора, поэтому кнопки
    заголовка (2.3) перерисовываются сами.
- **MRU** — в том же `apply`: `touchMru` при смене активной вкладки активной группы,
  `removeMru` при закрытии вкладки.

**Тесты**
1. `layout-store`: файл v1 → `load` даёт `null`, `save` пишет v2; v2 туда-обратно;
   `remove` убирает ключ; `retain(['a'])` оставляет `a` и `window`; 1 МБ — отказ, файл
   цел; атомарность (подставной `rename`).
2. `store.apply` с `too-many-groups` возвращает ошибку, а `layouts` — прежний объект.
3. `persistence`: пять изменений за 200 мс → одно `saveLayout` на работу; изменения в
   двух работах → два сохранения.
4. До `worksLoaded` нет ни одного `loadLayout`; после — ровно один на показанную
   работу.
5. Восстановление с вкладкой удалённой сессии: её нет, пустая группа схлопнута.
6. Работа пропала из снимка → `removeLayout(workKey)`.
7. `history`: 60 записей → 50; повтор подряд не пишется; `stepHistory(-1)` после двух
   записей возвращает первую; запись после шага назад обрезает «вперёд»; мёртвая запись
   пропускается; `at` записи — время подставных часов.
8. `mru`: 25 касаний → 20; `removeMru` убирает; порядок — свежие первыми.
9. `layout-store`: два параллельных `save` разных работ без `await` между ними — обе
   раскладки на диске; `save` одной работы параллельно с `remove` другой — тоже.
10. `store`: `apply(openTab)` над негидрированной работой → `null`, в `layouts` её нет;
    `hydrate` с сохранённой раскладкой — в ней и сохранённые вкладки, и вкладка из
    `apply`.
11. `store`: после двух смен вкладки `canBack()` истинно; `back()` возвращает прежнюю
    вкладку и новой записи не пишет; затем `canForward()` истинно, `forward()`
    возвращает обратно.
12. `persistence`: активная работа пропала из снимка → активна следующая по `order`, у
    последней в `order` — предыдущая; `removeLayout` только у пропавшей.
13. `persistence`: первый снимок после `worksLoaded` зовёт `retainLayouts` с ключами его
    работ ровно один раз.
14. `ipc`: `app:save-layout` при `LayoutTooLargeError` пишет `console.warn` и отвечает
    успехом.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 2.3. Оболочка окна: заголовок, сайдбары, строка статуса, пустые состояния

**Зачем.** Рамка окна как у Orca, в которую встанут группы и вкладки.
**Зависит от:** 2.2. **Спека:** 4.4, 5.1, 5.9, 5.10.

**Файлы**
- Создать:
  - `packages/desktop/src/main/window.ts` и тест;
  - в `packages/desktop/src/renderer/shell/`: `AppShell.tsx`, `Titlebar.tsx`,
    `Resizer.tsx`, `Landing.tsx`, `ErrorBoundary.tsx` и тесты.
- Перенести: `renderer/components/StatusBar.tsx` → `renderer/shell/StatusBar.tsx`.
- Изменить:
  - `src/main/index.ts` — `createMainWindow` вместо `createSecureWindow`; канал
    `app:titlebar-double-click`;
  - `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/bridge.ts` —
    `app.titlebarDoubleClick()`;
  - `src/main/menu.ts`, `src/shared/bridge.ts` — `MenuAction` `'new-work'` и
    `'toggle-left-sidebar'`: пункт «Новая работа» ⌘N в меню «Сессия», меню «Вид» с
    пунктом «Сайдбар работ» ⌘B;
  - `renderer/test-utils/fake-bridge.ts` — `titlebarDoubleClick` с журналом вызовов;
  - `renderer/store/ui.ts` и тест — зеркало всего `ui.json` и `patchUi`, сайдбары,
    состояния палитры, выбора сессии и диалогов (интерфейс ниже);
  - `renderer/App.tsx` — рендерит `AppShell`;
  - `renderer/components/layout/Workspace.tsx` — палитру и выбор сессии больше не
    монтирует и не держит в своём state; `WorkspaceHandle` + `openBeside`,
    `closeActivePanel`;
  - `renderer/components/sidebar/Sidebar.tsx` — `NewWorkDialog` и `CreateRoomDialog`
    больше не монтирует: «+ работа» и «Создать комнату с…» открывают их через
    `store/ui.ts`;
  - `renderer/components/settings/SettingsDialog.tsx` — вид и уведомления через
    `setAppearance` и `patchUi` стора;
  - E2E `smoke.spec.ts`, `terminal.spec.ts`, `grid.spec.ts`, `layout.spec.ts` —
    готовность окна ждут по `getByTestId('landing')`, а не по тексту «Работ пока нет».
- Удалить: `src/main/security.ts` — защита навигации переезжает в `window.ts`.

**Интерфейсы**

```ts
// main/window.ts
export function mainWindowOptions(input: { dark: boolean; preloadPath: string }): BrowserWindowConstructorOptions;
/** Запрет навигации, кроме своего index.html, и window.open → deny; отдельно — ради теста на подставном webContents. */
export function guardNavigation(webContents: Pick<WebContents, 'on' | 'setWindowOpenHandler'>, indexUrl: string): void;
/** Окно с прежней защитой: contextIsolation, sandbox, guardNavigation. */
export function createMainWindow(input: {
  dark: boolean; preloadPath: string; indexHtmlPath: string; search?: string;
}): BrowserWindow;

// renderer/store/ui.ts, дополнение к UiState
ui: UiFile;                          // зеркало ui.json; до загрузки — DEFAULT_UI
uiLoaded: boolean;
/** Единственный путь записи ui.json из рендерера: патч сразу сливается в зеркало и уходит в app.saveUi. */
patchUi(patch: Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>): void;
/** app.setAppearance (ui.json пишет main, 1.1) и appearance в зеркале. */
setAppearance(mode: Appearance): void;
/** Сливает patch с объектом сайдбара из зеркала и отдаёт его целиком в patchUi. */
setSidebar(side: 'left' | 'right', patch: { open?: boolean; width?: number }): void;
paletteOpen: boolean;
setPaletteOpen(open: boolean): void;
/** Выбор сессии для ⌘D и ⇧⌘D: работа, сторона и уже открытые сессии — их в списке нет. */
picker: { workKey: string; direction: 'right' | 'down'; openSessionIds: string[] } | null;
openPicker(picker: NonNullable<UiState['picker']>): void;
closePicker(): void;
// DialogsState + createRoom; requiredMember обязателен до 3.4
createRoom: { projectPath: string; workId: string; requiredMember: { id: string; label: string } } | null;
openCreateRoomDialog(input: NonNullable<DialogsState['createRoom']>): void;
closeCreateRoomDialog(): void;

// components/layout/Workspace.tsx, дополнение к WorkspaceHandle (живёт до 2.7)
/** Открыть сессию рядом с активной панелью — выбор в SessionPicker. */
openBeside(ref: SessionRef, workKey: string, title: string, direction: 'right' | 'down'): void;
closeActivePanel(): void;

// renderer/shell/Resizer.tsx
export function clampWidth(width: number, min: number, max: number): number;
export interface ResizerProps {
  side: 'left' | 'right';
  width: number; min: number; max: number;
  target: React.RefObject<HTMLElement>;       // чью ширину двигать в DOM во время перетаскивания
  onCommit(width: number): void;              // только на pointerup
}

// renderer/shell/ErrorBoundary.tsx
export interface ErrorBoundaryProps { title: string; onClose?: () => void; children: React.ReactNode }
```

**Поведение**
- **`mainWindowOptions`:**
  - `titleBarStyle: 'hiddenInset'`, `trafficLightPosition: { x: 16, y: 12 }`;
  - `minWidth: 800`, `minHeight: 500`, `width: 1280`, `height: 800`;
  - `backgroundColor` `#0a0a0a` или `#ffffff`;
  - `webPreferences`: `contextIsolation: true`, `sandbox: true`,
    `nodeIntegration: false`, `preload`.
  - `setWindowOpenHandler → deny` и отказ в `will-navigate` на всё, кроме своего
    `index.html`, — как в `security.ts`; это делает `guardNavigation`.
- **Заголовок 36px:**
  - `-webkit-app-region: drag`; `no-drag` — у кнопок, полей и слота `#titlebar-tabs`
    (спека 5.1);
  - слева отступ 80px, затем кнопки «сайдбар работ» (⌘B), «назад» и «вперёд». Эти две
    зовут `back()` и `forward()` `layout/store.ts` и неактивны, пока `canBack()` и
    `canForward()` ложны;
  - справа: поле «Поиск ⌘J» — `setPaletteOpen(true)`, нынешняя палитра до 6.2; «правый
    сайдбар» неактивен до 7.2;
  - двойной клик по пустому месту — `app.titlebarDoubleClick()`. Main делает то, что
    велит `AppleActionOnDoubleClick` из `systemPreferences.getUserDefault`:
    `Maximize` — zoom, `Minimize` — свернуть.
- **Сайдбары.**
  - Левый по `ui.leftSidebar` зеркала. ⌘B — пункт «Сайдбар работ» меню «Вид»
    (`toggle-left-sidebar`) → `setSidebar('left', { open: !open })`.
  - `Resizer` на `pointermove` меняет `style.width` цели через
    `requestAnimationFrame` и кладёт прозрачный оверлей поверх центра.
  - На `pointerup` — `onCommit`: `setSidebar(side, { width })`, пересчёт размеров
    терминалов.
  - Свёрнутый сайдбар — `width: 0`, содержимое размонтировано.
- **Зеркало `ui.json`.**
  - `init` стора грузит `app.loadUi()` в `ui` и ставит `uiLoaded`.
  - Все записи `ui.json` из рендерера идут через `patchUi` и `setAppearance`. Массивы
    и вложенные объекты берутся из зеркала, поэтому компоненты с устаревшей копией не
    затирают друг друга.
  - `activeWorkKey` пишет только `layout/persistence.ts` (2.2), зеркало его не читает.
- **Центр и диалоги.**
  - Центр `AppShell` до 2.7 — прежний `Workspace`. Новый центр появится в 2.4 за
    флагом `?center=new`.
  - `AppShell` монтирует `CommandPalette`, `SessionPicker`, `NewWorkDialog` и
    `CreateRoomDialog` по состояниям `store/ui.ts` — и при `Landing` тоже.
  - Палитра строит команды `buildCommands` с действиями через `WorkspaceHandle`.
  - `Workspace` на меню `split-right` и `split-down` зовёт `openPicker` с работой
    активной панели. Выбор в `SessionPicker` → `openBeside`.
  - Меню `palette` слушает `AppShell` → `setPaletteOpen(true)`; `new-work` (⌘N) →
    `openNewWorkDialog()`.
  - `AppShell` зовёт `useLayoutPersistence` (2.2).
- **Строка статуса** 24px, сегменты 1, 4 и 5 спеки 5.9: связь с хостом, последнее
  уведомление хоста, будильник. Сегменты 2 и 3 добавят 3.1 и 4.2.
- **`Landing`** — если работ нет (`works.length === 0` после загрузки): плитка
  `size-20 rounded-2xl`, «Harnas», кнопки «Новая работа ⌘N» (`openNewWorkDialog()`) и
  «Палитра ⌘J» (`setPaletteOpen(true)`). Корень — `data-testid="landing"`, у оболочки
  с работами — `data-testid="app-shell"`.
- **E2E.** Четыре прежних сценария ждут готовности окна по `getByTestId('landing')`:
  строки «Работ пока нет» у `Landing` нет (спека 5.10).
- **`ErrorBoundary`** показывает `title`, текст ошибки, «Повторить» и «Закрыть», если
  есть `onClose`. «Повторить» перемонтирует детей: `key + 1`. Оборачивает сайдбар,
  центр и правый сайдбар; вкладки обернёт 2.4.

**Тесты**
1. `mainWindowOptions({ dark: true })`: `hiddenInset`, `trafficLightPosition`,
   `minWidth` 800, `minHeight` 500, `backgroundColor` `#0a0a0a`, `sandbox` и
   `contextIsolation` — `true`, `nodeIntegration` — `false`, `webviewTag` не задан.
2. `guardNavigation` на подставном `webContents`: `will-navigate` на
   `https://example.com` отменён, на свой `index.html` — нет; `window.open` — `deny`.
3. `clampWidth(600, 220, 500)` → 500, `(100, 220, 500)` → 220.
4. `Resizer`: `pointermove` не зовёт `onCommit`; `pointerup` зовёт один раз с
   приведённой шириной.
5. `ErrorBoundary`: ребёнок бросает → видны заголовок и текст; «Повторить» монтирует
   ребёнка заново — счётчик монтирований 2.
6. `AppShell` без работ показывает `Landing`; с работой — сайдбар и центр.
7. Кнопки заголовка: «сайдбар» переключает `ui.leftSidebar.open` и зовёт `app.saveUi`
   с целым `leftSidebar`; «назад» неактивна, пока `canBack()` ложно, и активна после
   двух смен вкладки в `layout/store.ts`.
8. `store/ui.ts`: `patchUi({ pinnedWorks: ['a'] })` и сразу
   `patchUi({ collapsedProjects: ['/p'] })` — в зеркале оба, `app.saveUi` получил два
   патча по одному ключу; `setSidebar('left', { width: 300 })` сохраняет `open`.
9. `AppShell` на `Landing`: кнопка «Новая работа» и меню `new-work` открывают
   `NewWorkDialog`; меню `palette` открывает `CommandPalette`. С работой меню
   `toggle-left-sidebar` сворачивает сайдбар, «Поиск ⌘J» открывает палитру.
10. `Workspace` на меню `split-right` зовёт `openPicker` с работой активной панели;
    выбор в `SessionPicker` из `AppShell` зовёт `openBeside`.
11. `SettingsDialog`: «Тёмная» зовёт `setAppearance('dark')` стора, «звук» —
    `patchUi({ notifications })` с остальными ключами из зеркала.

**Приёмка**
- [ ] Все тесты зелёные, прежние E2E зелёные с новым ожиданием готовности.
- [ ] `pnpm dev:desktop`: светофор macOS на месте, окно тащится за заголовок, двойной
      клик увеличивает окно (ручная проверка).

---

## 2.4. Группы и вкладки

**Зачем.** Раскладка видна: сплиты, строки вкладок, тела вкладок.
**Зависит от:** 2.3. **Спека:** 5.3, 5.10.

**Файлы**
- Создать в `packages/desktop/src/renderer/layout/`:
  - `LayoutView.tsx`, `SplitView.tsx`, `GroupView.tsx`, `TabStrip.tsx`, `Tab.tsx` и
    тесты;
  - `tab-meta.ts` и тест;
  - `bodies/MailBody.tsx`, `bodies/RoomBody.tsx`, `bodies/DiffBody.tsx`,
    `bodies/MissingBody.tsx`, `bodies/TerminalBody.tsx`. В 2.4 терминал рисуется
    прямо в теле, в 2.5 переезжает в слой;
  - `keys.ts` и тест — временные сочетания до 6.1.
- Изменить:
  - `renderer/shell/Titlebar.tsx` — слот `#titlebar-tabs`;
  - `renderer/shell/AppShell.tsx` — новый центр за флагом `?center=new`;
  - `src/main/index.ts` — `center=new` в `search` окна при `HARNAS_DESKTOP_CENTER=new`,
    как `renderer=dom` при `HARNAS_TERMINAL_RENDERER=dom`;
  - `renderer/lib/keys.ts` и тест — `TerminalKeyEvent` знает `ctrlKey`, `shiftKey`,
    `key`; окну отдаются ⌃Tab, ⌃⇧Tab и ⌃1–9;
  - `src/main/menu.ts` — «Вернуть закрытую» ⌘⇧T, `MenuAction` `'reopen-tab'`;
  - `src/shared/bridge.ts` — `MenuAction` дополнен.

**Интерфейсы**

```ts
// layout/tab-meta.ts
export interface TabMeta {
  title: string;
  icon: 'terminal' | 'mail' | 'room' | 'diff' | 'file' | 'browser';
  session: WorkSession | null;       // для точки состояния и значка агента
  unread: boolean;                   // в этапе 2 всегда false; подключит 4.2
  dirty: boolean;                    // в этапе 2 всегда false; подключит 7.3
  favicon: string | null;            // в этапе 2 всегда null; подключит 9.2
}
export function tabMeta(tab: TabSpec, entry: WorkEntry | null): TabMeta;
/** Обрезка по кодовым точкам: суррогатная пара не рвётся, в конце «…». */
export function truncateTitle(title: string, max?: number): string;   // 40

// layout/LayoutView.tsx
export function LayoutView(props: { workKey: string }): JSX.Element;

// layout/keys.ts — временно, до 6.1
/** ⌃Tab, ⌃⇧Tab, ⌃1–9, ⌘⇧[, ⌘⇧] — рендерер ловит сам, в меню их нет. */
export function layoutKeyAction(event: KeyboardEvent):
  | { kind: 'mru'; step: 1 | -1 } | { kind: 'tab-index'; index: number }
  | { kind: 'tab-step'; step: 1 | -1 } | null;

// lib/keys.ts
export interface TerminalKeyEvent {
  readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly key: string;
}
```

**Поведение**
- **Новый центр за флагом.**
  - С 2.4 до 2.7 центр `AppShell` — прежний `Workspace`. С `?center=new` — `LayoutView`
    активной работы, а `Workspace` не монтируется.
  - Флаг читается из `location.search` один раз при загрузке.
  - При флаге `AppShell` сам обслуживает меню `close-panel`, `reopen-tab`,
    `prev-panel`, `next-panel`, `split-right`, `split-down` и действия палитры
    «открыть»: `setActiveWork` и `apply(openTab)` в `layout/store.ts`.
  - Входы сайдбара подключит 2.5; E2E до 2.7 идут без флага.
- **Сплит.** `SplitView` — flex по `ratio`. Разделитель: видимая линия 3px
  `--split-divider` (strong на hover), зона захвата 8px. Во время перетаскивания доля
  пишется в DOM, `setRatio` — на `pointerup`, с пиксельным минимумом 240×160.
- **Строка вкладок.**
  - Одна группа — `TabStrip` порталом в `#titlebar-tabs`, вкладки там — `no-drag`.
    Иначе — строка 32px над телом каждой группы.
  - Вид вкладок, крестика и кнопки «+» — спека 5.3. «+» — `setPaletteOpen(true)`:
    нынешняя палитра до 6.2, смонтированная в `AppShell` (2.3).
  - Горизонтальная прокрутка колесом, затухание у краёв.
- **Пустая группа** (корень пустой работы) — текст «Откройте сессию из сайдбара, ⌘T —
  новая сессия» (спека 5.8).
- **Вкладка:**
  - клик — `focusTab`, средняя кнопка — `closeTab`;
  - меню: «Закрыть», «Закрыть остальные», «Закрыть справа», «Разделить вправо»,
    «Разделить вниз» — два последних открывают выбор сессии, как ⌘D;
  - закрытие показывает тост «Вкладка закрыта — ⌘⇧T вернёт».
- **Тела вкладок**, каждое в `ErrorBoundary` с `onClose`:
  - `mail` — `MailPanel`, `room` — `RoomPanel`, `diff` — нынешний `ChangesPanel`
    (до 8.3), `terminal` — `TerminalPanel` (до 2.5);
  - нет сессии или комнаты в карте — `MissingBody`: «Сессия удалена» или «Комната
    удалена», и «Закрыть».
- **Клавиши этапа 2:**

| Действие меню или клавиша | Что делает |
|---|---|
| `close-panel` | закрыть активную вкладку |
| `reopen-tab` | вернуть закрытую |
| `prev-panel` / `next-panel` | фокус на предыдущую или следующую группу в визуальном порядке |
| `split-right` / `split-down` | `openPicker` с активной работой и её открытыми сессиями → выбор → `splitGroup` активной группы с `sizes` из DOM |
| ⌃Tab / ⌃⇧Tab | MRU вперёд / назад |
| ⌃1–9 | вкладка по номеру в активной группе |
| ⌘⇧[ / ⌘⇧] | предыдущая / следующая вкладка группы |

  - `lib/keys.ts#shouldForwardToTerminal` отдаёт окну ⌃Tab, ⌃⇧Tab и ⌃1–9.
- **Отказ сплита** (`too-many-groups`, `too-small`) — тост «Слишком мало места для ещё
  одной группы» или «Не больше 8 групп в работе».

**Тесты**
1. Одна группа — `TabStrip` внутри `#titlebar-tabs`. Две группы — две строки в телах,
   слот заголовка пуст.
2. У активной вкладки `data-active="true"` и нижняя полоса. Средняя кнопка закрывает.
3. «Закрыть остальные» оставляет одну вкладку, «Закрыть справа» — вкладки слева и
   текущую.
4. `layoutKeyAction`: ⌃2 → `{ tab-index: 1 }`, ⌃Tab → `mru +1`, ⌘⇧] → `tab-step +1`,
   ⌘J → `null`.
5. `shouldForwardToTerminal`: ⌃Tab, ⌃1 → `false`; ⌃C, ⌃A → `true`.
6. `tabMeta`: заголовки всех шести видов по спеке 5.3. У `diff` с `commit` —
   `Изменения S02 · <7 символов hash>`.
7. `truncateTitle('🙂'.repeat(50), 40)` — 40 эмодзи и «…», без одиночных суррогатов.
8. Вкладка удалённой сессии → `MissingBody`, «Закрыть» убирает вкладку.
9. Перетаскивание разделителя: во время движения `setRatio` не зовётся, на отпускании
   — один раз.
10. Сплит при 8 группах → тост и раскладка без изменений.
11. `Tab`: крестик неактивной вкладки скрыт до hover (`opacity-0`,
    `group-hover:opacity-100`), у активной — виден (спека 14.2).
12. Пустая корневая группа показывает «Откройте сессию из сайдбара, ⌘T — новая
    сессия».
13. `AppShell` с `?center=new`: `Workspace` не смонтирован; меню `split-right`
    открывает выбор сессии без уже открытых; выбор → две группы в раскладке активной
    работы; «+» строки вкладок открывает палитру.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] С `HARNAS_DESKTOP_CENTER=new pnpm dev:desktop`: вкладки в заголовке при одной
      группе, по группам — при нескольких (ручная проверка).

---

## 2.5. Слой поверхностей и терминал

**Зачем.** Перенос вкладки терминала между группами не пересоздаёт xterm и не
переподключает PTY.
**Зависит от:** 2.4. **Спека:** 5.5.

**Шаг 0 — проба платформы.** `CSS.supports('anchor-name', '--a')` не годится: он
отвечает `true`, даже когда якорь недействителен для этой разметки.
- В `HARNAS_DESKTOP_CENTER=new pnpm dev:desktop`, в DevTools окна, собрать пробу той же
  формы, что у слоя:
  - контейнер `position: absolute; inset: 0`;
  - в нём тело `anchor-name: --probe` с отступами и размером 100×50;
  - соседний блок без `position`, `transform` и `contain`, а в нём поверхность:
    `position: absolute; position-anchor: --probe; top: anchor(top); left: anchor(left);
    width: anchor-size(width); height: anchor-size(height)`.
- `getBoundingClientRect()` поверхности совпал с телом (±1 px) — путь якорей. Иначе
  реализуется запасной путь `layout/anchor-fallback.ts` (ниже), а в `TODOS.md` пишется
  причина.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/layout/SurfaceLayer.tsx` и тест;
  - `packages/desktop/src/renderer/layout/lru.ts` и тест;
  - `packages/desktop/src/renderer/terminal/TerminalSurface.tsx` и тест — по образцу
    `components/terminal/TerminalPanel.tsx`. Сам `TerminalPanel.tsx` остаётся телом
    панели прежнего центра до 2.7 и берёт `use-terminal` из нового места;
  - при провале шага 0 — `packages/desktop/src/renderer/layout/anchor-fallback.ts` и
    тест.
- Перенести вместе с тестами:
  - `renderer/components/terminal/use-terminal.ts` → `renderer/terminal/use-terminal.ts`;
  - `renderer/components/terminal/xterm-themes.ts` → `renderer/terminal/xterm-themes.ts`.
- Изменить:
  - `components/terminal/TerminalPanel.tsx` — импорты из `renderer/terminal/`;
  - `layout/GroupView.tsx` — тело группы объявляет `anchor-name: --g-<groupId>`;
  - `layout/LayoutView.tsx` — проп `active`;
  - `layout/bodies/TerminalBody.tsx` — пустое место-заглушка, сам терминал в слое;
  - `terminal/use-terminal.ts` — `pty.resize` только у видимой поверхности;
  - `shell/AppShell.tsx` — контейнеры работ LRU; входы сайдбара при `?center=new` идут
    в `layout/store.ts`.

**Интерфейсы**

```ts
// layout/lru.ts
export interface Lru<K> { touch(key: K): K[]; has(key: K): boolean; keys(): K[] }  // touch возвращает вытесненные
export function createLru<K>(limit: number): Lru<K>;

// layout/LayoutView.tsx — с 2.5
export function LayoutView(props: { workKey: string; active: boolean }): JSX.Element;

// layout/SurfaceLayer.tsx — шрифт из settings.get, как прежде через Workspace
export function SurfaceLayer(props: {
  workKey: string; active: boolean; fontFamily: string; fontSize: number;
}): JSX.Element;

// terminal/TerminalSurface.tsx
export interface TerminalSurfaceProps {
  sessionRef: SessionRef;
  tabId: string;
  groupId: string;          // якорь `--g-<groupId>`
  visible: boolean;
  fontFamily: string; fontSize: number;
}
export interface TerminalSurfaceHandle { focus(): void; scrollToBottom(): void; search: SearchAddon | null }
/** Реестр живых поверхностей для фокуса, прокрутки и поиска (4.3, 5.3). */
export const terminalSurfaces: Map<string /* refKey */, TerminalSurfaceHandle>;

// layout/anchor-fallback.ts — только если шаг 0 провалился
export function useAnchorRect(groupId: string): { top: number; left: number; width: number; height: number } | null;
```

**Поведение**
- **Контейнер работы.** `AppShell` держит контейнеры трёх последних активных работ (LRU
  по `activeWorkKey`):
  - контейнер — `position: absolute; inset: 0` в центре. Внутри сначала `LayoutView`
    этой работы, затем её `SurfaceLayer`;
  - контейнер — containing block поверхностей, а тела групп — его потомки. Поэтому
    `anchor()` действительны: якорь обязан быть потомком containing block
    позиционируемого элемента;
  - `SurfaceLayer` своего containing block не создаёт: без `position`, `transform`,
    `contain`, `filter`;
  - у неактивных работ контейнер скрыт (`visibility: hidden`, `inert`), но `LayoutView`
    смонтирован, и якоря живы;
  - вытесненный из LRU контейнер размонтируется: xterm освобождаются, `pty.detach`.
- **`LayoutView` с `active: false`** не порталит строку вкладок в `#titlebar-tabs` и не
  ловит клавиши 2.4.
- **Поверхности.** Слой рисует `TerminalSurface` на каждую вкладку `terminal` раскладки
  работы. Ключ React — id вкладки, поэтому перенос вкладки не меняет ключ.
- **Позиция.** `position: absolute; position-anchor: --g-<groupId>; top: anchor(top);
  left: anchor(left); width: anchor-size(width); height: anchor-size(height)`. При
  переносе меняется только `--g-<groupId>`. `anchor-name` и `position-anchor`
  задаются через `el.style.setProperty` или объект с приведением к `CSSProperties`: в
  `CSSProperties` @types/react 18 их нет.
- **Видимость.** Вкладка активна в своей группе **и** работа активна → видима. Иначе
  `visibility: hidden` и атрибут `inert`. `inert` ставится через ref
  (`toggleAttribute('inert', …)`): в React 18 это не булев проп. `visible` уходит в
  `use-terminal.ts` — подключение по видимости, как сейчас: `pty.attach` при
  появлении, `pty.detach` при скрытии.
- **Размер.** После изменения ширины сайдбара или доли сплита `fit()` и `pty.resize` —
  прежний механизм `ResizeObserver` с тишиной 50 мс, но только у видимой поверхности.
  Скрытая изменения размера пропускает, при появлении делает `fit()` и `pty.resize`.
- **`data-mount-id`.** Корень `TerminalSurface` несёт `data-tab-id` и `data-mount-id` —
  случайный id, заданный один раз при монтировании. Его проверяет E2E 2.7: перенос
  вкладки не меняет id.
- **Реестр `terminalSurfaces`** пополняется при монтировании и чистится при
  размонтировании.
- **Входы сайдбара при `?center=new`:**
  - клик по сессии → `setActiveWork` её работы + `apply(openTab(terminal))`;
  - «вся почта», комната, «изменения» → сначала `setActiveWork` той работы, по
    которой кликнули (id `mail` общий на раскладку), затем `apply(openTab)`.

**Тесты**
1. `createLru(3)`: четвёртый ключ вытесняет первый; повторное касание обновляет
   порядок.
2. Перенос вкладки терминала в другую группу: конструктор подставного `Terminal`
   вызван один раз; вызовов `pty.attach` в подставном бридже не прибавилось;
   `data-mount-id` прежний.
3. Вкладка стала неактивной → `pty.detach`, снова активной → `pty.attach` со снимком.
4. Активация четырёх работ подряд: контейнер первой размонтирован (`Terminal.dispose`
   вызван), возврат к ней создаёт терминал заново и подключает.
5. `terminalSurfaces` содержит ключ, пока поверхность смонтирована.
6. При запасном пути — `useAnchorRect` отдаёт прямоугольник тела группы и
   обновляется на `ResizeObserver`.
7. Три работы в LRU: у каждой свой контейнер, в нём `LayoutView` раньше
   `SurfaceLayer`; у `SurfaceLayer` нет ни классов, ни инлайн-стилей `position`,
   `transform`, `contain`.
8. Неактивная работа LRU: тела её групп в DOM, контейнер с `visibility: hidden` и
   `inert`; в `#titlebar-tabs` — строка вкладок только активной работы.
9. Невидимая поверхность на `ResizeObserver` не шлёт `pty.resize`; видимая — шлёт через
   50 мс.
10. При `?center=new` клик по «Почта» работы B, пока активна A: активна B, вкладка
    `mail` в раскладке B.

**Приёмка**
- [ ] Шаг 0 выполнен, результат записан в описании коммита.
- [ ] Все тесты зелёные.
- [ ] С флагом `?center=new`: терминал встаёт ровно в тело своей группы, перенос между
      группами не мигает и не теряет прокрутку (ручная проверка).

---

## 2.6. Перетаскивание

**Зачем.** Вкладки и сессии раскладываются мышью, как у Orca.
**Зависит от:** 2.5. **Спека:** 5.4.

**Файлы**
- Создать: `packages/desktop/src/renderer/layout/dnd.ts` и тест,
  `packages/desktop/src/renderer/layout/DropIndicator.tsx`.
- Изменить:
  - `shell/AppShell.tsx` — один `DndContext` с сенсорами, `DragOverlay` и
    `onDragEnd → applyDrop` над сайдбаром, заголовком и центром;
  - `layout/LayoutView.tsx`, `TabStrip.tsx`, `GroupView.tsx` — только droppable и
    sortable: сортируемые вкладки, зоны броска; своего `DndContext` нет;
  - `components/sidebar/SessionTree.tsx` — строка сессии активной работы становится
    перетаскиваемой через `@dnd-kit`; HTML5-перетаскивание уходит. Без флага
    `?center=new` сессии в старый центр до 2.7 не перетаскиваются: он уходит в 2.7;
  - `packages/desktop/package.json` — `@dnd-kit/core`, `@dnd-kit/sortable`.

**Интерфейсы**

```ts
// layout/dnd.ts
export type DragItem = { kind: 'tab'; tabId: string } | { kind: 'session'; sessionId: string };
export type DropZone =
  | { kind: 'strip'; groupId: string; index: number }
  | { kind: 'center'; groupId: string }
  | { kind: 'edge'; groupId: string; edge: Edge };
export interface RectLike { left: number; top: number; width: number; height: number }
/** Центр или край: край — 25% ширины или высоты; в углу побеждает ближайшая сторона. */
export function zoneForPoint(point: { x: number; y: number }, body: RectLike, groupId: string): DropZone;
export function applyDrop(layout: WorkLayout, item: DragItem, zone: DropZone, sizes: GroupSizes): OpResult;
/** onDragEnd @dnd-kit → что бросили (`active.data`) и куда (`over.data` + zoneForPoint); null — мимо зон. */
export function dropFromDragEnd(event: DragEndEvent): { item: DragItem; zone: DropZone } | null;
```

**Поведение**

| Что тащат → куда | Итог |
|---|---|
| Вкладку → строку вкладок | `moveTab` на индекс |
| Вкладку → центр тела | `moveTab` последней в группу |
| Вкладку → край тела | `moveTab` с `edge` |
| Сессию → строку, центр или край | `openTab(terminal)` в зону. Если вкладка уже открыта — `moveTab` туда |

- **Один `DndContext` — в `AppShell`.** Строка сессии живёт в сайдбаре, а зоны броска —
  в центре. `useDraggable` вне провайдера получает контекст по умолчанию и молча не
  тащит, поэтому провайдер накрывает сайдбар, заголовок и центр. `onDragEnd` —
  `dropFromDragEnd` и `apply(activeWorkKey, applyDrop(…))`.
- **Индикаторы** — спека 5.4: линия 2px blue-500 в строке, подсветка тела,
  полупрозрачная половина у края.
- **Сессии неактивной работы** не тащатся: курсор `not-allowed`, активатор `@dnd-kit`
  выключен.
- **Отказ операции** — тост из 2.4.

**Тесты**
1. `zoneForPoint`:
   - точка в центре → `center`;
   - `x` на 24% ширины → `edge left`, на 26% → `center`;
   - угол (5%, 5%) → ближайшая сторона.
2. `applyDrop` вкладки в строку другой группы на индекс 0 → вкладка первая там.
3. `applyDrop` вкладки к правому краю → сплит `row`, новая группа второй.
4. `applyDrop` сессии в центр → вкладка терминала создана в группе. Та же сессия, уже
   открытая в другой группе, переносится.
5. `applyDrop` к краю при 8 группах → `too-many-groups`.
6. У строки сессии неактивной работы нет `data-draggable`.
7. `dropFromDragEnd`: `active` строки сессии и `over` края тела → `{ kind: 'session' }`
   и `edge`; `over: null` → `null`.
8. `AppShell` с `?center=new`: его `onDragEnd` с `active` строки сессии сайдбара и
   `over` тела группы открывает вкладку терминала в этой группе. Строка и тело — под
   одним `DndContext`.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] С флагом `?center=new` вкладки и строки сессий из сайдбара перетаскиваются мышью
      на все четыре края и в строку (ручная проверка).

---

## 2.7. Переключение работ, сплит с выбором, удаление dockview; приёмка этапа 2

**Зачем.** Центр показывает выбранную работу; dockview и его обвязка уходят.
**Зависит от:** 2.6. **Спека:** 5.6, 5.11.

**Файлы**
- Изменить в `packages/desktop/src/renderer/`:
  - `shell/AppShell.tsx` — новый центр единственный: флаг `?center=new` и ветка
    прежнего `Workspace` уходят; входы сайдбара, меню и палитра идут только в
    `layout/store.ts` (подключены в 2.4–2.5);
  - `App.tsx` — ⌘T: работа — активная (`activeWorkKey`), родитель — `selectedSessionOf`;
    ⌘1–9 → `setActiveWork` N-й работы по порядку создания;
  - `layout/store.ts` и тест — `selectedSessionOf`;
  - `components/palette/CommandPalette.tsx`, `lib/commands.ts` и тест — «открыть» идёт
    через `layout/store.ts`; `lastSessionByWork` уходит (работа открывается своей
    раскладкой), `recentSessionRefs` — из `entries()` истории;
  - `components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx` — подсветка
    выбранной сессии из `selectedSessionOf`;
  - `store/ui.ts` и тест — без `selectedRef`, `selectedWorkKey`, `lastSessionByWork`,
    `recentSessionRefs`, `selectSession`, `activePanelId`, `setActivePanelId`;
    `visibleSessionRefs` считается из раскладки и слоя.
- Изменить вне рендерера:
  - `src/main/menu.ts`, `src/shared/bridge.ts` — `MenuAction` `'history-back'` и
    `'history-forward'`: пункты «Назад» ⌘⌥← и «Вперёд» ⌘⌥→ в меню «Вид»; `loadLayout`
    и `saveLayout` — на `WorkLayout`;
  - `src/main/index.ts` — без флага `center=new`;
  - `src/main/layout-store.ts` и тест — `retain` больше не бережёт ключ `window`.
- Удалить:
  - `renderer/components/layout/Workspace.tsx`, `panel-registry.tsx`,
    `use-layout-persistence.ts`, `sidebar-drag.ts` и их тесты;
  - `renderer/components/terminal/TerminalPanel.tsx` и тест — тело панели прежнего
    центра;
  - `renderer/lib/panel-id.ts` и тест;
  - `renderer/styles/dockview.css`;
  - зависимость `dockview-react`.
- E2E:
  - `e2e/grid.spec.ts` → `e2e/shell.spec.ts`;
  - `e2e/layout.spec.ts` — переписан под раскладку на работу.
- Документы: `README.md`, раздел «Окно» — раскладка на работу, вкладки, сплиты, ⌘D,
  ⌘⇧T, ⌃Tab, ⌘⌥←/→.

**Интерфейсы**

```ts
// layout/store.ts, дополнение
/** Выбранная сессия: активная работа и терминал активной вкладки её активной группы; иначе null. */
export function selectedSessionOf(
  state: Pick<LayoutState, 'activeWorkKey' | 'layouts'>, works: WorkEntry[],
): { workKey: string; ref: SessionRef } | null;
```

**Поведение**
- **Выбор сессии выводится, а не хранится.** `Workspace`, который писал `selectedRef`
  и соседей, удалён:
  - ⌘T берёт работу из `activeWorkKey`, родителя новой сессии — из
    `selectedSessionOf`; сайдбар берёт оттуда же подсветку строки;
  - недавние сессии палитры — вкладки-терминалы из `entries()` истории, свежие первыми,
    без повторов, до 20.
- `visibleSessionRefs` для нынешних уведомлений — сессии, чьи вкладки видимы по
  правилу 2.5. Точнее видимость посчитает 4.2.
- ⌘1–9 пока выбирают работу по порядку создания; сайдбарный порядок придёт в 3.4.
- Назад и вперёд — кнопки заголовка и пункты меню «Вид»: `history-back` (⌘⌥←) и
  `history-forward` (⌘⌥→) → `back()` и `forward()` `layout/store.ts`.

**Тесты** (1–4 — E2E, stub-агент, свой хост на тест)
1. `shell.spec.ts`:
   - работа с тремя сессиями; ⌘D (через `menu:action`) и выбор `S02` → две группы;
   - вкладку `S02` мышью к нижнему краю группы `S01` → по-прежнему две группы:
     исходная группа `S02` опустела и удалена (2.1), `S02` стоит под `S01`;
   - закрытие последней вкладки группы схлопывает сплит — группа одна.
2. `shell.spec.ts`, перенос без пересоздания:
   - у поверхности терминала `data-mount-id` — его ставит `TerminalSurface` (2.5);
   - вкладку `S01` переносят в другую группу — `data-mount-id` тот же, текст экрана на
     месте. Тот же `data-mount-id` значит, что второго `pty.attach` не было (спека
     14.3).
3. `shell.spec.ts`: две работы; клик по строке сессии второй работы в сайдбаре — в
   центре раскладка второй; назад (`menu:action` `history-back`) — снова первая.
4. `layout.spec.ts`: у двух работ разные раскладки; окно перезапущено — обе раскладки
   на месте по своим работам.
5. `selectedSessionOf`: активная вкладка-терминал → её сессия; активна вкладка почты →
   `null`; активной работы нет → `null`.
6. Меню `new-session` (⌘T) открывает диалог с `projectPath` и `workId` активной работы
   и родителем из `selectedSessionOf`.

**Приёмка**
- [ ] Все тесты зелёные, все E2E зелёные: прежние `smoke`, `terminal`, `theme` и новые.
- [ ] `grep -rn dockview packages/desktop/src packages/desktop/e2e
      packages/desktop/package.json` пуст; `out/`, `dist/` и `node_modules/` не в счёт.

**Приёмка этапа 2** (человек, на пересобранном `harnas.app`)
- [ ] Две работы с разными раскладками переключаются кликом.
- [ ] Перенос терминала между группами не мигает и не теряет прокрутку.
- [ ] ⌘⌥← возвращает на прежнюю вкладку, ⌘⇧T возвращает закрытую.
- [ ] `README.md` обновлён.
