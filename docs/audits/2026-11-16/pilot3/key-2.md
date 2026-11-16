# Pilot 3 — answer key, task 2 (packages/core/src)

Subject: `/Users/kalmbik61/parley/pilot3-subject` at `9eabc014`; all paths relative to that root. Every cited line was re-opened at 9eabc014 by the key author (s-400) before hand-in.
The question wording in the task file is authoritative; the wording below is the long form the key was written against.
Closed = every required element is correct (with at least one correct path:line). Partial = some elements, nothing wrong. False = a substantially wrong claim about the code.

## Slice: C1 — slice `packages/core/src/feed/` (incl. codex/, opencode/, qwen/)



### Q01 (easy)
Question: In the OpenCode part of the feed slice, a tool call whose code throws is reported by OpenCode as a *successful* tool event / completed tool part. How do the live-event bridge and the message-list feed builder each recognise such a call and what do they turn it into? And since OpenCode's completion events for a tool do not repeat the tool's name, where does the bridge get the name from?
Required elements:
1. Bridge: a `session.tool.success` event whose `metadata.error` is `true` counts as "threw" and is mapped to a `PostToolUseFailure` record (not `PostToolUse`) — `packages/core/src/feed/opencode/events.ts:125` (and the mapping on `:126`)
2. Bridge: the error text of such a call is the `text` of the first `content` part (otherwise, for a normal failure, `error.message`) — `packages/core/src/feed/opencode/events.ts:128`
3. Message list: a tool part with status `completed` but `state.metadata.error === true` is finished with feed status `failed` (only `completed` without that flag is `done`) — `packages/core/src/feed/opencode/apply-opencode.ts:125` (status choice on `:126`)
4. Tool name: remembered per call id from the earlier `session.tool.input.started` event in the returned bridge state, looked up for later events with fallback `'tool'`, and deleted once the call is over (success/failed) — `packages/core/src/feed/opencode/events.ts:115`, `:121`, `:138`
Closed when: all four elements are correct. For element 4 any one of the three cited lines suffices as evidence if the answer states remember → look up (fallback "tool") → forget after completion. Element 2 may be phrased as "first content item's text".
Typical wrong answer: says the message-list builder relies on `status === 'error'` only, or that the name comes from the success event itself / from the message list.
Why grep is not enough: the "threw" logic lives in two different files with different shapes (SSE event vs. message part), and the name lookup spans three separated places of the bridge's state handling.

### Q02 (medium)
Question: In the Codex part of the feed slice, when a feed is built from a session rollout journal (and later extended by new journal records), how does re-reading the same file avoid duplicate items, how does a sub-agent's "history start" offset affect what is applied, and under exactly which condition is an "earlier history is only in Terminal" error item added to the feed?
Required elements:
1. Deduplication: a record with an ordinal not greater than the last applied ordinal is skipped; otherwise the cursor's last ordinal advances to it. Records with no ordinal (old journals) are always applied — `packages/core/src/feed/codex/apply-codex.ts:372` (through `:375`)
2. History start: the initial cursor is created with last ordinal = historyStart − 1, so records before the offset are skipped by the same rule (the agent-meta reader likewise ignores records with ordinal < historyStart) — `packages/core/src/feed/codex/apply-codex.ts:385` (also `packages/core/src/feed/codex/codex-agents.ts:73`)
3. The cursor is marked "modern" only when an `event_msg` record of type `item_completed` is seen — `packages/core/src/feed/codex/apply-codex.ts:349`
4. The error item is prepended (put first, id `error:codex-history`) only if the cursor is not modern AND at least one record is a `response_item` or an `event_msg` whose type is not `token_count` — `packages/core/src/feed/codex/apply-codex.ts:388` (through `:392`)
Closed when: all four elements are correct. For element 2 the `codex-agents.ts:73` citation is optional; the core fact is lastOrdinal = historyStart − 1. Element 4 must name both conditions (no `item_completed` seen + some conversational record), and "prepended / placed first" must be stated.
Typical wrong answer: "the note is added when records lack an ordinal" or "when the journal is older than 0.160" without the `item_completed` / `token_count` conditions; or claiming ordinal-less records are dropped.
Why grep is not enough: the modern flag is set deep inside the per-record dispatcher, while the condition that uses it and the ordinal filter sit in two other functions; the condition also depends on a second, separate scan of all records.

