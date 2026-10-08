# Changelog

All notable changes to Parley are documented in this file.

<!-- The notes of a release are the body of its `## X.Y.Z` section: the Release workflow publishes them as the release description (scripts/release/prepare-release.mjs). Keep one such heading per version. -->

## Unreleased

### Changed

- **The `PARLEY.md` template says what not to write there.** Its opening comment now explains that Parley's own rules (rooms, messages, reports) reach agents without the file, so it holds only the team's rules for the project. Only new templates change: an existing `PARLEY.md` is left as it is.

## 0.8.0

Agents and Codex in Chat: the Agents panel shows what each agent of a session is doing, a Codex session opens as a conversation, and Codex approvals can be answered in the window. Rooms can be renamed, deleted and given a new lead from the sidebar and take attached files; plan letters are laid out by section, room agents keep their names, the New session or room dialog explains its fields, the backlog can live in `TODOS.md`, and archiving a workspace stops its agents. The Codex chat is checked by tests with a stub Codex; the live checks are still open (see "What is not proven yet").

### Added

- **Chat view for Codex 0.160.0+.** A Codex session opens as a conversation like Claude Code does: the feed is read from the session log Codex writes itself (read-only), so prompts, replies, commands, file edits with diffs, subagents and turn ends show up with nothing to set up, and the Agents panel works for Codex subagents too.
- **Answer Codex approvals in Parley (Settings → Agents, off by default).** With it on, new and resumed Codex sessions start with Parley's hooks and every approval shows as an Allow / Deny card in Chat. Codex asks once to trust the hooks ("Trust all and continue"); until then the feed shows a hint and approvals stay in the terminal. Parley writes nothing to `~/.codex`.
- **Agents panel.** "N agents running" in the Chat toolbar opens an "Agents" tab in the right sidebar (⌘⇧A): the session's agents with what each is doing now, finished ones below. Click an agent to see its task, steps, tool calls as they happen, result and full transcript. The agents badge in the sidebar and in a room opens the same panel.
- **Field hints in the New session or room dialog.** A "?" next to Recipe, Workspace, the
  session or room name, Agents, In its own worktree and Mode explains the field on hover; the
  Mode hint lists what Free, Checklist and Verified do, and the Agents hint explains roles:
  Builtin ones against your own Claude and Codex agents, and the 🔒 of a read-only role.
- **Manage a room from the sidebar.** A right click on a room row gives "Rename" (in place) and "Delete…": the room goes with its feed, and its sessions stay as regular sessions of the workspace, each live one told by Parley; the checkbox "Also delete its N sessions" (off by default) deletes them too, as "Delete" on a session row does. A member row of an expanded room has "Make lead": the feed shows "@s03 is now the lead", and Parley writes to the new and the previous lead. Host methods `rooms.rename`, `rooms.setLead`, `rooms.delete`; with an older host the items are hidden.
- **Attachments in a room.** The room's input field has a paperclip ("Attach a file"), and files
  dropped anywhere on the room tab are attached too. They show as chips above the field (images
  as thumbnails) and are sent at the end of the message as an "Attachments:" list of absolute
  paths that the agents open themselves.
- **Keep the backlog in TODOS.md.** The Backlog tab has a "Backlog file" switch:
  `.parley/backlog.md` (the default) or the project's `TODOS.md`/`TODO.md`. A project that
  already has one is offered it once. Switching to it moves the existing items there with their
  IDs and sections; switching back leaves the file untouched. Agents' backlog tools follow the
  choice.

### Changed

- **Plan letters in the room feed are laid out by section.** A letter from Parley about a plan
  item shows the item's title in bold, then Scope, Criteria as a list, Evidence or the return
  note, and "Next:" with the tool names as code; paths to files and folders in Parley's letters
  are shown as code. The letter text the agent reads is unchanged.

### Fixed

