# Code Mode family F1: store writes and `send_message`

Status: **ACCEPTED** by s-292 (contract, m-7387) and s-296 (isolation, concurrency, recovery: CLEAR with R1–R4 in W0's acceptance, m-7388). Author: s-312 (family designer).

Scope: the 16 methods of F1 (families order, `docs/plans/2026-11-10-code-mode-families-order.md`, commits `c76e9612`, `f695fcdf`). They are moved into `code_execute` under the human's decision m-7370 and the lead's rulings m-7375: (1) the consent gate, (2) the sticky `writesExist` reader in B0, (5) `send_message` in F1. The document has two parts:
- the write foundation **W0**, senior-only under PARLEY.md because it is the write boundary;
- six adapter batches **W1–W6** for Sonnet executors.

No gate of the families order §1 (G1–G8) is weakened.

Sources read (2026-11-10, nothing run):
- `parley/w-0054/t12a` `7a83d601`:
  - `core/src/mcp/code-mode/{native-policy,detector,broker,catalog,migration-registry,launch-decision,run-record,contracts}.ts`;
  - `core/src/mcp/{code-mode-tools,remote-tools,tools,plan-tools,attempt-tools,agent-plan-tool}.ts`;
  - `core/src/work/{settings-file,mcp-config,launch,code-mode-instructions}.ts`;
  - `host/src/agent/tools-endpoint.ts`.
- A read-only survey of the 16 handlers. Its citations are below as `file:line`.
- Spec `docs/specs/2026-11-07-code-mode-design.md` §4, §5.1, §5.2, §6, §7, §7.1; plan T11; T11 batch plan `0cd2b6c5` (B0, R1–R3, common acceptance).

## 1. Facts that shape the design

1. **Classic consent differs by provider and launch.**
   - **Claude** (`settings-file.ts:254–263`): autonomous (workspace) launches get `permissions.allow: ["mcp__parley"]`, so every Parley tool is pre-allowed. An ordinary session gets no Parley allow except `mcp__parley__close_session` and the browser rules, when `allowBrowser` is set. Every other Parley write in an ordinary Claude session goes through the human's permission card (`feed-service.ts:697–757`, `reduce.ts:718`), unless the human's own settings allow it. A card answered "always" writes the suggested rule into the client's settings (`decisions.ts:48–54`).
   - **Codex** (`mcp-config.ts:232–247`): Parley writes `default_tools_approval_mode="approve"` for the `parley` server, so Codex runs every Parley tool **without a prompt**. The comment notes that a per-tool `tools` table would override that mode.
   - **GLM** uses Claude's semantics. A custom client has no documented semantics.
2. **The live policy source answers one verdict for every method** (`detector.ts:183`): `allow` while clear. It reads **no** `permissions.allow` rule. Today it reads only Parley's `codeMode` key (`detector.ts:95–119`), and `PROVIDER_ROWS` is empty (`provider-rows.ts:14`), so a live source is never clear in this build.
3. **The gate already asks the source per exact call** (`native-policy.ts:282`, `PolicyQuery {method, args, argsSha256}`). A per-method answer needs no new gate API.
4. **The result already carries broker-owned receipts.** `ExecuteResult.operations` holds `{ordinal, method, argsSha256, dispatched, outcome, responseBytes, incomplete}` (`contracts.ts:403–437`). It survives a value over 16 KiB: the second attempt in `code-mode-tools.ts:347–350` keeps `operations`. Only the last resort, `fixed(FAILED_TEXT)` (`code-mode-tools.ts:357`), drops them.
5. **Retries reuse one `callId` per prepared call** (`remote-tools.ts:504`), and the host joins or replays a seen `callId` (`tools-endpoint.ts:166–213`). The host replay memory is in memory only: 10 min TTL after settle and 256 records per session. Eviction (`tools-endpoint.ts:179–182`) removes the oldest keys, **running ones included**. A host restart revokes the token (401).
6. **Duplicates.** A second identical classic call:
   - **writes again:** `send_message` (a second letter), `create_room` (a second room; members move again);
   - **refreshes in place:** `backlog_take` by the same taker, `publish_agent_plan`, `plan_progress`, `plan_update` (one more log line);
   - **is a no-op or a conflict:** `set_room_mode`, `add_to_room`, `plan_submit`, `plan_verify`;
   - **is caught by a host key:** `backlog_suggest`, `remember`, `attempt_submit`, `attempt_verify`, autonomous `propose_decision`;
   - **replaces the card** with `rev+1`: `propose_completion` and non-autonomous `propose_decision`.
7. **All 16 are fenced** (none is in `AGENT_FENCE_FREE`, `tools.ts:2035`). All 16 are `WRITES`/`WRITE` with `readOnlyHint:false`, `destructiveHint:false`, `openWorldHint:false`, so `effectOf` gives `write`. All are served by the host `/agent/tools` runner. The attempt tools and autonomous `propose_decision` go on to `context.attempts` in the host (`host.ts:518`).
8. **Errors after a commit are possible.**
   - Plan tools run `flushPlanEffects` after the transaction (`plan-tools.ts:433–445`). A flush failure is reported as `effects.unavailable`, not as an error.
   - The backlog and memory feed lines are a separate `writeLetters` after the store write. A failure there is reported as `feedUnavailable:true`.
   - The generic catches are "Plan operation could not be completed." and "Backlog operation could not be completed.". Whether they can follow a commit is **not verified**, so a write's tool-error does **not** prove that nothing was written.
9. **The run record has no fsync** (`run-record.ts:12–13`, m-5920). After power loss, a write's effect can survive its lost intent.

## 2. W0 — the write foundation (SENIOR-ONLY)

Why senior (PARLEY.md): it widens what the guest may execute (§5.2 write boundary); it changes the policy source, the launcher's allowlist and held-record handling (recovery); and it changes scheduler admission (concurrency).

### W0.1 Consent source (§5.2 under m-4571; ruling m-7375 (1))

A new pure module `code-mode/consent.ts` computes the launch's **Parley consent set**: `'all'` or a set of method names. It reads the same effective sources that the provider's T12a row inspects, and it reads them only while the detector scan is clear.

| Provider | Consent set |
|---|---|
| Claude, GLM | Union of `permissions.allow` entries in Parley's session settings file and in the user, project and local settings. `mcp__parley` → `'all'`. `mcp__parley__<method>` (exact) → that method. Any other spelling, wildcard or pattern gives **no** consent. Permission modes (`auto`, `acceptEdits`, bypass) give no consent. |
| Codex | `'all'` when the effective `mcp_servers.parley.default_tools_approval_mode` is `"approve"` (Parley writes it). A method whose effective per-tool `approval_mode` is anything else is removed from the set. That case is also a detector trigger (ask/deny for a Parley method, §5.1), so in practice the scan is not clear. |
| custom | Empty. |

Rules:
- **Policy answer per call.** The live source's `decide(q)`:
  - not clear → `revoked` (unchanged);
  - `q.method` is a read → `allow` (unchanged, m-4571);
  - a write in the consent set, **re-read at this check** → `allow`;
  - otherwise → `ask`, which means zero calls (G1).
- **Re-reading.** The set is re-read at every execute, nested call and retry check, from the same fingerprints as the detector. If a rule is removed mid-launch, that method answers `ask` from then on. It is not a terminal `revoked` for the whole gate, so reads keep working. The method stays migrated in that launch, so the agent cannot run it until the next launch (W-A, accepted m-7387).
  The cost is named (s-296, m-7388): such a method has no direct twin, so it cannot run until relaunch. For `send_message` that silences the session's mail for the rest of the launch; `report` stays direct.
- **One read for detector and consent (s-296 R2).** Consent is taken from the same bounded bytes (`readBounded`) that the detector classified in that synchronous stretch, never from a second read. A second read could stall on a FIFO or an oversized file outside the detector's bounds and its latch. It could also judge a different file than the detector did.
- **Launcher and session use the same reader (s-296 R3).** The launcher's allowlist (W0.2) is computed by the session's reader: the same module, `readBounded`, symlinks refused, at most 1 MiB. A source that this reader refuses gives no consent, so the write stays direct and is never migrated without a usable twin.
- **Check-to-dispatch window (s-296 R1; spec §5.1 runtime binding).** Consent is re-read synchronously inside the dispatch edge: deadline → `gate.decide`/`authorize` (consent from the current stretch's scan) → prepare → intent → attempt 1 sent synchronously in `send()`. The window is that one synchronous stretch, the same residual window as for reads. A rule removed by another process within it is not seen, and the write goes out.
  - **Named afterwards.** Before the run's result is made, the broker re-reads consent once for every dispatched write. If a method's consent is gone, the result carries `consent-withdrawn` with `params: {method, ordinal}` naming that dispatched operation.
- **The agent is told why.** Such a refusal carries a new fixed diagnostic `consent-withdrawn` with `params: {method}`. Its closed message is: "consent for <method> was withdrawn in this launch; it runs again as a direct tool after relaunch". No other text, and no host or guest text, enters it (m-7387).
- **What is never consent:** `onHumanRequest`, a script flag, a guest argument, an environment value, the catalogue or the manifest. A manifest only narrows.
- **Fixture authority stays separate.** `consent.ts` reads files only through the provider row's source set, and a fixture mint cannot reach a live launch (§5.1).

### W0.2 Per-launch partition

- **Allowlist.** At launch, the launcher computes the allowlist as `MIGRATABLE_READS ∪ (MIGRATABLE_WRITES ∩ consent set)`, with the same reader as W0.1. A write without consent is **not** in the allowlist and stays a direct tool in that launch, so the client's own permission step keeps working (G7 per launch).
- **Proven names.** `proven` stays global, and the effective proven set is `proven ∩ allowlist`. `checkReplacement`, `replacementRouting` and the exposure record (`migrated`/`residual`) use the effective set. So migrated ∪ direct = original and migrated ∩ direct = ∅ hold per launch by construction.
- **Consequence (told to the human, m-7375).**
  - Autonomous Claude launches can reach exactly-three for writes.
  - Ordinary Claude sessions keep direct writes unless the human allows them.
  - Codex launches can migrate all 16, because classic Codex has no per-call step for Parley tools (§1.1).

### W0.3 Effects in catalogue, broker and registry

- **Registry.** `MIGRATABLE_WRITES` is a data list, created empty; each adapter batch appends to it. Every registry entry carries `effect`, which B0 adds.
- **Catalogue.** `documented` = allowlisted ∧ signature available ∧ (`effect === 'read'` ∨ (`effect === 'write'` ∧ in this launch's allowlist)). `destructive` and `unknown` are never documented by F1; F3 decides `close_session`.
- **Broker.** The run's methods are the gate's eligible methods ∩ allowlist. The `non-read-method` refusal becomes `effect-not-allowed`, raised for `destructive`, `unknown` or a write that is not in the allowlist.
- **Contract.** The contract version is bumped once; the reviewers judge whether a new refusal code needs it.

### W0.4 Write receipts outside the guest

- The receipts are `ExecuteResult.operations` (fact 4), which the broker owns.
- W0 keeps them in **every** result of a run that dispatched a write. The last-resort `fixed(FAILED_TEXT)` is replaced, for such runs, by a fixed minimal result that carries `runId`, `incomplete: true` and `operations`, with a contract test at 32 operations.
- An `unknown` write also gets the existing `call-unsettled` diagnostic.
- A test proves it: a script that writes and then returns a value over 16,384 B still reports the write's `ordinal`, `method`, `argsSha256` and `outcome: 'succeeded'`.
- The guest's value is never the only record of a write.
- **A cancelled `code_execute` (s-296 R4).** The SDK sends no answer at all to a cancelled request (H2c-2; SDK 1.30.0 `protocol.js:369`). A write dispatched before the cancel then lives only in the run record. The agent sees no receipt, the record stays `unaccounted` naming the write, and the next launch is `blocked/non-read-record` (W0.7). This limit is named, not solved.

### W0.5 Retry and settlement rule

- **No transport retry for a write.** `beforeRetry` returns `false` when the method's effect is `write`, so the first retryable failure ends as `unknown('retry-not-authorized')`.
- **Why "never".** "Unless the host replay record is guaranteed held" (families order) cannot be met: eviction can drop a running record (fact 5), the memory is not durable, and a restart revokes the token. Zero retries is the only rule that holds.
- **`unread` is not a terminal receipt for a write.** The cases are a truncated 200, a route refusal, an unreadable envelope and an invalid result. For a write each becomes `unknown`: the lease is held, and the next launch is `blocked` (G4).
- **Tool errors.** A 200 with `isError` is a terminal `failed` receipt, as in classic: the agent sees the same error text. It does **not** prove that nothing was written (fact 8), and the declaration says so.
- **Intent.** The intent is still written to the run record before attempt 1 (`broker.ts:229`). Power loss can lose it after the effect (fact 9, m-5920). That limit is the same as a classic call lost to power loss, and it is named, not solved.

### W0.6 Sticky `writesExist` (ruling m-7375 (2))

- **Marker.** `code-mode/<session>.writes.json` holds `{v:1, at, launchId}`, written atomically with mode 0600 under the run-record directory rules.
- **Reader (in B0, accepted m-7375 (2)).**
  - present → `true`;
  - unreadable, oversized, not a regular file, or of an unknown version → `true` (fail closed);
  - absent → `false`.
  
  `writesExist` = catalogue writes ∨ marker.
- **Writer (W0).** The launcher writes the marker **before** writing a launch decision whose allowlist holds a write. If the write fails, writes are dropped from that launch's allowlist; that launch is reads-only, not refused.
- **Lifetime.** The marker is never removed by Code Mode; only session deletion removes it (`deleteSessionFiles`).
- **Trust.** It is accounting-level trust, like the run record: the agent's own shell could delete it. That limit is the same as the run record's and is named.

### W0.7 Held records

`selectExposure` is unchanged. A record naming a write (not in `READS`) gives `blocked/non-read-record`. An unreadable record with `writesExist` gives `blocked/unreadable-record`.

Consequence: after an `unknown` write, the next launch of that session waits for a human (T8h's explicit blocked handoff). For autonomous rooms this stalls the engine until a human acts. That is the safe side of G4, and it is named in the card.

### W0.8 Concurrency: a write runs alone (W-C, accepted m-7387)

The scheduler admits a write only when no other call of the run is in flight, and admits no call while a write is in flight. Reads keep their two-in-flight limit.

Reasons:
- Classic order between a script's writes and its reads stays the order the script awaited.
- A failure of one write never races a second write.
- `Promise.all` over writes becomes sequential, never parallel.

Test: `Promise.all([send, send])` gives two dispatches whose host start times do not overlap, and a third call queued behind them.

### W0.9 Hints and texts (m-5887)

- **Annotations per launch.** `code_execute` keeps `readOnlyHint:false`. `destructiveHint` and `openWorldHint` stay false for F1, because none of the 16 is destructive or open-world. A test ties them to the maximum effect of the launch's allowlist; F2 and F3 move them.
- **Description per launch.** "Only read methods can run" becomes "Read methods, and the write methods code_search lists as executable, can run".
- **Search.** `code_search` shows `effect` per method (existing field).

### W0.10 Write adapters (shared shape)

- **Module.** A new `code-mode/write-adapters.ts` holds the shared helpers: strict JSON parse, `rest`, and a `runWrite` built like `run`.
- **Result type.** `WriteResult<T>` = `ReadResult<T>`, the same union. The host assessment is fixed `complete`, because completeness is a read notion. Ledger state is the operation's outcome, so a malformed answer is `succeeded` plus a guest `invalid-output`.
- **Table.** `write-adapter-table.ts` holds one line per write: decoder, output schema and per-file adapter revision.
- **Prose inside JSON becomes enums.** Where a handler puts a template in a `message` field, the decoder maps it to a closed enum plus the id, exactly as F4 does, and any other text is `shape-mismatch`:
  - `remember`: `remembered: <m-id>` | `suggested: <ms-NN>` | `already remembered: <id>`;
  - `backlog_suggest`: `added:` | `suggested:` | `already in backlog:`;
  - `backlog_take`: `taken:`.
- **Warnings.** `send_message` warnings stay verbatim strings in `warnings`, as data.

### W0 files, acceptance, mutants

**Base.** The integration branch after R1 → R2 → R3 → R4-find_skill are merged. W0 edits the adapter table area and the catalogue those batches append to. Worktree `w-0054-f1-w0`, branch `parley/w-0054/f1-w0` (proposed).

**Files (expected set; the lead fixes it before the hand-off):**
- `code-mode/consent.ts` (new, +test);
- `code-mode/detector.ts` (live source `decide` per method, +test);
- `code-mode/migration-registry.ts` (`MIGRATABLE_WRITES`, effective proven, +test);
- `code-mode/catalog.ts` (+test);
- `code-mode/broker.ts` (effects, `beforeRetry`, write `unread` → unknown, +test);
- `code-mode/scheduler.ts` (write exclusivity, +test);
- `code-mode/contracts.ts` (refusal code, `consent-withdrawn` diagnostic, version, +test);
- `mcp/code-mode-tools.ts` (description, hints, last-resort result, +test);
- `code-mode/write-adapters.ts`, `code-mode/write-adapter-table.ts` (new, +test);
- `code-mode/writes-marker.ts` (writer added next to B0's reader, +test);
- `work/launch-exposure.ts`, `work/launch.ts` (allowlist from consent, marker before decision, +`launch-exposure.test.ts`);
- `work/code-mode-instructions.ts` (`replacementRouting` accepts consented writes, +test).

**Acceptance:**
1. With the shipped registry (`MIGRATABLE_WRITES` empty), behaviour is identical to the R merge, with the same T9a routing.
2. A fixture write is migrated only with consent. Without consent it stays direct, and the partition holds over full, short, agent and navigator variants for Claude ordinary, Claude autonomous, Codex and custom.
3. Consent per provider row per the W0.1 table:
   - exact name, server-wide, a wildcard or pattern (no consent), a permission mode (no consent);
   - a Codex per-tool override;
   - each source unreadable → fail closed (the detector trigger).
4. Policy:
   - deny, ask, unknown, stale and revoked → zero dispatch;
   - a rule removed between two calls → the second call is `ask`, zero dispatch, the `consent-withdrawn` diagnostic with the exact fixed message, and reads keep working;
   - a rule added mid-launch does not migrate a method in that launch.
5. The W0.4 receipt test, plus a last-resort result that still carries `operations`.
6. W0.5:
   - a 503 on attempt 1 → `unknown`, `attempts: 1`, lease held;
   - each `unread` route → `unknown` for a write and the terminal `unread` for a read (regression);
   - a 200 `isError` → `failed`.
7. W0.6:
   - marker written before the decision;
   - marker write failure → a reads-only launch;
   - an unreadable record with the marker → `blocked`;
   - a downgrade fixture (B0 reader with a marker present) → `blocked`.
8. W0.8 exclusivity test; W0.9 hint test.
9. The four isolation items (s-296, m-7388):
   - **R1:** a consent removal after the edge check and before the send. The write is dispatched, and the result names it with `consent-withdrawn {method, ordinal}`.
   - **R2:** a settings file swapped between the detector's read and consent within one stretch gives no consent; there is exactly one read of each source per stretch.
   - **R3:** a symlinked settings file, and one over 1 MiB, each leave the write out of the launcher's allowlist, so it stays direct.
   - **R4:** a cancel after a write's host receipt gives no client answer, a record `unaccounted` naming the write, and the next launch `blocked/non-read-record`.
10. Mutants (private clone, m-7332), with survivors named:
   - `decide` returning `allow` for a write without consent;
   - the consent reader accepting a pattern;
   - `beforeRetry` true for writes;
   - write `unread` → terminal;
   - last resort without `operations`;
   - marker absent read as present (and the reverse);
   - exclusivity off;
   - allowlist ignoring consent;
   - consent from a second read;
   - a launcher reader that follows symlinks;
   - no post-run consent re-read.
11. Core tsc; direct dependents and the routing sweep on Node 22.16.0 and 22.23.3, under the lock, with zero skips.

**Reviewers.** s-296 (isolation, recovery, concurrency) and s-292 (contract). The verifier is named by the lead.

**Size (estimate, not measured).** 14–18 files, about +900/−150 including tests; 14–20 h.

## 3. Adapter batches W1–W6 (Sonnet)

Every batch bases on the W0 commit, runs in its own worktree, and edits only:
- its own new adapter files;
- append-only lines in `write-adapter-table.ts` and `MIGRATABLE_WRITES`;
- in W6 only, the named instruction file.

No original handler file is edited.

### Acceptance common to every write adapter (WA)

1. **Decoder parity.** For every handler branch, the classic JSON text, strictly parsed, deep-equals the decoded guest value re-encoded by the adapter's fixed bijections, plus `unknownFields`. An `isError` result is `tool-error` verbatim. A malformed answer is a fixed `invalid-output` code, never an empty success.
2. **Consent partition.** The method is migrated only with consent and is direct otherwise, in the same fixtures as W0 acceptance 2.
3. **Policy.** deny, ask, unknown, stale and revoked → zero dispatch. The stale-agent fence gives `STALE_AGENT` as `tool-error` with **no** store change (a store snapshot before and after).
4. **Host authority.** Every caller check the survey lists for the method gives, through the guest, the same `tool-error` text as a direct call, one fixture per check.
5. **Duplicates.** The classic second-identical-call behaviour (§1.6) is the same through the guest. The broker never sends a second attempt itself: one host start per dispatch, with a counting host.
6. **No retry.** A 503 or socket failure on attempt 1 → `unknown`, one attempt, lease held. A launcher fixture with that record → `blocked/non-read-record`.
7. **Receipts.** The write plus a final value over 16,384 B → `operations` names the write as `succeeded`. In contract v4 the agent view never omits a non-read operation: the write's row is in the text the agent receives on every status, while a clean read is left out of a completed view.
8. **Conservation and hints:** `checkReplacement` over the variants; the execute hints test in a launch holding this write.
9. **Mutants** in a private clone; both Nodes; core tsc; direct dependents; the routing sweep; the lock; zero skips.

### W1 — memory and backlog: `remember`, `backlog_suggest`, `backlog_take`, `publish_agent_plan`

- **Files:** `code-mode/write-adapters/{remember,backlog-suggest,backlog-take,publish-agent-plan}.ts` and tests; 4 table lines; 4 registry names.
- **Method rules:**
  - `remember`, `backlog_suggest`:
    - `message` → `{outcome: 'remembered'|'suggested'|'duplicate'` (memory) / `'added'|'suggested'|'duplicate'` (backlog)`, id}`; `diagnostics` verbatim; `feedUnavailable` boolean.
    - Host acceptance is unchanged: pending unless `onHumanRequest` (memory) or the project `backlogRule` admits it (`project-preferences.ts:7,25`).
    - Fixtures cover each `backlogRule`, `onHumanRequest: true` recorded as `claimedHumanRequest` (`memory-suggestions.ts:55–66`), and duplicates.
    - `remember` is absent in the short profile: no stub, conservation holds.
  - `backlog_take`: `{outcome:'taken', id}`. A same-taker repeat passes. Another taker or a checked item → `backlog-conflict`.
  - `publish_agent_plan`: `{ok, completed, total}`. Only one `in_progress`; 50 steps.
- **Mutants:**
  - swap two outcome templates;
  - accept an unknown template;
  - drop `feedUnavailable`;
  - make `diagnostics` optional;
  - accept `ok:false` for `publish_agent_plan`.
- **Size (estimate):** 8–9 files, about +700; 8–12 h.

### W2 — plan items: `plan_update`, `plan_progress`, `plan_submit`, `plan_verify`

- **Files:** `code-mode/write-adapters/{plan-update,plan-progress,plan-submit,plan-verify}.ts`, a shared `plan-output.ts` (decoder of `{next, effects, saved?}`) and tests; 4 table lines; 4 registry names.
- **Method rules:**
  - **`effects`.** Decoded as `{queued, pendingSnapshots, pendingBacklog, conflictCount, conflicts}` or the `unavailable: true` summary (`plan-tools.ts:433–445`). `conflicts` is at most 100 (`plan-effects.ts:793`), and its length + omitted ≤ `conflictCount` is checked as `page-invariant`. `effects.unavailable` is data, not an error: the write committed (fact 8).
  - **`next`.** `{total, assignments ≤ 5}`.
  - **Conflicts.** `rev` is checked as in classic (`plans.ts:517–531`), and a stale `rev` gives the fixed conflict text as `tool-error`. Item mutations do not bump `rev`.
  - **`plan_verify`.** The verifier identity check (`actor !== item.verifier || actor === item.owner`) is exercised. The human-return path is not exposed: it is human-only.
  - **`plan_progress`.** Owner or verifier; no autonomous plans.
- **Mutants:**
  - treat `effects.unavailable` as an error;
  - drop the `conflicts` bound;
  - accept `assignments` > 5;
  - drop `saved` on `plan_progress`.
- **Size (estimate):** 10–11 files, about +800; 10–14 h.

### W3 — proposals: `set_room_mode`, `propose_completion`, `propose_decision`

- **Files:** `code-mode/write-adapters/{set-room-mode,propose-completion,propose-decision}.ts` and tests; 3 table lines; 3 registry names. `plan-output.ts` from W2 is reused **read-only**; if it is needed before W2 merges, W3 bases on W2's merge.
- **Method rules:**
  - **`set_room_mode`.** `{effects}`. Lowering is refused for agents ("only the human can lower room mode", `plans.ts:911–912`); the fixture proves the refusal through the guest. The same mode gives an empty change.
  - **`propose_completion`.** `{proposalId, rev, effects}`. Autonomous rooms refuse agents ("only the engine…", `proposals.ts:217`).
  - **`propose_decision`.** Three output shapes, by branch: free room `{proposalId, rev}`, plan mode `{…, effects}`, autonomous `{proposalId, rev}` from the host. The decoder selects the branch from the room mode returned by a **fixture-known** room, never by guessing from keys. If the branch cannot be told apart from the arguments alone, the decoder accepts the union, and the review must accept that. The autonomous `requestKey` dedup is exercised.
  - **The 5 proposal-style writes.** These are `remember`, `backlog_suggest`, `plan_submit`, `propose_completion` and `propose_decision`. Their human acceptance stays in the host. Accept and return endpoints and human-only setters are never exposed (§5.2).
- **Mutants:**
  - allow lowering;
  - drop `effects` on plan mode;
  - accept an autonomous result with `effects`;
  - accept `rev` ≤ 0.
- **Size (estimate):** 7–8 files, about +600; 8–10 h.

### W4 — rooms: `create_room`, `add_to_room`

- **Files:** `code-mode/write-adapters/{create-room,add-to-room}.ts` and tests; 2 table lines; 2 registry names.
- **Method rules:**
  - **`create_room`.**
    - Output `{roomId}`. There is no dedup, so a second identical call creates a second room and moves the members again; WA5 records it as classic behaviour. WA6 matters most here.
    - Fixtures cover closed members, swarm members, a lead who is not a member, and the message-rate refusal (`tools.ts:361–368`).
  - **`add_to_room`.** `{messageId}`; lead only; "already a participant" on a repeat.
- **Mutants:**
  - accept a missing `roomId`;
  - accept `messageId` of a wrong shape;
  - let a non-lead fixture pass.
- **Size (estimate):** 4–5 files, about +400; 4–6 h.

### W5 — attempts: `attempt_submit`, `attempt_verify`

- **Files:** `code-mode/write-adapters/{attempt-submit,attempt-verify}.ts` and tests; 2 table lines; 2 registry names.
- **Method rules:**
  - **`attempt_submit`.** Output `{receipt, submissionKey}`. A repeat with the same manifest returns the existing receipt; a different manifest gives `handoff-conflict` (`autonomous.ts:749–765`; `attempts-endpoint.ts:210`).
  - **`attempt_verify`.** Output `{check}`. A same-verdict repeat returns the check; a different one gives `check-conflict`. The verifier is never the worker.
  - **Reachability.** Confined-attempt workspaces (`clone`, `artifacts`) are classic under T12a Delta 10. The fixtures do not depend on whether a live autonomous launch reaches these methods.
- **Mutants:**
  - accept a receipt without `submissionKey`;
  - accept a `check` that is not a string;
  - collapse `handoff-conflict` into success.
- **Size (estimate):** 4–5 files, about +450; 5–8 h.

### W6 — `send_message`

- **Files:**
  - `code-mode/write-adapters/send-message.ts` and its test;
  - 1 table line and 1 registry name;
  - `work/code-mode-instructions.ts` and its test: `TERMINAL_OPERATIONS` loses `send_message`; the guide line "report, wait_for, check_inbox and send_message are always top-level" names only the operations that still are; `RULES` keeps "mail" for the inbox.
- **Method rules:**
  - Output: `{messageId}` and an optional `warning`, kept verbatim as data.
  - No dedup: two identical calls are two letters, as in classic, so WA6 matters most here.
  - Fixtures cover:
    - the 4,096-char limit;
    - room membership;
    - the owner → live lead exception (`tools.ts:1266–1267`);
    - `replyTo` without `room`;
    - a direct letter that needs exactly one `to`;
    - the rate refusal.
  - The existing Codex example row for `send_message` (`code-mode-instructions.ts:86`) is used unchanged.
- **Ruling (W-B, m-7387).** `TERMINAL_OPERATIONS` comes from ruling m-6667 ("operations that end or hand over a turn: always top-level"). The human's m-7370 together with m-7375 (5) supersedes m-6667 **for `send_message` only**. `send_message` leaves `TERMINAL_OPERATIONS`; `wait_for` and `check_inbox` stay there until F3.
- **Mutants:**
  - keep `send_message` in `TERMINAL_OPERATIONS`;
  - drop `warning`;
  - accept an empty `messageId`.
- **Size (estimate):** 3–4 files, about +350; 4–6 h.

### Shared files and merge order

| File | W0 | W1 | W2 | W3 | W4 | W5 | W6 | A-* |
|---|---|---|---|---|---|---|---|---|
| `write-adapter-table.ts` | creates | +4 | +4 | +3 | +2 | +2 | +1 | — |
| `migration-registry.ts` `MIGRATABLE_WRITES` | creates | +4 | +4 | +3 | +2 | +2 | +1 | — |
| `migration-registry.ts` `proven` | — | — | — | — | — | — | — | +1 each, serial |
| `write-adapters/plan-output.ts` | — | — | creates | reads | — | — | — | — |
| `work/code-mode-instructions.ts` | edits | — | — | — | — | — | edits | — |
| catalogue, broker, scheduler, contracts, code-mode-tools, launch files | edits | — | — | — | — | — | — | — |

- **Merge order:** W1 → W2 → W3 → W4 → W5 → W6. Each later batch rebases on the previous merge, resolves only its appended lines, and reruns its own tests under the lock.
- **Parallelism:** W1, W2, W4, W5 and W6 can run in parallel from W0. W3 starts after W2's merge, or reads `plan-output.ts` from W2's branch with the lead's consent.

### Activation A-<method>

One commit per method adds the name to `proven`, serially, after all of these:
- INTERIM;
- T12b for the provider;
- T8h;
- the provider row's consent reader (W0.1) proven live for that provider;
- the method's batch acceptance.

Checks:
- the direct declaration disappears **only in launches with consent**;
- a call to the direct name in such a launch gives `unknown tool`;
- the guide routes the name;
- conservation holds;
- the real-client regression for the provider passes.

Implementer Sonnet; s-296 reviews authority; s-308 verifies conservation (D3).

### Bounded attempts and restoration (plan T11)

Each method is its own task. A failed review or verification is one attempt; after two, the method stays a named temporary residual. Restoration removes the name from `MIGRATABLE_WRITES` and its table line. The verifier then checks that the method is direct with its original schema hash in **every** launch kind, and that the partition holds.

## 4. Order and dependencies

```
B0 (+ sticky reader) → R1 ∥ R2 ∥ R3 ∥ R4-find_skill → merge R1..R4 → W0 → W1 ∥ W2 ∥ W4 ∥ W5 ∥ W6, W3 after W2 → merge W1..W6 → A-<method>
```

- **Live activation** waits for: INTERIM; T12a provider rows (`PROVIDER_ROWS` non-empty, fact 2); T12b; T8h.
- **Fixture work** waits for none of them.
- **F3's `close_session`** reuses W0 and needs no new foundation.
- **F2** reuses W0 and adds its own route.

## 5. Spec and plan text to amend after acceptance

- **Spec §5.2 write rule:** add the consent source (W0.1), the per-launch partition (W0.2), the retry rule (W0.5) and receipts (W0.4).
- **Spec §5.1:** the live source answers per method.
- **Spec §4:**
  - line 198, the exclusion list: attempt/plan mutations, memory changes and room decisions move to F1;
  - the execute annotations paragraph: per launch, by maximum effect.
- **Plan T11 rows** for the 16 methods: point to F1.
- **T11 batch plan §2:** the store-writes row and `send_message` leave the terminal row.
- **Plan T8b ruling m-6667:** amended for `send_message` if W-B is confirmed.

## 6. Lead rulings (s-292, m-7387)

- **W-A.** When a consent rule is removed mid-launch, that method answers `ask` until the next launch, and reads go on. The refusal carries the fixed `consent-withdrawn` diagnostic (W0.1). The method has no direct twin in that launch: for `send_message` this silences mail until relaunch, while `report` stays direct (s-296, m-7388).
- **W-B.** m-7370 with m-7375 (5) supersedes m-6667 for `send_message` only. It leaves `TERMINAL_OPERATIONS`; `wait_for` and `check_inbox` stay until F3.
- **W-C.** A write runs alone (W0.8).
- **W-D.** Codex consent is `'all'`, matching classic. s-292 carries the fact to the human: every Codex session can run writes inside scripts.
- W0.4, W0.5 and W0.6 are accepted as written.

## 7. Not verified

- Nothing was run: no tests, no tsc, no `tools/list`.
- Whether the generic plan and backlog error texts can follow a committed write (fact 8).
- Whether a human's `.claude` local rule written by an "always" answer has exactly the `mcp__parley__<method>` spelling (`decisions.ts:48–54` passes the client's suggestions through).
- Codex's effective per-tool `approval_mode` merge with the human's `config.toml` beyond the comment at `mcp-config.ts:234–236` and its 0.162 probe.
- GLM and custom client semantics for `permissions.allow`.
- Whether `propose_decision`'s branch is decidable from arguments alone (W3).
- How often an `unknown` write blocks a session in practice. For autonomous rooms, each block stalls the engine until a human acts.
- The cost of re-reading consent at every check (latency not measured).
- **Binding on T12a-Claude (s-293; s-292, m-7387).** In an ordinary Claude session, does the client prompt the human for `mcp__parley__code_execute`? Parley allows `mcp__parley` only for autonomous launches (`settings-file.ts:254`). Does the answer change between `readOnlyHint: true` (a reads-only launch) and `false` (a launch with a consented write)? Both are to be measured on the real binary at T12a-Claude. The answer decides whether a reads-only Code Mode session prompts where classic `get_map` did not.
- All sizes and hours are estimates from reading code, not measurements.

## Impact card

- **Goal:** move the 16 F1 writes into `code_execute` without removing any human permission step classic has.
- **Behaviour:** none yet; a design. If built and activated:
  - Autonomous Claude, Codex, and human-allowed methods in ordinary Claude sessions run their writes inside scripts.
  - Every other write stays a direct tool.
  - A lost write answer blocks the session's next launch until a human decides.
- **Numbers:** 16 methods; 1 senior foundation and 6 Sonnet batches. Estimates, not measured: about +4,200 lines including tests and 53–76 h (W0 14–20 h, adapters 39–56 h).
- **Screens:** none.
- **For the human:**
  - In an ordinary Claude session, Parley still asks you before a write unless you allowed it ("always" in the permission card counts from the next launch).
  - In Codex, Parley tools already run without asking, and that stays so inside scripts.
  - A consent mismatch leaves a write as a direct tool, never unusable.
  - After a lost or cancelled write answer, Parley stops and asks you before relaunching that session.
- **Risk:**
  - a consent reader that reads too much would remove your permission step; it is fail-closed, read once with the detector and mutant-tested;
  - duplicate letters or rooms if a retry ever sent twice; writes get zero retries;
  - blocked autonomous sessions after unknown writes;
  - the named check-to-dispatch window.
- **Cost:** not measured; the hours above are estimates.
- **Verdict:** accepted by s-292 (contract, m-7387) and s-296 (CLEAR with R1–R4, m-7388).
