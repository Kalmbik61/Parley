# Code Mode families F1–F4: gates, feasibility and order

Status: **ACCEPTED by the lead (s-292, m-7375).** Author: s-311 (family designer); revised by s-312 to apply the lead's rulings (§4). This document designs no family in full and assigns no work. It answers one question: in which order the four families should be designed, and which of them can be designed at all without weakening a gate.

Scope: the human's decision m-7370 (via s-288): every remaining method except `browser_*` moves into `code_execute`. The 15 `browser_*` tools stay direct MCP tools as a decided permanent exclusion. Permissions come from Parley (m-4571 stands).

**Amendment (human decision m-7377, relayed by s-292 in m-7379).** `report` stays a direct MCP tool permanently, like `browser_*`. It is a decided exclusion, not a residual and not part of F3. This overrides every mention of `report` as an F3 method below (§2 F3, §3 row 3, §4 ruling 4, the impact card). F3 is `wait_for`, `check_inbox` and `close_session`. Decided direct exclusions: 16 (15 `browser_*` and `report`). Methods in scope: 24 (F1 16, F2 4, F3 3, F4 1). Feasibility: 18 yes (F1 16 with conditions, `close_session` with conditions, `find_skill`), 6 unknown (F2 4, `check_inbox`, `wait_for`), none no. Hours are unchanged, because `report` was never sized: about 125–200 h in total (estimate, not measured). The order F4 → F1 → F3 → F2 stands, with the F1 consent condition, and families run in parallel where they are independent.

Sources read (2026-11-10): T11 batch plan `docs/plans/2026-11-10-code-mode-t11-batches.md` at `0cd2b6c5`; spec `docs/specs/2026-11-07-code-mode-design.md` §3.1, §4, §5.1, §5.2, §6, §7, §7.1; plan `docs/plans/2026-11-07-code-mode-plan.md` (autonomous continuation, T8h, T11, effect-family table, T13); code on `parley/w-0054/s-293` `d715a789` and `parley/w-0054/t12a` `7a83d601`; room duties m-7267, m-7324, m-7366, m-5887. Nothing was run.

## 0. Four code facts that shape every family

These facts come from reading the source. Each one moves a feasibility answer below.

1. **The live policy source allows every eligible call while the detector is clear.** `detector.ts:183` (t12a): `decide: () => (detector.scan().kind === 'clear' ? 'allow' : 'revoked')`. For reads this is the m-4571 rule. For a write, it would allow the call with no human step at all.
2. **In classic, Parley does not pre-allow its write tools in an ordinary Claude session.** `work/settings-file.ts:254–257`: the session settings `permissions.allow` hold `mcp__parley` (all Parley tools) **only for autonomous sessions**. Otherwise they hold the browser tools except evaluate, cookies and storage, plus `close_session`. So a classic `send_message`, `remember`, `plan_submit` or `create_session` goes through the client's permission step, which Parley routes to the human (`PermissionRequest` hook, `host/src/hooks/decisions.ts`), unless the human's own settings allow it. That step is the "concrete human consent at the underlying method boundary" that spec §5.2 keeps. Fact 1 applied to writes would remove it. **This is the central gate of F1, F2 and F3's `close_session`.**
3. **`writesExist` matters only for an unreadable record, and an unreadable record has no readable header.** `selectExposure` (`launch-decision.ts:113–116`) consults `writesExist` only when `record.kind === 'unreadable'`. The m-7366 alternative "read it from the record's header" therefore never applies where it matters. **`writesExist` has to be sticky.** The reader of the sticky value has to exist in every build that can be launched after a write has shipped. A downgrade to a build without the reader would read an unreadable record as classic.
4. **Creation tools have no broker route and no host deduplication.** `create_session`, `request_agent_switch`, `create_swarm` and `swarm_add` are answered in the session MCP process (`tools.ts:2149–2163`) by a direct `fetch` to `/agent/sessions`, `/agent/switch` and the swarm endpoints (`session-tools.ts:45,99`), with no `callId`. The `/agent/tools` runner has a `callId` replay cache (`host/src/agent/tools-endpoint.ts:15–18,165–211`, 10 min TTL, a per-session limit, in memory only). `create_session` waits up to 120 s (`session-tools.ts:49`). The run's total wall is 30 s (§6).

