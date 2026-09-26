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
- `attention/derive.ts` (`WorkAttention`, `humanUnreadLetters`, `roomUnreadForHuman`);
- `layout/store.ts`, `terminal/TerminalSurface.tsx` (`terminalSurfaces`);
- `renderer/notifications.ts` (что заменяется), `lib/capabilities.ts`
  (`REQUIRED_METHODS`).

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
    `markSeen`, обработчик `activity.seen`;
  - `packages/host/src/methods/index.ts` — регистрация;
  - `packages/desktop/src/renderer/lib/capabilities.ts` — `REQUIRED_METHODS` +
    `activity.seen`, `mail.markRead`.
- Создать: `packages/host/src/methods/mail.ts` и `mail.test.ts`.

**Интерфейсы**

```ts
// core/work/letters.ts — через updateMap
/**
 * Ставит readBy.human = now письмам, которые человек видит: прямым письмам человеку
 * и сообщениям комнат, не от самого человека. Уже прочитанные и чужие id пропускаются.
 * Возвращает, сколько отметок поставлено.
 */
export async function markHumanRead(projectPath: string, workId: string, messageIds: string[]): Promise<number>;

// protocol/methods.ts
NOTIFICATIONS['activity.seen'] = z.object({ ref: sessionRef });
METHODS['mail.markRead'] = z.object({ projectPath: z.string(), workId: z.string(), messageIds: z.array(z.string()).min(1).max(500) });
Results['mail.markRead'] = { marked: number };
```

**Поведение**
- **`pty.attach`** отдаёт снимок и подписывает клиента, «просмотрено» не трогает.
  `pty.input` по-прежнему зовёт `markSeen`.
- **`activity.seen { ref }`** зовёт `activity.markSeen(ref)`. Неизвестная сессия —
  тихо игнорируется: уведомление, ответа нет.
- **`mail.markRead`:**
  - пустой результат — не ошибка: `{ marked: 0 }`;
  - работы нет — `not_found`;
  - запись карты — одна, `updateMap` на все id сразу.
- **`markHumanRead`** не трогает письма, адресованные только агентам (`roomId ===
  null` и `to` без `human`), и письма от `human`.

**Тесты**
1. `markHumanRead`:
   - письмо S01 человеку → 1, `readBy.human` — ISO-время;
   - повтор → 0;
   - письмо S01 агенту S02 → 0;
   - сообщение комнаты от S02 → 1;
   - неизвестный id → 0.
2. Хост: `pty.attach` сессии в `unseen` оставляет `unseen` — подставная активность без
   вызова `markSeen`.
3. Хост: `activity.seen` зовёт `markSeen` ровно этой сессии; неизвестная — без
   исключения, хост живёт (тот же приём, что в тесте `94c5f8c`).
4. Хост: `mail.markRead` для несуществующей работы → `not_found`; 501 id —
   `bad_request` на схеме.

**Приёмка**
- [ ] Все тесты зелёные во всех пакетах.

---

## 4.2. Видимость, отметки, счётчики, бейдж

**Зачем.** Человек видит, где нужен, а отметки гаснут, когда он посмотрел.
**Зависит от:** 4.1. **Спека:** 7.2, 7.3, 7.6.

**Файлы**
- Создать в `packages/desktop/src/renderer/attention/`:
  - `seen.ts` и тест;
  - `store.ts` и тест;
  - `use-mark-read.ts` и тест;
  - `next.ts` и тест.
- Изменить в `packages/desktop/src/renderer/`:
  - `layout/Tab.tsx` и `layout/tab-meta.ts` — `unread` и значок вопроса из внимания;
  - `sidebar/WorkCard.tsx`, `sidebar/SessionRow.tsx` — данные из `attention/store.ts`;
  - `components/mail/MailPanel.tsx`, `components/rooms/RoomPanel.tsx` —
    `useMarkRead` на письмах;
  - `shell/StatusBar.tsx` — сегмент 3: «N ждут тебя · M не просмотрено», клик — к
    следующей;
  - `App.tsx` — бейдж через `app.setBadge`: из `attention/store.ts`, прежний расчёт в
    `notifications.ts` отключается.

**Интерфейсы**

