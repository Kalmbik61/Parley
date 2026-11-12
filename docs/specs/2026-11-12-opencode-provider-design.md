# OpenCode 2.x as a built-in provider: design

Status: revision 3, waiting for the human's decision. No application code before the human accepts.
- Revision 1 (e4c18e56) was critiqued by s-348 (Codex gpt-6-astra, "revise": 1 blocker, 2 major, 1 minor). This revision answers every finding; the mapping is in appendix A.
- Part O of room r-28. Lead s-345, owner s-320 (2026-11-12).
- Plan: `docs/plans/2026-11-12-opencode-provider-plan.md`.
- Branch: `parley/w-0054/s-345`, the same branch as Parts M, A and Q. Order in the branch: M, A, Q, then O. No push and no PR until the human says so.
- Sources:
  - the brief of s-320;
  - the hands-on spike of s-350, on OpenCode 2.2.7 with a throwaway HOME, a mock model and a mock MCP server (`docs/research/2026-11-12-opencode-2x-spike.md`);
  - the integration map of the Qwen provider work (`docs/plans/2026-11-11-qwen-code-provider-and-cli-install-plan.md`, appendix 1).

## 1. The request

- The human, 2026-11-12: "Let's connect an integration with OpenCode right in this branch."
- The human's decision: support line **2.x only**, because "it is newer".
  - Package: npm `@opencode/cli`, latest 2.2.7.
  - Repository: github.com/anomalyco/opencode.
  - Installer: `curl -fsSL https://opencode.ai/v2/install | bash`.
- Line 1.x (npm `opencode-ai`, 1.19.5) is not a target. Both lines install a command named `opencode`.
- Constraints:
  - no code before the human accepts;
  - junior executors, one task at a time;
  - senior-only tasks named with the reason;
  - Part O must not delay Parts M and A.

## 2. Facts from the spike (OpenCode 2.2.7, darwin-arm64)

**Legend:** **[O]** observed by running; **[S]** read in the binary's strings or its served docs; **[N]** not found or not tested.

1. **Install and version.**
   - **[O]** `npm i --prefix <p> @opencode/cli@2.2.7` installs a 231 MB Bun-compiled binary. It links it as `opencode` and as `opencode2`.
   - **[O]** `opencode --version` prints `opencode v2.2.7`. The 1.x line prints a bare `1.19.5`.
   - **[S]** The curl installer uses `~/.opencode/bin`. It was not run **[N]**.
2. **Config per process [O].**
   - `OPENCODE_CONFIG_CONTENT` (JSON) is merged after the global config. It accepts `mcp`, `permissions`, `model`, `default_agent`, `autoupdate` and `provider`.
   - Nothing is written to user config.
   - With the two-process topology (item 5), the config env must go to the **server** process.
   - An MCP `command` is resolved on the server's PATH, so Parley must pass an absolute path.
3. **MCP tools exist only through Code Mode [O].**
   - The model's tool list is `edit glob grep question read shell skill subagent webfetch websearch write execute`.
   - MCP tools appear in the system prompt as a catalog `tools.<server>.<tool>(args)`. The model calls them from JS in `execute`: `return await tools.parley.ping({...})`.
   - No switch to expose them as plain tools was found **[N]**.
   - Every MCP `tools/call` carries `params._meta["ai.opencode/sessionID"]`.
4. **Permissions [O].**
   - The ordered rule list `permissions: [{action, resource, effect: allow|deny|ask}]` resolves by **last match wins**. `*` wildcards work.
   - The MCP action name is `<server>_<tool>` (`parley_check_inbox`).
   - The default `build` agent is `* allow`.
   - `--auto` on the TUI auto-approves everything that is not explicitly denied.
   - Denying `edit` and `shell` removes those tools from the model's list: enforced by absence.
   - The `plan` agent is not read-only, because `shell` is allowed there.
   - Replies go through `POST /api/session/{id}/permission/{req}/reply {"decision":"once|always|reject"}`.