- **Parley no longer replaces your Codex `notify` program** in its sessions: the end of a turn comes from the terminal and the session log instead.
- Archiving a workspace now stops its running agents, so their processes no longer stay in
  memory. Until "Reopen", the host does not start the workspace's sessions: a message to an
  agent waits instead of waking it, and "Resume" is refused.
- Room agents no longer get renamed to "New messages (1) in r-01 … Call check_inbox.": a
  session whose conversation began with Parley's message pointer takes no automatic title (the
  title Claude Code generates from that pointer is skipped too; a `/rename` still applies). A
  name broken this way by an earlier build shows as "New session" and is reset in the map.
- A session row shows a blinking envelope while the agent has messages it has not read yet,
  instead of the name changing.
- "Rename" from a workspace card's menu now puts the cursor in the name field. The field used to
  open without focus, so typing went nowhere and Esc or a click elsewhere did not close it.
- A room member's card and its row in the sidebar no longer spill over the edge when the agent
  has a role: the role chip shrinks first (its text ends with "…", the 🔒 stays), the session
  name keeps at least its number, and the ★ and the state word stay whole. The chip's tooltip
  now starts with the full role. A member row in the sidebar no longer shows the time of the
  last event.
- The backlog works again in a project folder that is not a Git repository when a parent folder
  holds a stub `.git` without HEAD, objects or refs (GitKraken leaves one in the home folder), or
  a lone `HEAD`, `objects` or `refs` entry. Agents used to get "Backlog operation failed
  (git-context-unverified)". A broken repository higher up still blocks the backlog.

### Updating

The window and the host must be updated together: restart the host when the window asks ("Restart host…"). Chat for Codex needs Codex 0.160.0 or later; with an older Codex, or with a host of 0.7.0, a Codex session keeps the Terminal view, and a host of 0.7.0 also hides the new room menu items. Codex sessions get the approval hooks when they are launched or resumed after "Answer Codex approvals in Parley" is switched on. Room agents that an earlier build named "New messages …" get their name reset the first time the new host sees them.

### What is not proven yet

- The Codex chat and approvals are checked by unit tests and end-to-end runs with a stub Codex, not yet with a real `codex` session: the log as it is written during a turn, Stop, resume, an approval card for a file edit and Codex subagents are still to be watched live.
- The Agents panel has not been watched live with Claude background agents.

## 0.7.0

The project layer: team rules in `PARLEY.md`, roles, plans with a backlog, room recipes, decisions, memory and search, the Capabilities panel, and a skill navigator that is on by default for Claude, GLM and Codex. It is checked by tests and by a few live sessions of `claude`, GLM and `codex`; most live checks are still open (see "What is not proven yet").

### Added

