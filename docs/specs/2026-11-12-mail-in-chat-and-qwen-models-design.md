# Delivered mail in Chat, and Qwen Code models: design

Status: revision 2, waiting for the human's decision. No application code before the human accepts.
- Revision 1 (7fb04655) was critiqued by s-348 (Codex gpt-6-astra, verdict "revise": 1 blocker, 4 major, 2 minor). This revision answers every finding; the mapping is in appendix A.
- Lead s-345, owner s-320, room r-28 (2026-11-12).
- Plan: `docs/plans/2026-11-12-mail-in-chat-and-qwen-models-plan.md`.
- Branch: `parley/w-0054/s-345`, fast-forwarded to `origin/master` f5c32ebb (0.34.0). Both parts land here. No push and no PR until the human says so.

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

**Part Q.** Qwen Code with a live account (s-320, m-7925):
- **Q2** (the model catalog) starts now from what the installed CLI shows without a login;
- **Q1** (live verification) waits for the human's `/auth`.

The facts so far are in §8.

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
  - **[N]** The exact `response.text` shape for MCP results (raw JSON or a content-array wrapper) is not recorded yet; M1 records it.
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
  - A failed journal write is logged and does not block the answer, as today.
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
- The existing cold/live race (§2.2), unless the human picks D7 (b).

### 3.7 Risks

- **A context the agent never saw.** The host answers the hook in time, but Claude Code drops or delays the context. The
  item then shows letters the model did not see. The letters were marked read either way, so the item tells the truth about
  Parley's side. It is listed under "Not verified".
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
   blocks show, also after reopen and restart. This needs a signed-in `qwen` **[D4]**. Without it, fixture tests cover both
   tools and the reseed.
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

- **Goal:** see in a session's Chat which letters it got and from whom.
- **Behaviour:** a mail block after every delivery, for every provider family; the pointer stays.
- **Numbers:** not measured yet. To measure: Chat bytes per delivery, mail journal bytes per inline delivery, and feed seed
  time on a long transcript before and after.
- **Screens:** Claude inline, Codex `exec`, Qwen (if signed in), reopen.
- **Risk:** §3.7.
- **Cost:** about 5 executor tasks and 1 review.

## 6. Decisions already taken

- New `mail` feed item. The tool route reads the provider's own file. The inline route uses a Parley mail journal, placed
  by the transcript attachment when there is one. The read marks table is not used.
- Gated by `feed-mail` per client, at the request boundary (§3.5).
- Mail appears in completion order (§3.2b).
- One branch, no push.
- Documents are written by the lead and copied into `docs/` by a junior executor (s-320, m-7927).

## 7. Open choices for the human

- **D1. Placement.** A separate always-visible block (recommended), or letters only inside the expanded tool row.
- **D2. Phone.** Unchanged in this version (recommended: smaller; phone builds are verified separately), or render `mail` on the phone too (+1 task, phone build and screenshot).
- **D3. Long text.** Fold to 6 lines with "Show more" (recommended), or always show in full.
- **D4. Qwen verification.** If `qwen` is not signed in when Part M is verified, Qwen is covered by fixture tests and goes to "Not verified" (recommended: the route is the same tool path as Codex and Claude), or Part M waits for the login.
- **D5. Which letters.** Show every delivered letter, including `system` (reports, invitations) and `parley` letters (recommended: that is what the agent saw), or only letters from sessions and the human.
- **D6. Plan assignment details.** Drop `roomTask` and `assignment` from the block (recommended: keep it small), or show them as a one-line badge.
- **D7. The existing restart race (§2.2, b-041).**
  - (a) Out of this work, recommended. Letters are exactly as durable as the rest of the Chat. Restart is verified with the
    Chat opened before the next hook, and the race stays in the backlog.
  - (b) Fix it in this branch, as an extra senior-only task (concurrency in the feed service), before V1.

## 8. Part Q — Qwen Code models

### 8.1 State on this machine (2026-11-12)

- `qwen` 0.27.2 is installed by the human at `~/.local/bin/qwen` (standalone, `~/.local/lib/qwen-code`, darwin-arm64).
- Not signed in: `~/.qwen` does not exist and `QWEN_HOME` is unset.
- The probes below ran with a scratch `HOME` and `QWEN_HOME` in the lead's scratchpad: the human's home was neither created nor changed.
- Never read: `oauth_creds.json`, `subscription_credentials.json`, any key.

