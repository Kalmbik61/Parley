# Answer Y: claims to check

Subject: Parley at da446e81, /Users/kalmbik61/parley/pilot2-subject. Line format: ID | kind | path:line | what fails | who does not learn it | harm | deliberate?

## Q7 of answer Y (its ten most harmful), as written
. The ten most harmful (by ID)

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

## The findings Q7 refers to

Q2-1  | a   | packages/core/src/secrets.ts:47 | corrupt secrets.json: readStore returns {}; writeSecret then rewrites the file with only its own key | the human saves one key (for example Telegram) and sees "saved"; the other keys (Z.ai, custom:*) are lost with no signal | high | partly (the read comment calls corrupt JSON "no key"; the loss on write is not described)
Q1-6  | a   | packages/host/src/consents/consents-service.ts:230 | run(): the held continuation or refusal launch throws after the human pressed Allow/Deny | the human sees "Trusted ✓"/"Done ✓" (decide() returned applied:true, card removed); the held session never starts; log.warn only | high | no
Q5-1  | a   | packages/desktop/src/renderer/island/IslandApp.tsx:473 | bridge.call('consents.list').catch(() => {}) on (re)connect | the human sees no consent card for consents the host holds; the agent waits for a decision that appears nowhere (until a later event refreshes the list) | high | no
Q1-1  | a   | packages/host/src/stuck/stuck-service.ts:123 | enqueue(): the task that builds/writes a stuck or limit episode letter throws | the stuck agent and the human: log.error only, the letter never arrives, the session just sits | high | no
Q1-2  | a   | packages/host/src/sessions/sessions-service.ts:496 | on PTY exit, finishExited (writing 'sleeping' to the map) fails | the human: log.error only; the window keeps showing an active session with no process, so mail to it does not wake it | high | no
Q3-1 | a/b | packages/core/src/mcp/inbox-watch.ts:117 | probe failures (readMap / unreadLetters / identity) are caught without a log; the watcher sleeps pollMs and retries forever | the channel-bound agent is never woken for new letters while the map read fails; it sees nothing until it calls check_inbox itself; the human sees an idle agent | med-high | yes (comment: wait for the next change)
Q1-15 | c   | packages/host/src/activity/log-index.ts:325 (and :343) | both watchSessions calls pass onError: () => {}, so fs.watch errors from core/watch.ts:137 are dropped | the human: the activity feed silently stops updating (EMFILE, removed folder) | med-high | yes (comment: retry on next event; the error itself is never surfaced)
Q2-8  | a   | packages/core/src/watch.ts:137 | fs.watch errors and failed watcher creation go only to an optional onError; the default is silent | through Q1-15: a session feed stops updating | med | yes (comment at 31)
Q2-2  | a   | packages/core/src/config.ts:475 | on write, JSON.parse of the existing config fails, so kept = {} and the file is rewritten with only the patch | the human changes one setting in the UI; all hand edits in a broken config.json are erased with no warning (the load path does complain) | med | yes (comment: write from scratch)
Q1-3  | a   | packages/host/src/sessions/sessions-service.ts:461 | settleLaunch: updateMap that settles the launch budget reservation fails | agents and the human: log.error only; the reservation stays unsettled, later launches can be refused for budget with no visible cause | med | no
Q4-1  | c   | packages/desktop/src/main/index.ts:246 | host spawn throws (entry or engine resolution, spawnHost); catch does console.error and returns null | the human: after up to 30 s of polling the window shows a generic socket/token "disconnected"; the real cause is only in main's console | med | no
Q4-2  | c   | packages/desktop/src/main/host-connection.ts:215 | startHostProcess() rejects; console.error only | same as Q4-1: the window never gets the spawn error | med | no

## Sampled findings (not in Q7)

