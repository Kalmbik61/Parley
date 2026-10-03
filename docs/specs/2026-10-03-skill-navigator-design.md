# Навигатор скиллов в сессиях Parley — дизайн

> Интеграционная сверка: 2026-10-03. [Единый план
> реализации](../plans/2026-10-03-parley-unified-implementation-plan.md), этапы 1, 4. Общий модуль
> источников используется навигатором и Capabilities; сокращение списка включается только после
> проверки конкретного CLI. Порядок и общие контракты — в плане; P00–P04 приняты по [контракту разведки](../research/2026-10-03-parley-cli/contracts.md).
> [Журнал выполнения](../plans/2026-10-03-parley-execution.md) отделяет evidence от остающихся live gates; реализация не завершена.

Дата: 2026-10-03. Статус: направление и четыре раздела дизайна приняты человеком в разговоре
2026-10-02…03 (свой навигатор вместо мода jev, в списке только имена, только свои скиллы,
локальный поиск по словам, выбирает сам агент, в комнате — ведущий). Единый план
составлен по согласованным спекам; принятая разведка отделяет подтверждённые формы от production candidate off и живых gates P32.
Основание:
- разбор мода `jev-skill-suggestion` и замер по транскриптам машины разработки (раздел 1.2);
- код Claude Code 2.1.287: бюджет списка скиллов (раздел 2.1);
- Codex 0.156.1: записи `[[skills.config]]`, `policy.allow_implicit_invocation`
  (`docs/research/2026-09-29-codex-research.md`), список скиллов не больше 2 % контекста
  (`packages/core/src/work/skill.ts`);
- как Parley запускает агентов: файл настроек работы в `--settings`
  (`packages/core/src/work/settings-file.ts`), флаги `-c` у Codex (`packages/core/src/providers.ts`),
  MCP-сервер `parley` на каждую сессию (`packages/core/src/work/mcp-config.ts`), системная вставка
  с потолком в 14 строк (`packages/core/src/work/guidance.ts`).

---

## 1. Зачем и что решено

### 1.1 Вопрос человека

Человек хотел применить в Parley мод `jev-skill-suggestion`: не грузить агентам все скиллы сразу,
а выбирать нужный через навигатор.

### 1.2 Что показал разбор мода

Мод — плагин Claude Code с функциональными хуками (ранний доступ, из claude-code-templates). Он
прячет от модели список скиллов и на каждый промпт вставляет целиком `SKILL.md` одного выбранного
скилла. Выбор по рецепту TypeSafe — два запроса к их модели Jev. Без ключа работает запасной
путь: один вызов маленькой модели Claude Code, без проверки «нужен ли скилл» и без перепроверки
тройки.

На машине разработки мод включён глобально: 86 скиллов переведены в `user-invocable-only`,
`disableBundledSkills: true`, ключа нет. Замер по 62 транскриптам (381 вставка), 2026-10-02:

- **Контекст.** Мод прячет список из 112 скиллов, это около 30 000 знаков. Взамен он вставляет
  в медиане около 28 000 знаков на сессию: `SKILL.md` в медиане занимает 8,8 тыс. знаков, у gstack
  до 80 тыс. Выигрыша нет.
- **Точность.** По ручной оценке последних 40 выборов, примерно половина мимо. Один и тот же
  стартовый промпт работы w-0010 в четырёх агентах дал четыре разных скилла.
- **Parley.** Мод срабатывает на стартовый промпт работы и на указатель «New messages…». На
  «вместе с GPT» он вставляет скиллы OMC (`ccg`, `ask`, `ultrawork`), и те ведут агента в обход
  инструментов Parley.
- **Субагенты** не видят 78 скрытых скиллов: мод работает только в главном разговоре.
- **Codex** мод не покрывает.

Из чего состоит список Claude на этой машине: скиллы плагинов — 17,5 тыс. знаков, claude.ai —
10,2 тыс., свои и проекта — 2,3 тыс. Одни имена заняли бы около 2,8 тыс.

### 1.3 Ответ

