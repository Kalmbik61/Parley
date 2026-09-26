# План, этап 3: карточки

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 6, 7.1, строка 3 таблицы 14.3.

**Итог этапа:**
- сайдбар из групп проектов и «Закреплённых» с карточками работ;
- работа, где нужен ты, стоит первой;
- меню карточки, переименование на месте, клавиатура;
- форма новой работы как у Orca.

**Перед стартом.** Сверить с кодом этапа 2:
- `layout/store.ts` (`setActiveWork`, `apply`, очередь до `hydrate`, `selectedSessionOf`)
  и `layout/tree.ts#openTab` — открытие вкладки: `apply(workKey, l => openTab(l, tab))`;
- `layout/persistence.ts` (`order`, `neighborWork`);
- `layout/dnd.ts` и `DndContext` в `AppShell` (перетаскивание строк сессий);
- `store/ui.ts` (зеркало `ui`, `patchUi`, `dialogs`) и `shared/ui-types.ts`
  (`pinnedWorks`, `collapsedProjects`, `showDoneWorks`, `lastProvider`);
- `lib/mail-view.ts#recipientsOf`, `lib/tree-order.ts`, `lib/dot-state.ts`
  (`stateWord`).

**Правило для человека в комнатах.** Человек — участник каждой комнаты, но в
`room.members` не пишется, а `recipientsOf` его вычитает (`lib/mail-view.ts:40`).
Поэтому непрочитанное человеком считается своими функциями (3.2), а не через
`recipientsOf`.

---

## 3.1. core и хост: `works.rename`, `works.setStatus`, список методов в `hello`

**Зачем.**
- Меню карточки умеет переименовать, завершить и архивировать работу.
- Окно узнаёт, какие методы понимает хост, и не падает на старом хосте.

**Зависит от:** —. **Спека:** 3.2, 6.7.

**Файлы**
- Изменить:
  - `packages/core/src/work/store.ts` и тест — `renameWork`, `setWorkStatus`; опция
    `touch` у `updateMap`;
  - `packages/core/src/index.ts` — экспорт;
  - `packages/protocol/src/methods.ts` и тест — схемы и результаты новых методов,
    `methods?: string[]` в результате `hello`;
  - `packages/host/src/methods/works.ts` и `works.test.ts` — `worksRename`,
    `worksSetStatus`;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/host/src/server.ts` и `server.test.ts` — `hello` отдаёт `methods`;
  - `packages/desktop/src/main/host-connection.ts` и тест — `methods` в статусе;
  - `packages/desktop/src/shared/bridge.ts` — `HostStatus.connected.methods`;
  - `packages/desktop/src/renderer/test-utils/fake-bridge.ts` — статус `connected` с
    `methods: REQUIRED_METHODS` по умолчанию и сеттер `setHostMethods`;
  - `packages/desktop/src/renderer/App.tsx` — статус хоста из `store/host.ts` вместо
    локального `useState`;
  - `packages/desktop/src/renderer/shell/StatusBar.tsx` — сегмент «Хост старее окна».
- Создать:
  - `packages/desktop/src/renderer/lib/capabilities.ts` и тест;
  - `packages/desktop/src/renderer/store/host.ts` и тест — стор статуса хоста.

**Интерфейсы**

```ts
// core/work/store.ts
export interface WriteOptions {
  lockTimeoutMs?: number;
  /** false — `work.updatedAt` не сдвигается: правка не событие работы (порядок сайдбара, спека 6.2). */
  touch?: boolean;                 // по умолчанию true
}
// оба — через updateMap(…, { touch: false })
export async function renameWork(projectPath: string, workId: string, title: string): Promise<WorkMap>;
export async function setWorkStatus(projectPath: string, workId: string, status: WorkStatus): Promise<WorkMap>;

// protocol/methods.ts — предел по кодовым точкам: `.max(120)` zod считает UTF-16, эмодзи шло бы за два
'works.rename':    z.object({ projectPath: z.string(), workId: z.string(),
  title: z.string().trim().min(1).refine((title) => [...title].length <= 120) }),
'works.setStatus': z.object({ projectPath: z.string(), workId: z.string(), status: z.enum(['active', 'done', 'archived']) }),
// Results
'works.rename': { ok: true };
'works.setStatus': { ok: true };
hello: { hostVersion: string; protocol: number; pid: number; methods?: string[] };

// desktop/shared/bridge.ts
export type HostStatus =
  | { state: 'connecting' }
  | { state: 'connected'; hostVersion: string; methods: string[] | null }   // null — хост до этапа 3
  | { state: 'mismatch'; hostVersion: string; liveSessions: number | null }
  | { state: 'disconnected'; reason: string };

