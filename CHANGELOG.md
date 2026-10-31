# Changelog

All notable changes to Parley are documented in this file.

<!-- The notes of a release are the body of its `## X.Y.Z` section: the Release workflow publishes them as the release description (scripts/release/prepare-release.mjs). Keep one such heading per version. -->

## Unreleased

### Added

- Parley can put idle Claude Code agents to sleep to free memory. It is off by default: turn it on with Settings → Agents → "Sleep idle agents after (min, 0 = off)". An agent falls asleep once its turn has been over for that many minutes and nothing is pending: no background task, approval, human draft or unread mail. Its process stops, and the next letter wakes it with its history. Other agents see it as `asleep`, and `wait_for` on it answers at once with a hint. Such wakes do not spend the resume or launch limits, and a sleeping agent's mail still wakes it after a host restart. "Keep awake" in a session's menu exempts that session. Codex sessions stay awake for now. An agent waiting in `wait_for` also falls asleep once a single wait has lasted that long; if it was waiting for another session, a system letter wakes it when that session finishes, gets stuck or falls asleep. The queen of a finished swarm falls asleep as soon as the swarm's result is delivered, without waiting for that time; a letter or Resume wakes it.
- Parley can cap how many agents run at once on the machine, across all projects. It is off by default: set Settings → Agents → "Agents running at once on this machine" to a number (1–128) or `auto`, which is 75% of RAM in GB (18 on a 24 GB Mac). At the cap a new launch does not fail: the session is created and waits in a queue, and it starts by itself when a slot frees, also after a host restart. The queue goes by class: your own launches first, then wake-ups by a letter, then launches by agents (`create_session` and swarms). Your own launches may run up to 2 over the cap, and a third one waits at the head of the queue. Working agents are never stopped to make room. Launches of the autonomous room engine are never queued, but they count toward the cap.
- Parley reads the memory pressure of the machine every 10 seconds, from the system's own pressure level on macOS and Linux; when it cannot tell, it behaves as if memory were fine. While the pressure is critical, the cap counts as full: agent launches wait in the queue, and your own launches still start, up to 2 over the cap, with a notice that they started while memory is critical.
- Idle agents fall asleep sooner when memory is low or a queued launch needs a slot. The wait drops from "Sleep idle agents after" to "Sleep idle agents sooner when the machine is busy" (5 minutes by default, 1–60): the agent that has been idle the longest goes first, one per 30 seconds when the pressure is high and one per 10 seconds when it is critical, plus one for each queued launch that needs a slot. A working agent is never put to sleep. With "Sleep idle agents after" at 0 there is no sleep for memory or for a slot, and Settings warns that queued launches may wait a long time. Such a session reads `asleep · memory was low` or `asleep · freed a slot`, and a letter wakes it as before.
- Sessions and agents have a new state, `queued`. The sidebar row reads `queued · limit 18/18` or `queued · low memory`, and agents see the same state in `get_map` and in their brief. `create_session`, `create_swarm` and `swarm_add` answer `queued` with the reason instead of failing, and `wait_for` on a queued session waits for it as for a running one.
- Agents can see how busy Parley and the machine are with the new `get_capacity` tool: live, asleep and queued sessions on the machine and in their workspace, their own child sessions, subagents and background tasks, the limits that apply and how much of each is used, and the memory pressure. It also says how many sessions can start right now and which limit stops the rest. A room lead is advised to call it before handing out parts to run in parallel.
- The status bar shows how many agents run on the machine: `Agents 17/18 · 3 queued · memory warn`, or just `Agents 5` when there is no cap and nothing else to report. A click lists the queued launches with their reasons and waiting time, the memory pressure and swap, and when idle agents fall asleep; "Limits in Settings" opens the agent settings. These are the same numbers `get_capacity` gives agents.

### Changed

- The limits on what agents create — new sessions per workspace and per room, swarm sessions and swarms per workspace — now count the last 24 hours (a sliding window) instead of all time. Before, the counters only grew, so in a long-running workspace agents hit a limit for good and the only way on was to raise it again; now a creation stops counting after a day. Settings → Limits names them "… per day", the defaults stay 50, 12, 64 and 6, and a refusal says how many agents created in the last 24 hours and that waiting also helps. The count starts from zero after the update.
- The host no longer runs `ps` for its own agent processes when it checks whether sessions are alive, so the check is lighter.

## 0.26.0

A session can continue on another provider, finished turns in Chat fold their work into a header, `get_map` fits in an agent's answer, and Restart Host no longer hangs on a stuck host.

### Added

