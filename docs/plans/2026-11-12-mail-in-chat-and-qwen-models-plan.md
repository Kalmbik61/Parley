# Mail in Chat and Qwen Code models: plan

Spec: `docs/specs/2026-11-12-mail-in-chat-and-qwen-models-design.md` (revision 1).
Branch: `parley/w-0054/s-345`. Lead: s-345. Owner: s-320. Room: r-28.
Status: draft. **No task starts before the human accepts the spec and decisions D1–D6.**

## Rules for every task

**Where.**
- Work only in `/Users/kalmbik61/parley/worktrees/my_harnas-00f205/w-0054-s-345`. Never touch the main checkout `/Users/kalmbik61/Desktop/MY/my_harnas`.
- One executor in the worktree at a time. No stash.

**Scope.**
- One task per executor at a time. Do not widen it.
- Ask the lead in r-28 when the spec does not answer something.

**Commits.**
- English conventional messages. No push, no PR.

**Checks before submit.** Report the counts for each:
- `pnpm --filter <touched packages> test`;
- `pnpm typecheck`;
- `pnpm lint`.

**Tests.**
- Every behaviour change has a test.
- Fixtures copy the *shape* of real records (spec §2.2) with invented content. No letter text, labels or paths from the human's real transcripts or rollouts go into the repository.

**Review.** The lead reviews each task against its criteria before the next starts. The final review (R1) is by a senior model that wrote none of the code.

**Seniority.**
- Junior tasks: Claude Sonnet or Codex gpt-6.1-sol, chosen by the remaining weekly limit (2026-11-12: Claude 97 %, Codex 93 %).
- One executor session takes M1–M4 in order: the same context, fewer sessions.
- No task is senior-only. M3 touches the hook answer path; its criteria pin that the answer does not change, and the lead reviews that part line by line.

## Order and shared files

```
Part M: M1 → M2 → M3 → M4 → V1 → R1 (+ fixes and delta review)
Part Q: Q2a (done, spec §8) → [human signs in] → Q1/Q2b → Q2c (spec revision 2, critique, second proposal)
```

- Strictly sequential.
- **Shared files:** `core/src/feed/types.ts` (M1, M2), `core/src/feed/reduce.ts` (M2), `host/src/feed/feed-service.ts` (M3), `desktop/src/renderer/chat/FeedList.tsx` (M1 stub, M4).

## Part M

### M1. Mail parser, types and fixtures (core)

**Scope.**
- **Record the shape first.** Record the real `response.text` that the feed holds for a Claude MCP tool result (`mcp__parley__check_inbox`), from the transcript and from a `PostToolUse` hook body (spec §2.2, [N]). Put the shape in the report.
- **Types.** In `packages/core/src/feed/types.ts`, add `FeedMail` and `FeedMailLetter` (spec §3.1), add `FeedMail` to `FeedItem`, add `FEED_MAIL_TEXT_LIMIT` = 16 Ki, and export them from the core index.
- **New `packages/core/src/feed/mail.ts`.**
  - `mailFromInline(text, at)`: text that starts with `INLINE_MAIL_LINE` + `\n` + JSON. `via: 'pointer'`, `toolUseId: null`.
  - `mailFromTool(tool)`: a top-level `tool` item that is `done`, under the rule of spec §3.2(b). It unwraps raw JSON, an MCP `{content:[{type:'text', text}]}` object, and an array of text parts.
  - Letters are validated field by field:
    - an invalid letter is skipped; no valid letter means `null`;
    - text longer than the limit is cut and gets `cut: true`;
    - the letter named by the hint "Message <id> is cut" gets `cut: true`;
    - `remaining` is copied;
    - `id` is `mail:<first letter id>`.
- **Stubs so typecheck stays green.**
  - Desktop `FeedList` `ItemView`: `case 'mail': return null`.
  - Mobile `FeedItemView`: `case 'mail': return null`.
  - Any other exhaustive switch that typecheck flags gets the smallest neutral case. M4 replaces the desktop stub; the phone keeps its stub (D2).
- **Fixtures** in `packages/core/src/feed/fixtures/mail/`:
  - Claude transcript `attachment` `hook_additional_context`, plus one SessionStart attachment as a negative;
  - Claude transcript `tool_use` + `tool_result` for `check_inbox` and for `wait_for {target:"inbox"}`;
  - Claude `PostToolUse` body for both;
  - Codex `event_msg/item_completed` `McpToolCall` for `check_inbox` and for `wait_for` (the `{state:"message", messages}` form);
  - Qwen assistant `functionCall` + `tool_result` for `check_inbox`.

**Files.** `core/src/feed/types.ts`, `core/src/feed/mail.ts` (new), `core/src/index.ts`, fixtures, `core/src/feed/mail.test.ts` (new), the stubs.

**Criteria.**
1. Every positive fixture gives the expected item. The test checks every field, including `via` and `toolUseId`.
2. These give `null`:
   - SessionStart context;
   - text without `INLINE_MAIL_LINE`;
   - `wait_for` with a session id target;
   - `read_room`, `get_map` and any other tool;
   - a `failed` tool;
   - empty `messages`;
   - malformed JSON;
   - a response with `truncated: true`;
   - a tool item with `agentId`.
