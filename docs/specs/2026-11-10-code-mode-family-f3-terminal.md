# Code Mode family F3: `check_inbox`, `wait_for`, `close_session`

Status: **ACCEPTED** by s-296 (terminal await, read marks, cancel, slot and lease lifetime, recovery: CLEAR with R1–R4, m-7405) and s-292 (contract and rulings, m-7406). Author: s-312 (family designer).

Scope: three methods, moved into `code_execute` under the human's m-7370 and the lead's m-7375 and m-7391. `report` is out of scope: it stays a direct tool permanently (human m-7377). F3 builds on F1's write foundation W0 (`docs/specs/2026-11-10-code-mode-family-f1-writes.md`, `5e3fc1ae`) and keeps gates G1–G8 of the families order (`docs/plans/2026-11-10-code-mode-families-order.md`).

The lead's three points (m-7391) are the design:
- `check_inbox`: a two-phase host inbox. A peek, then an acknowledgement only after delivery.
- `wait_for`: a terminal await by the wrapper, outside the guest, after the script ends.
- `close_session`: under W0, as the last dispatch, after the run settles.

Sources read (2026-11-10, nothing run):
- `parley/w-0054/t12a` `7a83d601`:
  - `core/src/mcp/tools.ts` (inbox views 264–352, `takeInbox` 1338–1362, `waitFor` 1042–1215, `close_session` 1532–1560, `TERMINAL` routing);
  - `core/src/work/{letter-tables,letter-store,delivery,map,mcp-config,code-mode-instructions}.ts`;
  - `core/src/mcp/{watch-map,inbox-watch,remote-tools}.ts`;
  - `core/src/mcp/code-mode/{scheduler,helper,broker,limits,contracts}.ts`;
  - `host/src/agent/tools-endpoint.ts`, `host/src/sessions/sessions-service.ts:2327–2356`, `host/src/pty/pty-manager.ts:305–317`.
- A read-only survey of these handlers; its citations appear as `file:line`.
- Spec §5.2, §6, §7, §7.1; plan T11 rows `T11-check_inbox`, `T11-wait_for`, `T11-close_session`; T13 OPEN item.

## 1. Facts that shape the design

1. **Read marks are per message and per reader.**
   - Storage: `message_reads(project_path, work_id, seq, reader, at)`, with a `message_unread` candidate table (`letter-tables.ts:1–11`).
   - `markRead(reader, ids, at)` inserts only the ids not yet marked, so it is **idempotent by id** (`letter-tables.ts:523–551`).
   - The human's window already marks by explicit ids (`mail.markRead` → `markHumanRead`, `host/src/methods/mail.ts:12–20`).
2. **`check_inbox` reads, builds views and marks in one transaction, before it returns** (`takeInbox`, `tools.ts:1338–1357`; `writeLetters`, `letter-store.ts:345–356`).
   - It has **no cap and no paging**: 620 unread letters are one answer, all marked at once (`letter-tables.ts:264–272`).
   - A client abort does not stop it.
   - So in classic a lost answer already loses the mail. Through Code Mode, a body over 1 MiB (`unread/body-over-cap`, `remote-tools.ts:311, 431–433`) or a guest that drops the value would lose it too.
3. **There is no peek or acknowledge for session mail.** Read-only accessors exist in core, `unreadLetters` and `unreadCount` (`letter-store.ts:378–396`), but no tool exposes them.
4. **`wait_for` waits on host push or a 2 s poll** (`watch-map.ts:48+`, `tools.ts:117`).
   - It stops at once on abort (`watch-map.ts:56, 75–79`).
   - The inbox branch marks **only after** the wait has ended and the cancel, turn-boundary and fence checks pass, through the same `takeInbox` (`tools.ts:1167–1214`). A cancelled wait marks nothing.
   - The session branch marks the caller's report letters about the target in a separate best-effort write (`tools.ts:1176–1184`).
   - Timeout: `MAX_TIMEOUT_SEC` 1,800 (`tools.ts:114`). The remote request timeout is the wait plus 30 s slack (`remote-tools.ts:33–36, 190–193`). Codex's MCP timeout is 1,860 s (`mcp-config.ts:178`).
   - `wait_for` is in the host's `CANCELLABLE_TOOLS`: an aborted call is dropped from replay, so a retry runs fresh (`tools-endpoint.ts:32, 202–209`).