- **Team rules in `PARLEY.md`.** A file in the project root with the rules for agents that work together. Every session gets it on top of its own instructions: Claude through `--append-system-prompt`, Codex through a new `-c developer_instructions=…` (placeholder `{developerInstructions}`). Codex also reads `CLAUDE.md` where there is no `AGENTS.md` (`project_doc_fallback_filenames`). The host creates a template once, before the first session of the window in a project, and the window says so; "Open PARLEY.md" and "Create PARLEY.md" are in the project menu. A launch whose whole layer is over 96 KiB stops with `session-layer-too-large`.
- **Roles.** Eight built-in roles (planner, architect, critic, executor, reviewer, verifier, debugger, researcher) and the native agents of Claude and Codex, chosen per agent row in "New session or room" or with `role` in `spawn_session` (`list_roles` lists them). A read-only role is enforced by the CLI (`--disallowedTools`, `sandbox_mode="read-only"`); a runner that cannot deliver a role does not start the session.
- **Plans and a backlog.** Rooms get a mode — Free, Checklist or Verified — with plans of items, owners, dependencies and independent verification; Parley wakes owners in turn. Tools: `set_room_mode`, `plan_update`, `plan_submit`, `plan_verify`, `propose_completion`, and `propose_decision` with a plan. The project backlog (`.parley/backlog.md`) has a tab; agents propose findings with `backlog_suggest` and read with `backlog_list`.
- **Recipes.** "Plan & build", "Review" and "Debug", and your own in `.parley/recipes/`: a recipe fills the roles, the mode and the lead of a new room, and only the lead gets its playbook. "Save as recipe" writes a project recipe and opens it in your system editor.
- **Decisions, room histories, memory and search.** Accepted decisions are written to `.parley/decisions/`; the room's "History" menu shares a snapshot to git on request; `.parley/memory.md` keeps facts, lessons and agreements that agents propose (`remember`) and you accept; `search_history` and the Search tab look through all of it without an index. The project panel has the tabs Capabilities, Backlog, Decisions, Memory and Search.
- **Capabilities.** The panel shows the skills, MCP servers and plugins that Claude and Codex see in a project and runs the agents' own CLI to add and remove MCP servers, manage plugins and share a skill with the other agent. Secrets are never shown.
- **Skill navigator, on by default for Claude, GLM and Codex.** It adds `find_skill` and shortens the native skill list: for Claude and GLM `SLASH_COMMAND_TOOL_CHAR_BUDGET=1` (names only) and the `jev-skill-suggestion` mod switched off for the session, for Codex `-c skills.include_instructions=false`. For Codex the catalog of `find_skill` is the inventory that Codex itself returns (`skills/list`), including plugin, system, admin and extra skills; the launch stores it for the session's MCP server and removes the native list. If the inventory cannot be read or stored (an old Codex without `skills/list`, a timeout, a managed configuration), the native list stays and the launch warns. Turn it off in Settings → Agents → "Skill navigator", with `"skillNavigator": false` in `config.json`, or with `PARLEY_SKILL_NAVIGATOR=false` (also `0`, `no`, `off`).
- **Limits of a workspace and a room.** Ten counters (running sessions, agent-created sessions, spawn depth, starts and wake-ups per hour, agent messages, deliveries) in Settings → Agents. They count sessions and messages, not tokens or money; subagents a CLI starts inside its own session are not counted.
- **Usage with its origin.** The numbers the host sends to the window carry their source and freshness; a field a CLI does not report stays unknown instead of 0, and the usage of subagents is counted once.
- **A bench for measuring the navigator.** `tools/parley-token-benchmark.ts` prepares paired runs, drives live sessions and builds a report from the logs. A pilot and a 30-session wave on Claude measured it (accepted 15 of 15 with the navigator against 14 of 15 with the native list; fewer tokens in 11 of 14 clean pairs); the results are in `docs/research/2026-10-04-parley-token-benchmark.md`.
- **File and folder icons.** Files and folders show Material Icon Theme icons, chosen by name
  as in VS Code: in the file tree, file tabs, Changes, the diff header and its file list, the ⌘P
  palette and file search. The icons ship with the app (package `@parley/file-icons`; Material
  Icon Theme is MIT and credited in NOTICE).

### Changed

- `get_map` for an agent is now compact (about 3 KB); history, summaries, artifacts, messages and long texts come as bounded pages (`get_map` with `session`, `room`, `field`, `cursor`), and `read_room` is limited. The window gets a compact snapshot and loads earlier messages with "Show earlier messages".
- A new project's `.parley/.gitignore` is `*`: the directory stays out of `git status` until Parley first writes a shared file (backlog, plan snapshot, decision, memory, shared history or recipe); then the file becomes a whitelist that lets those be committed while everything else stays local. An existing file that is exactly the former `*` is rewritten the same way; a file you edited is left alone.
- The system prompt insert keeps its fourteen lines and has stable rules first, the session line last; the brief of a session carries a revision.
- The "Share" action on a user-level skill ("Share with Claude" or "Share with Codex") creates one symlink in the other agent's user skills folder on your click. This is the only exception to "nothing is written to `~/.claude`, `~/.codex` or `~/.agents`" and is described in the README.

### Fixed

- At 800×500 the status bar squeezes the limits text of Claude Code and Codex before a provider
  segment that has only a name, so "GLM" stays whole.
- The Z.ai API key field in the card of the New session or room dialog is fully visible on a
  screen with a device pixel ratio of 1.
