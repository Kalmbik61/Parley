# План, этап 2: сетка панелей

Дата: 2026-09-26. Индекс и общие правила — `2026-09-26-desktop-plan.md`. Спека —
`2026-09-26-desktop-design.md`, разделы 4.4, 5.1, 5.2.

**Итог этапа:** три терминала и «вся почта работы» одновременно на экране, а
раскладка переживает перезапуск окна.

**Перед стартом:** сверить имена из этапа 1 — `TerminalPanel`, `store/ui.ts`,
`HarnasBridge`, `MenuAction` — с тем, что получилось в коде.

---

## 2.1. Сетка dockview и перетаскивание

**Зачем.** Несколько живых агентов рядом, раскладка мышью.
**Зависит от:** 1.11. **Спека:** 4.4, 5.1, 5.2.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `components/layout/Workspace.tsx`;
  - `components/layout/panel-registry.ts`;
  - `components/layout/sidebar-drag.ts`;
  - `components/palette/SessionPicker.tsx`;
  - `lib/panel-id.ts`;
  - тесты рядом и `e2e/grid.spec.ts`.
- Изменить:
  - `App.tsx` — вместо одной панели `Workspace`;
  - `components/sidebar/SessionTree.tsx` — строки перетаскиваются;
  - `store/ui.ts` — активная панель;
  - `package.json` desktop — `dockview`.

**Интерфейсы**

```ts
// lib/panel-id.ts: одна панель на сессию (спека 4.4) держится на детерминированном id
export const workKey = (projectPath: string, workId: string): string => `${projectPath}\u0000${workId}`;
export type PanelKind = 'terminal' | 'mail' | 'room' | 'changes';
export interface PanelSpec { kind: PanelKind; ref?: SessionRef; workKey: string; roomId?: string }
export function panelId(spec: PanelSpec): string; // 'terminal:<refKey>', 'mail:<workKey>', 'room:<workKey>:<roomId>', 'changes:<refKey>'

// components/layout/panel-registry.ts
export const PANEL_COMPONENTS: Record<PanelKind, React.FC<{ params: PanelSpec }>>; // 'mail', 'room', 'changes' — заглушки до 2.4, 3.6, 4.3

// components/layout/sidebar-drag.ts
export const DRAG_MIME = 'application/x-harnas-panel';
export function dragPayload(spec: PanelSpec): string;
export function readDragPayload(event: DragEvent): PanelSpec | null;
```

**Поведение**
- **Открыть сессию.** Если панель с таким `panelId` уже есть — фокус на неё. Иначе —
  новая вкладка в активной группе.
- **Перетаскивание из сайдбара:** на край панели — деление в эту сторону; в центр —
  вкладка в той же группе.
- **⌘D и ⇧⌘D** открывают `SessionPicker` — сессии текущей работы без панели.
  Выбранная сессия встаёт справа или снизу от активной панели.
- **⌘W** закрывает активную панель: `pty.detach`, сессия не трогается.
- **⌘[ и ⌘]** — предыдущая и следующая панель в порядке раскладки.
- **Размеры.** Каждая панель терминала сама шлёт `pty.resize` под свой размер (1.11).
- **Видимость.** Вкладка, которая стала невидимой, делает `pty.detach`; ставшая
  видимой — `pty.attach` со снимком. Иначе фоновая вкладка отмечала бы сессию
  просмотренной (`markSeen`), и `unseen` пропадал бы без взгляда человека.
- **Уведомления** из 1.10 теперь считают видимой сессию, у которой видна панель в
  сетке, а не выбранную в сайдбаре.

**Тесты**
1. `panelId` детерминирован: одна и та же сессия даёт один и тот же id.
2. Второе открытие той же сессии → панель одна, и она в фокусе.
3. Закрытие панели → `pty.detach` вызван, `sessions.stop` — нет.
4. `readDragPayload` отвергает чужой MIME и битый JSON.
5. `SessionPicker` не показывает сессии, у которых уже есть панель.
5а. Переключение вкладок: ушедшая делает `pty.detach`, пришедшая — `pty.attach`;
   сессия невидимой вкладки не отмечается просмотренной.
6. **E2E:** три stub-сессии рядом; ввод в одну не попадает в две другие.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Перетаскивание из сайдбара на все четыре края работает (ручная проверка).

---

## 2.2. Раскладка на работу

**Зачем.** Вернулся к работе — всё стоит, как было.
**Зависит от:** 2.1. **Спека:** 5.1.

**Файлы**
- Создать:
  - `packages/desktop/src/main/layout-store.ts` и тест;
  - `packages/desktop/src/renderer/components/layout/use-layout-persistence.ts` и тест.
- Изменить:
  - `src/shared/bridge.ts` — `app.loadLayout`, `app.saveLayout`;
  - `src/main/ipc.ts`, `src/preload/index.ts`.

**Интерфейсы**

```ts
// main/layout-store.ts — файл ~/.harnas/desktop/layouts.json
export interface LayoutsFile { version: 1; layouts: Record<string, unknown> } // ключ — workKey
export function createLayoutStore(file: string, options?: { maxBytes?: number }): { // 1 МБ
  load(workKey: string): Promise<unknown | null>;
  save(workKey: string, layout: unknown): Promise<void>; // tmp + rename
};
// bridge.ts, дополнение к app
loadLayout(workKey: string): Promise<unknown | null>;
saveLayout(workKey: string, layout: unknown): Promise<void>;
```

**Поведение**
- Изменение раскладки → сохранение через 500 мс тишины.
- Смена работы: сохранить текущую → загрузить нужную → `api.fromJSON`.
- **Перед восстановлением** выбрасываются панели, чьих сессий или комнат больше нет
  в карте.
