# Delivered mail in Chat, Qwen approval mode, and Qwen Code models: design

Status: revision 4.
- **Part M is accepted** by the human as p-48 (r-28, m-7946), with the first option of every decision D1–D8 (§7). Implementation has started.
- **Parts A and Q** wait for the second proposal. No code for them before the human accepts.
- Critique history:
  - revision 1 (7fb04655) was critiqued by s-348 (Codex gpt-6-astra, "revise");
  - revision 2 (3e72171b) answered every finding (appendix A), and the delta review accepted it, with D8 left for the human;
  - revision 3 (2a9460a3) added Parts A and Q; s-348 asked to revise them (2 major, 2 minor), and revision 4 answers every finding (appendix B).
- **Part O** (OpenCode 2.x) gets its own documents and proposal.
- Lead s-345, owner s-320, room r-28 (2026-11-12).
- Plan: `docs/plans/2026-11-12-mail-in-chat-and-qwen-models-plan.md`.
- Branch: `parley/w-0054/s-345`, fast-forwarded to `origin/master` f5c32ebb (0.34.0). All parts land here. No push and no PR until the human says so.

## 1. The request

**Part M.** The human, 2026-11-12 (translated): when sessions send each other messages, the recipient's Chat shows only the
host's pointer prompt "New messages (N)… Call check_inbox."; the letter itself is not visible. The human wants to see in
that session's Chat which message arrived and from which session.

Confirmed by the human through s-320 the same day (r-28, m-7924): letters must be visible in Chat for **every provider
family**, not only Claude Code. Acceptance is per family:
- **claude** (Claude Code, GLM and custom providers of the Claude family): inline with the pointer, and through `check_inbox` / `wait_for`;
- **codex**: `check_inbox` / `wait_for`, including a wait inside its `exec` script;
- **qwen**: `check_inbox` / `wait_for`.

Verification must show a real Codex session's Chat with a delivered letter, not only Claude's. A family that cannot be
covered in the first version is an explicit open choice (§7), not a silent gap.

**Part A.** The human, 2026-11-12, through s-320 (m-7950): Qwen Code must start in auto-accept, not manual. Today the human
switches by hand (§9).

**Part Q.** Qwen Code with a live account (s-320, m-7925, m-7950):
- **Q1:** live verification of the "Not verified" list of the Qwen provider work.
- **Q2:** a model catalog. Today there is only "Default" or a typed model id.

The human signed in on 2026-11-12; the facts are in §8.

**Out of scope.**
- No mail client and no reply UI.
- No change to delivery: pointer text, when it is typed, inline answer, marking read.
- The room feed and the window's mail views stay as they are.

## 2. Facts (Part M)

**Legend:** **[O]** observed in a real file or run on this machine; **[S]** read in source; **[N]** not verified.

### 2.1 Delivery

- **[S] One take for every route.** `check_inbox`, `wait_for("inbox")` and the inline answer to the pointer all go through
  `takeInbox` (`packages/core/src/mcp/tools.ts:1416`). It builds one page with `inboxPage` and marks exactly those letters
  read with `letters.markRead(sessionId, page.ids, at)`. The marks are committed before the page is returned, so a letter is
  never delivered twice.
- **[S] Letter view.** Each letter on the page is `inboxView` → `messageView` (`tools.ts:265`):
  - `id`, `from`, `fromLabel`, `at`, `text`, `kind`, `room: {id, title} | null`;
  - optional `replyTo`, `via`, `toEveryone`, `roomTask`, `assignment`.

  The page carries `remaining` and `hint` when letters are left or one letter is cut.
- **[S] Page limits.**
  - At most `INBOX_MAX_LETTERS` = 50 letters and `INBOX_MAX_BYTES` = 32 KiB per page (`context-budget.ts:47-49`).
  - The inline route has its own cap, `INLINE_MAIL_MAX_CHARS` = 9000 chars.
- **[S] Inline route.** Only Claude-family providers get it (`packages/host/src/hooks/inline-mail.ts`,
  `byFamily(provider, { claude: false, … })`). The host answers the `UserPromptSubmit` hook whose prompt is the pointer with
  `additionalContext` = `INLINE_MAIL_LINE + "\n" + JSON.stringify({messages, ...extras})`.
- **[S] Journal line.** `ParleyInlineMail` in `events/<session>.jsonl` records only `letters` (a count), just before the
  answer (`inline-mail.ts:38-41, 96-101`). Metrics read it.
- **[S] Other marks without delivery.** Two `markRead` calls mark letters read without handing them to the agent as letters:
  - `report` marks an older unread report letter about the same session read when a newer one replaces it (`tools.ts:969`);
  - `wait_for(<session id>)` marks the report letters about that session read when it returns that session's result (`tools.ts:1255`).

