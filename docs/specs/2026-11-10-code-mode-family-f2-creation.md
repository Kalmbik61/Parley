# Code Mode family F2: session creation

Status: **ACCEPTED** by s-292 (contract; m-7414, m-7416, m-7425, m-7427) and s-296 (isolation, recovery, duplicates; m-7415, m-7417, m-7423, m-7426; ACCEPT conditional on R3 (i)–(iv), which are in §2.2 and F2-H acceptance). Author: s-312 (family designer).

Scope: `create_session`, `request_agent_switch`, `create_swarm`, `swarm_add`, moved into `code_execute` under the human's m-7370 and the lead's m-7375 and m-7402. F2 builds on F1's W0 (`docs/specs/2026-11-10-code-mode-family-f1-writes.md`, `5e3fc1ae`): consent, per-launch partition, receipts, zero write retries, the sticky marker and the write-alone rule. It keeps gates G1–G8 (`docs/plans/2026-11-10-code-mode-families-order.md`). The families order rated F2 **UNKNOWN**. This design makes it **YES, provided the lead accepts decisions F2-R and F2-A (§5)**.

Sources read (2026-11-10, nothing run):
- `parley/w-0054/t12a` `7a83d601`:
  - `core/src/mcp/{session-tools,swarm-tools,tools,server,remote-tools}.ts`;
  - `core/src/work/{resource-policy,agent-switch}.ts`;
  - `host/src/agent/{session-endpoint,switch-endpoint,swarm-endpoint,attempts-endpoint,tools-endpoint,browser-endpoint}.ts`;
  - `host/src/sessions/sessions-service.ts`, `host/src/consents/consents-service.ts`, `host/src/swarms/spawn.ts`, `host/src/rooms/autonomous-engine.ts`, `host/src/capacity/capacity-service.ts`.
- A read-only survey of these paths; its citations appear as `file:line`.
- Spec §5.2, §6, §7.1; plan T11 rows for the four methods.

## 1. Facts that shape the design

1. **No route today.**
   - None of the four is in `TOOLS`. The session MCP server answers them itself, before both the Code Mode branch and the runner (`tools.ts:2157–2171`), by a direct `fetch` to the agent channel:
     - `POST /agent/sessions` (120 s timeout);
     - `POST /agent/switch` (30 s);
     - `POST /agent/swarms` with `op: 'create' | 'add'` (120 s).
   - None sends a `callId` or request key (`session-tools.ts:43–50, 98–104`; `swarm-tools.ts:61–67`).
   - The host `/agent/tools` runner answers `unknown tool` for them (`tools.ts:1742`).
   - The MCP-side `staleAgent` fence does not cover them. The token does: it is removed when the PTY exits and replaced at relaunch, so a stale process gets 401 (`sessions-service.ts:661–667`).
2. **Creation blocks until spawn.** `/agent/sessions` and `/agent/swarms` call `sessionsService.create` (`sessions-service.ts:1426–1597`). In order, it:
   1. checks provider readiness, the role and the model;
   2. writes the pending session under `updateMap`, with admission: rolling caps of 50 per work and 12 per room per 24 h, and `reserveAttempt`;
   3. plans a worktree if asked;
   4. reserves the budget and gets machine admission;
   5. creates the worktree, installs skills, hooks and the plan;
   6. calls `pty.start`.
   
   It answers after step 6, or with `queued` or `held` (`sessions-service.ts:968–1003, 1363–1366`). A client disconnect does not stop it.
3. **No dedup for creation.** A second identical POST creates a second session, swarm or member: `createPendingSession` always allocates a new id. The one precedent for idempotent creation is the autonomous engine, which journals an intent and looks the session up by a deterministic label before creating (`autonomous-engine.ts:368–388, 944–946`).
4. **`request_agent_switch` only asks.**
   - `/agent/switch` checks rights (`switch-endpoint.ts:16–28`), creates or returns a pending consent card, and answers at once with fixed prose: "asked @human; the switch happens only after their answer".
   - Pending cards are deduplicated **durably** by target, provider and model (`consents-service.ts:342–365`, `consents.json`).
   - The switch runs only after the human's allow. At that point `stop(ref)` kills the target's PTY, a new `agentRevision` is written, and the session is relaunched (`sessions-service.ts:1913–2069`).
