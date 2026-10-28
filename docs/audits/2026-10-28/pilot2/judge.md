# Pilot 2 blind judgment

Start (date -u): 2026-10-28T17:45:02Z  
End (date -u): 2026-10-28T17:58:27Z

Subject: `da446e813af609c1e76282ace885587475d12041`, read directly in `/Users/kalmbik61/parley/pilot2-subject`; tracked subject files were clean. Static inspection only; no builds or tests. Every finding line is counted, including duplicate mechanisms under different IDs.

A comment establishes intent but does not excuse destructive data loss or a stalled primary workflow. DELIBERATE identifies documented auxiliary/recovery behavior or an explicit alternative error/result path. FALSE can contain a real nearby catch when the submitted mechanism or consequence is materially wrong. Startup/crash findings retain CORRECT for the withheld main/host diagnostic (kind c), with the visible connection failure expressly noted.

## Answer X

| ID | Verdict | Proof |
| --- | --- | --- |
| Q5-1 | CORRECT | packages/desktop/src/renderer/chat/ChatView.tsx:392 catches feed.interrupt failure only with console.warn; no user error or fallback is issued. |
| Q1-1 | CORRECT | packages/host/src/host.ts:400 only logs engine failures; packages/host/src/rooms/autonomous-engine.ts:1120 catches scheduled cycle errors and :1134 scans every second; recovery alone has backoff at :1107. |
| Q6-1 | CORRECT | packages/host/src/rooms/autonomous-engine.ts:1111 runs cycle outside recovery backoff; :1120 forwards failures to the log-only host.ts:400 callback and :1134 polls again without an attempt cap. |
| Q1-2 | CORRECT | packages/host/src/works/works-service.ts:890 only warns; packages/core/src/work/works.ts:267 suppresses repeated poll failures until recovery, with no changed snapshot or window error for persistent failure. |
| Q1-3 | CORRECT | packages/host/src/sessions/sessions-service.ts:1375 swallows launch rejection and :1380 removes requested refs; methods/sessions.ts:182 returns ok; only HostError is separately noticed at sessions-service.ts:934. |
| Q2-1 | CORRECT | packages/core/src/secrets.ts:47 maps corrupt JSON to {}; :127 then rewrites that empty store plus one key, while :140 and :144 delete a corrupt store on clear; the read comment does not protect the other secrets. |
| Q2-2 | CORRECT | packages/core/src/custom-providers.ts:196 turns every read/parse error into []; packages/host/src/methods/custom-providers.ts:110, :125 and :127 append to that empty list and replace the file without a read-failure signal. |
| Q3-1 | CORRECT | packages/core/src/mcp/inbox-watch.ts:118 suppresses failed probes, sleeps pollMs at :121 and continues indefinitely; :101 cannot discover/ring unread mail while map reads keep failing. |
| Q1-5 | CORRECT | packages/host/src/assistant/assistant-service.ts:1285 logs offline selection and returns skipped; assistant/reminders.ts:196 advances/removes it and :198 only logs the skip, with no user notification on this branch. |
| Q1-6 | CORRECT | packages/host/src/assistant/reminders.ts:165 defaults to skipped, :168 only logs onDue exceptions, and :182 logs/drops exhausted retries; :186/:196 advance the reminder without reporting those losses to its owner. |
| Q1-7 | CORRECT | packages/host/src/assistant/reminders.ts:112 swallows persistence errors; add still appends in memory, calls save at :238 and returns the reminder at :240, so restart loses an apparently created reminder. |
| Q4-1 | CORRECT | packages/desktop/src/main/index.ts:245 logs and returns null without reportUnavailable (:223); main/host-connection.ts:331 sends a later connection reason, losing the original spawn/entry exception rather than hiding disconnection itself. |
| Q5-2 | FALSE | packages/desktop/src/renderer/store/works.ts:173 really only warns, but :192 requires again and :193 clears it; :175 does not restore it, so its timer cannot perpetually retry a lone repair failure (new gaps set it at :257). |
| Q1-4 | CORRECT | packages/host/src/works/works-service.ts:901 discards requestRefresh; its :918 await propagates a throw from the unguarded listener call at :974 through the finally-only chain at :920, producing an unhandled rejection. |
| Q1-9 | CORRECT | packages/host/src/host.ts:852 only logs telegram.start rejection; telegram/service.ts:1220 reads config/secret before error state is set, so this startup failure can leave the channel inactive without a window error. |
| Q1-11 | CORRECT | packages/host/src/rooms/history-service.ts:129 counts failed rebuilds and :132 calls the host.ts:283 log-only callback; generated local history can remain stale (history-service.ts:45 limits this to derivatives, not live room/decision data). |
| Q1-13 | CORRECT | packages/host/src/stuck/stuck-service.ts:169 only logs and returns false; :227 writes stuck status plus letters atomically and :231 marks told only on success, so the intended recipients can miss the stalled-session alert. |
| Q1-15 | CORRECT | packages/host/src/sessions/sessions-service.ts:454 catches settlement-write failure at :461 and only logs; failed release can retain a reserved slot counted by core/src/work/resource-policy.ts:211. |
| Q1-17 | FALSE | packages/host/src/context/context-service.ts:62 starts independent per-session promises, each updating its own indicator at :64/:65; Promise.all rejection caught at :78 does not cancel the other updates, contrary to the all-sessions-freeze claim. |
| Q1-19 | CORRECT | packages/host/src/wake/wake-service.ts:1075 starts playbook delivery and :1076 only logs rejection, then clears the in-flight key at :1079; this delivery failure is not reported to the new lead. |
| Q1-21 | DELIBERATE | packages/host/src/server.ts:181 explicitly documents guarding one-way notifications against stale-PTY crashes; :184 catches/logs because these messages have no request id or response contract. |
| Q1-23 | DELIBERATE | packages/host/src/methods/works.ts:62 commits work deletion first; :63 explicitly declares history removal a derivative cleanup that must not turn the committed mutation into a retryable failure. |
| Q2-4 | DELIBERATE | packages/core/src/work/launch.ts:838 explicitly makes descriptor stamping auxiliary to an established launch; mcp/tools.ts:1654 reports unverified native availability and directs the agent to the full native skill list. |
| Q2-6 | DELIBERATE | packages/core/src/work/statusline.ts:137 documents independent best-effort hook outputs; :146/:147 suppress auxiliary cache-write errors while :149 still returns the terminal status line, without claiming those writes succeeded. |
| Q3-3 | DELIBERATE | packages/core/src/mcp/tools.ts:1650 caches an unavailable catalog, but :1654 supplies an explicit unverified-availability reason and full-list fallback, returned at :1695; this is a qualified fail-closed result, not verified absence of skills. |
| Q3-5 | CORRECT | packages/core/src/mcp/tools.ts:1540 updates the thread binding, but :1553 catches its failure with only process.stderr.write; the calling agent receives no binding-failure field/result. |
| Q4-3 | FALSE | packages/desktop/src/main/host-connection.ts:739 logs lost browser-result delivery, but packages/host/src/agent/browser-endpoint.ts:181 finishes the pending operation with an explicit timeout failure to the agent, not success or silence. |
| Q4-5 | DELIBERATE | packages/desktop/src/main/quit-guard.ts:55 is final shutdown cleanup; main/host-connection.ts:689 intentionally ignores the shutdown RPC response, then :701/:702 escalates to SIGTERM/SIGKILL before exit. |
| Q4-7 | DELIBERATE | packages/desktop/src/main/ipc.ts:572 explicitly documents success for LayoutTooLargeError with the previous disk layout retained; :575 limits this exception and :579 propagates other save failures. |
| Q5-3 | CORRECT | packages/desktop/src/renderer/sidebar/SessionRowMenu.tsx:82 only warns on control-operation failure; :86 toasts only resume budget refusal, so other stop/close/delete errors have no user-facing reason despite the unchanged row. |
| Q5-5 | DELIBERATE | packages/desktop/src/renderer/App.tsx:280 documents that the screen shows the reason at :284; main/host-connection.ts:332 updates that status and :271 schedules reconnection, so button catches are not the only error path. |
| Q5-7 | CORRECT | packages/desktop/src/renderer/store/ui.ts:358 updates the visible setting, but :364 drops saveUi failure; :359 sends only each raw patch, so an unrelated later patch does not guarantee persistence of this lost setting. |
| Q6-3 | CORRECT | packages/core/src/mcp/inbox-watch.ts:118 catches map/probe errors and :121/:122 sleeps a fixed pollMs then retries without a cap or outward failure signal; this repeats Q3-1. |
| Q6-5 | DELIBERATE | packages/host/src/telegram/outbox.ts:3 explicitly specifies a queue-wide 429 pause; :59/:60 honors retry_after and :61 exits if the queue is cleared, rather than dropping a rate-limited message as though sent. |
| Q6-7 | CORRECT | packages/host/src/limits/limits-service.ts:250 schedules fixed-interval refreshes; :224/:225 already suppress collection failure with only a host warning, retaining stale state and exposing no refresh-error state to the window. |
| Q6-9 | FALSE | packages/desktop/src/renderer/store/works.ts:178 caps delay, but :192/:193 consumes again before each repair and :171 does not restore it on failure; without another gap there is no endless repair loop at this cited site. |

