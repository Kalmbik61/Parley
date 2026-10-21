# Codex в Parley: доверие к папке карточкой, политика одобрений и песочницы по ролям, короткий набор инструментов — дизайн

Дата: 2026-10-21. Статус: написана по итогам сверки с апстримом Orca (main, 1.4.214, выгружен 2026-10-21) и разговора с человеком 2026-10-21; прошла проверку строителем (десять вопросов разобраны ниже, расхождения с кодом исправлены); спайк 0 выполнен 2026-10-21 на `codex-cli 0.162.0` с разрешения человека — флаг доверия и `approvals_reviewer` работают (4.3); решения 9 и 11 подтверждены человеком 2026-10-21; план — `docs/specs/2026-10-21-codex-trust-policy-tools-plan.md`. Код Parley читался по `origin/master` на 2026-10-21 (в нём уже этапы A и B помощника и Telegram и `default_tools_approval_mode="approve"` у сервера `parley`).

Связано:
- остров одобрений — `docs/specs/2026-10-12-island-design.md` (v0.12.0); запросы действий Codex на острове — коммит `4edd9c5c` (2026-10-18, в master);
- остров для всех провайдеров — `docs/specs/2026-10-14-island-providers-design.md` (ветка `feat/island-providers`, не влита; отсюда берётся только мысль о переключателе «ответы через Parley» по провайдеру);
- помощник и Telegram — `docs/specs/2026-10-19-assistant-control-telegram-design.md`, этапы A и B в master; живой приёмки Telegram с настоящим ботом не было;
- исследование Codex — `docs/research/2026-09-29-codex-research.md` (разделы 6.2, 7, 8, 13), стенд токенов — `docs/research/2026-10-04-parley-token-benchmark.md` («Codex в журнале»: code mode);
- зависание `exec` на неотвеченном одобрении — заметка памяти 2026-10-16, сторож `codex-call-wait` в master.

## 1. Зачем

Три жалобы человека на Codex в Parley: просит разрешение на каждом шаге; ходит вокруг задачи, не вызывая нужные инструменты или вызывая их с ошибками; зацикливается на одном вызове. Сверка с Orca показала, что у них этих проблем нет, но ценой нарушения нашей рамки: Codex там запускается с `--dangerously-bypass-approvals-and-sandbox`, доверие к папке Orca дописывает в `config.toml` человека сама, хукам выдаёт доверие сама, а оркестрацию ведёт пятью шелл-командами с примерами вместо MCP.

Корни у нас:
- **одобрения**: запуск `-a on-request` без доверия к папке. Непомеченную папку Codex считает недоверенной, экран доверия остаётся человеку в терминале, а песочница становится `read-only`, и каждая запись идёт через одобрение. Роли только для чтения получают `sandbox_mode="read-only"` явно, и любая команда с записью тоже спрашивает. Хуки Codex по умолчанию выключены, поэтому вопрос висит в TUI, которого человек не видит;
- **кружение и ошибки вызовов**: Codex получает около 40 инструментов MCP, 14 строк политики и гид на 37 КБ, а зовёт инструменты из JS-ячейки (`tools.mcp__parley__get_map({})`) без единого примера;
- **зацикливание**: после каждого хода печатается указатель «New messages (N)… Call check_inbox.», а правила «после report остановись» нет; часть «зависаний» — ожидание неотвеченного одобрения в `exec`.

Цель: сессия Codex в Parley стартует без экрана доверия, спрашивает человека только там, где это задано ролью и настройкой, а координируется коротким набором инструментов с примерами вызовов. Рамка не меняется: Parley не выдаёт доверие себе, не пишет в чужие каталоги и не снимает песочницу целиком.

## 2. Что сейчас (по коду)