### 8.2 Facts without a login

**Two account routes.** `/auth` offers "Qwen Account with Subscription" (chat.qwen.ai Plus or Pro), QwenCloud, and Alibaba
ModelStudio (Coding Plan, Token Plan, Standard API key). Inside the CLI the account routes are two auth types:
- **[S] `qwen-oauth`, the legacy free route.** Its list is hard-coded: `QWEN_OAUTH_MODELS = [{id: "coder-model", …}]`. The bundled docs say it "cannot be overridden".
- **[S] `qwen-subscription`, Plus or Pro.**
  - The default model is `QWEN_SUBSCRIPTION_MODEL = "qwen3.8-max"`, and the base URL is `https://api.qwen.ai/compatible-mode/v1`.
  - The list is dynamic: the CLI calls `GET {base}/models` with the subscription bearer token. It keeps `id`, `input_modalities` and `context_window_tokens`.
  - It caches the result as `models` / `modelMetadata` **inside `subscription_credentials.json`**, the secret file. Parley must not read it.

**Where each catalog source stands.**
- **[S] `model-registry.json`** (`~/.qwen/model-registry.json`) is a models.dev metadata cache: capabilities and limits for many models, refreshed daily, with a bundled snapshot. It is not the list of models the account may use. At most it can enrich metadata such as the context window.
- **[S] `modelProviders`** in `settings.json` lists API-key providers (`openai`, `anthropic`, `gemini`, `vertex-ai` or custom ids) as `ModelConfig[]` (`id`, `name`, `description`, `baseUrl`, `envKey`, `generationConfig`). It does not hold the subscription models: the docs say "use /model to choose from the models available with your subscription".
- **[S] `settings.json` can hold secrets.** The bundled docs say `env` there is stored in plain text and name `security.auth.apiKey` (`auth.md:377`, `model-providers.md:192`). Parley and its sessions read only single named fields from it, with a field extraction. They never print, copy or attach the file (critique finding 7).
- **[S] `GET /v1/models`** needs the account token, so it is out for Parley: reading the token means reading a secret file.
- **[O] ACP `session/new`.**
  - Unsigned, `qwen --acp` answers `initialize` (agentInfo `qwen-code` 0.27.2; `loadSession`; `sessionCapabilities.list` and `resume`). `session/new` then fails with -32000 "Authentication required: Use /auth to sign in or configure a model first."
  - With a dummy OpenAI-compatible runtime model (fake key, unreachable base URL, no network call) `session/new` returns `models`: `{currentModelId: "$runtime|openai|probe-model(openai)", availableModels: [{modelId, name, description, _meta: {contextLimit, authType, baseModelId, isRuntime}}]}`. The result also carries `modes` and `configOptions`.
  - The source builds `availableModels` from the CLI's own model registry (`acpAgent` `buildModelsData`), so it would include subscription models once signed in **[N]**.

### 8.3 What needs the signed-in account (Q1 and the rest of Q2)

1. Which route the human's subscription uses, read as the single field `security.auth.selectedType` of `settings.json`.
2. ACP `session/new` `availableModels` signed in: the real `modelId` strings and their format (for example `qwen3.8-max(qwen-subscription)`), `name`, `_meta.contextLimit` and `modalities`, and `currentModelId`.
3. Whether the id that `session/new` returns is what `qwen --model <id>` accepts in a pty session (Parley launches `qwen` in a pty, not through ACP).
4. How long `session/new` takes signed in (it may call `GET /models`) and what it does offline (the cached list).
5. s-322's "Not verified" list: real model records (thinking, usage), the OAuth flow end to end, `auth_success` with OAuth, a real quota error, resume of a real session, real model ids.

### 8.4 Direction (to be designed after 8.3)

The likely catalog source is a short-lived `qwen --acp` probe that runs `initialize` and `session/new`, reads
`models.availableModels`, and stops before any prompt. It runs in the same home as Parley's Qwen sessions and never touches
credential files. `model-registry.json` may enrich the metadata. The design is written only once 8.3 items 1–4 are observed.

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
