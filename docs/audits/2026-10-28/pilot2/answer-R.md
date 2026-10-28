# Pilot 2 answer R: silent failures across Parley (research swarm)

Start: Wed Oct 28 17:29:58 UTC 2026
End: Wed Oct 28 17:40 UTC 2026 (`date -u` at 17:39:43 before writing this file)

Subject: Parley at `da446e81` (`/Users/kalmbik61/parley/pilot2-subject`), `packages/*/src` without tests.

Method: an Opus queen cut the code into 8 slices, one Claude Haiku drone per slice (host A, host B, core/work, core rest, core/mcp + protocol, desktop main + preload, renderer A, renderer B). Each drone grepped its slice for catch / `.catch(` / `'error'` handlers / `void f()` / timers / loops / retry words, opened the hits and judged them. Then one Codex gpt-6-luna verifier rechecked 41 key claims at the same SHA: 36 PASS, 4 FAIL, 1 NOT VERIFIED. All 8 drones handed in **partial** coverage (see "Not covered").

Marks in the last column:
- `[V<n>]`: the verifier confirmed it (claim V<n>), with the line it gave.
- `[nv]`: a drone claim the verifier did not recheck. The drone opened the line, but treat it as lower confidence.
- `[Q]`: the queen read the code to settle a disputed claim (only V7, V26, V29 and one grep for `uncaughtException`).

Format: `ID | kind | path:line | what fails | who does not learn it and what they see instead | harm | deliberate? | mark`

## Q1. Host (`packages/host/src`)

