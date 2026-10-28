# Pilot 2 task: silent failures across Parley

Subject: Parley source code at commit `da446e81`, in the read-only worktree `/Users/kalmbik61/parley/pilot2-subject`. Read only: do not run, build or change anything there. Scope: `packages/*/src` without tests (~167k lines: desktop 88k, core 44k, host 32k, protocol 3.6k).

A **silent failure** is an error or a failed operation that the one who could react to it never learns about (the human in Parley's window, or the agent that called a tool):
- (a) swallowing: a `catch` (or `.catch`, an `error` handler) only logs, does nothing or returns a default, and the caller cannot tell it from success;
- (b) endless retry: a retry, poll or wait loop without a cap or without backoff that hides a persistent error;
- (c) never reaches the window: the host or the Electron main process knows about the error but does not send it to the window (no event, no `host.notice`, no result field, no UI text);
- (d) lost promise: a promise without `await` and without `.catch`, so the error becomes an unhandled rejection or disappears;
- (e) false success: a tool, method or endpoint answers success, or a misleading result, after a failure.

## Questions

- Q1. Host (`packages/host/src`): places of kinds a–e.
- Q2. Core (`packages/core/src` except `mcp/`): places of kinds a–e.
- Q3. The agent MCP server (`packages/core/src/mcp`) and the protocol (`packages/protocol/src`): where an agent gets success or nothing instead of an error.
- Q4. Desktop main and preload (`packages/desktop/src/main`, `packages/desktop/src/preload`).
- Q5. Desktop renderer (`packages/desktop/src/renderer`).
- Q6. All retries, polls and wait loops across the code: which have no cap or no backoff (kind b).
- Q7. The ten most harmful findings from Q1–Q6: the scenario the human or the agent sees, and the consequence.

## Answer format

Header: start and end time (`date -u`). Then the findings per question Q1–Q6, one finding per line:

```
<ID> | <kind a–e> | <path:line at da446e81> | what fails | who does not learn it and what they see instead | harm high/med/low | deliberate? (yes if a code comment explains why it is silent)
```

ID is `Q<n>-<number>`. A finding without `path:line` is a hypothesis and goes to a separate list. "Not found" comes with the list of what was read. At the end: Q7 (by ID) and a section "Not covered" with what was not read and why.

Time limit: 90 minutes from your start. Quality matters more than count: a wrong `path:line` or a place that is not a silent failure counts against the answer.
