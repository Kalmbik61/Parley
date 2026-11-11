# code_execute agent view (contract v4) — design note

Rev 1 (after s-292 m-7650): E-1 has been added (§2, §5, §7).
- Rulings: CONTRACT_VERSION 4 is accepted. The target is judged per call (D1), and discovery is reported as its own per-session line in every table. D2 is rejected; D3 comes next.
- The T9a gate reruns on v4 on both Nodes.

Rev 2 (ACCEPTED, m-7655: s-296 CLEAR m-7653, s-292 ACCEPT m-7650). The build spec is §5–§7 plus E-1, plus these:
- **V1.** `isRead` comes from the catalogue the run actually used: the same `Resolved` whose broker launch ran the methods. It is never taken from a catalogue re-resolved at answer time. A method that catalogue does not contain reads as non-read and is listed.
  - Test T17: a run whose catalogue marks a method `write`, answered while a later resolve would call it `read`, still lists the row.
  - Mutant M17: `isRead` taken from a fresh resolve.
- **V2.** The fallback attempts in `toResult` (`invalid-output`, `helper-failure`) keep `base` (runId, operations). A fallback view after dispatched calls therefore lists every row. T12 asserts the rows, not only the kind.
  - `FAILED_TEXT` (no rows) is the one path where receipts can be missing, as in v3.
- **N1.** `agentViewProblem` also checks `runId`: it is present exactly when status ≠ completed and `full.runId ≠ null`, and it equals `full.runId`.
- **A-1** (Rev 3, s-314 self-finding after acceptance; a harness gap only, product unchanged). The conservation phase reads the raw execute body:
  - `tools/parley-token-benchmark-replay-run.ts:192-193` reads `whole.body.operations[0].responseBytes` and `whole.body.error` for the `wholeGuide` report row;
  - `:150` reads `run.body.value`.
  - In v4 the wire has no `responseBytes`, and it has no rows on a clean completed run. So the phase `exec` in arms.ts (`input.phase … run: exec`) must return `body` = the parent's full ExecuteResult from the tap whenever `full` is present, and the wire body only when `full === null`. `value` is the same in both, so the guide and roles comparisons are unchanged.
  - Test: `wholeGuide.replacement.readBytes` stays non-null on the guide goals.
  - Mutant M18: phase body = wire → readBytes is null → RED.
- **E-1b** (Rev 3, an answer to s-296 m-7658: which zero-op cause gives a bare `incomplete:true`). Read from the code, not run. Two causes exist; both are completed runs with no operation and no diagnostic.
  1. `refused.notSerializable > 0` (`guest.ts:212`). The guest itself refuses a `parley.<m>()` call to a method outside the run's methods, or with arguments that do not stringify. The script catches it and returns. `finalIncomplete` (`broker.ts:124`) raises the claim, but `diagnosticsOf` (`code-mode-tools.ts:298-304`) maps every refused counter except `notSerializable`.
  2. `outcome.unsettled` holds a call that was queued in the guest but never left it (`guest.ts:195`). It has no ledger entry, so it has no operation and no diagnostic.
  - **Proposed fix** (contract, for s-292): one new host-template diagnostic, `calls-not-made`.
    - Params: `{cause: 'refused-in-script' | 'not-started', count: integer ≥ 1}`, with no ordinal or method.
    - Messages: "<count> call(s) refused inside the script: unknown method or arguments not JSON" and "<count> call(s) started by the script never left it".
    - `diagnosticsOf` emits it from `refused.notSerializable` and from the `unsettled` rids that have no operation.
  - With it, every incomplete has a stated reason. `agentViewProblem` then refuses a completed `incomplete:true` view that has neither rows nor diagnostics, unless there are zero ops and only the broker's claim with no counters; none such is known.
  - Tests:
    - T18: a script that calls `parley.nope()` in try/catch and returns gives `calls-not-made` with cause `refused-in-script`.
    - T19: a script that returns without awaiting a queued call gives cause `not-started`, if the helper can produce it. Otherwise the test is named as not reachable.
  - Mutant M19: the notSerializable mapping is removed → RED.
  - **ACCEPTED** (s-292 m-7665, rides v4). The cause set is closed, the message is a fixed host template, and no guest text is used.
    - `agentViewProblem` refuses a bare completed `incomplete:true`, one with no rows and no diagnostics. A third, unknown cause therefore surfaces as `invalid-output` (fail-closed). The guest's value is lost in that case, which is accepted.
    - E-1's all-rows rule stays for incompletes that have rows.
    - The spec's diagnostics list gains `calls-not-made` in the same doc freeze.
  - **T19 condition** (s-296 m-7664, s-292 m-7666). For the not-started calls, T19 asserts that the host log shows no call and that the run record holds none. `not-started` is never said of a call the host saw.
  - Mutant M20: emit `not-started` for an admitted call (one with a ledger entry) → RED.
