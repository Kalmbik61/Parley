# Скиллы, MCP и плагины агентов в окне Parley — дизайн

> Интеграционная сверка: 2026-10-03. [Единый план
> реализации](../plans/2026-10-03-parley-unified-implementation-plan.md), этапы 1, 5. Источники
> скиллов общие с навигатором; панель показывает и недоступные модели записи с причиной, поиск
> возвращает только доступные. Порядок и общие контракты — в плане; P00–P04 приняты по [контракту разведки](../research/2026-10-03-parley-cli/contracts.md).
> [Журнал выполнения](../plans/2026-10-03-parley-execution.md) отделяет evidence от остающихся live gates; реализация не завершена.

Дата: 2026-10-02. Статус: направление и четыре раздела дизайна приняты человеком в разговоре
2026-10-02 (вариант B, объём «просмотр + установка», панель проекта, скиллы «показ + дать второму
агенту»). Единый план составлен; P01–P04 приняты, неподдержанные действия unavailable, remote/policy/live gates остаются P32.
Основание:
- разбор Hermes Agent и OpenClaw (раздел 1.2);
- живые CLI на машине разработки: Claude Code 2.1.287, Codex 0.156.1 (раздел 4);
- как Parley запускает агентов: `--mcp-config` без `--strict-mcp-config`
  (`packages/core/src/providers.ts:159`), `-c mcp_servers.parley=…` у Codex
  (`packages/core/src/work/mcp-config.ts`), скилл `parley` в `.agents/skills` с симлинком
  `.claude/skills` (`packages/core/src/work/skill-install.ts`).

---

## 1. Зачем и что решено

### 1.1 Вопрос человека

Харнес растёт. У Hermes, OpenClaw и похожих систем есть раздел скиллов и MCP, где можно
подключать своё. Нужен ли такой Parley и откуда брать скиллы?

### 1.2 Чем Parley отличается от Hermes и OpenClaw

Hermes и OpenClaw держат свой цикл агента, поэтому скиллы и MCP — их собственная среда
выполнения, и экосистему им приходится строить с нуля: Hermes Skills Hub на стандарте
agentskills.io, ClawHub у OpenClaw.

У Parley агент — нативный `claude` или `codex`, а у них скиллы, MCP, плагины и маркетплейсы уже
есть. Поддержка в Parley тоже уже есть, только её не видно:
- Claude запускается с `--mcp-config` без `--strict-mcp-config`, поэтому MCP человека из
  `~/.claude.json` и `.mcp.json` в сессиях Parley работают. `/plugin` и `/mcp` в терминале
  сессии работают тоже;
- Parley уже умеет класть один скилл обоим агентам (`skill-install.ts`).

Значит, вопрос не в том, добавить ли скиллы, а в том, нужно ли окно, через которое ими
управлять.

### 1.3 Ответ

**Делаем раздел-окно в нативные настройки** (вариант B). Parley показывает, что видит каждый
агент в проекте, и ставит или удаляет нативными командами. Своего формата, своего каталога и
своей среды выполнения скиллов нет.

**Своего каталога не делаем** (отвергнутый вариант C). Пример цены: в феврале 2026 Koi Security
нашли 341 вредоносный скилл среди 2 857 на ClawHub. 335 из них ставили Atomic Stealer на macOS
через «обязательную установку зависимостей». Свой каталог — это модерация и ответственность, и
он дублирует маркетплейсы Anthropic и OpenAI.

**Откуда брать.** Ниоткуда своего:
- маркетплейсы плагинов, уже подключённые у агента (`claude plugin list --available --json`,
  `codex plugin list`);
- маркетплейс, который человек подключил сам (`owner/repo`);
- блок `mcpServers` из README сервера: форма добавления MCP разбирает его сама.

Поиск по официальному реестру MCP (`registry.modelcontextprotocol.io`, REST `/v0/servers`)
отложен.

### 1.4 Политика Anthropic

Parley не трогает вход и учётные данные агента. Всё, что меняет конфиг, делают нативные CLI.
Сам Parley **никогда не пишет** в `~/.claude.json` и `~/.codex/config.toml`, а только читает
из них нужные поля (раздел 4.1).

---

## 2. Объём первой версии