// renderer/lib/capabilities.ts
/** Методы и уведомления протокола 1 до этого плана — их умеет любой хост. */
export const BASELINE_METHODS: readonly string[];
/** Что нужно окну этой сборки; пополняется в 3.1, 4.1, 5.1, 8.1. */
export const REQUIRED_METHODS: readonly string[];
export function hostMethods(status: HostStatus): Set<string>;   // null → BASELINE_METHODS
export function missingMethods(status: HostStatus): string[];
export function useHostSupports(method: string): boolean;       // статус — из useHostStore

// renderer/store/host.ts
export interface HostState {
  status: HostStatus;                                  // до первого onStatus — { state: 'connecting' }
  init(bridge: HarnasBridge): () => void;              // подписка на onStatus; возвращает отписку
}
export const useHostStore: UseBoundStore<StoreApi<HostState>>;

// test-utils/fake-bridge.ts, дополнение к FakeBridge
/** Методы хоста в статусе connected; null — хост до этапа 3. По умолчанию REQUIRED_METHODS. */
setHostMethods(methods: string[] | null): void;
```

`BASELINE_METHODS` — дословно ключи `METHODS` и `NOTIFICATIONS` протокола на коммите
`0a93b93`: `hello`, `host.info`, `host.shutdown`, `providers.list`, `works.list`,
`works.create`, `works.delete`, `sessions.create`, `sessions.resume`, `sessions.stop`,
`sessions.delete`, `sessions.close`, `sessions.interrupted`,
`sessions.resumeInterrupted`, `pty.attach`, `pty.detach`, `wake.pause`, `wake.resume`,
`wake.state`, `settings.get`, `settings.set`, `rooms.create`, `rooms.send`,
`worktrees.available`, `worktrees.diff`, `worktrees.commit`, `worktrees.merge`,
`worktrees.discard`, `pty.input`, `pty.resize`.

`REQUIRED_METHODS` в 3.1 = `BASELINE_METHODS` + `works.rename`, `works.setStatus`.

**Поведение**
- **`renameWork`** обрезает пробелы. Пусто или длиннее 120 символов — ошибка с текстом
  «название работы: 1–120 символов». Символы считаются по кодовым точкам: эмодзи — один.
  Хост отдаёт ошибку как `bad_request`.
- **`setWorkStatus`** меняет `work.status`. Работа уходит в `archived` и с живыми
  сессиями — архив их не трогает, так же как сейчас не трогает TUI.
- **`work.updatedAt` не сдвигается.** `renameWork` и `setWorkStatus` пишут через
  `updateMap(…, { touch: false })`: переименование и статус — не события работы, иначе
  карточка всплывала бы в начало своего ранга с временем «сейчас» (спека 6.2).
- **Хост в ответе `hello`** отдаёт
  `methods = sort(['hello', ...keys(methodHandlers), ...keys(notificationHandlers)])`.
  `hello` обрабатывает сам `server.ts` до таблиц обработчиков, без него новый хост
  выглядел бы старым.
- **`HostConnection`** кладёт `methods` из ответа `hello` в статус `connected`. Поля нет
  — `null`.
- **Статус хоста — в `store/host.ts`**, а не в локальном state `App`: `App` зовёт
  `init(bridge)` и читает `status` оттуда, `useHostSupports` — тоже.
- **Строка статуса.** Если `missingMethods(status)` не пуст — сегмент «Хост старее окна
  — перезапустить». Клик открывает `ConfirmDialog`: «Перезапуск оборвёт живых агентов,
  они поднимутся через --resume» → `app.restartHost()`.
- **Функции** с неподдерживаемым методом прячутся через `useHostSupports`: пункты меню
  карточки «Переименовать», «Завершить», «Архивировать».

**Тесты**
1. `renameWork`: `'  Новая  '` → `'Новая'`; `''` и 121 символ — ошибка; 120 эмодзи
   принимаются; `work.updatedAt` не изменился.
2. `setWorkStatus('archived')` пишет статус и не меняет `work.updatedAt`; неверный
   статус схема протокола отвергает до хоста.
3. Хост: `works.rename` с пустым названием → `bad_request`; успешный вызов меняет
   карту на диске.
4. `server.test`: `methods` в ответе `hello` — ровно отсортированные ключи `METHODS` и
   `NOTIFICATIONS` протокола, `hello` среди них.
5. `HostConnection`: ответ `hello` без `methods` → `methods: null`; с `methods` —
   массив.
6. `capabilities`: `hostMethods` при `null` — ровно `BASELINE_METHODS`;
   `missingMethods` при `null` — `REQUIRED_METHODS` без `BASELINE_METHODS`. Список
   выводится, а не зашит: 4.1, 5.1 и 8.1 этот тест не трогают.
7. `capabilities`: `missingMethods` нового хоста пуст — статус с `methods` = ключи
   `METHODS` и `NOTIFICATIONS` протокола (то, что отдаёт хост по тесту 4) → `[]`.
8. `store/host.ts`: `onStatus` подставного моста пишет статус в стор;
   `useHostSupports('works.rename')` — `true` по умолчанию подставного моста, `false`
   после `setHostMethods(null)`.
9. `updateMap(…, { touch: false })` не меняет `work.updatedAt`, без опции — сдвигает.

**Приёмка**
- [ ] Все тесты зелёные во всех пакетах.

---

## 3.2. Внимание и порядок сайдбара

**Зачем.** Порядок карточек считается чистыми функциями: где нужен ты — выше.
**Зависит от:** —. **Спека:** 6.1, 6.2, 7.1.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `attention/derive.ts` и тест;
  - `sidebar/sort.ts` и тест;
  - `sidebar/use-deferred-order.ts` и тест.

**Интерфейсы**

```ts
// attention/derive.ts
export type Attention = 'needs-you' | 'unseen' | 'working' | 'idle' | 'off';
export const ATTENTION_RANK: Record<Attention, 4 | 3 | 2 | 1 | 0>;
export function sessionAttention(session: WorkSession, live: SessionActivity | null): Attention;
/** Прямые письма человеку (roomId === null, to содержит 'human'), не от человека, без readBy.human. */
export function humanUnreadLetters(map: WorkMap): Message[];
/** Сообщения комнаты не от человека без readBy.human: человек — участник любой комнаты. */
export function roomUnreadForHuman(map: WorkMap, roomId: string): number;
export interface WorkAttention {
  level: Attention;
  needsYou: number;                     // сессии в 'needs-you'
  unseen: number;
  humanUnread: number;
  roomsUnread: Record<string, number>;  // только комнаты с непрочитанным
  lastEventAt: string;                  // max(lastEventAt сессий, work.updatedAt, at последнего письма)
}
export function workAttention(entry: WorkEntry, activity: Record<string, ActivityEntry>): WorkAttention;