5. **Server and topology [O].**
   - **Standalone TUI.** A standalone TUI starts its own server on a random loopback port with a random password, which Parley cannot learn.
   - **Topology that works.** Parley starts `opencode serve --hostname 127.0.0.1 --port <p>` with `OPENCODE_SERVER_PASSWORD=<per-session secret>` and the config env. The TUI then runs as `opencode --server http://127.0.0.1:<p>` with the same password in its env.
   - **Authentication.**
     - HTTP Basic, user `opencode`. A wrong or missing password gives 401, or a clear exit of the client.
     - `/health` and `/doc` are unauthenticated.
     - The password is passed only through env, so it is visible to the same user's `ps eww`.
   - **API.** It has 139 operations. `GET /api/info` gives the version, pid and URLs. The session inbox can be listed and cancelled (`/inbox`).
6. **Lifecycle events [O].** SSE `GET /api/event`, one global stream per server. Every `session.*` event carries `sessionID`. For one turn:
   - `session.created`;
   - `session.inbox.enqueued` (prompt submitted);
   - `session.execution.started`;
   - `session.step.*`, `session.reasoning.*` and `session.text.*`;
   - `session.tool.called`, `.progress`, then `.success` or `.failed`;
   - `session.usage.updated`;
   - `session.execution.succeeded` (turn done) or `.interrupted`.

   Permission waits come as `permission.asked` / `.replied`, and MCP state as `mcp.status.changed`. A `failed` execution event was not observed **[N]**.
7. **Session id [O].**
   - `-s/--session ses_<anything>` continues the session, or creates it with that id. Parley can choose the id.
   - Without `-s`, the id is not printed.
   - The same `-s` on an existing id resumes with its history. `-c` continues the last session.
8. **Transcript [O].**
   - `GET /api/session/{id}/message` returns typed messages:
     - `user`;
     - `assistant`, with `content` parts `reasoning` and `text`, plus `finish`, `cost`, `tokens{input,output,reasoning,cache{read,write}}` and `model{id,providerID,variant}`;
     - `idle`.
   - Export works through `GET /api/experimental/session/{id}/export` and `opencode session export <id> --server …`.
   - Storage is SQLite under `XDG_DATA_HOME/opencode/opencode.db`.
   - Reading a closed session without a running server was not tested **[N]**.
9. **Prompt injection [O].** `POST /api/session/{id}/prompt {"text":…}` appears live in the running TUI and is answered (`delivery: "steer"`).
10. **TUI flags [O].**
    - The root TUI has `--server`, `--standalone`, `--auto`, `-c`, `-s`, `--prompt` (auto-submits) and a positional directory.
    - It has **no `--model`, `--agent` or `--variant`**. The model comes from config `"model": "provider/model#variant"`, or per session through `POST /api/session/{id}/model`.
11. **Unattended start [O].**
    - A fresh HOME without auth starts straight into the session, with only a closable "Connect provider" card. There is no sign-in wall and no trust dialog.
    - Update notices are off with `autoupdate: false` (normalized to `update: "disable"`) or `OPENCODE_DISABLE_AUTOUPDATE`.
    - The release-highlights dialog is a `cli.json` setting (`OPENCODE_CLI_CONFIG_CONTENT`, key `highlights` **[S]**). It was not reproduced **[N]**.
12. **Accounts and models [O].**
    - `auth list` signed out prints "No authenticated integrations". `--format json` prints `[]`.
    - `models` lists `provider/model` lines: 12 free `opencode/*` models, plus configured providers. It works offline.
13. **Update [S].** `opencode upgrade [target] --method curl|npm|pnpm|bun|yarn|vp|brew|winget`. It was not run: it can call a global `npm install -g`.
14. **[S] Parley today.** A host restart ends every session's pty: s-349 went to `sleeping` with exit code 129 at the 0.34.0 update (r-28 map, 2026-11-12). Sessions are later resumed by Parley.

## 3. Contract gaps and how Parley closes them

