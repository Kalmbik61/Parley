# Parley — журнал выполнения workflow

Дата запуска: 2026-10-03.

- Workflow: superpowers:subagent-driven-development, встроенные агенты Codex App.
- Исполнители и независимые проверяющие: gpt-6.1-sol, reasoning_effort=high.
- Worktree: /Users/kalmbik61/.codex/worktrees/parley-upgrade/my_harnas.
- Ветка: codex/parley-upgrade.
- Исходная кодовая база: master, 72a87361d8073c011e60f31e5d254f1045ff086b.
- Документация: snapshot из worktree docs/parley-md; исходные файлы не изменялись.
- План: [единый план](2026-10-03-parley-unified-implementation-plan.md).
- Задачи: [очередь агентов](2026-10-03-parley-agent-tasks.md).
- Переход к зависимой задаче — после независимого ревью и проверки результата.
- Документационный стартовый коммит: 1acc937.
- Текущая фаза: P00–P18, P20/P21/P22/P23/P29/P39 accepted (25/40); P19/P24/P27 running.
- Установка зависимостей: `pnpm install --frozen-lockfile`, exit 0; lockfile сохранён.
- Базовая сборка: `pnpm --filter '@parley/host...' build`, exit 0 (core, protocol, host).
- Базовые проверки: `pnpm --filter @parley/core exec vitest run src/capabilities src/work/launch.test.ts src/work/guidance.test.ts` — 5 файлов, 132 теста passed.
- P00: независимая проверка /root/p00_review приняла коммит `9aedc3e`, замечаний нет; сохранность исходных checkout и snapshot подтверждена повторно.

| ID | Задача | Статус | Evidence |
|---|---|---|---|
| P00 | Подготовить актуальную рабочую базу | done | agent /root/p00_prepare_base; model gpt-6.1-sol/high; commit 9aedc3e; review accepted by /root/p00_review |
| P01 | Проверить Claude: источники, budget, jev и инструменты | done | agent /root/p01_claude_probe; gpt-6.1-sol/high; commit 09eda36; review accepted by /root/p01_review; native full-list fallback |
| P02 | Проверить Codex: скиллы, слой, роли и resume | done | agent /root/p02_codex_probe; gpt-6.1-sol/high; commit ce3efc1; review accepted by /root/p00_review; native live gates remain |
| P03 | Проверить команды Capabilities и scopes | done | agent /root/p03_capabilities_probe; gpt-6.1-sol/high; commit 5debed1; review accepted by /root/p03_review; unsupported actions unavailable |
| P04 | Закрыть контракты разведки и выбор парсеров | done | /root/p00_prepare_base reassigned P04; gpt-6.1-sol/high; commits 8a71358/e4e61cc; reviewer /root/p01_review accepted |
| P05 | Реализовать общие типы и YAML/TOML-разборщики | done | /root/p01_claude_probe reassigned P05; gpt-6.1-sol/high; commits 5e95a38/eb24192; reviewer /root/p00_review accepted; 31 tests passed |
| P06 | Реализовать источники скиллов Claude | done | 4792cb1/7c91a36; reviewer /root/p01_review accepted, 25 targeted + direct probes |
| P07 | Реализовать источники скиллов Codex | done | a0c8f2c/e15a367; reviewer /root/p01_review accepted, 7 targeted + direct probe |
| P08 | Собрать каталог, BM25 и перевести chat-view на него | done | d5f3251/0caf683; independent42 +3 probes +15scan; reviewer /root/p01_claude_probe accepted |
| P09 | Собрать слой сессии и доставку Codex | done | c2ccbbd; reviewer /root/p03_review accepted; 225 core / 52 host, builds; targeted DEL/consumer fixes passed |
| P10 | Подключить создание PARLEY.md и Open/Create | done | 733ab7d/e20d5b7/72b3edb; independent final recheck accepted, 19 core repeated |
| P11 | Реализовать каталог ролей и умолчания | done | 83ac8fc/4c2fb30; independent 14 targeted +6 probes, reviewer /root/p01_review accepted |
| P12 | Подключить роли к запуску, MCP и диалогу | done | fd3654e; Important fixed; independent44+9probes accepted, exact39files matched |
| P13 | Реализовать find_skill и настройку MCP | done | f3394ae; independent341core/62host/8controls,25SHA/blob; /root/p01_review accepted |
| P14 | Подключить навигатор к CLI и Settings | done | baf9af9 + a9c1e14; independent symlink probes GREEN, 33 settings fixtures, SHA2/core build0; /root/p01_claude_probe accepted |
| P15 | Реализовать безопасный снимок Capabilities | done | d4278ce/20cf256/eef8425; independent fixes accepted; full33 tests/types/lint |
| P16 | Создать единую панель проекта и вкладку Capabilities | done | b7589f7; independent165checks accepted;17SHA matched; visual gate P32 |
| P17 | Добавить native действия MCP | done | f447ccd +0c0d1f9, /root/p01_review accepted; original/related probes GREEN,43affected/lint/SHA4/hostbuild0; live/P32 pending |
| P18 | Добавить native действия плагинов | done | c917f45 backend/DTO, a4abc3f UI; independent /root/p02_codex_probe accepted; native live gate P32 |
| P19 | Добавить передачу скилла второму CLI | running | /root/p02_codex_probe; TMP foundation first, shared integration locked |
| P20 | Реализовать shared/local state и домен бэклога | done | 4391680; exact14SHA; author181checks; independent fixes/probes accepted /root/p01_review |
| P21 | Подключить бэклог к MCP, host и панели | done | fb2784f; /root/p01_review accepted after4-file UIrework;38SHA/blob +registry,162MCP/build/types0 |
| P22 | Реализовать режимы, планы, ревизии и снимки | done | cec588d; independent /root/p01_claude_probe accepted;168fixtures +4probes/lint/types,11SHA,coherentbuild0 |
| P23 | Подключить инструменты планов и будильник | done | 6a3635f helper + b511fda integration21; correction peer9/root lifecycle peer19, actual257GREEN |
| P24 | Показать план и итог в комнате | running | /root/p01_claude_probe; TMP UI, existing bridge/DTO, serial strings |
| P25 | Реализовать рецепты и плейбук ведущего | pending | — |
| P26 | Подключить рецепты к диалогу и Save as recipe | pending | — |
| P27 | Реализовать журнал принятых версий и историю | running | /root/p01_review; TMP immutable journal/local history foundation |
| P28 | Подключить Decisions и Share history | pending | — |
| P29 | Реализовать память проекта и её слой | done | 127367e; /root/p01_claude_probe accepted; original Unicode9 GREEN,54affected/probes,16exact staged SHA,corebuild0 |
| P30 | Реализовать search_history по записям проекта | pending | — |
| P31 | Подключить память, поиск и UI | pending | — |
| P32 | Провести сквозную проверку и сравнение навигатора | pending | — |
| P33 | Обновить документацию по фактическому результату | pending | — |
| P34 | Ограничить bootstrap и повторение контекста | pending | audit-token track; dependencies P25, P29 |
| P35 | Ввести компактные map/snapshots и страницы | pending | audit-token track; dependencies P27, P31 |
| P36 | Исправить свежесть usage и cache ledger | pending | audit-token track; dependencies P24 |
| P37 | Ограничить launches/fanout и лишний старт | pending | audit-token track; dependencies P23, P26 |
| P38 | Подготовить benchmark принятого результата | pending | audit-token track; dependencies P34, P35, P36, P37, P14, P31, P39 |
| P39 | Доставлять внутренний навык minimal-development | done | 50a878f; author /root/p01_claude_probe; independent /root/p01_review accepted; 84core/17host, ownership/failure probes, builds0 |

