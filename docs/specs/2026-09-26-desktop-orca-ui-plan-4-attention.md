# План, этап 4: внимание

Дата: 2026-09-27. Индекс и общие правила — `2026-09-26-desktop-orca-ui-plan.md`. Спека —
`2026-09-26-desktop-orca-ui-design.md`, разделы 3.2, 7, строка 4 таблицы 14.3.

**Итог этапа:**
- «не просмотрено» гаснет, только когда человек действительно видит терминал;
- письма человеку отмечаются прочитанными;
- отметки на вкладках, карточках и в строке статуса;
- бейдж Dock;
- уведомление macOS ведёт прямо во вкладку и не приходит, когда человек и так
  смотрит.

**Перед стартом.** Сверить с кодом этапов 2–3:
- `attention/derive.ts` (`WorkAttention`, `sessionAttention`, `humanUnreadLetters`,
  `roomUnreadForHuman`);
- `sidebar/use-sidebar-sections.ts` (3.3): `useSidebarSections`, `useSidebarAttention`,
  `useSidebarSectionsSync`. Счётчики и бейдж 4.2 берут внимание отсюда, своего расчёта у
  них нет;
- `store/ui.ts`: зеркало `ui.notifications`, `windowFocused`, `visibleSessionRefs` и
  `setSessionVisible` — их пишет `terminal/TerminalSurface.tsx` с 2.5;
- `store/activity.ts` (`useActivityStore`): повтор активности после подключения доходит
  до стора с раундом исправлений 3.1;
- `store/host.ts` (`useHostStore`) и `lib/capabilities.ts` (`REQUIRED_METHODS`,
  `hostMethods`, `useHostSupports`) — из 3.1;
- `layout/store.ts` (очередь до `hydrate`, `selectedSessionOf`), `layout/persistence.ts`
  (гидрация асинхронная), `terminal/TerminalSurface.tsx` (`terminalSurfaces`,
  `TerminalSurfaceHandle`), `shell/AppShell.tsx` (LRU из трёх работ, `inert` скрытых
  контейнеров);
- `layout/TabStrip.tsx` (считает `tabMeta` и отдаёт `Tab` пропом) и `layout/Tab.tsx`;
- `layout/GroupView.tsx` (`LayoutBodyContext.active` — работа активна),
  `layout/bodies/MailBody.tsx`, `layout/bodies/RoomBody.tsx`;
- `renderer/notifications.ts` (что заменяется), trust-wait в `renderer/App.tsx` и его
  тесты `App.test.tsx:94–175` (E.1: «не русский `notice.text`»),
  `lib/participant.ts#noticeTitle`;
- `shared/strings.ts` (`S.notifications`, `S.statusBar`, `noticeText`).

**Строки интерфейса** — правило индекса («Сквозные ограничения», кусок E.1):
- русские строки интерфейса в «…» ниже — смысл, а не текст. Текст — английский, ключом
  `S` в `packages/desktop/src/shared/strings.ts`: ключ и английский стоят рядом или в
  «Интерфейсах» куска. Кусок, который добавляет строки, вносит `shared/strings.ts` в
  «Изменить»;
- тесты ждут английский текст;
- название работы, ярлык сессии, задача, `summary` и текст письма — данные человека и
  агентов, а не строки интерфейса: в уведомление они идут как есть;
- `HostNotice.text` хост пишет по-русски, и окно его не показывает нигде. Смысл вида —
  `noticeText(notice)` (E.1), сам текст — только в консоль.

---

## 4.1. core и хост: `activity.seen`, `mail.markRead`

**Зачем.** «Просмотрено» и «прочитано» ставит окно по видимости, а не побочным
эффектом подключения.
**Зависит от:** 3.1. **Спека:** 3.2, 7.2.

**Файлы**
- Изменить:
  - `packages/core/src/work/letters.ts` и тест — `markHumanRead`;
  - `packages/core/src/index.ts` — экспорт;
  - `packages/protocol/src/methods.ts` и тест — уведомление `activity.seen`, метод
    `mail.markRead`;
  - `packages/host/src/methods/pty.ts` и `pty.test.ts` — `pty.attach` без
    `markSeen`, обработчик `activity.seen`, `works` в `PtyMethodDeps`. Тесты зовут
    фабрику с подставным `works`. Тест «`pty.attach` … помечает активность увиденной»
    (`pty.test.ts:124`) утверждает обратное новому поведению — его заменяет тест 2;
  - `packages/host/src/methods/works.ts` — `requireWork` и `notFoundOnGone`
    экспортируются: их зовёт `mail.ts`;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` +
    `activity.seen`, `mail.markRead`.
- Создать: `packages/host/src/methods/mail.ts` и `mail.test.ts`.

**Интерфейсы**

```ts
// core/work/letters.ts — через updateMap(…, { touch: false }) из 3.1
/**
 * Ставит readBy.human = now письмам, которые человек видит: прямым письмам человеку
 * и сообщениям комнат, не от самого человека. Уже прочитанные и чужие id пропускаются.
 * Возвращает, сколько отметок поставлено. work.updatedAt не сдвигается.
 * Подходящих id нет — 0 без updateMap: карта, индекс и .bak не переписываются.
 * Карты нет — WorkNotFoundError, как у updateMap.
 */
export async function markHumanRead(projectPath: string, workId: string, messageIds: string[]): Promise<number>;

// protocol/methods.ts
NOTIFICATIONS['activity.seen'] = z.object({ ref: sessionRef });
METHODS['mail.markRead'] = z.object({ projectPath: z.string(), workId: z.string(), messageIds: z.array(z.string()).min(1).max(500) });
Results['mail.markRead'] = { marked: number };

// host/methods/pty.ts
export interface PtyMethodDeps {
  pty: PtyManager;
  activity: ActivityService;
  works: WorksService;   // activity.seen: есть ли сессия в снимке работ хоста
}