| Gap (spike §) | Design answer |
|---|---|
| TUI server not addressable (5) | Parley owns a per-session `opencode serve` on a loopback port with a per-session password; the TUI attaches with `--server` (§4.2). |
| No hook config (6) | A host **event bridge** subscribes to `/api/event` per session and writes Parley journal events (§4.4). |
| Session id not printed (7) | Parley generates `ses_<uuid>` and passes `-s` on start and resume (`linkBy: 'session-id'`). |
| MCP only through Code Mode (3) | OpenCode-specific tool guidance `tools.parley.<tool>(…)`, like the Codex `exec` text (§4.6). |
| No `--model` (10) | The model goes into the per-session config `model` (§4.7). |
| `plan` agent not read-only (4) | Read-only roles get explicit deny rules (§4.8). |
| 1.x on PATH (1) | A version gate: below 2.0.0 means "OpenCode 1.x found; Parley needs 2.x", with Install/Update (§4.9). |
| Update and highlight prompts (11) | Per-process config: `autoupdate: false` and `OPENCODE_DISABLE_AUTOUPDATE=1`; `OPENCODE_CLI_CONFIG_CONTENT {"highlights": false}`. |
| MCP command on PATH (2) | An absolute path to Parley's MCP server command. |

## 4. Design

### 4.1 Registry entry

- **Identity.** `family: 'opencode'`, `id: 'opencode'`, label "OpenCode", mark `Oc`, `hasHistory: true`, `linkBy: 'session-id'`.
- **Runner.** `command: 'opencode'`, `minVersion: '2.0.0'`, and a new `mcpConfig: 'opencode-server'` route.
- **Args.**
  - `args`: `--server {serverUrl} -s {sessionId} {autoFlag}`.
  - `resumeArgs`: the same, with `{providerSessionId}`.
  - No `{prompt}`: the brief goes through the API (§4.5).
- **Family unions.** `ProviderFamily` and every family union grow. The A1b pattern of the Qwen work applies: every `byFamily` caller gets an `opencode` branch, neutral unless this design says otherwise. The sites that test `providerFamily(...) === 'qwen'` directly are listed in the plan.

### 4.2 Server supervision (senior-only: process lifecycle)

- **Start.** For each launch or resume, the host:
  1. picks a free loopback port;
  2. makes a 32-byte random password;
  3. starts `opencode serve --hostname 127.0.0.1 --port <p>` as a child it owns, in its own process group, with `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CLI_CONFIG_CONTENT` and `OPENCODE_DISABLE_AUTOUPDATE=1`;
  4. waits for `GET /api/info` with Basic auth, within 15 s;
  5. starts the TUI in the pty with `--server http://127.0.0.1:<p>` and the same password in its env.
- **Run record.** The host appends `{sessionRef, pid, pgid, startedAt}` of the server to `<parley-home>/run/opencode-servers.json`. The password and the port are never written.
- **Stop.**
  - When the TUI exits, or the session sleeps or closes, the host first makes one last transcript poll into the cache (§4.11).
  - Then the server group gets SIGTERM, SIGKILL after 2 s, and Parley awaits the exit and removes the run record.
- **Server dies first.** A server that dies while the TUI lives marks the session failed with a readable reason. The TUI is then stopped too.
- **Host dies first** (critique finding 1).
  - A host restart ends the TUI with its pty, as for every family (§2.14). The server would survive it, because it is in its own group.
  - So at start, before resuming any session, the host reads the run file. For every recorded group it lists the live members of that process group (`ps -g <pgid>`), whether or not the leader is still alive. It kills the members whose command line is `opencode` (the server and anything it spawned). If the group's members run something else, the pgid was reused, and nothing is killed. Then it clears the file.
  - The session then resumes as usual: a new server, a new password, and the same `ses_` id. There is never a second server for one session, and no credentials survive the host.
  - The history of the dead run is in OpenCode's own storage and is read by the new server.
  - The last poll of the dead run may be missing from the cache until the new server is polled. This window is at most one poll interval.
- **Never stored.** The password and port live only in host memory and in the two processes' env. They are never written to the map, the journal, the run file or logs.
- **Port race.** Choosing a port by binding 0 and releasing it races with other processes. On "address in use" the host retries up to 3 times with a new port. Whether `serve --port 0` works and reports its port is **[N]**; if it does, the plan uses it instead.
- **Exposure** (critique finding 4).
  - The server binds 127.0.0.1 only. A test checks the bound address.
  - The unauthenticated `/health` and `/doc` are fetched in a test. Their bodies must not contain the session id, the password, the working directory or the user name; a failure blocks release.
  - What they return (version, API description, web UI) is listed in the docs as local exposure while a session runs.

