# План, этап 2: каркас

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, раздел 5, строка 2 таблицы 14.3.

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
/** Чистая операция дерева; человек закрывает вкладки только через requestCloseTabs стора (2.2). */
export function closeTab(layout: WorkLayout, tabId: string): WorkLayout;
/** Поля вкладки без kind и id; растёт по нужде. Пока одно — адрес вкладки браузера (9.2). */
export type TabPatch = { url?: string };
export function updateTab(layout: WorkLayout, tabId: string, patch: TabPatch): WorkLayout;
export function moveTab(layout: WorkLayout, tabId: string,
  target: { groupId: string; index: number } | { groupId: string; edge: Edge }, sizes?: GroupSizes): OpResult;
export function splitGroup(layout: WorkLayout, groupId: string, direction: 'row' | 'column',
  tab: TabSpec, sizes?: GroupSizes): OpResult;
export function setRatio(layout: WorkLayout, splitId: string, ratio: number): WorkLayout;
export function focusGroup(layout: WorkLayout, groupId: string): WorkLayout;
export function focusTab(layout: WorkLayout, tabId: string): WorkLayout;
export function reopenClosed(layout: WorkLayout): WorkLayout;
export function pruneLayout(layout: WorkLayout, alive: (tab: TabSpec) => boolean): WorkLayout;
/** Нарушения инвариантов 1–6 спеки 5.2, а также `activeTabId` не из своей группы (`null` — только у пустой). */
export function validateLayout(layout: WorkLayout): string[];
export function parseWorkLayout(raw: unknown): WorkLayout | null;        // разбор с диска; мусор или нарушенный инвариант → null
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
  - `activeGroupId` переходит на соседа. Сосед — сплит → на первую группу его поддерева
    в визуальном порядке (`groups()`).
  - Функция чистая и синхронная: вопрос о несохранённом буфере в неё не встаёт.
    Закрытие человеком идёт через `requestCloseTabs` (2.2).
- **`updateTab`** меняет поля вкладки на месте: id, вид, группа и место в строке те же,
  `closedTabs` не трогается. Нет такой вкладки или поле не её вида (`url` у терминала) —
  прежняя раскладка той же ссылкой.
- **`moveTab` с `edge`** создаёт новую группу с вкладкой на указанной стороне
  целевой группы:
  - `left` и `top` — новая группа первым ребёнком;
  - `row` для `left` и `right`, `column` для `top` и `bottom`;
  - `ratio` 0.5.
  - Перенос единственной вкладки группы к краю этой же группы ничего не меняет.
- **После `moveTab`** перенесённая вкладка — активная в целевой группе, а
  `activeGroupId` — целевая группа; с `edge` — новая группа. На этом держатся тест 2
  куска 2.5 и E2E 2 куска 2.7: перенесённый терминал видим.
- **`splitGroup` с уже открытой вкладкой** переносит её в новую группу, как `moveTab` к
  краю: исходная группа, оставшаяся пустой, удаляется. Единственная вкладка самой
  `groupId` — раскладка без изменений.
- **`splitGroup` и `moveTab` с `edge` отказывают** без изменения раскладки:
  - групп уже 8 и после операции их стало бы 9 — `too-many-groups`. Если исходная
    группа переносимой вкладки исчезает, число групп не растёт, и операция разрешена;
  - по `sizes` целевая группа уже, чем `2 × 240` для `row`, или ниже `2 × 160` для
    `column` — `too-small`;
  - без `sizes` проверяется только число групп.
- **`setRatio`** приводит долю к 0.1–0.9. Нечисловая доля (`NaN`, `±Infinity`) —
  прежняя раскладка той же ссылкой: приведение к 0.1–0.9 `NaN` не ловит, а в jsdom и у
  свёрнутого окна размеры нулевые (2.4). Пиксельный минимум держит интерфейс при
  перетаскивании (2.4).
- **`reopenClosed`** снимает первую из `closedTabs` и открывает её в активной группе.
  Если такая вкладка уже открыта — фокус.
- **`pruneLayout`** выкидывает вкладки, для которых `alive` ложно, и схлопывает
  опустевшие группы. Пустой корень остаётся пустой группой.
- **`parseWorkLayout`** проверяет форму узлов, вид и поля вкладок, пересчитывает
  `activeGroupId`, если он битый. Любая ошибка формы → `null`.
  - Затем `validateLayout`: инварианты по спеке 5.2 проверяются на каждой загрузке.
    Любое нарушение, кроме уже починенного `activeGroupId`, → `null`: дубль id вкладки,
    больше 8 групп, пустая некорневая группа, `activeTabId` не из своей группы.

**Тесты**
1. `openTab` уже открытой вкладки из другой группы: групп и вкладок столько же, фокус
   на ней.
2. `openTab` в группу `{ groupId, index: 0 }` ставит вкладку первой.
3. Закрытие последней вкладки некорневой группы: группа удалена, сплит заменён
   соседом, `validateLayout` пуст. Сосед — сплит: `activeGroupId` — его первая группа
   по `groups()`.
4. Закрытие последней вкладки корня: корень — пустая группа, `activeTabId: null`.
5. `closedTabs`: 12 закрытий подряд оставляют 10 последних; повторное закрытие той же
   вкладки не дублирует её.
6. `moveTab` внутри строки меняет порядок; в другую группу — переносит, пустая
   исходная удаляется. Перенесённая вкладка — `activeTabId` целевой группы,
   `activeGroupId` — целевая.
7. `moveTab` к каждому из четырёх краёв даёт правильные `direction` и порядок детей;
   `activeGroupId` — новая группа.
8. Девятая группа → `too-many-groups`, раскладка — та же ссылка.
9. `splitGroup` при ширине группы 400 px (`row`) → `too-small`; при 600 px — сплит.
10. `setRatio(…, 0.05)` → 0.1, `(…, 0.95)` → 0.9; `NaN` и `Infinity` → та же ссылка на
    раскладку.
11. `reopenClosed` возвращает последнюю закрытую в активную группу и снимает её со
    стека.
12. `pruneLayout` с «мёртвой» сессией: вкладка убрана, группа схлопнута.
13. `parseWorkLayout` отвергает неизвестный вид вкладки, сплит с одним ребёнком,
    `ratio: 'x'`. Отвергает и верную форму с нарушенным инвариантом: дубль id вкладки,
    9 групп, пустая некорневая группа, `activeTabId` не из своей группы. Битый
    `activeGroupId` чинит. Принимает результат `JSON.parse(JSON.stringify(layout))`.