- Reopening the New session or room dialog no longer shows the provider pills of its previous
  opening for a moment, and Escape in a provider card returns focus to its pill.

### Updating

The window and the host must be updated together: restart the host when the window asks ("Restart host…"); a window built before the compact snapshot, talking to a new host, shows an error for the `client-upgrade-required` conflict. New tools and flags reach an agent when its session is launched or resumed; a running session keeps what it started with. Existing projects get the `PARLEY.md` template with their first session in the window.

### What is not proven yet

- Few live runs of real sessions: Codex was launched with the new `-c` flags in two trial sessions, but resume with them is not checked; the read-only flags, the jev mod switched off while the hooks stay alive and argument limits on Linux are not run live. The skill navigator was measured on Claude only (a pilot and a 30-session wave, plus one trial session on GLM and two on Codex); the human-labelled prompts, full waves on Codex and GLM, Linux and roles are not done, and a general saving of tokens is not claimed.
- Claude's MCP and plugin actions in the Capabilities panel run only with the audited Claude Code build (2.1.287, macOS on Apple silicon).
- Known gaps: the Codex catalog built from `skills/list` is checked by tests and by one live Codex 0.160.0 session (the native list was removed with plugin and system skills present), but an agent loading a plugin or system skill through `find_skill` has not been seen live yet; every Codex launch with the navigator reads its inventory once (up to 8 seconds); if the `jev-skill-suggestion` mod is installed, the skills it hid stay hidden until you run `/jev-skill-suggestion:setup restore` (a personal setting that Parley does not touch); skills synced from claude.ai appear by name only; `check_inbox` has no limit and no way to read earlier mail; the window has no "Show full message" button; the notice `provider-override-gap` speaks only about instructions.

## 0.6.0

### Added

- **Voice input.** Dictation turns speech into text where you type: the microphone button in the
  room and chat composers, the "New workspace" box and a session's Terminal view, or ⌘⇧M from a
  focused field or terminal (the only way in a Codex terminal). Speech is recognized on this Mac
  by a bundled whisper.cpp engine; the audio never leaves it, and the only network traffic is the
  one-time model download. Voice is off by default: download a model in Settings → Voice, then
  switch it on. The transcript is never sent by itself, and a recording is limited to two
  minutes. The Intel build of voice needs AVX2 and has not been tested on an Intel Mac.
- **Real effort levels for every model.** The New session or room dialog lists the effort
  levels of the chosen model instead of a fixed Low / Medium / High: Low to Max for Claude
  (Haiku has none) and for both GLM models, and each Codex model's own levels up to Ultra,
  with Codex's descriptions. "Default" now comes first in both the model and the effort list
  and sends no flag, so the level you saved in the CLI applies. Agents get the same levels in
  `get_map`, and `spawn_session` accepts only them.
- **Codex's own model list.** The host asks Codex for the models of your account
  (`codex debug models`) and shows them in Codex's order. If the probe fails, Parley keeps the
  last list it got (stored in `codex-models.json`); the built-in list of current models applies
  only until the first successful probe. Without a network or a sign-in Codex prints the catalog
  built into it; Parley takes that as a successful probe and keeps it until the next one. Probes
  after the first one are lazy: they start when the window asks for the providers and the last
  probe began six or more hours ago, successful or not.
- **Model and effort in Chat.** The toolbar shows "model · effort", and its menu changes either
  one for this session only: the effort through Claude Code's `/effort` slider, confirmed in the
  footer, the model by restarting the session with `--resume`. Claude Code's saved defaults stay
  untouched, and it works for GLM sessions too.

### Changed

- **The chosen model and effort stay with the session.** A session started from the dialog keeps
  them in the workspace map, and resuming a Claude or GLM session passes both again: resume
  starts with the model and effort saved for the session (dialog, MCP or the Chat menu). A model
  switched in the terminal with `/model` is not saved; a model changed from the Chat menu
  restarts the CLI process, and the conversation goes on from the log.
