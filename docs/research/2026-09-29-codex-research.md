# Codex CLI как полноправный агент комнаты: проверенные факты

Дата исследования: 2026-09-29. Проверено на Codex CLI 0.159.0 (stable, релиз 2026-09-29 08:05 UTC; 0.161.0-alpha уже в работе) и на репозитории `openai/codex`, ветка `main`, коммит `8ffd91e42a` (2026-09-29 18:53 UTC).

Ограничения исследования: `codex` и `claude` не запускались (даже `--version`), `~/.codex` не читался, агентов не запускал, в репозитории харнесса ничего не менялось (кроме этого файла). Всё, что ниже помечено «на живом не проверено», выведено из документации и исходников.

## 0. Как читать

Метки:
- **[док]** — официальная документация OpenAI (страницы `developers.openai.com/codex/...` отдают 308 на `learn.chatgpt.com/docs/...`; у каждой страницы есть Markdown-двойник `.md`).
- **[код]** — исходники `openai/codex` (`файл:строки`, ветка main на коммите выше; номера строк уплывают, имена функций и констант надёжнее).
- **[вывод]** — мой вывод из [док] и [код], живой проверки нет.
- **не подтверждено** — источника нет.

Про цитаты: текст документации не воспроизвожу (правило об авторских правах), даю пересказ со ссылкой на страницу и раздел. Единственная прямая цитата из документации — в п. 3.2 (правило доверия к хукам). Для кода — файл и строки; отдельные строки интерфейса из исходников (сообщения об ошибках, заголовки) приведены в кавычках как идентификаторы.

Сокращения источников (все `https://learn.chatgpt.com/docs/`):
- **D-cli** `developer-commands.md?surface=cli` (справочник CLI; таблицы флагов на странице рисуются скриптом и в `.md` не попадают — флаги взяты из исходников);
- **D-adv** `config-file/config-advanced.md`; **D-ref** `config-file/config-reference.md`;
- **D-hooks** `hooks.md`; **D-mcp** `extend/mcp.md`; **D-skills** `build-skills.md`;
- **D-sec** `agent-approvals-security.md`; **D-install** `codex/cli.md`; **D-auth** `auth.md`;
- **D-exec** `non-interactive-mode.md`; **D-env** `config-file/environment-variables.md`;
- **D-log** `changelog` (то же: `developers.openai.com/codex/changelog`); **D-full** `llms-full.txt` (сводный экспорт всех страниц).
- Corroboration: Context7 `/openai/codex` (совпадает с исходниками, но местами отстаёт по версии).

## 1. Сводка (главное за одну страницу)

1. **MCP без записи в `~/.codex/config.toml` работает**: `-c mcp_servers.harnas={...}` (инлайн-таблица) или отдельные dotted-ключи. `-c` глобален, действует и в `codex resume`. Текущий `codexMcpOverride` в `packages/core/src/work/mcp-config.ts` синтаксически верен.
2. **У Codex теперь есть настоящие хуки** (12 событий, включая `PermissionRequest` и `Stop`; GA с 2026-05-14), но все неуправляемые (не корпоративные и не системные) хуки запускаются только после разового ревью человеком в `/hooks`. Хуки, заданные через `-c`, считаются такими же и без ревью не работают. Флаг `--dangerously-bypass-hook-trust` не годится.
3. **Сигналы «закончил ход / нужен ты» есть и без хуков и без доверия**: (а) rollout-лог (`task_started`, `task_complete`, `turn_aborted`), (б) заголовок окна терминала (OSC 0): по умолчанию спиннер во время хода и `[ ! ] Action Required` при одобрении (слова Ready/Working добавляет элемент `status`), (в) OSC 9 уведомления `agent-turn-complete` и `approval-requested`, (г) `notify` (только конец хода, JSON последним аргументом). События одобрений в rollout **не пишутся**.
4. **Скиллы**: `.agents/skills` от cwd до корня репозитория, `~/.agents/skills`, `/etc/codex/skills`. Добавить каталог скиллов флагом нельзя. Гид проще доставлять через поле `instructions` MCP-сервера или `-c developer_instructions=...`.
5. **Ввод в TUI**: bracketed paste включён; Enter отправляет; вставка длиннее 1000 символов превращается в плейсхолдер, который раскрывается при отправке; занятому агенту Enter = «вмешаться в текущий ход» (steer), Tab = «в очередь». Открытые всплывающие меню (`/`, `@`, `$`) забирают Enter.
6. **Первый запуск блокируют**: логин (браузер), диалог доверия к папке (git-проект без записи о доверии; запись делает сам Codex в `~/.codex/config.toml`). Диалог обновления пропускается, если передан стартовый промпт.
7. **Дефолты**: одобрения `on-request`, человек-ревьюер; песочница `workspace-write` для помеченных проектов и `read-only` для непомеченных.
8. **Resume**: `codex resume <UUID|имя> [ПРОМПТ]`; id заранее задать нельзя. Модель, усилие, одобрения и песочница восстанавливаются из треда, если их не передавать снова. MCP-конфиг передавать нужно каждый раз.
9. **Общий фоновый демон включён по умолчанию с 0.157.0 (2026-09-25)**; любой `-c` (кроме узкого списка) и `--no-daemon` держат запуск в «встроенном» режиме — хуки и MCP-серверы остаются детьми процесса в вашем pty.
10. **Установка**: npm, Homebrew, `install.sh`. Нет vendor-бинаря = не встал `optionalDependency` `@openai/codex-<платформа>`; лечится переустановкой.
11. **Лимиты**: поля `rate_limits` в `token_count` подтверждены по исходникам, `window_minutes` и `resets_at` бывают `null`, `limit_id` по умолчанию `codex`.

---

## 2. Вопрос 1. MCP-сервер только флагами запуска

### Ответ

Да. Codex разбирает `-c key=value` так: ключ — до первого `=`, значение пробуют разобрать как TOML, при неудаче берут как обычную строку. Вложенные ключи — через точку. Поддерживаются строки в двойных кавычках, массивы `[..]`, инлайн-таблицы `{k = v}`.

Точный синтаксис (argv без оболочки, внешние кавычки нужны только в shell):

```
-c 'mcp_servers.harnas={command="/abs/node",args=["/abs/mcp/server.js"],env={HARNAS_WORK_DIR="/abs/work",HARNAS_SESSION_ID="s-1"},startup_timeout_sec=20}'
```

Эквивалент отдельными флагами (так делает официальный TypeScript SDK):

```
-c 'mcp_servers.harnas.command="/abs/node"'
-c 'mcp_servers.harnas.args=["/abs/mcp/server.js"]'
-c 'mcp_servers.harnas.env.HARNAS_SESSION_ID="s-1"'
-c 'mcp_servers.harnas.startup_timeout_sec=20'
```

