<!-- drone 3 s-410 model=haiku addedAt=2026-11-16T17:23:16.962Z handedAt=2026-11-16T17:26:09.489Z result=done -->
Research drone s-410, subject pilot3-subject @ 9eabc014 (read-only). Files read whole: packages/host/src/swarms/{swarms-service.ts, spawn.ts, briefs.ts}, packages/host/src/rooms/{check-runner.ts, autonomous-engine.ts}; core: packages/core/src/work/swarms.ts, rooms.ts:124-133,347-349, autonomous.ts:679-740. Paths relative to the copy root.

Q09 — collecting and back to running
- Move to collecting: packages/host/src/swarms/swarms-service.ts:233 (swarm not terminal), then the else-if chain 235-272: queen result done (235) / failed (238) / queen closed (241) / expired (245) do not fire; then 257-260 requires swarm.status === 'running', workers.length > 0 (non-queen members), and every worker isSettled. Status set at 261; queen gets a note at 263-271.
- A non-queen member is finished (isSettled, 99-104): handedAt !== null, or session missing, or lifecycle 'closed', or result 'failed', or lifecycle 'sleeping' with result null and endedAt at least DRONE_SILENT_MS (2 min, line 48) old. handedAt is set at 228-231 when session.result === 'done' (a 'progress' report does not hand in, comment at 227).
- Expiry (245) uses limits only when read: limits read only if some swarm is non-terminal (packages/host/src/swarms/swarms-service.ts:365-367); isSwarmExpired in packages/core/src/work/swarms.ts:79-82.
- Back to running: packages/host/src/swarms/spawn.ts:143-144 (queen's swarm_add on a collecting swarm sets running). Only assignment from collecting to running in the repo (grep over host and core). Requires caller is the queen (spawn.ts:129-131) and swarm not terminal (134-136).

Q10 — creator, delivery
- Creator: packages/host/src/swarms/spawn.ts:68-73 creatorOf: no caller -> human (70); caller is the live lead of a non-archived room -> room (71-72, first such room); otherwise session (72). Fixed at creation: spawn.ts:104-110 (creator recorded in WorkSwarm). Type: packages/core/src/work/swarms.ts:21-24.
- Result: queen's report sets queen.result; swarm end and result text at swarms-service.ts:235-240 (summary cut to SWARM_SUMMARY_MAX, 85-87, 216). Result object: 301 (swarm.result ??=). Text: deliveryText 169-178.
- Expiry grace: 292-300 (expired swarm waits up to SWARM_EXPIRY_GRACE_MS, line 46, for the queen's report).
- Letter path: deliverByLetter 184-201: session creator -> letter only if target live (188); room creator -> needs room not archived (194) and liveLead non-null (195-196) -> parleyNote; human or no target -> false (200). On success deliveredAt is written in the same record (303-306).
- Notice path: when deliverByLetter is false, notice pushed at 308-313 (kind swarm-done / swarm-failed). reconcileWork (352-357) broadcasts host.notice (354) and only then calls markDelivered (356; sets deliveredAt if still null, 329-344). If broadcast throws, reconcileWork rejects, markDelivered is not reached, pass() logs it (371-374), and the next pass re-delivers because needsReconcile requires deliveredAt null (115).

Q11 — check outcome and halting
- Recorded outcome priority: packages/host/src/rooms/check-runner.ts:220-227: write-outside-root (221) > orphan-scan-unavailable (222) > orphan-descendants (223) > timeout (224) > launch-failed (225) > killed-by-signal (226) > exit-code pass/fail (227). Verdict stays 'error' (default line 67) for all but pass/fail. Earlier early returns (e.g. 79-83, 86, 92, 105, 129, 139) fire before the spawn. Attribution text (44-59, 221) changes only wording.
- Override: finally at 230-237 writes output tail / cleanup failure and overwrites verdict 'error' and summary, after the chain.
- Halts: only in packages/host/src/rooms/autonomous-engine.ts. record() 582-587 halts with reason 'confinement' only when verdict === 'error' and summary includes 'confinement-unavailable' (585-586). Summaries 'confinement-unavailable' from check-runner.ts:83 and 217 (217 adds '(sandbox log)'; both contain the substring). Runner exception (not a summary): checkAttempt 601-607 and integration 925-931 settle the op failed and halt 'human'. Cancellation (signal aborted) does not halt (604, 609, 927, 932). All other summaries (write-outside-root, timeout, orphan-*, launch-failed, killed-by-signal, fail) are only recorded (583-584) and fed to decide (621-634) or failIntegration (937); no halt.

Q12 — overdue attempt
- Detection: safety tick ENGINE_SAFETY_TICK_MS = 30_000 (autonomous-engine.ts:48); poll 1185 calls scan(true) which forces schedule even with unchanged version (1161-1164, 1183). Cycle gate: work status active (1053), plan active (1054), not halted (1058).
- Exact overdue condition (1083): attempt.status in ['starting','running','checking'] AND io.now().getTime() - Date.parse(attempt.startedAt) > plan.autonomous.budget.limits.minutesPerAttempt * 60_000 (strict). startedAt set at packages/core/src/work/autonomous.ts:733. 'submitted', 'checking' only via the same line; 'queued' not included.
- Integration verifier variant (1072-1082): launched integration-verifier with no end op and settledAt ?? at older than minutesPerAttempt -> stop-session + halt 'stuck' (1077-1079).
- Effects on sessions (1086-1089): stop-session intent for worker and verifier; sessionOperation (299-309) calls io.sessions.stop only if lifecycle is active, pending or closing (304). Sessions are stopped, not closed here.
- Effects on plan (1090-1097): attempt status is NOT changed; plan halted with reason 'stuck' and detail '<attemptId>: stuck <kind> since <since>' or 'minutesPerAttempt exceeded' (1091-1092); note to live lead (1093-1095); drainSessions (1098). Halted plan: cycle skips it except halt-summary refresh and stop/close drain (1058-1061); haltedDetail adds 'explicit human resume required' (110-116). Sessions are closed later only by cleanupPlan on cancel/complete (731-761, 750-759).

Open:
- Q09: what limits=null means when readLimits fails (swarms-service.ts:367 .catch) — partly verified; the queen-missing edge (queen undefined skips closed/done branches, 241 uses optional chaining) not resolved.
- Q10: sessions.close/stop behaviour and host.broadcast delivery guarantees not read (outside slice); swarm cancel path packages/host/src/methods/swarms.ts:44 not read.
- Q11: core halt() (packages/core/src/work/autonomous.ts:1333) and recordCheck (autonomous.ts:910) not read, so the effect of a recorded 'error' verdict on coverageVerdict is unverified.
- Q12: meaning and shape of session.stuck (used at autonomous-engine.ts:1079, 1091) lives in the sessions service, not read; the stop effect on the process is unverified.

Coverage: partial