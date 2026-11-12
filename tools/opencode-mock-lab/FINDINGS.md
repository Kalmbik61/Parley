# O0 findings: opencode 2.2.7 against the mock lab

All commands ran with a throwaway `HOME` and `XDG_*` dirs (see `env.sh`), the mock model and no real keys. Excerpts are from
`recorded/` (sanitized: paths, host name, pids and ports are replaced). `oc` below is the 2.2.7 binary. Reproduce with
`OPENCODE=<binary> ./record.sh <empty dir>`.

## Item answers

1. **`serve --port 0`: works and prints the port.** `oc serve --hostname 127.0.0.1 --port 0` prints one line
   `server listening on http://127.0.0.1:4096` (real run: a random port; `recorded/serve-orphan.out`). `GET /api/info` →
   `"urls":["http://127.0.0.1:4096"]` repeats it. So the host can pass `--port 0` and read the first stdout line instead of
   choosing a port itself.
2. **`session export` without a server: works with `--standalone`.** `oc session export ses_labfull0001 --standalone`
   reads the SQLite db under `XDG_DATA_HOME` and prints `{"info":{...},"messages":[...]}`
   (`recorded/session-export.json`; message types `user, assistant, assistant, assistant, idle`). `oc session list --standalone`
   prints tab-separated `id  title  date` (`recorded/session-list.txt`). **Without `--standalone` and without `--server`
   every command starts a detached background service** (`opencode serve --service`, parent pid 1, loopback port) and writes its
   password in clear to `XDG_CONFIG_HOME/opencode/service.json` (`{"password": "..."}`). That service survives the command. The
   host must always pass `--standalone` (or `--server`) for CLI reads.
3. **`debug config` without a server: works with `--standalone`.** It prints a JSON array of config sources in merge order. A
   config injected with `OPENCODE_CONFIG_CONTENT` appears as `{"type":"document","info":{"mcp":{"servers":{"parley":{...}}}}}`
   (`recorded/debug-config-injected.txt`); a user file `XDG_CONFIG_HOME/opencode/opencode.json` appears as
   `{"type":"document","path":".../opencode.json","info":{...}}` (`recorded/debug-config-userfile.txt`); the default is only
   `{"type":"directory","path":".../cfg/opencode"}`. Both shapes are normalised (`mcp.servers.parley`). So the "does the human
   already define an MCP server named `parley`" check can run before launch, without a server: look for `info.mcp.servers.parley`
   in the sources. Not checked: project-level `opencode.json` and `OPENCODE_CONFIG` sources.
4. **`auth list --format json` with a configured provider.**
   - Signed out: `[]` (`auth-list-signedout.json`).
   - Key from env (`ANTHROPIC_API_KEY=<fake>`): `[{"id":"anthropic","name":"Anthropic","connections":[{"type":"env","name":"ANTHROPIC_API_KEY"}]}]`.
   - Stored credential (fake key typed into the secret prompt through a pty; `auth login --answer` cannot carry the key, the
     secret prompt needs a terminal): `[{"id":"anthropic","name":"Anthropic","connections":[{"type":"credential","id":"cred_…","label":"Anthropic","method":"key"}]}]`.
   - **No secret is printed**: `grep -c FAKE` on the stored output is 0; only the env var name and a credential id. The command
     that does print secrets is `auth export` ("print stored credentials, including secrets"), output
     `[{"id":"cred_…","integrationID":"anthropic","label":"Anthropic","active":true,"value":{"type":"key","key":"<secret>"}}]`. The
     host must never run `auth export`. Counting entries of `auth list --format json` is safe.
5. **`models --verbose`: not a flag.** `oc models --verbose` fails with `Unrecognized flag: --verbose in command opencode models`;
   `--format`, `--json` and a provider argument fail the same way. `models` takes no options; output is `provider/model` lines
   (12 `opencode/*-free` lines signed out and offline; 34 lines with the stored Anthropic credential:
   `anthropic/claude-haiku-4-5` … `anthropic/claude-sonnet-5-5`). **Variants come from the API**, not the CLI:
   `GET /api/model` lists models with `"variants":[{"id":"none|minimal|low|medium|high|max","settings":{"reasoningEffort":"…"}}]` for
   reasoning models and `"variants":[]` for others (`recorded/models-api.json`, head only). So effort = variant ids of the model.
6. **The `execute` tool part** in `GET /api/session/{id}/message` (assistant message `content` item):
   ```json
   {"type":"tool","id":"call_…","name":"execute","executed":false,
    "state":{"status":"completed","input":{"code":"return await tools.parley.check_inbox({})"},
             "content":[{"type":"text","text":"{\n  \"messages\": [ {\"id\":\"m-1\",\"from\":\"s-1\", … } ]\n}"}],
             "metadata":{"toolCalls":[{"tool":"parley.check_inbox","status":"completed"}],"truncated":false}},
    "time":{"created":…,"ran":…,"completed":…}}
   ```
   The MCP result is the pretty-printed JSON of the tool's text content in `state.content[0].text` (here the `check_inbox` page
   `{"messages":[…]}`). The `shell` part has the same frame: `name:"shell"`, `input:{command,description}`, `metadata:{status,truncated,exit:0}`.
   A throwing `execute` (`throw new Error(...)`) is still `status:"completed"` with `content[0].text` = `Error: boom from execute`
   and `metadata:{"toolCalls":[],"error":true}`; the event is `session.tool.success`, not `.failed`. A `check_inbox` that ran has
   `toolCalls[0].tool == "parley.check_inbox"`, so detection by `metadata.toolCalls[].tool` is possible without parsing `input.code`.
   Assistant messages are one per LLM step: the turn above gave three (shell step, execute step, final text), reasoning in each.