- Запуск Codex (`core/src/providers.ts`, `CODEX_PARLEY_FLAGS`): `--no-daemon -a on-request -c mcp_servers.parley={…} -c developer_instructions=… [-c sandbox_mode="read-only"] -c project_doc_fallback_filenames=["CLAUDE.md"] -c tui.* [-c hooks.* при codexApprovals] [lean] --model … -c model_reasoning_effort="…" <бриф>`. При `resume` — те же `-c` без `-a` и `--no-daemon`. Доверие к папке не передаётся («экран доверия проходит человек в терминале Codex»); `projects` нигде в коде нет.
- Доверие у самого Codex (исследование, 6.2): экран «Folder access» показывается, когда ни папка, ни корень репозитория не помечены в `projects`; для связанных worktree доверие берётся у корня основного репозитория (`git-utils/src/trust.rs`). Доверие включает проектные слои `.codex/` (конфиг, хуки, правила, MCP-серверы репозитория).
- Песочница (`core/src/roles/catalog.ts`, `prepareSessionRole`): `read-only` у ролей с `readOnly: true` (feature-lead, planner, architect, critic, reviewer, researcher) и у ролей Codex из `.codex/agents/*.toml` с таким `sandbox_mode`; у остальных флага нет, и Codex берёт умолчание по доверию.
- Шаблон запуска (`core/src/work/agents.ts`, `nativeConfigArgs`): родная проекция принимает только известные подстановки `-c` (`{mcpConfig}`, `{developerInstructions}`, `{notify}`, `{skillCatalog}`, `{sandbox}`, усилие); любая другая пара с `{` делает проекцию `unsupported`, и роли Codex из `.codex/agents` с навигатором скиллов молча не проверяются.
- Хуки Codex: только при `codexApprovals` (`core/src/config.ts`, по умолчанию `false`; Settings → Agents, «Answer Codex approvals in Parley»); доверие хуку человек выдаёт в Codex через `/hooks` один раз; без хука через 15 с (`CODEX_HOOK_GRACE_MS`) `decisions = 'terminal'`.
- Остров (`desktop/src/renderer/island/requests.ts`, `shared/island.ts`, `ISLAND_ATTENTION_ONLY_PROVIDERS`): запросы действий Codex показываются; есть карточка — кнопки, нет — строка «answer in terminal» и «Open terminal». Очередь `requests.ts` строится по сессиям в состоянии «ждёт» (`ref` обязателен); карточки помощника и решения по комнате живут отдельно (`AssistantView`, `assistant.decide`).
- Telegram (`host/src/telegram/`, в master): `CardRecord` — `feed` / `room` / `assistant`; карточку ленты шлёт при `decisions !== 'terminal'` без проверки провайдера (`service.ts:422`, `:686`); кнопки — `pc1:<shortId>:<code>` (`callbacks.ts`); переключатели `telegramEnabled`, `telegramNeedsYou`, `telegramFinished`, `telegramMail`, `telegramCards`.
- Инструменты (`core/src/mcp/tools.ts`, `createParleyServer`): всегда `TOOLS` (17 из `tools.ts` + `publish_agent_plan` + `plan_update` / `plan_submit` / `plan_verify`), при канале агента — 14 `browser_*`, при канале сессии — `create_session`, при навигаторе — `find_skill`. Сервер знает сессию по `PARLEY_WORK_DIR` и `PARLEY_SESSION_ID`, провайдера не знает. `backlog_list` / `backlog_suggest` названы в текстах ведущим: системное письмо о завершении плана (`work/plan-effects.ts:138`), плейбук рецепта review (`recipes/builtin.ts`), раздел `plans` гида.
- Слой сессии Codex: `-c developer_instructions=…` (`core/src/work/session-layer.ts`); блоки — политика `stableGuidance` (14 строк, потолки 4 КБ / 8 КБ, `context-budget.ts`), роль, `bridge` (`CODEX_APPROVAL_GUIDANCE` + подсказка про CLAUDE.md), правило браузера, бриф, PARLEY.md, память; аргумент ≤ 96 КиБ.
- Code mode Codex (проба 2026-10-06, codex-cli 0.160): каждый вызов инструмента — запись `custom_tool_call` с `name: exec`, в `input` JS-код, инструменты видны как `tools.mcp__parley__<имя>(…)`. События одобрений в rollout не пишутся.
- Жизненный цикл сессии (`core/src/work/session-state.ts`): `pending | active | sleeping | closed`. Запуск (`host/src/sessions/sessions-service.ts`, `launch()`): резерв бюджета (`reserveLaunch`), worktree, скилл, `PARLEY.md`, потом `planLaunch` / `planResume` / `planNew` и процесс; cwd — `session.worktree?.path ?? projectPath`. Подъём спящей письмом — `host/src/wake/wake-service.ts` (`isResourceDenial` — отказ без письма о сбое, `resumeFailed` — письмо отправителям). `create_session` (`core/src/mcp/session-tools.ts`) ждёт ответ хоста до 120 с и отдаёт `{sessionId, provider}`. CLI `parley-core work session new` процесс не запускает: печатает команду, окружение и cwd (`launchedBy: 'cli'`).
- Проект появляется вместе с первой работой: папку выбирает диалог каталога в main (`desktop/src/main/index.ts`, `showOpenDialog`), записи «проект» у хоста нет; состояние проекта — `<проект>/.parley`, состояние человека — `parleyHome()` (`core/src/work/store.ts`; атомарная запись — `tmp` + `rename`, `store.ts:306`; `config.json` пишется обычным `writeFile`).

Что делает Orca (для справки, не для копирования): `shared/tui-agent-permissions.ts` (YOLO по умолчанию, Auto = `--approve-for-me`), `main/agent-trust-presets.ts` (`markCodexProjectTrusted` пишет `[projects."<realpath>"] trust_level = "trusted"` во все config.toml), `main/codex/codex-structured-permission-policy.ts` (full-access = `never` + `danger-full-access`; auto = `on-request` + `workspace-write` + `auto_review`; ask = `on-request` + `workspace-write` + `user`, все поля всегда явно), `main/runtime/orchestration/preamble.ts` (команды с примерами у правила, heartbeat 5 мин, «после worker_done — стоп, никаких циклов check»).

## 3. Решения

Решения человека (разговор 2026-10-21):

| # | Вопрос | Решение |
| --- | --- | --- |
| 1 | Доверие к папке | Обязательное согласие человека, когда папка входит в workspace; без согласия сессии Codex в ней не стартуют |
| 2 | Где спрашивать | В окне при выборе папки; если запуск пришёл не от человека и согласия нет — карточка на острове сверху и, при привязанном Telegram, в Telegram с кнопками |
| 3 | Рамка | Parley не выдаёт доверие себе и не пишет в `~/.codex/config.toml`; согласие хранится у Parley и передаётся Codex при запуске |
| 4 | Политика Codex | По ролям: исполнителям явная `workspace-write` и авторевьюер Codex без хука (режим auto), ролям только для чтения — `read-only`; карточки острова через хуки остаются там, где человек хочет решать сам |
| 5 | Инструменты | Урезанный набор для Codex и примеры вызовов в слое; правило «после report — стоп» |
| 5а | Claude и браузер | Три браузерных инструмента `parley` (`browser_evaluate`, `browser_cookies`, `browser_storage`) у Claude Code тоже без вопросов — только они, остальное у Claude как есть (5.4) |

