# Pilot 3, task 2: how Parley core works

Subject: Parley source at commit `9eabc014`, read-only copy `/Users/kalmbik61/parley/pilot3-subject`. Read only that copy: the project's working folder is on an older commit and does not count. Do not run, build or change anything. Tests (`*.test.ts`, `e2e`, `test-utils`, `__fixtures__`) are out of scope. Every source must be `path:line` at `9eabc014`, path relative to the copy root.

Four slices of `packages/core/src`, one member per slice. Answers come from reading code, often across files.

## Slice A: `packages/core/src/feed/` (with `codex/`, `opencode/`, `qwen/`)

- Q01. An OpenCode tool call whose code throws is reported by OpenCode as successful. How do the live-event bridge and the message-list feed builder each recognise such a call and what do they turn it into? OpenCode's completion events do not repeat the tool name: where does the bridge get it?
- Q02. When a feed is built from a Codex rollout journal and later extended, how does re-reading avoid duplicate items, how does a sub-agent's history-start offset affect what is applied, and exactly when is an "earlier history is only in Terminal" error item added?
- Q03. When a Claude Code transcript feed is built together with Parley's mail journal, how do journal deliveries get into the feed: what the transcript's attachment record contributes, where a delivery with no matching attachment goes, when it is dropped, and which journal entry wins for a duplicate id?
- Q04. In the live Claude Code hook reducer, a permission request does not carry its tool call id. How does the reducer pick the running call a new permission card belongs to, what id the card gets, when no card is made at all, and, when the call finishes, which pending cards are settled and how?

## Slice B: room plans — `packages/core/src/work/plans.ts`, `plan-effects.ts`, `plan-tasks.ts`, `plan-state.ts`, `plan-snapshots.ts`

- Q05. An accepted (not autonomous) plan runs in an open room and the session that owns some items is closed. What happens to each of its items depending on status, and who gets the follow-up letter?
- Q06. In verified mode an item is submitted but its named verifier is unavailable. When does a verifier count as unavailable, who is expected to act instead, what changes if that one also owns the item, and will the verification call accept them?
- Q07. Markdown snapshots of a plan are captured on plan events and written to shared storage later. What identifies a snapshot, what happens when the same one is captured again (and to the plan change that triggered it), how is a write acknowledged, and when is its record removed?
- Q08. An amended revision of an active plan is accepted. How is it decided which items keep progress and which start over, what is kept and added for an existing item that starts over, and how can an item finished under a checklist plan count as finished after promotion to verified mode without being verified?

## Slice C: worktrees and launch — `packages/core/src/work/worktree.ts`, `worktree-seed.ts`, `worktree-include.ts`, `worktree-owner.ts`, `launch.ts`

- Q09. When a session's branch is merged back into its base, which checks can refuse the merge before git merges anything, in what order, and what happens if the merge hits a conflict?
- Q10. A new session worktree can receive ignored paths (dependencies, build output) from the main checkout. Which filters decide which paths qualify, in the main checkout and in the new worktree?
- Q11. While include paths are cloned one by one into a new worktree: when is a path skipped (and is the skip reported), how are the entry limit and the time limit applied, and how does a clone reach its final place?
- Q12. When a session runs on the Codex runner inside its own git worktree, the sandbox may get extra writable locations so the agent can commit. Under which conditions, what validation must pass first, and exactly which locations are granted?

## Slice D: mail — `packages/core/src/work/letter-store.ts`, `letter-tables.ts`, `letter-upgrade.ts`, `letters.ts`, `delivery.ts`, `thread.ts`, `channel.ts`, `events.ts`, `packages/core/src/mcp/inbox-watch.ts`, `inbox-page.ts`

- Q13. When the background watcher tells an agent about new letters, which letters does it ring for and in what order, how is the sender named, and what number does it give as the unread count?
- Q14. Who receives a room letter with no explicit addressee, how does that change when the room is archived, and which stored unread-candidate rows does the database store delete when a session leaves a room or the room is archived?
- Q15. For an idle live agent with unread letters, which letters make the host type the pointer at once and which wait for quiet? How is the wait computed (bounds, unparseable or far-future timestamps), and which letters enter that computation?
- Q16. In the database-backed letter store, how is a new letter's number chosen so numbers are never reused after a room is deleted with its letters, and what does the id look like? If that deletion runs inside a nested rollback scope that then fails, what is restored and how?

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
