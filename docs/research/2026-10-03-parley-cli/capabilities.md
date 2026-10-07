# P03: подтверждённые команды Capabilities и scopes

Дата: 2026-10-03. Рабочая база: `c1d4bb4`, ветка `codex/parley-upgrade`.
Проверены установленные **Claude Code 2.1.287** и **codex-cli 0.156.1** на macOS arm64.
Это evidence исследования CLI, а не проверка запуска сессий Parley и не реализация адаптера.

## Метод и границы

Сначала прочитаны CLI `--help` для перечисленных групп и подкоманд; затем выполнены
изолированные команды во временном git-проекте и его worktree. Репозиторного
`AGENTS.md` в выданном checkout нет. Исходные checkout и реальные пользовательские
конфиги не изменялись. Владение ограничено этим документом и временными файлами.

Все mutation probes использовали отдельные `CLAUDE_CONFIG_DIR=T/claude`,
`CODEX_HOME=T/codex`, `GIT_CONFIG_GLOBAL=T/gitconfig`, `XDG_CONFIG_HOME=T/xdg`,
`GIT_CONFIG_NOSYSTEM=1`, где `T` — новая папка в `/tmp`. `HOME` не менялся.
Claude создал `T/claude/.claude.json` и backups именно внутри этого конфига.
Автообновления и nonessential traffic Claude отключены. Из переданного дочерним
процессам окружения убраны credential-like переменные; их значения не печатались.
Локальные settings Claude записали git excludes в `T/xdg/git/ignore`.

Fixtures ниже получены из реального stdout/stderr; временные пути заменены на
`/tmp/P03`, время — на `<timestamp>`. `SYNTHETIC_SENTINEL`, `FIXTURE_TOKEN`,
localhost URL и все имена плагинов/серверов придуманы для пробы. Ни один реальный
секрет, пользовательский marketplace или сервер не использован. Никакие remote
marketplaces не добавлялись и не устанавливались. Тестовый плагин содержит только
один безвредный `SKILL.md`; hooks, MCP и команды установки отсутствуют.

Обозначения: **observed** — реально исполнено; **help** — только локальный CLI help;
**docs** — официальная документация; **unverified** — не запускалось.
По таблицам `argv` — массив аргументов для `execFile`, без shell-интерполяции.
`<s>` означает проверенный `user|project|local`, `<id>` — `fixture@p03-fixture`.
Все действия выполняются с явным `cwd`; он остаётся cwd выбранной сессии/проекта.

## Claude: операции v1