## Answer Y

| ID | Verdict | Proof |
| --- | --- | --- |
| Q2-1 | CORRECT | packages/core/src/secrets.ts:47 returns {} for corrupt JSON; :127/:129 use it for read-modify-write, replacing salvageable entries with the single newly saved key without exposing corruption. |
| Q1-6 | CORRECT | packages/host/src/consents/consents-service.ts:230 logs action failure after :283 removes holds and :289/:291 starts background continuation and returns applied:true; non-HostError launch failures escape sessions-service.ts:934 notices. |
| Q5-1 | CORRECT | packages/desktop/src/renderer/island/IslandApp.tsx:473 silently drops initial consent-list failure, leaving island cards absent until an event/reconnect; the stronger nowhere claim is limited by the main-window reader at renderer/store/consents.ts:57. |
| Q1-1 | CORRECT | packages/host/src/stuck/stuck-service.ts:123 catches queued report failure with a host log only; :267/:273 do not re-arm failed reporting, so the intended lead/human notification can be lost (the stuck session itself is excluded at :177). |
| Q1-2 | CORRECT | packages/host/src/sessions/sessions-service.ts:484 calls finishExited and :496 only logs failure; core/src/work/launch.ts:908 writes sleeping, while host/src/wake/wake-service.ts:913 refuses mail wake for a still-active map record. |
| Q3-1 | CORRECT | packages/core/src/mcp/inbox-watch.ts:117/:118 suppresses failed map/probe reads, :121/:122 retries on fixed delay forever; mcp/tools.ts:1764/:1777 confirms this watcher drives the advertised channel notifications. |
| Q1-15 | CORRECT | packages/host/src/activity/log-index.ts:325 and :343 supply empty onError callbacks; core/src/watch.ts:137/:139 routes watcher errors/creation failures there and contains no watcher re-creation, so log-based activity can stop advancing silently. |
| Q2-8 | CORRECT | packages/core/src/watch.ts:137 forwards runtime watcher errors only to optional onError, and :139/:141 does the same for creation failure; host/src/activity/log-index.ts:325 discards both, including failures beyond a harmless missing provider directory. |
| Q2-2 | DELIBERATE | packages/core/src/config.ts:464 explicitly specifies replacing corrupt config when saving a setting; :475/:480 implement that policy, while :383/:395 expose parse failure through loadConfig.warning instead of concealing it as a valid configuration. |
| Q1-3 | CORRECT | packages/host/src/sessions/sessions-service.ts:461 logs failed settlement only; core/src/work/resource-policy.ts:211 counts reserved slots, so a failed release can block other launches (successful active evidence is repaired at :190/:262). |
| Q4-1 | CORRECT | packages/desktop/src/main/index.ts:246 logs the actual spawn/entry exception and returns null without reportUnavailable; host-connection.ts:331/:332 later sends only a connection-level reason, losing the useful startup diagnostic. |
| Q4-2 | CORRECT | packages/desktop/src/main/host-connection.ts:214/:215 only logs spawn callback rejection and :219 clears spawning; :331/:332 supplies a later generic connection error rather than that exception to the window. |
| Q1-4 | CORRECT | packages/host/src/sessions/sessions-service.ts:1375 only logs resume rejection and :1380 removes the requested interrupted refs; non-HostError failures bypass the separate notice at :934, although HostError failures do get a notice. |
| Q1-8 | CORRECT | packages/host/src/compaction/compaction-service.ts:198 only logs unexpected job rejection and :201 clears running status; the explicit notices at :175/:179 cover non-submission/timeout, not every thrown exclusive/run failure. |
| Q1-11 | CORRECT | packages/host/src/hooks/hook-server.ts:299/:300 installs a post-listen log-only error handler with no window notice or listener recovery; the error is hidden, although an error event alone does not prove permanent listener death. |
| Q1-14 | FALSE | packages/host/src/assistant/reminders.ts:34 sets MAX_RETRIES=12 and :175/:182 increments and drops after the cap; :204 schedules a delay, not an uncapped busy/not-ready retry loop. |
| Q1-18 | CORRECT | packages/host/src/host.ts:830 only logs collectInterrupted rejection and then :835 marks works ready; sessions/sessions-service.ts:471 initializes interruptedRefs empty, so collection failure can suppress the interrupted banner. |
| Q1-21 | CORRECT | packages/host/src/wake/wake-service.ts:1075 starts recipe delivery and :1076 only logs rejection; :1079 clears its in-flight marker without any failure notice or agent result. |
| Q1-24 | DELIBERATE | packages/host/src/providers/auth-service.ts:240/:242 explicitly chooses preserved prior status or first-check signedIn:false for the Sign-in fallback; :245 expires that fallback immediately so the next check retries without the normal cache delay. |
| Q2-4 | DELIBERATE | packages/core/src/work/lease.ts:36 defines null as unknown tenant; :79/:80 uses it conservatively to skip lease-file cleanup, and :4 states the former hostLeaseActive launch consumer is unused, so no live takeover consequence is established. |
| Q2-7 | CORRECT | packages/core/src/custom-providers.ts:196 maps all file read/parse failures to [], indistinguishable from no custom providers; host/src/methods/custom-providers.ts:110/:127 also makes a later add destructive, beyond a harmless absent-file default. |
| Q2-11 | FALSE | packages/core/src/assistant/stream.ts:46 does substitute {}, but this parses CLI output; host/src/assistant/assistant-service.ts:484/:490 uses the event only to publish tool display detail, not to execute a tool with those arguments. |
| Q3-2 | CORRECT | packages/protocol/src/framing.ts:65 JSON.parse throws on a malformed line; host/src/server.ts:71/:76 rethrows non-LineTooLongError from the socket callback, with no host/core uncaught-exception handler; the window receives disconnection, not the decoding cause. |
| Q3-5 | DELIBERATE | packages/core/src/mcp/tools.ts:798 explicitly calls the wait journal best-effort; :812 suppresses append failure because the journal is a window hint and the actual wait_for result does not depend on it. |
| Q4-4 | DELIBERATE | packages/desktop/src/main/quit-guard.ts:55 logs final shutdown-cleanup failure; main/host-connection.ts:687 documents ignored shutdown-response errors and :701/:702 escalates process termination, so the catch alone does not establish an abandoned live host. |
| Q4-7 | DELIBERATE | packages/desktop/src/main/ipc.ts:828 omits receiptError from the UI, but core/src/work/parley-md.ts:281/:287 retains a durable reservation after actual file creation; :207 explicitly makes this conservative auxiliary accounting, so created remains truthful. |
| Q4-10 | DELIBERATE | packages/desktop/src/main/update-check.ts:243 documents non-throwing background checks; :249 retains an already discovered update and :253 suppresses optional polling failure rather than falsely reporting a successful download or installation. |
| Q5-2 | FALSE | packages/desktop/src/renderer/App.tsx:250 lacks a promise catch, but main/host-connection.ts:623/:332 propagates connection failure into host status, main/ipc.ts:1094 sends it to the window and App.tsx:284 renders its reason; nothing/no text is false. |
| Q5-5 | CORRECT | packages/desktop/src/renderer/layout/persistence.ts:173/:174 converts restore rejection to emptyLayout, then :180 hydrates that empty state without a load-error indicator, making a saved layout appear absent. |
| Q5-8 | FALSE | packages/desktop/src/renderer/store/works.ts:192 requires again and :193 resets it before repair; :171/:178 only installs a timer and does not re-arm again, so a lone failed repair does not produce the claimed endless retries. |
| Q5-11 | CORRECT | packages/desktop/src/renderer/update/update-notice.ts:50 persists dismissal before openExternal; :53 only warns on open failure and :41 suppresses that version thereafter, so failed opening also removes the offer. |
| Q5-14 | DELIBERATE | packages/desktop/src/renderer/browser/panel/agent-registry.ts:39 rolls back failed registration, :53 resets failed hello state and :110/:112 resubmits forgotten page reports on sync; the documented auxiliary registration contract avoids falsely retaining successful registration. |
| Q5-17 | FALSE | packages/desktop/src/renderer/voice/downloads-store.ts:67 maps rejected IPC to a generic error, but :76 shows a failure toast; shared/strings.ts:2593 says Download failed, so the user sees neither success nor the claimed network diagnosis. |