```
Q1-1  | a   | packages/host/src/stuck/stuck-service.ts:123 | enqueue(): the task that builds/writes a stuck or limit episode letter throws | the stuck agent and the human: log.error only, the letter never arrives, the session just sits | high | no | [V1]
Q1-2  | a   | packages/host/src/sessions/sessions-service.ts:496 | on PTY exit, finishExited (writing 'sleeping' to the map) fails | the human: log.error only; the window keeps showing an active session with no process, so mail to it does not wake it | high | no | [V2]
Q1-3  | a   | packages/host/src/sessions/sessions-service.ts:461 | settleLaunch: updateMap that settles the launch budget reservation fails | agents and the human: log.error only; the reservation stays unsettled, later launches can be refused for budget with no visible cause | med | no | [V3]
Q1-4  | a   | packages/host/src/sessions/sessions-service.ts:1375 | resumeInterrupted: launch(ref,'resume') rejects | the human who pressed resume: log.error only, the ref is dropped from interruptedRefs, no notice | med | no | [V4]
Q1-5  | a/e | packages/host/src/sessions/sessions-service.ts:1278 | session delete: readMap(...).catch(()=>null), so the worktree cleanliness check is skipped and deleteSession goes on | the human: the delete succeeds without the dirty-worktree check (the effect on uncommitted work was not traced) | med | no | [V5]
Q1-6  | a   | packages/host/src/consents/consents-service.ts:230 | run(): the held continuation or refusal launch throws after the human pressed Allow/Deny | the human sees "Trusted ✓"/"Done ✓" (decide() returned applied:true, card removed); the held session never starts; log.warn only | high | no | [V12]
Q1-7  | a/e | packages/host/src/providers/auth-service.ts:383 | logout(): `claude auth logout` fails, catch logs only; caller packages/host/src/methods/custom-providers.ts:154 deletes the account anyway | the human sees the account removed while the keychain login may stay | med | yes (caller comment: logout failure does not block deletion) | [V13]
Q1-8  | a   | packages/host/src/compaction/compaction-service.ts:198 | the compaction job rejects; .catch logs, finally publishes pending=null | the human/agent: the "compacting" state just clears, with no failure text | med | no | [V14]
Q1-9  | a   | packages/host/src/telegram/outbox.ts:71 | Telegram job: non-retryable error or 3 network failures, then the job is dropped with a log line | the Telegram human never gets the card/notice (for example needs-you) and is not told it was dropped | med | no | [V15]
Q1-10 | b   | packages/host/src/telegram/outbox.ts:59 | 429 answers are retried after retry_after with no attempt cap | Telegram delivery can be delayed without end; nobody is told | low | no | [V15]
Q1-11 | c   | packages/host/src/hooks/hook-server.ts:300 | the hook server emits 'error' after listen; log.warn only | the window is not told: the hook feed (approvals, live feed) is dead for the rest of the host's life | med | yes (comment: the host must not fail because of the receiver) | [V9]
Q1-12 | c   | packages/host/src/host.ts:811 | hookServer.listen fails at start; log.error, no host.notice | the human: sessions start without hook URLs, only the terminal works, no explanation | med | yes (comment: the window shows the terminal) | [V10]
Q1-13 | a   | packages/host/src/limits/limits-service.ts:224 | the CLI limits read fails; log.warn only, nothing new is published | the human sees stale usage numbers as if they were current | med | no | [V11]
Q1-14 | b   | packages/host/src/assistant/reminders.ts:204 | while the assistant is busy or not ready, the reminder re-arms setTimeout(tick, RETRY_MS) with no cap | the human is never told a reminder is postponed without end | low-med | yes (comment logs the postponement) | [V16]
Q1-15 | c   | packages/host/src/activity/log-index.ts:325 (and :343) | both watchSessions calls pass onError: () => {}, so fs.watch errors from core/watch.ts:137 are dropped | the human: the activity feed silently stops updating (EMFILE, removed folder) | med-high | yes (comment: retry on next event; the error itself is never surfaced) | [V20]
Q1-16 | c   | packages/host/src/host.ts:470 | the Codex hook launcher is not written; log.warn, the launch goes on | the human: Codex approvals quietly fall back to the terminal | med | yes (comment at 461-462) | [nv]
Q1-17 | c   | packages/host/src/host.ts:852 | telegram.start fails; log.error only | the human: the Telegram channel is silently off | med | yes (comment: a channel failure must not stop the host) | [nv]
Q1-18 | a   | packages/host/src/host.ts:830 | collectInterrupted fails; log.error, start goes on | the human: the "interrupted sessions" banner is empty | med | no | [nv]
Q1-19 | a   | packages/host/src/sessions/sessions-service.ts:1317 | stopRetired: stop() of a closed/archived session fails; log.error only | the human: the PTY of a closed session may keep running | med | no | [nv]
Q1-20 | a   | packages/host/src/methods/works.ts:64 | history.removeWork(...).catch(()=>undefined); the delete answers success | the human: the history stays after "delete" | low-med | no | [nv]
Q1-21 | a   | packages/host/src/wake/wake-service.ts:1075 | deliverRecipeToNewLeads fails; log.error | a new room lead never gets its playbook; no notice | low-med | no | [nv]
Q1-22 | a   | packages/host/src/telegram/service.ts:1091 | a detached voice chain fails with a non-HostError; log only (a HostError does get a notice) | the Telegram user gets no reply to the voice message | low-med | no | [nv]
Q1-23 | a   | packages/host/src/consents/consents-service.ts:162 | save(): the consent file cannot be written; warn only | the human: the decision holds in memory and is asked again after a restart | low-med | no | [nv]
Q1-24 | e   | packages/host/src/providers/auth-service.ts:239 | check(): a timeout or spawn failure is shown as signedIn:false, detail null | the human sees "not signed in" with a Sign-in button instead of "check failed" | low-med | yes (comment at 240-242) | [nv]
Q1-25 | b   | packages/host/src/limits/limits-service.ts:93 | a fixed setInterval poll with no backoff; a persistent read failure warns on every tick | log spam only; the window stays stale (see Q1-13) | low | no | [nv]
```

## Q2. Core (`packages/core/src` except `mcp/`)

