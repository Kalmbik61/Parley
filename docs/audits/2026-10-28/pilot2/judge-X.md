# Answer X: claims to check

Subject: Parley at da446e81, /Users/kalmbik61/parley/pilot2-subject. Line format: ID | kind | path:line | what fails | who does not learn it | harm | deliberate?

## Q7 of answer X (its ten most harmful), as written
. Ten most harmful

1. Q5-1 — the human presses Stop in the chat, the interrupt fails, nothing is shown; the agent keeps spending tokens
   and changing files while the human thinks it stopped.
2. Q1-1 / Q6-1 — an autonomous plan hits an engine error; the plan card shows it running, the engine retries the same
   failure every second, only the host log knows. The human waits for work that never moves.
3. Q1-2 — the works watcher fails (DB locked/unreadable); the window freezes on an old snapshot without any notice;
   the human acts on stale sessions, rooms and letters.
4. Q1-3 — after a crash the human clicks Resume on the interrupted banner; some launches fail, the method says ok, the
   banner disappears, those sessions stay asleep with their work unfinished.
5. Q2-1 — a damaged secrets.json: saving one key drops all other keys, clearing a key deletes the file; the human
   sees "no key" and loses provider keys without any message.
6. Q2-2 — an unreadable providers.json: adding one provider overwrites the list, other custom providers disappear.
7. Q3-1 — the agent's inbox watcher hits a persistent map read error; the agent is no longer woken by mail and never
   learns why; letters pile up unread.
8. Q1-5 / Q1-6 / Q1-7 — reminders vanish: skipped while the CLI is offline, consumed after an exception, or not saved
   and lost on restart; the human relied on a check that never happens.
9. Q4-1 — the host cannot be spawned (bad bundle, spawn error); the human sees a generic "host not answering"
   after the timeout instead of the real reason and cannot fix it.
10. Q5-2 — a rooms.mail gap repair keeps failing; the room view silently misses letters while retries go on in the
    background.

## The findings Q7 refers to

