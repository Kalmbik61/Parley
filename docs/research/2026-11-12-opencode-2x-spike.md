# OpenCode 2.x spike (Part O) — s-350, 2026-11-12

Legend: [O] observed by running; [S] read in installed package / binary strings (binary is a Bun-compiled executable, no readable JS source; "source" = `strings` of the binary and the built-in `opencode` skill text served by `/api/skill`); [N] not found / not tested.

## 0. Setup and versions
- `npm install --prefix <scratch>/prefix2 @opencode/cli@2.2.7` → [O] `dist-tags.latest = 2.2.7`. Installed `@opencode/cli` + `@opencode/cli-darwin-arm64` (optionalDependency, 231 MB Mach-O). `postinstall.mjs` hard-links the platform binary to `@opencode/cli/bin/opencode.exe` (link count 2).
- `opencode --version` → `opencode v2.2.7` (prefix "opencode v").
- 1.x in another prefix: `npm install --prefix <scratch>/prefix1 opencode-ai@1.19.5`; `opencode --version` → `1.19.5` (bare). Only `--version` was checked for 1.x.
- Wrapper used for every run: throwaway `HOME` + `XDG_{CONFIG,DATA,STATE,CACHE}_HOME` in scratchpad, `PATH` without the user's dirs (except node's), `--standalone` or explicit `serve`. No keys. Model = local OpenAI-compatible mock (`lab/mock-llm.mjs`, streaming, scripted tool calls, `reasoning_content`, usage) as a custom provider; MCP = `lab/mcp-ping.mjs` (stdio, tools `ping`, `other`).
- Guard did not refuse anything. No `upgrade` was executed (see §12). All processes killed; `ps` clean at the end. No repo changes.

## 1. Per-process config injection (MCP server) — [O]
`OPENCODE_CONFIG_CONTENT='{"provider":{...},"model":"mock/mock-1","mcp":{"parley":{"type":"local","command":["node","…/mcp-ping.mjs"],"environment":{"X":"y"}}}}'`
- `opencode debug config --standalone` shows it merged as a `document` source after the global dir; it is normalised to the 2.x shape (`mcp.servers.parley`, `providers`). The 1.x key names (`provider`, `mcp.<name>`) are still accepted.
- The server was spawned with the given `environment` and connected (`initialize` → `tools/list`); TUI sidebar showed `• parley Connected`. Nothing was written to user config (`home/cfg/opencode` stayed empty).
- Gotcha [O]: `command` is resolved against the server process's PATH; with a stripped PATH, log says `mcp connect failed … NotFound: ChildProcess.spawn (node …)`. Parley must give an absolute path or keep PATH.
- Related env [S]: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_CONFIG_PROJECT_DISABLE`, `OPENCODE_CLI_CONFIG_CONTENT` (cli.json/TUI prefs), `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_FREE_MODELS`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DB`.
- IMPORTANT: with `--server`, the **server** process owns config/MCP, so the env must be set on `opencode serve`, not on the TUI.

## 2. MCP tools are "Code Mode" only — [O]
MCP tools are NOT in the model's tool list. The request to the LLM lists `edit glob grep question read shell skill subagent webfetch websearch write execute`; the system prompt has a "# Code Mode" catalog (`tools.parley.ping({msg?})`) and the model must call `execute` with JS: `return await tools.parley.ping({msg:"hi"})`. Observed end-to-end: tool event `session.tool.progress` metadata `toolCalls:[{tool:"parley.ping",status:"running"}]`, then `session.tool.success` content `pong:{"msg":"hi"}`. Consequences: real models must follow the Code Mode protocol; tool names reaching Parley-side prompts/skills must be `tools.parley.<name>`. No config switch to turn Code Mode off was found [N] (only searched strings/config accept test).

## 3. MCP approval / pre-allowing one server's tools — [O]
- Default (`build` agent) permissions: `* allow` (see §10) — an MCP call ran with no prompt.
- Permission action name for an MCP tool is `<server>_<tool>` (e.g. `parley_ping`), resource `*`.
- Config rule list (`permissions`: ordered `{action, resource, effect: allow|deny|ask}`, **last match wins**, `*` wildcards in action work): `[{"*","*","ask"},{"parley_*","*","allow"}]` → both `parley_ping` and `parley_other` ran without a prompt while `shell` asked (`permission.asked`, action `shell`, resource = the command). With `[{"*","*","ask"}]` alone, `parley_ping` produced `permission.asked` (save: `["*"]`).
- Reply API: `POST /api/session/{id}/permission/{reqID}/reply` body `{"decision":"once|always|reject"}` (field is `decision`, not `reply`) → 204; event `permission.replied`.