```
Q2-1  | a   | packages/core/src/secrets.ts:47 | corrupt secrets.json: readStore returns {}; writeSecret then rewrites the file with only its own key | the human saves one key (for example Telegram) and sees "saved"; the other keys (Z.ai, custom:*) are lost with no signal | high | partly (the read comment calls corrupt JSON "no key"; the loss on write is not described) | [V19]
Q2-2  | a   | packages/core/src/config.ts:475 | on write, JSON.parse of the existing config fails, so kept = {} and the file is rewritten with only the patch | the human changes one setting in the UI; all hand edits in a broken config.json are erased with no warning (the load path does complain) | med | yes (comment: write from scratch) | [V21]
Q2-3  | a   | packages/core/src/work/launch.ts:839 | stampNativeContext(...).catch(() => {}) after launch | the human: the launch reports started; later the native context stops matching and the context availability closes with no notice | med | yes (comment at 838) | [V17]
Q2-4  | a   | packages/core/src/work/lease.ts:44 | any readFile error (EACCES, I/O, not only ENOENT) and corrupt JSON (:49-51) return null, the same as "no lease" | callers cannot tell "unreadable" from "free" (the callers were not read) | med | yes (doc comment: unreadable means unknown tenant) | [V18]
Q2-5  | a   | packages/core/src/migrate.ts:384 | rewriteBriefs(to).catch(() => undefined) after a project folder move | the human: the move reports success; work briefs keep pointing at the old paths | med | no | [V22]
Q2-6  | a   | packages/core/src/migrate.ts:435 | rewriteArtifactPaths(...).catch(() => undefined) | the human: artifact paths stay stale, no diagnostic | med | no | [V22]
Q2-7  | a   | packages/core/src/custom-providers.ts:196 | any read/parse error of the custom providers file returns [] | the human: all custom providers vanish from the list with no message | med | yes (comment groups "absent" and "invalid JSON") | [V23]
Q2-8  | a   | packages/core/src/watch.ts:137 | fs.watch errors and failed watcher creation go only to an optional onError; the default is silent | through Q1-15: a session feed stops updating | med | yes (comment at 31) | [V20 via its caller]
Q2-9  | c   | packages/core/src/roles/context.ts:158 | any app-server failure (spawn error, exit, 8 s timeout, size limit, bad JSON at :143) aborts, and readCodexNativeContext returns null | the caller sees "no context", not the reason | med | no | [nv]
Q2-10 | a   | packages/core/src/feed/images.ts:105 | an image save fails and returns null | the human: the image just disappears from the feed | low-med | no | [nv]
Q2-11 | a   | packages/core/src/assistant/stream.ts:46 | broken JSON in the tool-arguments string becomes {} | the assistant's tool call runs with empty arguments as if that were intended | low-med | no | [nv]
Q2-12 | a   | packages/core/src/host-lock.ts:63 | socketIsAlive: any connect error (EACCES too) means false | a live host can be judged dead (the consequence was not traced) | low-med | no | [nv]
Q2-13 | a   | packages/core/src/work/events.ts:215 | parseEvent: a broken journal line returns null and is dropped | the human: that event is missing from the window with no trace | low | yes (comment at 213) | [nv]
```

## Q3. Agent MCP server (`packages/core/src/mcp`) and protocol (`packages/protocol/src`)