// sidebar/sort.ts
export interface SidebarSection {
  kind: 'pinned' | 'project';
  key: string;                          // 'pinned' | projectPath
  title: string;                        // 'Закреплённые' | имя папки
  projectPath: string | null;
  works: WorkEntry[];                   // уже отсортированы
  collapsed: boolean;
}
export function compareWorks(a: { attention: WorkAttention; createdAt: string }, b: typeof a): number;
export function buildSections(input: {
  entries: WorkEntry[];
  attention: Record<string, WorkAttention>;   // ключ — workKey
  pinned: string[]; collapsed: string[]; showDone: boolean;
}): SidebarSection[];
/** Видимый порядок работ — для ⌘1–9, ⌘⇧↑↓ и соседней работы (3.4). */
export function visibleWorkOrder(sections: SidebarSection[]): string[];

// sidebar/use-deferred-order.ts
/**
 * Пока указатель над списком, отдаёт свежие секции в прежнем порядке ключей: секций (`key`) и
 * работ в них (`workKey`). Новый порядок — после ухода указателя или через maxDeferMs.
 */
export function useDeferredOrder(sections: SidebarSection[], hovering: boolean, maxDeferMs?: number): SidebarSection[];  // 3000
```

**Поведение**
- **`sessionAttention`** — таблица спеки 7.1.
- **`workAttention.level`** — наивысший ранг сессий. `humanUnread > 0` поднимает его до
  `needs-you`. Комнаты уровень не поднимают. У работы без сессий и писем — `off`.
- **`compareWorks`:** ранг по убыванию, потом `lastEventAt` по убыванию, потом
  `createdAt` по возрастанию. `lastEventAt` не сдвигают переименование, смена статуса и
  отметки прочтения: они не трогают `work.updatedAt` (3.1, 4.1).
- **`buildSections`:**
  - «Закреплённые» — первыми, если в них есть хоть одна работа; закреплённая работа в
    группе проекта не повторяется;
  - группы проектов упорядочены по максимальному рангу внимания среди своих работ, при
    равенстве — по имени папки. Время и `createdAt` на порядок групп не влияют: при
    равном ранге он стабилен (спека 6.1);
  - `archived` скрыты всегда;
  - `done` — после остальных в своей группе, при `showDone: false` скрыты;
  - `collapsed` — по `collapsedProjects`.
- **`visibleWorkOrder`** — работы в порядке на экране: «Закреплённые», затем проекты.
  Работ свёрнутых проектов и скрытых `done` в нём нет.
- **`useDeferredOrder`** держит только порядок, данные карточек свежие. Работа или
  секция, которой не было в прежнем порядке, встаёт в конец; пропавшая убирается
  сразу.

**Тесты**
1. `sessionAttention`: все строки таблицы 7.1, включая `closed` → `off`, `sleeping` →
   `idle`, `active` без активности → `idle`.
2. `humanUnreadLetters`:
   - письмо агента агенту не считается;
   - письмо человеку от S01 без `readBy.human` — считается, с `readBy.human` — нет;
   - письмо от человека — нет.
3. `roomUnreadForHuman`: сообщение S01 в комнате — 1, сообщение человека — 0, после
   `readBy.human` — 0.
4. `workAttention`: работа с одной `blocked` и одной `unseen` → `level: 'needs-you'`,
   `needsYou: 1`, `unseen: 1`. Работа только с письмом человеку → `needs-you`.
   Работа только с непрочитанной комнатой → уровень по сессиям. Работа без сессий и
   писем → `off`.
5. `compareWorks`: ранг важнее времени; при равном ранге свежее выше; при равном
   времени старшая по созданию выше.
6. `buildSections`:
   - закреплённая работа не дублируется в проекте;
   - `archived` нет;
   - `done` в конце, при `showDone: false` отсутствует;
   - порядок групп проектов — по максимальному рангу; две группы с равным рангом идут
     по имени папки, даже если работа второй свежее.
7. `useDeferredOrder`: при `hovering` порядок держится, а данные карточек свежие; уход
   указателя отдаёт новый; через 3000 мс (поддельные таймеры) новый отдаётся и под
   указателем; новая работа под указателем — в конце своей секции, удалённая пропадает
   сразу.
8. `visibleWorkOrder`: «Закреплённые» первыми; работ свёрнутого проекта и скрытых
   `done` нет.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 3.3. Карточки, строки сессий, группы проектов

**Зачем.** Сайдбар как у Orca: видно, где что происходит, без чтения всех строк.
**Зависит от:** 3.2. **Спека:** 4.1 (цвета проектов), 4.2, 6.1, 6.3.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `sidebar/WorkSidebar.tsx`, `sidebar/ProjectGroup.tsx`, `sidebar/WorkCard.tsx`,
    `sidebar/SessionRow.tsx` и тесты;
  - `sidebar/use-sidebar-sections.ts` и тест — общий источник секций;
  - `lib/project-color.ts` и тест;
  - `lib/relative-time.ts` и тест;
  - `lib/use-now.ts` и тест.
- Изменить:
  - `shell/AppShell.tsx` — `WorkSidebar` вместо `Sidebar`; старый живёт до 3.5 за
    флагом `?sidebar=old` для сравнения. `AppShell` зовёт `useSidebarSectionsSync()`;
  - `store/ui.ts` — `sidebarHovering` и `setSidebarHovering`;
  - `packages/desktop/package.json` — `@tanstack/react-virtual`.
- Решение по значкам агентов: проверить правила брендов Anthropic и OpenAI на показ
  логотипа для обозначения интеграции. Результат — строкой в спеке, раздел 18,
  вопрос 1. Пока решения нет — буквенные значки из 1.2.

**Интерфейсы**

```ts
// lib/project-color.ts — REPO_COLORS Orca, спека 4.1
export const PROJECT_COLORS: readonly string[];            // 8 цветов
export function projectColor(projectPath: string): string; // стабильный хеш по модулю 8