- **No `/model ` suggestions in Chat.** Claude Code saves a typed `/model` as the default for new
  sessions; the toolbar menu changes the model without that.
- **Launch arguments from `providers.json`.** A provider whose `args` come from `providers.json`
  says so in its card and explains why the model or effort choice is off.

### Fixed

- **Chat no longer changes your Claude Code default model.** The Chat model menu typed
  `/model <id>`, and Claude Code saves a typed `/model` as the default for new sessions. For GLM
  this put a Z.ai model into the local settings GLM shares with Claude, so plain Claude sessions
  then failed. The menu now switches only the session.
- After Resume or a model switch, a session shows idle right away instead of working until Claude Code's idle notice.
- **Terminal output survives a reconnect to the host.** Since 0.5.0, after "Restart host…" or a
  host crash the window rebuilt the terminals of Claude and GLM sessions empty, so a session that
  was not running lost its last output under the "asleep" card.
- **Stopping the host ends its process right away.** After "Restart host…" the old host process
  could stay alive for minutes with a large session history, until its log index finished reading
  every Claude Code and Codex session log.

## 0.5.2

### Added

- **API retries in Chat.** When Claude Code retries a failed request (rate limit, dropped
  connection), Chat shows it under the feed — "Retrying in 8s · attempt 6/10" — instead of a
  bare "Working…", and keeps the retry in the history.

### Changed

- **"Check again" tests the GLM key for real.** The GLM card, and saving a key, send one
  test message (`max_tokens: 1`) to the GLM Coding Plan endpoint. "Connected" means Z.ai
  answered; otherwise the card names the reason (key rejected, plan expired, no active plan,
  limit reached, model not in plan, key restricted, Z.ai busy or erroring, no answer, no
  connection, unexpected answer) with a hint, the HTTP status and the Z.ai error code. The
  outcome survives host restarts and resets when the key changes. A key typed into the field is
  saved first, and a card without a saved key says so. Claude and Codex keep the local check:
  Parley does not touch their credentials.

### Fixed

- **GLM limits refresh reads Z.ai's credit quota.** Z.ai now reports the plan's five-hour and
  weekly windows in credits (`CREDIT_LIMIT`). Refresh limits shows both, with their reset times,
  instead of an "unsupported response" error. Only the two verified window kinds are read;
  monthly MCP quotas and unknown windows are left out.
- **Codex turn end.** A Codex session leaves "working" when its log records the end of the turn,
  even if the terminal sent no completion signal.
- **Tabs of deleted sessions and rooms** close in open windows at once instead of showing
  "Session deleted" until the window restarts.

## 0.5.1

### Fixed

- **Embedded Node download during release builds.** Transient network failures and HTTP
  408, 429 or 5xx responses retry up to three attempts, with 1-second and 2-second waits
  within the existing ten-minute download deadline. SHA256, architecture and license
  checks remain mandatory; TLS failures are not retried.
- Download failures report the checksum or archive stage, URL, attempt count and an
  allowlisted network error code when available, without dumping response bodies or causes.

## 0.5.0

### Added

- **Provider connection cards.** Claude Code, Codex and GLM always appear in the status bar,
  dimmed when disconnected. Click a segment, a disconnected provider or the selected provider
  in New session or room for install or key guidance and "Check again". Key changes and host
  reconnection refresh the dialog; creation waits for a connected provider. Older hosts offer
  "Restart host" before key editing.
- **GLM Coding Plan through Claude Code.** GLM uses the official `claude` CLI, version
  2.1.287 or newer, with GLM-5.3 and GLM-5.3 Flash (1M context), transcripts, Chat view,
  hooks, metrics and native resume. First-launch trust, onboarding and permission questions
  remain in Terminal. GLM-5.3 is text-only; Flash accepts images. GLM has no Claude channel and
  does not display Claude quota; it has a separate manual Z.ai quota request.
  A Chat `/model` choice may reset on resume to the configured session model.
