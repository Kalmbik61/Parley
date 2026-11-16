# Pilot 3, task 1: how the Parley host works

Subject: Parley source at commit `9eabc014`, read-only copy `/Users/kalmbik61/parley/pilot3-subject`. Read only that copy: the project's working folder is on an older commit and does not count. Do not run, build or change anything. Tests (`*.test.ts`, `e2e`, `test-utils`) are out of scope. Every source must be `path:line` at `9eabc014`, path relative to the copy root.

Four slices of `packages/host/src`, one member per slice. Answers come from reading code, often across files.

## Slice A: `packages/host/src/sessions/`

- Q01. After a host restart, which sessions go on the "interrupted mid-turn" list offered to the human (which sessions and journal events are skipped, and when a finished turn still counts as interrupted), and what is checked again when the human asks to resume them?
- Q02. When an agent's process exits, how does the host decide whether and how to tell the quiet-endings watcher, what launch information goes with an exit nobody asked for, and how does a human closing a session differ from a human stopping it?
- Q03. When a human changes a session's model: what happens to the effort chosen earlier, when is the change refused as busy for a running agent, and how does a running agent pick up the new model?
- Q04. During one launch of an existing session, which checks can end it before a worktree folder is created, in what order, which end it as "held" or "queued" instead of an error, and what happens to the work budget reservation when the launch is queued?

## Slice B: `packages/host/src/wake/` and `packages/host/src/sleep/`

- Q05. When the moment comes to auto-continue a live session after its usage limit resets, which conditions stop the host from typing the continue text, in what priority, what happens to that limit episode then, and what resets the counter one of the conditions depends on?
- Q06. At the last moment before an idle agent is put to sleep, which conditions cancel the sleep? If the session is still active after the stop, what is done? How does sleep for memory pressure or a free slot react when its chosen candidate is cancelled?
- Q07. How is the per-session limit on waking sleeping sessions by mail counted, which wakes do not use it up, how often is the human told it is exhausted, and when is a used unit given back?
- Q08. When the host itself puts an agent to sleep (not a human Stop), what makes letters that arrived around that moment, or were unread when the host restarted, still wake the session, while for a human-stopped session they do not? Trace it across both folders.

## Slice C: `packages/host/src/rooms/` and `packages/host/src/swarms/`

- Q09. What must be true for a running swarm to move to its collecting phase, when does one non-queen member count as finished for that, and what puts a collecting swarm back to running?
- Q10. How is a swarm's creator decided, and how does the final result reach it? When does it go out as a notification to the human instead of a letter, and when is it marked delivered in that case?
- Q11. When a sandboxed check of an autonomous-plan attempt finishes and several things went wrong at once, which problem decides the recorded outcome? Which check outcomes make the engine halt the whole plan instead of just recording a non-passing check?
- Q12. An autonomous-plan attempt runs past its allowed time while nothing in the work is being written. How does the engine still notice, what exact condition makes the attempt overdue, and what does the engine then do to the attempt's sessions and to the plan?

## Slice D: `packages/host/src/works/` and `packages/host/src/stuck/`

- Q13. Which kinds of session need are reported at once and which wait (and where does the wait come from)? When a reported episode ends, when is a "back" notice posted at all, and which kinds also get a "back" letter?
- Q14. After a host restart the map may already mark a session stuck. On the first activity event for it, how is that state taken over, and what happens if the event has (a) no need, (b) a need of a kind outside the same episode, (c) a same-episode need with changed details?
- Q15. When this host process commits a write that changes only letters, how and when do (a) the host's own mail subscribers, (b) windows with the per-room mail feature, (c) windows without it learn about it? Include the batching delay and what makes the batch wait longer.
- Q16. In the paged sync for desktop windows, when a client starts a pull without a cursor, what decides between a full reset and a delta from its base revision? Which publications move the lower bound used there, which change the sync epoch, and what does an epoch change do to clients?

## Answer format

```
Header: swarm id, start and end time (date -u).
One line per question, Q01–Q16, in order:
Q07 | answered | closed in: wave 1 or continuation | <the answer, 1–5 sentences> | sources: path:line[, path:line] at 9eabc014 | verifier: PASS, FAIL or not checked
Q08 | not answered | <what was read and why it stays open>
Then: "Register" — one line per member: session id, slice, the coverage it declared (covered or partial).
Then: "Not covered" — what was not read and why.
A claim without path:line is a hypothesis: mark the question "not answered" and put the claim into the explanation.
```

A question is closed only when every part of it is answered. A wrong claim about the code counts against the answer.
