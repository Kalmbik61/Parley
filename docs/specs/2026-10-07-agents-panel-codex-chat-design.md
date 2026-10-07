# Панель агентов справа и вид Chat для Codex

Дата: 2026-10-07. Статус: спека согласована в брейншторме 2026-10-07, ждёт просмотра человеком; план реализации — после неё.

Связано:
- TODOS, раздел 21 «Панель агентов справа» (просьба пользователя 2026-10-07 со снимком кнопки «4 agents running»), разделы 10 и 18;
- план вида Chat `docs/specs/2026-10-01-chat-view-plan.md` (Codex там вынесен в отдельный план) и разведка `docs/research/2026-10-01-chat-view-spike.md`;
- разведка Codex `docs/research/2026-09-29-codex-research.md` (0.159, по исходникам; разделы 3.2–3.3 о хуках и журнале);
- локальный план пользователя `.omx/plans/2026-10-04-provider-adapters-and-chat.md`, этапы 4–6: отсюда правила «не писать `~/.codex/config.toml`», «сопоставлять по id, а не по тексту», «незнакомый формат — причина и рабочий терминал», «форма элемента меняется — растёт `FEED_SCHEMA_VERSION`»;
- спека нормалайзера `docs/specs/2026-10-06-model-effort-normalizer-design.md` (меню модели и effort; у Codex в чате здесь не трогаются).

## 1. Зачем

1. **Видеть, чем заняты агенты, не листая ленту.** Кнопка «N agents running» в тулбаре вида Chat сейчас только прокручивает ленту к первой карточке агента. Человек хочет панель справа, как в Claude Desktop и Codex Desktop (со слов пользователя, не сверялось): список агентов сессии, у каждого — что он делает сейчас. Клик по агенту — провал внутрь: что ему поручили, что он уже сделал, на каком он этапе, итог.
2. **Вид Chat у Codex.** Сессия Codex сейчас бывает только терминалом: сегмент Chat выключен. Нужна та же лента разговора поверх скрытого терминала, что у Claude, — в рамке, где Parley запускает официальный интерактивный `codex` под логином человека и не трогает его конфиги.

Обе части связаны: агенты Codex попадают в панель, когда у Codex есть лента.

## 2. Что сейчас (проверено 2026-10-07)

| # | Что | Где |
|---|---|---|
| 1 | «N agents running» — кнопка в тулбаре Chat (`agents: { running, onShow }`); клик ставит просьбу показать первую карточку агента | `packages/desktop/src/renderer/chat/ChatToolbar.tsx:107, 240`; `ChatView.tsx:223` (`runningAgents`), `:364` (`showAgent` → `requestReveal`), `:403` |
| 2 | Карточка агента в ленте уже знает почти всё: тип, описание, модель, задание (до 16 КБ), статус, длительность, `toolCount`, последние 100 вложенных вызовов живыми дельтами, итог, путь к журналу | `packages/core/src/feed/types.ts` (`FeedAgent`) |
| 3 | Раскрытие карточки: вложенные вызовы, итог и «Show transcript» — полная лента агента разовым `feed.snapshot { ref, agentId }`, в окне последние 200 элементов | `chat/items/AgentItem.tsx`; хост — `agentSnapshot` в `packages/host/src/feed/feed-service.ts` |
| 4 | Бейдж агентов с поповером в строке сессии сайдбара и у участника комнаты — по `LiveMetrics.tasks` (id, тип, описание, фоновый); строка поповера открывает вкладку на карточке | `components/AgentsBadge.tsx:18`; вызовы — `sidebar/SessionRow.tsx:316`, `components/rooms/ParticipantStrip.tsx:86` → `layout/bodies/RoomBody.tsx:44`; `chat/open-agent.ts:18` (`openAgentCard`), `chat/ui-store.ts:70, 93` (`requestReveal`) |
| 5 | Правый сайдбар — вкладки Files и Changes, ширина, ресайзер; нет места — сайдбара нет | `shell/RightSidebar.tsx`, `shared/ui-types.ts` (`rightSidebar.tab`, `fitRightSidebar`) |
| 6 | Chat у Codex выключен трижды: окно (`feedAvailable`: семейство не `claude`), хост (`feedHookUrl` и сев журнала только у Claude Code) | `renderer/lib/feed-view.ts:42, 50, 57`; `host/src/sessions/sessions-service.ts:389, 396` (`feedHookUrl`, `feedSupported`); `host/src/feed/feed-service.ts:481-483` (`seed`), `:594-601` (`seedAside`) |
| 7 | Что Parley уже знает о Codex: журнал сессии (`~/.codex/sessions/…/rollout-*.jsonl`) находится и индексируется, у журналов субагентов есть родитель; состояние — по заголовку окна (OSC 0) и уведомлениям терминала (OSC 9), конец хода — ещё и `notify` | `core/src/codex/discover.ts`, `core/src/codex/index-session.ts`, `host/src/activity/log-index.ts`, `host/src/pty/codex-terminal.ts`, `core/src/work/codex-notify.ts` |
| 8 | Разбора журнала Codex в элементы ленты нет. Одобрения Codex видны только по экрану («нужен ты»), отвечать — в терминале | — |
| 9 | Parley подменяет у Codex `notify` флагом `-c notify=…`. У пользователя в `~/.codex/config.toml` свой `notify` (SkyComputerUseClient → oh-my-codex), и в сессиях Parley он не срабатывает | `core/src/providers.ts:128, 146, 164` (`CODEX_CONFIG_FLAGS`, `{notify}`, `CODEX_PARLEY_FLAGS`); `core/src/work/launch.ts:346-349`; `core/src/work/mcp-config.ts:186` (`codexNotifyOverride`) |
| 10 | `feed.interrupt` шлёт Esc в терминал любой сессии; разбор после Esc (`settleInterrupt`: стереть промпт, вернувшийся в поле `❯`) — механика Claude | `host/src/feed/feed-service.ts:631, 876`, `:73, 76` |
| 11 | Приёмник хуков: `POST /hooks`, токен на сессию (`PARLEY_HOOK_TOKEN`), сверка `x-parley-session` и `session_id` с id сессии провайдера; пропускает только события из набора Claude Code (`FEED_HOOK_EVENTS`); токен выдаётся только сессиям Claude Code | `host/src/hooks/hook-server.ts:138-149, 208-228, 290`; `core/src/work/settings-file.ts:95`; `host/src/sessions/sessions-service.ts:537`; `host/src/host.ts:232` |
| 12 | MCP-сервер Parley связан с хостом только файлами работы (stdio к агенту, `PARLEY_WORK_DIR`, `fs.watch`) — своего канала к хосту у него нет | `core/src/mcp/server.ts:5`, `core/src/mcp/context.ts:68`, `core/src/mcp/watch-map.ts:1` |