Ключи сервера (все документированы): `command`, `args`, `env`, `env_vars`, `cwd`, `startup_timeout_sec` (по умолчанию 10 с), `tool_timeout_sec` (60 с), `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `tools.<tool>.approval_mode`.

Интерактивный режим и `codex resume`: работает. Флаг `-c` объявлен глобальным, а `resume` сливает свои `-c` с корневыми и даёт им наивысший приоритет.

### Источники

- [док] D-adv, раздел «One-off overrides from the CLI»: значения `--config` разбираются как TOML; ключи допускают точечную нотацию; пример `mcp_servers.context7.enabled=false`.
- [док] D-mcp, «Configure with config.toml» и «Other configuration options»: список ключей и умолчания. D-ref, таблица `mcp_servers.<id>.*`.
- [код] `codex-rs/utils/cli/src/config_override.rs:22-24` (значение — TOML, иначе литерал), `:55-63` (делится по первому `=`), `:95-102` (значение оборачивается в `_x_ = <значение>` и парсится как TOML), `:164-169` (тест `parses_inline_table` — инлайн-таблица явно поддерживается), `:29-36` (`global = true`).
- [код] `codex-rs/config/src/overrides.rs:22` — путь режется по `.` **без поддержки кавычек**: ключ вида `projects."/abs/path".trust_level` работать не будет, вложенную таблицу с «неудобными» ключами нужно передавать целым значением.
- [код] `codex-rs/cli/src/main.rs:2557-2590` (`finalize_resume_interactive`), `:2649-2690` (`merge_interactive_cli_flags`): `-c` у `resume` добавляются последними.
- [код] `sdk/typescript/src/exec.ts:261-343` — официальная сериализация: строки через `JSON.stringify`, массивы `[a, b]`, таблицы `{k = v}`, вложенные объекты раскладываются в отдельные `-c path=value`.
- Context7 `/openai/codex` (исходник `codex-rs/config/src/merge.rs`): слой сессионных флагов сливается с пользовательским конфигом рекурсивно по таблицам (`merge_toml_values`), так что одноимённый пользовательский `[mcp_servers.harnas]` не стирается целиком: поля из `-c` перекрывают его поля, остальные остаются.

### Что важно знать про поведение сервера

- **Окружение процесса сервера урезано.** Кроме `env` из конфига и списка `env_vars`, MCP-серверу передаются только `HOME, LOGNAME, PATH, SHELL, USER, LANG, LC_ALL, TERM, TMPDIR, TZ, __CF_USER_TEXT_ENCODING` [код: `codex-rs/rmcp-client/src/utils.rs:16-60`, `:163-175`]. Значит `HARNAS_WORK_DIR` и `HARNAS_SESSION_ID` должны лежать именно в `env` (сейчас так и сделано).
- **Как показываются инструменты**: команда `/mcp` в TUI [док D-mcp]; вызовы в ленте выглядят как ячейки «Calling» / «Called» [код: `codex-rs/tui/src/history_cell/mcp.rs:165-167`]; запуск — «Booting MCP server: <имя>» и «MCP startup incomplete (failed: ...)» [код: `codex-rs/tui/src/chatwidget/mcp_startup.rs:17-18`, `:215-219`]. Модель видит инструменты как `mcp__<сервер>__<инструмент>` [код: `codex-rs/codex-mcp/src/mcp/mod.rs:83-87`, `qualified_mcp_tool_name_prefix`; D-hooks приводит `mcp__filesystem__read_file`].
- **Провал запуска сервера не фатален**, если не задан `required=true` (тогда старт или resume падает) [док D-ref: `mcp_servers.<id>.required`]. Иначе агент молча остаётся без инструментов `harnas`.

### Подтверждение вызовов инструментов MCP

Режим по умолчанию — `auto` (`AppToolApproval::Auto` помечен `#[default]`, [код] `codex-rs/config/src/mcp_types.rs:26-34`). Решение принимается так [код `codex-rs/core/src/mcp_tool_call.rs:2466-2500`, `codex-rs/codex-mcp/src/mcp/mod.rs:91-112`]:

| Режим (`default_tools_approval_mode` или `tools.<t>.approval_mode`) | Когда просят человека |
|---|---|
| `auto` | по аннотациям инструмента: `destructiveHint=true` — да; `readOnlyHint=true` — нет; иначе — да, если `destructiveHint` или `openWorldHint` не заданы либо истинны (незаданные считаются истиной), то есть **без аннотаций спросят; молчание нужно оба `false`** |
| `prompt` | всегда |
| `writes` | всегда, если инструмент не помечен `readOnlyHint=true` |
| `approve` | никогда |

Дополнительно: при политике одобрений `never` вызов, который требует одобрения, **отклоняется** («MCP tool call requires approval, but approval policy is never»), а не выполняется [код: `mcp_tool_call.rs:1620-1624`]. Автоодобрение без вопросов — только при режиме `approve` либо при `never` вместе с полным доступом к диску [код: `codex-mcp/src/mcp/mod.rs:91-112`].

### Следствие для харнесса

- Форму `codexMcpOverride` менять не нужно. Полезные добавки: `startup_timeout_sec`, при желании `required=true`.
- Инструменты `harnas` без аннотаций при `on-request` будут спрашивать человека на **каждый** вызов. Чистое решение без ослабления политики клиента — выставить в самом MCP-сервере аннотации инструментов (`readOnlyHint: true` для чтений; `destructiveHint: false` и `openWorldHint: false` для записи в комнату). Альтернатива — `default_tools_approval_mode="approve"` в `-c` (решение человека, см. риски).
- Не запускать Codex с `--ask-for-approval never`: инструменты `harnas` начнут отклоняться.
- Однозначный признак «сервер поднялся»: сам `harnas-mcp` может писать факт `initialize` в каталог работы; нет рукопожатия за N секунд — предупредить.
- Отладка инструментов в живой сессии: `/mcp`.

**Не подтверждено (живой проверки нет)**: что именно выведет `/mcp` и как выглядит ячейка одобрения для нашего сервера.

---

## 3. Вопрос 2. Сигнал «агент закончил ход / ждёт ввода»

### 3.1. `notify`

**Ответ.** `notify = ["программа", "аргумент", ...]` в конфиге; задаётся и флагом: `-c 'notify=["/abs/node","/abs/harnas-notify.js"]'`. Событие сегодня одно: `agent-turn-complete`. Программа запускается напрямую (без оболочки) с **последним аргументом argv — JSON-строкой**; stdin, stdout и stderr у неё закрыты. Поля JSON (kebab-case): `type`, `thread-id`, `turn-id`, `cwd`, `client` (необязательное, например `codex-tui`), `input-messages` (массив), `last-assistant-message` (строка или `null`). Окружение — снимок окружения процесса Codex (значит, `HARNAS_*` из вашего pty доходят), с вычищенными служебными переменными.

