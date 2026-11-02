# Bounded window synchronisation

Status: conditional design PASS relayed by the lead (m-2338); the human requested
implementation-task creation using the test1 subscription / Sonnet (s-203/m-2366) and then
continued both executor sessions on GLM `glm-5.3[1m]` (m-2382/m-2384); all implementation,
including P5, now runs on GLM. This
documentation handoff is not authorization to code: each item awaits formal verified-room
plan acceptance and an accepted scoped assignment. It does not authorize capability
activation or waive performance regressions. Historical M1–M4 are evidence, not production
behaviour. Implementation has not started.

Handoff (2026-11-01): implementation/test-fixture sessions s-212 and s-213 were created on
provider `custom-test1`, model `oauth/pereverzev/claude-sonnet-4-5-20250929`; at 16:16Z the
human replaced test1 and both sessions continue on GLM `glm-5.3[1m]` (m-2381–m-2384). Senior
Codex leads and reviews, and s-211 independently verifies every accepted item in r-20. The
human's provider choice overrides older Codex-only and senior-only P5 implementation wording.
Base: `33e3761b` (`origin/master`). Incident: backlog b-019.

### Open performance decision and provenance

The human's wording is «исключить повторение без ущерба для производительности».
The payload/extra-serialization/ELD gates in s-38/m-2225 are the lead's operationalization
of that request, not a verbatim human quotation. Unconditional CPU parity for every dense
all-row rewrite was added during review; it is not an explicit human requirement. The
human's acceptable performance criterion remains pending; no CPU waiver is implied.

Lead evidence is the final **128 KiB native-page run**, not the preliminary eight-sample
M4 diagnosis: `docs/research/2026-11-01-window-snapshot-native-eld-m4.md`, five alternating
pairs, 100 measured calls per path/case. Dense process CPU p50 is **39.155 → 50.803 ms**
(about 30% higher); host ELD p95 **52.560 → 6.320 ms**, max **89.326 → 55.312 ms**;
the worst candidate synchronous slice is **52.902 ms**. Task/status CPU is about 9 ms
p50 and host ELD p95 below 4.9 ms. The 4 ms target is not a hard bound. These pipeline
numbers exclude real renderer parse/IPC and cold bootstrap; retained-result memory and
uncontrolled GC/scheduling may affect tails without an isolated attribution.

The earlier eight-sample M4 native-array diagnostic found dense CPU 47.081 vs 38.347 ms
and subsequent sparse CPU 8.971 vs 35.669 ms. Its evolving dense→nochange→edit follow-up
encoded 3,000→0→1 rows. Keep those historical results separate from the final run; they
are not a production performance pass or measurements of a cold bootstrap.

Recommend **512 KiB as the planned candidate**, following s-38's recommendation; the
human has not selected or production-validated that constant. **128 KiB is a fallback
only if verified by the same P7 acceptance**, not an automatic safe/pass choice. The
separate n=8 paired same-candidate diagnostic found dense CPU p50 **45.599→32.634 ms**
and **215→54 pages**, with mixed/noisy ELD: dense p95 4.846→5.034 ms, max 5.366→5.190 ms,
worst slice 4.935→5.168 ms; sparse max 4.145→4.485 ms. Sparse remained 8,919 bytes.
The earlier conservative diagnostic recommendation to keep 128 is historical evidence;
this plan recommends 512 for measured review without claiming no delay tradeoff. Never
claim parity against another run's roughly 39 ms reference or infer consumer/cold-start
latency from page count. Detailed history remains in
`docs/research/2026-11-01-window-snapshot-budget-diagnostic-m4.md`.

Lean text previews remain out of scope. Conditional design PASS is not a dense-CPU waiver.
The human requested implementation-task creation and selected the implementer provider;
this documentation-only handoff is not an accepted implementation assignment. P7 must
resolve any material performance regression before acceptance. No additional prototype
benchmark work is authorized by this documentation task.

Dense-case applicability (code evidence, frequency not measured):

- The synthetic `allChanged` case replaces every session's task text in an already
  populated cache. No normal production command that rewrites every stored task on each
  ordinary update was found in the inspected paths. It is a stress workload, not a
  measured user traffic mix.
