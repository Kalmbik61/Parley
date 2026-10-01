# Окно без терминала поверх CLI: разведка

Дата: 2026-10-01. Проверено на установленном `claude` 2.1.286 и документации `code.claude.com/docs` на эту же дату. Codex не трогали: сначала Claude Code, как решено в TODOS, прогон 18.

Что сделано: 9 запусков настоящего интерактивного `claude` в скрытом PTY (как его запускает хост Parley), около 16 обращений к модели Haiku 4.5, всё в пустой папке вне репозитория. Настройки пользователя не грузились (`--setting-sources project,local`, `--strict-mcp-config`), чтобы плагины и хуки человека не мешали измерениям. Стенд, скрипты проб и улики (экраны, события хуков, строка статуса) лежат в `docs/research/2026-10-01-chat-view-spike/`.

## 0. Как читать

Метки:
- **[проба]** — проверено вживую на стенде, улика в `evidence/<проба>/`;
- **[журнал]** — по настоящим журналам 22 интерактивных сессий CLI за три недели (версии 2.1.250–2.1.283) на этой машине;
- **[док]** — по документации, вживую не проверено (страница и раздел указаны);
- **[вывод]** — моё заключение.

Текст документации не воспроизвожу (правило об авторских правах), даю пересказ со ссылкой на страницу. Подписи диалогов и подвала CLI привожу в кавычках как идентификаторы.

## 1. Сводка

1. **Гибрид работает, и главный канал — не клавиши, а хуки.** Claude Code отдаёт хуками всё, что нужно ленте: промпт человека, текст ответа по мере вывода (`MessageDisplay`), каждый вызов инструмента с аргументами и результатом (`PreToolUse`, `PostToolUse`), запрос разрешения с командой и подсказками (`PermissionRequest`), конец хода с полным текстом ответа (`Stop`), ошибку API (`StopFailure`). **[проба]**
2. **На запрос разрешения окно отвечает структурно, без клавиш:** хук `PermissionRequest` возвращает `allow` или `deny` с сообщением для модели, может сменить режим на `acceptEdits`. Пока хук ждёт нажатия в окне, обычный диалог всё равно виден в терминале и отвечает на клавиши; по таймауту хука диалог остаётся. Оба канала живут одновременно. **[проба]**
3. **Вопрос агента с вариантами** (`AskUserQuestion`) окно получает хуком `PreToolUse` целиком (вопросы, варианты, описания) и отвечает тем же хуком: `allow` + `updatedInput.answers`. Диалог в терминале при этом не появляется. Клавишами тоже работает. **[проба]**
4. **Одобрение плана** (`ExitPlanMode`): текст плана приходит в `PreToolUse` и `PermissionRequest`; диалог с тремя вариантами отвечает на клавиши; после одобрения режим становится `acceptEdits`. **[проба]**
5. **Режим работы.** Узнать текущий — из любого хука (`permission_mode`) и из подвала экрана. Сменить: `Shift+Tab` крутит цикл manual → accept edits → plan → manual; `/plan` включает план напрямую; хук `PermissionRequest` может поставить режим при ответе на запрос. Журнал сессии записывает режим только на границе хода, для живого состояния он не годится. **[проба]**
6. **Клавиши нужны там, где хука нет:** смена режима, прерывание (Esc), меню. Клавишу слать только когда экран успокоился, и сверять результат по экрану до следующего шага — первая же проба на диалоге доверия показала, что ранний Enter подтверждает не тот пункт. **[проба]**
7. **Только экран, хуков нет:** диалог доверия папке при первом запуске (ни хуков, ни журнала, ни строки статуса до ответа; пункт по умолчанию — «No, exit»), экран входа, меню `/model`, `/resume`, `/config`, `/permissions`, отказ по Esc на запросе разрешения и прерывание Esc (хук `Stop` не приходит). Для них скрытый терминал нужно показывать. **[проба]**
8. **Журнал сессии** годится как история и для диффов (`toolUseResult.structuredPatch`), но не как живая лента: текст ответа упал в файл одной порцией через 84 мс после конца хода, а хук `MessageDisplay` отдавал его построчно за 1,9 с до того. **[проба]**
9. **Рамка не меняется:** агент — тот же немодифицированный интерактивный `claude` под логином человека, хуки и строка статуса — документированные механизмы, которые Parley уже использует через `--settings`. Решение хуком — это ответ от имени человека, в рамке только когда кнопку нажал человек (TODOS, прогон 18).
10. **Субагенты видны целиком** (`evidence/p6b-subagents`): вызов `Agent` даёт описание задачи, тип и модель; вложенные вызовы субагента приходят теми же хуками с `agent_id` и `agent_type`; `SubagentStop` отдаёт итоговый текст и путь к журналу субагента; ход родителя заканчивается `Stop` со списком `background_tasks`, а пробуждение приходит как `UserPromptSubmit` с `<task-notification>`. Этого хватает, чтобы показать, какой агент сколько субагентов запустил и зачем — и в сессии, и у участника комнаты. **[проба]**