- **N2.** The `seq` tap holds because a second concurrent run is refused as `busy`, so at most one run is in flight per connection. The concurrency test states "one run plus one busy".

Author s-314 (Opus), room r-26. Design only. Base: `parley/w-0054/s-293` at 29326bfa (read-only).
Reviewers: s-296 (gates, isolation), s-292 (contract, spec). Builder after acceptance: Sonnet (s-306).

## 0. What the 3.0–3.4 KB actually is (read this first)

The T9a report (`tok-report.json`, `accounting.<goal>.replacement.perMessage`) shows that the replacement arm makes **two** wrapper calls per goal.
`callB repl` is their sum, not one code_execute envelope:

| goal (like-for-like) | direct result B | code_search B | code_execute B | calls~ gap now (tok) |
|---|---:|---:|---:|---:|
| read-session-detail | 1020 | 2644 | 667 | +504 |
| read-room-letters | 910 | 2644 | 707 | +554 |
| read-role-catalogue | 4421 | 2644 | 2034 | −125 |
| read-backlog-entries | 678 | 2644 | 777 | +654 |
| hostile-letter-remains-data | 682 | 2644 | 682 | +628 |
| projection-cannot-clear-incomplete | 8854 | 2644 | 595 | −1764 |
| plan-read-preserves-content | 488+993 | 2644 | 974 | +403 |
| denied-room-is-tool-error | 130 | 2644 | 809 | +855 |
| unavailable-host-read | 4289 | 2644 | 657 | −391 |
| host-list-404-is-unavailable | 4303 | 2644 | 446 | −480 |
| remote-404-cannot-read-local-store | 4315 | 2644 | 657 | −414 |

- On 9 of the 11 goals, code_execute is already no bigger than the direct result. Only backlog (+99 B) and denied-room (+679 B) are bigger.
- The fixed cost is the discovery page. The arm calls `code_search {query: script.search ?? 'parley'}` (`tools/parley-token-benchmark-replay-arms.ts:519`), and that page is 2644 B on every goal.
  - Estimated cost: about 650–700 o200k tokens. Method: a locally rendered search page measured 3.79 B/token, and calls~ minus the execute share gives about 635.
- **Consequence for the target.** Even a zero-byte envelope leaves 5 goals above "direct + 100" *per goal*. The envelope can only bring *per call* within target. Section 4 has the numbers.
- The per-goal target needs a separate decision on discovery. Options, not designed here:
  - **D1.** Judge the target per call, and report discovery as its own once-per-session line.
  - **D2.** Narrow the replay's discovery query to the method name, using the existing per-goal `search` field (a scripts change, scriptsSha moves).
    - Measured locally on the dist catalogue: `"get_map"` 423 B / 125 tok, `"read_room"` 334 B / 106 tok.
  - **D3.** A separate product item that shrinks code_search pages.
- Even with D2, denied-room stays about +165 per goal, by estimate: its direct answer is 130 B, and any discovery call costs about 100 tokens or more.

## 1. Principle

- **The parent computes exactly what it computes today.**
  - `makeExecuteResult` and every check in `serializeExecuteResult` run unchanged: the closed schema, `resultProblem`, `provenanceProblem` and the value budget.
  - Incomplete, unread, U2/unknown, limit-reached, the run record, policy refusals and `isError` all still come from the full `ExecuteResult` in the parent.
- **The agent receives a projection** of that checked result: the *agent view*.
  - It is rendered from the checked result only, and nothing is recomputed.
  - It is re-checked against the result before it is sent, for status, incomplete, error kind, every limit-reached and every non-clean op.
  - A failed check fails closed: toResult falls to its next attempt (error `invalid-output`, then `helper-failure`, then `FAILED_TEXT`). It never falls to a success.
