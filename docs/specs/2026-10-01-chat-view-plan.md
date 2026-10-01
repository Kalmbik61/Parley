# План реализации: вид «Chat» в вкладке сессии — лента поверх скрытого терминала

**Цель:** сессия Claude Code в окне выглядит как разговор — лента сообщений, вызовов
инструментов и диффов, поле ввода, карточки разрешений и вопросов, — а терминал скрыт за
переключателем и показывается по кнопке или сам, когда CLI просит то, чего в ленте нет.
Агент остаётся тем же интерактивным `claude` в PTY под логином человека (TODOS, прогон 18).

**Спека:** разведка `docs/research/2026-10-01-chat-view-spike.md` (механика хуков, журнала и
экрана, проверенная на `claude` 2.1.286; улики в папке с тем же именем), раздел 18 TODOS и
раздел «Решения» ниже. Codex в этот план не входит: у него нет хуков, лента по его журналу и
одобрения разбором терминала — отдельная разведка и отдельный план.

План выровнен с релизом 0.2.0 (`d2dfe32`, 2026-10-01): живые субагенты уже приходят окнам в
`LiveMetrics.tasks`, участник комнаты показывает, чем занят, — этот план строит поверх, а не
рядом. Задачи 1–2 — этап 0 дизайна удалённого доступа
(`2026-10-01-remote-access-design.md`, 11.1): протокол `feed.*` и решения `feed.decide` потом
едут на телефон, см. решение 14.

**Стек:** как у плана комнат Organic: Electron 44, React 18, TS strict ESM, Tailwind 4,
shadcn-примитивы в `renderer/ui/`, zustand 5, `react-markdown` + `remark-gfm`,
`@tanstack/react-virtual`, vitest + jsdom, Playwright `_electron`. Протокол — zod в
`packages/protocol`. Хост — `node:net` на unix-сокете; приёмник хуков — `node:http` на
127.0.0.1.

## Global Constraints

- **Рамка.** Та же, что в README и чек-листе 15.1 спеки Orca-UI, плюс следствия разведки:
  - агент — немодифицированный `claude`; хуки и строка статуса уезжают только файлом
    `--settings` работы, в `~/.claude` и `~/.claude.json` не пишем;
  - **никаких автоответов**: решение уходит хуку только по нажатию человека в окне. Хост
    сам отвечает хуку только «без решения» (пустой JSON) — когда карточку сняли иначе,
    по таймауту или при выключении. Ни одного пути, где хост отвечает `allow` без нажатия;
  - способы входа CLI не ограничиваем: пока нет `SessionStart` (доверие папке, вход,
    предупреждение канала), вкладка показывает терминал;
  - учётные данные не читаем, к API не ходим, лимиты — из строки статуса, как сейчас.
- **Тексты окна** — только английские, из `packages/desktop/src/shared/strings.ts`; страж —
  `english-ui`. Тексты для агента — английские (`agent-texts-en`).
- **Протокол только добавляется.** `PROTOCOL_VERSION` остаётся 1, новые методы — в
  `hello.methods`; окно без метода `feed.snapshot` вид «Chat» не предлагает
  (`renderer/lib/capabilities.ts`).
- **Версия CLI.** HTTP-хуки ленты пишутся в файл настроек только для `claude` не ниже
  `FEED_MIN_VERSION = 2.1.286` (версия стенда); для старого `claude` и для Codex вкладка
  открывается терминалом, переключатель недоступен с подсказкой.
- **Сеть.** Приёмник хуков слушает только 127.0.0.1, порт случайный, вход по токену; окно в
  сеть не ходит.
- **Контраст** — вторичный текст не ниже 4.5:1 в обеих темах (`styles/tokens.test.ts`),
  признак состояния не ниже 3:1. Иконки lucide — `strokeWidth` 2.75.
- **Тесты и E2E:** настоящий `claude` в автотестах не запускается, только стаб
  (`e2e/stub-echo-agent.mjs`); E2E работают в своих временных каталогах; буфер обмена,
  уведомления macOS, Finder и браузер человека не трогаются.
- **Коммиты и репозиторий:** коммиты по-русски, последняя строка — `Co-Authored-By`;
  стейджинг явными путями; `.omc/` и `.superpowers/` не коммитить; НИКОГДА не делать
  `git stash`; неотслеживаемый `packages/desktop/prototype/` не трогать.

## Review Focus

1. **Гонки решений.** Карточка висит, а человек ответил в терминале: хук получает пустой
   ответ, карточка помечается «answered in the terminal», второе нажатие в окне ничего не
   шлёт. Два клика подряд — одно решение. Хост перезапущен с висящей карточкой — ответ
   хуку не теряется молча: карточка stale, терминал показан.
2. **Длинные значения.** Команда на 2 000 символов, путь на 300, дифф на 5 000 строк,
   вывод инструмента на 2 МБ: карточка и элемент ленты не выталкивают кнопки за край,
   усечение явное. Проверять в 800×500 и 1400×900, обе темы.
3. **Скорость.** Ответ приёмника на `MessageDisplay` — не больше 10 мс (CLI держит порцию
   до ответа); лента в 2 000 элементов прокручивается без рывков (виртуализация);
   `feed.changed` — дельты, не весь список.