## Текущая разведка — ещё до независимой приёмки

- P01: Claude 2.1.287; settings schema отклоняет `skillListingBudgetFraction: 0`; env budget=1 требует проверки. До подтверждения — полный нативный список.
- P02: Codex 0.156.1; `debug prompt-input` подтверждает `developer_instructions`, CLAUDE fallback и read-only; `--no-daemon` принят текущим CLI. Нативные дубликаты имён скиллов сохраняются. Это не evidence живого launch/resume/MCP.
- P03: Claude plugin details только для установленного/plugin-dir, text output; Codex plugin add/remove и list, без enable/disable/update/details. Codex MCP list не health-check. Local MCP Claude привязан к canonical main checkout и виден в worktree.
- Итоговые доказательства и запасные пути будут приняты отдельным review P01–P03, затем закреплены в P04. Неподтверждённые флаги не разрешены для реализации.

## Назначение агентов после первой волны

Лимит созданных agent threads достигнут при запросе reviewer P02. Свободные агенты той же модели переиспользуются с новым bounded назначением; автор результата и независимый reviewer остаются разными. Не создаём другую модель или фоновые runtime-состояния. P01 принят review без замечаний; оставшиеся native release gates сохраняются.

## Подготовка следующей волны (код ещё не изменён)

- Read-only P05: общий YAML/TOML mapping parser, whole-file SKILL.md 65 536-byte limit, boolean availability с явной reason; старый capabilities parser мигрирует в P08.
- Read-only P09: один layer builder для systemPrompt/developerInstructions/quiet; окончательный env известен только в host. Для complete guard выданы P09 host sessions-service.ts/test и единственный необходимый core export; P10 получает их последовательно.
- P04 проверяет pins `yaml 2.9.1` / `smol-toml 1.9.0`; выбор вступает в силу после независимого review.

## Незакрытые release gates (не блокируют базовую реализацию)

| Область | Фактический статус | Безопасный путь до приёмки |
|---|---|---|
| Claude listing reduction | loader/roles проверены synthetic transport; account/synced/policy и host lifecycle неполны | native full list, navigator default false |
| Codex listing reduction | offline config подтверждён; live turn failed | native full list; не добавлять временные disables/include_instructions |
| Native runtime | debug не доказывает model read, enforcement, resume, report | P32 smoke на configured supported CLI model |
| Hook lifecycle | synthetic command hooks подтверждены; statusLine/report/wake не приняты | сохранить функциональные hooks; не выключать их все |
| Linux argv/env | macOS Node probes пройдены; Linux runtime отсутствует | pre-spawn guards; Linux проверка остаётся P32 |
| Remote/managed Capabilities | изолированные local fixtures пройдены, remote/OAuth/managed unverified | unsupported actions unavailable, structured safe fields only |

