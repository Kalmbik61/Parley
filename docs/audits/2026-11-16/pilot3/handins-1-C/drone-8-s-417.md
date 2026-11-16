<!-- drone 8 s-417 model=haiku addedAt=2026-11-16T17:28:34.619Z handedAt=2026-11-16T17:32:47.616Z result=done -->
Drone D2 (s-417), Parley @9eabc014, copy /Users/kalmbik61/parley/pilot3-subject. Read only. Paths are relative to the copy root.

Q13. Which needs are reported at once, which wait, and where the wait comes from
- Wait source: host.ts:471-472 creates `createStuckService(..., { reportMs: stuckReportFromEnv(process.env) })`. Inside, `reportMs = options.reportMs ?? STUCK_REPORT_MS` (stuck-service.ts:118). STUCK_REPORT_MS = 120_000 (core packages/core/src/work/stuck.ts:34).
- PARLEY_STUCK_REPORT_MS is wired: stuckReportFromEnv (stuck-service.ts:66-71) calls envValue(env,'STUCK_REPORT_MS') (core packages/core/src/names.ts:56-61). That checks PARLEY_ (ENV_PREFIX, names.ts:31) first, then HARNAS_ (names.ts:32). It accepts an integer from 100 to 600000. Anything else gives undefined, which means the default.
- Reported at once (IMMEDIATE = limit, sign-in, startup; stuck-service.ts:74): open() calls report() directly (stuck-service.ts:285-287).
- Waiting (approval, question; stuck-service.ts:76 WAITING): open() arms a timer for reportMs (stuck-service.ts:289-293). When it fires it reports the episode's current need, if the episode is still the same (289-292). startup is in WAITING too, so an approval or question episode turning into startup keeps its existing timer and is not reported at once (sameEpisode, stuck-service.ts:78, 324-329).
- If the episode ends before the timer fires: finish() clears the timer (267), told === null, so nothing is written, no line and no letter.
- Episode end and "back" (finish, stuck-service.ts:266-280): the line and letter are written only if told !== null (270), not silent (274), and session.lifecycle === 'active' (274). silent is true when the kind changes (325) or on the first reconcile after host start (308-317, 319). post() (209-221) returns before anything is written if the room is archived (212). That suppresses both the line and the letters. Without a room, no line is written but the letters still go out (216-220).
- Back letter: only when IMMEDIATE.has(told.kind), i.e. limit, sign-in, startup (277). approval and question get a back line in the room but no back letter.
- Also: report() always produces a letter (stuck-service.ts:243-247, stuckLetter returns a string for every kind). So approval and question get a letter at report time after 120 s, but no letter at back time.

Predecessor claims, Q13:
- IMMEDIATE = {limit, sign-in, startup}, SV:74: confirmed.
- open() at once 285-287, else timer 289-293: confirmed.
- STUCK_REPORT_MS 120000 at SV:118 and stuck.ts:34: confirmed (stuck-service.ts:118 is the use, stuck.ts:34 the constant).
- env SV:62-71: confirmed.
- Back line from finish() 266-280 when told !== null, not silent, lifecycle active, room not archived (post 212): confirmed. Correction: an archived room also suppresses the back letters, because post() returns before the letters loop.
- Back letter only if IMMEDIATE.has(told.kind) (277): confirmed.

