# Kimi shared PTY probe

Base `1e31045dace781de95026c762f1425a67744b54e`. This is a probe, with no production changes. Chat submits into the same stock Kimi 2.7.3 PTY that Terminal displays and writes to. Neither path starts ACP or transfers native ownership.

## Plan and acceptance

1. Reuse the native handoff probe's disposable homes, bounded waits, and loopback synthetic model. Launch Kimi in one `node-pty` from the start. Check two input paths on the same PID and provider ID, actual ANSI output, resize, and `/help`. Tab selection is local presentation state.
2. Record the active `wire.jsonl` path and the observed payloads and timing for identity, readiness, busy state, input, streamed output, permission and elicitation, `/compact`, `/new`, and resume. Exercise both input paths without lost or duplicate turns and state what a minimal reader and ready gate must do.
3. Install only a local fixture plugin in the disposable home, with rules and one inert MCP tool. Check native invocation and approval choices without experimental flags. Compare provider ID and tool authority after `/new`, including how a stable Parley session can track the new provider ID, as with Codex and Qwen.
4. Capture the loopback request and response for `/compact` and check completion with the small fixture tool. Do not use real prompts, account configuration, credentials, or large real schemas.
5. Record measured feasibility, exact event shapes, likely production boundaries, and unverified risks. Run the smallest relevant checks and commit only the probe, this plan, and any minimal new synthetic fixture. No push or app install/restart.

## Run

```sh
PARLEY_KIMI_SHARED_PTY_BIN=/Users/kalmbik61/.kimi-code/bin/kimi pnpm --filter @parley/host exec vitest run src/kimi/shared-pty.probe.test.ts
```

Run on macOS with the workspace dependencies and native PTY helper installed. The exact opt-in path and Kimi version are checked. The runner needs permission to bind a loopback listener and allocate a PTY. As in the handoff probe, the child uses an allowlisted environment, empty disposable homes and a Seatbelt profile that denies outside network connections and real home data access. The setup PTY installs the exact local fixture, then exits before the measured PTY starts. There is no ACP process and no paid model request. Only the disposable empty folder and fixture installation are trusted.

## Kimi 2.7.3 observations

The live process was stock `kimi` (`kimi-code` in `ps`). Chat-like input used bracketed paste and a separate Return. Raw Terminal input wrote plain bytes and Return to the same PTY. In both paths the probe waited for the echo before sending Return, using the 150 ms fallback separation from the existing probe. Neither input source has a separate provider conversation. The first session ID A appeared **after** the first message. By then the CLI was already usable and could show `/help`. Switching the selected view needs no provider RPC, process restart, or ownership decision.

The first two submitted prompts and both replies appeared exactly once in A's main wire. The test held an SSE reply open after the first delta. The CLI painted the partial reply and a working indicator, **with an empty composer still on screen**. The second Chat submission was refused at this boundary and never reached Kimi. A raw Terminal turn then ran after the first turn finished. The test uses the blank composer plus the observed working indicator, not the mere existence of a provider ID, to distinguish these cases.

### Tool catalog and authority

| Native session | Model discovery | Dispatch and approval |
| --- | --- | --- |
| A, lazy first message on a fresh process | The plugin's MCP `tools/list` had already run. The main wire contained `mcp.tools_discovered` with the tiny schema. The fixture was absent both from the initial RAW model request's `tools[]` and from its messages. No experimental flags were set. | The loopback model named the known fixture deliberately. **Reject** returned an error without a stdio call. A second call with **Approve for this session** reached stdio and returned `RESULT_SHARED`. This is proof of dispatch, not discovery. |
| B, `/new` after A in the surviving PTY | The first B request advertised the fixture by its qualified name, with `parameters: {type:"object",properties:{}}`. The loopback model picked it from `tools[]`. No A conversation or compact summary was sent. | Native approval was shown again despite the session-wide approval in A. **Approve once** returned the fixture result. The plugin rules and tool stay attached to the process, but A's native approval did not carry over. |
| C, `/new` immediately after a fresh launch | The CLI allocated an ID and reported one connected stdio tool before the first prompt. The first model request still omitted the fixture schema. | Fresh `/new` is not a demonstrated fix for cold model discovery. This control does not spoof a tool call. |
| A, exact native resume from disk after compaction | The first resumed request advertised the fixture. | The resumed turn did not call the tool. |

The exact name is `mcp__plugin-parley-shared-pty-probe_fixture__handoff_probe`. The plugin's `systemPrompt` marker appeared in the model request, as did the `UserPromptSubmit` hook's rules. This gives working native execution and a separate, concrete provider limitation. MCP connection, provider ID and a usable composer do **not** prove the cold model catalog is populated. The fixture bypass in A cannot be treated as evidence that a model will spontaneously discover the tool there. No full Parley catalog or account profile was used. The fixture's temporary grant is not a production authorization design. [Kimi local plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html), [Kimi MCP behavior](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html).