## 3. Факты Codex 0.160.0 (разведка 2026-10-07)

Установлен `codex-cli 0.160.0` (npm `@openai/codex`); последний стабильный — 0.160.1 от 2026-10-05. Источники: локальные проверки, документация (learn.chatgpt.com: hooks, subagents, config-reference) и исходники `openai/codex` на теге `rust-v0.160.1`.

**Хуки.**
1. `codex features list`: `hooks` — stable, включены по умолчанию; `multi_agent` — stable, включён.
2. События: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`. Обработчики — `command` (JSON на stdin) и `mcp_tool`.
3. Общие поля входа: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`; у событий хода — `turn_id`; у событий субагента — `agent_id`, `agent_type`. `PreToolUse`: `tool_name`, `tool_use_id`, `tool_input`; `PostToolUse` — ещё `tool_response`; `SubagentStop` — `agent_transcript_path`; `SessionStart` — `source` (`startup|resume|clear|compact|fork`). Имена инструментов: `Bash`, `apply_patch` (алиасы `Edit`/`Write`), `spawn_agent` (алиас `Agent`), `mcp__…`.
4. **`PermissionRequest` отвечает на одобрение**: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message":…}}}`. Любой `deny` побеждает; `allow` пропускает запрос без окна одобрения в TUI; молчание — обычное окно в TUI. Хук идёт до показа окна одобрения; предел по умолчанию 600 с. Срабатывает ли он на каждое одобрение `apply_patch` — в документации не найдено.
5. **Доверие.** Хук не из управляемого слоя (в том числе заданный флагом `-c`) не запускается, пока человек не одобрит его в `/hooks`. Одобрение привязано к хешу определения хука (событие, matcher, группа, текст обработчика) и ключу `<источник>:<событие>:<группа>:<обработчик>`; хранится в `~/.codex/config.toml` (`[hooks.state."…"] trusted_hash`), пишет его сам Codex. Обход — только `--dangerously-bypass-hook-trust` (запускает и недоверенные проектные хуки; не используем).
6. Свои хуки у пользователя уже есть: `~/.codex/hooks.json` (8 событий), плагин OMC вешает хук на `permission_request`.

**Журнал сессии (rollout).**
7. Строка: `{timestamp, ordinal, type, payload}`; `ordinal` монотонный. Файл создаётся при первой записи, дальше каждая порция пишется построчно с `flush` — журнал можно читать вживую. Живьём на 0.160 не проверено (этап 0).
8. Пишутся только законченные элементы: `event_msg/item_completed` с `TurnItem` (`payload`: `thread_id`, `turn_id`, `item`, `started_at_ms`, `completed_at_ms`), а также `task_started`, `task_complete`, `turn_aborted`, `turn_context`, `compacted`, `token_count`, `response_item/*`. **Не пишутся**: запросы одобрения, начало команды или патча, `ItemStarted`, порции текста (`*Delta`). Команда и текст появляются в журнале только законченными.
9. Типы `item_completed.item` в журналах пользователя: `UserMessage` (`content[].text`), `AgentMessage` (`content[].text`, `phase`: `commentary`/`final_answer`), `Reasoning`, `CommandExecution` (`command[]`, `cwd`, `status` `completed|failed` (в коде ещё `declined`), `exit_code`, `aggregated_output`, `duration`), `FileChange` (`changes: {путь: {type, unified_diff | content, move_path}}`, `status`), `McpToolCall` (`server`, `tool`, `arguments`, `status`, `result.content[]`, `duration`), `SubAgentActivity` (`kind`: `started|interacted|completed|interrupted`, `agent_thread_id`, `agent_path`), `CollabAgentToolCall` (в журналах пользователя только `wait`), `Extension` (веб-поиск: `query`, `results`), `ImageView`, `ContextCompaction`. `Plan` в исходниках есть, в журналах пользователя не встречен.

