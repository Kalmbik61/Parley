# Окно харнаса: комнаты, решения, облик Organic — дизайн

Спека следующей версии окна (`packages/desktop`) по hi-fi handoff, который передал
пользователь 2026-09-29. Исходник handoff без правок лежит в
`docs/design/2026-09-29-rooms-organic/`: README, `TASKS.md`, HTML-прототип, снимки. Пути
`prototype/…`, `screenshots/` и `TASKS.md` в тексте ниже — относительно этого каталога.
План реализации — `docs/specs/2026-09-29-desktop-rooms-organic-plan.md`.

## Статус и решения (2026-09-29)

Эта спека обязательна для облика и для поведения комнат. Она заменяет раздел 4 (облик) спеки
Orca-UI `docs/specs/2026-09-26-desktop-orca-ui-design.md`, а также размеры из её таблицы 4.4
там, где они расходятся. Поведение из спек окна и Orca-UI, которого здесь нет, не меняется:
ресайз, сплиты, редактор, ревью, браузер.

Правила проекта сильнее handoff:
- тексты окна — только английские, из `shared/strings.ts`;
- юридическая рамка README и чек-лист 15.1 спеки Orca-UI;
- протокол — только добавления;
- окно не ходит в сеть.

Решения по открытым вопросам handoff (раздел 6) и уточнения пользователя:

1. **Главная кнопка.**
   - В светлой теме светлый текст `bg` на `accent` даёт 3.0:1 — для текста 14px это ниже
     AA. Поэтому в светлой теме фон главной кнопки — `accent-700` (5.7:1), hover —
     `accent-800`, active — `accent-900`.
   - В тёмной теме — как в прототипе: фон `accent`, текст `bg` (6.5:1).
2. **Hover неактивной карточки** — `text 4%` вместо 6%.
   - `text 5%` (первое решение) вместе с порогом 4.5:1 невыполнимо: `neutral-700` на
     `surface` даёт 4.47:1, при 6% — 4.41:1.
   - Порог сквозной, поэтому взято ближайшее целое, где он держится: 4% — 4.56:1
     (тёмная 6.50:1).
3. **Строка статуса.**
   - Слева — сегменты провайдеров: значок, имя, версия CLI.
   - Справа — сегменты спеки Orca-UI 5.9: связь с хостом, счётчики внимания,
     `host.notice`, будильник.
   - Лимиты подписки — по разделу 3.5 (решение 10).
4. **Одна комната на сессию.**
   - Правило проводит хост в `rooms.create` и `rooms.addMember`: сессия уходит из прочих
     комнат работы.
   - Старые карты не переписываются. Если сессия в старой карте состоит в нескольких
     комнатах, сайдбар ставит её в комнату с самым ранним `createdAt`.
5. **Модель и effort.**
   - Флаги CLI берутся из документации провайдера (Claude Code, Codex), не угадываются.
   - Не подтверждено — `providers.list` отдаёт `models: null` и `effort: false`, окно
     прячет контрол.
6. **Значки провайдеров** — брендовые SVG из `prototype/assets` (`claude.svg`,
   `codex.svg`, `codex-light.svg` для тёмной темы).
   - Это решение пользователя 2026-09-29 для личной неподписанной сборки. Оно заменяет
     требование лицензии из раздела 5 handoff и из спеки Orca-UI 4.6.
   - Происхождение и принадлежность знаков — в `NOTICE`.
   - Неизвестный провайдер — буквенный `AgentIcon`.
7. **Бейдж свёрнутой комнаты** — число **всех** агентов этого провайдера в комнате
   (решение пользователя), тултип `2 Claude Code agents` — как в разделе 1.2.
8. **Шрифты** Figtree и Caprasimo лежат локально в `renderer/assets/fonts/` вместе с
   лицензиями OFL 1.1. Из Google Fonts не грузятся.
9. **Прототип в репозитории** (`packages/desktop/prototype/rooms`, ветка `proto/rooms`) —
   исследование сверх этой спеки: план с владельцами, ревизии, роли и инструкции,
   «Launch prepared». Всё это — следующий этап (TODOS, прогон 8).
10. **Лимиты подписок** (решение пользователя 2026-09-29) показываются в строке
    статуса. Данные — только те, что отдают сами CLI: строка статуса Claude Code и
    логи Codex, раздел 3.5. Учётные данные не читаются, API не вызывается. Запрет
    handoff (раздел 1.1) снят, рамка README поправлена.


## Обзор

Дизайн следующей версии окна (`packages/desktop`). Три изменения:

1. **Комната — разговор с 1..N агентами.** С одним агентом это обычная сессия, с двумя и больше — комната с ведущим. Переключателя типа нет: тип следует из числа агентов в диалоге создания.
2. **Решение ждёт человека.** Задача пишется в комнату один раз для всех. Ведущий собирает позиции участников и приносит решение: карточка `decision · waiting for you` с кнопками `Accept` / `Return for rework`, во внимании она весит как «нужен ты». После `Accept` ведущий раздаёт части, участники отчитываются в той же комнате.
3. **Облик Organic** вместо нейтральных токенов Orca: песочный фон, терракотовый и шалфейный акценты, Caprasimo в заголовках и кнопках, Figtree в тексте, скругления до пилюль. Светлая и тёмная тема.

Плюс: упоминания `@` в поле ввода комнаты (как в Telegram), черновик на каждую комнату, перетаскивание сессий в комнату прямо в сайдбаре, один диалог «New session or room».

## О файлах

`prototype/Harnas Window v2.dc.html` — **дизайн-референс в HTML**, не продакшн-код. Он показывает облик и поведение. Задача — воссоздать его в `packages/desktop` на существующем стеке (Electron, React 18, Tailwind 4, примитивы shadcn/ui в `renderer/ui/`, zustand) и дописать недостающее в `packages/core`, `packages/protocol`, `packages/host`.

Правила репозитория остаются в силе: спеки `docs/specs/2026-09-26-desktop-design.md` («спека окна») и `docs/specs/2026-09-26-desktop-orca-ui-design.md` («спека Orca-UI»), английский интерфейс из `shared/strings.ts` (глоссарий: работа → workspace), юридическая рамка из README репозитория.

