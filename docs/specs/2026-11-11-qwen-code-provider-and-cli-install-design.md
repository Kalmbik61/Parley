# Qwen Code as a built-in provider, and installing and updating CLIs from Settings → Providers: design

Status: revision 2, waiting for the human's decision.
- Revision 1 (5738e6d9) was critiqued by s-325 (Codex gpt-6-astra, verdict "revise", 15 findings). This revision answers every finding; the mapping is in appendix B.
- Lead s-322, owner s-320, room r-27, spike s-323 (2026-11-11).

Plan: `docs/plans/2026-11-11-qwen-code-provider-and-cli-install-plan.md`.
Branch: `parley/w-0054/s-322` (from `origin/master` 8048054c). Both parts land here.

## 1. The request

The human, 2026-11-11 (translated): "Make Qwen Code ours rather than affiliating it with Claude Code. Also add to the
provider settings the ability to install the always-current version of a CLI (Claude or Codex) and to update it in
the same place. Do all of it within one branch."

Confirmed by the human through s-320 on the same day (r-27, m-7812):

- **Part B is authorized as assumed.** The host installs a missing CLI with the official installer of the latest version. The installed version is always visible, with "Check now" and an "Up to date" state. This covers Claude, Codex and Qwen.
- **No Qwen credentials.** The human will not be asked for them again. Anything that needs a live model turn goes to "Not verified", and those code paths must fail visibly.
- **Budget** does not cut scope.

## 2. Facts

**Legend:**
- **[O]** observed on a real run;
- **[S]** read in source or bundled docs;
- **[N]** not verified.

**Spike setup:**
- **CLI:** `@qwen-code/qwen-code` **0.27.2** (npm `latest`, 2026-11-10), installed into a scratch prefix and run with a throwaway `HOME`/`QWEN_HOME`.
- **The model in every live run was a local OpenAI-compatible mock** on 127.0.0.1 with a fake key, plus a one-tool stdio MCP mock.

**Evidence:** the spike report and its addendum A1–A10. Copies sit in the s-322 scratchpad, `spike/qwen-spike-report.md`, along with `spike/lab/`, `spike/home2/`, `spike/home3/` and `spike/dl/install.sh`. Plan task A0 versions the lab and sanitized fixtures in the repo, because scratchpads are temporary.

### 2.1 Qwen Code CLI