```
Q3-1 | a/b | packages/core/src/mcp/inbox-watch.ts:117 | probe failures (readMap / unreadLetters / identity) are caught without a log; the watcher sleeps pollMs and retries forever | the channel-bound agent is never woken for new letters while the map read fails; it sees nothing until it calls check_inbox itself; the human sees an idle agent | med-high | yes (comment: wait for the next change) | [V24]
Q3-2 | c   | packages/host/src/server.ts:76 (decoder at packages/protocol/src/framing.ts:65) | LineDecoder.push calls JSON.parse per line with no per-line guard; server.ts rethrows everything except LineTooLongError from the socket 'data' handler, and no uncaughtException handler exists in host/core | one malformed line from any local client (MCP server, window) becomes an uncaught exception in the host; everyone else sees only "disconnected" | med | no | [V26][Q]
Q3-3 | b   | packages/core/src/mcp/inbox-watch.ts:130 | notify() fails: the letter is un-rung and the loop rings again every pollMs with no cap or backoff | silent spin; the agent gets no channel call | low | yes (comment) | [nv]
Q3-4 | a   | packages/core/src/mcp/context.ts:107 | agentFromEnv returns undefined for a malformed host URL or token | the agent's session quietly works on direct map reads instead of the host path; no message to the agent or the window | low-med | yes (comment: do not trust foreign config) | [nv]
Q3-5 | a   | packages/core/src/mcp/tools.ts:812 | the appendFile of a wait_for journal event is swallowed | the event journal silently lacks entries; the agent sees a normal wait_for | low | yes (comment) | [nv]
Q3-6 | a   | packages/core/src/mcp/provider-rows.ts:66 | fetchProviderRows returns null on any error; tools.ts:614-616 falls back to the local registry | the agent gets a provider list whose "available" may differ from the host's view, with a note but no error | low | yes (fallback) | [nv]
```

Refuted in Q3: `packages/core/src/mcp/plan-tools.ts:377`. On a flushPlanEffects failure finish() returns the summary with `unavailable:true`, which tells the agent that delivery is unavailable. That is not a false success (V25 FAIL).

## Q4. Desktop main and preload

```
Q4-1  | c   | packages/desktop/src/main/index.ts:246 | host spawn throws (entry or engine resolution, spawnHost); catch does console.error and returns null | the human: after up to 30 s of polling the window shows a generic socket/token "disconnected"; the real cause is only in main's console | med | no | [V27]
Q4-2  | c   | packages/desktop/src/main/host-connection.ts:215 | startHostProcess() rejects; console.error only | same as Q4-1: the window never gets the spawn error | med | no | [V28]
Q4-3  | e   | packages/desktop/src/main/ipc.ts:575 | app:save-layout: LayoutTooLargeError returns success without saving | the human sees "saved"; the new layout is lost and the old one comes back after a restart | med | yes (comment: quiet console warning by plan) | [V30]
Q4-4  | a   | packages/desktop/src/main/quit-guard.ts:55 | stopHost() fails during quit; log only, app.quit() goes on | the human confirmed quit thinking sessions stopped; the host may keep running | med | no | [V32]
Q4-5  | b   | packages/desktop/src/main/host-connection.ts:536 | call() registers a pending request with no per-call timer | a wedged but connected host leaves every window RPC pending until the socket closes: buttons hang with no error | med | no | [V33]
Q4-6  | d   | packages/desktop/src/main/window.ts:169 | `void ask().then(...)` with no catch | a rejected askUnresponsive is an unhandled rejection; the hung-window prompt may not come again for that window | low-med | no | [V31]
Q4-7  | c   | packages/desktop/src/main/ipc.ts:828 | PARLEY.md receiptError: console.warn only, the result goes back as {exists, created} | the human/agent sees a normal success | low-med | no | [nv]
Q4-8  | c   | packages/desktop/src/main/host-connection.ts:595 | no host socket: a notification is dropped with console.warn; the IPC handler (ipc.ts:522) answers success | the renderer believes it was delivered | low-med | partly (comment at 592-593) | [nv]
Q4-9  | a   | packages/desktop/src/main/index.ts:683 (also :615, :618, :888) | island / assistant-mirror sync .catch → console.warn | the island shows stale settings | low-med | partly (comment at 682) | [nv]
Q4-10 | a   | packages/desktop/src/main/update-check.ts:253 | any update-check failure is swallowed ("Молчим") | the human never learns the update check failed | low | yes | [nv]
Q4-11 | e   | packages/desktop/src/main/ipc.ts:369 | findInGuest times out (2 s) and resolves with the last partial result, possibly 0 matches | the human sees "0 matches" as a normal answer | low | no | [nv]
Q4-12 | a   | packages/desktop/src/preload/index.ts:226 | .catch(() => {}) on app:take-focus-target | the click's focus target is silently lost | low | no | [nv]
```

