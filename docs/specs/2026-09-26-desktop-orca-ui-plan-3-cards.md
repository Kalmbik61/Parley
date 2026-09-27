# План, этап 3: карточки

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 6, 7.1, строка 3 таблицы 14.3.

**Итог этапа:**
- сайдбар из групп проектов и «Закреплённых» с карточками работ;
- работа, где нужен ты, стоит первой;
- меню карточки, переименование на месте, клавиатура;
- форма новой работы как у Orca.

**Перед стартом.** Сверить с кодом этапа 2:
- `layout/store.ts` (`setActiveWork`, `apply`, очередь до `hydrate`; `selectedSessionOf`
  появляется в 2.7) и `layout/tree.ts#openTab` — открытие вкладки:
  `apply(workKey, l => openTab(l, tab))`;
- `layout/persistence.ts` (`order`): соседа пропавшей активной работы выбирает
  `survivingNeighbor`, а `neighborWork` рантаймом не вызывается;
- `layout/dnd.ts` (`dndId`, `DragSourceData`, `dragItemOf` — в коде 2.6 они есть, в плане
  2.6 их нет) и `DndContext` в `AppShell` (перетаскивание строк сессий);
- `store/ui.ts` (зеркало `ui`, `patchUi`, `dialogs`) и `shared/ui-types.ts`
  (`pinnedWorks`, `collapsedProjects`, `showDoneWorks`, `lastProvider`);
- `lib/mail-view.ts#recipientsOf`, `lib/tree-order.ts`, `lib/dot-state.ts`
  (`stateWord`);
- `shared/strings.ts` (`S`, `errorText`) и `shared/ipc-error.ts` (`decodeIpcError`) —
  из E.1.

**Проверить после 2.7** — места плана, которые опираются на код 2.7:
- ⌘T берёт работу из `activeWorkKey` — «Новая сессия» из меню карточки (3.4);
- `selectedSessionOf` и имена `layout/dnd.ts` — подсветка и перетаскивание `SessionRow`
  (3.3);
- флаги окна в `main/index.ts`: после 2.7 там нет `center=new` (3.3, 3.5);
- тесты `shell/AppShell.test.tsx` после удаления `Workspace` (3.3, 3.4).

**Правило для человека в комнатах.** Человек — участник каждой комнаты, но в
`room.members` не пишется, а `recipientsOf` (`lib/mail-view.ts:41`) его вычитает
(`:46`). Поэтому непрочитанное человеком считается своими функциями (3.2), а не через
`recipientsOf`.

**Строки интерфейса** — правило индекса («Сквозные ограничения», кусок E.1):
- русские строки интерфейса в «…» ниже — смысл, а не текст. Текст — английский, ключом
  `S` в `packages/desktop/src/shared/strings.ts`: ключ и английский стоят рядом или в
  «Интерфейсах» куска. Кусок, который добавляет строки, вносит `shared/strings.ts` в
  «Изменить»;
- тесты ждут английский текст;
- ошибку хоста окно показывает как `errorText(decodeIpcError(err).code,
  S.errors.actions.<действие>)`, по образцу `CreateRoomDialog.tsx` и
  `NewSessionDialog.tsx`. Текст хоста — только в консоль;
- даты и время — `en-US`.

---

## 3.1. core и хост: `works.rename`, `works.setStatus`, список методов в `hello`

**Зачем.**
- Меню карточки умеет переименовать, завершить и архивировать работу.
- Окно узнаёт, какие методы понимает хост, и не падает на старом хосте.
- Окно, подключившееся к живому хосту, сразу знает активность сессий, а не ждёт их
  следующего события.

**Зависит от:** —. **Спека:** 3.2, 6.7.

**Файлы**
- Изменить:
  - `packages/core/src/work/store.ts` и тест — `renameWork`, `setWorkStatus`; опция
    `touch` у `updateMap` (`UpdateMapOptions`);
  - `packages/core/src/index.ts` — экспорт;
  - `packages/protocol/src/methods.ts` и тест — схемы и результаты новых методов,
    `methods?: string[]` в результате `hello`;
  - `packages/host/src/methods/works.ts` и `works.test.ts` — `worksRename`,
    `worksSetStatus`; работы нет — `not_found`;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/host/src/server.ts` и `server.test.ts` — `hello` отдаёт `methods`; новый
    клиент получает текущую активность сессий;
  - `packages/host/src/activity/activity-service.ts` и `activity-service.test.ts` —
    `current()`;
  - `packages/host/src/host.ts` — `registerClient` после ответа `hello` шлёт клиенту
    `activity.changed` из `current()`;
  - `packages/desktop/src/main/host-connection.ts` и тест — `methods` в статусе;
  - `packages/desktop/src/shared/bridge.ts` — `HostStatus.connected.methods`;
  - `packages/desktop/src/shared/strings.ts` — строки сегмента и подтверждения
    перезапуска;
  - `packages/desktop/src/renderer/test-utils/fake-bridge.ts` — статус `connected` с
    `methods: REQUIRED_METHODS` по умолчанию и сеттер `setHostMethods`;
  - `packages/desktop/src/renderer/App.tsx` — статус хоста из `store/host.ts` вместо
    локального `useState`;
  - `packages/desktop/src/renderer/shell/StatusBar.tsx` — сегмент «Хост старее окна»,
    свой `ConfirmDialog` и проп `onRestartHost`;
  - `packages/desktop/src/renderer/shell/AppShell.tsx` — передаёт `onRestartHost`.
- Создать:
  - `packages/desktop/src/renderer/lib/capabilities.ts` и тест;
  - `packages/desktop/src/renderer/store/host.ts` и тест — стор статуса хоста;
  - `packages/desktop/src/renderer/shell/StatusBar.test.tsx`.

**Интерфейсы**

```ts
// core/work/store.ts
/** Только у updateMap: createWork, deleteWorkFiles и pruneWorksIndex берут прежний WriteOptions. */
export interface UpdateMapOptions extends WriteOptions {
  /** false — `work.updatedAt` не сдвигается: правка не событие работы (порядок сайдбара, спека 6.2). */
  touch?: boolean;                 // по умолчанию true
}
export async function updateMap(projectPath: string, workId: string,
  mutate: (map: WorkMap) => void, options?: UpdateMapOptions): Promise<WorkMap>;
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
export function hostMethods(status: HostStatus): Set<string>;   // connected: methods ?? BASELINE_METHODS; иначе пусто
export function missingMethods(status: HostStatus): string[];   // только у connected; иначе []
export function useHostSupports(method: string): boolean;       // статус — из useHostStore; не connected — false

// renderer/store/host.ts
export interface HostState {
  status: HostStatus;                                  // до первого onStatus — { state: 'connecting' }
  init(bridge: HarnasBridge): () => void;              // подписка на onStatus; возвращает отписку
}
export const useHostStore: UseBoundStore<StoreApi<HostState>>;

// test-utils/fake-bridge.ts, дополнение к FakeBridge
/**
 * Методы хоста в статусе connected; null — хост до этапа 3. По умолчанию REQUIRED_METHODS.
 * Заново рассылает статус подписчикам onStatus, как emitStatus.
 */
setHostMethods(methods: string[] | null): void;

