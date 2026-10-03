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
- Текущая фаза: P00–P12, P15/P16 accepted; P13/P17 running.
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
| P13 | Реализовать find_skill и настройку MCP | running | /root/p02_codex_probe; P12/P08 accepted; core-only transport/context/cache/config grants |
| P14 | Подключить навигатор к CLI и Settings | pending | — |
| P15 | Реализовать безопасный снимок Capabilities | done | d4278ce/20cf256/eef8425; independent fixes accepted; full33 tests/types/lint |
| P16 | Создать единую панель проекта и вкладку Capabilities | done | b7589f7; independent165checks accepted;17SHA matched; visual gate P32 |
| P17 | Добавить native MCP add/remove/check | running | /root/p01_claude_probe; DTO-first wire grant; private selector/context/queue, registry root |
| P18 | Добавить native действия плагинов | pending | — |
| P19 | Добавить передачу скилла второму CLI | pending | — |
| P20 | Реализовать shared/local state и домен бэклога | pending | — |
| P21 | Подключить бэклог к MCP, host и панели | pending | — |
| P22 | Реализовать режимы, планы, ревизии и снимки | pending | — |
| P23 | Подключить инструменты планов и будильник | pending | — |
| P24 | Показать план и итог в комнате | pending | — |
| P25 | Реализовать рецепты и плейбук ведущего | pending | — |
| P26 | Подключить рецепты к диалогу и Save as recipe | pending | — |
| P27 | Реализовать журнал принятых версий и историю | pending | — |
| P28 | Подключить Decisions и Share history | pending | — |
| P29 | Реализовать память проекта и её слой | pending | — |
| P30 | Реализовать search_history по записям проекта | pending | — |
| P31 | Подключить память, поиск и UI | pending | — |
| P32 | Провести сквозную проверку и сравнение навигатора | pending | — |
| P33 | Обновить документацию по фактическому результату | pending | — |

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
