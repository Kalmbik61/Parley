# OpenCode 2.x fixtures

All content is invented (ids, paths, text). Shapes come from the spike `docs/research/2026-11-12-opencode-2x-spike.md`
(OpenCode 2.2.7) and its recorded SSE streams.

| File | Content | Source of the shape |
| --- | --- | --- |
| `events-turn.jsonl` | one MCP turn: `session.created` … `session.execution.succeeded`, plus an unrelated `mcp.status.changed` | Observed (`events*.txt` of the spike lab) |
| `events-more.jsonl` | `permission.asked/replied`, `session.tool.failed`, `session.execution.interrupted`, another session's event, a non-user inbox item | `permission.*`, `tool.failed`, `interrupted` observed; the rest from the openapi schema |
| `messages-main.json` | `GET /api/session/{id}/message`: user, assistant (reasoning, text, `execute` ping, failed `write`), `idle`, `system`, a streaming second turn, an unknown type | Message and part names observed; every `tool` part (`state.status`, `content`, `time`) built from `openapi.json` |
| `messages-mail.json` | `execute` parts that read the inbox: `check_inbox`, `wait_for` with the MCP `{content:[…]}` wrapper, and `read_room` (no mail) | Built from `openapi.json`; the spike has no recorded `execute` part |

## To re-check against a runnable 2.2.7

- The `tool` part of the messages API: `name` (`execute`), `state.status` values, `state.content[]`, `time.completed`. The spike recorded only the SSE side.
- What `execute` returns for an MCP tool: plain JSON text, the `{content:[{type:"text"}]}` wrapper (both are covered), or something else.
- Whether `session.tool.called/success/failed` carry the tool name (the recorded ones do not; the mapper takes it from `session.tool.input.started`).
- `session.execution.failed` and `session.step.failed` payloads (schema only; `failed` was never observed).
- The `idle` message with `outcome: failed|interrupted`, and the other `system`/`synthetic`/`compaction` message types.
- Whether the list is paged (`cursor.next`) for long sessions.
- Streaming messages: `time.completed` absent while streaming (assumed from the schema).