// shell/StatusBar.tsx, дополнение StatusBarProps
/** «Restart» в подтверждении: AppShell передаёт () => void bridge.app.restartHost(). */
onRestartHost: () => void;

// host/activity/activity-service.ts, дополнение ActivityService
/** Текущая активность всех сессий, которые держит сервис, — повтор для нового клиента. */
current(): Array<EventData<'activity.changed'>>;

// shared/strings.ts, дополнение S.statusBar (английский текст; русский в плане — смысл)
hostOutdated: 'Host is outdated — restart',       // «Хост старее окна — перезапустить»
restartHostTitle: 'Restart host?',
restartHostDescription: 'Live agents will be interrupted and come back with --resume.',
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
  «название работы: 1–120 символов» (текст core, core не переводится; окно покажет
  `errorText` по коду). Символы считаются по кодовым точкам: эмодзи — один. Хост отдаёт
  ошибку как `bad_request`.
- **`setWorkStatus`** меняет `work.status`. Работа уходит в `archived` и с живыми
  сессиями — архив их не трогает, так же как сейчас не трогает TUI.
- **Работы нет** — `works.rename` и `works.setStatus` отвечают `not_found`, как
  `mail.markRead` (4.1). Обработчик читает карту до вызова core
  (`readMap(…).catch(() => null)`, приём `worksDelete`): `updateMap` на несуществующую
  работу бросает обычный `Error`, и хост отдал бы `internal`.
- **`work.updatedAt` не сдвигается.** `renameWork` и `setWorkStatus` пишут через
  `updateMap(…, { touch: false })`: переименование и статус — не события работы, иначе
  карточка всплывала бы в начало своего ранга с временем `now` (спека 6.2). Опция
  `touch` — только у `updateMap` (`UpdateMapOptions`): у `createWork`,
  `deleteWorkFiles` и `pruneWorksIndex` она ничего бы не значила.
- **Хост в ответе `hello`** отдаёт
  `methods = sort(['hello', ...keys(methodHandlers), ...keys(notificationHandlers)])`.
  `hello` обрабатывает сам `server.ts` до таблиц обработчиков, без него новый хост
  выглядел бы старым.
- **Новый клиент узнаёт активность сразу.** Хост шлёт `activity.changed` только при
  изменении (`activity-service.ts`), а живёт дольше окна. Окно, перезапущенное при
  живом хосте, до следующего события считало бы сессию, ждущую разрешения, `idle`: в
  `blocked` она событий больше не шлёт, и её работа не поднимается. Поэтому
  `registerClient` в `host.ts` после ответа `hello` шлёт этому клиенту `activity.changed`
  на каждую запись `current()`. Новых методов нет, протокол не меняется; другие
  клиенты повторов не получают.
- **`HostConnection`** кладёт `methods` из ответа `hello` в статус `connected`. Поля нет
  — `null`.
- **Статус хоста — в `store/host.ts`**, а не в локальном state `App`: `App` зовёт
  `init(bridge)` и читает `status` оттуда, `useHostSupports` — тоже.
- **Без связи** (`connecting`, `mismatch`, `disconnected`) `hostMethods` пуст, а
  `missingMethods` — `[]`: звать нечего и подсказывать про версию некому, у `mismatch`
  свой экран.
- **Строка статуса.** Если `missingMethods(status)` не пуст — сегмент «Хост старее окна
  — перезапустить» (`S.statusBar.hostOutdated`). Клик открывает `ConfirmDialog` самой
  `StatusBar` (локальное состояние; 6.3 переведёт открытие на `confirmRestartHost`):
  заголовок `S.statusBar.restartHostTitle`, описание «перезапуск оборвёт живых агентов,
  они поднимутся через --resume» (`S.statusBar.restartHostDescription`), кнопка
  `S.connection.restart` (`Restart`) → `onRestartHost()`. `AppShell` передаёт
  `() => void bridge.app.restartHost()`.
- **Функции** с неподдерживаемым методом прячутся через `useHostSupports`: пункты меню
  карточки «Переименовать» (`Rename`), «Завершить» и «Вернуть в работу» (`Mark as done`,
  `Reopen`), «Архивировать» (`Archive`) и двойной клик переименования (3.4).

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
   после `setHostMethods(null)`: сеттер заново рассылает статус подписчикам `onStatus`.
9. `updateMap(…, { touch: false })` не меняет `work.updatedAt`, без опции — сдвигает.
10. Хост: `works.rename` и `works.setStatus` для несуществующей работы → `not_found`, а
    не `internal`.
11. `capabilities` при `connecting`, `mismatch` и `disconnected`: `hostMethods` пуст,
    `missingMethods` — `[]`, `useHostSupports` — `false`.
12. `StatusBar`: статус `connected` с `methods: null` — сегмент
    `Host is outdated — restart`; клик — подтверждение `Restart host?`; `Restart` зовёт
    `onRestartHost` один раз, `Cancel` — ни разу. С полным `REQUIRED_METHODS` сегмента
    нет.
13. `activity-service`: после `PermissionRequest` в журнале сессии `current()` отдаёт её
    с `blocked`.
14. Хост (`server.test.ts`): сессия ушла в `blocked`, потом подключается второй клиент —
    сразу после ответа на `hello` он получает `activity.changed` этой сессии с
    `blocked`. Список методов при этом прежний: тест 4 не меняется.

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
- Изменить: `packages/desktop/src/shared/strings.ts` — `S.sidebar.pinned`
  (`Pinned`), заголовок «Закреплённых».

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
  title: string;                        // S.sidebar.pinned ('Pinned') | имя папки
  projectPath: string | null;
  works: WorkEntry[];                   // показанные в секции, уже отсортированы
  collapsed: boolean;
}
export function compareWorks(a: { attention: WorkAttention; createdAt: string }, b: typeof a): number;
export function buildSections(input: {
  entries: WorkEntry[];
  attention: Record<string, WorkAttention>;   // ключ — workKey
  pinned: string[]; collapsed: string[]; showDone: boolean;
}): SidebarSection[];
/** Видимый порядок работ — для ⌘1–9, ⌘⇧↑↓, соседней работы и выбора на старте (3.4). */
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
  - «Закреплённые» (`S.sidebar.pinned` — `Pinned`) — первыми, если в них есть хоть одна
    работа; закреплённая работа в группе проекта не повторяется;
  - группы проектов упорядочены по максимальному рангу внимания среди своих работ, при
    равенстве — по имени папки. Время и `createdAt` на порядок групп не влияют: при
    равном ранге он стабилен (спека 6.1);
  - ранг группы считается по работам, показанным в ней: закреплённая работа поднимает
    «Закреплённые», а не группу своего проекта;
  - `archived` скрыты всегда;
  - `done` — после остальных в своей группе, при `showDone: false` скрыты. Правило одно
    для всех секций, для «Закреплённых» тоже;
  - группа проекта без единой показанной работы (все закреплены, архивны или скрытые
    `done`) не показывается;
  - число работ в заголовке проекта — `works.length` секции, то есть показанные;
  - `collapsed` — по `collapsedProjects`.