- Initial connection, host restart and a reset after expired history must transfer all
  visible rows. They have similar output volume, but M4 starts from a warm cache and is
  **not** a cold-bootstrap timing. T4 must measure those separately.
- `reconcileMap` (`core/work/liveness.ts:193`) may change a batch of active/sleeping
  sessions after process loss/revival. It changes only affected sessions; it does not
  rewrite every task. Host reconciliation runs at start and watcher passes, not a timer.
- Archive/reopen (`core/work/store.ts:1157`) changes only `work.status`; it is not an
  all-session update. `replaceStoredMap` at line 586 is explicitly a test helper and
  must not be cited as a normal import or recovery trigger.
- Old-schema normalization traverses sessions (`core/work/map.ts:603`), but this is not
  evidence of routine all-row changes between live published revisions.

Thus no empirical "once per N minutes" or dense-update percentage is available. Any
description of it as rare is an inference from these code paths, not measured frequency.

## Goal and evidence

Adding workspaces, archived workspaces or sessions must never silently stop the window's
updates. Keep the current 8 MiB framing protection. No deletion, restart, archive operation
or larger global snapshot limit is part of the remedy.

`works-service.ts:290–320` sums cached per-work JSON sizes, retries a compact variant and
returns null above 5 MiB. `publish()` then omits `works.changed`, but still updates
`published` and releases mixed mail. `works.list` returns an error instead of data.
`works-service.window.test.ts` explicitly expects zero change events after overflow.
Archiving removes message tails only; `mailWorkMap` already has no tails, while archived
sessions, rooms and plans remain. Thus archive-only stubs and shorter text merely move the
failure threshold. Splitting by work without paging leaves the same failure for one large work.

Baseline evidence: `docs/research/data/window-snapshot-bench.json`, generated on Node
22.23.3 / Apple M4 Pro, 5 warmups, 30 pipeline samples and 15 measured real-service
changes per scenario. The service run uses real SQLite, watchers and core projections
with three fake clients (mail, compact, legacy); it excludes socket/IPC/renderer cost.
Pipeline payloads use a fixed synthetic project path, so service bytes differ slightly.

| Fixture | Compact snapshot bytes | Old 5 MiB gate | Hypothetical single-row frame |
|---|---:|---|---:|
| 2 works, 20 sessions | 176,413 | passes | 8,828 B |
| 30 works, 1,000 sessions, 20 archived | 8,766,319 | drops all 15 updates | 8,819 B |
| 30 works, 3,000 sessions, 20 archived | 26,260,933 | drops all 15 updates | 8,819 B |
| 1 work, 3,000 sessions | 26,251,105 | drops all 15 updates | 8,825 B |
| 30 works, 3,000 sessions, 80-byte texts | 1,785,104 | passes | 671 B |

The first four fixtures have 4 KiB task and summary per session. Fallback has identical
bytes because these fields are already at its 4 KiB limit. One work alone can be 26 MB;
per-work framing without internal pages therefore cannot solve the problem. A transport
experiment packing session rows into 128 KiB frames peaks at 122,751 B across these
fixtures. This excludes other work metadata and is evidence for feasibility, not proof
that the proposed complete protocol meets the bound.

Baseline write-to-broadcast p95 on supported fixtures is 92.395 ms (small) and 90.497 ms
(short-text 3k); over-limit fixtures have no broadcast latency because none arrived.
These are mixed-client end-to-broadcast timings, not isolated publish CPU. The initial
corrected one-row experiment exposes a regression: on one 3k-session work the candidate
costs CPU p50/p95 53.174/54.524 ms versus 33.263/34.670 ms; active ELD p95 is 55.280
versus 34.079 ms. Projection alone is p50/p95 2.854/3.478 ms. Serialising every row and
then comparing encoded text is rejected. M2 measures structural comparison before
encoding and retaining equal-row encodings in that historical experiment. That cache
policy is superseded for the prepared candidate below; production remains unapproved.
Projection/comparison/encoding still require cooperative slices. No production head
performance is claimed by either benchmark.

