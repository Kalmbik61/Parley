<!-- drone 2 s-428 model=haiku addedAt=2026-11-16T17:40:45.091Z handedAt=2026-11-16T17:46:05.393Z result=done -->
Q05–Q08, slice B (room plans), source copy /Users/kalmbik61/parley/pilot3-subject at 9eabc014. Read whole: packages/core/src/work/plans.ts, plan-effects.ts, plan-tasks.ts, plan-state.ts, plan-snapshots.ts; also rooms.ts, stored-texts.ts, shared-markdown.ts (cited). Paths relative to copy root.

## Q05. Accepted plan in an open room; the session owning some items is closed

Mechanism: reconcileRoomPlans (plans.ts:974-1011) runs inside every map write through reserve(): reservePlanEffects → reserve → reconcileRoomPlans before effects are built (plan-effects.ts:291-296 "called inside a map write"; plan-effects.ts:360; the outer updateMap call is not read, see Coverage).
- Owner is "not live" when not a room member or closed (liveOwner plans.ts:91-98, participant plans.ts:60-74, isAlive rooms.ts:106-108). Items of live owners are skipped (plans.ts:991).
- Status by status of the closed owner's item:
  - `done`: unchanged, waits for the verifier (plans.ts:993 `continue`).
  - satisfied (`verified`, or `done` with acceptedChecklistRevision < plan.rev): unchanged (planItemSatisfied plan-state.ts:10-18; plans.ts:1006 skips it).
  - `blocked`: unchanged. Legacy case: an item blocked by 0.32.0 with note "Owner is closed or deleted." and prior `done` returns to `done` (plans.ts:994-1005).
  - `waiting`, `ready`, `in_progress`, `returned`: set to `blocked` with log entry by "system", note "Owner is closed or deleted." (plans.ts:1006-1007; log() plans.ts:419-430). log() does not touch `progress`, so the owner's checkpoint is kept.
  - Dependents owned by live sessions are not blocked automatically; planItemReady (plan-state.ts:21-26) only reads satisfied dependencies.
- If the room has no live members at all, the plan is cancelled instead (plans.ts:983-988); that is a different path.

Follow-up letters (plan-effects.ts):
- Target for a blocked item is the live lead: itemEffect plan-effects.ts:139-142 (kind "blocked", text "Blocked: Owner is closed or deleted."). The lead gets it only if actionable: actionable plan-effects.ts:90-97; a null target gives no letter (plan-effects.ts:144-146).
- Closed owner gets no letter: actionable fails (plan-effects.ts:90-97, 144-146).
- `done` items (verified mode, not satisfied) get a verify letter to the verifier (plan-effects.ts:127-134; the lead when the verifier is unavailable, plan-effects.ts:129).
- Letter delivery: queued effects become PARLEY notes (plan-effects.ts:453-460) only within PLAN_LETTERS_PER_HOUR = 120 per room per rolling hour (plan-effects.ts:33, 449); otherwise they stay queued.
- Duties: blocked owner gets `wait`, the live lead gets `resolve-block` (plan-state.ts:86-87, 120-121). plan_tasks lists duties only for visible plans and open rooms with the session as member (plan-tasks.ts:209-228, 252-259), so the closed owner sees nothing.

## Q06. Verified mode; item submitted; named verifier unavailable

- When a verifier counts as unavailable: planVerifierUnavailable (plans.ts:76-82) = verifier not null AND participant() false. participant (plans.ts:60-74): HUMAN is always available; another session counts only if it is a room member, present in the map and not closed. So unavailable = named session closed, removed from the map, or no longer in the room. Used in itemEffect (plan-effects.ts:128), plan_tasks (plan-tasks.ts:256), verifyPlanItem (plans.ts:774).
- Who acts instead: planItemDuties (plan-state.ts:101-111). With verified mode, verifier unavailable and status `done`:
  - live lead (liveLeadId) ≠ owner → lead gets duty `verify` (plan-state.ts:111);
  - live lead = owner → lead gets duty `resolve-block` (plan-state.ts:108-110), meaning the owner must propose an amended plan with another verifier;
  - no live lead → nobody gets a duty (plan-state.ts:107-111 gives nothing).
  - Letter: itemEffect targets liveLead when unavailable (plan-effects.ts:128-129). The text says the named verifier is unavailable; the lead calls plan_verify, or if it owns the item, proposes an amended plan (plan-effects.ts:130-134).
- If the lead also owns the item: duty is resolve-block, not verify (plan-state.ts:108-110). The letter is still kind verify with the "call plan_verify" wording (plan-effects.ts:130-134), so the letter and the duty disagree (observed in code).
- Will the verification call accept them: verifyPlanItem (plans.ts:741-823):
  - status must be `done` and plan active (plans.ts:762-763);
  - actor that is the owner is refused (plans.ts:768-779, actor === item.owner);
  - a non-verifier lead is accepted only if liveLead === actor and the verifier is unavailable (plans.ts:772-774);
  - HUMAN is always accepted (plans.ts:757-758, 767 `actor !== HUMAN`);
  - mutablePlan requires actor to be a live participant (plans.ts:537-539).
- Amendment path for an owner-lead: validateDraft refuses verifier === owner in non-autonomous plans (plans.ts:176-191); a default verifier that equals the owner is replaced by HUMAN when the owner is the only eligible live member (plans.ts:176-184).
- Checkpoint for the verifier role: savePlanCheckpoint accepts only actor === item.verifier (plans.ts:607-611), so an unavailable verifier cannot save one and the lead cannot save it as verifier.