P04 review: root передал на независимую проверку три расхождения формулировок: PARLEY.md marked preprocessing truncation, custom runner override-gap warning, once-per-host/project notices. До уточнения контрактов P05/P09 остаются pending.

## Начало реализации

P04 accepted после fix `e4e61cc`. P05 и P09 реализуются параллельно в непересекающихся файлах. P05 — единственный writer package/lockfile; P09 — единственный writer launch/provider/host/index. Общие builds/host tests выполняются после готовности обоих patch/dependencies; целевые тесты независимы. /root/p03_capabilities_probe переносит принятые P04 контракты в пять спек и unified plan; не пишет код или tracker.

P05: exact dependencies установлены (`yaml 2.9.1`, `smol-toml 1.9.0`), pnpm exit 0; целевые P09 tests больше не ждут install. P09 дополнительно получил только NoticeKind union в protocol/types.ts для существующего host notice канала; wire DTO/event contract сохранён, UI/e2e acceptance остаётся P10.

P05 implementation ready: bounded strict UTF-8 readers и общие full YAML/TOML parsers; 30 целевых тестов passed, ESLint/isolated tsc passed. Передано /root/p00_review; общий core build пока не является результатом P05, ожидает завершения P09 patch.

P05 code review needs rework: один Important finding — FIFO SKILL.md блокирует open до stat. Исправление общего reader и regression test назначены автору; P06/P07 не открыты.

P04 docs-integration (unified plan + пять спек) передана /root/p01_review. P09 сообщил 18 processor/guard tests passed; общий целевой core batch и host-патч ещё выполняются, задача не принята.

P05 принят повторным review после FIFO fix `eb24192`: 31/31 независимо повторены, замечаний нет. P09 core targeted batch — 5 файлов/220 tests passed; dependency build и целевые host tests запускает его автор, root не повторяет их без новой причины. P06/P07 откроются после текущей общей build-точки. P04 docs review потребовал две targeted поправки (plugin skillOverrides exception и запрет arbitrary CLI excerpts), автор исправляет.

P04 docs-integration accepted /root/p01_review после fix `1c8282d` к `081f3ea`: оба Important закрыты, 35 links/anchors корректны, whitespace clean. Unified plan и пять спек теперь содержат approved research contracts; остальные две спеки сохраняют ранее согласованные rev/state/privacy контракты.

P09 build/targeted verification: core/protocol/host builds, 225 core tests, 52 host tests, scoped lint passed. Root desktop typecheck нашёл TS2739 NoticeKind mapping; исправлены пять detail strings и существующий strings test consumer. Reviewer подтвердил DEL raw TOML ошибку: исправлено escaping + настоящий TOML roundtrip/escaped byte boundary. После fixes: desktop typecheck passed, 72 strings tests и 11 session-layer tests passed. Snapshot передан reviewer; native UI/real CLI/Linux execution не объявлены принятыми.

P09 snapshot `c2ccbbd` accepted /root/p03_review: нет оставшихся findings; независимо подтверждены TOML control roundtrip/encoded ceiling, 38 noticeText tests и oversized custom Claude pre-spawn. P06/P07/P10 запущены с базы c2ccbbd; disjoint ownership skills/claude, skills/codex и PARLEY host/desktop соответственно. P10 общий export/wire/registry получает только после явного назначения ведущим.

P10 выданы минимальные integration points: core exports, единственный NoticeKind, bridge typed IPC, English labels/mapping, App created-notice Open action и IPC allowlist tests. Host registry/wire methods не расширяются; остальные workers не пишут эти файлы.

P10 transaction clarification approved: reserve receipt before wx creation; failed initial receipt means no file, creation failure rolls back only owned reservation, failed final update retains receipt. Spec согласована; поведенческая приёмка этого пути ещё ожидает P10 tests/review. Второй marker не добавляется.

P07 готов: 30/30 fixtures и scoped tsc passed, owned diff только codex.ts/test. P06 — 32 fixtures green, final scoped checks ещё выполняются. P10 общий core/protocol/host/desktop build exit 0 на compile-ready source snapshots; fake-bridge.ts выдан только как обязательный typed consumer. Это ещё не acceptance P06/P07/P10.

P06 snapshot готов: 32/32 fixtures, scoped ESLint/strict production tsc passed. Verified source/native context API описан caller-facing; unknown availability closed. Только claude.ts/test, без shared mutations. P07 snapshot `a0c8f2c` проверяет /root/p01_review.

P06 snapshot `4792cb1` сохранён. Выдача /root/p00_review отклонена платформой: `agent thread limit reached`; /root/p01_review проверит P06 после P07, независимость от автора сохранена. Свободный существующий исполнитель /root/p01_claude_probe получил P11 (P05/P09 accepted), только roles modules/tests без shared mutations.

P07 review /root/p01_review needs rework: native whitespace collapse перед human name selectors не реализовано, две no-control-regex lint errors. Fix выдан доступному независимому от reviewer исполнителю /root/p02_codex_probe, только codex.ts/test. P10 готов: 16 owned files, core 15 / host 57 / desktop 149 / Electron e2e 4 passed, builds/typecheck/lint passed; промежуточный watcher timeout с successful isolated/full reruns. Receipt TOCTOU disclosed для review, отдельный lock не добавлен.

