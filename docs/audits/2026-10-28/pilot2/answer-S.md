# Pilot 2 — answer S (single session, s-65)

Start: Wed Oct 28 17:29:59 UTC 2026
End: Wed Oct 28 17:43:41 UTC 2026

Subject: `/Users/kalmbik61/parley/pilot2-subject` at `da446e81` (HEAD checked with `git log -1`). Read only, nothing run there.
Paths below are relative to `packages/`. Line numbers are at `da446e81`.

Method: every `catch (`, `catch {` and `.catch(` in `*/src` outside tests was listed with three lines of context
(host 456, core 363, protocol 1, desktop 497); places that rethrow or wrap the error into a protocol error were dropped,
the rest were read in their surrounding code. Then every `for (;;)`, `while (true)`, `while (!…)` and `setInterval(`, and
every line-start `void x(...)` without `.catch` in host, core and desktop main/preload. Host has no
`process.on('unhandledRejection')` (grep over all packages), so in the Node 22 host an unhandled rejection kills the
process; the code itself says so (`host/src/server.ts:181-183`, `host/src/methods/index.ts:379-381`).

Format: `ID | kind | path:line | what fails | who does not learn it and what they see instead | harm | deliberate?`

## Q1. Host (`host/src`)

```
Q1-1 | c,b | host/src/host.ts:400 (+ host/src/rooms/autonomous-engine.ts:1120, :1134) | any error that escapes the autonomous engine's processWork/cycle (git, map write, launch, recovery) | the human: the engine's onFailure only writes log.error; the plan card stays "running" with nothing moving. The engine re-polls every 1 s (:1134) and repeats the same failure with no backoff (only recovery has one, :1106) and no notice — unlike plan effects, whose onFailure broadcasts host.notice (host.ts:270-280) | high | no
Q1-2 | c | host/src/works/works-service.ts:890 | the works watcher (DB data_version poll, list read) fails — DB locked/unreadable, read throws | the human: onError only logs a warning ("событие пропущено"); the window keeps the last snapshot, changes made by agents stop arriving, no works-changed and no host.notice; core reports such a failure only once (core/src/work/works.ts:267) | high | no
Q1-3 | e | host/src/sessions/sessions-service.ts:1375 (handler host/src/methods/sessions.ts:181) | sessions.resumeInterrupted: launch of an interrupted session fails | the human clicks Resume on the "interrupted" banner: launch errors are only logged, the method answers {ok:true}, the refs are removed from the interrupted list (:1379-1380) so the banner disappears; a host.notice is sent only for HostError (:933), other errors (map lock timeout, spawn error) leave the session asleep with no message | med | no
Q1-4 | d | host/src/works/works-service.ts:901 | `void requestRefresh()` has no .catch; refreshPass calls listeners synchronously without try (:974) | nobody: a throwing works.onChange subscriber or publish turns into an unhandled rejection, which in this host is a process crash (window then shows "disconnected"); onMail subscribers, by contrast, are wrapped (:595) | med | no
Q1-5 | a | host/src/assistant/assistant-service.ts:1285 (+ host/src/assistant/reminders.ts:196-197) | a reminder fires while the assistant CLI is offline | the human who set the reminder: it returns 'skipped', the store advances it (one-shot reminder is removed) and only deps.log is written — no assistant.changed error, no Telegram line; the reminder silently never happens | med | no
Q1-6 | a | host/src/assistant/reminders.ts:168 and :183 | onDue throws, or the assistant cannot start MAX_RETRIES times | the human: a throwing onDue is treated as 'skipped' and the reminder is consumed; after retries it is "dropped" — both only in deps.log | med | no
Q1-7 | e | host/src/assistant/reminders.ts:112 (called from add at :238) | reminders.json cannot be written (disk, permissions) | the human/assistant: add() returns the reminder as created, the failure is only logged; after a host restart the reminder is gone | med | no
Q1-8 | a | host/src/telegram/service.ts:1091-1093 (+ host/src/telegram/poller.ts:62) | handling of a text/voice message or of /start, a command, a button fails with a non-HostError | the Telegram owner: only HostError gets a "could not" reply; anything else is logged (detached → "voice failed", others rethrown and logged by the poller) and the message gets no answer | med | no
Q1-9 | c | host/src/host.ts:852 | telegram.start() throws (config or secret read) | the human: only log.error; Telegram is simply inactive, the settings show no error (lastError stays null) | low | yes ("Сбой канала не должен останавливать хост" explains why the host goes on, not why the window is not told)
Q1-10 | c | host/src/host.ts:811 | the feed hook receiver does not start listening | the human: log.error only; sessions start without HTTP hooks, the window shows only the terminal (no chat feed, no permission cards) with no notice why | med | yes (comment at :808-809)
Q1-11 | c | host/src/host.ts:283 | room history derivative files are not rebuilt (history-service counts failures, host/src/rooms/history-service.ts:130) | the human: onFailure only writes log.warn('history-write-failed'); room history/journal views stay stale | low | no
Q1-12 | c | host/src/sessions/agent-skills.ts:80 | installing the Parley agent skill fails entirely (write error) | the agent and the human: the session starts without the skill, only log.error; skipped installs do reach the window (:57), the total failure does not | med | partly ("session starts without them" in the log text)
Q1-13 | c | host/src/stuck/stuck-service.ts:169 | the map write that posts "session is stuck / hit its limit" fails | the room lead and the human: write() returns false, only log.error; the stuck letter and the session's stuck mark are not posted, the lead keeps waiting for a stalled session | med | yes (doc comment :161 "сбой — строка в журнале хоста, без исключения наружу")
Q1-14 | a,b | host/src/sessions/sessions-service.ts:1317 | stopping a session that was closed by close_session or whose work was archived fails | the human: log.error only; the map says closed/archived while the agent process may keep running; retried only on the next works change, without cap or backoff | med | no
Q1-15 | a | host/src/sessions/sessions-service.ts:461 | the budget reservation outcome (spent/released) is not written | the human: log.error only; the reservation stays as it was in the map (see hypothesis H2 for the consequence) | low | no
Q1-16 | a,b | host/src/limits/limits-service.ts:224 (+ :248, :250) | reading CLI limits fails (one unreadable work limits file makes the whole collect throw) | the human: a warning without the error text; the status bar keeps showing the previous limits; periodic refresh failures are dropped by `.catch(() => {})` every interval | low | no
Q1-17 | a,b | host/src/context/context-service.ts:78 | a context-fill tick fails (one session's read rejects the Promise.all) | the human: `.catch(() => undefined)`, not even logged; the context indicator of every session stops updating while the failure repeats each interval | low | no
Q1-18 | a | host/src/activity/codex-log-poll.ts:81 | reindexing a Codex session log fails | the human: nothing is logged; Codex activity state (working/idle) stays stale until the file changes again | low | yes
Q1-19 | c | host/src/wake/wake-service.ts:1076 | delivering a recipe playbook to a new room lead fails | the new lead agent: log.error only; it works without the playbook until some later map change retries | low | partly (doc comment ending at :1068 says the next change retries)
Q1-20 | a | host/src/wake/wake-service.ts:1158 | loadConfig() fails at wake start | the human: `.catch(() => {})`; resumeRate silently stays at the default instead of the configured value | low | no
Q1-21 | c | host/src/server.ts:186 | a notification handler (pty.input, pty.resize, …) throws | the human typing in the terminal: notifications have no reply, the failure is a log.warn only; keystrokes to a dead PTY are lost | low | yes (comment :181-183)
Q1-22 | a | host/src/consents/consents-service.ts:162 | consents.json cannot be written | the human: log.warn only; decisions live in memory, after a restart the human is asked again | low | yes (comment :126)
Q1-23 | a | host/src/methods/works.ts:64 | removing history files of a deleted work fails | the human: works.delete answers {ok:true}; derived files stay | low | yes (comment :63)
```

