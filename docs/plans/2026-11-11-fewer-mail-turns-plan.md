# Fewer mail turns: design and plan

Branch: `feat/fewer-mail-turns` (from `origin/master` 79428593). Owner: s-315. Human request: 2026-11-11, "work out the merges in a new
branch from origin/master and measure; a little of the Claude and Codex limits may be spent".

## 1. Goal

Cut the model responses an agent spends on receiving mail, without changing what the agent learns or when. A response is one request to
the model; each one re-reads the whole conversation, so the cost of a mail tool call is the response it forces, not its JSON.

## 2. Evidence (Claude transcripts of this project, 56 sessions that call Parley, 20,570 responses)

Weights: input 1, cache read 0.1, cache write 1.25, output 5. Shares are of the weighted cost of those 56 sessions. They are upper
bounds from recorded sessions, not provider billing. Codex sessions are not in this sample.

| Pattern | Responses | Share |
|---|---:|---:|
| The response right after `wait_for` was moved to the background by Claude Code (text only 773, Bash or Monitor polling 332, a second `wait_for` 286, `check_inbox` 82) | 1,473 | 6.4% |
| A response whose only action is `check_inbox`, woken by the pointer, mail returned | 1,510 | 7.2% |
| A response whose only action is `check_inbox`, nothing returned | 355 | 1.3% |
| A response whose only action is `wait_for`, right after one whose only action was `send_message` | 164 | 0.6% |

Facts behind the table:

- 1,670 of 3,129 `wait_for` calls (53%) ended as `MCP tool "parley/wait_for" is still running after 120s. It was moved to the
  background…`. Claude Code does this since 2.1.212; the threshold is `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` (default 120000, `0` turns
  it off). Parley does not set it. The guidance tells the agent to wait with one blocking `wait_for("inbox", 1500)`.