### 2.2 Where the delivered letters live, and how the feed reads them

- **[O] Claude Code 2.1.322, inline route.** The transcript stores the hook context as its own record. The record comes right
  after the pointer's `user` record, and its `parentUuid` is that record:

  ```json
  {"type":"attachment","timestamp":"…","attachment":{"type":"hook_additional_context","hookName":"UserPromptSubmit",
   "hookEvent":"UserPromptSubmit","toolUseID":"hook-…","content":["Parley delivered the messages announced above; … \n{\"messages\":[…]}"]}}
  ```

  - SessionStart context uses the same attachment type with other text. Only content that starts with `INLINE_MAIL_LINE` is mail.
  - Today `feedFromTranscript` drops every `attachment` record (`from-transcript.ts:271`).
  - This record is not a public contract. Versions between `FEED_MIN_VERSION` 2.1.286 and 2.1.322 are **[N]**, and Claude
    Code may drop a hook context. So the attachment alone is not a durable source (critique finding 1).
- **[S] Claude Code, tool route.**
  - `check_inbox` / `wait_for` results are ordinary MCP tool results. They are in the transcript (`tool_result`) and in the
    live `PostToolUse` hook.
  - The feed already turns them into `tool` items named `mcp__parley__check_inbox` / `mcp__parley__wait_for`, with
    `response.text` up to `FEED_RESULT_LIMIT` = 64 Ki chars.
  - **[O, M1]** In the transcript both `tool_result.content` and `toolUseResult` are `[{type:'text', text:'<JSON indented by 2>'}]`. The feed joins the text parts into `response.text`. The live `PostToolUse` body is **[N]**.
- **[O] Codex, tool route, including `exec`.** Codex runs Parley tools from `exec` scripts
  (`text(await tools.mcp__parley__wait_for({target:"inbox", …}))`). Its rollout still records one
  `event_msg/item_completed` `McpToolCall` item per MCP call made inside the script:
  `{type:"McpToolCall", server:"parley", tool:"check_inbox"|"wait_for", arguments, status:"completed", result:{content:[{type:"text", text:"{…\"messages\":[…]}"}]}}`.
  - Seen for `check_inbox` (rollout 2026-11-12T00-02-07) and for `wait_for {target:"inbox", timeoutSec:1500}` returning `{"state":"message","messages":[…]}` (rollout 2026-11-11T15-45-37).
  - `apply-codex.ts:229-235` already turns these into `tool` items `mcp__parley__<tool>` with the result.
- **[S] Qwen Code, tool route.**
  - Parley sessions run with tool search off, so the model calls `mcp__parley__<tool>` directly (mock lab `mcpdirect`, `apply-qwen.ts:80-85`).
  - The `tool_result` record closes the call with `functionResponse.response.output`.
  - **[N]** Not seen with a real Qwen model calling `check_inbox` or `wait_for`.
- **[S] Seeding.** On window reopen with a live feed the host serves its ring. On host restart or eviction it seeds the ring
  from the transcript or rollout (`feed-service.ts` `seedClaude`, `seedCodex`, `seedQwen`). Live Claude feed comes from
  hooks only: the transcript tail feeds only retries and interrupts.
- **[S] Existing cold/live race (all item kinds).** After a host restart the Claude ring is empty.
  - The first hook of a running session sets `feed.live` (`feed-service.ts:833-834`).
  - A live feed is never seeded from the transcript (`:939-941`, `:1524`, `:1940`).
  - The Chat of a session that fired a hook before its first snapshot shows only what came after the restart: prompts,
    replies and tools as well as letters. This predates this work. It is backlog b-041 and decision D7 (critique finding 2).
- **[S] Child feeds.** `agentSnapshot` reads subagent transcripts through the same transcript reader, whose tool items have
  no `agentId` (`from-transcript.ts:215`, `feed-service.ts:1582-1596`). An `agentId` check alone does not tell a child feed
  apart (critique finding 5).
- **[S] Item order.** `FeedDraft.put` replaces an existing item in place and appends a new one (`reduce.ts:312-319`). The
  window store applies deltas the same way (`desktop/src/renderer/chat/store.ts:103-113`).

### 2.3 Clients

- **[S] No runtime validation.** `feedItem` (`protocol/src/feed.ts`) is used only in tests. Desktop and phone take feed items as they come.
- **[S] Unknown kinds in the desktop.** `FeedList` `ItemView` renders nothing for an unknown kind. `turn-fold.ts:117-127`
  treats it as hidden work and folds it into a group whose title falls back to "Retried requests" when the run has no tool,
  agent or text (`turn-fold.ts:67-68`).