**Входит:**
- панель проекта: скиллы, MCP и плагины Claude и Codex, с уровнем, источником и состоянием;
- MCP: добавить (форма и вставка JSON из README) и удалить;
- плагины: каталог подключённых маркетплейсов, состав перед установкой, установить, удалить,
  включить, выключить, подключить маркетплейс;
- скилл-папка: дать второму агенту и забрать обратно.

**Не входит:**
- наборы MCP и скиллов на комнату или сессию. Это следующий шаг, его естественное место —
  эта же панель и тот же `--mcp-config`;
- поиск по реестру MCP;
- установка скилла из git по адресу;
- различия скиллов внутри worktree сессий (незакоммиченные скиллы в worktree);
- провайдеры реестра, кроме Claude и Codex: в панели их нет;
- автоматический перезапуск сессий после изменений.

---

## 3. Архитектура

```
окно (renderer)                     хост (harnas-host)                      машина хоста
CapabilitiesDialog  ── protocol ──▶  capabilities/                ──execFile──▶ claude / codex
  группы Skills/MCP/Plugins          ├─ service.ts  снимок, очередь          ├─ ~/.claude.json (чтение)
  форма MCP, каталог                 ├─ claude.ts   адаптер                  ├─ .mcp.json (чтение)
                                     ├─ codex.ts    адаптер                  └─ папки скиллов
                                     ├─ redact.ts   описание без секретов
                                     └─ skills.ts   папки и симлинки
```

- **Хост, модуль `packages/host/src/capabilities/`.** Для каждого провайдера свой адаптер с общим
  интерфейсом: `snapshot(projectPath)`, `catalog()`, `addMcp`, `removeMcp`, `installPlugin`,
  `uninstallPlugin`, `setPluginEnabled`, `addMarketplace`. CLI запускается тем же бинарём, что и у
  сессий (`commandBinary`, подмена `PARLEY_*_BIN`), с таймаутом и `SIGKILL`, как в
  `host/src/providers/versions.ts`.
- **Почему хост, а не окно.** Конфиги лежат на машине хоста. По спеке удалённого доступа
  (`2026-10-01-remote-access-design.md`) окно может оказаться на другой машине.
- **Протокол** (`packages/protocol/src/methods.ts`):
  - `capabilities.get { projectPath }` — последний снимок, сразу;
  - `capabilities.refresh { projectPath, check?: boolean }` — пересобрать; `check` включает
    полную проверку MCP у Claude (раздел 4.4);
  - `capabilities.catalog { provider }`;
  - `capabilities.mcp.add`, `capabilities.mcp.remove`;
  - `capabilities.plugin.install`, `.uninstall`, `.setEnabled`, `.addMarketplace`;
  - `capabilities.skill.share`, `capabilities.skill.unshare`;
  - событие `capabilities.changed { projectPath, snapshot }`.
- **Окно.** Единая панель проекта `ProjectPanel` с вкладкой Capabilities; позднее
  туда добавляются Backlog, Decisions и Memory. Открывается из меню заголовка проекта
  (`sidebar/SectionMenu.tsx`) и действием палитры «Capabilities…». Формы действий
  используют диалоги по образцу `SettingsDialog`. Тексты окна на английском.

---

## 4. Данные

### 4.1 Строка снимка

```ts
type CapabilityKind = 'skill' | 'mcp' | 'plugin';
type Scope = 'user' | 'project' | 'local' | 'plugin' | 'builtin'
  | 'system' | 'admin' | 'extra' | 'claude.ai';
type Status = 'ok' | 'off' | 'needs-auth' | 'pending-approval' | 'failed' | 'unknown';

interface Presence {
  id: string;             // provider + canonical native identity; не только name
  scope: Scope | null;    // null: native scope не подтверждён
  source: string | null;   // id плагина, маркетплейс, путь скилла от проекта или от ~
  enabled: boolean | null; // null: effective policy не подтверждена
  status: Status;
  summary: string | null;  // только из разрешённого списка (раздел 5)
  modelAvailable: boolean | null; // скилл: доступность модели, у MCP/плагина null
  unavailableReason: string | null; // скрытие или неизвестная доступность; не секрет
  sharedFrom?: 'claude' | 'codex'; // скилл: этот агент видит симлинк на папку другого
}

interface CapabilityRow {
  id: string;             // kind/name; plugins дополнительно provider-qualified
  kind: CapabilityKind;
  name: string;
  description: string | null;
  claude: Presence[];
  codex: Presence[];
}
```

