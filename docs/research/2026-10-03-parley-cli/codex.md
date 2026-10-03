# P02 — Codex CLI: источники, overrides, слой, роли и resume

Дата: 2026-10-03. База: `codex/parley-upgrade`, P00 `c1d4bb4`. Только исследование; production-флаги не изменялись.

## Вердикт для P04

**Offline-контракты подтверждены на установленном `codex-cli 0.156.1`; живое выполнение не принято.** Единственная ограниченная модельная попытка с выбранными для smoke `gpt-6.1-sol` / `high` получила HTTP 400: эта модель не поддерживается данным Codex CLI с ChatGPT account. Это ограничение проверенного CLI/runtime, не вывод о доступности модели у агентов приложения. Модель не подменяли. Не было успешного ответа модели, чтения отключённого файла, проверки записи, `report` или `resume`.

Поэтому до положительной живой проверки P32 сохранять нативный список скиллов; `find_skill` может работать поверх него. Сокращение списка, включая новый `skills.include_instructions=false`, остаётся выключенным. При отсутствии подтверждённой доставки слоя/ограничений нельзя объявлять роль готовой; роль read-only без обеспечиваемого канала sandbox/слоя не запускать, согласно общей спеке.

| Контракт | Evidence / статус | Безопасный путь |
| --- | --- | --- |
| User/project roots и повторяющиеся имена | observed, prompt-input + pinned source | идентичность по provider + canonical SKILL.md path; не придумывать winner по имени |
| `skills.config` path/name, ошибки, сохранение user disables | observed + source | сохранять порядок человеческих правил; необязательный override не передавать при неполном resolver/переполнении |
| `policy.allow_implicit_invocation=false` | observed: нет в автоматическом списке | исключать из автоматического поиска; явную загрузку не объявлять проверенной |
| Чтение файла, отключённого только Parley | unverified: live turn failed | нативный список; не скрывать его до живого read + MCP acceptance |
| `developer_instructions`, CLAUDE fallback | observed, offline | массив argv, сериализация TOML; живой запуск остаётся отдельным gate |
| sandbox и текст роли | observed: argv/config/prompt shape; enforcement unverified | отказ для роли, если доставка/ограничения не обеспечиваются |
| launch / resume / MCP report / notify | attempted launch failed; остальные unverified | P32 с поддержанной configured CLI моделью; не считать debug живой сессией |
| `--no-daemon` | observed: help + реальный launch argv принят | нет основания требовать 0.157 только по комментарию в коде |
| 96 КиБ аргумент macOS | observed success; большой argv — E2BIG | проверять каждый аргумент и сумму argv/env до spawn; Linux остаётся P32 |
| Plugins, remote/admin/profile overrides | source-backed частично; plugin fixture/live unverified | не сокращать список для непроверенного источника, не обходить cache как каталог включённых plugins |

## Среда и границы

- CLI: `/Users/kalmbik61/.nvm/versions/node/v22.18.0/bin/codex`, `codex-cli 0.156.1`, Node 22.18.0.
- ОС: macOS 15.3.1 arm64. `getconf ARG_MAX`: `1048576`.
- Изоляция offline: `HOME=/tmp/parley-p02/home`, `CODEX_HOME=/tmp/parley-p02/home/.codex`, temporary Git repo `/tmp/parley-p02/repo`, cwd `repo/sub`. Codex канонизирует `/tmp` в `/private/tmp`.
- Изоляция live: отдельные `/tmp/parley-p02/live-home` и `live-repo`; временная копия auth, собственный config/MCP fixture. Копия auth удалена после попытки. Значения credentials/config человека в отчёт не включены.
- SHA-256 настоящего `~/.codex/config.toml` до/после live совпал (`configUnchanged:true`). Настоящий global config и исходные checkouts не изменялись.
- Bootstrap выполнен. Корневого/родительского AGENTS.md внутри выданного worktree нет; применены инструкции пользователя и карточка P02. Общие plan/status/spec файлы не редактировались.
- Первое скачивание source в sandbox не смогло разрешить DNS; публичные upstream файлы затем прочитаны с разрешённой escalation. Ошибочные старые пути source дали 404; найдены актуальные split crates по tree API версии. Это не evidence отсутствия механизма.

