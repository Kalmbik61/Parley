# Qwen Code as a built-in provider, and installing and updating CLIs from Settings → Providers: design

Status: draft waiting for the human's decision. Lead s-322, owner s-320, room r-27, spike s-323 (2026-11-11).
Plan: `docs/plans/2026-11-11-qwen-code-provider-and-cli-install-plan.md`.
Branch: `parley/w-0054/s-322`, fast-forwarded to `origin/master` 8048054c. Both parts land in this branch.

## 1. The request

The human, 2026-11-11 (translated): "Make Qwen Code ours rather than affiliating it with Claude Code. Also add to the
provider settings the ability to install the always-current version of a CLI (Claude or Codex) and to update it in
the same place. Do all of it within one branch."

The human confirmed, through s-320 on the same day (r-27, m-7812):

- **Part B** is what s-320 assumed. It has three pieces:
  - an Install action when the CLI is missing, which the host runs with the official installer of the latest version;
  - the installed version always visible, with "Check now" and an "Up to date" state;
  - the same for Claude, Codex and Qwen.
- **No Qwen credentials.** There is no subscription and no key, and the human will not be asked again.
  - Everything that needs a live model turn goes to "Not verified".
  - Code paths that depend on a live login must fail visibly.
- **Budget** is not a reason to cut scope.

## 2. Facts

Legend:
- **[O]** observed on a real run;
- **[S]** read in source or bundled docs;
- **[N]** not verified.

Spike setup:
- The spike installed `@qwen-code/qwen-code` **0.27.2** (npm `latest`, published 2026-11-10) into a scratch prefix.
- It ran with a throwaway `HOME`/`QWEN_HOME`.
- **The model in every live run was a local OpenAI-compatible mock** on 127.0.0.1 with a fake key.
- The Parley MCP server was replaced by a small stdio MCP mock.
- Report and lab: the s-322 scratchpad, folder `spike/` (`qwen-spike-report.md`, `lab/`, `home2/.qwen/projects/…/chats/*.jsonl`).

### 2.1 Qwen Code CLI

