# План: доска комнаты и цвет агента

> **Исполнителю:** прочитай разделы «Global Constraints» и «Решения, принятые при планировании», затем только свою задачу. Шаги задачи — флажки `- [ ]`, иди по порядку. Чужих файлов не трогай; если задача без них не делается, остановись и напиши ведущему.

**Goal:** В комнате появляется вид Board: пункты плана стоят карточками в колонках по состоянию, видно, какой агент чем занят и где нужен человек. У каждой сессии агента появляется свой цвет — кольцо вокруг значка провайдера во всём окне.

**Architecture:** Меняется только окно (`packages/desktop`). Доска — чистая функция от плана комнаты, карты работы, участников и живой активности: `room-board-model.ts` считает колонки и карточки, `room-board-activity.ts` — метки пунктов у участников и ленту событий. Правила плана берутся из `@parley/core/plan-state`. Вид Feed / Board хранится в раскладке у вкладки комнаты, как вид Chat / Terminal у вкладки сессии. В виде Board лента комнаты остаётся на месте и сохраняет раскладку, а доска ложится слоем поверх неё; отметка «прочитано» на это время отключается тем же способом, что у неактивной работы. Цвет агента выводится из номера сессии и нигде не хранится.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes: true`), React 18, zustand, Tailwind 4, Radix (обёртки в `renderer/ui`), vitest 2 + jsdom + @testing-library/react, Playwright + Electron.

**Spec:** `docs/specs/2026-11-17-room-board-design.md`. Макет: `docs/design/2026-11-17-room-board/index.html`. Человек 2026-11-17 велел строить план на этой спеке: всё делается сразу и выкладывается разом, этапы — только границы pull request.

**База:** ветка `feat/room-board` от свежего `origin/master`.
- Факты сверены с `origin/master` a8e55117 (2026-11-17). К концу рецензии master ушёл на 2a03b0bf: места в `packages/desktop` на месте, строки `core/work/types.ts` сдвинулись. Номера строк — ориентир, искать по имени.
- Короткие пути: `renderer/…` и `shared/…` — от `packages/desktop/src/`, `core/…` — от `packages/core/src/`.
- Спека, план и макет при исполнении лежали только в основной рабочей копии, вне git; в ветку они добавлены последним коммитом.
- Основная копия стоит на старой ветке и отстаёт от master на 1432 коммита. Рабочая копия сессии Parley создаётся от ветки основной копии (карточка `b-048`), поэтому базу задаёт ведущий явно (раздел «Как исполнять»).

Рецензия: s-464 (Codex, роль критика), 2026-11-17. Первое чтение — три блокирующих, семь существенных и пять мелких замечаний. Повторное — одно блокирующее и два существенных новых, четыре недоделанных прежних. Все учтены в этом тексте; правки после повторного чтения критик не перечитывал.

## Ход исполнения

Заполняет ведущий после каждой волны: что сделано, чем проверено, числа, коммиты.

| Волна | Задачи | Состояние |
|---|---|---|
| A | 1 ∥ 2 | Приняты. `4ca5aafd` (цвет агента), `65b2bcc8` (модель доски) |
| B | 3 ∥ 4 | Приняты. `481ca22c` (метки и события), `1e5e473b` (вид вкладки и переключатель) |
| C | 5 | Принята со второй сдачи: тест на Enter перенесён в сквозной сценарий. `1e40d537`, `685082ad` |
| D | 6 ∥ 8 | 6 — со второй сдачи: фокус уходил на карточку чужой комнаты (`5e2877fc`, `33f46248`); 8 — `eb4269d6` |
| E | 7 | Принята. `ada4f0c5` |
| F | 9, 10 | 10 — `b66f8a41`, затем `3045c4d9` (способ заменён); 9 — со второй сдачи: `cc3264cf`, `b0ec70b7`, `fcfc8b1b` |

Поправка 2026-11-17: сквозной сценарий задачи 9 показал, что в окне 800×500 колонкам доски не остаётся места. Добавлена задача 10 (пункт 10 плана комнаты, поправка p-61). Задача 9 заканчивает сценарий после неё; формальной зависимости в плане комнаты нет: Parley не принимает зависимость от пункта с большим номером.

Вторая поправка 2026-11-17: ведущий при чтении сданного пункта 10 нашёл, что способ задачи 10 (контейнерный запрос на корне панели) повторяет записанный в проекте дефект Chromium. Способ заменён замером высоты через `ResizeObserver`; ошибка в плане, не в работе исполнителя.

Итог 2026-11-17: все 10 пунктов приняты проверяющими, человек принял завершение плана. На `fcfc8b1b`: тесты окна — 541 файл и 10 966 тестов прошли, 4 файла и 30 тестов пропущены; `pnpm typecheck` и `pnpm lint` без ошибок; сквозной сценарий Electron — 4 из 4. Снимки сценария: `docs/design/2026-11-17-room-board/shots/`. Найденное и не исправленное — карточка `b-050` (в низком окне полная шапка, возможно, видна один кадр).

## Решения, принятые при планировании

Спека говорит, что должно получиться; здесь — как именно, там, где спека оставляет выбор.

| Вопрос | Решение |
|---|---|
| Геометрия кольца | Обёртка ровно в размер значка с контуром (`outline`) 1,5 px и отступом 2 px, скругление полное. Контур не входит в размер элемента, поэтому раскладка строк не меняется нигде |
| Приглушение кольца | Атрибут `data-agent-icon` при кольце переезжает со значка на обёртку. Правило `renderer/styles/dimmed.css:23` тогда приглушает кольцо и значок один раз; сам файл не правится |
| Имена токенов | `--agent-colour-0` … `--agent-colour-7`. Префикс `--agent-` занят токеном `--agent-question` |
| Сессии, которой нет в карте | Цвета не получает нигде: ни кольца у значка, ни полосы на карточке |
| Поле вида вкладки | У вкладки комнаты `view?: 'board'` в сохранённой раскладке: поля нет — Feed. В `TabPatch` новое поле `roomView`, чтобы не смешивать с `view` вкладки сессии |
| Лента в виде Board | Остаётся отрисованной и занимает своё место, доска ложится непрозрачным слоем поверх. Все расчёты прокрутки ленты работают как раньше. Лента получает `inert`, а отметка «прочитано» отключается через `active` у `useMarkRead` — так же, как у неактивной работы (`renderer/attention/use-mark-read.ts:115`). Поле ввода и плашка ответа на это время не рисуются: поле регистрирует себя целью перетаскивания карточек и целью ввода по своей геометрии (`renderer/components/rooms/Composer.tsx:116-122`) и под слоем доски перехватывало бы их. Черновик лежит в сторе и сохраняется |
| Метка пункта у участника | Во второй строке карточки участника, перед строкой занятия. В первой строке места нет: там имя держит минимум `5ch`, а первой сжимается роль (`renderer/components/rooms/ParticipantStrip.tsx:4-5`) |
| Слово состояния агента | `sessionWord` (`renderer/lib/session-word.ts:21`) по сессии из карты и живой активности — то же слово, что на доске проекта, и для сессий вне комнаты |
| Модель | Два файла: карточки и колонки отдельно, метки и события отдельно. Так задачи 2 и 3 маленькие, а 3 и 4 идут параллельно |
| Строки | Весь блок `S.roomBoard` заводит задача 2. Остальные задачи `shared/strings.ts` не трогают |
| Кто владеет панелью пункта | `RoomPanel`: у него мост, переход к сессии и лента. Доска только сообщает номер нажатого пункта |
| Панель пункта | На `renderer/ui/dialog.tsx`. Содержимое — значок и подпись исполнителя и тело строки пункта из списка плана, вынесенное в компонент, с раскрытым блоком подробностей |
| Проверяет человек | Пункт Verified-плана с проверяющим `human` в In review показывает «Submitted · waiting for you» и считается ждущим человека (спека 5.5, 5.6) |
| Текст остановки плана | `S.plans.haltNotice(detail)` — тот же, что в ленте (`renderer/components/rooms/RoomPanel.tsx:598`). Своей таблицы причин доска не заводит |
| Данные карточки доски проекта | Необязательное поле `plan` в `TargetInfo` (`renderer/board/target-info.ts:18`); у цели-сессии и комнаты без подходящего плана его нет |
| Границы pull request | PR 1 — задача 1 (цвет агента). PR 2 — задачи 2–5 (доска видна). PR 3 — задачи 6–9 (панель пункта, движение, доска проекта, метки, приёмка). Все три идут в `feat/room-board`; в master она уходит одним PR после приёмки человеком |

## Global Constraints

- Меняется только `packages/desktop`. Исключение — `CHANGELOG.md` в задаче 9. Если задача упирается в core, хост или протокол — остановиться и написать ведущему.
- Подписи в окне — по-английски, только из `S` в `shared/strings.ts`. Страж `packages/desktop/src/english-ui.test.ts` запрещает кириллицу в строковых литералах `src`. Комментарии и названия тестов — на языке соседнего кода; в новых файлах `renderer/components/rooms/board/` — по-русски.
- Из `@parley/core` окно импортирует типы из корня пакета, значения — только из подпутей (`@parley/core/plan-state`, `@parley/core/attention`, `@parley/core/session-state`).
- Подпись, слово состояния и ход плана берутся из существующих функций: `sessionRowLabel` (`renderer/lib/participant.ts:68`), `sessionWord` (`renderer/lib/session-word.ts:21`), `ownerLabel` (`renderer/components/rooms/PlanPanel.tsx:332`), `planProgress` (`PlanPanel.tsx:49`). Свои слова для тех же состояний не заводить.
- «Пункт выполнен», «пункт готов», «кому действовать» — только `planItemSatisfied`, `planItemReady`, `planItemDuties` из `@parley/core/plan-state`.
- Необязательный проп, которого может не быть, передаётся условным разворотом, а не значением `undefined`: `{...(x === undefined ? {} : { x })}`. Образцы — `PlanPanel.tsx:500`, `renderer/components/rooms/RoomHeader.tsx:67`.
- Новые пропы существующих компонентов — необязательные, с прежним поведением по умолчанию: тесты соседних задач и чужие места вызова править не придётся.
- Живое состояние сессии: `activityFor(byRef, { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId })` (`renderer/store/activity.ts:64`) отдаёт запись; объект активности — её поле `activity`, слово состояния — `activity.activity`. Образец — `renderer/board/target-info.ts:28-36`.
- Вкладка комнаты с видом должна разбираться `parseTabSpec` (`renderer/layout/tree.ts:646`): сегодня разбор молча выбрасывает лишние поля, и выбор Board терялся бы при восстановлении раскладки.
- Тесты окна: без jest-dom, `cleanup` вручную, проверки через `toBeTruthy`, `toBeNull`, `getAttribute`. Сторы сбрасываются `setState` в `beforeEach`. Образец — `renderer/components/rooms/PlanPanel.test.tsx:1-75`.
  - Фикстуры: `makeWork`, `makeSession`, `makeRoom`, `makeActivity`, `makeNeed`, `activityMap` (`renderer/test-utils/work-fixtures.ts`), `autonomousRoomPlan` (`renderer/test-utils/autonomous-plan.ts`).
  - У `makeWork` нет поля планов: план кладётся после, `entry.map.plans = [plan]`. `makeRoom(id, title)` дополняется разворотом: `{ ...makeRoom('r-01', 'Delivery'), members: [...], lead: 's-01' }`.
  - Typecheck окна тесты не проверяет (`packages/desktop/tsconfig.web.json` их исключает), а запуск тестов типы не сверяет. Ошибку типов в тесте не поймает ни одна команда: сигнатуры в тестах сверять по коду.
- В eslint нет плагина react-hooks, подчёркивание в деструктуризации не игнорируется, действует `prefer-const`.
- Визуальные проверки — в окне 800×500, с длинным названием пункта и длинной подписью сессии, в обеих темах.
- Команды:
  - тесты: `pnpm --filter @parley/desktop exec vitest run <файлы>`;
  - typecheck окна: `pnpm --filter @parley/desktop typecheck` (при свежей рабочей копии сначала `pnpm typecheck` из корня: он собирает зависимости);
  - eslint: `pnpm lint`;
  - тяжёлые команды — по одной и после `uptime`: при load average за минуту ≥ 8 ждать.
- Коммиты — по-английски, с явными путями, по одному на задачу; у задачи 9 их два. Push и pull request — только по слову человека. Описание PR несёт карточку влияния (`PARLEY.md`).
- Известные красные тесты master, которые чинить не надо: e2e `restart-host.spec.ts` (`b-017`) и `chat-view.spec.ts` (`b-018`); `core/src/mcp/server.test.ts` внутри сессии агента (`b-020`); `host/src/methods/providers.test.ts` и `core/src/work/launch.test.ts` на этой машине, e2e острова (`b-046`); нестабильный `assistant-service.test.ts` (`b-040`).

## Review Focus

1. **Лента под доской.** В виде Board видимое письмо не отмечается прочитанным, черновик и место прокрутки целы, до ленты не доходит Tab, а карточка, брошенная на комнату, не попадает в невидимое поле ввода; после возврата в Feed всё работает как раньше. Тесты — в задачах 4 и 9.
2. **Раскладка.** Старая раскладка без поля и раскладка с незнакомым значением открывают Feed и остаются валидными; вид Chat / Terminal у вкладки сессии не затронут; вид Board переживает сохранение и чтение. Тесты — в задаче 4.
3. **Автономный план.** `returned` и `blocked` стоят в In progress при любой попытке; проверяющий получает метку уже при попытке `submitted`; остановленный план меток не даёт. Тесты — в задачах 2 и 3.
4. **Человек не пропускает своё.** При ждущем решении и при остановленном плане над колонками стоит уведомление; пункт, где сессия ждёт человека или проверяет человек, стоит первым в колонке, даже если он ещё и заблокирован. Тесты — в задачах 2 и 5.
5. **Кольцо.** Не сдвигает раскладку, приглушается один раз, держит 3:1 на всех фонах, не обрезается контейнерами, не достаётся сессии вне карты. Тесты — в задаче 1, снимки — в задаче 9.

---

## Порядок исполнения

| Волна | Задачи | Файлы | После волны |
|---|---|---|---|
| A | 1 ∥ 2 | значок, токены, четыре места вызова ∥ `strings.ts`, `PlanPanel.tsx`, модель | тесты задач 1–2, typecheck окна, eslint. **PR 1** — задача 1 |
| B | 3 ∥ 4 | `room-board-activity.ts` ∥ раскладка, `RoomBody.tsx`, `RoomPanel.tsx`, `RoomHeader.tsx` | тесты задач 3–4, typecheck окна |
| C | 5 | `RoomBoard.tsx`, `RoomBoardCard.tsx`, `RoomPanel.tsx` | тесты задачи 5, typecheck, eslint. **PR 2** — задачи 2–5 |
| D | 6 ∥ 8 | панель пункта, `PlanPanel.tsx`, `RoomPanel.tsx` ∥ `RoomBoard.tsx`, `use-card-motion.ts` | тесты задач 6 и 8 и списка плана, typecheck |
| E | 7 | доска проекта, `ParticipantStrip.tsx`, `RoomHeader.tsx`, `RoomPanel.tsx` | тесты задачи 7, typecheck |
| F | 9 | e2e, CHANGELOG | итоговая проверка. **PR 3** — задачи 6–9 |

В одной волне задачи не делят файлов. `RoomPanel.tsx` правят задачи 4, 5, 6 и 7 — строго по очереди.

## Как исполнять

Оба способа дают младшей модели одну задачу за раз. Ревью на границе каждого PR делает старшая модель (роль `builtin:reviewer`).

**Способ А — субагенты в одной рабочей копии (так исполнены планы доски проекта).**
1. Ведущий создаёт рабочую копию: `git fetch origin && git worktree add .claude/worktrees/room-board -b feat/room-board origin/master`.
2. Каждая волна — субагенты на Sonnet, по одному на задачу, с текстом «Global Constraints», «Решений» и своей задачи. Исполнители пишут файлы и тесты, но тесты, typecheck, eslint не запускают и не коммитят: в общей копии соседняя задача ещё не дописана. Шаг «Проверка» своей задачи они пропускают.
3. После волны ведущий гоняет проверки из таблицы порядка, чинит мелочи отдельным исполнителем, коммитит по задаче и заполняет «Ход исполнения».

**Способ Б — комната в режиме Verified.**
1. Участники: ведущий (старшая модель), два исполнителя `builtin:executor` на Sonnet (E1, E2), проверяющий `builtin:verifier`.
2. Ведущий создаёт ветку `git branch feat/room-board origin/master` и держит её в своей рабочей копии.
3. Каждый исполнитель первым действием в своей рабочей копии делает `git merge --ff-only feat/room-board`, после сдачи предыдущей волны — снова. Сам запускает тесты своей задачи и typecheck, коммитит в свою ветку. Ведущий вливает принятую ветку в `feat/room-board`.
4. Пункты плана комнаты:

| Пункт | Задача | Исполнитель | После |
|---|---|---|---|
| 1 | Task 1 | E1 | — |
| 2 | Task 2 | E2 | — |
| 3 | Task 3 | E2 | 2 |
| 4 | Task 4 | E1 | 2 |
| 5 | Task 5 | E1 | 1, 2, 4 |
| 6 | Task 6 | E1 | 5 |
| 7 | Task 7 | E1 | 1, 3, 6 |
| 8 | Task 8 | E2 | 3, 5 |
| 9 | Task 9 | E1 | 7, 8 |

Критерии пункта — шаги и правила задачи из этого плана; проверяющий у всех пунктов один.

Автономный режим комнаты для этого плана не берём: он на реальных агентах полный цикл не проходил.

---

### Task 1: цвет агента — правило, токены, кольцо у значка

**Files:**
- Create: `renderer/lib/agent-colour.ts`
- Test: `renderer/lib/agent-colour.test.ts`, новый `renderer/components/rooms/SenderAvatar.test.tsx`
- Modify:
  - `renderer/styles/tokens.css`, `renderer/styles/tokens.test.ts`;
  - `renderer/components/AgentIcon.tsx`, `renderer/components/AgentIcon.test.tsx`;
  - `renderer/components/rooms/SenderAvatar.tsx`, `RoomMessage.tsx`, `ParticipantStrip.tsx`, `MentionMenu.tsx`;
  - `renderer/sidebar/SessionRow.tsx`.

**Interfaces:**
- Consumes:
  - `AgentIcon` и его два вида, картинка и буква (`renderer/components/AgentIcon.tsx:97-131`);
  - помощники теста токенов `THEMES`, `NON_TEXT`, `solid`, `on`, `contrastRatio` (`renderer/styles/tokens.test.ts:39-53`) и запись фонов сайдбара `STATE_ICON_BACKGROUNDS` (`:325-331`);
  - образец цвета без хранения: `projectColor` (`renderer/lib/project-color.ts:28`).
- Produces:
  ```ts
  // renderer/lib/agent-colour.ts
  export const AGENT_COLOUR_COUNT = 8;
  /** Номер цвета 0..7 по номеру сессии `s-<N>`; `null` — у любого другого идентификатора. */
  export function agentColourIndex(sessionId: string | null | undefined): number | null;
  /** `var(--agent-colour-3)` либо `null`, если цвета нет. */
  export function agentColourVar(sessionId: string | null | undefined): string | null;

  // AgentIcon.tsx — новый необязательный проп
  export interface AgentIconProps { provider: string; size?: number; label?: string; sessionId?: string | null }
  // SenderAvatar.tsx — новый необязательный проп
  export interface SenderAvatarProps { /* прежние поля */ sessionId?: string | null }
  ```
- Правила:
  - **Номер.** Идентификатор вида `/^s-(\d+)$/` → `N % 8`. Всё остальное (`human`, `engine`, пустая строка, `null`) → `null`.
  - **Имя токена.** `agentColourVar` возвращает одну из восьми буквальных строк из массива (`'var(--agent-colour-0)'` …), не склейку: страж `tokens.test.ts:699` ищет имена `var(--x)` в исходниках.
  - **Токены.** Восемь имён `--agent-colour-0` … `--agent-colour-7` отдельным блоком: в `:root` после `--state-done` (`tokens.css:284`), в `.dark` после `--state-done` (`:448`). Значения — из таблицы спеки 5.1, в том же порядке. Рампы палитры Organic не трогать.
  - **Кольцо.** Есть цвет — значок оборачивается в `<span>`:
    - размер ровно `size` × `size`, классы `inline-flex shrink-0 rounded-full`;
    - стиль: контур 1,5 px цвета агента, `outlineOffset` 2 px;
    - атрибуты `data-agent-icon=""` и `data-agent-colour="<номер>"`;
    - значок внутри рисуется как сегодня, но без `data-agent-icon`.
  - **Без цвета** разметка `AgentIcon` остаётся прежней до байта.
  - **Места вызова.** Добавить проп:
    - `SessionRow.tsx:337` — `sessionId={session.id}`;
    - `ParticipantStrip.tsx:62` — `sessionId={participant.id}`;
    - `MentionMenu.tsx:67` — `sessionId={member.id}`;
    - `RoomMessage.tsx:183` — `sessionId={message.fromId}` в `SenderAvatar`.
  - **`SenderAvatar`** передаёт `sessionId` в `AgentIcon`, только когда отправитель — агент и его провайдер известен (`provider !== null`). У удалённой сессии, человека, помощника и системы кольца нет.
  - Если где-то кольцо обрезается контейнером с `overflow`, поправить отступ в этом месте и сказать об этом в отчёте; кольцо не убирать.
  - Если значение цвета не проходит тест контраста, менять светлоту только этого значения, тон и порядок не трогать; новое значение назвать в отчёте.

- [ ] **Step 1: Тесты `agent-colour.test.ts`:**
  - «s-1…s-8 дают восемь разных номеров»;
  - «s-9 совпадает с s-1, s-512 даёт 0»;
  - «human, engine, пустая строка, мусор, null — цвета нет»;
  - «agentColourVar отдаёт имя токена по номеру».
- [ ] **Step 2: Тесты `tokens.test.ts`** — новый блок «кольцо цвета агента — не ниже 3:1»: обе темы × восемь токенов × фоны. Фоны:
  - все из `STATE_ICON_BACKGROUNDS`;
  - `--sheet` и `--popover`;
  - карточка участника: обычная — `currentColor` 6 % поверх листа, подкрашенные — `--color-accent-200` и `--color-accent-2-200` (`ParticipantStrip.tsx:94-98`);
  - выбранная строка меню упоминаний: `--accent` поверх `--popover` (`MentionMenu.tsx:64`).

  Составные фоны собирать теми же помощниками `on` и `solid`. Восемь имён добавить в список `called` (`:722`).
- [ ] **Step 3: Тесты `AgentIcon.test.tsx`:**
  - «без sessionId разметка прежняя: data-agent-icon на картинке, обёртки нет»;
  - «с sessionId — обёртка с data-agent-icon и data-agent-colour, у картинки атрибута нет»;
  - «буква неизвестного провайдера тоже получает кольцо»;
  - «sessionId не вида s-N — как без него».
- [ ] **Step 4: Тесты `SenderAvatar.test.tsx`:** «агент с известным провайдером — значок с кольцом», «удалённая сессия s-N (провайдер null) — без кольца», «человек, помощник и система — без кольца».
- [ ] **Step 5: Написать правило, токены, кольцо и четыре места вызова.**
- [ ] **Step 6: Проверка:** тесты шагов 1–4 и существующие `ParticipantStrip.test.tsx`, `SessionRow.test.tsx`, `RoomPanel.test.tsx`; typecheck окна.
- [ ] **Step 7: Commit** `feat(desktop): give each agent session its own colour ring`.

---

### Task 2: строки, последняя проверка попытки, модель доски

**Files:**
- Create:
  - `renderer/components/rooms/latest-attempt-check.ts`;
  - `renderer/components/rooms/board/room-board-model.ts`.
- Test: `renderer/components/rooms/latest-attempt-check.test.ts`, `renderer/components/rooms/board/room-board-model.test.ts`
- Modify:
  - `shared/strings.ts` — новый блок `roomBoard` в `S`, перед `rooms` (`:1281`);
  - `renderer/components/rooms/PlanPanel.tsx` — расчёт `attempt`, `check`, `verdict` (`:467-476`) заменить вызовами общих функций; текст строки не меняется.

**Interfaces:**
- Consumes:
  - типы `RoomPlan`, `PlanItem`, `PlanItemStatus`, `PlanAttempt`, `CheckResult`, `PlanMode`, `Room`, `WindowWorkEntry`, `SessionNeed` из `@parley/core`;
  - `planItemSatisfied`, `planItemReady`, `planSubmission`, `planItemDuties` (`core/work/plan-state.ts:10`, `:21`, `:32`, `:65`);
  - `roomAwaitsDecision`, `sessionNeed` (`core/work/attention.ts:40`, `:49`);
  - `roomLiveLead`, `roomVerifierUnavailable` (`renderer/lib/room-lead.ts:17`, `:27`);
  - `sessionRowLabel` (`renderer/lib/participant.ts:68`), `sessionWord` (`renderer/lib/session-word.ts:21`), `ownerLabel` (`PlanPanel.tsx:332`);
  - `activityFor`, `ActivityEntry` (`renderer/store/activity.ts:12`, `:64`);
  - `ParticipantModel.planLine` (`renderer/components/rooms/feed-model.ts:57`) — только строка личного плана; участники — это члены комнаты, исполнитель пункта может им не быть.
- Produces:
  ```ts
  // renderer/components/rooms/latest-attempt-check.ts
  /** Последняя попытка пункта — с наибольшим `n`; `undefined` у неавтономного плана и у пункта без попыток. */
  export function lastAttempt(plan: RoomPlan, itemId: number): PlanAttempt | undefined;
  /** Последняя записанная проверка попытки — расчёт из `PlanSummary` без изменений. */
  export function latestAttemptCheck(plan: RoomPlan, attempt: PlanAttempt): CheckResult | undefined;
  /** Текст проверки, как в списке плана: `specId → verdict · сводка до 160 знаков`; `''`, если проверки нет. */
  export function checkLine(check: CheckResult | undefined): string;

  // renderer/components/rooms/board/room-board-model.ts
  export type BoardColumnId = 'waiting' | 'progress' | 'review' | 'done';
  export interface BoardAgent {
    id: string;               // s-NN или другой идентификатор
    label: string;
    provider: string | null;  // null — сессии нет в карте: ни значка, ни цвета, ни Open session
    word: string;             // слово состояния; '' — у сессии вне карты
  }
  export type BoardObstacle =
    | { kind: 'blocked'; note: string | null }
    | { kind: 'need'; need: SessionNeed }
    | { kind: 'soft'; text: string };
  export type BoardReview =
    | { kind: 'waiting'; reviewer: BoardAgent }   // Verified: ждёт проверяющего-сессию
    | { kind: 'human' }                           // Verified: проверяет человек
    | { kind: 'none' }                            // Verified: проверить некому
    | { kind: 'attempt'; status: PlanAttempt['status']; check: string; failed: boolean }; // Autonomous
  export interface BoardCardModel {
    itemId: number;
    title: string;
    status: PlanItemStatus;
    column: BoardColumnId;
    agent: BoardAgent | null;       // null — автономный пункт без исполнителя: «Engine»
    doing: string | null;
    obstacle: BoardObstacle | null;
    waitsFor: number[];             // незакрытые зависимости; только в Waiting
    ready: boolean;                 // пункт в Waiting, зависимости закрыты
    returned: string | null;
    review: BoardReview | null;     // только в In review
    basis: number | null;           // ревизия основания из Checklist
    attempt: { n: number; of: number } | null;
    submission: number | null;
    updatedAt: string | null;       // ISO
    needsHuman: boolean;
    involved: string[];             // сессии, названные на карточке, — для фильтра
  }
  export type BoardNotice = { kind: 'decision' } | { kind: 'halted'; detail: string };
  export interface RoomBoardModel {
    mode: PlanMode;
    columns: { id: BoardColumnId; cards: BoardCardModel[] }[];
    notice: BoardNotice | null;
    filterAgents: BoardAgent[];
  }
  export interface RoomBoardInput {
    plan: RoomPlan; room: Room; entry: WindowWorkEntry;
    participants: readonly ParticipantModel[];
    activity: Record<string, ActivityEntry>;
    now: Date;
  }
  /** Доска доступна: план в состоянии active, completing или completed. */
  export function roomBoardAvailable(plan: RoomPlan | null): plan is RoomPlan;
  /** Исполнитель пункта для показа; `null` — автономный пункт без исполнителя. */
  export function boardItemAgent(input: RoomBoardInput, item: PlanItem): BoardAgent | null;
  export function buildRoomBoard(input: RoomBoardInput): RoomBoardModel;
  ```
- Строки — блок `S.roomBoard`, ровно такой:
  ```ts
  roomBoard: {
    viewLabel: 'Room view', feed: 'Feed', board: 'Board',
    columns: { waiting: 'Waiting', progress: 'In progress', review: 'In review', done: 'Done', verified: 'Verified' },
    empty: 'Nothing here', engine: 'Engine',
    ready: 'Ready',
    waitsFor: (items: string): string => `Waits for ${items}`,
    blocked: (note: string): string => (note === '' ? 'Blocked' : `Blocked: ${note}`),
    returned: (note: string): string => (note === '' ? 'Returned' : `Returned: ${note}`),
    waitingFor: (who: string): string => `Submitted · waiting for ${who}`,
    waitingForYou: 'Submitted · waiting for you',
    noVerifier: 'No verifier available',
    attempt: (n: number, of: number): string => `attempt ${n} of ${of}`,
    submission: (n: number): string => `submission ${n}`,
    updated: (ago: string): string => `updated ${ago}`,
    noticeDecision: 'A decision is waiting for you in the feed',
    openFeed: 'Open feed',
    filter: 'Show the cards of one agent',
    filterOnly: (label: string): string => `Only ${label}`,
    item: (id: number): string => `#${id}`,
    moreItems: (count: number): string => `+${count}`,
    sheet: (id: number): string => `Plan item ${id}`,
    openSession: 'Open session', showInFeed: 'Show in feed',
    events: 'Latest changes',
    event: (who: string, item: number, status: string): string => `${who} · #${item} → ${status}`,
    working: 'Working now',
  },
  ```
  Слова состояний пункта и попытки, состояние плана, основание из Checklist и текст остановки уже есть: `S.plans.itemStatus`, `status`, `basis`, `attemptStatus`, `haltNotice` (`shared/strings.ts:61-94`).
- Правила модели (разделы спеки в скобках):
  - **Колонки режима (4.2).** Checklist — `waiting`, `progress`, `done`; остальные — все четыре. Порядок фиксирован.
  - **Колонка пункта (5.2).** По таблицам спеки. Сочетание вне таблиц → `progress`.
  - **Агент (5.3)** — функция `boardItemAgent`, её же зовёт карточка. Идентификатор — `item.owner`, у автономного плана — `worker` последней попытки; у автономного пункта без него — `null`. Дальше:
    1. сессия с таким идентификатором есть в `entry.map.sessions` → `label = sessionRowLabel(id, session.label)`, её `provider`, `word = sessionWord(session, живая активность, now)`;
    2. иначе `label = ownerLabel(entry, id)`, `provider = null`, `word = ''`.

    Членство в комнате на это не влияет: бывший участник и закрытая сессия сохраняют подпись и слово.
  - **Ожидание человека.** `need = sessionNeed(session, живая активность)` у сессии агента из карты; у остальных — `null`.
  - **Нужен человек (5.6)** считается отдельно от того, что показано на карточке: `needsHuman = need !== null или review.kind === 'human'`, в любой колонке.
  - **Что мешает (4.3, п. 4)** — первое подходящее: пункт `blocked` → `blocked` с `item.note`; `need !== null` → `need`; `item.progress?.owner?.blocker` → `soft`.
  - **Чем занят (5.4)** — только в `progress`: `item.progress?.owner?.next`; иначе `planLine.text` участника с тем же идентификатором, если `planLine.kind === 'current'` и у этого агента одна карточка в `progress`; иначе `null`.
  - **Waiting.** `waitsFor` — зависимости, не выполненные по `planItemSatisfied`; `ready = planItemReady(plan, item)`.
  - **Возврат.** У пункта `returned`: `returnNote` последней сдачи, иначе её `note`, иначе `item.note`.
  - **Проверка (5.5)** — только в `review`:
    - Verified: `planItemDuties(plan, item, roomLiveLead(entry.map, room), roomVerifierUnavailable(entry.map, room, item.verifier))`; обязанность `verify` у `human` → `human`; у сессии → `waiting` с ней как проверяющим (агент собирается тем же способом); обязанности `verify` нет → `none`;
    - Autonomous: `attempt` с состоянием последней попытки, `check = checkLine(latestAttemptCheck(...))`, `failed` — вердикт проверки `fail` или `error`.
  - **Основание.** `basis` — `acceptedChecklistRevision`, когда карточка в `done`, пункт в состоянии `done` и режим не Checklist.
  - **Попытка и сдача (5.5).** `attempt` — у автономного пункта с попыткой, в любой колонке: `n` и `budget.limits.attemptsPerItem`. `submission` — `planSubmission(item)`, когда режим Verified и номер больше единицы.
  - **Обновлено.** Самое позднее `at` из `item.log` и, у автономного пункта, из журнала последней попытки; записей нет — `null`.
  - **Порядок (5.6).** В каждой колонке сначала `needsHuman`, затем по `itemId`.
  - **Фильтр (5.7).** `involved` — агент карточки и проверяющий из `waiting`. `filterAgents` — эти сессии с `provider !== null`, без повторов, по номеру сессии.
  - **Уведомление (4.1).** `roomAwaitsDecision(room)` → `decision`; иначе `plan.autonomous?.halted` → `halted` с её `detail`; решение важнее остановки.
  - Модуль не обращается к хосту и к сторам.

- [ ] **Step 1: Тесты `latest-attempt-check.test.ts`:** «последняя попытка — с наибольшим n», «нет попыток — undefined», «проверка берётся только своей попытки и только завершённая», «строка проверки обрезает сводку до 160 знаков», «нет проверки — пустая строка».
- [ ] **Step 2: Тесты `room-board-model.test.ts`:**
  - «доска доступна у active, completing, completed и недоступна у proposed, cancelled и без плана»;
  - «Checklist — три колонки, done стоит в Done»;
  - «Verified: waiting и ready — Waiting; in_progress, returned, blocked — In progress; done — In review; verified — последняя»;
  - «done с основанием из Checklist стоит в последней колонке и несёт basis»;
  - «зависимость, принятая по основанию из Checklist, считается закрытой»;
  - «Autonomous: попытка running — In progress, submitted, checking, accepted, queued — In review, verified — Verified»;
  - «Autonomous: returned и blocked стоят в In progress при попытке submitted»;
  - «Autonomous: attempt n of m есть и у проверенного пункта»;
  - «сочетание вне таблиц попадает в In progress, карточка не теряется»;
  - «агент: участник комнаты, бывший участник, сессии нет в карте, автономный пункт без исполнителя»;
  - «слово агента — sessionWord: закрытая сессия с результатом done и failed, сессия в очереди, уснувшая сессия»;
  - «чем занят: next отметки; строка личного плана у единственной карточки; при двух карточках строки нет»;
  - «что мешает: блокировка, ожидание человека, мягкое препятствие — по порядку»;
  - «нужен человек: заблокированный пункт, чья сессия ждёт человека, стоит первым; пункт в Waiting и проверенный пункт в последней колонке с такой сессией — тоже»;
  - «возврат: returnNote важнее note сдачи, она важнее note пункта»;
  - «проверка Verified: сессия, человек, проверяющий недоступен при живом ведущем, без ведущего, ведущий — исполнитель»;
  - «проверка Autonomous: состояние попытки, текст проверки, failed при fail и error»;
  - «сдача: номер показан со второй; обновлено: позднейшее время из журнала пункта и журнала попытки»;
  - «уведомление: решение, остановка с любым значением причины, решение важнее остановки, ничего»;
  - «фильтр: агенты и проверяющие без повторов, по номеру сессии, без сессий вне карты».
- [ ] **Step 3: Добавить блок строк, вынести расчёт проверки из `PlanPanel.tsx`, написать модель.**
- [ ] **Step 4: Проверка:** тесты шагов 1–2, `PlanPanel.test.tsx` без правки ожиданий, `english-ui.test.ts`, typecheck окна.
- [ ] **Step 5: Commit** `feat(desktop): add the room board model`.

---

### Task 3: метки пунктов у участников и события доски

**Files:**
- Create: `renderer/components/rooms/board/room-board-activity.ts`
- Test: `renderer/components/rooms/board/room-board-activity.test.ts`

**Interfaces:**
- Consumes: задача 2 — `lastAttempt`; `planItemDuties` (`core/work/plan-state.ts:65`); `roomLiveLead`, `roomVerifierUnavailable` (`renderer/lib/room-lead.ts:17`, `:27`).
- Produces:
  ```ts
  /** Сессия → номера пунктов, по которым она сейчас должна действовать, по возрастанию. */
  export function participantItemTags(plan: RoomPlan, room: Room, entry: WindowWorkEntry): ReadonlyMap<string, number[]>;
  export type BoardEventStatus =
    | { source: 'item'; status: PlanItemStatus }
    | { source: 'attempt'; status: PlanAttempt['status'] };
  export interface BoardEvent { at: string; by: string; itemId: number; change: BoardEventStatus }
  /** Последние перемены плана, новые первыми; по умолчанию три. */
  export function boardEvents(plan: RoomPlan, limit?: number): BoardEvent[];
  ```
- Правила:
  - **Метки (спека 5.4).** План не `active` и не `completing` → пустая карта.
    - Checklist, Verified: для каждого пункта — `planItemDuties` с живым ведущим и доступностью проверяющего; метку получает `sessionId` каждой обязанности с действием не `wait`. Обязанность у `human` метки не даёт.
    - Autonomous, план остановлен (`autonomous.halted !== null`) → пустая карта.
    - Autonomous, не остановлен: `worker` последней попытки при `starting` или `running`; `verifier` попытки, если он записан, при `submitted` или `checking`.
  - **События (спека 5.8).**
    - каждая запись `item.log` — событие `source: 'item'`;
    - у автономного плана — записи журнала попыток с состоянием `submitted`, `checking`, `accepted`, `queued`, если оно отличается от предыдущей записи той же попытки;
    - порядок: позднее раньше; при равном `at` раньше пункт с меньшим номером, запись пункта раньше записи попытки.

- [ ] **Step 1: Тесты:**
  - «метки Verified: начать, продолжить, переделать, проверить, снять блокировку — у нужной сессии»;
  - «метки Checklist: начать, продолжить, переделать; проверяющего нет»;
  - «ожидающий исполнитель и человек-проверяющий меток не получают»;
  - «проверяющий недоступен — метка у живого ведущего»;
  - «план completing даёт метки; completed и cancelled — нет»;
  - «Autonomous: исполнитель при starting и при running; проверяющий при submitted и при checking; при queued — никто»;
  - «Autonomous остановлен — меток нет»;
  - «события: записи пунктов и попыток, новые первыми, три по умолчанию»;
  - «повтор состояния попытки отброшен»;
  - «равное время — порядок устойчив».
- [ ] **Step 2: Написать модуль.**
- [ ] **Step 3: Проверка:** тесты шага 1, typecheck окна.
- [ ] **Step 4: Commit** `feat(desktop): derive participant item tags and board events`.

---

### Task 4: вид вкладки комнаты и переключатель Feed / Board

**Files:**
- Create: `renderer/components/rooms/board/RoomViewSwitch.tsx`
- Test: `renderer/layout/tree.test.ts`, `renderer/layout/persistence.test.ts`, `renderer/components/rooms/RoomPanel.test.tsx` (дополнить)
- Modify:
  - `shared/layout-types.ts`;
  - `renderer/layout/tree.ts`;
  - `renderer/layout/GroupView.tsx`, `renderer/layout/bodies/RoomBody.tsx`;
  - `renderer/components/rooms/RoomPanel.tsx`, `RoomHeader.tsx`.

**Interfaces:**
- Consumes:
  - задача 2: `roomBoardAvailable`, строки `S.roomBoard`;
  - `currentRoomPlan` (`renderer/components/rooms/PlanPanel.tsx:34`);
  - `updateTab`, `TabPatch` (`renderer/layout/tree.ts:56-62`, `:297-314`), `parseTabSpec` (`:646-689`), `tabId.room` (`renderer/layout/ids.ts:29`);
  - `useLayoutStore.getState().apply(workKey, fn)` (`renderer/layout/store.ts:45`) — как в `renderer/chat/ChatToolbar.tsx:254-258`;
  - `ToggleGroup`, `ToggleGroupItem` — как в `ChatToolbar.tsx:267-281`;
  - `useMarkRead` и его поле `active` (`RoomPanel.tsx:138`; `renderer/attention/use-mark-read.ts:115`).
- Produces:
  ```ts
  // shared/layout-types.ts
  /** Вид вкладки комнаты: лента или доска плана. */
  export type RoomView = 'feed' | 'board';
  //   | { kind: 'room'; id: string; roomId: string; view?: 'board' }

  // renderer/layout/tree.ts
  //   TabPatch.roomView?: RoomView

  // RoomBody.tsx — новый необязательный проп
  //   view?: RoomView                      // по умолчанию 'feed'
  // RoomPanel.tsx — новые необязательные пропы
  //   view?: RoomView                      // по умолчанию 'feed'
  //   onViewChange?: (view: RoomView) => void
  // RoomHeader.tsx — новый необязательный проп
  //   viewSwitch?: ReactNode

  // renderer/components/rooms/board/RoomViewSwitch.tsx
  export function RoomViewSwitch(props: { view: RoomView; onChange(view: RoomView): void }): JSX.Element;
  ```
- Правила, часть 1 — раскладка:
  - `updateTab`: у вкладки `room` патч `roomView: 'board'` ставит `view: 'board'`, патч `roomView: 'feed'` убирает поле. Вкладки других видов `roomView` не принимают; патч `view` вкладку комнаты не меняет.
  - `parseTabSpec`, случай `room` (`:661`): `view === 'board'` сохраняется; поля нет или значение другое — вкладка без поля. Раскладка остаётся валидной.
  - `GroupView.tsx:103` передаёт в `RoomBody` `view={tab.view ?? 'feed'}`.
  - `RoomBody` создаёт обработчик сам и передаёт в `RoomPanel` `view` и `onViewChange`: `useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tabId.room(roomId), { roomView }))`.
- Правила, часть 2 — переключатель и лента:
  - `RoomViewSwitch` — `ToggleGroup type="single"` из двух пунктов, `aria-label={S.roomBoard.viewLabel}`. Пустое значение (повторное нажатие на выбранный пункт) пропускается, как в `ChatToolbar.tsx:254-258`.
  - `RoomPanel` отдаёт переключатель в `RoomHeader` пропом `viewSwitch`, только когда есть `onViewChange` и `roomBoardAvailable(currentRoomPlan(entry, roomId))`. В шапке он стоит в строке названия перед кнопкой Browser.
  - `boardOpen = view === 'board' && доска доступна`.
  - Блок ленты (`RoomPanel.tsx:545`), строка занятых участников (`:635`), заметка архива, плашка ответа и поле ввода (`:664-672`) оборачиваются в один новый контейнер `data-room-feed-area` с классами `flex min-h-0 flex-1 flex-col`. Снаружи — контейнер `data-room-feed-stack` с классами `relative flex min-h-0 flex-1 flex-col`.
  - При `boardOpen`:
    - лента и строка занятых участников остаются отрисованными и занимают своё место; `data-room-feed-area` получает атрибут `inert` (ставить через ref и `toggleAttribute`: типы React 18 его не знают) и `aria-hidden`;
    - плашка ответа и поле ввода не рисуются. Черновик лежит в сторе (`composerDrafts`, `renderer/store/ui.ts`) и переживает размонтирование поля; выбранный ответ — состояние `RoomPanel`, оно остаётся;
    - внутри `data-room-feed-stack` поверх ленты стоит слой `<div data-room-board-layer="" className="absolute inset-0 z-10 flex min-h-0 flex-col bg-sheet" />`. Задача 5 положит в него доску;
    - `useMarkRead` получает `active: active && !boardOpen`.
  - При возврате в Feed поле ввода возвращается и лента становится ниже. Если она была у низа (`atBottomRef`, `:193`), прижать её к низу (`pinToBottom`) в `useLayoutEffect` по смене `boardOpen`.
  - Остальные расчёты прокрутки ленты (`:198-220`, `:328-401`) не трогать: лента сохраняет раскладку, и они работают как раньше.
  - Корневой элемент панели с приёмом перетаскивания (`:513`) и его обработчики не меняются.

- [ ] **Step 1: Тесты `tree.test.ts`:**
  - «патч roomView: board ставит вид вкладке комнаты, feed — убирает поле»;
  - «roomView не меняет вкладку сессии, а view не меняет вкладку комнаты»;
  - «раскладка с view: board у комнаты разбирается с видом»;
  - «раскладка без поля и с незнакомым значением даёт вкладку без вида и остаётся валидной»;
  - «вид chat и terminal у вкладки сессии разбирается как раньше».
- [ ] **Step 2: Тест `persistence.test.ts`:** «вид board у вкладки комнаты переживает сохранение и чтение раскладки».
- [ ] **Step 3: Тесты `RoomPanel.test.tsx`** (для прочтения — приём блока «прочтение существующим механизмом», `:2237-2260`, с подменённым `IntersectionObserver`):
  - «переключатель есть при плане active, completing, completed; его нет у комнаты без плана, при плане proposed и cancelled, и без onViewChange»;
  - «нажатие Board зовёт onViewChange('board'), нажатие Feed — onViewChange('feed'), повторное нажатие на выбранный пункт ничего не зовёт»;
  - «вид board: лента остаётся в дереве и получает inert, слой доски стоит поверх, поля ввода и плашки ответа в дереве нет»;
  - «вид board при недоступной доске: слоя нет, inert нет»;
  - «в виде board видимое письмо не уходит в mail.markRead; после возврата в feed — уходит»;
  - «таймер прочтения, начатый до переключения в board, письмо не отмечает»;
  - «при возврате в feed лента, стоявшая у низа, прижимается к низу»;
  - «черновик поля ввода и выбранный ответ сохраняются после board → feed»;
  - «без пропа view панель ведёт себя как раньше».
- [ ] **Step 4: Написать раскладку и проводку (часть 1), затем переключатель и слой (часть 2).**
- [ ] **Step 5: Проверка:** тесты шагов 1–3; существующие `GroupView.test.tsx`, `RoomBody.test.tsx`, `RoomPanel.earlier.test.tsx`, `RoomRecipeChip.test.tsx` без правок; typecheck окна.
- [ ] **Step 6: Commit** `feat(desktop): add a Feed and Board switch to the room tab`.

---

### Task 5: доска — колонки, карточки, фильтр, уведомление

**Files:**
- Create: `renderer/components/rooms/board/RoomBoard.tsx`, `renderer/components/rooms/board/RoomBoardCard.tsx`
- Test: `renderer/components/rooms/board/RoomBoard.test.tsx`
- Modify: `renderer/components/rooms/RoomPanel.tsx` — в слой `data-room-board-layer` кладётся `RoomBoard`.

**Interfaces:**
- Consumes:
  - задача 1: `AgentIcon` с `sessionId`, `agentColourVar`;
  - задача 2: `buildRoomBoard`, типы модели, `S.roomBoard`;
  - `BoardColumn` (`renderer/board/BoardColumn.tsx:4-12`): пропы `title`, `count`, `top?`, `children`; рисует `<section>` с заголовком и `<ul>`, пропа `className` у него нет;
  - `planProgress` (`renderer/components/rooms/PlanPanel.tsx:49`), `S.plans.status`, `itemStatus`, `attemptStatus`, `basis`, `haltNotice`;
  - `needLabel` (`renderer/attention/derive.ts:60`; второй аргумент — миллисекунды), `relativeTimeAgo(iso: string, now: Date)` (`renderer/lib/relative-time.ts:42`), `Button` (`renderer/ui/button.tsx`);
  - `model.participants`, `activity` и `now` из `RoomPanel`.
- Produces:
  ```ts
  export function RoomBoard(props: {
    plan: RoomPlan; room: Room; entry: WindowWorkEntry;
    participants: readonly ParticipantModel[];
    activity: Record<string, ActivityEntry>;
    now: Date;
    onOpenFeed(): void;
    /** Нажатие и Enter на карточке; панель пункта подключает задача 6. */
    onOpenItem?: (itemId: number) => void;
  }): JSX.Element;
  export function RoomBoardCard(props: {
    card: BoardCardModel; mode: PlanMode; dimmed: boolean; now: Date; onOpen?: (itemId: number) => void;
  }): JSX.Element;
  ```
- Правила:
  - **Строка доски.** Слева ряд фильтра: по кнопке на агента из `filterAgents` — `AgentIcon` с кольцом, `aria-pressed`, `title={S.roomBoard.filterOnly(label)}`; группа с `aria-label={S.roomBoard.filter}`. Справа `S.plans.status[plan.status]` и `planProgress(plan)`. Отступы по бокам — как у ленты, `px-9`.
  - **Уведомление.** `notice !== null` → полоса над колонками на фоне вопроса агента: `S.roomBoard.noticeDecision` либо `S.plans.haltNotice(detail)`, и кнопка `S.roomBoard.openFeed`, которая зовёт `onOpenFeed`.
  - **Колонки.** Контейнер `flex min-h-0 flex-1 items-start gap-3 overflow-auto px-9 pb-3`. Каждая колонка:
    ```tsx
    <div className="rounded-2xl bg-foreground/[0.06] p-2" data-board-column={id}>
      <BoardColumn title={…} count={cards.length}>
        {cards.length === 0
          ? <li className="px-1 py-2 text-xs text-muted-foreground">{S.roomBoard.empty}</li>
          : cards.map((card) => <li key={card.itemId}><RoomBoardCard … /></li>)}
      </BoardColumn>
    </div>
    ```
    Название — из `S.roomBoard.columns`; последняя колонка — `done` у Checklist, `verified` у остальных. Подложка нужна потому, что на листе комнаты карточка без неё сливается с фоном.
  - **Карточка** — `<button type="button" data-board-item={itemId}>` на всю ширину: `rounded-[14px] bg-card p-2.5 text-left text-sm shadow-sm`, слева полоса 3 px. Цвет полосы — `agentColourVar(agent.id)`, только когда `agent !== null` и `agent.provider !== null`; иначе `var(--color-neutral-400)`. Строки сверху вниз, пустые пропускаются (спека 4.3):
    1. `S.roomBoard.item(itemId)` мелко и название, `line-clamp-2`, `[overflow-wrap:anywhere]`;
    2. агент: `AgentIcon` размером 16 с `sessionId`, подпись (`truncate`) и `word`. При `agent === null` — `S.roomBoard.engine`. При `provider === null` — только подпись. Если препятствие — ожидание человека, `word` не показывается: его несёт строка 4;
    3. `doing`, `line-clamp-2`, вторичный цвет;
    4. препятствие на фоне вопроса агента: `S.roomBoard.blocked(note ?? '')`, `needLabel(need, now.getTime())` либо текст мягкого препятствия;
    5. в Waiting: `ready` → `S.roomBoard.ready`, иначе `S.roomBoard.waitsFor('#2, #3')`;
    6. `S.roomBoard.returned(note)`;
    7. проверка: `waitingFor(reviewer.label)`, `waitingForYou`, `noVerifier`, либо `S.plans.attemptStatus[status]` и текст проверки; `human`, `none` и `failed` — на фоне вопроса агента;
    8. `S.plans.basis(basis)`;
    9. мелкая строка: `attempt(n, of)` либо `submission(n)`, и `updated(relativeTimeAgo(updatedAt, now))`, когда `updatedAt !== null`. Первый аргумент — строка ISO как есть.
  - **Запасной случай.** Если карточка стоит в In progress, а состояние пункта не `in_progress`, не `returned` и не `blocked`, рядом с названием стоит `S.plans.itemStatus[status]`.
  - **Фильтр.** Выбранный агент хранится в состоянии `RoomBoard`; карточки, где его нет в `involved`, получают `dimmed` (`opacity-30`). Повторное нажатие снимает фильтр.
  - **Нажатие и Enter** на карточке зовут `onOpen(itemId)`, если он передан.
  - `RoomPanel` кладёт `<RoomBoard>` в слой и передаёт `onOpenFeed={() => onViewChange?.('feed')}`. `onOpenItem` в этой задаче не передаётся.

- [ ] **Step 1: Тесты `RoomBoard.test.tsx`:**
  - «Verified: четыре колонки с числами, пункт стоит в своей колонке»;
  - «Checklist: три колонки, последняя — Done»;
  - «карточка в работе показывает агента, слово состояния и чем он занят»;
  - «заблокированный пункт и ожидание человека выделены; при ожидании человека слово состояния не дублируется»;
  - «In review: ждёт проверяющего, ждёт человека, проверить некому»;
  - «Autonomous: состояние попытки, текст проверки, attempt n of m»;
  - «основание из Checklist подписано; номер сдачи и время обновления показаны»;
  - «исполнителя нет в карте: подпись без значка, полоса нейтральная»;
  - «запасной случай: рядом с названием стоит слово состояния пункта»;
  - «уведомление о решении и об остановке; Open feed зовёт onOpenFeed»;
  - «фильтр по исполнителю и по проверяющему бледнит чужие карточки, повторное нажатие снимает»;
  - «нажатие на карточку зовёт onOpenItem с номером пункта; карточка — обычная включённая кнопка и берёт фокус». Сам Enter jsdom в нажатие не превращает: его проверяет сквозной сценарий задачи 9 (решение ведущего 2026-11-17 по возврату пункта 5);
  - «пустая колонка показывает Nothing here».
- [ ] **Step 2: Написать доску и карточку, подключить в `RoomPanel`.**
- [ ] **Step 3: Проверка:** тесты шага 1, `RoomPanel.test.tsx`, typecheck окна, eslint.
- [ ] **Step 4: Commit** `feat(desktop): show the room plan as a board`.

---

### Task 6: панель пункта

**Files:**
- Create: `renderer/components/rooms/board/RoomBoardItemSheet.tsx`
- Test: `renderer/components/rooms/board/RoomBoardItemSheet.test.tsx`, `renderer/components/rooms/RoomPanel.test.tsx` (дополнить)
- Modify:
  - `renderer/components/rooms/PlanPanel.tsx` — тело строки пункта (`<li>`, `:481-626`) выносится в экспортируемый компонент `PlanItemBody`; `PlanSummary` рисует его;
  - `renderer/components/rooms/RoomPanel.tsx` — открытый пункт, панель, Show in feed.

**Interfaces:**
- Consumes:
  - задача 1: `AgentIcon` с `sessionId`; задача 2: `boardItemAgent`, `BoardAgent`; задача 5: атрибут `data-board-item`, проп `onOpenItem` доски;
  - `Dialog`, `DialogContent`, `DialogTitle` (`renderer/ui/dialog.tsx:28-111`): это примитивы Radix; `DialogContent` принимает `onCloseAutoFocus`;
  - `PlanSummary` (`PlanPanel.tsx:426`): расчёты строки — `session`, `attempt`, `check`, `verdict`, `satisfied`, `duties`, `submission`, `now` (`:461-480`);
  - `onOpenSession` (`RoomPanel.tsx:108`), прокрутка ленты `containerRef` и `atBottomRef` (`:190`, `:193`).
- Produces:
  ```ts
  // PlanPanel.tsx
  export function PlanItemBody(props: {
    plan: RoomPlan; item: PlanItem; entry?: WindowWorkEntry; bridge?: ParleyBridge;
    /** Блок подробностей раскрыт сразу (панель пункта). */
    expanded?: boolean;
    renderActions?: (item: PlanItem) => JSX.Element | null;
  }): JSX.Element;

  // RoomBoardItemSheet.tsx
  export function RoomBoardItemSheet(props: {
    plan: RoomPlan; item: PlanItem | null; agent: BoardAgent | null;
    entry: WindowWorkEntry; bridge: ParleyBridge;
    onClose(): void;
    /** Вернуть фокус на карточку после обычного закрытия. */
    onReturnFocus(): void;
    onOpenSession(sessionId: string): void;
    onShowInFeed(): void;
  }): JSX.Element;
  ```
- Правила:
  - **Вынос.** `PlanItemBody` — содержимое нынешнего `<li>` без самого `<li>`; расчёты строки (`:461-480`) переезжают внутрь компонента. `PlanSummary` рисует `<li …><PlanItemBody … {...(renderActions ? { renderActions } : {})} /></li>`. Разметка, атрибуты `data-plan-*` и тексты списка не меняются. Формы действий остаются в `PlanPanel` (`:634` и ниже).
  - **Панель.** `Dialog` открыт при `item !== null`; `onOpenChange(false)` зовёт `onClose`. Содержимое прижато к правому краю, ширина до 420 px, на всю высоту, прокручивается. Заголовок — `DialogTitle` с `S.roomBoard.sheet(item.id)`.
  - Внутри, сверху вниз:
    1. исполнитель: `AgentIcon` размером 16 с `sessionId` (только при `agent.provider !== null`), подпись и слово; при `agent === null` — `S.roomBoard.engine`;
    2. `<PlanItemBody plan item entry bridge expanded />` без `renderActions`;
    3. кнопки `S.roomBoard.openSession` и `S.roomBoard.showInFeed`.
  - **Open session** есть, только когда `agent !== null` и `agent.provider !== null`; зовёт `onOpenSession(agent.id)`.
  - **Возврат фокуса.** `DialogContent onCloseAutoFocus`: отменить действие по умолчанию и позвать `onReturnFocus`. После Show in feed фокус не возвращается.
  - **`RoomPanel`:**
    - хранит номер открытого пункта; передаёт доске `onOpenItem`;
    - `agent` считает через `boardItemAgent` с теми же входами, что у доски;
    - `onReturnFocus` находит в слое доски карточку `[data-board-item="<номер>"]` и ставит на неё фокус; карточки нет — ничего не делает. Номер берётся из ref, куда он записан при открытии: состояние к этому моменту уже сброшено;
    - `onShowInFeed`: закрыть панель, позвать `onViewChange?.('feed')`, поставить ленту в начало (`containerRef.current.scrollTop = 0`) и снять признак «у низа» (`atBottomRef.current = false`), чтобы лента не прижалась обратно. Лента в виде Board сохраняет раскладку, поэтому прокрутка срабатывает сразу. Список плана стоит в ленте первым (`:553`).

- [ ] **Step 1: Тесты `RoomBoardItemSheet.test.tsx`:**
  - «панель показывает исполнителя со значком, состояние, обязанности, отметку хода и раскрытые критерии»;
  - «у автономного пункта видна последняя попытка и её проверка»;
  - «действий над планом в панели нет»;
  - «Open session есть у сессии из карты и нет у сессии вне карты и у Engine»;
  - «Show in feed зовёт onShowInFeed»;
  - «Esc зовёт onClose».
- [ ] **Step 2: Тесты `RoomPanel.test.tsx`:**
  - «нажатие на карточку открывает панель этого пункта»;
  - «Show in feed из ленты, стоявшей у низа: вид feed, лента в начале, список плана виден»;
  - «после закрытия панели фокус на карточке».
- [ ] **Step 3: Вынести `PlanItemBody`, написать панель, подключить в `RoomPanel`.**
- [ ] **Step 4: Проверка:** тесты шагов 1–2; `PlanPanel.test.tsx`, `PlanRemainingView.test.tsx`, `CompletionCard.test.tsx`, `DecisionCard.test.tsx` без правки ожиданий; typecheck окна. Возврат фокуса и закрытие нажатием мимо в jsdom могут не воспроизводиться: тогда оставить их сквозному сценарию задачи 9 и сказать об этом в отчёте.
- [ ] **Step 5: Commit** `feat(desktop): open a plan item from the room board`.

---

### Task 7: карточка комнаты на доске проекта и метка пункта у участника

**Files:**
- Test: `renderer/board/target-info.test.ts`, `renderer/board/BoardCardView.test.tsx`, `renderer/components/rooms/ParticipantStrip.test.tsx` (дополнить)
- Modify:
  - `renderer/board/target-info.ts`, `renderer/board/BoardCardView.tsx`;
  - `renderer/components/rooms/ParticipantStrip.tsx`, `RoomHeader.tsx`, `RoomPanel.tsx`.

**Interfaces:**
- Consumes:
  - задача 1: `AgentIcon` с `sessionId`; задача 3: `participantItemTags`;
  - `currentRoomPlan`, `planProgress` (`renderer/components/rooms/PlanPanel.tsx:34`, `:49`);
  - `activityFor` (`renderer/store/activity.ts:64`), `sessionRowLabel` (`renderer/lib/participant.ts:68`); `targetInfo` (`renderer/board/target-info.ts:20`).
- Produces:
  ```ts
  // target-info.ts — новое необязательное поле
  export interface TargetInfo {
    label: string; word: string; gone: boolean; focus: FocusTarget;
    /** Только у комнаты с планом active или completing. */
    plan?: { progress: string; working: { id: string; provider: string; label: string }[]; more: number };
  }
  // ParticipantStrip.tsx, RoomHeader.tsx — новый необязательный проп
  //   itemTags?: ReadonlyMap<string, number[]>
  ```
- Правила:
  - **`targetInfo`, цель-комната.** План — `currentRoomPlan(entry, room.id)`; при состоянии `active` или `completing` заполняется `plan`:
    - `progress = planProgress(plan)`;
    - работающие — участники комнаты (`room.members`), у которых `activityFor(activity, ref)?.activity.activity === 'working'`, где `ref = { projectPath: entry.projectPath, workId, sessionId }`; порядок — по возрастанию номера сессии; `label = sessionRowLabel(id, session.label)`;
    - `working` — первые четыре, `more` — сколько осталось.
  - **`BoardCardView`.** В колонках In progress и Review, под строкой цели (`:68-82`), при `target.plan`: строка с `progress` и ряд значков с `aria-label={S.roomBoard.working}`. Каждый значок — `<span title={label}><AgentIcon provider size={14} sessionId={id} /></span>`; `more > 0` → `S.roomBoard.moreItems(more)`. Без `target.plan` карточка прежняя.
  - **Метка у участника.** `RoomPanel` считает `participantItemTags(plan, room, entry)` для плана из `currentRoomPlan` и передаёт в `RoomHeader` → `ParticipantStrip` пропом `itemTags`, условным разворотом. Метки стоят во второй строке карточки участника — первым элементом ряда `mx-3 mb-[9px] mt-1 flex min-w-0 items-center gap-2` (`ParticipantStrip.tsx:106`), перед строкой занятия: `S.roomBoard.item(id)` первых двух пунктов и `S.roomBoard.moreItems(n)` для остальных, одним элементом `shrink-0 text-[11px] text-muted-foreground`. Строка занятия после них обрезается, как сейчас. Первая строка карточки не меняется: имя по-прежнему держит минимум `5ch`, первой сжимается роль. Комната всегда попадает в эту ветку разметки, потому что передаёт `onOpenPlan`; в двух других ветках меток нет. Нет меток — разметка прежняя.

- [ ] **Step 1: Тесты `target-info.test.ts`:**
  - «комната с активным планом получает ход и работающих с подписями»;
  - «сессия перестала работать — из списка уходит»;
  - «не больше четырёх значков, остальные числом, порядок по номеру сессии»;
  - «план completing даёт поле; completed, proposed, комната без плана и цель-сессия — нет».
- [ ] **Step 2: Тесты `BoardCardView.test.tsx`:** «In progress и Review показывают ход и значки с подсказкой-подписью», «без plan карточка как раньше».
- [ ] **Step 3: Тесты `ParticipantStrip.test.tsx`:** «метка пункта стоит у участника», «больше двух пунктов — два и +N», «метки стоят первыми во второй строке, первая строка карточки не меняется», «без меток разметка прежняя».
- [ ] **Step 4: Написать.**
- [ ] **Step 5: Проверка:** тесты шагов 1–3, `BoardView.test.tsx`, `RoomPanel.test.tsx`; typecheck окна.
- [ ] **Step 6: Commit** `feat(desktop): show room plan progress on the project board`.

---

### Task 8: движение карточек и лента событий

**Files:**
- Create: `renderer/components/rooms/board/use-card-motion.ts`
- Test: `renderer/components/rooms/board/use-card-motion.test.tsx`, `renderer/components/rooms/board/RoomBoard.test.tsx` (дополнить)
- Modify: `renderer/components/rooms/board/RoomBoard.tsx`

**Interfaces:**
- Consumes: задача 3 — `boardEvents`; задача 5 — атрибут `data-board-item` и полоса цвета агента у карточек; `ownerLabel` (`PlanPanel.tsx:332`); `S.plans.itemStatus`, `S.plans.attemptStatus`, `S.roomBoard.event`, `S.roomBoard.events`.
- Produces:
  ```ts
  export const CARD_MOTION_MS = 460;
  /**
   * Запоминает место каждой карточки (`[data-board-item]`) внутри контейнера и после отрисовки запускает переезд тем,
   * что сменили место. `version` меняется, когда меняется модель доски.
   */
  export function useCardMotion(container: RefObject<HTMLElement | null>, version: unknown): void;
  ```
- Правила:
  - **Движение (спека 5.9).** Места карточек снимаются в `useLayoutEffect` и хранятся по значению `data-board-item`, а не по элементу: при смене колонки React создаёт новый элемент.
  - Карточка, чьё место сменилось, получает `element.animate` от старого места к новому с длительностью `CARD_MOTION_MS` и вторую анимацию — вспышку контура. Цвет вспышки — цвет левой полосы карточки. Полоса сделана дочерним элементом `[data-board-stripe]` с заливкой (`RoomBoardCard.tsx`), поэтому цвет берётся как `getComputedStyle(полоса).backgroundColor`.
  - При первом показе доски мест ещё нет — анимации нет.
  - При `matchMedia('(prefers-reduced-motion: reduce)').matches` анимации нет.
  - Среда без `element.animate` (jsdom) не падает: вызов под проверкой наличия.
  - **Лента событий (спека 5.8).** Под колонками, с рамкой сверху и `aria-label={S.roomBoard.events}`: до трёх строк из `boardEvents(plan)` — время `HH:MM` и `S.roomBoard.event(ownerLabel(entry, by), itemId, слово)`. Слово — `S.plans.itemStatus` или `S.plans.attemptStatus` по `change.source`. Первая строка основным цветом, остальные вторичным. Событий нет — ленты нет.

- [ ] **Step 1: Тесты `use-card-motion.test.tsx`** (подменить `Element.prototype.animate` и `getBoundingClientRect`):
  - «первый показ — анимации нет»;
  - «карточка сменила место — анимация с длительностью 460 мс»;
  - «карточка переехала в другую колонку (новый элемент с тем же номером) — анимация есть»;
  - «вспышка берёт цвет заливки полосы `[data-board-stripe]`»;
  - «место то же — анимации нет»;
  - «уменьшить движение — анимации нет»;
  - «без element.animate хук не падает».
- [ ] **Step 2: Тесты `RoomBoard.test.tsx`:** «лента показывает три последние перемены, новая сверху», «событий нет — ленты нет».
- [ ] **Step 3: Написать хук и ленту.**
- [ ] **Step 4: Проверка:** тесты шагов 1–2, typecheck окна, eslint.
- [ ] **Step 5: Commit** `feat(desktop): animate room board cards and list the latest changes`.

---

### Task 9: сквозной сценарий 800×500, CHANGELOG, итоговая проверка

**Files:**
- Create: `packages/desktop/e2e/room-board.spec.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes:
  - образец `packages/desktop/e2e/room-assignments.spec.ts`: карту кладёт тест ядром (`addRoom`, `addSession`, `updateMap`, `reservePlanEffects`), окно 800×500, длинные названия;
  - образец `packages/desktop/e2e/room-participants-layout.spec.ts`: проверки геометрии;
  - помощники `e2e/tmp.js`, `e2e/stop-host.js`, `e2e/stop-app.js`: `quitApp` (`stop-app.ts:49`) закрывает окно штатно и даёт раскладке сохраниться, `stopApp` (`:37`) — только уборка в конце.
