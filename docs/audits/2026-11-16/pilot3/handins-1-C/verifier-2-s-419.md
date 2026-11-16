<!-- verifier 2 s-419 model=gpt-6-luna addedAt=2026-11-16T17:34:27.933Z handedAt=2026-11-16T17:35:28.201Z result=done -->
D1: PASS — SW:233-261 gates transition on nonterminal state, no earlier queen/expiry outcome, running status, at least one worker, and all workers settled; SW:263-271 notes the live queen only (SW:164-165).
D2: PASS — SW:99-104 matches all settled cases and the 2-minute sleeping threshold; SW:228-231 records handedAt on result done.
D3: PASS — SP:129-144 permits queen swarm_add and returns collecting status to running; no other path in the inspected source performs this transition.
D4: PASS — SP:68-73 classifies no caller as human, a caller leading a live non-archived room as room, otherwise session; SP:104-110 records creator at creation.
D5: PASS — SW:184-201 sends to a live session or a non-archived room's live lead; otherwise false; SW:303-306 sets deliveredAt in the same map update as successful letter delivery.
D6: PASS — SW:308-313 queues swarm-done/swarm-failed when letter delivery fails; SW:354-356 broadcasts before markDelivered; SW:115 requires undelivered terminal result for reconciliation; SW:292-300 applies expiry grace.
D7: PASS — CR:220-227 applies the stated verdict precedence; CR:67 defaults to error; CR:230-237 can replace verdict with error on tail/cleanup failure.
D8: PASS — AE:582-587 halts confinement for error plus confinement-unavailable; AE:601-607 and 925-931 halt human on runner exception; cancellation does not halt and other results are recorded.
D9: PASS — core autonomous.ts:910-999 invokes withinTime; withinTime at 322-348 halts budget when attempt elapsed time including checks exceeds minutesPerAttempt.
D10: PASS — AE:48 defines 30-second safety tick; AE:1161-1164 and 1183 force scan scheduling.
D11: PASS — AE:1083 uses starting/running/checking and strict elapsed > minutesPerAttempt; core autonomous.ts:733 sets startedAt; AE:1083 uses stuck only in detail.
D12: PASS — AE:1086-1098 stops worker/verifier through sessionOperation, halts stuck, informs live lead, and drains; sessionOperation at 304 limits stop to active/pending/closing; core autonomous.ts:251-262 aborts eligible attempts and returns their items.
D13: PASS — SV:74, 285-293 distinguishes immediate limit/sign-in/startup from timed approval/question; host.ts:471-472, SV:66-71 and core names.ts:56-61 configure env duration (100..600000 ms); core stuck.ts:34 and SV:118 provide 120000 ms default.
D14: PASS — SV:266-280 only backs when told exists, non-silent, and active; SV:212 suppresses archived-room post; SV:216-220 still sends letters without a room; SV:277 gates back letter on IMMEDIATE.
D15: PASS — SV:296-331 implements first observation, initial episode without timer, silent finish for null/out-of-episode needs, same-episode update, and detail refresh; SV:78-86 compares need fields; SV:253-259 only refreshes session.stuck.
D16: PASS — core store.ts:1230 defines structural as upserts/deletes/workChanged; 1171 fast path and 1280,1316 emissions corroborate; plain letter-only writes are excluded.
D17: PASS — WK:840-892 calls notify(mail) synchronously on commit for non-structural writes; WK:694-702 dispatches host mail subscribers.
D18: PASS — WK:895-911 arms once on first write without restarting; mail.ts:32 gives 50 ms; WK:801-823 flushes through sendMail to rooms-mail clients.
D19: PASS — WK:816 publishes works.changed to lacksMail clients only when refreshEntry returns true (WK:727-758); false returns without that notification.
D20: PASS — WK:826-837 holds structural batches for releaseMail after snapshot publication; WK:887-888 tracks pending structural writes; WK:958-971 includes foreign structural writes; WK:901-909 and mail.ts:42 cap hold at 2000 ms.
D21: PASS — SY:319 reset predicate matches; SY:414 marks reader completed on commit page.
D22: PASS — protocol works-sync.ts:32,34 gives 256-commit/4 MiB bounds; SY:214-215 advances floor to at least oldest evicted revision; SY:207-209 and 217 set floor to nextRevision on reorder/retire.
D23: PASS — SY:165 defines retire for removed/incarnation-changed key; SY:176 creates epoch on retire; SY:241-249 drops pins, notifies readers, clears completed state/transfers/expiry and replaces cache; SY:391-392 maps old cursor to cursor-unknown repair; desktop works-sync.ts:353-361 sets reset on epoch change and 473 uses base 0; SY:269-276 emits works.invalidated after changed publication.

Coverage: all D1-D23 reviewed in the specified read-only subject copy; tests were out of scope. No claim is NOT VERIFIED.
Impact card — Goal: verify claims D1-D23. Behaviour: all 23 source claims pass. Numbers: 23 claims reviewed; tests not run (out of scope). Screens: not applicable. For the human: results above. Risk: source inspection only. Cost: not measured. Verdict: PASS.