4. **Старые хост и CLI.** Окно с хостом без `feed.*` и хост с `claude` 2.1.28x ниже порога
   работают как сегодня: терминал, без ошибок в консоли. Окно 0.3.0 с хостом 0.2.0:
   уведомление «Host is outdated — restart» (0.2.0) показывается, вид Chat недоступен до
   перезапуска хоста.
5. **Рамка.** В коде хоста нет ветки, где решение `allow`/`deny` рождается без запроса
   `feed.decide` от окна. Файл настроек не содержит ничего, кроме хуков и строки статуса.
6. **Приёмник.** Чужой токен — 401 без тела; неизвестная сессия — 404; тело больше
   предела — 413; невалидный JSON — 400; всё это не роняет хост и не попадает в ленту.

## Как гонять

- **Ветка** — `feat/chat-view` от `master` (d2dfe32, релиз 0.2.0), в своём worktree: в
  основной рабочей копии лежат неотслеживаемые файлы соседней сессии
  (`docs/specs/2026-10-01-remote-access-design.md`, `.superpowers/`) — не трогать и не
  коммитить.
- **Кусок** — отдельный исполнитель на Opus 5.5 medium через Workflow, 1–2 задачи на кусок.
  Потом ревью-линзы с разными именами файлов отчётов; диф контролёр читает сам.
- **Порядок.** 1 → 2 → 3 → 4 → 5. Кусок 3 может стартовать после подкуска 2a (протокол),
  остальное хоста ему не нужно: окно тестируется на фикстурах ленты.
- **Перед каждым коммитом:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, тесты затронутых
  пакетов.
- **Перед закрытием куска** — прогоны по одному, не параллельно (ПК с 24 ГБ без swap):
  1. `pnpm -r --workspace-concurrency=1 --no-bail run test --maxWorkers=4 --minWorkers=1`;
  2. `pnpm --filter @parley/host build`;
  3. `pnpm --filter @parley/desktop build`;
  4. `pnpm --filter @parley/desktop e2e --workers=1`.
- **Известные флейки** — список плана комнат Organic («Как гонять») и TODOS, прогон 6:
  сверять по имени теста, не по факту красного прогона.
- **Визуальная сверка.** Playwright-снимки dev-сборки: вкладка сессии в чате и в терминале,
  карточка разрешения с длинной командой, карточка вопроса, дифф; 800×500 и 1400×900, обе
  темы.
- **Живая проверка** на настоящем `claude` — руками, после куска 5 (список в куске 5).

## Решения