Роутер — сама модель сессии. Человек пишет на любом языке, модель его понимает и решает, какой
скилл нужен. Parley даёт ей две вещи:

1. **Короткий список — кандидат.** Целевой режим оставляет имена в родном списке Claude и описании `find_skill` Codex. Production сохраняет оба полных native списка до resolver parity и live gates P32 (раздел 2).
2. **Справочник.** Инструмент `find_skill` MCP-сервера `parley` по запросу отдаёт описания
   кандидатов, модель выбирает и загружает скилл родным способом своего CLI.

В комнате скилл для каждой части работы называет ведущий.

Решения:
- каждый агент находит только скиллы своего CLI; ведущий может искать скиллы участника (`for`);
- поиск локальный, по словам; без сети, без расхода лимита, без хука на каждый промпт;
- своего формата и каталога скиллов нет, источник — родные `SKILL.md`, как в спеке Capabilities
  (`docs/specs/2026-10-02-capabilities-design.md`);
- session-only выключение jev — candidate с обнаруженным точным id и сохранением Parley hooks; до live gates полного сокращения нет;
- правила CLI не обходим: спрятанный человеком скилл навигатор не показывает;
- переключатель в настройках Parley, по умолчанию выключен до живой проверки (раздел 8).

### 1.4 Чего не делаем

- Хук на каждый промпт со вставкой скилла, как у jev. Это противоречит решению из разбора OMC:
  «не брать хуки на каждый промпт».
- Отдельную модель для выбора (эмбеддинги, Haiku) и побочные вызовы модели сессии.
- Скиллы чужого провайдера: Codex-агент не берёт скилл Claude. Отдать скилл второму агенту — это
  «дать второму» в панели Capabilities.
- Свой формат, каталог и маркетплейс скиллов.
- Запись в `~/.claude/settings.json`, `~/.codex/config.toml` и в файлы мода jev.
- Показ в окне, какой скилл взял агент. Позже, если понадобится.

---

## 2. Что видит агент

### 2.1 Claude: кандидат списка из имён

В Claude Code 2.1.287 бюджет descriptions задаётся `SLASH_COMMAND_TOOL_CHAR_BUDGET`
либо `окно контекста × 4 × skillListingBudgetFraction` (default 0,01).
`skillListingBudgetFraction: 0` **invalid** в schema (`>0 && <=1`); observed CLI
с exit 0 оставил descriptions, поэтому этот вариант не передаётся.
`SLASH_COMMAND_TOOL_CHAR_BUDGET=1` — observed candidate: имена небандлённых скиллов
сохраняются, их descriptions убираются; bundled/name-only exceptions остаются.
Это не полный список длиной один знак и не гарантия размером ≤3000 знаков.

Production сохраняет полный native список. Env1 возможен только после complete
resolver parity, native main/subagent loader и реальных lifecycle gates P32.
Budget/jev candidate действует только в session env/settings, не в глобальном
конфиге; человеческие hidden rules и hooks/statusLine сохраняются.
`skillListingMaxDescChars=0` не заменяет доказанный candidate.

### 2.2 Codex: budget и suppression — кандидаты, production off

В Codex 0.156.1 offline подтверждены `skills.max_context_tokens` и
`skills.include_instructions=false`; второй путь version-pinned/source-backed.
Budget=1 убирает advertised rows, это не режим «только имена». Оба кандидата off:
production сохраняет полный native список до resolver parity и live P32 gates.
`find_skill` работает поверх него и не обещает сокращения.

Suppression candidate `-c skills.config=[{path=…, enabled=false}, …]` использует
canonical **полный SKILL.md**, не каталог. Человеческие native rules применяются
только из User и SessionFlags (не project skills.config), low→high с сохранением
порядка: последующие name/path selectors могут отменять предыдущие. name=false
скрывает все одноимённые документы; path=false — ровно файл. Directory selector
принимается parser, но документ не выключает. Разные canonical файлы с одинаковым
name сохраняются; symlink aliases одного файла дедуплицируются.