- Одноимённые скилл или MCP у обоих агентов — одна строка с двумя колонками. Presence arrays сохраняют все canonical native identities: Codex same-name файлы не схлопываются и не получают выдуманный winner. Пустой массив означает отсутствие в готовой колонке; loading/error хранятся отдельно от rows. Unknown enabled policy — null/status unknown, не guessed true. Отсутствующий native scope (например, Codex plugin list) — null, не guessed user. Native system/admin/extra/claude.ai scope сохраняется без приведения к user. Если у скиллов две
  независимые canonical файлы/папки (не подтверждённый симлинк), в строке пометка «separate copies», и «дать второму» недоступно.
- Плагины не сливаются: у агентов разные форматы. Строка плагина держит только одного агента и
  раскрывается в его скиллы и MCP.
- **Встроенное.** MCP `parley` в конфигах нет: его подставляет запуск. Хост добавляет его строкой
  `builtin` сам. Скилл `parley` виден в папках, хост помечает его `builtin` по учёту
  `skills-receipt.json`. Встроенное нельзя удалить и нельзя «дать второму».

### 4.2 Источники: Claude

| Что | Откуда | Заметки |
|---|---|---|
| Плагины | `claude plugin list --json` | array; scope/enabled/projectEnabled; projectEnabled не общий effective enabled, mcpServers optional/schema ещё не подтверждена |
| Каталог | `claude plugin list --available --json` | object installed/available, observed local ~0,1–0,2 с; remote discovery/network не проверены |
| Состав плагина | `claude plugin details <id>` | installed-only text, нет --json; available-only inventory/cost unknown; local --plugin-dir отдельный inspected path |
| MCP user/local | isolated/native config `.claude.json`: user mcpServers, local projects[realpath(mainCheckout)].mcpServers | read-only ≤32 МБ; worktree sharing observed; unresolved identity partial/unknown |
| MCP project | `<session cwd checkout>/.mcp.json` | approval/disabled поля native project record; full trust workflow не подтверждён, unknown не enabled |
| Скиллы | shared resolver: user/project/commands/plugins, synced account/manifest/config | canonical document identity, full multiline YAML description, весь SKILL.md ≤65 536 байт; unknown availability false; навигатор §3.2 |

Ordinary MCP snapshot читается из файлов, не через `claude mcp list/get`: команды запускают/подключают approved серверы; unapproved pending, disabled может отсутствовать. Local MCP из основной копии виден в worktree: native storage canonical mainCheckout, даже если stdout пишет cwd worktree. Identity из bounded native/Git queries+realpath, не строки stdout или догадки dirname(.git); cwd/shared projectPath не меняются.
`~/.claude.json` — внутренний файл Claude Code. Разбор терпимый: если поле не нашлось или формат
другой, строки MCP Claude получают `unknown`, а `check` по-прежнему работает.

### 4.3 Источники: Codex

| Что | Откуда | Заметки |
|---|---|---|
| MCP | `codex mcp list --json` / `mcp get <name> --json` | array/object; config/auth metadata, **не health-check**, secrets raw; auth_status не Connected |
| Плагины, каталог | `codex plugin list --json` / `--available --json` | object installed/available; explicit installed/enabled/source/policy fields; remote variants unverified |
| Скиллы | shared resolver: native config-folder/deprecated/user/project/system/admin/plugin/extra roots | canonical full-file identity; same-name файлы сохраняются; User/SessionFlags rules (не project) и policy; unknown roots unavailable до parity |

### 4.4 Состояние MCP

- По умолчанию берётся то, что известно без запуска серверов: включён ли сервер, одобрен ли
  (`pending-approval`), auth metadata Codex. Неизвестный auth_status — unknown, bearer_token/unsupported не доказывают Connected.
- Explicit «Check» у Claude — `claude mcp list`/targeted `mcp get <name>` text: whitelist connected/pending/disabled/failed/unknown, exit 0 не означает здоровье всех серверов. Disabled/отсутствующий output сверяется с snapshot, не failed. Raw launch command/env/headers/Issue в UI не идёт. Unknown text → прежний safe snapshot и diagnostic.
- Codex connection Check **unavailable**: list/get не запускают MCP (marker probe), auth_status не health. Native `/mcp` — recovery для connection/auth; не выдумывать mcp check или собственный запуск сервера.