- **`visibleWorkOrder`** — работы в порядке на экране: «Закреплённые», затем проекты.
  Работ свёрнутых проектов и скрытых `done` в нём нет. Он нужен клавишам, выбору соседа
  и выбору на старте. Раскладки (`retainLayouts`, `drop`, `removeLayout`) идут по
  составу снимка — всем работам, 3.4.
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
     по имени папки, даже если работа второй свежее;
   - группы проекта, где все работы закреплены или архивны, нет; где остались только
     `done` при `showDone: false` — тоже;
   - закреплённая `done` при `showDone: false` пропадает и из «Закреплённых»;
   - закреплённая работа в `needs-you` не поднимает группу своего проекта;
   - `title` секции закреплённых — `Pinned`.
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
  - `sidebar/use-sidebar-sections.ts` и тест — общий источник секций и внимания;
  - `lib/project-color.ts` и тест;
  - `lib/relative-time.ts` и тест;
  - `lib/use-now.ts` и тест.
- Изменить:
  - `shell/AppShell.tsx` — `WorkSidebar` вместо `Sidebar`; старый живёт до 3.5 за
    флагом `?sidebar=old` для сравнения. `AppShell` зовёт `useSidebarSectionsSync()`;
  - `shell/AppShell.test.tsx` — `getByText('Search')` находит две кнопки, заголовка и
    сайдбара; строки «All workspace mail» в `WorkSidebar` нет — тест открывает почту
    через `✉N` карточки (письмо человеку);
  - `src/main/index.ts` — переменная `HARNAS_DESKTOP_SIDEBAR=old` даёт флаг
    `sidebar=old`, как прежде `HARNAS_DESKTOP_CENTER=new` давала `center=new`. Иначе
    флаг нечем включить: флаги окна ставит main;
  - `store/ui.ts` — `sidebarHovering` и `setSidebarHovering`;
  - `shared/strings.ts` — строки сайдбара и времени (ниже);
  - `styles/tokens.css` и `tokens.test.ts` — цвет вторичного текста на активной карточке
    и подсвеченной строке, контраст в обеих темах;
  - `packages/desktop/package.json` — `@tanstack/react-virtual`.
- Решение по значкам агентов: проверить правила брендов Anthropic и OpenAI на показ
  логотипа для обозначения интеграции. Результат — строкой в спеке, раздел 18,
  вопрос 1. Пока решения нет — буквенные значки из 1.2.

**Интерфейсы**

```ts
// lib/project-color.ts — REPO_COLORS Orca, спека 4.1
export const PROJECT_COLORS: readonly string[];            // 8 цветов
export function projectColor(projectPath: string): string; // стабильный хеш по модулю 8

// lib/relative-time.ts — en-US, слова из S.time
/** 'now' (< 1 мин), '3m', '2h', 'yesterday', 'Sep 26' (этот год), 'Sep 26, 2025' (прошлые). */
export function relativeTime(iso: string, now: Date): string;

// lib/use-now.ts
/** Текущее время, обновляется раз в periodMs; WorkSidebar зовёт один раз и раздаёт карточкам. */
export function useNow(periodMs: number): Date;

// sidebar/use-sidebar-sections.ts
/** Секции в порядке на экране — общий источник WorkSidebar, ⌘1–9 и ⌘⇧↑↓ (3.4), nextAttentionTarget (4.2). */
export function useSidebarSections(): SidebarSection[];
/** Внимание работ того же расчёта (ключ — workKey): WorkSidebar и карточки его не пересчитывают. */
export function useSidebarAttention(): Record<string, WorkAttention>;
/**
 * Единственный писатель: buildSections из сторов работ, активности и зеркала ui.json,
 * затем useDeferredOrder по sidebarHovering. Зовётся один раз в AppShell — живёт и при
 * свёрнутом сайдбаре. Возвращает секции своего рендера: стор пишет эффект, поэтому
 * useSidebarSections() отстаёт на рендер, а AppShell берёт видимый порядок из возврата (3.4).
 */
export function useSidebarSectionsSync(): SidebarSection[];

// store/ui.ts, дополнение
sidebarHovering: boolean;                 // указатель над списком сайдбара — ставит WorkSidebar
setSidebarHovering(hovering: boolean): void;

// sidebar/WorkCard.tsx — на корне карточки data-work-key (E2E cards.spec, 3.5)
export interface WorkCardProps {
  entry: WorkEntry; attention: WorkAttention; activity: Record<string, ActivityEntry>;
  active: boolean; pinned: boolean; branch: string | null; now: Date;
  /** Выбранная сессия (selectedSessionOf, 2.7), если она в этой работе. */
  selectedSessionId: string | null;
  onActivate(): void; onOpenSession(sessionId: string): void;
  onOpenMail(): void;                     // клик по ✉N; меню комнат по # — 3.4
}

// sidebar/SessionRow.tsx — контракт перетаскивания 2.6, как у строки SessionTree.tsx
export interface SessionRowProps {
  workKey: string; session: WorkSession; depth: number;
  activity: ActivityEntry | null; now: Date;
  /** Работа строки активна: только тогда строку можно тащить (спека 6.4). */
  draggable: boolean;
  selected: boolean;
  onOpen(): void;
}
// useDraggable({ id: dndId.session(workKey, session.id),
//   data: { item: { kind: 'session', sessionId } } /* DragSourceData */, disabled: !draggable });
// на строке data-session-id и data-selected; data-draggable — только при draggable, иначе
// cursor-not-allowed; HTML5-атрибута draggable нет

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
sidebar: {
  search: 'Search',                                   // «Поиск»; подпись ⌘K до 6.2
  newWorkspaceInProject: 'New workspace in project',  // aria-label «+» заголовка проекта
  sessionCount: (n: number) => string,                // «N сессий»: '1 session', '3 sessions'
  moreClosed: (n: number) => string,                  // «ещё N закрытых»: '+2 closed'
},
time: {
  now: 'now', yesterday: 'yesterday',
  minutes: (n: number) => string,                    // '3m'
  hours: (n: number) => string,                      // '2h'
},
```

**Поведение**
- **Сайдбар** — спека 6.1:
  - верх: «Поиск» (`S.sidebar.search` — `Search`, `setPaletteOpen(true)`) с подписью
    ⌘K и «+ Работа ⌘N» (`S.sidebar.addWorkspace` — `+ workspace`; `openNewWorkDialog()`:
    до 3.5 — прежний `NewWorkDialog`, смонтированный в `AppShell` с 2.3). До 6.2 палитра
    висит на ⌘K (`main/menu.ts`), заголовок и `Landing` показывают ⌘K, а тест
    `AppShell.test.tsx` требует, чтобы ⌘J нигде не было. Подпись ⌘J ставит 6.2;
  - список секций из `useSidebarSections()`, внимание — из `useSidebarAttention()`;
    `pointerenter` и `pointerleave` списка → `setSidebarHovering`. Тот же порядок видят
    ⌘1–9 и строка статуса;
  - размонтирование списка сбрасывает `sidebarHovering`: ⌘B прячет сайдбар под
    указателем без `pointerleave`, флаг залип бы, и каждая пересортировка ждала бы 3 с;
  - `showDone` — `ui.showDoneWorks` зеркала; переключатель — меню «⋯» секции (3.4);
  - больше 50 карточек — виртуализация `@tanstack/react-virtual`, оценка высоты
    карточки — 44px плюс 24px на строку сессии.