| # | Fact | Mark | Evidence |
|---|---|---|---|
| Q1 | `QWEN_CODE_SYSTEM_SETTINGS_PATH=<file>` loads a settings file per process. Its `mcpServers` connect and its `hooks` fire. | O | report §1 |
| Q2 | The variable **replaces** the standard system file: macOS `/Library/Application Support/QwenCode/settings.json`, Linux `/etc/qwen-code/settings.json`. The standard file is then not read. A project `.env` cannot set the variable. | S | addendum A5 |
| Q3 | Settings merge: the user `~/.qwen/settings.json`, the system file and `--mcp-config` are unioned. On a server-name clash between user and system, the system definition wins. User and system hooks both fire. | O | §1 |
| Q4 | Precedence, low to high: defaults < system defaults < user < project < system < env < flags. Project-scope MCP servers and hooks need a one-time approval; system-scope ones do not. | S, O | §1, §2 |
| Q5 | There is no `--settings` flag. `--mcp-config <json\|file>` exists, and `"trust": true` set through it works. Hooks come only from settings files. | O | §1, A10 |
| Q6 | `QWEN_HOME` moves `~/.qwen`, including all state. | O | §1 |
| Q7 | A stdio MCP server from the system file starts without a trust prompt. | O | §2 |
| Q8 | MCP tools are **deferred** by default: the model sees `tool_search` and `tool_call`. `tools.toolSearch.enabled: false` declares MCP tools directly. This is a global switch for every merged server. It was observed with a one-tool mock only. | O | §2, A3 |
| Q9 | `--approval-mode default` asks before an MCP tool call ("1 once / 2 always in project / 3 always for user / 4 no") and fires `Notification` `permission_prompt`. `"trust": true` on the server skips the question for every tool of that server. A read-only shell command (`echo hi`) was auto-approved in default mode. | O | §2 |
| Q10 | Without auth, the TUI stops at a "Connect a Provider" picker. SessionStart has already fired at that point, and no other hook fires. With `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL`, it starts in under 6 s and fires `Notification` `auth_success`. Folder trust is off by default. | O | §2, A7 |
| Q11 | A fresh `QWEN_HOME` starts in `auto` approval mode (LLM-classifier approvals). `--approval-mode plan\|default\|auto-edit\|auto\|yolo` sets the mode. | O | §2, §7 |
| Q12 | Hooks fire in an interactive pty: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop (once per turn), Notification (`idle_prompt` after every turn, `permission_prompt`, `auth_success`). 24 events exist. Hook types: command, http, function, prompt. The `http` type was not exercised. | O (fired), S (list, types) | §3 |
| Q13 | Hook payloads carry `session_id, transcript_path, cwd, hook_event_name, timestamp, permission_mode`. Stop adds `last_assistant_message, context_usage, context_limit, input_tokens`. After tool results, a second UserPromptSubmit arrives with `prompt: ""`: a model follow-up, not a user turn. | O | §3 |
| Q14 | SessionStart and UserPromptSubmit can add context through stdout or `additionalContext`. | S | A8 |
| Q15 | `--session-id <uuid>` sets the id, which is used verbatim in hooks, stream-json and the transcript name. | O | §4 |
| Q16 | The transcript is `$QWEN_HOME/projects/<cwd, each non-alphanumeric → "-">/chats/<id>.jsonl`. This encoding is lossy. `--resume <id>` and `--continue` append to the same file and keep the id. | O, S | §4, A6 |
| Q17 | Transcript records: `user` (`provenance: real_user`); `assistant` (`message.parts[]`: `text`, `thought: true`, `functionCall`; `usageMetadata`); `tool_result` (`functionResponse`, `toolCallResult.status`); many `system` lines (telemetry, memory snapshots). Samples are in appendix A. | O | §5 |
| Q18 | After each turn a background memory extractor makes a second model call. `memory.enableManagedAutoMemory: false` and `memory.enableManagedAutoDream: false` remove it: one request per turn instead of two, on the mock. | O | §5, A3 |
| Q19 | A positional prompt is one-shot. `-i <prompt>` runs the prompt and stays interactive. `--append-system-prompt` and `-m` work in a pty. Writing `text\r` in one write submits a turn. Bracketed paste was not tried. `/compress` exists. | O | §6, A4 |
| Q20 | `qwen --acp` answers `initialize` and `session/new`. `-o stream-json` gives Claude-shaped events. | O | §6 |
| Q21 | Auth types: openai, openai-responses, anthropic, qwen-oauth, qwen-subscription, gemini, vertex-ai. Qwen OAuth is interactive and browser-only, inside `/auth`. `qwen auth` was removed. | O, S | §8 |
| Q22 | OAuth credentials are stored in `$QWEN_HOME/oauth_creds.json`. The non-secret `security.auth.selectedType` sits in `$QWEN_HOME/settings.json`. Env-only auth leaves no trace in files. | S, O | A9 |
| Q23 | `general.enableAutoUpdate: false` turns off the startup check and auto-install. `qwen --version` prints `0.27.2`. | S, O | §9 |
| Q24 | `qwen update` is non-interactive: exit 0 when up to date or updated, exit 1 on failure. **A standalone install updates itself. npm, pnpm and brew installs only print the command to run and exit 0.** | S | A2 |
| Q25 | The npm install is `npm install -g @qwen-code/qwen-code@latest` and needs Node ≥ 22. The realpath of `qwen` then lies inside `node_modules/@qwen-code/qwen-code`. | O, S | A1 |
| Q26 | The standalone installer is `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh` (not run). It: verifies a SHA-256-checked archive; unpacks to `~/.local/lib/qwen-code/`; writes the wrapper `~/.local/bin/qwen` and `~/.qwen/source.json`; edits the shell rc unless `--no-modify-path`; asks no questions. `--method detect`, the default, falls back to npm through `registry.npmmirror.com`; `--method standalone` does not. | S | A1 |
| Q27 | The latest version is npm `dist-tags.latest`. Many experimental dist-tags exist and are ignored. The Brew formula is `qwen-code`. | O, S | §9, A1 |

### 2.2 Parley today

**Families.**
- `ProviderFamily = 'claude'` is the only family (`core/src/providers.ts:30`), and Codex has no family. About 62 files branch on `id === 'codex'` or `isClaudeCode(...)`.
- At least these sites treat "not codex" as Claude:
  - `host/src/activity/log-index.ts:118, 409-414, 507-511`
  - `host/src/hooks/hook-server.ts:328`
  - `host/src/hooks/inline-mail.ts:60`
  - `host/src/feed/feed-service.ts:794-805, 851`
  - `host/src/compaction/compaction-service.ts:40`
  - `host/src/pty/process-monitor.ts:44`
  - `host/src/context/context-service.ts:64`
  - `core/src/work/room-usage.ts:83`
  - `core/src/work/role-choice.ts:23`
  - `core/src/watch.ts:55-85`
  - `host/src/activity/activity-service.ts:656, 714, 1130, 1153`
  - `desktop/src/renderer/lib/feed-view.ts:49-53`
- No exhaustive switch exists.

**Host launch gates.**
- `host/src/sessions/sessions-service.ts:734-745` gives a hook URL only to Claude-family and Codex sessions, gated on version. Lines 1314-1324 register a hook token only when that URL exists.
- `core/src/work/launch.ts:321` treats MCP as present only when the argv template contains `{mcpConfig}`. Browser guidance depends on this (line 571).