Открыть прототип: `npx serve prototype`, затем `Harnas Window v2.dc.html` в Chrome (нужна сеть для Google Fonts). Тема по умолчанию тёмная. Сценарий для просмотра:
1. Окно открывается в работе «Платежи» на `S02 бэкенд`, который ждёт разрешения.
2. Через 2 с — уведомление `Decision waiting for you` → `Open` → комната «Возвраты» с карточкой решения. `Accept` или `Return for rework`.
3. «+ New session or room» в активной карточке → добавить агента → `Create room` → написать задачу без упоминаний → позиции → решение.
4. Перетащить строку сессии на другую сессию (диалог новой комнаты) или на строку комнаты (вступление).
5. Набрать `@` в поле ввода комнаты.

**Симуляция, не переносить:** данные `seed()`, реплики агентов (`POSITIONS`, `ROLES`, «Принял, беру в работу.», «Версия N, с учётом замечания.»), все таймеры, терминал из строк вместо xterm, ответ на диалог разрешения, числа лимитов подписки в строке статуса (настоящие данные — раздел 3.5).

## Фиделити

**Hi-fi.** Раскладка, размеры, цвета, типографика, тексты интерфейса и состояния финальные. Содержимое ленты и названия работ (русский текст) — пример данных.

Где размер прототипа расходится с таблицей 4.4 спеки Orca-UI, берётся прототип: Organic крупнее на 10% (заголовок 40 вместо 36, сайдбар 288 вместо 280, строка статуса 28 вместо 24). Поведение из спек, которого прототип не показывает (ресайз сайдбаров, сплиты, редактор, ревью, браузер), не меняется.

## Карта: прототип → код

| Область | Файлы сейчас | Что сделать |
|---|---|---|
| Токены, шрифты, иконки | `renderer/styles/tokens.css`, `base.css`, `assets/fonts/`, `ui/button.tsx` | Тема Organic (раздел 4) |
| Каркас, вкладки | `shell/AppShell.tsx`, `Titlebar.tsx`, `StatusBar.tsx`, `layout/TabStrip.tsx`, `Tab.tsx` | Геометрия и вид (1.1) |
| Сайдбар | `sidebar/WorkSidebar.tsx`, `ProjectGroup.tsx`, `WorkCard.tsx`, `SessionRow.tsx`, `sort.ts` | Новая `RoomRow.tsx`, группировка участников, цели перетаскивания (1.2, 2.5) |
| Комната | `components/rooms/RoomPanel.tsx`, `RoomHeader.tsx`, `Composer.tsx` | Лента участников, карточка решения, упоминания, черновики (1.3, 2.2–2.4) |
| Диалоги | `dialogs/NewSessionDialog.tsx`, `rooms/CreateRoomDialog.tsx`, `dialogs/NewWorkDialog.tsx` | Один диалог вместо двух (1.5), диалог комнаты из двух сессий (1.6) |
| Внимание | `attention/derive.ts`, `notifications.ts`, `lib/room-view.ts` | Решение в комнате = «нужен ты» (2.7) |
| Данные | `core/src/work/types.ts`, `core/src/mcp/tools.ts`, `protocol/src/methods.ts`, `host/src/methods/*` | `Room.lead`, `Room.proposal`, три метода, инструмент `propose_decision` (раздел 3) |

Ниже `text N%` означает `color-mix(in srgb, var(--color-text) N%, transparent)`, имена цветов — токены раздела 4.

## 1. Экраны

### 1.1 Окно

```
┌ заголовок 40: [⇤][←][→] (зона = ширина сайдбара) │ вкладки-пилюли … [+] │ [⇥] ┐
│ сайдбар 288      │ лист центра: radius 28, shadow-sm, отступ 0 8 8 0 │ правый 320 │
└ строка статуса 28 ────────────────────────────────────────────────────────────┘
```

- Фон окна `surface`. Центр — лист `--sheet` со скруглением 28px (`--radius-lg`) и `shadow-sm`, `overflow: hidden`. При скрытом левом сайдбаре отступ слева 8px.
- **Заголовок.** Левая зона шириной сайдбара (при скрытом — по содержимому), padding-left 16 (светофор нативный, `hiddenInset`). Кнопки 28×28, пилюли, иконки 15: сайдбар (⌘B), назад (⌘⌥←), вперёд (⌘⌥→); недоступная — opacity .45. Hover `text 8%`, active `text 14%`. Справа — правый сайдбар (⌘L), включённый — фон `text 10%`.
- **Вкладки** (пока группа одна — в заголовке, спека Orca-UI 5.3). Пилюля 28px, `flex: 0 1 200px`, min 72px, padding `0 11px` (у активной справа 5px), gap 7, 12px. Активная: фон `neutral-100`, `shadow-sm`, вес 600, крестик 18×18 (иконка 10). У неактивных крестика нет, закрытие средней кнопкой. Подкраска: сессия `blocked` — `accent-200`, `unseen` — `accent-2-200`; комната с ждущим решением и почта с непрочитанным — `accent-200`. «+» 28px открывает палитру.
- **Строка статуса** 28px, padding `0 14 2 18`, gap 14, 12px `neutral-800`: сегмент на провайдера — значок 14, имя, версия CLI моноширинным 11px `neutral-700`. **Лимиты подписки** — полоска и `58% 5h · 41% wk` после версии, по разделу 3.5.

### 1.2 Сайдбар

- **Навигация** (padding `4 10 10 10`, gap 2): строки 32px, пилюли, padding `0 8 0 12`, gap 10, 13px — `Search` (⌘J), `New workspace` (⌘N). Сочетание — пилюля 10px, padding `2 7`, фон `neutral-200`, текст `neutral-800`.
- **Список**: padding `0 10 14 10`, между проектами 16, между карточками 6. Пока курсор над списком, порядок заморожен (`use-deferred-order.ts` уже есть).
- **Заголовок проекта**: 30px пилюля, padding `0 3 0 8`, gap 8 — круг 16px цвета проекта, имя Caprasimo 15px/1, число работ 11px `neutral-700`, шеврон 13 (свёрнут −90°, `transition .15s`), справа «+» 24px (тултип `New workspace in {project}`). Клик сворачивает.
- **Карточка работы**: padding `8 8 8 10`, radius 16. Активная — фон `neutral-100` и `shadow-sm`; прочие hover `text 6%`; `done` — opacity .6.
  - Строка заголовка 22px, gap 8: значок самого срочного состояния (если в работе ждёт решение — значок вопроса), название 13px (700 при непрочитанной почте или `unseen`, иначе 500), `✉N` (Mail 12, 11px/600 `accent-700`, тултип `{n} unread messages to you`), `#N` — число комнат с непрочитанным (Hash 12, 11px/600 `neutral-700`), время 10px `neutral-700`, min-width 22.
  - Мета 11px/16px `neutral-700`, padding-left 20: `{project} · {N} sessions ·` и ветка моноширинным.
  - Блок строк: отступ сверху 6, gap 1.
