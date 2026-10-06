# Changelog

All notable changes to Parley are documented in this file.

<!-- The notes of a release are the body of its `## X.Y.Z` section: the Release workflow publishes them as the release description (scripts/release/prepare-release.mjs). Keep one such heading per version. -->

## Unreleased

Written in the branch `feat/parley-upgrade`; no version is announced. It is checked by tests, and the live checks with real `claude` and `codex` sessions are still open (see "What is not proven yet").

### Added

- **Team rules in `PARLEY.md`.** A file in the project root with the rules for agents that work together. Every session gets it on top of its own instructions: Claude through `--append-system-prompt`, Codex through a new `-c developer_instructions=…` (placeholder `{developerInstructions}`). Codex also reads `CLAUDE.md` where there is no `AGENTS.md` (`project_doc_fallback_filenames`). The host creates a template once, before the first session of the window in a project, and the window says so; "Open PARLEY.md" and "Create PARLEY.md" are in the project menu. A launch whose whole layer is over 96 KiB stops with `session-layer-too-large`.
- **Roles.** Eight built-in roles (planner, architect, critic, executor, reviewer, verifier, debugger, researcher) and the native agents of Claude and Codex, chosen per agent row in "New session or room" or with `role` in `spawn_session` (`list_roles` lists them). A read-only role is enforced by the CLI (`--disallowedTools`, `sandbox_mode="read-only"`); a runner that cannot deliver a role does not start the session.
- **Plans and a backlog.** Rooms get a mode — Free, Checklist or Verified — with plans of items, owners, dependencies and independent verification; Parley wakes owners in turn. Tools: `set_room_mode`, `plan_update`, `plan_submit`, `plan_verify`, `propose_completion`, and `propose_decision` with a plan. The project backlog (`.parley/backlog.md`) has a tab; agents propose findings with `backlog_suggest` and read with `backlog_list`.
- **Recipes.** "Plan & build", "Review" and "Debug", and your own in `.parley/recipes/`: a recipe fills the roles, the mode and the lead of a new room, and only the lead gets its playbook. "Save as recipe" writes a project recipe and opens it in your system editor.
- **Decisions, room histories, memory and search.** Accepted decisions are written to `.parley/decisions/`; the room's "History" menu shares a snapshot to git on request; `.parley/memory.md` keeps facts, lessons and agreements that agents propose (`remember`) and you accept; `search_history` and the Search tab look through all of it without an index. The project panel has the tabs Capabilities, Backlog, Decisions, Memory and Search.
- **Capabilities.** The panel shows the skills, MCP servers and plugins that Claude and Codex see in a project and runs the agents' own CLI to add and remove MCP servers, manage plugins and share a skill with the other agent. Secrets are never shown.
- **Skill navigator, off by default.** Settings → Agents → "Skill navigator" (or `PARLEY_SKILL_NAVIGATOR=1`) adds `find_skill` and shortens the native skill list: for Claude `SLASH_COMMAND_TOOL_CHAR_BUDGET=1` and the `jev-skill-suggestion` mod switched off for the session, for Codex `-c skills.include_instructions=false`.
- **Limits of a workspace and a room.** Ten counters (running sessions, agent-created sessions, spawn depth, starts and wake-ups per hour, agent messages, deliveries) in Settings → Agents. They count sessions and messages, not tokens or money; subagents a CLI starts inside its own session are not counted.
- **Usage with its origin.** The numbers the host sends to the window carry their source and freshness; a field a CLI does not report stays unknown instead of 0, and the usage of subagents is counted once.
- **A bench for measuring the navigator.** `tools/parley-token-benchmark.ts` prepares paired runs and builds a report from the logs; it makes no paid model calls.

### Changed

- `get_map` for an agent is now compact (about 3 KB); history, summaries, artifacts, messages and long texts come as bounded pages (`get_map` with `session`, `room`, `field`, `cursor`), and `read_room` is limited. The window gets a compact snapshot and loads earlier messages with "Show earlier messages".
- The `.parley/.gitignore` of a new project is a whitelist: the backlog, plan snapshots, decisions, memory, shared histories and recipes can be committed, everything else stays local. An existing file that is exactly the former `*` is rewritten the first time a shared file is written; a file you edited is left alone.
- The system prompt insert keeps its fourteen lines and has stable rules first, the session line last; the brief of a session carries a revision.
- The "Share" action on a user-level skill ("Share with Claude" or "Share with Codex") creates one symlink in the other agent's user skills folder on your click. This is the only exception to "nothing is written to `~/.claude`, `~/.codex` or `~/.agents`" and is described in the README.

### Updating

The window and the host must be updated together: restart the host when the window asks ("Restart host…"); a window built before the compact snapshot, talking to a new host, shows an error for the `client-upgrade-required` conflict. New tools and flags reach an agent when its session is launched or resumed; a running session keeps what it started with. Existing projects get the `PARLEY.md` template with their first session in the window.

### What is not proven yet

- No live run of real sessions: Codex launch and resume with the new `-c` flags, the read-only flags, the jev mod switched off while the hooks stay alive, argument limits on Linux. The paid measurement and the human-labelled prompts for the skill navigator have not been done; nothing is claimed about a saving of tokens, and the navigator stays off by default.
- Claude's MCP and plugin actions in the Capabilities panel run only with the audited Claude Code build (2.1.287, macOS on Apple silicon).
- Known gaps: after the shortening Codex offers only user and project skills; skills that the jev mod hid stay hidden until you run `/jev-skill-suggestion:setup restore` (a personal setting that Parley does not touch — do it before relying on the navigator); skills synced from claude.ai appear by name only; `check_inbox` has no limit and no way to read earlier mail; the window has no "Show full message" button; the notice `provider-override-gap` speaks only about instructions; GLM is not covered.

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