M2 (`docs/research/2026-11-01-window-snapshot-structural-m2.md`) confirms the corrected
comparison helps sparse changes: one-work/3k task edit process CPU p50/p95 is
39.272/45.868 → 8.374/10.104 ms; active ELD p95 is 47.514 → 10.420 ms.
However its allchanged candidate serialises every changed row twice (cached row JSON and
a second object-based envelope), and regresses 37.933/41.486 → 80.568/111.046 ms. The base
also serialises rows twice; M2 does not isolate repeated encoding as the sole cause.
Per-row overhead, comparison and allocation can contribute and must be measured.
It also emits an oversized single allchanged frame. Historical M3 then measured verbatim
cached-row packing into actual bounded frames, but dense CPU still regressed. M4 attributed
the dominant cost to individual row stringification and tested native bounded-array
encoding with immutable projected objects instead. These experiments are complete as
evidence for the conditionally reviewed candidate below, not execution/performance
approval. Task reviews and P7 acceptance remain required.
Small-fixture ELD near the 1 ms timer floor proves no universal non-regression. Preserve
all original M1–M4 research notes/JSON; this reconciliation does not rewrite their results.

## Planned candidate boundary (execution not authorized)

Negotiate a new `works-sync` capability. Current window clients use a paged bootstrap and
versioned **collection-row deltas**; unchanged works and unchanged rows never cross the
wire again for a structural change elsewhere. Keep the existing `mailWorkMap` projection
and `rooms.mail` path. Compare each changed work's projected row objects against immutable
cached previous objects before encoding. In delta generation, equal rows cause no encoding;
encode changed objects in bounded native arrays, with explicit removals. Ordinary changed
rows are serialized once in their successful page; overflow/fragment retries may serialize
again and all such work is counted. Eager per-row JSON strings or record-size caches are
not obligations. Reuse bounded encoded-page payloads across subscribers while resident.
This is keyed row replacement, not arbitrary JSON-path patching. A one-session update
in a single enormous work must not resend that entire work with additional page envelopes.

The existing core change event identifies a work and a structural boolean, not changed
session/room IDs; foreign writes are detected by work version. Therefore projection and
row comparison remain O(size of the changed work), with no claim of O(changed rows) CPU.
Avoid database/journal redesign here. Wire and secondary encoding costs scale with changed
rows and counted bounded retries. Unchanged works retain their immutable projection;
there is no mandatory eager per-row encoded cache.

Equality is a correctness boundary: equal rows must decode to the same JSON value;
false negatives only cost extra transmission, false positives silently lose updates.
Use JSON-compatible own-property data and an exact structural comparator. Cached rows
must be independent of mutable service maps; mutation-after-publication and frozen-cache
tests guard this. Never rely on object identity for rows reconstructed from database reads.
Persistent projected objects are O(current map size), like the existing projection cache.
`WORKS_SYNC_ENCODED_CACHE_BYTES` bounds additional reusable encoded pages, not logical
row objects or map size. No eager per-row JSON/size cache is required; optional lazy
encodings must expose their deferred CPU and retained memory if a consumer needs them.
M3 records UTF-8 encoding payload sizes and unforced-GC process heap/RSS observations,
not isolated retained-heap cost; native-object cache overhead remains unmeasured. P7 must
report actual memory alongside CPU, completion, loop delay and subsequent sparse work.

There is no total workspace-byte acceptance threshold on this path. Bound individual
messages, work per event-loop slice, pending transfers and retained generations instead.
All works, including archives, remain discoverable and usable. Archive-on-demand stubs
are deferred: they would change many selectors, root authorisation, restored tabs and
island behaviour, and they do not solve growth of a single active work.

## Prepared wire and cache contract

1. A small `works.invalidated { epoch, revision }` announces a newer structural view.
   Sync has a separate structural revision: mail-only `refreshEntry()` increments the
   existing work/mail revision but MUST NOT invalidate sync or send structural pages.
   `rooms.mail` continues to carry mail-only progress. When only sync clients connect,
   `publish()` does not run either global `buildWindow` or legacy encoding.
   A connection runs one `works.sync` pull at a time; newer invalidations coalesce to a
   wanted revision, never an unbounded event queue. Initial connection pulls immediately.
2. `works.sync` starts a reset or delta transaction from the client's applied structural
   revision. An opaque, client-bound cursor then pulls bounded pages. A transaction pins
   immutable projected work references at a target revision. Changes during reading do
   not restart it: finish that generation, then fetch the coalesced newer generation.