- **[S] Unknown kinds on the phone.** Same as the desktop (`mobile/src/feed/fold.ts:55, 96-97`, `FeedViews.tsx`).
- **[S] Feature switch.**
  - The host already sends some feed events by client feature: `feed.resync` goes only to clients with `feed-resync` in
    `hello.features` (`feed-service.ts:671`).
  - `feed.snapshot` has no client today: `methods/feed.ts:26` passes only `ref`, `agentId` and `scope`.
  - The phone reaches the feed through `packages/remote`, whose host hello does not announce new features (`remote/src/host-link.ts:335`).

## 3. Design (Part M)

### 3.1 One new feed item: `mail`

A `mail` item stands for one delivery: one page of letters handed to this session at one moment.

```ts
interface FeedMailLetter {
  id: string;                    // m-…
  from: string;                  // session id, 'human', 'system' or 'parley'
  fromLabel: string | null;      // label at delivery time, as the agent saw it
  kind: 'note' | 'question' | 'decision';
  room: { id: string; title: string } | null;
  at: string;                    // when the letter was sent
  text: string;                  // up to FEED_MAIL_TEXT_LIMIT
  cut?: true;                    // shortened by delivery (page hint) or by the feed limit
}
interface FeedMail {
  id: string;                    // `mail:<first letter id>`
  at: string;                    // delivery time, see below
  kind: 'mail';
  via: 'pointer' | 'check_inbox' | 'wait_for';
  toolUseId: string | null;      // the tool call it came from; null for 'pointer'
  letters: FeedMailLetter[];     // 1..50
  remaining?: number;            // unread letters left after this page
}
```

- **Id.** A letter is marked read for a session exactly once, so `mail:<first letter id>` is unique in that session's feed.
  Every path for one delivery makes the same id, so they never double.
- **Delivery time `at`.**
  - Inline: the host's answer time, taken once and stored in the mail journal (§3.2a). The live path and every seed use that
    stored value; an attachment record only places the item.
  - Tool route: the time of the record or hook that finished the tool.
  - Live/seed equality for the tool route covers `id`, `via`, `toolUseId`, `letters` and `remaining`. `at` may differ by the
    clock of its source: hook receipt time against record timestamp (critique finding 3).
- **Limit.** `FEED_MAIL_TEXT_LIMIT` = 16 Ki chars per letter, the same as `FEED_INPUT_LIMIT`. A page is at most 32 KiB anyway.
- **Kept and dropped fields.** The item keeps only what the human reads. `replyTo`, `via`, `toEveryone`, `roomTask` and
  `assignment` are dropped. **[D6]**

### 3.2 Sources

**(a) Inline, Claude family: a mail journal owned by Parley, placed by the transcript.**
- **Journal.** Just before it answers the hook with the letters, the host appends `{at, text}` to a per-session mail journal
  in the work's folder: `mail/<session>.jsonl`, a new directory beside `events/`.
  - `text` is the exact `additionalContext`, at most 9000 chars.
  - The `ParleyInlineMail` line in `events/` keeps its form; metrics are unchanged.
  - A failed journal write is logged and does not block the answer, as today (D8).
  - The file is small, and the seed reads it whole. It is never mixed into the large `events/` journal.
- **Live.** Claude's live feed does not read the transcript, so after answering, the host puts the item into the session's
  feed through the core parser `mailFromInline(text, at)`. It does so only after it answered the hook with the letters: not
  late, not abandoned. The feed handles the pointer prompt synchronously first, so the item lands after the pointer prompt.
- **Seed.** `seedClaude` builds the feed from the transcript, then reconciles it with the mail journal:
  - a transcript `attachment` record (`hook_additional_context`, `hookEvent: UserPromptSubmit`, content starting with
    `INLINE_MAIL_LINE`) marks the place: the item goes there, with content and `at` from the matching journal line (same
    `mail:` id), or parsed from the attachment when the journal line is missing (a delivery from before this change);
  - every journal delivery that has no attachment (Claude Code dropped it, or an older CLI never wrote it) is inserted after
    the last pointer `prompt` item whose `at` is not later than the journal `at`; with no such prompt, it goes in time order.
- **Result.** The inline letters survive a restart even when the CLI keeps no trace of them (critique finding 1).

**(b) Tool results, every family: the provider's own file.**
- **Rule.** When a top-level `tool` item finishes `done`, a `mail` item is put if:
  - the tool is named `mcp__parley__check_inbox`, or `mcp__parley__wait_for` with `input.target === 'inbox'`;
  - its response parses as an object with a non-empty `messages` array.
- **Parsing.** One core function unwraps the known response shapes (raw JSON text, MCP `{content:[{type:'text', text}]}`, an
  array of text parts) and validates every letter field. On anything else it returns no item and the tool row stays as today.