1. **Транспорт — HTTP-хуки на хост.** В файл настроек работы (`core/work/settings-file.ts`)
   добавляются хуки `type: "http"` на `http://127.0.0.1:<порт>/hooks` с заголовками
   `Authorization: Bearer $PARLEY_HOOK_TOKEN` и `X-Parley-Session: $PARLEY_SESSION_ID`
   через `allowedEnvVars` (hooks, «HTTP hook fields»). Токен и порт живут столько, сколько
   хост; файл настроек переписывается при каждом запуске сессии, поэтому порт в нём всегда
   свежий. Файловый журнал `events/` с восемью прежними событиями остаётся как есть: по нему
   считается активность, и регрессий там быть не должно.
   События по HTTP: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `MessageDisplay`,
   `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
   `Stop`, `StopFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`,
   `PostCompact`, `PostModelSwitch`. Все без матчера, `PreToolUse` тоже: иначе лента не видит
   обычный вызов до его результата; на обычные вызовы хост отвечает мгновенно, ждут только
   вопрос и план. Таймауты: `PermissionRequest` и `PreToolUse` — 3600 с (ждём человека),
   `MessageDisplay` — умолчание 10 с, остальные — умолчание.
2. **Лента живёт на хосте.** `FeedService` держит на сессию кольцо до 2 000 элементов,
   собранных чистым редьюсером из core; окно получает `feed.snapshot` и дельты
   `feed.changed`. Если у живой сессии нет событий (хост перезапущен, сессия возобновлена),
   первый снимок хост сеет из журнала сессии тем же нормализатором — история без текста по
   мере вывода, но с вызовами, результатами и диффами. Пути `transcript_path` и
   `agent_transcript_path` из хуков хост читает только внутри корней истории Claude
   (`claudeProjectRoots`, как `activity/subagent-meta.ts` в 0.2.0); чужой путь не читается.
3. **Элементы ленты** (`FeedItem`, core): `prompt` (текст человека), `text` (ответ; растёт по
   `MessageDisplay` по `message_id`, закрывается `Stop` с полным текстом), `tool` (вызов:
   `running` → `done` | `failed` | `rejected`; аргументы, сводка результата, хунки диффа),
   `permission` (карточка: `pending` → `allowed` | `denied` | `elsewhere` | `stale`),
   `question` (карточка `AskUserQuestion`), `plan` (карточка `ExitPlanMode`), `error`
   (`StopFailure`), `notice` (старт, `/clear`, компакция, смена модели, субагент), `turn`
   (конец хода). Размышления (`thinking`) в v1 не показываем: по мере вывода их нет.
4. **Ответы — хуками.** Разрешение: `allow`, `deny` с текстом для модели, `allow` +
   `updatedPermissions` из `permission_suggestions` (пункт «don't ask again»); вопрос агента:
   `PreToolUse` → `allow` + `updatedInput` с исходными `questions` и `answers`. Оба пути
   проверены на стенде. План (`ExitPlanMode`): в куске 4 сначала проверить на стенде ответ
   хуком (`allow` + `updatedInput` с исходным `plan`); если работает — хук, если нет —
   клавиши с проверкой экрана (Enter / Down+Enter после «Ready to code?»), а третий вариант
   («Tell Claude what to change») — только через терминал.
5. **Снятие карточки без решения.** Хост отвечает хуку пустым `{}` и помечает карточку
   `elsewhere`, когда для той же сессии пришёл `PostToolUse`/`PostToolUseFailure` с тем же
   инструментом, `Stop`, `UserPromptSubmit`, `SessionEnd`, либо активность стала `idle`
   (журнал: отказ по Esc и прерывание не дают `Stop`). По таймауту 3600 с — `stale`:
   «answer in the terminal». При выключении хоста все висящие — `{}`.
6. **Вид вкладки.** У вкладки `terminal` появляется поле `view: 'chat' | 'terminal'`
   (раскладка, переживает перезапуск); для Claude по умолчанию `chat`, для Codex и старого
   `claude` — `terminal` без переключателя. Переключатель — сегмент «Chat | Terminal» в
   тулбаре вкладки; та же команда в палитре. Поверхность терминала (`SurfaceLayer`) видна
   только когда `view === 'terminal'`; в чате она не монтируется, `pty.detach`.
7. **Автопоказ терминала** — ровно один случай: до `SessionStart` вкладка показывает
   терминал, а после него один раз сама переходит в чат, если человек не трогал
   переключатель. Во всех прочих случаях (меню, elicitation, отказ по Esc, экран без
   карточки при `blocked`) чат показывает баннер «Claude Code is waiting in the terminal»
   с кнопкой «Open terminal» и обычную метку «нужен ты». Переключать вид под руками
   человека нельзя.
8. **Ввод.** Поле чата шлёт `pty.send` с теми же отказами и тостами, что у отправки из
   комнаты (`terminal/send.ts`: busy, blocked, draft). Enter — отправить, Shift+Enter —
   перенос. Кнопка «Stop» — Esc через `pty.input`. Сообщение во время хода уходит в очередь
   CLI, лента показывает его серым до `UserPromptSubmit`.
9. **Режим.** В строке состояния чата — текущий режим из последнего хука (`permission_mode`)
   и меню «Manual / Accept edits / Plan». Метод `sessions.setMode`: хост считает число
   `Shift+Tab` от текущего режима по циклу manual → accept edits → plan, жмёт по одному и
   после каждого сверяет подвал экрана своего headless-терминала («manual mode on»,
   «accept edits on», «plan mode on»); не сошлось — отвечает фактическим режимом и
   `verified: false`, окно просит открыть терминал. `plan` можно ставить и текстом `/plan`.
   Режимы `auto` и `bypassPermissions` в меню не предлагаем.
10. **Текст и результаты.** Markdown — `components/rooms/RoomMarkdown.tsx` и
    `lib/markdown-links.ts` (0.2.0), код моноширинный. Результат инструмента свёрнут;
    показываем до 64 КБ, дальше «truncated, open the terminal». Дифф — хунки
    `structuredPatch` с номерами строк и `+`/`−` цветами
    токенов review.
11. **Шум хуков** не показываем: `SubagentStop` с пустым `agent_type` и `PostModelSwitch` с
    `source: auto` — от генерации заголовка сессии и смены модели в плане. Субагенты с
    `agent_type` — карточка `agent` (решение 13).
12. **Приёмник.** Только POST `/hooks`, JSON до 16 МБ, `hook_event_name` из списка решения 1,
    сессия по заголовку `X-Parley-Session` среди живых сессий хоста, `session_id` тела
    сверяется с `providerSessionId`. Остальное — 400/401/404/413 без тела, в лог хоста.
13. **Субагенты: кто, сколько, зачем** (просьба пользователя 2026-10-01; проверено на стенде,
    `evidence/p6b-subagents`). Вызов `Agent` несёт `description`, `prompt`, `subagent_type`,
    `model`; с 2.1.198 субагенты фоновые по умолчанию: `PostToolUse(Agent)` приходит сразу
    (`status: async_launched`, `agentId`, `resolvedModel`), ход родителя заканчивается `Stop`
    со списком `background_tasks`, дальше идут вложенные хуки с `agent_id` и `agent_type`
    (каждый вызов инструмента субагента), потом `SubagentStop` с `last_assistant_message` и
    `agent_transcript_path`, а родитель просыпается `UserPromptSubmit`, чей `prompt`
    начинается с `<task-notification>` (`task-id` = `agentId`, `tool-use-id` = вызов
    `Agent`). Лента держит на сессию дерево агентов: карточка `agent` — тип, описание,
    модель, статус `running` → `done` | `failed`, длительность, число вложенных вызовов,
    итоговый текст, путь к журналу субагента; вложенные вызовы живут внутри карточки, а не
    в общем потоке; пробуждение `<task-notification>` — `notice` «agent reported», не промпт
    человека. Живые субагенты у всех окон уже есть с 0.2.0: `LiveMetrics.tasks` (id, тип,
    описание, фоновый) из файлового журнала и `meta.json` субагента, `heldByBackground` у
    сессии; участник комнаты показывает «Subagent: …» или «3 subagents: …» с полным списком
    в подсказке. Этот план добавляет сверху: карточку с историей и результатом в ленте, бейдж
    с поповером в строке сессии сайдбара (вместо `▤N`), переход из поповера к карточке и
    строку «N agents running» в тулбаре чата. Нового поля в метриках не нужно.
    `SubagentStop` с пустым `agent_type` — служебный, не показываем. Foreground-субагент
    (`run_in_background: false`) отдаёт в `PostToolUse` ещё `content`, `totalToolUseCount`,
    `totalDurationMs` — по документации, на стенде не гонялся.
14. **Протокол `feed.*` — общий с удалённым доступом.** Дизайн
    `2026-10-01-remote-access-design.md` считает задачи 1–2 своим этапом 0, а на телефоне
    решение рождается только из `feed.decide`. Поэтому элементы и решения — чистый JSON со
    схемами zod в `packages/protocol`; у ленты своя версия схемы (`FEED_SCHEMA_VERSION`,
    растёт только добавлением полей); размеры элементов ограничены (результат инструмента
    до 64 КБ, текст плана и вопроса целиком); `feed.snapshot` плюс дельты по `revision` —
    единственный способ чтения; `feed.decide` с `applied: false` — защита от устаревшего
    снимка. Ожидающая карточка сворачивается в сводку «нужен ты» одной строкой (инструмент
    и команда, файл или вопрос) — её возьмёт push.

## Task 1: core — модель ленты, нормализаторы, настройки хуков

**Файлы:**
- `packages/core/src/feed/types.ts`, `reduce.ts`, `from-transcript.ts`, `noise.ts`,
  `index.ts` (экспорт через `packages/core/src/index.ts`);
- `packages/core/src/feed/fixtures/` — копии `events.jsonl` проб `p1-stream`,
  `p2-permissions`, `p2b-hook-decisions`, `p3-modes`, `p4-questions-plan`, `p5b-write` из
  `docs/research/2026-10-01-chat-view-spike/evidence/` и 2–3 настоящих журнала сессий
  (обезличенные, как делает `tools/scrub-export.mjs`);
- `packages/core/src/work/settings-file.ts`, `launch.ts` (опция `hookUrl`),
  `work/feed-version.ts` (`FEED_MIN_VERSION`, `feedSupported`, рядом с `channel.ts`).

**Что сделать:**
1. **Типы** `FeedItem` по решению 3: у каждого — `id`, `at`, `kind`; у `tool` — `toolUseId`,
   `name`, `input`, `status`, `response?` (усечённая сводка + полный размер), `patch?`
   (хунки); у карточек — `cardId`, `state`, данные запроса (`tool_name`, `tool_input`,
   `permission_suggestions` | `questions` | `plan`); у `text` — `messageId`, `text`,
   `streaming`.
2. **Редьюсер** `applyHookEvent(state, event, at)` → `{ state, changes }`: чистый, порядок —
   порядок прихода. Разбор `background_tasks`, `agent_id`, `agent_type` и `transcript_path` —
   тот же, что у `work/events.ts` в 0.2.0: `parseTasks` и `textOf` вынести в экспорт, типы
   `BackgroundTask` и `EventRecord` переиспользовать. Правила: `UserPromptSubmit` →
   `prompt`; `MessageDisplay` → `text` по `message_id` (`final` закрывает); `Stop` →
   закрыть все `text` хода и подставить
   `last_assistant_message`, добавить `turn`; `PreToolUse` → `tool running` (и карточка
   `question`/`plan` для `AskUserQuestion`/`ExitPlanMode`); `PermissionRequest` → карточка
   `permission` при `tool`; `PostToolUse` → `done` + ответ/патч, снять карточки этого
   инструмента как `elsewhere`, если они ещё `pending`; `PostToolUseFailure` → `failed`;
   `StopFailure` → `error`; `SessionStart`/`SessionEnd`/`PreCompact`/`PostCompact`/
   `PostModelSwitch` (не `auto`) → `notice`; `Notification` — только `permission_prompt`
   как подсказка карточке; шум по решению 11 — отбросить. Кольцо — в хосте, редьюсер его
   не знает.
   Субагенты (решение 13): `PreToolUse(Agent)` → карточка `agent running` с описанием,
   типом и моделью; `SubagentStart` и `PostToolUse(Agent)` привязывают `agentId` (по
   порядку: первый `agent` без id); события с `agent_id` → вложенные элементы карточки, не
   общий поток; `SubagentStop` с типом → `done`, итоговый текст и `agent_transcript_path`;
   `PostToolUseFailure(Agent)` → `failed`; `Stop.background_tasks` — какие карточки ещё
   `running`; `UserPromptSubmit` с `prompt` от `<task-notification>` → `notice` «agent
   reported» с ссылкой на карточку по `tool-use-id`, а не `prompt`.
3. **Нормализатор журнала** `feedFromTranscript(records)`: `user` (строка, `text`, `image`
   → `prompt`; `tool_result` → закрытие `tool` с `toolUseResult`), `assistant` (`text` →
   `text`, `tool_use` → `tool`, `thinking` — пропуск), запись «[Request interrupted by
   user]» и «User rejected tool use» → `rejected`, `system/turn_duration` → `turn`,
   `queue-operation` — пропуск; `tool_use` `Agent` + `toolUseResult` с `agentId` → карточка
   `agent` (без вложенных вызовов — они в журнале субагента). Тот же нормализатор читает
   журнал субагента (`<сессия>/subagents/agent-<id>.jsonl`, записи с `isSidechain: true`)
   для раскрытой карточки. Поверх `adapter-v1.ts`, не вместо него.
4. **Настройки хуков.** `workSettings({ hookUrl, hookEvents })`: при `hookUrl` в `hooks`
   добавляются HTTP-обработчики по решению 1 (все без матчера, `PreToolUse` тоже), прежние
   `cat >>` остаются. `writeWorkSettings`
   и `planLaunch` принимают `hookUrl`; без него файл такой же, как сегодня.
5. **Порог версии** `feedSupported(version)` по `parseVersion` из `channel.ts`.

**Тесты:**
- редьюсер на фикстурах: ход p1 даёт 1 `prompt`, 1 `text` с 12 строками и `turn`; p2 —
  `tool` с карточкой `permission`, которая после `PostToolUse` становится `elsewhere`;
  p2b — `allowed`/`denied` после `decide`; p4 — `question` с ответом, `plan` с текстом;
  p5b — `patch` с хунком `-beta/+gamma`; шум p3 (`SubagentStop` без типа, `PostModelSwitch`
  auto) не даёт элементов; `/clear` закрывает ход; p6b — одна карточка `agent` «List
  project files» типа Explore с одним вложенным `Bash`, после `SubagentStop` — `done` с
  текстом, пробуждение `<task-notification>` — `notice`, а не `prompt`;
- нормализатор журнала на настоящих записях: порядок, диффы, прерывание, отказ, картинка;
- `settings-file`: с `hookUrl` есть HTTP-хуки с заголовками и `allowedEnvVars`, таймауты по
  решению 1, прежние хуки на месте; без `hookUrl` — файл побайтно прежний; рамочный тест
  про `~/.claude` остаётся зелёным;
- `feedSupported`: 2.1.285 — нет, 2.1.286 — да, мусор — нет.

**Готово:** `pnpm --filter @parley/core test` зелёный, экспорт из `@parley/core` собран.

## Task 2: host и protocol — приёмник хуков, решения, служба ленты

Подкуски: **2a** — протокол (типы и схемы, можно отдать окну сразу), **2b** — приёмник и
служба ленты, **2c** — запуск сессии с токеном и адресом.

**Файлы:**
- protocol: `methods.ts` (`feed.snapshot`, `feed.subscribe`, `feed.unsubscribe`,
  `feed.decide`; результат `hello.methods`), `events.ts` (`feed.changed`), `types.ts`
  (реэкспорт `FeedItem`, `FeedDecision`), тесты схем;
- host: `hooks/hook-server.ts` (node:http), `hooks/pending.ts` (ожидание решений),
  `feed/feed-service.ts`, `methods/feed.ts`, `methods/index.ts`, `host.ts` (сборка и
  порядок остановки), `context.ts`, `sessions/sessions-service.ts` (окружение агента и
  `hookUrl` по версии), `providers/versions.ts` (версия для порога).

**Что сделать:**
1. **Протокол.** `feed.snapshot { ref, agentId? } → { items, revision }` (с `agentId` —
   лента субагента, посеянная из его журнала; без него — лента сессии);
   `LiveMetrics.tasks` остаётся единственным списком живых субагентов (0.2.0), нового поля в
   метриках нет; схемы `FeedItem` и `FeedDecision` — zod, с `FEED_SCHEMA_VERSION`
   (решение 14);
   `feed.subscribe { ref } → { ok }` и `feed.unsubscribe`; `feed.decide { ref, cardId,
   decision }`, где `decision` — `{ kind: 'permission', behavior: 'allow' | 'deny',
   always?: true, message? }` | `{ kind: 'question', answers: Record<string, string> }` |
   `{ kind: 'plan', choice: 'auto-accept' | 'manual' }` → `{ applied: boolean, state }`
   (`applied: false`, если карточка уже не `pending`). Событие `feed.changed { ref,
   revision, upsert: FeedItem[], removed: string[] }` — только подписчикам.
2. **Приёмник.** Слушает `127.0.0.1:0`; токен — 32 байта `randomBytes` на старт хоста;
   проверка по решению 12; ответ — сразу `{}` для всех событий, кроме ожидающих решения.
   Для `PermissionRequest` и `PreToolUse` c `AskUserQuestion`/`ExitPlanMode` — `pending`:
   запись `{ ref, cardId, respond }`; `respond` зовут `feed.decide` (JSON решения по
   решению 4), снятие по решению 5 (`{}`), таймаут 3600 с (`{}` + `stale`), выключение
   (`{}` всем). Тело ограничено 16 МБ; разбор JSON — в `try`, ошибка — 400.
3. **Служба ленты.** На сессию: состояние редьюсера, кольцо 2 000, `revision`. Источники:
   приёмник, `feed.decide` (меняет состояние карточки), активность хоста (`idle` снимает
   карточки по решению 5), `pty.exit` (закрыть ход, карточки → `stale`). `feed.snapshot`
   без живых событий сеет из журнала через `log-index` (`transcript_path` сессии) один раз.
   `feed.changed` шлёт дельты подписчикам того же клиента, что подписался (как `pty.output`
   в `methods/pty.ts`). Пути журналов из хуков (`transcript_path`, `agent_transcript_path`)
   перед чтением проверяются по `claudeProjectRoots` (решение 2); живых субагентов для
   сайдбара и комнаты по-прежнему считает сервис активности из файлового журнала
   (`LiveMetrics.tasks`, 0.2.0).
4. **Запуск.** `sessions-service`: в `plan.env` добавляется `PARLEY_HOOK_TOKEN`; `hookUrl`
   передаётся в `planLaunch`/`planResume` только для `claude` с `feedSupported(version)`
   (версия — из `providerVersions`; нет версии — хуков нет, окно увидит терминал).
   `hello.methods` перечисляет `feed.*`.

**Тесты:**
- приёмник: 401/404/413/400; верное событие доходит до службы с `ref`; `MessageDisplay`
  получает ответ за < 10 мс в тесте; `pending` отвечает решением из `decide`, пустым по
  `PostToolUse`, по таймауту (фальшивые таймеры) и при `stop()`;
- служба: снимок, дельты, кольцо (2 001-й элемент вытесняет первый, `removed` в событии),
  сев из журнала на фикстуре, `idle` снимает карточку, `decide` на не-`pending` → `applied:
  false`; снимок субагента по `agentId` из его журнала; путь вне корней истории Claude —
  `not_found`, файл не читается;
- `sessions-service`: окружение содержит токен; файл настроек с `hookUrl` для 2.1.286 и
  без него для 2.1.280 и для codex;
- `server.test.ts`: `feed.*` в `hello.methods`.

**Готово:** `pnpm --filter @parley/host test` и `build` зелёные; `pnpm --filter
@parley/protocol test` зелёный.

## Task 3: окно — вид «Chat»: лента, поле ввода, переключатель

**Файлы:**
- `renderer/chat/`: `ChatView.tsx`, `FeedList.tsx` (виртуализация), `items/PromptItem.tsx`,
  `TextItem.tsx`, `ToolItem.tsx`, `DiffHunks.tsx`, `NoticeItem.tsx`, `ErrorItem.tsx`,
  `TurnItem.tsx`, `Composer.tsx`, `ChatToolbar.tsx` (сегмент, режим, модель, Stop),
  `store.ts` (ленты по `refKey`, подписка при открытии, отписка при закрытии вкладки),
  `use-feed.ts`;
- `layout/bodies/TerminalBody.tsx` (рендерит `ChatView` при `view === 'chat'`),
  `layout/SurfaceLayer.tsx` (поверхность только при `view === 'terminal'`),
  `shared/layout-types.ts` (`view?`), `layout/tree.ts`, `layout/persistence.ts` (старая
  раскладка без `view` читается, умолчание по провайдеру), `layout/tab-meta.ts`;
- `lib/capabilities.ts` (`feed.snapshot`), `palette/` (команда «Toggle chat / terminal»),
  `shared/keybindings.ts`, `shared/strings.ts`.

**Что сделать:**
1. **Поле `view`** у вкладки `terminal`; умолчание — `chat` для Claude, `terminal` для
   остальных и для сессий без `feed.*` у хоста (решение 6). Переключатель — сегмент в
   тулбаре вкладки; для Codex и старого CLI сегмент выключен с тултипом.
2. **Лента.** Список элементов по решению 3 и 10: промпт справа на `--sheet`, текст ответа
   markdown, вызов инструмента — строка с именем и сводкой (`Bash` — команда, `Edit`/`Write`
   — путь, `Read` — путь, MCP — имя инструмента), раскрывается в аргументы и результат;
   дифф — хунки; `turn` — тонкая черта с длительностью; `error` — красная карточка с
   текстом. Текст по мере вывода — тот же элемент, курсор-индикатор пока `streaming`.
   Автопрокрутка к концу, пока человек у края; иначе кнопка «Jump to latest».
   Карточка `agent` (решение 13): свёрнуто — значок типа, описание задачи, модель, статус
   со спиннером, «N tool calls», длительность; развёрнуто — вложенные вызовы живьём,
   итоговый текст, кнопка «Show transcript» (подгружает `feed.snapshot { ref, agentId }`
   в ту же область). Несколько агентов одной пачки — стопкой; после конца хода родителя
   карточки с `running` остаются живыми, пока не придёт `SubagentStop`.
3. **Поле ввода** по решению 8: textarea на 1–8 строк, Enter/Shift+Enter, кнопка Send,
   пока ход идёт — «Queue» и серый элемент в ленте до `UserPromptSubmit`. Отказы
   `pty.send` — тосты из `terminal/send.ts` без изменений.
4. **Тулбар**: сегмент Chat/Terminal, режим (текст, меню — кусок 4), модель из `notice`
   старта и `PostModelSwitch`, кнопка Stop (Esc через `pty.input`, видна пока ход идёт).
5. **Поверхность терминала** не монтируется в чате; при переходе в терминал — обычный
   `pty.attach` со снимком. Переход назад — `pty.detach`.

**Тесты:**
- компоненты на фикстурах из core: все виды элементов, усечение результата 64 КБ, дифф
  5 000 строк рендерится виртуально, `streaming` индикатор, автопрокрутка и «Jump to
  latest»; карточка `agent` в трёх состояниях, с длинным описанием и с 50 вложенными
  вызовами, «Show transcript» подгружает ленту субагента;
- store: подписка при открытии вкладки, отписка при закрытии, дельты применяются по
  `revision`, устаревшая дельта отбрасывается;
- `SurfaceLayer`: поверхность есть только при `view === 'terminal'`; `persistence`: старая
  раскладка получает `view` по умолчанию;
- `capabilities`: без `feed.snapshot` вкладка открывается терминалом, сегмента нет;
- `english-ui` зелёный.

**Готово:** окно собирается, тесты зелёные; снимки: чат с текстом, вызовами и диффом в
обеих темах; переключение в терминал и обратно без потери экрана.

## Task 4: карточки, режим, автопоказ терминала

Подкуски: **4a** — карточки, режим, автопоказ (пункты 1–5); **4b** — агенты в сайдбаре,
комнате и тулбаре (пункт 6), идёт после 2b.

**Файлы:**
- `renderer/chat/cards/PermissionCard.tsx`, `QuestionCard.tsx`, `PlanCard.tsx`,
  `WaitingBanner.tsx`; `chat/store.ts` (решения, идемпотентность);
- `renderer/attention/derive.ts` (ожидающая карточка — «нужен ты» вкладки и работы);
- protocol: `sessions.setMode { ref, mode } → { mode, verified }`;
- host: `pty/screen.ts` (`text(rows)` — последние строки экрана без управляющих
  последовательностей), `pty/mode-switch.ts`, `methods/sessions.ts`;
- `shared/strings.ts`, `renderer/layout/bodies/TerminalBody.tsx` (автопоказ);
- 4b: `renderer/components/AgentsBadge.tsx` (бейдж «N agents» с поповером из
  `metrics.tasks`: тип, описание, фоновый; «Open» ведёт в карточку ленты),
  `renderer/lib/metrics-line.ts` (`▤N` → бейдж), строка сессии в сайдбаре (`sidebar/`),
  `components/rooms/ParticipantStrip.tsx` (строка «Subagent: …» из 0.2.0 получает тот же
  поповер), `chat/ChatToolbar.tsx` («2 agents running»).

**Что сделать:**
1. **Карточка разрешения.** Из `tool_input`: `Bash` — команда моноширинно и описание;
   `Edit`/`Write` — путь и дифф/содержимое; MCP — имя сервера и инструмента, аргументы
   JSON свёрнуто. Кнопки: «Allow», «Allow and don't ask again» (есть только при
   `permission_suggestions` с `addRules`; шлёт `always: true`), «Deny» с полем «Tell Claude
   what to do instead» (пусто — без `message`). После решения карточка остаётся в ленте со
   своим состоянием; `elsewhere` — «answered in the terminal», `stale` — «waited too long,
   answer in the terminal».
2. **Карточка вопроса.** Заголовок, вопрос, варианты с описаниями, `multiSelect`, поле
   «Other» (свободный текст — как вариант «Type something» в CLI); несколько вопросов — по
   очереди; «Submit» шлёт `answers`.
3. **Карточка плана.** Markdown плана, кнопки «Approve, auto-accept edits», «Approve,
   approve each edit», «Change the plan in the terminal» (открывает терминал). Сначала —
   проверка на стенде (`docs/research/2026-10-01-chat-view-spike/`, новый сценарий): ответ
   хуком `PreToolUse(ExitPlanMode)` `allow` + `updatedInput` с исходным `plan`. Работает —
   хост отвечает хуком; нет — хост жмёт клавиши после сверки «Ready to code?» на своём
   экране (решение 4). Результат проверки — в отчёт разведки и в этот план.
4. **Режим** по решению 9: меню в тулбаре, `sessions.setMode`, на `verified: false` — тост
   «Open the terminal to switch the mode».
5. **Автопоказ** по решению 7: до `SessionStart` вкладка новой сессии открывается
   терминалом; после первого `SessionStart` — чат, один раз. Баннер «Claude Code is waiting
   in the terminal» при `blocked` без `pending`-карточки и при `Notification` с типами
   `elicitation_*`. Ожидающая карточка = «нужен ты» в `derive.ts` (как ожидание решения
   комнаты).
6. **Агенты в сайдбаре, комнате и тулбаре** (решение 13). Источник — `metrics.tasks` из
   `activity.changed` (0.2.0); нет поля — прежний счётчик `▤N`. Строка сессии в сайдбаре:
   бейдж «2 agents» с поповером (тип, описание, фоновый или нет). Полоса участников
   комнаты уже пишет «Subagent: …» и «3 subagents: …» с подсказкой — добавить тот же поповер
   и переход: клик по строке открывает вкладку сессии на карточке агента. Тулбар чата:
   «2 agents running» → прокрутка к первой `running`-карточке. Пока сессию держат только
   фоновые субагенты (`heldByBackground`), поле ввода открыто, кнопки «Stop» нет.

**Тесты:**
- карточки: три состояния каждой, длинные команды и пути, «Allow and don't ask again»
  появляется только с подсказкой, второй клик не шлёт `decide`;
- `derive.ts`: `pending` даёт `needs-you`, `elsewhere` снимает;
- host: `mode-switch` на фальшивом экране — manual → plan это два нажатия, подвал не
  сошёлся → `verified: false`; `screen.text()` режет управляющие последовательности;
- автопоказ: вкладка без `SessionStart` — терминал; после `SessionStart` — чат; если человек
  переключил сам — не трогаем;
- 4b: бейдж в строке сессии и поповер у участника комнаты из `metrics.tasks`; без поля —
  `▤N`; поповер с длинным описанием в 800×500; `heldByBackground` прячет «Stop» и не
  блокирует ввод.

**Готово:** снимки карточек в обеих темах, 800×500; сценарий «запрос → Allow в окне →
результат в ленте» проходит на стабе (кусок 5 добавит E2E).

## Task 5: E2E, стаб, живая проверка, документы

**Файлы:**
- `packages/desktop/e2e/stub-echo-agent.mjs` (HTTP-хуки), `e2e/chat-view.spec.ts`,
  `e2e/fixtures/feed/`;
- `README.md` (раздел «Chat view»; «Subagents and waiting» из 0.2.0 дополнить карточкой
  агента), `CHANGELOG.md` (`## 0.3.0` с «Updating from 0.2.x»: после установки окно само
  попросит перезапустить хост), `TODOS.md` (прогон 18 — сделанное и хвосты), отчёт
  разведки (результат проверки плана из куска 4).