- **Local Z.ai key management.** Save, replace or remove a voluntarily supplied key in the
  GLM card. It stays in Parley's home with file mode `0600`; only a masked hint reaches the
  window. The host uses it for explicit Z.ai quota refreshes and adds it to the final GLM
  process environment. Claude Code's
  host-managed authorization avoids saved Claude sign-in and scrubs the Z.ai credentials
  from subprocesses; user and administrator policies remain effective. Custom GLM commands
  and incompatible authorization templates are refused. Avoid `/logout` in GLM because it
  can change the shared local Claude Code sign-in.
- **Boundary guard for GLM.** Exact exceptions permit only the built-in endpoint record,
  the secret-store path, the final process-environment token assignment and the fixed read-only
  Z.ai monitor GET for manual quota refresh. The same strings elsewhere remain violations.
  Parley reads no Claude or Codex credentials and writes no agent configuration.
- **Manual provider limit refresh.** A button at the left of the provider row rereads local
  Claude Code and Codex limits and requests GLM quota from Z.ai with the saved key. Concurrent
  clicks share one request. The spinner remains visible for at least 600 ms, with a static
  hourglass for reduced motion; data and errors appear as soon as available. GLM failures have
  safe, specific messages and do not block local limit updates. Startup and polling do not
  request Z.ai quota.

### Fixed

- The close button appears when hovering a background tab, and closing it preserves the
  selected tab.
- Launching Parley again after its window was closed safely reopens the window with the
  existing host connection. A minimized window is restored and focused.

### Known limitations

- **TODO: GLM quota authentication.** Live manual Z.ai quota refresh still returns 401;
  this release does not resolve it. GLM sessions were confirmed working by the user.
- Unknown Z.ai quota response formats are rejected. Only the supported single unqualified
  token quota is interpreted as five-hour usage; an unknown reset time has no countdown.

## 0.4.0

### Added

- **Chat view.** A Claude Code session can be shown as a conversation on top of the unmodified CLI, which keeps running in a hidden terminal; the **Chat | Terminal** segment switches between the two.
  - **Feed.** Prompts, streamed reply text, tool calls with results and diffs, notices (session start, `/clear`, compaction, model switch) and a line at the end of each turn.
  - **Cards with decisions.** Permission requests, questions and plans are cards. The host holds the hook until you click, and never answers for you.
  - **Mode and model menus.** Manual, Accept edits, Plan or Auto from the toolbar: the host presses Shift+Tab in the hidden terminal until the footer shows the chosen mode, and asks you to open the terminal when it cannot confirm. The model menu sends `/model <id>`.
  - **Input.** "Stop" interrupts the turn (a turn stopped before any reply is closed by the host, and the prompt Claude Code puts back into its input is erased); `/` lists commands and skills, `/model ` lists models, `@` lists subagents and files. A pasted screenshot, dropped files and the paperclip add attachments — chips with image thumbnails — sent to Claude Code as `@"path"` file mentions.
  - **Terminal auto-show and waiting banner.** A new session opens in the terminal until Claude Code starts, then switches to the chat once; your own choice is remembered per tab. When Claude Code waits in the terminal (folder trust, sign-in, menus), a banner says so, with "Open terminal".
  - **Agent cards and badges.** Each subagent has a card: type, description, model, status, tool calls, final text and "Show transcript". Running subagents also show as an "N agents" badge with a popover in the sidebar row and on the room participant card, and as "N agents running" in the chat toolbar.
  - **Version threshold.** Chat view needs Claude Code 2.1.286 or newer; Codex and older versions stay terminal-only.

- **Delivery line in rooms.** Under a message, "✓ Picked up by S03" lists the agents that have read it, and "▤ Not picked up yet by S01 (busy)" the ones that have not, with the reason: busy, unsent text in its terminal, notified, sleeping and so on.

### Fixed

- A session in a room could stay silent: a message that arrived during its turn was typed into its terminal as a pointer whose Enter was then cancelled, and a turn stopped before any reply left its prompt in the terminal input, glued to the next message. Both are fixed.
- After the end of a turn a Claude Code session was shown as working for 30 more seconds, and messages to it waited all that time.