| Действие | Подтверждённый argv после executable `claude` | Evidence / результат | Ограничение и восстановление |
|---|---|---|---|
| Installed plugins | `["plugin","list","--json"]` | observed; F1, массив, пустой `[]` | JSON validate; `projectEnabled` не является общим effective enabled; при ошибке сохранить прежний безопасный снимок и повторить refresh |
| Available plugins | `["plugin","list","--available","--json"]` | observed; F2, объект installed/available | `--available` требует `--json`; локальный каталог подтверждён, remote discovery/network timing unverified; timeout/error не превращать в пустой успешный каталог |
| Installed details | `["plugin","details",<id>]` | observed; F3, текст inventory/token estimates | нет `--json`; не гарантировать стабильный табличный parser; неизвестные строки → unavailable estimates, без падения |
| Available details до установки | тот же argv | observed exit 1, F3a | **unavailable для available-only плагина**; показать подтверждённые поля каталога, inventory/cost — unknown |
| Details локального исходника | `["--plugin-dir",<localPath>,"plugin","details","fixture"]` | observed F3, source `fixture@inline` | только уже доступный локальный исходник; не выдавать за проверенный remote предпросмотр; каталог компонентов можно читать отдельно без исполнения |
| MCP обычный снимок | нет CLI health command | читать user/local `.claude.json`, project `.mcp.json` | `mcp list/get` запускают health-check, поэтому не выполнять на обычном refresh; ограничить файлы 32 МБ, валидировать и очистить DTO |
| MCP Check | `["mcp","list"]` | observed F4, текст | нет `--json`; starts/connects approved servers; pending/disabled отдельно от failed; неизвестное состояние → unknown; CLI exit 0 не означает все connected |
| MCP targeted details/check | `["mcp","get",<name>]` | observed F4a | текст содержит env/headers/URL; сырой stdout в UI не передавать; absent exit 1, повторить снимок |
| MCP add stdio | `["mcp","add","--scope",<s>,<name>,"--",<cmd>,...args]` | observed во всех трёх scopes, F5 | имя `[A-Za-z0-9_-]+`; дефолт CLI local, UI user нужно передавать явно; remove с тем же scope для отмены |
| MCP add stdio env | `["mcp","add","--scope",<s>,<name>,"-e","K=V","--",<cmd>,...args]` | help; env shape в F5 | этот конкретный env CLI branch не исполнен; значения не логировать; повторные env передавать валидированным argv |
| MCP add HTTP | `["mcp","add","--transport","http","--scope",<s>,<name>,"--header","X-Fixture: SYNTHETIC_SENTINEL","--",<url>]` | observed local, F5a | add печатает headers; очистка success stdout так же обязательна, как stderr; принимается только валидированная URL, без показа path/query |
| MCP add SSE | заменить transport на `sse` | help, mutation unverified | transport допустим по help; live SSE/auth не доказаны, Check может вернуть unknown/failed |
| MCP JSON | `["mcp","add-json","--scope",<s>,<name>,<serverJson>]` | observed local HTTP с headers, F5b | передать **один server object**, не `mcpServers` wrapper; JSON форму разобрать в host и проверить provider/transport; remove тем же scope |
| MCP remove | `["mcp","remove","--scope",<s>,<name>]` | observed все scopes, F5c | всегда явный scope; без него CLI может выбирать источник; plugin/builtin/managed серверы не удалять этим action; refresh после exit 0 |
| Plugin install | `["plugin","install",<id>,"--scope",<s>,"--json"]` | observed все scopes, F6 | дефолт user; точный id и scope; command-source/archive headersHelper могут требовать подтверждение команды, см. policy ниже |
| Plugin uninstall | `["plugin","uninstall",<id>,"--scope",<s>,"--json"]` | observed все scopes, F6 | по help есть `--keep-data`, без него удаляет persistent data; fixture без data; v1 UI должен явно описывать удаление; восстановление install, данные автоматически не восстанавливаются |
| Plugin enable | `["plugin","enable",<id>,"--scope",<s>,"--json"]` | observed все scopes, F6 | передавать scope, default auto-detect не использовать; disabled state подтверждён F1; inverse disable |
| Plugin disable | `["plugin","disable",<id>,"--scope",<s>,"--json"]` | observed все scopes, F6 | не использовать `--all`; inverse enable; higher-priority policy может запрещать action |
| Plugin update | `["plugin","update",<id>,"--scope",<s>,"--json"]` | observed up-to-date во всех scopes, F6 | changed-version/restart behaviour только help, unverified; updateOutcome не всегда up_to_date; refresh, session restart indication |
| Add marketplace | `["plugin","marketplace","add",<source>,"--scope",<s>,"--json"]` | observed локальный path во всех scopes, F7 | user default; URL/GitHub по help, remote branches unverified; явно валидировать source, не исполнять shell fragment |
| Удаление marketplace для отмены | `["plugin","marketplace","remove","p03-fixture","--json"]` | observed F7 | не копировать rollback удаления marketplace, если он был подключён до действия; не менять человеческие existing sources |
| Plugin Check | отдельного check нет | help | unavailable: refresh list/details проверяет metadata, не безопасность и не исполнение компонента |

### F1: установленный Claude plugin и scope semantics

