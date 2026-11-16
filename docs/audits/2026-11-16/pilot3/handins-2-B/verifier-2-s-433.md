<!-- verifier 2 s-433 model=gpt-6-luna addedAt=2026-11-16T17:48:43.034Z handedAt=2026-11-16T17:49:58.408Z result=done -->
C36 | PASS | mergeWorktree follows the claimed validation/checkout/dirty-check order, then merges into base with --no-ff -m ... --end-of-options (packages/core/src/work/worktree.ts:1301-1337).
C37 | PASS | Host merge calls requirePresentWorktree before mergeWorktree; presence check stats the worktree path as a directory (packages/host/src/worktrees/worktrees-service.ts:121-135,210-214).
C38 | PASS | Merge failure gathers unmerged paths via diff --name-only -z --diff-filter=U, aborts, and returns conflict plus files (packages/core/src/work/worktree.ts:1326-1334).
C39 | PASS | mergeCheck is a separate export and mergeWorktree does not call it (packages/core/src/work/worktree.ts:1059-1079,1301-1337).
C40 | PASS | Include file is checked with lstat for regular file, nonzero size, and ≤ 256 KiB; invalid input returns [] (packages/core/src/work/worktree-include.ts:14-15,88-89).
C41 | PASS | Candidates come from ls-files -z --others --ignored --directory --exclude-from=<file>, then intersect with exclude-standard results (packages/core/src/work/worktree-include.ts:47-60,91-99).
C42 | PASS | safeEntry rejects empty/absolute paths, empty or '..' segments, and first segment '.git' (packages/core/src/work/worktree-include.ts:77-82,100).
C43 | PASS | ignoredIn invokes check-ignore --stdin in the supplied root, and main-checkout filtering calls it with sourceRoot (packages/core/src/work/worktree-include.ts:66-74,103).
C44 | PASS | Entries are deduped/sorted with trailing slash removed; nested entries, missing paths and symlinks are skipped; maximum is 1000 (packages/core/src/work/worktree-include.ts:105-130).
C45 | PASS | Target-root check-ignore retains only entries ignored there; check-ignore failure causes [] (packages/core/src/work/worktree-include.ts:139-158).
C46 | PASS | Constants are SEED_MAX_ENTRIES = 300_000 and SEED_TIMEOUT_MS = 120_000 (packages/core/src/work/worktree-seed.ts:17-18).
C47 | PASS | Existing target path is continued over before clone and is not added to skipped/cloned reporting (packages/core/src/work/worktree-seed.ts:253-254).
C48 | PASS | Deadline is start + timeout; expired paths get timeout skips and expired prevents later clones; deadline is rechecked after entry counting (packages/core/src/work/worktree-seed.ts:241,255-260,267-272).
C49 | PASS | countEntries counts path plus descendants against maxEntries - used; over-budget path gets entries skip and loop continues; used increases only after clone placement (packages/core/src/work/worktree-seed.ts:120-135,261-264,281).
C50 | PASS | Deadline timer aborts clone; clone uses cp -c (directories via staged directory); failure reason depends on expiration/abort (packages/core/src/work/worktree-seed.ts:73-82,106-118,273-284).
C51 | PASS | Stage is <gitDir>/parley-seed/<index>; placement creates parent, rejects appeared target, renames directories or links then removes staged files (packages/core/src/work/worktree-seed.ts:171-180,213-218,249,280).
C52 | PASS | Seed summary copies up to five skipped paths with reasons (packages/core/src/work/worktree-seed.ts:309-338).
C53 | PASS | Writable roots are added only under the listed Codex/non-workspace/non-readOnly/workspace-write/worktree/template conditions and serialized as a JSON array argument (packages/core/src/work/launch.ts:497-506).
C54 | PASS | prepareWorktreeGitWrites validates branch/revision, separate registered gitdir, branch HEAD, common-dir parents/files and objects directory; failures use worktree-corrupt (packages/core/src/work/worktree.ts:631-670).
C55 | PASS | Returned writable paths are gitDir, common objects, branch ref and lock, branch log and lock: six total (packages/core/src/work/worktree.ts:671).
C56 | PASS | Watcher filters ids already rung, sorts ascending by at, and rings in order (packages/core/src/mcp/inbox-watch.ts:79,102-105,126-129).
C57 | PASS | Watcher uses unreadLetters without a deleted-letter filter; unread selection has no deleted check (packages/core/src/mcp/inbox-watch.ts:102, packages/core/src/work/letters.ts:37-38, packages/core/src/work/letter-tables.ts:293).
C58 | PASS | participantLabel maps parley to Parley, live session to label, deleted session to '<id> (deleted)', otherwise raw id (packages/core/src/work/thread.ts:162-167).
C59 | PASS | Ring text has the claimed form; unread metadata is mine.length, including all unread letters in the probe snapshot (packages/core/src/mcp/inbox-watch.ts:60-70,109).
C60 | PASS | recipientsOf implements archived-room none, explicit to, otherwise room members excluding human/sender, missing room none, and joinedSeq threshold for broadcast (packages/core/src/work/letters.ts:20-30).
C61 | PASS | left deletes only this reader's room unread rows whose corresponding letter has recipients '[]' (packages/core/src/work/letter-tables.ts:600-608).
C62 | PASS | archived deletes all room unread rows except those for HUMAN (packages/core/src/work/letter-tables.ts:610-617).
C63 | PASS | Urgent excludes report updates; otherwise human sender, nonempty to, non-note kind, or recipient mention qualifies (packages/core/src/work/delivery.ts:154-177).
C64 | PASS | Constants and settleDelayMs branches/formula match the claim (packages/core/src/work/delivery.ts:20-21,190-209).
C65 | PASS | Delivery removes deleted letters, and settle computation receives only letters whose ids are not pointed (packages/core/src/work/delivery.ts:237,252-254).
C66 | PASS | Sequence is max(work.messageSeq ?? 0, work MAX(seq)) + 1; id is m- plus a minimum two-digit padded sequence (packages/core/src/work/letter-tables.ts:539-543).
C67 | PASS | deleteRoom reads max seq before deletion and stores a greater sequence in work.messageSeq with an undo entry (packages/core/src/work/letter-tables.ts:656-672).
C68 | PASS | Savepoint rolls back undo actions in reverse, restores wrote and journal, rolls back/releases SQL savepoint and rethrows; success forwards undo entries outward (packages/core/src/work/letter-tables.ts:710-736).
Coverage is complete for C36–C68.