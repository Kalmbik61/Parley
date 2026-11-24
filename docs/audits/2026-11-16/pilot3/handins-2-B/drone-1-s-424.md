<!-- drone 1 s-424 model=haiku addedAt=2026-11-16T17:40:37.672Z handedAt=2026-11-16T17:43:16.243Z result=done -->
Drone A feed (s-424), read-only, source: /Users/kalmbik61/parley/pilot3-subject at 9eabc014. Paths relative to copy root. Impact card: not applicable (read-only research, no change).

Q01 — OpenCode throwing tool call
- Bridge (packages/core/src/feed/opencode/events.ts):
  - Tool name comes from `session.tool.input.started`: `data.name` stored in `toolNames[data.id]` (events.ts:112-116). Later tool events look it up by call id (events.ts:121); if absent, name = `tool`.
  - A throwing `execute` is `session.tool.success` with `data.metadata.error === true` (events.ts:123-125). It maps to hook `PostToolUseFailure`; other success = `PostToolUse`; `.called` = `PreToolUse`; `.failed` = `PostToolUseFailure` (events.ts:126).
  - Error text for the throwing case = `data.content[0].text` only (events.ts:127-128); for `.failed` = `data.error.message` (events.ts:128).
  - Record: tool_name, tool_use_id, tool_input, detail; `error` only on PostToolUseFailure (events.ts:129-134). `detail` for `execute`: first `tools.parley.X(` match in code, else first line capped at 120 chars (events.ts:77-85).
  - Name is dropped from state on non-Pre hooks (events.ts:136-140). No mail item is produced by the bridge.
- Message-list builder (packages/core/src/feed/opencode/apply-opencode.ts):
  - Name = part `name` (apply-opencode.ts:115), no event needed.
  - Part `status` `completed` with `state.metadata.error === true` → `finishTool(..., 'failed')` (apply-opencode.ts:125-126); `status` `error` → failed (126). Output = all text parts joined with newline, else error message (122; opencodeContentText at message-record.ts:43-49).
  - Mail: `mailFromExecute` on finished execute with inbox code (apply-opencode.ts:84-93, 130-131).
- Difference: bridge reads `data.metadata` and first content part; builder reads `state.metadata` and all text parts (events.ts:124 vs apply-opencode.ts:125, events.ts:127 vs apply-opencode.ts:122).
- Reducer on the resulting hook: PostToolUseFailure → failed status, response = error string (reduce.ts:782, 796).
Answered. Open: the real OpenCode payload shape (data.metadata vs state.metadata) is only asserted in comments (events.ts:123, apply-opencode.ts:124); the spec/openapi it cites is not in the copy I read.

Q02 — Codex rollout re-read, history start, error item
- Dedup: applyCodexRecords skips records with non-null ordinal ≤ cursor.lastOrdinal and advances it (apply-codex.ts:371-375); cursor shape at apply-codex.ts:53-62. Host tail read calls it with the stored cursor (packages/host/src/feed/feed-service.ts:1250-1253).
- Records with null ordinal (pre-0.160) are not cursor-filtered (apply-codex.ts:372). Dedupe there relies on stable ids: FeedDraft.put replaces same id in place (reduce.ts:313-322). Stable ids: prompt `prompt:${id}` (apply-codex.ts:184), text `text:${id}` (191), tool `${id}` (200), FileChange `${id}:${index}` (213), notice `notice:${id}` (257). Not verified: items built with draft.nextId (turn, notice) could duplicate on re-feed of null-ordinal journals.
- historyStart (parent/build path): feedFromCodexRollout sets start cursor lastOrdinal = historyStart − 1 (apply-codex.ts:385), so records with ordinal < historyStart are skipped; default 0 skips none (apply-codex.ts:385, 373).
- Sub-agent live path: on first read, track.cursor.lastOrdinal = meta.historyStart − 1 (feed-service.ts:43-46), then applyCodexRecords with agentId (feed-service.ts:48-53). Agent meta skips ordinal < historyStart for turn_context, task, result but reads session_meta first (codex-agents.ts:62-73).
- Sub-agent snapshot path: feedFromCodexRollout with historyStart and context 'child' (feed-service.ts:1721-1726): pre-marker records skipped (apply-codex.ts:385); mail flag off (apply-codex.ts:386); agentId stays null, so UserMessage/AgentMessage of the child ARE emitted in this snapshot (apply-codex.ts:181-192 check agentId only when non-null). Live child path suppresses them (apply-codex.ts:182, 189) and nests calls into children (putTool, apply-codex.ts:129-136).
- "Earlier history only in Terminal" error item (CODEX_HISTORY_IN_TERMINAL, apply-codex.ts:64-65, 390):
  - Added only in feedFromCodexRollout (apply-codex.ts:388-392), never by applyCodexRecords. Callers that build: parent seed (feed-service.ts:1049) and child snapshot (feed-service.ts:1721). Incremental callers (feed-service.ts:1253, 1287) never add it.
  - Condition: cursor.modern is false AND the passed record array contains a response_item or an event_msg whose type ≠ token_count (apply-codex.ts:388-389). cursor.modern is set to true for every item_completed that passes the ordinal filter (apply-codex.ts:348-349), so skipped pre-historyStart records do not set it.
  - Inserted at the head of items with id `error:codex-history`, at = records[0].at or epoch (apply-codex.ts:390-391). Limit trimming runs after and may drop it (apply-codex.ts:393).