// host/methods/works.ts — в 3.1 были приватными
/** Работы нет или карта битая — HostError('not_found'), а не internal. */
export async function requireWork(projectPath: string, workId: string): Promise<void>;
/** WorkNotFoundError core (работу удалили, пока запись ждала map.lock) → HostError('not_found'); прочее — как есть. */
export function notFoundOnGone(error: unknown): never;
```

**Поведение**
- **`pty.attach`** отдаёт снимок и подписывает клиента, «просмотрено» не трогает.
  `pty.input` по-прежнему зовёт `markSeen`.
- **`activity.seen { ref }`** зовёт `activity.markSeen(ref)`, только если сессия есть в
  снимке работ хоста: `works.entry(projectPath, workId)` и сессия в её карте.
  Уведомление приходит от клиента, и хост не пишет состояние по ref, которого не знает.
  Мусор не копится и без проверки: `recompute` такой ref пропускает, а `seenAt` чистит
  `pruneRemoved` на каждом снимке (`activity-service.ts:387`). Неизвестная сессия —
  тихо игнорируется: уведомление, ответа нет.
- **Между 4.1 и 4.2** «не просмотрено» гаснет только вводом в терминал: `pty.attach`
  его больше не гасит, а окно ещё не шлёт `activity.seen`. Временная регрессия, её
  снимает 4.2.
- **`mail.markRead`:**
  - пустой результат — не ошибка: `{ marked: 0 }`;
  - работы нет — `not_found`, как у `works.rename` в 3.1: обработчик сперва зовёт
    `requireWork`, а `WorkNotFoundError` из `markHumanRead` (работу удалили, пока запись
    ждала `map.lock`) переводит `notFoundOnGone`;
  - запись карты — одна, `updateMap` на все id сразу;
  - подходящих id нет — записи нет вовсе: `markHumanRead` сперва читает карту и без
    подходящих id `updateMap` не зовёт. `updateMap` пишет индекс, `.bak` и карту всегда,
    и повтор с `marked: 0` разослал бы `works.changed` всем клиентам.
- **`markHumanRead`** не трогает письма, адресованные только агентам (`roomId ===
  null` и `to` без `human`), и письма от `human`.
- **`work.updatedAt` не сдвигается** (`touch: false`): прочтение — не событие работы,
  карточка не всплывает в начало своего ранга (спека 6.2).

**Тесты**
1. `markHumanRead` — по таблице случаев «непрочитано человеком». Та же таблица,
   дословно, у теста 7 куска 4.2: рантайм core окну недоступен, общего модуля нет.
   - письмо S01 человеку → 1, `readBy.human` — ISO-время;
   - повтор → 0, `map.json` не переписан (mtime прежний);
   - письмо S01 человеку и S02, прочитанное S02, но не человеком → 1;
   - письмо S01 агенту S02 → 0;
   - сообщение комнаты от S02 → 1; сообщение комнаты от человека → 0;
   - письмо человека агенту S01 → 0;
   - неизвестный id → 0;
   - `work.updatedAt` после отметок прежний — `mail.markRead` не меняет порядок
     сайдбара.
2. Хост: `pty.attach` сессии в `unseen` оставляет `unseen` — подставная активность без
   вызова `markSeen`. Заменяет тест `pty.test.ts:124`.
3. Хост: `activity.seen` зовёт `markSeen` ровно этой сессии; неизвестная (подставной
   `works.entry` её не знает) — без исключения и без вызова `markSeen`, хост живёт (тот
   же приём, что в тесте `94c5f8c`).
4. Хост: `mail.markRead` для несуществующей работы → `not_found`, а не `internal`; работа
   удалена во время записи (`markHumanRead` бросил `WorkNotFoundError`) — тоже
   `not_found`; 501 id — `bad_request` на схеме.

**Приёмка**
- [ ] Все тесты зелёные во всех пакетах.

---

## 4.2. Видимость, отметки, счётчики, бейдж

**Зачем.** Человек видит, где нужен, а отметки гаснут, когда он посмотрел.
**Зависит от:** 4.1. **Спека:** 7.2, 7.3, 7.6.

**Файлы**
- Создать в `packages/desktop/src/renderer/attention/`:
  - `seen.ts` и тест;
  - `store.ts` и тест — итоги поверх `useSidebarAttention()`, без своего расчёта;
  - `use-mark-read.ts` и тест;
  - `next.ts` и тест.
- Создать: `packages/desktop/src/renderer/layout/use-tab-meta-extras.ts` — один хук
  собирает `extras` из хранилищ; 7.3 и 9.2 дописывают в него свои поля.
- Изменить в `packages/desktop/src/renderer/`:
  - `attention/derive.ts` и тест — `isHumanUnread`; `humanUnreadLetters` и
    `roomUnreadForHuman` (3.2) выражаются через неё;
  - `layout/tab-meta.ts` и тест — вход `extras`: `unread` и `needsYou` из внимания;
  - `layout/TabStrip.tsx` и тест — `extras` из `useTabMetaExtras()` один раз на строку и
    `tabMeta(tab, entry, extras)`: `tabMeta` зовётся здесь (`TabStrip.tsx:161`), а `Tab`
    получает `meta` пропом;
  - `layout/Tab.tsx` и тест — `data-unread`, значок вопроса по `meta.needsYou`;
  - `layout/GroupView.tsx`, `layout/bodies/MailBody.tsx`, `layout/bodies/RoomBody.tsx` —
    `active` из `LayoutBodyContext` и `bridge` идут до панелей;
  - `components/mail/MailPanel.tsx` и тест, `components/rooms/RoomPanel.tsx` — пропы
    `active` и `bridge` (у `RoomPanel` он уже есть), `useMarkRead` на письмах;
  - `store/ui.ts` и тест — `documentVisible`;
  - `shell/StatusBar.tsx` и тест — сегмент 3: «N ждут тебя · M не просмотрено», клик — к
    следующей;
  - `shell/AppShell.tsx` — отдаёт `StatusBar` итоги и `openNextAttention`: строка
    статуса работает на пропах;
  - `App.tsx` и `App.test.tsx` — бейдж через `app.setBadge` из `attention/store.ts` и
    трекер «просмотрено», оба в эффекте `App`;
  - `notifications.ts` и тест — `createNotificationWatcher` больше не ставит бейдж: его
    `setBadge` уходит (сам файл удаляет 4.3).
- Изменить: `packages/desktop/src/shared/strings.ts` — `S.statusBar.attention`.
- `sidebar/WorkCard.tsx` и `sidebar/SessionRow.tsx` 4.2 не трогает: все отметки таблицы
  7.3 на карточке и строке рисует 3.3 по `useSidebarAttention()`.

**Интерфейсы**

```ts
// attention/derive.ts, дополнение
/** Не прочитано человеком по правилам 3.2: письмо ему или сообщение комнаты, не от него, без readBy.human. */
export function isHumanUnread(message: Message): boolean;
// humanUnreadLetters(map) — прямые письма (roomId === null) с isHumanUnread;
// roomUnreadForHuman(map, roomId) — сообщения комнаты с isHumanUnread