Источники: [док] D-adv, «Notifications» (событие `agent-turn-complete`, JSON одним аргументом, список полей); [код] `codex-rs/hooks/src/legacy_notify.rs:13-42` (структура полезной нагрузки), `:44-73` (запуск, `stdin/stdout/stderr = null`), `codex-rs/hooks/src/registry.rs:79` (снимок окружения), `:124-129` (подключение из `config.notify`), `:322-336` (`command_from_argv`: прямой exec, `env_clear`, затем снимок).

Оговорки:
- В коде стоит `TODO: Remove this hook ... when legacy notify support is removed` (`legacy_notify.rs:44`): механизм «унаследованный», возможно удаление.
- Из проектного `.codex/config.toml` ключ `notify` игнорируется (D-adv, D-ref), из пользовательского слоя и из `-c` — работает.
- Если у человека в `~/.codex/config.toml` есть свой `notify`, наш `-c notify=...` заменит его на время сессии (массив не сливается) [вывод].

### 3.2. Хуки (hooks)

**Ответ.** Есть, и их набор шире, чем у Claude Code. События: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd`. Нет аналога `Notification` (вопрос пользователю через хук не приходит). Общий для всех JSON на stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`; у ходовых событий ещё `turn_id`, `permission_mode`.

Ключевые события для окна:
- `PermissionRequest` — срабатывает, когда Codex собирается спросить одобрение (шелл-эскалация, правка файлов, вызов MCP-инструмента); поля `tool_name`, `tool_input` (у `Bash` — `command`), `tool_input.description`. Если хук не выносит решения (просто пишет в журнал), идёт обычный запрос человеку. Это ровно «нужен ты».
- `Stop` — ход закончен; поля `turn_id`, `stop_hook_active`, `last_assistant_message`; хук может вернуть `{"decision":"block"}` и заставить агента продолжить (нам не нужно). Пустой stdout и код 0 — успех.
- `SessionStart` — поле `source`: `startup`, `resume`, `clear`, `compact`; вместе с `session_id` и `transcript_path` даёт **точный id сессии и путь к rollout-логу** без угадывания по cwd и времени.

Команда хука выполняется в окружении процесса Codex, JSON приходит через stdin (в отличие от `notify`). Текущий `HOOK_COMMAND` харнесса (`cat >> "$HARNAS_WORK_DIR/events/$HARNAS_SESSION_ID.jsonl" || true`) применим как есть, имена событий `HOOK_EVENTS` совпадают с Codex, кроме `Notification`.

**Задание хуков флагами**: раздел `[hooks]` — обычный ключ конфига, значит `-c 'hooks.Stop=[{hooks=[{type="command",command="..."}]}]'` (имена событий в PascalCase; форма — [код] `codex-rs/config/src/hook_config.rs:35-61`). Слой сессионных флагов действительно участвует в поиске хуков (`codex-rs/hooks/src/engine/discovery.rs:126-176`).

**Главная проблема — доверие.** Прямая цитата (D-hooks, «How hooks run»): «Non-managed hooks must be reviewed and trusted before they run.» По коду [`discovery.rs:823-833`] слой `SessionFlags` — **не** управляемый (`is_managed = false`), поэтому хук из `-c` получает статус `Untrusted` и не запускается, пока `hooks.state."<ключ>".trusted_hash` не совпадёт с хешем его определения [`discovery.rs:794-811`, `:713-721`]. Состояние доверия читается только из пользовательского слоя и слоя сессионных флагов [`codex-rs/hooks/src/config_rules.rs:15-66`]. Варианты:

| Вариант | Как | Оценка |
|---|---|---|
| Человек один раз доверяет в `/hooks` | Codex сам записывает доверие (`hooks.state`, читается из пользовательского слоя, `config_rules.rs:15-66`; место записи — [вывод], вероятно `~/.codex/config.toml`); при неизменном тексте хука доверие сохраняется между запусками | безопасно; граница «харнесс не пишет в `~/.codex`» соблюдена; текст хука должен быть побайтно стабильным (значения — из env, а не из шаблона) |
| `--dangerously-bypass-hook-trust` | флаг запуска | **не использовать**: запускает и недоверенные проектные хуки репозитория, отключает демон; без явного согласия человека нельзя |
| `-c hooks.state...trusted_hash=...` | самовыдача доверия | технически возможно, но хеш считается внутренним `version_for_toml` (нестабильный интерфейс) и обходит ревью человека; решать человеку |
| Не использовать хуки | сигналы из п. 3.3 | доверие не нужно |

Дата GA хуков: 2026-05-14 (D-log, запись «Work with Codex from anywhere»). С какой версии CLI они работают — не подтверждено.

### 3.3. Другие сигналы без хуков и без доверия

1. **Rollout-лог (пассивно).** Пишутся `event_msg` с `payload.type`: `task_started` (`turn_id`, `started_at`), `task_complete` (`turn_id`, `last_agent_message`, `error`, метки времени), `turn_aborted` (`reason`); плюс `token_count`. [код: `codex-rs/protocol/src/protocol.rs:1407-1418` (имена `task_started`/`task_complete`, принимаются и `turn_*`), `:2153-2215`, `:4257-4275`; `codex-rs/rollout/src/policy.rs:113-119` (эти события сохраняются)]. **События одобрений в лог не попадают** (`ExecApprovalRequest`, `ApplyPatchApprovalRequest`, `RequestUserInput`, `ElicitationRequest` в списке «транзиентных»: `policy.rs:141-200`, конкретно `:176-180`). Значит для «нужен ты» одного лога мало.
2. **Заголовок окна терминала (OSC 0), включён по умолчанию.** Заголовок по умолчанию — `["spinner","project"]` (D-ref, `tui.terminal_title`; D-full, раздел `/title`). Пока идёт ход — кадр спиннера (⠋⠙⠹...) и проект; **при ожидании ответа человека заголовок меняется на `[ ! ] Action Required | <проект>` с миганием `[ . ]`** [код: `codex-rs/tui/src/chatwidget/status_surfaces.rs:42-43` (префиксы), `:324` и `:387-395` (условие: требуется действие и в списке есть `spinner`), `:1036-1042`; `codex-rs/tui/src/bottom_pane/mod.rs:1717-1724`, `approval_overlay.rs:620`, `mcp_server_elicitation.rs:1647` — что считается «требует действия» (оверлей одобрения, MCP-эликитация, неотвеченные вопросы); запись — `codex-rs/tui/src/terminal_title.rs:90`, `\x1b]0;<текст>\x07`]. Элемент `status` даёт слова «Ready / Working / Waiting / Thinking / Starting» (`status_surfaces.rs:991-1010`; при действии этот элемент из заголовка исключается), элемент `thread-id` (принимается и имя `session-id`) — полный UUID треда (`bottom_pane/title_setup.rs`, перечисление `TerminalTitleItem`). Документированы в D-full/D-ref: `spinner`, `status`, `project`, `thread`, `git-branch`, `model`, `task-progress`; `thread-id`/`session-id` и текст `Action Required` есть **только в исходниках**. Вариант для харнесса: `-c 'tui.terminal_title=["spinner","status","session-id"]'` — заголовок несёт состояние и id сессии (на живом не проверено).
3. **Терминальные уведомления TUI.** `tui.notifications` (bool или список типов; документированы `agent-turn-complete` и `approval-requested`, [D-adv «notify vs tui.notifications»]); по коду типы: `agent-turn-complete`, `approval-requested` (правка/команда/MCP-эликитация), `plan-mode-prompt`, `async-question` [`codex-rs/tui/src/chatwidget/notifications.rs:26-99`]. Способ — `tui.notification_method` (`auto|osc9|bel`; `osc9` пишет `ESC ] 9 ; текст BEL`, [`codex-rs/tui/src/notifications/osc9.rs:46-54`]). Условие `tui.notification_condition` по умолчанию `unfocused`: пока терминал считается сфокусированным (стартовое значение — «в фокусе», обновляется только событиями фокуса), уведомления **подавляются** [`codex-rs/tui/src/tui.rs:114-118`, `:746`, `:1002-1010`] — нужен `always`. Текст «Approval requested: <команда>» / «Codex wants to edit <файл>» / «Agent turn complete» (или 200 знаков ответа) — не типизирован, классифицировать по префиксу.