**Субагенты.**
10. У каждого субагента свой журнал. Его `session_meta`: `parent_thread_id`, `forked_from_id`, `agent_nickname`, `agent_path`, `source.subagent.thread_spawn {parent_thread_id, depth, agent_path, agent_nickname, agent_role}`, `subagent_history_start_ordinal` — журнал начинается копией истории родителя, собственная работа агента — после этой отметки.
11. Задание приходит агенту межагентным сообщением `response_item/agent_message` (с автором и получателем), а не записью `spawn_agent` у родителя. У родителя видны `SubAgentActivity` и `CollabAgentToolCall`.
12. Одобрения субагента всплывают в TUI из неактивного треда (в CLI — клавиша `o`, чтобы открыть тред).

**Прочее.**
13. Parley запускает Codex с `--no-daemon`: общий демон app-server берёт окружение первого запустившего процесса, а привязка хуков к сессии идёт через окружение.
14. Машинный режим (`codex app-server`) — по-прежнему вне рамки (раздел 18 TODOS); здесь не используется.

## 4. Решения брейншторма (2026-10-07)

| # | Вопрос | Решение |
|---|---|---|
| 1 | Где панель | Третья вкладка «Agents» правого сайдбара |
| 2 | Чьи агенты | Активной сессии; бейдж агентов в строке другой сессии переключает панель на неё |
| 3 | Закончившие агенты | Показывать ниже живых, свёрнутым блоком «Finished (n)» |
| 4 | Источник ленты Codex | Журнал — у всех; хуки — когда человек одобрил их в `/hooks`: тогда карточки Allow/Deny и раннее «идёт» |
| 5 | Объём первой версии Chat у Codex | Лента, поле ввода с вложениями, Stop, карточки агентов и панель. Модель, effort и режим — только подписью; меняются в терминале |
| 6 | Живые пробы Codex | Только с разрешения человека: тратят лимит подписки |
| 7 | `notify` | Подмену убрать, если от неё ничего не зависит (проверка в этапе 0–1); тогда цепочка человека снова работает |
| 8 | Доверие хуков | Parley не пишет доверие сам и не запускает Codex с `--dangerously-bypass-hook-trust`; одобряет человек в `/hooks` |

## 5. Устройство

### 5.1 Панель агентов (только окно)

**Место.** `rightSidebar.tab` в `ui.json` получает значение `'agents'` (`shared/ui-types.ts`: тип, `normalizeRightSidebar`). Окно прежней сборки незнакомую вкладку читает как `files`. В `RightSidebar.tsx` — третья кнопка «Agents» и `AgentsPanel`.

**Чья сессия.** Панель показывает сессию `focusedSessionOf(state, workKey)` (`layout/store.ts:111`; им же пользуются Files, Changes и палитра): терминал или дифф активной группы, иначе самая свежая из открытых вкладок сессии по истории фокуса. Фокус на вкладке комнаты, файла или браузера сессию панели не меняет. Нет ни одной — пустое состояние «Open a session to see its agents». Выбор агента (экран агента) держится в `chat/ui-store.ts` по ключу сессии и переживает смену вкладок; на диск не пишется.

**Данные.**
- У сессии с видом Chat (`feedAvailable`) панель сама держит подписку на ленту (`useFeedSubscription`; подписки со счётчиком, вторая не мешает) и читает `useFeed(ref)`.
- У сессии без вида Chat (старый `claude`, Codex до 0.160, хост без признака `feed-codex`) — список из `LiveMetrics.tasks` без провала внутрь и строкой «Agent details need Chat» с причиной из `feedAvailability`.

**Модель панели** — чистые функции `renderer/agents/agents-model.ts`:
- `agentRows(items)` → `{ running, finished }`: строки по карточкам `agent` в порядке ленты. Строка: id карточки, `agentId`, тип, описание (нет — тип), модель, статус, `toolCount`, начало (`at`), длительность, фоновый, **текущий шаг** — `toolHeadline` последнего вложенного вызова; нет вызовов — `null`; нет `agentId` — состояние «Starting…».
- `agentSteps(agent)` → этапы агента: вход последнего вложенного `TodoWrite` (Claude) или элемент `Plan` (Codex), список `{ text, status }`; нет — `null`.

**Список.** Сверху работающие: значок типа (как в `AgentItem`), описание, строка текущего шага, «тип · модель · N calls · время» (живой секундомер `useNow`). Ниже — «Finished (n)», свёрнут; раскрытие держится в `ui-store`. Пусто — «No agents in this session yet».

**Экран агента** (внутри панели, «← All agents» возвращает к списку; вложенные вызовы — `ToolItem` с `compact`, как в `AgentItem.tsx:126, 168`):
- шапка: значок, описание, тип · модель, статус, длительность;
- «Task» — задание, Markdown (`RoomMarkdown`), длиннее 12 строк — свёрнуто с «Show all»;
- «Steps» — `agentSteps`, если есть;
- «Activity» — вложенные вызовы компактными строками (`ToolItem`, как в раскрытой карточке), вживую, новые снизу, прилипание к низу как у ленты;
- «Result» — итог Markdown, когда агент закончил;
- «Full transcript» — лента агента `feed.snapshot { ref, agentId }` (загрузка, ошибка, готово; последние 200 элементов, как в `AgentItem`). Пока агент работает, снимок перечитывается при росте `toolCount`, не чаще раза в 3 с; по концу агента — один последний раз. Загрузку и состояние выносим из `AgentItem` в общий хук `useAgentTranscript`, карточка и панель пользуются им оба;
- «Show in chat» — вид Chat вкладки сессии и прокрутка к карточке (`openAgentCard`).