- Only 8 `wait_for` calls returned `{"state":"running"}` (a timeout).
- The wake pointer (`New messages (N)… Call check_inbox.`, `packages/core/src/work/delivery.ts:92-115`) costs one response that only
  fetches the mail. Parley already receives `UserPromptSubmit` from Claude Code as an HTTP hook
  (`packages/core/src/work/settings-file.ts`, `FEED_HOOK_EVENTS`), and that hook may answer with
  `hookSpecificOutput.additionalContext` (cap 10,000 characters; the model sees it as a system reminder, not as the user's words).

## 3. Design

### 3.1 M1. Claude Code does not background Parley waits

Every launch whose runner command is `claude` (Claude, GLM, custom Claude-family providers) gets
`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = (MAX_TIMEOUT_SEC + 60) * 1000` (1,860,000). The longest Parley wait is `MAX_TIMEOUT_SEC` (1800 s),
so no `wait_for` is backgrounded, and a runaway call of any other MCP server still is, after 31 minutes. The constant sits next to
`CODEX_MCP_TOOL_TIMEOUT_SEC` (`packages/core/src/work/mcp-config.ts:170`), which follows the same rule for Codex. A value the human
already set in the environment wins.

Not `0`: the docs describe `0` as also changing how an interactive session treats MCP tasks, which is more than this change needs.

### 3.2 M2. The wake pointer brings the mail (Claude Code)

When the host's hook receiver gets `UserPromptSubmit` for a session and the prompt is a wake pointer (the existing pointer pattern in
`delivery.ts`), the host takes that session's inbox page exactly as `check_inbox` does (same view: `messages`, `roomTask`,
`assignment`, `openAssignments`, `remaining`, hints; same mark-read in the same write; same agent-revision and fence checks) and answers
the hook with:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}
```

`<text>` is one fixed English line, then the page as compact JSON:

```
Parley delivered the messages announced above; they are marked read. Do not call check_inbox for them.
{"messages":[…],…}
```

Rules:

- The text is at most 9,000 characters. Letters that do not fit stay unread and are counted in `remaining` with the existing hint
  (`N more unread: call check_inbox again.`); the first letter is cut by the existing single-letter rule if it alone does not fit.
- The pointer text is not changed. If the hook answer is lost, the agent calls `check_inbox` as today and gets the mail.
- Any error, a fenced inbox, a stale agent revision, or nothing unread: answer with no `additionalContext` and mark nothing read.
- The host must answer within 2 s; past that it answers without context and marks nothing read.
- Only Claude-family sessions that have the feed hooks. Codex sessions are not touched by this task.
- The delivery is written to the session's event journal so that usage metrics can count it (one line, the kind named
  `ParleyInlineMail`, with the letter count).

Authority is unchanged: letters stay data from colleagues. They arrive as hook context, which Claude Code marks as a system reminder,
not as text typed by the human.

### 3.3 Not in this phase

- M3, a guidance line that lets the agent put `wait_for` in the same message as its last `send_message` (0.6%). Decided after the
  phase 1 numbers.
- Codex inline delivery. Decided after the Codex baseline (T3) shows what Codex spends.
- Any change to which letters wake a waiting agent.

## 4. Tasks

One task at a time per executor. Commit locally with English messages, only your own paths; no push, no PR. Run targeted test files,
not whole suites. `origin/master` CI is red before this branch in these files, do not chase them: core `work/usage-timeline.test.ts`;
host `feed/feed-service.test.ts`, `methods/providers.test.ts`, `methods/rooms.test.ts`, `sessions/resource-budget.test.ts`,
`sessions/sessions-service{,.queue,.start-write,.switch}.test.ts`, `swarms/swarms-service.test.ts`.

### T1. M1: the background threshold (executor A)

- Files: `packages/core/src/work/mcp-config.ts` (the constant), the place where the launch environment of a `claude` runner is
  assembled (`packages/core/src/providers.ts` and/or `packages/core/src/work/launch.ts`; find the single point that covers Claude, GLM
  and custom Claude-family providers), their tests.
- Acceptance: a test shows the variable with the value 1,860,000 in the launch environment of Claude, GLM and one custom Claude-family
  provider, and absent for Codex; a test shows a value already present in the host's environment is kept; the constant is derived from
  `MAX_TIMEOUT_SEC`, with a test like `mcp-config.test.ts:106`. Launch goldens change only by this line.

### T2. M2: mail with the wake pointer (executor A, after T1)

- Files: the host's hook receiver for feed HTTP hooks (find it under `packages/host/src`), `packages/core/src/work/delivery.ts` (reuse
  the pointer pattern, export it if needed), `packages/core/src/mcp/tools.ts` or `mcp/inbox-page.ts` (a host-callable take of one inbox
  page with a character budget; no second implementation of the view), tests beside each.
- Acceptance, as tests:
  1. pointer prompt, two unread letters: the answer carries `additionalContext` with the fixed line and both letters, the letters are
     read, the text is at most 9,000 characters, the JSON is compact;
  2. more unread than fits: `remaining` and the hint are present, the rest stays unread;
  3. a prompt that is not a pointer: no `additionalContext`, nothing read;
  4. pointer prompt, nothing unread: no `additionalContext`;
  5. the take throws, the inbox is fenced, or the revision is stale: no `additionalContext`, nothing read;
  6. a Codex session: unchanged;
  7. a `roomTask` letter keeps its `roomTask` field in the delivered page.
- Report in the hand-in, as facts: whether `UserPromptSubmit` reaches the host for a pointer typed into the PTY and for the first
  prompt of a resumed session (from the code and existing fixtures; a live check belongs to T3).

### T3. Measurement harness and runs (executor B)

Worktree `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-fewer-mail-turns-bench`, branch `feat/fewer-mail-turns-bench`
(from `origin/master`; its build is also the baseline arm).

- Files: `tools/mail-turns-bench.ts`, `tools/mail-turns-bench.test.ts` (pure parts), results under
  `docs/research/2026-11-11-mail-turns/`. Reuse `tools/parley-token-benchmark-drive.ts` (isolated `PARLEY_HOME`, a copy of a small
  project, host spawn, socket RPC, turn-end detection). Never the live workspace, never this repository's `.parley`.
- One real session under test per run; its counterpart is scripted by the harness (letters sent through the host's own RPC or the
  core store API, no second model).
- Scenario W (waiting): the session is told to send `ready` to the counterpart, then wait for mail; for each letter with a number it
  answers with the number plus one and waits again; on `STOP` it calls `report`. The harness sends letters after 20 s, 150 s, 150 s,
  then `STOP` after 20 s.
- Scenario P (pointer): the session is told to call `report` and end its turn; 30 s later the harness sends a letter with a number;
  the session must answer with the number plus one. Twice.
- Per run, from the provider's own log: model responses (Claude: distinct assistant message ids; Codex: per-request `token_count`
  records), tool calls by name, tool results that say "moved to the background", `check_inbox` calls, tokens (input, cache read, cache
  write, output), wall time, and whether the scenario's final answers are correct.
- `--repo <checkout>` picks the checkout whose `packages/host/dist/main.js` runs: the bench worktree for the baseline, the feature
  worktree for the treatment.
- Order: (1) harness and a dry run on a stub agent, no paid call; hand in for review; (2) baseline runs; (3) treatment runs after T1
  and T2 are reviewed and committed.
- Paid budget, fixed: Claude `sonnet`, 3 runs per scenario per arm (12 runs); Codex `gpt-6.1-sol`, effort medium, 2 runs per scenario,
  baseline only (4 runs). A run is stopped at 40 responses or 15 minutes. Nothing beyond this without the owner.
- Acceptance: a results file with one row per run and a table per scenario and arm (median and each value); a failed or stopped run
  is listed, not dropped; no percentage of savings is derived from fewer than 3 runs per arm.

### Review

One senior reviewer reads the T1 and T2 diff before the treatment runs: authority and mark-read semantics, the 9,000-character rule,
failure paths, tests that would pass without the change.

## 5. Not verified by this document

- That Claude Code calls the HTTP `UserPromptSubmit` hook for a pointer typed into the PTY and for a resumed session's first prompt,
  and waits for its answer.
- That the threshold variable is honoured by the installed Claude Code (2.1.322) for stdio MCP servers.
- Codex behaviour on long waits and on the pointer.
- The effect on provider billing.
