<!-- verifier 2 s-413 model=gpt-6-luna addedAt=2026-11-16T17:28:00.564Z handedAt=2026-11-16T17:29:47.385Z result=done -->
Coverage: complete for claims Q09–Q16; inspected only the specified read-only copy. No commands that build/run or modify it were used.
C09-1 PASS — running branch requires nonterminal state, nonempty non-queen workers, all settled; preceding terminal checks exclude queen-hand-in/expiry (packages/host/src/swarms/swarms-service.ts:233-261).
C09-2 PASS — done records resultAt or at; comment says progress does not hand in (packages/host/src/swarms/swarms-service.ts:227-231).
C09-3 PASS — all listed settled conditions and two-minute silent sleeper threshold match (packages/host/src/swarms/swarms-service.ts:99-104).
C09-4 PASS — collecting resets to running when adding a member (packages/host/src/swarms/spawn.ts:142-144).
C10-1 PASS — creator classification and storage match (packages/host/src/swarms/spawn.ts:69-73,107).
C10-2 PASS — live session receives a letter; room path requires unarchived room and live lead; otherwise false (packages/host/src/swarms/swarms-service.ts:184-200).
C10-3 PASS — failed letter delivery queues swarm-done/swarm-failed notice (packages/host/src/swarms/swarms-service.ts:308-313).
C10-4 PASS — letter delivery and deliveredAt happen in same map transaction; notice broadcasts before markDelivered updates deliveredAt, while unreconciled results remain eligible (packages/host/src/swarms/swarms-service.ts:303-305,328-357; 8-10,115).
C11-1 PASS — ordered else-if outcome chain and default error verdict match (packages/host/src/rooms/check-runner.ts:67,221-227).
C11-2 PASS — output-tail and cleanup failures overwrite verdict and summary in finally (packages/host/src/rooms/check-runner.ts:232-237).
C11-3 PASS — record halts only for error verdict with confinement-unavailable substring (packages/host/src/rooms/autonomous-engine.ts:582-587).
C11-4 PASS — non-abort runner exception settles failed, halts as human with check detail, then rethrows; abort skips that handling (packages/host/src/rooms/autonomous-engine.ts:588-621).
C12-1 PASS — poll forces scans every 30000ms, force bypasses version guard (packages/host/src/rooms/autonomous-engine.ts:48,1159-1165,1185).
C12-2 PASS — statuses and strict elapsed-budget comparison match (packages/host/src/rooms/autonomous-engine.ts:1083).
C12-3 PASS — stop-session ops are intended for worker/verifier IDs and sessionOperation calls stop for active/pending/closing sessions; drainSessions runs (packages/host/src/rooms/autonomous-engine.ts:1086-1089,299-317).
C12-4 PASS — stuck detail and halt reason, plus note to live lead, match (packages/host/src/rooms/autonomous-engine.ts:1091-1095).
C13-1 PASS — limit/sign-in/startup are immediate; others timer at reportMs/default 120000ms (packages/host/src/stuck/stuck-service.ts:74,118,285-293; packages/core/src/work/stuck.ts:34).
C13-2 PASS — back line requires told episode, non-silent finish and active session; post suppresses archived-room output (packages/host/src/stuck/stuck-service.ts:212,266-280).
C13-3 PASS — back letter limited to immediate kinds; approval/question yield null (packages/host/src/stuck/stuck-service.ts:216,277).
C14-1 PASS — first event restores known stuck into in-memory episode without timer (packages/host/src/stuck/stuck-service.ts:306-311).
C14-2 PASS — first-event null need finishes silently (packages/host/src/stuck/stuck-service.ts:314-318,266-274).
C14-3 PASS — differing episode kind silently finishes old episode then opens new need (packages/host/src/stuck/stuck-service.ts:78,324-326).
C14-4 PASS — same episode updates need; changed already-reported details refresh only session.stuck; sameNeed compares listed fields (packages/host/src/stuck/stuck-service.ts:80-86,329-330,253-259).
C15-1 FAIL — notification is synchronous only for non-structural writes. Structural writes append to batch.notices and notify later during flushMail, so subscribers are not notified synchronously in onWritten for those writes (packages/host/src/works/works-service.ts:882-887, 802-806).
C15-2 PASS — batching, 50ms timer, and rooms.mail feature-filtered send path match (packages/host/src/works/works-service.ts:879-910,761-777; packages/host/src/works/mail.ts:32).
C15-3 PASS — flush refreshes entry, then successful refresh publishes lacksMail; publishLegacy maps that to works.changed (packages/host/src/works/works-service.ts:806,816; 479-482,513).
C15-4 PASS — structural/foreign batches wait for suitable published snapshot, with two-second cap from batch start (packages/host/src/works/works-service.ts:705-714,826-837,895-910,958-971; packages/host/src/works/mail.ts:42).
C16-1 PASS — cursorless pull starts from base; reset predicate and delta base match (packages/host/src/works/works-sync.ts:319-320,396).
C16-2 PASS — floor advances on journal eviction and is set to nextRevision for reorder/retire (packages/host/src/works/works-sync.ts:211-218; packages/protocol/src/works-sync.ts:32,34).
C16-3 PASS — retire is work removal or incarnation change; retire causes new randomUUID epoch (packages/host/src/works/works-sync.ts:129,165-176).
C16-4 PASS — epoch retirement drops pins/resets readers/clears transfer caches; invalidation is sent on change; stale/unknown cursors return reset-required (packages/host/src/works/works-sync.ts:243-276,391-394,420-423).