**Откуда открывается.**
- «N agents running» в тулбаре — `agents.onShow` (`ChatView.tsx:364`) открывает сайдбар на вкладке Agents (тем же путём, что `showRightTab`). Нет места (`rightSidebarHasRoom()` ложно) — прежнее поведение: прокрутка к первой карточке.
- Строка поповера `AgentsBadge` в сайдбаре и у участника комнаты — новый `openAgentInPanel(ref, agentId)` рядом с `openAgentCard` (`chat/open-agent.ts`): фокус на вкладке сессии (`applyFocusTarget`), вкладка Agents и сразу экран этого агента. Нет места — прежний `openAgentCard`. Вызовы меняются в `SessionRow.tsx:316` и `RoomBody.tsx:44`.
- Палитра и меню View: действие `sidebar.agents` «Show agents», ⌘⇧A (свободно; рядом ⌘⇧E — Files, ⌘⇧G — Changes). Четыре места, как у `sidebar.changes`: `ActionId` и `ACTIONS` в `shared/keybindings.ts:11, 53`, `IMPLEMENTED_ACTIONS` в `renderer/keys/handler.ts:17`, ветка `runAction` в `palette/actions.ts:168` (`ctx.ui.showRightTab('agents')`), `needsActiveWork`.

**Тексты окна** — английские, `S.agentsPanel.*` в `shared/strings.ts`.

### 5.2 Лента Codex из журнала (core)

Новый модуль `packages/core/src/feed/codex/`:
- `rollout-record.ts` — разбор строки журнала в `{ ordinal, at, type, payload }` без исключений: битая строка — `null`;
- `apply-codex.ts` — `applyCodexRecord(draft, record, ctx)` на тех же строительных блоках редьюсера, что у Claude (`newTool`, `newText`, `finishTool`, `newAgent`, `closeFeedTurn`, `FeedDraft`);
- `from-codex-rollout.ts` — `feedFromCodexRollout(lines, options)` для сева и снимка (в том числе снимка субагента — с отметки `subagent_history_start_ordinal`).

Записи до последнего применённого `ordinal` пропускаются: повторное чтение файла не даёт дублей. Id элементов — из id элементов Codex (`codex:<item.id>`), а не по тексту.

| Запись журнала | Элемент ленты |
|---|---|
| `task_started` | начало хода (`turnStartedAt`) |
| `item_completed` `UserMessage` | `prompt` (текст из `content[].text`; картинки — счётчик `images`) |
| `item_completed` `AgentMessage` | `text`, `streaming: false` (обе фазы — `commentary` и `final_answer`) |
| `item_completed` `Reasoning` | пропуск (thinking у Claude тоже не показывается) |
| `item_completed` `CommandExecution` | `tool` `Bash`: вход `{ command, cwd }` (`command[]` склеенный как в TUI), ответ — `aggregated_output` (предел `FEED_RESULT_LIMIT`), статус `completed` → `done`, `failed` → `failed`, `declined` → `rejected`; `endedAt` из `completed_at_ms` |
| `item_completed` `FileChange` | по одному `tool` на файл (`codex:<item.id>:<n>`): `update` — `Edit` с хунками из `unified_diff`; `add` — `Write` без хунков, вход `{ file_path, content }` (обрезка `FEED_INPUT_LIMIT`); `delete` — `Delete` с `{ file_path }`; `move_path` — во входе |
| `item_completed` `McpToolCall` | `tool` `mcp__<server>__<tool>`, вход `arguments`, ответ — текст `result.content[]` |
| `item_completed` `Extension` (веб-поиск) | `tool` `WebSearch`, вход `{ query }` |
| `item_completed` `ImageView` | `tool` `ViewImage`, вход `{ file_path }` |
| `item_completed` `CollabAgentToolCall` | не `spawn` — `tool` с именем инструмента (`wait_agent`, `send_message`…) и `receiver_thread_ids`; привязка к карточкам агентов — по id тредов |
| `item_completed` `SubAgentActivity` | `started` — карточка `agent` (`agentId` = `agent_thread_id`, статус `running`); `completed` — `done`; `interrupted` — `failed`; `interacted` — без элемента |
| `item_completed` `Plan` | только вход для «Steps» панели; в ленту — нет |
| `item_completed` `ContextCompaction`, `compacted` | `notice` `compact` |
| `task_complete` | `turn` с длительностью от `task_started` |
| `turn_aborted` | `turn` с `interrupted: true` |
| `turn_context` | модель и effort — для подписи в тулбаре; режим — `approval_policy` и `sandbox_policy` подписью |
| незнакомый тип `item` или записи | пропуск, счётчик в `host.log` |

`toolHeadline` (`chat/feed-model.ts`) узнаёт `Delete` и `ViewImage` как инструменты с путём.

**Хунки из `unified_diff`.** Если общего разбора unified diff в core нет, — маленький разборщик в `feed/codex/unified-diff.ts` в `FeedPatchHunk[]` с тем же пределом `FEED_PATCH_LINES`.