```json
[
  {
    "id": "fixture@p03-fixture",
    "version": "1.0.0",
    "scope": "project",
    "enabled": true,
    "installPath": "/tmp/P03/claude/plugins/cache/p03-fixture/fixture/1.0.0",
    "installedAt": "<timestamp>",
    "lastUpdated": "<timestamp>",
    "projectPath": "/tmp/P03/project",
    "projectEnabled": true
  }
]
```

После disable project: `enabled:false, projectEnabled:false`. У user нет projectPath,
у local есть projectPath; для user и local при `enabled:true` поле `projectEnabled:false`.
Следовательно, фильтрация `projectEnabled === true` потеряет реально включённые
user/local плагины. Fixture не содержит plugin MCP: отсутствие `mcpServers` допустимо;
наличие/формат этого optional поля данным плагином не подтверждены.

### F2: Claude available

```json
{
  "installed": [],
  "available": [{
    "pluginId": "fixture@p03-fixture",
    "name": "fixture",
    "description": "Synthetic fixture only",
    "marketplaceName": "p03-fixture",
    "version": "1.0.0",
    "source": "./plugins/fixture"
  }]
}
```

Пустая изоляция: `{ "installed": [], "available": [] }`. Обе формы list и
available занимали около 0,1–0,2 с на этих маленьких локальных fixtures.
Это не сетевой benchmark и не утверждение, что CLI никогда не ходит в сеть.

### F3 / F3a: details

```text
fixture 1.0.0
  Description: Synthetic fixture only
  Source: fixture@p03-fixture

Component inventory
  Skills (1)  fixture
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~10 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  fixture         < 20       < 20
```

Это оценка CLI, не измерение реального usage. До установки тот же id, уже видимый в
available, дал exit 1 и текст `Plugin "fixture@p03-fixture" not found.` с подсказкой
list/`--plugin-dir`. `details ... --json` дал exit 1 / `unknown option '--json'`.

### F4 / F4a: MCP Check text

```text
Checking MCP server health…

fixture-user: node /tmp/P03/server.js - ✔ Connected
fixture-project: node /tmp/P03/server.js - ⏸ Pending approval (run `claude` to approve)
fixture-local: node /tmp/P03/server.js - ✔ Connected
```

Отдельная отрицательная fixture, тоже exit 0:

```text
fixture-failed: /usr/bin/false  - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
```

`disabledMcpjsonServers:["fixture-project"]` в изолированном project record исключил
server из list; **это не failed**. Поле `enabledMcpjsonServers` само по себе не дало
connected в проведённой пробе; полный trust/approval workflow не подтверждён.
Состояния authentication-required, managed-denied и disabled-text unverified.
Не угадывать их по одному exit code; исходный config должен сохранять disabled и
pending даже если list их не печатает. `mcp list --json` rejected (exit 1).

`mcp get fixture-local`:

```text
fixture-local:
  Scope: Local config (private to you in this project)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: /tmp/P03/server.js
  Environment:

To remove this server, run: claude mcp remove fixture-local -s local
```

HTTP get напечатал `Authorization: Bearer SYNTHETIC_SENTINEL` **без redaction**,
а failure Issue содержал сетевую ошибку. Raw text и success output одинаково секретны.
Missing get: exit 1, stderr `No MCP server named "missing". Run ...`.

### F5 / F5a / F5b / F5c: MCP mutation и storage

```text
Added stdio MCP server fixture-local with command: node /tmp/P03/server.js to local config
File modified: /tmp/P03/claude/.claude.json [project: /tmp/P03/project]
```

```json
{
  "mcpServers": {
    "fixture-user": {"type":"stdio","command":"node","args":["/tmp/P03/server.js"],"env":{}}
  },
  "projects": {
    "/tmp/P03/project": {
      "mcpServers": {
        "fixture-local": {"type":"stdio","command":"node","args":["/tmp/P03/server.js"],"env":{}}
      },
      "enabledMcpjsonServers": [],
      "disabledMcpjsonServers": []
    }
  }
}
```