## 4. Lifecycle signals with session id — [O]
SSE `GET /api/event` (Basic auth) is a global stream for the server; every `session.*` event carries `sessionID`. Observed order for one MCP turn:
`session.created` (new session) → `session.inbox.enqueued` (prompt submitted) → `session.execution.started` → `session.inbox.delivered` → `session.step.started` → `session.reasoning.started/delta/ended` → `session.text.started/delta/ended` → `session.tool.input.started/ended` → `session.tool.called` → `session.tool.progress` → `session.tool.success` | `session.tool.failed` (`error.type` e.g. `aborted` "The user declined this tool call") → `session.step.ended` (finish, tokens, cost) → `session.usage.updated` → `session.execution.succeeded` (= idle/turn done) | `session.execution.interrupted` (reason e.g. `shutdown`).
- Waiting for permission: `permission.asked` (id, sessionID, action, resources, metadata, source.messageID/id) and `permission.replied`; also `GET /api/permission/request`, `GET /api/session/{id}/permission`.
- Also `mcp.status.changed {server}`, `session.renamed`, `provider.updated`, etc.
- Per-process plugin route: `plugins` config exists [S]; not needed and not tested [N].
- Map to Parley hooks: started=`session.created`/`session.execution.started`; prompt submitted=`session.inbox.enqueued`; turn idle=`session.execution.succeeded|interrupted|failed?`(failed variant not observed); permission wait=`permission.asked`; tool start/finish=`session.tool.called|success|failed`.
- Bonus [O]: the MCP server itself learns the session id: every `tools/call` carries `params._meta["ai.opencode/sessionID"]="ses_…"` (seen in `mcp.log`).