## 1. Gates every family keeps

These are common to F1–F4 and are not repeated per family.

- **G1 Policy.** deny, ask, unknown, stale and revoked mean zero calls, at execute, at each nested call and before each retry (§5.1, broker `beforeRetry`).
- **G2 Authority.** Every nested call re-enters the original host authority path through the remote-only runner, with no local fallback (§5.2). Host 404 is a refusal.
- **G3 No replay.** No script, write, creation or pending call is replayed (§7.1). "200 = answering attempt only": a 200 settles the attempt that answered and says nothing about earlier attempts.
- **G4 Held records.** A held or unaccounted record naming a non-read method, or a method this build does not know, gives `blocked`, never classic (B0 acceptance, m-7366). `writesExist` is sticky and is never taken from the current build alone (m-7267, m-7366, fact 3).
- **G5 Final result.** 16 KiB final-result cap with the `limit-reached`/`result-bytes` diagnostic (m-7324).
- **G6 Hints.** Execute annotations follow the maximum effect of the launch's allowlist (m-5887). They are per launch, because the allowlist is.
- **G7 Conservation.** Per launch, migrated ∪ direct = original and migrated ∩ direct = ∅; nothing is invented or hidden (§3.1). Failed-attempt restoration as in plan T11.
- **G8 Rollback.** T8h: freeze admission, account dispatched/unknown calls, keep the lease, no same-launch exposure switch.

## 2. Families

### F1 — store writes and `send_message` (16 methods)

Methods: the 15 store writes of the T11 batch plan §2 (`backlog_suggest`, `backlog_take`, `remember`, `publish_agent_plan`, `set_room_mode`, `plan_update`, `plan_submit`, `plan_verify`, `plan_progress`, `propose_completion`, `propose_decision`, `create_room`, `add_to_room`, `attempt_submit`, `attempt_verify`) and `send_message` (moved in from F3, m-7375 ruling 5).

**Extra gates.**
- **Consent (§5.2 write rule, fact 2; accepted, m-7375 ruling 1).** A nested write is dispatched only when Parley holds a human allow for that method in that launch. The allow comes from Parley's effective allow set: the session settings rule written by Parley (autonomous `mcp__parley`) or a human allow rule that the detector already reads. With no allow, the gate answers `ask`, and `ask` means zero calls. The m-4571 "allow while clear" stays for reads only. `onHumanRequest` and script flags are never consent.
- **Per-launch partition.** A write without an allow in a launch stays direct in that launch, so the native permission step keeps working. This is G7 per launch. It means an ordinary interactive session does not reach exactly-three for those writes; autonomous sessions can. The lead has told the human this as a fact (m-7375).
- **Write receipts outside the guest.** Every dispatched write's (ordinal, method, outcome) goes into the execute result envelope, owned by the broker, even when the guest value hits G5. Otherwise an agent that sees `result-bytes` cannot tell that the write happened, and may run it again.
- **Retries.** Writes get no transport retry unless the host replay record for that `callId` is guaranteed to be held. A lost answer is `unknown`, keeps the lease, and the next launch is `blocked` (G4). A transport `unread` is a terminal receipt for reads only (broker header comment); for a write it is `unknown`.
- **Sticky `writesExist` (fact 3).** It is set before the first launch whose allowlist holds a write, never cleared, and read by every build from B0 on.
- **`send_message`.** A write under the rules above. Delivery is human-visible, and a lost answer leaves delivery ambiguous: it is `unknown`, never retried, and the next launch is `blocked` (G4).

**Spec sections reopened.** §5.2 write rule (consent source under m-4571), §4 execute annotations, §5.1 policy source (a per-method answer instead of "allow while clear"), plan effect-family table (writes/approval).