- **Строка сессии**: 26px пилюля, padding-left `8 + 12·depth` px, gap 6, 12px — значок состояния 12, значок агента 13, `S02 бэкенд` (700 у выбранной), слово состояния 11px, GitBranch 11 при своём worktree (тултип `Own worktree · {branch}`), время 10px шириной 22. Фон: `blocked` — `accent-200` (слово `accent-800`), `unseen` — `accent-2-200` (слово `accent-2-800`), выбранная и hover — `text 9%`. Закрытая — opacity .5. Тултип — задача.
- **Строка комнаты** (новая): radius 14, padding `4 6 7 {8 + 12·depth}`, gap 4.
  - Шапка 18px, gap 6: значок вопроса 12, если решение ждёт человека, иначе пустое место 12; Hash 13 `neutral-700`; название; слово — `decision` (`accent-800`), `{n} new` (`neutral-800`) или пусто; шеврон в кнопке 16px (тултип `Show agents` / `Hide agents`); время последнего сообщения.
  - Свёрнута — значки провайдеров участников (padding-left 37, gap 14): значок 14 и счётчик в правом нижнем углу (left 9, top 8) — кружок min 12px, фон `neutral-300`, 9px/700, обводка 1.5px цветом фона карточки. Тултип `2 Claude Code agents`.
  - Развёрнута — строки участников 26px, padding-left 18, как строки сессий; у ведущего `★` 11px `accent-700` (тултип `Lead`).
  - Фон: решение ждёт — `accent-200`; выбрана — `text 9%`; развёрнута — `text 4%` (hover 6%). Название 700 при выборе, непрочитанном или решении. Тултип: `Room · lead S01 · S01, S02, S03, S04`.
- **Состав строк карточки**: сессии в порядке `treeOrder`; участник комнаты отдельной строкой не выводится — на месте первого встреченного участника стоит строка его комнаты; комнаты без живых участников — в конце.
- Под строками: `{n} more closed` / `Hide closed` (24px, 11px, padding-left 28). У активной карточки со статусом `active` — `+ New session or room` (24px, 11px, padding-left 26, Plus 11), открывает диалог 1.5.

**Слова состояний** (строчными): `working`, `needs you`, `done · unseen`, `idle`, `not started`, `done`, `failed`, `asleep`, `closed`. Тексты — через `shared/strings.ts`.

**Значки состояний** (коробка 12px, точка 8px):

| Состояние | Значок | Цвет |
|---|---|---|
| working | кольцо, border 2px, верх прозрачный, вращение (общая фаза, спека Orca-UI 4.2) | `neutral-700` |
| blocked | MessageCircleQuestion | `accent-600` |
| unseen | точка | `accent-2-600` |
| idle | точка | `neutral-400` |
| pending | кольцо 2px | `neutral-500` |
| done | CircleCheck | `accent-2-600` |
| failed | CircleX | `accent-700` |
| спит | Moon | `neutral-600` |
| закрыта | «–» | `neutral-500` |

### 1.3 Комната (вкладка `room:<id>`)

Колонка: шапка, лента, поле ввода. Всё на листе центра.

- **Шапка** (padding `24 36 14`, gap 12, снизу линия 1px `currentColor 12%`): название — Caprasimo 25px/1.12, letter-spacing −.015em; подзаголовок 13px muted: `Created by you · 4 agents · lead S01 · Платежи` или `Created by S01 архитектор · …`.
- **Лента участников** (горизонтальная прокрутка, gap 8): карточка 230px, radius 14, padding `9 12`, gap 4. Строка 1 (12px): значок состояния, значок агента 14, `S02 бэкенд` 600, `★` у ведущего, слово 11px. Строка 2: задача 12px muted в одну строку. Фон по состоянию (`accent-200` / `accent-2-200`), иначе `currentColor 6%`; hover — inset-рамка 1px `currentColor 28%`. Тултип `Claude Code · Opus 5.5 · high`. Клик открывает терминал участника.
- **Лента сообщений** (padding `18 36`, gap 16, ширина до 680px; при открытии и новом сообщении прокручена вниз):
  - блок `Decisions` — все сообщения вида `decision`: фон `accent-2-500 14%`, radius 16, padding `12 16`; подпись 11px/600 uppercase, letter-spacing .06em, muted; пункты 13px/1.5 — `{text} · {from}`;
  - пустая комната — 14px muted: `Write the task for everyone below. The lead collects positions and brings you a decision.`;
  - сообщение (gap 10): аватар 18 — значок агента; у человека круг `accent-2-200` с User цвета `accent-2-800`; у системы круг `neutral-300` с Hash цвета `neutral-800`. Мета 12px muted, перенос по словам: отправитель (600, основной цвет), `★` у ведущего (`accent-700`), `→ all` или `→ S02 бэкенд, S03 ревью`, тег вида (`question` — `tag-accent`, `decision` — `tag-accent-2`, `note` — `tag-neutral`), время, точка 7px `accent-2-500` у непрочитанного. Текст 14px/1.55, `pre-wrap`, упоминания — чипы (1.4). Строка ожидания 12px muted `▤ Not picked up yet by S02, S03` — пока не все адресаты прочитали (`readBy`).
  - **Карточка решения** — последней в ленте, пока решение ждёт: до 680px, radius 16, рамка 1.5px `accent`, фон `accent 9%`, padding `14 16`, gap 10. Шапка 12px: аватар, отправитель 600, тег `tag-accent` с текстом `decision · waiting for you`, время muted. Текст 14px с чипами. Кнопки `Accept` (primary) и `Return for rework` (secondary). После `Return for rework` вместо кнопок: textarea (min 64px, radius 14, рамка `currentColor 22%`, фон `currentColor 5%`, 14px, placeholder `What should the lead change?`) и `Send to lead` / `Cancel`.