Refuted in Q4: `packages/desktop/src/main/host-connection.ts:738`, a browser.agentResult call failure logged with console.warn (V29 FAIL). The queen read it: the comment at :722 documents that the host itself answers the agent with `window_not_connected` or `timeout`. So the agent does learn of the failure, without its exact cause.

## Q5. Desktop renderer

```
Q5-1  | a   | packages/desktop/src/renderer/island/IslandApp.tsx:473 | bridge.call('consents.list').catch(() => {}) on (re)connect | the human sees no consent card for consents the host holds; the agent waits for a decision that appears nowhere (until a later event refreshes the list) | high | no | [V39]
Q5-2  | d   | packages/desktop/src/renderer/App.tsx:250 | handleRestart: `void bridge.app.restartHost();` with no catch | the human presses "restart" on the version-mismatch screen; nothing happens, no text | med | no | [V34]
Q5-3  | a   | packages/desktop/src/renderer/store/providers.ts:103 | providers.list fails: providers = [], loaded = true, console only; the reload callers at :178/:180/:212 also swallow it | the human sees an empty provider list as if nothing were configured | med | no | [V35]
Q5-4  | a   | packages/desktop/src/renderer/layout/persistence.ts:436 | saveLayout(...).catch(() => {}) | the human's tab/layout changes are not persisted, nothing tells them | med | no (per verifier) | [V36]
Q5-5  | a   | packages/desktop/src/renderer/layout/persistence.ts:174 | restoreLayout(...).catch(() => emptyLayout()) | a read failure silently opens an empty layout in place of the saved one | med | no | [V36]
Q5-6  | b   | packages/desktop/src/renderer/chat/chat-outbox.ts:112 | 'busy': the same message is retried every CHAT_RETRY_MS with no cap | the human sees only a "queued" chip for as long as the session stays busy | med | yes (module comment) | [V37]
Q5-7  | b   | packages/desktop/src/renderer/chat/chat-outbox.ts:60 | 'blocked': untilNotBlocked waits on the activity store with no timeout | a message to a session that stays blocked never resolves and never errors | med | yes (module comment) | [V37]
Q5-8  | b   | packages/desktop/src/renderer/store/works.ts:171 | the rooms.mail repair retries with capped backoff but no attempt cap; failures go to console.warn | a held-mail gap persists silently | med | no | [V38]
Q5-9  | a   | packages/desktop/src/renderer/voice/downloads-store.ts:58 | listModels() fails, so downloaded = [] | the human sees every voice model as not downloaded | med | no | [V40]
Q5-10 | a   | packages/desktop/src/renderer/voice/downloads-store.ts:84 | removeModel(...).catch(() => undefined), then refresh; with :58 failing the voice model becomes null and voice is disabled | the voice setting is silently reset | med | no | [V40]
Q5-11 | a   | packages/desktop/src/renderer/update/update-notice.ts:50 | dismiss(version) runs before openExternal; an open failure (:53) is console.warn only | the human clicks Download, nothing opens, and the update offer never comes back | med | no | [V41]
Q5-12 | a   | packages/desktop/src/renderer/App.tsx:289 (and :296) | Retry / restart on the "disconnected before first connect" screen: .catch → console.warn | the human clicks Retry; the screen stays as it was | med | yes (comment at 34-36) | [nv]
Q5-13 | a   | packages/desktop/src/renderer/store/ui.ts:416 | loadUi fails: uiLoaded set, DEFAULT_UI kept | saved UI preferences silently show as defaults | med | yes (comment at 415) | [nv]
Q5-14 | a/c | packages/desktop/src/renderer/browser/panel/agent-registry.ts:39 (and :50) | registerTab rejects: console.warn + undo() | main never learns the page; no toast | med | yes (comment) | [nv]
Q5-15 | b   | packages/desktop/src/renderer/store/room-pages.ts:144 | the open-room retry backs off up to 30 s with no attempt cap; console.warn only | a room page never opens after a host fault and keeps retrying while the panel is open | low | no | [nv]
Q5-16 | d   | packages/desktop/src/renderer/voice/downloads-store.ts:80 | cancelDownload awaited with no catch, called as `void cancel(...)` from VoiceSettings.tsx:69 | an unhandled rejection; no toast | low | no | [nv]
Q5-17 | e   | packages/desktop/src/renderer/voice/downloads-store.ts:67 | any downloadModel rejection is mapped to {error:'network'} | the human sees "network" for any host error | low | no | [nv]
Q5-18 | a   | packages/desktop/src/renderer/attention/notify.ts:402 (and :713) | pendingAsk().catch(() => null) | a notification goes out without the question text | low | partly | [nv]
Q5-19 | a   | packages/desktop/src/renderer/terminal/LinkMenu.tsx:77 | openExternal(url) .catch → console.warn | a link click does nothing visible | low | no | [nv]
```