- Правила сценария:
  1. Карта: комната с Verified-планом из шести пунктов в разных состояниях (ждёт зависимостей, готов, в работе с отметкой хода, сдан и ждёт проверяющего, возвращён, проверен), три сессии с номерами подряд, длинное название пункта и длинная подпись сессии. Агентов нет.
  2. В бэклоге проекта — карточка, взятая этой комнатой. Её кладёт тест ядром: `addBacklogItem` и `takeBacklogItem` (`core/work/backlog.ts:338`, `:413`; экспорт из `@parley/core`), цель — `<workId>/<roomId>`, как в `packages/host/src/methods/backlog.ts:117`.
  3. Открыть комнату: переключатель виден. Нажать Board: четыре колонки, у каждой число, пункты стоят в колонках по таблице спеки 5.2.
  4. Окно 800×500: ничего не выходит за окно, колонки прокручиваются по горизонтали, название пункта обрезано. В виде Board лента участников и строка режима скрыты, первая карточка каждой непустой колонки видна целиком и нажимается, лента событий занимает одну строку. В окне 1280×800 в виде Board лента участников видна.
  5. У значков трёх сессий подряд разные `data-agent-colour`; у одной сессии номер цвета одинаков в сайдбаре и на карточке.
  6. Сменить состояние пункта в карте (`updateMap`): карточка оказывается в новой колонке без перезагрузки.
  7. Нажать на карточку: панель пункта открыта; Esc закрывает её, фокус на карточке. Нажать Enter на карточке в фокусе: панель снова открыта. Нажать мимо панели: она закрыта, фокус на карточке.
  8. Положить в комнату предложение, ждущее человека: над колонками уведомление; Open feed показывает ленту. Нажать Board снова.
  9. Закрыть окно через `quitApp` и открыть снова: комната открыта в виде Board.
  10. Доска проекта: карточка этой комнаты показывает ход плана.
  11. Лента под доской:
      - прокрутить ленту вверх, открыть Board, вернуться в Feed — место прокрутки то же;
      - лента у низа, открыть Board, положить в комнату новое письмо, вернуться в Feed — лента у низа, письмо видно;
      - в виде Board клавиша Tab не доходит до элементов ленты.
  12. Карточка участника в окне 800×500: у участника с двумя метками пунктов и «+N», длинной ролью, звездой ведущего и длинным словом состояния имя не уже `5ch` (замер — как в `room-participants-layout.spec.ts:227-236`), вторая строка не выходит за карточку.