7. **The failed-execution event name: `session.execution.failed`**, preceded by `session.step.failed`. Triggered by a 400 from the
   model: `{"type":"session.execution.failed","data":{"sessionID":"…","error":{"type":"provider.invalid-request","message":"mock model failure","status":400,…}}}`;
   the message list then ends with `{"type":"idle","outcome":"failed","error":{…}}` (`messages-model-error.json`). A 500 is retried
   instead: `session.retry.scheduled` + `provider.internal` per attempt (5 attempts seen in 25 s with a growing back-off), no failure
   event within that time, assistant message with `"retry":{"attempt":5,"at":…,"error":{…}}`. Declined tools stay `session.tool.failed`
   (spike). Idle outcome set seen: `succeeded`, `failed`.
8. **`serve` survives the death of its starter: yes.** `zsh -c "oc serve … & sleep 600"` was killed with `kill -9`; the parent is
   gone, `serve` is alive and answers `GET /api/info` (`recorded/orphan.txt`). `serve` has no lifeline of its own, so the host must
   keep its own (pid file, kill on exit, or the host lifeline from the design).
9. **`/inbox` list with one queued prompt.** While `ses_labqueue001` was busy with a 4 s turn, a second prompt returned
   `{"data":{"id":"msg_…","sessionID":"ses_labqueue001","time":{"created":…},"type":"user","payload":{"text":"second queued prompt"},"delivery":"steer"}}`;
   `GET /api/session/ses_labqueue001/inbox` →
   `{"data":[{"id":"msg_…","sessionID":"…","time":{"created":…},"type":"user","payload":{"text":"second queued prompt"},"delivery":"steer"}]}`
   (`recorded/inbox.json`). The running prompt is not in the list; the list holds only queued items, array under `data`. Event:
   `session.inbox.enqueued`, later `session.inbox.delivered`.
10. **`/health` and `/doc`.** Both return `HTTP 200`, `content-type: text/html`, without auth: the web UI page
    (`<!doctype html><html lang="en" style="background-color: var(--v2-background-bg-deep, #fafafa)">…`), with the same CSP
    headers; neither is JSON, so neither tells a readiness check anything beyond "an HTTP server answers". `GET /api/info`
    needs auth (401 `{"_tag":"UnauthorizedError","message":"Authentication required"}` otherwise) and is the better probe:
    `{"version":"2.2.7","pid":…,"hostname":"…","urls":["http://127.0.0.1:…"],"paths":{"tmp":"…"},"capabilities":{"persistentPty":true}}`.

## Other recorded shapes

- Event stream of the full turn (`events.sse.txt`): `session.created` → `session.inbox.enqueued` → `session.execution.started` →
  `session.inbox.delivered` → per step `session.step.started`, `session.reasoning.*`, `session.tool.input.started/ended`,
  `session.tool.called`, `session.tool.progress`, `session.tool.success`, `session.step.ended`, `session.usage.updated` → final
  `session.text.*` → `session.execution.succeeded`. `mcp.status.changed {server}` and `mcp.resources.changed` come at start;
  `shell.created` / `shell.exited` wrap the shell tool.
- Permission: with rules `[{"*","*","ask"},{"parley_*","*","allow"}]`, `shell` asks and the `execute` → `check_inbox` call does not.
  `permission.asked` data `{id,sessionID,action:"shell",resources:["echo hello-from-shell"],save:["echo *"],source:{type:"tool",messageID,id}}`;
  reply `POST /api/session/{id}/permission/{id}/reply {"decision":"once"}` → 204; `permission.replied` data `{sessionID,requestID,reply:"once"}`.
- Session object (`session.json`): `outcome`, cumulative `tokens`, `time{created,updated,busy,idle}`, `location.directory`.
- `/openapi.json` has 139 paths (`openapi-paths.txt`).

## Not observed

- `wait_for` through `execute` with a real blocking wait (the mock answers at once; `MCPWAIT` mode exists, not recorded).
- A 500 turn to its final failure (the run stops after the 5th retry within the record window).
- `auth login` with API keys outside a pty; browser/oauth methods; the curl installer; `upgrade` (never run, by rule).
- `--auto` and TUI screens: this lab records the server only. `run.sh <dir> tui` starts the TUI against the server but needs a terminal.
- Project-level config sources in `debug config`; Windows/Linux behaviour.
