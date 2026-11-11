# Qwen Code transcript and hook fixtures

Sanitized from real `qwen` 0.27.2 runs against the mock model in `tools/qwen-mock-lab/`.

- Every absolute path is replaced by `/work/project` (cwd) or `/work/home/.qwen/...` (transcript path).
- The `memory_catalog_snapshot` system record is kept with the text `[memory snapshot omitted]`.
- `fixtures.test.ts` fails if a user path or memory text comes back.

| File | Content |
| --- | --- |
| `session-main.jsonl` | user, assistant text, thinking (`thought: true`), MCP calls through the `tool_call` wrapper (`tool_search`, then `tool_call` with the inner `mcp__parley__echo`), tool results, system records (`attribution_snapshot`, `memory_catalog_snapshot`, `ui_telemetry`). Observed. |
| `session-resume.jsonl` | one session file with two runs: the second run (`--resume`) appended its records to the first. Observed. |
| `hook-payloads.jsonl` | one hook payload per line: SessionStart, UserPromptSubmit, Stop, Notification (`idle_prompt`). Observed. |

Synthetic records (shapes taken from the spike report, not captured live):

- `session-main.jsonl`, last 6 records (uuids `…0901`–`…0906`): a `run_shell_command` call with a success result (copied from the observed run in `session-resume.jsonl`), and a `tool_call` of `mcp__parley__echo` whose result has `status: "error"` and `response.error`.
- `hook-payloads.jsonl`: PreToolUse and PostToolUse, and the empty UserPromptSubmit (`prompt: ""`, seen after tool results in the spike).