// layout/tab-meta.ts — tabMeta остаётся чистой; данные хранилищ приходят одним входом.
// Сигнатура с 4.2 не меняется: 7.3 и 9.2 наполняют свои поля, а не добавляют параметры.
export interface TabMetaExtras {
  attention: Record<string /* refKey */, Attention>;   // 4.2
  dirtyTabIds: ReadonlySet<string>;                     // 7.3: вкладки file с несохранённым буфером; до него пусто
  browser: Record<string /* tabId */, { title: string | null; favicon: string | null }>;  // 9.2; до него пусто
}
export const EMPTY_EXTRAS: TabMetaExtras;
export interface TabMeta { /* поля 2.4 */ needsYou: boolean }   // значок вопроса вместо точки; важнее точки
export function tabMeta(tab: TabSpec, entry: WorkEntry | null, extras?: TabMetaExtras): TabMeta;  // без extras — EMPTY_EXTRAS

// layout/use-tab-meta-extras.ts
/** attention — sessionAttention (3.2) каждой сессии снимка по её активности. Зовёт TabStrip, один раз на строку. */
export function useTabMetaExtras(): TabMetaExtras;

// store/ui.ts, дополнение
documentVisible: boolean;   // visibilitychange; начальное — document.visibilityState === 'visible'
// windowFocused — как было: флаг по событиям focus/blur окна, начальное — document.hasFocus()

// attention/seen.ts
export interface VisibilityInput {
  windowFocused: boolean;
  documentVisible: boolean;
  /** store/ui.ts, пишет TerminalSurface (2.5): поверхность видима — работа активна, вкладка активна в группе. */
  visibleSessionRefs: Readonly<Record<string /* refKey */, true>>;
}
/** refKey сессий, чей терминал человек видит: поверхность видима при фокусе окна и видимом документе. */
export function visibleSessions(input: VisibilityInput): ReadonlySet<string>;
export interface SeenTracker {
  update(visible: ReadonlySet<string> /* refKey */, unseen: ReadonlyMap<string /* refKey */, SessionRef>): void;
  dispose(): void;
}
/** 1 с непрерывной видимости сессии в unseen → send(ref); не чаще раза в 2 с на сессию. */
export function createSeenTracker(deps: {
  send(ref: SessionRef): void;
  now(): number; setTimer: typeof setTimeout; clearTimer: typeof clearTimeout;
}): SeenTracker;

// attention/store.ts — поверх useSidebarAttention() (3.3): второго расчёта внимания нет
export interface AttentionTotals { needsYou: number; unseen: number; humanUnread: number }
/** Суммы по работам секций сайдбара: свёрнутые проекты входят, архивные и скрытые done — нет. */
export function attentionTotals(byWork: Record<string, WorkAttention>): AttentionTotals;
export function useAttentionTotals(): AttentionTotals;          // attentionTotals(useSidebarAttention())
export function badgeCount(totals: AttentionTotals): number;   // needsYou + humanUnread

// attention/use-mark-read.ts
/**
 * Ref-колбэк для элемента письма: непрочитанное, видимое ≥1 с при active, фокусе окна и видимом
 * документе, уходит в mail.markRead пачкой через 500 мс тишины, до 500 id за вызов. `unread` —
 * isHumanUnread(message), а не LetterView.unread: тот значит «хоть один адресат не прочёл».
 * Колбэк стабилен для одного messageId: перерисовка панели отсчёт не сбрасывает.
 */
export function useMarkRead(input: {
  bridge: HarnasBridge; projectPath: string; workId: string;
  /** Работа активна — LayoutBodyContext.active. Фокус окна и видимость документа хук берёт из store/ui.ts. */
  active: boolean;
}): (messageId: string, unread: boolean) => (el: HTMLElement | null) => void;

// components/mail/MailPanel.tsx, дополнение MailPanelProps; у RoomPanelProps — только active
bridge: HarnasBridge;
active: boolean;          // GroupView → MailBody/RoomBody → панель

// attention/next.ts
/**
 * Следующая после current по кругу сессия уровня needs-you, затем unseen, в порядке сайдбара — sections
 * из useSidebarSections() (3.3). Работы свёрнутых проектов входят, как в счётчиках (attention/store.ts).
 */
export function nextAttentionTarget(
  sections: SidebarSection[], byWork: Record<string, WorkAttention>,
  activity: Record<string, ActivityEntry>, current: SessionRef | null,
): SessionRef | null;
/**
 * «Следующая, где нужен ты» (спека 7.6): current — selectedSessionOf(…)?.ref, затем setActiveWork и
 * apply(openTab(terminal)); null — идти некуда. Зовут строка статуса и действие attention.next (6.3,
 * ActionContext.attention.next).
 */
export function openNextAttention(): SessionRef | null;

// shell/StatusBar.tsx, дополнение StatusBarProps
attention: { needsYou: number; unseen: number };   // AppShell: useAttentionTotals()
onNextAttention: () => void;                        // AppShell: openNextAttention

// shared/strings.ts, дополнение S.statusBar (английский текст; русский в плане — смысл)
/** «N ждут тебя · M не просмотрено»: нулевая часть не пишется, обе нулевые — ''. */
attention: (needsYou: number, unseen: number) => string,   // '2 need you · 1 unseen', '1 needs you', '3 unseen'
```

**Поведение**
- **Видимость.**
  - `windowFocused` — флаг `store/ui.ts` по событиям `focus` и `blur` окна, начальное
    значение — `document.hasFocus()`. Трекер читает флаг, а не `document.hasFocus()` в
    момент проверки. `documentVisible` — `visibilitychange`, его заводит
    `store/ui.ts#init`.
  - Терминал виден, если видима его поверхность — `visibleSessionRefs` (работа активна
    и вкладка активна в своей группе) — при фокусе окна и видимом документе. Источник
    видимости терминалов один: `seen.ts` раскладку заново не разбирает.
  - Трекер пересчитывается на каждое изменение `visibleSessionRefs`, фокуса, видимости
    документа или активности.
  - Трекер живёт в эффекте `App` рядом с бейджем. `activity.seen` шлётся через
    `bridge.notify`, только если хост его знает: перед каждой отправкой —
    `hostMethods(useHostStore.getState().status).has('activity.seen')`. Значение
    `useHostSupports`, взятое при монтировании, после перезапуска хоста устарело бы.
