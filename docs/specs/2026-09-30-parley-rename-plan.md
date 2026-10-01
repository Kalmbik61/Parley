# Переименование harnas → parley в коде — план

Продукт снаружи уже называется **Parley**: коммит 2500e8c переименовал приложение, меню и тексты
окна, README и видео. Этот план доводит имя до кода, путей, переменных, имён для агентов и
данных на диске. Главное условие — живые данные человека не теряются и не раздваиваются:
- `~/.harnas`;
- `.harnas` в проектах;
- worktree;
- куки встроенного браузера;
- разрешение уведомлений;
- запущенные сессии.

Основа плана — инвентаризация 2026-09-30: четыре агента на чтение. Сводка лежит в
`.superpowers/parley-rename/inventory-digest.json` основного checkout.

Ветка `feat/parley-rename`, worktree `.claude/worktrees/parley-rename`, от master 2825eda.

## Решения

- **R1. Один модуль имён.** Файл `packages/core/src/names.ts` — единственный источник имён.
  Экспортируется из `@parley/core`.

  | Константа | Значение |
  | --- | --- |
  | `PRODUCT` | `'Parley'` |
  | `HOME_DIR` / `LEGACY_HOME_DIR` | `'.parley'` / `'.harnas'` |
  | `STATE_DIR` / `LEGACY_STATE_DIR` | `'.parley'` / `'.harnas'` |
  | `STATE_DIRS` | `['.parley', '.harnas']` |
  | `ENV_PREFIX` / `LEGACY_ENV_PREFIX` | `'PARLEY_'` / `'HARNAS_'` |
  | `MCP_SERVER_NAME` | `'parley'` |
  | `SKILL_NAME` / `LEGACY_SKILL_NAME` | `'parley'` / `'harnas'` |
  | `BRANCH_PREFIX` | `'parley/'` |
  | `DEFAULT_WORKTREE_ROOT` | `'~/parley/worktrees'` |

  Функции:
  - `envValue(env, key)` — сначала `PARLEY_<key>`, потом `HARNAS_<key>`. Пустая строка = не
    задано, как сейчас.
  - `envName(env, key)` — какое имя реально задано. Нужна для `settings.get.locked`.

  Литералы `.harnas`, `HARNAS_`, `'harnas'` вне этого модуля остаются только там, где это
  осознанное наследие (R7) или тест совместимости.
- **R2. Пакеты, бинарники, идентификаторы.**
  - Пакеты `@harnas/{core,protocol,host,desktop}` → `@parley/…`, корень `my-harnas` → `parley`.
  - Бинарники `harnas-core`, `harnas-mcp`, `harnas-host` → `parley-core`, `parley-mcp`,
    `parley-host`.
  - TS-имена: `harnasHome` → `parleyHome`, `HarnasConfig` → `ParleyConfig`, `HarnasBridge` →
    `ParleyBridge`, `window.harnas` → `window.parley`, `createHarnasServer` →
    `createParleyServer` и так далее.
  - Префиксы логов и ошибок: `[parley]`, `parley-mcp:`, `parley-error:`.
  - Временные каталоги тестов: `parley-…`.
  - Протокол не меняется: `PROTOCOL_VERSION` остаётся `1`.
- **R3. Переменные окружения.**
  - Всё чтение идёт через `envValue`: новое имя главнее, старое `HARNAS_*` работает как
    запасное. Это касается переменных в login-shell человека, `*_BIN`, настроек `ENV_NAMES` и
    сессионных переменных.
  - Детям (агент, MCP-сервер, хук, statusLine, notify Codex) передаются **оба** набора
    сессионных переменных: `PARLEY_WORK_DIR` и `HARNAS_WORK_DIR`, `PARLEY_SESSION_ID` и
    `HARNAS_SESSION_ID`, `PARLEY_CHANNEL` и `HARNAS_CHANNEL`, `PARLEY_HOME` и `HARNAS_HOME`.
    Старые хосты и старые скрипты работают дальше.
  - Команда хука: `${PARLEY_WORK_DIR:-$HARNAS_WORK_DIR}`.
  - Маска проброса env в Codex-MCP принимает оба префикса.
  - `contextFromEnv`, `statusline`, `codex-notify` читают оба имени.
  - Тесты и E2E задают `PARLEY_*`. Отдельные тесты проверяют запасные `HARNAS_*`.
