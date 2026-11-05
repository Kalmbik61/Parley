# b-026: report(done/failed) wakes the session that gave the task — plan

Lead: s-04 (room r-02). Executor: s-05. Owner: s-02.
Base: origin/master 54d64f75 or newer. Branch: `feat/report-wakes-task-giver`. English commits.

## Human decision (2026-11-05)

Inbox-letter variant. When session B reports done/failed and its latest task came from session A
(a direct message or `create_session`), A gets an inbox letter like `s-281 reported done: <first line>`
that wakes `wait_for("inbox")`. No new `wait_for` parameter.

## Settled design

### D1. Who is the "latest task giver" — derived, not stored

Nothing new is stored in the map. At `report(done|failed)` time the giver is derived from the letter
store and the map (one helper, `packages/core/src/work/task-giver.ts`, `lastTaskGiver(map, letters, B)`):

1. B is a member of an open (not archived) room → **no giver**. In a room the room protocol owns
   reporting: members report to the lead in the room.
2. B belongs to a swarm (`swarmOfSession(map, B) !== null`) → **no giver** (the queen has its own protocol).
3. Otherwise take the **newest letter received by B** that counts as a task: direct (`roomId === null`),
   `to` includes B, sender ≠ B, sender not `system`/`parley`, `kind !== 'question'`.
   Questions are not tasks and are skipped entirely (they neither set nor reset the giver).
   Letters whose sender was created by B (`sender.createdBy === B`: a child reporting back) are skipped too.
   - newest such letter is from `human` → **no giver**;
   - from an agent session A → giver A;
   - no such letter → giver = `B.createdBy` (the `create_session` caller), or none.
4. Giver filters: giver ≠ B, giver ≠ human, giver exists in the map and is not closed (a sleeping giver
   is fine: the letter wakes it under the usual resume limit, D5).

Use the store query `involving: [B]`, `roomId: null`, `newestFirst: true` with paging by `beforeSeq`
(page 50) until a counting letter is found or the store is exhausted; filter in code.

Known limit (goes to "Not verified" in the final report, not fixed here): text the human types straight
into B's terminal is not a letter, so it does not reset the giver.

### D2. The letter

- `from: 'system'`, `roomId: null`, `to: [A]`, `kind: 'note'`.
- Text (English, one line): `s-05 reported done: <first non-empty line of the summary, cut to 200 chars with …>. Full summary: get_map {session: "s-05", field: "summary"}`
  (`reported failed` for failed). Text builder and the matcher `isReportLetterAbout(message, B)`
  live next to each other in `task-giver.ts` (match: from system, roomId null, text starts with `${B} reported `).
- A direct letter with a non-empty `to` is already urgent (`wakesAtOnce`), so it wakes `wait_for("inbox")`
  and the host pointer immediately, with no settle window.
- Not to the human, not to B itself (D1.4). `progress` never sends a letter.

### D3. Repeated reports

Every `report(done|failed)` sends a letter — the re-tasked case keeps `result` at `done`, so a
"result changed" check would miss exactly b-026. To avoid piling up: in the same `writeLetters`
transaction, any still-unread report letters about B addressed to A are marked read for A
(`letters.markRead(A, ids, at)`) before the new one is added. A has at most one unread report letter
per B, always the newest status.

### D4. No duplicate when A waits on B by id

- Order in `report`: summary write (existing first `updateMap`) → letter (`writeLetters`) → `finishSession`.
  The letter exists before the status changes, so a waiter woken by the status sees it.
- In `waitFor` by id: when the probe returns a finished state (`done`/`failed`) to caller A — whether
  it waited or the result was already there — mark read for A every unread report letter about the target
  (`isReportLetterAbout`). A gets the result once, by id.
- Residual race (cosmetic, accepted): a Codex caller in `wait_for(B)` may get a queued pointer for the
  letter before the wait marks it read; its `check_inbox` then returns nothing.

### D5. Limits

- System letters are not agent messages: they do not count against B's or A's message budget or
  `messageRate` (`isAgentSender` already excludes `system`). Nothing changes there.
- Waking a sleeping A goes through the existing `resumeRate`: no bypass, no new limit.
- D3 caps unread report letters at one per (A, B).

### D6. Texts (keep consistent)

- `report` tool description: add that done/failed also mails the session that last gave the task by a
  direct message or `create_session`.
- `wait_for` tool description: the existing "wait for its answer to a new job via \"inbox\"" gains
  "— its next report arrives there as a letter".
- `packages/core/src/work/guidance.ts` (wait_for line, ~:112): same addition, short.
- `packages/core/src/work/guide.ts` (~:278 "Giving a new job…" and ~:641 "A session that only calls
  `report` sends no message…"): the second paragraph is now wrong for direct/create_session tasks —
  rewrite: such a session's report reaches you as a letter, wait via `"inbox"`; a session in a room
  reports in the room.
- `tools-size.test.ts` budgets must still pass; keep additions short.

## Tasks (one at a time)

### Task 1 — mechanism (s-05)

Files: new `packages/core/src/work/task-giver.ts` (+ `task-giver.test.ts`), `packages/core/src/mcp/tools.ts`
(`report`, `waitFor`), new `packages/core/src/mcp/report-letter.test.ts` (or extend an existing mcp test
file that already drives `report` + `wait_for`, e.g. `wait-for-take.test.ts` style). Copy this plan into the
branch as `docs/plans/2026-11-05-report-wakes-task-giver-plan.md`.

Acceptance (each a test):
1. A `create_session`s B; B `report(done)` → A has one unread direct letter from `system`, text starts
   `s-NN reported done: <first line>`; `wait_for("inbox")` of A returns it.
2. Re-task (the b-026 case): B already `done`; A sends B a direct note; B `report(done)` again → A gets a new letter.
3. C (agent) sends B a direct note after A's task → letter goes to C, not to A.
4. A question from C to B does not change the giver (A still gets it).
5. Newest counting letter to B is from the human → no letter. B created by the human with no letters → no letter.
6. `progress` → no letter. `failed` → `reported failed`.
7. Two `done` reports in a row with the first letter unread → A has exactly one unread report letter about B, with the newer text.
8. A in `wait_for(B)` while B reports done → the wait returns the result and A has no unread report letter;
   same when A calls `wait_for(B)` after the report.
9. B is a member of an open room → no letter. Giver closed → no letter. A direct note to B from a session B
   created is skipped.
10. Existing tests of the touched files still pass.

Checks: `uptime` first; run only the touched test files with vitest; `tsc --noEmit` / the package
typecheck and eslint for `packages/core`. Commit on the branch; no push.

### Task 2 — texts (s-05)

Files: `packages/core/src/mcp/tools.ts` (descriptions), `packages/core/src/work/guidance.ts`,
`packages/core/src/work/guide.ts`, their tests (`guidance.test.ts`, `guide.test.ts`, `tools-size.test.ts`,
any snapshot of the descriptions).

Acceptance: D6 wording in place; no text still says a session that only calls `report` sends nothing
for direct/create_session tasks; size budgets pass; touched tests, typecheck and eslint green. Commit; no push.

## Review (s-04)

Lead reviews each diff against D1–D6 before the next task; acceptance and the impact card go to s-02.
