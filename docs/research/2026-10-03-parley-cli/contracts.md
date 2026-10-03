# P04 — контракты реализации по принятой разведке

Дата: 2026-10-03. Checkout: `/Users/kalmbik61/.codex/worktrees/parley-upgrade/my_harnas`, `codex/parley-upgrade`; входной HEAD `28b9187e19766304bd785c8885576c9857d2babb`. Основание: независимо принятые [P01 Claude](claude.md), [P02 Codex](codex.md), [P03 Capabilities](capabilities.md), [общие контракты](../../plans/2026-10-03-parley-unified-implementation-plan.md#shared-contracts) и [карточка P04](../../plans/2026-10-03-parley-agent-tasks.md#p04).

Этот контракт разрешает реализацию P05–P09 с указанными ограничениями. Он не принимает live release, не меняет product/config/dependencies и не разрешает сокращение нативных списков. Во время исследования зависимости только распакованы в `/tmp`, без package-manager install, для отдельной проверки API на Node 20.

## 1. Неизменные архитектурные границы

- `cwd` — контекст CLI конкретной сессии/worktree. Skill resolver, native rules/roles и `find_skill(for)` используют его, не cwd ведущего.
- `projectPath` — основная копия общих PARLEY.md, памяти, бэклога, рецептов, планов и журнала через общий `stateDir` с прежним `.harnas/` fallback. Исправление native local MCP identity не меняет `cwd` или общий `projectPath`.
- Один общий каталог и полноценные YAML/TOML parsers обслуживают navigator/Capabilities и миграцию существующего scanner chat-view. Сигнатура `capabilities.list`, команды/агенты и её ограничения сохраняются; DTO нового каталога не подменяет этот wire-контракт. P08 adapter сохраняет прежний `CapabilitySkill.path` (папка для SKILL.md, файл для command), прежний source enum `user|project|plugin` и пустые массивы у неподдержанного provider. Новый canonical document path остаётся внутренним; extra source нельзя молча привести к user. Новые источники идут в новую панель отдельной безопасной projection.
- Один сборщик слоя используется для launch, quick start, autoLaunch и resume: `systemGuidance (≤14 строк) → мост Codex → роль → плейбук только ведущему → quiet brief → обработанный PARLEY.md → факты памяти`. Различаются только каналы `{systemPrompt}` и `{developerInstructions}`, не состав.
- Обработанные PARLEY.md, текст роли и плейбук — каждый ≤32768 UTF-8 байт, включая конечную marker строку. Сохраняется documented обрезка по последней строке с явной меткой и безопасным warning: PARLEY.md §5.2 (`[PARLEY.md is cut at 32 KB by Parley]`, `parley-md-truncated`), роли §5.2/§8 и рецепты §6.3 (marked line truncation). Нельзя silent truncation; native role permissions/model/effort side channels не усекаются и не ослабляются вместе с текстом. Память — 12288; итоговый сериализованный аргумент — 98304. Переполнение собранного обязательного аргумента после preprocessing/escaping — `session-layer-too-large` до spawn; не повторная обрезка сборки. Скиллы не меняют provider/model/effort/permissions; постоянного поля skill у сессии/рецепта/пункта нет.
- `skillNavigator=false` по умолчанию; `agentSkills` независим. Один снимок настройки передаётся в launch flags/guidance/MCP env. Выключенный navigator не добавляет Parley budget, jev-disable или skills.config. Человеческие native правила остаются действующими.
- Каталог живёт локально в MCP по provider/cwd, панель — безопасный host snapshot с Refresh без watcher. Машинные paths/catalog/config/тела SKILL.md/секреты не пишутся в общую память. Immutable accepted plan/decision rev и граница shared/local state не меняются.

## 2. NativeSkill, identity и причины

Сохраняется boolean-контракт unified plan; отдельный stored tri-state не нужен:

```ts
interface NativeSkill {
  provider: 'claude' | 'codex';
  name: string; // точное native load name, включая namespace
  description: string; // полное валидное описание; пусто только у invalid metadata record
  source: 'user' | 'project' | 'plugin' | 'claude.ai' | 'system' | 'admin' | 'extra';
  path: string; // абсолютный canonical путь всего документа SKILL.md / Claude command .md
  documentKind: 'skill' | 'command'; // internal origin; never infer from canonical basename
  modelAvailable: boolean;
  unavailableReason: string | null;
}
```

Identity — tuple `(provider, realpath(document))`; при необходимости ключ `JSON.stringify([provider, path])`. Не basename, не имя скилла и не каталог вместо SKILL.md. Symlink aliases одного файла дедуплицируются внутри provider; разные providers не объединяются. Для одинакового canonical path выбирается запись в native discovery/merge order, а не победитель после BM25; непроверенный alias/name conflict требует partial diagnostic. Имя может повторяться у Codex. Ranking tie-break: score desc, затем native name, затем canonical path, фиксированное побайтное сравнение; canonical path нужен и в ответе Codex для однозначной загрузки.

`modelAvailable=true` только при подтверждённых source, native rule/policy и пути загрузки для данного контекста; `unavailableReason=null`. Любая неизвестность — `false`, не guessed enabled. Панель видит запись и причину, navigator исключает её **до** ranking. `installed` не равняется model availability; наличие папки cache/synced не является включённостью.

Минимальный словарь причин: `human-disabled`, `user-invocable-only`, `implicit-invocation-disabled`, `disable-model-invocation`, `plugin-disabled`, `shadowed`, `availability-unverified`, `invalid-metadata`, `load-tool-unavailable`. Синтаксически битые, oversized, unreadable документы и broken symlinks дают отдельные безопасные diagnostics `invalid-yaml|invalid-toml|invalid-utf8|file-too-large|unreadable|invalid-policy|invalid-name`, без фиктивного NativeSkill. Пропущенный либо нестроковый description при известном native name сохраняет запись с `description=''`, `modelAvailable=false`, `invalid-metadata`; нельзя приводить массив/число к строке. Если native name определить нельзя, только diagnostic. Валидный name-only override сохраняет исходное полное description и доступность; он ограничивает advertisement, не содержимое индекса.

Непроверенные system/admin/extra roots могут иметь diagnostic/недоступную запись, но union не означает поддержанный discovery. Unreadable root отмечается partial, а не успешным пустым источником. Broken/циклические ссылки и лимит обхода не роняют весь каталог; они запрещают pruning неполного каталога.

## 3. Источники, приоритеты и native rules

| Провайдер / область | Точный принятый контракт | Где остаётся partial/fallback |
|---|---|---|
| Claude user/project | `$CLAUDE_CONFIG_DIR/skills` (по умолчанию `~/.claude/skills`) и `.claude/skills` session cwd; simple native name из directory, а не декоративного YAML name. В observed коллизии user выигрывает project; losing record `shadowed` | Ancestor roots, enterprise layers и исчерпывающая priority matrix не проверены; не объявлять произвольный filesystem override native winner |
| Claude commands | `.claude/commands/**/*.md` входят в model listing, native nested name `nested:nested-only`; общий resolver обязан учитывать их | Полный command/skill collision precedence требует fixture; не хранить второй независимый scanner |
| Claude plugins | Native names namespace вида `fixture:plugin-only`; включённость и установленность читаются отдельно. `projectEnabled` не общий effective enabled, нельзя фильтровать только по нему | Cache glob и installed_plugins.json сами по себе недостаточны для effective policy; P03 list evidence не подтверждает все source variants |
| Claude скрытия | `disable-model-invocation:true`, effective `skillOverrides: off|user-invocable-only` исключают автоматический поиск; name-only оставляет имя. Human overrides сохраняются при отключении jev | Plugin skills не следует автоматически подчинять обычным skillOverrides; неизвестные managed settings → `availability-unverified` |
| Claude synced/bundled | Reserved `skills/synced/<account>` требует native account/manifest/config, включая syncClaudeAiSkills veto; bundled — отдельный system источник | Arbitrary synced fixture не рекламировался. Не угадывать active account/namespace; полный native list, partial diagnostic |
| Codex roots | Project config folders `.codex/skills`, cwd→native project root `.agents/skills`, deprecated `$CODEX_HOME/skills`, `$HOME/.agents/skills`, bundled `.system`; pinned source также admin/system-config, plugin и extra roots | Project root берётся из native markers, не только `.git`; profiles/MDM/admin/plugin/real linked-worktree parity не полностью observed. Unverified источники не доступны поиску |
| Codex duplicates | Одноимённые project/nested/user/legacy документы одновременно в native listing. Дедупликация canonical path, не winner по имени; source sorting scope/name/path | Не переносить Claude user>project winner на Codex. Для загрузки всегда полный canonical SKILL.md |
| Codex rules | Только native layers **User и SessionFlags**, low→high, включая native loader behavior для disabled config layers; project skills.config не участвует | Generic effective-TOML merge project rules дал бы ошибочный native результат; Parley project restriction нельзя называть native rule |
| Codex selectors | Preserve rule order; одинаковый selector заменяется поздним. Последующие name/path rules применяются в порядке и могут отменить предыдущие для файла. name=false скрывает все одноимённые; path=false — ровно canonical full SKILL.md | Cross-selector порядок source-backed, не exhaustive live. Directory selector принят parser, но **не выключает** документ |
| Codex policy | `agents/openai.yaml` `policy.allow_implicit_invocation:false` исключает автоматический поиск; enabled=true не снимает veto | Неверная форма policy/неboolean → invalid-policy diagnostic и недоступность, никогда true. Explicit invocation live не подтверждён |

Pinned boundary evidence Codex: depth 6, ≤2000 directories и ≤20000 entries на root; allowed user/repo/admin symlinks, system symlinks ignored. Это native source contract из P02, не результаты новых P04 граничных тестов. Все root/settings inputs инъецируются для fixture; CLI-specific resolver сохраняет native порядок, generic parser только разбирает документы.

Человеческие правила вычисляются **до** временного Parley suppression snapshot. Snapshot содержит provenance generated-by-Parley отдельно от human rules: Parley path=false не должен позже стать human-disabled. Generated selector не заменяет/не активирует human-disabled файл; исходный порядок человеческих flags сохраняется. При невозможности точного merge generated suppression целиком отсутствует, native list сохранён. Неверные overrides вызывают exit 1, поэтому их нельзя отправлять с расчётом на launch retry.

## 4. Production fallback и роли

**Оба полных нативных списка сохраняются в production до resolver parity и положительных live P32 gates.** Navigator разрешён поверх списка; отсутствие подходящего скилла — нормальный результат. Показанный ниже механизм — кандидат, не включение.

| Механизм | Статус P01/P02 | Разрешённое поведение |
|---|---|---|
| Claude skillListingBudgetFraction=0 | invalid schema (`>0 && <=1`); exit 0 молча оставил descriptions | Запрещённый вариант; удалить из целевого дизайна |
| Claude SLASH_COMMAND_TOOL_CHAR_BUDGET=1 | observed names сохраняются, небандлённые descriptions убраны; bundled exception остаётся | Candidate только после complete resolver, role loader и Parley lifecycle gates. Это budget descriptions, не полный список длиной 1 |
| Jev | Точный observed module id `jev-skill-suggestion@skills-dir`; session enabledPlugins=false сохраняет command hooks | Обнаруживать конкретный id/installation source; не предполагать id для inline/другой установки. Preserve session hooks/statusLine/end-turn/wake; не disableAllHooks/safe-mode/bare, не setup restore |
| Codex skills.config | Offline full-path/name selectors работают; invalid config срывает startup | Production suppression off. Только валидированный provenance-aware candidate; oversized/partial resolver → omit generated override |
| Codex include_instructions=false | Offline удаляет весь skills block; source-pinned, не подтверждён stable public reference | Candidate off; не гарантирует разрешённое чтение выбранного документа |
| Codex max_context_tokens=1 | Offline нет advertised rows; budget действительно есть | Candidate off; не режим «только имена» |
| Native Claude role/subagent | Whitelist Skill/MCP positive synthetic native loader transport; P11 pinned loader+official docs: required metadata name is native agentType, filename may differ, missing name skipped | Без filename fallback; ambiguous same-root identity unavailable. У роли без доказанного Skill/find_skill path полный список; ancestor/managed/CLI/plugin parity и P12 lookup adaptation остаются gates |
| Native Codex role | Auto-discovered agents/**/*.toml: обязательные `name`, непустые developer_instructions, description после layer merge. Поздняя одноимённая роль выигрывает, metadata может наследоваться | Без filename fallback. Declared config_file name-hint — другой путь, пока вне v1. Нет main-session role flag: main fields доставляются через native args+layer |
| Read-only / resume | P02 offline prompt/config positive; live HTTP 400, MCP/report/resume не состоялись | Не объявлять enforcement; роль без обеспечиваемой доставки/ограничений не запускать. Проверенный native CLI supported model выбирается отдельно от фиксированной модели агентов workflow |

Codex CLAUDE fallback — `project_doc_fallback_filenames=["CLAUDE.md"]` (filename, не directory); native AGENTS/override в каждой папке выигрывает, root→cwd накопление observed. `.claude/CLAUDE.md`, budget exhaustion и немедленное изменение resume слоя не доказаны. Обычный custom Codex без `{developerInstructions}` сохраняет documented поведение PARLEY.md §7: `provider-override-gap` warning и запуск без слоя/моста; Parley не переписывает пользовательский runner. Hard refusal до spawn применяется только когда выбранная обязательная роль/permissions требуют доставки, которую данный runner обеспечить не может; generic plain custom runner не запрещается из-за одного missing placeholder. CLI flag capability проверяется фактическим бинарником; `--no-daemon` принят 0.156.1, guard ≥0.157 по старому комментарию не обоснован.

## 5. P05: полноценные parsers и пределы

Фиксировать **точные** runtime versions без caret в core и lockfile после P04 review:

| Package | Pin / лицензия | Runtime / API |
|---|---|---|
| yaml | `2.9.1`, ISC, 0 runtime dependencies | Node >=14.6; `parseDocument`, errors, `toJS`; YAML 1.2 block/folded/quoted scalars. [Tagged package](https://raw.githubusercontent.com/eemeli/yaml/v2.9.1/package.json), [npm version](https://www.npmjs.com/package/yaml/v/2.9.1) |
| smol-toml | `1.9.0`, BSD-3-Clause, 0 runtime dependencies | Node >=18; named ESM `parse`, `stringify`; TOML multiline, tables/arrays. [Tagged package](https://raw.githubusercontent.com/squirrelchat/smol-toml/v1.9.0/package.json), [npm version](https://www.npmjs.com/package/smol-toml/v/1.9.0) |

Реальные registry JSON 2026-10-03 подтвердили versions/licenses/engines и отсутствие dependencies. Official npm tarballs SHA-512 integrity проверен, распаковка только `/private/tmp/parley-p04-parsers-oasyp3wp`. На installed Node **20.15.1** прошли 12 отдельных API cases: YAML literal+boolean/folded/quoted/duplicate/invalid/alias bound; TOML multiline basic+array+policy/literal/duplicate+invalid/unsafe key/stringify roundtrip; string `"false"` остаётся string и требует semantic validation. Это isolated library smoke, не product P05 тесты.

API использования: `parseDocument(text, {version:'1.2', strict:true, uniqueKeys:true})`, затем проверка `doc.errors` и `doc.toJS({maxAliasCount:100})`. Корневое значение — plain mapping, не scalar/array/null; иначе invalid. Не распространять exception text. Бounded aliases подтверждены [tagged YAML options](https://raw.githubusercontent.com/eemeli/yaml/v2.9.1/docs/03_options.md); ошибки документа описаны [document API](https://raw.githubusercontent.com/eemeli/yaml/v2.9.1/docs/04_documents.md).

TOML: `parse(text, {integersAsBigInt:'asNeeded', useLegacyDate:true, unsafeKeyBehaviour:'throw', maxDepth:100})`; schema projection допускает только требуемые primitive fields. Не требовать Temporal/Node 26: devEngines не runtime engines. Для generated overrides использовать `stringify` полного validated минимального объекта; каждый assignment передавать одним элементом argv. API options подтверждены [tagged parse source](https://raw.githubusercontent.com/squirrelchat/smol-toml/v1.9.0/src/parse.ts), named exports — [index](https://raw.githubusercontent.com/squirrelchat/smol-toml/v1.9.0/src/index.ts). Нет roundtrip-edit пользовательского конфига: библиотека не обещает сохранение comments/layout. Небольшие оговорки full TOML: invalid dates/UTF-8 требуют caller validation, large integers сохраняются BigInt; [tagged README](https://raw.githubusercontent.com/squirrelchat/smol-toml/v1.9.0/README.md).

**Предел относится ко всему SKILL.md: 65536 bytes inclusive.** Больший документ пропускается, даже если YAML header короткий. Read bounded max+1, strict UTF-8 decode (fatal), затем извлечь начальную header область между самостоятельными `---` строками (BOM/CRLF поддержать). После закрывающего delimiter Markdown body не разбирается/не экспортируется/не индексируется. Отсутствующий начальный header — `missing`, начальный header без closing delimiter либо invalid YAML — `invalid`, корректная mapping — `valid`; общий reader возвращает только mapping/status/safe diagnostic, не body. Loader Claude/Codex позднее сам читает исходный документ своим способом.

YAML/TOML helper общий для skill frontmatter, роли, рецепта и CLI settings/policy; caller выбирает отдельный bounded input-document ceiling (SKILL.md 65536 и bounded native role/config/settings inputs), parser не вшивает размер SKILL в любую конфигурацию. Предел role body 32768 — post-parse preprocessing текста, не лимит raw native TOML: целый bounded TOML сначала полноценно разбирается, затем developer_instructions проходит marked line truncation; прочие native fields сохраняются. Запрет частичных regex-парсеров YAML/TOML остаётся. Nullable/missing/string-bool fields не coercing: `enabled`, `disable-model-invocation`, allow_implicit_invocation — реальные booleans; description/name/developer_instructions — strings; schema ошибки никогда не расширяют доступ.

Все exceptions очищаются до кода и максимум безопасных line/column; YAML/TOML error может включать исходную строку или секрет. Raw mapping/exception/config/stdout/stderr/argv в host log или DTO не попадают; field projection whitelist. Лицензии ISC/BSD-3-Clause совместимы с MIT продукта при сохранении notices; P05 сохраняет license metadata, distribution notices проверяются при release.

## 6. P09: UTF-8, argv и окончательное окружение

Продуктовый per-argument ceiling **98304 UTF-8 bytes после TOML/JSON сериализации**, включая key `developer_instructions=`, кавычки, escaping и любые пробелы сериализатора. NUL в argv/env — invalid до spawn. Это предел Parley, не обещание ОС. Блоковые ceilings также действуют. Не считать UTF-16 JS length или исходную длину текста; использовать Buffer.byteLength(finalArg,'utf8').

Общая проверка после окончательного env merge:

```text
stringBytes = sum(utf8Bytes(argv0/executable + each final argv) + 1 NUL)
            + sum(utf8Bytes(key + '=' + finalValue) + 1 NUL)
pointerBytes = pointerSize * (argc + envc + 2)
estimatedBytes = stringBytes + pointerBytes + 32768 reserve
require estimatedBytes <= runtime ARG_MAX
```

32768 — выбранный консервативный product reserve, не измеренная точная kernel overhead. Limits injectable в тестах; query bounded getconf/sysconf, не hardcode наблюдаемый 1 MiB на Linux. Учитываются substituted executable/args, длинные paths, реальный final inherited env и generated token/env. На Linux отдельно каждую argv/env string с NUL проверять против native per-string bound `32 * pageSize`; cumulative ARG_MAX зависит от stack limit. [Linux execve reference](https://man7.org/linux/man-pages/man2/execve.2.html). Если limits недоступны, aggregate check не объявлять пройденным: safe pre-spawn diagnostic/error; нельзя guess увеличить ceiling. OS E2BIG всё равно обработать безопасно без raw argv/env.

Core P09 проверяет блоки, serialized args и placeholder delivery для обязательной роли/permissions; обычный custom Codex placeholder gap даёт warning с сохранением запуска; итоговый env известен только в `packages/host/src/sessions/sessions-service.ts` после `agentEnv(process.env)`, `plan.env` **и PARLEY_HOOK_TOKEN**. Поэтому P09 получает последовательное владение этим файлом/его тестом и необходимым export `packages/core/src/index.ts` от root. Host непосредственно перед `pty.start` проверяет aggregate. Безопасные `LaunchPlan.warnings` пишутся в host log на каждой попытке запуска; пользовательские notices дедуплицируются за жизнь хоста: PARLEY.md unreadable/truncated — по projectPath и warning code, provider-override-gap — один раз за жизнь хоста глобально по code, без per-project/per-provider повторов, как требует §7. User notice не повторяется на каждой попытке. Если guard срабатывает после register hook token, handle не стартует и token unregister выполняется; проверить отсутствие утечки. Core-only check не считается полной реализацией aggregate guard.

Переполнение optional Parley suppression: убрать **весь generated suppression**, сохранив human flags и полный native list; пересобрать/повторно проверить args+env, записать warning в log текущей попытки; user notice подавлять по указанной области (PARLEY.md: host/project; provider-override-gap: host global) после первого показа. Не обрезать selectors. Без optional flags всё ещё oversized → безопасная ошибка до spawn. Oversized обязательный layer аргумент → `session-layer-too-large` с размерами блоков; aggregate env/другие args → отдельная безопасная spawn-budget ошибка с числовыми размерами. Разрешено только documented marked preprocessing блоков; нельзя молча усекать собранный аргумент, policy/permissions или роль при отсутствии обязательного канала доставки. Одна и та же проверка для launch/quick/auto/resume.

Новая безопасная Node-проба P04: macOS Darwin 24.3.0 arm64, Node 25.8.0, getconf ARG_MAX=1048576, subprocess только Node, synthetic env без credentials. P02 отдельно подтвердил Codex native parser при argBytes=98304 и UTF-8=70025 на Node22 CLI.

| Probe P04 | argv payload bytes | env bytes с NUL | stringBytes | estimatedBytes | Результат |
|---|---|---:|---:|---:|---|
| Single 96 KiB | 98304 | 19 | 98675 | 131507 | exit 0, bytes/hash preserved |
| Cyrillic/newlines/quote/backslash | 70029 | 19 | 70400 | 103232 | exit 0, bytes/hash preserved |
| Cumulative fit | 98304 + 98304 | 262155 | 459116 | 492020 | exit 0, bytes/hash preserved |
| Cumulative overflow | 3 × 98304 | 851977 | 1147243 | 1180299 | E2BIG до child start |

Пример повторения без запуска CLI/сети:

```js
import {spawnSync} from 'node:child_process';
const prefix='developer_instructions=';
const arg=prefix+JSON.stringify('a'.repeat(98304-Buffer.byteLength(prefix)-2));
const env={PATH:'/usr/bin:/bin'};
const run=(args,env)=>spawnSync(process.execPath,['-e',
  'console.log(JSON.stringify(process.argv.slice(1).map(x=>Buffer.byteLength(x))))',
  '--',...args],{env,encoding:'utf8',timeout:5000,maxBuffer:4096});
console.log(run([arg],env)); // exit 0, [98304] на проверенной macOS
const bigEnv={...env,...Object.fromEntries(Array.from({length:26},(_,i)=>
  ['P04_'+i,'x'.repeat(32760)]))};
console.log(run([arg,arg,arg],bigEnv).error?.code); // E2BIG на проверенной macOS
```

**Linux runtime unavailable в этой сессии**: ОС tools — Darwin, Linux worker/VM не предоставлен. Формулы Linux — reference-backed, не executed. Не устанавливать Docker/VM ради P04. Target Linux (ARG_MAX/page size/stack, Node20 и final host env), macOS long canonical paths/custom provider overrides остаются явно в P32; local probe не заменяет эти gates.

## 7. Provider actions и безопасные scopes

Точные argv/fixtures F1–F12 и help-only ветви сохраняются в [P03](capabilities.md); action adapter обязан использовать эти provider-specific формы, не общую guessed команду. Ниже обязательная матрица разрешения (после executable; `s=user|project|local`).

| Действие | Claude 2.1.287 | Codex 0.156.1 |
|---|---|---|
| Installed / available | `plugin list --json` (array) / `plugin list --available --json` (object) | Те же argv, **object** installed/available; no generic array parser |
| Details | `plugin details <id>` text, installed-only; available-only exit 1. Local `--plugin-dir` отдельный inspected path | unavailable: нет details command; только list fields, cost unknown |
| Install / uninstall | `plugin install/uninstall <id> --scope <s> --json` | `plugin add/remove <id> --json`, без scope |
| Enable / disable / update | `plugin enable/disable/update <id> --scope <s> --json` | unavailable; -c listing toggle не доказал action, --enable/--disable относятся features |
| Marketplace add | `plugin marketplace add <source> --scope <s> --json` | `plugin marketplace add <source> --json`, no scope |
| Marketplace recovery | `plugin marketplace remove <name> --json` только вновь добавленный source | `plugin marketplace remove <name> --json`; upgrade Git only, positive remote unverified, не plugin update |
| MCP snapshot / details | Read-only bounded .claude.json/.mcp.json files; ordinary Refresh **не** mcp list/get (те запускают servers) | `mcp list --json` array / `mcp get <name> --json` object, только metadata |
| MCP Check | `mcp list` / `mcp get <name>` text, только explicit Check; connected/pending/disabled/failed/unknown по safe whitelist | unavailable connection Check; auth_status не Connected; native `/mcp` recovery |
| MCP stdio add | `mcp add --scope <s> <name> [-e K=V] -- <cmd> ...args` | `mcp add <name> [--env K=V] -- <cmd> ...args`, user/global only |
| MCP HTTP add | `mcp add --transport http --scope <s> <name> [--header H: V] -- <url>` | `mcp add <name> --url <url> [--bearer-token-env-var <ENV_NAME>]`; имя env, не token |
| MCP JSON | `mcp add-json --scope <s> <name> <oneServerObject>` | Нет add-json; strict convert только supported stdio/HTTP fields; headers и unsupported fields → unavailable, без потерь |
| MCP remove | `mcp remove --scope <s> <name>`, scope явный | `mcp remove <name>`, user/global only; project/local mutation unavailable |
| Plugin Check / MCP SSE | plugin Check unavailable; SSE help-only, positive transport/auth gate остаётся | plugin Check/SSE unavailable; не менять транспорт молча |

MCP server name общая product validation `[A-Za-z0-9_-]+` (это намеренно уже native Codex grammar). Project/native trust read не означает project write-scope command. Plugin/system/managed MCP не удаляется standalone remove. Remote sources/OAuth/managed denial/plugin-provided MCP schemas остаются unverified, показываются unavailable/unknown с native recovery, без прямой config записи.

Claude local MCP sharing: `projects[realpath(mainCheckout)]` в user .claude.json, даже при mutation из worktree. `.mcp.json` читается у **session cwd checkout**, а не общей копии. В P15 main identity берётся из доказанной canonical project/Git worktree identity (bounded argv queries/realpath), не из success stdout и не простой догадки dirname(.git). При unresolved/non-git/atypical identity — partial/unknown, не доказанный пустой local list. cwd/projectPath сессии сохраняются; native precedence/local approvals fixture должны проверяться отдельно.

Actions serialise per provider/project; exact scope/id и actual binary capability проверяются до dispatch. JSON schemas allow missing plugin mcpServers и неизвестные поля, но выводят только whitelist DTO. Validate exit **и** outcome; stdout success также может содержать headers/env/secret. Не логировать raw text/argv/config; errors, URLs/path/query/headers/token values редактируются одинаково. Timeout/network failure не заменяет каталог успешным пустым; сохранить прежний безопасный snapshot и retry diagnostic.

Claude uninstall может удалить persistent data (observed keptData=false); UI подтверждение обязано описывать это, reinstall не обещает restore data. Command-source shownCommand/accept-command ветка только help: никогда автоматически -y; если точная command/hash approval не реализована, путь unavailable/native UI. Rollback не удаляет existing человеческие marketplaces/config sources. После action Refresh и needs-restart для текущих сессий, где live применение не доказано.

## 8. Все строки этапа 0: evidence / fallback

| Строка unified Task 0 | Принятое evidence | Fallback / gate |
|---|---|---|
| Claude budget | P01 env1 positive, fraction0 invalid | Full native list; candidate env1 только P32 |
| Jev session-only | P01 exact module id+command hooks preserved | Unknown install id → no suppression; TUI/statusLine/product wake P32 |
| Claude role/subagent Skill/find_skill | P01 synthetic transport запускает native loader и child/MCP | Role-specific tools/permissions+real host P32; не advertise отсутствующий tool |
| Claude roots/commands/plugins | P01 listing parity local fixture, P03 actions/scopes | Synced/account/managed/ancestor/collision matrix partial; full list |
| Codex roots/config/policy | P02 offline+tagged source, full path selectors/User+SessionFlags | Human rules intact; plugins/admin parity и disabled-path live read P32 |
| Codex invalid/long override | P02 invalid parse fails; macOS 98304 success; P04 cumulative E2BIG | Не отправлять invalid optional override; full list при превышении |
| Codex layer/bridge/role/sandbox/resume | P02 debug parse/prompt positive; attempted live failed HTTP400 | Enforcement/report/resume не приняты, read-only role fail safely |
| Capabilities/actions/local MCP | P03 native CLI fixtures and scopes, canonical main sharing | Unsupported actions unavailable; auth_status не health; remote/policy P32 |
| Full argv/env/macOS/Linux | P02 CLI+P04 Node macOS evidence; Linux execve reference | Pre-spawn guard; Linux/long paths/custom env/providers P32 |

## 9. Точные согласующие правки для root

Права P04 не включают live specs/plan/queue: ниже предложения Find/Replace. Применять после независимого P04 review; исходные P00 hashes не пересчитываются под новые редакции.

1. **Unified plan, shared NativeSkill:** Find `source: 'user' | 'project' | 'plugin' | 'claude.ai';` → Replace `source: 'user' | 'project' | 'plugin' | 'claude.ai' | 'system' | 'admin' | 'extra';`. Find comment `path: string; // абсолютный путь SKILL.md или файла нативной команды Claude` → Replace `path: string; // canonical полный document path; identity = provider + canonical path`. После interface вставить: `Unknown availability is modelAvailable=false with availability-unverified; navigator filters before ranking. Codex preserves same-name documents at different canonical paths; human User/SessionFlags rules and policy apply before Parley-generated suppression.`

2. **Navigator §2.1:** Replace bullet от `- skillListingBudgetFraction: 0` (в исходнике имя в backticks) до `поэтому нужен именно бюджет;` текстом: `skillListingBudgetFraction: 0 invalid в schema Claude 2.1.287 и не сокращает список. SLASH_COMMAND_TOOL_CHAR_BUDGET=1 — проверенный candidate для небандлённых descriptions; bundled descriptions сохраняются. Production сохраняет полный список до resolver parity и live lifecycle/role gates P32.` Удалить размер ≤3 тыс. знаков как обещание, заменить measured fixture/current-machine estimate без гарантии.

3. **Navigator §2.2:** Find `Бюджета списка у Codex нет.` → Replace `В Codex 0.156.1 offline подтверждены skills.max_context_tokens и skills.include_instructions=false; второй flag version-pinned и candidate. Production full native list до resolver/live P32 gates.` Заменить `эффективными человеческими skills.config` на `упорядоченными native правилами User и SessionFlags (не project rules) с сохранением selectors/provenance`; path выключения — canonical full SKILL.md. Добавить distinct same-name file identity и отказ от winner по имени.

4. **Navigator §3.2 / unified Task1:** Find `Файл больше 64 КБ пропускается.` → Replace `Весь SKILL.md больше 65536 bytes пропускается; читается bounded max+1 и strict UTF-8. Только YAML mapping начального frontmatter идёт в metadata; missing/invalid различаются, тело не возвращается.` В root lists добавить Codex legacy project config folders, system/admin/plugin/extra source-backed roots, но availability=false/unverified до доказанного resolver; Claude commands обязательны, synced account/manifest/config не filesystem glob.

5. **Roles §4.2:** Find `Имя — codex:<name из файла или имя файла>.` (соответствующая строка с backticks) → Replace `Auto-discovered Codex TOML требует name и непустой developer_instructions; description обязателен после native layer merge. Filename fallback не поддержан. Recursive agents roots и поздний same-name winner source-backed; declared config_file name hint — отдельный поздний контракт.` После списка parsing вставить точные pins/API §5 этого файла; main role label не заменяет args/слой/sandbox и live enforcement gate.

6. **Capabilities §6.3:** Replace два bullets от `Перед установкой окно показывает состав` до `удалить, включить, выключить.` текстом: `Claude details доступен установленному id; available-only состав/стоимость unknown (local --plugin-dir — отдельный подтверждённый reader). Codex list installed/available есть; install/uninstall используют add/remove без scope. Codex details/enable/disable/update unavailable в CLI v1. Claude mutations требуют user/project/local scope; persistent data deletion явно показывается.` В MCP разделе добавить canonical-main local identity, cwd checkout .mcp.json, Claude Check explicit и Codex auth_status!=Connected; raw success stdout также редактируется.

7. **Unified Task0 budget row:** Find `Claude budget: skillListingBudgetFraction: 0 / env budget=1` (backticks в исходнике) → Replace `Claude budget: env budget=1 candidate; fraction=0 invalid`. **Unified Task5 step4:** Replace общий plugin-actions список на provider-specific матрицу §7, запрещая guessed Codex toggle/details/update.

8. **Unified shared argv paragraph / PARLEY.md §3.3:** После per-arg ceiling вставить aggregate формулу §6 с host проверкой после final env+hook token, NUL/per-string bounds, injectable runtime limits, safe failure, host-log warnings per attempt и user-notice dedup: PARLEY.md once host/project, provider-override-gap once host global. Сохранить documented marked PARLEY.md/role/playbook preprocessing ≤32768 bytes включая marker (PARLEY.md §5.2, Roles §5.2/§8, Recipes §6.3) и plain custom Codex warning+launch §7; отказ только при недоставимой обязательной роли/permissions. **P09 ownership root:** добавить `packages/host/src/sessions/sessions-service.ts`, `packages/host/src/sessions/sessions-service.test.ts` и необходимый export `packages/core/src/index.ts`; P10 получает их позже последовательно. Не утверждать full env guard по core-only tests.

9. **P05 parser acceptance root:** pins из §5; tests valid/invalid/missing header, whole-file limit, strict UTF-8/duplicate keys/bounded aliases, full multiline description, mapping/schema boolean/string validation, safe code+position diagnostics. Native parser errors never log source excerpts. Роль/recipe/settings переиспользуют те же generic parsers; не четыре локальных regex-парсера.

## 10. Оставшиеся gates и сдача

P05–P09 можно реализовать по этому контракту после independent acceptance P04; их тесты должны подтвердить implementation, не пересказать research. Не заявлять release/list-reduction readiness.

P32 отдельно: реальные Claude account/synced/managed/plugin priority/collision/symlink boundary fixtures; clean main/subagent native loader для доступных role tools; интерактивный statusLine и настоящий Parley MCP report/end-turn/notify/wake; Codex live supported native model, чтение Parley-disabled document при сохранении human disables, denied write без elevation, role/main args, launch/resume/compaction boundary; native plugin/admin/extra parity; managed denial/remote install/OAuth/restart; host cumulative guard на macOS long paths/custom env/provider substitution и target Linux (без искусственного требования Docker); approved role texts/distribution notices. У каждого непроверенного пути до этого full-list/unavailable/fail-safe behavior, а не silently assumed success.

## 11. Воспроизведение API и argv evidence

Первоначально оба скрипта выполнялись через stdin. Для независимого review их точные тела сохранены как `/private/tmp/parley-p04-api-smoke.mjs` и `/private/tmp/parley-p04-argv-probe.mjs`; ниже долговечные копии. Node20 executable этой машины: `/Users/kalmbik61/.nvm/versions/node/v20.15.1/bin/node`. Распакованные verified modules: `/private/tmp/parley-p04-parsers-oasyp3wp/yaml/package/dist/index.js` и `/private/tmp/parley-p04-parsers-oasyp3wp/smol-toml/package/dist/index.js`.

```sh
/Users/kalmbik61/.nvm/versions/node/v20.15.1/bin/node /private/tmp/parley-p04-api-smoke.mjs
node /private/tmp/parley-p04-argv-probe.mjs
```

Ожидается API `passed:12`, exit 0; argv: три положительные строки и `E2BIG` на cumulative overflow. Исходный argv runtime — Node25.8.0/macOS arm64. Exact stringBytes зависят от executable path; на другой машине сравнивать byte preservation/outcome и собственный runtime ARG_MAX, не копировать macOS числа на Linux. Для portable повтора сохранить тела в любые .mjs, указать installed Node20 и заменить только два module paths на локально распакованные official tarballs pinned versions; package-manager install и CLI/model запуск не требуются.

API smoke (исходные 12 cases):

```js
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parse as tomlParse,stringify} from '/private/tmp/parley-p04-parsers-oasyp3wp/smol-toml/package/dist/index.js';
const require=createRequire(import.meta.url);
const {parseDocument}=require('/private/tmp/parley-p04-parsers-oasyp3wp/yaml/package/dist/index.js');
const yaml=s=>{const d=parseDocument(s,{version:'1.2',strict:true,uniqueKeys:true});if(d.errors.length)throw Error('invalid-yaml');return d.toJS({maxAliasCount:100});};
const opts={integersAsBigInt:'asNeeded',useLegacyDate:true,unsafeKeyBehaviour:'throw',maxDepth:100};
const cases=[];
let y=yaml('name: example\ndescription: |\n  first line\n  second "quoted" line\ndisable-model-invocation: false\n');
assert.equal(y.description,'first line\nsecond "quoted" line\n');assert.equal(y['disable-model-invocation'],false);cases.push('yaml-literal-and-boolean');
assert.equal(yaml('description: >\n  first\n  second\n').description,'first second\n');cases.push('yaml-folded');
assert.equal(yaml('description: "quote \\" slash \\\\"\n').description,'quote " slash \\');cases.push('yaml-quoted');
assert.throws(()=>yaml('a: 1\na: 2\n'));cases.push('yaml-duplicate-rejected');
assert.throws(()=>yaml('a: [\n'));cases.push('yaml-invalid-rejected');
assert.throws(()=>yaml('a: &a [1, 2]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n'));cases.push('yaml-alias-expansion-bounded');
let t=tomlParse('name="role"\ndeveloper_instructions="""\nfirst\nquote \\" and Unicode Ж\n"""\n[[skills.config]]\npath="/tmp/full/SKILL.md"\nenabled=false\n[policy]\nallow_implicit_invocation=false\n',opts);
assert.equal(t.developer_instructions,'first\nquote " and Unicode Ж\n');assert.equal(t.skills.config[0].enabled,false);assert.equal(t.policy.allow_implicit_invocation,false);cases.push('toml-multiline-array-policy');
assert.equal(tomlParse("developer_instructions='''\nfirst\nsecond\n'''\n",opts).developer_instructions,'first\nsecond\n');cases.push('toml-literal-multiline');
assert.throws(()=>tomlParse('a=1\na=2\n',opts));assert.throws(()=>tomlParse('a=[\n',opts));cases.push('toml-invalid-and-duplicate-rejected');
assert.throws(()=>tomlParse('__proto__.x=1\n',opts));cases.push('toml-unsafe-key-rejected');
const value='quote " slash \\ newline\nЖ';assert.equal(tomlParse(stringify({developer_instructions:value}),opts).developer_instructions,value);cases.push('toml-serialization-roundtrip');
assert.equal(tomlParse('enabled="false"\n',opts).enabled,'false');cases.push('semantic-validation-required');
console.log(JSON.stringify({node:process.version,yaml:'2.9.1',toml:'1.9.0',passed:cases.length,cases},null,2));
```

macOS argv/env probe (исходное тело):

```js
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
const bytes=s=>Buffer.byteLength(s,'utf8');
const prefix='developer_instructions=';
const serialize=s=>prefix+JSON.stringify(s);
const argMax=Number(spawnSync('/usr/bin/getconf',['ARG_MAX'],{encoding:'utf8'}).stdout.trim());
const code="const a=process.argv.slice(1); console.log(JSON.stringify({bytes:a.map(x=>Buffer.byteLength(x)),valid:a.every(x=>{try{return typeof JSON.parse(x.slice('developer_instructions='.length))==='string'}catch{return false}}),sha:require('node:crypto').createHash('sha256').update(a.join('')).digest('hex')}))";
const fits=serialize('a'.repeat(98304-bytes(prefix)-2));
const unicode=serialize('Ж'.repeat(20000)+'\n'.repeat(15000)+'"\\');
const baseEnv={PATH:'/usr/bin:/bin'};
const envN=n=>Object.fromEntries([...Object.entries(baseEnv),...Array.from({length:n},(_,i)=>['P04_'+i,'x'.repeat(32760)])]);
const run=(kind,args,env)=>{
 const argv=[process.execPath,'-e',code,'--',...args];
 const strings=argv.reduce((n,s)=>n+bytes(s)+1,0)+Object.entries(env).reduce((n,[k,v])=>n+bytes(k+'='+v)+1,0);
 const estimated=strings+8*(argv.length+Object.keys(env).length+2)+32768;
 const r=spawnSync(process.execPath,argv.slice(1),{env,encoding:'utf8',timeout:5000,maxBuffer:4096});
 const expected=createHash('sha256').update(args.join('')).digest('hex');
 const decoded=r.status===0?JSON.parse(r.stdout):null;
 return {kind,argBytes:args.map(bytes),envBytes:Object.entries(env).reduce((n,[k,v])=>n+bytes(k+'='+v)+1,0),stringBytes:strings,estimatedBytes:estimated,status:r.status,error:r.error?.code??null,valid:decoded?.valid??null,bytesPreserved:decoded?JSON.stringify(decoded.bytes)===JSON.stringify(args.map(bytes))&&decoded.sha===expected:null};
};
const results=[run('arg96KiB',[fits],baseEnv),run('utf8-escaping',[unicode],baseEnv),run('argv-env-fit',[fits,fits],envN(8)),run('argv-env-overflow',[fits,fits,fits],envN(26))];
console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,os:os.release(),argMax,results},null,2));
if(results[0].status!==0||!results[0].bytesPreserved||results[1].status!==0||!results[1].bytesPreserved||results[2].status!==0||results[3].error!=='E2BIG')process.exitCode=1;
```

## P11 source amendment — 2026-10-03

Claude local role identity — exact required frontmatter name (metadata-only name/description), not filename. Pinned 2.1.287 Vjn/T6 и [official frontmatter contract](https://code.claude.com/docs/en/sub-agents#frontmatter-reference) подтверждают lookup. Same-root duplicates имеют native read-order ambiguity: no invented lexical winner. Codex role scalar normalization — Rust Unicode White_Space edge trim, no internal collapse; FEFF retained, name never used as filesystem path. Existing filename-only assertAgent must be adapted in P12. Native effective layer/trust/requirements reader remains required for Codex role selection; raw user+cwd TOML alone is not evidence of a complete stack.