- **Заголовок проекта** 28px:
  - чип `projectColor`, имя папки, число работ (`works.length` секции), «+»
    (`aria-label` `S.sidebar.newWorkspaceInProject`) — форма новой работы с этим
    проектом (из 3.5; до неё — `openNewWorkDialog()`, прежний диалог без проекта);
  - клик сворачивает и разворачивает (`patchUi({ collapsedProjects })`);
  - тултип — полный путь.
- **Карточка** — спека 6.3:
  - `data-work-key` на корне: по нему E2E `cards.spec` (3.5) читает порядок карточек;
  - полоса по `attention.level` (orange, yellow, emerald, нет);
  - заголовок 13/20, `font-semibold` при `unseen > 0` или `humanUnread > 0` (спека 6.3;
    строка «Карточка» таблицы 7.3 выровнена так же). Обрезает его CSS (`truncate`), а
    не строка: браузер режет по графемам и суррогатную пару не рвёт, в DOM название
    целиком;
  - `✉N`; `#N` — число комнат с непрочитанным, а у работы с комнатами без
    непрочитанного — `#` без числа: иначе комнату без новых сообщений из сайдбара не
    открыть. Меню комнат по клику — 3.4;
  - 📌, `relativeTime(lastEventAt, now)`;
  - мета 11px: имя папки · «N сессий» (`S.sidebar.sessionCount(n)` — `3 sessions`) ·
    ветка проекта из `WorksSnapshot.branches` моно;
  - строки сессий по `treeOrder`, отступ 12px на уровень;
  - закрытые спрятаны: «ещё N закрытых» (`S.sidebar.moreClosed(n)` — `+2 closed`)
    разворачивает до конца сеанса окна (состояние в памяти);
  - `done` приглушена: `opacity-60` (спека 6.1).
- **Строка сессии** 24px:
  - `AgentStateDot`, `AgentIcon`, `S02 исполнитель` (`sessionRowLabel`), слово
    состояния `stateWord` muted 11px;
  - `⎇` при `session.worktree`, время `relativeTime`;
  - пометка trust-wait: ⚠ с тултипом `S.sidebar.trustWaitTooltip`, если в
    `store/notices.ts` есть `host.notice` вида `trust-wait` по ref строки — то же правило,
    что сейчас в `SessionTree.tsx:156–166`. Пометка переезжает сюда до удаления
    `SessionTree` в 3.5: требование `2026-09-26-desktop-plan-4-worktree.md` («пометка в
    строке сессии») в силе;
  - подсветка amber-500/10 при `needs-you` и `unseen`; выбранная сессия
    (`selectedSessionOf`, 2.7) — `data-selected` и подложка `--work-sidebar-accent`;
  - тултип (`ui/hover-card`): задача (первые 300 символов), сводка `summary` (текст
    отчёта агента; `result` — только `'done' | 'failed' | null`, текста в нём нет), слово
    итога `stateWord`, модель и `formatMetricsLine` (`lib/metrics-line.ts`) из
    `LiveMetrics`, ветка worktree;
  - `data-session-id` на строке: по нему кликают E2E `terminal.spec` и `cards.spec`;
  - перетаскивание — контракт 2.6 (`SessionRowProps` выше), под `DndContext`
    `AppShell`: тащатся только строки активной работы, у остальных `cursor-not-allowed`.
    На `[data-session-id]` и `data-draggable` опирается `AppShell.dnd.test.tsx`.
- **Клики** (спека 6.4): по карточке — `setActiveWork`; по строке сессии —
  `setActiveWork` и `apply(openTab(terminal))`, как входы сайдбара 2.5.
- **Активная карточка** (`active`): фон
  `color-mix(in srgb, var(--work-sidebar-foreground) 8%, transparent)` (в тёмной 10%),
  рамка, тень `0 1px 2px`. Hover — `--work-sidebar-accent` 40%.
- **Контраст вторичного текста.** Самый тёмный фон сайдбара теперь — активная карточка,
  а не `--work-sidebar-accent`, на котором построен тест 1.3. `--muted-foreground` на
  ней ниже 4.5:1 (светлая 4.44, тёмная 4.09), на amber-500/10 поверх неё — ещё ниже.
  Мета, слово состояния и время на активной карточке и на подсвеченных строках — цвет,
  который держит 4.5:1: `--work-sidebar-foreground` с прозрачностью или свой токен в
  `styles/tokens.css`.
- **Обновление времени.** Раз в 30 с перерисовка по `now`, без таймера на каждую
  карточку: `WorkSidebar` зовёт `useNow(30_000)` один раз и раздаёт `now` карточкам.

**Тесты**
1. `projectColor` детерминирован и даёт цвет из восьми. Распределение — инвариантом по
   диапазону: 800 путей `/p/<i>` дают каждый цвет от 60 до 140 раз.
2. `relativeTime`: 30 с → `now`, 3 мин → `3m`, 2 ч → `2h`, вчерашняя дата →
   `yesterday`, дата этого года → `Sep 26`, прошлого — `Sep 26, 2025`.
3. `WorkCard`:
   - полоса orange при `needs-you`;
   - жирный заголовок при `unseen`;
   - `✉2` при двух письмах; `#1`; у работы с комнатами без непрочитанного — `#` без
     числа;
   - 📌 при `pinned`;
   - мета — `3 sessions`;
   - `+2 closed` раскрывается кликом;
   - на корне `data-work-key`.
4. `SessionRow`: девять состояний из таблицы 4.2 дают свой значок и слово
   `stateWord`; `⎇` только с `worktree`; подсветка при `needs-you`; на строке
   `data-session-id`.
5. `WorkSidebar`:
   - `Pinned` наверху;
   - свёрнутый проект без карточек;
   - архивных нет;
   - при 60 работах в DOM больше нуля и меньше 60 карточек (виртуализация). У jsdom
     высота списка нулевая — размер задаёт `initialRect` виртуализатора, иначе карточек
     ноль и тест ничего не доказывает.
6. Пересортировка под указателем откладывается: `pointerenter`, событие `blocked`,
   порядок прежний; `pointerleave` — работа первая.
7. `WorkCard` со `status: 'done'` приглушена (`opacity-60`); название из 60 эмодзи в
   DOM целиком (`textContent` равен названию), у заголовка класс `truncate`.
8. «+ Работа» (`+ workspace`) и «+» заголовка проекта открывают `NewWorkDialog` через
   `openNewWorkDialog`.
9. `useSidebarSections` в двух компонентах под `AppShell` отдаёт один порядок: пока
   `sidebarHovering` истинно, оба держат прежний; при свёрнутом сайдбаре секции
   по-прежнему обновляются.
10. `useNow(30_000)`: новая дата раз в 30 с (поддельные таймеры); размонтирование
    снимает таймер.
11. `SessionRow`: `host.notice` вида `trust-wait` по её ref — ⚠ с тултипом
    `S.sidebar.trustWaitTooltip`; у строки другой сессии пометки нет.
12. `SessionRow`, контракт перетаскивания (сюда переезжает тест
    `SessionTree.test.tsx:213`): у строки неактивной работы нет `data-draggable` и курсор
    `not-allowed`, у активной — есть; HTML5-атрибута `draggable` нет ни у одной; у
    выбранной сессии — `data-selected`.
13. Тултип строки: задача, `summary`, слово итога `stateWord`, модель и строка
    `formatMetricsLine`.