5. **`close_session` changes the map and returns `{sessionId}`.** The host kills the target's PTY later and asynchronously: `stopRetired` runs on a debounced works refresh (75–100 ms), then SIGHUP, then SIGKILL after 3 s (`sessions-service.ts:2327–2356`, `pty-manager.ts:305–317`).
   - For a self-close, the answer usually leaves first, but that is a race, not a handshake.
   - The annotation is `CLOSES` (`destructiveHint: true`).
   - Closing an already closed session gives `isError` (`map.ts:288–290`).
   - Authority: self always; created descendants; finished members of a room the caller leads when `closeFinished` is set; never swarm members (`tools.ts:1532–1560`).
6. **All three are classic writes for consent.** Their annotations are `WRITES`, `WRITES` and `CLOSES`. In an ordinary Claude session only `close_session` is pre-allowed, and only with `allowBrowser` (`settings-file.ts:254–263`); `check_inbox` and `wait_for` go through the human's permission step unless allowed. Codex and autonomous Claude pre-allow all three (F1 §1.1).
7. **The wrapper has no step after the guest.**
   - The lease is released on quiescence (`scheduler.ts:588–591`).
   - Admission closes when the guest ends, and later calls are refused as `run-ended` (`helper.ts:847`).
   - The wall is 30 s (`limits.ts:38–51`).
8. **Terminal routing today.** `TERMINAL_OPERATIONS` = `check_inbox`, `report`, `send_message`, `wait_for` (`code-mode-instructions.ts:141`, m-6667); F1 W-B removes `send_message`. The guide says these are "always top-level" (`:180`). Codex example rows for `check_inbox` and `wait_for` exist but are unreachable (`:88–89`).

## 2. Design

### 2.1 Two-phase inbox (host change, SENIOR)

The guest-facing method is unchanged: `parley.check_inbox({})`. Underneath it is two host operations that only the broker and wrapper can reach. They are **not** tools, so they are absent from `tools/list` and the guest cannot name them.

**`inbox-peek`**
- A new `op` on the existing `/agent/tools` route, token-bound to the session like any call.
- It runs the same snapshot as `takeInbox`: stale-agent check, `inboxFenced` gives empty, `unreadFor`, `inboxView`, `openAssignmentsNotice`. It **does not mark**.
- It returns `{messages, openAssignments?, hint?, deliver: {ids, more}}`.
- **Bound.** `messages` is cut at a host-owned byte budget `MAIL_PAGE_BYTES` (§2.3), in `seq` order, keeping whole letters. `more` is the number of unread letters not included. The cut letters stay unread, and the wake pointer keeps pointing at them (`delivery.ts:87–108` reads read marks).
- **Effect.** None: no state the agent relies on changes. The host logs the call as any call.

**`inbox-ack`**
- A new `op` on the same route.
- It calls `markRead(session, ids, at)` for exactly the ids that one peek of this session returned.
- **Keyed by the peek's `callId` (s-296 R1, m-7405).** The host keeps the delivered ids **per peek `callId`** in a bounded in-memory map (an entry limit per session and a TTL). The ack names that `callId`, and an id outside that peek's set is refused. So the guest, the wrapper or a forged body cannot mark letters that were never delivered.
- **Why not "the last peek".** Keying by "the session's last peek" would let a stray earlier peek finish later and overwrite the set. The current ack would then be refused, and the redelivery could repeat in a loop.
- Idempotent by id (fact 1). It may be retried with the same `callId`, and a repeat changes nothing.

**Classic is untouched.** The direct `check_inbox` and `wait_for` keep `takeInbox`. The handler is refactored into `peekInbox` + `markRead` called back to back, with byte-identical results; a test pins it.

### 2.2 `check_inbox` inside a script

1. **Dispatch.** The guest's `parley.check_inbox({})` is dispatched as `inbox-peek` under the gate (consent per W0.1, since the method is a classic write).
2. **What the guest gets.** The decoded value: the same message DTOs as classic, plus `more`.
3. **What the model gets.** Separately, the broker copies the peeked messages into a new **host-owned `mail` section** of `ExecuteResult`. It is outside the guest's 16 KiB value, so a guest projection, a thrown error or `result-bytes` cannot drop the mail.
4. **Acknowledgement at the answer edge.** The wrapper sends `inbox-ack(callId, ids)` **after** the `ExecuteResult` holding the `mail` section has been built and validated, and **before** the handler returns it to the SDK. It sends the ack only if the client's request signal is not aborted **and** the gate, re-checked at this edge, is not `revoked` or `stale`.
   - **The ack is gated (s-296 R2).** It is a new underlying call (`markRead`), and §5.1 allows no new underlying call after a trigger. Under a revoked gate no ack is sent: the `mail` section is still returned, the letters stay unread, and they are delivered again in the next launch.