### 4.5 Снимок

- Хост держит последний снимок каждого проекта в памяти. На диск ничего не пишется.
- Части Claude и Codex собираются независимо. Окно показывает часть Claude, как только она
  готова, а колонка Codex до своей части показывает загрузку.
- Снимок пересобирается после каждого действия из панели и по кнопке «Refresh». Изменения,
  сделанные в терминале, видны после «Refresh» или повторного открытия панели. Слежения за
  файлами нет.


### 4.6 Общие источники с навигатором

Панель и `find_skill` используют один модуль `packages/core/src/skills/`. Существующие
подсказки chat-view из `capabilities/scan.ts` подключаются к нему, сохраняя свой
контракт `capabilities.list`; новый снимок панели не заменяет этот метод молча.
Шапки скиллов, ролей и рецептов разбираются общим YAML-разборщиком, настройки
Codex — общим TOML-разборщиком. Отдельные сканеры и парсеры для каждой функции
не создаются.

Панель показывает установленное и скрытое с причиной недоступности модели;
навигатор возвращает только то, что агент может загрузить. Временные выключающие
записи, добавленные запуском Parley, не становятся человеческими выключениями.
Вкладка проекта использует основную копию; поиск `for` — cwd и настройки участника.
Refresh панели обновляет её снимок, индекс уже идущего MCP не меняется.

Действие «дать второму» по явному выбору человека меняет нативные папки через
симлинк; `find_skill(for)` только читает каталог второго CLI и ничего не устанавливает.
Выключение навигатора не выключает панель, а `agentSkills: false` не скрывает
пользовательские скиллы и не выключает `find_skill`.
---

## 5. Секреты

На машине разработки `codex mcp list --json` отдал ключи API открытым текстом: один в аргументах
сервера, другой в заголовках. Окно, а с удалённым доступом и сеть, не должны видеть таких
значений никогда.

**Правило: разрешённый список, а не маскировка.** Сырой конфиг сервера не попадает ни в один тип
протокола. Хост собирает `summary` только из частей, которые точно не секрет:

- **stdio:** команда и число аргументов: `node · 4 args`. Если команда — запускатель пакетов
  (`npx`, `bunx`, `uvx`, `pipx`, `pnpm dlx`), добавляется первый аргумент без дефиса — имя
  пакета: `npx figma-developer-mcp · +2 args`;
- **http/sse:** схема и хост, без пути и query: `https · mcp.context7.com`. Путь не показывается,
  потому что некоторые сервисы держат токен прямо в пути;
- **`env`, заголовки:** только имена, без значений: `env: FIGMA_API_KEY`. Имена переменных из
  `env_vars`, `bearer_token_env_var`, `env_http_headers` Codex — тоже только имена.

**Вывод CLI.** Любой stdout/stderr, **включая успешные mutations**, перед показом проходит вырезание; headers/env могут быть открыты даже в success output. Raw text/argv/config и parser exceptions с source excerpts в logs/protocol не идут. Safe code/position и whitelist DTO вместо raw вывода. stderr действия перед показом проходит вырезание. Убирается всё, что хост видел в
сыром конфиге, кроме самой команды: аргументы, значения `env` и заголовков, пути и query URL. И
всё, что человек ввёл в форму: аргументы, значения `env` и заголовков, URL. Сырой вывод «Check»
не показывается вовсе (раздел 4.4).

---

## 6. Действия

Всё через `execFile` с массивом аргументов, без оболочки. Действия по одному провайдеру идут
строго по очереди: две записи не попадают в один конфиг одновременно. Чтение — таймаут 15 с,
установка плагина — 120 с (клонируется git).

### 6.1 MCP: добавить

- Поля: имя; вид (stdio: команда и аргументы; http: URL); `env`; заголовки. Галочки «Claude» и
  «Codex».
- Вставка JSON из README разбирает стандартный блок `{"mcpServers": {...}}` (или один сервер без
  обёртки) и заполняет форму. Окно разбирает ввод, host повторно валидирует schema/поля/transport/provider и whitelist-supported argv; unsupported поля не теряются молча.