## Q2. Core (`core/src` without `mcp/`)

```
Q2-1 | a,e | core/src/secrets.ts:47 (+ writeSecret :127, clearSecret :140-146) | secrets.json is corrupt JSON | the human: readStore returns {} so every key reads as "no key" instead of "damaged file"; saving one key (writeSecret) rewrites the file with that key only and drops the others (zai, custom:*); clearing a key on a damaged file deletes the whole file (empty data → rm) | med | partly (comment :35 says corrupt JSON gives no key; the overwrite is not mentioned)
Q2-2 | a,e | core/src/custom-providers.ts:196 | providers.json cannot be read or parsed (any error, EACCES included) | the human: readCustomProviders returns []; adding a provider (host/src/methods/custom-providers.ts:110, :127) then writes a list with only the new record, the other custom providers vanish silently | med | yes (comment :191 "Нет файла или битый JSON — пусто")
Q2-3 | a | core/src/config.ts:475 (+ :480) | config.json cannot be read or parsed when a setting is saved | the human: kept = {} and the file is rewritten with only the patch — all other settings reset to defaults; the write is a plain writeFile, not atomic | low | yes (comment :464-465)
Q2-4 | a | core/src/work/launch.ts:839 | stamping the native-context descriptor after launch fails | the agent: `.catch(() => {})`; later find_skill reports skills as unverified with no hint why | low | yes (comment :838)
Q2-5 | a | core/src/migrate.ts:354 (+ :383-390) | rewriting briefs / writing self-ignore / the migration record after a state-dir move fails | the agent: `.catch(() => undefined)`; briefs keep paths of the old directory | low | yes (comments :345-346, :381-382)
Q2-6 | a | core/src/work/statusline.ts:146-147 | saving limits/context from the status line fails | the human: `.catch(() => undefined)`; limits and context fill are silently stale | low | no
```