// lib/relative-time.ts
/** 'сейчас' (< 1 мин), '3м', '2ч', 'вчера', '26 сент' (этот год), '26.09.2025'. */
export function relativeTime(iso: string, now: Date): string;

// lib/use-now.ts
/** Текущее время, обновляется раз в periodMs; WorkSidebar зовёт один раз и раздаёт карточкам. */
export function useNow(periodMs: number): Date;

// sidebar/use-sidebar-sections.ts
/** Секции в порядке на экране — общий источник WorkSidebar, ⌘1–9 и ⌘⇧↑↓ (3.4), nextAttentionTarget (4.2). */
export function useSidebarSections(): SidebarSection[];
/**
 * Единственный писатель: buildSections из сторов работ, активности и зеркала ui.json,
 * затем useDeferredOrder по sidebarHovering. Зовётся один раз в AppShell — живёт и при
 * свёрнутом сайдбаре.
 */
export function useSidebarSectionsSync(): void;

// store/ui.ts, дополнение
sidebarHovering: boolean;                 // указатель над списком сайдбара — ставит WorkSidebar
setSidebarHovering(hovering: boolean): void;

// sidebar/WorkCard.tsx
export interface WorkCardProps {
  entry: WorkEntry; attention: WorkAttention; activity: Record<string, ActivityEntry>;
  active: boolean; pinned: boolean; branch: string | null; now: Date;
  onActivate(): void; onOpenSession(sessionId: string): void;
  onOpenRooms(): void; onOpenMail(): void;
}
```

**Поведение**
- **Сайдбар** — спека 6.1:
  - верх: «Поиск ⌘J» (`setPaletteOpen(true)`) и «+ Работа ⌘N» (`openNewWorkDialog()`:
    до 3.5 — прежний `NewWorkDialog`, смонтированный в `AppShell` с 2.3);
  - список секций из `useSidebarSections()`; `pointerenter` и `pointerleave` списка →
    `setSidebarHovering`. Тот же порядок видят ⌘1–9 и строка статуса;
  - `showDone` — `ui.showDoneWorks` зеркала; переключатель — меню «⋯» секции (3.4);
  - больше 50 карточек — виртуализация `@tanstack/react-virtual`, оценка высоты
    карточки — 44px плюс 24px на строку сессии.
- **Заголовок проекта** 28px:
  - чип `projectColor`, имя папки, число работ, «+» — форма новой работы с этим
    проектом (из 3.5; до неё — `openNewWorkDialog()`, прежний диалог без проекта);
  - клик сворачивает и разворачивает (`patchUi({ collapsedProjects })`);
  - тултип — полный путь.
- **Карточка** — спека 6.3:
  - полоса по `attention.level` (orange, yellow, emerald, нет);
  - заголовок 13/20, `font-semibold` при `unseen > 0` или `humanUnread > 0`. Обрезает
    его CSS (`truncate`), а не строка: браузер режет по графемам и суррогатную пару не
    рвёт, в DOM название целиком;
  - `✉N`, `#N` (число комнат с непрочитанным), 📌, `relativeTime(lastEventAt, now)`;
  - мета 11px: имя папки · `N сессий` · ветка проекта из `WorksSnapshot.branches` моно;
  - строки сессий по `treeOrder`, отступ 12px на уровень;
  - закрытые спрятаны: «ещё N закрытых» разворачивает до конца сеанса окна
    (состояние в памяти);
  - `done` приглушена: `opacity-60` (спека 6.1).