3. Reset pages enumerate the full work catalogue, project branches and complete work
   rows. Delta pages carry row upserts/removals, deleted work keys and
   changed/deleted project branches. A commit page includes epoch and target revision.
   The cursor must not contain arbitrary filesystem paths or accept another client's pin.
4. Page records contain work metadata and collection items (sessions, rooms, plans,
   deleted-session IDs and other existing map fields). Ordering and optional-field
   semantics round-trip exactly. Encode bounded native object arrays and validate actual
   UTF-8 response bytes, including the complete runtime RPC id/envelope, sequence/cursor
   metadata, escaping, separators and newline. Overflow retries split only the bounded
   batch, count every rejected encoding and never reserialize the whole collection.
   Named collections use stable IDs; lists without IDs use explicit
   section replacement records, paged by index. Array order is explicit: unchanged
   order sends nothing, insertion/deletion/reorder updates the affected section's order
   vector in bounded pages. Work metadata/status changes are upserts (archive is not a
   deletion). A single record larger than a page uses ordered UTF-8-safe JSON-text
   fragments with counted escaped bytes and the complete RPC envelope. Native prototypes
   rejected such a row; production MUST fragment and round-trip it, never inherit that
   prototype rejection or drop a row. Fragment retry work is counted. Never solve an
   oversized collection by dropping entities or emitting a fake empty list.
   Accepted `pl-03` revision 2 repairs two representation gaps without changing historical
   P1 verification: `section-fragment { key, field, element, index, text, final }` addresses
   only one absolute unnamed-section element; its final marker completes that element,
   while a separate final `section` establishes the exact section length (including an
   empty closing slice after a fragmented final element). `order-slice { key, field,
   start, ids, final }` transmits bounded order chunks; final establishes exact vector
   length. Validate contiguous zero-based coverage, no overlap/duplicate ranges or IDs,
   all referenced IDs present after upserts/removals, and no mixing whole `order` with
   slices. Reserve/check incoming indices incrementally; later fragment pieces consult the
   reserved element directly instead of rescanning earlier slices. Operation counts must
   grow near-linearly with slice count. Reject invalid/incomplete input atomically, retaining
   the old view. Field
   removal resets prior staging before a representation change.
   Shared browser-safe `worksSyncNamedRows` classifies only nonempty arrays with unique
   own safe string IDs of at most 128 UTF-16 units; all other id-shaped arrays use indexed
   sections, preserving their original IDs as values. Build bounded sections/order slices
   from the outset, fragment only the oversized element, and never stringify the surrounding
   aggregate list/vector to split it. Independent s211 review precedes host/main adoption.
   Individual huge-element assembly/parse remains subject to P7; this is no timing waiver.
5. Cache immutable projected objects by project/work/version; build only changed works.
   Reuse encoded page payloads across subscribers within the bounded page cache; dynamic
   per-client envelopes are checked separately against the final frame bound. Eviction
   permits on-demand page regeneration with measured costs, not an unbounded eager row
   encoding cache. Budget checking must not stringify the whole workspace. Yield between
   native page construction/encoding batches. No synchronous loop writes all pages to a socket. Reads use pull flow control; no page is pushed over a
   socket already above its watermark.
   Actual RPC integration needs a trusted host-internal prepared result: current
   `server.ts` otherwise re-encodes `client.send({id,result})`, then slow logging may
   encode the result again. A runtime-private brand carries immutable data, JSON and
   its measured bytes from the page encoder; server adds only the small response-id
   envelope, validates the final bound and writes through sendLine. Slow logs reuse
   the byte count. A false sendLine return is backpressure after a possible write,
   never permission to retry that response. Ordinary methods keep their existing path.
6. Keep one applied view and one in-flight transaction per connection. Work references
   shared with the existing cache are not copied per client. Bound extra retained encoded
   pages; generate pages on demand instead of caching the entire aggregate encoding.
   Disconnect disposes pins. Expired/evicted cursors return a typed reset-required result;
   the window retains its prior view visibly stale and starts a fresh paged bootstrap.
   A reset cannot be rejected because its aggregate bytes exceed a transport budget.