Q15. Structural flag and how letter-only writes reach subscribers, windows with rooms-mail, and windows without rooms-mail
Structural flag (core packages/core/src/work/store.ts):
- Full path, store.ts:1230: structural = diff.upserts.length>0 || diff.deletes.length>0 || diff.workChanged. workChanged = previous.work !== next.work || extra (packages/core/src/work/map-rows.ts:256). work is JSON.stringify(map.work) (map-rows.ts:191). It is computed before touch (the updatedAt shift is at store.ts:1239-1242), so a bare updatedAt change is not structural.
- Fast path for letters-only writes with a clean cache, store.ts:1171: structural = JSON.stringify(hit.map.work) !== hit.work, also before touch.
- Letter writes change map.work only in deleteRoom: letter-tables.ts:666-669 sets messageSeq, letter-store.ts:288-291 too. LetterTx.add reads messageSeq (letter-tables.ts:541) but does not write it. So plain letter adds are not structural. A write that deletes a room's letters IS structural.
- The event is emitted with structural at store.ts:1280 and 1316. The field is defined at store.ts:553.
- works.ts:303: watchWorks ignores a write with structural === false unless unseen. It does not call schedule, so no refreshPass runs.
Paths (packages/host/src/works/works-service.ts unless stated):
(a) The host's own mail subscribers: onWritten (840-892) calls notify(mail) synchronously for a non-structural write (889; notify at 694-702). If pendingStructural is set, batch.structuralVersion is raised (887-888), but the notify still happens immediately. Structural writes go into batch.notices (883) and are delivered later, in flushMail (805) or at the end of refreshPass (1219-1222), after the snapshot. Subscribers registered by onMail: activity/activity-service.ts:1901, agent/tool-context.ts:37, wake/wake-service.ts:1961, telegram/service.ts:1380 (handler 924), rooms/history-service.ts:200. I did not read their handler bodies.
(b) Windows with rooms-mail: the batch goes out through the timer armed by armBatch (895-911). Delay = mailBatchMs = MAIL_BATCH_MS = 50 ms (mail.ts:32; default at works-service.ts:207). The timer is armed by the first write of the batch and is not restarted (896), so later letters ride along and nothing waits longer than 50 ms. flushMail (801-823) calls refreshEntry and then sendMail (761-777). sendMail sends to isMailClient clients: buildMailEvent (mail.ts:202) reads one snapshot, fitMailEvent caps the frame at 256 KiB (mail.ts:34, 312), and slow clients get gluedMailEvent (mail.ts:381; WS:775).
(c) Windows without rooms-mail: flushMail line 816 calls publish(lacksMail) only if refreshEntry returned true. publish (476-519) sends works.changed via broadcastWorks (457-461) to toCompact and toLegacy windows. refreshEntry (727-758) returns true only when current.version is defined, current.version < batch.version, prevVersion and structuralVersion are not ahead of it, and the identity check passes. It also rebuilds the window snapshot (754-755).
  refreshEntry false (returns at 732, 735, 739, 743, 747): no works.changed goes out, and entries is not updated. Nothing re-triggers a pass: scheduleRefresh callers are 855 (incarnation change), 1027 (watcher onWorks), 1121 and 1165/1168 (sync retry). A letter-only write does not wake the watcher. So the window learns at the next full refresh, which is the next structural write, a foreign write, or a version-less watcher read. I did not find a periodic full pass, but I did not prove there is none.
Longer waits:
- A batch with structuralVersion > 0 (a structural write in it, pendingStructural from earlier at 887-888, or a foreign write at holdForeign 958-971) is held until releaseMail after the snapshot publish (826-837). The timer is re-armed for MAIL_HOLD_MAX_MS - elapsed (901-909). The hard cap is 2000 ms from the batch start (mail.ts:42). Letter-only writes that join such a batch wait too.

Predecessor claims, Q15:
- structural flag at store.ts:1230, 1280, 1316, 553: confirmed. Missing: the fast path at 1171.
- onWritten WS:840-892: confirmed.
- (a) notify sync WS:883-890, 694-702: confirmed.
- (b) joinBatch mail.ts:108-117, armBatch WS:895-911, MAIL_BATCH_MS 50 (mail.ts:32), timer not restarted at 896, flushMail 801-823, sendMail 761-777, 256 KiB: confirmed.
- (c) works.changed only if refreshEntry true (WS:816, publish 476-519): confirmed.
- refreshEntry false at 732-744: corrected. The function spans 727-758; the false returns are at 732, 735, 739, 743, 747.
- cap 2000 ms, mail.ts:42, armBatch 901-909: confirmed.