```ts
// attention/seen.ts
export interface VisibilityInput {
  windowFocused: boolean;
  documentVisible: boolean;
  activeWorkKey: string | null;
  layout: WorkLayout | null;       // раскладка активной работы
  entry: WorkEntry | null;         // активная работа
}
/** Сессии, чьи вкладки терминала активны в своих группах активной работы при фокусе окна. */
export function visibleSessions(input: VisibilityInput): SessionRef[];
export interface SeenTracker {
  update(visible: SessionRef[], unseen: ReadonlySet<string> /* refKey */): void;
  dispose(): void;
}
/** 1 с непрерывной видимости сессии в unseen → send(ref); не чаще раза в 2 с на сессию. */
export function createSeenTracker(deps: {
  send(ref: SessionRef): void;
  now(): number; setTimer: typeof setTimeout; clearTimer: typeof clearTimeout;
}): SeenTracker;

// attention/store.ts
export interface AttentionTotals { needsYou: number; unseen: number; humanUnread: number }
export function useAttention(): { byWork: Record<string, WorkAttention>; totals: AttentionTotals };
export function badgeCount(totals: AttentionTotals): number;   // needsYou + humanUnread

// attention/use-mark-read.ts
/** Ref-колбэк для элемента письма: видимое ≥1 с при фокусе окна непрочитанное уходит в mail.markRead пачкой через 500 мс. */
export function useMarkRead(input: {
  bridge: HarnasBridge; projectPath: string; workId: string; active: boolean;
}): (messageId: string, unread: boolean) => (el: HTMLElement | null) => void;

// attention/next.ts
/** Следующая по кругу сессия уровня needs-you, затем unseen, в видимом порядке сайдбара. */
export function nextAttentionTarget(
  sections: SidebarSection[], byWork: Record<string, WorkAttention>,
  activity: Record<string, ActivityEntry>, current: SessionRef | null,
): SessionRef | null;
```

**Поведение**
- **Видимость.**
  - `windowFocused` — события `focus` и `blur` окна, `documentVisible` —
    `visibilitychange`.
  - Трекер пересчитывается на каждое изменение раскладки, активной работы, фокуса или
    активности.
  - `activity.seen` шлётся через `bridge.notify`, только если `useHostSupports
    ('activity.seen')`.
- **Письма.**
  - `IntersectionObserver` с порогом 0.5 на элементах непрочитанных писем.
  - Письмо, видимое непрерывно 1 с при фокусе окна и активной вкладке почты или
    комнаты, попадает в пачку.
  - Пачка уходит в `mail.markRead` через 500 мс тишины.
  - Повторно одно письмо не отправляется, пока снимок работ его не обновит.
- **Отметки** — таблица спеки 7.3:
  - вкладка: подложка amber-500/10 при `needs-you` или `unseen`, значок вопроса
    вместо точки при `needs-you`;
  - карточка и строка — как в 3.3, но из `useAttention`.
- **Строка статуса.** «2 ждут тебя · 1 не просмотрено». Нули не показываются, при двух
  нулях сегмента нет. Клик — `nextAttentionTarget` → активная работа и фокус вкладки
  (`openTab`).
- **Бейдж** — `badgeCount`, ноль — пустой. Шлётся при изменении.

**Тесты**
1. `visibleSessions`:
   - окно не в фокусе → пусто;
   - `documentVisible: false` → пусто;
   - вкладка терминала неактивна в группе → её нет;
   - работа не активна → пусто.
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
5. `nextAttentionTarget`: сначала `needs-you` по порядку сайдбара, по кругу; нет
   `needs-you` — первая `unseen`; нет обеих — `null`.
6. Вкладка терминала сессии в `needs-you`: `data-unread="true"` и значок вопроса.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 4.3. Уведомления с переходом; приёмка этапа 4

**Зачем.** Уведомление приводит прямо к агенту и не мешает, когда человек уже смотрит.
**Зависит от:** 4.2. **Спека:** 3.3, 7.4, 7.5.

**Файлы**
- Создать:
  - `packages/desktop/src/main/notifications.ts` и тест;
  - в `packages/desktop/src/renderer/attention/`: `notify.ts`, `flash.ts`,
    `focus-target.ts` и тесты;
  - `packages/desktop/e2e/attention.spec.ts`.
- Изменить:
  - `src/shared/bridge.ts` — `app.notify(note: AppNote)`, `app.onFocusTarget`, типы
    `AppNote` и `FocusTarget` (спека 3.3);
  - `src/preload/index.ts`, `src/main/ipc.ts` — проверка `AppNote`, событие
    `app:focus-target`;
  - `src/main/index.ts` — уведомитель, `app.on('activate')` не мешает переходу;
  - `renderer/App.tsx` — `wireAttentionNotifications` вместо `wireNotifications`,
    обработчик `onFocusTarget`;
  - `renderer/components/settings/SettingsDialog.tsx` — секция «Уведомления» читает и
    пишет `ui.json.notifications`, текст подсказки про системные настройки.
- Удалить: `renderer/notifications.ts` и его тест.

**Интерфейсы**