| # | Fact | |
|---|---|---|
| Q1 | `QWEN_CODE_SYSTEM_SETTINGS_PATH=<file>` loads a settings file per process. Its `mcpServers` connect and its `hooks` fire. | O |
| Q2 | The variable **replaces** the platform's standard system file (macOS `/Library/Application Support/QwenCode/settings.json`, Linux `/etc/qwen-code/settings.json`); the standard file is then not read. A project `.env` cannot set it. | S |
| Q3 | Settings merge: user `~/.qwen/settings.json`, the system file and `--mcp-config` are unioned. On a server-name clash between user and system, the system definition wins. User and system hooks both fire. | O |
| Q4 | Precedence, low to high: defaults < system defaults < user < project `.qwen/settings.json` < system settings < env < CLI flags. Project-scope MCP servers and hooks need a one-time approval; system-scope ones do not. | S, O |
| Q5 | No `--settings` flag. `--mcp-config <json\|file>` exists, and `"trust": true` set through it works. Hooks come only from settings files. | O |
| Q6 | `QWEN_HOME` moves `~/.qwen` (all state). | O |
| Q7 | A stdio MCP server from the system file starts without a trust prompt. | O |
| Q8 | By default MCP tools are **deferred**: the model sees `tool_search` and `tool_call` and needs two extra steps per tool. `tools.toolSearch.enabled: false` declares MCP tools directly. | O |
| Q9 | In `--approval-mode default`, an MCP tool call asks "Allow execution of MCP tool …? 1 once / 2 always in project / 3 always for user / 4 no" and fires `Notification` `permission_prompt`. `"trust": true` on the server removes the question. | O |
| Q10 | Without auth, the TUI stops at a "Connect a Provider" picker. SessionStart has already fired at that point, and no other hook fires. With `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL` set, it starts in under 6 s with no question and fires `Notification` `auth_success`. Folder trust is off by default. | O |
| Q11 | A fresh `QWEN_HOME` starts in `auto` approval mode (LLM-classifier approvals) and prints a banner. `--approval-mode plan\|default\|auto-edit\|auto\|yolo` sets the mode. | O |
| Q12 | Hooks fire in an interactive pty: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop (once per turn), Notification (`idle_prompt` after every turn, `permission_prompt`, `auth_success`). 24 events exist, including StopFailure, PermissionRequest, PreCompact and SessionEnd. Hook types: command, http, function, prompt. | O (fired), S (list, types) |
| Q13 | Every hook payload has `session_id, transcript_path, cwd, hook_event_name, timestamp, permission_mode`. Stop adds `last_assistant_message, context_usage, context_limit, input_tokens`. After tool results, a second UserPromptSubmit arrives with `prompt: ""`; it is a model follow-up, not a user turn. | O |
| Q14 | SessionStart and UserPromptSubmit can add context to the model through stdout or `hookSpecificOutput.additionalContext`. | S |
| Q15 | `--session-id <uuid>` sets the id. It is used verbatim in hooks, stream-json and the transcript file name. | O |
| Q16 | The transcript is `$QWEN_HOME/projects/<cwd with every non-alphanumeric character → "->/chats/<sessionId>.jsonl`. The encoding is not collision-free, so use `transcript_path` from the hook. `--resume <id>` and `--continue` append to the same file and keep the id. | O, S (rule) |
| Q17 | Transcript record types (samples in appendix A): **(a)** `user` with `provenance: real_user`; **(b)** `assistant`, whose `message.parts[]` hold `text`, `thought: true` or `functionCall`, plus `usageMetadata`; **(c)** `tool_result` with `functionResponse` and `toolCallResult.status`; **(d)** `system` (telemetry, memory snapshots; many lines). | O |
| Q18 | After every turn a background memory extractor makes a second model call. `memory.enableManagedAutoMemory: false` and `memory.enableManagedAutoDream: false` remove it. | O |
| Q19 | A positional prompt is one-shot: the CLI answers and exits. `-i <prompt>` runs the prompt and stays interactive. `--append-system-prompt` and `-m` work in a pty. Writing `text\r` to the pty in one write submits a turn. `/compress` exists. | O |
| Q20 | `qwen --acp` answers `initialize` and `session/new`. `-o stream-json` gives Claude-shaped events. | O |
| Q21 | Auth types: openai, openai-responses, anthropic, qwen-oauth, qwen-subscription, gemini, vertex-ai. | O (help) |
| Q22 | Qwen OAuth is interactive and browser-only, inside `/auth`. `qwen auth` was removed. | S, O (help) |
| Q23 | OAuth credentials live in `$QWEN_HOME/oauth_creds.json`. The non-secret `security.auth.selectedType` in `$QWEN_HOME/settings.json` names the chosen type. Env-only auth leaves no trace in files. | S, O |
| Q24 | `qwen --version` prints `0.27.2`. `general.enableAutoUpdate: false` turns off the startup check and auto-install. | O, S |
| Q25 | `qwen update` is non-interactive. Exit codes: 0 when up to date or updated, 1 on failure. **For a standalone install it updates itself; for npm, pnpm and brew installs it only prints the command to run and exits 0.** | S |
| Q26 | Official install, npm: `npm install -g @qwen-code/qwen-code@latest`. The package needs Node ≥ 22. After install, the realpath of `qwen` is inside `node_modules/@qwen-code/qwen-code`. | O, S |
| Q27 | Official install, standalone script: `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh`. | S, not run |
| Q28 | What the standalone script does: (a) downloads a SHA-256-checked archive; (b) unpacks it to `~/.local/lib/qwen-code/`; (c) writes a shell wrapper `~/.local/bin/qwen` and `~/.qwen/source.json`; (d) adds the bin dir to the shell rc unless given `--no-modify-path`; (e) runs without prompts. With `--method detect` (the default) it falls back to npm through `registry.npmmirror.com`; `--method standalone` stops the fallback. | S, not run |
| Q29 | Brew formula `qwen-code`. | S |
| Q30 | Latest version: npm `dist-tags.latest`. Many experimental dist-tags exist (`jobbench`, `gdpval-*`); use only `latest`. | O |