- **Письма.**
  - `IntersectionObserver` с порогом 0.5 на элементах непрочитанных писем.
  - Письмо, видимое непрерывно 1 с при активной работе (`active`), фокусе окна и видимом
    документе, попадает в пачку. Тело вкладки смонтировано только у активной вкладки
    группы, но так у всех трёх работ LRU: скрытые контейнеры лежат поверх активного с
    `visibility: hidden` и `inert`, а `IntersectionObserver` CSS-видимость не учитывает.
    Без `active` письма скрытой работы ушли бы в `mail.markRead`, хотя человек их не
    видел.
  - `active` — `LayoutBodyContext.active`: `GroupView` отдаёт его `MailBody` и
    `RoomBody`, те — панелям вместе с `bridge`.
  - Колбэк стабилен на `messageId`. `MailBody` подписан на всю активность (`byRef`) и
    перерисовывается на каждое `activity.changed`: новый колбэк на каждый рендер
    перевешивал бы наблюдатель, и при работающих агентах 1 с не набиралась бы.
  - Пачка уходит в `mail.markRead` через 500 мс тишины; больше 500 id — несколькими
    вызовами по 500.
  - `mail.markRead` шлётся, только если хост его знает — та же проверка `hostMethods(…)`
    в момент отправки: старый хост ответил бы `unknown_method`.
  - Повторно одно письмо не отправляется, пока снимок работ его не обновит. Ошибка
    вызова — id возвращаются в очередь и уходят следующей пачкой: письмо не застревает
    до перемонтирования панели.
- **Отметки** — таблица спеки 7.3:
  - вкладка: `data-unread` при `needs-you` или `unseen`; подложка amber-500/10 — у
    неактивной вкладки, как с 2.4 (`Tab.tsx:131`); значок вопроса вместо точки при
    `needs-you`;
  - `needsYou` важнее точки. `AgentStateDot` для `blocked` и так рисует вопрос
    (`MessageCircleQuestion`), но при `result !== null` точка показала бы `done` или
    `failed` (`lib/dot-state.ts#displayStatus`). Вкладка при `meta.needsYou` рисует
    вопрос всегда;
  - карточка и строка сессии — уже в 3.3 по `useSidebarAttention()`: полоса, жирный
    заголовок, подложка строки. 4.2 их не трогает.
- **Счётчики** — внимание из `useSidebarAttention()` (3.3), второго расчёта нет. Домен —
  работы секций сайдбара: свёрнутые проекты входят, архивные и скрытые `done` — нет
  (спека 7.3). Тот же домен обходит `nextAttentionTarget`: иначе «2 ждут тебя» показывало
  бы сессию, до которой клик не дойдёт.
- **Строка статуса.** «2 ждут тебя · 1 не просмотрено» (`S.statusBar.attention` —
  `2 need you · 1 unseen`). Нули не показываются, при двух нулях сегмента нет.
  - «N ждут тебя» — сессии (`totals.needsYou`). Письма в счёт не входят: они в бейдже
    и на карточках, а клик ведёт только к сессиям.
  - `StatusBar` работает на пропах: итоги и `onNextAttention` отдаёт `AppShell`.
  - Клик — `openNextAttention()`: `current` — `selectedSessionOf(…)?.ref`, цель —
    `nextAttentionTarget` по секциям `useSidebarSections()`, затем `setActiveWork` и
    `apply(openTab(terminal))`. Ту же функцию зовёт действие палитры `attention.next`
    (6.3).
- **Бейдж** — `badgeCount`, ноль — пустой. Шлётся из эффекта `App`, только когда число
  сменилось. Прежний `createNotificationWatcher` бейдж больше не ставит, иначе два
  источника спорили бы.

**Тесты**
1. `visibleSessions`:
   - окно не в фокусе → пусто;
   - `documentVisible: false` → пусто;
   - сессии нет в `visibleSessionRefs` → её нет;
   - фокус и видимый документ → ровно ключи `visibleSessionRefs`.

   Правило «работа активна, вкладка активна в группе» держит тест 17
   `SurfaceLayer.test.tsx` (2.5).
2. `createSeenTracker` (поддельные таймеры):
   - видимость 999 мс — `send` нет;
   - 1000 мс — один `send`;
   - потеря видимости на 500 мс сбрасывает отсчёт;
   - повторное попадание в `unseen` через 1 с — ещё один `send` не раньше 2 с от
     прошлого;
   - сессия не в `unseen` — `send` нет.
3. `useMarkRead`: два письма видимы 1 с → один вызов `mail.markRead` с двумя id; окно
   без фокуса — вызова нет.
4. `badgeCount({ needsYou: 2, unseen: 5, humanUnread: 1 })` → 3.
5. `nextAttentionTarget`: сначала `needs-you` по порядку сайдбара, по кругу после
   `current`; нет `needs-you` — первая `unseen`; нет обеих — `null`. Сессия работы
   свёрнутого проекта находится, скрытой `done` — нет.
6. Вкладка терминала сессии в `needs-you`: `data-unread="true"` и значок вопроса — в том
   числе у сессии с `result: 'done'`, где точка показала бы `done`.
7. `isHumanUnread` — таблица случаев теста 1 куска 4.1, дословно; `humanUnreadLetters` и
   `roomUnreadForHuman` на ней совпадают с тестами 2 и 3 куска 3.2. `useMarkRead`:
   письмо человеку, прочитанное другим адресатом, но не человеком, уходит в пачку;
   прочитанное человеком — нет.
8. `createNotificationWatcher` больше не зовёт `setBadge`; бейдж шлёт `App` —
   `badgeCount` при каждом его изменении и только тогда (`bridge.badges`).
9. Строка статуса при `needsYou: 2, unseen: 1, humanUnread: 3` — `2 need you · 1 unseen`;
   при `needsYou: 1, unseen: 0` — `1 needs you`; при `needsYou: 0, unseen: 0` сегмента
   нет. Клик по сегменту зовёт `onNextAttention` один раз.