## Q07. Markdown snapshots

- Identity: file = `${work.id}-${roomId}-${plan.id}-rev-${rev}-${event}.md` (plan-snapshots.ts:47); event ∈ accepted | completed | cancelled (plan-snapshots.ts:44). Validation: regex and suffix checks (plan-snapshots.ts:22-34); validatePlanStorage regex (plans.ts:1187-1199).
- Capture points: acceptRoomPlan (plans.ts:514-521, with removed items), completed in recalculate (plans.ts:452), completeRoomPlan (plans.ts:1039), cancelPlan (plans.ts:851), setRoomMode cancel (plans.ts:943), reconcile on closed room (plans.ts:987).
- Same snapshot captured again: edit() stores the draft only if the body returns (plans.ts:112-126).
  - identical content → the existing intent is returned, nothing new is pushed, and the plan change proceeds (plan-snapshots.ts:115-121; sha compared via exportSha256, stored-texts.ts:34);
  - different content → PlanSnapshotError("snapshot-conflict") (plan-snapshots.ts:118-119) propagates out of the body; the map is not assigned (plans.ts:120-125), so the plan change that triggered the capture is refused. Caller handling is not in this slice.
- Write and acknowledgement: flushPlanSnapshots (plan-snapshots.ts:134-202), called after updateMap (plan-snapshots.ts:131; plan-effects.ts:888-921).
  - Only `pending` intents (plan-snapshots.ts:145-147); the file must start with the work id (plan-snapshots.ts:153-155).
  - Under withSharedProjectLock: publishImmutableMarkdown (plan-snapshots.ts:155-171; shared-markdown.ts:13-146). Exclusive link creates the file; an existing identical file is success (shared-markdown.ts:93-95); a different existing file is conflict (shared-markdown.ts:94, 124); invalid → snapshot-invalid; other write failure → snapshot-write-failed (plan-snapshots.ts:162-166).
  - Ack: a separate updateMap settles the record only when file and sha256 match (plan-snapshots.ts:174-186); settleExport (stored-texts.ts:49-57) keeps sha256, bytes, title, deletes content, sets status `written`.
  - Failure: pushed to `failed`, intent stays pending with its content (plan-snapshots.ts:188-196). A retry after a successful file write but failed ack finds the identical file and succeeds (shared-markdown.ts:93-95).
- Record removal: prune (plan-effects.ts:325-345). Written exports go when the plan's end (completedAt ?? cancelledAt, matched by id and rev, plan-effects.ts:327-332) is older than 7 days (PLAN_EFFECTS_KEEP_MS plan-effects.ts:27; cut plan-effects.ts:326; keep condition plan-effects.ts:339), or on overflow with `all` regardless of age (plan-effects.ts:411-418; EFFECT_LIMIT / EFFECT_BYTES plan-effects.ts:24-25). Pending exports are never pruned (plan-effects.ts:339 keeps status !== written). A plan with no end date is kept (plan-effects.ts:339). deleteRoom keeps planExports (rooms.ts:418-420; it prunes only plans, planEffects and planBacklogIntents, rooms.ts:438-442).

## Q08. Amended revision of an active plan accepted

- Keep or restart: acceptRoomPlan (plans.ts:457-524) → amendmentChanges (plan-state.ts:146-183). Changed set = items whose `semantics` differ (title, owner, scope, after, criteria, verifier; plan-state.ts:126-134, 170-171) plus new items plus transitive dependents via `after` (plan-state.ts:173-181). Unchanged items (plans.ts:480-494) keep status, evidence, note, log, progress, submissions and acceptedChecklistRevision (promotion exemption aside).
- Changed or new item (plans.ts:495-507): fields come from validateDraft (status waiting, evidence null, note null, log empty; plans.ts:198-210). It keeps `submissions` (plans.ts:496-497) and gets its previous log plus one entry by HUMAN, status waiting, note "Assignment changed; previous evidence invalidated." (plans.ts:498-506). progress and acceptedChecklistRevision are not copied. Then ready/waiting is recalculated (plans.ts:511-513).
- Submissions history: capped at PLAN_SUBMISSIONS_MAX = 5 (plans.ts:44, 735-736). planSubmission reads the last `done` in the log (plan-state.ts:32-36).
- Checklist → verified promotion: amendmentChanges sets promotionExempt for an item that was `done` in an accepted Checklist plan, with the same title, owner, scope and after (plan-state.ts:162-169). Such an item is not changed and gets acceptedChecklistRevision = existing.rev (plans.ts:491-492; plan-state.ts:240-242 in planRemaining). Criteria and verifier are not compared for this exemption (plan-state.ts:154-161).
- Counted as finished: planItemSatisfied in verified mode is verified OR (done AND 0 ≤ acceptedChecklistRevision < plan.rev) (plan-state.ts:10-18). The new rev is existing.rev + 1, so the exempt item counts. It is cleared when the status leaves done (plans.ts:428) or on downgrade to Checklist (plans.ts:955). Stored validation: plans.ts:1158-1165. Snapshot text: "Completion basis: accepted Checklist revision N; no verification claimed." (plan-snapshots.ts:79-83).

Coverage: partial — open: Q05 part "where reservePlanEffects is called" (the outer updateMap write path in store.ts, not read, outside the slice); Q07 part "how the write is acknowledged" depends on the shared lock and updateMap internals in store.ts (not read), and the caller's handling of snapshot-conflict (outside the slice). Q06 and Q08 answered from the slice; no open parts. Not verified: runtime behaviour (no tests run, read-only).