**Карточка агента Codex.** Тип — `agent_role` (нет — `agent_nickname`), описание — `agent_nickname`, модель — из `turn_context` журнала агента, задание — первое `response_item/agent_message`, адресованное агенту, после отметки истории; итог — его последний `AgentMessage` с фазой `final_answer`. Поля берёт хост (раздел 5.3) из журнала агента и дописывает в карточку.

**Старый или незнакомый формат.** Записи без `item_completed` (журналы Codex до 0.160 и старая часть журнала, возобновлённого новым Codex) в ленту не идут. Если в непустом журнале не нашлось ни одной понятной записи, в ленте — `notice` «Earlier history of this session is only in Terminal»; новые ходы после неё показываются как обычно. Ни разу не разобранная строка и незнакомые типы пишутся в `host.log` счётчиком, а не ошибкой.

### 5.3 Хост: источник Codex

В `feed-service.ts` выбор источника по провайдеру: Claude Code — как сейчас; Codex — новый `host/src/feed/codex-source.ts`.
- **Какой журнал.** Путь журнала сессии — `activity.logFile(ref)` (`host/src/activity/activity-service.ts:101, 885`; привязка `cwd+time` либо `thread_id`). При одобренных хуках — точный `transcript_path` из `SessionStart`.
- **Где ветвится.** `seed` (`feed-service.ts:481`) и `seedAside` (`:594`) выбирают разбор по провайдеру вместо `isClaudeCode`; `onLogChange` (`:794`) будит и источник Codex.
- **Сев и хвост.** При первой подписке — `feedFromCodexRollout` по всему файлу, дальше чтение с запомненной позиции байтов; неполная последняя строка ждёт продолжения. Новые строки замечает то же слежение за журналами, что ведёт `log-index` (и `fs.watch` с потерей одновременных записей учтён там же); плюс страховочный опрос раз в 2 с, пока сессия жива.
- **Субагенты.** По `SubAgentActivity started` хост находит журнал агента по id треда и читает его хвост с `subagent_history_start_ordinal`. В `LogIndex` (`host/src/activity/log-index.ts:27`) для этого появляется публичный `childLogs(parentThreadId)` поверх внутренних `byParent` (`:54`) и `descendantsOf` (`:89`), а в службе активности — `childLogFile(ref, threadId)`. Дальше: законченные элементы агента становятся `children` его карточки (`agentId`), растёт `toolCount`; задание, тип, модель и итог — как в 5.2. Чтение журнала агента прекращается после `completed`/`interrupted` и последнего прочитанного элемента.
- **Снимок агента.** `agentSnapshot` (`feed-service.ts:650`) у Codex — `feedFromCodexRollout` журнала агента с отметки истории, а не `<журнал>/subagents/agent-<id>.jsonl`.
- **Stop.** `interrupt` (`feed-service.ts:876`) у Codex — Esc, как сейчас, но без `settleInterrupt` Claude (`:631`: приглашение `❯` и стирание вернувшегося промпта): ход закрывает `turn_aborted` журнала. Что Codex делает с набранным после Esc — этап 0.
- **Кольцо, дельты, ревизии** — общие (`FEED_MAX_ITEMS`, `FEED_MAX_BYTES`, пакеты по 50 мс).
- **Признак хоста.** `hello.features` получает `feed-codex`. Окно без него Chat у Codex не включает.

### 5.4 Окно для Codex

- **Гейт.** `feedAvailable` пускает Codex, когда у хоста есть `feed-codex` и версия `codex` ≥ `CODEX_FEED_MIN_VERSION` (`'0.160.0'`, `protocol/src/feed.ts`, копия в core). Ниже — сегмент выключен, подсказка «Chat needs Codex 0.160.0 or newer».
- **Ввод** — `pty.send` (bracketed paste, очередь занятому агенту — как сейчас у Codex). Подсказки `/` у Codex не показываются: санитайзер Codex меняет начало строки на `/`. Вложения уходят списком абсолютных путей в конце сообщения, как в комнате.
- **Stop** — `feed.interrupt`: у Codex Esc в терминал (проверка в этапе 0), ход закрывает `turn_aborted` из журнала.
- **Ожидание одобрения без хуков.** Активность `blocked` по заголовку окна и нет карточки `pending` — баннер «ждёт в терминале» (`WaitingBanner`, как у Claude для диалогов без хука) и автопоказ терминала.
- **Тулбар.** Подпись «модель · effort» — из `turn_context`; режим — подписью из `approval_policy` и `sandbox_policy`; меню модели, effort и режима у Codex нет.
- **Раннее «идёт» без хуков** не показывается: пока команда работает, видна строка «Working…» по активности.

### 5.5 `notify`

Сейчас подмена `-c notify=…` пишет событие `Stop` в журнал событий работы (`core/src/work/codex-notify.ts:59, 86`). Его потребители (проверено по коду 2026-10-07):
- активность: `activity-service.ts:715, 722` → `core/src/work/activity.ts:289` (`case 'Stop'`, `turnEndedAt`); слияние с сигналами терминала Codex — `eventsFor` (`activity-service.ts:323`);
- будильник писем: `host/src/wake/wake-service.ts:563` (`turnEndedAt`), `:583` (`hookedSince` — «хуки уже приходили»), `:157` (счётчик длины журнала); отправка — `host/src/pty/send.ts:81` (`hookedSince`);
- поиск прерванных сессий: `sessions/interrupted.ts:12, 71`.