### Q03 (medium)
Question: In the feed slice, when the Claude Code transcript feed is built together with Parley's mail journal (deliveries sent "with a pointer"), how do journal deliveries end up in the feed? Cover: what the transcript's attachment record contributes, where a delivery that has no matching attachment is inserted, when such a delivery is dropped, and which journal entry wins for a duplicate id.
Required elements:
1. Mail handling applies only to a root (non-sub-agent) transcript; an `attachment` record of type `hook_additional_context` for `UserPromptSubmit` is parsed as an inline delivery, and the journal's version of that delivery (same id) replaces the parsed one at that position — `packages/core/src/feed/from-transcript.ts:170` (replacement on `:174`; root-only on `:266`)
2. After the transcript pass, journal deliveries not already in the feed are inserted in time order; each goes right after the last pointer prompt whose time is ≤ the delivery's time, skipping past mail items already standing there — `packages/core/src/feed/mail-seed.ts:37` (through `:47`)
3. With no such pointer prompt: the delivery is dropped if it is older than the first feed item; otherwise it goes before the first item whose time is later than its own (or at the end) — `packages/core/src/feed/mail-seed.ts:50` (through `:53`)
4. Duplicate ids in the journal: the first entry wins (later repeats and unparsable lines are ignored) — `packages/core/src/feed/mail-seed.ts:21`
Closed when: all four elements are correct. Element 1 is closed by the attachment filter + "journal version preferred"; mentioning root-only is a plus but not required. Element 2 needs both "last pointer prompt not later than the delivery" and "after already-present mail items". Element 3 needs both the drop rule and the time-based placement.
Typical wrong answer: "deliveries are simply appended at the end" or "sorted by time into the feed", missing the pointer-prompt anchoring and the drop-if-older-than-feed rule; or "last entry wins".
Why grep is not enough: the flow crosses two files (transcript builder → mail-seed index and insertion), and the placement rules are spread over a nested loop plus a fallback branch.