- **Строка сессии** 24px:
  - `AgentStateDot`, `AgentIcon`, `S02 исполнитель` (`sessionRowLabel`), слово
    состояния `stateWord` muted 11px;
  - `⎇` при `session.worktree`, время `relativeTime`;
  - подсветка amber-500/10 при `needs-you` и `unseen`;
  - тултип (`ui/hover-card`): задача (первые 300 символов), первая строка `result`,
    иначе `summary`, модель и токены из `LiveMetrics`, ветка worktree;
  - `data-session-id` на строке: по нему кликают E2E `terminal.spec` и `cards.spec`;
  - перетаскивание — из 2.6, под `DndContext` `AppShell`.
- **Клики** (спека 6.4): по карточке — `setActiveWork`; по строке сессии —
  `setActiveWork` и `apply(openTab(terminal))`, как входы сайдбара 2.5.
- **Активная карточка** (`active`): фон
  `color-mix(in srgb, var(--work-sidebar-foreground) 8%, transparent)` (в тёмной 10%),
  рамка, тень `0 1px 2px`. Hover — `--work-sidebar-accent` 40%.
- **Обновление времени.** Раз в 30 с перерисовка по `now`, без таймера на каждую
  карточку: `WorkSidebar` зовёт `useNow(30_000)` один раз и раздаёт `now` карточкам.

**Тесты**
1. `projectColor` детерминирован и даёт цвет из восьми. Распределение — инвариантом по
   диапазону: 800 путей `/p/<i>` дают каждый цвет от 60 до 140 раз.
2. `relativeTime`: 30 с → `сейчас`, 3 мин → `3м`, 2 ч → `2ч`, вчерашняя дата →
   `вчера`, дата этого года → `26 сент`, прошлого — `26.09.2025`.
3. `WorkCard`:
   - полоса orange при `needs-you`;
   - жирный заголовок при `unseen`;
   - `✉2` при двух письмах; `#1`;
   - 📌 при `pinned`;
   - `ещё 2 закрытых` раскрывается кликом.
4. `SessionRow`: девять состояний из таблицы 4.2 дают свой значок и слово
   `stateWord`; `⎇` только с `worktree`; подсветка при `needs-you`; на строке
   `data-session-id`.
5. `WorkSidebar`:
   - «Закреплённые» наверху;
   - свёрнутый проект без карточек;
   - архивных нет;
   - при 60 работах в DOM больше нуля и меньше 60 карточек (виртуализация). У jsdom
     высота списка нулевая — размер задаёт `initialRect` виртуализатора, иначе карточек
     ноль и тест ничего не доказывает.