14. `styles/tokens.test.ts` (`test-utils/contrast.ts`): вторичный текст на активной
    карточке, на amber-500/10 поверх неё и на выбранной строке — не ниже 4.5:1 в обеих
    темах.
15. `WorkSidebar` размонтирован под указателем (сайдбар закрыт ⌘B) — `sidebarHovering`
    ложно, следующая пересортировка не ждёт 3 с.
16. Верх сайдбара — `Search` с подписью ⌘K; тест `AppShell.test.tsx` «⌘J нигде нет»
    зелёный.
17. `useSidebarAttention` отдаёт внимание работ секций. `useSidebarSectionsSync()`
    возвращает секции своего рендера: в рендере, где пришёл первый снимок, в возврате
    уже его работы.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Решение по значкам агентов записано в спеке (раздел 18, вопрос 1).

---

## 3.4. Меню, переименование, клавиатура сайдбара

**Зачем.** Всё, что делается с работой, — из карточки, мышью и с клавиатуры.
**Зависит от:** 3.1, 3.3. **Спека:** 6.4, 6.5, 6.7 (`Reopen` у архивной).

**Файлы**
- Создать в `packages/desktop/src/renderer/sidebar/`:
  - `CardMenu.tsx`, `SessionRowMenu.tsx`, `RoomsMenu.tsx`, `SectionMenu.tsx`,
    `InlineRename.tsx` и тесты;
  - `use-sidebar-keys.ts` и тест.
- Создать: `renderer/components/rooms/CreateRoomDialog.test.tsx` — его пока нет.
- Изменить:
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` —
    `app.revealWork(projectPath, workId)`, канал `app:reveal-work`; опция
    `showItemInFolder` в `RegisterIpcOptions`, в `ipc.test.ts` — заглушка;
  - `src/main/index.ts` — `showItemInFolder: (path) => shell.showItemInFolder(path)`,
    рядом с `openExternal`;
  - `renderer/test-utils/fake-bridge.ts` — `revealWork` с журналом вызовов;
  - `renderer/layout/keys.ts` и тест — ⌘⇧↑ и ⌘⇧↓. До 6.1 это обработчик `keydown` в
    рендерере, а не акселератор меню: пункт меню отнимал бы у полей ввода выделение до
    начала и конца;
  - `renderer/layout/LayoutView.tsx` и тест — явная ветка `tab-step`: исход `work-step`
    не её;
  - `renderer/App.tsx` — `NewSessionDialog` берёт работу из `dialogs.newSession.work`,
    иначе активную;
  - `shell/AppShell.tsx` и `AppShell.test.tsx` — ⌘1–9 (меню `work-N`, его слушает
    `AppShell` с 2.3) и ⌘⇧↑↓ по видимому порядку вместо `orderedWorks`; входы
    `useLayoutPersistence` (ниже); кандидаты `CreateRoomDialog` при
    `requiredMember: null`. Тест 7 куска 2.7 («`work-2` — вторая по порядку создания»)
    переходит на видимый порядок;
  - `renderer/layout/persistence.ts` и тест — `order` и `visibleOrder` порознь; соседняя
    работа и при архиве активной;
  - `renderer/sidebar/WorkSidebar.tsx`, `WorkCard.tsx`, `SessionRow.tsx`,
    `ProjectGroup.tsx` и тесты — меню, `InlineRename`, `RoomsMenu` по `#`;
  - `renderer/components/rooms/CreateRoomDialog.tsx` — `requiredMember`
    необязателен;
  - `renderer/store/ui.ts` и тест — `dialogs.createRoom.requiredMember` может быть
    `null`; `dialogs.newSession.work`;
  - `shared/strings.ts` — пункты меню, подтверждения, действия ошибок (ниже).
- `SessionMenu.tsx` в 3.4 не удаляется: его импортирует `SessionTree.tsx` старого
  сайдбара, который живёт за `?sidebar=old` до 3.5. Оба уходят в 3.5.

**Интерфейсы**

```ts
// sidebar/CardMenu.tsx — пункты спеки 6.4
export type CardAction = 'pin' | 'unpin' | 'new-session' | 'new-room' | 'open-mail' | 'rename'
  | 'reveal' | 'copy-path' | 'finish' | 'reopen' | 'archive' | 'delete';
/** Действия без внешнего состояния меню делает само (сторы, мост); наружу — то, что у карточки. */
export interface CardMenuProps {
  entry: WorkEntry; pinned: boolean; bridge: HarnasBridge;
  onRename(): void;                        // InlineRename своей карточки
  onOpenMail(): void;                      // вкладка mail этой работы
  children: ReactNode;                     // карточка — триггер ui/context-menu
}
// sidebar/WorkCard.tsx, дополнение WorkCardProps
onOpenRoom(roomId: string): void;          // выбор в RoomsMenu — вкладка room
// sidebar/RoomsMenu.tsx — открывается по # или #N карточки
export interface RoomsMenuProps { map: WorkMap; onOpenRoom(roomId: string): void; children: ReactNode }

// sidebar/use-sidebar-keys.ts
export interface SidebarCursor { workKey: string; sessionId: string | null }
export function moveCursor(order: SidebarCursor[], current: SidebarCursor | null, key: 'ArrowUp' | 'ArrowDown'): SidebarCursor | null;

// layout/keys.ts — ещё один исход layoutKeyAction; разбирает его только AppShell
| { kind: 'work-step'; step: 1 | -1 }       // ⌘⇧↓ — 1, ⌘⇧↑ — −1

// layout/persistence.ts — вход useLayoutPersistence (было: order в порядке сайдбара)
order: string[];                // все работы снимка, с архивными и скрытыми; синхронно из works
visibleOrder: string[] | null;  // visibleWorkOrder(возврат useSidebarSectionsSync()); null — до uiLoaded

// store/ui.ts — диалог новой сессии знает свою работу
newSession: { open: boolean; parentSessionId: string | null;
  work: { projectPath: string; workId: string } | null };   // null — активная работа (⌘T)
openNewSessionDialog(parentSessionId: string | null, work?: { projectPath: string; workId: string }): void;

// components/rooms/CreateRoomDialog.tsx — было обязательным
requiredMember: { id: string; label: string } | null;   // null — из меню карточки

// shared/strings.ts, дополнения S (английский текст; русский в плане — смысл)
cardMenu: {
  pin: 'Pin', unpin: 'Unpin', newSession: 'New session', newRoom: 'New room',
  openMail: 'Open mail', rename: 'Rename', reveal: 'Reveal in Finder', copyPath: 'Copy path',
  markDone: 'Mark as done', reopen: 'Reopen', archive: 'Archive', deleteEllipsis: 'Delete…',
  archiveConfirmTitle: (title: string) => string,          // 'Archive "Redesign"?'
  deleteConfirmTitle: (title: string) => string,           // 'Delete "Redesign"?'
  deleteConfirmDescription: (sessions: number) => string,  // '3 sessions will be deleted. Running agents will be stopped.'
},
sidebar: {
  showDone: 'Show done', sectionMenu: 'Section options',
  sessionMenu: { openBeside: 'Open to the side', copyWorktreePath: 'Copy worktree path' },
},
rooms: { newRoomTitle: 'New room' },
errors: { actions: {
  renameWorkspace: 'rename workspace', markWorkspaceDone: 'mark workspace as done',
  reopenWorkspace: 'reopen workspace', archiveWorkspace: 'archive workspace',
  deleteWorkspace: 'delete workspace', revealWorkspace: 'reveal workspace in Finder',
} },
```