- **Поле ввода** (padding `10 36 18`, gap 6, сверху линия `currentColor 12%`): подпись 12px muted — `To everyone` или `To S02, S03`; редактор contentEditable — radius 19, высота 38–140px, padding `8 16`, рамка 1px `currentColor 22%`, фон `currentColor 5%`, 14px/20px, плейсхолдер `Write to everyone · type @ to mention an agent`; кнопка `Send` (primary).
- **Меню упоминаний** над полем: left 36, ширина `min(380px, 100% − 72px)`, max-height 260, radius 16, фон `neutral-100`, `shadow-lg`, padding 6, gap 2. Заголовок 11px uppercase `Agents in this room`. Пункт padding `7 10`, radius 10: значок агента 16, `S02 бэкенд` 600, мета 12px `neutral-700` — `Opus 5.5 · high · idle`. Выделенный — `text 9%`. Пусто — `No agents match`.

### 1.4 Чип упоминания

`display: inline-block; padding: 0 7px; margin: 0 1px; border-radius: 999px; background: color-mix(in srgb, var(--color-accent) 22%, transparent); color: var(--color-accent-800); font-weight: 600; white-space: nowrap`. Текст `@S02 бэкенд`. Одинаков в редакторе (нередактируемый узел) и в ленте.

### 1.5 Диалог «New session or room» (660px)

Заменяет `NewSessionDialog` и `CreateRoomDialog`. Открывается: `+ New session or room` в карточке, ⌘T, палитра, пункт меню карточки «New room».

- Заголовок `New session` при одном агенте, `New room` при двух и больше. Подсказка 12px `neutral-700`: `Add another agent to make it a room.` / `The agents discuss the task you write in the room. The lead brings you a decision.`
- Сетка 2 колонки, gap 12: `Workspace` — select активных работ `{title} · {project}` (по умолчанию активная); `Session name` (placeholder `Optional`) или `Room name` (placeholder `What the agents will discuss`).
- `Agents` — строки, gap 8. В строке (gap 8): звезда ведущего 28px (только при ≥2 агентах; `★` цвета `accent` у ведущего, `☆` `neutral-600` у прочих; тултип `Lead` / `Make lead`); провайдер — пилюли 34px `Claude` / `Codex` со значком 14 (выбранная: рамка `accent`, фон `neutral-100`, вес 600; иначе рамка `divider`); select модели; сегмент усилия `Low` / `Medium` / `High`; удалить — X 28px (недоступно при одном агенте, opacity .35).
- `+ Add agent` (secondary): строка берёт провайдера последней, первую модель его списка, усилие `medium`.
- Низ: сводка 12px `neutral-700` слева — `One session in Платежи` / `Room with 3 agents in Платежи`; `Cancel`; главная — `Start session` / `Create room`.
- По умолчанию один агент: провайдер из `ui.json.lastProvider`, первая модель, `medium`; ведущий — первый агент.

### 1.6 Диалог «New room» из двух сессий (420px)

Появляется, когда сессию бросили на другую сессию той же работы. Подзаголовок `S02 бэкенд and S03 ревью move into the room.`; `Name` (placeholder `What the agents will discuss`); `Lead` — две пилюли 38px (значок 14, `S03 ревью` 600, задача muted; выбранная — рамка `accent`, фон `neutral-100`), по умолчанию ведущая та, на которую бросили. `Cancel` / `Create room`.

### 1.7 Диалог «New workspace» (520px)

`Project` — сегмент проектов; `Agent` — сегмент провайдеров; `Title` (placeholder `Taken from the first prompt if empty`); `First prompt` — textarea от 96px, radius 16 (placeholder `What should the agent do?`); `Cancel` / `Create workspace`.

### 1.8 Прочие виды центра (есть в коде — перекрасить)

- **Не запущена**: карточка до 520px, padding 24, gap 12 — кикер `Not started` (`accent-700`), `S04 тесты · Платежи` Caprasimo 20px, задача 14px, мета — провайдер и путь брифа моноширинным, `Start session`.
- **Спит / закрыта**: кикер `Asleep` / `Closed` (`neutral-700`), последняя реплика агента или задача, `Claude Code · last event 3h ago`, `Resume`.
- **Нет вкладок**: `No open tabs` + `Open a session from the sidebar, or find anything with ⌘J.`
- **Почта**: `Mail`, подзаголовок `{workspace} · {n} unread` / `all read`; карточки до 640px: тег вида, `S03 ревью → you`, время, точка `accent-600` у непрочитанного, текст 14px.
- **Правый сайдбар** 320px (padding `2 12 8 4`, gap 14): сегмент `Files` / `Changes`; заголовки Caprasimo 17px; в Changes `+N` — `accent-2-700`, `−N` — `accent-700`, файлы пилюлями от 30px, главная кнопка `Commit all` → `Merge into main` → `Merged`.

### 1.9 Палитра ⌘J

Затемнение `neutral-900 45%` (тёмная `rgb(0 0 0 / .6)`) + blur 2px. Панель 720px, сверху `min(10%, 4rem)`, radius 28, фон `neutral-100`, `shadow-lg`. Поле — пилюля 48px, фон `surface`, 15px, placeholder `Search workspaces, sessions, tabs and actions`. Секции (заголовок 11px uppercase): без запроса — `Open tabs` (до 6), `Workspaces` (4); с запросом — `Tabs` (5), `Workspaces` (6), `Sessions` (8), `Actions` (6). Пункт padding `9 12`, radius 16: значок 16, заголовок 14/600, подпись 12px, `⌘1…⌘9` пилюлей. Ничего не нашлось — `Create workspace “{query}”`. Подвал 11px на `bg`: `↑↓ select · Enter open · ⌘1–9 pick · Esc close`. Новое действие: `New session or room`. Ранжирование — по спеке Orca-UI 9.2.

### 1.10 Уведомление

- **В окне** (окно в фокусе): справа снизу (right 16, bottom 40), 320px, radius 16, фон `neutral-100`, `shadow-lg`, padding `12 14` — значок вопроса 14, заголовок 700, текст 12px `neutral-700`, кнопки `Open` / `Later`; скрывается через 8 с. `Open` открывает цель.
- **Системное** (окно не в фокусе): по спеке Orca-UI 7.4, `FocusTarget { kind: 'room' }`, тег `proposal:{workKey}:{roomId}`.
- Тексты: `Decision waiting for you` / `{room} · S01 collected positions`; после переделки — `{room} · S01 revised the decision`.