`last_assistant_message` из этих событий никто не читает (`core/src/work/events.ts:160` его не хранит).

Конец хода у Codex уже приходит и без `notify`: OSC 9 «Agent turn complete» и заголовок окна превращаются в `Stop` (`activity-service.ts:204-217`), а `task_complete` журнала подмешивается через `eventsFor`. Поэтому:
1. В этапе 0 (по коду и тестам, без запуска Codex) проверить, что каждый потребитель выше получает `Stop` и признак «хуки приходили» у Codex из терминала и журнала, а не только из `notify`; где нет — довести.
2. Убрать `{notify}` из `CODEX_CONFIG_FLAGS` (`providers.ts:146`) и его подстановку (`launch.ts:346-349`, `mcp-config.ts:186`); `codex-notify.ts` и его bin удалить, если вызовов не осталось. Свой `notify` человека снова срабатывает.

Не получилось перевести всех потребителей без потерь — подмена остаётся, причина пишется в TODOS.

### 5.6 Хуки Codex по доверию

**Что подключаем.** При запуске Parley добавляет `-c hooks.<Event>=[…]` для `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`. `UserPromptSubmit` не нужен: промпт приходит в журнал законченным `UserMessage` сразу на старте хода. `~/.codex/config.toml` Parley не пишет.

**Обработчик — `command`.** Текст определения хука побайтно стабилен между запусками, сессиями и обновлениями Parley — иначе одобрение слетает. Поэтому команда — постоянный путь `~/.parley/bin/parley-codex-hook` (свой каталог Parley): это короткий скрипт-запускатель, его содержимое (путь к `node` и к мосту в сборке хоста) хост переписывает при старте, а путь и текст хука не меняются. Мост читает stdin, шлёт его в приёмник хуков хоста с токеном сессии и печатает ответ. Сессию и приёмник мост узнаёт из окружения (`PARLEY_HOOK_URL`, `PARLEY_HOOK_TOKEN`, id сессии Parley); окружение в хеш хука не входит.

Обработчик `mcp_tool` не выбран: MCP-сервер Parley связан с хостом только файлами (раздел 2, п. 12) и не может ждать решения окна без нового канала.

Ошибка моста (хост недоступен, таймаут) — пустой вывод и код 0: Codex показывает обычное окно одобрения в TUI.

**Приёмник** — тот же `host/src/hooks/hook-server.ts` (127.0.0.1, токен на сессию), удержание и решения — `hooks/pending.ts`, `hooks/decisions.ts`, вход — `feedService.onHook` (`feed-service.ts:434`). Что меняется:
- `feedHookUrl` (`sessions-service.ts:389`) и выдача токена (`:537`) — и для Codex ≥ `CODEX_FEED_MIN_VERSION`;
- фильтр событий (`hook-server.ts:208`) — набор по провайдеру: у Codex семь событий выше;
- сверка `session_id` с id сессии провайдера (`hook-server.ts:211-228`): у новой сессии Codex id треда ещё не известен (привязка по `cwd+time` приходит позже) — первый `SessionStart` с верным токеном и `x-parley-session` привязывает его, дальше сверка как у Claude;
- разбор событий — свой `applyCodexHookEvent` в core рядом с `apply-codex.ts`: имена событий те же, что у Claude, поля и имена инструментов — Codex.

**Доверие.** Первый пришедший хук сессии (`SessionStart`) — хуки одобрены, хост ставит сессии `decisions: 'window'`. Не пришёл за 15 с после старта процесса — `decisions: 'terminal'`; лента работает на журнале, а в ней один раз — подсказка «Approve Parley's hooks in /hooks to answer approvals here» с кнопкой «Open terminal». Нажимать `/hooks` и одобрять — человеку.

**Карточки.** `PermissionRequest` → карточка `permission`: `toolName` (`Bash`, `apply_patch`, `mcp__…`), `toolInput`, `suggestions: []`; «Allow and don't ask again» у Codex не показывается. Решение окна — ответ хука `allow`/`deny` с текстом для модели. Удержание — до 590 с; дольше — карточка `stale`, ответ в терминале (предел Codex 600 с). Хук OMC человека на `permission_request` не мешает: любой `deny` побеждает.

**Раннее «идёт».** `PreToolUse` ставит в ленту вызов со статусом `running` по `tool_use_id`; законченный элемент журнала с тем же id его закрывает. Совпадают ли `tool_use_id` хука и id элемента журнала — проверка этапа 0; не совпадают — раннего «идёт» нет, лента остаётся на журнале (без дублей). `SubagentStart`/`SubagentStop` привязывают карточку агента раньше журнала; `Stop` закрывает ход раньше `task_complete` (повторное закрытие — без нового элемента).

### 5.7 Протокол (`PROTOCOL_VERSION` остаётся 1)

- `feed.snapshot` и `feed.changed` получают необязательное поле `decisions: 'window' | 'terminal' | null` рядом с `mode` (может ли окно отвечать на одобрения этой сессии; `null` — не известно). Окно прежней сборки поле не читает.
- `hello.features`: `feed-codex`.
- `CODEX_FEED_MIN_VERSION` в `protocol/src/feed.ts`.
- Элементы ленты не меняют форму: новые имена инструментов (`Delete`, `ViewImage`, `WebSearch`, имена инструментов субагентов Codex) — строки. `FEED_SCHEMA_VERSION` остаётся 2. Если план всё же добавит поле элементу, версия растёт по правилу протокола.
- `rightSidebar.tab: 'agents'` — файл окна `ui.json`, не протокол хоста.