- **R4. Дом.** `parleyHome()` выбирает первое подходящее:
  1. `PARLEY_HOME`;
  2. `HARNAS_HOME`;
  3. `~/.parley`, если он есть;
  4. `~/.harnas`, если он есть;
  5. иначе `~/.parley`.

  Окно больше не читает `process.env.HARNAS_HOME` само, а берёт дом только из core.
- **R5. Каталог состояния проекта.**
  - Выбор: `<проект>/.parley`, если есть; иначе `<проект>/.harnas`, если есть; иначе новый
    `.parley`.
  - Резолвер один (`stateDir(projectPath)`). Его используют `workPaths`, `works.ts`,
    `skill-install`, `mcp/context` (принимает оба basename).
  - Все стражи знают **оба** имени:
    - pathspec-исключения и `check-ignore` в `worktree.ts`;
    - `git-api.ts`, `fs-api.ts`, `watch.ts`;
    - запрет записи в `roots.ts`;
    - скрытие в дереве файлов;
    - `NotRunningCard`.
  - Созданный кодом `.parley` сразу получает `.parley/.gitignore` со строкой `*`: каталог
    состояния сам себя прячет в чужих репозиториях.
  - Корневой `.gitignore` этого репозитория: добавить `.parley/`, `.harnas/` оставить.
- **R6. Перенос данных.** Один раз, осторожно: `rename`, никогда не копия. Нет живого —
  переносим, есть живое — работаем со старым и пробуем при следующем запуске.
  - **Дом.** Переносит главный процесс окна при старте, до поиска и запуска хоста.
    - Условия, все сразу:
      - не задан ни `PARLEY_HOME`, ни `HARNAS_HOME`;
      - `~/.parley` нет;
      - `~/.harnas` — настоящий каталог, не симлинк;
      - старый хост не жив — проверка `host/host.pid` и сокета, как `isStaleLock` хоста;
      - нет `*.lock` в корне дома.
    - Тогда `rename(~/.harnas, ~/.parley)` и запись `~/.parley/migrated-from-harnas.json`:
      что, когда, откуда.
    - Иначе дом остаётся `~/.harnas`: по R4 окно подключится к старому хосту как раньше.
  - **Проекты.** Переносит хост при старте, до наблюдателей.
    - Для каждого проекта из `works-index.json`, где есть `.harnas` и нет `.parley`.
    - Условия: ни у одной сессии его работ нет живого процесса (`liveness`), нет `map.lock`.
    - Тогда `rename(.harnas, .parley)`, `.parley/.gitignore` (`*`), строка в
      `migrated-from-harnas.json`.
    - Мёртвые записи индекса пропускаются.
  - **Не трогаем никогда:**
    - существующие worktree `~/harnas/worktrees/…` и ветки `harnas/…` — путь и ветка
      закреплены в картах, `--resume` ищет транскрипт по cwd;
    - `worktreeRoot`, явно заданный человеком.
- **R7. Что намеренно остаётся со старым именем.** Всё это невидимо человеку, а смена стоит
  данных или разрешений.
  - `appId dev.harnas.desktop`: разрешение уведомлений, plist, savedState.
  - Раздел `persist:harnas-browser`: куки и хранилища встроенного браузера.
  - userData Electron закрепляется на `<appData>/@harnas/desktop`, если такой каталог есть;
    иначе используется `<appData>/@parley/desktop`. Ставится на верхнем уровне
    `main/index.ts` до `requestSingleInstanceLock`. Тесты со своим домом — как сейчас.
- **R8. Имена для агентов.**
  - MCP-сервер `parley`: инструменты `mcp__parley__*`, тег `<channel source="parley">`,
    `server:parley`, `serverInfo.name`. Двойной регистрации нет.
  - В гиде `read_guide` — строка о том, что в старых сессиях инструменты звались
    `mcp__harnas__*`, а в `.claude/agents/*.md` префикс надо поправить.
  - Скилл `parley`. Установщик убирает свои старые записи `harnas` по квитанции:
    - папку и симлинк — только если sha256 совпадает с записанным;
    - строки `info/exclude` со старым маркером;
    - правленное человеком не трогает.