- **Only fields the agent cannot act on are dropped.** Every status, error and completeness marker is always explicit, with no "absent means fine" rule:
  - `status` and `incomplete` are in every view;
  - `error` is in every non-completed view.

## 2. Agent view, field rules

Key order is fixed as listed. JSON is compact, and the closed schema `AGENT_VIEW` lives in contracts.ts.

| field | present when | content |
|---|---|---|
| `status` | always | `completed` \| `error` \| `partial-or-unknown` (as v3) |
| `incomplete` | always | boolean, = `ExecuteResult.incomplete` (explicit `false` too) |
| `value` | iff status = completed | the final value (as v3) |
| `error` | iff status ≠ completed | `{kind, message}` exactly as v3 (host template) |
| `runId` | iff status ≠ completed and runId ≠ null | as v3 |
| `operations` | iff at least one row is selected | rows `{ordinal, method, dispatched, outcome, incomplete}`; selection below |
| `diagnostics` | iff non-empty | v3 entries `{code, params, message}` unchanged (busy text included) |
| `diagnosticsTruncated` | iff true | `true` |

**Row selection**:
- status ≠ completed: **every** operation.
- status = completed: every operation **except** one that is all of: a catalogue read (`effect: 'read'`), `outcome: 'succeeded'` and `incomplete: false`.
- **E-1** (s-292, m-7650). Suppose status = completed and `incomplete: true`, but the rule above selects no row and `diagnostics` is empty. That happens, for example, when the incompleteness is the broker's own claim. Then **every** operation is listed, so the agent sees what ran.
  - With zero operations there is nothing more to show, and the explicit `incomplete: true` stays.
- Why: the agent sees every refused, failed, cancelled, unread, unknown, draining or incomplete call. F1 "Receipts" (`2026-11-10-code-mode-family-f1-writes.md`: writes recorded in operations in every result) stays true for the agent too, because a non-read op is never omitted.

**Dropped from the agent text**, with the reason:
- `contract`: the agent does not version-switch, and the version still enters apiRevision.
- `apiRevision`: the agent sent it.
- `argsSha256`, `responseBytes`: not actionable. Limit hits arrive as `limit-reached`.
- `error: null` and `value: null` on the wrong status.
- `diagnosticsTruncated: false`.
- `runId` on a completed run.

All of these stay in the parent's `ExecuteResult`.

`isError` is unchanged: `true` iff status ≠ completed. The `code_execute` descriptor is unchanged (no list bytes, no toolList conservation impact).

### Shapes per status (real texts from the reference projection, synthetic values)

**completed, clean** (the small read):
```
{"status":"completed","incomplete":false,"value":{...}}
```

**completed + incomplete.** The causes are an op the adapter saw as incomplete (page.next/cut/complete:false), a caught failed call, a guest- or broker-refused op, or the broker's own claim. `isError` is absent.
```
{"status":"completed","incomplete":true,"value":{...},"operations":[{"ordinal":1,"method":"read_room","dispatched":true,"outcome":"failed","incomplete":false}],"diagnostics":[{"code":"call-failed","params":{"ordinal":1,"method":"read_room"},"message":"call 1 (read_room) returned an error"}]}
```

**error before any run** (`invalid-request`, `stale-revision`, `unavailable` with no run, `busy`). There is no runId and no operations; `busy` carries its one busy diagnostic and that diagnostic's stop-retrying text.
```
{"status":"error","incomplete":true,"error":{"kind":"stale-revision","message":"The apiRevision is not the current one; read code_search/code_docs again."}}
```

**error after a run started** (`unavailable` after a host 404, `syntax`, `runtime`, `timeout`, `cancelled`, `quota`, `tool-error`, `invalid-output`, `helper-failure`):
```
{"status":"error","incomplete":true,"error":{"kind":"unavailable","message":"Code execution is not available for this session."},"runId":"…","operations":[{"ordinal":1,"method":"get_map","dispatched":false,"outcome":"refused","incomplete":false}]}
```

**partial-or-unknown** (`unsettled`):
```
{"status":"partial-or-unknown","incomplete":true,"error":{"kind":"unsettled","message":"A call's outcome is unknown."},"runId":"…","operations":[{"ordinal":1,"method":"get_map","dispatched":true,"outcome":"unknown","incomplete":true}],"diagnostics":[{"code":"call-unsettled",…}]}
```