### 5.8 Порядок работ

1. **Панель агентов** для Claude и GLM (5.1) — только окно; можно влить и выпустить отдельно.
2. **Этап 0** — живые пробы Codex и проверка потребителей `notify` (раздел 9); итоги правят спеку до кода.
3. **Chat для Codex из журнала** (5.2–5.5): разбор в core, источник на хосте, гейт и окно, агенты Codex в ленте и панели, `notify`.
4. **Хуки Codex по доверию** (5.6): мост, приёмник, карточки, раннее «идёт», подсказка про `/hooks`.
5. **Документы, E2E и живые прогоны** (раздел 8).

## 6. Ошибки и крайние случаи

| Случай | Поведение |
|---|---|
| Журнал Codex ещё не создан (создаётся при первой записи) | Лента пустая, ввод работает; журнал появился — сев |
| Журнал не нашёлся или привязка неоднозначна | `notice` «Codex log not found yet» и рабочий терминал; повторная попытка при каждом обновлении индекса журналов |
| Старый или незнакомый формат журнала | Понятные записи — в ленте, остальное — в терминале; заметка «Earlier history of this session is only in Terminal» (5.2) |
| Оборванная последняя строка | Ждёт продолжения, не разбирается |
| Рестарт хоста | Сев из журнала целиком (кольцо 2000 элементов), карточки из старой истории не становятся активными |
| Esc в самом терминале | `turn_aborted` в журнале закрывает ход чертой «Interrupted» |
| Resume Codex | Журнал тот же или новый — проверка этапа 0; лента сеется из того, что даёт индекс |
| Хуки одобрены, но `PermissionRequest` не пришёл (например, на `apply_patch`) | Баннер «ждёт в терминале», как без хуков |
| Определение хука изменилось (новая версия Parley) | Codex снова не доверяет — `decisions: 'terminal'` и подсказка; лента работает |
| Два окна отвечают на одну карточку | Как у Claude: применяется первое решение |
| Агент без `agentId` (Claude до `SubagentStart`) | В панели «Starting…», провал — после привязки |
| Агент Codex без своего журнала (не найден) | Карточка без вложенных вызовов, «Full transcript» — ошибка с повтором |
| Сайдбар не влезает (узкое окно) | Тулбар и поповер ведут к карточке в ленте, как раньше |

## 7. Совместимость и откат

- Codex ниже 0.160.0, хост без `feed-codex`, окно прежней сборки — Codex только терминалом, как сейчас.
- Хуки не одобрены — Chat у Codex всё равно работает на журнале.
- Откат хуков — убрать `-c hooks.*` из запуска; одобрения в `~/.codex/config.toml` остаются у человека и ни на что не влияют.
- Откат `notify` — вернуть одну строку в `CODEX_CONFIG_FLAGS`.
- Панель — только окно; откат — убрать вкладку, `ui.json` со значением `agents` прочитается как `files`.

## 8. Проверка

- **core:** разбор журнала Codex на фикстурах — строки из журналов пользователя 0.160 (структура настоящая, текст и пути заменены); пропуск дублей по `ordinal`; оборванная строка; агенты с отметкой истории; unified diff в хунки; `applyCodexHookEvent`.
- **host:** источник Codex — сев, хвост, неполная строка, журнал появился позже, журналы агентов, снимок агента; мост хуков — ответ `PermissionRequest`, таймаут, хост недоступен; признак `feed-codex`; `decisions` по первому хуку.
- **desktop:** модель панели (`agentRows`, `agentSteps`, текущий шаг, «Starting…»); компоненты панели и экрана агента; гейт Chat для Codex; подписи тулбара.
- **E2E** (Playwright, настоящий хост):
  - панель агентов на стабе `chat-hooks` (агенты, вложенные вызовы, конец агента, «Show in chat», вход из тулбара и из поповера сайдбара);
  - `codex-chat` на стабе `stub-codex-agent.mjs`, который научится писать журнал и звать хуки: лента, ввод, Stop, карточка Allow/Deny, подсказка без доверия, агент Codex в панели;
  - окна 800×500 и обычное, длинные описания агентов, команды и пути (жалоба 2026-09-27 на короткие значения в проверках); DPR 1 и 2.
- **Живые прогоны** с настоящим Codex (с разрешения человека): без одобренных хуков и с одобренными; с субагентом.

## 9. Этап 0: живые пробы Codex (первая задача плана)

Каждая проба — короткая сессия настоящего `codex` 0.160 в отдельной папке, только с разрешения человека.
1. Журнал пишется построчно во время хода: элементы появляются по мере окончания, а не в конце хода.
2. Esc в TUI прерывает ход; в журнале — `turn_aborted`.
3. Resume: дописывается тот же журнал или создаётся новый.
4. Хуки из `-c`: что показывает TUI при неодобренных хуках (блокирует ли старт), как выглядит одобрение в `/hooks`, переживает ли одобрение перезапуск сессии, resume и смену содержимого запускателя `~/.parley/bin/parley-codex-hook`; какой `session_id` приходит в хуке (id треда?).
5. `PermissionRequest`: приходит на команду, на `apply_patch`, на MCP; ответ `allow`/`deny` снимает окно в TUI.
6. `tool_use_id` хука против id элемента журнала у той же команды.
7. Субагент: журнал агента, отметка истории, где лежит задание, `SubagentStart`/`SubagentStop` и их `agent_id` против id треда.
8. Без запуска Codex: каждый потребитель `notify` из 5.5 получает `Stop` и «хуки приходили» из терминала и журнала.