**Feasible without weakening a gate: YES, with conditions.** It holds because the consent gate above and the per-launch partition are accepted (m-7375 ruling 1). Without them, fact 1 would remove the human's permission step for writes, so it would be **NO**. The 5 proposal-style writes (`remember`, `backlog_suggest`, `plan_submit`, `propose_completion`, `propose_decision`) keep their human acceptance in the host. `set_room_mode` and `plan_verify` are not proposals; the host keeps their own boundaries (human-only lowering of the room mode, the verifier's acceptance boundary). Human-only setters are never exposed (§5.2). `attempt_submit` and `attempt_verify`: confined-attempt workspaces (`clone`, `artifacts`) are classic under T12a Delta 10. Whether any live autonomous launch can reach them is **unknown**; their fixtures do not depend on it.

**Dependencies.** B0 (allowlist, `READS` from effect, unknown-method block). **B0 amendment, accepted (m-7375 ruling 2):** the reader of the sticky `writesExist` marker joins B0's acceptance, a few lines plus one launcher test. Without it, a downgrade into a B0-era build would read an unreadable record as classic once writes have shipped. No dependency on other families. F2 and F3 (`close_session`) depend on F1's consent gate, write receipts and retry rule.

**Size (estimate, not measured).** Design 8–12 h. Implementation: a write foundation W0 (consent source, per-launch partition, receipts, retry rule, sticky marker, hints) 14–20 h. Under PARLEY.md it is senior-only, because it touches the write boundary. Then 16 per-method adapters at 2–4 h each (32–64 h, Sonnet). Total about 55–95 h.

### F2 — session creation (4 methods)

**Extra gates.** All of F1's, plus:
- a **new broker route** to the agent-channel endpoints, remote-only and without fallback, under the same gate and audit identity (fact 4);
- **duplicate-spawn prevention:** a host idempotency key on `/agent/sessions`, `/agent/switch` and the swarm endpoints, because today a lost answer followed by a retry can spawn twice;
- **wall versus latency:** `create_session` may take up to 120 s, while the run wall is 30 s. A deadline mid-creation leaves an `unknown` creation and a `blocked` next launch. That is safe, but it would happen routinely.
- **`request_agent_switch`** relaunches the caller. Every later call in the same run must hit the stale-agent fence, and the switch must not drop the run's unsettled calls.
- hints: `openWorldHint: true` once any creation is in the allowlist (G6).

**Spec sections reopened.** §5.2 ("no new host endpoint or transport-status mechanism is assumed"; one remote-only runner); §6 wall bound or an asynchronous creation contract; §7.1 (creation never replayed); T5b1 transport scope.

**Later: YES.** The F2 design (`docs/specs/2026-11-10-code-mode-family-f2-creation.md`, accepted m-7425/m-7426) settles both points below. Creation goes through the existing runner with an in-process host hook (F2-R) and answers at the launch gate (F2-A′); the request key is evidence plus a defense lookup (F2-K).

**Feasible without weakening a gate: UNKNOWN.** No gate has to be weakened in principle. Two open points decide it:
- host idempotency keys on the creation endpoints are a host protocol change the spec does not assume;
- the 120 s versus 30 s mismatch needs either an accepted asynchronous "creation requested" receipt or a higher wall bound for creation runs, and a higher bound is a change of §6.

If neither is accepted, the answer is NO.

**Dependencies.** B0; F1 (consent gate, write receipts, retry rule, sticky `writesExist`).

**Size (estimate, not measured).** Design 6–10 h. Implementation: broker agent-channel route 8–12 h (senior: new authority route); host idempotency 8–12 h (senior: duplicate prevention); 4 adapters at 3–4 h each. Total about 35–50 h.

### F3 — terminal: `report`, `wait_for`, `check_inbox`, `close_session`

`close_session` moved in from F1 because it shares the §7.1 terminal duty; `send_message` moved out to F1 (m-7375 ruling 5).