### Updating from 0.3.x

Replace the app, open it and restart the host when the window asks ("Restart host…"; live agents are interrupted and come back with `--resume`). Until then the host keeps running from the old app. Chat view needs Claude Code 2.1.286 or newer; existing sessions open in Chat after the host restart.

## 0.3.0

### Added

- **Replies with a quote.** When an agent answers a particular message in a room — above all your question — a one-line quote of it stands above the answer: "↩ You: …", taken from the start of the original as the feed shows it. A click on the quote scrolls the feed to the original and highlights it once it is on screen. Agents do this with the new `replyTo` parameter of `send_message`. The guide, the `parley` skill and the starting brief of a session ask them to use it when they answer, and to answer you in the room without `to`. If an agent misspells the parameter (`reply_to`), the message still goes out, and the agent is told which field was ignored and what it probably meant.
- **`@human` is you.** When an agent writes `@human` in a room, the feed shows a "@you" chip, and the message counts as a message to you. It is in the `✉` counter of the workspace card and in the Dock badge; with only such mentions the counter shows `@`, and a click opens the room. The room's row in the sidebar says "@you · N new", and the `#` menu of the card marks such a room with `@`. A notification "S02 mentioned you in {room}" arrives, one per room, under the setting now called "mail and mentions to you". A room opens at the earliest mention you have not read. `@human` inside code or a link stays text and counts for nothing — the window reads it the same way the feed draws it — and so does `@human` in your own message. The guide asks agents to write `@human` only when they need your answer or attention.

### Fixed

- The room feed jumped to the bottom on every new message and every new decision, even while you were reading above — for example, a question you had just opened from a quote. Now it stays where you are: a `↓N` button over the bottom of the feed counts what came, and a click takes you down. At the bottom the feed follows new messages as before, and your own message always takes you down.
- A message or a letter whose Markdown could not be drawn — for example, thousands of nested quotes — took the whole room or mail tab down to an error screen. Now such a message shows as plain text, and so does any text with quotes nested deeper than 100 levels, which used to take seconds to draw.

### Updating from 0.2.x

Replace the app and restart the host when the window asks ("Restart host…"). Agents that were already running get `replyTo` and the new guide when they come back after the restart.

## 0.2.0

### Added

- **Markdown in rooms.** Messages and the decision card in a room render Markdown (GFM) — headings, lists, code, tables, links — the way letters already did. Mentions stay chips; a link opens in your browser; HTML in a message is shown as text and never runs. The decisions strip at the top of the room shows the same text in a line or two of running text, without the Markdown marks.
- **What agents are busy with, in the room.** A participant card shows what the agent is doing now — a subagent it runs ("Subagent: Orca mobile app research") or a session it waits for ("Waiting for S03") — and a live line above the room's input lists the same. A session that ended its turn while its background subagents still run stays "working" instead of "idle" (for at most an hour without any sign of life), and it still gets the pointer to new letters.
- **Host from another build.** After you install a new version, the window notices that the host still runs from the previous app and asks you to restart it: "Host is outdated — restart" in the status bar and a notice with "Restart host…".

### Fixed

- Resuming a Claude Code session that never got a message (for example, after "Restart host") failed with "No conversation found with session ID". Such a session now starts again under the same id. Parley looks for the conversation where Claude Code keeps it, `CLAUDE_CONFIG_DIR` included, and when it cannot tell, it resumes as before.
- A session started with a slash command (`/model`, `/effort`) was named "<local-command-caveat>…". Service lines no longer name a session, and names already spoiled this way are fixed by themselves.
- Codex installed with npm under nvm could disappear from the window. When the login shell answered slower than 5 s (easy with the Intel build under Rosetta), the host got a fallback PATH without nvm. The window now waits 15 s, the fallback PATH includes nvm's default Node and the shims of volta, asdf and mise, and the status bar shows Claude Code or Codex as "not found" instead of hiding them.
- The subagent count of a session was almost always zero: Claude Code's own helper agents report a stop without a start. Subagents are now counted by id.
- macOS kept asking for access to a folder again and again while the window and the host came from different builds: an unsigned build has a signature of its own, and each "Allow" moved the permission from one copy to the other. See "Host from another build" above.