## 2. Поведение

### 2.1 Сессия или комната

- Диалог 1.5 с одним агентом создаёт сессию (`sessions.create` с `model`, `effort`) и открывает её терминал.
- С двумя и больше — N сессий и комнату с ведущим (`rooms.create` с `lead`), открывает вкладку комнаты и разворачивает её строку. Сессии комнаты стартуют сразу, без задачи (тихий старт, `task: ''`, ярлык пустой — строка показывает `S05`): задачу человек пишет в комнату.
- Названия по умолчанию: комната `Room {n}`.

### 2.2 Разговор в комнате

- Enter — отправить, Shift+Enter — перенос, пустое не отправляется, вставка — только текст.
- Адресаты — упомянутые сессии; без упоминаний `to: []`, то есть всем (`recipientsOf`). Текст уходит с токенами `@s02`; лента рисует `@s-?\d+` чипом с ярлыком участника.
- Черновик хранится на комнату (`{workKey}/{roomId}`) и переживает смену вкладок и работ до перезапуска окна.

### 2.3 Упоминания

- Меню открывается, когда перед курсором стоит `@` (в начале строки или после пробела / переноса) и за ним до 24 знаков без пробела.
- Фильтр — подстрока без учёта регистра в `S02 s02 {label} {provider name} {model}`.
- ↑/↓ — выбор по кругу, Enter или Tab — вставить, Esc — закрыть; наведение выделяет, клик вставляет (на `mousedown`, чтобы не терять фокус редактора).
- Вставка заменяет `@запрос` нередактируемым чипом и неразрывным пробелом, курсор ставится за пробел. Подпись `To …` обновляется по чипам.

### 2.4 Решение

1. Человек пишет в комнату с ≥2 участниками без упоминаний. Письмо будит всех (существующий будильник).
2. Участники высказываются в комнате (`send_message(room)`), ведущий собирает позиции.
3. Ведущий зовёт `propose_decision(room, text)`. Харнесс кладёт решение в `Room.proposal`. Повторный вызов до ответа человека заменяет текст, `rev + 1`.
4. Окно: карточка решения, подкрашенные строка комнаты и вкладка, ранг «нужен ты», уведомление (1.10).
5. `Accept` → `rooms.resolveProposal(accept)`: решение становится сообщением `decision` от ведущего, добавляется системное `You accepted the decision`, `proposal = null`, ведущему уходит письмо о принятии. Ведущий раздаёт части упоминаниями, участники отчитываются в комнате ведущему.
6. `Return for rework` → заметка → `Send to lead` → `rooms.resolveProposal(return, note)`: письмо человека ведущему `Returned for rework: {note}` (без заметки `Returned for rework.`), `proposal = null`. Ведущий дорабатывает и снова зовёт `propose_decision`.

Пока решение ждёт, новое письмо человека всем цикл не перезапускает.

### 2.5 Перетаскивание в сайдбаре

Только внутри одной работы; бросок в раскладку (спека Orca-UI 5.4) работает как раньше. В окне сессия состоит максимум в одной комнате.

- Сессию на другую сессию → диалог 1.6. После создания обе уходят из прежних комнат, системное сообщение `Room created from @s03 and @s02`.
- Сессию на строку комнаты, где её нет → `rooms.addMember`: сессия уходит из прочих комнат работы, системное сообщение `@s04 joined the room`, строка комнаты разворачивается.
- Цель подсвечивается фоном `accent 14%` и inset-рамкой 1.5px `accent`. На себя и в свою комнату бросить нельзя.

### 2.6 Развёртывание строки комнаты

По умолчанию развёрнута, если в активной работе открыта вкладка комнаты или одного из её участников. Ручной шеврон перекрывает правило до перезапуска окна. Клик по строке открывает комнату; клик по уже открытой развёрнутой — сворачивает.

### 2.7 Внимание

- Комната с ждущим решением — ранг 4 «нужен ты», как `blocked` (спека Orca-UI 7.1); значок карточки — вопрос. Непрочитанная почта человеку — ранг 3.
- Порядок в группе: `done` внизу, затем ранг по убыванию, свежесть, `createdAt`. Группы — по высшему рангу, затем по имени.
- «Следующая, где нужен ты» (палитра, счётчик строки статуса): сначала сессии `blocked`, потом комнаты с решением, потом `unseen` — в порядке сайдбара, по кругу от текущей вкладки.
- Просмотр: `unseen`-сессия, непрочитанное в комнате или почте гаснет через 1.2 с на активной вкладке (`activity.seen`, `mail.markRead`), в остальном — правило спеки Orca-UI 7.2.

### 2.8 Клавиши

⌘J палитра, ⌘B левый сайдбар, ⌘L правый, ⌘1–9 — работа по порядку сайдбара (не в диалоге и не в палитре), ⌘T — диалог 1.5, ⌘N — 1.7, Esc закрывает диалог. В палитре ↑/↓, Enter, ⌘1–9. История назад/вперёд — 50 записей, закрытые вкладки пропускаются.

## 3. Данные и протокол

Все добавления совместимые: `PROTOCOL_VERSION` остаётся 1, новые методы попадают в `hello.methods`, окно прячет функцию, если метода нет (спека Orca-UI 3.2).

### 3.1 core: `work/types.ts`

```ts
interface Room {
  // id, title, creator, members, createdAt — как сейчас
  lead: string | null;        // id ведущего; null — первый из members
  proposal: Proposal | null;  // решение ждёт человека
}
interface Proposal {
  id: string;                 // p-<n>, не переиспользуется
  from: string;               // ведущий
  text: string;               // 1..10000, токены @s02
  rev: number;                // 0, +1 на каждую переделку
  at: string;
}
```

`parseMap` подставляет старым картам `lead: null`, `proposal: null`. Решение — изменяемый слот комнаты, а не письмо: лента остаётся лентой фактов, факты (`decision`, заметка возврата, системные сообщения) дописываются при ответе человека.

### 3.2 protocol: методы