## 2. Три источника сигналов

### 2.1 Хуки **[проба]**

Увидено на стенде (поля — из настоящих событий, `evidence/*/events.jsonl`):

| Событие | Что даёт окну | Поля сверх общих |
|---|---|---|
| `SessionStart` | начало, `source` = startup / clear, модель, путь к журналу | `source`, `model` |
| `UserPromptSubmit` | промпт ушёл, текущий режим | `prompt`, `permission_mode` |
| `MessageDisplay` | текст ответа по мере вывода, порциями из целых строк | `turn_id`, `message_id`, `index`, `final`, `delta` |
| `PreToolUse` | вызов инструмента с аргументами до выполнения | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | запрос разрешения: команда или файл, подсказки | `tool_name`, `tool_input`, `permission_suggestions` |
| `PostToolUse` | результат инструмента, у Write/Edit — дифф | `tool_response`, `duration_ms` |
| `PostToolBatch` | конец пачки параллельных вызовов | `tool_calls` |
| `Stop` | конец хода, полный текст ответа | `last_assistant_message`, `background_tasks`, `session_crons` |
| `StopFailure` | ход оборвался ошибкой API | `error`, `last_assistant_message` |
| `Notification` | `permission_prompt` через 6 с ожидания, `idle_prompt` через 60 с | `notification_type`, `message` |
| `SessionEnd` | выход: `prompt_input_exit`, `clear`, `other` | `reason` |
| `SubagentStart` | субагент запущен (в тот же момент, что `PostToolUse(Agent)`) | `agent_id`, `agent_type` |
| `SubagentStop` | субагент закончил: итоговый текст, журнал субагента. С пустым `agent_type` — служебный (заголовок, подсказки) — шум | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks` |
| хуки внутри субагента | `PreToolUse`, `PostToolUse`, `PostToolBatch` субагента приходят с его метками — вложенные вызовы видны живьём | `agent_id`, `agent_type` |
| `PostModelSwitch` | смена модели; с `source: auto` — служебная (заголовок, план) — шум | `from_model`, `to_model`, `source` |

Общие поля всех событий: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, у большинства — `permission_mode`.

Инструмент `Agent` (`evidence/p6b-subagents`): `tool_input` — `description`, `prompt`, `subagent_type`, при явном указании `model` и `run_in_background`; с 2.1.198 субагенты фоновые по умолчанию, и `tool_response` приходит сразу — `status: async_launched`, `agentId`, `description`, `resolvedModel`, `prompt`, `outputFile`. Ход родителя заканчивается `Stop` с `background_tasks` (`id` = `agentId`, `type: subagent`, `status`, `description`, `agent_type`). Когда субагент закончил, родитель просыпается `UserPromptSubmit`, чей `prompt` начинается с `<task-notification>` (`task-id`, `tool-use-id`, `status`, `summary`) — это не промпт человека. Журнал субагента — `<сессия>/subagents/agent-<id>.jsonl`, записи с `isSidechain: true` и `agentId`; на этой машине таких журналов 497. Foreground-субагент (`run_in_background: false`) по документации отдаёт в `tool_response` ещё `content`, `totalToolUseCount`, `totalDurationMs` (hooks, «PreToolUse input» → «Agent») — на стенде не гонялся. `MessageDisplay` внутри субагента не приходил.

Решения, проверенные на стенде:
- `PermissionRequest` → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`: инструмент выполнился через 0,45 с, в терминале под вызовом подпись «Allowed by PermissionRequest hook». С `"deny"` и `message` модель получила сообщение и ответила «The command was declined». С `updatedPermissions: [{type: "setMode", mode: "acceptEdits", destination: "session"}]` все следующие хуки пришли с `permission_mode: acceptEdits`, подвал сменился на «accept edits on», строка статуса перезапустилась.
- `PreToolUse` для `AskUserQuestion` → `permissionDecision: "allow"` + `updatedInput` с исходными `questions` и `answers: {"Which fruit?": "Pear"}`: диалог не показан, `PostToolUse` через 32 мс, модель ответила «Pear». Документация описывает приём для `-p`-режима (hooks, «PreToolUse decision control»), в интерактивной сессии он работает так же.
- Таймаут: хук `PermissionRequest` с `timeout: 6` промолчал — диалог в терминале оставался и принял Enter; никаких ошибок в ленте. Умолчание таймаута — 600 с для хуков `command` и `http` (hooks, «Common fields»). **[док]**

