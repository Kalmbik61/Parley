# Agent switch that changes the role: confirm instead of fail

Date: 2026-11-12. Base: master 2c69adc1 (v0.35.0). Backlog: b-044. Owner: s-320; lead: s-363.

## 1. Problem

A switch to a provider on which the session's role cannot run is written to the map, and then every launch fails with `role-permissions-unavailable`. Incident: architect (built-in, read-only) on Codex → Qwen Code through `request_agent_switch`; the session cannot start until it is switched again.

Cause (v0.35.0):
- `roleForProvider` (`packages/core/src/work/agents.ts:235`) returns a built-in role unchanged, without checking that the target accepts it.
- `runSwitch` (`packages/host/src/sessions/sessions-service.ts:2166`) trusts it, so the map is switched.
- The launch plan (`assertRoleDelivery`, `agents.ts:176`) refuses a read-only role on a family without verified read-only enforcement (Qwen Code, `neutral` custom runners). The first-launch repair (`sessions-service.ts:988`) calls the same `roleForProvider`, so nothing repairs it.

The human's decision: do not refuse the switch; let the session continue on the target after a confirmation that says the role will change. Read-only on Qwen stays refused by design (Qwen spec 2026-11-11, D10).

## 2. Behaviour

### 2.1 What the role becomes
One rule, as today: `roleForProvider` keeps the role if the target accepts it, else the same-name role of the target family, else no role. Change: a built-in role is now checked too (`prepareSessionRole(..., mode: 'existing')`); a built-in role the target refuses becomes `null` (built-in roles have no per-family variant). For a built-in read-only role on Qwen Code or a `neutral` runner that means "no role". Built-in roles on Claude, Codex, OpenCode and Qwen (non-read-only) are accepted as before.

### 2.2 The role change (`RoleChange`)

A new core function computes, for a session role and a target provider entry:

```ts
interface RoleChange {
  from: string;          // roleId before, e.g. "builtin:architect"
  to: string | null;     // roleId after, or null = no role
  readOnlyLost: boolean; // the role before resolves read-only and the role after does not
  text: string;          // one English sentence for people, the same on every surface
}
```

`null` when the role does not change (same roleId, or the session has no role). `readOnlyLost` uses the catalog's resolved `readOnly` of each role (`resolveRoleChoice`). Fail closed: a native Codex role whose settings could not be read (missing from the catalog, or the catalog has a Codex diagnostic) counts as read-only, with the text `<Name> may be a read-only role (its Codex settings could not be read) and does not run on <Target>. The session will continue <after>, and can edit files and run commands.` Display name: the catalog role's `name` (built-in: "Architect"); a role missing from the catalog → its roleId. The target role is written as `<Name> (<source>)` when it is a native role.

Text (exact form, English):
- read-only lost, no role after: `Architect is a read-only role and does not run on Qwen Code. The session will continue without a role, and can edit files and run commands.`
- read-only lost, another role after: `Reviewer is a read-only role and does not run on Codex. The session will continue as reviewer (codex), and can edit files and run commands.`
- otherwise: `Role reviewer does not run on Codex. The session will continue as reviewer (codex).` / `… The session will continue without a role.`

### 2.3 The acknowledgement

`sessions.switchAgent` gets an optional `roleChange: { from: string; to: string | null }` — the change the human saw. `runSwitch` computes the change where it computes the role today (before `switching` is written, before any map update) and decides:

| computed change | ack in request | result |
|---|---|---|
| none | any | switch as today (ack ignored) |
| exists, `readOnlyLost` | absent | refuse, `conflict`, message = `text` + ` Confirm the role change in the Parley window to continue.`; map untouched |
| exists | present, differs from computed | refuse, `conflict`, `The role change has changed since it was shown: <text> Open the dialog again.`; map untouched |
| exists, not `readOnlyLost` | absent | switch as today (old clients keep working; native-role replacement was silent before and stays allowed) |
| exists | present, equal | switch; map records the new role (or none), the old role goes into the previous-agent binding (`applyAgentSwitch` already does this) |

Decision (lead): the ack is mandatory only when read-only is lost. A native role replaced by its same-name role was allowed silently before; making the ack mandatory there would break old clients and the phone sheet for no safety gain. The text is still shown before every role change on updated surfaces.