3. Long text is cut with `cut: true`, the hint marks its letter `cut`, and an invalid letter is skipped.
4. Tests, typecheck and lint pass. The report states the recorded Claude MCP response shape.

### M2. Feed reducers emit `mail` (core)

**Scope.** Call M1 where tools finish and where the inline attachment is read, and put the `mail` item right after its source:
- `from-transcript.ts`:
  - a new branch for `attachment` records whose `attachment.type` is `hook_additional_context`;
  - the `tool_result` finish (line 159).
- `reduce.ts`: the live hook finish (line 802), top-level only. The child path at line 795 makes no mail.
- `codex/apply-codex.ts`: the `McpToolCall` finish (line 235), only when `agentId` is null.
- `codex/apply-codex-hook.ts`: line 73.
- `qwen/apply-qwen.ts`: line 108.

**Criteria.**
1. Built from each fixture, the feed shows the `tool` item followed by the `mail` item. For inline: the pointer `prompt`, then `mail`.
2. Applying the same records twice leaves one `mail` item.
3. For one Claude delivery, the live hook path and the transcript seed give equal `mail` items.
4. A subagent's `check_inbox` gives no `mail`.
5. Existing feed tests pass unmodified.

### M3. Protocol, host gate, live inline item (protocol + host)

**Scope.**
- **Protocol** (`protocol/src/feed.ts`):
  - a strict `mail` schema;
  - `FEED_SCHEMA_VERSION` = 4;
  - `FEED_MAIL_FEATURE = 'feed-mail'`, exported;
  - `feed.test.ts` parses the M1 fixture items.
- **Host gate** (`host/src/feed/feed-service.ts`). For a client without `feed-mail`, drop:
  - `mail` items from the `feed.snapshot` result;
  - `mail` items from `feed.changed` `upsert`;
  - `mail:` ids from `removed`.

  The ring and revisions are not changed.
- **Live inline.**
  - The feed service gets a method that applies `mailFromInline` for a session ref and commits it as a normal update.
  - `host/src/hooks/inline-mail.ts` gets an optional `delivered(ref, text, at)` dependency. It is called once, right after the hook is answered with the letters, and never on late, abandoned, empty, fenced or failed takes. A throw inside it is caught and logged and does not touch the answer.
  - Wire it where `createInlineMail` and the feed service are created.
- **Phone.** Check that the client `packages/remote` uses for feed subscriptions does not announce `feed-mail`, and say so in the report with a file and line.

**Criteria.**
1. Without the feature, the snapshot and deltas hold no `mail` and no `mail:` removals. With it, both hold them. Revisions are equal in both cases.
2. `inline-mail` tests:
   - `delivered` is called exactly once with the answered text;
   - it is not called on late, abandoned, empty or failed takes;
   - the hook response is the same as before the change (existing tests pass unmodified);
   - a throwing `delivered` still answers the hook with the letters.
3. A live inline delivery puts the pointer `prompt`, then `mail` with id `mail:<first id>`. A reseed from a transcript with the matching attachment gives the same item.
4. Tests, typecheck and lint pass.

### M4. Desktop Chat (desktop)

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

### V1. Verification on the real app (builtin:verifier, junior, with the lead)

**Scope.**
- Build and run the desktop app from the branch, in the same way as V1 of the Qwen provider work (Playwright Electron).
- Run spec §4 items 1–8. Use short sessions with tiny prompts, to save limits.
- Save screenshots to the verifier's scratchpad.
- Measure:
  - the `mail` item bytes per delivery;
  - the feed seed time of a long Claude transcript, before and after (base f5c32ebb vs. HEAD).

**Criteria.**
- Each §4 item is pass, fail or not verified, with a screenshot path or test name.
- The Codex `exec` item (3) has a screenshot.
- The Qwen item (4) follows D4.

### R1. Independent review (senior, wrote none of the code)

- **Reviewer.** The stage 1 critic (Codex gpt-6-astra) reviews the whole diff against the spec. If the Codex limit is hit, Claude Opus does it.
- **Fixes.** The M executor makes the fixes. Then a delta review.

## Part Q

- **Q2a, done.** No code. Unsigned facts are in spec §8.2. The facts that need the account are in §8.3.
- **Q1/Q2b.** Runs after s-320 says the human has signed in. The lead does it, read-only, with the human's real Qwen home:
  - spec §8.3 items 1–4: `settings.json` `security.auth.selectedType`; the ACP `session/new` `availableModels` probe; whether `qwen --model <id>` accepts that id in a short pty session; the timings;
  - s-322's "Not verified" list: one short real turn for records, usage and resume. The quota error is recorded only if it happens; it is never provoked.
  - It never reads `oauth_creds.json`, `subscription_credentials.json` or any key. The facts go into spec §8 through the docs copier.
- **Q2c.** The catalog design becomes spec revision 2. Then a critique, then a second `propose_decision`. Q implementation tasks are planned only after that acceptance.

## Out of this plan

- `mail` on the phone (D2, the second option).
- A reply UI, and any change to delivery.
