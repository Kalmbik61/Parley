# Delivered mail in Chat, and Qwen Code models: design

Status: revision 1, draft for critique. No application code before the human accepts.
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
  read with `letters.markRead(sessionId, page.ids, at)`.
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
- **[S] Journal line.** `ParleyInlineMail` in `events/<session>.jsonl` records only `letters` (a count). Metrics read it; it
  stays as it is.
- **[S] Other marks without delivery.** Two `markRead` calls mark letters read without handing them to the agent as letters:
  - `report` marks an older unread report letter about the same session read when a newer one replaces it (`tools.ts:969`);
  - `wait_for(<session id>)` marks the report letters about that session read when it returns that session's result (`tools.ts:1255`).

### 2.2 Where the delivered letters already live durably

- **[O] Claude Code 2.1.322, inline route.** The transcript stores the hook context as its own record. The record comes right
  after the pointer's `user` record, and its `parentUuid` is that record:

  ```json
  {"type":"attachment","timestamp":"…","attachment":{"type":"hook_additional_context","hookName":"UserPromptSubmit",
   "hookEvent":"UserPromptSubmit","toolUseID":"hook-…","content":["Parley delivered the messages announced above; … \n{\"messages\":[…]}"]}}
  ```

  - SessionStart context uses the same attachment type with other text. Only content that starts with `INLINE_MAIL_LINE` is mail.
  - Today `feedFromTranscript` drops every `attachment` record (`from-transcript.ts:271`).
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
  - **[N]** Not seen with a real Qwen model calling `check_inbox`.
- **[S] Reopen and restart already re-read these files.** On window reopen with a live feed the host serves its ring. On
  host restart or eviction it seeds the ring from the transcript or rollout (`feed-service.ts` `seedClaude`, `seedCodex`,
  `seedQwen`). Live Claude feed comes from hooks only: the transcript tail feeds only retries and interrupts.

### 2.3 Clients

- **[S] No runtime validation.** `feedItem` (`protocol/src/feed.ts`) is used only in tests. Desktop and phone take feed items as they come.
- **[S] Unknown kinds in the desktop.** `FeedList` `ItemView` renders nothing for an unknown kind. `turn-fold.ts:117-127`
  treats it as hidden work and folds it into a group whose title falls back to "Retried requests" when the run has no tool,
  agent or text (`turn-fold.ts:67-68`).