6. Пересортировка под указателем откладывается: `pointerenter`, событие `blocked`,
   порядок прежний; `pointerleave` — работа первая.
7. `WorkCard` со `status: 'done'` приглушена (`opacity-60`); название из 60 эмодзи в
   DOM целиком (`textContent` равен названию), у заголовка класс `truncate`.
8. «+ Работа» и «+» заголовка проекта открывают `NewWorkDialog` через
   `openNewWorkDialog`.
9. `useSidebarSections` в двух компонентах под `AppShell` отдаёт один порядок: пока
   `sidebarHovering` истинно, оба держат прежний; при свёрнутом сайдбаре секции
   по-прежнему обновляются.
10. `useNow(30_000)`: новая дата раз в 30 с (поддельные таймеры); размонтирование
    снимает таймер.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Решение по значкам агентов записано в спеке (раздел 18, вопрос 1).

---

## 3.4. Меню, переименование, клавиатура сайдбара

**Зачем.** Всё, что делается с работой, — из карточки, мышью и с клавиатуры.
**Зависит от:** 3.1, 3.3. **Спека:** 6.4, 6.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/sidebar/`:
  - `CardMenu.tsx`, `SessionRowMenu.tsx`, `RoomsMenu.tsx`, `SectionMenu.tsx`,
    `InlineRename.tsx` и тесты;
  - `use-sidebar-keys.ts` и тест.
- Изменить:
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` —
    `app.revealWork(projectPath, workId)`, канал `app:reveal-work`;
  - `renderer/test-utils/fake-bridge.ts` — `revealWork` с журналом вызовов;
  - `renderer/layout/keys.ts` и тест — ⌘⇧↑ и ⌘⇧↓. До 6.1 это обработчик `keydown` в
    рендерере, а не акселератор меню: пункт меню отнимал бы у полей ввода выделение до
    начала и конца;
  - `renderer/App.tsx`, `shell/AppShell.tsx` — ⌘1–9 (меню `work-N`) и ⌘⇧↑↓ по
    `visibleWorkOrder(useSidebarSections())` вместо `orderedWorks`; тот же порядок
    уходит в `order` `useLayoutPersistence`;
  - `renderer/layout/persistence.ts` и тест — соседняя работа и при архиве активной;
  - `renderer/components/rooms/CreateRoomDialog.tsx` и тест — `requiredMember`
    необязателен;
  - `renderer/store/ui.ts` — `dialogs.createRoom.requiredMember` может быть `null`.
- `SessionMenu.tsx` в 3.4 не удаляется: его импортирует `SessionTree.tsx` старого
  сайдбара, который живёт за `?sidebar=old` до 3.5. Оба уходят в 3.5.

**Интерфейсы**

```ts
// sidebar/CardMenu.tsx — пункты спеки 6.4
export type CardAction = 'pin' | 'unpin' | 'new-session' | 'new-room' | 'open-mail' | 'rename'
  | 'reveal' | 'copy-path' | 'finish' | 'archive' | 'delete';
// sidebar/use-sidebar-keys.ts
export interface SidebarCursor { workKey: string; sessionId: string | null }
export function moveCursor(order: SidebarCursor[], current: SidebarCursor | null, key: 'ArrowUp' | 'ArrowDown'): SidebarCursor | null;

// layout/keys.ts — ещё один исход layoutKeyAction
| { kind: 'work-step'; step: 1 | -1 }       // ⌘⇧↓ — 1, ⌘⇧↑ — −1

// components/rooms/CreateRoomDialog.tsx — было обязательным
requiredMember: { id: string; label: string } | null;   // null — из меню карточки
```

**Поведение**
- **Меню карточки** (`ui/context-menu`):

| Пункт | Действие |
|---|---|
| Закрепить / Открепить | `patchUi({ pinnedWorks })` |
| Новая сессия | диалог новой сессии для этой работы |
| Новая комната | `openCreateRoomDialog({ projectPath, workId, requiredMember: null })` |
| Открыть почту | вкладка `mail` |
| Переименовать | `InlineRename` |
| Показать в Finder | `app.revealWork(projectPath, workId)`: main проверяет по `works.list`, что такая работа есть, и зовёт `shell.showItemInFolder(projectPath)` |
| Скопировать путь | `navigator.clipboard.writeText(projectPath)` |
| Завершить | `works.setStatus('done')` |
| Архивировать | `ConfirmDialog` → `works.setStatus('archived')` |
| Удалить… | `ConfirmDialog` с числом сессий и предупреждением «живые процессы остановятся» → `sessions.stop` живых сессий → `works.delete` |

  Пункты с неподдерживаемыми методами спрятаны (`useHostSupports`).