- **R9. Worktree по умолчанию**, только для новых сессий:
  - корень `~/parley/worktrees`;
  - префикс ветки `parley/`;
  - сообщение слияния `parley: …`;
  - пример ветки в гиде и в `agent-guide-sync.test.ts` — вместе.
- **R10. Документы.**
  - README: технические разделы на новые имена. Новый короткий раздел «Переход с harnas»:
    - что переносится само, когда и при каких условиях;
    - что остаётся по R7;
    - что старые `HARNAS_*` читаются;
    - что старые worktree и ветки остаются как есть.
  - Абзац «в коде пока прежнее имя harnas» убрать. Лишний блок с постером под видео тоже
    убрать: плеер уже вставлен.
  - `TODOS.md`, прогон 15 — отметить сделанное, остаток записать.
  - Исторические `docs/specs/*` не трогать.
- **R11. Чего не делаем:**
  - двойной регистрации MCP;
  - симлинков старых каталогов;
  - копирования данных;
  - смены протокола.

  Не трогаем неотслеживаемый `packages/desktop/prototype/`.

## Шаги

Каждый шаг — отдельный агент, по очереди, в одном worktree. Каждый заканчивается зелёными
проверками и одним коммитом.

### S1. Механика имён — без смены поведения

Меняет только имена. Поведение (каталоги, env, MCP, скилл) остаётся прежним до S2 и S3.
- Пакеты, бинарники, TS-идентификаторы, мост `window.parley`, префиксы логов, временные
  каталоги тестов — по R2.
- Корневые скрипты `package.json`, `packages/desktop/package.json` (`dist`, фильтры),
  глобы в `electron-builder.yml`, `host-launcher` и его тест, `e2e/global-setup.ts`.
- `pnpm install`: lockfile и симлинки. Удалить устаревшие `*.tsbuildinfo` и `dist`/`out`
  перед сборкой.

Проверка: `pnpm build`, `pnpm typecheck`, `pnpm lint`, все юнит-тесты через замок.

### S2. Модуль имён, env и каталоги с чтением обоих имён

- `names.ts` по R1.
- env по R3.
- Дом по R4.
- Каталог проекта и стражи по R5.
- `.parley/.gitignore`.
- Окно берёт дом из core.
- E2E, `playwright.config.ts` и заглушки агентов (`stub-*.mjs`, `stub-echo-agent.mjs`) — на
  `PARLEY_*`. Заглушки понимают оба имени.
- В `e2e/global-setup.ts` страж: дом теста лежит под `os.tmpdir()`.
- Тесты совместимости: старые env; оба каталога; pathspec с обоими; `contextFromEnv` с
  `.harnas/works`; сохранённый `mcp/<sid>.json` со старыми env работает.

Проверка: сборка, typecheck, lint, все юнит-тесты.

### S3. Имена для агентов

- MCP-сервер и канал по R8.
- Скилл и очистка старого по R8.
- Ветка, корень worktree и сообщение слияния по R9.
- Тексты для агентов: гид, бриф, скилл, CLI usage, `tools.ts`.
- `agent-guide-sync.test.ts`.
- `e2e/agent-skills.spec.ts` и ключ `mcpServers` в `stub-echo-agent.mjs`.

Проверка: сборка, typecheck, lint, все юнит-тесты.

### S4. Перенос данных и userData

- Перенос дома — в окне, проектов — в хосте, по R6. Запись `migrated-from-harnas.json`.
- userData по R7.
- Юнит-тесты стражей переноса на временных каталогах:
  - живой хост → не переносим;
  - есть `.parley` → не переносим;
  - симлинк → не переносим;
  - живая сессия в проекте → проект не переносим;
  - `map.lock` → не переносим;
  - обычный случай → `rename` и запись.
- Один E2E: временный дом со старым `~/.harnas` (`works-index`, `config.json`) и проект со
  старым `.harnas`. Окно стартует → оба перенесены, работа видна в сайдбаре, `.parley/.gitignore`
  на месте.

Проверка: сборка, typecheck, lint, юнит-тесты, новый E2E.

### S5. Документы