### Main wire and native signal contract

The observed path is `$KIMI_CODE_HOME/sessions/wd_cwd_<hash>/session_<uuid>/agents/main/wire.jsonl`. The workspace segment is opaque. A and B have separate files under the same workspace. The header has `type:"metadata"`, `protocol_version:"1.5"`, `min_protocol_version:"1.5"` and `created_at`. Main records carry `agentId:"main"` and millisecond `time`. Fields below are shown without unrelated payload.

| Signal | Actual shapes |
| --- | --- |
| Identity | The `SessionStart` hook carries `session_id`, `client_type:"kimi_code_cli"`, `cwd`, `source:"startup"` or `"resume"`, `model` and `profile`. On `/new` the hook named B **before** the new viewport finished painting. Resuming A by `--session <A>` after exit used a new PID, emitted `source:"resume"`, showed previous replies and sent A's compact summary on the next turn. |
| Input and turn | `turn.prompt {input,origin:{kind:"user"},promptId,turnId,trigger:"normal"}` and `context.append_message {message:{role:"user",content,toolCalls,id,origin}}` carry the same user input. The latter may include a hook result as a text part with `meta.source:"user prompt submit hook"`. Emit the human message once, not from both rows or its hook. `UserPromptSubmit` has `prompt:[{type:"text",text}]` and `is_steer`. `TurnStarted` has numeric `turn_id`, `origin_kind`, and `prompt`. |
| Completion | `turn.ended {turnId,reason:"completed",durationMs,replyModel,modelSteps}` and `prompt.completed {promptId,finishedAt,reason}`. The `Stop` hook has `turn_id,step,first_step_of_turn,finish_reason,usage,stop_hook_active`. A `step.end` is not a turn end because a tool turn may use several steps. |
| Assistant content | `context.append_loop_event {event:{type:"step.begin",uuid,turnId,step}}`, then `event:{type:"content.part",uuid,turnId,step,stepUuid,block,part:{type:"text",text},startedAt,durationMs}`. Nested loop `turnId` is a string in the probe, while outer turn and hook IDs are numbers. The CLI painted a partial SSE reply before any corresponding `content.part` appeared. The closed block recorded the merged text, not one row per token or HTTP delta. |
| Tools | In `context.append_loop_event`, `tool.call` includes `toolCallId,name,args`; `tool.result` includes `parentUuid,toolCallId,result:{output,isError,durationMs}`. A rejected call is recorded as a tool error even though the MCP server never ran it. |
| Permission | `interaction.request {id,kind:"approval",agentId,toolCallId,request:{id,sessionId,agentId,turnId,toolCallId,toolName,action,display}}` and `interaction.resolved {id,response:{decision}}`. The matching `PermissionRequest` and `PermissionResult` hooks use snake_case fields and an `approval_<uuid>` ID. Hook callbacks can be asynchronous. The PTY offered **Approve once**, **Approve for this session**, **Reject**, and **Reject with feedback**. |
| Elicitation | The native `AskUserQuestion` tool took `questions:[{question,header,multi_select,options:[{label,description}]}]`. The PTY used separate select and review/submit screens. Wire `interaction.request` used `kind:"question"`, `id:"question_<uuid>"`, `toolCallId`, and `request:{turnId,toolCallId,questions}` with camelCase `multiSelect`. `interaction.resolved.response` was `{answers:{"Which synthetic marker?":"ALPHA"},method:"enter"}`. `PreToolUse` and `PostToolUse` shared the call ID. The latter's `tool_output` was a stringified `{"answers":{"Which synthetic marker?":"ALPHA"}}`. No permission was needed for that question. |

[Documented Kimi hook payloads and hook semantics](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html), [Kimi built-in tools](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html).

### Manual compaction

Both runs posted one streamed `/v1/chat/completions` request with `model`, `messages`, `tools`, `prompt_cache_key`, `max_tokens`, `stream:true`, and `stream_options`. Kimi included the original system prompt, conversation (including date injection, tool calls and tool results) and a final user-role handoff-summary instruction. In B the `tools[]` array still advertised the one tiny plugin schema alongside built-ins. In A it did not. The loopback returned one assistant text delta with the summary, an empty delta with `finish_reason:"stop"`, and `data: [DONE]`. Both native screens reported completion. This is completion with the small schema, not evidence of shrinkage or a test of an oversized schema.

Wire order was `full_compaction.begin {source:"manual"}` → `context.apply_compaction {summary,contextSummary,compactedCount,tokensBefore,tokensAfter,summaryOutputTokens,keptUserMessageCount,appendedInjectionCount,wireLines:{start,end}}` → `full_compaction.complete`. The earlier records remained in the same file. The hooks carried `PreCompact {trigger:"manual",token_count}` and `PostCompact {trigger:"manual",estimated_token_count}` in addition to the common hook fields. The tiny synthetic runs reported A 14,402 → 14,776 and B 14,199 → 14,722 estimated tokens. The original session A could still replay its visible history and use the summary after exact-ID resume.