```ts
'rooms.create':          { /* как сейчас */ lead?: string;                  // по умолчанию members[0]
                           origin?: [string, string]; quiet?: boolean }
                         // origin — две сессии, из которых собрана комната (диалог 1.6): хост пишет
                         // системную строку `Room created from @s03 and @s02`; обе — из members
                         // quiet — тихий старт (диалог 1.5): без писем-приглашений, лента пуста
'rooms.addMember':       { projectPath; workId; roomId; sessionId } → { messageId }
                         // сессия уходит из прочих комнат работы; системное сообщение. Уже участник
                         // и нигде больше — bad_request; состоящая и в других комнатах (старая карта)
                         // остаётся в этой одной
'rooms.resolveProposal': { projectPath; workId; roomId; proposalId;
                           action: 'accept' | 'return'; note?: string /* 0..4000 */;
                           rev?: number } → { messageId }
                         // conflict, если proposalId устарел или rev (версия показанной карточки,
                         // Proposal.rev) не совпал: ведущий успел заменить текст. Окно шлёт rev
'sessions.create':       { /* как сейчас */ model?: string; effort?: 'low' | 'medium' | 'high' }
```

`model` и `effort` передаются через реестр провайдеров (`core/src/providers.ts`). Если провайдер их не поддерживает, поле отбрасывается, а окно прячет контрол: `providers.list` отдаёт `models: string[] | null` и `effort: boolean`. Какой флаг CLI несёт усилие — решить по документации провайдера, не угадывать.

Поля `models`, `effort` и `version` у элемента `providers.list` необязательны, как `hello.methods`: хост переживает окно, и новое окно может получить элементы без них. Нет поля — «контрола нет», «версии нет». Ведущим считается назначенный `lead` (или первый из `members`), пока он жив; закрытого или удалённого подменяет первый живой участник (`liveLead` в `work/rooms.ts`). Комната закрыта, когда в ней нет ни одного живого участника: тогда нет и ведущего.

### 3.3 MCP

- `propose_decision(room, text)` — только ведущий комнаты; ошибка, если зовёт не ведущий или комната закрыта. Ответ `{ proposalId, rev }`.
- `create_room(title, members, lead?)`.
- Гид (`read_guide`), бриф и системная вставка. Ведущему: собрать позиции в комнате, предложить `propose_decision`, до принятия работу не начинать; после принятия раздать части упоминаниями; после возврата переделать и предложить снова. Участнику: на задачу для всех высказаться одним сообщением, ждать своей части, отчитываться в комнате ведущему.

### 3.4 Состояние окна

- `store/ui.ts`: `roomExpanded: Record<roomKey, boolean>`, `composerDrafts: Record<roomKey, string>` — только в памяти.
- Диалог 1.5: `{ workKey, title, leadKey, members: Array<{ key, provider, model, effort }> }`.
- Диалог 1.6: `{ workKey, a, b, title, lead }`.

### 3.5 Лимиты подписок

Решение пользователя 2026-09-29. Окно показывает расход лимитов подписки только по
данным, которые отдают сами CLI. Учётные данные не читаются: ни Keychain, ни
`~/.claude/.credentials.json`, ни `~/.codex/auth.json`. Эндпоинты использования
провайдеров не вызываются. Скрытых процессов агентов нет.

- **Claude Code — строка статуса.**
  - Харнесс добавляет ключ `statusLine: { type: 'command', command: <скрипт харнесса> }`
    в свой файл настроек, который уже передаёт агенту флагом `--settings` рядом с
    хуками (`core/work/settings-file.ts`). В `~/.claude` ничего не пишется.
  - Claude Code зовёт скрипт с JSON на stdin (документация
    `code.claude.com/docs/en/statusline`). У подписок Pro и Max после первого ответа
    модели в нём есть `rate_limits.five_hour` и `rate_limits.seven_day`:
    `used_percentage` (0–100) и `resets_at` (Unix-секунды). Окна могут отсутствовать
    по отдельности; окно с прошедшим `resets_at` Claude Code отбрасывает сам.
  - Скрипт делает две вещи:
    1. Если `rate_limits` есть, атомарно пишет `{ at, rateLimits }` в файл сессии в
       каталоге работы.
    2. Печатает строку статуса терминала. Если у человека свой `statusLine` в
       настройках Claude Code (`~/.claude/settings.json` или настройки проекта; только
       чтение), скрипт вызывает его команду с тем же stdin и печатает её вывод — строка
       в терминале остаётся прежней. Иначе печатает короткую строку: модель и процент
       контекста.
  - Скрипт быстрый, потому что Claude Code зовёт его часто. Сети он не касается, его
    ошибки не роняют строку статуса.
- **Codex — логи сессий.** В `~/.codex/sessions/**/rollout-*.jsonl` событие
  `event_msg` с `payload.type: 'token_count'` несёт `rate_limits.primary` и
  `rate_limits.secondary`: `used_percent`, `window_minutes` (300 — 5 часов, 10080 —
  неделя), `resets_at`. Хост берёт последнее такое событие самого свежего лога. Только
  чтение, как остальные логи Codex.
- **Хост.**
  - Держит последнее значение на провайдера: у Claude — самое свежее по `at` среди
    сессий, у Codex — по логу.
  - Отдаёт окну добавлением в протокол: у элемента `providers.list` новое поле
    `limits: { fiveHour: LimitWindow | null, week: LimitWindow | null, at: string } | null`,
    где `LimitWindow = { usedPercent: number, resetsAt: string }`. Плюс событие
    `providers.limitsChanged`.
  - Окно с прошедшим `resetsAt` не отдаётся.
- **Окно — строка статуса (1.1).**
  - В сегменте провайдера после версии: полоска — пятичасовое окно, текст
    `58% 5h · 41% wk`. Есть только одно окно — показывается оно одно.
  - Тултип: `5-hour window resets at {time} · Weekly window resets {day} {time} ·
    Updated {time}`.
  - От 80% в любом окне текст и полоска — цвета `accent-700`.
  - Нет данных — в сегменте только значок, имя и версия.
- **Свежесть.** Числа обновляются, только пока агент работает: у Claude — когда CLI
  зовёт строку статуса, у Codex — после хода. Поэтому в тултипе всегда
  `Updated {time}`.

## 4. Токены

Источник — `prototype/_ds/organic-…/styles.css` (светлая) и объект `DARK` в прототипе (тёмная). В `renderer/styles/tokens.css` положить `:root` и `.dark`, переменные shadcn выразить через них.

