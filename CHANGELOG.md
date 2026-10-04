# Changelog

All notable changes to Parley are documented in this file.

<!-- The notes of a release are the body of its `## X.Y.Z` section: the Release workflow publishes them as the release description (scripts/release/prepare-release.mjs). Keep one such heading per version. -->

## Unreleased

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