## Q6. Retries, polls and wait loops (kind b)

No cap or no backoff (by ID above):
- Q1-10 `packages/host/src/telegram/outbox.ts:59`: 429 retry, no attempt cap [V15]
- Q1-14 `packages/host/src/assistant/reminders.ts:204`: busy reminder re-arm, no cap [V16]
- Q1-25 `packages/host/src/limits/limits-service.ts:93` (also `:250`): fixed-interval poll, no backoff, errors dropped [nv]
- Q3-1 `packages/core/src/mcp/inbox-watch.ts:117`: probe failure retried every pollMs forever, no log [V24]
- Q3-3 `packages/core/src/mcp/inbox-watch.ts:130`: notify failure re-rung every pollMs [nv]
- Q4-5 `packages/desktop/src/main/host-connection.ts:536`: RPC wait with no per-call timeout [V33]
- Q5-6, Q5-7 `packages/desktop/src/renderer/chat/chat-outbox.ts:112`, `:60`: busy retry with no cap; blocked wait with no timeout [V37]
- Q5-8 `packages/desktop/src/renderer/store/works.ts:171`: backoff but no attempt cap [V38]
- Q5-15 `packages/desktop/src/renderer/store/room-pages.ts:144`: backoff ≤30 s, no attempt cap [nv]
- `packages/desktop/src/renderer/island/progress.ts:36`: a perpetual poll (min 500 ms, no backoff) that keeps polling after it publishes "unavailable"; low [nv]
- `packages/desktop/src/renderer/island/IslandApp.tsx:702`: a 1 s setInterval revalidate while a request card is shown; low [nv]
- `packages/host/src/activity/codex-log-poll.ts:93`: an uncapped setInterval; errors swallowed at :81, reindex only on a signature change; low [nv]
- `packages/desktop/src/main/update-check.ts:261`: a daily setInterval whose failure is hidden (Q4-10); low [nv]

