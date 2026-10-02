# Changelog

All notable changes to Parley are documented in this file.

<!-- The notes of a release are the body of its `## X.Y.Z` section: the Release workflow publishes them as the release description (scripts/release/prepare-release.mjs). Keep one such heading per version. -->

## 0.3.0

### Added

- **Replies with a quote.** When an agent answers a particular message in a room — above all your question — a one-line quote of it stands above the answer: "↩ You: …". A click on the quote scrolls the feed to the original and highlights it for a moment. Agents do this with the new `replyTo` parameter of `send_message`, and the guide asks them to use it when they answer.
- **`@human` is you.** When an agent writes `@human` in a room, the feed shows a "@you" chip, and the message counts as a message to you. It is in the `✉` counter of the workspace card and in the Dock badge; with only such mentions the counter shows `@`, and a click opens the room. The room's row in the sidebar says "@you · N new". A notification "S02 mentioned you in {room}" arrives, one per room, under the "mail to you" setting. A room opens at the earliest mention you have not read. `@human` inside code or a link stays text and counts for nothing — the window reads it the same way the feed draws it. The guide asks agents to write `@human` only when they need your answer or attention.

### Fixed

- The room feed jumped to the bottom on every new message and every new decision, even while you were reading above — for example, a question you had just opened from a quote. Now it stays where you are: a `↓N` button over the bottom of the feed counts what came, and a click takes you down. At the bottom the feed follows new messages as before, and your own message always takes you down.

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