Q16. Paged sync for desktop windows: reset vs delta on a pull without a cursor; floor, epoch, and client effects (packages/host/src/works/works-sync.ts = SY)
Reset condition, SY:319: reset = base === 0 || !reader.completed || base < this.floor || base > this.revision. The transaction then becomes {mode: reset?'reset':'delta', base: reset?0:base, target: revision} (SY:320). Otherwise the delta streams records with revision > base (SY:324). pull without cursor → start(), SY:396. Desktop sends base = forceReset ? 0 : view.revision (desktop packages/desktop/src/main/works-sync.ts:473). forceReset comes from the reset flag, which is set by invalidate on an epoch change (353-361), by failed() (537-545), and by retry().
reader.completed is set true only on a commit, i.e. the last page (SY:414), and set to false on epoch change (SY:245) or for a new reader (SY:282).
Floor moves (SY:211-218), only in publications with changed = true (SY:158 sets changed = upserts.length>0, so any upsert publication counts as a commit):
- Journal eviction when there are more than WORKS_SYNC_JOURNAL_COMMITS = 256 commits (packages/protocol/src/works-sync.ts:32) or more than WORKS_SYNC_JOURNAL_BYTES = 4 MiB (protocol:34). floor = max(floor, oldest.revision) (SY:214-215).
- floor = nextRevision on key reorder (deltaOrder check, SY:207-209) or on retire (SY:217).
- floor is then used by rows.prune(floor) (SY:221) and to drop old deletes and branch deletes (SY:225-226). Initial floor is 0 (SY:83). Grep: no other assignment to floor in the file.
Epoch change:
- nextEpoch = retire ? randomUUID() : this.epoch (SY:176). retire = a committed key left the catalogue, or changedLife (incarnation changed) (SY:165). A reorder moves only the floor, not the epoch. Epoch initial value: SY:61-62.
- Applied at SY:241-249 on retire: pins forgotten (243-244, forget without the expired flag), readers notified = false and completed = false (245), transfers, expired and mailExpired cleared (246), cache replaced (247), currentEpoch = nextEpoch (248). SY:264 drops transfers whose target is not the new revision.
Effects on clients:
- Host: a pull without a cursor after the epoch change → reset (completed false, SY:319). A pull with an old cursor → the pin is gone → repair 'cursor-unknown' (SY:391-392; 'cursor-expired' only if the expired map holds it for this client), and repair returns reset-required (SY:420-423).
- works.invalidated {epoch, revision} (SY:269-276) goes to each client with notified = false after EVERY changed publication, not only on epoch change. notified is reset to false at each pull start (SY:342).
- Desktop: invalidate with a different epoch sets reset = true (desktop:353-361). The next pull then uses base 0 (desktop:473), which gives a reset on the host.
- Desktop on reset-required: failed('reset-required') (desktop:480 → 537-545). It sets reset = true and retries after min(250·2^n, 5000) ms.
- A floor move alone, without an epoch change: a client with base < floor gets a reset transaction (SY:319-320). The desktop applies it normally (desktop:502-503, 514), so it is not an error.

Predecessor claims, Q16:
- start() 311-320 and the reset formula at 319: confirmed.
- Floor at 214-215 and 217; WORKS_SYNC constants at protocol:32, 34: confirmed.
- Epoch at 176 and retire at 165: confirmed.
- Effects 241-249 and 264: confirmed.
- works.invalidated 269-276: confirmed, but the scope is corrected. It is sent after every changed publication, not only on an epoch change.
- cursor-unknown 391-392: confirmed.
- Desktop 353-361 and 473: confirmed.

Open:
1. Q15 (c): I did not exhaustively prove that no periodic or other full pass exists. So what makes a window without rooms-mail catch up after refreshEntry false is only partly established.
2. The handler bodies of the mail subscribers (activity, tool-context, wake, telegram, history) are not read.
3. Whether the host overrides mailBatchMs (works-service.ts:99-103 says it is for tests) is not checked in host.ts.
4. works-sync.ts lines 1-119 and 420-564 are not read in full (I checked them with greps for floor and epoch only). The record-level delta (rows.records) is not read. The desktop reset application is checked only for mode.

Coverage: partial. Read in full: stuck-service.ts, core stuck.ts, mail.ts, works-service.ts (whole file, 1291 lines). Read in part: works-sync.ts 120-420, works.ts 215-330, store.ts 536-560, 1050-1100, 1136-1320, letter-tables.ts 530-560 and 655-680, letter-store.ts 280-300, map-rows.ts 191-256, names.ts 31-82, desktop works-sync.ts 340-372, 462-480, 537-551.