14. **Инвариант по диапазону.** Генератор с зерном делает 500 случайных операций из
    таблицы: `open`, `close`, `move` в строку и к краю, `split`, `setRatio`,
    `reopen`, `prune`, `update`. `setRatio` получает и `NaN`, `±Infinity`. После каждой
    `validateLayout` пуст, а число групп ≤ 8.
15. `tabId` детерминирован. `nodeId` с подставным `random` даёт ожидаемую строку
    `g-xxxxxx`.
16. `splitGroup` вкладкой, уже открытой в другой группе: вкладка одна на раскладку,
    стоит в новой группе; опустевшая исходная группа удалена, `validateLayout` пуст.
17. При 8 группах `moveTab` единственной вкладки группы к краю другой группы разрешён:
    групп по-прежнему 8. Та же операция со второй вкладкой группы →
    `too-many-groups`.
18. `updateTab` вкладки браузера `{ url: 'http://localhost:5173/a' }`: адрес новый, id,
    группа и индекс те же, `validateLayout` пуст. Неизвестный id и `url` у вкладки
    терминала → та же ссылка на раскладку.

**Приёмка**
- [x] Все тесты зелёные.

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
    `layoutRemovals`, `layoutRetains`;
  - `packages/desktop/e2e/layout.spec.ts` — опрос `layouts.json` читает файл v2:
    `file.works.window?.panels` вместо `file.layouts.window?.panels`, тип
    `{ version: 2; works: Record<string, { panels?: Record<string, unknown> }> }`. Без
    этого сценарий не узнаёт файл, который пишет 2.2, и падает по таймауту, а «прежние
    E2E зелёные» нужны до 2.7.
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
/** Вопрос перед закрытием вкладок человеком; false — человек отменил. С 7.3 — несохранённые буферы. */
export type CloseGuard = (workKey: string, tabIds: string[]) => Promise<boolean>;
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
  /**
   * Единственный путь закрытия вкладок человеком: крестик, средняя кнопка, меню вкладки,
   * `close-panel` (⌘W). Сначала guard, потом closeTab по каждой; false — отменено, раскладка та же.
   */
  requestCloseTabs(workKey: string, tabIds: string[]): Promise<boolean>;
  /** null — закрывать без вопроса (до 7.3). */
  setCloseGuard(guard: CloseGuard | null): void;
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
  - `activeWorkKey === null`, а в снимке есть работы (первая работа после пустого
    старта) → активной становится первая в `order`. Иначе после «Новой работы» с
    `Landing` центру нечего показать.
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
    заголовка (2.3) перерисовываются сами;
  - `entries()` отдаёт записи со временем `at`. По ним недавние сессии (2.7), свежесть
    палитры (6.2) и «последняя сессия работы» вкладки «Изменения» (8.2).
- **MRU** — в том же `apply`: `touchMru` при смене активной вкладки активной группы,
  `removeMru` при закрытии вкладки.
- **Закрытие вкладок человеком** — только `requestCloseTabs(workKey, ids)`:
  - сначала `closeGuard` (7.3 спросит про несохранённые буферы); `false` — ничего не
    закрыто, ответ `false`;
  - иначе `apply(closeTab)` по каждой вкладке по порядку, ответ `true`;
  - guard не задан — закрывается сразу.
  - Без вопроса вкладки убирают только `pruneLayout` (мёртвые сессии, комнаты и корни:
    записывать некуда) и `drop` (работа исчезла из снимка).

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
15. `store.requestCloseTabs`: без guard вкладки закрыты, ответ `true`. Guard получил
    `workKey` и id и ответил `false` — раскладка прежняя, ответ `false`. Ответил `true` —
    закрыты обе вкладки из списка.
16. `persistence`: старт без работ, `activeWorkKey` — `null`; пришёл снимок с двумя
    работами → активна первая в `order`, через 300 мс `saveUi({ activeWorkKey })`.
17. E2E `layout.spec.ts`, прежний сценарий на dockview: опрос находит три панели в
    `works.window` файла v2, после перезапуска окна панели на месте.

**Приёмка**
- [x] Все тесты зелёные.
- [x] `e2e/layout.spec.ts` зелёный на файле v2.

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
  - `renderer/App.tsx` — рендерит `AppShell` с пропами `AppShellProps` (ниже).
    `workspaceRef`, `selectWorkByNumber` и подписка на меню `work-1…9` переезжают в
    `AppShell`. В `App` остаются экраны связи (`connecting`, `mismatch`,
    `disconnected`), `settings.get` → шрифт, меню `settings` и `new-session`,
    `NewSessionDialog`, `SettingsDialog` и `Toaster`;
  - `renderer/components/layout/Workspace.tsx` — палитру и выбор сессии больше не
    монтирует и не держит в своём state; `WorkspaceHandle` + `openBeside`,
    `closeActivePanel`;
  - `renderer/components/palette/SessionPicker.tsx` и тест — вход по id сессий:
    `sessionCandidates(entry, openSessionIds)` отсеивает сессии, чьи id уже открыты.
    Импорт `lib/panel-id.ts` уходит: id панелей dockview ему больше не нужны, а
    `panel-id.ts` удаляет 2.7. Файл живёт до 6.2;
  - `renderer/components/sidebar/Sidebar.tsx` — `NewWorkDialog` и `CreateRoomDialog`
    больше не монтирует: «+ работа» и «Создать комнату с…» открывают их через
    `store/ui.ts`;
  - `renderer/components/settings/SettingsDialog.tsx` — вид и уведомления через
    `setAppearance` и `patchUi` стора;
  - все E2E, которые ждут текст «Работ пока нет», — готовность окна ждут по
    `getByTestId('landing')`. Список — по `grep -rln "Работ пока нет"
    packages/desktop/e2e` на момент куска: сейчас `smoke.spec.ts`, `terminal.spec.ts`,
    `grid.spec.ts`, `layout.spec.ts`; `theme.spec.ts` из 1.4 — если он тоже ждёт этот
    текст.
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

// components/palette/SessionPicker.tsx (живёт до 6.2), новая сигнатура
/** Сессии работы, которых нет в openSessionIds (id сессий, не id панелей). */
export function sessionCandidates(entry: WorkEntry, openSessionIds: ReadonlySet<string>): SessionCandidate[];