### Следствие для харнесса

- Рекомендую сначала строить «состояние Codex» на путях без доверия: OSC-заголовок как основной источник (мгновенно; есть «нужен ты»; можно нести `session-id`), rollout-лог как подтверждение конца хода, `notify` для точного текста последнего ответа. Хуки — необязательное усиление после разового доверия человека.
- Разбор OSC 0 и OSC 9 нужен в том, кто держит pty (хост на node-pty), а не только в xterm.js окна: сессия должна иметь состояние и при закрытой панели. Разбирать байтовый поток нужно с буфером на границах чанков.
- Строки заголовка и уведомлений — не публичный интерфейс; закладывать «неизвестное состояние» и тесты-контракты на живом Codex.

**Не подтверждено**: аналог «канала» Claude Code (push из MCP в открытую сессию). В документации не найден; в исходниках есть `codex-mcp/src/event_stream.rs` (потоки событий MCP), назначение не описано.

---

## 4. Вопрос 3. Скиллы

### Ответ

Каталоги поиска [док D-skills, «Where Codex loads local skills»; код `codex-rs/ext/skills/src/host_roots.rs:73-185`]:
- `REPO`: `.agents/skills` в **каждом** каталоге от cwd вверх до корня репозитория (корень — по маркерам проекта, по умолчанию `.git`);
- `USER`: `$HOME/.agents/skills` (устаревший `$CODEX_HOME/skills` ещё читается);
- `ADMIN`: `/etc/codex/skills`; `SYSTEM`: встроенные;
- по коду есть и `<репо>/.codex/skills` (слой проекта) — в документации не упомянут;
- слой сессионных флагов корней **не добавляет** (`host_roots.rs:121-126`): каталог скиллов флагом `-c` не подключить.

Формат: каталог с `SKILL.md`; обязательны поля `name` (до 64 знаков) и `description` (до 1024 знаков) в заголовке; необязательно `agents/openai.yaml` (`policy.allow_implicit_invocation: false` отключает автовыбор). Глубина обхода 6, до 2000 каталогов на корень [`codex-rs/ext/skills/src/loader/mod.rs:19-32`]. Явный вызов — `$имя` или `/skills`; неявный — по `description`. Симлинки: документация прямо говорит, что каталоги-симлинки поддерживаются и Codex идёт по цели. Отдельный флаг включения в документации не упомянут; отключать скиллы можно записями `[[skills.config]]` с `path` и `enabled=false`. Изменения подхватываются автоматически, при сомнениях — перезапуск. В режиме «restricted» (проект помечен недоверенным) скиллы всё равно загружаются (текст экрана доверия: «Skills still load»).

### Следствие для харнесса

- Скилл «harnas» пришлось бы класть в репозиторий пользователя (`.agents/skills/harnas/`) или в `~/.agents/skills` — оба варианта выходят за границы «ничего не пишем в чужие каталоги». Симлинк из `~/.agents/skills/harnas` на каталог харнесса тоже пишет в дом.
- Для доставки гида без записи файлов есть два документированных пути: поле `instructions` в ответе `initialize` MCP-сервера (D-mcp: Codex использует его как общее руководство к инструментам сервера; первые 512 знаков должны быть самодостаточны) и ключ `developer_instructions` (D-ref: «дополнительные инструкции разработчика», задаётся `-c developer_instructions="..."`).
- Как `developer_instructions` ведёт себя при `resume` (дублируется ли, если уже сохранена в истории) — **не подтверждено**.

---

## 5. Вопрос 4. Ввод в интерактивный TUI через pty

### Ответ

- **Bracketed paste включён**: при старте TUI шлёт `EnableBracketedPaste` [`codex-rs/tui/src/tui.rs:245`], фокус-события тоже (`:259`). Вставка идёт как `ESC[200~ ... ESC[201~`.
- Что делает композер со вставкой [`codex-rs/tui/src/bottom_pane/chat_composer/paste_input.rs:111-148`]: `\r\n` и `\r` приводятся к `\n`; текст **длиннее 1000 символов** (`LARGE_PASTE_CHAR_THRESHOLD`, `chat_composer.rs:447`) заменяется в поле ввода плейсхолдером с числом знаков (точный вид текста не проверял) и раскрывается при отправке; текст, похожий на путь к картинке, становится вложением.
- **Отправка**: Enter (по умолчанию `submit_keys = Enter`, `queue_keys = Tab`; `chat_composer.rs:819-820`, обработка `:3523-3533`). Раскладку можно сменить пользовательским `tui.keymap` (D-ref) — слепой Enter при нестандартной раскладке не сработает.
- **Агент занят** [док D-cli, «Interactive shortcuts»; код `chat_composer.rs:3523-3529`]: Enter вмешивается в текущий ход (steer), Tab кладёт сообщение в очередь на следующий ход. Слэш-команды тоже можно ставить в очередь Tab'ом. (0.159.0 добавил необязательный `instant_interrupt`.)
- **Небрекетированный ввод** (быстрые «нажатия клавиш»): работает эвристика «burst» — быстрый поток символов считается вставкой, Enter внутри неё не отправляет [`chat_composer.rs`, блок «Non-bracketed Paste Bursts», `:228-262`; D-log 0.156.0: исправлена потеря отступов, когда терминал шлёт вставку как отдельные нажатия]. Для надёжности использовать именно bracketed paste.