### 2.2 Parley today

**Families**
- `ProviderFamily = 'claude'` is the only value (`packages/core/src/providers.ts:30`). Codex has no family.
- About 62 files branch on `id === 'codex'` or `isClaudeCode(...)`.
- At least 13 sites treat "not codex" as Claude, with no compile error. Examples:
  - `host/src/activity/log-index.ts:118`
  - `host/src/hooks/hook-server.ts:328`
  - `host/src/hooks/inline-mail.ts:60`
  - `host/src/feed/feed-service.ts:851`
  - `host/src/compaction/compaction-service.ts:40`
  - `host/src/pty/process-monitor.ts:44`
  - `host/src/context/context-service.ts:64`
  - `core/src/work/room-usage.ts:83`
  - `core/src/work/role-choice.ts:23`
  - `host/src/activity/activity-service.ts:656,714,1130,1153`
  - `desktop/src/renderer/lib/feed-view.ts:49-53`
- No exhaustive switch exists. Adding `'qwen'` to `Provider` (`core/src/session-index.ts:23`) breaks compile only at `PROVIDERS: Record<Provider, …>`.

**Qwen today**
- Qwen exists only as the custom preset `qwen` (`desktop/src/renderer/components/providers/custom-presets.ts:96-126`): Claude Code pointed at Alibaba's Anthropic-compatible endpoints. It becomes `custom-<slug>` with `family: 'claude'`.
- A `qwen` CLI added through `providers.json` gets no family: a bare terminal with no MCP, hooks or Chat view.

**Updates**
- `core/src/cli-updates.ts` and `host/src/providers/updates.ts` know only `'codex' | 'claude'`. The latest-version check runs daily, at most once every 20 h. It **skips a CLI that is not installed** (`updates.ts:156-157`).
- `current()` reports only "newer and not skipped". There is no forced check.
- `update-run.ts` runs `<binary> update`. Its safety properties:
  - `shell: false`, own process group;
  - 5 min timeout, 4 KB output tail;
  - per-command busy guard, env scrub;
  - absent from the remote and island allowlists.