// renderer/shell/AppShell.tsx
export interface AppShellProps {
  bridge: HarnasBridge;
  status: HostStatus;                    // строка статуса; App рендерит AppShell только при 'connected'
  fontFamily: string; fontSize: number;  // из settings.get в App, до ответа — запасные; идут в центр
}
export function AppShell(props: AppShellProps): JSX.Element;

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
  - справа: поле «Поиск ⌘K» — `setPaletteOpen(true)`, нынешняя палитра до 6.2; «правый
    сайдбар» неактивен до 7.2. Подпись — сочетание, которое открывает палитру сейчас
    (пункт меню «Палитра команд» ⌘K); на ⌘J её меняет 6.2;
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
  - Ручка `workspaceRef` живёт в `AppShell`. Через неё идут входы сайдбара, действия
    палитры и меню `work-1…9`: N-я работа по порядку создания и её последняя сессия,
    как прежний `selectWorkByNumber` в `App`.
  - `AppShell` монтирует `CommandPalette`, `SessionPicker`, `NewWorkDialog` и
    `CreateRoomDialog` по состояниям `store/ui.ts` — и при `Landing` тоже.
  - Палитра строит команды `buildCommands` с действиями через `WorkspaceHandle`.
  - `Workspace` на меню `split-right` и `split-down` зовёт `openPicker` с работой
    активной панели и `openSessionIds` — сессиями этой работы, у которых открыта
    панель терминала (`specFromPanelId`). `AppShell` даёт `SessionPicker` кандидатов
    `sessionCandidates(entry, new Set(picker.openSessionIds))`; выбор → `openBeside`.
  - Меню `palette` слушает `AppShell` → `setPaletteOpen(true)`; `new-work` (⌘N) →
    `openNewWorkDialog()`.
  - `AppShell` зовёт `useLayoutPersistence` (2.2).
- **Строка статуса** 24px, сегменты 1, 4 и 5 спеки 5.9: связь с хостом, последнее
  уведомление хоста, будильник. Сегменты 2 и 3 добавят 3.1 и 4.2.
- **Рамка окна** одна при любом центре: сверху `Titlebar`, сразу под ним
  `InterruptedBanner`, снизу `StatusBar`.
- **`Landing`** — если работ нет (`works.length === 0` после загрузки): плитка
  `size-20 rounded-2xl`, «Harnas», кнопки «Новая работа ⌘N» (`openNewWorkDialog()`) и
  «Палитра ⌘K» (`setPaletteOpen(true)`; подпись ⌘J — с 6.2, как у поля «Поиск»).
  Корень — `data-testid="landing"`, у оболочки с работами — `data-testid="app-shell"`.
  - `Landing` — только центр: `Titlebar` и `StatusBar` остаются. Без области
    перетаскивания пустое окно при `hiddenInset` не утащить.
- **E2E.** Все прежние сценарии, которые ждали «Работ пока нет», ждут готовности окна
  по `getByTestId('landing')`: строки «Работ пока нет» у `Landing` нет (спека 5.10).
- **`ErrorBoundary`** показывает `title`, текст ошибки, «Повторить» и «Закрыть», если
  есть `onClose`. «Повторить» перемонтирует детей: `key + 1`. Оборачивает сайдбар,
  центр и правый сайдбар; вкладки обернёт 2.4, поверхности — 2.5.

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
6. `AppShell` без работ: `Landing` в центре, `Titlebar` и `StatusBar` на месте,
   `InterruptedBanner` в DOM сразу после заголовка. С работой — сайдбар и центр.
7. Кнопки заголовка: «сайдбар» переключает `ui.leftSidebar.open` и зовёт `app.saveUi`
   с целым `leftSidebar`; «назад» неактивна, пока `canBack()` ложно, и активна после
   двух смен вкладки в `layout/store.ts`.
8. `store/ui.ts`: `patchUi({ pinnedWorks: ['a'] })` и сразу
   `patchUi({ collapsedProjects: ['/p'] })` — в зеркале оба, `app.saveUi` получил два
   патча по одному ключу; `setSidebar('left', { width: 300 })` сохраняет `open`.
9. `AppShell` на `Landing`: кнопка «Новая работа» и меню `new-work` открывают
   `NewWorkDialog`; меню `palette` открывает `CommandPalette`. С работой меню
   `toggle-left-sidebar` сворачивает сайдбар, «Поиск ⌘K» открывает палитру. Подписи
   сочетания палитры в заголовке и на `Landing` — ⌘K, «⌘J» там нет (до 6.2).
10. `Workspace` на меню `split-right` зовёт `openPicker` с работой активной панели и
    `openSessionIds` — id сессий её открытых терминалов; выбор в `SessionPicker` из
    `AppShell` зовёт `openBeside`.
11. `SettingsDialog`: «Тёмная» зовёт `setAppearance('dark')` стора, «звук» —
    `patchUi({ notifications })` с остальными ключами из зеркала.
12. `sessionCandidates(entry, new Set(['s-02']))` → `s-01` и `s-03`; пустой набор — все
    сессии работы. Тест строит набор из id сессий, `panelId` в нём нет.
13. `AppShell` по меню `work-2` открывает через ручку `Workspace` последнюю сессию
    второй работы по порядку создания, как прежний `App`.

**Приёмка**
- [x] Все тесты зелёные, прежние E2E зелёные с новым ожиданием готовности.
- [x] `pnpm dev:desktop`: светофор macOS на месте, окно тащится за заголовок — и на
      `Landing` без работ, двойной клик увеличивает окно (ручная проверка). _(проверено агентом в собранном окне через Playwright; на `harnas.app` — финальная приёмка)_

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

// layout/LayoutView.tsx — bridge и шрифт приходят от AppShell (AppShellProps, 2.3)
export function LayoutView(props: {
  workKey: string; bridge: HarnasBridge; fontFamily: string; fontSize: number;
}): JSX.Element;

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
  - Активной работы нет (`activeWorkKey === null`, пока `persistence` её не выбрал,
    2.2) — центр пуст: ни групп, ни строки вкладок в `#titlebar-tabs`.
  - `LayoutView` получает от `AppShell` `bridge`, `fontFamily` и `fontSize` и отдаёт их
    телам вкладок своим контекстом, как `PanelHostContext` прежнего `Workspace`:
    `TerminalBody` нужен шрифт, `MailBody`, `RoomBody` и `DiffBody` — мост.
  - Флаг читается из `location.search` один раз при загрузке.
  - При флаге `AppShell` сам обслуживает меню `close-panel`, `reopen-tab`,
    `prev-panel`, `next-panel`, `split-right`, `split-down` и действия палитры
    «открыть»: `setActiveWork` и `apply(openTab)` в `layout/store.ts`.
  - Входы сайдбара подключит 2.5; E2E до 2.7 идут без флага.