Human rules/policy вычисляются до Parley suppression; generated provenance
хранится отдельно, не становится human-disabled и не активирует hidden файл.
Нельзя generic-merge project TOML как native skills rules. Invalid override
ломает startup: не отправлять его с расчётом на retry. Partial/oversized/unknown
→ omit весь generated suppression, сохранить human flags и полный native список;
итоговый argv/env повторно проверяется по PARLEY.md §3.3.

### 2.3 Когда агент зовёт `find_skill`

Об этом говорит описание самого инструмента. В системной вставке — полфразы в существующей строке:
потолок в 14 строк не поднимаем. Тексты для агентов — на английском. Черновики (окончательный
текст — в плане):

- описание `find_skill`: «Looks up skills for a task. Before a task that a skill may cover
  (a workflow, a tool, a file format), call this and choose from the descriptions it returns. Skill descriptions are in English, so English words find more. Load the
  chosen skill the usual way. for — a session id: search the skills that session's agent can load
  (a room lead choosing a skill for a participant).» У Codex в конце — «Your skills: a, b, c…»;
- полфразы во вставке, в строке `read_guide`: «find_skill — skills by task, if needed».

Фраза о списке из одних имён добавляется только в подтверждённом режиме сокращения;
при запасном полном списке описание не обещает сокращение. Подсказка отсутствует,
если навигатор выключен или нативная роль не допускает инструмент.

### 2.4 Правила CLI

Навигатор не показывает скилл, который модель сама загрузить не может или которого человек
спрятал:
- `disable-model-invocation: true` в заголовке `SKILL.md`;
- effective `skillOverrides: off|user-invocable-only` только для native источников, к которым Claude применяет это правило. Plugin skills игнорируют обычные skillOverrides: например, `off` для `fixture:plugin-only` само по себе не скрывает plugin skill. Их доступность проверяется по native plugin включённости/policy и пути загрузки; неизвестность остаётся unavailable;
- у Codex — `policy.allow_implicit_invocation: false` в `agents/openai.yaml` скилла и записи
  `[[skills.config]]` с `enabled = false`, поставленные человеком.

---

## 3. Инструмент `find_skill`

### 3.1 Вход и выход

Вход:
- `query` — строка, обязательна: что ищем, словами модели;
- `for` — id сессии этой работы, необязателен: чьи скиллы искать. По умолчанию — свои;
- `limit` — сколько вернуть, по умолчанию 5, не больше 10.

Выход — JSON, как у остальных инструментов сервера: провайдер, для которого шёл поиск, и до
`limit` скиллов. У каждого скилла:
- `name` — как его зовёт CLI (у плагина с префиксом: `superpowers:brainstorming`);
- `description` — полное описание из заголовка `SKILL.md`;
- `source` — `user`, `project`, `plugin`, `claude.ai`, `system`, `admin`, `extra` по подтверждённому resolver; source union не обещает discovery/availability непроверенного root;
- `load` — как загрузить: у Claude — инструмент Skill с этим именем, у Codex — прочитать `SKILL.md`
  по абсолютному пути.

Ничего не нашлось — пустой список и фраза «No skill matched: work without one, or try other
words». Пустой `query`, сессия не из этой работы — ошибка. Закрытая сессия в `for` — можно: это
только чтение. Аннотации — `READS`.

### 3.2 Индекс

Индекс собирается из родных мест провайдера и живёт в процессе MCP-сервера до конца сессии. Для
Claude — при первом вызове, для Codex — при старте (нужны имена для описания инструмента). Индекс
для `for` строится лениво, отдельно на пару «провайдер, папка сессии», с учётом
native настроек этого контекста. Проектные источники берутся из рабочей папки участника (включая worktree), не ведущего; human выключения — из допустимых native layers CLI (Codex User/SessionFlags, не project skills.config). Для закрытой
сессии используются текущие файлы и настройки, а не исторический список скиллов.
Если её worktree удалён, возвращается явный пустой результат с причиной; поиск
не подменяется каталогом основной копии проекта.