## Totals

| Answer | Checked | CORRECT | DELIBERATE | FALSE |
| --- | ---: | ---: | ---: | ---: |
| X | 36 | 23 | 9 | 4 |
| Y | 33 | 20 | 8 | 5 |

## Q7 harm-ranking notes

These assess whether each harm belongs at roughly its stated place, not whether there is a uniquely correct ordering. Ranking notes are separate from factual verdicts; a plausible harm can remain important even when its submitted retry mechanism is wrong.

### Answer X

| Rank / ID | Reasonable? | Note |
| --- | --- | --- |
| 1. Q5-1 | yes | A failed Stop can leave file changes and token spending underway; loss of human control reasonably ranks first (ChatView.tsx:392). |
| 2. Q1-1 / Q6-1 | yes | A log-only failure recurring in the autonomous cycle can stall an entire active plan (autonomous-engine.ts:1111/:1134; host.ts:400). |
| 3. Q1-2 | yes | Persistent work-watch read failures make workspace-wide decisions rely on old state (works-service.ts:890; core/work/works.ts:267). |
| 4. Q1-3 | yes | Removing interrupted refs after a non-HostError launch failure can hide unfinished recovery; HostError does have a separate notice (sessions-service.ts:934/:1375). |
| 5. Q2-1 | yes | Silent destructive read-modify-write of other provider secrets belongs among the most harmful, even if it could reasonably rank higher (secrets.ts:127). |
| 6. Q2-2 | yes | A read failure followed by replacement can erase several configured providers and disrupt subsequent launches (custom-providers.ts:196; methods/custom-providers.ts:127). |
| 7. Q3-1 | yes | Persistent watcher errors remove the channel notification mechanism without telling the agent, delaying collaborative work (inbox-watch.ts:118). |
| 8. Q1-5 / Q1-6 / Q1-7 | yes | Lost, consumed or unpersisted reminders break promised future work; grouping these related paths is reasonable (reminders.ts:112/:168/:183). |
| 9. Q4-1 | yes | Startup failure blocks the app and losing its concrete cause impedes repair; the harm is missing diagnosis, since disconnected is still shown (main/index.ts:246; host-connection.ts:332). |
| 10. Q5-2 | yes | Missing room letters is substantial enough for the list, but the claimed perpetual automatic repair loop is false; this ranking does not validate that mechanism (store/works.ts:173/:192). |