Capped or with backoff (checked by drones, [nv]): `host/src/wake/wake-service.ts:379-395` (retry caps); `host/src/sessions/sessions-service.ts` start loop (START_WRITE_ATTEMPTS); `host/src/host.ts` pid-lock loop (2 attempts); `host/src/pty/effort-switch.ts:120-146`, `pty/mode-switch.ts:116-121` (max ms); `host/src/telegram/poller.ts:91` (backoff ≤30 s, status surfaced); `host/src/telegram/outbox.ts` network retries (3); `host/src/telegram/service.ts:768` (3 re-checks); `host/src/compaction/compaction-service.ts:136` (ended by timeout); `host/src/rooms/autonomous-engine.ts:1098-1107` (backoff ≤30 s); `host/src/context/context-service.ts:73-77`, `health/health-service.ts:93-100`; `core/src/work/store.ts:276-292` (lock with deadline, fixed delay); `core/src/secrets.ts:91-103` (10 s deadline, then throws); `core/src/roles/context.ts:116` (8 s); `core/src/mcp/remote-tools.ts:204-250` (retry budget, growing pauses, then HOST_NOT_RESPONDING); `core/src/mcp/tools.ts:947-980` and `mcp/watch-map.ts:52-111` (deadlines); `desktop/src/main/host-connection.ts:529-534` (reconnect: backoff 0.5→5 s, unbounded attempts, but the status and reason reach the window); `host-connection.ts:309-343` (connect within 5/30 s); `renderer/island/requests.ts:32` ([500,1500,4000]); `renderer/attention/focus-target.ts:123-135`; `renderer/terminal/webgl-policy.ts:100`.

## Q7. The ten most harmful (by ID)

1. **Q2-1** (`secrets.ts:47`): one corrupt secrets.json, and the next saved key silently erases every other stored key while the UI says "saved". This loses data.
2. **Q1-6** (`consents-service.ts:230`): the human presses Allow, the card says "Trusted ✓", but the held launch threw. The session never starts and nobody is told.
3. **Q5-1** (`IslandApp.tsx:473`): consents.list fails on reconnect, so pending consent cards are absent. The agent waits for a decision the human cannot see.
4. **Q1-1** (`stuck-service.ts:123`): the stuck/limit letter fails to build or write and is dropped. The agent never learns it is stuck or limited, and the human sees a silent session.
5. **Q1-2** (`sessions-service.ts:496`): the process has died but the map still says active. The window shows a live agent, and mail to it does not wake it.
6. **Q3-1** (`inbox-watch.ts:117`): while map reads fail, a channel agent is never woken for letters. The loop retries forever and logs nothing.
7. **Q1-15 / Q2-8** (`log-index.ts:325`, `watch.ts:137`): fs.watch dies (EMFILE or a removed folder) and the activity feed freezes. The window keeps showing stale data with no error.
8. **Q2-2** (`config.ts:475`): with a syntax error in config.json, one setting change from the UI rewrites the file with only that patch, so the hand edits are lost.
9. **Q1-3** (`sessions-service.ts:461`): an unsettled launch reservation leaks budget. Later launches are refused with no visible cause.
10. **Q4-1 / Q4-2** (`index.ts:246`, `host-connection.ts:215`): the host fails to spawn and the window shows only a generic "disconnected" after up to 30 s. The real cause is only in main's console.

All ten are verified (V19, V12, V39, V1, V2, V24, V20, V21, V3, V27/V28).

## Refuted claims (verifier FAIL)

- `packages/host/src/methods/assistant.ts:8` (`void service.ask`). This is not lost: `packages/host/src/assistant/assistant-service.ts:512` runAsk catches and publishes phase:error with the message (V6).
- `packages/host/src/methods/index.ts:305` (planEffects.flush `.catch(()=>undefined)`). The comment at :304 says a delivery failure keeps the pending effects and their notice. The queen read the comment; the notice path in plan-effects was not traced (V7: FAIL by the comment, effectively NOT VERIFIED).
- `packages/core/src/mcp/plan-tools.ts:377`. It answers `unavailable:true`, an explicit signal (V25).
- `packages/desktop/src/main/host-connection.ts:738`. The host answers the agent `window_not_connected`/`timeout`, as documented at :722 (V29, read by the queen).

## Hypotheses (no confirmed line, or effect not traced)

