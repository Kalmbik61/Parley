<!-- verifier 1 s-412 model=gpt-6-luna addedAt=2026-11-16T17:27:59.656Z handedAt=2026-11-16T17:29:23.400Z result=done -->
Coverage: source-only inspection of the designated read-only copy; no commands that modify, build, or test were run. Eight-topic brief reviewed. Evidence is complete for source ranges returned; output truncation means some cited sections were not independently visible, so those are marked NOT VERIFIED.

C01-1 PASS — sleeping-only scan; archived works skipped (packages/host/src/sessions/interrupted.ts:58-63).
C01-2 PASS — autoSleep, queued, null journal skipped (packages/host/src/sessions/interrupted.ts:64-75).
C01-3 PASS — idle notice, wait/permission and subagent lines filtered; empty filtered journal skipped (packages/host/src/sessions/interrupted.ts:19-37, 76-79).
C01-4 PASS — Stop/SessionEnd completion exception for full-journal background tasks (packages/host/src/sessions/interrupted.ts:12, 44-47, 80).
C01-5 NOT VERIFIED — requested-time lifecycle re-filter lines were not visible in returned excerpt (packages/host/src/sessions/sessions-service.ts:2658-2714).
C01-6 NOT VERIFIED — resumeInterrupted body excerpt was truncated (packages/host/src/sessions/sessions-service.ts:2715-2727).
C02-1 PASS — cause stored only when PTY exists; default quiet; exit consumes cause (packages/host/src/sessions/sessions-service.ts:710-714, 1827-1831).
C02-2 PASS — launch actor set on spawn and consumed on exit (packages/host/src/sessions/sessions-service.ts:715-716, 1445-1448).
C02-3 PASS — human/quiet/no-cause branches and launch run duration match (packages/host/src/sessions/sessions-service.ts:746-753).
C02-4 PASS — exit cleanup and finalization order matches, catch logs transition failure (packages/host/src/sessions/sessions-service.ts:718-758).
C02-5 NOT VERIFIED — close implementation excerpt was truncated (packages/host/src/sessions/sessions-service.ts:2586-2597).
C03-1 PASS — exclusive lock wraps setModel; busy concurrent error (packages/host/src/sessions/sessions-service.ts:476-500, 1863-1867).
C03-2 PASS — not-found/provider/same-model checks; catalog resolver implementation present (packages/host/src/sessions/sessions-service.ts:1871-1882; packages/host/src/sessions/model-choice.ts:21-36).
C03-3 PASS — undefined preserved; unsupported non-null effort becomes null (packages/host/src/sessions/sessions-service.ts:1883-1890).
C03-4 PASS — launch, live activity, background work, and draft guards match (packages/host/src/sessions/sessions-service.ts:1891-1904; packages/host/src/sessions/sessions-service.ts:466-469).
C03-5 NOT VERIFIED — setModel tail, planResume, and return branches were truncated (packages/host/src/sessions/sessions-service.ts:1906-1929; packages/core/src/work/launch.ts:321).
C04-1 NOT VERIFIED — launchDetailed preamble lines were not visible in full output (packages/host/src/sessions/sessions-service.ts:902-908).
C04-2 PASS — launchHeld ordering observed in source (packages/host/src/sessions/sessions-service.ts:950-1011).
C04-3 PASS — trust and project-MCP hold paths precede budget reservation (packages/host/src/sessions/sessions-service.ts:1039-1095).
C04-4 PASS — budget reservation/refusal is before worktree (packages/host/src/sessions/sessions-service.ts:1099-1101, 623-653).
C04-5 PASS — queue releases attempt before queued map write and returns queued (packages/host/src/sessions/sessions-service.ts:1102-1139).
C04-6 PASS — worktree follows these checks; pre-process reservation release in finally (packages/host/src/sessions/sessions-service.ts:1149-1195, 1552-1557).
C05-1 NOT VERIFIED — episode tracking excerpt was truncated (packages/host/src/wake/wake-service.ts:1393-1397).
C05-2 NOT VERIFIED — deadline constants excerpt was truncated (packages/host/src/wake/limit-return.ts:20-23; packages/core/src/work/stuck.ts:36-40).
C05-3 NOT VERIFIED — tryLimitReturn preconditions excerpt was truncated (packages/host/src/wake/wake-service.ts:1445-1464).
C05-4 NOT VERIFIED — returnBlock excerpt was truncated (packages/host/src/wake/limit-return.ts:43-51; packages/core/src/work/stuck.ts:40).
C05-5 NOT VERIFIED — blocked settle/notice and episode handling excerpt was truncated (packages/host/src/wake/wake-service.ts:1472-1480, 1401-1410).
C05-6 NOT VERIFIED — no-block return initiation excerpt was truncated (packages/host/src/wake/wake-service.ts:1494-1505).
C05-7 NOT VERIFIED — reset branches were not all visible (packages/host/src/wake/wake-service.ts:1384-1390, 1932).
C06-1 PASS — lock-time cancel checks and no mark on cancellation (packages/host/src/sleep/auto-sleep-service.ts:318-337; packages/core/src/work/auto-sleep.ts:158-164).
C06-2 PASS — active marked session drops mark, warns, returns false (packages/host/src/sleep/auto-sleep-service.ts:343-354).
C06-3 PASS — retry and survivor watch follow success; 10s constant (packages/host/src/sleep/auto-sleep-service.ts:356-366; packages/host/src/sleep/descendants.ts:14-15).
C06-4 PASS — candidate iteration and pressure timestamp on successful sleep; freeSlot uses sleepOne (packages/host/src/sleep/auto-sleep-service.ts:512-527, 534-548, 630-638).
C07-1 PASS — sliding hour implementation and default rate 6 (packages/host/src/wake/resume-limiter.ts:13, 28-36; packages/core/src/config.ts:141-146).
C07-2 PASS — limiter slot taken for resume action; exhausted slot selects resume-limit (packages/host/src/wake/wake-service.ts:1626-1632; packages/core/src/work/delivery.ts:55-64).
C07-3 NOT VERIFIED — backoff/trust/queue exclusions were not fully visible in truncated excerpt (packages/host/src/wake/wake-service.ts:1618-1630).
C07-4 PASS — release helper; unavailable, held/queued, and budget refusal paths release slot; other failures do not (packages/host/src/wake/wake-service.ts:790-795, 821-826, 855-875, 885-898).
C07-5 PASS — per-session notice throttle and default reason (packages/host/src/wake/wake-service.ts:678-686; interval constant at :172).
C08-1 PASS — pending sleep mark and inbox fences for check_inbox/wait_for (packages/host/src/sleep/auto-sleep-service.ts:327-330; packages/core/src/work/auto-sleep.ts:172-174; packages/core/src/mcp/tools.ts:1127-1134, 1429-1431).
C08-2 PASS — host-sleep exit clears pointed; human stop marks unread pointed (packages/host/src/wake/wake-service.ts:645-654, 2035-2041).
C08-3 PASS — restart marks unread only for no-process non-autoSleep sessions (packages/host/src/wake/wake-service.ts:662-676).
C08-4 PASS — retry clears pointed without process; sleeping delivery action is resume (packages/host/src/wake/wake-service.ts:1910-1915; packages/core/src/work/delivery.ts:63-72).