### Answer Y

| Rank / ID | Reasonable? | Note |
| --- | --- | --- |
| 1. Q2-1 | yes | Destructive overwrite of other stored secrets is a defensible first priority (secrets.ts:47/:127). |
| 2. Q1-6 | yes | Successful consent followed by a swallowed non-HostError continuation failure leaves the workflow abandoned after apparent acceptance (consents-service.ts:230/:291). |
| 3. Q5-1 | no | The missing island card is real, but third place relies on appears nowhere: the main window separately loads consent cards and Chat/Terminal can show Waiting for folder trust (store/consents.ts:57/:93; ChatView.tsx:405). |
| 4. Q1-1 | yes | Losing the lead/human stuck report can strand coordinated work; the stuck session itself is deliberately not a recipient, contrary to the wording (stuck-service.ts:177/:227). |
| 5. Q1-2 | yes | A dead process retained as active can suppress mail-driven resume and stall the task (sessions-service.ts:496; wake-service.ts:913). |
| 6. Q3-1 | yes | An unreported persistent failure in channel mail discovery can indefinitely delay agent replies (inbox-watch.ts:117/:121). |
| 7. Q1-15 / Q2-8 | yes | A silently dead log watcher compromises activity/usage visibility across sessions; retry-on-next-event does not recreate a failed watcher (watch.ts:137; log-index.ts:325). |
| 8. Q2-2 | no | The scenario is explicitly documented corrupt-config recovery and loadConfig already returns a parse warning; it is not a leading silent-failure defect (config.ts:383/:464). |
| 9. Q1-3 | yes | A failed release can retain capacity and block other launches; this is narrower than all unsettled reservations, since active evidence repairs spent launches (resource-policy.ts:190/:211/:262). |
| 10. Q4-1 / Q4-2 | yes | A missing startup diagnostic can make a completely unusable app harder to repair, although connection failure itself is visible and the two IDs describe overlapping paths (main/index.ts:246; host-connection.ts:215/:332). |