README, TODOS и мелочи по R10.

Проверка: `git grep -in harnas` по живой документации — остаются только осознанные упоминания
(R7, раздел «Переход с harnas»).

### V. Проверка целиком

- Полный прогон через замок: все юнит-тесты, сборки, **все** E2E (`--workers=1`).
- После E2E пусты:
  - `pgrep -fl parley-rename/packages/host/dist`;
  - `~/harnas/worktrees`;
  - `~/parley/worktrees`.
- `git grep -in harnas -- . ':!docs/specs'` — каждое оставшееся вхождение разнесено по R7,
  совместимости, тестам совместимости или исторической записи. Список — в отчёт.

### R. Ревью

Одна состязательная линза по всему диффу ветки. Искать:
- потерю или раздвоение данных;
- пропущенный запасной путь (старый env, старый каталог);
- `.parley`, попавший в коммиты чужих проектов;
- второй хост рядом со старым;
- поломку `--resume` старых сессий.

Находки — со сценарием отказа.

### F. Правки по ревью

Одна волна правок, если ревью что-то нашло.

Сделано (ревью и проверка 2026-09-30). Уточнения к R6 и R8:
- **R6, что считается живым.** Кроме карты (pid и время старта) — таблица процессов (`ps`): сессию из
  терминала (`work session new`) карта хранит как `pending` без pid, а её агент держит путь к каталогу
  состояния в командной строке (`--mcp-config`, `--settings`). Нет таблицы — отказ. Дом теперь тоже проверяет
  сессии: по проектам своего индекса, в обоих именах каталога состояния.
- **R6, git.** Проект, у которого git отслеживает файлы `.harnas/`, не переносится (причина `tracked`):
  иначе отслеживаемое исчезло бы из рабочей копии, а `.parley` со своим `.gitignore` не закоммитить.
- **R6, ссылки на себя.** После `rename` пути артефактов в картах (`.harnas/works/…`) и относительные пути
  `.harnas/works/…` в сохранённых брифах переписываются на `.parley`. Проза (письма, резюме) — запись о
  сказанном, её не правим.
- **R8, разрешения.** «always allow» под `mcp__harnas__*` на `mcp__parley__*` не переезжают: строка в
  `read_guide` и в README; файлы настроек Claude Code не правятся.
- Песочница тестов снимает унаследованные `PARLEY_HOME` и `HARNAS_HOME`; адрес модели Monaco —
  `file:///parley/…`.

## Как гонять

- Замок тяжёлых прогонов:
  `/Users/kalmbik61/Desktop/MY/my_harnas/.superpowers/parley-rename/heavy.sh <команда…>`.
- Все юнит-тесты: `heavy.sh pnpm -r --workspace-concurrency=1 --no-bail run test --maxWorkers=4 --minWorkers=1`.
- Одиночные файлы: `pnpm --filter <пакет> exec vitest run <файлы> --maxWorkers=2 --minWorkers=1`.
- E2E: `heavy.sh pnpm --filter @parley/desktop e2e --workers=1` (до S1 фильтр — `@harnas/desktop`).
- Известные флейки: `theme.spec.ts:72`, `attention.spec.ts:190`, `rooms-dialogs.spec.ts:170`, в
  хосте — `rooms.test` «два Accept подряд» и `sessions-service` «закрытие по карте 8». Флейк
  перезапускать отдельно; если повторяется — это не флейк.

## Рамка

- Настоящие `claude` и `codex` не запускать.
- Не читать `~/.claude/.credentials.json`, `~/.codex/auth.json`, Keychain.
- Не писать в `~/.claude`, `~/.codex`, `~/.agents`, в настоящие `~/.harnas`, `~/.parley` и
  `~/harnas/worktrees`. E2E — только с временными `PARLEY_HOME` / `HARNAS_WORKTREE_ROOT` →
  `PARLEY_WORKTREE_ROOT`, `HARNAS_NOTIFICATIONS=log` → `PARLEY_NOTIFICATIONS=log`,
  `LOGIN_SHELL=skip`.
- Без `git stash`. В индекс — явные пути или `git add -u` плюс новые файлы по списку.
- Каждый шаг — один коммит на русском, в стиле репозитория, с последней строкой
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
