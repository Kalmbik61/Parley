# Window sync implementation plan

> For GLM executors: use the executing-plans workflow for the assigned task only.

**Goal:** prevent the desktop's global 5 MiB update cliff without sacrificing correctness
or accepting an unresolved material performance regression.

**Architecture:** capability-negotiated pull pages carry versioned row changes from an
immutable projected-object cache. Bounded native-array encoding and reusable encoded
pages avoid a global hot-path snapshot; desktop main and renderer commit coherent views.

**Tech stack:** TypeScript, Node 22, Zod protocol schemas, Vitest, Electron/Zustand.

**Status:** implementation-task preparation requested. The human explicitly selected the
test1 subscription / Sonnet for implementation and test fixtures (s-203/m-2366), overriding
the older Codex-only and senior-only P5 implementation wording, then continued both executor
sessions on GLM `glm-5.3[1m]` (m-2382/m-2384); all implementation, including P5, runs on
GLM. This document still does
not authorize code: each item starts only after formal verified-room plan acceptance and an
accepted scoped assignment. Conditional design PASS (m-2338) is not a production/performance
PASS; P7 acceptance remains mandatory. No production code has started.

Worktree `/private/tmp/parley-s203-snapshot`, branch `fix/scalable-window-snapshot`, base
`33e3761b`. Contract: `docs/specs/2026-11-01-window-snapshot-design.md`.

Handoff (2026-11-01): implementation/test-fixture sessions s-212 and s-213 were created on
provider `custom-test1`, model `oauth/pereverzev/claude-sonnet-4-5-20250929`; at 16:16Z the
human replaced test1 and both sessions continue on GLM `glm-5.3[1m]` (m-2381–m-2384). Senior
Codex leads and reviews, and s-211 independently verifies every accepted item in r-20. This
records the actual provider/model, not permission to start before an accepted assignment. One item per
executor; preserve others' edits. No commit, push, PR, live-host restart or real-workspace
data changes without an explicit scoped instruction.

## Present → intended behaviour

| Present | Intended after implementation and P7 acceptance |
|---|---|
| >5 MiB aggregate snapshots drop updates or fail works.list. | All works/sessions remain available through complete bounded reset/delta transactions. |
| One structural edit can rebuild/encode a global snapshot. | Reproject only changed works; equal rows cause no delta encoding; send changed rows/removals/order only. |
| Missing updates can leave stale UI without durable repair. | Loading/current/catching-up/stale states, atomic commits and bounded retry/reset recovery. |
| Pipeline measurements exclude real consumer work. | Exact RPC/IPC byte bounds and measured host/main/renderer work, cold bootstrap and write→commit latency. |

## Scope and non-goals

Scope is the existing P1–P7 desktop sync boundary: protocol/reducer, cooperative projection,
host paging, desktop-main forwarding, roots/island adapters, renderer/mail recovery and
isolated verification. Preserve full projected text, optional fields/order, exact-byte
RPC envelopes, oversized-row fragmentation, mail-only semantics and filesystem/privacy
checks. New desktop + old host retains negotiated compatibility and exposes a persistent
stale error. Unmodified old clients keep their known legacy size limit; they cannot gain
retroactive stale-UI repair.

No data trimming/deletion, database/journal redesign, larger global snapshot limit,
remote/phone migration, compression, unrelated UI work or live deployment. Historical
M1–M4 evidence and current production gates stay unchanged. Production/default capability
stays disabled THROUGH P7; opt-in isolated fixtures test ready consumers. Default enable
is a final accepted integration action requiring explicit authorization.

## Decision context and proposed budget

The human wording is «исключить повторение без ущерба для производительности».
m-2225 payload/ELD gates are lead operationalization; unconditional dense CPU parity was
review-added. Preparing this plan neither chooses a budget for the human nor waives CPU.

Recommend **WORKS_SYNC_PAGE_BYTES = 512 KiB as the planned candidate**, not a proven or
human-selected constant. A 128 KiB fallback is available only after measured acceptance.
The n=8 paired cap diagnostic found dense CPU p50 45.599→32.634 ms and pages 215→54,
with mixed/noisy ELD; it proves no parity against another run's ~39 ms reference. The
final 128 KiB run disclosed dense CPU 39.155→50.803 ms, host ELD p95 52.560→6.320 ms,
max 89.326→55.312 ms and worst slice 52.902 ms. Real renderer/IPC/cold-start costs remain
unmeasured. P7 must resolve material regressions rather than silently accept a tradeoff.

Keep detailed history in the research notes, not this task list:

- `docs/research/2026-11-01-window-snapshot-native-eld-m4.md`
- `docs/research/2026-11-01-window-snapshot-budget-diagnostic-m4.md`
- `docs/research/2026-11-01-window-snapshot-diagnose-m4.md`

## Owners, dependencies and outputs

Owners below are assignment roles, not permission to begin implementation. Bounded
implementation and test-fixture tasks use GLM (`glm-5.3[1m]`) executors per the latest human
instruction (m-2382/m-2384; originally test1 Sonnet, m-2366). A senior Codex lead reviews each
contract/handoff, and a separate Codex verifier independently accepts every item. P5 also
uses a GLM executor, with mandatory senior Codex permission-boundary review.