**Each limit** (`code-bytes`, `argument-bytes`, `response-bytes`, `result-bytes`, `operations`, `in-flight`, `active-time`, `wall-time`, `memory`):
- It always arrives as `diagnostics[{code:"limit-reached",params:{limit},message:"limit reached: <name>"}]`, on whichever status the run has.
- `diagnostics` is never omitted when non-empty, so a limit is never silent.
- A guest-floor limit has no op, and it still arrives this way.
- If diagnostics were truncated, `diagnosticsTruncated:true` says so.

## 3. Opt-in

None. Nothing the agent can act on is removed. A `detail` flag would:
- change the execute request schema, which puts bytes into every tools/list and changes `REQUEST_SCHEMAS`;
- add a branch to gate and test;
- serve no agent use.

The full result stays in the parent and reaches the T9a judge through the server tap (section 6).

## 4. Cost, before → after (ESTIMATE, not measured)

**Method**
- v3 texts come from the real `serializeExecuteResult` in `packages/core/dist` at 29326bfa.
- v4 texts come from a reference projection of the *same* `ExecuteResult`.
- Values are synthetic, and the counts use js-tiktoken 1.0.21 o200k_base from the T9a tok dir.
- Scripts: `measure.mjs` and `measure2.mjs` in this scratchpad, output in `measure2.out`.
- v3 with a real-format apiRevision is about 30 tokens more than the `a×64` placeholder in measure2: 216 versus 186 on the clean read.

**Per call**

| case | v3 tok | v4 tok | saved |
|---|---:|---:|---:|
| value alone (small) | 24 | 24 | – |
| completed clean, 1 op | 216 | 36 | ~180 |
| completed clean, 2 ops | ~290 | 36 | ~254 |
| completed, op incomplete | ~216 | 65 | ~150 |
| completed, caught failed call | 247 | 107 | ~140 |
| error stale-revision | 112 | 38 | ~74 |
| error unavailable after 404, 1 op | ~208 | 96 | ~112 |
| partial-or-unknown | 243 | 135 | ~108 |
| error quota + limit | 231 | 122 | ~109 |

- The envelope overhead on a clean small read drops from about 190 to about 12 tokens over the value.
- Per call, all 11 goals land within "direct + 100" by estimate. denied-room is the closest, at about +65: its value carries the original MCP error result, which is the same data the direct call returns.

**Per goal**, as calls~ gap from the T9a table minus the estimated saving:
- session +325, room +375, role −305, backlog +505, hostile +450, projection −1915, plan-read +150, denied +715, unavailable −500, host-list-404 −590, remote-404 −525.
- The 6 positive goals are each still mostly the ~650–700-token discovery page. Section 0 has the options.

## 5. Files the executor touches; contract and spec changes

**Product**
- `packages/core/src/mcp/code-mode/contracts.ts`
  - `CONTRACT_VERSION` 3 → 4, with one doc-comment line: "v4: the MCP text is the agent view; ExecuteResult is the parent's record". Recommended; s-292 rules.
  - Add the `AgentView` type and the closed `AGENT_VIEW` schema.
  - Add `renderAgentView(validators, result, isRead: (method) => boolean): string`. It works in this order:
    1. call `serializeExecuteResult` (so every existing check runs);
    2. project;
    3. validate its own text against `AGENT_VIEW`;
    4. run `agentViewProblem(view, result)`, which checks that status, incomplete and error.kind are equal, that the set of limit-reached limits is equal, that every non-clean op and every non-read op is present, and the E-1 rule;
    5. throw `ContractError('invalid-output')` on any problem.
  - `parseExecuteResult` and `makeExecuteResult` are unchanged.
- `packages/core/src/mcp/code-mode-tools.ts`
  - `answer()` renders `renderAgentView` instead of `serializeExecuteResult`, and gets `isRead` from the resolved catalogue (`documentedRead`).
  - `execute()` returns an internal `{ call: CallToolResult; full: ExecuteResult | null }` (null on the `FAILED_TEXT` paths), and `call()` returns `.call`.
  - No other mapping changes: `toResult`, `preRun`, `diagnosticsOf`, `errorKindOf` and the attempt chain all stay as they are.
