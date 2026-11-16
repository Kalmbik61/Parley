<!-- verifier 1 s-432 model=gpt-6-luna addedAt=2026-11-16T17:48:42.286Z handedAt=2026-11-16T17:50:55.788Z result=done -->
C1 | PASS | input-started stores call name; later tool events look it up by id, fallback tool.
C2 | PASS | Success with metadata.error is failure; other success, called, and failed map as claimed.
C3 | PASS | Throwing success takes first content text; failed event takes error.message.
C4 | PASS | Name comes from part.name; completed metadata.error or error status fails; text parts join by newline, otherwise error message.
C5 | PASS | Failure sets tool status failed and response to the error string.
C6 | PASS | Non-null ordinals <= lastOrdinal are skipped; accepted ordinals advance cursor; null ordinals pass.
C7 | PASS | put replaces equal-id item at its existing index.
C8 | PASS | Rollout starts at historyStart−1; first live child read likewise sets cursor from meta.historyStart−1.
C9 | PASS | History note is inserted only by rollout under stated conditions, at head and then trimmed; passing item_completed sets modern.
C10 | PASS | Journal is indexed for root context only.
C11 | PASS | Inline-parseable entries only; first duplicate id wins.
C12 | PASS | Root UserPromptSubmit hook attachment content is parsed at record time; journal version wins and is put in place.
C13 | PASS | Missing journal entries are time-sorted and inserted after eligible pointer prompt (past adjacent mail), else by time/end. Yes, one can be DROPPED when no prompt exists and its time predates the first item (mail-seed.ts:50-51).
C14 | PASS | Missing tool name creates no card; question/plan tools with own pending non-permission card and no matched running tool are suppressed.
C15 | PASS | Candidates are same-name running tools without an existing card, from main tools or the specified agent children; last equal-input candidate wins, else last candidate.
C16 | PASS | A found tool gets permission:<toolUseId> if unused; otherwise generated id; absent tool leaves toolUseId null.
C17 | PASS | Matching pending cards settle elsewhere; when id match is absent, first unbound same-name/agent/input card is used; question answers come from tool_response.
C18 | PASS | reserve calls reconcileRoomPlans; autonomous plans are skipped and closed rooms cancel active plans.
C19 | PASS | Owner is live if a non-HUMAN participant, i.e. room member with present non-closed session.
C20 | PASS | Closed-owner reconciliation preserves done/satisfied items; restores qualifying blocked-after-done item; leaves other blocked items; blocks other unsatisfied items.
C21 | PASS | Blocked targets live lead; ready/returned target owner only if actionable; verify targets available verifier or lead fallback; no live lead means no fallback letter.
C22 | FAIL | ENGINE is also a participant for autonomous mode (plans.ts:66-67); autonomous validation requires owner and verifier ENGINE (plans.ts:154-156), so the claim's participant definition is incomplete.
C23 | PASS | Unavailable-verifier message tells lead the verifier is unavailable and requests amended plan if lead owns item.
C24 | PASS | Lead gets verify if not owner, resolve-block if owner; owner gets wait.
C25 | PASS | Verified active done item can be verified by HUMAN, named verifier, or eligible live lead; other actors fail with RoomRuleError.
C26 | PASS | Snapshot filename includes work, room, plan, revision, and accepted/completed/cancelled event.
C27 | PASS | Existing same-file/same-digest intent is returned; digest conflict throws snapshot-conflict.
C28 | PASS | edit copies draft into map only after body returns, so thrown conflict aborts mutation.
C29 | PASS | Flush writes pending intents under shared lock; separate no-touch map ack settles matching file/digest; caught failure leaves intent pending.
C30 | FAIL | Overflow all=true removes any-age written planExports, but written planBacklogIntents still require endedAt older than retention; missing plan/revision records remain (plan-effects.ts:337-344).
C31 | FAIL | Promotion-exempt checklist-to-verified items are excluded from changed even when criteria/verifier differ; otherwise semantics compare title, owner, scope, after, criteria, verifier and dependents propagate (plan-state.ts:152-180).
C32 | PASS | Exemption requires previous checklist, new verified, prior accepted plan, previous done, same title/owner/scope/after.
C33 | PASS | Unchanged items carry status/evidence/note/log/progress/submissions; exempt item gets prior revision.
C34 | PASS | Changed existing items preserve submissions and prior log plus invalidation entry; new item starts cleared and waiting then dependency-derived ready/waiting.
C35 | PASS | Verified-mode satisfaction accepts verified or done with acceptedChecklistRevision >=0 and < plan.rev.