F5a HTTP add: `Added HTTP MCP server fixture-http with URL: ... to local config`,
затем JSON headers (sentinel напечатан открыто) и File modified.
F5b add-json: `Added http MCP server fixture-json to local config`.
F5c remove: `Removed MCP server fixture-local from local config` + File modified.
User remove пишет user config, project remove — `project/.mcp.json`.
`bad name` отвергнуто exit 1; invalid scope отвергнут exit 1. Ошибка invalid scope
перечисляет также internal scopes (`dynamic`, `enterprise`, `agent` и др.);
это не разрешение добавить их в v1: публичный help поддерживает три human scopes.

### F6: plugin mutation JSON

```json
{"command":"install","outcome":"ok","plugin":"fixture@p03-fixture","pluginId":"fixture@p03-fixture","scope":"user","message":"Successfully installed plugin: fixture@p03-fixture (scope: user)"}
{"command":"disable","outcome":"ok","plugin":"fixture@p03-fixture","pluginId":"fixture@p03-fixture","scope":"user","message":"Successfully disabled plugin: fixture (scope: user)"}
{"command":"enable","outcome":"ok","plugin":"fixture@p03-fixture","pluginId":"fixture@p03-fixture","scope":"user","message":"Successfully enabled plugin: fixture (scope: user)"}
{"command":"update","outcome":"ok","plugin":"fixture@p03-fixture","pluginId":"fixture@p03-fixture","scope":"user","message":"fixture is already at the latest version (1.0.0).","updateOutcome":"up_to_date","oldVersion":"1.0.0","newVersion":"1.0.0"}
{"command":"uninstall","outcome":"ok","plugin":"fixture@p03-fixture","pluginId":"fixture@p03-fixture","scope":"user","keptData":false,"message":"Successfully uninstalled plugin: fixture (scope: user)"}
```

Та же schema наблюдалась для project и local. Ошибка install missing: exit 1,
stdout JSON `command:install,outcome:failed,plugin,scope,message,failureCode:not_found`;
stderr тоже содержит ошибку. Parser должен учитывать exit и outcome, очищать message.
По help noninteractive command-source install/update может показать `shownCommand`
и потребовать `--accept-command <sha256>` либо `-y`. Этот branch **unverified**:
v1 не должен автоматически добавлять `-y`, исполнять или угадывать команду.
Если интерфейс не может представить точную команду и связанный hash человеку,
этот installation path unavailable; восстановление — native plugin UI.
Managed scope update присутствует в help, но v1 mutations managed не разрешены.

### F7: marketplaces

```json
{"command":"marketplace-add","outcome":"ok","marketplace":"p03-fixture","message":"Successfully added marketplace: p03-fixture (declared in user settings)"}
{"command":"marketplace-remove","outcome":"ok","marketplace":"p03-fixture","message":"Successfully removed marketplace: p03-fixture"}
```

Project/local add отличаются `declared in project/local settings`; подтверждены.

## Claude local MCP из worktree: наблюдение, меняющее resolver

В temp git-репозитории создана исходная копия `T/project` и отдельная ветка/worktree
`T/worktree` обычным `git worktree add`. CLI cwd был каждым путём по очереди.

| Источник | Основная копия | Worktree | Подтверждение |
|---|---|---|---|
| user MCP | Connected | Connected | F4; общий isolated user config |
| local MCP добавлен из основной копии | Connected | Connected | list/get из worktree, exit 0 |
| local MCP добавлен из worktree | Connected | Connected | get из основной копии, exit 0 |
| незакоммиченный `.mcp.json` основной копии | Pending approval | отсутствует | файл не скопирован в worktree |

**Фактическое storage:** add local, выполненный из worktree, записал сервер в
`projects[realpath(mainCheckout)]`, а не `projects[realpath(worktree)]`.
В macOS `/tmp` нормализовался в `/private/tmp`. При этом success stdout `File modified`
печатал project path worktree; нельзя определять storage по этой строке.