- Tests:
  - `contracts.test.ts` and `code-mode-tools.test.ts`;
  - `code-mode-client-gone.test.ts` and `code-mode-launch.test.ts`, wherever they read v3 fields from the text.

**Harness** (tools/)
- `parley-token-benchmark-replay-arms.ts`
  - The preload execute anchor becomes `return (await execute(state, args, signal)).call;`. The tap appends `{seq, code, result: done.call, full: done.full}`, where `seq` is a per-server counter taken when the request enters `execute`.
  - `result`, `second`, `nextRun` and phase `exec` use `executeLike(full)` matched by the request's send order (`seq`). They fall back to the wire body only when `full === null`.
  - Answers still come from the wire body.
- `parley-token-benchmark-replay-judge.ts`: the new invariant and the abort change in section 6.
- Their tests, plus the replay self-check cases.

**Spec and plan** (`w-0054-code-mode-docs`)
- spec §4, the paragraph "The execute result contains…": the MCP text is the agent view (the section 2 table). The parent keeps the full ExecuteResult.
- spec §6, "Accepted T7a wrappers" (CONTRACT_VERSION 3): add a v4 record line on acceptance.
- `2026-11-10-code-mode-family-f1-writes.md`, Receipts: add "the agent view never omits a non-read op".
- plan T9a: the judge reads parent results from the tap, plus the new invariant.

## 6. T9a judge rules and goals touched; conservation

**Source change (semantics unchanged)**
- These now read the parent's full result from the tap instead of the agent text:
  - `executeLike` and every `run` criterion: `status`, `incomplete`, `errorKind`, `runId`, `busyReason`, `diagnostic`, `limitReached`, `operations`, `operationsInclude`, `noValue`;
  - the invariants `attempt-has-result`, `one-call-id-per-operation`, `incomplete-floor`, `unknown-keeps-record` and `claims-complete`.
- Without this, a clean run's omitted rows would break the following, which therefore read the tap:
  - `one-call-id-per-operation` (0 dispatched rows against 1 call id);
  - `hostile-letter-remains-data`'s `operations` criterion.

**Still read from the agent text (unchanged meaning)**
- The answer extraction (`body.value`).
- Raw extracts:
  - `error.kind`, in unavailable-host-read, host-list-404-is-unavailable and remote-404-cannot-read-local-store. It is kept, because `error` stays an object;
  - `diagnostics` where `code = limit-reached`, in argument-bytes-positive-boundary and response-bytes-positive-boundary. It is kept, because it is present when non-empty.
- `text.neverContains $canary`.

**New invariant `agent-view-faithful`** (replacement arm, every execute answer with a `full`):
- The wire text, parsed, deep-equals the judge's **own literal** projection of `full`. It is written in the judge and not imported from the product, the same anti-circularity rule as `CODEX_ROWS`.
- `isError === (full.status !== 'completed')`.
- This is the conservation link: every fact the judge reads from the parent is shown to the agent, or is one of the named dropped fields.

**`abort-no-answer-delivered`**
- `runId` is now on the wire only for non-completed views, so the check also asserts that no response to the cancelled request's JSON-RPC id was received.

**Unchanged**
- Goals (`read-workflows.json`, goalsSha) and scripts (scriptsSha), unless the owner picks D2.
- The accounting method. The re-measure uses the same o200k dir.

**Self-check**
- Add wrongly-passing cases that must fail:
  - wire `incomplete:false` against full `true`;
  - wire without a limit-reached that full has;
  - wire `completed` against full `error`;
  - a wire op row missing for a failed op.

## 7. Tests and mutants