5. **Swarms** are a queen plus read-only drones and verifiers. `swarm_add` is for the queen only, and caps apply (`resource-policy.ts:423–441`). Swarm members cannot create sessions (`sessions-service.ts:1555`).
6. **Annotations.** All four have `openWorldHint: true` and `readOnlyHint: false`; `request_agent_switch` also has `idempotentHint: true`. So `effectOf` gives `write`, and G6 requires `openWorldHint: true` on `code_execute` in any launch holding one.
7. **Consent in classic** (F1 §1.1):
   - in an ordinary Claude session none of the four is pre-allowed, so the human sees the permission card;
   - autonomous Claude and Codex pre-allow them.

## 2. Design

### 2.1 Route: the host runner serves creation in process (decision F2-R)

Today's agent-channel `fetch` is not reused. The four creation calls are served by the **same remote-only `/agent/tools` runner** that serves every other nested call. This follows the precedent of `context.attempts`, which the host already wires in process (`host.ts:518`).

- **Core.** `createToolRunner.dispatch` gains one branch for the four names. It calls `context.creation?.{createSession, requestSwitch, createSwarm, swarmAdd}` and answers `unknown tool` when `context.creation` is absent. That is the case in the local fallback runner and in every classic in-process runner.
- **Host.** `host.ts` builds `context.creation` per session, calling `sessionsService.create`, `consentsService.requestSwitch` and the swarm admission **in process**. It reuses the same rights checks the agent-channel endpoints run today:
  - `switchRequestDenial`;
  - `parent: null`, `requestedBy`;
  - the swarm `op` checks.
  
  Those checks move into shared functions; the endpoints and the hook call the same code.
- **Not listed.** The runner's `list()` does not list the four. Classic sessions keep listing them from the session server and calling the agent channel exactly as today, byte for byte.
- **What the route gives.**
  - One authority path, with no new broker route (§5.2 "one remote-only runner" holds).
  - The stale-agent fence, which is **stricter** than classic, where only the token fences.
  - G2 holds: a host without the hook answers `unknown tool`. That is a refusal with no fallback.
  - The host runner's `callId` replay is **not** claimed as a benefit: it can only fire on a resend, and W0.5 forbids resends (s-292, m-7414).

### 2.2 Creation answers at the launch gate (decision F2-A′, option (a); s-292 m-7414/m-7416, s-296 m-7415)

`create_session` can block up to 120 s; the run wall is 30 s (§6). The ≥120 s wall is rejected (m-7414). Instead, a creation called **through the Code Mode route** answers at the **launch gate**, so that `starting`, `queued` and `held` are real states.