По документации, вживую не проверено **[док]**:
- **HTTP-хуки** (`type: "http"`): тот же JSON уходит POST-запросом на локальный адрес, решение — тело ответа 2xx (hooks, «HTTP hook fields», «HTTP response handling»). Хосту это удобнее, чем `cat >> файл` и опрос файла: событие приходит сразу, ответ на запрос — просто задержанный HTTP-ответ.
- `Elicitation` — форма MCP-сервера, хук может ответить `accept/decline/cancel` с полями (hooks, «Elicitation»).
- `PreModelSwitch` может отклонить смену модели; `PostModelSwitch` сообщает `from_model`/`to_model`.
- `SessionStart` для `resume`, `compact`, `fork`; при `resume` — сколько прошло времени и дорог ли прогрев кэша.

### 2.2 Журнал сессии **[журнал]** **[проба]**

- Записи: `user`, `assistant` (блоки `text`, `thinking`, `tool_use`; у `user` — `tool_result` и `image`), `attachment` (вывод хуков, напоминания), `system` (`turn_duration`, `stop_hook_summary`, `informational`), `queue-operation` (`enqueue`/`dequeue` очереди сообщений), `permission-mode` и `mode`, `last-prompt`, `ai-title`/`custom-title`, `file-history-snapshot`, `cost-state`.
- `toolUseResult`: у `Bash` — `stdout`, `stderr`, `interrupted`; у `Edit` и `Write` — `filePath`, `originalFile`, `structuredPatch` (хунки для диффа); у `Read` — `type`, `file`; у `Agent` — `agentId`, `outputFile`.
- Отставание: запись промпта появилась через 145 мс после хука `UserPromptSubmit`; ответ модели — одной порцией после `Stop`. Документация прямо предупреждает, что файл пишется асинхронно и может не содержать последних сообщений хода (hooks, «Common input fields», про `transcript_path`). **[док]**
- Запись `permission-mode` обновилась только после следующего хода, а не при смене режима.
- Отказ по Esc виден только здесь: `tool_result` с текстом «The user doesn't want to proceed…», `toolUseResult: "User rejected tool use"`. Прерывание ответа — запись `user` с текстом «[Request interrupted by user]».
- `/clear` заводит новый `session_id` и новый файл; путь приходит в `SessionStart` с `source: clear`.
- Формат недокументирован (handoff, раздел 4): адаптер с версией схемы и тесты на настоящих файлах остаются обязательными.

### 2.3 Строка статуса **[проба]**

Скрипт получает JSON с `model`, `cost`, `context_window` (использовано, процент), `rate_limits` (5 часов и 7 дней — проценты и время сброса), `prompt_cache`, `session_name`, `output_style`, `fast_mode`, `thinking`, `version`. Режима разрешений в JSON нет, но скрипт перезапускается при каждой смене режима (statusline, «When it updates»), поэтому годится как сигнал «что-то изменилось, перечитай подвал». Parley уже снимает лимиты этим путём.

### 2.4 Экран **[проба]**

Что видно только здесь: диалог доверия папке, экран входа, меню `/model` (список моделей, «Enter to set as default · s to use this session only · Esc to cancel»), подвал с режимом («⏸ manual mode on», «⏵⏵ accept edits on (shift+tab to cycle)», «⏸ plan mode on (shift+tab to cycle)»), спиннер с токенами, подсказки CLI.

## 3. Матрица «можем / не можем»