Рекомендация P04/P15: resolver должен знать canonical main-checkout identity local
MCP и фактический session cwd; недостаточно читать только `projects[cwd]`.
Не менять cwd/projectPath запуска ради исправления. Резолвить git identity безопасно
(argv, bounded timeout, realpath), отдельно читать `.mcp.json` выбранного checkout.
Это observed для 2.1.287/macOS; nested dirs, older versions, Windows/Linux и standalone
non-git directories не проверены. Если identity не удалось установить, явно сообщать
unknown/partial и не выдавать отсутствие local MCP за факт.

## Codex: операции v1

| Действие | Подтверждённый argv после executable `codex` | Evidence / результат | Ограничение и восстановление |
|---|---|---|---|
| MCP snapshot | `["mcp","list","--json"]` | observed F8; массив | auth_status — не connection status; strict projection/redaction, не передавать transport raw |
| MCP details | `["mcp","get",<name>,"--json"]` | observed F8; объект | get содержит enabled_tools/disabled_tools, но нет auth_status; absent exit 1; не объявлять connected |
| MCP Check health | отсутствует | `mcp check fixture` observed exit 2 | **unavailable**; list/get — refresh metadata, native session `/mcp` для connection/auth; самодельный launcher не часть v1 |
| MCP add stdio | `["mcp","add",<name>,"--env","K=V","--",<cmd>,...args]` | observed F9 с synthetic env | user/global config, no scope flag; repeated --env по help; remove имя для отмены |
| MCP add HTTP | `["mcp","add",<name>,"--url",<url>,"--bearer-token-env-var","FIXTURE_TOKEN"]` | observed F9 | именно имя env-var, не bearer value; env только stdio; HTTP/OAuth сеть и login unverified |
| MCP JSON из UI | разобрать в host → stdio/HTTP argv выше | нет `add-json` в help | headers/env_http_headers не поддержаны add help; нельзя молча терять JSON поля: unavailable либо native config flow |
| MCP SSE | отсутствует | только streamable HTTP в help | unavailable: не превращать SSE URL в HTTP без проверки |
| MCP remove | `["mcp","remove",<name>]` | observed F9 | только user/global; project/local remove unavailable, не писать config.toml вместо native CLI |
| Installed plugins | `["plugin","list","--json"]` | observed F10 | объект installed/available, не массив; без --available uninstalled не включены |
| Available plugins | `["plugin","list","--available","--json"]` | observed local F10 | exact marketplace filter `["--marketplace","p03-fixture"]` подтверждён; remote account discovery/network unverified |
| Plugin details | отсутствует | observed `plugin details` exit 2 | unavailable; только подтверждённые поля списка, optional local inventory отдельным reader, token estimate unknown |
| Plugin install | `["plugin","add",<id>,"--json"]` | observed F11 | **add**, не install; нет --scope; пишет user config и cache; remove для отмены |
| Plugin uninstall | `["plugin","remove",<id>,"--json"]` | observed F11 | **remove**, не uninstall; no scope; refresh, reinstall возвращает файлы, не обещает persistent data |
| Plugin enable/disable | отсутствует | observed одноимённые subcommands exit 2 | **unavailable в CLI mutation v1**; --enable/--disable — FEATURES, не plugins; native UI/config flow |
| Plugin update | отсутствует | observed `plugin update` exit 2 | unavailable; marketplace upgrade не является обещанием обновить установленный plugin; native UI/manual documented flow |
| Add marketplace | `["plugin","marketplace","add",<source>,"--json"]` | observed local F12 | user config, no scope; Git/owner-repo/ref по help, remote unverified; remove только вновь добавленный source для отмены |
| Marketplace refresh | `["plugin","marketplace","upgrade","p03-fixture","--json"]` | local source observed exit 1; F12 | предназначен Git snapshots, positive Git branch unverified; не скрывать failure и не переименовывать в plugin update |
| Marketplace remove | `["plugin","marketplace","remove","p03-fixture","--json"]` | observed F12 | refresh; existing human marketplace не удалять как компенсацию неудачного plugin install |
| Plugin Check | отсутствует | observed `plugin check` exit 2 | unavailable, metadata refresh не проверяет безопасность/работоспособность |