Мои выборы (строитель и человек видят их как мои; меняются при просмотре):

| # | Выбор | Почему |
| --- | --- | --- |
| 6 | Согласие — на проект; worktree покрыты | Codex сам берёт доверие worktree у корня основного репозитория (6.2); Parley передаёт и путь проекта, и cwd (4.3), когда они различаются. Спайк: экран снимает и ключ на корень, и ключ на сам worktree |
| 7 | Запись согласия — `parleyHome()/trust.json` по realpath | Доверие — свойство человека, не проекта: в `<проект>/.parley` оно уехало бы коллегам по репозиторию |
| 8 | Codex получает доверие флагом `-c projects={…}` | Слой конфига без записи в файл; форма из исследования (13.2); живая проверка — спайк 0 |
| 9 | Роли только для чтения: `approval_policy="never"` + `sandbox_mode="read-only"` | Не спрашивать вовсе: записи отвергает песочница, роль их и так запрещает. Исследование отвергало `never` из-за одобрений инструментов `parley` — с `default_tools_approval_mode="approve"` (в master) причина ушла. **Подтверждено человеком 2026-10-21** |
| 10 | Политика через `-c approval_policy` / `approvals_reviewer` / `sandbox_mode`, а не `-a` | Одни и те же ключи при запуске и `resume`; `-c` глобален и проверен, `-a` после `resume <id>` не проверен |
| 11 | Настройка `codexWriteApprovals: 'auto' \| 'parley' \| 'terminal'` вместо булевой `codexApprovals`; умолчание `auto` | Три честных режима для пишущих ролей; перенос: `true` → `parley`, `false` → `terminal`. **Умолчание `auto` подтверждено человеком 2026-10-21** |
| 12 | Профиль инструментов `short` для Codex: без `remember`, `memory_read`, `search_history` и без строки политики о них | Три инструмента «по желанию»; `backlog_*` остаются — их велят звать письма ведущим планов, плейбук review и гид. Сокращение небольшое, главный рычаг — примеры и правило остановки (6.2) |
| 13 | Примеры — отдельный блок слоя для Codex рядом с `CODEX_APPROVAL_GUIDANCE`, политика 14 строк общая | Не трогать общий текст и его потолки; примеры нужны только code mode |
| 14 | Порядок исполнения: спайк 0 → политика → инструменты и примеры → доверие (диалог, запись, флаг) → карточка (остров, Telegram) | Политика и примеры не зависят от спайка; доверие ждёт его результата |
| 15 | Удержание запуска — только у Codex; диалог в композере — для любой папки | Согласие сегодня меняет только запуск Codex; держать Claude и GLM не за что, а спящие Claude-сессии прежних проектов после обновления встали бы зря |
| 16 | Проверка согласия — до любого побочного действия запуска; удержание — отдельный исход, не ошибка | До резерва бюджета, worktree, скилла и `PARLEY.md`; wake-service не шлёт письма о сбое, `create_session` отвечает сразу |
| 17 | Удержанные запуски хранятся рядом с карточкой: `{ref, mode}` | После перезапуска хоста `allow` их продолжит; параметры берутся из записи сессии и писем, стартовый промпт тихого запуска не хранится |
| 18 | `auto` требует Codex не ниже 0.162.0 (версия спайка); ниже — `terminal` с диагностикой | Незнакомый ключ конфига сорвал бы старт каждой сессии; «безопасная сторона на старых CLI» |
| 19 | В режиме `parley` хуки получают все роли Codex, и только для чтения тоже | `Stop`, `SessionStart`, раннее «идёт» нужны и им; у `never` запросов разрешений просто не бывает |
| 20 | Диалог доверия говорит о проектных слоях `.codex/` прямо | Человек соглашается на конфиг чужого репозитория бессрочно и для всех worktree — он должен это прочитать |
| 21 | Провал спайка 0 — раздел 4 целиком откладывается | Согласие, которое нечем применить, было бы бутафорией; разделы 5–6 от спайка не зависят |

Вне объёма (раздел 8): экран доверия Claude Code, `danger-full-access` и `--dangerously-bypass-approvals-and-sandbox`, переопределение политики на сессию, heartbeat и сторож «завис», вопросы и планы Codex (`request_user_input`), app-server, предложение согласия помощником, удержание запусков, которые печатает CLI.

## 4. Доверие к папке

### 4.1 Запись

`parleyHome()/trust.json`, владелец — хост, запись атомарная по образцу `work/store.ts` (`tmp` + `rename`):

```json
{ "version": 1,
  "folders": { "/Users/me/Desktop/proj": { "grantedAt": "2026-10-21T10:00:00Z", "by": "window" } } }
```

