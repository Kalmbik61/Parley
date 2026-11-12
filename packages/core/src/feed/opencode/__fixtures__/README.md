# OpenCode 2.x fixtures

All content is invented (ids, paths, text). Shapes come from the spike `docs/research/2026-11-12-opencode-2x-spike.md`
(OpenCode 2.2.7) and its recorded SSE streams.

| File | Content | Source of the shape |
| --- | --- | --- |
| `events-turn.jsonl` | one MCP turn: `session.created` … `session.execution.succeeded`, plus an unrelated `mcp.status.changed` | Observed (`events*.txt` of the spike lab) |
| `events-more.jsonl` | `permission.asked/replied`, `session.tool.failed`, `session.execution.interrupted`, another session's event, a non-user inbox item | `permission.*`, `tool.failed`, `interrupted` observed; the rest from the openapi schema |
| `lab-turn.json`, `lab-execute-error.json`, `lab-model-error.json` | copies of `tools/opencode-mock-lab/recorded/messages-*.json`: a turn with `shell`, `execute` → `check_inbox` and text; a throwing `execute`; a failed model turn (`idle outcome: failed`). Newest first, as the API lists them | Recorded from OpenCode 2.2.7 against the mock model (invented content) |
| `lab-events.sse.txt` | copy of `tools/opencode-mock-lab/recorded/events.sse.txt`: four sessions of SSE (full turn with permission, queued prompt, two failed turns) | Recorded from OpenCode 2.2.7 against the mock model |
| `messages-main.json` | `GET /api/session/{id}/message`: user, assistant (reasoning, text, `execute` ping, failed `write`), `idle`, `system`, a streaming second turn, an unknown type | Message and part names observed; every `tool` part (`state.status`, `content`, `time`) built from `openapi.json` |
| `messages-mail.json` | `execute` parts that read the inbox: `check_inbox`, `wait_for` with the MCP `{content:[…]}` wrapper, and `read_room` (no mail) | Built from `openapi.json`; the spike has no recorded `execute` part |

## Closed by the mock lab (O0, FINDINGS.md)

- The `tool` part shape (`name`, `state.status/input/content/metadata`, `time`) and the `execute` result text.
- A throwing `execute` is `completed` with `metadata.error: true` (and `session.tool.success`); the parsers treat it as failed.
- `session.execution.failed` / `session.step.failed` payloads, and `idle` with `outcome: failed`.
- The message list is newest first and paged (`cursor.next`); the reducer sorts by time.

## To re-check against a runnable 2.2.7

- Whether `session.tool.called/success/failed` carry the tool name (the recorded ones do not; the mapper takes it from `session.tool.input.started`).
- The `idle` message with `outcome: interrupted`, and the other `system`/`synthetic`/`compaction` message types.
- The second page of a long session (`cursor.next`): the host must fetch all pages before applying.
- Streaming messages: `time.completed` absent while streaming (assumed from the schema).
- A real blocking `wait_for` through `execute`.