- A session can continue on another provider: "Continue on another provider…" in the session menu, in the banner above the chat composer ("Out of … usage until …"), on the card of a session that is not running, and in the usage-limit notification opens a dialog to pick the provider, model and effort. The session keeps its id, rooms, leadership, child sessions, mail and worktree; only the agent behind it changes. The new agent gets a handover package as its first message (a brief from the map, the state of its obligations, the working copy and the tail of the previous conversation), the feed shows a "Continued on …" divider, and the room lead gets a letter from `parley`. Between Claude accounts the conversation itself continues: the new agent resumes a fork of the previous transcript with its full context (the first turn on the new account re-caches it), and the original stays untouched.
- An agent can ask for such a switch with `request_agent_switch`: the request arrives as a consent card in the window, the island and Telegram, and nothing happens without the human's answer. Allow on the card stops the working agent and continues it on the chosen provider.
- Session usage is split into segments by agent: the usage popover lists each provider, account and model the session ran on with its own tokens and cost, and the room total sums the segments.
- **Finished turns fold in Chat.** A finished turn shows its prompt, a status line ("Completed in 2m 31s", or "Stopped" / "Failed") and the final answer; the work in between (tool calls, intermediate replies, subagents) folds under a header that names the kinds of work, for example "Read files, ran commands, edited files". "Finished turns" in Settings → Appearance picks Fold work (the default, replies stay visible), Final answer only, or Expanded (the previous flat feed). A running, stopped or failed turn never folds, and neither do permission, question and plan cards. ([#144](https://github.com/Kalmbik61/Parley/pull/144))

### Changed

- Letters to agents about a usage limit now suggest continuing the session on another provider.
- A change of a room's owner writes a line into the room feed and sends letters to the new and the previous owner.
- Sessions of a removed provider now sleep safely: mail waits (`provider-missing`) instead of failing a resume, and the not-running card offers "Continue on another provider…" instead of Resume.
- Confirming the removal of your own provider account lists the sessions that run on it, each with "Continue on…".
- Reply on an agent's message in a room now addresses that agent: the letter goes to them without a hand-typed `@`, joined with any mentions you add. The plate above the composer reads "Reply to S07 …" (and notes when the author has left the room); × removes both the quote and the addressee. `rooms.send` takes an optional `replyTo`, so the host stores the link like an agent's `send_message replyTo` and the feed shows a native quote instead of a Markdown copy; a selected fragment still travels as a `>` quote.
- The session title in the chat toolbar is a plate hanging from the top edge of the panel, like a notch: the title is shown as written (no capitals, no letter spacing) in the app font, on an accent fill with smooth curved sides. Colours come from the new `--session-title-fill` / `--session-title-ink` tokens in both themes.
- An agent can close the pages it opened in the browser panel with the new `browser_close` tool, so it can free a slot at the limit of 5 pages instead of asking the human. Pages the human opened or moved into the panel cannot be closed this way. Closing works like the cross on a page tab: the active page moves to a neighbour, the last page removes the panel, and keyboard focus and the active tab do not change.
- An agent can close the sessions it created with `create_session`, and the sessions those created in turn, with `close_session` — without asking the human, once their work is accepted or no longer needed. Closing its own session still needs the human's consent. Sessions made by the human, by a colleague, or by a swarm, and swarm members, cannot be closed this way; the system insert, `read_guide` and the skill stub say so.
- **`get_map` fits in an agent's answer.** Without arguments it returns an overview of at most 48 KiB: short rows for sessions, rooms and plans, each list with its total and a cursor for the next page (`get_map {field: "sessions", cursor}`), with the calling session, its rooms and their plans first. A cursor that no longer matches the map answers `stale-cursor`. Reads of one session or room work as before. Before, a large workspace produced a map of 185–233 KB that Claude Code saved to a file instead of reading it. ([#144](https://github.com/Kalmbik61/Parley/pull/144))

### Fixed

- **Restart Host no longer hangs on a stuck host.** It waited for the old host's answer to `host.shutdown` with no deadline, so a host whose socket stayed open but silent kept the restart waiting forever. Now it waits for the old host to exit up to a deadline, then stops it with SIGTERM and SIGKILL after checking that the process is still a Parley host, and connects to a new host; if the old host still does not exit, Restart Host reports an error instead of starting a second one. ([#144](https://github.com/Kalmbik61/Parley/pull/144))
- Space on a focused button activates the button instead of jumping to the message field. ([#144](https://github.com/Kalmbik61/Parley/pull/144))

### What is not proven yet

- Restart Host on a really stuck host, an inline `get_map` in a large workspace and turn folding on long sessions are covered by tests only; they have not been checked live.

## 0.25.0

Agents can run a research swarm for large read-only tasks, links in Chat and room feeds open in the side browser, and a deleted worktree folder no longer hides a project's memory and backlog.

### Added

- **Research swarms.** For a big read-only task that does not fit one context (a whole-repository audit, a large document set, a web search) an agent can start a swarm with `create_swarm`. A queen session splits the task, adds drones that read slices and verifiers that recheck claims (`swarm_add`), and hands one summary back to whoever started the swarm. Swarm members only read; they are closed when they hand in or when the swarm ends. Swarms show in the sidebar, the queen's chat header, the workspace card and the island, with an animated honeycomb icon; the swarm row menu opens the queen, cancels the swarm or marks its result as seen. ([#133](https://github.com/Kalmbik61/Parley/pull/133))
- Swarms have their own limits in Settings: sessions per swarm (16), running sessions per swarm (8), agent-created swarms (6) and swarm sessions (64) per workspace, and a swarm lifetime (90 minutes, 0 = no limit). Swarm sessions do not use the workspace's new-session budget, but they share its running-session and launch limits. ([#133](https://github.com/Kalmbik61/Parley/pull/133))
- The built-in `research-swarm` skill tells the queen when a swarm is worth it, how to cut the task, what drones hand in, and how to verify and summarise. `create_swarm` and the queen's brief point to it, and both say that a narrow task is faster and cheaper with one agent. ([#135](https://github.com/Kalmbik61/Parley/pull/135))

### Changed

- Agents are told to keep implementation on standard-tier models (Executor) and to leave preparation, leading and review to strong ones; a strong model takes code only for a named reason. The rule is in the system insert, `read_guide` (topics `tools` and `lead`), the lead's brief, the Planner and Feature Lead prompts and the `PARLEY.md` template; a project's `PARLEY.md` can change it. ([#137](https://github.com/Kalmbik61/Parley/pull/137))
- A plain click on an http(s) link in a session's Chat or a room feed opens the page in that session's or room's browser panel: an address already open is reused, a closed panel opens, and the 5-page limit shows a toast. Views without a browser panel (mail, file previews) still open a tab. The link menu's Parley browser item does the same; the system browser and Copy link are unchanged. ([#134](https://github.com/Kalmbik61/Parley/pull/134))

### Fixed

- A git worktree whose folder was deleted (listed by `git worktree list` as `prunable`) no longer makes the whole project unavailable. Before, project memory, backlog and decisions were skipped, and every launch said "resolve memory.md conflicts" although memory.md was fine. When the project's Git repository really cannot be verified, the notice now says so instead of blaming memory.md. ([#138](https://github.com/Kalmbik61/Parley/pull/138))

### What is not proven yet

- `create_swarm` has not run a real task yet: both pilots emulated a swarm with ordinary sessions, so automatic closing, the "all handed in" letter and the swarm limits are covered by tests only.
- In the pilots, on a narrow task (one module, about 15 files) a single agent covered more and finished sooner at about the same cost. On a wide audit of Parley's code the swarm finished a little sooner (12 against 14 minutes), found somewhat more and cost less, but a larger share of its findings was false (15 % against 11 %), and its verifier passed three of the five false ones.

## 0.24.0

The assistant's voice can use the larger Qwen3-TTS 1.7B model, and sleeping sessions are marked with 💤 in the sidebar.

### Added

- **Qwen3-TTS 1.7B voice.** Settings → Assistant → Voice lists the 0.6B and 1.7B models, each with its own Download, Cancel, Delete and progress. The assistant speaks with the largest downloaded model; nothing downloads on its own. ([#132](https://github.com/Kalmbik61/Parley/pull/132))
- Sleeping sessions (no process; Resume wakes them) show 💤 in the sidebar instead of their last result's glyph, with an "Asleep" tooltip. The state word still says done, failed or asleep. ([#131](https://github.com/Kalmbik61/Parley/pull/131))

### Fixed

- A re-opened Settings window no longer keeps stale download progress and Cancel after a voice model finishes downloading or is removed. A model that finishes downloading mid-sentence takes over from the next sentence instead of cutting the current one. ([#132](https://github.com/Kalmbik61/Parley/pull/132))

### What is not proven yet

- How fast the 1.7B voice speaks on a real machine has not been measured.

## 0.23.0

The assistant gets hands: it sees every work, room and session, reads them for you and prepares a plan of actions you confirm with one click. Chat and rooms learn Reply quotes, code Copy and path links, the sidebar nests agent-created sessions under their creator, and default limits are higher.

### Added

- **The assistant acts on a plan you confirm.** Ask the assistant to start agents, rooms or sessions and it shows one card with the whole plan: which project, role, provider and model each new agent gets. Nothing runs until you click on the card (on the island or in Telegram); the plan then runs step by step and stops at the first failure, saying where it stopped. ([#128](https://github.com/Kalmbik61/Parley/pull/128))
  - The assistant sees every open work, room and session, finds them by the words you use (project names included, closed and archived ones too) and reads a room or a session's history page by page.
- **Reply to a message.** A Reply action next to Copy on a model answer in Chat and on an agent's message in a room puts a quote above the input. A selected fragment is quoted in full; otherwise the start of the message, up to 300 characters. ([#123](https://github.com/Kalmbik61/Parley/pull/123))
- **Chat links, code Copy and path links.** Code blocks have Copy, links open in Parley's browser with a link menu, and a file path becomes a link while Cmd/Ctrl is held over it. Mail letters render with the same Markdown as rooms. Codex prompts show their attachments as chips and thumbnails. ([#123](https://github.com/Kalmbik61/Parley/pull/123))
- The Chat/Terminal toolbar names the session the tab belongs to, as in the sidebar. ([#123](https://github.com/Kalmbik61/Parley/pull/123))
- **Sessions under their creator.** A session an agent starts with `create_session` sits under the creator's row in the sidebar, with tree lines. Only the sidebar reads this; mail, rights and limits are unchanged. ([#125](https://github.com/Kalmbik61/Parley/pull/125))
- Archived works show 💤 in the sidebar. ([#126](https://github.com/Kalmbik61/Parley/pull/126))

### Changed

- **Higher default limits.** A workspace now runs up to 24 live sessions (was 10), a room up to 12 (was 6), with 50 new sessions and 60 launches per hour. Message limits are unchanged. ([#127](https://github.com/Kalmbik61/Parley/pull/127), [#129](https://github.com/Kalmbik61/Parley/pull/129))
- On a display without a notch, the island's pill shows the assistant's speaking face while it speaks, without an orange focus ring around it. ([#122](https://github.com/Kalmbik61/Parley/pull/122))

### Fixed

- Custom providers and subscription accounts show their vendor logo on the island instead of the Parley icon. ([#120](https://github.com/Kalmbik61/Parley/pull/120))
- GLM sessions and custom providers with a key no longer stop on Claude Code's auto mode notice ("this session isn't eligible… ask your gateway to implement"). Their endpoints cannot run auto mode's server-side checks, so Parley starts them with `CLAUDE_CODE_AUTO_MODE_SERVER=0`: auto mode checks actions with Claude Code's own classifier requests on the provider's quota, as before, without holding the first action until someone presses Enter in the terminal. ([#121](https://github.com/Kalmbik61/Parley/pull/121))
- A start prompt given together with blocked tools reaches the model again instead of being read as more blocked tools. ([#124](https://github.com/Kalmbik61/Parley/pull/124))
- A message that starts with an absolute path is no longer taken for a slash command, so a Reply quote goes out with it; the link menu opens at the cursor. ([#123](https://github.com/Kalmbik61/Parley/pull/123))
- Autonomous mode outside a git repository is refused clearly: the project must be the repository's root, the room dialog hints at it, and a failed git check stops the plan with a reason instead of retrying silently. ([#130](https://github.com/Kalmbik61/Parley/pull/130))

### What is not proven yet

- The assistant's plans were checked with tests and E2E; a live run on real agents in the built app has not been done.

## 0.22.0

The largest release so far. Works move from `map.json` files into one SQLite database, and letters stop refreshing the whole window, so long works with busy rooms stay fast. A room can run its plan on its own in the new Autonomous mode. Agents take fewer turns: only urgent mail wakes them at once. The assistant speaks in a neural voice with a face, and the island answers agents' questions and plans, sits in the notch and plays its own sounds.

### Added

- **Autonomous rooms (stage 1).** A fourth room mode, Autonomous ("The engine runs attempts after Go; the human accepts the result"), next to Free, Checklist and Verified. After your Go the host's engine runs the plan without you: for each item it starts a worker attempt in an isolated clone, runs the checks frozen at Go on a clean checkout of the exact commit, has a verifier judge the criteria, and merges accepted attempts into an integration branch, where the checks run again. ([#110](https://github.com/Kalmbik61/Parley/pull/110))
  - The room shows every attempt as "Attempt N · status · check" (Starting, Running, Submitted, Checking, Accepted, Queued, Integrated, Returned, …). You accept the result at the end, as in a Verified room.
  - The engine is the only one who changes an autonomous plan and starts or closes its sessions. It stops on a spent budget, no progress, a stuck attempt, a host restart or a breach of the attempt's sandbox; the room then shows "Execution stopped" with the reason, and Continue resumes it.
- **The assistant speaks.** With "Speak answers" on (Settings → Assistant), answers are spoken by Qwen3-TTS 0.6B CustomVoice, run on your Mac by speech.cpp: speech is synthesized locally, and no text or audio leaves your Mac for the voice. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
  - Five voices: Serena (the default), Ryan, Aiden, Vivian and Ono Anna. Settings lists them with gender, languages and licence. The assistant speaks of itself in the gender of the voice; when you switch to a voice of another gender mid-conversation, its next answer follows.
  - The weights (one 1214 MB file for all five voices) are downloaded only when you press Download in Settings → Assistant, checked against their sha256, and can be cancelled or deleted, like the Whisper models. After a download, "Preparing voice…" shows until the voice is ready.
  - Speech streams sentence by sentence while the answer is still being written: the first sentence plays as soon as it is complete, and the next ones follow in order. Code blocks are not read aloud. The answer before a confirmation card is spoken too. Esc, Send or Cancel on the card, the speaker button on the island and a new question stop the voice at once. The model leaves memory after 15 minutes without speech and comes back by itself on the next answer.
  - The voice needs Apple Silicon and an answer language of Russian or English. On an Intel Mac, in another language, or when the voice is not downloaded, the answer is text only; a missing voice is named once on the island ("Voice "…" isn't downloaded — open Settings").
- **A face while it talks.** The assistant's swarm becomes a face: the mouth follows the real voice (open vowels, "i", "u" and closed lips), the face reacts to the intonation (eyes up on a question, a pulse on stressed words), and the mood can change from sentence to sentence. Reduce motion keeps a still face. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Island sounds.** The island plays short cues synthesized on the fly, with no sound files: requests, questions and plans, Done, an assistant error, listening, speaking and a sent decision. Settings → Notifications → Island picks the palette (Soft by default, Crystal or Warm; picking one plays a sample) and the volume. "Interface sounds" (hover, open and close, an agent starting) are off by default. Requests follow "Sound when you're needed" and Done follows "Sound when an agent finishes"; thinking and tool steps are always silent. Many agents finishing at once give one sound, not a burst, and while the assistant speaks, interface cues stay quiet and the voice dips under a request. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Swarm reactions and island motion.** The swarms react to events with one short movement: a hop for a permission or a plan, a nod for a question, a spin with sparks for Done, a shake for an error, a glint for an assistant tool step. Small swarms flash instead of moving. The island grows with a slight overshoot and shrinks without one. "Reduce motion" in Settings → Notifications → Island, like the macOS setting, stills the swarm and the island's shape changes; the sounds stay. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **The island in the notch.** On a MacBook with a notch the island is exactly the size of the notch when there is nothing to show. While agents work, a Done is unseen or the assistant is folded away or speaking, it becomes one capsule around the notch, with the swarm or the assistant's face on the left and the Done or working count on the right. It drops down below the notch only when you open it (a click, the hotkey or pulling the tab; the pointer alone does not open it) or when something needs you: a request, a card or the assistant. Displays without a notch, and an island moved to the left or right edge, keep the strip; moving to another display changes the shape at once. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Questions answered on the island.** A question card from an agent shows all of its questions, one to four, page by page with Back and Next, with single or multiple choice, option descriptions and Other. Submit sends every answer at once, and a half-typed answer survives when you click elsewhere. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Plans on the island.** A plan card shows the whole plan as plain text in a scrolling area that fits the island. Two buttons approve it, with edits auto-accepted or approved one by one; changing the plan is an explicit hand-off: "Change plan in terminal" opens the session's terminal. When a plan can only be approved in the terminal, the card says so. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **What an agent is doing.** Open a session row on the island to see its recent actions: the step running now and up to 20 earlier ones (read files, edit files, run command, search, delegate), each with its status and time. Only the opened row is refreshed, and only while the island is open. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Subagents and rooms waiting for you.** A session row lists its active subagents (up to eight, with "+N more") and stays on the island while they run, even after its own Done is cleared. A room whose lead proposes a decision or a completion shows as "Waiting for you" with the live lead's name and an "Open room" button; you answer in the room itself. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Everything pending from the keyboard.** A global shortcut, Control+Alt+I by default, opens the island on the first pending item: folder consents, then agent requests, then rooms waiting for you. Up and Down move between them, Control+Enter opens the selected one in Parley, Esc gives the keyboard back. Settings → Notifications → Island changes or turns off the shortcut and says when another app holds it. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- **Vendor logos.** Custom providers made from the Kimi, DeepSeek, MiniMax, Qwen and OpenRouter presets, and their tiles in "+ Add provider", show the vendor's mark instead of the Parley icon. Kimi and OpenRouter come from their official brand kits, DeepSeek, MiniMax and Qwen from LobeHub's icon set (MIT); sources are listed in NOTICE. ([#109](https://github.com/Kalmbik61/Parley/pull/109), [#119](https://github.com/Kalmbik61/Parley/pull/119))

### Changed

- **Works live in a database.** On its first start, 0.22.0 moves every workspace map into one SQLite database, `~/.parley/parley.db` (WAL), and checks each map against the file before switching. A write now changes only the rows it touches instead of reparsing and rewriting the whole map; letters, read marks and unread counts have their own tables, and texts of written plan and decision exports stay only in their files. A workspace that could not be moved keeps its file, is named in a notice in the window and is tried again on the next start. ([#113](https://github.com/Kalmbik61/Parley/pull/113))
- **Agents' Parley tools run in the host.** An agent's MCP server forwards Parley tool calls to the host over its agent channel instead of reading and rewriting the map itself; parsed maps are cached, and waiters for a lock queue instead of polling the lock file. With an older host the tools fall back to direct access. ([#108](https://github.com/Kalmbik61/Parley/pull/108))
- **A letter no longer refreshes everything.** Letters and read marks reach the window as small `rooms.mail` events, about 1.5 KB per letter, instead of a full refresh and a works snapshot of up to 1 MB. The room feed and Mail load by pages when you open them. On a test stand, 60 letters into a room of three caused 0 full refreshes instead of 60 and sent 88 KB to the window instead of 11 MB. ([#116](https://github.com/Kalmbik61/Parley/pull/116))
- **Agents take fewer turns.** A letter wakes an idle agent at once only when it is urgent: from you, addressed to it, a question or a decision, or an `@sNN` mention. A broadcast note waits for 30 seconds of quiet in the room (at most 120 seconds) and arrives in one batch with the next urgent letter. ([#118](https://github.com/Kalmbik61/Parley/pull/118))
  - `wait_for("inbox")` follows the same rule and marks the mail it returns as read; `get_map` no longer carries the provider catalog; the descriptions of Parley's tools are about half as long (10.2 KB → 5.6 KB), and agents are told to stay silent and wait once.
  - A Codex `wait_for` left behind at the end of a turn no longer takes mail meant for the next turn.
- **A tidier room screen.** Closed participants fold behind an "N closed" toggle. The interrupted banner has one chip per session with its workspace title, opens the session on click, explains what "interrupted" means and can be dismissed. The "History" button left the room header. The browser panel covers the room only in windows narrower than 560 px. ([#111](https://github.com/Kalmbik61/Parley/pull/111))
- Codex sessions show on the island like any other: working, waiting for you, Done with the last answer, in the counters and the work and room groups. A Codex request without a card on the island opens its terminal. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- A Done of a session you are already looking at (its chat or terminal visible in the focused Parley window) no longer pops the island out; it still appears in the list. ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- The island's request sound is the island's own cue instead of the system beep, and Done on the island sounds only with "Sound when an agent finishes". ([#115](https://github.com/Kalmbik61/Parley/pull/115))
- The assistant marks the mood of every sentence, not only the first one; the marks never reach the island, the history or Telegram. Its tone is calm by default: an idle home or something it can't do is a plain fact, sad and angry faces are kept for real failures and are softer than before, and coral is only for the assistant's own errors. ([#115](https://github.com/Kalmbik61/Parley/pull/115))

### Fixed

- After one wrong visibility reading the island could stay on screen while clicks went through it to the window below, and Esc and the shortcut did nothing until a restart. ([#106](https://github.com/Kalmbik61/Parley/pull/106))
- Taking a backlog item into a workspace whose map is larger than 1 MiB no longer fails with "An active target workspace is required". ([#107](https://github.com/Kalmbik61/Parley/pull/107))

### Updating

- The first start of 0.22.0 moves your works into `~/.parley/parley.db`. Each workspace's `map.json` is renamed to `map.v2.json` and `works-index.json` to `works-index.v2.json`; the database does not read them. Parley 0.21 and older do not read the database: to go back, quit Parley and rename the files back. Works changed after the update stay only in the database.
- Building from source needs Node.js 22.16 or newer. The app itself carries its own Node.js.

### Known issues

- The first spoken answer after installing or updating Parley can come as text: the voice engine compiles its shaders for about 15 seconds on its first start. Later answers speak.
- Telegram replies stay text only, and Ukrainian, Kazakh and Belarusian answers have no voice yet.

### What is not proven yet

- Autonomous rooms passed their tests with stub agents; the pilot on real agents was stopped and a full live cycle has not been run.
- The database move, `rooms.mail` and the quiet window were measured on test stands and in E2E; a long live run on real works with many rooms has not been done.

## 0.21.0

A second Claude Code account of yours as a provider, participants that say why they wait for you and come back after a usage limit, folder trust and three approval modes for Codex.

### Added

- **Stuck participants.** An agent that waits for you no longer drops out of the work unnoticed: Parley tells you why, tells the room, and brings the session back after a usage limit. ([#105](https://github.com/Kalmbik61/Parley/pull/105))
  - A session that needs you carries the reason: `approval`, `question`, `limit`, `sign-in` or `starting`. The participant strip and the sidebar rows show it as a label with a tooltip, and the delivery line of a letter to such a session says why it waits ("Not picked up yet by S03 (usage limit until 19:27)").
  - The "needs you" notification, the island and Telegram say the same thing, for example "Waiting for your approval: ls -la" or "Hit its Codex usage limit; resets at 19:27". The macOS banner is silent and the window plays its own sound for it. Settings → Notifications has "Sound when you're needed" and a new "Sound when an agent finishes", off by default.
  - The room feed gets a line when a participant gets stuck and when it is back. Parley also writes to the room lead and to the agents waiting for the stuck session: at once for a usage limit, a sign-in problem or a startup screen, and after 2 minutes for an approval or a question.
  - Agents see it too: `get_map` shows `stuck` on a session, `wait_for` ends with `state: "stuck"`, and `send_message` warns when the addressee is stuck.
  - After a usage limit resets, Parley types "Your usage limit has reset. Read your inbox first, then continue the task the limit interrupted." into the terminal of Codex and GLM sessions, at most twice in a row. Claude Code on a subscription continues by itself. When Parley cannot continue a session (unsent text in its terminal, an open menu, or the limit hit again twice), it tells you.
  - A Codex session stuck on a tool call nobody answered counts as waiting for your approval.
- **Accounts.** A second Claude Code account of yours is now a provider next to your regular Claude Code: its own name, its own sign-in, its own limits. Requires Claude Code **2.1.304 or newer**. ([#105](https://github.com/Kalmbik61/Parley/pull/105))
  - Settings → Providers → "+ Add provider" has a first tile, "Another Claude Code account" ("Your own subscription, signed in from Parley"; the Codex tile says it is coming soon). An account has a name (by default "Claude Code 2", "Claude Code 3", …, saved with the account), its own folder `~/.parley/providers/custom-claude-N/` with its own sign-in, history and memory, and "Bring from Claude Code", which links your `CLAUDE.md`, skills and agents and is on by default. The form has Save, Sign in / Cancel, Sign out and Delete, with "Also delete its folder". Deleting an account signs it out first. The folder of an account with running sessions is not deleted: stop them first.
  - Sign in runs `claude auth login` in a small terminal inside Settings: the browser opens, you sign in with the other account and paste the code into that terminal. Parley asks `claude auth status` for the state and never reads the keychain or any credential file. Your regular Claude Code sign-in is untouched: the keychain entry of an account is separate, per folder.
  - An account is a full provider: sessions, rooms, Chat, roles, the assistant and `create_session` for agents all work with it. It has its own limits segment in the status bar; click it for a card with the state, the limits, Sign in and Open in Settings. An account that is not signed in is dimmed and refuses to launch ("… is not signed in: open Settings → Providers and press Sign in").
  - The launch environment of an account session has no API key and no inherited OAuth variables: `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_*` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` are removed, and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is not set.
  - Agents see accounts too. `get_map` takes the provider rows from the host: availability, sign-in state and limits (the five-hour and weekly windows) per provider, and `create_session` describes accounts. When a participant hits a usage limit, the letter to the lead lists the other signed-in accounts of the same CLI (the regular Claude Code and your accounts; providers with a key, such as GLM or Kimi, are not listed), and the lead asks you before starting a replacement.
  - `parley work session create --provider <account>` is refused, like for providers with a key, because the launch needs the account's folder.
- **Folder trust for agents.** Codex sessions start in a project folder only after you trust the folder for agents. New work asks in the composer once you pick the folder. When a Codex launch comes from somewhere else (an agent's `create_session`, an auto-launch, a letter waking a sleeping session, a project from an earlier version), the launch is held before anything is created and the same question arrives as a card on the island and, if Telegram is linked, in Telegram, with Trust and Deny; an answer in any one place closes the others. Trust continues every held launch of that folder; Deny closes a new session as failed and tells the agent that created it. Settings → Projects lists the trusted folders, and Revoke applies from the next launch. The consent lives in Parley's own `trust.json` and goes to Codex as a launch flag, so Codex no longer shows its own trust screen in these sessions, and Parley never writes to `~/.codex`. Claude Code and GLM launches are not held. ([#104](https://github.com/Kalmbik61/Parley/pull/104))
- `create_session` answers at once with `held: folder-trust` when the Codex launch waits for that consent, instead of waiting for the session to start; the agent is told the session starts by itself after you trust the folder. In the window such a session reads "waiting for folder trust". ([#104](https://github.com/Kalmbik61/Parley/pull/104))

### Changed

- The macOS banner of an agent that finished no longer plays a system sound unless "Sound when an agent finishes" is on. Banners that ask for you are silent; the window plays its own sound instead. ([#105](https://github.com/Kalmbik61/Parley/pull/105))
- **Codex approvals have three modes.** Settings → Agents offers Auto-review (the default: Codex's own reviewer decides, nothing for you to answer, no hooks), Ask in Parley (cards on the island, in Telegram and in the window; Codex asks once to trust Parley's hooks) and Ask in the terminal. They replace the "Answer Codex approvals in Parley" checkbox. A saved `codexApprovals` and `PARLEY_CODEX_APPROVALS` are still read while the new `codexWriteApprovals` / `PARLEY_CODEX_WRITE_APPROVALS` is not set: on becomes Ask in Parley, off becomes Ask in the terminal. Auto-review needs Codex 0.162.0 or newer; on an older Codex (or one whose version Parley could not read) the sessions start in Ask in the terminal, and a known old version is reported once with a notice. ([#104](https://github.com/Kalmbik61/Parley/pull/104))
- **A policy per role for Codex.** Read-only roles run with `approval_policy="never"` and `sandbox_mode="read-only"`: Codex asks nothing, and the sandbox rejects writes. Writing roles and sessions without a role get an explicit `workspace-write` sandbox and the approval mode above. A resumed session gets the same flags, and `-a on-request` is gone from the command line. A role from the project's `.codex/agents` keeps its own sandbox. ([#104](https://github.com/Kalmbik61/Parley/pull/104))
- **A shorter tool list and call examples for Codex.** `remember`, `memory_read` and `search_history` are hidden from Codex sessions, and the policy no longer mentions them; Claude Code and GLM keep them. The session layer gains a short block of examples of how Codex code mode calls Parley's tools (`tools.mcp__parley__get_map({})` and four more) and a rule: call `report` once at the end, then end the turn instead of polling `get_map` or `check_inbox`. ([#104](https://github.com/Kalmbik61/Parley/pull/104))
- Claude Code sessions no longer ask before `browser_evaluate`, `browser_cookies` and `browser_storage`: Parley allows them in advance like every other browser tool. Before, the three sat in `permissions.ask`, which Claude Code treats as stronger than any `allow`, so the prompt came back on every call even after "don't ask again". Codex sessions already called them without approval. ([#103](https://github.com/Kalmbik61/Parley/pull/103))

## 0.20.0

Create a workspace without agents, start several sessions side by side without a room, and dictate the note when you return a room decision for rework.

### Added

- **A workspace without agents.** New workspace now opens with no agents, and Create workspace makes an empty workspace. "Add agent" adds the same rows as New session or room (provider, role, model, effort). One agent starts a session. With two or more, "Put them in a room" (on by default) creates a room with a lead and posts your first prompt to the room; turned off, it starts separate sessions that each get the prompt as their task. ([#101](https://github.com/Kalmbik61/Parley/pull/101))
- **Separate sessions without a room.** New session or room has the same switch: turn it off to add several sessions side by side to a workspace. Recipes and the room mode apply only to rooms. ([#101](https://github.com/Kalmbik61/Parley/pull/101))
- **Dictate the rework note.** The note of "Return for rework" on a room decision has a mic button and takes ⌘⇧M; "Send to lead" waits until the dictation lands in the note. ([#101](https://github.com/Kalmbik61/Parley/pull/101))

### Changed

- Messages you send from Chat while a turn is running wait in the window until the turn ends, by itself or by Stop, and then go out in order. A waiting message has "Send now" and a remove button. ([#99](https://github.com/Kalmbik61/Parley/pull/99))
- Built-in roles: the Feature Lead creates new sessions itself with `create_session`, the Critic checks decisions as well as plans, the Reviewer checks whether tests cover the change, and the Debugger adds a regression test when the failure can be reproduced. ([#99](https://github.com/Kalmbik61/Parley/pull/99), [#100](https://github.com/Kalmbik61/Parley/pull/100))
- The README is shorter. ([#98](https://github.com/Kalmbik61/Parley/pull/98))

### Fixed

- After Stop, a message sent from Chat during the turn no longer hangs as "Queued". ([#99](https://github.com/Kalmbik61/Parley/pull/99))
- Enter or Send while dictating finishes the dictation instead of sending the text typed so far; the transcript lands in the field and the next Enter sends it. This covers Chat, rooms and the first prompt of New workspace. ([#99](https://github.com/Kalmbik61/Parley/pull/99))
- The "Return for rework" form and its note survive switching away from the room tab. ([#99](https://github.com/Kalmbik61/Parley/pull/99))

## 0.19.0

Agents drive their browser panels on any site, Codex no longer asks before Parley's own tools, and typing anywhere in the window goes to the open Chat or room.

### Added

- **Agents drive their browser panels.** An agent opens pages, waits for them to load, navigates (address, back, forward, reload), reads the accessibility tree with `eN` references, clicks, double-clicks, hovers, types, presses keys, scrolls, selects, checks, drags, waits for text, resizes the page and screenshots a page or one element. It works only in the browser panel of its own chat and of the rooms it belongs to; your own browser tabs stay closed to it. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- **Any site.** Agents act and read on any `http(s)` page of their panels, not only on `localhost`. Secrets in addresses, the console, the network log and form fields are still masked as `<redacted>`. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- **Scripts, cookies and storage with approval in Claude Code.** `browser_evaluate` runs JavaScript in the page, and `browser_cookies` and `browser_storage` read and change cookies and storage; in Claude Code each call waits for your approval (except in bypassPermissions mode), so an agent led astray by a page cannot read your session tokens without a question. Codex sessions call them without approval, like all of Parley's tools. ([#95](https://github.com/Kalmbik61/Parley/pull/95), [#97](https://github.com/Kalmbik61/Parley/pull/97))
- **Files.** Agents upload files into file fields (never from secret locations such as `~/.ssh`, keychains or `.env` files) and receive downloads in a folder of their session, kept for seven days. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- **Cookies and storage.** Agents read and change (in Claude Code, after your approval) the cookies and the `localStorage` / `sessionStorage` of the page they are on. The browser's cookies are shared with you, so an agent on a site where you are signed in acts as you. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- **Badge with Stop.** While an agent works, the page row shows its badge with a Stop button, the page frame is highlighted and a dot marks the click. Stop, "Pause agents" and the switch in Settings interrupt an operation that is already running. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- **`parley-browser` skill.** A built-in skill that explains these tools to Claude, GLM and Codex sessions. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- **Type anywhere to write a message.** With a Chat or a room open, a printable key pressed outside any field focuses its message box and the character lands there, as in Telegram. Shortcuts, the terminal, the editor, other fields, open dialogs and the palette are left alone. ([#96](https://github.com/Kalmbik61/Parley/pull/96))

### Changed

- In Claude Code, every browser tool is allowed in advance except `browser_evaluate`, `browser_cookies` and `browser_storage`, which always ask. ([#95](https://github.com/Kalmbik61/Parley/pull/95))
- Codex sessions no longer ask before calling Parley's own tools (for example `create_session`, `close_session` and the browser tools). ([#97](https://github.com/Kalmbik61/Parley/pull/97))
- httpOnly cookie values are never shown to agents. ([#95](https://github.com/Kalmbik61/Parley/pull/95))

### Fixed

- **Annotate outlines the element under the pointer.** With Annotate on, hovering the page draws an amber frame around the element a click would pin, as Select does; before, the frame showed up only after the click. It hides over a pin's number (a click there edits it), while you drag a region, while a comment is open, and when the pointer leaves the page, so it never ends up in the screenshot that goes to the chat. ([#94](https://github.com/Kalmbik61/Parley/pull/94))
- **Accepting a room decision from Telegram or the assistant works when the decision carries a plan.** Before, Accept on a plan amendment or a completion ended as "Revised" while the decision stayed open in Parley. ([#92](https://github.com/Kalmbik61/Parley/pull/92))
- **The island takes the keyboard on the first touch.** When the island opened for a reminder or a Telegram turn, typing into its field and Esc did nothing after Send or a cancelled dictation until you reopened it with the hotkey. ([#93](https://github.com/Kalmbik61/Parley/pull/93))

## 0.18.0

Control Parley from the island assistant and from Telegram. The assistant proposes rooms, answers to agent requests, room decisions and reminders, and you confirm each one on the island; a Telegram bot brings the same cards with buttons, the notifications and the assistant to your phone.

### Added

- **The assistant can propose more than a letter.** Ask it to create a room, to answer an agent's permission, question or plan, or to accept or return a room lead's decision: it shows a card on the island and you press Create, Allow, Deny, Answer, Accept plan or Return. Nothing happens without that press; a card that was already answered elsewhere says so. ([#89](https://github.com/Kalmbik61/Parley/pull/89))
- **Reminders held by the host.** "Check the room in five minutes", "at 15:30" or "every ten minutes": the host fires the check and the island opens with the answer, also after a host restart. ([#89](https://github.com/Kalmbik61/Parley/pull/89))
- **Telegram.** Settings → Notifications → Telegram: paste a bot token from @BotFather, link your Telegram with a code or QR born on your Mac, and switch on what you want: requests that need you as cards with Allow / Deny / Answer buttons, finished turns, letters and mentions (reply to a letter to answer it), assistant cards. Text and voice messages go to the assistant; audio is transcribed on your Mac by the same Whisper engine. One bot for one owner and one Mac, strangers get no reply, and everything still passes through you. ([#90](https://github.com/Kalmbik61/Parley/pull/90))

### Fixed

- **Opening a PDF in the built-in browser no longer crashes the app.** The viewer's subframe is allowed by the browser guard. ([#88](https://github.com/Kalmbik61/Parley/pull/88))

## 0.17.0

Connect your own Anthropic-compatible provider (Kimi, MiniMax, Qwen, DeepSeek, OpenRouter, or any address) as a Claude Code session with its own address, key and models. Your regular Claude Code is not affected: its sign-in, settings and history stay where they were.

### Added

- **Own providers.** Settings → Providers and the "+ Add provider" button in the status bar add a provider from a preset or from your own address, with a name, a key, four model slots (or one model for all), and a "Check" that sends a short test message. Each provider gets its own folder, `~/.parley/providers/<id>/`, with its own sign-in, history and memory. The key is kept in Parley's secrets file and reaches only the process of the provider's session. Requires Claude Code **2.1.302 or newer**.
- **Bring from Claude Code.** An option that links your `CLAUDE.md`, skills and agents into a provider's folder. These are links: editing them in a provider's session changes the originals your regular Claude sessions use. To change something only for one provider, ask its agent to make a copy first; the agent asks whether a change is for both or only for this provider. MCP servers are not shared: each provider has its own.

## 0.16.1

Agents can create ordinary sessions in their workspace again, and Chat recovers after a failed CLI version check.

### Added

- **Agents can create and launch peer sessions with `create_session`.** Choose Claude, Codex, GLM, or another available provider in the current workspace. New sessions have no parent and inherit no room membership; a room lead can invite them separately. Existing creation and launch limits still apply. ([#84](https://github.com/Kalmbik61/Parley/pull/84))

### Fixed

- **Chat no longer stays disabled after a failed CLI version check.** Unknown versions are checked again, explicit refresh updates known versions, and the disabled Chat tooltip explains whether the version is unknown, too old, or unsupported by the host. ([#84](https://github.com/Kalmbik61/Parley/pull/84))

### Changed

- Agents can publish personal execution steps directly to Parley, including when native planning tools or Chat are unavailable. Room cards always offer a Plan entry point, and the Agents panel explains when steps have not been published yet.
- Personal plan updates do not send messages or wake the Feature Lead. Room leads and Feature Leads are instructed to consolidate milestone reports, escalate actionable blockers and decisions, and skip routine step-by-step notifications.

## 0.16.0

Agent plans are now visible in room cards and the Agents tab. Feature Lead and agent-owned rooms let agents coordinate existing sessions, while Codex operations that need attention are easier to find.

### Changed

- **Agents coordinate existing sessions instead of creating child sessions.** The `spawn_session` tool and automatic launch of parent-linked pending sessions have been removed. Create new sessions through the window or CLI, then invite them to a room. Integrations using `create_room` must now provide nonempty working members and an explicit lead among them.

### Added

- **Agent-authored plans appear in room participant cards and the Agents tab.** See the current or next step, confirmed progress and descriptions, and open a participant's plan without leaving the room. Claude task IDs also restore subagent steps; incomplete histories are marked explicitly. Large plans retain their full progress counts and current step.
- **Feature Lead coordinates a feature through rooms.** The new built-in role plans work, coordinates participants and checks the result. An agent can own a room without joining its working members; ownership and room leadership are shown separately in the sidebar.

### Fixed

- **Codex operations that stop producing output surface as needing attention.** A long-running code operation no longer leaves the session looking indefinitely busy when it may need approval.
- **Codex terminal requests remain reachable from the island.** When a waiting request cannot be shown as an interactive card, the island provides a way to open the session's terminal.

## 0.15.2

The host does far less work while agents run: it reads only what agents append to their logs, and the island and notifications no longer download whole chats. The assistant on the island shows what you send at once, queues the messages you send while it answers instead of cancelling the answer, can address agents in a room with a mention, and its Send button shows that it is sending.

### Added

- **The assistant can address agents in a room.** When it passes your message to a room, it can mention the agents it is for: the card shows them as `@` chips, and the letter goes to the room addressed to them, the way an `@` mention you type does. It can still write to an agent's own chat instead; which way it goes depends on how you ask.

### Fixed

- **The host no longer re-reads whole agent transcripts while agents work.** Each time an agent wrote to its log, the host parsed the entire file again, along with every subagent log of the session; with a dozen busy agents this took about 60 % of the host's CPU time. The host now reads only what was appended since the last read: on a 160 MB transcript an update costs about 4 ms of CPU instead of about 500 ms.
- **The island and notifications no longer download the whole chat of a session.** To show a waiting request or the last answer, the window asked the host for the entire chat of the session (up to 4 MB) every time a session started waiting or finished a turn. In two hours with 18 sessions that came to about 530 MB, and the window's other requests queued behind it for up to a minute and a half. They now get only the waiting requests and the last answer.
- **What you send to the assistant shows up right away.** The island used to wait for the host before showing your question, and under load that took seconds. Now the question appears at once with "Sending…".
- **Messages sent while the assistant is answering wait their turn.** Each new message used to cancel the answer in progress, so quick messages in a row left only the last one answered. Now they wait under the answer as grey "Queued" items (× removes one) and go to the assistant together as one message when it finishes. The earlier exchange stays on the island above, dimmed. Dictating with the mic button no longer stops the answer either; the shortcut still interrupts it, as before.
- **The Send button on the assistant's card shows that it is sending.** It spins, and both buttons stay disabled until the message is delivered or fails.

## 0.15.1

Parley stays responsive with many agents at work: the host stops re-reading work maps and agent logs over and over, and agent sessions no longer run your own status line. A process that crashes holding the works index lock no longer leaves Parley unable to save, the window says why a session did not start, and the assistant's answer stays on the island until you close it.

### Changed

- **Agent sessions no longer run your own Claude Code status line.** Claude Code runs the status line command after every model response; in a room with six busy agents a custom one (for example a HUD that calls git, node and jq) ran about once a second and kept 15–20 % of a CPU core busy. Sessions started by Parley now show Parley's short line (model and context use) in their terminal. Your status line in your own terminal is unchanged.
- **The host keeps 1,000 lines of each terminal instead of 5,000.** The host holds a copy of every session's terminal in memory and sends all of it when the window opens the session; with 20–30 sessions the deeper history could take hundreds of megabytes. When you open a session, the terminal now starts with its last 1,000 lines; while it stays open the window keeps up to 5,000 as before. The chat view is not affected.

### Fixed

- **A long answer from the assistant no longer runs off the island.** The question, the answer and the
  confirmation card scroll inside the island, while the swarm, the input field and the hints stay in place.
  While a card waits, the view keeps it and its **Send** button in sight. A long question shows two lines;
  hover it for the whole text.
- **Parley no longer stays stuck when a process dies holding the works index lock.** A lock whose owner is gone is now taken over automatically; a lock left behind by an older version is taken over after 10 seconds. Before, a crashed process could leave Parley unable to save any work until the lock file was deleted by hand. Several processes waiting on the same dead lock no longer race to take it over, and a lock that times out now says who holds it (the owner's pid, whether it is alive, and for how long).
- **The window says why a session did not start.** When the work or room session limit or the hourly starts limit is reached, resuming a session, creating one, creating a room or dropping a session into a room now names the limit (for example "6 of 6 sessions are already running in this room") and what to do about it, including the Settings value to raise. Before, most of these showed only "conflicting state" or nothing at all.
- **Session liveness checks work when Parley or its CLI runs under a non-English locale.**
- **Deleting a work no longer removes its folder when the index is busy.** The folder is now deleted only once the index lock is taken, so a failed delete leaves the work intact.
- **Parley stays responsive with many agents running.** The host now re-reads work maps once per change instead of a dozen times (one watcher on the Parley home, overlapping reads collapsed into one repeat, unchanged maps are not parsed again). Role chips share one read of the Codex configuration instead of starting Codex for each of them (role files are still read fresh). A transcript update recomputes only the session it belongs to, and a live transcript is re-indexed at most every two seconds instead of after every append.
- **The room usage chip no longer loads the host.** It refreshes once a minute (or on Refresh), and the host reads only what was appended to the agents' logs since the last request instead of the whole file. Role chips now share one request per working directory instead of one per session.
- **A burst of terminal output no longer becomes one huge message.** Printing a large file or a log dump used to be sent to the window as a single message, which could approach the protocol's 8 MiB frame limit; output is now sent in pieces of at most 256 KiB.
- **The assistant's answer stays on the island until you close it.** It used to close by itself 8 seconds after the answer unless the pointer was over the island, often while you were still reading. Now it stays until you press Esc or the shortcut, click the ⌃ arrow, swipe the island up or click elsewhere.

## 0.15.0

Parley gets an assistant that lives on the island and a browser that lives next to every chat and room. Agents can open pages in that browser and read it, the sessions Parley starts run leaner, and the window, the assistant and the agents' brief now agree on what state a session is in.

### Added

- **Assistant on the island.** Press ⌥Space from any app, or click the dot on the island, and ask about your agents, works and rooms: who is working, who needs you, what a room is up to. Speak or type; the answer streams onto the island. Ask it to tell a room or an agent something and it prepares a card. Nothing is sent until you confirm; the message then shows as "You (via assistant)" in the room or in Chat. An agent that is asleep can take a message too: the card says it will be woken, and the session resumes with your text as its first turn.
  - Off by default. Settings → Assistant: turn it on, pick the provider and model (Claude, GLM or Codex, on your subscription; each question is a short run of that CLI, not an API call), the answer language (any Whisper language or the system one) and the shortcut (click the field, press the keys).
  - Voice goes through the same local Whisper as dictation in chats, so audio never leaves your Mac. The mic button puts the transcript into the field; the shortcut sends it as soon as you stop talking. The hint under the field shows your shortcut and Esc to close.
  - The swarm: a cloud of souls at rest, a sphere while it thinks, an arc while a tool runs, a stream while it answers, an amber ring while a card waits, coral on an error, grey while the host is away. The pill shows a small swarm while the assistant is busy. Reduced motion is honored.
  - It sees all your open works and rooms, keeps one conversation (forgotten after 15 minutes of silence or with **New conversation**) and never acts on its own: it reads and proposes, you decide.

- **A browser next to every Chat and room.** The **Browser** button opens a panel beside the view with its own pages (up to five), Console | Network, device sizes, Select and Annotate; what you pick or annotate goes to the chat or room the panel belongs to. Pages survive a window restart, and in a narrow window the panel covers the view with a **Back** button. A regular browser tab moves there with **⋯ → Move to browser of…**.
  - **Agents can open a page for you.** An agent puts a localhost page into the browser of its own chat or room. If the view is off screen, a toast says "S02 opened localhost:5173" with a **Show** button. It never changes your active tab or workspace, never takes the keyboard focus, and the same address is not opened twice.
  - **Agents can read it.** Claude, GLM and Codex list the pages of their own chat and rooms, read the console errors and failed requests of the current page, and take screenshots, also at another size such as 375×812 (the page shows "Agent capture 375×812" for a moment, then your size comes back). Your own browser tabs are never visible to agents. Secrets are masked as `<redacted>` by the shape of the value (`Bearer …`, JWT, `password=…`, `api_key=…`, and `sid`, `sig`, `jwt`, `pwd`, `xsrf`, `code` in a URL); a request in detail stays under 20 KB, similar console entries are folded, and `after` returns only what is new since the last read. Agents that run with Parley's own settings do not ask before opening or reading.
  - **Pause and the switch.** **⋯ → Pause agents** in a panel page stops all agents in that panel (**Resume agents** lifts it); Settings → Browser → "Let agents use the browser" turns access off for everyone. Sessions started before the update get the tools after a restart.

- **Lean agent sessions.** Agents that Parley starts for rooms and through `spawn_session` run without your plugins, other MCP servers and auto-memory: about a third less context on every turn of Claude Code (measured on one machine; Codex was not measured). Parley's own tools and hooks, your skills and the project's `CLAUDE.md` stay. It applies to sessions created after you update; turn it off in Settings → Agents ("Lean agent sessions") or with `PARLEY_LEAN_AGENTS=0`. A session from the New session dialog is lean only if you tick "Lean session".
- **Numbers for a "Parley feels slow" report.** The host status line and the diagnostics archive carry per-window counters since the previous status line: map re-reads and their time, bytes of map JSON parsed, terminal output received (chunks and bytes), and session recomputes of the wake and activity services.

### Changed

- **One table of session states.** The window, the assistant and the agents' brief take the session state from one shared module, so they use the same words ("working", "needs you", "asleep"…), and a session you just resumed is never reported as off.
- **Sessions started by another session hang off their parent in the sidebar.** A thin line runs from the parent's status dot to each child, and the indent grows per level. A child whose parent row is hidden under "N more closed" has no line.
- **Agents get clear rules for room correspondence.** A letter stays under 1200 characters, documents and file edits go into a file with only its path in the letter, earlier messages are not quoted (`replyTo` instead), `read_room` is for when the history is really needed, and the room map is read through the tools, not `map.json`.
- **The built-in minimal-development skill asks for more care around a change.** Before editing, an agent lists what the change must reach and what it could break; a deliberate shortcut is marked with a `shortcut: <the limit>, <when to replace it>` comment; new non-trivial logic gets a small test; the final report names what was skipped and any risk. Installed copies update on the next agent launch; a copy you edited is left alone.
- **Notification toggles start with a capital letter.** Settings → Notifications now reads "Needs you", "Finished", "Mail and mentions to you", "Sound", "Island with requests at the top of the screen".

### Fixed

- **Screenshots from an agent show the real page.** A screenshot at another size, or of a page wider than the panel, used to come back as a repeated tile; the window now sets the page to the requested size for the moment. A full-page screenshot takes the first three viewport heights and says so; images stay under 3.5 MB. A timed-out or repeated screenshot no longer leaves your page in the agent's size, and a second request waits for the first.
- **Pause really pauses.** An agent cannot open a page in a paused panel, and a cancelled window navigation no longer makes agents forget the pause. Agent screenshots in `drops/` are cleaned up hourly.
- **Oversized letters no longer slip through `send_message`.** The 4096-character limit was only declared in the tool schema, so letters of 54 KB went through; the server now enforces it, and a letter above 1200 characters comes back with a warning to shorten it. Letters are never truncated, and letters sent from the window are not affected.

## 0.14.0

Parley can now package what it knows about its own slowness into one file, so a report about a slow window comes with evidence. Quitting the app now stops the host and its sessions, after a question, and two Codex problems are fixed: sessions that froze until Parley was restarted, and compaction that looked stuck.

### Added

- **Diagnostics in the status bar.** One click saves a zip with host logs, a process list, request timings and an optional 20-second CPU profile of the host — attach it to an issue when Parley feels slow. The host journal now records where delays happen: session readiness, Chat sends, room mail delivery and the first reply.

### Changed

- **Quitting Parley stops the host and its sessions.** Closing the window still leaves the agents
  working. Quit (⌘Q, or Quit in the Dock menu) now asks "Quit Parley?" with the number of running
  sessions and stops the host together with them; with no live sessions it quits without a question.
  A host that does not answer within 10 seconds is stopped by its pid, and a system restart or
  shutdown stops it at once, without asking. The interrupted sessions do not restart on their own:
  the next launch lists them so you can bring them back. Updating gets simpler too: after ⌘Q the
  host is gone, so the new app does not need "Restart host…" unless you only closed the window.

### Fixed

- **Compacting a Codex agent finishes on time.** The context chip stayed on "…" after Codex had already
  compacted, and five minutes later a false "compaction didn't go through" followed. Parley now reads the end
  of the Codex log itself while compaction runs, and a long compaction of a big context is not counted as failed
  before 15 minutes. The context percentage of Codex agents stays current too.
- **Codex sessions no longer freeze until Parley is restarted.** On macOS the file system does not report
  appended lines of the logs Codex keeps open, so activity, token usage and subagents of a Codex session stopped
  updating. Parley now re-reads the logs of running Codex sessions itself instead of waiting for those events.

## 0.13.1

Chat gets Copy and Send again under messages, ↑ and ↓ through your past messages, and a send queue that keeps your messages in order in Chat and rooms. The host log now shows where time goes when starting a session or opening Chat is slow.

### Added

- **Copy and Send again under Chat messages.** Hover over your message to copy it or send it again right
  away; every piece of the model's answer has Copy too. In an empty Chat field, ↑ and ↓ go through the
  messages you sent in this session.
- **Messages wait their turn.** What you send to a busy Chat or room shows up in the feed right away,
  greyed out, and goes out strictly one at a time. Chat retries by itself while the agent is busy or
  waiting for a permission. A message that could not be sent is marked **Not sent**, with **Retry** and
  **×**; the ones after it wait, marked **Waiting**. The queue lives in the window: it survives switching
  tabs and views, but not closing the window.

### Changed

- **The host log shows where time goes.** Starting a new session and opening Chat can take several
  seconds on a busy machine. To find out why, Parley's host now writes to `~/.parley/host/host.log`
  how long each step of creating and starting a session took, every Chat feed snapshot (its size and
  how long it took to build), every request that took over a second, and, once a minute, how far the
  host fell behind when it was busy for 250 ms or more. Nothing else changes; the log holds no prompts,
  keys or command lines.

## 0.13.0

Rooms now show how many tokens they used and how full each agent's context is, and you can compact an agent's context right from the room. Chat no longer gets stuck on "Working…" after the agent has answered.

### Added

- **See how many tokens a room used.** The room header has a chip with the room's input and output
  tokens (`↑1.2M ↓84k`); click it for the breakdown by provider and by session, counted from the moment
  each member joined the room until they left. **Copy** puts the table on the clipboard as Markdown.
  Chat shows the same chip with its session's tokens over its whole life. These are tokens, not money
  or a share of your plan limit — the limits stay at the bottom of the window; a number a provider does
  not report shows as `?`, and an incomplete total starts with `≥`.
- **See how full each agent's context is, and compact it on your terms.** Every room participant card shows
  how much of the model's context window the agent has used (amber from 60 %, red from 85 %), and the room
  header shows the fullest one as **Ctx 82%**. Click a chip to compact that agent with focus instructions
  prefilled from the room's title — edit them if you like — or use **Compact all** for the whole room. An agent
  that is busy compacts as soon as its turn ends (⏳); Parley holds room messages for it until compaction is
  done. Chat shows the same chip for its session. Codex compacts without focus instructions.

### Changed

- **Clear on the island marks the finished sessions as seen.** The quiet **Clear** under the list
  used to hide the "Done" rows on the island only, so the green "unseen" dot stayed in the Parley
  sidebar. Now it also marks those sessions as seen, as if you had looked at them: the dot goes
  away and the "✅ N" tab disappears. A row that was already seen in Parley is only hidden.

### Fixed

- **Chat no longer gets stuck on "Working…" when the agent has already answered.** Sometimes Chat
  (and the agents panel in a room) stopped taking updates: the answer was already in the terminal,
  and it showed up in Chat only after switching to the terminal and back. Two leaks are fixed. The
  host no longer drops the window's feed subscription when its socket buffer is full — that happened
  right after large feed snapshots of long sessions (up to 4 MB) — and the window no longer discards
  an update that arrives just before the snapshot it is waiting for.
- **Clear stays in place under a long Done list on the island.** Clear was inside the scrolling
  list and scrolled away with it; it now stands under the list.

## 0.12.1

After a restart, accepting a room's decision no longer hangs for half a minute: Parley's host now comes up in a few seconds, and the window shows what it is waiting for — a spinner in the pressed button and on messages that are being delivered.

### Changed

- **Waiting is visible.** While the answer to a decision is on its way, the pressed button (Accept or Send to lead) shows a spinner; if Parley is still starting, the card says "Parley is still starting — your answer goes through once it is ready". Under a message, recipients that Parley is delivering it to by itself — waking the session or after typing the pointer — show "Delivering to S01 (resuming)…" with a spinner; the ones that need you keep "▤ Not picked up yet by …".

### Fixed

- **Accept answers right after a restart.** After Parley was reopened, the host put every session whose process had ended to sleep one by one, and its own writes kept starting overlapping passes of the same check; until they finished, Accept and Return for rework on a decision waited — up to half a minute on a busy machine. Sleeping sessions of a workspace are now recorded in one write and the passes run one at a time: on a copy of real workspaces (9 workspaces, 38 sessions) the start went from 15–18 s to about 3 s, and the "invalid transition sleeping → sleeping" errors in the host log are gone. Sessions also wake on an accepted decision sooner.

## 0.12.0

The Island at the top of the screen — in the notch on a MacBook — answers permission requests and shows which agents are working and what they just finished. Browser pages send their context to chat, your messages in rooms sit on the right, and "needs you" notifications say what is asked.

### Added

- **Page context in chat.** The bar above a browser page has "To: S02 ▾" — the session or room
  where page context goes. ⌖ Select (⌘⇧C) adds the clicked element with its role, React
  component and source, styles, HTML and a screenshot; ⇧-click keeps selecting. ✎ Annotate
  (⌘⌥A) puts numbered pins on elements and dashed frames on areas, each with your comment, and
  the tray adds up to 20 of them as one file with one screenshot. "Add to chat" on a console
  line or a request and "Add errors to chat" in the panel header add those too. Each is a
  Markdown file in `~/.parley/desktop/drops/context` with secrets replaced by `<redacted>`; it
  becomes a chip above the Chat or room field, or one line in a terminal session's input
  without Enter. A toast offers "Open" and "Undo". Nothing is sent by itself.
- **Island.** A black panel at the top of the screen (in the notch on a MacBook) shows how many agents
  are working and waiting ("N working · M waiting"); hover or click it for the list of active
  workspaces and rooms, and a click on a row opens it in Parley. A permission request, a simple
  question (one question, one choice, up to four options) or a plan opens a card by itself: Allow,
  Always (when the agent offers rules) and Deny, or the answer as a button; a plan and a complex
  question have "Open in Parley". With several requests the card shows "1 of N" and arrows, and its
  buttons stay disabled for half a second so an accidental click does not answer it. An agent that
  finished a turn you have not looked at yet stays on the island as a "Done" row with the start of
  its last reply ("✅ N done" in the pill, **Clear** hides the rows). The island never disappears: at
  rest it shrinks into a thin bar (or a small "✅ N" while there are unseen Done rows) and grows back
  on a new request, new work or a finished turn, or when you click the bar; tuck it away yourself
  with the ⌃ arrow or by swiping up. Drag it by any part along the top edge; it snaps to the left,
  the center or the right and is remembered per monitor. Only the island catches the mouse, clicks
  beside it reach the windows below. Claude and GLM sessions only: Codex requests stay system
  notifications. On by default; Settings → Notifications → "island with requests at the top of the
  screen". While the island is on, a request with a card there is not repeated as a macOS
  notification.

### Changed

- **Design Mode is now Select.** The result card and "Send to agent ▾" are gone: the element
  becomes an attachment of the "To" target, and its chip shows the screenshot before you send.
- **Your messages in rooms are on the right.** Like prompts in Chat, they sit on the right on a
  tinted bubble; agents' messages and system letters stay on the left.
- **"Needs you" notifications say what is asked.** The notification names the request (a command,
  a file edit, a fetch, a question or a plan), the project and how many other sessions are waiting,
  and a click opens the session in Chat at that card.

### Fixed

- **Notification clicks and update notices keep working after a browser tab loads.** Once a browser tab had loaded
  a page, clicking a macOS notification raised the window but didn't open the session, and a new-version notice
  never reached it, until the window was reloaded.
- **Resume works when the agent process is still alive.** After a host restart brought a whole
  workspace up at once, a session could keep running while Parley showed it asleep, and Resume did
  nothing. Parley now retries recording the start and, if it still can't, stops the process so
  Resume brings the session up again.
- **"Allow always" for Codex no longer loses the answer.** With no rules to add, Codex dropped the
  decision; it now counts as a plain Allow.

## 0.11.0

Screenshots an agent takes — with Chrome DevTools MCP, Claude in Chrome or Playwright, or an image it reads — now show in Chat as thumbnails under the call, and a click opens them larger. A live agent that has reported "done" no longer looks finished.

### Added

- **Screenshots in Chat.** When an agent's tool returns an image — a browser screenshot from Chrome DevTools MCP,
  Claude in Chrome or Playwright, an image it read — Chat shows it as a thumbnail under the call; click to view it
  larger. Parley keeps these images in `~/.parley/feed-images` for 7 days, 1 GiB at most (the oldest go first).

### Fixed

- **A live agent that reported "done" shows as working.** Agents report done at the end of every turn and stay
  alive; the sidebar, the room and the workspace card showed such a session as done, and its row menu offered
  Resume instead of Stop. A live session now shows its activity; the reported result shows for a sleeping or
  closed session and in the row's tooltip.
- **Thumbnails keep their proportions on macOS.** Image thumbnails of attachments were stretched into a square;
  they now keep the picture's aspect ratio.

## 0.10.1

A screenshot pasted into a room's message field now becomes an attachment, and a long message no longer hides where you type: the message field of a room and of the Chat view follows the caret when typed or pasted text grows past its height.

### Fixed

- **Screenshots paste into a room.** ⌘V or Edit → Paste with an image (and no text) on the clipboard adds it as an attachment, like the paperclip. Before, the room's field took only plain text and the paste did nothing.
- **A clipboard image that can't be read says so.** When the window sees an image on the clipboard but can't save it, the Chat view and the room show "Couldn't read the image from the clipboard" instead of doing nothing.
- **The message field keeps the caret in view.** In a room, after pasting a long text, Shift+Enter, dropping text or picking an @-mention, the field scrolls to where you type, bottom padding included; before, a pasted text left the caret far below the visible part. In the Chat view the last line no longer sits flush against the field's border. Editing in the middle of a scrolled-up field doesn't make it jump.

## 0.10.0

A room whose work is done can be archived: its feed stays readable, nobody writes to it until you reopen it. A project no longer disappears from the sidebar when all its workspaces are archived — they sit under "N archived" at the bottom of its group, and "Remove from list…" hides the project. Sessions created without a name get a real one — S01 Ralph, S02 Anatoly, S03 Ruslan… — and any session can be renamed.

### Added

- **Archived rooms.** "Archive…" in a room row's menu: the feed stays readable, nobody can write to the room
  until "Reopen", a waiting decision is dismissed and a live plan cancelled. "Also stop its N agents that are in
  no other room" is on by default; agents left running get a letter. Archived rooms sit under "N archived rooms"
  at the bottom of the card.
- **Archived workspaces under a link.** A project whose workspaces are all archived stays in the sidebar with "+"
  and "N archived" at the bottom of its group; "Remove from list…" hides it until a workspace is created there.
- **Session names and Rename.** A session created without a name gets one by its number — S01 Ralph, S02
  Anatoly, S03 Ruslan… — and keeps it; Claude Code's title no longer replaces it (an untitled workspace still
  gets its title). "Rename" in a session row's menu.

### Changed

- Sessions that already carry "New session" in older workspaces show the name by their number in the window;
  Claude Code's title still renames them once, as before.

## 0.9.0

The browser tab gets a console and network panel and viewport sizes: the page's messages, exceptions and requests with their bodies are visible right in the tab, errors and failed requests are counted on the button, and the page can be emulated at phone, tablet and laptop sizes. On macOS the first hook of a new session is no longer lost.

### Added

- **Console and network in the browser tab.** The console button in the tab's bar (⌘⌥I; ⌘⌥J opens it on
  Console) shows a panel at the bottom of the tab. Console lists the page's messages and exceptions with the
  levels Errors, Warnings, Info and Debug, a text filter, repeats as "×N", the stack of an error, the extra
  lines of a multi-line message of any level, objects as a short preview and "Copy". Network lists the
  requests with type filters, "Failed only" and a URL filter; a request opens Headers, Payload and Response —
  the body up to 1 MB — and the list narrows to Status and Name beside it. A red counter on the button shows
  the errors of the current page (console errors, exceptions and failed requests), a yellow one — the
  warnings; each reads "999+" past 999.
- **Viewport sizes for the browser tab.** Fit, Mobile S/M/L, Tablet, Laptop, Desktop, "Custom…", "Rotate" and
  1x/2x/3x: the page is emulated at that size (mobile sizes with touch and a mobile user agent) and centered
  with a "375 × 812 · 2x" label; the size stays with the tab after a restart.

### Changed

- The "DevTools" button of a browser tab moved to "⋯" → "Open full DevTools"; the same menu has "Clear console
  and network".

### Fixed

- **The first hook of a new session is no longer lost on macOS.** A hook written at the moment the host set up
  a new file watcher could be missed, so the session's state lagged behind and sending text or changing effort
  answered "blocked" until the agent wrote its next hook. The host now reads the session logs once more a second
  after it sets up new watchers.

## 0.8.1

Room agents learn their role from the human's task itself: a task written to a room for everyone now reaches each agent marked as such, with its role, the lead and a hint, so agents no longer start working in parallel before the lead has collected positions. The `PARLEY.md` template now says what not to write there.

### Changed

- **The `PARLEY.md` template says what not to write there.** Its opening comment now explains that Parley's own rules (rooms, messages, reports) reach agents without the file, so it holds only the team's rules for the project. Only new templates change: an existing `PARLEY.md` is left as it is.

### Fixed

- **Room agents learn their role from the human's task itself.** A task written to a room for everyone now reaches each agent marked as a task for everyone, with its role (lead or member), the lead and a short hint: speak up in one message and wait for the lead, or collect positions and propose a decision. Before, rooms created from the window started their agents before the room existed, so the agents saw a bare task and started working in parallel without agreeing. The terminal pointer says "(a task for everyone)", and a restarted agent already gets its role from its brief, which is rebuilt from the map at launch.

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
