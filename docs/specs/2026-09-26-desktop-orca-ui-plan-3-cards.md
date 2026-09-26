# План, этап 3: карточки

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 6, 7.1, строка 3 таблицы 14.3.

**Итог этапа:**
- сайдбар из групп проектов и «Закреплённых» с карточками работ;
- работа, где нужен ты, стоит первой;
- меню карточки, переименование на месте, клавиатура;
- форма новой работы как у Orca.

**Перед стартом.** Сверить с кодом этапа 2:
- `layout/store.ts` (`setActiveWork`, `apply`, `openTab`);
- `layout/dnd.ts` (перетаскивание строк сессий);
- `shared/ui-types.ts` (`pinnedWorks`, `collapsedProjects`, `showDoneWorks`,
  `lastProvider`);
- `lib/mail-view.ts#recipientsOf`, `lib/tree-order.ts`, `lib/dot-state.ts`.

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
  - `packages/core/src/work/store.ts` и тест — `renameWork`, `setWorkStatus`;
  - `packages/core/src/index.ts` — экспорт;
  - `packages/protocol/src/methods.ts` и тест — схемы и результаты новых методов,
    `methods?: string[]` в результате `hello`;
  - `packages/host/src/methods/works.ts` и `works.test.ts` — `worksRename`,
    `worksSetStatus`;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/host/src/server.ts` и `server.test.ts` — `hello` отдаёт `methods`;
  - `packages/desktop/src/main/host-connection.ts` и тест — `methods` в статусе;
  - `packages/desktop/src/shared/bridge.ts` — `HostStatus.connected.methods`;
  - `packages/desktop/src/renderer/shell/StatusBar.tsx` — сегмент «Хост старее окна».
- Создать: `packages/desktop/src/renderer/lib/capabilities.ts` и тест.

**Интерфейсы**

```ts
// core/work/store.ts — через updateMap, work.updatedAt = now
export async function renameWork(projectPath: string, workId: string, title: string): Promise<WorkMap>;
export async function setWorkStatus(projectPath: string, workId: string, status: WorkStatus): Promise<WorkMap>;

// protocol/methods.ts
'works.rename':    z.object({ projectPath: z.string(), workId: z.string(), title: z.string().trim().min(1).max(120) }),
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
export function useHostSupports(method: string): boolean;
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
  «название работы: 1–120 символов». Хост отдаёт её как `bad_request`.
- **`setWorkStatus`** меняет `work.status`. Работа уходит в `archived` и с живыми
  сессиями — архив их не трогает, так же как сейчас не трогает TUI.
- **Хост в ответе `hello`** отдаёт `methods` — отсортированные ключи
  `methodHandlers` и `notificationHandlers`.
- **`HostConnection`** кладёт `methods` из ответа `hello` в статус `connected`. Поля нет
  — `null`.
- **Строка статуса.** Если `missingMethods(status)` не пуст — сегмент «Хост старее окна
  — перезапустить». Клик открывает `ConfirmDialog`: «Перезапуск оборвёт живых агентов,
  они поднимутся через --resume» → `app.restartHost()`.
- **Функции** с неподдерживаемым методом прячутся через `useHostSupports`: пункты меню
  карточки «Переименовать», «Завершить», «Архивировать».

**Тесты**
1. `renameWork`: `'  Новая  '` → `'Новая'`; `''` и 121 символ — ошибка; `updatedAt`
   вырос.
2. `setWorkStatus('archived')` пишет статус; неверный статус схема протокола отвергает
   до хоста.
3. Хост: `works.rename` с пустым названием → `bad_request`; успешный вызов меняет
   карту на диске.
4. `server.test`: ответ `hello` содержит `works.rename`, `pty.input`, `hello`;
   список отсортирован.
5. `HostConnection`: ответ `hello` без `methods` → `methods: null`; с `methods` —
   массив.
6. `capabilities`: `hostMethods` при `null` — ровно `BASELINE_METHODS`;
   `missingMethods` при `null` — `['works.rename', 'works.setStatus']`.

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
/** Видимый порядок работ — для ⌘1–9 и ⌘⇧↑↓ (3.4). */
export function visibleWorkOrder(sections: SidebarSection[]): string[];