7. Track `lastStructuralRevision` for each work, keyed row changes and deleted work/row
   tombstones in a bounded revision journal. Keep at most 256 structural commits or
   4 MiB of journal metadata (whichever is reached first); a base older than its floor
   or from another epoch starts a reset. Pages of an already pinned transaction survive
   journal eviction. These limits cause repair, never permanent refusal or missing deletes.
   Each live row and section-order vector has `lastChangedRevision`, updated when its
   projected JSON value differs; tombstones retain their removal revision. A delta from base r1
   to target r3 includes every surviving row/order/tombstone changed after r1, not merely
   the r2-to-r3 diff. New sections with no dedicated row schema use explicit section
   replacement; map fields must not disappear when the schema evolves. Use validated
   own-property keys, not executable JSON paths or assignment through prototype keys.

Initial named budgets (performance gates must validate these):

| Constant | Value | Purpose |
|---|---:|---|
| `WORKS_SYNC_PAGE_BYTES` | 512 KiB planned candidate | Full encoded response/event including envelope; 128 KiB only after verified fallback acceptance |
| `WORKS_SYNC_INFLIGHT` | 1 per connection | Pull and IPC backpressure |
| `WORKS_SYNC_SLICE_MS` | 4 ms | Cooperative build/encode scheduling target |
| `WORKS_SYNC_PIN_IDLE_MS` | 30,000 ms | Abandoned cursor cleanup; refreshed by progress |
| `WORKS_SYNC_STALE_MS` | 2,000 ms | Persistent visible lag, not hidden failure |
| `WORKS_SYNC_ENCODED_CACHE_BYTES` | 4 MiB | Extra encoded-page cache, not logical map limit |
| `WORKS_SYNC_JOURNAL_COMMITS` | 256 | Maximum retained structural history |
| `WORKS_SYNC_JOURNAL_BYTES` | 4 MiB | Journal metadata budget; overflow advances reset floor |

The proposed page budget is a maximum byte size, not a measured parser/IPC latency
budget. P7 must measure real Electron renderer parse/fragment assembly and IPC costs at
that explicit cap, including near-cap frames; neither 128 nor 512 KiB has consumer
acceptance yet. The budget does not bound total map size or prove cold-bootstrap speed.

The 4 ms cooperative target covers pure projection traversal, structural comparison,
native array encoding and fragmentation/packing. Capture coherent letter metadata before
yielding pure projection; never keep a SQLite read transaction open across awaits. P2/T1
must observe yields between bounded batches and report maximum slices. Current prototypes
still have uninterruptible projection/batch work and the final 128 run observed a 52.902 ms
slice. Do not attribute that tail to a specific stage without evidence or claim a hard
4 ms guarantee. Measure CPU and completion separately from ELD, record retries and
oversized-row/GC observations; lowering wire bytes or choosing 128 alone is not a pass.

## Consumer and recovery contract

The accepted P3/P6 amendment adds `works.mailState` as an authoritative bounded per-work
mail replacement after every full bootstrap/reset. Its exact wire and validation
contract is frozen in the implementation plan's P3 amendment and
`protocol/src/works-mail-state.ts`. It is a dedicated mail assembler, never a structural
reducer input: one unread scalar summary plus indexed room metadata, sparse unread and
canonical candidate sections, with per-element fragments and atomic completion. Preserve
direct key `''`, empty replacements and unread decreases. Bind all pages to host epoch,
work, coherent mail source version, proven reachable required structural source version,
client and RPC purpose. Unknown coverage must refresh/retry rather than invent a
dependency; errors never masquerade as empty mail. Pins/cache/admission/expiry and actual
RPC frames remain bounded and isolated from structural transfers. Ordinary mail repair
does not project the workspace or invalidate structure. P6 performs bounded durable
reconciliation even with no held events, guards epoch/work lifetime after awaits and
compares dependencies only to the committed structural entry.version. Equal mail versions
may repair counts/removals; older captured mail cannot replace newer held/applied mail.
Ranges for held/open room histories remain a separate repair. Contract review precedes
consumer adoption; default activation remains gated by P7.

The host process epoch is distinct from its increasing structural revision. A client only
commits a transaction with its expected epoch and base revision; duplicate pages are
idempotent, missing/out-of-order pages and incorrect cursors trigger repair. A reset clears
the old epoch only when its complete replacement is ready. Later commits cannot be
overwritten by older RPC responses. `ready` means a complete consistent bootstrap, not
receipt of any first page. Incomplete enumeration must not prune restored tabs.