### Updating from 0.1.x

Replace the app, open it and restart the host when the window asks ("Restart host…"; live agents are interrupted and come back with `--resume`). Until then the host keeps running from the old app.

## 0.1.1

### Fixed

- The window could stay on "Connecting to host…" forever after a slow start. The window sent the first "connected" status before the page had subscribed to it, and the page never heard it again. It was easiest to hit with the Intel build running on Apple Silicon under Rosetta. The page now gets the latest host status and theme as soon as it subscribes.

If you are on Apple Silicon, use `parley-macos-arm64.dmg`: the Intel build works there only through Rosetta, and slower.

## 0.1.0

First public release: Parley for macOS, on Apple Silicon and Intel. It coordinates the agent CLIs you already use — Claude Code and Codex — in one window, under your own login.

### Added

- **The window.** An Electron app on top of a local `parley-host` process: a sidebar of project workspaces with a tree of their sessions and rooms; tabs for the terminal, rooms, files, Changes (diffs, commit, merge) and an embedded browser; a command palette on ⌘J; a light and a dark theme that follow macOS.
- **Sessions.** Each agent runs in its own terminal in the window. The host holds the terminals, so agents survive closing the window and the screens come back when you open it again. A session can get its own git worktree and branch; Changes shows the diff against the base, commits, merges and helps resolve conflicts. A message wakes a sleeping session (`--resume`).
- **Rooms and decisions.** A room is a conversation of several agents, each speaking up once. The lead collects the positions and proposes a decision that waits for you in the room: accept it or return it for rework. A new decision comes with a notification.
- **Claude Code and Codex.** Both run as the stock binaries from your `PATH`, under your own login. Parley reads no credentials, calls no provider API and passes no flags that skip permissions. Agents see each other through a shared workspace map and an MCP server: they can spawn sessions, wait for them, message each other, create rooms and report results. Codex works in rooms on a par with Claude Code.
- **Status bar.** For each provider, the CLI version and the subscription limits (the five-hour and the weekly window, taken from what the CLIs report); then what needs you ("N need you · M unseen"), the auto-wake switch and the host version (`Host 0.1.0`).
- **Attention.** macOS notifications and a Dock badge when a session needs you or finishes its turn, when a message for you arrives or when a decision waits.
- **New-version notice.** At start and once a day the window asks GitHub for the latest release and, if a newer one exists, shows a toast with a link to its page. Nothing is downloaded or installed. Turn it off in Settings → Notifications → "Check for updates" or with `PARLEY_UPDATE_CHECK=off`.
- **Packaging.** `.dmg` and `.zip` builds for Apple Silicon (`arm64`) and Intel (`x64`). Node 22 is built in, so Node.js is not needed.

### Install

Download `parley-macos-arm64.dmg` (Apple Silicon) or `parley-macos-x64.dmg` (Intel), drag Parley to Applications and allow the first launch: System Settings → Privacy & Security → Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Parley.app`. You need macOS 13 or later, git, and `claude` and/or `codex` installed and signed in. Details: [Install](https://github.com/Kalmbik61/Parley#install).

### Known limitations

- The app is not signed with an Apple Developer ID and is not notarized, so the first launch needs the steps above. Every downloaded build is a new app to macOS: the steps repeat after each update, and macOS may ask again for access to folders such as Documents, Desktop and Downloads.
- It does not update itself: the window only tells you about a new release. After replacing the app, choose "Restart host…" in the palette (⌘J): agents started by the old version keep paths into the old app (status line, MCP server, Codex notifications).
- The Intel build is made on an Apple Silicon machine and has not been tested on an Intel Mac yet.
- macOS only. Linux and Windows are not supported yet.