10. `tabMeta` вкладки терминала: в `extras.attention` сессия `needs-you` → `unread` и
    `needsYou` истинны; `unseen` → `unread` истинно, `needsYou` ложно; без `extras` оба
    ложны, как в этапе 2.
11. `useMarkRead`: вкладка почты активна в скрытой работе LRU (`active: false`) при
    фокусе окна — письма 1 с видимы для `IntersectionObserver`, `mail.markRead` не
    зовётся.
12. `useMarkRead` (поддельные таймеры):
    - перерисовка панели каждые 300 мс не мешает отметке через 1 с;
    - 501 непрочитанное письмо → два вызова, 500 и 1 id;
    - ошибка вызова → те же id уходят следующей пачкой;
    - хост без `mail.markRead` (`setHostMethods` без него) — вызова нет.
13. Трекер в `App`: хост без `activity.seen` (`setHostMethods` без него) —
    `bridge.notify` не зовётся; после `setHostMethods(REQUIRED_METHODS)` та же сессия в
    `unseen` уходит: метод проверяется в момент отправки.
14. `attentionTotals` считает работы из `useSidebarAttention()`: работа свёрнутого
    проекта входит, архивная и скрытая `done` — нет.
15. `openNextAttention`: выбрана первая сессия `needs-you` — переход ко второй: её работа
    активна, вкладка открыта; работа не гидрирована — вкладка открывается из очереди
    после `hydrate`. Идти некуда — `null`, активная работа прежняя.
16. `store/ui.ts`: начальное `documentVisible` — по `document.visibilityState`;
    `visibilitychange` в `hidden` → `false`, обратно → `true`; `blur` окна →
    `windowFocused: false` без обращения к `document.hasFocus()`.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 4.3. Уведомления с переходом; приёмка этапа 4

**Зачем.** Уведомление приводит прямо к агенту и не мешает, когда человек уже смотрит.
**Зависит от:** 4.2. **Спека:** 3.3, 7.4, 7.5, 13, 15.2.

**Файлы**
- Создать:
  - `packages/desktop/src/main/notifications.ts` и тест;
  - в `packages/desktop/src/renderer/attention/`: `notify.ts`, `flash.ts`,
    `focus-target.ts` и тесты;
  - `packages/desktop/e2e/attention.spec.ts`.
- Изменить:
  - `src/shared/bridge.ts` — `app.notify(note: AppNote)`, `app.onFocusTarget`, типы
    `AppNote` и `FocusTarget` (спека 3.3);
  - `src/shared/strings.ts` — новый `S.notifications` и `S.settings.notificationsHint`
    (ниже). `trustWaitTitle`, `alertSuffixBlocked` и `alertSuffixUnseen` удаляются: их
    читали только `App.tsx` и `notifications.ts`;
  - `src/preload/index.ts`, `src/main/ipc.ts` и `ipc.test.ts` — проверка `AppNote` и
    обрезка до 200 кодовых точек, событие `app:focus-target`, канал
    `app:take-focus-target`;
  - `src/main/index.ts` — уведомитель, `app.on('activate')` не мешает переходу; клик
    при закрытом окне создаёт его заново; признаки «окна нет» (`isDestroyed()`) и «окно
    загружено» (`did-finish-load`);
  - `renderer/test-utils/fake-bridge.ts` — `appNotified` с `AppNote`, `onFocusTarget`,
    эмиттер `emitFocusTarget` и сеттер отложенной цели `setPendingFocusTarget`;
  - `renderer/App.tsx` — `wireAttentionNotifications` вместо `wireNotifications` и
    trust-wait-обработчика `host.notice`, обработчик `onFocusTarget`;
  - `renderer/App.test.tsx` — тесты trust-wait E.1 (`:94–175`) переезжают в
    `attention/notify.test.ts` (тест 11); в `App.test.tsx` остаётся сквозная регрессия
    «русский `notice.text` до уведомления не доходит»;
  - `renderer/layout/Tab.tsx` — `data-work-key` на вкладке: вспышку адресует пара
    работа + вкладка;
  - `renderer/lib/participant.ts` и тест — без `noticeTitle`: его звал только
    `notifications.ts`;
  - `renderer/terminal/TerminalSurface.tsx` — комментарий к `setSessionVisible` называет
    читателя `attention/seen.ts` (`visibleSessions`) вместо `App.tsx#wireNotifications`;
  - `renderer/components/settings/SettingsDialog.tsx` и `SettingsDialog.test.tsx` —
    подсказка про системные настройки в секции «Уведомления»; сами переключатели пишут
    `patchUi` с 2.3.
- Удалить: `renderer/notifications.ts` и его тест.
- Документы: `README.md`, раздел «Окно» — внимание и уведомления.

**Интерфейсы**