Итоги — раздел «Факты этапа 0» в этой спеке; расхождения с разделом 5 правят спеку до кода.

## 10. Критерии приёмки

1. Клик по «N agents running» открывает вкладку Agents со списком агентов сессии; у каждого работающего видны описание и текущий шаг, обновляются вживую.
2. Клик по агенту показывает задание, этапы (если есть), вызовы вживую и итог; «Full transcript» и «Show in chat» работают; «← All agents» возвращает к списку.
3. Закончившие агенты — в свёрнутом «Finished (n)» ниже живых.
4. Строка поповера агентов в сайдбаре и в комнате открывает сессию и экран этого агента.
5. Сессия Codex ≥ 0.160.0 открывается в виде Chat: прошлые и новые промпты, ответы, команды с выводом, правки с диффом, вызовы MCP; промпт из поля уходит ровно один раз; переключение Chat ↔ Terminal — тот же тред.
6. Stop прерывает ход Codex; лента закрывает его «Interrupted».
7. Без одобренных хуков одобрение Codex — баннер и терминал; один раз — подсказка про `/hooks`.
8. С одобренными хуками запрос одобрения Codex — карточка Allow/Deny, решение доходит, окно в TUI не показывается.
9. Агенты Codex — карточки в ленте и строки в панели с заданием, вызовами и итогом.
10. Свой `notify` человека срабатывает и в сессиях Parley (или в TODOS записано, почему подмена осталась).
11. Ничего не пишется в `~/.codex` и `~/.claude`, кроме того, что пишет сам CLI по действию человека.
12. Unit, host и E2E зелёные; E2E в 800×500 с длинными значениями; живые прогоны пройдены или их пункты записаны в TODOS.

## 11. Файлы

**core:** `src/feed/codex/rollout-record.ts`, `apply-codex.ts`, `from-codex-rollout.ts`, `unified-diff.ts` (если нет общего), `apply-codex-hook.ts`, фикстуры `src/feed/fixtures/codex-*.jsonl`; `src/work/feed-version.ts` (`CODEX_FEED_MIN_VERSION`); `src/providers.ts` (`CODEX_CONFIG_FLAGS`: хуки, `notify`); `src/work/launch.ts`; `src/work/codex-notify.ts` (судьба после 5.5).

**protocol:** `src/feed.ts` (`CODEX_FEED_MIN_VERSION`, `decisions`), `src/methods.ts` (поле `decisions` в ответах ленты).

**host:** `src/feed/feed-service.ts` (выбор источника, `agentSnapshot`, `interrupt`, `decisions`), `src/feed/codex-source.ts`, `src/activity/log-index.ts` (`childLogs`), `src/activity/activity-service.ts` (`childLogFile`; `Stop` у Codex без `notify`), `src/hooks/hook-server.ts` (события и привязка сессий Codex), мост `codex-hook-bin` и запускатель `~/.parley/bin/parley-codex-hook`, `src/sessions/sessions-service.ts` (адрес приёмника и токен для Codex), признак `feed-codex` в `hello`; потребители `Stop` из 5.5 (`wake-service.ts`, `pty/send.ts`, `sessions/interrupted.ts`) — если этап 0 найдёт пробелы.

**desktop:** `src/shared/ui-types.ts`, `src/shared/strings.ts`, `src/shared/keybindings.ts`, `src/renderer/keys/handler.ts`, `src/renderer/palette/actions.ts`, `src/renderer/shell/RightSidebar.tsx`, `src/renderer/sidebar/SessionRow.tsx`, `src/renderer/layout/bodies/RoomBody.tsx`, `src/renderer/agents/` (`AgentsPanel.tsx`, `AgentDetail.tsx`, `agents-model.ts`, `use-agent-transcript.ts`), `src/renderer/chat/items/AgentItem.tsx` (общий хук транскрипта), `src/renderer/chat/ChatToolbar.tsx`, `ChatView.tsx`, `chat/open-agent.ts`, `chat/ui-store.ts`, `chat/feed-model.ts` (`toolHeadline`), `components/AgentsBadge.tsx` и его вызовы, `lib/feed-view.ts`, палитра; E2E `e2e/agents-panel.spec.ts`, `e2e/codex-chat.spec.ts`, стаб `e2e/stub-codex-agent.mjs`.

**docs:** README (Chat у Codex, панель агентов, `/hooks`), CHANGELOG, TODOS (пункт 21 закрыть, разделы 10 и 18 обновить).

## 12. Вне подпроекта

- Меню модели, effort и режима у Codex в чате (через resume; раздел 10 TODOS).
- Подсказки `/` и команд Codex в поле ввода.
- Вопросы агента Codex (`request_user_input`) карточками — в журнал они не пишутся, хука для них нет.
- `codex app-server` и машинный режим.
- Агенты всех сессий работы в одной панели.
- Автоматизация `/hooks` и любая запись доверия за человека.