- `packages/host/src/hooks/pending.ts:90`: a held hook that times out answers `{}` (EMPTY_HOOK_RESPONSE). Whether the CLI treats that as allow or as a fallback is not established in this repo (V8 NOT VERIFIED).
- Q1-5: deleting a session past a failed readMap may remove or orphan a dirty worktree. The deleteSession effect on the worktree was not traced.
- Q2-4: a lease that reads as null could let two hosts act on one work. The lease callers were not read.
- `packages/core/src/custom-providers.ts:196`: the empty list from a broken file may later be written back, losing the records. The writers were not read.
- `packages/host/src/consents/consents-service.ts:197`: `isLive(...).catch(() => false)` may release or resume a hold on a failed liveness check.
- Host feed/activity fire-and-forget calls (`feed/feed-service.ts` ~929, 1320, 1337-1338, 1442-1444; `activity/activity-service.ts` ~772, 921, 1252, 1295, 1437, 1479; `works/works-service.ts:901`; `providers/codex-catalog.ts:222`): `void x()` with no `.catch` seen; whether the callees catch internally is not checked.
- `packages/desktop/src/renderer/browser/BrowserSurface.tsx:525`, `:574`: agentFocusReady / agentCaptureReady `.catch` → console.warn; the agent may see a timeout instead of the cause.
- `packages/desktop/src/main/ipc.ts:492`, `:495`: shortcut defaults answer ok:true with accelerator null (a possible kind e).

## Not covered

All eight drones reported partial coverage: grep-driven, hits opened, many files not read. Named gaps:
- **core/work (largest gap)**: delivery.ts, db.ts, letters.ts, letter-store.ts (except the savepoint), channel.ts, autonomous.ts (except one loop), and most of the other ~70 files were only grepped. The callers of `watchEvents` onError were not checked.
- **host**: feed/feed-service.ts, feed/image-store.ts, feed/stash.ts, activity/activity-service.ts, activity/log-index.ts (except the watch calls), rooms/* (except one autonomous-engine excerpt), providers/versions.ts, providers/codex-catalog.ts, telegram/assistant-bridge.ts, agent/browser-endpoint.ts, capabilities/snapshot.ts, diagnostics/profiler.ts, methods/{context-pages,custom-providers,telegram,memory,history}.ts, pty/draft.ts, pty/codex-terminal.ts, limits/glm-check.ts, sessions/agent-skills.ts, sessions/ready-journal.ts, idle.ts, timing.ts.
- **core rest**: codex/*, capabilities/*, skills/search.ts, skills/context.ts, roles/claude.ts, feed/* except images/turn, most of providers.ts, agent-plan*.ts, all-sessions.ts, adapter-v1.ts, telegram.ts, session-tree.ts, most of session-indexer.ts and migrate.ts.
- **mcp/protocol**: protocol events.ts, methods.ts and types.ts were only grepped; the host-side handlers of MCP calls were not read.
- **desktop main**: main/files/*, main/browser/* (many console.warn catches), main/island/*, roots.ts, shell-env.ts, layout-store.ts, notes-store.ts, recipe-file.ts, drops.ts, host-launcher.ts, image-thumbnail.ts, notifications.ts, menu.ts, preload/island.ts, most of preload/index.ts.
- **renderer**: ProviderCard, CustomProviderPanel, SignInTerminal, launch-agents, MemoryPanel, ProjectSearch, PluginPanel, NewSessionOrRoomDialog, Composer, ContextChip, most of AppShell, ErrorBoundary, files/preview, files/editor, terminal/SearchBar, island/sound, attention/seen, use-mark-read.ts, chime.ts, browser/devtools, island/consents/ConsentView, island/swarm, theme, ui, agents, review/diff-sides.ts.
- `desktop/src/shared` was not covered as a slice.

Why: one wave of 8 Haiku drones (the cap this run allowed), each with a slice of 15-30k lines and a 40-minute budget. The run rules let the queen read code only to settle disputes, so she did not fill the gaps herself.

Cost: 8 drones (Claude Haiku), 8/8 handed in, 8/8 partial; 1 verifier (Codex gpt-6-luna, medium) on 41 claims: 36 PASS, 4 FAIL, 1 NOT VERIFIED. The queen read code only for V7, V26 and V29 and one grep for `uncaughtException`.
