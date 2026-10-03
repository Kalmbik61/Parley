# P13: нативный контекст доступности скиллов

Дата: 2026-10-03. Read-only preflight /root/p01_review, gpt-6.1-sol/high. Это evidence для интеграции принятого resolver, не приёмка P13/P32 и не разрешение сокращать нативный список.

## Codex 0.156.1

На bounded stdio connection app-server после initialize/initialized поддержан `skills/list` с `{cwds:[participantCwd],forceReload:true}`. Ответ `data[{cwd,skills[],errors[]}]`; row содержит name, canonical document path, scope user/repo/system/admin, enabled, description, optional plugin/interface/dependencies. `enabled` — отсутствие path в native disabled set, а не полная model availability. [Pinned implementation](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/catalog_processor.rs#L452-L527).

Два изолированных offline subprocess probes без model/auth/MCP/daemon подтвердили same-name user/project canonical files, human path-disable и SessionFlags name-disable. Manual-only `allow_implicit_invocation:false` продолжает возвращать enabled:true. В fixture 5 inventory records/3 доступных после пересечения policy; session disable оставил1доступный. Safe summary `/private/tmp/parley-p13-skills-j7ri5e83/safe-summary.json`, probe `/private/tmp/parley-p13-skills-probe.py`; bounded cleanup выполнен.

Production adapter проверяет точный participant cwd/canonical identity и сохраняет разные документы. Human low→high User/SessionFlags snapshots передаются принятому resolver; Parley-generated suppression из human rules исключается. Native inventory — evidence только для подтверждённых local roots; результат пересекается по canonical path И native name. Доступность требует native enabled И resolver modelAvailable. Policy YAML остаётся обязательной; plugin/extra/unsupported roots не повышаются автоматически. Native inventory не доказывает model read execution.

## Claude 2.1.287

Pinned local control transport: `--print --input-format stream-json --output-format stream-json --verbose`, init-only `initialize → get_settings → get_skills_dialog`. Synthetic probe с isolated HOME/CLAUDE_CONFIG_DIR, strict empty MCP, dummy API key и localhost:1 завершён без user/model turn. Settings sources low→high userSettings/projectSettings/localSettings/flagSettings/policySettings, effective и optional errors; menu сообщает native state on/name-only/user-invocable-only/off, source, locks и slash visibility. Fixture: project skill on, user-disabled skill off, settings errors отсутствуют. Safe summary `/private/tmp/parley-p13-claude-x9jfzzpr/safe-summary.json`, script `/private/tmp/parley-p13-claude-control-probe.py`. Pinned binary schema/handlers byte offsets180262367/180183727/179256763/204921626; SDK getSettings найден отдельно.

ClaudeNativeEvidence.policyVerified требует совпадения launch cwd/config/settings и отсутствия unreadable/unsupported policy. Internal projection только нужных settings fields; raw settings/errors/dependencies не логировать и не возвращать в DTO. Menu advertised — slash visibility, не proof Skill tool availability. Read-only list_permission_rules имеет provenance live-state, но TUI/session binding, tool narrowing и role-specific load route остаются отдельной проверкой. Account/plugin/managed availability не угадывается.

## Границы реализации

Переиспользовать bounded native context transport P12, где это уменьшает дублирование, и accepted skills resolver; нового filesystem scanner/parser не добавлять. MCP search cache привязан к provider/canonical cwd и launch snapshot; чужой или удалённый worktree не заменяется каталогом ведущего. Unknown availability закрыта для model search, полный native список сохранён. Fresh-main context evidence не выдавать за running role/TUI evidence. P32 проверяет настоящий load/report/notify/resume и parity отдельно.