- **Сплит.** `SplitView` — flex по `ratio`. Разделитель: видимая линия 3px
  `--split-divider` (strong на hover), зона захвата 8px. Во время перетаскивания доля
  пишется в DOM, `setRatio` — на `pointerup`, с пиксельным минимумом 240×160.
  - Нулевой размер сплита (jsdom, свёрнутое окно) даёт нечисловую долю: в DOM она не
    пишется, а `setRatio` оставляет раскладку прежней (2.1).
- **Строка вкладок.**
  - Одна группа — `TabStrip` порталом в `#titlebar-tabs`, вкладки там — `no-drag`.
    Иначе — строка 32px над телом каждой группы.
  - Вид вкладок, крестика и кнопки «+» — спека 5.3. «+» — `setPaletteOpen(true)`:
    нынешняя палитра до 6.2, смонтированная в `AppShell` (2.3).
  - Горизонтальная прокрутка колесом, затухание у краёв.
- **Пустая группа** (корень пустой работы) — текст «Откройте сессию из сайдбара, ⌘T —
  новая сессия» (спека 5.8).
- **Вкладка:**
  - клик — `focusTab`;
  - крестик и средняя кнопка — `requestCloseTabs(workKey, [id])` (2.2), не `closeTab`
    напрямую: с 7.3 закрытие спросит про несохранённый файл;
  - меню: «Закрыть», «Закрыть остальные», «Закрыть справа» — один вызов
    `requestCloseTabs` со всем списком. «Разделить вправо», «Разделить вниз» сначала
    делают `focusGroup` группы этой вкладки, затем открывают выбор сессии, как ⌘D:
    `splitGroup` режет активную группу, и без фокуса разделилась бы чужая;
  - закрытие показывает тост «Вкладка закрыта — ⌘⇧T вернёт».
- **Тела вкладок**, каждое в `ErrorBoundary` с `onClose`:
  - `mail` — `MailPanel`, `room` — `RoomPanel`, `diff` — нынешний `ChangesPanel`
    (до 8.3), `terminal` — `TerminalPanel` (до 2.5);
  - нет сессии или комнаты в карте — `MissingBody`: «Сессия удалена» или «Комната
    удалена», и «Закрыть».
- **Клавиши этапа 2:**

| Действие меню или клавиша | Что делает |
|---|---|
| `close-panel` | `requestCloseTabs` активной вкладки |
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
2. У активной вкладки `data-active="true"` и нижняя полоса. Средняя кнопка и крестик
   зовут `requestCloseTabs` с id вкладки, и она закрыта.
3. «Закрыть остальные» — один вызов `requestCloseTabs` со всеми, кроме текущей: остаётся
   одна вкладка. «Закрыть справа» — остаются вкладки слева и текущая.
4. `layoutKeyAction`: ⌃2 → `{ tab-index: 1 }`, ⌃Tab → `mru +1`, ⌘⇧] → `tab-step +1`,
   ⌘J → `null`.
5. `shouldForwardToTerminal`: ⌃Tab, ⌃1 → `false`; ⌃C, ⌃A → `true`.
6. `tabMeta`: заголовки всех шести видов по спеке 5.3. У `diff` с `commit` —
   `Изменения S02 · <7 символов hash>`.
7. `truncateTitle('🙂'.repeat(50), 40)` — 40 эмодзи и «…», без одиночных суррогатов.
8. Вкладка удалённой сессии → `MissingBody`, «Закрыть» убирает вкладку.
9. Перетаскивание разделителя: во время движения `setRatio` не зовётся, на отпускании
   — один раз. Размеры сплита подставлены: jsdom отдаёт нулевые прямоугольники.
10. Сплит при 8 группах → тост и раскладка без изменений.
11. `Tab`: крестик неактивной вкладки скрыт до hover (`opacity-0`,
    `group-hover:opacity-100`), у активной — виден (спека 14.2).
12. Пустая корневая группа показывает «Откройте сессию из сайдбара, ⌘T — новая
    сессия».
13. `AppShell` с `?center=new`: `Workspace` не смонтирован; меню `split-right`
    открывает выбор сессии без уже открытых; выбор → две группы в раскладке активной
    работы; «+» строки вкладок открывает палитру. Размеры групп подставлены
    (`getBoundingClientRect`): из jsdom пришли бы нули и `too-small`.
14. Меню вкладки из неактивной группы → «Разделить вправо» → выбор сессии: разделена
    группа этой вкладки, прежняя активная группа не тронута.
15. `?center=new`, работы есть, `activeWorkKey: null`: `LayoutView` не смонтирован,
    `#titlebar-tabs` пуст.
16. Разделитель при нулевом размере сплита: отпускание оставляет раскладку той же
    ссылкой, в стиле DOM нет `NaN`.
17. `LayoutView` с `fontFamily: 'Menlo'` и `fontSize: 15`: тело терминала создаёт
    подставной `Terminal` с этим шрифтом; тело комнаты получает тот же `bridge`.

**Приёмка**
- [x] Все тесты зелёные.
- [x] С `HARNAS_DESKTOP_CENTER=new pnpm dev:desktop`: вкладки в заголовке при одной
      группе, по группам — при нескольких (ручная проверка). _(проверено агентом в собранном окне через Playwright; на `harnas.app` — финальная приёмка)_

---

## 2.5. Слой поверхностей и терминал

**Зачем.** Перенос вкладки терминала между группами не пересоздаёт xterm и не
переподключает PTY.
**Зависит от:** 2.4. **Спека:** 5.5.

**Шаг 0 — проба платформы.** `CSS.supports('anchor-name', '--a')` не годится: он
отвечает `true`, даже когда якорь недействителен для этой разметки.
- В меню окна нет DevTools (`main/menu.ts`), поэтому проба идёт через Playwright
  `_electron`, а не через DevTools окна:
  - собрать окно: `pnpm --filter @harnas/host build && pnpm --filter @harnas/desktop
    build`;
  - запустить его временным скриптом Playwright (в коммит не входит) с временным
    `HARNAS_HOME`, как E2E, и после погасить хост (`e2e/stop-host.ts`);
  - в `window.evaluate` собрать пробу той же формы, что у слоя:
    - контейнер `position: absolute; inset: 0`;
    - в нём тело `anchor-name: --probe` с отступами и размером 100×50;
    - соседний блок без `position`, `transform` и `contain`, а в нём поверхность:
      `position: absolute; position-anchor: --probe; top: anchor(top);
      left: anchor(left); width: anchor-size(width); height: anchor-size(height)`.