- **«Удалить…».** Хост отвечает `conflict`, пока у работы есть живая сессия. Поэтому
  после подтверждения окно зовёт `sessions.stop` каждой сессии с `lifecycle: 'active'`
  и только затем `works.delete`. Подтверждение — согласие человека на остановку
  (рамка 15.1). Отказ хоста — тост с текстом ошибки.
- **Активная работа удалена или архивирована** → активной становится соседняя по
  `visibleWorkOrder` (`neighborWork`, 2.2). Раскладка удалённой стирается, архивной —
  остаётся.
- **«Новая комната»** открывает `CreateRoomDialog` без обязательного участника:
  заголовок «Новая комната», «Создать» доступна от одного выбранного участника.
- **`SectionMenu`** — меню «⋯» заголовка секции: переключатель «Показывать
  завершённые» → `patchUi({ showDoneWorks })` (спека 6.1).
- **`InlineRename`:**
  - двойной клик по заголовку или пункт меню;
  - поле на месте заголовка, выделено всё;
  - Enter — `works.rename`, Esc или потеря фокуса без изменений — отмена;
  - ошибка — тост и возврат прежнего названия.
- **`RoomsMenu`.** Клик по `#N` — меню всех комнат работы со счётчиками
  `roomUnreadForHuman`. Выбор — вкладка `room`.
- **`SessionRowMenu`** — пункты нынешнего `SessionMenu` плюс «Скопировать путь
  worktree», если у сессии `worktree`. «Открыть рядом» — `splitGroup` активной группы
  вправо (`row`) с вкладкой терминала этой сессии.
- **Клавиатура сайдбара** — спека 6.5:
  - Tab в сайдбар ставит курсор на активную карточку;
  - ↑↓ ходят по карточкам и строкам сессий, Enter открывает;
  - → разворачивает закрытые, ← сворачивает;
  - Shift+F10 открывает меню элемента под курсором.
- **⌘1–9** — N-я работа `visibleWorkOrder`, **⌘⇧↑↓** — соседняя. Обработчик `keydown`
  окна пропускает ⌘⇧↑↓ из `input`, `textarea`, `contenteditable` и терминала (`.xterm`):
  там это выделение текста.

**Тесты**
1. «Закрепить» зовёт `patchUi` с работой в `pinnedWorks`, «Открепить» — без неё.
2. «Удалить…»: до подтверждения — ни одного вызова; после — `sessions.stop` каждой
   сессии с `lifecycle: 'active'`, затем `works.delete`; `conflict` от хоста → тост.
3. `InlineRename`: Enter зовёт `works.rename` с новым названием; Esc — не зовёт;
   ошибка хоста возвращает прежнее название и показывает тост.
4. `RoomsMenu` показывает все комнаты работы и счётчики.
5. После `setHostMethods` без `works.rename` пункта «Переименовать» нет.
6. `moveCursor`: ↓ с последней строки остаётся на ней; ↑ с первой — на ней;
   переход между карточками идёт через строки сессий.
7. ⌘1 открывает первую работу видимого порядка, включая «Закреплённые».
8. `SectionMenu`: «Показывать завершённые» зовёт `patchUi({ showDoneWorks: false })`,
   и работы `done` пропадают из секции.
9. Активная работа: снимок со `status: 'archived'` → активна соседняя по
   `visibleWorkOrder`, `removeLayout` не зван; снимок без неё → соседняя и
   `removeLayout`.
10. «Новая комната» из меню карточки: `CreateRoomDialog` без обязательного участника,
    «Создать» неактивна, пока никто не выбран; `rooms.create` — с выбранными.
11. ⌘⇧↓ в поле ввода и в терминале работу не меняет; вне их — соседняя по видимому
    порядку.
12. «Открыть рядом» в `SessionRowMenu`: групп стало две, вкладка сессии — в правой.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 3.5. Форма новой работы; приёмка этапа 3

**Зачем.** Новая работа с первой сессией — одним действием, как у Orca.
**Зависит от:** 3.4. **Спека:** 6.6.

**Файлы**
- Создать: `packages/desktop/src/renderer/sidebar/NewWorkComposer.tsx` и тест.
- Изменить:
  - `renderer/components/dialogs/NewSessionDialog.tsx` и тест — агент по умолчанию, как
    у формы (ниже); `patchUi({ lastProvider })` при создании;
  - `renderer/store/ui.ts` — `dialogs.newWork` с проектом, `openNewWorkDialog(projectPath?)`;
  - `renderer/App.tsx`, `shell/AppShell.tsx` — `AppShell` монтирует `NewWorkComposer`
    вместо `NewWorkDialog`; меню `new-work` (⌘N, 2.3), «+ Работа» и «+» заголовка
    проекта открывают его.