**Поведение**
- **Меню карточки** (`ui/context-menu`), тексты — `S.cardMenu`:

| Пункт | Действие |
|---|---|
| Закрепить / Открепить (`Pin` / `Unpin`) | `patchUi({ pinnedWorks })` |
| Новая сессия (`New session`) | `openNewSessionDialog(null, { projectPath, workId })` — диалог для этой работы, и у неактивной карточки |
| Новая комната (`New room`) | `openCreateRoomDialog({ projectPath, workId, requiredMember: null })` |
| Открыть почту (`Open mail`) | вкладка `mail` |
| Переименовать (`Rename`) | `InlineRename` |
| Показать в Finder (`Reveal in Finder`) | `app.revealWork(projectPath, workId)`: main проверяет по `works.list`, что такая работа есть, и зовёт `showItemInFolder(projectPath)`; нет — `not_found` |
| Скопировать путь (`Copy path`) | `navigator.clipboard.writeText(projectPath)` |
| Завершить (`Mark as done`); у `done` и `archived` — Вернуть в работу (`Reopen`) | `works.setStatus('done')`; у `done` и `archived` — `works.setStatus('active')` |
| Архивировать (`Archive`); у `archived` пункта нет | `ConfirmDialog` (`archiveConfirmTitle`) → `works.setStatus('archived')` |
| Удалить… (`Delete…`) | `ConfirmDialog` (`deleteConfirmTitle`, `deleteConfirmDescription`: число сессий и «живые процессы остановятся») → `sessions.stop` живых сессий → `works.delete` → ключ уходит из `pinnedWorks` |

  Пункты с неподдерживаемыми методами спрятаны (`useHostSupports`).
- **Архивная карточка** видна только при временном показе архивных (6.3, действие
  `works.showArchived`, спека 6.7). У неё вместо `Mark as done` и `Archive` — `Reopen`:
  иначе показанную работу нечем вернуть. В 3.4 архивных в сайдбаре нет, и пункт
  безвреден.
- **Ошибки хоста и main** на любом пункте — тост `errorText(decodeIpcError(err).code,
  S.errors.actions.<…>)`: `renameWorkspace`, `markWorkspaceDone`, `reopenWorkspace`,
  `archiveWorkspace`, `deleteWorkspace`, `revealWorkspace`. Например, `conflict` на
  удалении — `Couldn't delete workspace: conflicting state.` Русский текст хоста
  (`host/src/methods/works.ts:24`) — только в консоль: страж `english-ui` рантайм-строк
  не видит.
- **«Удалить…».** Хост отвечает `conflict`, пока у работы есть живая сессия. Поэтому
  после подтверждения окно зовёт `sessions.stop` каждой сессии с `lifecycle: 'active'`
  и только затем `works.delete`. Подтверждение — согласие человека на остановку
  (рамка 15.1). После успеха ключ работы уходит из `pinnedWorks` (`patchUi`): иначе
  удалённая работа осталась бы в `ui.json` навсегда.
- **Состав снимка и видимый порядок — разные входы `useLayoutPersistence`.**
  - `order` — все работы снимка, с архивными, свёрнутыми и скрытыми `done`; `AppShell`
    считает его синхронно из `entries`. По нему `retainLayouts` первого снимка, а `drop`
    и `removeLayout` — только у работы, которая была в прежнем снимке и пропала.
  - `visibleOrder` — `visibleWorkOrder` секций из возврата `useSidebarSectionsSync()`
    (не `useSidebarSections()`: тот отстаёт на рендер); `null`, пока зеркало `ui.json`
    не загружено (`uiLoaded`). Он нужен только для выбора соседа и выбора на старте.
  - Свернуть проект, скрыть `done`, закрепить или открепить — раскладок не трогают и
    активную работу не меняют. Иначе свёрнутый проект «удалял» бы свои работы: `drop`,
    `removeLayout` и смена активной.
- **Активная работа удалена или архивирована** — пропала из снимка или получила
  `status: 'archived'`. Активной становится соседняя по прежнему `visibleOrder` среди
  оставшихся (`survivingNeighbor`, 2.2), иначе первая в `visibleOrder`, иначе первая
  неархивная в `order`. Раскладка удалённой стирается, архивной — остаётся. Других
  поводов менять активную работу у `persistence` нет.
- **Старт.** `retainLayouts` — на первом снимке после `worksLoaded`. Активная
  выбирается, когда есть и снимок, и `visibleOrder`: `ui.activeWorkKey`, если работа есть
  в снимке и не архивная (в том числе из свёрнутого проекта), иначе первая в
  `visibleOrder`, иначе первая неархивная в `order`. То же правило — у пустого старта,
  когда пришли первые работы.
- **«Новая сессия»** из меню передаёт работу карточки в `dialogs.newSession.work`: после
  2.7 `App` берёт работу диалога из `activeWorkKey`, и пункт неактивной карточки открыл
  бы диалог чужой работы. ⌘T — `work: null`, активная работа.
- **«Новая комната»** открывает `CreateRoomDialog` без обязательного участника:
  заголовок «Новая комната» (`S.rooms.newRoomTitle` — `New room`), «Создать»
  (`S.common.create`) доступна от одного выбранного участника. Кандидаты — все
  незакрытые сессии работы: фильтр `AppShell` по `requiredMember.id` при `null` не
  применяется.
- **`SectionMenu`** — меню «⋯» заголовка секции (`aria-label` `S.sidebar.sectionMenu`):
  переключатель «Показывать завершённые» (`S.sidebar.showDone` — `Show done`) →
  `patchUi({ showDoneWorks })` (спека 6.1).
- **`InlineRename`:**
  - двойной клик по заголовку или пункт меню. Без `works.rename` у хоста спрятаны и
    пункт, и двойной клик;
  - поле на месте заголовка, выделено всё;
  - Enter или потеря фокуса с изменённым названием — `works.rename`; Esc или потеря
    фокуса без изменений — отмена;
  - ошибка — тост `errorText(…, S.errors.actions.renameWorkspace)` и возврат прежнего
    названия.
- **`RoomsMenu`.** Клик по `#N` или `#` — меню всех комнат работы со счётчиками
  `roomUnreadForHuman`. Выбор — `onOpenRoom(roomId)`, вкладка `room`.
- **`SessionRowMenu`** — пункты нынешнего `SessionMenu` (`S.sidebar.sessionMenu`) плюс
  «Скопировать путь worktree» (`copyWorktreePath` — `Copy worktree path`), если у сессии
  `worktree`. «Открыть рядом» (`openBeside` — `Open to the side`): сначала
  `setActiveWork` работы строки, затем
  `apply(key, l => splitGroup(l, l.activeGroupId, 'row', tab, sizes))`. Группа берётся
  внутри операции, поэтому та работает и из очереди до `hydrate`.
- **Наведение держат меню и переименование.** Уход указателя в портал меню (карточки,
  строки, секции, `RoomsMenu`) и время `InlineRename` — не уход с сайдбара: иначе
  пересортировка сдвинула бы карточку под меню, а виртуализация перемонтировала бы поле
  ввода. `WorkSidebar` ставит `sidebarHovering`, когда указатель над списком, или
  открыто меню, или идёт переименование.