Ловушки:
- **Открытое всплывающее меню забирает Enter.** При токене `@файл`, `$скилл`, команде `/...` под курсором Enter выбирает пункт меню, а не отправляет сообщение [`chat_composer.rs:2171-2190`, `sync_popups` `:3935-4030`]. Если текст заканчивается таким токеном — Enter не отправит. Вставка со строки `/...` или `!...` (режим оболочки) меняет смысл.
- Пока TUI стартует, ввод принимает временный композер («черновик»: `codex-rs/tui/src/startup_orchestration.rs:1-5`, `startup_draft`); будет ли отправка (Enter) работать до готовности сессии — не подтверждено. Стартовое сообщение надёжнее передавать позиционным аргументом (так и делается).
- Нужен настоящий `TERM` (не `dumb`): при `TERM=dumb` Codex спрашивает «Continue anyway? [y/N]» [`codex-rs/cli/src/main.rs`, `run_interactive_tui`].

### Следствие для харнесса

Последовательность отправки [вывод]: дождаться состояния «Ready» без «Action Required» → `ESC[200~` + текст + `ESC[201~` → короткая пауза (десятки мс) → `\r`. Текст делать безопасным: не начинать с `/`, `!`, `$`, не заканчивать токеном `@...`, `$...`, `/...` (завершать обычным словом; при необходимости добавить в конец пробел: токен кончается на пробеле, точка в него входит). Если агент занят — сознательно выбирать Enter (steer) или Tab (очередь). Для писем харнесса подходит Tab (очередь), чтобы не вмешиваться в идущий ход.

**Не подтверждено на живом**: точные задержки; поведение при вставке во время анимации старта.

---

## 6. Вопрос 5. Первый запуск и диалоги

Что может остановить автозапуск (по убыванию вероятности):

1. **Логин.** Без сохранённых учётных данных TUI показывает экран входа (ChatGPT — с открытием браузера; либо ключ API) [док D-auth; D-log 0.159.0]. Проверка без запуска TUI: `codex login status` — код выхода 0, если учётные данные есть [док D-cli]. Хранилище — файл `auth.json` или ключница ОС (`cli_auth_credentials_store`); с ключницей возможен системный диалог macOS — **не подтверждено**.
2. **Доверие к папке.** Для проекта с корнем-git, который **не помечен** в `projects` пользовательского конфига, показывается экран «Folder access»: доверять ли папке (текст предупреждает, что настройки папки могут исполнять код без запроса к модели), кнопки «Trust and continue» / «Quit», решение сохраняется [код `codex-rs/tui/src/onboarding/trust_directory.rs:56-98`]. Условие показа — [`codex-rs/tui/src/config_update.rs:197-395`]: не показывать, если папка (или корень репозитория) помечена доверенной, либо папка вне проекта (нет маркеров корня), либо проектный слой уже включён. Сохранение — запись `projects."<путь>".trust_level = "trusted"` в пользовательский конфиг (`config_update.rs:74-84`); пишет Codex, не харнесс. Для связанных worktree доверие берётся у корня основного репозитория [`codex-rs/git-utils/src/trust.rs:12-24`] — одно решение покрывает и worktree харнесса.
   Управление: только решением человека (ответить в терминале) либо `-c 'projects={"/абсолютный/путь"={trust_level="trusted"}}'` (целой таблицей, см. п. 2; **на живом не проверено**, и это решение человека, а не харнесса).