**Что сделать:**
1. **Стаб.** Читает путь `--settings` из argv, находит HTTP-хук и заголовки; строка
   `STUB_HOOK <json>` в терминале — POST события на хост от имени сессии; ответ хоста стаб
   печатает как `HOOK<<json>>` (так E2E видит решение). Без HTTP-хука в файле — как сегодня.
2. **E2E** (`--workers=1`): вкладка Claude открывается чатом после `SessionStart`, до него
   — терминал; текст по порциям `MessageDisplay` виден по мере прихода; `PreToolUse` +
   `PostToolUse` дают элемент с результатом и диффом; `PermissionRequest` → карточка →
   «Allow» → стаб печатает `HOOK<<{"hookSpecificOutput"…"allow"}>>`; «Deny» с текстом;
   карточка вопроса → ответ → `answers` у стаба; последовательность `Agent` →
   `SubagentStart` → вложенный `Bash` с `agent_id` → `SubagentStop` даёт карточку агента
   «running» → «done» с текстом, бейдж «1 agent» в сайдбаре и у участника комнаты, поповер с
   описанием; переключатель Chat/Terminal и обратно;
   хост без `feed.*` (старый стаб-хост не нужен: достаточно `capabilities` на подменённом
   `hello`) — терминал без ошибок; длинная команда в 800×500 — кнопки видны.