- **Placement: completion order.** The item is appended when the tool finishes, after whatever the feed holds at that
  moment. With two tools running, `wait_for` A, then B, then A finishing gives A, B, mail-A. Live hooks, the Claude
  transcript, the Codex rollout and the Qwen transcript all produce that same order, because each of them finishes A at the
  same point in its stream (critique finding 3).
- **Families.**
  - Claude: transcript and live `PostToolUse`.
  - Codex: `McpToolCall`, which covers `exec` scripts, and the Codex hook path.
  - Qwen: `tool_result`.

  All of them reach `finishTool` (`reduce.ts:802`, `from-transcript.ts:159`, `apply-codex.ts:235`,
  `apply-codex-hook.ts:73`, `apply-qwen.ts:108`). The parser is called there, in core, so every client sees the same item.
- **Not covered: subagents.**
  - Live nested tools (`agentId` set, `reduce.ts:795`) make no item.
  - Child feeds built for `agentSnapshot` (Claude subagent transcripts, Codex child rollouts) are read with mail off: the
    transcript and rollout readers take an explicit root/child context, and child snapshots pass "child" (critique finding 5).
- **`read_room` and `get_map`.** They also return `messages`, but they do not deliver or mark read. They never make a `mail` item.

**Rejected alternative: the read marks table.** `message_reads` (seq, reader, at) is durable and provider-neutral, but:
- it holds reads that were not deliveries (§2.1, last bullet);
- it does not say how a letter arrived, or what text the agent saw;
- placing letters among turns by time alone would be approximate.

### 3.3 Only in the recipient's Chat

A `mail` item comes only from the recipient session's own mail journal, transcript, rollout or hook. No other session's
Chat, room feed or window view gets it. A room broadcast shows in each member's Chat when that member takes it, with that
member's delivery time.

### 3.4 Desktop Chat

- **New `MailItem`.**
  - One bordered block per delivery, with one entry per letter.
  - **Entry header:** sender, kind badge (note / question / decision), room as `r-28 · <title>` when present, local time
    (the same formatter as other Chat timestamps).
  - **Sender:** `S-320 КВЕН-реал` (`sessionRowLabel(from, fromLabel)`), `you` for `human`, the system label for `system`, `Parley` for `parley`.
  - **Body:** the text, folded to 6 lines with "Show more" / "Show less" **[D3]**, and a "cut" mark when `cut`.
  - **Footer:** "N more unread" when `remaining > 0`.
- **Pointer.** The pointer prompt stays as it is today.
- **Fold.** `turn-fold.ts` treats `mail` as always visible in both fold modes, like `notice`. It never joins a work group, so
  letters stay visible in a folded turn **[D1]**. The `tool` row of `check_inbox` / `wait_for` stays where it is, folded as today.
- **Find.** The Chat find bar (`find.ts`) searches letter text and sender.
- **Strings.** Strings go in `shared/strings.ts`, next to `chat.letter`.

### 3.5 Phone and older clients

- **Gated per client at the request boundary.** `mail` items reach only clients whose `hello.features` holds the new
  `FEED_MAIL_FEATURE = 'feed-mail'` (critique finding 4):
  - **`feed.snapshot`.** `methods/feed.ts` passes `request.client` to the feed service, which filters the snapshot it returns.
    This also covers a first snapshot taken before subscribing.
  - **`feed.changed`.** The `upsert` and the `removed` ids that start with `mail:` are filtered per subscriber.
  - **Mail-only deltas.** A delta that carried only mail is still sent with an empty `upsert`, so `revision` stays continuous for every client.
  - **Shared state.** The ring, revisions and items are shared and unchanged.
- **Why the gate:** without it, an older desktop or phone would fold an unknown item into a misleading "Retried requests" group (§2.3).
- **Who sees what.**
  - Older desktop windows: no feature, so their Chat is unchanged.
  - New desktop on an older host: no `mail` items are made, so the Chat is unchanged.
  - The phone: `packages/remote` does not announce the feature (`host-link.ts:335`), so the phone feed is unchanged in this
    version **[D2]**. A new and an old client on one feed each get their own view.
- **Schema version.** `FEED_SCHEMA_VERSION` goes from 3 to 4, and the `feedItem` schema gains the strict `mail` object.

### 3.6 What does not change

- Delivery and pointer text, `isPointerText` and the renderer's pointer regexes, `takeInbox` and its marks.
- The `ParleyInlineMail` line and the metrics that count it.
- The pending-letters queue in Chat (gray "Not picked up yet" letters): it shows letters before delivery, and the new item shows them after.
- Room feed, window mail, `mail.markRead`.
- The existing cold/live race (§2.2): D7 (a).

### 3.7 Risks

- **A context the agent never saw.** The host answers the hook in time, but Claude Code drops or delays the context. The
  item then shows letters the model did not see. The letters were marked read either way, so the item tells the truth about
  Parley's side. It is listed under "Not verified".