- CHANGELOG, раздел `## Unreleased` → `### Added`, по-английски, одной записью с жирным первым предложением: вид Board в комнате, кольцо цвета агента, ход плана на карточке доски проекта; сказать, что доска только показывает и что вид запоминается.

- [ ] **Step 1: Написать сценарий.**
- [ ] **Step 2: Собрать и прогнать:** `pnpm --filter @parley/host build && pnpm --filter @parley/desktop build`, затем `env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" LANG="$LANG" pnpm --dir packages/desktop exec playwright test e2e/room-board.spec.ts e2e/room-assignments.spec.ts e2e/room-participants-layout.spec.ts e2e/room-row.spec.ts --workers=1`.
- [ ] **Step 3: Итоговая проверка:** `pnpm --filter @parley/desktop test`, `pnpm typecheck`, `pnpm lint`. Числа — в «Ход исполнения».
- [ ] **Step 4: Снимки для человека** в обеих темах: сайдбар с кольцами, шапка комнаты с метками пунктов, доска Verified-плана, доска в окне 800×500, панель пункта, карточка комнаты на доске проекта. По снимкам проверить глазами: кольцо нигде не обрезано и не наезжает на соседний значок.
- [ ] **Step 5: Запись в CHANGELOG.**
- [ ] **Step 6: Два коммита:** `test(desktop): cover the room board end to end` и `docs(changelog): add the room board`.

