# Mail in Chat, Qwen approval mode and Qwen Code models: plan

Spec: `docs/specs/2026-11-12-mail-in-chat-and-qwen-models-design.md` (revision 3).
Branch: `parley/w-0054/s-345`. Lead: s-345. Owner: s-320. Room: r-28.

Status: revision 3.
- **Part M is accepted** as p-48 with D1–D8 (spec §7). M1 is done (3bafe473); M2 is in progress.
- **Parts A and Q** (tasks A1, Q1, Q2) wait for critique and the human's acceptance of the second proposal. No code for them before that.
- **Part O** (OpenCode) has its own documents.

## Rules for every task

**Where.**
- Work only in `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-345`. Never touch the main checkout `/Users/kalmbik61/Desktop/MY/my_harnas`.
- One executor in the worktree at a time. The docs copier commits with `git commit --only <path>`. No stash.

**Scope.**
- One task per executor at a time. Do not widen it.
- Ask the lead in r-28 when the spec does not answer something.

**Commits.**
- English conventional messages. No push, no PR.

**Checks before submit.** Report the counts for each:
- `pnpm --filter <touched packages> test`;
- `pnpm typecheck`;
- `pnpm lint`.

Name every failing test. The known failures before this work are frame-check, launch.test (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`) and usage-timeline (flaky). A new failure is the task's to fix.

**Tests.**
- Every behaviour change has a test.
- Fixtures copy the *shape* of real records (spec §2.2, §8.3) with invented content. No letter text, labels or paths from the human's real transcripts, rollouts or Qwen files go into the repository.

**Review.** The lead reviews each task against its criteria before the next starts. The final review (R1) is by a senior model that wrote none of the code.

**Seniority.**
- Junior tasks: Claude Sonnet. Codex executors cannot write this worktree: their `workspace-write` sandbox covers only their own cwd.
- One executor session (s-349) takes the tasks in order.
- No task is senior-only. M4 and Q2 touch the hook answer path, the Claude seed and a child process; their criteria pin the behaviour, and the lead reviews those parts line by line.

## Order and shared files

```
Part M (accepted): M1 ✓ → M2 → M3 → M4 → M5
Parts A, Q (after the second acceptance): A1 → Q2
Then: V1 (M + A + Q, real app; includes Q1) → R1 (+ fixes and delta review)
```

- Strictly sequential. If the second proposal is not accepted when M5 ends, V1 runs for Part M alone, and V1-AQ runs later.
- **Shared files:**
  - `core/src/feed/types.ts` (M1, M2);
  - `core/src/feed/reduce.ts` and `from-transcript.ts` (M2, M4);
  - `host/src/feed/feed-service.ts` (M3, M4);
  - `desktop/src/renderer/chat/FeedList.tsx` (M1 stub, M5);
  - `core/src/providers.ts` (Q2);
  - `core/src/work/launch.ts` (A1);
  - `host/src/methods/providers.ts` (Q2).

## Part M (accepted)

### M1. Mail parser, types and fixtures (core) — done, 3bafe473

### M2. Feed reducers emit `mail` from tool results (core)

**Scope.**
- Call `mailFromTool` where top-level tools finish. Append the item when the tool finishes (completion order, spec §3.2b):
  - `from-transcript.ts`: the `tool_result` finish (line 159);
  - `reduce.ts`: the live hook finish (line 802). The child path at line 795 makes no mail;
  - `codex/apply-codex.ts`: the `McpToolCall` finish (line 235), only when `agentId` is null;
  - `codex/apply-codex-hook.ts`: line 73;
  - `qwen/apply-qwen.ts`: line 108.
- **Root/child context.**
  - Add an explicit context option to `feedFromTranscript` and `feedFromCodexRollout`: root, the default, or child.
  - Child turns mail off.
  - In `host/src/feed/feed-service.ts`, `agentSnapshot` passes child for the Claude subagent transcript (`:1595-1596`) and the Codex child rollout (`:1582-1585`).

**Criteria.**
1. Built from each tool fixture, the feed shows the `tool` item and then, at its finish, the `mail` item.
2. The overlapping-tools fixture gives A, B, mail-A, both through live hooks and through the transcript.
3. Applying the same records twice leaves one `mail` item.
4. For one Claude delivery, the live hook path and the transcript seed give `mail` items equal in `id`, `via`, `toolUseId`, `letters` and `remaining`.
5. A test through the real `agentSnapshot` entry points, for a Claude subagent transcript and a Codex child rollout that hold `check_inbox`, gives no `mail`.
6. Existing feed tests pass unmodified.

### M3. Protocol and per-client gate (protocol + host)

**Scope.**
- **Protocol** (`protocol/src/feed.ts`):
  - a strict `mail` schema;
  - `FEED_SCHEMA_VERSION` = 4;
  - `FEED_MAIL_FEATURE = 'feed-mail'`, exported;
  - `feed.test.ts` parses the M1 fixture items.
- **Snapshot gate.** `host/src/methods/feed.ts` passes `request.client` to `feed.snapshot`. For a client without `feed-mail`, the feed service drops `mail` items from the snapshot it returns.
- **Delta gate.** `feed.changed` is filtered per subscriber: `mail` items leave `upsert`, and `mail:` ids leave `removed`. A delta that carried only mail is still sent with an empty `upsert`, with the same `revision`.
- The ring and revisions are not changed.
- **Phone.** Confirm that `packages/remote/src/host-link.ts:335` does not announce `feed-mail`, and test it.

**Criteria.**
1. A client without the feature gets no `mail` in:
   - an unsubscribed snapshot;
   - a subscribed snapshot;
   - a delta.

   A client with it gets all three.
2. An old and a new client on one feed get their own views. Their revisions are equal.
3. A mail-only delta reaches the old client as an empty delta with the next revision.
4. A test asserts that the remote bridge's hello features lack `feed-mail`.
5. Tests, typecheck and lint pass.

### M4. Inline mail: journal, live item, seed reconciliation (core + host)

**Scope.**
- **Mail journal.** In `host/src/hooks/inline-mail.ts`, just before answering the hook with the letters, append `{at, text}` to `<work>/mail/<session>.jsonl`.
  - Create the directory when it is missing.
  - A failed write is logged and does not change the answer (D8).
  - The `ParleyInlineMail` line in `events/` stays as it is.
  - Check that nothing that globs `events/` or the work folder takes the new directory for sessions or hooks, and name the checked files in the report.
- **Live item.** An optional `delivered(ref, text, at)` dependency, with the same `at` as the journal line.
  - It is called once, right after the hook is answered with the letters.
  - It is never called on late, abandoned, empty, fenced or failed takes.
  - A throw inside it is caught and logged and does not touch the answer.
  - The feed service applies `mailFromInline` and commits a normal update.
  - Wire it where `createInlineMail` and the feed service are created.
- **Seed** (`seedClaude`, and the transcript reader for root feeds):
  - an `attachment` record of an inline delivery places the item; its content and `at` come from the journal line with the same `mail:` id, or from the attachment when no line exists;
  - every journal delivery that is missing after the transcript is inserted after the last pointer `prompt` whose `at` is not later than its own; with no such prompt, it goes in time order;
  - child feeds read no journal.

**Criteria.**
1. `inline-mail` tests:
   - the journal line and `delivered` both happen once with the answered text and the same `at`;
   - neither happens on late, abandoned, empty or failed takes;
   - a throwing journal or `delivered` still answers the hook with the letters;
   - the existing tests pass unmodified.
2. A live inline delivery puts the pointer `prompt`, then `mail` with id `mail:<first id>`.
3. A reseed from a transcript **with** the attachment gives an item equal to the live one, `at` included, in the same place.
4. A reseed from the same transcript **without** the attachment, with the journal line present, gives the same item after the pointer prompt.
5. A reseed with an attachment and no journal line (a delivery from before this change) gives the item parsed from the attachment.
6. The report gives the journal bytes per delivery and the seed time with and without the journal, on a fixture of 200 inline deliveries.
7. Tests, typecheck and lint pass.

### M5. Desktop Chat (desktop)

**Scope.**
- The desktop announces `feed-mail` in `hello.features`, where it announces `feed-resync`.
- New `chat/items/MailItem.tsx`, per spec §3.4:
  - sender per type: session (`sessionRowLabel`), `you`, system, `Parley`;
  - kind badge, room `r-NN · title`, local time;
  - text folded to 6 lines with Show more / Show less;
  - cut mark and "N more unread".
- `FeedList` `ItemView` renders it, replacing the M1 stub. The virtualizer estimate covers it.
- `turn-fold.ts`: `mail` is always visible in both modes and never joins a group.
- `find.ts`: searches letter text and sender.
- Strings go in `shared/strings.ts` next to `chat.letter`.

**Criteria.**
1. Item tests cover:
   - the four sender types;
   - the kind badge, room and time;
   - a letter over 6 lines folded, then expanded and folded back;
   - the cut mark;
   - the `remaining` line.
2. Fold tests:
   - `mail` is visible in both modes;
   - a turn of pointer → `mail` → text has no "Retried requests" group;
   - a turn of `check_inbox` tool → `mail` → text keeps the tool in its group and `mail` visible.
3. A find test hits letter text and sender.
4. The hello test includes `feed-mail`.
5. Tests, typecheck and lint pass.

## Part A (after the second acceptance)

### A1. Qwen starts in `auto` (core)

**Scope.**
- In `core/src/work/launch.ts:538`, ordinary Qwen sessions get `subs.approvalMode = 'auto'` (or `auto-edit` if the human picks it in DA1), new and resumed. Autonomous workspaces keep `auto`.
- `yolo` is never produced. Read-only roles are still refused, as today.
- Update the comment at `core/src/providers.ts:626` and the D6 comment at `:473`.

**Criteria.**
1. Launch-argument tests: a new Qwen session and a resumed one both carry `--approval-mode auto`.
2. No path produces `yolo` (a test over the launch variants).
3. The read-only role refusal test is unchanged and passes.
4. Tests, typecheck and lint pass.

## Part Q (after the second acceptance)

### Q2. Qwen model catalog from ACP (core + host)

**Scope.**
- **Core.**
  - `qwenModelsFile()` beside `codexModelsFile()`.
  - `loadProviders` reads it into the `qwen` entry's `models`, with the same validation and limits as the Codex file (`providers.ts:1150` onwards).
  - No file or an invalid file: `models: null`, as today.
- **Host.** New `host/src/providers/qwen-catalog.ts`, after `codex-catalog.ts`, per spec §8.4:
  - the probe spawns `qwen --acp` (PATH or `PARLEY_QWEN_BIN`) with an empty temp `cwd` it creates and removes;
  - it sends `initialize` and `session/new {cwd, mcpServers: []}` as JSON-RPC lines, reads `result.models.availableModels`, then kills the process group;
  - timeout 15 s, output cap 1 MiB;
  - it keeps entries with `_meta.isRuntime === false`, maps `id` = `_meta.baseModelId` and `label` = `name`, keeps the ACP order, and sets `efforts: null`;
  - it starts at host start when `qwen` is installed, refreshes in the background from `providers.list` when the catalog is older than 6 h, and refreshes after `providers.signInExit` for `qwen`;
  - a list that differs from the stored one is written atomically and fires `onChange`; a failure leaves the file alone.
- **Wiring** in `host.ts` and `methods/providers.ts`, the way `codexCatalog` is wired.

**Criteria.**
1. Unit tests with a fake `qwen --acp` script (no real CLI and no network) cover:
   - the three-model answer (an invented shape copy of spec §8.3 item 2), giving three `ModelOption`s in order with bare ids;
   - an "Authentication required" error, a timeout, oversized output and malformed JSON: the stored file is untouched;
   - runtime entries, which are dropped.
2. A test that the probe passes no Parley settings file and opens no file under the Qwen home (it spawns only the CLI).
3. `providers.list` shows the stored list for `qwen`. With no file, `models` is `null`.
4. Refresh after 6 h and after `signInExit` (fake clock).
5. Tests, typecheck and lint pass.

## Verification and review

### V1. Verification on the real app (builtin:verifier, Claude Sonnet, with the lead)

**Scope.**
- Build and run the desktop app from the branch, in the same way as V1 of the Qwen provider work (Playwright Electron).
- Use short sessions with tiny prompts, to save limits.
- Save screenshots to the verifier's scratchpad.
- **Part M.** Spec §4 items 1–9. For item 5, Restart Host with the sessions idle, and open each Chat before the session's next hook (D7).
- **Parts A and Q.** Spec §9.4 items 1–4. Q1 (§8.5) with `qwen3.8-flash`:
  - Chat thought and text;
  - usage;
  - resume;
  - the TUI mode at start;
  - the picker.
- Measure:
  - the `mail` item bytes per delivery;
  - the mail journal bytes per inline delivery;
  - the feed seed time of a long Claude transcript, before and after (base f5c32ebb vs. HEAD);
  - the Qwen catalog probe time.

**Criteria.**
- Each item is pass, fail or not verified, with a screenshot path or test name.
- The Codex `exec` item and the Qwen mail item have screenshots.

### R1. Independent review (senior, wrote none of the code)

- **Reviewer.** The critic s-348 (Codex gpt-6-astra) reviews the whole diff against the spec. If the Codex limit is hit, Claude Opus does it.
- **Fixes.** The executor makes the fixes. Then a delta review.

## Out of this plan

- `mail` on the phone (D2).
- A reply UI, and any change to delivery.
- The restart race (D7, b-041).
- Qwen effort (DQ2), unless the human picks the follow-up.
- Part O (OpenCode): separate documents.