## Q3. Agent MCP server (`core/src/mcp`) and protocol (`protocol/src`)

```
Q3-1 | b,a | core/src/mcp/inbox-watch.ts:118 | the inbox watcher cannot read the map (DB unreadable, work deleted live) | the agent: no error, no ring; the loop sleeps pollMs and retries forever with no cap and no backoff, the agent just stops being woken by mail | med | yes (comment :119-120)
Q3-2 | b | core/src/mcp/inbox-watch.ts:130 | a ring notification cannot be sent (transport closed, client busy) | the agent: retried every pollMs forever, no cap, nobody is told | low | yes (comment :131, :136-137)
Q3-3 | a | core/src/mcp/tools.ts:1650 | building the skill catalog throws (Codex app-server timeout, I/O) | the agent: `.catch(() => ({ catalog: null }))` without `retry`, so the empty result is cached for the life of the MCP process; find_skill answers "no skill" with the generic reason "availability … unverified", never the real error | low | no
Q3-4 | a | core/src/mcp/tools.ts:812 | writing ParleyWaitStart/End to the session events journal fails | the human (window): the waiting state of the agent is not shown; the agent's wait_for is unaffected | low | yes (comment :797-799, :812)
Q3-5 | a | core/src/mcp/tools.ts:1553 | recording the Codex thread binding fails | the agent and the human: only a stderr line of the MCP process; the binding proof is not recorded | low | no
```

Checked and not silent: the CallTool handler turns every thrown error into `isError` (`core/src/mcp/tools.ts:1743-1748`);
remote runner retries with a budget and then answers "host not responding" (`core/src/mcp/remote-tools.ts:224-246`);
`wait_for` probe errors reject (`core/src/mcp/watch-map.ts:93-96`); backlog/memory feed failures are returned as
`feedUnavailable` (`core/src/mcp/tools.ts:1321`, `:1398`); browser/session/attempt tools return explicit texts.
`protocol/src`: one catch (`protocol/src/capability-actions.ts:11`, URL validation returning false) — not a silent failure;
`protocol/src/framing.ts:59` loop is a line splitter. No finding in protocol.

## Q4. Desktop main and preload (`desktop/src/main`, `desktop/src/preload`)

```
Q4-1 | c | desktop/src/main/index.ts:245 | resolving the host entry or spawnHost throws (missing bundle, spawn error) | the human: console.error and `return null`, but no connection.reportUnavailable (the node-not-found branch at :220-223 does call it); the window waits for the connect timeout and shows a generic "host not answering"/socket error instead of the reason | med | no
Q4-2 | c | desktop/src/main/assistant-mirror.ts:40 | assistant.configure to the host fails | the human: only deps.log; the settings UI shows the new assistant provider/model/voice while the host keeps the old ones | med | no
Q4-3 | a,e | desktop/src/main/host-connection.ts:739 | sending browser.agentResult back to the host fails | the agent: the result of its browser operation (which may already have clicked/typed) is lost; after the host timeout it gets "The window did not answer within N s." (host/src/agent/browser-endpoint.ts:181) | med | no
Q4-4 | d | desktop/src/main/window.ts:88 | the main window's loadFile rejects | the human: `void` without .catch and no did-fail-load handler — a blank window; the island load does have a .catch (index.ts:513) | low | no
Q4-5 | a | desktop/src/main/quit-guard.ts:55 | stopHost fails during quit after the human chose to stop sessions | the human: only deps.log, the app quits anyway; stopHost escalates to SIGKILL (host-connection.ts:701-702), so a leftover host is unlikely | low | no
Q4-6 | a | desktop/src/main/ui-store.ts:31-34 (+ :38) | ui.json is unreadable or broken | the human: DEFAULT_UI is used and the next save writes defaults merged with the patch — all window settings reset, only a console warning (or nothing, for broken JSON) | low | yes (doc comment :20-26)
Q4-7 | e | desktop/src/main/ipc.ts:571 | app:save-layout with a layout over the size limit | the renderer gets success; the layout is not saved, only console.warn in main | low | yes (comment :572-574)
Q4-8 | a | desktop/src/main/update-check.ts:253 | the update check fails | the human: nothing ("Молчим"); no update is offered | low | yes
```