### Task 10: низкая панель — сжатая шапка в виде Board и лента событий в одну строку

Добавлена поправкой 2026-11-17 по находке задачи 9. Исполнитель E2, идёт перед задачей 9.

Способ изменён второй поправкой 2026-11-17. Первый вариант делал корень панели контейнером по размеру и прятал ряды контейнерным запросом. Так нельзя: в проекте записан дефект Chromium — у потомков размерного контейнера порой не пересчитывается `:disabled`, и включённые кнопки остаются со стилем выключенных (шапка `renderer/browser/BrowserChrome.tsx`, тест «P2» в `BrowserChrome.test.tsx`, 2 случая из 80 запусков окна). Под контейнером оказались бы поле ввода, карточки доски и переключатель режима. Поэтому высоту меряет сама панель, как `BrowserChrome` меряет ширину своей строки.

**Files:**
- Test: `renderer/components/rooms/RoomHeader.test.tsx` (новый), `renderer/components/rooms/board/RoomBoard.test.tsx` (дополнить), `renderer/components/rooms/RoomPanel.test.tsx` (дополнить)
- Modify: `renderer/components/rooms/RoomPanel.tsx`, `RoomHeader.tsx`, `board/RoomBoard.tsx`.

**Interfaces:**
- Consumes: шапка комнаты (`RoomHeader.tsx`): ряд режима и чипов и лента участников; лента событий в `RoomBoard.tsx`; корень панели `data-room-panel` (`RoomPanel.tsx`); образец замера — `BrowserChrome.tsx:113-128`.
- Produces:
  ```ts
  // RoomHeader.tsx и board/RoomBoard.tsx — новый необязательный проп
  //   compact?: boolean   // вид Board в низкой панели
  // RoomPanel.tsx
  //   const SHORT_PANEL_HEIGHT = 560;   // панель ниже этой высоты считается низкой
  ```