P10 snapshot `733ab7d` проверяет /root/p01_review. P06 review needs rework: local reserved account names неправомерно доступны; исходный author исправляет source-aware guard до возврата к P11. P07 bounded fixes готовы: 37 tests + scoped lint/types/diff check; native source подтвердил SKILL whitespace collapse и human selector edge trim без internal collapse. Отдельный snapshot/recheck, не acceptance.

P06 fix готов: 46 fixtures/lint/strict tsc passed, source-aware reserved native names; snapshot/recheck queued. P10 review воспроизвёл реальную receipt cleanup race. Выбран minimal conservative fix без lock: сохранить reservation при ошибке файла, auto retry только при неудачной начальной записи receipt, явный Create остаётся. Spec уточнена, core helper/test fix выполняет исходный автор. P08 пока только read-only preflight; implementation ждёт P06/P07 accepted.

P06 `7c91a36` и P07 `e15a367` accepted повторным /root/p01_review: исходные defects закрыты, targeted independent tests/probes + lint/diff и snapshot blobs сверены. P10 conservative fix готов: no receipt unlink после write failure; 18 tests/lint/strict types passed; новые race/failure tests RED→GREEN. Shared build не повторён без новой consumer mutation. P08 dependencies теперь приняты.

P10 repeat review: actual cleanup race закрыта; дополнительный ENOSPC после успешного receipt open подавляет retry, что не совпало с широкой prose policy. Spec теперь точно различает failure ДО exclusive open и ПОСЛЕ reservation/body failure; автор добавляет realistic fixture, production unlink не возвращаем. P11 ready: 9 roles files, 30 role +4 English guards/lint/strict types passed; stable snapshot/review следующим.

P11 snapshot `83ac8fc` проверяет /root/p01_review. P10 ENOSPC test ready: real wx open with injected write failure; 19 core tests/lint/strict types passed, production unchanged. Final recheck передан независимому /root/p01_claude_probe; исходная race уже закрыта review /root/p01_review.

P10 ENOSPC snapshot `72b3edb` проверяет /root/p01_claude_probe, P11 `83ac8fc` — /root/p01_review. P08 получает approved minimal documentKind internal contract + sole writer source output/types/index; human chat inventory adapter сохраняет wire, automatic search фильтрует modelAvailable. План/nav spec/contracts согласованы; source discovery behavior не расширяется.

P10 final accepted /root/p01_claude_probe, 19 core tests independently repeated; ENOSPC policy/test и original race fixes закрыты. P11 independent review /root/p01_review выявил два Important native mismatches. Approved source amendment: Claude required metadata identity/no filename fallback/ambiguous same-root unavailable; Codex Rust Unicode edge trim без extra filesystem-name policy. Spec/unified/contracts согласованы; author исправляет readers/tests. P12 effective-config reader obligation остаётся explicit.

P11 fixes готовы: только4readers/tests, 43role+4English/lint/strict types passed, 15regressions RED→GREEN. P08 final targeted158/lint/types passed; согласованная core→protocol→host build exit0. P08 consumer/wire/desktop checks ещё выполняются, broad release gates не принимаются. /root/p01_review выполняет read-only P12 effective native context preflight, затем P11 recheck.

P08 готов:14owned files, 158 core /3host /2wire /22desktop consumers, lint/strict types/diff/builds/desktop typecheck passed. Native correction user skill precedence и installed plugin source evidence сохранили wire shapes; actual command SKILL.md locator tested. Независимый reviewer /root/p01_claude_probe читает только новые P08 changes; исходный автор P08 другой. P11 fix snapshot `4c2fb30` ожидает отдельный /root/p01_review recheck после native context preflight.

## P12 native context preflight

/root/p01_review подтвердил config/read includeLayers и configRequirements/read на изолированных offline fixtures Codex 0.156.1. Parsed layers high→low, project trust disabledReason и SessionFlags проверены; named-profile API отсутствует, nonempty managed requirements не проверены. Whitelist projection и ограничения записаны в research/codex.md §8. P11 recheck запущен отдельно; P12 implementation ожидает его приёмку, /root/p02_codex_probe пока готовит read-only integration grants.

## Приёмка P11 и исправление P08

P11 fixes accepted /root/p01_review: native metadata identity, same-root ambiguity и Rust whitespace подтверждены независимыми fixtures/probes. P08 review нашёл Important/P2: relative configDir расходится между common skill resolver и legacy agent scanner. /root/p02_codex_probe получил только scan.ts/scan.test.ts для исправления и RED→GREEN fixture; P12 preparation пока read-only.

## P15 DTO amendment перед реализацией

Root согласовал с P15 preflight presence arrays вместо singular Presence, stable canonical identities, enabled:boolean|null и полный native scope union. Это сохраняет accepted Codex same-name inventory и unknown policy; spec/unified обновлены вместе. P15 code ещё ждёт P08 acceptance и последовательные shared grants с P12.

## Выдача P12 и P08 recheck

P08 path fix snapshot 0caf683 (+35/−2, только scan/test) передан /root/p01_claude_probe для повторения независимого RED fixture. P12 dependencies P11/P10 accepted, назначен /root/p02_codex_probe на owned core/host/UI и минимальные согласованные grants. Protocol temporarily locked под предстоящий P15 DTO-first этап; registry root. Новые human permission features не вводятся.