| Что нужно окну | Как | Статус |
|---|---|---|
| Промпт человека → агенту | `pty.send` (вставка + Enter), уже есть | **[проба]** работает, `UserPromptSubmit` через 0,3 с |
| Текст ответа по мере вывода | хук `MessageDisplay` | **[проба]** построчно, 100–250 мс между строками |
| Размышления модели | только журнал, блок `thinking`, после хода | **[журнал]** |
| Вызовы инструментов и результаты | `PreToolUse` + `PostToolUse` | **[проба]** |
| Диффы правок | `PostToolUse(Edit/Write).tool_response.structuredPatch`, то же в журнале | **[проба]** |
| Запрос разрешения: показать | `PermissionRequest` (команда, файл, подсказки) | **[проба]** |
| Разрешить / отказать | решение хука `allow` / `deny` + `message` | **[проба]** |
| «Всегда разрешать» | `updatedPermissions: addRules` с `destination` | **[док]** |
| Отменить ход и сказать, что делать иначе | клавиша Esc в диалоге; хука `Stop` не будет | **[проба]** |
| Вопрос агента с вариантами | `PreToolUse(AskUserQuestion)` + `updatedInput.answers`; или клавиши | **[проба]** оба пути |
| Одобрение плана | `PreToolUse/PermissionRequest(ExitPlanMode)` с текстом плана; ответ клавишами | **[проба]** клавиши; ответ хуком по той же схеме, что у вопроса — **[док]** |
| Текущий режим | `permission_mode` в хуках; подвал экрана | **[проба]** |
| Сменить режим | `Shift+Tab` (цикл) + сверка подвала; `/plan`; `setMode` в ответе хука; `--permission-mode` при запуске | **[проба]** первые три |
| Сменить модель, усилие | `/model <имя>`, `/effort <уровень>` текстом; `PostModelSwitch` подтверждает | **[док]**; `/model` без аргумента — меню, только экран **[проба]** |
| Прервать ответ | Esc; журнал пишет «[Request interrupted by user]» | **[проба]** |
| Сообщение во время работы | `pty.send` ставит в очередь; `queue-operation` в журнале, `UserPromptSubmit` при отправке | **[проба]** |
| Конец хода, ошибки API | `Stop` с текстом; `StopFailure` с `error` | **[проба]** |
| Лимиты, контекст, стоимость | строка статуса | **[проба]** |
| `/clear`, `/compact` | `SessionEnd(clear)` + `SessionStart(clear)` с новым журналом; `PreCompact`/`PostCompact` | **[проба]** clear; compact — **[док]** |
| Субагенты: кто, сколько, зачем | `PreToolUse(Agent)` (описание, тип, модель) + `SubagentStart`/`SubagentStop` + вложенные хуки с `agent_id` + `Stop.background_tasks`; журнал `agent_transcript_path` | **[проба]** фоновый агент; foreground-поля — **[док]** |
| Доверие папке, вход, меню настроек | только экран | **[проба]** показывать терминал |
| Формы MCP (elicitation) | хук `Elicitation` | **[док]** |
| Картинки во вводе | не проверялось | — |

## 4. Хронометраж одного хода **[проба]**

Промпт из 12 строк, Haiku 4.5, отсчёт от вставки текста в PTY (`evidence/p1-stream`):
- `UserPromptSubmit` +0,29 с; запись `user` в журнале +0,43 с;
- первая строка ответа в `MessageDisplay` +5,58 с (ожидание модели), дальше 12 порций по одной строке за 1,9 с, последняя вместе со `Stop` +7,49 с;
- `assistant` в журнале +7,57 с — весь текст разом, уже после `Stop`.

Запрос разрешения: `PreToolUse` → `PermissionRequest` 33 мс; решение хука → `PostToolUse` 0,45 с; Enter в диалоге → `PostToolUse` около 0,4 с.

## 5. Следствия для устройства Parley **[вывод]**

1. **Хуки — на хост по HTTP, а не через файл.** Сейчас хост читает журнал хуков файлом (`core/work/settings-file.ts`). Для ленты и ответов нужен канал туда и обратно: локальный HTTP-адрес хоста в `--settings`, события — POST, решения — тело ответа. Файл можно оставить как страховку. Таймаут хука `PermissionRequest` поднять с запасом (умолчание 600 с), `MessageDisplay` держит порцию до ответа хука — отвечать мгновенно.
2. **Карточка разрешения** строится из `tool_input` и `permission_suggestions`, а не из текста диалога: подписи вариантов в терминале зависят от контекста (в папке вне проекта второй пункт был про доступ к каталогу, у файлов — про переход в accept edits). Три действия окна: разрешить, отказать с текстом для модели, разрешить и дальше не спрашивать.
3. **Терминал и окно не спорят.** Пока окно ждёт нажатия, диалог в терминале живой; кто ответил первым, тот и прав. Значит, переключатель «Terminal» можно показывать в любой момент без гонок.
4. **Клавиши — по протоколу:** дождаться тишины PTY, нажать, сверить экран, только потом подтверждать. Так уже работает «печать хоста» для `pty.send`; для `Shift+Tab` сверка — подвал, для меню — выделенная строка.
5. **Автопоказ терминала**: пока не пришёл `SessionStart` (доверие, вход, предупреждение канала) и когда на экране меню или спиннер без хуков дольше порога — окно само показывает терминал или помечает «нужен ты». Это же следует из правила про способы входа (TODOS, прогон 18).
6. **Конец хода без `Stop`** (Esc в диалоге, прерывание) ловить по журналу: `tool_result` с отказом или запись «[Request interrupted by user]», плюс возврат приглашения на экране.
7. **Шум хуков**: `SubagentStop` с пустым `agent_type` и `PostModelSwitch` с `source: auto` — от генерации заголовка; в ленту не показывать. Счётчик субагентов с 0.2.0 ведётся по id, и чужая остановка без старта ничего не снимает (`activity.ts`).
8. **Ответы терминала на запросы программы** (DA1 и прочие) для клавиш не нужны — проверено на меню с ответами и без. Но headless-терминал хоста их всё равно отдаёт; при скрытом окне терминала это и остаётся единственным «терминалом».
9. **Хрупкость**: формат журнала недокументирован; состав хуков растёт с версиями (`MessageDisplay`, `PostToolBatch` новые) — проверять `claude --version` и держать тесты на настоящих событиях из `evidence/`.