## 5. Does the TUI expose its server? Address / auth — [O]
- `opencode --standalone` (TUI): the TUI process spawns a child `opencode serve --stdio …` that **listens on 127.0.0.1:<random port>** (`lsof`: `TCP 127.0.0.1:53045 (LISTEN)`), protected by HTTP Basic (user `opencode`, password = a random 43-char `OPENCODE_PASSWORD` generated per process and passed in the child's env). Unauthenticated → 401 `UnauthorizedError` (except `GET /health` 200, and `/doc`). Port and password are not printed; the only ways to get them are `ps eww`/`lsof` (hacky). Setting `OPENCODE_PASSWORD` for the standalone TUI does NOT take effect (verified: fixed value → 401, child had a different random value). No flag for port.
- Recommended topology [O]: Parley starts `OPENCODE_SERVER_PASSWORD=<per-session> opencode serve --hostname 127.0.0.1 --port <chosen>` (with all config env), then the TUI as `OPENCODE_SERVER_PASSWORD=<same> opencode --server http://127.0.0.1:<port> …` (`OPENCODE_PASSWORD` is also accepted by the client). Without the password the client exits: `Error: Server at … requires a password; set OPENCODE_PASSWORD`; wrong password: `Server at … rejected the password`. Server returns 401 for wrong user or no password. `/health` and `/doc`, `/openapi.json`(auth) …: `/health` returns the web UI HTML unauthenticated (info leak is minor, but it is an open loopback port).
- Password can only be passed through env (no CLI flag) → visible to same-user `ps eww`. Port is TCP loopback, not a unix socket [N].
- `GET /api/info` → `{"version":"2.2.7","pid":…,"urls":["http://127.0.0.1:14096"],…}`.
- 139 API operations (`GET /openapi.json`, auth) incl. `session.*`, `permission.*`, `event.subscribe`, `mcp.*`, `config.get`, `model.list`, `fs.*`, `pty.*`.

## 6. Learning the session id at launch — [O]
- `-s/--session <id>`: "Session ID to continue, or to create if it does not exist". Parley can choose the id: `opencode … -s ses_parleySPIKE0001 --prompt "…"` created exactly that id (verified with `GET /api/session/ses_parleySPIKE0001` and `session list`). Id must match `^ses…` (`-s foo` → `Expected a string starting with "ses"`). `POST /api/session {"id":"ses_…"}` also takes an id.
- Without `-s`, the TUI creates a session whose id is not announced on stdout; only `GET /api/session` (newest first) / `session.created` event reveal it. `GET /api/session/active` returned `{"data":{}}` for the idle TUI.
- `OPENCODE_SESSION_ID` appears in strings [S] but was not present in the TUI's env [O]; not usable as an input.

## 7. Resume in the TUI — [O]
- `opencode --server … -s ses_parleySPIKE0002` on an existing session reopens it with history. `-c` continues the last session. `--fork` exists on `run`/`mini` only [O help].

## 8. Transcript, reasoning, usage — [O]
- `GET /api/session/{id}/message` → typed messages: `user`, `assistant` (`content` array with `{"type":"reasoning","text":…}` and `{"type":"text"}`, `finish`, `cost`, `tokens{input,output,reasoning,cache{read,write}}`, `model{id,providerID,variant}`), `idle {outcome:"succeeded"}`. Session object has cumulative `tokens`, `cost`, `time{busy,idle}`, `outcome`.
- Export: `GET /api/experimental/session/{id}/export` and CLI `opencode session export <id> --server …` (JSON `{info, …}`); `session import`. Reasoning only appears if the provider returns it (mock used `reasoning_content`; events show `native.reasoningField`).
- `GET /api/session/{id}/context`, `/diff` exist [S openapi].

## 9. Prompt injection into a running TUI — [O]
`POST /api/session/{id}/prompt {"text":"injected from API"}` (Basic auth) → 200 with a `user` message `delivery:"steer"`; the text appeared live in the running TUI pane and was answered. Other `delivery` values exist in the schema (`Session.Inbox.Delivery`), not enumerated [N]. Also `/interrupt`, `/inbox` list/cancel.

## 10. TUI flags (full) — [O help]
Root (TUI): `[directory]`, `--standalone`, `--server <url>`, `--auto`, `-c/--continue`, `-s/--session <id>`, `--prompt <text>`; global: `--log-level`, `--print-logs`, `--wizard`, `--completions`. **No `--model`, `--agent`, `--variant` on the root TUI** (`--model` prints help and exits). `opencode mini` has `--model provider/model`, `--agent`, `--prompt`, `-c/-s`, `--fork`, `--replay`. `run` has `-m provider/model#variant`, `--agent`, `--format json`, `--auto`, `--title`, `--archived`, `--thinking`, `-f`.
- For the TUI use config instead [O via `debug config`]: `"model":"mock/mock-1#high"` (→ `{providerID, model, variant:"high"}`), `"default_agent":"plan"`. Or switch per session via API `POST /api/session/{id}/model|agent` [S openapi].
- `--prompt` auto-submits at start [O].

## 11. Unattended-start blockers — [O/S]
- Fresh HOME, no auth: TUI started straight into the session; only a non-modal "Getting started / Connect provider" side card (✕ closable). No sign-in wall, no trust dialog.
- Release highlights: setting "Show the release highlights once after OpenCode updates" exists [S] in `cli.json` (`~/.config/opencode/cli.json`, merge override `OPENCODE_CLI_CONFIG_CONTENT`); key name `highlights` [S]. Not triggered on a fresh HOME [O]; could not be reproduced (needs an upgrade between versions) [N].
- Update prompt: config `"autoupdate": false` → normalised to `"update":"disable"`; `"autoupdate":"notify"` → `"update":"notify"` [O debug config]; `OPENCODE_DISABLE_AUTOUPDATE` env [S]. "OpenCode update available" strings [S]; not observed (we were on latest).
- Permission dialog (without `--auto`): modal "△ Permission required … Allow once / Always allow / Reject".
- First `serve`/TUI run also creates `opencode.db` (SQLite) etc. under XDG_DATA_HOME.

## 12. `auth list`, `models`, `upgrade`
- `auth list` signed out [O]: text `No authenticated integrations`; with `--format json` it printed `[]` (flag accepted).
- `models` [O]: 12 lines `opencode/<model>` free models (beam-free, big-pickle, deepseek-v4.1-flash-free, …); with a custom provider also `mock/mock-1`. Output identical with `OPENCODE_DISABLE_MODELS_FETCH=1`, so the list works offline from a bundled/cached catalog; `OPENCODE_DISABLE_FREE_MODELS=1` did not change the count (not conclusive) [O]. Format `provider/model`; `#variant` is a suffix accepted in `-m`.
- `upgrade` [S/O help only]: `opencode upgrade [target] --method curl|npm|pnpm|bun|yarn|vp|brew|winget`. Deliberately NOT executed: it could shell out to `npm install -g`. Disable: `autoupdate:false`, `OPENCODE_DISABLE_AUTOUPDATE`. `opencode uninstall` exists (keeps data).

## 13. Real binary path per install method
- npm (this spike): `<prefix>/node_modules/.bin/opencode` → symlink to `../@opencode/cli/bin/opencode.exe` (a Mach-O copy/hard-link of `@opencode/cli-darwin-arm64/bin/opencode`). The package ships two bin names: `opencode` and `opencode2`. [O]
- 1.x npm: `<prefix>/node_modules/.bin/opencode` → `../opencode-ai/bin/opencode.exe`; only `opencode`. [O]
- curl installer: `~/.opencode/bin` appears in the binary [S] (PATH-line cleanup logic); installer not run. brew/others not checked [N].
- Distinguishing versions: 2.x `--version` = `opencode v2.2.7`; 1.x = `1.19.5`. 2.x name `opencode2` exists only in the 2.x package.

## 14. What if 1.x is on PATH — [O partial]
`opencode --version` returns a bare `1.19.5`. A parser expecting `opencode vX.Y.Z` fails → clean detection point (reject, or fall back to `opencode2` if present). Behaviour of 1.x flags was not tested (not a target).

## 15. Read-only roles — [O]
Permission config can enforce read-only, but not through the built-in `plan` agent:
- `debug agents`: `plan` has `edit * deny` (only `…/.opencode/plan/*` allowed) but `* allow` for `shell`, so it can still write files via `shell`.
- Explicit rules `[{"*","*","allow"},{"edit","*","deny"},{"shell","*","deny"}]` in `OPENCODE_CONFIG_CONTENT` removed `edit`, `write`, `shell` from the tool list sent to the model (request tools: `glob grep question read skill subagent webfetch websearch execute`) — enforced by absence, not by prompt. `webfetch`, `websearch`, `subagent` and Code Mode `fetch` remain and would need `deny` too; MCP (`parley_*`) stayed allowed. Action names: file writes = `edit` (tool `write` asks as `edit`), commands = `shell`, MCP = `<server>_<tool>`.
- Caveat: Code Mode `execute` runs JS with `fetch`; filesystem only through `tools`.

## 16. "Auto-accept at start" equivalent — [O]
- Default `build` agent already has `{"*","*","allow"}` (only `.env` reads ask; `browser` denied) → shell/edit/MCP run without prompts out of the box.
- `--auto` ("Auto-approve permissions that are not explicitly denied") works on the TUI with `--server` (status line `Build auto · …`); with config `* ask` it auto-approved `shell` (no dialog), while without `--auto` the dialog appeared. So the match for "auto-accept" = `--auto` flag at TUI launch (explicit `deny` rules stay enforced by tool removal).

## Contract gaps (what 2.x lacks / complicates for a Parley provider)
1. **TUI has no `--model/--agent/--variant`**; model/variant/agent must be injected via config (`model`, `default_agent`) or API per session.
2. **Standalone TUI server is not addressable**: random port and random password, no flag/env override (`OPENCODE_PASSWORD` ignored) → hooks/transcript/injection require the two-process topology (`serve` + `--server`), i.e. Parley must own the server lifecycle, a free port and cleanup; password only via env (visible to same-user `ps`); `/health` and `/doc` are unauthenticated on that loopback port.
3. **Session id not printed** unless chosen: use `-s ses_<generated>` (must start with `ses`).
4. **MCP tools only via Code Mode `execute`** — prompts/skills telling the model to "call tool X" must use `tools.parley.X`; no way found to expose them as plain tools.
5. **Hooks are not native**: lifecycle comes from SSE `/api/event` (a Parley-side subscriber per session) — no per-process hook/command config like Qwen; plugin path untested.
6. **`plan` agent is not read-only** (shell allowed); read-only roles need explicit `edit`/`shell`/`webfetch`/`websearch`/`subagent` denies.
7. **Version detection**: 2.x `opencode v2.2.7` vs 1.x `1.19.5`; two command names in 2.x (`opencode`, `opencode2`); curl path `~/.opencode/bin`.
8. **Update/highlight prompts** controlled via config (`autoupdate:false`, `cli.json highlights`) — highlights not reproduced; `upgrade` not exercised (can call global npm).
9. **Spawn PATH**: MCP `command` needs absolute path/PATH in the server process.
10. Not covered: real-model reasoning variants, `failed` execution event name, plugin API, curl/brew install, Windows/Linux, permission `always` persistence (`/api/permission/saved`), `delivery` modes.

## Artifacts
Scripts/config under the scratchpad `lab/` (mock-llm.mjs, mcp-ping.mjs, cfg1–5.json, openapi.json, events*.txt) and `oc.sh`.