**Roles.**
- `core/src/work/agents.ts:129-199` validates role delivery with a Claude or Codex flag grammar. It fails closed for any other template, and read-only delivery exists only for Claude (`--disallowedTools`) and Codex (`sandbox_mode`).
- Built-in roles planner, critic, reviewer, architect, feature-lead and researcher are read-only (`core/src/roles/builtin.ts`).

**Durable events.**
- `core/src/work/events.ts:235-259` drops the prompt text from journal records.
- `core/src/work/activity.ts:434-454` treats every UserPromptSubmit as a new turn and SessionStart as ready for input.

**Pty input.**
- `host/src/pty/send.ts:105-135` and `type-and-submit.ts:69-118` use bracketed paste and a separate delayed submit. They check draft, PID and blocked state, with Codex-specific submit keys.

**Claude permissions.**
- Ordinary Claude sessions pre-allow only browser tools and `close_session`.
- The whole Parley server is allowed only in autonomous mode (`core/src/work/settings-file.ts:254-256`).
- Claude workspace sessions run with `--permission-mode auto` (`launch.ts:633`).

**Session settings files.**
- `settings-file.ts:275-330` writes them with checks against redirected parents and leaves.

**Qwen today.**
- Qwen exists only as the custom preset `qwen` (`desktop/src/renderer/components/providers/custom-presets.ts:96-126`): Claude Code pointed at Alibaba's Anthropic-compatible endpoints, with `family: 'claude'`.
- A `qwen` CLI listed in `providers.json` gets a bare terminal.

**Updates.**
- `core/src/cli-updates.ts` and `host/src/providers/updates.ts` know only `codex` and `claude`.
- The daily check skips CLIs that are not installed (`updates.ts:156-157`) and reports only "newer and not skipped". It cannot be forced.
- `update-run.ts` runs `<binary> update` as follows:
  - `shell: false`, in its own process group;
  - 5 min timeout, keeps the last 4 KB of output;
  - per-command busy guard;
  - strips only Codex install markers from the env (`:58-63`; `agentEnv` strips three parent-session markers, `providers.ts:731-741`);
  - success means the version grew or equals the latest (`:145-148`);
  - the method is absent from the remote and island allowlists.

**Install.**
- `provider-install.ts` shows copy-only commands.
- On record: "Parley installs and downloads nothing" (`docs/specs/2026-10-02-providers-connect-design.md:66`).
- The README lists Parley's network requests (`README.md:122-127`). The version checks are already missing from that list.

**UI.**
- The update row draws nothing unless a newer version is known.
- "Check again" only reloads the list.

**PATH.**
- The host PATH is captured once at app launch (`desktop/src/main/shell-env.ts`).

## 3. Part A: Qwen Code as a built-in provider

### 3.1 Integration route

| Route | Gives | Cost | Verdict |
|---|---|---|---|
| **pty + per-process system settings file + transcript tail** | The real Qwen TUI in Parley's terminal, sign-in inside it, hooks for state, the transcript for Chat, `--session-id` and `--resume`: the same shape as Claude | New parser, hook mapping, watcher and typing strategy | **Chosen** |
| ACP (`qwen --acp`) | Structured events and permissions | No terminal; needs a new ACP client and UI, including sign-in; `session/prompt` not verified | Rejected for v1 |
| `-o stream-json` | Claude-shaped events | One-shot; multi-turn over stdin not verified | Rejected for sessions |

The reason: Parley's promise is the unmodified official CLI in a terminal the human sees and types into. Every piece
of that is observed for Qwen (Q1, Q7, Q12, Q15–Q17, Q19).

### 3.2 Family model

- `ProviderFamily` becomes `'claude' | 'codex' | 'qwen'`.
- Codex gets `family: 'codex'`.
- A helper `providerFamily(entry)` replaces the open-coded checks wherever a family is meant.
- Custom providers and Claude accounts stay `claude`. `providers.json` entries stay family-less.
- Every site of §2.2 becomes an explicit family check, and new family switches are exhaustive (`never`). The full inventory is plan appendix 1.
- Intentional behaviour changes, listed so they are not mistaken for regressions:
  - a family-less `providers.json` CLI takes the neutral path, where today it wrongly takes the Claude path;
  - the wire field `providers.list.family` shows `"codex"` for Codex instead of `null`.
- Claude, Codex, GLM, custom and account providers keep their behaviour. A synthetic `qwen` entry and an unknown family are tested on every converted site **before** the real entry is registered.

### 3.3 Launch

**Registry entry.**
- Id `qwen`, label "Qwen Code", command `qwen`.
- `family: 'qwen'`, `linkBy: 'session-id'`, `hasHistory: true`, `minVersion: '0.27.2'`.
- New MCP route kind `mcpConfig: 'qwen-system-settings'`. `launch.ts` decides "MCP present" by this route kind, not by the `{mcpConfig}` placeholder, so `find_skill` and browser guidance reach qwen sessions.