Ключ — realpath папки проекта (`fs.realpath`, как у Orca: `/tmp` и `/private/tmp` — одна папка). `by` — `window | island | telegram`. Отзыв — удаление записи в Settings → Projects (список папок с кнопкой Revoke); отозванное согласие действует на следующий запуск, живые сессии не трогаются.

Согласие покрывает проект и все сессии его работ, включая worktree (`session.worktree.path`), где бы те ни лежали: принадлежность решается записью сессии в карте проекта, не путём. Папка, которую человек открыл как второй проект (например, сам worktree), — отдельный проект и отдельное согласие.

### 4.2 Когда и где спрашивать

1. **Окно.** В композере новой работы после выбора папки без записи в `trust.json` — модальный диалог «Trust <папка> for agents?». Текст: Codex в этой папке и её worktree стартует без своего экрана доверия, получает запись в рабочую папку (`workspace-write`) и выполняет конфигурацию самого репозитория из `.codex/` (конфиг, хуки, правила, MCP-серверы); согласие действует, пока его не отозвать в Settings → Projects; для Claude Code пока ничего не меняется (раздел 8). Кнопки Trust / Cancel; Cancel возвращает в композер без работы. Это и есть «обязательное согласие»: без него работа не создаётся, какой бы провайдер ни был выбран.
2. **Запуск Codex не от человека.** Сессия Codex стартует, а согласия на её проект нет: `create_session` агента, автозапуск, подъём спящей сессии письмом, `resumeInterrupted` на старте хоста, проекты из прежних версий (перенос: записей нет — спрашиваем при первом таком запуске). Запуск останавливается до решения, прежде чем `launch()` займёт бюджет, создаст worktree, поставит скилл или напишет `PARLEY.md`: карта не меняется, сессия остаётся `pending` (новая) или `sleeping` (подъём). Хост заводит карточку согласия (4.4) и запоминает удержанный запуск. Запуски Claude, GLM и своих провайдеров не удерживаются (решение 15).
   - `launch()` отдаёт новый исход `held: 'folder-trust'` (не исключение). `create_session` отвечает сразу `{ sessionId, provider, held: 'folder-trust' }` и текстом «The session waits for the human to trust the folder; it starts by itself after that» — в 120 с ожидания не упирается. Wake-service считает удержание отказом без письма о сбое: письма остаются непрочитанными, как при `isResourceDenial`, и подъём повторяется, когда согласие придёт.
   - Allow — хост продолжает все удержанные запуски этой папки: `pending` — `launch`, `sleeping` — обычный путь подъёма (письма по-прежнему непрочитанные). Deny — новая сессия закрывается с итогом `failed` и системной заметкой «launch refused: folder not trusted», создателю-агенту уходит письмо `note` с той же фразой; спящая не поднимается, письма ждут.
   - Окно и остров узнают об удержании из карточек (`consents.list`, поле `requestedBy`): отдельного поля в активности сессии нет — снимки активности есть только у живых процессов. В главном окне у такой сессии строка «waiting for folder trust» с кнопкой, открывающей карточку.
3. Если главное окно открыто и впереди, диалог из п. 1 показывается и для п. 2 (окно подписано на `consents.changed`); карточка на острове и в Telegram появляется всё равно, ответ в любом месте закрывает остальные (как у карточек ленты).

Запуск, который печатает CLI (`parley-core work session new`), не удерживается: процесс поднимает человек сам и экран доверия видит в своём терминале (раздел 8).

### 4.3 Как Codex узнаёт о доверии

Запуск и `resume` Codex получают подстановку `{trust}` в `CODEX_CONFIG_FLAGS`:

```
-c projects={"<realpath проекта>"={trust_level="trusted"},"<realpath cwd>"={trust_level="trusted"}}
```

Второй ключ — только когда cwd (`session.worktree?.path ?? projectPath`) после `realpath` отличается от папки проекта. По исследованию Codex и так берёт доверие worktree у корня основного репозитория, но папка проекта в Parley не обязана быть корнем репозитория, а второй ключ безвреден. Строки — через `tomlString` (экранирование кавычек и обратных слэшей, как у `mcp_servers`). Нет согласия — подстановка выпадает, и хост не доходит до запуска (4.2). Файлы Codex не пишутся.

Родная проекция шаблона (`work/agents.ts`, `nativeConfigArgs`) получает `{trust}` и `{approvals}` в список известных подстановок, иначе роли Codex из `.codex/agents` и навигатор перестали бы проверяться. Читатель ролей (`roles/context.ts`, `config/read`) получает ту же пару `-c projects=…`: без неё Codex отключает проектные слои недоверенной папки, и роль из проекта не нашлась бы до запуска. Пользовательский `providers.json` без `{trust}` — диагностика `provider-override-gap` по образцу `{developerInstructions}`; шаблон остаётся его.

**Спайк 0 — выполнен 2026-10-21 на `codex-cli 0.162.0`** (с разрешения человека; временный `CODEX_HOME` с копией `auth.json`, временные git-папки, TUI в pty через node-pty и экран `@xterm/headless`, `--no-daemon`; в настоящий `~/.codex` ничего не записано, стенд удалён):