### F8: Codex MCP JSON и отсутствие health-check

```json
[
  {
    "name":"fixture-http",
    "enabled":true,
    "disabled_reason":null,
    "transport":{
      "type":"streamable_http",
      "url":"http://127.0.0.1:1/mcp",
      "bearer_token_env_var":"FIXTURE_TOKEN",
      "http_headers":null,
      "env_http_headers":null,
      "http_headers_helper":null
    },
    "startup_timeout_sec":null,
    "tool_timeout_sec":null,
    "auth_status":"bearer_token"
  },
  {
    "name":"fixture-stdio",
    "enabled":true,
    "disabled_reason":null,
    "transport":{
      "type":"stdio",
      "command":"node",
      "args":["/tmp/P03/server.js"],
      "env":{"SYNTHETIC_KEY":"SYNTHETIC_SENTINEL"},
      "env_vars":[],
      "cwd":null
    },
    "startup_timeout_sec":null,
    "tool_timeout_sec":null,
    "auth_status":"unsupported"
  }
]
```

Get JSON совпадает с записью, но вместо auth_status имеет `enabled_tools:null` и
`disabled_tools:null`. Env sentinel выходит открыто. Null/unknown fields и unknown
auth enums не должны ломать snapshot. List выдавал bearer_token для заведомо
недоступного localhost URL за ~0,04 с. Сервер `touch /tmp/P03/codex-mcp-launched`
при list не был запущен (marker отсутствовал). Это доказательство config listing,
не проверки подключения. Missing get: exit 1 / `No MCP server named 'missing' found.`.

### F9: Codex MCP mutations и scopes

```text
Added global MCP server 'fixture-stdio'.
Removed global MCP server 'fixture-stdio'.
```

Add HTTP имеет тот же текст. `--scope project` rejected exit 2. Invalid name
`bad name` rejected exit 1; разрешённый набор по ошибке CLI:
letters/numbers плюс `- _ : @ / .`. Для v1 безопасно выбрать общий более узкий
набор `[A-Za-z0-9_-]+`, но это продуктовая валидация, не полная грамматика Codex.
User MCP список одинаков в основной копии и worktree с тем же config home.
Project config **читается** нативным Codex при trust по docs, но `mcp add/remove`
не предоставляют project/local write scope; обе части не следует смешивать.

### F10: Codex installed/available

```json
{
  "installed": [],
  "available": [{
    "pluginId":"fixture@p03-fixture",
    "name":"fixture",
    "marketplaceName":"p03-fixture",
    "version":"1.0.0",
    "installed":false,
    "enabled":false,
    "source":{"source":"local","path":"/tmp/P03/market/plugins/fixture"},
    "marketplaceSource":{"sourceType":"local","source":"/tmp/P03/market"},
    "installPolicy":"AVAILABLE",
    "authPolicy":"ON_INSTALL"
  }]
}
```

После add та же запись в `installed` с `installed:true,enabled:true`; без --available
`available:[]`. Установленный fixture появился в `T/codex/plugins/cache` и
`T/codex/config.toml` (`[plugins."fixture@p03-fixture"] enabled=true`). Не найден
scope field; **remote workspace install scope не выводить из user config**.
Remote `source`, scopes/policies/availability/disabled_reason variants unverified.
Малый локальный список занимал ~0,04 с; это не remote performance обещание.

Отрицательная проверка гипотезы toggle:
`["-c","plugins.\"fixture@p03-fixture\".enabled=false","plugin","list","--json"]`
всё равно вернул `enabled:true`. Нельзя использовать этот listing override как
проверенный action или доказательство effective state в сессии.