// sidebar/use-deferred-order.ts
/** Пока указатель над списком, отдаёт прежний порядок; новый — после ухода указателя или через maxDeferMs. */
export function useDeferredOrder<T>(order: T[], hovering: boolean, maxDeferMs?: number): T[];  // 3000
```

**Поведение**
- **`sessionAttention`** — таблица спеки 7.1.
- **`workAttention.level`** — наивысший ранг сессий. `humanUnread > 0` поднимает его до
  `needs-you`. Комнаты уровень не поднимают.
- **`compareWorks`:** ранг по убыванию, потом `lastEventAt` по убыванию, потом
  `createdAt` по возрастанию.
- **`buildSections`:**
  - «Закреплённые» — первыми, если в них есть хоть одна работа; закреплённая работа в
    группе проекта не повторяется;
  - группы проектов упорядочены по лучшей работе внутри (`compareWorks`), при
    равенстве — по имени папки;
  - `archived` скрыты всегда;
  - `done` — после остальных в своей группе, при `showDone: false` скрыты;
  - `collapsed` — по `collapsedProjects`.

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
   Работа только с непрочитанной комнатой → уровень по сессиям.
5. `compareWorks`: ранг важнее времени; при равном ранге свежее выше; при равном
   времени старшая по созданию выше.
6. `buildSections`:
   - закреплённая работа не дублируется в проекте;
   - `archived` нет;
   - `done` в конце, при `showDone: false` отсутствует;
   - порядок групп проектов — по лучшей работе.
7. `useDeferredOrder`: при `hovering` порядок держится; уход указателя отдаёт новый;
   через 3000 мс (поддельные таймеры) новый отдаётся и под указателем.

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
  - `lib/project-color.ts` и тест;
  - `lib/relative-time.ts` и тест.
- Изменить:
  - `shell/AppShell.tsx` — `WorkSidebar` вместо `Sidebar`; старый живёт до 3.5 за
    флагом `?sidebar=old` для сравнения;
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

// sidebar/WorkCard.tsx
export interface WorkCardProps {
  entry: WorkEntry; attention: WorkAttention; activity: Record<string, ActivityEntry>;
  active: boolean; pinned: boolean; branch: string | null;
  onActivate(): void; onOpenSession(sessionId: string): void;
  onOpenRooms(): void; onOpenMail(): void;
}
```

**Поведение**
- **Сайдбар** — спека 6.1:
  - верх: «Поиск ⌘J» и «+ Работа ⌘N»;
  - список секций из `buildSections`, порядок через `useDeferredOrder`, флаг
    `hovering` — `pointerenter` и `pointerleave` списка;
  - больше 50 карточек — виртуализация `@tanstack/react-virtual`, оценка высоты
    карточки — 44px плюс 24px на строку сессии.
- **Заголовок проекта** 28px:
  - чип `projectColor`, имя папки, число работ, «+» — форма новой работы с этим
    проектом (из 3.5, до неё — прежний диалог);
  - клик сворачивает и разворачивает (`saveUi({ collapsedProjects })`);
  - тултип — полный путь.
- **Карточка** — спека 6.3:
  - полоса по `attention.level` (orange, yellow, emerald, нет);
  - заголовок 13/20, `font-semibold` при `unseen > 0` или `humanUnread > 0`;
  - `✉N`, `#N` (число комнат с непрочитанным), 📌, `relativeTime(lastEventAt)`;
  - мета 11px: имя папки · `N сессий` · ветка проекта из `WorksSnapshot.branches` моно;
  - строки сессий по `treeOrder`, отступ 12px на уровень;
  - закрытые спрятаны: «ещё N закрытых» разворачивает до конца сеанса окна
    (состояние в памяти).
- **Строка сессии** 24px:
  - `AgentStateDot`, `AgentIcon`, `S02 исполнитель` (`sessionRowLabel`), слово
    состояния muted 11px;
  - `⎇` при `session.worktree`, время `relativeTime`;
  - подсветка amber-500/10 при `needs-you` и `unseen`;
  - тултип (`ui/hover-card`): задача (первые 300 символов), первая строка `result`,
    иначе `summary`, модель и токены из `LiveMetrics`, ветка worktree;
  - перетаскивание — из 2.6.
- **Активная карточка** (`active`): фон
  `color-mix(in srgb, var(--work-sidebar-foreground) 8%, transparent)` (в тёмной 10%),
  рамка, тень `0 1px 2px`. Hover — `--work-sidebar-accent` 40%.
- **Обновление времени.** Раз в 30 с перерисовка по `now`, без таймера на каждую
  карточку: один общий `useNow(30_000)`.

**Тесты**
1. `projectColor` детерминирован и даёт цвет из восьми. Разные пути дают разные цвета
   хотя бы в 6 случаях из 8 заданных (распределение).