## Приёмка P08 и выдача P15

P08 fix accepted /root/p01_claude_probe: original relative config regression, numeric BM25 и canonical alias/parent-root/containment/missing-context probes green; 15 scanner fixtures/lint/strict types/diff passed. P15 назначен тому же агенту как исполнителю нового независимого домена; P12 author другой. Protocol P15 DTO-first sole writer, затем root unlock P12.

P12 source preflight уточнил exact AgentsToml tuning whitelist и lossy requirements projection. Поддержан только обязательный requirements:null response; любой non-null, даже all-null fields, context-unverified. Evidence передано author и записано в research/codex.md. P15 scope|null согласован для native sources без подтверждённого scope; spec обновлена.

P15 DTO-first frozen: новый protocol/capability-snapshot.ts/test + methods/events/index safe get/refresh/changed. Presence arrays/nullable scope+enabled/document locators/semantic boundaries; 15 targeted tests и прежняя полная protocol95, scoped lint/strict types/diff green. Root сохраняет отдельный wire snapshot; это не P15 acceptance. Автор продолжает owned host readers; P12 получает protocol после unlock.

## Действующий protocol unlock P12

P15 wire snapshot d4278ce сохранён и protocol build прошёл; root передал единственное право role-specific protocol/methods.ts/types.ts/index.ts/test агенту /root/p02_codex_probe. Независимый P15 wire precheck accepted (15 fixtures, 7 nested rejection probes, 2 strict request checks). Auto-review отклонил одну следующую P12 multi-file запись, сочтя protocol locked/root-owned; из той попытки изменений нет. Root уточнил concrete granted paths в P12 card. P15 host files и host/methods/index.ts не входят в запись. Author может повторить authorized change с этой evidence, сохраняя safe DTO.

## Интеграция P12 ведущим после auto-review отказа субагенту

Второй agent write отклонён: auto-review посчитал передачу authorization недоверенным assistant context и предложил root integration under trusted user context. Автор не обходил отказ и не менял blocked files; подготовил reviewable unified patch /private/tmp/parley-p12-integration.patch и SHA256 исходных12файлов. Root прочёл полный diff, проверил exact granted scope и hashes; root apply с прямым user request прошёл auto-review. Затем root зарегистрировал roles.list; P15 get/refresh registry тоже интегрирован ведущим. Запись разблокирована через предложенную безопасную альтернативу; human повторное разрешение не потребовалось. Проверки и независимая приёмка P12/P15 ещё впереди.

## P12 финальные уточнения и P15 full review

Root применил проверенные по exact scope и SHA256 patches P12: inline security overrides/read-only revision refresh, empty-string legacy omission с exact-null clearing, native unsupported-config отказ до existing fallback. Core production заморожен, новая core build exit 0; потребительские проверки выполняет автор. P15 host snapshot 20cf256 сохранён отдельно от P12 registry additions; wire d4278ce. 30 host/96 protocol tests и scoped types/lint passed, полная независимая проверка /root/p01_review запущена. /root/p01_claude_probe делает P16 read-only preflight до acceptance.

P15 full review needs rework: два Important — encoded credential fragment и ambient GIT_DIR cross-project scope. Исправляет исходный author в redact/snapshot +tests; /root/p01_review проверяет замороженный P12 параллельно. P12 consumer results: protocol42, MCP+agents189, host69, desktop239; CLI suite пока runner-environment Corepack error до исполнения product. Integrity bypass не используется, production source не меняется из-за среды.

P15 fixes accepted independently, aggregate d4278ce/20cf256/eef8425; P16 dispatched with sole writer grants. P12 CLI runner environment restored without integrity bypass,22/22 passed. P12 independent Important delivery pairing reproduced with positional sandbox; author fixes conservative supported template grammar on both start/resume. Plain custom compatibility and Claude-like GLM builtin text channel retained.

P12 snapshot fd3654e accepted independently /root/p01_review;44 regressions/9probes and exact39files matched, rootcorebuild0. P13 prerequisites accepted, author preparing narrow nativecontext/cache/singleflagsnapshot integration; writes await concrete grants. P16sharedstrings unlocked solewriter aftersnapshot. Native runtime gates P32 remain explicit.

P13 implementation dispatched after P12acceptance, no protocol/UI mutations. Bound local participant context, human policy provenance, Promise cache, single launch/MCP flag snapshot; неизвестный Claude Tool route остаётся unavailable. P17 read-only preflight требует private selector registry для presence IDs и global per-provider queue; actualactions gatedP16acceptance, no new native calls.

P16 snapshot b7589f7 передан independentreview; автор готовит P17 только read-only до acceptance. P13 получил narrow single-pass nativeEvidence Codex reader grant вместо повторных per-document root scans; source/policy boundaries сохранены.

P16accepted /root/p01_review;165 independent checks and17frozenfiles matched. P17 dispatched DTO-first; later host/UI with private selector/source proof/global queue. P13foundation exact4patch rootapplied SHA/absence matched, fixtures proceed; participant stamp is existing launch.ts:startSession after updateMap. New shared readCodexNativeContext export coordinated for P17, transport has one writer.