### F11: Codex plugin mutations

```json
{"pluginId":"fixture@p03-fixture","name":"fixture","marketplaceName":"p03-fixture","version":"1.0.0","installedPath":"/tmp/P03/codex/plugins/cache/p03-fixture/fixture/1.0.0","authPolicy":"ON_INSTALL"}
{"pluginId":"fixture@p03-fixture","name":"fixture","marketplaceName":"p03-fixture"}
```

Первая строка add, вторая remove. Нет Claude-style `outcome/command` envelope.
Missing add: exit 1, stdout пустой, stderr `plugin ... was not found in marketplace ...`.
`--scope project` rejected exit 2. Каждый из details/enable/disable/update/check
дал exit 2 и `unrecognized subcommand`. Help и реальные parser errors согласуются.

### F12: Codex marketplace

```json
{"marketplaceName":"p03-fixture","installedRoot":"/tmp/P03/market","alreadyAdded":false}
{"marketplaces":[{"name":"p03-fixture","root":"/tmp/P03/market","marketplaceSource":{"sourceType":"local","source":"/tmp/P03/market"}}]}
{"marketplaceName":"p03-fixture","installedRoot":null}
```

Это add, list, remove соответственно. Upgrade local: exit 1,
`marketplace ... is not configured as a Git marketplace`. По help возможны Git URL,
`owner/repo[@ref]` и `--ref`; сетевые branches не проверены.

## Fixtures: воспроизведение и ограничения policy

Тестовый marketplace был локальным каталогом; обе CLI приняли legacy-compatible
`.claude-plugin/marketplace.json`. Минимальная структура:

```json
{"name":"p03-fixture","owner":{"name":"Fixture"},"plugins":[{"name":"fixture","source":"./plugins/fixture","description":"Synthetic fixture only","version":"1.0.0"}]}
```

Plugin `plugins/fixture/.claude-plugin/plugin.json`:
`{"name":"fixture","version":"1.0.0","description":"Synthetic fixture only"}`.
Skill frontmatter: `name: fixture`, `description: Synthetic fixture only`;
body `Return fixture.`. MCP Connected fixture — локальный Node JSON-lines process:
ответ initialize содержит request protocolVersion, `capabilities:{tools:{}}`,
`serverInfo:{name:"fixture",version:"1.0"}`; tools/list → `tools:[]`;
notification не получает ответа. Это настоящий MCP handshake, без LLM запуска.

Пробы использовали `subprocess.run(argv, cwd=..., env=isolatedEnv,
capture_output=True, timeout=20)`. JSON list/details validation выполняется в host;
для Claude text check parser должен видеть только ограниченный whitelist статусов,
сохранять unknown, удалять launch command/URL/Issue/env. Не логировать raw stderr,
success stdout, full argv, JSON config или вставленные значения. URL/headers,
строки commands/args и plugin metadata — недоверенные данные, не инструкции.

Это не evidence отсутствия всех OS-level managed настроек: env isolation не отменяет
корпоративную policy, системные requirements или keychain. Managed-denied,
remote auth и custom CLI overrides требуют дополнительных bounded fixtures;
они не считаются успешно проверенными здесь. Unsupported path отображается
unavailable/unknown с родным CLI/UI recovery, а не исполняется guessed command.
Actions serialise per provider/project; после действия refresh, текущую сессию
помечать needs restart там, где применение live не доказано. Не компенсировать
failure прямой записью человеческих config-файлов или удалением чужих sources.

## Первичные источники и решения для P04

Официальные страницы открыты 2026-10-03, после локальных help/probes. Документы
могут описывать другую версию; конкретные argv выше привязаны к установленным CLI.