- `getBoundingClientRect()` поверхности совпал с телом (±1 px) — путь якорей. Иначе
  реализуется запасной путь `layout/anchor-fallback.ts` (ниже), а в `TODOS.md` пишется
  причина.

**Файлы**
- Создать:
  - `packages/desktop/src/renderer/layout/SurfaceLayer.tsx` и тест;
  - `packages/desktop/src/renderer/layout/lru.ts` и тест;
  - `packages/desktop/src/renderer/terminal/TerminalSurface.tsx` и тест — по образцу
    `components/terminal/TerminalPanel.tsx`, но с тремя отличиями (поведение ниже):
    - фон обёртки отступа — фон темы xterm, а не контейнера;
    - на меню `find` поверхность сама не подписывается, полосу поиска открывает
      `openSearch()` её ручки;
    - xterm и полоса поиска — под `ErrorBoundary` внутри корня поверхности.
    Сам `TerminalPanel.tsx` остаётся телом панели прежнего центра до 2.7 и берёт
    `use-terminal` из нового места;
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
  - `terminal/use-terminal.ts` — `pty.resize` только у видимой поверхности. Правило 1.3
    (после attach `fit()`, `pty.resize` только при расхождении с ответом хоста) и его
    тесты не меняются;
  - `shell/AppShell.tsx` — контейнеры работ LRU: работа без раскладки — пустой
    контейнер, `drop` убирает работу из LRU. Меню `find` → `openSearch()` видимой
    поверхности активной группы через `terminalSurfaces`. Входы сайдбара при
    `?center=new` идут в `layout/store.ts`.

**Интерфейсы**

```ts
// layout/lru.ts
export interface Lru<K> {
  touch(key: K): K[];       // возвращает вытесненные
  has(key: K): boolean;
  keys(): K[];
  remove(key: K): void;     // работа исчезла (`drop`) — её контейнер размонтируется
}
export function createLru<K>(limit: number): Lru<K>;

// layout/LayoutView.tsx — с 2.5 добавлен active
export function LayoutView(props: {
  workKey: string; active: boolean; bridge: HarnasBridge; fontFamily: string; fontSize: number;
}): JSX.Element;

// layout/SurfaceLayer.tsx — мост и шрифт из AppShellProps (2.3), как прежде через Workspace
export function SurfaceLayer(props: {
  workKey: string; active: boolean; bridge: HarnasBridge; fontFamily: string; fontSize: number;
}): JSX.Element;

// terminal/TerminalSurface.tsx
export interface TerminalSurfaceProps {
  bridge: HarnasBridge;     // для use-terminal
  sessionRef: SessionRef;   // из него же workKey для requestCloseTabs
  tabId: string;
  groupId: string;          // якорь `--g-<groupId>`
  visible: boolean;
  fontFamily: string; fontSize: number;
}
/**
 * openSearch() — с 2.5: полоса поиска из TerminalPanel с фокусом в поле.
 * 5.3 меняет полосу на SearchBar и дописывает clear(); их зовут действия find и terminal.clear (6.3).
 */
export interface TerminalSurfaceHandle {
  focus(): void; scrollToBottom(): void; search: SearchAddon | null;
  openSearch(): void;
}
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
  - вытесненный из LRU контейнер размонтируется: xterm освобождаются, `pty.detach`;
  - работы нет в `layouts` (до `hydrate` после `setActiveWork` или после `drop`) —
    контейнер пуст: ни `LayoutView`, ни `SurfaceLayer`. `drop` убирает работу и из LRU
    (`lru.remove`), и её контейнер размонтируется;
  - спека 5.5 описывает контейнер так же: позиционирован контейнер работы, а не слой.
- **`LayoutView` с `active: false`** не порталит строку вкладок в `#titlebar-tabs` и не
  ловит клавиши 2.4.
- **Поверхности.** Слой рисует `TerminalSurface` на каждую вкладку `terminal` раскладки
  работы, чья сессия есть в карте работы (`WorkEntry.map.sessions`). Ключ React — id
  вкладки, поэтому перенос вкладки не меняет ключ.
  - У вкладки удалённой сессии поверхности нет. Её `pty.attach` падает, и пустой xterm
    лёг бы в слое поверх тела и закрыл `MissingBody` (2.4) с «Закрыть».
  - **Граница ошибки** (спека 5.10). Корень `TerminalSurface` несёт привязку к якорю,
    видимость, `data-tab-id`, `data-mount-id` и фон. xterm, `use-terminal`, полоса
    поиска и запись в `terminalSurfaces` живут во внутреннем компоненте под
    `ErrorBoundary` (2.3): граница ловит ошибки только потомков. `title` — из
    `tabMeta`, `onClose` → `requestCloseTabs(workKey, [tabId])`, `workKey` — из
    `sessionRef`.
  - Своего блока у границы нет: запасной вид встаёт внутри корня, на место терминала,
    и лишнего containing block в слое не появляется. «Повторить» пересоздаёт только
    внутренность, `data-mount-id` корня прежний.
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
  - `TerminalSurface` пишет видимость в `store/ui.ts`, как `panel-registry.tsx`:
    `setSessionVisible(refKey(sessionRef), visible)` на каждую смену и `false` при
    размонтировании. По `visibleSessionRefs` `App.tsx#wireNotifications` решает, видна
    ли сессия; после 2.7 других писателей у него нет.
- **Размер.** После изменения ширины сайдбара или доли сплита `fit()` и `pty.resize` —
  прежний механизм `ResizeObserver` с тишиной 50 мс, но только у видимой поверхности.
  Скрытая изменения размера пропускает.
  - Появление — это `attach()`. После снимка `fit()`, а `pty.resize` — только если
    `cols`/`rows` разошлись с ответом хоста: правило 1.3 в `use-terminal.ts`. Отдельного
    resize при появлении нет: он дал бы второй SIGWINCH и перерисовку агента.
  - Тесты `use-terminal.test.ts` про ресайз после attach («совпал с ответом attach —
    `pty.resize` не уходит» и «отличается — уходит один») переезжают без правок.