- **Клавиатура сайдбара** — спека 6.5:
  - Tab в сайдбар ставит курсор на активную карточку;
  - ↑↓ ходят по карточкам и строкам сессий, Enter открывает;
  - → разворачивает закрытые, ← сворачивает;
  - Shift+F10 открывает меню элемента под курсором.
- **⌘1–9** — N-я работа видимого порядка, **⌘⇧↑↓** — соседняя в нём:
  - исход `work-step` разбирает один обработчик `keydown` на `window` в `AppShell`. У
    `LayoutView` (он смонтирован у трёх работ LRU) явная ветка `tab-step`, а `work-step`
    проходит мимо него без `preventDefault`. Сейчас всё, что не `mru` и не `tab-index`,
    `LayoutView` считает `tab-step`, и ⌘⇧↓ заодно листал бы вкладки активной группы;
  - в поле ввода (`input`, `textarea`, `[contenteditable]` вне `.xterm`) сочетание
    остаётся выделению до края (спека 9.6);
  - в терминале сочетание идёт окну: спека 9.6 отдаёт окну все ⌘-сочетания терминала,
    `shouldForwardToTerminal` их xterm не отдаёт. Фокус xterm —
    `textarea.xterm-helper-textarea`, поэтому `.xterm` проверяется раньше `textarea`;
  - активной работы нет в видимом порядке (её проект свёрнут, `done` скрыта) — ⌘⇧↓
    берёт первую видимую работу, ⌘⇧↑ — последнюю.

**Тесты**
1. «Закрепить» (`Pin`) зовёт `patchUi` с работой в `pinnedWorks`, «Открепить»
   (`Unpin`) — без неё.
2. «Удалить…» (`Delete…`): до подтверждения — ни одного вызова; после —
   `sessions.stop` каждой сессии с `lifecycle: 'active'`, затем `works.delete`, и ключа
   работы больше нет в `pinnedWorks`; `conflict` от хоста → тост
   `Couldn't delete workspace: conflicting state.`
3. `InlineRename`: Enter зовёт `works.rename` с новым названием; Esc — не зовёт; потеря
   фокуса с изменённым названием — зовёт, без изменений — нет; `bad_request` хоста
   возвращает прежнее название и показывает тост
   `Couldn't rename workspace: invalid request.`
4. `RoomsMenu` показывает все комнаты работы и счётчики. У работы с комнатами без
   непрочитанного `#` без числа открывает то же меню; выбор — вкладка `room`.
5. После `setHostMethods` без `works.rename` пункта `Rename` нет, и двойной клик по
   заголовку поле не открывает.
6. `moveCursor`: ↓ с последней строки остаётся на ней; ↑ с первой — на ней;
   переход между карточками идёт через строки сессий.
7. ⌘1 открывает первую работу видимого порядка, включая «Закреплённые»; меню `work-2` —
   вторую в видимом порядке, а не по созданию (тест 7 куска 2.7 в `AppShell.test.tsx`
   переписан).
8. `SectionMenu`: `Show done` зовёт `patchUi({ showDoneWorks: false })`, и работы
   `done` пропадают из секции.
9. Активная работа: снимок со `status: 'archived'` → активна соседняя по
   `visibleOrder`, `removeLayout` не зван; снимок без неё → соседняя и
   `removeLayout`.
10. «Новая комната» из меню карточки (`CreateRoomDialog.test.tsx`): заголовок
    `New room`, обязательного участника нет, кандидаты — все незакрытые сессии работы;
    `Create` неактивна, пока никто не выбран; `rooms.create` — с выбранными.
11. ⌘⇧↓ в поле ввода работу не меняет; в терминале (фокус в
    `textarea.xterm-helper-textarea`) и вне полей — соседняя по видимому порядку, а
    активная вкладка активной группы прежняя: `LayoutView` на `work-step` вкладки не
    листает и `preventDefault` не зовёт.
12. «Открыть рядом» (`Open to the side`) в `SessionRowMenu`: размеры групп подставлены
    (`measureGroupSizes()` в jsdom даёт нули, и сплит отказал бы `too-small`), у работы
    уже открыта вкладка — групп стало две, вкладка сессии в правой. Строка неактивной
    и ещё не гидрированной работы: работа становится активной, операция применяется из
    очереди после `hydrate`.
13. Свернуть проект активной работы (`collapsedProjects`) и скрыть её, если она `done`
    (`showDoneWorks: false`), — ни `drop`, ни `removeLayout`, активная прежняя.
14. Первый снимок: `retainLayouts` получает все работы, включая архивные; до `uiLoaded`
    активная не выбрана; после — активна работа из `ui.activeWorkKey`, хотя её проект
    свёрнут.
15. «Новая сессия» (`New session`) на неактивной карточке → `sessions.create` с её
    `projectPath` и `workId`; ⌘T после этого — снова диалог активной работы.
16. Ошибки пунктов по коду: `not_found` на «Архивировать» (`Archive`) → тост
    `Couldn't archive workspace: not found.`; `revealWork` с `not_found` →
    `Couldn't reveal workspace in Finder: not found.`
17. `ipc`: `app:reveal-work` существующей работы зовёт `showItemInFolder(projectPath)`,
    чужой — отказ `not_found` без вызова.
18. Меню карточки открыто, указатель ушёл со списка — событие `blocked` порядок не
    меняет; меню закрыто — новый порядок. Во время `InlineRename` — так же.
19. У работы `done` вместо `Mark as done` пункт `Reopen` → `works.setStatus('active')`.
20. Проект активной работы свёрнут: ⌘⇧↓ делает активной первую видимую работу, ⌘⇧↑ —
    последнюю.
21. У работы `archived` в меню карточки — `Reopen` → `works.setStatus('active')`, пунктов
    `Mark as done` и `Archive` нет.

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
  - `renderer/store/ui.ts` и тест — `dialogs.newWork` с проектом,
    `openNewWorkDialog(projectPath?)`; `store/ui.test.ts` сверял `dialogs.newWork` как
    `boolean`;
  - `renderer/sidebar/ProjectGroup.tsx` и тест — «+» передаёт свой `projectPath`: в 3.3
    он зовёт `openNewWorkDialog()` без аргументов;
  - `shell/AppShell.tsx` — монтирует `NewWorkComposer` вместо `NewWorkDialog`; меню
    `new-work` (⌘N, 2.3), «+ Работа» (`+ workspace`) и «+» заголовка проекта открывают
    его; ветки `?sidebar=old` больше нет;
  - `src/main/index.ts` — без `HARNAS_DESKTOP_SIDEBAR` и флага `sidebar=old`;
  - `renderer/lib/dot-state.ts` и тест — без `maxDotState`: его звал только
    `WorkList.tsx`;
  - `shared/strings.ts` — строки формы в `S.dialogs.newWork`; без `S.sidebar.heading` и
    `S.sidebar.empty`, их читал только `Sidebar.tsx`;
  - комментарии, которые называют удалённые файлы: `renderer/App.tsx` (пометка
    trust-wait — в `SessionRow`, 3.3), `renderer/lib/commands.ts`,
    `renderer/styles/tokens.test.ts`, `shared/strings.ts`.