- Правила (спека 4.1):
  - Контейнерных запросов в панели комнаты нет: ни `container-type`, ни `@container`, ни вариантов `@min-`/`@max-`. Всё, что добавил коммит `b66f8a41` (классы контейнера на корне, `SHORT_PANEL_HIDDEN`, обёртки с этим классом, проп `boardOpen` у шапки), убирается.
  - `RoomPanel` меряет высоту корня `data-room-panel`: `useLayoutEffect` с `ResizeObserver`, берётся `contentRect.height` последней записи; панель низкая, если высота меньше `SHORT_PANEL_HEIGHT`. Нет `ResizeObserver` в окружении — замера нет, панель считается высокой. При размонтировании наблюдатель отключается.
  - `compact = boardOpen && панель низкая`. `RoomPanel` передаёт `compact` в `RoomHeader` и в `RoomBoard` условным разворотом: без него проп не передаётся.
  - `RoomHeader` при `compact` не рисует ряд режима и чипов и ленту участников. Название, подзаголовок, переключатель вида и кнопка Browser есть всегда. Без `compact` разметка шапки та же, что до задачи 10 (в `ef249e8c`).
  - `RoomBoard` при `compact` показывает в ленте событий одну строку — самое свежее событие. Без `compact` — до трёх, как раньше.
  - Строка ленты событий всегда одна: текст с `truncate`, полный текст («время текст») в `title` строки.
  - Высота корня от содержимого не зависит (`h-full`), поэтому скрытие рядов не меняет замер и не зацикливается. Размеры и отступы в высокой панели не меняются.