Q5-1 | a | desktop/src/renderer/chat/ChatView.tsx:392 | feed.interrupt (the chat Stop button) fails | the human presses Stop: the error goes to console.warn only, no toast; the agent keeps working while the human believes it was stopped | high | no
Q1-1 | c,b | host/src/host.ts:400 (+ host/src/rooms/autonomous-engine.ts:1120, :1134) | any error that escapes the autonomous engine's processWork/cycle (git, map write, launch, recovery) | the human: the engine's onFailure only writes log.error; the plan card stays "running" with nothing moving. The engine re-polls every 1 s (:1134) and repeats the same failure with no backoff (only recovery has one, :1106) and no notice — unlike plan effects, whose onFailure broadcasts host.notice (host.ts:270-280) | high | no
Q6-1 | b,c | host/src/rooms/autonomous-engine.ts:1134 | the 1 s poll re-runs processWork; a cycle failure is repeated every second with no backoff and no cap, only log.error (host.ts:400) | the human sees a frozen plan | high | no
Q1-2 | c | host/src/works/works-service.ts:890 | the works watcher (DB data_version poll, list read) fails — DB locked/unreadable, read throws | the human: onError only logs a warning ("событие пропущено"); the window keeps the last snapshot, changes made by agents stop arriving, no works-changed and no host.notice; core reports such a failure only once (core/src/work/works.ts:267) | high | no
Q1-3 | e | host/src/sessions/sessions-service.ts:1375 (handler host/src/methods/sessions.ts:181) | sessions.resumeInterrupted: launch of an interrupted session fails | the human clicks Resume on the "interrupted" banner: launch errors are only logged, the method answers {ok:true}, the refs are removed from the interrupted list (:1379-1380) so the banner disappears; a host.notice is sent only for HostError (:933), other errors (map lock timeout, spawn error) leave the session asleep with no message | med | no
Q2-1 | a,e | core/src/secrets.ts:47 (+ writeSecret :127, clearSecret :140-146) | secrets.json is corrupt JSON | the human: readStore returns {} so every key reads as "no key" instead of "damaged file"; saving one key (writeSecret) rewrites the file with that key only and drops the others (zai, custom:*); clearing a key on a damaged file deletes the whole file (empty data → rm) | med | partly (comment :35 says corrupt JSON gives no key; the overwrite is not mentioned)
Q2-2 | a,e | core/src/custom-providers.ts:196 | providers.json cannot be read or parsed (any error, EACCES included) | the human: readCustomProviders returns []; adding a provider (host/src/methods/custom-providers.ts:110, :127) then writes a list with only the new record, the other custom providers vanish silently | med | yes (comment :191 "Нет файла или битый JSON — пусто")
Q3-1 | b,a | core/src/mcp/inbox-watch.ts:118 | the inbox watcher cannot read the map (DB unreadable, work deleted live) | the agent: no error, no ring; the loop sleeps pollMs and retries forever with no cap and no backoff, the agent just stops being woken by mail | med | yes (comment :119-120)
Q1-5 | a | host/src/assistant/assistant-service.ts:1285 (+ host/src/assistant/reminders.ts:196-197) | a reminder fires while the assistant CLI is offline | the human who set the reminder: it returns 'skipped', the store advances it (one-shot reminder is removed) and only deps.log is written — no assistant.changed error, no Telegram line; the reminder silently never happens | med | no
Q1-6 | a | host/src/assistant/reminders.ts:168 and :183 | onDue throws, or the assistant cannot start MAX_RETRIES times | the human: a throwing onDue is treated as 'skipped' and the reminder is consumed; after retries it is "dropped" — both only in deps.log | med | no
Q1-7 | e | host/src/assistant/reminders.ts:112 (called from add at :238) | reminders.json cannot be written (disk, permissions) | the human/assistant: add() returns the reminder as created, the failure is only logged; after a host restart the reminder is gone | med | no
Q4-1 | c | desktop/src/main/index.ts:245 | resolving the host entry or spawnHost throws (missing bundle, spawn error) | the human: console.error and `return null`, but no connection.reportUnavailable (the node-not-found branch at :220-223 does call it); the window waits for the connect timeout and shows a generic "host not answering"/socket error instead of the reason | med | no
Q5-2 | a,b | desktop/src/renderer/store/works.ts:171 | repairing a rooms.mail gap (followRoom/rereadRoom/openRoom) fails | the human: console.warn only; retries with backoff forever, no cap; the room silently misses letters until a repair succeeds | med | no

## Sampled findings (not in Q7)