```ts
// main/notifications.ts
export interface NotificationLike {
  show(): void; close(): void;
  on(event: 'click' | 'close', cb: () => void): void;
}
export function createNotifier(deps: {
  create(options: { title: string; body: string; silent: boolean }): NotificationLike;
  /** restore → show → focus; окна нет (null или isDestroyed: macOS держит приложение без окон) — создать заново. */
  focusWindow(): void;
  /** Окну после did-finish-load — событием app:focus-target; иначе — в отложенные (createPendingFocusTarget). */
  sendFocusTarget(target: FocusTarget): void;
}): { notify(note: AppNote): void };
/** Цель клика для окна, которое ещё грузится. Новая заменяет прежнюю; take отдаёт её один раз. */
export function createPendingFocusTarget(): { put(target: FocusTarget): void; take(): FocusTarget | null };

// main/ipc.ts, RegisterIpcOptions
showNotification: (note: AppNote) => void;       // было { title, body }; форму проверил и обрезал ipc.ts
takeFocusTarget: () => FocusTarget | null;       // app:take-focus-target

// bridge.ts, дополнение к app
notify(note: AppNote): void;
/** При подписке отдаёт слушателю отложенную цель: сначала ту, что держит прелоад, иначе из app:take-focus-target. */
onFocusTarget(listener: (target: FocusTarget) => void): () => void;

// test-utils/fake-bridge.ts, дополнение к FakeBridge
readonly appNotified: AppNote[];
emitFocusTarget(target: FocusTarget): void;
/** Отложенная цель main: первый подписчик onFocusTarget получает её сразу, как через app:take-focus-target. */
setPendingFocusTarget(target: FocusTarget | null): void;

// renderer/attention/notify.ts — замена notifications.ts
export interface NotifyDeps {
  notify(note: AppNote): void;
  prefs(): UiFile['notifications'];
  isTargetVisible(target: FocusTarget): boolean;
  /** Снимок работ окна: название работы, сессия (ярлык, задача, summary), письма. */
  entries(): readonly WorkEntry[];
}
export function createAttentionNotifier(deps: NotifyDeps): {
  /** Переход — по sessionAttention (3.2); первое значение сессии — база без уведомления. */
  onActivity(ref: SessionRef, activity: SessionActivity): void;
  /** Новые прямые письма человеку (isHumanUnread); первый снимок — база. */
  onWorks(entries: readonly WorkEntry[]): void;
  /** trust-wait, launch-failed, resume-failed; ref: null или сессии нет в снимке — без уведомления. */
  onHostNotice(notice: HostNotice): void;
};
/**
 * Подписки App: useActivityStore (живые события и повтор после подключения), useWorksStore (первый снимок —
 * ответ works.list), host.notice моста. Каждый вызов — новый уведомитель с пустыми базами: App зовёт его
 * на каждый переход в connected. Возвращает отписку.
 */
export function wireAttentionNotifications(bridge: HarnasBridge, deps: Omit<NotifyDeps, 'notify'>): () => void;

// renderer/attention/flash.ts
/** data-flash на [role="tab"][data-work-key][data-tab-id] на durationMs; кольцо 2px --ring рисует CSS. */
export function flashTab(workKey: string, tabId: string, durationMs?: number): void;   // 600

// renderer/attention/focus-target.ts
export interface FocusTargetDeps {
  works: readonly WorkEntry[];
  setActiveWork(workKey: string): void;
  openTab(workKey: string, tab: TabSpec): void;      // apply(workKey, l => openTab(l, tab)); до hydrate — очередь (2.2)
  /**
   * true, когда вкладка — активная в своей группе отрисованной раскладки активной работы, а у терминала
   * поверхность видима (visibleSessionRefs: inert уже снят) и есть в terminalSurfaces. Подписка на сторы,
   * не дольше 2 с; не дождалась — false.
   */
  whenShown(workKey: string, tab: TabSpec): Promise<boolean>;
  surface(ref: SessionRef): TerminalSurfaceHandle | undefined;   // terminalSurfaces.get(refKey(ref))
  flash(workKey: string, tabId: string): void;
}
/** Сразу — setActiveWork и openTab; после whenShown — flash, у терминала scrollToBottom и focus. false — цели больше нет. */
export function applyFocusTarget(target: FocusTarget, deps: FocusTargetDeps): boolean;

// shared/strings.ts — S.notifications вместо trustWaitTitle и alertSuffix* (английский текст; русский в плане — смысл)
notifications: {
  /** «<работа> · <ярлык> — <событие>»: название работы и ярлык — данные, как есть. */
  sessionTitle: (workspace: string, session: string, event: string) => string,
                                                 // 'Redesign · S02 executor — needs you'
  needsYou: 'needs you',                         // «ждёт тебя»
  finished: 'finished',                          // «закончил ход»
  trustWait: 'waiting for folder trust',         // «ждёт доверия к папке»
  launchFailed: "couldn't launch",               // «не запустилась»
  resumeFailed: "couldn't resume",               // «не возобновилась»
  /** «<работа> · письмо | вопрос | решение от S01» по Message.kind. */
  mailTitle: (workspace: string, kind: 'note' | 'question' | 'decision', from: string) => string,
                                                 // 'Redesign · message from S01', 'Redesign · question from S01'
  targetGone: 'Workspace or session no longer exists',   // тост «Работа или сессия уже удалены»
},
settings: {
  notificationsHint: 'Not getting notifications? System Settings → Notifications → Harnas',
                                                 // «Не приходят — Системные настройки → Уведомления → Harnas»
},
```

**Поведение**
- **Один поток перехода** (спека 3.3): клик по уведомлению приходит событием
  `app:focus-target` (`onFocusTarget`), отдельного `onNotificationClick` нет. Меню Dock
  в MVP нет — спека 17.
- **Когда шлём** — таблица спеки 7.4: переход сессии в `needs-you` или `unseen`, новое
  прямое письмо человеку, уведомления хоста `trust-wait`, `launch-failed`,
  `resume-failed`.
  - Переход считается по `sessionAttention(session, activity)` (3.2), а не по сырому
    `activity`: у `closed` и `sleeping` `needs-you` не бывает. Сессии нет в снимке окна —
    уровень по `activity`, как у живой сессии, а уведомления нет: заголовок не из чего
    собрать.
  - Первое значение активности сессии после (пере)подписки — база без уведомления, как
    первый снимок у `onWorks`. Хост после `hello` повторяет новому клиенту активность
    всех сессий (3.1), а `App` пересоздаёт подписки на каждый переход в `connected`. Без
    базы запуск окна, «Restart host» и обрыв связи давали бы по уведомлению на каждую
    невидимую `blocked` и `unseen` сессию.
  - Активность уведомитель берёт из `useActivityStore`, а не прямо из
    `activity.changed`: повтор после подключения попадает в стор, даже когда пришёл
    раньше подписки рендерера (раунд исправлений 3.1). Слушай уведомитель одни события —
    повтор прошёл бы мимо, и базой стал бы первый настоящий переход.
  - Повтор того же состояния не уведомляет.
  - Ключ в `prefs()` выключен — не шлём. `prefs()` — `ui.notifications` зеркала
    `store/ui.ts` (2.3).
  - `isTargetVisible` — видимость по правилам 4.2: для сессии — `visibleSessions`, для
    почты и комнаты — их вкладка активна в своей группе активной работы при фокусе окна
    и видимом документе.
  - `onWorks` берёт первый снимок за базу: письма, которые уже были на старте, не
    уведомляют. Уведомляет только письмо, которого не было в прошлом снимке.
  - Уведомление хоста с `ref: null` или по сессии, которой нет в снимке окна, не
    показывается: вести некуда, заголовок не из чего собрать.