P17 DTO milestone 6ba002b accepted precheck /root/p01_review: 43 targeted tests и 31 independent probes, scoped lint/diff и 6 SHA совпадают. Protocol build и stable core transport build exit 0; author перешёл к host/UI. P13 получил узкий host caller grant для передачи actual LaunchPlan revision в startSession, без новых полей map и изменений P12. Descriptor/integration готовятся единым проверяемым patch, full acceptance обеих задач впереди.

P13 root integration: descriptor, chosen-template policy projection, single launch/MCP flag и actual revision forwarding применены четырьмя прочитанными artifacts; exact 8-file scope и исходные SHA/absence совпали. Optional startSession revision уточнён до application; fail-safe native context и closed PID-null fixtures проверяет author. P17 DTO остаётся frozen; Claude positive policy route исследуется отдельно, unknown не повышается до verified по одному файлу.

P17 Claude preflight завершён /root/p01_review: native Add guard подтверждён до scope write, universal get_settings policy proof отклонён из-за lower admin tiers/managed-mcp.json. Contract/spec/план согласованы action-specific ownership/policy/health; narrow private reader/context grant выдан author, binary identity/version повторно проверяется. Real config/model calls не выполнялись; это не full P17 acceptance.

P17 publisher evidence: primary installer/manifest read-only fetch подтвердил exact SHA/size installed source-audited Claude2.1.287 darwin-arm64. Local platform signature check failed; independent reviewer перепроверяет publisher artifact match, sourceguard binding и portable limitation. Installer не исполнялся, binary/config не изменены. P13 cache race pending→bound reproduced RED; root applied one-file hash-checked fix, coherent core build exit0, final author consumer validation продолжается.

P13 human-disable regression reproduced RED: native disabled User layer терял human skills.config selector. Root applied one-file skills/context projection preserving disabled User/SessionFlags human policy while native inventory remains required; core build exit0. P17 origin recheck accepted /root/p01_review; default positive binary proof ограничен audited publisher darwin-arm64 2.1.287, other builds unavailable до evidence, без machinepath constants.

P13 snapshot f3394ae сохранён root: exact25SHA/gitBlob matched,927insertions/22deletions. Author499core/62host/lint/scopedcorefixturetypes passed, corebuild0; independentfullreview /root/p01_review запущен. Combinedhostfixturetypecheck имеет только неизменённый fakeActivity baseline mismatch. Author готовит P20 read-only preflight до write unlock; P17 продолжает host/UI, registry Add/Remove/Check root-bound и ещё unstaged.

2026-10-04: пользователь восстановил лимиты; P17 author возобновлён с сохранённого состояния. P13 independent full review accepted f3394ae без Critical/Important:341core/62host/8isolatedcontrols,exact25SHA/blob/lint/diff. P20 dispatched core-only с сохранением выбранного nested project scope, versioned LOCAL sequence и idempotent partial recovery; host main-resolver delegation ждёт P17freeze. P14 remaining work готовит independent P13 reviewer read-only; strings ещё solewriter P17.

P14 dispatched после acceptedP13: per-session settings, immutable guide/guidance flag и UI Settings; generic protocol/host field уже поддержан, нового wire production нет. Root сохранил P17 MCP strings exactonefile milestone7b1356e/lint0; S.settings solewriter передан P14, P17 sourcegroup freeze. P20 separate native-main-root/nested-shared-project interface согласован, temp production drafts; общий build ждёт coherent окно обоих core writers.


## Продолжение после восстановления лимитов — 2026-10-04

P14 frozen snapshot `baf9af9`: exact14 SHA/gitBlob matched; 301 core +26 Settings +4 host fixtures, scoped strict types/lint/diff passed. Независимая приёмка ещё впереди. Native Claude role без подтверждённых permissions не рекламирует find_skill; full native lists/suppression OFF сохранены.

P17 завершил isolated native Claude project Add/Remove с exact audited publisher artifact: оба exit0, только private temp Git project/HOME/config, без модели и human config writes. Desktop137 и typecheck passed; final reader integrity/Codex binary identity fixes и полное независимое ревью ещё впереди. Это не P32 live-session gate.

Root прочёл и применил P20 domain14 и lossless2 bundles: exact scope/before/after SHA совпали, diffcheck0. Автор проверяет полный actual-path batch; independent reviewer /root/p01_review проверяет races/lossless/context/recovery на temp fixtures. Preliminary race между двумя Markdown reads исследуется до принятия.

P20 independent review needs rework: два Important, оба воспроизведены /root/p01_review на temp probes — stale preparedSource между двумя reads и LS/PS title round-trip. Автор исправляет до freeze; 71 domain +5 shared-storage targeted checks passed. Coherent core production build P14/P20 exit0; эта сборка не означает принятие P20.

P20 accepted independently /root/p01_review после exact2-file fixes: оригинальные race/LS/PS probes GREEN, 28 affected fixtures passed; author full181/runtime checks/types/lint. Root snapshot4391680 exact14SHA/gitBlob. P17 frozen f447ccd exact18owned+rootregistry matched; hostbuild0. P14 reviewer переназначен /root/p01_claude_probe для параллельной независимой проверки.

P21 dispatched /root/p02_codex_probe после P20 acceptance: первая фаза только новые host/BacklogPanel/protocol-backlog modules. P14/P17 shared points frozen под independent review; unlock/DTO surface согласует root отдельно.