**Tests**
- T1: clean completed. Keys are exactly `status`, `incomplete`, `value`, with `incomplete:false` and no `isError`.
- T2: completed with one incomplete-succeeded op among clean ones. Only that row is shown, with `incomplete:true`.
- T3: a caught failed call. The row and `call-failed` are shown, with `incomplete:true`.
- T4: a guest-floor limit (no op) and a broker-refused op. `limit-reached` is shown, and the refused row is shown.
- T5: each pre-run kind (4). `error` is present; there is no runId and no operations; `isError`; busy carries the exact `BUSY_TEXTS` message.
- T6: each post-run kind (all 13 `ERROR_KINDS` reachable through `toResult`). error.kind, runId, every row and `isError`.
- T7: partial-or-unknown. The status, `unsettled`, the unknown row with `incomplete:true`, and `isError`.
- T8: each of the 9 `LIMIT_NAMES` reaches the view.
- T9: `diagnosticsTruncated` true is present; false is absent.
- T10: over every valid ExecuteResult fixture in contracts.test.ts, the view's status, incomplete, error.kind and limits equal the result's.
- T11: a forged method or a foreign revision is still refused (the `serializeExecuteResult` checks run first).
- T12: a renderer failure gives error `invalid-output`, then `FAILED_TEXT`, never `completed`.
- T13: a hostile value whose own keys are `status`, `error` or `incomplete` stays inside `value`. Top-level keys are exactly the rule's.
- T14: a non-read op (a fixture catalogue with a write) on a clean completed run is still listed.
- T15: a size guard. A clean 1-op view is at most the value bytes + 60 B.
- T16 (E-1): completed, `incomplete:true` from the broker claim only, every op a clean succeeded read and no diagnostics. All rows are listed. Also: the same case with zero ops gives `{status, incomplete:true, value}`.
- Harness:
  - two concurrent runs with identical code are matched by `seq`;
  - `agent-view-faithful` passes on the 58 goals and fails on each self-check case.

**Mutants** (each must go RED)
- M1: `incomplete` is always false.
- M2: `incomplete` is dropped when false.
- M3: the completed filter keeps only `outcome ≠ succeeded`, which drops incomplete-succeeded rows.
- M4: diagnostics are dropped on a completed run.
- M5: only limit-reached is dropped.
- M6: partial-or-unknown is rendered as error.
- M7: `error` is omitted on a non-completed run.
- M8: `value` is shown on an error, or omitted on completed.
- M9: a non-completed run lists only the non-succeeded rows.
- M10: `isError` is set only for `status === 'error'`.
- M11: `renderAgentView` skips `serializeExecuteResult`.
- M12: `agentViewProblem` always returns null. A unit test with a tampered view catches it.
- M13: the busy message is replaced.
- M14: `diagnosticsTruncated:true` is dropped.
- M15: `isRead` is ignored, so writes are omitted.
- M16 (E-1): the fallback that lists all rows is removed, and T16 goes RED. A second mutant removes only the E-1 check in `agentViewProblem`; a tampered-view unit test catches it.
- Harness:
  - H1: the judge reads the wire instead of the tap (the hostile and one-call-id checks go RED);
  - H2: the faithful check ignores `incomplete`;
  - H3: the tap is matched by code sha instead of `seq`.

## 8. Risks

- **Clients of the v3 text.**
  - In the repo: the T9a harness (handled in section 6), and the core tests named in section 5.
  - Not checked by me:
    - T10's offline script (e691a7f4, `parley/w-0054/t10`);
    - the T12a-Claude isolated-run tooling;
    - the R1/R2 decoders, which the lead says build on the envelope. As I read them, the decoders are guest-side `ReadResult` and do not parse the MCP text, but this needs confirmation by their owners.
  - Outside the repo: none. A real launch has no broker yet (`liveBackend`), so no shipped client has seen v3 text.
- **Version bump.** Bumping to v4 changes every apiRevision, and tests that pin a revision value must update.
- **A model that learned v3**: it loses `apiRevision`, `argsSha256` and `responseBytes`, none of which it needs. `status` and `error.kind` keep their places.
- **The write cohort.** The `isRead` rule keeps receipts. A future effect such as `unknown` is treated as non-read, so it is listed.
- **Tap ordering.** `seq` assumes requests enter `execute` in receipt order on one stdio connection. Two first calls share one memo promise, so FIFO is kept. H3 and the concurrency test cover it.
- **The target.** Section 0: per goal, it is not reachable through the envelope while each goal pays a ~650–700-token discovery page. That decision belongs to the lead and the owner.

## Not verified

- Every token number here is an estimate on synthetic values rendered locally. None comes from the T9a run, and the real per-goal values were not rendered.
- The token cost of the replay's 2644 B search page is derived from a byte ratio. It was not counted.
- The two arms' per-message token split: T9a stores tokens only for the whole stream.
- Whether T10's script, the T12a tooling or the R1/R2 branches parse the v3 text.
- That every `ERROR_KINDS` value is reachable through `toResult` (T6 must establish it).