**Argv.**
- New session: `qwen --session-id {sessionUuid} --approval-mode {approvalMode} --append-system-prompt {systemPrompt} -m {model} -i {prompt}`.
- Resume: `qwen --resume {providerSessionId}` with the same flags, without `--session-id`.
- Empty substitutions drop their pair.

**Env.**
- `QWEN_CODE_SYSTEM_SETTINGS_PATH=<per-session file>`, plus Parley's usual env.
- Parley never sets `QWEN_HOME`, `OPENAI_*` or keys.

**Host gates.**
- `sessions-service.ts` gives qwen a hook URL and a token when `qwen` ≥ `minVersion`, registers and cleans up the token like Claude, and applies the same to resume.

**The per-session system settings file** is written with the protected writer of `settings-file.ts` (redirect checks, `0600`). It is built in this order.

1. **Base.**
   - The effective original system file is the one Qwen would read without Parley: the inherited `QWEN_CODE_SYSTEM_SETTINGS_PATH` if the host env has one, else the platform default.
   - If that file is **absent**, there is no base.
   - If it **exists but is unreadable, not a regular file, or not valid JSON**, the launch is refused. The message names the file; nothing is silently dropped.
   - Otherwise its content is the base, and all of its keys are kept.
2. **Required keys.** If the base makes integration impossible, the launch is refused with a message naming the key. Those cases are:
   - it defines a server named `parley`;
   - `mcp.allowed` excludes `parley`, or `mcp.excluded` includes it;
   - hooks are disabled globally.
3. **Parley additions.**
   - `mcpServers.parley`: the same stdio command and env Claude gets, with trust per D7.
   - Hook groups for SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, Notification and PermissionRequest: the `cat >>` journal command plus the HTTP feed hook. They are appended to any base groups.
4. **Defaults Parley sets only when the base does not set them:**
   - `general.enableAutoUpdate: false`;
   - `tools.toolSearch.enabled: false` (D8);
   - the memory switches (D9).
   - If the base sets one of them, the base wins and the session notice says so. Parley never relaxes an administrator's value.

**HTTP hooks.** The required route for state and Chat is the HTTP hook. The command journal is the durable record (restart and replay), not a silent substitute. If the qwen version or the host cannot provide the HTTP route, the session runs as a bare terminal, and the card and Chat say so. Plan task A4 proves that the `http` hook type works on the mock lab before any dependent task.

**Approval mode** follows D6. `--yolo` is never used.

### 3.4 Readiness, state, mail

**Normalization.** One contract serves both the live HTTP path and the journal/replay path (`core/src/work/events.ts`, `activity.ts`). The journal record keeps only non-secret facts:
- `promptEmpty` for UserPromptSubmit;
- `notificationType`;
- `contextUsage` and `contextLimit` from Stop.

**Hook mapping:**

| Hook | Activity |
|---|---|
| UserPromptSubmit with `promptEmpty: false` | turn started (`promptEmpty: true` is ignored, on live and on replay) |
| PreToolUse / PostToolUse | tool activity |
| Stop | turn finished, idle |
| Notification `permission_prompt` / PermissionRequest | waiting for the human in the terminal |
| Notification `idle_prompt` | idle |
| StopFailure | turn failed, shown as stuck with the message |
| SessionEnd | exited |