| Task | Owner | Depends on | Reviewable output / handoff |
|---|---|---|---|
| P1 | GLM executor | Accepted scoped assignment | Wire schemas/reducer plus frozen internal main→renderer/island batches, status/readiness and roots-adapter interface text; lead review before consumers. |
| P2 | GLM executor | P1 independently accepted | Cooperative exact projection/object cache, change/order/tombstone model, encoding counters and tests for P3. |
| P3 | GLM executor | P1 + P2 independently accepted | Host pinned transactions, trusted prepared RPC pages/backpressure, mail/legacy integration and socket tests. |
| P4 scaffolding | GLM executor | P1 independently accepted | Main synchronizer/bridge and mock transport tests; can run independently of P2 without enabling capability. |
| P4 integration | Same GLM P4 owner; sole main/index.ts editor | P3 + P5 adapter + P6 consumer independently accepted | Bind real host path, committed lookups, island filtering and late-renderer bootstrap; integrated acceptance requires all three. |
| P5 | GLM executor + mandatory senior Codex permission-boundary review | P1 frozen roots interface + P4 wiring coordination | Roots adapter/security tests and reviewed wiring patch handed to P4; P5 never edits main/index.ts directly. |
| P6 | GLM executor | P1 frozen contract + P4 mock bridge ready | Mock renderer/mail acceptance may precede P3; real acceptance needs P3/P5/P6 integrated. |
| Integration handoff | Lead + P3–P6 owners | P3/P4/P5/P6 independently accepted | All consumers ready; capability enabled only in isolated integration fixtures, with compatibility/security tests passing. |
| P7 | GLM evidence/fixture executor + independent senior Codex verifier/reviewer | Integrated candidate independently accepted | Paired actual-process performance/correctness evidence and explicit PASS/FAIL/inconclusive verdict. |

Execution order: P1 freezes wire AND internal contracts → P2 and P4 scaffolding may run
independently → P6 mock consumer follows P4 mock bridge, even before P3 → P3 follows P2 →
integrate P3/P4/P5/P6 → P7. Fake-transport acceptance is not live integration acceptance;
the latter requires P3 + P5 + P6 ready. P5 supplies its adapter and reviewed wiring patch
through a serialized handoff to P4, the **single editing owner of main/index.ts**.
Production/default capability remains disabled THROUGH P7. Only opt-in isolated fixtures
enable it before acceptance; default enable is the final accepted integration action,
requiring every consumer ready, P7 PASS and explicit authorization.

For each authorized task: add the focused failing regression; verify that failure, make
the smallest scoped implementation, run its focused commands below, then hand off files,
contract and evidence for review. Do not start a dependent task on an unreviewed interface.
No automatic commits. P7 failure returns a bounded repair item, not an unreviewed variant.

## P1 — shared contract and pure transaction reducer

Owner: one GLM executor. Files: new `packages/protocol/src/works-sync.ts`,
`packages/protocol/src/works-sync.test.ts`; exports in `index.ts`, method schema/result
in `methods.ts`, event declaration in `events.ts`. No host or desktop wiring yet.

Define `WORKS_SYNC_FEATURE`, the named budgets from the design, `works.sync` request and
response types, `works.invalidated`, and a browser-safe pure staged reducer. Do not
change the existing `works.list` response shape. Production/default capability stays
disabled THROUGH P7; opt-in isolated fixtures exercise ready consumers. Default enable
is the final accepted integration action after all consumers and explicit authorization.

The exact public contract must be written down and sent to the lead before P2/P3/P4 handoff.
It must cover epoch, base/target structural revision, reset vs delta, client-bound opaque
cursor, next cursor and final commit, typed reset-required, ordered records and explicit
deletes. No executable JSON paths. Collection row keys are field + stable entity ID;
lists without stable IDs use section replacement with explicit order. Unknown future
map fields must survive section fallback. Source work version for mail metadata differs
from sync structural revision. Oversized record fragments have identity, index and final
marker; missing/duplicate/conflicting fragments cannot produce a partial committed row.

P1 also freezes reviewed **internal contract text** before P4: main→renderer/island
batch/transaction shapes, status/error/progress/readiness events and complete-view/changed-
work/deletion inputs for the roots adapter. Include epoch/revision, commit/readiness and
stale/partial semantics at these boundaries. P4 implements these types in its existing
bridge/island scope; P4/P6/P5 must not invent independent wire or consumer shapes. This
is contract review, not extra desktop implementation ownership in P1.

The reducer stages pages without mutating the committed snapshot. Commit preserves
unchanged references and returns affected/deleted work keys. A reset does not erase old
data until complete. It must support a late consumer starting from no snapshot and reject
wrong epoch/base or incomplete transaction atomically. Work keys include project path.

Acceptance: targeted red test first for reset/delta round-trip, absence vs empty optional
fields, ordering, work/row delete/recreate, skipped revisions, repeated pages, oversized
Unicode record fragments and prototype-like keys. Generated deterministic edit sequences
must match the target `WorksSnapshot` deeply. This module cannot import Node-only APIs.
The handoff includes the frozen wire/internal contract text before P4 mocks begin. Run
protocol tests and build. No timed unit-test assertions.

## P2 — cooperative projection and immutable row cache