Источники Claude: `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`),
`.claude/skills` session cwd и `.claude/commands/**/*.md` с native nested names.
Простое native skill name берётся из directory, не декоративного YAML name;
observed user/project collision выигрывает user, losing record — shadowed.
Plugin installPath/namespace, effective включённость и hidden rules учитываются
отдельно; installed_plugins.json/cache glob не доказывают effective availability.
Reserved synced требует native account/manifest/config и syncClaudeAiSkills veto,
не произвольный filesystem glob. Ancestor/enterprise/plugin/synced priority matrix
остаётся partial; неизвестный источник не рекламируется как доступный.

Источники Codex по pinned source: config folders `.codex/skills`, `.agents/skills`
cwd→native project root (native markers, не только .git), deprecated
`$CODEX_HOME/skills`, `$HOME/.agents/skills`, bundled `.system`, admin/system-config,
plugin и extra roots. Source-backed не означает observed parity: непроверенные
roots дают `availability-unverified`, не попадают в автоматический поиск.
Native bounds: depth 6, ≤2000 directories и ≤20000 entries на root; user/repo/admin
symlinks допустимы, system symlinks ignored; boundary live gates остаются.

Весь SKILL.md ≤65 536 байт inclusive: bounded max+1 read и strict UTF-8 decode,
затем только начальный YAML mapping frontmatter между самостоятельными `---`
строками (BOM/CRLF допустимы). Missing header отличается от invalid незакрытого/
битого header; body не возвращается и не индексируется. Shared `yaml@2.9.1`
parseDocument с errors/uniqueKeys и maxAliasCount=100 сохраняет full multiline
описание; `smol-toml@1.9.0` полноценно разбирает settings/policy, multiline и arrays.
Mapping/schema boolean/string fields без coercion; ошибки — только safe code/position,
без исходных строк. Missing/nonstring description при известном native name даёт
invalid-metadata unavailable record; неизвестный native name — diagnostic.
Unreadable root/broken link/limit — partial diagnostic, не успешный пустой источник;
unknown policy/availability fail closed, полный native список сохраняется.

Код чтения скиллов — общий модуль `packages/core/src/skills/`, используемый
навигатором и панелью Capabilities. Сканер подсказок chat-view, уже имеющийся в
текущем `master` в `packages/core/src/capabilities/`, переиспользуется и мигрирует
на этот модуль; второй независимый обход каталогов не создаётся. Его нынешняя
упрощённая шапка (первые 4096 байт и первая строка description) не является
полным YAML-разбором для навигатора.

Общий результат содержит источник, путь, полное описание и доступность модели
с причиной. Панель показывает установленное, в том числе скрытое; `find_skill`
применяет фильтр 2.4. Refresh панели не меняет уже построенный индекс сессии.
Identity — `(provider, realpath(полного документа))`, не basename/name/папка. Codex same-name файлы сохраняются; symlink aliases одного файла дедуплицируются. При неизвестной policy/availability `modelAvailable=false`, причина `availability-unverified`; фильтр до ranking. Native discovery/merge order выбирает запись canonical path, не BM25.

### 3.3 Поиск

BM25 по словам имени и описания. Имя весит втрое больше описания. Слова — в нижнем регистре,
разбиение по небуквенным знакам, имя ещё и по `-`, `_`, `:`. Английские стоп-слова выбрасываются,
окончания `-s`, `-es`, `-ing`, `-ed` срезаются. Возвращаются скиллы с ненулевым весом, при равенстве —
по native имени, затем canonical document path, фиксированным побайтным сравнением. Результат детерминирован.

Запрос на другом языке просто ничего не найдёт: модель сформулирует его заново, подсказка об
этом — в описании инструмента. Человеку подстраиваться не нужно.

---

## 4. Комнаты