- Удалить:
  - `renderer/components/dialogs/NewWorkDialog.tsx`;
  - `renderer/components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx`,
    `SessionMenu.tsx` (из 3.4 — вместе с его потребителем), `StatusDot.tsx`,
    `MetricsLine.tsx`;
  - их тесты и флаг `?sidebar=old`.
- `lib/metrics-line.ts` с тестом остаётся: его берёт тултип `SessionRow` (3.3).
- Создать: `packages/desktop/e2e/cards.spec.ts`.
- Документы: `README.md`, раздел «Окно» — сайдбар, карточки, «Закреплённые», форма.

**Интерфейсы**

```ts
export interface NewWorkDraft {
  projectPath: string | null; title: string; goal: string;
  startSession: boolean; provider: string | null; label: string; task: string;
  worktree: boolean; createMore: boolean;
}
/** Пределы спеки 6.6: название 1–120, цель до 4000, ярлык до 40, задача до 20000 — по кодовым точкам. Тексты — S.dialogs.newWork. */
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

// shared/strings.ts — S.dialogs.newWork (группа прежнего NewWorkDialog) дополняется для формы
projectField: 'Project', startSession: 'Start a session', agentField: 'Agent', createMore: 'Create more',
titleLength: 'Title: 1–120 characters', goalTooLong: 'Goal: up to 4,000 characters',
labelTooLong: 'Label: up to 40 characters', taskTooLong: 'Task: up to 20,000 characters',
agentRequired: 'Select an agent',
// уже есть: title 'New workspace', chooseFolderPlaceholder 'Choose a folder…', titleField 'Title',
// goalField 'Goal', selectFolderRequired 'Select a project folder'. Поля сессии — из
// S.dialogs.newSession (labelField, taskField, inOwnWorktree), кнопки — S.common.create и S.common.retry.
```

**Поведение** — спека 6.6:
- **Проекты** — из `projectPath` всех работ плюс «Выбрать папку…»
  (`S.dialogs.newWork.chooseFolderPlaceholder` — `Choose a folder…`, `app.chooseFolder`).
  От «+» заголовка проекта проект уже выбран: `ProjectGroup` зовёт
  `openNewWorkDialog(projectPath)`.
- **Агенты** — `providers.list`, только `available`. По умолчанию —
  `ui.lastProvider ?? 'claude'`, если он среди доступных, иначе первый доступный. То же
  правило — в `NewSessionDialog`.
- **Ярлык.** Пустой — окно подставляет `label` выбранного провайдера из
  `providers.list`: по спеке 6.6 пустой ярлык — имя агента, а хост пишет пустой ярлык как
  есть.
- **Поле «Свой worktree»** (`S.dialogs.newSession.inOwnWorktree`) видно после
  `worktrees.available { projectPath }` → `available: true`.
- **Отправка:** ⌘Enter или «Создать» (`S.common.create`).
  - `works.create`, при `startSession` — затем `sessions.create`.
  - Ошибка второго вызова — работа уже создана, в форме ошибка сессии
    `errorText(decodeIpcError(err).code, S.errors.actions.createSession)` и «Повторить»
    (`S.common.retry` — `Retry`): повторяется только `sessions.create`. Ошибка
    `works.create` — `errorText(…, S.errors.actions.createWorkspace)`.
  - Успех → `setActiveWork` и `apply(openTab(terminal))` новой сессии, когда снимок
    работ (`works.changed`) принёс новую работу и её сессию. `sessions.create` отвечает
    раньше снимка, и вкладка, открытая сразу, мигнула бы телом «Session deleted»
    (`MissingBody`). Работа ещё не гидрирована — операция ждёт `hydrate` в очереди (2.2).
    Затем `patchUi({ lastProvider })`.
  - «Создать ещё» (`S.dialogs.newWork.createMore` — `Create more`) — форма очищает
    название, цель и задачу и остаётся открытой.

**Тесты**
1. `validateDraft`:
   - без проекта — ошибка `Select a project folder`;
   - пустое название — `Title: 1–120 characters`;
   - 121 символ — та же ошибка, 120 эмодзи — без ошибки;
   - цель 4001 символ — `Goal: up to 4,000 characters`; ярлык 41 —
     `Label: up to 40 characters`; задача 20001 — `Task: up to 20,000 characters`;
   - при `startSession` без агента — `Select an agent`.
2. Успех: `works.create`, затем `sessions.create` с `worktree` из формы. До
   `works.changed` с новой сессией вкладки нет и `Session deleted` не мелькает; после —
   работа активна, вкладка открыта.
3. `sessions.create` падает: работа не пересоздаётся, в форме — текст `errorText` по коду
   (`Couldn't create session: …`), `Retry` зовёт только `sessions.create`.
4. «Создать ещё» (`Create more`): после успеха форма открыта, название пустое, проект и
   агент сохранены.
5. **E2E `cards.spec.ts`:**
   - порядок карточек читается по `data-work-key` (3.3);
   - две работы в одном проекте, по сессии в каждой; указатель вне сайдбара, иначе
     пересортировка отложена;
   - порядок до событий: вторая работа создана позже и при равном ранге выше;
   - тест дописывает `{"hook_event_name":"UserPromptSubmit"}` в журнал сессии первой
     работы (`<project>/.harnas/works/<workId>/events/<sessionId>.jsonl`) — за 2 с первая
     выше второй: `working` против `idle`. Так проверена сортировка по вниманию, а не
     по времени создания;
   - затем строку `{"hook_event_name":"Notification","notification_type":"permission_prompt"}`
     в журнал второй — за 2 с вторая снова первая, у её строки сессии значок вопроса.
6. **E2E:** форма новой работы с включённым «Создать ещё» (`Create more`) создаёт две
   работы подряд. Проект — через «+» заголовка проекта, где уже есть работа (создана
   `works.create` до открытия формы): нативный диалог `app.chooseFolder`
   (`dialog.showOpenDialog`) E2E не выберет.
7. «+» заголовка проекта открывает форму с этим проектом; меню `new-work` (⌘N) — без
   проекта.
8. Агент по умолчанию: `ui.lastProvider`; без него — `claude`; `claude` недоступен —
   первый доступный. Так же в `NewSessionDialog`.
9. Пустой ярлык → `sessions.create` с `label` выбранного провайдера; непустой — как
   введён.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.
- [ ] `grep -rn "components/sidebar\|SessionTree\|WorkList\|maxDotState\|sidebar=old\|HARNAS_DESKTOP_SIDEBAR"
      packages/desktop/src packages/desktop/e2e` пуст, включая комментарии.

**Приёмка этапа 3** (человек, на пересобранном `harnas.app`)
- [ ] Три работы в двух проектах: сессия, ждущая разрешения, поднимает свою работу
      первой.
- [ ] Окно перезапущено при живом хосте, где сессия ждёт разрешения: её значок и её
      работа первой видны сразу, без нового события.
- [ ] Свёрнутый проект активной работы не сбрасывает её раскладку; после перезапуска
      окна активна прежняя работа.
- [ ] Закрепление, переименование на месте, архив и удаление работают из меню.
- [ ] ⌘1–9 и ⌘⇧↑↓ ходят в видимом порядке.
- [ ] `README.md` обновлён.