5. **No ack** when:
   - the result cannot be built;
   - the request was cancelled (the SDK sends no answer, H2c-2);
   - the peek was `unknown`/`unread`;
   - the gate is revoked or stale at the edge.
   
   In all four cases the letters stay unread and come back next time.
6. **One peek per run.** A second `check_inbox` in the same run, or a `check_inbox` together with a deferred `wait_for("inbox")`, is refused with the fixed refusal `one-inbox-read-per-run`, and nothing is dispatched.
7. **Delivery semantics.**
   - **Classic is at most once**: the marks come before the answer.
   - **F3 is at least once, except in one named window (s-296 R3).** The window is **[ack sent → response written by the SDK]**, and it includes the ack's own round trip. A client cancel inside it makes the SDK drop the answer (H2c-2; SDK 1.30.0 `protocol.js:369`) while the page is already marked. That is classic's lost answer, slightly wider.
     - The wrapper re-checks the request signal after the ack resolves. If the request was cancelled, it logs "page marked, answer dropped" with the run id and the number of letters, and no letter text.
     - Outside that window nothing is lost; at worst a letter is delivered twice.

### 2.3 Result sections (contract change)

`ExecuteResult` gains two optional host-owned sections. Both are outside the guest's value and its 16 KiB cap, and both are host-built from decoded DTOs, never from guest data.

- **`mail`**: `{messages, openAssignments?, hint?, more}`, bounded by `MAIL_PAGE_BYTES`.
- **`wait`**: the outcome of a deferred `wait_for`, `{state, …}`, with its own `mail` when the target is the inbox.

The whole result keeps its 64 KiB text limit (`RESULT_TEXT_LIMITS`, `contracts.ts:110`). `MAIL_PAGE_BYTES` is set so that the 16 KiB value, 32 operations, the diagnostics and one mail page fit in that limit. The value is **32 KiB**, a design choice accepted by s-292 (F3-P, m-7406) and to be measured in T10. Paging with `more` replaces classic's unbounded answer only inside Code Mode. Letters past the page stay unread and are delivered later, never lost. The contract version is bumped once. `operations` (F1 W0.4) stays in every result.

### 2.4 `wait_for`: a deferred terminal await

1. **In the script.**
   - `parley.wait_for(args)` is validated and gate-checked at the call: zero calls on non-allow.
   - It is recorded as the run's **terminal intent** and resolves at once to `{deferred: true}`. Nothing is sent.
   - Every later guest call in the run is refused as `after-terminal`, with no dispatch.
   - At most one terminal intent per run (`wait_for` or `close_session`); a second is refused as `after-terminal`.
2. **After the guest.** The wrapper runs the wait only after the guest has ended **and** every other call of the run is terminal (the ledger is quiescent apart from the intent).
   - **Slot.** The helper runtime has exited (the guest slot is free), and the session lease is held in a new state `terminal-wait` for this one call. A `code_execute` arriving meanwhile gets `busy` with a new reason `waiting`. Direct tools, `report` among them, keep working.
   - **Gate.** It is re-checked just before dispatch (G1). If it is not allow, zero calls, and `wait: {state: 'not-run', reason}` is returned with a fixed reason.
   - **Peek mode.**
     - The host's `waitFor` runs in a **peek mode**, selected by the op and never by guest arguments.
     - The inbox branch ends where classic would mark. It returns the peek answer (§2.1) instead: `state: 'message'`, the messages and `deliver.ids`. The ack follows the §2.2 rule.
     - The session branch skips the best-effort report-letter marking. It returns those letter ids in `deliver`, and they are acked by the same rule.
   - **Timeout.** The deferred wait gets `min(timeoutSec ?? 600, 1800 − elapsedRunSeconds)`. With the 30 s request slack, the whole `code_execute` answers within 1,830 s, under Codex's 1,860 s.