Смежное, на будущее **[док]**: у Claude Code есть собственный менеджер нескольких сессий в терминале — `claude --bg`, `claude agents`, `claude attach`, экран agent-view (страница agent-view), — и Remote Control, который показывает локальную сессию в чате claude.ai (страница remote-control). Оба — официальные, но живут в терминале и на claude.ai, а не в чужом окне.

## 6. Не проверено

- Codex: лента из `~/.codex/sessions`, одобрения разбором терминала (TODOS, прогон 10) — отдельная разведка.
- Ответ хуком на `ExitPlanMode` (`allow` + `updatedInput`), «всегда разрешать» через `updatedPermissions: addRules`, `Elicitation`.
- Хуки пользователя и плагины рядом с хуками Parley: стенд их отключал.
- Foreground-субагент (`run_in_background: false`) и несколько параллельных агентов в одной пачке: на стенде был один фоновый Explore.
- Длинные абзацы в `MessageDisplay` (порция — целые строки, абзац без переносов придёт одной порцией), картинки во вводе, `Tab to amend` в диалоге, `--ax-screen-reader` для разбора экрана, режим `auto` в цикле `Shift+Tab` (на стенде его не было).
- Linux и Windows.

## 7. Побочная находка: вход CLI «on hold»

С 08:08 до 09:21 (локальное время) 15 сессий проекта `journal-agent`, запущенных через Agent SDK (`promptSource: sdk`, `claude-desktop` в `entrypoint`), и первая проба стенда в 15:31 получили от API `account_on_hold`: «Your account is on hold and can't use Claude Code». Организация та же, что у сессий Claude Desktop, которые всё это время работали. Последний успешный ответ через вход CLI до этого — 29 сентября 22:16. После повторного `/login` в CLI (сообщение пользователя в 15:38) ошибка исчезла, все пробы прошли. Документация (errors, «Your account is on hold») утверждает, что повторный вход такую блокировку не снимает, — здесь снял; причина не выяснена.

Хуком это видно как `StopFailure` с `error: account_on_hold`, в журнале — `assistant` с `isApiErrorMessage: true`. Окну стоит показывать такие ошибки карточкой.

## 8. Стенд

`docs/research/2026-10-01-chat-view-spike/`:
- `lib.mjs` — запуск `claude` в PTY через `node-pty` и `@xterm/headless` из `packages/host` (путь к пакету — `PARLEY_HOST_PKG`), запись экрана, хуков, журнала и строки статуса, печать и клавиши;
- `hook.mjs` — хук: пишет stdin как есть в `events.jsonl`, по `control.json` ждёт `decision.json` и отдаёт его в stdout; `statusline.mjs` — сохраняет JSON строки статуса;
- `p0`–`p6` — сценарии проб (`p6` — субагент); запуск `node p1-stream.mjs` из этой папки, вывод — в `out/<проба>/` (экраны, `timeline.json`, `pty.raw`);
- `evidence/<проба>/` — экраны и `events.jsonl` всех прогонов.

Следы проб вне репозитория: папка `scratchpad/chat-probe/proj` во временном каталоге сессии с файлами проб, её запись о доверии в `~/.claude.json`, журналы 9 сессий в `~/.claude/projects/-private-tmp-…-chat-probe-proj/`, план `~/.claude/plans/make-a-two-line-plan-bright-cerf.md`. В `~/.claude` я ничего не правил и не удалял.