Owner: one GLM executor after P1's interfaces are independently accepted; independent of P4
scaffolding. Output: exact projection/object-cache interface and counters for P3. Files:
`packages/core/src/work/context-pages.ts`, its focused tests/exports;
new `packages/host/src/works/sync-rows.ts` and focused tests. Do not wire the live service.

Accepted `pl-03` revision 2 adds a narrow prerequisite repair owned by the authorized
Sol executor (s215), with independent s211 review before cache/main adoption. Historical
P1 verification remains recorded; this additive repair reruns its regressions. The shared
browser-safe protocol adds `section-fragment { key, field, element, index, text, final }`
for one absolute unnamed-array element, and `order-slice { key, field, start, ids, final }`
for bounded named-row order vectors. Fragment `final` closes only the element; a normal
`section` with `final: true` separately establishes the exact section length (an empty
slice at the total length can close a fragmented final element). Order-slice `final`
establishes exact order length. Coverage must be contiguous from zero; overlaps, duplicate
fragments/IDs, missing referenced rows, mixed whole-order/sliced-order representations and
conflicting completion reject atomically. Coverage reserves/checks only incoming indices;
repeat fragments consult their reserved element directly, with no scan over all prior slices.
Operation-count regressions cover growth from 1k to 2k slices. Field removal resets staging
before a kind change.

Host and main share `worksSyncNamedRows`: only nonempty arrays whose elements have unique,
own, nonempty, safe string IDs of at most 128 UTF-16 units qualify. Other arrays, including
huge/unsafe/duplicate id-shaped values, use indexed sections losslessly. Produce bounded
sections/order slices from the outset; never encode the aggregate list/vector to discover
or split an overflow. Fragment only an oversized individual section element. The individual
fragment's final assembly/parse and atomic commit still require P7 evidence; no timing
waiver follows from this contract repair.

Preserve byte-for-byte/deep-equal projection semantics against `mailWorkMap`. Capture
coherent compact mail metadata synchronously under the existing database snapshot, then
yield only during pure projection traversal; never leave a SQLite snapshot open across
awaits. Cooperatively slice projection, equality comparison and changed-row encoding.
Immutable cached projected rows must not alias mutable service maps.

Use exact structural comparison over immutable projected objects, independent of
mutable service maps. In delta generation, equal rows cause no encoding. Encode ordinary
changed rows once within their bounded native-array page, without eagerly caching every
row's JSON/size. Oversized-batch retries can re-encode rows: count all attempted rows,
bytes and CPU, split only bounded batches, and never retry the whole collection. Reuse
encoded pages across subscribers within the separate bounded page cache. A single
oversized row must use P1's UTF-8-safe fragments with exact RPC-envelope accounting;
prototype rejection of such a row is not acceptable production behaviour. Track source
work version, last structural revision per row/order, and explicit tombstones. A later mail-only version must not trigger projection on the known local
mail-only path. Whole-map encoding is forbidden here.

Acceptance: exact old/new projection equality on existing fixtures plus long text, arrays,
private Codex bindings and optional fields; mutation-after-cache test; equal rows encode
zero times, ordinary one-row edit encodes only that row and necessary metadata;
counted bounded overflow retries, oversized-row fragment round-trip, dense→nochange→edit
on an evolving cache, and allchanged control; observed yields for 3k sessions and recorded
maximum synchronous slice. Memory growth is reported, not hidden in the 4 MiB transient-page cache budget.

## P3 — host transactions, paging and service integration

Accepted amendment (pl-03 rev3, P3/P6 only): authoritative per-work mail repair is
`works.mailState({projectPath,workId,cursor?})`. P3 owns
`protocol/src/works-mail-state.ts` and tests, method schema/result/export registration,
the existing host works method/service and bounded pin plumbing. P6 consumes only the
independently reviewed contract. No structural reducer changes or default activation.

The dedicated `WorksMailStateAssembler({epoch,key})` is single-use for one request
sequence. `mail-page` carries `epoch,key,sourceVersion,requiredStructuralVersion,index,
cursor,next,records,commit`; all identity fields are frozen for a pin. Exactly one
`{kind:'mail-summary',key,unreadLetters}` and all three complete indexed sections are
required. `mailRooms` elements are `{roomId,metadata:{total,top,lastAt,unread,decision}}`;
`unreadRooms` elements are `{roomId,count}`; `mentionCandidates` elements are canonical
window `Message`s in increasing message sequence, at most200. The room key `''` is
direct mail data. Sparse unread keys and zero/decreasing counts survive exactly.
Only `section` and `section-fragment` operate on these three fields. Fragments reserve
one element index and must complete before the separate final section marker. Reject
unknown fields, structural record kinds, changed identity/dependency, missing page
prefixes, cursor mismatch, duplicate summary/room/count/candidate keys, repeated indices,
gaps, overlap, incomplete fragments and conflicting completion. Coverage checks are
linear; a continuation never scans preceding slices. Only final validated assembly
returns the full replacement; it never updates structure or raises its coverage.