### 4.3 Per-session config (`OPENCODE_CONFIG_CONTENT`)

- **The JSON Parley builds:**
  - `mcp.parley`: `{type: "local", command: [<absolute node>, <absolute Parley MCP entry>], environment: {…Parley MCP env…}}`;
  - `permissions`: the role's rules (§4.8), plus `[{action: "parley_*", resource: "*", effect: "allow"}]` last, so Parley's tools never ask;
  - `model`: the chosen model (§4.7), when one is chosen;
  - `autoupdate: false`.
- **User config is kept.** The human's own config stays in effect, merged before this document.
- **Conflict.** If the human's config already defines an MCP server named `parley`, launch is refused with a readable message. This is checked with `opencode debug config` in a dry run **[N]** whether that works without a server.

### 4.4 Event bridge (senior-only: reconnecting stream, activity state)

- **Subscription.** The host subscribes to `GET /api/event` of each live OpenCode session's server. It reconnects with backoff while the server lives.
- **Mapping.** Events are mapped to Parley journal events in `events/<session>.jsonl`, the same records the hook server writes for other families:
  - `session.created` → SessionStart;
  - `session.inbox.enqueued` → UserPromptSubmit;
  - `session.tool.called` / `.success` / `.failed` → PreToolUse / PostToolUse / PostToolUseFailure, with the tool name and a short detail;
  - `permission.asked` → Notification (permission);
  - `session.execution.succeeded` / `.interrupted` → Stop;
  - `session.usage.updated` → context-fill facts.
- **Own session only.** Events of other session ids on the same server are ignored.
- **Readiness.** The session is ready when `/api/info` answers, `mcp.status.changed` reports `parley` connected, and the TUI process is alive. Then the deferred brief is sent (§4.5).
- **Activity.** busy, idle and blocked follow from the mapped events, as for Qwen.

### 4.5 Brief, pointer and mail delivery

- **Through the API.** The deferred brief, the mail pointer and the limit-return text are sent with `POST /api/session/{id}/prompt {text}`, not typed into the pty **[DO5]**. This needs no screen parsing and works while the TUI is busy: the server queues the prompt (`session.inbox.enqueued`).
- **Fallback without duplicates** (critique finding 2). The host types into the pty only when the API **definitely** did not take the prompt:
  - the connection was refused before the request was sent; or
  - a 4xx answer named a rejection.

  On an ambiguous outcome (timeout, reset after sending, 5xx), the host lists the session inbox (`/inbox`) and the latest messages:
  - if the text is queued or present, nothing more is sent;
  - otherwise it retries the API once;
  - only if the server is gone does it type into the pty.

  A delivery is marked done for the mail pointer only once, so a pointer is never delivered twice.
- **No inline route.** There is no hook to answer, so mail arrives the Codex/Qwen way: the pointer, then `check_inbox` / `wait_for` in Code Mode.

### 4.6 Tool guidance (Code Mode)

- **Bridge text.** OpenCode sessions get a family bridge text, like `CODEX_TOOL_EXAMPLES`:
  - Parley tools are called inside `execute` as `return await tools.parley.<tool>({...})`;
  - with `wait_for` and the `check_inbox` pointer examples;
  - one call per `execute` for mail tools, so the result is the inbox page.
- **Tool profile.** The short profile is used, as for Codex.

### 4.7 Models

- **Catalog [DO7].**
  - The host runs `opencode models` (offline-capable, ≤ 10 s) at host start and every 6 h. It stores `opencode-models.json` the way the Codex and Qwen catalogs do.
  - Ids are `provider/model`.
  - The variant (`#high`) is the effort: `models --verbose` may list variants **[N]**. Without variants, effort is off.
- **Choice.** The chosen model is written to the per-session config `model`, because the TUI has no flag. "Default" omits it.

### 4.8 Roles