Desktop main owns the wire pull and sends the same bounded batches to the renderer;
it must not reconstitute and structured-clone the global snapshot on every change.
A shared pure reducer assembles changes in main and renderer. Main's roots registry
uses its local committed view; deletes revoke roots, and pending/stale views cannot
grant new filesystem permissions. Island batches are projected using the existing island
field allowlist before IPC; raw new pages cannot bypass `projectIslandWorks` privacy.
Opening a renderer/island mid-transfer gets a coherent reset plus subsequent commits.

At commit, the renderer updates only affected works and rows and reuses unchanged references.
It retains `withMail`/held messages and the existing distinction between structural
revision and mail version. `rooms.mail` can arrive during paging: gate by each work's
structural version, coalesce overflow into explicit repair, and never silently lose mail
when the current bounded waiting queue evicts an event. A deleted work cancels its
pending pages and mail repair. An archived work remains a normal readable entry.

For sync clients, correctness no longer depends on the host sending all structure before
mixed mail: bounded host mail hold can expire and the client gate is authoritative.
The structural transaction becomes available before its invalidation is emitted; that
invalidation releases the sync delivery path's structural hold, without waiting for an
RPC/commit acknowledgement. Mail's required structural work version travels explicitly
and is compared to the committed structural version, independently of latest mail version.
Add that required-structure field additively to sync-client `rooms.mail`; old clients
and remote retain their existing event semantics. Each structural work commit also names
the source work version at which its compact mail counts were read. If that source version
is older than the client's held mail version, preserve the newer compact counts and
mention candidates already applied by `rooms.mail`, as current `store/works.ts` does.
Use version ordering, never numeric maximum (unread counts can legitimately decrease).
Eviction from either waiting limit sets a durable `repairAllAfterCommit` flag (one boolean,
not an unbounded per-work set); after commit, repair mail counts and held/open room ranges
for the committed works with bounded concurrency. A repair failure keeps that state and
surfaces stale mail until successful retry. Legacy clients retain their existing send-order
semantics. Never wait for a slow sync client before notifying internal onMail consumers.

Desktop window and island expose loading, current, catching-up, and stale/error state.
A new revision marks catching-up immediately; stale means no successful commit for
`WORKS_SYNC_STALE_MS` while wanted exceeds applied after a complete bootstrap.
During initial bootstrap show loading with received-page/row progress; stale means no
page progress for `WORKS_SYNC_STALE_MS`, not total bootstrap time above two seconds.
Continuous successful commits do not restart a flashing stale banner. On stale, failure or invalid cursor,
show a persistent banner with retry and preserve the last good data. Completion clears
it automatically. Session/work deletion and root-sensitive file actions must resolve
against a fresh host lookup or report the host's stale/not-found failure explicitly;
optimistic removal cannot claim success before the host accepts. Logging alone
is not visible degradation. No instruction to delete/archive workspaces to recover.

Feature negotiation preserves old clients. New host/new window uses sync exclusively.
New window/old host retains the existing snapshot path but turns `snapshot-too-large`
notice into a persistent stale banner. Old clients cannot be retroactively repaired:
keep their wire format and known error handling; document any remaining old-client
limitation explicitly. `published` must describe structural data available to the chosen
delivery path, not blindly advance after a failed legacy snapshot. Preserve bounded mail
hold and all existing internal onChange/onMail consumers.

All `works.list` consumers in desktop main must move together: the six local document/file
actions in `main/ipc.ts` resolve their work through the committed local synchroniser:
miss or in-progress sync means wait for that commit, then retry lookup once and fail
closed if absent. The roots adapter independently verifies paths; partial/stale data
cannot be used to grant a root. Delete/archive and reconnect during that wait are tests.
Do not intercept the typed wire `works.list` method with a different response shape.
The separate remote package has its own connection and capability set: do not enable
`works-sync` there without migrating `host-link`, fanout and phone bootstrap. Remote's
existing legacy size limitation remains outside this desktop-window task and must be
reported as not verified, rather than accidentally claiming all surfaces are fixed.

## Acceptance and implementation breakdown