**Extra gates.**
- **§7.1 "no lost terminal report"** under detector-off. A revoked gate means zero calls (G1). If `report` is migrated, a session whose detector trips mid-task has no way left to report in that launch. This is the OPEN T13 item. The spec says that lifecycle exemption "is not decided here".
- **Read marks (`check_inbox`, `wait_for("inbox")`).** These calls mark mail read. In a script, mail can be marked read and then never reach the model: through G5 (a mailbox over 16 KiB; this room's inbox is far over it), a guest projection, or a lost answer. Keeping the gate needs read marks applied only after delivery to the model. That means a two-phase host operation (peek, then acknowledge), which is a host change.
- **Waiting (§7).** No busy-wait and no runtime slot held for up to 1,800 s. The 30 s wall rules out an in-script `wait_for`. A gate-keeping shape is a terminal await performed by the wrapper outside the guest after the script ends, with the slot released and the lease held only for that one call. Codex's 1,860 s MCP timeout bounds it.
- **`close_session`.** A destructive write under F1's consent gate, write receipts and retry rule. Closing the caller from inside a run must not kill the process that holds the run's lease while calls are unsettled. The design must order it: it is the last dispatch, the broker refuses any later call, and the close takes effect only after the run settles, or `close_session` stays direct.

**Spec sections reopened.** §7 (waits), §7.1 and T13 OPEN item (terminal report, close), §5.2 (report stays classic; close is named; two-phase inbox would be a new host operation), §6 (wall versus waits).

**Feasible without weakening a gate.** Per method:
- `close_session`: YES, under F1, with the ordering condition above;
- `check_inbox`: UNKNOWN; it needs a two-phase host operation;
- `wait_for`: UNKNOWN; it needs the wrapper-level terminal await;
- `report`: **NO** under the current gates. Migrating it either loses the terminal report under detector-off, which breaks §7.1, or lets `report` through a revoked gate, which breaks G1. The lead has sent the question to the human (m-7375 ruling 4). `report` waits on that answer; `check_inbox` and `wait_for` do not.

One possible decision, s-311's suggestion and not the human's: the host writes a `failed` report with reason `code-mode-revoked` when such a session ends without one. That makes no nested call. It is a product choice for the human.

**Dependencies.** B0; F1 (`close_session` uses its consent gate, write receipts and retry rule); the human's answer on the lifecycle disposition (T13 OPEN) for `report`.

**Size (estimate, not measured).** Design 8–12 h. Implementation:
- `close_session` adapter and run-ordering 2–4 h on F1;
- two-phase inbox (host + adapter) 10–14 h, senior;
- wrapper terminal await 10–16 h, senior: slot and lease lifetime;
- `report` not sized until the decision.

Total about 30–46 h with design, without `report`.

### F4 — `find_skill`

**Extra gates.** The stray-execution rule (U2): an unknown call that completes after its run changes the next answer. Here the effect is that `misses` (`tools.ts:1906,1983`) turns the next empty answer's `message` from `NO_SKILL` into `NO_SKILL_AGAIN`. Data (`skills`, `omitted`, `reason`) is not affected; only the advisory text is. Per s-296 (m-7366), the counter is per process, so a guest call and a direct call may not share it.

**Spec sections reopened.** §3.1 row `T11-find_skill`; §4 ("excluded pending effects review"); **ruling D2 (m-7363)**, which kept it direct. D2 is reopened: the human listed `find_skill` explicitly (m-7370; m-7375 ruling 3).

**Feasible without weakening a gate: YES.** The lead chose option (a) (m-7375 ruling 3): the decoder carries `message` as a structured advisory enum, and the design records that a stray miss can only move that advisory, never data or authority. There is no handler change; option (b), a handler change so that a repeat of the same query does not count as a second miss, is not taken. Which process serves the guest call is **not verified**.

**Dependencies.** B0 only (it is a read; it is not in R1–R3). No other family.

**Size (estimate, not measured).** Design 1–2 h; implementation 4–6 h (adapter, schema, fixtures; Sonnet).

## 3. Order (accepted, m-7375)

| # | Family | Why here |
|---|---|---|
| 1 | **F4** | Smallest. Reopens only D2. Depends only on B0, so it can be a fourth R batch next to R1–R3. |
| 2 | **F1** | Builds the write machinery F2 and F3 need: consent gate, per-launch partition, write receipts, retry rule, sticky `writesExist`, hints. The sticky reader lands with B0, before F1. |
| 3 | **F3** | `close_session` reuses F1. `check_inbox` and `wait_for` need their own host and wrapper designs. `report` waits on the human's answer, which the lead has requested in parallel. |
| 4 | **F2** | Largest boundary change: a new broker route plus host idempotency plus the wall question. It needs F1. |

Scope moves accepted by the lead (m-7375 ruling 5) and applied above:
- `send_message` is in F1, since it is a write under F1's rules.
- `close_session` is in F3, since it shares the §7.1 terminal duty.

Activation of every family still waits for INTERIM, T12b and T8h, as plan T11 says. Design and fixture work do not.

## 4. Lead rulings (m-7375)

1. The F1 consent gate is accepted as the reading of §5.2 under m-4571. A write is allowed only from Parley's effective allow set; otherwise the answer is `ask`, zero calls are made, and the method stays direct in that launch. Interactive sessions keep some direct writes; the lead has told the human this as a fact.
2. The sticky `writesExist` reader joins B0's acceptance.
3. m-7370 reopens D2: `find_skill` is in scope. F4 uses option (a): `message` becomes a structured advisory enum. No handler change.
4. The `report` question is with the human. `report` waits on that answer; `check_inbox` and `wait_for` do not.
5. `send_message` moves into F1 and `close_session` into F3. Erratum applied: there are 5 proposal-style writes, not 7.

## 5. Not verified

- Nothing was run: no tests, no tsc, no `tools/list`.
- Whether a human's own allow rules for Parley tools in user/project settings are inside the detector's current effective-source read; F1's consent gate depends on reading them.
- Whether Codex sessions have a per-call human step for Parley writes in classic (approval policy and `readOnlyHint` handling); fact 2 was checked for Claude only.
- Whether `close_session` ends the session MCP process before a run's unsettled calls settle.
- Whether the host replay cache per-session limit can evict a `callId` within one run.
- Which process serves a guest `find_skill` and a direct one.
- How often an unknown write would put a session into `blocked` in practice; for autonomous rooms that stalls the engine until a human acts.
- Whether any autonomous launch outside `clone`/`artifacts` workspaces can reach `attempt_submit`/`attempt_verify` while Delta 10 holds.
- All sizes are estimates from reading code, not measurements.

## Impact card

- **Goal:** order the four non-browser families so that each can be designed without weakening a gate, and say plainly where that is not yet possible.
- **Behaviour:** none; a planning document.
- **Numbers:** 25 methods in scope (F1 16, F2 4, F3 4, F4 1). Feasibility: 18 yes (F1 16 with conditions, `close_session` with conditions, `find_skill`), 6 unknown (F2 4, `check_inbox`, `wait_for`), 1 no under the current gates (`report`, waiting on the human). Hours are estimates, not measured: about 125–200 h of design and implementation in total (sum of the family totals above).
- **Screens:** none.
- **For the human:** writes cannot simply follow the reads' "allow while clear" rule. In classic, Parley asks you before most write tools in an ordinary session, and Code Mode keeps that step: such a write stays a direct tool in that session. Migrating `report` needs your decision on what happens when Code Mode is switched off mid-task.
- **Risk:** reading §5.2 too loosely would silently remove the human's permission step for writes; the sticky `writesExist` reader must ship with B0, before any write.
- **Cost:** not measured; design time only.
- **Verdict:** accepted by the lead (m-7375); order F4 → F1 → F3 → F2.
