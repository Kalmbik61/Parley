# Code Mode T11: remaining methods, residual candidates and parallel batches

Status: **ACCEPTED by s-292 (m-7363, rulings D0–D5 in §5) and s-296 (m-7366, with two B0 additions recorded in B0's acceptance).** Not committed. Author: s-309 (planner). This document assigns no work and authorizes no activation; the lead hands out parts.

Sources read (2026-11-10):

- spec `docs/specs/2026-11-07-code-mode-design.md` (§3.1 inventory, §5.2 broker rules and write rule, §7 waits/browser/rollback) and plan `docs/plans/2026-11-07-code-mode-plan.md` (T11 rows, effect-family table, T13, autonomous continuation) at docs HEAD `ddb74aba`;
- code on `parley/w-0054/s-293` HEAD `d715a789` (committed tree; s-295's uncommitted `tools/` edits ignored) and T12a commit `7a83d601` on `parley/w-0054/t12a`;
- room decisions m-7267 (writesExist duty), m-7324 (16 KiB final cap, result-bytes), m-7332 (mutants only in private clones), m-7338/m-7339 (parallel, test lock serial, T9a gate priority).

## 0. What T11 can and cannot be now

- **Five reads are fixture-migrated, none is activated.** `MIGRATION_REGISTRY.proven` is empty (`migration-registry.ts:43`) and `PROVEN_PROVIDERS` is empty (`proven.ts`, T12a). Every launch is classic. T11 work before INTERIM can therefore only be **fixture-stage** work: adapters, schemas, fixtures and the allowlist plumbing, with the method still direct and non-executable. **Activation** (registry `proven` + removal of the direct declaration) stays behind the plan's T11 dependencies: INTERIM disposition, proven live reads for the provider (T12b), the m-4837 gate, isolation and T8h.
- **The read-only bound is hard-wired to the five-method cohort in seven places.** A sixth read cannot migrate until a foundation batch (B0) replaces "cohort" with "allowlisted read":
  1. `catalog.ts:159` `documented = cohort === 'initial' && effect === 'read' && …`; `catalog.ts:190` revision binds `allowlist: INITIAL_COHORT`;
  2. `broker.ts:205` `methods = gate.launch.methods.filter(m ∈ INITIAL_COHORT)`; `broker.ts:48` `DECODERS` is a fixed five-entry table;
  3. `code-mode-tools.ts:152` `usable()` requires every broker method ∈ `INITIAL_COHORT`;
  4. `migration-registry.ts:65` `registryValid` accepts only cohort methods in `proven`;
  5. `launch-decision.ts:104` `READS` = cohort entries, so a held record naming a migrated non-cohort read would be treated as non-read and **block** the launch;
  6. `work/code-mode-instructions.ts:43` `replacementRouting` throws unless `proven ⊆ cohort`;
  7. `read-output-schemas.ts:27` `READ_ADAPTERS_SHA256` hashes the whole `read-adapters.ts`, so any new decoder in that file moves the `adapterRevision` of all five and the catalogue/api revisions.
- **Two route families are unreachable by the broker at all.** The broker dispatches only through the host `/agent/tools` runner (`createRemoteOnlyCaller`, spec §5.2). `browser_*`, `create_session`, `request_agent_switch`, `create_swarm` and `swarm_add` are answered inside the session MCP process through `context.agent` (`tools.ts` `createParleyServer`, CallTool handler). Migrating any of them needs a new broker route, which is a §5.2 boundary change, not an adapter.

## 1. The remaining methods (45 of 50)

Original universe at `d715a789`: `TOOLS` 30 (incl. `PLAN_TOOLS` with the 3 attempt tools, `plan_tasks`, `publish_agent_plan`) + `find_skill` (navigator only) + 15 `browser_*` (agent channel only) + 4 session tools (session and agent channel only) = **50**, equal to the registry's 5 cohort + 45 direct entries. Short profile hides `remember`, `memory_read`, `search_history` (`mcp-config.ts:48`). Counts are source arithmetic; no `tools/list` was run.

Effect classes used here: **read** (no state change the agent can rely on), **write** (store/state change inside Parley), **terminal** (the four lifecycle/mail operations bound by the room as never migrated), **external** (creates or relaunches agents/sessions; `openWorldHint: true`), **destructive** (`destructiveHint: true` or irreversible). "Route": host = host `/agent/tools` runner; in-proc = session MCP process via `context.agent`.

| # | Method | Source | Annotation | Class | Route | In T11 now? | Why |
|---|---|---|---|---|---|---|---|
| 1 | `memory_read` | `tools.ts` memoryTool | READS | read | host | **yes** (batch R1) | Read; own 64 KiB cap with structured `truncated`; absent in short profile. |
| 2 | `search_history` | `tools.ts` memoryTool | READS | read | host | **yes** (R1) | Read; `total`/`limit`, prose `message` on zero hits; absent in short. |
| 3 | `plan_tasks` | `plan-tasks.ts` | readOnly | read | host | **yes** (R2) | Read; caller-bound plan visibility and paging. |
| 4 | `attempt_status` | `attempt-tools.ts` via `planTool` | readOnly | read | host | **yes** (R2) | Read; autonomous rooms only; host attempt request behind it. |
| 5 | `get_capacity` | `tools.ts` getCapacity | READS | read | host | **yes** (R3) | Read; host machine facts may be missing (`HOST_UNREACHABLE_NOTE`). |
| 6 | `find_skill` | `tools.ts` skillNavigator | READS | read with a side effect | host (navigator launches only) | no (D2, m-7363); **reopened by F4** (m-7370, m-7375): batch R4-find_skill | Annotated read, but `misses` (`tools.ts:1906/1983`) changes the next answer, so a stray second execution changes state; that does not fit U2's stray-read acceptance. Spec row names "miss-counter effects". F4 answers this with an advisory enum (`docs/specs/2026-11-10-code-mode-family-f4-find-skill.md`). |
| 7 | `report` | `tools.ts` | WRITES | terminal | host | no | Room duty: never migrated. §5.2: report stays classic. T13 OPEN lifecycle item. |
| 8 | `wait_for` | `tools.ts` | WRITES | terminal | host | no | Room duty. §7: unsupported in scripts; needs the waiting/mailbox family design. |
| 9 | `check_inbox` | `tools.ts` | WRITES | terminal | host | no | Room duty. Mutates read marks; waiting/mailbox family. |
| 10 | `send_message` | `tools.ts` | WRITES | terminal | host | no | Room duty. Human-visible delivery; delivery ambiguity. |
| 11 | `backlog_suggest` | `tools.ts` | WRITES | write | host | no | §5.2 write rule; human/project consent at the method boundary. |
| 12 | `backlog_take` | `tools.ts` | WRITES | write | host | no | §5.2 write rule. |
| 13 | `remember` | `tools.ts` memoryTool | WRITES | write | host | no | §5.2: concrete human consent; `onHumanRequest` is never proof. |
| 14 | `publish_agent_plan` | `agent-plan-tool.ts` | write | write | host | no | §5.2 write rule; no consent proof exists at its boundary. |
| 15 | `set_room_mode` | `plan-tools.ts` | WRITE | write | host | no | §5.2; human-only lowering. |
| 16 | `plan_update` | `plan-tools.ts` | WRITE | write | host | no | §5.2; concurrent edits/revision. |
| 17 | `plan_submit` | `plan-tools.ts` | WRITE | write | host | no | §5.2; creates a pending human decision. |
| 18 | `plan_verify` | `plan-tools.ts` | WRITE | write | host | no | §5.2; acceptance boundary. |
| 19 | `plan_progress` | `plan-tools.ts` | WRITE | write | host | no | §5.2. |
| 20 | `propose_completion` | `plan-tools.ts` | WRITE | write | host | no | §5.2; human acceptance. |
| 21 | `propose_decision` | `tools.ts` | WRITES | write | host | no | §5.2; human-only acceptance. |
| 22 | `create_room` | `tools.ts` | WRITES | write | host | no | §5.2; atomic creation outcome. |
| 23 | `add_to_room` | `tools.ts` | WRITES | write | host | no | §5.2; moves a session out of its other rooms. |
| 24 | `attempt_submit` | `attempt-tools.ts` | write | write | host | no | §5.2; duplicate/partial outcomes. |
| 25 | `attempt_verify` | `attempt-tools.ts` | write | write | host | no | §5.2; verifier authority. |
| 26 | `close_session` | `tools.ts` | CLOSES (destructive) | destructive | host | no | §5.2 names "close" explicitly. |
| 27 | `create_session` | `session-tools.ts` | openWorld | external | in-proc | no | §5.2 names "session creation"; no broker route. |
| 28 | `request_agent_switch` | `session-tools.ts` | openWorld | external | in-proc | no | Relaunch/lifecycle; creation family; no broker route. |
| 29 | `create_swarm` | `swarm-tools.ts` | openWorld | external | in-proc | no | Session creation; no broker route. |
| 30 | `swarm_add` | `swarm-tools.ts` | openWorld | external | in-proc | no | Session creation; no broker route. |
| 31 | `browser_tabs` | `browser-tools.ts` | READ | read | in-proc | no | §7: all browser tools stay classic initially, read-looking ones included; browser family design; no broker route. |
| 32 | `browser_console` | `browser-tools.ts` | READ | read | in-proc | no | Same. |
| 33 | `browser_network` | `browser-tools.ts` | READ | read | in-proc | no | Same; sensitive headers. |
| 34 | `browser_screenshot` | `browser-tools.ts` | READ | read | in-proc | no | Same; §7 requires image/resource delivery without guest base64. |
| 35 | `browser_snapshot` | `browser-tools.ts` | READ | read | in-proc | no | Same; refs and untrusted text. |
| 36 | `browser_downloads` | `browser-tools.ts` | READ | read | in-proc | no | Same; paths, no ambient guest filesystem. |
| 37 | `browser_wait_for` | `browser-tools.ts` | READ | read (a wait) | in-proc | no | Same; also a wait (§7). |
| 38 | `browser_open` | `browser-tools.ts` | CONTROL | write | in-proc | no | §7; navigation side effects. |
| 39 | `browser_navigate` | `browser-tools.ts` | CONTROL | write | in-proc | no | §7; unknown navigation outcome. |
| 40 | `browser_action` | `browser-tools.ts` | CONTROL | write | in-proc | no | §7; never replay page actions. |
| 41 | `browser_resize` | `browser-tools.ts` | CONTROL | write | in-proc | no | §7; shared-page mutation. |
| 42 | `browser_close` | `browser-tools.ts` | CONTROL | write | in-proc | no | §7; plan row says write. |
| 43 | `browser_evaluate` | `browser-tools.ts` | SCRIPT (destructive, openWorld) | destructive | in-proc | no | §7 and §5.2. |
| 44 | `browser_cookies` | `browser-tools.ts` | SECRETS (destructive) | destructive | in-proc | no | §7; secrets; can sign the human out. |
| 45 | `browser_storage` | `browser-tools.ts` | SECRETS (destructive) | destructive | in-proc | no | §7; per-origin writes. |

Totals: read 13 (5 in T11 scope, `find_skill` kept direct by D2, 7 browser reads blocked by §7), write 20 (15 store writes + 5 browser control), terminal 4, external 4, destructive 4 (`close_session` + 3 browser). In T11 scope now: **5 reads**.

## 2. Residual candidates: may not migrate without a new reviewed design

These **40** methods get **no T11 attempt** in this plan. Each needs a design the spec does not yet have; none exists in the docs tree at `ddb74aba`.

| Group | Methods | Spec reason | Design that would reopen it |
|---|---|---|---|
| Terminal (room duty) | `report`, `wait_for`, `check_inbox`, `send_message` | Room binding duty: never migrated. §5.2: report stays classic. §7: `wait_for` unsupported in scripts. T13 OPEN item: report/close/mail under detector-off vs §7.1 "no lost terminal report". | None planned; T13 records them. **Later rulings:** `report` stays direct permanently (human m-7377); `send_message` moves to F1 (m-7375 (5), W-B m-7387); `wait_for` and `check_inbox` are F3 (`docs/specs/2026-11-10-code-mode-family-f3-terminal.md`, accepted m-7405/m-7406), as is `close_session`. |
| Store writes | `backlog_suggest`, `backlog_take`, `remember`, `publish_agent_plan`, `set_room_mode`, `plan_update`, `plan_submit`, `plan_verify`, `plan_progress`, `propose_completion`, `propose_decision`, `create_room`, `add_to_room`, `attempt_submit`, `attempt_verify` | §5.2: "Writes are a separate future design and senior-only review gate… prove concrete human consent at the underlying method boundary; otherwise remain classic before dispatch." Also m-5887 (execute hints must reach the maximum effect first), no-fsync (m-5920), the "200 = answering attempt only" guarantee. | Writes/approval/creation/terminal-lifecycle family design (plan effect-family table: s-290 + s-296). **Done for these 15 and `send_message`: F1** (`docs/specs/2026-11-10-code-mode-family-f1-writes.md`, accepted m-7387/m-7388): W0 then W1–W6. |
| Close | `close_session` | §5.2 names "close" explicitly; destructive. | Same family. |
| Creation | `create_session`, `request_agent_switch`, `create_swarm`, `swarm_add` | §5.2 names "session creation"; external; served in-proc, so no broker route exists. | Same family, plus a §5.2 route reopening. **Done: F2** (`docs/specs/2026-11-10-code-mode-family-f2-creation.md`, accepted m-7425/m-7426): F2-H, then A1 and A2. |
| Read with a side effect | `find_skill` | Plan row: "miss-counter effects"; a read that changes its own next answer does not fit U2's stray-read acceptance (ruling D2, m-7363); navigator-only. | A design that makes the counter safe under stray execution, or an accepted read-with-effect class. **Done: F4** (`docs/specs/2026-11-10-code-mode-family-f4-find-skill.md`, accepted m-7383/m-7384); the method leaves this list. |
| Browser | all 15 `browser_*` | §7: "All browser tools remain classic initially, including read-looking browser methods and screenshots"; served in-proc via the agent channel. | Browser family design (s-290 + s-296) and a §5.2 route reopening. |

Labelling (D1, m-7363): T13 records each of the 40 as **"named TEMPORARY residual — not attempted: spec §5.2/§7 forbids migration without a reviewed design"**, with its schema hash, kept apart from residuals left after two unsuccessful bounded attempts. Permanent disposition stays human-only; s-292 informs the human.

## 3. Batches

Rule kept from plan T11: each method is still its own task and is accepted, activated and if needed restored on its own. A batch groups work for one executor and one worktree; it is not a batch permission grant. The R batches are the "junior-only fixture/DTO subtasks separately scoped by the lead" that plan T11 allows; authority and activation stay senior-reviewed.

Order: **integration merge (frozen) → B0 → (R1 ∥ R2 ∥ R3) → merge R1, R2, R3 in that order → A-<method> one at a time after the activation gates.** B0 and R1–R3 run at the fixture stage now (D0). Only the test lock `/private/tmp/parley-r25-tests.lock` is serial (FIFO, T9a gate first). Mutants run only in private clones (m-7332).

### B0. Allowlisted-read foundation — SENIOR-ONLY (s-293)

Why senior: it widens what the guest may execute (authority/security boundary, §5.2), changes held-record handling in `selectExposure` (recovery, T8h), and carries the write-boundary duty m-7267 and the m-5887 hint rule.

Scope (files fixed by the lead before handoff; this is the expected set):

- `code-mode/migration-registry.ts` (+test): entries gain `effect`; a data list `MIGRATABLE_READS` (cohort five plus the T11 reads, initially empty beyond the five); `registryValid` accepts in `proven` exactly the migratable reads that this launch has, and never a non-read.
- `code-mode/catalog.ts` (+test): `documented` = allowlisted ∧ `effect === 'read'` ∧ signature available; revision binds the allowlist (catalogVersion 3). A migratable read that is not in `proven` gets **no callable guest stub** (test).
- `code-mode/broker.ts` (+test): methods = gate methods ∩ allowlist; `non-read-method` refusal kept; `DECODERS` read from a new table module.
- New `code-mode/read-adapter-table.ts`: one line per decoded method (decoder + schema + per-adapter revision). The five move here unchanged.
- `code-mode/read-adapters.ts`: export the shared helpers (`run`, `rest`, `readCut`, `readPage`, `readTextPage`, `echo`) unchanged, so new decoders live in their own files.
- `code-mode/read-output-schemas.ts` (+test): replace the whole-file `READ_ADAPTERS_SHA256` with a per-adapter-file hash map, so a new adapter file does not move the five's `adapterRevision`. Tests compute expected revisions; no literal hash that every batch must move, other than its own file's.
- `mcp/code-mode-tools.ts` (+test): `usable()` uses the allowlist; execute hints stay `readOnlyHint: true`-compatible and a test ties them to the maximum effect of the allowlist (m-5887: still all reads).
- `code-mode/launch-decision.ts` (+test): `READS` from registry `effect === 'read'`, not from `cohort`.
- `work/launch-exposure.ts`, `work/launch.ts` (+`launch-exposure.test.ts`): `decideLaunchExposure` passes `writesExist` computed from the broker catalogue/registry (false while every migratable method is a read) into `selectExposure`, with a launcher test for both values (m-7267).
- `work/code-mode-instructions.ts` (+test): `replacementRouting` accepts `proven ⊆ migratable reads`.

Acceptance:

- Behaviour with the shipped registry is unchanged: same five documented methods, `proven` empty, classic everywhere; T9a's `tools/parley-token-benchmark-replay-launch.ts` (imports `MIGRATION_REGISTRY`, `replacementRouting`) still gives the same shipped routing. `tools/` is not edited; the tools project test run stays green.
- A fixture registry with a sixth read: documented, decoded, executable only when `proven` and policy `allow`; deny/ask/unknown/stale/revoked → zero dispatch.
- A fixture write in the allowlist is refused at registry, catalogue and broker (three independent refusals), and `writesExist` becomes true only from the catalogue, never from a script or env.
- Held record naming a migrated non-cohort read → classic `held-run`, not `blocked`; naming a write → `blocked`; unreadable + writesExist → `blocked`.
- A held record naming a method that is **not in this build's registry** (a downgrade, or a record written between an R-batch merge and its restoration) → `blocked`, reason `non-read-record`, never classic; one launcher test (s-296, m-7366).
- Binding on the write-family design: **`writesExist` must be true if any build that could have written this record could execute a write: sticky once a write ships, or read from the record's own header — never from the current build alone.** In T11 no write enters the allowlist, so it stays false and this costs no code (s-296, m-7366).
- B0 edits `read-adapters.ts` (helper exports), so it moves the five methods' `adapterRevision` once; B0's report says so, so that a revision pinned in another test is not a surprise. After B0, the per-adapter-file hash map keeps R batches from moving each other's revisions.
- Mutants on every changed predicate; core tsc; direct dependents and the routing sweep on Node 22.16.0 and 22.23.3 under the lock; zero skips.

Reviewers: s-296 (isolation/recovery) and s-292 (contract); verifier named by the lead. Size (estimate, not measured): 12–14 files, about +450/−90 including tests.

### R1. `memory_read`, `search_history` — junior (Sonnet)

- New files: `code-mode/read-adapters/memory-read.ts`, `search-history.ts`, their schemas (`read-output-schemas/…` or inside the adapter file as B0 decides) and tests.
- Shared edits (append-only): two lines in `read-adapter-table.ts`, two names in `MIGRATABLE_READS`.
- Fixtures from the real handler (`memoryTool`) over a synthetic project memory/history: ids filter, unknown ids, malformed ids (tool-error), `truncated` at 64 KiB (→ `partial`), `total`, zero hits with `message`, scopes, limit.
- Method-specific: absent in short profile → not in catalogue, not invented; `onRequest`/`by` kept verbatim.
- 16 KiB: a classic `memory_read` of about 64 KiB → guest result `invalid-output` + `limit-reached`/`result-bytes`; the same content is reachable through `ids` slices (named surface limit, m-7324).
- Size: 6–8 new files, about +600 including tests.

### R2. `plan_tasks`, `attempt_status` — junior (Sonnet)

- New adapter files, schemas, tests; two table lines, two registry names.
- `plan_tasks`: caller-bound visibility (another session's plan never appears), paging, errors as data.
- `attempt_status`: list form and `attemptId` form (paged JSON text, `cursor`/`maxBytes`), missing attempt, non-member refusal; no mutation (a test reads the store before and after).
- Size: 6–8 new files, about +600.

### R3. `get_capacity` — junior (Sonnet)

- New adapter file, schema, test; one table line, one registry name.
- Rows when the host answers and when it does not (`HOST_UNREACHABLE_NOTE`): the missing host facts must be `partial` or `unknown` by a structured field, never by reading the note's prose; if the handler has no structured mark, the decoder returns `unknown` for that case and the batch reports it.
- Arguments refused (`get_capacity takes no arguments`) → tool-error.
- Size: 3–4 new files, about +350.

R4 (`find_skill`) was dropped by D2 (m-7363). It is restored as **R4-find_skill** by F4 (m-7370, m-7375): Sonnet, on B0, in parallel with R1–R3, merged after R3. Its scope, acceptance and mutants are in `docs/specs/2026-11-10-code-mode-family-f4-find-skill.md` §4.

### Acceptance common to every R batch, per method

1. **Decoder parity with classic:** for every request branch, the real handler's classic JSON text, strictly parsed, deep-equals the decoded guest value plus `unknownFields`; `isError` results are `tool-error` verbatim; a malformed shape is a fixed `invalid-output` code with assessment `unknown`, never an empty success.
2. **Completeness / incomplete floor:** `partial` only from a structured omission mark, otherwise `unknown`; a broker run that returns or drops a partial/unknown read ends `incomplete: true`; an own-cap cut is the terminal `unread` receipt (read effect only).
3. **Conservation:** `checkReplacement` over full, short, agent and navigator variants gives migrated ∪ direct = original and migrated ∩ direct = ∅; nothing absent is invented.
4. **Policy:** deny/ask/unknown/stale/revoked → zero dispatch for that method; the stale-agent fence behaves as classic (these reads are in `AGENT_FENCE_FREE`).
5. **16 KiB final cap:** a fixture over 16,384 B yields `limit-reached`/`result-bytes`; exactly 16,384 B passes.
6. **Mutants** on the new decoder and schema in a private clone; survivors named.
7. **Routing sweep** (`code-mode-routing-manifest` test) green; new file names classified if the sweep asks.
8. Both Nodes, core tsc, direct dependents (adapter table, schemas, catalogue, broker, code-mode-tools, registry, launch-decision, code-mode-launch), under the lock, zero skips. No original handler file is edited.

Bounded attempt: one freeze per method that fails review or verification counts as one attempt. Restoration after a failed attempt (plan T11): the method's name is removed from `MIGRATABLE_READS` and its table line, the verifier checks that it is direct with its original schema hash, and the conservation partition holds.

### A-<method>. Activation — after the gates, one method per commit

- Depends on: INTERIM disposition, `PROVEN_PROVIDERS` containing the provider (T12b), T8h, the method's R acceptance.
- Change: add the name to `MIGRATION_REGISTRY.proven` (`directOf` and the `read_guide` overlay follow the registry). One file plus its test, about +20 lines.
- Checks: the direct declaration disappears for that method only; calling it directly gives `unknown tool`; the guide routes it to `parley.<method>`; conservation; real-client regression for the provider.
- Serial: every activation edits the same `proven` list. Implementer: Sonnet; s-296 reviews authority; s-308 verifies conservation (D3, m-7363).

### Shared files and conflict order

| File | B0 | R1 | R2 | R3 | A-* |
|---|---|---|---|---|---|
| `code-mode/read-adapter-table.ts` | creates | +2 lines | +2 | +1 | — |
| `code-mode/migration-registry.ts` `MIGRATABLE_READS` | creates | +2 names | +2 | +1 | — |
| `code-mode/migration-registry.ts` `proven` | — | — | — | — | +1 each, serial |
| `code-mode/read-output-schemas.ts` | rewrites the hash scheme | +2 entries only if B0 keeps schemas central | +2 | +1 | — |
| `code-mode/catalog.ts`, `broker.ts`, `code-mode-tools.ts`, `launch-decision.ts`, `launch-exposure.ts`, `launch.ts`, `code-mode-instructions.ts` | edits | — | — | — | — |

R batches edit nothing else that is shared. Merge order R1 → R2 → R3; each later batch rebases on the previous merge and resolves only its append lines, then reruns its own tests under the lock.

### T9a replay harness

No new goals are needed for T11. Goals r2 (`read-workflows.json`, docs `ddb74aba`) exercise `get_map` (29), `read_room` (4) and `close_session` (1); T11 acceptance rests on handler fixtures, not on replay. B0 must keep the T9a shipped routing identical while `proven` is empty. Measuring the new reads in FINAL T10 workflows would need goals r3 with an independent author and a separate review (decision D4); it is not part of these batches.

## 4. Base branches and sizes

| Batch | Base | Worktree / branch (proposed) | Size (estimate, not measured) | Implementer tier |
|---|---|---|---|---|
| B0 | the integration merge `parley/w-0054/s-293` HEAD + `parley/w-0054/t12a` `7a83d601`, built first by the B0 executor in its own worktree and resolved as s-306's trial report shows; the merge is frozen and s-296 reviews only its hunks; B0 goes on top of it (m-7363) | `w-0054-t11-b0` / `parley/w-0054/t11-b0` | 12–14 files, +450/−90, plus the merge | senior (s-293) |
| R1 | B0 commit | `w-0054-t11-r1` / `parley/w-0054/t11-r1` | 6–8 files, ~+600 | Sonnet |
| R2 | B0 commit | `w-0054-t11-r2` / `parley/w-0054/t11-r2` | 6–8 files, ~+600 | Sonnet |
| R3 | B0 commit | `w-0054-t11-r3` / `parley/w-0054/t11-r3` | 3–4 files, ~+350 | Sonnet |
| A-<method> | the merge of R1–R3 | the integration branch | 1–2 files, ~+20 each | Sonnet (D3) |

B0 bases on the T12a merge because B0 edits `launch-exposure.ts`/`launch.ts` (only in T12a) and `code-mode-tools.ts`, `broker.ts`, `native-policy.ts`-adjacent code that both branches changed. No batch touches `tools/` (T9a).

## 5. Decisions (rulings of s-292, m-7363)

- **D0 — yes.** B0 and R1–R3 run at the fixture stage now; activation waits for INTERIM.
- **D1 — accepted.** The 40 are labelled "named TEMPORARY residual — not attempted: spec §5.2/§7 forbids migration without a reviewed design", with their schema hash, kept apart from residuals left after two failed attempts. s-292 informs the human; permanent disposition stays human-only.
- **D2 — `find_skill` stays direct.** It joins §2 and R4 is dropped: a read that changes its own next answer does not fit U2's stray-read acceptance, and one navigator-only method is not worth a batch. s-296 adds (m-7366): the counter is a closure per `skillNavigator` instance (`tools.ts:1906`), so it is per process, and whether a guest call and a direct call share it depends on which process serves each. **Superseded** by the human's m-7370 and the lead's m-7375 (3): `find_skill` is in scope as F4, with `message` as a structured advisory enum and no handler change; R4-find_skill is restored (F4 design, accepted m-7383/m-7384).
- **D3 — Sonnet implements activation commits;** s-296 reviews authority (s-290 is closed); s-308 verifies conservation.
- **D4 — no goals r3 in T11.**
- **D5 — the human's call;** whether a write-family or browser-family design starts is not part of this plan.
- **B0 base:** the B0 executor first builds the integration merge (s-293 HEAD + t12a `7a83d601`) in its own worktree, resolved as s-306's trial report shows; the merge is frozen, s-296 reviews only its hunks, and B0 goes on top of it.

## 6. Not verified

- Nothing was run: no tests, no tsc, no `tools/list`. Every count is from reading source at `d715a789` and `7a83d601`.
- That the host `/agent/tools` runner answers `get_capacity` (host facts through `context.capacity`) and `attempt_status` exactly as the direct path does in a remote launch.
- Whether `declarationsFor`/`code_docs` would emit a declaration for a documented but not enabled method; B0's "no callable guest stub" test must settle it.
- Which existing tests pin literal catalogue, registry or adapter revision hashes, and so how many expectations B0 moves.
- Whether the T9a harness pins `REGISTRY_REVISION`, `apiRevision` or catalogue revisions beyond the `MIGRATION_REGISTRY` import found in `replay-launch.ts`.
- Whether `get_capacity` output has a structured mark for missing host facts (R3 may have to return `unknown`).
- Whether `code-mode-instructions.ts` needs a per-method example entry (`:86`) for each migrated read.
- Conflicts between `s-293` and `t12a`: s-306's trial integration is pending.
- Realistic output sizes of the five reads against the 16 KiB final cap.
- Effect classes come from annotations and handler reading, not from observed behaviour.

## Impact card

- **Goal:** split T11 into parallel parts without crossing the spec's write rule.
- **Behaviour:** none; a plan only. If executed: 5 more reads reachable inside `code_execute`; 40 methods stay direct.
- **Numbers:** 50 original methods; 5 fixture-migrated (none activated); 45 remaining: 5 reads in scope, 40 named residual candidates. Sizes above are estimates, not measured.
- **Screens:** none.
- **For the human:** the exactly-three target cannot be reached by T11 alone: 40 methods need write, browser, lifecycle or side-effect designs that do not exist yet.
- **Risk:** B0 widens the guest allowlist; it is senior-only and reviewed by s-296 and s-292.
- **Cost:** not measured.
- **Verdict:** accepted by s-292 (m-7363) and s-296 (m-7366).