`mail-unavailable` reasons are `busy`, `retry`, `not-found`, `cursor-expired`,
`cursor-unknown`, `cursor-client`, `cursor-work`; none fabricates empty mail. Cursor
purpose/client/work binding, admission, bounded encoded cache, idle expiry and disconnect
cleanup are independent of the structural transaction. Actual RPC id/envelope/newline
uses the same selected byte cap and private prepared-result boundary. Capture all mail
metadata synchronously inside one SQLite letter snapshot before yielding/encoding.
`requiredStructuralVersion` must be a proven reachable per-work structural source
version, never the global sync revision or guessed latest mail version. Unknown coverage
requires coherent per-work refresh/retry. Ordinary cached mail repair performs no global
projection or structural invalidation. A missing/deleted work yields explicit failure.

The P3 producer admits one mail pull/pin per connection independently of the structural
pin, up to64 mail pins/starting captures (fixture options may lower this). Admission
returns `busy`; it does not evict structural work. Both purposes share the bounded4MiB
encoded payload LRU, with separate transfer identities; idle expiry is30s with timer
cleanup even without another request. A coherent detached capture is cooperatively
copied/frozen before encoding, then enumerated in native batches of32. Neither room
dictionary is mapped/stringified as one array. Each mail transfer reserves its actual
work identity/envelope and maximum numeric RPC id before packing; delivery rechecks
the actual full frame including newline. `sendLine(false)` never retries that page.
Known coverage uses proof from the completed structural publication queue, then reads
all mail metadata and source version in one synchronous SQLite snapshot. If coverage is
unknown, project only a detached capture of that work, check its source/lifetime again
inside the structural publication queue and return `retry` after making the dependency
reachable. Superseded/deleted captures do not poison or partially publish the cache.
Known ordinary mail reads do not invoke this structural repair. Work deletion/disconnect
cancels pins; epoch/work lifetime guards also remain mandatory at the consumer.

P6 schedules bounded authoritative reconciliation for every work after every full reset,
including fresh windows without held messages. Commit only when epoch/work lifetime
still matches, the committed structural entry.version covers the requirement, and the
captured mail version is at least any held/applied mail version (equal versions may
repair removals/decreases). Never use held mail or global revision as structural coverage.
Replace rooms/unread/candidates atomically; repair held/open message ranges separately.
Keep durable retry/visible stale after failure and bound scheduling across works.

Owner: one GLM executor after P2 and P1 independent acceptance. Output: host transaction/RPC contract
and socket evidence for P4 integration. Files: new
`packages/host/src/works/works-sync.ts` and tests;
`packages/host/src/works/works-service.ts`, focused window/mail tests;
`packages/host/src/methods/works.ts`, `methods/index.ts`, `server.ts` and focused tests.

Integrate structural revisions and P2's cache. Per-client transactions pin immutable
target references and pull at most one encoded page at a time within selected
`WORKS_SYNC_PAGE_BYTES` (planned candidate 512 KiB; 128 only if verified). Every actual runtime
RPC response id/envelope, sequence/cursor, separator, escaping and newline counts toward
the cap. Encode native bounded arrays; overflow splits only the bounded batch and all
retry encodings are counted. Reuse resident encoded-page payloads across subscribers;
there is no aggregate-size refusal or full-workspace stringify. A single oversized row
must fragment and round-trip rather than inherit the prototype's rejection.
Review the actual response boundary: `server.ts` currently calls `client.send({id,result})`
and serialises ordinary handler results. A page already encoded for sizing must not be
encoded again there or by slow-request diagnostics. Use a narrowly scoped trusted prepared
result path or an equivalently reviewed solution; never allow raw JSON from a client.
The runtime response id/envelope must be included in the final byte check. Test real
sendLine delivery, ordinary-handler compatibility and fake-client fallback equivalence.
Use a runtime-private brand for the host's prepared result, not duck-typed keys a client
could supply. The trusted encoder creates immutable typed data, JSON and byte count
together; server serialises only the response id/small envelope. Slow diagnostics use
the known byte count. Validate final bytes before writing. `sendLine(false)` may mean
the frame was already queued: never retry that response; pause subsequent page production.
Socket tests cover one response only, Unicode/escaping, near-budget id overhead, forced
slow logging without another encode, fallback equivalence and unchanged ordinary errors.
Journal horizon/cursor expiry returns reset-required; disconnect cleans up pins.
New invalidations coalesce while an old pinned transaction completes. Wrong client or
epoch cannot consume a cursor. A slow client does not delay other clients or internal
listeners. Legacy clients retain negotiated old behaviour; sync-only connections never
run global compact/legacy snapshot construction.

Mail-only local writes send zero sync invalidations/pages and perform zero sync
projections. For mixed mail, expose the structural transaction before invalidation and
release sync delivery's hold then; the client gate uses the explicit required structural
version. Internal onMail and legacy hold semantics stay intact.

Acceptance: 30w/1k, 30w/3k and 1w/3k initial sync and subsequent create/edit/delete all
finish above the old 5 MiB gate; every frame <= selected `WORKS_SYNC_PAGE_BYTES`. Test change during paging,
skipped revisions, journal eviction, client disconnect, cursor mismatch, huge single
record and archived-work updates. Existing legacy and mail tests pass. Test the new path
fails to deliver on the original base (missing capability/protocol or old dropped update),
rather than simply deleting the old compatibility assertions.

## P4 — desktop main synchroniser and bounded local forwarding