- Уровень Claude: UI user по умолчанию, project (`.mcp.json` session checkout), local. CLI default local, поэтому scope всегда явный. Local mainCheckout виден из worktree в 2.1.287; unresolved/atypical identity partial, не утверждение невидимости.
- У Codex только пользовательский уровень, так пишет `codex mcp add`.
- Команды: `claude mcp add [--transport http] --scope <s> <name> [-e K=V …] [--header …] -- <cmd> <args…>`
  или `<url>`; `codex mcp add <name> [--env K=V …] -- <cmd> <args…>` или `--url <url>`. Точный
  набор флагов — [матрица P04 §7](../research/2026-10-03-parley-cli/contracts.md#7-provider-actions-и-безопасные-scopes). Claude JSON: mcp add-json --scope <s> <name> <oneServerObject>; Codex add-json/SSE нет, strict convert только supported stdio/HTTP fields, unsupported headers/fields unavailable, не теряются. Codex HTTP bearer-token-env-var принимает имя переменной, не value; project/local mutations unavailable.

### 6.2 MCP: удалить

С подтверждением: `claude mcp remove --scope <s> <name>`, `codex mcp remove <name>` user/global. Scope всегда явный у Claude, project/local mutation unavailable у Codex; plugin/system/managed MCP отдельно не удаляется. Общая product validation имени `[A-Za-z0-9_-]+` намеренно уже Codex grammar. В строке plugin MCP ссылка на плагин.

### 6.3 Плагины

- Каталог подключённых маркетплейсов с поиском по имени и описанию.
- Claude details доступен installed id: pre-install available-only inventory/cost **unknown**; local `--plugin-dir` — отдельный подтверждённый inspected path. Codex details нет: только list fields, стоимость unknown.
- Claude install/uninstall/enable/disable/update: `plugin <action> <id> --scope user|project|local --json`. Exact scope/id, exit+outcome validation. Uninstall может удалить persistent data; явно описать это, reinstall не обещает восстановление.
- Codex install/uninstall — `plugin add/remove <id> --json`, без scope. CLI enable/disable/update/check/details **unavailable**; --enable/--disable — feature flags, не plugins; listing -c toggle не доказал action. Recovery native UI/config, не guessed CLI и не прямой config writer.
- Command-source/headersHelper install/update branch только help: без auto -y; если точная shownCommand/hash approval не поддержана интерфейсом, path unavailable/native UI.
- «Add marketplace»: Claude `plugin marketplace add <source> --scope <s> --json`, Codex `plugin marketplace add <source> --json`; local path observed, remote/OAuth/policy unverified. Rollback remove только вновь добавленный source, не existing человеческие marketplaces. Codex marketplace upgrade — Git snapshot, не plugin update. После действия refresh/needs-restart при непроверенном live применении; timeout/error сохраняет предыдущий safe snapshot. Сторонние sources никто не проверяет.

### 6.4 Скилл: дать второму агенту

- Оригинал остаётся на месте. У второго агента появляется симлинк на него.
- **user-уровень:** `~/.claude/skills/<x>` ↔ пользовательская папка Codex, абсолютный симлинк.
  Это осознанное исключение из правила `skill-install.ts` «в `~/.claude`, `~/.codex`, `~/.agents`
  ничего не пишется»: здесь пишет только нажатие человека.
- **проект:** относительный симлинк `.agents/skills/<x>` → `../../.claude/skills/<x>` или
  обратный. В `info/exclude` не прячется, как свой `parley`: это содержимое человека. Панель
  говорит: «New file in git status — commit it so worktree sessions see the skill».
- **Забрать обратно** удаляет только симлинк, который ведёт на оригинал. Папку и чужой симлинк
  не трогает.
- Нельзя: место занято (папка или чужой симлинк), скилл встроенный или из плагина. Симлинк не
  создался — ошибка, без копии: копия разойдётся с оригиналом.

### 6.5 Запущенные сессии

Ничего не перезапускается само. После любого действия панель пишет: «Applies to new sessions.
N sessions running in this project — restart them to pick this up». N хост берёт из своего списка
сессий проекта.

---

## 7. Ошибки

- **CLI нет в PATH:** колонка агента — «not installed», действия для него недоступны.
- **Ненулевой код выхода:** safe error code и числовой exit code/размеры; raw stderr/stdout и любые excerpts не попадают в host log или DTO, включая успешный stdout. Только whitelist-поля подтверждённой схемы могут перейти в безопасный результат.
- **Таймаут:** «timed out after N s», процесс убит, снимок не меняется.
- **Не разобрался ответ CLI** (сменился формат): строки агента — `unknown`; в журнале/DTO только safe diagnostic code и числовые counts, без excerpts. Неизвестный формат не позволяет доказать очистку неизвестных секретов; raw success/error output не журналируется.
- **Не разобрался `~/.claude.json`:** MCP Claude уровней user/local — `unknown`, остальное
  работает.
- **Действие, пока идёт другое у того же агента:** ждёт в очереди, кнопка показывает ожидание.

---

## 8. Тесты

Настоящие `claude` и `codex` тесты не запускают. Вместо них заглушки через `PARLEY_*_BIN`:
заглушка печатает заготовленный ответ и записывает свои аргументы.

- **Секреты (главный тест).** Конфиг с секретами в аргументах, заголовках, `env`, пути и query
  URL. Проверка: ни одного значения нет в сериализованном ответе `capabilities.get` и событии.
  Отдельно — вырезание из stderr; разбор «Check» по заготовке вывода `claude mcp list` с
  секретом в аргументах — в ответе только состояния.
- **Разбор источников:** заготовки `claude plugin list --json`, `~/.claude.json` (обычный, без
  нужных полей, мусор, больше предела), `.mcp.json`, `codex mcp list --json`, папки скиллов.
  Слияние одноимённых строк, «separate copies», встроенный `parley`.
- **Построение команд:** аргументы add, remove, install, uninstall, setEnabled, addMarketplace
  при каждом сочетании провайдера, уровня и вида.
- **Очередь:** два действия одного агента не идут одновременно, разных агентов — идут.
- **Симлинки** во временной папке: ссылка относительная; «забрать обратно» не трогает чужую
  папку и чужую ссылку; занятое место — ошибка.
- **Протокол:** схемы методов в `methods.test.ts`.
- **Окно:** строки с двумя значками, загрузка колонки Codex, встроенный `parley` под замком,
  подсказка про перезапуск, заполнение формы из JSON (обёртка `mcpServers`, один сервер, мусор).
- **Живая проверка:** окно 800×500, длинный путь проекта и длинные имена серверов и плагинов;
  настоящие add и remove MCP у обоих агентов в тестовом проекте; сессия в worktree видит MCP
  пользовательского уровня.

---

## 9. Куски

0. **Разведка.** Ответы на открытые вопросы раздела 10 вписываются в эту спеку до начала кода.
1. **Хост:** адаптеры, снимок, разрешённый список, `capabilities.get` и `refresh`, событие.
2. **Окно:** панель проекта только для чтения. Уже здесь от неё есть польза.
3. **MCP:** добавить (форма и JSON) и удалить, очередь, подсказка про перезапуск.
4. **Плагины:** каталог, состав перед установкой, install, uninstall, enable, disable, «Add
   marketplace».
5. **Скиллы:** дать второму агенту и забрать обратно.

Реализация — после актуальной базы chat-view (0.4.0), этап 5 единого плана.
Общий каталог скиллов создаётся раньше, на этапе 1; готовая панель не блокирует
навигацию агента. Backlog, Decisions и Memory добавляют вкладки в эту же панель,
не заводят вторую панель проекта.

---

## 10. Принятая разведка и оставшиеся gates

[Матрица P03/P04](../research/2026-10-03-parley-cli/contracts.md#7-provider-actions-и-безопасные-scopes)
закрыла реальные argv/JSON shapes, installed/available, canonical-main local MCP,
поддержанные scopes и explicit Check границы. Full native skill catalog остаётся
production baseline; whole-file SKILL.md ceiling 65 536 байт, shared pinned parsers,
canonical identity и unknown fail closed — контракт resolver из навигатора §3.2.
Remote discovery performance, managed denial/OAuth/remote install, plugin MCP schema,
полная source parity и live restart/enforcement остаются [gates P32](../research/2026-10-03-parley-cli/contracts.md#10-оставшиеся-gates-и-сдача).
Unsupported path — unavailable/native recovery, не guessed command.