- **Фон.** Обёртка отступа 4px вокруг xterm красится `xtermTheme(dark).background`
  (`terminal/xterm-themes.ts`) и меняется вместе с `dark` из `useUiStore`. У образца
  `TerminalPanel` обёртка без фона, и в тёмной теме вокруг терминала видна рамка
  `--card` (`#171717` против `#282c34`).
- **Поиск ⌘F.** Полоса поиска `TerminalPanel` переезжает в поверхность, но на меню
  `find` поверхность сама не подписывается: смонтированы поверхности трёх работ со
  всеми вкладками, и ⌘F открыл бы полосу во всех, включая скрытые.
  - Меню `find` при `?center=new` слушает `AppShell`. Он берёт активную вкладку активной
    группы активной работы и, если это терминал, зовёт `openSearch()` её ручки из
    `terminalSurfaces`.
  - `openSearch()` показывает полосу с фокусом в поле; Enter — `findNext`, Esc
    закрывает. В 5.3 полосу заменит `SearchBar`.
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
   порядок; `remove` убирает ключ — `has` ложно, в `keys()` его нет.
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
11. Поверхность стала видимой, `pty.attach` ответил 80×24. Подставной `FitAddon` дал
    80×24 — `pty.resize` не ушёл; дал 100×30 — ушёл ровно один `pty.resize` 100×30.
12. Обёртка отступа поверхности: `background-color` — `#282c34` при `dark: true`; после
    `setDark(false)` — фон `XTERM_LIGHT`, а подставной `Terminal` не создан заново.
13. Вкладка удалённой сессии: в слое нет элемента с её `data-tab-id`, в теле видна
    `MissingBody` «Сессия удалена», «Закрыть» убирает вкладку.
14. Подставной `Terminal` одной вкладки бросает в конструкторе: внутри корня её
    поверхности — запасной вид с заголовком вкладки, «Закрыть» зовёт
    `requestCloseTabs(workKey, [tabId])`. Поверхность соседней вкладки жива:
    `Terminal.dispose` у неё не вызван.
15. Две группы с терминалами, в активной — две вкладки-терминала: меню `find`
    открывает полосу поиска только у видимой поверхности активной группы. У скрытой
    вкладки и у другой группы полосы нет.
16. Работа в LRU без раскладки: контейнер есть, в нём нет ни `LayoutView`, ни
    поверхностей; после `hydrate` они появились. `drop` работы — её контейнер
    размонтирован, `Terminal.dispose` вызван.
17. `visibleSessionRefs` содержит `refKey` видимой поверхности. Вкладка стала
    неактивной или поверхность размонтирована — ключа нет.

**Приёмка**
- [x] Шаг 0 выполнен, результат записан в описании коммита; скрипт пробы в коммит не
      входит.
- [x] Все тесты зелёные.
- [x] С флагом `?center=new`: терминал встаёт ровно в тело своей группы, перенос между
      группами не мигает и не теряет прокрутку (ручная проверка). _(проверено агентом в собранном окне через Playwright; на `harnas.app` — финальная приёмка)_

---

## 2.6. Перетаскивание

**Зачем.** Вкладки и сессии раскладываются мышью, как у Orca.
**Зависит от:** 2.5. **Спека:** 5.4.

**Файлы**
- Создать: `packages/desktop/src/renderer/layout/dnd.ts` и тест,
  `packages/desktop/src/renderer/layout/DropIndicator.tsx`.
- Изменить:
  - `shell/AppShell.tsx` — один `DndContext` над сайдбаром, заголовком и центром:
    сенсор `PointerSensor` с `activationConstraint: { distance: 4 }`, `DragOverlay`,
    `collisionDetection={layoutCollision(activeWorkKey)}`, `onDragEnd` → `applyDrop`
    или `onTerminalDrop`;
  - `layout/LayoutView.tsx`, `TabStrip.tsx`, `GroupView.tsx` — только droppable и
    sortable: сортируемые вкладки, зоны броска; своего `DndContext` нет. В `data` —
    `DropTargetData` с `workKey` своей работы; у неактивной работы все они `disabled`;
  - `terminal/TerminalSurface.tsx` — droppable зоны `terminal` с `sessionId` на корне
    поверхности, `disabled: !visible`;
  - `components/sidebar/SessionTree.tsx` — строка сессии активной работы становится
    перетаскиваемой через `@dnd-kit` и несёт `data-draggable`; HTML5-перетаскивание
    уходит. Без флага `?center=new` сессии в старый центр до 2.7 не перетаскиваются:
    он уходит в 2.7;
  - `packages/desktop/package.json` — `@dnd-kit/core`, `@dnd-kit/sortable`.

**Интерфейсы**

```ts
// layout/dnd.ts
export type DragItem = { kind: 'tab'; tabId: string } | { kind: 'session'; sessionId: string };
export type DropZone =
  | { kind: 'strip'; groupId: string; index: number }
  | { kind: 'center'; groupId: string }
  | { kind: 'edge'; groupId: string; edge: Edge }
  | { kind: 'terminal'; sessionId: string };    // поверхность терминала: путь в поле ввода (7.2)
export interface RectLike { left: number; top: number; width: number; height: number }
/** Центр или край: край — 25% ширины или высоты; в углу побеждает ближайшая сторона. */
export function zoneForPoint(point: { x: number; y: number }, body: RectLike, groupId: string): Exclude<DropZone, { kind: 'terminal' }>;
/** Принимает ли терминал предмет: в этапе 2 — никакой (tab и session → false); 7.2 добавит file. */
export function acceptsTerminal(item: DragItem): boolean;
/** `data` каждого droppable и sortable раскладки; `workKey` — работа-владелец. */
export type DropTargetData = { workKey: string } & (
  | { kind: 'strip'; groupId: string; index: number }   // вкладка строки или хвост строки
  | { kind: 'body'; groupId: string }                   // центр или край — по zoneForPoint
  | { kind: 'terminal'; sessionId: string }             // поверхность терминала
);
/**
 * collisionDetection DndContext. Контейнеры с чужим `data.workKey` отбрасываются: тела
 * скрытых работ LRU лежат на месте тела активной. Терминал под указателем и
 * acceptsTerminal(active) — зона терминала важнее центра и краёв тела группы; иначе
 * droppable терминалов пропускаются.
 */
export function layoutCollision(activeWorkKey: string | null): CollisionDetection;
export function applyDrop(layout: WorkLayout, item: DragItem, zone: Exclude<DropZone, { kind: 'terminal' }>, sizes: GroupSizes): OpResult;
/** onDragEnd @dnd-kit → что бросили (`active.data`) и куда (`over.data` — DropTargetData, + zoneForPoint); null — мимо зон. */
export function dropFromDragEnd(event: DragEndEvent): { item: DragItem; zone: DropZone } | null;
/**
 * Бросок в зону `terminal`; раскладку не трогает. Зовёт её onDragEnd AppShell. В этапе 2
 * пустая — таких предметов нет; 7.2 кладёт путь файла в поле ввода агента.
 */
export function onTerminalDrop(item: DragItem, sessionId: string): void;
```