- [Claude settings](https://code.claude.com/docs/en/settings): `CLAUDE_CONFIG_DIR`
  переносит home-directory данные; settings scopes отличаются от MCP scopes;
  local settings в worktree используют main checkout (docs, не замена MCP probe).
- [Claude MCP](https://code.claude.com/docs/en/mcp): user/project/local storage,
  project approvals, precedence, транспорт и подключение (docs).
- [Claude plugin management](https://code.claude.com/docs/en/discover-plugins):
  scope enabledPlugins в user/project/local settings, installed details и локальный
  `--plugin-dir`, native management/recovery (docs).
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): stdio/HTTP,
  CLI add и native `/mcp` для connection/auth (docs).
- [Codex config precedence](https://learn.chatgpt.com/docs/config-file/config-basic):
  trusted project config читается отдельно от user config; enforced requirements
  ограничивают overrides (docs; project mutation CLI этим не доказан).
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins):
  repo/personal local marketplaces, legacy-compatible каталог, documented local
  plugin `enabled` config; workspace-managed plugins имеют отдельную policy (docs).

P04 должен согласовать пять отклонений от первоначальной Capabilities спеки:

1. Codex plugin list поддерживает JSON installed/available; install/uninstall argv
   — **add/remove**. Enable/disable/update/details через CLI в v1 недоступны.
2. Codex MCP Check не выдаёт живой connection status; auth_status metadata нельзя
   переименовать в Connected. Для такого check — unavailable/native `/mcp`.
3. Claude details до установки remote plugin не доказан и available-only local
   fixture rejected. Inventory/cost unknown; подтверждён локальный --plugin-dir.
4. Claude local MCP worktree sharing требует canonical main-checkout identity;
   stdout path недостаточен. cwd/projectPath запуска сохраняются.
5. Redaction применяется к **всем** CLI outputs, включая успешные mutation outputs;
   raw plugin MCP schema и remote policies остаются отдельными непроверенными ветвями.

Проведены CLI help checks, JSON/text fixture checks, позитивные изолированные
mutation probes, отрицательные unsupported/validation probes, worktree storage
и no-launch marker checks. Сессии Parley/LLM launch, remote install, OAuth login,
политика managed denial, Windows/Linux и применение изменений в уже запущенных
сессиях **не проверялись**. Stage/commit, shared code и статус очереди не менялись.

## P17 Claude action proof — 2026-10-03

Ownership конфигурации, полнота policy и health MCP проверяются отдельно. Native 2.1.287 Add guard проверяет policy до scope write; get_settings не universal policy proof. Source locators и ограничения закреплены в [P17 amendment](contracts.md#p17-action-proof-amendment--2026-10-03).

Artifact source: [официальный installer](https://claude.ai/install.sh) указывает [manifest 2.1.287](https://downloads.claude.ai/claude-code-releases/2.1.287/manifest.json). Root прочитал оба public artifacts без выполнения installer; darwin-arm64 checksum `6eab8333fe2121553100d8f40bfada384a3e989b94f947e18ba6677a6fcb41ea`, size 227827120 совпали с independently inspected installed native bytes. Manifest commit `3c446a1b98aceb99a6cdee0f84a8bea42f4a8937`, build 2026-10-01. Local codesign --verify сообщил invalid signature; совпадение publisher HTTPS manifest доказывает byte identity опубликованного artifact, а не исправность platform signature. Other platform runtime gates не закрыты одним manifest.

Default positive action proof привязывается к принятому version/platform/digest, actual canonical path и fresh bounded hash; machine absolute path не записывается в repo. Другой/custom binary или изменившийся fingerprint — unavailable. Synthetic adapter evidence не объявляет реальную policy/health доказанной; raw config/output не сохраняется.

Independent artifact recheck /root/p01_review подтвердил HTTPS installer/manifest bytes и повторный stable-stat hash installed binary. Default allowlist согласован только для source-audited darwin-arm64 artifact2.1.287 выше; другие platform checksums имеют publisher provenance, guard equivalence остаётся inference и не разрешает action автоматически. Ни installer, ни binary install/update не выполнялись.
