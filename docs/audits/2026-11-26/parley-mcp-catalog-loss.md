# Addendum: parley MCP catalog loss at 18:23 (task 1)

Date: 2026-11-26. Investigation: s-684 (code review of `origin/master`) plus wire re-check by the lead.
Status: bounded with evidence; root cause not confirmed; no Parley defect proven.

## Confirmed from the wire

- The parley tools were discovered exactly once, at conversation creation: 2026-11-24T14:39:43Z,
  `mcp.tools_discovered` serverName=parley, 50 tools. After the 17:38Z restart (2.8.1) there was **no**
  parley re-discovery — only figma-bridge (60) and context7 (2) at 17:39:04. The 50 parley tools in the
  17:56 request snapshot survived the restart via persisted session state.
- The loss fired at turn start: 18:23:01.103 user prompt «продолжай» (`turn.prompt`, turnId 60) →
  18:23:01.120 injected `<tools_removed>` announcement for all 50 `mcp__parley__*` tools. No
  `mcp.server_failed`, no `mcp.tools_discovered`, no `tools.update_store` row precedes it (last store
  update 09:16:05). So a turn-start catalog refresh dropped the stale parley tools.
- Host did not restart (continuous state logs 18:20–18:25); the parley entry is present in
  `~/.kimi-code/mcp.json`; the old MCP child (PID 34116, started 17:39Z) is gone, the current child
  (84961) belongs to the 18:31Z kimi process.

## Ruled out by code review (origin/master)

- A host disconnect does NOT directly yield a successful empty catalog: `createParleyServer`
  (`packages/core/src/mcp/tools.ts` ~2283–2320) advertises `tools:{}` and forwards the list to the
  runner; `createRemoteToolRunner.list` (`packages/core/src/mcp/remote-tools.ts`) throws a protocol
  error on host/network/auth failure when no fallback exists, and `createKimiNativeMcp` supplies no
  fallback. An empty successful list is only produced by a newly started **unbound** `--kimi-native`
  server (`packages/core/src/mcp/kimi-native.ts`, `unboundTools.list=[]` when `PARLEY_KIMI_NATIVE` is
  absent/incomplete — evaluated once at startup).

## Remaining candidates (neither established)

1. The parley MCP child exited or stalled before 18:23 (exit timing and stderr not recoverable now);
   Kimi's turn-start refresh dropped the stale tools without writing `mcp.server_failed` (that event
   marks connection attempts, not necessarily a mid-session drop).
2. A replacement MCP server started unbound and returned an empty list; the registration command in
   `mcp.json` is persistent, but no evidence proves a restart or env loss at 18:23.

## Consequences for the recovery plan

- The poison mechanism and the repair design (task 3) do not depend on which candidate is true: any
  catalog shrink that emits a removal announcement can poison a compacted history.
- Hardening idea (not a confirmed defect, not in scope): after a host reconnect or a session resume,
  ensure the `--kimi-native` child is (re)started bound and re-announces its tools, so stale persisted
  tools cannot linger and then drop at a turn start. File as a backlog idea only if the human wants it.

Not verified: exact child exit cause/time, stderr capture, deployed app code equivalence to
origin/master at 18:23, raw wire timestamp format assumptions beyond the numeric `time` field.