**Поведение**

| Что тащат → куда | Итог |
|---|---|
| Вкладку → строку вкладок | `moveTab` на индекс |
| Вкладку → центр тела | `moveTab` последней в группу |
| Вкладку → край тела | `moveTab` с `edge` |
| Сессию → строку или центр | `openTab(terminal)` в зону. Если вкладка уже открыта — `moveTab` туда |
| Сессию → край | `openTab(terminal)` в целевую группу, затем `moveTab` к краю — одна операция `applyDrop`. Уже открытая — сразу `moveTab` к краю |
| Файл (с 7.2) → терминал сессии | путь в поле ввода агента (спека 5.4, 8.5); раскладка не меняется |

- **Сессия к краю.** `splitGroup` умеет только вправо и вниз, а `moveTab` берёт только
  открытую вкладку, поэтому `applyDrop` делает обе операции подряд над одной
  раскладкой. Отказ второй (`too-many-groups`, `too-small`) — прежняя раскладка той же
  ссылкой, активная вкладка цели прежняя.
- **Один `DndContext` — в `AppShell`.** Строка сессии живёт в сайдбаре, а зоны броска —
  в центре. `useDraggable` вне провайдера получает контекст по умолчанию и молча не
  тащит, поэтому провайдер накрывает сайдбар, заголовок и центр. `onDragEnd` —
  `dropFromDragEnd` и `apply(activeWorkKey, applyDrop(…))`.
- **Порог перетаскивания.** `PointerSensor` — только с `activationConstraint:
  { distance: 4 }`. Без порога @dnd-kit начинает перетаскивание уже на `pointerdown` и
  глушит следующий `click` слушателем в фазе захвата. Клик по строке сессии перестал бы
  её открывать, крестик и средняя кнопка — закрывать вкладку (тесты 2–3 куска 2.4).
- **Скрытые зоны выключены.** @dnd-kit ищет столкновения среди всех включённых
  droppable, а прямоугольник у `visibility: hidden` и `inert` полный. Тела скрытых
  работ LRU лежат на месте тела активной, скрытые терминалы группы — на месте видимого.
  `over` мог бы оказаться группой неактивной работы: `applyDrop` над раскладкой
  активной получил бы `not-found`, и бросок потерялся бы; с 7.2 путь файла ушёл бы в
  скрытую вкладку другой сессии той же группы. Поэтому:
  - droppable и sortable `LayoutView`, `GroupView`, `TabStrip` — `disabled: !active`;
  - droppable `TerminalSurface` — `disabled: !visible`;
  - `layoutCollision(activeWorkKey)` вдобавок отбрасывает контейнеры с чужим
    `data.workKey`.
- **Зона терминала.** Поверхность лежит в слое над телом своей группы, и по
  прямоугольникам @dnd-kit их не различит. Поэтому `DndContext` получает
  `collisionDetection={layoutCollision(activeWorkKey)}`:
  - предмет, который терминал принимает (`acceptsTerminal`), над поверхностью — зона
    `terminal`, она важнее центра и краёв тела;
  - вкладка и строка сессии терминал не видят: над ним работают зоны тела группы, как
    без поверхности;
  - `onDragEnd` с зоной `terminal` раскладку не трогает, а зовёт `onTerminalDrop(item,
    sessionId)` из `dnd.ts`. До 7.2 таких предметов нет, и функция пустая.
- **Индикаторы** — спека 5.4: линия 2px blue-500 в строке, подсветка тела,
  полупрозрачная половина у края.
  - `DropIndicator` — `position: absolute` в теле группы с `z-index: 10`. Слой
    поверхностей идёт после `LayoutView` и без этого закрыл бы индикатор над
    вкладкой-терминалом.
  - У поверхностей `z-index` не задан. Предки индикатора внутри контейнера работы не
    создают своего контекста наложения: без `z-index` у позиционированных, без
    `transform`, `opacity` < 1 и `isolation`.
- **Сессии неактивной работы** не тащатся: курсор `not-allowed`, активатор `@dnd-kit`
  выключен. `data-draggable` ставит сам `SessionTree`, только на перетаскиваемой
  строке: у @dnd-kit такого атрибута нет.
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
6. У строки сессии неактивной работы нет `data-draggable`, у строки активной — есть.
7. `dropFromDragEnd`: `active` строки сессии и `over` края тела → `{ kind: 'session' }`
   и `edge`; `over: null` → `null`.
8. `AppShell` с `?center=new`: его `onDragEnd` с `active` строки сессии сайдбара и
   `over` тела группы открывает вкладку терминала в этой группе. Строка и тело — под
   одним `DndContext`.
9. `layoutCollision` активной работы, указатель над поверхностью терминала в центре
   тела: для вкладки и сессии — зона `center` этой группы; для подставного предмета,
   который `acceptsTerminal` принимает, — `terminal` с `sessionId` поверхности.
10. `dropFromDragEnd` с `over` поверхности терминала → `{ kind: 'terminal', sessionId }`;
    `onDragEnd` с такой зоной раскладку не меняет и зовёт `onTerminalDrop(item,
    sessionId)` — шпион через `vi.mock` модуля `dnd.ts`.
11. Две работы A и B в LRU, тела их групп на одном прямоугольнике: `layoutCollision('A')`
    среди droppable A и B отдаёт зону тела группы A. `onDragEnd` `AppShell` над телом
    меняет раскладку A, раскладка B — та же ссылка.
12. Скрытые зоны выключены. У неактивной работы `useDroppable` и `useSortable` её
    `LayoutView`, `GroupView`, `TabStrip` вызваны с `disabled: true`, у активной — с
    `false`. Два терминала в одной группе: droppable скрытой вкладки — `disabled:
    true`; для принимаемого предмета `layoutCollision` над телом → `terminal` с
    `sessionId` видимой вкладки.