### 2.4 Where the human sees it before confirming
- **Window switch dialog** (`SwitchAgentDialog`, opened from the session menu, chat `SwitchBanner` — limit and sign-in offers —, `NotRunningCard`, the limit notice in `attention/notify.ts`, `ProviderSessions`): `sessions.switchOptions` returns `roleChange: RoleChange | null` for each target. The dialog shows the selected target's `text` above the confirm button (warning style when `readOnlyLost`) and sends `roleChange: {from, to}` with the switch.
- **`agent-switch` consent card**: the host computes `roleChange` when the card is created (`AgentSwitchCard.roleChange?: RoleChange`, persisted with the card) and every renderer shows `text` as its own line: window and island (`switchRequestText`), Telegram (`T.switchAsks`), phone (`ConsentViews`, not truncated).
- **Allow**: `consents.decide` gets an optional `roleChange: {from, to}`. For a card with `roleChange.readOnlyLost`, `allow` without a matching ack is refused (`bad_request`, `text` + ` Allow it in an updated Parley window.`) before anything happens; `deny` needs no ack. Window, island, Telegram (host-side) and the phone send the card's `{from, to}` with `allow`. `answerSwitch` passes the ack on to `switchAgent`; if the host now computes a different change, the existing failure path (notice + letter to the requester) carries the refusal text.

### 2.5 After a confirmed switch
The host broadcasts one `host.notice` (kind `role-missing`, existing kind) for every switch whose role changed, from any client: `@s02 continues on Qwen Code without a role: Architect no longer applies, and the read-only restriction is lifted.` (or `… as reviewer (codex)`; the read-only clause only when `readOnlyLost`). The window dialog drops its own post-switch role toast (`S.dialogs.switchAgent.roleChanged`) so the human sees one notice. The `sessions.switchAgent` result keeps `role?: {from, to}` unchanged.

### 2.6 First launch after a switch (`launchHeld`, `awaitingAgent`)
Same computation. If the change loses read-only, the launch is refused with a readable error instead of `role-permissions-unavailable`; nothing is changed in the map: `Architect is a read-only role and does not run on Qwen Code. Continue @s02 on Codex again to keep the role; from there you can continue it on Qwen Code without the role.` (`Codex` = label of the provider of the last previous-agent binding; no binding → `on another provider`.) Other role changes keep today's repair (map updated, `role-missing` notice).

### 2.7 Already stuck sessions (acceptance 6): a refusal that names the way out
Chosen: the refusal of 2.6, not a new "start without role" action. Reason: the stuck state comes only from 0.35.0 switches; after this fix no switch writes it, so a one-off state does not earn a new launch parameter and a new NotRunningCard action. The way out is one existing action (Continue on another provider → the previous provider, where the role runs), then the confirmed switch of 2.4 if the human still wants Qwen Code. The text reaches the human through the existing `launch-failed` / wake-blocked display.

## 3. Unchanged
Session creation (read-only on Qwen is refused up front as today); switches where the role runs on the target (Claude ↔ Codex ↔ OpenCode with built-in roles; built-in non-read-only roles on Qwen); sessions without a role; Qwen read-only enforcement (none).

## 4. Out of scope
- **Switching back does not restore the role.** `applyAgentSwitch` stores the old role in the binding, but no code reads it back; a later switch to the old provider keeps the current role (or none). Not changed here.
- **Phone switch sheet** (`mobile/src/feed/SwitchSheet.tsx`): it does not show the role change and sends no ack, so a read-only loss is refused there with the readable message of 2.3 (the sheet shows host errors). Other role changes go through as today.
- A "role text without enforcement" mode for Qwen.

## 5. Acceptance → where it is checked
1. Window dialog text before confirm; confirm switches and starts → T4 tests, verifier screenshots.
2. Consent card text on window, island, Telegram, phone; allow = confirmed → T3, T4, T5 tests, verifier screenshots.
3. No silent loss of read-only from any client; refusal before any map change, names role and provider → T2, T3 tests.
4. New role (or none) in the map, old role in the binding, one notice → T2 tests, verifier.
5. Unit test: built-in read-only to qwen without ack → refused, map untouched; with ack → switched, launch plan succeeds → T2.
6. Stuck session: refusal names the way out (2.7) → T2 test, verifier.
7. No change for role-preserving switches, creation, no-role sessions → T1, T2 control tests, verifier.