## 1. Native skills: roots и идентичность

`codex debug prompt-input P02_TEST` вернул JSON array. Временные скиллы имеют `name`, `description`, тело-маркер. Наблюдаемые корни и строки списка:

```text
r0 = /private/tmp/parley-p02/repo/.codex/skills
r1 = /private/tmp/parley-p02/home/.codex/skills
r2 = /private/tmp/parley-p02/home/.agents/skills
r3 = /private/tmp/parley-p02/home/.codex/skills/.system
r4 = /private/tmp/parley-p02/repo/.agents/skills
r5 = /private/tmp/parley-p02/repo/sub/.agents/skills

- p02-collision: P02_ROOT_COLLISION (file: r4/p02-collision/SKILL.md)
- p02-collision: P02_NESTED_COLLISION (file: r5/p02-collision/SKILL.md)
- p02-nested: P02_NESTED (file: r5/p02-nested/SKILL.md)
- p02-oldproject: P02_OLDPROJECT (file: r0/p02-old-project/SKILL.md)
- p02-root: P02_ROOT (file: r4/p02-root/SKILL.md)
- p02-collision: P02_USER_COLLISION (file: r2/p02-collision/SKILL.md)
- p02-collision: P02_LEGACY_COLLISION (file: r1/p02-collision/SKILL.md)
- p02-legacy: P02_LEGACY (file: r1/p02-legacy/SKILL.md)
- p02-user: P02_USER (file: r2/p02-user/SKILL.md)
```