Owner: one GLM executor. P4 scaffolding starts after P1 review, independently of P2;
real integrated acceptance waits for P3 + P5 + P6. P4 is the sole main/index.ts editing
owner; apply P5's reviewed wiring patch only through a serialized handoff.
Output: implementation of P1's frozen bridge/consumer contract, then real synchronizer. Files: new
`packages/desktop/src/main/works-sync.ts` and tests;
`main/host-connection.ts`, `main/ipc.ts`, `main/index.ts`,
`shared/bridge.ts`, `shared/island.ts`, relevant preload surface and focused tests.

First scaffold against P1's mock contract without advertising the capability. After P3,
one synchroniser per host connection negotiates that contract, drives pulls and commits
P1's reducer; production/default activation stays disabled through P7. Opt-in isolated
fixtures can exercise ready consumers. Renderer bootstrap is local paged state, not a
global structured clone. Forward
bounded batches to attached surfaces, replay a coherent reset to late renderers, and
retain a local committed view for roots and the six main actions using works.list today.
Miss/in-progress sync waits for its commit then retries lookup once; absent work fails
closed. Do not silently rewrite the wire works.list return type. Old-host fallback
retains existing behaviour and exposes snapshot-too-large as persistent stale state.

Island projection must strip every currently forbidden private field before local IPC;
new page events must not bypass its existing boundary. Remote does not advertise the
new feature in this task. Keep its known legacy-size limitation explicit.

Acceptance: new/new and new/old pairs, no extra global encode/clone on a one-row change,
single inflight pull, coalescing, reconnect/epoch, abort/dispose, late renderer, exact
island privacy, correct loading/current/stale status and known-oversize old host. Mock
transport acceptance may precede P3; integrated acceptance requires P3/P5/P6 readiness.

Item7 isolated binding: `PARLEY_WORKS_SYNC=1` is honored only with an explicit
`PARLEY_HOME` (or existing legacy aliases) and the existing desktop test-switch gate
(unpackaged, or explicit `PARLEY_E2E=1` for a packaged fixture). This does not enable
the ordinary host bootstrap or default desktop capability. A fixture must explicitly
construct its host service with `sync: { enabled: true }`.

The opted-in HostConnection advertises the feature in hello. `bindHostWorksSync`
negotiates both sync methods plus the feature, owns one synchronizer and feeds
status/invalidations. Both main and island bind the trusted recovery callback. Their
main-supplied query flag and negotiated host support select the renderer consumer;
old hosts retain legacy initialization and persistent oversize errors. Roots and the
six main lookups use committed sync state only for supported hosts; the last negotiated
choice persists through disconnect so recovery cannot fall back to legacy permissions.
Legacy source listeners are filtered while sync is selected. Root policy options are
identical, and sync roots/synchronizer/connection are disposed at actual app exit.
Every completed reset reaches attached surfaces even if epoch/revision is unchanged:
Retry and reconnect require fresh consumer mail reconciliation.
The opted-in works consumer remains subscribed across disconnect and failed recovery,
with disposal on unmount or renegotiation to a legacy host. Other stores keep their
existing connection lifetime. Island retains the sync failure/Retry surface, expands
it and suppresses idle hiding while repair fails; disconnected progress RPCs remain off.
Hit-region eligibility uses that same retained availability, so disconnected sync Retry
remains inside the measured native mouse region; legacy disconnected regions remain null.

## P5 — roots permission adapter (mandatory senior Codex review)

Owner: one GLM executor. Because this adapter is a filesystem write boundary, a
senior Codex permission-boundary review is mandatory before acceptance. Files:
`packages/desktop/src/main/roots.ts` and roots tests. P1 freezes the roots-adapter interface;
P5 supplies the adapter and a reviewed main/index.ts wiring patch to P4 through a serialized
handoff. P4 alone edits main/index.ts; P5 does not acquire shared-file ownership.
Output: reviewed permission adapter, wiring handoff and roots/security evidence.

Feed only complete committed views/deltas to the existing root verification. Only changed
works require root recomputation. Partial bootstrap, stale state and failed recovery
cannot grant a root. Committed deletions retire it immediately; a pending lookup waits
for the in-progress commit and then retries or fails. Preserve realpath and symlink checks.

Acceptance: no grants from partial reset; deletion while lookup waits; stale/reconnect;
new valid worktree after commit; foreign/symlink escape rejection. Existing roots tests
and impacted file API tests pass. Senior review is required before acceptance.

## P6 — renderer commit, mail recovery and visible state

Owner: one GLM executor after P4's mock consumer/bridge handoff, using P1's frozen
internal contract. Fake-transport acceptance may precede P3; real acceptance requires
P3/P5/P6 integration. Output: atomic renderer commit/mail recovery and ready fixtures. Files:
`packages/desktop/src/renderer/store/works.ts`, focused works tests;
`components/WorksErrorBanner.tsx`, `shared/strings.ts` and relevant island status surface.

Consume bounded staged pages and commit only complete transactions. Initial readiness
must not prune restored layouts prematurely. Preserve held room messages and newer mail
counts/mentions by source version (never numeric max). Gate mail on required structural
work version. Either waiting-queue overflow sets durable repair-after-commit, and repair
is bounded/retried visibly. Deletes cancel staged rows and mail repairs for that work.