- **Текст** окно собирает из `S.notifications`. Название работы, ярлык
  (`sessionRowLabel`), первая строка задачи, `summary` или письма — данные, идут как есть:
  - заголовок `<работа> · S02 исполнитель — ждёт тебя` или `— закончил ход`
    (`sessionTitle` с `needsYou` или `finished`);
  - для письма — `<работа> · письмо от S01`, `вопрос от S01` или `решение от S01`
    (`mailTitle`; S01 — `sessionTag` отправителя);
  - уведомления хоста — `<работа> · S02 исполнитель — ждёт доверия к папке`
    (`trust-wait`), `— не запустилась` (`launch-failed`), `— не возобновилась`
    (`resume-failed`): `sessionTitle` с `trustWait`, `launchFailed`, `resumeFailed`. У
    прежнего заголовка trust-wait в `App.tsx` (`trustWaitTitle`) не было ни работы, ни
    ярлыка;
  - тело — первая строка задачи (`needs-you`), итога (`summary`: в `result` только
    `done` или `failed`, текста там нет) или письма. У уведомлений хоста тело —
    `noticeText(notice)` без ярлыка: ярлык уже в заголовке. `notice.text` — только в
    консоль;
  - заголовок и тело — не длиннее 200 кодовых точек (спека 15.2). Длиннее — первые 199
    и «…», итог ровно 200; суррогатная пара не рвётся, счёт как у `truncateTitle`
    (`layout/tab-meta.ts`).
- **Теги:** `session:<refKey>`, `mail:<workKey>`, `notice:<kind>:<refKey>`. Main
  держит `Map<tag, Notification>` и закрывает прежнее уведомление с тем же тегом перед
  показом нового. Запись уходит из `Map` на `click` и на `close`. Ссылка в `Map` нужна и
  сама по себе: сейчас `new Notification(note).show()` её не держит
  (`main/index.ts:137`), и объект может уйти в сборку мусора вместе с обработчиком
  `click`.
- **Проверка в main.** `app:notify` принимает только `AppNote`: строки `title`, `body`,
  `tag`; `target` — один из трёх видов `FocusTarget` со строковыми полями; `silent` —
  булево. Неверная форма — отказ без показа. `title` и `body` main режет до 200 кодовых
  точек так же, как окно.
- **Клик:**
  1. Main: `restore()`, если свёрнуто, `show()`, `focus()`. Окна нет — `mainWindow`
     пуст или `isDestroyed()` (после закрытия ссылка не обнуляется,
     `main/index.ts:28–34`), macOS держит приложение и без окон: main создаёт окно
     заново.
  2. Main отдаёт цель окну, у которого уже был `did-finish-load`, событием
     `app:focus-target`; иначе кладёт её в отложенные (`createPendingFocusTarget`). До
     `did-finish-load` прелоад не слушает, и событие потерялось бы — и у окна, созданного
     кликом, и у окна, которое `app.on('activate')` создало за миг до клика.
  3. Рендерер: `applyFocusTarget`:
     - сразу — активная работа (`setActiveWork`) и вкладка (`openTab`); работа ещё не
       показывалась — `openTab` ждёт её `hydrate` в очереди (2.2);
     - когда вкладка показана (`whenShown`) — вспышка 600 мс (кольцо 2px `--ring`) по
       паре `workKey` + `tabId`, у терминала — прокрутка вниз и фокус ввода
       (`TerminalSurfaceHandle.focus()`). Раньше звать их бесполезно: уведомление почти
       всегда про фоновую работу, её раскладка может быть не гидрирована, работы может
       не быть в LRU (поверхностей нет), а до коммита React контейнер ещё `inert`;
     - `whenShown` не дождался за 2 с — вкладка открыта, без вспышки и фокуса;
     - `flashTab` ищет `[role="tab"][data-work-key][data-tab-id]`: id `mail` и
       `terminal:s-01` одинаковы во всех работах, а `data-tab-id` носит и поверхность
       терминала.
  - **Цель до первого снимка работ** — из `app:take-focus-target` или любая другая, пока
    `useWorksStore.loading` истинно, — ждёт первого ответа `works.list` и применяется
    после; тоста нет. Иначе главный путь «клик при закрытом окне» кончался бы тостом
    «уже удалены»: подписки `App` заводятся в `connected`, а `works.list` в этот момент
    ещё в пути.
  - **Цели нет** (работу или сессию удалили) — окно на переднем плане и тост «Работа
    или сессия уже удалены» (`S.notifications.targetGone`): это ответ на действие
    человека (спека 7.5, 13).
  - **Прелоад.** Цель, пришедшая событием, пока у `onFocusTarget` нет слушателей, не
    теряется: прелоад держит последнюю и отдаёт её первому подписчику, а если её нет —
    спрашивает `app:take-focus-target`. Main отдаёт отложенную цель один раз. Цель
    получает слушатель, подписанный в момент доставки: `StrictMode` в разработке
    подписывает эффекты дважды.
- **Звук** — `silent: !prefs().sound`.
- **Подсказка в настройках** (спека 7.4, «Разрешение»): Electron на macOS не сообщает,
  запретил ли пользователь уведомления, поэтому в секции «Уведомления» всегда стоит
  строка «Не приходят — Системные настройки → Уведомления → Harnas»
  (`S.settings.notificationsHint`).

**Тесты**
1. `createNotifier`: два уведомления с одним тегом — у первого вызван `close`, у
   второго `show`. Клик — `focusWindow`, затем `sendFocusTarget` с целью. После `click`
   и после `close` запись уходит из `Map`: следующее уведомление с тем же тегом `close`
   у прежнего не зовёт.
2. `createAttentionNotifier`:
   - первое значение сессии — база: `blocked` первым — уведомления нет;
   - после базы `working` переход в `blocked` при невидимой цели — одно уведомление:
     заголовок `Redesign · S02 executor — needs you`, тело — первая строка задачи;
   - повтор `blocked` — нет;
   - цель видима — нет;
   - `prefs().needsYou: false` — нет;
   - `sound: false` → `silent: true`;
   - сессия `closed` или `sleeping` с `blocked` в активности — нет.
3. Новое письмо человеку → уведомление `mail:<workKey>`; `question` от S01 — заголовок
   `Redesign · question from S01`, тело — первая строка письма. Письмо агента агенту и
   сообщение комнаты — нет.