```css
:root {
  --color-bg: #f5ead8; --color-surface: #ebddc5; --color-text: #201e1d;
  --color-accent: #c67139; --color-accent-2: #7a8a5e;
  --color-divider: color-mix(in srgb, #201e1d 16%, transparent);
  --color-neutral-100: #f9f4ed; --color-neutral-200: #eee7db; --color-neutral-300: #dcd3c4;
  --color-neutral-400: #c0b6a5; --color-neutral-500: #a19786; --color-neutral-600: #82796a;
  --color-neutral-700: #645c50; --color-neutral-800: #474238; --color-neutral-900: #2e2b25;
  --color-accent-100: #fff2eb; --color-accent-200: #ffe1d0; --color-accent-300: #ffc6a5;
  --color-accent-400: #f6a06b; --color-accent-500: #d67f48; --color-accent-600: #b2622d;
  --color-accent-700: #8c491a; --color-accent-800: #643312; --color-accent-900: #402310;
  --color-accent-2-100: #f0fae1; --color-accent-2-200: #e1eecc; --color-accent-2-300: #ccdbb2;
  --color-accent-2-400: #aebf92; --color-accent-2-500: #8fa073; --color-accent-2-600: #728157;
  --color-accent-2-700: #56633f; --color-accent-2-800: #3d472b; --color-accent-2-900: #272e1b;
  --shadow-sm: 0 1px 2px color-mix(in srgb, #2e2b25 14%, transparent);
  --shadow-md: 0 3px 10px color-mix(in srgb, #2e2b25 16%, transparent);
  --shadow-lg: 0 12px 32px color-mix(in srgb, #2e2b25 22%, transparent);
  --sheet: #f9f4ed;                 /* лист центра = neutral-100 */
  --scrim: color-mix(in srgb, #2e2b25 50%, transparent);   /* палитра — 45% */
}
.dark {  /* рампы перевёрнуты: 100 — самый тёмный */
  --color-bg: #0e0d0c; --color-surface: #161513; --color-text: #ece6dc;
  --color-accent: #d67f48; --color-accent-2: #8fa073;
  --color-divider: color-mix(in srgb, #ece6dc 14%, transparent);
  --color-neutral-100: #23211e; --color-neutral-200: #2c2926; --color-neutral-300: #3b3732;
  --color-neutral-400: #524d46; --color-neutral-500: #6e675e; --color-neutral-600: #8b8479;
  --color-neutral-700: #a8a095; --color-neutral-800: #cbc4b9; --color-neutral-900: #e9e3d9;
  --color-accent-100: #2a1a10; --color-accent-200: #3a2314; --color-accent-300: #58341c;
  --color-accent-400: #8f5529; --color-accent-500: #c46d37; --color-accent-600: #dc8753;
  --color-accent-700: #eea373; --color-accent-800: #f8c39f; --color-accent-900: #fde2cf;
  --color-accent-2-100: #1b2014; --color-accent-2-200: #242b1a; --color-accent-2-300: #343e25;
  --color-accent-2-400: #52603b; --color-accent-2-500: #7d8f5f; --color-accent-2-600: #9aad7b;
  --color-accent-2-700: #b5c697; --color-accent-2-800: #d0ddb7; --color-accent-2-900: #e7efd8;
  --shadow-sm: 0 0 0 1px color-mix(in srgb, #ece6dc 9%, transparent), 0 1px 2px rgb(0 0 0 / .5);
  --shadow-md: 0 0 0 1px color-mix(in srgb, #ece6dc 9%, transparent), 0 4px 12px rgb(0 0 0 / .5);
  --shadow-lg: 0 0 0 1px color-mix(in srgb, #ece6dc 10%, transparent), 0 12px 32px rgb(0 0 0 / .6);
  --sheet: #0b0a09;
  --scrim: rgb(0 0 0 / .6);
}
```

**Переменные shadcn** (обе темы):

| Переменная | Значение |
|---|---|
| `--background` | `surface` — фон окна |
| `--foreground` | `text` |
| `--card`, `--popover` | `neutral-100` — активная карточка, активная вкладка, палитра, меню, уведомление |
| `--primary` / `--primary-foreground` | `accent` / `bg`; hover `accent-600`, active `accent-700` |
| `--secondary`, `--muted` | `neutral-200` |
| `--muted-foreground` | `neutral-700` |
| `--accent` / `--accent-foreground` | `text 9%` / `text` — выбранная строка |
| `--destructive` | тёмная — `accent-700`, светлая — `accent-800`: по решению 1 главная кнопка светлой темы — `accent-700`, и кнопка удаления на нём слилась бы с ней, а `Discard` и `Delete` должны от неё отличаться |
| `--border`, `--input` | `divider` |
| `--ring` | тёмная — `accent`, светлая — `accent-600`: чистый `accent` к фону окна 2.69:1, ниже 3:1 для признака состояния, `accent-600` — 3.35:1. Фокус — `outline: 2px solid; outline-offset: 2px` |
| `--work-sidebar`, `--sidebar` | `surface` (у сайдбаров нет своего фона) |
| `--work-sidebar-accent` | `text 9%` |
| `--agent-question` | `accent-600` |
| `--status-success` | `accent-2-600` — значки и заливки; цвет текста — `--status-success-text` = `accent-2-700` (`accent-2-600` даёт 3.14:1 на фоне окна светлой, `accent-2-700` — 4.82:1) |
| `--radius` | 16px |

`tokens.test.ts` читает hex из `tokens.css`: либо писать hex прямо в переменные shadcn, либо научить тест разворачивать `var()` и `color-mix()`. Порог 4.5:1 для вторичного текста остаётся. Замеры: `neutral-700` на `surface` 4.9:1, на `neutral-100` 6.0, на `accent-200` 5.3, на `accent-2-200` 5.4, на выбранной строке активной карточки 5.1; тёмная тема — от 4.88 (выбранная строка активной карточки; на `surface` 7.1, на `neutral-100` 6.2).

**Цвет проекта** — хеш `projectPath` по ступеням 400: `accent-400`, `accent-2-400`, `neutral-400` (прототип показывает первые два).

**Радиусы**: `--radius-sm` 8, `--radius-md` 16 (карточки работ, пункты палитры), `--radius-lg` 28 (лист центра, палитра); диалоги 32px (`28 × 1.15`); кнопки, поля, теги, сегменты — 999px.