- **A failed journal write (D8, accepted).** A failed write of the mail journal (for example a full disk) is logged, and the
  letters still reach the agent. Such a delivery survives a restart only if Claude Code wrote its attachment.
- **Placement without an attachment.** A journal-only delivery is placed after the last pointer prompt at or before its
  time. Clocks are the same machine's. If the transcript record of the pointer is written after the host's answer, the item
  can land one prompt early. A fixture checks the normal order; the rest is **[N]**.
- **Truncated responses.** A tool response cut at 64 Ki chars fails to parse, so no item is made and the tool row stays. A
  32 KiB page wrapped and escaped by Codex stays under 64 Ki chars **[S]**, but this is not measured.
- **Ring budget.** Mail items count against the ring's `maxItems` and `maxBytes` like any item. At most about 32 KiB per delivery.
- **Mail journal growth.** At most 9000 chars per inline delivery, per session. It is removed with the work folder.
  Not measured over a long run.
- **Restart race.** Until b-041 is fixed, a Claude session that fires a hook after a restart and before its Chat is opened
  loses its earlier Chat history, letters included (D7).

## 4. Acceptance (Part M)

Per family, on the real app, built from this branch:

1. **claude, inline.** A Claude Code session idle at the prompt gets a direct letter and a room letter. Its Chat shows the
   pointer prompt and then a mail block with both letters (sender, kind, room, time, text).
2. **claude, tool.** A Claude Code session that calls `check_inbox`, and one that waits with `wait_for("inbox")`, both show the
   mail block when the tool finishes.
3. **codex.** A real Codex session reads a letter through `check_inbox` in an `exec` script, and another letter through
   `wait_for("inbox")` in an `exec` script. Its Chat shows both mail blocks. A screenshot is required.
4. **qwen.** A Qwen Code session reads one letter through `check_inbox` and one through `wait_for("inbox")`, and both mail
   blocks show, also after reopen and restart. `qwen` is now signed in, so this is checked live.
5. **Reopen and restart.**
   - After closing and reopening the Chat, the same mail blocks show in the same places, for 1–3.
   - After Restart Host, the same holds when the Chat is opened before the session's next hook (D7).
   - A unit test removes the attachment from a transcript: after a reseed the inline block is still there, rebuilt from the mail journal.
6. **Only the recipient.** The sender's Chat and a third member's Chat show no mail block for that letter.
7. **Old clients.** Unit tests cover:
   - a client without `feed-mail` gets no `mail` in an unsubscribed snapshot, a subscribed snapshot or a delta;
   - an old and a new client on one feed each see their own view;
   - a mail-only delta keeps `revision` continuous for the old client;
   - the remote bridge's hello lacks the feature.

   The phone build is unchanged.
8. **Long text.** A letter over 6 lines is folded with "Show more". A cut letter shows the cut mark.
9. **Order.** A fixture with two overlapping tools gives the same completion order (A, B, mail-A) live and seeded.

Unit tests also cover:
- the parser on fixtures of every source shape, for both Qwen tools;
- id stability between the live and seeded paths;
- the child feed exclusion, through the real `agentSnapshot` entry points;
- the `read_room` exclusion;
- the fold rule.

## 5. Impact (expected; measured at the end)

- **Goal:**
  - see in a session's Chat which letters it got and from whom;
  - start Qwen in auto-accept;
  - pick a Qwen model from the account's real list.
- **Behaviour:**
  - a mail block after every delivery, for every provider family; the pointer stays;
  - Qwen sessions start in `auto`;
  - the Qwen model picker lists the account's models.
- **Numbers:** not measured yet. To measure:
  - Chat bytes per delivery and mail journal bytes per inline delivery;
  - feed seed time on a long transcript, before and after;
  - Qwen catalog probe time.
- **Screens:** Claude inline, Codex `exec`, Qwen mail, the Qwen mode at start, the Qwen model picker, reopen.
- **Risk:** §3.7, §8.6, §9.3.
- **Cost:** about 7 executor tasks and 1 review.

## 6. Decisions already taken

- New `mail` feed item. The tool route reads the provider's own file. The inline route uses a Parley mail journal, placed
  by the transcript attachment when there is one. The read marks table is not used.
- Gated by `feed-mail` per client, at the request boundary (§3.5).
- Mail appears in completion order (§3.2b).
- One branch, no push.
- Documents are written by the lead and copied into `docs/` by a junior executor (s-320, m-7927).
- Part M accepted as p-48 with D1–D8 as in §7 (m-7946).

## 7. Part M decisions (accepted by the human, p-48)