- **Where `held` and `queued` are decided** (both reviewers' B1). Not at the pending write (`createPendingSession`, `sessions-service.ts:1523`), which comes first, and not at the worktree plan write (`:1578`). They are decided later, inside `createInteractive → launchDetailed → launchHeld`:
  - the Codex folder-trust check (`:904`; creation's `awaitsConsent` at `:1519`);
  - the project-MCP hold card (`:935–958`);
  - the work reserve (`:964`);
  - machine admission and the queue (`:966–1003`).
- **The seam.** `launchDetailed` gains an optional `onDecided(outcome)` callback, called **at most once** (it is not called at all when the launch returns early or throws first; see N3 below):
  - with `held` (trust or project-MCP card), `queued` (machine queue) or `starting` (reserve and machine admitted);
  - **after** the pending record and the worktree plan are written (s-296 R1: a later launcher of the pending record then always sees its plan);
  - **before** `createWorktree` (`:1034`), the skill, hooks, plan and `pty.start`.
  
  Classic and every other launch path pass no callback and stay byte-identical (F2-H acceptance 1).
- **Answer on the first outcome (s-296 N3).** The hook answers on **whichever comes first**:
  - `onDecided` gives its state;
  - an early return of `launchDetailed` (`'started'` when `launching` or `closing` is set or the PTY is live, `:806–810`) gives `state: 'starting'`;
  - a throw before any decision (`readyProvider`, `ResourceDeniedError` from the reserve, rights or caps) gives a verbatim `tool-error`.
  
  Answering only from `onDecided` would let such a call hang until the 30 s wall, end `unknown` and block the session.
- **Continuation.** After the answer, the launch continues in the host, detached from the request.
  - **Catch-all (s-296 R2).** The detached part runs under a catch-all, because an unhandled rejection crashes the host on Node 22. Host stop awaits or aborts it.
  - Only failures in the later steps (worktree, skill, hooks, plan, binary, spawn, start-write) arrive by letter.
- **Time covered by the answer.** It includes `readyProvider(…, true)` and `projectMcp.inspect`; the N2 numbers below include both.
- **Result.**
  - `create_session`: `{sessionId, provider, state: 'starting' | 'queued' | 'held', held?, queued?}`.
  - `create_swarm`: `{swarmId, queenSessionId, state, held?, queued?}`.
  - `swarm_add`: `{sessionId, member, state, held?, queued?}`.
  
  `held` and `queued` keep their classic values and are present exactly when `state` names them.
- **Failure after the gate (s-296 R2, R4; replaces s-292's B2 wording, m-7416).**
  - **Recipient.** The hook's requester, stored at admission as a new `requestedBy` field on the session record (and the swarm record) **for all three creation methods**, inside the admission `updateMap`. The letter never goes to:
    - `session.parent`, which is always null for agent creations (`:1458`; today's worktree-failure letter at `:1048` already goes nowhere);
    - `createdBy`, which is not set for swarm members (`:1529`).
  - **State: closed as failed, a deliberate divergence from classic (s-292 m-7425/m-7427, s-296 m-7420).**
    - The host calls `setResult(map, id, 'failed')`, which closes the record, as `refuseLaunch` does (`consents/held-launches.ts:57`, then `deps.close`). `setResult` and the failure letter go in **one** `updateMap`, as `held-launches` does.
    - The host also broadcasts the launch-failed notice and releases the reserve and the machine slot.
    - Classic's catch (`:1586–1597`) instead leaves the record pending and rethrows to a caller who is still waiting. In Code Mode nobody is waiting any more, and a pending record that nothing launches is treated as stuck (`:1462/1468/1488`).
    - **The closed record is the once-marker.** It is no longer pending, so it can never be selected again, and no separate marker is needed.
  - **Letter.** The host sends the stored requester a fixed letter: "session <id> could not be started: <code>".
  - **Host restart (s-296 R3, s-292 C2).** A restart after the answer but before spawn leaves a pending record that nothing launches (comments at `:1462/1468/1488`), and an in-memory letter would be lost.
    - **The rule.** At host start, a record that meets **all** of these gets `setResult 'failed'` and the fixed failure letter to its stored `requestedBy`, in **one** `updateMap`:
      - pending, with a `requestKey` and a stored `requestedBy`;
      - **no** `queued` entry in the map, so it is not waiting for a machine slot;
      - **no** open hold card for it in `consents.json`, so it is not waiting for a trust or project-MCP decision;
      - **launch never started**, tested on a named field: neither `pid` nor `startedAtProcess` is set on the record, which is what the start-write step records.
    - **Once only.** The record is closed by that write, so a second restart does not select it again.
  - The agent learns the outcome with `get_map` or a deferred `wait_for({target: <id>})` (F3), never by polling inside the 30 s script.
- **One creation per run (O1, s-292 m-7416).** At most **one** of the four creation methods per run, matching classic's one creation per turn. A second one is refused with the closed refusal `one-creation-per-run` and zero calls.
- **Classic is unchanged.** The agent-channel endpoints keep their blocking answer.
- **The contract difference.** In Code Mode, "created" means "decided": `starting` is past every admission and capacity gate but before the process exists. s-292 carries this to s-288 once F2 is accepted.
- **Time to the decision, read from this machine's host logs (N2).**
  - **Source.** `~/.parley/host/host.log{,.1}`, entries from 2026-11-09 and 2026-11-10, read-only:
    - 30 "создание сессии: время шагов" entries (agent and human creations);
    - joined by session id with the first "запуск сессии: время шагов" entry of mode `launch`.
  - **Decision time** = the creation steps before `launch` + the launch steps `readMap`, `provider`, `trust`, `projectMcp`, `reserve`, `machine`, `queue`. Over the 23 joined entries: min 5 ms, p50 134 ms, p90 1,596 ms, max 7,959 ms.
  - **The whole creation** ("создание сессии" `totalMs`, 31 entries): p50 713 ms, p90 4,612 ms, max 13,599 ms.
  - **Caveats.** The join pairs a creation with the first launch entry of that session, which can belong to a later relaunch (one pair gave a negative remainder), so the decision numbers are approximate. They are one machine and two days, not a benchmark. All observed decision times are under the 30 s wall. A slower decision still ends `unknown` (§2.3), and T10 measures it on the target setup.

### 2.3 Duplicates and recovery

- **No retries.** W0.5 applies: one attempt, and a write's `unread` is `unknown`. With no resend there is no transport duplicate.
- **A durable request key (F2-K: evidence, plus a defense lookup; m-7414, m-7416, m-7417).**
  - **Derivation.** The key is **broker-computed and requester-scoped**: `requestKey` = sha256 of the audit identity `(launchId, runId, ordinal, method, argsSha256)`. The broker sends it in the request `meta`; the guest never supplies or sees it. One shared derivation function serves the broker and the launcher's blocked notice (s-296 R5).
  - **Lookup and store together.** Both run **in the same admission `updateMap` callback** (`:1523`), never check-then-act. The key is stored with the stored `requestedBy` on the created session record (or the swarm record).
  - **Durability.** Unlike the in-memory replay, the key survives a host restart and a `launchKey` change.
  - **The lookup stays as a defense** (s-296 ruling, m-7417). Within the callback, a record with the same key **and** the same `requestedBy` is returned instead of creating another.
    - It should never fire under W0.5. It covers a hand replay with the token and any later change to the retry rule.
    - A forged key returns only the requester's own record.
  - **Lookup conditions** (m-7417):
    1. A hit returns **before any admission side effect**: no counters, no `noteCreation`, no `reserveAttempt`.
    2. A hit on a closed record returns that record with `state: 'closed'` and never creates.
    3. A hit returns the stored record's **current** state.
- **Unknown outcome.** When a creation ends `unknown` (wall, socket, give-up), the lease is held and the next launch is `blocked/non-read-record` (W0.7).
  - The launcher's blocked notice derives the request key from the held record with the shared function and names it. If a session with that key exists, the notice says "session <id> was created by the lost call". The human decides with that fact in hand.
  - For an unreadable record (`blocked/unreadable-record`), the notice says that the key cannot be derived (s-296 R5).
  - The key does **not** resolve the block automatically: a missing key does not prove that the host is not still before admission.
- **A user re-run is a new operation.** A new run gives a new key, so it creates again. That is an explicit new authorized operation, never an inferred replay (§7.1).

### 2.4 `request_agent_switch`

- **Shape.** A proposal-style write. It creates or returns a durable pending card that only the human answers (fact 4), and `idempotentHint` is true. Through the route of §2.1 it answers at once, so the wall is no issue.
- **Decoded value.** The fixed prose maps to `{outcome: 'asked'}`. Any other text → `shape-mismatch`.
- **The target may be the caller or another session** (`switch-endpoint.ts:22–26`: the target itself, its parent or `createdBy`, or the live lead or owner of its room; s-292 N1).
- **The human's allow can arrive during a later run of the target.** The host then stops the **target's** PTY (`stop(ref)`) while a script of the target may be running. When the target is the caller, that is the caller's own process; when it is another session, the caller is untouched and the target goes through the same path.
  - This is the existing "process ends with unsettled calls" path. The run record keeps them, the token is removed (later calls get 401 → `unknown`), and the relaunch reads the record: `held-run` for reads and peeks, `blocked` for writes.
  - Every later call of the old process also meets the stale-agent fence, because the new `agentRevision` replaces the host runner (`tools-endpoint.ts:149–151`).
  - No new mechanism is needed. A test proves the sequence (§3, F2-H acceptance).
- **The card is the consent for the switch itself.** W0 consent only decides whether the *request* may be made inside a script.

### 2.5 Swarms

`create_swarm` and `swarm_add` follow §2.2 and §2.3, with their own caps and errors kept verbatim: `not-queen`, `swarm-closed`, `resource-budget`. A swarm member's script cannot create, because the host refuses it (`sessions-service.ts:1555`), the same as classic.

### 2.6 Hints, consent, detector-off

- **Hints (G6).** `openWorldHint: true` on `code_execute` in a launch holding any of the four. The catalogue carries `openWorld` from the annotations, and W0.9's test is extended.
- **Consent (W0.1).**
  - In an ordinary Claude session the four stay direct unless the human allowed them.
  - In autonomous Claude and Codex they migrate. s-292 already carries the Codex fact to the human.
- **Write-alone (W0.8).** It applies to the four.
- **Detector-off.** Zero calls, and no direct twin, so the session cannot create or switch until relaunch. Nothing is lost, and the relaunch required by F3-L restores the direct tools. The `mail-unavailable-until-relaunch` diagnostic does not apply. A fixed diagnostic `creation-unavailable-until-relaunch` is added, with the closed message "creating or switching sessions is unavailable in this launch".

## 3. Batches

### F2-H — host creation hook and decision answer (SENIOR-ONLY)

Why senior: a new authority path into session creation (§5.2), duplicate prevention, recovery evidence, and the async failure path.

- **Base.** The W0 commit. It runs in parallel with W1–W6, F3-H and F3-W. Worktree `w-0054-f2-h`, branch `parley/w-0054/f2-h` (proposed).
- **Files:**
  - `core/src/mcp/tools.ts`: the dispatch branch; the four names stay out of `list()`;
  - `core/src/mcp/context.ts`: the `creation` hook type;
  - `host/src/host.ts`: the hook wiring;
  - `host/src/agent/{session-endpoint,switch-endpoint,swarm-endpoint}.ts`: checks extracted into shared functions;
  - `host/src/sessions/sessions-service.ts`:
    - the `onDecided` seam in `launchDetailed`;
    - `requestedBy`;
    - the `requestKey` lookup and store in one callback;
    - the detached catch-all;
    - the failure-after-gate path;
    - the host-start letter for pending records with a key;
  - `host/src/swarms/spawn.ts`: the key and `requestedBy` on swarm records;
  - `core/src/mcp/code-mode/{catalog,broker}.ts`: `openWorld` from annotations, the `requestKey` in `meta` for the four;
  - `mcp/code-mode-tools.ts`: hints;
  - `code-mode/contracts.ts`: the diagnostic and the `one-creation-per-run` refusal;
  - `code-mode/helper.ts`: the per-run creation count;
  - a shared `code-mode/request-key.ts`: the derivation used by the broker and the notice;
  - their tests.
- **Acceptance:**
  1. **Classic unchanged.** The four classic tools keep their agent-channel requests and answers byte for byte (fixtures for each outcome, `held`/`queued` included). Every launch path that passes no `onDecided` (human launch, wake, queue pump, resume, switch relaunch, engine) is byte-identical, timing log included.
  2. **Route.**
     - Through `/agent/tools`, each of the four runs the same rights checks as its endpoint: one fixture per refusal in survey §5–§7.
     - The runner without `context.creation` answers `unknown tool`, with zero creation.
     - `tools/list` of the runner does not show them.
  3. **Gate answer (A′, option (a)).**
     - `onDecided` is called at most once, after the pending record and the worktree plan are written, and before `createWorktree`, the skill and spawn.
     - Each real state is reached by a fixture: `held/folder-trust` (untrusted Codex project), `held/project-mcp` (pending card), `queued/machine-limit`, `queued/memory-critical`, `starting`.
     - The later steps complete in the background.
     - A reserve refusal or a cap refusal is a `tool-error`, as in classic.
     - **N3:** an early `'started'` return gives an answer with `state: 'starting'`, and a throw before the decision gives a `tool-error`. Neither hangs to the wall.
  4. **Failure after the gate (R2, R4).** For **each** of `create_session`, `create_swarm` and `swarm_add`, an injected throw at the worktree, the skill install, `pty.start` and the start write in turn gives:
     - no unhandled rejection, and host stop awaits or aborts the detached part;
     - `setResult 'failed'` (the record closed), the launch-failed notice, and the reserve and the machine slot released;
     - the fixed letter delivered to the stored `requestedBy`, never to `parent` or `createdBy`, in the same `updateMap` as `setResult`.
  5. **Host restart (R3, C2).**
     - A restart fixture after the answer and before spawn: at host start, the qualifying pending record is failed and lettered in one write.
     - Two restarts give one letter.
     - A queued record and a held record (open card) at restart stay open and get no letter.
  6. **Request key (R5, m-7417).**
     - It is stored with `requestedBy` for all three creation methods. The guest cannot set it, and the broker and the notice derive it with one shared function.
     - It survives a host restart fixture.
     - **Defense test.**
       - A resend with the same key and requester returns the first record, with its current state, and creates nothing.
       - The hit makes no counter change, no `noteCreation` and no `reserveAttempt`.
       - A hit on a closed record returns `state: 'closed'`.
       - A different requester with the same key creates.
     - The lookup and the store run in the same `updateMap` callback; a test interleaves two admissions.
  7. **One creation per run (O1).** A second creation call in a run is refused as `one-creation-per-run`, with zero calls.
  8. **Unknown outcome.**
     - The wall is hit before the answer, so the record is `unaccounted`, the next launch is `blocked`, and the notice names the key and, when found, the session.
     - For an unreadable record, the notice says that the key cannot be derived.
  9. **Switch during a run (N1).** Two fixtures:
     - **target == caller.** Allow → `stop(ref)` while the caller's run is in flight. Later calls get 401 → `unknown`, the relaunch reads the record, and the new process's calls pass the fence.
     - **target ≠ caller.** Allow → the target's PTY stops while the target's run is in flight, with the same record path for the target. The caller's run is untouched.
  10. **Hints.** `openWorldHint` is true only in launches holding a creation method.
  11. **Mutants:**
      - creation answered at the pending write, or before the worktree plan write;
      - creation answered after spawn on the Code Mode path;
      - `onDecided` called twice or on a classic path;
      - the answer only from `onDecided` (N3);
      - a held or queued record is failed at restart;
      - `setResult` and the letter written in separate updates;
      - the detached part without a catch-all;
      - no stored `requestedBy` for swarms;
      - the failure letter sent to `parent` or `createdBy`;
      - no failure letter at host start;
      - the key not stored;
      - lookup and store in separate callbacks;
      - a hit still increments the spawned/recent counters (m-7417);
      - a second creation per run admitted;
      - the dispatch branch reachable without the hook;
      - `openWorld` dropped.
  12. Core and host tsc; both Nodes; the routing sweep; the lock; zero skips.
- **Size (estimate, not measured):** 14–17 files, about +1,200/−120; 22–30 h.

### F2-A1 — creation adapters (Sonnet)

- **Base.** The F2-H commit.
- **Files:**
  - `code-mode/write-adapters/{creation-output,create-session,create-swarm,swarm-add}.ts` and tests;
  - 3 table lines; 3 registry names.
- **Rules:**
  - `state` is a closed enum: `starting | queued | held | closed`. `closed` comes only from a defense-lookup hit.
  - `held` is `folder-trust | project-mcp`.
  - `queued` is `machine-limit | memory-critical`.
  - `held` is present iff `state` is `held`; `queued` is present iff `state` is `queued`; otherwise `shape-mismatch`.
  - The classic prose blocks for `held`/`queued` are a fixed function of those fields; a parity test pins it against the classic answer, using F2-H's real-state fixtures.
  - Errors are verbatim `tool-error`, including the classic "Check get_map before retrying" texts.
- **Acceptance:** F1's WA items 1–9, plus the `state` mapping and the caps (`resource-budget`, `not-queen`, `swarm-closed`).
- **Mutants:**
  - accept an unknown `state`;
  - accept `held` with `state: 'starting'`;
  - drop `member`;
  - accept a missing `queenSessionId`.
- **Size (estimate):** 8–9 files, about +700; 8–12 h.

### F2-A2 — `request_agent_switch` adapter (Sonnet)

- **Base.** The F2-H commit; it runs in parallel with A1.
- **Files:** `code-mode/write-adapters/request-agent-switch.ts` and its test; 1 table line; 1 registry name.
- **Rules:**
  - The fixed prose → `{outcome: 'asked'}`.
  - A deduplicated pending card gives the same answer.
  - Rights refusals are verbatim.
- **Acceptance:** F1's WA items 1–9.
- **Mutants:**
  - accept any prose;
  - a refused target fixture that passes.
- **Size (estimate):** 2–3 files, about +250; 3–4 h.

### Order and merges

```
W0 → F2-H → (F2-A1 ∥ F2-A2) → merge → A-create_session, A-create_swarm, A-swarm_add, A-request_agent_switch (serial)
```

- `write-adapter-table.ts` and `MIGRATABLE_WRITES` are append-only, after whichever F1 and F3 batches merged first.
- **Activation** waits for INTERIM, T12b, T8h, the provider's consent reader, and the F3-L relaunch (the detector-off path).

## 4. Spec and plan text to amend after acceptance

- **§5.2:**
  - "External publication, deletion, session creation … remain original classic actions" → creation under F2;
  - "no new host endpoint" → no new endpoint: creation is served by the existing runner through a host hook.
- **§6:** a creation in Code Mode answers at the launch decision; the wall is unchanged.
- **§7.1:** the creation request key as recovery evidence.
- **Plan T11 rows** for the four methods; the T11 batch plan creation row; the families order's F2 feasibility (UNKNOWN → YES with F2-R and F2-A).

## 5. Rulings (s-292 m-7414/m-7416; s-296 m-7415/m-7417)

- **F2-R.** Accepted: the existing `/agent/tools` runner with an in-process host hook. s-296 has no isolation objection.
- **F2-A′, option (a).** Answer at the launch gate: after the hold, queue, reserve and machine decision and after the worktree plan write, before `createWorktree`. Only failures in the later steps come by letter. The ≥120 s wall is rejected. s-292 carries "created = decided" to s-288 once F2 is accepted.
- **F2-K.** The key is evidence, never an automatic unblock, and is broker-computed and requester-scoped. The lookup stays as a defense (s-296, m-7417), under three conditions: no side effects on a hit, `closed` on a closed record, and the current state returned.
- **O1.** At most one creation per run.
- **Applied:** s-296 R1–R5 and N3, and s-292 N1, N2 (§2.2, §2.3, §2.4 and F2-H acceptance).
  - The recipient is R4's stored `requestedBy` (m-7416).
  - The failed state is `setResult 'failed'` (closed), written in one update with the letter (s-292, m-7425/m-7427). This supersedes "classic pending" in m-7422; the closed record is the once-marker.
  - C2/R3: the restart rule excludes queued and held records and uses a named never-started field.

## 6. Not verified

- Nothing was run: no tests, no tsc, no `tools/list`.
- The time to the launch decision on the target setup. §2.2 quotes one machine's logs over two days, with an approximate join, and T10 measures it.
- Whether every failure after the gate reaches `setResult 'failed'` plus the letter in one update without a race against a parallel `get_map` or the queue pump.
- That `pid` and `startedAtProcess` are exactly the fields the start-write step sets. F2-H confirms the field and names it in code.
- Whether auto-launch or the queue pump picks up a host-created pending record left by a restart (s-296).
- Whether `/agent/switch` rights checks and the consent store can be called in process from the runner hook without the endpoint's double auth check changing behaviour (the hook uses the runner's token-bound ref).
- PTY-less (CLI-launched) callers: they have no agent channel, so they have no creation tools and are absent from both paths.
- The real-client behaviour of `openWorldHint: true` on `code_execute` (prompting) per provider; tied to the T12a-Claude prompt measurement (F1, m-7387).
- All sizes and hours are estimates from reading code, not measurements.

## Impact card

- **Goal:** move the four creation methods into `code_execute` without duplicate spawns, without holding a slot for minutes, and with fail-closed recovery.
- **Behaviour:** none yet; a design. If built and activated:
  - a script can create sessions, swarms and members and ask for an agent switch;
  - a creation answers once its launch is decided (starting, queued or held), and later start failures arrive as letters;
  - classic tools are unchanged.
- **Numbers:**
  - 4 methods; 1 senior batch and 2 Sonnet batches.
  - Estimates, not measured: about +2,150 lines including tests and 33–46 h. Order-doc design estimate: 6–10 h.
  - Read from this machine's host logs (2026-11-09/10, approximate join): time to the launch decision p50 134 ms, p90 1.6 s, max 8.0 s (23 creations).
- **Screens:** none.
- **For the human:**
  - In an ordinary Claude session, Parley still asks you before a script creates a session, unless you allowed it. Codex and autonomous sessions can create inside scripts, as they can directly today.
  - In Code Mode, "created" means "decided": the session is past every limit and capacity check but its process may not exist yet.
  - If the start then fails, even across a host restart, the session is closed as failed and the agent that asked gets one letter.
  - A session waiting in the queue or for your decision is never closed by a restart.
  - A script can create at most one session, swarm or member per run, like one per turn in classic.
  - An agent-switch request still waits for your answer.
- **Risk:**
  - a new in-process path into session creation;
  - the decision-answer contract difference (F2-A′);
  - blocked sessions after a lost creation answer, with the request key as evidence.
- **Cost:** not measured.
- **Verdict:** accepted on contract by s-292 (m-7425, m-7427), and by s-296 on isolation, recovery and duplicates once R3 (i)–(iv) are in the text (m-7426), which they now are.