4. `applyFocusTarget` для сессии: `setActiveWork` и `openTab(terminal)` сразу;
   `flash(workKey, tabId)`, `scrollToBottom` и `focus` — только после `whenShown` →
   `true`; `whenShown` → `false` — ни вспышки, ни фокуса. Для удалённой сессии →
   `false`, ничего не открыто, а обработчик `onFocusTarget` в `App` показывает тост
   `Workspace or session no longer exists`.
5. `SettingsDialog`: в секции «Уведомления» всегда видна подсказка
   `Not getting notifications? System Settings → Notifications → Harnas`. Запись
   переключателей уже проверяют тест 1 куска 1.4 и тест 11 куска 2.3.
6. **E2E `attention.spec.ts`, переход.** Две работы, у второй — сессия.
   `app.evaluate` шлёт окну `app:focus-target` с этой сессией. Вторая работа активна,
   вкладка её сессии в фокусе, а фокус ввода — в её терминале: `document.activeElement`
   — `textarea.xterm-helper-textarea` внутри
   `[data-work-container="<ключ второй работы>"] [data-tab-id="terminal:<id>"]`.
7. **E2E, «просмотрено».**
   - Вкладка сессии неактивна; тест дописывает в журнал хуков
     `{"hook_event_name":"UserPromptSubmit"}` и `{"hook_event_name":"Stop"}`;
   - карточка становится жирной (`unseen`);
   - окно без фокуса: `window.dispatchEvent(new Event('blur'))` в рендерере —
     `windowFocused` ведут события (4.2). Вкладку активируют событием
     `app:focus-target`, как в тесте 6: окно main оно не фокусирует. Карточка жирная и
     через 2 с;
   - окно выводится в фокус: `app.evaluate(({ app, BrowserWindow }) => {
     app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]?.focus(); })`. Если
     под Playwright `document.hasFocus()` всё равно ложно, фокус эмулируется событием
     `focus` окна рендерера (`window.dispatchEvent(new Event('focus'))`): трекер читает
     флаг из событий, а не `document.hasFocus()`;
   - за 3 с карточка перестаёт быть жирной.
8. `createPendingFocusTarget`: `take()` отдаёт положенную цель один раз, затем `null`;
   новая `put` заменяет прежнюю. `ipc.test.ts`: `app:take-focus-target` отдаёт
   отложенную цель, повтор — `null`.
9. `createAttentionNotifier.onWorks`: первый снимок с письмами человеку — ни одного
   уведомления; второй с новым письмом — одно.
10. `onHostNotice` вида `launch-failed` → заголовок `Redesign · S02 executor — couldn't
    launch`, тело `Couldn't launch this session.`, тег `notice:launch-failed:<refKey>`.
11. Регрессия E.1, сюда переезжают тесты `App.test.tsx:94–175`:
    - `trust-wait` с кириллическим `notice.text`: `text` нет ни в заголовке, ни в теле;
      заголовок `Redesign · S03 backend — waiting for folder trust`, тело
      `Not responding since launch — may be waiting for folder trust.`, кириллицы в
      уведомлении нет вовсе;
    - `ref: null` — уведомления нет;
    - в `App.test.tsx` — сквозной тест: `host.notice` вида `trust-wait` с русским `text`
      через подставной мост, в `appNotified` этого `text` нет.
12. Обрезка:
    - название работы из 201 эмодзи → заголовок ровно 200 кодовых точек, последняя «…»,
      непарных суррогатов нет; первая строка письма из 201 эмодзи — тело так же; текст
      ровно в 200 кодовых точек не меняется;
    - `ipc`: `app:notify` с `title` из 201 эмодзи показывает 200 кодовых точек; `target`
      чужой формы, `silent: 'yes'` или `tag: 1` — отказ, `showNotification` не зван.
13. `wireAttentionNotifications` на подставном мосте и настоящих сторах: две сессии
    приходят первыми в `blocked` (повтор 3.1) — уведомлений нет; третья после базы
    `working` уходит в `blocked` — одно. Отписка и новый вызов (переподключение) —
    повтор тех же `blocked` снова база, уведомлений нет.
14. Отложенный тест 2.5 «`focus()` поверхности фоновой работы»: `AppShell` на
    подставном мосте, xterm подменён, как в `AppShell.test.tsx`; цель — сессия
    негидрированной работы вне LRU. `openTab` ждёт в очереди; после `hydrate` вызваны
    `focus()` и `scrollToBottom()` её поверхности, и в момент `focus()` ни поверхность,
    ни контейнер работы не `inert`.
15. `App` на подставном мосте: отложенная цель (`setPendingFocusTarget`), `works.list`
    ещё не ответил — работа не активна, тоста нет; после ответа цель применена: работа
    активна, вкладка открыта, тоста нет.
16. `flashTab(workKey, tabId)` (поддельные таймеры): `data-flash` на вкладке этой работы
    600 мс, потом снят; вкладка с тем же id в другой работе LRU и поверхность терминала
    с тем же `data-tab-id` — без него.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.
- [ ] `grep -rn "wireNotifications\|createNotificationWatcher\|noticeTitle\|trustWaitTitle\|alertSuffix"
      packages/desktop/src packages/desktop/e2e` пуст, включая комментарии.

**Приёмка этапа 4** (человек, на пересобранном `harnas.app`)
- [ ] Окно в фоне, агент закончил ход — уведомление; клик приводит на вкладку, рамка
      вспыхивает, печатать в терминал можно сразу.
- [ ] Окно закрыто кнопкой заголовка, приложение живо: клик по уведомлению открывает
      окно сразу на вкладке сессии, без тоста «уже удалены».
- [ ] При открытом окне и видимой вкладке уведомления нет.
- [ ] Перезапуск окна при живом хосте, где сессия ждёт разрешения, пачки уведомлений не
      даёт.
- [ ] «Не просмотрено» не гаснет, пока окно не в фокусе.
- [ ] Бейдж Dock показывает число «ждут тебя» и писем тебе.
- [ ] Заголовки и тексты уведомлений — по-английски; как есть приходят только название
      работы, ярлык, задача и письмо.
- [ ] `README.md`, раздел «Окно» — внимание и уведомления.