3. **Диалог обновления.** Показывается, если вышла новая версия и установка умеет обновляться; **пропускается, когда передан непустой стартовый промпт** [`codex-rs/tui/src/lib.rs:1171`]. При `resume` без промпта возможен. Ключ `check_for_update_on_startup=false` отключает проверку (D-ref).
4. **Миграция модели.** Подсказка «попробовать новую модель» показывается, когда у текущей модели в каталоге есть преемник [`codex-rs/tui/src/app/startup_prompts.rs:309-390`]. В упакованном каталоге у четырёх моделей списка харнесса (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`) `upgrade = null`, у `gpt-5.6-*` и `gpt-5.5` он есть [`codex-rs/models-manager/models.json`]. Подтверждения запоминаются в `notice.model_migrations` (D-ref).
5. **Выбор каталога при `resume`**, если cwd отличается от сохранённого: спрашивает; снимается `-c 'tui.resume_cwd="session"'` (или `"current"`), а явный `--cd` приоритетнее (D-cli, раздел `codex resume`).
6. **Не блокирует, но важно**: предупреждение о хуках, требующих ревью (D-hooks); совет-подсказки (`tui.show_tooltips`); экран приветствия; предупреждение при `--dangerously-bypass-approvals-and-sandbox` (`notice.hide_full_access_warning`).
7. **Демон.** При включённом общем демоне могут появляться «варианты восстановления» при несовместимых настройках сервера (D-log 0.157.0). Не касается запусков с `-c` (см. п. 12, «Общий фоновый демон»).

Флаги, не ослабляющие безопасность: `--ask-for-approval on-request` и `--sandbox workspace-write` (явные значения того, что и так «Авто»); `-c check_for_update_on_startup=false` (по желанию); `-c 'tui.resume_cwd="session"'` или `--cd`; `--no-daemon`. Нельзя: `--dangerously-bypass-approvals-and-sandbox` / `--yolo`, `--dangerously-bypass-hook-trust`, `--full-auto` (устарел), `--approve-for-me` (автоматический ревьюер вместо человека).

### Следствие для харнесса

Автозапуск Codex без человека возможен только для проектов, где доверие уже есть и вход выполнен. Иначе агент виснет на экране доверия или входа — это надо показывать как «нужен ты» (признак: нет заголовка `Ready`/`Working` за N секунд после старта, либо разбор текста экрана). Предполётная проверка: `codex login status` и (по желанию) `codex doctor --json` [упомянут в шаблоне баг-репорта репозитория]. Читать `~/.codex/config.toml`, чтобы заранее узнать о доверии, можно только по решению человека: там могут лежать токены в `env` MCP-серверов.

---

## 7. Вопрос 6. Одобрения и песочница по умолчанию

### Ответ

- `--ask-for-approval` (`-a`) принимает **только** `on-request` и `never` [код `codex-rs/utils/cli/src/approval_mode_cli_arg.rs:9-16`; D-ref: `untrusted` больше не поддерживается, `on-failure` устарел, есть ещё таблица `granular`]. Значение по умолчанию — `on-request` [код `codex-rs/protocol/src/protocol.rs:986-996`, `codex-rs/core/src/config/mod.rs:3731-3750`].
- `--sandbox` (`-s`): `read-only`, `workspace-write`, `danger-full-access` [код `sandbox_mode_cli_arg.rs:14-18`].
- Умолчание песочницы [код `codex-rs/core/src/config/permissions.rs:51-62`]: проект помечен (доверенный или недоверенный) → `workspace-write`; **не помечен → `read-only`**. Документация согласована: версионированные папки — «Авто» (запись в рабочую папку и `on-request`), неверсионированные — `read-only`; Codex может стартовать в `read-only`, пока папке не доверят (D-sec, «Defaults and recommendations»). Сеть в `workspace-write` выключена (D-sec).
- Ревьюер одобрений по умолчанию — человек (`approvals_reviewer = user`, D-ref). `--approve-for-me` (алиас `--not-so-yolo`) включает автоматического ревьюера [код `shared_options.rs:43-50`] — для «нужен ты» не годится.
- Профили: `--profile <имя>` накладывает `$CODEX_HOME/<имя>.config.toml`; при `-p` общий демон отключается [`daemon_startup.rs:42-43`].

Как сделать, чтобы запросы одобрения шли человеку в терминал агента, как у Claude Code: ничего дополнительного не требуется — по умолчанию оверлей одобрения показывается в TUI. Чтобы пользовательский конфиг не изменил это в сессиях харнесса, можно явно передать `--ask-for-approval on-request --sandbox workspace-write` (и при желании `-c 'approvals_reviewer="user"'`).

### Следствие для харнесса

Запросы одобрений будут приходить в терминал агента; окно узнаёт о них по заголовку `[ ! ] Action Required` (п. 3.3) или хуку `PermissionRequest` (п. 3.2). Флаги `-a`/`-s` при `resume` считаются явными переопределениями и заменяют сохранённые в треде настройки (п. 8) — передавать их тем же значением безвредно.

---

## 8. Вопрос 7. Возобновление

### Ответ

- Синтаксис [код `codex-rs/cli/src/main.rs:350-370`, D-cli «codex resume»]: `codex resume [SESSION_ID] [PROMPT]`; `SESSION_ID` — UUID или имя сессии (UUID приоритетнее); `--last` берёт последнюю сессию **из текущего cwd**, `--all` снимает фильтр по cwd, `--include-non-interactive` включает неинтерактивные. Промпт после id допустим (`SessionTuiCli` запрещает только `--last ID PROMPT`).
- **Заранее задать id новой сессии нельзя**: поле помечено внутренним и «не публичным флагом» [`codex-rs/tui/src/cli.rs:32-35`].
- **Где взять id** (по надёжности): (а) `session_meta.payload.id` в первой записи rollout-лога и суффикс имени файла `rollout-<время>-<uuid>.jsonl` (у «откатанных» тредов имя `rollout-<время>-<thread>_<rollout>.jsonl` — суффикс это **rollout id**, а не thread id; [код `codex-rs/rollout/src/rollout_file_name.rs:39-74`]); (б) хук `SessionStart` (`session_id`, `transcript_path`) — после доверия; (в) заголовок терминала с элементом `session-id` — по [код]; (г) поле `thread-id` в JSON `notify` — после первого хода; (д) **`_meta.threadId` и `_meta.sessionId` в каждом `tools/call` к любому MCP-серверу** [код `codex-rs/core/src/mcp_tool_call.rs:1257-1260`, `:1403-1435`, применено `:516-528`] — сервер `harnas-mcp` узнаёт id треда при первом же вызове, без гадания «cwd+время»; в документации этого нет; (е) `CODEX_THREAD_ID` в окружении шелл-команд, которые запускает модель [код `codex-rs/protocol/src/shell_environment.rs:7`, `:152`] — не для MCP-сервера; (ж) TUI формирует подсказку `codex resume <id>` (`resume_hint` в итогах выхода) [код `codex-rs/utils/cli/src/resume_command.rs:6-30`]; что она печатается на экран при выходе — [вывод], не проверено.
- **Сохраняются ли `-c` и `-m`**: как флаги — нет, каждый запуск задаёт свои. Но при `resume` настройки **треда** восстанавливаются, если запуск их не переопределяет [код `codex-rs/tui/src/app/config_persistence.rs:31-55`; `codex-rs/tui/src/resume_permissions.rs:15-45`; `codex-rs/tui/src/app_server_session.rs:342-352`]: модель, провайдер и усилие берутся из треда, пока нет `-m`/`--model` и нет `model`, `model_provider`, `model_reasoning_effort` в слое `-c`; политика одобрений, ревьюер и профиль песочницы — пока нет `-a`, `-s` и соответствующих `-c`. `mcp_servers` в тред не сохраняются: `-c mcp_servers.harnas=...` надо передавать при каждом запуске (харнесс так и делает). Действующий `resumeArgs` (`['resume','{providerSessionId}','-c','{mcpConfig}']`) правильно **не** передаёт `-m` и усилие, и потому модель и усилие сохраняются.

### Следствие для харнесса

- Добавить `'{prompt}'` последним аргументом `resumeArgs` у codex (как у claude) — для «указателя на письма» при подъёме спящей сессии; промпт не должен начинаться с `-`.
- Если каталог сессии мог измениться, передавать `--cd` или `-c 'tui.resume_cwd="session"'`, иначе Codex спросит.
- Первичная привязка записи карты к rollout-логу: вместо `cwd+time` использовать `_meta.threadId` из первого вызова MCP или `SessionStart` (если доверие есть).

**Не подтверждено на живом**: поведение `codex resume <несуществующий id>`.

---

## 9. Вопрос 8. Установка и версия

- Официальные способы [док D-install]: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (автономный установщик; каталог по умолчанию `~/.local/bin`, переменная `CODEX_INSTALL_DIR`; для скриптов `CODEX_NON_INTERACTIVE=1`, D-env), `npm install -g @openai/codex`, `brew install --cask codex`; обновление той же командой (Homebrew: `brew upgrade --cask codex`).
- **Почему нет vendor-бинаря.** `@openai/codex` — тонкая JS-обёртка (`codex-cli/bin/codex.js`): она находит платформенный пакет (`@openai/codex-darwin-arm64`, `-darwin-x64`, `-linux-x64`, ...) и запускает `vendor/<triple>/bin/codex` [код `codex-cli/bin/codex.js:16-23`, `:79-110`]. Платформенные пакеты подключаются как `optionalDependencies` при публикации [`codex-cli/scripts/build_npm_package.py:301-307`]. Если их нет (установка с `--omit=optional`, несовпадение архитектуры, например x64-node под Rosetta на arm64-маке, оборванная установка), обёртка бросает «Missing optional dependency @openai/codex-<платформа>. Reinstall Codex: <команда>» (`npm install -g @openai/codex@latest`; при pnpm/bun — их команды, `codex.js:98-109`). Это в точности состояние из `TODOS.md`, раздел 10. Лечение — переустановка; человеку.
- **Как проверить установку**: `codex --version` (проходит всю цепочку, включая нативный бинарь; при отсутствии vendor-бинаря обёртка падает с необработанным исключением Node: ненулевой код и текст ошибки в stderr [вывод из `codex.js:107-109`]); `codex login status` (учётные данные); `codex doctor` (диагностика установки, конфига, входа, терминала, состояния; в шаблоне баг-репорта — `codex doctor --json`, «если версия поддерживает») [D-cli раздел `codex doctor`; `.github/ISSUE_TEMPLATE/3-cli.yml`]. Проба `--version` у харнесса уже есть (`packages/host/src/providers/versions.ts`, на старте хоста); `login status` и `doctor` разумно вызывать при подготовке автозапуска или по действию человека.
- **Формат `codex --version`**: официальная документация формат не приводит [док D-log показывает `@openai/codex@0.159.0` только для npm]. По исходникам имя берётся из пакета `codex-cli` (`codex-rs/cli/Cargo.toml`, `bin_name = "codex"` влияет лишь на строку Usage, `main.rs:116-125`), значит ожидаемый вывод — `codex-cli 0.159.0`. Разбор в `packages/host/src/providers/versions.ts` («первая тройка цифр») к этому готов. **Не подтверждено запуском.**

---

## 10. Вопрос 9. Лимиты в `token_count`

Подтверждено по исходникам [`codex-rs/protocol/src/protocol.rs:2343-2405`], сверено с `packages/core/src/codex/limits.ts`:

- Запись rollout-лога: `{"timestamp":..., ["ordinal":n,] "type":"event_msg", "payload":{"type":"token_count","info":{...},"rate_limits":{...}}}` (`codex-rs/history/src/rollout_payload.rs:35-70`, `codex-rs/history/src/lib.rs:350-356`, `EventMsg` — `protocol.rs:1358`); `token_count` **сохраняется** (`rollout/src/policy.rs:113-119`).
- `rate_limits` может быть `null` (частичные обновления) — читатель харнесса правильно идёт к более ранней записи.
- `RateLimitSnapshot`: `limit_id` (строка или `null`; нормализуется, по умолчанию корзина `codex`; есть и другие, например `codex_other`, [`codex-rs/codex-api/src/rate_limits.rs:53-102`]), `limit_name`, `normal_model_slug`, `primary`, `secondary`, `credits` (`has_credits`, `unlimited`, `balance`), `individual_limit`, `spend_control_reached`, `plan_type`, `rate_limit_reached_type`.
- `RateLimitWindow`: `used_percent` (число 0–100), **`window_minutes` (число или `null`)**, **`resets_at` (Unix-секунды или `null`)** (`protocol.rs:2392-2400`). Харнесс уже пропускает окно без длины или времени сброса и определяет окно по `window_minutes`, а не по имени поля — это верно.
- Данные приходят из заголовков ответов ChatGPT-подписки; для входа по ключу API `rate_limits` может отсутствовать [вывод].
- Добавление, которого нет в комментарии `indexCodexSession`: в `TokenUsage` появилось поле `cache_write_input_tokens` (по умолчанию 0; `protocol.rs:2241-2259`). Комментарий «отдельного счётчика записи в кэш у Codex нет» устарел; как поле входит в `input_tokens` — не подтверждено.
- Альтернатива чтению логов (для сведения): элементы заголовка/строки статуса `five-hour-limit`, `weekly-limit` показывают остаток лимитов в самом TUI; в границах проекта («только то, что отдают CLI») не нужна.

---

## 11. Что в харнессе расходится с текущим Codex (для плана)

1. `.ralph/specs/runners.md`: «подсессий у Codex не бывает». Устарело: в `session_meta` есть `parent_thread_id`, `agent_nickname`, `agent_role`, `source` (`"cli"`, `"exec"`, `{"subagent":...}`, `{"internal":...}`), `thread_source`, `session_id` (корневой тред) [`protocol.rs:2826-2837`, `:3123-3191`]. Логи подагентов лежат в тех же `sessions/`. `discoverCodexSessions` и привязка `cwd+time` могут принять чужой тред: фильтровать по `source == "cli"` и отсутствию `parent_thread_id`.
2. Регулярка в `packages/core/src/codex/discover.ts` (`rollout-.*-<uuid>.jsonl`) для имени с `_` (откатанные треды) захватит rollout id вместо thread id; индексатор берёт id из `session_meta` и потому не страдает.
3. Формат логов сейчас `legacy` (`history_mode`); режим `paginated` создать пока нельзя [D-full, app-server `thread/start`], миграция и сжатие в `.jsonl.zst` — в разработке и выключены [`codex-rs/features/src/lib.rs:1171-1188`]. Читатель должен видеть `history_mode` и `.zst` и не падать.
4. Новые виды записей (`token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, поле `ordinal`) — неизвестные типы пропускаются (уже так).
5. `providers.ts`: комментарий «проверено по codex 0.80» устарел (сейчас 0.159); `resumeArgs` без `{prompt}` (п. 8).
6. `TODOS.md`, раздел 10: «передача MCP-конфига через `-c mcp_servers.harnas=…` не проверена». Теперь подтверждена по исходникам (тест `parses_inline_table`), по документации и по практике официального SDK; на живом Codex по-прежнему нет. Пункт «агент у приглашения для провайдеров без хуков» для Codex решается сигналами из п. 3.3.
7. `mcpConfig()`/`codexMcpOverride`: `channel` для codex правильно игнорируется (канала нет).
8. Комментарий в `providers.ts` «`resume_session_id` помечен `#[clap(skip)]`» остаётся верным для main (`tui/src/cli.rs:32-35`).

