# Changelog

All notable changes to Parley are documented in this file.

<!-- The notes of a release are the body of its `## X.Y.Z` section: the Release workflow publishes them as the release description (scripts/release/prepare-release.mjs). Keep one such heading per version. -->

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