Preload: `desktop/src/preload/index.ts:226`, `:330` swallow a failed one-off `invoke` for a held focus target / update
info — benign (the event path stays), not listed.

## Q5. Desktop renderer (`desktop/src/renderer`)

```
Q5-1 | a | desktop/src/renderer/chat/ChatView.tsx:392 | feed.interrupt (the chat Stop button) fails | the human presses Stop: the error goes to console.warn only, no toast; the agent keeps working while the human believes it was stopped | high | no
Q5-2 | a,b | desktop/src/renderer/store/works.ts:171 | repairing a rooms.mail gap (followRoom/rereadRoom/openRoom) fails | the human: console.warn only; retries with backoff forever, no cap; the room silently misses letters until a repair succeeds | med | no
Q5-3 | a | desktop/src/renderer/sidebar/SessionRowMenu.tsx:82 | sessions.stop / close / delete / resume from the sidebar menu fail | the human: console.warn only (toast only for a resume budget refusal); the row just does not change, no reason | med | yes (comment :80 "строка сама покажет исход")
Q5-4 | b | desktop/src/renderer/store/room-pages.ts:144 (+ :153) | opening a room's message pages keeps failing | the human: retried with backoff while the room is open, no cap; retry failures only console.warn | low | no
Q5-5 | a | desktop/src/renderer/App.tsx:289, :296 | Retry / Restart host on the disconnected screen fail | the human: console.warn only; the screen keeps the previous reason, the click looks ignored | low | yes (comment :280)
Q5-6 | a | desktop/src/renderer/layout/persistence.ts:404 (+ :436) | restoring a work's layout fails / saving it fails | the human: the work opens with an empty layout as if none was saved; save failures are dropped | low | yes (comments :405-406, :437-438)
Q5-7 | a | desktop/src/renderer/store/ui.ts:364 | app.saveUi fails | the human: the setting changes on screen but is not persisted; dropped | low | yes (comment :365)
```

Checked and reported to the human: most renderer catches end in `toast(...)` or `setError(...)` (room menus, session
create/launch, provider panels, project panels, files, settings, outbox `room-outbox.ts:33`).

## Q6. Retries, polls and wait loops (kind b)

No cap or no backoff:

```
Q6-1 | b,c | host/src/rooms/autonomous-engine.ts:1134 | the 1 s poll re-runs processWork; a cycle failure is repeated every second with no backoff and no cap, only log.error (host.ts:400) | the human sees a frozen plan | high | no
Q6-2 | b | host/src/rooms/autonomous-engine.ts:1106 | recovery failures: exponential backoff up to 30 s but no cap; agents get 'engine-recovering', the human only a log line | med | no
Q6-3 | b,a | core/src/mcp/inbox-watch.ts:118 | map read failure: fixed pollMs, no cap, no backoff (= Q3-1) | med | yes
Q6-4 | b | core/src/mcp/inbox-watch.ts:130 | ring failure: fixed pollMs, no cap (= Q3-2) | low | yes
Q6-5 | b | host/src/telegram/outbox.ts:59 | HTTP 429 is retried after retry_after with no attempt cap; the single outbox pump blocks all later jobs while a 429 persists | low | no
Q6-6 | b | host/src/sessions/sessions-service.ts:1317 | stopping a retired session is retried on every works change, no cap (= Q1-14) | med | no
Q6-7 | b,a | host/src/limits/limits-service.ts:250 | fixed-interval refresh, every failure dropped by `.catch(() => {})` | low | no
Q6-8 | b,a | host/src/context/context-service.ts:78 | fixed-interval tick, every failure dropped without a log | low | no
Q6-9 | b | desktop/src/renderer/store/works.ts:178 | mail repair: backoff capped in delay, unbounded in attempts (= Q5-2) | med | no
Q6-10 | b | desktop/src/renderer/store/room-pages.ts:144 | room open retry: backoff, unbounded attempts (= Q5-4) | low | no
```

