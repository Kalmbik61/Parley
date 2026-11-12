# Plan: role change on agent switch

Spec: `docs/specs/2026-11-12-switch-role-change-confirm-design.md`. Branch `parley/w-0054/s-363` from 2c69adc1. One executor (builtin:executor, Claude sonnet), tasks in order, each reviewed by the lead before the next. Review: builtin:reviewer on Claude opus over the whole diff. Verification: builtin:verifier on Claude sonnet in the real app. Lead decision: T2/T3 touch the write boundary of the switch but the change is a few guarded lines before the first map write, fully specified in spec 2.3; they go to the sonnet executor and get a focused senior review instead of senior implementation (the week limits of Claude and Codex are at 95–96 %).

## T0 — documents
Commit the spec and this plan unchanged.

## T1 — core and protocol
- `packages/core/src/work/agents.ts`: `roleForProvider` checks a built-in role against the target (`prepareSessionRole(cwd, entry, {roleId, provider: entry.id, mode: 'existing'}, catalog)` → accepted: role; refused (`RoleChoiceError`): `null`). Comment updated.
- New exported function (same file or `work/role-change.ts`), e.g. `roleChangeOnSwitch(cwd, entry, targetLabel, role, catalog?) → Promise<RoleChange | null>` per spec 2.2, with the texts of 2.2. It uses `roleForProvider` for the role after and the catalog's resolved `readOnly` for both sides. Export from `packages/core/src/index.ts`.
- `packages/protocol`: type `RoleChange` (spec 2.2) and `RoleChangeAck = {from: string; to: string | null}`; `sessions.switchAgent` params gain optional `roleChange` (ack); `sessions.switchOptions` result target gains optional `roleChange: RoleChange | null`; `AgentSwitchCard` gains optional `roleChange?: RoleChange`; `consents.decide` params gain optional `roleChange` (ack). Remote allowlist: `CONSENT_DECIDE_KEYS` accepts `roleChange` with a shape check (`from` non-empty string ≤ 200, `to` string ≤ 200 or null); `SWITCH_AGENT_KEYS` unchanged (phone sheet out of scope).
- Tests: `agents.test.ts`, `launch-qwen.test.ts` — built-in read-only (architect) on qwen → null; built-in architect on codex/claude kept; built-in executor on qwen kept; neutral custom runner without role channel → null; the new function: each text form of 2.2, `readOnlyLost` true/false, no role → null, unchanged role → null. Protocol schema tests for the new optional fields (old payloads still parse). Allowlist test: decide with and without `roleChange`, bad shape → refused.
Accept: typecheck, lint, core + protocol tests green.

## T2 — host: switch and first launch (write boundary; focused senior review)
- `sessions-service.ts` `runSwitch`: replace the role computation at ~2166 with the change of T1 and apply the table of spec 2.3, all before `launching.add` and the first `updateMap`. `SwitchRequest` and `host/src/methods/sessions.ts` pass `roleChange` through.
- `switchOptions`: each target carries `roleChange` (one catalog read per call; a target whose entry cannot be read → `null`).
- `launchHeld` (`awaitingAgent`, ~988): read-only lost → throw a `HostError` with the text of spec 2.6 before any map change; other changes keep today's repair.
- One `host.notice` (kind `role-missing`) after a switch whose role changed (spec 2.5), on every path; remove nothing else.
- Expose `roleChangeFor(ref, provider)` on the sessions service for T3.
- Tests (host): criterion 5 (built-in read-only → qwen: no ack → `conflict`, map byte-for-byte unchanged, no `switching`; with matching ack → switched, role `null` in map, binding role `builtin:architect`, launch plan does not throw `role-permissions-unavailable`); mismatching ack → refused, map untouched; native role replaced without ack → switched as today; control: built-in architect Codex → Claude, no-role session → nothing changes, no notice; stuck session (provider qwen, architect, `awaitingAgent`) → launch refused with the 2.6 text naming Codex, map untouched; exactly one notice per confirmed role change.
Accept: typecheck, lint, host tests green except the two known failures.

## T3 — host: consent card and Telegram
- `host.ts` switch endpoint `request`: compute `roleChange` via `roleChangeFor` and store it on the card; `consents-service.ts` persisted-card validator accepts it.
- `decide(id, 'allow', …, roleChange?)`: card with `roleChange.readOnlyLost` and missing/mismatching ack → `bad_request` with spec 2.4 text, nothing changes, card stays pending; `answerSwitch` passes `roleChange: {from, to}` to `switchAgent`. Method handler passes the new param.
- Telegram: `T.switchAsks` (or `consentCardMessage`) adds `card.roleChange.text` as its own line; the Telegram Allow passes the card's ack.
- Tests: card carries the change; allow without ack refused (pending kept); allow with ack switches; deny without ack works; card without role change unchanged; Telegram text and decide.
Accept: as T2.

## T4 — window and island
- `SwitchAgentDialog.tsx`: show the selected target's `roleChange.text` above the confirm button (warning style when `readOnlyLost`), send `roleChange: {from, to}`; remove the post-switch `roleChanged` toast (host notice replaces it; drop the string if unused).
- `store/consents.ts` `switchRequestText` (window + island) shows the card's role text on its own line; `decide` sends the card's ack with `allow`. `AgentSwitchDialog`/`ConsentView` render it.
- `CHANGELOG.md`: one entry under Unreleased.
- Tests: renderer tests for the dialog (text shown, ack sent; no text when no change) and for the card text.
Accept: typecheck, lint, desktop tests green.

## T5 — phone
- `mobile/src/cards/ConsentViews.tsx`: role text as its own line, not truncated; `remote-client` `consents.decide` sends the card's ack with `allow`.
- Tests: mobile card model/view test, remote-client decide params.
Accept: typecheck, lint, mobile + remote-client tests green.

## T6 — review and full suite
Reviewer (opus) reads the whole diff against 2c69adc1 with the spec; executor fixes findings. Full suite `pnpm -r --no-bail test`: only the two known failures (core `src/work/launch.test.ts` "claude получает id…", host `src/methods/providers.test.ts` "версии кэшируются…").

## T7 — verification in the real app (verifier)
Fresh throwaway PARLEY_HOME and project, real CLIs on the cheapest models (Codex gpt-6-luna, Qwen qwen3.8-flash, Claude haiku): architect on Codex → Qwen from the window (dialog text, screenshot; starts; one notice; map role null, binding role architect); same through `request_agent_switch` (card in window and island, screenshots; Allow starts it); a direct `sessions.switchAgent` without ack → refused, map untouched; a stuck session built on 2c69adc1 behaviour → refusal text names Codex, Continue on Codex works; control Codex → Claude with architect: no role text, role kept. Telegram and phone: not run unless available — say so.

## Risks
- Claude/Codex week limits at 95–96 %: sessions may stall; the lead reports a blocker to s-320.
- Old window or phone builds against the new host: they cannot show the text; for read-only loss they get the readable refusal (by design).
- `switchOptions` now reads the role catalog per call: one read, measured by the existing timer if slow.