## 12. Дополнительные находки

- **Общий фоновый демон** (важно для всех остальных пунктов). Автозапуск демона для интерактивных запусков включён по умолчанию (0.157.0, 2026-09-25; `daemon_auto_start`: Stable, `default_enabled: true`, [`codex-rs/features/src/lib.rs:947-953`]). Когда демон используется, хуки и MCP-серверы, по всей видимости, запускает он, а не процесс в вашем pty, и окружение у них его, а не ваше [вывод: архитектура «TUI — клиент демона», `codex-rs/tui/src/lib.rs:1013-1040`; как именно демон воспроизводит конфиг и окружение, не проверял]. Демон не используется, если есть **любой** `-c`, кроме узкого списка булевых `features.*`, `tui.fullscreen_transcript`, `suppress_unstable_features_warning`, а также при `--profile`, `--oss`, `--strict-config`, `--dangerously-bypass-hook-trust` и `--no-daemon` [`codex-rs/tui/src/daemon_startup.rs:25-89`, `startup_orchestration.rs:176-183`, `:494-499`]. Запуск харнесса с `-c mcp_servers...` уже «встроенный»; для явности можно добавить `--no-daemon` (в CLI-справочнике флаг не описан; есть в D-log 0.156.0 и в `tui/src/cli.rs:83-85`).
- **`codex exec` для `printArgs`** [D-exec, D-cli]: `codex exec "<промпт>"` печатает в stdout только последнее сообщение агента; по умолчанию песочница `read-only`; требуется git-репозиторий или `--skip-git-repo-check`; `--ephemeral` не сохраняет rollout; `--json` даёт поток событий (`thread.started` с `thread_id`, `turn.completed` и др.); `-o <файл>` пишет последнее сообщение; `codex exec resume <id|--last> "<промпт>"`. Если включён `required=true` для MCP-сервера и он не поднялся, `exec` завершается с ошибкой.
- **Хук-обработчик типа `mcp_tool`** [D-hooks]: жизненное событие может вызвать инструмент уже подключённого MCP-сервера (например, `harnas`) — тоже требует ревью доверия.
- **Codex App Server** (JSON-RPC: `turn/steer`, одобрения как серверные запросы, события ходов) — документированная программная поверхность вместо разбора pty; пригодилась бы, если решат не скрейпить терминал (D-full, «Codex App Server»). Вне текущей рамки.
- **`CODEX_HOME`** (D-env) задаёт корень состояния (конфиг, вход, логи, сессии): отдельный `CODEX_HOME` для харнесса потерял бы вход и историю — не подходит.

