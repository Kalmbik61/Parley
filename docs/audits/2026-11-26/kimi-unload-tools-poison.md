# Kimi Code 2.8.1: `unload_tools` history poison

Date: 2026-11-26. Status: root cause verified from session evidence; upstream fix not available (2.8.1 is the latest stable).

## Symptom

A native Kimi session fails every turn with the same API error and never recovers, even after stop/resume:

```
[provider.api_error] unload_tools at message position 168:
tool "mcp__figma-dev-mode-mcp-server__add_code_connect_map" is not declared or has already been unloaded
```

Observed in Parley session s-32 «OTC-15» (work w-0047, cwd `/Users/kalmbik61/Desktop/tdhc`),
Kimi conversation `session_893c961c-2dff-47d3-b3ff-af7983b9cde7`.

## Verified timeline (wire + session log)

All times UTC, 2026-11-26 unless noted. Evidence: `~/.kimi-code/sessions/wd_tdhc_335bf131e8fe/session_893c961c-…/agents/main/wire.jsonl` and `logs/kimi-code.log`.

- 11-25 06:22 — `figma-dev-mode-mcp-server` (local Figma desktop app, `http://127.0.0.1:3845/mcp` in the user's `~/.kimi-code/mcp.json`) recovers; its 10 tools are added to the catalog (`tool_select.tools_changed`, disclosure=inline).
- 11-25 21:21, 11-26 05:25, 11-26 09:05 — three full compactions replace the context with summaries. Earlier tool-lifecycle announcements are compacted away: the wire's persisted context contains only two lifecycle messages, both from 11-26 (see below).
- 17:39:07 — the CLI (2.8.0) sees 2.8.1 (published 13:26) and self-updates; install completes 17:39:48 (`updates/install.json`). The session process restarts on 2.8.1.
- 17:39:32 — `mcp.server_failed` for `figma-dev-mode-mcp-server`: "Timed out after 30000ms" (Figma app closed).
- 17:56:27.801 — on the first prompt after the restart (a delivered letter), the CLI injects a `tool_lifecycle` announcement: added=3 (figma-bridge), **removed=10 (all figma-dev-mode tools)**, disclosure revision 4.
- 17:56:31 — `turn.ended` reason=failed, `error.code=provider.api_error`, statusCode 400, `retryable:false`, the unload_tools message above (position 168).
- 18:23:01.120 — a second poisoned announcement: added=0, **removed=50 (all `mcp__parley__*` tools)**. No `mcp.server_failed` for parley in the wire; the host did not restart; the parley entry is still in `mcp.json`. Cause of the catalog loss is open (see plan task 1).
- 18:23:05 — same 400, same position 168.
- 18:31 — human resumes the session again; the poison is in the persisted context, so the next prompt will fail identically. Human deferred repair on 2026-11-26.

Supporting facts:

- Zero `select_tools` calls and zero figma-dev-mode tool calls in the whole session: the removed tools were **never declared** in the post-compaction history.
- All catalog tools are `disclosure=inline`; the 17:56 request snapshot has 242 tools, no figma-dev-mode, `select_tools` present (earlier 2.8.0 snapshots had no `select_tools`).
- Earlier catalog removals under 2.8.0 (11-25 10:20 parley, 20:42 mempalace) produced **no** lifecycle announcements and no poison. The announcement behavior appeared with 2.8.1.

## Mechanism (from the 2.8.1 binary)

- `toolSelectService` renders catalog deltas as text parts with `meta { kind: "tool_lifecycle", added, removed }` (`renderDeltaAnnouncement`).
- The OpenAI protocol lowering (`kimiOpenAIProtocol.message`) appends `{ role: "system", unload_tools: removed }` for every message whose parts carry `removed` names, whenever the model spec has `dynamically_loaded_tools`. It does **not** check whether those tools were ever declared in the history being sent.
- The API replays the ledger and rejects an unload of a tool that is not declared at that position → 400. The announcement stays in the persisted context → every later request repeats the failure. The session is permanently stuck.
- Compaction cannot repair it: the compaction context builder keeps recent injections (`appendedInjections = history.slice(compactedCount).filter(origin.kind === "injection")`), so the poisoned announcement survives compaction.
- The capability cannot be disabled from outside: `mergeCapability` ORs discovered and configured capabilities; `KIMI_MODEL_CAPABILITIES` only defines the separate env-model; `KIMI_CODE_EXPERIMENTAL_TOOL_SELECT` no longer exists in 2.8.1 (the delete in `kimiTerminalEnv` is a no-op leftover).

Conclusion: a Kimi Code 2.8.1 regression. Trigger: an MCP catalog shrink (flaky local server, or the parley MCP connection loss) after compaction, on a model with `dynamically_loaded_tools`.

## Manual recovery (deferred by the human)

For any poisoned session, while its process is stopped:

1. Back up `agents/main/wire.jsonl`.
2. Delete the `context.append_message` rows whose content part has `meta.kind === "tool_lifecycle"` with a non-empty `meta.removed` naming the tool from the error (both poisoned rows in this session). Keep every other byte.
3. Resume the session. The CLI rebuilds the context from the wire; with no announcements in history the toolSelect service injects a fresh snapshot (added-only, harmless).
4. Verify: the next turn completes; if a different tool is named, repeat for that announcement (bounded).

Risk: the resume path may re-emit removal deltas from rebuilt catalog state; verify empirically after the edit. Fallback: a new Kimi conversation with the last compaction summary handed over.

## Open questions

- Why did all 50 parley MCP tools leave the catalog at 18:23:01 without `mcp.server_failed`? (Plan task 1.)
- Does 2.8.1 emit removal announcements for inline tools unconditionally, or only when `select_tools` is active? (Affects how often the trigger fires; the recovery design does not depend on the answer.)