- [ ] **Step 1: Тесты `RoomHeader.test.tsx`:** «без compact ряд режима и лента участников на месте», «с compact их нет, а название, подзаголовок, переключатель вида и кнопка Browser есть».
- [ ] **Step 2: Тесты `RoomBoard.test.tsx`:** «строка события — одна строка с полным текстом в подсказке», «с compact в ленте одно, самое свежее событие; без него — до трёх».
- [ ] **Step 3: Тесты `RoomPanel.test.tsx`** с подменой `ResizeObserver` (как в `BrowserChrome.test.tsx`): «вид Board, высота 559 — ряда режима и ленты участников нет, в ленте событий одна строка», «вид Board, высота 560 — шапка полная», «вид Feed, высота 559 — шапка полная», «порог пересекается в обе стороны», «в разметке панели нет `container-type` и `@container`». Прежние тесты `RoomPanel.test.tsx` проходят без правки ожиданий.
- [ ] **Step 4: Написать.**
- [ ] **Step 5: Проверка:** тесты шагов 1–3, вся папка `board/`, typecheck окна, eslint по изменённым файлам. Сами размеры jsdom не показывает: их проверяет шаг 4 сквозного сценария задачи 9.
- [ ] **Step 6: Commit** поверх `b66f8a41`, без переписывания истории: `fix(desktop): measure the short room panel instead of a container query`. Первый коммит задачи — `fix(desktop): keep the room board usable in a short panel`.

## Не проверено при планировании

- Значения восьми цветов в живом окне: контраст посчитан автором по списку фонов, теста ещё нет.
- Не обрезается ли контур кольца контейнерами с `overflow` в сайдбаре и в ленте участников.
- Атрибут `inert` у ленты под слоем доски и возврат фокуса из панели пункта: решения приняты по чтению кода и документации Radix, в окне не прогонялись.
- Правки после повторного чтения критика он не перечитывал.
- Автономный план на живых агентах.