**Readiness state machine** (per process; replaces Claude's "SessionStart = ready"):
- `starting`: from spawn.
- SessionStart → `started`. It is **not** ready, because Q10 shows SessionStart under the auth picker.
- `auth_success`, the first UserPromptSubmit with `promptEmpty: false`, or `idle_prompt` → `ready`.
- `started` past the grace (the existing startup grace) → "Qwen needs attention at startup (sign-in or a dialog): see the terminal". It does not assert that sign-in failed.
- Later evidence of readiness clears the state.
- Nothing is typed into the pty before `ready`.

**Mail and typing.** This is a Qwen-specific typing strategy, not the Codex one.
- It keeps every guarantee of `send.ts` and `type-and-submit.ts`: the human's draft, the human typing at the same time, process-generation and PID checks, blocked-dialog recheck, sanitization, retry and dedup.
- The submit is `text` and then `\r`, written as observed (Q19). Bracketed paste is used only if A6 proves it.
- An idle session that is `ready` but has never run a turn gets mail too.
- Inline hook delivery (Q14) is excluded for qwen in v1.

**Context fill** comes from `contextUsage`.

**Compaction** sends `/compress`.

### 3.5 History, transcript binding, Chat view

**Binding.**
- The session id is `{sessionUuid}`. SessionStart's `transcript_path` is stored in the session map as the binding, so it survives a host restart.
- Before a binding is used, the first transcript records are checked for `sessionId` equal to the binding and `cwd` equal to the session cwd.
- The lossy directory encoding (Q16) is never decoded into a cwd.

**Discovery and watching.**
- A qwen `WatchSource` (`core/src/watch.ts`) watches `<qwenHome>/projects/*/chats/*.jsonl`.
- The `log-index.ts` registration and reindex dispatch get a qwen branch. A generic reindex never reads qwen files as Codex.
- Tests cover: creation after host start, append, a partial last line, truncation, missed watch events with periodic rescan, a host restart with no new hook, and the same native id under two families.

**Parser.** `core/src/feed/qwen/` turns records into feed items:
- user records with `real_user`;
- assistant text and thinking;
- tool calls, using the inner MCP name of the `tool_call` wrapper;
- tool results with their status;
- usage.

`system` records are skipped. Unknown types are counted and skipped.

**Feed ownership.**
- The transcript owns the turn, message and tool items.
- Hooks own only state: busy, idle, waiting and stuck.
- The feed `onHook` path gets an explicit qwen branch that creates no transcript-like items and no permission cards. Qwen approvals are answered in the terminal in v1, and the Chat view shows "waiting for approval in the terminal".

**Resume.** Sleep and wake use `--resume <id>`.

**Qwen home.** One resolver `qwenHome(env)` returns `$QWEN_HOME` from the host env, else `~/.qwen`. Launch, discovery, card state and tests all use it.

### 3.6 Models, sign-in hints, card, roles

**Models.**
- "Default" (no `-m`) or a typed model id.
- The card shows `model.name` from `<qwenHome>/settings.json` if present.
- No effort.

**Sign-in hints.** These are hints, never an authentication verdict.

| Found | Card text |
|---|---|
| `security.auth.selectedType` | "Configured: <type>" |
| `oauth_creds.json` (presence only) | "Qwen account sign-in found" |
| `OPENAI_API_KEY` in the host env (presence only) | "Key found in environment" |
| none | "Sign-in not detected: start a Qwen session and use /auth in the terminal" |

Parley reads only `model.name` and `security.auth.selectedType`, never logs the file and never opens the credential file.

**Card.** Settings → Providers next to Claude, Codex and GLM, with an icon, a status bar segment and the Part B rows.

**Roles** (D10):
- Built-in roles that are **not** read-only (executor, debugger, verifier) run on qwen through `--append-system-prompt`.
- Read-only roles stay **refused** on qwen with the existing `role-permissions-unavailable` error. Qwen has no enforcement Parley has verified: `--approval-mode plan` and `--exclude-tools` are [N].
- Native Claude and Codex roles do not fit qwen.
- `assertRoleDelivery` gets an explicit qwen grammar. Qwen's flags are `--session-id`, `--resume`, `--approval-mode`, `--append-system-prompt`, `-m` and a trailing `-i {prompt}`. The fail-closed behaviour is kept for everything else.
- `modelForTier` gives `null` for qwen.

### 3.7 v1 includes and excludes

**Includes:**
- the family refactor;
- launch and resume;
- the settings file;
- readiness, state, mail and stuck;
- the parser, watcher, Chat view and history;
- the card with hints;
- non-read-only built-in roles;
- Part B for qwen;
- the stub and mock lab;
- the preset rename.

**Excludes:**
- several Qwen accounts;
- Parley-held keys (D5);
- usage and limit readers;
- the capabilities panel;
- read-only roles on qwen;
- autonomous rooms, the one-shot assistant, swarms and phone launch on qwen;
- ACP and stream-json;
- effort and a model catalog;
- inline hook mail;
- approval cards in Chat.

## 4. Part B: install and update from Settings → Providers

### 4.1 One descriptor per CLI

New `core/src/cli-tools.ts` replaces the hard-coded pairs in `cli-updates.ts`, `updates.ts`, `update-run.ts` and `provider-install.ts`:

| | claude | codex | qwen |
|---|---|---|---|
| Latest version | npm dist-tags of `@anthropic-ai/claude-code`, channel from Claude settings (as today) | GitHub releases, or the brew cask API (as today) | npm `dist-tags.latest` of `@qwen-code/qwen-code` |
| Install method | npm / native (as today) | npm / standalone / brew (as today) | npm (realpath in `node_modules/@qwen-code/qwen-code`) / standalone (`~/.local/lib/qwen-code/` and the `~/.local/bin/qwen` wrapper) / brew / unknown |
| Update | `claude update` | `codex update` | standalone: `qwen update`; npm: bound npm route (§4.3); brew or unknown: manual command only |
| Install (macOS, Linux) | script `https://claude.ai/install.sh` with bash | script `https://chatgpt.com/codex/install.sh` with sh | D2 |
| Expected binary | `~/.local/bin/claude` | `~/.local/bin/codex` | `~/.local/bin/qwen` (standalone) |
| Smoke | `claude --version` | `codex -c check_for_update_on_startup=false --version` (as today) | `qwen --version` |

On Windows, Install and the bound npm route show copy-only commands.

### 4.2 Running an installer

`providers.install {provider}` runs on the host. The runner is extracted from `update-run.ts` and shared with update.

1. **Constant argv.** Only built-in commands from the table. Nothing from the request or from settings reaches the argv.
2. **Download, then run.**
   - The host downloads the script over HTTPS from the constant URL. Redirects are allowed only to HTTPS, the body is capped at 1 MB and the timeout is 15 s.
   - The script goes into a fresh `0700` temp dir and runs as `[/bin/bash --noprofile --norc | /bin/sh, <file>, …constant args]` with `shell: false`.
   - Nothing is piped from the network into a shell. The SHA-256 and size are logged, and the temp dir is removed.
3. **Installer env.** It starts from `agentEnv` with the update scrub, then:
   - **removes** shell startup and runtime injection variables: `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `NODE_OPTIONS`, `NODE_PATH`, `npm_config_*`, `NPM_CONFIG_*`, `npm_package_*`;
   - **keeps** proxy and CA variables deliberately: `HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`.
   - For npm routes it passes `--registry=https://registry.npmjs.org/` and `--userconfig=<empty temp file>`. If the global npmrc sets a scoped registry for `@qwen-code`, the action refuses with the reason.
4. **No sudo, ever.** A permission failure shows the error and the manual command.
5. **Process control.**
   - Own process group, 10 min timeout.
   - The group is killed on timeout and on host shutdown.
   - The last 4 KB of output are kept.
   - Install and update share the per-CLI busy guard.
6. **Locating the binary afterwards.**
   - The shared resolver looks for this command on the host PATH, then at the table's **exact expected binary** for this command only. `PARLEY_<CMD>_BIN` overrides both.
   - The host PATH is not changed, so other executables in that dir are unaffected.
   - The fallback works after a restart too, because the resolver always checks it.
   - If the binary was found only through the fallback, the result carries `pathNote`: "<dir> is not on your shell PATH; Parley finds qwen there".
7. **After locating.** The host probes the version of that exact binary, runs the smoke, broadcasts `providers.changed` and re-checks the latest version.
8. **Success** requires all of: exit 0, no timeout, a version on the resolved binary, and a passing smoke. Otherwise the result carries the error, the output tail and the manual command.
9. **Allowlists.** `providers.install`, `providers.checkUpdates` and `providers.update` go into `REMOTE_FORBIDDEN` and stay out of `ISLAND_METHODS`.
10. **Confirmation.** The window shows the exact command and the source URL. It also says plainly what is trusted: "This downloads the vendor's installer and runs it as you. Parley logs its fingerprint but cannot verify the vendor's code or what the installer downloads." For profile effects it shows the D3 choice.
    - The host does not rely on this confirmation; the constant argv and env policy are the guarantee.

### 4.3 Update binding (npm)

The npm route updates the installation Parley launches, and only that one.

1. Resolve the active binary's realpath, then `<prefix>` from `<prefix>/lib/node_modules/@qwen-code/qwen-code`.
2. Require `<prefix>/bin/node` (or the node on whose bin the wrapper sits) and `<prefix>/lib/node_modules/npm/bin/npm-cli.js` to exist.
3. Check that node against `engines.node`.
4. Run `[<node>, <npm-cli.js>, 'install', '-g', '--prefix', <prefix>, '--registry=https://registry.npmjs.org/', '--userconfig', <empty>, '@qwen-code/qwen-code@latest']`.

If any part cannot be bound, the route returns the manual command and runs nothing. It never falls back to the npm on PATH.

**Success** follows the existing rule: the same resolved binary reports a version that grew or equals the latest. An unchanged older version or a downgrade is a failure.

### 4.4 Status always visible, Check now

- `updates.ts` checks the latest version for missing CLIs too. The cache keeps `{latest, checkedAt, method, skipped, lastError}`.
- Each `providers.list` item for the three CLIs gets `cli: { installed, latest, method, checkedAt, state: 'missing'|'up-to-date'|'available'|'skipped'|'unknown', lastError }`. `update` stays as is for the phone and island.
- `providers.checkUpdates {provider}` forces a fresh probe and a fresh fetch. The host allows at most one per CLI per 10 s.
- The row is always drawn for an installed CLI:
  - `Claude Code 2.1.340 · Up to date · checked 14:05 · [Check now]`
  - `Codex 0.162.0 → 0.166.0 · standalone · [Update] · Skip this version · [Check now]`
  - `Qwen Code 0.27.2 → 0.28.0 · skipped · [Update anyway] · [Check now]`
  - `Codex 0.162.0 · Could not check (offline) · checked 09:12 · [Check now]`
  - `Qwen Code 0.27.2 → 0.28.0 · brew · update with: brew upgrade qwen-code · [Copy]`
- A missing CLI shows `Not installed · latest X · [Install…] · [Copy command] · Guide`.
- The status bar "↑" covers qwen.

### 4.5 README and earlier decisions

- **README "How it works":**
  - Parley starts the official CLIs from your PATH and installs or updates them only when you press Install or Update.
  - Parley's own requests include the daily version check (npm registry, GitHub, brew cask API) and installer downloads.
- **Earlier decision:** "Parley installs nothing" (2026-10-02) is superseded by this spec. The header of `provider-install.ts` changes too.

## 5. The existing Qwen custom preset

The preset is kept, as the route for Alibaba Coding Plan and Token Plan keys through Claude Code. Its label becomes
**"Qwen models in Claude Code (Alibaba key)"**. Its id and the existing `custom-*` providers do not change (D4).

## 6. Security

**Installers.** The guarantees are:
- a constant argv and URL;
- HTTPS only;
- download, then run;
- a controlled env: no startup injection, a forced registry, an empty npm userconfig;
- the npm route bound to the active install;
- no sudo;
- a click plus a confirmation that states the real trust boundary;
- no phone or island route;
- a timeout and a group kill.

What is **not** guaranteed: the vendor's code, and whatever the installer itself downloads. The logged fingerprint gives auditability, not verification. Script hashes are not pinned, because vendors change the scripts without notice.

**Qwen settings file.**
- The administrator's system file is preserved or the launch refuses.
- No administrator value is relaxed.
- The trust of Parley's MCP server is an explicit human decision (D7). Server-side authorization of Parley tools is unchanged either way.

**Qwen credentials.** Parley reads two non-secret keys and checks presence only for the credential file and env keys.

**Read-only roles** stay refused on qwen until enforcement is proven.

## 7. Decisions for the human

The install/update scope is already authorized (§1). The README and the superseded 2026-10-02 rule change as described in §4.5. The decisions left:

**D2. Qwen installer.**
- (a) The standalone script with `--method standalone`. It needs no Node and updates itself through `qwen update`; the binary lands in `~/.local/bin` like Claude and Codex. The source is Alibaba's CDN (Hangzhou).
- (b) npm from the official registry. It needs Node ≥ 22 on the host; this machine has 22.23.3.
- Recommendation: (a).

**D3. Shell profile edits by the qwen installer.**
- (a) Allow the installer's default, which adds `~/.local/bin` to the shell profile so `qwen` works in your own terminal.
- (b) `--no-modify-path`: Parley still finds qwen through §4.2.6.
- Recommendation: (a), stated in the confirmation. The Claude and Codex scripts run with their own defaults; their profile behaviour is not verified.

**D4. Preset rename** to "Qwen models in Claude Code (Alibaba key)".
- Recommendation: yes.

**D5. Qwen keys in Parley.**
- v1 uses only Qwen's own sign-in (`/auth`) or your environment.
- Recommendation: no Parley-held key in v1.

**D6. Qwen approval mode.**
- (a) Mirror Claude: `--approval-mode auto` in workspace sessions (Claude has `--permission-mode auto` there) and `default` elsewhere.
- (b) `default` everywhere: edits and non-read-only shell commands wait in the terminal. Read-only shell was auto-approved on the mock.
- `auto` uses an LLM classifier that adds model calls (not measured).
- Recommendation: (a).

**D7. Trust of Parley's MCP server.**
- (a) `"trust": true` on the `parley` server. Every Parley tool, including mutating ones and future ones, runs without a question in the terminal. Ordinary Claude sessions pre-allow only browser tools and `close_session`, but Claude workspace sessions in auto mode effectively do not ask either.
- (b) A tool-level allow list equal to Claude's ordinary policy, if A5 proves Qwen supports one (`--allowed-tools` with MCP names, [N]). Otherwise (c).
- (c) No trust: Parley tool calls wait for approval in the terminal (default mode) or for the classifier (auto).
- Recommendation: (b) if proven, else (a), because (c) makes every mail and map call wait.

**D8. Tool search off in Parley qwen sessions** (`tools.toolSearch.enabled: false`).
- This affects every MCP server merged into the session, yours too: all their tools are declared directly.
- It is kept only if A5 shows the full Parley tool list plus a representative user server reaching the mock with usable schemas, with the tool count and payload size recorded.
- Otherwise the sessions keep tool search, and Parley guidance teaches `tool_search` → `tool_call`.
- Recommendation: off, subject to that check.

**D9. Memory extractor off in Parley qwen sessions.**
- On the mock this went from two model requests per turn to one (other calls such as tool turns or the classifier are not counted). It also stops Qwen writing memories from Parley sessions into `~/.qwen`.
- Recommendation: off.

**D10. Roles on qwen in v1.**
- Only non-read-only built-in roles (executor, debugger, verifier). Read-only roles (planner, critic, reviewer, architect, feature-lead, researcher) are refused until enforcement is proven.
- Recommendation: yes.

**V1 real install.**
- Accepting this spec also authorizes one real qwen Install through Parley into a scratch `HOME` during verification. It downloads and runs Alibaba's installer once.

## 8. Acceptance without a login

**Mock lab.** A local OpenAI-compatible mock, the real `qwen` 0.27.2, a throwaway `QWEN_HOME`, and the real Parley host and MCP server. It is versioned in the repo by A0.

**Checked through `sessions-service`** (not only `launch.ts`), for new and resumed sessions:
- HTTP and command hooks reach the host receiver with the token;
- Parley MCP connects with no prompt and the Parley tools are usable (D7/D8 as chosen);
- busy → idle;
- readiness and the startup-attention state without auth env;
- a message wakes an idle session, including one before its first turn;
- `/compress`;
- `--resume` into the same transcript;
- the Chat view renders the run;
- the watcher finds a new session after host start;
- a host restart keeps the binding;
- read-only roles are refused and the executor role launches;
- an administrator system file is preserved; an invalid one refuses the launch.

**Tests:**
- the empty-prompt replay;
- installer env policy (inherited `BASH_ENV`, `npm_config_registry` and a scoped registry);
- the npm binding with two prefixes and with an unchanged version;
- resolver fallback without PATH change;
- UI states.

**Mocked failure sequences:** mocked auth failure and quota error responses from the mock model (StopFailure path).

**Needs a live login** (these go to "Not verified"):
- a real Qwen model's records (thinking, usage);
- the OAuth flow end to end;
- whether `auth_success` fires for OAuth at every start;
- a real quota error;
- real model ids.

## Appendix A. Samples (observed, mock model)

```json
{"type":"user","provenance":"real_user","executionContext":{"modelId":"mock-model","authType":"openai","approvalMode":"yolo"},"message":{"role":"user","parts":[{"text":"call the echo tool"}]},"promptId":"<sid>########0"}
{"type":"assistant","provenance":"assistant_output","model":"mock-model","message":{"role":"model","parts":[{"text":"Hello from mock"}]},"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":3,"thoughtsTokenCount":0,"totalTokenCount":23,"cachedContentTokenCount":0}}
{"type":"assistant","message":{"role":"model","parts":[{"text":"thinking about it","thought":true},{"text":"…"}]}}
{"type":"assistant","message":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"tool_call","args":{"name":"mcp__parley__echo","arguments":{"text":"hi"}}}}]}}
{"type":"tool_result","provenance":"tool_result","message":{"role":"user","parts":[{"functionResponse":{"id":"call_1","name":"run_shell_command","response":{"output":"…"}}}]},"toolCallResult":{"callId":"call_1","status":"success"}}
```

Every record also has `uuid, parentUuid, sessionId, timestamp, cwd, version`.

```json
{"session_id":"4444…","transcript_path":"…/projects/<enc-cwd>/chats/4444….jsonl","cwd":"…","hook_event_name":"SessionStart","permission_mode":"yolo","source":"startup","model":"mock-model"}
{"…":"…","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"…","context_usage":0.0001,"context_limit":200000,"input_tokens":20}
```

## Appendix B. Critique of revision 1 and the answer (s-325)

| # | Finding | Answer |
|---|---|---|
| 1 | Administrator system policy can be lost | §3.3 base resolution: absent, refuse, or keep; required keys; never relax. Senior-only A5. |
| 2 | Host hook URL/token gate and MCP-route detection missing | §2.2, §3.3 host gates and the route kind; A5/A6 acceptance through `sessions-service` |
| 3 | Role delivery and read-only enforcement | §3.6, D10: qwen grammar, read-only refused; senior-only A9 |
| 4 | Empty prompt and context on the durable path | §3.4 normalization contract in `events.ts`/`activity.ts`; HTTP route required, not a silent fallback |
| 5 | `trust: true` is an approval expansion | D7 |
| 6 | Readiness, sign-in inference, pty guarantees | §3.4 state machine, neutral wording, Qwen typing strategy keeping `send.ts` guarantees; Codex claim removed |
| 7 | Installer env and registry | §4.2.3 |
| 8 | npm update bound to the active install | §4.3 |
| 9 | Broad PATH change | §4.2.6 exact-binary fallback, no PATH change |
| 10 | Watcher, reindex, feed ownership, restart binding | §3.5 |
| 11 | One effective Qwen home; hints, not verdicts | §3.5 `qwenHome`, §3.6 |
| 12 | Bounded refactor, task splits, seniority, shared files | Plan: inventory appendix, A1 split, A7 split, senior-only marks, serialization |
| 13 | Tool search is global | D8 and its A5 check |
| 14 | Evidence labels | §2 evidence column cites addendum A1–A10; lab versioned by A0 |
| 15 | Decision framing | D1 dropped (already authorized); D2/D3 split; D6/D9 wording; V1 install authorized with acceptance |