`p02-manual` с `agents/openai.yaml: policy.allow_implicit_invocation: false` отсутствует. `enabled=true` через user `skills.config` не возвращает его в автоматическую рекламу. Explicit invocation по `$skill` разрешён документацией, но живым вызовом здесь не проверен. [Official skill policy](https://learn.chatgpt.com/docs/build-skills).

Все четыре одноимённых файла рекламируются одновременно. **Приоритета по имени в native listing нет.** P04 должен хранить отдельные записи с путями и детерминированным tie-break; ответ с одним голым именем недостаточен для загрузки. Source `host_merge.rs` удаляет дубликаты **canonical path**, затем сортирует scope/name/path.

Pinned source `host_roots.rs` подтверждает:

- `skills` каждой project config folder (`.codex/skills`), deprecated `$CODEX_HOME/skills`, `$HOME/.agents/skills`, bundled `.system`;
- `.agents/skills` между cwd и найденным project root; root определяется markers, не обязательно только `.git`; `project_root_markers` из project config для этой операции пропускается;
- system config folder `skills` со scope Admin, plugin roots и extra roots;
- пути roots дедуплицируются. User/repo/admin directory symlinks разрешены; system symlinks игнорируются. Глубина recursive discovery 6, до 2000 каталогов, до 20000 entries на root. Это source evidence, не exhaustive boundary probe.

Следствие: исходный перечень navigator неполон без legacy project, bundled/admin/plugin источников. Unverified root не выдавать за поддержанный. Profiles/MDM/enterprise и реальные linked worktrees отдельно не воспроизводились.

## 2. `skills.config`, человеческие выключения и native budget

Безопасный argv (каждая строка — отдельный элемент; shell не участвует):

```json
["codex", "debug", "prompt-input", "-c",
 "skills.config=[{path=\"/tmp/parley-p02/home/.agents/skills/p02-user/SKILL.md\",enabled=false}]",
 "P02_TEST"]
```

Observed:

- Full SKILL.md path выключает user, legacy user, project и nested project строки. Сам файл остаётся на диске. Это не доказательство доступа модели.
- Path на **каталог скилла** принят как конфигурация, но не выключил файл. Использовать canonical full document path. В config-reference описание folder отличается от проверенной реализации; пример build-skills и source используют SKILL.md. [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [skill disable example](https://learn.chatgpt.com/docs/build-skills).
- `{name="p02-collision",enabled=false}` выключает все четыре одноимённых записи.
- User rule `{path=user/SKILL.md,enabled=false}` сохраняется при session override с другим selector (`nested`): обе строки скрыты. Это не обычная замена единого array.
- Project `.codex/config.toml` rule `{path=root/SKILL.md,enabled=false}` **не выключил** root skill. Source `skill_config_rules_from_stack` целенаправленно читает только User и SessionFlags из `all_layers_low_to_high`. Даже disabled config layers допускаются этим source вызовом; нельзя заменять его generic effective-TOML merge.
- Правила разных selectors сохраняются в порядке слоёв. Поздний одинаковый selector заменяет ранний; при применении позднее name/path правило может отменить раннее правило для того же файла. Source-only подтверждение точного cross-selector порядка; exhaustive комбинации не запускались.
- `skills.config="wrong"` → exit 1, `invalid type: string "wrong", expected a sequence`.
- `skills.config=[{path="/tmp/missing",enabled="false"}]` → exit 1, expected boolean. Неверный необязательный override способен сорвать launch, нельзя передавать его «на удачу».

Для Parley сначала строится доступность **из человеческих** user/session rules и policy; только потом формируется Parley snapshot. Записи Parley нельзя снова интерпретировать как human disables. Сохранять также name selectors и порядок, а не только список path=false. Project policy может быть отдельно более строгим контрактом Parley, но его нельзя называть native Codex behavior.

Обнаруженный drift спеки «у Codex нет бюджета»:

| Override | prompt-input, exit 0 | Применение сейчас |
| --- | --- | --- |
| `skills.include_instructions=false` | `<skills_instructions>` целиком отсутствует | supported offline; production reduction disabled до live acceptance |
| `skills.max_context_tokens=1` | skills block есть, advertised skill rows нет | не является режимом «только имена» |
| `skills.config=[…]` | выбранные записи отсутствуют | valid offline; роста argv можно избежать иным механизмом после принятого решения P04 |

`SkillsConfig` source имеет `include_instructions: Option<bool>` и positive `max_context_tokens`, capped 10000; официальный reference подтверждает budget, default 2%. `include_instructions` в fetched reference не найден, поэтому его поддержка опирается на установленный CLI + version-pinned source, а не на документированный стабильный API.

## 3. Слой, fallback и shape

Пример argv:

```json
["codex", "debug", "prompt-input", "-c",
 "developer_instructions=\"P02_DEV quote \\\" \\\\ newline\\nКириллица\"",
 "-c", "sandbox_mode=\"read-only\"",
 "-c", "project_doc_fallback_filenames=[\"CLAUDE.md\"]", "P02_TEST"]
```

Observed JSON shape:

```json
[
  {"type":"message","role":"developer","content":[{"type":"input_text","text":"…permissions…"},{"type":"input_text","text":"…P02_DEV exact decoded text…"},{"type":"input_text","text":"…skills…"}]},
  {"type":"message","role":"user","content":[{"type":"input_text","text":"…AGENTS instructions if found…"},{"type":"input_text","text":"…environment_context…"}]},
  {"type":"message","role":"user","content":[{"type":"input_text","text":"P02_TEST"}]}
]
```

Количество content blocks зависит от наличия слоя/skills/project docs; это fixture shape, не стабильный RPC schema. Quotes, backslash, newline, Cyrillic возвращены точно; native permissions/environment показывают restricted read-only filesystem. Plain role developer body не подменяет permissions.

Fallback fixtures:

| Файлы в root / cwd | Override | Model-visible marker |
| --- | --- | --- |
| CLAUDE.md / CLAUDE.md | нет | оба отсутствуют |
| CLAUDE.md / CLAUDE.md | `["CLAUDE.md"]` | `P02_CLAUDE_ROOT`, `P02_CLAUDE_NESTED` |
| AGENTS.md + CLAUDE.md / AGENTS.override.md + CLAUDE.md | `["CLAUDE.md"]` | `P02_AGENTS_ROOT`, `P02_OVERRIDE_NESTED`; CLAUDE markers отсутствуют |

В каждой папке нативный AGENTS/override выигрывает у fallback; накопление root→cwd подтверждено. `.claude/CLAUDE.md` и исчерпание project-doc budget в этих probes не проверялись. Мост передавать голым filename, не каталогом.

`--no-daemon` присутствует в help установленной 0.156.1; `codex --no-daemon --help` exit 0. Live argv с ним дошёл до модельного HTTP error, без unknown-option error. Комментарий introduced 0.157 не является доказательством необходимости guard. Для иных бинарников нужна capability check, не выдуманная минимальная версия.

## 4. Native roles: source evidence и предел проверки

Pinned `agent-roles/{loader,discovery,agent_role_config}.rs`:

- discovering recursive `agents/**/*.toml` относительно config folders; layers low→high;
- более поздняя одноимённая роль побеждает, недостающая metadata может наследоваться;
- auto-discovered file требует `name`, непустой `developer_instructions`; description обязателен после merge. Filename fallback из спеки не соответствует auto-discovery. Declared `[agents.name] config_file` имеет name hint и иной validation путь;
- роль — конфигурация для subagent; отдельного main-session role flag в help нет. Для main session Parley доставляет выбранные поля собственными `-m`/`-c`, не только label.

Temporary native role fixture с user/project одноимённым TOML принят offline без stderr, но `debug prompt-input` не отобразил role descriptions и не применил role body к главной сессии. Поэтому **native winner остаётся source-backed**, не observed model selection. Нельзя утверждать, что роль реально ограничила главную сессию на основании этой пробы.

Supported offline main-session args: `-m gpt-6.1-sol`, `-c model_reasoning_effort="high"`, `-c sandbox_mode="read-only"`, `-c developer_instructions=<serialized layer>`, top-level `-a on-request`. Resume config parsing заявлен help `codex exec resume --help`; живого resume нет. Immediate delivery обновлённого developer layer/предел «после compaction» здесь не доказан: не обещать немедленное обновление; оставлять P32 gate.

## 5. Plugins и policy

Наличие Codex plugin skills подтверждено официальной документацией и pinned source, но временный установленный plugin с enabled/disabled слоями **не воспроизводился**. [Official plugin packaging and configuration](https://developers.openai.com/plugins/build/plugins).

Source `core-plugins/loader.rs` объединяет configured stack plugins с remote installed snapshot; native plugin skills проходят skill rules. `store.rs`: cache `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`. Cache содержит установленные версии и не равен enabled catalog. `ext/skills/host_roots.rs` принимает plugin skill roots с identity/namespace; режим portable Agent Plugin может быть direct-children, legacy — recursive. Поэтому нельзя свести поддержку к glob всех `cache/**/SKILL.md` или получить актуальный remote state из диска.

Официальная документация описывает repo `.agents/plugins/marketplace.json` и `[plugins."name@marketplace"].enabled` в trusted project `.codex/config.toml`, с project overrides и enforced requirements. Это documented контракт, не локально проверенная precedence matrix. Remote/admin requirements/plugins и namespace collisions оставить неподдержанными для pruning до native parity fixture. Safe fallback: полный native list, диагностировать частичный индекс.

## 6. Размер argv/environment

Обязательный Parley ceiling остаётся 98304 bytes **после сериализации**, включая `developer_instructions=`. Проверка в macOS временном проекте:

```json
[
 {"kind":"ascii","argBytes":98304,"exit":0,"developerContains":true},
 {"kind":"utf8","argBytes":70025,"exit":0,"developerContains":true},
 {"kind":"large","argBytes":1100025,"errno":7,"error":"Argument list too long"},
 {"argMax":1048576,"environmentBytes":2131,"environmentEntries":31}
]
```

Unicode fixture — 20000 `Ж` и 15000 newline; строки декодированы точно. Large аргумент отвергнут ОС до запуска CLI. ARG_MAX — не обещание для одного аргумента/любого env. Generic pre-spawn budget должен учитывать UTF-8 всех argv/env, NUL terminators, служебный запас платформы и per-arg 96 КиБ Parley; injectable limits нужны для тестов. Linux, long canonical paths и большое inherited environment здесь **unverified**, не основание повышать ceiling. Optional skills override oversized → убрать целиком и сохранить native list. Mandatory layer oversized → `session-layer-too-large` до spawn, без усечения.

## 7. Live попытка и остаточная проверка

Безопасный launch argv shape (массив, no shell):

```text
codex --no-daemon -a on-request
  -c sandbox_mode="read-only"
  -c model_reasoning_effort="high"
  -c skills.config=[{path="<temporary full SKILL.md>",enabled=false}]
  -c developer_instructions="<P02_ROLE_READONLY + P02_LAUNCH_A>"
  exec --json -m gpt-6.1-sol -C /tmp/parley-p02/live-repo <bounded probe>
```

Temporary stdio MCP `p02_probe` exposes `report(text:string)`, returns `P02_REPORT_ACK`, stores only fixture reports under `/tmp`; реальные сообщения людям не отправляет. Не является Parley product integration.

Observed event sequence: `thread.started`, `item.completed` (fallback model metadata warning), `turn.started`, `error`, `turn.failed`; exit 1. Server error:

```text
HTTP 400 invalid_request_error:
The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.
```

`writeExists:false` — лишь факт отсутствия записи после failed turn, **не evidence sandbox enforcement**. Resume намеренно не выполнялся после failed launch. Report ACK не получен. Нужны P32 проверки на поддержанной нативным CLI модели (можно использовать его configured model; модель исполнителя/reviewer workflow остаётся `gpt-6.1-sol` / `high`): actual shell read только Parley-disabled path; human-disabled файл не должен попасть в поиск; denied write без elevation; product `report` и конец хода/notify; launch/resume одинаковый argv channel; изменённый слой с compaction boundary. До этого claims live-ready/list-reduction запрещены.

## Воспроизведение и evidence

Текущие обезличенные fixtures и скрипты находятся в `/tmp/parley-p02`; они не часть product. Скрипты не меняют checkout/global config. **Не запускать `live.py` повторно с той же недоступной CLI моделью**: уже получен runtime отказ. Повтор smoke с configured supported CLI моделью относится к P32 и не меняет модель агента workflow; отказ не блокирует всю реализацию.

```text
python3 /tmp/parley-p02/probe.py
python3 /tmp/parley-p02/merge-probe.py
```

`probe.py` создаёт изолированные roots/config, запускает debug fixtures и пишет `out/*.json`/`*.stderr`. `merge-probe.py` проверяет user/project/session selectors; для новой машины заменить единственный абсолютный путь CLI, остальные fixture paths локальны. Отдельные `include_false.json`, `budget_one.json`, `disable_name.json`, `native_roles.json`, `sizes.json`, `live-out/{launch-argv.json,launch.jsonl,launch.stderr}` сохраняют итоговые результаты. Canonical `/private/tmp` соответствует `/tmp`. `probe.py` перед запуском очищает только собственные offline `home`/`repo` fixtures, поэтому baseline воспроизводим. Он не трогает `live-home` или настоящий HOME. Baseline `roots.json` уже сохранён.

Минимальная portable схема offline-повтора без этих artifacts:

```python
# Python 3.11+: tmp = TemporaryDirectory(); создать HOME/.codex/config.toml,
# temp git repo/.agents/skills/a/SKILL.md и HOME/.agents/skills/b/SKILL.md.
# SKILL.md: ---\nname: a\ndescription: P02_A\n---\nBODY\n
argv = ['codex', 'debug', 'prompt-input', '-c',
        'developer_instructions=' + json.dumps('quote " \\ newline\nЖ', ensure_ascii=False),
        '-c', 'skills.config=[{path=' + json.dumps(str(skill_md)) + ',enabled=false}]',
        '-c', 'sandbox_mode="read-only"', 'P02_TEST']
result = subprocess.run(argv, cwd=repo, env={**os.environ, 'HOME': str(home),
                        'CODEX_HOME': str(home / '.codex')},
                        capture_output=True, text=True, timeout=25)
# Assert exit 0; decode JSON array; inspect role/content text and skill rows.
```

Pinned upstream source (read from official OpenAI repository tag `rust-v0.156.1`, saved under `source/`; no moving-main inference):

- [Skills configuration rules](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/skills_config.rs)
- [Host roots](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/ext/skills/src/host_roots.rs)
- [Canonical merge and sorting](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/ext/skills/src/loader/host_merge.rs)
- [Discovery constants](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/ext/skills/src/loader/mod.rs)
- [Role parsing](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/agent-roles/src/agent_role_config.rs), [role loading](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/agent-roles/src/loader.rs)
- [Plugin loading](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/loader.rs), [plugin storage](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core-plugins/src/store.rs)

Observed installed binary is authoritative for tested flags; pinned source adds contracts not directly observable in debug. Official current docs can differ from version-pinned source; mismatches are recorded above. P02 closes bounded research with explicit fallback/gates, not release acceptance.

Проверка сдачи: 15 целевых assertions по сохранённым JSON fixtures прошли; `git diff --no-index --check /dev/null codex.md` прошёл. Файл не staged/committed; ведущий интегрирует после независимого review.

## 8. P12: фактический контекст конфигурации без model turn

Дополнительная read-only разведка /root/p01_review, gpt-6.1-sol/high, Codex 0.156.1. Изолированные HOME/CODEX_HOME и вложенный git project; четыре bounded stdio subprocess probes. Ни model/thread, ни daemon, MCP/OAuth не запускались; процессы завершались SIGTERM с двухсекундным SIGKILL fallback. Raw stdout/config не сохранялись в product/logs.

Поддержанный обмен: `codex app-server --stdio`; JSONL `initialize` с clientInfo и experimentalApi, notification `initialized`, request `config/read` с `{cwd, includeLayers:true}`, затем `configRequirements/read` с `{}`. Ответ `layers` упорядочен high→low. Для role loader его нужно развернуть и пропустить слои с disabledReason. `layer.config` содержит исходную parsed таблицу `agents`; effective `response.config` в fixtures её не содержал, поэтому отсутствие declared roles нельзя выводить из effective DTO. Проверять agents нужно во всех активных слоях, включая SessionFlags без config folder.

Native config_folder: System/User — parent поля file; Project — dotCodexFolder; остальные sources не дают папку. Четыре случая:

| Fixture | Результат |
|---|---|
| Nested project, untrusted | Оба Project слоя возвращены, disabled; User/System active |
| Nested project, trusted | Оба Project слоя active; порядок nested→root→user→system |
| Trusted плюс `-c agents.max_threads=3` | SessionFlags первый high-priority слой; parsed agents сохранена |
| `--profile blue app-server` | CLI отвергает profile для app-server; read API не имеет profile parameter |

Обычные controls max_threads не являются declared role; named entries таблицы agents требуют отдельной unsupported-config диагностики до role selection. Named-profile runner пока context-unverified: не делать guessed manual merge. configRequirements/read вернул none только в этих synthetic fixtures; nonempty managed/MDM/cloud constraints не проверены. Не превращать это в утверждение поддержки всех requirements. В production передавать только whitelist projection (folder/order/disabled/hasDeclaredRoles/version/constraints), raw config/stdout не логировать и не возвращать в DTO.

Evidence: `/private/tmp/parley-p12-context-_znxl0q4/probe.py` и safe-summary.json. Переносимый повтор: создать temporary HOME/CODEX_HOME, git project/sub, user config с analytics=false/plugins=false и projects.<canonical-main>.trust_level, по одному .codex/config.toml с agents.max_threads в root/sub; выполнить обмен выше с bounded cleanup. Profile failure должен оставаться failure, а не пустым успешным каталогом.

Pinned primary sources: [config layer state/order/folders](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/state.rs), [config read service](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/config_manager_service.rs), [protocol/config](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/config.rs). Это evidence для P12 adapter; P11 review и P32 live gates принимаются отдельно.

### P12 source-bound schema уточнения

Pinned `AgentsToml` tuning keys: enabled; max_concurrent_threads_per_session; max_threads (serde alias); max_depth; default_subagent_model; default_subagent_reasoning_effort; job_max_runtime_seconds (removed compatibility no-op); interrupt_message. Все остальные keys flattened в AgentRoleToml map, то есть declared-role candidates. Успешный effective config/read не доказывает корректность каждого raw layer: malformed lower-layer value мог быть перекрыт выше. Active layer agents должен быть object с валидными tuning types, иначе context-unverified. [Exact definition](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/config_toml.rs).

`configRequirements/read` exact null — поддержанный путь без requirements. Property обязана присутствовать; любой non-null/unknown/malformed результат пока context-unverified. Non-null object даже с null visible fields не означает отсутствие policy: DTO projection lossy, raw remote_sandbox_config/rules не входят; login restriction без requirements.toml тоже создаёт object. Empty allowedSandboxModes не unrestricted. [Requirements projection](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/config_processor.rs). P12 не ослабляет policy ручной интерпретацией неполной проекции.