| Случай | Запуск | Результат |
| --- | --- | --- |
| контроль: папка без флага | `codex --no-daemon` в свежей git-папке | экран «Folder access … Trust this folder? … Your trust decision will be saved», кнопки «Trust and continue» / «Quit» |
| (а) папка с флагом | `-c projects={"<repo>"={trust_level="trusted"}}` | экрана нет, композер; `/status`: «Permissions: Workspace (Ask for approval)» |
| (б) worktree без флага | cwd `.claude/worktrees/wt` | экран доверия есть: без записей worktree ничего не наследует |
| (б) worktree, ключ на корень | то же, ключ — корень репозитория | экрана нет, Workspace |
| (б') worktree, ключ на сам worktree | ключ — только путь worktree | экрана нет, Workspace: годятся оба ключа |
| (в) `resume` с флагом | `codex resume <id> -c projects=…` | экрана нет; **без `-c sandbox_mode` тред, шедший в read-only, поднялся как Workspace**; `approvals_reviewer` тред восстановил («Approve for me») |
| (г) путь с пробелом и кавычкой | папка `proj "q" x`, кавычка в TOML как `\"` | экрана нет, Workspace |
| (д) `-c approval_policy="never" -c sandbox_mode="read-only"` | | принят: «Permissions: Read Only (never)» |
| (д) `-c approval_policy="on-request" -c approvals_reviewer="auto_review" -c sandbox_mode="read-only"`, один платный ход «создай spike.txt» | | принят: «Read Only (Approve for me)»; модель запросила одобрение, `printf 'ok' > spike.txt` выполнен, файл создан, окна одобрения для человека не было, ход 10 с |
| (е) версия | | нижняя граница для `auto` — 0.162.0 |

Попутно: во временный `config.toml` Codex записал только `[tui]` (детектор скрин-ридера и nux модели), записи `projects` от флага нет — доверие флагом не сохраняется, как и требовалось; rollout появляется только после первого хода, и сессию без единого промпта `codex resume` не поднимет (у Parley первым промптом идёт бриф); авторевьюер пишет свой rollout с `parent_thread_id`, `source: {subagent: {other: "guardian"}}` и `thread_source: "guardian_review"` — индексатор Parley отличает порождённые треды по этим признакам (`codex/index-session.ts`), на приёмке проверить, что они не всплывают сессиями; в свежем доме при старте показывается рамка «update available», композер она не блокирует. Решение 21 (откат раздела 4 при провале) не понадобилось.

### 4.4 Карточка согласия

Новое семейство карточек, четвёртое после ленты, помощника и комнаты.

Протокол (`protocol/src/consents.ts`):

```ts
interface ConsentCard {
  id: string;                         // c-NN, сквозной у хоста
  kind: 'folder-trust';
  folder: string;                     // realpath проекта
  projectPath: string;
  requestedBy: { source: 'agent' | 'resume' | 'launch'; sessionId?: string; workId?: string; label?: string };
  at: string;
  state: 'pending' | 'allowed' | 'denied';
}
```

Методы хоста: `consents.list` → `{ items: ConsentCard[] }` (только `pending`); `consents.decide { id, decision: 'allow' | 'deny' }` → `{ applied: boolean; state }` (второе нажатие — `applied: false`, как у `feed.decide`); событие `consents.changed { upsert, removed }`. Хранение — `parleyHome()/consents.json`: карточка и удержанные запуски `{ ref, mode: 'launch' | 'resume' }` переживают перезапуск хоста, таймаута нет. На старте хост сверяет удержанные записи с картами (сессия закрыта или уже живая — запись снимается). Решение `allow` пишет `trust.json` (4.1) и продолжает запуски (4.2); `deny` закрывает их.

Остров: `ISLAND_METHODS` + `consents.list` / `consents.decide`, `ISLAND_EVENTS` + `consents.changed`. Карточка согласия — свой стор `island/consents.ts` и свой вид, как у карточки помощника, а не элемент очереди `requests.ts` (та строится по ждущим сессиям с `ref`). Показывается раньше карточек ленты: она держит запуск. Заголовок «Trust folder for agents?», строка с папкой (с сокращением середины длинного пути, как у заголовков) и «requested by S03 Ruslan · create_session», кнопки **Trust** / **Deny**; «Done ✓» на 8 с, «Already answered» при `applied: false`. Мини-вид с подписью «Card». Фразы подтверждения острова («да») работают как для остальных карточек. Звук и уведомление — как у запроса разрешения (`attention/notify.ts`, тип «needs you»).

Telegram: `CardRecord` + `{ kind: 'consent'; consentId; chatId; messageId; at }`; сообщение «<b>Trust folder for agents?</b>\n<папка>\nRequested by S03 Ruslan (create_session) · my_harnas», кнопки `pc1:<shortId>:a` (Trust) и `pc1:<shortId>:d` (Deny); идёт по переключателю `telegramCards`; закрытие при решении в другом месте — `T.answeredAtMac`; истечения нет. Ответ — `consents.decide`, квитанция «Trusted ✓» / «Denied». Помощник карточку согласия не предлагает (раздел 8).

## 5. Политика одобрений и песочницы по ролям

### 5.1 Что получает запуск

Политика собирается в `prepareSessionRole` (`core/src/roles/catalog.ts`) и доезжает до `CODEX_CONFIG_FLAGS` подстановками `{approvals}` и `{sandbox}` (сейчас есть только `{sandbox}`); `-a on-request` из `CODEX_PARLEY_FLAGS` убирается, его место занимает `-c approval_policy=…` (решение 10). Одни и те же пары при запуске и `resume`: политика следует текущей настройке, а не памяти треда.

| Роль Codex | `sandbox_mode` | `approval_policy` | `approvals_reviewer` | Хуки |
| --- | --- | --- | --- | --- |
| только чтение (`readOnly: true`; роли Codex с `sandbox_mode = "read-only"`) | `read-only` | `never` | — | по настройке 5.2 (в `parley` — есть; запросов разрешений при `never` не бывает) |
| пишущая (executor, verifier, debugger; сессия без роли; роли Codex с `workspace-write`) | `workspace-write` (явно) | по настройке 5.2 | по настройке 5.2 | по настройке 5.2 |
| роль Codex с `danger-full-access` | как в роли | по настройке 5.2 | по настройке 5.2 | по настройке 5.2 |

Строка `/status` у Codex 0.162 для этих сочетаний: «Workspace (Ask for approval)», «Read Only (never)», «Read Only (Approve for me)» (спайк 0). При `resume` все три ключа передаются снова: спайк (в) показал, что без `-c sandbox_mode` тред, шедший в read-only, поднимается как Workspace.

`danger-full-access` Parley сам не назначает никому; роль человека из `.codex/agents` с таким `sandbox_mode` уважается как сейчас. Явная `workspace-write` у сессии без роли — умолчание Parley, а не требование роли: в `assertRoleDelivery` она не участвует, и свой `providers.json` без `{sandbox}` или `{approvals}` получает диагностику `provider-override-gap`, а не отказ; его собственные литералы (`-a …`) остаются как есть.

Роли только для чтения с `never`: Codex не спрашивает ни о чём, запись отвергает песочница, инструменты `parley` одобрены конфигом сервера. Ожидаемое поведение модели — сообщить, что запись запрещена, и продолжить; если на живом прогоне (раздел 9) такая роль зацикливается на отвергнутой команде, откат для неё — `on-request` по настройке 5.2, и это записывается в спеку.

### 5.2 Настройка для пишущих ролей

`codexWriteApprovals: 'auto' | 'parley' | 'terminal'` в `config.json` (`core/src/config.ts`), переменная `PARLEY_CODEX_WRITE_APPROVALS`; умолчание `auto` (решение 11). Перенос: прежний `codexApprovals: true` → `parley`, `false` → `terminal`; прежнее имя читается ещё один релиз, `PARLEY_CODEX_APPROVALS` — так же.

| Режим | Флаги | Хуки | Где решается | Что видит остров |
| --- | --- | --- | --- | --- |
| `auto` | `-c approval_policy="on-request" -c approvals_reviewer="auto_review"` | нет | авторевьюер Codex | ничего: карточек нет, состояние по заголовку терминала как сейчас |
| `parley` | `-c approval_policy="on-request"` | `-c hooks.*` у всех ролей Codex (как сейчас при `codexApprovals`), один раз `/hooks` у человека | человек: остров, окно, Telegram | карточки `permission` (Allow / Deny; «always» Codex не принимает) |
| `terminal` | `-c approval_policy="on-request"` | нет | человек в терминале | «answer in terminal» + «Open terminal» (как сейчас) |

Хук `PermissionRequest` идёт раньше авторевьюера (Codex 0.162, `core/src/tools/approvals.rs`), поэтому `auto` и карточки на одну сессию не совмещаются: в `auto` хуков нет намеренно. Сторож `codex-call-wait` и удержание карточек работают только в `parley`.

Версия: `auto` требует Codex не ниже версии из спайка 0 (е); проба версии провайдера (`providerVersions`, как у `feedHookUrl`) ниже границы — запуск идёт как `terminal` с диагностикой `codex-auto-unsupported` в ленте и строкой в Settings → Agents.

Окно: Settings → Agents — вместо галочки три варианта с подписями: «Auto-review (Codex's reviewer decides; nothing to answer)», «Ask in Parley (cards on the island and in Telegram; Codex asks once to trust Parley's hooks)», «Ask in the terminal». Подсказка про `/hooks` — только у `parley`. Chat у Codex показывает текущий режим строкой под составом промпта (там, где сейчас подсказка про хуки).

### 5.3 Что не меняется

Claude Code и GLM — как сейчас (хуки всегда, решения в окне), кроме 5.4. Инструменты `parley` у Codex — без вопросов (`default_tools_approval_mode="approve"`, в master). `CODEX_APPROVAL_GUIDANCE` остаётся: при `parley` и `terminal` зависшее одобрение по-прежнему возможно.

### 5.4 Claude Code: браузерные инструменты `parley` без вопросов

Сессия Claude получает от Parley файл настроек с `permissions.allow` на все инструменты `parley`, кроме трёх браузерных, которые лежат в `permissions.ask` (`core/src/work/settings-file.ts`, `BROWSER_ASK_PERMISSIONS`; решения 2026-10-20 п. 2 и 2026-10-21 п. 9). У Claude Code правило `ask` сильнее любого `allow`, в том числе того, что он сам пишет по «Yes, and don't ask again for … in <проект>», поэтому вопрос повторяется на каждом вызове; сам Claude Code об этом и говорит: «Ask rule mcp__parley__browser_evaluate overrides auto mode for this tool» (снимок человека 2026-10-21).

Решение человека 2026-10-21 (5а): у Claude эти три инструмента тоже без вопросов. Правка: `browser_evaluate`, `browser_cookies`, `browser_storage` переходят в `permissions.allow`, список `ask` в файле настроек исчезает (`BROWSER_ASK_PERMISSIONS` и `BROWSER_TOOLS_ASK` уходят, если больше никому не нужны); тексты скилла parley-browser и описаний трёх инструментов, README и CHANGELOG правятся там, где сказано, что Claude спрашивает. Остальные правила Claude Code (команды, правки файлов, его собственный режим) не трогаются. Это маленькая самостоятельная правка своей веткой; остального плана она не ждёт.

## 6. Короткий набор инструментов и примеры

### 6.1 Профиль `short`

`McpConfigParams.toolProfile?: 'short'` → переменная `PARLEY_TOOL_PROFILE=short` в окружении сервера (только для Codex; `codexMcpOverride`). `createParleyServer` при `short` не объявляет `remember`, `memory_read`, `search_history`; вызов неизвестного имени отвечает обычной ошибкой MCP. Всё остальное объявляется как сейчас: карта, отчёт, письма, комнаты, планы, бэклог, `publish_agent_plan`, `create_session` при канале, `find_skill` при навигаторе, `browser_*` при канале агента.

`stableGuidance` получает параметр `toolProfile`: при `short` из строки `read_guide — …` выпадает фраза «Memory: remember one lasting project fact or lesson (the human accepts it); before a big choice, search_history and memory_read.», остальное побайтно как сейчас (потолки `guidanceBudgetProblems` не меняются). Гид `read_guide` при `short` пропускает раздел о памяти.

Сокращение намеренно небольшое: тексты ведущим и гид зовут `backlog_*`, комнаты и планы нужны ролям, браузер — проверкам. Что именно сбивает Codex, спека не знает; измерение 6.4 покажет, нужно ли резать дальше.

### 6.2 Блок примеров для Codex

Новый блок слоя `CODEX_TOOL_EXAMPLES` (`core/src/work/guidance.ts`), идёт в `bridge` вместе с `CODEX_APPROVAL_GUIDANCE` только у Codex; у Claude ничего не добавляется. Текст (английский, как весь слой):

```
Parley tools in Codex code mode are called as tools.mcp__parley__<name>(args). Examples:
  const map = await tools.mcp__parley__get_map({});
  await tools.mcp__parley__send_message({ to: "s-02", kind: "question", text: "Which branch do I build on?" });
  const inbox = await tools.mcp__parley__check_inbox({});                 // once per "New messages (N)" pointer
  await tools.mcp__parley__wait_for({ target: "inbox", timeoutSec: 600 }); // to wait for a reply, instead of calling check_inbox in a loop
  await tools.mcp__parley__report({ status: "done", summary: "What was done, what was found, what is left." });
Call report exactly once at the end (status failed if the task is not done), then stop: end the turn, do not poll get_map or check_inbox, do not start unrelated work. New messages reach you as the pointer after your turn.
```

Имена аргументов — из схем `tools.ts` (`get_map`, `send_message {to, kind, text, room?, replyTo?}`, `check_inbox {}`, `wait_for {target, timeoutSec}`, `report {status, summary, artifacts?}`); тест сверяет блок со схемами по именам, чтобы пример не разошёлся с инструментом. Блок ≤ 1 КБ и восемь строк; в потолки политики он не входит (это `bridge`), в 96 КиБ аргумента — входит, `validateLayerArguments` как сейчас.

Форма `tools.mcp__parley__…` проверена пробой на 0.160 (стенд токенов); если на живом Codex текущей версии вызовы выглядят иначе (например, без `exec`), блок переписывается по факту, а правило о `report` и остановке остаётся.

### 6.3 Указатель и остановка

Указатель «New messages (N)… Call check_inbox.» (`core/src/work/delivery.ts`) не меняется. Правило остановки — в блоке 6.2 и одной фразой в общей политике (строка про `report`): «Before finishing you must call report — otherwise the result will not go anywhere; after report, end the turn». Отдельного сторожа повторов нет (раздел 8).

### 6.4 Как измерить

Стенд `docs/research/2026-10-04-parley-token-benchmark.md` для Codex считает только `find_skill`; письма, `get_map`, `report` и одобрения он не размечает. Поэтому здесь — свой короткий скрипт по rollout сессии (`~/.codex/sessions/…`, записи `custom_tool_call` с `name: exec`): число вызовов `tools.mcp__parley__*` в коде, число `check_inbox` / `get_map` подряд без письма между ними, число `report`. Одобрения в rollout не пишутся: в `parley` их считает лента (карточки `permission`), в `terminal` — человек по терминалу, в `auto` их нет по построению.

Сценарий: две сессии Codex в комнате (вопрос → ответ → report) и сессия-исполнитель с правкой файла. «До» снимается до любой правки политики и инструментов, «после» — на приёмке; оба — платные ходы, их запускает человек (правило P32). Цифры записываются в спеку при приёмке; порог не задаётся заранее.

## 7. Что меняется в коде (карта для плана)

- `protocol`: `consents.ts`, методы `consents.list` / `consents.decide`, событие `consents.changed`; исход `held` у `sessions.create` / `launch`.
- `core`: `trust.json` и `consents.json` в `parleyHome()` (чтение, атомарная запись по образцу `store.ts`); подстановки `{trust}` и `{approvals}` в `CODEX_CONFIG_FLAGS`, уход `-a on-request`; те же подстановки в `work/agents.ts` (`nativeConfigArgs`) и у читателя ролей (`roles/context.ts`); политика по роли в `prepareSessionRole`; `codexWriteApprovals` в `config.ts` с переносом; `CODEX_TOOL_EXAMPLES` и `toolProfile` в `guidance.ts` / `guide.ts`; `PARLEY_TOOL_PROFILE` в `mcp-config.ts` и профиль в `createParleyServer`; ответ `create_session` с `held` (`mcp/session-tools.ts`); диагностики `provider-override-gap` для `{trust}` / `{approvals}` и `codex-auto-unsupported`; `settings-file.ts` — три браузерных инструмента в `allow` у Claude (5.4, своей веткой).
- `host`: проверка согласия в начале `launch()` (`sessions-service.ts`) до резерва и побочных действий, исход `held`, продолжение по решению; удержание в `wake-service.ts` как отказ без письма о сбое и повтор подъёма; методы и события согласий, `consents.json`; `feedHookUrl` по `codexWriteApprovals === 'parley'`; граница версии для `auto`; письмо создателю при `deny`; Telegram — `consent` в `CardRecord`, `cards.ts`, `service.ts`, `callbacks.ts`.
- `desktop`: диалог в композере новой работы; Settings → Agents (три режима), Settings → Projects (список согласий, Revoke); остров — методы, события, стор и вид карточки согласия; строка «waiting for folder trust» в главном окне; строки в `shared/strings.ts`; Chat у Codex — строка режима.
- Документы: README (разделы Codex и остров), CHANGELOG, `docs/research/2026-09-29-codex-research.md` — пометка к 13.2 и 13.3 о принятых решениях.

## 8. Вне объёма, открытые вопросы, риски

Вне объёма этой спеки:
- экран доверия Claude Code: его запись живёт в `~/.claude.json` человека, флага нет; писать туда — нарушение рамки. Остаётся терминал; согласие 4.1 Claude пока не использует (диалог говорит об этом прямо);
- `danger-full-access` и `--dangerously-bypass-approvals-and-sandbox` — не назначаются Parley; переопределение политики на одну сессию — позже, вместе с переключателем провайдера из спеки 2026-10-14;
- heartbeat и сторож «воркер завис» по образцу Orca (10 мин без сигнала) — отдельная тема, TODOS;
- вопросы и планы Codex (`request_user_input`), app-server как канал, предложение согласия помощником (`propose_decision`) — следующий шаг после живой приёмки;
- запуски, которые печатает CLI `parley-core` (человек поднимает процесс сам).

Открытых вопросов для человека не осталось: решения 9 и 11 подтверждены 2026-10-21, спайк 0 выполнен.

Риски:
- спайк 0 пройден на 0.162.0; новая версия Codex может сменить ключи или строки `/status` — приёмка идёт на версии человека, а разбор заголовка и уведомлений терминала остаётся с честным «неизвестно»;
- треды авторевьюера (`guardian_review`) в `sessions/` — проверить на приёмке, что индексатор и лента не показывают их отдельными сессиями;
- `never` у ролей только для чтения: модель может повторять отвергнутую запись — откат в 5.1;
- авторевьюер Codex одобряет команды сам: сеть в `workspace-write` выключена Codex по умолчанию, запись вне рабочей папки блокирует песочница, но решения о командах принимает не человек — это и есть смысл режима `auto`, умолчание подтверждено человеком 2026-10-21;
- Telegram этап B не проверен вживую — карточку согласия принимать после его приёмки;
- факты о Codex — 0.160–0.162; версия в окне показывается, спайк 0 и приёмка идут на той, что стоит у человека.

## 9. Живая проверка (приёмка)

1. Новая работа в папке без согласия: диалог; Cancel — работы нет; Trust — запись в `trust.json`, сессия Codex стартует без экрана доверия, строка статуса `workspace-write` (пишущая роль) или `read-only` (роль только для чтения).
2. Исполнитель Codex при `auto` правит файл и запускает тесты — ни одного вопроса человеку, в ленте видны вызовы; при `parley` то же — карточки на острове с Allow / Deny, ответ с острова продолжает ход, в Telegram та же карточка закрывается «Answered at Mac»; при `terminal` — «answer in terminal».
3. Роль только для чтения (critic): попытка записи отвергнута, вопроса нет, сессия доходит до `report`.
4. `create_session` из сессии Codex в проекте без согласия (перенос): ответ инструменту приходит сразу с `held`, сессия `pending`, карточка на острове и в Telegram, в главном окне строка «waiting for folder trust»; Trust с Telegram — запуск продолжился, карточка на острове закрылась; Deny — сессия `failed`, создателю письмо. Перезапуск хоста с ждущей карточкой — карточка и удержание на месте.
5. Подъём спящей сессии Codex письмом в проекте без согласия — карточка, письма непрочитанные, письма о сбое отправителю нет; после Trust сессия поднялась и прочитала письма. С согласием — тот же `-c projects…` и та же политика; тред помнит модель и усилие.
6. Сценарий 6.4: цифры до и после записаны.
7. E2E 800×500: диалог композера, три варианта в Settings → Agents, карточка согласия на острове (стаб-хост с `consents.list`), главное окно без сдвигов.