Q1-4 | d | host/src/works/works-service.ts:901 | `void requestRefresh()` has no .catch; refreshPass calls listeners synchronously without try (:974) | nobody: a throwing works.onChange subscriber or publish turns into an unhandled rejection, which in this host is a process crash (window then shows "disconnected"); onMail subscribers, by contrast, are wrapped (:595) | med | no
Q1-9 | c | host/src/host.ts:852 | telegram.start() throws (config or secret read) | the human: only log.error; Telegram is simply inactive, the settings show no error (lastError stays null) | low | yes ("Сбой канала не должен останавливать хост" explains why the host goes on, not why the window is not told)
Q1-11 | c | host/src/host.ts:283 | room history derivative files are not rebuilt (history-service counts failures, host/src/rooms/history-service.ts:130) | the human: onFailure only writes log.warn('history-write-failed'); room history/journal views stay stale | low | no
Q1-13 | c | host/src/stuck/stuck-service.ts:169 | the map write that posts "session is stuck / hit its limit" fails | the room lead and the human: write() returns false, only log.error; the stuck letter and the session's stuck mark are not posted, the lead keeps waiting for a stalled session | med | yes (doc comment :161 "сбой — строка в журнале хоста, без исключения наружу")
Q1-15 | a | host/src/sessions/sessions-service.ts:461 | the budget reservation outcome (spent/released) is not written | the human: log.error only; the reservation stays as it was in the map (see hypothesis H2 for the consequence) | low | no
Q1-17 | a,b | host/src/context/context-service.ts:78 | a context-fill tick fails (one session's read rejects the Promise.all) | the human: `.catch(() => undefined)`, not even logged; the context indicator of every session stops updating while the failure repeats each interval | low | no
Q1-19 | c | host/src/wake/wake-service.ts:1076 | delivering a recipe playbook to a new room lead fails | the new lead agent: log.error only; it works without the playbook until some later map change retries | low | partly (doc comment ending at :1068 says the next change retries)
Q1-21 | c | host/src/server.ts:186 | a notification handler (pty.input, pty.resize, …) throws | the human typing in the terminal: notifications have no reply, the failure is a log.warn only; keystrokes to a dead PTY are lost | low | yes (comment :181-183)
Q1-23 | a | host/src/methods/works.ts:64 | removing history files of a deleted work fails | the human: works.delete answers {ok:true}; derived files stay | low | yes (comment :63)
Q2-4 | a | core/src/work/launch.ts:839 | stamping the native-context descriptor after launch fails | the agent: `.catch(() => {})`; later find_skill reports skills as unverified with no hint why | low | yes (comment :838)
Q2-6 | a | core/src/work/statusline.ts:146-147 | saving limits/context from the status line fails | the human: `.catch(() => undefined)`; limits and context fill are silently stale | low | no
Q3-3 | a | core/src/mcp/tools.ts:1650 | building the skill catalog throws (Codex app-server timeout, I/O) | the agent: `.catch(() => ({ catalog: null }))` without `retry`, so the empty result is cached for the life of the MCP process; find_skill answers "no skill" with the generic reason "availability … unverified", never the real error | low | no
Q3-5 | a | core/src/mcp/tools.ts:1553 | recording the Codex thread binding fails | the agent and the human: only a stderr line of the MCP process; the binding proof is not recorded | low | no
Q4-3 | a,e | desktop/src/main/host-connection.ts:739 | sending browser.agentResult back to the host fails | the agent: the result of its browser operation (which may already have clicked/typed) is lost; after the host timeout it gets "The window did not answer within N s." (host/src/agent/browser-endpoint.ts:181) | med | no
Q4-5 | a | desktop/src/main/quit-guard.ts:55 | stopHost fails during quit after the human chose to stop sessions | the human: only deps.log, the app quits anyway; stopHost escalates to SIGKILL (host-connection.ts:701-702), so a leftover host is unlikely | low | no
Q4-7 | e | desktop/src/main/ipc.ts:571 | app:save-layout with a layout over the size limit | the renderer gets success; the layout is not saved, only console.warn in main | low | yes (comment :572-574)
Q5-3 | a | desktop/src/renderer/sidebar/SessionRowMenu.tsx:82 | sessions.stop / close / delete / resume from the sidebar menu fail | the human: console.warn only (toast only for a resume budget refusal); the row just does not change, no reason | med | yes (comment :80 "строка сама покажет исход")
Q5-5 | a | desktop/src/renderer/App.tsx:289, :296 | Retry / Restart host on the disconnected screen fail | the human: console.warn only; the screen keeps the previous reason, the click looks ignored | low | yes (comment :280)
Q5-7 | a | desktop/src/renderer/store/ui.ts:364 | app.saveUi fails | the human: the setting changes on screen but is not persisted; dropped | low | yes (comment :365)
Q6-3 | b,a | core/src/mcp/inbox-watch.ts:118 | map read failure: fixed pollMs, no cap, no backoff (= Q3-1) | med | yes
Q6-5 | b | host/src/telegram/outbox.ts:59 | HTTP 429 is retried after retry_after with no attempt cap; the single outbox pump blocks all later jobs while a 429 persists | low | no
Q6-7 | b,a | host/src/limits/limits-service.ts:250 | fixed-interval refresh, every failure dropped by `.catch(() => {})` | low | no
Q6-9 | b | desktop/src/renderer/store/works.ts:178 | mail repair: backoff capped in delay, unbounded in attempts (= Q5-2) | med | no