Q1-4  | a   | packages/host/src/sessions/sessions-service.ts:1375 | resumeInterrupted: launch(ref,'resume') rejects | the human who pressed resume: log.error only, the ref is dropped from interruptedRefs, no notice | med | no
Q1-8  | a   | packages/host/src/compaction/compaction-service.ts:198 | the compaction job rejects; .catch logs, finally publishes pending=null | the human/agent: the "compacting" state just clears, with no failure text | med | no
Q1-11 | c   | packages/host/src/hooks/hook-server.ts:300 | the hook server emits 'error' after listen; log.warn only | the window is not told: the hook feed (approvals, live feed) is dead for the rest of the host's life | med | yes (comment: the host must not fail because of the receiver)
Q1-14 | b   | packages/host/src/assistant/reminders.ts:204 | while the assistant is busy or not ready, the reminder re-arms setTimeout(tick, RETRY_MS) with no cap | the human is never told a reminder is postponed without end | low-med | yes (comment logs the postponement)
Q1-18 | a   | packages/host/src/host.ts:830 | collectInterrupted fails; log.error, start goes on | the human: the "interrupted sessions" banner is empty | med | no
Q1-21 | a   | packages/host/src/wake/wake-service.ts:1075 | deliverRecipeToNewLeads fails; log.error | a new room lead never gets its playbook; no notice | low-med | no
Q1-24 | e   | packages/host/src/providers/auth-service.ts:239 | check(): a timeout or spawn failure is shown as signedIn:false, detail null | the human sees "not signed in" with a Sign-in button instead of "check failed" | low-med | yes (comment at 240-242)
Q2-4  | a   | packages/core/src/work/lease.ts:44 | any readFile error (EACCES, I/O, not only ENOENT) and corrupt JSON (:49-51) return null, the same as "no lease" | callers cannot tell "unreadable" from "free" (the callers were not read) | med | yes (doc comment: unreadable means unknown tenant)
Q2-7  | a   | packages/core/src/custom-providers.ts:196 | any read/parse error of the custom providers file returns [] | the human: all custom providers vanish from the list with no message | med | yes (comment groups "absent" and "invalid JSON")
Q2-11 | a   | packages/core/src/assistant/stream.ts:46 | broken JSON in the tool-arguments string becomes {} | the assistant's tool call runs with empty arguments as if that were intended | low-med | no
Q3-2 | c   | packages/host/src/server.ts:76 (decoder at packages/protocol/src/framing.ts:65) | LineDecoder.push calls JSON.parse per line with no per-line guard; server.ts rethrows everything except LineTooLongError from the socket 'data' handler, and no uncaughtException handler exists in host/core | one malformed line from any local client (MCP server, window) becomes an uncaught exception in the host; everyone else sees only "disconnected" | med | no |[Q]
Q3-5 | a   | packages/core/src/mcp/tools.ts:812 | the appendFile of a wait_for journal event is swallowed | the event journal silently lacks entries; the agent sees a normal wait_for | low | yes (comment)
Q4-4  | a   | packages/desktop/src/main/quit-guard.ts:55 | stopHost() fails during quit; log only, app.quit() goes on | the human confirmed quit thinking sessions stopped; the host may keep running | med | no
Q4-7  | c   | packages/desktop/src/main/ipc.ts:828 | PARLEY.md receiptError: console.warn only, the result goes back as {exists, created} | the human/agent sees a normal success | low-med | no
Q4-10 | a   | packages/desktop/src/main/update-check.ts:253 | any update-check failure is swallowed ("Молчим") | the human never learns the update check failed | low | yes
Q5-2  | d   | packages/desktop/src/renderer/App.tsx:250 | handleRestart: `void bridge.app.restartHost();` with no catch | the human presses "restart" on the version-mismatch screen; nothing happens, no text | med | no
Q5-5  | a   | packages/desktop/src/renderer/layout/persistence.ts:174 | restoreLayout(...).catch(() => emptyLayout()) | a read failure silently opens an empty layout in place of the saved one | med | no
Q5-8  | b   | packages/desktop/src/renderer/store/works.ts:171 | the rooms.mail repair retries with capped backoff but no attempt cap; failures go to console.warn | a held-mail gap persists silently | med | no
Q5-11 | a   | packages/desktop/src/renderer/update/update-notice.ts:50 | dismiss(version) runs before openExternal; an open failure (:53) is console.warn only | the human clicks Download, nothing opens, and the update offer never comes back | med | no
Q5-14 | a/c | packages/desktop/src/renderer/browser/panel/agent-registry.ts:39 (and :50) | registerTab rejects: console.warn + undo() | main never learns the page; no toast | med | yes (comment)
Q5-17 | e   | packages/desktop/src/renderer/voice/downloads-store.ts:67 | any downloadModel rejection is mapped to {error:'network'} | the human sees "network" for any host error | low | no