## Дополнение человека: audit token economy

Прочитаны C1–C6/измерения/cache/economic gate и A11/A14/A21/A22/F01–F05 из docs/audits/2026-10-03. Immutable source copies сохранены в worktree; новый контракт docs/plans/2026-10-04-parley-token-economy-audit.md согласован с общим планом и PARLEY/navigator/memory specs. Queue расширена39: новыеP34–P38 предшествуютP32; 17accepted остаются, source line numbers исторические. Остальной audit remediation scope не перенесён. Платные native turns пока не запускались, savings не заявлены.

P14 safety fix accepted: a9c1e14, original directory/leaf symlink probes foreignPreserved/rejected, 33 affected fixtures и core build exit0. Текущий результат18 accepted из40. Внутренний minimal-development добавлен в project-native folders и workflow; P39 доставит его через existing owned installer, без global hooks. Token-audit P34–P38 сохранены; новый навык — отдельная ось P38, проценты экономии не заявлены.

P17 accepted0c0d1f9 после точного4-file health fix: original loss-of-proof probe и production related override/concurrent refresh/no-resurrection fixtures GREEN;43 affectedtests, SHA4/lint0 и hostbuild0. 19accepted из40. Docs/skill integration independently accepted /root/p01_review:40cards/40rows/acyclic,124local links, immutableaudithashes/LICENSE и native metadata/alias. Commitc3d8d73. P21 shared grant открыт после DTO read; registry root-only. P22 иP39 dispatched disjointcore owners; P18 пока read-onlyaudit. Current Claude symlink2.1.288 не заменяет approved2.1.287 artifact: exactстарый artifact проверен, userCLI не изменён. Native/platform/model gates не закрывались.

P39 exact6 source assets applied from SHA8ebe0071…96c2: author76core/17host/strict types/lint0; peerreview /root/p01_review assigned, acceptance pending. Current source frozen. P21 prepareTake(empty patch) preserves human bytes +actual stableID, read-only inspectSharedIgnore extension granted for agent-first warning delivery. Manual host API uses actual shared-token authentication; MCP only list/suggest, no fabricated human attestation or new authentication architecture. P22 promotion exception clarified in source; ordinary amendments still invalidate prior results.

P39 accepted50a878f после narrow temporary-ownership fix: foreign LICENSE.tmp сохранён, handle закрывается при stat/write failure, cleanup только собственного inode. Independent original probe/11affected/3resource-failure GREEN; точные6SHA и core/host builds0. 20accepted из40; native model loading и economic gates остаются в P32/P38. P22 final11 bundle c98a354…8d1a applied with exact hashes, independent review /root/p01_claude_probe; P21 foundation awaiting root registry integration, lifecycle/backlog closure закреплены за P23.

P22 acceptedcec588d: managed168 and independent168+4meaningful probes GREEN, strict/lint0, exact11hashes. P21 foundation05703f…f158 applied +rootregistry; coherent core/protocol/hostbuild0 and registry2tests/lint0. Partial independent P21review found alias-first watcher retained removed client path; narrow fix assigned author with canonical internal context, preserving requested notification identity. Take followup uses canonical room liveness (sleeping/pending live; closed/deleted denied). P18 resumed backend/DTO-first, P23 accepteddep dispatched with persisted occurrence-level delivery/retry proofs; protocol/sharedregistry serialized by root, MCPheld P21.21accepted из40; finalgates pending.

P21 full next24+fix4 applied with exacthashes; source38 freeze2146c4…534a. Root managed MCP162/162, coherent core/protocol/hostbuild0, desktoptypecheck0. Independentfoundation26checks/originalaliasprobe GREEN; fullGUI/MCP/IPCpeerreview /root/p01_review pending. P29 domain/lastlayer dispatched TMP-only /root/p02_codex_probe; ordinaryrememberpending, onHumanRequest explicitlyclaimedagentrequest (not humanattestation), hash/version-boundUndo, truthfulsourceclaims and12KiBUTF8completefacts. P18newcatalogaggregateUTF8cap requested beforeDTOapply; currentsharedsourcefreeze preserved.

P21 acceptedfb2784f: canonical watcher/liveness и narrow UI epoch/semanticTake fixes прошли независимые original probes; foundation26, GUI/dialog/IPC21, finalaffected17 GREEN, exact38SHA/blobd15e1022…edf2c +rootregistry. Root server162 и coherentbuild0, latestdesktoptypecheck0.22accepted из40. P23MCP/guide/guidance unlock послеP21; P18boundedDTO6 SHA874fcaf…cb0e applied +protocolbuild0, backend/policy closure продолжается. P29 memory NoticeKind2/strings2 consumer-only grant открыт, source shared-domain lock исправлен; provenance/on-requestclaim/Undo/12KiB сохраняются.

P29 first20 domain fixtures GREEN плюс layer13/state-dir38; source-origin preservation/actual fact human amendment разделены. Legacy store createWork equality fixture корректируется только под accepted plans[] read normalization. P23 first23 scoped DTO/domain/closure checks GREEN; новая collection absent на обычной Free map, no-work/no-write обязателен. Root grants narrow trusted-letter cancellation filter и отдельный plan-effect-failed notice consumer; P29 memory notices интегрируются последовательно. P38 off/on skill axis дополнена реальной native availability/loading evidence, не одним installer flag; человеческие native assets не удаляются.