2. `relativeTime`: 30 с → `сейчас`, 3 мин → `3м`, 2 ч → `2ч`, вчерашняя дата →
   `вчера`, дата этого года → `26 сент`, прошлого — `26.09.2025`.
3. `WorkCard`:
   - полоса orange при `needs-you`;
   - жирный заголовок при `unseen`;
   - `✉2` при двух письмах; `#1`;
   - 📌 при `pinned`;
   - `ещё 2 закрытых` раскрывается кликом.
4. `SessionRow`: девять состояний из таблицы 4.2 дают свой значок; `⎇` только с
   `worktree`; подсветка при `needs-you`.
5. `WorkSidebar`:
   - «Закреплённые» наверху;
   - свёрнутый проект без карточек;
   - архивных нет;
   - при 60 работах в DOM меньше 60 карточек (виртуализация).
6. Пересортировка под указателем откладывается: `pointerenter`, событие `blocked`,
   порядок прежний; `pointerleave` — работа первая.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Решение по значкам агентов записано в спеке (раздел 18, вопрос 1).

---

## 3.4. Меню, переименование, клавиатура сайдбара

**Зачем.** Всё, что делается с работой, — из карточки, мышью и с клавиатуры.
**Зависит от:** 3.1, 3.3. **Спека:** 6.4, 6.5.

**Файлы**
- Создать в `packages/desktop/src/renderer/sidebar/`:
  - `CardMenu.tsx`, `SessionRowMenu.tsx`, `RoomsMenu.tsx`, `InlineRename.tsx` и
    тесты;
  - `use-sidebar-keys.ts` и тест.
- Изменить:
  - `src/main/menu.ts`, `src/shared/bridge.ts` — `MenuAction` `'work-prev'` и
    `'work-next'` (⌘⇧↑, ⌘⇧↓) в меню «Работа»;
  - `src/shared/bridge.ts`, `src/preload/index.ts`, `src/main/ipc.ts` —
    `app.revealWork(projectPath, workId)`, канал `app:reveal-work`;
  - `renderer/App.tsx` — ⌘1–9 и ⌘⇧↑↓ по `visibleWorkOrder`, вместо `orderedWorks`.
- Удалить: `renderer/components/sidebar/SessionMenu.tsx` — заменён `SessionRowMenu`.

**Интерфейсы**

```ts
// sidebar/CardMenu.tsx — пункты спеки 6.4
export type CardAction = 'pin' | 'unpin' | 'new-session' | 'new-room' | 'open-mail' | 'rename'
  | 'reveal' | 'copy-path' | 'finish' | 'archive' | 'delete';
// sidebar/use-sidebar-keys.ts
export interface SidebarCursor { workKey: string; sessionId: string | null }
export function moveCursor(order: SidebarCursor[], current: SidebarCursor | null, key: 'ArrowUp' | 'ArrowDown'): SidebarCursor | null;
```

**Поведение**
- **Меню карточки** (`ui/context-menu`):

| Пункт | Действие |
|---|---|
| Закрепить / Открепить | `saveUi({ pinnedWorks })` |
| Новая сессия | диалог новой сессии для этой работы |
| Новая комната | `CreateRoomDialog` |
| Открыть почту | вкладка `mail` |
| Переименовать | `InlineRename` |
| Показать в Finder | `app.revealWork(projectPath, workId)`: main проверяет по `works.list`, что такая работа есть, и зовёт `shell.showItemInFolder(projectPath)` |
| Скопировать путь | `navigator.clipboard.writeText(projectPath)` |
| Завершить | `works.setStatus('done')` |
| Архивировать | `ConfirmDialog` → `works.setStatus('archived')` |
| Удалить… | `ConfirmDialog` с числом сессий и предупреждением «живые процессы остановятся» → `works.delete` |

  Пункты с неподдерживаемыми методами спрятаны (`useHostSupports`).
- **`InlineRename`:**
  - двойной клик по заголовку или пункт меню;
  - поле на месте заголовка, выделено всё;
  - Enter — `works.rename`, Esc или потеря фокуса без изменений — отмена;
  - ошибка — тост и возврат прежнего названия.
- **`RoomsMenu`.** Клик по `#N` — меню всех комнат работы со счётчиками
  `roomUnreadForHuman`. Выбор — вкладка `room`.
- **`SessionRowMenu`** — пункты нынешнего `SessionMenu` плюс «Скопировать путь
  worktree», если у сессии `worktree`.