Conditional design review has passed as reported by the lead; the human has requested
implementation-task creation; executors now run GLM `glm-5.3[1m]` (m-2382/m-2384). Code
starts only after formal verified-room
plan acceptance and an accepted scoped assignment, with P1's shared contract reviewed before
consumers. P1 freezes wire and internal main→renderer/
island batches, status/readiness and roots-adapter interface text before P4 implements it;
consumers must not invent independent shapes. P2 and P4 scaffolding may then run
independently; P6 mock acceptance can follow P4 mocks before P3. Real integration needs
P3 + P5 + P6; P3 waits for P2. P4 alone edits main/index.ts, applying P5's reviewed adapter/
wiring patch through a serialized handoff. Production/default capability stays disabled
THROUGH P7; only opt-in isolated fixtures enable it before acceptance. Default enable is
a final accepted integration action after all consumers, P7 PASS and explicit authorization.
Each implementation/test-fixture task goes to a GLM (`glm-5.3[1m]`) executor with one bounded
ownership slice; a separate Codex verifier independently accepts it before dependents proceed.

- T1, protocol/core/host transport: new capability, exact page schemas, budgets, versioned
  projected-object cache/pins, bounded native pages and row-delta transactions. Existing
  legacy routes continue to pass.
  Unit tests: exact page byte bound, one oversized record, 30 works/3k sessions and one
  work/3k sessions; epoch/base validation; mutation during a multi-page read; delete and
  archive; slow/disconnected reader; cursor expiry; zero extra full-map serialisations.
  Journal-floor reset preserves tombstones; mail-only writes emit zero sync pages;
  mail-only writes also cause zero sync projections; sync-only clients never build global
  legacy/compact snapshots. Compare reduction of reset/delta pages by deep equality to
  the existing target projection, including order, absent optional fields and section
  fallback, across deterministic generated edit sequences. A client skipping 2+ revisions
  with edit/delete/reorder must match the target exactly. Split into sequential
  GLM assignments: schemas/budgets, row cache/journal, pinned transactions/service
  wiring, each independently accepted by Codex before the next dependent item.
- T2, desktop shared/main: one synchroniser, bounded IPC batches, roots and island
  adapters. Tests: new/new, new/old capability pair; roots never grant from partial data;
  island forbidden fields absent; late renderer bootstrap; reconnect; cancellation.
  The roots permission adapter is implemented by the GLM executor even though it
  touches the write boundary. Mandatory senior Codex permission-boundary review is required
  before acceptance; the older senior-only implementation requirement no longer applies.
- T3, desktop renderer: atomic delta apply, mail gating/recovery and persistent status
  in WorksErrorBanner and affected controls. Tests: no pruning on partial reset; old
  response cannot roll back; newly created session appears above old 5 MiB threshold;
  deletion removes it; forced overflow/failure is visibly stale and retries recover.
  Mail in more than 16 works during bootstrap and more than 32 pending events repairs
  after commit instead of losing updates. Sustained structural changes in one large work
  keep making commit progress and never hide a genuine stall. Depends on T2's reducer.
  Deliver newer mail first, then commit an older structural transaction: unread counts
  and mention candidates must retain the newer mail state; a later legitimate read event
  must still decrease unread counts. Test both ordinary deltas and reset commits.
- T4 / P7, end-to-end evidence: a GLM executor runs deterministic M1 fixtures on
  supported-size base and head through actual host publish, protocol framing, Electron IPC
  and renderer parsing/fragment assembly/reducer commit; an independent senior Codex
  verifier reviews the evidence and verdict. Measure byte volume, CPU/completion, ELD and maximum
  slices against the explicitly reviewed frame-byte and consumer-latency budgets. Screenshot
  loading/stale/recovered states using Parley browser
  if the renderer fixture is available; otherwise mark Screens not verified. Review the
  final diff with a senior Codex reviewer. No push or PR without the human.