3. **Cancellation.** If the client cancels `code_execute` while waiting, the broker aborts the host request. `wait_for` is `CANCELLABLE` (fact 4), so the host stops it and drops its replay record. Peek mode marks nothing, so there is nothing to account and nothing to ack. The receipt is terminal `cancelled`.
4. **Detector trigger while waiting.** It is a mid-run trigger (§5.1 runtime binding). The wait is a supported cancellation, so it is aborted, nothing is acked, and the result carries `wait: {state:'not-run', reason:'revoked'}` and `incomplete: true`.
5. **A peek marks nothing, so it never holds the lease.**
   - An `inbox-peek` or a peek-mode wait changes no mail state. So every outcome that is not a 200 (abort, socket failure, wall, give-up) is a **terminal receipt** (`cancelled` or `unread`), never `unknown`, and it does not hold the lease (U2). This extends the reads' terminal-`unread` rule (m-5840): a peek has no mark to double, and a stray peek that completes later marks nothing.
   - **The one effect of a peek-mode wait (s-296 R4).** `waitOnce` appends `ParleyWaitStart` and `ParleyWaitEnd` to the session's events journal (`tools.ts:1123–1160`). The host's activity view reads them into `waitingFor` (`activity.ts:643`), and auto-sleep acts on that (`ALLOW_WAITER_SLEEP`). So a deferred wait can be slept or stopped while it holds the lease in `terminal-wait`, for up to 30 min.
     - That is the same as a classic `wait_for`, and it is accepted.
     - When it happens, the run record names only `wait_for#peek`, nothing is marked, and the next launch is classic `held-run`, never blocked.
     - `ParleyWaitEnd` must also be written on cancel (in the `finally`), so the activity view does not keep a stale waiter.
   - In the run record, peeks are logged under the names `check_inbox#peek` and `wait_for#peek`, registered with effect `read`. A held record naming only peeks is classic `held-run`. A build without those names (B0-era) reads them as unknown methods and blocks (s-296's B0 rule); that is safe.
6. **Effect on admission.** No call runs after the terminal await. The "write runs alone" rule (W0.8) does not apply to peeks.

### 2.5 `close_session`: the last dispatch

1. **Consent and effect.**
   - It migrates only with W0 consent. That is the pre-allowed `mcp__parley__close_session` in an ordinary Claude session with `allowBrowser`, autonomous Claude, Codex, or a human allow rule.
   - Its effect is `destructive`. W0's catalogue rule is extended for this one method: `documented` admits `destructive` only for `close_session`.
   - Execute hints get `destructiveHint: true` in a launch holding it (G6, m-5887).
2. **Terminal intent.** `parley.close_session({target})` is validated and gate-checked at the call. It is recorded as the run's terminal intent and resolves to `{deferred: true}`; later calls are refused as `after-terminal`, as in §2.4.
3. **After quiescence.** The wrapper re-checks the gate, writes the intent to the run record, and dispatches **one** attempt with no retry (W0.5). The outcome goes into `operations` and into a `close` section (`{sessionId}` or the tool error).
   - **Self-close.** The host kills the caller's PTY asynchronously, about 75–100 ms after the map write plus SIGHUP (fact 5). The answer usually leaves first, but that is a race, the same as classic. If the process dies before the answer, the record stays `unaccounted` naming `close_session`. The session is closed, so no launch follows. If a human ever relaunches it, the record gives `blocked/non-read-record`, which is safe.
   - **Closing another session** has no kill race for the caller.
4. **Mail before a self-close.** If the run peeked mail, its ack is sent before the close is dispatched, so a delivered page is not left unmarked by the kill. If the ack fails, the letters stay unread on a closed session; that is harmless.

### 2.6 Detector-off and liveness (T13 OPEN item; question F3-L)

Under a revoked gate, migrated `check_inbox`, `wait_for` and `close_session` make zero calls (G1), and they have no direct twin (G7).
- **Nothing is lost.** Unread mail stays unread, and `report` stays direct (m-7377), so §7.1's "no lost terminal report" holds.
- **But the session is deaf.** It cannot read mail or wait until it is relaunched, and the design has no automatic restart (§7.1). The wake pointer still arrives, but a `check_inbox` in that launch is refused.
- **The agent is told.** The refusal carries a fixed diagnostic `mail-unavailable-until-relaunch`, with the closed message "mail and waiting are unavailable in this launch; report your state and end the turn".

**Disposition: L1 with a required relaunch (s-292, m-7406).**
- Deafness lasts until relaunch, with the diagnostic above.
- **The relaunch is required, not optional.** Its signal is the in-process refusal/revoke record that T12a-Claude already owes (m-7275). On that record the host relaunches the session classic at its next idle point, and the session is told why.
- This is a host change with its own test, in s-293's T12a-Claude scope. F3 activation waits for it.
- The lead tells the human that a Code Mode off-switch makes running Code Mode sessions deaf to mail until that relaunch. If the human prefers **L2** (`check_inbox` and `wait_for` stay direct permanently, like `report`), F3 shrinks to `close_session`.

### 2.7 Routing texts

- `TERMINAL_OPERATIONS` keeps only `report`. The guide line becomes "report is always a top-level tool call".
- `RULES` keeps "close, mail, wait" as subjects of the unchanged rules.
- The Codex example rows for `check_inbox` and `wait_for` change their notes:
  - `check_inbox`: "mail arrives in result.mail; do not return it";
  - `wait_for`: "the wait runs after the script; nothing after it runs".
- These are agent-visible text changes and go into T10 text inputs.
- **Ruling F3-T (m-7406).** The human's m-7370 together with m-7391 supersedes m-6667 for `check_inbox` and `wait_for`. `TERMINAL_OPERATIONS` keeps only `report`.

## 3. Batches

### F3-H — two-phase host inbox (SENIOR-ONLY)

Why senior: it is a new host operation on the authority route (§5.2 reopened: "no new host endpoint or transport-status mechanism is assumed"), it changes mailbox read-mark semantics, and it touches concurrency with parallel readers.

- **Base.** The R1–R4 merge. It is independent of W0 and can run in parallel with it. Worktree `w-0054-f3-h`, branch `parley/w-0054/f3-h` (proposed).
- **Files:**
  - `core/src/mcp/tools.ts`: split `takeInbox` into `peekInbox` + `markRead`; add peek mode to `waitFor`;
  - `core/src/mcp/remote-tools.ts`: `RemoteToolRequest` ops `inbox-peek`, `inbox-ack`; the remote-only caller methods;
  - `host/src/agent/tools-endpoint.ts`: ops, auth, the delivered-ids map, `CANCELLABLE` for peek-mode waits;
  - their tests.
- **Acceptance:**
  1. Classic `check_inbox` and `wait_for` results are byte-identical before and after the split (fixtures: fenced, stale, assignments, 620 letters).
  2. A peek marks nothing; the wake pointer still counts the letters.
  3. The page bound keeps whole letters in `seq` order, and `more` is exact.
  4. An ack marks exactly the ids delivered by the named peek `callId`. An undelivered id or an unknown `callId` is refused, nothing is marked, and the refusal is fixed. A repeat is a no-op.
     - A stray earlier peek that finishes between P2 and P2's ack does not affect that ack (s-296 R1).
     - The map's entry limit and TTL are tested.
  5. A letter arriving between peek and ack stays unread.
  6. A peek-mode wait that is aborted marks nothing, drops its replay record and still writes `ParleyWaitEnd` (s-296 R4).
  7. A stale agent gives `STALE_AGENT` on both ops.
  8. Neither op is in `tools/list` for any profile, and the guest cannot reach either.
  9. Mutants:
     - a peek that marks;
     - an ack that accepts any id;
     - a map keyed by session instead of by peek `callId`;
     - a page cut that splits a letter;
     - `more` off by one;
     - a peek-mode wait that marks on timeout.
  10. Core and host tsc; both Nodes; the lock; zero skips.
- **Size (estimate, not measured):** 6–8 files, about +600/−60; 10–14 h.

### F3-W — wrapper terminal intents and result sections (SENIOR-ONLY)

Why senior: slot and lease lifetime, scheduler states, cancellation and recovery (T8h).

- **Base.** W0, with F3-H merged. Worktree `w-0054-f3-w`, branch `parley/w-0054/f3-w` (proposed).
- **Files:**
  - `code-mode/scheduler.ts`: lease state `terminal-wait`, busy reason `waiting`;
  - `code-mode/helper.ts`: terminal intent, `after-terminal`, `one-inbox-read-per-run`;
  - `code-mode/broker.ts`: deferred dispatch after quiescence; peek receipts terminal; `mail`/`wait`/`close` sections; ack at the answer edge;
  - `code-mode/contracts.ts`: sections, refusals, diagnostics, version;
  - `code-mode/run-record.ts`: `#peek` names;
  - `code-mode/migration-registry.ts`: `#peek` entries with effect `read`; `close_session` destructive admission;
  - `code-mode/catalog.ts`;
  - `mcp/code-mode-tools.ts`: ack edge, cancellation, hints;
  - their tests.
- **Acceptance:**
  1. **§2.2 ack edge.**
     - The ack is sent only after a valid result.
     - No ack on cancel, on a failed build, or on an `unknown`/`unread` peek.
     - Mail survives a guest that returns 20 KiB, throws, or drops the value.
     - **R2:** `check_inbox`, then `wait_for(session)`, then a trigger while waiting. The result carries `mail`, and no ack is sent.
     - **R3:** a cancel after the ack resolves gives the "page marked, answer dropped" log line and no answer.
  2. **Deferred wait.**
     - It starts only after quiescence, with the slot free and the lease held.
     - `code_execute` meanwhile gets `busy/waiting`, and direct tools work.
     - The timeout is clamped by elapsed time, and a test proves the 1,830 s bound.
     - Cancel aborts the host wait: zero marks, receipt `cancelled`, lease released.
     - A detector trigger while waiting gives `not-run/revoked`.
     - **R4:** Stop or auto-sleep during a deferred wait gives a record naming only `wait_for#peek`, zero marks, the slice-D log line, and the next launch classic `held-run`.
  3. **Terminal rules.**
     - A second terminal intent → `after-terminal`.
     - A call after a terminal intent → `after-terminal`, zero dispatch.
     - `check_inbox` together with `wait_for("inbox")` → `one-inbox-read-per-run`.
  4. **Peek receipts.**
     - Every non-200 route of a peek is terminal and does not hold the lease.
     - A record naming only peeks → `held-run`.
     - A B0-reader fixture with a `#peek` name → `blocked`.
  5. **`close_session`.**
     - Dispatched last, with one attempt.
     - A self-close fixture whose process dies before the answer leaves an `unaccounted` record naming `close_session`.
     - The mail ack is sent before the close.
     - Hints are `destructiveHint: true` only in launches holding it.
  6. **L1, if chosen:** the `mail-unavailable-until-relaunch` diagnostic, with its fixed text, on every refused mail or wait call under a revoked gate.
  7. **Mutants:**
     - ack before the result is built;
     - ack on cancel;
     - ack under a revoked gate;
     - a peek receipt held as `unknown`;
     - the wait run before quiescence;
     - no clamp;
     - a call admitted after a terminal intent;
     - close dispatched before quiescence;
     - close retried.
  8. Core tsc; both Nodes; the routing sweep; the lock; zero skips.
- **Size (estimate, not measured):** 12–15 files, about +900/−80; 12–18 h.

### F3-A1 — `check_inbox` and `wait_for` adapters (Sonnet)

- **Base.** The F3-W commit.
- **Files:**
  - `code-mode/write-adapters/{inbox-message,check-inbox,wait-for}.ts` and tests;
  - 2 table lines; 2 registry names;
  - `work/code-mode-instructions.ts` and its test (§2.7, after F3-T).
- **Rules:**
  - The message DTO models `id, from, fromLabel, at, text, kind, room, replyTo?, via?, toEveryone?, roomTask?, assignment?`, with `unknownFields`.
  - `wait_for` states are a closed union: `message`, `running`, `deleted`, `stuck`, `asleep`, `done`, `failed`, `sleeping`, `closed`, `not-run`. Any other state → `shape-mismatch`.
- **Acceptance:** F1's WA items 1–4, 8 and 9 for these two methods, plus §2.7 text tests (classic text byte-identical).
- **Mutants:**
  - drop `roomTask`;
  - accept an unknown state;
  - make `more` optional;
  - keep `check_inbox` in `TERMINAL_OPERATIONS`.
- **Size (estimate):** 7–8 files, about +650; 8–10 h.

### F3-A2 — `close_session` adapter (Sonnet)

- **Base.** The F3-W commit; it runs in parallel with A1.
- **Files:** `code-mode/write-adapters/close-session.ts` and its test; 1 table line; 1 registry name.
- **Rules:**
  - Output `{sessionId}`.
  - Fixtures for each authority branch: self, a descendant, a `closeFinished` member, a refused swarm member, an already-closed target.
- **Acceptance:** F1's WA items 1–9.
- **Mutants:**
  - accept a missing `sessionId`;
  - let a swarm member fixture pass;
  - treat already-closed as success.
- **Size (estimate):** 2–3 files, about +250; 2–4 h.

### Order and merges

```
R1..R4 merge → (W0 ∥ F3-H) → F3-W → (F3-A1 ∥ F3-A2) → merge A1, A2 → A-check_inbox, A-wait_for, A-close_session (serial)
```

- **Shared files:** `write-adapter-table.ts` and `MIGRATABLE_WRITES` are append-only. They come after F1's W1–W6 lines if F1 merges first; otherwise the order is resolved at merge.
- **`code-mode-instructions.ts`** is edited by W0, W6 and F3-A1, in that order.
- **Activation** waits for INTERIM, T12b, T8h, the provider's consent reader, and the T12a-Claude host relaunch at idle (F3-L, m-7406).

## 4. Spec and plan text to amend after acceptance

- **§7:** "`wait_for` is unsupported inside scripts initially" → the deferred terminal await (§2.4).
- **§5.2:** "no new host endpoint or transport-status mechanism is assumed" → reopened for `inbox-peek` and `inbox-ack` only.
- **§4 line 198:** `check_inbox` and `wait_for(inbox)` are excluded → the two-phase inbox.
- **§6:** the 30 s wall now excludes the deferred wait, which has its own bound (§2.4).
- **Plan T11 rows** for the three methods; the T13 OPEN item (F3-L's disposition).
- **The T8b terminal sentence** (after F3-T); the T11 batch plan terminal row.

## 5. Rulings (s-292, m-7406; s-296, m-7405)

- **F3-L.** L1, with the host relaunch at idle required. It is in T12a-Claude's scope (s-293), and F3 activation waits for it. The human is told and may choose L2.
- **F3-T.** m-6667 is superseded for `check_inbox` and `wait_for`; `TERMINAL_OPERATIONS` keeps only `report`.
- **F3-P.** 32 KiB pages, to be measured in T10.
- **Contract.** The host-owned `mail` and `wait` sections sit inside the 64 KiB result text and are built from decoded DTOs only. The contract version is bumped once.
- **s-296 R1–R4** are in §2.1, §2.2, §2.4 and in F3-H/F3-W acceptance.

## 6. Not verified

- Nothing was run: no tests, no tsc, no `tools/list`.
- Whether the host's in-memory map of delivered ids survives what it must: a host restart drops it, so an ack after a restart is refused and the letters are redelivered. That is safe, but the cost is not measured.
- Whether Claude Code keeps a `code_execute` call open for up to 1,830 s. Codex's 1,860 s is configured; Claude's MCP tool timeout for long calls is not checked here, and classic `wait_for` relies on the same limit.
- Whether `turnBoundarySince` (Codex abandoned the call) fires correctly when the abandoned call is `code_execute` rather than `wait_for`.
- The relaunch-at-idle path for L1: there is no host mechanism today. It is owed by T12a-Claude (m-7406).
- How often mail would be redelivered under at-least-once (not measured).
- PTY-less sessions: no kill path was found, so a self-close only changes the map (fact 5).
- All sizes and hours are estimates from reading code, not measurements.

## Impact card

- **Goal:** move `check_inbox`, `wait_for` and `close_session` into `code_execute` without losing mail, holding a slot during waits, or racing a self-close.
- **Behaviour:** none yet; a design. If built and activated:
  - mail read in a script reaches the model in a host-owned section and is marked read only after the answer is built;
  - waits run after the script, with the runtime slot freed;
  - a close is the run's last call.
- **Numbers:** 3 methods; 2 senior batches and 2 Sonnet batches. Estimates, not measured: about +2,400 lines including tests and 32–46 h. Order-doc design estimate: 8–12 h.
- **Screens:** none.
- **For the human:**
  - Inside Code Mode, a mail page is at most 32 KiB, and the rest arrives on the next check.
  - A letter may occasionally arrive twice, but is never lost to a script.
  - A letter can be lost only if the client cancels while the answer is being written, as in classic.
  - If you switch Code Mode off mid-task, the agent cannot read mail or wait until Parley relaunches it classic at its next idle point (F3-L), though it can still report.
  - A deferred wait can be slept like a classic one.
- **Risk:**
  - a new host operation on the authority route;
  - the ack edge and its named window;
  - the deafness under detector-off until the relaunch;
  - the self-close race, which is the same as classic.
- **Cost:** not measured.
- **Verdict:** accepted by s-296 (CLEAR with R1–R4, m-7405) and s-292 (m-7406).
