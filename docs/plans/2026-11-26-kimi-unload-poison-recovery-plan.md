# Kimi unload_tools poison: detection and auto-recovery

Date: 2026-11-26. Base: `origin/master`. Evidence and mechanism: `docs/audits/2026-11-26/kimi-unload-tools-poison.md`.
The bug is in Kimi Code 2.8.1 (upstream, no fix released). Parley cannot patch the CLI; it can detect the poisoned
history, repair it safely, and resume — and remove the triggers it controls.

## Task 1 — Investigation: parley MCP catalog loss (read-only)

Owner: junior researcher. Scope: `packages/core/src/mcp` (`--kimi-native` mode: tool list lifecycle, session binding,
`tools/list_changed`), `packages/host/src/kimi/registration.ts`, host log `~/.parley/host/host.log` around
2026-11-26T18:23Z, wire of `session_893c961c-2dff-47d3-b3ff-af7983b9cde7`.
Question: why did all 50 `mcp__parley__*` tools leave the Kimi catalog at 18:23:01 without `mcp.server_failed`?
Deliverable: an addendum to the audit doc with the mechanism and evidence, or ruled-out hypotheses with evidence.
If a Parley-side defect is confirmed, file it as a separate backlog item; do not fix it inside this task.
Acceptance: the addendum explains the loss or bounds it with evidence; no code changes.

## Task 2 — No CLI self-update from the terminal path

Owner: junior. Scope: `packages/host/src/providers/kimi-env.ts` — `kimiTerminalEnv` sets
`KIMI_CODE_NO_AUTO_UPDATE = '1'` (same policy as `kimiLoginEnv`); a CLI binary swap mid-session is how 2.8.1
entered this session. The stale `delete env.KIMI_CODE_EXPERIMENTAL_TOOL_SELECT` may stay (harmless) or go;
if removed, note it in the commit body. Tests next to the existing env coverage.
Acceptance: a unit test proves the flag is set for the terminal env and Parley capability vars stay stripped;
`pnpm --filter @parley/host test` passes for the touched suite.

## Task 3 — Detect the poison and recover the session (senior-only: recovery + write boundary)

Owner: senior. Design constraints:

- Detect: in the native wire read path (`packages/host/src/kimi/native-wire.ts` / `native-session.ts`), a
  `turn.ended` with `reason:"failed"`, `error.code:"provider.api_error"`, `error.details.statusCode:400` and
  `error.message` matching `unload_tools at message position \d+: tool "(.+)" is not declared or has already been unloaded`.
  The projection currently drops the error text; carry what detection needs without putting free text into feed schemas.
- Repair only with the session process stopped (use the existing stop/start lifecycle; never edit a live wire).
  Back up `agents/main/wire.jsonl` beside it, then atomically rewrite without the poisoned `context.append_message`
  rows: content part `meta.kind === "tool_lifecycle"` whose `meta.removed` contains the named tool, located after
  the last `context.apply_compaction`. Every other byte preserved. The wire has no hash chain (verified), but the
  repair must still refuse files that changed between read and write.
- Resume through the existing native start path; verify the next turn completes. If a different tool is named,
  repair that announcement too; bound attempts by the number of poisoned announcements, never loop.
- Surface a `host.notice` in Chat: history repaired, what was removed. On repair failure: leave the backup,
  report the blocker, do not retry blindly.
- The human deferred repair of s-32 «OTC-15»; run the recovery on it only after the human accepts.

Acceptance: fixture-based tests (poisoned wire → exactly the poisoned rows removed, backup exists, other rows
byte-identical, live-process refusal, idempotence, bounded attempts); the touched host suites pass; a probe or
manual run on the real session shows the next turn completing after repair.

## Task 4 — Upstream report (external; human approval at run time)

File a bug against Kimi Code with the audit's minimal reproduction: catalog shrink after compaction →
`unload_tools` for never-declared tools → permanent 400. Include version 2.8.1, the wire excerpt and the
lowering code path. Do not publish anything without the human's explicit go-ahead.