Expose loading progress, current, catching-up, stale/error and retry. Initial stale timer
measures lack of page progress; post-bootstrap stale timer measures lack of commit while
wanted > applied. New successful data clears error. Deletion success comes from host;
stale IDs never produce an optimistic claim of success. Island sees the same status.

Acceptance: partial reset preserves tabs; delayed old RPC cannot roll back; newer mail
then older structural commit preserves counts/mentions; legitimate read lowers unread;
mail in >16 works/>32 waiting events recovers; retry and reconnect; sustained commits
avoid false stale while real stalled updates show persistent status. Mock readiness does
not enable the capability; integrated acceptance waits for P3, P5 and P6 consumers.

Accepted P6 recovery amendment (pl-03 rev4, m2628/m2634): main admits mail reads
only from registered main/island main frames, at most one pending page per sender
and two globally, without a waiting queue. Each page has its own 30-second response
deadline. Reset, reload or sender destruction cannot release an unresolved call's
admission slot or deadline; settlement or connection retirement releases it.

A deadline retires the shared socket and candidate generation, rejects and deletes
**all** pending RPCs, and clears their timers before one bounded existing-host-only
handshake. Both surfaces retain their committed view and see connection failure;
successful reconnection requires fresh structural reset and mail reconciliation.
Unrelated writes may already have completed: reject them once and never replay them.
Recovery never spawns, stops, restarts or signals the host. Attempts, including Retry,
are coalesced and limited to one per 30 seconds; failure remains visibly disconnected.

Item7 must pass `() => connection.retryMailRecovery()` as the fifth argument to
`bindWorksSyncWindow` for **both** surfaces. This main-owned callback uses the existing
trusted `works-sync:retry` channel even while disconnected. Its null result preserves
ordinary structural Retry; its promise represents the shared bounded recovery.
No new preload/bridge channel or host/protocol production change is involved.
Socket closure does not cancel an already-running host capture: its global 64-slot
reservation remains owned until its actual `finally` settlement. A closed reader
cannot install a late pin. Saturated captures honestly return busy/stale.

## P7 — integrated verification and performance verdict

Owner: one GLM executor for isolated fixtures and evidence, with an independent
senior Codex verifier/reviewer. Starts after the integration handoff is independently
accepted, not before all consumers exist. Files: isolated test/measurement fixtures under `tools/bench/`,
`packages/desktop/e2e/works-sync.spec.ts` and focused integration tests; raw paired
head/base JSON and results under `docs/research/`. Preserve all historical M1–M4 artifacts.
No production patch belongs to the verifier without a separate repair assignment.

Declare reference machine/OS/Node/Electron versions, **60 Hz reference (16.7 ms frame)**,
selected `WORKS_SYNC_PAGE_BYTES`, sample/warmup counts and client mix **before** each run.
Predeclare build mode and near-cap/huge-single-row fixtures (including final fragment and
commit cases), not only hardware/software versions. Use
at least five alternating paired trials on completing supported-size base/head fixtures
(small and short-text 3k), identical debounce and single modern client; run mixed-client
compatibility separately. Never infer parity from different runs or page count.

| Proposed check | Measurement | Acceptance / reported evidence |
|---|---|---|
| Synchronous near-cap handling per process | Host projection/encode/fragment slices; main/renderer final-fragment assembly and parse, staged apply, atomic final commit, mandatory same-process roots/island/mail adapters and IPC-send slices. Include actual near-cap, huge-row final fragment and ordinary ~9 KiB pages; not only ordinary JSON.parse. | **p95 <=16.7 ms in each process on declared 60 Hz reference; report max**, CPU and phase breakdown. This is a proposed plan gate, not a human-selected threshold or a hard maximum guarantee. |
| IPC wall latency | Main send→renderer receipt and reverse acknowledgement, including wall queue/clone/transfer time, separately from synchronous work. | Report p50/p95/max separately; do not classify IPC waiting as process CPU or assume 16.7 ms of wall RTT from the slice budget. Compare supported base; unresolved material regression fails. |
| Actual publication/consumer result | Write→host publish→wire→main→renderer commit, CPU/completion/ELD in actual processes, total request/response/IPC bytes, projection/encoding/retry counts. | Compare paired completing supported base; correct complete state, no silent regression or full-map hot-path serialization. Report p50/p95/max and longest slices; unresolved material CPU/ELD/latency regression fails. |
| Dense/oversized workload | Warm allChanged, dense→nochange→single-edit cache evolution, and one record larger than the selected frame cap. | Count all retries; every actual RPC frame <= selected cap; fragment and decode the oversized row exactly. Report these separately, without inventing a completing old >5 MiB base. |
| Cold bootstrap/reset | Empty consumer, reconnect/new epoch and expired cursor at 30w/3k and 1w/3k. | Measure first-page and complete-commit time, IPC/parse/fragment costs, CPU/ELD/peak memory and all pull RTT/bytes. Head must complete; assess separately from warm dense updates. |
| Sustained edits / mail | 1w/3k, 10 structural writes/s for 30s; mail-only updates. | Progress throughout, proposed p95 write→commit lag <=2s, no mail-only sync traffic/projection; preserve mail versions and repair. |