- **D1.** The mail block is always visible, in a separate row.
- **D2.** The phone is unchanged in this version.
- **D3.** Long text is folded to 6 lines with "Show more".
- **D4.** Qwen is covered by fixtures if it is not signed in. It now is, so it is also checked live.
- **D5.** Every delivered letter is shown, including `system` and `parley` letters.
- **D6.** No `roomTask` / `assignment` in the block.
- **D7.** The existing restart race stays out of this work (b-041).
- **D8.** A failed mail journal write is non-fatal; the letters still reach the agent.

## 8. Part Q — Qwen Code models

### 8.1 State on this machine (2026-11-12)

- `qwen` 0.27.2 is installed by the human at `~/.local/bin/qwen` (standalone, `~/.local/lib/qwen-code`, darwin-arm64).
- The human signed in on 2026-11-12 with "Qwen Account with Subscription".
- Never read: `oauth_creds.json`, `subscription_credentials.json`, any key.
- `settings.json` can hold secrets (§8.2), so only single named fields are read from it, by field extraction. It is never printed or copied.

### 8.2 Facts without a login (from revision 2)

- **[S] `qwen-oauth`, the legacy free route.** Its list is hard-coded: `QWEN_OAUTH_MODELS = [{id: "coder-model", …}]`.
- **[S] `qwen-subscription`, Plus or Pro.**
  - The default is `qwen3.8-max`, and the base URL is `https://api.qwen.ai/compatible-mode/v1`.
  - The CLI fetches `GET {base}/models` with the account token and caches the list **inside `subscription_credentials.json`**. Parley must not read it.
- **[S] `model-registry.json`** is a models.dev metadata cache, not the account's list.
- **[S] `modelProviders`** in `settings.json` lists API-key providers only.
- **[S] `settings.json` can hold secrets.** The bundled docs say `env` there is plain text and name `security.auth.apiKey` (`auth.md:377`, `model-providers.md:192`).
- **[S] `GET /v1/models`** needs the token, so it is out for Parley.
- **[O] ACP `session/new` unsigned** fails with -32000 "Authentication required". With a dummy runtime model it returns
  `models: {currentModelId, availableModels: [{modelId, name, description, _meta: {contextLimit, authType, baseModelId, isRuntime}}]}`.

### 8.3 Facts signed in (2026-11-12, lead s-345)

1. **[O] Route.** `security.auth.selectedType` = `qwen-subscription`, `model.name` = `qwen3.8-max`. `settings.json` has the top-level keys `$version`, `model`, `permissions` (only `allow`), `security` and `ui`, and no `modelProviders`.
2. **[O] ACP `session/new`.**
   - `qwen --acp`, `initialize` and then `session/new {cwd: <empty scratch dir>, mcpServers: []}` answered within 1 s of the request (3.9 s after process start, including a fixed 3 s wait of the probe client).
   - `models.currentModelId` = `qwen3.8-max(qwen-subscription)`.
   - `availableModels`, in this order:
     - `qwen4.0-max-preview(qwen-subscription)`;
     - `qwen3.8-max(qwen-subscription)`;
     - `qwen3.8-flash(qwen-subscription)`.
   - Each model has `name` = the base id, `description: null`, and `_meta` = `{contextLimit: 1000000, authType: "qwen-subscription", baseModelId, modalities: {image: true, video: true}, baseUrl: "https://api.qwen.ai/compatible-mode/v1", isRuntime: false}`.
3. **[O] `configOptions` of `session/new`:**
   - `mode`: `plan`, `default`, `auto-edit`, `auto`, `yolo`; current `auto` in ACP;
   - `model`: the same three;
   - `workflow_mode`: off, and unavailable;
   - `reasoning_effort` for the current model: `none`, `low`, `medium` and `xhigh`, default `medium`, category `thought_level`.
4. **[O] No session left behind.** The ACP probe left no chat file under `~/.qwen/projects/`; only the prompt run in item 5 wrote one.
5. **[O] The bare base id works for `-m`.**
   - `qwen -p "Reply with exactly the word OK and nothing else." -m qwen3.8-flash --approval-mode plan --output-format json` gave `system/init` `model: "qwen3.8-flash"` and `result` "OK" in 3.3 s.
   - Usage: 13,945 input tokens and 23 output tokens.
   - The wall time was 13 s, including CLI start.
6. **[O] Real transcript records (0.27.2).**
   - The assistant record has `parts` `[thought, text]`, and `usageMetadata` has `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount` and `cachedContentTokenCount`.
   - `system` records have the subtypes `attribution_snapshot`, `memory_catalog_snapshot` and `ui_telemetry`.
   - This is the shape of the mock fixtures the Qwen feed parser was built on.
7. **[O] `model-registry.json`** holds 294 models from many vendors (keys `source`, `fetchedAt`, `projection`, `models`, `etag`). This confirms it is not the account's list.
8. **[S] Parley today.** The runner passes `-m {model}` on start and resume (`core/src/providers.ts:471-509`). The provider has `models: null` and `effort: false`. The CLI has no effort flag (`qwen --help`).