**Отступы** (плотность 1.1×): 4.4 / 8.8 / 13.2 / 17.6 / 26.4 / 35.2 px.

**Компоненты Organic** (перенести в примитивы `renderer/ui/`):
- `button`: Caprasimo 14px/1.2, padding `8.8px 15.84px`, пилюля, gap 6. Primary — фон `accent`, текст `bg`. Secondary — рамка `divider`, hover `text 7%`, active `text 14%`. Disabled — opacity .45.
- `input` / `textarea`: min-height 36, padding `6px 14px`, 14px, фон `surface`, рамка `divider`, пилюля (textarea — radius 16, от 90px); hover рамка `text 45%`, фокус рамка и caret — `--ring`.
- `field label`: 12px, `text 70%`, отступ снизу 5.
- сегмент: рамка `divider`, пилюля; опция padding `7px 12px`, 13px, разделитель `divider`; выбранная — фон `--primary` (светлая — `accent-700`, тёмная — `accent`; текст `bg` на чистом `accent` светлой 3.03:1, ниже порога, решение 1), текст `bg`; hover `text 7%`.
- `tag`: 11px, letter-spacing .02em, padding `3px 10px`, пилюля; `accent` — фон `accent-100`, текст `accent-800`; `accent-2` — `accent-2-100` / `accent-2-800`; `neutral` — `neutral-100` / `neutral-800`.
- `card`: фон `surface`, radius 32, padding 13.2, gap 8.8; kicker 10px uppercase .1em; title Caprasimo 17px/1.2 (в пустых состояниях 20px).
- `dialog`: фон `surface`, radius 32, padding 17.6, gap 13.2, `shadow-lg`; заголовок Caprasimo 20px; кнопки справа, gap 8.8, отступ сверху 8.8; затемнение `--scrim`.
- `::selection` — `accent 30%`.

**Типографика**
- Текст — Figtree (веса 400, 500, 600, 700); база окна 13px/1.4. Заголовки и кнопки — Caprasimo 400. Моноширинный (ветки, пути, версии, терминал) — `'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace`.
- Шкала: 10 — сочетания, время; 11 — мета, слова состояний, подписи секций (600, uppercase, .06em); 12 — вкладки, строки, мета ленты; 13 — навигация, заголовок карточки; 14 — текст ленты, поля; 15 — поле палитры, имя проекта (Caprasimo); 17 — заголовки правого сайдбара; 20 — заголовки диалогов и пустых состояний; 25 — название комнаты и почты.
- Шрифты положить в `renderer/assets/fonts/` (Figtree variable, Caprasimo, обе OFL 1.1 — лицензии рядом). Грузить из Google Fonts нельзя: окно не ходит в сеть.

**Иконки** — lucide-react, `strokeWidth={2.75}` у всех. Использованы: Search, Plus, X, PanelLeft, PanelRight, ArrowLeft, ArrowRight, ChevronDown, MessageCircleQuestion, CircleCheck, CircleX, Moon, Mail, Hash, GitBranch, AlarmClock, Folder, File, User. Размеры: 15 заголовок, 14 навигация, 16 поле палитры, 13 группы и шевроны, 12 значки состояний и бейджи, 11 ветка и «+» в карточке, 10 крестик вкладки.

**Терминал.** Фон, текст и курсор xterm — `--sheet` и `text`, выделение — `accent 30%`; ANSI-палитры остаются по спеке Orca-UI 4.7. В прототипе есть второй светлый лист «Espresso» (фон `neutral-900`, текст `neutral-100`, muted `neutral-400`) — по желанию, в настройках «Вид».

## 5. Ассеты

- `prototype/assets/claude.svg`, `codex.svg`, `codex-light.svg` (Codex для тёмной темы) — значки провайдеров из прототипа. Перед включением в сборку проверить лицензию бренда (спека Orca-UI 4.6); без неё — буквенный значок `AgentIcon`.
- Фото и прочей графики нет.

## 6. Открытые вопросы

1. **Контраст главной кнопки.** Текст `bg` на `accent` — 3.0:1 (система допускает 3:1 для крупного текста и хрома). Для 4.5:1 нужен фон `accent-700`. По умолчанию — как в прототипе.
2. **Hover неактивной карточки** (`text 6%` на `surface`) даёт `neutral-700` 4.4:1; `text 5%` — 4.47:1, тоже ниже порога. Решено: `text 4%` (4.56:1), см. решение 2.
3. **Строка статуса.** Прототип рисует только провайдеров. Сегменты спеки Orca-UI 5.9 (связь с хостом, счётчики внимания, `host.notice`, будильник) по умолчанию оставить справа от провайдеров.
4. **Одна комната на сессию.** Сайдбар держится на этом правиле; core сейчас его не требует. `rooms.addMember` и `rooms.create` проводят его на хосте.
5. **Флаг усилия** у Claude Code и Codex — по документации CLI; пока нет подтверждения, контрол скрыт.

## 7. Файлы

- `README.md` — этот документ.
- `TASKS.md` — порядок реализации кусками с критериями готовности.
- `prototype/Harnas Window v2.dc.html` — прототип: разметка сверху, логика в `<script data-dc-script>` (`seed()` — данные, `cardVals` / `roomRow` — сайдбар, `renderVals` — всё остальное, `afterHumanMessage` / `acceptProposal` / `returnProposal` — симуляция решения, `composerKey` / `pickMention` / `serializeEditor` — упоминания).
- `prototype/support.js` — рантайм прототипа, в продукт не переносится.
- `prototype/_ds/organic-160db661-cdda-445e-92e5-f03bd486fce2/styles.css` — токены и классы Organic; `_ds_bundle.js` — рантайм системы для прототипа.
- `prototype/assets/*.svg` — значки провайдеров.
- `screenshots/` — состояния прототипа (924×540): `dark-01…14` — уведомление, терминал с разрешением, палитра, решение ждёт, возврат на доработку, меню упоминаний, чип в поле, решение принято, отчёты агентов, комната человека, диалоги новой сессии / комнаты / комнаты из двух / работы; `light-01…02` — светлая тема. Лента в снимках прокручена к низу; лимиты подписки в строке статуса — по §3.5. В диалоге новой комнаты select показывает первую работу — баг прототипа, по умолчанию выбрана активная.