All executor concurrency/recovery changes (pins, revisions, client gate) require a senior Codex
code-review pass and independent verification before acceptance. P5 roots implementation also
uses a GLM executor, with mandatory senior Codex permission-boundary review; no senior-only
implementation requirement remains. For current measurements the
renderer commit-latency and live status screenshots are not verified; T4 must measure
write-to-renderer-commit latency at 10 structural writes/second for 30 seconds, including
one 3,000-session work, and require progress throughout with p95 lag <=2 seconds.
Also measure single-write latency against a completing supported-size base (small and
short-text 3k fixtures) with identical debounce and one modern client; mixed-client base
write-to-broadcast p50 85/88 ms excludes pull RTT, Electron IPC and renderer parse/commit.
The unchanged old base never completes the >5 MiB fixtures: record dropped/no-completion,
not zero latency or a before/after performance pair. Any lifted-limit baseline or uncapped
encode is measurement-only, with altered limits documented, not current production or
an accepted remedy. For oversized fixtures, report head completion/feasibility separately.
Cold complete bootstrap/reconnect/reset after expiry must be measured separately for
30w/3k and 1w/3k, including IPC, renderer JSON parse/fragment assembly and commit at the
explicit selected frame cap. Page-count reductions alone establish no startup speedup.
For the planned 512 KiB candidate, test real near-cap consumer work. Proposed per-process
synchronous page-handling p95 is <=16.7 ms on a declared 60 Hz reference: host build/
encode/fragment slices and main/renderer final-fragment assembly and parse, staged apply,
atomic final commit and all mandatory same-process roots/island/mail adapters, plus IPC-
send work. This includes huge-row completion, not only ordinary per-page JSON.parse.
Declare reference hardware/build mode and near-cap/huge-row fixtures before runs. Report
max. Measure IPC wall send→receive/ack and queue latency separately;
it is not process CPU or constrained by assumption to that synchronous-slice budget.
Fallback to 128 requires the same measured acceptance. Any material performance regression
left unresolved means FAIL; inconclusive noise is not PASS and no tradeoff is silently
waived. Failed or missing consumer checks block acceptance, with no open-ended prototype
loop. These are proposed plan gates, not human-selected numerical limits.

Deterministic CI gates: no silent skipped revision, maximum frame <= selected
`WORKS_SYNC_PAGE_BYTES`, no global
JSON.stringify during steady-state publication, no unchanged-work re-encoding, bounded
pending transfer count, and normal row-delta wire bytes <= baseline full-snapshot
bytes for the same supported fixture. For data beyond the old gate, compare with the
uncapped required baseline payload, not the misleading zero bytes of dropped delivery.
Timed performance is a paired same-machine benchmark, not a flaky unit-test duration
assertion: at least 5 warm paired trials; report p50/p95 with noise, cold bootstrap
separately. The m-2225 payload/ELD and normal-update publish gates are lead operational
criteria,
subject to the pending human performance decision; do not silently add unconditional
dense CPU parity or waive a measured tradeoff. Report supported-base normal-update
comparisons and dense CPU/completion/ELD separately. An improvement/equivalence claim is
blocked when noise is inconclusive. P7 must agree explicit renderer parse/IPC frame-latency
budgets before its verdict, including the proposed 16.7 ms per-process p95 reference;
current host-only results cannot satisfy that consumer gate. The supported-size baseline,
dense/oversized and cold-reset results remain separate, with no cross-run parity claim.

## Impact card (design phase)

Goal: remove the global snapshot size cliff without hiding stale data.
Behaviour: not verified; no production code changed.
Numbers: baseline drops 15/15 changes in each of the three over-limit fixtures; 128 KiB
session-page feasibility measured. Final native 128 dense CPU p50 39.155→50.803 ms and
ELD p95 52.560→6.320 ms, max 89.326→55.312 ms, are pipeline-only. Complete head/renderer
performance is not measured: no implementation exists.
Screens: not measured; this phase changes no UI.
For the human: a reproducible cause, explicit criterion provenance and a prepared
bounded native-page candidate with disclosed dense CPU/host-loop tradeoffs.
Risk: cursor/revision races, mail ordering, root permissions and island privacy need tests.
Cost: design and measurement work only; implementation cost not measured.
Verdict: conditional design PASS and human-authorized plan preparation, not implementation
or production PASS. Recommend 512 KiB as the unproven planned candidate; 128 is a verified-
only fallback. M1–M4 remain unchanged evidence and neither cap has consumer acceptance.
The incident is not fixed by these documents. Execution needs a separate assignment;
production acceptance remains T1–T4 / P1–P7, with no unresolved material regression waived.
