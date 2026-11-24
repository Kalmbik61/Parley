# opencode mock lab

Runs the real `opencode` 2.2.7 against a local mock model with a throwaway home, so the server API, events and CLI can be
observed with no credentials and no network. Node 20+, zsh; Python 3 only for the pty driver. Everything binds to `127.0.0.1`.
The OpenCode binary is not installed by the lab: point `OPENCODE` at an existing 2.2.7 copy (`<prefix>/node_modules/.bin/opencode`).
Never run it with the real `HOME`; every script below sets a throwaway one.

| File | Role |
| --- | --- |
| `mock.mjs` | OpenAI-compatible mock: streaming `chat/completions`, `reasoning_content`, usage, tool calls. Trigger words in the user prompt: `FULLTURN` (shell, then `execute` → `check_inbox`, then text), `MCPCALL`, `MCPWAIT`, `MCPFAIL` (code throws), `BASHCALL`, `SLOW` (4 s), `LLM400`, `LLM500`; default: reasoning + text. |
| `mcp.mjs` | stdio MCP server `parley` with `check_inbox` (`{"messages":[…]}`) and `wait_for` (`{"state":"message","messages":[…]}` or `{"state":"running"}`); one invented letter, delivered once. Logs to `MCP_LOG`. |
| `env.sh` | The throwaway environment: `HOME`, `XDG_*` under `<dir>/home`, auto-update and model fetch off, server password. |
| `run.sh` | Starts the mock and `opencode serve --port 0` (config injected with `OPENCODE_CONFIG_CONTENT`; `EXTRA_CONFIG` merges more). `run.sh <dir> tui` runs the TUI with `--server` (needs `PORT=<serve port>` and a terminal). |
| `record.mjs`, `sanitize.mjs`, `record.sh` | Drive the server, the CLI items and an orphaned `serve`, then write `recorded/`. |
| `ptyrun.py` | Types lines into a pty (the API key prompt of `auth login`). |
| `record-tools.mjs` | Prints the model's tool list for one `permissions` list (the read-only check, `packages/core/src/work/__fixtures__/opencode-read-only-tools.json`). |
| `FINDINGS.md` | The answers to the open items of the design, with commands and excerpts. |

## Reproduce the fixtures

```sh
OPENCODE=/path/to/opencode-2.2.7 tools/opencode-mock-lab/record.sh "$(mktemp -d)"
```

This rewrites `recorded/`. Check afterwards that no process is left: `ps aux | grep -E 'opencode|mock.mjs'`.
CLI commands without `--standalone` or `--server` start a detached background service; the lab always passes `--standalone`.

## By hand

```sh
W=$(mktemp -d); OPENCODE=/path/to/opencode tools/opencode-mock-lab/run.sh $W      # prints the URL, password lab-secret
curl -u opencode:lab-secret -X POST -H 'content-type: application/json' $URL/api/session -d '{"id":"ses_lab0001"}'
curl -u opencode:lab-secret -X POST -H 'content-type: application/json' $URL/api/session/ses_lab0001/prompt -d '{"text":"FULLTURN"}'
curl -u opencode:lab-secret $URL/api/session/ses_lab0001/message
kill $(cat $W/serve.pid $W/mock.pid)
```