3. **Живая проверка** руками на настоящем `claude` (как прогон 2 TODOS): запуск в
   недоверенной папке (терминал → чат), ход с текстом, Bash с разрешением из окна, отказ с
   текстом, вопрос агента, план, смена режима, `/clear`, прерывание Esc в терминале при
   открытом чате, выключение хоста с висящей карточкой; субагент Explore и два
   параллельных агента в комнате из двух сессий — бейджи и поповеры у обоих участников.
4. **Документы.** README: что такое вид Chat, что остаётся в терминале, порог версии CLI,
   рамка (решения человека, никаких автоответов). CHANGELOG 0.3.0 — «Added» и «Updating from
   0.2.x». TODOS: прогон
   18 отмечен, хвосты — Codex, `thinking`, elicitation, ответ на план хуком (если не
   вышло), картинки во вводе.

**Готово:** все пакеты зелёные, E2E зелёный, живая проверка пройдена человеком, документы
обновлены.

## Прогресс

- [ ] Task 1 — core: модель ленты, нормализаторы, настройки хуков
- [ ] Task 2a — протокол `feed.*`
- [ ] Task 2b — приёмник хуков, ожидание решений, служба ленты
- [ ] Task 2c — запуск сессии с токеном и адресом, порог версии
- [ ] Task 3 — окно: вид «Chat», лента, поле ввода, переключатель
- [ ] Task 4a — карточки разрешения, вопроса и плана; режим; автопоказ терминала
- [ ] Task 4b — агенты в сайдбаре, комнате и тулбаре
- [ ] Task 5 — E2E и стаб, живая проверка, документы