- **Клавиатура сайдбара** — спека 6.5:
  - Tab в сайдбар ставит курсор на активную карточку;
  - ↑↓ ходят по карточкам и строкам сессий, Enter открывает;
  - → разворачивает закрытые, ← сворачивает;
  - Shift+F10 открывает меню элемента под курсором.
- **⌘1–9** — N-я работа `visibleWorkOrder`, **⌘⇧↑↓** — соседняя.

**Тесты**
1. «Закрепить» зовёт `saveUi` с работой в `pinnedWorks`, «Открепить» — без неё.
2. «Удалить…»: `works.delete` зовётся только после подтверждения.
3. `InlineRename`: Enter зовёт `works.rename` с новым названием; Esc — не зовёт;
   ошибка хоста возвращает прежнее название и показывает тост.
4. `RoomsMenu` показывает все комнаты работы и счётчики.
5. Без `works.rename` в `methods` хоста пункта «Переименовать» нет.
6. `moveCursor`: ↓ с последней строки остаётся на ней; ↑ с первой — на ней;
   переход между карточками идёт через строки сессий.
7. ⌘1 открывает первую работу видимого порядка, включая «Закреплённые».

**Приёмка**
- [ ] Все тесты зелёные.

---

## 3.5. Форма новой работы; приёмка этапа 3

**Зачем.** Новая работа с первой сессией — одним действием, как у Orca.
**Зависит от:** 3.4. **Спека:** 6.6.

**Файлы**
- Создать: `packages/desktop/src/renderer/sidebar/NewWorkComposer.tsx` и тест.
- Изменить:
  - `renderer/components/dialogs/NewSessionDialog.tsx` — агент по умолчанию
    `ui.json.lastProvider`, запись `lastProvider` при создании;
  - `renderer/App.tsx`, `shell/AppShell.tsx` — ⌘N и «+» открывают `NewWorkComposer`.
- Удалить:
  - `renderer/components/dialogs/NewWorkDialog.tsx`;
  - `renderer/components/sidebar/Sidebar.tsx`, `WorkList.tsx`, `SessionTree.tsx`,
    `StatusDot.tsx`, `MetricsLine.tsx`;
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
export function validateDraft(draft: NewWorkDraft): Partial<Record<keyof NewWorkDraft, string>>;
```

**Поведение** — спека 6.6:
- **Проекты** — из `projectPath` всех работ плюс «Выбрать папку…» (`app.chooseFolder`).
- **Агенты** — `providers.list`, только `available`.
- **Поле «Свой worktree»** видно после `worktrees.available { projectPath }` →
  `available: true`.
- **Отправка:** ⌘Enter или «Создать».
  - `works.create`, при `startSession` — затем `sessions.create`.
  - Ошибка второго вызова — работа уже создана, в форме ошибка сессии и «Повторить»:
    повторяется только `sessions.create`.
  - Успех → `setActiveWork` и `openTab(terminal)` новой сессии; `saveUi({ lastProvider })`.
  - «Создать ещё» — форма очищает название, цель и задачу и остаётся открытой.

**Тесты**
1. `validateDraft`:
   - без проекта — ошибка «Выберите проект»;
   - пустое название — «Название: 1–120 символов»;
   - 121 символ — та же ошибка;
   - при `startSession` без агента — «Выберите агента».
2. Успех: `works.create`, затем `sessions.create` с `worktree` из формы; работа
   активна, вкладка открыта.
3. `sessions.create` падает: работа не пересоздаётся, «Повторить» зовёт только
   `sessions.create`.
4. «Создать ещё»: после успеха форма открыта, название пустое, проект и агент
   сохранены.
5. **E2E `cards.spec.ts`:**
   - две работы в одном проекте, по сессии в каждой;
   - тест дописывает строку `{"hook_event_name":"Notification","notification_type":"permission_prompt"}`
     в `<project>/.harnas/works/<workId>/events/<sessionId>.jsonl` второй работы;
   - за 3 с карточка второй работы первая в группе, у её строки сессии значок вопроса.
6. **E2E:** форма новой работы с включённым «Создать ещё» создаёт две работы подряд.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 3** (человек, на пересобранном `harnas.app`)
- [ ] Три работы в двух проектах: сессия, ждущая разрешения, поднимает свою работу
      первой.
- [ ] Закрепление, переименование на месте, архив и удаление работают из меню.
- [ ] ⌘1–9 и ⌘⇧↑↓ ходят в видимом порядке.
- [ ] `README.md` обновлён.