- Удалить:
  - `renderer/components/dialogs/NewWorkDialog.tsx`;
  - `renderer/components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx`,
    `SessionMenu.tsx` (из 3.4 — вместе с его потребителем), `StatusDot.tsx`,
    `MetricsLine.tsx`;
  - их тесты и флаг `?sidebar=old`.
- Создать: `packages/desktop/e2e/cards.spec.ts`.
- Документы: `README.md`, раздел «Окно» — сайдбар, карточки, «Закреплённые», форма.

**Интерфейсы**

```ts
export interface NewWorkDraft {
  projectPath: string | null; title: string; goal: string;
  startSession: boolean; provider: string | null; label: string; task: string;
  worktree: boolean; createMore: boolean;
}
/** Пределы спеки 6.6: название 1–120, цель до 4000, ярлык до 40, задача до 20000 — по кодовым точкам. */
export function validateDraft(draft: NewWorkDraft): Partial<Record<keyof NewWorkDraft, string>>;

// sidebar/NewWorkComposer.tsx — диалог шириной 560 px
export interface NewWorkComposerProps {
  open: boolean;
  projectPath: string | null;          // от «+» заголовка проекта — уже выбран
  onOpenChange(open: boolean): void;
}

// store/ui.ts — dialogs.newWork вместо boolean
newWork: { open: boolean; projectPath: string | null };
openNewWorkDialog(projectPath?: string): void;
```

**Поведение** — спека 6.6:
- **Проекты** — из `projectPath` всех работ плюс «Выбрать папку…» (`app.chooseFolder`).
  От «+» заголовка проекта проект уже выбран.
- **Агенты** — `providers.list`, только `available`. По умолчанию —
  `ui.lastProvider ?? 'claude'`, если он среди доступных, иначе первый доступный. То же
  правило — в `NewSessionDialog`.
- **Поле «Свой worktree»** видно после `worktrees.available { projectPath }` →
  `available: true`.
- **Отправка:** ⌘Enter или «Создать».
  - `works.create`, при `startSession` — затем `sessions.create`.
  - Ошибка второго вызова — работа уже создана, в форме ошибка сессии и «Повторить»:
    повторяется только `sessions.create`.
  - Успех → `setActiveWork` и `apply(openTab(terminal))` новой сессии: работа ещё не
    гидрирована, операция ждёт `hydrate` в очереди (2.2). Затем
    `patchUi({ lastProvider })`.
  - «Создать ещё» — форма очищает название, цель и задачу и остаётся открытой.

**Тесты**
1. `validateDraft`:
   - без проекта — ошибка «Выберите проект»;
   - пустое название — «Название: 1–120 символов»;
   - 121 символ — та же ошибка, 120 эмодзи — без ошибки;
   - цель 4001 символ — «Цель: до 4000 символов»; ярлык 41 — «Ярлык: до 40 символов»;
     задача 20001 — «Задача: до 20000 символов»;
   - при `startSession` без агента — «Выберите агента».
2. Успех: `works.create`, затем `sessions.create` с `worktree` из формы; работа
   активна, вкладка открыта.
3. `sessions.create` падает: работа не пересоздаётся, «Повторить» зовёт только
   `sessions.create`.
4. «Создать ещё»: после успеха форма открыта, название пустое, проект и агент
   сохранены.
5. **E2E `cards.spec.ts`:**
   - две работы в одном проекте, по сессии в каждой; указатель вне сайдбара, иначе
     пересортировка отложена;
   - порядок до событий: вторая работа создана позже и при равном ранге выше;
   - тест дописывает `{"hook_event_name":"UserPromptSubmit"}` в журнал сессии первой
     работы (`<project>/.harnas/works/<workId>/events/<sessionId>.jsonl`) — за 2 с первая
     выше второй: `working` против `idle`. Так проверена сортировка по вниманию, а не
     по времени создания;
   - затем строку `{"hook_event_name":"Notification","notification_type":"permission_prompt"}`
     в журнал второй — за 2 с вторая снова первая, у её строки сессии значок вопроса.
6. **E2E:** форма новой работы с включённым «Создать ещё» создаёт две работы подряд.
7. «+» заголовка проекта открывает форму с этим проектом; меню `new-work` (⌘N) — без
   проекта.
8. Агент по умолчанию: `ui.lastProvider`; без него — `claude`; `claude` недоступен —
   первый доступный. Так же в `NewSessionDialog`.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 3** (человек, на пересобранном `harnas.app`)
- [ ] Три работы в двух проектах: сессия, ждущая разрешения, поднимает свою работу
      первой.
- [ ] Закрепление, переименование на месте, архив и удаление работают из меню.
- [ ] ⌘1–9 и ⌘⇧↑↓ ходят в видимом порядке.
- [ ] `README.md` обновлён.