- **Битый файл** → пустые раскладки и строка в строке статуса. При следующем
  сохранении файл перезаписывается.
- **Файл больше лимита** → сохранение отказывает, в строке статуса предупреждение,
  старая раскладка остаётся.

**Тесты**
1. `save` → `load` возвращает то же самое.
2. Битый JSON → `load` даёт `null`, следующий `save` пишет валидный файл.
3. Панель удалённой сессии при восстановлении выброшена.
4. Пять изменений за 200 мс → одно сохранение.
5. Запись атомарна: во время записи `layouts.json` всегда читается как валидный JSON.

**Приёмка**
- [ ] Все тесты зелёные.
- [ ] Раскладка переживает перезапуск окна (E2E: открыть три панели, выйти,
      запустить — три панели на местах).

---

## 2.3. Палитра команд ⌘K

**Зачем.** Быстро найти сессию, работу или действие без мыши.
**Зависит от:** 2.1. **Спека:** 5.2.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `components/palette/CommandPalette.tsx`;
  - `lib/fuzzy.ts`;
  - `lib/commands.ts`;
  - тесты рядом.

**Интерфейсы**

```ts
export interface Command { id: string; title: string; hint?: string; keywords: string[]; run(): void | Promise<void> }
export function buildCommands(state: {
  works: WorksSnapshot; ui: UiState; bridge: HarnasBridge;
}): Command[];
/** Совпадение по подпоследовательности; выше — сплошной кусок и начало слова. */
export function fuzzyScore(query: string, text: string): number | null;
```

**Поведение**
- **Пункты палитры:**
  - работы — переключиться;
  - сессии всех работ — открыть; в ключах номер `S03` и заголовок работы;
  - действия: «Новая сессия», «Новая работа», «Настройки», «Пауза будильника» или
    «Снять паузу», «Вся почта работы» (из 2.4), «Закрыть панель».
- **Порядок.** Пустой запрос — сначала сессии, открытые последними.
- **Клавиши:** стрелки — навигация, Enter — выполнить, Esc — закрыть.
- **Без новых зависимостей:** Radix Dialog и свой список.

**Тесты**
1. `fuzzyScore('s03', 'S03 бэкенд')` находит; `'плат'` находит работу «Платежи»;
   сплошное совпадение выше разрывного.
2. Enter выполняет выбранную команду, Esc закрывает без действия.
3. При пустом запросе недавние сессии идут первыми.

**Приёмка**
- [ ] Все тесты зелёные.

---

## 2.4. Панель «вся почта работы» и приёмка этапа 2

**Зачем.** Переписку работы видно рядом с терминалами, с нормальным текстом.
**Зависит от:** 2.1. **Спека:** 5.1, 6.3, 6.4.

**Эталон для переноса:** `packages/tui/src/room-view.ts` — подписи `S03 (Codex)`,
блок решений, заголовок письма, `▤`.

**Файлы**
- Создать в `packages/desktop/src/renderer/`:
  - `components/mail/MailPanel.tsx`, `Letter.tsx`, `Decisions.tsx`;
  - `lib/mail-view.ts`, `lib/participant-tag.ts`;
  - тесты рядом.
- Изменить:
  - `components/layout/panel-registry.ts` — `mail`;
  - `components/sidebar/SessionTree.tsx` — строка «вся почта работы», если в работе
    есть письма;
  - `lib/commands.ts`;
  - `package.json` desktop — `react-markdown` и `remark-gfm`, **без** `rehype-raw`.

**Интерфейсы**

```ts
export interface LetterView {
  id: string; time: string; from: string; to: string; kind: 'note' | 'question' | 'decision';
  text: string; unread: boolean;
}
export interface MailView { participants: string[]; decisions: { shown: LetterView[]; earlier: number }; letters: LetterView[] }
export function mailView(entry: WorkEntry, providers: Array<{ id: string; label: string }>, models: Record<string, string | null>): MailView;
/** 'S03 (Codex)'; модель неизвестна — подпись провайдера; удалённая — 'S02 (удалена)'. */
export function participantTag(map: WorkMap, id: string, model: string | null, providers: Array<{ id: string; label: string }>): string;
```

**Поведение**
- **Шапка:** `вся почта · N писем` и участники в порядке сайдбара.
- **Блок решений:** до пяти последних; каждое не длиннее двух строк
  (`line-clamp`); старше — строкой `+N раньше`.
- **Заголовок письма:** `ЧЧ:ММ  S03 (Codex) → S01 (Opus 5.5)  · вопрос`.
- **Тело:** markdown, код с подсветкой. Сырой HTML показывается текстом. Ссылки
  открываются через `app.openExternal`.
- **Прочтение.** Прочитанные письма не гаснут. У непрочитанного адресатом — `▤`.
- **Прокрутка.** Лента держится хвоста. Если пользователь ушёл вверх, новое письмо
  позицию не сбивает, в шапке растёт `↓N`.

**Тесты**
1. В ленте все письма работы, а не поддерева.
2. У корневой сессии ярлык в 200 знаков — ни одна строка ленты его не содержит.
3. Решений семь → показаны пять и `+2 раньше`.
4. `▤` только у непрочитанных, прочитанные не приглушены.
5. `<script>alert(1)</script>` в теле показан текстом, скрипт не выполняется; блок
   кода отрисован.
6. Новое письмо при прокрутке вверх не двигает позицию, `↓N` растёт.

**Приёмка**
- [ ] Все тесты зелёные.

**Приёмка этапа 2** (человек)
- [ ] Три терминала и «вся почта работы» одновременно на экране.
- [ ] Раскладка переживает перезапуск окна.
- [ ] `README.md` — раздел «Сетка» и клавиши. `TODOS.md` — закрыт «Сплит главной
      области на две живые панели».
