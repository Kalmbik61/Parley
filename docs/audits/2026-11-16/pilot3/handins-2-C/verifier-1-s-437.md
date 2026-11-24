<!-- verifier 1 s-437 model=gpt-6-luna addedAt=2026-11-16T17:55:24.379Z handedAt=2026-11-16T17:56:54.916Z result=done -->
Read-only source verification against commit 9eabc014. Coverage was partial: I inspected the cited implementation ranges for all C1–C26, but did not run tests/builds (explicitly out of scope). Verdicts:
C1 | PASS | packages/core/src/feed/opencode/events.ts:121-128
C2 | PASS | packages/core/src/feed/opencode/events.ts:112-116,121
C3 | PASS | packages/core/src/feed/opencode/apply-opencode.ts:115,120-126
C4 | PASS | packages/core/src/feed/codex/apply-codex.ts:370-375; packages/core/src/feed/reduce.ts:313-322
C5 | PASS | packages/core/src/feed/codex/apply-codex.ts:385; packages/core/src/feed/codex/codex-agents.ts:69-73
C6 | PASS | packages/core/src/feed/codex/apply-codex.ts:348-349,381-395
C7 | PASS | packages/core/src/feed/from-transcript.ts:170-174,266-267,296-297
C8 | PASS | packages/core/src/feed/mail-seed.ts:31-56; packages/core/src/feed/from-transcript.ts:305; packages/core/src/work/delivery.ts:145-152
C9 | PASS | packages/core/src/feed/mail-seed.ts:16-21; packages/core/src/feed/mail.ts:79-80,91-101
C10 | PASS | packages/core/src/feed/reduce.ts:119-120,728-749
C11 | PASS | packages/core/src/feed/reduce.ts:297-304,759-769
C12 | PASS | packages/core/src/feed/reduce.ts:734-757; packages/core/src/feed/reduce.ts:1029-1030; packages/core/src/work/events.ts:261-265
C13 | PASS | packages/core/src/feed/reduce.ts:569-572,652-670,782-827
C14 | PASS | packages/core/src/work/plans.ts:60-98,419-430,974-1011; packages/core/src/work/plan-state.ts:10-18
C15 | PASS | packages/core/src/work/store.ts:1034 onward (updateMap contains no reconciliation); packages/core/src/mcp/plan-tools.ts:511-522,707; packages/host/src/methods/rooms.ts:125,177; packages/host/src/rooms/plan-effects.ts:189-197; packages/core/src/work/plan-effects.ts:360
C16 | PASS | packages/core/src/work/plan-effects.ts:33,90-97,127-146,449
C17 | PASS | packages/core/src/work/plans.ts:60-82
C18 | PASS | packages/core/src/work/plan-state.ts:101-111; packages/core/src/work/plan-effects.ts:128-134
C19 | PASS | packages/core/src/work/plans.ts:741-823
C20 | PASS | packages/core/src/work/plan-snapshots.ts:44-47
C21 | PASS | packages/core/src/work/plan-snapshots.ts:115-121; packages/core/src/work/plans.ts:112-126; packages/core/src/work/store.ts:300-311,1219
C22 | PASS | packages/core/src/work/plan-snapshots.ts:134-202; packages/core/src/work/stored-texts.ts:49-57; packages/core/src/work/shared-markdown.ts:93-95
C23 | PASS | packages/core/src/work/plan-effects.ts:27,325-345,405-418
C24 | PASS | packages/core/src/work/plan-state.ts:126-183; packages/core/src/work/plans.ts:480-494
C25 | PASS | packages/core/src/work/plans.ts:495-507
C26 | PASS | packages/core/src/work/plan-state.ts:10-18,154-169; packages/core/src/work/plans.ts:491-492
Impact card — Goal: verify source claims Q01–Q08. Behaviour: all 26 claims match the inspected code. Numbers: 26/26 PASS, not measured by tests; tests were expressly out of scope. Screens: none. For the human: source-level verdict only. Risk: runtime behavior was not exercised. Cost: not measured.