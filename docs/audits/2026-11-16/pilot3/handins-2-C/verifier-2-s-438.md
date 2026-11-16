<!-- verifier 2 s-438 model=gpt-6-luna addedAt=2026-11-16T17:55:25.765Z handedAt=2026-11-16T17:56:59.366Z result=done -->
Coverage: complete for C27–C42; read-only source inspection, no commands that modify, build, or test.

Goal: verify claims C27–C42 against the cited source. Behaviour: C27 FAIL; C32 FAIL; C37 FAIL; all other claims PASS. Numbers: 16 claims reviewed; not measured (source verification only). Screens: not applicable. For the human: see claim verdicts below. Risk: no runtime behavior was exercised. Cost: not measured. Verdict: partial acceptance; three claims need correction.

C27 | FAIL | The pinned-checkout order is session copy first (if not removedAt), then base—not base then session copy: packages/core/src/work/worktree.ts:851-853. The rest of the stated sequence is supported at 846-850, 855-873, 1301-1325.
C28 | PASS | packages/core/src/work/worktree.ts:1326-1334
C29 | PASS | packages/core/src/work/worktree-include.ts:14-16, 76-82, 85-135
C30 | PASS | packages/core/src/work/worktree-include.ts:138-158; packages/core/src/work/worktree-seed.ts:201-225
C31 | PASS | packages/core/src/work/worktree-seed.ts:17, 120-135, 253-265, 280-282
C32 | FAIL | After expiration, later existing targets still take the early continue and are not reported as skipped 'timeout'; so not every following path is skipped with that reason: packages/core/src/work/worktree-seed.ts:253-259. Other details, including timeout clone abort and first-five description, are supported by 267-284, 309-326, 334-338.
C33 | PASS | packages/core/src/work/worktree-seed.ts:106-118, 171-180, 213-218, 249, 287, 293
C34 | PASS | packages/core/src/work/launch.ts:504-506
C35 | PASS | packages/core/src/work/worktree.ts:593-672
C36 | PASS | packages/core/src/mcp/inbox-watch.ts:60-72, 96-110; packages/core/src/work/thread.ts:162-167
C37 | FAIL | An absent room returns explicit to before the missing-room guard: only when room is defined and archived does it return [] first, then explicit to, then missing room: packages/core/src/work/letters.ts:20-23. Thus missing-room + explicit recipients yields to, contrary to the claim.
C38 | PASS | packages/core/src/work/letter-tables.ts:600-617; packages/core/src/work/rooms.ts:146-149, 492-497
C39 | PASS | packages/core/src/work/delivery.ts:160-182; packages/core/src/work/task-giver.ts:74-76
C40 | PASS | packages/core/src/work/delivery.ts:20-21, 197-208, 237-258
C41 | PASS | packages/core/src/work/letter-tables.ts:537-543, 656-677
C42 | PASS | packages/core/src/work/letter-tables.ts:670-673, 710-736; packages/core/src/work/map-rows.ts:189-191