### Q04 (hard)
Question: In the feed slice's live Claude Code hook reducer, a permission-request event does not carry the id of the tool call it is about. How does the reducer decide which running call (if any) a new permission card belongs to, what id the card gets, when does it create no card at all, and — once the tool call finishes — which pending cards get settled and with what state?
Required elements:
1. Binding: candidates are running calls with the same tool name that have no card yet, taken from the main feed (or from the sub-agent card's children when the event has an agent id); the last one with an identical (limited) input is preferred, else the last candidate — `packages/core/src/feed/reduce.ts:742` (through `:749`)
2. No card: for the question tool or the plan-exit tool, if no running call matched and a pending non-permission card for that tool already exists, nothing is created — `packages/core/src/feed/reduce.ts:752` (through `:757`)
3. Card id: `permission:<toolUseId>` when bound to a call and that id is still free; otherwise a sequential `permission:#<n>` id from the draft counter (card's toolUseId stays null when unbound) — `packages/core/src/feed/reduce.ts:759` (through `:762`)
4. On the finishing event (post-tool-use or its failure variant): all pending cards with that toolUseId are settled; if none, exactly one — the earliest pending card with no toolUseId, same tool name, same agent and same input; each is settled as `elsewhere` (bound to the toolUseId, and a question card gets its answers from `tool_response` if not already answered) — `packages/core/src/feed/reduce.ts:659` (through `:669`) and `packages/core/src/feed/reduce.ts:818` (through `:824`)
Closed when: all four elements are correct. Element 1 must mention both the "no card yet / running / same name" filter and the input-equality preference with fallback to the last candidate. Element 4 must give the by-id-first, single-unbound-fallback rule and the `elsewhere` state; citing either of the two line ranges is acceptable if both halves of the rule are stated.
Typical wrong answer: "the card is matched to the most recent tool call" (missing the no-existing-card filter and input preference), or "finished calls mark their cards allowed/done", or "all unbound cards with that name are settled".
Why grep is not enough: binding, the question/plan exception, id allocation and settlement live in three separate functions far apart in a ~1200-line file, and settlement depends on a helper defined ~150 lines above its caller.
## Slice: C2 — room plans slice



### Q05 (easy)
Question: In the room-plan slice, an accepted (non-autonomous) plan is running in an open room and the session that owns some of its items gets closed. What happens to each of that owner's items depending on its current status, and who receives the follow-up letter about the items this affects?
Required elements:
1. Every item of a no-longer-live owner that is not yet satisfied and is not already `done` or `blocked` is moved to `blocked` by `system`, with the note "Owner is closed or deleted." — `packages/core/src/work/plans.ts:1006` (note text at `packages/core/src/work/plans.ts:972`)
2. A submitted (`done`) item is left alone: it keeps waiting for its verifier and the owner's closure does not block it (an item blocked this way earlier, right after a `done` entry, is put back to `done`) — `packages/core/src/work/plans.ts:993` (restore at `packages/core/src/work/plans.ts:994-1003`)
3. The letter for a blocked item goes to the room's live lead, not to the owner. It carries the block note and asks for an amended decision. Blocked items get a letter even though their owner is no longer actionable — `packages/core/src/work/plan-effects.ts:141` (exemption at `packages/core/src/work/plan-effects.ts:106-112`)
Closed when: all three are correct. For element 2, "done items are untouched / not blocked" is enough; the legacy restore is a bonus. Also acceptable as extra (not required): this reconciliation runs at the start of every plan-letter reservation pass (`packages/core/src/work/plan-effects.ts:360`); autonomous plans are skipped (`packages/core/src/work/plans.ts:981`); if the room itself is closed, the whole plan is cancelled (`packages/core/src/work/plans.ts:983-988`).
Typical wrong answer: "all the owner's items are blocked", which misses that `done` items are kept. Or "the owner/verifier is notified" instead of the live lead.
Why grep is not enough: the status change is in one file, while the letter routing and the exemption for blocked/done items are in another and must be connected through the item status.

### Q06 (medium)
Question: In the room-plan slice, in verified mode, an item has been submitted but its named verifier has become unavailable. When does a verifier count as unavailable? Who is expected to act on the item instead, and what changes if that person is also the item's owner? Will the verification call accept that person?
Required elements:
1. Unavailable means a verifier is set and is not a live participant: not a room member, or the session is closed. The human is never unavailable — `packages/core/src/work/plans.ts:81` (participant rule at `packages/core/src/work/plans.ts:66-73`)
2. The duty moves to the live room lead: the lead gets a `verify` duty (in the verifier role). If the live lead is the item's owner, the lead instead gets a `resolve-block` duty (propose an amendment with another verifier). With no live lead, nobody gets it — `packages/core/src/work/plan-state.ts:101-111` (the task list feeds this flag at `packages/core/src/work/plan-tasks.ts:252-257`)
3. The verify letter is sent to the live lead instead of the named verifier. Its text says the named verifier is unavailable and that, if the reader owns the item, they should propose an amended plan with another verifier — `packages/core/src/work/plan-effects.ts:128-134`
4. The verification call always rejects the item's owner, even when the owner is the lead. A non-verifier is accepted only if they are the live lead and the named verifier is unavailable. The human is always accepted — `packages/core/src/work/plans.ts:767-779`
Closed when: all four are correct. Accept "lead verifies, but the owner-lead can't and must amend" as elements 2 and 4 together, provided both the duty/letter side and the authorization side are stated. Also acceptable, not required: the letter still targets the lead even when the lead is the owner, because the target does not check ownership.
Typical wrong answer: "the human verifies", or "the lead verifies in every case", which misses the owner-is-lead exception. Another: the claim that the letter goes to the original verifier.
Why grep is not enough: the duty table, letter targeting, unavailability predicate and authorization check are in three different files and must be read together.

### Q07 (medium)
Question: In the room-plan slice, Markdown snapshots of a plan are captured on plan events and later written to shared storage. What identifies one snapshot? What happens when the same snapshot is captured again, and what happens then to the plan change that triggered it? After a snapshot is written, how is the write acknowledged, and when is its record removed from the map?
Required elements:
1. The file name is built from work id, room id, plan id, revision and event (`accepted` / `completed` / `cancelled`) — `packages/core/src/work/plan-snapshots.ts:47`
2. Recapturing the same file with identical text (compared by sha256) returns the existing record, with no duplicate. Different text throws a `snapshot-conflict` error. Because capture runs inside the cloned-draft edit, the throw aborts the whole plan mutation and the caller's map is left unchanged — `packages/core/src/work/plan-snapshots.ts:115-121` and `packages/core/src/work/plans.ts:112-125`
3. The flush writes the pending snapshot under the shared-project lock. Then, in a separate map update, it acknowledges the record by matching file and text sha256 and settles it (the text leaves the map, the digest stays). A failed write leaves the record pending — `packages/core/src/work/plan-snapshots.ts:172-186`
4. A written snapshot record is pruned once its plan's `completedAt`/`cancelledAt` is more than 7 days old. When effect storage is over its limit, the record is pruned regardless of age. A plan with neither date keeps it — `packages/core/src/work/plan-effects.ts:337-340` (7 days: `packages/core/src/work/plan-effects.ts:27`; over-limit second prune: `packages/core/src/work/plan-effects.ts:411-413`)
Closed when: all four are correct. For element 2, both halves are required: same text is a no-op, different text is a conflict that aborts the mutation (or leaves the map unchanged). For element 4, "7 days after the plan ended" is enough. The over-limit case is a bonus.
Typical wrong answer: "a recapture overwrites the earlier snapshot", or the claim that records are deleted right after writing.
Why grep is not enough: capture/identity, the abort behaviour of the edit wrapper, and pruning are in three different files. Pruning is keyed on the plan's end date, not on the record itself.

### Q08 (hard)
Question: In the room-plan slice, an amended revision of an active room plan is accepted. How is it decided which items keep their previous progress and which start over? What is kept, and what is added, for an existing item that starts over? How can an item finished under a checklist plan still count as finished after the plan is promoted to verified mode, without ever being verified?
Required elements:
1. An item starts over if it is new or if any of its title, owner, scope, dependencies, criteria or verifier differ from the previous revision — `packages/core/src/work/plan-state.ts:126-134` (applied at `packages/core/src/work/plan-state.ts:170-171`)
2. The reset spreads transitively: any item that depends (directly or indirectly) on a reset item also starts over — `packages/core/src/work/plan-state.ts:173-181`
3. An unchanged item copies its status, evidence, note, log, progress and submission history. A reset existing item keeps its submission history and log, plus one appended `waiting` entry by the human: "Assignment changed; previous evidence invalidated." Its status, evidence and checkpoints start fresh. Then every waiting/ready item is recomputed from its dependencies — `packages/core/src/work/plans.ts:482-507` (recompute at `packages/core/src/work/plans.ts:511-513`)
4. Promotion exemption: an item is exempt if the old plan was an accepted checklist, the new one is verified, the item was `done`, and its title/owner/scope/dependencies are unchanged (criteria and verifier ignored). It is not reset and is stamped with the old revision number. In verified mode a `done` item counts as satisfied when that stamp is a valid integer lower than the current revision — `packages/core/src/work/plan-state.ts:162-169`, `packages/core/src/work/plans.ts:491-492`, `packages/core/src/work/plan-state.ts:13-17`
Closed when: all four are correct. For element 4, all three parts are required: the exemption condition (including that criteria/verifier changes are ignored), the stamp set to the old revision, and the satisfied rule (stamp < current rev). Paraphrases such as "carries the accepted checklist revision" are acceptable.
Typical wrong answer: "only changed items reset", which misses transitive dependents. Another: "checklist done items become verified on promotion"; in fact they stay `done` and are satisfied through the revision stamp. A third: the claim that a reset item's log is cleared.
Why grep is not enough: the change detection and satisfied rule are in one file, the copy/reset mechanics in another. The exemption only makes sense when the condition, the stamp and the satisfied check are followed across both.
## Slice: C3 — work slice: session worktrees, dependency seeding, launch planning



### Q09 (easy)
Question: In the session-worktree slice, when a session's branch is merged back into its base, what checks can refuse the merge before git merges anything, in what order, and what happens if the merge itself hits a conflict?
Required elements:
1. First, if no checkout (main folder or any worktree) has the base branch, or its HEAD, checked out, the merge is refused as "base not checked out". — `packages/core/src/work/worktree.ts:1310` (lookup at `packages/core/src/work/worktree.ts:843`)
2. Next, if the base checkout has uncommitted changes, it is refused as "base dirty". The project's state directories (`.parley`/`.harnas`, under the project prefix) do not count. — `packages/core/src/work/worktree.ts:1317` (exclusion at `packages/core/src/work/worktree.ts:870`)
3. Then, if the session's own worktree has uncommitted changes, it is refused as "uncommitted". This check is skipped when cleanup has already removed the copy, because only the branch is merged then. — `packages/core/src/work/worktree.ts:1314` and `packages/core/src/work/worktree.ts:1319`
4. The merge is a `--no-ff` merge run in the base checkout. If it fails, the unmerged files (`--diff-filter=U`) are collected, then `merge --abort` restores the base, and the result is "conflict" with that file list. — `packages/core/src/work/worktree.ts:1325`, `packages/core/src/work/worktree.ts:1331`, `packages/core/src/work/worktree.ts:1333`
Closed when: all four elements are present and in this order (base not checked out → base dirty → own uncommitted → conflict with abort). Element 3 must mention the removed-copy exception. Element 2 must say that state dirs are ignored. An answer may also mention, without penalty, that revision names are validated before any git call (`worktree.ts:1308`).
Typical wrong answer: putting the uncommitted check on the session worktree before the base-dirty check, saying that a conflict leaves the base half-merged, or leaving out the removed-copy exception.
Why grep is not enough: the order sits in one function, but the meaning of "base checkout" and of "dirty" comes from two helpers several hundred lines earlier.

### Q10 (medium)
Question: In the worktree slice, a new session worktree can receive ignored paths (dependencies, build output) from the main checkout. Which filters decide which paths qualify, in both the main checkout and the new worktree?
Required elements:
1. The candidates are paths that git lists as ignored-and-untracked under the patterns of the include list file (`ls-files --others --ignored --directory --exclude-from=<list>`) **and** that are also ignored by the project's normal ignore rules (`--exclude-standard`); only the intersection is kept. The list file itself must be a regular, non-empty file of at most 256 KiB. — `packages/core/src/work/worktree-include.ts:91`, `packages/core/src/work/worktree-include.ts:93`, `packages/core/src/work/worktree-include.ts:99` (size check `packages/core/src/work/worktree-include.ts:89`)
2. Each candidate must itself be ignored in the main checkout (`check-ignore`). A directory listed only because something inside it is ignored (e.g. `packages/a/` under a `dist/` rule) is dropped. — `packages/core/src/work/worktree-include.ts:103`, `packages/core/src/work/worktree-include.ts:108`
3. Unsafe entries are dropped: absolute paths, empty or `..` segments, and paths whose first segment is `.git`. So are entries nested under an already-kept entry, and symlinks. At most 1000 entries are kept. — `packages/core/src/work/worktree-include.ts:100`, `packages/core/src/work/worktree-include.ts:120`, `packages/core/src/work/worktree-include.ts:127`, `packages/core/src/work/worktree-include.ts:130`
4. Finally, only entries that are **also ignored in the new worktree** are kept (`check-ignore` run in the target). Directories are queried with a trailing `/`, so a `node_modules/` rule matches even though the directory does not exist there yet. This resolution is what the seeding step calls. — `packages/core/src/work/worktree-include.ts:150`, `packages/core/src/work/worktree-include.ts:152`, `packages/core/src/work/worktree-seed.ts:203`
Closed when: all four filters are named. For element 3, naming nested-entry removal plus either symlink removal or the 1000 cap is enough, as long as the unsafe-path rule is also mentioned. Paraphrases such as "must be both in the include list and gitignored" are fine for element 1.
Typical wrong answer: treating the include file as the whole rule ("everything matching `.worktreeinclude` is copied"), or leaving out the second ignore check in the target worktree.
Why grep is not enough: the filters are spread over three git calls with different exclude sources, plus a second pass against the target that is reached from the seeding module.

### Q11 (medium)
Question: In the dependency-seeding part of the worktree slice, while include paths are being cloned one by one into a new worktree, when is a path skipped (and is the skip reported), how are the per-path entry limit and the time limit applied, and how does a clone reach its final place?
Required elements:
1. A path that already exists in the worktree is skipped silently: it is neither cloned nor reported as skipped. — `packages/core/src/work/worktree-seed.ts:254`
2. The entry limit (300 000 by default) is one budget shared by the whole run, not a per-path limit. Each path's entry count is compared with what is left (`maxEntries - used`), and `used` grows only after a successful clone; going over the budget is reported as `entries`. — `packages/core/src/work/worktree-seed.ts:261`, `packages/core/src/work/worktree-seed.ts:262`, `packages/core/src/work/worktree-seed.ts:281`
3. The time limit is a single deadline for the whole run (120 s by default). It is checked before the entry count and again before the clone, a timer aborts a clone in progress, and once the deadline has passed every later path is reported as `timeout` without starting. — `packages/core/src/work/worktree-seed.ts:241`, `packages/core/src/work/worktree-seed.ts:256`, `packages/core/src/work/worktree-seed.ts:268`, `packages/core/src/work/worktree-seed.ts:273`
4. Each path is cloned into a staging directory inside the worktree's own git dir (`<gitdir>/parley-seed/<index>`). It is then moved into place with `rename` for a directory or a hard `link` for a file. If the target appeared during the clone, the move fails (reported as `failed`) instead of overwriting it. — `packages/core/src/work/worktree-seed.ts:215`, `packages/core/src/work/worktree-seed.ts:249`, `packages/core/src/work/worktree-seed.ts:173`, `packages/core/src/work/worktree-seed.ts:175`, `packages/core/src/work/worktree-seed.ts:178`
Closed when: all four elements are correct. Element 2 must say the budget is cumulative or shared across paths. Element 3 must say the deadline is global and that later paths get `timeout`. The exact defaults (300 000 / 120 s) are not required.
Typical wrong answer: "each path is limited to 300 000 entries and 120 s"; "existing targets are overwritten" or "existing targets are reported as skipped"; "files are copied directly into the worktree".
Why grep is not enough: the shared-budget behaviour shows only when you follow `used` from its declaration through the loop to the increment after the move. The staging location and the move semantics live in a separate helper and in the setup block before the loop.

### Q12 (hard)
Question: In the launch slice, when a session runs on the Codex runner inside its own git worktree, Parley may give the sandbox extra writable locations so that the agent can commit. Under which conditions does that happen, what validation must pass first, and exactly which locations are granted?
Required elements:
1. This happens only when the provider is Codex, the session is not an autonomous-workspace session, the role is not read-only, its sandbox mode is `workspace-write`, the session has a worktree, and the runner template contains the `{approvals}` placeholder. The result is appended to the approvals arguments as `-c sandbox_workspace_write.writable_roots=<JSON list>`. — `packages/core/src/work/launch.ts:504`, `packages/core/src/work/launch.ts:506`
2. The worktree's branch must be exactly `parley/<workId>/<sessionId>` or the legacy `harnas/<workId>/<sessionId>`, and the worktree's `HEAD` must be a symbolic ref to `refs/heads/<that branch>`. Otherwise launch fails with a "worktree-corrupt" error. — `packages/core/src/work/worktree.ts:638`, `packages/core/src/work/worktree.ts:646`, `packages/core/src/work/worktree.ts:648`
3. The worktree's `.git` must resolve, without running git, to a registered worktree git dir under `<common>/worktrees/` whose back-pointer leads to this same folder, and that git dir must not be the shared common dir itself. Otherwise this is also "worktree-corrupt". — `packages/core/src/work/worktree.ts:642`, `packages/core/src/work/worktree.ts:643` (resolution at `packages/core/src/work/worktree.ts:621`, `packages/core/src/work/worktree.ts:624`)
4. The granted locations are the worktree's own git dir, the shared `objects` dir, the branch ref file and its `.lock`, and the branch reflog file and its `.lock` (both under the common dir). The parent directories of the ref and the reflog are created step by step and each must be a real directory. The four files must be absent or regular files (not redirected). — `packages/core/src/work/worktree.ts:649`, `packages/core/src/work/worktree.ts:651`, `packages/core/src/work/worktree.ts:659`, `packages/core/src/work/worktree.ts:667`, `packages/core/src/work/worktree.ts:671`
Closed when: element 1 names at least the Codex, worktree-present, writable `workspace-write` role, non-autonomous and `{approvals}` conditions, and the `writable_roots` flag. Elements 2 and 3 name both validations. Element 4 lists all six roots (git dir, objects, ref, ref.lock, reflog, reflog.lock). Naming the whole common `.git` dir as writable is wrong.
Typical wrong answer: "the whole repository `.git` directory is made writable", "the main checkout is added as a writable root", or leaving out the `.lock`/reflog files. Another is naming the condition only as "Codex with a worktree" and missing the role and template gates.
Why grep is not enough: the gate is one dense line in the launch planner, while the validations and the list of roots are in a different file, behind a call that also depends on a git-dir check about 30 lines earlier.
## Slice: C4 — mail / letters slice



### Q13 (easy)
Question: In the mail slice, when the background watcher tells an agent about new letters, which letters does it notify about and in what order? How is the sender named in the notification, and what number does the notification give as the agent's unread count?
Required elements:
1. It notifies only about unread letters it has not already rung for in this process, sorted oldest-first by their `at` timestamp. — `packages/core/src/mcp/inbox-watch.ts:104`
2. The notification text is "New message from <label> (<kind>): call check_inbox.". Its meta has message_id, from, from_label, kind and unread, and no letter text. — `packages/core/src/mcp/inbox-watch.ts:62`
3. How the sender is named: "Parley" for the Parley system sender, the session's label for a live session, "<id> (deleted)" for a session in the deleted-sessions list, and the bare id otherwise. — `packages/core/src/work/thread.ts:163`
4. The unread number is the session's total unread count from the same snapshot (`mine.length`). It includes letters already rung for, not just the new ones, so every ring in one batch carries the same number. — `packages/core/src/mcp/inbox-watch.ts:109`
Closed when: all four are correct. For element 3, all four label cases must be named. For element 4, the answer must say the count is the total unread, not the count of new or not-yet-rung letters.
Typical wrong answer: says the unread count is the number of new letters in this batch, or that the notification includes the letter text.
Why grep is not enough: the label rules sit in another file behind a call, and the unread number is a variable passed in at the call site, not inside the notification builder.

### Q14 (medium)
Question: In the mail slice, who counts as a recipient of a room letter that names no explicit addressee? How does that change when the room is archived? When a session leaves a room, or the room is archived, which stored unread-candidate rows does the database-backed store delete?
Required elements:
1. For a room broadcast (empty `to`), the recipients are the room's members minus the human and minus the sender. — `packages/core/src/work/letters.ts:24`
2. If the room records join positions, only members whose recorded join number is strictly below the letter's number receive it, so members who joined at or after the letter do not. A member with no recorded value counts as 0. — `packages/core/src/work/letters.ts:30`
3. An archived room has no recipients at all, even for letters with an explicit `to`. This check runs before the explicit-`to` check. — `packages/core/src/work/letters.ts:21`
4. Leaving deletes only that reader's candidate rows for that room's broadcast letters (`recipients = '[]'`), so letters addressed to them explicitly stay unread. Archiving deletes the room's candidate rows for every reader except the human, whose letters stay unread. — `packages/core/src/work/letter-tables.ts:605` (leave) and `packages/core/src/work/letter-tables.ts:614` (archive)
Closed when: all four are correct. "Joined before the letter" is an acceptable paraphrase for element 2. Element 4 needs both halves: leave keeps explicitly addressed letters, and archive keeps the human's candidates.
Typical wrong answer: says that leaving removes all of the reader's unread rows for the room, that archiving also clears the human's unread, or that explicitly addressed letters in an archived room still have recipients.
Why grep is not enough: the recipient rule is in one file and the candidate deletions are SQL in another. The order of the checks (archive before explicit `to`) and the strict comparison against the join number can only be seen by reading the function.

### Q15 (medium)
Question: In the mail slice, for an idle live agent with unread letters, which letters make the host type the pointer right away, and which wait for the room to go quiet? How is the waiting time computed, including its bounds and the handling of unparseable or far-future timestamps? Which letters enter that computation?
Required elements:
1. A letter is urgent unless it is a report-update letter. Otherwise it is urgent if any of these hold: it is from the human, it has an explicit `to`, its kind is not `note`, or its text mentions the recipient as `@sNN` (or `@s-NN` for ids of the form `s-NN`). Any urgent letter makes the delay 0. — `packages/core/src/work/delivery.ts:175` (mention forms: `packages/core/src/work/delivery.ts:161` and `packages/core/src/work/thread.ts:186`)
2. Delay = min(newest + settle, oldest + settleMax) − now, clamped to the range 0..settleMax. The defaults are 30 s and 120 s. — `packages/core/src/work/delivery.ts:208` (defaults: `packages/core/src/work/delivery.ts:20`)
3. The delay is 0 if any letter's timestamp cannot be parsed, or if the newest timestamp is more than the settle window in the future. — `packages/core/src/work/delivery.ts:200` and `packages/core/src/work/delivery.ts:206`
4. Only letters not yet pointed at (and not deleted) enter the computation. The pointer text and the letter-id list still cover every non-deleted unread letter. — `packages/core/src/work/delivery.ts:253` (deleted filter: `packages/core/src/work/delivery.ts:237`; text over all letters: `packages/core/src/work/delivery.ts:295`)
Closed when: all four are correct. The exact constants are needed for element 2; "30 seconds after the newest, at most 2 minutes after the oldest, never more than 2 minutes" is an acceptable paraphrase. Element 1 must include the report-update exception and the mention rule.
Typical wrong answer: says only "notes wait 30 s", or misses the 120 s cap tied to the oldest letter. Other misses: the report-update exception, the future-timestamp shortcut, and the fact that already-pointed letters are excluded from the delay but kept in the text.
Why grep is not enough: the urgency predicate, the mention regex (built from a helper in another file), the delay formula and the pointed-letter filter are in separate functions. The answer needs that whole chain.

### Q16 (hard)
Question: In the mail slice's database-backed letter store, how is a new letter's number chosen so that numbers are never reused after a room is deleted with all its letters, and what does the id look like? If that room deletion happens inside a nested rollback scope that then fails, what is restored, and by what mechanism (given that part of the state is not in the database)?
Required elements:
1. New number = max(the work's remembered `messageSeq` (0 if absent), current MAX(seq) of the work's letters) + 1. The id is `m-` followed by the number zero-padded to at least 2 digits. — `packages/core/src/work/letter-tables.ts:541` (id: `packages/core/src/work/letter-tables.ts:543`)
2. Deleting a room reads the work-wide MAX(seq) before deleting, then deletes the room's letters (reads and candidates go by cascade). If nothing was deleted it returns without changes. Otherwise it raises the in-memory `messageSeq` to max(previous, that top). — `packages/core/src/work/letter-tables.ts:657` to `packages/core/src/work/letter-tables.ts:669`
3. The `messageSeq` change lives on the in-memory map draft, not in the letter tables. So the deletion pushes an undo closure onto the innermost open scope's log (`packages/core/src/work/letter-tables.ts:670`). When the scope fails, it runs its undo log in reverse, restores the "wrote" flag, truncates the write journal to its earlier lengths, then runs SQL `ROLLBACK TO` and `RELEASE`. — `packages/core/src/work/letter-tables.ts:729` to `packages/core/src/work/letter-tables.ts:733`
4. When a nested scope succeeds, it passes its undo actions up to the enclosing scope. A later failure of the outer scope therefore still restores `messageSeq`. — `packages/core/src/work/letter-tables.ts:725`
Closed when: all four are correct. Element 3 must name both the in-memory undo of `messageSeq` and the SQL savepoint rollback; "SQL rollback alone" does not close it. Element 4 may be phrased as "inner successes hand their undo actions to the outer scope".
Typical wrong answer: says the next number is just MAX(seq)+1 from the table, or that the SQL savepoint rollback restores everything (it does not restore the in-memory counter). Another miss is the hand-off of undo actions from inner to outer scopes.
Why grep is not enough: the numbering rule, the room deletion and the savepoint logic are about 200 lines apart in one large file. Linking them needs the undo-stack mechanism read in full, which no comment states end to end.