- **Read-only roles [DO4].**
  - Read-only roles are enforced with `permissions` deny rules for `edit`, `shell`, `webfetch`, `websearch` and `subagent` (spike §15). Denied tools disappear from the model's list.
  - Code Mode `execute` keeps `fetch` but no filesystem access.
- **What read-only means** (critique finding 3).
  - As for Claude and Codex, read-only means no file writes and no commands in the project.
  - Parley's own tools stay allowed in every role: `send_message`, `report` and the rest. Read-only critics and reviewers need them; their Claude and Codex counterparts have them today.
  - Network reads through `execute` `fetch` remain possible. The role picker says so for OpenCode.
  - A test lists the tools in the model request of a read-only session: no `edit`, `write` or `shell`; `execute` present; Parley tools reachable.
- **Writable roles** use the start mode (§4.10).
- **No native roles.** `modelForTier` gives null.

### 4.9 Install, update, versions, 1.x

- **Descriptor table entry** (`cli-tools.ts`):
  - latest source: npm dist-tags of `@opencode/cli`;
  - install: npm into the user's prefix, or the official curl installer `https://opencode.ai/v2/install`, with its redirect hosts determined once **[N]**;
  - expected binary per method: npm prefix `bin/opencode`; curl `~/.opencode/bin/opencode` **[S]**;
  - update: npm-bound for npm installs; `opencode upgrade --method curl` for curl installs; manual otherwise.
- **Version parse.** `opencode vX.Y.Z` → X.Y.Z. A bare `X.Y.Z` with X < 2 is 1.x.
- **1.x found [DO1].** The provider card and readiness say "OpenCode 1.x found (version); Parley supports 2.x". They offer Install, which puts 2.x first on PATH by the method's rules. Parley never runs a 1.x binary.

### 4.10 Start mode [DO3]

- Writable sessions start the TUI with `--auto`: everything not explicitly denied is approved. This matches "auto-accept at start" for Qwen.
- The permission rules still deny what a role forbids.
- No `yolo`-like bypass exists or is used.

### 4.11 Chat feed [DO6]

- **Core reducer.** A core reducer turns API messages into feed items:
  - `user` → prompt;
  - `assistant` `text` → text;
  - `reasoning` is not shown, as for other families;
  - tool parts → tool items;
  - `idle` → turn close.
- **Mail (Part M parity).** An `execute` tool whose code calls `tools.parley.check_inbox` or `tools.parley.wait_for({target:"inbox"})` and whose output parses as an inbox page gets a `mail` item, through the same core parser. The tool shape is **[N]**: the plan records a fixture first.
- **Live.** The host polls `GET /api/session/{id}/message` every 2 s while the Chat is subscribed and the server lives. SSE events trigger an early poll.
- **Durable cache.**
  - Each poll that changes the list stores the messages in Parley's own cache `<work>/opencode/<session>.json`, capped at 8 MiB.
  - A last poll runs before every planned server stop (§4.2).
  - A reopened Chat or a restarted host seeds from that cache when no server runs. A closed session's Chat therefore keeps its history without starting OpenCode.
  - After a host crash, at most one poll interval of the last run can be missing until the session's next server is polled.
  - `session export` without a server is **[N]**; if it works, it may replace the cache later.
- **Gating.** Chat is gated by host feature `feed-opencode` and `minVersion`, like Qwen.

### 4.12 Sign-in [DO2]

- Parley holds no OpenCode keys. The human signs in inside OpenCode: the TUI's "Connect provider", or `opencode auth login` in a terminal.
- The provider card shows a hint from `opencode auth list --format json`. Only the count of entries is read, and the output is never stored or logged. Whether that JSON holds secrets is **[N]**; the plan checks it in a scratch HOME first.

### 4.13 What does not change

- Other providers, delivery rules, mail semantics, and the inline route (Claude only).

## 5. Risks

- **Size.** This is a provider of the Qwen work's size (A0–A11, B1–B6 there). Two parts here are senior-only, plus a verification.
- **The server password** is visible to the same user through `ps eww`. That is the same trust boundary as the user's own files.
- **`/health` and `/doc`** are unauthenticated on 127.0.0.1 while a session runs. Their contents are tested (§4.2), and any local process or local web page can read them.
- **Code Mode dependence.** A model that does not follow the Code Mode protocol cannot call Parley tools.
- **2.x is young.** The API and event names may change between minor versions. `minVersion` is pinned to the verified version, and the fixtures record the shapes.
- **The cache** duplicates the transcript in Parley's work folder, up to 8 MiB per session.