The unchanged >5 MiB base drops updates and never completes. Mark it **no-completion**,
not zero latency or a performance-parity pair. Any lifted-limit baseline or uncapped
encoding reference is **measurement-only**, with altered limits documented; it is not
the unchanged production baseline or an accepted remedy. Keep normal supported-base
comparisons, dense/oversized feasibility and cold reset results separate.

A failed or missing consumer check blocks acceptance; do not substitute an open-ended
prototype loop. A 512 KiB candidate must pass real renderer/IPC/host checks, not merely encode fewer
pages. A 128 KiB fallback must rerun the same acceptance and cannot receive an automatic
PASS. Any material performance regression left unresolved means **FAIL**; inconclusive
noise means **inconclusive**, not PASS. No executor/verifier silently waives the disclosed
dense CPU tradeoff. Proposed numerical gates and any acceptance decision require human/
lead review; approval of plan preparation alone provides no waiver.

Run the focused commands and required builds/typecheck/lint below. Use Parley browser
first for loading/stale/recovered fixtures and capture screenshots; record unavailable
actual-window checks as unverified. Senior reviewer checks final diff, exact-byte RPC
path, fragmentation, mail, security and legacy behaviour. No live-host restart/push/PR.

## Executable verification handoffs (after execution is authorized)

Commands are from the checked package scripts: core/protocol/host `test` use Vitest,
`build` uses tsc; desktop `test`, `typecheck`, `build` and `e2e` use Vitest/tsc/Electron-
Vite/Playwright; root `lint` uses ESLint. They are plan commands, **not run for this
plan-only task**. Planned tests below must exist and run cases: protocol/core/host scripts
use --passWithNoTests, so a missing new test is not valid green evidence.

Set an isolated home before tests; fixtures must create only temporary projects and must
not call real provider CLIs. Desktop e2e/global-setup already enforces temporary homes and
skips CLI version probes. No command attaches to or restarts the human's live host.

```sh
set -e
export WINDOW_SYNC_TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/parley-window-sync.XXXXXX")"
export PARLEY_HOME="$WINDOW_SYNC_TEST_HOME"
export HARNAS_HOME="$WINDOW_SYNC_TEST_HOME"
export PARLEY_SKIP_VERSION_PROBE=1

# Dependency builds before focused consumer checks.
pnpm --filter @parley/core build
pnpm --filter @parley/protocol build
pnpm --filter @parley/host build

# P1: new reducer/protocol fixture (create it before running this command).
test -f packages/protocol/src/works-sync.test.ts
pnpm --filter @parley/protocol test src/works-sync.test.ts
# P2: projection and new cache fixture.
test -f packages/host/src/works/sync-rows.test.ts
pnpm --filter @parley/core test src/work/context-pages.test.ts
pnpm --filter @parley/host test src/works/sync-rows.test.ts
# P3: new transport plus actual response boundary/mail/legacy regressions.
test -f packages/host/src/works/works-sync.test.ts
pnpm --filter @parley/host test src/works/works-sync.test.ts src/works/works-service.window.test.ts src/works/works-service.mail.test.ts src/server.test.ts src/methods/works.test.ts
# Build every desktop dependency, including remote/file-icons, on a clean checkout.
pnpm --filter "@parley/desktop^..." build
# P4/P5: new main fixture and permission/compatibility adapters.
test -f packages/desktop/src/main/works-sync.test.ts
pnpm --filter @parley/desktop test src/main/works-sync.test.ts src/main/host-connection.test.ts src/main/roots.test.ts src/main/ipc.test.ts src/main/island/works-projection.test.ts
# P6: renderer/mail and optional-field compatibility.
pnpm --filter @parley/desktop test src/renderer/store/works.test.ts src/renderer/store/works.compact.test.ts
# Integration/P7: isolated Electron fixture, after all consumers are wired.
pnpm --filter @parley/desktop typecheck
pnpm --filter @parley/desktop build
test -f packages/desktop/e2e/works-sync.spec.ts
pnpm --filter @parley/desktop e2e e2e/works-sync.spec.ts e2e/works-unreadable.spec.ts
# Final repository checks; report unrelated failures without silently fixing more scope.
pnpm build
pnpm lint
```

Expected handoff: selected test files execute nonzero tests, targeted regressions and
package builds/typecheck pass, no fixture uses real workspace data, and raw P7 measurements
support the declared verdict. Fixtures failing only because they are absent are work still
required by their owner. Existing historical pipeline benchmarks are not substitutes for
these integration/performance checks. Cleanup is limited to the task-created temporary
home through fixture teardown; never remove a real workspace/home directory.

## Current acceptance gate and impact card

Plan-ready means bounded P1–P7 assignments, explicit interface/dependency review points
and a verification contract. It does not mean implementation authorized or production
PASS. Conditional design review is recorded; execution assignment, task reviews and P7
proof remain required. Current production's 5 MiB/8 MiB protections are unchanged.

Goal: prevent silent update loss without unresolved material performance regression.
Behaviour: planned only; capability stays disabled until all consumers and gates are ready.
Numbers: recommended 512 KiB candidate, verified-only 128 KiB fallback; proposed per-process
near-cap p95 <=16.7 ms on declared 60 Hz reference. No new measurements in this plan task.
Screens: not measured; actual renderer/IPC checks belong to P7.
For the human: reviewable owner/dependency/file/test plan, not a CPU waiver.
Risk: consumer latency, cold reset, cursor/mail/security races and material regressions
must be resolved by implementation tests and P7.
Cost: implementation/runtime/model cost not measured here.
Verdict: prepared for review; no implementation, benchmark execution, commit or deployment.


