<!-- drone 7 s-416 model=haiku addedAt=2026-11-16T17:28:33.870Z handedAt=2026-11-16T17:30:41.011Z result=done -->
Research drone s-416, slice C (commit 9eabc014, read-only copy /Users/kalmbik61/parley/pilot3-subject). Paths relative to the copy root. Tests were not read.

Q09 — the swarm moves to collecting, when a worker counts as finished, and what returns it to running

Confirmed predecessor claims:
- swarms-service.ts:233 — reconciliation runs only while the swarm is not terminal.
- :257-259 — collecting requires status 'running', workers.length > 0 (workers = members with role !== 'queen', :215), and every worker isSettled (:259).
- :99-104 — isSettled is true when: handedAt !== null, or the session is missing, or lifecycle 'closed', or result 'failed', or (lifecycle 'sleeping' && result null && endedAt !== null && now − endedAt ≥ DRONE_SILENT_MS = 2 min, :48).
- :228-231 — handedAt is written only when session.result === 'done' (and the swarm is not terminal, :227-228 loop runs regardless, but handedAt is set in the loop before the non-terminal block).
- :263-271 — note to queen. Missing members are listed.
- spawn.ts:143-144 — `swarm_add` by the queen on a collecting swarm sets status back to 'running'. Preconditions: spawn.ts:129-132 (caller is queen), :134-136 (swarm not terminal). No other code in the slice sets 'running' again (initial value spawn.ts:116 at creation).

Corrections / additions:
- Predecessor said "queen check 129-131" — that is correct; I also confirm :134-136 are the terminal check.

OPEN PART (queen session missing) — answered from the code:
- When the queen is absent from the map (queen === undefined), every queen branch is false: :235, :238, :241 (queen?.lifecycle === 'closed' is false). Expiry at :245 still applies (no queen condition). Collecting at :256-261 does NOT depend on the queen, so a swarm with all workers settled still moves to collecting.
- The collecting note is silently dropped: noteQueen (:164-165) writes only if isLive(queen).
- Terminal delivery with a missing queen: lateReport false (:108-110); the summary is '' (:216, :301); the expiry grace wait (:293-299) does not apply (isLive(queen) false), so delivery happens at once through deliverByLetter (:184-201) to the creator; queenAwaitsSleep is false (:130), so no sleep request.
- Full condition list for collecting: swarm not terminal (:233) AND not queen done/failed/closed (:235-241) AND not expired (:245) AND status === 'running' (:257) AND workers.length > 0 (:258) AND every worker isSettled (:259). The queen's existence is not required.

Q11 — which problem decides the recorded outcome; which outcomes halt the plan

Confirmed predecessor claims:
- check-runner.ts:220-227 — priority order: write-outside-root (:221) > orphan-scan-unavailable (:222) > orphan-descendants (:223) > timeout (:224) > launch-failed (:225) > killed-by-signal (:226) > exit-code pass/fail (:227).
- verdict default 'error' at :67; verdict is set to pass/fail only in the :227 else branch. So every non-pass outcome in :221-226 keeps verdict 'error'.
- finally :230-237 can overwrite both verdict (set to 'error') and summary (output-tail-failed :233, cleanup-failed :237). This happens even after a pass, so it is a corrected point: the finally block can turn a passing result into an error.
- engine record() autonomous-engine.ts:582-587 — halts reason 'confinement' only when verdict === 'error' AND summary includes 'confinement-unavailable' (:585). check-runner.ts:83 and :217 produce that text. The early return at :217 is 'confinement-unavailable (sandbox log)', which also matches includes().
- checkAttempt runner exception: autonomous-engine.ts:601-607 — halt 'human' (:606). Integration: :925-931 — halt 'human' (:929). Cancellation (:604, :927) throws CHECK_CANCELLED and does not halt. run() catches all errors itself (:228-229), so a runner throw is practically unreachable.

Corrected / added:
- core recordCheck (packages/core/src/work/autonomous.ts:910-999) does not call halt() itself, but it does call withinTime at :997. withinTime (:322-348) halts with reason 'budget', detail 'minutesPerAttempt limit' (haltDraft at :346) when the attempt's minutes (endedAt-or-now minus startedAt plus check durations) exceed minutesPerAttempt. So a check that makes the attempt overdue also halts the plan — as 'budget', not 'stuck'. Predecessor's "no other check outcome halts" is therefore incorrect for this budget path.
- Halts outside check outcomes that a check can reach: effect() on any thrown effect (autonomous-engine.ts:290-292) — the reason is 'confinement' / 'budget' / 'human' by text match; not check-specific.
- haltDraft (autonomous.ts:251-262) aborts starting/running/checking attempts (status 'aborted', item 'returned').

OPEN PART (halt callers): grep of autonomous.ts haltDraft callers gives :346, :376, :708, :1243, :1402. I did not read :708 ('attempt or repair limit') or :1243 to confirm whether they are reachable from a check outcome.

Q12 — overdue attempt with no writes

Confirmed predecessor claims:
- ENGINE_SAFETY_TICK_MS = 30_000 (autonomous-engine.ts:48). The poll at :1185-1186 calls scan(true) (:1183) every 30 s, which forces schedule (:1161-1164) and bypasses the version check.
- Overdue condition (autonomous-engine.ts:1083): an attempt whose status is 'starting', 'running' or 'checking' (not 'submitted') and io.now() − Date.parse(attempt.startedAt) > plan.budget.limits.minutesPerAttempt × 60_000 (strict >). startedAt is set at autonomous.ts:733 (startAttempt, input.now).
- Integration verifier variant: :1072-1082 (uses settledAt ?? at), halts 'stuck' at :1079, stops only the integration verifier.
- Sessions: stop-session for worker and verifier (:1086-1089), each via sessionOperation (:299-309). sessionOperation stops only when the session exists and lifecycle ∈ active/pending/closing (:304); otherwise the op settles without a stop.
- Plan: halt 'stuck' with detail (:1090-1097); parleyNote to the live lead (:1094-1095); drainSessions (:1098).
- haltedDetail (:110-116).

Corrected:
- The attempt status is NOT changed by the engine itself, but haltDraft (autonomous.ts:258-262) moves every starting/running/checking attempt to 'aborted' and its item to 'returned'. So the attempt does end as 'aborted' through the core halt.
- The "stuck" detail (:1091) uses session.stuck only for the text. The overdue decision does NOT read session.stuck at all — it is purely time-based on startedAt. The engine does not check whether anything is being written.
- stop-session process effect: sessions-service.ts:1827-1835 — stop(ref) with no cause sets exitCauses 'quiet' (not 'human') and calls pty.stop(ref), then awaits finalizing. The body of pty.stop (kill semantics) was NOT read — unverified.
- If stop throws, effect() (:290-292) halts 'human' (or 'budget'/'confinement' by text), not 'stuck' — the halt at :1092 is not reached.

Open:
- pty.stop body: does it kill the process group and when? Not read (outside slice).
- autonomous.ts :708 and :1243 halt callers (see Q11).
- sessions lifecycle after stop (whether the session is marked closed): not read.

Coverage: partial. Read whole: swarms-service.ts, spawn.ts, check-runner.ts; autonomous-engine.ts in ranges 40-125, 285-320, 560-625, 915-940, 1040-1215; core autonomous.ts in ranges 236-262, 318-380, 725-740, 895-1010, 1320-1360; sessions-service.ts 1827-1835. Not read: rooms/*.test.ts (out of scope), briefs.ts, the body of pty.stop, autonomous.ts :708 and :1243, decide() and its returnAttempt.