Uncapped but visible, so not silent: desktop reconnect loop `desktop/src/main/host-connection.ts:523-533` (backoff
0.5→5 s, status `disconnected` with a reason); Telegram poller `host/src/telegram/poller.ts:44` (exponential backoff,
`onStatus('error', …)`).

Checked, bounded: `core/src/secrets.ts:91` (10 s deadline), `core/src/work/store.ts:276` (lock timeout),
`core/src/mcp/tools.ts:947` (call timeout), `core/src/mcp/remote-tools.ts:224` (retry budget),
`core/src/work/context-pages.ts:257`, `core/src/recipes/catalog.ts:90` (256 entries), `core/src/skills/codex.ts:222`
(maxAncestors), `core/src/work/works.ts:252` (reports once), `host/src/assistant/reminders.ts:159` (MAX_RETRIES),
`host/src/assistant/assistant-service.ts:1278` (waits for idle, exits on stop), `host/src/rooms/plan-effects.ts:382`
(4 attempts + notice), `host/src/rooms/autonomous-engine.ts:825` (queue drain), `host/src/sessions/sessions-service.ts:899`
(START_WRITE_ATTEMPTS), `host/src/telegram/outbox.ts:64` (NETWORK_RETRIES), `host/src/telegram/service.ts:1210`
(GETME_ATTEMPTS), `host/src/providers/custom-check.ts:51`, `host/src/limits/zai-*.ts` (body readers with limits),
`desktop/src/main/browser/agent-ops.ts:672`, `:740`, `desktop/src/main/browser/agent-dom.ts:103` (deadlines),
`desktop/src/main/update-check.ts:143`, `desktop/src/main/browser/favicon.ts:30` (size-limited readers),
`desktop/src/renderer/lib/outbox.ts` (retry only on explicit 'retry'), `desktop/src/renderer/review/notes/store.ts:79`
(random id).

## Hypotheses (no exact place or consequence not proven)

- H1. `host/src/works/works-service.ts:974`: which `works.onChange` subscriber can actually throw synchronously was not
  traced; Q1-4 holds as a lost promise, the crash needs such a subscriber.
- H2. Q1-15: an unsettled budget reservation may keep a launch slot counted and make later launches fail with
  `resource-budget`; `settleAttempt` (`core/src/work/resource-policy.ts:315`) was not read.
- H3. Q1-13: whether a stuck episode whose write failed is reported again later (episode.told stays unset) was not
  traced.
- H4. `desktop/src/main/roots.ts:244`, `:282`: `void apply(snapshot)` without .catch; whether `buildEntries` can reject
  was not checked.

## Q7. Ten most harmful

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

## Not covered

- Not every catch was opened in its function: of ~1,317 catch sites I read in context those that do not rethrow
  (host ≈ 456 listed, all scanned; core 268 non-rethrowing scanned; desktop main/preload 160 and renderer 278 scanned),
  and opened the code only for the candidates above. Branches that end in `return null` / `return false` in parsers
  (JSON, TOML, frontmatter, URL) were treated as validation, not as silent failures.
- Error paths that are not `catch`/`.catch` (e.g. `if (!ok) return` after a failed result object, `Promise.allSettled`
  results ignored) were not searched systematically; only `allSettled` in `host/src/limits/limits-service.ts:232` was read.
- `.then(onOk)` chains without a rejection handler were checked only for lines starting with `void`; multi-line chains
  stored in variables were not.
- Renderer `void x()` calls without `.catch` were not swept (the sweep covered host, core and desktop main/preload).
- `host/src/telegram/*` beyond service/poller/outbox/state, `host/src/capabilities/*` internals, `core/src/skills/*`,
  `core/src/work/store.ts` beyond the lock and the catch list, and `desktop/src/main/browser/*` beyond the catch list
  were not read in depth: their catches return explicit result codes (`invalid`, `unverified`, `cli-error`,
  `io-error`, `diagnose(...)`) that reach the caller.