## 6. Acceptance (Part O)

Checked on the real app with OpenCode 2.x and a mock OpenAI-compatible model (the mock lab), plus one real account if the human has one:

1. **Install.** Install from Settings → Providers gives `opencode v2.x`. A 1.x binary on PATH shows the 1.x message.
2. **Start.** A new session starts unattended:
   - the TUI attaches to its own server;
   - no dialog;
   - `parley` MCP connected;
   - the brief delivered through the API.
3. **Tools and mail.** The agent calls `get_map`, `send_message` and `check_inbox` through Code Mode. A letter sent to it shows as a pointer and then a mail block in Chat.
4. **Activity.** busy and idle follow the turns. A permission ask shows as blocked.
5. **Resume.** Close and resume keeps the session id and history.
6. **Restart.**
   - Restart Host with a live OpenCode session: no `opencode serve` of the old run is left (`ps`).
   - The session resumes with one new server and its history.
   - Reopening Chat shows the history.
7. **Roles.** A read-only role has no `edit` or `shell` in the model request (mock log), and still reaches Parley tools. A writable role starts with `--auto`.
8. **Models.** A model chosen from the catalog is the one used (message `model`).
9. **Cleanup and exposure.**
   - After close, no `opencode` process from that session is left (`ps`).
   - No password appears in the map, the journal, the run file or logs.
   - The server listens on 127.0.0.1 only.
10. **No duplicates.** A pointer sent while the API times out after accepting is delivered once (fake-server test, plus one real check).

## 7. Open choices for the human

Recommended first.

- **DO1. 1.x on PATH.** Show "Parley supports 2.x" with Install (recommended), or also use the `opencode2` command when it exists.
- **DO2. Sign-in.** No keys in Parley: the human signs in inside OpenCode, and the card shows only whether an account is connected (recommended). Or: Parley manages provider keys.
- **DO3. Start mode.** `--auto` (recommended, as asked for Qwen), or edits allowed and commands asked.
- **DO4. Read-only roles.** Enforced with deny rules (recommended). Parley tools stay allowed, as for Claude and Codex, and `execute` `fetch` remains. Or: refused, as for Qwen.
- **DO5. Delivery.** Through the server API with the no-duplicate fallback (recommended), or typed into the terminal as for Qwen.
- **DO6. Chat history of closed sessions.** Parley's own cache (recommended), or Chat only while the session's server runs.
- **DO7. Models.** A catalog from `opencode models` with the model written into the session config (recommended), or only "Default".
- **DO8. Scope.** All of the plan in this branch after Parts M, A and Q (recommended by the order s-320 set), or a first slice without the catalog and roles (DO4 and DO7 later).

## Appendix A. Critique of revision 1 (s-348) and answers

1. **Blocker, host-first death.** The TUI dies with its pty. The server is swept at the next host start from a run file with pids only, checked against the command line. Resume starts exactly one new server (§4.2, §6.6).
2. **Major, duplicate delivery.** The pty fallback runs only on a definite rejection. Ambiguous outcomes check the session inbox and messages first, and a pointer is marked delivered once (§4.5, §6.10).
3. **Major, read-only and Parley tools.** This is stated as intended parity with Claude and Codex read-only roles, which keep Parley tools. The picker discloses `execute` `fetch`, and a test lists the allowed tools (§4.8, DO4).
4. **Minor, unauthenticated endpoints.** The bound address and the bodies of `/health` and `/doc` are tested for identifiers and secrets, and documented as local exposure (§4.2, §5, §6.9).

5. **Major (delta review), leader died first.** The sweep lists the group's live members and kills those running `opencode`, not only a live leader; a reused pgid is left alone (§4.2, plan O5 criterion 7).

The spike report is now in the repository, so the critic can read it: `docs/research/2026-11-12-opencode-2x-spike.md`.