Answered. Open: whether other 0.160+ markers than item_completed exist (cursor.modern rule) is not checked against the spec; the null-ordinal re-feed duplicate question above is not verified.

Q03 — Claude transcript + mail journal
- Journal used only for root context (from-transcript.ts:266-267).
- Journal index: each entry parsed by mailFromInline; broken or non-pointer lines dropped; first entry wins for a duplicate mail id (mail-seed.ts:17-24). Item id = `mail:<first letter id>` (mail.ts:79-80).
- mailFromInline needs the exact first line + JSON with `messages` (mail.ts:14, 91-101).
- attachment record contributes only when: root, record type `attachment`, attachment.type `hook_additional_context`, hookEvent `UserPromptSubmit` (from-transcript.ts:296-297, 169-170). Each text in content goes through mailFromInline with the record's time (172-173). If the journal has the same id, the journal version is put instead (174: journal.get(parsed.id) ?? parsed). So journal content and time win; the attachment's own text/time is used only when no journal entry matches. Position = where the attachment record sits in transcript order.
- Journal entries with no matching item (by id) are inserted after transcript build (from-transcript.ts:304-305; mail-seed.ts:31-55): missing = journal entries whose id is not in items, sorted by time (mail-seed.ts:33-34). Placed after the last prompt with isPointerText and at ≤ mail.at, skipping mail items directly after it (mail-seed.ts:36-47). No pointer prompt → before first item with later time, or at end (mail-seed.ts:50-53).
- Dropped: non-pointer/unparseable entries (mail-seed.ts:20; mail.ts:91-101); later duplicate ids (mail-seed.ts:21); ids already present in items (mail-seed.ts:33-34); no pointer prompt and older than the first item (mail-seed.ts:50-51); child context (from-transcript.ts:266-267); tail trim by limit after insertion (from-transcript.ts:304-308).
- Winner for duplicate id: first journal entry in order (mail-seed.ts:21); journal beats attachment (from-transcript.ts:174).
- Inferred, not traced: a mail item from a check_inbox tool result (putMail, from-transcript.ts:165; mail.ts:108-119) has the same `mail:` id scheme, so it would also block journal insertion.
Answered. Open: isPointerText (packages/core/src/work/delivery.ts:145) is not read, so the exact pointer test is unverified.

Q04 — PermissionRequest in the live hook reducer (packages/core/src/feed/reduce.ts)
- Dispatch: PermissionRequest → onPermissionRequest (reduce.ts:1073-1074); record from eventRecordOf, agentId = data.agent_id (work/events.ts:261-275).
- No card when: event record null / not an object (reduce.ts:1029-1030); tool_name missing (reduce.ts:735); AskUserQuestion or ExitPlanMode with no matching running tool and an own pending non-permission card with the same tool name already exists (reduce.ts:751-757).
- Candidate pool: root = main tools (agentId undefined) (reduce.ts:742-743, isMainTool at 366-367); nested = children of rec.agentId's agent (reduce.ts:742-745).
- Candidates: same name, status `running`, no card yet for that toolUseId (reduce.ts:740-748).
- Pick: last candidate whose input equals the request input by JSON equality (sameInput, reduce.ts:119-120, 749); otherwise the last candidate (749).
- Card id: `permission:<tool.toolUseId>` if a tool was found and no item has that id; otherwise draft.nextId('permission') (reduce.ts:759-762). toolUseId = null if no tool (card unlinked). agentId set for nested calls. Card starts pending, notified false (reduce.ts:763-775, approx).
- Unlinked card and later PreToolUse: onPreToolUse does not touch cards (reduce.ts:672-705), so the card stays toolUseId null until a PostToolUse matches it by unbound rule below.
- Settle on finish (onPostToolUse, reduce.ts:782-823): the finished tool is put first (796-815); then cardsOfCall (818): pending cards with the same toolUseId; if none, the first pending card with toolUseId null, same name, same agentId, equal input (cardsOfCall reduce.ts:652-670). Each is settled `elsewhere` with toolUseId written (818-825). Question cards take answers from tool_response (820-823). settle() puts state + settledAt and, for `elsewhere` with toolUseId, calls rejectTool (reduce.ts:569-572); rejectTool only rejects a still-running tool (575-585), which is already finished here, so no-op.
- Other settle paths: UserPromptSubmit settles all pending `elsewhere` (reduce.ts:880-883, settleAllPending at 605-607); Stop (root) → endTurn settles all pending and rejects running main tools (reduce.ts:829-870); closeTurn settles all unless keepPending (reduce.ts:626-641), rejectRunningTools at 632.
- Notification permission_prompt only sets notified on the last pending permission card (reduce.ts:1096-1104); no state change.
- States `allowed`/`denied`/`answered` are written in the window decision path (reduce.ts:1164, 1176, 1182), not in the hook reducer; the function there was not read in full.
Answered. Open: decision path (reduce.ts ~1150-1200) not read in full; hook-side equivalence of nested-agent ordering not traced.

Not verified: work/events.ts only read at 261-275; work/delivery.ts:145 not read; reduce.ts read only in ranges 279-330, 355-385, 442-452, 520-880, 1020-1105, not whole; host feed-service.ts read only 1035-1065, 1240-1300, 1700-1735; OpenCode spec/openapi not in the copy.

Coverage: partial — Q01–Q04 answered from the cited ranges; gaps: whole-file reads of reduce.ts and work/events.ts, work/delivery.ts:145 (isPointerText), the window decision path (reduce.ts ~1150–1200), and the OpenCode payload spec; null-ordinal Codex re-feed duplicates not verified.