Ведущий, раздавая части работы, называет скилл, если он подходит: «@s02 — `figma-design-to-code`».
Подходящий скилл участника он ищет через `find_skill` с `for: s02` и видит скиллы того CLI, на
котором работает участник. Новых полей в `send_message`, `propose_decision` и `spawn_session` нет —
это текст. В Checklist/Verified он входит в `scope` пункта плана или текст
решения и приходит владельцу системным письмом Parley. Рецепты не закрепляют
скилл заранее: выбор делается для конкретной задачи и CLI участника. Роль и
ограничения участника сильнее инструкций скилла. В разделе гида `lead` (`packages/core/src/work/guide.ts`) — одна фраза: «When handing out
parts, name a skill for each part if one fits: find_skill with for: <session id>». Участник
загружает скилл родным способом. Если скилл не подходит, участник говорит об этом в комнате.

---

## 5. Соседи

- **Мод jev.** Точный observed id — `jev-skill-suggestion@skills-dir`;
  session `enabledPlugins[id]=false` сохраняет command hooks. Обнаруживать installation
  source/id, не угадывать id для inline или другой установки. Candidate зависит от
  P32: statusLine, настоящие Parley report/end-turn/notify/wake. Не применять
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0`, disableAllHooks/safe-mode/bare или setup restore
  как fallback. Unknown id/failed gate → no suppression, полный список и diagnostic.

- **Скиллы, спрятанные модом jev.** Его настройка переводит скиллы в `user-invocable-only`. Модель
  такой скилл загрузить не может, поэтому навигатор его не показывает (раздел 2.4). На машине
  разработки таких 78, включая gstack. Совет человеку — в день выпуска навигатора выполнить
  `/jev-skill-suggestion:setup restore`: скиллы вернутся модели везде, мод в обычных сессиях
  продолжит работать как прежде. Это личная настройка человека, Parley её не трогает.
- **Субагенты Claude.** Synthetic native-loader evidence принято, но tools/permissions и реальный Parley lifecycle проверяются отдельно. Без доказанного Skill/find_skill path список не сокращается.
- **Скилл `parley`.** В candidate режиме description может сократиться; guidance ведёт к `read_guide`, но это не заменяет role-specific live loader gate.
- **Запущенные сессии.** Переключатель действует на новые и возобновлённые сессии: бюджет,
  выключение jev и `-c` задаются при запуске.

---

## 6. Включение

- В `ParleyConfig` — `skillNavigator: boolean`, переменная `PARLEY_SKILL_NAVIGATOR`, по умолчанию
  `false`. Переключатель «Skill navigator» в окне настроек рядом с `agentSkills`, текст на
  английском.
- Выключено — всё как сегодня: инструмента `find_skill` в списке сервера нет, бюджета, выключения
  jev и записей `-c` нет.
- Включено по умолчанию — отдельное решение после живой проверки (раздел 8).

---

### 6.1 Один снимок настройки на запуск

Запуск читает `skillNavigator` один раз; это значение определяет argv, настройки
Claude, подсказку в слое и окружение дочернего MCP-сервера. Сервер не перечитывает
новое значение из глобального файла независимо от уже запущенного агента.
Одновременное переключение настройки не может оставить короткий список без
`find_skill`. У включённого навигатора файл `--settings` создаётся для конкретной
сессии в `settings/<session-id>.json` каталога работы; при выключенном сохраняется
прежний путь. Хуки и statusLine базового файла сохраняются.

Навигатор не зависит от `agentSkills`: тот управляет установкой встроенного
скилла `parley`, а инструменты MCP и общий каталог имеют свой переключатель.
Индекс сессии не обновляется по Refresh панели: новые файлы видны после следующего
запуска/`resume` MCP. Нативная роль без Skill/`find_skill` получает предупреждение
и полный список; список не сокращается до появления проверенного пути загрузки.

## 7. Ошибки

- Будущая версия Claude Code перестала понимать запись бюджета — список снова полный. `find_skill`
  работает, теряется только экономия. Ловит проверка размера списка (раздел 8).
- Codex invalid skills.config observed ломает startup: только проверенный candidate после gates, иначе generated override отсутствует; не рассчитывать на повторный launch.
- jev не выключился — он прячет и список имён, и вставляет свой выбор. Ловит та же проверка
  размера списка: в транскрипте видны вставки мода.
- Индекс пуст — `find_skill` отвечает пустым списком, сессия работает; unreadable/partial/unknown даёт причину, не доказанное отсутствие скиллов.

---

## 8. Тесты и проверка

- **Модуль `skills/`:** источники каждого провайдера на заготовленных папках; фильтры раздела 2.4;
  разбор заголовка (кавычки, многострочное описание, больше 64 КБ, мусор); симлинки на папки.
- **Поиск:** заготовленные запросы и ожидаемый порядок первых трёх; детерминированность;
  пустой результат.
- **Инструмент:** схема, `for` (свой, чужой провайдер, не из этой работы, закрытая сессия),
  `limit`, описание с именами у Codex.
- **Запуск:** production full native list; budget/jev/Codex suppression отсутствуют до positive P32 gates. Candidate tests проверяют exact id, valid selectors/provenance, off/partial/overflow fallback, hook preservation и final argv/env; включённый navigator сам по себе suppression не разрешает.
- **Настройки:** `skillNavigator` из файла и из окружения, переключатель в окне;
  один snapshot запуска для argv/guidance/MCP, независимость от agentSkills,
  отдельный settings включённой сессии и сохранность всех хуков Parley.
- **Соседи:** панель видит скрытое с причиной, поиск фильтрует; Refresh не обновляет
  индекс MCP; role limits сохраняются; scope/снимок плана несут подсказку скилла.
- **Сверка на машине разработки:** имена индекса Claude совпадают с родным списком — полем
  `names` вложения `skill_listing` в транскрипте — за вычетом спрятанных.
- **Размер:** измерить skill_listing candidate на текущей контрольной машине, записав состав каталога; ориентир прежнего набора ≤3000 знаков не универсальный bound. До resolver/live gates production full list.
- **Живая проверка:** около 15 реальных промптов человека, включая те, где jev промахнулся, и те, где
  скилл не нужен. Правильный ответ — скилл или «не нужен» — размечает человек. Прогон на Claude и
  Codex, с навигатором и без. Цель — агент берёт верный скилл или обходится без него не реже, чем с
  родным списком, и лишних скиллов не берёт. Итоги вписываются в эту спеку.

---

## 9. Куски

0. **Разведка.** Ответы на вопросы раздела 10 вписываются в эту спеку до начала кода.
1. **Модуль `skills/`:** источники, заголовок, поиск, кеш, тесты.
2. **`find_skill`** в MCP-сервере: вход и выход, `for`, описание, тесты.
3. **Claude:** navigator/guidance/settings snapshot и переключатель; env1/exact-id jev candidate production off до P32.
4. **Codex:** navigator metadata; canonical-file suppression/budget candidates production off до P32.
5. **Проверка:** сверка, размер, живая проверка; решение о включении по умолчанию.

Очередь зафиксирована в едином плане: этап 0 — проверка CLI, этап 1 — общий
`skills/`, этап 4 — навигатор, этап 5 — панель Capabilities. Рецепты, планы и
память используют навигатор при его наличии и работают при выключенном.
Включение по умолчанию остаётся отдельным решением человека после живой проверки.

---

## 10. Принятая разведка и оставшиеся gates

P01–P04 приняты: [контракт и evidence/fallback](../research/2026-10-03-parley-cli/contracts.md#8-все-строки-этапа-0-evidence--fallback).
Fraction0 invalid, env1 candidate; Codex budget существует, suppression off;
commands/native User+SessionFlags/canonical file identity входят в resolver.
Synced/account/managed/plugin/admin/extra parity, live чтение Parley-disabled файла
при сохранении human disables, role-specific main/subagent tools, реальный
Parley lifecycle и Linux final-env guard остаются [P32 gates](../research/2026-10-03-parley-cli/contracts.md#10-оставшиеся-gates-и-сдача).
MCP sampling вне v1 и не задерживает реализацию. До gates — full list и unavailable/unknown.