### 8.4 Design (Q2): a model catalog from the CLI, like Codex

- **Probe.** A host module `qwen-catalog.ts`, after `codex-catalog.ts`.
  - It runs the human's `qwen` (PATH or `PARLEY_QWEN_BIN`) as `qwen --acp` under the human's own home.
  - It sends `initialize`, then `session/new` with `cwd` = an empty Parley-owned temp directory and `mcpServers: []`.
  - It reads `models.availableModels`. It never sends a prompt.
  - Timeout 15 s; output cap 1 MiB.
  - The probe does not load Parley's per-session system settings file.
- **Process lifetime** (critique B1).
  - The CLI is spawned detached, as the leader of its own process group, with piped stdio.
  - After the answer, a timeout, an error or the output cap, Parley ends stdin, sends SIGTERM to the whole group, and then SIGKILL to the group after 2 s if any member is alive.
  - Parley awaits the exit and destroys the pipes in a `finally`.
  - The temp `cwd` is removed afterwards. A child that inherits stdout cannot keep the probe waiting past the timeout.
- **Secret boundary** (critique B2).
  - Parley's code never opens, reads, copies or passes any Qwen credential file or key: not as an argument, not in the environment.
  - The CLI reads its own auth state, as it does in every Qwen session the human starts. That read is the CLI's and is expected.
  - The guarantee covers Parley's side only, and its tests check Parley's own file operations and spawn arguments.
- **When, and only one at a time** (critique B3).
  - **Triggers:**
    - at host start, if `qwen` is installed;
    - in the background, when `providers.list` finds the catalog older than 6 h;
    - right after a Qwen sign-in from Settings ends (`providers.signInExit`).
  - **One probe at a time.** At most one probe runs, held as a shared in-flight promise; a trigger during a probe joins it.
  - **No waiting.** `providers.list` and the New session dialog never wait for a probe. They answer at once with the stored list, or `models: null` when there is none.
- **Store.** A successful probe whose list differs from the stored one rewrites `qwen-models.json` in the Parley home atomically and calls `onChange`. `loadProviders` reads it, so the window, the host and the agents' MCP server see one list.
- **Failure keeps the old list.** A failed probe (not signed in, timeout, bad output) leaves the file alone. With no file, `models: null` stays (Default or a typed id), as today.
- **Mapping.**
  - Only entries with `_meta.isRuntime === false` are used.
  - `ModelOption.id` = `_meta.baseModelId`, the bare id observed to work with `-m`, so no new flag form is needed. `label` = `name`.
  - Order as in ACP.
  - `efforts: null` in v1 (DQ2). "Default" stays the absence of `-m`, so the CLI uses `model.name` from its settings.
- **Preview models** (`qwen4.0-max-preview`) are listed as the CLI lists them (DQ3).

### 8.5 Q1: live verification still owed (after the code lands)

- One short real Qwen session from Parley: `qwen3.8-flash`, a tiny prompt. It checks:
  - Chat thought and text;
  - usage;
  - resume after closing;
  - mail (Part M, item 4);
  - the mode at start (Part A);
  - the picker (Part Q).
- The probe is also run once for real: no process left (`ps`), no chat file left, and its time recorded.
- The quota error is never provoked; it is recorded only if it happens.
- The OAuth flow inside Parley's Settings sign-in and the `auth_success` hook are checked only if the human signs in again from Settings. Otherwise they stay "Not verified".

### 8.6 Risks (Part Q)

- **ACP is a second surface of the CLI.** Its `session/new` shape may change between versions. The probe validates the shape and falls back to the stored list.
- **The probe costs a CLI start, about 2–4 s,** at most every 6 h. No model tokens: ACP `session/new` sends no prompt (§8.3 items 2 and 4).
- **A preview model may vanish.** A session started with a vanished id fails the way a typed wrong id fails today.

## 9. Part A — Qwen Code starts in auto-accept

### 9.1 Facts

- **[S]** `core/src/work/launch.ts:538`: `subs.approvalMode = workspace ? 'auto' : 'default'`.
  - `workspace` is `session.workspace`, the autonomous-room confinement.
  - `launch.ts:303` refuses `workspace` for every provider but Codex and Claude.
  - So an ordinary Qwen session always gets `--approval-mode default`, new and resumed: the `{approvalMode}` slot of `args` and `resumeArgs`, `providers.ts:487-505`.
- **[O, s-320]** The human's live Qwen process ran with `--approval-mode default`, and its transcript records `approvalMode "default"`.
- **[O]** Qwen 0.27.2 modes are `plan`, `default`, `auto-edit`, `auto` ("LLM classifier auto-approves safe actions, blocks risky ones") and `yolo` (`qwen --help`, ACP `configOptions`).
- **Accepted decision D6 of the Qwen provider work** reads "auto in workspace sessions". It was meant as Parley's sessions, and was implemented as autonomous workspaces only. This is a defect against that decision.