**Install**
- `provider-install.ts` shows a command to copy:
  - Claude: `curl -fsSL https://claude.ai/install.sh | bash`
  - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`
- The decision on record is "Parley installs and downloads nothing" (`docs/specs/2026-10-02-providers-connect-design.md:66`).
- The README (`README.md:122-127`) says Parley starts "the unmodified `claude` and `codex` from your PATH" and lists Parley's own network requests. The CLI version checks are already missing from that list.

**UI**
- `ProviderUpdateRow` draws nothing unless a newer version is known.
- "Check again" on the card only reloads `providers.list`.
- Not drawn anywhere: Up to date, Check now, last-checked time, check failed, un-skip, Install.

**PATH**
- The host's PATH is captured once at app launch from a login shell (`desktop/src/main/shell-env.ts`).
- Native installers put binaries in `~/.local/bin`; `npm -g` uses the active Node's bin.
- A freshly installed CLI may not be on the host PATH until restart. The card says so today (`strings.ts:827`).

## 3. Part A: Qwen Code as a built-in provider

### 3.1 Integration route

| Route | What Parley gets | Cost | Verdict |
|---|---|---|---|
| **pty + per-process system settings file (MCP, hooks, switches) + transcript tail** | The real Qwen TUI in Parley's terminal, sign-in inside it, hooks for state, the transcript for Chat, `--session-id` and `--resume`. The same shape as Claude. | The transcript parser and the hook mapping are new code | **Chosen** |
| ACP (`qwen --acp`) | Structured events and permission requests over JSON-RPC | No terminal. Parley would need an ACP client and its own UI for everything the TUI does, including sign-in. `session/prompt` and permissions are unverified. | Rejected for v1 |
| `-o stream-json` | Claude-shaped events | One-shot only; multi-turn over stdin is unverified; no TUI | Rejected for sessions. Possible later for one-shot assistant turns. |

Reason: Parley's promise is the unmodified official CLI in a terminal the human can see and type into, with state
from hooks and Chat from the transcript. Every piece of that is observed for Qwen (Q1, Q7, Q12, Q15–Q17, Q19). ACP
would make Qwen the only provider without a terminal and needs a new client.

### 3.2 Family model

- `ProviderFamily` becomes `'claude' | 'codex' | 'qwen'`.
  - The `codex` entry gets `family: 'codex'`.
  - A helper `providerFamily(entry): ProviderFamily | null` replaces the open-coded checks wherever a family is meant.
  - Custom providers and Claude accounts stay `claude`. `providers.json` entries stay family-less.
- Every "not codex, so Claude" site from §2.2 becomes an explicit family check.
  - A family-less id takes the neutral path (no Claude hooks or transcript), not the Claude path.
  - This changes nothing for claude, codex, glm, custom and account providers.
  - It does change `providers.json` CLIs, which today wrongly take the Claude path in those sites.
  - It lands **before** the `qwen` entry exists, so a missed site cannot send a Qwen session down the Claude path.
- New code that switches on family uses an exhaustive `switch` with a `never` check.
- The wire field `providers.list` `family?: 'claude' | null` (`protocol/src/methods.ts:455`) widens to the three values.
  - `core/src/mcp/provider-rows.ts`, `AgentIcon.tsx` and `feed-view.ts` follow.
  - Agents will see `family: "codex"` for Codex where they saw `null`.

### 3.3 Launch

**Registry entry `qwen`**
- Built-in; id `qwen`; label "Qwen Code"; command `qwen`.
- `family: 'qwen'`, `linkBy: 'session-id'`, `hasHistory: true`, `minVersion: '0.27.2'` (the observed version).

**Argv**
- New session: `qwen --session-id {sessionUuid} --approval-mode {approvalMode} --append-system-prompt {systemPrompt} -m {model} -i {prompt}`.
  - Empty substitutions drop their pair, as for Claude.
  - `-i`, because a positional prompt is one-shot (Q19).
- Resume: `qwen --resume {providerSessionId}` with the same flags minus `--session-id`.

**Env**
- `QWEN_CODE_SYSTEM_SETTINGS_PATH=<per-session file>`, plus the usual Parley env (`PARLEY_WORK_DIR`, `PARLEY_SESSION_ID`, hook token).
- Parley does **not** set `QWEN_HOME`, `OPENAI_*` or any key. Qwen runs with the user's own `~/.qwen` and sign-in.

**Per-session system settings file** (written by Parley into the work dir, like Claude's `--settings` file)
1. **Base.** If the platform's standard system file exists and is readable, its content is the base (Q2 says it would otherwise be dropped). A file that cannot be parsed is skipped with a host-log warning.
2. **`mcpServers.parley`.** The same stdio command and env Parley gives Claude, plus `"trust": true` (Q9). Only Parley's own server is trusted; the user's servers keep their settings.
3. **`hooks`.** SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure, Notification and PermissionRequest each get the pair Claude gets (`core/src/work/settings-file.ts`): the `cat >>` journal command and the HTTP feed hook to the host. Entries are appended to any base hooks of the same event.
   - Qwen's `http` hook type is [S]. The launch task proves it on the mock lab. If it fails, the command hook alone carries the events.
4. **`tools.toolSearch.enabled: false`.** Parley's tools are declared directly (Q8). Without it every Parley call costs two extra steps, and agents trained on Parley guidance would fail.
5. **`general.enableAutoUpdate: false`.** Updates go through Parley's row (Part B), mirroring Codex's `check_for_update_on_startup=false`.
6. **Memory switches.** `memory.enableManagedAutoMemory` and `memory.enableManagedAutoDream` are set only if the human chooses so (D6).

**Approval mode:** decision D5. Never `--yolo` (README: "No YOLO flags").

### 3.4 State, mail and stuck detection

**Hook mapping** (the hook server registers qwen sessions with a qwen event set):

| Hook | Parley activity |
|---|---|
| UserPromptSubmit, non-empty `prompt` | turn started (an empty prompt is ignored, Q13) |
| PreToolUse / PostToolUse | tool activity |
| Stop | turn finished, idle |
| Notification `permission_prompt` / PermissionRequest | waiting for the human |
| Notification `idle_prompt` | idle |
| StopFailure | turn failed: stuck, with the message |
| SessionEnd | exited |

**Sign-in wait.** SessionStart fires even while the auth picker blocks the TUI (Q10). So a qwen session whose SessionStart arrived, but neither `auth_success` nor a UserPromptSubmit within the startup grace, is shown as "Qwen is waiting for sign-in: choose a provider in the terminal (/auth)". The state is visible, never silent.

**Mail.** After Stop the host types the wake pointer into the pty as `text\r` in one write (Q19), on the path Codex uses.
- Hook context injection exists (Q14) but is [S] only.
- Claude's inline delivery (`inline-mail.ts`) explicitly excludes qwen in v1.

**Context fill** comes from the Stop payload `context_usage` (Q13), instead of Claude's statusline file.

**Compaction** sends `/compress` (Q19).

### 3.5 Session identity, history and Chat view

- **Identity.** The session id is the `{sessionUuid}` Parley passes (Q15). The transcript path comes from the SessionStart payload.
- **Parser.** `core/src/feed/qwen/` turns transcript records into feed items:
  - user (`provenance: real_user`);
  - assistant text and thinking (`thought: true`);
  - tool call (`functionCall`; for the `tool_call` wrapper, the inner MCP name);
  - tool result (`functionResponse`, status);
  - usage (`usageMetadata`).
  - `system` records are skipped. Unknown types are counted and skipped, never thrown on.
- **Feed.** The feed service seeds and tails qwen transcripts. The Chat gate (`feed-view.ts`) opens for family `qwen`.
- **History.** The session index discovers `$QWEN_HOME/projects/*/chats/*.jsonl` (`~/.qwen` unless the host env sets `QWEN_HOME`), so the sessions list and resume show Qwen sessions.
- **Sleep and wake** use `--resume <id>`.

### 3.6 Models, sign-in, card, roles

**Models**
- No catalog is available without a login. v1 offers "Default" (no `-m`) or a typed model id.
- If present, the card also shows `model.name` from `~/.qwen/settings.json`.
- Effort is not offered in v1.

**Sign-in state on the card**

| Condition | Card text |
|---|---|
| `security.auth.selectedType` set | "Configured: <type>" |
| `oauth_creds.json` exists (presence only) | "Qwen account" |
| `OPENAI_API_KEY` present in the host env (presence only) | "Key in environment" |
| otherwise | "Not signed in: start a Qwen session and choose a provider in the terminal (/auth)" |

- "Configured" means a type is chosen, not that a token is valid; the card says so.
- Parley reads only `model.name` and `security.auth.selectedType` from `~/.qwen/settings.json`, never logs the file, and never opens the credential file.

**Card**
- Settings → Providers shows the card next to Claude, Codex and GLM (`CORE_IDS`).
- It has an icon, the status bar segment, and the Part B rows.

**Roles**
- Parley's built-in roles reach qwen through the system prompt layer (`--append-system-prompt`).
- Native Claude and Codex roles do not fit qwen; the catalog rule says so.
- `modelForTier` gives qwen `null` (the CLI default).

### 3.7 What v1 includes and excludes

**Includes**
- the family refactor;
- the registry entry, launch and resume;
- the settings file;
- state, mail and stuck detection;
- the transcript parser, Chat view and history;
- the card with sign-in state, and built-in roles;
- Part B for qwen;
- a stub `qwen` for tests and a mock lab for live checks;
- the preset rename (§5).

**Excludes** (each is a later step):
- several Qwen accounts (`QWEN_HOME` per account);
- Parley-held Qwen keys (D4);
- usage and limit readers (Qwen has no quota API);
- the capabilities panel (skills, plugins, MCP per CLI);
- autonomous rooms, the one-shot assistant, swarms and phone launch on qwen (those allowlists stay `claude`/`codex`);
- ACP and stream-json routes;
- effort and a model catalog;
- hook-based inline mail.

## 4. Part B: install and update from Settings → Providers

### 4.1 One descriptor per CLI

New `core/src/cli-tools.ts` replaces the hard-coded pairs in `cli-updates.ts`, `updates.ts`, `update-run.ts` and `provider-install.ts` with one table keyed by command:

| | claude | codex | qwen |
|---|---|---|---|
| Latest version | npm dist-tags of `@anthropic-ai/claude-code`, channel from Claude settings (as today) | GitHub releases, or the brew cask API for brew installs (as today) | npm `dist-tags.latest` of `@qwen-code/qwen-code` |
| Install method | npm / native (as today) | npm / standalone / brew (as today) | npm (realpath in `node_modules/@qwen-code/qwen-code`) / standalone (`~/.local/lib/qwen-code/` exists and the found binary is the `~/.local/bin/qwen` wrapper) / brew (Homebrew prefix) / unknown |
| Update argv | `claude update` | `codex update` | standalone: `qwen update`. npm: `<npm next to the install> install -g @qwen-code/qwen-code@latest` (Q25: `qwen update` only prints this). brew / unknown: no run, manual command only |
| Install (macOS, Linux) | download `https://claude.ai/install.sh`, run with `/bin/bash` | download `https://chatgpt.com/codex/install.sh`, run with `/bin/sh` | decision D2 |
| Expected install dir | `~/.local/bin` | `~/.local/bin` | `~/.local/bin` (standalone) or the npm global bin |
| Smoke after update or install | `claude --version` | `codex -c check_for_update_on_startup=false --version` (as today) | `qwen --version` |

- "npm next to the install" is `<prefix>/bin/npm` derived from the realpath `<prefix>/lib/node_modules/…`. If it does not exist, the npm on the host PATH is used.
- Windows: Install and the qwen npm update show copy-only commands. Parley runs no installer on Windows in v1.

### 4.2 Running an installer

`providers.install {provider}` runs on the host with the safety properties of `providers.update`; the runner is extracted from `update-run.ts` and shared.

1. **Constant argv.** Only built-in commands from the table. Nothing from the request or from settings reaches the argv.
2. **Download, then run.**
   - The host downloads a script installer over HTTPS from the constant URL: HTTPS-only redirects, 1 MB cap, 15 s timeout.
   - It writes the script into a fresh `0700` temp dir and runs `[/bin/bash or /bin/sh, <file>, …constant args]` with `shell: false`.
   - Nothing is piped from the network into a shell. The script's SHA-256 and size go to the host log. The temp dir is removed afterwards.
3. **npm installs** run `[<npm>, 'install', '-g', '<package>@latest']`, using the official registry (no `--registry`).
   - If npm is missing, or Node is below the package's `engines.node`, the action fails before running, with the reason and the manual command.
4. **Env and privileges.** `agentEnv`, scrubbed as for update. No `sudo`, ever. A permission failure (npm prefix not writable) shows the error and the manual command.
5. **Process control.**
   - Own process group; 10 min timeout; the group is killed on timeout and on host shutdown.
   - Last 4 KB of output kept.
   - Install and update share the per-CLI busy guard.
6. **After exit.**
   - Look for the binary on the host PATH, then in the table's expected dir.
   - If it is found only in the expected dir, the host prepends that dir to its own PATH and to `agentEnv`. The result carries `pathNote`: "<dir> is not on your shell PATH; Parley uses it until restart."
   - Then: probe the version, run the smoke, broadcast `providers.changed`, and re-check the latest version for that CLI.
7. **Success** means exit 0, no timeout, a version found and the smoke passing. Otherwise the result carries the error, the output tail and the manual command.
8. **Allowlists.** `providers.install` and `providers.checkUpdates` are mutating or networked methods. They go into `REMOTE_FORBIDDEN` (`protocol/src/remote/allowlist.ts`) and stay out of `ISLAND_METHODS`. `providers.update` moves from NOT_DECIDED to `REMOTE_FORBIDDEN` as well.
9. **Confirmation.** Before the call the window shows a confirmation with the exact command, the source URL and, for script installers, the note that the installer may add its bin dir to the shell profile. "Install" is the only accept button.
   - The host does not rely on that confirmation for safety; the constant argv is the guarantee.

### 4.3 Status always visible, Check now

- `updates.ts` also checks the latest version for missing CLIs, so Install can say "Install 2.1.340". The cache keeps `{latest, checkedAt, method, skipped, lastError}`.
- Each `providers.list` item for the three CLIs gets:
  `cli: { installed: string | null, latest: string | null, method: string | null, checkedAt: string | null, state: 'missing' | 'up-to-date' | 'available' | 'skipped' | 'unknown', lastError: string | null }`.
  The existing `update` field stays unchanged, because the phone and island read it.
- `providers.checkUpdates {provider}` forces a fresh version probe and a latest-version fetch, ignoring the 20 h gate. The host allows one check per CLI per 10 s.
- For an installed CLI the row is always drawn:
  - `Claude Code 2.1.340 · Up to date · checked 14:05 · [Check now]`
  - `Codex 0.162.0 → 0.166.0 · standalone · [Update] · Skip this version · [Check now]`
  - `Qwen Code 0.27.2 → 0.28.0 · skipped · [Update anyway] · [Check now]` (updating un-skips)
  - `Codex 0.162.0 · Could not check (offline) · checked 09:12 · [Check now]`
  - `Qwen Code 0.27.2 → 0.28.0 · brew · update with: brew upgrade qwen-code · [Copy]` (no run for brew/unknown)
- For a missing CLI the card shows `Not installed · latest 0.27.2 · [Install…] · [Copy command] · Guide`.
- The status bar "↑" mark covers qwen too.

### 4.4 README and earlier decisions

The README's "How it works" changes in two places:
- Parley starts the official CLIs from your PATH, and installs or updates them only when you press Install or Update.
- Parley's own requests now include the daily version check (npm registry, GitHub, brew cask API) and the installer downloads.

This spec supersedes the decision of 2026-10-02 that "Parley installs nothing". The header comment of `provider-install.ts` changes accordingly.

## 5. The existing Qwen custom preset

The preset stays. It is the working route for Alibaba Coding Plan and Token Plan keys through Claude Code, and it needs no `qwen` CLI.

- To avoid two things called "Qwen", its label becomes **"Qwen models in Claude Code (Alibaba key)"**.
- The preset id and existing `custom-*` providers do not change, so a configured provider keeps working.
- The built-in provider is "Qwen Code".

This is s-320's recommendation; decision D3.

## 6. Security

**Installers.** An installer is vendor code run as the user. The guarantees:
- a constant argv and URL per CLI;
- HTTPS only;
- download, then run; never `curl | sh`;
- a logged SHA-256;
- no sudo;
- an explicit click plus a confirmation showing the command;
- no phone or island route;
- a timeout and a group kill.

Parley does not pin script hashes. The vendors change the scripts without notice, so pinning would break Install every time.

**Qwen standalone installer.** It is fetched from Alibaba's CDN in Hangzhou. Running it with `--method standalone` disables its npm fallback through `registry.npmmirror.com`. The archive is SHA-256-checked by the script itself (Q28, [S]).

**Qwen settings file.**
- It trusts only Parley's own MCP server and sets no approval bypass. The approval mode is D5.
- It keeps an administrator's standard system file as its base (§3.3).

**Qwen credentials.** Parley reads two non-secret keys from `~/.qwen/settings.json`. It checks the credential file and env keys for presence only.

## 7. Decisions for the human

**D1. Install from Parley.**
- What changes: "Parley installs nothing" is superseded. The host runs the official installer when you press Install, after a confirmation showing the command. Phone and island can neither install nor update.
- Recommendation: yes; this is the request.

**D2. Qwen installer.** Options:
- (a) the official standalone script with `--method standalone`. No Node needed, updates itself through `qwen update`, binary in `~/.local/bin` like Claude and Codex. The script adds `~/.local/bin` to the shell profile, which is its default.
- (b) `npm install -g @qwen-code/qwen-code@latest` from the official npm registry. Needs Node ≥ 22 on the host's PATH (this machine has 22.23.3).

Recommendation: (a), and let the script edit the shell profile, as the official default does.

**D3. Preset name.**
- Rename the Qwen preset to "Qwen models in Claude Code (Alibaba key)".
- Recommendation: yes.

**D4. Qwen keys in Parley.**
- v1 uses only the sign-in done inside Qwen (`/auth`) or the user's own environment, and Parley stores no Qwen key.
- The alternative is a key field for a Coding Plan or DashScope key, passed as env.
- Recommendation: not in v1.

**D5. Qwen approval mode.** Options:
- (a) Mirror Claude: `--approval-mode auto` in workspace sessions, where Claude gets `--permission-mode auto`, and `default` elsewhere.
- (b) `default` everywhere: every edit and shell command waits for the human in the terminal.

Recommendation: (a). Qwen's `auto` uses an LLM classifier, which adds model calls (not measured).

**D6. Memory extractor.**
- Qwen makes a second model call after each turn and writes memories into `~/.qwen` (Q18).
- Should Parley sessions turn it off with `memory.enableManagedAutoMemory: false` and `memory.enableManagedAutoDream: false`?
- Recommendation: yes. It halves model requests per turn (observed on the mock), and Parley has its own project memory.

## 8. Acceptance without a login

**Checked by tests and on the mock lab.** The mock lab is a local OpenAI-compatible mock, the real `qwen` 0.27.2 and a throwaway `QWEN_HOME`.
- The generated argv and settings file for new and resumed sessions (unit tests).
- A real `qwen` started by Parley's launch code against the mock:
  - Parley MCP connects with no prompt;
  - a Parley tool call succeeds as a direct tool;
  - hooks reach the host;
  - state goes busy → idle;
  - the wake pointer typed after Stop starts a turn;
  - `--resume` continues the same transcript;
  - the Chat view renders the mock transcript.
- Without auth env, the "waiting for sign-in" state appears.
- Install and update against stub binaries and a local HTTPS stub script (tests).
- One real qwen Install into a scratch prefix, run by the verifier and not in CI.
- The UI states of §4.3: component tests and an e2e on stub binaries.

**Needs a live login** (goes to "Not verified"):
- the transcript records of a real Qwen model (thinking format, usage);
- the Qwen OAuth flow end to end;
- resuming a real session;
- StopFailure on a real quota error;
- real model ids;
- whether `auth_success` fires for OAuth at every start.

## Appendix A. Transcript and hook samples (observed, mock model)

```json
{"type":"user","provenance":"real_user","executionContext":{"modelId":"mock-model","authType":"openai","approvalMode":"yolo"},"message":{"role":"user","parts":[{"text":"call the echo tool"}]},"promptId":"<sid>########0"}
{"type":"assistant","provenance":"assistant_output","model":"mock-model","message":{"role":"model","parts":[{"text":"Hello from mock"}]},"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":3,"thoughtsTokenCount":0,"totalTokenCount":23,"cachedContentTokenCount":0}}
{"type":"assistant","message":{"role":"model","parts":[{"text":"thinking about it","thought":true},{"text":"…"}]}}
{"type":"assistant","message":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"tool_call","args":{"name":"mcp__parley__echo","arguments":{"text":"hi"}}}}]}}
{"type":"tool_result","provenance":"tool_result","message":{"role":"user","parts":[{"functionResponse":{"id":"call_1","name":"run_shell_command","response":{"output":"…"}}}]},"toolCallResult":{"callId":"call_1","status":"success"}}
```

Every record also carries `uuid, parentUuid, sessionId, timestamp, cwd, version`.

```json
{"session_id":"4444…","transcript_path":"…/projects/<enc-cwd>/chats/4444….jsonl","cwd":"…","hook_event_name":"SessionStart","permission_mode":"yolo","source":"startup","model":"mock-model"}
{"…":"…","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"…","context_usage":0.0001,"context_limit":200000,"input_tokens":20}
```