### Integration boundaries

- **One process and two views.** In `packages/core/src/work/launch.ts` and `packages/host/src/sessions/sessions-service.ts`, launch native into the existing PTY manager on start and exact-ID resume. Chat sends via `packages/host/src/pty/send.ts` and `type-and-submit.ts`, and Terminal keeps raw input. Reuse their single pending submit, draft mutation and PID checks. Gate writes before paste and recheck before Return. A composer or `SessionStart` alone is insufficient. Track busy/interaction state separately, avoid sending while trust/login/modals are active, and check that the current PTY still owns the intended draft. The probe's English screen expressions and sleep are 2.7.3 evidence, not a general parser.
- **Identity is independent of readiness and tools.** Keep the Parley `SessionRef` stable and bind the observed provider ID to the current launch generation via an authenticated, per-launch plugin rendezvous. Verify the main path under the configured Kimi home and the expected cwd. Use `SessionStart` on the same live generation to switch from A to B and settle A's unresolved requests. Neither a global search by cwd/recent time nor a bare inherited environment identifies the current provider conversation. Codex's `linkSession` and `bindCodexThread` combine log ownership and MCP thread proof. Qwen's `activity/qwen-binding.ts` and `activity-service.ts` separate validated transcript identity from current-process readiness. Kimi needs an explicit same-launch rebind because `linkSession` handles initially unbound IDs only. Bind the MCP transport to the right Parley ref and launch generation before any real operation. The fixture uses a grant file only to observe dispatch. Hooks can fail open and stdio `tools/call` provides no provider session ID.
- **Read one durable stream.** Add the native reader near `packages/host/src/kimi/` and connect it to `feed/feed-service.ts`, `feed/kimi-interactions.ts` and `activity/activity-service.ts`. Consume complete lines by byte offset per file and bind every record to the current ID, tailing append-only across resume without re-emitting replay. Project human text from user-origin `context.append_message`, assistant text from closed `content.part`, pending requests from `interaction.request/resolved`, and lifecycle from turn/compaction rows. Do not fold the same hooks as a second source of messages, do not present hook/context injection as human text, and do not treat a compact summary as a Chat reply. Keep opaque paths and track replacement/truncation explicitly. Subagent streams, branches, steering, undo and clear need their own projection decisions. Wire alone does not show text as quickly as the terminal while a content block is still open.
- **Remove UI ownership assumptions at the boundary.** The existing exclusive path is wired through `packages/desktop/src/renderer/chat/ChatView.tsx`, `kimi-control.ts`, `chat-outbox.ts`, `terminal/TerminalSurface.tsx`, and `island/requests.ts` / `model.ts`. Switch view without taking over the provider. The native modal can stay the source of truth for human decisions. No ACP-like interactive response channel was proved for native PTY, so a Chat or island card cannot safely send a blind approval key. The current ACP path, snapshots and persisted handoff markers need a compatibility decision for existing sessions, separate from the native probe.

### Bounded screens

```text
116×30  help · Esc / Enter / q to cancel   Keyboard shortcuts   Slash commands
102×26  empty composer after SIGWINCH
102×26  SHARED_REPLY_                     Working for 1s
102×26  1. Approve once                   2. Approve for this session
        3. Reject                         4. Reject with feedback
102×26  Which synthetic marker?            ALPHA / BETA → review → Submit
```

## Impact card

- **Goal** — Establish the stock native boundary for one live Kimi process shared by Chat and Terminal.
- **Behaviour** — Both input paths used one PID and provider ID. Native permission, question, compaction, same-PID `/new` and exact native resume worked. The cold catalog omitted the already connected plugin tool.
- **Numbers** — 1 opt-in case, 6 user turns with exact-once wire and hook assertions, 12 accepted loopback requests including 2 compactions, 2 successful inert calls, 1 rejected before stdio, 0 external requests.
- **Screens** — Real ANSI, `/help`, Escape, 116×30 → 102×26 resize, working composer, approval and elicitation viewports.
- **For the human** — No production code, app install, restart, account settings, or live conversations changed.
- **Risk** — Cold native tool discovery is incomplete in this fixture. Tool dispatch by known name is not a workaround for provider catalog visibility. Main wire text arrives after a block closes. Hook ordering and availability are not safety guarantees.
- **Cost** — No paid requests. Production effort and runtime overhead not measured.
- **Verdict** — Single native PTY is feasible for input, terminal UI, wire projection, and native decisions. Stock 2.7.3 cold model tool discovery is not proved. The same plugin was advertised and callable without flags after a warm same-process `/new`.

**Not verified** — Actual Parley desktop wiring, real model profiles and MCP authority, overlapping physical keystrokes during the Chat paste window, non-English or narrower terminal layouts, compatibility migration, oversized schemas, and any writable production change.