- **[S] Unknown kinds on the phone.** Same as the desktop (`mobile/src/feed/fold.ts:55, 96-97`, `FeedViews.tsx`).
- **[S] Feature switch.** The host already sends some feed events by client feature: `feed.resync` goes only to clients with
  `feed-resync` in `hello.features` (`feed-service.ts:671`). The phone reaches the feed through `packages/remote`, which
  subscribes on its behalf.

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
  at: string;                    // delivery time
  kind: 'mail';
  via: 'pointer' | 'check_inbox' | 'wait_for';
  toolUseId: string | null;      // the tool call it came from; null for 'pointer'
  letters: FeedMailLetter[];     // 1..50
  remaining?: number;            // unread letters left after this page
}
```

- **Id.** A letter is marked read for a session exactly once, so `mail:<first letter id>` is unique in that session's feed.
  The live path and the seed from a file make the same id, so they never double.
- **Limit.** `FEED_MAIL_TEXT_LIMIT` = 16 Ki chars per letter, the same as `FEED_INPUT_LIMIT`. A page is at most 32 KiB anyway.
- **Kept and dropped fields.** The item keeps only what the human reads. `replyTo`, `via`, `toEveryone`, `roomTask` and
  `assignment` are dropped. **[D6]**

### 3.2 Sources: the agent's own files, no new storage

There are two sources. Both are files the feed already reads on reopen and restart, so condition (c) holds without new storage.

**(a) Inline, Claude family.**
- **Seed.** `feedFromTranscript` turns an `attachment` record into a `mail` item with `via: 'pointer'` and `at` = the record
  timestamp. It must have `attachment.type === 'hook_additional_context'`, `hookEvent === 'UserPromptSubmit'`, and a first
  content string that starts with `INLINE_MAIL_LINE`.
- **Live.** Claude's live feed does not read the transcript, so the host adds the item itself:
  - `createInlineMail` gets a `delivered(ref, text, at)` callback;
  - it calls it only after it answered the hook with the letters (not late, not abandoned);
  - the feed service puts the item through the same core parser.
- **Order.** The feed handles the pointer prompt synchronously before the take finishes, so the item lands after the
  pointer prompt in both paths.

**(b) Tool results, every family.**
- **Rule.** When a top-level `tool` item finishes `done`, a `mail` item is put right after it if:
  - the tool is named `mcp__parley__check_inbox`, or `mcp__parley__wait_for` with `input.target === 'inbox'`;
  - its response parses as an object with a non-empty `messages` array.
- **Parsing.** One core function unwraps the known response shapes (raw JSON text, MCP `{content:[{type:'text', text}]}`, an
  array of text parts) and validates every letter field. On anything else it returns no item and the tool row stays as today.
- **Families.**
  - Claude: transcript and live `PostToolUse`.
  - Codex: `McpToolCall`, which covers `exec` scripts, and the Codex hook path.
  - Qwen: `tool_result`.

  All of them already reach `finishTool` (`reduce.ts:802`, `from-transcript.ts:159`, `apply-codex.ts:235`,
  `apply-codex-hook.ts:73`, `apply-qwen.ts:108`). The parser is called there, in core, not in the renderer, so every
  client sees the same item.
- **Not covered.** Calls inside a subagent (tool items with `agentId`) make no `mail` item: a subagent reading the parent's
  mail is not a delivery to the session's Chat.
- **`read_room` and `get_map`.** They also return `messages`, but they do not deliver or mark read. They never make a `mail` item.

**Rejected alternative: the read marks table.** `message_reads` (seq, reader, at) is durable and provider-neutral, but:
- it holds reads that were not deliveries (§2.1, last bullet);
- it does not say how a letter arrived;
- placing letters among turns by time alone would be approximate, while the transcript places them exactly where the agent saw them.

### 3.3 Only in the recipient's Chat

A `mail` item comes only from the recipient session's own transcript, rollout or hook. No other session's Chat, room feed or
window view gets it. A room broadcast shows in each member's Chat when that member takes it, with that member's delivery time.

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

- **Gated by client feature.** The host sends `mail` items only to clients whose `hello.features` holds the new
  `FEED_MAIL_FEATURE = 'feed-mail'`. The filter covers:
  - the `feed.snapshot` result;
  - `feed.changed` `upsert`;
  - `removed` ids that start with `mail:`.

  The ring and revisions are shared and unchanged; the filter only drops items on the way out.
- **Why the gate:** without it, an older desktop or phone would fold an unknown item into a misleading "Retried requests" group (§2.3).
- **Who sees what.**
  - Older desktop windows: no feature, so their Chat is unchanged.
  - New desktop on an older host: no `mail` items are made, so the Chat is unchanged.
  - The phone: `packages/remote` does not announce the feature, so the phone feed is unchanged in this version **[D2]**.
- **Schema version.** `FEED_SCHEMA_VERSION` goes from 3 to 4, and the `feedItem` schema gains the strict `mail` object.

### 3.6 What does not change

- Delivery and pointer text, `isPointerText` and the renderer's pointer regexes, `takeInbox` and its marks.
- The `ParleyInlineMail` line and the metrics that count it.
- The pending-letters queue in Chat (gray "Not picked up yet" letters): it shows letters before delivery, and the new item shows them after.
- Room feed, window mail, `mail.markRead`.

### 3.7 Risks

- **The hook context may never reach the agent.** The host answers the hook in time, but Claude Code may drop or delay the
  context. The live item then shows letters the model did not see, and after a restart the item disappears (no attachment
  record). The letters were marked read either way, so the live item tells the truth about Parley's side. Accepted; listed
  under "Not verified".
- **The attachment record's form is not a public contract.** It is read only from Claude Code 2.1.322, the version on this
  machine. Older versions down to `FEED_MIN_VERSION` 2.1.286 are **[N]**. If the record is missing, the seeded Chat lacks
  inline letters while the live Chat had them. The tool route is unaffected.
- **Truncated responses.** A tool response cut at 64 Ki chars fails to parse, so no item is made and the tool row stays. A
  32 KiB page wrapped and escaped by Codex stays under 64 Ki chars **[S]**, but this is not measured.
- **Ring budget.** Mail items count against the ring's `maxItems` and `maxBytes` like any item. At most about 32 KiB per delivery.

## 4. Acceptance (Part M)

Per family, on the real app, built from this branch:

1. **claude, inline.** A Claude Code session idle at the prompt gets a direct letter and a room letter. Its Chat shows the
   pointer prompt and then a mail block with both letters (sender, kind, room, time, text).
2. **claude, tool.** A Claude Code session that calls `check_inbox`, and one that waits with `wait_for("inbox")`, both show the
   mail block after the tool row.
3. **codex.** A real Codex session reads a letter through `check_inbox` in an `exec` script, and another letter through
   `wait_for("inbox")` in an `exec` script. Its Chat shows both mail blocks. A screenshot is required.
4. **qwen.** A Qwen Code session reads a letter through `check_inbox` or `wait_for`, and the mail block shows. This needs a
   signed-in `qwen` **[D4]**.
5. **Reopen and restart.** After closing and reopening the Chat, and after Restart Host, the same mail blocks show in the same
   places, for 1–3.
6. **Only the recipient.** The sender's Chat and a third member's Chat show no mail block for that letter.
7. **Old clients.** A client without `feed-mail` (unit test of the host filter, plus the phone build unchanged) gets no `mail` items.
8. **Long text.** A letter over 6 lines is folded with "Show more". A cut letter shows the cut mark.

Unit tests cover:
- the parser on recorded fixtures of every source shape;
- id stability between the live and seeded paths;
- the subagent exclusion;
- the `read_room` exclusion;
- the fold rule;
- the host filter.

## 5. Impact (expected; measured at the end)

- **Goal:** see in a session's Chat which letters it got and from whom.
- **Behaviour:** a mail block after every delivery, for every provider family; the pointer stays.
- **Numbers:** not measured yet. To measure: Chat bytes per delivery, and feed seed time on a long transcript before and after.
- **Screens:** Claude inline, Codex `exec`, Qwen (if signed in), reopen.
- **Risk:** §3.7.
- **Cost:** about 4 executor tasks and 1 review.

## 6. Decisions already taken

- New `mail` feed item from the agent's own files (§3.2), not the read marks table.
- Gated by `feed-mail` (§3.5).
- One branch, no push.
- Documents are written by the lead and copied into `docs/` by a junior executor (s-320, m-7927).

## 7. Open choices for the human

- **D1. Placement.** A separate always-visible block after the pointer or the tool row (recommended), or letters only inside the expanded tool row.
- **D2. Phone.** Unchanged in this version (recommended: smaller; phone builds are verified separately), or render `mail` on the phone too (+1 task, phone build and screenshot).
- **D3. Long text.** Fold to 6 lines with "Show more" (recommended), or always show in full.
- **D4. Qwen verification.** If `qwen` is not signed in when Part M is verified, Qwen is covered by fixture tests and goes to "Not verified" (recommended: the route is the same tool path as Codex and Claude), or Part M waits for the login.
- **D5. Which letters.** Show every delivered letter, including `system` (reports, invitations) and `parley` letters (recommended: that is what the agent saw), or only letters from sessions and the human.
- **D6. Plan assignment details.** Drop `roomTask` and `assignment` from the block (recommended: keep it small), or show them as a one-line badge.

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
- **[S] `modelProviders`** in `settings.json` lists API-key providers (`openai`, `anthropic`, `gemini`, `vertex-ai` or custom ids) as `ModelConfig[]` (`id`, `name`, `description`, `baseUrl`, `envKey`, `generationConfig`). Credentials are never stored there. It does not hold the subscription models: the docs say "use /model to choose from the models available with your subscription".
- **[S] `GET /v1/models`** needs the account token, so it is out for Parley: reading the token means reading a secret file.
- **[O] ACP `session/new`.**
  - Unsigned, `qwen --acp` answers `initialize` (agentInfo `qwen-code` 0.27.2; `loadSession`; `sessionCapabilities.list` and `resume`). `session/new` then fails with -32000 "Authentication required: Use /auth to sign in or configure a model first."
  - With a dummy OpenAI-compatible runtime model (fake key, unreachable base URL, no network call) `session/new` returns `models`: `{currentModelId: "$runtime|openai|probe-model(openai)", availableModels: [{modelId, name, description, _meta: {contextLimit, authType, baseModelId, isRuntime}}]}`. The result also carries `modes` and `configOptions`.
  - The source builds `availableModels` from the CLI's own model registry (`acpAgent` `buildModelsData`), so it would include subscription models once signed in **[N]**.

### 8.3 What needs the signed-in account (Q1 and the rest of Q2)

1. Which route the human's subscription uses (`qwen-subscription` or another), as seen in `settings.json` `security.auth.selectedType` (not a secret file).
2. ACP `session/new` `availableModels` signed in: the real `modelId` strings and their format (for example `qwen3.8-max(qwen-subscription)`), `name`, `_meta.contextLimit` and `modalities`, and `currentModelId`.
3. Whether the id that `session/new` returns is what `qwen --model <id>` accepts in a pty session (Parley launches `qwen` in a pty, not through ACP).
4. How long `session/new` takes signed in (it may call `GET /models`) and what it does offline (the cached list).
5. s-322's "Not verified" list: real model records (thinking, usage), the OAuth flow end to end, `auth_success` with OAuth, a real quota error, resume of a real session, real model ids.

### 8.4 Direction (to be designed after 8.3)

The likely catalog source is a short-lived `qwen --acp` probe that runs `initialize` and `session/new`, reads
`models.availableModels`, and stops before any prompt. It runs in the same home as Parley's Qwen sessions and never touches
credential files. `model-registry.json` may enrich the metadata. The design is written only once 8.3 items 1–4 are observed.