13. Под `DndContext` `AppShell`: клик по строке сессии активной работы открывает её
    вкладку; клик по крестику вкладки под `SortableContext` закрывает её
    (`requestCloseTabs`). Сдвиг указателя на 5 px с зажатой кнопкой начинает
    перетаскивание.
14. `applyDrop` сессии к левому краю: слева новая группа с вкладкой её терминала,
    `activeGroupId` — она. При 8 группах — `too-many-groups`, раскладка — та же ссылка,
    `activeTabId` целевой группы прежний.
15. `DropIndicator` несёт `z-index` 10; у корня `TerminalSurface` и у тела группы
    `z-index` не задан.

**Приёмка**
- [x] Все тесты зелёные.
- [x] С флагом `?center=new` вкладки и строки сессий из сайдбара перетаскиваются мышью
      на все четыре края и в строку. Индикаторы видны и над вкладкой-терминалом; клик
      по строке сессии и крестику вкладки работает, как без перетаскивания (ручная
      проверка). _(проверено агентом в собранном окне через Playwright; на `harnas.app` — финальная приёмка)_

---

## 2.7. Переключение работ, сплит с выбором, удаление dockview; приёмка этапа 2

**Зачем.** Центр показывает выбранную работу; dockview и его обвязка уходят.
**Зависит от:** 2.6. **Спека:** 5.6, 5.11.

**Файлы**
- Изменить в `packages/desktop/src/renderer/`:
  - `shell/AppShell.tsx` — новый центр единственный: флаг `?center=new`, ветка
    прежнего `Workspace` и ручка `workspaceRef` уходят; входы сайдбара, меню и палитра
    идут только в `layout/store.ts` (подключены в 2.4–2.5). Меню `work-1…9` (его
    слушает `AppShell` с 2.3) → `setActiveWork` N-й работы по порядку создания;
  - `App.tsx` — ⌘T: работа — активная (`activeWorkKey`), родитель — `selectedSessionOf`;
  - `layout/store.ts` и тест — `selectedSessionOf`;
  - `components/palette/CommandPalette.tsx`, `lib/commands.ts` и тест — «открыть» идёт
    через `layout/store.ts`; `lastSessionByWork` уходит (работа открывается своей
    раскладкой), `recentSessionRefs` — из `entries()` истории. Из шапки `commands.ts`
    уходит ссылка на `panel-id.ts`;
  - `components/palette/SessionPicker.tsx` — логика та же: с 2.3 вход — id сессий, и
    импорт `lib/panel-id.ts` до удаления модуля здесь не возвращается. Комментарий
    файла — про выбор сессии для групп `AppShell`, а не панелей `Workspace`. Файл живёт
    до 6.2;
  - `components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx` — подсветка
    выбранной сессии из `selectedSessionOf`;
  - `store/ui.ts` и тест — без `selectedRef`, `selectedWorkKey`, `lastSessionByWork`,
    `recentSessionRefs`, `selectSession`, `activePanelId`, `setActivePanelId`.
    `visibleSessionRefs` и `setSessionVisible` остаются: их пишет `TerminalSurface`
    (2.5);
  - `test-utils/fake-bridge.ts` — `layouts: Map<string, WorkLayout>`, журнал
    `layoutSaves: Array<{ workKey: string; layout: WorkLayout }>`, `loadLayout` отдаёт
    `WorkLayout | null`. Файл входит в `tsconfig.web.json`, и без правки `pnpm typecheck`
    красный;
  - `ui/tabs.tsx`, `App.test.tsx` — комментарии без «dockview». То же в комментариях
    файлов выше, которые 2.7 и так меняет: `App.tsx`, `lib/commands.ts`, `store/ui.ts`.
- Изменить вне рендерера:
  - `src/main/menu.ts`, `src/shared/bridge.ts` — `MenuAction` `'history-back'` и
    `'history-forward'`: пункты «Назад» ⌘⌥← и «Вперёд» ⌘⌥→ в меню «Вид»; `loadLayout`
    и `saveLayout` — на `WorkLayout`, их комментарий без «dockview»;
  - `src/preload/index.ts` — `loadLayout` и `saveLayout` под новые типы моста;
  - `src/main/ipc.ts` — комментарий о раскладке без «dockview», если 2.2 его не
    переписал;
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
  правилу 2.5. Пишет его только `TerminalSurface` (2.5). Точнее видимость посчитает
  4.2.
- Без активной работы (`activeWorkKey === null`, а работы есть) центр пуст, как в 2.4,
  пока `persistence` не выберет первую по `order` (2.2).
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
   - Вторая работа теперь скрыта в LRU, её тела лежат на том же месте. В первой работе
     открыть кликом вторую её сессию — две вкладки-терминала в одной группе.
   - Вкладку мышью к правому краю группы → в первой работе две группы. Клик по второй
     работе — у неё по-прежнему одна группа: бросок не ушёл в скрытую работу.
4. `layout.spec.ts`: у двух работ разные раскладки; окно перезапущено — обе раскладки
   на месте по своим работам.
5. `selectedSessionOf`: активная вкладка-терминал → её сессия; активна вкладка почты →
   `null`; активной работы нет → `null`.
6. Меню `new-session` (⌘T) открывает диалог с `projectPath` и `workId` активной работы
   и родителем из `selectedSessionOf`.
7. `AppShell`: меню `work-2` делает активной вторую работу по порядку создания, в
   центре — её раскладка.

**Приёмка**
- [x] Все тесты зелёные, все E2E зелёные: прежние `smoke`, `terminal`, `theme` и новые.
- [x] `pnpm typecheck` зелёный: мост, `preload/index.ts` и `fake-bridge.ts` на
      `WorkLayout`.
- [x] `grep -rn dockview packages/desktop/src packages/desktop/e2e
      packages/desktop/package.json` пуст, включая комментарии; `out/`, `dist/` и
      `node_modules/` не в счёт.
- [x] `grep -rn "panel-id" packages/desktop/src` пуст, включая комментарии.

**Приёмка этапа 2** (человек, на пересобранном `harnas.app`)
- [x] Две работы с разными раскладками переключаются кликом.
- [x] Перенос терминала между группами не мигает и не теряет прокрутку.
- [x] Вокруг терминала нет рамки другого цвета — ни в тёмной теме, ни в светлой.
- [x] ⌘⌥← возвращает на прежнюю вкладку, ⌘⇧T возвращает закрытую.
- [x] `README.md` обновлён.