## Accepted item10 repair — bounded progress and atomic publication (pl-03 rev6)

Contracts: room r-20 m2737 and m2757. Ownership: s214; independent verification: s211.
Core watcher (75ms in the host) and service (100ms by default) keep the first pending
change's deadline; invalidations during an in-flight operation request one latest
follow-up and cannot postpone admission. These bounds do not overcome CPU blocking.

Opted-in service refreshes capture owned maps, actual source versions, catalogue identity
and mail in one synchronous database read before git/liveness/lease maintenance. Ordinary
later writes do not cancel coherent intermediate V. A versionless legacy list is not used
as structural proof: the sync path reacquires a coherent read. Cached list maps from a
raced read are no longer filed under the earlier version.

Publication stages immutable row states and catalogue/branch/tombstone/journal metadata.
It validates lifecycle/catalogue and committed structural coverage at queue entry and
again after cooperative preparation, then adopts state without an await or a row walk.
A discarded candidate cannot change committed rows, removals, journal/floor, revision,
notifications or pinned transactions. Live mail-only watermarks are reconciled at adoption
without increasing structural coverage. Genuine preparation errors still require repair;
ordinary supersession retains the valid prior snapshot and schedules bounded reacquisition.

Focused acceptance covers continuous two-work progress, delayed maintenance, catalogue
addition and delete/recreate during staging, late row/record rejection, pinned-state and
journal retention, stop, live mail watermarks and queued per-work repairs. Item10's unit
checks do not establish P7 performance, memory or native recovery PASS. The preserved P7
FAIL evidence, small CPU regression and separate island Retry repair remain open. Default
capability stays OFF; no activation or live restart is part of this item.


Item10 candidate limitation (s214/s211 lifecycle review, m2767/m2774): not submitted
as complete. A normal same-millisecond delete/recreate can reuse key, numeric version,
createdAt and SQLite rowid. The existing list/store key+version caches and catalogue
fingerprint cannot prove incarnation; same-epoch RESET also retains old renderer mail
floors. A deterministic isolated core-API probe is preserved in
`/private/tmp/parley-s214-item10/lifetime-probe.{mjs,json,log}`. Item10 is blocked for
reviewed durable incarnation/cache semantics and consumer-safe retirement. Existing
unit PASS results do not waive this uncovered failure. No extra files are authorized
by this note; no epoch shortcut or protocol/renderer expansion was applied.


### Item10 lifecycle extension implemented for independent review (pl-03 rev7)

The rev6 candidate limitation above is superseded by the accepted m2780 implementation;
its original failure evidence remains unchanged. Schema3 assigns every actual works INSERT
a durable positive safe incarnation from a DB-wide counter/trigger, backfills existing
rows atomically, and preserves incarnations on ordinary updates. Both map/list caches,
foreign watcher comparisons and coherent capture validate incarnation plus version.
Work wait keys include incarnation; write notifications carry the identity captured in
the writing transaction, so a foreign recreation before delivery cannot relabel a write.

Modern publication stages incarnation metadata with rows/catalogue and validates it at
final commit. New incarnation accepts equal/lower numeric versions; old incarnation
cannot overwrite it. Committed removal or replacement retires the sync epoch atomically,
including old pins, encoding transfers/cache and notification coalescing state. Old
mail-only watermarks belong to their incarnation. Ordinary writes do not retire epochs.
An old page or mail capture finishing after retirement cannot attach to the new epoch.

Renderer new-epoch reset invalidates asynchronous page/quote/mail work immediately and
keeps the previous visible entries/quotes while staging. Successful commit replaces old
message bodies and numeric mail state. Page/quote handlers and finally blocks carry
request/lifetime identity; obsolete completion cannot apply data or clear replacement
jobs. Same-epoch reconnect retains its prior history behavior. Existing physical mail RPC
admission stays bounded until an obsolete request settles; its payload is discarded.

Evidence is frozen in `/private/tmp/parley-s214-item10-rev7`: full owned source, hashes,
incremental patches from pre-item10 and rev6 baselines, isolated test/build logs and the
same-clock probe now returning B with the old catalogue rejected. Focused migration,
cache/watcher, host final-commit/pin and actual main/island store tests are required for
independent s211 verification. P7 performance/native acceptance remains separate; global
reload cost on epoch retirement, the preserved small CPU finding and item11 Retry remain
unmeasured/unresolved here. Default capability is OFF; no live database was migrated,
restarted, or deployed by this work.

### Human-authorized activation in PR #164 (2026-11-02)

The human explicitly asked to enable this synchronization in PR #164 before merging, so the
previous default-off gate is removed in the PR branch: the host registers `works.sync` and
`works.mailState`, and the desktop main window and island negotiate and consume the paged
protocol by default. Older clients continue to use the existing negotiated legacy path.
This authorization is a deliberate override of the planned P7-before-default-activation
sequence; it does not change the verification record. P7 performance acceptance and the
human's live UI runs remain unverified, so no performance or no-regression claim is made.
