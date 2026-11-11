# qwen mock lab

Runs the real `qwen` (Qwen Code 0.27.2) against a local mock model, with a throwaway home, so the CLI's hooks,
MCP bridge and transcript can be observed with no credentials and no network. Node 20+; Python 3 only for the
pty driver. Everything binds to `127.0.0.1`.

| File | Role |
| --- | --- |
| `mock.mjs` | OpenAI-compatible mock: `/v1/chat/completions` (stream and non-stream), `/v1/models`. Modes by trigger word in the prompt: `mcpflow`, `shellflow`, `thinkflow`, `autherr` (401), `quotaerr` (429 quota); default: thinking + text. `MOCK_MODE` sets the default. |
| `mcp.mjs` | stdio MCP server, one tool `echo` (`text: "fail"` returns `isError`). |
| `hook.mjs`, `hook-server.mjs` | command-hook and http-hook targets that log the payloads. |
| `gen-settings.mjs` | writes the `QWEN_CODE_SYSTEM_SETTINGS_PATH` file: MCP server `parley` + hooks. |
| `ptyrun.py` | pty driver for the interactive TUI. |

## Run the real qwen

```sh
LAB=<repo>/tools/qwen-mock-lab
W=$(mktemp -d)                      # throwaway work dir
npm install --prefix $W/qwen @qwen-code/qwen-code@0.27.2        # never -g
QWEN=$W/qwen/node_modules/.bin/qwen
mkdir -p $W/home $W/proj

node $LAB/mock.mjs $W/mock.log &                 # writes $W/mock.log.port
node $LAB/hook-server.mjs $W/http.log &          # optional http hook target
sleep 1
node $LAB/gen-settings.mjs $W/settings.json $W/hook.log $W/mcp.log --http-port $(cat $W/http.log.port)

export HOME=$W/home QWEN_HOME=$W/home/.qwen
export OPENAI_API_KEY=mock OPENAI_MODEL=mock-model
export OPENAI_BASE_URL=http://127.0.0.1:$(cat $W/mock.log.port)/v1
export QWEN_CODE_SYSTEM_SETTINGS_PATH=$W/settings.json
cd $W/proj
ID=11111111-1111-4111-8111-111111111111

# 1. headless, MCP flow (tool_search, then tool_call -> mcp__parley__echo), approvals bypassed
$QWEN --session-id $ID --approval-mode yolo -o stream-json "mcpflow" > $W/out.jsonl
# 2. resume appends to the same transcript
$QWEN --resume $ID --approval-mode yolo -o stream-json "second turn" >> $W/out.jsonl
# 3. interactive TUI in a pty: -i prompt, then two typed lines
SEND='again\r|bye\r' python3 $LAB/ptyrun.py 25 $QWEN --resume $ID -i "from pty"
# 4. error modes
$QWEN --approval-mode yolo -o stream-json "autherr" ; $QWEN --approval-mode yolo -o stream-json "quotaerr"
```

Observe: `$W/hook.log` (command-hook payloads), `$W/http.log` (http-hook POSTs with headers),
`$W/mcp.log` (MCP handshake), `$W/mock.log` (requests the model received),
`$QWEN_HOME/projects/<cwd with non-alphanumerics -> "-">/chats/$ID.jsonl` (transcript, appended by steps 2 and 3).

Never point `HOME`/`QWEN_HOME` at the real `~/.qwen`. Stop the background servers when done (`kill %1 %2`).
Fixtures in `packages/core/src/feed/qwen/__fixtures__/` were produced from these runs and sanitized.

## Observed with qwen 0.27.2 (one run of the steps above)

- Command and http hooks both fire for every event (30 payloads each); the http hook carries the configured headers.
- `--resume` appends to the same transcript; step 3 types into the TUI with no blocking prompt.
- `autherr` ends the run at once: `result` with `is_error: true`, text `API Error: 401 Incorrect API key provided: mock.`.
- `quotaerr` (429) is **retried**: 24 requests in 60 s, the run was still going when `timeout 60` killed it. Do not wait for a quick exit; cap the mock with a request counter if a fast failure is needed.