```ts
// main/notifications.ts
export interface NotificationLike { show(): void; close(): void; on(event: 'click', cb: () => void): void }
export function createNotifier(deps: {
  create(options: { title: string; body: string; silent: boolean }): NotificationLike;
  focusWindow(): void;                     // restore → show → focus
  sendFocusTarget(target: FocusTarget): void;
}): { notify(note: AppNote): void; closeAll(): void };

// renderer/attention/notify.ts — замена notifications.ts
export interface NotifyDeps {
  notify(note: AppNote): void;
  prefs(): UiFile['notifications'];
  isTargetVisible(target: FocusTarget): boolean;
  workTitle(projectPath: string, workId: string): string;
}
export function createAttentionNotifier(deps: NotifyDeps): {
  onActivity(ref: SessionRef, session: WorkSession | null, activity: SessionActivity): void;
  onWorks(entries: WorkEntry[]): void;           // новые письма человеку
  onHostNotice(notice: HostNotice): void;        // trust-wait, launch-failed, resume-failed
};

// renderer/attention/flash.ts
export function flashTab(tabId: string, durationMs?: number): void;   // 600

// renderer/attention/focus-target.ts
export function applyFocusTarget(target: FocusTarget, deps: {
  works: WorkEntry[]; setActiveWork(workKey: string): void;
  openTab(workKey: string, tab: TabSpec): void; flash(tabId: string): void;
  scrollToBottom(refKey: string): void;
}): boolean;   // false — цели больше нет
```

**Поведение**
- **Когда шлём** — таблица спеки 7.4: переход сессии в `blocked` или `unseen`, новое
  письмо человеку, уведомления хоста `trust-wait`, `launch-failed`, `resume-failed`.
  - Повтор того же состояния не уведомляет.
  - Ключ в `prefs()` выключен — не шлём.
  - `isTargetVisible` — видимость по правилам 4.2: для сессии — её терминал, для
    почты — вкладка почты активна при фокусе.
- **Текст:**
  - заголовок `<работа> · S02 исполнитель — ждёт тебя` или `— закончил ход`;
  - для письма — `<работа> · письмо от S01`, `вопрос от S01` или `решение от S01`;
  - тело — первая строка задачи, итога (`result`, иначе `summary`) или письма, до 200
    символов.
- **Теги:** `session:<refKey>`, `mail:<workKey>`, `notice:<kind>:<refKey>`. Main
  закрывает прежнее уведомление с тем же тегом перед показом нового.
- **Клик:**
  1. Main: `restore()`, если свёрнуто, `show()`, `focus()`.
  2. Main шлёт `app:focus-target`.
  3. Рендерер: `applyFocusTarget` — активная работа, вкладка (`openTab`), вспышка 600
     мс (кольцо 2px `--ring`), прокрутка терминала вниз.
  - Цели нет — окно просто на переднем плане, тост «Работа или сессия уже удалены».
- **Звук** — `silent: !prefs().sound`.
- **Подсказка в настройках.** Electron на macOS не сообщает, запретил ли пользователь
  уведомления. Поэтому в секции «Уведомления» всегда стоит строка: «Не приходят —
  Системные настройки → Уведомления → Harnas». Это уточнение к спеке 7.4: признака
  запрета, на который она ссылается, у платформы нет.

**Тесты**
1. `createNotifier`: два уведомления с одним тегом — у первого вызван `close`, у
   второго `show`. Клик — `focusWindow`, затем `sendFocusTarget` с целью.
2. `createAttentionNotifier`:
   - переход в `blocked` при невидимой цели — одно уведомление с заголовком по
     таблице;
   - повтор `blocked` — нет;
   - цель видима — нет;
   - `prefs().needsYou: false` — нет;
   - `sound: false` → `silent: true`.
3. Новое письмо человеку → уведомление `mail:<workKey>`. Письмо агенту агенту — нет.
4. `applyFocusTarget` для сессии: `setActiveWork`, `openTab(terminal)`, `flash`,
   `scrollToBottom`. Для удалённой сессии → `false`, ничего не открыто.
5. `SettingsDialog`: переключатели «Уведомления» пишут `saveUi({ notifications })`.
6. **E2E `attention.spec.ts`, переход.** Две работы, у второй — сессия.
   `app.evaluate` шлёт окну `app:focus-target` с этой сессией. Вторая работа активна,
   вкладка её сессии в фокусе.
7. **E2E, «просмотрено».**
   - Вкладка сессии неактивна; тест дописывает в журнал хуков
     `{"hook_event_name":"UserPromptSubmit"}` и `{"hook_event_name":"Stop"}`;
   - карточка становится жирной (`unseen`);
   - вкладку активируют при фокусе окна (`BrowserWindow.focus()` через
     `app.evaluate`) — за 3 с карточка перестаёт быть жирной.

**Приёмка**
- [ ] Все тесты зелёные, E2E зелёные.

**Приёмка этапа 4** (человек, на пересобранном `harnas.app`)
- [ ] Окно в фоне, агент закончил ход — уведомление; клик приводит на вкладку, рамка
      вспыхивает.
- [ ] При открытом окне и видимой вкладке уведомления нет.
- [ ] «Не просмотрено» не гаснет, пока окно не в фокусе.
- [ ] Бейдж Dock показывает число «ждут тебя» и писем тебе.
- [ ] `README.md`, раздел «Окно» — внимание и уведомления.
