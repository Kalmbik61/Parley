Blind verdicts for task 1, subject commit 9eabc014 (verified HEAD 9eabc014e12a109e7e19ff0818162346cd8426aa). Mandatory key details were scored equally; a citation does not replace an omitted explanation.

Paths are relative to the subject root. H = packages/host/src; SS = H/sessions/sessions-service.ts; WS = H/wake/wake-service.ts; AS = H/sleep/auto-sleep-service.ts; AE = H/rooms/autonomous-engine.ts; SV = H/stuck/stuck-service.ts; WK = H/works/works-service.ts; SY = H/works/works-sync.ts; CA = packages/core/src/work/autonomous.ts.

| Q | X | Y | заметка |
|---|---|---|---|
| Q01 | closed | closed | Selection, ignored events, background Stop, and resume rechecks covered (H/sessions/interrupted.ts:60; SS:2721). |
| Q02 | partly | partly | Both omit synchronous capture/deletion of the launch actor alongside the exit cause (SS:713,715,716). |
| Q03 | closed | closed | Effort, busy gates, and stop/resume covered (SS:1885,1893,1925). |
| Q04 | closed | partly | Y omits the claude-command MCP gate and the null-card exception (SS:1070,1090). |
| Q05 | closed | partly | Y omits that draft blocking includes the host's leftover pointer text (WS:1468). |
| Q06 | partly | partly | Both omit clearing a stale pending-sleep mark and skipping sleep in that ordinary pass (AS:448). |
| Q07 | partly | partly | Both omit the rate callback/startup config load and recomputation with resume disabled (WS:442,1952,1631). |
| Q08 | partly | partly | Both omit the fresh DB check and retry's hold/queue/budget reset (WS:647,1908). |
| Q09 | closed | closed | Collecting, settled-member cases, and queen-added second wave covered (H/swarms/swarms-service.ts:100,256). |
| Q10 | closed | closed | Creator routing and notice-before-delivered ordering covered (H/swarms/swarms-service.ts:184,354,356). |
| Q11 | wrong | closed | X wrongly excludes budget halts (CA:997,346) and calls the failed check operation a failed attempt (AE:605). |
| Q12 | closed | closed | Forced tick, strict deadline, session stop, and stuck halt covered (AE:1083,1185). |
| Q13 | closed | closed | Immediate/delayed needs and back gates covered (SV:74,274,277). |
| Q14 | partly | partly | Both omit that startup/question/approval share one episode (SV:76,78). |
| Q15 | closed | closed | Both cover recipients, 50-ms batching, structural hold and 2000-ms cap; actual refresh/send order is WK:806,808. |
| Q16 | wrong | wrong | Both claim every changed publication sends works.invalidated; already-notified readers are skipped (SY:273). |

Totals:

| Answer | closed | partly | wrong | none |
|---|---:|---:|---:|---:|
| X | 9 | 5 | 2 | 0 |
| Y | 8 | 7 | 1 | 0 |

Key corrections:

1. Q11 omits the budget halt during result recording. CA:997 calls `withinTime(next, integration ? attemptOf(next, a.integration.queue[0]!) : attempt, input.now);`; CA:345–346 says `if (minutes <= a.budget.limits.minutesPerAttempt) return true;` then `haltDraft(plan, 'budget', 'minutesPerAttempt limit', now);`. X's exclusive halt claim is false; Y covers this path.
2. Q11's priority chain also needs the finalizer override. H/rooms/check-runner.ts:233 assigns `result.verdict = 'error'; result.summary = `output-tail-failed: ${String(error)}`;`; line 237 likewise assigns `cleanup-failed`. Both answers include these overrides.
3. Q15 reverses refresh and send in its flush description. WK:806 is `const refreshed = refreshEntry(batch);`, WK:808 then calls `sendMail(batch)`, and WK:816 is `if (refreshed) publish(lacksMail);`. Both answers are accepted against the actual order.

Not verified: additional claims were sampled, not exhaustively audited. No code execution, tests, builds, or lint checks were run, as task.md prohibits running/building and excludes tests. Answer authors and experimental conditions were not investigated; forbidden audit/private materials were not opened. No files were changed and no sessions were created.

Impact card — Goal: blind scoring. Behaviour: read-only assessment. Numbers: 32 verdicts; totals above. Screens: not measured (no UI task). For the human: omissions and false claims identified per question. Risk: additional claims sampled. Cost: not measured (no resource accounting). Verdict: judging complete; neither answer closes every question.