---

## 13. Риски и открытые вопросы для человека

**Решения, которые нельзя принимать за человека**

1. **Хуки и доверие.** Хуки дали бы структурные `PermissionRequest`/`Stop`/`SessionStart`, но требуют разового `/hooks`-доверия. Варианты: (а) не использовать, ограничиться сигналами без доверия (моя рекомендация для старта); (б) просить человека довериться один раз (текст хука должен быть побайтово стабилен); (в) самовыдача доверия через `-c hooks.state...trusted_hash` (обход ревью, нестабильный хеш); (г) `--dangerously-bypass-hook-trust` — не рекомендую (запускает и недоверенные проектные хуки).
2. **Доверие к проекту.** Разрешить ли харнессу передавать `-c 'projects={"<путь>"={trust_level="trusted"}}'` после явного согласия человека в окне, или человек всегда отвечает на экран Codex сам. Это включает проектные `.codex/`-слои (конфиг, хуки, правила).
3. **Одобрения инструментов `harnas`.** Аннотировать инструменты в самом сервере (`readOnlyHint`, `destructiveHint:false`, `openWorldHint:false`) или ослабить клиент через `default_tools_approval_mode="approve"`.
4. **Замена пользовательских настроек на время сессии.** `-c notify=...`, `tui.notifications`, `tui.terminal_title` перекроют личные настройки человека в сессиях харнесса. Допустимо ли; нужно ли вызывать его `notify`.
5. **Чтение `~/.codex/config.toml`** ради заранее известного доверия и его `notify`: файл может содержать токены. Разрешать ли (аутентификационный файл и логи по-прежнему не читаются).
6. **Ручные шаги остаются людям**: переустановка Codex (нет vendor-бинаря), вход, первый ответ на экран доверия.

**Технические риски**

7. **Недокументированные внутренности**, на которых держатся лучшие сигналы: строки OSC-заголовка (`Action Required`, `Ready`), тексты OSC 9, `_meta.threadId`, `CODEX_THREAD_ID`, элемент `session-id`. Нужны контрактные проверки на живом Codex и явное состояние «неизвестно».
8. **Скорость изменений**: общий демон включён по умолчанию только с 2026-09-25 (0.157.0), формат логов и набор событий меняются; зафиксировать минимальную проверенную версию (0.159.0) и показывать версию из `codex --version` в окне.
9. **Ввод**: всплывающие меню съедают Enter; нестандартный `tui.keymap`; текст, начинающийся с `/`, `!`, `$`; плейсхолдер вставки >1000 знаков; занятый агент (steer против очереди).
10. **Молчаливая потеря инструментов**: если `harnas-mcp` не поднялся, Codex продолжает без него (нет `required=true`).
11. **Разбор `-c` мягкий**: значение, не разобравшееся как TOML, превращается в строку без ошибки; корректность экранирования (`JSON.stringify`) проверять тестом; символы DEL и одиночные суррогаты в строках дали бы неверный TOML.
12. **Подагенты и внутренние треды** попадают в `sessions/` (п. 11.1) — риск неверной привязки и лишних сессий в списке.
13. **Общий демон**: если запуск без `-c` и без `--no-daemon`, MCP-серверы и хуки, вероятно, идут из окружения демона (нет `HARNAS_*`) [вывод].
14. **Ключница macOS**: возможен системный диалог доступа к Keychain при чтении учётных данных — не подтверждено.
15. **Легаси `notify`** может быть удалён; хуки — задел на будущее.

## 14. План живой проверки (когда разрешат запускать настоящий Codex)

1. `codex --version`; `codex login status`; `codex doctor --json` — формат вывода и код выхода.
2. Запуск с `-c mcp_servers.harnas={...}` в инлайн-форме и в форме отдельных ключей: `/mcp`, вызов инструмента, есть ли запрос одобрения без аннотаций и с ними; `_meta` вызова (`threadId`, `sessionId`).
3. Снять сырой поток pty: последовательность OSC 0/OSC 9 в состояниях «старт», «работа», «одобрение», «конец хода», «MCP не поднялся»; с `tui.notification_condition="always"` и без.
4. Свежий git-проект: экран доверия; подавляет ли его `-c projects={...}`; появление записи в `~/.codex/config.toml` после «Trust and continue».
5. Хук `Stop` через `-c hooks.Stop=[...]`: статус `Untrusted`, предупреждение при старте, что записывает `/hooks` и сохраняется ли доверие между запусками.
6. Вставка: bracketed paste 50 и 1500 знаков + `\r`; меню `@`/`/`; поведение при занятом агенте (Enter и Tab).
7. `resume`: модель, усилие, песочница без флагов и с флагами; `resume <id> "<промпт>"`; запрос каталога при смене cwd.
8. Убедиться, что запуск с `-c` не поднимает общий демон.
9. Сверить, что для ключевого входа (не подписка) `rate_limits` пуст.