P29 frozen domain13 c33835b6…5aab21 и consumer3 07a2d8e6…5d443 применены root с exact before/after SHA/gitBlob. Author216 relevant core cases, strings79, scoped types/lint0; coherent core/protocol/hostbuild0 и desktoptypecheck0. Independent review /root/p01_claude_probe после P18 backend freeze; P29 ещё не accepted. Memory ≤12 288 UTF8 bytes включает complete facts/id/provenance/header/marker; противоречие раннего лимита в unified устранено вместе с memory spec. P23 conflicts изолируются по captured intent, новое capture не блокируется старым конфликтом; retries bounded и ручное восстановление без пересборки payload.

P18 backend17 3af084bd…2dd80 applied; root зарегистрировал7 plugin methods через прежний singleton, hostbuild0. Independent /root/p02_codex_probe DTO Important scopes/provider исправлен narrow2 patch8eaae3b…cac55d1; original11probes GREEN. Backend Important pretty multiline Codex JSON воспроизведён2RED и передан author; P18 ещё не accepted/UI pending. P29 independent exact16SHA seal подтверждён до additive P23 shared additions, protective Undo amendment согласован в spec/unified. P23 milestone17 8ebad40f…c5108 + notice3 6c9cf057…c19f2 applied с exact scope/hashes; peer helper review ongoing, full MCP/wake wiring author ещё делает.

Ограничение человека: остановиться при достижении 30% недельного лимита. Текущий рабочий смысл — остаток ≤30%; уточнение расход/остаток задано асинхронно. Последнее наблюдение get_usage_limits: usedPercent40, windowDurationMins10080, остаток60%; проверять на интеграционных границах и перед новой задачей. При достижении порога остановить агентов и сохранить checkpoint без запуска новых задач.

P23 first helper milestone independently accepted /root/p02_codex_probe: exact17SHA,46existing+4meaningful probes GREEN, no Critical/Important; full MCP/wake wiring и общая P23 приёмка ещё pending. P12 roles §5.7 сохраняет MCP coordination/report для read-only native ролей: plan_update/submit/verify используют trusted actor/rev guards, без нового mutable role-catalog permission resolver. Coherent core/protocol/hostbuild0 после P23+P18 DTO fix.

P29 independent needs rework: UTF16 lone surrogate принимается как fact/details/why/refs, затем UTF8 silently replaces text. Root pure probe и independent9RED подтвердили; author p02 исправляет только6memory/layer files, до reservation/Markdown writes. Other original79 +independent5+freshlaunch2 GREEN,16SHA seal. P18 prettyJSON2RED исправляет author p01. Acceptance remains22/40. Последний недельный остаток59% (usedPercent41); пользовательский порог пока не достигнут.

P29 independently accepted /root/p01_claude_probe: original9 Unicode failures GREEN +valid emoji,54affected/probes final GREEN; sixafterSHA exact, validators refuse input before local/Markdown writes. Root staged only reviewed P29 domain13+consumer3+fix6 through exact staged hashes, commit127367e; P23 shared additions остались unstaged.23accepted из40. P18 prettyJSONfix2 469c2ae…3b1322 accepted /root/p02_codex_probe original4GREEN/SHA2, hostbuild0; P18UI TMP phase opened with one bridge prop preserving P21backlog. Последний недельный остаток55% (usedPercent45).

P18 full independently accepted: UI9 f1c6299e…6054a45 exact hashes, author136/peer22 GREEN, root desktop web noEmit0; c917f45+a4abc3f source checkpoints. P19 TMP foundation dispatched after acceptance. P23 integration14 f93cc387…5933b applied; independent peer isolated Cyrillic Free decision character/byte regression, narrow correction pending. Root host wiring3 b8d07d87…ff404a singleton/start/stop/safe notice +7 worksReady gates; hostbuild0 and18 host scoped checks GREEN, independent lifecycle review ongoing.24/40accepted. Недельный лимит: остаток52% (used48), порог30% остатка не достигнут.

P23 full independently accepted: immutable first helper6a3635f, integration21 b511fda exact stagedSHA. Correction7 7f4ef6ef…2e0ad5 restored Cyrillic limits, exact Free response, off-guide; five authored RED→GREEN, author264GREEN/types/lint0, rootactual257GREEN/core+protocolbuild0. Peer9 relevant independent rechecks+exact7SHA, root lifecycle peer19+exact3SHA, no remaining Critical/Important. Spec/unified clarify same limits/semantics. P24 UI and P27 journal/history dispatched after fullacceptance; P19 remains running, sharedsurface grants bounded/TMPonly.25/40accepted. Недельный остаток48% (used52); остановка при30% остатка сохранена.

P19 manual/source availability clarified: structurally known ordinary human SKILL folder with only availability-unverified partial diagnosis can be explicitly shared; false/unknown model availability is unchanged, no native execution/policy bypass. P27 capture/retry/private publisher extraction grants bounded to existing host authority and schema2/full8MiB limits; P24 UI uses existing DTO/bridge. Implementation acceptance remains25/40.