### 9.2 Design

- **Ordinary sessions.** Ordinary Parley Qwen sessions start with `--approval-mode auto`, new and resumed (DA1).
- **Never `yolo`.**
- **Read-only roles** are still refused, as today.
- **Autonomous workspaces** keep `auto`.
- **No persisted mode** (critique B4). Parley does not store a mode chosen inside the TUI. Such a choice lasts for that TUI run only. Every launch and every resume starts in `auto` by design.

### 9.3 Risks

- **The classifier.** `auto` lets the CLI's own classifier approve actions it judges safe. That is the human's request; `default` stays reachable inside the TUI.
- **Resume.** A resume also switches a session the human had kept in `default` back to `auto`. This is stated to the human in the proposal.

### 9.4 Acceptance (Parts A and Q)

1. A new and a resumed Qwen session launch with `--approval-mode auto`. There are unit tests on the launch arguments, and the TUI shows the auto mode at start (a screenshot). A mode switched inside the TUI is back to `auto` after a resume.
2. The New session dialog for Qwen lists the account's models in ACP order, plus "Default". A session started with `qwen3.8-flash` runs that model (transcript `model`).
3. Signed out or probe failure: the stored list stays. With no stored list: "Default" or a typed id, as today. This is covered by unit tests with a fake ACP process.
4. **Process cleanup.** A unit test uses a fake CLI that forks a child holding stdout open. The probe still ends within its timeout plus 2 s, and no member of the group is left.
5. **One probe at a time.** Concurrent triggers start one probe, and `providers.list` answers at once during a probe (unit tests).
6. **Secret boundary.** Unit tests check that Parley's probe code opens no file except its own temp directory and `qwen-models.json`, and that it passes no credential path or key in arguments or environment. The real probe in V1 leaves no process and no chat file.

### 9.5 Open choices (Parts A and Q)

- **DA1. Mode at start.** `auto`, the classifier approving safe actions (recommended, s-320's default), or `auto-edit`, approving edits only.
- **DQ1. Catalog refresh.** At host start, every 6 h and after a sign-in (recommended), or only when the New session dialog opens.
- **DQ2. Effort.** No effort choice for Qwen in v1 (recommended: the CLI has no effort flag; ACP shows `reasoning_effort` per model), or a follow-up through Qwen settings.
- **DQ3. Preview models.** List them as the CLI does (recommended), or hide ids that contain `preview`.

## Appendix A. Critique of revision 1 (s-348) and answers

1. **Blocker, inline durability.** A Parley-owned mail journal holds every inline delivery; the attachment only places it.
   A unit test reseeds without the attachment (§3.2a, §4.5).
2. **Major, cold/live race.** Confirmed in the source. It predates this work and covers every item kind: backlog b-041, and
   decision D7. Restart acceptance is defined around it (§2.2, §4.5).
3. **Major, order and time.** Completion order is the stated rule. Inline `at` is stored once. Tool-route equality excludes
   `at`. An overlapping-tools fixture checks the order (§3.1, §3.2b, §4.9).
4. **Major, snapshot gate.** `methods/feed.ts` passes the client, and the filter runs per request and per subscriber.
   Mail-only deltas stay as empty deltas. Old, new and remote clients are tested (§3.5, §4.7).
5. **Major, child feeds.** The transcript and rollout readers take an explicit root/child context, and child snapshots read
   with mail off. Tested through the real `agentSnapshot` entry points (§3.2b).
6. **Minor, Qwen coverage.** Both tools, reopen and restart are required. Fixtures cover both tools and the reseed (§4.4).
7. **Minor, `settings.json`.** It is marked as possibly holding secrets; only named single fields are read (§8.2, §8.3).

## Appendix B. Critique of revision 3, Parts A and Q (s-348) and answers

1. **Major, probe shutdown.** A detached owned process group; stdin ended; SIGTERM, then SIGKILL to the group after 2 s;
   exit awaited and pipes destroyed in `finally`. Tested with a fake CLI whose child holds stdout open (§8.4, §9.4.4).
2. **Major, secret boundary.** The guarantee is restated as Parley's side only. The CLI's own auth reads are expected. Tests
   check Parley's file operations, arguments and environment (§8.4, §9.4.6).
3. **Minor, concurrent refresh.** One shared in-flight probe; `providers.list` never waits and returns the stored list or
   `null` (§8.4, §9.4.5).
4. **Minor, mode persistence.** No persisted mode: a TUI choice lasts for that run, and every launch and resume starts in
   `auto` by design (§9.2, §9.4.1).
